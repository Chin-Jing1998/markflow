/**
 * 直接打开阅读（方案 §3.4.6）：md / html / xml / pdf 四类本地文件 → 视图对象
 *
 * createReader(deps) → { open, close, closeAll, sessions }
 *   deps = { grants, tmp?, core?, sanitize?, xmlView?, log? }
 *     grants   asset-protocol 的授权表（grant(roots) → sid / revoke(sid)）
 *     core     { parseMarkdown, renderDocument }，省略时懒加载 converters/parsers/md 与 converters/index
 *   open({ path })      → { sessionId, kind, name, path, ext, view, warnings }
 *   close({ sessionId })→ { closed: boolean }
 *
 * 视图对象（§3.3.5 契约）：
 *   md   → { kind: 'md', html, raw }     parsers/md 解析 → renderers/html（reader 主题 + mf-asset 图片前缀）
 *   html → { kind: 'html', html }        html-sanitize 清洗，相对图改写为 mf-asset，远程图只留 alt
 *   xml  → { kind: 'xml', xml, structuredHtml }  xml-view 美化原文 + 已知 profile 的结构化视图
 *   pdf  → { kind: 'pdf', url }          mf-asset 地址交 Chromium 内置阅读器（承载它的 iframe 不得带 sandbox）
 *
 * 每次 open 建一个会话：一个临时目录（md 的图片落在这里）+ 一个 sid。sid 授权的目录：
 * md 为临时目录，html / xml / pdf 为该文件所在目录（相邻图片与 PDF 本体都在那里）。
 * close 撤销授权并删除临时目录；同时在场的会话数超过 MAX_SESSIONS 时自动关闭最早的一个。
 *
 * 本模块另把「写资产到目录」与「按扩展名建视图」两件事导出，供 preview-session 的来源栏复用
 * （方案 §3.4.7：来源栏的 md 与 pdf 与「直接打开」完全一致）。
 */
const path = require('path');
const fsp = require('fs').promises;

const { errText, isWithinDir, statOrNull } = require('../../converters/util');
const { ASSET_EXTENSIONS } = require('./asset-protocol');
const { sanitizeHtml } = require('./html-sanitize');
const { buildXmlView } = require('./xml-view');

const READER_EXTENSIONS = Object.freeze(['.md', '.markdown', '.html', '.htm', '.xml', '.pdf']);
const KIND_BY_EXT = Object.freeze({
    '.md': 'md', '.markdown': 'md', '.html': 'html', '.htm': 'html', '.xml': 'xml', '.pdf': 'pdf',
});
const READER_THEME = 'reader';
const TEMP_PREFIX = 'markflow-reader-';
const MAX_SESSIONS = 4;
/** 单个文本文件的读取上限：阅读视图不承担超大文件，超限给中文提示而不是卡死渲染进程 */
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

const isReaderPath = (target) => READER_EXTENSIONS.includes(path.extname(String(target || '')).toLowerCase());
const kindOf = (target) => KIND_BY_EXT[path.extname(String(target || '')).toLowerCase()] || null;
const assetBaseFor = (sid) => `mf-asset://${sid}/`;

// ============================================================
// 资产落盘（reader 与 preview 共用）
// ============================================================

/**
 * 把 doc.assets / 渲染器 assets 写进目录，返回实际写入的资产名。
 * 资产名来自转换内核（images/image_1.jpg 或裸文件名），仍逐项做穿越校验，绝不写到目录之外。
 */
async function writeAssets(dir, assets = []) {
    const written = [];
    for (const asset of Array.isArray(assets) ? assets : []) {
        if (!asset || typeof asset.name !== 'string' || !asset.buffer) continue;
        const rel = asset.name.split(/[\\/]/).filter((segment) => segment && segment !== '.').join(path.sep);
        if (!rel || rel.split(path.sep).includes('..')) continue;
        const abs = path.resolve(dir, rel);
        if (!isWithinDir(dir, abs)) continue;
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, asset.buffer);
        written.push(asset.name);
    }
    return written;
}

async function readTextFile(filePath) {
    const stat = await statOrNull(filePath);
    if (!stat || !stat.isFile()) throw new Error(`文件不存在或不是普通文件：${filePath}`);
    if (stat.size > MAX_TEXT_BYTES) throw new Error(`文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），阅读视图上限为 ${MAX_TEXT_BYTES / 1024 / 1024} MB`);
    return fsp.readFile(filePath, 'utf8');
}

// ============================================================
// 视图构建
// ============================================================

function loadCore(core) {
    return {
        parseMarkdown: (core && core.parseMarkdown) || ((input, ctx) => require('../../converters/parsers/md').parse(input, ctx)),
        renderDocument: (core && core.renderDocument) || ((doc, target, options, context) => require('../../converters/index').renderDocument(doc, target, options, context)),
        normalizeOptions: (core && core.normalizeOptions) || ((raw) => require('../../converters/options').normalizeOptions(raw)),
    };
}

