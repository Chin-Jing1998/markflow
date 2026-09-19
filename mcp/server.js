/**
 * MarkFlow MCP stdio 服务
 *
 * stdio 传输下 stdout 被 JSON-RPC 帧独占，因此先把 console 的标准输出通道重定向到 stderr，
 * 防止依赖库的日志污染协议流；此重定向必须在 require 其它模块之前完成。
 * 工具：convert_document（批量转换）、list_formats（能力矩阵）、extract_article（网页只读提取）。
 *
 * 入参 schema 的枚举、取值范围与说明一律取自 converters/options.js 的描述树（经 service.describeOptionHint
 * 与 service.describeOptionSpec 生成，与 CLI 的 --help 同源），不在本文件重复维护取值表；schema 层的拒绝
 * 文案全部中文化（SDK 会把该错误包成 isError 结果返回，不抛到调用方）。
 * 未知入参不再静默丢弃：inputSchema 放行未知键，顶层与段内的未知键记入结果的 ignoredArguments 后剔除。
 * 带 progressToken 调用 convert_document 时，批处理事件转成 notifications/progress（进度单调递增）。
 */
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const path = require('path');
const fsp = require('fs').promises;
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const service = require('../converters/service');
const { OPTION_ENUMS } = require('../converters/options');
const { TARGETS, DIRECTORY_SCAN_EXTENSIONS, resolveUserPath } = require('../converters/targets');
const { expandInputs } = require('../converters/scan');
const { errText, isDirectory } = require('../converters/util');
const pkg = require('../package.json');

const CONCURRENCY = 2;
const MAX_CONTENT_CHARS = 200000;
const DEFAULT_EXTRACT_MAX_CHARS = service.DEFAULT_EXTRACT_MAX_CHARS;
const RETURN_CONTENT_WARNING = 'returnContent 仅对 bundle 目标返回正文';
// 进度通知中每项任务的满分；总分为项数 × 满分
const PROGRESS_PER_TASK = 100;
const PHASE_LABELS = Object.freeze({ parsing: '解析中', rendering: '渲染中', writing: '写入中' });

// ==================== 入参 schema ====================

// 必填与类型错误一律中文化；每处都新建实例（同一 zod 对象复用会被转成 $ref，而 Desktop 客户端不接受 $ref）
const typeMessages = (label, kind) => ({ required_error: `${label} 为必填项`, invalid_type_error: `${label} 须为${kind}` });
const str = (label) => z.string(typeMessages(label, '字符串'));
const bool = (label) => z.boolean(typeMessages(label, '布尔值'));
const num = (label) => z.number(typeMessages(label, '数字'));
const int = (label) => num(label).int(`${label} 须为整数`);
const list = (label, item) => z.array(item, typeMessages(label, '数组'));
// 枚举取值取自 converters/options.js；errorMap 让 schema 层的拒绝也带中文说明
const enumOf = (values, label) => z.enum([...values], {
    errorMap: () => ({ message: `${label} 须为 ${values.join(' | ')} 之一` }),
});
// 顶层数值字段按描述树补 min / max；嵌套字段不补，范围交 options.js 的归一层把关（文案形如「选项 xml.indent 须为…」）
function ranged(label, dotted) {
    const spec = service.describeOptionSpec(dotted);
    const message = `${label} 须为 ${spec.min}–${spec.max} 之间的${spec.integer ? '整数' : '数字'}`;
    const base = spec.integer ? int(label) : num(label);
    return base.min(spec.min, message).max(spec.max, message);
}
// 嵌套段：段内字段全部可选，未知键放行（由 handler 记入 ignoredArguments 后剔除）
const section = (label, shape) => z.object(shape, typeMessages(label, '对象')).partial().passthrough();
// 字段说明：说明文字缺省取描述树中首条路径的说明，再接取值括注（与 CLI 帮助同源），最后可接补充说明
function fieldText(paths, { description, note } = {}) {
    const spec = service.describeOptionSpec(paths[0]);
    const text = description || (spec ? spec.description : '');
    return `${text}${service.describeOptionHint(paths)}${note ? `；${note}` : ''}`;
}

