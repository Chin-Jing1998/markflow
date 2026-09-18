/**
 * mcp/server.js 集成测试
 *
 * 以官方 SDK 的 stdio 客户端连接真实服务进程，覆盖：
 *   工具清单与入参 schema（含转换选项、2020-12 方言、无 $ref、描述与取值范围、中文校验文案）、
 *   工具 annotations 与服务 instructions、list_formats 能力矩阵（含 DTD 校验器、LibreOffice 与受理扩展名）、
 *   convert_document 的成功/选项透传/入参错误/运行期失败、validate 标记、ignoredArguments、
 *   patent profile 的 outputs 契约（键名不变、值为官方案卷结构 100001/100001.xml 一类的新路径）、
 *   缺失输入不预检、returnContent（contentTruncated、非 bundle 告警、紧凑 JSON）、进度通知、
 *   extract_article 的只读提取（结构、截断语义、零落盘）、
 *   专利五书 XML 反向导入（案卷 zip / 五书目录 / 单个 XML 三种输入、xmlImport 段、list_formats 列出新输入类型）。
 * 客户端在 listTools() 后会用 outputSchema 校验 structuredContent，因此这些用例同时验证了
 * 服务端返回结构与声明的 schema 一致。临时产物一律写入 os.tmpdir()。
 *
 * extract_article 的成功路径另起一个服务进程：SSRF 守卫不放行 127.0.0.1，而 allowPrivateNetwork
 * 不该暴露成工具入参，故用 --require 预加载脚本在那个进程内为守卫补上该选项（见 fixtures）。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const { OPTION_ENUMS } = require('../converters/options');
// 正文页固件只用于长正文用例；本文件下方另有自带的 /article 页与段落常量
const { startArticleServer, buildArticlePage } = require('./fixtures/article-server');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'mcp', 'server.js');
const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'allow-private-network.js');
const SAMPLE_MD = path.join(ROOT, 'test', 'fixtures', 'sample.md');
const SAMPLE_PDF = path.join(ROOT, 'test', 'fixtures', 'sample.pdf');
const SAMPLE_PATENT = path.join(ROOT, 'test', 'fixtures', 'patent', 'sample-patent.docx');
const PKG_VERSION = require('../package.json').version;

let client;
let clientTransport;
let tmpDir;

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-mcp-'));
    client = new Client({ name: 'markflow-test', version: '1.0.0' });
    // 传输层对象留作引用：进度用例要在 SDK 派发之前抓取原始帧，理由见该用例注释
    clientTransport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: ROOT });
    await client.connect(clientTransport);
});

after(async () => {
    if (client) await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

const makeOutDir = (prefix) => fs.mkdtempSync(path.join(tmpDir, prefix));

// ============================================================
// 工具清单
// ============================================================

test('listTools 恰好暴露 convert_document、extract_article 与 list_formats', async () => {
    // Act
    const { tools } = await client.listTools();

    // Assert
    assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ['convert_document', 'extract_article', 'list_formats'],
    );
    tools.forEach((tool) => {
        assert.equal(typeof tool.description, 'string');
        assert.ok(tool.outputSchema, `${tool.name} 应声明 outputSchema`);
    });
});

// Claude Desktop 内置客户端的校验器只接受 2020-12 标识，见到 draft-07 会抛 “unsupported dialect”
// 并在校验层拦下调用；SDK 默认输出 draft-07，故服务端在出站帧上改写。此用例守住该改写不被回退。
test('工具 schema 声明 2020-12 方言，且不含仅 draft-07 成立的构造', async () => {
    // Arrange
    const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
    // 两版语义不一致的关键字：元组式 items 在 2020-12 中改为 prefixItems，其余为 draft-07 专属
    const walk = (node, at) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach((child, i) => walk(child, `${at}[${i}]`));
        ['definitions', '$ref', 'dependencies'].forEach((key) => {
            assert.ok(!(key in node), `${at} 含 draft-07 专属关键字 ${key}`);
        });
        assert.ok(!Array.isArray(node.items), `${at} 使用了元组式 items`);
        Object.entries(node).forEach(([key, value]) => walk(value, `${at}.${key}`));
    };

    // Act
    const { tools } = await client.listTools();

    // Assert
    tools.forEach((tool) => {
        assert.equal(tool.outputSchema.$schema, DIALECT, `${tool.name} 的 outputSchema 方言不符`);
        if (tool.inputSchema && tool.inputSchema.$schema !== undefined) {
            assert.equal(tool.inputSchema.$schema, DIALECT, `${tool.name} 的 inputSchema 方言不符`);
        }
        walk(tool.inputSchema, `${tool.name}.inputSchema`);
        walk(tool.outputSchema, `${tool.name}.outputSchema`);
    });
});

test('convert_document 的 inputSchema 暴露全部转换选项，只有 outputDir 必填', async () => {
    // Act
    const { tools } = await client.listTools();
    const tool = tools.find((item) => item.name === 'convert_document');
    const { properties } = tool.inputSchema;

    // Assert：入参键清单
    assert.deepEqual(Object.keys(properties).sort(), [
        'clean', 'docx', 'html', 'imageFormat', 'jpegPpi', 'jpegQuality', 'math', 'mineru', 'outputDir', 'paths',
        'patentParts', 'pdf', 'pdfBackend', 'raster', 'returnContent', 'skipExisting', 'target', 'theme', 'urls',
        'validate', 'xml', 'xmlImport', 'xmlProfile',
    ].sort());
    assert.equal(properties.validate.type, 'boolean');
    assert.deepEqual(tool.inputSchema.required, ['outputDir']);

    // Assert：枚举取自 converters/options.js，嵌套段为独立对象（不产生 $ref）
    assert.deepEqual(properties.target.enum, ['bundle', 'docx', 'pdf', 'html', 'xml']);
    assert.deepEqual(properties.theme.enum, [...OPTION_ENUMS.htmlThemes]);
    assert.deepEqual(properties.xmlProfile.enum, [...OPTION_ENUMS.xmlProfiles]);
    assert.deepEqual(properties.patentParts.items.enum, [...OPTION_ENUMS.patentParts]);
    assert.deepEqual(properties.pdfBackend.enum, [...OPTION_ENUMS.pdfBackends]);
    assert.deepEqual(properties.imageFormat.enum, [...OPTION_ENUMS.imageFormats]);
    assert.deepEqual(properties.math.enum, [...OPTION_ENUMS.mathModes]);
    assert.deepEqual(Object.keys(properties.mineru.properties),
        ['model', 'ocr', 'formula', 'table', 'language', 'pageRanges', 'timeoutSec']);
    assert.deepEqual(Object.keys(properties.html.properties),
        ['fontFamily', 'fontSize', 'lineHeight', 'contentWidth', 'spacing', 'inlineImages']);
    assert.deepEqual(Object.keys(properties.pdf.properties), ['pageSize', 'landscape']);
    assert.deepEqual(Object.keys(properties.docx.properties), ['pageSize', 'fontSize', 'fontAscii', 'fontEastAsia']);
    assert.deepEqual(Object.keys(properties.xml.properties), [
        'indent', 'numberingStart', 'numberingWidth', 'imageDpi', 'sectionDetection', 'rasterizeTables', 'rasterizeFormulas',
    ]);
    assert.deepEqual(Object.keys(properties.raster.properties), ['scale', 'maxWidth']);
    assert.deepEqual(properties.pdf.properties.pageSize.enum, [...OPTION_ENUMS.pageSizes]);
    assert.deepEqual(properties.xml.properties.sectionDetection.enum, [...OPTION_ENUMS.sectionDetection]);
    assert.deepEqual(properties.mineru.required, undefined, '嵌套段各字段均为可选');
    assert.equal(JSON.stringify(tool.inputSchema).includes('$ref'), false, 'inputSchema 不得出现 $ref');
    assert.equal(properties.mineru.properties.token, undefined, '令牌不经 MCP 传入');
});

// ============================================================
// list_formats
// ============================================================

test('list_formats 返回能力矩阵，office 目标含 bundle', async () => {
    // Act
    const result = await client.callTool({ name: 'list_formats' });

    // Assert
    assert.notEqual(result.isError, true);
    const { targets, capabilities, version } = result.structuredContent;
    assert.deepEqual(targets.office, ['bundle', 'html', 'xml']);
    assert.deepEqual(targets.url, ['bundle', 'html', 'xml']);
    assert.ok(targets.markup.includes('docx'));
    assert.ok(targets.markup.includes('html'));
    assert.deepEqual(Object.keys(capabilities).sort(),
        ['libreoffice', 'mineru', 'pdfBackend', 'raster', 'themes', 'validator', 'xmlProfiles']);
    for (const key of ['validator', 'libreoffice']) {
        assert.deepEqual(Object.keys(capabilities[key]).sort(), ['available', 'hint', 'name'], `${key} 的键`);
        assert.equal(capabilities[key].available, capabilities[key].name !== null);
    }
    assert.deepEqual(result.structuredContent.extensions, ['.docx', '.xlsx', '.pptx', '.pdf', '.md', '.markdown', '.xml', '.zip']);
    assert.deepEqual(Object.keys(targets.inputs), ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'xml', 'zip', 'url'], '专利五书 XML 与案卷 zip 列入输入类型');
    assert.deepEqual([targets.inputs.xml, targets.inputs.zip], ['markup', 'markup']);
    assert.equal('sofficeAvailable' in capabilities, false);
    assert.equal(typeof capabilities.pdfBackend.available, 'boolean');
    assert.equal(typeof capabilities.pdfBackend.hint, 'string');
    assert.equal(typeof capabilities.raster.available, 'boolean');
    assert.equal(typeof capabilities.raster.hint, 'string');
    assert.ok(capabilities.raster.name === null || typeof capabilities.raster.name === 'string');
    assert.equal(typeof capabilities.mineru.configured, 'boolean');
    assert.deepEqual(capabilities.themes, ['apple', 'apple-dark', 'github', 'academic', 'reader', 'print']);
    assert.deepEqual(capabilities.xmlProfiles, ['generic', 'patent']);
    assert.deepEqual(Object.keys(capabilities.mineru), ['configured', 'source'], 'mineru 只报是否配置与来源');
    for (const name of ['MINERU_TOKEN', 'MINERU_API_TOKEN']) {
        if (process.env[name]) assert.equal(JSON.stringify(result).includes(process.env[name]), false, `${name} 的取值不得出现在输出中`);
    }
    assert.equal(version, PKG_VERSION);
    // text 内容与 structuredContent 同源
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

// ============================================================
// convert_document：成功路径
// ============================================================

test('convert_document 把 Markdown 转为 docx，产物落盘', async () => {
    // Arrange
    const outputDir = makeOutDir('docx-');

    // Act
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { paths: [SAMPLE_MD], target: 'docx', outputDir },
    });

    // Assert
    assert.notEqual(result.isError, true);
    const payload = result.structuredContent;
    assert.equal(payload.ok, true);
    assert.equal(payload.outputDir, outputDir);
    assert.deepEqual(payload.errors, []);
    assert.equal(payload.results.length, 1);
    const [item] = payload.results;
    assert.equal(item.input, SAMPLE_MD);
    assert.equal(item.target, 'docx');
    assert.ok(fs.existsSync(item.outputPath));
    assert.equal(item.content, undefined);
    assert.equal(item.sourceType, 'md');
    assert.equal(item.options.imageFormat, 'jpg');
    assert.equal(item.options.mineru.token, null);
    assert.deepEqual(item.extras, []);
    assert.deepEqual(item.backends, { pdfParser: null, raster: null });
});

test('convert_document 以 target=html 转换 Markdown，产出目录含 html 与 images/', async () => {
    // Arrange
    const outputDir = makeOutDir('html-');

    // Act
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { paths: [SAMPLE_MD], target: 'html', outputDir },
    });

    // Assert
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const [item] = result.structuredContent.results;
    assert.equal(item.target, 'html');
    assert.equal(item.outputs.html, path.join(outputDir, 'sample', 'sample.html'));
    assert.ok(fs.existsSync(item.outputs.html));
    assert.ok(fs.existsSync(item.outputs.imagesDir));
});

test('convert_document 的 patent profile：outputs 键名不变，值为官方案卷结构下的新路径，图片与所属 XML 同目录', async () => {
    // Arrange：关闭栅格化以免依赖 Electron
    const outputDir = makeOutDir('patent-');

    // Act
    const result = await client.callTool({
        name: 'convert_document',
        arguments: {
            paths: [SAMPLE_PATENT], target: 'xml', outputDir, xmlProfile: 'patent', math: 'text', validate: true,
            xml: { rasterizeTables: false, rasterizeFormulas: false },
        },
    });

    // Assert
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const [item] = result.structuredContent.results;
    const dir = path.join(outputDir, 'sample-patent');
    assert.deepEqual(item.outputs, {
        claims: path.join(dir, '100001', '100001.xml'),
        description: path.join(dir, '100002', '100002.xml'),
        drawings: path.join(dir, '100003', '100003.xml'),
        abstract: path.join(dir, '100004', '100004.xml'),
        abstractFigure: path.join(dir, '100005', '100005.xml'),
        zip: path.join(dir, 'sample-patent.zip'),
        precheck: path.join(dir, 'precheck.json'),
    });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['100001', '100002', '100003', '100004', '100005', 'precheck.json', 'sample-patent.zip'].sort());
    assert.ok(fs.existsSync(path.join(dir, '100003', '100003_1.jpg')), '附图应与 100003.xml 同目录');
    assert.deepEqual(item.warnings.filter((text) => text.startsWith('DTD 校验：')), []);
});

test('convert_document 透传转换选项：扁平键与嵌套段都进入结果 options', async () => {
    // Arrange
    const outputDir = makeOutDir('options-');

    // Act
    const result = await client.callTool({
        name: 'convert_document',
        arguments: {
            paths: [SAMPLE_MD], target: 'html', outputDir,
            theme: 'github', imageFormat: 'keep', jpegQuality: 80, jpegPpi: 420, math: 'text', pdfBackend: 'local',
            xmlProfile: 'patent', patentParts: ['claims', 'description'],
            mineru: { model: 'vlm', ocr: true, language: 'en', pageRanges: '1-3' },
            html: { fontSize: 20, spacing: 'loose', inlineImages: false },
            docx: { pageSize: 'Letter', fontAscii: 'Georgia', fontEastAsia: '宋体' },
            xml: { indent: 4, numberingStart: 5, numberingWidth: 3 },
        },
    });

    // Assert
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const { options } = result.structuredContent.results[0];
    assert.equal(options.html.theme, 'github');
    assert.equal(options.pdf.theme, 'github');
    assert.equal(options.html.fontSize, 20);
    assert.equal(options.html.spacing, 'loose');
    assert.equal(options.imageFormat, 'keep');
    assert.equal(options.jpegQuality, 80);
    assert.equal(options.jpegPpi, 420);
    assert.equal(options.math, 'text');
    assert.equal(options.pdfBackend, 'local');
    assert.equal(options.xml.profile, 'patent');
    assert.deepEqual(options.xml.patent.parts, ['claims', 'description']);
    assert.deepEqual(options.xml.numbering, { start: 5, width: 3 });
    assert.equal(options.xml.indent, 4);
    assert.equal(options.docx.pageSize, 'Letter');
    // docx 段的 fontAscii / fontEastAsia 由 service.buildOptions 展开为 fontFamily
    assert.deepEqual(options.docx.fontFamily, { ascii: 'Georgia', eastAsia: '宋体' });
    assert.equal(options.mineru.model, 'vlm');
    assert.equal(options.mineru.ocr, true);
    assert.equal(options.mineru.language, 'en');
    assert.equal(options.mineru.pageRanges, '1-3');
    assert.equal(options.mineru.token, null, '令牌不得出现在结果中');
});

test('省略转换选项时结果 options 取默认值', async () => {
    // Arrange
    const outputDir = makeOutDir('defaults-');

    // Act
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { paths: [SAMPLE_MD], target: 'html', outputDir },
    });

    // Assert
    const { options } = result.structuredContent.results[0];
    assert.equal(options.html.theme, 'apple');
    assert.equal(options.imageFormat, 'jpg');
    assert.equal(options.jpegQuality, 90);
    assert.equal(options.jpegPpi, 330);
    assert.equal(options.xml.profile, 'generic');
});

test('省略 target 时按输入类型取默认值：PDF 转 bundle', async () => {
    // Arrange
    const outputDir = makeOutDir('bundle-');

    // Act：固定走本地后端，避免用例依赖 MinerU 令牌与外网
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { paths: [SAMPLE_PDF], outputDir, pdfBackend: 'local' },
    });

    // Assert
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const [item] = result.structuredContent.results;
    assert.equal(item.target, 'bundle');
    assert.equal(item.backends.pdfParser, 'pdfjs');
    assert.ok(fs.existsSync(item.outputs.md));
    assert.ok(fs.existsSync(item.outputs.json));
});

test('returnContent 为 true 时附带生成的 Markdown 正文', async () => {
    // Arrange
    const outputDir = makeOutDir('content-');

    // Act
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { paths: [SAMPLE_PDF], returnContent: true, outputDir, pdfBackend: 'local' },
    });

    // Assert
    const [item] = result.structuredContent.results;
    assert.equal(typeof item.content, 'string');
    assert.ok(item.content.length > 0);
    assert.equal(item.content, fs.readFileSync(item.outputs.md, 'utf8'));
    assert.equal(item.contentTruncated, false);
    // text 仍含正文以兼容只读 text 的客户端，但改为紧凑 JSON（无缩进换行）
    assert.equal(result.content[0].text.includes('\n'), false, 'text 应为紧凑 JSON');
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('paths 与 urls 可同时提供，按顺序批量转换', async () => {
    // Arrange
    const outputDir = makeOutDir('mixed-');

    // Act：回环地址会被 fetch-guard 拒绝，用于制造一个可复现的失败项
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { paths: [SAMPLE_MD], urls: ['http://127.0.0.1:9/'], outputDir },
    });

    // Assert
    const payload = result.structuredContent;
    assert.equal(payload.ok, false);
    assert.equal(payload.results.length, 1);
    assert.equal(payload.results[0].target, 'docx');
    assert.equal(payload.errors.length, 1);
    assert.equal(payload.errors[0].input, 'http://127.0.0.1:9/');
    assert.equal(typeof payload.errors[0].error, 'string');
    assert.notEqual(payload.errors[0].error, '');
});

// ============================================================
// convert_document：入参错误返回 isError
// ============================================================

test('输出目录不存在时返回 isError 与中文说明，不抛异常', async () => {
    // Act
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { paths: [SAMPLE_MD], outputDir: path.join(tmpDir, 'no-such-dir') },
    });

    // Assert
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /输出目录不存在或不是目录：/);
    assert.equal(result.structuredContent, undefined);
});

test('paths 与 urls 均为空时返回 isError', async () => {
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { outputDir: tmpDir },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /paths 与 urls 至少提供一项/);
});

test('target 与输入类型不匹配时返回 isError', async () => {
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { paths: [SAMPLE_MD], target: 'bundle', outputDir: tmpDir },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /目标 bundle 不接受 md 输入/);
});

test('xmlProfile 取值非法时返回 isError 与中文说明，不抛异常', async () => {
    // Act：schema 层即拒绝，SDK 把该错误包成 isError 结果返回
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { paths: [SAMPLE_MD], target: 'xml', outputDir: tmpDir, xmlProfile: 'cnipa' },
    });

    // Assert
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /xmlProfile 须为 generic \| patent 之一/);
    assert.equal(result.structuredContent, undefined);
});

test('嵌套段取值越界时由 options 归一层拒绝，返回 isError 的中文说明', async () => {
    // Act：xml.indent 在 schema 层是整数，取值范围由 converters/options.js 把关
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { paths: [SAMPLE_MD], target: 'xml', outputDir: tmpDir, xml: { indent: 99 } },
    });

    // Assert
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /选项 xml\.indent 须为 0–8 之间的整数/);
    assert.equal(result.structuredContent, undefined);
});

test('不支持的输入扩展名返回 isError', async () => {
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { paths: [path.join(tmpDir, 'a.txt')], outputDir: tmpDir },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /不支持的输入格式/);
});

// ============================================================
// extract_article
// ============================================================

const ARTICLE_PARAGRAPHS = [
    '知识库建设的第一道门槛是把散落在网页里的正文干净地取出来，导航、侧栏与评论一旦混进来，后续的切分与检索都会被噪声带偏，'
        + '而且这种污染很难在下游发现，往往要等到检索结果明显跑偏时才被察觉，返工成本相当高。',
    '模板化的抽取规则只能覆盖少数站点，面对长尾站点必须依赖通用的正文识别算法，按段落长度、链接密度与标点分布给候选容器打分，'
        + '再结合站点自身的结构特征做一次校正，才能在覆盖率与准确率之间取得可用的平衡。',
    '取出正文之后还要做一轮规范化，去掉零宽字符与多余空行，否则同一篇文章在不同时间抓取会产生大量无意义的差异，'
        + '既浪费存储，也让版本比对变得毫无意义，因此规范化应当作为管线里的固定环节而不是可选项。',
];
const ARTICLE_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>正文提取实践</title>
<meta property="og:site_name" content="工程笔记">
<meta name="author" content="孙七">
<meta property="article:published_time" content="2026-07-08T09:10:11Z">
<meta name="description" content="谈谈网页正文提取的工程实践">
</head><body>
<nav><a href="/">首页</a><a href="/about">关于</a></nav>
<div class="entry-body">
${ARTICLE_PARAGRAPHS.map((p) => `<p>${p}</p>`).join('\n')}
<p><img src="/pic.png" alt="流程示意"></p>
</div>
<div class="comment-list"><p>读者甲：受教了。</p><p>读者乙：同问。</p></div>
</body></html>`;

function startPageServer() {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push(req.url);
        if (req.url === '/article') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ARTICLE_PAGE);
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            base: `http://127.0.0.1:${server.address().port}`,
            requests,
            close: () => new Promise((done) => {
                server.closeAllConnections();
                server.close(() => done());
            }),
        }));
    });
}

// 另起一个允许访问本机地址的服务进程，cwd 指向一个空目录，便于断言「一个文件都没写」
async function startExtractClient(cwd) {
    const extractClient = new Client({ name: 'markflow-extract-test', version: '1.0.0' });
    await extractClient.connect(new StdioClientTransport({
        command: process.execPath,
        args: ['--require', PRELOAD, SERVER],
        cwd,
    }));
    return extractClient;
}

const listFilesDeep = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

test('extract_article 的 inputSchema 只有 url 必填', async () => {
    // Act
    const { tools } = await client.listTools();
    const tool = tools.find((item) => item.name === 'extract_article');

    // Assert
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['maxChars', 'url']);
    assert.deepEqual(tool.inputSchema.required, ['url']);
    assert.ok(tool.outputSchema, 'extract_article 应声明 outputSchema');
});

test('extract_article 返回正文与元数据，图片只列地址不下载，磁盘无任何产物', async (t) => {
    // Arrange
    const server = await startPageServer();
    const workDir = fs.mkdtempSync(path.join(tmpDir, 'extract-'));
    const extractClient = await startExtractClient(workDir);
    t.after(async () => { await extractClient.close(); await server.close(); });

    // Act
    const result = await extractClient.callTool({
        name: 'extract_article',
        arguments: { url: `${server.base}/article` },
    });

    // Assert：返回结构
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const payload = result.structuredContent;
    assert.equal(payload.url, `${server.base}/article`);
    assert.equal(payload.finalUrl, `${server.base}/article`);
    assert.equal(payload.title, '正文提取实践');
    assert.equal(payload.author, '孙七');
    assert.equal(payload.publishedAt, '2026-07-08T09:10:11.000Z');
    assert.equal(payload.siteName, '工程笔记');
    assert.equal(payload.excerpt, '谈谈网页正文提取的工程实践');
    assert.equal(payload.lang, 'zh-CN');
    assert.equal(payload.extraction, 'readability');
    assert.ok(payload.wordCount > 100, `wordCount 实际为 ${payload.wordCount}`);
    assert.equal(payload.truncated, false);

    // Assert：正文完整、噪声剔除
    for (const paragraph of ARTICLE_PARAGRAPHS) {
        assert.ok(payload.markdown.includes(paragraph), `正文段落应在返回里：${paragraph.slice(0, 10)}…`);
    }
    assert.ok(!payload.markdown.includes('读者甲'), '评论区不应出现在返回里');

    // Assert：图片只列原始地址，服务器没收到图片请求
    assert.deepEqual(payload.images, [{ url: `${server.base}/pic.png`, alt: '流程示意' }]);
    assert.deepEqual(server.requests, ['/article']);

    // Assert：全程零落盘
    assert.deepEqual(listFilesDeep(workDir), []);

    // Assert：text 内容与 structuredContent 同源
    assert.deepEqual(JSON.parse(result.content[0].text), payload);
});

test('extract_article 的 maxChars 生效：超长时截断并置 truncated', async (t) => {
    // Arrange
    const server = await startPageServer();
    const workDir = fs.mkdtempSync(path.join(tmpDir, 'extract-trunc-'));
    const extractClient = await startExtractClient(workDir);
    t.after(async () => { await extractClient.close(); await server.close(); });

    // Act
    const truncatedResult = await extractClient.callTool({
        name: 'extract_article',
        arguments: { url: `${server.base}/article`, maxChars: 20 },
    });
    const fullResult = await extractClient.callTool({
        name: 'extract_article',
        arguments: { url: `${server.base}/article`, maxChars: 100000 },
    });

    // Assert
    assert.equal(truncatedResult.structuredContent.truncated, true);
    assert.equal(truncatedResult.structuredContent.markdown.length, 20);
    assert.equal(fullResult.structuredContent.truncated, false);
    assert.ok(fullResult.structuredContent.markdown.length > 20);
    // 截断只影响 markdown，wordCount 仍按全文统计
    assert.equal(truncatedResult.structuredContent.wordCount, fullResult.structuredContent.wordCount);
    assert.deepEqual(listFilesDeep(workDir), []);
});

test('extract_article 抓取失败时返回 isError 与中文说明', async () => {
    // Act：默认服务进程不放行本机地址
    const result = await client.callTool({
        name: 'extract_article',
        arguments: { url: 'http://127.0.0.1:9/' },
    });

    // Assert
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /[一-龥]/);
    assert.equal(result.structuredContent, undefined);
});

// ============================================================
// 入参描述、取值范围与中文校验文案
// ============================================================

test('convert_document 的入参描述由 options.js 描述树生成，顶层数值字段带取值范围', async () => {
    // Act
    const { tools } = await client.listTools();
    const { properties } = tools.find((item) => item.name === 'convert_document').inputSchema;

    // Assert
    assert.match(properties.target.description, /content_list/);
    assert.match(properties.target.description, /contentListV2/);
    assert.match(properties.theme.description, /html 默认 apple，pdf 默认 print/);
    assert.match(properties.mineru.description, /~\/\.mineru\/config\.yaml/);
    assert.match(properties.paths.description, /工作目录/);
    assert.match(properties.paths.description, /errors/);
    assert.match(properties.returnContent.description, /contentTruncated/);
    assert.equal(properties.jpegQuality.type, 'integer');
    assert.equal(properties.jpegQuality.minimum, 60);
    assert.equal(properties.jpegQuality.maximum, 100);
    assert.match(properties.jpegQuality.description, /范围 60–100；默认 90/);
    assert.equal(properties.jpegPpi.minimum, 72);
    assert.equal(properties.jpegPpi.maximum, 600);
    assert.match(properties.html.properties.fontSize.description, /范围 10–32；默认 16/);
    assert.match(properties.docx.properties.fontSize.description, /范围 8–36；默认 11/);
});

test('schema 层拒绝的入参返回 isError 与中文说明：必填、类型、网址、整数与范围', async () => {
    // Arrange
    const cases = [
        [{ paths: [SAMPLE_MD] }, /outputDir 为必填项/],
        [{ paths: [SAMPLE_MD], outputDir: 42 }, /outputDir 须为字符串/],
        [{ urls: ['not-a-url'], outputDir: tmpDir }, /urls 的每一项须为合法网址/],
        [{ paths: [SAMPLE_MD], outputDir: tmpDir, jpegQuality: 'abc' }, /jpegQuality 须为数字/],
        [{ paths: [SAMPLE_MD], outputDir: tmpDir, jpegPpi: 100.5 }, /jpegPpi 须为整数/],
        [{ paths: [SAMPLE_MD], outputDir: tmpDir, jpegQuality: 120 }, /jpegQuality 须为 60–100 之间的整数/],
        [{ paths: [SAMPLE_MD], outputDir: tmpDir, html: 'apple' }, /html 须为对象/],
        [{ paths: [SAMPLE_MD], outputDir: tmpDir, xml: { indent: 'x' } }, /xml\.indent 须为数字/],
    ];

    for (const [args, expected] of cases) {
        // Act
        const result = await client.callTool({ name: 'convert_document', arguments: args });

        // Assert
        assert.equal(result.isError, true, JSON.stringify(args));
        assert.match(result.content[0].text, expected);
        assert.equal(result.structuredContent, undefined);
    }
    const extract = await client.callTool({ name: 'extract_article', arguments: {} });
    assert.equal(extract.isError, true);
    assert.match(extract.content[0].text, /url 为必填项/);
});

// ============================================================
// convert_document：结果信封的新增字段
// ============================================================

test('validate 为真时结果信封标记 validate: true，省略时无此字段', async () => {
    // Arrange
    const outputDir = makeOutDir('validate-');

    // Act
    const marked = await client.callTool({
        name: 'convert_document', arguments: { paths: [SAMPLE_MD], target: 'xml', outputDir, validate: true },
    });
    const plain = await client.callTool({ name: 'convert_document', arguments: { paths: [SAMPLE_MD], target: 'xml', outputDir } });

    // Assert
    assert.notEqual(marked.isError, true, JSON.stringify(marked.content));
    assert.equal(marked.structuredContent.validate, true);
    assert.equal(marked.structuredContent.results[0].options.xml.validate, true);
    assert.equal(plain.structuredContent.validate, undefined);
    const { tools } = await client.listTools();
    assert.equal(tools.find((item) => item.name === 'convert_document').outputSchema.properties.validate.type, 'boolean');
});

test('未知入参不再静默丢弃：顶层与嵌套段的未知键记入 ignoredArguments，其余照常转换', async () => {
    // Arrange
    const outputDir = makeOutDir('ignored-');

    // Act
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { paths: [SAMPLE_MD], target: 'html', outputDir, fontSize: 20, font: 'Georgia', html: { colour: 'red', fontSize: 18 } },
    });

    // Assert
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const payload = result.structuredContent;
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.ignoredArguments, ['font', 'fontSize', 'html.colour']);
    assert.equal(payload.results[0].options.html.fontSize, 18, '已知字段照常生效');
    assert.equal(payload.results[0].options.html.fontFamily, null, '未知键 font 不生效');
    const { tools } = await client.listTools();
    const tool = tools.find((item) => item.name === 'convert_document');
    assert.notEqual(tool.inputSchema.additionalProperties, false, 'inputSchema 不再声明拒收未知键');
    assert.deepEqual(tool.outputSchema.properties.ignoredArguments.items, { type: 'string' });
});

test('输入文件不预检：缺失项记入 errors 且 isError 为 false，其余项照常转换', async () => {
    // Arrange
    const outputDir = makeOutDir('missing-');
    const missing = path.join(tmpDir, '不存在.md');

    // Act
    const result = await client.callTool({ name: 'convert_document', arguments: { paths: [SAMPLE_MD, missing], outputDir } });

    // Assert
    assert.notEqual(result.isError, true);
    const payload = result.structuredContent;
    assert.equal(payload.ok, false);
    assert.equal(payload.results.length, 1);
    assert.deepEqual(payload.errors.map((item) => item.input), [missing]);
    assert.match(payload.errors[0].error, /输入文件不存在/);
    assert.equal(payload.ignoredArguments, undefined, '无未知入参时不写 ignoredArguments');
});

test('convert_document 的新增嵌套字段（pdf、mineru、xml 的 patent 别名、raster）进入结果 options', async () => {
    // Arrange
    const outputDir = makeOutDir('new-fields-');

    // Act
    const result = await client.callTool({
        name: 'convert_document',
        arguments: {
            paths: [SAMPLE_MD], target: 'html', outputDir,
            pdf: { pageSize: 'Letter', landscape: true },
            mineru: { formula: false, table: false, timeoutSec: 120 },
            xml: { imageDpi: 200, sectionDetection: 'headings', rasterizeTables: false, rasterizeFormulas: false },
            raster: { scale: 3, maxWidth: 1200 },
        },
    });

    // Assert
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const { options } = result.structuredContent.results[0];
    assert.equal(options.pdf.pageSize, 'Letter');
    assert.equal(options.pdf.landscape, true);
    assert.equal(options.mineru.formula, false);
    assert.equal(options.mineru.table, false);
    assert.equal(options.mineru.timeoutSec, 120);
    assert.deepEqual(options.xml.patent, {
        parts: 'auto', rasterizeTables: false, rasterizeFormulas: false, imageDpi: 200, sectionDetection: 'headings',
    });
    assert.deepEqual(options.raster, { scale: 3, maxWidth: 1200 });
});

// ============================================================
// convert_document：returnContent
// ============================================================

test('returnContent 对非 bundle 目标不返回正文，并在该项 warnings 中说明', async () => {
    // Arrange
    const outputDir = makeOutDir('content-html-');

    // Act
    const result = await client.callTool({
        name: 'convert_document', arguments: { paths: [SAMPLE_MD], target: 'html', outputDir, returnContent: true },
    });

    // Assert
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const [item] = result.structuredContent.results;
    assert.equal(item.content, undefined);
    assert.equal(item.contentTruncated, undefined);
    assert.ok(item.warnings.includes('returnContent 仅对 bundle 目标返回正文'), JSON.stringify(item.warnings));
});

test('returnContent 正文超过 20 万字符时截断并置 contentTruncated', async (t) => {
    // Arrange：约 23 万字符的长正文页，另起放行本机地址的服务进程
    const paragraphs = Array.from({ length: 2000 }, (_, i) => `第 ${i + 1} 段。${ARTICLE_PARAGRAPHS[i % ARTICLE_PARAGRAPHS.length]}`);
    const server = await startArticleServer({ pages: { '/long': buildArticlePage({ title: '超长正文', paragraphs }) } });
    const workDir = fs.mkdtempSync(path.join(tmpDir, 'long-'));
    const outputDir = makeOutDir('long-out-');
    const extractClient = await startExtractClient(workDir);
    t.after(async () => { await extractClient.close(); await server.close(); });

    // Act
    const result = await extractClient.callTool({
        name: 'convert_document', arguments: { urls: [`${server.base}/long`], outputDir, returnContent: true },
    });

    // Assert
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const [item] = result.structuredContent.results;
    const markdown = fs.readFileSync(item.outputs.md, 'utf8');
    assert.ok(markdown.length > 200000, `产物正文应超过 20 万字符，实际 ${markdown.length}`);
    assert.equal(item.contentTruncated, true);
    assert.equal(item.content.length, 200000);
    assert.ok(markdown.startsWith(item.content));
});

// ============================================================
// 目录输入、路径写法、重跑策略与取消
// ============================================================

test('outputDir 支持 ~ 写法，paths 支持目录并把展开情况写入信封', async (t) => {
    // Arrange：另起一个主目录指向临时目录的服务进程，使 ~ 可预期地展开。
    // os.homedir() 在类 Unix 上读 HOME，在 Windows 上读 USERPROFILE，两者都要覆盖，
    // 否则 win32 下 ~ 仍展开为运行器的真实主目录（C:\Users\runneradmin）。
    const home = fs.mkdtempSync(path.join(tmpDir, 'mcp-home-'));
    const outputDir = path.join(home, 'out');
    fs.mkdirSync(outputDir);
    const inDir = fs.mkdtempSync(path.join(tmpDir, 'mcp-dir-'));
    fs.copyFileSync(SAMPLE_MD, path.join(inDir, 'a.md'));
    fs.copyFileSync(SAMPLE_MD, path.join(inDir, 'b.md'));
    fs.writeFileSync(path.join(inDir, 'notes.txt'), '不受支持的文件');
    const homeClient = new Client({ name: 'markflow-home-test', version: '1.0.0' });
    await homeClient.connect(new StdioClientTransport({
        command: process.execPath, args: [SERVER], cwd: ROOT, env: { ...process.env, HOME: home, USERPROFILE: home },
    }));
    t.after(() => homeClient.close());

    // Act
    const result = await homeClient.callTool({
        name: 'convert_document', arguments: { paths: [inDir], target: 'html', outputDir: '~/out' },
    });

    // Assert
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const payload = result.structuredContent;
    assert.equal(payload.ok, true, JSON.stringify(payload.errors));
    assert.equal(payload.outputDir, outputDir, '~ 应展开为主目录下的绝对路径');
    assert.deepEqual(payload.results.map((item) => item.name).sort(), ['a', 'b']);
    assert.deepEqual(payload.inputExpansion.directories, [{ path: inDir, count: 2 }]);
    assert.deepEqual(payload.inputExpansion.skipped, [path.join(inDir, 'notes.txt')]);
    assert.equal(payload.inputExpansion.truncated, false);
});

test('未给目录时信封不带 inputExpansion；skipExisting 命中时结果项带 skipped 且不重写产物', async () => {
    // Arrange
    const outputDir = makeOutDir('skip-');

    // Act
    const first = await client.callTool({ name: 'convert_document', arguments: { paths: [SAMPLE_MD], target: 'docx', outputDir } });
    assert.notEqual(first.isError, true, JSON.stringify(first.content));
    const produced = first.structuredContent.results[0].outputPath;
    const mtimeBefore = fs.statSync(produced).mtimeMs;
    const second = await client.callTool({
        name: 'convert_document', arguments: { paths: [SAMPLE_MD], target: 'docx', outputDir, skipExisting: true },
    });
    assert.notEqual(second.isError, true, JSON.stringify(second.content));
    // 跳过项未解析文档，title 为 null，outputSchema 须放行
    assert.equal(second.structuredContent.results[0].title, null);
    const badClean = await client.callTool({
        name: 'convert_document', arguments: { paths: [SAMPLE_MD], target: 'docx', outputDir, clean: 'yes' },
    });

    // Assert
    assert.equal(first.structuredContent.inputExpansion, undefined, '未给目录时不写 inputExpansion');
    assert.equal(first.structuredContent.results[0].skipped, undefined);
    assert.equal(second.structuredContent.results[0].skipped, true);
    assert.equal(fs.statSync(produced).mtimeMs, mtimeBefore, '跳过时不得重写产物');
    assert.equal(badClean.isError, true);
    assert.match(badClean.content[0].text, /clean 须为布尔值/);
});

test('请求取消后不再领取新任务：已开始的照常写出，服务继续可用', async (t) => {
    // Arrange：延时应答的本机页面，取消时首批任务必然仍在进行
    const server = await startArticleServer({ pages: { '/slow': { html: buildArticlePage(), delayMs: 400 } } });
    const workDir = fs.mkdtempSync(path.join(tmpDir, 'cancel-'));
    const outputDir = makeOutDir('cancel-out-');
    const cancelClient = await startExtractClient(workDir);
    t.after(async () => { await cancelClient.close(); await server.close(); });
    const urls = Array.from({ length: 6 }, () => `${server.base}/slow`);
    const controller = new AbortController();

    // Act：首个请求到达即取消
    const call = cancelClient.callTool(
        { name: 'convert_document', arguments: { urls, outputDir } }, undefined, { signal: controller.signal },
    );
    await new Promise((resolve) => {
        const timer = setInterval(() => {
            if (server.requests.length >= 1) { clearInterval(timer); resolve(); }
        }, 10);
    });
    controller.abort();
    await assert.rejects(call, '取消后客户端侧的调用应被拒绝');
    // MCP 协议规定取消后不再回响应，故以磁盘产物与服务可用性验证服务端行为
    await new Promise((resolve) => { setTimeout(resolve, 900); });

    // Assert
    assert.ok(fs.readdirSync(outputDir).length < urls.length,
        `未领取的任务不应产出：${JSON.stringify(fs.readdirSync(outputDir))}`);
    assert.ok(server.requests.length < urls.length, '中止后不应再抓取新页面');
    const after = await cancelClient.callTool({ name: 'list_formats' });
    assert.notEqual(after.isError, true, '取消后服务仍应继续可用');
});

// ============================================================
// 进度通知、annotations 与 instructions
// ============================================================

/**
 * 进度通知在传输层取证，而不是只看 SDK 的 onprogress 回调：
 * StdioClientTransport 的 processReadBuffer 会把同一个读块里的帧按序同步交给 onmessage，而 SDK 的
 * Protocol 对两类帧处理时序不同——通知走 _onnotification，派发被推迟到一个微任务（protocol.js:284）；
 * 响应走 _onresponse，在同一同步段里就删掉了 _progressHandlers（protocol.js:488）。于是末尾若干条通知
 * 一旦与响应落进同一个读块，等它们的微任务跑起来时 progress 处理器已被删除，_onprogress 会以
 * “unknown token” 丢弃它们。服务端的写入顺序本身是对的（通知先于响应写进同一条 stdout 管道，实测
 * 180 轮无一例外），丢帧纯属客户端派发时序，负载越高越容易命中——CI 上那次 last.progress 停在 190
 * 即此因。故在 onmessage 上取证：该回调与响应帧的处理同处一个同步段，响应到达时先于它的帧必已记全，
 * 断言因此不依赖任何时序。
 */
