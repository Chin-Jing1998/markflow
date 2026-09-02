/**
 * converters/ir/turndown.js 单元测试
 * 覆盖：HTML 表格 → GFM 表格的列数判定（取各行最大值、短行补空单元格、排除嵌套表格的行）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTurndownService } = require('../converters/ir/turndown');

// 表格规则在 word 与 url 两个 profile 上都挂着，两者行为应一致
const PROFILES_WITH_TABLE = ['word', 'url'];

function toMarkdown(html, profile = 'word') {
    return createTurndownService(profile).turndown(html).trim();
}

test('不规则表格按最长行确定列数，短行补空单元格', () => {
    // Arrange：首行 1 列、次行 3 列
    const html = '<table><tr><td>a</td></tr><tr><td>b</td><td>c</td><td>d</td></tr></table>';

    // Act & Assert
    for (const profile of PROFILES_WITH_TABLE) {
        const lines = toMarkdown(html, profile).split('\n');
        assert.equal(lines.length, 3, `${profile}: ${JSON.stringify(lines)}`);
        assert.equal(lines[0], '| a |  |  |');
        assert.equal(lines[1], '| --- | --- | --- |');
        assert.equal(lines[2], '| b | c | d |');
    }
});

test('表头短于数据行时列数不被截断', () => {
    // Arrange
    const html = '<table><thead><tr><th>甲</th></tr></thead>'
        + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>';

    // Act
    const lines = toMarkdown(html).split('\n');

    // Assert
    assert.equal(lines[1], '| --- | --- |');
    assert.equal(lines[0], '| 甲 |  |');
    assert.equal(lines[2], '| 1 | 2 |');
});

test('嵌套表格的行与单元格不计入外层表格', () => {
    // Arrange：外层 1 行 1 列，其单元格内还有一张 1 行 2 列的表
    const html = '<table><tr><td>外层'
        + '<table><tr><td>内甲</td><td>内乙</td></tr></table>'
        + '</td></tr></table>';

    // Act
    const lines = toMarkdown(html).split('\n');

    // Assert
    assert.equal(lines.length, 2, `外层表只应有 1 行数据 + 1 行分隔，实际 ${JSON.stringify(lines)}`);
    assert.equal(lines[1], '| --- |');
});

test('单元格内的换行折叠为空格，竖线被转义', () => {
    // Arrange
    const html = '<table><tr><td>甲\n乙</td><td>a|b</td></tr></table>';

    // Act
    const lines = toMarkdown(html).split('\n');

    // Assert
    assert.equal(lines[0], '| 甲 乙 | a\\|b |');
    assert.equal(lines[1], '| --- | --- |');
});
