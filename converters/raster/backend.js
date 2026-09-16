/**
 * 栅格化后端（两级回退）：把自包含的 HTML 片段页渲染为 PNG Buffer
 *   ⓪ 进程内后端     —— 桌面端主进程经 registerInProcess({ name, rasterize }) 注册（自身即 Electron，
 *                        offscreen 窗口 + CDP 截图），注册后 detect / rasterize 一律优先取用，name 原样返回；
 *   ① electron-worker —— 项目内装有 electron 二进制：把 jobs.json 与各片段写入 tmp.makeTempDir 工作目录，
 *                        spawn 独立 Electron 运行 converters/raster/electron-raster-worker.js 一次处理整批
 *                        （串行排队；超时 = 60s + 10s × 任务数，可由 timeoutMs 覆盖）；
 *   ② 二者皆无        —— detect 返回 available:false 与中文提示，rasterize 抛中文错误。
 *
 * detect() → { name, available, hint }
 * rasterize(jobs, { dpi = 300, timeoutMs }) → Promise<Map<id, Buffer | Error>>
 *   - jobs 为 [{ id, html }]：id 兼作文件名（^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$，批内唯一），html 为完整片段页；
 *   - dpi 决定截图缩放（scale = dpi / 96，PNG 像素 = 片段 CSS 像素 × scale）；
 *   - 单任务失败不影响其它任务：该 id 的值为 Error（message 为中文原因）；整批失败（进程崩溃、超时、
 *     未写出 results.json）才抛错；空任务表直接返回空 Map，不启动进程。
 * registerInProcess({ name, rasterize })：rasterize(jobs, { dpi }) → Promise<Map<id, Buffer>>，缺失或非 Buffer
 *   的条目在本模块归一为 Error；unregisterInProcess() 注销。
 *
 * 工作目录布局（由本模块写入，工作进程只读 jobs.json 并写 out/）：
 *   jobs.json           { version: 1, dpi, jobs: [{ id, file }] }（file 为片段页绝对路径）
 *   fragments/<id>.html 片段页
 *   out/<id>.png        截图产物；out/results.json 为 { version: 1, results: [{ id, ok, file?, width?, height?, scale?, error? }] }
 *   profile/            工作进程独立的 userData / sessionData
 * 模块顶层不 require electron；electron 路径经 chromium/spawn.js 的 getElectronPath 惰性探测。
 * 模块加载时异步清理 os.tmpdir() 下修改时间超过 1 天的 markflow-raster-* 残留目录。
 * 依赖可经 _setDeps 注入以便测试，_reset 恢复真实实现并清空进程内注册。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const tmp = require('../tmp');
const { spawnElectron, assertExitOk, getElectronPath } = require('../chromium/spawn');

const WORKER_SCRIPT = path.join(__dirname, 'electron-raster-worker.js');
const WORKER_LABEL = 'Electron 栅格工作进程';
const WORKER_BACKEND_NAME = 'electron-worker';
const TEMP_PREFIX = 'markflow-raster-';
const JOBS_FILE = 'jobs.json';
const RESULTS_FILE = 'results.json';
const FRAGMENTS_DIR = 'fragments';
const OUT_DIR = 'out';
const PROFILE_DIR = 'profile';
const JOBS_VERSION = 1;
const DEFAULT_DPI = 300;
const MIN_DPI = 1;
const MAX_DPI = 2400;
const MAX_JOBS = 2000;
const BASE_TIMEOUT_MS = 60000;
const PER_JOB_TIMEOUT_MS = 10000;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

let overrides = {};
let inProcess = null;
let workerQueue = Promise.resolve();

const noop = () => undefined;
const attempt = (fn) => { try { return fn(); } catch (err) { return null; } };

// ---- 探测 ----

/** electron 二进制路径：测试可经 _setDeps({ electronPath }) 注入；文件不存在视同未安装 */
function findElectronBinary() {
    if (!('electronPath' in overrides)) return getElectronPath();
    const electronPath = overrides.electronPath;
    if (typeof electronPath !== 'string' || !electronPath) return null;
    return attempt(() => (fs.existsSync(electronPath) ? electronPath : null));
}

