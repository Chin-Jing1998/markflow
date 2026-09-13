/**
 * MarkFlow MCP stdio 服务
 *
 * stdio 传输下 stdout 被 JSON-RPC 帧独占，因此先把 console 的标准输出通道重定向到 stderr，
 * 防止依赖库的日志污染协议流；此重定向必须在 require 其它模块之前完成。
 * 工具：convert_document（批量转换）、list_formats（能力矩阵）、extract_article（网页只读提取）。
 */
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const fsp = require('fs').promises;
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const service = require('../converters/service');
const { OPTION_ENUMS } = require('../converters/options');
const { errText, isDirectory } = require('../converters/util');
const pkg = require('../package.json');

const CONCURRENCY = 2;
const MAX_CONTENT_CHARS = 200000;
const DEFAULT_EXTRACT_MAX_CHARS = 50000;

// 枚举取值一律取自 converters/options.js，不在本文件重复维护；每处新建实例（同一 zod 对象复用会被转成 $ref），
// errorMap 让 schema 层的拒绝也带中文说明——SDK 会把该错误包成 isError 结果返回，不抛到调用方
const enumOf = (values, label) => z.enum([...values], {
    errorMap: () => ({ message: `${label} 须为 ${values.join(' | ')} 之一` }),
});

const CONVERT_INPUT = {
    paths: z.array(z.string()).optional().describe('本地文件绝对路径列表'),
    urls: z.array(z.string().url()).optional().describe('网页 URL 列表'),
    target: z.enum(['bundle', 'docx', 'pdf', 'html', 'xml']).optional().describe('bundle=md+json+images（办公文档/网页），docx|pdf 仅用于 Markdown 输入，html|xml 接受全部输入；省略则按输入类型默认'),
    outputDir: z.string().describe('已存在的输出目录绝对路径'),
    returnContent: z.boolean().optional().describe(`为 true 时在结果中附带生成的 Markdown 文本（bundle 目标，最多 ${MAX_CONTENT_CHARS} 字符）`),
    theme: enumOf(OPTION_ENUMS.htmlThemes, 'theme').optional().describe('html 与 pdf 目标的主题'),
    xmlProfile: enumOf(OPTION_ENUMS.xmlProfiles, 'xmlProfile').optional()
        .describe('XML 方言：generic 通用文档结构，patent 国知局专利五书'),
    patentParts: z.array(enumOf(OPTION_ENUMS.patentParts, 'patentParts')).optional()
        .describe('patent profile 下输出的五书子集；省略即按识别结果输出'),
    pdfBackend: enumOf(OPTION_ENUMS.pdfBackends, 'pdfBackend').optional()
        .describe('PDF 解析后端：auto 有 MinerU 令牌走云端否则本地，mineru 强制云端，local 强制本地'),
    imageFormat: enumOf(OPTION_ENUMS.imageFormats, 'imageFormat').optional()
        .describe('图片归一格式：jpg 把位图统一转为 JPEG，keep 保持原格式'),
    jpegQuality: z.number().int().optional().describe('JPEG 质量，60–100'),
    math: enumOf(OPTION_ENUMS.mathModes, 'math').optional()
        .describe('docx 公式：image 栅格为图片，text 降级为线性化文本'),
    mineru: z.object({
        model: enumOf(OPTION_ENUMS.mineruModels, 'mineru.model'),
        ocr: z.boolean(),
        language: z.string(),
        pageRanges: z.string(),
    }).partial().optional()
        .describe('MinerU 云端解析参数；令牌只取自本机环境变量或 ~/.markflow/config.json，不接受经此传入'),
    html: z.object({
        fontFamily: z.string(),
        fontSize: z.number(),
        lineHeight: z.number(),
        contentWidth: z.number().int(),
        spacing: enumOf(OPTION_ENUMS.spacing, 'html.spacing'),
        inlineImages: z.boolean(),
    }).partial().optional().describe('html 目标参数：字体栈、字号（px）、行高、栏宽（px）、段距与图片内联'),
    docx: z.object({
        pageSize: enumOf(OPTION_ENUMS.pageSizes, 'docx.pageSize'),
        fontSize: z.number(),
        fontAscii: z.string(),
        fontEastAsia: z.string(),
    }).partial().optional().describe('docx 目标参数：纸张、正文字号（pt）与中西文字体'),
    xml: z.object({
        indent: z.number().int(),
        numberingStart: z.number().int(),
        numberingWidth: z.number().int(),
    }).partial().optional().describe('xml 目标参数：缩进空格数与说明书段号的起始值、补零位数'),
    validate: z.boolean().optional().describe('xml 目标：渲染后用官方 DTD 校验（patent）或检查 well-formed（generic），结果写入 warnings'),
};
// 入参中交给 service.buildOptions 的键；其余（paths/urls/target/outputDir/returnContent）由本文件自行处理
const OPTION_ARG_KEYS = Object.freeze([
    'theme', 'xmlProfile', 'patentParts', 'pdfBackend', 'imageFormat', 'jpegQuality', 'math',
    'mineru', 'html', 'docx', 'xml', 'validate',
]);
const RESULT_ITEM = z.object({
    input: z.string(), target: z.string(), name: z.string(), title: z.string(), sourceType: z.string(),
    outputPath: z.string(), outputs: z.record(z.string()), imagesCount: z.number(), warnings: z.array(z.string()),
    options: z.record(z.any()), extras: z.array(z.string()),
    backends: z.object({ pdfParser: z.string().nullable(), raster: z.string().nullable() }),
    content: z.string().optional(),
});
const CONVERT_OUTPUT = {
    ok: z.boolean(), outputDir: z.string(), results: z.array(RESULT_ITEM),
    errors: z.array(z.object({ input: z.string(), error: z.string() })),
};
// 后端探测结果；每处调用都新建一份 schema：同一 zod 对象复用两次会被转成 $ref，而 Desktop 客户端不接受 $ref
const backendStatus = () => z.object({ name: z.string().nullable(), available: z.boolean(), hint: z.string() });
const CAPABILITIES = z.object({
    pdfBackend: backendStatus(),
    raster: backendStatus(),
    mineru: z.object({ configured: z.boolean(), source: z.string().nullable() }),
    themes: z.array(z.string()),
    xmlProfiles: z.array(z.string()),
});
const FORMATS_OUTPUT = { targets: z.record(z.any()), capabilities: CAPABILITIES, version: z.string() };

