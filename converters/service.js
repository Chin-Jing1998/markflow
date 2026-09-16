/**
 * CLI、MCP 与桌面端共用的服务层
 *
 * 各入口对外承诺同一套结果结构（README：MCP「返回结构同命令行的 --json」），
 * 故能力探测、选项映射、任务规划、批处理、结果信封与网页正文提取统一在此实现，入口只做各自的表示层：
 * CLI 负责参数解析、人类可读输出与退出码，MCP 负责 schema 与协议信封，桌面端负责 IPC。
 *
 * probeCapabilities() → { pdfBackend, raster, mineru: { configured, source }, validator, libreoffice, themes, xmlProfiles }
 *                       绝不含令牌本身；validator 为 DTD 校验器（可选依赖 libxml2-wasm，探测要加载 wasm，故结果在
 *                       进程内缓存，测试可用 _setValidatorProbe 注入、_resetProbeCache 复位），libreoffice 为非必需
 *                       的兜底（其探测由 converters/soffice.js 自行缓存），二者与 raster 同形：{ name, available, hint }，
 *                       不报本机安装路径
 * describeFormats()   → { targets, capabilities, extensions, version }；extensions 为受理的输入扩展名清单
 * buildOptions(flat, { targets }?) → 归一冻结后的 options：把 CLI/MCP 的扁平参数（theme、xmlProfile、jpegQuality…）与
 *                       嵌套段（html{…}、xml{…}…，段内支持 numberingStart、fontAscii、imageDpi 一类扁平别名）映射为
 *                       converters/options.js 的结构；未知键忽略，非法值抛中文错误。
 *                       targets 为本批目标（数组或 Set）时，扁平键落到不属于本批目标的段且取值不合法的，跳过写入、
 *                       保留默认值（段与目标的对应见 SECTION_TARGETS）；属于本批目标的段、与目标无关的键（顶层、mineru、
 *                       raster）以及嵌套段照常校验；省略 targets 即全部校验
 * describeOptionSpec(dotted) → describeOptions() 描述树中的节点，未知路径返回 null
 * describeOptionHint(paths)  → 取值说明「（可选 …；默认 …）」，CLI 帮助与 MCP 入参描述同源：多条路径取值相同则合并、
 *                       默认值不同逐段列出，取值不同则逐段列范围与默认；未知路径抛中文错误
 * planTasks(raws, requestedTarget, cwd) → [{ raw, input, target }]，任一项不合法即抛中文错误
 * runConversion({ tasks, outputDir, concurrency, onEvent, options }) → { ok, outputDir, results, errors }
 * extractArticle({ url, maxChars }) → { url, finalUrl, title, author?, publishedAt?, siteName?, excerpt?, lang?,
 *                       wordCount, extraction, markdown, truncated, images }：网页只读提取，不落盘、不下载图片（图片只列
 *                       原始地址）；markdown 超过 maxChars（缺省或非正整数时取 DEFAULT_EXTRACT_MAX_CHARS）即截断并置
 *                       truncated，wordCount 仍按全文；取不到的元数据字段整条省略；失败抛中文错误。
 *                       CLI 的 extract 子命令与 MCP 的 extract_article 共用本实现
 *
 * 能力探测、转换与提取均按需 require 重模块，保持 require('./service') 本身轻量。
 */
const { convert, listTargets, runBatch } = require('./index');
const { createNameRegistry } = require('./naming');
const { resolveTarget, classifyInput, SUPPORTED_EXTENSIONS } = require('./targets');
const { normalizeOptions, describeOptions, OPTION_ENUMS } = require('./options');
const { getMineruToken } = require('./config');
const { errText } = require('./util');
const pkg = require('../package.json');

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_EXTRACT_MAX_CHARS = 50000;
// 取不到即整条省略的网页元数据字段
const EXTRACT_OPTIONAL_META = Object.freeze(['author', 'publishedAt', 'siteName', 'excerpt', 'lang']);
// 探测 DTD 校验器时走一次 well-formed 检查所用的最小文档
const VALIDATOR_PROBE_XML = '<probe/>';
const VALIDATOR_NAME = 'libxml2-wasm';
const LIBREOFFICE_NAME = 'soffice';
const LIBREOFFICE_ROLE = '非必需，仅作 PDF 出图的第三级后端与 patent profile 下 EMF/WMF 栅格化的兜底';

// ============================================================
// 能力探测
// ============================================================

