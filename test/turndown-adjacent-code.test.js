/**
 * converters/ir/turndown.js（url profile）：相邻的 <code> 元素转成 Markdown 后粘连
 * 成因：turndown 7.2.4 的 code 规则按值内的反引号串选定围栏长度，产物为「围栏 + 值 + 围栏」（值以反引号开头或结尾、
 * 或首尾都是空格时首尾各补一个空格），process 把相邻节点的产物首尾直接拼接。两段行内代码在输出中相邻时，前一段的
 * 闭围栏与后一段的开围栏连成一个更长的反引号串，其长度不等于前一段的开围栏，不能闭合前一段，remark 解析时配对错位。
 * 例如修复前（a48ad6a）「<p>前<code>a</code><code>b</code>后</p>」输出「前`a``b`后」，解析为单个代码段「a``b」；
 * 「<code>a`b</code><code>c</code>」输出「``a`b```c`」，解析为文本「``a」加代码段「b```c」。相邻不限于直接相邻的
 * 兄弟：两段之间的空元素与注释产物为空，外层的 span 等无规则元素原样透传内容，零宽字符由 parsers/url 的
 * normalizeMarkdown 删除，这些情形在交给 remark 的文本中同样相邻。
 * 修法：url profile 的 inlineCode 规则接管内置 code 规则，产物逐字不变，只把闭围栏的末一个反引号换成哨兵 U+0000（HTML
 * 解析器不让 NUL 进入 DOM，输出中的 NUL 只能是哨兵）；包装后的 turndown 在整篇输出上把每个哨兵换回反引号，哨兵之后隔着
 * 零宽字符若干紧跟反引号（只能是下一段的开围栏）的，在反引号之后写入空 HTML 注释 <!---->；与 renderers/md 分隔相邻
 * inlineCode 的写法相同，解析为代码段、html(<!---->)、代码段。
 * 覆盖：
 *   - 已列形态：20 种相邻形态（两段、三段、值含反引号、值以反引号开头或结尾、值首尾为 U+FEFF、两段之间夹空元素、注释、
 *     零宽字符、空 code 与被解析器忽略的 NUL，包在透传元素内，处在链接、strong、em、sup 内，标题与列表项内，直接挂在
 *     根上，pre 内与文本混排的行内代码），逐字断言 Markdown 产物，并断言全链路解析后的片段序列。
 *   - 端到端：经 parsers/url 的 parse() 抓取本机页面（站点选择器取正文），断言 IR 与 md、html、docx、xml、content-list
 *     五种渲染器的产物。
 *   - 矩阵：9 种代码值的两段全排列 81 组与三段 27 组（三段按步长 0、1、4 取值）× 12 种语境 × 8 种间隙，共 10368 例。
 *   - 回归护栏：不相邻的 21 种形态 Markdown 产物逐字等于修复前的产物；输入混入 U+0000 的 4 种形态断言解析器已把它忽略
 *     或换成 U+FFFD、伪造不出哨兵；输入混入 ir/markers 保留段码点的 3 种形态 IR 与修复前相同。
 *   - 种子随机：固定种子生成 1500 个段落，每段 2–6 个位置，各位置按 22% 取 2–3 段依次排列的代码（其间以 35% 的概率
 *     夹空元素或零宽字符、20% 的概率夹空白或换行）、15% 取单段代码、25% 取文本，其余取空元素、零宽字符、空白、换行
 *     与嵌套的格式或透传元素（深度 ≤ 2，<a> 不嵌套 <a>），段末再补一项文本；含相邻代码的段落与对照段落各占相当比例。
 * 断言口径：全链路为 turndown('url') → collapseBreakMarkers → normalizeMarkdown → remark-parse + remark-gfm →
 * liftInlineHtml → restoreMarkers，与 parsers/url 的调用同序（端到端用例另含正文提取、cleanNoise 与 preprocessHtml）。
 * 解析结果展平为「文本 + 格式集合」与「代码 + 格式集合」片段，文本略去空白与零宽字符后合并相邻同格式的片段，与按源 HTML
 * 推出的期望逐项相同即判为正确；代码值的期望为源值折叠空白串、去掉首尾空白之后的结果（turndown 把首尾空白移到代码段
 * 之外）。值为 <!----> 的 html 节点不产生片段，但须恰好夹在两个 inlineCode 之间，且个数等于期望的相邻对数；其余 html
 * 与意外的节点类型一律判错。
 * 范围外：
 *   - word 与 basic profile：mammoth 的样式映射不产出 <code>，docx 管线遇不到相邻代码，两者仍用内置 code 规则；
 *   - 表格单元格内的代码：单元格按纯文本输出，代码格式本就丢失（原有行为）；
 *   - <pre> 的首个子节点是 <code> 时整块按代码块输出，只取首个 code 的文本，其后的 code 丢失（原有行为，回归护栏
 *     断言其产物不变）；
 *   - 值只含零宽字符的 code：normalizeMarkdown 删除零宽字符后只剩「``」，解析为字面文本（原有行为）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const JSZip = require('jszip');

const { createTurndownService } = require('../converters/ir/turndown');
const { liftInlineHtml } = require('../converters/ir/inline-html');
const { restoreMarkers } = require('../converters/ir/markers');
const { loadUnified } = require('../converters/ir/unified-loader');
const { normalizeMarkdown } = require('../converters/web/normalize');
const { parse, collapseBreakMarkers } = require('../converters/parsers/url');
const { _setLookup } = require('../converters/net/fetch-guard');
const { normalizeOptions } = require('../converters/options');
const mdRenderer = require('../converters/renderers/md');
const htmlRenderer = require('../converters/renderers/html');
const docxRenderer = require('../converters/renderers/docx');
const xmlRenderer = require('../converters/renderers/xml');
const contentList = require('../converters/renderers/content-list');

// 不可见字符与反斜杠一律以码点生成，源码中不出现转义序列与不可见字面量
const fromCode = (code) => String.fromCharCode(code);
const ZWSP = fromCode(0x200b);
const ZWJ = fromCode(0x200d);
const BOM = fromCode(0xfeff);
const NBSP = fromCode(0x00a0);
const IDEOGRAPHIC_SPACE = fromCode(0x3000);
const BACKSLASH = fromCode(92);
const BR_MARKER = fromCode(0xef03);
// ir/markers 保留段中的码点 U+EF05、U+EF06（进入 IR 后由 restoreMarkers 删除），只在「输入混入保留段码点」的护栏用例里出现
const RESERVED_A = fromCode(0xef05);
const RESERVED_B = fromCode(0xef06);
// 哨兵码点 U+0000 与解析器的替换字符 U+FFFD，只在「输入混入 U+0000」的护栏用例里出现
const NUL = fromCode(0);
const REPLACEMENT = fromCode(0xfffd);
// url profile 在相邻两段代码之间写入的分隔注释
const SEPARATOR = '<!---->';
const LINK_URL = 'https://example.com/p';
// 片段展平所认的格式类型
const FORMAT_TYPES = new Set(['strong', 'emphasis', 'delete', 'superscript', 'subscript', 'link']);
// 块类型：展平时穿过、不产生片段
const PASS_THROUGH_TYPES = new Set(['root', 'paragraph', 'heading', 'list', 'listItem', 'blockquote']);
const MAX_REPORTED = 10;

// ============================================================
// 转换与展平
// ============================================================

const toMarkdown = (html) => createTurndownService('url').turndown(html);

/** 全链路：与 parsers/url 的 turndown 之后各步同序 */
async function toIr(html) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    const markdown = normalizeMarkdown(collapseBreakMarkers(toMarkdown(html)));
    return restoreMarkers(liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(markdown), { source: 'web' }));
}

