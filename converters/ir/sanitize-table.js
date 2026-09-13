/**
 * IR 中原始 `<table>` HTML 的降级与清洗
 *
 * MinerU 的 full.md 把表格原样写成 HTML 片段，remark 解析后落在 mdast 的 `html` 节点里（value 为原始
 * 标签文本）。这类节点若直接进入下游：Markdown 会把它整段照抄（含可能的 script / on* 事件），
 * DOCX/PDF 渲染器则完全看不见表格内容。本模块在 IR 建好后统一处理：
 *
 *   规则表（无 colspan/rowspan，且各行单元格数一致）→ 转成标准 mdast table 节点，
 *                                                    所有渲染器都能原生输出，单元格内取纯文本；
 *   含合并单元格或结构不规则的表          → 保留 HTML，但按白名单重建（仅 table/thead/tbody/tr/th/td
 *                                          六个标签、仅 colspan/rowspan 两个属性、文本一律转义），
 *                                          并挂 data.safeTable = true 供 HTML 渲染器原样透传。
 *
 * 契约：sanitizeTables(tree) → { tree, converted, kept }
 *   tree       新树（不修改入参）；无表格时原样返回同一引用
 *   converted  转成 mdast table 的表格数
 *   kept       保留为白名单 HTML 的表格数（按含表格的 html 节点计数）
 *
 * 安全取舍：清洗走「按白名单重建」而非「从原 DOM 删掉危险内容」—— 后者永远存在漏网的标签或属性，
 * 前者只可能漏掉无害内容。script / style 连同其文本一并丢弃，注释丢弃，其余非白名单标签降级为纯文本。
 */
const { load } = require('cheerio');
const { createTable, createTableRow, createTableCell, createText } = require('./schema');

/** 白名单标签：其余标签一律降级为其文本内容 */
const ALLOWED_TAGS = new Set(['table', 'thead', 'tbody', 'tr', 'th', 'td']);
/** 白名单属性：只保留合并单元格所需的两个 */
const ALLOWED_ATTRS = Object.freeze(['colspan', 'rowspan']);
/** 内容连同标签一起丢弃的元素 */
const DROPPED_TAGS = new Set(['script', 'style']);
/** 合并跨度的合法取值：1–999 的整数，1 视为未合并 */
const SPAN_RE = /^\d{1,3}$/;
/** html 节点里是否可能有表格；粗筛，避免为每个 html 节点都起一次解析器 */
const HAS_TABLE_RE = /<table[\s>]/i;
const ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' });
const ESCAPE_RE = /[&<>"]/g;

/**
 * @param {object} tree mdast 根节点
 * @returns {{ tree: object, converted: number, kept: number }}
 */
function sanitizeTables(tree) {
    const stats = { converted: 0, kept: 0 };
    const next = mapNode(tree, stats);
    return { tree: next, converted: stats.converted, kept: stats.kept };
}

// 深度优先重建：只有命中表格的 html 节点会被替换，其余节点在无子节点变化时返回原引用
function mapNode(node, stats) {
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'html' && typeof node.value === 'string' && HAS_TABLE_RE.test(node.value)) {
        return transformHtml(node, stats);
    }
    if (!Array.isArray(node.children)) return node;
    const children = node.children.map((child) => mapNode(child, stats));
    return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
}

function transformHtml(node, stats) {
    const $ = load(node.value, null, false);
    const roots = $.root()[0].children || [];
    const tables = $('table').toArray();
    if (tables.length === 0) return node;

    // 片段里只有一张表且没有别的内容时才可能整体换成 mdast table，否则换掉就会丢正文
    if (tables.length === 1 && roots.length === 1 && roots[0] === tables[0]) {
        const table = toMdastTable(tables[0]);
        if (table) {
            stats.converted += 1;
            return table;
        }
    }
    stats.kept += 1;
    return {
        ...node,
        value: serializeNodes(roots),
        data: { ...(node.data && typeof node.data === 'object' ? node.data : {}), safeTable: true },
    };
}

// ============================================================
// 规则表 → mdast table
// ============================================================

/** 返回 mdast table 节点；含合并单元格、无数据行或各行列数不一致时返回 null */
function toMdastTable(tableEl) {
    const rows = [];
    for (const tr of findTags(tableEl, 'tr')) {
        const cells = (tr.children || []).filter((child) => isTag(child) && (child.name === 'th' || child.name === 'td'));
        if (cells.some(isMerged)) return null;
        rows.push(cells.map((cell) => textOf(cell)));
    }
    if (rows.length === 0 || rows[0].length === 0) return null;
    if (rows.some((row) => row.length !== rows[0].length)) return null;
    return createTable(null, rows.map((row) => createTableRow(row.map((cell) => createTableCell(cell ? [createText(cell)] : [])))));
}

function isMerged(cell) {
    return ALLOWED_ATTRS.some((name) => {
        const raw = cell.attribs && cell.attribs[name];
        return typeof raw === 'string' && SPAN_RE.test(raw.trim()) && Number(raw.trim()) > 1;
    });
}

/** 单元格纯文本：丢弃 script/style，<br> 视作空格，连续空白折叠为一个空格 */
function textOf(node) {
    return collectText(node).replace(/\s+/g, ' ').trim();
}

function collectText(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text') return String(node.data == null ? '' : node.data);
    if (!isTag(node)) return '';
    if (DROPPED_TAGS.has(node.name)) return '';
    if (node.name === 'br') return ' ';
    return (node.children || []).map(collectText).join('');
}

// ============================================================
// 白名单重建
// ============================================================

function serializeNodes(nodes) {
    return (nodes || []).map(serializeNode).join('');
}

function serializeNode(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text') return escapeText(String(node.data == null ? '' : node.data));
    if (!isTag(node)) return '';
    if (DROPPED_TAGS.has(node.name)) return '';
    if (node.name === 'br') return ' ';
    // 非白名单标签降级为其内容：既不丢正文，也不可能把 href / on* 一类属性带出来
    if (!ALLOWED_TAGS.has(node.name)) return serializeNodes(node.children);
    return `<${node.name}${serializeAttrs(node.attribs)}>${serializeNodes(node.children)}</${node.name}>`;
}

function serializeAttrs(attribs) {
    const parts = [];
    for (const name of ALLOWED_ATTRS) {
        const raw = attribs && attribs[name];
        if (typeof raw !== 'string') continue;
        const value = raw.trim();
        if (SPAN_RE.test(value) && Number(value) > 1) parts.push(` ${name}="${value}"`);
    }
    return parts.join('');
}

// 换行一并压成空格：html 节点的 value 里出现空行会把这段原始 HTML 从中截断
const escapeText = (text) => text.replace(ESCAPE_RE, (ch) => ESCAPES[ch]).replace(/\s+/g, ' ');

// ============================================================
// DOM 小工具（domhandler 节点，不依赖 cheerio 选择器）
// ============================================================

const isTag = (node) => Boolean(node) && (node.type === 'tag' || node.type === 'script' || node.type === 'style') && typeof node.name === 'string';

/**
 * 深度优先收集指定标签名的后代（不含自身）；不进入嵌套的 table，
 * 否则内层表格的 tr 会被算成外层表格的行。
 */
function findTags(node, name, out = []) {
    for (const child of (node && node.children) || []) {
        if (isTag(child) && child.name === name) out.push(child);
        if (isTag(child) && child.name === 'table') continue;
        if (child && child.children) findTags(child, name, out);
    }
    return out;
}

module.exports = { sanitizeTables };
