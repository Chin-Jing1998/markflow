/**
 * converters/parsers/url.js 单元测试
 * 覆盖：标题提取顺序、正文结构（heading/table/image）、script 剔除、图片入 assets 与 Referer、
 *       懒加载属性、下载失败降级、data URL 图片、SSRF 守卫拒绝本地地址、
 *       字面尖括号与字符引用写法逐字进入 IR
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const cheerio = require('cheerio');
const { parse, collapseBreakMarkers, markIndents } = require('../converters/parsers/url');
const { MARKERS, indentMarker } = require('../converters/ir/markers');
const { LEAF_BLOCK_SELECTOR, NESTED_BLOCK_SELECTOR, NESTED_BLOCK_TAGS } = require('../converters/web/indent');
const { _setLookup } = require('../converters/net/fetch-guard');
const mdRenderer = require('../converters/renderers/md');
const { buildContentList } = require('../converters/renderers/content-list');
const { BUDGET_FACTOR, budgetMs } = require('./helpers/timing-budget');

// 按真实公众号文章裁剪的结构夹具（section 嵌套、小字图注、相邻 strong、单双 br、text-indent、段首 NBSP）
const WECHAT_FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'web', 'wechat-collapse.html'));
// 最小合法 GIF：签名 + 1×1 逻辑屏幕
const GIF_1X1 = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00])]);
// 不可见字符以码点生成，源码不出现看不见的字面量
const MARKER_RE = new RegExp(`[${String.fromCharCode(0xEF00)}-${String.fromCharCode(0xEF1F)}]`);
const IDEO = String.fromCharCode(0x3000);

// ============================================================
// 测试夹具：手工生成合法 PNG
// ============================================================

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i += 1) {
        crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(width, height) {
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.alloc((width * 3 + 1) * height, 0);
    return Buffer.concat([
        signature,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

const PNG = makePng(8, 8);
const CHINESE_RE = /[一-龥]/;

// ============================================================
// 测试服务器
// ============================================================

const MAIN_PAGE = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>页面标题</title>
<meta property="og:title" content="OG 标题">
<script>var HEAD_SECRET = 1;</script>
</head><body>
<nav>导航栏</nav>
<article>
<h2>二级标题</h2>
<p>正文含<span style="font-weight:bold">粗体</span>片段</p>
<table><tr><th>列一</th><th>列二</th></tr><tr><td>1</td><td>2</td></tr></table>
<p><img src="/a.png" alt="示意图"></p>
<script>var INNER_SECRET = 2;</script>
</article>
<footer>页脚</footer>
</body></html>`;

const LAZY_PAGE = `<!doctype html>
<html><head><title>懒加载页</title></head><body>
<article>
<h1>懒加载标题</h1>
<p><img data-src="/missing.png" src=""></p>
<p><img data-src="/a.png"></p>
</article>
</body></html>`;

const DATA_URL_PAGE = `<!doctype html>
<html><head><title>内嵌图片页</title></head><body>
<article>
<p><img src="data:image/png;base64,${PNG.toString('base64')}"></p>
</article>
</body></html>`;

// 区间号与上下标：成对的单「~」曾被 remark-gfm 吞成删除线，<sup>/<sub> 曾被 turndown 剥成纯文本
const RANGE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>区间写法</title></head><body>
<article>
<h1>区间写法</h1>
<p>C1~C30的烷基、C1~C30的烷氧基</p>
<p>疗程3~5天，有效率10~20%</p>
<p>R<sup>2</sup>、C<sub>1</sub>的烷基</p>
<p>原价<del>3~5元</del>，现价<s>作废</s>两元</p>
</article>
</body></html>`;

// 网页表格的表题：GFM 没有表题语法，<caption> 的文字曾被表格规则整段丢弃、进不了 IR
const TABLE_CAPTION_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>表题写法</title></head><body>
<article>
<h1>表题写法</h1>
<p>下表列出各组收率，供后文引用。</p>
<table><caption>表 1 各组收率（10~20℃、30~40℃，*为显著）</caption>
<tr><th>组别</th><th>收率</th></tr><tr><td>甲</td><td>90%</td></tr></table>
<p>由上表可见，甲组收率最高。</p>
</article>
</body></html>`;

// 表格单元格与图片 alt：这两条文本通道曾绕过 turndown 的 escape，其中成对的单「~」被吞成删除线、
// 星号被吞成斜体。该夹具走完整解析链路，一并覆盖 turndown 与 remark 之间的字符串级步骤
const ESCAPE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>转义写法</title></head><body>
<article>
<h1>转义写法</h1>
<table><tr><th>温度</th><th>代号</th></tr><tr><td>10~20℃、30~40℃</td><td>a*b*c</td></tr></table>
<p><img src="/a.png" alt="10~20℃与30~40℃对比"></p>
</article>
</body></html>`;

// 零宽空格 U+200B，以码点生成
const ZWSP = String.fromCharCode(0x200B);
// 文本中的「<b>」曾被当成行内 HTML（还会被提升成 strong 节点）、「&lt;」曾被解码；零宽字符夹在「&」与「lt;」
// 之间时，normalizeMarkdown 在 turndown 之后才删掉它，实体重新成立；该夹具走完整解析链路，一并覆盖
// turndown 与 remark 之间的字符串级步骤。
const HTML_SYNTAX_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>尖括号写法</title></head><body>
<article>
<h1>尖括号写法</h1>
<p>当a&lt;b&gt;c时成立</p>
<p>见&amp;lt;与&amp;amp;，另有 &amp;#60; 与 AT&amp;T，网址 http://example.com/?a=1&amp;b=2 结束</p>
<p>&lt;div&gt;块级开头&lt;/div&gt;</p>
<p>零宽：&amp;${ZWSP}lt; 与 &lt;${ZWSP}b&gt;粗&lt;/b&gt;</p>
<p><strong>粗&lt;em&gt;</strong>、<em>斜&amp;amp;</em>、<del>删&lt;s&gt;</del>、R<sup>a&lt;b</sup>、C<sub>x&lt;y</sub></p>
<table><tr><th>项</th><th>值</th></tr><tr><td>a&lt;b&gt;c</td><td>见&amp;lt;与&amp;amp;</td></tr></table>
<p><img src="/a.png" alt="见&amp;lt;与&amp;amp; 及 a&lt;b&gt;c"></p>
</article>
</body></html>`;

// ------------------------------------------------------------
// 超长空白夹具：turndown 7.2.4 的 postProcess 对整篇输出跑 /[\t\r\n\s]+$/，
// 输出里任何一段不在末尾、长度为 R 的连续空白都要花约 R²/2 步
// ------------------------------------------------------------

const WS_NBSP = String.fromCharCode(0x00a0);
// 载荷规模。取 20 万，是为了让仅 turndown 一处在未截断时就需约 16 秒，为下方上限的 5 倍以上：
// 即便日后 collapseBreakMarkers 与 normalizeMarkdown 的两条正则被改成线性，本用例仍能发现截断被移除
const WS_PAYLOAD_LENGTH = 200000;
// 整次 parse 的绝对上限。截断后实测在百毫秒量级，距此上限 30 倍以上，慢机与 node --test 多文件
// 并行时不会误报；不用倍率断言是因为毫秒级测量噪声大
const WS_PARSE_BUDGET_MS = 3000;
// 正文提取需要足量普通段落才会命中
const WS_FILLER = '<p>这是一段用于让正文提取命中的普通文字，长度足够，内容与本用例无关。</p>'.repeat(8);

const wsPage = (title, payload) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head><body>
<article>
<h1>${title}</h1>
${WS_FILLER}
${payload}
${WS_FILLER}
</article>
</body></html>`;

// ① 图片 alt 里的超长 ASCII 空格：属性值不经 turndown 的空白折叠，原样进入输出
const WS_ALT_PAGE = wsPage('超长空白 alt', `<p><img src="/a.png" alt="x${' '.repeat(WS_PAYLOAD_LENGTH)}y"></p>`);
// ② 正文里的超长不换行空格：turndown 只折叠 [ \r\n\t]，不换行空格逐字进入输出
const WS_NBSP_PAGE = wsPage('超长空白正文', `<p>甲x${WS_NBSP.repeat(WS_PAYLOAD_LENGTH)}y乙</p>`);

// ------------------------------------------------------------
// 提取质量对比夹具
// ------------------------------------------------------------

// ① 正文被侧栏与评论区夹在中间：整页最长的 div 是三者的公共父节点，旧的「最长 div」
//    兜底会把侧栏与评论一并带进正文，Readability 则只取正文
const BODY_PARAGRAPHS = [
    '在分布式系统里，一致性与可用性的取舍是绕不开的话题，本文先梳理常见的一致性模型，再结合实际的部署形态说明它们各自的代价与适用边界。',
    '强一致性要求任何一次读取都能看到最新写入的结果，实现上通常依赖共识协议，代价是写入延迟随副本数与跨机房距离上升，可用性在网络分区时下降。',
    '最终一致性放宽了这一约束，允许副本在有限时间内不一致，换来的是更低的写入延迟与更高的可用性，适合对读到旧值不敏感的业务场景。',
];
const ASIDE_LINKS = Array.from({ length: 12 }, (_, i) => `<a href="/promo/${i}">推广位标题${i}</a>`).join('');
const TALK_ITEMS = Array.from({ length: 8 }, (_, i) => `<p>读者${i}：说得好，学到了。</p>`).join('');

const SIDEBAR_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>一致性模型综述</title>
<meta property="og:site_name" content="架构笔记">
<meta name="author" content="李四">
<meta property="article:published_time" content="2026-03-04T05:06:07Z">
<meta name="description" content="梳理常见一致性模型及其代价">
</head><body>
<div id="wrapper">
<div class="aside-column">${ASIDE_LINKS}</div>
<div class="post-body"><h2>一致性模型</h2>${BODY_PARAGRAPHS.map((p) => `<p>${p}</p>`).join('')}<p><img src="/a.png" alt="示意图"></p></div>
<div class="talk-list">${TALK_ITEMS}</div>
</div>
</body></html>`;

// ② 段落短、Readability 判为不可读，因而走 fallback:article；正文里混着分享栏、
//    相关阅读、关注引导语与二维码图，用于验证噪声清洗
const NOISY_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>噪声页</title></head><body>
<article>
<h1>清洗验证</h1>
<p>点击上方蓝字关注我们</p>
<p>正文第一段。</p>
<div class="social-share"><a href="/share/weibo">分享到微博</a><a href="/share/wechat">分享到微信</a></div>
<p><img src="/a.png" alt="正文配图"></p>
<ul class="related-posts"><li><a href="/r/1">相关文章一</a></li><li><a href="/r/2">相关文章二</a></li></ul>
<p>正文第二段。</p>
<p>长按识别下方二维码<img src="/qr.png" alt="二维码"></p>
<div id="comments"><p>某条评论</p></div>
<p>转载请注明出处。</p>
</article>
</body></html>`;

// ③ 站点专属选择器命中：#js_content 之外还有一段更长的无关内容，用于证明站点表优先级最高
const WECHAT_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>公众号文章</title></head><body>
<h1 id="activity-name">公众号标题</h1>
<div id="js_content"><p>公众号正文段落，长度不长但由站点选择器直接命中。</p></div>
<div class="site-extra">${BODY_PARAGRAPHS.join('')}${BODY_PARAGRAPHS.join('')}</div>
</body></html>`;

function startServer() {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push({ url: req.url, referer: req.headers.referer || null });
        switch (req.url) {
            case '/':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(MAIN_PAGE);
                return;
            case '/lazy':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(LAZY_PAGE);
                return;
            case '/data-url':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(DATA_URL_PAGE);
                return;
            case '/range':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(RANGE_PAGE);
                return;
            case '/table-caption':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(TABLE_CAPTION_PAGE);
                return;
            case '/escape':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(ESCAPE_PAGE);
                return;
            case '/html-syntax':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(HTML_SYNTAX_PAGE);
                return;
            case '/ws-alt':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(WS_ALT_PAGE);
                return;
            case '/ws-nbsp':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(WS_NBSP_PAGE);
                return;
            case '/sidebar':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(SIDEBAR_PAGE);
                return;
            case '/noisy':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(NOISY_PAGE);
                return;
            // 站点表按 url.includes 匹配，故把域名放进路径即可命中微信规则
            case '/mp.weixin.qq.com/s/abc':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(WECHAT_PAGE);
                return;
            // 微信夹具：经 _setLookup 把 mp.weixin.qq.com 解析到本机，站点选择器按主机名命中
            case '/mp.weixin.qq.com/s/fixture':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(WECHAT_FIXTURE);
                return;
            case '/wx/banner.gif':
                res.writeHead(200, { 'Content-Type': 'image/gif' });
                res.end(GIF_1X1);
                return;
            case '/a.png':
            case '/qr.png':
            case '/wx/figure.png':
                res.writeHead(200, { 'Content-Type': 'image/png' });
                res.end(PNG);
                return;
            default:
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('not found');
        }
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({
                base: `http://127.0.0.1:${server.address().port}`,
                requests,
                close: () => new Promise((done) => {
                    server.closeAllConnections();
                    server.close(() => done());
                }),
            });
        });
    });
}

// ============================================================
// IR 遍历辅助
// ============================================================

function collect(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) {
        for (const child of node.children) collect(child, predicate, out);
    }
    return out;
}

function plainText(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text' || node.type === 'inlineCode') return String(node.value || '');
    if (!Array.isArray(node.children)) return '';
    return node.children.map(plainText).join('');
}

// 汇总 IR 中所有字面量（text/html/code），用于断言 script 内容被彻底剔除
function allLiterals(ir) {
    return collect(ir, (n) => typeof n.value === 'string').map((n) => n.value).join('\n');
}

// ============================================================
// 用例
// ============================================================

test('解析网页：og:title 作标题，IR 含 heading/table/image，图片进入 assets 且带页面 Referer', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());
    const url = `${server.base}/`;

    // Act
    const doc = await parse({ url }, { allowPrivateNetwork: true });

    // Assert：标题与 meta
    assert.equal(doc.kind, 'document');
    assert.equal(doc.meta.title, 'OG 标题');
    assert.equal(doc.meta.sourceType, 'url');
    assert.equal(doc.meta.sourceUrl, url);

    // Assert：IR 结构
    const headings = collect(doc.ir, (n) => n.type === 'heading');
    assert.deepEqual(headings.map((h) => [h.depth, plainText(h)]), [[1, 'OG 标题'], [2, '二级标题']]);

    assert.deepEqual(collect(doc.ir, (n) => n.type === 'strong').map(plainText), ['粗体']);

    const tables = collect(doc.ir, (n) => n.type === 'table');
    assert.equal(tables.length, 1);
    const rows = collect(tables[0], (n) => n.type === 'tableRow');
    assert.deepEqual(rows.map((r) => r.children.map(plainText)), [['列一', '列二'], ['1', '2']]);

    const images = collect(doc.ir, (n) => n.type === 'image');
    assert.equal(images.length, 1);
    assert.equal(images[0].url, 'images/image_1.png');
    assert.equal(images[0].alt, '示意图');

    // Assert：script 与导航/页脚内容不进入 IR
    const literals = allLiterals(doc.ir);
    assert.ok(!literals.includes('SECRET'), `IR 不应含 script 内容，实际：${literals}`);
    assert.ok(!literals.includes('导航栏') && !literals.includes('页脚'));

    // Assert：assets 与 Referer
    assert.equal(doc.assets.length, 1);
    assert.equal(doc.assets[0].name, 'images/image_1.png');
    assert.equal(doc.assets[0].mime, 'image/png');
    assert.ok(doc.assets[0].buffer.equals(PNG));
    const imageRequest = server.requests.find((r) => r.url === '/a.png');
    assert.equal(imageRequest.referer, url, 'Referer 应为页面 URL 而非图片 URL');
    assert.ok(Array.isArray(doc.warnings));
});

test('懒加载 data-src 被识别；单张下载失败记 warning 并保留原 URL，编号不留空洞', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());
    const url = `${server.base}/lazy`;

    // Act
    const doc = await parse({ url }, { allowPrivateNetwork: true });

    // Assert
    assert.equal(doc.meta.title, '懒加载标题');
    const images = collect(doc.ir, (n) => n.type === 'image');
    assert.deepEqual(images.map((n) => n.url), [`${server.base}/missing.png`, 'images/image_1.png']);
    assert.equal(doc.assets.length, 1);
    assert.equal(doc.assets[0].name, 'images/image_1.png');
    assert.ok(
        doc.warnings.some((w) => w.includes('missing.png') && w.includes('404')),
        `warnings 应记录失败图片，实际为 ${JSON.stringify(doc.warnings)}`,
    );
});

test('data URL 图片解码进入 assets', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());

    // Act
    const doc = await parse({ url: `${server.base}/data-url` }, { allowPrivateNetwork: true });

    // Assert
    const images = collect(doc.ir, (n) => n.type === 'image');
    assert.deepEqual(images.map((n) => n.url), ['images/image_1.png']);
    assert.equal(doc.assets.length, 1);
    assert.equal(doc.assets[0].mime, 'image/png');
    assert.ok(doc.assets[0].buffer.equals(PNG));
});

test('未开启 allowPrivateNetwork 时本地地址被拒并抛中文错误', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());
    const url = `${server.base}/`;

    // Act & Assert
    await assert.rejects(parse({ url }), CHINESE_RE);
    await assert.rejects(parse({ url }, { allowPrivateNetwork: false }), /内网|保留/);
    assert.equal(server.requests.length, 0, '被拒的请求不应到达服务器');
});

test('非法输入与非 http 协议抛中文错误', async () => {
    await assert.rejects(parse({}), /input\.url/);
    await assert.rejects(parse({ url: '   ' }), /input\.url/);
    await assert.rejects(parse({ url: 'ftp://example.com/a' }), /协议/);
});

// ============================================================
// 提取质量：三级链路
// ============================================================

test('侧栏与评论包夹的页面走 Readability，正文保留、侧栏与评论被剔除', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());

    // Act
    const doc = await parse({ url: `${server.base}/sidebar` }, { allowPrivateNetwork: true });
    const literals = allLiterals(doc.ir);

    // Assert：命中的是 Readability 而非「最长 div」兜底
    assert.equal(doc.meta.extraction, 'readability');

    // Assert：三段正文与配图都在
    for (const paragraph of BODY_PARAGRAPHS) {
        assert.ok(literals.includes(paragraph), `正文段落应保留：${paragraph.slice(0, 12)}…`);
    }
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'image').map((n) => n.url), ['images/image_1.png']);

    // Assert：侧栏推广与评论区一条都不剩
    assert.ok(!literals.includes('推广位标题'), `侧栏推广不应进入正文，实际：${literals.slice(0, 200)}`);
    assert.ok(!literals.includes('说得好'), '评论区不应进入正文');
    assert.equal(collect(doc.ir, (n) => n.type === 'link' && String(n.url).includes('/promo/')).length, 0);
});

test('Readability 分支下元数据齐全，wordCount 与 fetchedAt 写入 meta', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());
    const url = `${server.base}/sidebar`;

    // Act
    const doc = await parse({ url }, { allowPrivateNetwork: true });

    // Assert
    assert.equal(doc.meta.title, '一致性模型综述');
    assert.equal(doc.meta.author, '李四');
    assert.equal(doc.meta.publishedAt, '2026-03-04T05:06:07.000Z');
    assert.equal(doc.meta.siteName, '架构笔记');
    assert.equal(doc.meta.excerpt, '梳理常见一致性模型及其代价');
    assert.equal(doc.meta.lang, 'zh-CN');
    assert.equal(doc.meta.sourceUrl, url);
    assert.equal(doc.meta.finalUrl, url);
    assert.ok(doc.meta.wordCount > 100, `wordCount 应覆盖三段正文，实际 ${doc.meta.wordCount}`);
    assert.match(doc.meta.fetchedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
});

test('短段落页面回退到 <article>，分享栏、相关阅读与引导语被清洗，二维码图不下载', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());

    // Act
    const doc = await parse({ url: `${server.base}/noisy` }, { allowPrivateNetwork: true });
    const literals = allLiterals(doc.ir);

    // Assert：Readability 判不可读，落到 article 兜底
    assert.equal(doc.meta.extraction, 'fallback:article');

    // Assert：正文两段与配图保留
    assert.ok(literals.includes('正文第一段。') && literals.includes('正文第二段。'), literals);
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'image').map((n) => n.url), ['images/image_1.png']);

    // Assert：各类噪声均被清掉
    for (const noise of ['分享到微博', '相关文章一', '某条评论', '点击上方蓝字', '长按识别', '转载请注明出处']) {
        assert.ok(!literals.includes(noise), `噪声「${noise}」应被清洗，实际：${literals}`);
    }

    // Assert：二维码图片在清洗阶段就被摘掉，压根没发起下载
    assert.equal(server.requests.filter((r) => r.url === '/qr.png').length, 0, '二维码图片不应被请求');
    assert.equal(doc.assets.length, 1);
});

test('取不到的元数据字段整条省略，不写空串占位', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());

    // Act：噪声页没有 author / published_time / og:site_name / lang
    const doc = await parse({ url: `${server.base}/noisy` }, { allowPrivateNetwork: true });

    // Assert
    assert.equal('author' in doc.meta, false);
    assert.equal('publishedAt' in doc.meta, false);
    assert.equal('lang' in doc.meta, false);
    // siteName 有主机名兜底，故必然存在
    assert.equal(doc.meta.siteName, '127.0.0.1');
});

test('站点专属选择器优先级最高：命中 #js_content，更长的无关内容被忽略', () => {
    // Arrange —— 站点匹配按主机名判定，故直接以真实公众号地址调提取层，不经 HTTP
    const cheerio = require('cheerio');
    const { extractContent } = require('../converters/web/extract');
    const url = 'https://mp.weixin.qq.com/s/abc';

    // Act
    const result = extractContent({ $: cheerio.load(WECHAT_PAGE), html: WECHAT_PAGE, url });

    // Assert
    assert.equal(result.extraction, 'site:mp.weixin.qq.com');
    assert.ok(result.html.includes('公众号正文段落'), '应取到 #js_content 的内容');
    assert.ok(!result.html.includes('在分布式系统里'), '站点选择器命中后不应再取其它容器的内容');
});

test('域名出现在路径或查询串时不触发站点选择器，回退通用提取', () => {
    // Arrange
    const cheerio = require('cheerio');
    const { extractContent } = require('../converters/web/extract');
    const url = 'https://example.com/mp.weixin.qq.com/s/abc';

    // Act
    const result = extractContent({ $: cheerio.load(WECHAT_PAGE), html: WECHAT_PAGE, url });

    // Assert
    assert.notEqual(result.extraction, 'site:mp.weixin.qq.com');
});

// ============================================================
// 只读提取模式
// ============================================================

test('skipImages 模式不下载图片：地址就地绝对化，清单挂在 data.images，assets 为空', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());
    const url = `${server.base}/noisy`;

    // Act
    const doc = await parse({ url }, { allowPrivateNetwork: true, skipImages: true });

    // Assert
    assert.deepEqual(doc.assets, []);
    assert.deepEqual(doc.data.images, [{ url: `${server.base}/a.png`, alt: '正文配图' }]);
    assert.deepEqual(
        collect(doc.ir, (n) => n.type === 'image').map((n) => n.url),
        [`${server.base}/a.png`],
    );
    // 只请求了页面本身，没有任何图片请求
    assert.deepEqual(server.requests.map((r) => r.url), ['/noisy']);
});

test('skipImages 模式下 data URL 图片截断显示，不撑爆返回体积', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());

    // Act
    const doc = await parse({ url: `${server.base}/data-url` }, { allowPrivateNetwork: true, skipImages: true });

    // Assert
    const [image] = doc.data.images;
    assert.ok(image.url.startsWith('data:image/png;base64,'), image.url);
    assert.ok(image.url.length < 80, `data URL 应被截断，实际长度 ${image.url.length}`);
    assert.deepEqual(doc.assets, []);
});

test('站点选择器按主机名匹配：子域命中，查询串与伪造子域不命中', () => {
    // Arrange
    const { matchesHost } = require('../converters/web/extract');
    const { hostnameOf } = require('../converters/util');
    const cases = [
        ['https://blog.csdn.net/user/article', 'csdn.net', true],
        ['https://csdn.net/x', 'csdn.net', true],
        ['https://evil.com/?redirect=csdn.net', 'csdn.net', false],
        ['https://csdn.net.evil.com/phish', 'csdn.net', false],
        ['not-a-url', 'csdn.net', false],
    ];

    // Act & Assert
    for (const [url, domain, expected] of cases) {
        assert.equal(matchesHost(hostnameOf(url), domain), expected, `${url} 对 ${domain} 的判定应为 ${expected}`);
    }
});

// ============================================================
// 转档保真：微信正文结构、换行、缩进、图片显示尺寸与图注
// ============================================================

async function parseWechatFixture(t) {
    const server = await startServer();
    t.after(() => server.close());
    _setLookup(async () => [{ address: '127.0.0.1', family: 4 }]);
    t.after(() => _setLookup(null));
    const { port } = new URL(server.base);
    return parse({ url: `http://mp.weixin.qq.com:${port}/mp.weixin.qq.com/s/fixture` }, { allowPrivateNetwork: true });
}

const paragraphOf = (doc, prefix) => doc.ir.children.find((n) => n.type === 'paragraph' && plainText(n).startsWith(prefix));

test('微信夹具：section 各自成段；图片独立成段并带显示宽度（超栏与 100% 均按 677px 栏宽）；图注紧随图片', async (t) => {
    // Act
    const doc = await parseWechatFixture(t);
    const top = doc.ir.children;

    // Assert：命中站点选择器，整篇不再塌成一段
    assert.equal(doc.meta.extraction, 'site:mp.weixin.qq.com');
    assert.ok(top.length >= 8, `块数应不少于 8，实际 ${top.length}`);

    // Assert：每张图片独占一个段落，display 为 677px
    const imageParagraphs = top.filter((n) => n.type === 'paragraph' && n.children.some((c) => c.type === 'image'));
    assert.equal(imageParagraphs.length, 3);
    for (const node of imageParagraphs) {
        assert.equal(node.children.length, 1, JSON.stringify(node.children));
        assert.deepEqual(node.children[0].data.display, { width: 677, unit: 'px', source: 'web' });
    }
    assert.deepEqual(doc.assets.map((a) => a.name), ['images/image_1.gif', 'images/image_2.png', 'images/image_3.png']);

    // Assert：小字 section 图注成为紧随第二张图的 caption 段落
    const at = top.indexOf(imageParagraphs[1]);
    assert.deepEqual(top[at + 1].data, { role: 'caption' });
    assert.equal(plainText(top[at + 1]), '图｜夹具的第一张配图');
    assert.ok(!MARKER_RE.test(JSON.stringify(doc.ir)), 'IR 中不得残留私用区标记');
});

test('微信夹具：粗体还原为 strong（相邻 strong 合并）；单 br 为硬换行、双 br 分段；text-indent 与段首 NBSP 成为 data.indent', async (t) => {
    // Act
    const doc = await parseWechatFixture(t);

    // Assert：粗体
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'strong').map(plainText), ['《夹具词典》', '前一半粗体后一半粗体，另一个是能力。']);

    // Assert：换行
    assert.deepEqual(paragraphOf(doc, '单个换行之前').children.map((n) => n.type), ['text', 'break', 'text']);
    assert.equal(plainText(paragraphOf(doc, '两个换行之前')), '两个换行之前');
    assert.equal(plainText(paragraphOf(doc, '两个换行之后')), '两个换行之后');

    // Assert：缩进（文本本身不带全角空格）
    for (const prefix of ['首行缩进两字的段落', '四个不换行空格起首的段落']) {
        const node = paragraphOf(doc, prefix);
        assert.ok(node, prefix);
        assert.equal(node.data && node.data.indent, 2, prefix);
    }
});

test('微信夹具转 Markdown：无 \\* 与字符引用，<img width> 独占一行，缩进为段首两个全角空格，单换行为反斜杠硬换行', async (t) => {
    // Act
    const markdown = await mdRenderer.render(await parseWechatFixture(t));
    const lines = markdown.split('\n');

    // Assert
    assert.ok(!markdown.includes('\\*'), markdown);
    assert.ok(!markdown.includes('&#x'), markdown);
    assert.ok(lines.includes('<img src="images/image_2.png" width="677" alt="">'), markdown);
    assert.equal(lines[lines.indexOf('<img src="images/image_2.png" width="677" alt="">') + 2], '图｜夹具的第一张配图');
    assert.ok(markdown.includes('依据<strong>《夹具词典》</strong>的解释'), markdown);
    assert.ok(lines.includes(`${IDEO}${IDEO}首行缩进两字的段落，来自 text-indent。`), markdown);
    assert.ok(lines.includes(`${IDEO}${IDEO}四个不换行空格起首的段落。`), markdown);
    assert.ok(lines.includes('单个换行之前\\'), markdown);
});

test('区间号页面：「~」逐字进入 IR，delete 只来自 <del>/<s>，<sup>/<sub> 成节点，Markdown 不把区间号变成删除线', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());

    // Act
    const doc = await parse({ url: `${server.base}/range` }, { allowPrivateNetwork: true });
    const paragraphs = doc.ir.children.filter((n) => n.type === 'paragraph');
    const markdown = await mdRenderer.render(doc);

    // Assert：四段正文逐字保留，波浪号不被吞
    assert.deepEqual(paragraphs.map(plainText), [
        'C1~C30的烷基、C1~C30的烷氧基',
        '疗程3~5天，有效率10~20%',
        'R2、C1的烷基',
        '原价3~5元，现价作废两元',
    ]);

    // Assert：delete 节点只来自真正的删除线标签
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'delete').map(plainText), ['3~5元', '作废']);

    // Assert：上下标进入 IR
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'superscript').map(plainText), ['2']);
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'subscript').map(plainText), ['1']);

    // Assert：md 产物中区间号不再是删除线，上下标以 HTML 标签落地
    assert.ok(!markdown.includes('~~C30'), markdown);
    assert.ok(markdown.includes('<sup>2</sup>') && markdown.includes('<sub>1</sub>'), markdown);
});

test('表题页面：<caption> 成紧邻表格之前的独立段落，「~」「*」逐字进入 IR，content_list 的 table_caption 收下表题', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());
    const captionText = '表 1 各组收率（10~20℃、30~40℃，*为显著）';

    // Act
    const doc = await parse({ url: `${server.base}/table-caption` }, { allowPrivateNetwork: true });
    const markdown = await mdRenderer.render(doc);
    const lines = markdown.split('\n');

    // Assert：顶层恰有一个表题段落，其下一个兄弟是表格，文字与源文逐字相等
    const top = doc.ir.children;
    const captionAt = top.findIndex((n) => n.type === 'paragraph' && n.data && n.data.role === 'table_caption');
    const roles = JSON.stringify(top.map((n) => [n.type, (n.data && n.data.role) || null]));
    assert.equal(top.filter((n) => n.data && n.data.role === 'table_caption').length, 1, roles);
    assert.equal(plainText(top[captionAt]), captionText, roles);
    assert.equal(top[captionAt + 1].type, 'table', roles);

    // Assert：表题里的成对「~」与星号未被误解析
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'delete'), []);
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'emphasis'), []);

    // Assert：md 产物里表题行紧排在表头行之前，二者之间只隔一个空行，且无私用区标记残留
    // 「为显著」只出现在表题里；「各组收率」正文段也有，不能用来定位
    const captionLine = lines.findIndex((line) => line.includes('为显著'));
    const headerLine = lines.findIndex((line) => line.startsWith('|') && line.includes('组别'));
    assert.ok(captionLine >= 0 && headerLine >= 0, markdown);
    assert.equal(lines[captionLine + 1], '', markdown);
    assert.equal(headerLine, captionLine + 2, markdown);
    assert.ok(!MARKER_RE.test(markdown), markdown);

    // Assert：content_list 的 table 块收下表题
    const tables = buildContentList(doc).filter((block) => block.type === 'table');
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0].table_caption, [captionText]);
});

test('转义写法页面：表格单元格与图片 alt 的「~」「*」逐字进入 IR，md 产物中不出现删除线', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());

    // Act
    const doc = await parse({ url: `${server.base}/escape` }, { allowPrivateNetwork: true });
    const markdown = await mdRenderer.render(doc);

    // Assert：单元格文本逐字保留
    const tables = collect(doc.ir, (n) => n.type === 'table');
    assert.equal(tables.length, 1);
    assert.deepEqual(
        collect(tables[0], (n) => n.type === 'tableRow').map((r) => r.children.map(plainText)),
        [['温度', '代号'], ['10~20℃、30~40℃', 'a*b*c']],
    );

    // Assert：图片 alt 逐字保留
    const images = collect(doc.ir, (n) => n.type === 'image');
    assert.equal(images.length, 1);
    assert.equal(images[0].alt, '10~20℃与30~40℃对比');

    // Assert：两条通道都不再误生成 delete 与 emphasis 节点
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'delete'), []);
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'emphasis'), []);

    // Assert：md 产物中区间号不是删除线
    assert.ok(!markdown.includes('10~~20'), markdown);
    assert.ok(!markdown.includes('~~'), markdown);
});

// ============================================================
// 超长空白：整条管线的耗时上限
// ============================================================

// 计时到毫秒，返回 [结果, 毫秒数]
async function timed(fn) {
    const started = process.hrtime.bigint();
    const value = await fn();
    return [value, Number(process.hrtime.bigint() - started) / 1e6];
}

test('图片 alt 含 20 万个空格：整条管线在耗时上限内跑完，载荷两侧的文字与图片都在', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());

    // Act
    const [doc, ms] = await timed(() => parse({ url: `${server.base}/ws-alt` }, { allowPrivateNetwork: true }));

    // Assert：耗时
    assert.ok(ms < WS_PARSE_BUDGET_MS, `解析耗时 ${ms.toFixed(0)} 毫秒，应低于 ${WS_PARSE_BUDGET_MS} 毫秒`);

    // Assert：内容没有被少做
    const images = collect(doc.ir, (n) => n.type === 'image');
    assert.equal(images.length, 1);
    assert.equal(images[0].url, 'images/image_1.png');
    assert.ok(images[0].alt.startsWith('x') && images[0].alt.endsWith('y'), `alt 两端的可见文字应保留，实际：${JSON.stringify(images[0].alt.slice(0, 4))}`);
    assert.equal(doc.assets.length, 1);
});

test('正文含 20 万个不换行空格：整条管线在耗时上限内跑完，载荷两侧的文字都在', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());

    // Act
    const [doc, ms] = await timed(() => parse({ url: `${server.base}/ws-nbsp` }, { allowPrivateNetwork: true }));

    // Assert：耗时
    assert.ok(ms < WS_PARSE_BUDGET_MS, `解析耗时 ${ms.toFixed(0)} 毫秒，应低于 ${WS_PARSE_BUDGET_MS} 毫秒`);

    // Assert：内容没有被少做
    const literals = allLiterals(doc.ir);
    assert.ok(literals.includes('甲x'), `载荷前的可见文字应保留，实际：${literals.slice(0, 120)}`);
    assert.ok(literals.includes('y乙'), `载荷后的可见文字应保留，实际：${literals.slice(0, 120)}`);
});

// ============================================================
// BR 标记折叠：耗时上限与语义等价
// ============================================================

// BR 标记取自 markers（U+EF03），源码不出现不可见字面量
const BR = MARKERS.BR;
const TAB = String.fromCharCode(0x09);

// 耗时用例的载荷规模：16 万个不含 BR 的行内空白。线性化之前的 BREAK_RUN_RE 写作「前导 [ \t]* + 必需的
// BR」，在不含 BR 的长空白串上每个起点都要吞到段尾再逐位回溯，耗时随长度平方增长——本机实测
// 2 万 178 ms、4 万 694 ms、8 万 2719 ms、16 万 10618 ms
const BREAK_STRESS_LENGTH = 160000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。
// 1000 ms 使两侧余量都不小于 5 倍——线性化之前的 10618 ms 是它的 10.6 倍，线性化之后实测不足 1 ms、
// 不到它的千分之一，故慢机以及 node --test 多文件并行抢占 CPU 时都不会误报
const BREAK_STRESS_BUDGET_MS = 1000;

// 线性化之前的 BREAK_RUN_RE 与其回调，仅作短输入的差分参照：前导的 [ \t]* 在不含 BR 的长空白串上逐位
// 回溯，不可用于耗时用例的输入规模
const LEGACY_BREAK_RUN_RE = new RegExp(`[ \\t]*${BR}(?:[ \\t\\n]*${BR})*[ \\t]*\\n*`, 'g');
const LEGACY_HEADING_LINE_RE = /^#{1,6}\s/;

function legacyCollapseBreakMarkers(markdown) {
    return String(markdown).replace(LEGACY_BREAK_RUN_RE, (run, offset, whole) => {
        const count = run.split(BR).length - 1;
        const newlines = run.replace(/[^\n]/g, '');
        const lineStart = offset === 0 || whole[offset - 1] === '\n';
        const lineEnd = newlines.length > 0 || offset + run.length >= whole.length;
        if (lineStart || lineEnd) return newlines;
        if (count >= 2) return '\n\n';
        const lineHead = whole.slice(whole.lastIndexOf('\n', offset - 1) + 1, offset);
        return LEGACY_HEADING_LINE_RE.test(lineHead) ? ' ' : '\\\n';
    });
}

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

test('BR 折叠：16 万个不含 BR 的空格不触发回溯，耗时在绝对上限内且文本逐字不变', async () => {
    // Arrange：折叠只针对 BR，载荷里一个 BR 都没有，正确的输出就是原样返回
    const input = `甲${' '.repeat(BREAK_STRESS_LENGTH)}乙`;

    // Act
    const [output, ms] = await timed(() => collapseBreakMarkers(input));

    // Assert：先验输出正确，以免「快」来自少做了事
    assert.equal(output, input, '不含 BR 的文本应逐字返回');
    assert.ok(ms < BREAK_STRESS_BUDGET_MS, `折叠实测 ${ms.toFixed(1)} 毫秒，超出上限 ${BREAK_STRESS_BUDGET_MS} 毫秒`);
});

test('BR 折叠：16 万个空格与制表符混排同样不触发回溯', async () => {
    // Arrange：前导空白类含制表符，回溯路径与纯空格一致
    const input = `甲${` ${TAB}`.repeat(BREAK_STRESS_LENGTH / 2)}乙`;

    // Act
    const [output, ms] = await timed(() => collapseBreakMarkers(input));

    // Assert
    assert.equal(output, input, '不含 BR 的文本应逐字返回');
    assert.ok(ms < BREAK_STRESS_BUDGET_MS, `折叠实测 ${ms.toFixed(1)} 毫秒，超出上限 ${BREAK_STRESS_BUDGET_MS} 毫秒`);
});

test('BR 折叠与线性化之前的实现逐字等价：{空格, 制表符, 换行, BR, a, #} 上长度不超过 6 的全部字符串', () => {
    // Arrange：6 个字符的字母表上长度 0 到 6 的全部字符串共 55987 个
    const samples = everyStringUpTo(6, [' ', TAB, '\n', BR, 'a', '#']);
    assert.equal(samples.length, 55987);

    // Act & Assert
    for (const text of samples) {
        assert.equal(collapseBreakMarkers(text), legacyCollapseBreakMarkers(text), JSON.stringify(text));
    }
});

test('BR 折叠：行首、行中、行尾、标题行与前导空白的判定逐字符合预期', () => {
    // Arrange：[输入, 期望输出, 说明]
    const cases = [
        [`甲 ${BR}乙`, '甲\\\n乙', '行中的单个 BR 连同前导空白折成反斜杠硬换行'],
        [`  ${BR}甲`, '甲', '前导空白位于行首时整段删除'],
        [`甲 ${BR}\n乙`, '甲\n乙', 'BR 段位于行尾时只留下段内换行'],
        [`甲 ${BR}`, '甲', 'BR 段位于串尾时整段删除'],
        [`甲 ${BR} ${BR} 乙`, '甲\n\n乙', '两个 BR 夹空格为分段'],
        [`甲${BR}${BR}${BR}乙`, '甲\n\n乙', '三个 BR 相连同样为分段'],
        [`甲 ${BR}\n${BR}乙`, '甲\n乙', '段内含换行时按行尾处置，原样留下这一个换行'],
        [`甲 ${BR}\n${BR}\n乙`, '甲\n\n乙', '段内含两个换行时两个都留下，效果即分段'],
        [`# 标题 ${BR}续写`, '# 标题 续写', '标题行内的单个 BR 换成空格'],
        [`###### 标题${BR}续写`, '###### 标题 续写', '六级标题同样按标题处置'],
        [`甲${BR}\n    乙`, '甲\n    乙', 'BR 段不吞下一行行首的缩进'],
        [`甲 ${TAB} ${BR}乙`, '甲\\\n乙', '前导空白为制表符与空格混排'],
        [`甲${BR}乙${BR}丙`, '甲\\\n乙\\\n丙', '相邻两段只隔可见字符时各自独立判定'],
        [`甲${BR}\n  ${BR}乙`, '甲\n乙', '前一段吞掉换行后，后一段的前导空白回看止于前一段的末尾'],
        [`\n  ${BR}${BR}甲`, '\n甲', '行首的连续 BR 连同前导空白一并删除'],
        ['甲    乙', '甲    乙', '不含 BR 的空白逐字不动'],
    ];

    // Act & Assert
    for (const [input, expected, note] of cases) {
        assert.equal(collapseBreakMarkers(input), expected, `${note}：${JSON.stringify(input)}`);
    }
});

// 行首回扫耗时用例的载荷规模：同一行里 20 万个单个 BR（与 'a' 交替，共 40 万字符）。行首定位改为增量维护
// 之前，每个「不在行首、不在行尾、只含一个 BR」的段都从段起点 lastIndexOf 回扫到行首，同一行 n 段合计
// O(n²)——本机直接调用实测 2.5 万 172 ms、5 万 674 ms、10 万 2428 ms、20 万 10138 ms（每翻倍约 4 倍）
const BREAK_LINE_STRESS_COUNT = 200000;
// 耗时上限取绝对值，理由同 BREAK_STRESS_BUDGET_MS。1000 ms 使两侧余量都不小于 5 倍——改动之前本用例
// 3 次实测 9599.5 ms、9136.1 ms、9193.1 ms，最快一次是它的 9.1 倍；改动之后以同一载荷、同一计时区间
// 3 次实测 26.8 ms、31.4 ms、26.5 ms，最慢一次不到它的 1/30，故慢机以及 node --test 多文件并行抢占 CPU
// 时都不会误报
const BREAK_LINE_STRESS_BUDGET_MS = 1000;

// 差分用例：定种子伪随机生成 2 万个长 20 到 60 字符的串，用例失败可原样复现。上面穷举的长度上限 6
// 放不下「标题前缀 + 两段单个 BR」（至少 7 个字符）与六级标题前缀后的单个 BR 这类组合，故另以长串抽样
const BREAK_DIFF_SEED = 20260923;
const BREAK_DIFF_COUNT = 20000;
const BREAK_DIFF_MIN_LENGTH = 20;
const BREAK_DIFF_MAX_LENGTH = 60;
// 加权字母表（重复列出即加权）：BR 与 a 各占十分之三，使一行常含多段单个 BR；换行占十分之一，
// 使一串通常跨几行、段间常夹换行
const BREAK_DIFF_ALPHABET = Object.freeze([' ', TAB, '\n', BR, BR, BR, 'a', 'a', 'a', '#']);
// 每到行首先以此概率插入标题前缀：1 到 7 个 # 接空格或制表符，其中 7 个 # 不成标题，用于核对判定窗口的边界
const BREAK_DIFF_HEADING_RATE = 0.5;
// 行中的单个 BR：前后各有一个可见字符，其间只隔零到多个行内空白。在上述字母表内，这类 BR 恰好各自成段
// 并走到标题判定，故覆盖面按它计数：所在行有标题前缀、且它前面那个可见字符位于前缀之后的换成空格，
// 其余换成反斜杠硬换行
const MID_LINE_BREAK_RE = new RegExp(`(?<=[a#][ \\t]*)${BR}(?=[ \\t]*[a#])`, 'g');
const HEADING_PREFIX_RE = /^#{1,6}[ \t]/;
// 覆盖面各类的下限：定种子下实测最少的一类（三者兼具的行）为 2388 行。下限只为发现生成器被改得铺不开，
// 故取约为其四成的 1000，不贴着实测值设定
const BREAK_DIFF_MIN_HITS = 1000;

// 随机串：逐字符从加权字母表抽取，每到行首先按概率插入标题前缀，最后截到抽定的长度
function randomBreakText(random) {
    const length = BREAK_DIFF_MIN_LENGTH + Math.floor(random() * (BREAK_DIFF_MAX_LENGTH - BREAK_DIFF_MIN_LENGTH + 1));
    let text = '';
    while (text.length < length) {
        if ((text === '' || text.endsWith('\n')) && random() < BREAK_DIFF_HEADING_RATE) {
            text += `${'#'.repeat(1 + Math.floor(random() * 7))}${random() < 0.5 ? ' ' : TAB}`;
        }
        text += BREAK_DIFF_ALPHABET[Math.floor(random() * BREAK_DIFF_ALPHABET.length)];
    }
    return text.slice(0, length);
}

// 覆盖面统计：逐行数出行中的单个 BR，分标题行内与非标题行内两类；另记同一行含两段以上的行数、
// 之前隔着换行另有 BR 的段数，以及三者兼具（标题行、行内两段以上、之前隔着换行另有 BR）的行数
function tallyBreakCoverage(text, coverage) {
    let breakAbove = false;
    for (const line of text.split('\n')) {
        const prefix = HEADING_PREFIX_RE.exec(line);
        const mids = (line.match(MID_LINE_BREAK_RE) || []).length;
        const headingMids = prefix ? (line.slice(prefix[0].length).match(MID_LINE_BREAK_RE) || []).length : 0;
        coverage.headingLine += headingMids;
        coverage.plainLine += mids - headingMids;
        if (mids >= 2) coverage.sameLine += 1;
        if (breakAbove) coverage.belowNewline += mids;
        if (breakAbove && headingMids >= 2) coverage.combined += 1;
        if (line.includes(BR)) breakAbove = true;
    }
}

test('BR 折叠行首定位：同一行 20 万个单个 BR 不触发平方级回扫，耗时在绝对上限内且逐个折成反斜杠硬换行', async () => {
    // Arrange：'a' 与 BR 交替，每段都不在行首、不在行尾、只含一个 BR，所在行也不是标题，正确的输出是
    // 每个 BR 都换成反斜杠硬换行；载荷在用例内现场构造，不与其他用例共用
    const input = `${`a${BR}`.repeat(BREAK_LINE_STRESS_COUNT)}a`;
    const expected = `${'a\\\n'.repeat(BREAK_LINE_STRESS_COUNT)}a`;

    // Act：计时区间只包 collapseBreakMarkers 一次调用，载荷与期望串的构造在区间之外
    const [output, ms] = await timed(() => collapseBreakMarkers(input));

    // Assert：先验输出正确，以免「快」来自少做了事
    assert.equal(output, expected, '每个单个 BR 都应折成反斜杠硬换行，其余字符逐字不变');
    assert.ok(ms < BREAK_LINE_STRESS_BUDGET_MS, `折叠实测 ${ms.toFixed(1)} 毫秒，超出上限 ${BREAK_LINE_STRESS_BUDGET_MS} 毫秒`);
});

test('BR 折叠行首定位：定种子随机生成的 2 万个串上与线性化之前的实现逐字等价，覆盖同一行多段、标题行与段间换行', () => {
    // Arrange
    const random = seededRandom(BREAK_DIFF_SEED);
    const coverage = { headingLine: 0, plainLine: 0, sameLine: 0, belowNewline: 0, combined: 0 };

    for (let index = 0; index < BREAK_DIFF_COUNT; index += 1) {
        const text = randomBreakText(random);

        // Act & Assert
        assert.equal(collapseBreakMarkers(text), legacyCollapseBreakMarkers(text), `第 ${index} 个串：${JSON.stringify(text)}`);
        tallyBreakCoverage(text, coverage);
    }

    // Assert：核对面确实铺开了——标题行内与非标题行内的单个 BR、同一行多段、隔着换行的段以及三者兼具的行都不少
    for (const [kind, hits] of Object.entries(coverage)) {
        assert.ok(hits >= BREAK_DIFF_MIN_HITS, `覆盖面 ${kind} 只有 ${hits} 处，应不少于 ${BREAK_DIFF_MIN_HITS} 处`);
    }
});

test('BR 折叠行首定位：同一行多段、标题行与跨行时逐字符合预期', () => {
    // Arrange：[输入, 期望输出, 说明]
    const cases = [
        [`# 标题${BR}甲${BR}乙`, '# 标题 甲 乙', '标题行内的两段单个 BR 都换成空格'],
        [`# 标题${BR}甲\n乙${BR}丙`, '# 标题 甲\n乙\\\n丙', '换行之后的下一行不是标题，其中的单个 BR 为反斜杠硬换行'],
        [`甲${BR}乙\n## 小节${BR}丙${BR}丁`, '甲\\\n乙\n## 小节 丙 丁', '正文行之后的标题行，行内两段都换成空格'],
        [`# 标题${BR}\n乙${BR}丙`, '# 标题\n乙\\\n丙', '换行被前一段吞下时，后一段的行首从该换行之后算起'],
        [`甲${BR}\n# 标题${BR}乙`, '甲\n# 标题 乙', '换行被前一段吞下时，下一行的标题照常识别'],
        [`甲${BR}乙\n丙\n# 标题${BR}丁`, '甲\\\n乙\n丙\n# 标题 丁', '两段之间隔着多行时，行首推进过其间的全部换行'],
        [`###### 标题${BR}甲${BR}乙`, '###### 标题 甲 乙', '六级标题前缀连同空白共 7 个字符，恰在判定窗口之内'],
        [`####### 七个${BR}甲`, '####### 七个\\\n甲', '7 个 # 不成标题'],
        [`#${TAB}标题${BR}甲`, `#${TAB}标题 甲`, '# 后接制表符同样算标题'],
        [`# ${BR}甲`, '#\\\n甲', '标题前缀的空白并入 BR 段，段前只剩 #，不算标题'],
    ];

    // Act & Assert
    for (const [input, expected, note] of cases) {
        assert.equal(collapseBreakMarkers(input), expected, `${note}：${JSON.stringify(input)}`);
    }
});

// ============================================================
// 段首缩进标注：嵌套块判定的耗时上限与语义等价
// ============================================================

// 耗时用例的载荷规模：一个叶子块下 10 万个直接子元素。线性化之前的「是否含嵌套块」判定走 cheerio 的
// $el.find(NESTED_BLOCK_SELECTOR)，它把该元素的全部子元素交给 css-select 的 prepareContext，
// 其中 removeSubsets 对这组根逐个做 lastIndexOf / includes，同级子元素 n 个即 O(n²)——本机实测
// 1 万 84 ms、2 万 311 ms、4 万 1215 ms、8 万 4789 ms、10 万 7607 ms（每翻倍约 4 倍）
const INDENT_STRESS_CHILDREN = 100000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。
// 1000 ms 使两侧余量都不小于 5 倍——线性化之前的 7607 ms 是它的 7.6 倍，线性化之后同一载荷实测
// 27 ms 上下、余量 36 倍，故慢机以及 node --test 多文件并行抢占 CPU 时都不会误报。
// 直接调用 markIndents 而不走全链路 parse：其余阶段（cheerio 载入、正文提取、turndown、remark）
// 自身线性的耗时会垫高线性化之后的总时长，两侧余量无法同时达到 5 倍（4 万时全链路新旧之比仅约 3.2）
const INDENT_STRESS_BUDGET_MS = 1000;

// 差分用例的随机树：字母表含叶子块、嵌套块、行内元素，以及 .find() 行为需实测确认的边角标签
const DIFF_TREE_TAGS = Object.freeze([
    'p', 'section', 'div', 'li', 'blockquote', 'ul', 'ol', 'table', 'figure', 'pre', 'h1', 'h6',
    'span', 'em', 'strong', 'i', 'a', 'template', 'svg', 'math', 'script', 'style',
]);
const DIFF_TREE_SEED = 20260919;
const DIFF_TREE_COUNT = 6000;
const DIFF_TREE_MAX_DEPTH = 3;
const DIFF_TREE_MAX_CHILDREN = 3;

// 与 url.js 的 VISIBLE_TEXT_RE 同一判据：JS 的 \s 含不换行空格与全角空格，故「有可见文字」即含非 \s 字符
const VISIBLE_TEXT_IN_TEST_RE = /[^\s]/;
// 选择器串的现状字面量：web/extract.js 也用同一个串走 linkedom 的 querySelector，故必须逐字节不变
const NESTED_BLOCK_LITERAL = 'p, section, div, li, blockquote, ul, ol, table, figure, pre, h1, h2, h3, h4, h5, h6';

// markIndents 以 prepend 插入标记，标注过的元素首个子节点即以 INDENT 标记开头的文本节点
function isIndentMarked(el) {
    const first = el && (el.children || [])[0];
    return Boolean(first && first.type === 'text' && String(first.data || '').startsWith(MARKERS.INDENT));
}

// 定种子的 mulberry32 伪随机数：同一种子每次生成同一批树，用例失败可原样复现
function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 随机小树：每个元素都带 text-indent:2em 与可见文字，故凡过判定者折算字数必为 2，判定与标注一一对应
function randomTree(random, depth) {
    const tag = DIFF_TREE_TAGS[Math.floor(random() * DIFF_TREE_TAGS.length)];
    const count = depth <= 0 ? 0 : Math.floor(random() * (DIFF_TREE_MAX_CHILDREN + 1));
    const inner = Array.from({ length: count }, () => randomTree(random, depth - 1)).join('');
    return `<${tag} style="text-indent:2em">甲${inner}</${tag}>`;
}

test('段首缩进标注：叶子块下 10 万个并列子元素不触发平方级扫描，耗时在绝对上限内且缩进照常标注', async () => {
    // Arrange：段首四个不换行空格折两字；载荷两端留可见文字，便于核对没有少做
    const html = `<p>&nbsp;&nbsp;&nbsp;&nbsp;甲x${'<i>&nbsp;</i>'.repeat(INDENT_STRESS_CHILDREN)}y乙</p>`;
    const $ = cheerio.load(html, null, false);

    // Act：计时区间只包 markIndents 一次调用，cheerio.load 在区间之外
    const [, ms] = await timed(() => markIndents($));

    // Assert：先验标注正确，以免「快」来自少做了事
    const text = $('p').text();
    const codes = [...text.slice(0, 4)].map((char) => char.codePointAt(0).toString(16)).join(',');
    assert.ok(text.startsWith(`${indentMarker(2)}甲x`), `段首应为两字缩进标记接「甲x」，实际前四个码点：${codes}`);
    assert.ok(text.endsWith('y乙'), '载荷末端的可见文字应保留');
    assert.ok(ms < INDENT_STRESS_BUDGET_MS, `标注实测 ${ms.toFixed(1)} 毫秒，超出上限 ${INDENT_STRESS_BUDGET_MS} 毫秒`);
});

test('段首缩进标注：定种子随机树上，实际被标注的元素集合与旧判定算出的集合逐个一致', () => {
    // Arrange
    const random = seededRandom(DIFF_TREE_SEED);
    let candidateCount = 0;

    for (let index = 0; index < DIFF_TREE_COUNT; index += 1) {
        const html = randomTree(random, DIFF_TREE_MAX_DEPTH);
        const $ = cheerio.load(html, null, false);

        // Arrange：给每个候选叶子块编号，标注前后据此对应
        const candidates = $(LEAF_BLOCK_SELECTOR).toArray();
        candidates.forEach((el, at) => $(el).attr('data-mf-probe', String(at)));
        const probeOf = (el) => $(el).attr('data-mf-probe');

        // Arrange：旧判定（cheerio 的 .find() 加可见文字）算出的「应被标注的元素集合」
        const expected = candidates
            .filter((el) => $(el).find(NESTED_BLOCK_SELECTOR).length === 0 && VISIBLE_TEXT_IN_TEST_RE.test($(el).text()))
            .map(probeOf);

        // Act
        markIndents($);

        // Assert
        assert.deepEqual(candidates.filter(isIndentMarked).map(probeOf), expected, `第 ${index} 棵树：${html}`);
        candidateCount += candidates.length;
    }

    // Assert：核对面确实铺开了，不是一批空树
    assert.ok(candidateCount > DIFF_TREE_COUNT, `候选叶子块应多于树的棵数，实际 ${candidateCount} 个`);
});

test('段首缩进标注：每个嵌套块标签都让外层块不再是叶子块，其自身照常标注', () => {
    // Arrange & Act & Assert
    for (const tag of NESTED_BLOCK_TAGS) {
        const $ = cheerio.load(`<div style="text-indent:2em">甲<${tag}>乙</${tag}></div>`, null, false);
        markIndents($);
        assert.equal(isIndentMarked($('div').first()[0]), false, `外层 div 含 <${tag}> 后代时不应标注`);
    }

    // Assert：对照组——同一形态换成行内后代，外层照常标注
    const $inline = cheerio.load('<div style="text-indent:2em">甲<em>乙</em></div>', null, false);
    markIndents($inline);
    assert.equal(isIndentMarked($inline('div').first()[0]), true, '只含行内后代的 div 应标注');
});

test('段首缩进标注：嵌套块藏在行内元素、template 与外来内容里同样不算叶子块；注释与 script／style 不影响标注', () => {
    // Arrange：[HTML, 外层 div 是否应被标注, 说明]
    const cases = [
        ['<div style="text-indent:2em">甲<span><p>乙</p></span></div>', false, '嵌套块藏在 span 里'],
        ['<div style="text-indent:2em">甲<span><em><blockquote>乙</blockquote></em></span></div>', false, '嵌套块藏在两层行内元素里'],
        ['<div style="text-indent:2em">甲<template><p>乙</p></template></div>', false, '候选块在载入根之下时，template 内容片段里的块照样计数'],
        ['<em>甲<div style="text-indent:2em">乙<template><p>丙</p></template></div></em>', true, '候选块的父节点是元素时，cheerio 给选择器加 :scope 后代，其后代组合子不跨 template 的内容片段，片段里的块一律匹配不到'],
        ['<em>甲<div style="text-indent:2em">乙<span><p>丙</p></span></div></em>', false, '同为嵌套候选，块不在 template 里时照常计数'],
        ['<div style="text-indent:2em">甲<svg><section>乙</section></svg></div>', false, 'svg 外来内容里的同名元素照样计数'],
        ['<div style="text-indent:2em">甲<math><section>乙</section></math></div>', false, 'math 外来内容里的同名元素照样计数'],
        ['<div style="text-indent:2em">甲<span><em>乙</em></span></div>', true, '只含行内后代'],
        ['<div style="text-indent:2em">甲<!--这里写了 p 标签--></div>', true, '注释不是元素'],
        ['<div style="text-indent:2em">甲<script>var html = "<p>乙</p>";</script></div>', true, 'script 的内容是原始文本，其中的标签名不算块'],
        ['<div style="text-indent:2em">甲<style>p { color: red; }</style></div>', true, 'style 的内容同样是原始文本'],
        ['<div style="text-indent:2em">甲<svg><circle></circle></svg></div>', true, 'svg 里没有同名块'],
        ['<div style="text-indent:2em">甲<template><span>乙</span></template></div>', true, 'template 里只有行内元素'],
    ];

    // Act & Assert
    for (const [html, marked, note] of cases) {
        const $ = cheerio.load(html, null, false);
        markIndents($);
        assert.equal(isIndentMarked($('div').first()[0]), marked, `${note}：${html}`);
    }
});

test('嵌套块选择器由标签名列表派生，与现有字面串逐字节相同', () => {
    // Assert：web/extract.js 把同一个串交给 linkedom 的 querySelector，串变了那条链路就跟着变
    assert.equal(NESTED_BLOCK_SELECTOR, NESTED_BLOCK_LITERAL);
    assert.equal(NESTED_BLOCK_SELECTOR, NESTED_BLOCK_TAGS.join(', '));
});

// ============================================================
// 空 span 清理与相邻 strong 合并：耗时上限与语义等价
// ============================================================

const { tidyEmptySpans, mergeAdjacentStrong } = require('../converters/parsers/url');
const { isAttached } = require('../converters/web/noise');

// 空 span 清理耗时用例的载荷规模：载荷 A、B 为同一父元素下 10 万个并列子元素，拆包载荷 C 为 3 万组 <br><i></i>
// （6 万个子元素）。改写之前三条路径各有一处平方级：A 的 $el.find('img') 把 span 的全部子元素交给 css-select 的
// prepareContext，其中 removeSubsets 对这组根逐个做 lastIndexOf / includes；B 的 $el.remove() 逐个在父节点
// children 上做 lastIndexOf + splice；C 先两次 .find()，再由 $el.replaceWith($el.contents()) 对每个子节点做
// removeElement。本机直接调用实测（每次新构造输入并重新载入）：A 1 万 94.8 ms、2 万 368.0 ms、4 万 1439.8 ms、
// 8 万 5721.8 ms；B 1 万 104.4 ms、2 万 334.0 ms、4 万 1254.7 ms、8 万 4917.3 ms；C 1 万组 1019.2 ms、2 万组 4084.3 ms、
// 4 万组 16262.4 ms（每翻倍约 4 倍）。C 的 replaceWith 经 cheerio 的 uniqueSplice 以 array.splice(...args) 一次展开
// 全部子节点，本机展开约 12.4 万个实参即抛 RangeError；3 万组只展开 6 万个，改写之前的红灯是耗时失败而非异常
const SPAN_STRESS_CHILDREN = 100000;
const SPAN_STRESS_BREAK_PAIRS = 30000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。
// 1000 ms 使两侧余量都不小于 5 倍——改写之前本节三个用例各实测 3 次，最快一次为 A 8840.7 ms、B 7107.7 ms、
// C 8415.9 ms，分别是它的 8.8、7.1、8.4 倍；改写之后同一用例各实测 18 次（其中 3 次与全量测试并行），最慢一次为
// A 64.9 ms、B 33.4 ms、C 18.9 ms，余量分别为 15.4、29.9、52.9 倍，故慢机以及 node --test 多文件并行抢占 CPU 时
// 都不会误报。直接调用 tidyEmptySpans、计时区间只包这一次调用：cheerio.load 与 preprocessHtml 的其余步骤不计入，
// 两侧余量只反映本函数
const SPAN_STRESS_BUDGET_MS = 1000;

// 相邻 strong 合并耗时用例的载荷规模：载荷 A 为同一段落下 12 万个首尾相接的 strong，载荷 B 为 6 万段两两相邻的
// strong（共 12 万个）。改写之前二者逐个以 $(next).remove() 删除后继，每次在父节点 children 上做 lastIndexOf + splice。
// 本机直接调用实测：A 1 万 85.5 ms、2 万 312.4 ms、4 万 1163.0 ms、8 万 4548.4 ms；B 1 万 60.8 ms、2 万 226.9 ms、
// 4 万 872.2 ms、8 万 3425.0 ms（每翻倍约 4 倍）
const STRONG_STRESS_COUNT = 120000;
// 耗时上限取绝对值，理由同 SPAN_STRESS_BUDGET_MS。1000 ms 使两侧余量都不小于 5 倍——改写之前 A、B 各实测 3 次，
// 最快一次为 A 10243.9 ms、B 7667.1 ms，分别是它的 10.2、7.7 倍；改写之后各实测 18 次（其中 3 次与全量测试并行），
// 最慢一次为 A 44.7 ms、B 39.9 ms，余量分别为 22.4、25.1 倍
const STRONG_STRESS_BUDGET_MS = 1000;
// 载荷 C 为一个后继 strong 下 10 万个子元素。改写之前 $(el).append($(next).contents()) 经 cheerio 的 uniqueSplice
// 对搬移的每个节点在旧父节点 children 上做 indexOf + splice，耗时随规模平方增长（每次计时前先全量回收的直接调用
// 实测：1 万 24.5 ms、2 万 87.6 ms、4 万 329.2 ms、8 万 1236.0 ms），且以 array.splice(...args) 一次展开全部新节点：
// 本机展开上限约 12.4 万个实参，12 万成功、13 万抛 RangeError。取 10 万，距上限留两成，改写之前的红灯是耗时失败而非异常
const STRONG_MOVE_CHILDREN = 100000;
// 载荷 C 的上限单列为 120 ms。splice 每次挪动 10 万项以内的指针数组，单价随该数组所在的代际相差十倍上下：数组仍在
// 新生代时不走写屏障，改写之前 10 万实测 616.5–678.4 ms（以 --min-semi-space-size=256 --max-semi-space-size=256
// 强制；默认参数下 9 万、11.5 万也时常落入此态，约 0.5、0.8 s）；已晋升老生代时逐项过写屏障，默认参数下独立运行
// 3.7–6.9 s，本用例 3 次实测 5843.1、5779.9、6804.6 ms。120 ms 使快态最快的 616.5 ms 仍是它的 5.1 倍；改写之后实测
// 18 次（其中 3 次与全量测试并行）最慢 23.0 ms，余量 5.2 倍。规模已贴近展开上限，两侧余量无法同时再放宽
// CI 上按 test/helpers/timing-budget.js 的系数放宽：CI 三平台上计时区间的估计最大值为 66 ms，放宽后余量 7.3 倍
const STRONG_MOVE_BUDGET_MS = 120;

test('空 span 清理：含可见字的 span 下 10 万个并列子元素不触发平方级扫描，耗时在绝对上限内且 span 原样保留', async () => {
    // Arrange：span 含可见字，按规则保留；改写之前判定它有无 img 后代的一次 .find() 即平方级
    const html = `<p><span>甲x${'<i>&nbsp;</i>'.repeat(SPAN_STRESS_CHILDREN)}y乙</span></p>`;
    const $ = cheerio.load(html, null, false);

    // Act：计时区间只包 tidyEmptySpans 一次调用，cheerio.load 在区间之外
    const [, ms] = await timed(() => tidyEmptySpans($));

    // Assert：先验结果正确，以免「快」来自少做了事——span 连同全部子元素与两端文字原样保留
    const span = $('span');
    assert.equal(span.length, 1, 'span 应保留');
    assert.equal(span[0].children.length, SPAN_STRESS_CHILDREN + 2, 'span 下应为两端文字加全部 i');
    const text = span.text();
    assert.ok(text.startsWith('甲x') && text.endsWith('y乙'), '载荷两端的可见文字应保留');
    assert.ok($.html() === html, '整段 HTML 应逐字不变');
    assert.ok(ms < SPAN_STRESS_BUDGET_MS, `清理实测 ${ms.toFixed(1)} 毫秒，超出上限 ${SPAN_STRESS_BUDGET_MS} 毫秒`);
});

test('空 span 清理：同一段落下 10 万个空 span 逐个删除不触发平方级拼接，耗时在绝对上限内且两端文字相连', async () => {
    // Arrange：每个 span 既无文字也无 br，按规则删除；改写之前逐个 .remove() 即平方级
    const html = `<p>甲${'<span></span>'.repeat(SPAN_STRESS_CHILDREN)}乙</p>`;
    const $ = cheerio.load(html, null, false);

    // Act
    const [, ms] = await timed(() => tidyEmptySpans($));

    // Assert：先验结果正确——span 全部删除，段落里只剩两端文字
    assert.equal($('span').length, 0, 'span 应全部删除');
    assert.equal($.html(), '<p>甲乙</p>');
    assert.ok(ms < SPAN_STRESS_BUDGET_MS, `清理实测 ${ms.toFixed(1)} 毫秒，超出上限 ${SPAN_STRESS_BUDGET_MS} 毫秒`);
});

test('空 span 清理：只含换行的 span 下 3 万组 br 与空 i 拆包不触发平方级扫描，耗时在绝对上限内且子元素按原序留在段落下', async () => {
    // Arrange：span 没有文字、含 br，按规则拆包；i 不是 span，随之留在段落下
    const pairs = '<br><i></i>'.repeat(SPAN_STRESS_BREAK_PAIRS);
    const html = `<p>甲<span>${pairs}</span>乙</p>`;
    const $ = cheerio.load(html, null, false);

    // Act
    const [, ms] = await timed(() => tidyEmptySpans($));

    // Assert：先验结果正确——span 拆包，br 与 i 数量不变、按原序夹在两端文字之间
    assert.equal($('span').length, 0, 'span 应拆包');
    assert.equal($('p')[0].children.length, SPAN_STRESS_BREAK_PAIRS * 2 + 2, '段落下应为两端文字加全部 br 与 i');
    assert.ok($.html() === `<p>甲${pairs}乙</p>`, 'br 与 i 应按原序留在段落下');
    assert.ok(ms < SPAN_STRESS_BUDGET_MS, `清理实测 ${ms.toFixed(1)} 毫秒，超出上限 ${SPAN_STRESS_BUDGET_MS} 毫秒`);
});

test('相邻 strong 合并：同一段落下 12 万个首尾相接的 strong 并为一个不触发平方级删除，耗时在绝对上限内且文字按原序并入', async () => {
    // Arrange：strong 之间不夹任何节点，按规则全部并入第一个；改写之前逐个 $(next).remove() 即平方级
    const html = `<p>甲${'<strong>粗</strong>'.repeat(STRONG_STRESS_COUNT)}乙</p>`;
    const $ = cheerio.load(html, null, false);

    // Act：计时区间只包 mergeAdjacentStrong 一次调用，cheerio.load 在区间之外
    const [, ms] = await timed(() => mergeAdjacentStrong($));

    // Assert：先验结果正确——只剩一个 strong，其文字为全部「粗」，两端文字留在 strong 之外
    const strong = $('strong');
    assert.equal(strong.length, 1, '应只剩一个 strong');
    assert.ok(strong.text() === '粗'.repeat(STRONG_STRESS_COUNT), 'strong 的文字应为全部「粗」');
    assert.ok($.html() === `<p>甲<strong>${'粗'.repeat(STRONG_STRESS_COUNT)}</strong>乙</p>`, '两端文字应原样留在 strong 之外');
    assert.ok(ms < STRONG_STRESS_BUDGET_MS, `合并实测 ${ms.toFixed(1)} 毫秒，超出上限 ${STRONG_STRESS_BUDGET_MS} 毫秒`);
});

test('相邻 strong 合并：同一段落下 6 万段两两相邻的 strong 各自合并不触发平方级删除，耗时在绝对上限内且每段文字为 ab', async () => {
    // Arrange：每段两个 strong 相邻、段间隔着文字 x，按规则各自并为一个
    const segments = STRONG_STRESS_COUNT / 2;
    const html = `<p>${'<strong>a</strong><strong>b</strong>x'.repeat(segments)}</p>`;
    const $ = cheerio.load(html, null, false);

    // Act
    const [, ms] = await timed(() => mergeAdjacentStrong($));

    // Assert：先验结果正确——每段只剩一个 strong、文字为 ab，段间文字 x 原样保留
    const strongs = $('strong').toArray();
    assert.equal(strongs.length, segments, `应剩 ${segments} 个 strong`);
    assert.ok(strongs.every((el) => $(el).text() === 'ab'), '每个 strong 的文字应为 ab');
    assert.ok($.html() === `<p>${'<strong>ab</strong>x'.repeat(segments)}</p>`, '段间文字 x 应原样保留');
    assert.ok(ms < STRONG_STRESS_BUDGET_MS, `合并实测 ${ms.toFixed(1)} 毫秒，超出上限 ${STRONG_STRESS_BUDGET_MS} 毫秒`);
});

test('相邻 strong 合并：后继 strong 下 10 万个子元素并入不触发平方级搬移，耗时在绝对上限内且子元素按原序接在「甲」之后', async (t) => {
    // Arrange：后继 strong 的全部子元素一次并入前一个；改写之前 append 对搬移的每个节点在旧父节点上 indexOf + splice
    const items = '<i>x</i>'.repeat(STRONG_MOVE_CHILDREN);
    const html = `<p><strong>甲</strong><strong>${items}</strong></p>`;
    const $ = cheerio.load(html, null, false);

    // Act
    const [, ms] = await timed(() => mergeAdjacentStrong($));

    // Assert：先验结果正确——只剩一个 strong，「甲」在前，i 按原序接在其后
    const strong = $('strong');
    assert.equal(strong.length, 1, '应只剩一个 strong');
    assert.equal(strong[0].children.length, STRONG_MOVE_CHILDREN + 1, 'strong 下应为「甲」加全部 i');
    assert.equal(strong[0].children[0].data, '甲', '首个子节点应为原有的「甲」');
    assert.ok($.html() === `<p><strong>甲${items}</strong></p>`, 'i 应按原序接在「甲」之后');
    const budget = budgetMs(STRONG_MOVE_BUDGET_MS);
    t.diagnostic(`合并实测 ${ms.toFixed(1)} 毫秒，上限 ${budget} 毫秒`);
    assert.ok(ms < budget, `合并实测 ${ms.toFixed(1)} 毫秒，超出上限 ${budget} 毫秒（${STRONG_MOVE_BUDGET_MS} 毫秒 × 系数 ${BUDGET_FACTOR}）`);
});

// 改写之前的 tidyEmptySpans、mergeAdjacentStrong 及其常量（照抄 url.js），仅作短输入的差分参照：其中 .find()、.remove()、
// .replaceWith()、.append() 在同一父元素下大量子节点时平方级，不可用于耗时用例的输入规模
const LEGACY_VISIBLE_TEXT_RE = /[^\s]/;
const LEGACY_KEPT_SPACE_RE = new RegExp(`[${String.fromCharCode(0x00a0)}${String.fromCharCode(0x3000)}]`);

function legacyTidyEmptySpans($) {
    $('span').each((_, el) => {
        if (!isAttached(el)) return;
        const $el = $(el);
        if ($el.find('img').length > 0) return;
        const text = $el.text();
        if (LEGACY_VISIBLE_TEXT_RE.test(text) || LEGACY_KEPT_SPACE_RE.test(text)) return;
        if ($el.find('br').length > 0) $el.replaceWith($el.contents());
        else $el.remove();
    });
}

function legacyMergeAdjacentStrong($) {
    $('strong').each((_, el) => {
        if (!isAttached(el)) return;
        for (let next = el.next; next && next.type === 'tag' && next.name === 'strong'; next = el.next) {
            $(el).append($(next).contents());
            $(next).remove();
        }
    });
}

// 差分用例的随机森林：顶层 1 到 3 个节点，其下每个元素 0 到 INLINE_DIFF_MAX_CHILDREN 个子节点、深度至多
// INLINE_DIFF_MAX_DEPTH，文本、注释与元素混排
const INLINE_DIFF_MAX_DEPTH = 4;
const INLINE_DIFF_MAX_CHILDREN = 4;
// 文本：空串、ASCII 空白（空格、制表符、换行）、不换行空格、全角空格、可见字
const INLINE_DIFF_TEXTS = Object.freeze(['', ' ', '\t', '\n', WS_NBSP, IDEO, '甲']);
// 注释：含形似标签的内容，既不计入文字，也不是元素
const INLINE_DIFF_COMMENTS = Object.freeze(['<!--甲-->', '<!--<br>-->', '<!---->']);
// 空元素不带结束标签；原始文本元素只生成文本内容，其中形似标签的字符不经 HTML 解析
const INLINE_DIFF_VOID_TAGS = new Set(['img', 'br']);
const INLINE_DIFF_RAW_TEXT_TAGS = new Set(['script', 'style']);
const INLINE_DIFF_RAW_TEXTS = Object.freeze(['', '甲', '<br>', '<img src="x">', '<span></span>', '<strong>甲</strong>']);

// 空 span 清理的森林：字母表含 span、strong、img、br、i、em、a、p、div、template、svg、math、script、style，span 重复十次
// 以提高其出现率。span 的子树有八成改从空白倾向的字母表取：文本多为 ASCII 空白、偶有不换行空格与全角空格，元素只有 br、
// 行内元素、template 与 img，用于造出删除与拆包及其边界（夹着 img、不换行空格或全角空格则保留，br 或 img 藏在 template
// 里则视父节点而定）
const TIDY_DIFF_SPEC = Object.freeze({
    tags: Object.freeze([...Array(10).fill('span'), 'strong', 'img', 'br', 'i', 'em', 'a', 'p', 'div', 'template', 'svg', 'math', 'script', 'style']),
    texts: INLINE_DIFF_TEXTS,
    blankTags: Object.freeze(['br', 'br', 'br', 'i', 'em', 'span', 'span', 'span', 'span', 'a', 'template', 'img']),
    blankTexts: Object.freeze(['', '', ' ', ' ', '\t', '\n', '\n', WS_NBSP, IDEO]),
    blankChance: 0.8,
    strongRunChance: 0,
});
const TIDY_DIFF_SEED = 20260927;
const TIDY_DIFF_TREE_COUNT = 10000;

// 相邻 strong 合并的森林：同一字母表，strong 重复两次；每个子节点位另以 35% 的概率改为连续生成 2 到 4 个 strong 兄弟
// （受该元素剩余的子节点位数所限），其子树照常生成、可再含 strong 串，用于造出连续并入、并入空 strong 与搬移后再合并
const MERGE_DIFF_SPEC = Object.freeze({
    tags: Object.freeze(['strong', 'strong', 'span', 'img', 'br', 'i', 'em', 'a', 'p', 'div', 'template', 'svg', 'math', 'script', 'style']),
    texts: INLINE_DIFF_TEXTS,
    blankChance: 0,
    strongRunChance: 0.35,
});
const MERGE_DIFF_SEED = 20260928;
const MERGE_DIFF_TREE_COUNT = 10000;

// 随机森林的 HTML；blank 为真时只从 spec 的空白倾向字母表取（仅 span 的子树按 spec.blankChance 进入）
function randomInlineForest(random, spec, depth = INLINE_DIFF_MAX_DEPTH, blank = false) {
    const pickFrom = (list) => list[Math.floor(random() * list.length)];
    const slots = depth === INLINE_DIFF_MAX_DEPTH
        ? 1 + Math.floor(random() * 3)
        : Math.floor(random() * (INLINE_DIFF_MAX_CHILDREN + 1));
    const element = (tag) => {
        if (INLINE_DIFF_VOID_TAGS.has(tag)) return `<${tag}>`;
        if (INLINE_DIFF_RAW_TEXT_TAGS.has(tag)) return `<${tag}>${pickFrom(INLINE_DIFF_RAW_TEXTS)}</${tag}>`;
        const blankInside = blank || (tag === 'span' && random() < spec.blankChance);
        return `<${tag}>${randomInlineForest(random, spec, depth - 1, blankInside)}</${tag}>`;
    };
    let html = '';
    for (let used = 0; used < slots;) {
        const room = slots - used;
        if (depth > 0 && room >= 2 && random() < spec.strongRunChance) {
            const run = Math.min(2 + Math.floor(random() * 3), room);
            for (let index = 0; index < run; index += 1) html += element('strong');
            used += run;
            continue;
        }
        used += 1;
        const roll = random();
        if (depth <= 0 || roll < 0.3) html += pickFrom(blank ? spec.blankTexts : spec.texts);
        else if (roll < 0.35) html += pickFrom(INLINE_DIFF_COMMENTS);
        else html += element(pickFrom(blank ? spec.blankTags : spec.tags));
    }
    return html;
}

// 在这一份载入的 cheerio 实例上计数 remove 与 replaceWith 的调用：$.fn 为每次载入各自的原型，不影响其他载入。
// lifted 另计「父节点已被祖先的拆包换成祖父节点」之后才删除或拆包的 span：它所在父节点的 children 数组里还留着
// 已拆包的祖先，改写后须在压实时先展开、再剔除
function countSpanMutations($) {
    const counts = { remove: 0, replaceWith: 0, lifted: 0 };
    const originalParent = new Map($('span').toArray().map((el) => [el, el.parent]));
    const noteLifted = (el) => {
        if (el.parent !== originalParent.get(el)) counts.lifted += 1;
    };
    const { remove, replaceWith } = $.fn;
    $.fn.remove = function countedRemove(...args) {
        counts.remove += 1;
        noteLifted(this[0]);
        return remove.apply(this, args);
    };
    $.fn.replaceWith = function countedReplaceWith(...args) {
        counts.replaceWith += 1;
        noteLifted(this[0]);
        return replaceWith.apply(this, args);
    };
    return counts;
}

// 在这一份载入的 cheerio 实例上计数 append 的调用，即并入后继 strong 的次数。emptySources 另计后继没有子节点的并入
// （原生 append 此时把当前 strong 末子节点的 next 置为 undefined，改写后保持 null）；chains 另计连续并入两个以上后继的
// strong；moved 另计自身已被先前的并入搬到别的 strong 之下、之后才并入后继的 strong（其父节点的 children 数组已被追加过）
function countStrongMerges($) {
    const counts = { merges: 0, emptySources: 0, chains: 0, moved: 0 };
    const originalParent = new Map($('strong').toArray().map((el) => [el, el.parent]));
    const mergedTimes = new Map();
    const { append } = $.fn;
    $.fn.append = function countedAppend(...args) {
        const target = this[0];
        counts.merges += 1;
        if (args[0].length === 0) counts.emptySources += 1;
        if (target.parent !== originalParent.get(target)) counts.moved += 1;
        const times = (mergedTimes.get(target) || 0) + 1;
        mergedTimes.set(target, times);
        if (times === 2) counts.chains += 1;
        return append.apply(this, args);
    };
    return counts;
}

// 从根出发逐层核对：每个子节点的 parent 指回父节点，prev / next 与 children 数组的相邻关系一致，根到叶不重复。
// preprocessHtml 在同一棵树上先合并 strong、再清理 span，改写后留下的树须结构自洽，下一步的遍历与改树才可靠。
// 首末两端的 null 与 undefined 同记为空：原生 append 在后继 strong 没有子节点时把当前 strong 末子节点的 next 置为
// undefined，改写后保持 null，二者对按真假判断的读取一视同仁，本核对只针对指错节点的情形
function assertTreeConsistent(root, label) {
    const seen = new Set([root]);
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        const children = node.children || [];
        children.forEach((child, index) => {
            assert.ok(!seen.has(child), `${label}：同一节点在树中出现两次`);
            seen.add(child);
            assert.ok(child.parent === node, `${label}：子节点的 parent 未指回父节点`);
            assert.ok((child.prev ?? null) === (index > 0 ? children[index - 1] : null), `${label}：prev 与 children 数组不一致`);
            assert.ok((child.next ?? null) === (index + 1 < children.length ? children[index + 1] : null), `${label}：next 与 children 数组不一致`);
            stack.push(child);
        });
    }
}

test('空 span 清理与改写之前的实现逐字等价：定种子随机森林上 $.html() 逐字相同，改写后的树结构自洽', () => {
    // Arrange
    const random = seededRandom(TIDY_DIFF_SEED);
    const stats = { removedTrees: 0, unwrappedTrees: 0, mixedTrees: 0, liftedTrees: 0 };

    for (let index = 0; index < TIDY_DIFF_TREE_COUNT; index += 1) {
        const html = randomInlineForest(random, TIDY_DIFF_SPEC);
        const $legacy = cheerio.load(html, null, false);
        const $current = cheerio.load(html, null, false);
        const counts = countSpanMutations($legacy);

        // Act
        legacyTidyEmptySpans($legacy);
        tidyEmptySpans($current);

        // Assert
        assert.equal($current.html(), $legacy.html(), `第 ${index} 棵树：${html}`);
        assertTreeConsistent($current.root()[0], `第 ${index} 棵树：${html}`);
        if (counts.remove > 0) stats.removedTrees += 1;
        if (counts.replaceWith > 0) stats.unwrappedTrees += 1;
        if (counts.remove > 0 && counts.replaceWith > 0) stats.mixedTrees += 1;
        if (counts.lifted > 0) stats.liftedTrees += 1;
    }

    // Assert：核对面确实铺开了——发生删除的树超过四分之一，发生拆包的超过十分之一，同一棵树里删除与拆包兼有的超过
    // 二十分之一，拆包之后再删除或拆包其原子孙 span 的超过五十分之一。定种子下实测依次为 4814、1930、1314、724 棵，
    // 下限约为其三到五成，只为发现生成器被改得铺不开
    assert.ok(stats.removedTrees > TIDY_DIFF_TREE_COUNT / 4, `发生删除的树应超过四分之一：${JSON.stringify(stats)}`);
    assert.ok(stats.unwrappedTrees > TIDY_DIFF_TREE_COUNT / 10, `发生拆包的树应超过十分之一：${JSON.stringify(stats)}`);
    assert.ok(stats.mixedTrees > TIDY_DIFF_TREE_COUNT / 20, `删除与拆包兼有的树应超过二十分之一：${JSON.stringify(stats)}`);
    assert.ok(stats.liftedTrees > TIDY_DIFF_TREE_COUNT / 50, `拆包后再改动子孙 span 的树应超过五十分之一：${JSON.stringify(stats)}`);
});

test('相邻 strong 合并与改写之前的实现逐字等价：定种子随机森林上 $.html() 逐字相同，改写后的树结构自洽', () => {
    // Arrange
    const random = seededRandom(MERGE_DIFF_SEED);
    const stats = { mergedTrees: 0, emptySourceTrees: 0, chainTrees: 0, movedTrees: 0 };

    for (let index = 0; index < MERGE_DIFF_TREE_COUNT; index += 1) {
        const html = randomInlineForest(random, MERGE_DIFF_SPEC);
        const $legacy = cheerio.load(html, null, false);
        const $current = cheerio.load(html, null, false);
        const counts = countStrongMerges($legacy);

        // Act
        legacyMergeAdjacentStrong($legacy);
        mergeAdjacentStrong($current);

        // Assert
        assert.equal($current.html(), $legacy.html(), `第 ${index} 棵树：${html}`);
        assertTreeConsistent($current.root()[0], `第 ${index} 棵树：${html}`);
        if (counts.merges > 0) stats.mergedTrees += 1;
        if (counts.emptySources > 0) stats.emptySourceTrees += 1;
        if (counts.chains > 0) stats.chainTrees += 1;
        if (counts.moved > 0) stats.movedTrees += 1;
    }

    // Assert：核对面确实铺开了——发生合并的树超过三分之一，并入空 strong 的与连续并入两个以上后继的各超过五分之一，
    // 搬移后再合并的超过十分之一。定种子下实测依次为 5705、4066、4156、3229 棵，下限约为其三到六成，
    // 只为发现生成器被改得铺不开
    assert.ok(stats.mergedTrees > MERGE_DIFF_TREE_COUNT / 3, `发生合并的树应超过三分之一：${JSON.stringify(stats)}`);
    assert.ok(stats.emptySourceTrees > MERGE_DIFF_TREE_COUNT / 5, `并入空 strong 的树应超过五分之一：${JSON.stringify(stats)}`);
    assert.ok(stats.chainTrees > MERGE_DIFF_TREE_COUNT / 5, `连续并入两个以上后继的树应超过五分之一：${JSON.stringify(stats)}`);
    assert.ok(stats.movedTrees > MERGE_DIFF_TREE_COUNT / 10, `搬移后再合并的树应超过十分之一：${JSON.stringify(stats)}`);
});

// ============================================================
// 片段载入与根级查询：顶层大量并列节点时的耗时上限
// ============================================================

const { listImages, preprocessHtml } = require('../converters/parsers/url');

// 载荷为顶层 n 个并列的 <p>段</p>：不带 class、id、br 与样式，也没有图片，清单提取与预处理都不改动它，正确的输出
// 就是原串；逐个删除、逐个替换等不在本节范围内的路径也就一条都不走，耗时只反映片段载入与根级查询
const STRESS_PARAGRAPH = '<p>段</p>';
const STRESS_PAGE_URL = 'https://example.com/article';

// 改写之前有两处平方级，都随顶层节点数 n 增长：
//   - 片段载入 cheerio.load(html, null, false)：parse5 的 parseFragment 在 getFragment 里经 _adoptNodes 把临时根的
//     子节点逐个 detachNode（indexOf + splice(0, 1)）再 appendChild 迁入片段根，splice 每次挪动其余全部数组项。载入耗时
//     随 n 并不单调（同一 n 下稳定，不同 n 之间折合的单价相差十余倍）——本机独立进程各实测 3 次：2 万 456–470 ms、
//     4 万 120–123 ms、6 万 2428–2570 ms、8 万 1672–1881 ms、10 万 4284–4529 ms、12 万 8239–9828 ms、
//     14 万 12422–13058 ms、16 万 11819–14816 ms、20 万 11159–13206 ms；
//   - 根级查询 $(选择器)：以根的全部元素子节点作搜索根交给 css-select 的 prepareContext，其中 domutils 的
//     removeSubsets 对这组根逐个做 lastIndexOf / includes，每次查询的耗时稳定地随 n 平方增长——本机实测 2 万 244–250 ms、
//     4 万 965–974 ms、6 万 2213–2263 ms、8 万 3899–3903 ms、16 万 15706–15746 ms。
// listImages 做一次载入、一次根级查询（$('img')）；preprocessHtml 做一次载入、七次根级查询（样式规则三次，
// $('img')、段首缩进、相邻 strong 合并、空 span 清理各一次）。
// 耗时上限取绝对值，理由同 BREAK_STRESS_BUDGET_MS；各用例直接调用被测函数、计时区间只包这一次调用，片段载入在函数之内
// 一并计时。改写之前的实测为本用例 3 次（1 次单独运行本节用例、2 次运行整个文件）；改写之后的实测含三类：本用例在全量
// 测试（node --test 多文件并行）中的用例耗时 9 次（含构造载荷与断言，是计时区间的上界），同一载荷、同一计时区间的独立
// 进程冷启动 3 次，以及冷启动且与全量测试并行 3 次
//
// 10 万个段落：改写之前 12619.1、12515.7、10830.4 ms，最快一次是上限 1000 ms 的 10.8 倍；改写之后全量测试中
// 84.4–124.3 ms，冷启动 93.3–98.8 ms，冷启动且并行 100.2–166.4 ms，最慢一次 166.4 ms 不到上限的 1/6
// CI 上按 test/helpers/timing-budget.js 的系数放宽：CI 三平台上计时区间的估计最大值为 710 ms，放宽后余量 5.6 倍
const IMAGE_LIST_STRESS_COUNT = 100000;
const IMAGE_LIST_STRESS_BUDGET_MS = 1000;
// 16 万个段落：规模取到载入稳定落在慢态的区间。改写之前 34354.7、24957.4、26475.2 ms，最快一次是上限 1500 ms 的 16.6 倍；
// 只把载入退回原生写法、根级查询保持线性时，同一步骤独立进程实测 12697.0、11988.9、11338.0 ms，最快一次仍是上限的
// 7.6 倍，故只剩载入一处平方级时本用例同样失败。改写之后全量测试中 143.9–196.6 ms，冷启动 142.1–153.9 ms，冷启动且
// 并行 147.8–186.6 ms，最慢一次 196.6 ms 不到上限的 1/7
// CI 上按 test/helpers/timing-budget.js 的系数放宽：CI 三平台上计时区间的估计最大值为 1244 ms，放宽后余量 4.8 倍
const FRAGMENT_LOAD_STRESS_COUNT = 160000;
const FRAGMENT_LOAD_STRESS_BUDGET_MS = 1500;
// 6 万个段落：改写之前 17031.7、18284.3、19399.0 ms，最快一次是上限 1500 ms 的 11.4 倍；改写之后全量测试中
// 107.1–142.5 ms，冷启动 107.9–108.7 ms，冷启动且并行 115.1–143.2 ms，最慢一次 143.2 ms 不到上限的 1/10
// CI 上按 test/helpers/timing-budget.js 的系数放宽：CI 三平台上计时区间的估计最大值为 1267 ms（macOS），放宽后余量 4.7 倍
const PREPROCESS_STRESS_COUNT = 60000;
const PREPROCESS_STRESS_BUDGET_MS = 1500;

test('只读图片清单：顶层 10 万个并列段落不触发平方级的片段载入与根级查询，耗时在绝对上限内且 HTML 逐字不变、清单为空', async (t) => {
    // Arrange：载荷在用例内现场构造，不与其他用例共用
    const html = STRESS_PARAGRAPH.repeat(IMAGE_LIST_STRESS_COUNT);

    // Act：计时区间只包 listImages 一次调用；片段载入在函数之内，属本节的修复对象，一并计时
    const [result, ms] = await timed(() => listImages(html, STRESS_PAGE_URL));

    // Assert：先验结果正确，以免「快」来自少做了事——没有图片，清单为空，HTML 原样返回
    assert.deepEqual(result.images, [], '载荷里没有图片，清单应为空');
    assert.ok(result.html === html, '整段 HTML 应逐字不变');
    const budget = budgetMs(IMAGE_LIST_STRESS_BUDGET_MS);
    t.diagnostic(`提取实测 ${ms.toFixed(1)} 毫秒，上限 ${budget} 毫秒`);
    assert.ok(ms < budget, `提取实测 ${ms.toFixed(1)} 毫秒，超出上限 ${budget} 毫秒（${IMAGE_LIST_STRESS_BUDGET_MS} 毫秒 × 系数 ${BUDGET_FACTOR}）`);
});

test('只读图片清单：顶层 16 万个并列段落使片段载入落在慢态，改写后耗时在绝对上限内且 HTML 逐字不变、清单为空', async (t) => {
    // Arrange
    const html = STRESS_PARAGRAPH.repeat(FRAGMENT_LOAD_STRESS_COUNT);

    // Act：计时区间只包 listImages 一次调用
    const [result, ms] = await timed(() => listImages(html, STRESS_PAGE_URL));

    // Assert：先验结果正确
    assert.deepEqual(result.images, [], '载荷里没有图片，清单应为空');
    assert.ok(result.html === html, '整段 HTML 应逐字不变');
    const budget = budgetMs(FRAGMENT_LOAD_STRESS_BUDGET_MS);
    t.diagnostic(`提取实测 ${ms.toFixed(1)} 毫秒，上限 ${budget} 毫秒`);
    assert.ok(ms < budget, `提取实测 ${ms.toFixed(1)} 毫秒，超出上限 ${budget} 毫秒（${FRAGMENT_LOAD_STRESS_BUDGET_MS} 毫秒 × 系数 ${BUDGET_FACTOR}）`);
});

test('HTML 预处理：顶层 6 万个并列段落不触发平方级的片段载入与根级查询，耗时在绝对上限内且 HTML 逐字不变', async (t) => {
    // Arrange
    const html = STRESS_PARAGRAPH.repeat(PREPROCESS_STRESS_COUNT);

    // Act：计时区间只包 preprocessHtml 一次调用
    const [output, ms] = await timed(() => preprocessHtml(html));

    // Assert：先验结果正确——段落无样式、无缩进空白，预处理不改动任何节点
    assert.ok(output === html, '整段 HTML 应逐字不变');
    const budget = budgetMs(PREPROCESS_STRESS_BUDGET_MS);
    t.diagnostic(`预处理实测 ${ms.toFixed(1)} 毫秒，上限 ${budget} 毫秒`);
    assert.ok(ms < budget, `预处理实测 ${ms.toFixed(1)} 毫秒，超出上限 ${budget} 毫秒（${PREPROCESS_STRESS_BUDGET_MS} 毫秒 × 系数 ${BUDGET_FACTOR}）`);
});

test('尖括号写法页面：字面的标签与字符引用写法逐字进入 IR，零宽字符删除后仍不成立，裸网址的查询串不多出反斜杠', async (t) => {
    // Arrange
    const server = await startServer();
    t.after(() => server.close());

    // Act
    const doc = await parse({ url: `${server.base}/html-syntax` }, { allowPrivateNetwork: true });
    const markdown = await mdRenderer.render(doc);

    // Assert：正文段落逐字保留，字符引用、零宽字符与裸网址查询串均未被误处理
    const paragraphs = doc.ir.children.filter((n) => n.type === 'paragraph' && plainText(n));
    assert.deepEqual(paragraphs.map(plainText), [
        '当a<b>c时成立',
        '见&lt;与&amp;，另有 &#60; 与 AT&T，网址 http://example.com/?a=1&b=2 结束',
        '<div>块级开头</div>',
        '零宽：&lt; 与 <b>粗</b>',
        '粗<em>、斜&amp;、删<s>、Ra<b、Cx<y',
    ]);

    // Assert：表格单元格文本逐字保留
    const tables = collect(doc.ir, (n) => n.type === 'table');
    assert.equal(tables.length, 1);
    assert.deepEqual(
        collect(tables[0], (n) => n.type === 'tableRow').map((r) => r.children.map(plainText)),
        [['项', '值'], ['a<b>c', '见&lt;与&amp;']],
    );

    // Assert：图片替代文字逐字保留
    const images = collect(doc.ir, (n) => n.type === 'image');
    assert.equal(images.length, 1);
    assert.equal(images[0].alt, '见&lt;与&amp; 及 a<b>c');

    // Assert：未产生 html 节点，各行内节点文字逐字保留
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'html'), []);
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'strong').map(plainText), ['粗<em>']);
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'emphasis').map(plainText), ['斜&amp;']);
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'delete').map(plainText), ['删<s>']);
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'superscript').map(plainText), ['a<b']);
    assert.deepEqual(collect(doc.ir, (n) => n.type === 'subscript').map(plainText), ['x<y']);

    // Assert：裸网址被识别为 link，查询串中的「&」未被转义成反斜杠形式
    const links = collect(doc.ir, (n) => n.type === 'link');
    assert.equal(links.length, 1);
    assert.equal(links[0].url, 'http://example.com/?a=1&b=2');

    // Assert：md 产物中「<」与「&」经转义
    assert.ok(markdown.includes('当a\\<b>c时成立'), markdown);
    assert.ok(markdown.includes('见\\&lt;与\\&amp;'), markdown);
});