const EXTRACT_INPUT = {
    url: z.string().url().describe('网页地址'),
    maxChars: z.number().int().positive().optional()
        .describe(`返回 Markdown 的最大字符数，默认 ${DEFAULT_EXTRACT_MAX_CHARS}，超出截断并标记`),
};
// 取不到的元数据字段整条省略，故除必有字段外一律 optional
const EXTRACT_OUTPUT = {
    url: z.string(), finalUrl: z.string(), title: z.string(),
    author: z.string().optional(), publishedAt: z.string().optional(), siteName: z.string().optional(),
    excerpt: z.string().optional(), lang: z.string().optional(),
    wordCount: z.number(), extraction: z.string(), markdown: z.string(), truncated: z.boolean(),
    images: z.array(z.object({ url: z.string(), alt: z.string() })),
};
const EXTRACT_OPTIONAL_META = Object.freeze(['author', 'publishedAt', 'siteName', 'excerpt', 'lang']);

// ==================== 工具实现 ====================

async function handleConvertDocument(args = {}) {
    const raws = [...(Array.isArray(args.paths) ? args.paths : []), ...(Array.isArray(args.urls) ? args.urls : [])];
    if (raws.length === 0) return failure('paths 与 urls 至少提供一项');
    const outputDir = typeof args.outputDir === 'string' ? args.outputDir : '';
    if (!(await isDirectory(outputDir))) return failure(`输出目录不存在或不是目录：${outputDir}`);

    // 取值范围与中文错误文案由 converters/options.js 的归一层给出，此处只把失败转成 isError 结果
    let options;
    try {
        options = service.buildOptions(pickDefined(args, OPTION_ARG_KEYS));
    } catch (err) {
        return failure(errText(err));
    }

    let tasks;
    try {
        tasks = service.planTasks(raws, args.target, process.cwd());
    } catch (err) {
        return failure(errText(err));
    }

    const payload = await service.runConversion({ tasks, outputDir, concurrency: CONCURRENCY, options });
    return success({
        ...payload,
        results: await Promise.all(payload.results.map((item) => withContent(item, args.returnContent))),
    });
}

async function handleListFormats() {
    return success(await service.describeFormats());
}

/**
 * 网页只读提取：复用 parsers/url 的提取链路（ctx.skipImages 关掉图片下载），
 * 渲染成 Markdown 直接返回。全程不落盘、不产生 assets，图片只列原始地址。
 */
async function handleExtractArticle(args = {}) {
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    if (!url) return failure('缺少 url');
    const maxChars = Number.isInteger(args.maxChars) && args.maxChars > 0 ? args.maxChars : DEFAULT_EXTRACT_MAX_CHARS;

    let doc;
    try {
        doc = await require('../converters/parsers/url').parse({ url }, { skipImages: true });
    } catch (err) {
        return failure(errText(err));
    }

    const markdown = String(await require('../converters/renderers/md').render(doc));
    const meta = doc.meta || {};
    const truncated = markdown.length > maxChars;
    return success({
        url,
        finalUrl: typeof meta.finalUrl === 'string' ? meta.finalUrl : url,
        title: typeof meta.title === 'string' ? meta.title : '',
        ...pickStrings(meta, EXTRACT_OPTIONAL_META),
        wordCount: Number.isFinite(meta.wordCount) ? meta.wordCount : 0,
        extraction: typeof meta.extraction === 'string' ? meta.extraction : '',
        markdown: truncated ? markdown.slice(0, maxChars) : markdown,
        truncated,
        images: doc.data && Array.isArray(doc.data.images) ? doc.data.images : [],
    });
}

