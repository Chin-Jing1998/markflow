/**
 * converters/metafile/emf-classic.js 经典记录回放的单元测试
 *
 * 覆盖：世界变换的四种合成方式、映射模式与窗口／视口、SaveDC／RestoreDC（负数与正数参数）、
 * 文字（基线、对齐、Dx、旋转、粗体、世界缩放下的字号）、裁剪交集与恢复、笔与画刷、路径括号、
 * BITBLT 空操作、未支持记录的诊断、GDI+ 仲裁用的 draw 开关，以及固定种子的变异循环。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const B = require('./helpers/emf-builder');
const { metafileToSvg, MetafileError } = require('../converters/metafile');
const { createReader, readRecords, readEmfHeader, createBudget, createDiagnostics, DEFAULT_LIMITS, EMR } = require('../converters/metafile/reader');
const { createSvgWriter } = require('../converters/metafile/svg-writer');
const { createClassicReplayer } = require('../converters/metafile/emf-classic');

/** 取 svg 里第一个匹配元素的属性字符串 */
function attrsOf(svg, tag) {
    const match = svg.match(new RegExp(`<${tag}\\b([^>]*)>`));
    assert.ok(match, `svg 里没有 <${tag}>：${svg}`);
    return match[1];
}
const attr = (svg, tag, name) => {
    const match = attrsOf(svg, tag).match(new RegExp(`\\b${name}="([^"]*)"`));
    return match ? match[1] : null;
};
const countOf = (svg, tag) => (svg.match(new RegExp(`<${tag}\\b`, 'g')) || []).length;

/** 直接驱动回放器，用于测试 draw 开关（GDI+ 仲裁语义，W2 使用） */
function replayDirect(buffer, draw) {
    const reader = createReader(buffer);
    const header = readEmfHeader(reader);
    const budget = createBudget(DEFAULT_LIMITS);
    const diagnostics = createDiagnostics();
    const writer = createSvgWriter({
        viewBox: header.viewBox, width: header.viewBox[2], height: header.viewBox[3], limits: DEFAULT_LIMITS, diagnostics,
    });
    const replayer = createClassicReplayer({
        reader, header, writer, budget, diagnostics, scope: 'd0:', minStrokeDev: 1,
    });
    for (const record of readRecords(reader, budget)) {
        diagnostics.counters.records = budget.records;
        if (record.type === EMR.HEADER) continue;
        replayer.handleRecord(record.type, record, draw);
    }
    return { svg: writer.render(), diagnostics, replayer };
}

const svgOf = (records, options) => metafileToSvg(B.buildEmf(records), options).svg;
const withPen = (records) => [
    B.extCreatePen({ handle: 1, style: 0x00010000, width: 16, color: B.rgb(0, 0, 0) }),
    B.selectObject(1),
    ...records,
];

test('世界变换 MWT_LEFTMULTIPLY：1／16 缩放下折线点按缩放输出', () => {
    const svg = svgOf([
        B.modifyWorldTransform([1 / 16, 0, 0, 1 / 16, 0, 0], 2),
        B.polyline16([[1600, 3200], [3200, 3200]]),
    ]);
    assert.equal(attr(svg, 'polyline', 'points'), '100,200 200,200');
});

test('世界变换：先 MWT_SET 再 MWT_LEFTMULTIPLY，合成顺序为「新变换先作用」', () => {
    const svg = svgOf([
        B.modifyWorldTransform([2, 0, 0, 2, 10, 20], 4),
        B.modifyWorldTransform([1 / 16, 0, 0, 1 / 16, 0, 0], 2),
        B.polyline16([[160, 160], [160, 160]]),
    ]);
    assert.equal(attr(svg, 'polyline', 'points'), '30,40 30,40');
});

test('世界变换 MWT_RIGHTMULTIPLY：新变换后作用', () => {
    const svg = svgOf([
        B.modifyWorldTransform([2, 0, 0, 2, 10, 20], 4),
        B.modifyWorldTransform([1 / 16, 0, 0, 1 / 16, 0, 0], 3),
        B.polyline16([[160, 160], [160, 160]]),
    ]);
    // 先缩放 2 平移 (10,20)，再整体缩到 1／16：x =(160·2+10)/16 = 20.625，y =(160·2+20)/16 = 21.25
    assert.equal(attr(svg, 'polyline', 'points'), '20.63,21.25 20.63,21.25');
});

test('世界变换 MWT_IDENTITY：恢复为单位矩阵', () => {
    const svg = svgOf([
        B.setWorldTransform([4, 0, 0, 4, 0, 0]),
        B.modifyWorldTransform([1, 0, 0, 1, 0, 0], 1),
        B.polyline16([[10, 20], [30, 40]]),
    ]);
    assert.equal(attr(svg, 'polyline', 'points'), '10,20 30,40');
});

