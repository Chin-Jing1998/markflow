/**
 * converters/pdf/backend.js 与 electron/pdf-printer.js 单元测试
 * 覆盖：非 Electron 进程内打印器不可用、本机探测（electron-worker）、真实工作进程出图、
 *       注入 mock 的 electron 主进程/soffice 分支、三级皆无时的中文错误、工作进程异常与超时、
 *       错误文案脱敏（仅首行 + 路径替换为 <path>）、残留临时目录清理
 */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const backend = require('../converters/pdf/backend');
const printer = require('../electron/pdf-printer');

const MOCK_PDF = Buffer.from('%PDF-1.4 mock-pdf');
const MOCK_DOCX = Buffer.from('PKmock-docx');
const WORKER_TEST_TIMEOUT_MS = 30000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
    backend._reset();
});

// ============================================================
// 辅助
// ============================================================

function getElectronPath() {
    try {
        const mod = require('electron');
        return typeof mod === 'string' && fs.existsSync(mod) ? mod : null;
    } catch (err) {
        return null;
    }
}

function isSpawnBlocked(err) {
    if (!err) return false;
    return err.code === 'ELECTRON_SPAWN_FAILED' || /sandbox|seatbelt|EPERM|EACCES/i.test(String(err.message));
}

function countWorkerTempDirs() {
    return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('markflow-pdf-worker-')).length;
}

function unavailablePrinter() {
    return {
        isAvailable: () => false,
        printToPdf: async () => {
            throw new Error('printer 不应被调用');
        },
    };
}

function unavailableSoffice() {
    return {
        isAvailable: async () => false,
        getInstallHint: () => 'MOCK_HINT_INSTALL',
        convertFile: async () => {
            throw new Error('soffice 不应被调用');
        },
    };
}

function fakeChild() {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
        child.killed = true;
    };
    return child;
}

// ============================================================
// 用例
// ============================================================

test('非 Electron 进程内 pdf-printer.isAvailable() 为 false 且 printToPdf 拒绝', async () => {
    assert.equal(printer.isAvailable(), false);
    await assert.rejects(() => printer.printToPdf('<p>x</p>'), /Electron 主进程/);
});

test('本机探测：存在 electron 二进制且非主进程时返回 electron-worker', async (t) => {
    if (!getElectronPath()) {
        t.skip('本机未安装 electron 二进制');
        return;
    }
    const result = await backend.detect();
    assert.equal(result.name, 'electron-worker');
    assert.equal(result.available, true);
    assert.equal(backend.isAvailableSync(), true);
});

test('electron-worker 真实出图：返回 %PDF 开头的 Buffer 并清理临时目录', { timeout: WORKER_TEST_TIMEOUT_MS }, async (t) => {
    if (!getElectronPath()) {
        t.skip('本机未安装 electron 二进制');
        return;
    }
    const before = countWorkerTempDirs();
    let pdf;
    try {
        pdf = await backend.renderPdf({ html: '<h1>你好</h1>' });
    } catch (err) {
        if (isSpawnBlocked(err)) {
            t.skip(`当前环境无法 spawn Electron：${err.message}`);
            return;
        }
        throw err;
    }
    assert.ok(Buffer.isBuffer(pdf));
    assert.equal(pdf.subarray(0, 4).toString('latin1'), '%PDF');
    assert.equal(countWorkerTempDirs(), before, '工作进程临时目录应被清理');
});

test('Electron 主进程后端优先：printer 可用时直接打印，不触碰其他后端', async () => {
    // Arrange
    const printed = [];
    backend._setDeps({
        printer: {
            isAvailable: () => true,
            printToPdf: async (html) => {
                printed.push(html);
                return MOCK_PDF;
            },
        },
        electronPath: null,
        soffice: {
            isAvailable: async () => {
                throw new Error('不应探测 soffice');
            },
            getInstallHint: () => '',
        },
    });

    // Act
    const detected = await backend.detect();
    const pdf = await backend.renderPdf({ html: '<p>主进程</p>' });

    // Assert
    assert.deepEqual(detected, { name: 'electron', available: true, hint: '' });
    assert.deepEqual(printed, ['<p>主进程</p>']);
    assert.equal(pdf, MOCK_PDF);
});

test('soffice 分支：调用 getDocxBuffer，写入 DOCX 后经 convertFile 得到 PDF', async () => {
    // Arrange
    const calls = [];
    const soffice = {
        isAvailable: async () => true,
        getInstallHint: () => 'MOCK_HINT_INSTALL',
        convertFile: async (inputPath, targetExt, opts) => {
            calls.push({ inputPath, targetExt, outDir: opts.outDir, content: fs.readFileSync(inputPath) });
            const outPath = path.join(opts.outDir, 'document.pdf');
            fs.writeFileSync(outPath, MOCK_PDF);
            return outPath;
        },
    };
    backend._setDeps({ printer: unavailablePrinter(), electronPath: null, soffice });
    let docxCalls = 0;
    const getDocxBuffer = async () => {
        docxCalls += 1;
        return MOCK_DOCX;
    };

    // Act
    const detected = await backend.detect();
    const pdf = await backend.renderPdf({ html: '<p>soffice</p>', getDocxBuffer });

    // Assert
    assert.equal(detected.name, 'soffice');
    assert.equal(docxCalls, 1, 'getDocxBuffer 应被调用一次');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].targetExt, 'pdf');
    assert.ok(calls[0].inputPath.endsWith('.docx'));
    assert.equal(calls[0].outDir, path.dirname(calls[0].inputPath));
    assert.deepEqual(calls[0].content, MOCK_DOCX, '写入的 DOCX 内容应与 getDocxBuffer 返回一致');
    assert.deepEqual(pdf, MOCK_PDF);
    assert.equal(fs.existsSync(calls[0].inputPath), false, 'soffice 临时目录应被清理');
});

