/**
 * bin/markflow.js 命令行集成测试
 *
 * 以子进程方式调用真实 CLI，断言 stdout/stderr 分流与退出码。
 * 覆盖：help/version、formats（含 DTD 校验器、LibreOffice 与受理扩展名）、convert 的默认目标与显式目标、
 *       转换选项透传与非法取值、按本批目标校验选项、--validate 标记、人类模式的告警输出、
 *       参数解析（中文报错、--no-<开关>、布尔开关误带取值、--concurrency 非法值告警）、
 *       extract 子命令（本机 HTTP 服务、stdout 为正文、零落盘）、
 *       config 子命令（set/get/unset 与文件权限）、参数错误（1）、失败项（2）、
 *       输出目录解析（--out / MARKFLOW_OUTPUT_DIR）、人类模式与 --json 模式的输出分流。
 * 临时产物与隔离的配置目录一律写入 os.tmpdir()。extract 的成功路径以 --require 预加载
 * allow-private-network.js，为子进程内的 SSRF 守卫放行 127.0.0.1（守卫本体不变）。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startArticleServer, buildArticlePage, ARTICLE_TITLE, ARTICLE_PARAGRAPHS } = require('./fixtures/article-server');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'markflow.js');
const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'allow-private-network.js');
const SAMPLE_MD = path.join(ROOT, 'test', 'fixtures', 'sample.md');
const SAMPLE_PDF = path.join(ROOT, 'test', 'fixtures', 'sample.pdf');
const PKG_VERSION = require('../package.json').version;
// parseArgs 的英文原文：CLI 已按错误码中文化，任何一句都不应再出现在 stderr 中
const ENGLISH_PARSE_ERROR_RE = /Unknown option|argument missing|does not take an argument|ambiguous|Unexpected argument/;

let tmpDir;

before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-cli-'));
});

after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 运行 CLI 并收集 stdout/stderr 与退出码；options.nodeArgs 放在脚本路径之前（如 --require 预加载）
function runCli(args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [...(options.nodeArgs || []), CLI, ...args], {
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
        '--font', '--font-size', '--line-height', '--numbering-start', '--validate',
        '--content-width', '--spacing', '--inline-images', '--page-size', '--landscape', '--docx-font-size',
        '--font-ascii', '--font-east-asia', '--xml-indent', '--numbering-width', '--mineru-formula', '--mineru-table',
        '--mineru-timeout', '--patent-image-dpi', '--section-detection', '--rasterize-tables', '--rasterize-formulas',
        '--raster-scale', '--raster-max-width'];
    flags.forEach((flag) => assert.ok(stdout.includes(flag), `--help 应列出 ${flag}`));
    // 多路径旗标：取值相同则合并、默认值不同逐段列出（pdf 主题缺省为 print 而非 apple）；取值不同则逐段列出
    assert.match(stdout, /可选 apple \| apple-dark \| github \| academic \| reader \| print；html 默认 apple，pdf 默认 print/);
    assert.match(stdout, /--font-size <n>.*html 范围 10–32，默认 16；docx 范围 8–36，默认 11/);
    assert.match(stdout, /范围 60–100；默认 90/);
    assert.match(stdout, /范围 72–600；默认 330/);
    assert.match(stdout, /--no-<开关>/);
    assert.match(stdout, /--json .*不输出进度/);
    assert.match(stdout, /extract <网址>/);
    assert.match(stdout, /--max-chars <n>/);
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

test('未知选项以 1 退出并在 stderr 给出中文的参数错误', async () => {
    const { code, stderr } = await runCli(['convert', '--nope']);
    assert.equal(code, 1);
    assert.match(stderr, /参数错误：未知选项 --nope/);
    assert.doesNotMatch(stderr, ENGLISH_PARSE_ERROR_RE);
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
    // DTD 校验器与 LibreOffice 的状态、受理扩展名清单；targets.capabilities.pdfBackend 为兼容保留
    for (const key of ['validator', 'libreoffice']) {
        assert.deepEqual(Object.keys(capabilities[key]).sort(), ['available', 'hint', 'name'], `${key} 的键`);
        assert.equal(capabilities[key].available, capabilities[key].name !== null);
    }
    assert.deepEqual(payload.extensions, ['.docx', '.xlsx', '.pptx', '.pdf', '.md', '.markdown']);
    assert.ok('pdfBackend' in payload.targets.capabilities);
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
    assert.match(stdout, /DTD 校验器 +→ /);
    assert.match(stdout, /受理扩展名 +→ \.docx \.xlsx \.pptx \.pdf \.md \.markdown/);
    // LibreOffice 非必需：可用时报名称，不可用时写明仅作兜底
    assert.match(stdout, /LibreOffice +→ (soffice|不可用（非必需)/);
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
    // 无告警时不多输出：既无逐条告警，汇总行也不带告警条数
    assert.doesNotMatch(stderr, /告警/);
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

// ============================================================
// convert：人类模式的告警输出
// ============================================================

test('人类模式：每项告警逐条写 stderr，汇总行追加告警条数；--json 模式 stderr 仍为空', async () => {
    // Arrange：patent profile 下 330 DPI 的图片必出「预检：」告警
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'warn-'));
    const args = ['convert', SAMPLE_MD, '--to', 'xml', '--xml-profile', 'patent', '--out', outDir];

    // Act
    const human = await runCli(args);
    const json = await runCli([...args, '--json']);

    // Assert
    assert.equal(human.code, 0, human.stderr);
    assert.equal(human.stdout.trim(), path.join(outDir, 'sample'));
    assert.match(human.stderr, /\n {2}告警：预检：/);
    const count = parseSingleLineJson(json.stdout).results[0].warnings.length;
    assert.ok(count > 0);
    assert.equal((human.stderr.match(/^ {2}告警：/gm) || []).length, count);
    assert.match(human.stderr, new RegExp(`汇总：成功 1 项，失败 0 项，输出目录 .*，告警 ${count} 条`));
    assert.equal(json.code, 0);
    assert.equal(json.stderr, '');
});

// ============================================================
// convert：按本批目标校验转换选项
// ============================================================

test('--to docx --font-size 9：html 段不属于本批，越界跳过并保留 16；docx 段写入 9', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'fs-docx-'));

    // Act
    const { code, stdout, stderr } = await runCli(['convert', SAMPLE_MD, '--to', 'docx', '--font-size', '9', '--out', outDir, '--json']);

    // Assert
    assert.equal(code, 0, stderr);
    const { options } = parseSingleLineJson(stdout).results[0];
    assert.equal(options.docx.fontSize, 9);
    assert.equal(options.html.fontSize, 16);
});

test('--to html --font-size 34：html 段属于本批，越界以 1 退出且不产生产物', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'fs-html-'));

    // Act
    const { code, stdout, stderr } = await runCli(['convert', SAMPLE_MD, '--to', 'html', '--font-size', '34', '--out', outDir]);

    // Assert
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /选项 html\.fontSize 须为 10–32 之间的数字/);
    assert.deepEqual(fs.readdirSync(outDir), []);
});

test('混合批次（md → docx、pdf → bundle）按各自目标校验：--font-size 9 只写入 docx 段', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'fs-mixed-'));

    // Act
    const { code, stdout, stderr } = await runCli([
        'convert', SAMPLE_MD, SAMPLE_PDF, '--pdf-backend', 'local', '--font-size', '9', '--out', outDir, '--json',
    ]);

    // Assert
    assert.equal(code, 0, stderr);
    const payload = parseSingleLineJson(stdout);
    assert.deepEqual(payload.results.map((item) => item.target), ['docx', 'bundle']);
    payload.results.forEach((item) => {
        assert.equal(item.options.docx.fontSize, 9);
        assert.equal(item.options.html.fontSize, 16);
    });
});

// ============================================================
// 参数解析：中文报错、--no-<开关>、布尔开关误带取值、--concurrency 告警
// ============================================================

test('参数解析错误按错误码中文化，不回显 parseArgs 的英文原文', async () => {
    // Arrange
    const cases = [
        [['convert', SAMPLE_MD, '--to'], /参数错误：选项 --to 缺少取值/],
        [['convert', SAMPLE_MD, '--json=1'], /参数错误：布尔开关 --json 不接受取值/],
        [['convert', SAMPLE_MD, '--no-to', 'html'], /参数错误：未知选项 --no-to（--no- 前缀只适用于布尔开关）/],
        [['convert', SAMPLE_MD, '--to', '--json'], /参数错误：选项 --to 的取值以短横线开头/],
        [['convert', SAMPLE_MD, '-x'], /参数错误：未知选项 -x/],
    ];

    for (const [args, expected] of cases) {
        // Act
        const { code, stdout, stderr } = await runCli(args);

        // Assert
        assert.equal(code, 1, args.join(' '));
        assert.equal(stdout, '');
        assert.match(stderr, expected);
        assert.doesNotMatch(stderr, ENGLISH_PARSE_ERROR_RE);
    }
});

test('--no-<开关> 显式关闭布尔开关，同一开关以最后一次出现为准', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'negate-'));
    const run = (flags) => runCli(['convert', SAMPLE_MD, '--to', 'html', '--out', outDir, '--json', ...flags]);

    // Act
    const off = await run(['--mineru-ocr', '--no-mineru-ocr', '--no-mineru-formula']);
    const on = await run(['--no-mineru-ocr', '--mineru-ocr']);
    const onlyOff = await run(['--no-mineru-ocr']);

    // Assert
    assert.equal(off.code, 0, off.stderr);
    const offOptions = parseSingleLineJson(off.stdout).results[0].options;
    assert.equal(offOptions.mineru.ocr, false);
    assert.equal(offOptions.mineru.formula, false, 'mineru.formula 默认 true，--no- 关闭');
    assert.equal(parseSingleLineJson(on.stdout).results[0].options.mineru.ocr, true);
    assert.equal(parseSingleLineJson(onlyOff.stdout).results[0].options.mineru.ocr, false);
});

test('布尔开关误带取值（--mineru-ocr false）以 1 退出，提示布尔开关不接受取值', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'bool-value-'));

    // Act
    const { code, stdout, stderr } = await runCli(['convert', SAMPLE_MD, '--mineru-ocr', 'false', '--out', outDir]);

    // Assert
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /布尔开关 --mineru-ocr 不接受取值「false」/);
    assert.match(stderr, /--no-mineru-ocr/);
    assert.deepEqual(fs.readdirSync(outDir), []);
});

test('--concurrency 非法值不报错：stderr 告警并按默认并发执行，--json 的 stdout 仍为一行', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'conc-'));

    // Act
    const zero = await runCli(['convert', SAMPLE_MD, '--out', outDir, '--concurrency', '0', '--json']);
    const text = await runCli(['convert', SAMPLE_MD, '--out', outDir, '--concurrency', 'abc']);

    // Assert
    assert.equal(zero.code, 0);
    assert.equal(parseSingleLineJson(zero.stdout).ok, true);
    assert.match(zero.stderr, /注意：--concurrency 取值「0」无效（须为正整数），已按默认值 2 执行/);
    assert.equal(text.code, 0);
    assert.match(text.stderr, /注意：--concurrency 取值「abc」无效/);
});

// ============================================================
// convert：与桌面端对齐的转换选项
// ============================================================

test('新增转换选项旗标进入结果 options，布尔项可用 --no- 关闭', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'new-flags-'));

    // Act
    const { code, stdout, stderr } = await runCli([
        'convert', SAMPLE_MD, '--to', 'html', '--out', outDir, '--json',
        '--content-width', '900', '--spacing', 'loose', '--inline-images', '--page-size', 'Letter', '--landscape',
        '--font-size', '18', '--docx-font-size', '12', '--font-ascii', 'Georgia', '--font-east-asia', '宋体',
        '--xml-indent', '4', '--numbering-width', '3', '--no-mineru-formula', '--no-mineru-table', '--mineru-timeout', '120',
        '--patent-image-dpi', '200', '--section-detection', 'headings', '--no-rasterize-tables', '--no-rasterize-formulas',
        '--raster-scale', '3', '--raster-max-width', '1200',
    ]);

    // Assert
    assert.equal(code, 0, stderr);
    const { options } = parseSingleLineJson(stdout).results[0];
    assert.equal(options.html.contentWidth, 900);
    assert.equal(options.html.spacing, 'loose');
    assert.equal(options.html.inlineImages, true);
    assert.equal(options.html.fontSize, 18);
    assert.equal(options.pdf.pageSize, 'Letter');
    assert.equal(options.docx.pageSize, 'Letter');
    assert.equal(options.pdf.landscape, true);
    assert.equal(options.docx.fontSize, 12, '--docx-font-size 优先于 --font-size');
    assert.deepEqual(options.docx.fontFamily, { ascii: 'Georgia', eastAsia: '宋体' });
    assert.equal(options.xml.indent, 4);
    assert.equal(options.xml.numbering.width, 3);
    assert.equal(options.mineru.formula, false);
    assert.equal(options.mineru.table, false);
    assert.equal(options.mineru.timeoutSec, 120);
    assert.deepEqual(options.xml.patent, {
        parts: 'auto', rasterizeTables: false, rasterizeFormulas: false, imageDpi: 200, sectionDetection: 'headings',
    });
    assert.deepEqual(options.raster, { scale: 3, maxWidth: 1200 });
});

// ============================================================
// extract
// ============================================================

// 预加载放行本机地址的子进程，cwd 指向空目录，便于断言「一个文件都没写」
const runExtract = (args, cwd) => runCli(['extract', ...args], { cwd, nodeArgs: ['--require', PRELOAD] });
const listFilesDeep = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

test('extract 人类模式：Markdown 正文写 stdout、摘要写 stderr，不下载图片、不落盘', async (t) => {
    // Arrange
    const server = await startArticleServer();
    t.after(() => server.close());
    const workDir = fs.mkdtempSync(path.join(tmpDir, 'extract-'));

    // Act
    const { code, stdout, stderr } = await runExtract([`${server.base}/article`], workDir);

    // Assert
    assert.equal(code, 0, stderr);
    ARTICLE_PARAGRAPHS.forEach((paragraph) => assert.ok(stdout.includes(paragraph), `stdout 应含正文：${paragraph.slice(0, 10)}…`));
    assert.ok(!stdout.includes('读者甲'), '评论区不应出现在正文里');
    assert.match(stderr, new RegExp(`标题：${ARTICLE_TITLE}`));
    assert.doesNotMatch(stderr, /已截断/);
    assert.deepEqual(server.requests, ['/article'], '图片不应被下载');
    assert.deepEqual(listFilesDeep(workDir), []);
});

test('extract --json：stdout 为一行 JSON，字段与 MCP extract_article 一致；--max-chars 截断并标记', async (t) => {
    // Arrange
    const server = await startArticleServer();
    t.after(() => server.close());
    const workDir = fs.mkdtempSync(path.join(tmpDir, 'extract-json-'));

    // Act
    const full = await runExtract([`${server.base}/article`, '--json'], workDir);
    const cut = await runExtract([`${server.base}/article`, '--json', '--max-chars', '20'], workDir);
    const cutHuman = await runExtract([`${server.base}/article`, '--max-chars', '20'], workDir);

    // Assert
    assert.equal(full.code, 0, full.stderr);
    assert.equal(full.stderr, '');
    const article = parseSingleLineJson(full.stdout);
    assert.deepEqual(Object.keys(article), [
        'url', 'finalUrl', 'title', 'author', 'publishedAt', 'siteName', 'excerpt', 'lang',
        'wordCount', 'extraction', 'markdown', 'truncated', 'images',
    ]);
    assert.equal(article.title, ARTICLE_TITLE);
    assert.equal(article.truncated, false);
    const truncated = parseSingleLineJson(cut.stdout);
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.markdown.length, 20);
    assert.equal(truncated.wordCount, article.wordCount, '截断只影响 markdown');
    assert.equal(cutHuman.code, 0);
    assert.match(cutHuman.stderr, /已截断/);
    assert.ok(cutHuman.stdout.startsWith(truncated.markdown));
    assert.deepEqual(listFilesDeep(workDir), []);
});

// ============================================================
// convert：目录输入、路径写法、重跑策略与取消
// ============================================================

// 造一个含两个受支持文件与一个不受支持文件的输入目录
function seedInputDir(prefix) {
    const dir = fs.mkdtempSync(path.join(tmpDir, prefix));
    fs.copyFileSync(SAMPLE_MD, path.join(dir, 'a.md'));
    fs.copyFileSync(SAMPLE_MD, path.join(dir, 'b.md'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), '不受支持的文件');
    return dir;
}

test('目录输入展开为其下受支持的文件，展开情况写入 stderr 与 --json 信封', async () => {
    // Arrange
    const inDir = seedInputDir('dir-in-');
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'dir-out-'));

    // Act
    const json = await runCli(['convert', inDir, '--to', 'html', '--out', outDir, '--json']);
    const human = await runCli(['convert', inDir, '--to', 'html', '--out', outDir]);

    // Assert
    assert.equal(json.code, 0, json.stderr);
    const payload = parseSingleLineJson(json.stdout);
    assert.deepEqual(payload.results.map((item) => item.name).sort(), ['a', 'b']);
    assert.deepEqual(payload.inputExpansion.directories, [{ path: inDir, count: 2 }]);
    assert.deepEqual(payload.inputExpansion.skipped, [path.join(inDir, 'notes.txt')]);
    assert.equal(payload.inputExpansion.truncated, false);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stderr, /目录展开：1 个目录 → 2 个文件；已跳过 1 个不支持的文件/);
});

test('目录内没有可转换文件时以 1 退出，不启动转换', async () => {
    // Arrange
    const inDir = fs.mkdtempSync(path.join(tmpDir, 'dir-empty-'));
    fs.writeFileSync(path.join(inDir, 'notes.txt'), '不受支持的文件');
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'dir-empty-out-'));

    // Act
    const { code, stdout, stderr } = await runCli(['convert', inDir, '--out', outDir]);

    // Assert
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /没有可转换的文件/);
    assert.deepEqual(fs.readdirSync(outDir), []);
});

test('--out 支持 ~ 与 file:// 写法', async () => {
    // Arrange
    const { pathToFileURL } = require('node:url');
    const home = fs.mkdtempSync(path.join(tmpDir, 'home-'));
    const outDir = path.join(home, 'out');
    fs.mkdirSync(outDir);

    // Act
    const tilde = await runCli(['convert', SAMPLE_MD, '--out', '~/out', '--json'], { env: { HOME: home, USERPROFILE: home } });
    const asUrl = await runCli(['convert', SAMPLE_MD, '--out', pathToFileURL(outDir).href, '--json']);

    // Assert
    assert.equal(tilde.code, 0, tilde.stderr);
    assert.equal(parseSingleLineJson(tilde.stdout).outputDir, outDir);
    assert.equal(asUrl.code, 0, asUrl.stderr);
    assert.equal(parseSingleLineJson(asUrl.stdout).outputDir, outDir);
});

test('--skip-existing：产物已存在时跳过且不重写，人类模式与 --json 各自标记', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'skip-'));
    const first = await runCli(['convert', SAMPLE_MD, '--to', 'docx', '--out', outDir, '--json']);
    const produced = parseSingleLineJson(first.stdout).results[0].outputPath;
    const mtimeBefore = fs.statSync(produced).mtimeMs;

    // Act
    const second = await runCli(['convert', SAMPLE_MD, '--to', 'docx', '--out', outDir, '--json', '--skip-existing']);
    const human = await runCli(['convert', SAMPLE_MD, '--to', 'docx', '--out', outDir, '--skip-existing']);

    // Assert
    assert.equal(second.code, 0, second.stderr);
    assert.equal(parseSingleLineJson(first.stdout).results[0].skipped, undefined, '未启用时结果不带 skipped');
    assert.equal(parseSingleLineJson(second.stdout).results[0].skipped, true);
    assert.equal(fs.statSync(produced).mtimeMs, mtimeBefore, '跳过时不得重写产物');
    assert.match(human.stderr, /已跳过：.*（产物已存在）/);
    assert.match(human.stderr, /跳过 1 项/);
});

test('--clean：重转前清理旧产物，用户放入的其它文件保留', async () => {
    // Arrange
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'clean-'));
    const first = await runCli(['convert', SAMPLE_MD, '--to', 'html', '--out', outDir, '--json']);
    const dir = parseSingleLineJson(first.stdout).results[0].outputPath;
    const stale = path.join(dir, 'images', 'image_99.jpg');
    fs.writeFileSync(stale, '旧产物');
    const mine = path.join(dir, '我的笔记.txt');
    fs.writeFileSync(mine, '保留我');

    // Act
    const again = await runCli(['convert', SAMPLE_MD, '--to', 'html', '--out', outDir, '--json', '--clean']);

    // Assert
    assert.equal(again.code, 0, again.stderr);
    assert.equal(fs.existsSync(stale), false, '旧的 MarkFlow 产物应被清理');
    assert.equal(fs.readFileSync(mine, 'utf8'), '保留我', '用户放入的文件应保留');
    assert.ok(fs.existsSync(path.join(dir, 'sample.html')), '本次产物应照常写出');
});

test('SIGINT 中止批次：进行中的任务跑完，未开始的记为已取消，退出码 2', async (t) => {
    // Arrange：本机 HTTP 服务延时应答，确保首项仍在进行时 SIGINT 已经送达
    const server = await startArticleServer({ pages: { '/slow': { html: buildArticlePage(), delayMs: 400 } } });
    t.after(() => server.close());
    const outDir = fs.mkdtempSync(path.join(tmpDir, 'sigint-'));
    const urls = Array.from({ length: 4 }, () => `${server.base}/slow`);
    const child = spawn(process.execPath, ['--require', PRELOAD, CLI, 'convert', ...urls, '--out', outDir, '--concurrency', '1'], { cwd: ROOT });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    // Act：等首项真正开始（服务器收到请求）后发 SIGINT
    await new Promise((resolve) => {
        const timer = setInterval(() => {
            if (server.requests.length >= 1) { clearInterval(timer); resolve(); }
        }, 10);
    });
    child.kill('SIGINT');
    const code = await new Promise((resolve) => child.on('close', resolve));

    // Assert
    assert.match(stderr, /已中止，正在等待进行中的任务结束/);
    assert.match(stderr, /已取消 3 项/);
    assert.equal(code, 2);
    assert.equal(server.requests.filter((item) => item === '/slow').length, 1, '中止后不应再领取新任务');
});

test('extract 参数错误以 1 退出，抓取失败以 2 退出，均给出中文说明', async () => {
    // Act
    const missing = await runCli(['extract']);
    const notUrl = await runCli(['extract', 'ftp://example.com/a']);
    const badMax = await runCli(['extract', 'https://example.com/a', '--max-chars', '0']);
    // 默认进程不放行本机地址：SSRF 守卫拒绝，失败可复现且无需外网
    const failed = await runCli(['extract', 'http://127.0.0.1:9/', '--json']);

    // Assert
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /extract 需要一个 http\(s\) 网址/);
    assert.equal(notUrl.code, 1);
    assert.match(notUrl.stderr, /extract 只接受 http\(s\) 网址/);
    assert.equal(badMax.code, 1);
    assert.match(badMax.stderr, /--max-chars 须为正整数/);
    assert.equal(failed.code, 2);
    assert.equal(failed.stdout, '');
    assert.match(failed.stderr, /提取失败：.*[一-龥]/);
});
