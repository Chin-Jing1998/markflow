/**
 * Word 加载项总装与设置键、IPC 处理器的单元测试（真实设置存储 + 临时端口 + 临时目录，脱离 Electron）
 * 覆盖：设置键 wordAddin 的 schema 与默认值（默认关闭、旧设置文件升级、段损坏按关闭处理、不可经 mf:settings:set 改写）；
 *       默认不监听任何端口；setEnabled 先落盘再启停，关闭后端口立即释放；启动时按设置恢复；
 *       端口被占用时开关保持启用、原因进状态；未启用时不探测 Word 的数据目录；非 macOS 禁用；
 *       连续切换开关串行执行；describe 不含令牌；dispose 停止监听；IPC 处理器的委托与「模块未就绪」。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { createSettingsStore, SettingsSchema, SettingsPatchSchema, WordAddinSchema, buildDefaultSettings, SETTINGS_FILENAME } = require('../desktop/main/settings');
const { createWordAddin } = require('../desktop/main/addin/controller');
const { defaultWefDir, MANIFEST_FILENAME } = require('../desktop/main/addin/manifest-installer');
const { ADDIN_CHANNELS, ADDIN_SCHEMAS, createAddinHandlers, ADDIN_NOT_READY } = require('../desktop/main/addin/ipc');
const { createIpcHandlers, CHANNELS, SCHEMAS } = require('../desktop/main/ipc');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'addin-controller-'));
const cleanups = [];
after(async () => {
    for (const cleanup of cleanups) await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
});

const ADDIN_DIR = path.join(__dirname, '..', 'office-addin');
const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`enc:${text}`),
    decryptString: (buffer) => Buffer.from(buffer).toString('utf8').slice(4),
};
const stubService = {
    planTasks: (raws, target) => raws.map((raw) => ({ raw, input: { path: raw }, target })),
    buildOptions: (flat) => flat,
    runConversion: async () => ({ ok: false, results: [], errors: [{ error: '桩' }] }),
};

let seq = 0;
function sandbox() {
    seq += 1;
    const dir = path.join(root, `case-${seq}`);
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.dirname(defaultWefDir(home)), { recursive: true });
    return { dir, home, userData: path.join(dir, 'userData') };
}

function makeStore(box) {
    return createSettingsStore({ dir: box.userData, safeStorage: fakeSafeStorage, defaults: { outputDir: path.join(box.dir, 'out'), libraryRoot: path.join(box.dir, 'lib') } });
}

function makeAddin(box, overrides = {}) {
    const settings = overrides.settings || makeStore(box);
    const logs = [];
    const addin = createWordAddin({
        settings, service: stubService, version: '3.0.0', platform: overrides.platform || 'darwin',
        port: overrides.port === undefined ? 0 : overrides.port, log: (line) => logs.push(line),
        paths: {
            staticDir: path.join(ADDIN_DIR, 'taskpane'), templatePath: path.join(ADDIN_DIR, 'manifest.xml'),
            wefDir: defaultWefDir(box.home), stagingDir: path.join(box.userData, 'word-addin'), tmpRoot: path.join(box.dir, 'tmp', 'uploads'),
        },
    });
    cleanups.push(() => addin.dispose());
    return { addin, settings, logs };
}

const health = async (port) => (await fetch(`http://127.0.0.1:${port}/v1/health`)).status;
const onDisk = (box) => JSON.parse(fs.readFileSync(path.join(box.userData, SETTINGS_FILENAME), 'utf8'));

// ============================================================
// 设置键
// ============================================================

test('设置键 wordAddin：默认关闭；schema 只收一个布尔；不可经 mf:settings:set 的 patch 改写', async () => {
    const box = sandbox();
    const store = makeStore(box);
    assert.deepEqual(store.get().wordAddin, { enabled: false }, '默认关闭：不启用就不监听任何端口');
    assert.deepEqual(buildDefaultSettings({ outputDir: '/o', libraryRoot: '/l' }).wordAddin, { enabled: false });
    assert.equal(WordAddinSchema.safeParse({ enabled: true }).success, true);
    for (const bad of [{}, { enabled: 'yes' }, { enabled: 1 }, { enabled: true, port: 8080 }, null, 'on']) assert.equal(WordAddinSchema.safeParse(bad).success, false, JSON.stringify(bad));
    assert.equal(SettingsPatchSchema.safeParse({ wordAddin: { enabled: true } }).success, false, '渲染层的通用设置通道写不进这个开关');
    await assert.rejects(store.set({ wordAddin: { enabled: true } }), /设置项不合法/);

    assert.deepEqual(await store.setWordAddin({ enabled: true }), { enabled: true });
    assert.deepEqual(onDisk(box).wordAddin, { enabled: true });
    assert.deepEqual(makeStore(box).load().wordAddin, { enabled: true }, '重新加载仍为启用');
    for (const bad of [{ enabled: 'yes' }, { enabled: true, port: 1 }, null, 'on']) await assert.rejects(store.setWordAddin(bad), /Word 加载项设置不合法/);
    assert.deepEqual(store.get().wordAddin, { enabled: true }, '被拒的写入不改变现值');
    await store.set({ theme: 'dark' });
    assert.deepEqual(onDisk(box).wordAddin, { enabled: true }, '保存其他设置不会把开关冲掉');
});

test('旧设置文件缺该键时读出为关闭；该段损坏时按关闭处理，其余设置项照旧', () => {
    const box = sandbox();
    fs.mkdirSync(box.userData, { recursive: true });
    const legacy = { version: 1, theme: 'dark', outputDir: path.join(box.dir, 'legacy-out'), checkUpdateOnStartup: false };
    fs.writeFileSync(path.join(box.userData, SETTINGS_FILENAME), JSON.stringify(legacy));
    const upgraded = makeStore(box);
    assert.deepEqual(upgraded.load().wordAddin, { enabled: false });
    assert.deepEqual([upgraded.get().theme, upgraded.get().outputDir, upgraded.warnings()], ['dark', legacy.outputDir, []]);

    for (const broken of ['yes', { enabled: 'true' }, { enabled: true, extra: 1 }, [true], 1]) {
        fs.writeFileSync(path.join(box.userData, SETTINGS_FILENAME), JSON.stringify({ ...legacy, wordAddin: broken }));
        const store = makeStore(box);
        assert.deepEqual(store.load().wordAddin, { enabled: false }, `坏数据不会误开端口：${JSON.stringify(broken)}`);
        assert.equal(store.get().theme, 'dark', '不牵连其余设置项');
    }
    assert.equal(SettingsSchema.safeParse({ ...buildDefaultSettings({ outputDir: '/o', libraryRoot: '/l' }), wordAddin: { enabled: true } }).data.wordAddin.enabled, true);
});

// ============================================================
// 总装
// ============================================================

test('默认不监听；启用即监听并落盘；关闭后端口立即释放；describe 不含令牌', async () => {
    const box = sandbox();
    const { addin } = makeAddin(box);
    const initial = await addin.init();
    assert.deepEqual([initial.supported, initial.enabled, initial.server.state, initial.server.url], [true, false, 'stopped', null]);
    assert.equal(initial.manifest.state, 'unchecked', '未启用时不去读 Word 的数据目录');

    const enabled = await addin.setEnabled(true);
    assert.deepEqual([enabled.enabled, enabled.server.state], [true, 'listening']);
    assert.equal(enabled.manifest.state, 'not-installed', '启用后才探测清单状态');
    assert.deepEqual(onDisk(box).wordAddin, { enabled: true });
    const { port } = enabled.server;
    assert.equal(await health(port), 200);
    const page = await (await fetch(`http://127.0.0.1:${port}/taskpane.html`)).text();
    const token = /name="markflow-token" content="([^"]+)"/.exec(page)[1];
    assert.ok(!JSON.stringify(await addin.describe()).includes(token), '设置页拿到的状态里没有令牌');

    const disabled = await addin.setEnabled(false);
    assert.deepEqual([disabled.enabled, disabled.server.state], [false, 'stopped']);
    assert.deepEqual(onDisk(box).wordAddin, { enabled: false });
    await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/health`), '关闭后立即停止监听');
});

test('启动时按设置恢复：上次启用则 init 即监听；dispose 停止监听', async () => {
    const box = sandbox();
    const settings = makeStore(box);
    await settings.setWordAddin({ enabled: true });
    const { addin } = makeAddin(box, { settings });
    const status = await addin.init();
    assert.equal(status.server.state, 'listening');
    assert.equal(await health(status.server.port), 200);
    await addin.dispose();
    await assert.rejects(fetch(`http://127.0.0.1:${status.server.port}/v1/health`));
    assert.deepEqual(onDisk(box).wordAddin, { enabled: true }, '退出不改开关：下次启动照常恢复');
});

test('端口被占用：开关保持启用，状态给出原因与排查办法；端口腾出后重新勾选即可', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => { blocker.listen(0, '127.0.0.1', resolve); });
    const box = sandbox();
    const { addin } = makeAddin(box, { port: blocker.address().port });
    const status = await addin.setEnabled(true);
    assert.deepEqual([status.enabled, status.server.state], [true, 'port-in-use']);
    assert.match(status.server.message, /已被其他程序占用/);
    assert.match(status.server.hint, /lsof -nP -iTCP:\d+ -sTCP:LISTEN/);
    assert.deepEqual(onDisk(box).wordAddin, { enabled: true });
    await new Promise((resolve) => { blocker.close(resolve); });
    await addin.setEnabled(false);
    assert.equal((await addin.setEnabled(true)).server.state, 'listening');
});

test('非 macOS：整体禁用——启用被拒绝、设置里即便为启用也不监听、安装被拒绝', async () => {
    const box = sandbox();
    const settings = makeStore(box);
    await settings.setWordAddin({ enabled: true });
    const { addin } = makeAddin(box, { settings, platform: 'win32' });
    const status = await addin.init();
    assert.deepEqual([status.supported, status.platform, status.server.state, status.manifest.state, status.unsupportedMessage], [false, 'win32', 'stopped', 'unsupported', '仅支持 macOS 版 Word']);
    await assert.rejects(addin.setEnabled(true), /仅支持 macOS 版 Word/);
    await assert.rejects(addin.install(), /仅支持 macOS 版 Word/);
    assert.equal((await addin.setEnabled(false)).enabled, false, '关闭始终允许');
});

test('安装与移除经总装执行，只动注入的旁加载目录；未启用时也能移除', async () => {
    const box = sandbox();
    const { addin } = makeAddin(box);
    const installed = await addin.install();
    assert.equal(installed.manifest.state, 'installed');
    assert.ok(fs.existsSync(path.join(defaultWefDir(box.home), MANIFEST_FILENAME)));
    assert.equal(installed.enabled, false);
    assert.equal((await addin.describe()).manifest.state, 'unchecked', '未启用时的常规查询仍不探测');
    assert.equal((await addin.uninstall()).manifest.state, 'not-installed');
    assert.equal(fs.existsSync(defaultWefDir(box.home)), false);
    assert.match(installed.manual.install, /^mkdir -p '/);
});

test('连续切换开关串行执行：最终状态与最后一次调用一致', async () => {
    const box = sandbox();
    const { addin } = makeAddin(box);
    const results = await Promise.all([addin.setEnabled(true), addin.setEnabled(false), addin.setEnabled(true), addin.setEnabled(false), addin.setEnabled(true)]);
    assert.deepEqual(results.map((item) => item.server.state), ['listening', 'stopped', 'listening', 'stopped', 'listening']);
    const final = await addin.describe();
    assert.deepEqual([final.enabled, final.server.state], [true, 'listening']);
    assert.equal(await health(final.server.port), 200);
});

test('入参校验：缺 settings / service 直接抛错', () => {
    assert.throws(() => createWordAddin({ service: stubService }), /缺少 settings/);
    assert.throws(() => createWordAddin({ settings: { get() {} }, service: stubService }), /缺少 settings/, '须带 setWordAddin');
    const box = sandbox();
    assert.throws(() => createWordAddin({ settings: makeStore(box) }), /缺少 service/);
});

// ============================================================
// IPC 处理器
// ============================================================

test('IPC：四个通道委托给总装；模块未就绪时抛中文错误；已并入主进程总表', async () => {
    const calls = [];
    const fake = {
        describe: async () => { calls.push('describe'); return { ok: 1 }; },
        setEnabled: async (enabled) => { calls.push(['setEnabled', enabled]); return { ok: 2 }; },
        install: async () => { calls.push('install'); return { ok: 3 }; },
        uninstall: async () => { calls.push('uninstall'); return { ok: 4 }; },
    };
    const handlers = createAddinHandlers(fake);
    assert.deepEqual(Object.keys(handlers).sort(), Object.values(ADDIN_CHANNELS).sort());
    assert.deepEqual(await handlers['mf:addin:status']({}, undefined), { ok: 1 });
    assert.deepEqual(await handlers['mf:addin:setEnabled']({}, { enabled: true }), { ok: 2 });
    assert.deepEqual(await handlers['mf:addin:install']({}, undefined), { ok: 3 });
    assert.deepEqual(await handlers['mf:addin:uninstall']({}, undefined), { ok: 4 });
    assert.deepEqual(calls, ['describe', ['setEnabled', true], 'install', 'uninstall']);

    for (const handler of Object.values(createAddinHandlers(null))) await assert.rejects(handler({}, { enabled: true }), new RegExp(ADDIN_NOT_READY));

    for (const channel of Object.values(ADDIN_CHANNELS)) {
        assert.ok(SCHEMAS[channel], `总表含 schema：${channel}`);
        assert.equal(SCHEMAS[channel], ADDIN_SCHEMAS[channel]);
    }
    assert.equal(CHANNELS.addinSetEnabled, 'mf:addin:setEnabled');
    const box = sandbox();
    const wired = createIpcHandlers({ electron: { dialog: {}, shell: {} }, settings: makeStore(box), service: stubService, scan: { scanPaths: async () => ({}) }, addin: fake });
    assert.deepEqual(await wired.handlers['mf:addin:setEnabled']({}, { enabled: false }), { ok: 2 });
    const unwired = createIpcHandlers({ electron: { dialog: {}, shell: {} }, settings: makeStore(box), service: stubService, scan: { scanPaths: async () => ({}) } });
    await assert.rejects(unwired.handlers['mf:addin:status']({}, undefined), new RegExp(ADDIN_NOT_READY));
});

test('preload 暴露四个加载项方法，且只传布尔开关', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');
    for (const channel of Object.values(ADDIN_CHANNELS)) assert.ok(src.includes(`invoke('${channel}'`), channel);
    assert.ok(src.includes("invoke('mf:addin:setEnabled', { enabled: Boolean(enabled) })"));
});
