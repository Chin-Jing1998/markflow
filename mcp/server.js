/**
 * MarkFlow MCP stdio 服务
 *
 * stdio 传输下 stdout 被 JSON-RPC 帧独占，因此先把 console 的标准输出通道重定向到 stderr，
 * 防止依赖库的日志污染协议流；此重定向必须在 require 其它模块之前完成。
 * 工具：convert_document（批量转换）、list_formats（能力矩阵）。
 */
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const fsp = require('fs').promises;
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { convert, listTargets, runBatch } = require('../converters');
const { resolveTarget, classifyInput } = require('../converters/targets');
const pkg = require('../package.json');

const CONCURRENCY = 2;
const MAX_CONTENT_CHARS = 200000;

const CONVERT_INPUT = {
    paths: z.array(z.string()).optional().describe('本地文件绝对路径列表'),
    urls: z.array(z.string().url()).optional().describe('网页 URL 列表'),
    target: z.enum(['bundle', 'docx', 'pdf']).optional().describe('bundle=md+json+images（办公文档/网页），docx|pdf 仅用于 Markdown 输入；省略则按输入类型默认'),
    outputDir: z.string().describe('已存在的输出目录绝对路径'),
    returnContent: z.boolean().optional().describe(`为 true 时在结果中附带生成的 Markdown 文本（bundle 目标，最多 ${MAX_CONTENT_CHARS} 字符）`),
};
const RESULT_ITEM = z.object({
    input: z.string(), target: z.string(), name: z.string(), title: z.string(), outputPath: z.string(),
    outputs: z.record(z.string()), imagesCount: z.number(), warnings: z.array(z.string()),
    content: z.string().optional(),
});
const CONVERT_OUTPUT = {
    ok: z.boolean(), outputDir: z.string(), results: z.array(RESULT_ITEM),
    errors: z.array(z.object({ input: z.string(), error: z.string() })),
};
const CAPABILITIES = z.object({
    sofficeAvailable: z.boolean(),
    pdfBackend: z.object({ name: z.string().nullable(), available: z.boolean(), hint: z.string() }),
});
const FORMATS_OUTPUT = { targets: z.record(z.any()), capabilities: CAPABILITIES, version: z.string() };

// ==================== 工具实现 ====================

async function handleConvertDocument(args = {}) {
    const raws = [...(Array.isArray(args.paths) ? args.paths : []), ...(Array.isArray(args.urls) ? args.urls : [])];
    if (raws.length === 0) return failure('paths 与 urls 至少提供一项');
    const outputDir = typeof args.outputDir === 'string' ? args.outputDir : '';
    if (!(await isDirectory(outputDir))) return failure(`输出目录不存在或不是目录：${outputDir}`);

    let tasks;
    try {
        tasks = raws.map((raw) => {
            const { input, type } = classifyInput(raw, process.cwd());
            return { raw, input, target: resolveTarget(type, args.target) };
        });
    } catch (err) {
        return failure(messageOf(err));
    }

    const run = (task) => convert({ input: task.input, target: task.target, outputDir });
    const { results, errors } = await runBatch(tasks, { concurrency: CONCURRENCY }, run);
    return success({
        ok: errors.length === 0,
        outputDir,
        results: await Promise.all(
            results.map(({ idx, result }) => describeResult(tasks[idx].raw, result, args.returnContent)),
        ),
        errors: errors.map(({ idx, error }) => ({ input: tasks[idx].raw, error: messageOf(error) })),
    });
}

async function handleListFormats() {
    const [sofficeAvailable, pdfBackend] = await Promise.all([
        require('../server/soffice').isAvailable(),
        require('../converters/pdf/backend').detect(),
    ]);
    const capabilities = { sofficeAvailable: Boolean(sofficeAvailable), pdfBackend };
    const targets = listTargets({
        sofficeAvailable: capabilities.sofficeAvailable,
        pdfBackend: pdfBackend.available ? pdfBackend : null,
    });
    return success({ targets, capabilities, version: pkg.version });
}

// returnContent 为 true 且产物含 Markdown 时附带正文（截断到上限）
async function describeResult(input, result, returnContent) {
    const { target, name, title, outputPath, imagesCount } = result;
    const outputs = result.outputs || {};
    const item = { input, target, name, title, outputPath, outputs, imagesCount, warnings: result.warnings || [] };
    if (!returnContent || !outputs.md) return item;
    return { ...item, content: (await readTextOrEmpty(outputs.md)).slice(0, MAX_CONTENT_CHARS) };
}

// ==================== 服务装配 ====================

function createServer() {
    const server = new McpServer({ name: 'markflow', version: pkg.version });
    server.registerTool('convert_document', {
        title: '转换文档',
        description: '把本地办公文档、PDF、Markdown 或网页转换为 Markdown 包（bundle）、DOCX 或 PDF。',
        inputSchema: CONVERT_INPUT,
        outputSchema: CONVERT_OUTPUT,
    }, handleConvertDocument);
    // list_formats 不声明 inputSchema：SDK 会给出空对象 schema，且允许调用方省略 arguments
    server.registerTool('list_formats', {
        title: '列出可用格式',
        description: '返回输入类型与转换目标的对应矩阵，以及本机 LibreOffice 与 PDF 后端的可用性。',
        outputSchema: FORMATS_OUTPUT,
    }, handleListFormats);
    return server;
}

async function start() {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    return server;
}

// ==================== 通用工具 ====================

const messageOf = (err) => (err && err.message ? err.message : String(err));

function success(structuredContent) {
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
}

// 入参层面的错误：返回 isError 结果而非抛异常，便于调用方读到中文说明
function failure(message) {
    return { isError: true, content: [{ type: 'text', text: message }] };
}

async function isDirectory(target) {
    if (typeof target !== 'string' || !target.trim()) return false;
    try { return (await fsp.stat(target)).isDirectory(); } catch (err) { return false; }
}

async function readTextOrEmpty(filePath) {
    try { return await fsp.readFile(filePath, 'utf8'); } catch (err) { return ''; }
}

module.exports = { createServer, start };

if (require.main === module) {
    start().catch((err) => { console.error(`MarkFlow MCP 启动失败：${messageOf(err)}`); process.exit(1); });
}
