/**
 * 变异测试：不可信图元的容错边界
 *
 * 判据只有两条，与调研报告 4.6 的第一层设防对应：
 *   ① 对任意变异输入，metafileToSvg／inspectMetafile 要么正常返回，要么抛 MetafileError（四种 code 之一），
 *      绝不抛出其它异常类型、绝不产出非字符串的 svg；
 *   ② 单次调用不超过时间预算（本用例取 200 毫秒），即不存在死循环与指数级回溯。
 *
 * 变异源是一个「什么都有」的合成夹具：Dual 的两套记录、续接的内嵌图元对象、三类裁剪、
 * 状态栈、文字与各种点编码。随机数带固定种子，失败可复现。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const B = require('./helpers/emf-builder');
const { inspectMetafile, metafileToSvg } = require('../converters/metafile');

/** 固定种子的 xorshift32：同一种子恒得同一变异序列 */
function createRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state ^= (state << 13); state >>>= 0;
        state ^= (state >>> 17);
        state ^= (state << 5); state >>>= 0;
        return state / 0x100000000;
    };
}
const SEED = 0x5EED2026;
const ITERATIONS = 400;
/** 单次调用的时间预算（毫秒） */
const CALL_BUDGET_MS = 200;
const ERROR_CODES = new Set(['NOT_METAFILE', 'UNSUPPORTED_FORMAT', 'MALFORMED', 'LIMIT_EXCEEDED']);

/** 内嵌图元：自身也是 Dual，内部还有 GetDC 区段与经典记录 */
function buildNested() {
    return B.buildEmf([
        B.emfPlusComment([
            B.plusHeader({ dual: true }),
            B.plusObject(2, 1, B.plusPenData({ argb: 0xFF000000, width: 2, unit: 0 })),
            B.plusDrawLines(1, [[0, 0], [1000, 1000], [0, 1000]], { closed: true }),
            B.plusObject(3, 2, B.plusPathData([[0, 0], [500, 0], [500, 500]], [0, 1, 1 | 0x80])),
            B.plusFillPath(2, 0xFF204080),
            B.plusGetDc(),
        ]),
        B.polyline16([[0, 0], [500, 500]]),
    ]);
}

/** 顶层夹具：续接对象、内嵌图元、裁剪、状态栈、文字、压缩点、注释 */
function buildFixture() {
    const inner = buildNested();
    return B.buildEmf([
        B.emfPlusComment([
            B.plusHeader({ dual: true, logicalDpi: [96, 96] }),
            B.plusSetPageTransform(0.24, 2),
            B.plusObject(6, 3, B.plusFontData({ em: 133.33, unit: 2, style: 1, face: 'Arial' })),
            B.plusObject(7, 4, B.plusStringFormatData({ leadingMargin: 0 })),
            B.plusObject(4, 5, B.plusRegionRectData([0, 0, 800, 800])),
            B.plusSave(0),
            B.plusSetClipRegion(5, 1),
            B.plusDrawString({ fontId: 3, formatId: 4, text: 'MeO', x: 120, y: 240 }),
            B.plusDrawLines(0, [[10, 10], [200, 40], [90, 120]], { compressed: true }),
            B.plusFillRects(0xFF000000, [[0, 0, 40, 40], [80, 80, 20, 20]]),
            B.plusRestore(0),
            B.plusComment(Buffer.from('CDIF\x00VjCD0100', 'latin1')),
            ...B.nestedMetafile(inner, { id: 6, chunkSize: 512 }),
            B.plusDrawImagePoints(6, [0, 0, 1000, 1000], [[100, 100], [900, 100], [100, 900]]),
        ]),
        B.extCreateFontIndirectW({ handle: 1, face: 'Arial', height: -40 }),
        B.selectObject(1),
        B.extTextOutW({ x: 10, y: 20, text: 'Ab', dx: [10, 10] }),
        B.intersectClipRect([0, 0, 500, 500]),
        B.polyline16([[0, 0], [10, 10]]),
        B.beginPath(),
        B.polyBezier16([[0, 0], [10, 0], [10, 10], [20, 10]]),
        B.endPath(),
        B.fillPath(),
    ]);
}

