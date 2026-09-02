/**
 * DOCX → IR
 *
 * 流程：mammoth（docx → HTML，图片经 convertImage 截获为 Buffer）
 *       → turndown('word')（HTML → Markdown）
 *       → remark-parse + remark-gfm（Markdown → mdast）
 *
 * 契约：
 *   - async parse({ path } | { buffer }, ctx) → MarkFlowDocument{ ir, assets, warnings, meta }
 *   - 不写盘、不打印：mammoth 警告与图片读取失败一律推入 warnings
 *   - 图片按出现顺序编号为 images/image_N.ext（N 从 1 起），IR 中 image 节点 url 与 assets 一一对应
 *   - 标题取首个 <h1> 文本，否则取去扩展名的文件名
 */
const path = require('path');
const mammoth = require('mammoth');
const { loadUnified } = require('../ir/unified-loader');
const { createDocument } = require('../ir/schema');
const { createTurndownService } = require('../ir/turndown');
const util = require('../ir/util');

const DEFAULT_SOURCE_NAME = '未命名.docx';
const DEFAULT_IMAGE_MIME = 'image/png';
// 残留在 HTML 里的 base64 内嵌图片（正常情况下 convertImage 已截获全部图片，此处兜底）
const INLINE_BASE64_IMG_RE = /<img\b[^>]*?\bsrc="data:image\/([a-z0-9.+-]+);base64,([^"]*)"[^>]*>/gi;
// 游离在标签之外的 base64 图片文本
const STRAY_BASE64_RE = /data:image\/[^;]+;base64,[A-Za-z0-9+/=]{50,}/g;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
const HTML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

// util.stripExt 由核心执行者提供；落地前用内联实现兜底
const stripExt = typeof util.stripExt === 'function'
    ? util.stripExt
    : (name) => path.basename(String(name || ''), path.extname(String(name || '')));

// ============================================================
// 对外入口
// ============================================================

/**
 * @param {{ path?: string, buffer?: Buffer }} input
 * @param {{ sourceName?: string, onProgress?: (phase: string, pct: number) => void }} ctx
 */
async function parse(input, ctx = {}) {
    const source = resolveSource(input);
    const sourceName = ctx.sourceName || (source.path ? path.basename(source.path) : DEFAULT_SOURCE_NAME);
    const assets = [];
    const warnings = [];

    notify(ctx, 'parsing', 20);
    const rawHtml = await convertWithMammoth(source, assets, warnings);
    const html = collectInlineBase64Images(rawHtml, assets, warnings);
    notify(ctx, 'assets', 60);

    const title = extractTitle(html) || stripExt(sourceName);
    const markdown = cleanupMarkdown(createTurndownService('word').turndown(html));

    const { unified, remarkParse, remarkGfm } = await loadUnified();
    const ir = unified().use(remarkParse).use(remarkGfm).parse(markdown);
    notify(ctx, 'ir', 90);

    const doc = createDocument({
        kind: 'document',
        ir,
        data: null,
        meta: { title, sourceType: 'docx', sourceName },
        assets,
        warnings,
    });
    // createDocument 扩展签名落地前不透传 assets/warnings，此处补齐（扩展后本赋值幂等）
    doc.assets = assets;
    doc.warnings = warnings;
    return doc;
}

// ============================================================
// 输入解析
// ============================================================

function resolveSource(input) {
    if (input && typeof input.path === 'string' && input.path) {
        return { path: path.resolve(input.path) };
    }
    if (input && Buffer.isBuffer(input.buffer)) {
        return { buffer: input.buffer };
    }
    throw new Error('parsers/docx 需要 input.path（.docx 文件路径）或 input.buffer');
}

// ============================================================
// mammoth 转换
// ============================================================

async function convertWithMammoth(source, assets, warnings) {
    const options = {
        convertImage: mammoth.images.imgElement(async (image) => {
            let buffer;
            try {
                buffer = await image.readAsBuffer();
            } catch (err) {
                warnings.push(`图片读取失败，已跳过（${errText(err)}）`);
                return { src: '' };
            }
            if (!buffer || buffer.length === 0) {
                warnings.push('遇到空图片，已跳过');
                return { src: '' };
            }
            return { src: pushAsset(assets, buffer, image.contentType) };
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
    const name = `images/image_${assets.length + 1}${util.getExtFromContentType(mime)}`;
    assets.push({ name, buffer, mime });
    return name;
}

function normalizeMime(contentType) {
    const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (!mime) return DEFAULT_IMAGE_MIME;
    return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

// ============================================================
// HTML 后处理
// ============================================================

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
    return decodeEntities(matched[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(text) {
    return text.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => HTML_ENTITIES[entity] || entity);
}

// ============================================================
// Markdown 清理（源自 旧版 word.js:101-110）
// 注：legacy 还会删除任意 100 字符以上的 [A-Za-z0-9+/=] 连续串以清理 base64 残留；
//     本实现已在 HTML 阶段精确收编全部内嵌图片，该规则会误删正文长串，故不再沿用。
// ============================================================

function cleanupMarkdown(markdown) {
    return String(markdown || '')
        .replace(/!\[[^\]]*\]\(data:image\/[^)]+\)/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ============================================================
// 工具
// ============================================================

function notify(ctx, phase, pct) {
    if (!ctx || typeof ctx.onProgress !== 'function') return;
    try {
        ctx.onProgress(phase, pct);
    } catch (err) {
        // 调用方回调自身的异常不影响解析
    }
}

function errText(err) {
    return (err && err.message) ? err.message : String(err);
}

module.exports = { parse };
