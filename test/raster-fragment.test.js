/**
 * converters/raster/fragment.js 片段页单元测试（不出图，只看 HTML）
 * 覆盖：公式片段页按 data.fontSizePt 出图与标定系数、字号缺失 / 越界时的回落、
 *       表格单元格内的上标 / 下标 / 下划线节点渲染
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
