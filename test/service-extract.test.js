/**
 * converters/service.js 的 extractArticle 单元测试
 *
 * CLI 的 extract 子命令与 MCP 的 extract_article 共用该实现，本文件只验服务层契约：返回字段与键序、
 * 截断语义（只截 markdown，wordCount 仍按全文）、图片只列地址不下载、失败抛中文错误。
 * SSRF 守卫默认拒绝 127.0.0.1，故在加载任何 parser 之前先引入 allow-private-network 预加载脚本，
 * 为本进程内的 fetch-guard 补上 allowPrivateNetwork（守卫本体不变，仅本测试进程生效）。
 */
require('./fixtures/allow-private-network');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const service = require('../converters/service');
const { startArticleServer, ARTICLE_TITLE, ARTICLE_PARAGRAPHS } = require('./fixtures/article-server');

let server;

before(async () => {
    server = await startArticleServer();
});

after(async () => {
    await server.close();
});

test('extractArticle 返回正文与元数据，键序与 MCP extract_article 一致，图片只列地址不下载', async () => {
    // Act
    const article = await service.extractArticle({ url: `${server.base}/article` });

    // Assert
    assert.deepEqual(Object.keys(article), [
        'url', 'finalUrl', 'title', 'author', 'publishedAt', 'siteName', 'excerpt', 'lang',
        'wordCount', 'extraction', 'markdown', 'truncated', 'images',
    ]);
    assert.equal(article.url, `${server.base}/article`);
    assert.equal(article.finalUrl, `${server.base}/article`);
    assert.equal(article.title, ARTICLE_TITLE);
    assert.equal(article.extraction, 'readability');
    assert.equal(article.truncated, false);
    ARTICLE_PARAGRAPHS.forEach((paragraph) => assert.ok(article.markdown.includes(paragraph)));
    assert.ok(!article.markdown.includes('读者甲'), '评论区不应出现在正文里');
    assert.deepEqual(article.images, [{ url: `${server.base}/pic.png`, alt: '流程示意' }]);
    assert.equal(server.requests.includes('/pic.png'), false, '图片不应被下载');
});

test('maxChars 只截断 markdown 并置 truncated，wordCount 仍按全文统计；非正整数回退默认上限', async () => {
    // Act
    const cut = await service.extractArticle({ url: `${server.base}/article`, maxChars: 20 });
    const full = await service.extractArticle({ url: `${server.base}/article`, maxChars: 0 });

    // Assert
    assert.equal(service.DEFAULT_EXTRACT_MAX_CHARS, 50000);
    assert.equal(cut.truncated, true);
    assert.equal(cut.markdown.length, 20);
    assert.equal(full.truncated, false);
    assert.ok(full.markdown.length > 20);
    assert.equal(cut.wordCount, full.wordCount);
});

test('缺少 url 或抓取失败时抛中文错误', async () => {
    await assert.rejects(service.extractArticle({}), /缺少 url/);
    await assert.rejects(service.extractArticle({ url: '   ' }), /缺少 url/);
    await assert.rejects(service.extractArticle({ url: `${server.base}/missing` }), /[一-龥]/);
});
