/**
 * converters/parsers/url.js 单元测试
 * 覆盖：标题提取顺序、正文结构（heading/table/image）、script 剔除、图片入 assets 与 Referer、
 *       懒加载属性、下载失败降级、data URL 图片、SSRF 守卫拒绝本地地址
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const { parse, collapseBreakMarkers } = require('../converters/parsers/url');
const { MARKERS } = require('../converters/ir/markers');
const { _setLookup } = require('../converters/net/fetch-guard');
const mdRenderer = require('../converters/renderers/md');

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
            case '/escape':
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(ESCAPE_PAGE);
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
