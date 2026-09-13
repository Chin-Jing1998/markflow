/**
 * PDF → IR（MinerU Open API v4 云端后端）
 *
 * 契约：parseWithMineru({ path }, ctx, { token, source }) → MarkFlowDocument，由 parsers/pdf.js 分派调用；
 * source 为令牌来源（config.getMineruToken 的 source），只用于鉴权失败时的中文提示。
 * 与本地文本层后端的差别：拿得到图片、版面顺序、表格与公式，代价是一次网络往返与账号额度。
 *
 * 流程与官方 SDK 的分工：
 *   1) 提交用 SDK 的 `submit(source, options)` —— 它封装了「POST /file-urls/batch 拿预签名 URL →
 *      PUT 上传」两步，返回 batch_id；
 *   2) 轮询、下载、解包一律自行实现 —— SDK 的 `getBatch()` 虽然也能拿结果，但它在内存里解包并只挑出
 *      markdown / content_list / 图片，layout.json 与 *_model.json 被直接丢弃，无法满足「全部产物落盘」；
 *   3) 轮询 `GET /extract-results/batch/{batch_id}`（Bearer 鉴权，3 s 起指数退避至 30 s，总时长受
 *      options.mineru.timeoutSec 约束），读 state / extract_progress / err_msg / full_zip_url；
 *   4) done 后流式下载 full_zip_url（只接受 https，上限 1 GB）到 tmp.makeTempDir 的一次性目录，
 *      jszip 解包：**全部条目**原样进 doc.extras（名字为 `mineru/<zip 内相对路径>`），
 *      full.md 交 parsers/md.parse({ text }, { baseDir }) 构 IR，图片经 md-images 读成 assets；
 *   5) IR 里 MinerU 写成原始 HTML 的表格交 ir/sanitize-table 处理（规则表转 mdast，合并单元格白名单清洗）。
 *
 * 落盘的临时目录在函数返回前一律删除：解包内容此时已全部在内存里（extras 的 buffer 与图片 asset 的
 * buffer），留着只会在长驻进程（MCP server）里累积。
 *
 * 进度映射（方案 §3.4.5）：提交 10 → pending 15 → running 15+30×页进度 → converting 48 → 下载 50
 * → 解包 53 → IR 55；内部强制单调不减，上界 55（index.js 的 parser 进度区间上限）。
 *
 * 令牌只出现在 Authorization 头与 SDK 内部，绝不进入 data / meta / warnings / 错误信息
 * （错误一律经 mineru-errors.describeMineruError 中文化并抹除令牌）。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const { createDocument } = require('../ir/schema');
const { sanitizeTables } = require('../ir/sanitize-table');
const { stripExt } = require('../ir/util');
const { normalizeOptions } = require('../options');
const { getMineruToken } = require('../config');
const { makeTempDir, removeTempDir } = require('../tmp');
const { notify, statOrNull } = require('../util');
const { describeMineruError, TIMEOUT_CODE, ZIP_TOO_LARGE_CODE } = require('./mineru-errors');
const md = require('../parsers/md');

const API_BASE = 'https://mineru.net/api/v4';
/** MinerU 单文件上限（官方限制 200 MB），本地先行拦截，省掉一次注定失败的上传 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
/** 结果包落盘上限，防止异常响应撑爆磁盘 */
const MAX_ZIP_BYTES = 1024 * 1024 * 1024;
const POLL_START_MS = 3000;
const POLL_MAX_MS = 30000;
const TEMP_PREFIX = 'markflow-mineru-';
const ZIP_FILENAME = 'result.zip';
const EXTRACT_DIRNAME = 'extract';
/** extras 内的顶层目录名；output.writeFolder 据此把它记为 outputs.mineruDir */
const EXTRAS_PREFIX = 'mineru';
const DATA_ID_PREFIX = 'markflow-';
const DATA_ID_HASH_LEN = 16;
/** HTTP 错误里保留的响应体长度 */
const HTTP_BODY_LIMIT = 300;

const PROGRESS = Object.freeze({
    SUBMITTED: 10, PENDING: 15, RUNNING_BASE: 15, RUNNING_SPAN: 30,
    CONVERTING: 48, DOWNLOADED: 50, UNPACKED: 53, IR: 55,
});
const STATE = Object.freeze({ DONE: 'done', FAILED: 'failed', RUNNING: 'running', CONVERTING: 'converting' });

/**
 * @param {{ path: string }} input 源文件绝对路径
 * @param {{ options?: object, sourceName?: string, onProgress?: Function }} [ctx]
 * @param {{ token?: string, source?: string }} [auth] 分派器已解析出的令牌与来源；缺省时本模块自行解析
 * @returns {Promise<object>} MarkFlowDocument
 */
