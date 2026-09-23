/**
 * 网页段首缩进识别（url 解析器的 preprocessHtml 与 web/extract 的 Readability 预标注共用）
 *
 *   indentFromStyleChain(styles)  styles 为「自身 → 祖先」由近及远的 style 串；text-indent 是继承属性，
 *                                 取最近一处声明：em 四舍五入；rem 按根字号 16px 折算；px 除以最近一处
 *                                 font-size（px，缺省 16）；结果钳制到 1–4，非正值（含显式 0）返回 0
 *   leadingIndentRun(text)        段首连续空白里 NBSP / U+3000 / em 空格 / en 空格合计 ≥ 2 个时返回
 *                                 { count, length }：count = U+3000 与 em 空格个数 + ⌈NBSP 与 en 空格个数 / 2⌉，
 *                                 length 为应删除的前缀长度（含其间的 ASCII 空白）；否则返回 null。
 *                                 ASCII 空格在 HTML 中会被折叠、不产生缩进，故不计数
 *   LEAF_BLOCK_SELECTOR           缩进的承载者：这些块元素中不含 NESTED_BLOCK_TAGS 后代者为「叶子块」
 *   NESTED_BLOCK_TAGS             嵌套块的标签名列表，是唯一的事实来源
 *   NESTED_BLOCK_SELECTOR         由 NESTED_BLOCK_TAGS 派生的选择器串，供按选择器查询的调用方使用
 */

const LEAF_BLOCK_SELECTOR = 'p, section, div, li, blockquote';
// 标签名列表与选择器串二者必须一致，故以列表为源头派生出串：url.js 的 markIndents 按标签名逐个后代比对，
// web/extract.js 的 annotateLayout 把串交给 linkedom 的 querySelector
const NESTED_BLOCK_TAGS = Object.freeze([
    'p', 'section', 'div', 'li', 'blockquote', 'ul', 'ol', 'table', 'figure', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);
const NESTED_BLOCK_SELECTOR = NESTED_BLOCK_TAGS.join(', ');

// 旧式数值之后的三个 \s* 之间只隔两个可空项，不命中时要把同一段空白在三者之间的各种分法逐一试遍，耗时随段长立方增长；
// 现把单位与 !important 各自连同其后的空白并成可选组，每段空白只归一处，匹配位置与各捕获组均与旧式相同
const TEXT_INDENT_RE = /(?:^|;)\s*text-indent\s*:\s*(-?\d+(?:\.\d+)?)\s*(?:(em|rem|px)\s*)?(?:!important\s*)?(?=;|$)/i;
const FONT_SIZE_RE = /(?:^|;)\s*font-size\s*:\s*(\d+(?:\.\d+)?)px/i;
const DEFAULT_FONT_PX = 16;
const ROOT_FONT_PX = 16;
const MIN_INDENT = 1;
const MAX_INDENT = 4;
// 不可见字符以码点声明、运行时生成（与 web/normalize 同一约定）：U+3000 全角空格、U+2003 em 空格记一字，
// U+00A0 不换行空格、U+2002 en 空格记半字
const WIDE_SPACE_CODES = Object.freeze([0x3000, 0x2003]);
const NARROW_SPACE_CODES = Object.freeze([0x00a0, 0x2002]);
const WIDE_SPACES = new Set(WIDE_SPACE_CODES.map((code) => String.fromCharCode(code)));
const NARROW_SPACES = new Set(NARROW_SPACE_CODES.map((code) => String.fromCharCode(code)));
const INDENT_SPACE_CLASS = ` \\t\\r\\n\\f${[...NARROW_SPACES, ...WIDE_SPACES].join('')}`;
const LEADING_SPACE_RE = new RegExp(`^[${INDENT_SPACE_CLASS}]+`);
const MIN_VISIBLE_SPACES = 2;

function indentFromStyleChain(styles) {
    const list = Array.isArray(styles) ? styles : [];
    const at = list.findIndex((style) => TEXT_INDENT_RE.test(String(style || '')));
    if (at < 0) return 0;
    const [, rawValue, rawUnit] = TEXT_INDENT_RE.exec(String(list[at]));
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) return 0;
    const unit = String(rawUnit || '').toLowerCase();
    let chars;
    if (unit === 'em') chars = value;
    else if (unit === 'rem') chars = (value * ROOT_FONT_PX) / textFontSize(list);
    else if (unit === 'px') chars = value / textFontSize(list);
    else return 0;
    const rounded = Math.round(chars);
    if (rounded < MIN_INDENT) return 0;
    return Math.min(MAX_INDENT, rounded);
}

// 字数以正文实际字号为单位：自叶子块起向上取最近一处 font-size（px）
function textFontSize(styles) {
    for (const style of styles) {
        const matched = FONT_SIZE_RE.exec(String(style || ''));
        const px = matched ? Number(matched[1]) : 0;
        if (px > 0) return px;
    }
    return DEFAULT_FONT_PX;
}

function leadingIndentRun(text) {
    const matched = LEADING_SPACE_RE.exec(String(text == null ? '' : text));
    if (!matched) return null;
    let wide = 0;
    let narrow = 0;
    for (const char of matched[0]) {
        if (WIDE_SPACES.has(char)) wide += 1;
        else if (NARROW_SPACES.has(char)) narrow += 1;
    }
    if (wide + narrow < MIN_VISIBLE_SPACES) return null;
    return { count: wide + Math.ceil(narrow / 2), length: matched[0].length };
}

module.exports = {
    indentFromStyleChain, leadingIndentRun,
    LEAF_BLOCK_SELECTOR, NESTED_BLOCK_TAGS, NESTED_BLOCK_SELECTOR, INDENT_SPACE_CLASS,
};
