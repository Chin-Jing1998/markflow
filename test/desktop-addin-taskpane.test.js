/**
 * office-addin/taskpane/taskpane.js 单元与集成测试（不经 Word：Office 以桩替代，页面用 linkedom 解析真实的 taskpane.html，
 * 请求打到监听临时端口的真实回环服务，转换内核以桩替代）
 * 覆盖：纯函数（告警分组、文件名、体积、DTD 校验摘要、进度文案）；
 *       分片取文件——按微软文档以 Compressed + 4194304 调用、多片按序拼接、成功 / 读片失败 / 超限三条路径都恰好 closeAsync 一次；
 *       客户端请求头（令牌、写操作的自定义头、百分号编码的文件名与源路径）与错误映射；轮询的容错、失败与超时；
 *       整页流程：探活 → 转换 → 结果区（发明名称、阻断项置顶、各书、分组告警、产物路径）→ 在访达中显示 / 预览；
 *       错误态：不在 Word 中、服务未启动（可重试）、版本不符、页面无令牌、令牌失效、文档超限、取文件失败、转换失败、服务端 413；
 *       文档正文不出现在页面上；Office 主题的深浅色。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('linkedom');

const pane = require('../office-addin/taskpane/taskpane.js');
const { createJobManager } = require('../desktop/main/addin/jobs');
const { createAddinServer } = require('../desktop/main/addin/server');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'addin-taskpane-'));
const STATIC_DIR = path.join(__dirname, '..', 'office-addin', 'taskpane');
const BODY_MARKER = 'SECRET-BODY-TEXT-7f3a';
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`${BODY_MARKER} 这是文档正文，不得出现在页面上`.repeat(3))]);
const cleanups = [];
after(async () => {
    for (const cleanup of cleanups) await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
});

let seq = 0;
const freshDir = (label) => {
    seq += 1;
    const dir = path.join(root, `${label}-${seq}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};
async function until(predicate, label) {
    for (let i = 0; i < 600; i += 1) {
        if (await predicate()) return;
        await new Promise((resolve) => { setTimeout(resolve, 5); });
    }
    throw new Error(`等待超时：${label}`);
}

// ============================================================
// 桩：Office、转换内核、服务
// ============================================================

/** 与 Office.js 同形的最小桩；内部按 10 字节切片以走到多片路径，data 为 number[]（官方文档：Compressed 的分片是字节数组） */
function fakeOffice({ host = 'Word', url = '', bytes = DOCX, failSliceAt = -1, getFileError = null, isDarkTheme } = {}) {
    const stats = { getFile: [], slices: [], closed: 0 };
    const SLICE = 10;
    const file = {
        size: bytes.length,
        sliceCount: Math.ceil(bytes.length / SLICE),
        getSliceAsync(index, callback) {
            stats.slices.push(index);
            setImmediate(() => {
                if (index === failSliceAt) callback({ status: 'failed', error: { message: '内部错误' } });
                else callback({ status: 'succeeded', value: { index, size: SLICE, data: [...bytes.subarray(index * SLICE, (index + 1) * SLICE)] } });
            });
        },
        closeAsync() { stats.closed += 1; },
    };
    return {
        stats,
        HostType: { Word: 'Word' },
        FileType: { Compressed: 'compressed' },
        AsyncResultStatus: { Succeeded: 'succeeded', Failed: 'failed' },
        context: {
            officeTheme: isDarkTheme === undefined ? undefined : { isDarkTheme },
            document: {
                url,
                getFileAsync(fileType, options, callback) {
                    stats.getFile.push({ fileType, options });
                    setImmediate(() => callback(getFileError ? { status: 'failed', error: { message: getFileError } } : { status: 'succeeded', value: file }));
                },
            },
        },
        onReady: (callback) => Promise.resolve().then(() => callback({ host, platform: host ? 'Mac' : null })),
    };
}

