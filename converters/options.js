/**
 * 转换选项（全仓单一定义）
 *
 * 默认值、枚举、取值范围与中文错误文案只在此处定义。CLI（bin/markflow.js）、MCP（mcp/server.js）与桌面端
 * 都经 converters/service.js 的 buildOptions 把各自的扁平参数映射为本模块定义的嵌套结构，再交
 * normalizeOptions 归一：
 *
 *   normalizeOptions(raw)   深合并默认值、逐项校验、深冻结后返回；raw 省略即全默认；任何非法值抛中文 Error；
 *                           传入本函数产出的对象时原样返回同一引用（幂等且零开销），故 parser ctx 与渲染器拿到的是同一份。
 *                           校验之后再按 profile 补默认值（见 applyProfileDefaults）：xml.profile 为 patent 且调用方
 *                           未显式给出 jpegPpi 时，jpegPpi 取 300 而非通用默认的 330——官方只受理 72–300 DPI
 *   applyPatentImportDefaults(options, sourceType)
 *                           按输入类型补默认值（见函数注释）：专利五书 XML 输入（xml / zip）且调用方未显式给出
 *                           docx.fontFamily.eastAsia 时取「宋体」。归一之后才知道输入类型（CLI 与 MCP 在调度器之外
 *                           就已归一），故另作一步；返回的仍是归一结果，再交 normalizeOptions 原样返回
 *   DEFAULT_OPTIONS         normalizeOptions({}) 的结果（冻结）
 *   OPTION_ENUMS            各枚举项的取值表（冻结），供入口的参数枚举与帮助文案取用
 *   describeOptions()       选项描述树（纯 JSON：类型、默认值、枚举、范围、说明），供 CLI 帮助与桌面端面板生成
 *   redactOptions(options)  返回去掉敏感项（mineru.token）的深拷贝；凡是要写进结果、日志或 JSON 的选项一律先经此处理
 *
 * 结构（方案 §3.3.1）：
 *   imageFormat 'jpg'|'keep'    jpegQuality 60–100    jpegPpi 72–600（patent 默认 300）    math 'image'|'text'
 *   pdfBackend 'auto'|'mineru'|'local'
 *   mineru { model, ocr, formula, table, language, pageRanges, timeoutSec, token }
 *   html   { theme, fontFamily, fontSize(px), lineHeight, contentWidth(px), spacing, inlineImages }
 *   pdf    { theme, pageSize, landscape, margins{top,bottom,left,right} }           页边距单位英寸
 *   docx   { pageSize, fontSize(pt), fontFamily{ascii,eastAsia}, margins|null }     页边距英寸；null 表示沿用渲染器默认
 *   xml    { profile, validate, indent, numbering{start,width}, patent{parts,rasterizeTables,rasterizeFormulas,imageDpi,sectionDetection} }
 *   xmlImport { paragraphNumbers }   专利五书 XML 反向导入（输入侧选项，作用于 parsers/xml，与目标无关）
 *   raster { scale, maxWidth }
 *
 * 未列出的键一律拒绝（防止拼写错误静默失效）；可空字段（html.fontFamily、mineru.pageRanges、mineru.token、
 * docx.margins）缺省为 null。本模块零依赖，可被任何层 require。
 */

const OPTION_ENUMS = deepFreeze({
    imageFormats: ['jpg', 'keep'],
    mathModes: ['image', 'text'],
    pdfBackends: ['auto', 'mineru', 'local'],
    mineruModels: ['pipeline', 'vlm'],
    htmlThemes: ['apple', 'apple-dark', 'github', 'academic', 'reader', 'print'],
    spacing: ['compact', 'normal', 'loose'],
    pageSizes: ['A4', 'Letter'],
    xmlProfiles: ['generic', 'patent'],
    patentParts: ['claims', 'description', 'drawings', 'abstract', 'abstract-figure'],
    sectionDetection: ['auto', 'headings'],
});