test('世界变换：未知的合成方式进入诊断且不改变状态', () => {
    const result = metafileToSvg(B.buildEmf([
        B.setWorldTransform([2, 0, 0, 2, 0, 0]),
        B.modifyWorldTransform([9, 0, 0, 9, 0, 0], 7),
        B.polyline16([[10, 10], [20, 20]]),
    ]));
    assert.equal(attr(result.svg, 'polyline', 'points'), '20,20 40,40');
    assert.ok(result.diagnostics.unsupported.some((item) => item.name === 'EMR_MODIFYWORLDTRANSFORM(mode=7)'));
});

test('映射模式：MM_ANISOTROPIC 按窗口／视口比例缩放，SCALEWINDOWEXTEX 生效', () => {
    const svg = svgOf([
        B.setMapMode(8),
        B.setWindowExtEx(1000, 1000),
        B.setViewportExtEx(500, 500),
        B.polyline16([[100, 200], [300, 400]]),
    ]);
    assert.equal(attr(svg, 'polyline', 'points'), '50,100 150,200');

    const scaled = svgOf([
        B.setMapMode(8),
        B.setWindowExtEx(1000, 1000),
        B.setViewportExtEx(500, 500),
        B.scaleWindowExtEx(1, 2, 1, 2),
        B.polyline16([[100, 200], [300, 400]]),
    ]);
    assert.equal(attr(scaled, 'polyline', 'points'), '100,200 300,400');

    const scaledViewport = svgOf([
        B.setMapMode(8),
        B.setWindowExtEx(1000, 1000),
        B.setViewportExtEx(500, 500),
        B.scaleViewportExtEx(2, 1, 2, 1),
        B.setWindowOrgEx(0, 0),
        B.setViewportOrgEx(0, 0),
        B.polyline16([[100, 200], [300, 400]]),
    ]);
    assert.equal(attr(scaledViewport, 'polyline', 'points'), '100,200 300,400');
    // 分母为 0 时保持原值，不产生 NaN
    const zeroDenominator = svgOf([
        B.setMapMode(8),
        B.setWindowExtEx(1000, 1000),
        B.setViewportExtEx(500, 500),
        B.scaleViewportExtEx(2, 0, 2, 0),
        B.polyline16([[100, 200], [300, 400]]),
    ]);
    assert.equal(attr(zeroDenominator, 'polyline', 'points'), '50,100 150,200');
});

test('映射模式：MM_HIMETRIC 按参考设备换算且 y 轴翻转', () => {
    const svg = svgOf([B.setMapMode(3), B.polyline16([[1000, 1000], [2000, 2000]])]);
    const points = attr(svg, 'polyline', 'points').split(' ').map((pair) => pair.split(',').map(Number));
    assert.ok(Math.abs(points[0][0] - 39.37) < 0.02, `实际 ${points[0][0]}`);
    assert.ok(points[0][1] < 0, 'MM_HIMETRIC 的 y 轴向上，设备坐标应为负');
});

test('SaveDC／RestoreDC：−1、−2 与正数参数各自恢复到对应层级', () => {
    const base = (restore) => svgOf([
        B.setWorldTransform([1, 0, 0, 1, 0, 0]),
        B.saveDc(),
        B.setWorldTransform([2, 0, 0, 2, 0, 0]),
        B.saveDc(),
        B.setWorldTransform([4, 0, 0, 4, 0, 0]),
        restore,
        B.polyline16([[10, 10], [10, 10]]),
    ]);
    assert.equal(attr(base(B.restoreDc(-1)), 'polyline', 'points'), '20,20 20,20');
    assert.equal(attr(base(B.restoreDc(-2)), 'polyline', 'points'), '10,10 10,10');
    assert.equal(attr(base(B.restoreDc(1)), 'polyline', 'points'), '10,10 10,10');
    assert.equal(attr(base(B.restoreDc(2)), 'polyline', 'points'), '20,20 20,20');
    // 越界的层级号不改变状态
    assert.equal(attr(base(B.restoreDc(9)), 'polyline', 'points'), '40,40 40,40');
});

test('RestoreDC(−2) 同时恢复裁剪与所选对象', () => {
    const svg = svgOf([
        B.createPen({ handle: 1, style: 0, width: 0, color: B.rgb(255, 0, 0) }),
        B.createPen({ handle: 2, style: 0, width: 0, color: B.rgb(0, 0, 255) }),
        B.selectObject(1),
        B.saveDc(),
        B.intersectClipRect([0, 0, 100, 100]),
        B.saveDc(),
        B.selectObject(2),
        B.intersectClipRect([0, 0, 10, 10]),
        B.restoreDc(-2),
        B.polyline16([[0, 0], [500, 500]]),
    ]);
    assert.equal(attr(svg, 'polyline', 'stroke'), '#ff0000');
    assert.equal(countOf(svg, 'g'), 0, 'RestoreDC(−2) 之后裁剪应已恢复为无裁剪');
});

