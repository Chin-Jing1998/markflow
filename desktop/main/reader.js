/**
 * 直接打开阅读（方案 §3.4.6）：md / html / xml / pdf / json 五类本地文件 → 视图对象；md 另可编辑
 *
 * createReader(deps) → { open, close, closeAll, renderMarkdown, saveMarkdown, importImage, imageDialogDir, sessions }
 *   deps = { grants, tmp?, core?, log? }
 *     grants   asset-protocol 的授权表（grant(roots) → sid / revoke(sid)）
 *     core     { parseMarkdown, renderDocument, normalizeOptions, renderBundleSidecars? }，省略时懒加载转换内核
 *   open({ path })                       → { sessionId, kind, name, path, ext, size, mtimeMs, editable, view, warnings }
 *   close({ sessionId })                 → { closed: boolean }（先等该会话挂起的保存跑完）
 *   renderMarkdown({ sessionId, text? }) → { sessionId, html, warnings, gen }；不传 text 时读盘
 *   saveMarkdown({ sessionId, text, force? }) → md-edit.saveMarkdownFile 的回包 + sessionId；同一会话串行
 *   importImage({ sessionId, sourcePath }) → { relPath, width, height, alt }（目标为 md 所在目录）
 *   非 md 会话调用以上三个编辑接口抛「只有 Markdown 文件可以编辑」。
 *
 * 视图对象（§3.3.5 契约）：
 *   md   → { kind: 'md', html, raw }     parsers/md 解析 → renderers/html（reader 主题 + mf-asset 图片前缀）
 *   html → { kind: 'html', html }        html-sanitize 清洗，相对图改写为 mf-asset，远程图只留 alt
 *   xml  → { kind: 'xml', xml, structuredHtml }  xml-view 美化原文 + 已知 profile 的结构化视图
 *   pdf  → { kind: 'pdf', url }          mf-asset 地址交 Chromium 内置阅读器（承载它的 iframe 不得带 sandbox）
 *   json → { kind: 'json', json, valid } 去 BOM 后格式化；解析失败按原文显示并给 warning
 *
 * 会话 { id, path, kind, sid|null, tempDir|null, base:{mtimeMs,size}, gen, lastUsed, editing, chain, pending, busy, lastRender }
 * 常驻至显式关闭。md 会话的资产（临时目录 + sid）可回收：持有资产的 md 会话超过 MAX_ASSET_SESSIONS 时按最久未用
 * 回收（撤销 sid、删临时目录，跳过当前与正在渲染的会话），下次 renderMarkdown 时 hydrate 重新授权重建——
 * 修复「第 5 个文件挤掉旧会话后图片 403」。每次渲染资产写 tempDir/g<gen>/、前缀 mf-asset://<sid>/g<gen>/，
 * 并删掉 g<gen-2>，正在显示的上一版预览帧仍可取图；文本与 sid 都未变时直接复用上次渲染结果。
 * 会话总数硬上限 MAX_SESSIONS：只驱逐未编辑、无挂起保存且不在渲染中的最旧会话。
 * html / xml / pdf / json 的 sid 授权该文件所在目录。
 *
 * 本模块另把「写资产到目录」与「按扩展名建视图」两件事导出，供 preview-session 的来源栏复用
 * （方案 §3.4.7：来源栏的 md 与 pdf 与「直接打开」完全一致）。
 */
const path = require('path');
const fsp = require('fs').promises;

const { errText, statOrNull } = require('../../converters/util');
const { ASSET_EXTENSIONS } = require('./asset-protocol');
const { sanitizeHtml } = require('./html-sanitize');
const { buildXmlView } = require('./xml-view');
const { READER_EXTENSIONS, KIND_BY_EXT, MAX_TEXT_BYTES } = require('./file-kinds');
const {
    renderMarkdownText, saveMarkdownFile, importImage: importImageFile, writeAssets, READER_THEME,
} = require('./md-edit');

