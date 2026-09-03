/**
 * IR → PDF（Buffer）
 *
 * 路径：IR → renderers/html → HTML 字符串 → converters/pdf/backend 两级后端出图
 * （独立 Electron 工作进程打印 → LibreOffice 以 DOCX 转 PDF）。
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

// 只导出 render：能力探测由 CLI 与 MCP 直连 converters/pdf/backend.detect()
module.exports = { render };