/**
 * IR 展平：text 与 inlineCode 成片段（f 为格式集合的有序数组），break 略去；分隔注释计数，并记下其两侧兄弟是否都是
 * inlineCode；其余 html 与意外节点类型另行收集
 */
function flatten(tree) {
    const frags = [];
    const stray = [];
    const others = [];
    let separators = 0;
    let misplaced = 0;
    const walk = (node, formats, siblings, index) => {
        if (node.type === 'text') frags.push({ k: 't', v: node.value, f: formats });
        else if (node.type === 'inlineCode') frags.push({ k: 'c', v: node.value, f: formats });
        else if (node.type === 'html') {
            if (node.value !== SEPARATOR) stray.push(node.value);
            else {
                separators += 1;
                const prev = siblings[index - 1];
                const next = siblings[index + 1];
                if (!prev || prev.type !== 'inlineCode' || !next || next.type !== 'inlineCode') misplaced += 1;
            }
        } else if (node.type !== 'break') {
            let next = formats;
            if (FORMAT_TYPES.has(node.type)) next = formats.includes(node.type) ? formats : [...formats, node.type].sort();
            else if (!PASS_THROUGH_TYPES.has(node.type)) others.push(node.type);
            const children = node.children || [];
            children.forEach((child, i) => walk(child, next, children, i));
        }
    };
    walk(tree, [], [], 0);
    return { frags, stray, others, separators, misplaced };
}

const INVISIBLE = new Set([ZWSP, ZWJ, BOM, fromCode(0x200c), fromCode(0x2060)]);
const squeeze = (text) => Array.from(text).filter((ch) => !/\s/.test(ch) && !INVISIBLE.has(ch)).join('');

