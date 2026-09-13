/**
 * 主进程内 Chromium 作业：printToPDF 与离屏栅格截图（方案 §3.4.9；出图方式与 converters/raster/electron-raster-worker.js 一致）
 *
 * createChromiumJobs(electron, { log }) → { printToPdf, rasterize, registerBackends, isAvailable }
 *   printToPdf({ html, print })   → Promise<Buffer>
 *       复用 v1 pdf-printer 的串行隐藏窗口：HTML 落到临时目录 loadFile → 等字体就绪 → printToPDF；
 *       print = { pageSize: 'A4'|'Letter', landscape, margins: { top, bottom, left, right } }（英寸，与 pdf/electron-worker.js
 *       的 print.json 同义），给出 print 时 preferCSSPageSize 为 false。
 *   rasterize(jobs, { dpi })      → Promise<Map<id, Buffer | Error>>
 *       jobs = [{ id, html }]，html 为 converters/raster/fragment.js 生成的自包含片段页（自带 nonce CSP，
 *       以 file:// 引用本地 MathJax 与字体）。宿主为 offscreen BrowserWindow（sandbox、contextIsolation、
 *       独立 session 分区，渲染进程崩溃后重建），逐任务：写临时文件 → loadURL(file://) → 等
 *       window.__markflowReady() 与 document.fonts.ready → 量 body 外接矩形 → webContents.debugger 1.3 的
 *       Page.captureScreenshot({ clip: { x, y, width, height, scale: dpi / 96 }, captureBeyondViewport, fromSurface })
 *       → detach。单任务失败放 Error 而不抛出。禁止 capturePage / setZoomFactor / enableDeviceEmulation。
 *   registerBackends()            → { pdf: boolean, raster: boolean }
 *       以 name 'in-process' 注册到 converters/pdf/backend 与 converters/raster/backend 的 registerInProcess；
 *       模块缺失或未导出该函数时记录日志并跳过，不抛错。
 *
 * 两类作业共用 session 分区 JOB_PARTITION（内存态、不落盘），其 webRequest 拦截一切非 file/data/blob/about 请求，
 * 主窗口所在的默认 session 不受影响；本模块不经 onHeadersReceived 注入任何 CSP，片段页自带的 CSP
 * （含 worker-src / connect-src）原样生效，否则 MathJax 的 startup.promise 永不落定。
 * 两类作业共用一条串行队列：同一时刻只有一个隐藏 / 离屏窗口在工作。
 */
const path = require('path');
const fsp = require('fs').promises;
const { pathToFileURL } = require('url');

const tmp = require('../../converters/tmp');

const IN_PROCESS_NAME = 'in-process';
const JOB_PARTITION = 'markflow-jobs';
const PDF_TEMP_PREFIX = 'markflow-pdf-app-';
const RASTER_TEMP_PREFIX = 'markflow-raster-app-';
const PDF_WINDOW = Object.freeze({ width: 800, height: 1200 });
/** 视口只影响布局的「可用宽度」（body 为 inline-block，内容宽于视口时按内容撑开），不影响截图范围 */
const RASTER_VIEWPORT = Object.freeze({ width: 800, height: 600 });
const PAGE_SIZES = new Set(['A4', 'Letter']);
const DEFAULT_MARGIN_INCH = 0.6;
const MAX_MARGIN_INCH = 3;
const DEFAULT_DPI = 300;
const MIN_DPI = 1;
const MAX_DPI = 2400;
const CSS_DPI = 96;
/** 单边像素上限：超出 Chromium 纹理尺寸的截图会失败，超限时按比例降低 scale */
const MAX_EDGE_PX = 16000;
const MIN_EDGE_PX = 1;
const LOAD_TIMEOUT_MS = 20000;
const READY_TIMEOUT_MS = 20000;
const SETTLE_FALLBACK_MS = 150;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const LOCAL_URL_RE = /^(file|data|blob|about|devtools|chrome-extension):/i;
const PDF_MAGIC = '%PDF';
const CDP_VERSION = '1.3';
const FONTS_READY_SCRIPT = 'document.fonts.ready.then(() => true)';
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
const errText = (err) => (err && err.message ? err.message : String(err));

function optionalRequire(request) {
    try {
        return require(request);
    } catch (err) {
        if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(request)) return null;
        throw err;
    }
}

const inchOrDefault = (value) => {
    const inch = Number(value);
    return Number.isFinite(inch) && inch >= 0 && inch <= MAX_MARGIN_INCH ? inch : DEFAULT_MARGIN_INCH;
};

