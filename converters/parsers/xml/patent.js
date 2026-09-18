/**
 * 国知局专利五书 XML → IR（renderers/xml/patent.js 的逆映射）
 *
 * booksToIr(documents, ctx) → Promise<{ children, inventionTitle, summary }>
 *   documents  [{ name, dir, root }]：已解析的 XML（root 为 converters/xml/dom 的元素树，根元素 cn-application-body）
 *   ctx        { images, report, paragraphNumbers }：images 为 images.js 的 importer；paragraphNumbers 为 true 时
 *              把说明书与摘要的段号写回段首（[0001] 加两个半角空格，正向链路会原样剥离并复用）
 *   children   mdast 顶层节点；inventionTitle 为发明名称的纯文字（无则 ''）；summary 为各书的计数，供导入概要
 *
 * IR 形态——以「正向链路能原样认回去」为准（识别规则见 renderers/xml/sections.js、claims.js、figures.js）：
 *   - 书目：每个顶层节点带 data.section = { index, header }，与 parsers/docx-sections 给 Word 分节写的约定同形，
 *     header 即书目名。docx 渲染器据此产出真实的 Word 分节与页眉，正向链路按页眉直接归书，不经位置推定；
 *     每书另有一个 depth 1 的书目标题节点（data.role = 'section-title'），md / html 目标靠它分隔五书，
 *     docx 渲染器在页眉已能承载书目名时略去它。书目顺序取官方递交顺序 BOOK_ORDER，书目按内容判定、与文件名无关；
 *     一份 XML 里放了多个书目容器的照样逐个导入，同一书目出现多份时取 name 码点序的第一份。
 *   - 权利要求书：每个 claim 的首个 claim-text 冠以「N. 」成段，其余 claim-text 各成一段；嵌套的 claim-text 拍平。
 *     不用 mdast list——正向链路会给有序列表项再补一次编号。
 *   - 说明书：invention-title → depth 1 的标题（超过正向链路认标题的 40 字上限时改写成「发明名称：X」字段段）；
 *     heading → 标题（depth 取 level，缺省 2）；p → 段落，Italic="1" 整段包成 emphasis；
 *     technical-field 等语义分节容器展开为其内的 heading 与 p。
 *   - 说明书附图：每个 figure → 图片段 + 图号段（图在上、图号在下，与官方模板一致）；图号段取 figure-labels，
 *     旧形态（cn-drawing-p 承载图号、figure-labels 只有图注）合并为「图N 图注」。
 *   - 摘要附图：只写图片段；figure/@num 与顺序不符时才补一个图号段，使回转后的 num 不变。
 *   - 缺图：附图区写成单独的占位段并省去图号段——留着图号段会让正向链路把它错配给下一幅图。
 * 段号缺省不写进正文：官方模板里段号由转换器生成而非手打，留在 Word 里反而妨碍增删段落；回转时按顺序重编。
 */
const { toInline, trimInline, plainText, inlineText, missingImageText } = require('./inline');

const BOOKS = Object.freeze({
    abstract: '说明书摘要', abstractFigure: '摘要附图', claims: '权利要求书', description: '说明书', drawings: '说明书附图',
});
// 官方递交顺序，亦即合并文档的分节顺序
const BOOK_ORDER = Object.freeze(['abstract', 'abstractFigure', 'claims', 'description', 'drawings']);
const CONTAINER_BOOKS = Object.freeze({ 'cn-claims': 'claims', description: 'description', 'cn-drawings': 'drawings', 'cn-abstract': 'abstract' });
const ABSTRACT_FIGURE = 'cn-abst-figure';
const OBJECT_ELEMENTS = new Set(['img', 'maths', 'tables', 'chemistry']);
const INLINE_ELEMENTS = new Set(['b', 'i', 'u', 'sup', 'sub', 'smallcaps', 'overscore', 'figref', 'claim-ref', 'crossref']);
const BLOCK_ELEMENTS = new Set(['p', 'heading', 'invention-title']);
const SKIPPED_BLOCKS = new Set(['br']);
const SECTION_TITLE_ROLE = 'section-title';
const TITLE_DEPTH = 1;
const DEFAULT_HEADING_LEVEL = 2;
const MAX_HEADING_DEPTH = 6;
// 正向链路把标题样段认作发明名称的长度上限（renderers/xml/sections.js 的 MAX_INVENTION_TITLE）
const MAX_TITLE_AS_HEADING = 40;
const TITLE_FIELD_PREFIX = '发明名称：';
const TEMP_NUM = 'XXXX';
const NUMBER_RE = /^\d{1,6}$/;
const PARAGRAPH_NUMBER_GAP = '  ';
// 与 renderers/xml/claims.js 的 CLAIM_START_RE 同一判据
const CLAIM_START_RE = /^\s*\d+\s*[.、．]/;
const FIGURE_LABEL_RE = /^\s*图\s*(\d+)\s*(.*)$/;