const TEMP_PREFIX = 'markflow-reader-';
/** 会话总数硬上限：超过时只驱逐未编辑且无挂起保存的最旧会话 */
const MAX_SESSIONS = 32;
/** 同时持有资产（临时目录 + sid）的 md 会话软上限 */
const MAX_ASSET_SESSIONS = 4;
const NOT_EDITABLE = '只有 Markdown 文件可以编辑';
const SESSION_GONE = '编辑会话不存在或已关闭，请重新打开文件';

const noop = () => undefined;
const isReaderPath = (target) => READER_EXTENSIONS.includes(path.extname(String(target || '')).toLowerCase());
const kindOf = (target) => KIND_BY_EXT[path.extname(String(target || '')).toLowerCase()] || null;
const assetBaseFor = (sid) => `mf-asset://${sid}/`;
const baseOf = (stat) => ({ mtimeMs: stat.mtimeMs, size: stat.size });

function sizeError(size) {
    return new Error(`文件过大（${(size / 1024 / 1024).toFixed(1)} MB），阅读视图上限为 ${MAX_TEXT_BYTES / 1024 / 1024} MB`);
}

async function readTextFile(filePath) {
    const stat = await statOrNull(filePath);
    if (!stat || !stat.isFile()) throw new Error(`文件不存在或不是普通文件：${filePath}`);
    if (stat.size > MAX_TEXT_BYTES) throw sizeError(stat.size);
    return fsp.readFile(filePath, 'utf8');
}

/** 同一文件句柄上先 fstat 再读：文本与 mtime/size 基线来自同一份内容，外部原子替换不会错配 */
async function readTextWithStat(filePath) {
    let handle;
    try {
        handle = await fsp.open(filePath, 'r');
    } catch (err) {
        throw new Error(`文件不存在或无法读取：${filePath}`);
    }
    try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error(`文件不存在或不是普通文件：${filePath}`);
        if (stat.size > MAX_TEXT_BYTES) throw sizeError(stat.size);
        return { text: await handle.readFile('utf8'), stat };
    } finally {
        await handle.close().catch(noop);
    }
}

// ============================================================
// 视图构建
// ============================================================

