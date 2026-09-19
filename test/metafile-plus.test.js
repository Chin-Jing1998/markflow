/**
 * converters/metafile/emf-plus.js 与 emf-plus-objects.js 的单元测试
 *
 * 覆盖：三种点编码、七类对象与跨记录续接、各绘图记录、页面与世界变换、三类裁剪与状态栈、
 * 文字基线与对齐、内嵌图元的仿射与递归上限、未支持记录的诊断、各项上限，
 * 以及 inspectMetafile 的 EMF+ 直方图、nestedDepth 与 hasChemDrawCdx。
 *
 * 夹具一律由 test/helpers/emf-builder.js 在运行时合成，不入库任何二进制图元；
 * ChemDraw 判据只放伪造的魔数，不放真实 CDX 文档。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const B = require('./helpers/emf-builder');
const { inspectMetafile, metafileToSvg } = require('../converters/metafile');

/** 把若干 EMF+ 记录包成一个带 EmfPlusHeader 的 Dual 图元 */
const plusEmf = (records, headerOptions = {}, classicRecords = []) => B.buildEmf([
    B.emfPlusComment([B.plusHeader({ dual: true }), ...records]),
    ...classicRecords,
], headerOptions);

const convert = (records, options = {}) => metafileToSvg(plusEmf(records), options);
const unsupportedNames = (result) => result.diagnostics.unsupported.map((item) => item.name).sort();
/** 数值断言：容差比较 */
const near = (actual, expected, tolerance, message) => assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message || ''} 实际 ${actual}，期望 ${expected} ± ${tolerance}`,
);
/** 从 SVG 里取某个属性的第一处取值 */
function attrValue(svg, element, name) {
    const match = new RegExp(`<${element}[^>]*\\s${name}="([^"]*)"`).exec(svg);
    return match ? match[1] : null;
}

// ---------------- 点编码与折线 ----------------

test('DrawLines：浮点点、笔属性与闭合位', () => {
    const pen = B.plusPenData({ argb: 0xFF112233, width: 4, unit: 0, dataFlags: 0x0002 | 0x0008, optional: Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.from([1, 0, 0, 0])]) });
    const result = convert([
        B.plusObject(2, 1, pen),
        B.plusDrawLines(1, [[10, 10], [100, 100], [200, 10]], { closed: true }),
    ]);
    assert.equal(result.diagnostics.shapes, 1);
    assert.equal(result.diagnostics.plusDrawn, 1);
    assert.match(result.svg, /<path d="M10 10L100 100L200 10Z"/);
    assert.match(result.svg, /stroke="#112233"/);
    assert.match(result.svg, /stroke-width="4"/);
    assert.match(result.svg, /stroke-linecap="round"/);
    assert.match(result.svg, /stroke-linejoin="bevel"/);
});

test('DrawLines：C 位的 16 位整数点与 P 位的相对点解出同样的坐标', () => {
    const points = [[10, 20], [130, 240], [30, 40]];
    const plain = convert([B.plusDrawLines(0, points)]);
    const compressed = convert([B.plusDrawLines(0, points, { compressed: true })]);
    const relative = convert([B.plusDrawLines(0, points, { relative: true })]);
    assert.equal(compressed.svg, plain.svg);
    assert.equal(relative.svg, plain.svg);
    assert.match(plain.svg, /d="M10 20L130 240L30 40"/);
});

test('笔的可选字段：虚线节距、复合线与自定义线帽按序读出，后三者记诊断', () => {
    // PenDataFlags 全置位：可选字段必须严格按 [MS-EMFPLUS] 2.1.2.7 的次序读，错一个字段画刷就取错色
    const optional = Buffer.concat([
        Buffer.alloc(24), // Transform
        B.uint32(1), // StartCap：Square
        B.uint32(2), // EndCap
        B.uint32(2), // Join：Round
        B.float32(5), // MiterLimit
        B.uint32(1), // LineStyle：Dash
        B.uint32(0), // DashedLineCap
        B.float32(0), // DashedLineOffset
        B.uint32(2), B.float32(3, 1), // DashedLine：两段节距
        B.uint32(0), // PenAlignment
        B.uint32(2), B.float32(0.2, 0.8), // CompoundLine
        B.uint32(4), Buffer.alloc(4), // CustomStartCap
        B.uint32(4), Buffer.alloc(4), // CustomEndCap
    ]);
    const result = convert([
        B.plusObject(2, 1, B.plusPenData({ argb: 0xFF445566, width: 2, unit: 0, dataFlags: 0x1FFF, optional })),
        B.plusDrawLines(1, [[0, 0], [10, 10]]),
    ]);
    assert.match(result.svg, /stroke="#445566"/, '可选字段读错会让内嵌画刷取到错位的字节');
    assert.match(result.svg, /stroke-width="2"/);
    assert.match(result.svg, /stroke-linecap="square"/);
    assert.match(result.svg, /stroke-linejoin="round"/);
    assert.match(result.svg, /stroke-dasharray="6 2"/);
    assert.deepEqual(unsupportedNames(result), [
        'EmfPlusPen(CompoundLine)', 'EmfPlusPen(CustomEndCap)', 'EmfPlusPen(CustomStartCap)',
    ]);
});

