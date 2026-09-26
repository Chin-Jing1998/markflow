/**
 * desktop/main/html-sanitize.js 单元测试（纯逻辑，不依赖 Electron 与文件系统）
 * 覆盖：script/iframe/object/embed/form/meta[http-equiv]/link/base 整体删除；on* 与 srcset/ping 删除；
 *       a 的 javascript: 与 data:text/html 去除、http(s) 加 noopener 与 target；
 *       style 属性与 <style> 正文里的 url() 外链替换、data: 保留；
 *       相对图改写为 mf-asset（含子目录与百分号编码）、越界与非白名单扩展名只留 alt、远程图只留 alt；
 *       缺少 baseDir / assetBase 时不改写任何图片；非 img 元素的 URL 属性一律删除；
 *       相邻两个低位代理项（正文、属性值、title）不抛错且换成 U+FFFD。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { sanitizeHtml, assetUrlFor, stripCssUrls, REMOVED_TAGS } = require('../desktop/main/html-sanitize');

const BASE_DIR = path.resolve('/tmp/markflow-sanitize-base');
const ASSET_BASE = 'mf-asset://0123456789abcdef0123456789abcdef/';

const run = (html, options = {}) => sanitizeHtml(html, { baseDir: BASE_DIR, assetBase: ASSET_BASE, ...options });

// ============================================================
// 元素与属性
// ============================================================

test('script / iframe / object / embed / form / meta[http-equiv] / link / base 整体删除', () => {
    const html = [
        '<html><head>',
        '<meta charset="utf-8"><meta http-equiv="refresh" content="0;url=http://evil/">',
        '<link rel="stylesheet" href="http://evil/a.css"><link rel="preload" as="script" href="http://evil/b.js">',
        '<base href="http://evil/">',
        '</head><body>',
        '<script>alert(1)</script>',
        '<iframe src="http://evil/"></iframe>',
        '<object data="x.swf"><param name="a" value="b"></object>',
        '<embed src="y.swf">',
        '<form action="http://evil/"><input name="pwd" type="password"></form>',
        '<p>正文</p>',
        '</body></html>',
    ].join('');
    const result = run(html);

    for (const tag of REMOVED_TAGS) assert.ok(!result.html.includes(`<${tag}`), `${tag} 未被删除`);
    assert.ok(!result.html.includes('http-equiv'), 'meta[http-equiv] 未被删除');
    assert.ok(!result.html.includes('pwd'), 'form 的内容应随 form 一并删除');
    assert.ok(result.html.includes('<p>正文</p>'), '正文应保留');
    assert.ok(result.html.includes('<meta charset="utf-8">'), '普通 meta 应保留');
    assert.deepEqual(result.removed, { script: 1, iframe: 1, object: 1, embed: 1, form: 1, base: 1, link: 2, meta: 1 });
    assert.ok(result.warnings.some((item) => item.includes('已移除不安全元素')));
});

test('全部 on* 事件属性与 srcset / ping 一并删除', () => {
    const result = run([
        '<body onload="alert(1)" ONUNLOAD="x()">',
        '<div onclick="a()" onmouseover="b()" data-onclick="保留">文字</div>',
        '<a href="https://example.com/" ping="http://evil/track">链接</a>',
        '<img src="a.png" srcset="http://evil/2x.png 2x" alt="图">',
        '</body>',
    ].join(''));
    assert.ok(!/\son[a-z]+=/i.test(result.html), `仍有事件属性：${result.html}`);
    assert.ok(result.html.includes('data-onclick="保留"'), 'data-onclick 不是事件属性，应保留');
    assert.ok(!result.html.includes('srcset'), 'srcset 未删除');
    assert.ok(!result.html.includes('ping='), 'ping 未删除');
});

test('非 img 元素的 URL 属性一律删除', () => {
    const result = run('<video src="v.mp4" poster="p.png"></video><audio src="a.mp3"></audio><div background="b.png">x</div>');
    assert.ok(!result.html.includes('v.mp4') && !result.html.includes('p.png'), 'video 的 src/poster 未删除');
    assert.ok(!result.html.includes('a.mp3'), 'audio 的 src 未删除');
    assert.ok(!result.html.includes('b.png'), 'background 未删除');
});

// ============================================================
// 链接
// ============================================================

test('a[href]：javascript: 与 data:text/html 去除，http(s) 加 noopener 与新窗口，片段保留', () => {
    const result = run([
        '<a href="javascript:alert(1)">坏一</a>',
        '<a href="  JavaScript:alert(2)">坏二</a>',
        '<a href="data:text/html,<b>x</b>">坏三</a>',
        '<a href="file:///etc/passwd">坏四</a>',
        '<a href="https://example.com/p?q=1#f">好</a>',
        '<a href="#section">片段</a>',
    ].join(''));
    assert.ok(!result.html.includes('javascript:') && !result.html.includes('JavaScript:'), 'javascript: 未去除');
    assert.ok(!result.html.includes('data:text/html'), 'data:text/html 未去除');
    assert.ok(!result.html.includes('file:///'), 'file: 未去除');
    assert.ok(result.html.includes('<a href="https://example.com/p?q=1#f" rel="noopener noreferrer" target="_blank">好</a>'), `外链改写不符：${result.html}`);
    assert.ok(result.html.includes('<a href="#section">片段</a>'), '同文档片段应原样保留');
    assert.deepEqual(result.links, { external: 1, stripped: 4 });
});

// ============================================================
// 样式
// ============================================================

test('style 属性与 <style> 正文里的 url() 外链替换为 none，data: 保留', () => {
    const result = run([
        '<style>body{background:url(http://evil/a.png)}',
        '.b{background-image:url("https://evil/b.png")}',
        '.c{background:url(\'data:image/gif;base64,R0lGOD\')}</style>',
        '<p style="background:url(http://evil/c.png);color:red">段</p>',
        '<p style="list-style-image:url(&quot;d.png&quot;)">相对也拦</p>',
    ].join(''));
    assert.ok(!result.html.includes('http://evil'), `样式里仍有外链：${result.html}`);
    assert.ok(!result.html.includes('https://evil'), '样式里仍有 https 外链');
    assert.ok(result.html.includes("url('data:image/gif;base64,R0lGOD')"), 'data: 的 url() 应保留');
    assert.ok(result.html.includes('background:none;color:red'), `style 属性改写不符：${result.html}`);
    assert.equal(stripCssUrls('a{background:url(x.png)}'), 'a{background:none}');
    assert.equal(stripCssUrls('a{background:url(data:image/png;base64,AA)}'), 'a{background:url(data:image/png;base64,AA)}');
});

// ============================================================
// 图片
// ============================================================

test('相对图改写为 mf-asset，越界与非白名单扩展名只留 alt，远程图只留 alt', () => {
    const result = run([
        '<img src="a.png" alt="同级">',
        '<img src="img/sub/b.jpeg" alt="子目录">',
        '<img src="./c.webp" alt="点开头">',
        '<img src="img/%E4%B8%AD%E6%96%87.png" alt="编码">',
        '<img src="d.png?v=2#x" alt="带查询">',
        '<img src="../out.png" alt="越界一">',
        '<img src="img/../../out2.png" alt="越界二">',
        '<img src="/etc/secret.png" alt="绝对路径">',
        '<img src="e.exe" alt="非白名单">',
        '<img src="https://cdn.example.com/r.png" alt="远程">',
        '<img src="//cdn.example.com/r2.png" alt="协议相对">',
        '<img src="data:image/png;base64,AAAA" alt="内联">',
    ].join(''));

    assert.ok(result.html.includes(`src="${ASSET_BASE}a.png"`), `同级图未改写：${result.html}`);
    assert.ok(result.html.includes(`src="${ASSET_BASE}img/sub/b.jpeg"`), '子目录图未改写');
    assert.ok(result.html.includes(`src="${ASSET_BASE}c.webp"`), './ 开头未规整');
    assert.ok(result.html.includes(`src="${ASSET_BASE}img/%E4%B8%AD%E6%96%87.png"`), '中文文件名未按 URL 编码回写');
    assert.ok(result.html.includes(`src="${ASSET_BASE}d.png"`), '查询串与片段应丢弃');
    assert.ok(result.html.includes('src="data:image/png;base64,AAAA"'), 'data: 图片应原样保留');

    for (const alt of ['越界一', '越界二', '绝对路径', '非白名单', '远程', '协议相对']) {
        const matched = new RegExp(`<img alt="${alt}">`).test(result.html);
        assert.ok(matched, `alt=${alt} 的图片应只剩 alt，实际：${result.html}`);
    }
    assert.deepEqual(result.images, { local: 6, remote: 2, blocked: 4 });
    assert.ok(result.warnings.some((item) => item.includes('已拦截 2 张远程图片')));
    assert.ok(result.warnings.some((item) => item.includes('有 4 张图片')));
});

test('缺少 baseDir / assetBase 时不改写任何图片，相对图只留 alt', () => {
    const bare = sanitizeHtml('<img src="a.png" alt="图"><img src="https://x/y.png" alt="远">');
    assert.ok(!bare.html.includes('a.png'), '无 baseDir 时相对图应丢 src');
    assert.deepEqual(bare.images, { local: 0, remote: 1, blocked: 1 });
});

test('assetUrlFor：边界判定与编码（纯函数）', () => {
    const opts = { baseDir: BASE_DIR, assetBase: ASSET_BASE };
    assert.equal(assetUrlFor('images/a.png', opts), `${ASSET_BASE}images/a.png`);
    assert.equal(assetUrlFor('./images/./a.png', opts), `${ASSET_BASE}images/a.png`);
    assert.equal(assetUrlFor('../a.png', opts), null);
    assert.equal(assetUrlFor('a.txt', opts), null);
    assert.equal(assetUrlFor('', opts), null);
    assert.equal(assetUrlFor('a.png', { baseDir: BASE_DIR }), null, '无 assetBase 即不改写');
    assert.equal(assetUrlFor('%E5%9B%BE.png', opts), `${ASSET_BASE}%E5%9B%BE.png`);
});

test('空输入与非字符串输入不抛错', () => {
    assert.equal(typeof sanitizeHtml('').html, 'string');
    assert.equal(typeof sanitizeHtml(null).html, 'string');
    assert.equal(typeof sanitizeHtml(undefined).html, 'string');
});

test('相邻两个低位代理项出现在正文、属性值与 title 里时不抛错，一律换成 U+FFFD', () => {
    // Arrange：parse5 7.3.0 遇到「低位代理项后紧跟低位代理项」抛 RangeError: Invalid code point；
    // 代理项与替换字符以码点生成，源码不出现孤立代理项的字面量或转义序列
    const low = String.fromCharCode(0xDC00);
    const pair = `${low}${low}`;
    const replaced = String.fromCharCode(0xFFFD).repeat(2);
    const html = `<!DOCTYPE html><html><head><title>题${pair}名</title></head><body><p title="${pair}">甲${pair}乙</p></body></html>`;

    // Act
    const result = sanitizeHtml(html);

    // Assert
    assert.ok(result.html.isWellFormed(), '清洗结果不应再含孤立代理项');
    assert.ok(result.html.includes(`<title>题${replaced}名</title>`), `title 未按预期替换：${result.html}`);
    assert.ok(result.html.includes(`<p title="${replaced}">甲${replaced}乙</p>`), `正文或属性值未按预期替换：${result.html}`);
});
