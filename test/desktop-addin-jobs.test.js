/**
 * desktop/main/addin/jobs.js 单元测试（转换内核以桩替代，脱离 Electron）
 * 覆盖：任务生命周期（上传中不对外 → 排队 → 运行 → 成功 / 失败）与快照形状；强制选项（patent + DTD 校验）并入设置默认项；
 *       同一时刻只跑一个转换、其余先进先出排队；排队名额上限（含并发到达的请求）与 429；
 *       上传临时文件的命名、权限与清理（成功、失败、抛异常、中止、dispose 五条路径）；首次使用前清掉上次残留；
 *       预检摘要与 precheck.json 的 source 改写；错误文案抹掉临时路径；已结束记录按存活时间与总数回收；
 *       纵深防御：停在 uploading 超过时限的任务被回收（名额、记录与临时目录一并释放），迟到的 commit 得 404。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createJobManager, JobError, DEFAULT_LIMITS, FORCED_OPTIONS, PART_KEYS } = require('../desktop/main/addin/jobs');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'addin-jobs-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const DOCX_BYTES = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not-a-real-docx')]);
let seq = 0;
const freshDir = (label) => {
    seq += 1;
    const dir = path.join(root, `${label}-${seq}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};
const tick = () => new Promise((resolve) => { setImmediate(resolve); });
async function until(predicate, label) {
    for (let i = 0; i < 400; i += 1) {
        if (await predicate()) return;
        await new Promise((resolve) => { setTimeout(resolve, 5); });
    }
    throw new Error(`等待超时：${label}`);
}

/**
 * 桩转换内核：每次 runConversion 记录现场（上传文件是否在、叫什么、权限），再按 behavior 产出结果。
 * gate 为真时每个任务都停在闸门上，由测试调用 release() 放行，用来观察并发与排队。
 */
function createStubService({ behavior = 'ok', gate = false } = {}) {
    const calls = [];
    const waiters = [];
    const stats = { active: 0, maxActive: 0 };
    const service = {
        calls, stats, flatOptions: [],
        release: () => { const next = waiters.shift(); if (next) next(); },
        planTasks: (raws, target) => raws.map((raw) => ({ raw, input: { path: raw }, target })),
        buildOptions: (flat, scope) => { service.flatOptions.push({ flat, scope }); return { built: flat }; },
        runConversion: async ({ tasks, outputDir, options, onEvent, concurrency }) => {
            const uploadPath = tasks[0].input.path;
            stats.active += 1;
            stats.maxActive = Math.max(stats.maxActive, stats.active);
            calls.push({
                uploadPath, outputDir, options, concurrency, target: tasks[0].target,
                existed: fs.existsSync(uploadPath),
                dirMode: fs.existsSync(uploadPath) ? fs.statSync(path.dirname(uploadPath)).mode & 0o777 : null,
            });
            try {
                onEvent({ type: 'start', idx: 0 });
                onEvent({ type: 'progress', idx: 0, phase: 'parsing', pct: 20 });
                if (gate) await new Promise((resolve) => { waiters.push(resolve); });
                if (behavior === 'throw') throw new Error('内核炸了');
                if (behavior === 'fail') return { ok: false, results: [], errors: [{ input: uploadPath, error: `输入文件不存在：${uploadPath}` }] };
                onEvent({ type: 'progress', idx: 0, phase: 'rendering', pct: 60 });
                onEvent({ type: 'progress', idx: 0, phase: 'parsing', pct: 10 });
                return { ok: true, results: [writeProduct(outputDir, path.basename(uploadPath, '.docx'), uploadPath)], errors: [] };
            } finally {
                stats.active -= 1;
            }
        },
    };
    return service;
}

/** 落一份与 patent profile 同形的产物：文件名故意不用官方名，确认被测模块只按 outputs 的键取路径 */
function writeProduct(outputDir, name, sourcePath) {
    const dir = path.join(outputDir, name);
    fs.mkdirSync(path.join(dir, '100001'), { recursive: true });
    const outputs = {
        claims: path.join(dir, '100001', '100001.xml'), description: path.join(dir, 'desc-any-name.xml'),
        zip: path.join(dir, `${name}.zip`), precheck: path.join(dir, 'precheck.json'),
    };
    fs.writeFileSync(outputs.claims, '<claims/>');
    fs.writeFileSync(outputs.description, '<description/>');
    fs.writeFileSync(outputs.zip, 'zip');
    fs.writeFileSync(outputs.precheck, JSON.stringify({
        profile: 'patent', generatedAt: '2026-09-18T00:00:00.000Z', source: sourcePath,
        blocking: ['预检：文档含修订标记'], warnings: ['分节：未识别到摘要'],
        items: [{ code: 'PRECHECK_REVISIONS', level: 'blocking', category: 'precheck', message: '预检：文档含修订标记' }],
        validation: { requested: true, engine: 'libxml2-wasm', files: [{ file: 'claims.xml', valid: true, errors: [], warnings: [] }, { file: 'description.xml', valid: false, errors: [{ line: 3, message: 'x' }], warnings: [] }] },
    }, null, 2));
    return { title: '一种测试装置', outputPath: dir, outputs, warnings: ['预检：文档含修订标记', '分节：未识别到摘要', 42] };
}

