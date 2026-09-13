/**
 * converters/service.js 单元测试
 * 覆盖：buildOptions 的扁平参数映射与类型转换、嵌套段深合并与 xml 扁平别名、未知键忽略、非法值中文错误、
 *       probeCapabilities 的形状（含 raster 后端探测结果与 mineru 状态，不含令牌）、runConversion 结果信封的新字段
 */
const { test, describe, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const service = require('../converters/service');
const config = require('../converters/config');
const { DEFAULT_OPTIONS } = require('../converters/options');

const ROOT = path.resolve(__dirname, '..');
const SAMPLE_MD = path.join(ROOT, 'test', 'fixtures', 'sample.md');
const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'service-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => config._reset());

// 隔离的家目录（无 ~/.mineru/config.yaml）与环境变量
function isolateConfig(env = {}) {
    const homeDir = fs.mkdtempSync(path.join(root, 'home-'));
    config._setDeps({ env, homeDir });
}

// ============================================================
// buildOptions
// ============================================================

describe('buildOptions', () => {
    test('省略参数或空对象即全默认，结果已冻结', () => {
        assert.deepEqual(service.buildOptions(), DEFAULT_OPTIONS);
        assert.deepEqual(service.buildOptions({}), DEFAULT_OPTIONS);
        assert.ok(Object.isFrozen(service.buildOptions({})));
    });

    test('扁平参数映射到嵌套路径并做类型转换（CLI 的字符串取值）', () => {
        // Act
        const opts = service.buildOptions({
            theme: 'github', xmlProfile: 'patent', patentParts: 'claims, description', pdfBackend: 'local',
            imageFormat: 'keep', jpegQuality: '85', jpegPpi: '420', math: 'text', mineruModel: 'vlm', mineruOcr: 'true',
            mineruLang: 'en', pageRanges: '1-3', font: 'Georgia, serif', fontSize: '18', lineHeight: '1.5',
            numberingStart: '10', numberingWidth: '5', mineruToken: 'tok', spacing: 'loose', pageSize: 'Letter',
            landscape: 'yes', inlineImages: 'false', imageDpi: 150, rasterScale: 3, validate: 'true',
        });

        // Assert
        assert.equal(opts.html.theme, 'github');
        assert.equal(opts.pdf.theme, 'github');
        assert.equal(opts.xml.profile, 'patent');
        assert.deepEqual(opts.xml.patent.parts, ['claims', 'description']);
        assert.equal(opts.pdfBackend, 'local');
        assert.equal(opts.imageFormat, 'keep');
        assert.equal(opts.jpegQuality, 85);
        assert.equal(opts.jpegPpi, 420);
        assert.equal(opts.math, 'text');
        assert.equal(opts.mineru.model, 'vlm');
        assert.equal(opts.mineru.ocr, true);
        assert.equal(opts.mineru.language, 'en');
        assert.equal(opts.mineru.pageRanges, '1-3');
        assert.equal(opts.mineru.token, 'tok');
        assert.equal(opts.html.fontFamily, 'Georgia, serif');
        assert.equal(opts.html.fontSize, 18);
        assert.equal(opts.docx.fontSize, 18);
        assert.equal(opts.html.lineHeight, 1.5);
        assert.equal(opts.html.spacing, 'loose');
        assert.equal(opts.html.inlineImages, false);
        assert.deepEqual(opts.xml.numbering, { start: 10, width: 5 });
        assert.equal(opts.pdf.pageSize, 'Letter');
        assert.equal(opts.docx.pageSize, 'Letter');
        assert.equal(opts.pdf.landscape, true);
        assert.equal(opts.xml.patent.imageDpi, 150);
        assert.equal(opts.raster.scale, 3);
        assert.equal(opts.xml.validate, true);
        assert.equal(service.buildOptions({ validate: true }).xml.validate, true);
        assert.equal(service.buildOptions({}).xml.validate, false);
    });

    test('patentParts 接受 auto、数组与顿号分隔', () => {
        assert.equal(service.buildOptions({ patentParts: 'auto' }).xml.patent.parts, 'auto');
        assert.deepEqual(service.buildOptions({ patentParts: ['drawings'] }).xml.patent.parts, ['drawings']);
        assert.deepEqual(service.buildOptions({ patentParts: 'abstract、abstract-figure' }).xml.patent.parts, ['abstract', 'abstract-figure']);
    });

    test('未知键忽略、空值视为未给出，非法值抛中文错误', () => {
        assert.deepEqual(service.buildOptions({ to: 'html', out: '/tmp', json: true, theme: '', jpegQuality: null }), DEFAULT_OPTIONS);
        assert.throws(() => service.buildOptions({ jpegQuality: 'abc' }), /参数 jpegQuality 须为数字，实际：abc/);
        assert.throws(() => service.buildOptions({ mineruOcr: 'maybe' }), /参数 mineruOcr 须为布尔值（true\/false），实际：maybe/);
        assert.throws(() => service.buildOptions({ theme: 'solarized' }), /选项 html\.theme 须为/);
        assert.throws(() => service.buildOptions({ patentParts: 'claims,cover' }), /选项 xml\.patent\.parts/);
        assert.throws(() => service.buildOptions({ jpegQuality: 120 }), /选项 jpegQuality 须为 60–100 之间的整数/);
        assert.throws(() => service.buildOptions('x'), /buildOptions 需要对象形式的参数/);
    });

    test('嵌套段深合并，xml 段内 numberingStart/numberingWidth 展开为 numbering，扁平键与嵌套段可混用', () => {
        // Act
        const opts = service.buildOptions({
            html: { theme: 'reader', fontSize: 20 },
            xml: { indent: 4, numberingStart: 3 },
            numberingWidth: 2,
            mineru: { model: 'vlm', pageRanges: '2-4' },
            docx: { fontFamily: { eastAsia: '宋体' } },
        });

        // Assert
        assert.equal(opts.html.theme, 'reader');
        assert.equal(opts.html.fontSize, 20);
        assert.equal(opts.html.lineHeight, 1.7);
        assert.equal(opts.xml.indent, 4);
        assert.deepEqual(opts.xml.numbering, { start: 3, width: 2 });
        assert.equal(opts.mineru.model, 'vlm');
        assert.equal(opts.mineru.pageRanges, '2-4');
        assert.deepEqual(opts.docx.fontFamily, { ascii: 'Calibri', eastAsia: '宋体' });
        assert.throws(() => service.buildOptions({ html: 'apple' }), /参数 html 须为对象/);
        assert.throws(() => service.buildOptions({ html: { colour: 'red' } }), /未知选项：html\.colour/);
    });
});

// ============================================================
// probeCapabilities
// ============================================================

describe('probeCapabilities', () => {
    test('含 pdfBackend / raster / mineru / themes / xmlProfiles，raster 为栅格后端探测结果，未配置令牌时 mineru 为未配置', async () => {
        // Arrange
        isolateConfig({});

        // Act
        const caps = await service.probeCapabilities();

        // Assert
        assert.deepEqual(Object.keys(caps).sort(), ['mineru', 'pdfBackend', 'raster', 'themes', 'xmlProfiles']);
        assert.equal(typeof caps.pdfBackend.available, 'boolean');
        assert.equal(typeof caps.pdfBackend.hint, 'string');
        assert.deepEqual(Object.keys(caps.raster).sort(), ['available', 'hint', 'name']);
        assert.ok(caps.raster.name === null || typeof caps.raster.name === 'string');
        assert.equal(typeof caps.raster.available, 'boolean');
        assert.equal(typeof caps.raster.hint, 'string');
        assert.equal(caps.raster.available, caps.raster.name !== null, '可用性与后端名一致');
        const electronInstalled = (() => {
            try {
                const mod = require('electron');
                return typeof mod === 'string' && require('node:fs').existsSync(mod);
            } catch (err) {
                return false;
            }
        })();
        if (electronInstalled) assert.deepEqual(caps.raster, { name: 'electron-worker', available: true, hint: '' });
        assert.deepEqual(caps.mineru, { configured: false, source: null });
        assert.deepEqual(caps.themes, ['apple', 'apple-dark', 'github', 'academic', 'reader', 'print']);
        assert.deepEqual(caps.xmlProfiles, ['generic', 'patent']);
        assert.equal('sofficeAvailable' in caps, false);
    });

    test('令牌来自环境变量时只报来源，绝不透出令牌', async () => {
        isolateConfig({ MINERU_TOKEN: 'secret-xyz-123' });
        const caps = await service.probeCapabilities();
        assert.deepEqual(caps.mineru, { configured: true, source: 'env:MINERU_TOKEN' });
        assert.equal(JSON.stringify(caps).includes('secret-xyz-123'), false);
        assert.equal(JSON.stringify(await service.describeFormats()).includes('secret-xyz-123'), false);
    });
});

// ============================================================
// runConversion
// ============================================================

describe('runConversion', () => {
    test('结果信封含 sourceType / options（脱敏）/ extras / backends，options 透传 convert', async () => {
        // Arrange
        const outputDir = fs.mkdtempSync(path.join(root, 'run-'));
        const tasks = service.planTasks([SAMPLE_MD], 'docx', ROOT);
        const options = service.buildOptions({ jpegQuality: 70, mineruToken: 'must-not-leak' });

        // Act
        const payload = await service.runConversion({ tasks, outputDir, options });

        // Assert
        assert.equal(payload.ok, true, JSON.stringify(payload.errors));
        const [item] = payload.results;
        assert.equal(item.sourceType, 'md');
        assert.equal(item.target, 'docx');
        assert.equal(item.options.jpegQuality, 70);
        assert.equal(item.options.mineru.token, null);
        assert.equal(JSON.stringify(payload).includes('must-not-leak'), false);
        assert.deepEqual(item.extras, []);
        assert.deepEqual(item.backends, { pdfParser: null, raster: null });
        assert.ok(fs.existsSync(item.outputPath));
    });
});

// ============================================================
// runConversion：批内产物名登记
// ============================================================

const converters = require('../converters');
const { createDocument, createRoot, createParagraph } = require('../converters/ir/schema');

describe('runConversion 的产物名登记', () => {
    // 桩 parser / renderer 只经调度器的 moduleLoader 注入，避免用例依赖真实解析后端
    function withStubs(stubs, fn) {
        converters._setModuleLoader((rel) => (
            Object.prototype.hasOwnProperty.call(stubs, rel) ? stubs[rel] : require(path.join(ROOT, 'converters', rel))
        ));
        return fn().finally(() => converters._reset());
    }

    const stubDoc = (sourceType) => createDocument({ ir: createRoot([createParagraph(sourceType)]), meta: { sourceType } });
    const bundleRenderers = {
        './renderers/md': { render: async () => '# 正文\n' },
        './renderers/json': { render: async () => '{}' },
    };

    // 在新建的临时目录下造出一组输入文件 → 绝对路径
    function seedInputs(prefix, names) {
        const dir = fs.mkdtempSync(path.join(root, prefix));
        return names.map((name) => {
            const file = path.join(dir, name);
            fs.writeFileSync(file, 'PK');
            return file;
        });
    }

    test('并发 2 下后一项先解析完也抢不到原名：sample 与 sample (pptx) 按命令行顺序归属', async () => {
        // Arrange：第 2 项（pptx）立即解析完，第 1 项（docx）要等它解析完才返回，
        // 于是「解析完成的先后」与「批内序号」恰好相反，用以证明最终名只由序号决定
        const [docxPath, pptxPath] = seedInputs('dup-in-', ['sample.docx', 'sample.pptx']);
        const outputDir = fs.mkdtempSync(path.join(root, 'dup-out-'));
        let markSecondParsed = () => {};
        const secondParsed = new Promise((resolve) => { markSecondParsed = resolve; });
        const stubs = {
            ...bundleRenderers,
            './parsers/pptx': { parse: async () => { markSecondParsed(); return stubDoc('pptx'); } },
            './parsers/docx': { parse: async () => { await secondParsed; return stubDoc('docx'); } },
        };
        const tasks = service.planTasks([docxPath, pptxPath], 'bundle', ROOT);

        // Act
        const payload = await withStubs(stubs, () => service.runConversion({ tasks, outputDir, concurrency: 2 }));

        // Assert
        assert.equal(payload.ok, true, JSON.stringify(payload.errors));
        assert.deepEqual(payload.results.map((item) => item.name), ['sample', 'sample (pptx)']);
        assert.deepEqual(payload.results.map((item) => item.outputPath), [
            path.join(outputDir, 'sample'),
            path.join(outputDir, 'sample (pptx)'),
        ]);
        assert.deepEqual(fs.readdirSync(outputDir).sort(), ['sample', 'sample (pptx)']);
        assert.ok(fs.existsSync(path.join(outputDir, 'sample (pptx)', 'sample (pptx).md')));
    });

    test('前序任务失败时放行后续：整批不卡住，失败项也不占用名字', async () => {
        // Arrange：第 1 项的文件不存在，convert 在登记之前即失败
        const [realPath] = seedInputs('rel-in-', ['sample.docx']);
        const missingPath = path.join(path.dirname(realPath), '缺失', 'sample.docx');
        const outputDir = fs.mkdtempSync(path.join(root, 'rel-out-'));
        const stubs = { ...bundleRenderers, './parsers/docx': { parse: async () => stubDoc('docx') } };
        const tasks = service.planTasks([missingPath, realPath], 'bundle', ROOT);

        // Act
        const payload = await withStubs(stubs, () => service.runConversion({ tasks, outputDir, concurrency: 2 }));

        // Assert
        assert.equal(payload.ok, false);
        assert.equal(payload.errors.length, 1);
        assert.equal(payload.errors[0].input, missingPath);
        assert.match(payload.errors[0].error, /输入文件不存在/);
        assert.deepEqual(payload.results.map((item) => item.name), ['sample']);
        assert.deepEqual(fs.readdirSync(outputDir), ['sample']);
    });

    test('混合目标按落盘形态分槽，同批互不改名', async () => {
        // Arrange
        const [mdPath, docxPath] = seedInputs('mix-in-', ['sample.md', 'sample.docx']);
        const outputDir = fs.mkdtempSync(path.join(root, 'mix-out-'));
        const stubs = {
            ...bundleRenderers,
            './parsers/md': { parse: async () => stubDoc('md') },
            './parsers/docx': { parse: async () => stubDoc('docx') },
            './renderers/docx': { render: async () => Buffer.from('PK docx') },
        };
        // 省略 --to：md 默认转 docx（单文件），docx 默认转 bundle（目录）
        const tasks = service.planTasks([mdPath, docxPath], undefined, ROOT);

        // Act
        const payload = await withStubs(stubs, () => service.runConversion({ tasks, outputDir, concurrency: 2 }));

        // Assert
        assert.equal(payload.ok, true, JSON.stringify(payload.errors));
        assert.deepEqual(payload.results.map((item) => item.target), ['docx', 'bundle']);
        assert.deepEqual(payload.results.map((item) => item.name), ['sample', 'sample']);
        assert.deepEqual(fs.readdirSync(outputDir).sort(), ['sample', 'sample.docx']);
    });

    test('登记表不跨批次：同一输入再转一次仍写回同一产物（幂等）', async () => {
        // Arrange
        const [input] = seedInputs('idem-in-', ['sample.docx']);
        const outputDir = fs.mkdtempSync(path.join(root, 'idem-out-'));
        const stubs = { ...bundleRenderers, './parsers/docx': { parse: async () => stubDoc('docx') } };
        const tasks = service.planTasks([input], 'bundle', ROOT);

        // Act：两次独立的 runConversion，各自新建登记表
        const first = await withStubs(stubs, () => service.runConversion({ tasks, outputDir }));
        const second = await withStubs(stubs, () => service.runConversion({ tasks, outputDir }));

        // Assert
        assert.equal(second.results[0].name, 'sample');
        assert.equal(second.results[0].outputPath, first.results[0].outputPath);
        assert.deepEqual(fs.readdirSync(outputDir), ['sample']);
    });
});
