/**
 * PDF 出图后端（三级回退）
 *
 * 职责：把 HTML（必要时改用 DOCX）渲染为 PDF Buffer，按运行环境自动选择后端：
 *   ① electron        —— 当前进程就是 Electron 主进程，直接用 electron/pdf-printer 打印；
 *   ② electron-worker —— 普通 Node 进程但项目内装有 electron 二进制，spawn 独立 Electron
 *                        运行 electron/pdf-worker.js 打印（串行排队，超时 60s）；
 *   ③ soffice         —— 本机装有 LibreOffice，先由 getDocxBuffer 生成 DOCX，再 soffice 转 PDF；
 *   ④ 三者皆无        —— 抛中文错误并附安装/使用提示。
 * 探测结果缓存：成功永久缓存，失败缓存 60s 后可重探；detect({ force:true }) 强制重探。
 * 依赖可经 _setDeps 注入以便测试，_reset 恢复真实实现并清空缓存。
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const WORKER_TIMEOUT_MS = 60000;
const DETECT_FAILURE_TTL_MS = 60000;
const TEMP_PREFIX = 'markflow-pdf-';
const STDERR_KEEP_LIMIT = 4096;
const STDERR_EXCERPT_LIMIT = 500;
const PDF_MAGIC = '%PDF';
const WORKER_SCRIPT = path.join(__dirname, '..', '..', 'electron', 'pdf-worker.js');

let overrides = {};
let detectCache = null;
let detectFailedAt = 0;
let workerQueue = Promise.resolve();

// ============================================================
// 依赖装载（可被 _setDeps 覆盖）
// ============================================================

function getPrinter() {
    if ('printer' in overrides) return overrides.printer;
    try {
        return require('../../electron/pdf-printer');
    } catch (err) {
        return null;
    }
}

function getElectronPath() {
    if ('electronPath' in overrides) return overrides.electronPath;
    try {
        const mod = require('electron');
        return typeof mod === 'string' && mod ? mod : null;
    } catch (err) {
        return null;
    }
}

function getSoffice() {
    if ('soffice' in overrides) return overrides.soffice;
    try {
        return require('../../server/soffice');
    } catch (err) {
        return null;
    }
}

function getSpawn() {
    return typeof overrides.spawn === 'function' ? overrides.spawn : spawn;
}

function getWorkerScript() {
    return overrides.workerScript || WORKER_SCRIPT;
}

function getWorkerTimeoutMs() {
    return Number(overrides.workerTimeoutMs) > 0 ? Number(overrides.workerTimeoutMs) : WORKER_TIMEOUT_MS;
}

// ============================================================
// 探测
// ============================================================

function isPrinterAvailable() {
    const printer = getPrinter();
    try {
        return !!(printer && typeof printer.isAvailable === 'function' && printer.isAvailable());
    } catch (err) {
        return false;
    }
}

function findElectronBinary() {
    const electronPath = getElectronPath();
    if (!electronPath || typeof electronPath !== 'string') return null;
    try {
        return fs.existsSync(electronPath) ? electronPath : null;
    } catch (err) {
        return null;
    }
}

async function isSofficeAvailable() {
    const soffice = getSoffice();
    if (!soffice || typeof soffice.isAvailable !== 'function') return false;
    try {
        return !!(await soffice.isAvailable());
    } catch (err) {
        return false;
    }
}

function buildHint() {
    const soffice = getSoffice();
    const sofficeHint =
        soffice && typeof soffice.getInstallHint === 'function'
            ? soffice.getInstallHint()
            : '前往 https://www.libreoffice.org/download/ 安装 LibreOffice';
    return (
        'PDF 输出需要以下任一环境：' +
        '① 在 MarkFlow 桌面端（Electron）内运行；' +
        '② 项目目录已安装 electron 依赖（执行 npm install 后自动可用）；' +
        `③ 本机安装 LibreOffice（${sofficeHint}）。`
    );
}

async function probe() {
    if (isPrinterAvailable()) return { name: 'electron', available: true, hint: '' };
    if (findElectronBinary()) return { name: 'electron-worker', available: true, hint: '' };
    if (await isSofficeAvailable()) return { name: 'soffice', available: true, hint: '' };
    return { name: null, available: false, hint: buildHint() };
}

/**
 * 探测可用后端（结果缓存）
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<{ name: 'electron'|'electron-worker'|'soffice'|null, available: boolean, hint: string }>}
 */
async function detect({ force = false } = {}) {
    if (!force && detectCache) {
        const failureFresh = Date.now() - detectFailedAt < DETECT_FAILURE_TTL_MS;
        if (detectCache.available || failureFresh) return detectCache;
    }
    const result = await probe();
    detectCache = result;
    detectFailedAt = result.available ? 0 : Date.now();
    return result;
}

/** 同步探测：覆盖能同步判定的 ①② 与已缓存的成功结果，供 server.js 之类的同步调用方使用 */
function isAvailableSync() {
    if (detectCache && detectCache.available) return true;
    return isPrinterAvailable() || !!findElectronBinary();
}

