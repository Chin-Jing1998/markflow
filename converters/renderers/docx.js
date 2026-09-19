/**
 * IR → DOCX（Buffer）
 *
 * 职责：把 mdast 形态的 IR 遍历为 docx 包的 Document/Paragraph/Table，返回 .docx 二进制。
 * 要点：
 *   - 渲染前先经 downgradeCustomNodes 把 slideBreak/sheetSection 降级为标准节点；
 *   - 图片按 node.data.asset 内嵌（png/jpg/gif/bmp，宽超 600px 按比例缩小），
 *     svg/webp/emf 或无 asset 的图片降级为斜体 alt 文本并记 warning；
 *     带物理显示尺寸的图片（data.displayWidthMm / displayHeightMm，专利五书 XML 反向导入写入）按毫米定尺寸，
 *     不受 600px 上限约束：毫米先换成整数 EMU（1 mm = 36000 EMU）再写 wp:extent，使正向链路从 wp:extent
 *     换回的毫米与目标像素逐值复原（1 像素 @300 DPI 恰为 3048 EMU）；
 *   - 图片角色的往返载体：data.role 为 formula / table / chemistry 的图片，替换文字写成 markflow:role=<角色>，
 *     原 alt 非空时写成 markflow:role=<角色>;<原 alt>；docx 解析器据此还原 data.role，XML 渲染层再包回
 *     maths / tables / chemistry；
 *   - Word 分节与页眉：顶层节点带 data.section = { index, header }（约定见 ir/schema，parsers/docx-sections 与
 *     parsers/xml 写入）时，按 index 把顶层节点分组，每组一个 Word 分节（下一页起），header 写进该节页眉；
 *     确有两节及以上时，标了 data.role = 'section-title' 的书目标题节点略去——书目名已由页眉承载，官方五书模板
 *     的正文里同样没有书目标题段；只有一节时保留它，因为单节文档的页眉不足以让 docx 解析器认出书目。
 *     没有任何节点带 data.section 的文档仍只产出一节，行为与此前一致；
 *   - 链接输出真实超链接（ExternalHyperlink），任务列表以 ☐/☑ 前缀表达；
 *   - 引用块左缩进 + 左边线 + 灰色文字；代码块逐行拆分、等宽字体、浅灰底纹；
 *   - 表格带边框、表头加粗；HTML 节点去标签后作普通文本（含 data.safeTable 的 <table> 片段，
 *     docx 不重建表格结构，仅取其文本，属已知限制）；
 *   - math 节点先经 degradeMath 降级为线性化文本；
 *   - 纸张、页边距、正文字号与中西文字体取自 options.docx（省略 options 时为该模块的默认值）；
 *   - 未知节点降级为纯文本段落，绝不静默丢弃。
 * 渲染器只向 doc.warnings 推入字符串，不打印 stdout；纯文本收集统一用 ir/util 的 collectText。
 */
// docx 包内打包的 util-deprecate 垫片在加载期读取 globalThis.localStorage；Node 25 起该访问器在未传
// --localstorage-file 时会向 stderr 打印 ExperimentalWarning，破坏 CLI「--json 模式 stderr 为空」的约定。
// 加载期间临时用值为 undefined 的自有属性遮住访问器，加载完即还原，不改变全局对象的最终形态。
function requireDocx() {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const shadowed = Boolean(descriptor && typeof descriptor.get === 'function' && descriptor.configurable);
    if (shadowed) {
        Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true, enumerable: false });
    }
    try {
        return require('docx');
    } finally {
        if (shadowed) Object.defineProperty(globalThis, 'localStorage', descriptor);
    }
}

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
    Tab,
    Header,
} = requireDocx();
const { imageSize } = require('image-size');
const { stripHtml, collectText } = require('../ir/util');
const { toBuffer } = require('../util');
const { downgradeCustomNodes, degradeMath } = require('../ir/schema');
const { stripMarkersTree } = require('../ir/markers');
const { normalizeOptions } = require('../options');

// ---- 常量 ----

const HEADING_MAP = {
    1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4, 5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6,
};
const ALIGN_MAP = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT };

/** 文档默认字体：西文 Calibri，中文回退微软雅黑（macOS 由 Word 自动回退到苹方） */
const DEFAULT_FONT = { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: '微软雅黑', cs: 'Calibri' };
const DEFAULT_FONT_SIZE_PT = 11;