const TARGET_DESCRIPTION = 'bundle=Markdown 知识库包（{名称}/{名称}.md + {名称}.json + {名称}_content_list.json + images/，'
    + 'PDF 走 MinerU 时另有 {名称}_content_list_v2.json、{名称}_model.json、{名称}_layout.json 与 {名称}_origin.pdf，'
    + '对应结果 outputs 中的 md、json、contentList、imagesDir、contentListV2、model、layout、originPdf）；'
    + 'docx | pdf 仅接受 Markdown 与专利五书 XML（.xml、案卷 .zip、五书目录）输入；html | xml 接受全部输入；'
    + '省略则按输入类型取默认目标（Office/PDF/网页 → bundle，Markdown 与专利五书 XML → docx）';
const PATHS_DESCRIPTION = '本地文件或目录的路径列表：建议用绝对路径，也支持 ~ 与 file:// 写法，'
    + '相对路径按 MCP 服务进程的工作目录解析；目录展开为其下受支持的文件（产物平铺在同一 outputDir，'
    + '不保留子目录层级，展开情况见结果的 inputExpansion；.xml 与 .zip 不随目录展开，须显式给出）；'
    + '国知局专利五书可给单个 .xml、案卷 .zip，或整个五书目录（内含 10000N/10000N.xml 或五书 XML，整体作为一项输入），'
    + '多书合并导入为一份文档；'
    + '服务端不预检文件是否存在，缺失项记入结果的 errors（isError 仍为 false），同批其余项照常转换';
const OUTPUT_DIR_DESCRIPTION = '已存在的输出目录：服务端不会创建目录，不存在即返回 isError；'
    + '建议用绝对路径，相对路径按 MCP 服务进程的工作目录解析';
const RETURN_CONTENT_DESCRIPTION = `为 true 时在结果项的 content 中附带生成的 Markdown 正文：仅 bundle 目标返回，`
    + `超过 ${MAX_CONTENT_CHARS} 字符即截断并把 contentTruncated 置为 true；`
    + '其它目标不返回正文，只在该项 warnings 中说明';
const MINERU_DESCRIPTION = 'MinerU 云端解析参数（仅 PDF 输入走 MinerU 时生效）；令牌只取自本机的环境变量 '
    + 'MINERU_TOKEN / MINERU_API_TOKEN、~/.markflow/config.json 或 ~/.mineru/config.yaml，不接受经此传入';