/** 一次变异：字节翻转、置零置满、截断或删段 */
function mutate(source, random) {
    const out = Buffer.from(source);
    const rounds = 1 + Math.floor(random() * 4);
    for (let round = 0; round < rounds; round += 1) {
        const at = Math.floor(random() * out.length);
        const choice = random();
        if (choice < 0.45) out[at] ^= 1 << Math.floor(random() * 8);
        else if (choice < 0.7) out[at] = 0xFF;
        else if (choice < 0.85) out[at] = 0x00;
        else out[at] = Math.floor(random() * 256);
    }
    if (random() < 0.15) return out.subarray(0, 1 + Math.floor(random() * out.length));
    return out;
}

/** 调用一次并判定：要么正常返回，要么抛 MetafileError；耗时不超过预算 */
function callOnce(label, run) {
    const startedAt = process.hrtime.bigint();
    let outcome = null;
    try {
        outcome = run();
    } catch (error) {
        assert.equal(error.name, 'MetafileError', `${label} 抛出了非 MetafileError：${error && error.stack}`);
        assert.ok(ERROR_CODES.has(error.code), `${label} 的错误码越界：${error.code}`);
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    assert.ok(elapsedMs < CALL_BUDGET_MS, `${label} 耗时 ${elapsedMs.toFixed(1)} 毫秒，超过预算`);
    return outcome;
}

test('变异循环：含 EMF+、续接对象与内嵌图元的夹具只会返回或抛 MetafileError', () => {
    const fixture = buildFixture();
    const random = createRandom(SEED);
    let converted = 0;
    for (let index = 0; index < ITERATIONS; index += 1) {
        const mutated = mutate(fixture, random);
        const label = `第 ${index} 次变异`;
        const result = callOnce(`${label}（auto）`, () => metafileToSvg(mutated));
        if (result) {
            converted += 1;
            assert.equal(typeof result.svg, 'string');
            assert.ok(result.svg.startsWith('<svg '), `${label} 产出的不是 SVG`);
            assert.ok(result.svg.endsWith('</svg>'));
            assert.doesNotMatch(result.svg, /<script|foreignObject|xlink:href|javascript:/i);
        }
        callOnce(`${label}（classic）`, () => metafileToSvg(mutated, { stream: 'classic' }));
        callOnce(`${label}（inspect）`, () => inspectMetafile(mutated));
    }
    assert.ok(converted > ITERATIONS / 10, `变异后仍能出图的次数过少（${converted}），夹具可能未被有效覆盖`);
});

test('变异循环：收紧的上限同样只会抛 MetafileError', () => {
    const fixture = buildFixture();
    const random = createRandom(SEED ^ 0x1234);
    const limits = { maxRecords: 64, maxPoints: 512, maxObjectBytes: 4096, maxNestedDepth: 1, maxSvgBytes: 8192 };
    for (let index = 0; index < ITERATIONS / 2; index += 1) {
        const mutated = mutate(fixture, random);
        callOnce(`第 ${index} 次变异（收紧上限）`, () => metafileToSvg(mutated, { limits }));
    }
});

test('未变异的夹具本身可转换，且两次调用逐字节相同', () => {
    const fixture = buildFixture();
    const first = metafileToSvg(fixture);
    const second = metafileToSvg(fixture);
    assert.equal(first.svg, second.svg);
    assert.ok(first.diagnostics.shapes > 0);
    assert.equal(first.diagnostics.nested, 1);
    assert.equal(first.diagnostics.text, 1, '经典段的 EXTTEXTOUTW 被抑制，只画 EMF+ 的 DrawString');
    assert.ok(first.diagnostics.classicSuppressed > 0);
    assert.equal(first.diagnostics.getDcSections, 1, '内嵌层的 GetDC 区段');
    assert.equal(inspectMetafile(fixture).hasChemDrawCdx, true);
});