const TWIP_PER_INCH = 1440;
/** 纸张尺寸（twip）：A4 = 210×297mm，Letter = 8.5×11in */
const PAGE_SIZE_TWIP = Object.freeze({
    A4: Object.freeze({ width: 11906, height: 16838 }),
    Letter: Object.freeze({ width: 12240, height: 15840 }),
});
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
// 物理显示尺寸 → wp:extent：docx 包按「像素 × 9525」取整得 EMU，故把整数 EMU 折成（可带小数的）像素交给它
const EMU_PER_MM = 36000;
const EMU_PER_PX = 9525;
// 超出此范围的毫米值不可信（Word 的页面上限约 558 mm），退回按像素定尺寸
const MAX_PHYSICAL_MM = 2000;
// 图片角色的往返载体（与 docx 解析器的读取侧逐字一致）
const ROLE_ALT_PREFIX = 'markflow:role=';
const ROLE_ALT_SEPARATOR = ';';
const IMAGE_ROLES = new Set(['formula', 'table', 'chemistry']);
const SECTION_TITLE_ROLE = 'section-title';
const PERCENT_BASE = 100;
const TASK_CHECKED_PREFIX = '☑ ';
const TASK_UNCHECKED_PREFIX = '☐ ';

const QUOTE_BORDER = { style: BorderStyle.SINGLE, size: 18, color: LINE_COLOR, space: 8 };
const TABLE_BORDER = { style: BorderStyle.SINGLE, size: 4, color: LINE_COLOR };
const TABLE_BORDERS = Object.fromEntries(
    ['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].map((side) => [side, TABLE_BORDER]),
);

/** docx ImageRun 支持的位图类型：由 mime 或 image-size 嗅探结果映射 */
const IMAGE_TYPE_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' };
const IMAGE_TYPE_BY_SNIFF = { png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', bmp: 'bmp' };
const UNKNOWN_MIMES = new Set(['', 'application/octet-stream']);

// ---- 入口 ----

/**
 * @param {object} doc MarkFlowDocument
 * @param {object} [options] 经 converters/options.js 归一的选项；省略则全取默认值
 * @returns {Promise<Buffer>} .docx 二进制
 */
async function render(doc, options) {
    if (!doc || typeof doc !== 'object') throw new Error('docx 渲染器需要 doc 对象');
    if (!Array.isArray(doc.warnings)) doc.warnings = [];
    const docxOptions = normalizeOptions(options).docx;

    // 公式降级须在自定义节点降级之前完成：两者互不依赖，合起来把 IR 收敛为纯标准 mdast；残留标记兜底剥除
    const root = downgradeCustomNodes(degradeMath(stripMarkersTree(doc.ir || { type: 'root', children: [] })));
    const ctx = { warnings: doc.warnings, quoteDepth: 0, listDepth: 0 };
    const sections = groupSections(root.children).map((group) => sectionToDocx(group, docxOptions, ctx));

    const document = new Document({
        creator: 'MarkFlow',
        title: String((doc.meta && doc.meta.title) || ''),
        styles: { default: { document: { run: runDefaults(docxOptions) } } },
        sections,
    });
    return Packer.toBuffer(document);
}

// ---- 分节 ----

/**
 * 顶层节点 → [{ header: string | null, nodes }]。data.section.index 变化即另起一组；不带分节信息的节点
 * （自定义节点降级出的标题等）并入当前组。全文没有分节信息时只有一组、header 为 null。
 * 确有两组及以上时略去书目标题节点（见文件头）。
 */
function groupSections(nodes) {
    const groups = [];
    let currentIndex = null;
    for (const node of nodes || []) {
        const section = node && node.data && node.data.section;
        const index = section && Number.isInteger(section.index) ? section.index : currentIndex;
        if (groups.length === 0 || index !== currentIndex) {
            groups.push({ header: section && typeof section.header === 'string' && section.header.trim() ? section.header.trim() : null, nodes: [] });
            currentIndex = index;
        }
        groups[groups.length - 1].nodes.push(node);
    }
    if (groups.length === 0) return [{ header: null, nodes: [] }];
    if (groups.length === 1) return groups;
    return groups.map((group) => ({ ...group, nodes: group.nodes.filter((node) => !isSectionTitle(node)) }));
}

const isSectionTitle = (node) => Boolean(node && node.type === 'heading' && node.data && node.data.role === SECTION_TITLE_ROLE);

function sectionToDocx(group, docxOptions, ctx) {
    const children = blocksToDocx(group.nodes, ctx);
    if (children.length === 0) children.push(emptyParagraph());
    const section = { properties: { page: pageProperties(docxOptions) }, children };
    if (group.header) section.headers = { default: headerOf(group.header) };
    return section;
}

// 页眉多行（事务所抬头一行、书目名一行）逐行成段，居中
const headerOf = (text) => new Header({
    children: text.split('\n').map((line) => new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: line })] })),
});

