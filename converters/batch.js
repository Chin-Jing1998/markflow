/**
 * 批量执行（受限并发）
 *
 * runBatch(items, { concurrency = 2, onEvent }, fn)
 *   fn(item, onProgress) → 结果（可为 Promise）
 *   onProgress(phase, pct) 由 fn 调用，转发为 progress 事件
 *
 * 事件顺序（单项）：{ type:'start', idx, name } → { type:'progress', idx, phase, pct }* → { type:'item', idx, ok, result?, error? }
 * 全部结束后：{ type:'done', total, succeeded, failed }
 * 返回：{ results: [{ idx, result }], errors: [{ idx, error }] }，均按 idx 升序
 *
 * 单项异常只记入 errors，不影响其他项；onEvent 自身异常被吞掉，不影响批处理。
 * concurrency 上限按 items 长度截断，非法值回退默认值。
 */
const path = require('path');

const DEFAULT_CONCURRENCY = 2;

async function runBatch(items, options = {}, fn) {
    if (!Array.isArray(items)) throw new Error('runBatch: items 必须是数组');
    if (typeof fn !== 'function') throw new Error('runBatch: 缺少任务函数 fn');

    const { concurrency = DEFAULT_CONCURRENCY, onEvent } = options || {};
    const emit = createEmitter(onEvent);
    const total = items.length;
    const workerCount = resolveConcurrency(concurrency, total);

    const results = [];
    const errors = [];
    let cursor = 0;

    const runOne = async (idx) => {
        const item = items[idx];
        emit({ type: 'start', idx, name: displayName(item, idx) });
        const onProgress = (phase, pct) => emit({ type: 'progress', idx, phase, pct });
        try {
            const result = await fn(item, onProgress);
            results.push({ idx, result });
            emit({ type: 'item', idx, ok: true, result });
        } catch (error) {
            errors.push({ idx, error });
            emit({ type: 'item', idx, ok: false, error });
        }
    };

    // 每个 worker 循环领取下一个下标；cursor 的读取与递增在同一同步段内完成，无竞争
    const worker = async () => {
        while (cursor < total) {
            const idx = cursor;
            cursor += 1;
            await runOne(idx);
        }
    };

    await Promise.all(Array.from({ length: workerCount }, worker));

    const byIdx = (a, b) => a.idx - b.idx;
    const sortedResults = [...results].sort(byIdx);
    const sortedErrors = [...errors].sort(byIdx);
    emit({ type: 'done', total, succeeded: sortedResults.length, failed: sortedErrors.length });
    return { results: sortedResults, errors: sortedErrors };
}

// 非法或非正数回退默认值，再按 items 长度截断
function resolveConcurrency(value, total) {
    const parsed = Number(value);
    const wanted = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_CONCURRENCY;
    return Math.min(wanted, total);
}

function createEmitter(onEvent) {
    if (typeof onEvent !== 'function') return () => {};
    return (event) => {
        try {
            onEvent(event);
        } catch (err) {
            // 事件回调自身的异常不影响批处理
        }
    };
}

// start 事件的展示名：item.name → input.path 文件名 → input.url → 序号
function displayName(item, idx) {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
        if (typeof item.name === 'string' && item.name) return item.name;
        const input = item.input || {};
        if (typeof input.path === 'string' && input.path) return path.basename(input.path);
        if (typeof input.url === 'string' && input.url) return input.url;
    }
    return `第 ${idx + 1} 项`;
}

module.exports = { runBatch };