const getWorkerScript = () => overrides.workerScript || WORKER_SCRIPT;

function buildHint() {
    return '表格与公式栅格化需要以下任一环境：'
        + '① 项目目录已安装 electron 依赖（执行 npm install 后自动可用）；'
        + '② 在 MarkFlow 桌面端内运行（主进程注册进程内后端）。'
        + '不可用时表格降级为逐行文本、公式降级为线性化文本。';
}

/**
 * @returns {Promise<{ name: string|null, available: boolean, hint: string }>}
 *   name 为进程内后端的注册名或 'electron-worker'；皆不可用时为 null 并附中文提示
 */
async function detect() {
    if (inProcess) return { name: inProcess.name, available: true, hint: '' };
    if (findElectronBinary()) return { name: WORKER_BACKEND_NAME, available: true, hint: '' };
    return { name: null, available: false, hint: buildHint() };
}

// ---- 进程内注册 ----

function registerInProcess({ name, rasterize: render } = {}) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('registerInProcess 需要非空的后端名 name');
    if (typeof render !== 'function') throw new Error('registerInProcess 需要 rasterize(jobs, { dpi }) 函数');
    inProcess = { name: name.trim(), rasterize: render };
}

function unregisterInProcess() {
    inProcess = null;
}

// ---- 栅格化 ----

async function rasterize(jobs, { dpi = DEFAULT_DPI, timeoutMs } = {}) {
    const list = normalizeJobs(jobs);
    const density = normalizeDpi(dpi);
    if (list.length === 0) return new Map();
    if (inProcess) return normalizeResult(await inProcess.rasterize(list, { dpi: density }), list);

    const electronPath = findElectronBinary();
    if (!electronPath) throw new Error(`栅格化后端不可用：${buildHint()}`);
    const task = () => runWorker(list, electronPath, { dpi: density, timeoutMs });
    const run = workerQueue.then(task, task);
    workerQueue = run.then(noop, noop);
    return run;
}

/** 任务表校验：数组、id 合法且唯一、html 为非空字符串；返回只含 id/html 的新数组 */
function normalizeJobs(jobs) {
    if (!Array.isArray(jobs)) throw new Error('rasterize 的 jobs 须为 [{ id, html }] 数组');
    if (jobs.length > MAX_JOBS) throw new Error(`rasterize 单批任务数不得超过 ${MAX_JOBS}（实际 ${jobs.length}）`);
    const seen = new Set();
    return jobs.map((job, index) => {
        const id = job && typeof job.id === 'string' ? job.id : '';
        if (!JOB_ID_RE.test(id)) throw new Error(`第 ${index + 1} 个栅格任务的 id 非法：${JSON.stringify(id)}`);
        if (seen.has(id)) throw new Error(`栅格任务 id 重复：${id}`);
        if (!job || typeof job.html !== 'string' || !job.html) throw new Error(`栅格任务 ${id} 缺少 html`);
        seen.add(id);
        return { id, html: job.html };
    });
}

function normalizeDpi(dpi) {
    const value = Number(dpi);
    if (!Number.isFinite(value) || value < MIN_DPI || value > MAX_DPI) {
        throw new Error(`rasterize 的 dpi 须为 ${MIN_DPI}–${MAX_DPI} 之间的数字，实际：${String(dpi)}`);
    }
    return value;
}

/** 进程内后端的返回值归一：接受 Map 或普通对象；每个任务 id 落为 Buffer 或 Error */
function normalizeResult(raw, list) {
    const lookup = raw instanceof Map ? (id) => raw.get(id)
        : raw && typeof raw === 'object' ? (id) => raw[id]
            : null;
    if (!lookup) throw new Error('进程内栅格后端须返回 Map<id, Buffer>');
    const out = new Map();
    for (const job of list) {
        const value = lookup(job.id);
        if (Buffer.isBuffer(value) && value.length > 0) out.set(job.id, value);
        else if (value instanceof Error) out.set(job.id, value);
        else out.set(job.id, new Error('后端未返回该任务的图像'));
    }
    return out;
}

