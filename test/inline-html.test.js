/**
 * converters/ir/inline-html.js 单元测试
 * 覆盖：<img> 提升（块级与行内、宽高与百分比、style 宽度、属性白名单）、src 协议白名单（脚本协议、实体编码与
 *       控制字符绕过、协议相对与绝对路径）、<u>/<strong|b>/<em|i>/<del|s>/<br> 配对提升、未配对标签删除留文本、
 *       同类嵌套拍平与相邻合并、只包图片的格式标签拆除、<figure>/<p> 包图与 figcaption 图注、其它 HTML 保留、
 *       无可提升内容时返回原引用、入参不变；
 *       matchImgTag 的 <img> 标签识别在 8 万个空格长段上的耗时上限，与线性化之前的实现逐字等价（差分）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadUnified } = require('../converters/ir/unified-loader');
const { liftInlineHtml, decodeEntities } = require('../converters/ir/inline-html');

async function parseMarkdown(md) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    return unified().use(remarkParse).use(remarkGfm).parse(md);
}

async function lift(md, options) {
    return liftInlineHtml(await parseMarkdown(md), options);
}

function collect(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) for (const child of node.children) collect(child, predicate, out);
    return out;
}

const images = (tree) => collect(tree, (n) => n.type === 'image');
const htmls = (tree) => collect(tree, (n) => n.type === 'html').map((n) => n.value);

// ============================================================
// <img>
// ============================================================

test('独占一行的 <img> 提升为段落中的 image 节点，宽度记入 data.display', async () => {
    // Act
    const tree = await lift('<img src="images/a.png" width="300" alt="示意 &amp; 说明" title="标题">\n\n正文\n', { source: 'html' });

    // Assert
    assert.equal(tree.children[0].type, 'paragraph');
    const [image] = tree.children[0].children;
    assert.deepEqual(image, {
        type: 'image', url: 'images/a.png', alt: '示意 & 说明', title: '标题',
        data: { display: { width: 300, unit: 'px', source: 'html' } },
    });
    assert.deepEqual(htmls(tree), []);
});

test('行内 <img>：宽高都是 px 时记 height；百分比宽度记为 %；style 中的 width:Npx 同样认', async () => {
    // Act
    const tree = await lift([
        '甲<img src="a.png" width="120" height="60">乙',
        '',
        '丙<img src="b.png" width="50%" height="40">丁',
        '',
        '戊<img src="c.png" style="height: 30px; width: 88.6px">己',
        '',
    ].join('\n'), { source: 'web' });

    // Assert
    const displays = images(tree).map((n) => n.data && n.data.display);
    assert.deepEqual(displays, [
        { width: 120, height: 60, unit: 'px', source: 'web' },
        { width: 50, unit: '%', source: 'web' },
        { width: 89, height: 30, unit: 'px', source: 'web' },
    ]);
    assert.deepEqual(tree.children[0].children.map((n) => n.type), ['text', 'image', 'text']);
});

test('不合规的宽度不记 display；白名单外的属性（onerror、class）一律丢弃', async () => {
    // Act
    const tree = await lift('<img src="a.png" width="300px" onerror="alert(1)" class="x" data-foo="1">\n');

    // Assert
    const [image] = images(tree);
    assert.deepEqual(Object.keys(image).sort(), ['alt', 'title', 'type', 'url']);
    assert.equal(image.url, 'a.png');
    assert.equal(JSON.stringify(tree).includes('alert'), false);
});

test('src 协议白名单：脚本协议、实体编码与控制字符绕过、协议相对地址与绝对路径均不提升，原样保留为 html', async () => {
    // Arrange
    const rejected = [
        '<img src="javascript:alert(1)">',
        '<img src="JaVaScRiPt:alert(1)">',
        '<img src="&#106;avascript:alert(1)">',
        '<img src="java&#x09;script:alert(1)">',
        '<img src="vbscript:msgbox(1)">',
        '<img src="data:text/html;base64,PHNjcmlwdD4=">',
        '<img src="//evil.example/x.png">',
        '<img src="/etc/passwd">',
        '<img src="file:///etc/passwd">',
        '<img width="10">',
    ];

    for (const tag of rejected) {
        // Act
        const tree = await lift(`${tag}\n`);

        // Assert
        assert.equal(images(tree).length, 0, tag);
        assert.equal(htmls(tree).length, 1, tag);
    }
});

test('src 白名单放行相对路径、http(s) 与 data:image/*', async () => {
    // Act
    const tree = await lift([
        '<img src="images/图 片.png">', '',
        '<img src="https://example.com/a.png?x=1&amp;y=2">', '',
        '<img src="data:image/png;base64,iVBORw0KGgo=">', '',
    ].join('\n'));

    // Assert
    assert.deepEqual(images(tree).map((n) => n.url), [
        'images/图 片.png',
        'https://example.com/a.png?x=1&y=2',
        'data:image/png;base64,iVBORw0KGgo=',
    ]);
});

test('src 白名单拒绝 data:image/svg+xml（含大小写、base64、charset 与实体编码变体），data:image/png 仍放行', async () => {
    // Arrange
    const rejected = [
        '<img src="data:image/svg+xml,%3Csvg%2F%3E">',
        '<img src="DATA:IMAGE/SVG+XML,%3Csvg%2F%3E">',
        '<img src="data:image/svg+xml;base64,PHN2Zy8+">',
        '<img src="data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E">',
        '<img src="data:image/svg&#x2b;xml,%3Csvg%2F%3E">',
        '<img src="data:image/svg,%3Csvg%2F%3E">',
    ];

    for (const tag of rejected) {
        // Act
        const tree = await lift(`${tag}\n`);

        // Assert
        assert.equal(images(tree).length, 0, tag);
        assert.equal(htmls(tree).length, 1, tag);
    }

    // Act
    const allowed = await lift('<img src="data:image/png;base64,iVBORw0KGgo=">\n');

    // Assert
    assert.deepEqual(images(allowed).map((n) => n.url), ['data:image/png;base64,iVBORw0KGgo=']);
});

// ============================================================
// 行内格式标签
// ============================================================

test('成对的 <u>/<strong>/<b>/<em>/<i>/<del>/<s> 提升为对应节点，<br> 为 break', async () => {
    // Act
    const tree = await lift('<u>下划线</u>、<strong>粗</strong><b>体</b>、<em>斜</em><i>体</i>、<del>删</del><s>除</s>、甲<br>乙\n');
    const types = tree.children[0].children.map((n) => n.type);

    // Assert：相邻的同类节点已合并（<strong>粗</strong><b>体</b> → 一个 strong）
    assert.deepEqual(types, ['underline', 'text', 'strong', 'text', 'emphasis', 'text', 'delete', 'text', 'break', 'text']);
    const strong = tree.children[0].children[2];
    assert.deepEqual(strong.children, [{ type: 'text', value: '粗体' }]);
    assert.deepEqual(htmls(tree), []);
});

test('未配对的标签删除、保留其间文本；中途被关闭的开标签视为未配对', async () => {
    // Act
    const unclosed = await lift('前<u>没有闭合的下划线\n');
    const stray = await lift('多余的</strong>闭标签\n');
    const crossed = await lift('<u>甲<strong>乙</u>丙</strong>\n');

    // Assert
    assert.deepEqual(unclosed.children[0].children, [{ type: 'text', value: '前没有闭合的下划线' }]);
    assert.deepEqual(stray.children[0].children, [{ type: 'text', value: '多余的闭标签' }]);
    const crossedTypes = crossed.children[0].children.map((n) => n.type);
    assert.deepEqual(crossedTypes, ['underline', 'text']);
    assert.deepEqual(crossed.children[0].children[0].children, [{ type: 'text', value: '甲乙' }]);
});

test('同类嵌套拍平；只包着图片的格式标签直接拆除', async () => {
    // Act
    const nested = await lift('<strong>外<strong>内</strong>尾</strong>\n');
    const wrappedImage = await lift('<strong><img src="a.png" width="677"></strong>\n');

    // Assert
    const [strong] = nested.children[0].children;
    assert.equal(strong.type, 'strong');
    assert.deepEqual(strong.children, [{ type: 'text', value: '外内尾' }]);
    assert.deepEqual(wrappedImage.children[0].children.map((n) => n.type), ['image']);
});

test('链接与表格单元格内的行内 HTML 同样提升', async () => {
    // Act
    const tree = await lift('[<u>链接</u>](https://example.com)\n\n| A |\n| --- |\n| <strong>格</strong> |\n');

    // Assert
    const link = collect(tree, (n) => n.type === 'link')[0];
    assert.equal(link.children[0].type, 'underline');
    const cell = collect(tree, (n) => n.type === 'tableCell')[1];
    assert.equal(cell.children[0].type, 'strong');
});

test('成对的 <sup>/<sub> 提升为 superscript / subscript，可与加粗、下划线互相嵌套', async () => {
    // Act：化学式里的上下标（R²、C₁ 的烷基）与嵌套形态
    const tree = await lift('R<sup>2</sup>、C<sub>1</sub>的烷基、<strong>甲<sub><u>乙</u></sub></strong>\n');
    const children = tree.children[0].children;

    // Assert：上下标各成节点，文字逐字保留
    assert.deepEqual(children.map((n) => n.type), ['text', 'superscript', 'text', 'subscript', 'text', 'strong']);
    assert.equal(children[1].children[0].value, '2');
    assert.equal(children[3].children[0].value, '1');
    assert.deepEqual(htmls(tree), []);

    // Assert：<strong>甲<sub><u>乙</u></sub></strong> 的三层嵌套按原层次还原
    const [, subscript] = children[5].children;
    assert.equal(children[5].children[0].value, '甲');
    assert.equal(subscript.type, 'subscript');
    assert.equal(subscript.children[0].type, 'underline');
    assert.equal(subscript.children[0].children[0].value, '乙');
});

test('Markdown 输入的 ~~删除线~~ 与 ~删除线~ 仍解析为 delete 节点（remark-gfm 的 singleTilde 未被改动）', async () => {
    // Act
    const doubled = await lift('~~双波浪~~\n');
    const single = await lift('~单波浪~\n');

    // Assert
    for (const tree of [doubled, single]) {
        const [deleted] = tree.children[0].children;
        assert.equal(deleted.type, 'delete');
    }
    assert.equal(doubled.children[0].children[0].children[0].value, '双波浪');
    assert.equal(single.children[0].children[0].children[0].value, '单波浪');
});

test('相邻的同类上下标合并；未配对的 <sup>/<sub> 删标签留文本', async () => {
    // Act
    const merged = await lift('X<sup>1</sup><sup>2</sup>\n');
    const unpaired = await lift('前<sub>没有闭合的下标\n');

    // Assert
    const [, sup] = merged.children[0].children;
    assert.equal(sup.type, 'superscript');
    assert.deepEqual(sup.children, [{ type: 'text', value: '12' }]);
    assert.deepEqual(unpaired.children[0].children, [{ type: 'text', value: '前没有闭合的下标' }]);
});

// ============================================================
// 块级包裹
// ============================================================

test('<figure> 只包着 img 与 figcaption：拆成图片段落 + 图注段落（data.role = caption）', async () => {
    // Act
    const tree = await lift('<figure><img src="a.png" width="400"><figcaption>图 1 <b>示意</b>图</figcaption></figure>\n');

    // Assert
    assert.equal(tree.children.length, 2);
    assert.equal(tree.children[0].children[0].type, 'image');
    assert.deepEqual(tree.children[1], { type: 'paragraph', data: { role: 'caption' }, children: [{ type: 'text', value: '图 1 示意 图' }] });
});

test('<p> / <div> 只包着 img 与 br 时提升；夹杂其它内容时保留为 html', async () => {
    // Act
    const wrapped = await lift('<p align="center"><img src="a.png"><br><img src="b.png"></p>\n');
    const mixed = await lift('<div><img src="a.png"><span>文字</span></div>\n');

    // Assert
    assert.deepEqual(wrapped.children[0].children.map((n) => n.type), ['image', 'break', 'image']);
    assert.equal(images(mixed).length, 0);
    assert.equal(htmls(mixed).length, 1);
});

test('白名单外的 HTML（script、span、注释）保留为 html 节点，交渲染器剥离', async () => {
    // Act
    const tree = await lift('<script>alert(1)</script>\n\n正文<span style="x">甲</span>\n');

    // Assert
    assert.ok(htmls(tree).some((value) => value.includes('<script>')));
    assert.ok(htmls(tree).includes('<span style="x">'));
});

test('无可提升内容时返回原引用；入参树不被改动', async () => {
    // Arrange
    const plain = await parseMarkdown('# 标题\n\n**粗体** 正文\n');
    const withHtml = await parseMarkdown('<u>下划线</u>\n');
    const snapshot = JSON.stringify(withHtml);

    // Act
    const same = liftInlineHtml(plain);
    liftInlineHtml(withHtml);

    // Assert
    assert.equal(same, plain);
    assert.equal(JSON.stringify(withHtml), snapshot);
});

test('decodeEntities 解码命名与数字实体，未知实体原样保留', () => {
    assert.equal(decodeEntities('&lt;a&gt; &amp; &quot;&#39;&#x4E2D;&#25991; &copy;'), '<a> & "\'中文 &copy;');
});

// ============================================================
// matchImgTag：<img> 标签识别线性于串长（耗时上限与逐字等价）
// ============================================================

const { isDeepStrictEqual } = require('node:util');
const { matchImgTag } = require('../converters/ir/inline-html');

// 耗时用例的输入规模：「<img」与 src 属性之间夹 8 万个半角空格，这一长段之后还有属性，不处于标签尾部
const IMG_STRESS_LENGTH = 80000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。200 ms 使两侧余量都不小于 5 倍——
// 线性化之前的 IMG_RE 经 liftInlineHtml 在这一规模上实测约 2.4 至 3.1 秒（2 万、4 万时约 0.17、0.66 秒，耗时随段长平方
// 增长），是上限的 11 倍以上；线性化之后单次调用实测约 0.3 毫秒，不到上限的五百分之一
const IMG_STRESS_BUDGET_MS = 200;

const elapsedMsSince = (started) => Number(process.hrtime.bigint() - started) / 1e6;

// 宽义空白以码点生成，源码里不出现看不见的字面量
const NBSP = String.fromCharCode(0x00a0);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

// 逐码点列出，失败输出里的不可见字符也能看清
const toCodePoints = (value) => Array.from(value, (unit) => unit.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
// 捕获组的可读形式：字符串列出码点，未参与匹配者写 undefined，整体不匹配写 null
const describeGroup = (value) => (typeof value === 'string' ? `[${toCodePoints(value)}]` : String(value));
// 节点列表的简短形式：超过 40 字的字符串只报长度与首尾 3 字的码点，免得断言信息被 8 万字的整串淹没
const briefNodes = (nodes) => JSON.stringify(nodes, (key, value) => (typeof value === 'string' && value.length > 40
    ? `长 ${value.length}，首 [${toCodePoints(value.slice(0, 3))}]，尾 [${toCodePoints(value.slice(-3))}]`
    : value));

test('<img 与 src 之间的 8 万个空格不触发回溯：liftInlineHtml 单次调用在绝对上限内，输出逐字正确', (t) => {
    // Arrange：在计时区间外新构造字符串与树，段落里只有这一个 html 节点
    const tree = {
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'html', value: `<img${' '.repeat(IMG_STRESS_LENGTH)}src="a.png">` }] }],
    };
    const expected = [{ type: 'image', url: 'a.png', alt: '', title: null }];

    // Act：计时区间只包这一次调用
    const started = process.hrtime.bigint();
    const result = liftInlineHtml(tree);
    const elapsedMs = elapsedMsSince(started);
    t.diagnostic(`liftInlineHtml 实测 ${elapsedMs.toFixed(2)} ms`);

    // Assert：先验输出正确，以免「快」来自少做了事——长空白段之后的 src 照常识别，html 节点提升为 image 节点
    const children = result.children[0].children;
    if (!isDeepStrictEqual(children, expected)) assert.fail(`段落子节点不符：${briefNodes(children)}`);
    assert.ok(
        elapsedMs < IMG_STRESS_BUDGET_MS,
        `liftInlineHtml 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${IMG_STRESS_BUDGET_MS} ms`,
    );
});

// 线性化之前的实现，仅作短输入的差分参照：惰性的属性段与其后的 \s* 争抢同一段空白——属性段每向后扩一个记号，\s* 都把
// 余下的空白重扫一遍，耗时随空白段长平方增长，不可用于耗时用例的输入规模。ATTR_BODY 与 IMG_RE 照录旧文件
const LEGACY_ATTR_BODY = `(?:[^<>"']|"[^"]*"|'[^']*')*`;
const LEGACY_IMG_RE = new RegExp(`^<img\\b(${LEGACY_ATTR_BODY}?)\\s*\\/?>$`, 'i');

// 差分字母表 18 个记号：九种空白（半角空格、制表符、U+3000、U+00A0、U+FEFF、LF、CR、U+2028、U+2029），属性段的界符、
// 引号与等号，字母与数字
const HTML_DIFF_SPACES = [' ', '\t', IDEOGRAPHIC_SPACE, NBSP, BYTE_ORDER_MARK, '\n', '\r', LINE_SEPARATOR, PARAGRAPH_SEPARATOR];
const HTML_DIFF_ALPHABET = [...HTML_DIFF_SPACES, '/', '>', '<', '"', "'", '=', 'a', 'S', '1'];
// 结构化随机串的属性记号：无引号值；双引号与单引号段（段内含空白、另一种引号、< 与 >）；孤立的名、等号与斜杠；
// 以及使属性段不合法的未闭合引号与裸 < >
const HTML_DIFF_ATTR_TOKENS = [
    'src=a.png', 'src="a b.png"', "alt='甲 乙'", 'title="a>b<c"', `alt='say "hi"'`, `x="'"`, 'width=10', 'd', '=', '/', 'f=g/',
    '"unclosed', "'", 'e="', '<', '>',
];
// 结构化随机串的结尾片段：>、/>、空，以及 > 前后的多余字符
const HTML_DIFF_ENDINGS = ['>', '>', '>', '>', '/>', '', 'x', '>>', '>x', '">', '<>'];
// <img> 差分的前缀片段：合规写法（大小写不一）、\b 不成立的 <imgx 一类、不完整的 <im、带前导空白或缺尖括号者
const IMG_DIFF_PREFIXES = [
    '<img', '<img', '<img', '<IMG', '<Img', '<imgx', '<im', '<img_', '<img1', '<img-', '<img/', '<img"', 'img', '<', '', ' <img', '< img',
];
// <img> 差分的典型样本，六类分支各举数例：前缀不符；不以「>」结尾；匹配且属性段为空；匹配且属性段含引号段；
// 以「/>」结尾而匹配；属性段不合法（未闭合引号、裸 < 或 >）而不匹配
const IMG_TYPICAL_SAMPLES = [
    '<imgx>', '<im>', '<img_ src=a>', 'img src=a>', ' <img src=a>',
    '<img src=a', '<img src=a> ', '<img src="a>',
    '<img>', '<IMG/>', '<img \n />', `<Img\t${IDEOGRAPHIC_SPACE}>`,
    `<img src="a b.png" alt='甲 "乙"'>`, '<img title="a>b<c">',
    '<img src=a.png/>', '<img src=a.png / >', '<img src="a.png"//>',
    '<img src="a.png>', "<img alt='x>", '<img <src=a>', '<img src=a>>', '<img >x>',
];
// 分支归类用的前缀判据，在测试内独立求得：「<img」（不区分大小写）之后不是单词字符 [A-Za-z0-9_]，即旧式的 \b 成立
const IMG_DIFF_HEAD_RE = /^<img(?![A-Za-z0-9_])/i;

// 字母表上由 0 到 maxLength 个记号拼成的全部字符串
function everyStringUpTo(maxLength, alphabet) {
    const all = [''];
    let level = [''];
    for (let length = 1; length <= maxLength; length += 1) {
        level = level.flatMap((prefix) => alphabet.map((token) => prefix + token));
        for (const item of level) all.push(item);
    }
    return all;
}

// 种子固定的 32 位伪随机数发生器（mulberry32）：每次运行抽到同一批样本，失败可原样复现
function createSeededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = Math.imul(state ^ (state >>> 15), state | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

// 结构化随机串：前缀片段 + 0 到 3 个「0 到 2 个空白 + 属性记号」+ 0 到 3 个空白 + 可选「/」+ 结尾片段
function randomStructuredTag(random, prefixes) {
    const pick = (items) => items[Math.floor(random() * items.length)];
    const spaces = (max) => Array.from({ length: Math.floor(random() * (max + 1)) }, () => pick(HTML_DIFF_SPACES)).join('');
    let text = pick(prefixes);
    for (let count = Math.floor(random() * 4); count > 0; count -= 1) text += spaces(2) + pick(HTML_DIFF_ATTR_TOKENS);
    return text + spaces(3) + (random() < 0.4 ? '/' : '') + pick(HTML_DIFF_ENDINGS);
}

test('matchImgTag 与线性化之前的 IMG_RE 逐组等价：BMP 逐码元、穷举短串与种子固定的随机串，六类分支均有样本', (t) => {
    // Arrange：典型样本在前
    const samples = [...IMG_TYPICAL_SAMPLES];
    // BMP 逐码元 262144 个：每个码元放进四个对空白敏感的位置——紧接「<img」（\b 与属性段起点）、属性值之后、「/>」之前、
    // 「/」与「>」之间，新式所用的 trimEnd 与旧式的 \s 字符集多一个或少一个都会暴露
    for (let code = 0; code <= 0xffff; code += 1) {
        const unit = String.fromCharCode(code);
        samples.push(`<img${unit}>`, `<img${unit}src=a${unit}/>`, `<img src=a${unit}>`, `<img src=a/${unit}>`);
    }
    // 穷举 24700 个：「<img」「<IMG」各接字母表上由 0 到 3 个记号拼成的全部字符串，不补与补一个「>」两种形态各一
    for (const head of ['<img', '<IMG']) {
        for (const rest of everyStringUpTo(3, HTML_DIFF_ALPHABET)) samples.push(head + rest, `${head}${rest}>`);
    }
    const random = createSeededRandom(20260923);
    const pick = (items) => items[Math.floor(random() * items.length)];
    // 一般随机串 30000 个：前缀片段后接字母表上 0 到 12 个记号
    for (let i = 0; i < 30000; i += 1) {
        samples.push(pick(IMG_DIFF_PREFIXES) + Array.from({ length: Math.floor(random() * 13) }, () => pick(HTML_DIFF_ALPHABET)).join(''));
    }
    // 结构化随机串 40000 个：贴近真实 <img> 标签的骨架，见 randomStructuredTag
    for (let i = 0; i < 40000; i += 1) samples.push(randomStructuredTag(random, IMG_DIFF_PREFIXES));
    assert.equal(samples.length, IMG_TYPICAL_SAMPLES.length + 356844);

    // Act & Assert
    const counts = { prefixMismatch: 0, unterminated: 0, emptyBody: 0, quotedBody: 0, selfClosing: 0, invalidBody: 0 };
    for (const sample of samples) {
        const legacy = LEGACY_IMG_RE.exec(sample);
        const expected = legacy ? legacy[1] : null;
        const actual = matchImgTag(sample);
        // 只在不一致时拼装诊断信息，免得数十万次调用都付这笔开销
        if (actual !== expected) assert.fail(`输入 [${toCodePoints(sample)}]：新式 ${describeGroup(actual)}，旧式 ${describeGroup(expected)}`);
        // 分支归类只用旧式的结果与测试内独立求得的输入特征
        if (!IMG_DIFF_HEAD_RE.test(sample)) counts.prefixMismatch += 1;
        else if (!sample.endsWith('>')) counts.unterminated += 1;
        else if (expected === null) counts.invalidBody += 1;
        else {
            if (expected === '') counts.emptyBody += 1;
            if (/["']/.test(expected)) counts.quotedBody += 1;
            if (sample.endsWith('/>')) counts.selfClosing += 1;
        }
    }
    // 覆盖自证：六类分支都须有样本，差分才不是对某一分支空转
    t.diagnostic(`样本 ${samples.length} 个；前缀不符 ${counts.prefixMismatch}，不以「>」结尾 ${counts.unterminated}，`
        + `匹配且属性段为空 ${counts.emptyBody}，匹配且属性段含引号段 ${counts.quotedBody}，以「/>」结尾而匹配 ${counts.selfClosing}，`
        + `属性段不合法而不匹配 ${counts.invalidBody}`);
    assert.ok(counts.prefixMismatch > 0, '没有前缀不符的样本');
    assert.ok(counts.unterminated > 0, '没有不以「>」结尾的样本');
    assert.ok(counts.emptyBody > 0, '没有匹配且属性段为空的样本');
    assert.ok(counts.quotedBody > 0, '没有匹配且属性段含引号段的样本');
    assert.ok(counts.selfClosing > 0, '没有以「/>」结尾而匹配的样本');
    assert.ok(counts.invalidBody > 0, '没有属性段不合法而不匹配的样本');
});