// 敏感项路径：redactOptions 置空，错误信息不回显其值
const SECRET_PATHS = Object.freeze([Object.freeze(['mineru', 'token'])]);
const SHOW_LIMIT = 60;
// patent profile 的 JPEG 密度默认值：官方只受理 72–300 DPI，通用默认 330 会被预检判为超范围
const PATENT_JPEG_PPI = 300;
// 专利五书 XML 反向导入为 Word 时的中文字体默认值：专利预检（renderers/xml/precheck.js 的 STANDARD_FONTS）
// 只接受宋体、黑体、楷体、仿宋，通用默认「微软雅黑」会让「五书 XML → Word → 再转 XML」自招一条字体告警
const PATENT_IMPORT_EAST_ASIA = '宋体';
// 专利五书 XML 的输入类型：单书 .xml、案卷 .zip 与五书目录（目录的类型同为 xml，见 targets.js 的 BUNDLE_DIR_TYPE）
const PATENT_IMPORT_SOURCE_TYPES = new Set(['xml', 'zip']);
// MinerU 页码范围：形如 "1-5,8,10-12"
const PAGE_RANGES_RE = /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/;
// 语言代码：MinerU 的 ch / en / japan / chinese_cht 等
const LANGUAGE_RE = /^[A-Za-z0-9_-]{1,32}$/;
// CSS 字体栈：禁止能闭合样式声明或注入标签的字符
const FONT_FAMILY_RE = /^[^;{}<>]+$/;

// ============================================================
// 字段描述符
// ============================================================

const enumField = (values, def, description) => ({ kind: 'enum', values, default: def, description });
/**
 * profileDefaults 给出「xml.profile 为某值且调用方未显式给出该键时实际生效的默认值」，
 * 随 describeOptions() 一并下发，使界面能显示会真正生效的缺省值而不必自行硬编码（见 applyProfileDefaults）
 */
const numberField = ({ min, max, integer = false, default: def, profileDefaults = null, description }) =>
    ({ kind: 'number', min, max, integer, default: def, profileDefaults, description });
const booleanField = (def, description) => ({ kind: 'boolean', default: def, description });
const stringField = ({ default: def = null, maxLength = 200, pattern = null, secret = false, description }) =>
    ({ kind: 'string', default: def, nullable: def === null, maxLength, pattern, secret, description });
const objectField = (fields, description, { nullable = false } = {}) =>
    ({ kind: 'object', fields, nullable, default: nullable ? null : undefined, description });
const partsField = (values, description) => ({ kind: 'parts', values, default: 'auto', description });

const marginFields = (def) => ({
    top: numberField({ min: 0, max: 3, default: def, description: '上边距（英寸）' }),
    bottom: numberField({ min: 0, max: 3, default: def, description: '下边距（英寸）' }),
    left: numberField({ min: 0, max: 3, default: def, description: '左边距（英寸）' }),
    right: numberField({ min: 0, max: 3, default: def, description: '右边距（英寸）' }),
});

