/**
 * 私用区码点标记：解析器在 HTML / OOXML 阶段携带版面信息的载体
 *
 * 背景：解析器在 HTML / OOXML 阶段拿得到首行缩进、图注、换行与制表符，却无法直接给 mdast 节点挂属性；
 * 于是先把这些信息写成私用区码点混入文本，经 turndown 与 remark-parse 原样带进 mdast，再由
 * restoreMarkers 还原为节点属性，残留一律清除。码点取 U+EF00–U+EF1F 一小段，与专利 XML 的官方
 * 标记码位（U+E200–U+E20F，见 renderers/xml/sections.js）不相交：
 *   INDENT    段首缩进；其后紧跟一个计数码点（COUNT_BASE + n），n 为段首全角字数（1–15）
 *   CAPTION   段首 → paragraph.data.role = 'caption'（图注）
 *   FOOTNOTE  段首 → paragraph.data.role = 'image_footnote'（图片脚注，如「来源：…」）
 *   TABLE_CAPTION 段首 → paragraph.data.role = 'table_caption'（表题，HTML 的 <caption>；与其后紧邻的表格对应）
 *   BR        网页 <br>：url 解析器在 remark 之前经 collapseBreakMarkers 折叠，进入 IR 的残留删除
 *   TAB       制表符 → '\t'（mammoth 与 turndown 会把真正的 \t 折叠成空格，故先以标记代替）
 *
 * 契约：
 *   MARKERS                 标记字符表（冻结）
 *   indentMarker(n)         INDENT + 计数码点；n 取整并钳制到 1–15，非正数返回空串
 *   stripMarkers(text)      删除字符串中的全部标记码点（TAB 一并删除）；字数统计等场景用
 *   hasMarkers(text)        字符串中是否含任何标记码点
 *   restoreMarkers(ir)      返回新树：段首 INDENT / CAPTION / FOOTNOTE / TABLE_CAPTION → data.indent / data.role，
 *                           TAB → '\t'，其余位置的标记删除，删空的文本节点移除，只剩空白的段落移除；不改动入参
 *   stripMarkersTree(ir)    渲染器入口的兜底清理：删除残留标记（TAB → '\t'），无残留时原样返回同一引用
 *   applyTextLayout(ir)     文本类渲染器（md / html）用：data.indent → 段首 n 个 U+3000，
 *                           非代码文本里的 '\t' → 两个 U+3000；不改动入参
 */

// 不可见字符一律以码点声明、运行时生成（与 web/normalize 同一约定），源码里不出现看不见的字面量
const fromCode = (code) => String.fromCharCode(code);
const MARKER_FIRST = 0xEF00;
const MARKER_LAST = 0xEF1F;
const MARKERS = Object.freeze({
    INDENT: fromCode(0xEF00),
    CAPTION: fromCode(0xEF01),
    FOOTNOTE: fromCode(0xEF02),
    BR: fromCode(0xEF03),
    TAB: fromCode(0xEF04),
    TABLE_CAPTION: fromCode(0xEF05),
});
const COUNT_BASE = 0xEF10;
const MAX_INDENT = 15;
// INDENT 后缺计数码点时按两字缩进处理（中文正文的惯例）
const DEFAULT_INDENT = 2;
const MARKER_CLASS = `[${fromCode(MARKER_FIRST)}-${fromCode(MARKER_LAST)}]`;
const ANY_MARKER_RE = new RegExp(MARKER_CLASS, 'g');
const HAS_MARKER_RE = new RegExp(MARKER_CLASS);
const IDEOGRAPHIC_SPACE = fromCode(0x3000);
const TAB_AS_SPACES = IDEOGRAPHIC_SPACE.repeat(2);

const ROLE_BY_MARKER = Object.freeze({
    [MARKERS.CAPTION]: 'caption',
    [MARKERS.FOOTNOTE]: 'image_footnote',
    [MARKERS.TABLE_CAPTION]: 'table_caption',
});
// 段首标记可能落在这些行内容器的首个文本里（如整段加粗时的 <strong>INDENT…</strong>）
const INLINE_CONTAINERS = new Set(['strong', 'emphasis', 'delete', 'underline', 'link', 'linkReference']);
// 值为字符串、需要清理的节点字段
const VALUE_TYPES = new Set(['text', 'inlineCode', 'code', 'html']);
const CODE_TYPES = new Set(['inlineCode', 'code']);

