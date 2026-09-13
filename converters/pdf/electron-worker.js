/**
 * 独立 Electron PDF 工作进程
 *
 * 用法：Electron <本脚本> <in.html> <out.pdf> [userDataDir] [print.json]
 * 由 converters/pdf/backend.js 在普通 Node 进程中 spawn 调用：
 * 隐藏窗口 loadFile 载入 HTML，等待加载与字体就绪后 printToPDF 写出到 out.pdf，
 * 成功 app.exit(0)；任何异常写 stderr 并 app.exit(1)。
 * 可选第三参数指定独立的 userData 目录，避免并行工作进程共用 Chromium profile。
 * 可选第四参数为打印参数 JSON（{ pageSize, landscape, margins:{top,bottom,left,right} }，页边距单位英寸）：
 * 逐项校验后覆盖内置默认；给出该文件时关闭 preferCSSPageSize，否则样式表里的 @page 会盖掉显式页边距。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const WINDOW_SIZE = { width: 800, height: 1200 };
const DEFAULT_MARGIN_INCH = 0.6;
const MAX_MARGIN_INCH = 3;
const PAGE_SIZES = new Set(['A4', 'Letter']);
const PRINT_OPTIONS = {
    printBackground: true,
    pageSize: 'A4',
    margins: { marginType: 'custom', top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    preferCSSPageSize: true,
};
const FONTS_READY_SCRIPT = 'document.fonts.ready.then(() => true)';

/** argv 形态：[Electron 二进制, 本脚本, in.html, out.pdf, userDataDir?, print.json?]；忽略 -- 开头的开关 */
function parseArgs(argv) {
    const positional = argv.slice(2).filter((arg) => !String(arg).startsWith('--'));
    const [inPath, outPath, userDataDir, printPath] = positional;
    if (!inPath || !outPath) {
        throw new Error('用法：Electron electron-worker.js <in.html> <out.pdf> [userDataDir] [print.json]');
    }
    return {
        inPath: path.resolve(inPath),
        outPath: path.resolve(outPath),
        userDataDir: userDataDir ? path.resolve(userDataDir) : null,
        printPath: printPath ? path.resolve(printPath) : null,
    };
}

/** 读取并逐项校验打印参数；文件缺省或字段非法时回落到内置默认值，不因参数问题中断打印 */
function readPrintOptions(printPath) {
    if (!printPath) return PRINT_OPTIONS;
    const raw = JSON.parse(fs.readFileSync(printPath, 'utf8'));
    const source = raw && typeof raw === 'object' ? raw : {};
    const margins = source.margins && typeof source.margins === 'object' ? source.margins : {};
    return {
        printBackground: true,
        pageSize: PAGE_SIZES.has(source.pageSize) ? source.pageSize : PRINT_OPTIONS.pageSize,
        landscape: source.landscape === true,
        margins: {
            marginType: 'custom',
            top: inchOrDefault(margins.top),
            bottom: inchOrDefault(margins.bottom),
            left: inchOrDefault(margins.left),
            right: inchOrDefault(margins.right),
        },
        preferCSSPageSize: false,
    };
}

function inchOrDefault(value) {
    const inch = Number(value);
    return Number.isFinite(inch) && inch >= 0 && inch <= MAX_MARGIN_INCH ? inch : DEFAULT_MARGIN_INCH;
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

async function printFile(inPath, outPath, printOptions) {
    const win = new BrowserWindow({
        show: false,
        ...WINDOW_SIZE,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
        await win.loadFile(inPath);
        await waitForFonts(win.webContents);
        const pdf = await win.webContents.printToPDF(printOptions);
        await fsp.mkdir(path.dirname(outPath), { recursive: true });
        await fsp.writeFile(outPath, pdf);
    } finally {
        if (!win.isDestroyed()) win.destroy();
    }
}

async function main() {
    const { inPath, outPath, userDataDir, printPath } = parseArgs(process.argv);
    const printOptions = readPrintOptions(printPath);
    if (userDataDir) {
        fs.mkdirSync(userDataDir, { recursive: true });
        app.setPath('userData', userDataDir);
    }
    await app.whenReady();
    if (app.dock) app.dock.hide();
    await printFile(inPath, outPath, printOptions);
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

main().then(() => app.exit(EXIT_OK), fail);
