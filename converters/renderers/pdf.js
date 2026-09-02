/**
 * IR → PDF（Buffer）
 *
 * 路径：IR → renderers/html → HTML 字符串 → converters/pdf/backend 三级后端出图
 * （Electron 主进程打印 → 独立 Electron 工作进程 → LibreOffice 以 DOCX 转 PDF）。
 * soffice 路径需要 DOCX 输入，故以 getDocxBuffer 惰性提供 renderers/docx 的产物，
 * 仅在真正走到该分支时才渲染 DOCX。
 */
const htmlRenderer = require('./html');
const docxRenderer = require('./docx');
const backend = require('../pdf/backend');

async function render(doc) {
    const html = await htmlRenderer.render(doc);
    return backend.renderPdf({ html, getDocxBuffer: () => docxRenderer.render(doc) });
}

/**
 * 同步能力探测（兼容 server.js 的同步调用）：仅覆盖 Electron 主进程与本地 electron 二进制两级，
 * 以及此前 detect() 已缓存的成功结果；含 LibreOffice 的完整探测请用 detect()。
 */
function isAvailable() {
    return backend.isAvailableSync();
}

/** 异步完整探测：{ name, available, hint } */
function detect(opts) {
    return backend.detect(opts);
}

module.exports = { render, isAvailable, detect };
