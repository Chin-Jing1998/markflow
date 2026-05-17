/**
 * IR → PDF (Buffer)
 *
 * 路径：IR → renderers/html → HTML 字符串 → electron/pdf-printer 打印。
 * 在 Electron 主进程内运行（server.js 被 main.js require）；
 * 纯 Web 模式（node server.js）下抛错，前端应降级到 HTML 输出 + 用户浏览器打印。
 */
const htmlRenderer = require('./html');

let pdfPrinter = null;
function tryLoadPrinter() {
    if (pdfPrinter !== null) return pdfPrinter;
    try {
        pdfPrinter = require('../../electron/pdf-printer');
    } catch (e) {
        pdfPrinter = false;
    }
    return pdfPrinter;
}

async function render(doc) {
    const printer = tryLoadPrinter();
    if (!printer || !printer.isAvailable()) {
        throw new Error(
            'PDF 输出不可用：需要在 Electron 桌面端运行。当前为 Web 模式，请改选 HTML 输出后在浏览器打印（Cmd/Ctrl+P → 另存为 PDF）。',
        );
    }

    const html = await htmlRenderer.render(doc);
    const pdfOptions = (doc.meta && doc.meta.pdfOptions) || {};
    return await printer.printToPdf(html, pdfOptions);
}

function isAvailable() {
    const printer = tryLoadPrinter();
    return !!(printer && printer.isAvailable());
}

module.exports = { render, isAvailable };