/** 片段规范化：文本略去空白与零宽字符、去空、相邻同格式合并；代码原样 */
function normalizeFrags(frags) {
    const out = [];
    for (const frag of frags) {
        if (frag.k === 'c') {
            out.push(`c:${frag.f.join('+')}:${frag.v}`);
            continue;
        }
        const v = squeeze(frag.v);
        if (!v) continue;
        const key = `t:${frag.f.join('+')}:`;
        if (out.length > 0 && out[out.length - 1].startsWith(key)) out[out.length - 1] += v;
        else out.push(key + v);
    }
    return out;
}

/** 与期望比对：片段逐项相同、无其余 html 与意外节点、分隔注释均夹在两段代码之间且个数等于 pairs；返回问题描述或 null */
function problemOf(flat, expectedFrags, pairs) {
    const actual = normalizeFrags(flat.frags);
    const expected = normalizeFrags(expectedFrags);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return `片段 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`;
    if (flat.stray.length > 0) return `多出 html ${JSON.stringify(flat.stray)}`;
    if (flat.others.length > 0) return `意外节点 ${JSON.stringify(flat.others)}`;
    if (flat.misplaced > 0) return `分隔注释未夹在两段代码之间 ${flat.misplaced} 处`;
    if (flat.separators !== pairs) return `分隔注释 ${flat.separators} 个，期望 ${pairs} 个`;
    return null;
}

const code = (v, ...f) => ({ k: 'c', v, f: [...f].sort() });
const text = (v, ...f) => ({ k: 't', v, f: [...f].sort() });

function reportFailures(failures, total) {
    assert.equal(failures.length, 0, `${failures.length}/${total} 例失败，前 ${MAX_REPORTED} 例：\n${failures.slice(0, MAX_REPORTED).join('\n')}`);
}

// ============================================================
// 已列形态
// ============================================================

// [名称, HTML, 期望 Markdown, 期望片段, 相邻对数]
const LISTED_FORMS = [
    ['两段', '<p>前<code>a</code><code>b</code>后</p>', '前`a`<!---->`b`后', [text('前'), code('a'), code('b'), text('后')], 1],
    ['三段', '<p>前<code>a</code><code>b</code><code>c</code>后</p>', '前`a`<!---->`b`<!---->`c`后',
        [text('前'), code('a'), code('b'), code('c'), text('后')], 2],
    ['值含反引号', '<p><code>a`b</code><code>c</code></p>', '``a`b``<!---->`c`', [code('a`b'), code('c')], 1],
    ['值以反引号开头', '<p><code>`a</code><code>b</code></p>', '`` `a ``<!---->`b`', [code('`a'), code('b')], 1],
    ['后一段以反引号结尾', '<p><code>a</code><code>b`</code></p>', '`a`<!---->`` b` ``', [code('a'), code('b`')], 1],
    ['值首尾为 U+FEFF（移到代码段外、再被删除）', `<p><code>a${BOM}</code><code>${BOM}b</code></p>`, '`a`' + SEPARATOR + BOM + BOM + '`b`',
        [code('a'), code('b')], 1],
    ['夹空的 b 元素', '<p><code>a</code><b></b><code>b</code></p>', '`a`<!---->`b`', [code('a'), code('b')], 1],
    ['夹无 src 的 img', '<p><code>a</code><img alt="图"><code>b</code></p>', '`a`<!---->`b`', [code('a'), code('b')], 1],
    ['夹注释', '<p><code>a</code><!-- 注 --><code>b</code></p>', '`a`<!---->`b`', [code('a'), code('b')], 1],
    ['夹零宽字符', `<p><code>a</code>${ZWSP}${ZWJ}<code>b</code></p>`, '`a`' + SEPARATOR + ZWSP + ZWJ + '`b`', [code('a'), code('b')], 1],
    ['夹空 code', '<p><code>a</code><code></code><code>b</code></p>', '`a`<!---->`b`', [code('a'), code('b')], 1],
    ['夹 NUL（HTML 解析器在正文中忽略 NUL，两段相邻）', `<p><code>a</code>${NUL}<code>b</code></p>`, '`a`<!---->`b`', [code('a'), code('b')], 1],
    ['前一段包在 span 内', '<p><span><code>a</code></span><code>b</code></p>', '`a`<!---->`b`', [code('a'), code('b')], 1],
    ['两段各包在 kbd 内', '<p><kbd><code>a</code></kbd><kbd><code>b</code></kbd></p>', '`a`<!---->`b`', [code('a'), code('b')], 1],
    ['处在链接内', `<p><a href="${LINK_URL}"><code>a</code><code>b</code></a></p>`, '[`a`' + SEPARATOR + '`b`](' + LINK_URL + ')',
        [code('a', 'link'), code('b', 'link')], 1],
    ['处在 strong 内', '<p><strong><code>a</code><code>b</code></strong></p>', '<strong>`a`<!---->`b`</strong>',
        [code('a', 'strong'), code('b', 'strong')], 1],
    ['处在 em 内的 sup 内', '<p><em><sup><code>a</code><code>b</code></sup></em></p>', '<em><sup>`a`<!---->`b`</sup></em>',
        [code('a', 'emphasis', 'superscript'), code('b', 'emphasis', 'superscript')], 1],
    ['标题与列表项内', '<h2><code>a</code><code>b</code></h2><ul><li><code>c</code><code>d</code></li></ul>',
        '## `a`<!---->`b`\n\n-   `c`<!---->`d`', [code('a'), code('b'), code('c'), code('d')], 2],
    ['直接挂在根上', '<code>a</code><code>b</code>', '`a`<!---->`b`', [code('a'), code('b')], 1],
    ['pre 内与文本混排（非代码块）', '<pre>t<code>a</code><code>b</code></pre>', 't`a`<!---->`b`', [text('t'), code('a'), code('b')], 1],
];

