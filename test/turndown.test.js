/**
 * converters/ir/turndown.js 单元测试
 * 覆盖：HTML 表格 → GFM 表格的列数判定（取各行最大值、短行补空单元格、排除嵌套表格的行）与表题成段、
 *       各 profile 的「~」转义（含超长反斜杠串上的线性耗时、与线性化之前实现的差分等价）、
 *       url profile 的保真约定（HTML 标签、标记、图注、上下标），
 *       表格单元格与图片 alt 接入 service.escape（转义顺序、换行折叠、src 与 title 沿用内置规则），
 *       「<」一律转义与「&」选择性转义（正文、表格单元格、图片 alt 三条通道，含跨文本节点、
 *       零宽字符穿插、裸网址查询串不受影响与线性耗时），
 *       以及 turndown → remark-gfm → ir/inline-html 的全链路结果
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const TurndownService = require('turndown');
const { createTurndownService } = require('../converters/ir/turndown');
const { MARKERS, restoreMarkers } = require('../converters/ir/markers');
const { loadUnified } = require('../converters/ir/unified-loader');
const { liftInlineHtml } = require('../converters/ir/inline-html');
const { normalizeMarkdown } = require('../converters/web/normalize');

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
// 表题（caption）：输出为紧邻表格之前、TABLE_CAPTION 标记开头的独立段落
// ============================================================

// 表题段落的段首标记；GFM 没有表题语法，标记由 ir/markers 还原为 data.role = 'table_caption'
const TABLE_CAPTION_MARK = MARKERS.TABLE_CAPTION;
// 不可见字符以码点生成，源码不出现看不见的字面量
const NBSP = String.fromCharCode(0x00a0);

test('表题：输出为紧邻表格之前、TABLE_CAPTION 标记开头的独立段落', () => {
    // Arrange
    const html = '<table><caption>表 1 各组收率</caption>'
        + '<tr><th>组别</th><th>收率</th></tr><tr><td>甲</td><td>90%</td></tr></table>';

    // Act & Assert：表格规则挂在 word 与 url 两个 profile 上，行为应一致
    for (const profile of PROFILES_WITH_TABLE) {
        assert.equal(
            toMarkdown(html, profile),
            `${TABLE_CAPTION_MARK}表 1 各组收率\n\n| 组别 | 收率 |\n| --- | --- |\n| 甲 | 90% |`,
            profile,
        );
    }
});

test('表题：只有表题的表格只输出表题段落；空表题不产出段落，表格本体与无表题时逐字相同', () => {
    // Arrange
    const body = '<tr><th>项</th></tr><tr><td>甲</td></tr>';

    // Act & Assert
    for (const profile of PROFILES_WITH_TABLE) {
        // Assert：只有表题、没有数据行
        assert.equal(
            toMarkdown('<table><caption>表 1 各组收率</caption></table>', profile),
            `${TABLE_CAPTION_MARK}表 1 各组收率`,
            profile,
        );

        // Assert：空表题与纯空白表题（含不换行空格）都不产出段落，表格本体逐字不变
        const bare = toMarkdown(`<table>${body}</table>`, profile);
        assert.equal(toMarkdown(`<table><caption></caption>${body}</table>`, profile), bare, profile);
        assert.equal(toMarkdown(`<table><caption> ${NBSP}\n</caption>${body}</table>`, profile), bare, profile);

        // Assert：既无表题也无数据行时输出空串
        assert.equal(toMarkdown(`<table><caption> ${NBSP}</caption></table>`, profile), '', profile);
    }
});

test('表题：经 service.escape 转义而竖线不转义，全链路后成 role 为 table_caption 的段落', async () => {
    // Arrange：区间号、强调星号、下划线、反引号、方括号与竖线
    const captionText = '表 1 10~20℃与30~40℃的*收率*，_a_ 与 `b` 与 [c](d)，a|b';
    const escaped = '表 1 10\\~20℃与30\\~40℃的\\*收率\\*，\\_a\\_ 与 \\`b\\` 与 \\[c\\](d)，a|b';
    const html = `<table><caption>${captionText}</caption><tr><td>甲</td></tr></table>`;

    // Act & Assert
    for (const profile of PROFILES_WITH_TABLE) {
        const { md, ir } = await toIr(html, profile);
        const restored = restoreMarkers(ir);

        // Assert：Markdown 记号已转义；段落里的竖线是字面量，不转义
        assert.equal(md.split('\n')[0], TABLE_CAPTION_MARK + escaped, profile);

        // Assert：根的子节点依次为表题段落与表格，段落文本与源文字逐字相等
        const [caption, table] = restored.children;
        assert.equal(caption.type, 'paragraph', profile);
        assert.deepEqual(caption.data, { role: 'table_caption' }, profile);
        assert.equal(plainText(caption), captionText, profile);
        assert.equal(table.type, 'table', profile);

        // Assert：删除线、强调、行内代码与链接一个都不应出现
        for (const type of INLINE_TYPES) {
            assert.deepEqual(textsOfType(restored, type), [], `${profile} 不应出现 ${type} 节点`);
        }

        // Assert：行首记号作表题时经 escape 带上反斜杠，IR 文本逐字不变，不生成 list / heading 节点
        for (const lead of ['1. 概述', '# 题', '- 项']) {
            const marked = await toIr(`<table><caption>${lead}</caption><tr><td>甲</td></tr></table>`, profile);
            const [leadCaption] = restoreMarkers(marked.ir).children;
            assert.equal(plainText(leadCaption), lead, `${profile}: ${lead}`);
            assert.deepEqual(collect(marked.ir, (n) => n.type === 'list' || n.type === 'heading'), [], `${profile}: ${lead}`);
        }
    }
});

test('表题：换行、制表符、连续空格与不换行空格折叠为单个空格，首尾空白去除', () => {
    // Arrange
    const html = `<table><caption>  表 1\n\t各组${NBSP}${NBSP}收率   （甲）  </caption><tr><td>甲</td></tr></table>`;

    // Act & Assert
    for (const profile of PROFILES_WITH_TABLE) {
        assert.equal(toMarkdown(html, profile).split('\n')[0], `${TABLE_CAPTION_MARK}表 1 各组 收率 （甲）`, profile);
    }
});

test('表题：多个 caption 逐个成段且顺序与 DOM 一致；写在行之后的与嵌套表格的各按其表归属', () => {
    // Act & Assert
    for (const profile of PROFILES_WITH_TABLE) {
        // Assert：两个 caption 按 DOM 顺序各成一段，排在表格本体之前
        assert.equal(
            toMarkdown('<table><caption>表 1 甲</caption><caption>续表 1</caption><tr><td>x</td></tr></table>', profile),
            `${TABLE_CAPTION_MARK}表 1 甲\n\n${TABLE_CAPTION_MARK}续表 1\n\n| x |\n| --- |`,
            profile,
        );

        // Assert：写在数据行之后的 caption（domino 解析后 DOM 顺序为 TBODY,CAPTION）仍输出在表格之前
        assert.equal(
            toMarkdown('<table><tr><td>x</td></tr><caption>表 1 甲</caption></table>', profile),
            `${TABLE_CAPTION_MARK}表 1 甲\n\n| x |\n| --- |`,
            profile,
        );

        // Assert：内层表题不计入外层——标记只出现一次，其文字随单元格纯文本落在外层单元格内
        const nested = toMarkdown('<table><caption>外题</caption><tr><td>外层'
            + '<table><caption>内题</caption><tr><td>内甲</td></tr></table>'
            + '</td></tr></table>', profile);
        assert.equal(nested.split(TABLE_CAPTION_MARK).length - 1, 1, `${profile}: ${JSON.stringify(nested)}`);
        assert.equal(nested, `${TABLE_CAPTION_MARK}外题\n\n| 外层内题内甲 |\n| --- |`, profile);
    }
});

test('url profile：加粗 section 内的表题随块级粗体逐块包裹，全链路后仍带 table_caption 角色', async () => {
    // Arrange
    const html = '<section style="font-weight: bold"><table><caption>表 1</caption><tr><td>a</td></tr></table></section>';

    // Act
    const { md, ir } = await toIr(html, 'url');
    const [caption] = restoreMarkers(ir).children;

    // Assert：表格本体属块语法、不套 <strong>，表题段落照常包裹
    assert.equal(md, `<strong>${TABLE_CAPTION_MARK}表 1</strong>\n\n| a |\n| --- |`);
    assert.deepEqual(caption.data, { role: 'table_caption' });
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

// ============================================================
// 「~」转义的耗时与语义等价：escapeTildes 须线性于文本长度
// ============================================================

// 耗时用例的输入规模：8 万个字面反斜杠，经 turndown 内置转义加倍后为 16 万。
// 线性化之前的写法 /(\\*)~/g 在这一规模上实测 13661 ms（1 万 40 ms、4 万 777 ms，耗时随长度平方增长）
const TILDE_STRESS_BACKSLASHES = 80000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。
// 2000 ms 使两侧余量都不小于 5 倍——线性化之前的 13661 ms 是它的 6.8 倍，线性化之后实测数毫秒、
// 不足它的百分之一，故慢机以及 node --test 多文件并行抢占 CPU 时都不会误报
const TILDE_STRESS_BUDGET_MS = 2000;

const elapsedMsSince = (started) => Number(process.hrtime.bigint() - started) / 1e6;

// 线性化之前的 escapeTildes，仅作短输入的差分参照：其前导的 \\* 在不含「~」的长反斜杠串上逐位回溯，
// 不可用于耗时用例的输入规模
const legacyEscapeTildes = (text) => text.replace(/(\\*)~/g, (matched, slashes) => (slashes.length % 2 === 1 ? matched : `${slashes}\\~`));

// 字母表上长度 0 到 maxLength 的全部字符串
function everyStringUpTo(maxLength, alphabet) {
    let level = [''];
    const all = [...level];
    for (let length = 1; length <= maxLength; length += 1) {
        level = level.flatMap((prefix) => alphabet.map((character) => prefix + character));
        all.push(...level);
    }
    return all;
}

test('escape：不含「~」的 8 万个反斜杠不触发回溯，耗时在绝对上限内且输出逐字正确', () => {
    // Arrange：只用 url profile——escape 的包装挂在工厂层、与 profile 无关，而网页正文属不可信输入
    const service = createTurndownService('url');
    const input = '\\'.repeat(TILDE_STRESS_BACKSLASHES);

    // Act
    const started = process.hrtime.bigint();
    const escaped = service.escape(input);
    const elapsedMs = elapsedMsSince(started);

    // Assert：先验输出正确，以免「快」来自少做了事
    assert.equal(escaped.length, TILDE_STRESS_BACKSLASHES * 2, '内置转义把每个字面反斜杠加倍，长度应恰为输入的 2 倍');
    assert.ok(!/[^\\]/.test(escaped), '输出应只含反斜杠');
    assert.ok(elapsedMs < TILDE_STRESS_BUDGET_MS, `escape 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${TILDE_STRESS_BUDGET_MS} ms`);
});

test('turndown 全链路：正文含 8 万个反斜杠时耗时在绝对上限内，输出逐字正确', () => {
    // Arrange：文本节点经 service.escape 转义，是全链路上唯一会被这段反斜杠拖慢的环节
    const service = createTurndownService('url');
    const html = `<p>${'\\'.repeat(TILDE_STRESS_BACKSLASHES)}</p>`;

    // Act
    const started = process.hrtime.bigint();
    const md = service.turndown(html);
    const elapsedMs = elapsedMsSince(started);

    // Assert
    assert.equal(md.length, TILDE_STRESS_BACKSLASHES * 2, '内置转义把每个字面反斜杠加倍，长度应恰为输入的 2 倍');
    assert.ok(!/[^\\]/.test(md), '输出应只含反斜杠');
    assert.ok(elapsedMs < TILDE_STRESS_BUDGET_MS, `turndown 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${TILDE_STRESS_BUDGET_MS} ms`);
});

test('escape 与线性化之前的实现逐字等价：{反斜杠, ~, 普通字符} 上长度不超过 7 的全部字符串', () => {
    // Arrange：3 个字符的字母表上长度 0 到 7 的全部字符串共 3280 个
    const samples = everyStringUpTo(7, ['\\', '~', 'a']);
    const builtinEscape = TurndownService.prototype.escape;
    assert.equal(samples.length, 3280);

    // Act & Assert：工厂层的 escape 等于「内置转义 + 线性化之前的 escapeTildes」
    for (const profile of ALL_PROFILES) {
        const service = createTurndownService(profile);
        for (const text of samples) {
            assert.equal(service.escape(text), legacyEscapeTildes(builtinEscape(text)), `${profile}: ${JSON.stringify(text)}`);
        }
    }
});

test('escape：反斜杠串位于串首、串尾与「~」两侧时，奇偶判定对每个「~」独立成立', () => {
    // Arrange：[HTML 文本中的字面值, 期望的 Markdown]
    const cases = [
        ['~', String.raw`\~`],                                          // 孤立的「~」
        ['~~', String.raw`\~\~`],                                       // 连续两个「~」逐个转义
        ['~a~', String.raw`\~a\~`],                                     // 「~」分居普通字符两侧
        ['~~~', String.raw`\~\~\~`],                                    // 行首 ~~~ 被内置转义成 \~~~，首个「~」已带 1 个反斜杠，不重复转义
        ['~~~~', String.raw`\~\~\~\~`],                                 // 行首 ~~~ 之后多出的「~」前无反斜杠，照常转义
        ['a~~~', String.raw`a\~\~\~`],                                  // 同样三个「~」不在行首，内置转义不介入，三个都要转义
        [String.raw`\~`, String.raw`\\\~`],                             // 反斜杠串紧邻「~」之前：1 个字面反斜杠加倍为 2 个，偶数故补转义
        [String.raw`\\~`, String.raw`\\\\\~`],                          // 2 个字面反斜杠加倍为 4 个
        [String.raw`\\\~甲`, String.raw`\\\\\\\~甲`],                    // 3 个字面反斜杠加倍为 6 个
        ['~\\', String.raw`\~\\`],                                      // 反斜杠串位于串尾、紧随「~」之后，只受内置转义影响
        [String.raw`a\\b`, String.raw`a\\\\b`],                         // 不含「~」时只有内置转义生效
    ];

    // Act & Assert
    for (const profile of ALL_PROFILES) {
        const service = createTurndownService(profile);
        for (const [input, expected] of cases) {
            assert.equal(service.escape(input), expected, `${profile}: ${JSON.stringify(input)}`);
        }
    }
});

// ============================================================
// 「<」与「&」的转义（正文、表格单元格、图片 alt 三条通道共用 service.escape）
// ============================================================

// parsers/url 的链路顺序：turndown → normalizeMarkdown（删零宽字符）→ remark-parse + remark-gfm → liftInlineHtml
async function toIrNormalized(html) {
    const md = normalizeMarkdown(toMarkdown(html, 'url'));
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    return { md, ir: liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(md), { source: SOURCE_OF.url }) };
}

const htmlNodes = (ir) => collect(ir, (n) => n.type === 'html');

// 零宽空格 U+200B：以码点生成，测试源码里不出现看不见的字面量
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200B);
// 对抗性输入的长度与单次转义的耗时上限：转义须随长度线性增长
const STRESS_LENGTH = 200000;
const STRESS_LIMIT_MS = 1000;

test('各 profile 全链路：正文中的「<」一律转义，标签与注释写法逐字进入 IR', async () => {
    // Act & Assert：「<」是否构成标签取决于后随字符，而 escape 逐文本节点调用、看不到下一个节点，故一律转义
    for (const profile of ALL_PROFILES) {
        const tag = await toIr('<p>当a&lt;b&gt;c时成立</p>', profile);
        assert.equal(tag.md, '当a\\<b>c时成立', profile);
        assert.equal(plainText(tag.ir), '当a<b>c时成立', profile);
        assert.deepEqual(htmlNodes(tag.ir), [], profile);
        assert.deepEqual(textsOfType(tag.ir, 'strong'), [], profile);

        // Assert：块级标签写在段首时整段会被当成 html 块，转义后仍是普通段落文本
        const block = await toIr('<p>&lt;div&gt;块级开头&lt;/div&gt;</p>', profile);
        assert.equal(plainText(block.ir), '<div>块级开头</div>', profile);
        assert.deepEqual(htmlNodes(block.ir), [], profile);

        // Assert：注释写法同理
        const comment = await toIr('<p>&lt;!-- 注释 --&gt;之后</p>', profile);
        assert.equal(plainText(comment.ir), '<!-- 注释 -->之后', profile);
        assert.deepEqual(htmlNodes(comment.ir), [], profile);

        // Assert：后随空白、汉字或另一个「<」时看似无害，同样转义——不按后随字符放行，IR 文本不受多转义影响
        const harmless = await toIr('<p>x &lt; y 且 温度&lt;中值 且 a&lt;&lt;b</p>', profile);
        assert.equal(harmless.md, 'x \\< y 且 温度\\<中值 且 a\\<\\<b', profile);
        assert.equal(plainText(harmless.ir), 'x < y 且 温度<中值 且 a<<b', profile);
    }
});

test('各 profile 全链路：尖括号包起来的邮箱与网址不再被自动链接吞掉尖括号', async () => {
    // Act & Assert：micromark 的邮箱自动链接首字符可为数字与多种标点，无法按后随字符放行
    for (const profile of ALL_PROFILES) {
        const { ir } = await toIr('<p>邮箱 &lt;12345@qq.com&gt; 与 &lt;http://example.com/a&gt;</p>', profile);

        // 只断言文本：GFM 仍会把其中的裸邮箱与裸网址另行识别为 link 节点，尖括号本身须逐字保留
        assert.equal(plainText(ir), '邮箱 <12345@qq.com> 与 <http://example.com/a>', profile);
    }
});

test('各 profile 全链路：可构成字符引用的「&」转义为 \\&，实体写法逐字进入 IR', async () => {
    // Act & Assert：命名引用与数值引用（十进制、十六进制）都会被 micromark 解码，须先转义
    for (const profile of ALL_PROFILES) {
        const named = await toIr('<p>见&amp;lt;与&amp;amp;</p>', profile);
        assert.equal(named.md, '见\\&lt;与\\&amp;', profile);
        assert.equal(plainText(named.ir), '见&lt;与&amp;', profile);

        const numeric = await toIr('<p>&amp;#60; 与 &amp;#x3C; 与 &amp;copy;</p>', profile);
        assert.equal(plainText(numeric.ir), '&#60; 与 &#x3C; 与 &copy;', profile);
    }
});

test('各 profile 全链路：不构成字符引用的「&」不转义，裸网址的查询串不多出反斜杠', async () => {
    // Act & Assert：GFM autolink literal 内部的反斜杠是字面量，一律转义会把它写进链接地址与文本
    for (const profile of ALL_PROFILES) {
        const source = 'AT&T 与 R&D，网址 http://example.com/?a=1&b=2 结束';
        const plain = await toIr('<p>AT&amp;T 与 R&amp;D，网址 http://example.com/?a=1&amp;b=2 结束</p>', profile);
        assert.equal(plain.md, source, profile);
        assert.ok(!plain.md.includes('\\'), `${profile}: ${plain.md}`);
        assert.equal(collect(plain.ir, (n) => n.type === 'link')[0].url, 'http://example.com/?a=1&b=2', profile);

        // Assert：「&」后随空白时不可能构成字符引用
        assert.equal(toMarkdown('<p>甲 &amp; 乙</p>', profile), '甲 & 乙', profile);

        // Assert：引用名长度以 micromark 的 characterReferenceNamedSizeMax 为界，31 个字母数字转义、32 个不转义
        const atLimit = await toIr('<p>&amp;CounterClockwiseContourIntegral;</p>', profile);
        assert.equal(atLimit.md, '\\&CounterClockwiseContourIntegral;', profile);
        assert.equal(plainText(atLimit.ir), '&CounterClockwiseContourIntegral;', profile);
        assert.equal(toMarkdown('<p>&amp;CounterClockwiseContourIntegralX;</p>', profile), '&CounterClockwiseContourIntegralX;', profile);

        // Assert：分号可能落在下一个文本节点里，故文本节点末尾的「&」从严按可能构成处理
        const tail = await toIr('<p>Q&amp;A</p>', profile);
        assert.equal(tail.md, 'Q\\&A', profile);
        assert.equal(plainText(tail.ir), 'Q&A', profile);
    }
});

test('各 profile 全链路：字面反斜杠已被加倍时不重复转义「<」与「&」', async () => {
    // Arrange：HTML 文本为「甲\<b>乙\&lt;丙」，turndown 自身会先把字面反斜杠加倍
    for (const profile of ALL_PROFILES) {
        // Act
        const { md, ir } = await toIr('<p>甲\\&lt;b&gt;乙\\&amp;lt;丙</p>', profile);

        // Assert：前导反斜杠为偶数个（已加倍），仍须补一个转义反斜杠
        assert.equal(md, '甲\\\\\\<b>乙\\\\\\&lt;丙', profile);
        assert.equal(plainText(ir), '甲\\<b>乙\\&lt;丙', profile);
    }
});

test('各 profile 全链路：「&」与「<」按文本节点边界从严转义，跨节点拼出的实体与标签不成立', async () => {
    // Act & Assert：escape 逐文本节点调用，「&」与其后的「lt;」分处两个节点时仍须转义
    for (const profile of ALL_PROFILES) {
        const { ir } = await toIr('<p>&amp;<span>lt;</span> 与 a&lt;<span>b&gt;c</span> 与 &amp;am<span>p;</span></p>', profile);

        assert.equal(plainText(ir), '&lt; 与 a<b>c 与 &amp;', profile);
    }
});

test('url profile 全链路：零宽字符被 normalizeMarkdown 删除后，跨零宽拼出的实体与标签仍不成立', async () => {
    // Arrange：parsers/url 在 turndown 之后、remark 之前删零宽字符，判定时须视零宽字符为不存在
    const cases = [
        [`<p>&amp;${ZERO_WIDTH_SPACE}lt;</p>`, '&lt;'],
        [`<p>&amp;l${ZERO_WIDTH_SPACE}t;</p>`, '&lt;'],
        [`<p>&lt;${ZERO_WIDTH_SPACE}b&gt;粗&lt;/b&gt;</p>`, '<b>粗</b>'],
    ];

    // Act & Assert
    for (const [html, expected] of cases) {
        const { ir } = await toIrNormalized(html);
        assert.equal(plainText(ir), expected, html);
        assert.deepEqual(htmlNodes(ir), [], html);
    }
});

test('表格单元格：「<」与「&」被转义，标签与实体写法逐字进入 IR', async () => {
    // Arrange：标签写法、实体写法，以及与竖线转义相邻的标签写法
    const html = tableOf('a&lt;b&gt;c', '见&amp;lt;与&amp;amp;', '&lt;b&gt;|&lt;/b&gt;');

    // Act & Assert：表格规则挂在 word 与 url 两个 profile 上，行为应一致
    for (const profile of PROFILES_WITH_TABLE) {
        const { md, ir } = await toIr(html, profile);
        const lines = md.split('\n');

        // Assert：Markdown 数据行逐字符相符（竖线转义补在 escape 之后，反斜杠不互相吞并）
        assert.equal(lines[2], '| a\\<b>c |', profile);
        assert.equal(lines[3], '| 见\\&lt;与\\&amp; |', profile);
        assert.equal(lines[4], '| \\<b>\\|\\</b> |', profile);

        // Assert：全链路后各单元格文本与源文本逐字相等
        assert.deepEqual(
            rowCells(ir),
            [['项'], ['a<b>c'], ['见&lt;与&amp;'], ['<b>|</b>']],
            profile,
        );

        // Assert：既不生成 html 节点，也不被误解析出行内节点
        assert.deepEqual(htmlNodes(ir), [], profile);
        for (const type of INLINE_TYPES) {
            assert.deepEqual(textsOfType(ir, type), [], `${profile} 不应出现 ${type} 节点`);
        }
    }
});

test('图片 alt：「<」与「&」被转义，标签与实体写法逐字进入 IR', async () => {
    // Act & Assert：内置 image 规则为三个 profile 共用，alt 规则同样覆盖三者
    for (const profile of ALL_PROFILES) {
        const entity = await toIr('<p><img src="a.png" alt="见&amp;lt;与&amp;amp;"></p>', profile);
        assert.equal(entity.md, '![见\\&lt;与\\&amp;](a.png)', profile);
        assert.equal(firstImage(entity.ir).alt, '见&lt;与&amp;', profile);

        // Assert：alt 内的尖括号网址不再被当作自动链接、尖括号不丢
        const autolink = await toIr('<p><img src="a.png" alt="&lt;http://a.com/x&gt;"></p>', profile);
        assert.equal(firstImage(autolink.ir).alt, '<http://a.com/x>', profile);

        // Assert：alt 内的半截标签原本会吃掉后文、整张图片随之丢失
        const halfTag = await toIr('<p><img src="a.png" alt="a &lt;b title=&quot;"> 之后 "&gt; 末尾</p>', profile);
        const images = collect(halfTag.ir, (n) => n.type === 'image');
        assert.equal(images.length, 1, profile);
        assert.equal(images[0].alt, 'a <b title="', profile);

        // Assert：回归防护，mdast 取 alt 时本就保留 html 片段原文，转义后仍逐字相等
        const tag = await toIr('<p><img src="a.png" alt="a&lt;b&gt;c"></p>', profile);
        assert.equal(firstImage(tag.ir).alt, 'a<b>c', profile);
    }
});

test('word profile 全链路：有意输出的 <u>/<sup>/<sub> 仍被提升，其中文本的「<」「&」照常转义', async () => {
    // Act
    const { md, ir } = await toIr('<p>R<sup>a&lt;b</sup>、<u>下&amp;lt;线</u>、C<sub>x&lt;y</sub></p>', 'word');

    // Assert：规则 replacement 拼出的标签不经 escape，标签内的文本经 escape
    assert.equal(md, 'R<sup>a\\<b</sup>、<u>下\\&lt;线</u>、C<sub>x\\<y</sub>');
    assert.deepEqual(textsOfType(ir, 'superscript'), ['a<b']);
    assert.deepEqual(textsOfType(ir, 'underline'), ['下&lt;线']);
    assert.deepEqual(textsOfType(ir, 'subscript'), ['x<y']);
    assert.deepEqual(htmlNodes(ir), []);
});

test('url profile 全链路：有意输出的行内 HTML 仍被提升，其中文本的「<」「&」照常转义', async () => {
    // Act
    const { ir } = await toIr('<p><strong>粗&lt;em&gt;</strong>、<em>斜&amp;amp;</em>、<del>删&lt;s&gt;</del>、R<sup>a&lt;b</sup>、C<sub>x&lt;y</sub></p>', 'url');

    // Assert：文本中的标签写法不再与规则拼出的真标签混淆，配对关系不被打乱
    assert.deepEqual(textsOfType(ir, 'strong'), ['粗<em>']);
    assert.deepEqual(textsOfType(ir, 'emphasis'), ['斜&amp;']);
    assert.deepEqual(textsOfType(ir, 'delete'), ['删<s>']);
    assert.deepEqual(textsOfType(ir, 'superscript'), ['a<b']);
    assert.deepEqual(textsOfType(ir, 'subscript'), ['x<y']);
    assert.deepEqual(htmlNodes(ir), []);

    // Assert：回归防护，imgDisplay 规则的属性值走 escapeAttr，不受转义链影响
    const display = await toIr('<p><img src="a.png" alt="a&lt;b&amp;lt;" data-mf-display="320"></p>', 'url');
    assert.equal(display.md, '<img src="a.png" alt="a&lt;b&amp;lt;" width="320">');
    assert.equal(firstImage(display.ir).alt, 'a<b&lt;');
});

test('代码内的「<」与「&」不转义（回归防护：turndown 不对 code 调 escape）', async () => {
    // Act
    const { md, ir } = await toIr('<p><code>&lt;b&gt; &amp;amp;</code></p>');

    // Assert
    assert.equal(md, '`<b> &amp;`');
    assert.deepEqual(textsOfType(ir, 'inlineCode'), ['<b> &amp;']);
});

test('上游已转义的「<」与「&」不重复转义：按前导反斜杠的奇偶判定', () => {
    // Arrange：把 turndown 自身的 escape 换成「只转义 < 与 &」的版本，模拟上游已转义的情形
    const original = TurndownService.prototype.escape;
    try {
        TurndownService.prototype.escape = (text) => text.replace(/[<&]/g, '\\$&');
        const service = createTurndownService('url');

        // Act & Assert：前导反斜杠为奇数个即视为已转义，原样保留；不判奇偶会得到 a\\<b，反斜杠自成一对、「<」重新裸露
        assert.equal(service.escape('a<b 与 &lt;'), 'a\\<b 与 \\&lt;');
    } finally {
        TurndownService.prototype.escape = original;
    }
});

test('「<」与「&」的转义耗时随长度线性增长，对抗性输入不触发回溯', () => {
    // Arrange：字符引用判定最易退化的几类输入（连续起点、超长扫描区间、零宽字符穿插），以及只由反斜杠组成的串
    //（内置转义先把它加倍为 40 万个，分词正则须把整段一次取走，不逐位回溯）
    const zeroWidthRun = `&${ZERO_WIDTH_SPACE.repeat(100)}`;
    const inputs = [
        '\\'.repeat(STRESS_LENGTH),
        '<'.repeat(STRESS_LENGTH),
        '&'.repeat(STRESS_LENGTH),
        '&a'.repeat(STRESS_LENGTH / 2),
        `&${'a'.repeat(STRESS_LENGTH)}`,
        `&${ZERO_WIDTH_SPACE.repeat(STRESS_LENGTH)}`,
        zeroWidthRun.repeat(Math.floor(STRESS_LENGTH / zeroWidthRun.length)),
    ];
    const service = createTurndownService('url');

    // Act & Assert
    for (const input of inputs) {
        const startedAt = Date.now();
        service.escape(input);
        const elapsed = Date.now() - startedAt;
        assert.ok(elapsed < STRESS_LIMIT_MS, `长度 ${input.length} 的输入耗时 ${elapsed}ms`);
    }
});
