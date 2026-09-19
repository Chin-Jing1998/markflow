/**
 * converters/assets/image-normalize.js 单元测试
 *
 * 覆盖：位图 → JPEG（透明铺白、JFIF 密度 330 PPI）、保持原格式的各类情形、
 * IR 的 url/assetName/data.asset 同步、keep 模式零改动、宽度上限与 patent profile 例外。
 *
 * 夹具一律用 jimp 现造（png/bmp/tiff/gif 均可由 jimp 编码）；WebP 与动图 GIF 无法由 jimp 编码，
 * 以 base64 常量内联（分别为 cwebp 与 ImageMagick 生成的 8×8 / 4×4 极小样本）。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { imageSize } = require('image-size');
const fs = require('node:fs');
const path = require('node:path');

const crypto = require('node:crypto');
const JSZip = require('jszip');
const {
    normalizeImages, restoreOriginals, isAnimatedGif, setJpegDensity, sniffImageMime,
} = require('../converters/assets/image-normalize');
const { loadJimp } = require('../converters/assets/jimp-loader');
const { normalizeOptions } = require('../converters/options');
const { convert } = require('../converters');

const FIXTURE_DOCX = path.join(__dirname, 'fixtures', 'images-sample.docx');
const TMP_ROOT = path.join(__dirname, 'tmp');

// 8×8 无损 WebP（左上角红、其余透明）
const WEBP_8X8 = Buffer.from('UklGRiQAAABXRUJQVlA4TBcAAAAvB8ABEA8Q8x/zHwyBbPLlb51ERP9DBgA=', 'base64');
// 4×4 两帧动图 GIF（含 NETSCAPE 循环扩展与两个图形控制扩展）
const ANIMATED_GIF = Buffer.from(
    'R0lGODlhBAAEAPAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQABQAAACwAAAAABAAEAAACBISPCQUA'
    + 'IfkEAAUAAAAsAAAAAAQABAAAAgSMjxkFADs=',
    'base64',
);
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>', 'utf8');
// 体量护栏阈值（与 image-normalize.js 保持一致）
const MAX_ASSET_BYTES = 200 * 1024 * 1024;
// PNG 的 IHDR 恒为首个区块：签名 8 字节 + 长度 4 + 'IHDR' 4，故宽高分别落在下标 16 与 20
const PNG_IHDR_WIDTH_OFFSET = 16;
const PNG_IHDR_HEIGHT_OFFSET = 20;

// ============================================================
// 夹具
// ============================================================

/** 造图并编码为指定 mime；transparent 为真时整张全透明，否则不透明纯红 */
async function makeImage(mime, { width = 8, height = 8, transparent = false } = {}) {
    const { Jimp } = await loadJimp();
    const image = new Jimp({ width, height, color: transparent ? 0x00000000 : 0xFF0000FF });
    return image.getBuffer(mime);
}

async function readSize(buffer) {
    const { Jimp } = await loadJimp();
    const image = await Jimp.read(buffer);
    return { width: image.width, height: image.height };
}

/** 读回 JPEG 的四角像素（RGBA 数组） */
async function cornerPixels(buffer) {
    const { Jimp } = await loadJimp();
    const image = await Jimp.read(buffer);
    const at = (x, y) => {
        const offset = (y * image.width + x) * 4;
        return [...image.bitmap.data.subarray(offset, offset + 4)];
    };
    return [at(0, 0), at(image.width - 1, 0), at(0, image.height - 1), at(image.width - 1, image.height - 1)];
}

/** 解析 JPEG 的 JFIF APP0 密度；无 APP0 返回 null */
function readJfifDensity(buffer) {
    if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) return null;
    let at = 2;
    while (at + 4 <= buffer.length && buffer[at] === 0xFF) {
        const marker = buffer[at + 1];
        if (marker === 0xDA) return null;
        const length = buffer.readUInt16BE(at + 2);
        if (marker === 0xE0 && buffer.subarray(at + 4, at + 9).toString('latin1') === 'JFIF\x00') {
            return { units: buffer[at + 11], x: buffer.readUInt16BE(at + 12), y: buffer.readUInt16BE(at + 14) };
        }
        at += 2 + length;
    }
    return null;
}

const imageNode = (url, data) => ({ type: 'image', url, alt: '图', data });

function makeDoc(assets, children = []) {
    return {
        schemaVersion: 1,
        kind: 'document',
        ir: { type: 'root', children },
        data: null,
        meta: { title: 'T' },
        assets,
        extras: [],
        warnings: [],
    };
}

const jpgOptions = (patch = {}) => normalizeOptions(patch);

// ============================================================
// 位图 → JPEG
// ============================================================

