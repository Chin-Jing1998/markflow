/**
 * converters/renderers/content-list.js 单元测试
 * 覆盖：阅读顺序与各块形状（text / text_level、image + display、图注与图片脚注并入前一个 image 块、
 *       表题并入其后紧邻的 table 块、table_body 转义、list 拍平嵌套、code、equation、blockquote 展开、分隔线跳过）、段内图片与文字拆块、
 *       page_idx（幻灯片与工作表序号）、不输出 bbox、残留标记剥除、4 空格缩进、safeTable 片段原样作表格
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { render, buildContentList } = require('../converters/renderers/content-list');
const {
    createDocument, createRoot, createHeading, createParagraph, createSlideBreak, createSheetSection, createMath,
} = require('../converters/ir/schema');
const { MARKERS } = require('../converters/ir/markers');

const text = (value) => ({ type: 'text', value });
const image = (url, display) => ({ type: 'image', url, alt: '', ...(display ? { data: { display } } : {}) });
const cell = (value) => ({ type: 'tableCell', children: [text(value)] });
const row = (...values) => ({ type: 'tableRow', children: values.map(cell) });
const item = (...children) => ({ type: 'listItem', children });
const DISPLAY = Object.freeze({ width: 677, unit: 'px', source: 'web' });

test('阅读顺序输出各类块，图注与图片脚注并入前一个 image 块', async () => {
    // Arrange
    const ir = createRoot([
        createHeading(1, '标题'),
        { type: 'paragraph', data: { indent: 2 }, children: [text('正文'), { type: 'strong', children: [text('粗体')] }] },
        createParagraph([image('images/image_1.png', DISPLAY)]),
        { type: 'paragraph', data: { role: 'caption' }, children: [text('图 1 示意')] },
        { type: 'paragraph', data: { role: 'image_footnote' }, children: [text('来源：夹具')] },
        { type: 'table', align: [null, null], children: [row('名称', '数量'), row('甲', '1 & <2>')] },
        { type: 'list', ordered: false, children: [item(createParagraph('甲'), { type: 'list', children: [item(createParagraph('乙'))] }), item(createParagraph('丙'))] },
        { type: 'code', lang: 'js', value: 'a();' },
        { type: 'blockquote', children: [createParagraph('引用段')] },
        createMath({ text: 'E=mc^2', display: true }),
        { type: 'thematicBreak' },
    ]);

    // Act
    const blocks = JSON.parse(await render(createDocument({ ir })));

    // Assert
    assert.deepEqual(blocks, [
        { type: 'text', text: '标题', text_level: 1, page_idx: 0 },
        { type: 'text', text: '正文粗体', page_idx: 0 },
        {
            type: 'image', img_path: 'images/image_1.png', image_caption: ['图 1 示意'], image_footnote: ['来源：夹具'],
            content: '', display: { ...DISPLAY }, page_idx: 0,
        },
        {
            type: 'table', img_path: '', table_caption: [], table_footnote: [],
            table_body: '<table><tr><td>名称</td><td>数量</td></tr><tr><td>甲</td><td>1 &amp; &lt;2&gt;</td></tr></table>', page_idx: 0,
        },
        { type: 'list', sub_type: 'text', list_items: ['甲', '乙', '丙'], page_idx: 0 },
        { type: 'code', sub_type: 'code', code_body: 'a();', code_caption: [], page_idx: 0 },
        { type: 'text', text: '引用段', page_idx: 0 },
        { type: 'equation', text: '$$E=mc^2$$', text_format: 'latex', page_idx: 0 },
    ]);
});

test('段内的图片与块级公式各自成块，其余行内内容按原顺序聚成文本块；无 display 的图片不带 display', () => {
    // Arrange
    const ir = createRoot([
        createParagraph([text('前'), image('images/image_2.png'), text('后'), { type: 'break' }, text('续')]),
        createParagraph([createMath({ text: 'x^2', display: true })]),
    ]);

    // Act
    const blocks = buildContentList(createDocument({ ir }));

    // Assert
    assert.deepEqual(blocks.map((b) => b.type), ['text', 'image', 'text', 'equation']);
    assert.equal(blocks[0].text, '前');
    assert.equal(blocks[2].text, '后\n续');
    assert.equal('display' in blocks[1], false);
    assert.equal(blocks[1].img_path, 'images/image_2.png');
});

test('列表条目里的图片紧随列表块各自成 image 块，list_items 只收文字', () => {
    // Arrange：docx 中常见「列表条目 + 条目内插图」
    const ir = createRoot([{ type: 'list', children: [item(createParagraph('甲'), createParagraph([image('images/image_9.png', DISPLAY)]))] }]);

    // Act
    const blocks = buildContentList(createDocument({ ir }));

    // Assert
    assert.deepEqual(blocks.map((b) => b.type), ['list', 'image']);
    assert.deepEqual(blocks[0].list_items, ['甲']);
    assert.equal(blocks[1].img_path, 'images/image_9.png');
    assert.deepEqual(blocks[1].display, { ...DISPLAY });
});

test('page_idx：幻灯片取 slideBreak 序号、工作表取 sheetSection 序号，标题作为带层级的文本块', () => {
    // Arrange
    const slides = createRoot([
        createSlideBreak({ title: '第一页', index: 0 }), createParagraph('甲'),
        createSlideBreak({ title: '第二页', index: 1 }), createParagraph([image('images/image_1.png')]),
    ]);
    const sheets = createRoot([createSheetSection({ name: '表三', index: 2 }), createParagraph('乙')]);

    // Act
    const slideBlocks = buildContentList(createDocument({ kind: 'presentation', ir: slides }));
    const sheetBlocks = buildContentList(createDocument({ kind: 'workbook', ir: sheets }));

    // Assert
    assert.deepEqual(slideBlocks.map((b) => [b.type, b.text || b.img_path, b.text_level || null, b.page_idx]), [
        ['text', '第一页', 2, 0], ['text', '甲', null, 0], ['text', '第二页', 2, 1], ['image', 'images/image_1.png', null, 1],
    ]);
    assert.deepEqual(sheetBlocks.map((b) => [b.text, b.text_level || null, b.page_idx]), [['表三', 1, 2], ['乙', null, 2]]);
});

test('不输出 bbox；残留标记剥除；前面没有图片的图注段按普通文本输出；safeTable 片段原样作表格', () => {
    // Arrange
    const ir = createRoot([
        { type: 'paragraph', data: { role: 'caption' }, children: [text(`图 9${MARKERS.TAB}孤立图注${MARKERS.BR}`)] },
        { type: 'html', value: '<table><tr><td>合并</td></tr></table>', data: { safeTable: true } },
        { type: 'html', value: '<span>行内</span>文字' },
    ]);

    // Act
    const json = buildContentList(createDocument({ ir }));

    // Assert
    assert.deepEqual(json, [
        { type: 'text', text: '图 9\t孤立图注', page_idx: 0 },
        { type: 'table', img_path: '', table_caption: [], table_footnote: [], table_body: '<table><tr><td>合并</td></tr></table>', page_idx: 0 },
        { type: 'text', text: '行内文字', page_idx: 0 },
    ]);
    assert.ok(json.every((block) => !('bbox' in block)));
});

test('table_caption 段落并入其后紧邻的 table 块，不单独成块；连续两个表题按序并入', () => {
    // Arrange：表题之前还有一张图片，表题不得并入图片的 image_caption
    const ir = createRoot([
        createParagraph([image('images/image_1.png', DISPLAY)]),
        { type: 'paragraph', data: { role: 'table_caption' }, children: [text('表 1 各组收率')] },
        { type: 'paragraph', data: { role: 'table_caption' }, children: [text('（续）')] },
        { type: 'table', align: [null], children: [row('组别'), row('甲')] },
    ]);

    // Act
    const blocks = buildContentList(createDocument({ ir }));

    // Assert
    assert.deepEqual(blocks.map((b) => b.type), ['image', 'table']);
    assert.deepEqual(blocks[0].image_caption, []);
    assert.deepEqual(blocks[1].table_caption, ['表 1 各组收率', '（续）']);
});

test('带 data.safeTable 的 html 表格片段同样接收其前紧邻的表题', () => {
    // Arrange
    const ir = createRoot([
        { type: 'paragraph', data: { role: 'table_caption' }, children: [text('表 2 合并单元格')] },
        { type: 'html', value: '<table><tr><td>合并</td></tr></table>', data: { safeTable: true } },
    ]);

    // Act
    const blocks = buildContentList(createDocument({ ir }));

    // Assert
    assert.deepEqual(blocks.map((b) => b.type), ['table']);
    assert.deepEqual(blocks[0].table_caption, ['表 2 合并单元格']);
});

test('其后不是表格的 table_caption 段落按普通文本块输出（后接普通段落、位于序列末尾各一例）', () => {
    // Arrange
    const ir = createRoot([
        { type: 'paragraph', data: { role: 'table_caption' }, children: [text('表 1 孤立表题')] },
        createParagraph('正文'),
        { type: 'table', align: [null], children: [row('组别')] },
        { type: 'paragraph', data: { role: 'table_caption' }, children: [text('表 2 末尾表题')] },
    ]);

    // Act
    const blocks = buildContentList(createDocument({ ir }));

    // Assert
    assert.deepEqual(blocks.map((b) => [b.type, b.text || b.table_caption]), [
        ['text', '表 1 孤立表题'],
        ['text', '正文'],
        ['table', []],
        ['text', '表 2 末尾表题'],
    ]);
});

test('表题之后紧跟空子节点时不抛错：空节点照旧跳过，表题回落为普通文本块', () => {
    // Arrange：emitBlock 对空子节点一向容错，判定「下一个兄弟是否表格」时须同样容错
    const ir = createRoot([
        { type: 'paragraph', data: { role: 'table_caption' }, children: [text('表 1 各组收率')] },
        null,
        { type: 'table', align: [null], children: [row('组别')] },
    ]);

    // Act
    const blocks = buildContentList(createDocument({ ir }));

    // Assert：空节点隔在中间，表题与表格已不紧邻
    assert.deepEqual(blocks.map((b) => [b.type, b.text || b.table_caption]), [
        ['text', '表 1 各组收率'],
        ['table', []],
    ]);
});

test('同一表格之前的表题多达 20 万个时照常逐个并入，不因展开实参超出调用栈而抛错', () => {
    // Arrange：网页中一张表格带 20 万个 <caption> 约 6 MB，在取页 20 MB 的上限之内
    const CAPTION_COUNT = 200000;
    const captions = Array.from({ length: CAPTION_COUNT }, (_, i) => (
        { type: 'paragraph', data: { role: 'table_caption' }, children: [text(`表${i}`)] }
    ));
    const ir = createRoot([...captions, { type: 'table', align: [null], children: [row('组别')] }]);

    // Act
    const blocks = buildContentList(createDocument({ ir }));

    // Assert
    assert.deepEqual(blocks.map((b) => b.type), ['table']);
    assert.equal(blocks[0].table_caption.length, CAPTION_COUNT);
    assert.equal(blocks[0].table_caption[CAPTION_COUNT - 1], `表${CAPTION_COUNT - 1}`);
});

test('render 返回 4 空格缩进的 JSON 字符串；非对象入参抛中文错误', async () => {
    // Act
    const output = await render(createDocument({ ir: createRoot([createParagraph('甲')]) }));

    // Assert
    assert.ok(output.startsWith('[\n    {\n        "type": "text"'), output.slice(0, 60));
    await assert.rejects(render(null), /content-list 需要 MarkFlowDocument/);
});