const CONVERT_INPUT_SHAPE = {
    paths: list('paths', str('paths 的每一项')).optional().describe(PATHS_DESCRIPTION),
    urls: list('urls', str('urls 的每一项').url('urls 的每一项须为合法网址')).optional().describe('网页 URL 列表（http / https）'),
    target: enumOf(TARGETS, 'target').optional().describe(TARGET_DESCRIPTION),
    outputDir: str('outputDir').describe(OUTPUT_DIR_DESCRIPTION),
    returnContent: bool('returnContent').optional().describe(RETURN_CONTENT_DESCRIPTION),
    theme: enumOf(OPTION_ENUMS.htmlThemes, 'theme').optional()
        .describe(fieldText(['html.theme', 'pdf.theme'], { description: 'html 与 pdf 目标的主题' })),
    xmlProfile: enumOf(OPTION_ENUMS.xmlProfiles, 'xmlProfile').optional().describe(fieldText(['xml.profile'])),
    patentParts: list('patentParts', enumOf(OPTION_ENUMS.patentParts, 'patentParts 的每一项')).optional()
        .describe(fieldText(['xml.patent.parts'], { note: '省略即按识别结果输出' })),
    pdfBackend: enumOf(OPTION_ENUMS.pdfBackends, 'pdfBackend').optional().describe(fieldText(['pdfBackend'])),
    imageFormat: enumOf(OPTION_ENUMS.imageFormats, 'imageFormat').optional().describe(fieldText(['imageFormat'])),
    jpegQuality: ranged('jpegQuality', 'jpegQuality').optional().describe(fieldText(['jpegQuality'])),
    jpegPpi: ranged('jpegPpi', 'jpegPpi').optional().describe(fieldText(['jpegPpi'])),
    math: enumOf(OPTION_ENUMS.mathModes, 'math').optional().describe(fieldText(['math'])),
    mineru: section('mineru', {
        model: enumOf(OPTION_ENUMS.mineruModels, 'mineru.model').describe(fieldText(['mineru.model'])),
        ocr: bool('mineru.ocr').describe(fieldText(['mineru.ocr'])),
        formula: bool('mineru.formula').describe(fieldText(['mineru.formula'])),
        table: bool('mineru.table').describe(fieldText(['mineru.table'])),
        language: str('mineru.language').describe(fieldText(['mineru.language'])),
        pageRanges: str('mineru.pageRanges').describe(fieldText(['mineru.pageRanges'])),
        timeoutSec: int('mineru.timeoutSec').describe(fieldText(['mineru.timeoutSec'])),
    }).optional().describe(MINERU_DESCRIPTION),
    html: section('html', {
        fontFamily: str('html.fontFamily').describe(fieldText(['html.fontFamily'])),
        fontSize: num('html.fontSize').describe(fieldText(['html.fontSize'])),
        lineHeight: num('html.lineHeight').describe(fieldText(['html.lineHeight'])),
        contentWidth: int('html.contentWidth').describe(fieldText(['html.contentWidth'])),
        spacing: enumOf(OPTION_ENUMS.spacing, 'html.spacing').describe(fieldText(['html.spacing'])),
        inlineImages: bool('html.inlineImages').describe(fieldText(['html.inlineImages'])),
    }).optional().describe('html 目标参数：字体栈、字号（px）、行高、栏宽（px）、段距与图片内联；'
        + 'pdf 目标同样以本段排版，只有主题另取 pdf.theme'),
    pdf: section('pdf', {
        pageSize: enumOf(OPTION_ENUMS.pageSizes, 'pdf.pageSize').describe(fieldText(['pdf.pageSize'])),
        landscape: bool('pdf.landscape').describe(fieldText(['pdf.landscape'])),
    }).optional().describe('pdf 目标参数：纸张与横向'),
    docx: section('docx', {
        pageSize: enumOf(OPTION_ENUMS.pageSizes, 'docx.pageSize').describe(fieldText(['docx.pageSize'])),
        fontSize: num('docx.fontSize').describe(fieldText(['docx.fontSize'])),
        fontAscii: str('docx.fontAscii').describe(fieldText(['docx.fontFamily.ascii'])),
        fontEastAsia: str('docx.fontEastAsia').describe(fieldText(['docx.fontFamily.eastAsia'])),
    }).optional().describe('docx 目标参数：纸张、正文字号（pt）与中西文字体'),
    xml: section('xml', {
        indent: int('xml.indent').describe(fieldText(['xml.indent'])),
        numberingStart: int('xml.numberingStart').describe(fieldText(['xml.numbering.start'])),
        numberingWidth: int('xml.numberingWidth').describe(fieldText(['xml.numbering.width'])),
        imageDpi: int('xml.imageDpi').describe(fieldText(['xml.patent.imageDpi'], { note: '仅 patent profile' })),
        sectionDetection: enumOf(OPTION_ENUMS.sectionDetection, 'xml.sectionDetection')
            .describe(fieldText(['xml.patent.sectionDetection'], { note: '仅 patent profile' })),
        rasterizeTables: bool('xml.rasterizeTables').describe(fieldText(['xml.patent.rasterizeTables'], { note: '仅 patent profile' })),
        rasterizeFormulas: bool('xml.rasterizeFormulas').describe(fieldText(['xml.patent.rasterizeFormulas'], { note: '仅 patent profile' })),
    }).optional().describe('xml 目标参数：缩进与说明书段号，以及 patent profile 的图片密度、分节识别与表格、公式栅格化'),
    xmlImport: section('xmlImport', {
        paragraphNumbers: bool('xmlImport.paragraphNumbers').describe(fieldText(['xmlImport.paragraphNumbers'])),
    }).optional().describe('专利五书 XML 反向导入参数（仅 .xml、案卷 .zip 与五书目录输入生效）'),
    raster: section('raster', {
        scale: num('raster.scale').describe(fieldText(['raster.scale'])),
        maxWidth: int('raster.maxWidth').describe(fieldText(['raster.maxWidth'])),
    }).optional().describe('栅格化参数（patent profile 下忽略）'),
    validate: bool('validate').optional().describe(fieldText(['xml.validate'], {
        description: 'xml 目标：渲染后用官方 DTD 校验（patent）或检查 well-formed（generic），结果写入 warnings',
    })),
    clean: bool('clean').optional()
        .describe('为 true 时在写入前清理产物目录中本工具生成的旧产物（images/、主产物、旁路 JSON、专利五书与其图片）；'
            + '用户放入该目录的其它文件一律保留。与 skipExisting 同为 true 时以跳过为准'),
    skipExisting: bool('skipExisting').optional()
        .describe('为 true 时主产物已存在即跳过该项：不解析、不改动任何文件，结果项带 skipped: true'),
};
// 未知键放行（passthrough）：由 handler 记入 ignoredArguments，而不是静默丢弃
const CONVERT_INPUT = z.object(CONVERT_INPUT_SHAPE, {
    required_error: 'convert_document 需要入参对象（至少包含 outputDir）',
    invalid_type_error: 'convert_document 的入参须为对象',
}).passthrough();

