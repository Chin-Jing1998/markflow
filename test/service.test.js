/**
 * converters/service.js 单元测试
 * 覆盖：buildOptions 的扁平参数映射与类型转换、嵌套段深合并与 xml 扁平别名、未知键忽略、非法值中文错误、
 *       按本批目标校验（targets）、docx 专属扁平键与 xml 段的 patent 别名；describeOptionHint 的取值说明；
 *       probeCapabilities 的形状（含 raster、DTD 校验器与 LibreOffice 的探测结果与 mineru 状态，不含令牌）、
 *       describeFormats 的受理扩展名、runConversion 结果信封的新字段
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
afterEach(() => {
    config._reset();
    service._resetProbeCache();
});

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

    test('省略 targets 即全部段照常校验（保持旧行为）', () => {
        assert.throws(() => service.buildOptions({ fontSize: 9 }), /选项 html\.fontSize 须为 10–32 之间的数字/);
        assert.throws(() => service.buildOptions({ fontSize: 9 }, {}), /选项 html\.fontSize/);
    });

    test('按本批目标校验：不属于本批目标的段取值越界时跳过写入、保留默认值', () => {
        // Act & Assert：docx 批次，html 段不属于本批，9 越界即跳过；docx 段照常写入
        const docxOnly = service.buildOptions({ fontSize: 9 }, { targets: ['docx'] });
        assert.equal(docxOnly.docx.fontSize, 9);
        assert.equal(docxOnly.html.fontSize, 16);

        // Act & Assert：html 批次，html 段属于本批，越界照常报错
        assert.throws(() => service.buildOptions({ fontSize: 34 }, { targets: ['html'] }), /选项 html\.fontSize 须为 10–32 之间的数字/);

        // Act & Assert：混合批次两段分别校验，任一段越界即报错，两段都合法才一并写入
        assert.throws(() => service.buildOptions({ fontSize: 9 }, { targets: ['html', 'docx'] }), /选项 html\.fontSize/);
        assert.throws(() => service.buildOptions({ fontSize: 34 }, { targets: new Set(['docx', 'html']) }), /选项 html\.fontSize/);
        const mixed = service.buildOptions({ fontSize: 20 }, { targets: ['html', 'docx'] });
        assert.equal(mixed.html.fontSize, 20);
        assert.equal(mixed.docx.fontSize, 20);
    });

    test('pdf 目标以 html 段排版，html 段同属 pdf 目标；与目标无关的段照常校验', () => {
        assert.throws(() => service.buildOptions({ fontSize: 9 }, { targets: ['pdf'] }), /选项 html\.fontSize/);
        const bundle = service.buildOptions({ fontSize: 9, lineHeight: 5, theme: 'solarized' }, { targets: ['bundle'] });
        assert.equal(bundle.html.fontSize, 16);
        assert.equal(bundle.docx.fontSize, 9, 'docx 段虽不在本批，但 9 对该段合法，照常写入');
        assert.equal(bundle.html.lineHeight, 1.7);
        assert.equal(bundle.pdf.theme, 'print');
        // 顶层键与 mineru、raster 段不绑定目标：越界照常报错
        assert.throws(() => service.buildOptions({ jpegQuality: 120 }, { targets: ['bundle'] }), /选项 jpegQuality/);
        assert.throws(() => service.buildOptions({ mineruTimeout: 5 }, { targets: ['docx'] }), /选项 mineru\.timeoutSec/);
        assert.throws(() => service.buildOptions({ rasterScale: 9 }, { targets: ['docx'] }), /选项 raster\.scale/);
        // 类型转换失败与目标无关，照常报错
        assert.throws(() => service.buildOptions({ lineHeight: 'abc' }, { targets: ['docx'] }), /参数 lineHeight 须为数字/);
        assert.throws(() => service.buildOptions({}, { targets: 'docx' }), /targets 须为目标名数组/);
    });

    test('docxFontSize / fontAscii / fontEastAsia 只作用于 docx 段，docxFontSize 优先于 fontSize', () => {
        // Act
        const opts = service.buildOptions({ fontSize: '18', docxFontSize: '12', fontAscii: 'Georgia', fontEastAsia: '宋体' });

        // Assert
        assert.equal(opts.html.fontSize, 18);
        assert.equal(opts.docx.fontSize, 12);
        assert.deepEqual(opts.docx.fontFamily, { ascii: 'Georgia', eastAsia: '宋体' });
    });

    test('xml 段内 imageDpi / sectionDetection / rasterizeTables / rasterizeFormulas 展开到 xml.patent', () => {
        // Act
        const opts = service.buildOptions({
            xml: { imageDpi: 200, sectionDetection: 'headings', rasterizeTables: false, rasterizeFormulas: false },
            pdf: { pageSize: 'Letter', landscape: true },
            raster: { scale: 3, maxWidth: 1200 },
        });

        // Assert
        assert.deepEqual(opts.xml.patent, {
            parts: 'auto', rasterizeTables: false, rasterizeFormulas: false, imageDpi: 200, sectionDetection: 'headings',
        });
        assert.equal(opts.pdf.pageSize, 'Letter');
        assert.equal(opts.pdf.landscape, true);
        assert.deepEqual(opts.raster, { scale: 3, maxWidth: 1200 });
    });
});

// ============================================================
// describeOptionHint（CLI 帮助与 MCP 入参描述同源的取值说明）
// ============================================================

describe('describeOptionHint', () => {
    test('单路径：枚举列可选值、数字列范围，附默认值；默认为 null 的可空项不列', () => {
        assert.equal(service.describeOptionHint(['jpegQuality']), '（范围 60–100；默认 90）');
        assert.equal(service.describeOptionHint(['xml.profile']), '（可选 generic | patent；默认 generic）');
        assert.equal(service.describeOptionHint(['mineru.formula']), '（默认 true）');
        assert.equal(service.describeOptionHint(['html.fontFamily']), '');
    });

    test('多路径：取值相同则合并，默认值不同逐段列出；取值不同则逐段列范围与默认', () => {
        assert.equal(
            service.describeOptionHint(['html.theme', 'pdf.theme']),
            '（可选 apple | apple-dark | github | academic | reader | print；html 默认 apple，pdf 默认 print）',
        );
        assert.equal(service.describeOptionHint(['html.fontSize', 'docx.fontSize']), '（html 范围 10–32，默认 16；docx 范围 8–36，默认 11）');
        assert.equal(service.describeOptionHint(['pdf.pageSize', 'docx.pageSize']), '（可选 A4 | Letter；默认 A4）');
    });

    test('describeOptionSpec 取描述树叶子；未知路径抛中文错误', () => {
        assert.equal(service.describeOptionSpec('xml.patent.imageDpi').max, 600);
        assert.equal(service.describeOptionSpec('html.nope'), null);
        assert.throws(() => service.describeOptionHint(['html.nope']), /未知选项路径：html\.nope/);
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
        assert.deepEqual(Object.keys(caps).sort(), ['libreoffice', 'mineru', 'pdfBackend', 'raster', 'themes', 'validator', 'xmlProfiles']);
        // DTD 校验器与 LibreOffice 同 raster 一样报 { name, available, hint }，可用性与名称一致
        for (const key of ['validator', 'libreoffice']) {
            assert.deepEqual(Object.keys(caps[key]).sort(), ['available', 'hint', 'name'], `${key} 的键`);
            assert.equal(caps[key].available, caps[key].name !== null, `${key} 可用性与名称一致`);
            assert.equal(typeof caps[key].hint, 'string');
        }
        if (fs.existsSync(path.join(ROOT, 'node_modules', 'libxml2-wasm'))) {
            assert.deepEqual(caps.validator, { name: 'libxml2-wasm', available: true, hint: '' });
        }
        if (!caps.libreoffice.available) assert.match(caps.libreoffice.hint, /非必需/);
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

    test('DTD 校验器探测在进程内缓存，可注入实现与复位', async () => {
        // Arrange
        isolateConfig({});
        let calls = 0;
        service._setValidatorProbe(async () => {
            calls += 1;
            return { name: 'stub-validator', available: true, hint: '' };
        });

        // Act
        const first = await service.probeCapabilities();
        const second = await service.probeCapabilities();

        // Assert
        assert.equal(calls, 1, '重复调用只探测一次');
        assert.equal(first.validator.name, 'stub-validator');
        assert.equal(second.validator.name, 'stub-validator');
        service._resetProbeCache();
        const third = await service.probeCapabilities();
        assert.notEqual(third.validator.name, 'stub-validator', '复位后回到真实探测');
    });

    test('令牌来自环境变量时只报来源，绝不透出令牌', async () => {
        isolateConfig({ MINERU_TOKEN: 'secret-xyz-123' });
        const caps = await service.probeCapabilities();
        assert.deepEqual(caps.mineru, { configured: true, source: 'env:MINERU_TOKEN' });
        assert.equal(JSON.stringify(caps).includes('secret-xyz-123'), false);
        assert.equal(JSON.stringify(await service.describeFormats()).includes('secret-xyz-123'), false);
    });

    test('describeFormats 另报受理扩展名清单，既有字段不变', async () => {
        // Arrange
        isolateConfig({});

        // Act
        const formats = await service.describeFormats();

        // Assert
        assert.deepEqual(Object.keys(formats), ['targets', 'capabilities', 'extensions', 'version']);
        assert.deepEqual(formats.extensions, ['.docx', '.xlsx', '.pptx', '.pdf', '.md', '.markdown']);
        assert.equal(typeof formats.targets.capabilities.pdfBackend, 'object', 'targets.capabilities.pdfBackend 与 capabilities.pdfBackend 并存');
        assert.equal(typeof formats.capabilities.validator.available, 'boolean');
        assert.equal(typeof formats.capabilities.libreoffice.available, 'boolean');
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

    test('signal 中止后未领取的任务记为已取消：errors 带 cancelled 标记', async () => {
        // Arrange：并发 1，首项完成即中止；worker 领下一项前会查中止标记，故后两项必然未开始
        const inDir = fs.mkdtempSync(path.join(root, 'cancel-in-'));
        const inputs = ['a.md', 'b.md', 'c.md'].map((name) => {
            const file = path.join(inDir, name);
            fs.writeFileSync(file, `# ${name}\n\n正文\n`);
            return file;
        });
        const outputDir = fs.mkdtempSync(path.join(root, 'cancel-out-'));
        const tasks = service.planTasks(inputs, 'docx', ROOT);
        const controller = new AbortController();

        // Act
        const payload = await service.runConversion({
            tasks, outputDir, concurrency: 1, signal: controller.signal,
            onEvent: (event) => { if (event.type === 'item') controller.abort(); },
        });

        // Assert
        assert.equal(payload.ok, false);
        assert.deepEqual(payload.results.map((item) => item.input), [inputs[0]]);
        assert.deepEqual(payload.errors.map((item) => item.input), [inputs[1], inputs[2]]);
        payload.errors.forEach((item) => {
            assert.equal(item.cancelled, true, '取消项须带 cancelled 标记');
            assert.equal(item.error, '已取消');
        });
        assert.equal(payload.results[0].skipped, undefined, '未启用 skipExisting 时结果不带 skipped');
    });

    test('skipExisting 与 clean 透传给 convert：命中跳过时结果带 skipped 且不重写产物', async () => {
        // Arrange
        const inDir = fs.mkdtempSync(path.join(root, 'skip-in-'));
        const input = path.join(inDir, 'keep.md');
        fs.writeFileSync(input, '# 标题\n\n正文\n');
        const outputDir = fs.mkdtempSync(path.join(root, 'skip-out-'));
        const tasks = service.planTasks([input], 'docx', ROOT);

        // Act
        const first = await service.runConversion({ tasks, outputDir });
        const produced = first.results[0].outputPath;
        const mtimeBefore = fs.statSync(produced).mtimeMs;
        const second = await service.runConversion({ tasks, outputDir, skipExisting: true });
        const badClean = await service.runConversion({ tasks, outputDir, clean: 'yes' });

        // Assert
        assert.equal(first.results[0].skipped, undefined);
        assert.equal(second.results[0].skipped, true);
        assert.equal(fs.statSync(produced).mtimeMs, mtimeBefore, '跳过时不得重写产物');
        assert.match(badClean.errors[0].error, /参数 clean 须为布尔值/, 'clean 原样透传给 convert');
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
