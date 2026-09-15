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
 *      jszip 解包；full.md 交 parsers/md.parse({ text }, { baseDir }) 构 IR，图片经 md-images 读成 assets；
 *   5) IR 里 MinerU 写成原始 HTML 的表格交 ir/sanitize-table 处理（规则表转 mdast，合并单元格白名单清洗）；
 *   6) 仿照 MinerU 结果包整理产物（产物名占位符 {name} 由 converters/output.js 替换）：
 *      - 图片：*_content_list.json 的 0–1000 归一化 bbox × layout.json 的 page_size（pt）× 96/72 → data.display（px），
 *        原始路径记 data.sourcePath；content_list 的 image_caption / image_footnote 文字相同的段落从正文移出，
 *        改为紧随图片的 caption / image_footnote 段落（找不到则补一段）；
 *        full.md 未引用的包内图片（表格截图、印章等）续编号进 assets，使附属 JSON 的每个图片路径都有着落；
 *      - 附属文件按 packageNameFor 改名：full.md 与 images/* 丢弃（已进 IR 与 assets），
 *        *_content_list.json → {name}_content_list.json（补 display），*_content_list_v2.json → {name}_content_list_v2.json，
 *        *_model.json → {name}_model.json，layout.json → {name}_layout.json，*_origin.pdf → {name}_origin.pdf，
 *        其余 → {name}_<文件名>；其中的哈希图名由 converters/index.js 渲染时改写为 images/image_N.*（layout 为裸名）。
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
const { stripExt, collectText } = require('../ir/util');
const { normalizeOptions } = require('../options');
const { NAME_TOKEN } = require('../output');
const { detectIndent } = require('../bundle-sidecars');
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
const DATA_ID_PREFIX = 'markflow-';
/** content_list 的 bbox 为 0–1000 归一化坐标，page_size 为 pt；显示尺寸按 96 dpi 折算 px */
const BBOX_SCALE = 1000;
const PX_PER_PT = 96 / 72;
const CONTENT_LIST_RE = /_content_list\.json$/i;
const CONTENT_LIST_V2_RE = /_content_list_v2\.json$/i;
const IMAGE_DIR_RE = /^images\//;
const IMAGE_ENTRY_RE = /^images\/[^/]+\.(?:jpe?g|png|gif|webp|bmp|tiff?)$/i;
const IMAGE_MIME_BY_EXT = Object.freeze({
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
});
/** 图注回填时在图片前后各看几段 */
const CAPTION_SEARCH_WINDOW = 3;
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
    const layoutWarnings = [];
    const layout = readPackageLayout(entries, layoutWarnings);
    const ir = placeCaptions(locateImages(alignImageNames(tree, mdDoc.assets), baseDir, layout), layout);

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
        assets: packageAssets(mdDoc.assets, ir, entries),
        extras: packageExtras(entries, markdown, layout),
        warnings: [...(mdDoc.warnings || []), ...warnings, ...layoutWarnings],
    });
}

// ============================================================
// MinerU 结果包整理：显示尺寸、图注、附属文件改名
// ============================================================

/** 读 *_content_list.json（非 v2）与 layout.json 的 page_size，得到「图片路径 → 块与显示尺寸」 */
function readPackageLayout(entries, warnings) {
    const listEntry = entries.find((entry) => CONTENT_LIST_RE.test(entry.name) && !CONTENT_LIST_V2_RE.test(entry.name)) || null;
    const layoutEntry = entries.find((entry) => path.posix.basename(entry.name) === 'layout.json') || null;
    const parsedList = parseJsonEntry(listEntry, warnings);
    const contentList = Array.isArray(parsedList) ? parsedList : null;
    const layoutJson = parseJsonEntry(layoutEntry, warnings);
    const pageSizes = new Map();
    const pages = layoutJson && Array.isArray(layoutJson.pdf_info) ? layoutJson.pdf_info : [];
    pages.forEach((page, index) => {
        const size = page && page.page_size;
        if (!Array.isArray(size) || size.length < 2) return;
        pageSizes.set(Number.isInteger(page.page_idx) ? page.page_idx : index, [Number(size[0]), Number(size[1])]);
    });
    const byPath = new Map();
    for (const block of contentList || []) {
        if (!block || typeof block.img_path !== 'string' || !block.img_path || byPath.has(block.img_path)) continue;
        byPath.set(block.img_path, { block, display: displayFromBbox(block, pageSizes) });
    }
    return { listEntry, contentList, byPath };
}

