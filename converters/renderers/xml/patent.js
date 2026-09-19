/**
 * xml 目标 patent profile：国知局专利五书（cn-application-body-20080416.dtd）
 *
 * analyze(doc, options) → { books, inventionTitle, issues, assignments, annotatedIr }   纯分类，供桌面端预览复用
 * render(doc, options)  → { files, assets, extras: [], warnings, omitDocAssets: true, issues, analysis, title? }
 *   产物结构与官方「WORD 转 XML 编辑器」的真实产出一致：每书一个以表格代码命名的目录（BOOK_CODES），目录内为
 *   <代码>.xml 与该书的图片 <代码>_<序号>.<扩展名>（序号规则见 assets.js）；没有 List.xml，也没有其它文件。
 *   files：五书分文件（FILE_NAMES，键形如 '100001/100001.xml'；parts 为 auto 时只输出识别到的部分）
 *          + {name}.zip（条目与落盘的五书、图片相对路径逐一相同：无外层文件夹、无目录条目、正斜杠、DEFLATE）
 *          + precheck.json（问题项清单与 validation 记录 { requested, engine, files: [{ file, valid, errors, warnings }] }，
 *          file 即 FILE_NAMES 的相对路径；precheck.json 与 zip 留在 {name}/ 根下，均不入 zip）；
 *   title：发明名称文本，调度器据此覆盖结果信封的 title；
 *   assets：[{ name: '100003/100003_1.jpg', buffer, mime }]，只含已输出各书的图片；img/@file 写裸文件名
 *          （FILE_REF_STYLE 'bare'，图片与所属 XML 同目录），故 omitDocAssets 为 true，调度器不再合并 doc.assets。
 *   outputs 的键（claims / description / drawings / abstract / abstractFigure）由 converters/output.js 按表格代码
 *   显式映射，须与 BOOK_CODES 一致（test/output.test.js 锁定）。
 * 字节级形态同样对齐官方：UTF-8 BOM、换行统一为 CRLF（不留裸 LF）、空元素写作 `<img … />`（XML_STYLE）；
 *   官方产出中不规则的空行与缩进不模仿。
 * 元素与属性约定以官方「WORD 转 XML 编辑器」的真实产出为准：UTF-8 BOM + 文件头三行（DOCTYPE 带空内部
 *   子集 []）+ <cn-application-body lang="zh" country="CN">；heading id="h0001" level="2"；
 *   p id="p0001" num="0001" Italic="0"；临时段 id="l0001" num="XXXX"；claim id="cl001" num="1"；
 *   figure id="f0001" num="0001" figure-labels="图1"（官方不产出 cn-drawing-p，图注即该属性）；
 *   tables tabl0001 / maths math0001 / chemistry chem0001 的 @num 一律四位补零；
 *   img 属性顺序为 id file wi he top left img-content img-format orientation inline，其中 wi/he 为毫米
 *   （向下取整）、file 为裸文件名、top/left 恒 "0"、orientation 恒 "portrait"、说明书附图与摘要附图
 *   inline="yes" 而说明书正文内的图 inline="no"，id 前缀按用途分 if / iaf / idf 三种并各自独立编号；
 *   官方不生成 claim-ref 与 figref，权项引用与正文图号一律保留为纯文本；
 *   容器元素不写 id；不用 technical-field 等语义分节元素，统一 (heading*, p+)+。
 * 表格 / 公式 / 化学式：带角色的 image 节点（data.role 'table' | 'formula' | 'chemistry'，ROLE_WRAPPERS）→
 *   <tables> / <maths> / <chemistry> 内仅含 img；chemistry 不写 chem 元素（官方转换器从不输出它，官方样式表在
 *   chem 存在时会隐藏图片）。仍为 table / math 节点的（栅格化未就绪或已关闭）降级为逐行文本 / 线性化文本并记
 *   「栅格化：」问题项。
 *   化学式图片与无角色图片同等参与分块（见 blocks 的 FIGURE_ROLES）：落在说明书附图 / 摘要附图里按附图输出
 *   为 figure > img（DTD 的 figure 只容纳 img，不包 chemistry），落在权利要求书 / 说明书 / 摘要正文里才包成
 *   chemistry > img。
 * 权利要求内的图片（化学结构式、公式图）：只含图片的段输出为 claim-text 内的 img，与说明书正文内图片同一规则
 *   （id 前缀 idf、inline="no"），不报问题项；说明书与摘要里只含图片的段按段内图片输出，并提示其可能是误放的附图
 *   （带角色的图片除外——它输出为 chemistry / maths / tables，本就是正文内容）。
 * 大图拆段的并回：解析层（ir/captions）为 Markdown 可读性把段首 / 段尾的大图拆成独立段落，并给同一原段落拆出的
 *   各块打上同组标记（data.splitGroup）。官方转换器逐个 Word 段落转换（一个 Word 段落 = 一个 p），故正文三书
 *   （权利要求书、说明书、摘要）在渲染前用 blocks 的 mergeSplitGroups 把同组的相邻块并回一个段落：段号只占一个、
 *   不再顺延，段内图片仍走 emitInline 的既有规则（chemistry / maths / tables 包裹照旧），并回后含文字的段落不再报
 *   「如为附图请移至说明书附图部分」（该提示只针对整段只有图片的块）。说明书附图与摘要附图不并——那两本书里
 *   「图片 + 同段图号」须保持拆开才能认成 figure 与图号。
 * options.xml.validate 为 true 时逐份调 validateXml，错误以「DTD 校验：」问题项进 warnings 与 precheck.json。
 */
