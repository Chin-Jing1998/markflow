/**
 * 不可信 HTML 清洗（方案 §3.4.6「直接打开 html」；纯逻辑，不依赖 Electron，也不触碰文件系统）
 *
 * sanitizeHtml(html, { baseDir?, assetBase?, allowedExts? }) → { html, warnings, removed, images, links }
 *   removed  各类被删元素的计数 { script, iframe, object, embed, form, meta, link, base }
 *   images   { local, remote, blocked }；links { external, stripped }
 *
 * 清洗规则（渲染进程把结果放进 <iframe sandbox srcdoc>，CSP 由 mf-app 响应头继承而来，此处是第二道闸）：
 *   1. 整体删除 script / iframe / object / embed / applet / frame / frameset / form / base / link
 *      / meta[http-equiv]（link 一律删净，含 rel=stylesheet 与各类资源提示，它们只会引向远程资源）；
 *   2. 删除全部 on* 事件属性，以及 srcset / ping / formaction 这类会另起请求或提交的属性；
 *   3. a[href] 只保留 http(s) 与同文档片段（#...），其余（javascript: / data:text/html / file: …）连属性一并删除；
 *      保留的外链加 rel="noopener noreferrer" 与 target="_blank"，由承载页的 setWindowOpenHandler 交
 *      shell.openExternal 打开（沙箱帧内无脚本，只能走这条路）；
 *   4. img[src]：data:image/* 原样保留；http(s) 与其它协议一律丢 src 只留 alt（远程图在本机发起请求
 *      等于把 SSRF 守卫拦下的地址重新放行）；相对路径在 baseDir 内且扩展名命中白名单时改写为
 *      assetBase + 相对路径，越界或扩展名不合一律丢 src 留 alt；其余元素的 URL 属性（src/poster/
 *      background/data/xlink:href）一律删除；
 *   5. style 属性与 <style> 正文里的 url(...) 除 data: 外一律替换为 none，避免样式通道外发请求。
 *
 * 被删元素与被拦图片计入返回值，界面据此提示「已拦截 N 张远程图片」一类信息。
 */
const path = require('path');
const { load } = require('cheerio');

const { isWithinDir } = require('../../converters/util');
const { ASSET_EXTENSIONS } = require('./asset-protocol');

/** 整体删除（含子孙）的元素；form 一并删除其内容：阅读视图不承载任何交互输入 */
const REMOVED_TAGS = Object.freeze(['script', 'iframe', 'object', 'embed', 'applet', 'frame', 'frameset', 'form', 'base', 'link']);
/** 只删特定属性组合的元素 */
const REMOVED_SELECTORS = Object.freeze(['meta[http-equiv]']);
/** 计数分类：把 applet/frame/frameset 归入 object，避免计数表无限膨胀 */
const REMOVED_GROUPS = Object.freeze({
    script: 'script', iframe: 'iframe', object: 'object', applet: 'object', frame: 'iframe', frameset: 'iframe',
    embed: 'embed', form: 'form', base: 'base', link: 'link', meta: 'meta',
});
/** 无条件删除的属性（正则匹配的 on* 另行处理） */
const DROPPED_ATTRS = Object.freeze(['srcset', 'ping', 'formaction', 'formtarget', 'background', 'lowsrc', 'dynsrc']);
/** 除 img 外，携带 URL 的属性一律删除：音视频与对象资源不在阅读视图的职责内 */
const URL_ATTRS = Object.freeze(['src', 'href', 'poster', 'data', 'action', 'codebase', 'xlink:href', 'longdesc', 'cite', 'usemap', 'profile', 'manifest']);
const EVENT_ATTR_RE = /^on/i;
const HTTP_RE = /^https?:$/i;
const FRAGMENT_RE = /^#/;
const DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+[;,]/i;
/** CSS 的 url(...)：单双引号与裸串三种写法 */
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
const DATA_URI_RE = /^data:/i;
/** 协议前缀：有则视为绝对地址（含 javascript: 与 data:）；// 开头的协议相对地址单独判 */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const PROTOCOL_RELATIVE_RE = /^\/\//;

const emptyStats = () => ({ script: 0, iframe: 0, object: 0, embed: 0, form: 0, base: 0, link: 0, meta: 0 });

/**
 * @param {string} html 不可信 HTML 全文
 * @param {{ baseDir?: string, assetBase?: string, allowedExts?: string[] }} [options]
 *   baseDir   该 HTML 所在目录的绝对路径；相对图片据此判定边界，缺省则相对图片一律丢 src
 *   assetBase 形如 'mf-asset://<sid>/' 的前缀；缺省则不改写任何图片地址
 * @returns {{ html: string, warnings: string[], removed: object, images: object, links: object }}
 */
function sanitizeHtml(html, { baseDir = null, assetBase = null, allowedExts = ASSET_EXTENSIONS } = {}) {
    const $ = load(String(html == null ? '' : html));
    const removed = emptyStats();
    const images = { local: 0, remote: 0, blocked: 0 };
    const links = { external: 0, stripped: 0 };
    const exts = new Set((allowedExts || ASSET_EXTENSIONS).map((ext) => String(ext).toLowerCase()));

    for (const selector of [...REMOVED_TAGS, ...REMOVED_SELECTORS]) {
        const nodes = $(selector);
        const group = REMOVED_GROUPS[selector.split('[')[0]] || selector;
        if (removed[group] !== undefined) removed[group] += nodes.length;
        nodes.remove();
    }

    $('*').each((index, node) => {
        if (!node || node.type !== 'tag') return;
        stripAttributes($, node);
        const tag = String(node.name || '').toLowerCase();
        if (tag === 'a') rewriteAnchor($, node, links);
        else if (tag === 'img') rewriteImage($, node, { baseDir, assetBase, exts, images });
        else dropUrlAttrs($, node);
        const style = $(node).attr('style');
        if (typeof style === 'string') $(node).attr('style', stripCssUrls(style));
    });

    $('style').each((index, node) => {
        const text = $(node).html();
        if (typeof text === 'string') $(node).text(stripCssUrls(text));
    });

    return { html: $.html(), warnings: buildWarnings(removed, images), removed, images, links };
}