/** 打印参数逐项校验；未给 print 时沿用内置默认并保留 preferCSSPageSize（与 pdf/electron-worker.js 一致） */
function buildPrintOptions(print) {
    if (!print || typeof print !== 'object') {
        return {
            printBackground: true,
            pageSize: 'A4',
            margins: { top: DEFAULT_MARGIN_INCH, bottom: DEFAULT_MARGIN_INCH, left: DEFAULT_MARGIN_INCH, right: DEFAULT_MARGIN_INCH },
            preferCSSPageSize: true,
        };
    }
    const margins = print.margins && typeof print.margins === 'object' ? print.margins : {};
    return {
        printBackground: true,
        pageSize: PAGE_SIZES.has(print.pageSize) ? print.pageSize : 'A4',
        landscape: print.landscape === true,
        margins: {
            top: inchOrDefault(margins.top),
            bottom: inchOrDefault(margins.bottom),
            left: inchOrDefault(margins.left),
            right: inchOrDefault(margins.right),
        },
        preferCSSPageSize: false,
    };
}

function validateJobs(jobs) {
    if (!Array.isArray(jobs)) throw new Error('rasterize 需要任务数组 [{ id, html }]');
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

const clampDpi = (dpi) => {
    const value = Number(dpi);
    if (!Number.isFinite(value)) return DEFAULT_DPI;
    return Math.min(MAX_DPI, Math.max(MIN_DPI, value));
};

const clampEdge = (value) => Math.min(MAX_EDGE_PX, Math.max(MIN_EDGE_PX, Math.ceil(Number(value) || 0)));

/** 目标 scale 会把任一边推过像素上限时按比例降低；返回实际采用的 scale 与是否受限 */
function fitScale(size, scale) {
    const longest = Math.max(size.width, size.height) * scale;
    if (longest <= MAX_EDGE_PX) return { scale, capped: false };
    return { scale: Math.floor((MAX_EDGE_PX / Math.max(size.width, size.height)) * 1000) / 1000, capped: true };
}

function ensurePdf(output) {
    const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output || []);
    if (buffer.subarray(0, PDF_MAGIC.length).toString('latin1') !== PDF_MAGIC) throw new Error('进程内 PDF 后端返回的内容不是合法 PDF');
    return buffer;
}