const text = (value) => ({ type: 'text', value });
const paragraph = (children) => ({ type: 'paragraph', children });
const elementsOf = (node) => node.children.filter((child) => child.type === 'element');

async function booksToIr(documents, ctx) {
    const books = {};
    for (const document of documents) await collectBooks(document, books, ctx);
    const present = BOOK_ORDER.filter((key) => books[key] && books[key].blocks.length > 0);
    const children = present.flatMap((key, order) => {
        const section = { index: order + 1, header: BOOKS[key] };
        const title = { type: 'heading', depth: TITLE_DEPTH, children: [text(BOOKS[key])], data: { role: SECTION_TITLE_ROLE } };
        return [title, ...books[key].blocks].map((node) => ({ ...node, data: { ...(node.data || {}), section } }));
    });
    const summary = Object.fromEntries(present.map((key) => [key, books[key].stats]));
    return { children, inventionTitle: books.description ? books.description.stats.title || '' : '', summary };
}

// 一份 XML → 其中各书；同一书目已有内容时后来者整份忽略
async function collectBooks(document, books, ctx) {
    for (const container of elementsOf(document.root)) {
        const key = CONTAINER_BOOKS[container.name];
        if (!key) { ctx.report.loss('unmapped', `<${container.name}>`); continue; }
        const scope = { ...ctx, dir: document.dir };
        if (key === 'abstract') {
            // 官方把摘要与摘要附图分成两份 XML，容器同为 cn-abstract：各自只认领自己确有内容的那一书
            const figures = abstractFigures(container);
            const body = abstractBody(container);
            if (figures.length > 0) await claimBook(books, 'abstractFigure', document, () => convertFigures(figures, scope, { labels: false }), ctx);
            if (hasContent(body)) await claimBook(books, 'abstract', document, () => convertBody(body, scope), ctx);
            continue;
        }
        if (!hasContent(container)) continue;
        const convert = { claims: convertClaims, description: convertDescription, drawings: (node, s) => convertFigures([node], s, { labels: true }) }[key];
        await claimBook(books, key, document, () => convert(container, scope), ctx);
    }
}

// 已有内容的书目不再转换后来者（免得白读图片、留下没人引用的资产）；转换结果为空的不占位
async function claimBook(books, key, document, convert, ctx) {
    if (books[key]) {
        ctx.report.warn(`${BOOKS[key]}出现了多份，已采用 ${books[key].source}，忽略 ${document.name}`);
        return;
    }
    const result = await convert();
    if (result.blocks.length > 0) books[key] = { ...result, source: document.name };
}

const hasContent = (node) => node.children.some((child) => child.type === 'element' || child.value.trim() !== '');
const abstractFigures = (container) => elementsOf(container).filter((child) => child.name === ABSTRACT_FIGURE);
const abstractBody = (container) => ({ ...container, children: container.children.filter((child) => !(child.type === 'element' && child.name === ABSTRACT_FIGURE)) });

// ============================================================
// 权利要求书
// ============================================================