function indentMarker(n) {
    const count = Math.min(MAX_INDENT, Math.round(Number(n)));
    if (!Number.isFinite(count) || count < 1) return '';
    return MARKERS.INDENT + String.fromCharCode(COUNT_BASE + count);
}

function stripMarkers(text) {
    return String(text == null ? '' : text).replace(ANY_MARKER_RE, '');
}

function hasMarkers(text) {
    return HAS_MARKER_RE.test(String(text == null ? '' : text));
}

// TAB 还原为 '\t'，其余标记删除
function cleanValue(value) {
    const text = String(value == null ? '' : value);
    if (!HAS_MARKER_RE.test(text)) return text;
    return text.split(MARKERS.TAB).join('\t').replace(ANY_MARKER_RE, '');
}

// ============================================================
// restoreMarkers
// ============================================================

function restoreMarkers(ir) {
    return restoreNode(ir);
}

function restoreNode(node) {
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'paragraph') return restoreParagraph(node);
    return cleanNode(node, restoreChildren);
}

function restoreChildren(children) {
    return children.map(restoreNode).filter((child) => !isEmptyParagraph(child));
}

function restoreParagraph(node) {
    const info = { indent: 0, role: null };
    const taken = takeLeading(Array.isArray(node.children) ? node.children : [], info);
    const hadMarkers = taken.changed || treeHasMarkers(node);
    const cleaned = cleanNode({ ...node, children: taken.children }, restoreChildren);
    if (hadMarkers && isBlankInline(cleaned.children)) return { ...cleaned, children: [] };
    if (!info.indent && !info.role) return cleaned;
    const data = { ...(cleaned.data || {}) };
    if (info.indent) data.indent = info.indent;
    if (info.role && !data.role) data.role = info.role;
    return { ...cleaned, data };
}

/**
 * 从子节点序列的开头取走段首标记，写入 info；首个节点是行内容器时深入其首个子节点。
 * 返回 { children, changed }：未取到任何标记时 children 为入参原引用。
 */
function takeLeading(children, info) {
    if (children.length === 0) return { children, changed: false };
    const [first, ...rest] = children;
    if (first && first.type === 'text') {
        const parsed = parseLead(String(first.value == null ? '' : first.value), info);
        if (!parsed.changed) return { children, changed: false };
        if (parsed.rest) return { children: [{ ...first, value: parsed.rest }, ...rest], changed: true };
        return { children: takeLeading(rest, info).children, changed: true };
    }
    if (first && INLINE_CONTAINERS.has(first.type) && Array.isArray(first.children)) {
        const inner = takeLeading(first.children, info);
        if (!inner.changed) return { children, changed: false };
        if (inner.children.length > 0) return { children: [{ ...first, children: inner.children }, ...rest], changed: true };
        return { children: takeLeading(rest, info).children, changed: true };
    }
    return { children, changed: false };
}

function parseLead(value, info) {
    let index = 0;
    while (index < value.length) {
        const char = value[index];
        if (char === MARKERS.INDENT) {
            const code = value.charCodeAt(index + 1);
            const counted = code > COUNT_BASE && code <= COUNT_BASE + MAX_INDENT;
            if (!info.indent) info.indent = counted ? code - COUNT_BASE : DEFAULT_INDENT;
            index += counted ? 2 : 1;
        } else if (ROLE_BY_MARKER[char]) {
            if (!info.role) info.role = ROLE_BY_MARKER[char];
            index += 1;
        } else if (char === MARKERS.BR) {
            index += 1;
        } else {
            break;
        }
    }
    return { changed: index > 0, rest: value.slice(index) };
}

