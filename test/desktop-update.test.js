/**
 * desktop/main/update-check.js 单元测试（不联网：请求函数一律注入）
 * 覆盖：版本比较（新版更高 / 已是最新 / 本地开发版更高 / 预发布与正式版 / 无法解析）；
 *       请求护栏（地址写死、User-Agent、不跟随重定向、带超时信号）；
 *       五种失败情形（超时、非 200、响应体超长、JSON 非法、字段类型不对）均按「检测失败」处理且不抛出；
 *       回包中的下载链接须落在本仓库前缀内，否则回退 releases 页面；
 *       24 小时缓存：命中即不发请求，force 无视缓存，过期后重新检测；缓存写入失败不影响返回值；
 *       settings.json 的 update 段：写入后可读回，损坏时按缺失处理且不牵连其余设置项；
 *       启动开关 checkUpdateOnStartup：关掉后启动判定为假，既不调用检测器也不发请求。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    createUpdateChecker, fetchLatestRelease, evaluateRelease, parseVersion, compareVersions, safeReleaseUrl,
    RELEASES_API_URL, RELEASES_PAGE_URL, AUTO_INTERVAL_MS,
} = require('../desktop/main/update-check');
const { createSettingsStore, SETTINGS_FILENAME } = require('../desktop/main/settings');
const { createIpcHandlers, validatePayload, CHANNELS, UPDATE_NOT_READY } = require('../desktop/main/ipc');
const { shouldCheckUpdateOnStartup } = require('../desktop/main/index')._internal;
const realService = require('../converters/service');
const scan = require('../desktop/main/scan');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });

const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`enc:${text}`),
    decryptString: (buffer) => Buffer.from(buffer).toString('utf8').slice(4),
};

// makeStore 创建的目录逐一登记，全部用例结束后仅删除这些目录；test/tmp/ 另有其他测试文件使用，不整体清空
const createdDirs = [];
after(() => {
    for (const dir of createdDirs) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
            // Windows 上句柄未及时释放时删除可能失败；残留目录不影响测试结论，清理失败不计为测试失败
        }
    }
});

function makeStore() {
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'update-'));
    createdDirs.push(dir);
    const store = createSettingsStore({ dir, safeStorage: fakeSafeStorage, defaults: { outputDir: path.join(dir, 'out'), libraryRoot: path.join(dir, 'lib') } });
    store.load();
    return { dir, store };
}

/** 最小 Response 桩：只提供 status / headers.get / text（不带 body 流，走文本长度兜底） */
const response = (status, text, headers = {}) => ({
    status,
    headers: { get: (name) => (Object.prototype.hasOwnProperty.call(headers, name.toLowerCase()) ? headers[name.toLowerCase()] : null) },
    text: async () => text,
});

const releaseBody = (tag, url) => JSON.stringify({ tag_name: tag, html_url: url, name: tag, body: '发布说明' });

// ============================================================
// 版本比较
// ============================================================

test('parseVersion：认 v 前缀、预发布与 build 元数据，不合规返回 null', () => {
    assert.deepEqual(parseVersion('3.0.0'), { major: 3, minor: 0, patch: 0, prerelease: [] });
    assert.deepEqual(parseVersion('v3.1.2'), { major: 3, minor: 1, patch: 2, prerelease: [] });
    assert.deepEqual(parseVersion(' V3.0.0-rc.1 '), { major: 3, minor: 0, patch: 0, prerelease: ['rc', '1'] });
    assert.deepEqual(parseVersion('3.0.0+build.7'), { major: 3, minor: 0, patch: 0, prerelease: [] });
    for (const bad of ['v3.0', 'latest', '', '3.0.0.1', 'v3.0.0-', 'v3.0.0-rc..1', null, undefined, 3, {}]) {
        assert.equal(parseVersion(bad), null, `应判为无法解析：${String(bad)}`);
    }
});

