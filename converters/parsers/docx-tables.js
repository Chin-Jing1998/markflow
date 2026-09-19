/**
 * docx 表格结构采集：mammoth 的 <table> → 结构化 grid，挂到 mdast 表格节点的 data.grid 上
 *
 * 背景：mammoth 输出的表格 HTML 完整带着合并单元格（colspan / rowspan）、单元格内多段（多个 <p>）
 * 与行内格式（<strong> / <em> / <u> / <sup> / <sub>），但 ir/turndown 把表格转成 GFM 时只取单元格的
 * textContent，这三样在那一步全部丢失。GFM 语法本身表达不了合并单元格，无法就地补救，故在交给
 * turndown 之前先把每个顶层表格另存成一份结构化数据，再在 mdast 建好后按标记对回表格节点。
 *
 * 配对不靠出现顺序：turndown 可能丢弃或改写个别表格，顺序配对必然错位。做法与 docx-layout 的图片序号
 * 标记同理——注入前给每个顶层表格（不在其它表格之内者）的首个单元格开头写一个文本标记，该标记随
 * textContent 进入 GFM 单元格、再随 remark 进入 mdast，回收时据此取号。
 *
 * 安全：document.xml 与 mammoth 产出的 HTML 均属不可信内容。grid 里只存文本与节点类型，不存任何 HTML
 * 字符串；片段页（raster/fragment.js）据此重建 HTML 并逐字转义，源文档的标记进不了片段页。
 *
 * 契约：
 *   collectTableGrids(html) → { html, grids, warnings }
 *     html    注入了表格标记的 HTML；无顶层表格时原样返回入参
 *     grids   Map<序号, grid>，序号按顶层表格出现顺序 1 起；无单元格的表格（turndown 会整体丢弃）不登记
 *     grid    { rows: [ { header, cells: [ { colspan, rowspan, header, paragraphs } ] } ] }
 *             paragraphs 为 [[行内节点…], …]，行内节点只用 text / strong / emphasis / delete / underline /
 *             superscript / subscript / break / inlineCode 八类（raster/fragment.js 的 nodeHtml 认得的类型）
 *   restoreTableGrids(ir, grids) → { ir, warnings }
 *     mdast 中首个单元格以标记开头的 table 节点：剥掉标记并挂上 data.grid；随后对整棵树做兜底清理，
 *     任何位置的残留标记一律删除（删空的文本节点移除），确保标记不会流进 md / html / docx / xml 产物。
 *     不改动入参；无标记可剥且无残留时原样返回同一引用
 *
 * 本期不做：对齐与列宽（mammoth 忽略 w:jc 与 w:tblGrid，取不到）；单元格内的图片以替换文字占位；
 * 嵌套表格按纯文本展开。后两项各记一条 warning。
 */
const cheerio = require('cheerio');

// 标记字符以码点生成（与 docx-layout 的图片序号标记同一写法），源码里不出现不可见或私用区的字面字符。
// U+27E6 / U+27E7 为可见的数学白方括号：万一残留也一眼可见，不会悄无声息地混进正文
const BRACKET_OPEN = String.fromCharCode(0x27E6);
const BRACKET_CLOSE = String.fromCharCode(0x27E7);
const MARKER_LABEL = 'MFT:';
const MARKER_SOURCE = `${BRACKET_OPEN}${MARKER_LABEL}(\\d{1,6})${BRACKET_CLOSE}`;
const ANY_MARKER_RE = new RegExp(MARKER_SOURCE, 'g');
const HAS_MARKER_RE = new RegExp(MARKER_SOURCE);
// remark 会先 trim 单元格文本，此处仍容忍前导空白
const LEADING_MARKER_RE = new RegExp(`^[ \\t]*${MARKER_SOURCE}`);
const tableMarker = (index) => `${BRACKET_OPEN}${MARKER_LABEL}${index}${BRACKET_CLOSE}`;

