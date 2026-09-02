/**
 * 独立 Electron PDF 工作进程
 *
 * 用法：Electron <本脚本> <in.html> <out.pdf> [userDataDir]
 * 由 converters/pdf/backend.js 在非 Electron 主进程环境下 spawn 调用：
 * 隐藏窗口 loadFile 载入 HTML，等待加载与字体就绪后 printToPDF 写出到 out.pdf，
 * 成功 app.exit(0)；任何异常写 stderr 并 app.exit(1)。
 * 可选第三参数指定独立的 userData 目录，避免与桌面端或并行工作进程共用 Chromium profile。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const WINDOW_SIZE = { width: 800, height: 1200 };
const PRINT_OPTIONS = {
    printBackground: true,
    pageSize: 'A4',
    margins: { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    preferCSSPageSize: true,
};
const FONTS_READY_SCRIPT = 'document.fonts.ready.then(() => true)';

/** argv 形态：[Electron 二进制, 本脚本, in.html, out.pdf, userDataDir?]；忽略 -- 开头的开关 */
function parseArgs(argv) {
    const positional = argv.slice(2).filter((arg) => !String(arg).startsWith('--'));
    const [inPath, outPath, userDataDir] = positional;
    if (!inPath || !outPath) {
        throw new Error('用法：Electron pdf-worker.js <in.html> <out.pdf> [userDataDir]');
    }
    return {
        inPath: path.resolve(inPath),
        outPath: path.resolve(outPath),
        userDataDir: userDataDir ? path.resolve(userDataDir) : null,
    };
}

function fail(err) {
    const detail = err && err.stack ? err.stack : String(err);
    process.stderr.write(`[pdf-worker] ${detail}\n`);
    app.exit(EXIT_FAIL);
}

async function waitForFonts(webContents) {
    try {
        await webContents.executeJavaScript(FONTS_READY_SCRIPT, true);
    } catch (err) {
        // 字体就绪等待失败不阻断打印
    }
}

async function printFile(inPath, outPath) {
    const win = new BrowserWindow({
        show: false,
        ...WINDOW_SIZE,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
        await win.loadFile(inPath);
        await waitForFonts(win.webContents);
        const pdf = await win.webContents.printToPDF(PRINT_OPTIONS);
        await fsp.mkdir(path.dirname(outPath), { recursive: true });
        await fsp.writeFile(outPath, pdf);
    } finally {
        if (!win.isDestroyed()) win.destroy();
    }
}

async function main() {
    const { inPath, outPath, userDataDir } = parseArgs(process.argv);
    if (userDataDir) {
        fs.mkdirSync(userDataDir, { recursive: true });
        app.setPath('userData', userDataDir);
    }
    await app.whenReady();
    if (app.dock) app.dock.hide();
    await printFile(inPath, outPath);
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

main().then(() => app.exit(EXIT_OK), fail);
