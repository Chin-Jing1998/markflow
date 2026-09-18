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
