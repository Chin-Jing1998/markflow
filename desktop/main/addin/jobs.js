/**
 * Word 加载项的转换任务编排（纯 Node，可脱离 Electron 单测；转换内核经参数注入）
 *
 * createJobManager({ service, tmpRoot, getOutputDir, getDefaults?, limits?, now?, log? }) → manager
 *   service        converters/service：planTasks / buildOptions / runConversion
 *   tmpRoot        上传临时目录的根（应用临时目录之下）；本模块独占，启动与 dispose 时整体清空
 *   getOutputDir   () => 设置里的输出目录（源路径不可用时的落点）
 *   getDefaults    () => 设置里的扁平转换默认项（与桌面端转换页一致地并入选项）；xmlProfile 与 validate 由本模块强制
 *   limits         { maxPending, maxRecords, ttlMs, uploadTimeoutMs }，缺省见 DEFAULT_LIMITS
 *
 *   reserve({ fileName, sourcePath }) → Promise<{ id, uploadPath }>
 *       占一个名额、裁决输出位置并建好私有临时目录（0700）；名额已满抛 JobError(429, 'queue-full')
 *   commit(id)  → 快照      上传已写完 → 入队；同一时刻只跑一个转换，其余按先后排队
 *   abort(id)   → Promise   上传失败或被拒 → 删临时目录、释放名额、不留记录
 *   get(id)     → 快照 | null
 *   productOf(id) → { outputPath, outputs } | null   仅成功任务；供「在访达中显示」「预览」取路径，路径从不出自客户端
 *   stats()     → { pending, running, records }
 *   dispose()   → Promise   不再受理；排队中的任务标为失败并清理；正在跑的任务无法中断，跑完后自行清理
 *
 * 快照（GET /v1/jobs/:id 的 data）：
 *   { id, name, status: 'queued'|'running'|'succeeded'|'failed', phase, pct, position, createdAt, startedAt, finishedAt,
 *     location: { basis, note }, result: { title, outputPath, outputs, warnings, parts, precheck } | null, error: { message } | null }
 *   precheck 为预检摘要 { available, blocking: string[], validation: { requested, engine, files: [{ file, valid, errorCount }] } }；
 *   outputs 原样取自结果信封，键名由转换内核决定，本模块不写死任何文件名。
 *
 * 生命周期：uploading（不对外）→ queued → running → succeeded | failed。上传的 docx 只落在该任务的临时目录，
 * 任务结束（成功、失败或中止）即删除；已结束的记录超过 ttlMs 或总数超过 maxRecords 时回收。
 * 停在 uploading 超过 uploadTimeoutMs 的任务视为被遗弃，在下一个回收点（reserve / get）连同名额、记录与临时目录一并回收：
 * 正常情况下轮不到它（请求流一断，服务层当场 abort），这是给「服务层没能察觉断开」兜底，使名额泄漏不必靠重启应用来恢复。
 * 日志只记任务号、字节数、耗时与状态，不记文件名、路径与文档内容；错误文案中的临时路径在回给客户端前抹掉。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { errText } = require('../../../converters/util');
const { resolveOutputLocation } = require('./output-location');

const fsp = fs.promises;
const noop = () => undefined;
/**
 * 上传阶段的时限（纵深防御，见文件头）：取 10 分钟——200 MB 的文档经本机回环上传只需数秒，
 * 服务层对整个请求的时限是 5 分钟，10 分钟长于它，不会误伤仍在进行的上传。
 */
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_LIMITS = Object.freeze({ maxPending: 5, maxRecords: 50, ttlMs: 60 * 60 * 1000, uploadTimeoutMs: UPLOAD_TIMEOUT_MS });
const JOB_ID_BYTES = 12;
const TMP_DIR_MODE = 0o700;
const UPLOAD_EXT = '.docx';
const TARGET = 'xml';
/** patent profile + DTD 校验：等价于命令行 convert <docx> --to xml --xml-profile patent --validate */
const FORCED_OPTIONS = Object.freeze({ xmlProfile: 'patent', validate: true });
const STATUS = Object.freeze({ UPLOADING: 'uploading', QUEUED: 'queued', RUNNING: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed' });
/** 五书各部分在结果信封 outputs 中的键；顺序即任务窗格的展示顺序与预览的默认取用顺序 */
const PART_KEYS = Object.freeze(['description', 'claims', 'abstract', 'drawings', 'abstractFigure']);
const PRECHECK_KEY = 'precheck';
const STOPPED_MESSAGE = 'Word 加载项服务已停止，任务未执行';

class JobError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'JobError';
        this.status = status;
        this.code = code;
    }
}

