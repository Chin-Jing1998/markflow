/**
 * converters/ir/turndown.js（url profile）：零宽字符之后的行首记号未转义，删去零宽字符后被解析为块结构
 * 成因：turndown 7.2.4 的转义表里有七条以 ^ 锚定的规则（^-、^\+ 、^(=+)、^(#{1,6}) 、^~~~、^>、^(\d+)\. ），锚定的是
 * escape 的入参即单个文本节点的开头。文本节点以零宽字符开头时七条都不命中，其后的记号原样输出；parsers/url 随后由
 * normalizeMarkdown 删去零宽字符，记号落在段首或硬换行之后的行首，remark 把它解析为引用块、列表、标题、分隔线或 setext
 * 标题。例如修复前（4a2de9a）「<p>（U+200B）&gt; 甲</p>」解析为引用块「甲」，「<p>甲<br>（U+200D）&gt;乙</p>」解析为段落
 * 「甲\」与引用块「乙」。零宽字符把其后的空格与不换行空格一并挡在 turndown 的空白折叠之外，二者删去零宽字符、归一为
 * 空格后成为行首缩进，缩进不超过 3 列时记号照样生效。七条中只有 ^~~~ 不受影响：工厂层的 escapeTildes 把文本中的每个
 * 「~」都转义为 \~。
 * 修法：url profile 包装 service.escape，文本节点以「零宽字符、半角空格、不换行空格」组成的前导段开头、且该段含零宽
 * 字符时，前导段原样保留，其余部分交上游转义，七条行首规则由此锚定在记号上；前导段的空格与不换行空格合计超过 3 个时
 * 不改（此时该行至多是缩进代码块，记号不起作用，补上的反斜杠反而成为代码文本）。
 * 覆盖：
 *   - 已列形态：21 种（「>」的两例原始复现；其余五条失效规则共六例：「- 」「---」「+ 」「===」「# 」「1. 」；~~~ 的对照；
 *     零宽字符后隔空格、隔不换行空格、隔三个不换行空格与夹空格的两个零宽字符；void 元素后的空格与零宽字符；列表项、引用块、
 *     section 内；字符引用写法；空元素之后；两个零宽字符；行中文本），逐字断言 Markdown 产物，并断言全链路解析后的块结构
 *     与文本。
 *   - 端到端：经 parsers/url 的 parse() 抓取本机页面（站点选择器取正文），断言 IR 的块结构与文本，并断言 md 渲染器的产物
 *     重新解析后仍为同样数目的段落。
 *   - 矩阵：11 种记号写法 × 13 种前缀 × 9 种语境，共 1287 例，全链路解析后的块结构与文本（略去空白与零宽字符）等于同语境
 *     无前缀的对照。
 *   - 回归护栏：不以零宽字符开头的文本、前导段空格超过 3 个、行内代码内的文本，Markdown 产物逐字等于修复前的产物；
 *     word 与 basic profile 的产物不变。
 *   - 种子随机：固定种子生成 1200 个样本，前缀为 1–5 个零宽字符、半角空格与不换行空格的随机排列（至少一个零宽字符，空格
 *     合计不超过 3 个，无序与有序列表项内分别不超过 1 个与 2 个，理由见「已知表现」），接随机记号与后续文本，放入随机
 *     语境，一段内可有两处；块结构与文本等于去掉前缀的对照。
 * 断言口径：全链路为 turndown('url') → collapseBreakMarkers → normalizeMarkdown → remark-parse + remark-gfm →
 * liftInlineHtml → restoreMarkers，与 parsers/url 的调用同序（端到端用例另含正文提取、cleanNoise 与 preprocessHtml）。
 * 块结构取节点类型、标题级别与列表是否有序，文本略去空白与零宽字符后比对。
 * 范围外（修复前后表现相同）：
 *   - 零宽字符夹在记号内部（「#（U+200B）# 甲」「1.（U+200B） 甲」「+（U+200B） 甲」）：记号本身被拆开，上游规则不命中；
 *   - 单个不换行空格后接记号（不含零宽字符）：不换行空格经 normalizeMarkdown 归一为空格后成为 1 列缩进；
 *   - 零宽字符隔开的空格合计达 4 个以上：删去零宽字符后成为缩进代码块，与记号无关；
 *   - 空元素把记号拆到两个文本节点（「1<b></b>. 甲」）、void 元素后保留的空格之后接记号（「<img> &gt; 甲」）、
 *     「1) 甲」、记号独占到行尾（「<p>12.  </p>」的空格被块尾折叠删去，上游规则要求记号后有空格）：均与零宽字符无关，
 *     属上游转义表本身的缺口。
 * 已知表现：列表项首行里 turndown 已在记号后写了 3 个（无序）或 2 个（有序）空格，前缀的空格再使记号后的空格合计达 5 个
 * 以上时，删去零宽字符后该项以缩进代码块开头（与「零宽字符隔开的空格合计达 4 个以上」同类，修复前即如此）；前缀的空格
 * 不超过 3 个时本修复照常补反斜杠，该反斜杠随之成为代码文本。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createTurndownService } = require('../converters/ir/turndown');
const { liftInlineHtml } = require('../converters/ir/inline-html');
const { restoreMarkers } = require('../converters/ir/markers');
const { loadUnified } = require('../converters/ir/unified-loader');
const { normalizeMarkdown } = require('../converters/web/normalize');
const { parse, collapseBreakMarkers } = require('../converters/parsers/url');
const { _setLookup } = require('../converters/net/fetch-guard');
const mdRenderer = require('../converters/renderers/md');

// 不可见字符与反斜杠一律以码点生成，源码中不出现转义序列与不可见字面量
const fromCode = (code) => String.fromCharCode(code);
const ZWSP = fromCode(0x200b);
const ZWNJ = fromCode(0x200c);
const ZWJ = fromCode(0x200d);
const WJ = fromCode(0x2060);
const BOM = fromCode(0xfeff);
const NBSP = fromCode(0x00a0);
const BACKSLASH = fromCode(92);
const BR_MARKER = fromCode(0xef03);
const ZERO_WIDTHS = [ZWSP, ZWNJ, ZWJ, WJ, BOM];
const MAX_REPORTED = 10;

// ============================================================
// 转换与块结构
// ============================================================

const toMarkdown = (html, profile = 'url') => createTurndownService(profile).turndown(html);

/** 全链路：与 parsers/url 的 turndown 之后各步同序 */
async function toIr(html) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    const markdown = normalizeMarkdown(collapseBreakMarkers(toMarkdown(html)));
    return restoreMarkers(liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(markdown), { source: 'web' }));
}

