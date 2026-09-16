/**
 * converters/raster/backend.js 单元测试
 * 覆盖：无 electron 时的中文提示与拒绝、进程内后端优先与注销回退、任务表校验、
 *       spawn 桩（工作目录内 jobs.json 结构与片段文件、参数表、results.json 取图、目录清理）、
 *       工作进程退出异常 / 缺 results.json、超时 kill、真实 electron 出图（PNG 像素 = CSS 像素 × 3.125，无 electron 时跳过）
 */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const backend = require('../converters/raster/backend');
const { buildTableFragment } = require('../converters/raster/fragment');
const { loadJimp } = require('../converters/assets/jimp-loader');
const { createTable, createTableRow, createTableCell } = require('../converters/ir/schema');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const FAKE_PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from('fake-png-body')]);
const TEMP_PREFIX = 'markflow-raster-';
const REAL_TEST_TIMEOUT_MS = 90000;
const TARGET_SCALE = 300 / 96;
const BOX_CSS = { width: 320, height: 160 };
const BOX_FRAGMENT = '<!doctype html><html><head><meta charset="utf-8">'
    + '<style>html,body{margin:0;padding:0;background:#fff}body{display:inline-block}</style></head>'
    + `<body><div style="width:${BOX_CSS.width}px;height:${BOX_CSS.height}px;background:#000"></div></body></html>`;

afterEach(() => {
    backend._reset();
});

// ============================================================
// 辅助
// ============================================================

// 与生产代码同一份解析：刻意不 require('electron')，否则二进制缺失时会当场下载并往 stdout 打印
const { getElectronPath } = require('../converters/chromium/spawn');

function isSpawnBlocked(err) {
    if (!err) return false;
    return err.code === 'ELECTRON_SPAWN_FAILED' || /sandbox|seatbelt|EPERM|EACCES/i.test(String(err.message));
}

/**
 * 记录被测调用自己建出的栅格工作目录。
 * 不数 os.tmpdir() 下的同前缀目录总数：该命名空间由全仓共享（converters/raster/backend.js 的
 * markflow-raster-、desktop/main/chromium-jobs.js 的 markflow-raster-app-，以及各后端模块加载时
 * 的残留回收器），npm test 又以每文件一进程并发跑 58 个套件，前后两次计数会被无关进程的
 * 建/删动作改写，与本用例是否清理无关。改为在调用期间挂 mkdtemp 探针，直接拿到本次调用的目录路径。
 * @returns {{ created: string[], restore: () => void }} created 为本次调用建出的工作目录绝对路径
 */
function spyRasterTempDirs() {
    const created = [];
    const realMkdtemp = fs.promises.mkdtemp;
    fs.promises.mkdtemp = async (prefix, ...rest) => {
        const dir = await realMkdtemp.call(fs.promises, prefix, ...rest);
        if (path.basename(dir).startsWith(TEMP_PREFIX)) created.push(dir);
        return dir;
    };
    return { created, restore: () => { fs.promises.mkdtemp = realMkdtemp; } };
}

function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
        child.killed = true;
    };
    return child;
}

/** 假子进程：先执行 onSpawn（可写产物），再在下一轮退出 */
function stubSpawn({ onSpawn = () => undefined, code = 0, stderr = '' } = {}) {
    return (file, args, options) => {
        onSpawn({ file, args, options });
        const child = fakeChild();
        setImmediate(() => {
            if (stderr) child.stderr.emit('data', stderr);
            child.emit('exit', code, null);
            child.emit('close', code, null);
        });
        return child;
    };
}

const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

function silenceConsoleError(fn) {
    const original = console.error;
    console.error = () => undefined;
    return Promise.resolve().then(fn).finally(() => { console.error = original; });
}

// ============================================================
// 用例
// ============================================================

test('detect：无进程内后端且无 electron 二进制时 name 为 null 并附中文提示，rasterize 抛错；空任务表直接返回空 Map', async () => {
    // Arrange
    backend._setDeps({ electronPath: null });

    // Act
    const result = await backend.detect();

    // Assert
    assert.equal(result.name, null);
    assert.equal(result.available, false);
    assert.match(result.hint, /electron/);
    assert.match(result.hint, /桌面端/);
    assert.match(result.hint, /[一-鿿]/);
    await assert.rejects(() => backend.rasterize([{ id: 'a', html: '<p>x</p>' }]), /栅格化后端不可用/);
    assert.deepEqual(await backend.rasterize([]), new Map());
});

