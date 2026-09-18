/**
 * 专利 profile 预检与问题项模型
 *
 * ISSUE_CODES  全部问题项的稳定短标识（本表为唯一定义处，各模块经 createIssue 引用）
 * CATEGORIES   问题类别 → warnings 文案前缀（预检：/分节：/发明名称：/权项：/段号：/附图：/栅格化：/DTD 校验：）
 * createIssue(code, message, { level?, location? }) → { code, level, category, message, location? }
 *   message 自动冠以类别前缀；level 缺省按 BLOCKING_CODES 判定（官方工具会拒绝转换的项为 blocking）
 * precheck(doc, { profile, sections }) → { blocking: string[], warnings: string[], items: Issue[] }
 *   逐项检查：字符集（控制字符 / 私用区 / 非字符 / 孤立代理项，近似 GB18030 之外）、图片格式与 JPEG 密度、
 *   源 docx 的 OOXML 特征（doc.data.ooxml，缺失时跳过；OLE 对象按 ProgID 是否命中化学白名单分两条文案）、
 *   公式线性化文本以标点结尾、缺节（sections 给出时）。
 *   预检只产出提示，不阻断转换；blocking 与 warnings 为按 level 分组的文案，items 为完整清单。
 */
const { collectText } = require('../../ir/util');
const { mathToText } = require('../../ir/schema');
const { readImageInfo } = require('./image-info');

const ISSUE_CODES = Object.freeze({
    PRECHECK_REVISIONS: 'PRECHECK_REVISIONS',
    PRECHECK_FLOATING_OBJECT: 'PRECHECK_FLOATING_OBJECT',
    PRECHECK_TEXTBOX: 'PRECHECK_TEXTBOX',
    PRECHECK_OLE: 'PRECHECK_OLE',
    PRECHECK_AUTO_NUMBERING: 'PRECHECK_AUTO_NUMBERING',
    PRECHECK_PROTECTION: 'PRECHECK_PROTECTION',
    PRECHECK_COMMENTS: 'PRECHECK_COMMENTS',
    PRECHECK_FONT: 'PRECHECK_FONT',
    PRECHECK_CHARSET: 'PRECHECK_CHARSET',
    PRECHECK_IMAGE_FORMAT: 'PRECHECK_IMAGE_FORMAT',
    PRECHECK_IMAGE_DPI: 'PRECHECK_IMAGE_DPI',
    PRECHECK_FORMULA_PUNCT: 'PRECHECK_FORMULA_PUNCT',
    SECTION_MISSING: 'SECTION_MISSING',
    SECTION_INFERRED: 'SECTION_INFERRED',
    SECTION_UNCLASSIFIED: 'SECTION_UNCLASSIFIED',
    PART_MISSING: 'PART_MISSING',
    TITLE_FALLBACK: 'TITLE_FALLBACK',
    TITLE_MISSING: 'TITLE_MISSING',
    CLAIM_NUMBER_GAP: 'CLAIM_NUMBER_GAP',
    CLAIM_NONE: 'CLAIM_NONE',
    NUMBERING_JUMP: 'NUMBERING_JUMP',
    FIGURE_NUMBER_GAP: 'FIGURE_NUMBER_GAP',
    FIGURE_MISSING_ASSET: 'FIGURE_MISSING_ASSET',
    FIGURE_ABSTRACT_MULTIPLE: 'FIGURE_ABSTRACT_MULTIPLE',
    FIGURE_ABSTRACT_DEPRECATED: 'FIGURE_ABSTRACT_DEPRECATED',
    FIGURE_INLINE_IMAGE: 'FIGURE_INLINE_IMAGE',
    FIGURE_UNUSED_ASSET: 'FIGURE_UNUSED_ASSET',
    FIGURE_TEXT_DROPPED: 'FIGURE_TEXT_DROPPED',
    RASTER_UNAVAILABLE: 'RASTER_UNAVAILABLE',
    DTD_INVALID: 'DTD_INVALID',
    DTD_UNAVAILABLE: 'DTD_UNAVAILABLE',
});

const CATEGORIES = Object.freeze({
    precheck: '预检：', section: '分节：', title: '发明名称：', claim: '权项：',
    numbering: '段号：', figure: '附图：', raster: '栅格化：', dtd: 'DTD 校验：',
});