/** 运行时能力探测：PDF 后端、栅格化后端、MinerU 令牌是否已配置（只报来源，不报令牌）、DTD 校验器与 LibreOffice */
async function probeCapabilities() {
    const [pdfBackend, raster, mineru, validator, libreoffice] = await Promise.all([
        require('./pdf/backend').detect(),
        probeRaster(),
        probeMineru(),
        probeValidator(),
        probeLibreOffice(),
    ]);
    return {
        pdfBackend, raster, mineru, validator, libreoffice,
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

/**
 * DTD 校验器是否可用取决于可选依赖 libxml2-wasm 是否安装，进程生命周期内不会变，而探测要加载 wasm；
 * 桌面端启动即调 describeFormats，故在进程内缓存首次结果（缓存的是 Promise，并发调用也只探测一次）。
 * CLI 与 MCP 每次调用都是新进程，不受缓存影响；测试可用 _setValidatorProbe 注入、_resetProbeCache 复位。
 */
let validatorProbe = probeValidatorOnce;
let validatorPromise = null;

function probeValidator() {
    if (!validatorPromise) validatorPromise = Promise.resolve(validatorProbe());
    return validatorPromise;
}

/** 测试注入：替换校验器探测实现并清空缓存 */
function _setValidatorProbe(fn) {
    validatorProbe = typeof fn === 'function' ? fn : probeValidatorOnce;
    validatorPromise = null;
}

/** 测试复位：回到真实探测并清空缓存 */
function _resetProbeCache() {
    validatorProbe = probeValidatorOnce;
    validatorPromise = null;
}

// 以最小文档走一次 well-formed 检查，与 --validate 同一条加载路径，未安装时带回安装提示
async function probeValidatorOnce() {
    try {
        const result = await require('./renderers/xml/validate').validateXml(VALIDATOR_PROBE_XML, { requireDtd: false });
        if (result.available) return { name: VALIDATOR_NAME, available: true, hint: '' };
        return { name: null, available: false, hint: typeof result.hint === 'string' ? result.hint : '' };
    } catch (err) {
        return { name: null, available: false, hint: `DTD 校验器探测失败：${errText(err)}` };
    }
}

// LibreOffice 非必需：只报是否可用（不报本机路径），不可用时写明其用途与安装方式
async function probeLibreOffice() {
    const soffice = require('./soffice');
    if (await soffice.detectSoffice()) return { name: LIBREOFFICE_NAME, available: true, hint: '' };
    return { name: null, available: false, hint: `${LIBREOFFICE_ROLE}；${soffice.getInstallHint()}` };
}

/** 能力矩阵 + 受理扩展名 + 版本号，CLI 的 formats 与 MCP 的 list_formats 同源 */
async function describeFormats() {
    const capabilities = await probeCapabilities();
    const targets = listTargets({ pdfBackend: capabilities.pdfBackend.available ? capabilities.pdfBackend : null });
    return { targets, capabilities, extensions: [...SUPPORTED_EXTENSIONS], version: pkg.version };
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

// 扁平参数 → 嵌套路径的映射表；同一扁平键可落到多条路径（theme 同时作用于 html 与 pdf 目标）；
// 表序即写入顺序，后写者覆盖同一路径上的先写者
const FLAT_MAP = Object.freeze([
    ['theme', ['html.theme', 'pdf.theme'], asString],
    ['xmlProfile', ['xml.profile'], asString],
    ['patentParts', ['xml.patent.parts'], asParts],
    ['pdfBackend', ['pdfBackend'], asString],
    ['imageFormat', ['imageFormat'], asString],
    ['jpegQuality', ['jpegQuality'], asNumber],
    ['jpegPpi', ['jpegPpi'], asNumber],
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
    // docx 专属：排在 fontSize 之后，二者同给时以 docxFontSize 为准
    ['docxFontSize', ['docx.fontSize'], asNumber],
    ['fontAscii', ['docx.fontFamily.ascii'], asString],
    ['fontEastAsia', ['docx.fontFamily.eastAsia'], asString],
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
    xml: Object.freeze({
        numberingStart: 'numbering.start',
        numberingWidth: 'numbering.width',
        imageDpi: 'patent.imageDpi',
        sectionDetection: 'patent.sectionDetection',
        rasterizeTables: 'patent.rasterizeTables',
        rasterizeFormulas: 'patent.rasterizeFormulas',
    }),
    docx: Object.freeze({ fontAscii: 'fontFamily.ascii', fontEastAsia: 'fontFamily.eastAsia' }),
});
// 与目标绑定的选项段 → 用到该段的目标。pdf 渲染器以 html 段排版（仅主题换成 pdf.theme），故 html 段同属 pdf 目标；
// 未列出的段（mineru、raster）与顶层键不绑定目标，始终校验
const SECTION_TARGETS = Object.freeze({
    html: Object.freeze(['html', 'pdf']),
    pdf: Object.freeze(['pdf']),
    docx: Object.freeze(['docx']),
    xml: Object.freeze(['xml']),
});

/** 扁平参数 → 归一冻结的 options；未定义、null 与空串视为未给出；scope.targets 见文件头 */
function buildOptions(flat = {}, scope = {}) {
    if (flat === null || typeof flat !== 'object' || Array.isArray(flat)) throw new Error('buildOptions 需要对象形式的参数');
    const inBatch = sectionFilter(scope ? scope.targets : undefined);
    const nested = {};
    for (const [key, paths, coerce] of FLAT_MAP) {
        const value = flat[key];
        if (value === undefined || value === null || value === '') continue;
        const converted = coerce(value, key);
        for (const dotted of paths) {
            // 不属于本批目标的段只收合法取值：越界即跳过、该段保留默认值，不让无关目标的约束拖垮整批
            if (!inBatch(dotted) && !isValidAt(dotted, converted)) continue;
            setPath(nested, dotted, converted);
        }
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

// targets 省略即全部段都算本批；否则按 SECTION_TARGETS 判定该路径所在段是否被本批某个目标用到
function sectionFilter(targets) {
    if (targets === undefined || targets === null) return () => true;
    if (!Array.isArray(targets) && !(targets instanceof Set)) throw new Error('buildOptions 的 targets 须为目标名数组');
    const batch = new Set(targets);
    return (dotted) => {
        const bound = SECTION_TARGETS[dotted.split('.')[0]];
        return !bound || bound.some((target) => batch.has(target));
    };
}

// 单条路径上的取值能否通过 options.js 的校验：只构造这一条路径交 normalizeOptions，其余字段取默认值
function isValidAt(dotted, value) {
    const probe = {};
    setPath(probe, dotted, value);
    try {
        normalizeOptions(probe);
        return true;
    } catch (err) {
        return false;
    }
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
// 选项说明（CLI 帮助与 MCP 入参描述同源）
// ============================================================

/** 'html.theme' → 描述树中的节点；顶层按键取，其余层经 fields 下钻；未知路径返回 null */
function describeOptionSpec(dotted) {
    return String(dotted).split('.').reduce((node, key, index) => {
        const container = index === 0 ? node : (node && node.fields);
        return container && Object.prototype.hasOwnProperty.call(container, key) ? container[key] : null;
    }, describeOptions());
}

/** 取值说明：枚举列可选值、数字列范围，附默认值（默认为 null 的可空项不列）；多路径的合并规则见文件头 */
function describeOptionHint(paths) {
    const entries = paths.map((dotted) => {
        const spec = describeOptionSpec(dotted);
        if (!spec) throw new Error(`未知选项路径：${dotted}`);
        return { section: dotted.split('.')[0], choices: choicesOf(spec), fallback: defaultOf(spec) };
    });
    const [first] = entries;
    const same = (key) => entries.every((entry) => entry[key] === first[key]);
    const parts = same('choices')
        ? [first.choices, same('fallback') ? labelDefault(first.fallback) : sectionDefaults(entries)]
        : entries.map((entry) => [`${entry.section} ${entry.choices}`.trim(), labelDefault(entry.fallback)].filter(Boolean).join('，'));
    const text = parts.filter(Boolean).join('；');
    return text ? `（${text}）` : '';
}

const choicesOf = (spec) => {
    if (Array.isArray(spec.values)) return `可选 ${spec.values.join(' | ')}`;
    if (typeof spec.min === 'number') return `范围 ${spec.min}–${spec.max}`;
    return '';
};
const defaultOf = (spec) => (spec.default === undefined || spec.default === null ? '' : String(spec.default));
const labelDefault = (fallback) => (fallback ? `默认 ${fallback}` : '');
const sectionDefaults = (entries) => entries
    .filter((entry) => entry.fallback)
    .map((entry) => `${entry.section} 默认 ${entry.fallback}`)
    .join('，');

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

/**
 * 执行批量转换并生成各入口共用的结果信封；options 原样透传 convert（省略即全默认）。
 * signal（AbortSignal）中止后不再领取新任务，已在运行的跑完；未领取的以「已取消」记入 errors 并带 cancelled: true。
 * clean 与 skipExisting 为写盘策略（非用户 options），原样透传 convert：非布尔值由 convert 拒绝并记入 errors。
 */
async function runConversion({
    tasks, outputDir, concurrency = DEFAULT_CONCURRENCY, onEvent, options, signal, clean, skipExisting,
} = {}) {
    // 每批一张产物名登记表：批内派生出同名产物的任务依次改名（sample、sample (pptx)、sample (2)），
    // 不再互相覆盖；登记表不跨批次留存，故单独重复转换同一输入仍覆盖同名产物、保持幂等
    const nameRegistry = createNameRegistry();
    // 批内序号：runBatch 同步领号后随即调用任务函数，故第 k 次调用对应 tasks[k]，计数器即任务序。
    // 登记按该序号排队，最终名与各任务解析完成的先后无关；任务失败时放行后续，避免整批卡住
    let nextOrder = 0;
    const runTask = (task, onProgress) => {
        const order = nextOrder;
        nextOrder += 1;
        return convert({
            input: task.input, target: task.target, outputDir, onProgress, options, nameRegistry, order, clean, skipExisting,
        }).catch((error) => {
            nameRegistry.release(order);
            throw error;
        });
    };
    const { results, errors } = await runBatch(tasks, { concurrency, onEvent, signal }, runTask);
    return {
        ok: errors.length === 0,
        outputDir,
        results: results.map(({ idx, result }) => describeResult(tasks[idx].raw, result)),
        // 取消项的 cancelled 标记随 errors 一并透出，入口据此把「已取消」与真正的失败分开陈述
        errors: errors.map(({ idx, error, cancelled }) => ({
            input: tasks[idx].raw,
            error: errText(error),
            ...(cancelled === true ? { cancelled: true } : {}),
        })),
    };
}

/**
 * 单项结果的对外形状；MCP 在此基础上按 returnContent 追加 content 与 contentTruncated 字段。
 * skipExisting 命中时 convert 返回 skipped: true，一并透出，未命中的结果不带该字段。
 */
function describeResult(input, result) {
    return {
        input,
        ...(result.skipped === true ? { skipped: true } : {}),
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

// ============================================================
// 网页只读提取
// ============================================================

/**
 * 复用 parsers/url 的提取链路（ctx.skipImages 关掉图片下载），渲染成 Markdown 直接返回；
 * 全程不落盘、不产生 assets，图片只列原始地址。返回形状见文件头
 */
async function extractArticle({ url, maxChars } = {}) {
    const target = typeof url === 'string' ? url.trim() : '';
    if (!target) throw new Error('缺少 url');
    const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_EXTRACT_MAX_CHARS;

    const doc = await require('./parsers/url').parse({ url: target }, { skipImages: true });
    const markdown = String(await require('./renderers/md').render(doc));
    const meta = doc.meta || {};
    const truncated = markdown.length > limit;
    return {
        url: target,
        finalUrl: typeof meta.finalUrl === 'string' ? meta.finalUrl : target,
        title: typeof meta.title === 'string' ? meta.title : '',
        ...pickStrings(meta, EXTRACT_OPTIONAL_META),
        wordCount: Number.isFinite(meta.wordCount) ? meta.wordCount : 0,
        extraction: typeof meta.extraction === 'string' ? meta.extraction : '',
        markdown: truncated ? markdown.slice(0, limit) : markdown,
        truncated,
        images: doc.data && Array.isArray(doc.data.images) ? doc.data.images : [],
    };
}

// 只挑出确实有值的字符串字段，空值不进结果
function pickStrings(source, keys) {
    return Object.fromEntries(
        keys.filter((key) => typeof source[key] === 'string' && source[key] !== '').map((key) => [key, source[key]]),
    );
}

module.exports = {
    probeCapabilities, describeFormats, buildOptions, describeOptionSpec, describeOptionHint,
    planTasks, runConversion, extractArticle, DEFAULT_CONCURRENCY, DEFAULT_EXTRACT_MAX_CHARS,
    _setValidatorProbe, _resetProbeCache,
};
