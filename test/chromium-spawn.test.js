/**
 * converters/chromium/spawn.js 单元测试
 * 覆盖：env 清洗（ELECTRON_RUN_AS_NODE / NODE_OPTIONS）、超时 SIGKILL 与 timedOut 结果、
 *       stderr 噪声过滤 + 跨 chunk 拼行 + 首行脱敏摘要、stdout 收集与限长、只发 exit 不发 close 的假子进程、
 *       spawn 失败的 ELECTRON_SPAWN_FAILED、assertExitOk 的中文错误、真实 electron --version（无 electron 时跳过）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
    spawnElectron, assertExitOk, scrubEnv, getElectronPath, SPAWN_FAILED_CODE,
} = require('../converters/chromium/spawn');

const OUTPUT_LIMIT = 4096;

// ============================================================
// 辅助
// ============================================================

function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = (signal) => {
        child.killed = true;
        child.killSignal = signal;
    };
    return child;
}

/** 下一轮事件循环里输出并退出的假子进程；withClose 为假时只发 exit */
function exitingChild({ stdout = [], stderr = [], code = 0, signal = null, withClose = true } = {}) {
    const child = fakeChild();
    setImmediate(() => {
        stdout.forEach((chunk) => child.stdout.emit('data', chunk));
        stderr.forEach((chunk) => child.stderr.emit('data', chunk));
        child.emit('exit', code, signal);
        if (withClose) child.emit('close', code, signal);
    });
    return child;
}