const JSZip = require('jszip');
const { el, serializeDocument } = require('./builder');
const { flattenBlocks, mergeSplitGroups } = require('./blocks');
const { detectSections, BOOK_KEYS } = require('./sections');
const { buildClaims } = require('./claims');
const { buildFigures, buildImg, assetNameOf } = require('./figures');
const { createIdFactory, createParagraphNumbering, createTempNumbering, stripParagraphNumber, padNumber } = require('./numbering');
const { createAssetRegistry } = require('./assets');
const { precheck, createIssue, ISSUE_CODES, LEVELS } = require('./precheck');
const { validateXml, describeValidation } = require('./validate');
const { emitRuns, isWholeMark, withoutMark, textRun } = require('./inline');
const { mathToText } = require('../../ir/schema');

// ---------- 产物布局：官方「WORD 转 XML 编辑器」的真实产出 ----------
// 表格代码 ↔ 书目：每书一个以表格代码命名的目录，目录内为 <代码>.xml 与该书的图片（命名见 assets.js）
const BOOK_CODES = Object.freeze({
    claims: '100001', description: '100002', drawings: '100003', abstract: '100004', abstractFigure: '100005',
});
const XML_EXT = '.xml';
const bookXmlPath = (code) => `${code}/${code}${XML_EXT}`;
// 五书相对产物目录的 posix 路径，同时是 zip 条目名与 validation 记录的 file
const FILE_NAMES = Object.freeze(Object.fromEntries(Object.entries(BOOK_CODES).map(([key, code]) => [key, bookXmlPath(code)])));
// img/@file 只写裸文件名：图片与所属 XML 同目录
const FILE_REF_STYLE = 'bare';
// zip 条目规则：条目名即落盘相对路径（正斜杠、无外层文件夹）；官方 zip 只有文件条目，故不自动补目录条目；
// 每书先 XML 后图片；precheck.json 不入 zip，官方产出没有 List.xml
const ZIP_ENTRY_OPTIONS = Object.freeze({ createFolders: false });
const ZIP_OPTIONS = Object.freeze({ type: 'nodebuffer', compression: 'DEFLATE' });
// 官方 XML 的换行为 CRLF，空元素写作 `<img … />`
const XML_STYLE = Object.freeze({ newline: '\r\n', emptyTagSpace: true });