test('笔只给 LineStyle 时按近似节距出虚线', () => {
    const optional = Buffer.concat([B.uint32(2)]); // LineStyle：Dot
    const result = convert([
        B.plusObject(2, 1, B.plusPenData({ width: 1, unit: 0, dataFlags: 0x0020, optional })),
        B.plusDrawLines(1, [[0, 0], [10, 10]]),
    ]);
    assert.match(result.svg, /stroke-dasharray="1 1"/);
});

test('缺笔对象时按 1 个设备单位的黑线描边，不抛错也不记未支持', () => {
    const result = convert([B.plusDrawLines(9, [[0, 0], [10, 10]])]);
    assert.match(result.svg, /stroke="#000000" stroke-width="1"/);
    assert.deepEqual(result.diagnostics.unsupported, []);
});

// ---------------- 填充与形状 ----------------

test('FillPolygon：S 位内联 ARGB 与画刷对象两条路径，半透明写 fill-opacity', () => {
    const inline = convert([B.plusFillPolygon(0x8000FF00, [[0, 0], [50, 0], [50, 50]])]);
    assert.match(inline.svg, /<polygon points="0,0 50,0 50,50" fill="#00ff00" fill-opacity="0.5" fill-rule="evenodd"\/>/);
    const byObject = convert([
        B.plusObject(1, 4, B.plusBrushData(0xFF102030)),
        B.plusFillPolygon(4, [[0, 0], [50, 0], [50, 50]], { inlineBrush: false }),
    ]);
    assert.match(byObject.svg, /<polygon points="0,0 50,0 50,50" fill="#102030" fill-rule="evenodd"\/>/);
});

test('FillRects 与 DrawRects：多个矩形合成一条路径，C 位矩形等价', () => {
    const filled = convert([B.plusFillRects(0xFF000000, [[0, 0, 10, 10], [20, 20, 5, 5]])]);
    assert.match(filled.svg, /<path d="M0 0L10 0L10 10L0 10ZM20 20L25 20L25 25L20 25Z" fill="#000000"\/>/);
    const stroked = convert([B.plusDrawRects(0, [[0, 0, 10, 10]])]);
    assert.match(stroked.svg, /<path d="M0 0L10 0L10 10L0 10Z" fill="none" stroke="#000000"/);
    const compressed = convert([B.plusFillRects(0xFF000000, [[0, 0, 10, 10], [20, 20, 5, 5]], { compressed: true })]);
    assert.equal(compressed.svg, filled.svg);
});

test('FillEllipse 与 DrawEllipse：四段三次贝塞尔闭合', () => {
    const filled = convert([B.plusFillEllipse(0xFF000000, [0, 0, 100, 50])]);
    const data = attrValue(filled.svg, 'path', 'd');
    assert.ok(data.startsWith('M100 25'), data);
    assert.equal((data.match(/C/g) || []).length, 4);
    assert.ok(data.endsWith('Z'));
    const stroked = convert([B.plusDrawEllipse(0, [0, 0, 100, 50])]);
    assert.match(stroked.svg, /fill="none" stroke="#000000"/);
});

test('FillPath 与 DrawPath：起点、直线、贝塞尔与闭合位', () => {
    const path = B.plusPathData(
        [[0, 0], [100, 0], [100, 40], [60, 80], [20, 100]],
        [0, 1, 3, 3, 3 | 0x80],
    );
    const result = convert([
        B.plusObject(3, 5, path),
        B.plusFillPath(5, 0xFF000000),
        B.plusDrawPath(5, 0),
    ]);
    assert.equal(result.diagnostics.shapes, 2);
    assert.match(result.svg, /d="M0 0L100 0C100 40 60 80 20 100Z"[^>]*fill="#000000"[^>]*fill-rule="evenodd"/);
    assert.match(result.svg, /d="M0 0L100 0C100 40 60 80 20 100Z" fill="none" stroke=/);
});