test('compareVersions：新版更高 / 已是最新 / 本地开发版更高 / 预发布小于正式版 / 无法判定', () => {
    // 远端更高
    assert.equal(compareVersions('v3.1.0', '3.0.0'), 1);
    assert.equal(compareVersions('v3.0.1', '3.0.0'), 1);
    assert.equal(compareVersions('v4.0.0', '3.9.9'), 1);
    // 已是最新（相等）
    assert.equal(compareVersions('v3.0.0', '3.0.0'), 0);
    assert.equal(compareVersions('3.0.0+build.9', '3.0.0'), 0, 'build 元数据不参与比较');
    // 本地为开发版，当前版更高
    assert.equal(compareVersions('v3.0.0', '3.1.0'), -1);
    assert.equal(compareVersions('v3.0.0', '3.0.1'), -1);
    // 预发布与正式版
    assert.equal(compareVersions('v3.0.0-rc.1', '3.0.0'), -1, '3.0.0-rc.1 < 3.0.0');
    assert.equal(compareVersions('v3.0.0', '3.0.0-rc.1'), 1, '3.0.0 > 3.0.0-rc.1');
    assert.equal(compareVersions('v3.0.0-rc.2', '3.0.0-rc.1'), 1);
    assert.equal(compareVersions('v3.0.0-rc.1', '3.0.0-rc.1'), 0);
    assert.equal(compareVersions('v3.0.0-alpha', '3.0.0-beta'), -1);
    assert.equal(compareVersions('v3.0.0-rc.1', '3.0.0-rc'), 1, '标识多的一方更大');
    assert.equal(compareVersions('v3.0.0-1', '3.0.0-alpha'), -1, '数字标识小于字母标识');
    assert.equal(compareVersions('v3.0.0-rc.10', '3.0.0-rc.9'), 1, '数字标识按数值而非字典序');
    assert.equal(compareVersions('v3.1.0-rc.1', '3.0.0'), 1, '预发布的主版本更高时仍更新');
    // 无法判定
    assert.equal(compareVersions('latest', '3.0.0'), null);
    assert.equal(compareVersions('v3.0', '3.0.0'), null);
    assert.equal(compareVersions('v3.0.0', 'dev'), null);
});

test('evaluateRelease：四态与中文文案', () => {
    const base = { currentVersion: '3.0.0', url: RELEASES_PAGE_URL };
    assert.equal(evaluateRelease({ ...base, tagName: 'v3.1.0' }).status, 'update-available');
    assert.match(evaluateRelease({ ...base, tagName: 'v3.1.0' }).message, /有新版本 v3\.1\.0/);
    assert.equal(evaluateRelease({ ...base, tagName: 'v3.0.0' }).status, 'latest');
    assert.match(evaluateRelease({ ...base, tagName: 'v3.0.0' }).message, /已是最新版/);
    assert.equal(evaluateRelease({ ...base, tagName: 'v3.0.0-rc.1' }).status, 'latest', '正式版高于同号预发布');
    assert.equal(evaluateRelease({ currentVersion: '3.1.0', tagName: 'v3.0.0' }).status, 'latest');
    assert.match(evaluateRelease({ currentVersion: '3.1.0', tagName: 'v3.0.0' }).message, /高于已发布的 v3\.0\.0/);
    const unknown = evaluateRelease({ ...base, tagName: 'nightly' });
    assert.equal(unknown.status, 'unknown', '解析不出的 tag_name 不得误报有新版');
    assert.match(unknown.message, /无法判定/);
});

// ============================================================
// 请求护栏
// ============================================================

test('fetchLatestRelease：地址写死、带 User-Agent 与超时信号、不跟随重定向', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return response(200, releaseBody('v3.1.0', 'https://github.com/Chin-Jing1998/markflow/releases/tag/v3.1.0'));
    };
    const result = await fetchLatestRelease({ fetchImpl });
    assert.deepEqual(result, { ok: true, tagName: 'v3.1.0', url: 'https://github.com/Chin-Jing1998/markflow/releases/tag/v3.1.0' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, RELEASES_API_URL);
    assert.equal(calls[0].url, 'https://api.github.com/repos/Chin-Jing1998/markflow/releases/latest');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers['User-Agent'], 'MarkFlow-Desktop');
    assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json');
    assert.equal(calls[0].init.redirect, 'error', '不跟随任何重定向');
    assert.ok(calls[0].init.signal && typeof calls[0].init.signal.aborted === 'boolean', '带中止信号（超时）');
});