function createManager(overrides = {}) {
    const service = overrides.service || createStubService(overrides.stub);
    const outputDir = overrides.outputDir || freshDir('out');
    const tmpRoot = overrides.tmpRoot || path.join(freshDir('tmp'), 'uploads');
    const logs = [];
    const manager = createJobManager({
        service, tmpRoot, getOutputDir: () => outputDir, log: (line) => logs.push(line),
        ...(overrides.getDefaults ? { getDefaults: overrides.getDefaults } : {}),
        ...(overrides.limits ? { limits: overrides.limits } : {}),
        ...(overrides.now ? { now: overrides.now } : {}),
    });
    return { manager, service, outputDir, tmpRoot, logs };
}

async function submit(manager, meta = {}) {
    const reserved = await manager.reserve(meta);
    fs.writeFileSync(reserved.uploadPath, DOCX_BYTES);
    manager.commit(reserved.id);
    return reserved;
}

const finished = (manager, id) => until(() => ['succeeded', 'failed'].includes((manager.get(id) || {}).status), `任务 ${id} 结束`);

// ============================================================
// 生命周期
// ============================================================

test('成功路径：上传中不对外 → 运行 → 成功；快照、强制选项、预检摘要与临时文件清理', async () => {
    const { manager, service, outputDir, tmpRoot, logs } = createManager({ getDefaults: () => ({ jpegPpi: 300, xmlProfile: 'generic', validate: false }) });
    const reserved = await manager.reserve({ fileName: '测试 申请.docx', sourcePath: '' });
    assert.match(reserved.id, /^[a-f0-9]{24}$/);
    assert.equal(path.basename(reserved.uploadPath), '测试 申请.docx', '临时文件按产物名命名，转换内核据此派生产物目录名');
    assert.ok(reserved.uploadPath.startsWith(`${tmpRoot}${path.sep}`), '只写在临时根目录之内');
    assert.equal(manager.get(reserved.id), null, '上传未完成的任务不对外可见');
    assert.equal(manager.productOf(reserved.id), null);

    fs.writeFileSync(reserved.uploadPath, DOCX_BYTES);
    const queued = manager.commit(reserved.id);
    assert.ok(['queued', 'running'].includes(queued.status));
    await finished(manager, reserved.id);

    const job = manager.get(reserved.id);
    assert.equal(job.status, 'succeeded');
    assert.deepEqual([job.phase, job.pct, job.position, job.error], ['done', 100, 0, null]);
    assert.equal(job.name, '测试 申请');
    assert.deepEqual(job.location, { basis: 'output-dir', note: '文档尚未保存到磁盘，产物已存入 MarkFlow 的输出目录' });
    assert.ok(Date.parse(job.createdAt) <= Date.parse(job.finishedAt));
    assert.equal(job.result.title, '一种测试装置');
    assert.equal(job.result.outputPath, path.join(outputDir, '测试 申请'));
    assert.deepEqual(job.result.parts, ['description', 'claims'], '只列 outputs 里真实存在的键，顺序固定');
    assert.deepEqual(job.result.warnings, ['预检：文档含修订标记', '分节：未识别到摘要'], '非字符串告警被丢弃');
    assert.deepEqual(job.result.precheck, {
        available: true, blocking: ['预检：文档含修订标记'],
        validation: { requested: true, engine: 'libxml2-wasm', files: [{ file: 'claims.xml', valid: true, errorCount: 0 }, { file: 'description.xml', valid: false, errorCount: 1 }] },
    });

    const [call] = service.calls;
    assert.deepEqual([call.existed, call.dirMode, call.target, call.concurrency, call.outputDir], [true, 0o700, 'xml', 1, outputDir]);
    assert.deepEqual(service.flatOptions[0], { flat: { jpegPpi: 300, ...FORCED_OPTIONS }, scope: { targets: ['xml'] } }, 'patent 与 validate 由本模块强制，设置里的同名项盖不掉');
    assert.deepEqual(FORCED_OPTIONS, { xmlProfile: 'patent', validate: true });
    assert.equal(fs.existsSync(path.dirname(reserved.uploadPath)), false, '任务结束即删除上传的临时目录');
    assert.deepEqual(manager.productOf(reserved.id).parts, ['description', 'claims']);
    assert.deepEqual(manager.stats(), { pending: 0, running: 0, records: 1 });
    assert.ok(logs.every((line) => !line.includes('测试 申请') && !line.includes(outputDir)), '日志不含文件名与路径');
    assert.deepEqual(PART_KEYS, ['description', 'claims', 'abstract', 'drawings', 'abstractFigure']);
});