const INVISIBLE = new Set(ZERO_WIDTHS);
const squeeze = (value) => Array.from(String(value)).filter((ch) => !/\s/.test(ch) && !INVISIBLE.has(ch)).join('');

/**
 * 块结构：节点类型、标题级别、列表是否有序与子节点；text 取略去空白与零宽字符后的值，相邻 text 合并，
 * 合并后为空的 text 略去（前缀里的空格在不同语境下或留或删，不影响结构判定）
 */
function shapeOf(node) {
    if (node.type === 'text') return squeeze(node.value);
    const out = [node.type];
    if (node.depth !== undefined) out.push(`h${node.depth}`);
    if (node.ordered !== undefined) out.push(node.ordered ? 'ol' : 'ul');
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') out.push(node.value);
    const children = [];
    for (const child of node.children || []) {
        const shaped = shapeOf(child);
        if (typeof shaped === 'string') {
            if (!shaped) continue;
            if (typeof children[children.length - 1] === 'string') children[children.length - 1] += shaped;
            else children.push(shaped);
        } else children.push(shaped);
    }
    if (children.length) out.push(children);
    return out;
}

const shapeKey = async (html) => JSON.stringify(shapeOf(await toIr(html)));

function reportFailures(failures, total) {
    assert.equal(failures.length, 0, `${failures.length}/${total} 例失败，前 ${MAX_REPORTED} 例：\n${failures.slice(0, MAX_REPORTED).join('\n')}`);
}

// ============================================================
// 已列形态
// ============================================================

