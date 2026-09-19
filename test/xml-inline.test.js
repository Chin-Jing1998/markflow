/**
 * converters/renderers/xml/inline.js 单元测试
 * 覆盖：superscript / subscript 节点摊平为 sup / sub 标记，与 b / i / u 嵌套时按 MARK_ORDER 出元素；
 *       残留的 <sup>/<sub> html 节点（未被 ir/inline-html 提升时的兜底）同样还原；
 *       p 与 claim-text 两种语境下的输出形态一致
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { flattenInline, emitRuns } = require('../converters/renderers/xml/inline');
const { el, serialize } = require('../converters/renderers/xml/builder');

const text = (value) => ({ type: 'text', value });
const node = (type, children) => ({ type, children });

/** 行内子节点 → 指定容器元素的 XML 字符串（indent 0：整体单行，便于逐字比对） */
function renderInline(children, name = 'p') {
    return serialize(el(name, {}, emitRuns(flattenInline(children), el)), { indent: 0 });
}

test('superscript / subscript 节点输出 sup / sub 元素，p 与 claim-text 语境一致', () => {
    // Arrange：C₁~C₃₀ 的烷基；R² 基团
    const children = [
        text('C'), node('subscript', [text('1')]), text('~C'), node('subscript', [text('30')]),
        text('的烷基，R'), node('superscript', [text('2')]), text('基团'),
    ];

    // Act
    const asParagraph = renderInline(children, 'p');
    const asClaimText = renderInline(children, 'claim-text');

    // Assert
    const inner = 'C<sub>1</sub>~C<sub>30</sub>的烷基，R<sup>2</sup>基团';
    assert.equal(asParagraph, `<p>${inner}</p>`);
    assert.equal(asClaimText, `<claim-text>${inner}</claim-text>`);
});

test('上下标与加粗、斜体、下划线嵌套时按 b → i → u → sup → sub 的次序出元素', () => {
    // Arrange
    const children = [node('strong', [node('underline', [node('subscript', [text('甲')])])])];

    // Act
    const xml = renderInline(children);

    // Assert
    assert.equal(xml, '<p><b><u><sub>甲</sub></u></b></p>');
});

test('相邻同标记片段合并，标记不外溢到其后的普通文本', () => {
    // Arrange
    const children = [
        node('superscript', [text('1')]), node('superscript', [text('2')]), text('尾'),
    ];

    // Act
    const xml = renderInline(children);

    // Assert
    assert.equal(xml, '<p><sup>12</sup>尾</p>');
});

test('未被提升的 <sup>/<sub> html 节点仍按开闭标记还原（兜底路径）', () => {
    // Arrange：ir/inline-html 未提升时，mdast 中上下标是成对的 html 节点
    const children = [
        text('C'), { type: 'html', value: '<sub>' }, text('1'), { type: 'html', value: '</sub>' }, text('烷基'),
    ];

    // Act
    const xml = renderInline(children);

    // Assert
    assert.equal(xml, '<p>C<sub>1</sub>烷基</p>');
});
