/**
 * converters/parsers/docx.js 单元测试
 * 覆盖：标题 / 加粗 / 图片 / 表格进入 IR，图片进入 assets，不写盘、不打印，title 回退，进度回调，
 *       meta.author（docProps/core.xml 的 dc:creator）
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
const mdRenderer = require('../converters/renderers/md');
const { buildLayoutSample, LAYOUT_EXPECTED } = require('./fixtures/build-layout-sample');
const {
    buildTitleSample, TITLE_EXPECTED, TAB_HEADING_EXPECTED, TITLE_LIST_EXPECTED,
} = require('./fixtures/build-title-sample');

// 不可见字符以码点生成，源码不出现看不见的字面量：U+3000 全角空格，U+EF00–U+EF1F 私用区版面标记
const IDEO = String.fromCharCode(0x3000);
const LAYOUT_RESIDUE_RE = new RegExp(`[${IDEO}${String.fromCharCode(0xEF00)}-${String.fromCharCode(0xEF1F)}]`);

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

// ============================================================
// 专利样稿夹具（test/fixtures/patent/，由 build-samples.js 生成）
// ============================================================

const PATENT_FIXTURES = path.join(__dirname, 'fixtures', 'patent');

test('规范样稿：公式进 math 节点、data.ooxml 就位、meta.sourcePath 为绝对路径', async () => {
    // Arrange
    const docxPath = path.join(PATENT_FIXTURES, 'sample-patent.docx');

    // Act
    const doc = await parse({ path: docxPath });

    // Assert：公式
    const maths = collect(doc.ir, (n) => n.type === 'math');
    assert.equal(maths.length, 2);
    assert.deepEqual(maths.map((n) => n.data.display), [false, true]);
    for (const node of maths) {
        assert.ok(node.data.mathml && node.data.mathml.includes('http://www.w3.org/1998/Math/MathML'));
        assert.ok(node.data.omml && node.data.omml.includes('m:oMath'));
        assert.ok(node.data.text.length > 0);
    }
    assert.equal(maths[0].data.text, '(F)/(S)');
    assert.ok(maths[1].data.text.startsWith('∑_{i=1}^{n}'));

    // Assert：OOXML 预检信息
    assert.ok(doc.data && doc.data.ooxml, 'data.ooxml 应存在');
    assert.equal(doc.data.ooxml.paragraphs, 36);
    assert.equal(doc.data.ooxml.headingStyleParagraphs, 5);
    assert.equal(doc.data.ooxml.revisions.trackRevisions, false);
    assert.deepEqual(doc.data.ooxml.oleObjects, []);

    // Assert：源路径与图片
    assert.equal(doc.meta.sourcePath, docxPath);
    assert.ok(path.isAbsolute(doc.meta.sourcePath));
    assert.equal(doc.assets.length, 3);
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'image').map((n) => n.url),
        ['images/image_1.png', 'images/image_2.png', 'images/image_3.png']);
    assert.deepEqual(doc.warnings, []);
});

test('无标题样稿：段数与图片数正确，顿号权项与坏引用原样进 IR', async () => {
    // Arrange
    const docxPath = path.join(PATENT_FIXTURES, 'sample-patent-notitle.docx');

    // Act
    const doc = await parse({ path: docxPath });

    // Assert：段落与标题数
    const top = doc.ir.children;
    assert.equal(top.length, 23);
    assert.equal(top.filter((n) => n.type === 'heading').length, 5);
    assert.equal(top.filter((n) => n.type === 'paragraph').length, 18);
    assert.equal(doc.data.ooxml.paragraphs, 23);

    // Assert：图片
    assert.equal(doc.assets.length, 2);
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'image').map((n) => n.url),
        ['images/image_1.png', 'images/image_2.png']);
    assert.equal(plainText(top[20]), '图1');
    assert.equal(plainText(top[22]), '图2');

    // Assert：无发明名称段、无四书标题、无段号；权项用顿号编号且第 3 项为坏引用
    assert.equal(collect(doc.ir, (n) => n.type === 'math').length, 0);
    assert.ok(plainText(top[0]).startsWith('本实用新型公开了'), '首段即摘要正文');
    assert.ok(plainText(top[1]).startsWith('1、一种液体容器'));
    assert.ok(plainText(top[5]).includes('根据权利要求12-3任一项所述'));
    assert.equal(top.filter((n) => /^\[\d{4}\]/.test(plainText(n))).length, 0, '样稿不应带段号');
});

// ============================================================
// 版面夹具（test/fixtures/build-layout-sample.js 现造）
// ============================================================

test('版面夹具：首行缩进（段落与样式链）进 data.indent，标题与悬挂缩进跳过；制表符保留为 \\t；文本不带全角空格与标记', async () => {
    // Act
    const doc = await parse({ buffer: await buildLayoutSample() }, { sourceName: '版面样例.docx' });
    const top = doc.ir.children;
    const byText = (prefix) => top.find((n) => plainText(n).startsWith(prefix));

    // Assert
    assert.equal(top[0].type, 'heading');
    assert.equal(top[0].data, undefined, '标题段不加缩进');
    assert.equal(byText('首行缩进两字').data.indent, 2);
    assert.equal(byText('样式链继承').data.indent, 2);
    assert.equal(byText('悬挂缩进').data, undefined);
    assert.equal(plainText(byText('制表符')), '制表符\t之后');
    assert.ok(!LAYOUT_RESIDUE_RE.test(JSON.stringify(doc.ir)), '段落文本本身不带全角缩进与私用区标记');
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'underline').map(plainText), ['下划线文字']);
});

test('版面夹具：图片显示尺寸取自 wp:extent 且按资产名对位（无 blip 的 drawing 不致错位），浮动图排在文字之后，题注成段', async () => {
    // Act
    const doc = await parse({ buffer: await buildLayoutSample() }, { sourceName: '版面样例.docx' });
    const top = doc.ir.children;
    const images = collect(doc.ir, (n) => n.type === 'image');

    // Assert：尺寸、alt 与资产一一对应，字节与夹具原图一致
    assert.deepEqual(
        images.map((n) => [n.url, n.alt, n.data.display.width, n.data.display.height, Boolean(n.data.floating)]),
        LAYOUT_EXPECTED.images.map((i) => [i.name, i.alt, i.width, i.height, i.floating]),
    );
    assert.deepEqual(doc.assets.map((a) => a.name), LAYOUT_EXPECTED.images.map((i) => i.name));
    LAYOUT_EXPECTED.images.forEach((image, i) => assert.ok(doc.assets[i].buffer.equals(image.buffer), image.name));

    // Assert：题注样式段与「图 2\t图 3」均为 caption，且紧随图片段
    const captions = top.filter((n) => n.data && n.data.role === 'caption');
    assert.deepEqual(captions.map(plainText), ['图 1 示意图甲', '图 2\t图 3']);
    const label = top.findIndex((n) => plainText(n) === '【示例】');
    assert.deepEqual(top.slice(label + 1, label + 4).map((n) => (n.children[0].type === 'image' ? n.children[0].url : plainText(n))),
        ['images/image_2.png', 'images/image_3.png', '图 2\t图 3']);
});

test('版面夹具转 Markdown：段首两个全角空格、<img width> 独占一行、制表符为两个全角空格、下划线为 <u>', async () => {
    // Act
    const markdown = await mdRenderer.render(await parse({ buffer: await buildLayoutSample() }, { sourceName: '版面样例.docx' }));
    const lines = markdown.split('\n');

    // Assert
    assert.ok(lines.includes(`${IDEO}${IDEO}首行缩进两字（firstLineChars）。`), markdown);
    assert.ok(lines.includes('<img src="images/image_1.png" width="200" alt="示意图甲">'), markdown);
    assert.equal(lines[lines.indexOf('<img src="images/image_1.png" width="200" alt="示意图甲">') + 2], '图 1 示意图甲');
    assert.ok(lines.includes(`图 2${IDEO}${IDEO}图 3`), markdown);
    assert.ok(lines.includes('<u>下划线文字</u>之后'), markdown);
});

// ============================================================
// 标题夹具（test/fixtures/build-title-sample.js 现造）
// ============================================================

test('标题夹具：Title 样式段（样式 ID 与样式名不同）优先于首个 H1 作 meta.title，正文中仍为普通段落', async () => {
    // Act
    const doc = await parse({ buffer: await buildTitleSample() }, { sourceName: '标题样例.docx' });

    // Assert
    assert.equal(doc.meta.title, TITLE_EXPECTED.title);
    const titleNode = doc.ir.children.find((n) => plainText(n) === TITLE_EXPECTED.title);
    assert.equal(titleNode && titleNode.type, 'paragraph', 'Title 样式段在正文中不改成标题');
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'heading').map((n) => [n.depth, plainText(n)]),
        [[1, TITLE_EXPECTED.heading]]);
});

test('标题夹具：Title 样式段无文字时 meta.title 回退为首个 H1', async () => {
    // Act
    const doc = await parse({ buffer: await buildTitleSample({ title: '' }) }, { sourceName: '标题样例.docx' });

    // Assert
    assert.equal(doc.meta.title, TITLE_EXPECTED.heading);
});

test('标题夹具：H1 标题含制表符时，meta.title 中的制表符标记换成一个空格而非直接删除', async () => {
    // Act
    const doc = await parse(
        { buffer: await buildTitleSample({ title: '', headingTab: true }) },
        { sourceName: '标题样例.docx' },
    );

    // Assert
    assert.equal(doc.meta.title, TAB_HEADING_EXPECTED.expected);
});

// 列表结构摘要（有序性、各项首段文字、嵌套列表），断言失败时整体可读
function summarizeList(list) {
    return {
        ordered: list.ordered,
        items: list.children.map((item) => ({
            text: plainText(item.children[0]),
            nested: item.children.filter((n) => n.type === 'list').map(summarizeList),
        })),
    };
}

// titleList 夹具的期望结构：同一个顶层列表里，Title 项内嵌下级段，同级段接续为第 2 项
function expectedTitleList(ordered) {
    return [{
        ordered,
        items: [
            { text: TITLE_EXPECTED.title, nested: [{ ordered, items: [{ text: TITLE_LIST_EXPECTED.child, nested: [] }] }] },
            { text: TITLE_LIST_EXPECTED.sibling, nested: [] },
        ],
    }];
}

test('标题夹具：Title 段带有序编号时在正文中为列表项，meta.title 仍取该段文字，md 中为不带类名与 HTML 的普通列表项', async () => {
    // Act
    const doc = await parse({ buffer: await buildTitleSample({ titleList: 'ordered' }) }, { sourceName: '标题样例.docx' });
    const markdown = await mdRenderer.render(doc);

    // Assert
    assert.equal(doc.meta.title, TITLE_EXPECTED.title);
    const items = collect(doc.ir, (n) => n.type === 'listItem');
    assert.ok(items.some((item) => plainText(item.children[0]) === TITLE_EXPECTED.title), 'Title 段文字应位于列表项内');
    assert.ok(markdown.split('\n').includes(`1. ${TITLE_EXPECTED.title}`), markdown);
    assert.doesNotMatch(markdown, /mf-title|<\/?(?:p|ol|ul|li|span)\b/);
});

test('标题夹具：同一编号定义下，带编号的 Title 段与相邻普通编号段同属一个列表（下级段嵌在其列表项内，同级段接续为第 2 项）', async () => {
    // Act
    const doc = await parse({ buffer: await buildTitleSample({ titleList: 'ordered' }) }, { sourceName: '标题样例.docx' });

    // Assert
    assert.deepEqual(doc.ir.children.filter((n) => n.type === 'list').map(summarizeList), expectedTitleList(true));
});

test('标题夹具：Title 段带项目符号时与同一编号定义下的普通段同属一个无序列表，meta.title 仍取该段文字', async () => {
    // Act
    const doc = await parse({ buffer: await buildTitleSample({ titleList: 'unordered' }) }, { sourceName: '标题样例.docx' });

    // Assert
    assert.equal(doc.meta.title, TITLE_EXPECTED.title);
    assert.deepEqual(doc.ir.children.filter((n) => n.type === 'list').map(summarizeList), expectedTitleList(false));
});

// ============================================================
// 作者：docProps/core.xml 的 dc:creator
// ============================================================

test('meta.author 取 docProps/core.xml 的 dc:creator（实体还原、首尾空白裁剪），进入 front matter 时位于 title 之后', async () => {
    // Arrange
    const buffer = await Packer.toBuffer(new Document({ creator: ' 张三 & 李四 ', sections: [{ children: [new Paragraph('正文')] }] }));

    // Act
    const doc = await parse({ buffer }, { sourceName: '甲.docx' });

    // Assert
    assert.equal(doc.meta.author, '张三 & 李四');
    const { prependFrontMatter } = require('../converters/web/frontmatter');
    assert.match(
        prependFrontMatter('正文\n', doc.meta, { convertedAt: 'T' }),
        /^---\ntitle: "甲"\nauthor: "张三 & 李四"\nsource: "甲\.docx"\nsourceType: "docx"\nconvertedAt: "T"\n---\n\n正文\n$/,
    );
});

test('dc:creator 为空或缺少 core.xml 时 meta 不含 author，字段与改动前一致', async () => {
    // Arrange
    const JSZip = require('jszip');
    const empty = await Packer.toBuffer(new Document({ creator: '', sections: [{ children: [new Paragraph('正文')] }] }));
    const zip = await JSZip.loadAsync(empty);
    zip.remove('docProps/core.xml');
    const noCore = await zip.generateAsync({ type: 'nodebuffer' });

    // Act
    const docs = [await parse({ buffer: empty }, { sourceName: '乙.docx' }), await parse({ buffer: noCore }, { sourceName: '丙.docx' })];

    // Assert
    for (const doc of docs) assert.deepEqual(Object.keys(doc.meta), ['title', 'sourceType', 'sourceName', 'sourcePath']);
});

test('占位作者名不写入 meta：docx 库缺省的 Un-named 视为无作者，含占位词的真实姓名照旧写入', async () => {
    // Arrange：不传 creator 时 docx 库写入缺省值 Un-named
    const placeholder = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('正文')] }] }));
    const real = await Packer.toBuffer(new Document({ creator: 'un-named 张三', sections: [{ children: [new Paragraph('正文')] }] }));

    // Act
    const docA = await parse({ buffer: placeholder }, { sourceName: '丁.docx' });
    const docB = await parse({ buffer: real }, { sourceName: '戊.docx' });

    // Assert
    assert.equal('author' in docA.meta, false);
    assert.equal(docB.meta.author, 'un-named 张三');
});