// [名称, HTML, 期望 Markdown, 期望块结构（JSON）]
const P = (...children) => ['root', [['paragraph', children]]];
const LISTED_FORMS = [
    ['原始复现：段首零宽字符后接「> 」', `<p>${ZWSP}&gt; 甲</p>`, `${ZWSP}${BACKSLASH}> 甲`, P('>甲')],
    ['原始复现：硬换行后零宽字符后接「>」', `<p>甲<br>${ZWJ}&gt;乙</p>`, `甲${BR_MARKER}${ZWJ}${BACKSLASH}>乙`, P('甲', ['break'], '>乙')],
    ['「- 」列表记号', `<p>${ZWSP}- 甲</p>`, `${ZWSP}${BACKSLASH}- 甲`, P('-甲')],
    ['硬换行后的「---」（setext 二级标题的下划线）', `<p>甲<br>${ZWSP}---</p>`, `甲${BR_MARKER}${ZWSP}${BACKSLASH}---`, P('甲', ['break'], '---')],
    ['「+ 」列表记号', `<p>${WJ}+ 甲</p>`, `${WJ}${BACKSLASH}+ 甲`, P('+甲')],
    ['硬换行后的「===」（setext 一级标题的下划线）', `<p>甲<br>${BOM}===</p>`, `甲${BR_MARKER}${BOM}${BACKSLASH}===`, P('甲', ['break'], '===')],
    ['「# 」标题记号', `<p>${ZWNJ}# 甲</p>`, `${ZWNJ}${BACKSLASH}# 甲`, P('#甲')],
    ['「1. 」有序列表记号', `<p>${ZWSP}1. 甲</p>`, `${ZWSP}1${BACKSLASH}. 甲`, P('1.甲')],
    ['对照：「~~~」围栏（工厂层已逐个转义「~」，修复前后相同）', `<p>${ZWSP}~~~</p>`,
        `${ZWSP}${BACKSLASH}~${BACKSLASH}~${BACKSLASH}~`, P('~~~')],
    ['零宽字符后隔一个空格', `<p>${ZWSP} &gt; 甲</p>`, `${ZWSP} ${BACKSLASH}> 甲`, P('>甲')],
    ['零宽字符后隔不换行空格', `<p>${ZWSP}&nbsp;- 甲</p>`, `${ZWSP}${NBSP}${BACKSLASH}- 甲`, P('-甲')],
    ['void 元素后的空格与零宽字符', `<p><img> ${ZWSP}# 甲</p>`, ` ${ZWSP}${BACKSLASH}# 甲`, P('#甲')],
    ['列表项内', `<ul><li>${ZWSP}&gt; 甲</li></ul>`, `-   ${ZWSP}${BACKSLASH}> 甲`, ['root', [['list', 'ul', [['listItem', [['paragraph', ['>甲']]]]]]]]],
    ['引用块内', `<blockquote><p>${ZWSP}- 甲</p></blockquote>`, `> ${ZWSP}${BACKSLASH}- 甲`, ['root', [['blockquote', [['paragraph', ['-甲']]]]]]],
    ['section 内（微信正文）', `<section>${ZWSP}12. 甲</section>`, `${ZWSP}12${BACKSLASH}. 甲`, P('12.甲')],
    ['字符引用写法', '<p>&#8203;&gt; 甲</p>', `${ZWSP}${BACKSLASH}> 甲`, P('>甲')],
    ['空元素之后', `<p><b></b>${BOM}+ 甲</p>`, `${BOM}${BACKSLASH}+ 甲`, P('+甲')],
    ['两个零宽字符', `<p>${ZWSP}${ZWJ}###### 甲</p>`, `${ZWSP}${ZWJ}${BACKSLASH}###### 甲`, P('######甲')],
    ['零宽字符、空格、零宽字符', `<p>${ZWSP} ${ZWJ}&gt; 甲</p>`, `${ZWSP} ${ZWJ}${BACKSLASH}> 甲`, P('>甲')],
    ['零宽字符后隔三个不换行空格（缩进 3 列，记号仍生效）', `<p>${ZWSP}&nbsp;&nbsp;&nbsp;&gt; 甲</p>`,
        `${ZWSP}${NBSP}${NBSP}${NBSP}${BACKSLASH}> 甲`, P('>甲')],
    ['行中文本（多转义一个反斜杠，IR 文本不变）', `<p>甲<b>乙</b>${ZWSP}- 丙</p>`, `甲<strong>乙</strong>${ZWSP}${BACKSLASH}- 丙`,
        P('甲', ['strong', ['乙']], '-丙')],
];