test('透明 PNG 转 JPEG：铺白后四角像素为白，资源名与 mime 同步改为 jpg', async () => {
    // Arrange
    const png = await makeImage('image/png', { transparent: true });
    const doc = makeDoc([{ name: 'images/image_1.png', buffer: png, mime: 'image/png' }]);

    // Act
    const result = await normalizeImages(doc, jpgOptions());

    // Assert
    assert.equal(result.converted, 1);
    assert.equal(result.kept, 0);
    assert.deepEqual(result.warnings, []);
    const [asset] = result.doc.assets;
    assert.equal(asset.name, 'images/image_1.jpg');
    assert.equal(asset.mime, 'image/jpeg');
    assert.equal(asset.buffer.subarray(0, 2).toString('hex'), 'ffd8');
    for (const [r, g, b] of await cornerPixels(asset.buffer)) {
        assert.ok(r > 250 && g > 250 && b > 250, `透明像素应铺白，实际 rgb(${r},${g},${b})`);
    }
});

test('BMP / TIFF / WebP / 静态 GIF 均转为 JPEG', async () => {
    // Arrange
    const assets = [
        { name: 'images/image_1.bmp', buffer: await makeImage('image/bmp'), mime: 'image/bmp' },
        { name: 'images/image_2.tiff', buffer: await makeImage('image/tiff'), mime: 'image/tiff' },
        { name: 'images/image_3.webp', buffer: WEBP_8X8, mime: 'image/webp' },
        { name: 'images/image_4.gif', buffer: await makeImage('image/gif'), mime: 'image/gif' },
    ];

    // Act
    const result = await normalizeImages(makeDoc(assets), jpgOptions());

    // Assert
    assert.equal(result.converted, 4);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(
        result.doc.assets.map((a) => [a.name, a.mime]),
        [
            ['images/image_1.jpg', 'image/jpeg'], ['images/image_2.jpg', 'image/jpeg'],
            ['images/image_3.jpg', 'image/jpeg'], ['images/image_4.jpg', 'image/jpeg'],
        ],
    );
});

test('产出 JPEG 的 JFIF APP0 密度为每英寸 330', async () => {
    // Arrange
    const doc = makeDoc([{ name: 'images/image_1.png', buffer: await makeImage('image/png'), mime: 'image/png' }]);

    // Act
    const result = await normalizeImages(doc, jpgOptions());

    // Assert
    assert.deepEqual(readJfifDensity(result.doc.assets[0].buffer), { units: 1, x: 330, y: 330 });
});

// ============================================================
// 保持原格式的情形
// ============================================================

test('动图 GIF / SVG / EMF 均保持原样并记中文 warning', async () => {
    // Arrange
    const assets = [
        { name: 'images/image_1.gif', buffer: ANIMATED_GIF, mime: 'image/gif' },
        { name: 'images/image_2.svg', buffer: SVG_BYTES, mime: 'image/svg+xml' },
        { name: 'images/image_3.emf', buffer: Buffer.from([1, 0, 0, 0, 9, 9]), mime: 'image/x-emf' },
    ];
    const doc = makeDoc(assets);

    // Act
    const result = await normalizeImages(doc, jpgOptions());

    // Assert：零转换即原样返回入参 doc
    assert.equal(result.converted, 0);
    assert.equal(result.kept, 3);
    assert.equal(result.doc, doc);
    assert.equal(result.warnings.length, 3);
    assert.match(result.warnings[0], /images\/image_1\.gif 保持原格式：动图 GIF/);
    assert.match(result.warnings[1], /images\/image_2\.svg 保持原格式：矢量图 SVG/);
    // 图元只在 patent profile 下栅格化（详见 test/metafile-normalize.test.js），此处的 generic profile 一律保持原样
    assert.equal(
        result.warnings[2],
        '图片 images/image_3.emf 保持原格式：EMF/WMF 图元只在专利（patent）profile 下栅格化为 JPG',
    );
});

test('像素数超阈值的图片保持原样：文件头声明 12000×8000 即被拦下，4000×3000 照常转码', async () => {
    // Arrange：伪造 PNG 的 IHDR 宽高（image-size 只读文件头、不校验 CRC），文件本身仍是小图
    const png = await makeImage('image/png');
    const huge = Buffer.from(png);
    huge.writeUInt32BE(12000, PNG_IHDR_WIDTH_OFFSET);
    huge.writeUInt32BE(8000, PNG_IHDR_HEIGHT_OFFSET);
    const scan = Buffer.from(png);
    scan.writeUInt32BE(4000, PNG_IHDR_WIDTH_OFFSET);
    scan.writeUInt32BE(3000, PNG_IHDR_HEIGHT_OFFSET);

    // Act
    const result = await normalizeImages(makeDoc([
        { name: 'images/image_1.png', buffer: huge, mime: 'image/png' },
        { name: 'images/image_2.png', buffer: scan, mime: 'image/png' },
    ]), jpgOptions());

    // Assert：12000×8000 = 9600 万像素越界；4000×3000 = 1200 万像素未越界，走解码（伪造尺寸令解码失败，
    // 但失败原因是「解码或编码失败」而非体量护栏，足以证明护栏没有拦它）
    assert.equal(result.doc.assets[0].name, 'images/image_1.png');
    assert.match(result.warnings[0], /images\/image_1\.png 保持原格式：单图 12000×8000 超过 8000 万像素上限（约 10000×8000）/);
    assert.match(result.warnings[1], /images\/image_2\.png 保持原格式：解码或编码失败/);
});

