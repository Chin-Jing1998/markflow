/**
 * bin/markflow.js 命令行集成测试
 *
 * 以子进程方式调用真实 CLI，断言 stdout/stderr 分流与退出码。
 * 覆盖：help/version、formats、convert 的默认目标与显式目标、转换选项透传与非法取值、--validate 标记、
 *       config 子命令（set/get/unset 与文件权限）、参数错误（1）、失败项（2）、
 *       输出目录解析（--out / MARKFLOW_OUTPUT_DIR）、人类模式与 --json 模式的输出分流。
 * 临时产物与隔离的配置目录一律写入 os.tmpdir()。
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

test('--help 的选项段由 options.js 的描述树生成，列出全部转换选项与 config 项', async () => {
    // Act
    const { code, stdout } = await runCli(['--help']);

    // Assert
    assert.equal(code, 0);
    const flags = ['--theme', '--xml-profile', '--patent-parts', '--pdf-backend', '--image-format',
        '--jpeg-quality', '--jpeg-ppi', '--math', '--mineru-model', '--mineru-ocr', '--mineru-lang', '--page-ranges',
        '--font', '--font-size', '--line-height', '--numbering-start', '--validate'];
    flags.forEach((flag) => assert.ok(stdout.includes(flag), `--help 应列出 ${flag}`));
    assert.match(stdout, /可选 apple \| apple-dark \| github \| academic \| reader \| print；默认 apple/);
    assert.match(stdout, /范围 60–100；默认 90/);
    assert.match(stdout, /范围 72–600；默认 330/);
    assert.match(stdout, /config {2,}读写/);
    assert.match(stdout, /mineru-token/);
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
    assert.deepEqual(payload.targets.office, ['bundle', 'html', 'xml']);
    assert.deepEqual(payload.targets.url, ['bundle', 'html', 'xml']);
    assert.ok(payload.targets.markup.includes('docx'));
    assert.ok(payload.targets.markup.includes('html'));
    assert.ok(payload.targets.markup.includes('xml'));
    const { capabilities } = payload;
    assert.equal('sofficeAvailable' in capabilities, false);
    assert.equal(typeof capabilities.pdfBackend.available, 'boolean');
    assert.equal(typeof capabilities.pdfBackend.hint, 'string');
    assert.equal(typeof capabilities.raster.available, 'boolean');
    assert.equal(typeof capabilities.raster.hint, 'string');
    assert.equal(typeof capabilities.mineru.configured, 'boolean');
    assert.ok(capabilities.mineru.source === null || typeof capabilities.mineru.source === 'string');
    assert.deepEqual(capabilities.themes, ['apple', 'apple-dark', 'github', 'academic', 'reader', 'print']);
    assert.deepEqual(capabilities.xmlProfiles, ['generic', 'patent']);
    assert.deepEqual(Object.keys(capabilities.mineru), ['configured', 'source'], 'mineru 只报是否配置与来源');
    for (const name of ['MINERU_TOKEN', 'MINERU_API_TOKEN']) {
        if (process.env[name]) assert.equal(stdout.includes(process.env[name]), false, `${name} 的取值不得出现在输出中`);
    }
    assert.equal(payload.version, PKG_VERSION);
});

test('formats 人类模式输出可读文本到 stdout', async () => {
    const { code, stdout } = await runCli(['formats']);
    assert.equal(code, 0);
    assert.match(stdout, /可用转换目标/);
    assert.match(stdout, /PDF 后端/);
    assert.match(stdout, /栅格化后端/);
    assert.match(stdout, /MinerU 令牌/);
    assert.match(stdout, /HTML 主题/);
    assert.match(stdout, /XML profile/);
    assert.match(stdout, /apple、apple-dark、github、academic、reader、print/);
    assert.match(stdout, /generic、patent/);
    assert.doesNotMatch(stdout, /LibreOffice/);
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

test('Markdown 显式转 html：产出 {name}/{name}.html 与 images/，结果含新字段', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'html-'));

    // Act
    const { code, stdout } = await runCli(['convert', SAMPLE_MD, '--to', 'html', '--out', outDir, '--json']);

    // Assert
    assert.equal(code, 0);
    const [item] = parseSingleLineJson(stdout).results;
    assert.equal(item.target, 'html');
    assert.equal(item.sourceType, 'md');
    assert.equal(item.outputPath, path.join(outDir, 'sample'));
    assert.equal(item.outputs.html, path.join(outDir, 'sample', 'sample.html'));
    assert.ok(fs.existsSync(item.outputs.html));
    // 图片扩展名随 imageFormat 归一（默认 jpg），此处只断言编号产物落盘且 html 按相对路径引用同一文件
    const images = fs.readdirSync(item.outputs.imagesDir);
    const firstImage = images.find((name) => name.startsWith('image_1.'));
    assert.ok(firstImage, `images/ 应含 image_1.*，实际：${images.join('、')}`);
    assert.ok(fs.readFileSync(item.outputs.html, 'utf8').includes(`images/${firstImage}`));
    assert.equal(item.options.html.theme, 'apple');
    assert.deepEqual(item.extras, []);
    assert.deepEqual(item.backends, { pdfParser: null, raster: null });
});

test('PDF 输入省略 --to 时默认转 bundle，产出 md 与 json', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'bundle-'));

    // Act
    // 固定走本地后端，避免用例依赖 MinerU 令牌与外网
    const { code, stdout } = await runCli(['convert', SAMPLE_PDF, '--pdf-backend', 'local', '--out', outDir, '--json']);

    // Assert
    assert.equal(code, 0);
    const payload = parseSingleLineJson(stdout);
    assert.equal(payload.ok, true);
    const [item] = payload.results;
    assert.equal(item.target, 'bundle');
    assert.equal(item.backends.pdfParser, 'pdfjs');
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
        '--pdf-backend',
        'local',
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
// convert：转换选项
// ============================================================

test('转换选项透传到结果 options：theme 兼作 pdf 主题，font-size 兼作 docx 字号', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'options-'));

    // Act
    const { code, stdout } = await runCli([
        'convert', SAMPLE_MD, '--to', 'html', '--out', outDir, '--json',
        '--theme', 'github', '--font', 'Georgia, serif', '--font-size', '18', '--line-height', '1.5',
        '--image-format', 'keep', '--jpeg-quality', '80', '--jpeg-ppi', '420', '--math', 'text', '--pdf-backend', 'local',
        '--xml-profile', 'patent', '--patent-parts', 'claims,description', '--numbering-start', '7',
        '--mineru-model', 'vlm', '--mineru-ocr', '--mineru-lang', 'en', '--page-ranges', '1-3',
    ]);

    // Assert
    assert.equal(code, 0);
    const { options } = parseSingleLineJson(stdout).results[0];
    assert.equal(options.html.theme, 'github');
    assert.equal(options.pdf.theme, 'github');
    assert.equal(options.html.fontFamily, 'Georgia, serif');
    assert.equal(options.html.fontSize, 18);
    assert.equal(options.docx.fontSize, 18);
    assert.equal(options.html.lineHeight, 1.5);
    assert.equal(options.imageFormat, 'keep');
    assert.equal(options.jpegQuality, 80);
    assert.equal(options.jpegPpi, 420);
    assert.equal(options.math, 'text');
    assert.equal(options.pdfBackend, 'local');
    assert.equal(options.xml.profile, 'patent');
    assert.deepEqual(options.xml.patent.parts, ['claims', 'description']);
    assert.equal(options.xml.numbering.start, 7);
    assert.equal(options.mineru.model, 'vlm');
    assert.equal(options.mineru.ocr, true);
    assert.equal(options.mineru.language, 'en');
    assert.equal(options.mineru.pageRanges, '1-3');
    assert.equal(options.mineru.token, null, '令牌不得出现在结果中');
});

test('省略转换选项时结果 options 取 options.js 的默认值，信封不含 validate', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'defaults-'));

    // Act
    const { code, stdout } = await runCli(['convert', SAMPLE_MD, '--to', 'html', '--out', outDir, '--json']);

    // Assert
    assert.equal(code, 0);
    const payload = parseSingleLineJson(stdout);
    assert.equal(payload.validate, undefined);
    const { options } = payload.results[0];
    assert.equal(options.html.theme, 'apple');
    assert.equal(options.imageFormat, 'jpg');
    assert.equal(options.jpegQuality, 90);
    assert.equal(options.jpegPpi, 330);
    assert.equal(options.xml.profile, 'generic');
});

test('未知主题以 1 退出，stderr 给出中文取值说明且不产生任何产物', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'bad-theme-'));

    // Act
    const { code, stdout, stderr } = await runCli(['convert', SAMPLE_MD, '--to', 'html', '--theme', 'solarized', '--out', outDir]);

    // Assert
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /选项 html\.theme 须为/);
    assert.match(stderr, /apple \| apple-dark/);
    assert.deepEqual(fs.readdirSync(outDir), []);
});

test('选项取值越界以 1 退出（--jpeg-quality）', async () => {
    const { code, stderr } = await runCli(['convert', SAMPLE_MD, '--jpeg-quality', '120', '--out', tmpDir]);
    assert.equal(code, 1);
    assert.match(stderr, /选项 jpegQuality 须为 60–100 之间的整数/);
});

test('--validate 经 buildOptions 进入 options.xml.validate，并在结果信封上标记 validate', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'validate-'));

    // Act
    const { code, stdout } = await runCli(['convert', SAMPLE_MD, '--to', 'xml', '--validate', '--out', outDir, '--json']);

    // Assert
    assert.equal(code, 0);
    const payload = parseSingleLineJson(stdout);
    assert.equal(payload.validate, true);
    assert.equal(payload.results[0].options.xml.validate, true);
    assert.deepEqual(payload.results[0].warnings.filter((item) => item.startsWith('DTD 校验：')), [], 'generic 产物应通过 well-formed 检查');
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

// ============================================================
// config
// ============================================================

// 仅用于断言「不回显」的占位取值，非真实令牌
const TOKEN_SAMPLE = 'mf-test-token-0123456789';
// 隔离配置目录并屏蔽环境变量令牌，令来源判定可复现（config.js 视空串为未配置）
const configEnv = (dir) => ({ MARKFLOW_CONFIG_DIR: dir, MINERU_TOKEN: '', MINERU_API_TOKEN: '' });

test('config set/get/unset：文件权限 0600，只报是否已配置与来源，取值不回显', async () => {
    // Arrange
    const dir = fs.mkdtempSync(path.join(tmpDir, 'config-'));
    const env = configEnv(dir);
    const file = path.join(dir, 'config.json');

    // Act：写入令牌
    const set = await runCli(['config', 'set', 'mineru-token', TOKEN_SAMPLE], { env });

    // Assert：落盘、权限 0600、回执不含取值
    assert.equal(set.code, 0);
    assert.match(set.stdout, /已保存/);
    assert.equal(set.stdout.includes(TOKEN_SAMPLE), false, '令牌不得出现在 stdout');
    assert.equal(set.stderr.includes(TOKEN_SAMPLE), false, '令牌不得出现在 stderr');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mineruToken, TOKEN_SAMPLE);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    // Act & Assert：人类模式只报状态与来源
    const got = await runCli(['config', 'get'], { env });
    assert.equal(got.code, 0);
    assert.match(got.stdout, /mineru-token/);
    assert.match(got.stdout, /MinerU 令牌：已配置（来源：config）/);
    assert.match(got.stdout, /配置文件中已写入/);
    assert.equal(got.stdout.includes(TOKEN_SAMPLE), false, '令牌不得出现在 config get 输出中');

    // Act & Assert：--json 模式同样只给状态
    const json = await runCli(['config', 'get', '--json'], { env });
    const payload = parseSingleLineJson(json.stdout);
    assert.equal(payload.configPath, file);
    assert.deepEqual(payload.items, [
        { name: 'mineru-token', label: 'MinerU 令牌', configured: true, source: 'config', inConfigFile: true },
    ]);
    assert.equal(json.stdout.includes(TOKEN_SAMPLE), false);

    // Act & Assert：unset 后配置文件不再保有该键
    const unset = await runCli(['config', 'unset', 'mineru-token'], { env });
    assert.equal(unset.code, 0);
    assert.match(unset.stdout, /已删除/);
    assert.equal('mineruToken' in JSON.parse(fs.readFileSync(file, 'utf8')), false);
    const after = parseSingleLineJson((await runCli(['config', 'get', '--json'], { env })).stdout);
    assert.equal(after.items[0].inConfigFile, false);
});

test('config get 在环境变量提供令牌时只报来源，不报取值', async () => {
    // Arrange：环境变量优先于配置文件
    const dir = fs.mkdtempSync(path.join(tmpDir, 'config-env-'));

    // Act
    const { code, stdout } = await runCli(['config', 'get', '--json'], {
        env: { ...configEnv(dir), MINERU_TOKEN: TOKEN_SAMPLE },
    });

    // Assert
    assert.equal(code, 0);
    const [item] = parseSingleLineJson(stdout).items;
    assert.deepEqual(item, {
        name: 'mineru-token', label: 'MinerU 令牌', configured: true, source: 'env:MINERU_TOKEN', inConfigFile: false,
    });
    assert.equal(stdout.includes(TOKEN_SAMPLE), false);
});

test('config 的子动作或配置项非法时以 1 退出，不写任何文件', async () => {
    // Arrange
    const dir = fs.mkdtempSync(path.join(tmpDir, 'config-bad-'));
    const env = configEnv(dir);

    // Act & Assert
    const action = await runCli(['config', 'list'], { env });
    assert.equal(action.code, 1);
    assert.match(action.stderr, /config 需要子动作/);

    const unknown = await runCli(['config', 'set', 'openai-key', 'x'], { env });
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /未知配置项：openai-key/);

    const missing = await runCli(['config', 'set', 'mineru-token'], { env });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /需要取值/);

    assert.deepEqual(fs.readdirSync(dir), []);
});

// ============================================================
// 批内同名产物
// ============================================================

// 造出三份派生出同一产物名的输入：同目录的 sample.md 与 sample.docx，另一目录的同名 sample.md
function seedDuplicateInputs(prefix) {
    const caseDir = fs.mkdtempSync(path.join(tmpDir, prefix));
    const dirA = path.join(caseDir, 'a');
    const dirB = path.join(caseDir, 'b');
    const outDir = path.join(caseDir, 'out');
    for (const dir of [dirA, dirB, outDir]) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(SAMPLE_MD, path.join(dirA, 'sample.md'));
    fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'images-sample.docx'), path.join(dirA, 'sample.docx'));
    fs.copyFileSync(SAMPLE_MD, path.join(dirB, 'sample.md'));
    return { inputs: [path.join(dirA, 'sample.md'), path.join(dirA, 'sample.docx'), path.join(dirB, 'sample.md')], outDir };
}

test('同批同名输入不互相覆盖：原名固定归属命令行首个输入（默认并发）', async () => {
    // Arrange
    const { inputs, outDir } = seedDuplicateInputs('dup-');

    // Act：不指定 --concurrency，用默认并发；归属只由命令行顺序决定
    const { code, stdout } = await runCli(['convert', ...inputs, '--to', 'html', '--out', outDir, '--json']);

    // Assert
    assert.equal(code, 0, stdout);
    const payload = parseSingleLineJson(stdout);
    assert.equal(payload.ok, true, JSON.stringify(payload.errors));
    assert.deepEqual(payload.results.map((item) => item.input), inputs);
    assert.deepEqual(payload.results.map((item) => item.name), ['sample', 'sample (docx)', 'sample (2)']);
    assert.deepEqual(payload.results.map((item) => item.outputPath), [
        path.join(outDir, 'sample'),
        path.join(outDir, 'sample (docx)'),
        path.join(outDir, 'sample (2)'),
    ]);
    assert.deepEqual(fs.readdirSync(outDir).sort(), ['sample', 'sample (2)', 'sample (docx)']);
    // 主产物文件名随目录名一并改名，三份 html 各自独立存在
    for (const item of payload.results) {
        assert.equal(item.outputs.html, path.join(item.outputPath, `${item.name}.html`));
        assert.ok(fs.existsSync(item.outputs.html), item.outputs.html);
    }
});

test('同批同名输入：换用并发 2 重复执行，name 序列与默认并发一致', async () => {
    // Arrange
    const { inputs, outDir } = seedDuplicateInputs('dup-c2-');

    // Act
    const { code, stdout } = await runCli([
        'convert', ...inputs, '--to', 'html', '--out', outDir, '--concurrency', '2', '--json',
    ]);

    // Assert
    assert.equal(code, 0, stdout);
    assert.deepEqual(
        parseSingleLineJson(stdout).results.map((item) => item.name),
        ['sample', 'sample (docx)', 'sample (2)'],
    );
});

test('同批混合目标：md 的 sample.docx 与 docx 的 sample/ 分属不同槽位，均不改名', async () => {
    // Arrange
    const caseDir = fs.mkdtempSync(path.join(tmpDir, 'mixed-'));
    const inDir = path.join(caseDir, 'in');
    const outDir = path.join(caseDir, 'out');
    for (const dir of [inDir, outDir]) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(SAMPLE_MD, path.join(inDir, 'sample.md'));
    fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'images-sample.docx'), path.join(inDir, 'sample.docx'));

    // Act：省略 --to，md 默认转 docx（单文件），docx 默认转 bundle（目录）
    const { code, stdout } = await runCli([
        'convert', path.join(inDir, 'sample.md'), path.join(inDir, 'sample.docx'), '--out', outDir, '--json',
    ]);

    // Assert
    assert.equal(code, 0, stdout);
    const payload = parseSingleLineJson(stdout);
    assert.equal(payload.ok, true, JSON.stringify(payload.errors));
    assert.deepEqual(payload.results.map((item) => item.target), ['docx', 'bundle']);
    assert.deepEqual(payload.results.map((item) => item.name), ['sample', 'sample']);
    assert.deepEqual(payload.results.map((item) => item.outputPath), [
        path.join(outDir, 'sample.docx'),
        path.join(outDir, 'sample'),
    ]);
    assert.deepEqual(fs.readdirSync(outDir).sort(), ['sample', 'sample.docx']);
    assert.equal(fs.statSync(path.join(outDir, 'sample')).isDirectory(), true);
    assert.equal(fs.statSync(path.join(outDir, 'sample.docx')).isFile(), true);
});
