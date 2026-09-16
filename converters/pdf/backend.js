/**
 * PDF 出图后端（三级回退）：把 HTML（必要时改用 DOCX）渲染为 PDF Buffer，
 * 按运行环境依次尝试候选表：
 *   ⓪ 进程内后端     —— 桌面端主进程经 registerInProcess({ name, render }) 注册（自身即 Electron，
 *                        隐藏窗口 printToPDF），注册后 detect / renderPdf 一律优先取用，name 原样返回；
 *   ① electron-worker —— 项目内装有 electron 二进制，spawn 独立 Electron 无界面运行
 *                        converters/pdf/electron-worker.js 打印（串行排队，超时 60s）；
 *   ② soffice         —— 本机装有 LibreOffice，先由 getDocxBuffer 生成 DOCX，再 soffice 转 PDF；
 *   ③ 三者皆无        —— 抛中文错误并附安装/使用提示。
 * 子进程的 env 清洗、超时 SIGKILL 与 stderr 摘要统一由 converters/chromium/spawn.js 提供。
 * 探测结果缓存：成功永久缓存，失败缓存 60s 后可重探；detect({ force:true }) 强制重探；
 * 注册 / 注销进程内后端即清空缓存。
 * 模块加载时异步清理 os.tmpdir() 下修改时间超过 1 天的 markflow-pdf-* 残留目录
 * （上次异常退出遗留的工作目录，正常路径已在 finally 中清理）。
 * 依赖可经 _setDeps 注入以便测试，_reset 恢复真实实现并清空缓存与进程内注册。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const tmp = require('../tmp');
const { spawnElectron, assertExitOk, getElectronPath } = require('../chromium/spawn');

const WORKER_TIMEOUT_MS = 60000;
const WORKER_LABEL = 'Electron PDF 工作进程';
const DETECT_FAILURE_TTL_MS = 60000;
const TEMP_PREFIX = 'markflow-pdf-';
const PDF_MAGIC = '%PDF';
const WORKER_SCRIPT = path.join(__dirname, 'electron-worker.js');

let overrides = {};
let inProcess = null;
let detectCache = null;
let detectFailedAt = 0;
let workerQueue = Promise.resolve();

const noop = () => undefined;
/** 同步执行 fn 并吞掉异常，失败返回 null */
const attempt = (fn) => { try { return fn(); } catch (err) { return null; } };

// ---- 依赖装载（可被 _setDeps 覆盖）与探测 ----

const getSoffice = () => ('soffice' in overrides ? overrides.soffice : attempt(() => require('../soffice')));
const getWorkerScript = () => overrides.workerScript || WORKER_SCRIPT;
const getWorkerTimeoutMs = () => (Number(overrides.workerTimeoutMs) > 0 ? Number(overrides.workerTimeoutMs) : WORKER_TIMEOUT_MS);

/** electron 二进制路径：测试可经 _setDeps({ electronPath }) 注入；文件不存在视同未安装 */
function findElectronBinary() {
    if (!('electronPath' in overrides)) return getElectronPath();
    const electronPath = overrides.electronPath;
    if (typeof electronPath !== 'string' || !electronPath) return null;
    return attempt(() => (fs.existsSync(electronPath) ? electronPath : null));
}

async function isSofficeAvailable() {
    const soffice = getSoffice();
    if (!soffice || typeof soffice.isAvailable !== 'function') return false;
    try { return !!(await soffice.isAvailable()); } catch (err) { return false; }
}

/** 后端候选表：check 为真的首个候选胜出，其 run(html, { getDocxBuffer, print }) 负责出图 */
const BACKENDS = [
    {
        name: 'electron-worker',
        check: () => !!findElectronBinary(),
        run: (html, opts) => renderViaWorker(html, findElectronBinary(), opts.print),
    },
    { name: 'soffice', check: () => isSofficeAvailable(), run: (html, opts) => renderViaSoffice(opts.getDocxBuffer) },
];

/** 进程内后端排在候选表最前；未注册时为 null */
function inProcessCandidate() {
    if (!inProcess) return null;
    const { name, render } = inProcess;
    return { name, check: () => true, run: (html, opts) => render({ html, print: opts.print }) };
}

async function pickBackend() {
    for (const backend of [inProcessCandidate(), ...BACKENDS]) {
        if (backend && await backend.check()) return backend;
    }
    return null;
}

function buildHint() {
    const soffice = getSoffice();
    const sofficeHint = soffice && typeof soffice.getInstallHint === 'function'
        ? soffice.getInstallHint()
        : '前往 https://www.libreoffice.org/download/ 安装 LibreOffice';
    return 'PDF 输出需要以下任一环境：'
        + '① 项目目录已安装 electron 依赖（执行 npm install 后自动可用）；'
        + `② 本机安装 LibreOffice（${sofficeHint}）。`;
}

/**
 * 探测可用后端（结果缓存）
 * @returns {Promise<{ name: string|null, available: boolean, hint: string }>}
 *   name 为进程内后端的注册名、'electron-worker' 或 'soffice'；皆不可用时为 null
 */
async function detect({ force = false } = {}) {
    if (!force && detectCache && (detectCache.available || Date.now() - detectFailedAt < DETECT_FAILURE_TTL_MS)) {
        return detectCache;
    }
    const hit = await pickBackend();
    detectCache = hit ? { name: hit.name, available: true, hint: '' } : { name: null, available: false, hint: buildHint() };
    detectFailedAt = hit ? 0 : Date.now();
    return detectCache;
}