test('路径类型数组按游程压缩时解出同样的 d，游程为 0 不空转', () => {
    const points = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const plain = convert([B.plusObject(3, 5, B.plusPathData(points, [0, 1, 1, 1])), B.plusDrawPath(5, 0)]);
    const rle = B.plusRecord(0x4008, (5 & 0xFF) | (3 << 8), Buffer.concat([
        Buffer.from([0x02, 0x10, 0xC0, 0xDB]), // Version
        Buffer.from([points.length, 0, 0, 0]),
        Buffer.from([0x00, 0x10, 0x00, 0x00]), // PathPointFlags：R 位（0x1000）
        B.plusPoints(points),
        Buffer.from([1, 0, 3, 1]), // 游程 1 的起点，游程 3 的直线
    ]));
    const packed = convert([rle, B.plusDrawPath(5, 0)]);
    assert.equal(packed.svg, plain.svg);
});

test('路径与画刷对象缺失时记诊断，不抛错', () => {
    const result = convert([B.plusFillPath(9, 0xFF000000), B.plusDrawPath(9, 0)]);
    assert.deepEqual(unsupportedNames(result), ['EmfPlusDrawPath(对象缺失)', 'EmfPlusFillPath(对象缺失)']);
    assert.ok(result.diagnostics.unsupported.every((item) => item.kind === 'drawing'));
});

// ---------------- 文字 ----------------

test('DrawString：Arial、em 100、点定位、LeadingMargin 为 0 时基线为 y + 90.5', () => {
    const result = convert([
        B.plusObject(6, 2, B.plusFontData({ em: 100, unit: 2, style: 1, face: 'Arial' })),
        B.plusObject(7, 3, B.plusStringFormatData({ leadingMargin: 0 })),
        B.plusDrawString({ fontId: 2, formatId: 3, text: 'Ab', x: 40, y: 60 }),
    ]);
    assert.equal(result.diagnostics.text, 1);
    assert.deepEqual(result.diagnostics.fonts, ['Arial']);
    near(Number(attrValue(result.svg, 'text', 'y')), 150.5, 0.1, 'DrawString 基线');
    assert.equal(attrValue(result.svg, 'text', 'x'), '40');
    assert.equal(attrValue(result.svg, 'text', 'font-size'), '100');
    assert.match(result.svg, /font-weight="bold"/);
});

test('DrawString：居中与靠右对齐、斜体、内联画刷的颜色与透明度', () => {
    const center = convert([
        B.plusObject(6, 2, B.plusFontData({ em: 50, style: 2 })),
        B.plusObject(7, 3, B.plusStringFormatData({ align: 1 })),
        B.plusDrawString({ fontId: 2, formatId: 3, text: 'Mid', x: 0, y: 0, width: 200, height: 60 }),
    ]);
    assert.equal(attrValue(center.svg, 'text', 'x'), '100');
    assert.match(center.svg, /text-anchor="middle"/);
    assert.match(center.svg, /font-style="italic"/);
    const far = convert([
        B.plusObject(6, 2, B.plusFontData({ em: 50 })),
        B.plusObject(7, 3, B.plusStringFormatData({ align: 2, trailingMargin: 0.2 })),
        B.plusDrawString({ fontId: 2, formatId: 3, text: 'End', x: 0, y: 0, width: 200, height: 60, brush: 0x80FF0000 }),
    ]);
    assert.equal(attrValue(far.svg, 'text', 'x'), '190');
    assert.match(far.svg, /text-anchor="end"/);
    assert.match(far.svg, /fill="#ff0000" fill-opacity="0.5"/);
});

test('DrawString：旋转的世界变换下文字以 transform="matrix(…)" 输出', () => {
    const result = convert([
        B.plusObject(6, 2, B.plusFontData({ em: 100 })),
        B.plusSetWorldTransform([0.8387, -0.5446, 0.5446, 0.8387, 0, 0]),
        B.plusDrawString({ fontId: 2, text: 'EG', x: 10, y: 20 }),
    ]);
    assert.match(result.svg, /<text[^>]*transform="matrix\(0\.8387 -0\.5446 0\.5446 0\.8387 0 0\)"/);
});