test('带 progressToken 调用时推送严格递增的中文进度通知，末条为全部完成', async () => {
    // Arrange
    const outputDir = makeOutDir('progress-');
    const frames = [];
    const events = [];
    const deliver = clientTransport.onmessage;
    clientTransport.onmessage = (message, extra) => {
        if (message && message.method === 'notifications/progress') frames.push(message.params);
        deliver(message, extra);
    };

    // Act：SDK 客户端给出 onprogress 时自动在 _meta 中带上 progressToken
    let result;
    try {
        result = await client.callTool(
            { name: 'convert_document', arguments: { paths: [SAMPLE_MD, SAMPLE_PDF], outputDir, pdfBackend: 'local' } },
            undefined,
            { onprogress: (progress) => events.push(progress) },
        );
    } finally {
        clientTransport.onmessage = deliver;
    }

    // Assert
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.equal(result.structuredContent.ok, true);
    assert.ok(frames.length >= 2, `应收到多条进度，实际 ${frames.length}`);
    const token = frames[0].progressToken;
    frames.forEach((frame, i) => {
        assert.equal(frame.progressToken, token, '同一次调用的进度帧须带同一个 token');
        assert.equal(frame.total, 200);
        assert.match(frame.message, /[一-龥]/);
        if (i > 0) assert.ok(frame.progress > frames[i - 1].progress, `进度须严格递增：${JSON.stringify(frames)}`);
    });
    const last = frames[frames.length - 1];
    assert.equal(last.progress, 200);
    assert.match(last.message, /完成/);
    // SDK 交付给调用方的那部分只可能少掉末尾若干条，故必为线上序列的前缀
    assert.deepEqual(
        events.map((event) => event.progress),
        frames.slice(0, events.length).map((frame) => frame.progress),
    );
});