test('字节数超 200 MB 的图片保持原样，且不读取其内容', async () => {
    // Arrange：零填充的桩 buffer，仅 length 越界；护栏先判字节数，故不会触碰这块内存
    const doc = makeDoc([{ name: 'images/image_1.png', buffer: Buffer.alloc(MAX_ASSET_BYTES + 1), mime: 'image/png' }]);

    // Act
    const result = await normalizeImages(doc, jpgOptions());

    // Assert
    assert.equal(result.converted, 0);
    assert.equal(result.kept, 1);
    assert.equal(result.doc, doc);
    assert.match(result.warnings[0], /images\/image_1\.png 保持原格式：单图 200\.0 MB 超过 200 MB 上限/);
});

test('解码失败的位图保持原格式并记 warning，不影响同批其它图片', async () => {
    // Arrange：声明为 png 但内容不是 png
    const assets = [
        { name: 'images/image_1.png', buffer: Buffer.from('这不是图片', 'utf8'), mime: 'image/png' },
        { name: 'images/image_2.png', buffer: await makeImage('image/png'), mime: 'image/png' },
    ];

    // Act
    const result = await normalizeImages(makeDoc(assets), jpgOptions());

    // Assert
    assert.equal(result.converted, 1);
    assert.equal(result.kept, 1);
    assert.equal(result.doc.assets[0].name, 'images/image_1.png');
    assert.equal(result.doc.assets[1].name, 'images/image_2.jpg');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /images\/image_1\.png 保持原格式：解码或编码失败/);
});

test('已是 JPEG 的资源不重编码、不告警，只补写 JFIF 密度且计入 kept', async () => {
    // Arrange：jimp 产出的 JPEG 其 APP0 为无单位 1×1
    const jpeg = await makeImage('image/jpeg');
    const doc = makeDoc([{ name: 'images/image_1.jpg', buffer: jpeg, mime: 'image/jpeg' }]);

    // Act
    const result = await normalizeImages(doc, jpgOptions());
    const [asset] = result.doc.assets;

    // Assert
    assert.equal(result.converted, 0, 'JPEG 只补密度，不算转换');
    assert.equal(result.kept, 1);
    assert.deepEqual(result.warnings, []);
    assert.equal(asset.name, 'images/image_1.jpg');
    assert.deepEqual(readJfifDensity(asset.buffer), { units: 1, x: 330, y: 330 });
    // APP0 段（下标 2–19）之外的字节逐字未动，即压缩数据未重编码
    assert.equal(asset.buffer.length, jpeg.length);
    assert.ok(asset.buffer.subarray(20).equals(jpeg.subarray(20)), 'APP0 之后的压缩数据应逐字不变');
});

// ============================================================
// IR 同步
// ============================================================

test('IR 中 image 节点的 url 与 data.assetName 随资源改名同步，入参 IR 不被改动', async () => {
    // Arrange：node1 走 url + assetName；node2 只有 assetName（url 为远程地址）；node3 无对应资源
    const png = await makeImage('image/png');
    const node1 = imageNode('images/image_1.png', { assetName: 'images/image_1.png' });
    const node2 = imageNode('https://example.com/a.png', { assetName: 'images/image_1.png' });
    const node3 = imageNode('https://example.com/b.png', null);
    const paragraph = { type: 'paragraph', children: [node1, node2, node3] };
    const doc = makeDoc([{ name: 'images/image_1.png', buffer: png, mime: 'image/png' }], [paragraph]);

    // Act
    const result = await normalizeImages(doc, jpgOptions());
    const [next1, next2, next3] = result.doc.ir.children[0].children;

    // Assert
    assert.equal(next1.url, 'images/image_1.jpg');
    assert.equal(next1.data.assetName, 'images/image_1.jpg');
    // url 只在等于旧资源名时改写
    assert.equal(next2.url, 'https://example.com/a.png');
    assert.equal(next2.data.assetName, 'images/image_1.jpg');
    // 无对应资源的节点沿用原引用
    assert.equal(next3, node3);
    // 入参 IR 原样未动
    assert.equal(node1.url, 'images/image_1.png');
    assert.equal(node1.data.assetName, 'images/image_1.png');
    assert.equal(doc.assets[0].mime, 'image/png');
});

