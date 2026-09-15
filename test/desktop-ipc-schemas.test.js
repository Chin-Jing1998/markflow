/**
 * desktop/main/ipc.js 单元测试（纯逻辑，Electron 以桩替代）
 * 覆盖：各通道 zod schema 拒绝畸形入参（缺字段、多余键、越界值、非 http(s) 外链、渲染进程注入 mineruToken）；
 *       转换批次：令牌只注入主进程 options 而不进事件、事件顺序 queued → running → done → finished、
 *       文件库 upsert 与 libraryId 回传、取消跳过未开始任务；testMineru 的鉴权失败 / 网络 / 正常三态且回包不含令牌；
 *       阶段 5 桩通道与文件库未就绪的中文错误；主题切换回调。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ipc = require('../desktop/main/ipc');
const { createSettingsStore } = require('../desktop/main/settings');
const scan = require('../desktop/main/scan');
const realService = require('../converters/service');

const { CHANNELS, SCHEMAS, validatePayload, createIpcHandlers, pickTarget, stripToken } = ipc;

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'ipc-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const SAMPLE_MD = path.join(__dirname, 'fixtures', 'sample.md');
const TOKEN = 'secret-token-xyz-987';

const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`enc:${text}`),
    decryptString: (buffer) => Buffer.from(buffer).toString('utf8').slice(4),
};

// ============================================================
// schema
// ============================================================

test('所有 §3.3.5 通道均有 schema，未知通道拒绝', () => {
    const expected = [
        'mf:formats:describe', 'mf:dialog:pickFiles', 'mf:dialog:pickDirectory', 'mf:paths:expand',
        'mf:convert:run', 'mf:convert:cancel',
        'mf:preview:open', 'mf:preview:render', 'mf:preview:export', 'mf:preview:close', 'mf:reader:open',
        'mf:md:render', 'mf:md:save', 'mf:md:insertImage',
        'mf:library:list', 'mf:library:update', 'mf:library:remove', 'mf:library:reveal', 'mf:library:open', 'mf:library:reconvert', 'mf:library:migrate',
        'mf:settings:get', 'mf:settings:set', 'mf:settings:setMineruToken', 'mf:settings:testMineru',
        'mf:theme:get', 'mf:theme:set', 'mf:shell:openExternal', 'mf:file:action',
    ];
    for (const channel of expected) assert.ok(SCHEMAS[channel], `缺少 schema：${channel}`);
    assert.equal(Object.keys(SCHEMAS).length, expected.length);
    assert.equal(expected.length, 29, '通道总数为 29');
    assert.ok(!SCHEMAS['mf:library:relocate'], 'relocate 不暴露为 IPC 通道');
    assert.throws(() => validatePayload('mf:library:relocate', {}), /未知的 IPC 通道/);
    assert.equal(CHANNELS.convertEvent, 'mf:convert:event');
    assert.equal(CHANNELS.themeChanged, 'mf:theme:changed');
    assert.equal(CHANNELS.previewEvent, 'mf:preview:event');
    assert.ok(!SCHEMAS[CHANNELS.previewEvent], '推送通道不需要入参 schema');
});

const REJECTS = [
    ['mf:paths:expand', undefined, '缺 paths'],
    ['mf:paths:expand', { paths: 'x' }, 'paths 非数组'],
    ['mf:paths:expand', { paths: [''] }, '空路径'],
    ['mf:paths:expand', { paths: ['/a'], extra: 1 }, '多余键'],
    ['mf:convert:run', { items: [] }, '空 items'],
    ['mf:convert:run', { items: [{ path: '/a.md', url: 'https://x' }] }, 'path 与 url 同给'],
    ['mf:convert:run', { items: [{ target: 'docx' }] }, 'path 与 url 皆缺'],
    ['mf:convert:run', { items: [{ path: '/a.md', target: 'exe' }] }, '非法 target'],
    ['mf:convert:run', { items: [{ url: 'ftp://x/y' }] }, '非 http(s) 网址（ftp）'],
    ['mf:convert:run', { items: [{ url: 'file:///etc/passwd' }] }, '非 http(s) 网址（file）'],
    ['mf:convert:run', { items: [{ url: 'javascript:alert(1)' }] }, '非 http(s) 网址（javascript）'],
    ['mf:convert:run', { items: [{ url: 'https://example.com/a', path: '/a.md', target: 'html' }] }, 'url 与 path 同给（带 target）'],
    ['mf:convert:run', { items: [{ url: '' }] }, '空 url'],
    ['mf:convert:run', { items: [{ path: '/a.md' }], options: { mineruToken: 'x' } }, '渲染进程注入令牌'],
    ['mf:convert:run', { items: [{ path: '/a.md' }], options: { theme: 'neon' } }, '非法主题'],
    ['mf:convert:run', { items: [{ path: '/a.md' }], options: { jpegQuality: 10 } }, '越界数值'],
    ['mf:convert:run', { items: [{ path: '/a.md' }], options: { unknown: 1 } }, '未知选项'],
    ['mf:convert:run', { items: [{ path: '/a.md' }], options: { validate: 'yes' } }, 'validate 非布尔'],
    ['mf:preview:render', { sessionId: 's1', options: { validate: 1 } }, '预览 validate 非布尔'],
    ['mf:convert:run', { items: [{ path: '/a.md' }], outputDir: '' }, '空输出目录'],
    ['mf:convert:cancel', {}, '缺 runId'],
    ['mf:convert:cancel', { runId: 5 }, 'runId 非字符串'],
    ['mf:library:list', { facets: { color: 'red' } }, '未知分面'],
    ['mf:library:list', { facets: { favorite: 'yes' } }, 'favorite 非布尔'],
    ['mf:library:list', { limit: 0 }, 'limit 越界'],
    ['mf:library:list', { sort: 'size' }, '非法排序字段'],
    ['mf:library:update', { id: 'r1', patch: { outputPath: '/x' } }, 'patch 含不可改字段'],
    ['mf:library:update', { id: 'r1', patch: { tags: 'a,b' } }, 'tags 非数组'],
    ['mf:library:remove', { id: 'r1', trash: 'yes' }, 'trash 非布尔'],
    ['mf:library:reveal', {}, '缺 id'],
    ['mf:library:reconvert', { id: 'r1', target: 'zip' }, '非法 target'],
    ['mf:library:migrate', {}, '缺 dryRun'],
    ['mf:settings:set', { patch: { theme: 'blue' } }, '非法主题'],
    ['mf:settings:set', { patch: { defaults: { mineruToken: 'x' } } }, 'defaults 注入令牌'],
    ['mf:settings:set', { patch: { library: { mode: 'cloud' } } }, '非法文件库模式'],
    ['mf:settings:set', { theme: 'dark' }, '缺 patch 包装'],
    ['mf:settings:setMineruToken', { token: 123 }, 'token 非字符串'],
    ['mf:settings:setMineruToken', {}, '缺 token'],
    ['mf:settings:testMineru', { token: '' }, '空 token'],
    ['mf:theme:set', { theme: 'blue' }, '非法主题'],
    ['mf:shell:openExternal', { url: 'file:///etc/passwd' }, 'file 外链'],
    ['mf:shell:openExternal', { url: 'javascript:alert(1)' }, 'javascript 外链'],
    ['mf:shell:openExternal', { url: 'mailto:a@b.c' }, 'mailto 外链'],
    ['mf:formats:describe', { extra: true }, '多余键'],
    ['mf:md:render', {}, '缺 sessionId'],
    ['mf:md:render', { sessionId: '' }, '空 sessionId'],
    ['mf:md:render', { sessionId: 's1', extra: 1 }, '多余键'],
    ['mf:md:render', { sessionId: 's1', text: 5 }, 'text 非字符串'],
    ['mf:md:save', { sessionId: 's1' }, '缺 text'],
    ['mf:md:save', { text: 'x' }, '缺 sessionId'],
    ['mf:md:save', { sessionId: 's1', text: 'x', force: 'yes' }, 'force 非布尔'],
    ['mf:md:save', { sessionId: 's1', text: 'x', path: '/etc/passwd' }, '渲染层不得指定写入路径'],
    ['mf:md:insertImage', {}, '缺 sessionId'],
    ['mf:md:insertImage', { sessionId: 's1', path: '/x.png' }, '渲染层不得指定图片路径'],
    ['mf:paths:expand', { paths: ['/a'], scope: 'all' }, '非法 scope'],
    ['mf:dialog:pickFiles', { purpose: 'x' }, '非法 purpose'],
    ['mf:file:action', undefined, '缺入参'],
    ['mf:file:action', { action: 'reveal' }, '缺 sessionId'],
    ['mf:file:action', { sessionId: '', action: 'reveal' }, '空 sessionId'],
    ['mf:file:action', { sessionId: 'r1' }, '缺 action'],
    ['mf:file:action', { sessionId: 'r1', action: 'delete' }, '非法 action'],
    ['mf:file:action', { sessionId: 'r1', action: 'open', path: '/etc/passwd' }, '渲染层不得指定文件路径'],
];

for (const [channel, payload, label] of REJECTS) {
    test(`schema 拒绝：${channel}（${label}）`, () => {
        assert.throws(() => validatePayload(channel, payload), /参数不合法/);
    });
}

test('schema 放行合法入参并原样返回', () => {
    assert.equal(validatePayload('mf:formats:describe', undefined), undefined);
    assert.deepEqual(validatePayload('mf:paths:expand', { paths: ['/a', '/b'] }), { paths: ['/a', '/b'] });
    const run = validatePayload('mf:convert:run', { items: [{ id: 't1', path: '/a.md', target: 'docx' }, { url: 'https://example.com/x' }], options: { theme: 'github', jpegQuality: 80, jpegPpi: 420, landscape: true } });
    assert.equal(run.items.length, 2);
    assert.equal(run.options.jpegPpi, 420);
    assert.deepEqual(validatePayload('mf:convert:run', { items: [{ id: 'u1', url: 'HTTP://Example.com/页面?q=1', target: 'html' }] }).items, [{ id: 'u1', url: 'HTTP://Example.com/页面?q=1', target: 'html' }]);
    assert.deepEqual(validatePayload('mf:library:list', { query: 'x', facets: { favorite: true, tag: 't' }, limit: 10, offset: 0 }).facets, { favorite: true, tag: 't' });
    assert.deepEqual(validatePayload('mf:library:update', { id: 'r1', patch: { favorite: true, highlighted: true } }).patch, { favorite: true, highlighted: true });
    assert.deepEqual(validatePayload('mf:settings:setMineruToken', { token: null }), { token: null });
    assert.deepEqual(validatePayload('mf:settings:set', { patch: { defaults: { theme: null } } }), { patch: { defaults: { theme: null } } });
    assert.deepEqual(validatePayload('mf:settings:set', { patch: { library: { repositories: ['/vault-a', '/vault-b'], activeRepository: '/vault-b' } } }).patch.library, { repositories: ['/vault-a', '/vault-b'], activeRepository: '/vault-b' });
    assert.deepEqual(validatePayload('mf:shell:openExternal', { url: 'HTTPS://example.com/a?b=1' }), { url: 'HTTPS://example.com/a?b=1' });
    assert.deepEqual(validatePayload('mf:library:migrate', { dryRun: true }), { dryRun: true });
    // validate：专利 XML 的 DTD 校验开关，转换与预览两条通道共用同一套扁平选项
    assert.deepEqual(validatePayload('mf:convert:run', { items: [{ path: '/a.docx', target: 'xml' }], options: { xmlProfile: 'patent', validate: true } }).options, { xmlProfile: 'patent', validate: true });
    assert.deepEqual(validatePayload('mf:preview:render', { sessionId: 's1', options: { validate: false } }).options, { validate: false });
    // Markdown 编辑：只收 sessionId（与文本、force），写入路径一律由主进程按会话取
    assert.deepEqual(validatePayload('mf:md:render', { sessionId: 'reader-1' }), { sessionId: 'reader-1' });
    assert.deepEqual(validatePayload('mf:md:render', { sessionId: 'reader-1', text: '# 标题\n' }), { sessionId: 'reader-1', text: '# 标题\n' });
    assert.deepEqual(validatePayload('mf:md:save', { sessionId: 'p1', text: '', force: true }), { sessionId: 'p1', text: '', force: true });
    assert.deepEqual(validatePayload('mf:md:insertImage', { sessionId: 'p1' }), { sessionId: 'p1' });
    assert.deepEqual(validatePayload('mf:paths:expand', { paths: ['/a'], scope: 'browse' }), { paths: ['/a'], scope: 'browse' });
    assert.deepEqual(validatePayload('mf:paths:expand', { paths: ['/a'], scope: 'convert' }), { paths: ['/a'], scope: 'convert' });
    assert.deepEqual(validatePayload('mf:dialog:pickFiles', { purpose: 'read' }), { purpose: 'read' });
    assert.deepEqual(validatePayload('mf:dialog:pickFiles', { directory: true, purpose: 'convert' }), { directory: true, purpose: 'convert' });
});

test('validate 经 service.buildOptions 映射到 xml.validate', () => {
    assert.equal(realService.buildOptions({ validate: true }).xml.validate, true);
    assert.equal(realService.buildOptions({ validate: false }).xml.validate, false);
    assert.equal(realService.buildOptions({}).xml.validate, false, '默认不做 DTD 校验');
});

test('pickTarget 与 stripToken', () => {
    assert.equal(pickTarget('docx', 'html', {}), 'html', '显式目标优先');
    assert.equal(pickTarget('docx', undefined, { office: 'xml' }), 'xml');
    assert.equal(pickTarget('docx', undefined, { office: 'docx' }), 'bundle', '不兼容的设置回退默认');
    assert.equal(pickTarget('md', undefined, {}), 'docx');
    assert.deepEqual(stripToken({ imageFormat: 'jpg', mineru: { token: 'x', model: 'vlm' } }), { imageFormat: 'jpg', mineru: { model: 'vlm' } });
    assert.deepEqual(stripToken(null), {});
});

// ============================================================
// 处理器
// ============================================================

function makeHarness({ library = 'default', runDelayMs = 5, preview = null, reader = null, dialog = {}, scanModule = scan } = {}) {
    const dir = fs.mkdtempSync(path.join(root, 'h-'));
    const settings = createSettingsStore({ dir, safeStorage: fakeSafeStorage, defaults: { outputDir: path.join(dir, 'out'), libraryRoot: path.join(dir, 'lib') } });
    settings.load();
    const seenOptions = [];
    const seenTasks = [];
    const seenAllowPrivate = [];
    const upserts = [];
    const service = {
        ...realService,
        describeFormats: async () => ({ targets: { office: ['bundle'], markup: ['docx'], url: ['bundle'] }, capabilities: {}, version: 'test' }),
        runConversion: async ({ tasks, outputDir, options, onEvent, allowPrivateNetwork }) => {
            seenOptions.push(options);
            seenTasks.push(tasks[0]);
            seenAllowPrivate.push(allowPrivateNetwork);
            onEvent({ type: 'progress', idx: 0, phase: 'parsing', pct: 30 });
            await new Promise((resolve) => setTimeout(resolve, runDelayMs));
            const task = tasks[0];
            if (task.raw.endsWith('fail.md')) return { ok: false, outputDir, results: [], errors: [{ input: task.raw, error: '模拟失败' }] };
            const outputPath = path.join(outputDir, `${path.basename(task.raw, path.extname(task.raw))}.${task.target}`);
            return {
                ok: true, outputDir,
                results: [{ input: task.raw, target: task.target, name: 'sample', title: 'Sample', sourceType: 'md', outputPath, outputs: { [task.target]: outputPath }, imagesCount: 0, warnings: [], options: { mineru: { token: null } }, extras: [], backends: { pdfParser: null, raster: null } }],
                errors: [],
            };
        },
    };
    const libraryStub = library === 'default' ? {
        upsertFromResult: async (result, opts) => { upserts.push({ result, opts }); return { id: `rec-${upserts.length}` }; },
        managedOutputDir: ({ root: base }) => path.join(base, '2026-09'),
        get: async () => null,
        list: async () => ({ items: [], total: 0, facets: {} }),
        update: async () => null,
        remove: async () => false,
        paths: async () => [],
    } : library;
    const opened = [];
    const applied = [];
    const electron = {
        dialog,
        shell: { openExternal: async (url) => { opened.push(url); }, showItemInFolder: () => undefined, openPath: async () => '', trashItem: async () => undefined },
        nativeTheme: { shouldUseDarkColors: false },
        BrowserWindow: { fromWebContents: () => null },
    };
    const { handlers, channels } = createIpcHandlers({ electron, settings, library: libraryStub, libraryMigrate: null, service, scan: scanModule, preview, reader, applyTheme: (theme) => applied.push(theme), log: () => undefined });
    const call = (channel, payload, event) => handlers[channel](event || makeEvent().event, validatePayload(channel, payload));
    return { dir, settings, handlers, channels, call, seenOptions, seenTasks, seenAllowPrivate, upserts, opened, applied };
}

function makeEvent() {
    const events = [];
    let resolveFinished;
    const finished = new Promise((resolve) => { resolveFinished = resolve; });
    const event = {
        sender: {
            isDestroyed: () => false,
            send: (channel, payload) => {
                assert.equal(channel, 'mf:convert:event');
                events.push(payload);
                if (payload.status === 'finished') resolveFinished(payload);
            },
        },
    };
    return { event, events, finished };
}

test('convert:run：令牌只注入主进程 options，事件不含令牌，顺序 queued → running → done → finished，写入文件库', async () => {
    const h = makeHarness();
    await h.settings.setMineruToken(TOKEN);
    const { event, events, finished } = makeEvent();
    const res = await h.call('mf:convert:run', { items: [{ id: 'a', path: SAMPLE_MD, target: 'docx' }], options: { theme: 'github' } }, event);
    assert.match(res.runId, /^run-/);
    assert.equal(res.outputDir, path.join(h.dir, 'out'));
    assert.ok(fs.existsSync(res.outputDir), '输出目录已创建');
    assert.deepEqual(res.tasks, [{ taskId: 'a', input: SAMPLE_MD, target: 'docx', type: 'md', name: 'sample.md' }]);
    const last = await finished;
    assert.deepEqual(last.summary, { total: 1, succeeded: 1, failed: 0, cancelled: 0 });

    const statuses = events.filter((item) => item.taskId === 'a').map((item) => item.status);
    assert.deepEqual(statuses, ['queued', 'running', 'running', 'done']);
    const progress = events.find((item) => item.taskId === 'a' && item.phase === 'parsing' && item.pct === 30);
    assert.ok(progress, '转发内核进度事件');
    const done = events.find((item) => item.status === 'done');
    assert.equal(done.libraryId, 'rec-1');
    assert.equal(done.result.outputPath, path.join(res.outputDir, 'sample.docx'));
    assert.ok(events.every((item) => item.runId === res.runId));
    assert.ok(!JSON.stringify(events).includes(TOKEN), '事件里不得出现令牌');

    assert.equal(h.seenOptions.length, 1);
    assert.equal(h.seenOptions[0].mineru.token, TOKEN, '令牌注入 options.mineru.token');
    assert.equal(h.seenOptions[0].html.theme, 'github');
    assert.equal(h.upserts.length, 1);
    assert.deepEqual(h.upserts[0].opts, { managed: false, outputDir: res.outputDir });
});

test('convert:run：设置里的默认项与默认目标生效，失败任务给出中文错误', async () => {
    const h = makeHarness();
    await h.settings.set({ defaults: { imageFormat: 'keep' }, defaultTargets: { markup: 'html' } });
    const failing = path.join(h.dir, 'fail.md');
    fs.writeFileSync(failing, '# x');
    const { event, events, finished } = makeEvent();
    const res = await h.call('mf:convert:run', { items: [{ path: SAMPLE_MD }, { path: failing }] }, event);
    assert.equal(res.tasks[0].target, 'html', 'settings.defaultTargets.markup 生效');
    assert.equal(res.tasks[0].taskId, 'task-1');
    const last = await finished;
    assert.deepEqual(last.summary, { total: 2, succeeded: 1, failed: 1, cancelled: 0 });
    const failed = events.find((item) => item.status === 'failed');
    assert.equal(failed.taskId, 'task-2');
    assert.equal(failed.error, '模拟失败');
    assert.equal(h.seenOptions[0].imageFormat, 'keep');
    assert.equal(h.seenOptions[0].mineru.token, null, '未配置令牌时不注入');
});

test('convert:run：url 项走 planTasks 的 { url } 输入，展示名为主机名，不经 paths:expand', async () => {
    const h = makeHarness();
    const { event, events, finished } = makeEvent();
    const res = await h.call('mf:convert:run', { items: [{ id: 'u1', url: 'https://example.com/article?id=1', target: 'html' }] }, event);
    assert.deepEqual(res.tasks, [{ taskId: 'u1', input: 'https://example.com/article?id=1', target: 'html', type: 'url', name: 'example.com' }]);
    const last = await finished;
    assert.deepEqual(last.summary, { total: 1, succeeded: 1, failed: 0, cancelled: 0 });
    assert.deepEqual(h.seenTasks[0].input, { url: 'https://example.com/article?id=1' });
    assert.equal(h.seenTasks[0].target, 'html');
    assert.equal(h.seenAllowPrivate.length, 1);
    assert.equal(h.seenAllowPrivate[0], undefined, '桌面端永不传 allowPrivateNetwork');
    await assert.rejects(h.call('mf:convert:run', { items: [{ url: 'https://example.com/a', target: 'docx' }] }), /不接受 url 输入/);
    assert.equal(events.filter((item) => item.status === 'done').length, 1);
});

test('convert:run：托管模式下输出目录取 library.managedOutputDir', async () => {
    const h = makeHarness();
    await h.settings.set({ library: { mode: 'managed' } });
    const { event, finished } = makeEvent();
    const res = await h.call('mf:convert:run', { items: [{ path: SAMPLE_MD }] }, event);
    assert.equal(res.outputDir, path.join(h.dir, 'lib', '2026-09'));
    await finished;
    assert.equal(h.upserts[0].opts.managed, true);
});

test('convert:cancel：未开始的任务标记 cancelled，进行中的任务跑完', async () => {
    const h = makeHarness({ runDelayMs: 40 });
    const { event, events, finished } = makeEvent();
    const res = await h.call('mf:convert:run', { items: [{ path: SAMPLE_MD }, { path: SAMPLE_MD }, { path: SAMPLE_MD }] }, event);
    assert.deepEqual(await h.call('mf:convert:cancel', { runId: res.runId }), { cancelled: true });
    const last = await finished;
    assert.deepEqual(last.summary, { total: 3, succeeded: 2, failed: 0, cancelled: 1 });
    assert.equal(events.filter((item) => item.status === 'cancelled').length, 1);
    assert.deepEqual(await h.call('mf:convert:cancel', { runId: res.runId }), { cancelled: false, reason: '批次不存在或已结束' });
});

test('convert:run：不支持的输入与不兼容的目标以中文错误拒绝', async () => {
    const h = makeHarness();
    await assert.rejects(h.call('mf:convert:run', { items: [{ path: '/tmp/x.exe' }] }), /不支持的输入格式/);
    await assert.rejects(h.call('mf:convert:run', { items: [{ path: SAMPLE_MD, target: 'bundle' }] }), /不接受 md 输入/);
});

test('settings：get 不含令牌；set 改主题触发 applyTheme；setMineruToken 回报 configured', async () => {
    const h = makeHarness();
    const before = await h.call('mf:settings:get', undefined);
    assert.equal(before.mineruTokenConfigured, false);
    const after1 = await h.call('mf:settings:set', { patch: { theme: 'dark', outputDir: path.join(h.dir, 'o2') } });
    assert.equal(after1.settings.theme, 'dark');
    assert.deepEqual(h.applied, ['dark']);
    await h.call('mf:settings:set', { patch: { outputDir: path.join(h.dir, 'o3') } });
    assert.deepEqual(h.applied, ['dark'], '主题未变不重复回调');
    assert.deepEqual(await h.call('mf:settings:setMineruToken', { token: TOKEN }), { configured: true });
    const described = await h.call('mf:settings:get', undefined);
    assert.equal(described.mineruTokenConfigured, true);
    assert.ok(!JSON.stringify(described).includes(TOKEN));
    assert.deepEqual(await h.call('mf:settings:setMineruToken', { token: null }), { configured: false });
});

test('testMineru：鉴权失败 / 网络错误 / 正常三态，回包不含令牌', async () => {
    const h = makeHarness();
    const originalFetch = globalThis.fetch;
    const calls = [];
    const respond = (status, body) => async (url, init) => {
        calls.push({ url, auth: init.headers.Authorization });
        return { ok: status >= 200 && status < 300, status, text: async () => body };
    };
    try {
        assert.deepEqual(await h.call('mf:settings:testMineru', undefined), { ok: false, status: 'not-configured', message: '尚未配置 MinerU 令牌' });
        await h.settings.setMineruToken(TOKEN);

        globalThis.fetch = respond(401, JSON.stringify({ code: 'A0202', msg: `token ${TOKEN} invalid` }));
        const auth = await h.call('mf:settings:testMineru', undefined);
        assert.equal(auth.ok, false);
        assert.equal(auth.status, 'auth-failed');
        assert.ok(!JSON.stringify(auth).includes(TOKEN));
        assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
        assert.match(calls[0].url, /\/extract-results\/batch\/markflow-probe$/);

        globalThis.fetch = async () => { const err = new TypeError('fetch failed'); err.cause = { code: 'ENOTFOUND' }; throw err; };
        const network = await h.call('mf:settings:testMineru', undefined);
        assert.equal(network.status, 'network');
        assert.match(network.message, /网络/);

        globalThis.fetch = respond(200, JSON.stringify({ code: -60012, msg: 'task not found' }));
        assert.deepEqual(await h.call('mf:settings:testMineru', undefined), { ok: true, status: 'ok', message: 'MinerU 令牌有效，连接正常' });

        globalThis.fetch = respond(500, `boom ${TOKEN}`);
        const other = await h.call('mf:settings:testMineru', { token: 'explicit-token' });
        assert.equal(other.status, 'error');
        assert.equal(calls[calls.length - 1].auth, 'Bearer explicit-token', '显式令牌优先于已存令牌');
        assert.ok(!JSON.stringify(other).includes(TOKEN) && !JSON.stringify(other).includes('explicit-token'));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('theme:set / shell:openExternal / formats:describe', async () => {
    const h = makeHarness();
    assert.deepEqual(await h.call('mf:theme:get', undefined), { theme: 'system', shouldUseDarkColors: false });
    assert.deepEqual(await h.call('mf:theme:set', { theme: 'light' }), { theme: 'light', shouldUseDarkColors: false });
    assert.deepEqual(h.applied, ['light']);
    assert.deepEqual(await h.call('mf:shell:openExternal', { url: 'https://example.com/' }), { ok: true });
    assert.deepEqual(h.opened, ['https://example.com/']);
    const formats = await h.call('mf:formats:describe', undefined);
    assert.equal(formats.library, true);
    assert.ok(formats.options && formats.options.pdfBackend);
    assert.deepEqual(formats.inProcess, { pdf: false, raster: false });
});

test('预览 / 阅读通道按会话分派，模块与文件库未就绪时给中文错误', async () => {
    const bare = makeHarness();
    for (const [channel, payload] of [
        ['mf:preview:open', { path: SAMPLE_MD }],
        ['mf:preview:render', { sessionId: 's1' }],
        ['mf:preview:export', { sessionId: 's1' }],
        ['mf:reader:open', { path: SAMPLE_MD }],
    ]) {
        await assert.rejects(bare.call(channel, payload), /预览与阅读模块未就绪/);
    }
    assert.deepEqual(await bare.call('mf:preview:close', { sessionId: 's1' }), { closed: false });

    const seen = [];
    const preview = {
        open: async (payload) => { seen.push(['open', payload]); return { sessionId: 'p1' }; },
        render: async (payload) => { seen.push(['render', payload]); return { sessionId: payload.sessionId }; },
        export: async (payload) => { seen.push(['export', payload]); return { outputPath: '/tmp/out' }; },
        close: async (payload) => ({ closed: payload.sessionId === 'p1' }),
    };
    const reader = {
        open: async (payload) => ({ sessionId: 'r1', path: payload.path }),
        close: async (payload) => ({ closed: payload.sessionId === 'r1' }),
    };
    const wired = makeHarness({ preview, reader });
    assert.deepEqual(await wired.call('mf:preview:open', { path: SAMPLE_MD }), { sessionId: 'p1' });
    // 目标由 pickTarget 裁决：md 输入未显式给出时落到 targets.js 的默认目标
    assert.deepEqual(seen[0][1], { path: SAMPLE_MD, type: 'md', target: 'docx', options: {} });
    await wired.call('mf:preview:open', { url: 'https://example.com/', target: 'html' });
    assert.deepEqual(seen[1][1], { url: 'https://example.com/', type: 'url', target: 'html', options: {} });
    assert.deepEqual(await wired.call('mf:reader:open', { path: SAMPLE_MD }), { sessionId: 'r1', path: SAMPLE_MD });
    // close 先问预览，未命中再问阅读
    assert.deepEqual(await wired.call('mf:preview:close', { sessionId: 'p1' }), { closed: true });
    assert.deepEqual(await wired.call('mf:preview:close', { sessionId: 'r1' }), { closed: true });
    assert.deepEqual(await wired.call('mf:preview:close', { sessionId: 'nope' }), { closed: false });

    const absent = makeHarness({ library: null });
    for (const [channel, payload] of [['mf:library:list', undefined], ['mf:library:reveal', { id: 'r1' }], ['mf:library:migrate', { dryRun: true }]]) {
        await assert.rejects(absent.call(channel, payload), /文件库模块未就绪/);
    }
    const formats = await absent.call('mf:formats:describe', undefined);
    assert.equal(formats.library, false);
});

test('registerIpc：逐通道注册并在处理前校验', async () => {
    const registered = new Map();
    const ipcMain = { handle: (channel, fn) => registered.set(channel, fn) };
    ipc.registerIpc(ipcMain, { 'mf:theme:set': async (event, payload) => payload.theme });
    assert.deepEqual([...registered.keys()], ['mf:theme:set']);
    assert.equal(await registered.get('mf:theme:set')({}, { theme: 'dark' }), 'dark');
    await assert.rejects(registered.get('mf:theme:set')({}, { theme: 'blue' }), /参数不合法/);
});

// ============================================================
// Markdown 编辑与文件库浏览
// ============================================================

const { BROWSE_EXTENSIONS, READER_EXTENSIONS } = require('../desktop/main/file-kinds');

function mdOwners() {
    const seen = [];
    const owner = (label, id) => ({
        sessions: new Map([[id, {}]]),
        renderMarkdown: async (payload) => { seen.push([label, 'render', payload]); return { html: `<p>${label}</p>` }; },
        saveMarkdown: async (payload) => { seen.push([label, 'save', payload]); return { saved: true }; },
        importImage: async (payload) => { seen.push([label, 'import', payload]); return { relPath: 'images/a.png', width: 10, height: 5, alt: 'a' }; },
        imageDialogDir: () => `/docs/${label}`,
        close: async () => ({ closed: false }),
    });
    return { seen, preview: owner('preview', 'p1'), reader: owner('reader', 'r1') };
}

test('md 通道按 sessionId 分派到预览或阅读会话，未知会话给中文错误', async () => {
    const { seen, preview, reader } = mdOwners();
    const h = makeHarness({ preview, reader });
    assert.deepEqual(await h.call('mf:md:render', { sessionId: 'p1', text: '# a' }), { html: '<p>preview</p>' });
    assert.deepEqual(await h.call('mf:md:render', { sessionId: 'r1' }), { html: '<p>reader</p>' });
    assert.deepEqual(await h.call('mf:md:save', { sessionId: 'r1', text: 'x', force: true }), { saved: true });
    assert.deepEqual(seen.map(([label, kind]) => `${label}:${kind}`), ['preview:render', 'reader:render', 'reader:save']);
    assert.deepEqual(seen[2][2], { sessionId: 'r1', text: 'x', force: true });
    for (const [channel, payload] of [['mf:md:render', { sessionId: 'zz' }], ['mf:md:save', { sessionId: 'zz', text: '' }], ['mf:md:insertImage', { sessionId: 'zz' }]]) {
        await assert.rejects(h.call(channel, payload), /编辑会话不存在或已关闭，请重新打开文件/);
    }
    const bare = makeHarness();
    await assert.rejects(bare.call('mf:md:render', { sessionId: 'p1' }), /编辑会话不存在或已关闭/);
});

test('md:insertImage：主进程弹图片对话框（默认文档目录），取消回 { canceled:true }，选中后交会话导入', async () => {
    const { seen, preview, reader } = mdOwners();
    const dialogs = [];
    let answer = { canceled: true, filePaths: [] };
    const dialog = { showOpenDialog: async (win, options) => { dialogs.push(options); return answer; } };
    const h = makeHarness({ preview, reader, dialog });
    assert.deepEqual(await h.call('mf:md:insertImage', { sessionId: 'r1' }), { canceled: true });
    assert.equal(seen.length, 0, '取消时不导入');
    assert.equal(dialogs[0].defaultPath, '/docs/reader');
    assert.deepEqual(dialogs[0].properties, ['openFile']);
    const exts = dialogs[0].filters[0].extensions;
    assert.ok(exts.includes('png') && exts.includes('jpg') && exts.includes('svg'));
    assert.ok(!exts.includes('*') && !exts.includes('exe'), '只接受图片扩展名');
    answer = { canceled: false, filePaths: ['/pics/a.png'] };
    assert.deepEqual(await h.call('mf:md:insertImage', { sessionId: 'p1' }), { canceled: false, relPath: 'images/a.png', width: 10, height: 5, alt: 'a' });
    assert.deepEqual(seen[0], ['preview', 'import', { sessionId: 'p1', sourcePath: '/pics/a.png' }]);
});

test('paths:expand 的 scope 透传到 scan：browse 另列 html / xml / json，缺省与 convert 沿用转档白名单', async () => {
    const calls = [];
    const scanStub = { scanPaths: async (...args) => { calls.push(args); return { files: [], unsupported: [], truncated: false }; } };
    const h = makeHarness({ scanModule: scanStub });
    await h.call('mf:paths:expand', { paths: ['/repo'], scope: 'browse' });
    await h.call('mf:paths:expand', { paths: ['/in'] });
    await h.call('mf:paths:expand', { paths: ['/in'], scope: 'convert' });
    assert.deepEqual(calls[0], [['/repo'], { exts: BROWSE_EXTENSIONS }]);
    assert.deepEqual(calls[1], [['/in']], '转档入口不带 exts，沿用默认白名单');
    assert.deepEqual(calls[2], [['/in']]);
});

test('dialog:pickFiles：purpose read 为单选「选择要打开的文件」与可阅读文档过滤器；缺省仍是转换对话框', async () => {
    const dialogs = [];
    const dialog = { showOpenDialog: async (win, options) => { dialogs.push(options); return { canceled: false, filePaths: ['/a.md', '/b.json'] }; } };
    const h = makeHarness({ dialog });
    assert.deepEqual(await h.call('mf:dialog:pickFiles', { purpose: 'read' }), { canceled: false, paths: ['/a.md'] });
    assert.equal(dialogs[0].title, '选择要打开的文件');
    assert.deepEqual(dialogs[0].properties, ['openFile']);
    assert.equal(dialogs[0].filters[0].name, '可阅读的文档');
    assert.deepEqual(dialogs[0].filters[0].extensions, READER_EXTENSIONS.map((ext) => ext.slice(1)));
    assert.deepEqual(dialogs[0].filters[1], { name: '全部文件', extensions: ['*'] });
    await h.call('mf:dialog:pickFiles', undefined);
    assert.equal(dialogs[1].title, '选择要转换的文件');
    assert.deepEqual(dialogs[1].properties, ['openFile', 'multiSelections']);
});

// ============================================================
// 当前文件操作（顶部栏：在访达中显示 / 用默认应用打开 / 复制路径）
// ============================================================

test('file:action：路径按 sessionId 在预览与阅读会话中取，reveal / open / copyPath 各走 shell 与剪贴板，失败给中文错误', async () => {
    assert.deepEqual(validatePayload('mf:file:action', { sessionId: 'reader-1', action: 'copyPath' }), { sessionId: 'reader-1', action: 'copyPath' });
    const dir = fs.mkdtempSync(path.join(root, 'fa-'));
    const settings = createSettingsStore({ dir, safeStorage: fakeSafeStorage, defaults: { outputDir: path.join(dir, 'out'), libraryRoot: path.join(dir, 'lib') } });
    settings.load();
    const revealed = [];
    const opened = [];
    const copied = [];
    let openFailure = '';
    const electron = {
        dialog: {}, nativeTheme: { shouldUseDarkColors: false }, BrowserWindow: { fromWebContents: () => null },
        shell: { showItemInFolder: (p) => revealed.push(p), openPath: async (p) => { opened.push(p); return openFailure; }, openExternal: async () => undefined, trashItem: async () => undefined },
        clipboard: { writeText: (text) => copied.push(text) },
    };
    const missing = path.join(dir, 'gone.md');
    const preview = { sessions: new Map([['p1', { input: { path: SAMPLE_MD } }], ['p2', { input: { url: 'https://example.com/' } }]]), close: async () => ({ closed: false }) };
    const reader = { sessions: new Map([['r1', { path: SAMPLE_MD }], ['r2', { path: missing }]]), close: async () => ({ closed: false }) };
    const { handlers } = createIpcHandlers({ electron, settings, service: realService, scan, preview, reader, log: () => undefined });
    const call = (payload) => handlers['mf:file:action']({}, validatePayload('mf:file:action', payload));

    assert.deepEqual(await call({ sessionId: 'r1', action: 'reveal' }), { ok: true });
    assert.deepEqual(revealed, [SAMPLE_MD], '阅读会话取所开文件');
    assert.deepEqual(await call({ sessionId: 'p1', action: 'open' }), { ok: true });
    assert.deepEqual(opened, [SAMPLE_MD], '预览会话取来源文件');
    assert.deepEqual(await call({ sessionId: 'r2', action: 'copyPath' }), { ok: true });
    assert.deepEqual(copied, [missing], '复制路径不要求文件仍在');

    openFailure = 'No application knows how to open';
    await assert.rejects(call({ sessionId: 'r1', action: 'open' }), /无法用默认应用打开：No application knows how to open/);
    await assert.rejects(call({ sessionId: 'r2', action: 'reveal' }), /文件不存在或已被移动/);
    await assert.rejects(call({ sessionId: 'p2', action: 'reveal' }), /网页/);
    await assert.rejects(call({ sessionId: 'nope', action: 'copyPath' }), /文件会话不存在或已关闭/);
    assert.equal(revealed.length, 1, '失败的 reveal 不调用 shell');

    const noClipboard = createIpcHandlers({ electron: { ...electron, clipboard: undefined }, settings, service: realService, scan, reader, log: () => undefined });
    await assert.rejects(noClipboard.handlers['mf:file:action']({}, { sessionId: 'r1', action: 'copyPath' }), /剪贴板不可用/);
    const bare = createIpcHandlers({ electron, settings, service: realService, scan, log: () => undefined });
    await assert.rejects(bare.handlers['mf:file:action']({}, { sessionId: 'r1', action: 'reveal' }), /文件会话不存在或已关闭/, '模块未就绪时按会话不存在处理');
});