function createStubService({ fail = false } = {}) {
    const service = {
        started: 0, received: [],
        planTasks: (raws, target) => raws.map((raw) => ({ raw, input: { path: raw }, target })),
        buildOptions: (flat) => flat,
        runConversion: async ({ tasks, outputDir, onEvent }) => {
            service.started += 1;
            service.received.push(fs.readFileSync(tasks[0].input.path));
            onEvent({ type: 'progress', idx: 0, phase: 'rendering', pct: 60 });
            if (fail) return { ok: false, results: [], errors: [{ error: '文档没有可识别的内容' }] };
            const dir = path.join(outputDir, path.basename(tasks[0].input.path, '.docx'));
            fs.mkdirSync(dir, { recursive: true });
            const outputs = { claims: path.join(dir, 'c.xml'), description: path.join(dir, 'd.xml'), precheck: path.join(dir, 'precheck.json') };
            fs.writeFileSync(outputs.claims, '<x/>');
            fs.writeFileSync(outputs.description, '<x/>');
            const blocking = ['预检：文档含修订标记，官方工具会拒绝转换'];
            fs.writeFileSync(outputs.precheck, JSON.stringify({ source: tasks[0].input.path, blocking, validation: { requested: true, engine: 'libxml2-wasm', files: [{ file: 'claims.xml', valid: true, errors: [] }, { file: 'description.xml', valid: true, errors: [] }] } }));
            const warnings = [...blocking, '分节：未识别到说明书摘要', '分节：未识别到说明书附图', '附图：图 2 缺少图片', '来自别处的告警'];
            return { ok: true, results: [{ title: '一种<b>测试</b>装置', outputPath: dir, outputs, warnings }], errors: [] };
        },
    };
    return service;
}

async function startBackend(overrides = {}) {
    const service = overrides.service || createStubService(overrides.stub);
    const outputDir = freshDir('out');
    const actionCalls = [];
    const jobs = createJobManager({ service, tmpRoot: path.join(freshDir('tmp'), 'uploads'), getOutputDir: () => outputDir });
    const server = createAddinServer({
        staticDir: STATIC_DIR, version: '9.8.7', jobs, port: 0,
        actions: { reveal: async (target) => actionCalls.push(['reveal', target]), preview: async (target) => actionCalls.push(['preview', target]) },
        ...(overrides.maxBodyBytes ? { maxBodyBytes: overrides.maxBodyBytes } : {}),
    });
    cleanups.push(async () => { await server.stop(); await jobs.dispose(); });
    const { port } = await server.start();
    const base = `http://127.0.0.1:${port}`;
    return { service, server, base, outputDir, actionCalls, html: await (await fetch(`${base}/taskpane.html`)).text() };
}

/** 解析页面并启动脚本；fetch 指向真实服务并记录每次请求，sleep 不真的等待 */
async function bootPage({ html, base, office, fetchImpl, mutate }) {
    const { document } = parseHTML(html);
    if (mutate) mutate(document);
    const requests = [];
    const realFetch = (target, init) => { requests.push({ target, init }); return fetch(`${base}${target}`, init); };
    await pane.boot(office, document, { fetchImpl: fetchImpl || realFetch, sleep: () => new Promise((resolve) => { setImmediate(resolve); }) });
    const $ = (id) => document.getElementById(id);
    const click = (node) => node.dispatchEvent(new document.defaultView.Event('click'));
    return { document, requests, $, click, settled: () => until(() => !$('result').hidden || !$('error').hidden, '页面出结果或报错') };
}

// ============================================================
// 纯函数
// ============================================================

test('groupWarnings：按前缀分组、保持既定顺序、未命中的归入「其他」、阻断项不重复列出', () => {
    const groups = pane.groupWarnings(['DTD 校验：d', '预检：a', '分节：b', '预检：c', '奇怪的告警', '栅格化：e', 42, '发明名称：f', '预检阻断：不算预检组'], ['预检：a']);
    assert.deepEqual(groups, [
        { name: '预检', items: ['c'] }, { name: '分节', items: ['b'] }, { name: '发明名称', items: ['f'] },
        { name: '栅格化', items: ['e'] }, { name: 'DTD 校验', items: ['d'] }, { name: '其他', items: ['奇怪的告警', '预检阻断：不算预检组'] },
    ]);
    assert.deepEqual(pane.groupWarnings(undefined, undefined), []);
});