function withEnv(patch, fn) {
    const saved = {};
    for (const [key, value] of Object.entries(patch)) {
        saved[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    const restore = () => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
    return Promise.resolve().then(fn).finally(restore);
}

function captureConsoleError(fn) {
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    try {
        fn();
    } finally {
        console.error = original;
    }
    return logged;
}

// ============================================================
// 用例
// ============================================================

test('env 清洗：剔除 ELECTRON_RUN_AS_NODE / NODE_OPTIONS，其余变量与 stdio 设置原样传给 spawn', async () => {
    // Arrange
    const calls = [];
    const spawn = (file, args, options) => {
        calls.push({ file, args, options });
        return exitingChild();
    };

    // Act
    const result = await withEnv({ ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--max-old-space-size=64', MF_KEEP: 'yes' }, () =>
        spawnElectron('/fake/electron', ['worker.js', 7], { spawn }));
    const explicit = await spawnElectron('/fake/electron', [], { spawn, env: { ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', ONLY: '1' } });

    // Assert
    assert.equal(result.code, 0);
    assert.equal(explicit.code, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].file, '/fake/electron');
    assert.deepEqual(calls[0].args, ['worker.js', '7'], '参数一律转为字符串');
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0].options.env, 'ELECTRON_RUN_AS_NODE'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0].options.env, 'NODE_OPTIONS'), false);
    assert.equal(calls[0].options.env.MF_KEEP, 'yes', '其余环境变量保留');
    assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(calls[0].options.windowsHide, true);
    assert.deepEqual(calls[1].options.env, { ONLY: '1' }, '显式 env 同样清洗');
    assert.deepEqual(scrubEnv({ ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1', NODE_OPTIONS: 'x', KEEP: 'y' }), { KEEP: 'y' });
});

test('超时：SIGKILL 子进程并立即以 timedOut 结束，assertExitOk 抛「超时」', async () => {
    // Arrange
    let child;
    const spawn = () => {
        child = fakeChild();
        return child;
    };

    // Act
    const result = await spawnElectron('/fake/electron', [], { timeoutMs: 30, spawn });

    // Assert
    assert.equal(result.timedOut, true);
    assert.equal(result.code, null);
    assert.equal(result.signal, 'SIGKILL');
    assert.equal(result.timeoutMs, 30);
    assert.equal(child.killed, true);
    assert.equal(child.killSignal, 'SIGKILL');
    assert.throws(() => assertExitOk(result, '测试进程'), /^Error: 测试进程超时（\d+s），已强制结束$/);
});

test('stderr：过滤噪声行、跨 chunk 拼行、摘要只取首行并脱敏路径；assertExitOk 记录完整 stderr 并抛含退出码的错误', async () => {
    // Arrange：噪声行与真实错误交错，且真实错误行被 chunk 边界切开
    const chunks = [
        'sandbox_extension_issue_file failed for /private/tmp/x (Operation not permitted)\n[raster-',
        "worker] Error: ENOENT: no such file or directory, open '/Users/someone/proj/a.html'\n"
        + '    at renderJob (/Users/someone/proj/worker.js:10:5)\n'
        + '+[IMKClient subclass]: chose IMKClient_Modern\n',
    ];

    // Act
    const result = await spawnElectron('/fake/electron', [], { spawn: () => exitingChild({ stderr: chunks, code: 3 }) });
    let message = '';
    const logged = captureConsoleError(() => {
        try {
            assertExitOk(result, 'X 进程');
        } catch (err) {
            message = err.message;
        }
    });

    // Assert
    assert.equal(result.code, 3);
    assert.equal(result.timedOut, false);
    assert.ok(!result.stderr.includes('sandbox_extension_issue_file'), '噪声行不进 stderr');
    assert.ok(!result.stderr.includes('IMKClient'), '输入法噪声不进 stderr');
    assert.ok(result.stderr.startsWith('[raster-worker] Error: ENOENT'), '跨 chunk 的行应拼回完整');
    assert.ok(result.stderr.includes('    at renderJob (/Users/someone/proj/worker.js:10:5)'), '完整 stderr 保留调用栈');
    assert.ok(result.stderrSummary.startsWith('[raster-worker] Error: ENOENT: no such file or directory, open'), '摘要取首个非噪声行');
    assert.ok(result.stderrSummary.includes('<path>'), '摘要中的绝对路径脱敏');
    assert.ok(!result.stderrSummary.includes('/Users/someone'));
    assert.ok(!result.stderrSummary.includes('    at '));
    assert.ok(message.startsWith('X 进程退出异常（code=3）：[raster-worker] Error: ENOENT'), message);
    assert.ok(!message.includes('/Users/someone'), '用户可见错误不泄露路径');
    assert.equal(logged.length, 1, '完整 stderr 写一次日志');
    assert.ok(logged[0].includes('/Users/someone/proj/worker.js:10:5'), '日志侧保留完整路径');
});

test('被信号终止时错误文案附 signal；只发 exit 不发 close 的子进程也能结束', async () => {
    // Act
    const killed = await spawnElectron('/fake/electron', [], { spawn: () => exitingChild({ code: null, signal: 'SIGSEGV' }) });
    const noClose = await spawnElectron('/fake/electron', [], { spawn: () => exitingChild({ stdout: ['done\n'], withClose: false }) });

    // Assert
    assert.equal(killed.signal, 'SIGSEGV');
    captureConsoleError(() => {
        assert.throws(() => assertExitOk(killed, 'X'), /X退出异常（code=null, signal=SIGSEGV）：无 stderr 输出/);
    });
    assert.equal(noClose.code, 0);
    assert.equal(noClose.stdout, 'done\n');
});

test('stdout 按行收集；stdout / stderr 各自封顶 4096 字符；退出码 0 时 assertExitOk 静默返回', async () => {
    // Arrange
    const big = `${'x'.repeat(100)}\n`.repeat(100);

    // Act
    const result = await spawnElectron('/fake/electron', [], { spawn: () => exitingChild({ stdout: ['v44.3.0\n', big], stderr: [big] }) });

    // Assert
    assert.ok(result.stdout.startsWith('v44.3.0\n'));
    assert.ok(result.stdout.length <= OUTPUT_LIMIT);
    assert.ok(result.stderr.length <= OUTPUT_LIMIT);
    assert.equal(assertExitOk(result, 'X'), undefined);
});

test('spawn 抛错或触发 error 事件 → reject，code 为 ELECTRON_SPAWN_FAILED', async () => {
    await assert.rejects(
        () => spawnElectron('/fake/electron', [], { spawn: () => { throw new Error('spawn ENOENT'); } }),
        (err) => err.code === SPAWN_FAILED_CODE && err.message.includes('无法启动 Electron 子进程') && err.message.includes('spawn ENOENT'),
    );
    await assert.rejects(
        () => spawnElectron('/fake/electron', [], {
            spawn: () => {
                const child = fakeChild();
                setImmediate(() => child.emit('error', new Error('EACCES')));
                return child;
            },
        }),
        (err) => err.code === SPAWN_FAILED_CODE && err.message.includes('EACCES'),
    );
});

test('assertExitOk 拒绝非法结果对象', () => {
    assert.throws(() => assertExitOk(null, 'X'), /X未返回执行结果/);
});

test('真实 electron：--version 输出版本号到 stdout 并以 0 退出', { timeout: 30000 }, async (t) => {
    const electronPath = getElectronPath();
    assert.ok(electronPath === null || typeof electronPath === 'string');
    if (!electronPath) {
        t.skip('本机未安装 electron 二进制');
        return;
    }
    let result;
    try {
        result = await spawnElectron(electronPath, ['--version'], { timeoutMs: 20000 });
    } catch (err) {
        if (err.code === SPAWN_FAILED_CODE) {
            t.skip(`当前环境无法 spawn Electron：${err.message}`);
            return;
        }
        throw err;
    }
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^v\d+\.\d+\.\d+/);
});
