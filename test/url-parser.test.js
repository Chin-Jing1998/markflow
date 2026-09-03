/**
 * converters/parsers/url.js 单元测试
 * 覆盖：标题提取顺序、正文结构（heading/table/image）、script 剔除、图片入 assets 与 Referer、
 *       懒加载属性、下载失败降级、data URL 图片、SSRF 守卫拒绝本地地址
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');

const { parse } = require('../converters/parsers/url');

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
            case '/a.png':
            case '/qr.png':
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
