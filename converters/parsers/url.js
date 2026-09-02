/**
 * URL → IR
 *
 * 流程：fetch-guard 抓页（SSRF 守卫 + 限长限时）→ cheerio 提取标题与正文（微信 / 知乎 /
 *       CSDN / 简书 / 通用兜底）→ 图片逐张经 fetch-guard 下载进 assets（失败记 warning
 *       并保留原 URL）→ 内联样式预处理 → turndown('url') → remark-parse + remark-gfm
 *
 * 契约：
 *   - async parse({ url } | string, ctx) → MarkFlowDocument{ ir, assets, warnings, meta }
 *   - 不写盘、不打印；ctx.allowPrivateNetwork 透传给 fetch-guard（仅测试使用）
 *   - 成功下载的图片按文档顺序编号为 images/image_N.ext（N 从 1 起），与 assets 一一对应
 */
const cheerio = require('cheerio');
const { loadUnified } = require('../ir/unified-loader');
const { createDocument } = require('../ir/schema');
const { createTurndownService } = require('../ir/turndown');
const { fetchText, fetchBinary } = require('../net/fetch-guard');
const { getExtFromContentType, getExtFromUrl } = require('../ir/util');

const DEFAULT_TITLE = '未命名文章';
// 懒加载图片常用属性，按优先级取第一个非空值
const IMAGE_SRC_ATTRS = ['data-src', 'data-original', 'data-actualsrc', 'data-lazy-src', 'src'];
const IMAGE_CONCURRENCY = 6;
// 进度百分比：parser 只报 parsing 阶段，三个节点单调递增且不超过 55（其后由调度器接管）
const PROGRESS_FETCH = 10;
const PROGRESS_ASSETS = 40;
const PROGRESS_IR = 55;
// 通用兜底：只考虑正文文本超过此长度的 div
const MIN_CONTENT_TEXT_LENGTH = 200;
const BOLD_STYLE_RE = /font-weight\s*:\s*(bold|[6-9]\d{2}|1000)/i;
const ITALIC_STYLE_RE = /font-style\s*:\s*italic/i;
const STRIKE_STYLE_RE = /text-decoration[^;]*line-through/i;
const DATA_URL_RE = /^data:([^,]*),([\s\S]*)$/i;
const MIME_BY_EXT = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
};

/** @param {{ url: string }|string} input @param {{ sourceName?, allowPrivateNetwork?, onProgress? }} ctx */
async function parse(input, ctx = {}) {
    const url = resolveUrl(input);
    const allowPrivateNetwork = ctx.allowPrivateNetwork === true;
    const assets = [];
    const warnings = [];

    notify(ctx, 'parsing', PROGRESS_FETCH);
    const page = await fetchText(url, { allowPrivateNetwork });
    const pageUrl = page.finalUrl;
    const $ = cheerio.load(page.text);
    const title = extractTitle($, pageUrl);
    const contentHtml = extractArticleContent($, pageUrl);

    notify(ctx, 'parsing', PROGRESS_ASSETS);
    const processedHtml = await collectImages(contentHtml, pageUrl, { allowPrivateNetwork, assets, warnings });
    const markdown = buildMarkdown(preprocessHtml(processedHtml), title);

    const { unified, remarkParse, remarkGfm } = await loadUnified();
    const ir = unified().use(remarkParse).use(remarkGfm).parse(markdown);
    notify(ctx, 'parsing', PROGRESS_IR);

    return createDocument({
        kind: 'document',
        ir,
        data: null,
        meta: { title, sourceType: 'url', sourceName: ctx.sourceName || url, sourceUrl: url, finalUrl: pageUrl },
        assets,
        warnings,
    });
}

function resolveUrl(input) {
    const raw = typeof input === 'string' ? input : (input && input.url);
    if (typeof raw !== 'string' || !raw.trim()) {
        throw new Error('parsers/url 需要 input.url（非空 URL 字符串）');
    }
    return raw.trim();
}

// ---------- 标题与正文提取（源自 旧版 url.js:86-156）----------

// 标题候选，按优先级取第一个非空结果；微信正文标题仅对该站生效
const TITLE_PICKERS = [
    ($, url) => (url.includes('mp.weixin.qq.com') ? $('#activity-name').text() : ''),
    ($) => $('meta[property="og:title"]').attr('content'),
    ($) => $('h1').first().text(),
    ($) => $('title').first().text(),
];

function extractTitle($, url) {
    for (const pick of TITLE_PICKERS) {
        const title = cleanTitle(pick($, url));
        if (title) return title;
    }
    return DEFAULT_TITLE;
}