test('进程内后端优先：注册后 detect 返回注册名、rasterize 直接调用并归一返回值；注销后回退到 electron 探测', async () => {
    // Arrange
    backend._setDeps({ electronPath: null });
    const calls = [];
    backend.registerInProcess({
        name: 'desktop',
        rasterize: async (jobs, opts) => {
            calls.push({ ids: jobs.map((job) => job.id), dpi: opts.dpi });
            return new Map([['a', FAKE_PNG], ['c', 'not-a-buffer']]);
        },
    });

    // Act
    const detected = await backend.detect();
    const out = await backend.rasterize(
        [{ id: 'a', html: '<p>a</p>' }, { id: 'b', html: '<p>b</p>' }, { id: 'c', html: '<p>c</p>' }],
        { dpi: 150 },
    );

    // Assert
    assert.deepEqual(detected, { name: 'desktop', available: true, hint: '' });
    assert.deepEqual(calls, [{ ids: ['a', 'b', 'c'], dpi: 150 }]);
    assert.deepEqual(out.get('a'), FAKE_PNG);
    assert.ok(out.get('b') instanceof Error);
    assert.match(out.get('b').message, /未返回该任务的图像/);
    assert.ok(out.get('c') instanceof Error, '非 Buffer 条目归一为 Error');

    backend.unregisterInProcess();
    assert.equal((await backend.detect()).name, null);
    backend._setDeps({ electronPath: process.execPath });
    assert.deepEqual(await backend.detect(), { name: 'electron-worker', available: true, hint: '' });

    assert.throws(() => backend.registerInProcess({ name: '  ', rasterize: async () => new Map() }), /name/);
    assert.throws(() => backend.registerInProcess({ name: 'x' }), /rasterize/);
});

test('任务表校验：非数组、非法 id、重复 id、缺 html 与越界 dpi 一律抛中文错误', async () => {
    backend.registerInProcess({ name: 'stub', rasterize: async () => new Map() });
    await assert.rejects(() => backend.rasterize('nope'), /须为 \[\{ id, html \}\] 数组/);
    await assert.rejects(() => backend.rasterize([{ id: '../x', html: '<p>x</p>' }]), /id 非法/);
    await assert.rejects(() => backend.rasterize([{ id: 'a', html: '<p>x</p>' }, { id: 'a', html: '<p>y</p>' }]), /id 重复/);
    await assert.rejects(() => backend.rasterize([{ id: 'a', html: '' }]), /缺少 html/);
    await assert.rejects(() => backend.rasterize([{ id: 'a', html: '<p>x</p>' }], { dpi: 0 }), /dpi/);
});

test('spawn 桩：工作目录含 jobs.json 与片段文件，参数表为 [worker, jobs.json, out, profile]，按 results.json 取图并清理目录', async () => {
    // Arrange
    const seen = {};
    backend._setDeps({
        electronPath: process.execPath,
        spawn: stubSpawn({
            onSpawn: ({ file, args, options }) => {
                seen.file = file;
                seen.args = args;
                seen.env = options.env;
                const [, jobsPath, outDir] = args;
                seen.workDir = path.dirname(jobsPath);
                seen.jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
                seen.fragments = seen.jobs.jobs.map((job) => [job.id, job.file.startsWith(seen.workDir), fs.readFileSync(job.file, 'utf8')]);
                fs.writeFileSync(path.join(outDir, 'a.png'), FAKE_PNG);
                fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({
                    version: 1,
                    results: [
                        { id: 'a', ok: true, file: 'a.png', width: 10, height: 5, scale: 3.125 },
                        { id: 'b', ok: false, error: '模拟失败' },
                    ],
                }));
            },
        }),
    });

    // Act
    const out = await backend.rasterize(
        [{ id: 'a', html: '<p>甲</p>' }, { id: 'b', html: '<p>乙</p>' }, { id: 'c', html: '<p>丙</p>' }],
        { dpi: 300 },
    );

    // Assert
    assert.equal(seen.file, process.execPath);
    assert.ok(seen.args[0].endsWith(path.join('raster', 'electron-raster-worker.js')));
    assert.ok(seen.args[1].endsWith('jobs.json'));
    assert.equal(seen.args[2], path.join(seen.workDir, 'out'));
    assert.equal(seen.args[3], path.join(seen.workDir, 'profile'));
    assert.equal(Object.prototype.hasOwnProperty.call(seen.env, 'ELECTRON_RUN_AS_NODE'), false);
    assert.ok(path.basename(seen.workDir).startsWith(TEMP_PREFIX));
    assert.equal(seen.jobs.version, 1);
    assert.equal(seen.jobs.dpi, 300);
    assert.deepEqual(seen.fragments, [['a', true, '<p>甲</p>'], ['b', true, '<p>乙</p>'], ['c', true, '<p>丙</p>']]);
    assert.deepEqual(out.get('a'), FAKE_PNG);
    assert.equal(out.get('b').message, '模拟失败');
    assert.match(out.get('c').message, /未返回该任务的结果/);
    assert.equal(fs.existsSync(seen.workDir), false, '工作目录应被清理');
});