async function parseWithMineru(input, ctx = {}, auth = {}) {
    if (!input || typeof input.path !== 'string' || !input.path) {
        throw new Error('pdf/mineru 需要 input.path（文件绝对路径）');
    }
    const absPath = path.resolve(input.path);
    const options = normalizeOptions(ctx.options);
    const sourceName = ctx.sourceName || path.basename(absPath);
    const resolved = typeof auth.token === 'string' && auth.token
        ? { token: auth.token, source: typeof auth.source === 'string' ? auth.source : '' }
        : await getMineruToken({ explicit: options.mineru.token });
    const { token } = resolved;
    const tokenSource = resolved.source || '';
    if (!token) throw new Error('未配置 MinerU 令牌，无法调用 MinerU 云端解析');

    const progress = createProgress(ctx);
    let dir = null;
    let remote;
    try {
        await assertUploadSize(absPath);
        const batchId = await submit({ absPath, sourceName, options, token });
        progress(PROGRESS.SUBMITTED);
        const task = await poll({ batchId, token, options, progress });
        dir = await makeTempDir(TEMP_PREFIX);
        const zipPath = await download(task.zipUrl, dir);
        progress(PROGRESS.DOWNLOADED);
        const unpacked = await unpack(zipPath, path.join(dir, EXTRACT_DIRNAME));
        progress(PROGRESS.UNPACKED);
        remote = { batchId, task, ...unpacked };
    } catch (err) {
        if (dir) await removeTempDir(dir);
        throw new Error(describeMineruError(err, { token, tokenSource }));
    }

    try {
        const doc = await buildDocument({ remote, ctx, options, sourceName });
        progress(PROGRESS.IR);
        return doc;
    } finally {
        await removeTempDir(dir);
    }
}

// ============================================================
// 提交
// ============================================================

async function assertUploadSize(absPath) {
    const stat = await getStat(absPath);
    if (!stat) {
        const err = new Error(`输入文件不存在：${absPath}`);
        err.code = 'ENOENT';
        throw err;
    }
    if (stat.size > MAX_UPLOAD_BYTES) {
        // 与服务端 -60005 同义，直接复用其中文文案
        const err = new Error(`文件大小 ${stat.size} 字节超过 MinerU 单文件上限`);
        err.code = '-60005';
        throw err;
    }
}

/** SDK 的 submit 完成「取预签名 URL → PUT 上传」，返回 batch_id */
async function submit({ absPath, sourceName, options, token }) {
    const client = getClient(token);
    const m = options.mineru;
    const batchId = await client.submit(absPath, {
        model: m.model,
        ocr: m.ocr,
        formula: m.formula,
        table: m.table,
        language: m.language,
        pages: m.pageRanges || undefined,
        // data_id 便于在 MinerU 控制台按来源认领任务；取 sourceName 的哈希而非原文，长度稳定且不含路径与中文
        fileParams: { [absPath]: { dataId: dataIdOf(sourceName) } },
    });
    if (typeof batchId !== 'string' || !batchId) throw new Error('MinerU 未返回 batch_id');
    return batchId;
}

const dataIdOf = (sourceName) =>
    DATA_ID_PREFIX + crypto.createHash('sha256').update(String(sourceName)).digest('hex').slice(0, DATA_ID_HASH_LEN);

// ============================================================
// 轮询
// ============================================================

async function poll({ batchId, token, options, progress }) {
    const timeoutSec = options.mineru.timeoutSec;
    const deadline = getNow() + timeoutSec * 1000;
    let wait = POLL_START_MS;
    // 页数只在 running 阶段的 extract_progress 里出现，done 响应常常不再带它，故逐轮记下最大值
    let totalPages = 0;
    for (;;) {
        const task = await fetchTask({ batchId, token });
        totalPages = Math.max(totalPages, task.totalPages);
        reportTaskProgress(task, progress);
        if (task.state === STATE.DONE) {
            if (!task.zipUrl) throw new Error('MinerU 任务已完成但未返回结果包地址');
            return { ...task, totalPages };
        }
        if (task.state === STATE.FAILED) throw failedError(task);
        if (getNow() >= deadline) throw timeoutError({ batchId, timeoutSec });
        await getSleep()(Math.min(wait, Math.max(0, deadline - getNow())));
        wait = Math.min(wait * 2, POLL_MAX_MS);
    }
}