/** Markdown → { kind:'md', html, raw }；图片先落临时目录，再经 assetBase 取用 */
async function buildMarkdownView({ filePath, assetBase, assetDir, core, theme = READER_THEME }) {
    const api = loadCore(core);
    const raw = await readTextFile(filePath);
    const doc = await api.parseMarkdown({ path: filePath }, { sourceName: path.basename(filePath) });
    const options = api.normalizeOptions({ html: { theme } });
    await writeAssets(assetDir, doc.assets);
    const rendered = await api.renderDocument(doc, 'html', options, { imageMode: { base: assetBase } });
    const html = String(Object.values(rendered.files)[0] || '');
    return {
        view: { kind: 'md', html, raw },
        warnings: [...(Array.isArray(doc.warnings) ? doc.warnings : []), ...(Array.isArray(rendered.warnings) ? rendered.warnings : [])],
    };
}

/** HTML → { kind:'html', html }；相对图相对该文件所在目录 */
async function buildHtmlView({ filePath, assetBase }) {
    const raw = await readTextFile(filePath);
    const result = sanitizeHtml(raw, { baseDir: path.dirname(filePath), assetBase, allowedExts: ASSET_EXTENSIONS });
    return { view: { kind: 'html', html: result.html }, warnings: result.warnings, stats: { removed: result.removed, images: result.images, links: result.links } };
}

/** XML → { kind:'xml', xml, structuredHtml } */
async function buildXmlFileView({ filePath, assetBase }) {
    const raw = await readTextFile(filePath);
    const view = buildXmlView(raw, { assetBase, label: path.basename(filePath) });
    return { view, warnings: view.warnings };
}

/** PDF → { kind:'pdf', url }；承载该 url 的 iframe 不得带 sandbox，否则被 ERR_BLOCKED_BY_CLIENT 拦掉 */
function buildPdfView({ filePath, assetBase }) {
    return { view: { kind: 'pdf', url: `${String(assetBase).replace(/\/+$/, '')}/${encodeURIComponent(path.basename(filePath))}` }, warnings: [] };
}

// ============================================================
// 会话
// ============================================================

function createReader(deps = {}) {
    const { grants, log = () => undefined } = deps;
    if (!grants || typeof grants.grant !== 'function') throw new Error('createReader 需要 asset-protocol 的授权表 grants');
    const tmp = deps.tmp || require('../../converters/tmp');
    const core = deps.core || null;
    const sessions = new Map();
    let seq = 0;

    async function dispose(session) {
        if (!session) return;
        try { grants.revoke(session.sid); } catch (err) { log(`[desktop] 撤销资源授权失败：${errText(err)}`); }
        if (session.tempDir) await tmp.removeTempDir(session.tempDir);
        sessions.delete(session.id);
    }

    async function trim() {
        while (sessions.size >= MAX_SESSIONS) {
            const oldest = sessions.values().next().value;
            if (!oldest) return;
            await dispose(oldest);
        }
    }

    async function open(payload = {}) {
        const filePath = path.resolve(String(payload.path || ''));
        const kind = kindOf(filePath);
        if (!kind) throw new Error(`阅读模式只支持 ${READER_EXTENSIONS.join(' / ')}，无法打开：${path.basename(filePath)}`);
        const stat = await statOrNull(filePath);
        if (!stat || !stat.isFile()) throw new Error(`文件不存在或不是普通文件：${filePath}`);
        await trim();

        const tempDir = kind === 'md' ? await tmp.makeTempDir(TEMP_PREFIX) : null;
        const roots = kind === 'md' ? [tempDir] : [path.dirname(filePath)];
        const sid = grants.grant(roots);
        seq += 1;
        const session = { id: `reader-${Date.now().toString(36)}-${seq}`, sid, tempDir, path: filePath, kind };
        sessions.set(session.id, session);

        try {
            const built = await buildView({ kind, filePath, assetBase: assetBaseFor(sid), assetDir: tempDir, core });
            return {
                sessionId: session.id, kind, name: path.basename(filePath), path: filePath,
                ext: path.extname(filePath).toLowerCase(), size: stat.size,
                view: built.view, warnings: built.warnings || [],
            };
        } catch (err) {
            await dispose(session);
            throw err;
        }
    }

    async function close(payload = {}) {
        const session = sessions.get(String(payload.sessionId || ''));
        if (!session) return { closed: false };
        await dispose(session);
        return { closed: true };
    }

    async function closeAll() {
        for (const session of [...sessions.values()]) await dispose(session);
    }

    return { open, close, closeAll, sessions };
}

async function buildView({ kind, filePath, assetBase, assetDir, core, theme }) {
    if (kind === 'md') return buildMarkdownView({ filePath, assetBase, assetDir, core, theme });
    if (kind === 'html') return buildHtmlView({ filePath, assetBase });
    if (kind === 'xml') return buildXmlFileView({ filePath, assetBase });
    if (kind === 'pdf') return buildPdfView({ filePath, assetBase });
    throw new Error(`未知的阅读类型：${kind}`);
}

module.exports = {
    createReader, buildView, buildMarkdownView, buildHtmlView, buildXmlFileView, buildPdfView,
    writeAssets, readTextFile, isReaderPath, kindOf, assetBaseFor,
    READER_EXTENSIONS, READER_THEME, MAX_SESSIONS, MAX_TEXT_BYTES,
};