test('md 文档的 data.asset 同步为 JPG 并置 normalized，absPath 保留', async () => {
    // Arrange
    const png = await makeImage('image/png');
    const node = imageNode('images/image_1.png', {
        assetName: 'images/image_1.png',
        asset: { absPath: '/tmp/x/pic.png', buffer: png, mime: 'image/png', width: 8, height: 8 },
    });
    const doc = makeDoc([{ name: 'images/image_1.png', buffer: png, mime: 'image/png' }], [node]);

    // Act
    const result = await normalizeImages(doc, jpgOptions());
    const { asset } = result.doc.ir.children[0].data;

    // Assert
    assert.equal(asset.mime, 'image/jpeg');
    assert.equal(asset.buffer, result.doc.assets[0].buffer);
    assert.equal(asset.absPath, '/tmp/x/pic.png');
    assert.equal(asset.normalized, true);
    assert.deepEqual([asset.width, asset.height], [8, 8]);
    // 入参节点上的 asset 未被改动
    assert.equal(node.data.asset.mime, 'image/png');
    assert.equal(node.data.asset.normalized, undefined);
});

// ============================================================
// 选项
// ============================================================

// ============================================================
// 原图留存与还原（bundle 目标）
// ============================================================

test('字节被改动的资产带 original（原名、原字节、原 mime）；再次归一仍只记最初那份', async () => {
    // Arrange
    const png = await makeImage('image/png');
    const jpeg = await makeImage('image/jpeg');
    const doc = makeDoc([
        { name: 'images/image_1.png', buffer: png, mime: 'image/png' },
        { name: 'images/image_2.jpg', buffer: jpeg, mime: 'image/jpeg' },
    ]);

    // Act
    const first = await normalizeImages(doc, jpgOptions());
    const second = await normalizeImages(first.doc, jpgOptions());

    // Assert：转码与只补密度的资产都留存原图
    assert.deepEqual(first.doc.assets.map((a) => [a.name, a.original.name, a.original.mime]), [
        ['images/image_1.jpg', 'images/image_1.png', 'image/png'],
        ['images/image_2.jpg', 'images/image_2.jpg', 'image/jpeg'],
    ]);
    assert.ok(first.doc.assets[0].original.buffer.equals(png));
    assert.ok(first.doc.assets[1].original.buffer.equals(jpeg));
    assert.ok(second.doc.assets[0].original.buffer.equals(png), '再次归一沿用最初的原图');
    assert.equal(second.doc.assets[0].original.name, 'images/image_1.png');
});

test('restoreOriginals 换回原图与原资源名，IR 的 url / assetName / data.asset 同步改回；无可恢复资产时返回同一引用', async () => {
    // Arrange
    const png = await makeImage('image/png', { width: 12, height: 6 });
    const node = imageNode('images/image_1.png', {
        assetName: 'images/image_1.png',
        asset: { absPath: '/tmp/x/pic.png', buffer: png, mime: 'image/png', width: 12, height: 6 },
        display: { width: 300, unit: 'px', source: 'docx' },
    });
    const doc = makeDoc([{ name: 'images/image_1.png', buffer: png, mime: 'image/png' }], [{ type: 'paragraph', children: [node] }]);
    const normalized = (await normalizeImages(doc, jpgOptions())).doc;

    // Act
    const restored = restoreOriginals(normalized);
    const back = restored.ir.children[0].children[0];

    // Assert
    assert.deepEqual(restored.assets.map((a) => [a.name, a.mime, 'original' in a]), [['images/image_1.png', 'image/png', false]]);
    assert.ok(restored.assets[0].buffer.equals(png));
    assert.equal(back.url, 'images/image_1.png');
    assert.equal(back.data.assetName, 'images/image_1.png');
    assert.ok(back.data.asset.buffer.equals(png));
    assert.equal(back.data.asset.mime, 'image/png');
    assert.equal(back.data.asset.normalized, undefined);
    assert.equal(back.data.asset.absPath, '/tmp/x/pic.png');
    assert.deepEqual([back.data.asset.width, back.data.asset.height], [12, 6]);
    assert.deepEqual(back.data.display, { width: 300, unit: 'px', source: 'docx' });
    assert.equal(normalized.ir.children[0].children[0].url, 'images/image_1.jpg', '入参不被改动');
    assert.equal(restoreOriginals(doc), doc);
});