const isFinished = (job) => job.status === STATUS.SUCCEEDED || job.status === STATUS.FAILED;
const toIso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** precheck.json 的 validation 段 → 摘要：各文件只留是否通过与错误条数，错误原文已在告警里 */
function summarizeValidation(validation) {
    if (!validation || typeof validation !== 'object') return null;
    const files = Array.isArray(validation.files) ? validation.files : [];
    return {
        requested: Boolean(validation.requested),
        engine: typeof validation.engine === 'string' ? validation.engine : null,
        files: files.map((item) => ({ file: String(item.file), valid: Boolean(item.valid), errorCount: Array.isArray(item.errors) ? item.errors.length : 0 })),
    };
}

/** 读产物目录里的预检清单并压成摘要；读不到或不是合法 JSON 时回 available: false，不影响任务成败 */
async function readPrecheckSummary(precheckPath) {
    const empty = { summary: { available: false, blocking: [], validation: null }, report: null };
    if (typeof precheckPath !== 'string' || !precheckPath) return empty;
    try {
        const report = JSON.parse(await fsp.readFile(precheckPath, 'utf8'));
        const blocking = Array.isArray(report.blocking) ? report.blocking.filter((item) => typeof item === 'string') : [];
        return { report, summary: { available: true, blocking, validation: summarizeValidation(report.validation) } };
    } catch (err) {
        return empty;
    }
}

/**
 * 预检清单里的 source 由转换内核按输入文件路径写入，这里的输入是上传的临时文件（任务结束即删）；
 * 改写为真实的文档路径，未保存的文档写 null，避免产物里留一个指向不存在文件的路径。只改已存在的 source 键。
 */