const CATEGORY_BY_PREFIX = Object.freeze([
    ['PRECHECK_', 'precheck'], ['SECTION_', 'section'], ['PART_', 'section'], ['TITLE_', 'title'],
    ['CLAIM_', 'claim'], ['NUMBERING_', 'numbering'], ['FIGURE_', 'figure'], ['RASTER_', 'raster'], ['DTD_', 'dtd'],
]);
// 官方工具会拒绝转换的项
const BLOCKING_CODES = new Set([
    ISSUE_CODES.PRECHECK_REVISIONS, ISSUE_CODES.PRECHECK_FLOATING_OBJECT,
    ISSUE_CODES.PRECHECK_TEXTBOX, ISSUE_CODES.PRECHECK_PROTECTION,
]);
const LEVELS = Object.freeze({ BLOCKING: 'blocking', WARNING: 'warning' });

function createIssue(code, message, { level, location } = {}) {
    if (!Object.values(ISSUE_CODES).includes(code)) throw new Error(`未知的问题项代码：${String(code)}`);
    const category = categoryOf(code);
    const prefix = CATEGORIES[category];
    const text = String(message == null ? '' : message);
    const issue = {
        code,
        level: level || (BLOCKING_CODES.has(code) ? LEVELS.BLOCKING : LEVELS.WARNING),
        category,
        message: text.startsWith(prefix) ? text : `${prefix}${text}`,
    };
    if (location) issue.location = String(location);
    return issue;
}

function categoryOf(code) {
    const hit = CATEGORY_BY_PREFIX.find(([prefix]) => code.startsWith(prefix));
    return hit ? hit[1] : 'precheck';
}

// ============================================================
// 预检
// ============================================================

const DPI_MIN = 72;
const DPI_MAX = 300;
const ACCEPTED_FORMATS = new Set(['jpg', 'tif']);
// 官方接受的常规字体
const STANDARD_FONTS = new Set(['宋体', '黑体', '楷体', '仿宋', '仿宋_GB2312', '楷体_GB2312', 'SimSun', 'SimHei', 'KaiTi', 'FangSong']);
const MAX_CHARSET_REPORTS = 10;
const MAX_CHARS_PER_REPORT = 3;
const FORMULA_PREVIEW = 30;
const TRAILING_PUNCT_RE = /[，。；：、,.;:!?！？]\s*$/;
// 官方标记字符（Cnipr.ttf 私用区码位 U+E201、U+E204–U+E20F）不计入字符集问题，由分节模块剥离
// 不可见字符一律以码点生成，源码里不出现看不见的字面量（与 ir/markers 同一约定）
const fromCode = (code) => String.fromCharCode(code);
const OFFICIAL_MARK_FIRST = 0xE200;
const OFFICIAL_MARK_LAST = 0xE20F;
const OFFICIAL_MARK_RE = new RegExp(`[${fromCode(OFFICIAL_MARK_FIRST)}-${fromCode(OFFICIAL_MARK_LAST)}]`);
const SUSPECT_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uE000-\uF8FF\uFDD0-\uFDEF\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;
const SECTION_LABELS = Object.freeze({ claims: '权利要求书', description: '说明书', drawings: '说明书附图', abstract: '说明书摘要' });

function precheck(doc, { profile = 'patent', sections = null } = {}) {
    const items = [];
    if (doc && typeof doc === 'object' && profile === 'patent') {
        items.push(...checkOoxml(doc.data && doc.data.ooxml));
        items.push(...checkCharset(doc.ir));
        items.push(...checkImages(doc.assets));
        items.push(...checkFormulaPunctuation(doc.ir));
        items.push(...checkSections(sections));
    }
    return {
        blocking: items.filter((item) => item.level === LEVELS.BLOCKING).map((item) => item.message),
        warnings: items.filter((item) => item.level === LEVELS.WARNING).map((item) => item.message),
        items,
    };
}

// ---------- 源 docx 特征（阶段 2a 的 doc.data.ooxml，缺失即跳过） ----------

