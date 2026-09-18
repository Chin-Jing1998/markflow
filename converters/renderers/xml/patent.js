/**
 * xml 目标 patent profile：国知局专利五书（cn-application-body-20080416.dtd）
 *
 * analyze(doc, options) → { books, inventionTitle, issues, assignments, annotatedIr }   纯分类，供桌面端预览复用
 * render(doc, options)  → { files, assets, extras: [], warnings, omitDocAssets: true, issues, analysis, title? }
 *   files：五书分文件（FILE_NAMES，parts 为 auto 时只输出识别到的部分）+ {name}.zip（五书 + 图片的同一平铺集合）
 *          + precheck.json（问题项清单与 validation 记录 { requested, engine, files }，不入 zip）；
 *   title：发明名称文本，调度器据此覆盖结果信封的 title；
 *   assets：图片一律改为裸文件名平铺在 {name}/ 根下（FILE_REF_STYLE 'bare'，官方案卷包内 XML 与图片同目录、
 *          无任何子目录，见研究报告 §4.4），故 omitDocAssets 为 true，调度器不再合并 doc.assets。
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
 * 表格 / 公式：栅格化后的 image 节点（data.role 'table' | 'formula'）→ <tables>/<maths> 内仅含 img；
 *   仍为 table / math 节点的（栅格化未就绪或已关闭）降级为逐行文本 / 线性化文本并记「栅格化：」问题项。
 * options.xml.validate 为 true 时逐份调 validateXml，错误以「DTD 校验：」问题项进 warnings 与 precheck.json。
 */
const JSZip = require('jszip');
const { el, serializeDocument } = require('./builder');
const { flattenBlocks } = require('./blocks');
const { detectSections, BOOK_KEYS } = require('./sections');
const { buildClaims } = require('./claims');
const { buildFigures, buildImg, assetNameOf } = require('./figures');
const { createIdFactory, createParagraphNumbering, createTempNumbering, stripParagraphNumber, padNumber } = require('./numbering');
const { createAssetRegistry } = require('./assets');
const { precheck, createIssue, ISSUE_CODES, LEVELS } = require('./precheck');
const { validateXml, describeValidation } = require('./validate');
const { emitRuns, isWholeMark, withoutMark, textRun } = require('./inline');
const { mathToText } = require('../../ir/schema');

const FILE_NAMES = Object.freeze({
    claims: 'claims.xml', description: 'description.xml', drawings: 'drawings.xml',
    abstract: 'abstract.xml', abstractFigure: 'abstract-figure.xml',
});
const FILE_REF_STYLE = 'bare';
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

    const assets = registry.list();
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

// 附图先于其它部分输出，使 drawing-N 的序号与附图顺序一致（各文件的 id 计数器相互独立）
function emitBooks(analysis, deps) {
    const { books, inventionTitle } = analysis;
    const out = {};
    out.drawings = emitDrawings(books.drawings, createFileContext(deps));
    out.abstractFigure = emitAbstractFigure(books.abstractFigure, createFileContext(deps));
    out.claims = emitClaims(books.claims, createFileContext(deps));
    out.description = emitDescription(books.description, createFileContext(deps), inventionTitle);
    out.abstract = emitAbstract(books.abstract, createFileContext(deps));
    return Object.fromEntries(BOOK_KEYS.map((key) => [key, out[key] ? wrapDocument(out[key], deps.options) : null]));
}

function createFileContext({ options, registry, issues }) {
    const ids = createIdFactory();
    return {
        el, ids, issues, temp: createTempNumbering(ids), assets: registry,
        dpi: options.xml.patent.imageDpi, numbering: options.xml.numbering,
    };
}