test('displayNameOf / formatSize / describeValidation / describeProgress', () => {
    assert.equal(pane.displayNameOf('/Users/x/案件 A/100%25 增长-申请.docx'), '100%25 增长-申请.docx', '本地路径里的 % 原样保留');
    assert.equal(pane.displayNameOf('https://contoso.sharepoint.com/a/%E4%BA%91%E7%AB%AF.docx?web=1'), '云端.docx');
    assert.equal(pane.displayNameOf('https://x.example/%E0%A4%A.docx'), '%E0%A4%A.docx', '畸形编码不抛出');
    for (const empty of ['', '   ', null, undefined, '/']) assert.equal(pane.displayNameOf(empty), '未保存的文档');
    assert.deepEqual([pane.formatSize(1), pane.formatSize(13594), pane.formatSize(2779817)], ['1 KB', '14 KB', '2.7 MB']);

    assert.deepEqual(pane.describeValidation(null), { text: 'DTD 校验：未执行', ok: false });
    assert.deepEqual(pane.describeValidation({ requested: true, engine: null, files: [] }), { text: 'DTD 校验：校验器不可用，已跳过（详见告警）', ok: false });
    assert.deepEqual(pane.describeValidation({ requested: true, engine: 'x', files: [{ file: 'a.xml', valid: true }, { file: 'b.xml', valid: true }] }), { text: 'DTD 校验：2 份全部通过', ok: true });
    assert.deepEqual(pane.describeValidation({ requested: true, engine: 'x', files: [{ file: 'a.xml', valid: true }, { file: 'b.xml', valid: false }] }), { text: 'DTD 校验：1 份未通过（b.xml）', ok: false });

    assert.deepEqual(pane.describeProgress({ status: 'queued', position: 3 }), { label: '排队中（前面还有 2 个任务）', value: 0 });
    assert.deepEqual(pane.describeProgress({ status: 'queued', position: 1 }), { label: '排队中，即将开始', value: 0 });
    assert.deepEqual(pane.describeProgress({ status: 'running', phase: 'rendering', pct: 60 }), { label: '正在生成五书 XML', value: 60 });
    assert.deepEqual(pane.describeProgress({ status: 'running', phase: '未知阶段' }), { label: '正在转换', value: 0 });
});

// ============================================================
// 分片取文件
// ============================================================

test('readDocument：按文档要求调用 getFileAsync，多片按序拼接，用完恰好 closeAsync 一次', async () => {
    const office = fakeOffice();
    const progress = [];
    const bytes = await pane.readDocument(office, { maxBytes: Infinity, onProgress: (done, total) => progress.push([done, total]) });
    assert.ok(Buffer.from(bytes).equals(DOCX), '拼出的字节与原文档逐字节一致');
    assert.deepEqual(office.stats.getFile, [{ fileType: 'compressed', options: { sliceSize: 4194304 } }]);
    assert.equal(pane.SLICE_SIZE, 4194304, '非 iPad 的分片上限，超出会报 Internal Error');
    const total = Math.ceil(DOCX.length / 10);
    assert.deepEqual(office.stats.slices, Array.from({ length: total }, (unused, index) => index), '逐片按序取');
    assert.deepEqual(progress[progress.length - 1], [total, total]);
    assert.equal(office.stats.closed, 1);
});

test('readDocument：取文件失败、读片失败、超限三条路径——有文件对象就必须关闭且只关一次', async () => {
    const noFile = fakeOffice({ getFileError: '文档正忙' });
    await assert.rejects(pane.readDocument(noFile, { maxBytes: Infinity, onProgress() {} }), (err) => err.code === 'read-failed' && /读取文档失败：文档正忙/.test(err.message));
    assert.equal(noFile.stats.closed, 0, '没拿到文件对象，无可关闭');

    const broken = fakeOffice({ failSliceAt: 2 });
    await assert.rejects(pane.readDocument(broken, { maxBytes: Infinity, onProgress() {} }), (err) => err.code === 'read-failed' && /第 3 片失败：内部错误/.test(err.message));
    assert.deepEqual([broken.stats.closed, broken.stats.slices], [1, [0, 1, 2]], '失败后不再继续取片');

    const huge = fakeOffice();
    await assert.rejects(pane.readDocument(huge, { maxBytes: 16, onProgress() {} }), (err) => err.code === 'too-large' && /超过上限/.test(err.message));
    assert.deepEqual([huge.stats.closed, huge.stats.slices], [1, []], '超限时一片都不取');

    const empty = fakeOffice({ bytes: Buffer.alloc(0) });
    assert.equal((await pane.readDocument(empty, { maxBytes: Infinity, onProgress() {} })).length, 0);
    assert.equal(empty.stats.closed, 1);
});