test('DrawString：字体对象缺失、多行文本各记一条诊断', () => {
    const missing = convert([B.plusDrawString({ fontId: 9, text: 'x' })]);
    assert.deepEqual(unsupportedNames(missing), ['EmfPlusDrawString(字体对象缺失)']);
    const multiline = convert([
        B.plusObject(6, 2, B.plusFontData({ em: 20 })),
        B.plusDrawString({ fontId: 2, text: 'a\r\nb' }),
    ]);
    assert.deepEqual(unsupportedNames(multiline), ['EmfPlusDrawString(多行文本按单行输出)']);
    assert.match(multiline.svg, />a b</);
});

// ---------------- 变换 ----------------

test('SetPageTransform 的缩放 0.24 同时作用于坐标、笔宽与字号', () => {
    const result = convert([
        B.plusSetPageTransform(0.24, 2),
        B.plusObject(2, 1, B.plusPenData({ width: 10, unit: 0 })),
        B.plusObject(6, 2, B.plusFontData({ em: 133.33, unit: 2 })),
        B.plusObject(7, 3, B.plusStringFormatData({ leadingMargin: 0 })),
        B.plusDrawLines(1, [[100, 100], [200, 200]]),
        B.plusDrawString({ fontId: 2, formatId: 3, text: 'X', x: 100, y: 100 }),
    ]);
    assert.match(result.svg, /d="M24 24L48 48"/);
    assert.match(result.svg, /stroke-width="2.4"/);
    assert.equal(attrValue(result.svg, 'text', 'x'), '24');
    near(Number(attrValue(result.svg, 'text', 'font-size')), 32, 0.01, '页面缩放下的字号');
});

test('非页面单位的字号与笔宽按 LogicalDpi 折算，且不随页面缩放变化', () => {
    const records = (scale) => [
        B.plusSetPageTransform(scale, 2),
        B.plusObject(2, 1, B.plusPenData({ width: 3, unit: 3 })), // 磅
        B.plusObject(6, 2, B.plusFontData({ em: 12, unit: 3, face: 'Arial' })), // 磅
        B.plusObject(7, 3, B.plusStringFormatData({ leadingMargin: 0 })),
        B.plusDrawLines(1, [[0, 0], [100, 100]]),
        B.plusDrawString({ fontId: 2, formatId: 3, text: 'X', x: 0, y: 0 }),
    ];
    const plain = metafileToSvg(plusEmf(records(1), {}));
    near(Number(attrValue(plain.svg, 'text', 'font-size')), 16, 0.01, '12 磅在 96 DPI 下等于 16 像素');
    assert.match(plain.svg, /stroke-width="4"/, '3 磅在 96 DPI 下等于 4 像素');
    const scaled = metafileToSvg(plusEmf(records(0.5), {}));
    near(Number(attrValue(scaled.svg, 'text', 'font-size')), 16, 0.01, '磅是物理单位，不随页面缩放变化');
    assert.match(scaled.svg, /stroke-width="4"/);
    assert.match(scaled.svg, /d="M0 0L50 50"/, '坐标仍受页面缩放作用');

    const metric = metafileToSvg(plusEmf([
        B.plusObject(2, 1, B.plusPenData({ width: 1, unit: 6 })), // 毫米
        B.plusDrawLines(1, [[0, 0], [10, 10]]),
    ], {}));
    near(Number(attrValue(metric.svg, 'path', 'stroke-width')), 96 / 25.4, 0.01, '1 毫米在 96 DPI 下的线宽');
});

test('世界变换：Set、Reset、前乘与后乘的 Multiply、Translate、Scale、Rotate', () => {
    const line = (records) => attrValue(metafileToSvg(plusEmf(records)).svg, 'path', 'd');
    assert.equal(line([B.plusSetWorldTransform([2, 0, 0, 2, 5, 5]), B.plusDrawLines(0, [[10, 10], [20, 20]])]), 'M25 25L45 45');
    assert.equal(line([B.plusSetWorldTransform([2, 0, 0, 2, 5, 5]), B.plusResetWorldTransform(), B.plusDrawLines(0, [[10, 10], [20, 20]])]), 'M10 10L20 20');
    assert.equal(line([B.plusTranslateWorldTransform(100, 0), B.plusScaleWorldTransform(2, 2), B.plusDrawLines(0, [[10, 10], [20, 20]])]), 'M120 20L140 40');
    assert.equal(line([B.plusScaleWorldTransform(2, 2), B.plusTranslateWorldTransform(100, 0, true), B.plusDrawLines(0, [[10, 10], [20, 20]])]), 'M120 20L140 40');
    assert.equal(line([B.plusMultiplyWorldTransform([1, 0, 0, 1, 7, 8]), B.plusDrawLines(0, [[0, 0], [1, 1]])]), 'M7 8L8 9');
    assert.equal(line([B.plusRotateWorldTransform(90), B.plusDrawLines(0, [[10, 0], [10, 10]])]), 'M0 10L-10 10');
});