test('文字：TA_BASELINE 下 y 即基线，Dx 数组输出逐字 x 列表', () => {
    const svg = svgOf([
        B.extCreateFontIndirectW({ handle: 1, face: 'Arial', height: -40 }),
        B.selectObject(1),
        B.setTextAlign(0x18),
        B.extTextOutW({ x: 0, y: 100, text: 'ABC', dx: [10, 20, 30] }),
    ]);
    assert.equal(attr(svg, 'text', 'y'), '100');
    assert.equal(attr(svg, 'text', 'x'), '0 10 30');
    assert.equal(attr(svg, 'text', 'font-size'), '40');
    assert.equal(attr(svg, 'text', 'xml:space'), 'preserve');
});

test('文字：世界缩放 0.5 与 lfHeight −200 得字号 100', () => {
    const svg = svgOf([
        B.setWorldTransform([0.5, 0, 0, 0.5, 0, 0]),
        B.extCreateFontIndirectW({ handle: 1, face: 'Arial', height: -200 }),
        B.selectObject(1),
        B.setTextAlign(0x18),
        B.extTextOutW({ x: 100, y: 100, text: 'A' }),
    ]);
    assert.equal(attr(svg, 'text', 'font-size'), '100');
    assert.equal(attr(svg, 'text', 'y'), '50');
});

test('文字：lfEscapement 900 输出 rotate(−90 …)，lfWeight ≥ 600 输出粗体', () => {
    const svg = svgOf([
        B.extCreateFontIndirectW({ handle: 1, face: 'Arial', height: -40, escapement: 900, weight: 700, italic: 1 }),
        B.selectObject(1),
        B.setTextAlign(0x18),
        B.extTextOutW({ x: 10, y: 20, text: 'X' }),
    ]);
    assert.equal(attr(svg, 'text', 'transform'), 'rotate(-90 10 20)');
    assert.equal(attr(svg, 'text', 'font-weight'), 'bold');
    assert.equal(attr(svg, 'text', 'font-style'), 'italic');
});

test('文字：TA_CENTER 与 TA_RIGHT 无 Dx 时用 text-anchor，有 Dx 时回退参考点', () => {
    const anchored = (align) => svgOf([
        B.extCreateFontIndirectW({ handle: 1, face: 'Arial', height: -40 }),
        B.selectObject(1),
        B.setTextAlign(0x18 | align),
        B.extTextOutW({ x: 100, y: 100, text: 'AB' }),
    ]);
    assert.equal(attr(anchored(0x06), 'text', 'text-anchor'), 'middle');
    assert.equal(attr(anchored(0x02), 'text', 'text-anchor'), 'end');

    const withDx = (align) => svgOf([
        B.extCreateFontIndirectW({ handle: 1, face: 'Arial', height: -40 }),
        B.selectObject(1),
        B.setTextAlign(0x18 | align),
        B.extTextOutW({ x: 100, y: 100, text: 'AB', dx: [20, 20] }),
    ]);
    assert.equal(attr(withDx(0x06), 'text', 'x'), '80 100');
    assert.equal(attr(withDx(0x02), 'text', 'x'), '60 80');
    assert.equal(attr(withDx(0x06), 'text', 'text-anchor'), null);
});

test('文字：TA_TOP 与 TA_BOTTOM 按字体上升部换算基线', () => {
    const baseline = (align) => attr(svgOf([
        B.extCreateFontIndirectW({ handle: 1, face: 'Arial', height: -100 }),
        B.selectObject(1),
        B.setTextAlign(align),
        B.extTextOutW({ x: 0, y: 0, text: 'A' }),
    ]), 'text', 'y');
    assert.equal(baseline(0x00), '90.5'); // Arial 上升部 0.905 em
    assert.equal(baseline(0x08), '-21.2'); // 1.117 − 0.905 = 0.212 em
});

test('文字：含旋转的世界变换改用 matrix() 排字', () => {
    const svg = svgOf([
        B.setWorldTransform([0.8387, -0.5446, 0.5446, 0.8387, 0, 0]),
        B.extCreateFontIndirectW({ handle: 1, face: 'Arial', height: -40 }),
        B.selectObject(1),
        B.setTextAlign(0x18),
        B.extTextOutW({ x: 10, y: 20, text: 'R' }),
    ]);
    assert.match(attr(svg, 'text', 'transform'), /^matrix\(0\.8387 -0\.5446 0\.5446 0\.8387 0 0\)$/);
});