const TABLE_TAG_RE = /<table\b[^>]*>|<\/table\s*>/gi;
const FIRST_CELL_RE = /<(?:td|th)\b[^>]*>/i;
/** 合并跨度合法区间：Word 表格最多 63 列，行数亦远小于此上限；越界或非数字一律回落到 1 */
const MAX_CELL_SPAN = 512;
const SPAN_RE = /^\d{1,4}$/;
const DEFAULT_SPAN = 1;

const ROW_SECTION_TAGS = new Set(['thead', 'tbody', 'tfoot']);
const CELL_TAGS = new Set(['td', 'th']);
/** 单元格内另起一段的元素：mammoth 只产出 <p>，其余为兜底 */
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote']);
/** domhandler 给 script / style 另立节点类型，判元素时须一并认；这两类连内容一起丢弃 */
const ELEMENT_TYPES = new Set(['tag', 'script', 'style']);
const DROPPED_TAGS = new Set(['script', 'style']);
const TEXT_TYPE = 'text';
const isElement = (node) => Boolean(node) && ELEMENT_TYPES.has(node.type);
const isDropped = (node) => DROPPED_TAGS.has(node.name);
/** HTML 标签 → 行内节点类型；未列出的容器只留内容 */
const INLINE_TAG_TYPES = Object.freeze({
    strong: 'strong', b: 'strong',
    em: 'emphasis', i: 'emphasis',
    u: 'underline', ins: 'underline',
    del: 'delete', s: 'delete', strike: 'delete',
    sup: 'superscript', sub: 'subscript',
});
/** 单元格内的图片没有替换文字时的占位字 */
const IMAGE_PLACEHOLDER = '图';
const IMAGE_WARNING = '表格内的图片未进入表格图，已以替换文字占位';
const NESTED_TABLE_WARNING = '表格内的嵌套表格已按纯文本展开';
const RESIDUE_WARNING = '表格标记有残留，已清除';

// ============================================================
// collectTableGrids
// ============================================================

function collectTableGrids(html) {
    const source = String(html == null ? '' : html);
    const warnings = [];
    const blocks = findTopLevelTables(source);
    if (blocks.length === 0) return { html: source, grids: new Map(), warnings };

    const grids = new Map();
    const edits = [];
    blocks.forEach((block, order) => {
        const fragment = source.slice(block.start, block.end);
        const cellAt = FIRST_CELL_RE.exec(fragment);
        const grid = cellAt ? tableToGrid(fragment, warnings) : null;
        if (!grid) return;
        const index = order + 1;
        grids.set(index, grid);
        edits.push({ at: block.start + cellAt.index + cellAt[0].length, text: tableMarker(index) });
    });
    return { html: applyEdits(source, edits), grids, warnings };
}

/** 顶层 <table> 的字节区间（不在其它表格之内者）；标签不配对时该表格不计入 */
function findTopLevelTables(html) {
    const blocks = [];
    let depth = 0;
    let start = -1;
    TABLE_TAG_RE.lastIndex = 0;
    for (let matched = TABLE_TAG_RE.exec(html); matched; matched = TABLE_TAG_RE.exec(html)) {
        if (matched[0][1] === '/') {
            if (depth === 0) continue;
            depth -= 1;
            if (depth === 0) blocks.push({ start, end: matched.index + matched[0].length });
        } else {
            if (depth === 0) start = matched.index;
            depth += 1;
        }
    }
    return blocks;
}

/** 从后往前插入，前序偏移不受影响 */
function applyEdits(html, edits) {
    if (edits.length === 0) return html;
    return [...edits].sort((a, b) => b.at - a.at)
        .reduce((text, edit) => text.slice(0, edit.at) + edit.text + text.slice(edit.at), html);
}

// ============================================================
// HTML 表格 → grid
// ============================================================

function tableToGrid(fragment, warnings) {
    const table = cheerio.load(fragment, null, false)('table').first()[0];
    if (!table) return null;
    const rows = tableRows(table).map((row) => rowToData(row, warnings));
    return rows.length > 0 ? { rows } : null;
}