// ---------------- 裁剪与状态栈 ----------------

test('SetClipRect：Replace 与 Intersect，裁剪区内的图形包在 <g clip-path> 里', () => {
    const replaced = convert([
        B.plusSetClipRect([0, 0, 100, 100], 0),
        B.plusDrawLines(0, [[0, 0], [10, 10]]),
    ]);
    assert.match(replaced.svg, /<clipPath id="c1" clipPathUnits="userSpaceOnUse"><rect x="0" y="0" width="100" height="100"\/><\/clipPath>/);
    assert.match(replaced.svg, /<g clip-path="url\(#c1\)"><path /);
    assert.equal(replaced.diagnostics.clipped, 1);
    const intersected = convert([
        B.plusSetClipRect([0, 0, 100, 100], 0),
        B.plusSetClipRect([50, 50, 200, 200], 1),
        B.plusDrawLines(0, [[0, 0], [10, 10]]),
    ]);
    assert.match(intersected.svg, /<rect x="50" y="50" width="50" height="50"\/>/);
});

test('SetClipRect：旋转变换下退化为四边形路径；其余合并方式进诊断', () => {
    const rotated = convert([
        B.plusSetWorldTransform([0, 1, -1, 0, 0, 0]),
        B.plusSetClipRect([0, 0, 100, 50], 0),
        B.plusDrawLines(0, [[0, 0], [10, 10]]),
    ]);
    assert.match(rotated.svg, /<clipPath id="c1"[^>]*><path d="M0 0L0 100L-50 100L-50 0Z"\/><\/clipPath>/);
    const union = convert([B.plusSetClipRect([0, 0, 10, 10], 2), B.plusDrawLines(0, [[0, 0], [10, 10]])]);
    assert.deepEqual(unsupportedNames(union), ['EmfPlusClip(CombineMode=2)']);
});

test('SetClipPath 与 SetClipRegion：Rect、Path、Infinite、Empty 四种节点', () => {
    const byPath = convert([
        B.plusObject(3, 5, B.plusPathData([[0, 0], [100, 0], [100, 100]], [0, 1, 1 | 0x80])),
        B.plusSetClipPath(5, 0),
        B.plusDrawLines(0, [[0, 0], [10, 10]]),
    ]);
    assert.match(byPath.svg, /<clipPath id="c1"[^>]*><path d="M0 0L100 0L100 100Z"\/>/);

    const byRect = convert([
        B.plusObject(4, 6, B.plusRegionRectData([10, 10, 30, 30])),
        B.plusSetClipRegion(6, 0),
        B.plusDrawLines(0, [[0, 0], [10, 10]]),
    ]);
    assert.match(byRect.svg, /<rect x="10" y="10" width="30" height="30"\/>/);

    const byRegionPath = convert([
        B.plusObject(4, 6, B.plusRegionPathData(B.plusPathData([[0, 0], [20, 0], [20, 20]], [0, 1, 1 | 0x80]))),
        B.plusSetClipRegion(6, 0),
        B.plusDrawLines(0, [[0, 0], [10, 10]]),
    ]);
    assert.match(byRegionPath.svg, /<clipPath id="c1"[^>]*><path d="M0 0L20 0L20 20Z"\/>/);

    const empty = convert([
        B.plusObject(4, 6, B.plusRegionEmptyData()),
        B.plusSetClipRegion(6, 0),
        B.plusDrawLines(0, [[0, 0], [10, 10]]),
    ]);
    assert.match(empty.svg, /<rect x="0" y="0" width="0" height="0"\/>/);

    const infinite = convert([
        B.plusSetClipRect([0, 0, 10, 10], 0),
        B.plusObject(4, 6, B.plusRegionInfiniteData()),
        B.plusSetClipRegion(6, 0),
        B.plusDrawLines(0, [[0, 0], [10, 10]]),
    ]);
    assert.doesNotMatch(infinite.svg, /<g clip-path=/);
});