function checkOoxml(ooxml) {
    if (!ooxml || typeof ooxml !== 'object') return [];
    const items = [];
    const floating = countOf(ooxml.floatingImages);
    if (floating > 0) items.push(createIssue(ISSUE_CODES.PRECHECK_FLOATING_OBJECT, `文档含 ${floating} 个浮动对象（wp:anchor），官方要求转为嵌入式后再转换`));
    const textBoxes = countOf(ooxml.textBoxes);
    if (textBoxes > 0) items.push(createIssue(ISSUE_CODES.PRECHECK_TEXTBOX, `文档含 ${textBoxes} 个文本框，官方工具不支持文本框内容`));
    items.push(...checkOle(ooxml.oleObjects));
    const autoNumbering = countOf(ooxml.autoNumbering);
    if (autoNumbering > 0) items.push(createIssue(ISSUE_CODES.PRECHECK_AUTO_NUMBERING, `${autoNumbering} 段使用了 Word 自动编号（w:numPr），官方要求段号与权项号以文字录入`));
    const revisions = ooxml.revisions && typeof ooxml.revisions === 'object' ? ooxml.revisions : {};
    const insertions = countOf(revisions.insertions);
    const deletions = countOf(revisions.deletions);
    const tracking = Boolean(revisions.trackRevisions);
    if (insertions + deletions > 0 || tracking) {
        items.push(createIssue(ISSUE_CODES.PRECHECK_REVISIONS,
            `文档含修订痕迹（插入 ${insertions} 处、删除 ${deletions} 处，修订跟踪${tracking ? '已开启' : '未开启'}），请先接受或拒绝全部修订`));
    }
    const protection = ooxml.protection && typeof ooxml.protection === 'object' ? ooxml.protection : {};
    if (protection.enforced) items.push(createIssue(ISSUE_CODES.PRECHECK_PROTECTION, `文档已启用保护${protection.type ? `（${protection.type}）` : ''}，官方要求不得加密或设置保护`));
    const comments = countOf(ooxml.comments);
    if (comments > 0) items.push(createIssue(ISSUE_CODES.PRECHECK_COMMENTS, `文档含 ${comments} 条批注，转换时将被丢弃`));
    const fonts = (Array.isArray(ooxml.eastAsiaFonts) ? ooxml.eastAsiaFonts : []).filter((font) => typeof font === 'string' && font && !STANDARD_FONTS.has(font));
    if (fonts.length > 0) items.push(createIssue(ISSUE_CODES.PRECHECK_FONT, `文档使用了常规字体之外的中文字体：${fonts.join('、')}（官方仅接受宋体、黑体、楷体、仿宋）`));
    return items;
}

// ProgID 命中化学白名单的 OLE 对象（ooxml.oleObjects[].chemistry，见 parsers/docx-chemistry）另立一条：
// 它的预览图已按化学式图片输出，不必改用公式编辑器；其余 OLE 对象维持原提示
function checkOle(oleObjects) {
    const ole = (Array.isArray(oleObjects) ? oleObjects : []).filter((item) => item && typeof item === 'object');
    const chemistry = ole.filter((item) => item.chemistry);
    const others = ole.filter((item) => !item.chemistry);
    const items = [];
    if (chemistry.length > 0) {
        items.push(createIssue(ISSUE_CODES.PRECHECK_OLE,
            `文档含 ${chemistry.length} 个化学结构式 OLE 对象${describeProgIds(chemistry)}，已按化学式图片输出`));
    }
    if (others.length > 0) {
        items.push(createIssue(ISSUE_CODES.PRECHECK_OLE,
            `文档含 ${others.length} 个 OLE 对象${describeProgIds(others)}，公式请改用公式编辑器或按图片处理`));
    }
    return items;
}

function describeProgIds(list) {
    const progIds = [...new Set(list.map((item) => item.progId).filter(Boolean))];
    return progIds.length > 0 ? `（${progIds.join('、')}）` : '';
}

const countOf = (value) => {
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
    return 0;
};

// ---------- 字符集 ----------

