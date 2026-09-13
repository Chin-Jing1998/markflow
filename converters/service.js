/**
 * CLI、MCP 与桌面端共用的服务层
 *
 * 各入口对外承诺同一套结果结构（README：MCP「返回结构同命令行的 --json」），
 * 故能力探测、选项映射、任务规划、批处理与结果信封统一在此实现，入口只做各自的表示层：
 * CLI 负责参数解析、人类可读输出与退出码，MCP 负责 schema 与协议信封，桌面端负责 IPC。
 *
 * probeCapabilities() → { pdfBackend, raster, mineru: { configured, source }, themes, xmlProfiles }（绝不含令牌本身）
 * describeFormats()   → { targets, capabilities, version }
 * buildOptions(flat)  → 归一冻结后的 options：把 CLI/MCP 的扁平参数（theme、xmlProfile、jpegQuality…）与
 *                       嵌套段（html{…}、xml{…}…，段内支持 numberingStart、fontAscii 一类扁平别名）映射为
 *                       converters/options.js 的结构；未知键忽略，非法值抛中文错误
 * planTasks(raws, requestedTarget, cwd) → [{ raw, input, target }]，任一项不合法即抛中文错误
 * runConversion({ tasks, outputDir, concurrency, onEvent, options }) → { ok, outputDir, results, errors }
 *
 * 能力探测与转换均按需 require 重模块，保持 require('./service') 本身轻量。
 */
const { convert, listTargets, runBatch } = require('./index');
const { createNameRegistry } = require('./naming');
const { resolveTarget, classifyInput } = require('./targets');
const { normalizeOptions, OPTION_ENUMS } = require('./options');
const { getMineruToken } = require('./config');
const { errText } = require('./util');
const pkg = require('../package.json');

const DEFAULT_CONCURRENCY = 2;

// ============================================================
// 能力探测
// ============================================================

/** 运行时能力探测：PDF 后端、栅格化后端、MinerU 令牌是否已配置（只报来源，不报令牌） */
async function probeCapabilities() {
    const [pdfBackend, raster, mineru] = await Promise.all([
        require('./pdf/backend').detect(),
        probeRaster(),
        probeMineru(),
    ]);
    return {
        pdfBackend, raster, mineru,
        themes: [...OPTION_ENUMS.htmlThemes],
        xmlProfiles: [...OPTION_ENUMS.xmlProfiles],
    };
}

async function probeRaster() {
    const result = await require('./raster/backend').detect();
    return {
        name: result && typeof result.name === 'string' ? result.name : null,
        available: Boolean(result && result.available),
        hint: result && typeof result.hint === 'string' ? result.hint : '',
    };
}

async function probeMineru() {
    const { token, source } = await getMineruToken();
    return { configured: Boolean(token), source: token ? source : null };
}

/** 能力矩阵 + 版本号，CLI 的 formats 与 MCP 的 list_formats 同源 */
async function describeFormats() {
    const capabilities = await probeCapabilities();
    const targets = listTargets({ pdfBackend: capabilities.pdfBackend.available ? capabilities.pdfBackend : null });
    return { targets, capabilities, version: pkg.version };
}

// ============================================================
// 选项映射
// ============================================================

const asString = (value, key) => {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    throw new Error(`参数 ${key} 须为字符串`);
};
const asNumber = (value, key) => {
    const parsed = typeof value === 'number' ? value : Number(String(value).trim());
    if (typeof value === 'boolean' || String(value).trim() === '' || !Number.isFinite(parsed)) {
        throw new Error(`参数 ${key} 须为数字，实际：${String(value)}`);
    }
    return parsed;
};
const BOOLEAN_WORDS = Object.freeze({ true: true, 1: true, yes: true, on: true, false: false, 0: false, no: false, off: false });
const asBoolean = (value, key) => {
    if (typeof value === 'boolean') return value;
    const word = String(value).trim().toLowerCase();
    if (word in BOOLEAN_WORDS) return BOOLEAN_WORDS[word];
    throw new Error(`参数 ${key} 须为布尔值（true/false），实际：${String(value)}`);
};
// 'auto' | 数组 | 逗号/顿号/空白分隔的字符串
const asParts = (value, key) => {
    if (Array.isArray(value)) return value.map((item) => asString(item, key));
    const text = asString(value, key);
    if (text === 'auto') return 'auto';
    return text.split(/[,，、\s]+/).map((item) => item.trim()).filter(Boolean);
};

