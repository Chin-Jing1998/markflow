/**
 * 两套记录的仲裁（[MS-EMFPLUS] 1.3.1）：stream = 'auto' 与 'classic' 的分工
 *
 * 覆盖：Dual 文件不重复绘制、经典回退段残缺时 auto 仍完整（复现调研报告 2.6 的缺陷形态）、
 * EmfPlusGetDC 区段的放行与再次抑制、无 EMF+ 时两种流逐字节相同、抑制期状态记录照常生效、
 * 抑制期的路径括号不跨记录串接，以及内嵌图元内部的 GetDC 区段。
 *
 * 夹具一律由 test/helpers/emf-builder.js 在运行时合成，不入库任何二进制图元。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const B = require('./helpers/emf-builder');
const { metafileToSvg } = require('../converters/metafile');

const auto = (buffer) => metafileToSvg(buffer);
const classic = (buffer) => metafileToSvg(buffer, { stream: 'classic' });

test('Dual 且两套记录等价：auto 只画 EMF+ 段，经典绘图记录全部计入 classicSuppressed', () => {
    const buffer = B.buildEmf([
        B.emfPlusComment([
            B.plusHeader({ dual: true }),
            B.plusDrawLines(0, [[0, 0], [100, 100]]),
            B.plusFillPolygon(0xFF000000, [[0, 0], [50, 0], [50, 50]]),
        ]),
        B.polyline16([[0, 0], [100, 100]]),
        B.polygon16([[0, 0], [50, 0], [50, 50]]),
    ]);
    const withPlus = auto(buffer);
    assert.equal(withPlus.diagnostics.shapes, 2, '两套记录描述同一幅画，不得画两遍');
    assert.equal(withPlus.diagnostics.plusDrawn, 2);
    assert.equal(withPlus.diagnostics.classicDrawn, 0);
    assert.equal(withPlus.diagnostics.classicSuppressed, 2);
    assert.ok(withPlus.diagnostics.classicSuppressed > 0);
    assert.doesNotMatch(withPlus.svg, /<polyline /);

    const onlyClassic = classic(buffer);
    assert.equal(onlyClassic.diagnostics.shapes, 2);
    assert.equal(onlyClassic.diagnostics.classicDrawn, 2);
    assert.equal(onlyClassic.diagnostics.plusDrawn, 0);
    assert.equal(onlyClassic.diagnostics.plusRecords, 3, 'classic 流仍清点 EMF+ 记录，供双流互校');
    assert.match(onlyClassic.svg, /<polyline /);
});

test('Dual 且经典段被人为截短：auto 的画面完整，classic 缺失后半幅', () => {
    const buffer = B.buildEmf([
        B.emfPlusComment([
            B.plusHeader({ dual: true }),
            B.plusDrawLines(0, [[0, 0], [100, 100]]),
            B.plusDrawLines(0, [[200, 200], [300, 300]]),
        ]),
        // 录制器按外层设备范围裁剔经典回退段，只留下前半幅（调研报告 2.6 表 H 的 image26／28 形态）
        B.polyline16([[0, 0], [100, 100]]),
    ]);
    const withPlus = auto(buffer);
    assert.equal(withPlus.diagnostics.shapes, 2);
    assert.match(withPlus.svg, /M0 0L100 100/);
    assert.match(withPlus.svg, /M200 200L300 300/);

    const onlyClassic = classic(buffer);
    assert.equal(onlyClassic.diagnostics.shapes, 1);
    assert.doesNotMatch(onlyClassic.svg, /200 200/);
    assert.ok(withPlus.diagnostics.shapes > onlyClassic.diagnostics.shapes, '双流互校据此判定经典段残缺');
});

test('Dual 且经典段为空白：auto 照常出图，classic 只剩白底', () => {
    const buffer = B.buildEmf([
        B.emfPlusComment([
            B.plusHeader({ dual: true }),
            B.plusFillPolygon(0xFF000000, [[0, 0], [50, 0], [50, 50]]),
        ]),
        // 经典段的几何被空矩形裁掉（image32／34 形态）：这里直接省去，等价于零条绘图记录
        B.intersectClipRect([0, 0, 0, 0]),
    ]);
    assert.equal(auto(buffer).diagnostics.shapes, 1);
    assert.equal(classic(buffer).diagnostics.shapes, 0);
});

test('GetDC：其后的经典绘图放行，下一条任意 EMF+ 记录之后再次抑制', () => {
    const buffer = B.buildEmf([
        B.emfPlusComment([B.plusHeader({ dual: true })]),
        B.polyline16([[0, 0], [10, 10]]),
        B.emfPlusComment([B.plusGetDc()]),
        B.polyline16([[20, 20], [30, 30]]),
        // EmfPlusComment 也是「任意类型的 EMF+ 记录」，其后经典绘图重新被抑制
        B.emfPlusComment([B.plusComment(Buffer.from('CDIF', 'latin1'))]),
        B.polyline16([[40, 40], [50, 50]]),
    ]);
    const result = auto(buffer);
    assert.equal(result.diagnostics.getDcSections, 1);
    assert.equal(result.diagnostics.classicDrawn, 1);
    assert.equal(result.diagnostics.classicSuppressed, 2);
    assert.match(result.svg, /points="20,20 30,30"/);
    assert.doesNotMatch(result.svg, /points="0,0 10,10"/);
    assert.doesNotMatch(result.svg, /points="40,40 50,50"/);
});

test('GetDC：同一个注释块里的 GetDC 只对其后的经典记录生效', () => {
    const buffer = B.buildEmf([
        B.emfPlusComment([B.plusHeader({ dual: true }), B.plusGetDc(), B.plusDrawLines(0, [[0, 0], [1, 1]])]),
        B.polyline16([[20, 20], [30, 30]]),
    ]);
    const result = auto(buffer);
    assert.equal(result.diagnostics.classicDrawn, 0, 'GetDC 之后紧跟 EMF+ 记录，区段随即结束');
    assert.equal(result.diagnostics.classicSuppressed, 1);
    assert.equal(result.diagnostics.plusDrawn, 1);
});

test('无 EMF+ 记录的文件：auto 与 classic 的输出逐字节相同', () => {
    const buffer = B.buildEmf([
        B.extCreateFontIndirectW({ handle: 1, face: 'Arial', height: -40 }),
        B.selectObject(1),
        B.setTextAlign(0x18),
        B.extTextOutW({ x: 10, y: 20, text: 'Ab', dx: [10, 10] }),
        B.intersectClipRect([0, 0, 500, 500]),
        B.polyline16([[0, 0], [10, 10]]),
        B.polygon16([[0, 0], [50, 0], [50, 50]]),
        B.gdiComment(Buffer.from('@Origin_Begin.Layer0.', 'latin1')),
    ]);
    const withPlus = auto(buffer);
    const onlyClassic = classic(buffer);
    assert.equal(withPlus.svg, onlyClassic.svg);
    assert.equal(withPlus.diagnostics.plusRecords, 0);
    assert.deepEqual(withPlus.plus, { present: false, dual: false });
    assert.deepEqual(withPlus.diagnostics.notes, []);
});

test('抑制期的状态记录照常生效：GetDC 之后沿用抑制期选中的笔与世界变换', () => {
    const buffer = B.buildEmf([
        B.emfPlusComment([B.plusHeader({ dual: true })]),
        B.extCreatePen({ handle: 1, style: 0x00010000, width: 6, color: B.rgb(0x22, 0x44, 0x66) }),
        B.selectObject(1),
        B.setWorldTransform([2, 0, 0, 2, 0, 0]),
        B.polyline16([[0, 0], [10, 10]]),
        B.emfPlusComment([B.plusGetDc()]),
        B.polyline16([[10, 10], [20, 20]]),
    ]);
    const result = auto(buffer);
    assert.equal(result.diagnostics.classicDrawn, 1);
    assert.match(result.svg, /points="20,20 40,40"/, '世界变换在抑制期已经生效');
    assert.match(result.svg, /stroke="#224466"/);
    assert.match(result.svg, /stroke-width="12"/);
});

test('抑制期的路径括号不跨记录串接：GetDC 之后的折线单独成形', () => {
    const buffer = B.buildEmf([
        B.emfPlusComment([B.plusHeader({ dual: true })]),
        B.beginPath(),
        B.polyline16([[100, 100], [200, 200]]),
        B.endPath(),
        B.fillPath(),
        B.emfPlusComment([B.plusGetDc()]),
        B.polyline16([[10, 10], [20, 20]]),
    ]);
    const result = auto(buffer);
    assert.equal(result.diagnostics.shapes, 1);
    assert.match(result.svg, /<polyline points="10,10 20,20"/);
    assert.doesNotMatch(result.svg, /100 100/, '被抑制的路径必须在 FILLPATH 处清空');
});

test('内嵌图元内部的 GetDC 区段：经典记录画进内嵌片段', () => {
    const inner = B.buildEmf([
        B.emfPlusComment([B.plusHeader({ dual: true }), B.plusGetDc()]),
        B.polyline16([[0, 0], [1000, 1000]]),
        B.emfPlusComment([B.plusDrawLines(0, [[0, 1000], [1000, 0]])]),
        B.polyline16([[0, 500], [1000, 500]]),
    ]);
    const buffer = B.buildEmf([
        B.emfPlusComment([
            B.plusHeader({ dual: true }),
            ...B.nestedMetafile(inner, { id: 7 }),
            B.plusDrawImagePoints(7, [0, 0, 1000, 1000], [[0, 0], [500, 0], [0, 500]]),
        ]),
    ]);
    const result = auto(buffer);
    assert.equal(result.diagnostics.nested, 1);
    assert.equal(result.diagnostics.getDcSections, 1);
    assert.equal(result.diagnostics.classicDrawn, 1, '内嵌层里只有 GetDC 之后的那一条放行');
    assert.equal(result.diagnostics.classicSuppressed, 1);
    assert.equal(result.diagnostics.plusDrawn, 1);
    assert.match(result.svg, /<g transform="matrix\(0\.5 0 0 0\.5 0 0\)">/);
    assert.match(result.svg, /<polyline points="0,0 1000,1000"/);
    assert.doesNotMatch(result.svg, /points="0,500 1000,500"/);
});

test('classic 流下内嵌图元不被展开，EMF+ 记录只清点', () => {
    const inner = B.buildEmf([
        B.emfPlusComment([B.plusHeader({ dual: false }), B.plusFillPolygon(0xFF000000, [[0, 0], [10, 0], [10, 10]])]),
    ]);
    const buffer = B.buildEmf([
        B.emfPlusComment([
            B.plusHeader({ dual: true }),
            ...B.nestedMetafile(inner, { id: 7 }),
            B.plusDrawImagePoints(7, [0, 0, 1000, 1000], [[0, 0], [500, 0], [0, 500]]),
        ]),
        B.polyline16([[0, 0], [10, 10]]),
    ]);
    const result = classic(buffer);
    assert.equal(result.diagnostics.nested, 0);
    assert.equal(result.diagnostics.plusDrawn, 0);
    assert.equal(result.diagnostics.plusRecords, 3);
    assert.equal(result.diagnostics.classicDrawn, 1);
    assert.doesNotMatch(result.svg, /<g transform=/);
});

test('stream 取值只认 classic，其余一律按 auto 处理', () => {
    const buffer = B.buildEmf([
        B.emfPlusComment([B.plusHeader({ dual: true }), B.plusDrawLines(0, [[0, 0], [10, 10]])]),
        B.polyline16([[0, 0], [10, 10]]),
    ]);
    const expected = auto(buffer).svg;
    for (const stream of ['auto', 'emfplus', undefined, null, 'CLASSIC']) {
        assert.equal(metafileToSvg(buffer, { stream }).svg, expected, `stream=${stream}`);
    }
    assert.notEqual(classic(buffer).svg, expected);
});