// ============================================================
// 客户端与轮询
// ============================================================

test('createClient：令牌随每个请求；自定义头只在写操作上；文件名与源路径经百分号编码；错误映射', async () => {
    const seen = [];
    const reply = (status, payload) => ({ ok: status >= 200 && status < 300, status, json: async () => payload });
    let next = () => reply(200, { ok: true, data: { fine: true } });
    const client = pane.createClient({ token: 'TKN', fetchImpl: async (target, init) => { seen.push({ target, init }); return next(); } });

    assert.deepEqual(await client.getJob('abc'), { fine: true });
    await client.createJob(new Uint8Array([1, 2]), { fileName: '申请 文件.docx', sourcePath: '/Users/张三/案件/申请 文件.docx' });
    await client.reveal('abc');
    await client.preview('abc', 'claims');
    await client.preview('abc', null);
    assert.deepEqual(seen.map((item) => [item.init.method, item.target]), [['GET', '/v1/jobs/abc'], ['POST', '/v1/jobs'], ['POST', '/v1/jobs/abc/reveal'], ['POST', '/v1/jobs/abc/preview'], ['POST', '/v1/jobs/abc/preview']]);
    for (const item of seen) {
        assert.equal(item.init.headers['X-MarkFlow-Token'], 'TKN');
        assert.equal(item.init.cache, 'no-store');
        assert.equal(item.init.headers['X-MarkFlow-Client'], item.init.method === 'GET' ? undefined : 'word-taskpane');
        assert.ok(!item.target.includes('TKN'), '令牌不进 URL');
    }
    const upload = seen[1].init;
    assert.equal(upload.headers['Content-Type'], 'application/octet-stream');
    assert.equal(upload.headers['X-MarkFlow-File-Name'], encodeURIComponent('申请 文件.docx'));
    assert.equal(upload.headers['X-MarkFlow-Source-Path'], encodeURIComponent('/Users/张三/案件/申请 文件.docx'));
    assert.match(upload.headers['X-MarkFlow-Source-Path'], /^[\x21-\x7e]+$/, '请求头里只有可见 ASCII');
    assert.deepEqual([seen[3].init.body, seen[4].init.body], ['{"part":"claims"}', '{}']);

    next = () => reply(401, { ok: false, error: { code: 'unauthorized', message: '…' } });
    await assert.rejects(client.health(), (err) => err.code === 'unauthorized' && err.message === pane.MESSAGES.unauthorized);
    next = () => reply(413, { ok: false, error: { code: 'payload-too-large', message: '文档超过大小上限（200 MB）' } });
    await assert.rejects(client.health(), (err) => err.code === 'payload-too-large' && err.message === '文档超过大小上限（200 MB）');
    next = () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } });
    await assert.rejects(client.health(), (err) => err.code === 'http-502');
    next = () => { throw new TypeError('Load failed'); };
    await assert.rejects(client.health(), (err) => err.code === 'service-down' && err.message === pane.MESSAGES.serviceDown);
});

