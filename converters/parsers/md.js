/**
 * Markdown → IR
 *
 * 关键点：
 *   1) 按路径读取 utf8 文本，baseDir 取源文件所在目录，供图片相对路径解析；
 *   2) 挂载 remark-gfm —— 缺失它会导致表格、删除线、任务列表退化为原始字面量文本；
 *   3) 宽松标题预处理 —— 兼容 "#标题"（缺空格）与全角 "＃标题" 两种非标准写法；
 *   4) 解析后立即把图片解析为可内嵌资源，挂到 image 节点的 data.asset 上。
 */
const fsp = require('fs').promises;
const path = require('path');
const { loadUnified } = require('../ir/unified-loader');
const { createDocument } = require('../ir/schema');
const { resolveImages, collectImageNodes } = require('../assets/md-images');

// 行首 1-6 个井号（半角或全角），且后面不再跟井号 —— 即构成合法 ATX 标题前缀
const HEADING_PREFIX_RE = /^([#＃]{1,6})(?![#＃])/gm;
// 井号与标题文字之间缺空格
const HEADING_TIGHT_RE = /^(#{1,6})(?=[^#\s])/gm;

/**
 * @param {object|string} input { path } 绝对路径，或 { text } 文本；字符串按文本处理
 * @param {object} ctx { sourceName?, baseDir?, onProgress?, fetchRemote? }
 */
async function parse(input, ctx = {}) {
    const { text, absPath } = await readSource(input);

    const baseDir = absPath ? path.dirname(absPath) : (ctx.baseDir || process.cwd());
    const sourceName = ctx.sourceName || (absPath ? path.basename(absPath) : undefined);

    const { unified, remarkParse, remarkGfm } = await loadUnified();
    const ir = unified().use(remarkParse).use(remarkGfm).parse(preprocess(text));
    notify(ctx, 'parsing', 30);

    const title = extractTitle(ir) || stripExt(sourceName);

    const { resolved, warnings } = await resolveImages(ir, baseDir, {
        fetchRemote: ctx.fetchRemote,
    });
    notify(ctx, 'parsing', 55);

    // 已成功解析（可内嵌）的图片登记为 assets，供调度器统计 imagesCount；同一 url 只登记一次
    const seen = new Set();
    const assets = collectImageNodes(ir)
        .filter((node) => node.data && node.data.asset && node.data.asset.buffer && !seen.has(node.url) && seen.add(node.url))
        .map((node) => ({ name: node.url, buffer: node.data.asset.buffer, mime: node.data.asset.mime }));

    return createDocument({
        kind: 'document',
        ir,
        data: null,
        meta: { title, sourceType: 'md', sourceName, baseDir },
        assets,
        warnings,
    });
}

// ============================================================
// 输入读取
// ============================================================

async function readSource(input) {
    if (typeof input === 'string') {
        return { text: input, absPath: null };
    }
    if (input && typeof input.path === 'string' && input.path) {
        const absPath = path.resolve(input.path);
        const text = await fsp.readFile(absPath, 'utf8');
        return { text, absPath };
    }
    if (input && typeof input.text === 'string') {
        return { text: input.text, absPath: null };
    }
    throw new Error('parsers/md 需要 input.path 或 input.text');
}

// ============================================================
// 文本预处理
// ============================================================

// 仅做两件事：换行归一、标题写法宽松化；其余字符不动
function preprocess(text) {
    return String(text == null ? '' : text)
        .replace(/\r\n/g, '\n')
        .replace(HEADING_PREFIX_RE, (match) => '#'.repeat(match.length))
        .replace(HEADING_TIGHT_RE, '$1 ');
}

// ============================================================
// 标题提取
// ============================================================

function extractTitle(node) {
    const heading = findFirstH1(node);
    return heading ? toPlainText(heading).trim() : '';
}

function findFirstH1(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'heading' && node.depth === 1) return node;
    if (!Array.isArray(node.children)) return null;
    for (const child of node.children) {
        const found = findFirstH1(child);
        if (found) return found;
    }
    return null;
}

function toPlainText(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text' || node.type === 'inlineCode') return String(node.value || '');
    if (!Array.isArray(node.children)) return '';
    return node.children.map(toPlainText).join('');
}

function stripExt(name) {
    if (!name) return '';
    return path.basename(String(name), path.extname(String(name)));
}

// ============================================================
// 进度回调（回调异常不得影响解析）
// ============================================================

function notify(ctx, phase, pct) {
    if (!ctx || typeof ctx.onProgress !== 'function') return;
    try {
        ctx.onProgress(phase, pct);
    } catch (err) {
        // 忽略调用方回调自身的异常
    }
}

module.exports = { parse };