function parseJsonEntry(entry, warnings) {
    if (!entry) return null;
    try {
        return JSON.parse(entry.buffer.toString('utf8'));
    } catch (err) {
        warnings.push(`MinerU 结果包中的 ${entry.name} 不是合法 JSON，图片尺寸与图注按缺失处理`);
        return null;
    }
}

function displayFromBbox(block, pageSizes) {
    const bbox = Array.isArray(block.bbox) ? block.bbox.map(Number) : [];
    if (bbox.length < 4 || bbox.some((value) => !Number.isFinite(value))) return null;
    const size = pageSizes.get(Number.isInteger(block.page_idx) ? block.page_idx : 0);
    if (!size || !(size[0] > 0) || !(size[1] > 0)) return null;
    const [x0, y0, x1, y1] = bbox;
    const width = Math.round(((x1 - x0) / BBOX_SCALE) * size[0] * PX_PER_PT);
    const height = Math.round(((y1 - y0) / BBOX_SCALE) * size[1] * PX_PER_PT);
    if (!(width >= 1)) return null;
    const display = { width };
    if (height >= 1) display.height = height;
    display.unit = 'px';
    display.source = 'mineru';
    return display;
}

/** 图片节点记下包内原始路径（data.sourcePath，由 data.asset.absPath 反推）与 content_list 给出的显示尺寸 */
function locateImages(tree, baseDir, layout) {
    const mapNode = (node) => {
        if (!node || typeof node !== 'object') return node;
        if (node.type === 'image') {
            const sourcePath = sourcePathOf(node, baseDir);
            if (!sourcePath) return node;
            const info = layout.byPath.get(sourcePath);
            const data = { ...(node.data || {}), sourcePath };
            if (info && info.display) data.display = info.display;
            // 解包目录在本模块返回前删除，absPath 随之失效；置空以免把本机临时路径写进 {name}.json
            if (data.asset) data.asset = { ...data.asset, absPath: null };
            return { ...node, data };
        }
        if (!Array.isArray(node.children)) return node;
        const children = node.children.map(mapNode);
        return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
    };
    return mapNode(tree);
}

function sourcePathOf(node, baseDir) {
    const absPath = node.data && node.data.asset && node.data.asset.absPath;
    if (typeof absPath !== 'string' || !absPath) return null;
    const rel = path.relative(baseDir, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
}

/**
 * content_list 的 image_caption / image_footnote 归位：与之文字相同的段落（图片前后 3 段内）移出正文，
 * 改为紧随图片的 caption / image_footnote 段落；找不到时补一段
 */
function placeCaptions(tree, layout) {
    if (!tree || !Array.isArray(tree.children) || layout.byPath.size === 0) return tree;
    const out = [...tree.children];
    let changed = false;
    for (let index = 0; index < out.length; index += 1) {
        const info = layout.byPath.get(imageSourceOfParagraph(out[index]));
        const block = info && info.block;
        if (!block) continue;
        const groups = [[textList(block.image_caption), 'caption'], [textList(block.image_footnote), 'image_footnote']];
        const inserted = [];
        for (const [texts, role] of groups) {
            for (const text of texts) {
                const at = findParagraphNear(out, index, text);
                let paragraph = { type: 'paragraph', children: [{ type: 'text', value: text }] };
                if (at >= 0) {
                    [paragraph] = out.splice(at, 1);
                    if (at < index) index -= 1;
                }
                inserted.push({ ...paragraph, data: { ...(paragraph.data || {}), role } });
            }
        }
        if (inserted.length === 0) continue;
        out.splice(index + 1, 0, ...inserted);
        index += inserted.length;
        changed = true;
    }
    return changed ? { ...tree, children: out } : tree;
}

// 只含一张图片的段落 → 该图片的 sourcePath；否则 null
function imageSourceOfParagraph(node) {
    if (!node || node.type !== 'paragraph' || !Array.isArray(node.children)) return null;
    const visible = node.children.filter((child) => !(child.type === 'text' && !String(child.value || '').trim()));
    if (visible.length !== 1 || visible[0].type !== 'image') return null;
    return (visible[0].data && visible[0].data.sourcePath) || null;
}

const textList = (value) => (Array.isArray(value) ? value : [])
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim());
const normalizeText = (text) => String(text || '').replace(/\s+/g, ' ').trim();