// ============================================================
// 元素改写
// ============================================================

function stripAttributes($, node) {
    for (const name of Object.keys(node.attribs || {})) {
        if (EVENT_ATTR_RE.test(name) || DROPPED_ATTRS.includes(name.toLowerCase())) $(node).removeAttr(name);
    }
}

function dropUrlAttrs($, node) {
    for (const name of Object.keys(node.attribs || {})) {
        if (URL_ATTRS.includes(name.toLowerCase())) $(node).removeAttr(name);
    }
}

/** 外链只留 http(s)（新窗口交主进程转系统浏览器）与同文档片段，其余连属性删除 */
function rewriteAnchor($, node, links) {
    dropUrlAttrsExceptHref($, node);
    const href = String($(node).attr('href') || '').trim();
    if (!href) return;
    if (FRAGMENT_RE.test(href)) return;
    const url = parseUrl(href);
    if (!url || !HTTP_RE.test(url.protocol)) {
        $(node).removeAttr('href');
        $(node).removeAttr('target');
        links.stripped += 1;
        return;
    }
    $(node).attr('href', url.href);
    $(node).attr('rel', 'noopener noreferrer');
    $(node).attr('target', '_blank');
    links.external += 1;
}

function dropUrlAttrsExceptHref($, node) {
    for (const name of Object.keys(node.attribs || {})) {
        const lower = name.toLowerCase();
        if (lower !== 'href' && URL_ATTRS.includes(lower)) $(node).removeAttr(name);
    }
}

function rewriteImage($, node, { baseDir, assetBase, exts, images }) {
    for (const name of Object.keys(node.attribs || {})) {
        const lower = name.toLowerCase();
        if (lower !== 'src' && URL_ATTRS.includes(lower)) $(node).removeAttr(name);
    }
    const src = String($(node).attr('src') || '').trim();
    if (!src) return;
    if (DATA_IMAGE_RE.test(src)) {
        images.local += 1;
        return;
    }
    if (SCHEME_RE.test(src) || PROTOCOL_RELATIVE_RE.test(src)) {
        $(node).removeAttr('src');
        images.remote += 1;
        return;
    }
    const rewritten = assetUrlFor(src, { baseDir, assetBase, exts });
    if (!rewritten) {
        $(node).removeAttr('src');
        images.blocked += 1;
        return;
    }
    $(node).attr('src', rewritten);
    images.local += 1;
}

/**
 * 相对地址 → mf-asset 地址；越界、扩展名不合白名单、缺少 baseDir/assetBase 时返回 null。
 * 查询串与片段一并丢弃：mf-asset 只按路径寻址。
 */
function assetUrlFor(src, { baseDir, assetBase, exts = new Set(ASSET_EXTENSIONS) } = {}) {
    if (!baseDir || !assetBase) return null;
    const clean = String(src).split('#')[0].split('?')[0];
    if (!clean) return null;
    let decoded;
    try {
        decoded = decodeURIComponent(clean);
    } catch (err) {
        decoded = clean;
    }
    if (path.isAbsolute(decoded) || /^[A-Za-z]:/.test(decoded)) return null;
    const base = path.resolve(baseDir);
    const abs = path.resolve(base, decoded);
    if (!isWithinDir(base, abs) || abs === base) return null;
    if (!exts.has(path.extname(abs).toLowerCase())) return null;
    const rel = path.relative(base, abs).split(path.sep).map((segment) => encodeURIComponent(segment)).join('/');
    return `${String(assetBase).replace(/\/+$/, '')}/${rel}`;
}

/** CSS 里的 url()：data: 保留，其余替换为 none（属性值与 <style> 正文共用） */
function stripCssUrls(css) {
    return String(css).replace(CSS_URL_RE, (match, dq, sq, bare) => {
        const value = String(dq !== undefined ? dq : (sq !== undefined ? sq : bare) || '').trim();
        return DATA_URI_RE.test(value) ? match : 'none';
    });
}

function parseUrl(href) {
    try {
        return new URL(href, 'https://markflow.invalid/');
    } catch (err) {
        return null;
    }
}

function buildWarnings(removed, images) {
    const warnings = [];
    const dropped = Object.entries(removed).filter(([, count]) => count > 0).map(([key, count]) => `${key} ×${count}`);
    if (dropped.length > 0) warnings.push(`已移除不安全元素：${dropped.join('、')}`);
    if (images.remote > 0) warnings.push(`已拦截 ${images.remote} 张远程图片（只保留替代文字）`);
    if (images.blocked > 0) warnings.push(`有 ${images.blocked} 张图片位于可访问目录之外或格式不被支持，已只保留替代文字`);
    return warnings;
}

module.exports = { sanitizeHtml, assetUrlFor, stripCssUrls, REMOVED_TAGS, URL_ATTRS, DROPPED_ATTRS };