test('ResetClip 清空裁剪；区域对象缺失或节点未支持时记诊断', () => {
    const reset = convert([
        B.plusSetClipRect([0, 0, 10, 10], 0),
        B.plusResetClip(),
        B.plusDrawLines(0, [[0, 0], [10, 10]]),
    ]);
    assert.doesNotMatch(reset.svg, /<g clip-path=/);
    const missing = convert([B.plusSetClipRegion(9, 0), B.plusSetClipPath(9, 0)]);
    assert.deepEqual(unsupportedNames(missing), ['EmfPlusSetClipPath(对象缺失)', 'EmfPlusSetClipRegion(对象缺失)']);
    const combined = convert([
        B.plusObject(4, 6, Buffer.concat([Buffer.alloc(8), Buffer.from([0, 0, 0, 0])])),
        B.plusSetClipRegion(6, 0),
    ]);
    assert.deepEqual(unsupportedNames(combined), ['EmfPlusRegion(node=0x0)']);
});

test('Save／Restore 与 BeginContainerNoParams／EndContainer 恢复变换与裁剪', () => {
    const result = convert([
        B.plusSave(0),
        B.plusSetWorldTransform([2, 0, 0, 2, 0, 0]),
        B.plusSetClipRect([0, 0, 10, 10], 0),
        B.plusDrawLines(0, [[10, 10], [20, 20]]),
        B.plusRestore(0),
        B.plusDrawLines(0, [[10, 10], [20, 20]]),
    ]);
    assert.match(result.svg, /<g clip-path="url\(#c1\)"><path d="M20 20L40 40"/);
    assert.match(result.svg, /<\/g><path d="M10 10L20 20"/);
    const container = convert([
        B.plusBeginContainerNoParams(1),
        B.plusSetPageTransform(2, 2),
        B.plusDrawLines(0, [[10, 10], [20, 20]]),
        B.plusEndContainer(1),
        B.plusDrawLines(0, [[10, 10], [20, 20]]),
    ]);
    assert.match(container.svg, /d="M20 20L40 40"/);
    assert.match(container.svg, /d="M10 10L20 20"/);
});

test('EMF+ Save 栈深超过上限时抛 LIMIT_EXCEEDED', () => {
    const saves = [];
    for (let index = 0; index < 5; index += 1) saves.push(B.plusSave(index));
    assert.throws(() => convert(saves, { limits: { maxStackDepth: 3 } }), (error) => error.code === 'LIMIT_EXCEEDED');
});

// ---------------- 对象续接与内嵌图元 ----------------

/** 一个只含 EMF+ 记录的内嵌图元：画一个占满自身 viewBox 的三角形 */
const nestedLeaf = () => plusEmf([B.plusFillPolygon(0xFF0000FF, [[0, 0], [1000, 0], [1000, 1000]])], {}, []);

test('对象续接：三段带 C 位的记录拼成一个 Metafile 对象', () => {
    const inner = nestedLeaf();
    const chunks = B.nestedMetafile(inner, { id: 7, chunkSize: Math.ceil((inner.length + 16) / 3) });
    assert.equal(chunks.length, 3);
    const result = metafileToSvg(plusEmf([
        ...chunks,
        B.plusDrawImagePoints(7, [0, 0, 1000, 1000], [[100, 100], [600, 100], [100, 600]]),
    ]));
    assert.equal(result.diagnostics.nested, 1);
    assert.match(result.svg, /<g transform="matrix\(0\.5 0 0 0\.5 100 100\)"><polygon points="0,0 1000,0 1000,1000" fill="#0000ff"/);
});

test('对象续接：TotalObjectSize 超过上限时抛 LIMIT_EXCEEDED', () => {
    const inner = nestedLeaf();
    const chunks = B.nestedMetafile(inner, { id: 7, chunkSize: 128, totalSize: 4096 });
    assert.throws(
        () => metafileToSvg(plusEmf(chunks), { limits: { maxObjectBytes: 1024 } }),
        (error) => error.code === 'LIMIT_EXCEEDED' && /续接对象总长/.test(error.message),
    );
});

test('对象续接：TotalObjectSize 谎报为小值时，累计字节同样受上限约束', () => {
    const chunk = Buffer.alloc(2048, 0x41);
    assert.throws(
        () => metafileToSvg(plusEmf([B.plusObject(5, 7, chunk, { continued: true, totalSize: 32 })]), {
            limits: { maxObjectBytes: 1024 },
        }),
        (error) => error.code === 'LIMIT_EXCEEDED' && /续接对象总长/.test(error.message),
    );
});

test('DrawImagePoints：源矩形到三点平行四边形的仿射；DrawImage 由目标矩形推出同一结果', () => {
    const inner = nestedLeaf();
    const byPoints = metafileToSvg(plusEmf([
        ...B.nestedMetafile(inner, { id: 7 }),
        B.plusDrawImagePoints(7, [0, 0, 1000, 1000], [[100, 100], [600, 100], [100, 600]]),
    ]));
    const byRect = metafileToSvg(plusEmf([
        ...B.nestedMetafile(inner, { id: 7 }),
        B.plusDrawImage(7, [0, 0, 1000, 1000], [100, 100, 500, 500]),
    ]));
    assert.equal(byRect.svg, byPoints.svg);
    assert.match(byPoints.svg, /<g transform="matrix\(0\.5 0 0 0\.5 100 100\)"/);
});

