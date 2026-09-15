/**
 * DOCX → IR
 *
 * 流程：读入 buffer → inspectOoxml（OOXML 预检信息）→ extractMath（OMML 换成哨兵 run）
 *       → prepareLayout（首行缩进、制表符、题注换成标记 run，图片 alt 前写序号并记下显示尺寸）
 *       → mammoth（docx → HTML，图片经 convertImage 截获为 Buffer，下划线经 styleMap 'u => u' 保留）
 *       → turndown('word')（HTML → Markdown）→ remark-parse + remark-gfm（Markdown → mdast）
 *       → restoreMath（哨兵换回 math 节点）→ liftInlineHtml（<u> 等 → 节点）→ applyDisplay（显示尺寸写回图片）
 *       → restoreMarkers（标记 → data.indent / data.role / \t）→ markCaptions（大图拆段、图注定角色）
 *
 * 契约：
 *   - async parse({ path } | { buffer }, ctx) → MarkFlowDocument{ ir, data, assets, warnings, meta }
 *   - 不写盘、不打印：mammoth 警告、图片读取失败、预检与公式抽取异常一律推入 warnings
 *   - 图片按出现顺序编号为 images/image_N.ext（N 从 1 起），IR 中 image 节点 url 与 assets 一一对应；
 *     取得到 wp:extent / VML 尺寸的图片带 data.display（px），浮动图另带 data.floating
 *   - 标题取首个 <h1> 文本，否则取去扩展名的文件名
 *   - data.ooxml 为 OOXML 预检信息（采集失败时为 null），meta.sourcePath 为源文件绝对路径
 *   - 公式一律进 IR 的 math 节点；options.math='text' 的降级由渲染器负责，解析层不降级
 *   - 段落文本本身不带全角缩进（由 md 渲染器按 data.indent 插入），专利 XML 等下游不受影响
 */
const path = require('path');
const fsp = require('fs/promises');
const mammoth = require('mammoth');
const { loadUnified } = require('../ir/unified-loader');
const { createDocument } = require('../ir/schema');
const { createTurndownService } = require('../ir/turndown');
const { liftInlineHtml } = require('../ir/inline-html');
const { restoreMarkers, stripMarkers } = require('../ir/markers');
const { markCaptions } = require('../ir/captions');
const { stripExt, getExtFromContentType } = require('../ir/util');
const { notify, errText } = require('../util');
const { inspectOoxml } = require('./docx-ooxml');
const { extractMath, restoreMath } = require('./docx-math');
const { prepareLayout, parseImageMarker } = require('./docx-layout');

const DEFAULT_SOURCE_NAME = '未命名.docx';
const DEFAULT_IMAGE_MIME = 'image/png';
// mammoth 默认丢弃下划线；映射为 <u> 后由 turndown 的 word profile 保留、ir/inline-html 提升为 underline
const STYLE_MAP = Object.freeze(['u => u']);
// 残留在 HTML 里的 base64 内嵌图片（正常情况下 convertImage 已截获全部图片，此处兜底）
const INLINE_BASE64_IMG_RE = /<img\b[^>]*?\bsrc="data:image\/([a-z0-9.+-]+);base64,([^"]*)"[^>]*>/gi;
// 游离在标签之外的 base64 图片文本
const STRAY_BASE64_RE = /data:image\/[^;]+;base64,[A-Za-z0-9+/=]{50,}/g;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
// 进度百分比：parser 只报 parsing 阶段，三个节点单调递增且不超过 55（其后由调度器接管）
const PROGRESS_READ = 20;
const PROGRESS_ASSETS = 40;
const PROGRESS_IR = 55;
const HTML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/**
 * @param {{ path?: string, buffer?: Buffer }} input
 * @param {{ sourceName?: string, onProgress?: (phase: string, pct: number) => void }} ctx
 */
async function parse(input, ctx = {}) {
    const source = resolveSource(input);
    const sourceName = ctx.sourceName || (source.path ? path.basename(source.path) : DEFAULT_SOURCE_NAME);
    const assets = [];
    const warnings = [];

    notify(ctx, 'parsing', PROGRESS_READ);
    const original = source.buffer || await fsp.readFile(source.path);
    const ooxml = await inspectSafely(original, warnings);
    const { buffer, formulas } = await extractSafely(original, warnings);
    const layout = await layoutSafely(buffer, warnings);

    const displayByAsset = new Map();
    const rawHtml = await convertWithMammoth({ buffer: layout.buffer }, { assets, warnings, displays: layout.displays, displayByAsset });
    const html = collectInlineBase64Images(rawHtml, assets, warnings);
    notify(ctx, 'parsing', PROGRESS_ASSETS);

    const title = stripMarkers(extractTitle(html)).trim() || stripExt(sourceName);
    const markdown = cleanupMarkdown(createTurndownService('word').turndown(html));

    const { unified, remarkParse, remarkGfm } = await loadUnified();
    const parsed = unified().use(remarkParse).use(remarkGfm).parse(markdown);
    const restored = restoreMath(parsed, formulas);
    warnings.push(...restored.warnings);
    const lifted = applyDisplay(liftInlineHtml(restored.ir, { source: 'docx' }), displayByAsset);
    const ir = markCaptions(restoreMarkers(lifted));
    notify(ctx, 'parsing', PROGRESS_IR);

    return createDocument({
        kind: 'document',
        ir,
        data: ooxml ? { ooxml } : null,
        meta: { title, sourceType: 'docx', sourceName, sourcePath: source.path || null },
        assets,
        warnings,
    });
}

