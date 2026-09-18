/**
 * converters/metafile/reader.js 与 index.js 对外契约的单元测试
 *
 * 覆盖：合成构造器自证、魔数嗅探、文件头与 viewBox（含 frame 退化回落 bounds）、
 * 四种错误码、各项上限触发 LIMIT_EXCEEDED、limits 只能收紧、inspectMetafile 的盘点结果，
 * 以及两条可核的模块约束（顶层 require 只有内建与同目录模块；同一输入两次输出逐字节相同）。
 *
 * 夹具一律由 test/helpers/emf-builder.js 在运行时合成，不入库任何二进制图元。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const B = require('./helpers/emf-builder');
const { sniffMetafile, inspectMetafile, metafileToSvg, MetafileError } = require('../converters/metafile');
const { createReader, readRecords, readEmfHeader, createBudget, resolveLimits, DEFAULT_LIMITS } = require('../converters/metafile/reader');

const METAFILE_DIR = path.join(__dirname, '..', 'converters', 'metafile');

/** 断言抛出的是带指定 code 的 MetafileError */
function assertCode(fn, code) {
    try {
        fn();
    } catch (error) {
        assert.ok(error instanceof MetafileError, `期望 MetafileError，实际 ${error && error.name}: ${error && error.message}`);
        assert.equal(error.code, code, `期望 code=${code}，实际 ${error.code}（${error.message}）`);
        return error;
    }
    assert.fail(`期望抛出 ${code}，但没有抛错`);
    return null;
}

const simpleEmf = (records = [B.polyline16([[0, 0], [100, 100]])], options) => B.buildEmf(records, options);

test('构造器自证：合成的 EMF 能被读取器解析，记录数与字节长度与文件头相符', () => {
    const records = [B.saveDc(), B.setTextAlign(0x18), B.polyline16([[0, 0], [10, 10]]), B.restoreDc(-1)];
    const buffer = B.buildEmf(records);
    const reader = createReader(buffer);
    const header = readEmfHeader(reader);
    assert.equal(header.declaredBytes, buffer.length);
    const budget = createBudget(DEFAULT_LIMITS);
    const parsed = [...readRecords(reader, budget)];
    // 迭代器在 EMR_EOF 处收尾，故 yield 出来的是 HEADER + 中间记录；预算计数含 EOF
    assert.equal(parsed.length, records.length + 1);
    assert.equal(budget.records, header.declaredRecords);
    assert.equal(parsed.reduce((sum, item) => sum + item.size, 0) + 20, buffer.length);
});

test('sniffMetafile 只看魔数：emf、wmf、wmf-placeable 与非图元', () => {
    assert.equal(sniffMetafile(simpleEmf()), 'emf');
    const placeable = Buffer.alloc(32);
    placeable.writeUInt32LE(0x9AC6CDD7, 0);
    assert.equal(sniffMetafile(placeable), 'wmf-placeable');
    const wmf = Buffer.alloc(32);
    wmf.writeUInt16LE(1, 0);
    wmf.writeUInt16LE(9, 2);
    assert.equal(sniffMetafile(wmf), 'wmf');
    assert.equal(sniffMetafile(Buffer.from('not a metafile at all')), null);
    assert.equal(sniffMetafile('字符串不是 Buffer'), null);
    assert.equal(sniffMetafile(Buffer.alloc(2)), null);
});

test('文件头：内容不在原点时 viewBox 起点等于 frame 换算的设备像素', () => {
    const buffer = simpleEmf(undefined, { frame: [2540, 5080, 27940, 30480] });
    const result = metafileToSvg(buffer);
    assert.deepEqual(result.viewBox, [100, 200, 1000, 1000]);
    assert.match(result.svg, /viewBox="100 200 1000 1000"/);
    assert.equal(result.width, 1000);
    assert.equal(result.height, 1000);
});

test('文件头：frame 退化时回落到 bounds', () => {
    const buffer = simpleEmf(undefined, { frame: [0, 0, 0, 0], bounds: [0, 0, 199, 99] });
    assert.deepEqual(metafileToSvg(buffer).viewBox, [0, 0, 200, 100]);
});

