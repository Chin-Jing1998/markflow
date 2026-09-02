/**
 * server/soffice.js 单元测试
 * 覆盖：探测缺失时的中文安装提示、命令行参数构造、独立 UserInstallation profile 的建与删、
 *       多次调用串行排队、转换失败与产物缺失的错误信息、参数校验、探测结果缓存
 *
 * 全程用 _setDetect / _setExecFile 注入假实现，不依赖本机是否安装 LibreOffice。
 */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const soffice = require('../server/soffice');

const FAKE_SOFFICE = '/fake/bin/soffice';

afterEach(() => {
    soffice._reset();
});

// ============================================================
// 夹具
// ============================================================

function makeTempDir(prefix = 'markflow-soffice-test-') {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeInputFile(name = '旧文档.doc') {
    const dir = makeTempDir();
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, 'dummy');
    return { dir, filePath };
}

/** 从参数数组里取 --outdir 的值 */
function readOutDir(args) {
    return args[args.indexOf('--outdir') + 1];
}

/** 从参数数组里取 -env:UserInstallation=file:// 后的目录 */
function readProfileDir(args) {
    const hit = args.find((a) => a.startsWith('-env:UserInstallation=file://'));
    return hit ? hit.replace('-env:UserInstallation=file://', '') : null;
}

/** 按 soffice 的产物命名规则写出目标文件 */
function writeExpectedOutput(args) {
    const inputPath = args[args.length - 1];
    const targetExt = args[args.indexOf('--convert-to') + 1];
    const outPath = path.join(
        readOutDir(args),
        `${path.basename(inputPath, path.extname(inputPath))}.${targetExt}`,
    );
    fs.writeFileSync(outPath, 'converted');
    return outPath;
}

// ============================================================
// 用例：探测缺失
// ============================================================

test('探测不到 soffice 时 isAvailable 为 false，convertFile 抛出含安装提示的中文错误', async () => {
    // Arrange
    soffice._setDetect(async () => null);
    const { filePath } = makeInputFile();
    const outDir = makeTempDir();

    // Act & Assert
    assert.equal(await soffice.isAvailable(), false);
    assert.equal(await soffice.detectSoffice(), null);
    await assert.rejects(
        () => soffice.convertFile(filePath, 'docx', { outDir }),
        (err) => {
            assert.match(err.message, /需要 LibreOffice 才能转换该格式/);
            assert.ok(
                err.message.includes(soffice.getInstallHint()),
                `错误信息应含安装提示，实际为：${err.message}`,
            );
            return true;
        },
    );
});

test('getInstallHint 给出当前平台的中文安装指引', () => {
    // Arrange & Act
    const hint = soffice.getInstallHint();

    // Assert
    assert.match(hint, /libreoffice\.org/);
    assert.ok(/macOS|Windows|Linux/.test(hint));
});

test('探测失败结果被缓存，force 可强制重探', async () => {
    // Arrange
    let probeCount = 0;
    soffice._setDetect(async () => {
        probeCount += 1;
        return null;
    });

    // Act
    await soffice.isAvailable();
    await soffice.isAvailable();
    const cachedCount = probeCount;
    await soffice.detectSoffice({ force: true });

    // Assert
    assert.equal(cachedCount, 1, '失败结果应在 TTL 内复用缓存');
    assert.equal(probeCount, 2, 'force 应触发重新探测');
});

test('探测成功结果被缓存，后续调用不再重复探测', async () => {
    // Arrange
    let probeCount = 0;
    soffice._setDetect(async () => {
        probeCount += 1;
        return FAKE_SOFFICE;
    });

    // Act
    const first = await soffice.detectSoffice();
    const second = await soffice.detectSoffice();

    // Assert
    assert.equal(first, FAKE_SOFFICE);
    assert.equal(second, FAKE_SOFFICE);
    assert.equal(probeCount, 1);
});

// ============================================================
// 用例：命令行参数与临时 profile
// ============================================================

test('转换命令含 --headless、--convert-to 与独立 UserInstallation profile', async () => {
    // Arrange
    const calls = [];
    let profileExistedDuringCall = false;
    soffice._setDetect(async () => FAKE_SOFFICE);
    soffice._setExecFile((file, args, options, cb) => {
        calls.push({ file, args, options });
        profileExistedDuringCall = fs.existsSync(readProfileDir(args));
        writeExpectedOutput(args);
        cb(null, '', '');
    });
    const { filePath } = makeInputFile('旧文档.doc');
    const outDir = path.join(makeTempDir(), 'nested-out'); // 故意不预先创建

    // Act
    const result = await soffice.convertFile(filePath, 'docx', { outDir });

    // Assert
    assert.equal(calls.length, 1);
    const { file, args, options } = calls[0];
    assert.equal(file, FAKE_SOFFICE);
    assert.ok(args.includes('--headless'));
    assert.ok(args.includes('--norestore'));
    assert.equal(args[args.indexOf('--convert-to') + 1], 'docx');
    assert.equal(readOutDir(args), outDir);
    assert.equal(args[args.length - 1], filePath);
    assert.ok(options.timeout > 0, 'execFile 应带超时');

    const profileDir = readProfileDir(args);
    assert.ok(profileDir, '必须传入 -env:UserInstallation=file://<dir>');
    assert.ok(profileExistedDuringCall, '转换期间临时 profile 目录应存在');
    assert.equal(fs.existsSync(profileDir), false, '转换结束后临时 profile 应被删除');

    assert.equal(result, path.join(outDir, '旧文档.docx'));
    assert.equal(fs.existsSync(result), true);
    assert.equal(fs.existsSync(outDir), true, 'outDir 不存在时应自动创建');
});

