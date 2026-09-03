/**
 * 网页正文提取（三级链路）
 *
 *   1) 站点专属选择器 —— 命中即用，extraction 记为 'site:<域名片段>'；
 *   2) Readability    —— 未命中站点表时启用，extraction 记为 'readability'；
 *   3) 旧兜底链路      —— Readability 判定不可读、解析失败或正文过短时启用，
 *                        依次 <article> → <main> → 文本最长的 div → <body>，
 *                        extraction 记为 'fallback:article' 等。
 *
 * 之所以保留兜底链路：Readability 依赖段落长度打分，对段落极短的中文页面、
 * 纯列表页与代码密集页会判负，此时旧链路仍能捞回正文。
 *
 * Readability 会就地改写传入的 document，故此处用 linkedom 单独解析一份 DOM，
 * 与调用方持有的 cheerio 实例互不影响。
 */
const { parseHTML } = require('linkedom');
const { Readability, isProbablyReaderable } = require('@mozilla/readability');

// 站点专属选择器：url 含 match 时按 selectors 顺序取第一个非空结果
const SITE_SELECTORS = Object.freeze([
    { match: 'mp.weixin.qq.com', selectors: ['#js_content'] },
    { match: 'zhihu.com', selectors: ['.Post-RichTextContainer', '.RichContent-inner'] },
    { match: 'csdn.net', selectors: ['#content_views', '#article_content'] },
    { match: 'jianshu.com', selectors: ['article', '._2rhmJa'] },
    { match: 'juejin.cn', selectors: ['#article-root', '.article-content'] },
    { match: 'segmentfault.com', selectors: ['#article-content', '.article-content'] },
    { match: 'sspai.com', selectors: ['.article-body'] },
    { match: 'cnblogs.com', selectors: ['#cnblogs_post_body'] },
]);

// 兜底链路中直接按标签取的两级
const FALLBACK_TAGS = Object.freeze(['article', 'main']);
// 兜底「最长 div」：只考虑文本超过此长度的 div
const MIN_CONTENT_TEXT_LENGTH = 200;
// Readability 结果的正文字符数低于此值视为失败，转入兜底链路
const MIN_READABILITY_TEXT_LENGTH = 200;
// charThreshold 默认 500 是按英文文章定的，中文单字信息量更大，短文常不足 500 字，故下调
const READABILITY_OPTIONS = Object.freeze({ charThreshold: 100 });
// 可读性预判阈值同样下调：默认 (140, 20) 要求段落普遍超过 140 字符，中文段落多在 50-150 字之间，
// 按默认值几乎所有中文文章都会被判为不可读。放宽后误判的代价可控——Readability 自身的
// charThreshold 与下面的 MIN_READABILITY_TEXT_LENGTH 会把真正提取不出正文的情况挡回兜底链路。
const READERABLE_OPTIONS = Object.freeze({ minContentLength: 50, minScore: 10 });

/**
 * @param {object} params
 * @param {import('cheerio').CheerioAPI} params.$ 已载入整页 HTML 的 cheerio 实例
 * @param {string} params.html 原始页面 HTML 文本
 * @param {string} params.url 页面 URL（用于站点选择器匹配）
 * @returns {{ html: string, extraction: string, article: object|null }}
 */
function extractContent({ $, html, url }) {
    const bySite = extractBySite($, url);
    if (bySite) return { ...bySite, article: null };

    const byReadability = extractByReadability(html);
    if (byReadability) return byReadability;

    return { ...extractByFallback($), article: null };
}

// ---------- 一级：站点专属选择器 ----------

/** 取 URL 主机名；解析失败返回空串 */
function hostnameOf(url) {
    try {
        return new URL(String(url || '')).hostname.toLowerCase();
    } catch (err) {
        return '';
    }
}

/** 主机名匹配：全等或为其子域，避免查询串等位置的子串误命中 */
function matchesHost(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
}

function extractBySite($, url) {
    const host = hostnameOf(url);
    for (const site of SITE_SELECTORS) {
        if (!matchesHost(host, site.match)) continue;
        for (const selector of site.selectors) {
            const content = $(selector).first().html();
            if (content && content.trim()) return { html: content, extraction: `site:${site.match}` };
        }
    }
    return null;
}

// ---------- 二级：Readability ----------

function extractByReadability(html) {
    let document;
    try {
        ({ document } = parseHTML(String(html || '')));
    } catch (err) {
        return null;
    }
    if (!document || !isReaderable(document)) return null;

    let article;
    try {
        article = new Readability(document, { ...READABILITY_OPTIONS }).parse();
    } catch (err) {
        return null;
    }
    if (!article || !article.content) return null;
    const textLength = String(article.textContent || '').trim().length;
    if (textLength < MIN_READABILITY_TEXT_LENGTH) return null;
    return { html: article.content, extraction: 'readability', article };
}

// isProbablyReaderable 内部依赖 matches/className 等 DOM 能力，异常时按不可读处理
function isReaderable(document) {
    try {
        return isProbablyReaderable(document, { ...READERABLE_OPTIONS });
    } catch (err) {
        return false;
    }
}

// ---------- 三级：旧兜底链路 ----------

function extractByFallback($) {
    for (const tag of FALLBACK_TAGS) {
        const content = $(tag).first().html();
        if (content && content.trim()) return { html: content, extraction: `fallback:${tag}` };
    }

    const longest = longestDiv($);
    if (longest) return { html: longest, extraction: 'fallback:longest-div' };

    const body = $('body').html();
    if (body && body.trim()) return { html: body, extraction: 'fallback:body' };
    return { html: '', extraction: 'fallback:empty' };
}

function longestDiv($) {
    let best = '';
    let maxLength = 0;
    $('div').each((_, el) => {
        const text = $(el).text().trim();
        if (text.length > maxLength && text.length > MIN_CONTENT_TEXT_LENGTH) {
            maxLength = text.length;
            best = $(el).html();
        }
    });
    return best;
}

module.exports = {
    extractContent,
    SITE_SELECTORS,
    MIN_READABILITY_TEXT_LENGTH,
    READERABLE_OPTIONS, hostnameOf, matchesHost };