test('文字：正的 lfHeight 按整体高度折算字号，EXTTEXTOUTA 走单字节路径', () => {
    const svg = svgOf([
        B.extCreateFontIndirectW({ handle: 1, face: 'Arial', height: 100 }),
        B.selectObject(1),
        B.setTextAlign(0x18),
        B.extTextOutW({ x: 0, y: 0, text: 'A', wide: false }),
    ]);
    assert.equal(attr(svg, 'text', 'font-size'), '89.5');
});

test('文字：ETO_GLYPH_INDEX 与符号字体进入诊断', () => {
    const glyphIndex = metafileToSvg(B.buildEmf([
        B.extCreateFontIndirectW({ handle: 1, face: 'Arial', height: -40 }),
        B.selectObject(1),
        B.extTextOutW({ x: 0, y: 0, text: 'AB', options: 0x0010 }),
    ]));
    assert.equal(countOf(glyphIndex.svg, 'text'), 0);
    assert.ok(glyphIndex.diagnostics.unsupported.some((item) => item.name.includes('ETO_GLYPH_INDEX')));

    const symbolFont = metafileToSvg(B.buildEmf([
        B.extCreateFontIndirectW({ handle: 1, face: 'Symbol', height: -40, charSet: 2 }),
        B.selectObject(1),
        B.setTextAlign(0x18),
        B.setBkMode(1),
        B.extTextOutW({ x: 0, y: 0, text: 'a' }),
    ]));
    assert.ok(symbolFont.diagnostics.unsupported.some((item) => item.name.includes('符号字体')));
    assert.deepEqual(symbolFont.diagnostics.fonts, ['Symbol']);
});

test('文字：OPAQUE 背景未绘制时进入诊断', () => {
    const result = metafileToSvg(B.buildEmf([
        B.extCreateFontIndirectW({ handle: 1, face: 'Arial', height: -40 }),
        B.selectObject(1),
        B.setBkMode(2),
        B.extTextOutW({ x: 0, y: 0, text: 'A' }),
    ]));
    assert.ok(result.diagnostics.unsupported.some((item) => item.name.includes('OPAQUE')));
});

test('裁剪：两次 INTERSECTCLIPRECT 得一个交集矩形，相同裁剪只定义一次 clipPath', () => {
    const result = metafileToSvg(B.buildEmf(withPen([
        B.intersectClipRect([0, 0, 100, 100]),
        B.intersectClipRect([50, 50, 200, 200]),
        B.polyline16([[0, 0], [10, 10]]),
        B.saveDc(),
        B.intersectClipRect([50, 50, 60, 60]),
        B.polyline16([[0, 0], [10, 10]]),
        B.restoreDc(-1),
        B.polyline16([[0, 0], [10, 10]]),
    ])));
    const clipRects = [...result.svg.matchAll(/<clipPath[^>]*><rect([^>]*)\/><\/clipPath>/g)].map((m) => m[1]);
    assert.equal(clipRects.length, 2, `实际 ${result.svg}`);
    assert.match(clipRects[0], /x="50" y="50" width="50" height="50"/);
    assert.match(clipRects[1], /x="50" y="50" width="10" height="10"/);
    // 第三条折线在 RestoreDC 之后回到第一个裁剪，复用同一个 clipPath
    assert.equal(countOf(result.svg, 'clipPath'), 2);
    assert.equal(result.diagnostics.clipped, 3);
});

test('裁剪：RestoreDC 之后裁剪恢复为无裁剪，分组随之关闭', () => {
    const svg = svgOf(withPen([
        B.saveDc(),
        B.intersectClipRect([0, 0, 100, 100]),
        B.polyline16([[0, 0], [10, 10]]),
        B.restoreDc(-1),
        B.polyline16([[0, 0], [20, 20]]),
    ]));
    assert.match(svg, /<g clip-path="url\(#c1\)"><polyline[^>]*\/><\/g><polyline/);
});

test('裁剪：EXTSELECTCLIPRGN 的替换、求交、清空与其余合并方式', () => {
    const intersect = svgOf(withPen([
        B.intersectClipRect([0, 0, 100, 100]),
        B.extSelectClipRgn([[50, 50, 200, 200]], 1),
        B.polyline16([[0, 0], [10, 10]]),
    ]));
    assert.match(intersect, /<rect x="50" y="50" width="50" height="50"\/>/);

    const multi = svgOf(withPen([
        B.extSelectClipRgn([[0, 0, 10, 10], [20, 20, 30, 30]], 5),
        B.polyline16([[0, 0], [10, 10]]),
    ]));
    assert.equal((multi.match(/<clipPath[^>]*>(<rect[^>]*\/>){2}<\/clipPath>/g) || []).length, 1);

    const cleared = svgOf(withPen([
        B.intersectClipRect([0, 0, 10, 10]),
        B.extSelectClipRgn([], 5),
        B.polyline16([[0, 0], [10, 10]]),
    ]));
    assert.equal(countOf(cleared, 'clipPath'), 0);

    const xored = metafileToSvg(B.buildEmf(withPen([
        B.extSelectClipRgn([[0, 0, 10, 10]], 3),
        B.polyline16([[0, 0], [10, 10]]),
    ])));
    assert.ok(xored.diagnostics.unsupported.some((item) => item.name === 'EMR_EXTSELECTCLIPRGN(mode=3)'));
});