// 入参中交给 service.buildOptions 的键；其余（paths/urls/target/outputDir/returnContent）由本文件自行处理
const OPTION_ARG_KEYS = Object.freeze([
    'theme', 'xmlProfile', 'patentParts', 'pdfBackend', 'imageFormat', 'jpegQuality', 'jpegPpi', 'math',
    'mineru', 'html', 'pdf', 'docx', 'xml', 'xmlImport', 'raster', 'validate',
]);
// 本工具认得的入参键与各嵌套段认得的字段：其余一律记入 ignoredArguments
const CONVERT_ARG_KEYS = Object.freeze(Object.keys(CONVERT_INPUT_SHAPE));
const SECTION_KEYS = Object.freeze(['mineru', 'html', 'pdf', 'docx', 'xml', 'xmlImport', 'raster']);
const SECTION_FIELDS = Object.freeze(Object.fromEntries(
    SECTION_KEYS.map((key) => [key, Object.freeze(Object.keys(CONVERT_INPUT_SHAPE[key].unwrap().shape))]),
));

// ==================== 出参 schema ====================

const RESULT_ITEM = z.object({
    // title 为 null 的唯一情形：skipExisting 命中时未解析文档，故拿不到标题
    input: z.string(), target: z.string(), name: z.string(), title: z.string().nullable(), sourceType: z.string(),
    outputPath: z.string(), outputs: z.record(z.string()), imagesCount: z.number(), warnings: z.array(z.string()),
    options: z.record(z.any()), extras: z.array(z.string()),
    backends: z.object({ pdfParser: z.string().nullable(), raster: z.string().nullable() }),
    content: z.string().optional(),
    contentTruncated: z.boolean().optional(),
    skipped: z.boolean().optional(),
});
const CONVERT_OUTPUT = {
    ok: z.boolean(), outputDir: z.string(), results: z.array(RESULT_ITEM),
    errors: z.array(z.object({ input: z.string(), error: z.string(), cancelled: z.boolean().optional() })),
    validate: z.boolean().optional(),
    ignoredArguments: z.array(z.string()).optional(),
    inputExpansion: z.object({
        directories: z.array(z.object({ path: z.string(), count: z.number() })),
        skipped: z.array(z.string()),
        truncated: z.boolean(),
    }).optional(),
};
// 后端探测结果；每处调用都新建一份 schema：同一 zod 对象复用两次会被转成 $ref，而 Desktop 客户端不接受 $ref
const backendStatus = () => z.object({ name: z.string().nullable(), available: z.boolean(), hint: z.string() });
const CAPABILITIES = z.object({
    pdfBackend: backendStatus(),
    raster: backendStatus(),
    mineru: z.object({ configured: z.boolean(), source: z.string().nullable() }),
    validator: backendStatus(),
    libreoffice: backendStatus(),
    themes: z.array(z.string()),
    xmlProfiles: z.array(z.string()),
});
const FORMATS_OUTPUT = {
    targets: z.record(z.any()), capabilities: CAPABILITIES, extensions: z.array(z.string()), version: z.string(),
};