test('fetchLatestRelease：下载链接只认本仓库前缀，越界一律回退 releases 页面', async () => {
    const withUrl = async (htmlUrl) => {
        const res = await fetchLatestRelease({ fetchImpl: async () => response(200, releaseBody('v3.1.0', htmlUrl)) });
        return res.url;
    };
    assert.equal(await withUrl('https://github.com/Chin-Jing1998/markflow/releases/tag/v3.1.0'), 'https://github.com/Chin-Jing1998/markflow/releases/tag/v3.1.0');
    assert.equal(await withUrl('https://evil.example/download'), RELEASES_PAGE_URL);
    assert.equal(await withUrl('https://github.com/other/repo/releases/tag/v1'), RELEASES_PAGE_URL);
    assert.equal(await withUrl('javascript:alert(1)'), RELEASES_PAGE_URL);
    assert.equal(await withUrl(12345), RELEASES_PAGE_URL);
    assert.equal(await withUrl(undefined), RELEASES_PAGE_URL);
    assert.equal(safeReleaseUrl(`https://github.com/Chin-Jing1998/markflow/${'x'.repeat(4000)}`), RELEASES_PAGE_URL, '超长链接回退');
    // 穿越串：朴素的 startsWith 会放行，归一后落在仓库之外，须回退
    assert.equal(await withUrl('https://github.com/Chin-Jing1998/markflow/../../evil'), RELEASES_PAGE_URL, '路径穿越回退');
    assert.equal(safeReleaseUrl('https://github.com/Chin-Jing1998/markflow/..'), RELEASES_PAGE_URL, '上跳一级回退');
});