function findParagraphNear(list, index, text) {
    const target = normalizeText(text);
    for (let offset = 1; offset <= CAPTION_SEARCH_WINDOW; offset += 1) {
        for (const at of [index + offset, index - offset]) {
            const node = list[at];
            if (node && node.type === 'paragraph' && normalizeText(collectText(node)) === target) return at;
        }
    }
    return -1;
}

/** assets 标注包内原始路径（sourcePath）；full.md 未引用的包内图片续编号补入，保证附属 JSON 的图片路径都有着落 */
function packageAssets(mdAssets, ir, entries) {
    const sourceByName = new Map();
    walkImages(ir, (node) => {
        const sourcePath = node.data && node.data.sourcePath;
        const name = (node.data && node.data.assetName) || node.url;
        if (sourcePath && name && !sourceByName.has(name)) sourceByName.set(name, sourcePath);
    });
    const assets = (mdAssets || []).map((asset) => (sourceByName.has(asset.name) ? { ...asset, sourcePath: sourceByName.get(asset.name) } : asset));
    const known = new Set(assets.map((asset) => asset.sourcePath).filter(Boolean));
    for (const entry of entries) {
        if (!IMAGE_ENTRY_RE.test(entry.name) || known.has(entry.name)) continue;
        const ext = path.posix.extname(entry.name).toLowerCase();
        assets.push({ name: `images/image_${assets.length + 1}${ext}`, buffer: entry.buffer, mime: IMAGE_MIME_BY_EXT[ext] || 'application/octet-stream', sourcePath: entry.name });
        known.add(entry.name);
    }
    return assets;
}

function walkImages(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'image') visit(node);
    if (Array.isArray(node.children)) for (const child of node.children) walkImages(child, visit);
}

/** 附属文件：丢弃 full.md 与 images/*，其余按 packageNameFor 改名；content_list 补上 display */
function packageExtras(entries, markdownEntry, layout) {
    const used = new Set();
    const extras = [];
    for (const entry of entries) {
        if (entry === markdownEntry || IMAGE_DIR_RE.test(entry.name)) continue;
        let name = packageNameFor(entry.name);
        if (used.has(name)) name = `${NAME_TOKEN}_${entry.name.replace(/\//g, '_')}`;
        if (used.has(name)) continue;
        used.add(name);
        const buffer = entry === layout.listEntry ? contentListWithDisplay(entry, layout) : entry.buffer;
        extras.push({ name, buffer });
    }
    return extras;
}

function packageNameFor(entryName) {
    const base = path.posix.basename(entryName);
    if (CONTENT_LIST_V2_RE.test(base)) return `${NAME_TOKEN}_content_list_v2.json`;
    if (CONTENT_LIST_RE.test(base)) return `${NAME_TOKEN}_content_list.json`;
    if (/_model\.json$/i.test(base)) return `${NAME_TOKEN}_model.json`;
    if (base === 'layout.json') return `${NAME_TOKEN}_layout.json`;
    if (/_origin\.pdf$/i.test(base)) return `${NAME_TOKEN}_origin.pdf`;
    return `${NAME_TOKEN}_${base}`;
}

function contentListWithDisplay(entry, layout) {
    if (!layout.contentList) return entry.buffer;
    let changed = false;
    const list = layout.contentList.map((block) => {
        if (!block || block.type !== 'image' || typeof block.img_path !== 'string') return block;
        const info = layout.byPath.get(block.img_path);
        if (!info || !info.display) return block;
        changed = true;
        return { ...block, display: info.display };
    });
    if (!changed) return entry.buffer;
    return Buffer.from(JSON.stringify(list, null, detectIndent(entry.buffer.toString('utf8'))), 'utf8');
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
