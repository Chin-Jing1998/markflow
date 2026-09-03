/**
 * URL → IR
 *
 * 流程：fetch-guard 抓页（SSRF 守卫 + 限长限时）→ cheerio 载入 → 标题提取
 *       → 正文提取（web/extract 的三级链路：站点选择器 → Readability → 旧兜底）
 *       → 噪声清洗（web/noise）→ 图片逐张经 fetch-guard 下载进 assets（失败记 warning
 *       并保留原 URL）→ 内联样式预处理 → turndown('url') → 文本规范化（web/normalize）
 *       → remark-parse + remark-gfm
 *
 * 契约：
 *   - async parse({ url } | string, ctx) → MarkFlowDocument{ ir, assets, warnings, meta }
 *   - 不写盘、不打印；ctx.allowPrivateNetwork 透传给 fetch-guard（仅测试使用）
 *   - 成功下载的图片按文档顺序编号为 images/image_N.ext（N 从 1 起），与 assets 一一对应
 *   - ctx.skipImages 为 true 时一张图都不下载：图片地址就地绝对化，清单挂在 data.images 上，
 *     assets 保持为空（供 MCP 的 extract_article 只读提取使用）
 *   - meta 除 title/sourceType/sourceName/sourceUrl/finalUrl 外，另含 extraction（实际命中的
 *     提取方式）、fetchedAt、wordCount 以及 web/metadata 取到的 author/publishedAt/
 *     siteName/excerpt/lang——取不到的字段一律省略而非置空
 */
const cheerio = require('cheerio');
const { loadUnified } = require('../ir/unified-loader');
const { createDocument } = require('../ir/schema');
const { createTurndownService } = require('../ir/turndown');
const { fetchText, fetchBinary } = require('../net/fetch-guard');
const { getExtFromContentType, getExtFromUrl } = require('../ir/util');
const { extractContent, hostnameOf, matchesHost } = require('../web/extract');
const { cleanNoise } = require('../web/noise');
const { normalizeMarkdown } = require('../web/normalize');
const { extractMetadata, countWords } = require('../web/metadata');

const DEFAULT_TITLE = '未命名文章';
// 懒加载图片常用属性，按优先级取第一个非空值
const IMAGE_SRC_ATTRS = ['data-src', 'data-original', 'data-actualsrc', 'data-lazy-src', 'src'];
const IMAGE_CONCURRENCY = 6;
// 进度百分比：parser 只报 parsing 阶段，三个节点单调递增且不超过 55（其后由调度器接管）
const PROGRESS_FETCH = 10;
const PROGRESS_ASSETS = 40;
const PROGRESS_IR = 55;
// skipImages 模式下 data URL 只保留这么长，base64 正文对阅读无价值
const DATA_URL_DISPLAY_MAX = 64;
const BOLD_STYLE_RE = /font-weight\s*:\s*(bold|[6-9]\d{2}|1000)/i;
const ITALIC_STYLE_RE = /font-style\s*:\s*italic/i;
const STRIKE_STYLE_RE = /text-decoration[^;]*line-through/i;
const DATA_URL_RE = /^data:([^,]*),([\s\S]*)$/i;
const MIME_BY_EXT = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
};

/** @param {{ url: string }|string} input @param {{ sourceName?, allowPrivateNetwork?, skipImages?, onProgress? }} ctx */
async function parse(input, ctx = {}) {
    const url = resolveUrl(input);
    const allowPrivateNetwork = ctx.allowPrivateNetwork === true;
    const skipImages = ctx.skipImages === true;
    const assets = [];
    const warnings = [];

    notify(ctx, 'parsing', PROGRESS_FETCH);
    const page = await fetchText(url, { allowPrivateNetwork });
    const pageUrl = page.finalUrl;
    const fetchedAt = new Date().toISOString();
    const $ = cheerio.load(page.text);
    const title = extractTitle($, pageUrl);
    const extracted = extractContent({ $, html: page.text, url: pageUrl });
    const contentHtml = cleanNoise(extracted.html);

    notify(ctx, 'parsing', PROGRESS_ASSETS);
    const { html: processedHtml, images } = skipImages
        ? listImages(contentHtml, pageUrl)
        : { html: await collectImages(contentHtml, pageUrl, { allowPrivateNetwork, assets, warnings }), images: [] };
    const markdown = normalizeMarkdown(buildMarkdown(preprocessHtml(processedHtml), title));

    const { unified, remarkParse, remarkGfm } = await loadUnified();
    const ir = unified().use(remarkParse).use(remarkGfm).parse(markdown);
    notify(ctx, 'parsing', PROGRESS_IR);

    return createDocument({
        kind: 'document',
        ir,
        data: skipImages ? { images } : null,
        meta: {
            title,
            ...extractMetadata({ $, article: extracted.article, url, finalUrl: pageUrl }),
            sourceType: 'url',
            sourceName: ctx.sourceName || url,
            sourceUrl: url,
            finalUrl: pageUrl,
            fetchedAt,
            extraction: extracted.extraction,
            wordCount: countWords(markdown),
        },
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

// ---------- 标题提取（源自 旧版 url.js:86-156；正文提取已迁往 web/extract.js）----------

// 标题候选，按优先级取第一个非空结果；微信正文标题仅对该站生效
const TITLE_PICKERS = [
    ($, url) => (matchesHost(hostnameOf(url), 'mp.weixin.qq.com') ? $('#activity-name').text() : ''),
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

/**
 * 只读模式的图片处理：不下载任何图片，就地把地址绝对化，并按文档顺序列出清单。
 * data URL 截断保留类型前缀——完整 base64 对阅读没有价值，还会撑爆返回体积。
 */
function listImages(html, pageUrl) {
    const $ = cheerio.load(html, null, false);
    const images = [];
    $('img').each((_, el) => {
        const $img = $(el);
        const raw = pickImageSource($img);
        // 懒加载属性已取值，清掉以免渲染端再度覆盖 src
        for (const attr of IMAGE_SRC_ATTRS) {
            if (attr !== 'src') $img.removeAttr(attr);
        }
        if (!raw) return;
        const src = toDisplayUrl(raw, pageUrl);
        $img.attr('src', src);
        images.push({ url: src, alt: ($img.attr('alt') || '').trim() });
    });
    return { html: $.html(), images };
}

function toDisplayUrl(raw, pageUrl) {
    if (/^data:/i.test(raw)) {
        return raw.length > DATA_URL_DISPLAY_MAX ? `${raw.slice(0, DATA_URL_DISPLAY_MAX)}...` : raw;
    }
    try {
        return new URL(raw, pageUrl).href;
    } catch (err) {
        return raw;
    }
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