const resolveTimeout = (timeoutMs, count) =>
    (Number(timeoutMs) > 0 ? Number(timeoutMs) : BASE_TIMEOUT_MS + PER_JOB_TIMEOUT_MS * count);

async function runWorker(list, electronPath, { dpi, timeoutMs }) {
    const workDir = await tmp.makeTempDir(TEMP_PREFIX);
    try {
        const { jobsPath, outDir, profileDir } = await writeWorkDir(workDir, list, dpi);
        const result = await spawnElectron(
            electronPath,
            [getWorkerScript(), jobsPath, outDir, profileDir],
            { timeoutMs: resolveTimeout(timeoutMs, list.length), spawn: overrides.spawn },
        );
        assertExitOk(result, WORKER_LABEL);
        return await collectResults(list, outDir);
    } finally {
        await tmp.removeTempDir(workDir);
    }
}

async function writeWorkDir(workDir, list, dpi) {
    const fragmentsDir = path.join(workDir, FRAGMENTS_DIR);
    const outDir = path.join(workDir, OUT_DIR);
    const profileDir = path.join(workDir, PROFILE_DIR);
    await fsp.mkdir(fragmentsDir);
    await fsp.mkdir(outDir);
    const entries = [];
    for (const job of list) {
        const file = path.join(fragmentsDir, `${job.id}.html`);
        await fsp.writeFile(file, job.html, 'utf8');
        entries.push({ id: job.id, file });
    }
    const jobsPath = path.join(workDir, JOBS_FILE);
    await fsp.writeFile(jobsPath, JSON.stringify({ version: JOBS_VERSION, dpi, jobs: entries }), 'utf8');
    return { jobsPath, outDir, profileDir };
}

/** 读 results.json 并按任务表逐项取图；缺条目、缺文件或非 PNG 一律记为该任务的 Error */
async function collectResults(list, outDir) {
    const raw = await fsp.readFile(path.join(outDir, RESULTS_FILE), 'utf8').catch(() => null);
    if (raw === null) throw new Error(`${WORKER_LABEL}未写出 ${RESULTS_FILE}`);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(`${WORKER_LABEL}写出的 ${RESULTS_FILE} 不是合法 JSON`);
    }
    const entries = new Map();
    for (const item of (parsed && Array.isArray(parsed.results) ? parsed.results : [])) {
        if (item && typeof item.id === 'string') entries.set(item.id, item);
    }

    const out = new Map();
    for (const job of list) {
        const entry = entries.get(job.id);
        if (!entry) { out.set(job.id, new Error('工作进程未返回该任务的结果')); continue; }
        if (!entry.ok) { out.set(job.id, new Error(String(entry.error || '工作进程未说明原因'))); continue; }
        const fileName = typeof entry.file === 'string' && entry.file ? path.basename(entry.file) : `${job.id}.png`;
        const png = await fsp.readFile(path.join(outDir, fileName)).catch(() => null);
        if (!png || png.length <= PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
            out.set(job.id, new Error('工作进程写出的图像不是合法 PNG'));
            continue;
        }
        out.set(job.id, png);
    }
    return out;
}

// ---- 残留临时目录清理 ----

const cleanupStaleTempDirs = (now = Date.now()) => tmp.cleanupStaleTempDirs({ matchPrefix: TEMP_PREFIX, now });

cleanupStaleTempDirs().catch(noop);

/** 覆盖依赖：{ electronPath, spawn, workerScript } */
function _setDeps(next = {}) {
    overrides = { ...overrides, ...next };
}

/** 恢复真实依赖并清空进程内注册与队列 */
function _reset() {
    overrides = {};
    inProcess = null;
    workerQueue = Promise.resolve();
}

module.exports = {
    detect, rasterize, registerInProcess, unregisterInProcess,
    _setDeps, _reset, _cleanupStaleTempDirs: cleanupStaleTempDirs,
    JOB_ID_RE, JOBS_VERSION, WORKER_BACKEND_NAME,
};