test('fetchLatestRelease：超时 / 非 200 / 响应体超长 / JSON 非法 / 字段类型不对，五种情形均按失败返回且不抛出', async () => {
    // ① 超时
    const timeout = await fetchLatestRelease({
        fetchImpl: async () => { const err = new Error('The operation was aborted due to timeout'); err.name = 'TimeoutError'; throw err; },
    });
    assert.equal(timeout.ok, false);
    assert.match(timeout.message, /无法连接 GitHub（请求超过 10 秒未完成）/);

    // 网络不可达也走同一路径
    const offline = await fetchLatestRelease({
        fetchImpl: async () => { const err = new TypeError('fetch failed'); err.cause = { code: 'ENOTFOUND' }; throw err; },
    });
    assert.equal(offline.ok, false);
    assert.match(offline.message, /无法连接 GitHub/);

    // ② 非 200
    for (const [status, pattern] of [[404, /尚无已发布的版本/], [403, /频率上限/], [429, /频率上限/], [500, /HTTP 500/]]) {
        const res = await fetchLatestRelease({ fetchImpl: async () => response(status, 'nope') });
        assert.equal(res.ok, false, `HTTP ${status} 应判为失败`);
        assert.match(res.message, pattern);
    }

    // ③ 响应体超长：content-length 声明超限
    const declared = await fetchLatestRelease({ fetchImpl: async () => response(200, '{}', { 'content-length': String(5 * 1024 * 1024) }) });
    assert.equal(declared.ok, false);
    assert.match(declared.message, /响应体超过 \d+ 字节上限/);

    // ③ 响应体超长：未声明长度，按实际文本兜底
    const oversize = await fetchLatestRelease({ fetchImpl: async () => response(200, 'x'.repeat(2 * 1024 * 1024)) });
    assert.equal(oversize.ok, false);
    assert.match(oversize.message, /响应体超过 \d+ 字节上限/);

    // ③ 响应体超长：走流式读取时到达上限即中止
    let cancelled = false;
    const chunk = new Uint8Array(256 * 1024);
    const streaming = await fetchLatestRelease({
        fetchImpl: async () => ({
            status: 200,
            headers: { get: () => null },
            body: { getReader: () => ({ read: async () => ({ value: chunk, done: false }), cancel: async () => { cancelled = true; } }) },
            text: async () => { throw new Error('不应走到 text()'); },
        }),
    });
    assert.equal(streaming.ok, false);
    assert.match(streaming.message, /响应体超过 \d+ 字节上限/);
    assert.equal(cancelled, true, '超限后取消读取');

    // ④ JSON 非法
    const badJson = await fetchLatestRelease({ fetchImpl: async () => response(200, '<html>502 Bad Gateway</html>') });
    assert.equal(badJson.ok, false);
    assert.match(badJson.message, /不是合法 JSON/);

    // ⑤ 字段类型不对
    for (const [body, pattern] of [
        [JSON.stringify({ tag_name: 3.1 }), /缺少版本号字段/],
        [JSON.stringify({ tag_name: null }), /缺少版本号字段/],
        [JSON.stringify({ name: 'v3.1.0' }), /缺少版本号字段/],
        [JSON.stringify({ tag_name: '   ' }), /为空或过长/],
        [JSON.stringify({ tag_name: 'v'.repeat(200) }), /为空或过长/],
        [JSON.stringify([{ tag_name: 'v3.1.0' }]), /结构不符合预期/],
        ['null', /结构不符合预期/],
        ['"v3.1.0"', /结构不符合预期/],
    ]) {
        const res = await fetchLatestRelease({ fetchImpl: async () => response(200, body) });
        assert.equal(res.ok, false, `应判为失败：${body.slice(0, 40)}`);
        assert.match(res.message, pattern);
    }

    // 运行环境没有 fetch 时同样按失败返回，不抛出
    const originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = undefined;
        const noFetch = await fetchLatestRelease({});
        assert.deepEqual(noFetch, { ok: false, message: '当前运行环境不支持网络请求' });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('fetchLatestRelease：tag_name 中的控制字符被剔除', async () => {
    const res = await fetchLatestRelease({ fetchImpl: async () => response(200, JSON.stringify({ tag_name: 'v3.1.0\n\x07', html_url: RELEASES_PAGE_URL })) });
    assert.deepEqual(res, { ok: true, tagName: 'v3.1.0', url: RELEASES_PAGE_URL });
});

// ============================================================
// 缓存与调度
// ============================================================

test('createUpdateChecker：首次检测写缓存，24 小时内复用缓存不再请求，force 无视缓存', async () => {
    const { store } = makeStore();
    const calls = [];
    let clock = 1_000_000;
    const checker = createUpdateChecker({
        settings: store, currentVersion: '3.0.0', now: () => clock,
        fetchImpl: async () => { calls.push(clock); return response(200, releaseBody('v3.1.0', 'https://github.com/Chin-Jing1998/markflow/releases/tag/v3.1.0')); },
    });

    const first = await checker.check({ force: false });
    assert.equal(first.status, 'update-available');
    assert.equal(first.latestVersion, 'v3.1.0');
    assert.equal(first.currentVersion, '3.0.0');
    assert.equal(first.cached, false);
    assert.equal(first.checkedAt, 1_000_000);
    assert.equal(calls.length, 1);
    assert.deepEqual(store.getUpdateCache(), {
        checkedAt: 1_000_000, status: 'update-available', message: first.message,
        latestVersion: 'v3.1.0', url: 'https://github.com/Chin-Jing1998/markflow/releases/tag/v3.1.0',
    });

    clock += AUTO_INTERVAL_MS - 1;
    const cached = await checker.check({ force: false });
    assert.equal(cached.cached, true);
    assert.equal(cached.checkedAt, 1_000_000, '缓存的检测时刻不变');
    assert.equal(calls.length, 1, '有效期内不再请求 GitHub');

    const forced = await checker.check({ force: true });
    assert.equal(forced.cached, false);
    assert.equal(forced.checkedAt, clock);
    assert.equal(calls.length, 2, '手动检测无视缓存');

    clock += AUTO_INTERVAL_MS;
    await checker.check({ force: false });
    assert.equal(calls.length, 3, '超过 24 小时后重新检测');
});

test('createUpdateChecker：时钟回拨按缓存过期处理；缓存在新实例中仍可读', async () => {
    const { store } = makeStore();
    let clock = 5_000_000;
    let calls = 0;
    const make = () => createUpdateChecker({
        settings: store, currentVersion: '3.0.0', now: () => clock,
        fetchImpl: async () => { calls += 1; return response(200, releaseBody('v3.0.0', RELEASES_PAGE_URL)); },
    });
    const first = await make().check({ force: false });
    assert.equal(first.status, 'latest');
    assert.equal(calls, 1);
    assert.equal((await make().check({ force: false })).cached, true, '换实例仍读同一份设置缓存');
    assert.equal(calls, 1);
    clock -= 60_000;
    assert.equal((await make().check({ force: false })).cached, false, '时钟回拨后重新检测');
    assert.equal(calls, 2);
});

test('createUpdateChecker：请求失败写入 failed 缓存且不抛出；缓存写入失败只记日志', async () => {
    const { store } = makeStore();
    const checker = createUpdateChecker({
        settings: store, currentVersion: '3.0.0', now: () => 7_000_000,
        fetchImpl: async () => { throw new TypeError('fetch failed'); },
    });
    const failed = await checker.check({ force: true });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.latestVersion, null);
    assert.equal(failed.url, null);
    assert.match(failed.message, /^检测失败：/);
    assert.equal(store.getUpdateCache().status, 'failed');

    const logged = [];
    const broken = createUpdateChecker({
        settings: { getUpdateCache: () => { throw new Error('读缓存炸了'); }, setUpdateCache: async () => { throw new Error('磁盘满'); } },
        currentVersion: '3.0.0', log: (line) => logged.push(line),
        fetchImpl: async () => response(200, releaseBody('v3.0.0', RELEASES_PAGE_URL)),
    });
    const result = await broken.check({ force: false });
    assert.equal(result.status, 'latest', '读写缓存出错不影响检测结论');
    assert.equal(logged.length, 1);
    assert.match(logged[0], /写入更新检测缓存失败/);
});

test('createUpdateChecker：依赖缺失时以中文错误拒绝构造', () => {
    const { store } = makeStore();
    assert.throws(() => createUpdateChecker({ currentVersion: '3.0.0' }), /需要带 getUpdateCache \/ setUpdateCache 的设置存储/);
    assert.throws(() => createUpdateChecker({ settings: store }), /需要当前版本号/);
    assert.throws(() => createUpdateChecker({ settings: store, currentVersion: '  ' }), /需要当前版本号/);
});

// ============================================================
// IPC 通道
// ============================================================

function makeIpc(update) {
    const { store } = makeStore();
    const electron = {
        dialog: {}, nativeTheme: { shouldUseDarkColors: false }, BrowserWindow: { fromWebContents: () => null },
        shell: { openExternal: async () => undefined, showItemInFolder: () => undefined, openPath: async () => '', trashItem: async () => undefined },
    };
    const { handlers } = createIpcHandlers({ electron, settings: store, service: realService, scan, update, log: () => undefined });
    return (payload) => handlers[CHANNELS.updateCheck]({}, validatePayload(CHANNELS.updateCheck, payload));
}

test('mf:update:check：转发 force 给检测器，模块未就绪时给中文错误', async () => {
    const seen = [];
    const call = makeIpc({ check: async (options) => { seen.push(options); return { status: 'latest', message: '已是最新版（3.0.0）', latestVersion: 'v3.0.0', url: null, checkedAt: 1, currentVersion: '3.0.0', cached: true }; } });
    assert.equal((await call(undefined)).status, 'latest');
    await call({ force: true });
    await call({ force: false });
    assert.deepEqual(seen, [{ force: false }, { force: true }, { force: false }], '缺省视为不强制');

    await assert.rejects(makeIpc(null)(undefined), new RegExp(UPDATE_NOT_READY));
});

// ============================================================
// 启动时自动检测的开关（settings.checkUpdateOnStartup）
// ============================================================

test('shouldCheckUpdateOnStartup：只有设置里显式为 false 才关闭', () => {
    assert.equal(shouldCheckUpdateOnStartup({ checkUpdateOnStartup: false }), false);
    assert.equal(shouldCheckUpdateOnStartup({ checkUpdateOnStartup: true }), true);
    assert.equal(shouldCheckUpdateOnStartup({}), true, '旧设置文件缺该字段按开启处理');
    assert.equal(shouldCheckUpdateOnStartup(undefined), true);
});

/**
 * 启动路径的等价复现：index.js 的 scheduleStartupUpdateCheck 内 run() 只有两行——
 * 判定为假直接返回，否则调 updateChecker.check({ force: false })。
 * 该函数定义在 bootstrap 内、依赖 Electron 的 app / BrowserWindow，普通 Node 里驱动不起来
 * （require 入口在非 Electron 进程中刻意不执行 bootstrap），故这里用同一个导出的判定函数
 * 加真实检测器复现那两行，覆盖等价于「开关为假时启动不触发检测」。
 */
test('启动开关：关掉后不调用检测器、不发请求、不写缓存；打开则照常检测', async () => {
    const { store } = makeStore();
    let fetched = 0;
    const checker = createUpdateChecker({
        settings: store,
        currentVersion: '3.0.0',
        fetchImpl: async () => { fetched += 1; return response(200, releaseBody('v3.0.0', RELEASES_PAGE_URL)); },
    });
    let checks = 0;
    const startupRun = async () => {
        if (!shouldCheckUpdateOnStartup(store.get())) return;
        checks += 1;
        await checker.check({ force: false });
    };

    await store.set({ checkUpdateOnStartup: false });
    await startupRun();
    assert.equal(checks, 0, '开关关闭：不调用 check');
    assert.equal(fetched, 0, '开关关闭：一个请求都不发');
    assert.equal(store.getUpdateCache(), null, '开关关闭：不写检测缓存');

    await store.set({ checkUpdateOnStartup: true });
    await startupRun();
    assert.equal(checks, 1);
    assert.equal(fetched, 1);
    assert.equal(store.getUpdateCache().status, 'latest');
});

// ============================================================
// settings.json 的 update 段
// ============================================================

test('设置存储：update 段写入后可读回，渲染层的 patch 无法写入，损坏时按缺失处理', async () => {
    const { dir, store } = makeStore();
    assert.equal(store.getUpdateCache(), null, '初始无缓存');
    const entry = { checkedAt: 1730000000000, status: 'latest', message: '已是最新版（3.0.0）', latestVersion: 'v3.0.0', url: RELEASES_PAGE_URL };
    await store.setUpdateCache(entry);
    assert.deepEqual(store.getUpdateCache(), entry);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, SETTINGS_FILENAME), 'utf8')).update, entry);

    // 普通设置写入不丢缓存
    await store.set({ theme: 'dark' });
    assert.deepEqual(store.getUpdateCache(), entry);

    // 不合法的缓存被拒绝
    await assert.rejects(store.setUpdateCache({ ...entry, status: 'maybe' }), /更新检测缓存不合法/);
    await assert.rejects(store.setUpdateCache({ ...entry, extra: 1 }), /更新检测缓存不合法/);

    // 渲染层可提交的 patch 不含 update
    await assert.rejects(store.set({ update: entry }), /设置项不合法/);

    // 损坏的 update 段按缺失处理，其余设置项照常
    const file = path.join(dir, SETTINGS_FILENAME);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...raw, update: { checkedAt: 'いつか' } }));
    const reloaded = createSettingsStore({ dir, safeStorage: fakeSafeStorage, defaults: { outputDir: path.join(dir, 'out'), libraryRoot: path.join(dir, 'lib') } });
    const settings = reloaded.load();
    assert.equal(settings.theme, 'dark', '损坏的缓存不牵连其余设置项');
    assert.deepEqual(reloaded.warnings(), []);
    assert.equal(reloaded.getUpdateCache(), null);
});

