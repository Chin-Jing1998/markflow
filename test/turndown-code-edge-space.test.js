/**
 * converters/ir/turndown.js（url profile）：代码值首尾的空白在邻居已有空白时留在反引号围栏之内
 * 成因：turndown 7.2.4 的 flankingWhitespace 按元素 textContent 首尾的 ASCII 空白计算要移到元素之外的空白，左邻（右邻）
 * 兄弟的文本以空格结尾（开头）时判定这一侧已被空白夹住、舍弃该侧（isFlankedByWhitespace）；replacementForNode 只在移出的
 * leading 或 trailing 非空时才 trim 内容。两侧都被舍弃、或一侧被舍弃而另一侧本无空白时，内容原样交给 code 规则，被舍弃的
 * 空白留在围栏之内，重新解析为代码值的一部分。邻居的文本能以空格开头或结尾，是因为 collapseWhitespace 不删 void 元素
 * （img、wbr 等）之后的空白：代码值末尾的空格与邻居里 void 元素之后的空格各留一份。例如修复前（4a2de9a 加上 A 项修复）
 * 「甲<code>x </code><samp><img> 乙</samp>」输出「甲`x ` 乙」，重新解析为值「x 」；镜像情形「<samp>甲 <img></samp>
 * <code> x</code>乙」输出「甲 ` x`乙」，值为「 x」。
 * 修法：url profile 的 inlineCode 规则在调用内置 code 规则之前补做 turndown 漏掉的 trim：flankingWhitespace 两侧皆空、
 * 而 textContent 在某侧有 ASCII 空白时，该侧空白必是被舍弃的，把内容这一侧的 ASCII 空白去掉；被舍弃的空白按 turndown
 * 的判定由邻居提供，围栏之外不另补。处在另一段 code 之内的 code 不动（其产物是外层代码段的原文）。
 * 覆盖：
 *   - 已列形态：18 种（值末尾空格后接 samp、kbd、span、u、strong、链接，void 元素为 img、wbr、带 alt 的 img；值含内部空格
 *     与反引号；处在链接、strong、列表项内；后接相邻代码；code 内以 img 结尾；首部空格的两种镜像；首尾两侧都被舍弃；
 *     只含空白与 void 元素的 code），逐字断言 Markdown 产物，并断言全链路解析后的片段序列。
 *   - 端到端：经 parsers/url 的 parse() 抓取本机页面（站点选择器取正文，含 cleanNoise 与 preprocessHtml），断言 IR 与
 *     md 渲染器的产物。
 *   - 矩阵：7 种代码值 × 17 种邻居标签 × 2 种 void 元素 × 3 种方位（末尾、首部、首尾）× 4 种语境，链接语境不以 a 作邻居，
 *     共 2814 例，全链路解析后代码值与片段序列与期望一致。
 *   - 回归护栏：turndown 本已处理的形态（后接文本、后接无前导空白的元素、后接 void 元素、首尾空白移到围栏外、一侧保留一侧
 *     舍弃、边缘为不换行空格）与嵌套 code 的 Markdown 产物逐字等于修复前；word 与 basic profile 的产物不变。
 *   - 种子随机：固定种子生成 1500 个段落，各位置按比例取首尾带空格的代码、以 void 元素与空格开头或结尾的透传与格式元素、
 *     文本、空白与零宽字符，全链路解析后片段序列与期望一致，分隔注释只出现在两段代码之间。
 * 断言口径：全链路为 turndown('url') → collapseBreakMarkers → normalizeMarkdown → remark-parse + remark-gfm →
 * liftInlineHtml → restoreMarkers，与 parsers/url 的调用同序（端到端用例另含正文提取、cleanNoise 与 preprocessHtml）。
 * 解析结果展平为「文本 + 格式集合」与「代码 + 格式集合」片段，文本略去空白与零宽字符后合并相邻同格式的片段；代码值的
 * 期望为源值折叠空白串、去掉首尾空白之后的结果，只含空白的代码按空白文本计。
 * 范围外：
 *   - 邻居的产物不以其空白开头或结尾时（img 带 src、邻居为 strong 等由 wrapHtml 修剪内容的元素），被舍弃的空白不出现在
 *     产物中：修复前该空白留在代码值里，修复后代码段与邻居之间没有空白，与 url profile 对 em、strong 等元素的既有处理一致；
 *   - 链接、透传元素等其他行内元素同样存在「两侧舍弃而不 trim」，链接文字首尾留有空格（不影响代码值）；
 *   - word 与 basic profile 仍用内置 code 规则（docx 管线遇不到此形态）。
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
const ZWJ = fromCode(0x200d);
const BOM = fromCode(0xfeff);
const NBSP = fromCode(0x00a0);
const BACKSLASH = fromCode(92);
const SEPARATOR = '<!---->';
const LINK_URL = 'https://example.com/p';
const FORMAT_TYPES = new Set(['strong', 'emphasis', 'delete', 'superscript', 'subscript', 'link']);
const PASS_THROUGH_TYPES = new Set(['root', 'paragraph', 'heading', 'list', 'listItem', 'blockquote']);
const MAX_REPORTED = 10;

// ============================================================
// 转换与展平
// ============================================================

const toMarkdown = (html, profile = 'url') => createTurndownService(profile).turndown(html);

/** 全链路：与 parsers/url 的 turndown 之后各步同序 */
async function toIr(html) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    const markdown = normalizeMarkdown(collapseBreakMarkers(toMarkdown(html)));
    return restoreMarkers(liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(markdown), { source: 'web' }));
}