const EXTRACT_INPUT = {
    url: str('url').url('url 须为合法网址').describe('网页地址（http / https）'),
    maxChars: int('maxChars').positive('maxChars 须为正整数').optional()
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

// ==================== 工具实现 ====================

async function handleConvertDocument(args = {}, extra = {}) {
    const raws = [...(Array.isArray(args.paths) ? args.paths : []), ...(Array.isArray(args.urls) ? args.urls : [])];
    if (raws.length === 0) return failure('paths 与 urls 至少提供一项');
    // outputDir 与输入一样支持 ~ 与 file:// 写法；相对路径按服务进程的工作目录解析
    let outputDir;
    try {
        outputDir = typeof args.outputDir === 'string' ? resolveUserPath(args.outputDir) : '';
    } catch (err) {
        return failure(errText(err));
    }
    if (!(await isDirectory(outputDir))) return failure(`输出目录不存在或不是目录：${outputDir}`);
    const { known, ignored } = collectArguments(args);

    // 目录就地展开为其下受支持的文件（产物平铺在同一 outputDir，不保留子目录层级）；未给目录时逐项与入参相同
    const expansion = await expandInputs(raws, { cwd: process.cwd() });
    if (expansion.inputs.length === 0) {
        return failure(`输入目录中没有可转换的文件（目录展开受理：${DIRECTORY_SCAN_EXTENSIONS.join(' ')}；.xml 与 .zip 须显式给出）`);
    }

    // 选项按本批目标校验，故先规划任务
    let tasks;
    try {
        tasks = service.planTasks(expansion.inputs, args.target, process.cwd(), { bundles: expansion.bundles });
    } catch (err) {
        return failure(errText(err));
    }

    // 取值范围与中文错误文案由 converters/options.js 的归一层给出，此处只把失败转成 isError 结果
    let options;
    try {
        options = service.buildOptions(pickDefined(known, OPTION_ARG_KEYS), { targets: tasks.map((task) => task.target) });
    } catch (err) {
        return failure(errText(err));
    }

    const payload = await service.runConversion({
        tasks, outputDir, concurrency: CONCURRENCY, options, onEvent: createProgressReporter(extra, tasks),
        // 调用方取消请求（或连接断开）后不再领取新任务，已在运行的跑完；未领取的以「已取消」记入 errors。
        // 注意：按 MCP 协议，取消后服务端不再回响应，故该信封只在未被取消时送达调用方
        signal: extra ? extra.signal : undefined,
        clean: args.clean, skipExisting: args.skipExisting,
    });
    const results = await Promise.all(payload.results.map((item) => withContent(item, args.returnContent)));
    return success({
        ...payload,
        results,
        // validate 已作为 xml.validate 进入 options，信封上另留标记，与命令行 --json 一致
        ...(args.validate === true ? { validate: true } : {}),
        ...(ignored.length > 0 ? { ignoredArguments: ignored } : {}),
        ...expansionEnvelope(expansion),
    }, { compact: true });
}

async function handleListFormats() {
    return success(await service.describeFormats());
}

/** 网页只读提取：实现在服务层（与 CLI 的 extract 子命令共用），此处只做协议信封 */
async function handleExtractArticle(args = {}) {
    try {
        return success(await service.extractArticle({ url: args.url, maxChars: args.maxChars }));
    } catch (err) {
        return failure(errText(err));
    }
}

/**
 * 入参分流：未知的顶层键与段内未知字段记入 ignored（段内形如 html.colour），并从交给 buildOptions 的对象中剔除。
 * ignored 排序后返回，与入参书写顺序无关。
 */
function collectArguments(args) {
    const known = {};
    const ignored = [];
    for (const [key, value] of Object.entries(args)) {
        if (!CONVERT_ARG_KEYS.includes(key)) { ignored.push(key); continue; }
        const fields = SECTION_FIELDS[key];
        if (!fields || !isPlainObject(value)) { known[key] = value; continue; }
        const kept = {};
        for (const [field, fieldValue] of Object.entries(value)) {
            if (fields.includes(field)) kept[field] = fieldValue;
            else ignored.push(`${key}.${field}`);
        }
        known[key] = kept;
    }
    return { known, ignored: [...ignored].sort() };
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// 目录展开情况：确实给了目录（或有跳过项、触达上限）时才作为新增字段写入信封，既有字段不变
function expansionEnvelope({ directories, skipped, truncated }) {
    if (directories.length === 0 && skipped.length === 0 && !truncated) return {};
    return { inputExpansion: { directories, skipped, truncated } };
}

// 只挑出调用方确实给了的键；未给出的不进 buildOptions，由 options.js 补默认值
function pickDefined(source, keys) {
    return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

/**
 * 进度通知：带 progressToken 时把 runBatch 的事件转成 notifications/progress——progress 为各项进度之和
 * （每项满分 PROGRESS_PER_TASK），total 为项数 × 满分，只在总和增加时发送，故严格单调递增；
 * 转换中的百分比封顶到满分减一，留出末条「完成」。不带 progressToken 返回 undefined，行为与此前一致。
 */
function createProgressReporter(extra, tasks) {
    const token = extra && extra._meta ? extra._meta.progressToken : undefined;
    if (token === undefined || token === null || typeof extra.sendNotification !== 'function') return undefined;
    const total = tasks.length * PROGRESS_PER_TASK;
    const done = new Map();
    let sent = 0;
    return (event) => {
        if (!event || typeof event.idx !== 'number') return;
        const pct = progressOf(event);
        if (pct === null) return;
        done.set(event.idx, Math.max(done.get(event.idx) || 0, pct));
        const progress = [...done.values()].reduce((sum, value) => sum + value, 0);
        if (progress <= sent) return;
        sent = progress;
        const message = `[${event.idx + 1}/${tasks.length}] ${displayName(tasks[event.idx])}：${phaseLabel(event)}`;
        // 通知发送失败（连接已断开）不影响转换本身
        extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken: token, progress, total, message },
        }).catch(() => {});
    };
}

