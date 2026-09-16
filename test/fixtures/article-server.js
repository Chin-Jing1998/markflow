/**
 * 测试专用：本机正文页 HTTP 服务（CLI extract、service.extractArticle 与 MCP 长正文用例共用）
 *
 * startArticleServer({ pages }) → Promise<{ base, requests, close }>
 *   默认提供 /article（三段中文正文，另有导航、评论区与一张图片）；pages 为「路径 → HTML」，可追加或覆盖；
 *   取值也可写成 { html, delayMs }，延迟应答，供「转换进行中发出取消」一类用例取得确定的时序。
 *   requests 按到达顺序记录请求路径，供断言「图片未被下载」或等待首个请求到达；close() 断开全部连接后关闭服务。
 * buildArticlePage({ title, paragraphs }) → 与 /article 同构的 HTML，供构造超长正文页。
 * ARTICLE_TITLE、ARTICLE_PARAGRAPHS 为 /article 的标题与正文段落。
 *
 * 服务只监听 127.0.0.1：SSRF 守卫默认拒绝本机地址，被测进程须以 --require allow-private-network.js 放行。
 */
const http = require('node:http');

const ARTICLE_TITLE = '正文提取实践';
const ARTICLE_PARAGRAPHS = Object.freeze([
    '知识库建设的第一道门槛是把散落在网页里的正文干净地取出来，导航、侧栏与评论一旦混进来，后续的切分与检索都会被噪声带偏，'
        + '而且这种污染很难在下游发现，往往要等到检索结果明显跑偏时才被察觉，返工成本相当高。',
    '模板化的抽取规则只能覆盖少数站点，面对长尾站点必须依赖通用的正文识别算法，按段落长度、链接密度与标点分布给候选容器打分，'
        + '再结合站点自身的结构特征做一次校正，才能在覆盖率与准确率之间取得可用的平衡。',
    '取出正文之后还要做一轮规范化，去掉零宽字符与多余空行，否则同一篇文章在不同时间抓取会产生大量无意义的差异，'
        + '既浪费存储，也让版本比对变得毫无意义，因此规范化应当作为管线里的固定环节而不是可选项。',
]);

function buildArticlePage({ title = ARTICLE_TITLE, paragraphs = ARTICLE_PARAGRAPHS } = {}) {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<meta property="og:site_name" content="工程笔记">
<meta name="author" content="孙七">
<meta property="article:published_time" content="2026-07-08T09:10:11Z">
<meta name="description" content="谈谈网页正文提取的工程实践">
</head><body>
<nav><a href="/">首页</a><a href="/about">关于</a></nav>
<div class="entry-body">
${paragraphs.map((p) => `<p>${p}</p>`).join('\n')}
<p><img src="/pic.png" alt="流程示意"></p>
</div>
<div class="comment-list"><p>读者甲：受教了。</p><p>读者乙：同问。</p></div>
</body></html>`;
}

function startArticleServer({ pages = {} } = {}) {
    const routes = { '/article': buildArticlePage(), ...pages };
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push(req.url);
        const route = Object.prototype.hasOwnProperty.call(routes, req.url) ? routes[req.url] : null;
        if (route === null) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
            return;
        }
        const { html, delayMs } = typeof route === 'string' ? { html: route, delayMs: 0 } : route;
        const respond = () => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        };
        if (delayMs > 0) setTimeout(respond, delayMs).unref();
        else respond();
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            base: `http://127.0.0.1:${server.address().port}`,
            requests,
            close: () => new Promise((done) => {
                server.closeAllConnections();
                server.close(() => done());
            }),
        }));
    });
}

module.exports = { startArticleServer, buildArticlePage, ARTICLE_TITLE, ARTICLE_PARAGRAPHS };
