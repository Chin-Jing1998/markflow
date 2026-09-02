/**
 * IR → DOCX（Buffer）
 *
 * 职责：把 mdast 形态的 IR 遍历为 docx 包的 Document/Paragraph/Table，返回 .docx 二进制。
 * 要点：
 *   - 渲染前先经 downgradeCustomNodes 把 slideBreak/sheetSection 降级为标准节点；
 *   - 图片按 node.data.asset 内嵌（png/jpg/gif/bmp，宽超 600px 按比例缩小），
 *     svg/webp/emf 或无 asset 的图片降级为斜体 alt 文本并记 warning；
 *   - 链接输出真实超链接（ExternalHyperlink），任务列表以 ☐/☑ 前缀表达；
 *   - 引用块左缩进 + 左边线 + 灰色文字；代码块逐行拆分、等宽字体、浅灰底纹；
 *   - 表格带边框、表头加粗；HTML 节点去标签后作普通文本；
 *   - 未知节点降级为纯文本段落，绝不静默丢弃。
 * 渲染器只向 doc.warnings 推入字符串，不打印 stdout。
 * 纯文本收集统一引用 converters/ir/util.js 的 collectText。
 */
const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    ImageRun,
    ExternalHyperlink,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
    AlignmentType,
    BorderStyle,
    ShadingType,
} = require('docx');
const { imageSize } = require('image-size');
const { stripHtml } = require('../ir/util');
const { downgradeCustomNodes } = require('../ir/schema');
const { collectText } = require('../ir/util');

// ============================================================
// 常量
// ============================================================

const HEADING_MAP = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6,
};

const ALIGN_MAP = {
    left: AlignmentType.LEFT,
    center: AlignmentType.CENTER,
    right: AlignmentType.RIGHT,
};

/** 文档默认字体：西文 Calibri，中文回退微软雅黑（macOS 由 Word 自动回退到苹方） */
const DEFAULT_FONT = { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: '微软雅黑', cs: 'Calibri' };
const DEFAULT_FONT_SIZE_HALF_PT = 22; // 11pt
const CODE_FONT = 'Courier New';
const CODE_FONT_SIZE_HALF_PT = 20; // 10pt
const CODE_FILL = 'F5F5F7';
const HEADER_FILL = 'F5F5F7';
const LINE_COLOR = 'D2D2D7';
const QUOTE_TEXT_COLOR = '6E6E73';

const INDENT_STEP_TWIP = 720; // 0.5 英寸
const HANGING_TWIP = 360;
const MAX_LIST_DEPTH = 5;
const MAX_IMAGE_WIDTH_PX = 600;
const TASK_CHECKED_PREFIX = '☑ ';
const TASK_UNCHECKED_PREFIX = '☐ ';

const QUOTE_BORDER = { style: BorderStyle.SINGLE, size: 18, color: LINE_COLOR, space: 8 };
const TABLE_BORDER = { style: BorderStyle.SINGLE, size: 4, color: LINE_COLOR };
const TABLE_BORDERS = {
    top: TABLE_BORDER,
    bottom: TABLE_BORDER,
    left: TABLE_BORDER,
    right: TABLE_BORDER,
    insideHorizontal: TABLE_BORDER,
    insideVertical: TABLE_BORDER,
};