test('已列形态：相邻的行内代码之间写入 <!---->，全链路解析后各段的值与段数不变', async () => {
    const failures = [];
    for (const [name, html, markdown, expected, pairs] of LISTED_FORMS) {
        // Act
        const actualMarkdown = toMarkdown(html);
        const problem = problemOf(flatten(await toIr(html)), expected, pairs);

        // Assert（汇总后统一断言，失败时列出全部不符的形态）
        if (actualMarkdown !== markdown) failures.push(`${name}：Markdown ${JSON.stringify(actualMarkdown)}，期望 ${JSON.stringify(markdown)}`);
        if (problem) failures.push(`${name}：${problem}`);
    }
    reportFailures(failures, LISTED_FORMS.length);
});

// ============================================================
// 端到端：parsers/url 的 parse() 与各渲染器
// ============================================================

const E2E_BODY = [
    '<p>前<code>a</code><code>b</code>后</p>',
    `<p>甲<code>x</code><b></b><code>y</code>${ZWSP}<code>z</code>乙</p>`,
    `<p><span><code>c</code></span><code>d</code><a href="${LINK_URL}"><code>e</code><code>f</code></a></p>`,
].join('\n');
const E2E_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>相邻代码</title></head><body><div id="js_content">${E2E_BODY}</div></body></html>`;

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

test('端到端：网页正文中相邻的 <code> 进入 IR 后各自成段，md 产物带分隔注释，html、docx、xml、content-list 均不含注释', async (t) => {
    // Arrange：经 _setLookup 把 mp.weixin.qq.com 解析到本机，站点选择器按主机名命中，正文原样取出
    const server = await startPageServer(E2E_PAGE);
    t.after(() => server.close());
    _setLookup(async () => [{ address: '127.0.0.1', family: 4 }]);
    t.after(() => _setLookup(null));

    // Act
    const doc = await parse({ url: `http://mp.weixin.qq.com:${server.port}/mp.weixin.qq.com/s/adjacent` }, { allowPrivateNetwork: true, skipImages: true });
    const paragraphs = doc.ir.children.filter((node) => node.type === 'paragraph');
    const md = await mdRenderer.render(doc);
    const html = await htmlRenderer.render(doc);
    const { files } = await xmlRenderer.render(doc, normalizeOptions({ xml: { profile: 'generic' } }));
    const xml = files['{name}.xml'];
    const blocks = JSON.parse(await contentList.render(doc));
    const zip = await JSZip.loadAsync(await docxRenderer.render(doc));
    const documentXml = await zip.file('word/document.xml').async('string');

    // Assert：IR
    assert.equal(paragraphs.length, 3, JSON.stringify(doc.ir));
    const expectations = [
        [[text('前'), code('a'), code('b'), text('后')], 1],
        [[text('甲'), code('x'), code('y'), code('z'), text('乙')], 2],
        [[code('c'), code('d'), code('e', 'link'), code('f', 'link')], 2],
    ];
    paragraphs.forEach((paragraph, i) => {
        const problem = problemOf(flatten(paragraph), ...expectations[i]);
        assert.equal(problem, null, `第 ${i + 1} 段：${problem}`);
    });
    // Assert：渲染器
    assert.ok(md.includes('前`a`<!---->`b`后') && md.includes('甲`x`<!---->`y`<!---->`z`乙'), md);
    assert.ok(html.includes('前<code>a</code><code>b</code>后'), html);
    assert.ok(html.includes('甲<code>x</code><code>y</code><code>z</code>乙'), html);
    assert.ok(!html.includes('<!--') && !html.includes('&#x3C;!--') && !html.includes('&lt;!--'), 'html 产物不应含分隔注释');
    assert.ok(xml.includes('<code>a</code><code>b</code>'), xml);
    assert.ok(!xml.includes('<!--') && !xml.includes('&lt;!--'), 'xml 产物不应含分隔注释');
    const texts = blocks.filter((block) => block.type === 'text').map((block) => block.text);
    assert.ok(texts.includes('前ab后') && texts.includes('甲xyz乙'), JSON.stringify(texts));
    assert.ok(!documentXml.includes('&lt;!--'), 'docx 产物不应含分隔注释');
    const runTexts = [...documentXml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]);
    for (const value of ['a', 'b', 'x', 'y', 'z', 'c', 'd', 'e', 'f']) assert.ok(runTexts.includes(value), `docx 缺少代码 ${value} 的 run：${JSON.stringify(runTexts)}`);
});