/** GET /extract-results/batch/{batch_id} → 归一后的任务状态（单文件提交，只取第一条结果） */
async function fetchTask({ batchId, token }) {
    const res = await getFetch()(`${API_BASE}/extract-results/batch/${encodeURIComponent(batchId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) throw await httpError(res, '查询 MinerU 任务状态');
    const body = await res.json();
    assertApiOk(body);
    const list = (body && body.data && body.data.extract_result) || [];
    const item = Array.isArray(list) && list.length > 0 ? list[0] : null;
    const progress = (item && item.extract_progress) || {};
    return {
        state: item && typeof item.state === 'string' ? item.state : 'pending',
        zipUrl: (item && item.full_zip_url) || '',
        errCode: item && item.err_code != null ? String(item.err_code) : '',
        errMsg: (item && item.err_msg) || '',
        fileName: (item && item.file_name) || '',
        extractedPages: Number(progress.extracted_pages) || 0,
        totalPages: Number(progress.total_pages) || 0,
        batchId,
    };
}

function reportTaskProgress(task, progress) {
    if (task.state === STATE.RUNNING) {
        const ratio = task.totalPages > 0 ? Math.min(task.extractedPages / task.totalPages, 1) : 0;
        progress(PROGRESS.RUNNING_BASE + PROGRESS.RUNNING_SPAN * ratio);
        return;
    }
    if (task.state === STATE.CONVERTING) {
        progress(PROGRESS.CONVERTING);
        return;
    }
    if (task.state !== STATE.DONE && task.state !== STATE.FAILED) progress(PROGRESS.PENDING);
}

// 服务端统一信封：code 非 0 即失败，msg 为英文原因
function assertApiOk(body) {
    if (!body || typeof body !== 'object') throw new Error('MinerU 返回了无法解析的响应');
    if (body.code === 0 || body.code === '0') return;
    const err = new Error(String(body.msg || 'unknown error'));
    err.code = body.code == null ? '' : String(body.code);
    throw err;
}

function failedError(task) {
    const err = new Error(task.errMsg || 'MinerU 解析失败');
    err.code = task.errCode || '-60010';
    return err;
}

function timeoutError({ batchId, timeoutSec }) {
    const err = new Error(`MinerU 任务 ${batchId} 在 ${timeoutSec} 秒内未完成`);
    err.code = TIMEOUT_CODE;
    err.batchId = batchId;
    err.timeoutSec = timeoutSec;
    return err;
}

/** 非 2xx 响应：带上截断的响应体，业务码（msgCode）只在报文里 */
async function httpError(res, action) {
    const body = await res.text().catch(() => '');
    const detail = body ? ` — ${body.slice(0, HTTP_BODY_LIMIT)}` : '';
    const err = new Error(`${action}失败：HTTP ${res.status} ${res.statusText || ''}${detail}`.replace(/\s+—/, ' —').trim());
    err.code = `HTTP_${res.status}`;
    return err;
}

// ============================================================
// 下载与解包
// ============================================================

/** 流式落盘，双重限长：先看 content-length，再在管道里逐块累计 */
async function download(url, dir) {
    const target = String(url || '');
    if (!/^https:\/\//i.test(target)) throw new Error(`MinerU 结果包地址不是 https：${target.slice(0, 120)}`);
    const res = await getFetch()(target, { method: 'GET', redirect: 'follow' });
    if (!res.ok) throw await httpError(res, '下载 MinerU 结果包');

    const declared = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0);
    if (Number.isFinite(declared) && declared > MAX_ZIP_BYTES) throw zipTooLargeError();

    const zipPath = path.join(dir, ZIP_FILENAME);
    await pipeline(await toNodeStream(res), createLimiter(MAX_ZIP_BYTES), fs.createWriteStream(zipPath));
    return zipPath;
}

async function toNodeStream(res) {
    if (res.body && typeof res.body.getReader === 'function') return Readable.fromWeb(res.body);
    if (res.body && typeof res.body.pipe === 'function') return res.body;
    return Readable.from(Buffer.from(await res.arrayBuffer()));
}

function createLimiter(maxBytes) {
    let total = 0;
    return new Transform({
        transform(chunk, encoding, callback) {
            total += chunk.length;
            if (total > maxBytes) {
                callback(zipTooLargeError());
                return;
            }
            callback(null, chunk);
        },
    });
}

function zipTooLargeError() {
    const err = new Error(`MinerU 结果包超过 ${MAX_ZIP_BYTES} 字节上限`);
    err.code = ZIP_TOO_LARGE_CODE;
    return err;
}

/**
 * 解包到 baseDir：全部条目写盘（供 md 图片解析读取）并原样返回。
 * 条目名先经 safeRelative 校验，阻断 zip-slip（绝对路径、".." 穿越、盘符）。
 */
async function unpack(zipPath, baseDir) {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(await fsp.readFile(zipPath));
    const entries = [];
    const warnings = [];
    for (const name of Object.keys(zip.files).sort()) {
        const file = zip.files[name];
        if (file.dir) continue;
        const rel = safeRelative(name);
        if (!rel) {
            warnings.push(`MinerU 结果包中跳过了路径异常的条目：${String(name).slice(0, 120)}`);
            continue;
        }
        const buffer = await file.async('nodebuffer');
        const target = path.join(baseDir, rel);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, buffer);
        entries.push({ name: rel, buffer });
    }
    if (entries.length === 0) throw new Error('MinerU 结果包为空');
    return { entries, warnings, baseDir };
}

/** zip 条目名 → 安全的 posix 相对路径；不安全返回 null */
function safeRelative(name) {
    const rel = String(name == null ? '' : name).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) return null;
    if (/^[A-Za-z]:/.test(rel)) return null;
    const segments = rel.split('/');
    if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
    return rel;
}

// ============================================================
// IR 构建
// ============================================================

async function buildDocument({ remote, ctx, options, sourceName }) {
    const { entries, warnings, baseDir, batchId, task } = remote;
    const markdown = pickMarkdown(entries);
    if (!markdown) throw new Error('MinerU 结果包中没有 Markdown 正文（full.md）');

    // md 解析器自己的进度（30/55）会打乱本模块的映射，这里屏蔽掉；baseDir 指向解包目录，
    // 图片相对引用 images/xxx.jpg 由 assets/md-images 读成 data.asset
    const mdDoc = await md.parse(
        { text: markdown.buffer.toString('utf8') },
        { ...ctx, baseDir, sourceName, onProgress: undefined },
    );
    const { tree } = sanitizeTables(mdDoc.ir);
    const ir = alignImageNames(tree, mdDoc.assets);

    return createDocument({
        kind: 'document',
        ir,
        data: {
            numPages: task.totalPages || null,
            mineru: {
                model: options.mineru.model,
                batchId,
                pages: task.totalPages || null,
                files: entries.map((entry) => entry.name),
            },
        },
        meta: {
            title: (mdDoc.meta && mdDoc.meta.title) || stripExt(sourceName),
            sourceType: 'pdf',
            sourceName,
            pdfParser: 'mineru',
            mineruModel: options.mineru.model,
        },
        assets: mdDoc.assets,
        extras: entries.map((entry) => ({ name: `${EXTRAS_PREFIX}/${entry.name}`, buffer: entry.buffer })),
        warnings: [...(mdDoc.warnings || []), ...warnings],
    });
}

/** 正文优先取根目录的 full.md，其次任意 *full.md，最后任意 .md */
function pickMarkdown(entries) {
    return entries.find((e) => e.name === 'full.md')
        || entries.find((e) => e.name.toLowerCase().endsWith('full.md'))
        || entries.find((e) => e.name.toLowerCase().endsWith('.md'))
        || null;
}

/**
 * 把 image 节点的 url 对齐到 assets 里的资源名（images/image_N.jpg）。
 * md 解析器保留的是 MinerU 原始文件名（images/<hash>.jpg），而资源落盘时用的是统一编号，
 * 两者不一致会让产物 md 里的图片引用指向不存在的文件。按 buffer 引用配对，不重复编号逻辑。
 */
function alignImageNames(tree, assets) {
    const nameByBuffer = new Map();
    for (const asset of assets || []) {
        if (asset && asset.buffer && !nameByBuffer.has(asset.buffer)) nameByBuffer.set(asset.buffer, asset.name);
    }
    if (nameByBuffer.size === 0) return tree;

    const mapNode = (node) => {
        if (!node || typeof node !== 'object') return node;
        if (node.type === 'image' && node.data && node.data.asset) {
            const name = nameByBuffer.get(node.data.asset.buffer);
            if (!name || node.url === name) return node;
            return { ...node, url: name, data: { ...node.data, assetName: name } };
        }
        if (!Array.isArray(node.children)) return node;
        const children = node.children.map(mapNode);
        return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
    };
    return mapNode(tree);
}

// ============================================================
// 进度
// ============================================================

// 上报一律归一为 parsing 阶段；本模块内强制单调不减且不超过 55
function createProgress(ctx) {
    let last = -Infinity;
    return (pct) => {
        const value = Math.min(Math.max(Math.round(pct), 0), PROGRESS.IR);
        if (value < last) return;
        last = value;
        notify(ctx, 'parsing', value);
    };
}

// ============================================================
// 可注入依赖
// ============================================================

let deps = {};
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getClient(token) {
    if (deps.client) return deps.client;
    const { MinerU } = require('mineru-open-sdk');
    return new MinerU(token);
}
const getFetch = () => deps.fetch || fetch;
const getNow = () => (deps.now ? deps.now() : Date.now());
const getSleep = () => deps.sleep || defaultSleep;
const getStat = (target) => (deps.stat ? deps.stat(target) : statOrNull(target));

/** 测试钩子：{ client, fetch, now, sleep, stat } */
function _setDeps(next = {}) { deps = { ...deps, ...next }; }
function _reset() { deps = {}; }

module.exports = {
    parseWithMineru,
    API_BASE, MAX_UPLOAD_BYTES, MAX_ZIP_BYTES, PROGRESS,
    _setDeps, _reset,
};