/** 文档默认 run：西文字体同时用于 hAnsi 与 cs，中文走 eastAsia；字号由 pt 换算为半磅 */
function runDefaults({ fontSize, fontFamily }) {
    const ascii = nonEmpty(fontFamily && fontFamily.ascii, DEFAULT_FONT.ascii);
    const eastAsia = nonEmpty(fontFamily && fontFamily.eastAsia, DEFAULT_FONT.eastAsia);
    const pt = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : DEFAULT_FONT_SIZE_PT;
    return { font: { ascii, hAnsi: ascii, eastAsia, cs: ascii }, size: Math.round(pt * 2) };
}

/** 页面属性：纸张恒定输出，页边距只在 options.docx.margins 非空时输出（null 表示沿用 docx 包默认） */
function pageProperties({ pageSize, margins }) {
    const page = { size: { ...(PAGE_SIZE_TWIP[pageSize] || PAGE_SIZE_TWIP.A4) } };
    if (margins && typeof margins === 'object') {
        page.margin = {
            top: inchToTwip(margins.top),
            bottom: inchToTwip(margins.bottom),
            left: inchToTwip(margins.left),
            right: inchToTwip(margins.right),
        };
    }
    return page;
}

function inchToTwip(inch) {
    const value = Number(inch);
    return Math.round((Number.isFinite(value) && value >= 0 ? value : 1) * TWIP_PER_INCH);
}

function nonEmpty(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

// ---- 块级节点 ----

function blocksToDocx(nodes, ctx) {
    const out = [];
    for (const node of nodes || []) out.push(...blockToDocx(node, ctx));
    return out;
}

/** 单个块节点 → docx 块（Paragraph/Table）数组 */
function blockToDocx(node, ctx) {
    if (!node || typeof node !== 'object') return [];
    switch (node.type) {
        case 'heading': {
            const heading = HEADING_MAP[node.depth] || HeadingLevel.HEADING_6;
            return [makeParagraph(ctx, { heading }, inlineToRuns(node.children, ctx))];
        }
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
    return new Paragraph({ ...props, children: children.length > 0 ? children : [new TextRun({ text: '' })] });
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
    const lines = String(node.value || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    const runs = lines.map((line, index) =>
        makeRun({ text: line, font: CODE_FONT, size: CODE_FONT_SIZE_HALF_PT, ...(index > 0 ? { break: 1 } : {}) }, ctx),
    );
    const options = { shading: { fill: CODE_FILL, type: ShadingType.CLEAR }, spacing: { before: 120, after: 120 } };
    return makeParagraph(ctx, options, runs);
}

// ---- 列表 ----

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

// ---- 表格 ----

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

    return [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, borders: TABLE_BORDERS })];
}

function tableCell(children, { isHeader, align }, ctx) {
    const runs = inlineToRuns(children, ctx, isHeader ? { bold: true } : {});
    return new TableCell({
        shading: isHeader ? { fill: HEADER_FILL, type: ShadingType.CLEAR } : undefined,
        children: [makeParagraph(ctx, { alignment: ALIGN_MAP[align] || AlignmentType.LEFT }, runs)],
    });
}

// ---- 行内节点（fmt 为继承的格式：bold/italics/strike/style 等）----

function inlineToRuns(nodes, ctx, fmt = {}) {
    const out = [];
    for (const node of nodes || []) out.push(...inlineToRun(node, ctx, fmt));
    return out;
}