/** IR 展平：text 与 inlineCode 成片段（f 为格式集合的有序数组），break 略去；分隔注释计数并核对两侧；其余 html 与意外节点另行收集 */
function flatten(tree) {
    const frags = [];
    const stray = [];
    const others = [];
    let misplaced = 0;
    const walk = (node, formats, siblings, index) => {
        if (node.type === 'text') frags.push({ k: 't', v: node.value, f: formats });
        else if (node.type === 'inlineCode') frags.push({ k: 'c', v: node.value, f: formats });
        else if (node.type === 'html') {
            if (node.value !== SEPARATOR) stray.push(node.value);
            else {
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
    return { frags, stray, others, misplaced };
}

const INVISIBLE = new Set([ZWSP, ZWJ, BOM, fromCode(0x200c), fromCode(0x2060)]);
const squeeze = (value) => Array.from(value).filter((ch) => !/\s/.test(ch) && !INVISIBLE.has(ch)).join('');

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

/** 与期望比对：片段逐项相同、无其余 html 与意外节点、分隔注释均夹在两段代码之间；返回问题描述或 null */
function problemOf(flat, expectedFrags) {
    const actual = normalizeFrags(flat.frags);
    const expected = normalizeFrags(expectedFrags);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return `片段 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`;
    if (flat.stray.length > 0) return `多出 html ${JSON.stringify(flat.stray)}`;
    if (flat.others.length > 0) return `意外节点 ${JSON.stringify(flat.others)}`;
    if (flat.misplaced > 0) return `分隔注释未夹在两段代码之间 ${flat.misplaced} 处`;
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

// [名称, HTML, 期望 Markdown, 期望片段]
const LISTED_FORMS = [
    ['原始复现：值末尾空格后接以 img 与空格开头的 samp', '<p>甲<code>x </code><samp><img> 乙</samp></p>', '甲`x` 乙', [text('甲'), code('x'), text('乙')]],
    ['samp 内为 wbr', '<p>甲<code>x </code><samp><wbr> 乙</samp></p>', '甲`x` 乙', [text('甲'), code('x'), text('乙')]],
    ['kbd 内为带 alt 的 img', '<p>甲<code>x </code><kbd><img alt="图"> 乙</kbd></p>', '甲`x` 乙', [text('甲'), code('x'), text('乙')]],
    ['后接 span', '<p>甲<code>x </code><span><img> 乙</span></p>', '甲`x` 乙', [text('甲'), code('x'), text('乙')]],
    ['后接 u', '<p>甲<code>x </code><u><img> 乙</u></p>', '甲`x` 乙', [text('甲'), code('x'), text('乙')]],
    ['后接 strong（wrapHtml 修剪其内容，产物中不再有空白）', '<p>甲<code>x </code><strong><img> 乙</strong></p>', '甲`x`<strong>乙</strong>',
        [text('甲'), code('x'), text('乙', 'strong')]],
    ['后接链接（链接文字保留前导空格）', `<p>甲<code>x </code><a href="${LINK_URL}"><img> 乙</a></p>`, '甲`x`[ 乙](' + LINK_URL + ')',
        [text('甲'), code('x'), text('乙', 'link')]],
    ['值含内部空格', '<p>甲<code>a b </code><samp><img> 乙</samp></p>', '甲`a b` 乙', [text('甲'), code('a b'), text('乙')]],
    ['值以反引号结尾', '<p>甲<code>a` </code><samp><img> 乙</samp></p>', '甲`` a` `` 乙', [text('甲'), code('a`'), text('乙')]],
    ['处在链接内', `<p><a href="${LINK_URL}">甲<code>x </code><samp><img> 乙</samp></a></p>`, '[甲`x` 乙](' + LINK_URL + ')',
        [text('甲', 'link'), code('x', 'link'), text('乙', 'link')]],
    ['处在 strong 内', '<p><strong>甲<code>x </code><samp><img> 乙</samp></strong></p>', '<strong>甲`x` 乙</strong>',
        [text('甲', 'strong'), code('x', 'strong'), text('乙', 'strong')]],
    ['列表项内', '<ul><li>甲<code>x </code><samp><img> 乙</samp></li></ul>', '-   甲`x` 乙', [text('甲'), code('x'), text('乙')]],
    ['后接相邻代码（两段之间隔着 samp 内代码的前导空格）', '<p><code>x </code><samp><img><code> y</code></samp></p>', '`x` `y`', [code('x'), code('y')]],
    ['code 内以 img 结尾，后接以空格开头的文本', '<p>甲<code>x <img></code> 乙</p>', '甲`x` 乙', [text('甲'), code('x'), text('乙')]],
    ['镜像：值首部空格前接以空格与 img 结尾的 samp', '<p><samp>甲 <img></samp><code> x</code>乙</p>', '甲 `x`乙', [text('甲'), code('x'), text('乙')]],
    ['镜像：code 内以 img 开头，前接以空格结尾的文本', '<p>甲 <code><img> x</code>乙</p>', '甲 `x`乙', [text('甲'), code('x'), text('乙')]],
    ['首尾两侧都被舍弃', '<p><samp>甲 <img></samp><code> x </code><samp><img> 乙</samp></p>', '甲 `x` 乙', [text('甲'), code('x'), text('乙')]],
    ['只含空白与 void 元素的 code（空白被舍弃后内容为空，整段不输出）', '<p><samp>甲 <img></samp><code><img> </code>乙</p>', '甲 乙',
        [text('甲'), text('乙')]],
];

test('已列形态：邻居已有空白时代码值首尾被舍弃的空白不再留在围栏之内，全链路解析后代码值与片段序列与期望一致', async () => {
    const failures = [];
    for (const [name, html, markdown, expected] of LISTED_FORMS) {
        // Act
        const actualMarkdown = toMarkdown(html);
        const problem = problemOf(flatten(await toIr(html)), expected);

        // Assert（汇总后统一断言，每种形态至多记一条，失败时列出全部不符的形态）
        const problems = [];
        if (actualMarkdown !== markdown) problems.push(`Markdown ${JSON.stringify(actualMarkdown)}，期望 ${JSON.stringify(markdown)}`);
        if (problem) problems.push(problem);
        if (problems.length) failures.push(`${name}：${problems.join('；')}`);
    }
    reportFailures(failures, LISTED_FORMS.length);
});

// ============================================================
// 端到端：parsers/url 的 parse() 与 md 渲染器
// ============================================================

const E2E_BODY = [
    '<p>甲<code>x </code><samp><img> 乙</samp></p>',
    '<p><samp>丙 <img></samp><code> y</code>丁</p>',
    '<p><kbd>戊 <wbr></kbd><code> z </code><kbd><wbr> 己</kbd></p>',
].join('\n');
const E2E_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>代码值空白</title></head><body><div id="js_content">${E2E_BODY}</div></body></html>`;

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

test('端到端：网页正文中邻居已有空白的代码值进入 IR 后不含首尾空白，md 渲染器的产物中围栏紧贴代码值', async (t) => {
    // Arrange：经 _setLookup 把 mp.weixin.qq.com 解析到本机，站点选择器按主机名命中，正文原样取出
    const server = await startPageServer(E2E_PAGE);
    t.after(() => server.close());
    _setLookup(async () => [{ address: '127.0.0.1', family: 4 }]);
    t.after(() => _setLookup(null));

    // Act
    const doc = await parse({ url: `http://mp.weixin.qq.com:${server.port}/mp.weixin.qq.com/s/edge-space` }, { allowPrivateNetwork: true, skipImages: true });
    const paragraphs = doc.ir.children.filter((node) => node.type === 'paragraph');
    const md = await mdRenderer.render(doc);

    // Assert：IR
    assert.equal(paragraphs.length, 3, JSON.stringify(doc.ir));
    const expectations = [
        [text('甲'), code('x'), text('乙')],
        [text('丙'), code('y'), text('丁')],
        [text('戊'), code('z'), text('己')],
    ];
    paragraphs.forEach((paragraph, i) => {
        const problem = problemOf(flatten(paragraph), expectations[i]);
        assert.equal(problem, null, `第 ${i + 1} 段：${problem}`);
    });
    // Assert：md 渲染器
    for (const fragment of ['`x`', '`y`', '`z`']) assert.ok(md.includes(fragment), md);
    for (const fragment of ['`x `', '` y`', '` z `']) assert.ok(!md.includes(fragment), md);
});

// ============================================================
// 矩阵
// ============================================================

// 代码值与期望值；方位决定在值的哪一侧补空格
const MATRIX_VALUES = [['x', 'x'], ['a b', 'a b'], ['a`', 'a`'], ['`a', '`a'], ['中文', '中文'], [BACKSLASH, BACKSLASH], ['<!---->', '<!---->']];
// 邻居标签与其格式类型（透传元素为 null）
const MATRIX_NEIGHBORS = [
    ['samp', null], ['span', null], ['kbd', null], ['u', null], ['tt', null], ['var', null], ['small', null], ['cite', null],
    ['q', null], ['abbr', null], ['font', null], ['strong', 'strong'], ['em', 'emphasis'], ['del', 'delete'], ['sup', 'superscript'],
    ['sub', 'subscript'], ['a', 'link'],
];
const MATRIX_VOIDS = ['<img>', '<wbr>'];
const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const openTag = (tag) => (tag === 'a' ? `<a href="${LINK_URL}">` : `<${tag}>`);
// 方位：[名称, 代码值 => 源值, 左邻, 右邻]；左邻以「甲 + 空格 + void」结尾，右邻以「void + 空格 + 乙」开头
const MATRIX_SIDES = [
    ['末尾', (v) => `${v} `, false, true],
    ['首部', (v) => ` ${v}`, true, false],
    ['首尾', (v) => ` ${v} `, true, true],
];
// 语境：[名称, 段内 HTML => 整段 HTML, 格式集合]
const MATRIX_CONTEXTS = [
    ['段落直属', (s) => `<p>${s}</p>`, []],
    ['列表项内', (s) => `<ul><li>${s}</li></ul>`, []],
    ['strong 内', (s) => `<p><strong>${s}</strong></p>`, ['strong']],
    ['链接内', (s) => `<p><a href="${LINK_URL}">${s}</a></p>`, ['link']],
];

test('矩阵：7 种代码值 × 17 种邻居标签 × 2 种 void 元素 × 3 种方位 × 4 种语境，代码值不含被舍弃的空白', async () => {
    const failures = [];
    let total = 0;
    for (const [ctxName, build, formats] of MATRIX_CONTEXTS) {
        for (const [tag, type] of MATRIX_NEIGHBORS) {
            // 链接之内不再嵌套链接：HTML 解析器遇到嵌套的 <a> 开标签会先关闭外层
            if (tag === 'a' && formats.includes('link')) continue;
            const neighborFormats = type && !formats.includes(type) ? [...formats, type] : formats;
            for (const voidTag of MATRIX_VOIDS) {
                for (const [sideName, withSpaces, left, right] of MATRIX_SIDES) {
                    for (const [value, expectedValue] of MATRIX_VALUES) {
                        total += 1;
                        const leftHtml = left ? `${openTag(tag)}甲 ${voidTag}</${tag}>` : '甲';
                        const rightHtml = right ? `${openTag(tag)}${voidTag} 乙</${tag}>` : '乙';
                        const html = build(`${leftHtml}<code>${escapeHtml(withSpaces(value))}</code>${rightHtml}`);
                        const expected = [
                            text('甲', ...(left ? neighborFormats : formats)),
                            code(expectedValue, ...formats),
                            text('乙', ...(right ? neighborFormats : formats)),
                        ];

                        // Act
                        const problem = problemOf(flatten(await toIr(html)), expected);

                        // Assert（汇总）
                        if (problem) failures.push(`${ctxName} / ${tag} / ${voidTag} / ${sideName} / ${JSON.stringify(html)}：${problem}`);
                    }
                }
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
    ['末尾空格后接文本（折叠已删去文本的前导空格）', '<p>甲<code>x </code> 乙</p>', '甲`x` 乙'],
    ['末尾空格后接无前导空白的 samp', '<p>甲<code>x </code><samp>乙</samp></p>', '甲`x` 乙'],
    ['末尾空格后接 void 元素（右邻 textContent 为空，不判夹住）', '<p>甲<code>x </code><img> 乙</p>', '甲`x`  乙'],
    ['首部空格前接以空格结尾的文本（折叠已删去代码值的前导空格）', '<p>甲 <code> x</code>乙</p>', '甲 `x`乙'],
    ['首尾空格两侧不被夹住', '<p>甲<code> x </code>乙</p>', '甲 `x` 乙'],
    ['一侧保留、一侧舍弃（turndown 已 trim）', '<p><samp>甲 <img></samp><code> x </code>乙</p>', '甲 `x` 乙'],
    ['边缘为不换行空格（非 ASCII 空白照常移出）', '<p>甲<code>x&nbsp;</code><samp><img> 乙</samp></p>', '甲`x`' + NBSP + ' 乙'],
    ['嵌套 code（内层是外层代码段的原文，不动）', '<p><code>a<code>b </code><samp><img> c</samp></code></p>', '``a`b ` c``'],
    ['只含空白的 code（空白节点，交 blankRule）', '<p>甲<code> </code>乙</p>', '甲 乙'],
];

test('回归护栏：turndown 本已处理的形态与嵌套 code 的产物逐字不变；word 与 basic profile 不受影响', () => {
    const failures = [];
    for (const [name, html, markdown] of GUARD_FORMS) {
        // Act
        const actual = toMarkdown(html);

        // Assert（汇总）
        if (actual !== markdown) failures.push(`${name}：${JSON.stringify(actual)}，期望 ${JSON.stringify(markdown)}`);
    }
    // word 与 basic profile：仍用内置 code 规则，产物维持原样
    for (const profile of ['basic', 'word']) {
        const actual = toMarkdown('<p>甲<code>x </code><samp><img> 乙</samp></p>', profile);
        if (actual !== '甲`x ` 乙') failures.push(`${profile} profile：${JSON.stringify(actual)}`);
    }
    reportFailures(failures, GUARD_FORMS.length + 2);
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
const RANDOM_CODE_VALUES = ['x', 'ab', '中文', 'a`', '`a', 'a b', BACKSLASH, '*x*', '<b>', '&'];
const RANDOM_TEXTS = ['甲', '乙', '文本', 'x', '，', '`', '*', '_', '['];
const RANDOM_VOIDS = ['<img>', '<wbr>', '<img alt="图">'];
const RANDOM_ZW = [ZWSP, ZWJ, BOM];
const RANDOM_TRANSPARENT = ['span', 'samp', 'kbd', 'u', 'tt', 'var', 'small', 'cite', 'q', 'abbr'];
const RANDOM_FORMATS = [['strong', 'strong'], ['b', 'strong'], ['em', 'emphasis'], ['i', 'emphasis'], ['del', 'delete'], ['sup', 'superscript'],
    ['sub', 'subscript'], ['a', 'link']];

/** 段落模型 → { html, frags }：代码值的期望为折叠空白、去掉首尾空白之后的结果，只含空白的按空白文本计 */
function randomParagraph(rand) {
    const pick = (list) => list[Math.floor(rand() * list.length)];
    const out = { html: '', frags: [] };
    const emitCode = (formats) => {
        const core = pick(RANDOM_CODE_VALUES);
        const r = rand();
        const value = r < 0.35 ? `${core} ` : (r < 0.6 ? ` ${core}` : (r < 0.8 ? ` ${core} ` : core));
        // 两成的代码在值的首或尾嵌一个 void 元素（code 内以 img 结尾或开头的形态）
        const inner = rand() < 0.2 ? (rand() < 0.5 ? `${escapeHtml(value)}${pick(RANDOM_VOIDS)}` : `${pick(RANDOM_VOIDS)}${escapeHtml(value)}`)
            : escapeHtml(value);
        out.html += `<code>${inner}</code>`;
        out.frags.push(code(value.trim(), ...formats));
    };
    const emitText = (formats) => {
        const v = pick(RANDOM_TEXTS);
        out.html += escapeHtml(v);
        out.frags.push(text(v, ...formats));
    };
    // 以「void + 空格」开头或以「空格 + void」结尾的邻居：透传元素或格式元素包着文本
    const emitNeighbor = (formats, inA) => {
        let tag;
        let type = null;
        if (rand() < 0.6) tag = pick(RANDOM_TRANSPARENT);
        else {
            [tag, type] = pick(RANDOM_FORMATS);
            while (inA && tag === 'a') [tag, type] = pick(RANDOM_FORMATS);
        }
        const next = type && !formats.includes(type) ? [...formats, type] : formats;
        out.html += tag === 'a' ? `<a href="${LINK_URL}">` : `<${tag}>`;
        if (rand() < 0.5) {
            out.html += `${pick(RANDOM_VOIDS)} `;
            emitText(next);
        } else {
            emitText(next);
            out.html += ` ${pick(RANDOM_VOIDS)}`;
        }
        out.html += `</${tag}>`;
    };
    const seq = (length, depth, formats, inA) => {
        for (let i = 0; i < length; i += 1) {
            const r = rand();
            if (r < 0.35) emitCode(formats);
            else if (r < 0.6) emitNeighbor(formats, inA);
            else if (r < 0.75) emitText(formats);
            else if (r < 0.8) out.html += ' ';
            else if (r < 0.84) out.html += pick(RANDOM_VOIDS);
            else if (r < 0.88) out.html += pick(RANDOM_ZW);
            else if (depth < 2 && r < 0.95) {
                let [tag, type] = pick(RANDOM_FORMATS);
                while (inA && tag === 'a') [tag, type] = pick(RANDOM_FORMATS);
                const next = formats.includes(type) ? formats : [...formats, type];
                out.html += tag === 'a' ? `<a href="${LINK_URL}">` : `<${tag}>`;
                // 格式元素至少含一项可见文本，免得整个元素产物为空、标签不输出
                emitText(next);
                seq(1 + Math.floor(rand() * 3), depth + 1, next, inA || tag === 'a');
                out.html += `</${tag}>`;
            } else if (depth < 2) {
                const tag = pick(RANDOM_TRANSPARENT);
                out.html += `<${tag}>`;
                seq(1 + Math.floor(rand() * 3), depth + 1, formats, inA);
                out.html += `</${tag}>`;
            } else emitText(formats);
        }
    };
    seq(2 + Math.floor(rand() * 5), 0, [], false);
    emitText([]);
    return { html: `<p>${out.html}</p>`, frags: out.frags };
}

test('种子随机：1500 个含首尾带空格代码与 void 邻居的段落，全链路解析后片段序列与期望一致', async () => {
    // Arrange
    const rand = seededRandom(RANDOM_SEED);
    const paragraphs = Array.from({ length: RANDOM_COUNT }, () => randomParagraph(rand));

    // Act
    const failures = [];
    for (const [i, paragraph] of paragraphs.entries()) {
        const problem = problemOf(flatten(await toIr(paragraph.html)), paragraph.frags);
        if (problem) failures.push(`#${i} ${JSON.stringify(paragraph.html)}：${problem}`);
    }

    // Assert
    reportFailures(failures, RANDOM_COUNT);
});
