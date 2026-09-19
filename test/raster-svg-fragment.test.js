/**
 * converters/raster/svg-fragment.js 单元测试
 * 覆盖：片段页骨架与 CSP（无 script-src、整页无脚本）、正文只有一个 <img>、宽高等于目标像素、
 *       src 为可解回原文的 data:image/svg+xml;base64、SVG 内容不进入 HTML 文本、非法入参抛错。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSvgImageFragment, SVG_FRAGMENT_CSP, MAX_EDGE_PX } = require('../converters/raster/svg-fragment');

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2" viewBox="0 0 4 2">'
    + '<rect x="0" y="0" width="4" height="2" fill="#ffffff"/><polyline points="0,0 4,2"/></svg>';

const bodyOf = (html) => html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
const countOf = (html, needle) => html.split(needle).length - 1;

test('片段页的 CSP 不含 script-src，整页没有任何脚本', () => {
    // Act
    const html = buildSvgImageFragment(SVG, { width: 240, height: 120 });

    // Assert
    assert.equal(SVG_FRAGMENT_CSP, "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${SVG_FRAGMENT_CSP}">`));
    assert.equal(html.includes('script-src'), false);
    assert.equal(html.includes('<script'), false);
    assert.ok(html.startsWith('<!doctype html><html lang="zh"><head><meta charset="utf-8">'));
    assert.ok(html.endsWith('</body></html>'));
});

test('正文只有一个 <img>：宽高等于目标像素，src 为可解回原文的 base64 data URI', () => {
    // Act
    const html = buildSvgImageFragment(SVG, { width: 863, height: 520 });

    // Assert
    const body = bodyOf(html);
    assert.equal(countOf(body, '<img '), 1);
    assert.equal(countOf(body, '<'), 1, '正文除 <img> 外不得有其它元素');
    assert.match(body, /^<img width="863" height="520" alt="" src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+">$/);

    const base64 = body.slice(body.indexOf('base64,') + 'base64,'.length, body.lastIndexOf('"'));
    assert.equal(Buffer.from(base64, 'base64').toString('utf8'), SVG);
    // SVG 只以 base64 出现，不以明文进入 HTML
    assert.equal(html.includes('<polyline'), false);
});

test('零边距白底且 body 为 inline-block（与工作进程量取 body 外接矩形的约定一致）', () => {
    // Act
    const html = buildSvgImageFragment(SVG, { width: 10, height: 10 });

    // Assert
    assert.ok(html.includes('html,body{margin:0;padding:0;background:#fff}'));
    assert.ok(html.includes('body{display:inline-block'));
    assert.ok(html.includes('img{display:block}'));
});

test('边长取整；非法 SVG 或越界边长一律抛错，交调用方降级', () => {
    // Act
    const rounded = buildSvgImageFragment(SVG, { width: 240.4, height: 119.5 });

    // Assert
    assert.match(bodyOf(rounded), /^<img width="240" height="120"/);
    assert.throws(() => buildSvgImageFragment('', { width: 10, height: 10 }), /非空的 SVG 字符串/);
    assert.throws(() => buildSvgImageFragment(null, { width: 10, height: 10 }), /非空的 SVG 字符串/);
    assert.throws(() => buildSvgImageFragment(SVG), /width/);
    assert.throws(() => buildSvgImageFragment(SVG, { width: 0, height: 10 }), /width/);
    assert.throws(() => buildSvgImageFragment(SVG, { width: 10, height: MAX_EDGE_PX + 1 }), /height/);
    assert.throws(() => buildSvgImageFragment(SVG, { width: 10, height: Number.NaN }), /height/);
});