test('waitForJob：偶发断连可容忍，连续 5 次判为失联；任务失败与超时各有明确文案', async () => {
    const sleep = () => Promise.resolve();
    const down = () => { throw new pane.PaneError('service-down', 'x'); };
    const script = (steps) => { let index = 0; return { getJob: async () => { const step = steps[Math.min(index, steps.length - 1)]; index += 1; return typeof step === 'function' ? step() : step; } }; };
    const updates = [];
    const done = await pane.waitForJob(script([{ status: 'queued', position: 1 }, down, down, { status: 'running', phase: 'parsing', pct: 20 }, { status: 'succeeded', id: 'j' }]), 'j', { sleep, now: () => 0, onUpdate: (job) => updates.push(job.status) });
    assert.equal(done.status, 'succeeded');
    assert.deepEqual(updates, ['queued', 'running', 'succeeded']);

    await assert.rejects(pane.waitForJob(script([down]), 'j', { sleep, now: () => 0, onUpdate() {} }), (err) => err.code === 'lost-contact');
    await assert.rejects(pane.waitForJob(script([{ status: 'failed', error: { message: '文档已损坏' } }]), 'j', { sleep, now: () => 0, onUpdate() {} }), (err) => err.code === 'convert-failed' && err.message === '转换失败：文档已损坏');
    await assert.rejects(pane.waitForJob(script([() => { throw new pane.PaneError('unauthorized', 'u'); }]), 'j', { sleep, now: () => 0, onUpdate() {} }), (err) => err.code === 'unauthorized', '令牌失效立即上抛，不重试');
    let clock = 0;
    await assert.rejects(pane.waitForJob(script([{ status: 'running' }]), 'j', { sleep, now: () => { clock += 20 * 60 * 1000; return clock; }, onUpdate() {} }), (err) => err.code === 'timeout');
});

// ============================================================
// 整页流程（真实页面 + 真实服务）
// ============================================================

test('探活 → 转换 → 结果区 → 在访达中显示 / 预览；文档正文不出现在页面上', async () => {
    const backend = await startBackend();
    const office = fakeOffice({ url: '/Users/someone/案件/一种测试装置-发明.docx', isDarkTheme: true });
    const page = await bootPage({ ...backend, office });

    assert.deepEqual([page.$('service-state').textContent, page.$('service-state').dataset.state], ['已连接 9.8.7', 'ok']);
    assert.equal(page.$('doc-name').textContent, '一种测试装置-发明.docx');
    assert.equal(page.$('convert').disabled, false);
    assert.equal(page.document.documentElement.dataset.theme, 'dark', '跟随 Office 主题');
    assert.equal(page.$('error').hidden, true);

    page.click(page.$('convert'));
    assert.equal(page.$('convert').disabled, true, '转换期间按钮禁用，防止重复提交');
    await page.settled();
    assert.equal(page.$('error').hidden, true, page.$('error-text').textContent);
    assert.equal(page.$('convert').disabled, false);
    assert.ok(backend.service.received[0].equals(DOCX), '服务端收到的字节与文档逐字节一致');
    assert.equal(office.stats.closed, 1);

    const cards = [...page.$('result').children];
    assert.deepEqual(cards.map((card) => card.querySelector('h2').textContent), [
        '发明名称', '预检阻断项（1）：官方转换器会因此拒绝转换，请先在文档中处理', '识别到的各书', '告警', '产物位置',
    ], '阻断项紧跟发明名称置顶');
    assert.equal(cards[0].querySelector('.title-value').textContent, '一种<b>测试</b>装置', '标题按纯文本显示');
    assert.equal(page.$('result').querySelector('b'), null, '来自转换结果的文字不会被当成 HTML 解析');
    assert.ok(cards[1].classList.contains('blocking'));
    assert.deepEqual([...cards[1].querySelectorAll('li')].map((li) => li.textContent), ['预检：文档含修订标记，官方工具会拒绝转换']);

    const parts = [...cards[2].querySelectorAll('.parts li')].map((li) => [li.firstChild.textContent, li.dataset.found]);
    assert.deepEqual(parts, [['说明书', 'true'], ['权利要求书', 'true'], ['说明书摘要', 'false'], ['说明书附图', 'false'], ['摘要附图', 'false']]);
    assert.equal(cards[2].querySelector('.ok-line').textContent, 'DTD 校验：2 份全部通过');
    const groups = [...cards[3].querySelectorAll('details.group')].map((group) => [group.querySelector('summary').textContent, [...group.querySelectorAll('li')].map((li) => li.textContent)]);
    assert.deepEqual(groups, [['分节（2）', ['未识别到说明书摘要', '未识别到说明书附图']], ['附图（1）', ['图 2 缺少图片']], ['其他（1）', ['来自别处的告警']]], '阻断项不在告警分组里重复出现');

    const outputPath = path.join(backend.outputDir, '一种测试装置-发明');
    assert.equal(cards[4].querySelector('.path-value').textContent, outputPath);
    assert.match(cards[4].querySelector('.note').textContent, /文档路径不可用/, '源文件不在本机该路径上：如实说明产物改存到了哪里');

    const [revealButton, previewButton] = [...cards[4].querySelectorAll('.actions button')];
    assert.deepEqual([revealButton.textContent, previewButton.textContent], ['在访达中显示', '在 MarkFlow 中预览']);
    page.click(revealButton);
    page.click(previewButton);
    page.click(cards[2].querySelectorAll('.parts button')[1]);
    await until(() => backend.actionCalls.length === 3, '三个动作到达服务端');
    assert.deepEqual(backend.actionCalls.map(([kind]) => kind).sort(), ['preview', 'preview', 'reveal']);
    assert.ok(backend.actionCalls.some(([kind, target]) => kind === 'reveal' && target === outputPath));
    assert.ok(backend.actionCalls.some(([kind, target]) => kind === 'preview' && target === path.join(outputPath, 'c.xml')), '点「权利要求书」一行的预览打开的是权利要求书');

    assert.ok(!page.document.documentElement.outerHTML.includes(BODY_MARKER), '文档正文不出现在页面上');
    const upload = page.requests.find((item) => item.target === '/v1/jobs');
    assert.equal(decodeURIComponent(upload.init.headers['X-MarkFlow-Source-Path']), '/Users/someone/案件/一种测试装置-发明.docx');
    assert.ok(page.requests.every((item) => !item.target.includes('?')), '请求地址不带查询串：文件名、路径与令牌都不进 URL');
});