/**
 * 注册进程内后端（桌面端主进程启动时调用）：render({ html, print }) → Promise<Buffer>，返回值须为合法 PDF。
 * 重复注册以最后一次为准；注册即清空探测缓存。
 */
function registerInProcess({ name, render } = {}) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('registerInProcess 需要非空的后端名 name');
    if (typeof render !== 'function') throw new Error('registerInProcess 需要 render({ html, print }) 函数');
    inProcess = { name: name.trim(), render };
    clearDetectCache();
}

function unregisterInProcess() {
    inProcess = null;
    clearDetectCache();
}

function clearDetectCache() {
    detectCache = null;
    detectFailedAt = 0;
}

/**
 * @param {{
 *   html: string,
 *   getDocxBuffer?: () => Promise<Buffer>,
 *   print?: { pageSize?: 'A4'|'Letter', landscape?: boolean, margins?: { top, bottom, left, right } },
 * }} params
 * print 为打印参数（页边距单位英寸），省略时工作进程沿用其内置默认；soffice 后端不支持该参数。
 * @returns {Promise<Buffer>}
 */
async function renderPdf({ html, getDocxBuffer, print } = {}) {
    if (typeof html !== 'string') throw new Error('renderPdf 需要 html 字符串');
    const hit = await pickBackend();
    if (!hit) throw new Error(`PDF 输出不可用：未找到可用的渲染后端。${buildHint()}`);
    return ensurePdf(await hit.run(html, { getDocxBuffer, print }), hit.name);
}

/** 不足 4 字节时截取结果必然短于 %PDF，同样判为非法 */
function ensurePdf(output, backendName) {
    const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output || []);
    if (buffer.subarray(0, PDF_MAGIC.length).toString('latin1') !== PDF_MAGIC) {
        throw new Error(`PDF 后端 ${backendName} 返回的内容不是合法 PDF`);
    }
    return buffer;
}

// ---- ① 独立 Electron 工作进程 ----

/** 串行排队：Electron 实例开销大，同一时刻只跑一个工作进程 */
function renderViaWorker(html, electronPath, print) {
    const task = () => runWorker(html, electronPath, print);
    const run = workerQueue.then(task, task);
    workerQueue = run.then(noop, noop);
    return run;
}

/** 打印参数以 JSON 落在工作目录内，路径作为第五个位置参数传给工作进程；省略时参数表与 v2 完全一致 */
async function runWorker(html, electronPath, print) {
    const tmpDir = await tmp.makeTempDir(`${TEMP_PREFIX}worker-`);
    const inPath = path.join(tmpDir, 'index.html');
    const outPath = path.join(tmpDir, 'output.pdf');
    try {
        await fsp.writeFile(inPath, html, 'utf8');
        const args = [getWorkerScript(), inPath, outPath, path.join(tmpDir, 'profile')];
        if (print && typeof print === 'object') {
            const printPath = path.join(tmpDir, 'print.json');
            await fsp.writeFile(printPath, JSON.stringify(print), 'utf8');
            args.push(printPath);
        }
        const result = await spawnElectron(electronPath, args, { timeoutMs: getWorkerTimeoutMs(), spawn: overrides.spawn });
        assertExitOk(result, WORKER_LABEL);
        return await fsp.readFile(outPath);
    } finally {
        await tmp.removeTempDir(tmpDir);
    }
}

// ---- ② LibreOffice：DOCX → PDF ----

async function renderViaSoffice(getDocxBuffer) {
    if (typeof getDocxBuffer !== 'function') throw new Error('soffice 后端需要 getDocxBuffer 以先生成 DOCX');
    const docx = await getDocxBuffer();
    if (!Buffer.isBuffer(docx) || docx.length === 0) throw new Error('getDocxBuffer 未返回有效的 DOCX Buffer');

    const tmpDir = await tmp.makeTempDir(`${TEMP_PREFIX}soffice-`);
    try {
        const docxPath = path.join(tmpDir, 'document.docx');
        await fsp.writeFile(docxPath, docx);
        return await fsp.readFile(await getSoffice().convertFile(docxPath, 'pdf', { outDir: tmpDir }));
    } finally {
        await tmp.removeTempDir(tmpDir);
    }
}

// ---- 残留临时目录清理 ----

/** 清理 os.tmpdir() 下修改时间超过 1 天的 markflow-pdf-* 目录（上次异常退出的残留） */
const cleanupStaleTempDirs = (now = Date.now()) => tmp.cleanupStaleTempDirs({ matchPrefix: TEMP_PREFIX, now });

cleanupStaleTempDirs().catch(noop);

/** 覆盖依赖：{ electronPath, soffice, spawn, workerScript, workerTimeoutMs }；传入后清空探测缓存 */
function _setDeps(next = {}) {
    overrides = { ...overrides, ...next };
    clearDetectCache();
}

/** 恢复真实依赖并清空缓存、队列与进程内注册 */
function _reset() {
    overrides = {};
    inProcess = null;
    clearDetectCache();
    workerQueue = Promise.resolve();
}

module.exports = {
    detect, renderPdf, registerInProcess, unregisterInProcess,
    _setDeps, _reset, _cleanupStaleTempDirs: cleanupStaleTempDirs,
};
