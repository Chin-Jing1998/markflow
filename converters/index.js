/**
 * 转换调度器（MarkFlow）
 *
 * 职责：输入类型识别 → 懒加载 parser → 解析为 IR → 计算标题 → 懒加载 renderer → 落盘。
 * 本文件顶层不加载任何 parser/renderer，也不探测 soffice 或 PDF 后端
 * （运行时能力由调用方传入 listTargets）。
 *
 * convert({ input: { path? | url? }, target: 'bundle' | 'docx' | 'pdf', outputDir, onProgress?, allowPrivateNetwork? })
 *   → { ok, target, name, title, sourceType, outputPath, outputs, imagesCount, warnings }
 *   bundle  ：outputPath 为产物目录，outputs = { md, json, imagesDir? }
 *   docx/pdf：outputPath 为单文件路径，outputs = { docx } 或 { pdf }
 *   失败一律 throw（中文错误信息）。
 *
 * onProgress(phase, pct) 依次收到 ('parsing',20) → ('rendering',60) → ('writing',90) → ('writing',100)；
 * parser 内部的细粒度进度会插在前两者之间，且一律归一为 phase='parsing'、
 * pct 钳制到 [0,55] 并在同一次转换内单调不减（见 buildParserContext）。
 */
const path = require('path');
const fsp = require('fs').promises;
const { sanitizeFolderName, stripExt, collectText } = require('./ir/util');
const output = require('./output');
const { runBatch } = require('./batch');

// 扩展名 → 输入类型
const EXT_TO_TYPE = Object.freeze({
    '.docx': 'docx', '.doc': 'doc', '.xlsx': 'xlsx', '.xls': 'xls', '.pptx': 'pptx',
    '.ppt': 'ppt', '.pdf': 'pdf', '.md': 'md', '.markdown': 'md',
});
const SUPPORTED_EXTENSIONS = Object.freeze(Object.keys(EXT_TO_TYPE));

// 输入类型 → 输入类别（决定可选目标）；键序即 listTargets().inputs 的键序。
// 键必须与 detectInputType 的返回值一一对应：.markdown 已归入 md，故此处没有 markdown 键
const INPUT_CLASS = Object.freeze({
    docx: 'office', doc: 'office', xlsx: 'office', xls: 'office', pptx: 'office',
    ppt: 'office', pdf: 'office', md: 'markup', url: 'url',
});
// 旧二进制格式依赖 soffice 转码
const LEGACY_INPUT_TYPES = Object.freeze(['doc', 'xls', 'ppt']);
// 目标 → { 接受的输入类别, 拒绝时的提示 }
const TARGET_RULES = Object.freeze({
    bundle: { classes: ['office', 'url'], hint: 'bundle 仅接受 Office、PDF 文件与网页输入' },
    docx: { classes: ['markup'], hint: 'docx 仅接受 Markdown 输入' },
    pdf: { classes: ['markup'], hint: 'pdf 仅接受 Markdown 输入' },
});
// 需要内嵌远程图片的目标
const BINARY_TARGETS = Object.freeze(['docx', 'pdf']);
const REMOTE_URL_RE = /^https?:\/\//i;
const REMOTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TITLE = '未命名文档';
const PROGRESS = Object.freeze({ PARSING: 20, RENDERING: 60, WRITING: 90, DONE: 100 });
// parser 上报进度的允许区间：上界须低于 RENDERING，避免解析阶段的百分比越过渲染阶段
const PARSER_PCT = Object.freeze({ MIN: 0, MAX: 55 });

// 'docx'|'doc'|'xlsx'|'xls'|'pptx'|'ppt'|'pdf'|'md'|'url'|null
function detectInputType(pathOrUrl) {
    if (typeof pathOrUrl !== 'string' || !pathOrUrl.trim()) return null;
    const value = pathOrUrl.trim();
    if (REMOTE_URL_RE.test(value)) return 'url';
    return EXT_TO_TYPE[path.extname(value).toLowerCase()] || null;
}

// 调用方负责探测 soffice 与 PDF 后端；本函数只做矩阵拼装
function listTargets({ sofficeAvailable = false, pdfBackend = null } = {}) {
    const soffice = Boolean(sofficeAvailable);
    return {
        office: ['bundle'],
        markup: pdfBackend ? ['docx', 'pdf'] : ['docx'],
        url: ['bundle'],
        inputs: Object.fromEntries(
            Object.entries(INPUT_CLASS).filter(([type]) => soffice || !LEGACY_INPUT_TYPES.includes(type)),
        ),
        capabilities: { sofficeAvailable: soffice, pdfBackend: pdfBackend || null },
    };
}