test('进度只增不减；快照是副本，改动它不影响任务记录', async () => {
    const { manager, service } = createManager({ stub: { gate: true } });
    const { id } = await submit(manager);
    await until(() => service.calls.length === 1, '任务开始运行');
    const running = manager.get(id);
    assert.deepEqual([running.status, running.phase, running.pct], ['running', 'parsing', 20]);
    service.release();
    await finished(manager, id);
    const done = manager.get(id);
    done.result.outputs.claims = '/etc/passwd';
    done.result.parts.push('evil');
    assert.notEqual(manager.get(id).result.outputs.claims, '/etc/passwd');
    assert.deepEqual(manager.productOf(id).parts, ['description', 'claims']);
});

test('precheck.json 的 source：未保存文档改写为 null，已保存文档改写为真实路径，其余字段不动', async () => {
    const caseDir = freshDir('案件');
    const savedDoc = path.join(caseDir, '已保存的申请.docx');
    fs.writeFileSync(savedDoc, 'x');
    const { manager } = createManager();
    const unsaved = await submit(manager, { sourcePath: '', fileName: '' });
    const saved = await submit(manager, { sourcePath: savedDoc });
    await finished(manager, unsaved.id);
    await finished(manager, saved.id);

    const unsavedJob = manager.get(unsaved.id);
    assert.match(unsavedJob.name, /^未命名文档-\d{8}-\d{6}$/);
    const unsavedReport = JSON.parse(fs.readFileSync(unsavedJob.result.outputs.precheck, 'utf8'));
    assert.equal(unsavedReport.source, null);
    assert.equal(unsavedReport.generatedAt, '2026-09-18T00:00:00.000Z');
    assert.equal(unsavedReport.items.length, 1);

    const savedJob = manager.get(saved.id);
    assert.deepEqual(savedJob.location, { basis: 'source-dir', note: null });
    assert.equal(savedJob.result.outputPath, path.join(caseDir, '已保存的申请'), '产物与源文件同级');
    assert.equal(JSON.parse(fs.readFileSync(savedJob.result.outputs.precheck, 'utf8')).source, savedDoc);
    assert.deepEqual(fs.readdirSync(path.dirname(savedJob.result.outputs.precheck)).filter((name) => name.endsWith('.tmp')), [], '改写不留临时文件');
});

test('失败路径：内核报错与抛异常都记为 failed，错误文案不含临时路径，临时目录照样清理', async () => {
    for (const behavior of ['fail', 'throw']) {
        const { manager, tmpRoot } = createManager({ stub: { behavior } });
        const reserved = await submit(manager, { fileName: '坏文档.docx' });
        await finished(manager, reserved.id);
        const job = manager.get(reserved.id);
        assert.deepEqual([job.status, job.phase, job.result], ['failed', 'failed', null], behavior);
        assert.ok(job.error.message.length > 0);
        assert.ok(!job.error.message.includes(tmpRoot), `错误文案不泄露临时目录（${behavior}）：${job.error.message}`);
        if (behavior === 'fail') assert.equal(job.error.message, '输入文件不存在：坏文档.docx');
        assert.equal(manager.productOf(reserved.id), null, '失败的任务没有产物可供显示与预览');
        assert.equal(fs.existsSync(path.dirname(reserved.uploadPath)), false);
    }
});

// ============================================================
// 并发、排队与名额
// ============================================================

test('同一时刻只跑一个转换，其余按提交先后排队', async () => {
    const { manager, service } = createManager({ stub: { gate: true } });
    const ids = [];
    for (const name of ['甲', '乙', '丙']) ids.push((await submit(manager, { fileName: `${name}.docx` })).id);
    await until(() => service.calls.length === 1, '第一个任务开始');
    assert.deepEqual(ids.map((id) => manager.get(id).status), ['running', 'queued', 'queued']);
    assert.deepEqual(ids.map((id) => manager.get(id).position), [0, 1, 2]);
    assert.deepEqual(manager.stats(), { pending: 2, running: 1, records: 3 });

    service.release();
    await until(() => service.calls.length === 2, '第二个任务开始');
    assert.deepEqual(ids.map((id) => manager.get(id).status), ['succeeded', 'running', 'queued']);
    assert.equal(manager.get(ids[2]).position, 1);
    service.release();
    await until(() => service.calls.length === 3, '第三个任务开始');
    service.release();
    await finished(manager, ids[2]);
    assert.equal(service.stats.maxActive, 1, '从未有两个转换同时在跑');
    assert.deepEqual(service.calls.map((call) => path.basename(call.uploadPath)), ['甲.docx', '乙.docx', '丙.docx'], '先进先出');
});