test('已列形态：零宽字符之后的行首记号逐一转义，全链路解析后仍为原段落文本', async () => {
    const failures = [];
    for (const [name, html, markdown, shape] of LISTED_FORMS) {
        // Act
        const actualMarkdown = toMarkdown(html);
        const actualShape = await shapeKey(html);

        // Assert（汇总后统一断言，每种形态至多记一条，失败时列出全部不符的形态）
        const problems = [];
        if (actualMarkdown !== markdown) problems.push(`Markdown ${JSON.stringify(actualMarkdown)}，期望 ${JSON.stringify(markdown)}`);
        if (actualShape !== JSON.stringify(shape)) problems.push(`块结构 ${actualShape}，期望 ${JSON.stringify(shape)}`);
        if (problems.length) failures.push(`${name}：${problems.join('；')}`);
    }
    reportFailures(failures, LISTED_FORMS.length);
});

// ============================================================
// 端到端：parsers/url 的 parse() 与 md 渲染器
// ============================================================

const E2E_BODY = [
    `<p>${ZWSP}&gt; 甲</p>`,
    `<p>乙<br>${ZWJ}&gt;丙</p>`,
    `<p>${ZWSP}- 丁</p>`,
    `<p>${BOM}1. 戊</p>`,
    `<section>${ZWSP}# 己</section>`,
].join('\n');
const E2E_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>行首记号</title></head><body><div id="js_content">${E2E_BODY}</div></body></html>`;

function startPageServer(html) {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            close: () => new Promise((done) => {
                server.closeAllConnections();
                server.close(() => done());
            }),
        }));
    });
}

test('端到端：网页正文中零宽字符之后的行首记号进入 IR 后仍是段落文本，md 渲染器的产物重新解析后不变', async (t) => {
    // Arrange：经 _setLookup 把 mp.weixin.qq.com 解析到本机，站点选择器按主机名命中，正文原样取出
    const server = await startPageServer(E2E_PAGE);
    t.after(() => server.close());
    _setLookup(async () => [{ address: '127.0.0.1', family: 4 }]);
    t.after(() => _setLookup(null));

    // Act
    const doc = await parse({ url: `http://mp.weixin.qq.com:${server.port}/mp.weixin.qq.com/s/line-start` }, { allowPrivateNetwork: true, skipImages: true });
    const md = await mdRenderer.render(doc);
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    const reparsed = unified().use(remarkParse).use(remarkGfm).parse(md);

    // Assert：IR 为 5 个段落（标题行为正文前补的文章标题），块结构与文本逐一相符
    const blocks = doc.ir.children.filter((node) => node.type !== 'heading');
    assert.deepEqual(blocks.map(shapeOf), [
        ['paragraph', ['>甲']],
        ['paragraph', ['乙', ['break'], '>丙']],
        ['paragraph', ['-丁']],
        ['paragraph', ['1.戊']],
        ['paragraph', ['#己']],
    ], JSON.stringify(doc.ir));
    // Assert：md 渲染器的产物重新解析后仍为同样的 5 个段落
    const reparsedBlocks = reparsed.children.filter((node) => node.type !== 'heading');
    assert.deepEqual(reparsedBlocks.map((node) => node.type), ['paragraph', 'paragraph', 'paragraph', 'paragraph', 'paragraph'], md);
});

// ============================================================
// 矩阵
// ============================================================