// 节点自身的字符串字段清理 + 子节点递归；无改动时返回原引用
function cleanNode(node, mapChildren) {
    let next = node;
    if (VALUE_TYPES.has(node.type) && typeof node.value === 'string' && HAS_MARKER_RE.test(node.value)) {
        next = { ...next, value: cleanValue(node.value) };
    }
    if (node.type === 'image') {
        const alt = typeof node.alt === 'string' && HAS_MARKER_RE.test(node.alt) ? stripMarkers(node.alt) : node.alt;
        const title = typeof node.title === 'string' && HAS_MARKER_RE.test(node.title) ? stripMarkers(node.title) : node.title;
        if (alt !== node.alt || title !== node.title) next = { ...next, alt, title };
    }
    if (Array.isArray(node.children)) {
        const children = mapChildren(node.children).filter((child) => !(child && child.type === 'text' && child.value === ''));
        if (children.length !== node.children.length || children.some((child, i) => child !== node.children[i])) {
            next = { ...next, children };
        }
    }
    return next;
}

function treeHasMarkers(node) {
    if (!node || typeof node !== 'object') return false;
    if (typeof node.value === 'string' && HAS_MARKER_RE.test(node.value)) return true;
    return Array.isArray(node.children) && node.children.some(treeHasMarkers);
}

// 只剩空白文本（含 \t 与全角空格）与换行的行内序列
function isBlankInline(children) {
    return children.every((child) => (child.type === 'text' && !String(child.value || '').trim()) || child.type === 'break');
}

const isEmptyParagraph = (node) => node && node.type === 'paragraph' && Array.isArray(node.children) && node.children.length === 0;

// ============================================================
// stripMarkersTree（渲染器入口兜底）
// ============================================================

function stripMarkersTree(ir) {
    if (!treeHasMarkersDeep(ir)) return ir;
    return stripNode(ir);
}

function stripNode(node) {
    if (!node || typeof node !== 'object') return node;
    return cleanNode(node, (children) => children.map(stripNode));
}

function treeHasMarkersDeep(node) {
    if (!node || typeof node !== 'object') return false;
    if (typeof node.value === 'string' && HAS_MARKER_RE.test(node.value)) return true;
    if (node.type === 'image' && [node.alt, node.title].some((v) => typeof v === 'string' && HAS_MARKER_RE.test(v))) return true;
    return Array.isArray(node.children) && node.children.some(treeHasMarkersDeep);
}

// ============================================================
// applyTextLayout（md / html 渲染器）
// ============================================================

function applyTextLayout(node, inCode = false) {
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'text' && !inCode && typeof node.value === 'string' && node.value.includes('\t')) {
        return { ...node, value: node.value.replace(/\t/g, TAB_AS_SPACES) };
    }
    if (!Array.isArray(node.children)) return node;
    const code = inCode || CODE_TYPES.has(node.type);
    let children = node.children.map((child) => applyTextLayout(child, code));
    if (node.type === 'paragraph') children = indentChildren(children, node.data && node.data.indent);
    const changed = children.length !== node.children.length || children.some((child, i) => child !== node.children[i]);
    return changed ? { ...node, children } : node;
}

// 段首插入 n 个全角空格；段落里没有可见文字（纯图片段）时不插
function indentChildren(children, indent) {
    const count = Math.min(MAX_INDENT, Math.round(Number(indent)));
    if (!Number.isFinite(count) || count < 1 || !hasVisibleText(children)) return children;
    const prefix = IDEOGRAPHIC_SPACE.repeat(count);
    const [first, ...rest] = children;
    if (first && first.type === 'text') return [{ ...first, value: prefix + String(first.value || '').replace(/^[ \t]+/, '') }, ...rest];
    return [{ type: 'text', value: prefix }, ...children];
}

function hasVisibleText(nodes) {
    return nodes.some((node) => {
        if (!node || typeof node !== 'object') return false;
        if (node.type === 'text' || node.type === 'inlineCode') return /\S/.test(String(node.value || ''));
        return Array.isArray(node.children) && hasVisibleText(node.children);
    });
}

module.exports = {
    MARKERS, COUNT_BASE, MAX_INDENT,
    indentMarker, stripMarkers, hasMarkers, restoreMarkers, stripMarkersTree, applyTextLayout,
};
