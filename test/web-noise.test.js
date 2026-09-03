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