test('排队名额有上限：超出回 429；并发到达的请求也不会一起越过上限；中止与完成会腾出名额', async () => {
    const { manager, service } = createManager({ stub: { gate: true }, limits: { maxPending: 2 } });
    const settled = await Promise.allSettled([1, 2, 3, 4].map(() => manager.reserve({})));
    const accepted = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    const rejected = settled.filter((item) => item.status === 'rejected').map((item) => item.reason);
    assert.equal(accepted.length, 2);
    assert.equal(rejected.length, 2);
    for (const err of rejected) {
        assert.ok(err instanceof JobError);
        assert.deepEqual([err.status, err.code], [429, 'queue-full']);
    }
    await manager.abort(accepted[0].id);
    assert.equal(fs.existsSync(path.dirname(accepted[0].uploadPath)), false, '中止即删临时目录');
    assert.throws(() => manager.commit(accepted[0].id), (err) => err instanceof JobError && err.status === 404, '已中止的任务不能再入队');
    const third = await manager.reserve({});
    await assert.rejects(manager.reserve({}), (err) => err.code === 'queue-full');

    // 正在运行的任务不占排队名额
    fs.writeFileSync(accepted[1].uploadPath, DOCX_BYTES);
    manager.commit(accepted[1].id);
    await until(() => service.calls.length === 1, '任务开始运行');
    const fourth = await manager.reserve({});
    assert.deepEqual(manager.stats(), { pending: 2, running: 1, records: 3 });
    await manager.abort(third.id);
    await manager.abort(fourth.id);
    service.release();
    await finished(manager, accepted[1].id);
    assert.equal(DEFAULT_LIMITS.maxPending, 5);
});

test('入参不合法：缺 service / tmpRoot 非绝对路径 / 缺 getOutputDir 直接抛错；输出目录不可用时 reserve 回 500 且不留记录', async () => {
    assert.throws(() => createJobManager({ tmpRoot: root, getOutputDir: () => root }), /缺少 service/);
    assert.throws(() => createJobManager({ service: createStubService(), tmpRoot: 'relative', getOutputDir: () => root }), /绝对路径/);
    assert.throws(() => createJobManager({ service: createStubService(), tmpRoot: root }), /getOutputDir/);
    const blocker = path.join(freshDir('blocker'), 'file');
    fs.writeFileSync(blocker, 'x');
    const { manager } = createManager({ outputDir: path.join(blocker, 'under-a-file') });
    await assert.rejects(manager.reserve({}), (err) => err instanceof JobError && err.status === 500 && /输出目录不可用/.test(err.message));
    assert.deepEqual(manager.stats(), { pending: 0, running: 0, records: 0 });
});

// ============================================================
// 清理与回收
// ============================================================

test('首次使用前清掉上次异常退出留下的临时目录', async () => {
    const tmpRoot = path.join(freshDir('stale'), 'uploads');
    const stale = path.join(tmpRoot, 'job-deadbeef', '上次的残留.docx');
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, 'secret');
    const { manager } = createManager({ tmpRoot });
    const reserved = await manager.reserve({});
    assert.equal(fs.existsSync(stale), false);
    assert.ok(fs.existsSync(path.dirname(reserved.uploadPath)));
    await manager.abort(reserved.id);
});

test('已结束的记录按存活时间回收，再按总数上限从最早结束的删起；未结束的任务从不回收', async () => {
    const clock = { value: 1_000_000 };
    const { manager, service } = createManager({ stub: { gate: true }, now: () => clock.value, limits: { ttlMs: 1000, maxRecords: 2, maxPending: 5 } });
    const first = await submit(manager);
    await until(() => service.calls.length === 1, '甲开始');
    service.release();
    await finished(manager, first.id);

    clock.value += 500;
    assert.ok(manager.get(first.id), '未过存活时间');
    clock.value += 600;
    assert.equal(manager.get(first.id), null, '超过存活时间即回收');

    const ids = [];
    for (let i = 0; i < 3; i += 1) {
        clock.value += 10;
        const { id } = await submit(manager);
        await until(() => service.calls.length === ids.length + 2, '任务开始');
        service.release();
        await finished(manager, id);
        ids.push(id);
    }
    const running = await submit(manager);
    await until(() => (manager.get(running.id) || {}).status === 'running', '最后一个任务运行中');
    assert.equal(manager.get(ids[0]), null, '超出总数上限，最早结束的先被回收');
    assert.equal(manager.get(ids[1]), null);
    assert.ok(manager.get(ids[2]));
    assert.equal(manager.get(running.id).status, 'running', '运行中的任务不回收');
    service.release();
    await finished(manager, running.id);
});

