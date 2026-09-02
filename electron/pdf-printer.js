/**
 * Electron 主进程 PDF 打印器
 *
 * 职责：在 Electron 主进程内复用内嵌 Chromium 的 webContents.printToPDF 把 HTML 渲染为 PDF。
 * 流程：HTML 写入 os.tmpdir() 下的 markflow-pdf-<随机> 目录内 index.html → 隐藏 BrowserWindow.loadFile →
 *       等待 did-finish-load 与 document.fonts.ready → printToPDF → finally 删除临时目录。
 * 约束：
 *   - 非 Electron 进程内（require('electron') 为路径字符串或抛错）isAvailable() 返回 false 且不抛异常；
 *   - 串行队列保证同一时刻只有一个隐藏窗口；
 *   - 模块加载时异步清理 os.tmpdir() 下修改时间超过 1 天的 markflow-pdf-* 残留目录。
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const TEMP_PREFIX = 'markflow-pdf-';
const STALE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const WINDOW_SIZE = { width: 800, height: 1200 };
const DEFAULT_PAGE_SIZE = 'A4';
const DEFAULT_MARGINS = { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 };
const FONTS_READY_SCRIPT = 'document.fonts.ready.then(() => true)';

const electron = loadElectronMain();
let printQueue = Promise.resolve();

/** 仅当 require('electron') 返回带 app/BrowserWindow 的模块对象时视为主进程 */
function loadElectronMain() {
    try {
        const mod = require('electron');
        return mod && typeof mod === 'object' && mod.app && mod.BrowserWindow ? mod : null;
    } catch (err) {
        return null;
    }
}

function isAvailable() {
    return electron !== null;
}

/**
 * @param {string} html 完整 HTML 文档
 * @param {{ pageSize?: string, landscape?: boolean, margins?: object }} [options]
 * @returns {Promise<Buffer>}
 */
async function printToPdf(html, options = {}) {
    if (!isAvailable()) {
        throw new Error('PDF 打印不可用：当前进程不是 Electron 主进程。');
    }
    if (typeof html !== 'string') throw new Error('printToPdf 需要 HTML 字符串');

    const task = () => doPrint(html, options);
    const run = printQueue.then(task, task);
    printQueue = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

async function doPrint(html, options) {
    const { app, BrowserWindow } = electron;
    if (!app.isReady()) await app.whenReady();

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
    const win = new BrowserWindow({
        show: false,
        ...WINDOW_SIZE,
        webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
    });

    try {
        const htmlPath = path.join(tmpDir, 'index.html');
        await fsp.writeFile(htmlPath, html, 'utf8');
        await loadAndWait(win, htmlPath);
        return await win.webContents.printToPDF(buildPrintOptions(options));
    } finally {
        if (!win.isDestroyed()) win.destroy();
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

/** 等待 did-finish-load（loadFile 的 Promise 亦以此为准）后再等字体就绪，替代固定延时 */
async function loadAndWait(win, htmlPath) {
    const { webContents } = win;
    const loaded = new Promise((resolve, reject) => {
        webContents.once('did-finish-load', () => resolve());
        webContents.once('did-fail-load', (_event, code, description) => {
            reject(new Error(`页面加载失败（${code}）：${description}`));
        });
    });
    await Promise.all([win.loadFile(htmlPath), loaded]);
    try {
        await webContents.executeJavaScript(FONTS_READY_SCRIPT, true);
    } catch (err) {
        // 字体就绪等待失败不阻断打印
    }
}

function buildPrintOptions(options = {}) {
    return {
        printBackground: true,
        pageSize: options.pageSize || DEFAULT_PAGE_SIZE,
        landscape: !!options.landscape,
        margins: options.margins || DEFAULT_MARGINS,
        preferCSSPageSize: true,
    };
}

/**
 * 清理 os.tmpdir() 下修改时间超过 1 天的 markflow-pdf-* 目录（上次异常退出的残留）
 * @returns {Promise<number>} 删除的目录数
 */
async function cleanupStaleTempDirs(now = Date.now()) {
    const base = os.tmpdir();
    let names = [];
    try {
        names = await fsp.readdir(base);
    } catch (err) {
        return 0;
    }

    let removed = 0;
    for (const name of names) {
        if (!name.startsWith(TEMP_PREFIX)) continue;
        const full = path.join(base, name);
        try {
            const stat = await fsp.stat(full);
            if (!stat.isDirectory() || now - stat.mtimeMs < STALE_TEMP_MAX_AGE_MS) continue;
            await fsp.rm(full, { recursive: true, force: true });
            removed += 1;
        } catch (err) {
            // 单个目录清理失败不影响其余
        }
    }
    return removed;
}

cleanupStaleTempDirs().catch(() => undefined);

module.exports = { printToPdf, isAvailable, _cleanupStaleTempDirs: cleanupStaleTempDirs };
