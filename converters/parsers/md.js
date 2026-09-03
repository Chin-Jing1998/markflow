/**
 * Markdown → IR
 *
 * 关键点：
 *   1) 按路径读取 utf8 文本，baseDir 取源文件所在目录，供图片相对路径解析；
 *   2) 先摘掉开头的 YAML front matter —— 留着的话 remark 会把它解析成一条分隔线加若干
 *      段落，转出的 DOCX/PDF 正文里就会混进 YAML 文本；摘出的键值合并进 meta；
 *   3) 挂载 remark-gfm —— 缺失它会导致表格、删除线、任务列表退化为原始字面量文本；
 *   4) 宽松标题预处理 —— 兼容 "#标题"（缺空格）与全角 "＃标题" 两种非标准写法；
 *   5) 解析后立即把图片解析为可内嵌资源，挂到 image 节点的 data.asset 上；
 *   6) 其中可被二进制渲染器内嵌的那部分统一编号为 images/image_N.ext 后作为 assets 返回
 *      —— 资源名不能沿用 Markdown 里的原始地址，否则 "../x.png"、绝对路径与 http(s) 地址
 *      会被当作落盘路径使用。
 */
const fsp = require('fs').promises;
const path = require('path');
const { loadUnified } = require('../ir/unified-loader');
const { createDocument } = require('../ir/schema');
const { stripExt } = require('../ir/util');
const { resolveImages, collectImageNodes } = require('../assets/md-images');
const { stripFrontMatter } = require('../web/frontmatter');
const { notify } = require('../util');

// docx 等二进制渲染器可内嵌的图片类型 → 资源扩展名；不在表内的（svg/webp 等）不进 assets，
// 但 image 节点上的 data.asset 仍保留，HTML 渲染照常可用
const EMBEDDABLE_EXT_BY_MIME = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/bmp': '.bmp',
};

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
    const { body, data: frontMatter } = stripFrontMatter(text);

    const baseDir = absPath ? path.dirname(absPath) : (ctx.baseDir || process.cwd());
    const sourceName = ctx.sourceName || (absPath ? path.basename(absPath) : undefined);

    const { unified, remarkParse, remarkGfm } = await loadUnified();
    const ir = unified().use(remarkParse).use(remarkGfm).parse(preprocess(body));
    notify(ctx, 'parsing', 30);

    const title = pickTitle(frontMatter, ir, sourceName);

    const { warnings } = await resolveImages(ir, baseDir, {
        fetchRemote: ctx.fetchRemote,
    });
    notify(ctx, 'parsing', 55);

    const assets = collectAssets(ir);

    return createDocument({
        kind: 'document',
        ir,
        data: null,
        // front matter 的键先展开，系统字段随后覆盖，保证来源信息不被文档自述值篡改
        meta: { ...frontMatter, title, sourceType: 'md', sourceName, baseDir },
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

// front matter 显式给出 title 时优先采用，否则沿用「首个 H1 → 文件名」的原有推断
function pickTitle(frontMatter, ir, sourceName) {
    const declared = frontMatter && typeof frontMatter.title === 'string' ? frontMatter.title.trim() : '';
    return declared || extractTitle(ir) || stripExt(sourceName);
}

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

// ============================================================
// 资源登记
// ============================================================

// 按文档顺序收集可内嵌图片，统一编号为 images/image_N.ext；同一 url 只登记一次
function collectAssets(ir) {
    const assets = [];
    const seen = new Set();
    for (const node of collectImageNodes(ir)) {
        const asset = node.data && node.data.asset;
        const ext = asset && asset.buffer ? EMBEDDABLE_EXT_BY_MIME[asset.mime] : undefined;
        if (!ext || seen.has(node.url)) continue;
        seen.add(node.url);
        assets.push({ name: `images/image_${assets.length + 1}${ext}`, buffer: asset.buffer, mime: asset.mime });
    }
    return assets;
}

// ============================================================
// 进度回调（回调异常不得影响解析）
// ============================================================


module.exports = { parse };