test('uploading 超时被回收：名额、记录与临时目录一并释放；未到时限的上传不受影响；迟到的 commit 得 404', async () => {
    const clock = { value: 5_000_000 };
    const { manager, logs } = createManager({ now: () => clock.value, limits: { maxPending: 1, uploadTimeoutMs: 1000 } });
    const stale = await manager.reserve({ fileName: '机密案件.docx' });
    fs.writeFileSync(stale.uploadPath, DOCX_BYTES);
    assert.deepEqual(manager.stats(), { pending: 1, running: 0, records: 1 });

    clock.value += 900;
    await assert.rejects(manager.reserve({}), (err) => err.code === 'queue-full', '未到时限：仍占着名额');
    assert.ok(fs.existsSync(stale.uploadPath), '未到时限的上传不受影响');

    clock.value += 200;
    const next = await manager.reserve({});
    assert.notEqual(next.id, stale.id, '过了时限：下一次 reserve 先回收再受理，不必重启应用');
    await until(() => !fs.existsSync(path.dirname(stale.uploadPath)), '被遗弃的上传的临时目录被删');
    assert.deepEqual(manager.stats(), { pending: 1, running: 0, records: 1 }, '只剩新任务');
    assert.throws(() => manager.commit(stale.id), (err) => err instanceof JobError && err.status === 404, '被回收之后才收完的上传不能再入队');
    await manager.abort(stale.id);
    const line = logs.find((item) => item.includes(stale.id));
    assert.equal(line, `[addin] 任务 ${stale.id} 上传超时未完成，已回收`);
    assert.ok(logs.every((item) => !item.includes('机密案件')), '日志不含文件名');

    // get 也是回收点：轮询别的任务同样会顺带清掉被遗弃的上传
    clock.value += 1100;
    assert.equal(manager.get(next.id), null, 'uploading 的任务不对外可见');
    assert.deepEqual(manager.stats(), { pending: 0, running: 0, records: 0 });
    assert.equal(DEFAULT_LIMITS.uploadTimeoutMs, 10 * 60 * 1000, '缺省 10 分钟：容得下 200 MB 的本机回环上传，也长于服务层 5 分钟的整请求时限');
});

test('reserve 的准备阶段遇上 dispose：不交出无主的上传路径，也不留临时目录', async () => {
    const { manager, tmpRoot } = createManager();
    const pending = manager.reserve({ fileName: '准备中.docx' });
    const disposing = manager.dispose();
    await assert.rejects(pending, (err) => err instanceof JobError && err.status === 503);
    await disposing;
    assert.deepEqual(manager.stats(), { pending: 0, running: 0, records: 0 });
    assert.deepEqual(fs.existsSync(tmpRoot) ? fs.readdirSync(tmpRoot) : [], []);
});

test('dispose：不再受理；排队中的任务标为失败、上传中的任务中止；临时根目录清空', async () => {
    const { manager, service, tmpRoot } = createManager({ stub: { gate: true } });
    const running = await submit(manager);
    const queued = await submit(manager);
    const uploading = await manager.reserve({});
    await until(() => service.calls.length === 1, '第一个任务开始');

    const disposing = manager.dispose();
    await tick();
    service.release();
    await disposing;
    await finished(manager, running.id);

    assert.equal(manager.get(queued.id).status, 'failed');
    assert.match(manager.get(queued.id).error.message, /已停止/);
    assert.equal(manager.get(uploading.id), null);
    assert.equal(service.calls.length, 1, '排队中的任务没有被执行');
    await assert.rejects(manager.reserve({}), (err) => err instanceof JobError && err.status === 503);
    assert.throws(() => manager.commit(uploading.id), JobError);
    for (const item of [running, queued, uploading]) assert.equal(fs.existsSync(path.dirname(item.uploadPath)), false);

    const idle = createManager();
    await idle.manager.reserve({});
    await idle.manager.dispose();
    assert.equal(fs.existsSync(idle.tmpRoot), false, '没有任务在跑时连根目录一并删除');
    assert.ok(tmpRoot.length > 0);
});