test('工具 annotations 与服务 instructions', async () => {
    // Act
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const instructions = client.getInstructions();

    // Assert
    assert.deepEqual(byName.convert_document.annotations, { destructiveHint: true, openWorldHint: true });
    assert.equal(byName.extract_article.annotations.readOnlyHint, true);
    assert.equal(byName.list_formats.annotations.readOnlyHint, true);
    assert.equal(typeof instructions, 'string');
    assert.match(instructions, /outputDir/);
    assert.match(instructions, /已存在/);
    assert.match(instructions, /计费/);
    assert.match(instructions, /pdfBackend:"local"/);
    assert.match(instructions, /extract_article/);
});

// ============================================================
// 模块导出
// ============================================================

test('createServer 返回未连接的 McpServer；console 标准输出通道已重定向到 stderr', () => {
    // Arrange & Act：本用例会改写当前进程的 console.log，故置于文件末尾
    const mod = require('../mcp/server');
    const server = mod.createServer();

    // Assert
    assert.equal(typeof mod.start, 'function');
    assert.equal(typeof server.connect, 'function');
    assert.equal(typeof server.registerTool, 'function');
    assert.equal(console.log, console.error);
    assert.equal(console.info, console.error);
    assert.equal(console.debug, console.error);
});

// ============================================================
// 专利五书 XML 反向导入
// ============================================================

