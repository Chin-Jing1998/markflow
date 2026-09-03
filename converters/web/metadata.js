/**
 * 网页元数据提取
 *
 * 数据源有两处：页面自身的 <meta>/<time>/<html lang>（经 cheerio 读取），
 * 以及 Readability 解析出的 article（未走 Readability 分支时为 null）。
 * 每个字段按固定优先级取第一个有效值，取不到就整字段省略——绝不写空串占位，
 * 否则下游 YAML front matter 会出现一堆 `author: ""` 噪声。
 *
 * 时间统一为 ISO 8601（Date 可解析才输出，不可解析则省略该字段）。
 */

// 摘要最大长度，按 Unicode 码点计（避免截断代理对）
const EXCERPT_MAX_LENGTH = 200;
// article:author 常填作者主页地址而非姓名，遇到 URL 则跳过
const URL_LIKE_RE = /^https?:\/\//i;
// 统计词数：中日韩统一表意文字按字计，其余按连续字母数字段落计。
// CJK 区间以码点声明并运行时拼装，避免源码里出现易被规范化改写的字面量。
const CJK_RANGES = Object.freeze([
    [0x3400, 0x4dbf],   // 扩展 A
    [0x4e00, 0x9fff],   // 基本区
    [0xf900, 0xfaff],   // 兼容表意文字
    [0x3040, 0x30ff],   // 日文假名
    [0xac00, 0xd7af],   // 谚文音节
]);
const hex4 = (cp) => `\\u${cp.toString(16).padStart(4, '0')}`;
const CJK_RE = new RegExp(`[${CJK_RANGES.map(([from, to]) => `${hex4(from)}-${hex4(to)}`).join('')}]`, 'g');
const WORD_RE = /[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g;

/**
 * @param {object} params
 * @param {import('cheerio').CheerioAPI} params.$ 载入整页 HTML 的 cheerio 实例
 * @param {object|null} params.article Readability 的解析结果，未使用该分支时为 null
 * @param {string} params.url 请求 URL
 * @param {string} params.finalUrl 重定向后的最终 URL
 * @returns {{ author?, publishedAt?, siteName?, excerpt?, lang? }} 只含取到值的字段
 */
function extractMetadata({ $, article, url, finalUrl }) {
    return compact({
        author: pickAuthor($, article),
        publishedAt: pickPublishedAt($, article),
        siteName: pickSiteName($, article, finalUrl || url),
        excerpt: pickExcerpt($, article),
        lang: pickLang($, article),
    });
}

// ---------- 各字段的取值链 ----------

function pickAuthor($, article) {
    const candidates = [
        article && article.byline,
        metaContent($, 'meta[name="author"]'),
        metaContent($, 'meta[property="article:author"]'),
        metaContent($, 'meta[name="twitter:creator"]'),
    ];
    for (const raw of candidates) {
        const value = squeeze(raw);
        if (value && !URL_LIKE_RE.test(value)) return value;
    }
    return '';
}

function pickPublishedAt($, article) {
    const candidates = [
        metaContent($, 'meta[property="article:published_time"]'),
        metaContent($, 'meta[itemprop="datePublished"]'),
        metaContent($, 'meta[name="pubdate"]'),
        $('time[datetime]').first().attr('datetime'),
        article && article.publishedTime,
    ];
    for (const raw of candidates) {
        const iso = toIsoString(raw);
        if (iso) return iso;
    }
    return '';
}

function pickSiteName($, article, url) {
    const candidates = [
        metaContent($, 'meta[property="og:site_name"]'),
        article && article.siteName,
        metaContent($, 'meta[name="application-name"]'),
        hostnameOf(url),
    ];
    for (const raw of candidates) {
        const value = squeeze(raw);
        if (value) return value;
    }
    return '';
}

function pickExcerpt($, article) {
    const candidates = [
        article && article.excerpt,
        metaContent($, 'meta[name="description"]'),
        metaContent($, 'meta[property="og:description"]'),
    ];
    for (const raw of candidates) {
        const value = squeeze(raw);
        if (value) return truncate(value, EXCERPT_MAX_LENGTH);
    }
    return '';
}

function pickLang($, article) {
    const candidates = [
        $('html').first().attr('lang'),
        article && article.lang,
        metaContent($, 'meta[http-equiv="content-language"]'),
        metaContent($, 'meta[property="og:locale"]'),
    ];
    for (const raw of candidates) {
        const value = squeeze(raw);
        if (value) return value;
    }
    return '';
}

// ---------- 通用工具 ----------

const metaContent = ($, selector) => $(selector).first().attr('content');

// 折叠空白并去首尾；非字符串一律归零
function squeeze(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

// 可被 Date 解析才返回 ISO 串，否则返回空串（调用方据此跳过该候选）
function toIsoString(value) {
    const text = squeeze(value);
    if (!text) return '';
    const time = Date.parse(text);
    return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

// 按码点截断，超长时以省略号收尾
function truncate(text, maxLength) {
    const chars = Array.from(text);
    return chars.length <= maxLength ? text : `${chars.slice(0, maxLength).join('')}…`;
}

function hostnameOf(url) {
    try { return new URL(String(url)).hostname || ''; } catch (err) { return ''; }
}

// 剔除空值字段：下游 front matter 只写实际存在的键
function compact(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== '' && value != null));
}

/** 中文按字计、西文按词计的词数统计；Markdown 语法字符不单独计数 */
function countWords(text) {
    const source = String(text == null ? '' : text);
    const cjk = (source.match(CJK_RE) || []).length;
    const words = (source.replace(CJK_RE, ' ').match(WORD_RE) || []).length;
    return cjk + words;
}

module.exports = { extractMetadata, countWords, EXCERPT_MAX_LENGTH };
