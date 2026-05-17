/**
 * 转换任务调度器 + SSE 推送
 *
 * 任务模型（内存 Map，进程重启即丢失）：
 *   jobs    : jobId → { id, status, items[], summary, createdAt }
 *   item    : { idx, inputType, outputFormat, name, source?, status, result?, error? }
 *   sub     : jobId → Set<res>（SSE 订阅者）
 *
 * 调用方约定：
 *   createJob(items) → job
 *   subscribe(jobId, res) → 建立 SSE 长连接
 *   runJob(jobId, processItem, opts) → 并发处理（默认 concurrency=2，CPU 密集）
 *   getJob(jobId) → 轮询兜底
 *
 * 任务保留 30 分钟后清理。
 */

const { randomUUID } = require('crypto');

const jobs = new Map();
const subscribers = new Map();

const JOB_RETENTION_MS = 30 * 60 * 1000;
const SSE_DRAIN_DELAY_MS = 1000;

function createJob(items) {
    const jobId = randomUUID();
    const job = {
        id: jobId,
        status: 'queued',
        items: items.map((it, idx) => ({
            idx,
            inputType: it.inputType,
            outputFormat: it.outputFormat,
            name: it.name || it.source || `item-${idx}`,
            source: it.source,
            options: it.options || {},
            file: it.file || null,
            status: 'queued',
        })),
        summary: null,
        createdAt: Date.now(),
    };
    jobs.set(jobId, job);
    return job;
}

function getJob(jobId) {
    return jobs.get(jobId);
}

function subscribe(jobId, res) {
    if (!jobs.has(jobId)) {
        res.status(404).end();
        return;
    }

    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    // 立即推一条 hello，确认连接
    res.write(`event: hello\ndata: ${JSON.stringify({ jobId })}\n\n`);

    if (!subscribers.has(jobId)) {
        subscribers.set(jobId, new Set());
    }
    subscribers.get(jobId).add(res);

    res.on('close', () => {
        const set = subscribers.get(jobId);
        if (set) set.delete(res);
    });

    // 心跳每 25s
    const heartbeat = setInterval(() => {
        try {
            res.write(`: heartbeat\n\n`);
        } catch (e) {
            clearInterval(heartbeat);
        }
    }, 25000);

    res.on('close', () => clearInterval(heartbeat));
}

function emit(jobId, event, data) {
    const set = subscribers.get(jobId);
    if (!set || set.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) {
        try {
            res.write(payload);
        } catch (e) {
            // 客户端已断开，下一次 close 事件会清理
        }
    }
}

/**
 * 运行任务。
 * @param {string} jobId
 * @param {(item, reportProgress) => Promise<resultData>} processItem
 *   reportProgress(phase, pct, name?) — 可选回调，触发 progress 事件
 * @param {{ concurrency?: number }} opts
 */
async function runJob(jobId, processItem, { concurrency = 2 } = {}) {
    const job = jobs.get(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);

    job.status = 'running';
    let success = 0;
    let failed = 0;
    const queue = [...job.items];

    async function worker() {
        while (queue.length) {
            const item = queue.shift();
            if (!item) return;
            item.status = 'running';

            emit(jobId, 'progress', {
                idx: item.idx,
                phase: 'parsing',
                pct: 0,
                name: item.name,
            });

            try {
                const data = await processItem(item, (phase, pct, name) => {
                    emit(jobId, 'progress', {
                        idx: item.idx,
                        phase,
                        pct,
                        name: name || item.name,
                    });
                });
                item.status = 'success';
                item.result = data;
                success++;
                emit(jobId, 'item', { idx: item.idx, success: true, data });
            } catch (err) {
                item.status = 'failed';
                item.error = err && err.message ? err.message : String(err);
                failed++;
                emit(jobId, 'item', {
                    idx: item.idx,
                    success: false,
                    error: item.error,
                });
            }
        }
    }

    const n = Math.min(concurrency, queue.length) || 1;
    const workers = Array.from({ length: n }, worker);
    await Promise.all(workers);

    job.status = 'done';
    job.summary = { total: job.items.length, success, failed };
    emit(jobId, 'done', { summary: job.summary });

    setTimeout(() => {
        const set = subscribers.get(jobId);
        if (set) {
            for (const res of set) {
                try {
                    res.end();
                } catch (e) {}
            }
            subscribers.delete(jobId);
        }
    }, SSE_DRAIN_DELAY_MS);

    setTimeout(() => {
        jobs.delete(jobId);
    }, JOB_RETENTION_MS);

    return job;
}

module.exports = {
    createJob,
    getJob,
    subscribe,
    runJob,
};