const {
    buildOfficialBundle, writeFiles, zipFiles, OFFICIAL_EXPECTED,
} = require('./fixtures/patent/roundtrip/build-roundtrip-fixtures');

test('convert_document 受理专利五书的三种输入：案卷 zip、五书目录与单个 XML，target 省略即 docx', async () => {
    // Arrange
    const work = makeOutDir('import-');
    const bundle = await buildOfficialBundle();
    const dir = writeFiles(path.join(work, '目录案卷'), bundle.files);
    const zip = path.join(work, '压缩案卷.zip');
    fs.writeFileSync(zip, await zipFiles(bundle.files));
    const single = path.join(dir, '100001', '100001.xml');
    const outputDir = makeOutDir('import-out-');

    // Act
    const result = await client.callTool({ name: 'convert_document', arguments: { paths: [zip, dir, single], outputDir } });

    // Assert
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const payload = result.structuredContent;
    assert.equal(payload.ok, true, JSON.stringify(payload.errors));
    assert.equal(payload.inputExpansion, undefined, '五书目录整体作为一项输入，不算目录展开');
    assert.deepEqual(payload.results.map((item) => [item.input, item.target, item.sourceType, item.name]), [
        [zip, 'docx', 'zip', '压缩案卷'], [dir, 'docx', 'xml', '目录案卷'], [single, 'docx', 'xml', '100001'],
    ]);
    assert.deepEqual(payload.results.map((item) => item.title), [OFFICIAL_EXPECTED.inventionTitle, OFFICIAL_EXPECTED.inventionTitle, '100001']);
    for (const item of payload.results) {
        assert.ok(fs.statSync(item.outputs.docx).size > 0);
        assert.ok(item.warnings.every((warning) => warning.startsWith('导入：')), item.warnings.join('\n'));
    }
});