test('DrawImage：位图对象、对象缺失、源矩形为空各记一条诊断', () => {
    const bitmap = convert([
        B.plusObject(5, 7, B.plusImageBitmapData()),
        B.plusDrawImage(7, [0, 0, 100, 100], [0, 0, 100, 100]),
    ]);
    assert.deepEqual(unsupportedNames(bitmap), ['EmfPlusDrawImage(位图)', 'EmfPlusImage(位图)']);
    const missing = convert([B.plusDrawImage(9, [0, 0, 100, 100], [0, 0, 100, 100])]);
    assert.deepEqual(unsupportedNames(missing), ['EmfPlusDrawImage(对象缺失)']);
    const emptySrc = convert([
        ...B.nestedMetafile(nestedLeaf(), { id: 7 }),
        B.plusDrawImage(7, [0, 0, 0, 0], [0, 0, 100, 100]),
    ]);
    assert.deepEqual(unsupportedNames(emptySrc), ['EmfPlusDrawImage(源矩形为空)']);
    const badCount = convert([
        ...B.nestedMetafile(nestedLeaf(), { id: 7 }),
        B.plusDrawImagePoints(7, [0, 0, 100, 100], [[0, 0], [10, 0]]),
    ]);
    assert.deepEqual(unsupportedNames(badCount), ['EmfPlusDrawImagePoints(点数不为 3)']);
});

test('内嵌图元嵌套 4 层：第 4 层记诊断，前 3 层照常出图且裁剪 id 全局唯一', () => {
    // 每层各画一条自己的线，便于分辨哪一层被截断；四层的裁剪矩形取值相同，id 只能靠作用域前缀区分
    const wrap = (inner) => plusEmf([
        ...B.nestedMetafile(inner, { id: 7 }),
        B.plusSetClipRect([0, 0, 1000, 1000], 0),
        B.plusDrawLines(0, [[0, 0], [10, 10]]),
        B.plusDrawImagePoints(7, [0, 0, 1000, 1000], [[0, 0], [1000, 0], [0, 1000]]),
    ]);
    const buffer = wrap(wrap(wrap(wrap(nestedLeaf()))));
    const result = metafileToSvg(buffer);
    assert.equal(result.diagnostics.nested, 3, '默认上限 3：第 4 层不再递归');
    assert.deepEqual(unsupportedNames(result), ['EmfPlusDrawImage(内嵌图元超过递归深度)']);
    assert.equal((result.svg.match(/M0 0L10 10/g) || []).length, 4, '前 4 层各自的图形照常出图');
    assert.doesNotMatch(result.svg, /<polygon/, '被截断的第 5 层不出图');
    const ids = [...result.svg.matchAll(/<clipPath id="(c\d+)"/g)].map((match) => match[1]);
    assert.equal(ids.length, new Set(ids).size, '裁剪 id 必须全局唯一');
    assert.equal(ids.length, 4);
});

test('内嵌图元自身畸形时只记诊断，外层照常出图', () => {
    const broken = Buffer.alloc(120);
    broken.writeUInt32LE(1, 0);
    broken.writeUInt32LE(108, 4);
    broken.writeUInt32LE(0x464D4520, 40);
    const result = metafileToSvg(plusEmf([
        B.plusObject(5, 7, B.plusImageMetafileData(broken)),
        B.plusDrawImagePoints(7, [0, 0, 100, 100], [[0, 0], [100, 0], [0, 100]]),
        B.plusDrawLines(0, [[0, 0], [10, 10]]),
    ]));
    assert.equal(result.diagnostics.shapes, 1);
    assert.ok(unsupportedNames(result).includes('EmfPlusDrawImagePoints(解析失败)'));
});

// ---------------- 未支持记录与上限 ----------------

