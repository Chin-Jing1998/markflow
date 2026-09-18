/**
 * converters/index.js 调度器单元测试
 * 覆盖：导出与懒加载、detectInputType、listTargets（规则派生）、convert 参数校验与非法选项、
 *       md → docx 与 md → html 真实端到端、三段式 API 独立调用、bundle/pdf/html/xml 经桩 parser/renderer
 *       的编排逻辑（字符串产物与 files 对象落盘、options 透传、extras 落盘与穿越拒绝、管线桩调用、渲染器缺失）、
 *       重跑策略 skipExisting / clean
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const converters = require('../converters');

// 懒加载断言必须在任何 parser/renderer 被触达前执行，故紧跟 require 之后
const HEAVY_MODULE_RE = /parsers|renderers|legacy|mammoth|exceljs|pdfjs|docx\/|pptxgenjs|cheerio|turndown/;
const loadedAtStartup = Object.keys(require.cache).filter((k) => HEAVY_MODULE_RE.test(k));

const { createDocument, createRoot, createHeading, createParagraph } = require('../converters/ir/schema');

const {
    convert, parseDocument, renderDocument, renderBundleSidecars, writeDocument,
    listTargets, detectInputType, SUPPORTED_EXTENSIONS, runBatch, _setModuleLoader, _reset,
} = converters;

const CONVERTERS_DIR = path.join(__dirname, '..', 'converters');
const FIXTURES = path.join(__dirname, 'fixtures');
const SAMPLE_MD = path.join(FIXTURES, 'sample.md');
const PNG = fs.readFileSync(path.join(FIXTURES, 'images', 'pic.png'));

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'index-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// ============================================================
// 导出与懒加载
// ============================================================

describe('模块导出与懒加载', () => {
    test('导出 convert / parseDocument / renderDocument / writeDocument / listTargets / detectInputType / SUPPORTED_EXTENSIONS / runBatch', () => {
        assert.equal(typeof convert, 'function');
        assert.equal(typeof parseDocument, 'function');
        assert.equal(typeof renderDocument, 'function');
        assert.equal(typeof writeDocument, 'function');
        assert.equal(typeof listTargets, 'function');
        assert.equal(typeof detectInputType, 'function');
        assert.equal(typeof runBatch, 'function');
        assert.equal(runBatch, require('../converters/batch').runBatch);
        assert.ok(Array.isArray(SUPPORTED_EXTENSIONS));
        assert.ok(Object.isFrozen(SUPPORTED_EXTENSIONS));
        for (const ext of ['.docx', '.xlsx', '.pptx', '.pdf', '.md', '.markdown', '.xml', '.zip']) {
            assert.ok(SUPPORTED_EXTENSIONS.includes(ext), ext);
        }
        for (const ext of ['.doc', '.xls', '.ppt']) {
            assert.equal(SUPPORTED_EXTENSIONS.includes(ext), false, ext);
        }
    });

    test('require 调度器不加载任何 parser / renderer / 重依赖', () => {
        assert.deepEqual(loadedAtStartup, []);
    });
});

// ============================================================
// detectInputType
// ============================================================

describe('detectInputType', () => {
    test('按扩展名识别（大小写无关），.markdown 归 md', () => {
        const cases = {
            '/a/b.docx': 'docx',
            'x.xlsx': 'xlsx',
            'x.pptx': 'pptx',
            'x.PDF': 'pdf',
            'x.md': 'md',
            'x.markdown': 'md',
            '/路径/中文 文件.Md': 'md',
            '/案卷/100002.xml': 'xml',
            '案卷.ZIP': 'zip',
        };
        for (const [input, expected] of Object.entries(cases)) {
            assert.equal(detectInputType(input), expected, input);
        }
    });

    test('http(s) 归 url', () => {
        assert.equal(detectInputType('https://example.com/a.docx'), 'url');
        assert.equal(detectInputType('HTTP://x.y'), 'url');
    });

    test('未知扩展名、无扩展名与空值返回 null', () => {
        for (const value of ['x.txt', 'x.html', 'x.json', 'x.doc', 'x.XLS', 'x.ppt', 'noext', '', '   ', null, undefined, 42]) {
            assert.equal(detectInputType(value), null, String(value));
        }
    });
});

// ============================================================
// listTargets
// ============================================================

describe('listTargets', () => {
    test('默认：无 PDF 后端时由规则派生，office/url 为 bundle+html+xml，markup 无 pdf', () => {
        assert.deepEqual(listTargets(), {
            office: ['bundle', 'html', 'xml'],
            markup: ['docx', 'html', 'xml'],
            url: ['bundle', 'html', 'xml'],
            inputs: { docx: 'office', xlsx: 'office', pptx: 'office', pdf: 'office', md: 'markup', xml: 'markup', zip: 'markup', url: 'url' },
            capabilities: { pdfBackend: null },
        });
    });

    test('inputs 不含 markdown 键（.markdown 已由 detectInputType 归入 md），也不含旧二进制格式', () => {
        const { inputs } = listTargets();
        assert.equal('markdown' in inputs, false);
        assert.deepEqual(Object.keys(inputs), ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'xml', 'zip', 'url']);
    });

    test('pdfBackend 存在时 markup 含 pdf 且顺序固定；与 targets.js 同一实现', () => {
        const backend = { name: 'electron-worker', available: true, hint: '' };
        const targets = listTargets({ pdfBackend: backend });
        assert.deepEqual(targets.markup, ['docx', 'pdf', 'html', 'xml']);
        assert.deepEqual(targets.office, ['bundle', 'html', 'xml']);
        assert.deepEqual(targets.capabilities, { pdfBackend: backend });
        assert.equal('sofficeAvailable' in targets.capabilities, false);
        assert.equal(listTargets, require('../converters/targets').listTargets);
    });
});

// ============================================================
// convert 参数校验（均在加载 parser 之前失败）
// ============================================================

describe('convert 参数校验', () => {
    const base = { target: 'docx', outputDir: root };

    test('相对路径拒绝', async () => {
        await assert.rejects(convert({ ...base, input: { path: 'test/fixtures/sample.md' } }), /绝对路径/);
    });

    test('不存在的文件与目录路径拒绝', async () => {
        await assert.rejects(convert({ ...base, input: { path: path.join(root, '不存在.md') } }), /不存在/);
        await assert.rejects(convert({ ...base, input: { path: root } }), /不是文件/);
    });

    test('不支持的扩展名拒绝', async () => {
        const txt = path.join(root, 'a.txt');
        fs.writeFileSync(txt, 'x');
        await assert.rejects(convert({ ...base, input: { path: txt } }), /不支持的输入格式/);
    });

    test('outputDir 缺失、不存在或不是目录时拒绝', async () => {
        const input = { path: SAMPLE_MD };
        await assert.rejects(convert({ input, target: 'docx' }), /outputDir/);
        await assert.rejects(convert({ input, target: 'docx', outputDir: path.join(root, 'missing') }), /输出目录不存在/);
        await assert.rejects(convert({ input, target: 'docx', outputDir: SAMPLE_MD }), /不是目录/);
    });

    test('path 与 url 同时给出、都不给或 input 非对象时拒绝', async () => {
        await assert.rejects(convert({ ...base, input: { path: SAMPLE_MD, url: 'https://x.y' } }), /二选一/);
        await assert.rejects(convert({ ...base, input: {} }), /二选一/);
        await assert.rejects(convert({ ...base, input: 'x' }), /二选一/);
        await assert.rejects(convert({ ...base }), /二选一/);
    });

    test('非法 target 拒绝', async () => {
        await assert.rejects(convert({ input: { path: SAMPLE_MD }, target: 'epub', outputDir: root }), /不支持的目标格式：epub（可选：bundle、docx、pdf、html、xml）/);
        await assert.rejects(convert({ input: { path: SAMPLE_MD }, outputDir: root }), /不支持的目标格式/);
    });

    test('非法选项拒绝：中文错误，且在加载 parser 之前失败', async () => {
        await assert.rejects(
            convert({ ...base, input: { path: SAMPLE_MD }, options: { jpegQuality: 1 } }),
            /选项 jpegQuality 须为 60–100 之间的整数，实际：1/,
        );
        await assert.rejects(convert({ ...base, input: { path: SAMPLE_MD }, options: { html: { theme: 'x' } } }), /选项 html\.theme/);
        await assert.rejects(convert({ ...base, input: { path: SAMPLE_MD }, options: { typo: true } }), /未知选项：typo/);
        await assert.rejects(convert({ ...base, input: { path: SAMPLE_MD }, options: 'jpg' }), /选项 options 须为对象/);
        assert.deepEqual(Object.keys(require.cache).filter((k) => /converters\/parsers\//.test(k)), [], '校验阶段不得加载 parser');
    });

    test('md → bundle 拒绝', async () => {
        await assert.rejects(convert({ input: { path: SAMPLE_MD }, target: 'bundle', outputDir: root }), /bundle 仅接受/);
    });

    test('docx → docx 与 docx → pdf 拒绝', async () => {
        const docx = path.join(root, 'in.docx');
        fs.writeFileSync(docx, 'PK');
        await assert.rejects(convert({ input: { path: docx }, target: 'docx', outputDir: root }), /docx 仅接受 Markdown/);
        await assert.rejects(convert({ input: { path: docx }, target: 'pdf', outputDir: root }), /pdf 仅接受 Markdown/);
    });

    test('非 http(s) 网址拒绝', async () => {
        await assert.rejects(convert({ input: { url: 'ftp://x/y' }, target: 'bundle', outputDir: root }), /http\(s\)/);
    });
});

// ============================================================
// md → docx：真实 parser 与 renderer
// ============================================================

describe('convert：md → docx（真实 parser 与 renderer）', () => {
    test('产出 .docx，标题取首个 H1，名称取文件名，进度事件依序', async () => {
        // Arrange
        const events = [];

        // Act
        const res = await convert({
            input: { path: SAMPLE_MD },
            target: 'docx',
            outputDir: root,
            onProgress: (phase, pct) => events.push([phase, pct]),
        });

        // Assert
        assert.equal(res.ok, true);
        assert.equal(res.target, 'docx');
        assert.equal(res.name, 'sample');
        assert.equal(res.title, '标题');
        assert.equal(res.sourceType, 'md');
        assert.equal(res.outputPath, path.join(root, 'sample.docx'));
        assert.deepEqual(res.outputs, { docx: res.outputPath });
        assert.equal(res.imagesCount, 1);
        assert.ok(Array.isArray(res.warnings));
        assert.equal(fs.readFileSync(res.outputPath).subarray(0, 2).toString(), 'PK');

        // 四个调度事件按序出现（parser 的细粒度进度允许穿插其间）
        const expected = ['parsing:20', 'rendering:60', 'writing:90', 'writing:100'];
        let cursor = 0;
        for (const [phase, pct] of events) {
            assert.equal(typeof phase, 'string');
            assert.ok(Number.isFinite(pct));
            if (`${phase}:${pct}` === expected[cursor]) cursor += 1;
        }
        assert.equal(cursor, expected.length, JSON.stringify(events));
    });
});

// ============================================================
// bundle / pdf：桩 parser 与 renderer（隔离并行执行者的模块）
// ============================================================

describe('convert：bundle / pdf（桩 parser 与 renderer）', () => {
    // stubs[rel] = 模块对象；null 表示模拟「模块缺失」；函数表示自定义加载行为（可抛错）
    let stubs = {};

    function stubLoader(rel) {
        if (!Object.prototype.hasOwnProperty.call(stubs, rel)) {
            return require(path.join(CONVERTERS_DIR, rel));
        }
        const stub = stubs[rel];
        if (stub === null) {
            const err = new Error(`Cannot find module '${rel}'`);
            err.code = 'MODULE_NOT_FOUND';
            throw err;
        }
        return typeof stub === 'function' ? stub() : stub;
    }

    before(() => _setModuleLoader(stubLoader));
    beforeEach(() => { stubs = {}; });
    after(() => _reset());

    const emptyMdDoc = (sourceType = 'md') => createDocument({ ir: createRoot([]), meta: { sourceType } });

    test('office 输入 → bundle：三件套落盘，标题取 H1，名称取文件名，imagesCount 取 assets 长度', async () => {
        // Arrange
        const inputPath = path.join(root, '季度 报告.docx');
        fs.writeFileSync(inputPath, 'PK');
        let seen = null;
        stubs['./parsers/docx'] = {
            parse: async (input, ctx) => {
                seen = { input, ctx };
                return createDocument({
                    ir: createRoot([
                        createHeading(1, '来自 H1 的标题'),
                        createParagraph('正文'),
                        { type: 'paragraph', children: [{ type: 'image', url: 'images/image_1.png', alt: '图' }] },
                    ]),
                    meta: { sourceType: 'docx', sourceName: ctx.sourceName },
                    assets: [{ name: 'images/image_1.png', buffer: PNG, mime: 'image/png' }],
                    warnings: ['提示一'],
                });
            },
        };

        // Act
        const res = await convert({ input: { path: inputPath }, target: 'bundle', outputDir: root });

        // Assert：parser 收到的入参与上下文
        assert.deepEqual(seen.input, { path: inputPath });
        assert.equal(seen.ctx.sourceName, '季度 报告.docx');
        assert.equal(typeof seen.ctx.onProgress, 'function');
        assert.equal(seen.ctx.allowPrivateNetwork, false);
        assert.equal(seen.ctx.fetchRemote, undefined);

        // Assert：返回结构
        const dir = path.join(root, '季度 报告');
        assert.equal(res.ok, true);
        assert.equal(res.target, 'bundle');
        assert.equal(res.name, '季度 报告');
        assert.equal(res.title, '来自 H1 的标题');
        assert.equal(res.sourceType, 'docx');
        assert.equal(res.outputPath, dir);
        assert.deepEqual(res.outputs, {
            md: path.join(dir, '季度 报告.md'),
            json: path.join(dir, '季度 报告.json'),
            contentList: path.join(dir, '季度 报告_content_list.json'),
            imagesDir: path.join(dir, 'images'),
        });
        assert.equal(res.imagesCount, 1);
        assert.deepEqual(res.warnings, ['提示一']);

        // Assert：产物内容。bundle 的 Markdown 带 YAML front matter，办公文档只写它拥有的字段
        const md = fs.readFileSync(res.outputs.md, 'utf8');
        assert.match(
            md,
            /^---\ntitle: "来自 H1 的标题"\nsource: "季度 报告\.docx"\nsourceType: "docx"\nconvertedAt: "[^"]+"\n---\n\n# 来自 H1 的标题/,
        );
        // bundle 不做 JPG 归一：images/ 存原图（字节一致），Markdown 引用原资源名
        assert.match(md, /!\[图\]\(images\/image_1\.png\)/);
        const json = JSON.parse(fs.readFileSync(res.outputs.json, 'utf8'));
        assert.deepEqual(Object.keys(json), ['schemaVersion', 'kind', 'ir', 'data', 'meta']);
        assert.equal(json.meta.title, '来自 H1 的标题');
        assert.ok(fs.readFileSync(path.join(res.outputs.imagesDir, 'image_1.png')).equals(PNG));
        const contentList = JSON.parse(fs.readFileSync(res.outputs.contentList, 'utf8'));
        assert.deepEqual(contentList.map((block) => block.type), ['text', 'text', 'image']);
        assert.equal(contentList[2].img_path, 'images/image_1.png');
    });

    test('meta.title 优先于 H1，渲染前已写回 doc.meta.title；无 assets 时不建 images/', async () => {
        // Arrange
        const inputPath = path.join(root, 'a.pdf');
        fs.writeFileSync(inputPath, '%PDF');
        stubs['./parsers/pdf'] = {
            parse: async () => createDocument({
                ir: createRoot([createHeading(1, 'H1 标题')]),
                meta: { title: '元数据标题', sourceType: 'pdf' },
            }),
        };
        const titlesAtRender = [];
        stubs['./renderers/md'] = { render: async (doc) => { titlesAtRender.push(doc.meta.title); return '# x\n'; } };
        stubs['./renderers/json'] = { render: async (doc) => { titlesAtRender.push(doc.meta.title); return '{}'; } };

        // Act
        const res = await convert({ input: { path: inputPath }, target: 'bundle', outputDir: root });

        // Assert
        assert.equal(res.title, '元数据标题');
        assert.deepEqual(titlesAtRender, ['元数据标题', '元数据标题']);
        assert.equal(res.name, 'a');
        assert.equal(res.imagesCount, 0);
        assert.equal('imagesDir' in res.outputs, false);
        assert.equal(fs.existsSync(path.join(root, 'a', 'images')), false);
        assert.match(
            fs.readFileSync(res.outputs.md, 'utf8'),
            /^---\ntitle: "元数据标题"\nsourceType: "pdf"\nconvertedAt: "[^"]+"\n---\n\n# x\n$/,
        );
    });

    test('url 输入：无标题时名称为「主机名-时间戳」且标题回退默认值；有标题时取清洗后的标题', async () => {
        // Arrange
        let seenInput = null;
        stubs['./parsers/url'] = {
            parse: async (input) => {
                seenInput = input;
                return createDocument({ ir: createRoot([createParagraph('正文')]), meta: { sourceType: 'url' } });
            },
        };

        // Act
        const untitled = await convert({ input: { url: 'https://example.com/post/1' }, target: 'bundle', outputDir: root });

        // Assert
        assert.deepEqual(seenInput, { url: 'https://example.com/post/1' });
        assert.match(untitled.name, /^example\.com-\d{8}-\d{6}$/);
        assert.equal(untitled.title, '未命名文档');
        assert.equal(untitled.sourceType, 'url');
        assert.equal(untitled.outputPath, path.join(root, untitled.name));

        // Arrange：有标题
        stubs['./parsers/url'] = {
            parse: async () => createDocument({ ir: createRoot([createHeading(1, '网页: 标题?')]), meta: { sourceType: 'url' } }),
        };

        // Act
        const titled = await convert({ input: { url: 'https://example.com/post/2' }, target: 'bundle', outputDir: root });

        // Assert
        assert.equal(titled.title, '网页: 标题?');
        assert.equal(titled.name, '网页_ 标题');
    });

    test('md → pdf：渲染器返回 Buffer 时写出单文件', async () => {
        // Arrange
        stubs['./parsers/md'] = { parse: async () => createDocument({ ir: createRoot([createHeading(1, 'PDF 标题')]), meta: { sourceType: 'md' } }) };
        stubs['./renderers/pdf'] = { render: async () => Buffer.from('%PDF-1.4 stub') };

        // Act
        const res = await convert({ input: { path: SAMPLE_MD }, target: 'pdf', outputDir: root });

        // Assert
        assert.equal(res.target, 'pdf');
        assert.equal(res.title, 'PDF 标题');
        assert.equal(res.outputPath, path.join(root, 'sample.pdf'));
        assert.deepEqual(res.outputs, { pdf: res.outputPath });
        assert.equal(fs.readFileSync(res.outputPath, 'utf8'), '%PDF-1.4 stub');
    });

    test('无 H1 且无 meta.title 时标题回退为去扩展名的文件名', async () => {
        stubs['./parsers/md'] = { parse: async () => emptyMdDoc() };
        stubs['./renderers/docx'] = { render: async () => Buffer.from('PK') };

        const res = await convert({ input: { path: SAMPLE_MD }, target: 'docx', outputDir: root });

        assert.equal(res.title, 'sample');
        assert.equal(res.name, 'sample');
    });

    test('docx/pdf 目标：fetch-guard 存在时 fetchRemote 包装 fetchBinary 并透传 allowPrivateNetwork', async () => {
        // Arrange
        const calls = [];
        stubs['./net/fetch-guard'] = {
            fetchBinary: async (url, opts) => {
                calls.push({ url, opts });
                return { buffer: PNG, mime: 'image/png', finalUrl: url };
            },
        };
        let ctxSeen = null;
        stubs['./parsers/md'] = { parse: async (input, ctx) => { ctxSeen = ctx; return emptyMdDoc(); } };
        stubs['./renderers/docx'] = { render: async () => Buffer.from('PK') };

        // Act
        await convert({ input: { path: SAMPLE_MD }, target: 'docx', outputDir: root, allowPrivateNetwork: true });
        const fetched = await ctxSeen.fetchRemote('https://img.example.com/a.png');

        // Assert
        assert.equal(ctxSeen.allowPrivateNetwork, true);
        assert.equal(fetched.mime, 'image/png');
        assert.ok(fetched.buffer.equals(PNG));
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, 'https://img.example.com/a.png');
        assert.equal(calls[0].opts.allowPrivateNetwork, true);
        assert.ok(calls[0].opts.maxBytes > 0);
    });

    test('渲染器未返回 Buffer、解析器返回无效文档、模块缺少导出时均抛中文错误', async () => {
        const params = { input: { path: SAMPLE_MD }, target: 'docx', outputDir: root };

        stubs['./parsers/md'] = { parse: async () => emptyMdDoc() };
        stubs['./renderers/docx'] = { render: async () => 42 };
        await assert.rejects(convert(params), /渲染器 docx 返回了不支持的产物类型/);

        stubs['./renderers/docx'] = { render: async () => ({ files: { 'a.docx': Buffer.from('PK'), 'b.docx': Buffer.from('PK') } }) };
        await assert.rejects(convert(params), /目标 docx 为单文件布局，渲染器却产出了 2 个文件/);

        stubs['./parsers/md'] = { parse: async () => null };
        await assert.rejects(convert(params), /未返回有效的 IR 文档/);

        stubs['./parsers/md'] = {};
        await assert.rejects(convert(params), /未导出 parse\(\)/);

        stubs['./parsers/md'] = { parse: async () => emptyMdDoc() };
        stubs['./renderers/docx'] = {};
        await assert.rejects(convert(params), /未导出 render\(\)/);
    });

    test('parser 的 (string, number) 进度透传，其它形态丢弃；onProgress 抛错不影响转换', async () => {
        // Arrange
        stubs['./parsers/md'] = {
            parse: async (input, ctx) => {
                ctx.onProgress('parsing', 35);
                ctx.onProgress({ stage: 'parse' });
                ctx.onProgress('parsing', 'NaN');
                return emptyMdDoc();
            },
        };
        stubs['./renderers/docx'] = { render: async () => Buffer.from('PK') };
        const events = [];

        // Act
        const res = await convert({
            input: { path: SAMPLE_MD },
            target: 'docx',
            outputDir: root,
            onProgress: (phase, pct) => {
                events.push([phase, pct]);
                throw new Error('回调异常');
            },
        });

        // Assert
        assert.equal(res.ok, true);
        assert.deepEqual(events, [['parsing', 20], ['parsing', 35], ['rendering', 60], ['writing', 90], ['writing', 100]]);
    });

    test('parser 自定义阶段名归一为 parsing，pct 钳到 [0,55] 且单调不减', async () => {
        // Arrange：三次上报分别触发「阶段名归一」「上界钳制」「回退丢弃」
        stubs['./parsers/md'] = {
            parse: async (input, ctx) => {
                ctx.onProgress('fetching', 10);
                ctx.onProgress('assets', 90);
                ctx.onProgress('ir', 30);
                return emptyMdDoc();
            },
        };
        stubs['./renderers/docx'] = { render: async () => Buffer.from('PK') };
        const events = [];

        // Act
        const res = await convert({
            input: { path: SAMPLE_MD },
            target: 'docx',
            outputDir: root,
            onProgress: (phase, pct) => events.push([phase, pct]),
        });

        // Assert
        assert.equal(res.ok, true);
        assert.deepEqual(events, [
            ['parsing', 20],
            ['parsing', 10],
            ['parsing', 55],
            ['rendering', 60],
            ['writing', 90],
            ['writing', 100],
        ]);
    });

    test('pct 为负数时钳到 0，非有限数字整条丢弃', async () => {
        // Arrange
        stubs['./parsers/md'] = {
            parse: async (input, ctx) => {
                ctx.onProgress('parsing', -20);
                ctx.onProgress('parsing', Infinity);
                ctx.onProgress('parsing', NaN);
                return emptyMdDoc();
            },
        };
        stubs['./renderers/docx'] = { render: async () => Buffer.from('PK') };
        const events = [];

        // Act
        await convert({
            input: { path: SAMPLE_MD },
            target: 'docx',
            outputDir: root,
            onProgress: (phase, pct) => events.push([phase, pct]),
        });

        // Assert
        assert.deepEqual(events, [['parsing', 20], ['parsing', 0], ['rendering', 60], ['writing', 90], ['writing', 100]]);
    });
});

// ============================================================
// v3 契约：字符串/files 产物落盘、options 透传、extras、管线桩、三段式 API
// ============================================================

describe('convert：v3 契约（桩 parser / renderer）', () => {
    let stubs = {};

    function stubLoader(rel) {
        if (!Object.prototype.hasOwnProperty.call(stubs, rel)) {
            return require(path.join(CONVERTERS_DIR, rel));
        }
        const stub = stubs[rel];
        if (stub === null) {
            const err = new Error(`Cannot find module '${rel}'`);
            err.code = 'MODULE_NOT_FOUND';
            throw err;
        }
        return typeof stub === 'function' ? stub() : stub;
    }

    before(() => _setModuleLoader(stubLoader));
    beforeEach(() => { stubs = {}; });
    after(() => _reset());

    const mdDoc = (extra = {}) => createDocument({
        ir: createRoot([createHeading(1, '标题'), createParagraph('正文')]),
        meta: { sourceType: 'md' },
        ...extra,
    });

    test('md → html：渲染器返回字符串时按 utf8 落盘为 {name}/{name}.html，assets 写入 images/', async () => {
        // Arrange：真实 md parser（sample.md 含一张本地图片），html 渲染器用桩
        let seen = null;
        stubs['./renderers/html'] = { render: async (doc, options, extra) => { seen = { options, extra }; return '<html>你好</html>'; } };

        // Act
        const res = await convert({ input: { path: SAMPLE_MD }, target: 'html', outputDir: root });

        // Assert
        const dir = path.join(root, 'sample');
        assert.equal(res.ok, true);
        assert.equal(res.target, 'html');
        assert.equal(res.outputPath, dir);
        assert.deepEqual(res.outputs, { html: path.join(dir, 'sample.html'), imagesDir: path.join(dir, 'images') });
        assert.equal(fs.readFileSync(res.outputs.html, 'utf8'), '<html>你好</html>');
        // sample.md 的 PNG 经默认归一化落盘为 JPEG
        assert.equal(
            fs.readFileSync(path.join(dir, 'images', 'image_1.jpg')).subarray(0, 2).toString('hex'),
            'ffd8',
        );
        assert.equal(res.imagesCount, 1);
        assert.deepEqual(res.extras, []);
        assert.equal(seen.options.html.theme, 'apple');
        assert.equal(seen.extra.imageMode, 'relative');
    });

    test('html 目标 inlineImages 时 imageMode 为 inline，pdf 目标为 file，可由 renderDocument 显式覆盖', async () => {
        const modes = [];
        stubs['./renderers/html'] = { render: async (doc, options, extra) => { modes.push(extra.imageMode); return '<html/>'; } };
        stubs['./renderers/pdf'] = { render: async (doc, options, extra) => { modes.push(extra.imageMode); return Buffer.from('%PDF'); } };
        const doc = mdDoc();

        await renderDocument(doc, 'html', { html: { inlineImages: true } });
        await renderDocument(doc, 'pdf');
        await renderDocument(doc, 'html', undefined, { imageMode: { base: 'mf-asset://sid/' } });

        assert.deepEqual(modes, ['inline', 'file', { base: 'mf-asset://sid/' }]);
    });

    test('files 对象落盘：{name} 占位替换，outputs 按扩展名/文件名取键，含 imagesDir', async () => {
        // Arrange
        stubs['./parsers/md'] = {
            parse: async () => mdDoc({ assets: [{ name: 'images/image_1.png', buffer: PNG, mime: 'image/png' }] }),
        };
        stubs['./renderers/xml'] = {
            render: async () => ({
                files: {
                    '{name}.xml': '<doc/>',
                    'claims.xml': '<cn-claims/>',
                    'abstract-figure.xml': Buffer.from('<cn-abstract/>'),
                    '{name}.zip': Buffer.from('PK'),
                },
            }),
        };

        // Act
        const res = await convert({ input: { path: SAMPLE_MD }, target: 'xml', outputDir: root });

        // Assert
        const dir = path.join(root, 'sample');
        assert.equal(res.outputPath, dir);
        assert.deepEqual(res.outputs, {
            xml: path.join(dir, 'sample.xml'),
            claims: path.join(dir, 'claims.xml'),
            abstractFigure: path.join(dir, 'abstract-figure.xml'),
            zip: path.join(dir, 'sample.zip'),
            imagesDir: path.join(dir, 'images'),
        });
        assert.equal(fs.readFileSync(res.outputs.xml, 'utf8'), '<doc/>');
        assert.equal(fs.readFileSync(res.outputs.abstractFigure, 'utf8'), '<cn-abstract/>');
        assert.equal(fs.readFileSync(res.outputs.zip, 'latin1'), 'PK');
        assert.ok(fs.existsSync(path.join(dir, 'images', 'image_1.jpg')));
    });

    test('渲染器的 warnings 并入结果；omitDocAssets 为 true 时不合并 doc.assets，裸文件名资产平铺在产物目录根下且无 images/', async () => {
        // Arrange
        const outDir = fs.mkdtempSync(path.join(root, 'omit-'));
        stubs['./parsers/md'] = {
            parse: async () => mdDoc({ assets: [{ name: 'images/image_1.png', buffer: PNG, mime: 'image/png' }], warnings: ['来自 parser'] }),
        };
        stubs['./renderers/xml'] = {
            render: async () => ({
                files: { 'claims.xml': '<cn-claims/>' },
                assets: [{ name: 'drawing-1.jpg', buffer: PNG, mime: 'image/jpeg' }],
                warnings: ['来自渲染器'],
                omitDocAssets: true,
            }),
        };

        // Act
        const res = await convert({ input: { path: SAMPLE_MD }, target: 'xml', outputDir: outDir });
        const rendered = await renderDocument(mdDoc({ assets: [{ name: 'images/image_1.png', buffer: PNG, mime: 'image/png' }] }), 'xml');

        // Assert
        const dir = path.join(outDir, 'sample');
        assert.deepEqual(res.outputs, { claims: path.join(dir, 'claims.xml') });
        assert.ok(fs.readFileSync(path.join(dir, 'drawing-1.jpg')).equals(PNG));
        assert.equal(fs.existsSync(path.join(dir, 'images')), false, 'omitDocAssets 时不得落盘 doc.assets');
        assert.equal(res.imagesCount, 1);
        assert.deepEqual(res.warnings, ['来自 parser', '来自渲染器']);
        assert.deepEqual(rendered.warnings, ['来自渲染器']);
        assert.deepEqual(rendered.assets.map((asset) => asset.name), ['drawing-1.jpg']);
    });

    test('渲染器返回 title 时覆盖结果信封的 title；未返回或为空白时沿用解析阶段的标题', async () => {
        // Arrange
        const outDir = fs.mkdtempSync(path.join(root, 'title-'));
        stubs['./parsers/md'] = { parse: async () => mdDoc() };
        stubs['./renderers/xml'] = { render: async () => ({ files: { 'claims.xml': '<cn-claims/>' }, title: '  一种试剂灌装装置 ' }) };

        // Act
        const overridden = await convert({ input: { path: SAMPLE_MD }, target: 'xml', outputDir: outDir });
        const rendered = await renderDocument(mdDoc(), 'xml');
        stubs['./renderers/xml'] = { render: async () => ({ files: { 'claims.xml': '<cn-claims/>' }, title: '   ' }) };
        const blank = await convert({ input: { path: SAMPLE_MD }, target: 'xml', outputDir: outDir });
        const noTitle = await renderDocument(mdDoc(), 'xml');

        // Assert
        assert.equal(overridden.title, '一种试剂灌装装置');
        assert.equal(rendered.title, '一种试剂灌装装置');
        assert.equal(blank.title, '标题', '空白 title 沿用 H1 标题');
        assert.equal(noTitle.title, null);
        assert.equal(overridden.name, 'sample', '产物名不受渲染器 title 影响');
    });

    test('options 透传：parser 的 ctx.options 与渲染器第二参数是同一份归一冻结值，返回值中 token 已脱敏', async () => {
        // Arrange
        let ctxOptions = null;
        let renderOptions = null;
        stubs['./parsers/md'] = { parse: async (input, ctx) => { ctxOptions = ctx.options; return mdDoc(); } };
        stubs['./renderers/docx'] = { render: async (doc, options) => { renderOptions = options; return Buffer.from('PK'); } };

        // Act
        const res = await convert({
            input: { path: SAMPLE_MD }, target: 'docx', outputDir: root,
            options: { jpegQuality: 70, mineru: { token: 'top-secret' }, html: { theme: 'github' } },
        });

        // Assert
        assert.equal(ctxOptions, renderOptions);
        assert.ok(Object.isFrozen(ctxOptions));
        assert.equal(ctxOptions.jpegQuality, 70);
        assert.equal(ctxOptions.mineru.token, 'top-secret');
        assert.equal(ctxOptions.html.theme, 'github');
        assert.equal(ctxOptions.html.fontSize, 16);
        assert.equal(res.options.jpegQuality, 70);
        assert.equal(res.options.mineru.token, null);
        assert.equal(JSON.stringify(res).includes('top-secret'), false);
        assert.deepEqual(res.backends, { pdfParser: null, raster: null });
    });

    test('extras 落盘：附属文件按相对路径写入产物目录，顶层目录进 outputs.<dir>Dir，返回 extras 清单', async () => {
        // Arrange
        const inputPath = path.join(root, '扫描件.pdf');
        fs.writeFileSync(inputPath, '%PDF');
        stubs['./parsers/pdf'] = {
            parse: async () => createDocument({
                ir: createRoot([createHeading(1, '扫描件')]),
                meta: { sourceType: 'pdf', pdfParser: 'mineru' },
                extras: [
                    { name: 'mineru/full.md', buffer: Buffer.from('# full') },
                    { name: 'mineru/images/p1.jpg', buffer: Buffer.from('JPG') },
                ],
            }),
        };

        // Act
        const res = await convert({ input: { path: inputPath }, target: 'bundle', outputDir: root });

        // Assert
        const dir = path.join(root, '扫描件');
        assert.deepEqual(res.outputs, {
            md: path.join(dir, '扫描件.md'),
            json: path.join(dir, '扫描件.json'),
            contentList: path.join(dir, '扫描件_content_list.json'),
            mineruDir: path.join(dir, 'mineru'),
        });
        assert.deepEqual(res.extras, ['mineru/full.md', 'mineru/images/p1.jpg']);
        assert.equal(fs.readFileSync(path.join(dir, 'mineru', 'full.md'), 'utf8'), '# full');
        assert.equal(fs.readFileSync(path.join(dir, 'mineru', 'images', 'p1.jpg'), 'utf8'), 'JPG');
        assert.deepEqual(res.backends, { pdfParser: 'mineru', raster: null });
    });

    test('extras 穿越拒绝：../ 与绝对路径均抛中文错误，且产物目录内外都不落盘', async () => {
        // Arrange
        const inputPath = path.join(root, '越界.pdf');
        fs.writeFileSync(inputPath, '%PDF');
        const evil = [
            [{ name: '../evil.txt', buffer: Buffer.from('x') }, /附属文件名不得包含 "\.\."：\.\.\/evil\.txt/],
            [{ name: path.join(root, 'abs-evil.txt'), buffer: Buffer.from('x') }, /附属文件名不得为绝对路径/],
            [{ name: 'mineru/ok.md', buffer: 'not-buffer' }, /附属文件 mineru\/ok\.md 缺少 Buffer 内容/],
        ];

        for (const [extra, pattern] of evil) {
            stubs['./parsers/pdf'] = {
                parse: async () => createDocument({ ir: createRoot([createHeading(1, '越界')]), meta: { sourceType: 'pdf' }, extras: [extra] }),
            };

            // Act & Assert
            await assert.rejects(convert({ input: { path: inputPath }, target: 'bundle', outputDir: root }), pattern);
        }
        assert.equal(fs.existsSync(path.join(root, 'evil.txt')), false);
        assert.equal(fs.existsSync(path.join(root, 'abs-evil.txt')), false);
        assert.equal(fs.existsSync(path.join(root, '越界', '越界.md')), false, '校验失败时不得写出任何产物');
    });

    test('渲染器模块缺失时抛中文错误并指明模块路径', async () => {
        stubs['./parsers/md'] = { parse: async () => mdDoc() };
        stubs['./renderers/xml'] = null;
        await assert.rejects(
            convert({ input: { path: SAMPLE_MD }, target: 'xml', outputDir: root }),
            /渲染器 xml 尚未提供：模块 converters\/renderers\/xml\.js 不存在/,
        );
        // 模块内部的加载错误原样透出，不被误报为「尚未提供」
        stubs['./renderers/xml'] = () => { const err = new Error('Cannot find module \'xmlbuilder2\''); err.code = 'MODULE_NOT_FOUND'; throw err; };
        await assert.rejects(convert({ input: { path: SAMPLE_MD }, target: 'xml', outputDir: root }), /Cannot find module 'xmlbuilder2'/);
    });

    test('管线桩：normalizeImages 总在 parser 之后调用；rasterizeNodes 仅在 math=image 或 patent profile 时调用', async () => {
        // Arrange
        const calls = [];
        stubs['./parsers/md'] = { parse: async () => mdDoc({ warnings: ['来自 parser'] }) };
        stubs['./renderers/docx'] = { render: async () => Buffer.from('PK') };
        stubs['./assets/image-normalize'] = {
            normalizeImages: async (doc, options) => {
                calls.push(['normalize', options.imageFormat]);
                return { doc: { ...doc, meta: { ...doc.meta, normalized: true } }, converted: 0, kept: 0, warnings: ['来自归一化'] };
            },
        };
        stubs['./raster/rasterize-nodes'] = {
            rasterizeNodes: async (doc, { kinds }) => {
                calls.push(['rasterize', kinds]);
                assert.equal(doc.meta.normalized, true, '栅格化须在归一化之后');
                return { doc, rasterized: 0, warnings: ['来自栅格化'], backend: 'stub-raster' };
            },
        };
        const run = (options, target = 'docx') => convert({ input: { path: SAMPLE_MD }, target, outputDir: root, options });

        // Act & Assert：默认 math=image → 只栅格公式
        let res = await run();
        assert.deepEqual(calls, [['normalize', 'jpg'], ['rasterize', ['math']]]);
        assert.deepEqual(res.warnings, ['来自 parser', '来自归一化', '来自栅格化']);
        assert.equal(res.backends.raster, 'stub-raster');

        // math=text → 不栅格
        calls.length = 0;
        res = await run({ math: 'text', imageFormat: 'keep' });
        assert.deepEqual(calls, [['normalize', 'keep']]);
        assert.equal(res.backends.raster, null);

        // patent profile 但目标不是 xml → 表格不栅格；parseDocument 目标为 xml 时表格与公式都栅格
        calls.length = 0;
        await run({ math: 'text', xml: { profile: 'patent' } });
        assert.deepEqual(calls, [['normalize', 'jpg']]);
        calls.length = 0;
        await parseDocument({ input: { path: SAMPLE_MD }, target: 'xml', options: { math: 'text', xml: { profile: 'patent' } } });
        assert.deepEqual(calls, [['normalize', 'jpg'], ['rasterize', ['table', 'math']]]);
        calls.length = 0;
        await parseDocument({ input: { path: SAMPLE_MD }, options: { xml: { profile: 'patent', patent: { rasterizeTables: false } } } });
        assert.deepEqual(calls, [['normalize', 'jpg'], ['rasterize', ['math']]]);
    });

    test('parseDocument / renderDocument / writeDocument 可独立调用，组合结果与 convert 一致', async () => {
        // Act：真实 md parser 与 docx 渲染器
        const events = [];
        const parsed = await parseDocument({ input: { path: SAMPLE_MD }, onProgress: (phase, pct) => events.push([phase, pct]) });
        const rendered = await renderDocument(parsed.doc, 'docx', parsed.options);
        const written = await writeDocument({ rendered, target: 'docx', outputDir: root, name: parsed.name });

        // Assert
        assert.equal(parsed.source.type, 'md');
        assert.equal(parsed.name, 'sample');
        assert.equal(parsed.title, '标题');
        assert.deepEqual(parsed.backends, { pdfParser: null, raster: null });
        assert.ok(Object.isFrozen(parsed.options));
        assert.deepEqual(parsed.doc.extras, []);
        assert.deepEqual(events[0], ['parsing', 20]);
        assert.ok(events.every(([phase, pct]) => phase === 'parsing' && pct <= 55));
        assert.deepEqual(Object.keys(rendered.files), ['{name}.docx']);
        assert.ok(Buffer.isBuffer(rendered.files['{name}.docx']));
        assert.equal(rendered.layout, 'single');
        assert.equal(rendered.assets.length, 1);
        assert.deepEqual(written, { outputPath: path.join(root, 'sample.docx'), outputs: { docx: path.join(root, 'sample.docx') }, extras: [] });
        assert.equal(fs.readFileSync(written.outputPath).subarray(0, 2).toString(), 'PK');
    });

    test('parseDocument 未给 target 时为 md 输入提供 fetchRemote，bundle 目标则不提供', async () => {
        const ctxs = [];
        stubs['./parsers/md'] = { parse: async (input, ctx) => { ctxs.push(ctx); return mdDoc(); } };
        await parseDocument({ input: { path: SAMPLE_MD } });
        await parseDocument({ input: { path: SAMPLE_MD }, target: 'docx' });
        await parseDocument({ input: { path: SAMPLE_MD }, target: 'html' });
        assert.equal(typeof ctxs[0].fetchRemote, 'function');
        assert.equal(typeof ctxs[1].fetchRemote, 'function');
        assert.equal(ctxs[2].fetchRemote, undefined);
        await assert.rejects(parseDocument({ input: { path: SAMPLE_MD }, target: 'epub' }), /不支持的目标格式：epub/);
    });

    test('writeDocument 与 renderDocument 的参数校验', async () => {
        await assert.rejects(renderDocument(null, 'docx'), /renderDocument 需要有效的 IR 文档/);
        await assert.rejects(renderDocument(mdDoc(), 'epub'), /不支持的目标格式：epub/);
        await assert.rejects(writeDocument({ rendered: { files: {} }, target: 'docx', outputDir: root, name: 'x' }), /只能写出一个文件（实际 0 个）/);
        await assert.rejects(writeDocument({ rendered: null, target: 'docx', outputDir: root, name: 'x' }), /writeDocument 需要 renderDocument 的结果/);
        await assert.rejects(writeDocument({ rendered: { files: { '{name}.docx': Buffer.from('PK') } }, target: 'docx', outputDir: path.join(root, 'missing'), name: 'x' }), /输出目录不存在/);
    });
});

// ============================================================
// html 目标：真实 renderers/html（图片寻址与主题的端到端验证）
// ============================================================

describe('convert：→ html（真实 renderers/html）', () => {
    let stubs = {};

    function stubLoader(rel) {
        if (!Object.prototype.hasOwnProperty.call(stubs, rel)) {
            return require(path.join(CONVERTERS_DIR, rel));
        }
        return stubs[rel];
    }

    before(() => _setModuleLoader(stubLoader));
    beforeEach(() => { stubs = {}; });
    after(() => _reset());

    test('md → html：产物为 {name}/{name}.html + images/，图片 src 指向 images/ 下的真实文件', async () => {
        // Act
        const res = await convert({
            input: { path: SAMPLE_MD }, target: 'html', outputDir: root,
            options: { html: { theme: 'github' } },
        });

        // Assert：目录结构
        const dir = path.join(root, 'sample');
        assert.equal(res.outputPath, dir);
        assert.deepEqual(res.outputs, { html: path.join(dir, 'sample.html'), imagesDir: path.join(dir, 'images') });
        const images = fs.readdirSync(res.outputs.imagesDir);
        assert.equal(images.length, 1);
        assert.match(images[0], /^image_1\.(jpg|png)$/);

        // Assert：产物内容——src 为 images/ 相对路径且文件确实存在，主题与 CSP 随选项生效
        const html = fs.readFileSync(res.outputs.html, 'utf8');
        const src = /<img src="([^"]+)"/.exec(html);
        assert.ok(src, html.slice(0, 400));
        assert.equal(src[1], `images/${images[0]}`);
        assert.ok(fs.existsSync(path.join(dir, src[1])));
        assert.ok(html.includes(`content="default-src 'none'; img-src 'self' file: data:; style-src 'unsafe-inline'; font-src file: data:"`));
        assert.ok(html.includes('#0969da'), 'github 主题应生效');
        assert.ok(html.includes('<title>标题</title>'));
    });

    test('桩 docx → html：parser 以资产名作节点地址时同样落到 images/，inlineImages 改为 data URI', async () => {
        // Arrange
        const inputPath = path.join(root, '报告.docx');
        fs.writeFileSync(inputPath, 'PK');
        stubs['./parsers/docx'] = {
            parse: async () => createDocument({
                ir: createRoot([
                    createHeading(1, '报告标题'),
                    { type: 'paragraph', children: [{ type: 'image', url: 'images/image_1.png', alt: '插图' }] },
                ]),
                meta: { sourceType: 'docx' },
                assets: [{ name: 'images/image_1.png', buffer: PNG, mime: 'image/png' }],
            }),
        };

        // Act：imageFormat: 'keep' 让资产名不随 JPG 归一改变，断言与桩数据一致；
        // 两次转换写入不同目录，避免后一次覆盖前一次的产物
        const inlineDir = fs.mkdtempSync(path.join(root, 'inline-'));
        const relative = await convert({
            input: { path: inputPath }, target: 'html', outputDir: root,
            options: { imageFormat: 'keep' },
        });
        const inline = await convert({
            input: { path: inputPath }, target: 'html', outputDir: inlineDir,
            options: { imageFormat: 'keep', html: { inlineImages: true } },
        });

        // Assert
        const dir = path.join(root, '报告');
        assert.deepEqual(relative.outputs, { html: path.join(dir, '报告.html'), imagesDir: path.join(dir, 'images') });
        const html = fs.readFileSync(relative.outputs.html, 'utf8');
        assert.ok(html.includes('<img src="images/image_1.png" alt="插图">'), html.slice(0, 400));
        assert.ok(fs.readFileSync(path.join(dir, 'images', 'image_1.png')).equals(PNG));

        // Assert：inlineImages 走 data URI，CSP 收紧到只放行 data:
        const inlineHtml = fs.readFileSync(inline.outputs.html, 'utf8');
        assert.ok(inlineHtml.includes(`src="data:image/png;base64,${PNG.toString('base64')}"`), inlineHtml.slice(0, 400));
        assert.ok(inlineHtml.includes("img-src data:;"));
    });
});

// ============================================================
// 批内产物名登记的接线（登记表自身的规则见 test/naming.test.js）
// ============================================================

const { createNameRegistry } = require('../converters/naming');

describe('convert：批内产物名登记（桩 parser 与 renderer）', () => {
    let stubs = {};

    function stubLoader(rel) {
        if (!Object.prototype.hasOwnProperty.call(stubs, rel)) return require(path.join(CONVERTERS_DIR, rel));
        return stubs[rel];
    }

    before(() => _setModuleLoader(stubLoader));
    after(() => _reset());
    beforeEach(() => {
        const parse = (sourceType) => async () => createDocument({
            ir: createRoot([createParagraph(sourceType)]),
            meta: { sourceType },
        });
        stubs = {
            './parsers/docx': { parse: parse('docx') },
            './parsers/pptx': { parse: parse('pptx') },
            './parsers/md': { parse: parse('md') },
            './renderers/md': { render: async () => '# 正文\n' },
            './renderers/json': { render: async () => '{}' },
            './renderers/docx': { render: async () => Buffer.from('PK docx') },
        };
    });

    // 在一个新建的临时目录下造出一组输入文件 → 绝对路径
    function seedInputs(dirPrefix, names) {
        const dir = fs.mkdtempSync(path.join(root, dirPrefix));
        return names.map((name) => {
            const file = path.join(dir, name);
            fs.writeFileSync(file, 'PK');
            return file;
        });
    }

    test('传入登记表时后到的同名任务改名，两份产物同时留在输出目录', async () => {
        // Arrange
        const [docxPath, pptxPath] = seedInputs('claim-in-', ['sample.docx', 'sample.pptx']);
        const outputDir = fs.mkdtempSync(path.join(root, 'claim-out-'));
        const nameRegistry = createNameRegistry();

        // Act
        const first = await convert({ input: { path: docxPath }, target: 'bundle', outputDir, nameRegistry });
        const second = await convert({ input: { path: pptxPath }, target: 'bundle', outputDir, nameRegistry });

        // Assert：结果信封的 name / outputPath / outputs 一并反映最终名
        assert.equal(first.name, 'sample');
        assert.equal(second.name, 'sample (pptx)');
        assert.equal(first.outputPath, path.join(outputDir, 'sample'));
        assert.equal(second.outputPath, path.join(outputDir, 'sample (pptx)'));
        assert.equal(second.outputs.md, path.join(outputDir, 'sample (pptx)', 'sample (pptx).md'));
        assert.equal(second.outputs.json, path.join(outputDir, 'sample (pptx)', 'sample (pptx).json'));
        assert.deepEqual(fs.readdirSync(outputDir).sort(), ['sample', 'sample (pptx)']);
        assert.equal(fs.readFileSync(second.outputs.md, 'utf8').includes('正文'), true);
    });

    test('最终名由 order 决定：序号 1 先发起登记也抢不到原名', async () => {
        // Arrange
        const [docxPath, pptxPath] = seedInputs('order-in-', ['sample.docx', 'sample.pptx']);
        const outputDir = fs.mkdtempSync(path.join(root, 'order-out-'));
        const nameRegistry = createNameRegistry();

        // Act：序号 1 的任务先启动，其登记会等到序号 0 登记完毕
        const late = convert({ input: { path: pptxPath }, target: 'bundle', outputDir, nameRegistry, order: 1 });
        const early = convert({ input: { path: docxPath }, target: 'bundle', outputDir, nameRegistry, order: 0 });

        // Assert
        assert.equal((await early).name, 'sample');
        assert.equal((await late).name, 'sample (pptx)');
    });

    test('不传登记表时沿用派生名：重复转换同一输入仍覆盖同名产物（跨批次幂等）', async () => {
        // Arrange
        const [docxPath] = seedInputs('plain-in-', ['sample.docx']);
        const outputDir = fs.mkdtempSync(path.join(root, 'plain-out-'));

        // Act
        const first = await convert({ input: { path: docxPath }, target: 'bundle', outputDir });
        const second = await convert({ input: { path: docxPath }, target: 'bundle', outputDir });

        // Assert
        assert.equal(first.name, 'sample');
        assert.equal(second.name, 'sample');
        assert.equal(second.outputPath, first.outputPath);
        assert.deepEqual(fs.readdirSync(outputDir), ['sample']);
    });

    test('single 布局同槽仍改名：两份同名产物写成两个文件', async () => {
        // Arrange
        const [mdA] = seedInputs('single-a-', ['sample.md']);
        const [mdB] = seedInputs('single-b-', ['sample.md']);
        const outputDir = fs.mkdtempSync(path.join(root, 'single-out-'));
        const nameRegistry = createNameRegistry();

        // Act
        const first = await convert({ input: { path: mdA }, target: 'docx', outputDir, nameRegistry });
        const second = await convert({ input: { path: mdB }, target: 'docx', outputDir, nameRegistry });

        // Assert
        assert.equal(first.outputPath, path.join(outputDir, 'sample.docx'));
        assert.equal(second.name, 'sample (2)');
        assert.equal(second.outputPath, path.join(outputDir, 'sample (2).docx'));
        assert.deepEqual(fs.readdirSync(outputDir).sort(), ['sample (2).docx', 'sample.docx']);
    });

    test('混合目标不改名：single 的 {name}.docx 与 folder 的 {name}/ 分属不同槽位', async () => {
        // Arrange
        const [mdPath, docxPath] = seedInputs('mixed-in-', ['sample.md', 'sample.docx']);
        const outputDir = fs.mkdtempSync(path.join(root, 'mixed-out-'));
        const nameRegistry = createNameRegistry();

        // Act：md → docx 产出文件 sample.docx，docx → bundle 产出目录 sample/，落盘上本就不冲突
        const single = await convert({ input: { path: mdPath }, target: 'docx', outputDir, nameRegistry, order: 0 });
        const folder = await convert({ input: { path: docxPath }, target: 'bundle', outputDir, nameRegistry, order: 1 });

        // Assert
        assert.equal(single.name, 'sample');
        assert.equal(folder.name, 'sample');
        assert.equal(single.outputPath, path.join(outputDir, 'sample.docx'));
        assert.equal(folder.outputPath, path.join(outputDir, 'sample'));
        assert.deepEqual(fs.readdirSync(outputDir).sort(), ['sample', 'sample.docx']);
        assert.equal(fs.statSync(folder.outputPath).isDirectory(), true);
        assert.equal(fs.statSync(single.outputPath).isFile(), true);
    });
});

// ============================================================
// bundle：MinerU 式结果包（原图、content_list、附属文件改名与路径改写）
// ============================================================

describe('bundle：MinerU 式结果包（桩 parser）', () => {
    let stubs = {};

    function stubLoader(rel) {
        if (!Object.prototype.hasOwnProperty.call(stubs, rel)) return require(path.join(CONVERTERS_DIR, rel));
        return stubs[rel];
    }

    before(() => _setModuleLoader(stubLoader));
    beforeEach(() => { stubs = {}; });
    after(() => _reset());

    const DISPLAY = Object.freeze({ width: 320, height: 160, unit: 'px', source: 'docx' });
    const IMG_LINE = '<img src="images/image_1.png" width="320" alt="图">';
    const docxDoc = () => createDocument({
        ir: createRoot([
            createHeading(1, '结果包'),
            { type: 'paragraph', children: [{ type: 'image', url: 'images/image_1.png', alt: '图', data: { display: { ...DISPLAY } } }] },
            { type: 'paragraph', data: { role: 'caption' }, children: [{ type: 'text', value: '图 1 示意' }] },
        ]),
        meta: { sourceType: 'docx' },
        assets: [{ name: 'images/image_1.png', buffer: PNG, mime: 'image/png' }],
    });

    test('docx → bundle：<img width> 独占一行、{name}_content_list.json 带图注与 display、images/ 与原图逐字节一致', async () => {
        // Arrange
        const inputPath = path.join(root, '结果包.docx');
        fs.writeFileSync(inputPath, 'PK');
        stubs['./parsers/docx'] = { parse: async () => docxDoc() };
        const outDir = fs.mkdtempSync(path.join(root, 'bundle-'));

        // Act
        const res = await convert({ input: { path: inputPath }, target: 'bundle', outputDir: outDir });

        // Assert
        const dir = path.join(outDir, '结果包');
        assert.deepEqual(res.outputs, {
            md: path.join(dir, '结果包.md'),
            json: path.join(dir, '结果包.json'),
            contentList: path.join(dir, '结果包_content_list.json'),
            imagesDir: path.join(dir, 'images'),
        });
        const lines = fs.readFileSync(res.outputs.md, 'utf8').split('\n');
        assert.ok(lines.includes(IMG_LINE), lines.join('\n'));
        assert.equal(lines[lines.indexOf(IMG_LINE) + 2], '图 1 示意');
        const blocks = JSON.parse(fs.readFileSync(res.outputs.contentList, 'utf8'));
        assert.deepEqual(blocks[1], {
            type: 'image', img_path: 'images/image_1.png', image_caption: ['图 1 示意'], image_footnote: [], content: '', display: { ...DISPLAY }, page_idx: 0,
        });
        assert.ok(fs.readFileSync(path.join(dir, 'images', 'image_1.png')).equals(PNG));
    });

    test('先解析后导出（桌面端路径）：无目标解析时图片已归一为 JPG，渲染 bundle 时换回原图与原资源名', async () => {
        // Arrange
        const inputPath = path.join(root, '先解析.docx');
        fs.writeFileSync(inputPath, 'PK');
        stubs['./parsers/docx'] = { parse: async () => docxDoc() };

        // Act
        const parsed = await parseDocument({ input: { path: inputPath } });
        const rendered = await renderDocument(parsed.doc, 'bundle', parsed.options, { imageMode: 'relative' });

        // Assert
        assert.equal(parsed.doc.assets[0].name, 'images/image_1.jpg', '无目标解析照常归一');
        assert.deepEqual(rendered.assets.map((a) => a.name), ['images/image_1.png']);
        assert.ok(rendered.assets[0].buffer.equals(PNG));
        assert.ok(rendered.files['{name}.md'].includes(IMG_LINE));
        assert.equal(JSON.parse(rendered.files['{name}_content_list.json'])[1].img_path, 'images/image_1.png');
    });

    test('renderBundleSidecars：返回 json 与 contentList 字符串，与 bundle 渲染产出逐字一致', async () => {
        // Act
        const doc = docxDoc();
        const sidecars = await renderBundleSidecars(doc, { name: '结果包', options: {} });
        const rendered = await renderDocument(doc, 'bundle');

        // Assert
        assert.deepEqual(Object.keys(sidecars).sort(), ['contentList', 'json']);
        assert.equal(sidecars.json, rendered.files['{name}.json']);
        assert.equal(sidecars.contentList, rendered.files['{name}_content_list.json']);
        await assert.rejects(renderBundleSidecars(null), /renderBundleSidecars 需要有效的 IR 文档/);
    });

    test('MinerU 来源：原件 content_list 取代生成版本，附属 JSON 的哈希图名改写为产物路径（layout 用裸名），outputs 带附属键', async () => {
        // Arrange
        const inputPath = path.join(root, '扫描件二.pdf');
        fs.writeFileSync(inputPath, '%PDF');
        const sha = '0123456789abcdef'.repeat(4);
        const display = { width: 397, unit: 'px', source: 'mineru' };
        const list = [{ type: 'image', img_path: `images/${sha}.jpg`, image_caption: [], image_footnote: [], bbox: [0, 0, 500, 500], page_idx: 0, display }];
        stubs['./parsers/pdf'] = {
            parse: async () => createDocument({
                ir: createRoot([{ type: 'paragraph', children: [{ type: 'image', url: 'images/image_1.png', alt: '', data: { sourcePath: `images/${sha}.jpg`, display } }] }]),
                meta: { sourceType: 'pdf', pdfParser: 'mineru' },
                assets: [{ name: 'images/image_1.png', buffer: PNG, mime: 'image/png', sourcePath: `images/${sha}.jpg` }],
                extras: [
                    { name: '{name}_content_list.json', buffer: Buffer.from(JSON.stringify(list, null, 4)) },
                    { name: '{name}_layout.json', buffer: Buffer.from(JSON.stringify({ pdf_info: [{ image_path: `${sha}.jpg`, page_size: [595, 842] }] })) },
                    { name: '{name}_origin.pdf', buffer: Buffer.from('%PDF-origin') },
                ],
            }),
        };
        const outDir = fs.mkdtempSync(path.join(root, 'mineru-bundle-'));

        // Act
        const res = await convert({ input: { path: inputPath }, target: 'bundle', outputDir: outDir });

        // Assert
        const dir = path.join(outDir, '扫描件二');
        assert.deepEqual(res.outputs, {
            md: path.join(dir, '扫描件二.md'),
            json: path.join(dir, '扫描件二.json'),
            contentList: path.join(dir, '扫描件二_content_list.json'),
            imagesDir: path.join(dir, 'images'),
            layout: path.join(dir, '扫描件二_layout.json'),
            originPdf: path.join(dir, '扫描件二_origin.pdf'),
        });
        assert.deepEqual([...res.extras].sort(), ['扫描件二_layout.json', '扫描件二_origin.pdf']);
        const contentList = JSON.parse(fs.readFileSync(res.outputs.contentList, 'utf8'));
        assert.equal(contentList[0].img_path, 'images/image_1.png');
        assert.deepEqual(contentList[0].bbox, [0, 0, 500, 500], '原件字段保留');
        assert.equal(JSON.parse(fs.readFileSync(res.outputs.layout, 'utf8')).pdf_info[0].image_path, 'image_1.png');
        for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
            assert.ok(!/[0-9a-f]{64}/.test(fs.readFileSync(path.join(dir, file), 'utf8')), `${file} 不应残留哈希图名`);
        }
    });
});

// ============================================================
// 重跑策略：skipExisting / clean（转换调用参数，不进 options）
// ============================================================

describe('convert：重跑策略 skipExisting / clean（桩 parser 与 renderer）', () => {
    const { createNameRegistry: newRegistry } = require('../converters/naming');
    let stubs = {};
    let parseCalls = 0;

    function stubLoader(rel) {
        if (!Object.prototype.hasOwnProperty.call(stubs, rel)) return require(path.join(CONVERTERS_DIR, rel));
        return stubs[rel];
    }

    before(() => _setModuleLoader(stubLoader));
    after(() => _reset());
    beforeEach(() => {
        parseCalls = 0;
        const parse = (sourceType, meta = {}) => async (input, ctx) => {
            parseCalls += 1;
            return createDocument({
                ir: createRoot([createParagraph('正文')]),
                meta: { sourceType, sourceName: ctx.sourceName, ...meta },
                assets: [{ name: 'images/image_1.png', buffer: PNG, mime: 'image/png' }],
            });
        };
        stubs = {
            './parsers/docx': { parse: parse('docx') },
            './parsers/md': { parse: parse('md') },
            './parsers/url': { parse: parse('url', { title: '网页标题' }) },
            './renderers/md': { render: async () => '# 正文\n' },
            './renderers/json': { render: async () => '{}' },
            './renderers/docx': { render: async () => Buffer.from('PK new') },
            './renderers/xml': { render: async () => ({ files: { '{name}.xml': '<doc/>' } }) },
        };
    });

    const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const listTree = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
        .sort(byCodePoint);
    // 目录快照：相对路径 → 内容与修改时间，用于断言「不改动任何文件」
    const snapshotTree = (dir) => Object.fromEntries(listTree(dir).map((rel) => {
        const file = path.join(dir, rel);
        return [rel, `${fs.readFileSync(file).toString('base64')}@${fs.statSync(file).mtimeMs}`];
    }));
    const seedInput = (name) => {
        const file = path.join(fs.mkdtempSync(path.join(root, 'rerun-in-')), name);
        fs.writeFileSync(file, 'PK');
        return file;
    };
    const newOutDir = () => fs.mkdtempSync(path.join(root, 'rerun-out-'));

    test('skipExisting：本地输入的主产物已存在时不解析、不改动任何文件，结果标 skipped: true', async () => {
        // Arrange
        const input = seedInput('报告.docx');
        const outputDir = newOutDir();
        const first = await convert({ input: { path: input }, target: 'bundle', outputDir });
        assert.equal('skipped' in first, false, '缺省结果信封形状不变');
        const before = snapshotTree(outputDir);
        parseCalls = 0;

        // Act
        const res = await convert({ input: { path: input }, target: 'bundle', outputDir, skipExisting: true });

        // Assert
        assert.equal(parseCalls, 0);
        const dir = path.join(outputDir, '报告');
        assert.deepEqual(res, {
            ok: true, skipped: true, target: 'bundle', name: '报告', title: null, sourceType: 'docx',
            outputPath: dir, outputs: { md: path.join(dir, '报告.md') },
            imagesCount: 0, warnings: [], options: res.options, extras: [], backends: { pdfParser: null, raster: null },
        });
        assert.equal(res.options.mineru.token, null);
        assert.deepEqual(snapshotTree(outputDir), before);
    });

    test('skipExisting：主产物缺失时照常转换（产物目录已存在也一样）', async () => {
        const input = seedInput('半成品.docx');
        const outputDir = newOutDir();
        fs.mkdirSync(path.join(outputDir, '半成品', 'images'), { recursive: true });

        const res = await convert({ input: { path: input }, target: 'bundle', outputDir, skipExisting: true });

        assert.equal(parseCalls, 1);
        assert.equal('skipped' in res, false);
        assert.ok(fs.existsSync(path.join(outputDir, '半成品', '半成品.md')));
    });

    test('skipExisting：单文件目标按 {name}.{ext} 判定；网页输入解析后按标题判定', async () => {
        // Arrange
        const outputDir = newOutDir();
        const mdInput = seedInput('说明.md');
        fs.writeFileSync(path.join(outputDir, '说明.docx'), 'OLD');
        fs.mkdirSync(path.join(outputDir, '网页标题'));
        fs.writeFileSync(path.join(outputDir, '网页标题', '网页标题.md'), 'OLD');

        // Act
        const single = await convert({ input: { path: mdInput }, target: 'docx', outputDir, skipExisting: true });
        const callsAfterSingle = parseCalls;
        const web = await convert({ input: { url: 'https://example.com/post' }, target: 'bundle', outputDir, skipExisting: true });

        // Assert
        assert.equal(callsAfterSingle, 0);
        assert.equal(single.skipped, true);
        assert.equal(single.outputPath, path.join(outputDir, '说明.docx'));
        assert.deepEqual(single.outputs, { docx: path.join(outputDir, '说明.docx') });
        assert.equal(fs.readFileSync(path.join(outputDir, '说明.docx'), 'utf8'), 'OLD');

        assert.equal(parseCalls, 1, '网页产物名取决于标题，须先解析');
        assert.equal(web.skipped, true);
        assert.equal(web.title, '网页标题');
        assert.equal(web.sourceType, 'url');
        assert.deepEqual(fs.readdirSync(path.join(outputDir, '网页标题')), ['网页标题.md']);
        assert.equal(fs.readFileSync(path.join(outputDir, '网页标题', '网页标题.md'), 'utf8'), 'OLD');
    });

    test('skipExisting：xml 目标的主产物随 profile 而定（generic 为 {name}.xml，patent 为 {name}.zip）', async () => {
        const outputDir = newOutDir();
        fs.mkdirSync(path.join(outputDir, 'sample'));
        fs.writeFileSync(path.join(outputDir, 'sample', 'sample.zip'), 'OLD');

        const patent = await convert({ input: { path: SAMPLE_MD }, target: 'xml', outputDir, options: { xml: { profile: 'patent' } }, skipExisting: true });
        const generic = await convert({ input: { path: SAMPLE_MD }, target: 'xml', outputDir, skipExisting: true });

        assert.equal(patent.skipped, true);
        assert.deepEqual(patent.outputs, { zip: path.join(outputDir, 'sample', 'sample.zip') });
        assert.equal('skipped' in generic, false);
        assert.ok(fs.existsSync(path.join(outputDir, 'sample', 'sample.xml')));
    });

    test('skipExisting 与批内登记表：跳过的任务仍占名，后续同名任务的最终名与首轮一致', async () => {
        // Arrange
        const inputs = [seedInput('同名.docx'), seedInput('同名.docx')];
        const outputDir = newOutDir();
        const runAll = async (extra) => {
            const nameRegistry = newRegistry();
            const out = [];
            for (const [order, input] of inputs.entries()) {
                out.push(await convert({ input: { path: input }, target: 'bundle', outputDir, nameRegistry, order, ...extra }));
            }
            return out;
        };
        const first = await runAll({});
        assert.deepEqual(first.map((res) => res.name), ['同名', '同名 (2)']);
        fs.rmSync(path.join(outputDir, '同名 (2)'), { recursive: true });
        parseCalls = 0;

        // Act
        const rerun = await runAll({ skipExisting: true });

        // Assert
        assert.deepEqual(rerun.map((res) => [res.name, res.skipped === true]), [['同名', true], ['同名 (2)', false]]);
        assert.equal(parseCalls, 1);
    });

    test('clean：写入前删除该产物目录中旧的 MarkFlow 产物，保留用户文件；缺省不删除', async () => {
        // Arrange
        const input = seedInput('笔记.docx');
        const outputDir = newOutDir();
        const dir = path.join(outputDir, '笔记');
        fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'images', 'image_99.jpg'), 'old');
        fs.writeFileSync(path.join(dir, '旧笔记.txt'), 'mine');
        fs.writeFileSync(path.join(dir, '笔记_origin.pdf'), 'old');

        // Act & Assert：缺省重跑不清理（回归守卫）
        await convert({ input: { path: input }, target: 'bundle', outputDir });
        assert.ok(fs.existsSync(path.join(dir, 'images', 'image_99.jpg')));
        assert.ok(fs.existsSync(path.join(dir, '笔记_origin.pdf')));

        // Act & Assert：clean 只清 MarkFlow 产物
        await convert({ input: { path: input }, target: 'bundle', outputDir, clean: true });
        assert.deepEqual(listTree(dir), ['images/image_1.png', '旧笔记.txt', '笔记.json', '笔记.md', '笔记_content_list.json'].sort(byCodePoint));
        assert.equal(fs.readFileSync(path.join(dir, '旧笔记.txt'), 'utf8'), 'mine');
    });

    test('clean 与 skipExisting 同时为真：已存在即跳过且不清理；主产物缺失时先清理再转换', async () => {
        // Arrange
        const input = seedInput('合并.docx');
        const outputDir = newOutDir();
        const dir = path.join(outputDir, '合并');
        await convert({ input: { path: input }, target: 'bundle', outputDir });
        fs.writeFileSync(path.join(dir, 'images', 'image_99.jpg'), 'old');

        // Act & Assert：主产物存在 → 跳过，不清理
        const skipped = await convert({ input: { path: input }, target: 'bundle', outputDir, clean: true, skipExisting: true });
        assert.equal(skipped.skipped, true);
        assert.ok(fs.existsSync(path.join(dir, 'images', 'image_99.jpg')));

        // Act & Assert：主产物缺失 → 清理后转换
        fs.rmSync(path.join(dir, '合并.md'));
        const redone = await convert({ input: { path: input }, target: 'bundle', outputDir, clean: true, skipExisting: true });
        assert.equal('skipped' in redone, false);
        assert.equal(fs.existsSync(path.join(dir, 'images', 'image_99.jpg')), false);
        assert.ok(fs.existsSync(path.join(dir, '合并.md')));
    });

    test('clean / skipExisting 须为布尔值，且不进入结果信封的 options', async () => {
        const input = seedInput('严格.docx');
        const outputDir = newOutDir();

        await assert.rejects(convert({ input: { path: input }, target: 'bundle', outputDir, skipExisting: 'true' }), /skipExisting 须为布尔值/);
        await assert.rejects(convert({ input: { path: input }, target: 'bundle', outputDir, clean: 1 }), /clean 须为布尔值/);
        assert.equal(parseCalls, 0);

        const res = await convert({ input: { path: input }, target: 'bundle', outputDir, clean: false, skipExisting: false });
        assert.equal('clean' in res.options, false);
        assert.equal('skipExisting' in res.options, false);
        assert.equal('skipped' in res, false);
    });
});