test('imageFormat=keep 时零改动：doc 原样返回，converted 为 0', async () => {
    // Arrange
    const doc = makeDoc([{ name: 'images/image_1.png', buffer: await makeImage('image/png'), mime: 'image/png' }]);

    // Act
    const result = await normalizeImages(doc, jpgOptions({ imageFormat: 'keep' }));

    // Assert
    assert.equal(result.doc, doc);
    assert.equal(result.converted, 0);
    assert.equal(result.kept, 1);
    assert.deepEqual(result.warnings, []);
});

test('宽度超过 raster.maxWidth 时等比缩小；patent profile 下不缩放', async () => {
    // Arrange
    const wide = await makeImage('image/png', { width: 300, height: 60 });
    const assetOf = () => [{ name: 'images/image_1.png', buffer: wide, mime: 'image/png' }];

    // Act
    const scaled = await normalizeImages(makeDoc(assetOf()), jpgOptions({ raster: { maxWidth: 200 } }));
    const patent = await normalizeImages(
        makeDoc(assetOf()),
        jpgOptions({ raster: { maxWidth: 200 }, xml: { profile: 'patent' } }),
    );

    // Assert
    assert.deepEqual(await readSize(scaled.doc.assets[0].buffer), { width: 200, height: 40 });
    assert.deepEqual(await readSize(patent.doc.assets[0].buffer), { width: 300, height: 60 });
});

// ============================================================
// patent profile：按 Word 显示尺寸在 jpegPpi 下重采样
// ============================================================

// 官方样例实测值：wp:extent 5272405×2597785 EMU = 146.4557×72.1607 mm，300 DPI 下官方输出 1730×852
const OFFICIAL_MM = { width: 146.45572, height: 72.16072 };
const OFFICIAL_PX = { width: 1730, height: 852 };

const docxDoc = (assets, children) => ({ ...makeDoc(assets, children), meta: { title: 'T', sourceType: 'docx' } });

test('patent profile：按 displayWidthMm/displayHeightMm 在 300 DPI 下重采样，像素与官方一致且 JFIF 密度同为 300', async () => {
    // Arrange：嵌入像素远小于显示尺寸，正是官方样例的形态（981×569 的 PNG 显示成 146×72 mm）
    const png = await makeImage('image/png', { width: 981, height: 569 });
    const doc = docxDoc(
        [{ name: 'images/image_1.png', buffer: png, mime: 'image/png' }],
        [imageNode('images/image_1.png', { displayWidthMm: OFFICIAL_MM.width, displayHeightMm: OFFICIAL_MM.height })],
    );

    // Act
    const result = await normalizeImages(doc, jpgOptions({ xml: { profile: 'patent' } }));

    // Assert
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(await readSize(result.doc.assets[0].buffer), OFFICIAL_PX);
    assert.deepEqual(readJfifDensity(result.doc.assets[0].buffer), { units: 1, x: 300, y: 300 });
});

test('重采样只在 patent profile 生效：generic profile 下像素与嵌入原图一致', async () => {
    // Arrange
    const png = await makeImage('image/png', { width: 100, height: 50 });
    const assetOf = () => [{ name: 'images/image_1.png', buffer: png, mime: 'image/png' }];
    const childrenOf = () => [imageNode('images/image_1.png', { displayWidthMm: OFFICIAL_MM.width, displayHeightMm: OFFICIAL_MM.height })];

    // Act
    const generic = await normalizeImages(docxDoc(assetOf(), childrenOf()), jpgOptions());
    const patent = await normalizeImages(docxDoc(assetOf(), childrenOf()), jpgOptions({ xml: { profile: 'patent' } }));

    // Assert
    assert.deepEqual(await readSize(generic.doc.assets[0].buffer), { width: 100, height: 50 });
    assert.deepEqual(await readSize(patent.doc.assets[0].buffer), OFFICIAL_PX);
});

// 把 JPEG 文件头 SOF 段声明的宽高改写为指定值：只动文件头，供体量护栏类用例伪造超大图
function declareJpegSize(buffer, width, height) {
    const out = Buffer.from(buffer);
    let offset = 2;
    while (offset + 9 < out.length && out[offset] === 0xff) {
        const marker = out[offset + 1];
        if (marker >= 0xc0 && marker <= 0xc2) {
            out.writeUInt16BE(height, offset + 5);
            out.writeUInt16BE(width, offset + 7);
            return out;
        }
        offset += 2 + out.readUInt16BE(offset + 2);
    }
    throw new Error('未找到 SOF 段');
}