/** docx ImageRun 支持的位图类型：由 mime 或 image-size 嗅探结果映射 */
const IMAGE_TYPE_BY_MIME = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
};
const IMAGE_TYPE_BY_SNIFF = { png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', bmp: 'bmp' };
const UNKNOWN_MIMES = new Set(['', 'application/octet-stream']);

// ============================================================
// 入口
// ============================================================

async function render(doc) {
    if (!doc || typeof doc !== 'object') throw new Error('docx 渲染器需要 doc 对象');
    if (!Array.isArray(doc.warnings)) doc.warnings = [];

    const root = downgradeCustomNodes(doc.ir || { type: 'root', children: [] });
    const ctx = { warnings: doc.warnings, quoteDepth: 0, listDepth: 0 };
    const blocks = blocksToDocx(root.children, ctx);
    if (blocks.length === 0) blocks.push(emptyParagraph());

    const document = new Document({
        creator: 'MarkFlow',
        title: String((doc.meta && doc.meta.title) || ''),
        styles: {
            default: {
                document: { run: { font: DEFAULT_FONT, size: DEFAULT_FONT_SIZE_HALF_PT } },
            },
        },
        sections: [{ children: blocks }],
    });
    return Packer.toBuffer(document);
}

// ============================================================
// 块级节点
// ============================================================

function blocksToDocx(nodes, ctx) {
    const out = [];
    for (const node of nodes || []) out.push(...blockToDocx(node, ctx));
    return out;
}

/** 单个块节点 → docx 块（Paragraph/Table）数组 */
function blockToDocx(node, ctx) {
    if (!node || typeof node !== 'object') return [];
    switch (node.type) {
        case 'heading':
            return [
                makeParagraph(
                    ctx,
                    { heading: HEADING_MAP[node.depth] || HeadingLevel.HEADING_6 },
                    inlineToRuns(node.children, ctx),
                ),
            ];
        case 'paragraph':
            return [makeParagraph(ctx, {}, inlineToRuns(node.children, ctx))];
        case 'list':
            return listToDocx(node, ctx);
        case 'blockquote':
            return blocksToDocx(node.children, { ...ctx, quoteDepth: ctx.quoteDepth + 1 });
        case 'code':
            return [codeToDocx(node, ctx)];
        case 'thematicBreak':
            return [ruleParagraph()];
        case 'table':
            return tableToDocx(node, ctx);
        case 'html':
            return textParagraph(stripHtml(node.value), ctx);
        case 'image':
            // 非标准的块级图片（部分 parser 直接产出），按行内图片处理
            return [makeParagraph(ctx, {}, inlineToRuns([node], ctx))];
        default:
            return textParagraph(collectText(node), ctx);
    }
}

/** 纯文本段落；文本为空时不产出，避免留下空行 */
function textParagraph(text, ctx) {
    const value = String(text || '').trim();
    if (!value) return [];
    return [makeParagraph(ctx, {}, [makeRun({ text: value }, ctx)])];
}

/** 统一构造段落：处于引用块内时叠加左缩进与左边线 */
function makeParagraph(ctx, options, children) {
    const props = { ...options };
    if (ctx.quoteDepth > 0) {
        const base = props.indent || {};
        props.indent = { ...base, left: (Number(base.left) || 0) + INDENT_STEP_TWIP * ctx.quoteDepth };
        props.border = { ...(props.border || {}), left: QUOTE_BORDER };
    }
    return new Paragraph({
        ...props,
        children: children.length > 0 ? children : [new TextRun({ text: '' })],
    });
}

/** 统一构造文字 run：处于引用块内且未指定颜色/字符样式时用灰色 */
function makeRun(options, ctx) {
    const props = { ...options };
    if (ctx.quoteDepth > 0 && !props.color && !props.style) props.color = QUOTE_TEXT_COLOR;
    return new TextRun(props);
}

function emptyParagraph() {
    return new Paragraph({ children: [new TextRun({ text: '' })] });
}

function ruleParagraph() {
    return new Paragraph({
        border: { bottom: { color: LINE_COLOR, space: 1, style: BorderStyle.SINGLE, size: 6 } },
        children: [new TextRun({ text: '' })],
    });
}

function codeToDocx(node, ctx) {
    const lines = String(node.value || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\t/g, '    ')
        .split('\n');
    const runs = lines.map((line, index) =>
        makeRun(
            {
                text: line,
                font: CODE_FONT,
                size: CODE_FONT_SIZE_HALF_PT,
                ...(index > 0 ? { break: 1 } : {}),
            },
            ctx,
        ),
    );
    return makeParagraph(
        ctx,
        {
            shading: { fill: CODE_FILL, type: ShadingType.CLEAR },
            spacing: { before: 120, after: 120 },
        },
        runs,
    );
}

// ============================================================
// 列表
// ============================================================

function listToDocx(listNode, ctx) {
    const out = [];
    const depth = ctx.listDepth;
    const ordered = !!listNode.ordered;
    let index = Number.isInteger(listNode.start) ? listNode.start : 1;

    for (const item of listNode.children || []) {
        if (!item || item.type !== 'listItem') {
            out.push(...blockToDocx(item, ctx));
            continue;
        }
        const marker = ordered ? `${index}. ` : '';
        index += 1;
        out.push(...listItemToDocx(item, { marker, ordered, depth }, ctx));
    }
    return out;
}

function listItemToDocx(item, { marker, ordered, depth }, ctx) {
    const out = [];
    const taskPrefix = taskPrefixOf(item.checked);
    const children = item.children || [];
    const hasParagraph = children.some((c) => c && c.type === 'paragraph');
    let isFirst = true;

    // 条目不含段落（如直接以嵌套列表或代码块开头）时，单独补一行前缀
    if (!hasParagraph && (marker || taskPrefix)) {
        out.push(listParagraph([], { prefix: marker + taskPrefix, ordered, depth, isFirst, taskPrefix }, ctx));
        isFirst = false;
    }

    for (const child of children) {
        if (child && child.type === 'paragraph') {
            const prefix = isFirst ? marker + taskPrefix : '';
            out.push(listParagraph(inlineToRuns(child.children, ctx), { prefix, ordered, depth, isFirst, taskPrefix }, ctx));
            isFirst = false;
        } else if (child && child.type === 'list') {
            out.push(...listToDocx(child, { ...ctx, listDepth: Math.min(depth + 1, MAX_LIST_DEPTH) }));
        } else {
            out.push(...blockToDocx(child, ctx));
        }
    }
    return out;
}

function taskPrefixOf(checked) {
    if (checked === true) return TASK_CHECKED_PREFIX;
    if (checked === false) return TASK_UNCHECKED_PREFIX;
    return '';
}

/**
 * 列表条目段落：无序非任务项走 bullet 编号；有序项与任务项用手写前缀（☐/☑ 本身充当标记）。
 * 首段悬挂缩进，续段仅左缩进以与首段正文对齐。
 */
function listParagraph(runs, { prefix, ordered, depth, isFirst, taskPrefix }, ctx) {
    const left = INDENT_STEP_TWIP * (depth + 1);
    const options = { indent: isFirst ? { left, hanging: HANGING_TWIP } : { left } };
    if (!ordered && isFirst && !taskPrefix) options.bullet = { level: depth };
    const children = prefix ? [makeRun({ text: prefix }, ctx), ...runs] : runs;
    return makeParagraph(ctx, options, children);
}

// ============================================================
// 表格
// ============================================================

function tableToDocx(tableNode, ctx) {
    const aligns = Array.isArray(tableNode.align) ? tableNode.align : [];
    const cellCtx = { ...ctx, quoteDepth: 0 };
    const rowNodes = (tableNode.children || []).filter(
        (row) => row && row.type === 'tableRow' && Array.isArray(row.children) && row.children.length > 0,
    );
    if (rowNodes.length === 0) return [];

    const columnCount = Math.max(...rowNodes.map((row) => row.children.length));
    const rows = rowNodes.map((row, rowIndex) => {
        const isHeader = rowIndex === 0;
        const cells = [];
        for (let col = 0; col < columnCount; col += 1) {
            const cellNode = row.children[col];
            cells.push(tableCell(cellNode ? cellNode.children : [], { isHeader, align: aligns[col] }, cellCtx));
        }
        return new TableRow({ children: cells, tableHeader: isHeader });
    });

    return [
        new Table({
            rows,
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: TABLE_BORDERS,
        }),
    ];
}

function tableCell(children, { isHeader, align }, ctx) {
    const runs = inlineToRuns(children, ctx, isHeader ? { bold: true } : {});
    return new TableCell({
        shading: isHeader ? { fill: HEADER_FILL, type: ShadingType.CLEAR } : undefined,
        children: [makeParagraph(ctx, { alignment: ALIGN_MAP[align] || AlignmentType.LEFT }, runs)],
    });
}

// ============================================================
// 行内节点（fmt 为继承的格式：bold/italics/strike/style 等）
// ============================================================

function inlineToRuns(nodes, ctx, fmt = {}) {
    const out = [];
    for (const node of nodes || []) out.push(...inlineToRun(node, ctx, fmt));
    return out;
}

function inlineToRun(node, ctx, fmt) {
    if (!node || typeof node !== 'object') return [];
    switch (node.type) {
        case 'text':
            return [makeRun({ ...fmt, text: String(node.value || '') }, ctx)];
        case 'strong':
            return inlineToRuns(node.children, ctx, { ...fmt, bold: true });
        case 'emphasis':
            return inlineToRuns(node.children, ctx, { ...fmt, italics: true });
        case 'delete':
            return inlineToRuns(node.children, ctx, { ...fmt, strike: true });
        case 'inlineCode':
            return [makeRun({ ...fmt, text: String(node.value || ''), font: CODE_FONT }, ctx)];
        case 'break':
            return [new TextRun({ break: 1 })];
        case 'link':
            return linkToDocx(node, ctx, fmt);
        case 'image':
            return [imageToDocx(node, ctx, fmt)];
        case 'html': {
            const text = stripHtml(node.value);
            return text ? [makeRun({ ...fmt, text }, ctx)] : [];
        }
        default: {
            const text = collectText(node);
            return text ? [makeRun({ ...fmt, text }, ctx)] : [];
        }
    }
}

function linkToDocx(node, ctx, fmt) {
    const url = typeof node.url === 'string' ? node.url.trim() : '';
    const linkFmt = { ...fmt, style: 'Hyperlink' };
    let children = inlineToRuns(node.children, ctx, linkFmt);
    if (!url) return children;
    if (children.length === 0) children = [makeRun({ ...linkFmt, text: url }, ctx)];
    return [new ExternalHyperlink({ link: url, children })];
}

// ============================================================
// 图片
// ============================================================

function imageToDocx(node, ctx, fmt) {
    const alt = String(node.alt || node.url || '图片');
    const asset = node.data && node.data.asset;
    const data = toBuffer(asset && asset.buffer);
    const degrade = (reason) => {
        ctx.warnings.push(`图片未内嵌，已降级为文字「${alt}」：${reason}`);
        return makeRun({ ...fmt, text: alt, italics: true }, ctx);
    };

    if (!asset || !data || data.length === 0) return degrade(`缺少可用的图片数据（${node.url || '无地址'}）`);
    const type = resolveImageType(asset.mime, data);
    if (!type) return degrade(`不支持的图片格式 ${asset.mime || '未知'}，仅支持 png/jpg/gif/bmp`);
    const size = resolveImageSize(asset, data);
    if (!size) return degrade('无法解析图片尺寸');

    try {
        return new ImageRun({
            type,
            data,
            transformation: { width: size.width, height: size.height },
            altText: { name: alt, description: alt, title: alt },
        });
    } catch (err) {
        return degrade(`docx 内嵌失败（${err && err.message ? err.message : err}）`);
    }
}

function toBuffer(value) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    return null;
}