async function convertClaims(container, ctx) {
    const blocks = [];
    let claims = 0;
    for (const child of elementsOf(container)) {
        if (child.name !== 'claim') {
            blocks.push(...await convertBlock(child, ctx));
            continue;
        }
        claims += 1;
        blocks.push(...await convertClaim(child, claims, ctx));
    }
    return { blocks, stats: { claims } };
}

async function convertClaim(claim, order, ctx) {
    if (claim.attrs['claim-type']) ctx.report.loss('claimType');
    const declared = String(claim.attrs.num || '').trim();
    const numeric = NUMBER_RE.test(declared);
    const num = numeric ? String(Number(declared)) : String(order);
    if (!numeric) ctx.report.warn(`第 ${order} 项权利要求的 num「${declared}」不是数字，已按顺序编为 ${num}`);
    const segments = [];
    for (const child of elementsOf(claim)) {
        if (child.name === 'claim-text') segments.push(...await flattenClaimText(child, ctx));
        else segments.push(...(await convertBlock(child, ctx)).map((block) => block.children || []));
    }
    const filled = segments.filter((nodes) => nodes.length > 0);
    if (filled.slice(1).some((nodes) => CLAIM_START_RE.test(inlineText(nodes)))) ctx.report.loss('claimContinuation', `权利要求 ${num}`);
    const [first = [], ...rest] = filled;
    return [paragraph([text(`${num}. `), ...first]), ...rest.map(paragraph)];
}

// claim-text → 若干段行内内容；嵌套的 claim-text 把外层内容切成前后两段，自身递归展开
async function flattenClaimText(node, ctx) {
    const segments = [];
    let pending = [];
    const flush = async () => {
        const nodes = trimInline(await toInline(pending, ctx));
        if (nodes.length > 0) segments.push(nodes);
        pending = [];
    };
    for (const child of node.children) {
        if (child.type === 'element' && child.name === 'claim-text') {
            ctx.report.loss('nestedClaimText');
            await flush();
            segments.push(...await flattenClaimText(child, ctx));
        } else {
            pending.push(child);
        }
    }
    await flush();
    return segments;
}

// ============================================================
// 说明书与摘要
// ============================================================

async function convertDescription(container, ctx) {
    const stats = { title: '', headings: 0, paragraphs: 0 };
    const blocks = await convertBody(container, ctx, stats);
    return { blocks: blocks.blocks, stats };
}

/** 正文容器（description、cn-abstract 及其内的语义分节）→ 块；stats 缺省时自建（摘要只计段数） */
async function convertBody(container, ctx, stats = { paragraphs: 0 }) {
    const numbering = { expected: 1 };
    const blocks = [];
    for (const child of container.children) blocks.push(...await convertBlock(child, { ...ctx, stats, numbering }));
    return { blocks, stats };
}

async function convertBlock(node, ctx) {
    if (node.type === 'text') return node.value.trim() ? inlineParagraph([node], ctx) : [];
    if (node.type !== 'element' || SKIPPED_BLOCKS.has(node.name)) return [];
    switch (node.name) {
        case 'p': return convertParagraph(node, ctx);
        case 'heading': return convertHeading(node, ctx);
        case 'invention-title': return convertTitle(node, ctx);
        case 'pb': ctx.report.loss('pageBreak'); return [];
        default:
    }
    // 直接落在块级位置的图片、公式 / 表格 / 化学式与行内标记：各自成段，标记与角色照常保留
    if (OBJECT_ELEMENTS.has(node.name) || INLINE_ELEMENTS.has(node.name)) return inlineParagraph([node], ctx);
    // 语义分节容器（technical-field、disclosure……）与其它未知容器：其内有段落或标题的逐层展开，否则按一段文字导入
    if (!containsBlocks(node)) {
        ctx.report.loss('unmapped', `<${node.name}>`);
        return inlineParagraph(node.children, ctx);
    }
    const blocks = [];
    for (const child of node.children) blocks.push(...await convertBlock(child, ctx));
    return blocks;
}