// start 不占进度；转换中的百分比封顶到满分减一；单项结束（成功或失败）即满分
function progressOf(event) {
    if (event.type === 'item') return PROGRESS_PER_TASK;
    if (event.type === 'progress' && Number.isFinite(event.pct)) {
        return Math.min(Math.max(event.pct, 0), PROGRESS_PER_TASK - 1);
    }
    return null;
}

const phaseLabel = (event) => {
    if (event.type === 'item') return event.ok ? '完成' : '失败';
    return PHASE_LABELS[event.phase] || '处理中';
};

const displayName = (task) => (task.input.path ? path.basename(task.input.path) : task.raw);

// returnContent 为 true 时附带正文：只有 bundle 目标有 Markdown 产物，其它目标只在 warnings 中说明
async function withContent(item, returnContent) {
    if (!returnContent) return item;
    if (item.target !== 'bundle' || !item.outputs.md) {
        return { ...item, warnings: [...item.warnings, RETURN_CONTENT_WARNING] };
    }
    const text = await readTextOrEmpty(item.outputs.md);
    const truncated = text.length > MAX_CONTENT_CHARS;
    return { ...item, content: truncated ? text.slice(0, MAX_CONTENT_CHARS) : text, contentTruncated: truncated };
}

// ==================== 服务装配 ====================