test('三级后端皆不可用时抛中文错误并附安装提示', async () => {
    // Arrange
    backend._setDeps({ printer: unavailablePrinter(), electronPath: null, soffice: unavailableSoffice() });

    // Act
    const detected = await backend.detect();

    // Assert
    assert.equal(detected.name, null);
    assert.equal(detected.available, false);
    assert.ok(detected.hint.includes('MOCK_HINT_INSTALL'));
    assert.equal(backend.isAvailableSync(), false);
    await assert.rejects(
        () => backend.renderPdf({ html: '<p>x</p>', getDocxBuffer: async () => MOCK_DOCX }),
        (err) => err.message.includes('PDF 输出不可用') && err.message.includes('MOCK_HINT_INSTALL'),
    );
});

test('工作进程退出异常时抛出含退出码与 stderr 摘要的错误', async () => {
    // Arrange
    const spawnCalls = [];
    backend._setDeps({
        printer: unavailablePrinter(),
        electronPath: process.execPath,
        soffice: unavailableSoffice(),
        spawn: (file, args, options) => {
            spawnCalls.push({ file, args, options });
            const child = fakeChild();
            setImmediate(() => {
                child.stderr.emit('data', '[pdf-worker] 模拟崩溃');
                child.emit('exit', 2, null);
            });
            return child;
        },
    });

    // Act & Assert
    await assert.rejects(
        () => backend.renderPdf({ html: '<p>x</p>' }),
        (err) => err.message.includes('code=2') && err.message.includes('模拟崩溃'),
    );
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].file, process.execPath);
    assert.ok(spawnCalls[0].args[0].endsWith(path.join('electron', 'pdf-worker.js')));
    assert.ok(spawnCalls[0].args[1].endsWith('index.html'));
    assert.ok(spawnCalls[0].args[2].endsWith('output.pdf'));
    assert.equal(Object.prototype.hasOwnProperty.call(spawnCalls[0].options.env, 'ELECTRON_RUN_AS_NODE'), false);
});

test('用户可见错误只取 stderr 首行并把绝对路径脱敏为 <path>，完整 stderr 走 console.error', async () => {
    // Arrange：真实崩溃时 stderr 是带绝对路径的多行调用栈
    const rawStderr = [
        "[pdf-worker] Error: ENOENT: no such file or directory, open '/Users/someone/编程项目工作站/知识库文件转换程序/tmp/index.html'",
        '    at printFile (/Users/someone/编程项目工作站/知识库文件转换程序/electron/pdf-worker.js:63:39)',
        '    at async main (/Users/someone/编程项目工作站/知识库文件转换程序/electron/pdf-worker.js:79:5)',
    ].join('\n');
    const logged = [];
    const originalError = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    backend._setDeps({
        printer: unavailablePrinter(),
        electronPath: process.execPath,
        soffice: unavailableSoffice(),
        spawn: () => {
            const child = fakeChild();
            setImmediate(() => {
                child.stderr.emit('data', rawStderr);
                child.emit('exit', 1, null);
            });
            return child;
        },
    });

    // Act
    let message = '';
    try {
        await backend.renderPdf({ html: '<p>x</p>' });
        assert.fail('应当抛错');
    } catch (err) {
        message = err.message;
    } finally {
        console.error = originalError;
    }

    // Assert
    assert.ok(message.includes('code=1'), '保留退出码');
    assert.ok(message.includes('ENOENT: no such file or directory'), '保留首行的原因说明');
    assert.ok(!message.includes('    at '), '不得带调用栈');
    assert.ok(!message.includes('/Users/someone'), '不得泄露绝对路径');
    assert.ok(!message.includes('pdf-worker.js:63'), '不得泄露源码行号');
    assert.ok(message.includes('<path>'), '路径应替换为 <path> 占位');
    assert.equal(logged.length, 1, '完整 stderr 应写一次日志');
    assert.ok(logged[0].includes('/Users/someone'), '日志侧保留完整路径以便排障');
});

test('工作进程超时被强制结束并抛出超时错误', async () => {
    // Arrange
    let child;
    backend._setDeps({
        printer: unavailablePrinter(),
        electronPath: process.execPath,
        soffice: unavailableSoffice(),
        workerTimeoutMs: 50,
        spawn: () => {
            child = fakeChild();
            return child;
        },
    });

    // Act & Assert
    await assert.rejects(() => backend.renderPdf({ html: '<p>x</p>' }), /超时/);
    assert.equal(child.killed, true, '超时后应 kill 子进程');
});

test('pdf-printer 清理超过 1 天的 markflow-pdf-* 残留目录，保留新目录', async () => {
    // Arrange
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-pdf-stale-'));
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-pdf-fresh-'));
    const twoDaysAgo = new Date(Date.now() - 2 * ONE_DAY_MS);
    fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);

    try {
        // Act
        const removed = await printer._cleanupStaleTempDirs();

        // Assert
        assert.ok(removed >= 1);
        assert.equal(fs.existsSync(stale), false, '过期目录应被删除');
        assert.equal(fs.existsSync(fresh), true, '新目录应保留');
    } finally {
        fs.rmSync(stale, { recursive: true, force: true });
        fs.rmSync(fresh, { recursive: true, force: true });
    }
});
