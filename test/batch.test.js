/**
 * converters/batch.js 单元测试
 * 覆盖：空数组、并发上限、事件顺序、单项失败隔离、结果排序、展示名、回调异常、参数校验
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runBatch } = require('../converters/batch');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 统计 fn 的峰值并发
async function measurePeak(items, options) {
    let running = 0;
    let peak = 0;
    await runBatch(items, options, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(5);
        running -= 1;
    });
    return peak;
}

test('空数组：仅发 done 事件，返回空结果', async () => {
    // Arrange
    const events = [];

    // Act
    const out = await runBatch([], { onEvent: (e) => events.push(e) }, async () => 1);

    // Assert
    assert.deepEqual(out, { results: [], errors: [] });
    assert.deepEqual(events, [{ type: 'done', total: 0, succeeded: 0, failed: 0 }]);
});

test('并发不超过 concurrency；单项事件顺序为 start → progress → item，done 最后且只发一次', async () => {
    // Arrange
    const events = [];
    const items = [1, 2, 3, 4, 5];
    let running = 0;
    let peak = 0;

    // Act
    const out = await runBatch(items, { concurrency: 2, onEvent: (e) => events.push(e) }, async (item, onProgress) => {
        running += 1;
        peak = Math.max(peak, running);
        onProgress('parsing', 20);
        await sleep(10);
        running -= 1;
        return item * 10;
    });

    // Assert
    assert.equal(peak, 2);
    assert.deepEqual(out.results, items.map((v, i) => ({ idx: i, result: v * 10 })));
    assert.deepEqual(out.errors, []);
    for (let idx = 0; idx < items.length; idx += 1) {
        const seq = events.filter((e) => e.idx === idx).map((e) => e.type);
        assert.deepEqual(seq, ['start', 'progress', 'item'], `idx=${idx}`);
    }
    const progress = events.find((e) => e.type === 'progress');
    assert.deepEqual(progress, { type: 'progress', idx: progress.idx, phase: 'parsing', pct: 20 });
    assert.deepEqual(events.at(-1), { type: 'done', total: 5, succeeded: 5, failed: 0 });
    assert.equal(events.filter((e) => e.type === 'done').length, 1);
});

test('concurrency 超过 items 长度时按长度截断；非法值回退默认 2', async () => {
    const three = [0, 1, 2];
    const four = [0, 1, 2, 3];
    assert.equal(await measurePeak(three, { concurrency: 10 }), 3);
    assert.equal(await measurePeak(four, { concurrency: 'abc' }), 2);
    assert.equal(await measurePeak(four, { concurrency: 0 }), 2);
    assert.equal(await measurePeak(four, {}), 2);
    assert.equal(await measurePeak(four, { concurrency: 1 }), 1);
});

test('单项失败不影响其他项，错误记入 errors 与 item 事件', async () => {
    // Arrange
    const events = [];

    // Act
    const out = await runBatch(['a', 'b', 'c'], { concurrency: 1, onEvent: (e) => events.push(e) }, async (item) => {
        if (item === 'b') throw new Error('第二项失败');
        return item.toUpperCase();
    });

    // Assert
    assert.deepEqual(out.results, [{ idx: 0, result: 'A' }, { idx: 2, result: 'C' }]);
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].idx, 1);
    assert.equal(out.errors[0].error.message, '第二项失败');

    const failed = events.find((e) => e.type === 'item' && e.idx === 1);
    assert.equal(failed.ok, false);
    assert.equal(failed.error.message, '第二项失败');
    assert.equal('result' in failed, false);
    assert.deepEqual(events.at(-1), { type: 'done', total: 3, succeeded: 2, failed: 1 });
});

test('完成顺序乱序时 results 仍按 idx 升序', async () => {
    const out = await runBatch([30, 5, 15], { concurrency: 3 }, async (ms) => {
        await sleep(ms);
        return ms;
    });
    assert.deepEqual(out.results, [{ idx: 0, result: 30 }, { idx: 1, result: 5 }, { idx: 2, result: 15 }]);
});

test('start 事件的 name 依次取 item.name / input.path 文件名 / input.url / 字符串 / 序号', async () => {
    const events = [];
    const items = [
        { name: '甲' },
        { input: { path: '/x/y/报告.docx' } },
        { input: { url: 'https://a.b/c' } },
        'plain',
        42,
    ];

    await runBatch(items, { concurrency: 1, onEvent: (e) => events.push(e) }, async () => null);

    assert.deepEqual(
        events.filter((e) => e.type === 'start').map((e) => e.name),
        ['甲', '报告.docx', 'https://a.b/c', 'plain', '第 5 项'],
    );
});

test('onEvent 抛错不影响批处理；同步抛错的 fn 同样被隔离', async () => {
    const out = await runBatch([1, 2], { onEvent: () => { throw new Error('回调异常'); } }, async (x) => x);
    assert.equal(out.results.length, 2);

    const sync = await runBatch([1], {}, () => { throw new Error('同步异常'); });
    assert.equal(sync.errors[0].error.message, '同步异常');
    assert.deepEqual(sync.results, []);
});

test('非法参数抛中文错误', async () => {
    await assert.rejects(runBatch(null, {}, async () => {}), /数组/);
    await assert.rejects(runBatch([], {}, null), /fn/);
});