function checkCharset(root) {
    const blocks = root && Array.isArray(root.children) ? root.children : [];
    const items = [];
    let extra = 0;
    blocks.forEach((block, index) => {
        const found = [];
        for (const match of collectText(block).matchAll(SUSPECT_CHAR_RE)) {
            if (OFFICIAL_MARK_RE.test(match[0])) continue;
            found.push(describeChar(match[0]));
        }
        if (found.length === 0) return;
        if (items.length >= MAX_CHARSET_REPORTS) { extra += 1; return; }
        const shown = [...new Set(found)];
        const summary = shown.slice(0, MAX_CHARS_PER_REPORT).join('、') + (shown.length > MAX_CHARS_PER_REPORT ? ` 等 ${shown.length} 种` : '');
        items.push(createIssue(ISSUE_CODES.PRECHECK_CHARSET, `第 ${index + 1} 段含 GB18030 不支持的字符：${summary}`, { location: `第 ${index + 1} 段` }));
    });
    if (extra > 0) items.push(createIssue(ISSUE_CODES.PRECHECK_CHARSET, `另有 ${extra} 段含 GB18030 不支持的字符`));
    return items;
}

function describeChar(char) {
    const code = char.codePointAt(0);
    const hex = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return `${hex}（控制字符）`;
    if ((code >= 0xe000 && code <= 0xf8ff) || code >= 0xf0000) return `${hex}（私用区）`;
    if (code >= 0xd800 && code <= 0xdfff) return `${hex}（孤立代理项）`;
    return `${hex}（非字符）`;
}

// ---------- 图片 ----------

function checkImages(assets) {
    const items = [];
    for (const asset of Array.isArray(assets) ? assets : []) {
        if (!asset || typeof asset.name !== 'string') continue;
        const info = readImageInfo(asset.buffer, asset.mime);
        const format = info && info.format ? info.format : extOf(asset.name);
        if (!ACCEPTED_FORMATS.has(format)) {
            items.push(createIssue(ISSUE_CODES.PRECHECK_IMAGE_FORMAT, `图片 ${asset.name} 为 ${format || '未知'} 格式，官方只受理 JPG/TIF`, { location: asset.name }));
            continue;
        }
        if (format !== 'jpg' || !info) continue;
        if (info.dpi === null) {
            items.push(createIssue(ISSUE_CODES.PRECHECK_IMAGE_DPI, `图片 ${asset.name} 未记录密度，尺寸将按 ${DPI_MAX} DPI 换算`, { location: asset.name }));
        } else if (info.dpi < DPI_MIN || info.dpi > DPI_MAX) {
            items.push(createIssue(ISSUE_CODES.PRECHECK_IMAGE_DPI, `图片 ${asset.name} 的密度为 ${info.dpi} DPI，超出官方要求的 ${DPI_MIN}–${DPI_MAX} DPI`, { location: asset.name }));
        }
    }
    return items;
}

function extOf(name) {
    const ext = String(name).toLowerCase().split('.').pop();
    if (ext === 'jpeg') return 'jpg';
    if (ext === 'tiff') return 'tif';
    return ext;
}

// ---------- 公式后标点 ----------

function checkFormulaPunctuation(root) {
    const items = [];
    const visit = (node) => {
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (!node || typeof node !== 'object') return;
        const text = formulaText(node);
        if (text !== null && TRAILING_PUNCT_RE.test(text)) {
            const preview = text.length > FORMULA_PREVIEW ? `${text.slice(0, FORMULA_PREVIEW)}…` : text;
            items.push(createIssue(ISSUE_CODES.PRECHECK_FORMULA_PUNCT, `公式“${preview}”的线性化文本以标点结尾，标点应置于公式之外`));
        }
        if (Array.isArray(node.children)) visit(node.children);
    };
    visit(root);
    return items;
}

// math 节点取线性化文本；栅格化后的公式图片（data.role 为 formula）取 data.text 或 alt
function formulaText(node) {
    if (node.type === 'math') return mathToText(node).trim();
    if (node.type === 'image' && node.data && node.data.role === 'formula') {
        const text = typeof node.data.text === 'string' ? node.data.text : (typeof node.alt === 'string' ? node.alt : '');
        return text.trim();
    }
    return null;
}

// ---------- 缺节 ----------

function checkSections(sections) {
    if (!sections || typeof sections !== 'object') return [];
    return Object.entries(SECTION_LABELS)
        .filter(([key]) => !hasContent(sections[key]))
        .map(([, label]) => createIssue(ISSUE_CODES.SECTION_MISSING, `未识别到${label}`));
}

const hasContent = (value) => (Array.isArray(value) ? value.length > 0 : Boolean(value));

module.exports = { ISSUE_CODES, CATEGORIES, LEVELS, createIssue, precheck };