// ============================================================
// 矩阵
// ============================================================

// 代码值与期望值（折叠空白串、去掉首尾空白之后）
const MATRIX_VALUES = [
    ['x', 'x'], ['a`b', 'a`b'], ['`a', '`a'], ['a`', 'a`'], ['``', '``'], ['a  b', 'a b'], ['中文', '中文'],
    [BACKSLASH, BACKSLASH], ['<!---->', '<!---->'],
];
const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const codeHtml = (value) => `<code>${escapeHtml(value)}</code>`;

// 语境：[名称, 由各段代码与间隙拼出 HTML 的函数, 代码的格式集合, 期望片段前后的文本]
const MATRIX_CONTEXTS = [
    ['段落直属', (codes, gap) => `<p>${codes.join(gap)}</p>`, [], []],
    ['前后有文本', (codes, gap) => `<p>前${codes.join(gap)}后</p>`, [], ['前', '后']],
    ['strong 内', (codes, gap) => `<p><strong>${codes.join(gap)}</strong></p>`, ['strong'], []],
    ['em 内', (codes, gap) => `<p><em>${codes.join(gap)}</em></p>`, ['emphasis'], []],
    ['del 内', (codes, gap) => `<p><del>${codes.join(gap)}</del></p>`, ['delete'], []],
    ['sub 内', (codes, gap) => `<p><sub>${codes.join(gap)}</sub></p>`, ['subscript'], []],
    ['链接内', (codes, gap) => `<p><a href="${LINK_URL}">${codes.join(gap)}</a></p>`, ['link'], []],
    ['span 内', (codes, gap) => `<p><span>${codes.join(gap)}</span></p>`, [], []],
    ['各段各包 span', (codes, gap) => `<p>${codes.map((c) => `<span>${c}</span>`).join(gap)}</p>`, [], []],
    ['各段各包 u', (codes, gap) => `<p>${codes.map((c) => `<u>${c}</u>`).join(gap)}</p>`, [], []],
    ['标题内', (codes, gap) => `<h2>${codes.join(gap)}</h2>`, [], []],
    ['列表项内', (codes, gap) => `<ul><li>${codes.join(gap)}</li></ul>`, [], []],
];
const MATRIX_GAPS = [
    ['直接相邻', ''], ['空 b', '<b></b>'], ['无 src 的 img', '<img>'], ['注释', '<!-- 注 -->'], ['空 span', '<span></span>'],
    ['U+200B', ZWSP], ['U+FEFF', BOM], ['wbr', '<wbr>'],
];

function matrixCombos() {
    const n = MATRIX_VALUES.length;
    const combos = [];
    for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) combos.push([i, j]);
    for (const step of [0, 1, 4]) for (let i = 0; i < n; i += 1) combos.push([i, (i + step) % n, (i + 2 * step) % n]);
    return combos;
}

test('矩阵：9 种代码值的两段与三段组合 × 12 种语境 × 8 种间隙，全链路解析后各段的值与格式不变', async () => {
    // Arrange：对照形态——各代码值单独放入每种语境，确认形态本身在范围内
    for (const [ctxName, build, formats, around] of MATRIX_CONTEXTS) {
        for (const [value, expectedValue] of MATRIX_VALUES) {
            const expected = [...(around[0] ? [text(around[0])] : []), code(expectedValue, ...formats), ...(around[1] ? [text(around[1])] : [])];
            const problem = problemOf(flatten(await toIr(build([codeHtml(value)], ''))), expected, 0);
            assert.equal(problem, null, `对照 ${ctxName} / ${JSON.stringify(value)}：${problem}`);
        }
    }
    const failures = [];
    let total = 0;
    for (const combo of matrixCombos()) {
        for (const [ctxName, build, formats, around] of MATRIX_CONTEXTS) {
            for (const [gapName, gap] of MATRIX_GAPS) {
                total += 1;
                const html = build(combo.map((i) => codeHtml(MATRIX_VALUES[i][0])), gap);
                const expected = [
                    ...(around[0] ? [text(around[0])] : []),
                    ...combo.map((i) => code(MATRIX_VALUES[i][1], ...formats)),
                    ...(around[1] ? [text(around[1])] : []),
                ];

                // Act
                const problem = problemOf(flatten(await toIr(html)), expected, combo.length - 1);

                // Assert（汇总）
                if (problem) failures.push(`${ctxName} / ${gapName} / ${JSON.stringify(html)}：${problem}`);
            }
        }
    }
    reportFailures(failures, total);
});