// 扁平参数 → 嵌套路径的映射表；同一扁平键可落到多条路径（theme 同时作用于 html 与 pdf 目标）
const FLAT_MAP = Object.freeze([
    ['theme', ['html.theme', 'pdf.theme'], asString],
    ['xmlProfile', ['xml.profile'], asString],
    ['patentParts', ['xml.patent.parts'], asParts],
    ['pdfBackend', ['pdfBackend'], asString],
    ['imageFormat', ['imageFormat'], asString],
    ['jpegQuality', ['jpegQuality'], asNumber],
    ['math', ['math'], asString],
    ['mineruModel', ['mineru.model'], asString],
    ['mineruOcr', ['mineru.ocr'], asBoolean],
    ['mineruFormula', ['mineru.formula'], asBoolean],
    ['mineruTable', ['mineru.table'], asBoolean],
    ['mineruLang', ['mineru.language'], asString],
    ['mineruTimeout', ['mineru.timeoutSec'], asNumber],
    ['mineruToken', ['mineru.token'], asString],
    ['pageRanges', ['mineru.pageRanges'], asString],
    ['font', ['html.fontFamily'], asString],
    ['fontSize', ['html.fontSize', 'docx.fontSize'], asNumber],
    ['lineHeight', ['html.lineHeight'], asNumber],
    ['contentWidth', ['html.contentWidth'], asNumber],
    ['spacing', ['html.spacing'], asString],
    ['inlineImages', ['html.inlineImages'], asBoolean],
    ['pageSize', ['pdf.pageSize', 'docx.pageSize'], asString],
    ['landscape', ['pdf.landscape'], asBoolean],
    ['validate', ['xml.validate'], asBoolean],
    ['xmlIndent', ['xml.indent'], asNumber],
    ['numberingStart', ['xml.numbering.start'], asNumber],
    ['numberingWidth', ['xml.numbering.width'], asNumber],
    ['rasterizeTables', ['xml.patent.rasterizeTables'], asBoolean],
    ['rasterizeFormulas', ['xml.patent.rasterizeFormulas'], asBoolean],
    ['imageDpi', ['xml.patent.imageDpi'], asNumber],
    ['sectionDetection', ['xml.patent.sectionDetection'], asString],
    ['rasterScale', ['raster.scale'], asNumber],
    ['rasterMaxWidth', ['raster.maxWidth'], asNumber],
]);
// 嵌套段直接深合并（MCP 的 html{…} / docx{…} / mineru{…} 等）
const NESTED_KEYS = Object.freeze(['mineru', 'html', 'pdf', 'docx', 'xml', 'raster']);
// 段内允许的扁平别名：MCP schema 用 xml{numberingStart} / docx{fontAscii} 这类一层写法表达嵌套字段，
// 以免 z.object 再套一层（嵌套越深越容易被 zod 转成 $ref，而 Desktop 客户端不接受 $ref）
const SECTION_ALIASES = Object.freeze({
    xml: Object.freeze({ numberingStart: 'numbering.start', numberingWidth: 'numbering.width' }),
    docx: Object.freeze({ fontAscii: 'fontFamily.ascii', fontEastAsia: 'fontFamily.eastAsia' }),
});

