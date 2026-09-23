/**
 * converters/web/noise.js 与 converters/web/normalize.js 单元测试
 *
 * 噪声清洗按规则逐条覆盖：class/id 令牌规则（含「不得误伤」的反例）、引导文案规则、
 * 结构规则（连续 br、空元素）、以及防止整篇正文被误删的安全阀。
 * 文本规范化覆盖零宽字符、不换行空格、行尾空白与多余空行。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { cleanNoise, tokensOf } = require('../converters/web/noise');
const { normalizeMarkdown } = require('../converters/web/normalize');

// 正文段落：长到足以让安全阀不触发（清洗对象须占比不超过一半）
const BODY = '<p>正文段落，内容足够长，用来充当被保留的主体部分，避免触发整体误删的安全阀。'
    + '这里再补一句同样属于正文的话，让正文明显长于被清洗的噪声块。</p>';

const clean = (fragment) => cleanNoise(`<div class="post">${BODY}${fragment}</div>`);

// ============================================================
// 令牌化
// ============================================================

test('tokensOf 拆分连字符、下划线与驼峰，且不把 shared 拆出 share', () => {
    // Act & Assert
    assert.deepEqual(tokensOf('social-share shareBtn_2'), ['social', 'share', 'share', 'btn', '2']);
    assert.deepEqual(tokensOf('shared-content'), ['shared', 'content']);
    assert.deepEqual(tokensOf(''), []);
    assert.deepEqual(tokensOf(null), []);
});

// ============================================================
// 规则一：class/id 令牌
// ============================================================

const ATTR_CASES = [
    ['分享栏 class', '<div class="social-share"><a href="#">微博</a></div>', '微博'],
    ['分享栏驼峰 class', '<div class="shareBtn">分享按钮</div>', '分享按钮'],
    ['分享栏 id', '<div id="share_box">分享盒子</div>', '分享盒子'],
    ['推荐位', '<section class="recommend-list">推荐条目</section>', '推荐条目'],
    ['相关阅读', '<ul class="related-posts"><li>相关文章</li></ul>', '相关文章'],
    ['评论区 id', '<div id="comments"><p>某条评论</p></div>', '某条评论'],
    ['评论区第三方组件', '<div class="gitalk-container">评论组件</div>', '评论组件'],
    ['面包屑', '<nav class="breadcrumb">首页 &gt; 分类</nav>', '首页'],
    ['广告位', '<div class="ad-banner">广告内容</div>', '广告内容'],
    ['广告位 adsbygoogle', '<ins class="adsbygoogle">广告位</ins>', '广告位'],
    ['订阅引导', '<div class="newsletter-signup">订阅邮件</div>', '订阅邮件'],
    ['二维码区块', '<div class="qrcode-wrap">扫我</div>', '扫我'],
    ['页内目录', '<div class="toc">目录条目</div>', '目录条目'],
    ['作者卡片', '<div class="author-card">作者简介文字</div>', '作者简介文字'],
    ['上下篇导航', '<div class="post-nav">上一篇</div>', '上一篇'],
];

for (const [name, fragment, marker] of ATTR_CASES) {
    test(`噪声选择器规则删除：${name}`, () => {
        // Act
        const result = clean(fragment);

        // Assert
        assert.ok(!result.includes(marker), `「${marker}」应被删除，实际：${result}`);
        assert.ok(result.includes('正文段落'), '正文必须保留');
    });
}

test('令牌相近但语义不同的 class 不被误伤', () => {
    // Arrange：shared / adapter / commentary 都含噪声词的子串，但令牌不同
    const fragment = '<div class="shared-content">共享内容</div>'
        + '<div class="adapter-box">适配器说明</div>'
        + '<div class="commentary">评述文字</div>'
        + '<div class="showcase">展示区</div>';

    // Act
    const result = clean(fragment);

    // Assert
    for (const kept of ['共享内容', '适配器说明', '评述文字', '展示区']) {
        assert.ok(result.includes(kept), `「${kept}」不应被删除，实际：${result}`);
    }
});

test('安全阀：命中规则但占据正文过半的容器保留不删', () => {
    // Arrange：整篇正文都装在一个 class 含 related 的容器里
    const html = '<div class="related-wrapper"><p>这是整篇文章的正文，容器 class 恰好命中噪声规则，'
        + '若直接删除会把全文清空，安全阀必须拦下这次删除。</p></div>';

    // Act
    const result = cleanNoise(html);

    // Assert
    assert.ok(result.includes('这是整篇文章的正文'), '占比过半的容器不得被删');
});

// ============================================================
// 规则二：引导文案
// ============================================================

const TEXT_CASES = [
    ['点击上方蓝字', '<p>点击上方蓝字关注我们</p>'],
    ['关注公众号', '<p>关注我们，获取更多内容</p>'],
    ['欢迎点赞转发', '<p>欢迎点赞、转发、在看</p>'],
    ['长按识别二维码', '<p>长按识别下方二维码<img src="/qr.png" alt="二维码"></p>'],
    ['扫码进群', '<p>扫码进群交流</p>'],
    ['转载声明', '<p>转载请注明出处。</p>'],
    ['未经授权禁止转载', '<p>未经授权不得转载</p>'],
    ['首发声明', '<p>本文首发于个人博客</p>'],
    ['版权声明', '<p>版权声明：本文遵循 CC 协议</p>'],
    ['阅读原文', '<p>点击阅读原文查看详情</p>'],
    ['推荐阅读栏目', '<p>推荐阅读</p>'],
    ['文末在看', '<p>点个在看</p>'],
];

for (const [name, fragment] of TEXT_CASES) {
    test(`噪声文案规则删除：${name}`, () => {
        // Act
        const result = clean(fragment);

        // Assert：整段连同其中的二维码图片一起消失
        assert.ok(!/<p>/.test(result.replace(/<p>正文段落[\s\S]*?<\/p>/, '')), `引导语段落应被删除，实际：${result}`);
        assert.ok(!result.includes('/qr.png'), '引导语里的二维码图片应一并删除');
    });
}

test('含引导词但属于正文论述的长段落不被删除', () => {
    // Arrange：句子里出现「转载」，但整段是正常论述且超过长度阈值
    const fragment = '<p>关于转载请注明出处这条约定，社区内部一直存在争论，本文尝试从版权法与'
        + '社区惯例两个角度展开分析，并给出一个可操作的建议清单供读者参考使用。</p>';

    // Act
    const result = clean(fragment);

    // Assert
    assert.ok(result.includes('社区内部一直存在争论'), '超过长度阈值的论述段落不应被删');
});

// ============================================================
// 规则三：结构
// ============================================================

test('连续 br 削减为两个，空元素被迭代删除', () => {
    // Arrange
    const html = '<div><p>甲<br><br><br><br>乙</p><p></p><div><span>   </span></div>'
        + '<div><img src="/a.png"></div><p><br></p></div>';

    // Act
    const result = cleanNoise(html);

    // Assert
    assert.equal((result.match(/<br>/g) || []).length, 2, `连续 br 应削减为 2 个，实际：${result}`);
    assert.ok(result.includes('<img src="/a.png">'), '只含图片的容器不算空，必须保留');
    assert.ok(!result.includes('<span>'), '只含空白的 span 应被删除');
    assert.ok(!/<p><\/p>/.test(result), '空段落应被删除');
});

test('只包着 <br> 的行内元素拆包保留换行；只含不换行空格或全角空格的行内元素保留；块级间隔段落仍删除', () => {
    // Arrange：微信把换行写成 <span leaf><br></span>，把段首缩进写成只含 NBSP 的 span（全角空格以码点生成）
    const ideo = String.fromCharCode(0x3000);
    const html = '<div><p>甲<span leaf=""><br></span>乙</p><section><span leaf=""><br></span></section>'
        + `<p><span>&nbsp;&nbsp;</span>丙</p><p><span>${ideo}${ideo}</span>丁</p><p><a href="#"><br></a>戊</p><p>&nbsp;</p></div>`;

    // Act
    const result = cleanNoise(html);

    // Assert
    assert.ok(result.includes('甲<br>乙'), `只包 br 的 span 应拆包，实际：${result}`);
    assert.ok(!result.includes('<section'), `只剩 br 的块级间隔应删除，实际：${result}`);
    assert.match(result, /<span>(?:&nbsp;|\xA0){2}<\/span>丙/, '只含 NBSP 的 span 应保留');
    assert.match(result, new RegExp(`<span>${ideo}${ideo}</span>丁`), '只含全角空格的 span 应保留');
    assert.ok(result.includes('<p><br>戊</p>'), `只包 br 的 a 应拆包，实际：${result}`);
    assert.ok(!/<p>(?:&nbsp;|\xA0)<\/p>/.test(result), '只含 NBSP 的块级间隔段落应删除');
});

test('表格单元格即使为空也不删除，结构不被破坏', () => {
    // Arrange
    const html = '<table><tr><th>列一</th><th></th></tr><tr><td>1</td><td></td></tr></table>';

    // Act
    const result = cleanNoise(html);

    // Assert
    assert.equal((result.match(/<t[dh]>/g) || []).length, 4, `单元格数量应保持 4，实际：${result}`);
});

test('空输入原样返回，不抛异常', () => {
    assert.equal(cleanNoise(''), '');
    assert.equal(cleanNoise('   '), '   ');
    assert.equal(cleanNoise(null), '');
});

// ============================================================
// 文本规范化
// ============================================================

const ZERO_WIDTH = String.fromCharCode(0x200b);
const WORD_JOINER = String.fromCharCode(0x2060);
const NBSP = String.fromCharCode(0x00a0);

test('规范化清除零宽字符、不换行空格、行尾空白与多余空行', () => {
    // Arrange
    const input = `# 标题${ZERO_WIDTH}\n\n\n\n正文${NBSP}内容   \n${ZERO_WIDTH}${WORD_JOINER}\n\n\n末尾\t  `;

    // Act
    const result = normalizeMarkdown(input);

    // Assert
    assert.equal(result, '# 标题\n\n正文 内容\n\n末尾');
    assert.ok(!result.includes(ZERO_WIDTH) && !result.includes(NBSP));
});

test('规范化归一 CRLF，且对空输入返回空串', () => {
    assert.equal(normalizeMarkdown('a\r\n\r\n\r\n\r\nb'), 'a\n\nb');
    assert.equal(normalizeMarkdown(''), '');
    assert.equal(normalizeMarkdown(null), '');
});

// ============================================================
// 行尾空白清理的耗时与语义等价：normalizeMarkdown 须线性于文本长度
// ============================================================

const { ZERO_WIDTH_CODE_POINTS, NBSP_CODE_POINTS } = require('../converters/web/normalize');

// 行终止符四个：LF 与 CR 写作转义序列，其余两个以码点生成
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

// 耗时用例的输入规模：256 个不换行空格后缀一个零宽字符，重复 400 次。零宽字符使这段空白在
// web/whitespace 的入口截断（上限 256、按 \s 计段）里分属 400 段、逐段放行；规范化先删零宽、
// 再把不换行空格归一为普通空格，于是在本函数内并成 102400 个普通空格的一段，且不在行尾
const TRAILING_STRESS_RUNS = 400;
const TRAILING_STRESS_RUN_LENGTH = 256;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。
// 1500 ms 使两侧余量都不小于 5 倍——线性化之前的 /[ \t]+$/gm 在这一规模上实测 9365.7 ms
// （同法实测 k=100 为 594.7 ms、k=200 为 2415 ms，耗时随段长平方增长），是它的 6.2 倍；
// 线性化之后实测数毫秒、不足它的百分之一，故慢机以及 node --test 多文件并行抢占 CPU 时都不会误报
const TRAILING_STRESS_BUDGET_MS = 1500;

const elapsedMsSince = (started) => Number(process.hrtime.bigint() - started) / 1e6;

// 码点列表 → 匹配其中任一字符的全局正则（与被测模块同一写法，供参照实现复用）
const charClassRegExp = (codePoints) => new RegExp(`[${codePoints.map((cp) => String.fromCharCode(cp)).join('')}]`, 'g');

const LEGACY_ZERO_WIDTH_RE = charClassRegExp(ZERO_WIDTH_CODE_POINTS);
const LEGACY_NBSP_RE = charClassRegExp(NBSP_CODE_POINTS);
const LEGACY_TRAILING_SPACE_RE = /[ \t]+$/gm;

// 线性化之前的 normalizeMarkdown，仅作短输入的差分参照：其行尾一步的量词加行尾锚在不处于
// 行尾的长空白串上逐位回溯，不可用于耗时用例的输入规模
const legacyNormalizeMarkdown = (markdown) => String(markdown == null ? '' : markdown)
    .replace(/\r\n/g, '\n')
    .replace(LEGACY_ZERO_WIDTH_RE, '')
    .replace(LEGACY_NBSP_RE, ' ')
    .replace(LEGACY_TRAILING_SPACE_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

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

test('规范化：不在行尾的 10 万个空白不触发回溯，耗时在绝对上限内且输出逐字正确', () => {
    // Arrange：每次新构造字符串——V8 对「同一字符串对象 + 同一全局正则」的 replace 结果有缓存
    const run = NBSP.repeat(TRAILING_STRESS_RUN_LENGTH) + ZERO_WIDTH;
    const input = `甲${run.repeat(TRAILING_STRESS_RUNS)}乙`;

    // Act
    const started = process.hrtime.bigint();
    const result = normalizeMarkdown(input);
    const elapsedMs = elapsedMsSince(started);

    // Assert：先验输出正确，以免「快」来自少做了事——该段夹在两个可见字符之间，须逐字保留
    assert.equal(result, `甲${' '.repeat(TRAILING_STRESS_RUN_LENGTH * TRAILING_STRESS_RUNS)}乙`);
    assert.ok(
        elapsedMs < TRAILING_STRESS_BUDGET_MS,
        `规范化实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${TRAILING_STRESS_BUDGET_MS} ms`,
    );
});

test('规范化与线性化之前的实现逐字等价：{空格, 制表符, LF, CR, 行分隔符, 段分隔符, 可见字符, 不换行空格, 零宽空格} 上长度不超过 5 的全部字符串', () => {
    // Arrange：9 个字符的字母表上长度 0 到 5 的全部字符串共 66430 个。字母表须含全部四个行终止符，
    // 行尾判定正是按它们取舍；不换行空格与零宽空格用于覆盖「前两步改写之后才并成一段」的情形
    const alphabet = [' ', '\t', '\n', '\r', LINE_SEPARATOR, PARAGRAPH_SEPARATOR, '甲', NBSP, ZERO_WIDTH];
    const samples = everyStringUpTo(5, alphabet);
    assert.equal(samples.length, 66430);

    // Act & Assert
    for (const text of samples) {
        assert.equal(normalizeMarkdown(text), legacyNormalizeMarkdown(text), JSON.stringify(text));
    }
});

test('规范化：空白段紧邻四种行终止符之前或位于串尾时删除，其余位置逐字保留', () => {
    // Arrange：[用例说明, 输入, 期望输出]。两端一律加可见字符，以免末尾 trim 掩盖行尾一步的效果
    const cases = [
        ['LF 之前的空白段删除', '甲  \n乙', '甲\n乙'],
        ['孤立 CR 之前的空白段删除', '甲  \r乙', '甲\r乙'],
        ['行分隔符之前的空白段删除', `甲  ${LINE_SEPARATOR}乙`, `甲${LINE_SEPARATOR}乙`],
        ['段分隔符之前的空白段删除', `甲  ${PARAGRAPH_SEPARATOR}乙`, `甲${PARAGRAPH_SEPARATOR}乙`],
        // 串尾一段同时落在行尾清理与末尾 trim 的覆盖范围内，两者结果一致，此处只断言最终形态
        ['串尾的空白段删除', '甲  ', '甲'],
        ['行中的空白段逐字保留', '甲  乙', '甲  乙'],
        ['行尾的制表符与空格混合段删除', '甲 \t \t\n乙', '甲\n乙'],
        ['行中的制表符与空格混合段逐字保留', '甲 \t 乙', '甲 \t 乙'],
        ['只含空格的整行清空', '甲\n   \n乙', '甲\n\n乙'],
        ['只含制表符的连续空行清空后并入空行折叠', '甲\n\t\n\t\n乙', '甲\n\n乙'],
        ['同一行内两段：前段保留、行尾段删除', '甲  乙  \n丙', '甲  乙\n丙'],
        ['相邻行分隔符之间的空白段删除，行分隔符不参与空行折叠', `甲  ${LINE_SEPARATOR}  ${LINE_SEPARATOR}乙`, `甲${LINE_SEPARATOR}${LINE_SEPARATOR}乙`],
        // 删零宽、归一不换行空格之后才并成一段：位于行尾则整段删除
        ['零宽与不换行空格拼成的行尾段删除', `甲 ${NBSP} ${ZERO_WIDTH} \n乙`, '甲\n乙'],
        // 同样并成一段，但位于行中：归一后的三个普通空格逐字保留
        ['零宽与不换行空格拼成的行中段保留', `甲 ${NBSP}${ZERO_WIDTH} 乙`, '甲   乙'],
    ];

    // Act & Assert
    for (const [name, input, expected] of cases) {
        assert.equal(normalizeMarkdown(input), expected, name);
    }
});

// ============================================================
// 空元素清理的耗时与语义等价：removeEmptyElements 须线性于节点数
// ============================================================

const cheerio = require('cheerio');
const { removeEmptyElements, isAttached } = require('../converters/web/noise');

// 耗时用例的载荷规模：载荷 A、B 为同一父元素下 10 万个并列子元素，拆包载荷 C 为 3 万组 <br><i></i>（6 万个子元素）。
// 改写之前三条路径各有一处平方级：A 的 $el.find(内容后代选择器) 把 span 的全部子元素交给 css-select 的
// prepareContext，其中 removeSubsets 对这组根逐个做 lastIndexOf / includes；B 的 $el.remove() 逐个在父节点
// children 上做 lastIndexOf + splice；C 先两次 .find()，再由 $el.replaceWith($el.contents()) 对每个子节点做
// removeElement。本机实测（每次新构造输入并重新载入，各 3 次，取值区间）：A 1 万 91–97 ms、2 万 374–377 ms、
// 4 万 1394–1400 ms、8 万 5696–5792 ms、10 万 9030–9133 ms；B 1 万 132–136 ms、2 万 442–475 ms、4 万 1392–1442 ms、
// 8 万 4980–5034 ms、10 万 7871–8359 ms；C 1 万组 895–1274 ms、2 万组 3692–5473 ms、3 万组 8886–11317 ms、
// 4 万组 17523–17999 ms（每翻倍约 4 倍）
const EMPTY_STRESS_CHILDREN = 100000;
const EMPTY_STRESS_BREAK_PAIRS = 30000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。
// 1000 ms 使两侧余量都不小于 5 倍——改写之前三种载荷最快的一次（A 9030 ms、B 7871 ms、C 8886 ms）分别是它的
// 9.0、7.8、8.8 倍；改写之后同一载荷各实测 9 次，最慢一次为 A 98 ms、B 133 ms、C 51 ms，余量分别为 10.2、7.5、
// 19.6 倍，故慢机以及 node --test 多文件并行抢占 CPU 时都不会误报。直接调用 removeEmptyElements、计时区间只包
// 这一次调用：cheerio.load 与 cleanNoise 的其余三步不计入，两侧余量只反映本函数
const EMPTY_STRESS_BUDGET_MS = 1000;

// 载入片段并只对 removeEmptyElements 一次调用计时；每个用例各自新构造输入、重新载入
function timedRemoveEmptyElements(html) {
    const $ = cheerio.load(html, null, false);
    const started = process.hrtime.bigint();
    removeEmptyElements($);
    return [$, elapsedMsSince(started)];
}

test('空元素清理：span 下 10 万个只含不换行空格的并列子元素不触发平方级扫描，耗时在绝对上限内且结构原样保留', () => {
    // Arrange：span 的文本只有不换行空格，按规则保留；改写之前判定它有无内容后代的一次 .find() 即平方级
    const html = `<p>甲x<span>${'<i>&nbsp;</i>'.repeat(EMPTY_STRESS_CHILDREN)}</span>y乙</p>`;

    // Act
    const [$, elapsedMs] = timedRemoveEmptyElements(html);

    // Assert：先验结果正确，以免「快」来自少做了事——span 连同全部子元素与两端文字原样保留
    const span = $('span');
    assert.equal(span.length, 1, 'span 应保留');
    assert.equal(span[0].children.length, EMPTY_STRESS_CHILDREN, 'span 的子元素应一个不少');
    const text = $('p').text();
    assert.ok(text.startsWith('甲x') && text.endsWith('y乙'), '载荷两端的可见文字应保留');
    assert.ok($.html() === html, '整段 HTML 应逐字不变');
    assert.ok(elapsedMs < EMPTY_STRESS_BUDGET_MS, `清理实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${EMPTY_STRESS_BUDGET_MS} ms`);
});

test('空元素清理：同一段落下 10 万个只含空格的 span 逐个删除不触发平方级拼接，耗时在绝对上限内且两端文字相连', () => {
    // Arrange：每个 span 只含 ASCII 空格且不含 br，按规则删除；改写之前逐个 .remove() 即平方级
    const html = `<p>甲${'<span> </span>'.repeat(EMPTY_STRESS_CHILDREN)}乙</p>`;

    // Act
    const [$, elapsedMs] = timedRemoveEmptyElements(html);

    // Assert：先验结果正确——span 全部删除，段落里只剩两端文字
    assert.equal($('span').length, 0, 'span 应全部删除');
    assert.equal($.html(), '<p>甲乙</p>');
    assert.ok(elapsedMs < EMPTY_STRESS_BUDGET_MS, `清理实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${EMPTY_STRESS_BUDGET_MS} ms`);
});

test('空元素清理：只含换行的 span 下 3 万组 br 与空 i 拆包不触发平方级扫描，耗时在绝对上限内且子元素按原序留在段落下', () => {
    // Arrange：span 没有文本、含 br，按规则拆包；空 i 不在空元素白名单内，随之留在段落下
    const pairs = '<br><i></i>'.repeat(EMPTY_STRESS_BREAK_PAIRS);
    const html = `<p>甲<span>${pairs}</span>乙</p>`;

    // Act
    const [$, elapsedMs] = timedRemoveEmptyElements(html);

    // Assert：先验结果正确——span 拆包，br 与 i 数量不变、按原序夹在两端文字之间
    assert.equal($('span').length, 0, 'span 应拆包');
    assert.equal($('p')[0].children.length, EMPTY_STRESS_BREAK_PAIRS * 2 + 2, '段落下应为两端文字加全部 br 与 i');
    assert.equal($('br').length, EMPTY_STRESS_BREAK_PAIRS, 'br 应一个不少');
    assert.equal($('i').length, EMPTY_STRESS_BREAK_PAIRS, 'i 应一个不少');
    assert.ok($.html() === `<p>甲${pairs}乙</p>`, 'br 与 i 应按原序留在段落下');
    assert.ok(elapsedMs < EMPTY_STRESS_BUDGET_MS, `清理实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${EMPTY_STRESS_BUDGET_MS} ms`);
});

// 改写之前的 removeEmptyElements 及其常量，仅作短输入的差分参照：其中 .find()、.remove()、.replaceWith() 在同一
// 父元素下大量子节点时平方级，不可用于耗时用例的输入规模
const LEGACY_EMPTY_TAGS = 'p, div, section, span, li, blockquote, h1, h2, h3, h4, h5, h6, article, header, figure, a';
const LEGACY_CONTENT_DESCENDANTS = 'img, video, audio, iframe, table, embed, object, svg, canvas, picture, source';
const LEGACY_EMPTY_SWEEP_ROUNDS = 3;
const LEGACY_INLINE_WRAPPERS = new Set(['span', 'a']);
const LEGACY_ASCII_SPACE_ONLY_RE = /^[ \t\r\n\f]*$/;

function legacyRemoveEmptyElements($) {
    for (let round = 0; round < LEGACY_EMPTY_SWEEP_ROUNDS; round += 1) {
        let changed = 0;
        $(LEGACY_EMPTY_TAGS).each((_, el) => {
            if (!isAttached(el)) return;
            const $el = $(el);
            if ($el.text().trim()) return;
            if ($el.find(LEGACY_CONTENT_DESCENDANTS).length > 0) return;
            if (LEGACY_INLINE_WRAPPERS.has(el.tagName)) {
                if (!LEGACY_ASCII_SPACE_ONLY_RE.test($el.text())) return;
                if ($el.find('br').length > 0) {
                    $el.replaceWith($el.contents());
                    changed += 1;
                    return;
                }
            }
            $el.remove();
            changed += 1;
        });
        if (changed === 0) return;
    }
}

// 定种子的 mulberry32 伪随机数：同一种子每次生成同一批树，用例失败可原样复现（与 url-parser 测试同一写法）
function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const EMPTY_DIFF_SEED = 20260923;
const EMPTY_DIFF_TREE_COUNT = 10000;
const EMPTY_DIFF_MAX_DEPTH = 4;
const EMPTY_DIFF_MAX_CHILDREN = 4;
// 字母表：空元素白名单的全部标签、内容后代的全部标签，以及 br、i、em、template、svg、math、script、style；
// span、a 另各重复四次，以提高行内包装元素的出现率
const EMPTY_DIFF_TAGS = Object.freeze([
    'p', 'div', 'section', 'span', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'article', 'header', 'figure', 'a',
    'img', 'video', 'audio', 'iframe', 'table', 'embed', 'object', 'svg', 'canvas', 'picture', 'source',
    'br', 'i', 'em', 'template', 'math', 'script', 'style',
    'span', 'a', 'span', 'a', 'span', 'a', 'span', 'a',
]);
// 文本：空串、ASCII 空白（空格、制表符、换行）、不换行空格、全角空格、可见字
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const EMPTY_DIFF_TEXTS = Object.freeze(['', ' ', '\t', '\n', NBSP, IDEOGRAPHIC_SPACE, '甲']);
// 空白倾向的子树：行内包装元素的子树有七成改从这里取，只含 ASCII 空白文本与 br、行内元素、template、img，
// 用于造出「只包着换行」的拆包情形及其边界（夹着 img 则整体保留，br 藏在 template 里则视父节点而定）
const EMPTY_DIFF_BLANK_TAGS = Object.freeze(['br', 'br', 'br', 'i', 'em', 'span', 'a', 'template', 'img']);
const EMPTY_DIFF_BLANK_TEXTS = Object.freeze(['', ' ', '\t', '\n']);
const EMPTY_DIFF_BLANK_CHANCE = 0.7;
const EMPTY_DIFF_VOID_TAGS = new Set(['img', 'br', 'embed', 'source']);
// 原始文本元素只生成文本内容：其内的标签字符不经 HTML 解析
const EMPTY_DIFF_RAW_TEXT_TAGS = new Set(['script', 'style', 'iframe']);

// 随机森林：顶层 1 到 3 个节点，其下每个元素 0 到 EMPTY_DIFF_MAX_CHILDREN 个子节点、深度至多 EMPTY_DIFF_MAX_DEPTH，
// 文本与元素混排；blank 为真时只生成空白倾向的子树
function randomEmptyForest(random, depth = EMPTY_DIFF_MAX_DEPTH, blank = false) {
    const pickFrom = (list) => list[Math.floor(random() * list.length)];
    const count = depth === EMPTY_DIFF_MAX_DEPTH
        ? 1 + Math.floor(random() * 3)
        : Math.floor(random() * (EMPTY_DIFF_MAX_CHILDREN + 1));
    let html = '';
    for (let index = 0; index < count; index += 1) {
        if (depth <= 0 || random() < 0.3) {
            html += pickFrom(blank ? EMPTY_DIFF_BLANK_TEXTS : EMPTY_DIFF_TEXTS);
            continue;
        }
        const tag = pickFrom(blank ? EMPTY_DIFF_BLANK_TAGS : EMPTY_DIFF_TAGS);
        if (EMPTY_DIFF_VOID_TAGS.has(tag)) {
            html += `<${tag}>`;
        } else if (EMPTY_DIFF_RAW_TEXT_TAGS.has(tag)) {
            html += `<${tag}>${pickFrom(EMPTY_DIFF_TEXTS)}</${tag}>`;
        } else {
            const blankInside = blank || (LEGACY_INLINE_WRAPPERS.has(tag) && random() < EMPTY_DIFF_BLANK_CHANCE);
            html += `<${tag}>${randomEmptyForest(random, depth - 1, blankInside)}</${tag}>`;
        }
    }
    return html;
}

// 在这一份载入的 cheerio 实例上计数 remove 与 replaceWith 的调用：$.fn 为每次载入各自的原型，不影响其他载入
function countMutations($) {
    const counts = { remove: 0, replaceWith: 0 };
    const { remove, replaceWith } = $.fn;
    $.fn.remove = function countedRemove(...args) {
        counts.remove += 1;
        return remove.apply(this, args);
    };
    $.fn.replaceWith = function countedReplaceWith(...args) {
        counts.replaceWith += 1;
        return replaceWith.apply(this, args);
    };
    return counts;
}

test('空元素清理与改写之前的实现逐字等价：定种子随机森林上 $.html() 逐字相同', () => {
    // Arrange
    const random = seededRandom(EMPTY_DIFF_SEED);
    const stats = { removedTrees: 0, unwrappedTrees: 0 };

    for (let index = 0; index < EMPTY_DIFF_TREE_COUNT; index += 1) {
        const html = randomEmptyForest(random);
        const $legacy = cheerio.load(html, null, false);
        const $current = cheerio.load(html, null, false);
        const counts = countMutations($legacy);

        // Act
        legacyRemoveEmptyElements($legacy);
        removeEmptyElements($current);

        // Assert
        assert.equal($current.html(), $legacy.html(), `第 ${index} 棵树：${html}`);
        if (counts.remove > 0) stats.removedTrees += 1;
        if (counts.replaceWith > 0) stats.unwrappedTrees += 1;
    }

    // Assert：核对面确实铺开了——过半的树发生了删除，发生拆包的树超过十分之一
    assert.ok(stats.removedTrees > EMPTY_DIFF_TREE_COUNT / 2, `发生删除的树应过半：${JSON.stringify(stats)}`);
    assert.ok(stats.unwrappedTrees > EMPTY_DIFF_TREE_COUNT / 10, `发生拆包的树应超过十分之一：${JSON.stringify(stats)}`);
});

// ============================================================
// 片段载入与根级查询：顶层大量并列节点时 cleanNoise 的耗时上限
// ============================================================

// 载荷为顶层 8 万个并列的 <p>段</p>：不带 class、id、br，文字不命中任何引导文案规则，也不是空元素，四步清洗都不
// 改动它，正确的输出就是原串；逐个 .remove() 等不在本节范围内的路径也就一条都不走。改写之前 cleanNoise 做一次
// 片段载入 cheerio.load(html, null, false)、四次根级查询（属性规则、文案规则、连续 br 削减、空元素清理各一次），
// 二者都随顶层节点数平方增长，病因与分规模实测见 test/url-parser.test.js 的「片段载入与根级查询」一节
const NOISE_STRESS_COUNT = 80000;
// 耗时上限取绝对值，理由同 TRAILING_STRESS_BUDGET_MS。1500 ms 使两侧余量都不小于 5 倍——改写之前本用例 3 次实测
// （1 次单独运行、2 次运行整个文件）17339.8、18391.9、16250.8 ms，最快一次是它的 10.8 倍；改写之后本用例在全量测试
// （node --test 多文件并行）中的用例耗时（含构造载荷与断言，是计时区间的上界）9 次为 195.1–245.9 ms，同一载荷、同一
// 计时区间的独立进程冷启动 3 次为 151.1–156.0 ms，冷启动且与全量测试并行 3 次为 160.6–200.6 ms，最慢一次 245.9 ms
// 不到它的 1/6。直接调用 cleanNoise、计时区间只包这一次调用，片段载入在函数之内一并计时
const NOISE_STRESS_BUDGET_MS = 1500;

test('噪声清洗：顶层 8 万个并列段落不触发平方级的片段载入与根级查询，耗时在绝对上限内且 HTML 逐字不变', () => {
    // Arrange：载荷在用例内现场构造，不与其他用例共用
    const html = '<p>段</p>'.repeat(NOISE_STRESS_COUNT);

    // Act：计时区间只包 cleanNoise 一次调用；片段载入在函数之内，属本节的修复对象，一并计时
    const started = process.hrtime.bigint();
    const result = cleanNoise(html);
    const elapsedMs = elapsedMsSince(started);

    // Assert：先验结果正确，以免「快」来自少做了事
    assert.ok(result === html, '整段 HTML 应逐字不变');
    assert.ok(elapsedMs < NOISE_STRESS_BUDGET_MS, `清洗实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${NOISE_STRESS_BUDGET_MS} ms`);
});