async function convert(params = {}) {
    const { input, target, outputDir, onProgress, allowPrivateNetwork = false } = params || {};
    const source = await resolveSource(input);
    await assertOutputDir(outputDir);
    assertTargetAllowed(target, source.type);
    const emit = createProgressEmitter(onProgress);

    emit('parsing', PROGRESS.PARSING);
    const parser = getParser(source.type);
    const ctx = buildParserContext({ source, target, allowPrivateNetwork, emit });
    const parsed = await parser.parse(source.type === 'url' ? { url: source.url } : { path: source.path }, ctx);
    if (!parsed || typeof parsed !== 'object' || !parsed.ir) throw new Error(`解析器 ${source.type} 未返回有效的 IR 文档`);

    // 标题：meta.title → 首个 H1 → 文件名（去扩展名）→ 默认值；渲染前写回 meta.title
    const rawTitle = extractRawTitle(parsed);
    const title = rawTitle || (source.type === 'url' ? '' : stripExt(source.sourceName)) || DEFAULT_TITLE;
    const doc = { ...parsed, meta: { ...(parsed.meta || {}), title } };
    const name = resolveOutputName(source, rawTitle);

    emit('rendering', PROGRESS.RENDERING);
    const rendered = await renderTarget(doc, target);
    emit('writing', PROGRESS.WRITING);
    const written = await writeTarget({ rendered, target, outputDir, name, assets: doc.assets });
    emit('writing', PROGRESS.DONE);

    return {
        ok: true, target, name, title, sourceType: source.type,
        outputPath: written.outputPath, outputs: written.outputs,
        imagesCount: Array.isArray(doc.assets) ? doc.assets.length : 0,
        warnings: Array.isArray(doc.warnings) ? [...doc.warnings] : [],
    };
}

// → { type, path?, url?, sourceName }
async function resolveSource(input) {
    const src = input && typeof input === 'object' ? input : {};
    const hasPath = typeof src.path === 'string' && src.path.trim() !== '';
    const hasUrl = typeof src.url === 'string' && src.url.trim() !== '';
    if (hasPath === hasUrl) throw new Error('input 必须是对象，且 path 与 url 二选一');

    if (hasUrl) {
        const url = src.url.trim();
        if (!REMOTE_URL_RE.test(url)) throw new Error(`仅支持 http(s) 网址：${url}`);
        return { type: 'url', url, sourceName: url };
    }

    const filePath = src.path;
    if (!path.isAbsolute(filePath)) throw new Error(`输入路径必须是绝对路径：${filePath}`);
    const stat = await statOrNull(filePath);
    if (!stat) throw new Error(`输入文件不存在：${filePath}`);
    if (!stat.isFile()) throw new Error(`输入路径不是文件：${filePath}`);

    const type = detectInputType(filePath);
    if (type) return { type, path: filePath, sourceName: path.basename(filePath) };
    const ext = path.extname(filePath) || '(无扩展名)';
    throw new Error(`不支持的输入格式：${ext}，支持：${SUPPORTED_EXTENSIONS.join(' ')}`);
}

async function assertOutputDir(outputDir) {
    if (typeof outputDir !== 'string' || !outputDir.trim()) throw new Error('缺少输出目录 outputDir');
    const stat = await statOrNull(outputDir);
    if (!stat) throw new Error(`输出目录不存在：${outputDir}`);
    if (!stat.isDirectory()) throw new Error(`输出路径不是目录：${outputDir}`);
}

function assertTargetAllowed(target, inputType) {
    const rule = TARGET_RULES[target];
    if (!rule) throw new Error(`不支持的目标格式：${target}（可选：${Object.keys(TARGET_RULES).join('、')}）`);
    if (!rule.classes.includes(INPUT_CLASS[inputType])) throw new Error(`目标 ${target} 不接受 ${inputType} 输入：${rule.hint}`);
}

async function statOrNull(target) {
    try { return await fsp.stat(target); } catch (err) { return null; }
}

// meta.title 优先，其次首个 H1 的纯文本
function extractRawTitle(doc) {
    const metaTitle = doc.meta && typeof doc.meta.title === 'string' ? doc.meta.title.trim() : '';
    return metaTitle || firstH1Text(doc.ir);
}

// 深度优先取首个非空的 depth=1 标题文本；无此类标题返回空串
function firstH1Text(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'heading' && node.depth === 1) return collectText(node).trim();
    if (!Array.isArray(node.children)) return '';
    for (const child of node.children) {
        const text = firstH1Text(child);
        if (text) return text;
    }
    return '';
}

// 文件输入取文件名；网页输入取标题，无标题时取「主机名-时间戳」
function resolveOutputName(source, rawTitle) {
    if (source.type !== 'url') return sanitizeFolderName(stripExt(source.sourceName));
    if (rawTitle) return sanitizeFolderName(rawTitle);
    return sanitizeFolderName(`${hostnameOf(source.url)}-${formatTimestamp()}`);
}