const SCHEMA = {
    imageFormat: enumField(OPTION_ENUMS.imageFormats, 'jpg', '图片归一格式：jpg 把位图统一转为 JPEG，keep 保持原格式'),
    jpegQuality: numberField({ min: 60, max: 100, integer: true, default: 90, description: 'JPEG 质量' }),
    jpegPpi: numberField({
        min: 72, max: 600, integer: true, default: 330, profileDefaults: { patent: PATENT_JPEG_PPI },
        description: 'JPEG 分辨率（PPI）；xml.profile 为 patent 且未显式指定时取 300',
    }),
    math: enumField(OPTION_ENUMS.mathModes, 'image', 'docx 公式的处理方式：image 栅格为图片，text 降级为线性化文本'),
    pdfBackend: enumField(OPTION_ENUMS.pdfBackends, 'auto', 'PDF 解析后端：auto 有 MinerU 令牌走云端否则本地，mineru 强制云端，local 强制本地'),
    mineru: objectField({
        model: enumField(OPTION_ENUMS.mineruModels, 'pipeline', 'MinerU 解析模型'),
        ocr: booleanField(false, '强制 OCR'),
        formula: booleanField(true, '识别公式'),
        table: booleanField(true, '识别表格'),
        language: stringField({ default: 'ch', maxLength: 32, pattern: LANGUAGE_RE, description: '文档语言代码' }),
        pageRanges: stringField({ maxLength: 200, pattern: PAGE_RANGES_RE, description: '页码范围，形如 1-5,8' }),
        timeoutSec: numberField({ min: 30, max: 3600, integer: true, default: 600, description: '云端解析超时（秒）' }),
        token: stringField({ maxLength: 512, secret: true, description: 'MinerU 令牌（仅桌面端主进程注入，不经 CLI/MCP 明文传递）' }),
    }, 'MinerU 云端解析参数'),
    html: objectField({
        theme: enumField(OPTION_ENUMS.htmlThemes, 'apple', 'HTML 主题'),
        fontFamily: stringField({ pattern: FONT_FAMILY_RE, description: '正文字体栈（CSS font-family 值），null 取主题默认' }),
        fontSize: numberField({ min: 10, max: 32, default: 16, description: '正文字号（px）' }),
        lineHeight: numberField({ min: 1, max: 3, default: 1.7, description: '行高倍数' }),
        contentWidth: numberField({ min: 480, max: 1600, integer: true, default: 760, description: '正文栏宽（px）' }),
        spacing: enumField(OPTION_ENUMS.spacing, 'normal', '段落间距档位'),
        inlineImages: booleanField(false, '图片以 data URI 内联而非 images/ 相对引用'),
    }, 'HTML 目标参数'),
    pdf: objectField({
        theme: enumField(OPTION_ENUMS.htmlThemes, 'print', 'PDF 打印主题'),
        pageSize: enumField(OPTION_ENUMS.pageSizes, 'A4', '纸张'),
        landscape: booleanField(false, '横向'),
        margins: objectField(marginFields(0.6), '页边距（英寸）'),
    }, 'PDF 目标参数'),
    docx: objectField({
        pageSize: enumField(OPTION_ENUMS.pageSizes, 'A4', '纸张'),
        fontSize: numberField({ min: 8, max: 36, default: 11, description: '正文字号（pt）' }),
        fontFamily: objectField({
            ascii: stringField({ default: 'Calibri', maxLength: 100, description: '西文字体' }),
            eastAsia: stringField({ default: '微软雅黑', maxLength: 100, description: '中文字体' }),
        }, '字体'),
        margins: objectField(marginFields(1), '页边距（英寸），null 表示沿用渲染器默认', { nullable: true }),
    }, 'DOCX 目标参数'),
    xml: objectField({
        profile: enumField(OPTION_ENUMS.xmlProfiles, 'generic', 'XML 方言：generic 通用文档结构，patent 国知局专利五书'),
        validate: booleanField(false, '渲染后用官方 DTD 校验并把结果写入 warnings'),
        indent: numberField({ min: 0, max: 8, integer: true, default: 2, description: '缩进空格数' }),
        numbering: objectField({
            start: numberField({ min: 1, max: 9999, integer: true, default: 1, description: '段号起始值' }),
            width: numberField({ min: 1, max: 6, integer: true, default: 4, description: '段号补零位数' }),
        }, '说明书段号'),
        patent: objectField({
            parts: partsField(OPTION_ENUMS.patentParts, '输出的五书子集，auto 按识别结果'),
            rasterizeTables: booleanField(true, '表格栅格为图片'),
            rasterizeFormulas: booleanField(true, '公式栅格为图片'),
            imageDpi: numberField({ min: 72, max: 600, integer: true, default: 300, description: '图片密度（DPI）' }),
            sectionDetection: enumField(OPTION_ENUMS.sectionDetection, 'auto', '分节识别：auto 标题或加粗短段，headings 仅标题'),
        }, '专利 profile 参数'),
    }, 'XML 目标参数'),
    xmlImport: objectField({
        paragraphNumbers: booleanField(false, '导入专利五书 XML 时把说明书与摘要的段号写回段首（[0001]），回转 XML 时原样复用；缺省不写，回转时按顺序重编'),
    }, '专利五书 XML 反向导入参数'),
    raster: objectField({
        scale: numberField({ min: 1, max: 4, default: 2, description: '栅格化缩放倍数（patent profile 下忽略）' }),
        maxWidth: numberField({ min: 200, max: 10000, integer: true, default: 1600, description: '图片最大宽度（px，patent profile 下忽略）' }),
    }, '栅格化参数'),
};
const ROOT_FIELD = objectField(SCHEMA, '转换选项');

// ============================================================
// 归一化
// ============================================================

// 本模块产出过的归一结果（已深冻结，不可能被改动），再次传入直接原样返回
const NORMALIZED = new WeakSet();
// 归一结果 → 调用方的原始入参：供归一之后才能判定的默认值（applyPatentImportDefaults）查某键是否为显式给出
const RAW_SOURCES = new WeakMap();

function normalizeOptions(raw) {
    if (raw !== null && typeof raw === 'object' && NORMALIZED.has(raw)) return raw;
    const source = raw === undefined || raw === null ? {} : raw;
    if (!isPlainObject(source)) throw new Error(`选项 options 须为对象，实际：${show(source)}`);
    const normalized = deepFreeze(applyProfileDefaults(normalizeObject(ROOT_FIELD, source, ''), source));
    NORMALIZED.add(normalized);
    RAW_SOURCES.set(normalized, source);
    return normalized;
}

