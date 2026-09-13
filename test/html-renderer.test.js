/**
 * converters/renderers/html.js 单元测试
 * 覆盖：原始 HTML 安全（script/onerror 不透传）、file:// 图片路径、无 asset 图片丢弃 src、
 *       打印页面 CSP、<title> 转义、GFM 表格/删除线/任务列表、CJK 字体栈与打印 CSS、自定义节点降级、
 *       relative/inline/{ base } 三种图片寻址与各自 CSP、资产寻址的三条路径、非法寻址模式报错、
 *       safeTable 白名单透传与越界降级、math 节点的 MathML 透传与文本降级、主题切换
 * 前 8 例不传 options：渲染器此时按打印场景取值（print 主题 + file 寻址），与 v2 行为一致。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { loadUnified } = require('../converters/ir/unified-loader');
const htmlRenderer = require('../converters/renderers/html');
const { normalizeOptions } = require('../converters/options');
const { createMath } = require('../converters/ir/schema');

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

function makeDoc(ir, meta = {}, assets = []) {
    return {
        schemaVersion: 1,
        kind: 'document',
        ir,
        data: null,
        meta: { title: '测试文档', sourceType: 'md', ...meta },
        assets,
        warnings: [],
    };
}

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);
const IMAGE_ASSET = { name: 'images/image_1.png', buffer: PNG, mime: 'image/png' };

/** 单张图片的文档：节点形态由 imageNode 决定，assets 固定登记 images/image_1.png */
function makeImageDoc(imageNode, assets = [IMAGE_ASSET]) {
    const ir = { type: 'root', children: [{ type: 'paragraph', children: [imageNode] }] };
    return makeDoc(ir, {}, assets);
}

const HTML_OPTIONS = (html = {}) => normalizeOptions({ html });

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

// ============================================================
// 图片寻址模式
// ============================================================

test('relative 模式：src 取资产名，CSP 放行 self 与 file:', async () => {
    // Arrange
    const doc = makeImageDoc({ type: 'image', url: 'images/image_1.png', alt: '图', title: '说明' });

    // Act
    const html = await htmlRenderer.render(doc, HTML_OPTIONS(), { imageMode: 'relative' });

    // Assert
    assert.ok(html.includes('<img src="images/image_1.png" alt="图" title="说明">'), html);
    assert.ok(html.includes(`content="default-src 'none'; img-src 'self' file: data:; style-src 'unsafe-inline'; font-src file: data:"`));
});