test('文件头：frame 与 bounds 都为空时判为 MALFORMED', () => {
    const buffer = simpleEmf(undefined, { frame: [0, 0, 0, 0], bounds: [0, 0, -1, -1] });
    assertCode(() => metafileToSvg(buffer), 'MALFORMED');
});

test('错误码：非图元为 NOT_METAFILE，WMF 为 UNSUPPORTED_FORMAT', () => {
    assertCode(() => metafileToSvg(Buffer.from('这不是图元，只是一段文字')), 'NOT_METAFILE');
    assertCode(() => metafileToSvg(Buffer.alloc(0)), 'NOT_METAFILE');
    assertCode(() => metafileToSvg('字符串'), 'NOT_METAFILE');
    const placeable = Buffer.alloc(64);
    placeable.writeUInt32LE(0x9AC6CDD7, 0);
    assertCode(() => metafileToSvg(placeable), 'UNSUPPORTED_FORMAT');
    const wmf = Buffer.alloc(64);
    wmf.writeUInt16LE(2, 0);
    wmf.writeUInt16LE(9, 2);
    assertCode(() => metafileToSvg(wmf), 'UNSUPPORTED_FORMAT');
});

test('错误码 MALFORMED：截断、长度非 4 的倍数、长度过短、越过文件尾、缺 EMR_EOF', () => {
    assertCode(() => metafileToSvg(simpleEmf(undefined, { omitEof: true })), 'MALFORMED');
    const truncated = simpleEmf();
    assertCode(() => metafileToSvg(truncated.subarray(0, truncated.length - 8)), 'MALFORMED');

    const oddLength = simpleEmf();
    oddLength.writeUInt32LE(110, 112); // 第二条记录的长度改成非 4 的倍数
    assertCode(() => metafileToSvg(oddLength), 'MALFORMED');

    const tooShort = simpleEmf();
    tooShort.writeUInt32LE(4, 112);
    assertCode(() => metafileToSvg(tooShort), 'MALFORMED');

    const beyondEnd = simpleEmf();
    beyondEnd.writeUInt32LE(0x10000, 112);
    assertCode(() => metafileToSvg(beyondEnd), 'MALFORMED');
});

test('错误码 MALFORMED：记录内偏移越过本记录边界', () => {
    const withOffString = B.buildEmf([B.extTextOutW({ x: 10, y: 20, text: 'AB' })]);
    // 文件头 108 字节，文字记录随即开始；offString 位于记录内偏移 36 + 12
    withOffString.writeUInt32LE(0xFFFF, 108 + 36 + 12);
    assertCode(() => metafileToSvg(withOffString), 'MALFORMED');

    const withOffDx = B.buildEmf([B.extTextOutW({ x: 10, y: 20, text: 'AB', dx: [5, 5] })]);
    withOffDx.writeUInt32LE(0xFFFF, 108 + 36 + 36);
    assertCode(() => metafileToSvg(withOffDx), 'MALFORMED');
});

test('上限：字节数、记录数、单条点数、栈深、裁剪矩形数、文字字符数、SVG 字节数、耗时', () => {
    const many = simpleEmf([
        B.polyline16([[0, 0], [10, 10], [20, 20]]),
        B.polyline16([[0, 0], [10, 10]]),
        B.polyline16([[0, 0], [10, 10]]),
    ]);
    assertCode(() => metafileToSvg(many, { limits: { maxBytes: 100 } }), 'LIMIT_EXCEEDED');
    assertCode(() => metafileToSvg(many, { limits: { maxRecords: 2 } }), 'LIMIT_EXCEEDED');
    assertCode(() => metafileToSvg(many, { limits: { maxPoints: 2 } }), 'LIMIT_EXCEEDED');
    assertCode(() => metafileToSvg(many, { limits: { maxSvgBytes: 150 } }), 'LIMIT_EXCEEDED');
    assertCode(() => metafileToSvg(many, { limits: { maxElapsedMs: 0 } }), 'LIMIT_EXCEEDED');

    const deep = simpleEmf([B.saveDc(), B.saveDc(), B.saveDc()]);
    assertCode(() => metafileToSvg(deep, { limits: { maxStackDepth: 2 } }), 'LIMIT_EXCEEDED');

    const clips = simpleEmf([B.extSelectClipRgn([[0, 0, 10, 10], [5, 5, 20, 20]], 1)]);
    assertCode(() => metafileToSvg(clips, { limits: { maxClipRects: 1 } }), 'LIMIT_EXCEEDED');

    const text = simpleEmf([B.extTextOutW({ x: 0, y: 0, text: 'ABCDE' })]);
    assertCode(() => metafileToSvg(text, { limits: { maxTextChars: 2 } }), 'LIMIT_EXCEEDED');
});