test('patent profile：体量超护栏的 JPEG 不解码不重采样，但仍补写 300 DPI 密度并告警', async () => {
    // Arrange：文件头声明 12000×8000（9600 万像素）越过体量护栏；显示尺寸齐备，本应触发重采样
    const jpeg = declareJpegSize(await makeImage('image/jpeg', { width: 8, height: 8 }), 12000, 8000);
    const doc = docxDoc(
        [{ name: 'images/image_1.jpg', buffer: jpeg, mime: 'image/jpeg' }],
        [imageNode('images/image_1.jpg', { displayWidthMm: OFFICIAL_MM.width, displayHeightMm: OFFICIAL_MM.height })],
    );

    // Act
    const result = await normalizeImages(doc, jpgOptions({ xml: { profile: 'patent' } }));

    // Assert：像素原样（文件头仍声明 12000×8000），密度补为 300，且给出一条跳过重采样的告警
    // 只读文件头取尺寸：readSize 会整图解码，对声明 9600 万像素的伪造图必然超出解码器内存上限
    const header = imageSize(result.doc.assets[0].buffer);
    assert.deepEqual({ width: header.width, height: header.height }, { width: 12000, height: 8000 });
    assert.deepEqual(readJfifDensity(result.doc.assets[0].buffer), { units: 1, x: 300, y: 300 });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /images\/image_1\.jpg/);
    assert.match(result.warnings[0], /12000×8000/);
});

test('重采样目标像素随 jpegPpi 走：显式 150 PPI 得一半像素，且 JFIF 密度同为 150', async () => {
    // Arrange
    const png = await makeImage('image/png', { width: 40, height: 20 });
    const doc = docxDoc(
        [{ name: 'images/image_1.png', buffer: png, mime: 'image/png' }],
        [imageNode('images/image_1.png', { displayWidthMm: 25.4, displayHeightMm: 12.7 })],
    );

    // Act
    const result = await normalizeImages(doc, jpgOptions({ jpegPpi: 150, xml: { profile: 'patent' } }));

    // Assert：25.4 mm = 1 英寸，150 PPI 即 150 px
    assert.deepEqual(await readSize(result.doc.assets[0].buffer), { width: 150, height: 75 });
    assert.deepEqual(readJfifDensity(result.doc.assets[0].buffer), { units: 1, x: 150, y: 150 });
});

test('已是 JPEG 的资产同样按显示尺寸重采样，但仍按「格式未变」计入 kept', async () => {
    // Arrange
    const jpeg = await makeImage('image/jpeg', { width: 60, height: 30 });
    const doc = docxDoc(
        [{ name: 'images/image_1.jpg', buffer: jpeg, mime: 'image/jpeg' }],
        [imageNode('images/image_1.jpg', { displayWidthMm: 25.4, displayHeightMm: 12.7 })],
    );

    // Act
    const result = await normalizeImages(doc, jpgOptions({ xml: { profile: 'patent' } }));

    // Assert
    assert.equal(result.converted, 0);
    assert.equal(result.kept, 1);
    assert.deepEqual(await readSize(result.doc.assets[0].buffer), { width: 300, height: 150 });
});

test('docx 来源取不到显示尺寸时保留嵌入像素并告警；md 等本就不记尺寸的来源不告警', async () => {
    // Arrange
    const png = await makeImage('image/png', { width: 80, height: 40 });
    const assetOf = () => [{ name: 'images/image_1.png', buffer: png, mime: 'image/png' }];
    const childrenOf = () => [imageNode('images/image_1.png', { display: { width: 80, unit: 'px' } })];
    const patentOptions = jpgOptions({ xml: { profile: 'patent' } });

    // Act
    const fromDocx = await normalizeImages(docxDoc(assetOf(), childrenOf()), patentOptions);
    const fromMd = await normalizeImages(
        { ...makeDoc(assetOf(), childrenOf()), meta: { title: 'T', sourceType: 'md' } },
        patentOptions,
    );

    // Assert
    assert.deepEqual(fromDocx.warnings, ['图片 images/image_1.png 未按 Word 显示尺寸重采样：源文档中未记录该图的显示尺寸，已按嵌入像素输出']);
    assert.deepEqual(fromMd.warnings, []);
    assert.deepEqual(await readSize(fromDocx.doc.assets[0].buffer), { width: 80, height: 40 });
    assert.deepEqual(await readSize(fromMd.doc.assets[0].buffer), { width: 80, height: 40 });
});

test('重采样护栏：目标单边超过 20000 px 时保留嵌入像素并告警，仍照常转为 JPEG', async () => {
    // Arrange：2000 mm 在 300 DPI 下约 23622 px，越过单边上限
    const png = await makeImage('image/png', { width: 40, height: 20 });
    const doc = docxDoc(
        [{ name: 'images/image_1.png', buffer: png, mime: 'image/png' }],
        [imageNode('images/image_1.png', { displayWidthMm: 2000, displayHeightMm: 1000 })],
    );

    // Act
    const result = await normalizeImages(doc, jpgOptions({ xml: { profile: 'patent' } }));

    // Assert
    assert.equal(result.converted, 1);
    assert.equal(result.doc.assets[0].name, 'images/image_1.jpg');
    assert.deepEqual(await readSize(result.doc.assets[0].buffer), { width: 40, height: 20 });
    assert.match(result.warnings[0], /^图片 images\/image_1\.png 未按 Word 显示尺寸重采样：目标 23622×11811 的单边超过 20000 px 上限，已按嵌入像素输出$/);
});