// ---------- 元素、属性与 id 约定 ----------
const ELEMENT_NAMES = Object.freeze({
    root: 'cn-application-body', claims: 'cn-claims', claim: 'claim', claimText: 'claim-text',
    description: 'description', inventionTitle: 'invention-title', heading: 'heading', paragraph: 'p', lineBreak: 'br',
    drawings: 'cn-drawings', figure: 'figure', img: 'img',
    abstract: 'cn-abstract', abstractFigure: 'cn-abst-figure', tables: 'tables', maths: 'maths', chemistry: 'chemistry',
});
// img 的 id 前缀按用途分三种：说明书附图 if、摘要附图 iaf、说明书正文内（公式、表格、段内图）idf
const ID_PREFIXES = Object.freeze({
    heading: 'h', figure: 'f', drawingImg: 'if', abstractImg: 'iaf', bodyImg: 'idf',
    tables: 'tabl', maths: 'math', chemistry: 'chem', claim: 'cl',
});
// 带角色的图片 → 包裹元素与 id 前缀（内部仅含 img；@num 四位补零）
const ROLE_WRAPPERS = Object.freeze({
    table: Object.freeze({ element: ELEMENT_NAMES.tables, prefix: ID_PREFIXES.tables }),
    formula: Object.freeze({ element: ELEMENT_NAMES.maths, prefix: ID_PREFIXES.maths }),
    chemistry: Object.freeze({ element: ELEMENT_NAMES.chemistry, prefix: ID_PREFIXES.chemistry }),
});
// 官方 DOCTYPE 带空内部子集；BOM 为官方产出的文件头首三字节
const DOCTYPE = Object.freeze({ name: ELEMENT_NAMES.root, systemId: '/dtdandxsl/cn-application-body-20080416.dtd', internalSubset: '' });
const BOM = '\ufeff';
const STYLESHEET = Object.freeze({ target: 'xml-stylesheet', data: 'type="text/xsl" href="/dtdandxsl/showxml.xsl"' });
const ROOT_ATTRS = Object.freeze({ lang: 'zh', country: 'CN' });
const PART_BY_OPTION = Object.freeze({ claims: 'claims', description: 'description', drawings: 'drawings', abstract: 'abstract', 'abstract-figure': 'abstractFigure' });
const PART_LABELS = Object.freeze({ claims: '权利要求书', description: '说明书', drawings: '说明书附图', abstract: '说明书摘要', abstractFigure: '摘要附图' });
const PRECHECK_FILE = 'precheck.json';
const NAME_TOKEN = '{name}';
const HEADING_LEVEL = '2';
const CLAIM_ID_WIDTH = 3;
const NUM_WIDTH = 4;
const VALIDATION_ENGINE = 'libxml2-wasm';
const CELL_SEPARATOR = ' | ';
const FORMULA_PREVIEW = 30;

function analyze(doc, options) {
    const ir = doc && doc.ir && typeof doc.ir === 'object' ? doc.ir : { type: 'root', children: [] };
    const detected = detectSections(flattenBlocks(ir), { sectionDetection: options.xml.patent.sectionDetection, meta: doc.meta || {} });
    return { ...detected, annotatedIr: annotate(ir, detected.assignments) };
}

async function render(doc, options) {
    const analysis = analyze(doc, options);
    const issues = [...analysis.issues];
    issues.push(...precheck(doc, { profile: 'patent', sections: analysis.books }).items);
    const registry = createAssetRegistry(doc.assets);

    const emitted = emitBooks(analysis, { options, registry, issues });
    const selected = selectParts(emitted, options.xml.patent.parts, issues);
    for (const name of registry.unused()) {
        issues.push(createIssue(ISSUE_CODES.FIGURE_UNUSED_ASSET, `图片 ${name} 未被任何部分引用，已省略`, { location: name }));
    }
    const validation = options.xml.validate ? await validateAll(selected, issues) : { requested: false, engine: null, files: [] };

    // 只落盘已输出各书的图片：未输出的书不留下只有图片、没有 XML 的目录
    const assets = registry.list(selected.map(([key]) => BOOK_CODES[key]));
    const files = Object.fromEntries(selected.map(([key, xml]) => [FILE_NAMES[key], xml]));
    files[`${NAME_TOKEN}.zip`] = await buildZip(selected, assets);
    files[PRECHECK_FILE] = JSON.stringify(precheckReport(doc, issues, validation), null, 2);
    return {
        files, assets, extras: [], warnings: issues.map((issue) => issue.message), omitDocAssets: true, issues, analysis,
        // 结果信封的 title 取发明名称（缺失时由调度器沿用解析阶段的标题）
        title: analysis.inventionTitle ? analysis.inventionTitle.text : undefined,
    };
}