test('limits 只能收紧：传入更宽的值不会放宽默认上限', () => {
    const merged = resolveLimits({ maxRecords: 10 ** 9, maxPoints: 5, maxElapsedMs: -1, maxBytes: 'x' });
    assert.equal(merged.maxRecords, DEFAULT_LIMITS.maxRecords);
    assert.equal(merged.maxPoints, 5);
    assert.equal(merged.maxElapsedMs, DEFAULT_LIMITS.maxElapsedMs);
    assert.equal(merged.maxBytes, DEFAULT_LIMITS.maxBytes);
    assert.equal(resolveLimits(null), DEFAULT_LIMITS);
    assert.equal(resolveLimits('不是对象'), DEFAULT_LIMITS);
});

test('inspectMetafile：只扫描不渲染，未支持的绘图记录进入 unsupported', () => {
    const buffer = B.buildEmf([
        B.polyline16([[0, 0], [10, 10]]),
        B.record(81, Buffer.alloc(80)), // EMR_STRETCHDIBITS：位图记录，本模块未支持
        B.record(45, Buffer.alloc(40)), // EMR_ARC：弧，本模块未支持
        B.setIcmMode(1), // 无害记录，不应进入 unsupported
    ]);
    const info = inspectMetafile(buffer);
    assert.equal(info.format, 'emf');
    assert.equal(info.records.classic.EMR_POLYLINE16, 1);
    assert.equal(info.records.classic.EMR_HEADER, 1);
    assert.equal(info.records.classic.EMR_EOF, 1);
    assert.deepEqual(info.records.plus, {});
    assert.deepEqual(info.header.frameMm, { width: 254, height: 254 });
    assert.deepEqual(info.header.device.px, [1000, 1000]);
    assert.equal(info.plus, null);
    assert.equal(info.nestedDepth, 0);
    assert.equal(info.hasChemDrawCdx, false);
    const names = info.unsupported.map((item) => item.name).sort();
    assert.deepEqual(names, ['EMR_ARC', 'EMR_STRETCHDIBITS']);
    assert.ok(info.unsupported.every((item) => item.kind === 'drawing'));
    assert.ok(!info.unsupported.some((item) => item.name === 'EMR_SETICMMODE'));
});

test('inspectMetafile：Dual 文件报出 present、dual 与 logicalDpi', () => {
    const buffer = B.buildEmf([
        B.emfPlusComment([B.plusHeader({ dual: true, logicalDpi: [144, 144] })]),
        B.polyline16([[0, 0], [10, 10]]),
    ]);
    const info = inspectMetafile(buffer);
    assert.deepEqual(info.plus, { present: true, dual: true, logicalDpi: [144, 144] });
});

test('本批 auto 遇到 EMF+ 时按经典记录回放，并在诊断里注明', () => {
    const buffer = B.buildEmf([
        B.emfPlusComment([B.plusHeader({ dual: false, logicalDpi: [96, 96] })]),
        B.polyline16([[0, 0], [10, 10]]),
    ]);
    const auto = metafileToSvg(buffer);
    assert.deepEqual(auto.plus, { present: true, dual: false });
    assert.equal(auto.diagnostics.plusRecords, 1);
    assert.ok(auto.diagnostics.notes.some((note) => note.includes('EMF+ 回放尚未实现')));
    assert.match(auto.svg, /<polyline /);

    const classic = metafileToSvg(buffer, { stream: 'classic' });
    assert.equal(classic.svg, auto.svg, 'W1 的 auto 与 classic 输出应当一致');
    assert.ok(classic.diagnostics.notes.some((note) => note.includes('只回放经典 EMR 记录')));
});

