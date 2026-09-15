/**
 * IR → Markdown
 *
 * 用 remark-stringify + remark-gfm 链支持 GFM 表格/删除线等扩展；
 * 扩展节点（slideBreak/sheetSection）先降级为 H1/H2/thematicBreak；
 * math 节点转为线性化文本并套 TeX 定界符（块级 $$…$$ 独立成段，行内 $…$），
 * 不引入 remark-math，故定界符只是文本约定，往返解析时按普通文本处理。
 * 带 data.safeTable 的 html 节点与其它 html 节点一样按原样输出（remark-stringify 直出 value）。
 *
 * 版面与格式（与 ir/markers、ir/inline-html 配套）：
 *   - 残留私用区标记兜底剥除；paragraph.data.indent → 段首 n 个 U+3000；非代码文本中的 \t → 两个 U+3000
 *   - 带 data.display 的图片输出 <img src="…" width="W" alt="…">（只写宽度，属性值转义）；无 display 仍为 ![]()
 *   - underline → <u>…</u>
 *   - strong / emphasis / delete：定界符两侧按 CommonMark flanking 规则（标点含 \p{P}\p{S}）判定安全时写
 *     ** / * / ~~，否则回退 <strong> / <em> / <del>——中文标点旁的字面星号会被转义成 \*\*，默认处理器
 *     还会把相邻汉字写成 &#x…; 字符引用
 */
const { loadUnified } = require('../ir/unified-loader');
const { downgradeCustomNodes, mathToText } = require('../ir/schema');
const { stripMarkersTree, applyTextLayout } = require('../ir/markers');

// 与 legacy turndown 配置对齐：bullet '-'、rule '---'、emphasis '*'、strong '**'、fences、atx
const MD_OPTIONS = {
    bullet: '-',
    rule: '-',
    emphasis: '*',
    strong: '*',
    fences: true,
    setext: false,
    listItemIndent: 'one',
};

const PUNCTUATION_RE = /[\p{P}\p{S}]/u;
const WHITESPACE_RE = /[\s\p{Zs}]/u;
const PX_RE = /^\d{1,5}$/;
const MAX_PERCENT = 100;

async function render(doc) {
    const { unified, remarkStringify, remarkGfm } = await loadUnified();
    const prepared = displayImagesToHtml(applyTextLayout(stripMarkersTree(doc.ir)));
    const downgraded = downgradeCustomNodes(wrapMath(prepared));
    const result = unified()
        .use(remarkGfm)
        .use(remarkStringify, { ...MD_OPTIONS, handlers: HANDLERS })
        .stringify(downgraded);
    return String(result);
}

/** math → 文本：display 为真时独立成段并用 $$…$$ 包裹，否则行内 $…$。不修改入参，返回新树 */
function wrapMath(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(wrapMath);
    if (node.type === 'math') {
        const display = Boolean(node.data && node.data.display);
        const text = mathToText(node);
        const value = display ? `$$${text}$$` : `$${text}$`;
        return display ? { type: 'paragraph', children: [{ type: 'text', value }] } : { type: 'text', value };
    }
    if (Array.isArray(node.children)) return { ...node, children: node.children.map(wrapMath) };
    return node;
}

// ============================================================
// 图片：带显示尺寸的输出为 <img>
// ============================================================

function displayImagesToHtml(node) {
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'image') {
        const width = displayWidth(node);
        if (!width || !node.url) return node;
        const alt = typeof node.alt === 'string' ? node.alt : '';
        return { type: 'html', value: `<img src="${escapeAttr(node.url)}" width="${width}" alt="${escapeAttr(alt)}">` };
    }
    if (!Array.isArray(node.children)) return node;
    const children = node.children.map(displayImagesToHtml);
    return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
}

// 校验后的 width 属性值：px 为 1–99999 的整数，百分比为 (0, 100]；不合规返回空串
function displayWidth(node) {
    const display = node.data && node.data.display;
    if (!display || !Number.isFinite(display.width) || display.width <= 0) return '';
    if (display.unit === '%') return display.width <= MAX_PERCENT ? `${display.width}%` : '';
    const px = String(Math.round(display.width));
    return PX_RE.test(px) ? px : '';
}

function escapeAttr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================
// 行内格式处理器
// ============================================================

/**
 * 定界符式格式（** / * / ~~）：两侧 flanking 安全时写定界符，否则写 HTML 标签。
 * 安全条件：内容首尾不是空白、不是定界符字符；首字是标点时前一字须为空白或标点（或行首），
 * 尾字是标点时后一字须为空白或标点（或行尾）。
 */
function attention(marker, tag, construct) {
    const handler = (node, _parent, state, info) => {
        const exit = state.enter(construct);
        const inner = state.containerPhrasing(node, { ...info, before: marker[0], after: marker[0] });
        exit();
        if (!inner) return '';
        return isDelimiterSafe(info.before, inner, info.after, marker[0])
            ? `${marker}${inner}${marker}`
            : `<${tag}>${inner}</${tag}>`;
    };
    handler.peek = () => marker[0];
    return handler;
}

function isDelimiterSafe(before, inner, after, markerChar) {
    const chars = Array.from(inner);
    const first = chars[0];
    const last = chars[chars.length - 1];
    if (!first || !last || first === markerChar || last === markerChar) return false;
    if (isWhitespace(first) || isWhitespace(last)) return false;
    const prev = Array.from(String(before || '')).pop() || '';
    const next = Array.from(String(after || ''))[0] || '';
    if (isPunctuation(first) && prev && !isWhitespace(prev) && !isPunctuation(prev)) return false;
    if (isPunctuation(last) && next && !isWhitespace(next) && !isPunctuation(next)) return false;
    return true;
}

const isWhitespace = (char) => WHITESPACE_RE.test(char);
const isPunctuation = (char) => PUNCTUATION_RE.test(char);

function underline(node, _parent, state, info) {
    const inner = state.containerPhrasing(node, { ...info, before: '>', after: '<' });
    return inner ? `<u>${inner}</u>` : '';
}
underline.peek = () => '<';

const HANDLERS = Object.freeze({
    strong: attention('**', 'strong', 'strong'),
    emphasis: attention('*', 'em', 'emphasis'),
    delete: attention('~~', 'del', 'strikethrough'),
    underline,
});

module.exports = { render, isDelimiterSafe };
