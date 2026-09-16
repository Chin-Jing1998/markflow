/**
 * 表格 / 公式节点栅格化：把 IR 中的 table / math 节点渲染为 JPG 图片节点
 *
 * 契约：rasterizeNodes(doc, { kinds, options }) → Promise<{ doc, rasterized, warnings, backend }>
 *   - kinds       要栅格的节点类型子集，取值 'table' | 'math'；由 index.js 按 options 推导：
 *                 options.math === 'image' → 含 'math'；xml.profile === 'patent'（且目标为 xml 或未指定）
 *                 → 按 xml.patent.rasterizeTables / rasterizeFormulas 追加 'table' / 'math'
 *   - options     normalizeOptions 归一后的选项：patent profile 取 xml.patent.imageDpi（默认 300）出图且不缩放；
 *                 其它 profile 按 raster.scale 提升出图密度（dpi = 96 × scale）并按 raster.maxWidth 限宽；
 *                 JPEG 文件统一按 options.jpegPpi（默认 330 PPI）写入 JFIF 密度
 *   - doc         处理后的文档（不修改入参，只在改动路径上新建节点）：命中节点替换为 image 节点
 *                 { type:'image', url:'images/<file>', alt, title:null,
 *                   data:{ assetName:'images/<file>', role:'table'|'formula', inline, width, height, dpi } }
 *                 并追加 assets（{ name, buffer, mime:'image/jpeg' }，名称与既有资源不冲突）
 *   - rasterized  被替换的节点数
 *   - backend     实际调用的栅格后端名（raster/backend.js 的 detect().name）；无可用后端时为 null
 *   - warnings    中文提示（string[]）：不抛出业务错误。后端不可用或单任务失败时该节点降级——
 *                 table → 每行一个 paragraph（单元格文本以「 | 」拼接），math → 线性化文本（段内为 text 节点，
 *                 独立成块为 degradeMath 产出的 paragraph）
 *
 * 命名：table-<序>.jpg（序为文档内表格顺序，1 起）；omath-<段>-<序>.jpg（段 = 含该公式的段落在全文段落序列
 *   中的 1 起序号，段落序列按先序遍历计 paragraph / heading / table——整张表计一个段号，无论其是否被栅格，
 *   故编号不随 kinds 变化；序 = 段内公式序号）。独立成块的 display 公式自身占一个段号，序为 1。
 *   alt：表格为「表格 N」，公式为线性化文本。
 * inline：行内公式（位于段落内且 display 为假）为 true，其余为 false。
 *
 * 片段页由 raster/fragment.js 构造，出图由 raster/backend.js 负责；PNG 经 jimp 铺白转 JPG 并写入 jpegPpi 指定的 JFIF 密度。
 * converters/index.js 仅在 kinds 非空时经 moduleLoader 懒加载并调用本模块；本模块顶层不 require electron
 * 或其它重依赖（jimp 经 assets/jimp-loader.js 动态加载）。
 */
const { errText } = require('../util');
const { createParagraph, createText, degradeMath, mathToText } = require('../ir/schema');
const { collectText } = require('../ir/util');
const { loadJimp } = require('../assets/jimp-loader');
const { setJpegDensity } = require('../assets/image-normalize');
const { buildTableFragment, buildMathFragment } = require('./fragment');

const KIND_TABLE = 'table';
const KIND_MATH = 'math';
const SUPPORTED_KINDS = new Set([KIND_TABLE, KIND_MATH]);
const ROLE_BY_KIND = { [KIND_TABLE]: 'table', [KIND_MATH]: 'formula' };
const IMAGES_PREFIX = 'images/';
const JPEG_EXT = '.jpg';
const JPEG_MIME = 'image/jpeg';
const CSS_DPI = 96;
const DEFAULT_DPI = 300;
const DEFAULT_SCALE = 2;
const DEFAULT_MAX_WIDTH = 1600;
const DEFAULT_QUALITY = 90;
const DEFAULT_PPI = 330;
const WHITE = 0xffffffff;
/** 段落序列的计数容器：公式的「段」号取最近的这类祖先（table 整张计一个段号） */
const PARAGRAPH_LIKE = new Set(['paragraph', 'heading', KIND_TABLE]);
const CELL_SEPARATOR = ' | ';