test('裁剪：SELECTCLIPPATH 求交，EXCLUDECLIPRECT 与 OFFSETCLIPRGN 只进诊断', () => {
    const selected = svgOf(withPen([
        B.beginPath(),
        B.polygon16([[0, 0], [100, 0], [100, 100]]),
        B.endPath(),
        B.selectClipPath(5),
        B.polyline16([[0, 0], [10, 10]]),
    ]));
    assert.match(selected, /<clipPath[^>]*><path d="M0 0L100 0L100 100Z" clip-rule="evenodd"\/><\/clipPath>/);

    const noted = metafileToSvg(B.buildEmf(withPen([
        B.excludeClipRect([0, 0, 10, 10]),
        B.record(26, Buffer.alloc(8)),
        B.selectClipPath(2),
        B.polyline16([[0, 0], [10, 10]]),
    ])));
    const names = noted.diagnostics.unsupported.map((item) => item.name);
    assert.ok(names.includes('EMR_EXCLUDECLIPRECT'));
    assert.ok(names.includes('EMR_OFFSETCLIPRGN'));
    assert.ok(names.includes('EMR_SELECTCLIPPATH(mode=2)'));
});

test('笔：几何笔随变换缩放，装饰笔恒为 1 个设备单位', () => {
    const geometric = svgOf([
        B.modifyWorldTransform([1 / 16, 0, 0, 1 / 16, 0, 0], 2),
        B.extCreatePen({ handle: 1, style: 0x00010000, width: 160, color: B.rgb(0, 0, 0) }),
        B.selectObject(1),
        B.polyline16([[0, 0], [1600, 1600]]),
    ]);
    assert.equal(attr(geometric, 'polyline', 'stroke-width'), '10');

    const cosmetic = svgOf([
        B.modifyWorldTransform([1 / 16, 0, 0, 1 / 16, 0, 0], 2),
        B.createPen({ handle: 1, style: 0, width: 0, color: B.rgb(0, 0, 0) }),
        B.selectObject(1),
        B.polyline16([[0, 0], [1600, 1600]]),
    ]);
    assert.equal(attr(cosmetic, 'polyline', 'stroke-width'), '1');
    assert.equal(attr(cosmetic, 'polyline', 'stroke-linecap'), 'round');
});

test('笔：线宽不低于 minStrokePx（按输出像素换算到设备单位）', () => {
    const records = [
        B.extCreatePen({ handle: 1, style: 0x00010000, width: 1, color: B.rgb(0, 0, 0) }),
        B.selectObject(1),
        B.modifyWorldTransform([1 / 16, 0, 0, 1 / 16, 0, 0], 2),
        B.polyline16([[0, 0], [1600, 1600]]),
    ];
    const buffer = B.buildEmf(records);
    assert.equal(attr(metafileToSvg(buffer).svg, 'polyline', 'stroke-width'), '1');
    assert.equal(attr(metafileToSvg(buffer, { minStrokePx: 3 }).svg, 'polyline', 'stroke-width'), '3');
    // 输出像素放大一倍时，1 个输出像素只合 0.5 个设备单位
    assert.equal(attr(metafileToSvg(buffer, { width: 2000, height: 2000 }).svg, 'polyline', 'stroke-width'), '0.5');
});