// 后代里有没有 p / heading / invention-title（显式栈遍历，深度已由扫描器的 maxDepth 封顶）
function containsBlocks(node) {
    const stack = [...elementsOf(node)];
    while (stack.length > 0) {
        const current = stack.pop();
        if (BLOCK_ELEMENTS.has(current.name)) return true;
        stack.push(...elementsOf(current));
    }
    return false;
}

async function inlineParagraph(children, ctx) {
    const nodes = trimInline(await toInline(children, ctx));
    return nodes.length > 0 ? [paragraph(nodes)] : [];
}

async function convertParagraph(node, ctx) {
    let nodes = trimInline(await toInline(node.children, ctx));
    if (nodes.length === 0) return [];
    // 段号先于整段斜体写入：正向链路先判整段斜体、后剥段号，段号落在斜体之外会让 Italic="1" 认不回来
    const number = paragraphNumber(node, ctx);
    if (number) nodes = [text(`[${number}]${PARAGRAPH_NUMBER_GAP}`), ...nodes];
    if (node.attrs.Italic === '1') nodes = [{ type: 'emphasis', children: nodes }];
    if (ctx.stats) ctx.stats.paragraphs += 1;
    return [paragraph(nodes)];
}

// 段号：临时段与非数字段号记为丢失；数字段号在 paragraphNumbers 开启时返回原文以写回段首，否则核对是否自 1 连续
function paragraphNumber(node, ctx) {
    const num = String(node.attrs.num || '').trim();
    if (!ctx.numbering) return null;
    if (num === TEMP_NUM) { ctx.report.loss('tempParagraph'); return null; }
    if (!NUMBER_RE.test(num)) return null;
    if (ctx.paragraphNumbers) return num;
    if (Number(num) !== ctx.numbering.expected) ctx.report.loss('paragraphNumber', `[${num}]`);
    ctx.numbering.expected = Number(num) + 1;
    return null;
}

async function convertHeading(node, ctx) {
    const nodes = trimInline(await toInline(node.children, ctx));
    if (nodes.length === 0) return [];
    const level = Number(node.attrs.level);
    if (node.attrs.level !== undefined && level !== DEFAULT_HEADING_LEVEL) ctx.report.loss('headingLevel', `level="${node.attrs.level}"`);
    const depth = Number.isInteger(level) && level >= 1 && level <= MAX_HEADING_DEPTH ? level : DEFAULT_HEADING_LEVEL;
    if (ctx.stats && ctx.stats.headings !== undefined) ctx.stats.headings += 1;
    return [{ type: 'heading', depth, children: nodes }];
}

// 发明名称：正向链路只写纯文本，其内的标记与图片回转后必丢
async function convertTitle(node, ctx) {
    const title = plainText(node).replace(/\s+/g, ' ').trim();
    if (!title) return [];
    if (elementsOf(node).length > 0) ctx.report.loss('titleMarkup');
    if (ctx.stats && !ctx.stats.title) ctx.stats.title = title;
    if (title.length > MAX_TITLE_AS_HEADING) return [paragraph([text(`${TITLE_FIELD_PREFIX}${title}`)])];
    return [{ type: 'heading', depth: TITLE_DEPTH, children: [text(title)] }];
}

// ============================================================
// 说明书附图与摘要附图
// ============================================================

/**
 * containers 内的 figure 依文档顺序 → 图片段（与图号段）。cn-drawing-p 的图号段按正向链路同一规则附着：
 * 紧跟在尚无图号的图片之后的归该图，否则留给下一幅图；不是图号的文字原样成段（正向链路会丢弃并告警）。
 */
async function convertFigures(containers, ctx, { labels }) {
    const entries = attachLooseLabels(containers.flatMap((container) => collectFigureEntries(container, ctx)));
    const blocks = [];
    let figures = 0;
    let lastNum = 0;
    for (const entry of entries) {
        if (entry.kind === 'note') { blocks.push(...await inlineParagraph(entry.node.children, ctx)); continue; }
        figures += 1;
        const num = figureNumber(entry, lastNum);
        lastNum = num;
        blocks.push(...await figureBlocks(entry, { num, order: figures, labels }, ctx));
    }
    return { blocks, stats: { figures } };
}