async function rasterizeNodes(doc, { kinds = [], options } = {}) {
    const wanted = new Set((Array.isArray(kinds) ? kinds : []).filter((kind) => SUPPORTED_KINDS.has(kind)));
    if (!doc || typeof doc !== 'object' || !doc.ir || wanted.size === 0) {
        return { doc, rasterized: 0, warnings: [], backend: null };
    }
    const targets = collectTargets(doc.ir, wanted);
    if (targets.length === 0) return { doc, rasterized: 0, warnings: [], backend: null };

    const settings = readSettings(options);
    const warnings = [];
    const backend = require('./backend');
    const detected = await backend.detect();
    if (!detected.available) {
        warnings.push(`栅格化后端不可用：${detected.hint}${degradeSummary(targets)}`);
        return { doc: applyReplacements(doc, degradeAll(targets), []), rasterized: 0, warnings, backend: null };
    }

    let images;
    try {
        images = await backend.rasterize(targets.map((target) => ({ id: target.id, html: buildFragment(target) })), { dpi: settings.renderDpi });
    } catch (err) {
        warnings.push(`栅格化失败：${errText(err)}${degradeSummary(targets)}`);
        return { doc: applyReplacements(doc, degradeAll(targets), []), rasterized: 0, warnings, backend: detected.name };
    }

    const taken = new Set((Array.isArray(doc.assets) ? doc.assets : []).map((asset) => asset && asset.name));
    const replacements = new Map();
    const assets = [];
    for (const target of targets) {
        const png = images.get(target.id);
        const outcome = Buffer.isBuffer(png)
            ? await encodeJpeg(png, settings).catch((err) => ({ error: `JPEG 编码失败（${errText(err)}）` }))
            : { error: png instanceof Error ? png.message : '后端未返回图像' };
        if (outcome.error) {
            warnings.push(`栅格化失败：${describe(target)}（${outcome.error}），${degradeText(target)}`);
            replacements.set(target.node, degradeNode(target));
            continue;
        }
        const name = uniqueName(`${IMAGES_PREFIX}${target.id}${JPEG_EXT}`, taken);
        taken.add(name);
        assets.push({ name, buffer: outcome.buffer, mime: JPEG_MIME });
        replacements.set(target.node, createImageNode(target, name, outcome));
    }
    return { doc: applyReplacements(doc, replacements, assets), rasterized: assets.length, warnings, backend: detected.name };
}

// ============================================================
// 命中节点收集
// ============================================================

/** 先序遍历：表格按文档顺序编号并占一个段号；公式按所在段落编号；被栅格的表格不再深入（其中公式随表格一起成图） */
function collectTargets(root, wanted) {
    const targets = [];
    let tableCount = 0;
    let paragraphCount = 0;
    const visit = (node, paragraph) => {
        if (Array.isArray(node)) { node.forEach((item) => visit(item, paragraph)); return; }
        if (!node || typeof node !== 'object') return;
        if (node.type === KIND_TABLE) {
            paragraphCount += 1;
            if (!wanted.has(KIND_TABLE)) { visit(node.children, { index: paragraphCount, mathCount: 0 }); return; }
            tableCount += 1;
            targets.push({ node, kind: KIND_TABLE, index: tableCount, id: `table-${tableCount}`, inline: false });
            return;
        }
        if (node.type === KIND_MATH) {
            if (!wanted.has(KIND_MATH)) return;
            const display = Boolean(node.data && node.data.display);
            if (paragraph) {
                paragraph.mathCount += 1;
                targets.push({ node, kind: KIND_MATH, id: `omath-${paragraph.index}-${paragraph.mathCount}`, inline: !display, display, inParagraph: true });
            } else {
                paragraphCount += 1;
                targets.push({ node, kind: KIND_MATH, id: `omath-${paragraphCount}-1`, inline: false, display, inParagraph: false });
            }
            return;
        }
        if (!Array.isArray(node.children)) return;
        if (PARAGRAPH_LIKE.has(node.type)) {
            paragraphCount += 1;
            visit(node.children, { index: paragraphCount, mathCount: 0 });
            return;
        }
        visit(node.children, paragraph);
    };
    visit(root, null);
    return targets;
}

const buildFragment = (target) => (target.kind === KIND_TABLE
    ? buildTableFragment(target.node)
    : buildMathFragment(target.node, { display: target.display }));

// ============================================================
// 选项与编码
// ============================================================

// 选项由 converters/options.js 归一并深冻结，此处仅做缺省兜底
function readSettings(options) {
    const source = options && typeof options === 'object' ? options : {};
    const xml = source.xml || {};
    const patent = xml.patent || {};
    const raster = source.raster || {};
    const isPatent = xml.profile === 'patent';
    return {
        quality: numberOr(source.jpegQuality, DEFAULT_QUALITY),
        ppi: numberOr(source.jpegPpi, DEFAULT_PPI),
        renderDpi: isPatent ? numberOr(patent.imageDpi, DEFAULT_DPI) : CSS_DPI * numberOr(raster.scale, DEFAULT_SCALE),
        // patent profile 下禁用缩放：专利图片的 wi/he 由原始像素与 DPI 换算
        maxWidth: isPatent ? 0 : numberOr(raster.maxWidth, DEFAULT_MAX_WIDTH),
    };
}

const numberOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/** PNG → 白底合成 → 按 maxWidth 限宽 → JPEG → 写入指定 PPI 的 JFIF 密度 */
async function encodeJpeg(png, settings) {
    const { Jimp } = await loadJimp();
    const image = await Jimp.read(png);
    const flat = new Jimp({ width: image.width, height: image.height, color: WHITE });
    flat.composite(image, 0, 0);
    if (settings.maxWidth > 0 && flat.width > settings.maxWidth) {
        flat.resize({ w: settings.maxWidth });
    }
    const density = Math.max(1, Math.round(settings.ppi));
    const buffer = setJpegDensity(await flat.getBuffer(JPEG_MIME, { quality: settings.quality }), density);
    return { buffer, width: flat.width, height: flat.height, dpi: density };
}

// ============================================================
// 替换与降级
// ============================================================

function createImageNode(target, name, { width, height, dpi }) {
    const alt = target.kind === KIND_TABLE ? `表格 ${target.index}` : (mathToText(target.node) || '公式');
    return {
        type: 'image',
        url: name,
        alt,
        title: null,
        data: { assetName: name, role: ROLE_BY_KIND[target.kind], inline: target.inline, width, height, dpi },
    };
}

/** table → 逐行段落（空表格移除）；math → 线性化文本（段内为 text 节点，独立成块为 paragraph） */
function degradeNode(target) {
    if (target.kind === KIND_MATH) return target.inParagraph ? createText(mathToText(target.node)) : degradeMath(target.node);
    const rows = Array.isArray(target.node.children) ? target.node.children.filter((row) => row && row.type === 'tableRow') : [];
    return rows
        .map((row) => (Array.isArray(row.children) ? row.children : []).map((cell) => collectText(cell).trim()).join(CELL_SEPARATOR))
        .filter((line) => line.trim() !== '')
        .map((line) => createParagraph([createText(line)]));
}

function degradeAll(targets) {
    return new Map(targets.map((target) => [target.node, degradeNode(target)]));
}

const describe = (target) => (target.kind === KIND_TABLE ? `表格 ${target.id}` : `公式 ${target.id}`);
const degradeText = (target) => (target.kind === KIND_TABLE ? '已降级为逐行文本' : '已降级为线性化文本');

function degradeSummary(targets) {
    const tables = targets.filter((target) => target.kind === KIND_TABLE).length;
    const maths = targets.length - tables;
    const parts = [];
    if (tables > 0) parts.push(`${tables} 个表格降级为逐行文本`);
    if (maths > 0) parts.push(`${maths} 个公式降级为线性化文本`);
    return parts.length > 0 ? `；已将 ${parts.join('、')}` : '';
}

/** 资源名去重：images/table-1.jpg 已存在时依次尝试 images/table-1-2.jpg、-3… */
function uniqueName(base, taken) {
    if (!taken.has(base)) return base;
    const stem = base.slice(0, base.length - JPEG_EXT.length);
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${stem}-${suffix}${JPEG_EXT}`;
        if (!taken.has(candidate)) return candidate;
    }
}

function applyReplacements(doc, replacements, assets) {
    const ir = replacements.size > 0 ? rewrite(doc.ir, replacements) : doc.ir;
    if (ir === doc.ir && assets.length === 0) return doc;
    const existing = Array.isArray(doc.assets) ? doc.assets : [];
    return { ...doc, ir, assets: assets.length > 0 ? [...existing, ...assets] : existing };
}

/** 只在子树确有改动时新建节点；替换值可为单节点或节点数组（数组在父级 children 中展开） */
function rewrite(node, replacements) {
    if (Array.isArray(node)) return rewriteList(node, replacements);
    if (!node || typeof node !== 'object') return node;
    if (replacements.has(node)) return replacements.get(node);
    if (!Array.isArray(node.children)) return node;
    const children = rewriteList(node.children, replacements);
    return children === node.children ? node : { ...node, children };
}

function rewriteList(list, replacements) {
    let changed = false;
    const out = [];
    for (const item of list) {
        const next = rewrite(item, replacements);
        if (next !== item) changed = true;
        if (Array.isArray(next)) out.push(...next);
        else out.push(next);
    }
    return changed ? out : list;
}

module.exports = { rasterizeNodes };