// ============================================================
// 五书组装
// ============================================================

// 各书的 id 计数器与图片序号计数器相互独立，输出的先后只决定问题项的排列顺序（沿用既有顺序：附图在前）
function emitBooks(analysis, deps) {
    const { books, inventionTitle } = analysis;
    const out = {};
    out.drawings = emitDrawings(books.drawings, createFileContext(deps, 'drawings'));
    out.abstractFigure = emitAbstractFigure(books.abstractFigure, createFileContext(deps, 'abstractFigure'));
    // 正文三书先把大图拆段拆出的同组相邻块并回（见文件头「大图拆段的并回」）；两本附图书维持拆开
    out.claims = emitClaims(mergeSplitGroups(books.claims), createFileContext(deps, 'claims'));
    out.description = emitDescription(mergeSplitGroups(books.description), createFileContext(deps, 'description'), inventionTitle);
    out.abstract = emitAbstract(mergeSplitGroups(books.abstract), createFileContext(deps, 'abstract'));
    return Object.fromEntries(BOOK_KEYS.map((key) => [key, out[key] ? wrapDocument(out[key], deps.options) : null]));
}

// assets 为该书专属的图片登记视图：文件名 <表格代码>_<序号>.<扩展名>，序号在书内独立计数
function createFileContext({ options, registry, issues }, key) {
    const ids = createIdFactory();
    return {
        el, ids, issues, temp: createTempNumbering(ids), assets: registry.forBook(BOOK_CODES[key]),
        dpi: options.xml.patent.imageDpi, numbering: options.xml.numbering,
    };
}

function wrapDocument(bookNode, options) {
    const root = el(ELEMENT_NAMES.root, ROOT_ATTRS, [bookNode]);
    return BOM + serializeDocument({ root, doctype: DOCTYPE, instructions: [STYLESHEET], indent: options.xml.indent, ...XML_STYLE });
}

function selectParts(emitted, parts, issues) {
    if (parts === 'auto') return BOOK_KEYS.filter((key) => emitted[key]).map((key) => [key, emitted[key]]);
    const selected = [];
    for (const part of parts) {
        const key = PART_BY_OPTION[part];
        if (emitted[key]) selected.push([key, emitted[key]]);
        else issues.push(createIssue(ISSUE_CODES.PART_MISSING, `已指定输出${PART_LABELS[key]}，但文档中未识别到该部分内容`));
    }
    return selected;
}

// ---------- 权利要求书 ----------

function emitClaims(blocks, ctx) {
    let { preface, claims } = buildClaims(blocks, { issues: ctx.issues });
    if (claims.length === 0 && preface.some((block) => block.kind === 'paragraph')) {
        ctx.issues.push(createIssue(ISSUE_CODES.CLAIM_NONE, `权利要求书中未识别到编号权项，已按段落顺序编为权项 1–${preface.length}`));
        claims = preface.map((block, index) => ({ num: index + 1, id: `${ID_PREFIXES.claim}${padNumber(index + 1, CLAIM_ID_WIDTH)}`, parts: [{ runs: block.kind === 'paragraph' ? block.runs : null, block }] }));
        preface = [];
    }
    if (claims.length === 0) return null;
    const children = preface.flatMap((block) => emitBlock(block, ctx, { numbering: ctx.temp, stripNumbers: false }));
    for (const claim of claims) {
        const texts = claim.parts.flatMap((part) => emitClaimPart(part, ctx));
        children.push(el(ELEMENT_NAMES.claim, { id: claim.id, num: String(claim.num) }, texts.length > 0 ? texts : [el(ELEMENT_NAMES.claimText)]));
    }
    return el(ELEMENT_NAMES.claims, {}, children);
}