const SERVER_INSTRUCTIONS = [
    'MarkFlow 文档转换服务：把本地办公文档、PDF、Markdown 与网页转成 Markdown 知识库包、DOCX、PDF、HTML 或 XML。',
    '国知局专利五书 XML 可反向导入为可再编辑的 Word：paths 给单个 .xml、案卷 .zip 或五书目录，target 省略即 docx；'
        + '导入时丢失或改写的信息以「导入：」开头记入该项 warnings。',
    'convert_document 的 outputDir 必须是已存在的目录（服务端不创建目录）；paths 建议用绝对路径，'
        + '相对路径按服务进程的工作目录解析。输入文件不预检：缺失项记入结果的 errors，不会让整批失败。',
    'PDF 输入的 pdfBackend 缺省为 auto：本机取得 MinerU 令牌时走 MinerU 云端解析（按量计费，且会上传文件）；'
        + '只要文本层或必须留在本机时，传 pdfBackend:"local"。',
    '只需要网页正文、不需要落盘时用 extract_article（不下载图片、不写任何文件）；需要图片与产物文件时才用 convert_document。',
    'list_formats 报告可用目标、主题、XML profile、受理扩展名与本机后端状态，拿不准时可先调用。',
    '批量或 PDF 转换可能超过客户端默认的请求超时，调用时带上 progressToken 即可收到进度通知。',
].join('\n');

function createServer() {
    const server = new McpServer({ name: 'markflow', version: pkg.version }, { instructions: SERVER_INSTRUCTIONS });
    server.registerTool('convert_document', {
        title: '转换文档',
        description: '把本地办公文档、PDF、Markdown、国知局专利五书 XML（.xml、案卷 .zip、五书目录）或网页转换为 Markdown 包（bundle）、DOCX、PDF、HTML 或 XML；'
            + '可指定主题、XML profile、图片与公式处理方式以及 MinerU 解析参数，省略的选项取默认值。'
            + '产物写入 outputDir（同名产物覆盖），返回结构与命令行 markflow convert --json 一致。',
        inputSchema: CONVERT_INPUT,
        outputSchema: CONVERT_OUTPUT,
        annotations: { destructiveHint: true, openWorldHint: true },
    }, handleConvertDocument);
    server.registerTool('extract_article', {
        title: '提取网页正文',
        description: '抓取网页并只返回提取后的 Markdown 正文与元数据，不下载图片、不写任何文件。',
        inputSchema: EXTRACT_INPUT,
        outputSchema: EXTRACT_OUTPUT,
        annotations: { readOnlyHint: true },
    }, handleExtractArticle);
    // list_formats 不声明 inputSchema：SDK 会给出空对象 schema，且允许调用方省略 arguments
    server.registerTool('list_formats', {
        title: '列出可用格式',
        description: '返回输入类型与转换目标的对应矩阵、受理的扩展名、可选主题与 XML profile，'
            + '以及本机 PDF 后端、栅格化后端、DTD 校验器、LibreOffice 与 MinerU 令牌的状态。',
        outputSchema: FORMATS_OUTPUT,
        annotations: { readOnlyHint: true },
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

// 转换结果用紧凑 JSON（正文可能很长），其余工具保持缩进便于人读；两者的 text 都与 structuredContent 同源
function success(structuredContent, { compact = false } = {}) {
    const text = compact ? JSON.stringify(structuredContent) : JSON.stringify(structuredContent, null, 2);
    return { content: [{ type: 'text', text }], structuredContent };
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
