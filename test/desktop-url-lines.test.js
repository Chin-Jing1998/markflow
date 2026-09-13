/**
 * desktop/renderer/js/url-lines.mjs 单元测试（渲染层纯逻辑，Node 经 import() 载入）
 * 覆盖：每行一个链接、前后空白与空行忽略、仅接受 http/https、非法行带行号与中文原因且不阻断其余行、
 *       重复链接只保留首个、超长拒绝、hostOf 主机名提取。
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mod;
before(async () => {
    mod = await import(pathToFileURL(path.join(__dirname, '..', 'desktop', 'renderer', 'js', 'url-lines.mjs')).href);
});

test('合法行逐行提取，空白与空行忽略', () => {
    const text = '  https://mp.weixin.qq.com/s/abc  \n\n\r\nhttp://example.com/path?q=1#h\n   ';
    const result = mod.parseUrlLines(text);
    assert.deepEqual(result.urls, ['https://mp.weixin.qq.com/s/abc', 'http://example.com/path?q=1#h']);
    assert.deepEqual(result.invalid, []);
    assert.equal(result.duplicates, 0);
    assert.equal(result.total, 2);
});

test('非 http/https 与畸形链接记入 invalid（含行号与原因），不阻断其余行', () => {
    const text = 'ftp://files.example.com/a\nhttps://zhuanlan.zhihu.com/p/1\nfile:///etc/passwd\njavascript:alert(1)\nhttps://\n随手写的文字\nhttps://blog.csdn.net/x';
    const result = mod.parseUrlLines(text);
    assert.deepEqual(result.urls, ['https://zhuanlan.zhihu.com/p/1', 'https://blog.csdn.net/x']);
    assert.deepEqual(result.invalid.map((item) => [item.line, item.reason]), [
        [1, mod.REASONS.scheme], [3, mod.REASONS.scheme], [4, mod.REASONS.scheme], [5, mod.REASONS.malformed], [6, mod.REASONS.scheme],
    ]);
    assert.equal(result.invalid[0].text, 'ftp://files.example.com/a');
    assert.equal(result.total, 7);
});

test('重复链接只保留首个并计数', () => {
    const result = mod.parseUrlLines('https://a.com/x\nhttps://a.com/x\nhttps://a.com/y\nhttps://a.com/x');
    assert.deepEqual(result.urls, ['https://a.com/x', 'https://a.com/y']);
    assert.equal(result.duplicates, 2);
});

test('超长链接拒绝；空输入返回空结果；非字符串入参按空处理', () => {
    const long = `https://a.com/${'x'.repeat(4100)}`;
    const result = mod.parseUrlLines(long);
    assert.deepEqual(result.urls, []);
    assert.equal(result.invalid[0].reason, mod.REASONS.tooLong);
    assert.deepEqual(mod.parseUrlLines(''), { urls: [], invalid: [], duplicates: 0, total: 0 });
    assert.deepEqual(mod.parseUrlLines(null), { urls: [], invalid: [], duplicates: 0, total: 0 });
});

test('hostOf 取小写主机名，不可解析时回退原文', () => {
    assert.equal(mod.hostOf('https://MP.Weixin.QQ.com/s/abc'), 'mp.weixin.qq.com');
    assert.equal(mod.hostOf('http://127.0.0.1:9223/'), '127.0.0.1');
    assert.equal(mod.hostOf('not a url'), 'not a url');
});