// 官方不生成 claim-ref：「根据权利要求1所述的…」原样留在 claim-text 内。
// 只含图片的段（化学结构式、公式图）→ 一个 claim-text，内含各图的 img（DTD 的 claim-text 允许 img / chemistry /
// maths / tables）；未栅格化的表格 / 块级公式降级为逐行文本
function emitClaimPart(part, ctx) {
    const runsList = part.runs ? [part.runs] : claimBlockRuns(part.block, ctx);
    return runsList.map((runs) => el(ELEMENT_NAMES.claimText, {}, emitInline(runs, ctx))).filter((node) => node.children.length > 0);
}

const claimBlockRuns = (block, ctx) => (block.kind === 'image' ? [imageRuns(block)] : degradedRuns(block, ctx));

// ---------- 说明书 ----------

function emitDescription(blocks, ctx, inventionTitle) {
    const numbering = createParagraphNumbering({ ...ctx.numbering, issues: ctx.issues });
    const children = inventionTitle ? [el(ELEMENT_NAMES.inventionTitle, {}, [inventionTitle.text])] : [];
    for (const block of blocks) {
        if (block.role === 'heading') {
            children.push(el(ELEMENT_NAMES.heading, { id: ctx.ids.next(ID_PREFIXES.heading).id, level: HEADING_LEVEL }, [block.headingText || block.text]));
            continue;
        }
        children.push(...emitBlock(block, ctx, { numbering, stripNumbers: true, imageNotice: PART_LABELS.description }));
    }
    return children.some((node) => node.name === ELEMENT_NAMES.paragraph) ? el(ELEMENT_NAMES.description, {}, children) : null;
}

// ---------- 说明书摘要与摘要附图 ----------

// 摘要内的图片段已由分节模块移入摘要附图；此处只剩文本段（段号独立从 1 计，预览不显示）
function emitAbstract(blocks, ctx) {
    const numbering = createParagraphNumbering({ width: ctx.numbering.width, issues: ctx.issues });
    const children = blocks.flatMap((block) => emitBlock(block, ctx, { numbering, stripNumbers: true, imageNotice: PART_LABELS.abstract }));
    return children.length > 0 ? el(ELEMENT_NAMES.abstract, {}, children) : null;
}

function emitAbstractFigure(blocks, ctx) {
    if (blocks.length === 0) return null;
    const { children, count } = buildFigures(blocks, { ...ctx, labels: false, allowCaption: false, imgPrefix: ID_PREFIXES.abstractImg });
    if (count === 0) return null;
    if (count > 1) ctx.issues.push(createIssue(ISSUE_CODES.FIGURE_ABSTRACT_MULTIPLE, `摘要附图有 ${count} 幅，官方要求不超过 1 幅`));
    ctx.issues.push(createIssue(ISSUE_CODES.FIGURE_ABSTRACT_DEPRECATED, '已生成摘要附图；官方提示摘要附图不再单独接收，建议提交前删除'));
    return el(ELEMENT_NAMES.abstract, {}, [el(ELEMENT_NAMES.abstractFigure, {}, children)]);
}

// ---------- 说明书附图 ----------

function emitDrawings(blocks, ctx) {
    if (blocks.length === 0) return null;
    const { children, count } = buildFigures(blocks, { ...ctx, labels: true, allowCaption: true, imgPrefix: ID_PREFIXES.drawingImg });
    return count > 0 ? el(ELEMENT_NAMES.drawings, {}, children) : null;
}

// ============================================================
// 段落与行内
// ============================================================