/** Markdown → { kind:'md', html, raw }；图片先落临时目录，再经 assetBase 取用 */
async function buildMarkdownView({ filePath, assetBase, assetDir, core, theme = READER_THEME }) {
    const raw = await readTextFile(filePath);
    const built = await renderMarkdownText({
        text: raw, baseDir: path.dirname(filePath), sourceName: path.basename(filePath), assetDir, assetBase, theme, core,
    });
    return { view: { kind: 'md', html: built.html, raw }, warnings: built.warnings };
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

/** JSON → { kind:'json', json, valid }；解析失败时按原文显示，并提示失败原因 */
async function buildJsonView({ filePath }) {
    const text = (await readTextFile(filePath)).replace(/^﻿/, '');
    try {
        return { view: { kind: 'json', json: JSON.stringify(JSON.parse(text), null, 2), valid: true }, warnings: [] };
    } catch (err) {
        return { view: { kind: 'json', json: text, valid: false }, warnings: [`JSON 解析失败，按原文显示：${errText(err)}`] };
    }
}

async function buildView({ kind, filePath, assetBase, assetDir, core, theme }) {
    if (kind === 'md') return buildMarkdownView({ filePath, assetBase, assetDir, core, theme });
    if (kind === 'html') return buildHtmlView({ filePath, assetBase });
    if (kind === 'xml') return buildXmlFileView({ filePath, assetBase });
    if (kind === 'pdf') return buildPdfView({ filePath, assetBase });
    if (kind === 'json') return buildJsonView({ filePath });
    throw new Error(`未知的阅读类型：${kind}`);
}

// ============================================================
// 会话
// ============================================================

function createReader(deps = {}) {
    const { grants, log = noop } = deps;
    if (!grants || typeof grants.grant !== 'function') throw new Error('createReader 需要 asset-protocol 的授权表 grants');
    const tmp = deps.tmp || require('../../converters/tmp');
    const core = deps.core || null;
    const sessions = new Map();
    let seq = 0;
    let clock = 0;

    const touch = (session) => { clock += 1; session.lastUsed = clock; };

    function revoke(sid) {
        if (!sid) return;
        try { grants.revoke(sid); } catch (err) { log(`[desktop] 撤销资源授权失败：${errText(err)}`); }
    }

    async function dispose(session) {
        if (!session) return;
        sessions.delete(session.id);
        const { sid, tempDir } = session;
        session.sid = null;
        session.tempDir = null;
        revoke(sid);
        if (tempDir) await tmp.removeTempDir(tempDir);
    }

    /** 回收一个 md 会话的资产：先同步摘掉 sid 与目录（此后的渲染会重新 hydrate），再撤销授权、删目录 */
    async function releaseAssets(session) {
        const { sid, tempDir } = session;
        session.sid = null;
        session.tempDir = null;
        session.lastRender = null;
        revoke(sid);
        if (tempDir) await tmp.removeTempDir(tempDir);
    }

    async function reclaimAssets(current) {
        const holders = [...sessions.values()].filter((item) => item.kind === 'md' && item.sid);
        let excess = holders.length - MAX_ASSET_SESSIONS;
        if (excess <= 0) return;
        const candidates = holders.filter((item) => item !== current).sort((a, b) => a.lastUsed - b.lastUsed);
        for (const victim of candidates) {
            if (excess <= 0) return;
            if (victim.busy > 0 || !victim.sid) continue;
            await releaseAssets(victim);
            excess -= 1;
        }
    }

    /** md 会话取用资产前调用：资产已被回收时重建临时目录并重新授权 */
    async function hydrate(session) {
        if (session.sid && session.tempDir) return false;
        session.tempDir = await tmp.makeTempDir(TEMP_PREFIX);
        session.sid = grants.grant([session.tempDir]);
        session.lastRender = null;
        await reclaimAssets(session);
        return true;
    }

    async function trimSessions() {
        while (sessions.size >= MAX_SESSIONS) {
            const victim = [...sessions.values()]
                .filter((item) => !item.editing && item.pending === 0 && item.busy === 0)
                .sort((a, b) => a.lastUsed - b.lastUsed)[0];
            if (!victim) return;
            await dispose(victim);
        }
    }

    function requireMd(sessionId) {
        const session = sessions.get(String(sessionId || ''));
        if (!session) throw new Error(SESSION_GONE);
        if (session.kind !== 'md') throw new Error(NOT_EDITABLE);
        return session;
    }

    async function renderGeneration(session, text) {
        session.gen += 1;
        const gen = session.gen;
        const { sid, tempDir } = session;
        const built = await renderMarkdownText({
            text, baseDir: path.dirname(session.path), sourceName: path.basename(session.path),
            assetDir: path.join(tempDir, `g${gen}`), assetBase: `${assetBaseFor(sid)}g${gen}/`, core,
        });
        if (gen > 2 && session.tempDir === tempDir) await tmp.removeTempDir(path.join(tempDir, `g${gen - 2}`));
        if (session.sid === sid) session.lastRender = { sid, text, html: built.html, warnings: built.warnings, gen };
        return { html: built.html, warnings: built.warnings, gen };
    }

    async function openMarkdown(session) {
        const { text, stat } = await readTextWithStat(session.path);
        session.base = baseOf(stat);
        session.busy += 1;
        try {
            await hydrate(session);
            const built = await renderGeneration(session, text);
            return { view: { kind: 'md', html: built.html, raw: text }, warnings: built.warnings, stat };
        } finally {
            session.busy -= 1;
        }
    }

    async function open(payload = {}) {
        const filePath = path.resolve(String(payload.path || ''));
        const kind = kindOf(filePath);
        if (!kind) throw new Error(`阅读模式只支持 ${READER_EXTENSIONS.join(' / ')}，无法打开：${path.basename(filePath)}`);
        const stat = await statOrNull(filePath);
        if (!stat || !stat.isFile()) throw new Error(`文件不存在或不是普通文件：${filePath}`);
        await trimSessions();

        seq += 1;
        const session = {
            id: `reader-${Date.now().toString(36)}-${seq}`, path: filePath, kind, sid: null, tempDir: null,
            base: baseOf(stat), gen: 0, lastUsed: 0, editing: false, chain: Promise.resolve(), pending: 0, busy: 0, lastRender: null,
        };
        touch(session);
        sessions.set(session.id, session);

        try {
            let built;
            let snapshot = stat;
            if (kind === 'md') {
                built = await openMarkdown(session);
                snapshot = built.stat;
            } else {
                session.sid = grants.grant([path.dirname(filePath)]);
                built = await buildView({ kind, filePath, assetBase: assetBaseFor(session.sid), core });
            }
            return {
                sessionId: session.id, kind, name: path.basename(filePath), path: filePath,
                ext: path.extname(filePath).toLowerCase(), size: snapshot.size, mtimeMs: snapshot.mtimeMs,
                editable: kind === 'md', view: built.view, warnings: built.warnings || [],
            };
        } catch (err) {
            await dispose(session);
            throw err;
        }
    }

    async function renderMarkdown(payload = {}) {
        const session = requireMd(payload.sessionId);
        touch(session);
        session.busy += 1;
        try {
            const hasText = typeof payload.text === 'string';
            const text = hasText ? payload.text : await readTextFile(session.path);
            if (hasText) session.editing = true;
            await hydrate(session);
            const cached = session.lastRender;
            if (cached && cached.sid === session.sid && cached.text === text) {
                return { sessionId: session.id, html: cached.html, warnings: cached.warnings, gen: cached.gen };
            }
            const built = await renderGeneration(session, text);
            return { sessionId: session.id, ...built };
        } finally {
            session.busy -= 1;
        }
    }

    async function saveMarkdown(payload = {}) {
        const session = requireMd(payload.sessionId);
        touch(session);
        const text = String(payload.text == null ? '' : payload.text);
        const force = Boolean(payload.force);
        session.pending += 1;
        const task = session.chain
            .then(() => saveMarkdownFile({ filePath: session.path, text, base: session.base, force, core, log }))
            .then((result) => {
                if (result.saved) {
                    session.base = result.base;
                    session.editing = true;
                }
                return { sessionId: session.id, ...result };
            });
        session.chain = task.then(noop, noop).then(() => { session.pending -= 1; });
        return task;
    }

    async function importImage(payload = {}) {
        const session = requireMd(payload.sessionId);
        touch(session);
        const result = await importImageFile({ sourcePath: payload.sourcePath, docDir: path.dirname(session.path) });
        session.lastRender = null;
        return result;
    }

    /** 插图对话框的默认目录：md 所在目录 */
    function imageDialogDir(payload = {}) {
        return path.dirname(requireMd(payload.sessionId).path);
    }

    async function close(payload = {}) {
        const session = sessions.get(String(payload.sessionId || ''));
        if (!session) return { closed: false };
        await session.chain.catch(noop);
        await dispose(session);
        return { closed: true };
    }

    async function closeAll() {
        for (const session of [...sessions.values()]) {
            await session.chain.catch(noop);
            await dispose(session);
        }
    }

    return { open, close, closeAll, renderMarkdown, saveMarkdown, importImage, imageDialogDir, sessions };
}

module.exports = {
    createReader, buildView, buildMarkdownView, buildHtmlView, buildXmlFileView, buildPdfView, buildJsonView,
    writeAssets, readTextFile, readTextWithStat, isReaderPath, kindOf, assetBaseFor,
    READER_EXTENSIONS, READER_THEME, MAX_SESSIONS, MAX_ASSET_SESSIONS, MAX_TEXT_BYTES,
};
