/**
 * converters/parsers/url.js 单元测试
 * 覆盖：标题提取顺序、正文结构（heading/table/image）、script 剔除、图片入 assets 与 Referer、
 *       懒加载属性、下载失败降级、data URL 图片、SSRF 守卫拒绝本地地址
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');

const { parse } = require('../converters/parsers/url');

// ============================================================
// 测试夹具：手工生成合法 PNG
// ============================================================

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i += 1) {
        crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(width, height) {
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.alloc((width * 3 + 1) * height, 0);
    return Buffer.concat([
        signature,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

const PNG = makePng(8, 8);
const CHINESE_RE = /[一-龥]/;

// ============================================================
// 测试服务器
// ============================================================

const MAIN_PAGE = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>页面标题</title>
<meta property="og:title" content="OG 标题">
<script>var HEAD_SECRET = 1;</script>
</head><body>
<nav>导航栏</nav>
<article>
<h2>二级标题</h2>
<p>正文含<span style="font-weight:bold">粗体</span>片段</p>
<table><tr><th>列一</th><th>列二</th></tr><tr><td>1</td><td>2</td></tr></table>
<p><img src="/a.png" alt="示意图"></p>
<script>var INNER_SECRET = 2;</script>
</article>
<footer>页脚</footer>
</body></html>`;

const LAZY_PAGE = `<!doctype html>
<html><head><title>懒加载页</title></head><body>
<article>
<h1>懒加载标题</h1>
<p><img data-src="/missing.png" src=""></p>
<p><img data-src="/a.png"></p>
</article>
</body></html>`;

const DATA_URL_PAGE = `<!doctype html>
<html><head><title>内嵌图片页</title></head><body>
<article>
<p><img src="data:image/png;base64,${PNG.toString('base64')}"></p>
</article>
</body></html>`;

function startServer() {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push({ url: req.url, referer: req.headers.referer || null });
        switch (req.url) {
            case '/':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(MAIN_PAGE);
                return;
            case '/lazy':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(LAZY_PAGE);
                return;
            case '/data-url':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(DATA_URL_PAGE);
                return;
            case '/a.png':
                res.writeHead(200, { 'Content-Type': 'image/png' });
                res.end(PNG);
                return;
            default:
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('not found');
        }
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                base: `http://127.0.0.1:${server.address().port}`,
                requests,
                close: () => new Promise((done) => {
                    server.closeAllConnections();
                    server.close(() => done());
                }),
            });
        });
    });
}

// ============================================================
// IR 遍历辅助
// ============================================================

function collect(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) {
        for (const child of node.children) collect(child, predicate, out);
    }
    return out;
}

function plainText(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text' || node.type === 'inlineCode') return String(node.value || '');
    if (!Array.isArray(node.children)) return '';
    return node.children.map(plainText).join('');
}

// 汇总 IR 中所有字面量（text/html/code），用于断言 script 内容被彻底剔除
function allLiterals(ir) {
    return collect(ir, (n) => typeof n.value === 'string').map((n) => n.value).join('\n');
}

// ============================================================
// 用例
// ============================================================

test('解析网页：og:title 作标题，IR 含 heading/table/image，图片进入 assets 且带页面 Referer', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());
    const url = `${server.base}/`;

    // Act
    const doc = await parse({ url }, { allowPrivateNetwork: true });

    // Assert：标题与 meta
    assert.equal(doc.kind, 'document');
    assert.equal(doc.meta.title, 'OG 标题');
    assert.equal(doc.meta.sourceType, 'url');
    assert.equal(doc.meta.sourceUrl, url);

    // Assert：IR 结构
    const headings = collect(doc.ir, (n) => n.type === 'heading');
    assert.deepEqual(headings.map((h) => [h.depth, plainText(h)]), [[1, 'OG 标题'], [2, '二级标题']]);

    assert.deepEqual(collect(doc.ir, (n) => n.type === 'strong').map(plainText), ['粗体']);

    const tables = collect(doc.ir, (n) => n.type === 'table');
    assert.equal(tables.length, 1);
    const rows = collect(tables[0], (n) => n.type === 'tableRow');
    assert.deepEqual(rows.map((r) => r.children.map(plainText)), [['列一', '列二'], ['1', '2']]);

    const images = collect(doc.ir, (n) => n.type === 'image');
    assert.equal(images.length, 1);
    assert.equal(images[0].url, 'images/image_1.png');
    assert.equal(images[0].alt, '示意图');

    // Assert：script 与导航/页脚内容不进入 IR
    const literals = allLiterals(doc.ir);
    assert.ok(!literals.includes('SECRET'), `IR 不应含 script 内容，实际：${literals}`);
    assert.ok(!literals.includes('导航栏') && !literals.includes('页脚'));

    // Assert：assets 与 Referer
    assert.equal(doc.assets.length, 1);
    assert.equal(doc.assets[0].name, 'images/image_1.png');
    assert.equal(doc.assets[0].mime, 'image/png');
    assert.ok(doc.assets[0].buffer.equals(PNG));
    const imageRequest = server.requests.find((r) => r.url === '/a.png');
    assert.equal(imageRequest.referer, url, 'Referer 应为页面 URL 而非图片 URL');
    assert.ok(Array.isArray(doc.warnings));
});

test('懒加载 data-src 被识别；单张下载失败记 warning 并保留原 URL，编号不留空洞', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());
    const url = `${server.base}/lazy`;

    // Act
    const doc = await parse({ url }, { allowPrivateNetwork: true });

    // Assert
    assert.equal(doc.meta.title, '懒加载标题');
    const images = collect(doc.ir, (n) => n.type === 'image');
    assert.deepEqual(images.map((n) => n.url), [`${server.base}/missing.png`, 'images/image_1.png']);
    assert.equal(doc.assets.length, 1);
    assert.equal(doc.assets[0].name, 'images/image_1.png');
    assert.ok(
        doc.warnings.some((w) => w.includes('missing.png') && w.includes('404')),
        `warnings 应记录失败图片，实际为 ${JSON.stringify(doc.warnings)}`,
    );
});

test('data URL 图片解码进入 assets', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());

    // Act
    const doc = await parse({ url: `${server.base}/data-url` }, { allowPrivateNetwork: true });

    // Assert
    const images = collect(doc.ir, (n) => n.type === 'image');
    assert.deepEqual(images.map((n) => n.url), ['images/image_1.png']);
    assert.equal(doc.assets.length, 1);
    assert.equal(doc.assets[0].mime, 'image/png');
    assert.ok(doc.assets[0].buffer.equals(PNG));
});

test('未开启 allowPrivateNetwork 时本地地址被拒并抛中文错误', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());
    const url = `${server.base}/`;

    // Act & Assert
    await assert.rejects(parse({ url }), CHINESE_RE);
    await assert.rejects(parse({ url }, { allowPrivateNetwork: false }), /内网|保留/);
    assert.equal(server.requests.length, 0, '被拒的请求不应到达服务器');
});

test('非法输入与非 http 协议抛中文错误', async () => {
    await assert.rejects(parse({}), /input\.url/);
    await assert.rejects(parse({ url: '   ' }), /input\.url/);
    await assert.rejects(parse({ url: 'ftp://example.com/a' }), /协议/);
});
