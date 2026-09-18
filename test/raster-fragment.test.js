/**
 * converters/raster/fragment.js 片段页单元测试（不出图，只看 HTML）
 * 覆盖：公式片段页按 data.fontSizePt 出图与标定系数、字号缺失 / 越界时的回落、
 *       表格单元格内的上标 / 下标 / 下划线节点渲染、
 *       table.data.grid 路径（colspan / rowspan 写法、首行不强制加粗、单元格内多段的 <p> 与段间距、
 *       文本转义、跨度脏数据回落与结构不符时回落到 GFM 路径）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildMathFragment, buildTableFragment } = require('../converters/raster/fragment');
const { createMath, createTable, createTableRow, createTableCell, createText } = require('../converters/ir/schema');

const MML = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi></math>';
/** 片段页 body 的字号声明 */
const FONT_SIZE_RE = /body\{display:inline-block;padding:\d+px;font-family:[^;]+;font-size:([\d.]+)pt/;

/** 带指定源稿字号的 math 节点（data.fontSizePt 由 parsers/docx-math 附加，schema 本身不含该字段） */
function mathWithSize(fontSizePt) {
    const node = createMath({ mathml: MML, text: 'a' });
    return fontSizePt === undefined ? node : { ...node, data: { ...node.data, fontSizePt } };
}

const fontSizeOf = (html) => {
    const match = html.match(FONT_SIZE_RE);
    assert.ok(match, `片段页应声明 body 字号：${html.slice(0, 200)}`);
    return Number(match[1]);
};

const inline = (nodes) => buildTableFragment(createTable(null, [
    createTableRow([createTableCell('表头')]),
    createTableRow([createTableCell(nodes)]),
]));

// ============================================================
// 公式片段页字号
// ============================================================

test('公式片段：字号取 data.fontSizePt 乘标定系数，且随源稿字号等比变化', () => {
    // Arrange / Act
    const at14 = fontSizeOf(buildMathFragment(mathWithSize(14)));
    const at28 = fontSizeOf(buildMathFragment(mathWithSize(28)));
    const at10p5 = fontSizeOf(buildMathFragment(mathWithSize(10.5)));

    // Assert：标定系数 12/14——MathJax 的 newcm 数学字形比 Word 的 Cambria Math 大，按官方产出幅面标定
    assert.equal(at14, 12);
    assert.equal(at28, 24, '源稿字号翻倍，出图字号同步翻倍');
    assert.equal(at10p5, 9);
});

test('公式片段：取不到字号或字号越界时回落到缺省值，与源稿 14pt 同值', () => {
    // Arrange / Act
    const baseline = fontSizeOf(buildMathFragment(mathWithSize(14)));

    // Assert
    for (const value of [undefined, null, 0, -12, 99999, Number.NaN, '14']) {
        assert.equal(fontSizeOf(buildMathFragment(mathWithSize(value))), baseline, `字号 ${String(value)} 应回落到缺省值`);
    }
});

// ============================================================
// 表格单元格内的行内节点
// ============================================================

test('表格片段：单元格内的上标、下标与下划线渲染成 sup / sub / u，文本仍转义', () => {
    // Arrange
    const nodes = [
        createText('CO'),
        { type: 'subscript', children: [createText('2')] },
        createText(' 面积 m'),
        { type: 'superscript', children: [createText('3')] },
        { type: 'underline', children: [createText('<划>')] },
    ];

    // Act
    const html = inline(nodes);

    // Assert
    assert.ok(html.includes('<td>CO<sub>2</sub> 面积 m<sup>3</sup><u>&lt;划&gt;</u></td>'), html.match(/<td>[\s\S]*?<\/td>/));
});

test('表格片段：上下标可嵌套其它行内节点，未知节点仍按原有兜底取文本', () => {
    // Arrange
    const nodes = [
        { type: 'superscript', children: [{ type: 'strong', children: [createText('n')] }] },
        { type: 'subscript', children: [] },
        { type: 'unknownInline', children: [createText('兜底')] },
    ];

    // Act
    const html = inline(nodes);

    // Assert
    assert.ok(html.includes('<td><sup><b>n</b></sup><sub></sub>兜底</td>'), html.match(/<td>[\s\S]*?<\/td>/));
});

// ============================================================
// data.grid 路径（docx 表格：合并单元格、单元格内多段与行内格式）
// ============================================================

/** 最小 grid 单元格；不写的项按 buildTableFragment 的默认值处理 */
const gridCell = (paragraphs, extra = {}) => ({ colspan: 1, rowspan: 1, header: false, paragraphs, ...extra });
const gridTable = (rows) => ({ ...createTable(null, [createTableRow([createTableCell('忽略')])]), data: { grid: { rows } } });
const bodyOf = (html) => {
    const matched = html.match(/<table>([\s\S]*)<\/table>/);
    assert.ok(matched, `片段页应含表格：${html.slice(0, 200)}`);
    return matched[1];
};

test('表格片段：有 grid 时按 grid 重建，跨度为 1 的不写 colspan / rowspan', () => {
    // Arrange
    const table = gridTable([
        { header: false, cells: [gridCell([[createText('横')]], { colspan: 2 }), gridCell([[createText('纵')]], { rowspan: 3 })] },
        { header: false, cells: [gridCell([[createText('普通')]])] },
    ]);

    // Act
    const body = bodyOf(buildTableFragment(table));

    // Assert
    assert.equal(body, '<tbody><tr><td colspan="2"><p>横</p></td><td rowspan="3"><p>纵</p></td></tr>'
        + '<tr><td><p>普通</p></td></tr></tbody>');
});

test('表格片段：有 grid 时首行不再强制加粗，只有 header 单元格用 th', () => {
    // Arrange
    const withoutHeader = gridTable([{ header: false, cells: [gridCell([[createText('首行')]])] }]);
    const withHeader = gridTable([
        { header: true, cells: [gridCell([[createText('表头')]], { header: true })] },
        { header: false, cells: [gridCell([[createText('正文')]])] },
    ]);

    // Act
    const plain = bodyOf(buildTableFragment(withoutHeader));
    const headed = bodyOf(buildTableFragment(withHeader));

    // Assert
    assert.equal(plain, '<tbody><tr><td><p>首行</p></td></tr></tbody>', '首行是普通行时全为 td');
    assert.equal(headed, '<thead><tr><th><p>表头</p></th></tr></thead><tbody><tr><td><p>正文</p></td></tr></tbody>');
});

test('表格片段：单元格内每段一个 <p>，段落外边距归零并给出小段间距', () => {
    // Arrange
    const table = gridTable([{ header: false, cells: [gridCell([[createText('一')], [createText('二')], [createText('三')]])] }]);

    // Act
    const html = buildTableFragment(table);

    // Assert
    assert.ok(bodyOf(html).includes('<td><p>一</p><p>二</p><p>三</p></td>'), bodyOf(html));
    assert.match(html, /th>p,td>p\{margin:0\}/);
    assert.match(html, /th>p\+p,td>p\+p\{margin-top:\dpt\}/);
});

test('表格片段：grid 里的文本一律转义，不把来源标记带进片段页', () => {
    // Arrange
    const injected = '<script>x</script>&"\'<td>';
    const table = gridTable([{ header: false, cells: [gridCell([[createText(injected), { type: 'strong', children: [createText('<b>')] }]])] }]);

    // Act
    const html = buildTableFragment(table);

    // Assert
    assert.ok(!html.includes('<script'), '片段页不得出现来源的 script 标签');
    assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;&amp;&quot;&#39;&lt;td&gt;'), bodyOf(html));
    assert.ok(html.includes('<b>&lt;b&gt;</b>'), '行内容器由节点类型重建，内容仍转义');
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/);
});

test('表格片段：grid 里的跨度为脏数据时回落到 1，结构不符时回落到 GFM 路径', () => {
    // Arrange
    const dirty = gridTable([{ header: false, cells: [
        gridCell([[createText('甲')]], { colspan: 0, rowspan: -2 }),
        gridCell([[createText('乙')]], { colspan: '3', rowspan: 2.5 }),
        gridCell([[createText('丙')]], { colspan: 99999 }),
    ] }]);
    const broken = { ...createTable(null, [createTableRow([createTableCell('甲')])]), data: { grid: { rows: [] } } };

    // Act
    const dirtyBody = bodyOf(buildTableFragment(dirty));
    const brokenHtml = buildTableFragment(broken);

    // Assert
    assert.equal(dirtyBody, '<tbody><tr><td><p>甲</p></td><td><p>乙</p></td><td><p>丙</p></td></tr></tbody>');
    assert.equal(brokenHtml, buildTableFragment(createTable(null, [createTableRow([createTableCell('甲')])])), 'rows 为空时与无 grid 的输出一致');
});