test('非 EMF+ 的 GDI 注释被忽略：既不绘制也不进 unsupported', () => {
    const result = metafileToSvg(B.buildEmf([
        B.gdiComment(Buffer.from('@Origin_Begin.Layer0.', 'latin1')),
        B.polyline16([[0, 0], [10, 10]]),
    ]));
    assert.deepEqual(result.diagnostics.unsupported, []);
    assert.equal(result.diagnostics.plusRecords, 0);
    assert.deepEqual(result.plus, { present: false, dual: false });
    assert.equal(result.diagnostics.shapes, 1);
});

test('classic 流容忍畸形的 EMF+ 注释，auto 流则判为 MALFORMED', () => {
    const bad = B.record(70, Buffer.concat([
        Buffer.from([0x20, 0x00, 0x00, 0x00]), // DataSize 声明 32 字节，实际不足
        Buffer.from([0x45, 0x4D, 0x46, 0x2B]), // 'EMF+'
        Buffer.alloc(4),
    ]));
    const buffer = B.buildEmf([bad, B.polyline16([[0, 0], [10, 10]])]);
    assertCode(() => metafileToSvg(buffer), 'MALFORMED');
    const classic = metafileToSvg(buffer, { stream: 'classic' });
    assert.ok(classic.diagnostics.unsupported.some((item) => item.name === 'EMF+(注释解析失败)'));
});

test('纯函数：同一输入两次调用的 svg 逐字节相同，elapsedMs 不进入 svg', () => {
    const buffer = B.buildEmf([
        B.extCreateFontIndirectW({ handle: 1, face: 'Arial', height: -40 }),
        B.selectObject(1),
        B.setTextAlign(0x18),
        B.extTextOutW({ x: 10, y: 20, text: 'Ab', dx: [10, 10] }),
        B.intersectClipRect([0, 0, 50, 50]),
        B.polygon16([[0, 0], [10, 0], [10, 10]]),
    ]);
    const first = metafileToSvg(buffer, { width: 300, height: 300 });
    const second = metafileToSvg(buffer, { width: 300, height: 300 });
    assert.equal(first.svg, second.svg);
    assert.ok(Buffer.from(first.svg).equals(Buffer.from(second.svg)));
    assert.ok(!/elapsed/i.test(first.svg));
    assert.equal(typeof first.diagnostics.elapsedMs, 'number');
});

test('readEmfHeader 自身也做魔数兜底，inspectMetafile 的异常同样收敛为 MetafileError', () => {
    // 公开入口先嗅探魔数，这一层是纵深防御；直接调用即可验证
    assertCode(() => readEmfHeader(createReader(Buffer.alloc(200))), 'NOT_METAFILE');
    const truncated = simpleEmf(undefined, { omitEof: true });
    assertCode(() => inspectMetafile(truncated), 'MALFORMED');
    assertCode(() => inspectMetafile(Buffer.from('不是图元')), 'NOT_METAFILE');
});

test('模块约束：converters/metafile/*.js 顶层只 require 内建模块与同目录模块', () => {
    const files = fs.readdirSync(METAFILE_DIR).filter((name) => name.endsWith('.js'));
    assert.ok(files.length >= 5);
    for (const name of files) {
        const source = fs.readFileSync(path.join(METAFILE_DIR, name), 'utf8');
        const specifiers = [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
        for (const specifier of specifiers) {
            const local = specifier.startsWith('./') && !specifier.slice(2).includes('/');
            const builtin = builtinModules.includes(specifier.replace(/^node:/, ''));
            assert.ok(local || builtin, `${name} 顶层 require 了 ${specifier}`);
        }
    }
});

test('metafileToSvg 接受 Uint8Array 与 ArrayBuffer', () => {
    const buffer = simpleEmf();
    const view = new Uint8Array(buffer);
    assert.equal(metafileToSvg(view).svg, metafileToSvg(buffer).svg);
    const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    assert.equal(metafileToSvg(copy).svg, metafileToSvg(buffer).svg);
});
