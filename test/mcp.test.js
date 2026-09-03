/**
 * mcp/server.js 集成测试
 *
 * 以官方 SDK 的 stdio 客户端连接真实服务进程，覆盖：
 *   工具清单、list_formats 能力矩阵、convert_document 的成功/入参错误/运行期失败、returnContent、
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

test('convert_document 的 inputSchema 声明 outputDir 为必填', async () => {
    // Act
    const { tools } = await client.listTools();
    const tool = tools.find((item) => item.name === 'convert_document');

    // Assert
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), [
        'outputDir',
        'paths',
        'returnContent',
        'target',
        'urls',
    ]);
    assert.deepEqual(tool.inputSchema.required, ['outputDir']);
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
    assert.ok(targets.office.includes('bundle'));
    assert.ok(targets.url.includes('bundle'));
    assert.ok(targets.markup.includes('docx'));
    assert.equal(typeof capabilities.sofficeAvailable, 'boolean');
    assert.equal(typeof capabilities.pdfBackend.available, 'boolean');
    assert.equal(typeof capabilities.pdfBackend.hint, 'string');
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
});

test('省略 target 时按输入类型取默认值：PDF 转 bundle', async () => {
    // Arrange
    const outputDir = makeOutDir('bundle-');

    // Act
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { paths: [SAMPLE_PDF], outputDir },
    });

    // Assert
    const [item] = result.structuredContent.results;
    assert.equal(item.target, 'bundle');
    assert.ok(fs.existsSync(item.outputs.md));
    assert.ok(fs.existsSync(item.outputs.json));
});

test('returnContent 为 true 时附带生成的 Markdown 正文', async () => {
    // Arrange
    const outputDir = makeOutDir('content-');

    // Act
    const result = await client.callTool({
        name: 'convert_document',
        arguments: { paths: [SAMPLE_PDF], returnContent: true, outputDir },
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
