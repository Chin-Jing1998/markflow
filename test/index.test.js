/**
 * converters/index.js 调度器单元测试
 * 覆盖：导出与懒加载、detectInputType、listTargets、convert 参数校验、
 *       md → docx 真实端到端、bundle/pdf 经桩 parser/renderer 的编排逻辑
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

const { convert, listTargets, detectInputType, SUPPORTED_EXTENSIONS, runBatch, _setModuleLoader, _reset } = converters;

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
    test('导出 convert / listTargets / detectInputType / SUPPORTED_EXTENSIONS / runBatch', () => {
        assert.equal(typeof convert, 'function');
        assert.equal(typeof listTargets, 'function');
        assert.equal(typeof detectInputType, 'function');
        assert.equal(typeof runBatch, 'function');
        assert.equal(runBatch, require('../converters/batch').runBatch);
        assert.ok(Array.isArray(SUPPORTED_EXTENSIONS));
        assert.ok(Object.isFrozen(SUPPORTED_EXTENSIONS));
        for (const ext of ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf', '.md', '.markdown']) {
            assert.ok(SUPPORTED_EXTENSIONS.includes(ext), ext);
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
            'x.DOC': 'doc',
            'x.xlsx': 'xlsx',
            'x.xls': 'xls',
            'x.pptx': 'pptx',
            'x.ppt': 'ppt',
            'x.PDF': 'pdf',
            'x.md': 'md',
            'x.markdown': 'md',
            '/路径/中文 文件.Md': 'md',
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
        for (const value of ['x.txt', 'x.html', 'x.json', 'noext', '', '   ', null, undefined, 42]) {
            assert.equal(detectInputType(value), null, String(value));
        }
    });
});

// ============================================================
// listTargets
// ============================================================

describe('listTargets', () => {
    test('默认：无 soffice、无 PDF 后端', () => {
        assert.deepEqual(listTargets(), {
            office: ['bundle'],
            markup: ['docx'],
            url: ['bundle'],
            inputs: { docx: 'office', xlsx: 'office', pptx: 'office', pdf: 'office', md: 'markup', url: 'url' },
            capabilities: { sofficeAvailable: false, pdfBackend: null },
        });
    });

    test('inputs 不含 markdown 键（.markdown 已由 detectInputType 归入 md）', () => {
        assert.equal('markdown' in listTargets().inputs, false);
        assert.equal('markdown' in listTargets({ sofficeAvailable: true }).inputs, false);
    });

    test('sofficeAvailable=true 时纳入 doc/xls/ppt，顺序固定', () => {
        const targets = listTargets({ sofficeAvailable: true });
        assert.deepEqual(Object.keys(targets.inputs), ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'pdf', 'md', 'url']);
        assert.deepEqual(targets.markup, ['docx']);
        assert.equal(targets.capabilities.sofficeAvailable, true);
    });

    test('pdfBackend 存在时 markup 含 pdf', () => {
        const targets = listTargets({ pdfBackend: 'electron' });
        assert.deepEqual(targets.markup, ['docx', 'pdf']);
        assert.equal(targets.capabilities.pdfBackend, 'electron');
        assert.equal('doc' in targets.inputs, false);
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
        await assert.rejects(convert({ input: { path: SAMPLE_MD }, target: 'html', outputDir: root }), /不支持的目标格式/);
        await assert.rejects(convert({ input: { path: SAMPLE_MD }, outputDir: root }), /不支持的目标格式/);
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
        assert.match(md, /!\[图\]\(images\/image_1\.png\)/);
        const json = JSON.parse(fs.readFileSync(res.outputs.json, 'utf8'));
        assert.deepEqual(Object.keys(json), ['schemaVersion', 'kind', 'ir', 'data', 'meta']);
        assert.equal(json.meta.title, '来自 H1 的标题');
        assert.ok(fs.readFileSync(path.join(res.outputs.imagesDir, 'image_1.png')).equals(PNG));
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

    test('fetch-guard 自身缺失时 fetchRemote 为 undefined；其依赖缺失时错误照常抛出', async () => {
        // Arrange
        let ctxSeen = null;
        stubs['./parsers/md'] = { parse: async (input, ctx) => { ctxSeen = ctx; return emptyMdDoc(); } };
        stubs['./renderers/docx'] = { render: async () => Buffer.from('PK') };
        stubs['./net/fetch-guard'] = null;

        // Act
        const res = await convert({ input: { path: SAMPLE_MD }, target: 'docx', outputDir: root });

        // Assert
        assert.equal(res.ok, true);
        assert.equal('fetchRemote' in ctxSeen, true);
        assert.equal(ctxSeen.fetchRemote, undefined);

        // Arrange：fetch-guard 自身存在但其依赖缺失
        stubs['./net/fetch-guard'] = () => {
            const err = new Error("Cannot find module 'undici'");
            err.code = 'MODULE_NOT_FOUND';
            throw err;
        };

        // Act & Assert
        await assert.rejects(convert({ input: { path: SAMPLE_MD }, target: 'docx', outputDir: root }), /undici/);
    });

    test('渲染器未返回 Buffer、解析器返回无效文档、模块缺少导出时均抛中文错误', async () => {
        const params = { input: { path: SAMPLE_MD }, target: 'docx', outputDir: root };

        stubs['./parsers/md'] = { parse: async () => emptyMdDoc() };
        stubs['./renderers/docx'] = { render: async () => 'not a buffer' };
        await assert.rejects(convert(params), /未返回 Buffer/);

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