/** 直属本表格的 tr：thead / tbody / tfoot 只下潜一层，嵌套表格的行不算 */
function tableRows(table) {
    const rows = [];
    for (const child of elementChildren(table)) {
        if (child.name === 'tr') rows.push({ el: child, inHead: false });
        else if (ROW_SECTION_TAGS.has(child.name)) {
            const inHead = child.name === 'thead';
            elementChildren(child).forEach((inner) => {
                if (inner.name === 'tr') rows.push({ el: inner, inHead });
            });
        }
    }
    return rows;
}

const elementChildren = (el) => (Array.isArray(el && el.children) ? el.children.filter(isElement) : []);

/** 子树的纯文字：script / style 的内容不计入（cheerio 的 .text() 会把它们一并取回） */
function plainText(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === TEXT_TYPE) return String(node.data || '');
    if (!isElement(node) || isDropped(node)) return '';
    return (node.children || []).map(plainText).join('');
}

/** 表头行：位于 thead 内，或全部单元格都是 th */
function rowToData({ el, inHead }, warnings) {
    const cells = elementChildren(el).filter((child) => CELL_TAGS.has(child.name)).map((cell) => cellToData(cell, warnings));
    return { header: inHead || (cells.length > 0 && cells.every((cell) => cell.header)), cells };
}

function cellToData(el, warnings) {
    const attrs = el.attribs || {};
    return {
        colspan: readSpan(attrs.colspan),
        rowspan: readSpan(attrs.rowspan),
        header: el.name === 'th',
        paragraphs: cellParagraphs(el, warnings),
    };
}

function readSpan(value) {
    const text = String(value == null ? '' : value).trim();
    if (!SPAN_RE.test(text)) return DEFAULT_SPAN;
    const span = Number(text);
    return span >= DEFAULT_SPAN && span <= MAX_CELL_SPAN ? span : DEFAULT_SPAN;
}

/** 单元格 → 段落序列：每个块级元素一段，块外的行内内容并成隐式段；只剩空白的段丢弃 */
function cellParagraphs(el, warnings) {
    const paragraphs = [];
    let current = [];
    const flush = () => {
        if (current.length > 0) paragraphs.push(current);
        current = [];
    };
    const walk = (nodes) => {
        for (const node of nodes || []) {
            if (node.type === TEXT_TYPE) {
                // 段首只剩空白时不起段：浏览器渲染块级内容时同样会折掉这段前导空白
                if (current.length > 0 || /\S/.test(String(node.data || ''))) current.push(...inlineNodes(node, warnings));
                continue;
            }
            if (!isElement(node) || isDropped(node)) continue;
            if (node.name === 'table') {
                flush();
                paragraphs.push(...nestedTableParagraphs(node, warnings));
            } else if (BLOCK_TAGS.has(node.name)) {
                flush();
                walk(node.children);
                flush();
            } else {
                current.push(...inlineNodes(node, warnings));
            }
        }
    };
    walk(el.children);
    flush();
    return paragraphs;
}

/** 嵌套表格：本期按纯文本展开成一段 */
function nestedTableParagraphs(el, warnings) {
    warnings.push(NESTED_TABLE_WARNING);
    const text = plainText(el).replace(/\s+/g, ' ').trim();
    return text ? [[{ type: TEXT_TYPE, value: text }]] : [];
}

function inlineNodes(node, warnings) {
    if (node.type === TEXT_TYPE) {
        const value = String(node.data || '');
        return value === '' ? [] : [{ type: TEXT_TYPE, value }];
    }
    // 注释、文档类型等非元素节点与 script / style 一律连内容丢弃
    if (!isElement(node) || isDropped(node)) return [];
    if (node.name === 'br') return [{ type: 'break' }];
    if (node.name === 'img') return [imagePlaceholder(node, warnings)];
    if (node.name === 'code') {
        const value = plainText(node);
        return value ? [{ type: 'inlineCode', value }] : [];
    }
    const children = (node.children || []).flatMap((child) => inlineNodes(child, warnings));
    const type = INLINE_TAG_TYPES[node.name];
    if (!type) return children;
    return children.length > 0 ? [{ type, children }] : [];
}

