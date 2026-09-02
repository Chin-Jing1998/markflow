/**
 * converters/renderers/html.js 单元测试
 * 覆盖：原始 HTML 安全（script/onerror 不透传）、file:// 图片路径、无 asset 图片丢弃 src、
 *       打印页面 CSP、<title> 转义、GFM 表格/删除线/任务列表、CJK 字体栈与打印 CSS、自定义节点降级
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { loadUnified } = require('../converters/ir/unified-loader');
const htmlRenderer = require('../converters/renderers/html');

// ============================================================
// 辅助
// ============================================================

async function parseMarkdown(md) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    return unified().use(remarkParse).use(remarkGfm).parse(md);
}

function collect(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) {
        for (const child of node.children) collect(child, predicate, out);
    }
    return out;
}

function makeDoc(ir, meta = {}) {
    return {
        schemaVersion: 1,
        kind: 'document',
        ir,
        data: null,
        meta: { title: '测试文档', sourceType: 'md', ...meta },
        assets: [],
        warnings: [],
    };
}

const ASSET_PATH = path.join(os.tmpdir(), 'markflow-html-test', '图 片.png');

// ============================================================
// 用例
// ============================================================

test('原始 HTML 不透传：script 与 onerror 被移除，普通行内标签仅保留文本', async () => {
    // Arrange
    const md = [
        '# 标题',
        '',
        '<script>alert(1)</script>',
        '',
        '内联 <img src=x onerror=alert(1)> 与 <b>粗体</b> 文本',
        '',
        '<style>body{display:none}</style>',
        '',
    ].join('\n');
    const ir = await parseMarkdown(md);

    // Act
    const html = await htmlRenderer.render(makeDoc(ir));

    // Assert
    assert.ok(!html.includes('<script'), 'script 标签不得出现');
    assert.ok(!html.includes('alert(1)'), 'script 内容不得出现');
    assert.ok(!html.includes('onerror'), '事件属性不得出现');
    assert.ok(!html.includes('display:none'), 'style 内容不得出现');
    assert.ok(html.includes('粗体'), '行内标签内文本应保留');
    assert.ok(html.includes('<h1>标题</h1>'));
});

test('带 asset 的图片 src 改写为 file:// 绝对路径，保留 alt 与 title', async () => {
    // Arrange
    const ir = await parseMarkdown('![本地](images/pic.png "说明")\n');
    const images = collect(ir, (n) => n.type === 'image');
    images[0].data = { asset: { absPath: ASSET_PATH, buffer: Buffer.alloc(0), mime: 'image/png', width: 8, height: 8 } };

    // Act
    const html = await htmlRenderer.render(makeDoc(ir));

    // Assert
    const expected = pathToFileURL(ASSET_PATH).href;
    assert.ok(expected.startsWith('file://'));
    assert.ok(html.includes(`src="${expected}"`), `本地图片 src 应为 ${expected}`);
    assert.ok(html.includes('alt="本地"') && html.includes('title="说明"'));
});

test('无本地 asset 的图片一律丢弃 src：远程、内网与 file:// URL 都不出现在输出中', async () => {
    // Arrange：打印窗口会真实发起请求，故被 SSRF 守卫拒绝的地址不得进入 <img src>
    const md = [
        '![远程](https://example.com/a.png)',
        '',
        '![内网](http://192.168.1.1/probe.png)',
        '',
        '![本机](http://127.0.0.1:8080/x.png "标题")',
        '',
        '![元数据](http://169.254.169.254/latest/meta-data/)',
        '',
        '![本地文件](file:///etc/hosts)',
        '',
    ].join('\n');
    const ir = await parseMarkdown(md);

    // Act
    const html = await htmlRenderer.render(makeDoc(ir));

    // Assert
    for (const url of ['example.com', '192.168.1.1', '127.0.0.1', '169.254.169.254', '/etc/hosts']) {
        assert.ok(!html.includes(url), `输出中不得出现 ${url}`);
    }
    assert.ok(!/<img[^>]*\ssrc=/.test(html), '无 asset 的图片不得带 src 属性');
    assert.ok(html.includes('<img alt="远程">'), 'alt 文本应保留为占位');
    assert.ok(!html.includes('title="标题"'), '无来源图片不保留 title');
});

test('打印页面 <head> 声明 CSP：默认全禁，图片与字体只放行 file: 与 data:', async () => {
    // Arrange
    const ir = await parseMarkdown('正文\n');

    // Act
    const html = await htmlRenderer.render(makeDoc(ir));

    // Assert
    const csp = "default-src 'none'; img-src file: data:; style-src 'unsafe-inline'; font-src file: data:";
    assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${csp}">`), `应含 CSP：${csp}`);
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<body>'), 'CSP 须在 <body> 之前声明');
});

test('<title> 使用 meta.title 并做 HTML 转义', async () => {
    // Arrange
    const ir = await parseMarkdown('正文\n');

    // Act
    const html = await htmlRenderer.render(makeDoc(ir, { title: 'A & B <x> "q"' }));

    // Assert
    assert.ok(html.includes('<title>A &amp; B &lt;x&gt; &quot;q&quot;</title>'));
    assert.ok(html.includes('<html lang="zh-CN">'));
    assert.ok(html.includes('<meta charset="utf-8">'));
});

test('GFM 表格、删除线、任务列表转为对应 HTML 结构', async () => {
    // Arrange
    const md = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '', '~~删~~', '', '- [ ] 待办', '- [x] 已办', ''].join('\n');
    const ir = await parseMarkdown(md);

    // Act
    const html = await htmlRenderer.render(makeDoc(ir));

    // Assert
    assert.ok(html.includes('<table>'));
    assert.ok(html.includes('<th>A</th>'));
    assert.ok(html.includes('<del>删</del>'));
    assert.ok(html.includes('type="checkbox" checked'));
    assert.ok(!html.includes('| ---'));
});

test('内联 CSS 含 CJK 字体栈、@page 边距、表格边框与代码块换行', async () => {
    // Arrange
    const ir = await parseMarkdown('正文\n');

    // Act
    const html = await htmlRenderer.render(makeDoc(ir));

    // Assert
    assert.ok(html.includes('"PingFang SC"') && html.includes('"Microsoft YaHei"') && html.includes('"Noto Sans CJK SC"'));
    assert.ok(html.includes('@page { margin: 1.5cm; }'));
    assert.ok(html.includes('border-collapse: collapse'));
    assert.ok(html.includes('white-space: pre-wrap; word-break: break-all'));
    assert.ok(html.includes('img { max-width: 100%'));
    assert.ok(html.includes('blockquote { border-left'));
});

test('slideBreak/sheetSection 自定义节点降级后可渲染', async () => {
    // Arrange
    const ir = {
        type: 'root',
        children: [
            { type: 'sheetSection', data: { name: '工作表一', index: 0 } },
            { type: 'paragraph', children: [{ type: 'text', value: '内容' }] },
            { type: 'slideBreak', data: { title: '第二页', index: 1 } },
        ],
    };

    // Act
    const html = await htmlRenderer.render(makeDoc(ir));

    // Assert
    assert.ok(html.includes('<h1>工作表一</h1>'));
    assert.ok(html.includes('<hr>'));
    assert.ok(html.includes('<h2>第二页</h2>'));
});
