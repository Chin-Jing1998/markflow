/**
 * converters/ir/turndown.js 单元测试
 * 覆盖：HTML 表格 → GFM 表格的列数判定（取各行最大值、短行补空单元格、排除嵌套表格的行）、
 *       各 profile 的「~」转义、url profile 的保真约定（HTML 标签、标记、图注、上下标），
 *       以及 turndown 'url' → remark-gfm → ir/inline-html 的全链路结果
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createTurndownService } = require('../converters/ir/turndown');
const { MARKERS } = require('../converters/ir/markers');
const { loadUnified } = require('../converters/ir/unified-loader');
const { liftInlineHtml } = require('../converters/ir/inline-html');

// 表格规则在 word 与 url 两个 profile 上都挂着，两者行为应一致
const PROFILES_WITH_TABLE = ['word', 'url'];
// 三个 profile 的产物都交给 singleTilde 的 remark-gfm 解析，故「~」转义与 profile 无关
const ALL_PROFILES = ['basic', 'word', 'url'];

function toMarkdown(html, profile = 'word') {
    return createTurndownService(profile).turndown(html).trim();
}

// turndown → remark-parse + remark-gfm → liftInlineHtml，与 parsers/url 内的调用同序
async function toIr(html, profile = 'url') {
    const md = toMarkdown(html, profile);
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    return { md, ir: liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(md), { source: 'web' }) };
}

function collect(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) for (const child of node.children) collect(child, predicate, out);
    return out;
}

function plainText(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text' || node.type === 'inlineCode') return String(node.value || '');
    if (!Array.isArray(node.children)) return '';
    return node.children.map(plainText).join('');
}

const textsOfType = (ir, type) => collect(ir, (n) => n.type === type).map(plainText);

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

test('word profile 保留 <sup>/<sub>（mammoth 由 w:vertAlign 产出），交 ir/inline-html 提升', () => {
    assert.equal(toMarkdown('<p>R<sup>2</sup>基团</p>', 'word'), 'R<sup>2</sup>基团');
    assert.equal(toMarkdown('<p>C<sub>1</sub>的烷基</p>', 'word'), 'C<sub>1</sub>的烷基');
});

test('各 profile：文本中的「~」转义为 \\~，避免成对的单波浪号被 remark-gfm 解析为删除线', () => {
    // Act & Assert：HTML 文本中的「~」恒为字面量，三个 profile 一视同仁
    for (const profile of ALL_PROFILES) {
        // 区间号「~」成对出现时最易受害，须逐个转义
        assert.equal(toMarkdown('<p>C1~C30的烷基、C1~C30的烷氧基</p>', profile), 'C1\\~C30的烷基、C1\\~C30的烷氧基', profile);
        // turndown 自身只转义行首的 ~~~，已带反斜杠的不重复转义，其余补齐
        assert.equal(toMarkdown('<p>~~~甲</p>', profile), '\\~\\~\\~甲', profile);
        // 文本中的字面反斜杠先被转义成 \\，其后的 ~ 仍须转义
        assert.equal(toMarkdown('<p>甲\\~乙</p>', profile), '甲\\\\\\~乙', profile);
    }
});

test('url profile 保留 <sup>/<sub>（网页的化学式与脚注标号），交 ir/inline-html 提升', () => {
    // Act & Assert：上下标为行内标签，不额外分段
    assert.equal(toMarkdown('<p>R<sup>2</sup>、C<sub>1</sub>的烷基</p>', 'url'), 'R<sup>2</sup>、C<sub>1</sub>的烷基');
    // 上标内的链接照常转 Markdown（脚注标号的常见写法）
    assert.equal(toMarkdown('<p>结论<sup><a href="#fn1">[1]</a></sup>成立</p>', 'url'), '结论<sup>[\\[1\\]](#fn1)</sup>成立');
    // 空标签不留残壳
    assert.equal(toMarkdown('<p>甲<sup> </sup>乙</p>', 'url'), '甲 乙');
});

test('url profile：line-through 样式仍输出 <del>，既有的行内样式约定不受上下标规则影响', () => {
    // Act & Assert：新规则注册在 URL_WRAP_RULES 表首、优先级最低，既有规则的命中不变
    assert.equal(toMarkdown('<p><span style="text-decoration: line-through">作废</span></p>', 'url'), '<del>作废</del>');
    assert.equal(toMarkdown('<p><sup style="text-decoration: line-through">废标</sup></p>', 'url'), '<del>废标</del>');
});

// ============================================================
// url profile 全链路：turndown → remark-gfm → ir/inline-html
// ============================================================

test('url profile 全链路：区间号「~」逐字进入 IR，不产生 delete 节点', async () => {
    // Act
    const { md, ir } = await toIr('<p>C1~C30的烷基、疗程3~5天</p>');

    // Assert
    assert.equal(md, 'C1\\~C30的烷基、疗程3\\~5天');
    assert.equal(plainText(ir), 'C1~C30的烷基、疗程3~5天');
    assert.deepEqual(textsOfType(ir, 'delete'), []);
});

test('url profile 全链路：<sup>/<sub> 还原为 superscript / subscript 节点', async () => {
    // Act
    const { ir } = await toIr('<p>R<sup>2</sup>、C<sub>1</sub>的烷基</p>');

    // Assert
    assert.deepEqual(textsOfType(ir, 'superscript'), ['2']);
    assert.deepEqual(textsOfType(ir, 'subscript'), ['1']);
    assert.equal(plainText(ir), 'R2、C1的烷基');
    assert.deepEqual(collect(ir, (n) => n.type === 'html'), []);
});

test('url profile 全链路：<del>/<s> 输出 <del> 标签而非 ~~，还原为 delete 节点且其中的「~」逐字保留', async () => {
    // Act
    const { md, ir } = await toIr('<p>原价<del>3~5元</del>，现价<s>作废</s>两元</p>');

    // Assert
    assert.equal(md, '原价<del>3\\~5元</del>，现价<del>作废</del>两元');
    assert.ok(!md.includes('~~'), md);
    assert.deepEqual(textsOfType(ir, 'delete'), ['3~5元', '作废']);
    assert.equal(plainText(ir), '原价3~5元，现价作废两元');
});