test('转换失败时临时 profile 同样被清理', async () => {
    // Arrange
    let profileDir = null;
    soffice._setDetect(async () => FAKE_SOFFICE);
    soffice._setExecFile((file, args, options, cb) => {
        profileDir = readProfileDir(args);
        const err = new Error('spawn failed');
        err.stderr = 'boom';
        cb(err, '', 'boom');
    });
    const { filePath } = makeInputFile();
    const outDir = makeTempDir();

    // Act & Assert
    await assert.rejects(() => soffice.convertFile(filePath, 'docx', { outDir }));
    assert.equal(fs.existsSync(profileDir), false);
});

// ============================================================
// 用例：串行队列
// ============================================================

test('多次 convertFile 串行执行，第二次开始不早于第一次结束', async () => {
    // Arrange
    const events = [];
    soffice._setDetect(async () => FAKE_SOFFICE);
    soffice._setExecFile((file, args, options, cb) => {
        const id = path.basename(args[args.length - 1]);
        events.push({ type: 'start', id, at: Date.now() });
        setTimeout(() => {
            writeExpectedOutput(args);
            events.push({ type: 'end', id, at: Date.now() });
            cb(null, '', '');
        }, 40);
    });
    const a = makeInputFile('甲.doc');
    const b = makeInputFile('乙.doc');
    const outDir = makeTempDir();

    // Act
    const results = await Promise.all([
        soffice.convertFile(a.filePath, 'docx', { outDir }),
        soffice.convertFile(b.filePath, 'docx', { outDir }),
    ]);

    // Assert
    assert.deepEqual(
        events.map((e) => `${e.type}:${e.id}`),
        ['start:甲.doc', 'end:甲.doc', 'start:乙.doc', 'end:乙.doc'],
    );
    assert.ok(
        events[2].at >= events[1].at,
        `第二次开始 ${events[2].at} 应不早于第一次结束 ${events[1].at}`,
    );
    assert.deepEqual(results, [
        path.join(outDir, '甲.docx'),
        path.join(outDir, '乙.docx'),
    ]);
});

test('前一个任务失败不阻断队列，后一个仍会执行', async () => {
    // Arrange
    let call = 0;
    soffice._setDetect(async () => FAKE_SOFFICE);
    soffice._setExecFile((file, args, options, cb) => {
        call += 1;
        if (call === 1) {
            cb(new Error('第一次失败'), '', '');
            return;
        }
        writeExpectedOutput(args);
        cb(null, '', '');
    });
    const a = makeInputFile('甲.doc');
    const b = makeInputFile('乙.doc');
    const outDir = makeTempDir();

    // Act
    const settled = await Promise.allSettled([
        soffice.convertFile(a.filePath, 'docx', { outDir }),
        soffice.convertFile(b.filePath, 'docx', { outDir }),
    ]);

    // Assert
    assert.equal(settled[0].status, 'rejected');
    assert.equal(settled[1].status, 'fulfilled');
    assert.equal(settled[1].value, path.join(outDir, '乙.docx'));
});

// ============================================================
// 用例：错误信息
// ============================================================

test('soffice 退出异常时错误含文件名、目标格式与 stderr 摘要', async () => {
    // Arrange
    soffice._setDetect(async () => FAKE_SOFFICE);
    soffice._setExecFile((file, args, options, cb) => {
        const err = new Error('Command failed');
        err.stderr = 'Error: source file could not be loaded';
        cb(err, '', err.stderr);
    });
    const { filePath } = makeInputFile('损坏文件.doc');
    const outDir = makeTempDir();

    // Act & Assert
    await assert.rejects(
        () => soffice.convertFile(filePath, 'docx', { outDir }),
        (err) => {
            assert.match(err.message, /soffice 转换失败/);
            assert.match(err.message, /损坏文件\.doc/);
            assert.match(err.message, /docx/);
            assert.match(err.message, /source file could not be loaded/);
            return true;
        },
    );
});

test('soffice 声称成功但未产出目标文件时抛错，并列出实际产物', async () => {
    // Arrange
    soffice._setDetect(async () => FAKE_SOFFICE);
    soffice._setExecFile((file, args, options, cb) => {
        // 写一个名字不对的产物，模拟 soffice 静默失败
        fs.writeFileSync(path.join(readOutDir(args), 'unexpected.txt'), 'x');
        cb(null, '', 'some warning');
    });
    const { filePath } = makeInputFile('演示.ppt');
    const outDir = makeTempDir();

    // Act & Assert
    await assert.rejects(
        () => soffice.convertFile(filePath, 'pptx', { outDir }),
        (err) => {
            assert.match(err.message, /soffice 未生成预期文件/);
            assert.match(err.message, /演示\.pptx/);
            assert.match(err.message, /unexpected\.txt/);
            return true;
        },
    );
});

