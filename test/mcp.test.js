/**
 * mcp/server.js 集成测试
 *
 * 以官方 SDK 的 stdio 客户端连接真实服务进程，覆盖：
 *   工具清单、list_formats 能力矩阵、convert_document 的成功/入参错误/运行期失败、returnContent。
 * 客户端在 listTools() 后会用 outputSchema 校验 structuredContent，因此这些用例同时验证了
 * 服务端返回结构与声明的 schema 一致。临时产物一律写入 os.tmpdir()。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'mcp', 'server.js');
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

test('listTools 恰好暴露 convert_document 与 list_formats', async () => {
    // Act
    const { tools } = await client.listTools();

    // Assert
    assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        ['convert_document', 'list_formats'],
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