test('未支持的 EMF+ 绘图记录进 diagnostics.unsupported（kind 为 drawing），不抛错', () => {
    const result = convert([
        B.plusRecord(0x4012, 0, Buffer.alloc(24)), // EmfPlusDrawArc
        B.plusRecord(0x4018, 0, Buffer.alloc(24)), // EmfPlusDrawCurve
        B.plusRecord(0x4035, 0, Buffer.alloc(8)), // EmfPlusOffsetClip：只影响状态
        B.plusRecord(0x401E, 0, Buffer.alloc(0)), // SetAntiAliasMode：无害，不进诊断
    ]);
    assert.deepEqual(unsupportedNames(result), ['EmfPlusDrawArc', 'EmfPlusDrawCurve', 'EmfPlusOffsetClip']);
    const kinds = Object.fromEntries(result.diagnostics.unsupported.map((item) => [item.name, item.kind]));
    assert.equal(kinds.EmfPlusDrawArc, 'drawing');
    assert.equal(kinds.EmfPlusOffsetClip, 'state');
});

test('记录内部字段畸形只记一条「解析失败」，整份转换照常完成', () => {
    const truncated = B.plusRecord(0x400D, 0, Buffer.from([10, 0, 0, 0])); // 声明 10 个点却没有点数据
    const result = convert([truncated, B.plusDrawLines(0, [[0, 0], [10, 10]])]);
    assert.equal(result.diagnostics.shapes, 1);
    assert.deepEqual(unsupportedNames(result), ['EmfPlusDrawLines(解析失败)']);
});

test('EMF+ 的点数与文字字符数同样受上限约束', () => {
    const points = [];
    for (let index = 0; index < 20; index += 1) points.push([index, index]);
    assert.throws(
        () => convert([B.plusDrawLines(0, points)], { limits: { maxPoints: 5 } }),
        (error) => error.code === 'LIMIT_EXCEEDED',
    );
    assert.throws(
        () => convert([
            B.plusObject(6, 2, B.plusFontData({ em: 10 })),
            B.plusDrawString({ fontId: 2, text: 'abcdefghij' }),
        ], { limits: { maxTextChars: 4 } }),
        (error) => error.code === 'LIMIT_EXCEEDED',
    );
});

test('未知对象类型与解析失败的对象各记一条诊断，ImageAttributes 按无害对象静默收下', () => {
    const result = convert([
        B.plusObject(8, 2, Buffer.alloc(16)), // ImageAttributes：只影响位图呈现，不进诊断
        B.plusObject(9, 3, Buffer.alloc(16)), // CustomLineCap：会影响线端形状，进诊断
        B.plusObject(6, 4, Buffer.from([1, 2, 3])), // 截断的字体对象
    ]);
    assert.deepEqual(unsupportedNames(result), ['EmfPlusObject(type=6 解析失败)', 'EmfPlusObject(type=9)']);
});

// ---------------- inspectMetafile ----------------

test('inspectMetafile：EMF+ 直方图、内嵌深度与 ChemDraw 判据', () => {
    const inner = plusEmf([
        B.plusComment(Buffer.from('CDIF\x00VjCD0100 伪造魔数', 'latin1')),
        B.plusFillPolygon(0xFF000000, [[0, 0], [10, 0], [10, 10]]),
    ]);
    const buffer = plusEmf([
        ...B.nestedMetafile(inner, { id: 7, chunkSize: 512 }),
        B.plusDrawImagePoints(7, [0, 0, 1000, 1000], [[0, 0], [100, 0], [0, 100]]),
        B.plusRecord(0x4012, 0, Buffer.alloc(24)), // EmfPlusDrawArc：未支持
    ], {}, [B.polyline16([[0, 0], [10, 10]])]);
    const info = inspectMetafile(buffer);
    assert.deepEqual(info.plus, { present: true, dual: true, logicalDpi: [96, 96] });
    assert.equal(info.records.plus.EmfPlusDrawImagePoints, 1);
    assert.equal(info.records.plus.EmfPlusFillPolygon, 1, '内嵌层的记录并入同一份直方图');
    assert.equal(info.records.plus.EmfPlusHeader, 2);
    assert.equal(info.records.classic.EMR_POLYLINE16, 1);
    assert.equal(info.nestedDepth, 1);
    assert.equal(info.hasChemDrawCdx, true);
    assert.deepEqual(info.unsupported.map((item) => item.name), ['EmfPlusDrawArc']);
    assert.equal(info.unsupported[0].kind, 'drawing');
});

test('inspectMetafile：没有 CDX 魔数的 CDIF 注释不算 ChemDraw', () => {
    const info = inspectMetafile(plusEmf([B.plusComment(Buffer.from('CDIF 只有前缀', 'latin1'))]));
    assert.equal(info.hasChemDrawCdx, false);
    assert.equal(info.records.plus.EmfPlusComment, 1);
    assert.equal(info.nestedDepth, 0);
});
