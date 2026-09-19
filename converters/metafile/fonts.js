'use strict';
/**
 * 图元字体表：Windows 字体名 → CSS 字体栈（含 macOS 回退）、字体上升部、符号字体判定
 *
 * 职责边界：纯查表模块，不 require 任何东西（含同目录），供 svg-writer.js 与回放层调用。
 *   - fontStack(face)        → CSS font-family 取值。字体名来自不可信文件，先剔除引号与 ; { } < >
 *                              （能闭合样式声明或注入标签的字符，同 raster/fragment.js 的 FONT_FAMILY_RE 思路），
 *                              再拼上回退栈。XML 转义由 svg-writer.js 负责，两层分工不重叠。
 *   - ascentOf(face)         → 上升部占 em 的比例，取自各字体的 hhea／OS2；未列出的按 FALLBACK_ASCENT 估。
 *                              经典段的 TA_BASELINE 用不到它，TA_TOP／TA_BOTTOM 与 EMF+ 的 DrawString 要用。
 *   - isSymbolFont / hasPrivateUseChars
 *                            → Symbol／Wingdings 系列字体与 U+F020–U+F0FF 字符的判定。本批只出诊断项：
 *                              这类文字按原字符输出会得到错误字形（ChemDraw 用 Symbol 写 α、β、Δ、→），
 *                              编码映射表留到 W5。
 *
 * macOS 无宋体、黑体等 Windows 中文字体，回退栈给出本机等价字体；字宽差异在经典段由逐字 Dx 定位抵消。
 */

/** 能闭合 CSS 声明或注入标签的字符，一律剔除 */
const UNSAFE_FONT_CHARS = /["';{}<>]/g;
/** 控制字符（含 DEL），一律剔除 */
const FONT_CONTROL_CHARS = /[\x00-\x1F\x7F]/g;
/** 私用区：Symbol 类字体常把 α、β、→ 编到这一段 */
const PRIVATE_USE_RE = /[\uf000-\uf0ff]/;
/** LOGFONT.lfCharSet 的 SYMBOL_CHARSET */
const SYMBOL_CHARSET = 2;
/** 未列入上升部表的字体按此估算 */
const FALLBACK_ASCENT = 0.9;
/** 字体名缺失时的兜底 */
const DEFAULT_FACE = 'Arial';
/** 通用回退栈：正文无衬线 */
const SANS_FALLBACK = 'Arial, Helvetica, sans-serif';

/** 常见字体的上升部（占 em 的比例，取自各字体 hhea／OS2） */
const ASCENT = Object.freeze({
    arial: 0.905,
    'arial narrow': 0.905,
    helvetica: 0.932,
    'times new roman': 0.891,
    times: 0.891,
    'courier new': 0.833,
    calibri: 0.75,
    cambria: 0.95,
    'cambria math': 0.95,
    tahoma: 1.0,
    verdana: 1.005,
    symbol: 1.005,
    wingdings: 0.9,
    simsun: 0.859,
    '宋体': 0.859,
    simhei: 0.859,
    '黑体': 0.859,
    kaiti: 0.859,
    '楷体': 0.859,
    fangsong: 0.859,
    '仿宋': 0.859,
    'microsoft yahei': 1.056,
    '微软雅黑': 1.056,
});

/** Windows 字体名 → 本机可用的回退栈（不含字体名自身，由 fontStack 拼在最前） */
const FALLBACK_STACK = Object.freeze({
    simsun: "'Songti SC', STSong, serif",
    '宋体': "'Songti SC', STSong, serif",
    nsimsun: "'Songti SC', STSong, serif",
    simhei: "'Heiti SC', STHeiti, sans-serif",
    '黑体': "'Heiti SC', STHeiti, sans-serif",
    kaiti: "'Kaiti SC', STKaiti, serif",
    '楷体': "'Kaiti SC', STKaiti, serif",
    kaiti_gb2312: "'Kaiti SC', STKaiti, serif",
    fangsong: "'Fangsong SC', STFangsong, serif",
    '仿宋': "'Fangsong SC', STFangsong, serif",
    'microsoft yahei': "'PingFang SC', 'Noto Sans CJK SC', sans-serif",
    '微软雅黑': "'PingFang SC', 'Noto Sans CJK SC', sans-serif",
    'times new roman': 'Times, serif',
    georgia: 'Times, serif',
    cambria: "'Times New Roman', Times, serif",
    'cambria math': "'STIX Two Math', 'Times New Roman', serif",
    'courier new': 'Courier, monospace',
    consolas: "'Courier New', Courier, monospace",
    symbol: "'Apple Symbols', serif",
    wingdings: "'Apple Symbols', serif",
    webdings: "'Apple Symbols', serif",
});

/** 判定为符号字体的字体名前缀（这些字体的码位不是普通字符） */
const SYMBOL_FACE_PREFIXES = Object.freeze([
    'symbol', 'wingdings', 'webdings', 'marlett', 'monotype sorts', 'zapfdingbats', 'zapf dingbats',
]);

const normalizeFace = (face) => String(face == null ? '' : face).trim().toLowerCase();

/** 剔除引号、分号与尖括号等不安全字符；净化后为空则回落到 DEFAULT_FACE */
function sanitizeFontName(face) {
    const cleaned = String(face == null ? '' : face)
        .replace(FONT_CONTROL_CHARS, '')
        .replace(UNSAFE_FONT_CHARS, '')
        .trim();
    return cleaned || DEFAULT_FACE;
}

/** CSS font-family 取值：净化后的字体名加引号，再接回退栈 */
function fontStack(face) {
    const name = sanitizeFontName(face);
    const fallback = FALLBACK_STACK[normalizeFace(name)] || SANS_FALLBACK;
    return `'${name}', ${fallback}`;
}

/** 上升部占 em 的比例 */
function ascentOf(face) {
    const key = normalizeFace(face);
    return ASCENT[key] === undefined ? FALLBACK_ASCENT : ASCENT[key];
}

/** 符号字体：lfCharSet 为 SYMBOL_CHARSET，或字体名落在符号字体系列内 */
function isSymbolFont(face, charSet) {
    if (charSet === SYMBOL_CHARSET) return true;
    const key = normalizeFace(face);
    return SYMBOL_FACE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** 文字是否含私用区字符（U+F000–U+F0FF） */
function hasPrivateUseChars(text) {
    return PRIVATE_USE_RE.test(String(text == null ? '' : text));
}

module.exports = {
    DEFAULT_FACE,
    FALLBACK_ASCENT,
    SYMBOL_CHARSET,
    sanitizeFontName,
    fontStack,
    ascentOf,
    isSymbolFont,
    hasPrivateUseChars,
};