function inlineToRun(node, ctx, fmt) {
    if (!node || typeof node !== 'object') return [];
    switch (node.type) {
        case 'text':
            return textRuns(String(node.value || ''), ctx, fmt);
        case 'strong':
            return inlineToRuns(node.children, ctx, { ...fmt, bold: true });
        case 'emphasis':
            return inlineToRuns(node.children, ctx, { ...fmt, italics: true });
        case 'delete':
            return inlineToRuns(node.children, ctx, { ...fmt, strike: true });
        case 'underline':
            return inlineToRuns(node.children, ctx, { ...fmt, underline: {} });
        // 上下标互斥（OOXML 的 w:vertAlign 只有一个取值），内层覆盖外层
        case 'superscript':
            return inlineToRuns(node.children, ctx, { ...fmt, subScript: false, superScript: true });
        case 'subscript':
            return inlineToRuns(node.children, ctx, { ...fmt, superScript: false, subScript: true });
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

/** 文本中的 \t 拆成真正的 Word 制表符（w:tab），其余文字照常成 run */
function textRuns(value, ctx, fmt) {
    if (!value.includes('\t')) return [makeRun({ ...fmt, text: value }, ctx)];
    const runs = [];
    value.split('\t').forEach((part, index) => {
        if (index > 0) runs.push(makeRun({ ...fmt, children: [new Tab()] }, ctx));
        if (part) runs.push(makeRun({ ...fmt, text: part }, ctx));
    });
    return runs;
}

function linkToDocx(node, ctx, fmt) {
    const url = typeof node.url === 'string' ? node.url.trim() : '';
    const linkFmt = { ...fmt, style: 'Hyperlink' };
    let children = inlineToRuns(node.children, ctx, linkFmt);
    if (!url) return children;
    if (children.length === 0) children = [makeRun({ ...linkFmt, text: url }, ctx)];
    return [new ExternalHyperlink({ link: url, children })];
}

// ---- 图片 ----

function imageToDocx(node, ctx, fmt) {
    const alt = altTextOf(node);
    const asset = node.data && node.data.asset;
    const data = toBuffer(asset && asset.buffer);
    const degrade = (reason) => {
        ctx.warnings.push(`图片未内嵌，已降级为文字「${alt}」：${reason}`);
        return makeRun({ ...fmt, text: alt, italics: true }, ctx);
    };

    if (!asset || !data || data.length === 0) return degrade(`缺少可用的图片数据（${node.url || '无地址'}）`);
    const type = resolveImageType(asset.mime, data);
    if (!type) return degrade(`不支持的图片格式 ${asset.mime || '未知'}，仅支持 png/jpg/gif/bmp`);
    const size = physicalSize(node.data) || resolveImageSize(asset, data, node.data && node.data.display);
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

// 替换文字：带角色的图片写往返标记（原 alt 为空时只写标记，不拿地址充数）；其余沿用 alt → 地址 → 「图片」
function altTextOf(node) {
    const role = node.data && node.data.role;
    if (typeof role !== 'string' || !IMAGE_ROLES.has(role)) return String(node.alt || node.url || '图片');
    const original = typeof node.alt === 'string' ? node.alt.trim() : '';
    return `${ROLE_ALT_PREFIX}${role}${original ? `${ROLE_ALT_SEPARATOR}${original}` : ''}`;
}

/**
 * 物理显示尺寸（毫米）→ 交给 docx 包的像素值（可带小数）：先取整到 EMU 再除以 9525，docx 包乘回去取整后
 * 即该整数 EMU。两维都须为正且在可信范围内，否则返回 null，走既有的按像素定尺寸与 600px 上限。
 */
function physicalSize(nodeData) {
    const width = Number(nodeData && nodeData.displayWidthMm);
    const height = Number(nodeData && nodeData.displayHeightMm);
    const valid = (mm) => Number.isFinite(mm) && mm > 0 && mm <= MAX_PHYSICAL_MM;
    if (!valid(width) || !valid(height)) return null;
    const toPx = (mm) => Math.max(1, Math.round(mm * EMU_PER_MM)) / EMU_PER_PX;
    return { width: toPx(width), height: toPx(height) };
}

/** 由 mime 判定 docx 图片类型；mime 未知时用 image-size 嗅探，已知但不支持（svg/webp/emf）返回 null */
function resolveImageType(mime, data) {
    const normalized = String(mime || '').toLowerCase().trim();
    if (IMAGE_TYPE_BY_MIME[normalized]) return IMAGE_TYPE_BY_MIME[normalized];
    if (!UNKNOWN_MIMES.has(normalized)) return null;
    const sniffed = measure(data);
    return (sniffed && IMAGE_TYPE_BY_SNIFF[sniffed.type]) || null;
}

/**
 * 显示尺寸（data.display）优先：px 直接取，百分比按 600px 栏宽折算，缺高度时按像素宽高比补；
 * 其次 asset 自带尺寸，缺失时用 image-size 解析。宽超 600px 按比例缩放
 */
function resolveImageSize(asset, data, display) {
    let width = positiveInt(asset.width);
    let height = positiveInt(asset.height);
    if (!width || !height) {
        const measured = measure(data);
        width = measured && positiveInt(measured.width);
        height = measured && positiveInt(measured.height);
    }
    const shown = displaySize(display, width && height ? { width, height } : null);
    if (shown) ({ width, height } = shown);
    if (!width || !height) return null;
    if (width > MAX_IMAGE_WIDTH_PX) {
        height = Math.max(1, Math.round((height * MAX_IMAGE_WIDTH_PX) / width));
        width = MAX_IMAGE_WIDTH_PX;
    }
    return { width, height };
}

function displaySize(display, natural) {
    if (!display || !(Number(display.width) > 0)) return null;
    const width = display.unit === '%'
        ? Math.round((Number(display.width) * MAX_IMAGE_WIDTH_PX) / PERCENT_BASE)
        : positiveInt(display.width);
    if (!width) return null;
    const explicit = display.unit === '%' ? null : positiveInt(display.height);
    if (explicit) return { width, height: explicit };
    if (!natural) return null;
    return { width, height: Math.max(1, Math.round((natural.height * width) / natural.width)) };
}

function measure(data) {
    try { return imageSize(data); } catch (err) { return null; }
}

function positiveInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

module.exports = { render };