// 预检信息采集失败不阻断解析，只记 warning
async function inspectSafely(buffer, warnings) {
    try {
        return await inspectOoxml(buffer);
    } catch (err) {
        warnings.push(`OOXML 预检信息采集失败，已跳过（${errText(err)}）`);
        return null;
    }
}

// 公式抽取失败时按无公式继续，交由 mammoth 决定后续成败
async function extractSafely(buffer, warnings) {
    try {
        return await extractMath(buffer);
    } catch (err) {
        warnings.push(`公式抽取失败，已按无公式处理（${errText(err)}）`);
        return { buffer, formulas: [] };
    }
}

// 版面预处理失败时按原样交给 mammoth：缩进、制表符与图片尺寸缺失，但正文不受影响
async function layoutSafely(buffer, warnings) {
    try {
        return await prepareLayout(buffer);
    } catch (err) {
        warnings.push(`版面信息（缩进、制表符、题注、图片尺寸）读取失败，已按原样转换（${errText(err)}）`);
        return { buffer, displays: new Map() };
    }
}

function resolveSource(input) {
    if (input && typeof input.path === 'string' && input.path) return { path: path.resolve(input.path) };
    if (input && Buffer.isBuffer(input.buffer)) return { buffer: input.buffer };
    throw new Error('parsers/docx 需要 input.path（.docx 文件路径）或 input.buffer');
}

// ---------- mammoth 转换 ----------

/**
 * 图片 alt 里的序号标记（docx-layout 写入）在此取出并还原原 alt，据此把显示尺寸登记到资产名上
 */
async function convertWithMammoth(source, { assets, warnings, displays, displayByAsset }) {
    const options = {
        styleMap: [...STYLE_MAP],
        convertImage: mammoth.images.imgElement(async (image) => {
            const { index, alt } = parseImageMarker(image.altText);
            let buffer;
            try {
                buffer = await image.readAsBuffer();
            } catch (err) {
                warnings.push(`图片读取失败，已跳过（${errText(err)}）`);
                return { src: '', alt };
            }
            if (!buffer || buffer.length === 0) {
                warnings.push('遇到空图片，已跳过');
                return { src: '', alt };
            }
            const name = pushAsset(assets, buffer, image.contentType);
            const display = index === null ? null : displays.get(index);
            if (display && display.width >= 1) displayByAsset.set(name, display);
            return { src: name, alt };
        }),
    };

    const result = await mammoth.convertToHtml(source, options);
    for (const message of result.messages || []) {
        warnings.push(`mammoth ${message.type || 'warning'}: ${message.message}`);
    }
    return result.value || '';
}

function pushAsset(assets, buffer, contentType) {
    const mime = normalizeMime(contentType);
    const name = `images/image_${assets.length + 1}${getExtFromContentType(mime)}`;
    assets.push({ name, buffer, mime });
    return name;
}

function normalizeMime(contentType) {
    const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (!mime) return DEFAULT_IMAGE_MIME;
    return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

// ---------- IR 后处理 ----------

// 资产名 → 显示尺寸，写回 image 节点的 data.display（px）；浮动图另记 data.floating。不改动入参
function applyDisplay(node, displayByAsset) {
    if (!node || typeof node !== 'object' || displayByAsset.size === 0) return node;
    if (node.type === 'image') {
        const size = displayByAsset.get(node.url);
        if (!size) return node;
        const display = { width: size.width };
        if (size.height >= 1) display.height = size.height;
        display.unit = 'px';
        display.source = 'docx';
        const data = { ...(node.data || {}), display };
        if (size.floating) data.floating = true;
        return { ...node, data };
    }
    if (!Array.isArray(node.children)) return node;
    const children = node.children.map((child) => applyDisplay(child, displayByAsset));
    return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
}

// ---------- HTML 后处理 ----------

// 把残留的 base64 内嵌图片收进 assets，并清掉游离的 base64 文本
function collectInlineBase64Images(html, assets, warnings) {
    return html
        .replace(INLINE_BASE64_IMG_RE, (tag, format, base64) => {
            const buffer = Buffer.from(base64, 'base64');
            if (buffer.length === 0) {
                warnings.push('遇到空的内嵌 base64 图片，已移除');
                return '';
            }
            const name = pushAsset(assets, buffer, `image/${format}`);
            return tag.replace(/\bsrc="[^"]*"/i, `src="${name}"`);
        })
        .replace(STRAY_BASE64_RE, '');
}

function extractTitle(html) {
    const matched = H1_RE.exec(html);
    if (!matched) return '';
    const text = matched[1].replace(/<[^>]+>/g, '')
        .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => HTML_ENTITIES[entity] || entity);
    return text.replace(/\s+/g, ' ').trim();
}

// Markdown 清理（源自 旧版 word.js:101-110）
// 注：legacy 还会删除任意 100 字符以上的 [A-Za-z0-9+/=] 连续串以清理 base64 残留；
//     本实现已在 HTML 阶段精确收编全部内嵌图片，该规则会误删正文长串，故不再沿用。
function cleanupMarkdown(markdown) {
    return String(markdown || '')
        .replace(/!\[[^\]]*\]\(data:image\/[^)]+\)/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

module.exports = { parse };