test('IR 上没有 image 节点引用的资产不参与重采样，也不告警', async () => {
    // Arrange
    const png = await makeImage('image/png', { width: 40, height: 20 });
    const doc = docxDoc([{ name: 'images/image_1.png', buffer: png, mime: 'image/png' }], []);

    // Act
    const result = await normalizeImages(doc, jpgOptions({ xml: { profile: 'patent' } }));

    // Assert
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(await readSize(result.doc.assets[0].buffer), { width: 40, height: 20 });
});

test('jpegQuality 生效：质量 60 的产物显著小于质量 100', async () => {
    // Arrange
    const png = await makeImage('image/png', { width: 64, height: 64 });
    const assetOf = () => [{ name: 'images/image_1.png', buffer: png, mime: 'image/png' }];

    // Act
    const low = await normalizeImages(makeDoc(assetOf()), jpgOptions({ jpegQuality: 60 }));
    const high = await normalizeImages(makeDoc(assetOf()), jpgOptions({ jpegQuality: 100 }));

    // Assert
    assert.ok(
        low.doc.assets[0].buffer.length < high.doc.assets[0].buffer.length,
        '质量 60 的 JPEG 应小于质量 100',
    );
});

test('无资源或空文档时原样返回', async () => {
    // Arrange
    const doc = makeDoc([]);

    // Act
    const result = await normalizeImages(doc, jpgOptions());

    // Assert
    assert.deepEqual(result, { doc, converted: 0, kept: 0, warnings: [] });
});

// ============================================================
// 导出的小工具
// ============================================================

test('sniffImageMime 按魔数识别常见图片类型，未知返回 null', async () => {
    // Arrange & Act & Assert
    assert.equal(sniffImageMime(await makeImage('image/png')), 'image/png');
    assert.equal(sniffImageMime(await makeImage('image/jpeg')), 'image/jpeg');
    assert.equal(sniffImageMime(await makeImage('image/gif')), 'image/gif');
    assert.equal(sniffImageMime(await makeImage('image/bmp')), 'image/bmp');
    assert.equal(sniffImageMime(await makeImage('image/tiff')), 'image/tiff');
    assert.equal(sniffImageMime(WEBP_8X8), 'image/webp');
    assert.equal(sniffImageMime(SVG_BYTES), 'image/svg+xml');
    assert.equal(sniffImageMime(Buffer.from('随便一段文字', 'utf8')), null);
    assert.equal(sniffImageMime(Buffer.alloc(0)), null);
});

test('mime 缺失的资源按魔数嗅探后照常转 JPEG', async () => {
    // Arrange
    const doc = makeDoc([
        { name: 'images/image_1.bin', buffer: await makeImage('image/png'), mime: 'application/octet-stream' },
        { name: 'images/image_2.bin', buffer: SVG_BYTES, mime: undefined },
    ]);

    // Act
    const result = await normalizeImages(doc, jpgOptions());

    // Assert
    assert.equal(result.doc.assets[0].name, 'images/image_1.jpg');
    assert.equal(result.doc.assets[1].name, 'images/image_2.bin');
    assert.match(result.warnings[0], /矢量图 SVG/);
});

test('isAnimatedGif 只对多帧 GIF 为真', async () => {
    // Arrange & Act & Assert
    assert.equal(isAnimatedGif(ANIMATED_GIF), true);
    assert.equal(isAnimatedGif(await makeImage('image/gif')), false);
    assert.equal(isAnimatedGif(await makeImage('image/png')), false);
    assert.equal(isAnimatedGif(Buffer.alloc(0)), false);
});

test('setJpegDensity 改写已有 APP0，无 APP0 时插入一段，非 JPEG 原样返回', async () => {
    // Arrange
    const jpeg = await makeImage('image/jpeg');
    assert.deepEqual(readJfifDensity(jpeg), { units: 0, x: 1, y: 1 }, 'jimp 输出的 APP0 密度应为无单位 1×1');
    // 去掉 APP0 段（FF E0 + 长度 16 + 16 字节内容 = 18 字节）
    const withoutApp0 = Buffer.concat([jpeg.subarray(0, 2), jpeg.subarray(20)]);

    // Act
    const patched = setJpegDensity(jpeg, 300);
    const inserted = setJpegDensity(withoutApp0, 150);
    const notJpeg = Buffer.from('abc');

    // Assert
    assert.deepEqual(readJfifDensity(patched), { units: 1, x: 300, y: 300 });
    assert.equal(patched.length, jpeg.length, '改写已有 APP0 不应改变长度');
    assert.deepEqual(readJfifDensity(inserted), { units: 1, x: 150, y: 150 });
    assert.equal(inserted.length, withoutApp0.length + 18);
    assert.equal(setJpegDensity(notJpeg, 300), notJpeg);
});