// 记号写法：[名称, HTML]；「===」「---」只在硬换行之后才可能成为 setext 标题的下划线，其余语境下作对照
const MATRIX_MARKERS = [
    ['> ', '&gt; 甲'], ['>', '&gt;甲'], ['- ', '- 甲'], ['---', '---'], ['+ ', '+ 甲'], ['===', '==='],
    ['# ', '# 甲'], ['###### ', '###### 甲'], ['~~~', '~~~'], ['1. ', '1. 甲'], ['12. ', '12. 甲'],
];
// 前缀：[名称, HTML]
const MATRIX_PREFIXES = [
    ['U+200B', ZWSP], ['U+200C', ZWNJ], ['U+200D', ZWJ], ['U+2060', WJ], ['U+FEFF', BOM],
    ['&#8203;', '&#8203;'], ['&#xFEFF;', '&#xFEFF;'], ['两个零宽字符', ZWSP + ZWJ], ['零宽字符 + 空格', `${ZWSP} `],
    ['零宽字符 + 空格 + 零宽字符', `${ZWSP} ${ZWJ}`], ['零宽字符 + 不换行空格', `${ZWSP}&nbsp;`],
    ['不换行空格 + 零宽字符', `&nbsp;${ZWSP}`], ['void 元素 + 空格 + 零宽字符', `<img> ${ZWSP}`],
];
// 语境：[名称, (前缀 + 记号) => HTML]
const MATRIX_CONTEXTS = [
    ['段首', (s) => `<p>${s}</p>`],
    ['硬换行后', (s) => `<p>甲<br>${s}</p>`],
    ['空元素后', (s) => `<p><b></b>${s}</p>`],
    ['无序列表项', (s) => `<ul><li>${s}</li></ul>`],
    ['有序列表项', (s) => `<ol><li>${s}</li></ol>`],
    ['引用块内', (s) => `<blockquote><p>${s}</p></blockquote>`],
    ['section', (s) => `<section>${s}</section>`],
    ['行中', (s) => `<p>甲<span>乙</span>${s}</p>`],
    ['表格单元格', (s) => `<table><tr><th>头</th></tr><tr><td>${s}</td></tr></table>`],
];

test('矩阵：11 种记号写法 × 13 种前缀 × 9 种语境，全链路解析后的块结构与文本等于无前缀的对照', async () => {
    const failures = [];
    let total = 0;
    for (const [ctxName, build] of MATRIX_CONTEXTS) {
        for (const [markName, mark] of MATRIX_MARKERS) {
            // Arrange：对照为同语境、无前缀的同一记号（上游转义表直接命中）
            const expected = await shapeKey(build(mark));
            for (const [prefixName, prefix] of MATRIX_PREFIXES) {
                total += 1;
                const html = build(`${prefix}${mark}`);

                // Act
                const actual = await shapeKey(html);

                // Assert（汇总）
                if (actual !== expected) failures.push(`${ctxName} / ${markName} / ${prefixName} / ${JSON.stringify(html)}：${actual}，期望 ${expected}`);
            }
        }
    }
    reportFailures(failures, total);
});

// ============================================================
// 回归护栏
// ============================================================

// [名称, HTML, 修复前后逐字相同的 Markdown 产物]
const GUARD_FORMS = [
    ['段首记号（上游直接转义）', '<p>&gt; 甲</p>', `${BACKSLASH}> 甲`],
    ['行中文本以半角空格开头', '<p>甲<b>乙</b> - 丙</p>', '甲<strong>乙</strong> - 丙'],
    ['零宽字符在文本中部', `<p>甲${ZWSP}&gt; 乙</p>`, `甲${ZWSP}> 乙`],
    ['零宽字符之后是普通文字', `<p>${ZWSP}甲 - 乙</p>`, `${ZWSP}甲 - 乙`],
    ['只含零宽字符的文本节点', `<p>${ZWSP}<b>乙</b></p>`, `${ZWSP}<strong>乙</strong>`],
    ['前导段的空格合计 4 个（删去零宽字符后为缩进代码块，不补反斜杠）', `<p>${ZWSP} ${ZWSP} ${ZWSP} ${ZWSP} &gt; 甲</p>`,
        `${ZWSP} ${ZWSP} ${ZWSP} ${ZWSP} > 甲`],
    ['前导段的空格与不换行空格合计 4 个', `<p>${ZWSP}&nbsp;&nbsp;&nbsp; - 甲</p>`, `${ZWSP}${NBSP}${NBSP}${NBSP} - 甲`],
    ['行内代码内的文本（不经转义）', `<p><code>${ZWSP}&gt; x</code></p>`, '`' + ZWSP + '> x`'],
    ['零宽字符后接反引号与星号（非行首规则，上游照常转义）', '<p>' + ZWSP + '`*甲*</p>', ZWSP + BACKSLASH + '`' + BACKSLASH + '*甲' + BACKSLASH + '*'],
];

