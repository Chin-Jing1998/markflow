/**
 * converters/parsers/md.js 单元测试
 * 覆盖：GFM 扩展、宽松标题预处理、CRLF 归一、meta 字段、本地/远程图片资源
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { parse } = require('../converters/parsers/md');

// ============================================================
// 测试夹具：手工生成合法 PNG（避免引入二进制测试资源）
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
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 2;  // color type: truecolor
    const raw = Buffer.alloc((width * 3 + 1) * height, 0);
    return Buffer.concat([
        signature,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

// ============================================================
// 测试夹具：临时目录与源文档
// ============================================================

const MD_LINES = [
    '#紧贴标题',
    '',
    '# 标题',
    '',
    '＃全角',
    '',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '~~删除线~~',
    '',
    '- [ ] 待办',
    '- [x] 已办',
    '',
    '![图](images/pic.png)',
    '',
    '![远程](https://example.com/a.png)',
    '',
];

function makeFixture() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-md-parser-')));
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images', 'pic.png'), makePng(8, 8));
    const lfPath = path.join(dir, 'doc.md');
    const crlfPath = path.join(dir, 'doc-crlf.md');
    fs.writeFileSync(lfPath, MD_LINES.join('\n'), 'utf8');
    fs.writeFileSync(crlfPath, MD_LINES.join('\r\n'), 'utf8');
    return { dir, lfPath, crlfPath };
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

// ============================================================
// 用例
// ============================================================

test('三种标题写法（缺空格 / 标准 / 全角井号）均解析为 depth 1 heading', async () => {
    // Arrange
    const { lfPath } = makeFixture();

    // Act
    const doc = await parse({ path: lfPath });
    const headings = collect(doc.ir, (n) => n.type === 'heading');

    // Assert
    assert.equal(headings.length, 3);
    assert.deepEqual(headings.map((h) => h.depth), [1, 1, 1]);
    assert.deepEqual(headings.map(plainText), ['紧贴标题', '标题', '全角']);
});

test('remark-gfm 生效：表格、删除线、任务列表被解析为对应节点', async () => {
    // Arrange
    const { lfPath } = makeFixture();

    // Act
    const doc = await parse({ path: lfPath });

    // Assert
    const tables = collect(doc.ir, (n) => n.type === 'table');
    assert.equal(tables.length, 1);
    assert.equal(collect(tables[0], (n) => n.type === 'tableRow').length, 2);

    assert.equal(collect(doc.ir, (n) => n.type === 'delete').length, 1);

    const items = collect(doc.ir, (n) => n.type === 'listItem');
    assert.deepEqual(items.map((n) => n.checked), [false, true]);
});

test('meta 取首个 H1 为 title，baseDir 为源文件所在目录', async () => {
    // Arrange
    const { dir, lfPath } = makeFixture();

    // Act
    const doc = await parse({ path: lfPath });

    // Assert
    assert.equal(doc.meta.title, '紧贴标题');
    assert.equal(doc.meta.baseDir, dir);
    assert.equal(doc.meta.sourceType, 'md');
    assert.equal(doc.meta.sourceName, 'doc.md');
});

test('无 H1 时 title 回退为去扩展名的文件名', async () => {
    // Arrange
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-md-parser-')));
    const target = path.join(dir, '知识库笔记.md');
    fs.writeFileSync(target, '## 二级标题\n\n正文\n', 'utf8');

    // Act
    const doc = await parse({ path: target });

    // Assert
    assert.equal(doc.meta.title, '知识库笔记');
});

test('本地相对路径图片进 assets 且 url 改写为资源名，远程图片记 warning 且保持原样', async () => {
    // Arrange
    const { dir, lfPath } = makeFixture();

    // Act
    const doc = await parse({ path: lfPath });
    const images = collect(doc.ir, (n) => n.type === 'image');

    // Assert
    assert.equal(images.length, 2);

    const local = images.find((n) => n.data && n.data.asset);
    assert.equal(local.url, 'images/image_1.png', '本地图片的 url 应改写为资源名');
    assert.equal(local.data.assetName, 'images/image_1.png');
    assert.ok(Buffer.isBuffer(local.data.asset.buffer));
    assert.equal(local.data.asset.width, 8);
    assert.equal(local.data.asset.height, 8);
    assert.equal(local.data.asset.mime, 'image/png');
    assert.equal(local.data.asset.absPath, path.join(dir, 'images', 'pic.png'));

    // 未取到 buffer 的远程图片不登记，url 与 data 均保持原样
    const remote = images.find((n) => n.url === 'https://example.com/a.png');
    assert.equal(remote.data && remote.data.asset, undefined);
    assert.equal(remote.data && remote.data.assetName, undefined);

    assert.equal(doc.assets.length, 1);
    assert.equal(doc.assets[0].name, 'images/image_1.png');
    assert.ok(
        doc.warnings.some((w) => w.includes('远程图片未内嵌')),
        `warnings 应含远程未内嵌提示，实际为 ${JSON.stringify(doc.warnings)}`,
    );
});

test('CRLF 输入与 LF 输入解析结果一致', async () => {
    // Arrange
    const { lfPath, crlfPath } = makeFixture();

    // Act
    const lfDoc = await parse({ path: lfPath });
    const crlfDoc = await parse({ path: crlfPath });

    // Assert
    assert.deepStrictEqual(crlfDoc.ir, lfDoc.ir);
});

test('input.text 形态可用，baseDir 取 ctx.baseDir', async () => {
    // Arrange
    const { dir } = makeFixture();

    // Act
    const doc = await parse({ text: '# 内联标题\n\n![图](images/pic.png)\n' }, { baseDir: dir });
    const [image] = collect(doc.ir, (n) => n.type === 'image');

    // Assert
    assert.equal(doc.meta.title, '内联标题');
    assert.equal(doc.meta.baseDir, dir);
    assert.equal(image.data.asset.width, 8);
});

// 最小合法 GIF：image-size 只读前 10 字节的签名与宽高
const GIF_1X1 = Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]),
]);

// 8×8 无损 WebP（cwebp 生成），用于验证 svg/webp 一类非内嵌格式同样进 assets
const WEBP_8X8 = Buffer.from('UklGRiQAAABXRUJQVlA4TBcAAAAvB8ABEA8Q8x/zHwyBbPLlb51ERP9DBgA=', 'base64');

test('凡取到 buffer 的图片都进 assets（含 svg/webp）并统一编号，同一 url 只登记一次', async () => {
    // Arrange：png 被引用两次，另有 gif、svg、webp 各一
    const { dir } = makeFixture();
    fs.writeFileSync(path.join(dir, 'images', 'anim.gif'), GIF_1X1);
    fs.writeFileSync(
        path.join(dir, 'images', 'logo.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>',
    );
    fs.writeFileSync(path.join(dir, 'images', 'shot.webp'), WEBP_8X8);
    const md = [
        '![一](images/pic.png)', '',
        '![二](images/pic.png)', '',
        '![三](images/anim.gif)', '',
        '![四](images/logo.svg)', '',
        '![五](images/shot.webp)', '',
    ].join('\n');

    // Act
    const doc = await parse({ text: md }, { baseDir: dir });
    const images = collect(doc.ir, (n) => n.type === 'image');

    // Assert
    assert.deepEqual(
        doc.assets.map((a) => [a.name, a.mime]),
        [
            ['images/image_1.png', 'image/png'],
            ['images/image_2.gif', 'image/gif'],
            ['images/image_3.svg', 'image/svg+xml'],
            ['images/image_4.webp', 'image/webp'],
        ],
    );
    // 每个节点的 url 与 data.assetName 一致；重复引用的 png 复用同一资源
    assert.deepEqual(images.map((n) => n.url), [
        'images/image_1.png', 'images/image_1.png', 'images/image_2.gif',
        'images/image_3.svg', 'images/image_4.webp',
    ]);
    assert.deepEqual(images.map((n) => n.data.assetName), images.map((n) => n.url));
    // data.asset 原样保留，docx/pdf 渲染器仍按它取 buffer
    const svg = images.find((n) => n.url === 'images/image_3.svg');
    assert.equal(svg.data.asset.mime, 'image/svg+xml');
});

test('资源名不沿用 Markdown 中的原始地址，子目录与中文文件名同样被编号', async () => {
    // Arrange：图片放在多层子目录，目录名与文件名均为中文
    const { dir } = makeFixture();
    const nested = path.join(dir, 'assets', '插图');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, '示意图.png'), makePng(4, 4));

    // Act
    const doc = await parse({ text: '![示意](assets/插图/示意图.png)\n' }, { baseDir: dir });

    // Assert
    assert.deepEqual(doc.assets.map((a) => a.name), ['images/image_1.png']);
    assert.equal(collect(doc.ir, (n) => n.type === 'image')[0].url, 'images/image_1.png');
});

test('<img width> 进 assets 并统一编号，保留 data.asset.absPath 与 data.display；<u> 成 underline；越界与脚本协议不收', async () => {
    // Arrange
    const { dir } = makeFixture();
    const md = [
        '<img src="images/pic.png" width="300" alt="示意">', '',
        '行内<img src="images/pic.png" width="50%">与<u>下划线</u>', '',
        '<img src="../outside.png" width="100">', '',
        '<img src="javascript:alert(1)">', '',
    ].join('\n');

    // Act
    const doc = await parse({ text: md }, { baseDir: dir });
    const images = collect(doc.ir, (n) => n.type === 'image');

    // Assert：两处引用同一文件，只登记一份资源
    assert.deepEqual(doc.assets.map((a) => a.name), ['images/image_1.png']);
    assert.equal(images.length, 3);
    const [block, inline, outside] = images;
    assert.equal(block.url, 'images/image_1.png');
    assert.equal(block.alt, '示意');
    assert.equal(block.data.asset.absPath, path.join(dir, 'images', 'pic.png'));
    assert.deepEqual(block.data.display, { width: 300, unit: 'px', source: 'html' });
    assert.equal(inline.url, 'images/image_1.png');
    assert.deepEqual(inline.data.display, { width: 50, unit: '%', source: 'html' });

    // Assert：越出 baseDir 的 <img> 与 Markdown 图片一样被拒，不登记
    assert.equal(outside.url, '../outside.png');
    assert.equal(outside.data.asset, undefined);
    assert.ok(doc.warnings.some((w) => w.includes('超出文档目录')), JSON.stringify(doc.warnings));

    // Assert：<u> 提升为 underline；脚本协议的 <img> 不提升，留作 html 由渲染器剥离
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'underline').map(plainText), ['下划线']);
    assert.ok(collect(doc.ir, (n) => n.type === 'html').some((n) => n.value.includes('javascript:')));
});