/** 由 mime 判定 docx 图片类型；mime 未知时用 image-size 嗅探，已知但不支持（svg/webp/emf）返回 null */
function resolveImageType(mime, data) {
    const normalized = String(mime || '').toLowerCase().trim();
    if (IMAGE_TYPE_BY_MIME[normalized]) return IMAGE_TYPE_BY_MIME[normalized];
    if (!UNKNOWN_MIMES.has(normalized)) return null;
    const sniffed = measure(data);
    return (sniffed && IMAGE_TYPE_BY_SNIFF[sniffed.type]) || null;
}

/** 优先用 asset 自带尺寸，缺失时用 image-size 解析；宽超 600px 按比例缩放 */
function resolveImageSize(asset, data) {
    let width = positiveInt(asset.width);
    let height = positiveInt(asset.height);
    if (!width || !height) {
        const measured = measure(data);
        width = measured && positiveInt(measured.width);
        height = measured && positiveInt(measured.height);
    }
    if (!width || !height) return null;
    if (width > MAX_IMAGE_WIDTH_PX) {
        height = Math.max(1, Math.round((height * MAX_IMAGE_WIDTH_PX) / width));
        width = MAX_IMAGE_WIDTH_PX;
    }
    return { width, height };
}

function measure(data) {
    try {
        return imageSize(data);
    } catch (err) {
        return null;
    }
}

function positiveInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

// ============================================================
// 文本工具
// ============================================================


module.exports = { render };