// 只挑出调用方确实给了的键；未给出的不进 buildOptions，由 options.js 补默认值
function pickDefined(source, keys) {
    return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

// 只挑出确实有值的字符串字段，空值不进结果
function pickStrings(source, keys) {
    return Object.fromEntries(
        keys.filter((key) => typeof source[key] === 'string' && source[key] !== '').map((key) => [key, source[key]]),
    );
}

// returnContent 为 true 且产物含 Markdown 时附带正文（截断到上限）；其余字段由服务层给出
async function withContent(item, returnContent) {
    if (!returnContent || !item.outputs.md) return item;
    return { ...item, content: (await readTextOrEmpty(item.outputs.md)).slice(0, MAX_CONTENT_CHARS) };
}

// ==================== 服务装配 ====================

function createServer() {
    const server = new McpServer({ name: 'markflow', version: pkg.version });
    server.registerTool('convert_document', {
        title: '转换文档',
        description: '把本地办公文档、PDF、Markdown 或网页转换为 Markdown 包（bundle）、DOCX、PDF、HTML 或 XML；'
            + '可指定主题、XML profile、图片与公式处理方式以及 MinerU 解析参数，省略的选项取默认值。',
        inputSchema: CONVERT_INPUT,
        outputSchema: CONVERT_OUTPUT,
    }, handleConvertDocument);
    server.registerTool('extract_article', {
        title: '提取网页正文',
        description: '抓取网页并只返回提取后的 Markdown 正文与元数据，不下载图片、不写任何文件。',
        inputSchema: EXTRACT_INPUT,
        outputSchema: EXTRACT_OUTPUT,
    }, handleExtractArticle);
    // list_formats 不声明 inputSchema：SDK 会给出空对象 schema，且允许调用方省略 arguments
    server.registerTool('list_formats', {
        title: '列出可用格式',
        description: '返回输入类型与转换目标的对应矩阵、可选主题与 XML profile，以及本机 PDF 后端、栅格化后端与 MinerU 令牌的状态。',
        outputSchema: FORMATS_OUTPUT,
    }, handleListFormats);
    return server;
}

// SDK 1.30 经 zod v3 转换器生成 schema 时固定写入 draft-07 标识，而 Claude Desktop 内置客户端的
// 校验器只接受 2020-12：见到其它标识即抛 “unsupported dialect” 并在校验层拦下调用，工具根本不执行。
// 生成的 schema 只用到 type / properties / required / items / additionalProperties 等两版语义一致的
// 关键字，不含 definitions、$ref 或元组式 items，故仅在出站帧上改写标识即可，schema 语义不变。
const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/** 返回改写了 $schema 的副本；本身未声明 $schema 时原样返回 */
function withCurrentDialect(schema) {
    if (!schema || typeof schema !== 'object' || typeof schema.$schema !== 'string') return schema;
    return { ...schema, $schema: JSON_SCHEMA_2020_12 };
}

/** 改写 tools/list 响应中各工具 schema 的方言标识；其余 JSON-RPC 帧原样透传 */
function normalizeToolDialects(message) {
    const tools = message && message.result && message.result.tools;
    if (!Array.isArray(tools)) return message;
    const rewritten = tools.map((tool) => {
        const next = { ...tool, inputSchema: withCurrentDialect(tool.inputSchema) };
        if (tool.outputSchema) next.outputSchema = withCurrentDialect(tool.outputSchema);
        return next;
    });
    return { ...message, result: { ...message.result, tools: rewritten } };
}

async function start() {
    const server = createServer();
    const transport = new StdioServerTransport();
    const send = transport.send.bind(transport);
    transport.send = (message, options) => send(normalizeToolDialects(message), options);
    await server.connect(transport);
    return server;
}

// ==================== 通用工具 ====================

function success(structuredContent) {
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
}

// 入参层面的错误：返回 isError 结果而非抛异常，便于调用方读到中文说明
function failure(message) {
    return { isError: true, content: [{ type: 'text', text: message }] };
}

async function readTextOrEmpty(filePath) {
    try { return await fsp.readFile(filePath, 'utf8'); } catch (err) { return ''; }
}

module.exports = { createServer, start };

if (require.main === module) {
    start().catch((err) => { console.error(`MarkFlow MCP 启动失败：${errText(err)}`); process.exit(1); });
}
