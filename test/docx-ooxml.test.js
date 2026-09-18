/**
 * converters/parsers/docx-ooxml.js 单元测试
 * 覆盖：浮动对象 / 文本框 / OLE / 自动编号 / 修订 / 保护 / 批注 / 域 / 东亚字体 /
 *       标题样式段与段落数的计数，OLE 对象按 ProgID 标出的 chemistry 标志（含版本后缀），
 *       缺部件按 0 计，非 zip 抛中文错误
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');

const { inspectOoxml } = require('../converters/parsers/docx-ooxml');

// ============================================================
// 夹具：手写 OOXML 部件打成 zip
// ============================================================

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
            xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
            xmlns:o="urn:schemas-microsoft-com:office:office"
            xmlns:v="urn:schemas-microsoft-com:vml">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>技术领域</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>自动编号段</w:t></w:r></w:p>
    <w:p><w:r><w:drawing><wp:anchor><wp:extent cx="100" cy="100"/></wp:anchor></w:drawing></w:r></w:p>
    <w:p><w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/></wp:inline></w:drawing></w:r></w:p>
    <w:p><mc:AlternateContent>
      <mc:Choice Requires="wps"><w:drawing><wps:txbx><w:txbxContent><w:p><w:r><w:t>文本框</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></mc:Choice>
      <mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>文本框</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>
    </mc:AlternateContent></w:p>
    <w:p><w:r><w:object><o:OLEObject Type="Embed" ProgID="Equation.3" ShapeID="_x0000_i1025"/></w:object></w:r></w:p>
    <w:p>
      <w:ins w:id="1" w:author="张三"><w:r><w:t>新增</w:t></w:r></w:ins>
      <w:del w:id="2" w:author="张三"><w:r><w:delText>删除</w:delText></w:r></w:del>
    </w:p>
    <w:p><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>
    <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>TOC \\o "1-3"</w:instrText></w:r></w:p>
    <w:p><w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/></w:rPr></w:pPr><w:r><w:t>正文</w:t></w:r></w:p>
  </w:body>
</w:document>`;

const SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:trackChanges/>
  <w:documentProtection w:edit="readOnly" w:enforcement="1"/>
</w:settings>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal"><w:rPr><w:rFonts w:eastAsia="黑体"/></w:rPr></w:style>
</w:styles>`;

const COMMENTS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="1" w:author="甲"><w:p><w:r><w:t>批注一</w:t></w:r></w:p></w:comment>
  <w:comment w:id="2" w:author="乙"><w:p><w:r><w:t>批注二</w:t></w:r></w:p></w:comment>
</w:comments>`;

function buildHandwrittenDocx(parts = {}) {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
    zip.file('word/document.xml', parts.document === undefined ? DOCUMENT_XML : parts.document);
    if (parts.settings !== null) zip.file('word/settings.xml', parts.settings || SETTINGS_XML);
    if (parts.styles !== null) zip.file('word/styles.xml', parts.styles || STYLES_XML);
    if (parts.comments !== null) zip.file('word/comments.xml', parts.comments || COMMENTS_XML);
    return zip.generateAsync({ type: 'nodebuffer' });
}

// ============================================================
// 用例
// ============================================================

test('各项计数：浮动对象、文本框、OLE、自动编号、修订、保护、批注、域、东亚字体、标题段', async () => {
    // Arrange
    const buffer = await buildHandwrittenDocx();

    // Act
    const ooxml = await inspectOoxml(buffer);

    // Assert
    assert.equal(ooxml.floatingImages, 1, '只计 wp:anchor，wp:inline 不算浮动');
    assert.equal(ooxml.textBoxes, 1, 'mc:Fallback 内的重复 txbxContent 不重复计数');
    assert.deepEqual(ooxml.oleObjects, [{ progId: 'Equation.3', chemistry: false }]);
    assert.equal(ooxml.autoNumbering, 1);
    assert.deepEqual(ooxml.revisions, { insertions: 1, deletions: 1, trackRevisions: true });
    assert.deepEqual(ooxml.protection, { enforced: true, type: 'readOnly' });
    assert.equal(ooxml.comments, 2);
    assert.equal(ooxml.fields, 2, 'w:fldSimple 与 w:instrText 各计一次');
    assert.deepEqual(ooxml.eastAsiaFonts, ['宋体', '黑体'], 'document.xml 与 styles.xml 合并去重');
    assert.equal(ooxml.headingStyleParagraphs, 1);
    assert.equal(ooxml.paragraphs, 12, '含文本框内的两个嵌套段落');
});

test('OLE 对象按 ProgID 标出化学结构式：含版本后缀者照样命中，公式编辑器不命中', async () => {
    // Arrange：三个 OLE 对象——带版本后缀的 ChemDraw、KingDraw、公式编辑器
    const objects = ['ChemDraw.Document.6.0', 'KingDrawObject.Document', 'Equation.DSMT4']
        .map((progId, index) => `<w:p><w:r><w:object><o:OLEObject Type="Embed" ProgID="${progId}" ShapeID="s${index}"/></w:object></w:r></w:p>`)
        .join('');
    const buffer = await buildHandwrittenDocx({
        document: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
            + `xmlns:o="urn:schemas-microsoft-com:office:office"><w:body>${objects}</w:body></w:document>`,
    });

    // Act
    const ooxml = await inspectOoxml(buffer);

    // Assert
    assert.deepEqual(ooxml.oleObjects, [
        { progId: 'ChemDraw.Document.6.0', chemistry: true },
        { progId: 'KingDrawObject.Document', chemistry: true },
        { progId: 'Equation.DSMT4', chemistry: false },
    ]);
});

test('缺部件按 0 计：无 settings / styles / comments 时不报错', async () => {
    // Arrange
    const buffer = await buildHandwrittenDocx({
        document: '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>',
        settings: null,
        styles: null,
        comments: null,
    });

    // Act
    const ooxml = await inspectOoxml(buffer);

    // Assert
    assert.equal(ooxml.paragraphs, 1);
    assert.equal(ooxml.comments, 0);
    assert.equal(ooxml.revisions.trackRevisions, false);
    assert.deepEqual(ooxml.protection, { enforced: false, type: '' });
    assert.deepEqual(ooxml.eastAsiaFonts, []);
});

test('真实 docx：Heading 样式段与段落数计数正确', async () => {
    // Arrange
    const document = new Document({
        sections: [{
            children: [
                new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('技术领域')] }),
                new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('背景技术')] }),
                new Paragraph({ children: [new TextRun('正文一')] }),
                new Paragraph({ children: [new TextRun('正文二')] }),
            ],
        }],
    });

    // Act
    const ooxml = await inspectOoxml(await Packer.toBuffer(document));

    // Assert
    assert.equal(ooxml.headingStyleParagraphs, 2);
    assert.equal(ooxml.paragraphs, 4);
    assert.deepEqual(ooxml.oleObjects, []);
    assert.equal(ooxml.floatingImages, 0);
});

test('中文版 Word 的数字 styleId：按 styles.xml 的 w:name 识别标题样式', async () => {
    // Arrange：真实来稿常见形态——w:styleId="1"，靠 <w:name w:val="heading 1"/> 才能辨认
    const document = `<w:document xmlns:w="w"><w:body>
        <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>技术领域</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>背景技术</w:t></w:r></w:p>
        <w:p><w:pPr><w:pStyle w:val="a"/></w:pPr><w:r><w:t>正文</w:t></w:r></w:p>
    </w:body></w:document>`;
    const styles = `<w:styles xmlns:w="w">
        <w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>
        <w:style w:type="paragraph" w:styleId="a"><w:name w:val="Normal"/></w:style>
    </w:styles>`;
    const buffer = await buildHandwrittenDocx({ document, styles, settings: null, comments: null });

    // Act
    const ooxml = await inspectOoxml(buffer);

    // Assert
    assert.equal(ooxml.headingStyleParagraphs, 2);
    assert.equal(ooxml.paragraphs, 3);
});

test('非 zip 输入抛中文错误', async () => {
    // Arrange：OLE 复合文档魔数（加密文档或误命名的 .doc）
    const ole = Buffer.concat([Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]), Buffer.alloc(16)]);

    // Act & Assert
    await assert.rejects(inspectOoxml(ole), /文档已加密或不是 docx/);
    await assert.rejects(inspectOoxml(Buffer.from('这不是一个 zip')), /文档已加密或不是 docx/);
    await assert.rejects(inspectOoxml('不是 Buffer'), /需要 docx 文件的 Buffer/);
});