function cleanTitle(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

// 站点专属选择器：命中即返回
const SITE_SELECTORS = [
    { match: 'mp.weixin.qq.com', selectors: ['#js_content'] },
    { match: 'zhihu.com', selectors: ['.Post-RichTextContainer', '.RichContent-inner'] },
    { match: 'csdn.net', selectors: ['#content_views', '#article_content'] },
    { match: 'jianshu.com', selectors: ['article', '._2rhmJa'] },
];

function extractArticleContent($, url) {
    for (const site of SITE_SELECTORS) {
        if (!url.includes(site.match)) continue;
        for (const selector of site.selectors) {
            const content = $(selector).html();
            if (content) return content;
        }
    }

    for (const tag of ['article', 'main']) {
        const content = $(tag).html();
        if (content) return content;
    }

    // 通用兜底：文本最长的 div
    let bestContent = '';
    let maxLength = 0;
    $('div').each((_, el) => {
        const text = $(el).text().trim();
        if (text.length > maxLength && text.length > MIN_CONTENT_TEXT_LENGTH) {
            maxLength = text.length;
            bestContent = $(el).html();
        }
    });
    return bestContent || $('body').html() || '';
}

/**
 * 图片收集：遍历正文中的 <img>，远程图片经 fetch-guard 下载，data URL 直接解码；
 * 成功者替换 src 为 images/image_N.ext 并推入 assets，失败者记 warning 并保留原 URL。
 */
async function collectImages(html, pageUrl, { allowPrivateNetwork, assets, warnings }) {
    const $ = cheerio.load(html, null, false);
    const candidates = [];

    $('img').each((_, el) => {
        const $img = $(el);
        const raw = pickImageSource($img);
        if (!raw) return;
        const candidate = toCandidate($img, raw, pageUrl);
        if (candidate.warning) warnings.push(candidate.warning);
        else candidates.push(candidate);
    });

    const results = await mapWithConcurrency(candidates, IMAGE_CONCURRENCY, (candidate) =>
        loadImage(candidate, pageUrl, allowPrivateNetwork));

    candidates.forEach((candidate, index) => {
        const result = results[index];
        // 懒加载属性已取值，清掉以免渲染端再度覆盖 src
        for (const attr of IMAGE_SRC_ATTRS) {
            if (attr !== 'src') candidate.$img.removeAttr(attr);
        }
        if (!result.ok) {
            warnings.push(`图片下载失败，保留原地址: ${candidate.display}（${result.error}）`);
            candidate.$img.attr('src', candidate.src);
            return;
        }
        const name = `images/image_${assets.length + 1}${result.ext}`;
        assets.push({ name, buffer: result.buffer, mime: result.mime });
        candidate.$img.attr('src', name);
    });

    return $.html();
}

function pickImageSource($img) {
    for (const attr of IMAGE_SRC_ATTRS) {
        const value = ($img.attr(attr) || '').trim();
        if (value) return value;
    }
    return '';
}

function toCandidate($img, raw, pageUrl) {
    if (/^data:/i.test(raw)) return { $img, kind: 'data', src: raw, display: 'data URL' };
    let absolute;
    try {
        absolute = new URL(raw, pageUrl);
    } catch (err) {
        return { warning: `图片地址非法，保持原样: ${raw}` };
    }
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') {
        return { warning: `图片协议不支持，保持原样: ${absolute.href}` };
    }
    return { $img, kind: 'remote', src: absolute.href, display: absolute.href };
}

async function loadImage(candidate, pageUrl, allowPrivateNetwork) {
    try {
        return candidate.kind === 'data'
            ? decodeDataUrl(candidate.src)
            : await downloadImage(candidate.src, pageUrl, allowPrivateNetwork);
    } catch (err) {
        return { ok: false, error: errText(err) };
    }
}

async function downloadImage(src, pageUrl, allowPrivateNetwork) {
    // Referer 传页面 URL 以通过防盗链校验
    const { buffer, mime } = await fetchBinary(src, { headers: { Referer: pageUrl }, allowPrivateNetwork });
    if (mime.startsWith('text/')) throw new Error(`返回内容不是图片（${mime}）`);
    if (buffer.length === 0) throw new Error('返回内容为空');
    const ext = mime.startsWith('image/') ? getExtFromContentType(mime) : getExtFromUrl(src);
    return { ok: true, buffer, ext, mime: mime.startsWith('image/') ? mime : (MIME_BY_EXT[ext] || mime) };
}

function decodeDataUrl(src) {
    const matched = DATA_URL_RE.exec(src);
    if (!matched) throw new Error('data URL 格式非法');
    const descriptor = matched[1] || '';
    const mime = (descriptor.split(';')[0] || '').trim().toLowerCase();
    if (!mime.startsWith('image/')) throw new Error(`data URL 不是图片（${mime || '未知类型'}）`);
    const buffer = /;base64/i.test(descriptor)
        ? Buffer.from(matched[2], 'base64')
        : Buffer.from(decodeURIComponent(matched[2]), 'utf8');
    if (buffer.length === 0) throw new Error('data URL 内容为空');
    return { ok: true, buffer, ext: getExtFromContentType(mime), mime };
}

async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const run = async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await worker(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
}

// ---------- HTML 预处理（源自 旧版 url.js:339-382）：内联样式 → 语义标签 ----------

const STYLE_TO_TAG_RULES = [
    { selector: 'span, b', re: BOLD_STYLE_RE, tag: 'strong' },
    { selector: 'span', re: ITALIC_STYLE_RE, tag: 'em' },
    { selector: 'span', re: STRIKE_STYLE_RE, tag: 'del' },
];

function preprocessHtml(html) {
    const $ = cheerio.load(html, null, false);
    for (const { selector, re, tag } of STYLE_TO_TAG_RULES) {
        $(selector).each((_, el) => {
            if (re.test($(el).attr('style') || '')) {
                $(el).replaceWith(`<${tag}>${$(el).html()}</${tag}>`);
            }
        });
    }
    $('img').each((_, el) => {
        const dataSrc = $(el).attr('data-src');
        if (dataSrc && !$(el).attr('src')) $(el).attr('src', dataSrc);
    });
    // 移除既无文本又无图片的空 span
    $('span').each((_, el) => {
        if (!$(el).text().trim() && !$(el).find('img').length) $(el).remove();
    });
    return $.html();
}

function buildMarkdown(html, title) {
    const markdown = createTurndownService('url').turndown(html)
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    // 正文没有一级标题时补上文章标题
    return markdown.startsWith('# ') ? markdown : `# ${title}\n\n${markdown}`;
}

// 进度回调异常不得影响解析
function notify(ctx, phase, pct) {
    try {
        if (ctx && typeof ctx.onProgress === 'function') ctx.onProgress(phase, pct);
    } catch (err) { /* 忽略调用方回调自身的异常 */ }
}

function errText(err) {
    return (err && err.message) ? err.message : String(err);
}

module.exports = { parse };
