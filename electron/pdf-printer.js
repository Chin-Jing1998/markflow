/**
 * Electron PDF 打印器
 *
 * 复用内嵌 Chromium 的 webContents.printToPDF 把 HTML 渲染为 PDF。
 * 仅在 Electron 主进程内可用（require('electron') 必须成功）。
 *
 * 串行队列：同时只创建 1 个 hidden BrowserWindow，避免高并发下窗口资源紧张。
 */

let electron = null;
let isElectronMain = false;
try {
    electron = require('electron');
    isElectronMain = !!(electron && electron.BrowserWindow && electron.app);
} catch (e) {
    electron = null;
}

let printQueue = Promise.resolve(null);

function isAvailable() {
    return isElectronMain;
}

async function printToPdf(html, options = {}) {
    if (!isElectronMain) {
        throw new Error(
            'PDF 输出不可用：当前进程不是 Electron 主进程。请改用浏览器自带打印（HTML 输出 + Ctrl/Cmd+P）。',
        );
    }

    // 链式排队
    const job = printQueue.then(() => doPrint(html, options));
    printQueue = job.catch(() => null); // 避免错误传染下一个 job
    return job;
}

async function doPrint(html, options) {
    const { BrowserWindow, app } = electron;

    // 必须在 app ready 之后
    if (!app.isReady()) {
        await app.whenReady();
    }

    const win = new BrowserWindow({
        show: false,
        width: 800,
        height: 1200,
        webPreferences: {
            offscreen: false,
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    try {
        const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
        await win.loadURL(dataUrl);

        // 等待页面 onload + 字体/图片渲染稳定
        await new Promise((resolve) => setTimeout(resolve, 400));

        const buffer = await win.webContents.printToPDF({
            printBackground: true,
            pageSize: options.pageSize || 'A4',
            landscape: options.landscape || false,
            margins: options.margins || {
                marginType: 'custom',
                top: 0.6,
                bottom: 0.6,
                left: 0.6,
                right: 0.6,
            },
            preferCSSPageSize: true,
        });
        return buffer;
    } finally {
        try {
            win.close();
        } catch (e) {}
    }
}

module.exports = { printToPdf, isAvailable };