// ============================================================
// 端到端：含图片的 docx → bundle
// ============================================================

test('含图片的 docx 转 html：images/ 全为 .jpg、html 引用一致、密度 330、透明图四角为白（bundle 以外的目标照常归一）', async () => {
    // Arrange：夹具由 test/fixtures/build-images-sample.js 生成（不透明 64×48 + 带 alpha 的 32×32）
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    const outputDir = fs.mkdtempSync(path.join(TMP_ROOT, 'image-normalize-'));
    after(() => fs.rmSync(outputDir, { recursive: true, force: true }));

    // Act
    const result = await convert({ input: { path: FIXTURE_DOCX }, target: 'html', outputDir });

    // Assert：产物目录下的图片一律是 JPEG
    const imagesDir = result.outputs.imagesDir;
    const files = fs.readdirSync(imagesDir).sort();
    assert.deepEqual(files, ['image_1.jpg', 'image_2.jpg']);
    assert.equal(result.imagesCount, 2);

    // Assert：HTML 的引用与落盘文件逐一对应
    const html = fs.readFileSync(result.outputs.html, 'utf8');
    const referenced = [...html.matchAll(/<img src="(images\/[^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(referenced, ['images/image_1.jpg', 'images/image_2.jpg']);

    // Assert：每张产物都是 JPEG 且 JFIF 密度为每英寸 330
    for (const file of files) {
        const buffer = fs.readFileSync(path.join(imagesDir, file));
        assert.equal(buffer.subarray(0, 2).toString('hex'), 'ffd8', file);
        assert.deepEqual(readJfifDensity(buffer), { units: 1, x: 330, y: 330 }, file);
    }

    // Assert：带 alpha 的那张（32×32）铺白后四角为白
    const { Jimp } = await loadJimp();
    const sized = await Promise.all(files.map(async (file) => {
        const buffer = fs.readFileSync(path.join(imagesDir, file));
        const image = await Jimp.read(buffer);
        return { buffer, width: image.width };
    }));
    const alpha = sized.find((item) => item.width === 32);
    assert.ok(alpha, `应有一张 32 像素宽的产物，实际宽度为 ${sized.map((s) => s.width).join('、')}`);
    for (const [r, g, b] of await cornerPixels(alpha.buffer)) {
        assert.ok(r > 250 && g > 250 && b > 250, `透明像素应铺白，实际 rgb(${r},${g},${b})`);
    }
});

test('含图片的 docx 转 bundle：images/ 与 docx 内 word/media/* 逐字节一致（不转码、不改密度），md 以 <img width> 引用原扩展名', async () => {
    // Arrange
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    const outputDir = fs.mkdtempSync(path.join(TMP_ROOT, 'image-bundle-'));
    after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
    const zip = await JSZip.loadAsync(fs.readFileSync(FIXTURE_DOCX));
    const media = await Promise.all(Object.keys(zip.files)
        .filter((name) => name.startsWith('word/media/') && !zip.files[name].dir)
        .map((name) => zip.file(name).async('nodebuffer')));
    const sha256 = (buffers) => buffers.map((buffer) => crypto.createHash('sha256').update(buffer).digest('hex')).sort();

    // Act
    const result = await convert({ input: { path: FIXTURE_DOCX }, target: 'bundle', outputDir });

    // Assert：原图原扩展名，字节与 docx 内媒体完全一致
    const files = fs.readdirSync(result.outputs.imagesDir).sort();
    assert.deepEqual(files, ['image_1.png', 'image_2.png']);
    const written = files.map((file) => fs.readFileSync(path.join(result.outputs.imagesDir, file)));
    assert.deepEqual(sha256(written), sha256(media));

    // Assert：md 引用原资源名，宽度取 docx 的 wp:extent
    const markdown = fs.readFileSync(result.outputs.md, 'utf8');
    const referenced = [...markdown.matchAll(/<img src="(images\/[^"]+)" width="(\d+)"/g)].map((m) => [m[1], Number(m[2])]);
    assert.deepEqual(referenced, [['images/image_1.png', 64], ['images/image_2.png', 32]]);
    assert.ok(fs.existsSync(result.outputs.contentList), '产物应含 {name}_content_list.json');
});