test('inline 模式：src 为 data URI，CSP 只放行 data:', async () => {
    // Arrange
    const doc = makeImageDoc({ type: 'image', url: 'images/image_1.png', alt: '图' });

    // Act
    const html = await htmlRenderer.render(doc, HTML_OPTIONS({ inlineImages: true }), { imageMode: 'inline' });

    // Assert
    assert.ok(html.includes(`src="data:image/png;base64,${PNG.toString('base64')}"`), html);
    assert.ok(html.includes(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src file: data:"`));
});

test('inline 模式：assets 未登记时回退到节点自带的 data.asset.buffer', async () => {
    // Arrange
    const node = { type: 'image', url: 'https://example.com/a.png', alt: '图' };
    node.data = { asset: { absPath: ASSET_PATH, buffer: PNG, mime: 'image/png' } };

    // Act
    const html = await htmlRenderer.render(makeImageDoc(node, []), HTML_OPTIONS(), { imageMode: 'inline' });

    // Assert
    assert.ok(html.includes('src="data:image/png;base64,'), html);
    assert.ok(!html.includes('example.com'), '远程地址不得出现在产物中');
});

test('{ base } 模式：src 为 base + 资产名，base 末尾自动补斜杠，CSP 由协议派生', async () => {
    // Arrange
    const doc = makeImageDoc({ type: 'image', url: 'images/image_1.png', alt: '图' });

    // Act
    const html = await htmlRenderer.render(doc, HTML_OPTIONS(), { imageMode: { base: 'mf-asset://s1' } });

    // Assert
    assert.ok(html.includes('<img src="mf-asset://s1/images/image_1.png" alt="图">'), html);
    assert.ok(html.includes(`content="default-src 'none'; img-src mf-asset: data:; style-src 'unsafe-inline'; font-src file: data:"`));
});

test('资产寻址两条路径：data.assetName 优先，其次 url 命中资产名；资产未登记则不出 src', async () => {
    // Arrange：三个节点分别为「只有 assetName」「只有 url」「两者都不命中 assets」
    const byName = { type: 'image', url: 'images/原始名.png', alt: 'A', data: { assetName: 'images/image_1.png' } };
    const byUrl = { type: 'image', url: 'images/image_1.png', alt: 'B' };
    const unknown = { type: 'image', url: 'images/未登记.png', alt: 'C' };
    const ir = { type: 'root', children: [{ type: 'paragraph', children: [byName, byUrl, unknown] }] };

    // Act
    const html = await htmlRenderer.render(makeDoc(ir, {}, [IMAGE_ASSET]), HTML_OPTIONS(), { imageMode: 'relative' });

    // Assert
    assert.equal((html.match(/src="images\/image_1\.png"/g) || []).length, 2, html);
    assert.ok(!html.includes('原始名') && !html.includes('未登记'), '节点原始 url 不应出现在 src 中');
    assert.ok(html.includes('<img alt="C">'), '未登记为资产的图片只留 alt');
});

test('relative 与 base 模式下，未登记为资产的图片仍然只留 alt', async () => {
    // Arrange
    const remote = { type: 'image', url: 'https://example.com/a.png', alt: '远程' };

    // Act
    const relative = await htmlRenderer.render(makeImageDoc(remote, []), HTML_OPTIONS(), { imageMode: 'relative' });
    const based = await htmlRenderer.render(makeImageDoc(remote, []), HTML_OPTIONS(), { imageMode: { base: 'mf-asset://s1/' } });

    // Assert
    for (const html of [relative, based]) {
        assert.ok(!html.includes('example.com'), html);
        assert.ok(!/<img[^>]*\ssrc=/.test(html), '无资产的图片不得带 src');
        assert.ok(html.includes('<img alt="远程">'));
    }
});

test('非法的图片寻址模式与缺协议的 base 抛中文错误', async () => {
    // Arrange
    const doc = makeImageDoc({ type: 'image', url: 'images/image_1.png', alt: '图' });

    // Assert
    await assert.rejects(() => htmlRenderer.render(doc, HTML_OPTIONS(), { imageMode: 'remote' }), /未知的图片寻址模式/);
    await assert.rejects(() => htmlRenderer.render(doc, HTML_OPTIONS(), { imageMode: { base: '/assets/' } }), /图片寻址 base/);
    await assert.rejects(() => htmlRenderer.render(doc, HTML_OPTIONS(), { imageMode: {} }), /图片寻址模式/);
});

// ============================================================
// safeTable 与 math
// ============================================================

test('带 data.safeTable 的 html 节点原样输出，普通 html 节点仍去标签', async () => {
    // Arrange
    const table = '<table><thead><tr><th colspan="2">头</th></tr></thead><tbody><tr><td>甲</td><td>乙</td></tr></tbody></table>';
    const ir = {
        type: 'root',
        children: [
            { type: 'html', value: table, data: { safeTable: true } },
            { type: 'html', value: '<div class="x">纯文本</div>' },
        ],
    };

    // Act
    const html = await htmlRenderer.render(makeDoc(ir), HTML_OPTIONS(), { imageMode: 'relative' });

    // Assert
    assert.ok(html.includes(table), 'safeTable 应原样透传');
    assert.ok(html.includes('纯文本') && !html.includes('<div class="x">'), '普通 html 节点应去标签');
});

test('safeTable 越出白名单（事件属性、内嵌脚本、非表格标签）时降级为文本', async () => {
    // Arrange
    const cases = [
        '<table><tr><td onclick="alert(1)">坏</td></tr></table>',
        '<table><tr><td><script>alert(1)</script>坏</td></tr></table>',
        '<table><tr><td><a href="javascript:alert(1)">坏</a></td></tr></table>',
        '<table><tr><td style="x">坏</td></tr></table>',
        '<table><!-- 注释 --><tr><td>坏</td></tr></table>',
    ];

    for (const value of cases) {
        // Act
        const ir = { type: 'root', children: [{ type: 'html', value, data: { safeTable: true } }] };
        const html = await htmlRenderer.render(makeDoc(ir), HTML_OPTIONS(), { imageMode: 'relative' });

        // Assert
        assert.ok(!html.includes('<table'), `不应透传：${value}`);
        assert.ok(!html.includes('onclick') && !html.includes('<script') && !html.includes('javascript:'), value);
        assert.ok(html.includes('坏'), '降级后文本应保留');
    }
});

test('math 节点：合法 MathML 原样输出，缺 MathML 时降级为 span.mf-math 并转义文本', async () => {
    // Arrange
    const mathml = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac><mi>a</mi><mn>2</mn></mfrac></math>';
    const ir = {
        type: 'root',
        children: [
            { type: 'paragraph', children: [{ type: 'text', value: '前 ' }, createMath({ mathml, text: 'a/2' })] },
            createMath({ text: 'a<b', display: true }),
        ],
    };

    // Act
    const html = await htmlRenderer.render(makeDoc(ir), HTML_OPTIONS(), { imageMode: 'relative' });

    // Assert
    assert.ok(html.includes(mathml), 'MathML 应原样输出');
    const span = /<span class="mf-math mf-math-display">([^<]*)<\/span>/.exec(html);
    assert.ok(span, html);
    assert.match(span[1], /a(&lt;|&#x3C;|&#60;)b/i, '降级文本中的 < 须转义');
});

test('math 节点：MathML 含脚本、事件属性、annotation-xml 或非 math 根时一律降级为文本', async () => {
    // Arrange
    const cases = [
        '<math><script>alert(1)</script><mi>x</mi></math>',
        '<math onload="alert(1)"><mi>x</mi></math>',
        '<math><annotation-xml encoding="text/html"><img src=x onerror=alert(1)></annotation-xml></math>',
        '<math><mi href="javascript:alert(1)">x</mi></math>',
        '<div><math><mi>x</mi></math></div>',
        '<math><mi>x</mi>',
    ];

    for (const mathml of cases) {
        // Act
        const ir = { type: 'root', children: [createMath({ mathml, text: '降级文本' })] };
        const html = await htmlRenderer.render(makeDoc(ir), HTML_OPTIONS(), { imageMode: 'relative' });

        // Assert
        assert.ok(html.includes('<span class="mf-math">降级文本</span>'), `${mathml} 应降级`);
        assert.ok(!html.includes('<math') && !html.includes('<script') && !html.includes('onerror'), mathml);
    }
});

// ============================================================
// 主题
// ============================================================

test('options.html.theme 决定样式，<title> 与 lang 不受主题影响', async () => {
    // Arrange
    const ir = await parseMarkdown('正文\n');

    // Act
    const github = await htmlRenderer.render(makeDoc(ir), HTML_OPTIONS({ theme: 'github' }), { imageMode: 'relative' });
    const dark = await htmlRenderer.render(makeDoc(ir), HTML_OPTIONS({ theme: 'apple-dark' }), { imageMode: 'relative' });

    // Assert
    assert.ok(github.includes('#0969da'), 'github 主题应含其链接色');
    assert.ok(!github.includes('@page { margin: 1.5cm; }'), '非 print 主题不应含打印分页规则');
    assert.ok(dark.includes('background: #1c1c1e'), 'apple-dark 应为深色底');
    for (const html of [github, dark]) {
        assert.ok(html.includes('<html lang="zh-CN">'));
        assert.ok(html.includes('<title>测试文档</title>'));
        assert.ok(html.includes(':root{--mf-font:'), '变量块应在主题样式之前');
    }
});

test('省略 options 时按打印场景取值：print 主题 + file 寻址', async () => {
    // Arrange
    const ir = await parseMarkdown('正文\n');

    // Act
    const omitted = await htmlRenderer.render(makeDoc(ir));
    const explicit = await htmlRenderer.render(makeDoc(ir), HTML_OPTIONS({ theme: 'print' }), { imageMode: 'file' });

    // Assert
    assert.equal(omitted, explicit);
    assert.ok(omitted.includes('@page { margin: 1.5cm; }'));
});