// 块 → p 节点数组：表格 / 块级公式（未栅格化）降级为若干文本段；只含图片的段按段内 img 输出。
// settings.imageNotice 为所在书目的名称时，对只含图片的段逐图提示（说明书、摘要里它可能是误放的附图）；
// 缺省不提示（权利要求书里的图片属正常内容）
function emitBlock(block, ctx, settings) {
    if (block.kind === 'paragraph') {
        const node = emitParagraph(block.runs, ctx, settings);
        return node ? [node] : [];
    }
    if (block.kind === 'image') {
        if (settings.imageNotice) noticeBodyImages(block, ctx, settings.imageNotice);
        const node = emitParagraph(imageRuns(block), ctx, { ...settings, stripNumbers: false });
        return node ? [node] : [];
    }
    return degradedRuns(block, ctx).map((runs) => emitParagraph(runs, ctx, settings)).filter(Boolean);
}

const imageRuns = (block) => block.images.map((image) => ({ kind: 'image', node: image }));

// 带角色的图片（化学式）不提示：它在正文里输出为 chemistry 元素，本就是正文内容，不是误放的附图
function noticeBodyImages(block, ctx, bookLabel) {
    for (const image of block.images) {
        if (wrapperOf(image)) continue;
        ctx.issues.push(createIssue(ISSUE_CODES.FIGURE_INLINE_IMAGE,
            `${bookLabel}正文含图片 ${assetNameOf(image) || '（无地址）'}，已作为段内图片输出；如为附图，请移至说明书附图部分`));
    }
}

// 未栅格化的表格 / 块级公式 → 文本 runs（每行一段）
function degradedRuns(block, ctx) {
    if (block.kind === 'table') {
        ctx.issues.push(createIssue(ISSUE_CODES.RASTER_UNAVAILABLE, `表格未栅格化（栅格化后端不可用或已关闭），已降级为 ${block.rows.length} 行文本`));
        return block.rows.map((row) => [textRun(row.join(CELL_SEPARATOR), [])]).filter((runs) => runs[0].text.trim() !== '');
    }
    if (block.kind === 'math') {
        const text = mathToText(block.node);
        ctx.issues.push(createIssue(ISSUE_CODES.RASTER_UNAVAILABLE, `公式“${preview(text)}”未栅格化，已降级为线性化文本`));
        return text ? [[textRun(text, [])]] : [];
    }
    if (block.kind === 'heading' || block.kind === 'paragraph') return [block.runs];
    return [];
}

// 官方不生成 figref：正文「如图4所示」原样保留为文本
function emitParagraph(inputRuns, ctx, { numbering, stripNumbers }) {
    let runs = inputRuns;
    const italic = isWholeMark(runs, 'i');
    if (italic) runs = withoutMark(runs, 'i');
    let explicit = null;
    if (stripNumbers) {
        const stripped = stripParagraphNumber(runs);
        explicit = stripped.number;
        runs = stripped.runs;
    }
    const children = emitInline(runs, ctx);
    if (children.length === 0) return null;
    const { id, num } = numbering.next(explicit);
    return el(ELEMENT_NAMES.paragraph, { id, num, Italic: italic ? '1' : '0' }, children);
}

function emitInline(runs, ctx) {
    return emitRuns(runs, el, {
        image: (node) => emitImage(node, ctx),
        math: (node) => degradeInlineMath(node, ctx),
    });
}

// 带角色的图片按 ROLE_WRAPPERS 包成 tables / maths / chemistry（仅含 img，不写 chem）；其余图片为段内 img。
// 说明书正文与权利要求内的图（含行内公式）官方一律写 inline="no"，id 前缀为 idf。
function emitImage(node, ctx) {
    const resolved = ctx.assets.use(assetNameOf(node));
    if (!resolved) {
        ctx.issues.push(createIssue(ISSUE_CODES.FIGURE_MISSING_ASSET, `图片 ${assetNameOf(node) || '（无地址）'} 没有本地文件，已略过`));
        return null;
    }
    const img = buildImg(ctx, { ...resolved, node, prefix: ID_PREFIXES.bodyImg, inline: false });
    const wrapper = wrapperOf(node);
    if (!wrapper) return img;
    const seq = ctx.ids.next(wrapper.prefix);
    return el(wrapper.element, { id: seq.id, num: padNumber(seq.index, NUM_WIDTH) }, [img]);
}