function imagePlaceholder(node, warnings) {
    warnings.push(IMAGE_WARNING);
    const alt = String((node.attribs && node.attribs.alt) || '').trim();
    return { type: TEXT_TYPE, value: alt || IMAGE_PLACEHOLDER };
}

// ============================================================
// restoreTableGrids
// ============================================================

function restoreTableGrids(ir, grids) {
    const map = grids instanceof Map ? grids : new Map();
    const warnings = [];
    const attached = map.size > 0 ? attachNode(ir, map) : ir;
    const residue = { count: 0 };
    const cleaned = sweepNode(attached, residue);
    if (residue.count > 0) warnings.push(`${RESIDUE_WARNING}（${residue.count} 处）`);
    return { ir: cleaned, warnings };
}

function attachNode(node, grids) {
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'table') return withGrid(node, grids);
    if (!Array.isArray(node.children)) return node;
    const children = node.children.map((child) => attachNode(child, grids));
    return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
}

/** 首个单元格以标记开头时：剥掉标记并挂 data.grid；标记取不到号或号无对应 grid 时只剥不挂 */
function withGrid(node, grids) {
    const rows = Array.isArray(node.children) ? node.children : [];
    const firstRow = rows[0];
    const cells = firstRow && Array.isArray(firstRow.children) ? firstRow.children : [];
    const taken = takeLeadingMarker(cells[0]);
    if (!taken) return node;
    const nextRow = { ...firstRow, children: [taken.node, ...cells.slice(1)] };
    const next = { ...node, children: [nextRow, ...rows.slice(1)] };
    const grid = grids.get(taken.index);
    return grid ? { ...next, data: { ...(node.data || {}), grid } } : next;
}

/** 沿最左路径取走开头的标记；取不到返回 null。不改动入参 */
function takeLeadingMarker(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'text') {
        const matched = LEADING_MARKER_RE.exec(String(node.value == null ? '' : node.value));
        if (!matched) return null;
        const rest = String(node.value).slice(matched[0].length);
        return { index: Number(matched[1]), node: rest === '' ? null : { ...node, value: rest } };
    }
    if (!Array.isArray(node.children) || node.children.length === 0) return null;
    const inner = takeLeadingMarker(node.children[0]);
    if (!inner) return null;
    const rest = node.children.slice(1);
    return { index: inner.index, node: { ...node, children: inner.node ? [inner.node, ...rest] : rest } };
}

/** 兜底清理：任何位置的残留标记一律删除，删空的文本节点移除；无残留时返回同一引用 */
function sweepNode(node, residue) {
    if (!node || typeof node !== 'object') return node;
    let next = node;
    if (typeof node.value === 'string' && HAS_MARKER_RE.test(node.value)) {
        next = { ...next, value: stripTableMarkers(node.value, residue) };
    }
    for (const key of ['alt', 'title']) {
        if (typeof node[key] === 'string' && HAS_MARKER_RE.test(node[key])) {
            next = { ...next, [key]: stripTableMarkers(node[key], residue) };
        }
    }
    if (!Array.isArray(node.children)) return next;
    const children = node.children
        .map((child) => sweepNode(child, residue))
        .filter((child) => !(child && child.type === 'text' && child.value === ''));
    if (children.length !== node.children.length || children.some((child, i) => child !== node.children[i])) {
        next = { ...next, children };
    }
    return next;
}

function stripTableMarkers(value, residue) {
    return String(value).replace(ANY_MARKER_RE, () => {
        residue.count += 1;
        return '';
    });
}

module.exports = { collectTableGrids, restoreTableGrids, tableMarker, MAX_CELL_SPAN };
