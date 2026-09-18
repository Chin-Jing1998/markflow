/**
 * converters/renderers/docx.js 单元测试
 * 覆盖：GFM 表格/删除线/任务列表、超链接、图片内嵌与降级、引用块、代码块、HTML 去标签、
 *       未知节点降级、CJK 默认字体、图片宽度缩放、空文档、
 *       options.docx 的纸张/页边距/字号/中西文字体透传、math 节点降级为线性化文本
 * IR 直接由 unified + remark-parse + remark-gfm 从内联 Markdown 构造，不依赖 parsers/md.js。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const JSZip = require('jszip');

const { loadUnified } = require('../converters/ir/unified-loader');
const docxRenderer = require('../converters/renderers/docx');
const { normalizeOptions } = require('../converters/options');
const { createMath } = require('../converters/ir/schema');

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
    for (let i = 0; i < buf.length; i += 1) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
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
// IR 构造与 docx 解包辅助
// ============================================================

const EMU_PER_PX = 9525;

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

function attachAsset(imageNode, { buffer, mime = 'image/png', width = 8, height = 8 }) {
    imageNode.data = {
        ...imageNode.data,
        asset: { absPath: '/tmp/markflow-docx-test/pic.png', buffer, mime, width, height },
    };
}

async function unzipDocx(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    return {
        documentXml: await zip.file('word/document.xml').async('string'),
        stylesXml: await zip.file('word/styles.xml').async('string'),
        relsXml: await zip.file('word/_rels/document.xml.rels').async('string'),
        mediaFiles: Object.keys(zip.files).filter((name) => name.startsWith('word/media/') && !zip.files[name].dir),
    };
}

const SAMPLE_MD = [
    '# 一级标题',
    '',
    '段落含 **粗体** 与 ~~删除线文字~~ 与 [示例链接](https://example.com/page) 与 `行内代码`。',
    '',
    '- [ ] 待办事项',
    '- [x] 已完成事项',
    '- 普通条目',
    '',
    '1. 第一项',
    '2. 第二项',
    '',
    '> 引用段落',
    '',
    '```js',
    'const answer = 42;',
    '    indented();',
    '```',
    '',
    '| 列A | 列B |',
    '| --- | ---: |',
    '| 甲 | 1 |',
    '',
    '![示意图](images/pic.png)',
    '',
    '<div class="note">内联 <b>HTML</b> 文本</div>',
    '',
    '---',
    '',
].join('\n');

async function renderSample() {
    const ir = await parseMarkdown(SAMPLE_MD);
    const [image] = collect(ir, (n) => n.type === 'image');
    attachAsset(image, { buffer: makePng(8, 8) });
    const doc = makeDoc(ir);
    const buffer = await docxRenderer.render(doc);
    return { doc, buffer, ...(await unzipDocx(buffer)) };
}

// ============================================================
// 用例
// ============================================================

test('GFM 节点正确落到 DOCX：表格、删除线、超链接、图片、任务列表、标题', async () => {
    // Arrange & Act
    const { buffer, documentXml, relsXml, mediaFiles } = await renderSample();

    // Assert：结构
    assert.equal(buffer.subarray(0, 2).toString('latin1'), 'PK', '应返回合法 zip/docx Buffer');
    assert.ok(documentXml.includes('<w:tbl>'), '应含表格');
    assert.ok(documentXml.includes('<w:strike'), '应含删除线');
    assert.ok(documentXml.includes('<w:hyperlink'), '应含超链接');
    assert.ok(documentXml.includes('<w:drawing>'), '应含内嵌图片');
    assert.ok(documentXml.includes('☐'), '未完成任务应有 ☐ 前缀');
    assert.ok(documentXml.includes('☑'), '已完成任务应有 ☑ 前缀');
    assert.ok(documentXml.includes('Heading1'), '一级标题应用 Heading1 样式');
    assert.ok(relsXml.includes('https://example.com/page'), '超链接目标应写入关系表');
    assert.equal(mediaFiles.length, 1, 'word/media/ 下应恰有 1 个图片文件');

    // Assert：不得残留 Markdown 字面量或旧版占位符
    assert.ok(!documentXml.includes('| ---'), '不应残留表格分隔行字面量');
    assert.ok(!documentXml.includes('~~'), '不应残留删除线标记');
    assert.ok(!documentXml.includes('[图片:'), '不应出现旧版图片占位文本');
});

test('未知块节点与未知行内节点降级为纯文本，不被丢弃', async () => {
    // Arrange
    const ir = await parseMarkdown('正文开始\n');
    ir.children.push({ type: 'unknownX', children: [{ type: 'text', value: '未知块节点文本' }] });
    ir.children.push({
        type: 'paragraph',
        children: [{ type: 'weirdInline', children: [{ type: 'text', value: '未知行内文本' }] }],
    });

    // Act
    const { documentXml } = await unzipDocx(await docxRenderer.render(makeDoc(ir)));

    // Assert
    assert.ok(documentXml.includes('未知块节点文本'));
    assert.ok(documentXml.includes('未知行内文本'));
});

test('无 asset 的图片降级为斜体 alt 文本并记录 warning', async () => {
    // Arrange
    const ir = await parseMarkdown('![远程示意图](https://example.com/a.png)\n');
    const doc = makeDoc(ir);

    // Act
    const { documentXml, mediaFiles } = await unzipDocx(await docxRenderer.render(doc));

    // Assert
    assert.ok(documentXml.includes('远程示意图'), 'alt 文本应出现在正文');
    assert.ok(documentXml.includes('<w:i/>'), '降级文本应为斜体');
    assert.ok(!documentXml.includes('<w:drawing>'));
    assert.equal(mediaFiles.length, 0);
    assert.ok(
        doc.warnings.some((w) => w.includes('远程示意图')),
        `warnings 应记录降级，实际为 ${JSON.stringify(doc.warnings)}`,
    );
});

test('svg 资源不内嵌，降级为 alt 文本并告警', async () => {
    // Arrange
    const ir = await parseMarkdown('![矢量图](logo.svg)\n');
    const [image] = collect(ir, (n) => n.type === 'image');
    attachAsset(image, { buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), mime: 'image/svg+xml', width: 10, height: 10 });
    const doc = makeDoc(ir);

    // Act
    const { documentXml, mediaFiles } = await unzipDocx(await docxRenderer.render(doc));

    // Assert
    assert.ok(documentXml.includes('矢量图'));
    assert.ok(!documentXml.includes('<w:drawing>'));
    assert.equal(mediaFiles.length, 0);
    assert.ok(doc.warnings.some((w) => w.includes('svg')));
});

test('图片宽度超过 600px 时按比例缩放到 600px', async () => {
    // Arrange：asset 自带尺寸 1200×600，渲染器应缩放为 600×300
    const ir = await parseMarkdown('![宽图](wide.png)\n');
    const [image] = collect(ir, (n) => n.type === 'image');
    attachAsset(image, { buffer: makePng(8, 8), width: 1200, height: 600 });

    // Act
    const { documentXml } = await unzipDocx(await docxRenderer.render(makeDoc(ir)));

    // Assert
    assert.ok(documentXml.includes(`cx="${600 * EMU_PER_PX}"`), '宽度应缩放为 600px');
    assert.ok(documentXml.includes(`cy="${300 * EMU_PER_PX}"`), '高度应等比缩放为 300px');
});

test('引用块带左缩进与左边线，代码块逐行拆分并用等宽字体与底纹', async () => {
    // Arrange & Act
    const { documentXml } = await renderSample();

    // Assert：引用块
    assert.ok(documentXml.includes('w:left="720"'), '引用段落应左缩进 720 twip');
    assert.ok(documentXml.includes('<w:left '), '引用段落应有左边线');
    assert.ok(documentXml.includes('<w:color w:val="6E6E73"/>'), '引用文字应为灰色');

    // Assert：代码块
    assert.ok(documentXml.includes('Courier New'), '代码块应用等宽字体');
    assert.ok(documentXml.includes('w:fill="F5F5F7"'), '代码块应有浅灰底纹');
    assert.ok(documentXml.includes('<w:br/>'), '多行代码应以换行 run 拆分');
    assert.ok(documentXml.includes('<w:t xml:space="preserve">    indented();</w:t>'), '代码行首空格应保留');
});

test('HTML 节点去标签后作为普通文本输出', async () => {
    // Arrange & Act
    const { documentXml } = await renderSample();

    // Assert
    assert.ok(documentXml.includes('内联 HTML 文本'));
    assert.ok(!documentXml.includes('&lt;div'), '不应残留 HTML 标签');
});

test('文档默认字体含 CJK 回退（eastAsia=微软雅黑）', async () => {
    // Arrange & Act
    const { stylesXml } = await renderSample();

    // Assert
    assert.ok(stylesXml.includes('w:eastAsia="微软雅黑"'));
    assert.ok(stylesXml.includes('w:ascii="Calibri"'));
});

test('slideBreak/sheetSection 自定义节点降级后可渲染，空文档亦返回合法 docx', async () => {
    // Arrange
    const ir = {
        type: 'root',
        children: [
            { type: 'sheetSection', data: { name: '工作表一', index: 0 } },
            { type: 'slideBreak', data: { title: '第二页', index: 1 } },
        ],
    };

    // Act
    const { documentXml } = await unzipDocx(await docxRenderer.render(makeDoc(ir)));
    const empty = await docxRenderer.render(makeDoc({ type: 'root', children: [] }));

    // Assert
    assert.ok(documentXml.includes('工作表一'));
    assert.ok(documentXml.includes('第二页'));
    assert.ok(documentXml.includes('Heading2'));
    assert.equal(empty.subarray(0, 2).toString('latin1'), 'PK');
});

test('options.docx 透传：纸张与页边距落到 sectPr，字号与中西文字体落到默认样式', async () => {
    // Arrange
    const ir = await parseMarkdown('正文\n');
    const options = normalizeOptions({
        docx: {
            pageSize: 'Letter',
            fontSize: 14,
            fontFamily: { ascii: 'Times New Roman', eastAsia: '宋体' },
            margins: { top: 0.5, bottom: 0.5, left: 1.25, right: 1.25 },
        },
    });

    // Act
    const { documentXml, stylesXml } = await unzipDocx(await docxRenderer.render(makeDoc(ir), options));

    // Assert：Letter = 12240×15840 twip，0.5in = 720 twip，1.25in = 1800 twip
    assert.match(documentXml, /<w:pgSz w:w="12240" w:h="15840"/);
    assert.match(documentXml, /<w:pgMar[^>]*w:top="720"[^>]*w:right="1800"[^>]*w:bottom="720"[^>]*w:left="1800"/);
    // 14pt = 28 半磅
    assert.match(stylesXml, /<w:sz w:val="28"\/>/);
    assert.ok(stylesXml.includes('w:ascii="Times New Roman"') && stylesXml.includes('w:eastAsia="宋体"'), stylesXml.slice(0, 400));
});

test('省略 options 时纸张为 A4、字号 11pt，与 v2 默认一致', async () => {
    // Arrange
    const ir = await parseMarkdown('正文\n');

    // Act
    const { documentXml, stylesXml } = await unzipDocx(await docxRenderer.render(makeDoc(ir)));

    // Assert：A4 = 11906×16838 twip，11pt = 22 半磅
    assert.match(documentXml, /<w:pgSz w:w="11906" w:h="16838"/);
    assert.match(stylesXml, /<w:sz w:val="22"\/>/);
    assert.ok(stylesXml.includes('w:ascii="Calibri"') && stylesXml.includes('w:eastAsia="微软雅黑"'));
});

test('math 节点降级为线性化文本：行内并入段落，块级独立成段', async () => {
    // Arrange：行内公式带 MathML，块级公式只有 text
    const ir = {
        type: 'root',
        children: [
            { type: 'paragraph', children: [{ type: 'text', value: '式 ' }, createMath({ mathml: '<math><mi>x</mi></math>', text: 'x^2' })] },
            createMath({ text: 'E=mc^2', display: true }),
        ],
    };

    // Act
    const { documentXml } = await unzipDocx(await docxRenderer.render(makeDoc(ir)));

    // Assert
    assert.ok(documentXml.includes('x^2') && documentXml.includes('E=mc^2'), documentXml);
    assert.ok(!documentXml.includes('<m:oMath') && !documentXml.includes('&lt;math'), '不得残留公式标记');
    assert.equal((documentXml.match(/<w:p>/g) || []).length >= 2, true, '块级公式应独立成段');
});

test('带 data.safeTable 的 html 节点按文本处理（已知限制：不重建表格结构）', async () => {
    // Arrange
    const ir = {
        type: 'root',
        children: [{
            type: 'html',
            value: '<table><tr><td>甲</td><td>乙</td></tr></table>',
            data: { safeTable: true },
        }],
    };

    // Act
    const { documentXml } = await unzipDocx(await docxRenderer.render(makeDoc(ir)));

    // Assert
    assert.ok(documentXml.includes('甲') && documentXml.includes('乙'));
    assert.ok(!documentXml.includes('&lt;table'), '不应残留 HTML 标签');
});

test('underline 输出下划线 run；带 display 的图片按显示宽度内嵌（缺高度时按像素宽高比补）；\\t 输出为 w:tab', async () => {
    // Arrange：IR 经 ir/inline-html 提升（与 md 解析器同一链路）
    const { liftInlineHtml } = require('../converters/ir/inline-html');
    const ir = liftInlineHtml(await parseMarkdown('<img src="images/pic.png" width="300">\n\n前<u>下划线</u>后\n\n图 1\t图 2\n'));
    const [image] = collect(ir, (n) => n.type === 'image');
    attachAsset(image, { buffer: makePng(100, 50), width: 100, height: 50 });

    // Act
    const { documentXml } = await unzipDocx(await docxRenderer.render(makeDoc(ir)));

    // Assert
    assert.ok(documentXml.includes(`cx="${300 * EMU_PER_PX}"`), '宽度取显示宽度 300px');
    assert.ok(documentXml.includes(`cy="${150 * EMU_PER_PX}"`), '高度按像素宽高比补为 150px');
    assert.match(documentXml, /<w:u w:val="single"\/>/);
    assert.ok(documentXml.includes('<w:tab/>'), '制表符应为 w:tab');
});

test('superscript / subscript 输出 w:vertAlign 的上下标 run', async () => {
    // Arrange：IR 经 ir/inline-html 提升（与 docx 解析器同一链路）
    const { liftInlineHtml } = require('../converters/ir/inline-html');
    const ir = liftInlineHtml(await parseMarkdown('C<sub>1</sub>的烷基、R<sup>2</sup>基团、<strong><sub>粗下标</sub></strong>\n'));

    // Act
    const { documentXml } = await unzipDocx(await docxRenderer.render(makeDoc(ir)));

    // Assert
    assert.match(documentXml, /<w:vertAlign w:val="subscript"\/>/);
    assert.match(documentXml, /<w:vertAlign w:val="superscript"\/>/);
    assert.ok(documentXml.includes('粗下标'), '嵌套在加粗内的下标文字不得丢失');
    assert.equal((documentXml.match(/<w:vertAlign w:val="subscript"\/>/g) || []).length, 2, '两处下标各成一个 run');
});