test('未保存的文档：显示「未保存的文档」，源路径与文件名都传空，产物名用「未命名文档-时间戳」', async () => {
    const backend = await startBackend();
    const page = await bootPage({ ...backend, office: fakeOffice({ url: '' }) });
    assert.equal(page.$('doc-name').textContent, '未保存的文档');
    page.click(page.$('convert'));
    await page.settled();
    const upload = page.requests.find((item) => item.target === '/v1/jobs');
    assert.deepEqual([upload.init.headers['X-MarkFlow-File-Name'], upload.init.headers['X-MarkFlow-Source-Path']], ['', '']);
    assert.match(page.$('result').querySelector('.path-value').textContent, /未命名文档-\d{8}-\d{6}$/);
    assert.match(page.$('result').querySelector('.note').textContent, /尚未保存/);
    assert.equal(page.document.documentElement.dataset.theme, undefined, '取不到 Office 主题时沿用系统深浅色');
});

// ============================================================
// 错误态
// ============================================================

test('不在 Word 中：提示并保持按钮禁用，不发任何请求', async () => {
    const backend = await startBackend();
    const page = await bootPage({ ...backend, office: fakeOffice({ host: null }) });
    assert.equal(page.$('error-text').textContent, pane.MESSAGES.notWord);
    assert.deepEqual([page.$('convert').disabled, page.$('retry').hidden, page.$('service-state').textContent], [true, true, '不在 Word 中']);
    assert.deepEqual(page.requests, []);
});

test('服务未启动：给出排查指引与「重试连接」；服务恢复后重试即可用', async () => {
    const backend = await startBackend();
    let down = true;
    const fetchImpl = (target, init) => (down ? Promise.reject(new TypeError('Load failed')) : fetch(`${backend.base}${target}`, init));
    const page = await bootPage({ ...backend, office: fakeOffice(), fetchImpl });
    assert.equal(page.$('error-text').textContent, pane.MESSAGES.serviceDown);
    assert.deepEqual([page.$('convert').disabled, page.$('retry').hidden, page.$('service-state').dataset.state], [true, false, 'error']);
    down = false;
    page.click(page.$('retry'));
    await until(() => page.$('service-state').dataset.state === 'ok', '重试后连上');
    assert.deepEqual([page.$('convert').disabled, page.$('error').hidden], [false, true]);
});