async function rewritePrecheckSource(precheckPath, report, sourcePath) {
    if (!report || typeof report !== 'object' || !Object.prototype.hasOwnProperty.call(report, 'source')) return;
    const next = { ...report, source: sourcePath || null };
    const tmp = `${precheckPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        await fsp.writeFile(tmp, JSON.stringify(next, null, 2), { flag: 'wx' });
        await fsp.rename(tmp, precheckPath);
    } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(noop);
    }
}

function createJobManager({ service, tmpRoot, getOutputDir, getDefaults = () => ({}), limits = {}, now = () => Date.now(), log = noop } = {}) {
    if (!service || typeof service.runConversion !== 'function') throw new Error('createJobManager 缺少 service');
    if (typeof tmpRoot !== 'string' || !path.isAbsolute(tmpRoot)) throw new Error('createJobManager 需要绝对路径的 tmpRoot');
    if (typeof getOutputDir !== 'function') throw new Error('createJobManager 缺少 getOutputDir');
    const caps = { ...DEFAULT_LIMITS, ...limits };
    const root = path.resolve(tmpRoot);
    /** id → 冻结的任务记录；状态变化一律以新对象替换（update），不就地改写 */
    const jobs = new Map();
    /** 排队中的任务号，先进先出 */
    const queue = [];
    const state = { runningId: null, disposed: false, purged: null };

    /** 首次使用前清掉上次异常退出留下的临时目录（单实例锁保证同一时刻只有一个主进程） */
    const purgeOnce = () => {
        if (!state.purged) state.purged = fsp.rm(root, { recursive: true, force: true }).catch(noop);
        return state.purged;
    };

    function update(id, patch) {
        const current = jobs.get(id);
        if (!current) return null;
        const next = Object.freeze({ ...current, ...patch });
        jobs.set(id, next);
        return next;
    }

    const pendingCount = () => [...jobs.values()].filter((job) => job.status === STATUS.UPLOADING || job.status === STATUS.QUEUED).length;
    const removeTmp = (job) => (job.dir ? fsp.rm(job.dir, { recursive: true, force: true }).catch(noop) : Promise.resolve());
    /** 错误文案里可能带着临时路径（如「输入文件不存在：…」），回给客户端前换成文件名 */
    const scrub = (job, text) => String(text).split(job.uploadPath).join(`${job.name}${UPLOAD_EXT}`).split(root).join('（临时目录）');

    /** 被遗弃的上传：停在 uploading 超过时限。先同步删记录（名额当场腾出），临时目录随后异步删除 */
    function reapStaleUploads(current) {
        const stale = [...jobs.values()].filter((job) => job.status === STATUS.UPLOADING && current - job.createdAt > caps.uploadTimeoutMs);
        for (const job of stale) {
            jobs.delete(job.id);
            removeTmp(job);
            log(`[addin] 任务 ${job.id} 上传超时未完成，已回收`);
        }
    }

    /** 回收点：先清被遗弃的上传，再回收已结束的记录（先按存活时间，再按总数上限，从最早结束的删起）；排队中与运行中的任务从不回收 */
    function prune() {
        const current = now();
        reapStaleUploads(current);
        const finished = [...jobs.values()].filter(isFinished).sort((a, b) => a.finishedAt - b.finishedAt);
        for (const job of finished) {
            if (current - job.finishedAt > caps.ttlMs) jobs.delete(job.id);
        }
        const overflow = jobs.size - caps.maxRecords;
        if (overflow <= 0) return;
        for (const job of finished.filter((item) => jobs.has(item.id)).slice(0, overflow)) jobs.delete(job.id);
    }

    async function reserve({ fileName, sourcePath } = {}) {
        if (state.disposed) throw new JobError(503, 'stopped', STOPPED_MESSAGE);
        prune();
        if (pendingCount() >= caps.maxPending) throw new JobError(429, 'queue-full', `排队中的任务已达上限（${caps.maxPending} 个），请等前面的任务完成后再试`);
        // 先同步占位再做异步准备：并发到达的请求逐个看到已被占掉的名额，不会一起越过上限
        const id = crypto.randomBytes(JOB_ID_BYTES).toString('hex');
        jobs.set(id, Object.freeze({
            id, status: STATUS.UPLOADING, phase: STATUS.QUEUED, pct: 0, createdAt: now(), startedAt: null, finishedAt: null, result: null, error: null,
        }));
        try {
            await purgeOnce();
            const location = await resolveOutputLocation({ sourcePath, fileName, fallbackDir: getOutputDir() });
            const dir = path.join(root, `job-${id}`);
            await fsp.mkdir(dir, { recursive: true, mode: TMP_DIR_MODE });
            const uploadPath = path.join(dir, `${location.baseName}${UPLOAD_EXT}`);
            // 准备期间记录被拿走（dispose，或超时回收）：名额已不属于本次请求，刚建的目录不能留成无主的
            if (!update(id, { name: location.baseName, dir, uploadPath, location })) {
                await fsp.rm(dir, { recursive: true, force: true }).catch(noop);
                throw new JobError(503, 'stopped', STOPPED_MESSAGE);
            }
            return { id, uploadPath };
        } catch (err) {
            jobs.delete(id);
            throw err instanceof JobError ? err : new JobError(500, 'prepare-failed', errText(err));
        }
    }

    async function abort(id) {
        const job = jobs.get(id);
        if (!job || job.status !== STATUS.UPLOADING) return;
        jobs.delete(id);
        await removeTmp(job);
    }

    function commit(id) {
        const job = jobs.get(id);
        if (!job || job.status !== STATUS.UPLOADING) throw new JobError(404, 'not-found', '任务不存在');
        if (state.disposed) throw new JobError(503, 'stopped', STOPPED_MESSAGE);
        const queued = update(id, { status: STATUS.QUEUED });
        queue.push(id);
        pump();
        return snapshot(jobs.get(id) || queued);
    }

    function pump() {
        if (state.runningId || state.disposed || queue.length === 0) return;
        const id = queue.shift();
        state.runningId = id;
        execute(id)
            .catch((err) => finish(id, { error: errText(err) }))
            .finally(() => {
                state.runningId = null;
                pump();
            });
    }

    async function execute(id) {
        const job = update(id, { status: STATUS.RUNNING, phase: 'parsing', startedAt: now() });
        const [task] = service.planTasks([job.uploadPath], TARGET, process.cwd());
        const options = service.buildOptions({ ...getDefaults(), ...FORCED_OPTIONS }, { targets: [TARGET] });
        const onEvent = (event) => {
            const current = jobs.get(id);
            if (!current || !event || event.type !== 'progress') return;
            update(id, {
                phase: typeof event.phase === 'string' ? event.phase : current.phase,
                pct: Number.isFinite(event.pct) ? Math.max(current.pct, Math.min(100, event.pct)) : current.pct,
            });
        };
        const outcome = await service.runConversion({ tasks: [task], outputDir: job.location.outputDir, concurrency: 1, options, onEvent });
        const result = outcome && outcome.ok && outcome.results ? outcome.results[0] : null;
        if (!result) {
            const failure = outcome && outcome.errors && outcome.errors[0];
            await finish(id, { error: (failure && failure.error) || '转换失败' });
            return;
        }
        await finish(id, { result: await describeResult(job, result) });
    }

    async function describeResult(job, result) {
        const outputs = result.outputs && typeof result.outputs === 'object' ? { ...result.outputs } : {};
        const { summary, report } = await readPrecheckSummary(outputs[PRECHECK_KEY]);
        await rewritePrecheckSource(outputs[PRECHECK_KEY], report, job.location.sourcePath);
        return {
            title: typeof result.title === 'string' ? result.title : '',
            outputPath: result.outputPath,
            outputs,
            warnings: Array.isArray(result.warnings) ? result.warnings.filter((item) => typeof item === 'string') : [],
            parts: PART_KEYS.filter((key) => typeof outputs[key] === 'string'),
            precheck: summary,
        };
    }

    /** 先删临时目录再翻状态：客户端看到「已结束」时，上传的 docx 已不在磁盘上 */
    async function finish(id, { result = null, error = null }) {
        const job = jobs.get(id);
        if (!job || isFinished(job)) return;
        await removeTmp(job);
        const finishedAt = now();
        update(id, {
            status: error ? STATUS.FAILED : STATUS.SUCCEEDED,
            phase: error ? 'failed' : 'done',
            pct: error ? job.pct : 100,
            finishedAt,
            result,
            error: error ? { message: scrub(job, error) } : null,
        });
        log(`[addin] 任务 ${id} ${error ? STATUS.FAILED : STATUS.SUCCEEDED}，耗时 ${finishedAt - (job.startedAt || finishedAt)} ms`);
    }

    function snapshot(job) {
        const position = job.status === STATUS.QUEUED ? queue.indexOf(job.id) + 1 : 0;
        return {
            id: job.id, name: job.name, status: job.status, phase: job.phase, pct: job.pct, position,
            createdAt: toIso(job.createdAt), startedAt: toIso(job.startedAt), finishedAt: toIso(job.finishedAt),
            location: { basis: job.location.basis, note: job.location.note },
            result: job.result ? { ...job.result, outputs: { ...job.result.outputs }, warnings: [...job.result.warnings], parts: [...job.result.parts] } : null,
            error: job.error ? { ...job.error } : null,
        };
    }

    function get(id) {
        prune();
        const job = jobs.get(id);
        return job && job.status !== STATUS.UPLOADING ? snapshot(job) : null;
    }

    function productOf(id) {
        const job = jobs.get(id);
        if (!job || job.status !== STATUS.SUCCEEDED || !job.result) return null;
        return { outputPath: job.result.outputPath, outputs: { ...job.result.outputs }, parts: [...job.result.parts] };
    }

    async function dispose() {
        state.disposed = true;
        const waiting = queue.splice(0, queue.length);
        await Promise.all(waiting.map((id) => finish(id, { error: STOPPED_MESSAGE })));
        const uploading = [...jobs.values()].filter((job) => job.status === STATUS.UPLOADING);
        await Promise.all(uploading.map((job) => abort(job.id)));
        // 仍有任务在跑时只删各任务自己的目录（由 finish 负责），根目录留到下次启动清理
        if (!state.runningId) await fsp.rm(root, { recursive: true, force: true }).catch(noop);
    }

    const stats = () => ({ pending: pendingCount(), running: state.runningId ? 1 : 0, records: jobs.size });

    return { reserve, commit, abort, get, productOf, stats, dispose };
}

module.exports = { createJobManager, JobError, readPrecheckSummary, DEFAULT_LIMITS, STATUS, PART_KEYS, FORCED_OPTIONS };
