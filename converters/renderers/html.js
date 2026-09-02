/**
 * IR → HTML 字符串
 *
 * 职责：mdast → hast（remark-rehype）→ HTML（rehype-stringify），套内联样式输出完整页面。
 * 定位：主要作为 PDF 渲染的中间产物（Electron/Chromium 打印），因此：
 *   - 关闭 allowDangerousHtml，IR 中的原始 HTML 只保留去标签后的文本，杜绝脚本注入；
 *   - 带 data.asset.absPath 的图片改写为 file:// 绝对路径，打印进程可直接读盘；
 *   - 内联 CSS 使用 CJK 字体栈，并声明 @page 边距，表格/代码块按打印场景设置换行与边框。
 */
const { pathToFileURL } = require('url');
const { stripHtml } = require('../ir/util');
const { loadUnified } = require('../ir/unified-loader');
const { downgradeCustomNodes } = require('../ir/schema');

const FONT_STACK =
    '-apple-system, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Segoe UI", sans-serif';
const MONO_FONT_STACK = '"SF Mono", Menlo, Consolas, "Courier New", monospace';

const PAGE_CSS = `
@page { margin: 1.5cm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: ${FONT_STACK}; font-size: 11pt; line-height: 1.7; color: #1d1d1f; margin: 0; padding: 0; overflow-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.4em 0 0.5em; page-break-after: avoid; }
h1 { font-size: 1.8em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; }
p { margin: 0.6em 0; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #d2d2d7; padding: 0.4em 0.7em; text-align: left; vertical-align: top; }
th { background: #f5f5f7; font-weight: 600; }
tr { page-break-inside: avoid; }
code, pre { font-family: ${MONO_FONT_STACK}; }
code { background: #f5f5f7; padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; }
pre { background: #f5f5f7; padding: 0.8em 1em; border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #d2d2d7; margin: 1em 0; padding: 0.2em 1em; color: #6e6e73; }
hr { border: none; border-top: 1px solid #d2d2d7; margin: 2em 0; }
a { color: #0071e3; text-decoration: none; }
ul.contains-task-list { list-style: none; padding-left: 1.2em; }
.task-list-item input[type="checkbox"] { margin-right: 0.4em; vertical-align: middle; }
`;

// ============================================================
// 入口
// ============================================================

async function render(doc) {
    if (!doc || typeof doc !== 'object') throw new Error('html 渲染器需要 doc 对象');
    const { unified, remarkRehype, rehypeStringify } = await loadUnified();
    const root = downgradeCustomNodes(doc.ir || { type: 'root', children: [] });

    const hast = await unified()
        .use(remarkRehype, {
            allowDangerousHtml: false,
            handlers: { image: imageHandler, html: htmlHandler },
        })
        .run(root);
    const body = unified().use(rehypeStringify, { allowDangerousHtml: false }).stringify(hast);

    const title = escapeHtml((doc.meta && doc.meta.title) || '');
    return wrapDocument(title, body);
}

// ============================================================
// 自定义 handler
// ============================================================

/** image：带本地 asset 的图片写成 file:// 绝对路径，其余保留原 url */
function imageHandler(state, node) {
    const properties = { src: resolveImageSrc(node) };
    if (node.alt !== null && node.alt !== undefined) properties.alt = node.alt;
    if (node.title !== null && node.title !== undefined) properties.title = node.title;
    const result = { type: 'element', tagName: 'img', properties, children: [] };
    state.patch(node, result);
    return state.applyData(node, result);
}

function resolveImageSrc(node) {
    const asset = node.data && node.data.asset;
    if (asset && typeof asset.absPath === 'string' && asset.absPath) {
        try {
            return pathToFileURL(asset.absPath).href;
        } catch (err) {
            // 非法路径时回退到原始 url
        }
    }
    return typeof node.url === 'string' ? node.url : '';
}

/** html：原始 HTML 不透传，去标签后仅保留文本（script/style 连同内容一并丢弃） */
function htmlHandler(state, node) {
    const value = stripHtml(node.value);
    if (!value.trim()) return undefined;
    const result = { type: 'text', value };
    state.patch(node, result);
    return result;
}

// ============================================================
// 页面包装与工具
// ============================================================

function wrapDocument(title, body) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}


function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = { render };
