/**
 * IR → MinerU 同构的 content_list（bundle 产物 {name}_content_list.json）
 *
 * 按阅读顺序输出块，字段与 MinerU 结果包的 *_content_list.json 对齐：
 *   heading          → { type: 'text', text, text_level }
 *   paragraph        → { type: 'text', text }
 *                      role 为 table_caption 的段落并入其后紧邻的 table 块，其后紧邻的不是表格时按普通文本块输出
 *   image            → { type: 'image', img_path, image_caption: [], image_footnote: [], content: '', display? }
 *                      role 为 caption / image_footnote 的段落并入前一个 image 块，不单独成块
 *   table            → { type: 'table', img_path: '', table_caption: [], table_footnote: [], table_body: '<table>…' }
 *                      table_caption 收其前紧邻的表题段落（按序，可多条）；来源为 table 节点与带 data.safeTable 的 html 节点
 *   块级公式          → { type: 'equation', text: '$$…$$', text_format: 'latex' }
 *   list             → { type: 'list', sub_type: 'text', list_items }（嵌套列表的条目按序拍平；条目里的图片紧随其后各成 image 块）
 *   code             → { type: 'code', sub_type: 'code', code_body, code_caption: [] }
 *   blockquote       → 展开为其中的块
 * 每块末尾带 page_idx：pptx 为幻灯片序号、xlsx 为工作表序号，其余为 0。非 PDF 来源没有版面坐标，不输出 bbox。
 * img_path 直接取节点 url——调用方负责让 url 为产物内的真实相对路径（converters/index.js 的 bundle 渲染即如此）。
 * 契约：render(doc) → string（4 空格缩进的 JSON，与 MinerU 结果包一致）。不改动入参。
 */
const { stripHtml } = require('../ir/util');
const { mathToText } = require('../ir/schema');
const { stripMarkersTree } = require('../ir/markers');

const JSON_INDENT = 4;
const CAPTION_FIELDS = Object.freeze({ caption: 'image_caption', image_footnote: 'image_footnote' });
const TABLE_CAPTION_ROLE = 'table_caption';

async function render(doc) {
    if (!doc || typeof doc !== 'object') throw new Error('renderers/content-list 需要 MarkFlowDocument 对象');
    return JSON.stringify(buildContentList(doc), null, JSON_INDENT);
}

function buildContentList(doc) {
    const ir = stripMarkersTree(doc.ir);
    const ctx = { page: 0, blocks: [] };
    walkBlocks(ir && Array.isArray(ir.children) ? ir.children : [], ctx);
    return ctx.blocks;
}

/**
 * 同一兄弟序列内按阅读顺序出块。表题段落须等到下一个兄弟才能定去向，故先暂存：
 * 下一个兄弟是表格就并入其 table_caption，否则回落为普通文本块（序列走完亦然）。
 */
function walkBlocks(nodes, ctx) {
    let captions = [];
    const flush = () => {
        for (const text of captions) push(ctx, { type: 'text', text });
        captions = [];
    };
    for (const node of nodes) {
        const caption = tableCaptionText(node);
        if (caption !== null) {
            if (caption) captions.push(caption);
            continue;
        }
        if (captions.length > 0 && isTableNode(node)) {
            emitBlock(node, ctx);
            // 表格块恒为 emitBlock 刚推入的最后一块；逐个推入而不展开实参，表题多达十余万个时不致超出调用栈
            const tableCaption = ctx.blocks[ctx.blocks.length - 1].table_caption;
            for (const caption of captions) tableCaption.push(caption);
            captions = [];
            continue;
        }
        flush();
        emitBlock(node, ctx);
    }
    flush();
}

// 表题段落的文字（可能为空串）；非表题段落返回 null
function tableCaptionText(node) {
    if (!node || node.type !== 'paragraph') return null;
    if (!node.data || node.data.role !== TABLE_CAPTION_ROLE) return null;
    return inlineText(node.children).trim();
}

// 出 table 块的两种节点：table 节点与带 data.safeTable 的 html 片段（二者都经 tableBlock 产出）
function isTableNode(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'table') return true;
    return node.type === 'html' && Boolean(node.data) && node.data.safeTable === true;
}

const push = (ctx, block) => ctx.blocks.push({ ...block, page_idx: ctx.page });

function emitBlock(node, ctx) {
    if (!node || typeof node !== 'object') return;
    switch (node.type) {
        case 'slideBreak':
        case 'sheetSection':
            emitSection(node, ctx);
            return;
        case 'heading': {
            const text = inlineText(node.children).trim();
            if (text) push(ctx, { type: 'text', text, text_level: node.depth || 1 });
            return;
        }
        case 'paragraph':
            emitParagraph(node, ctx);
            return;
        case 'image':
            push(ctx, imageBlock(node));
            return;
        case 'table':
            push(ctx, tableBlock(tableHtml(node)));
            return;
        case 'html':
            emitHtml(node, ctx);
            return;
        case 'math':
            push(ctx, equationBlock(node));
            return;
        case 'list':
            push(ctx, { type: 'list', sub_type: 'text', list_items: listItems(node) });
            // list_items 只收文字；条目里的图片紧随列表块各自成 image 块，保证 content_list 覆盖全部图片
            for (const image of collectImages(node)) push(ctx, imageBlock(image));
            return;
        case 'code':
            push(ctx, { type: 'code', sub_type: 'code', code_body: String(node.value == null ? '' : node.value), code_caption: [] });
            return;
        case 'thematicBreak':
            return;
        default:
            emitFallback(node, ctx);
    }
}