// ============================================================
// 回归护栏
// ============================================================

// [名称, HTML, 修复前后逐字相同的 Markdown 产物]：两段代码不相邻，或不经 inlineCode 规则输出
const GUARD_FORMS = [
    ['单独一段', '<p>前<code>a</code>后</p>', '前`a`后'],
    ['隔着半角空格', '<p><code>a</code> <code>b</code></p>', '`a` `b`'],
    ['值首尾为半角空格（移到代码段外）', '<p><code> a </code><code>b</code></p>', '`a` `b`'],
    ['前一段以半角空格结尾', '<p><code>a </code><code>b</code></p>', '`a` `b`'],
    ['隔着不换行空格', `<p><code>a</code>${NBSP}<code>b</code></p>`, '`a`' + NBSP + '`b`'],
    ['隔着全角空格', `<p><code>a</code>${IDEOGRAPHIC_SPACE}<code>b</code></p>`, '`a`' + IDEOGRAPHIC_SPACE + '`b`'],
    ['隔着文本', '<p><code>a</code>中<code>b</code></p>', '`a`中`b`'],
    ['隔着换行', '<p><code>a</code><br><code>b</code></p>', '`a`' + BR_MARKER + '`b`'],
    ['隔着只含空白的 code', '<p><code>a</code><code> </code><code>b</code></p>', '`a` `b`'],
    ['隔着文本中的反引号', '<p><code>a</code>`<code>b</code></p>', '`a`' + BACKSLASH + '``b`'],
    ['隔着文本中的反斜杠', `<p><code>a</code>${BACKSLASH}<code>b</code></p>`, '`a`' + BACKSLASH + BACKSLASH + '`b`'],
    ['前一段在 strong 内', '<p><strong><code>a</code></strong><code>b</code></p>', '<strong>`a`</strong>`b`'],
    ['前一段在链接内', `<p><a href="${LINK_URL}"><code>a</code></a><code>b</code></p>`, '[`a`](' + LINK_URL + ')`b`'],
    ['后一段在链接内', `<p><code>a</code><a href="${LINK_URL}"><code>b</code></a></p>`, '`a`[`b`](' + LINK_URL + ')'],
    ['前一段在 mark 内', '<p><mark><code>a</code></mark><code>b</code></p>', '==`a`==`b`'],
    ['pre 代码块', '<pre><code>a</code></pre>', '```\na\n```'],
    ['pre 首个子节点为 code 的多段代码（只取首段，原有行为）', '<pre><code>a</code><code>b</code></pre>', '```\na\n```'],
    ['code 内嵌套的相邻 code（外层代码段的原文）', '<p><code><code>a</code><code>b</code></code></p>', '``` `a``b` ```'],
    ['带删除线样式的 code（归 inlineStrikethrough）', '<p><code style="text-decoration:line-through">a</code><code>b</code></p>', '<del>a</del>`b`'],
    ['kbd、samp、tt、var（无对应规则，按纯文本输出）', '<p><kbd>a</kbd><kbd>b</kbd><samp>c</samp><tt>d</tt><var>e</var></p>', 'abcde'],
    ['块首的三反引号围栏代码段（wrapHtml 的块语法判定不变）', '<div><strong><p><code>a`b``c</code>x</p><p>y</p></strong></div>',
        '```a`b``c```x\n\n<strong>y</strong>'],
];

// [名称, HTML, 期望 Markdown, 期望 IR 片段]：输入混入 U+0000。HTML 解析器在正文中忽略 NUL、在属性值中换成 U+FFFD、字符引用
// &#0; 同样换成 U+FFFD，因此输入伪造不出哨兵（正文中夹在两段代码之间的 NUL 见已列形态）
const NUL_FORMS = [
    ['文本中的 NUL（忽略）', `<p>甲${NUL}乙</p>`, '甲乙', [text('甲乙')]],
    ['代码值中的 NUL（忽略）', `<p><code>a${NUL}b</code></p>`, '`ab`', [code('ab')]],
    ['链接地址中的 NUL（换成 U+FFFD）', `<p><a href="x${NUL}y"><code>a</code></a><code>b</code></p>`,
        '[`a`](x' + REPLACEMENT + 'y)`b`', [code('a', 'link'), code('b')]],
    ['字符引用 &#0;（换成 U+FFFD）', '<p>甲&#0;乙</p>', '甲' + REPLACEMENT + '乙', [text('甲' + REPLACEMENT + '乙')]],
];

