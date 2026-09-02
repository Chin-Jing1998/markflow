/**
 * converters/parsers/docx.js 单元测试
 * 覆盖：标题 / 加粗 / 图片 / 表格进入 IR，图片进入 assets，不写盘、不打印，title 回退，进度回调
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, Table, TableRow, TableCell,
} = require('docx');

const { parse } = require('../converters/parsers/docx');

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

// ============================================================
// 测试夹具：用 docx 包生成文档
// ============================================================

const PNG = makePng(8, 8);
const TITLE = '测试标题';

function cell(text) {
    return new TableCell({ children: [new Paragraph(text)] });
}

async function buildDocx({ withHeading = true } = {}) {
    const children = [];
    if (withHeading) {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(TITLE)] }));
    }
    children.push(
        new Paragraph({ children: [new TextRun('普通文字'), new TextRun({ text: '加粗文字', bold: true })] }),
        new Paragraph({ children: [new ImageRun({ type: 'png', data: PNG, transformation: { width: 8, height: 8 } })] }),
        new Table({
            rows: [
                new TableRow({ children: [cell('甲'), cell('乙')] }),
                new TableRow({ children: [cell('1'), cell('2')] }),
            ],
        }),
    );
    const document = new Document({ sections: [{ children }] });
    return Packer.toBuffer(document);
}

function makeTempDir() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-docx-parser-')));
}

function listFiles(dir) {
    return fs.readdirSync(dir, { recursive: true }).map(String).sort();
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

// 捕获 console 输出，验证 parser 不打印
function captureConsole(t) {
    const calls = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    for (const level of Object.keys(original)) {
        console[level] = (...args) => calls.push([level, ...args]);
    }
    t.after(() => Object.assign(console, original));
    return calls;
}

// ============================================================
// 用例
// ============================================================

test('解析出 H1、加粗、图片与表格；图片进入 assets；执行期间不写盘、不打印', async (t) => {
    // Arrange
    const dir = makeTempDir();
    const docxPath = path.join(dir, '示例文档.docx');
    fs.writeFileSync(docxPath, await buildDocx());
    const before = listFiles(dir);
    const consoleCalls = captureConsole(t);

    // Act
    const doc = await parse({ path: docxPath });

    // Assert：IR 结构
    const headings = collect(doc.ir, (n) => n.type === 'heading');
    assert.equal(headings.length, 1);
    assert.equal(headings[0].depth, 1);
    assert.equal(plainText(headings[0]), TITLE);

    const strongs = collect(doc.ir, (n) => n.type === 'strong');
    assert.deepEqual(strongs.map(plainText), ['加粗文字']);

    const tables = collect(doc.ir, (n) => n.type === 'table');
    assert.equal(tables.length, 1);
    const rows = collect(tables[0], (n) => n.type === 'tableRow');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.children.map(plainText)), [['甲', '乙'], ['1', '2']]);

    const images = collect(doc.ir, (n) => n.type === 'image');
    assert.equal(images.length, 1);
    assert.equal(images[0].url, 'images/image_1.png');

    // Assert：assets 与 IR 一一对应
    assert.equal(doc.assets.length, 1);
    assert.equal(doc.assets[0].name, 'images/image_1.png');
    assert.equal(doc.assets[0].mime, 'image/png');
    assert.ok(Buffer.isBuffer(doc.assets[0].buffer));
    assert.ok(doc.assets[0].buffer.equals(PNG), '图片字节应与原图一致');

    // Assert：meta 与 warnings
    assert.equal(doc.kind, 'document');
    assert.equal(doc.meta.title, TITLE);
    assert.equal(doc.meta.sourceType, 'docx');
    assert.equal(doc.meta.sourceName, '示例文档.docx');
    assert.ok(Array.isArray(doc.warnings));

    // Assert：无副作用
    assert.deepEqual(listFiles(dir), before, '解析不得在源目录新增文件');
    assert.deepEqual(consoleCalls, [], '解析不得打印 stdout/stderr');
});

test('无 H1 时 title 回退为去扩展名的文件名；input.buffer 形态可用', async () => {
    // Arrange
    const buffer = await buildDocx({ withHeading: false });

    // Act
    const doc = await parse({ buffer }, { sourceName: '知识库笔记.docx' });

    // Assert
    assert.equal(doc.meta.title, '知识库笔记');
    assert.equal(doc.meta.sourceName, '知识库笔记.docx');
    assert.equal(collect(doc.ir, (n) => n.type === 'heading').length, 0);
    assert.equal(doc.assets.length, 1);
});

test('onProgress 以 (phase, pct) 形式被调用，回调异常不影响解析', async () => {
    // Arrange
    const buffer = await buildDocx();
    const phases = [];

    // Act
    const doc = await parse({ buffer }, {
        onProgress: (phase, pct) => {
            phases.push([phase, pct]);
            throw new Error('回调故障');
        },
    });

    // Assert
    assert.ok(phases.length >= 2);
    assert.ok(phases.every(([phase, pct]) => typeof phase === 'string' && typeof pct === 'number'));
    assert.equal(doc.meta.title, TITLE);
});

test('非法输入抛中文错误', async () => {
    await assert.rejects(parse({}), /input\.path|input\.buffer/);
    await assert.rejects(parse({ path: path.join(os.tmpdir(), 'markflow-不存在的文件.docx') }));
});
