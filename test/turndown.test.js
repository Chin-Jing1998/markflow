/**
 * converters/ir/turndown.js 单元测试
 * 覆盖：HTML 表格 → GFM 表格的列数判定（取各行最大值、短行补空单元格、排除嵌套表格的行）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTurndownService } = require('../converters/ir/turndown');
const { MARKERS } = require('../converters/ir/markers');

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

// ============================================================
// url profile 的保真约定（与 ir/markers、ir/inline-html 配套）
// ============================================================

test('url profile：section 按块级分段（微信正文不再塌成一段），<br> 输出 BR 标记', () => {
    // Act
    const markdown = toMarkdown('<section><span>甲</span></section><section><section><span>乙<br>丙</span></section></section>', 'url');

    // Assert
    assert.equal(markdown, `甲\n\n乙${MARKERS.BR}丙`);
});

test('url profile：粗体、斜体、删除线输出 HTML 标签而非星号；含空行的块级粗体逐块包裹', () => {
    // Act
    const inline = toMarkdown('<p>依据<strong>《词典》</strong>的<em>斜</em><del>删</del><span style="font-weight:bold">样式粗</span></p>', 'url');
    const block = toMarkdown('<section style="font-weight: bold"><p>甲</p><p>乙</p></section>', 'url');

    // Assert
    assert.equal(inline, '依据<strong>《词典》</strong>的<em>斜</em><del>删</del><strong>样式粗</strong>');
    assert.equal(block, '<strong>甲</strong>\n\n<strong>乙</strong>');
});

test('url profile：图片后的小字 section 与 figcaption 输出 CAPTION 标记开头的独立段落', () => {
    // Act
    const wechat = toMarkdown('<section><img src="a.png"></section><section style="font-size: 12px;text-align: center"><span>图｜说明</span></section>', 'url');
    const figure = toMarkdown('<figure><img src="b.png"><figcaption>图 1 甲</figcaption></figure>', 'url');
    const notCaption = toMarkdown('<section><span>无图</span></section><section style="font-size: 12px"><span>小字但前面没有图</span></section>', 'url');

    // Assert
    assert.equal(wechat, `![](a.png)\n\n${MARKERS.CAPTION}图｜说明`);
    assert.equal(figure, `![](b.png)\n\n${MARKERS.CAPTION}图 1 甲`);
    assert.ok(!notCaption.includes(MARKERS.CAPTION), notCaption);
});

test('url profile：带 data-mf-display 的 img 输出 <img src alt width>（属性值转义、百分比、宽高）', () => {
    assert.equal(toMarkdown('<img src="images/a.png" alt="甲&quot;乙" data-mf-display="677">', 'url'), '<img src="images/a.png" alt="甲&quot;乙" width="677">');
    assert.equal(toMarkdown('<img src="a.png" data-mf-display="320x160">', 'url'), '<img src="a.png" width="320" height="160">');
    assert.equal(toMarkdown('<img src="a.png" data-mf-display="50%">', 'url'), '<img src="a.png" width="50%">');
    assert.equal(toMarkdown('<img src="a.png" data-mf-display="bad">', 'url'), '');
});

test('word profile 保留 <u>（mammoth 经 styleMap 产出），交 ir/inline-html 提升', () => {
    assert.equal(toMarkdown('<p>前<u>下划线</u>后</p>', 'word'), '前<u>下划线</u>后');
});