test('工作进程退出异常时抛含退出码与 stderr 摘要的错误；退出正常但未写 results.json 时抛错', async () => {
    backend._setDeps({ electronPath: process.execPath, spawn: stubSpawn({ code: 1, stderr: '[raster-worker] 模拟崩溃\n' }) });
    await silenceConsoleError(() => assert.rejects(
        () => backend.rasterize([{ id: 'a', html: '<p>x</p>' }]),
        (err) => err.message.includes('Electron 栅格工作进程退出异常（code=1）') && err.message.includes('模拟崩溃'),
    ));

    backend._setDeps({ spawn: stubSpawn() });
    await assert.rejects(() => backend.rasterize([{ id: 'a', html: '<p>x</p>' }]), /未写出 results\.json/);
});

test('工作进程超时被强制结束并抛出超时错误', async () => {
    // Arrange
    let child;
    backend._setDeps({
        electronPath: process.execPath,
        spawn: () => {
            child = fakeChild();
            return child;
        },
    });

    // Act & Assert
    await assert.rejects(() => backend.rasterize([{ id: 'a', html: '<p>x</p>' }], { timeoutMs: 50 }), /Electron 栅格工作进程超时/);
    assert.equal(child.killed, true, '超时后应 kill 子进程');
});

test('真实 electron 出图：PNG 像素 = CSS 像素 × 3.125 且内容为黑色方块，表格片段可出图，临时目录被清理', { timeout: REAL_TEST_TIMEOUT_MS }, async (t) => {
    if (!getElectronPath()) {
        t.skip('本机未安装 electron 二进制');
        return;
    }
    // Arrange
    const spy = spyRasterTempDirs();
    const table = createTable(null, [
        createTableRow([createTableCell('项目'), createTableCell('数值')]),
        createTableRow([createTableCell('宽度'), createTableCell('12.5')]),
    ]);

    // Act
    let out;
    try {
        out = await backend.rasterize([{ id: 'box', html: BOX_FRAGMENT }, { id: 'table-1', html: buildTableFragment(table) }], { dpi: 300 });
    } catch (err) {
        if (isSpawnBlocked(err)) {
            t.skip(`当前环境无法 spawn Electron：${err.message}`);
            return;
        }
        throw err;
    } finally {
        spy.restore();
    }

    // Assert
    const box = out.get('box');
    assert.ok(Buffer.isBuffer(box), box instanceof Error ? box.message : '应返回 Buffer');
    const size = pngSize(box);
    assert.deepEqual(size, { width: Math.round(BOX_CSS.width * TARGET_SCALE), height: Math.round(BOX_CSS.height * TARGET_SCALE) });
    const { Jimp } = await loadJimp();
    const image = await Jimp.read(box);
    const center = ((Math.floor(size.height / 2) * size.width) + Math.floor(size.width / 2)) * 4;
    const [r, g, b] = image.bitmap.data.subarray(center, center + 3);
    assert.ok(r < 16 && g < 16 && b < 16, `中心像素应为黑色，实际 ${r},${g},${b}`);

    const tablePng = out.get('table-1');
    assert.ok(Buffer.isBuffer(tablePng), tablePng instanceof Error ? tablePng.message : '表格应返回 Buffer');
    const tableSize = pngSize(tablePng);
    assert.ok(tableSize.width > 100 && tableSize.height > 30, JSON.stringify(tableSize));
    assert.equal(spy.created.length, 1, '本次 rasterize 应建且只建一个栅格工作目录');
    assert.equal(fs.existsSync(spy.created[0]), false, '工作目录应被清理');
});