test('版本不符、页面无令牌：提示重新打开任务窗格，按钮锁死且不提供重试', async () => {
    const backend = await startBackend();
    const stale = await bootPage({ ...backend, office: fakeOffice(), mutate: (doc) => doc.querySelector('meta[name="markflow-version"]').setAttribute('content', '1.0.0') });
    assert.match(stale.$('error-text').textContent, /MarkFlow 已更新（页面 1\.0\.0，服务 9\.8\.7）。请关闭本任务窗格后重新打开/);
    assert.deepEqual([stale.$('convert').disabled, stale.$('retry').hidden], [true, true]);

    const rawTemplate = fs.readFileSync(path.join(STATIC_DIR, 'taskpane.html'), 'utf8');
    const broken = await bootPage({ ...backend, html: rawTemplate, office: fakeOffice() });
    assert.equal(broken.$('error-text').textContent, pane.MESSAGES.pageBroken, '占位符未被替换（页面不是由 MarkFlow 提供）时不把占位符当令牌用');
    assert.equal(broken.$('convert').disabled, true);
    assert.deepEqual(broken.requests, []);
});

test('令牌失效（MarkFlow 重启过）：上传回 401，提示重新打开任务窗格并锁死按钮', async () => {
    const backend = await startBackend();
    const page = await bootPage({ ...backend, office: fakeOffice(), mutate: (doc) => doc.querySelector('meta[name="markflow-token"]').setAttribute('content', 'stale-token-from-last-run') });
    assert.equal(page.$('convert').disabled, false, '探活免令牌，此时还看不出令牌已失效');
    page.click(page.$('convert'));
    await page.settled();
    assert.equal(page.$('error-text').textContent, pane.MESSAGES.unauthorized);
    assert.deepEqual([page.$('convert').disabled, page.$('retry').hidden, backend.service.started], [true, true, 0]);
});

test('文档超限：页面先按注入的上限拦下，不上传；绕过页面检查时服务端回 413 并原样提示', async () => {
    const backend = await startBackend({ maxBodyBytes: 64 });
    const office = fakeOffice();
    const page = await bootPage({ ...backend, office });
    page.click(page.$('convert'));
    await page.settled();
    assert.match(page.$('error-text').textContent, /超过上限.*无法转换/);
    assert.deepEqual([office.stats.closed, office.stats.slices.length, page.requests.filter((item) => item.target === '/v1/jobs').length], [1, 0, 0]);
    assert.equal(page.$('convert').disabled, false, '换一份文档可以再试');

    const bypass = await bootPage({ ...backend, office: fakeOffice(), mutate: (doc) => doc.querySelector('meta[name="markflow-max-bytes"]').setAttribute('content', '999999999') });
    bypass.click(bypass.$('convert'));
    await bypass.settled();
    assert.match(bypass.$('error-text').textContent, /文档超过大小上限/);
    assert.equal(backend.service.started, 0);
});

test('取文件失败与转换失败：如实显示原因，按钮恢复可用', async () => {
    const backend = await startBackend({ stub: { fail: true } });
    const unreadable = await bootPage({ ...backend, office: fakeOffice({ getFileError: '文档处于受保护视图' }) });
    unreadable.click(unreadable.$('convert'));
    await unreadable.settled();
    assert.equal(unreadable.$('error-text').textContent, '读取文档失败：文档处于受保护视图');
    assert.equal(unreadable.$('convert').disabled, false);

    const failing = await bootPage({ ...backend, office: fakeOffice() });
    failing.click(failing.$('convert'));
    await failing.settled();
    assert.equal(failing.$('error-text').textContent, '转换失败：文档没有可识别的内容');
    assert.deepEqual([failing.$('result').hidden, failing.$('progress').hidden, failing.$('convert').disabled], [true, true, false]);
});
