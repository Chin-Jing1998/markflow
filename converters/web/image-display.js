/**
 * 网页图片的显示尺寸
 *
 * displaySizeOf($img, host) → { width, height?, unit: 'px' | '%', source: 'web' } | null
 *   取值优先级：width 属性 → style 的 width（px 或 %）→ data-mf-width（web/extract 在 Readability 清样式前
 *   从 style 预标注）→ 微信的 data-w（图片原始像素宽，仅微信公众号页面）。
 *   微信公众号：px 取 min(px, WX_COLUMN_PX)（超栏图由 max-width:100% 压回栏宽，height 同比缩放）；
 *   百分比按栏宽换算为 px（round(pct × 栏宽 / 100)）。其它站点 px 原样、百分比保留为 '%'。
 *   只有同时显式给出 px 宽高时才记 height；取不到宽度返回 null（不设 display）。
 * formatDisplayAttr(display) → data-mf-display 属性值（'677' | '677x300' | '50%'），由 ir/turndown 的
 *   imgDisplay 规则读回并输出 <img … width>。
 */

const WECHAT_HOST = 'mp.weixin.qq.com';
/**
 * 微信公众号 PC 端正文栏宽（px）。2026-09-15 实测三篇样本：正文容器 section 的 style 宽 677px；
 * 图片 style 宽 754px 者（超出栏宽）由 max-width:100% 压回 677px，width:100% 者即 677px。
 */
const WX_COLUMN_PX = 677;
const PERCENT_BASE = 100;
const MAX_PERCENT = 100;
const ATTR_DIMENSION_RE = /^\s*(\d{1,5}(?:\.\d+)?)\s*(px|%)?\s*$/i;
const styleRe = (prop) => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d{1,5}(?:\\.\\d+)?)\\s*(px|%)`, 'i');
const STYLE_WIDTH_RE = styleRe('width');
const STYLE_HEIGHT_RE = styleRe('height');
const SOURCE = 'web';

const isWechatHost = (host) => {
    const name = String(host || '').toLowerCase();
    return name === WECHAT_HOST || name.endsWith(`.${WECHAT_HOST}`);
};

function displaySizeOf($img, host) {
    const read = (name) => String($img.attr(name) || '').trim();
    const wechat = isWechatHost(host);
    const style = read('style');
    const width = parseDimension(read('width'))
        || matchStyle(style, STYLE_WIDTH_RE)
        || parseDimension(read('data-mf-width'))
        || (wechat ? pxOnly(parseDimension(read('data-w'))) : null);
    if (!width) return null;
    const height = width.unit === 'px' ? pxOnly(parseDimension(read('height')) || matchStyle(style, STYLE_HEIGHT_RE)) : null;
    return finalize(width, height, wechat);
}

function finalize(width, height, wechat) {
    if (width.unit === '%') {
        if (!wechat) return { width: roundPercent(width.value), unit: '%', source: SOURCE };
        return { width: Math.round((width.value * WX_COLUMN_PX) / PERCENT_BASE), unit: 'px', source: SOURCE };
    }
    let w = Math.round(width.value);
    let h = height ? Math.round(height.value) : 0;
    if (wechat && w > WX_COLUMN_PX) {
        if (h) h = Math.round((h * WX_COLUMN_PX) / w);
        w = WX_COLUMN_PX;
    }
    if (w < 1) return null;
    const display = { width: w };
    if (h >= 1) display.height = h;
    display.unit = 'px';
    display.source = SOURCE;
    return display;
}

function parseDimension(raw) {
    const matched = ATTR_DIMENSION_RE.exec(String(raw || ''));
    if (!matched) return null;
    const value = Number(matched[1]);
    const unit = String(matched[2] || 'px').toLowerCase();
    if (!(value > 0)) return null;
    if (unit === '%' && value > MAX_PERCENT) return null;
    return { value, unit };
}

function matchStyle(style, re) {
    const matched = re.exec(String(style || ''));
    return matched ? parseDimension(`${matched[1]}${matched[2]}`) : null;
}

const pxOnly = (dimension) => (dimension && dimension.unit === 'px' ? dimension : null);
const roundPercent = (value) => Math.round(value * PERCENT_BASE) / PERCENT_BASE;

function formatDisplayAttr(display) {
    if (!display || !Number.isFinite(display.width)) return '';
    if (display.unit === '%') return `${display.width}%`;
    return Number.isFinite(display.height) ? `${display.width}x${display.height}` : String(display.width);
}

module.exports = { displaySizeOf, formatDisplayAttr, WX_COLUMN_PX };