test('笔：端帽、接头、斜接上限、空笔与虚线样式', () => {
    const styled = svgOf([
        B.setMiterLimit(4),
        B.extCreatePen({ handle: 1, style: 0x00010000 | 0x100 | 0x2000, width: 4, color: B.rgb(0, 0, 0) }),
        B.selectObject(1),
        B.polyline16([[0, 0], [10, 10]]),
    ]);
    assert.equal(attr(styled, 'polyline', 'stroke-linecap'), 'square');
    assert.equal(attr(styled, 'polyline', 'stroke-linejoin'), 'miter');
    assert.equal(attr(styled, 'polyline', 'stroke-miterlimit'), '4');

    const bevel = svgOf([
        B.extCreatePen({ handle: 1, style: 0x00010000 | 0x200 | 0x1000, width: 4, color: B.rgb(0, 0, 0) }),
        B.selectObject(1),
        B.polyline16([[0, 0], [10, 10]]),
    ]);
    assert.equal(attr(bevel, 'polyline', 'stroke-linecap'), 'butt');
    assert.equal(attr(bevel, 'polyline', 'stroke-linejoin'), 'bevel');
    assert.equal(attr(bevel, 'polyline', 'stroke-miterlimit'), null);

    const nullPen = svgOf([
        B.extCreatePen({ handle: 1, style: 0x00010000 | 5, width: 4, color: B.rgb(0, 0, 0) }),
        B.selectObject(1),
        B.polyline16([[0, 0], [10, 10]]),
    ]);
    assert.equal(attr(nullPen, 'polyline', 'stroke'), 'none');

    const dashed = svgOf([
        B.extCreatePen({ handle: 1, style: 0x00010000 | 1, width: 3, color: B.rgb(0, 0, 0) }),
        B.selectObject(1),
        B.polyline16([[0, 0], [10, 10]]),
    ]);
    assert.equal(attr(dashed, 'polyline', 'stroke-dasharray'), '18 6');
});

test('画刷：实心、空与库存对象；阴影线画刷进入诊断', () => {
    const solid = svgOf([
        B.createBrushIndirect({ handle: 1, style: 0, color: B.rgb(0, 128, 255) }),
        B.selectObject(1),
        B.polygon16([[0, 0], [10, 0], [10, 10]]),
    ]);
    assert.equal(attr(solid, 'polygon', 'fill'), '#0080ff');
    assert.equal(attr(solid, 'polygon', 'fill-rule'), 'evenodd');

    const winding = svgOf([
        B.setPolyFillMode(2),
        B.createBrushIndirect({ handle: 1, style: 0, color: B.rgb(0, 0, 0) }),
        B.selectObject(1),
        B.polygon16([[0, 0], [10, 0], [10, 10]]),
    ]);
    assert.equal(attr(winding, 'polygon', 'fill-rule'), null);

    const nullBrush = svgOf([B.selectObject(0x80000005), B.polygon16([[0, 0], [10, 0], [10, 10]])]);
    assert.equal(attr(nullBrush, 'polygon', 'fill'), 'none');

    const hatched = metafileToSvg(B.buildEmf([
        B.createBrushIndirect({ handle: 1, style: 2, color: B.rgb(0, 0, 0) }),
        B.selectObject(1),
        B.polygon16([[0, 0], [10, 0], [10, 10]]),
    ]));
    assert.ok(hatched.diagnostics.unsupported.some((item) => item.name.includes('CREATEBRUSHINDIRECT')));
});

test('对象表：DELETEOBJECT 之后 SELECTOBJECT 不改变状态', () => {
    const svg = svgOf([
        B.createPen({ handle: 1, style: 0, width: 0, color: B.rgb(255, 0, 0) }),
        B.selectObject(1),
        B.deleteObject(1),
        B.selectObject(1),
        B.polyline16([[0, 0], [10, 10]]),
    ]);
    assert.equal(attr(svg, 'polyline', 'stroke'), '#ff0000');
});

test('图形：矩形、椭圆、圆角矩形、LINETO 与 32 位折线族', () => {
    const shapes = svgOf(withPen([
        B.rectangle([10, 20, 110, 120]),
        B.ellipse([0, 0, 100, 50]),
        B.roundRect([0, 0, 40, 40], 8, 8),
        B.moveToEx(5, 5),
        B.lineTo(25, 35),
        B.polyline([[0, 0], [10, 10]]),
        B.polygon([[0, 0], [10, 0], [10, 10]]),
        B.polyBezier([[0, 0], [10, 0], [20, 10], [30, 10]]),
        B.polyPolygon([[[0, 0], [5, 0], [5, 5]], [[10, 10], [15, 10], [15, 15]]]),
    ]));
    assert.match(shapes, /<rect x="10" y="20" width="100" height="100"/);
    assert.match(shapes, /<ellipse cx="50" cy="25" rx="50" ry="25"/);
    assert.match(shapes, /<rect x="0" y="0" width="40" height="40" rx="4" ry="4"/);
    assert.match(shapes, /<line x1="5" y1="5" x2="25" y2="35"/);
    assert.match(shapes, /<path d="M0 0C10 0 20 10 30 10"/);
    assert.match(shapes, /<path d="M0 0L5 0L5 5ZM10 10L15 10L15 15Z"/);
});