test('convert_document 的 xmlImport 段：schema 只有 paragraphNumbers，取值透传，段内未知字段记入 ignoredArguments', async () => {
    // Arrange
    const { tools } = await client.listTools();
    const { properties } = tools.find((item) => item.name === 'convert_document').inputSchema;
    const work = makeOutDir('import-options-');
    const zip = path.join(work, '案卷.zip');
    fs.writeFileSync(zip, await zipFiles((await buildOfficialBundle()).files));

    // Act
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { paths: [zip], outputDir: makeOutDir('import-options-out-'), target: 'html', xmlImport: { paragraphNumbers: true, images: 'link' } },
    });

    // Assert
    assert.deepEqual(Object.keys(properties.xmlImport.properties), ['paragraphNumbers']);
    assert.equal(properties.xmlImport.properties.paragraphNumbers.type, 'boolean');
    assert.match(properties.xmlImport.properties.paragraphNumbers.description, /段号写回段首.*默认 false/);
    assert.match(properties.paths.description, /案卷 \.zip，或整个五书目录/);
    const payload = result.structuredContent;
    assert.equal(payload.ok, true, JSON.stringify(payload.errors));
    assert.deepEqual(payload.ignoredArguments, ['xmlImport.images']);
    assert.equal(payload.results[0].options.xmlImport.paragraphNumbers, true);
    assert.ok(fs.readFileSync(payload.results[0].outputs.html, 'utf8').includes('[0001]'));
});

test('convert_document：非专利 XML 与 bundle 目标的中文说明', async () => {
    // Arrange
    const work = makeOutDir('import-foreign-');
    const foreign = path.join(writeFiles(work, { 'pom.xml': Buffer.from('<project/>') }), 'pom.xml');

    // Act
    const failed = await client.callTool({ name: 'convert_document', arguments: { paths: [foreign], outputDir: makeOutDir('import-foreign-out-') } });
    const refused = await client.callTool({ name: 'convert_document', arguments: { paths: [foreign], target: 'bundle', outputDir: makeOutDir('import-refused-out-') } });

    // Assert：运行期失败进 errors（isError 为 false）；目标不接受该输入属入参错误
    assert.notEqual(failed.isError, true);
    assert.deepEqual(failed.structuredContent.errors, [{ input: foreign, error: 'pom.xml 不是国知局专利五书 XML：根元素为 project，应为 cn-application-body' }]);
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /目标 bundle 不接受 xml 输入/);
});