/**
 * 按 profile 调整默认值：patent profile 下 jpegPpi 取 PATENT_JPEG_PPI。
 * 通用默认 330 超出官方受理的 72–300 DPI，真实底稿实测因此产出 5 条密度预检告警；该密度同时决定
 * assets/image-normalize 的重采样目标像素，故须与官方一致。只在调用方未给出 jpegPpi 时生效
 * （未给出即 undefined——null 与非整数在 normalizeNumber 已抛错），显式传入的值一律尊重；
 * 其余 profile 不受影响。
 */
function applyProfileDefaults(normalized, source) {
    if (source.jpegPpi !== undefined) return normalized;
    if (!normalized.xml || normalized.xml.profile !== 'patent') return normalized;
    return { ...normalized, jpegPpi: PATENT_JPEG_PPI };
}

/**
 * 按输入类型调整默认值：输入为专利五书 XML（单书 .xml、案卷 .zip、五书目录）时，docx.fontFamily.eastAsia
 * 取 PATENT_IMPORT_EAST_ASIA。判据与 applyProfileDefaults 一致——看归一前的入参里该键是否为 undefined，
 * 显式给出的（CLI 的 --font-east-asia、MCP 的 docx.fontEastAsia 与直接的嵌套写法都归一到同一条路径）一律照用。
 * 不按目标区分：docx 段只被 docx 渲染器读取，而桌面端三段式 API 解析时不一定知道目标。
 * 返回值同样登记为归一结果，故可再交 normalizeOptions 原样返回；其余输入类型原样返回入参。
 */
function applyPatentImportDefaults(options, sourceType) {
    if (!PATENT_IMPORT_SOURCE_TYPES.has(sourceType)) return options;
    if (!isPlainObject(options) || !isPlainObject(options.docx) || !isPlainObject(options.docx.fontFamily)) return options;
    if (options.docx.fontFamily.eastAsia === PATENT_IMPORT_EAST_ASIA) return options;
    const raw = RAW_SOURCES.get(options);
    if (isGivenEastAsia(raw)) return options;
    const fontFamily = { ...options.docx.fontFamily, eastAsia: PATENT_IMPORT_EAST_ASIA };
    const next = deepFreeze({ ...options, docx: { ...options.docx, fontFamily } });
    NORMALIZED.add(next);
    if (raw !== undefined) RAW_SOURCES.set(next, raw);
    return next;
}

// 归一前的入参里是否显式给出了中文字体
const isGivenEastAsia = (raw) => isPlainObject(raw) && isPlainObject(raw.docx)
    && isPlainObject(raw.docx.fontFamily) && raw.docx.fontFamily.eastAsia !== undefined;

function normalizeField(spec, raw, at) {
    switch (spec.kind) {
        case 'object': return normalizeObject(spec, raw, at);
        case 'enum': return normalizeEnum(spec, raw, at);
        case 'number': return normalizeNumber(spec, raw, at);
        case 'boolean': return normalizeBoolean(spec, raw, at);
        case 'string': return normalizeString(spec, raw, at);
        case 'parts': return normalizeParts(spec, raw, at);
        default: throw new Error(`选项描述符类型未知：${spec.kind}`);
    }
}

function normalizeObject(spec, raw, at) {
    if (raw === undefined) return spec.nullable ? null : buildObject(spec, {}, at);
    if (raw === null) {
        if (spec.nullable) return null;
        throw new Error(`选项 ${labelOf(at)} 不可为空`);
    }
    if (!isPlainObject(raw)) throw new Error(`选项 ${labelOf(at)} 须为对象，实际：${show(raw)}`);
    return buildObject(spec, raw, at);
}

function buildObject(spec, raw, at) {
    const unknown = Object.keys(raw).find((key) => !Object.prototype.hasOwnProperty.call(spec.fields, key));
    if (unknown !== undefined) {
        throw new Error(`未知选项：${joinPath(at, unknown)}（可用：${Object.keys(spec.fields).join('、')}）`);
    }
    const out = {};
    for (const [key, sub] of Object.entries(spec.fields)) out[key] = normalizeField(sub, raw[key], joinPath(at, key));
    return out;
}

function normalizeEnum(spec, raw, at) {
    if (raw === undefined) return spec.default;
    if (!spec.values.includes(raw)) throw new Error(`选项 ${at} 须为 ${spec.values.join(' | ')} 之一，实际：${show(raw)}`);
    return raw;
}

