/**
 * converters/ir/turndown.js 单元测试
 * 覆盖：HTML 表格 → GFM 表格的列数判定（取各行最大值、短行补空单元格、排除嵌套表格的行）、
 *       各 profile 的「~」转义、url profile 的保真约定（HTML 标签、标记、图注、上下标），
 *       表格单元格与图片 alt 接入 service.escape（转义顺序、换行折叠、src 与 title 沿用内置规则），
 *       以及 turndown → remark-gfm → ir/inline-html 的全链路结果
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

// liftInlineHtml 的 source 取值：word profile 的产物来自 parsers/docx，其余来自 parsers/url
const SOURCE_OF = { basic: 'web', word: 'docx', url: 'web' };

// turndown → remark-parse + remark-gfm → liftInlineHtml，与 parsers/docx、parsers/url 内的调用同序
async function toIr(html, profile = 'url') {
    const md = toMarkdown(html, profile);
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    return { md, ir: liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(md), { source: SOURCE_OF[profile] }) };
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

// ============================================================
// 表格单元格接入 service.escape（全链路：turndown → remark-gfm → ir/inline-html）
// ============================================================

// 单列表格：表头固定为「项」，其余每个入参各占一行
const tableOf = (...cells) => `<table><tr><th>项</th></tr>${cells.map((c) => `<tr><td>${c}</td></tr>`).join('')}</table>`;
// IR 中逐行的单元格文本（含表头行）
const rowCells = (ir) => collect(ir, (n) => n.type === 'tableRow').map((row) => row.children.map(plainText));
// 单元格转义后不应再被误解析出来的行内节点
const INLINE_TYPES = ['delete', 'emphasis', 'strong', 'inlineCode', 'link'];

test('表格单元格：成对的「~」与星号等行内记号被转义，逐字进入 IR 且不生成行内节点', async () => {
    // Arrange：区间号、强调星号、下划线与反引号与链接写法
    const html = tableOf('10~20℃、30~40℃', 'a*b*c', '_x_ 与 `y` 与 [z](u)');

    // Act & Assert：表格规则挂在 word 与 url 两个 profile 上，行为应一致
    for (const profile of PROFILES_WITH_TABLE) {
        const { md, ir } = await toIr(html, profile);
        const lines = md.split('\n');

        // Assert：Markdown 数据行逐字符相符
        assert.equal(lines[2], '| 10\\~20℃、30\\~40℃ |', profile);
        assert.equal(lines[3], '| a\\*b\\*c |', profile);
        assert.equal(lines[4], '| \\_x\\_ 与 \\`y\\` 与 \\[z\\](u) |', profile);

        // Assert：全链路后各单元格文本与源文本逐字相等
        assert.deepEqual(
            rowCells(ir),
            [['项'], ['10~20℃、30~40℃'], ['a*b*c'], ['_x_ 与 `y` 与 [z](u)']],
            profile,
        );

        // Assert：删除线、强调、行内代码与链接一个都不应出现
        for (const type of INLINE_TYPES) {
            assert.deepEqual(textsOfType(ir, type), [], `${profile} 不应出现 ${type} 节点`);
        }
    }
});

test('表格单元格：字面反斜杠与竖线相邻时仍属同一单元格，反斜杠与「~」逐字保留', async () => {
    // Arrange：a\|b 中的反斜杠为字面量，若不先加倍就补转义竖线，两者会配成一对、竖线重新成为列分隔符
    const html = tableOf('a\\|b', '甲\\~乙~丙');

    // Act & Assert
    for (const profile of PROFILES_WITH_TABLE) {
        const { md, ir } = await toIr(html, profile);
        const lines = md.split('\n');

        // Assert：escape 先把反斜杠加倍，再补的竖线转义使其前导反斜杠为奇数个
        assert.equal(lines[2], '| a\\\\\\|b |', profile);
        assert.equal(lines[3], '| 甲\\\\\\~乙\\~丙 |', profile);

        // Assert：每行恰一个单元格，字面反斜杠与两个「~」都在
        assert.deepEqual(rowCells(ir), [['项'], ['a\\|b'], ['甲\\~乙~丙']], profile);
    }
});

test('表格单元格：换行折叠与竖线转义的既有行为不变；行首记号转义后 IR 文本逐字不变', async () => {
    // Act & Assert
    for (const profile of PROFILES_WITH_TABLE) {
        // Assert：单元格内换行折叠为空格，未转义的竖线补反斜杠后仍属同一单元格
        const folded = await toIr('<table><tr><td>甲\n乙</td><td>a|b</td></tr></table>', profile);
        assert.deepEqual(rowCells(folded.ir), [['甲 乙', 'a|b']], profile);

        // Assert：行首记号经 escape 后带上反斜杠，remark 解析时逐字还原，IR 文本不变
        const markers = await toIr(tableOf('-5', '1. 项', '# 题', '&gt;90%'), profile);
        assert.deepEqual(
            markers.md.split('\n').slice(2),
            ['| \\-5 |', '| 1\\. 项 |', '| \\# 题 |', '| \\>90% |'],
            profile,
        );
        assert.deepEqual(rowCells(markers.ir), [['项'], ['-5'], ['1. 项'], ['# 题'], ['>90%']], profile);
    }
});

// ============================================================
// 图片 alt 接入 service.escape（新规则接管内置 image 规则）
// ============================================================

const firstImage = (ir) => collect(ir, (n) => n.type === 'image')[0];

test('图片 alt：成对的「~」被转义，alt 逐字进入 IR 且不生成 delete 节点', async () => {
    // Act & Assert：内置 image 规则为三个 profile 共用，新规则同样覆盖三者
    for (const profile of ALL_PROFILES) {
        const { md, ir } = await toIr('<p><img src="a.png" alt="10~20℃与30~40℃对比"></p>', profile);

        assert.equal(md, '![10\\~20℃与30\\~40℃对比](a.png)', profile);
        const images = collect(ir, (n) => n.type === 'image');
        assert.equal(images.length, 1, profile);
        assert.equal(images[0].alt, '10~20℃与30~40℃对比', profile);
        assert.deepEqual(textsOfType(ir, 'delete'), [], profile);
    }
});

test('图片 alt：内置转义表原有的覆盖面不因接管而回退（方括号、星号、结尾反斜杠）', async () => {
    // Act & Assert
    for (const profile of ALL_PROFILES) {
        const bracket = await toIr('<p><img src="a.png" alt="图[1] 甲~乙~丙 *强*"></p>', profile);
        assert.equal(bracket.md, '![图\\[1\\] 甲\\~乙\\~丙 \\*强\\*](a.png)', profile);
        assert.equal(firstImage(bracket.ir).alt, '图[1] 甲~乙~丙 *强*', profile);

        // 以反斜杠结尾：escape 先把它加倍，方括号才不会被吃掉
        const backslash = await toIr('<p><img src="a.png" alt="甲~乙~\\"></p>', profile);
        assert.equal(firstImage(backslash.ir).alt, '甲~乙~\\', profile);
    }
});

test('图片 alt：只折叠换行，行内的制表符与连续空格逐字保留', async () => {
    // Act & Assert
    for (const profile of ALL_PROFILES) {
        // Assert：换行后的「- 」原本会打断段落、使整张图片丢失，折叠为空格后图片完整
        const multiline = await toIr('<p><img src="a.png" alt="甲~乙\n- 丙~丁"></p>', profile);
        assert.equal(multiline.md, '![甲\\~乙 - 丙\\~丁](a.png)', profile);
        assert.equal(firstImage(multiline.ir).alt, '甲~乙 - 丙~丁', profile);
        assert.deepEqual(collect(multiline.ir, (n) => n.type === 'list'), [], profile);

        // Assert：Word 自动生成的替代文字形如「图形用户界面\n\n描述已自动生成」，空行一并折叠为单个空格
        const auto = await toIr('<p><img src="a.png" alt="图形用户界面\n\n描述已自动生成"></p>', profile);
        assert.equal(firstImage(auto.ir).alt, '图形用户界面 描述已自动生成', profile);

        // Assert：换行之外的空白不属折叠范围，制表符与连续空格原样保留
        const inlineSpace = await toIr('<p><img src="a.png" alt="甲\t\t乙   丙~丁~"></p>', profile);
        assert.equal(firstImage(inlineSpace.ir).alt, '甲\t\t乙   丙~丁~', profile);

        // Assert：换行两侧的空白随换行一并折叠，首尾的换行不留空格（&#13;&#10; 为字符引用写入的 CRLF）
        assert.equal(toMarkdown('<p><img src="a.png" alt="\n甲  \n\t 乙&#13;&#10;丙\n"></p>', profile), '![甲 乙 丙](a.png)', profile);
    }
});

test('图片 src 与 title 的输出与内置规则逐字一致，title 中的「~」不转义', async () => {
    // Act & Assert
    for (const profile of ALL_PROFILES) {
        // Assert：src 含「~」、空格与括号，title 含「~」与引号；title 不按 Markdown 解析，无须转义
        const full = await toIr('<p><img src="dir/~u/a (1).png" alt="5~6与7~8" title="5~10 &quot;与&quot; 20~30"></p>', profile);
        assert.equal(full.md, '![5\\~6与7\\~8](<dir/~u/a \\(1\\).png> "5~10 \\"与\\" 20~30")', profile);
        assert.equal(firstImage(full.ir).url, 'dir/~u/a (1).png', profile);
        assert.equal(firstImage(full.ir).title, '5~10 "与" 20~30', profile);

        // Assert：无 src 的图片输出空串，无 alt 的图片输出 ![](src)
        assert.equal(toMarkdown('<p><img alt="1~2~3"></p>', profile), '', profile);
        assert.equal(toMarkdown('<p><img src="b.png"></p>', profile), '![](b.png)', profile);
    }
});

test('url profile：带 data-mf-display 的图片仍由 imgDisplay 规则接管，优先级未被 alt 规则抢占', async () => {
    // Act
    const { md, ir } = await toIr('<p><img src="a.png" alt="10~20℃与30~40℃" data-mf-display="320"></p>', 'url');

    // Assert：输出 HTML 而非 Markdown 图片，其 alt 不经 Markdown 解析，逐字还原
    assert.equal(md, '<img src="a.png" alt="10~20℃与30~40℃" width="320">');
    assert.equal(firstImage(ir).alt, '10~20℃与30~40℃');
});
