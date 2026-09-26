/**
 * converters/web/whitespace.js 单元测试
 *
 * 被测函数 capWhitespaceRuns 在 url 管线进入 turndown 之前就地截断 DOM 中的超长连续空白，
 * 用以避开 turndown 7.2.4 postProcess 的 /[\t\r\n\s]+$/ 在长空白串上的平方级回溯。
 *
 * 覆盖四类语义：① 属性值逐段独立截断；② 文本节点按「是否可被 turndown 折叠」区分成本；
 * ③ 跨文本节点累计（相邻的空白在输出里会并成一段，逐节点各自截断挡不住）；
 * ④ 不产出任何可见字符的子树既不计数也不清零——只有 template 与 turndown 移除的标签属此列，
 *    表格的 caption 不在其中：表题文字由表格规则输出为独立段落，照常计数与清零。另有两条回归用例：常规文档零改动，
 * 以及截断后经真实 turndown('url') 转换，输出中最长的空白段不超过上限。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const { capWhitespaceRuns, MAX_WHITESPACE_RUN } = require('../converters/web/whitespace');
const { createTurndownService, URL_REMOVED_TAGS } = require('../converters/ir/turndown');

// 不可见字符以码点生成，源码不出现看不见的字面量（与仓库既有测试同一约定）
const NBSP = String.fromCharCode(0x00a0);
const IDEO = String.fromCharCode(0x3000);
// 载荷长度取上限之上一截，足以看出截断又不拖慢用例
const OVER_LIMIT = 300;

// 片段载入 → 就地截断 → 返回 cheerio 根
function cap(html, droppedTags) {
    const $ = cheerio.load(html, null, false);
    capWhitespaceRuns($, droppedTags);
    return $;
}

// 文本中最长的一段连续空白的长度
function longestRun(text) {
    const runs = String(text == null ? '' : text).match(/\s+/g) || [];
    return runs.reduce((max, run) => Math.max(max, run.length), 0);
}

// 文本中某个字符出现的总次数
function countOf(text, char) {
    return String(text == null ? '' : text).split(char).length - 1;
}

// ============================================================
// 属性值：逐段独立截断
// ============================================================

test('属性值：alt、title、href、src 中超长空白截为上限', () => {
    // Arrange
    const run = ' '.repeat(OVER_LIMIT);
    const html = `<p><a href="/p?q=h${run}h" title="t${run}t">`
        + `<img src="/i.png?q=s${run}s" alt="a${run}a"></a></p>`;

    // Act
    const $ = cap(html);

    // Assert
    assert.equal(longestRun($('img').attr('alt')), MAX_WHITESPACE_RUN);
    assert.equal(longestRun($('img').attr('src')), MAX_WHITESPACE_RUN);
    assert.equal(longestRun($('a').attr('href')), MAX_WHITESPACE_RUN);
    assert.equal(longestRun($('a').attr('title')), MAX_WHITESPACE_RUN);
});

test('属性值：以字符引用写入的空白同样截断，不换行空格与普通空格一视同仁', () => {
    // Arrange
    const html = `<p><img src="/i.png" alt="a${'&#32;'.repeat(OVER_LIMIT)}a" `
        + `title="t${'&nbsp;'.repeat(OVER_LIMIT)}t"></p>`;

    // Act
    const $ = cap(html);

    // Assert
    assert.equal(longestRun($('img').attr('alt')), MAX_WHITESPACE_RUN);
    assert.equal(countOf($('img').attr('title'), NBSP), MAX_WHITESPACE_RUN);
});

test('属性值：同一值内的多段空白各自独立截断，互不累计', () => {
    // Arrange：两段之间隔着可见字符，输出里不会并成一段
    const run = ' '.repeat(OVER_LIMIT);
    const html = `<p><img src="/i.png" alt="a${run}b${run}c"></p>`;

    // Act
    const $ = cap(html);

    // Assert
    const alt = $('img').attr('alt');
    assert.equal(longestRun(alt), MAX_WHITESPACE_RUN);
    assert.equal(countOf(alt, ' '), MAX_WHITESPACE_RUN * 2);
});

test('属性值：不超过上限的空白逐字不动（alt 的行内制表符与连续空格照旧保留）', () => {
    // Arrange：与 test/turndown.test.js 的 alt 逐字保留用例同一样例
    const alt = '甲\t\t乙   丙~丁~';

    // Act
    const $ = cap(`<p><img src="/i.png" alt="${alt}"></p>`);

    // Assert
    assert.equal($('img').attr('alt'), alt);
});

// ============================================================
// 文本节点：可折叠与不可折叠的成本不同
// ============================================================

test('文本：不换行空格与全角空格属不可折叠空白，超长即截为上限', () => {
    // Act
    const nbsp = cap(`<p>甲x${NBSP.repeat(OVER_LIMIT)}y乙</p>`);
    const ideo = cap(`<p>甲x${IDEO.repeat(OVER_LIMIT)}y乙</p>`);

    // Assert
    assert.equal(countOf(nbsp('p').text(), NBSP), MAX_WHITESPACE_RUN);
    assert.equal(countOf(ideo('p').text(), IDEO), MAX_WHITESPACE_RUN);
});

test('文本：pre 内的 ASCII 空格原样进入输出，故截为上限', () => {
    // Act
    const $ = cap(`<pre><code>x${' '.repeat(OVER_LIMIT)}y</code></pre>`);

    // Assert
    assert.equal(countOf($('code').text(), ' '), MAX_WHITESPACE_RUN);
});

test('文本：pre 之外的 ASCII 空白会被 turndown 折叠成一个空格，整段逐字保留', () => {
    // Act
    const $ = cap(`<p>甲x${' '.repeat(OVER_LIMIT)}y乙</p>`);

    // Assert
    assert.equal(countOf($('p').text(), ' '), OVER_LIMIT);
});

// ============================================================
// 跨文本节点累计
// ============================================================

test('跨节点：逐个不换行空格分散在 300 个元素里，合计仍截为上限', () => {
    // Act
    const $ = cap(`<p>甲x${'<i>&nbsp;</i>'.repeat(OVER_LIMIT)}y乙</p>`);

    // Assert
    assert.equal(countOf($('p').text(), NBSP), MAX_WHITESPACE_RUN);
});

test('跨节点：不产出内容的 void 元素隔开的单空格逐个累计，合计截为上限', () => {
    // Arrange：<wbr> 不产出字符，其后的空格不会与相邻段合并，会逐个进入输出

    // Act
    const $ = cap(`<p>甲x${'<wbr> '.repeat(OVER_LIMIT)}y乙</p>`);

    // Assert
    assert.equal(countOf($('p').text(), ' '), MAX_WHITESPACE_RUN);
});

test('跨节点：中间出现可见字符即清零，两侧各 200 个不换行空格全部保留', () => {
    // Act
    const $ = cap(`<p>甲${NBSP.repeat(200)}x${NBSP.repeat(200)}乙</p>`);

    // Assert
    assert.equal(countOf($('p').text(), NBSP), 400);
});

// ============================================================
// 不产出可见字符的子树：既不计数也不清零
// ============================================================

test('跳过子树：被 turndown 移除的标签内的文字不清零，两侧空白合计截为上限', () => {
    // Arrange：script 内的 x 不进入输出，两段不换行空格在输出里会并成一段
    const html = `<p>甲${NBSP.repeat(200)}<script>x</script>${NBSP.repeat(200)}乙</p>`;

    // Act
    const $ = cap(html, URL_REMOVED_TAGS);

    // Assert
    assert.equal(countOf($('p').text(), NBSP), MAX_WHITESPACE_RUN);
});

test('跳过子树：template 无须传参即被跳过', () => {
    // Act
    const tpl = cap(`<p>甲${NBSP.repeat(200)}<template>x</template>${NBSP.repeat(200)}乙</p>`);

    // Assert
    assert.equal(countOf(tpl.root().text(), NBSP), MAX_WHITESPACE_RUN);
});

test('caption 不属被跳过的子树：表题的可见文字照常清零，两侧各 200 个不换行空格全部保留', () => {
    // Arrange：表题文字由表格规则输出为紧邻表格之前的独立段落，会进入 turndown 输出
    const html = `<p>甲${NBSP.repeat(200)}</p><table><caption>x</caption></table>`
        + `<p>${NBSP.repeat(200)}乙</p>`;

    // Act
    const $ = cap(html);

    // Assert
    assert.equal(countOf($.root().text(), NBSP), 400);
});

test('caption 内的超长不可折叠空白照常截为上限', () => {
    // Act
    const $ = cap(`<table><caption>甲x${NBSP.repeat(OVER_LIMIT)}y乙</caption><tr><td>a</td></tr></table>`);

    // Assert
    assert.equal(countOf($('caption').text(), NBSP), MAX_WHITESPACE_RUN);
});

test('跳过子树：未把 script 列为移除标签时，其内文字照常清零', () => {
    // Act
    const $ = cap(`<p>甲${NBSP.repeat(200)}<script>x</script>${NBSP.repeat(200)}乙</p>`);

    // Assert
    assert.equal(countOf($('p').text(), NBSP), 400);
});

test('跳过子树：被跳过的子树内部一个字符都不改', () => {
    // Arrange
    const inner = `x${' '.repeat(OVER_LIMIT)}y`;

    // Act
    const $ = cap(`<p>甲<script title="t${' '.repeat(OVER_LIMIT)}t">${inner}</script>乙</p>`, URL_REMOVED_TAGS);

    // Assert
    assert.equal($('script').text(), inner);
    assert.equal(countOf($('script').attr('title'), ' '), OVER_LIMIT);
});

// ============================================================
// 回归：常规文档零改动
// ============================================================

test('常规文档一个字符都不改', () => {
    // Arrange
    const html = '<h2>小标题</h2>'
        + `<p style="text-indent:2em">${IDEO}${IDEO}首段正文，段首用全角空格缩进。</p>`
        + '<ul>\n  <li>条目一</li>\n  <li>条目二</li>\n</ul>'
        + '<pre><code>function add(a, b) {\n    return a + b;\n}</code></pre>'
        + '<p><img src="/i.png" alt="示意图" title="图 1"></p>'
        + '<p>末段正文，含<a href="/next?q=1">链接</a>与<strong>加粗</strong>。</p>';
    const $ = cheerio.load(html, null, false);
    const before = $.html();

    // Act
    capWhitespaceRuns($, URL_REMOVED_TAGS);

    // Assert
    assert.equal($.html(), before);
});

// ============================================================
// 回归：截断后经真实 turndown 转换，输出的空白段有确定上界
// ============================================================

// 块之间的两个换行可能与段尾空白相连，故上界为上限加 2
const OUTPUT_RUN_LIMIT = MAX_WHITESPACE_RUN + 2;
// 对抗形态的规模：取 2000 已远超上限，同时保持用例在毫秒量级
const ADVERSARIAL_N = 2000;

const ADVERSARIAL_CASES = [
    ['alt 空格', `<p>图<img src="/i.png" alt="x${' '.repeat(ADVERSARIAL_N)}y">后</p>`],
    ['title 空格', `<p>图<img src="/i.png" alt="x" title="x${' '.repeat(ADVERSARIAL_N)}y">后</p>`],
    ['文本 不换行空格', `<p>甲x${NBSP.repeat(ADVERSARIAL_N)}y乙</p>`],
    ['文本 全角空格', `<p>甲x${IDEO.repeat(ADVERSARIAL_N)}y乙</p>`],
    ['pre 空格', `<pre><code>x${' '.repeat(ADVERSARIAL_N)}y</code></pre>`],
    ['逐个不换行空格', `<p>甲x${'<i>&nbsp;</i>'.repeat(ADVERSARIAL_N)}y乙</p>`],
    ['void 元素隔开的空格', `<p>甲x${'<wbr> '.repeat(ADVERSARIAL_N)}y乙</p>`],
    ['不换行空格与 script 交替', `<p>甲x${`${NBSP}<script>s</script>`.repeat(ADVERSARIAL_N)}y乙</p>`],
    ['不换行空格与 ASCII 空格交替', `<p>甲x${`${NBSP} `.repeat(ADVERSARIAL_N)}y乙</p>`],
    ['caption 内不换行空格', `<table><caption>甲x${NBSP.repeat(ADVERSARIAL_N)}y乙</caption><tr><td>a</td></tr></table>`],
    [
        '纯空白 caption 夹在两段之间',
        `<p>甲x${NBSP.repeat(ADVERSARIAL_N)}</p><table><caption>${NBSP.repeat(ADVERSARIAL_N)}</caption></table>`
        + `<p>${NBSP.repeat(ADVERSARIAL_N)}y乙</p>`,
    ],
];

for (const [name, html] of ADVERSARIAL_CASES) {
    test(`截断后 turndown 输出的最长空白段不超过上限：${name}`, () => {
        // Arrange
        const $ = cheerio.load(html, null, false);

        // Act
        capWhitespaceRuns($, URL_REMOVED_TAGS);
        const markdown = createTurndownService('url').turndown($.html());

        // Assert
        const longest = longestRun(markdown);
        assert.ok(
            longest <= OUTPUT_RUN_LIMIT,
            `最长空白段为 ${longest}，应不超过 ${OUTPUT_RUN_LIMIT}`,
        );
    });
}