// 幻灯片 / 工作表：切换 page_idx，标题作为一条带层级的文本
function emitSection(node, ctx) {
    const data = node.data || {};
    if (Number.isInteger(data.index) && data.index >= 0) ctx.page = data.index;
    const title = String((node.type === 'slideBreak' ? data.title : data.name) || '').trim();
    if (title) push(ctx, { type: 'text', text: title, text_level: node.type === 'slideBreak' ? 2 : 1 });
}

function emitParagraph(node, ctx) {
    const role = node.data && node.data.role;
    const field = CAPTION_FIELDS[role];
    const last = ctx.blocks[ctx.blocks.length - 1];
    if (field && last && last.type === 'image') {
        const text = inlineText(node.children).trim();
        if (text) last[field].push(text);
        return;
    }
    // 段内的图片与块级公式各自成块，其余行内内容按原顺序聚成文本块
    let run = [];
    const flush = () => {
        const text = inlineText(run).trim();
        if (text) push(ctx, { type: 'text', text });
        run = [];
    };
    for (const child of node.children || []) {
        if (child && child.type === 'image') {
            flush();
            push(ctx, imageBlock(child));
        } else if (child && child.type === 'math' && child.data && child.data.display) {
            flush();
            push(ctx, equationBlock(child));
        } else {
            run.push(child);
        }
    }
    flush();
}

function emitHtml(node, ctx) {
    const raw = typeof node.value === 'string' ? node.value.trim() : '';
    if (node.data && node.data.safeTable === true) {
        push(ctx, tableBlock(raw));
        return;
    }
    const text = stripHtml(raw);
    if (text) push(ctx, { type: 'text', text });
}

function emitFallback(node, ctx) {
    if (node.type === 'blockquote' || node.type === 'footnoteDefinition' || node.type === 'root') {
        walkBlocks(node.children || [], ctx);
        return;
    }
    const text = Array.isArray(node.children) ? inlineText(node.children).trim() : String(node.value == null ? '' : node.value).trim();
    if (text) push(ctx, { type: 'text', text });
}

// ============================================================
// 块构造
// ============================================================

function imageBlock(node) {
    const block = { type: 'image', img_path: typeof node.url === 'string' ? node.url : '', image_caption: [], image_footnote: [], content: '' };
    const display = node.data && node.data.display;
    if (display && Number.isFinite(display.width)) block.display = { ...display };
    return block;
}

const tableBlock = (body) => ({ type: 'table', img_path: '', table_caption: [], table_footnote: [], table_body: body });

const equationBlock = (node) => ({ type: 'equation', text: `$$${mathToText(node)}$$`, text_format: 'latex' });

function tableHtml(node) {
    const rows = (node.children || []).filter((row) => row && row.type === 'tableRow');
    const body = rows.map((row) => `<tr>${(row.children || []).map((cell) => `<td>${escapeHtml(inlineText(cell.children).trim())}</td>`).join('')}</tr>`);
    return `<table>${body.join('')}</table>`;
}

function collectImages(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (node.type === 'image') out.push(node);
    if (Array.isArray(node.children)) for (const child of node.children) collectImages(child, out);
    return out;
}

function listItems(list) {
    const items = [];
    for (const item of list.children || []) {
        if (!item || typeof item !== 'object') continue;
        const own = (item.children || []).filter((child) => child && child.type !== 'list');
        const text = own.map((child) => (Array.isArray(child.children) ? inlineText(child.children) : String(child.value || ''))).join('\n').trim();
        if (text) items.push(text);
        for (const nested of (item.children || []).filter((child) => child && child.type === 'list')) items.push(...listItems(nested));
    }
    return items;
}

// ============================================================
// 行内纯文本
// ============================================================

function inlineText(nodes) {
    return (Array.isArray(nodes) ? nodes : []).map(inlineNodeText).join('');
}

function inlineNodeText(node) {
    if (!node || typeof node !== 'object') return '';
    switch (node.type) {
        case 'text':
        case 'inlineCode':
            return String(node.value == null ? '' : node.value);
        case 'break':
            return '\n';
        case 'math':
            return `$${mathToText(node)}$`;
        case 'html':
            return stripHtml(node.value);
        case 'image':
            return '';
        case 'footnoteReference':
            return `[^${node.label || node.identifier || ''}]`;
        default:
            return Array.isArray(node.children) ? inlineText(node.children) : '';
    }
}

function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { render, buildContentList };