function normalizeNumber(spec, raw, at) {
    if (raw === undefined) return spec.default;
    const kind = spec.integer ? '整数' : '数字';
    const valid = typeof raw === 'number' && Number.isFinite(raw) && (!spec.integer || Number.isInteger(raw));
    if (!valid || raw < spec.min || raw > spec.max) {
        throw new Error(`选项 ${at} 须为 ${spec.min}–${spec.max} 之间的${kind}，实际：${show(raw)}`);
    }
    return raw;
}

function normalizeBoolean(spec, raw, at) {
    if (raw === undefined) return spec.default;
    if (typeof raw !== 'boolean') throw new Error(`选项 ${at} 须为布尔值，实际：${show(raw)}`);
    return raw;
}

function normalizeString(spec, raw, at) {
    if (raw === undefined) return spec.default;
    const display = spec.secret ? '（已隐藏）' : show(raw);
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
        if (spec.nullable) return null;
        throw new Error(`选项 ${at} 不可为空`);
    }
    if (typeof raw !== 'string') throw new Error(`选项 ${at} 须为字符串，实际：${display}`);
    const value = raw.trim();
    if (value.length > spec.maxLength) throw new Error(`选项 ${at} 长度不得超过 ${spec.maxLength} 个字符`);
    if (spec.pattern && !spec.pattern.test(value)) throw new Error(`选项 ${at} 格式非法：${display}`);
    return value;
}

function normalizeParts(spec, raw, at) {
    if (raw === undefined) return spec.default;
    if (raw === 'auto') return 'auto';
    const valid = Array.isArray(raw) && raw.length > 0
        && raw.every((item) => spec.values.includes(item))
        && new Set(raw).size === raw.length;
    if (!valid) {
        throw new Error(`选项 ${at} 须为 'auto' 或由 ${spec.values.join('、')} 组成的非空且不重复的数组，实际：${show(raw)}`);
    }
    return [...raw];
}

// ============================================================
// 描述与脱敏
// ============================================================

/** 纯 JSON 的描述树：每个叶子含 type / default / description，枚举含 values，数字含 min / max / integer */
function describeOptions() {
    return describeField(ROOT_FIELD).fields;
}

function describeField(spec) {
    const base = { type: spec.kind, description: spec.description || '' };
    switch (spec.kind) {
        case 'object':
            return {
                ...base, nullable: spec.nullable,
                fields: Object.fromEntries(Object.entries(spec.fields).map(([key, sub]) => [key, describeField(sub)])),
            };
        case 'enum': return { ...base, values: [...spec.values], default: spec.default };
        case 'number': return {
            ...base, min: spec.min, max: spec.max, integer: spec.integer, default: spec.default,
            ...(spec.profileDefaults ? { profileDefaults: { ...spec.profileDefaults } } : {}),
        };
        case 'boolean': return { ...base, default: spec.default };
        case 'string':
            return {
                ...base, default: spec.default, nullable: spec.nullable, maxLength: spec.maxLength,
                pattern: spec.pattern ? spec.pattern.source : null, secret: spec.secret,
            };
        case 'parts': return { ...base, values: [...spec.values], default: spec.default };
        default: return base;
    }
}

/** 去掉敏感项的深拷贝（未冻结，便于写入结果信封） */
function redactOptions(options) {
    const copy = deepClone(options);
    if (!isPlainObject(copy)) return copy;
    for (const segments of SECRET_PATHS) {
        const parent = segments.slice(0, -1).reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), copy);
        if (isPlainObject(parent) && parent[segments[segments.length - 1]] !== undefined) parent[segments[segments.length - 1]] = null;
    }
    return copy;
}

// ============================================================
// 工具
// ============================================================

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const item of Object.values(value)) deepFreeze(item);
    }
    return value;
}

function deepClone(value) {
    if (Array.isArray(value)) return value.map(deepClone);
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepClone(item)]));
    return value;
}

const joinPath = (at, key) => (at ? `${at}.${key}` : key);
const labelOf = (at) => at || 'options';

// 错误信息里的值回显：JSON 形态、超长截断
function show(value) {
    let text;
    try {
        text = value === undefined ? 'undefined' : JSON.stringify(value);
        if (typeof text !== 'string') text = String(value);
    } catch (err) {
        text = String(value);
    }
    return text.length > SHOW_LIMIT ? `${text.slice(0, SHOW_LIMIT - 3)}...` : text;
}

const DEFAULT_OPTIONS = normalizeOptions({});

module.exports = { normalizeOptions, applyPatentImportDefaults, describeOptions, redactOptions, OPTION_ENUMS, DEFAULT_OPTIONS, SECRET_PATHS };