function withTimeout(promise, ms, label) {
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s）`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createChromiumJobs(electron, { log = (line) => process.stderr.write(`${line}\n`) } = {}) {
    if (!electron || !electron.app || !electron.BrowserWindow) throw new Error('createChromiumJobs 需要 Electron 主进程模块');
    const { app, BrowserWindow, session } = electron;
    let queue = Promise.resolve();
    let guardInstalled = false;

    const enqueue = (task) => {
        const run = queue.then(task, task);
        queue = run.then(noop, noop);
        return run;
    };

    /** 作业窗口独占的 session 分区：片段页与打印页只能引用本地资源，拦截一切外部请求 */
    function ensureJobSession() {
        if (guardInstalled) return;
        session.fromPartition(JOB_PARTITION).webRequest.onBeforeRequest((details, callback) => {
            callback({ cancel: !LOCAL_URL_RE.test(String(details.url)) });
        });
        guardInstalled = true;
    }

    const jobPrefs = (extra = {}) => ({
        partition: JOB_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        ...extra,
    });

    const destroy = (win) => { if (win && !win.isDestroyed()) win.destroy(); };

    async function waitForFonts(webContents) {
        try { await webContents.executeJavaScript(FONTS_READY_SCRIPT, true); } catch (err) { /* 不阻断 */ }
    }

    // ---------- PDF ----------

    function printToPdf({ html, print } = {}) {
        if (typeof html !== 'string') throw new Error('printToPdf 需要 html 字符串');
        const options = buildPrintOptions(print);
        return enqueue(() => doPrint(html, options));
    }

    async function doPrint(html, printOptions) {
        if (!app.isReady()) await app.whenReady();
        ensureJobSession();
        const dir = await tmp.makeTempDir(PDF_TEMP_PREFIX);
        const win = new BrowserWindow({ show: false, ...PDF_WINDOW, webPreferences: jobPrefs() });
        try {
            const file = path.join(dir, 'index.html');
            await fsp.writeFile(file, html, 'utf8');
            await withTimeout(win.loadURL(pathToFileURL(file).href), LOAD_TIMEOUT_MS, '打印页加载');
            await waitForFonts(win.webContents);
            return ensurePdf(await win.webContents.printToPDF(printOptions));
        } finally {
            destroy(win);
            await tmp.removeTempDir(dir);
        }
    }

    // ---------- 栅格 ----------

    function rasterize(jobs, { dpi = DEFAULT_DPI } = {}) {
        const list = validateJobs(jobs);
        const scale = clampDpi(dpi) / CSS_DPI;
        if (list.length === 0) return Promise.resolve(new Map());
        return enqueue(() => doRasterize(list, scale));
    }

    /** 离屏宿主窗口；渲染进程崩溃后 alive 置假，下一任务重建 */
    function createHost() {
        const win = new BrowserWindow({
            show: false,
            ...RASTER_VIEWPORT,
            useContentSize: true,
            webPreferences: jobPrefs({ offscreen: true }),
        });
        const host = { win, alive: true };
        win.webContents.on('render-process-gone', () => { host.alive = false; });
        return host;
    }

    const isHostUsable = (host) => host.alive && !host.win.isDestroyed();

    async function doRasterize(jobs, targetScale) {
        if (!app.isReady()) await app.whenReady();
        ensureJobSession();
        const dir = await tmp.makeTempDir(RASTER_TEMP_PREFIX);
        const out = new Map();
        let host = createHost();
        try {
            for (const job of jobs) {
                if (!isHostUsable(host)) {
                    destroy(host.win);
                    host = createHost();
                }
                try {
                    out.set(job.id, await renderJob(host.win, job, dir, targetScale));
                } catch (err) {
                    log(`[desktop] 栅格任务 ${job.id} 失败：${errText(err)}`);
                    out.set(job.id, err instanceof Error ? err : new Error(errText(err)));
                }
            }
            return out;
        } finally {
            destroy(host.win);
            await tmp.removeTempDir(dir);
        }
    }

    async function renderJob(win, job, dir, targetScale) {
        const { webContents } = win;
        const file = path.join(dir, `${job.id}.html`);
        await fsp.writeFile(file, job.html, 'utf8');
        await withTimeout(webContents.loadURL(pathToFileURL(file).href), LOAD_TIMEOUT_MS, '片段页加载');
        await webContents.executeJavaScript(READY_SCRIPT, true);
        const size = await measure(webContents);
        const { scale } = fitScale(size, targetScale);
        const png = await captureScreenshot(webContents, size, scale);
        if (png.length === 0) throw new Error('截图为空');
        return png;
    }

    async function measure(webContents) {
        const raw = await webContents.executeJavaScript(MEASURE_SCRIPT, true);
        return { width: clampEdge(raw && raw.width), height: clampEdge(raw && raw.height) };
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
            return Buffer.from(data || '', 'base64');
        } finally {
            try { dbg.detach(); } catch (err) { /* 已断开 */ }
        }
    }

    // ---------- 注册到内核后端 ----------

    function registerBackends() {
        const status = { pdf: false, raster: false };
        const pdfBackend = safeRequire('../../converters/pdf/backend');
        if (pdfBackend && typeof pdfBackend.registerInProcess === 'function') {
            pdfBackend.registerInProcess({ name: IN_PROCESS_NAME, render: ({ html, print } = {}) => printToPdf({ html, print }) });
            status.pdf = true;
        } else {
            log('[desktop] converters/pdf/backend 未提供 registerInProcess，PDF 输出沿用工作进程后端');
        }
        const rasterBackend = safeRequire('../../converters/raster/backend');
        if (rasterBackend && typeof rasterBackend.registerInProcess === 'function') {
            rasterBackend.registerInProcess({ name: IN_PROCESS_NAME, rasterize: (jobs, opts) => rasterize(jobs, opts) });
            status.raster = true;
        } else {
            log('[desktop] converters/raster/backend 未提供 registerInProcess，栅格化沿用工作进程后端');
        }
        return status;
    }

    function safeRequire(request) {
        try {
            return optionalRequire(request);
        } catch (err) {
            log(`[desktop] 加载 ${request} 失败：${errText(err)}`);
            return null;
        }
    }

    return { printToPdf, rasterize, registerBackends, isAvailable: () => true };
}

module.exports = {
    createChromiumJobs, buildPrintOptions, validateJobs, clampDpi, clampEdge, fitScale,
    IN_PROCESS_NAME, JOB_PARTITION, DEFAULT_DPI, CSS_DPI, JOB_ID_RE, LOCAL_URL_RE, MAX_EDGE_PX,
};