function wrapDocument(bookNode, options) {
    const root = el(ELEMENT_NAMES.root, ROOT_ATTRS, [bookNode]);
    return BOM + serializeDocument({ root, doctype: DOCTYPE, instructions: [STYLESHEET], indent: options.xml.indent });
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

// 官方不生成 claim-ref：「根据权利要求1所述的…」原样留在 claim-text 内
function emitClaimPart(part, ctx) {
    if (part.runs) {
        const kids = emitInline(part.runs, ctx);
        return kids.length > 0 ? [el(ELEMENT_NAMES.claimText, {}, kids)] : [];
    }
    return degradedRuns(part.block, ctx).map((runs) => el(ELEMENT_NAMES.claimText, {}, emitInline(runs, ctx))).filter((node) => node.children.length > 0);
}

// ---------- 说明书 ----------

function emitDescription(blocks, ctx, inventionTitle) {
    const numbering = createParagraphNumbering({ ...ctx.numbering, issues: ctx.issues });
    const children = inventionTitle ? [el(ELEMENT_NAMES.inventionTitle, {}, [inventionTitle.text])] : [];
    for (const block of blocks) {
        if (block.role === 'heading') {
            children.push(el(ELEMENT_NAMES.heading, { id: ctx.ids.next(ID_PREFIXES.heading).id, level: HEADING_LEVEL }, [block.headingText || block.text]));
            continue;
        }
        children.push(...emitBlock(block, ctx, { numbering, stripNumbers: true }));
    }
    return children.some((node) => node.name === ELEMENT_NAMES.paragraph) ? el(ELEMENT_NAMES.description, {}, children) : null;
}

// ---------- 说明书摘要与摘要附图 ----------

// 摘要内的图片段已由分节模块移入摘要附图；此处只剩文本段（段号独立从 1 计，预览不显示）
function emitAbstract(blocks, ctx) {
    const numbering = createParagraphNumbering({ width: ctx.numbering.width, issues: ctx.issues });
    const children = blocks.flatMap((block) => emitBlock(block, ctx, { numbering, stripNumbers: true }));
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

// 块 → p 节点数组：表格 / 块级公式（未栅格化）降级为若干文本段；段内图片按 img 输出
function emitBlock(block, ctx, settings) {
    if (block.kind === 'paragraph') {
        const node = emitParagraph(block.runs, ctx, settings);
        return node ? [node] : [];
    }
    if (block.kind === 'image') {
        block.images.forEach((image) => ctx.issues.push(createIssue(ISSUE_CODES.FIGURE_INLINE_IMAGE,
            `正文含图片 ${assetNameOf(image) || '（无地址）'}，已作为段内图片输出；附图请置于说明书附图部分`)));
        const runs = block.images.map((image) => ({ kind: 'image', node: image }));
        const node = emitParagraph(runs, ctx, { ...settings, stripNumbers: false });
        return node ? [node] : [];
    }
    return degradedRuns(block, ctx).map((runs) => emitParagraph(runs, ctx, settings)).filter(Boolean);
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

// 栅格化产物按角色包成 tables / maths（仅含 img）；其余图片为段内 img。
// 说明书正文内的图（含行内公式）官方一律写 inline="no"，id 前缀为 idf。
function emitImage(node, ctx) {
    const role = node.data && node.data.role;
    const resolved = ctx.assets.use(assetNameOf(node), { kind: 'inline' });
    if (!resolved) {
        ctx.issues.push(createIssue(ISSUE_CODES.FIGURE_MISSING_ASSET, `图片 ${assetNameOf(node) || '（无地址）'} 没有本地文件，已略过`));
        return null;
    }
    const img = buildImg(ctx, { ...resolved, node, prefix: ID_PREFIXES.bodyImg, inline: false });
    if (role === 'table') {
        const seq = ctx.ids.next(ID_PREFIXES.tables);
        return el(ELEMENT_NAMES.tables, { id: seq.id, num: padNumber(seq.index, NUM_WIDTH) }, [img]);
    }
    if (role === 'formula') {
        const seq = ctx.ids.next(ID_PREFIXES.maths);
        return el(ELEMENT_NAMES.maths, { id: seq.id, num: padNumber(seq.index, NUM_WIDTH) }, [img]);
    }
    return img;
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

// 逐份校验；返回 precheck.json 的 validation 记录（校验器不可用时 engine 为 null、files 为空）
async function validateAll(selected, issues) {
    const files = [];
    for (const [key, xml] of selected) {
        const file = FILE_NAMES[key];
        const result = await validateXml(xml);
        issues.push(...describeValidation(file, result, { requireDtd: true }));
        if (!result.available) return { requested: true, engine: null, files: [] };
        files.push({
            file, valid: result.valid,
            errors: result.errors.map(({ line, message }) => ({ line, message })),
            warnings: result.warnings.map(({ line, message }) => `第 ${line} 行：${message}`),
        });
    }
    return { requested: true, engine: VALIDATION_ENGINE, files };
}

async function buildZip(selected, assets) {
    const zip = new JSZip();
    for (const [key, xml] of selected) zip.file(FILE_NAMES[key], xml);
    for (const asset of assets) zip.file(asset.name, asset.buffer);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
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
    render, analyze, FILE_NAMES, FILE_REF_STYLE, ELEMENT_NAMES, ID_PREFIXES, DOCTYPE, STYLESHEET, ROOT_ATTRS, PRECHECK_FILE,
};