test('回归护栏：不以零宽字符开头的文本、前导段空格超过 3 个与行内代码的产物逐字不变；word 与 basic profile 不受影响', () => {
    const failures = [];
    for (const [name, html, markdown] of GUARD_FORMS) {
        // Act
        const actual = toMarkdown(html);

        // Assert（汇总）
        if (actual !== markdown) failures.push(`${name}：${JSON.stringify(actual)}，期望 ${JSON.stringify(markdown)}`);
    }
    // word 与 basic profile：其管线不删除零宽字符，行首转义维持上游写法
    for (const profile of ['basic', 'word']) {
        for (const [html, markdown] of [[`<p>${ZWSP}&gt; 甲</p>`, `${ZWSP}> 甲`], [`<p>${ZWSP}- 甲</p>`, `${ZWSP}- 甲`]]) {
            const actual = toMarkdown(html, profile);
            if (actual !== markdown) failures.push(`${profile} profile：${JSON.stringify(actual)}，期望 ${JSON.stringify(markdown)}`);
        }
    }
    reportFailures(failures, GUARD_FORMS.length + 4);
});

// ============================================================
// 种子随机
// ============================================================

/** mulberry32：固定种子的伪随机数 */
function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const RANDOM_SEED = 20260927;
const RANDOM_COUNT = 1200;
const RANDOM_MARKERS = ['&gt; ', '&gt;', '- ', '---', '+ ', '===', '# ', '## ', '###### ', '~~~', '1. ', '9. ', '12. ', '-', '#'];
const RANDOM_TAILS = ['', '甲', '文本', 'x', '，', '*', '`', '[', '_', '~'];
// [语境, 前缀空格上限]：列表项首行的上限见文件头「已知表现」
const RANDOM_CONTEXTS = [
    [(s) => `<p>${s}</p>`, 3], [(s) => `<p>甲<br>${s}</p>`, 3], [(s) => `<p><b></b>${s}</p>`, 3], [(s) => `<ul><li>${s}</li></ul>`, 1],
    [(s) => `<ol><li>${s}</li></ol>`, 2], [(s) => `<blockquote><p>${s}</p></blockquote>`, 3], [(s) => `<section>${s}</section>`, 3],
    [(s) => `<p>甲<span>乙</span>${s}</p>`, 3], [(s) => `<div>${s}</div>`, 3], [(s) => `<p>甲<br>${s}<br>乙</p>`, 3],
];

/** 前缀：1–5 个零宽字符、半角空格与不换行空格的随机排列，至少一个零宽字符，空格合计不超过 maxSpaces 个 */
function randomPrefix(rand, maxSpaces) {
    const pick = (list) => list[Math.floor(rand() * list.length)];
    for (;;) {
        const length = 1 + Math.floor(rand() * 5);
        const parts = Array.from({ length }, () => {
            const r = rand();
            if (r < 0.6) return pick(ZERO_WIDTHS);
            return r < 0.8 ? ' ' : '&nbsp;';
        });
        const spaces = parts.filter((part) => part === ' ' || part === '&nbsp;').length;
        if (parts.some((part) => ZERO_WIDTHS.includes(part)) && spaces <= maxSpaces) return parts.join('');
    }
}

test('种子随机：1200 个零宽字符前缀后接行首记号的样本，块结构与文本等于去掉前缀的对照', async () => {
    // Arrange
    const rand = seededRandom(RANDOM_SEED);
    const pick = (list) => list[Math.floor(rand() * list.length)];
    // 每个样本一至两处「前缀 + 记号 + 后续文本」，第二处接在 <br> 之后；对照为同一语境、去掉各处前缀的写法
    const samples = Array.from({ length: RANDOM_COUNT }, () => {
        const [build, maxSpaces] = pick(RANDOM_CONTEXTS);
        const count = rand() < 0.3 ? 2 : 1;
        const segments = Array.from({ length: count }, () => ({
            prefix: randomPrefix(rand, maxSpaces), body: `${pick(RANDOM_MARKERS)}${pick(RANDOM_TAILS)}`,
        }));
        return {
            html: build(segments.map((seg) => `${seg.prefix}${seg.body}`).join('<br>')),
            control: build(segments.map((seg) => seg.body).join('<br>')),
        };
    });

    // Act
    const failures = [];
    for (const [i, sample] of samples.entries()) {
        const actual = await shapeKey(sample.html);
        const expected = await shapeKey(sample.control);
        if (actual !== expected) failures.push(`#${i} ${JSON.stringify(sample.html)}：${actual}，期望 ${expected}`);
    }

    // Assert
    reportFailures(failures, RANDOM_COUNT);
});