// image 节点的角色 → ROLE_WRAPPERS 条目；无角色或角色不在表内时为 null
function wrapperOf(node) {
    const role = node && node.data && node.data.role;
    return typeof role === 'string' && Object.hasOwn(ROLE_WRAPPERS, role) ? ROLE_WRAPPERS[role] : null;
}

function degradeInlineMath(node, ctx) {
    const text = mathToText(node);
    ctx.issues.push(createIssue(ISSUE_CODES.RASTER_UNAVAILABLE, `公式“${preview(text)}”未栅格化，已降级为线性化文本`));
    return text;
}

const preview = (text) => (text.length > FORMULA_PREVIEW ? `${text.slice(0, FORMULA_PREVIEW)}…` : text);

// ============================================================
// 校验、打包与报告
// ============================================================

// 逐份校验；返回 precheck.json 的 validation 记录（校验器不可用时 engine 为 null、files 为空）。
// 记录里的 file 为相对路径（100001/100001.xml）；问题项文案另冠书目名，免得只见表格代码不知是哪一书
async function validateAll(selected, issues) {
    const files = [];
    for (const [key, xml] of selected) {
        const file = FILE_NAMES[key];
        const result = await validateXml(xml);
        issues.push(...describeValidation(`${PART_LABELS[key]} ${file}`, result, { requireDtd: true }));
        if (!result.available) return { requested: true, engine: null, files: [] };
        files.push({
            file, valid: result.valid,
            errors: result.errors.map(({ line, message }) => ({ line, message })),
            warnings: result.warnings.map(({ line, message }) => `第 ${line} 行：${message}`),
        });
    }
    return { requested: true, engine: VALIDATION_ENGINE, files };
}

// 条目与落盘的相对路径逐一相同；每书先 XML 后图片（条目规则见 ZIP_ENTRY_OPTIONS）
async function buildZip(selected, assets) {
    const zip = new JSZip();
    for (const [key, xml] of selected) {
        zip.file(FILE_NAMES[key], xml, ZIP_ENTRY_OPTIONS);
        const dirPrefix = `${BOOK_CODES[key]}/`;
        for (const asset of assets.filter((item) => item.name.startsWith(dirPrefix))) zip.file(asset.name, asset.buffer, ZIP_ENTRY_OPTIONS);
    }
    return zip.generateAsync(ZIP_OPTIONS);
}

function precheckReport(doc, issues, validation) {
    const meta = doc.meta || {};
    return {
        profile: 'patent',
        generatedAt: new Date().toISOString(),
        source: typeof meta.sourcePath === 'string' && meta.sourcePath ? meta.sourcePath : null,
        blocking: issues.filter((issue) => issue.level === LEVELS.BLOCKING).map((issue) => issue.message),
        warnings: issues.filter((issue) => issue.level === LEVELS.WARNING).map((issue) => issue.message),
        items: issues.map((issue) => ({ ...issue })),
        validation,
    };
}

// 顶层节点写回识别结果 data.patent = { book, role }（返回新树，不改动入参）
function annotate(ir, assignments) {
    const children = (ir.children || []).map((node) => (assignments.has(node)
        ? { ...node, data: { ...(node.data || {}), patent: assignments.get(node) } }
        : node));
    return { ...ir, children };
}

module.exports = {
    render, analyze, BOOK_CODES, FILE_NAMES, FILE_REF_STYLE, ELEMENT_NAMES, ID_PREFIXES, DOCTYPE, STYLESHEET, ROOT_ATTRS, PRECHECK_FILE,
};
