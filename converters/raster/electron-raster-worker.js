/**
 * 独立 Electron 栅格工作进程：把 HTML 片段页离屏渲染为 PNG
 *
 * 用法：Electron <本脚本> <jobs.json> <outDir> [userDataDir]
 * 由 converters/raster/backend.js 在普通 Node 进程中 spawn 调用：
 *   jobs.json 为 { version, dpi, jobs: [{ id, file }] }，一个进程串行处理整份任务表；每个任务以 file:// 载入
 *   片段页（本地脚本与字体只能经 file:// 引用），等待页面就绪后量取 body 外接矩形，经 CDP
 *   Page.captureScreenshot({ clip: { …, scale: dpi / 96 }, captureBeyondViewport: true, fromSurface: true })
 *   截图并写出 <outDir>/<id>.png；全部任务处理完写出 <outDir>/results.json 后 app.exit(0)。
 *   单任务失败只记入 results.json 的 error（并写一行 stderr），不影响其它任务；参数、任务表或 Electron 自身
 *   的异常才写 stderr 并 app.exit(1)。
 *
 * 出图决策依据 R4 探针（Electron 44.3.0）：offscreen 窗口 + CDP clip.scale 的 PNG 像素恒为 CSS 像素 × scale，
 * 与显示器缩放无关；禁止 offscreen 下 capturePage（1× 帧上采样发虚）、setZoomFactor（按 URL 持久化污染
 * 后续任务）与 enableDeviceEmulation（不改输出）。窗口只建一次、逐任务复用，渲染进程崩溃后重建；
 * 每次截图后 debugger.detach()。必须订阅 window-all-closed，否则销毁最后一个窗口即退出进程。
 * 页面就绪：片段页可定义 window.__markflowReady()（公式页在其中等待 MathJax 排版完成），之后再等
 * document.fonts.ready 与两帧 requestAnimationFrame；整体设上限，超时按当前画面截图。
 * 网络：session.webRequest 拦截一切非 file:/data:/blob:/about: 请求，片段页不可能访问外网。
 */
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pathToFileURL } = require('url');

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const CSS_DPI = 96;
const DEFAULT_DPI = 300;
const CDP_VERSION = '1.3';
const RESULTS_FILE = 'results.json';
const RESULTS_VERSION = 1;
/** 视口只影响布局的「可用宽度」（body 为 inline-block，内容宽于视口时按内容撑开），不影响截图范围 */
const VIEWPORT = { width: 800, height: 600 };
/** 单边像素上限：超出 Chromium 纹理尺寸的截图会失败，超限时按比例降低 scale 并在结果中如实记录 */
const MAX_EDGE_PX = 16000;
const MIN_EDGE_PX = 1;
const LOAD_TIMEOUT_MS = 20000;
const READY_TIMEOUT_MS = 20000;
const SETTLE_FALLBACK_MS = 150;
/** 任务 id 兼作文件名：只允许安全字符，杜绝路径穿越 */
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LOCAL_URL_RE = /^(file|data|blob|about|devtools|chrome-extension):/i;
/** PNG IHDR：宽在字节 16–19，高在 20–23（大端） */
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;

/** 页面就绪：先等片段自带的就绪钩子（MathJax），再等字体与两帧绘制；rAF 在离屏窗口可能被节流，故设兜底 */
const READY_SCRIPT = `(async () => {
    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), ${READY_TIMEOUT_MS}));
    const settle = () => Promise.race([
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
        new Promise((resolve) => setTimeout(resolve, ${SETTLE_FALLBACK_MS})),
    ]);
    const ready = (async () => {
        if (typeof window.__markflowReady === 'function') await window.__markflowReady();
        await document.fonts.ready;
        await settle();
        return 'ready';
    })();
    return Promise.race([ready, timeout]);
})()`;
/** body 为 inline-block 且 html/body 零边距，其外接矩形的右下角即内容尺寸 */
const MEASURE_SCRIPT = `(() => {
    const rect = document.body.getBoundingClientRect();
    return { width: Math.ceil(rect.right), height: Math.ceil(rect.bottom) };
})()`;

const noop = () => undefined;

/** argv 形态：[Electron 二进制, 本脚本, jobs.json, outDir, userDataDir?]；忽略 -- 开头的开关 */
function parseArgs(argv) {
    const positional = argv.slice(2).filter((arg) => !String(arg).startsWith('--'));
    const [jobsPath, outDir, userDataDir] = positional;
    if (!jobsPath || !outDir) {
        throw new Error('用法：Electron electron-raster-worker.js <jobs.json> <outDir> [userDataDir]');
    }
    return {
        jobsPath: path.resolve(jobsPath),
        outDir: path.resolve(outDir),
        userDataDir: userDataDir ? path.resolve(userDataDir) : null,
    };
}

/** 读取并校验任务表：{ dpi, jobs: [{ id, file }] }，id 唯一且可作文件名，file 须存在 */
function readJobs(jobsPath) {
    const raw = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    const source = raw && typeof raw === 'object' ? raw : {};
    if (!Array.isArray(source.jobs)) throw new Error('jobs.json 须含 jobs 数组');
    const dpi = Number(source.dpi);
    const seen = new Set();
    const jobs = source.jobs.map((job, index) => {
        const id = job && typeof job.id === 'string' ? job.id : '';
        if (!JOB_ID_RE.test(id)) throw new Error(`第 ${index + 1} 个任务的 id 非法：${JSON.stringify(id)}`);
        if (seen.has(id)) throw new Error(`任务 id 重复：${id}`);
        if (!job || typeof job.file !== 'string' || !job.file) throw new Error(`任务 ${id} 缺少片段文件路径 file`);
        seen.add(id);
        return { id, file: path.resolve(path.dirname(jobsPath), job.file) };
    });
    return { dpi: Number.isFinite(dpi) && dpi > 0 ? dpi : DEFAULT_DPI, jobs };
}