/** 扁平参数 → 归一冻结的 options；未定义、null 与空串视为未给出 */
function buildOptions(flat = {}) {
    if (flat === null || typeof flat !== 'object' || Array.isArray(flat)) throw new Error('buildOptions 需要对象形式的参数');
    const nested = {};
    for (const [key, targets, coerce] of FLAT_MAP) {
        const value = flat[key];
        if (value === undefined || value === null || value === '') continue;
        const converted = coerce(value, key);
        for (const target of targets) setPath(nested, target, converted);
    }
    for (const key of NESTED_KEYS) {
        const section = flat[key];
        if (section === undefined || section === null) continue;
        if (typeof section !== 'object' || Array.isArray(section)) throw new Error(`参数 ${key} 须为对象`);
        const patch = SECTION_ALIASES[key] ? expandAliases(section, SECTION_ALIASES[key]) : section;
        setPath(nested, key, mergeDeep(getPath(nested, key), patch));
    }
    return normalizeOptions(nested);
}

function expandAliases(section, aliases) {
    const out = {};
    for (const [key, value] of Object.entries(section)) {
        if (key in aliases) setPath(out, aliases[key], value);
        else out[key] = value;
    }
    return out;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function mergeDeep(base, patch) {
    if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) out[key] = mergeDeep(out[key], value);
    return out;
}

function setPath(obj, dotted, value) {
    const keys = dotted.split('.');
    let node = obj;
    for (const key of keys.slice(0, -1)) {
        if (!isPlainObject(node[key])) node[key] = {};
        node = node[key];
    }
    node[keys[keys.length - 1]] = value;
}

function getPath(obj, dotted) {
    return dotted.split('.').reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), obj);
}

// ============================================================
// 任务规划与执行
// ============================================================

/** 归类输入并裁决目标；不触碰文件系统，存在性由调用方或 convert 负责 */
function planTasks(raws, requestedTarget, cwd) {
    return raws.map((raw) => {
        const { input, type } = classifyInput(raw, cwd);
        return { raw, input, target: resolveTarget(type, requestedTarget) };
    });
}

/** 执行批量转换并生成各入口共用的结果信封；options 原样透传 convert（省略即全默认） */
async function runConversion({ tasks, outputDir, concurrency = DEFAULT_CONCURRENCY, onEvent, options } = {}) {
    // 每批一张产物名登记表：批内派生出同名产物的任务依次改名（sample、sample (pptx)、sample (2)），
    // 不再互相覆盖；登记表不跨批次留存，故单独重复转换同一输入仍覆盖同名产物、保持幂等
    const nameRegistry = createNameRegistry();
    // 批内序号：runBatch 同步领号后随即调用任务函数，故第 k 次调用对应 tasks[k]，计数器即任务序。
    // 登记按该序号排队，最终名与各任务解析完成的先后无关；任务失败时放行后续，避免整批卡住
    let nextOrder = 0;
    const runTask = (task, onProgress) => {
        const order = nextOrder;
        nextOrder += 1;
        return convert({ input: task.input, target: task.target, outputDir, onProgress, options, nameRegistry, order })
            .catch((error) => {
                nameRegistry.release(order);
                throw error;
            });
    };
    const { results, errors } = await runBatch(tasks, { concurrency, onEvent }, runTask);
    return {
        ok: errors.length === 0,
        outputDir,
        results: results.map(({ idx, result }) => describeResult(tasks[idx].raw, result)),
        errors: errors.map(({ idx, error }) => ({ input: tasks[idx].raw, error: errText(error) })),
    };
}

/** 单项结果的对外形状；MCP 在此基础上按 returnContent 追加 content 字段 */
function describeResult(input, result) {
    return {
        input,
        target: result.target,
        name: result.name,
        title: result.title,
        sourceType: result.sourceType,
        outputPath: result.outputPath,
        outputs: result.outputs || {},
        imagesCount: result.imagesCount,
        warnings: result.warnings || [],
        options: result.options || {},
        extras: result.extras || [],
        backends: result.backends || { pdfParser: null, raster: null },
    };
}

module.exports = { probeCapabilities, describeFormats, buildOptions, planTasks, runConversion, DEFAULT_CONCURRENCY };
