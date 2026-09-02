/**
 * bin/markflow.js 命令行集成测试
 *
 * 以子进程方式调用真实 CLI，断言 stdout/stderr 分流与退出码。
 * 覆盖：help/version、formats、convert 的默认目标与显式目标、参数错误（1）、失败项（2）、
 *       输出目录解析（--out / MARKFLOW_OUTPUT_DIR）、人类模式与 --json 模式的输出分流。
 * 临时产物一律写入 os.tmpdir()。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'markflow.js');
const SAMPLE_MD = path.join(ROOT, 'test', 'fixtures', 'sample.md');
const SAMPLE_PDF = path.join(ROOT, 'test', 'fixtures', 'sample.pdf');
const PKG_VERSION = require('../package.json').version;

let tmpDir;

before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-cli-'));
});

after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 运行 CLI 并收集 stdout/stderr 与退出码
function runCli(args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [CLI, ...args], {
            cwd: options.cwd || ROOT,
            env: { ...process.env, ...(options.env || {}) },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

// --json 模式下 stdout 必须恰好是一行 JSON
function parseSingleLineJson(stdout) {
    const lines = stdout.split('\n').filter((line) => line !== '');
    assert.equal(lines.length, 1, `stdout 应恰好一行，实际 ${lines.length} 行：${stdout}`);
    return JSON.parse(lines[0]);
}

// ============================================================
// 用法与版本
// ============================================================

test('--help 打印用法到 stdout 并以 0 退出', async () => {
    const { code, stdout, stderr } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /用法：markflow <子命令>/);
    assert.match(stdout, /convert/);
    assert.match(stdout, /mcp/);
    assert.equal(stderr, '');
});

test('无子命令等同 --help，以 0 退出', async () => {
    const { code, stdout } = await runCli([]);
    assert.equal(code, 0);
    assert.match(stdout, /用法：markflow <子命令>/);
});

test('--version 输出 package.json 的版本号', async () => {
    const { code, stdout } = await runCli(['--version']);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), PKG_VERSION);
});

test('未知子命令以 1 退出并在 stderr 给出中文提示', async () => {
    const { code, stdout, stderr } = await runCli(['unknown-cmd']);
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /未知子命令：unknown-cmd/);
});

test('未知选项以 1 退出并在 stderr 给出参数错误', async () => {
    const { code, stderr } = await runCli(['convert', '--nope']);
    assert.equal(code, 1);
    assert.match(stderr, /参数错误：/);
});

// ============================================================
// formats
// ============================================================

test('formats --json 输出单行 JSON，含 targets 与 capabilities', async () => {
    const { code, stdout, stderr } = await runCli(['formats', '--json']);
    assert.equal(code, 0);
    assert.equal(stderr, '');
    const payload = parseSingleLineJson(stdout);
    assert.deepEqual(payload.targets.office, ['bundle']);
    assert.deepEqual(payload.targets.url, ['bundle']);
    assert.ok(payload.targets.markup.includes('docx'));
    assert.equal(typeof payload.capabilities.sofficeAvailable, 'boolean');
    assert.equal(typeof payload.capabilities.pdfBackend.available, 'boolean');
    assert.equal(typeof payload.capabilities.pdfBackend.hint, 'string');
    assert.equal(payload.version, PKG_VERSION);
});

test('formats 人类模式输出可读文本到 stdout', async () => {
    const { code, stdout } = await runCli(['formats']);
    assert.equal(code, 0);
    assert.match(stdout, /可用转换目标/);
    assert.match(stdout, /PDF 后端/);
});

// ============================================================
// convert：成功路径
// ============================================================

test('Markdown 显式转 docx：--json 输出单行 JSON，产物落盘，退出码 0', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'docx-'));

    // Act
    const { code, stdout, stderr } = await runCli(['convert', SAMPLE_MD, '--to', 'docx', '--out', outDir, '--json']);

    // Assert
    assert.equal(code, 0);
    assert.equal(stderr, '');
    const payload = parseSingleLineJson(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.outputDir, outDir);
    assert.equal(payload.errors.length, 0);
    assert.equal(payload.results.length, 1);
    const [item] = payload.results;
    assert.equal(item.input, SAMPLE_MD);
    assert.equal(item.target, 'docx');
    assert.equal(item.name, 'sample');
    assert.ok(fs.existsSync(item.outputPath));
    assert.equal(item.outputs.docx, item.outputPath);
    assert.deepEqual(item.warnings, []);
});

test('PDF 输入省略 --to 时默认转 bundle，产出 md 与 json', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'bundle-'));

    // Act
    const { code, stdout } = await runCli(['convert', SAMPLE_PDF, '--out', outDir, '--json']);

    // Assert
    assert.equal(code, 0);
    const payload = parseSingleLineJson(stdout);
    assert.equal(payload.ok, true);
    const [item] = payload.results;
    assert.equal(item.target, 'bundle');
    assert.ok(fs.existsSync(item.outputs.md));
    assert.ok(fs.existsSync(item.outputs.json));
});

test('人类模式：产物路径走 stdout，进度与汇总走 stderr', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'human-'));

    // Act
    const { code, stdout, stderr } = await runCli(['convert', SAMPLE_MD, '--out', outDir]);

    // Assert
    assert.equal(code, 0);
    assert.equal(stdout.trim(), path.join(outDir, 'sample.docx'));
    assert.match(stderr, /开始：.*sample\.md → docx/);
    assert.match(stderr, /完成：.*sample\.docx/);
    assert.match(stderr, /汇总：成功 1 项，失败 0 项/);
});

test('相对路径按当前工作目录解析，输出为绝对路径', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'relative-'));

    // Act
    const { code, stdout } = await runCli(['convert', 'test/fixtures/sample.md', '--out', outDir, '--json'], {
        cwd: ROOT,
    });

    // Assert
    assert.equal(code, 0);
    const payload = parseSingleLineJson(stdout);
    assert.equal(payload.results[0].input, 'test/fixtures/sample.md');
    assert.ok(path.isAbsolute(payload.results[0].outputPath));
});

test('多输入按 --concurrency 批量转换，结果按输入顺序返回', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'batch-'));

    // Act
    const { code, stdout } = await runCli([
        'convert',
        SAMPLE_MD,
        SAMPLE_PDF,
        '--out',
        outDir,
        '--concurrency',
        '2',
        '--json',
    ]);

    // Assert
    assert.equal(code, 0);
    const payload = parseSingleLineJson(stdout);
    assert.equal(payload.results.length, 2);
    assert.deepEqual(
        payload.results.map((item) => item.target),
        ['docx', 'bundle'],
    );
});

test('MARKFLOW_OUTPUT_DIR 在缺省 --out 时生效', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'env-'));

    // Act
    const { code, stdout } = await runCli(['convert', SAMPLE_MD, '--json'], { env: { MARKFLOW_OUTPUT_DIR: outDir } });

    // Assert
    assert.equal(code, 0);
    const payload = parseSingleLineJson(stdout);
    assert.equal(payload.outputDir, outDir);
});

// ============================================================
// convert：参数错误（退出码 1）
// ============================================================

test('convert 缺少输入时以 1 退出', async () => {
    const { code, stderr } = await runCli(['convert', '--out', tmpDir]);
    assert.equal(code, 1);
    assert.match(stderr, /convert 需要至少一个输入/);
});

test('目标与输入类型不匹配时以 1 退出，且不产生任何产物', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'mismatch-'));

    // Act
    const { code, stdout, stderr } = await runCli(['convert', SAMPLE_MD, '--to', 'bundle', '--out', outDir]);

    // Assert
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /目标 bundle 不接受 md 输入/);
    assert.deepEqual(fs.readdirSync(outDir), []);
});

test('输入文件不存在时以 1 退出并给出绝对路径', async () => {
    const { code, stdout, stderr } = await runCli(['convert', '不存在.md', '--json']);
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /输入文件不存在：/);
    assert.match(stderr, /不存在\.md/);
});

test('不支持的扩展名以 1 退出并列出受支持格式', async () => {
    const { code, stderr } = await runCli(['convert', 'a.txt', '--out', tmpDir]);
    assert.equal(code, 1);
    assert.match(stderr, /不支持的输入格式：a\.txt/);
});

test('输出目录不存在时以 1 退出，不启动转换', async () => {
    const missing = path.join(tmpDir, 'no-such-dir');
    const { code, stdout, stderr } = await runCli(['convert', SAMPLE_MD, '--out', missing]);
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /输出目录不存在：/);
});

test('批量输入中任一项不合法即整体以 1 退出，不启动转换', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'partial-'));

    // Act
    const { code, stderr } = await runCli(['convert', SAMPLE_MD, 'a.txt', '--out', outDir, '--json']);

    // Assert
    assert.equal(code, 1);
    assert.match(stderr, /不支持的输入格式/);
    assert.deepEqual(fs.readdirSync(outDir), []);
});

// ============================================================
// convert：运行期失败（退出码 2）
// ============================================================

test('存在失败项时以 2 退出，失败原因写入 errors', async () => {
    // Arrange：回环地址被 fetch-guard 拒绝，失败可复现且无需外网
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'failed-'));

    // Act
    const { code, stdout } = await runCli(['convert', 'http://127.0.0.1:9/', '--out', outDir, '--json']);

    // Assert
    assert.equal(code, 2);
    const payload = parseSingleLineJson(stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.results.length, 0);
    assert.equal(payload.errors.length, 1);
    assert.equal(payload.errors[0].input, 'http://127.0.0.1:9/');
    assert.equal(typeof payload.errors[0].error, 'string');
    assert.notEqual(payload.errors[0].error, '');
});

test('部分成功部分失败时以 2 退出，成功项仍写入 results', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'mixed-'));

    // Act
    const { code, stdout } = await runCli([
        'convert',
        SAMPLE_MD,
        'http://127.0.0.1:9/',
        '--out',
        outDir,
        '--json',
    ]);

    // Assert
    assert.equal(code, 2);
    const payload = parseSingleLineJson(stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.results.length, 1);
    assert.equal(payload.errors.length, 1);
    assert.ok(fs.existsSync(payload.results[0].outputPath));
});
