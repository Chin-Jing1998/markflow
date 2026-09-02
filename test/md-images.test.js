/**
 * converters/assets/md-images.js 单元测试
 * 覆盖：段落/表格单元格/列表项内嵌套 image 解析、本地路径（含 file:// 与 URL 编码中文名）、
 *       文件不存在、远程图片（含/不含 fetchRemote）、data URL、空 IR
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');

const { resolveImages } = require('../converters/assets/md-images');

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

const PNG_8x8 = makePng(8, 8);

// ============================================================
// 测试夹具：临时目录（结束后统一清理）
// ============================================================

const tempDirs = [];

function makeTempDir() {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-md-images-')));
    tempDirs.push(dir);
    return dir;
}

after(() => {
    for (const dir of tempDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ============================================================
// 用例
// ============================================================

test('段落 / 表格单元格 / 列表项中嵌套的 image 节点均被解析，width 均为 8', async () => {
    // Arrange
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images', 'pic.png'), PNG_8x8);

    const paragraphImg = { type: 'image', url: 'images/pic.png', alt: 'p' };
    const tableImg = { type: 'image', url: 'images/pic.png', alt: 't' };
    const listImg = { type: 'image', url: 'images/pic.png', alt: 'l' };
    const ir = {
        type: 'root',
        children: [
            { type: 'paragraph', children: [paragraphImg] },
            {
                type: 'table',
                children: [
                    {
                        type: 'tableRow',
                        children: [
                            { type: 'tableCell', children: [tableImg] },
                        ],
                    },
                ],
            },
            {
                type: 'list',
                children: [
                    {
                        type: 'listItem',
                        children: [
                            { type: 'paragraph', children: [listImg] },
                        ],
                    },
                ],
            },
        ],
    };

    // Act
    const { resolved, warnings } = await resolveImages(ir, dir);

    // Assert
    assert.equal(resolved, 3);
    assert.deepEqual(warnings, []);
    assert.equal(paragraphImg.data.asset.width, 8);
    assert.equal(tableImg.data.asset.width, 8);
    assert.equal(listImg.data.asset.width, 8);
});

test('本地文件不存在时记 warning 且节点保持原样', async () => {
    // Arrange
    const dir = makeTempDir();
    const missingImg = { type: 'image', url: 'images/missing.png' };
    const ir = { type: 'root', children: [{ type: 'paragraph', children: [missingImg] }] };

    // Act
    const { resolved, warnings } = await resolveImages(ir, dir);

    // Assert
    assert.equal(resolved, 0);
    assert.ok(
        warnings.some((w) => w === '图片未找到: images/missing.png'),
        `warnings 应含未找到提示，实际为 ${JSON.stringify(warnings)}`,
    );
    assert.equal(missingImg.data, undefined);
});

test('file:// URL 可解析为本地图片', async () => {
    // Arrange
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    const absPath = path.join(dir, 'images', 'pic.png');
    fs.writeFileSync(absPath, PNG_8x8);
    const fileUrl = pathToFileURL(absPath).href;
    const img = { type: 'image', url: fileUrl };
    const ir = { type: 'root', children: [{ type: 'paragraph', children: [img] }] };

    // Act
    const { resolved, warnings } = await resolveImages(ir, dir);

    // Assert
    assert.equal(resolved, 1);
    assert.deepEqual(warnings, []);
    assert.equal(img.data.asset.width, 8);
    assert.equal(img.data.asset.absPath, absPath);
});

test('URL 编码的中文文件名可解析到磁盘上的中文文件', async () => {
    // Arrange
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    const absPath = path.join(dir, 'images', '图.png');
    fs.writeFileSync(absPath, PNG_8x8);
    const img = { type: 'image', url: 'images/%E5%9B%BE.png' };
    const ir = { type: 'root', children: [{ type: 'paragraph', children: [img] }] };

    // Act
    const { resolved, warnings } = await resolveImages(ir, dir);

    // Assert
    assert.equal(resolved, 1);
    assert.deepEqual(warnings, []);
    assert.equal(img.data.asset.width, 8);
    assert.equal(img.data.asset.absPath, absPath);
});

test('远程图片在无 fetchRemote 时记「远程图片未内嵌」且不挂 asset', async () => {
    // Arrange
    const img = { type: 'image', url: 'https://example.com/a.png' };
    const ir = { type: 'root', children: [{ type: 'paragraph', children: [img] }] };

    // Act
    const { resolved, warnings } = await resolveImages(ir, os.tmpdir());

    // Assert
    assert.equal(resolved, 0);
    assert.ok(
        warnings.some((w) => w === '远程图片未内嵌: https://example.com/a.png'),
        `warnings 应含远程未内嵌提示，实际为 ${JSON.stringify(warnings)}`,
    );
    assert.equal(img.data, undefined);
});

test('注入 fetchRemote 后远程图片被挂上 asset', async () => {
    // Arrange
    const img = { type: 'image', url: 'https://example.com/b.png' };
    const ir = { type: 'root', children: [{ type: 'paragraph', children: [img] }] };
    const fetchRemote = async (url) => {
        assert.equal(url, 'https://example.com/b.png');
        return { buffer: PNG_8x8, mime: 'image/png' };
    };

    // Act
    const { resolved, warnings } = await resolveImages(ir, os.tmpdir(), { fetchRemote });

    // Assert
    assert.equal(resolved, 1);
    assert.deepEqual(warnings, []);
    assert.equal(img.data.asset.width, 8);
    assert.equal(img.data.asset.mime, 'image/png');
    assert.ok(fs.existsSync(img.data.asset.absPath), '远程图片应落临时文件');
});

test('data:image/png;base64 URL 被挂上 asset 且 absPath 存在于磁盘', async () => {
    // Arrange
    const dataUrl = `data:image/png;base64,${PNG_8x8.toString('base64')}`;
    const img = { type: 'image', url: dataUrl };
    const ir = { type: 'root', children: [{ type: 'paragraph', children: [img] }] };

    // Act
    const { resolved, warnings } = await resolveImages(ir, os.tmpdir());

    // Assert
    assert.equal(resolved, 1);
    assert.deepEqual(warnings, []);
    assert.equal(img.data.asset.width, 8);
    assert.equal(img.data.asset.mime, 'image/png');
    assert.ok(fs.existsSync(img.data.asset.absPath), 'data URL 应落临时文件');
});

test('resolveImages 对空 IR 返回 resolved:0 且 warnings 为空', async () => {
    // Arrange
    const ir = { type: 'root', children: [] };

    // Act
    const result = await resolveImages(ir, os.tmpdir());

    // Assert
    assert.deepEqual(result, { resolved: 0, warnings: [] });
});

// ============================================================
// 目录边界：baseDir 之外的图片一律不读盘
// ============================================================

// 构造互不包含的一对目录：base 为文档目录，outside 与它同级，内含一张真实 PNG
function makeIsolatedPair() {
    const root = makeTempDir();
    const base = path.join(root, 'base');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(base);
    fs.mkdirSync(outside);
    const outsidePng = path.join(outside, 'outside.png');
    fs.writeFileSync(outsidePng, PNG_8x8);
    return { base, outsidePng };
}

function singleImageIr(url) {
    const img = { type: 'image', url };
    return { img, ir: { type: 'root', children: [{ type: 'paragraph', children: [img] }] } };
}

test('绝对路径 /etc/hosts 被拒绝：不挂 asset 且记「图片超出文档目录」', async () => {
    // Arrange
    const { base } = makeIsolatedPair();
    const { img, ir } = singleImageIr('/etc/hosts');

    // Act
    const { resolved, warnings } = await resolveImages(ir, base);

    // Assert
    assert.equal(resolved, 0);
    assert.equal(img.data, undefined);
    assert.deepEqual(warnings, ['图片超出文档目录，未内嵌: /etc/hosts']);
});

test('相对路径 ../ 逃出文档目录时被拒绝，即便目标是真实存在的 PNG', async () => {
    // Arrange
    const { base } = makeIsolatedPair();
    const { img, ir } = singleImageIr('../outside/outside.png');

    // Act
    const { resolved, warnings } = await resolveImages(ir, base);

    // Assert
    assert.equal(resolved, 0);
    assert.equal(img.data, undefined);
    assert.deepEqual(warnings, ['图片超出文档目录，未内嵌: ../outside/outside.png']);
});

test('file:// 指向文档目录之外时同样被拒绝', async () => {
    // Arrange
    const { base, outsidePng } = makeIsolatedPair();
    const fileUrl = pathToFileURL(outsidePng).href;
    const { img, ir } = singleImageIr(fileUrl);

    // Act
    const { resolved, warnings } = await resolveImages(ir, base);

    // Assert
    assert.equal(resolved, 0);
    assert.equal(img.data, undefined);
    assert.deepEqual(warnings, [`图片超出文档目录，未内嵌: ${fileUrl}`]);
});

test('文档目录内指向外部的符号链接被拒绝（realpath 二次判定）', async () => {
    // Arrange
    const { base, outsidePng } = makeIsolatedPair();
    fs.mkdirSync(path.join(base, 'images'));
    fs.symlinkSync(outsidePng, path.join(base, 'images', 'link.png'));
    const { img, ir } = singleImageIr('images/link.png');

    // Act
    const { resolved, warnings } = await resolveImages(ir, base);

    // Assert
    assert.equal(resolved, 0);
    assert.equal(img.data, undefined);
    assert.deepEqual(warnings, ['图片超出文档目录，未内嵌: images/link.png']);
});

test('文档目录内的相对路径（含 ./ 前缀）不受边界判定影响', async () => {
    // Arrange
    const { base } = makeIsolatedPair();
    fs.mkdirSync(path.join(base, 'images'));
    const absPath = path.join(base, 'images', 'pic.png');
    fs.writeFileSync(absPath, PNG_8x8);
    const plain = { type: 'image', url: 'images/pic.png' };
    const dotted = { type: 'image', url: './images/pic.png' };
    const ir = { type: 'root', children: [{ type: 'paragraph', children: [plain, dotted] }] };

    // Act
    const { resolved, warnings } = await resolveImages(ir, base);

    // Assert
    assert.equal(resolved, 2);
    assert.deepEqual(warnings, []);
    assert.equal(plain.data.asset.absPath, absPath);
    assert.equal(dotted.data.asset.absPath, absPath);
    assert.equal(dotted.data.asset.width, 8);
});

// ============================================================
// 临时文件：进程私有目录 + 0600 + 同内容复用
// ============================================================

test('data URL 落盘到 mkdtemp 私有目录，权限 0600，且同内容复用同一文件', async () => {
    // Arrange
    const dataUrl = `data:image/png;base64,${PNG_8x8.toString('base64')}`;
    const first = singleImageIr(dataUrl);
    const second = singleImageIr(dataUrl);

    // Act
    await resolveImages(first.ir, os.tmpdir());
    await resolveImages(second.ir, os.tmpdir());
    const target = first.img.data.asset.absPath;
    const dir = path.dirname(target);

    // Assert：目录名带 mkdtemp 随机后缀，不是可预测的固定目录
    assert.ok(path.basename(dir).startsWith('markflow-md-assets-'), `实际目录为 ${dir}`);
    assert.ok(path.basename(dir).length > 'markflow-md-assets-'.length, `目录缺少随机后缀：${dir}`);
    assert.notEqual(dir, path.join(os.tmpdir(), 'markflow-md-assets'));

    // Assert：文件权限仅属主可读写
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);

    // Assert：同内容复用同一路径，内容与源一致
    assert.equal(second.img.data.asset.absPath, target);
    assert.ok(fs.readFileSync(target).equals(PNG_8x8));
});
