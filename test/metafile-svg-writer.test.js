/**
 * converters/metafile/svg-writer.js 单元测试
 *
 * 覆盖：矩阵基元、数值格式化（NaN 与无穷写 0）、XML 转义与控制字符剔除、元素封闭集合、
 * 裁剪定义与去重、按裁剪分组、片段栈（W2 内嵌图元的接缝）、输出字节上限，
 * 以及「整份输出只含调研报告 4.6 列出的 11 种元素」这一净化断言。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const B = require('./helpers/emf-builder');
const { metafileToSvg, MetafileError } = require('../converters/metafile');
const { createDiagnostics, DEFAULT_LIMITS, resolveLimits } = require('../converters/metafile/reader');
const {
    ALLOWED_ELEMENTS, IDENTITY_MATRIX, multiplyMatrix, transformPoint, matrixScale, isAxisAligned,
    formatNumber, formatNumber4, escapeXml, matrixAttr, pointsAttr, subpathData, createSvgWriter,
} = require('../converters/metafile/svg-writer');

const makeWriter = (limits = DEFAULT_LIMITS) => {
    const diagnostics = createDiagnostics();
    const writer = createSvgWriter({ viewBox: [0, 0, 100, 100], width: 100, height: 100, limits, diagnostics });
    return { writer, diagnostics };
};

test('矩阵基元：乘法、点变换、等比缩放因子与轴对齐判定', () => {
    assert.deepEqual(multiplyMatrix(IDENTITY_MATRIX, IDENTITY_MATRIX), [1, 0, 0, 1, 0, 0]);
    // 行向量约定：p · (A · B) 等于先 A 后 B
    const composed = multiplyMatrix([2, 0, 0, 2, 1, 1], [1, 0, 0, 1, 10, 20]);
    assert.deepEqual(composed, [2, 0, 0, 2, 11, 21]);
    assert.deepEqual(transformPoint(composed, 5, 5), [21, 31]);
    assert.equal(matrixScale([2, 0, 0, 8, 0, 0]), 4);
    assert.equal(matrixScale([0, 0, 0, 0, 0, 0]), 1, '退化矩阵取 1，避免除零');
    assert.equal(isAxisAligned([1, 0, 0, 1, 0, 0]), true);
    assert.equal(isAxisAligned([1, 0.5, 0, 1, 0, 0]), false);
    assert.equal(isAxisAligned([-1, 0, 0, 1, 0, 0]), false);
    assert.equal(matrixAttr([1, 0, 0, 1, 2.123456, 3]), 'matrix(1 0 0 1 2.1235 3)');
});

test('数值格式化：两位与四位小数，NaN、无穷与负零一律写 0', () => {
    assert.equal(formatNumber(1.006), '1.01');
    assert.equal(formatNumber(1 / 3), '0.33');
    assert.equal(formatNumber(2), '2', '整数不补小数位');
    assert.equal(formatNumber(-0), '0');
    assert.equal(formatNumber(-0.001), '0');
    assert.equal(formatNumber(NaN), '0');
    assert.equal(formatNumber(Infinity), '0');
    assert.equal(formatNumber(-Infinity), '0');
    assert.equal(formatNumber4(1 / 3), '0.3333');
    assert.equal(formatNumber4(NaN), '0');
    assert.equal(pointsAttr([[1.234, 2], [3, 4]]), '1.23,2 3,4');
    assert.equal(subpathData([[0, 0], [1, 1]], true), 'M0 0L1 1Z');
    assert.equal(subpathData([], false), '');
});

test('XML 转义：尖括号、与号、引号被转义，控制字符与非字符码位被剔除', () => {
    assert.equal(escapeXml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
    assert.equal(escapeXml('a\x00b\x07c\x1fd\x7fe'), 'abcde');
    assert.equal(escapeXml('a￾b￿c'), 'abc');
    assert.equal(escapeXml('保留\t制表与\n换行'), '保留\t制表与\n换行');
});

test('元素封闭集合：只认 11 种元素，其余一律抛 MetafileError', () => {
    const { writer } = makeWriter();
    assert.deepEqual([...ALLOWED_ELEMENTS].sort(), [
        'clipPath', 'defs', 'ellipse', 'g', 'line', 'path', 'polygon', 'polyline', 'rect', 'svg', 'text',
    ]);
    assert.equal(writer.element('rect', { x: '0', y: null, z: undefined }), '<rect x="0"/>');
    assert.throws(() => writer.element('script', {}), (error) => error instanceof MetafileError && error.code === 'MALFORMED');
    assert.throws(() => writer.element('foreignObject', {}), MetafileError);
    // 属性值也走转义，来自文件的字符串无法闭合属性
    assert.equal(writer.element('rect', { fill: 'a"><script>' }), '<rect fill="a&quot;&gt;&lt;script&gt;"/>');
});

test('裁剪：相同的裁剪只定义一次 clipPath，分组随裁剪切换开合', () => {
    const { writer, diagnostics } = makeWriter();
    const clipA = writer.rectClip('d0:', [0, 0, 10, 10]);
    const clipB = writer.rectClip('d0:', [0, 0, 20, 20]);
    writer.emit(writer.element('rect', { x: '0' }), clipA);
    writer.emit(writer.element('rect', { x: '1' }), clipA);
    writer.emit(writer.element('rect', { x: '2' }), clipB);
    writer.emit(writer.element('rect', { x: '3' }), null);
    const svg = writer.render();
    assert.equal((svg.match(/<clipPath/g) || []).length, 2);
    assert.match(svg, /<g clip-path="url\(#c1\)"><rect x="0"\/><rect x="1"\/><\/g><g clip-path="url\(#c2\)"><rect x="2"\/><\/g><rect x="3"\/>/);
    assert.equal(diagnostics.counters.clipped, 3);
});

test('裁剪求交：矩形与矩形直接算交集，非矩形改挂父级 clipPath', () => {
    const { writer } = makeWriter();
    const merged = writer.intersectClip('d0:', writer.rectClip('d0:', [0, 0, 100, 100]), writer.rectClip('d0:', [50, 50, 200, 200]));
    assert.deepEqual(merged.rect, [50, 50, 100, 100]);
    assert.equal(writer.intersectClip('d0:', null, merged), merged);

    const pathClip = writer.pathClip('d0:p1', 'M0 0L10 0L10 10Z', 'evenodd');
    const nested = writer.intersectClip('d0:', merged, pathClip);
    writer.emit(writer.element('rect', { x: '0' }), nested);
    const svg = writer.render();
    assert.match(svg, /<clipPath id="c2" clipPathUnits="userSpaceOnUse" clip-path="url\(#c1\)">/);
});

test('片段栈：pushFragment／popFragment 取出独立片段，defs 与字节计数共用（W2 内嵌图元接缝）', () => {
    const { writer } = makeWriter();
    writer.emit(writer.element('rect', { x: '0' }), null);
    writer.pushFragment();
    writer.emit(writer.element('rect', { x: '1' }), writer.rectClip('d1:', [0, 0, 5, 5]));
    const fragment = writer.popFragment();
    assert.equal(fragment, '<g clip-path="url(#c1)"><rect x="1"/></g>');
    writer.emit(`<g transform="matrix(1 0 0 1 0 0)">${fragment}</g>`, null);
    const svg = writer.render();
    assert.match(svg, /<rect x="0"\/><g transform="matrix\(1 0 0 1 0 0\)"><g clip-path="url\(#c1\)"><rect x="1"\/><\/g><\/g>/);
    assert.equal((svg.match(/<clipPath/g) || []).length, 1);
    assert.ok(writer.bytes > 0);
});

test('输出体积上限：累计字节超过 maxSvgBytes 时抛 LIMIT_EXCEEDED', () => {
    const { writer } = makeWriter(resolveLimits({ maxSvgBytes: 40 }));
    assert.throws(() => {
        for (let index = 0; index < 100; index += 1) writer.emit(writer.element('rect', { x: String(index) }), null);
    }, (error) => error instanceof MetafileError && error.code === 'LIMIT_EXCEEDED');
});

test('输出净化：文字与字体名里的危险字符被转义或剔除', () => {
    const result = metafileToSvg(B.buildEmf([
        B.extCreateFontIndirectW({ handle: 1, face: 'Ar"ial; }<x>', height: -40 }),
        B.selectObject(1),
        B.setTextAlign(0x18),
        B.extTextOutW({ x: 0, y: 0, text: '<a&b"c\x01d' }),
    ]));
    assert.match(result.svg, />&lt;a&amp;b&quot;cd<\/text>/);
    assert.match(result.svg, /font-family="'Arial x', Arial, Helvetica, sans-serif"/);
    assert.ok(!result.svg.includes('<x>'));
    assert.ok(!/[;{}]/.test(result.svg.match(/font-family="[^"]*"/)[0]));
});

test('整份输出只含调研报告 4.6 列出的元素，且不出现 script、style、外链与事件属性', () => {
    const result = metafileToSvg(B.buildEmf([
        B.extCreatePen({ handle: 1, style: 0x00010000 | 0x100 | 0x2000, width: 4, color: B.rgb(0, 0, 0) }),
        B.selectObject(1),
        B.createBrushIndirect({ handle: 2, style: 0, color: B.rgb(0, 0, 0) }),
        B.selectObject(2),
        B.intersectClipRect([0, 0, 500, 500]),
        B.polyline16([[0, 0], [10, 10]]),
        B.polygon16([[0, 0], [10, 0], [10, 10]]),
        B.rectangle([0, 0, 10, 10]),
        B.ellipse([0, 0, 10, 10]),
        B.moveToEx(0, 0),
        B.lineTo(10, 10),
        B.beginPath(),
        B.polyBezier16([[0, 0], [10, 0], [20, 10], [30, 10]]),
        B.endPath(),
        B.fillPath(),
        B.extCreateFontIndirectW({ handle: 3, face: 'Arial', height: -40 }),
        B.selectObject(3),
        B.setTextAlign(0x18),
        B.extTextOutW({ x: 0, y: 0, text: 'A' }),
    ]));
    const tags = new Set([...result.svg.matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]));
    for (const tag of tags) assert.ok(ALLOWED_ELEMENTS.has(tag), `输出里出现了不允许的元素 ${tag}`);
    assert.deepEqual([...tags].sort(), ['clipPath', 'defs', 'ellipse', 'g', 'line', 'path', 'polygon', 'polyline', 'rect', 'svg', 'text']);
    assert.ok(!/\son[a-z]+=/i.test(result.svg), '不得出现事件属性');
    assert.ok(!/https?:|file:|data:/i.test(result.svg.replace('http://www.w3.org/2000/svg', '')), '除 xmlns 外不得出现外链');
    assert.ok(!/<style|<script|<foreignObject/i.test(result.svg));
});
