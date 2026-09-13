/**
 * IR → PDF（Buffer）
 *
 * 路径：IR → renderers/html → HTML 字符串 → converters/pdf/backend 两级后端出图
 * （独立 Electron 工作进程打印 → LibreOffice 以 DOCX 转 PDF）。
 * 选项透传：
 *   - 主题取 options.pdf.theme（默认 print），以其覆盖 options.html.theme 后交 html 渲染器；
 *     覆盖经 normalizeOptions 构造新对象完成，不改动传入的冻结选项；
 *   - 图片一律走 'file' 模式（file:// 绝对路径），打印进程可直接读盘；
 *   - 纸张、横向与页边距交 backend.renderPdf 的 print 参数，最终落到 Chromium 的 printToPDF。
 * soffice 路径需要 DOCX 输入，故以 getDocxBuffer 惰性提供 renderers/docx 的产物，
 * 仅在真正走到该分支时才渲染 DOCX；该分支不支持上述打印参数（已知限制）。
 */
const htmlRenderer = require('./html');
const docxRenderer = require('./docx');
const backend = require('../pdf/backend');
const { normalizeOptions } = require('../options');

/**
 * @param {object} doc MarkFlowDocument
 * @param {object} [options] 经 converters/options.js 归一的选项；省略则全取默认值
 * @returns {Promise<Buffer>} PDF 二进制
 */
async function render(doc, options) {
    const opts = normalizeOptions(options);
    const htmlOptions = normalizeOptions({ ...opts, html: { ...opts.html, theme: opts.pdf.theme } });
    const html = await htmlRenderer.render(doc, htmlOptions, { imageMode: 'file' });
    return backend.renderPdf({
        html,
        getDocxBuffer: () => docxRenderer.render(doc, opts),
        print: { pageSize: opts.pdf.pageSize, landscape: opts.pdf.landscape, margins: { ...opts.pdf.margins } },
    });
}

// 只导出 render：能力探测由 CLI 与 MCP 直连 converters/pdf/backend.detect()
module.exports = { render };