// [名称, HTML, 修复前后相同的 IR 片段]：输入混入 ir/markers 保留段的码点。保留段码点与哨兵无关，在 turndown 的输出里照常
// 隔开两段（不是零宽字符，不判相邻），进入 IR 后由 restoreMarkers 删除
const RESERVED_FORMS = [
    ['文本中的保留段码点', `<p>甲${RESERVED_B}${RESERVED_A}乙</p>`, [text('甲乙')]],
    ['代码值中的「保留段码点 + 反引号 + 保留段码点」', '<p><code>a' + RESERVED_B + '`' + RESERVED_A + 'b</code></p>', [code('a`b')]],
    ['两段代码之间的保留段码点（隔开两段）', `<p><code>a</code>${RESERVED_A}<code>b</code></p>`, [code('a'), code('b')]],
];

test('回归护栏：不相邻的形态 Markdown 产物逐字不变；输入混入 U+0000 时解析器先行忽略或替换、伪造不出哨兵；混入保留段码点时 IR 与修复前相同', async () => {
    const failures = [];
    for (const [name, html, markdown] of GUARD_FORMS) {
        // Act
        const actual = toMarkdown(html);

        // Assert（汇总）
        if (actual !== markdown) failures.push(`${name}：${JSON.stringify(actual)}，期望 ${JSON.stringify(markdown)}`);
    }
    for (const [name, html, markdown, expected] of NUL_FORMS) {
        const actualMarkdown = toMarkdown(html);
        const flat = flatten(await toIr(html));
        const actual = normalizeFrags(flat.frags);
        if (actualMarkdown !== markdown) failures.push(`${name}：Markdown ${JSON.stringify(actualMarkdown)}，期望 ${JSON.stringify(markdown)}`);
        if (JSON.stringify(actual) !== JSON.stringify(normalizeFrags(expected)) || flat.stray.length > 0) {
            failures.push(`${name}：片段 ${JSON.stringify(actual)}，多出 html ${JSON.stringify(flat.stray)}`);
        }
    }
    for (const [name, html, expected] of RESERVED_FORMS) {
        // 只比片段不比分隔注释数：第三例的两段由保留段码点隔开，不写分隔注释，该码点进入 IR 后删除
        const flat = flatten(await toIr(html));
        const actual = normalizeFrags(flat.frags);
        if (JSON.stringify(actual) !== JSON.stringify(normalizeFrags(expected)) || flat.stray.length > 0) {
            failures.push(`${name}：片段 ${JSON.stringify(actual)}，多出 html ${JSON.stringify(flat.stray)}`);
        }
    }
    reportFailures(failures, GUARD_FORMS.length + NUL_FORMS.length + RESERVED_FORMS.length);
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
const RANDOM_COUNT = 1500;
const RANDOM_CODE_VALUES = ['x', 'y', 'ab', '中文', 'a`b', '`a', 'a`', '``', 'a``b', 'a`b``c', ' x ', 'x ', ' ', 'a  b', '*x*', 'a_b',
    BACKSLASH, '<b>', '&', '<!---->'];
const RANDOM_TEXTS = ['甲', '乙', '文本', '示例', 'x', 'abc', '，', '。', '`', '``', '*', '_', BACKSLASH, '[', ']', '~', 'a*b'];
const RANDOM_EMPTIES = ['<span></span>', '<b></b>', '<em></em>', '<sup></sup>', '<u></u>', '<code></code>', '<img>', '<img alt="图">',
    '<a></a>', '<!-- 注 -->', '<wbr>', '<b><img></b>', '<script>var x = 1;</script>'];
const RANDOM_ZW = [ZWSP, ZWJ, BOM, fromCode(0x200c), fromCode(0x2060)];
const RANDOM_FORMATS = [['strong', 'strong'], ['b', 'strong'], ['em', 'emphasis'], ['i', 'emphasis'], ['del', 'delete'], ['s', 'delete'],
    ['sup', 'superscript'], ['sub', 'subscript'], ['a', 'link']];
const RANDOM_TRANSPARENT = ['span', 'u', 'kbd', 'samp', 'tt', 'var', 'small', 'cite', 'q', 'a'];

/**
 * 段落模型 → { html, frags, pairs }。pairs 按输出记号推演：代码 C、可见文本 T、空白 W、换行 B，格式元素的开闭标签各记
 * T，零宽字符、空元素与透传元素本身不记，两个 C 之间无任何记号即计一对。<a> 之内不再生成 <a>
 */
function randomParagraph(rand) {
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const collapse = (value) => value.replace(/[ \t\r\n]+/g, ' ');
    const out = { html: '', frags: [], tokens: [] };
    const emitCode = (value, formats) => {
        out.html += codeHtml(value);
        const v = collapse(value);
        if (!/\S/.test(v)) {
            if (v) out.tokens.push('W');
            return;
        }
        if (/^\s/.test(v)) out.tokens.push('W');
        out.frags.push(code(v.trim(), ...formats));
        out.tokens.push('C');
        if (/\s$/.test(v)) out.tokens.push('W');
    };
    const emitText = (formats) => {
        const v = pick(RANDOM_TEXTS);
        out.html += escapeHtml(v);
        out.frags.push(text(v, ...formats));
        out.tokens.push('T');
    };
    // <a> 之内不生成 <a></a>：HTML 解析器遇到嵌套的 <a> 开标签会先关闭外层
    const pickEmpty = (inA) => {
        let snippet = pick(RANDOM_EMPTIES);
        while (inA && snippet === '<a></a>') snippet = pick(RANDOM_EMPTIES);
        return snippet;
    };
    // 串内两段代码之间的间隙：多为空，其次为空元素与零宽字符（仍相邻），少量为空白与换行（不相邻的对照）
    const emitGap = (inA) => {
        const r = rand();
        if (r < 0.45) return;
        if (r < 0.65) out.html += pickEmpty(inA);
        else if (r < 0.8) out.html += pick(RANDOM_ZW);
        else if (r < 0.9) {
            out.html += ' ';
            out.tokens.push('W');
        } else {
            out.html += '<br>';
            out.tokens.push('B');
        }
    };
    const seq = (length, depth, formats, inA) => {
        for (let i = 0; i < length; i += 1) {
            const r = rand();
            if (r < 0.22) {
                const count = rand() < 0.7 ? 2 : 3;
                for (let k = 0; k < count; k += 1) {
                    if (k > 0) emitGap(inA);
                    emitCode(pick(RANDOM_CODE_VALUES), formats);
                }
            } else if (r < 0.37) emitCode(pick(RANDOM_CODE_VALUES), formats);
            else if (r < 0.62) emitText(formats);
            else if (r < 0.7) out.html += pickEmpty(inA);
            else if (r < 0.75) out.html += pick(RANDOM_ZW);
            else if (r < 0.8) {
                out.html += ' ';
                out.tokens.push('W');
            } else if (r < 0.82) {
                out.html += '<br>';
                out.tokens.push('B');
            } else if (depth < 2 && r < 0.92) {
                let [tag, type] = pick(RANDOM_FORMATS);
                while (inA && tag === 'a') [tag, type] = pick(RANDOM_FORMATS);
                const next = formats.includes(type) ? formats : [...formats, type];
                out.html += `<${tag}${tag === 'a' ? ` href="${LINK_URL}"` : ''}>`;
                out.tokens.push('T');
                // 格式元素至少含一项可见文本，免得整个元素产物为空、标签不输出
                emitText(next);
                seq(Math.floor(rand() * 3), depth + 1, next, inA || tag === 'a');
                out.html += `</${tag}>`;
                out.tokens.push('T');
            } else if (depth < 2) {
                let tag = pick(RANDOM_TRANSPARENT);
                while (inA && tag === 'a') tag = pick(RANDOM_TRANSPARENT);
                out.html += `<${tag}>`;
                seq(1 + Math.floor(rand() * 3), depth + 1, formats, inA || tag === 'a');
                out.html += `</${tag}>`;
            } else emitText(formats);
        }
    };
    seq(2 + Math.floor(rand() * 5), 0, [], false);
    // 段末补一项文本：换行之后只剩零宽字符时，collapseBreakMarkers 先按行中换行写出「\ + 换行」，normalizeMarkdown
    // 随后删去零宽字符，段末留下字面反斜杠（原有问题，与相邻代码无关），段末有文本即不触发
    emitText([]);
    let pairs = 0;
    for (let i = 1; i < out.tokens.length; i += 1) if (out.tokens[i - 1] === 'C' && out.tokens[i] === 'C') pairs += 1;
    return { html: `<p>${out.html}</p>`, frags: out.frags.map((f) => ({ ...f, f: [...f.f].sort() })), pairs };
}

test('种子随机：1500 个含相邻行内代码的段落，全链路解析后片段与期望一致，分隔注释数等于相邻对数', async () => {
    // Arrange
    const rand = seededRandom(RANDOM_SEED);
    const paragraphs = Array.from({ length: RANDOM_COUNT }, () => randomParagraph(rand));
    const adjacent = paragraphs.filter((p) => p.pairs > 0).length;
    // 相邻与对照两类都须占相当比例，免得随机分布退化
    assert.ok(adjacent > RANDOM_COUNT / 4 && adjacent < RANDOM_COUNT * 3 / 4, `含相邻代码的段落 ${adjacent} 个`);

    // Act
    const failures = [];
    for (const [i, paragraph] of paragraphs.entries()) {
        const problem = problemOf(flatten(await toIr(paragraph.html)), paragraph.frags, paragraph.pairs);
        if (problem) failures.push(`#${i} ${JSON.stringify(paragraph.html)}：${problem}`);
    }

    // Assert
    reportFailures(failures, RANDOM_COUNT);
});