function hostnameOf(url) {
    try { return new URL(url).hostname || 'web'; } catch (err) { return 'web'; }
}

// 本地时间 YYYYMMDD-HHmmss
function formatTimestamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    return `${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function renderTarget(doc, target) {
    if (target === 'bundle') {
        const md = await getRenderer('md').render(doc);
        const json = await getRenderer('json').render(doc);
        return { md: String(md), json: String(json) };
    }
    const buffer = await getRenderer(target).render(doc);
    if (!Buffer.isBuffer(buffer)) throw new Error(`渲染器 ${target} 未返回 Buffer`);
    return { buffer };
}

async function writeTarget({ rendered, target, outputDir, name, assets }) {
    if (target !== 'bundle') {
        const filePath = await output.writeSingle({ outputDir, name, ext: target, buffer: rendered.buffer });
        return { outputPath: filePath, outputs: { [target]: filePath } };
    }
    const bundle = await output.writeBundle({
        outputDir, name, md: rendered.md, json: rendered.json,
        assets: Array.isArray(assets) ? assets : [],
    });
    return {
        outputPath: bundle.dir,
        outputs: { md: bundle.mdPath, json: bundle.jsonPath, ...(bundle.imagesDir ? { imagesDir: bundle.imagesDir } : {}) },
    };
}

function buildParserContext({ source, target, allowPrivateNetwork, emit }) {
    // parser 各自命名的 phase（fetching / assets / ir 等）对外无意义，一律归一为 'parsing'；
    // pct 钳制到 [MIN, MAX] 并记住上次取值，低于上次的回退进度直接丢弃
    let lastPct = -Infinity;
    return {
        sourceName: source.sourceName,
        // 只接受 (phase: string, pct: number) 形态的进度，其它形态一律丢弃
        onProgress: (phase, pct) => {
            if (typeof phase !== 'string' || !Number.isFinite(pct)) return;
            const clamped = Math.min(Math.max(pct, PARSER_PCT.MIN), PARSER_PCT.MAX);
            if (clamped < lastPct) return;
            lastPct = clamped;
            emit('parsing', clamped);
        },
        allowPrivateNetwork: Boolean(allowPrivateNetwork),
        fetchRemote: BINARY_TARGETS.includes(target) ? createRemoteFetcher(allowPrivateNetwork) : undefined,
    };
}

// 远程图片下载器：依赖 net/fetch-guard，模块缺失时返回 undefined（parser 将记 warning 而非内嵌）
function createRemoteFetcher(allowPrivateNetwork) {
    const guard = loadOptionalModule('./net/fetch-guard');
    if (!guard || typeof guard.fetchBinary !== 'function') return undefined;
    return (url) => guard.fetchBinary(url, { maxBytes: REMOTE_IMAGE_MAX_BYTES, allowPrivateNetwork: Boolean(allowPrivateNetwork) });
}

// 进度回调自身的异常不影响转换
function createProgressEmitter(onProgress) {
    if (typeof onProgress !== 'function') return () => {};
    return (phase, pct) => { try { onProgress(phase, pct); } catch (err) { /* 忽略 */ } };
}

// parser/renderer 只在首次使用时 require，保证 require('./converters') 本身零重依赖
let moduleLoader = require;
const getParser = (type) => loadPart('parsers', type, 'parse', '解析器');
const getRenderer = (name) => loadPart('renderers', name, 'render', '渲染器');

function loadPart(dir, name, method, label) {
    const mod = moduleLoader(`./${dir}/${name}`);
    if (!mod || typeof mod[method] !== 'function') throw new Error(`${label} ${name} 未导出 ${method}()`);
    return mod;
}

// 仅当缺失的正是目标模块本身（错误信息点名了它，兼容相对说明符与绝对路径两种写法）才返回 null；
// 其依赖缺失等其它错误照常抛出
function loadOptionalModule(relPath) {
    try {
        return moduleLoader(relPath);
    } catch (err) {
        const named = err && String(err.message).replace(/\\/g, '/').includes(relPath.replace(/^\.\//, ''));
        if (named && err.code === 'MODULE_NOT_FOUND') return null;
        throw err;
    }
}

// 测试钩子：替换模块加载器以注入桩 parser/renderer（与 server/soffice.js 的 _set*/_reset 约定一致）
function _setModuleLoader(fn) { moduleLoader = typeof fn === 'function' ? fn : require; }
function _reset() { moduleLoader = require; }

module.exports = {
    convert, listTargets, detectInputType, SUPPORTED_EXTENSIONS, runBatch,
    _setModuleLoader, _reset,
};