function fail(err) {
    const detail = err && err.stack ? err.stack : String(err);
    process.stderr.write(`[raster-worker] ${detail}\n`);
    app.exit(EXIT_FAIL);
}

const errText = (err) => (err && err.message ? err.message : String(err));

/** 离屏宿主窗口；渲染进程崩溃后 alive 置假，下一任务重建窗口 */
function createHost() {
    const win = new BrowserWindow({
        show: false,
        ...VIEWPORT,
        useContentSize: true,
        webPreferences: {
            offscreen: true,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
        },
    });
    const host = { win, alive: true };
    win.webContents.on('render-process-gone', () => { host.alive = false; });
    return host;
}

const isHostUsable = (host) => host.alive && !host.win.isDestroyed();

const destroyHost = (host) => { if (!host.win.isDestroyed()) host.win.destroy(); };

/** 片段页只能引用本地资源：拦截一切 http(s)/ws 等外部请求 */
function installNetworkGuard() {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !LOCAL_URL_RE.test(String(details.url)) });
    });
}

function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s）`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const clampEdge = (value) => Math.min(MAX_EDGE_PX, Math.max(MIN_EDGE_PX, Math.ceil(Number(value) || 0)));

async function measure(webContents) {
    const raw = await webContents.executeJavaScript(MEASURE_SCRIPT, true);
    return { width: clampEdge(raw && raw.width), height: clampEdge(raw && raw.height) };
}

/** 目标 scale 会把任一边推过像素上限时按比例降低；返回实际采用的 scale 与是否受限 */
function fitScale(size, scale) {
    const longest = Math.max(size.width, size.height) * scale;
    if (longest <= MAX_EDGE_PX) return { scale, capped: false };
    return { scale: Math.floor((MAX_EDGE_PX / Math.max(size.width, size.height)) * 1000) / 1000, capped: true };
}

async function captureScreenshot(webContents, size, scale) {
    const dbg = webContents.debugger;
    dbg.attach(CDP_VERSION);
    try {
        const { data } = await dbg.sendCommand('Page.captureScreenshot', {
            format: 'png',
            fromSurface: true,
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: size.width, height: size.height, scale },
        });
        return Buffer.from(data, 'base64');
    } finally {
        try { dbg.detach(); } catch (err) { /* 已断开 */ }
    }
}

function pngSize(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < PNG_HEIGHT_OFFSET + 4) return { width: 0, height: 0 };
    return { width: buffer.readUInt32BE(PNG_WIDTH_OFFSET), height: buffer.readUInt32BE(PNG_HEIGHT_OFFSET) };
}

async function renderJob(win, job, outDir, targetScale) {
    const { webContents } = win;
    await withTimeout(webContents.loadURL(pathToFileURL(job.file).href), LOAD_TIMEOUT_MS, '片段页加载');
    const readiness = await webContents.executeJavaScript(READY_SCRIPT, true);
    const size = await measure(webContents);
    const { scale, capped } = fitScale(size, targetScale);
    const png = await captureScreenshot(webContents, size, scale);
    if (png.length === 0) throw new Error('截图为空');
    const file = `${job.id}.png`;
    await fsp.writeFile(path.join(outDir, file), png);
    const { width, height } = pngSize(png);
    return { id: job.id, ok: true, file, width, height, cssWidth: size.width, cssHeight: size.height, scale, capped, readiness };
}

async function renderAll({ dpi, jobs }, outDir) {
    await fsp.mkdir(outDir, { recursive: true });
    const targetScale = dpi / CSS_DPI;
    const results = [];
    let host = createHost();
    try {
        for (const job of jobs) {
            if (!isHostUsable(host)) {
                destroyHost(host);
                host = createHost();
            }
            try {
                results.push(await renderJob(host.win, job, outDir, targetScale));
            } catch (err) {
                const error = errText(err);
                process.stderr.write(`[raster-worker] 任务 ${job.id} 失败：${error}\n`);
                results.push({ id: job.id, ok: false, error });
            }
        }
    } finally {
        destroyHost(host);
    }
    return results;
}

async function main() {
    const { jobsPath, outDir, userDataDir } = parseArgs(process.argv);
    const spec = readJobs(jobsPath);
    if (userDataDir) {
        fs.mkdirSync(userDataDir, { recursive: true });
        app.setPath('userData', userDataDir);
        app.setPath('sessionData', userDataDir);
    }
    // 窗口在任务间复用并由本进程显式退出，不让「所有窗口关闭」触发隐式退出
    app.on('window-all-closed', noop);
    await app.whenReady();
    if (app.dock) app.dock.hide();
    installNetworkGuard();
    const results = await renderAll(spec, outDir);
    await fsp.writeFile(path.join(outDir, RESULTS_FILE), JSON.stringify({ version: RESULTS_VERSION, dpi: spec.dpi, results }), 'utf8');
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

main().then(() => app.exit(EXIT_OK), fail);
