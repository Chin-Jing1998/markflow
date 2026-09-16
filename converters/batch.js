/**
 * 批量执行（受限并发，可取消）
 *
 * runBatch(items, { concurrency = 2, onEvent, signal }, fn)
 *   fn(item, onProgress, signal) → 结果（可为 Promise）
 *   onProgress(phase, pct) 由 fn 调用，转发为 progress 事件；signal 原样转交 fn，底层可自行响应中止
 *
 * 事件顺序（单项）：{ type:'start', idx, name } → { type:'progress', idx, phase, pct }* → { type:'item', idx, ok, result?, error? }
 * 全部结束后：{ type:'done', total, succeeded, failed }（有任务被取消时另带 cancelled 计数）
 * 返回：{ results: [{ idx, result }], errors: [{ idx, error, cancelled? }] }，均按 idx 升序
 *
 * 取消：signal（AbortSignal）中止后不再领取新任务，已在运行的任务照常跑完并按实际结果记录；
 * 未领取的任务不发 start，直接以 Error('已取消') 记入 errors（该项带 cancelled: true），并发一条同样带
 * cancelled: true 的 item 事件；failed 计数包含被取消的任务。未传 signal 或未中止时，事件与返回值形状不变。
 *
 * 单项异常只记入 errors，不影响其他项；onEvent 自身异常被吞掉，不影响批处理。
 * concurrency 上限按 items 长度截断，非法值回退默认值；signal 须为 AbortSignal（或带布尔 aborted 的同形对象）。
 */
const path = require('path');

const DEFAULT_CONCURRENCY = 2;
const CANCELLED_MESSAGE = '已取消';

async function runBatch(items, options = {}, fn) {
    if (!Array.isArray(items)) throw new Error('runBatch: items 必须是数组');
    if (typeof fn !== 'function') throw new Error('runBatch: 缺少任务函数 fn');

    const { concurrency = DEFAULT_CONCURRENCY, onEvent, signal } = options || {};
    assertSignal(signal);
    const isAborted = () => Boolean(signal && signal.aborted);
    const emit = typeof onEvent === 'function'
        ? (event) => { try { onEvent(event); } catch (err) { /* 事件回调自身的异常不影响批处理 */ } }
        : () => {};
    const total = items.length;
    const parsed = Math.floor(Number(concurrency));
    const workerCount = Math.min(Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_CONCURRENCY, total);

    const results = [];
    const errors = [];
    let cursor = 0;

    const runOne = async (idx) => {
        emit({ type: 'start', idx, name: displayName(items[idx], idx) });
        try {
            const result = await fn(items[idx], (phase, pct) => emit({ type: 'progress', idx, phase, pct }), signal);
            results.push({ idx, result });
            emit({ type: 'item', idx, ok: true, result });
        } catch (error) {
            errors.push({ idx, error });
            emit({ type: 'item', idx, ok: false, error });
        }
    };

    // 每个 worker 循环领取下一个下标；cursor 的读取与递增在同一同步段内完成，无竞争；中止后不再领取
    const worker = async () => {
        while (cursor < total && !isAborted()) {
            const idx = cursor;
            cursor += 1;
            await runOne(idx);
        }
    };

    await Promise.all(Array.from({ length: workerCount }, worker));
    // 中止后仍未领取的任务（下标 cursor 起）一律记为已取消
    const cancelled = total - cursor;
    for (let idx = cursor; idx < total; idx += 1) {
        const error = new Error(CANCELLED_MESSAGE);
        errors.push({ idx, error, cancelled: true });
        emit({ type: 'item', idx, ok: false, error, cancelled: true });
    }
    const byIdx = (a, b) => a.idx - b.idx;
    const sorted = { results: [...results].sort(byIdx), errors: [...errors].sort(byIdx) };
    emit({
        type: 'done', total, succeeded: sorted.results.length, failed: sorted.errors.length,
        ...(cancelled > 0 ? { cancelled } : {}),
    });
    return sorted;
}

function assertSignal(signal) {
    if (signal === undefined || signal === null) return;
    if (typeof signal !== 'object' || typeof signal.aborted !== 'boolean') throw new Error('runBatch: signal 须为 AbortSignal');
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
