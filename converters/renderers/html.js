/**
 * IR → HTML
 * mdast → hast (remark-rehype) → HTML 字符串 (rehype-stringify)
 */
const { loadUnified } = require('../ir/unified-loader');
const { downgradeCustomNodes } = require('../ir/schema');

async function render(doc) {
    const { unified, remarkRehype, rehypeStringify } = await loadUnified();
    const downgraded = downgradeCustomNodes(doc.ir);
    const hast = await unified()
        .use(remarkRehype, { allowDangerousHtml: true })
        .run(downgraded);
    const html = unified()
        .use(rehypeStringify, { allowDangerousHtml: true })
        .stringify(hast);

    const title = (doc.meta && doc.meta.title) || '';
    const wrapped = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; line-height: 1.7; color: #1d1d1f; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin-top: 1.5em; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #d2d2d7; padding: 0.5em 0.8em; text-align: left; }
th { background: #f5f5f7; }
code { background: #f5f5f7; padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; }
pre { background: #f5f5f7; padding: 1em; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #0071e3; padding-left: 1em; color: #6e6e73; margin: 1em 0; }
hr { border: none; border-top: 1px solid #d2d2d7; margin: 2em 0; }
a { color: #0071e3; }
</style>
</head>
<body>
${html}
</body>
</html>`;
    return wrapped;
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

module.exports = { render };