// 深度优先收集 figure 与 cn-drawing-p / p 文字段（手写 XML 里 figure 可能被包在 cn-drawing-p 内，一并容忍）
function collectFigureEntries(node, ctx) {
    return elementsOf(node).flatMap((child) => {
        if (child.name === 'figure') return [{ kind: 'figure', node: child, label: null }];
        if (child.name === 'pb') { ctx.report.loss('pageBreak'); return []; }
        if (child.name === 'p') return plainText(child).trim() ? [{ kind: 'note', node: child }] : [];
        // 没有 figure 包裹的裸 img：当作一幅没有属性的 figure
        if (child.name === 'img') return [{ kind: 'figure', node: { type: 'element', name: 'figure', attrs: {}, children: [child] }, label: null }];
        return collectFigureEntries(child, ctx);
    });
}

// 图号形态的文字段并入相邻的 figure：前一幅图还没有图号就归它，否则归紧随其后的那一幅；返回新序列，不改动入参
function attachLooseLabels(entries) {
    const labelOf = new Map();
    const consumed = new Set();
    entries.forEach((entry, index) => {
        if (entry.kind !== 'note') return;
        const label = plainText(entry.node).replace(/\s+/g, ' ').trim();
        if (!FIGURE_LABEL_RE.test(label)) return;
        const owner = [index - 1, index + 1].find((at) => entries[at] && entries[at].kind === 'figure' && !labelOf.has(at));
        if (owner === undefined) return;
        labelOf.set(owner, label);
        consumed.add(index);
    });
    return entries.map((entry, index) => (labelOf.has(index) ? { ...entry, label: labelOf.get(index) } : entry))
        .filter((entry, index) => !consumed.has(index));
}

// 图号：figure/@num → 图号段里的数字 → 上一幅图的下一号
function figureNumber(entry, lastNum) {
    const declared = String(entry.node.attrs.num || '').trim();
    if (NUMBER_RE.test(declared) && Number(declared) >= 1) return Number(declared);
    const fromLabel = FIGURE_LABEL_RE.exec(entry.label || entry.node.attrs['figure-labels'] || '');
    return fromLabel ? Number(fromLabel[1]) : lastNum + 1;
}

async function figureBlocks(entry, { num, order, labels }, ctx) {
    const images = [];
    for (const child of elementsOf(entry.node)) if (child.name === 'img') images.push(...await toInline([child], ctx));
    const missing = images.length === 0 || images.every((node) => node.type !== 'image');
    const labelText = figureLabel(entry, num);
    if (missing) {
        const file = elementsOf(entry.node).filter((child) => child.name === 'img').map((child) => String(child.attrs.file || '').trim()).join('、');
        return [paragraph([text(missingImageText(`${labelText}${file ? `（${file}）` : ''}`))])];
    }
    if (!labels) {
        if (entry.node.attrs['figure-labels'] || entry.label) ctx.report.loss('figureAttributes', 'figure-labels');
        return num === order ? [paragraph(images)] : [paragraph(images), paragraph([text(`图${num}`)])];
    }
    return [paragraph(images), paragraph([text(labelText)])];
}

// 图号段文字：figure-labels 自带「图N」的原样采用（官方形态）；figure-labels 只有图注的（旧形态）合并为「图N 图注」；
// 没有 figure-labels 时取 cn-drawing-p 里的图号段原文（可带图注，如「图3：局部放大图」），再没有即「图N」
function figureLabel(entry, num) {
    const attr = String(entry.node.attrs['figure-labels'] || '').replace(/\s+/g, ' ').trim();
    if (FIGURE_LABEL_RE.test(attr)) return attr;
    if (attr) return `图${num} ${attr}`;
    return entry.label && FIGURE_LABEL_RE.test(entry.label) ? entry.label : `图${num}`;
}

module.exports = { booksToIr, BOOKS, BOOK_ORDER, SECTION_TITLE_ROLE };