// ============================================================
// 渲染
// ============================================================

/**
 * @param {{ html: string, getDocxBuffer?: () => Promise<Buffer> }} params
 * @returns {Promise<Buffer>}
 */
async function renderPdf({ html, getDocxBuffer } = {}) {
    if (typeof html !== 'string') throw new Error('renderPdf 需要 html 字符串');

    if (isPrinterAvailable()) {
        return ensurePdf(await getPrinter().printToPdf(html), 'electron');
    }
    const electronPath = findElectronBinary();
    if (electronPath) {
        return ensurePdf(await renderViaWorker(html, electronPath), 'electron-worker');
    }
    if (await isSofficeAvailable()) {
        return ensurePdf(await renderViaSoffice(getDocxBuffer), 'soffice');
    }
    throw new Error(`PDF 输出不可用：未找到可用的渲染后端。${buildHint()}`);
}

function ensurePdf(output, backendName) {
    const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output || []);
    if (buffer.length < PDF_MAGIC.length || buffer.subarray(0, PDF_MAGIC.length).toString('latin1') !== PDF_MAGIC) {
        throw new Error(`PDF 后端 ${backendName} 返回的内容不是合法 PDF`);
    }
    return buffer;
}

// ---- ② 独立 Electron 工作进程 ----

/** 串行排队：Electron 实例开销大，同一时刻只跑一个工作进程 */
function renderViaWorker(html, electronPath) {
    const task = () => runWorker(html, electronPath);
    const run = workerQueue.then(task, task);
    workerQueue = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

async function runWorker(html, electronPath) {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `${TEMP_PREFIX}worker-`));
    const inPath = path.join(tmpDir, 'index.html');
    const outPath = path.join(tmpDir, 'output.pdf');
    const profileDir = path.join(tmpDir, 'profile');
    try {
        await fsp.writeFile(inPath, html, 'utf8');
        await spawnWorker(electronPath, [getWorkerScript(), inPath, outPath, profileDir]);
        return await fsp.readFile(outPath);
    } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

function spawnWorker(electronPath, args) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;

        let child;
        try {
            child = getSpawn()(electronPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        } catch (err) {
            reject(wrapSpawnError(err));
            return;
        }

        let stderr = '';
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };
        const timeoutMs = getWorkerTimeoutMs();
        const timer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch (err) {
                // 进程可能已退出
            }
            finish(reject, new Error(`Electron PDF 工作进程超时（${Math.round(timeoutMs / 1000)}s），已强制结束`));
        }, timeoutMs);

        if (child.stderr) {
            child.stderr.on('data', (chunk) => {
                if (stderr.length < STDERR_KEEP_LIMIT) stderr += String(chunk);
            });
        }
        child.on('error', (err) => finish(reject, wrapSpawnError(err)));
        child.on('exit', (code, signal) => {
            if (code === 0) {
                finish(resolve);
                return;
            }
            const detail = excerpt(stderr) || '无 stderr 输出';
            const signalText = signal ? `, signal=${signal}` : '';
            finish(reject, new Error(`Electron PDF 工作进程退出异常（code=${code}${signalText}）：${detail}`));
        });
    });
}

function wrapSpawnError(err) {
    const wrapped = new Error(`无法启动 Electron PDF 工作进程：${err && err.message ? err.message : err}`);
    wrapped.code = 'ELECTRON_SPAWN_FAILED';
    wrapped.cause = err;
    return wrapped;
}

function excerpt(text) {
    return String(text || '')
        .trim()
        .slice(0, STDERR_EXCERPT_LIMIT);
}

// ---- ③ LibreOffice：DOCX → PDF ----

async function renderViaSoffice(getDocxBuffer) {
    if (typeof getDocxBuffer !== 'function') {
        throw new Error('soffice 后端需要 getDocxBuffer 以先生成 DOCX');
    }
    const docx = await getDocxBuffer();
    if (!Buffer.isBuffer(docx) || docx.length === 0) {
        throw new Error('getDocxBuffer 未返回有效的 DOCX Buffer');
    }

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `${TEMP_PREFIX}soffice-`));
    try {
        const docxPath = path.join(tmpDir, 'document.docx');
        await fsp.writeFile(docxPath, docx);
        const pdfPath = await getSoffice().convertFile(docxPath, 'pdf', { outDir: tmpDir });
        return await fsp.readFile(pdfPath);
    } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

// ============================================================
// 测试注入钩子
// ============================================================

/** 覆盖依赖：{ printer, electronPath, soffice, spawn, workerScript, workerTimeoutMs }；传入后清空探测缓存 */
function _setDeps(next = {}) {
    overrides = { ...overrides, ...next };
    detectCache = null;
    detectFailedAt = 0;
}

/** 恢复真实依赖并清空缓存与队列 */
function _reset() {
    overrides = {};
    detectCache = null;
    detectFailedAt = 0;
    workerQueue = Promise.resolve();
}

module.exports = {
    detect,
    renderPdf,
    isAvailableSync,
    WORKER_TIMEOUT_MS,
    _setDeps,
    _reset,
};