test('并发的非强制检测合并为一次请求：缓存过期时启动路径与设置页不会各打一次 GitHub', async () => {
    // Arrange：缓存留空（等同过期），fetch 计数并人为拉长，制造真实的并发窗口
    const { store } = makeStore();
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return response(200, releaseBody('v3.1.0', RELEASES_PAGE_URL));
    };
    const checker = createUpdateChecker({ settings: store, currentVersion: '3.0.0', fetchImpl });

    // Act：主进程与渲染层同时触发
    const [a, b] = await Promise.all([checker.check({ force: false }), checker.check({ force: false })]);

    // Assert
    assert.equal(calls, 1, `并发的非强制检测应只请求一次，实际 ${calls} 次`);
    assert.equal(a.status, 'update-available');
    assert.deepEqual(a, b, '两个调用方拿到同一个结果');

    // 在途 promise 落定后须释放：缓存此时已写入，再检测直接回缓存、仍不增加请求
    assert.equal((await checker.check({ force: false })).cached, true);
    assert.equal(calls, 1);

    // 强制检测不并入合并，用户点按钮就应重新请求
    await checker.check({ force: true });
    assert.equal(calls, 2);
});

test('在途检测失败后不卡死：下一次检测仍会重新请求', async () => {
    // Arrange：第一次抛错，其后正常
    const { store } = makeStore();
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('boom'), { name: 'TypeError' });
        return response(200, releaseBody('v3.1.0', RELEASES_PAGE_URL));
    };
    const checker = createUpdateChecker({ settings: store, currentVersion: '3.0.0', fetchImpl });

    // Act
    const first = await checker.check({ force: false });

    // Assert：网络异常被 fetchLatestRelease 兜住，记为检测失败而非抛出
    assert.equal(first.status, 'failed');
    assert.equal(calls, 1);

    // 失败结果也会写缓存，故这里用 force 绕开缓存，验证在途 promise 已释放
    const second = await checker.check({ force: true });
    assert.equal(second.status, 'update-available');
    assert.equal(calls, 2);
});
