/**
 * mcp/server.js 集成测试
 *
 * 以官方 SDK 的 stdio 客户端连接真实服务进程，覆盖：
 *   工具清单与入参 schema（含转换选项、2020-12 方言、无 $ref）、list_formats 能力矩阵、
 *   convert_document 的成功/选项透传/入参错误/运行期失败、returnContent、
 *   extract_article 的只读提取（结构、截断语义、零落盘）。
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

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'mcp', 'server.js');
const PRELOAD = path.join(ROOT, 'test', 'fixtures', 'allow-private-network.js');
const SAMPLE_MD = path.join(ROOT, 'test', 'fixtures', 'sample.md');
const SAMPLE_PDF = path.join(ROOT, 'test', 'fixtures', 'sample.pdf');
const PKG_VERSION = require('../package.json').version;

let client;
let tmpDir;

before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-mcp-'));
    client = new Client({ name: 'markflow-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: ROOT }));
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
        'docx', 'html', 'imageFormat', 'jpegPpi', 'jpegQuality', 'math', 'mineru', 'outputDir', 'paths',
        'patentParts', 'pdfBackend', 'returnContent', 'target', 'theme', 'urls', 'validate', 'xml', 'xmlProfile',
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
    assert.deepEqual(Object.keys(properties.mineru.properties), ['model', 'ocr', 'language', 'pageRanges']);
    assert.deepEqual(Object.keys(properties.html.properties),
        ['fontFamily', 'fontSize', 'lineHeight', 'contentWidth', 'spacing', 'inlineImages']);
    assert.deepEqual(Object.keys(properties.docx.properties), ['pageSize', 'fontSize', 'fontAscii', 'fontEastAsia']);
    assert.deepEqual(Object.keys(properties.xml.properties), ['indent', 'numberingStart', 'numberingWidth']);
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
    assert.deepEqual(Object.keys(capabilities).sort(), ['mineru', 'pdfBackend', 'raster', 'themes', 'xmlProfiles']);
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