test('图形：16 位的 …To 折线与贝塞尔从当前点续接并更新当前点', () => {
    const svg = svgOf(withPen([
        B.moveToEx(10, 10),
        B.polylineTo16([[20, 20], [30, 30]]),
        B.polyBezierTo16([[40, 30], [50, 40], [60, 40]]),
    ]));
    assert.match(svg, /<path d="M10 10L20 20L30 30"/);
    assert.match(svg, /<path d="M30 30C40 30 50 40 60 40"/);
    assert.match(svg, /<polyline|<path/);
    assert.match(svg, /<path d="M30 30C/);
});

test('路径括号：BEGINPATH…ENDPATH 后 FILLPATH 填充、STROKEPATH 描边、STROKEANDFILLPATH 兼有', () => {
    const build = (closer) => svgOf([
        B.extCreatePen({ handle: 1, style: 0x00010000, width: 2, color: B.rgb(0, 0, 0) }),
        B.selectObject(1),
        B.createBrushIndirect({ handle: 2, style: 0, color: B.rgb(255, 0, 0) }),
        B.selectObject(2),
        B.beginPath(),
        B.moveToEx(0, 0),
        B.polyBezier16([[0, 0], [10, 0], [20, 10], [30, 10]]),
        B.closeFigure(),
        B.endPath(),
        closer,
    ]);
    const filled = build(B.fillPath());
    assert.equal(attr(filled, 'path', 'fill'), '#ff0000');
    assert.equal(attr(filled, 'path', 'stroke'), 'none');
    const stroked = build(B.strokePath());
    assert.equal(attr(stroked, 'path', 'fill'), 'none');
    assert.equal(attr(stroked, 'path', 'stroke'), '#000000');
    const both = build(B.strokeAndFillPath());
    assert.equal(attr(both, 'path', 'fill'), '#ff0000');
    assert.equal(attr(both, 'path', 'stroke'), '#000000');
    assert.match(filled, /d="M0 0M0 0C10 0 20 10 30 10Z"/);

    const aborted = svgOf(withPen([B.beginPath(), B.polyline16([[0, 0], [10, 10]]), B.abortPath(), B.fillPath()]));
    assert.equal(countOf(aborted, 'path'), 0);
});

test('路径括号：…To 折线在路径内从当前点续接，闭合子路径后重新起笔', () => {
    const svg = svgOf(withPen([
        B.beginPath(),
        B.moveToEx(0, 0),
        B.polylineTo16([[10, 0], [10, 10]]),
        B.closeFigure(),
        B.moveToEx(20, 20),
        B.polylineTo16([[30, 20]]),
        B.endPath(),
        B.strokePath(),
    ]));
    assert.equal(attr(svg, 'path', 'd'), 'M0 0L10 0L10 10ZM20 20L30 20');

    // 路径内没有 MoveTo 时，…To 记录自行补一个起点
    const implicitStart = svgOf(withPen([
        B.beginPath(), B.polylineTo16([[10, 10]]), B.endPath(), B.strokePath(),
    ]));
    assert.equal(attr(implicitStart, 'path', 'd'), 'M0 0L10 10');
});

test('BITBLT：空操作 ROP 不输出图形，带位图的记录进入诊断', () => {
    const noop = metafileToSvg(B.buildEmf([B.bitBlt()]));
    assert.equal(countOf(noop.svg, 'rect'), 1, '只应有背景矩形');
    assert.equal(noop.diagnostics.unsupported.length, 0);

    const withBitmap = metafileToSvg(B.buildEmf([B.bitBlt({ rop: 0x00CC0020, bitmapBytes: 64 })]));
    assert.equal(countOf(withBitmap.svg, 'rect'), 1);
    const entry = withBitmap.diagnostics.unsupported.find((item) => item.name === 'EMR_BITBLT');
    assert.deepEqual(entry, { name: 'EMR_BITBLT', count: 1, kind: 'drawing' });

    const blackness = svgOf([B.bitBlt({ rop: 0x00000042, dest: [10, 10], size: [20, 30] })]);
    assert.match(blackness, /<rect x="10" y="10" width="20" height="30" fill="#000000"\/>/);
    const whiteness = svgOf([B.bitBlt({ rop: 0x00FF0062, dest: [0, 0], size: [5, 5] })]);
    assert.match(whiteness, /<rect x="0" y="0" width="5" height="5" fill="#ffffff"\/>/);
});

test('未支持的记录进入 diagnostics.unsupported 且分清 drawing 与 state', () => {
    const result = metafileToSvg(B.buildEmf([
        B.record(45, Buffer.alloc(40)), // EMR_ARC
        B.record(45, Buffer.alloc(40)),
        B.record(81, Buffer.alloc(80)), // EMR_STRETCHDIBITS
        B.record(119, Buffer.alloc(8)), // EMR_SETLINKEDUFIS：状态类
        B.setIcmMode(1), // 无害记录，不计入
        B.setRop2(13),
    ]));
    const byName = Object.fromEntries(result.diagnostics.unsupported.map((item) => [item.name, item]));
    assert.deepEqual(byName.EMR_ARC, { name: 'EMR_ARC', count: 2, kind: 'drawing' });
    assert.equal(byName.EMR_STRETCHDIBITS.kind, 'drawing');
    assert.equal(byName.EMR_SETLINKEDUFIS.kind, 'state');
    assert.equal(byName.EMR_SETICMMODE, undefined);
    assert.equal(byName.EMR_SETROP2, undefined);
});

test('draw 开关：绘图记录被抑制而状态记录照常生效（GDI+ 仲裁语义，供 W2 使用）', () => {
    const buffer = B.buildEmf([
        B.setWorldTransform([2, 0, 0, 2, 0, 0]),
        B.extCreatePen({ handle: 1, style: 0x00010000, width: 4, color: B.rgb(0, 0, 0) }),
        B.selectObject(1),
        B.polyline16([[0, 0], [10, 10]]),
        B.beginPath(),
        B.polyline16([[0, 0], [10, 10]]),
        B.endPath(),
        B.fillPath(),
    ]);
    const suppressed = replayDirect(buffer, false);
    assert.equal(countOf(suppressed.svg, 'polyline'), 0);
    assert.equal(countOf(suppressed.svg, 'path'), 0);
    assert.ok(suppressed.diagnostics.counters.classicSuppressed >= 3);
    assert.equal(suppressed.diagnostics.counters.classicDrawn, 0);
    assert.deepEqual(suppressed.replayer.state().worldTransform, [2, 0, 0, 2, 0, 0]);

    const drawn = replayDirect(buffer, true);
    assert.equal(countOf(drawn.svg, 'polyline'), 1);
    assert.equal(countOf(drawn.svg, 'path'), 1);
    assert.equal(drawn.diagnostics.counters.classicSuppressed, 0);
});

test('固定种子的变异循环 500 次：只会返回或抛 MetafileError，单次不超过 200 毫秒', () => {
    const base = B.buildEmf([
        B.modifyWorldTransform([1 / 16, 0, 0, 1 / 16, 0, 0], 2),
        B.extCreatePen({ handle: 1, style: 0x00010000, width: 16, color: B.rgb(0, 0, 0) }),
        B.selectObject(1),
        B.createBrushIndirect({ handle: 2, style: 0, color: B.rgb(0, 0, 0) }),
        B.selectObject(2),
        B.saveDc(),
        B.intersectClipRect([0, 0, 500, 500]),
        B.polyline16([[0, 0], [100, 100], [200, 50]]),
        B.polyPolygon16([[[0, 0], [10, 0], [10, 10]], [[20, 20], [30, 20], [30, 30]]]),
        B.beginPath(),
        B.polyBezier16([[0, 0], [10, 0], [20, 10], [30, 10]]),
        B.endPath(),
        B.fillPath(),
        B.extCreateFontIndirectW({ handle: 3, face: 'Arial', height: -40, escapement: 900 }),
        B.selectObject(3),
        B.setTextAlign(0x18),
        B.extTextOutW({ x: 10, y: 20, text: 'Ab1', dx: [10, 10, 10] }),
        B.bitBlt(),
        B.emfPlusComment([B.plusHeader({ dual: true })]),
        B.restoreDc(-1),
    ]);
    let seed = 0x5EED1234;
    const nextRandom = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
    let ok = 0;
    let thrown = 0;
    let slowest = 0;
    for (let round = 0; round < 500; round += 1) {
        const mutated = Buffer.from(base);
        const flips = 1 + Math.floor(nextRandom() * 4);
        for (let k = 0; k < flips; k += 1) {
            mutated[Math.floor(nextRandom() * mutated.length)] = Math.floor(nextRandom() * 256);
        }
        const startedAt = Date.now();
        try {
            metafileToSvg(mutated, { limits: { maxElapsedMs: 200 } });
            ok += 1;
        } catch (error) {
            assert.ok(error instanceof MetafileError, `第 ${round} 轮抛出了 ${error && error.name}：${error && error.message}`);
            assert.ok(['NOT_METAFILE', 'UNSUPPORTED_FORMAT', 'MALFORMED', 'LIMIT_EXCEEDED'].includes(error.code));
            thrown += 1;
        }
        const elapsed = Date.now() - startedAt;
        slowest = Math.max(slowest, elapsed);
        assert.ok(elapsed <= 200, `第 ${round} 轮耗时 ${elapsed} 毫秒`);
    }
    assert.equal(ok + thrown, 500);
    assert.ok(ok > 0 && thrown > 0, `成功 ${ok} 次、抛错 ${thrown} 次，两类都应出现`);
    assert.ok(slowest <= 200);
});