// ============================================================
// 用例：参数校验
// ============================================================

test('缺少 inputPath / targetExt / outDir 时抛出中文错误', async () => {
    // Arrange
    soffice._setDetect(async () => FAKE_SOFFICE);
    const outDir = makeTempDir();

    // Act & Assert
    await assert.rejects(
        () => soffice.convertFile('', 'docx', { outDir }),
        /需要 inputPath/,
    );
    await assert.rejects(
        () => soffice.convertFile('/tmp/a.doc', '', { outDir }),
        /需要 targetExt/,
    );
    await assert.rejects(
        () => soffice.convertFile('/tmp/a.doc', 'docx', {}),
        /需要 options\.outDir/,
    );
});

test('导出的公开 API 齐备', () => {
    // Assert
    for (const name of ['detectSoffice', 'isAvailable', 'getInstallHint', 'convertFile']) {
        assert.equal(typeof soffice[name], 'function', `应导出 ${name}`);
    }
});

// ============================================================
// 用例：旧二进制格式 parser 的委派闭环（xls → xlsx、ppt → pptx）
// ============================================================

/** 假 soffice：把预置的新格式文件内容写成 soffice 应产出的文件名 */
function stubConvertWith(content, capture) {
    soffice._setDetect(async () => FAKE_SOFFICE);
    soffice._setExecFile((file, args, options, cb) => {
        if (capture) capture.outDir = readOutDir(args);
        const inputPath = args[args.length - 1];
        const targetExt = args[args.indexOf('--convert-to') + 1];
        fs.writeFileSync(
            path.join(
                readOutDir(args),
                `${path.basename(inputPath, path.extname(inputPath))}.${targetExt}`,
            ),
            content,
        );
        cb(null, '', '');
    });
}

test('xls parser 经 soffice 转 xlsx 后委派解析，临时目录用完即删且保留原文件名', async () => {
    // Arrange
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('旧表');
    ws.addRow(['列一', '列二']);
    ws.addRow([1, 2]);
    const xlsxBuffer = await wb.xlsx.writeBuffer();

    const capture = {};
    stubConvertWith(Buffer.from(xlsxBuffer), capture);
    const { filePath } = makeInputFile('历史台账.xls');

    // Act
    const doc = await require('../converters/parsers/xls').parse({ path: filePath });

    // Assert
    assert.equal(doc.kind, 'workbook');
    assert.equal(doc.meta.sourceName, '历史台账.xls', 'sourceName 应保留原始文件名');
    assert.equal(doc.meta.title, '历史台账');
    assert.equal(doc.data.sheets.length, 1);
    assert.equal(doc.data.sheets[0].name, '旧表');
    assert.equal(fs.existsSync(capture.outDir), false, '中间产物目录应被清理');
});

test('ppt parser 经 soffice 转 pptx 后委派解析，临时目录用完即删', async () => {
    // Arrange
    const JSZip = require('jszip');
    const ns =
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
        'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
    const zip = new JSZip();
    zip.file(
        'ppt/slides/slide1.xml',
        `<?xml version="1.0" encoding="UTF-8"?><p:sld ${ns}><p:cSld><p:spTree><p:sp>` +
            '<p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
            '<p:txBody><a:p><a:r><a:t>旧版幻灯片</a:t></a:r></a:p></p:txBody>' +
            '</p:sp></p:spTree></p:cSld></p:sld>',
    );
    const pptxBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    const capture = {};
    stubConvertWith(pptxBuffer, capture);
    const { filePath } = makeInputFile('旧版汇报.ppt');

    // Act
    const doc = await require('../converters/parsers/ppt').parse({ path: filePath });

    // Assert
    assert.equal(doc.kind, 'presentation');
    assert.equal(doc.meta.sourceName, '旧版汇报.ppt');
    assert.equal(doc.data.slides[0].title, '旧版幻灯片');
    assert.equal(fs.existsSync(capture.outDir), false, '中间产物目录应被清理');
});

test('soffice 不可用时，旧二进制 parser 透传含安装提示的中文错误', async () => {
    // Arrange
    soffice._setDetect(async () => null);
    const { filePath } = makeInputFile('历史台账.xls');

    // Act & Assert
    await assert.rejects(
        () => require('../converters/parsers/xls').parse({ path: filePath }),
        /需要 LibreOffice 才能转换该格式/,
    );
});

test('旧二进制 parser 缺少 input.path 时抛出中文错误', async () => {
    // Act & Assert
    await assert.rejects(
        () => require('../converters/parsers/doc').parse({}),
        /parsers\/doc 需要 input\.path/,
    );
    await assert.rejects(
        () => require('../converters/parsers/xls').parse({}),
        /parsers\/xls 需要 input\.path/,
    );
    await assert.rejects(
        () => require('../converters/parsers/ppt').parse({}),
        /parsers\/ppt 需要 input\.path/,
    );
});
