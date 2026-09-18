/**
 * docx 版面预处理：首行缩进、制表符、题注与图片显示尺寸
 *
 * mammoth 会丢掉 w:ind 首行缩进、把 w:tab 变成随后被 turndown 折叠的 \t、不给图片带显示尺寸，
 * 故在交给 mammoth 之前（extractMath 之后）先在 word/document.xml 上做字符串级改写（写法沿用 docx-math），
 * 把这些信息换成 mammoth 一定会保留的形态——私用区标记文本（见 ir/markers）与图片替代文本：
 *   - 首行缩进：有效值按「段落 w:ind → pStyle 的 basedOn 链 → docDefaults」逐级取；firstLineChars/100，
 *     或 firstLine / (sz × 10)（sz 为半磅字号：首个 run → 段落标记 → 样式链 → docDefaults，缺省 21）；
 *     悬挂缩进、编号段落、标题段落（标题样式或大纲级别 0–8）与无文字段落跳过；
 *     命中者在 pPr 之后插入一个 INDENT 标记 run
 *   - 制表符：run 内的 <w:tab/> → TAB 标记文本（w:tabs 里的制表位带属性，不受影响）
 *   - 题注：段落样式（含 basedOn 链）名为 caption / 题注 → 插 CAPTION 标记 run
 *   - 图片：每个含 a:blip 的 w:drawing 在 wp:docPr@descr 前写入序号标记 ⟦MF:k⟧（mammoth 以 descr、
 *     其次 title 作 alt），记录 wp:extent 的显示尺寸（EMU / 9525 = px，同时 EMU / 914400 × 25.4 = mm）
 *     与是否浮动（wp:anchor）；VML 图片（v:imagedata）在 o:title 前写标记，尺寸取所属 v:shape 的
 *     style（pt / in / cm / mm / px / pc → px 与 mm 各算一份）。
 *     标记随 alt 回到 parsers/docx 的 convertImage，据此把尺寸对到资产名上，与图片出现顺序无关
 *     （实测样稿 wp:extent 16 个而 a:blip 14 个，按顺序配对必然错位）
 *   - 化学式：起始位置落在 docx-chemistry 给出的化学区间（OLE ProgID 与 EMBED 域代码两条判据）内的图片，
 *     其序号记入 roles，值为 'chemistry'；另两条判据（替换文字、EMF 字节）由 parsers/docx 的 convertImage 判定
 *
 * 像素与毫米两套并存且互不换算：px 供既有的版面还原（data.display，按 96 DPI 定义、取整）；
 * mm 是 Word 中的物理显示尺寸（浮点、不取整），供 patent profile 按官方规则在 300 DPI 下重采样
 * 附图与写 img/@wi、@he。由 px 反推 mm 会先丢一次精度，故两者各自从 EMU / CSS 长度直接算出。
 *
 * 契约：
 *   prepareLayout(docxBuffer) → {
 *     buffer,
 *     displays: Map<k, { width, height?, floating, widthMm?, heightMm? }>,
 *     roles: Map<k, 'chemistry'>,
 *   }
 *     无 document.xml 或无任何改写时原样返回入参 buffer；mm 两项取不到即整条省略；roles 只记命中的序号
 *   parseImageMarker(alt) → { index: number | null, alt }：取出序号并还原原 alt
 * 说明：document.xml 与 styles.xml 属不可信文档内容，本模块只做字符串定位与替换，不执行其中任何指令。
 */
const JSZip = require('jszip');
const cheerio = require('cheerio');
const { MARKERS, indentMarker } = require('../ir/markers');
const { findBlocks, findCloseTag, readTag } = require('./docx-math');
const { CHEMISTRY_ROLE, collectChemistryRanges, inChemistryRange } = require('./docx-chemistry');

const DOCUMENT_PART = 'word/document.xml';
const STYLES_PART = 'word/styles.xml';
const EMU_PER_PX = 9525;
const EMU_PER_INCH = 914400;
const INCH_MM = 25.4;
// 缺省字号：五号字 10.5pt = 21 半磅；一个字宽 = 半磅 × 10 twip
const DEFAULT_HALF_POINTS = 21;
const TWIPS_PER_HALF_POINT = 10;
const CHARS_UNIT = 100;
const MAX_INDENT_CHARS = 8;
const BODY_OUTLINE_LEVEL = 9;
const MAX_STYLE_DEPTH = 20;
const IMAGE_MARKER_RE = /^⟦MF:(\d{1,6})⟧/;
const imageMarker = (k) => `⟦MF:${k}⟧`;
const HEADING_NAME_RE = /^\s*(heading|标题)\s*\d/i;
const HEADING_ID_RE = /^(Heading|标题)\s*\d/i;
const CAPTION_NAME_RE = /^(caption|题注)$/i;
const PX_PER_UNIT = Object.freeze({ pt: 96 / 72, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, px: 1, pc: 16 });
// 同一组 CSS 单位换算到毫米；px 按 96 DPI 定义（VML 的裸数字按 px 处理，与 PX_PER_UNIT 一致）
const MM_PER_UNIT = Object.freeze({
    pt: INCH_MM / 72, in: INCH_MM, cm: 10, mm: 1, px: INCH_MM / 96, pc: INCH_MM / 6,
});
const TEXT_RUN_RE = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
const MATH_SENTINEL_RE = /MFMATH\d+/g;

async function prepareLayout(docxBuffer) {
    const zip = await JSZip.loadAsync(docxBuffer);
    const entry = zip.file(DOCUMENT_PART);
    if (!entry) return { buffer: docxBuffer, displays: new Map(), roles: new Map() };
    const xml = await entry.async('string');
    const stylesEntry = zip.file(STYLES_PART);
    const styles = readStyles(stylesEntry ? await stylesEntry.async('string') : '');

    const edits = [];
    const displays = new Map();
    const roles = new Map();
    const counter = { next: 0 };
    const chem = { ranges: collectChemistryRanges(xml), roles };
    collectDrawingEdits(xml, edits, displays, counter, chem);
    collectVmlEdits(xml, edits, displays, counter, chem);
    collectParagraphEdits(xml, styles, edits);
    collectTabEdits(xml, edits);
    if (edits.length === 0) return { buffer: docxBuffer, displays, roles };

    zip.file(DOCUMENT_PART, applyEdits(xml, edits));
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return { buffer, displays, roles };
}

// 图片起始位置落在化学区间内即记角色（判据 a 与 c，见 docx-chemistry）
function markChemistry(chem, at, k) {
    if (inChemistryRange(chem.ranges, at)) chem.roles.set(k, CHEMISTRY_ROLE);
}

function parseImageMarker(alt) {
    const text = String(alt == null ? '' : alt);
    const matched = IMAGE_MARKER_RE.exec(text);
    if (!matched) return { index: null, alt: text };
    return { index: Number(matched[1]), alt: text.slice(matched[0].length) };
}

// 编辑按位置升序拼接成新串（O(n)），编辑区间互不重叠
function applyEdits(xml, edits) {
    const sorted = [...edits].sort((a, b) => a.at - b.at);
    const parts = [];
    let cursor = 0;
    for (const edit of sorted) {
        if (edit.at < cursor) continue;
        parts.push(xml.slice(cursor, edit.at), edit.insert);
        cursor = edit.at + edit.remove;
    }
    parts.push(xml.slice(cursor));
    return parts.join('');
}

// ============================================================
// 图片：DrawingML 与 VML
// ============================================================

function collectDrawingEdits(xml, edits, displays, counter, chem) {
    for (const block of findBlocks(xml, 'w:drawing')) {
        const body = xml.slice(block.start, block.end);
        if (!/<a:blip\b[^>]*\br:(?:embed|link)\s*=/.test(body)) continue;
        const docPrAt = body.search(/<wp:docPr(?=[\s/>])/);
        if (docPrAt < 0) continue;
        const docPr = readTag(body, docPrAt);
        if (!docPr) continue;
        counter.next += 1;
        const k = counter.next;
        markChemistry(chem, block.start, k);
        const extentAt = body.search(/<wp:extent(?=[\s/>])/);
        const extentTag = extentAt >= 0 ? readTag(body, extentAt) : null;
        const extent = extentTag ? attrsOf(body.slice(extentAt, extentTag.end + 1)) : new Map();
        displays.set(k, sizeOf(emuToPx(extent.get('cx')), emuToPx(extent.get('cy')), /<wp:anchor(?=[\s>])/.test(body), {
            width: emuToMm(extent.get('cx')),
            height: emuToMm(extent.get('cy')),
        }));
        edits.push(altEdit(xml, block.start + docPrAt, block.start + docPr.end + 1, k));
    }
}

// docPr 的 descr 写成「标记 + mammoth 原本会取的 alt」（descr 非空取 descr，否则取 title）
function altEdit(xml, tagStart, tagEnd, k) {
    const tag = xml.slice(tagStart, tagEnd);
    const attrs = attrsOf(tag);
    const descr = attrs.get('descr');
    const alt = descr && descr.trim() ? descr : (attrs.get('title') || '');
    const value = `${imageMarker(k)}${alt.replace(/"/g, '&quot;')}`;
    const existing = /\sdescr\s*=\s*("[^"]*"|'[^']*')/.exec(tag);
    if (existing) return { at: tagStart + existing.index, remove: existing[0].length, insert: ` descr="${value}"` };
    return { at: tagStart + '<wp:docPr'.length, remove: 0, insert: ` descr="${value}"` };
}

function collectVmlEdits(xml, edits, displays, counter, chem) {
    const re = /<v:imagedata(?=[\s/>])/g;
    for (let matched = re.exec(xml); matched; matched = re.exec(xml)) {
        const tag = readTag(xml, matched.index);
        if (!tag) break;
        const tagText = xml.slice(matched.index, tag.end + 1);
        const attrs = attrsOf(tagText);
        if (!attrs.get('r:id')) continue;
        counter.next += 1;
        const k = counter.next;
        markChemistry(chem, matched.index, k);
        const style = shapeStyleBefore(xml, matched.index);
        displays.set(k, sizeOf(cssLengthPx(style, 'width'), cssLengthPx(style, 'height'), /position\s*:\s*absolute/i.test(style), {
            width: cssLengthMm(style, 'width'),
            height: cssLengthMm(style, 'height'),
        }));
        const existing = /\so:title\s*=\s*("([^"]*)"|'([^']*)')/.exec(tagText);
        if (existing) {
            const title = (existing[2] ?? existing[3] ?? '').replace(/"/g, '&quot;');
            edits.push({ at: matched.index + existing.index, remove: existing[0].length, insert: ` o:title="${imageMarker(k)}${title}"` });
        } else {
            edits.push({ at: matched.index + '<v:imagedata'.length, remove: 0, insert: ` o:title="${imageMarker(k)}"` });
        }
    }
}

// 所属 v:shape 的 style（取 imagedata 之前最近的 <v:shape 开标签，不含 v:shapetype）
function shapeStyleBefore(xml, index) {
    const at = xml.lastIndexOf('<v:shape', index);
    if (at < 0 || !/[\s>]/.test(xml[at + '<v:shape'.length] || '')) return '';
    const tag = readTag(xml, at);
    return tag ? (attrsOf(xml.slice(at, tag.end + 1)).get('style') || '') : '';
}

// CSS 长度 → { value, unit }；取不到返回 null。单位缺省按 px（VML 的裸数字即 px）
function cssLength(style, prop) {
    const matched = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*(pt|in|cm|mm|px|pc)?`, 'i').exec(style);
    return matched ? { value: Number(matched[1]), unit: String(matched[2] || 'px').toLowerCase() } : null;
}

function cssLengthPx(style, prop) {
    const length = cssLength(style, prop);
    return length ? Math.round(length.value * (PX_PER_UNIT[length.unit] || 1)) : 0;
}

// 毫米不取整：物理尺寸要参与 300 DPI 目标像素的换算，先取整会把误差放大数倍
function cssLengthMm(style, prop) {
    const length = cssLength(style, prop);
    return length ? length.value * (MM_PER_UNIT[length.unit] || MM_PER_UNIT.px) : 0;
}

const emuToPx = (value) => {
    const emu = Number(value);
    return Number.isFinite(emu) && emu > 0 ? Math.round(emu / EMU_PER_PX) : 0;
};

const emuToMm = (value) => {
    const emu = Number(value);
    return Number.isFinite(emu) && emu > 0 ? (emu / EMU_PER_INCH) * INCH_MM : 0;
};

// px 取整后 ≥ 1 才写，mm 为正即写；两者取不到时各自省略，下游据此判定是否有显示尺寸
function sizeOf(width, height, floating, mm = {}) {
    const size = { width: width >= 1 ? width : 0 };
    if (height >= 1) size.height = height;
    size.floating = Boolean(floating);
    if (mm.width > 0) size.widthMm = mm.width;
    if (mm.height > 0) size.heightMm = mm.height;
    return size;
}

function attrsOf(tagText) {
    const attrs = new Map();
    const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (let matched = re.exec(tagText); matched; matched = re.exec(tagText)) {
        if (!attrs.has(matched[1])) attrs.set(matched[1], matched[2] ?? matched[3] ?? '');
    }
    return attrs;
}

// ============================================================
// 段落：首行缩进与题注
// ============================================================

function collectParagraphEdits(xml, styles, edits) {
    const re = /<w:p(?=[\s>/])/g;
    for (let matched = re.exec(xml); matched; matched = re.exec(xml)) {
        const open = readTag(xml, matched.index);
        if (!open) break;
        if (open.selfClosing) continue;
        const contentStart = open.end + 1;
        const close = findCloseTag(xml, 'w:p', contentStart);
        if (close < 0) continue;
        const pPr = readParagraphProperties(xml, contentStart);
        const body = xml.slice(contentStart, close);
        if (!hasText(body)) continue;
        const props = paragraphProps(pPr ? pPr.text : '', body);
        const markers = paragraphMarkers(props, styles);
        if (!markers) continue;
        edits.push({ at: pPr ? pPr.end : contentStart, remove: 0, insert: `<w:r><w:t xml:space="preserve">${markers}</w:t></w:r>` });
    }
}

// pPr 必为 w:p 的首个子元素
function readParagraphProperties(xml, from) {
    let at = from;
    while (at < xml.length && /\s/.test(xml[at])) at += 1;
    if (!xml.startsWith('<w:pPr', at) || !/[\s/>]/.test(xml[at + '<w:pPr'.length] || '')) return null;
    const tag = readTag(xml, at);
    if (!tag) return null;
    if (tag.selfClosing) return { end: tag.end + 1, text: '' };
    const end = findCloseTag(xml, 'w:pPr', tag.end + 1);
    return end < 0 ? null : { end, text: xml.slice(at, end) };
}

function hasText(body) {
    TEXT_RUN_RE.lastIndex = 0;
    for (let matched = TEXT_RUN_RE.exec(body); matched; matched = TEXT_RUN_RE.exec(body)) {
        if (/\S/.test(matched[1].replace(MATH_SENTINEL_RE, ''))) return true;
    }
    return false;
}

function paragraphProps(pPrText, body) {
    // 修订记录里的旧属性（w:pPrChange）不参与判定
    const text = pPrText.replace(/<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/g, '');
    const numId = /<w:numId\b[^>]*\bw:val="(\d+)"/.exec(text);
    const indTag = /<w:ind\b[^>]*>/.exec(text);
    const markRpr = /<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/.exec(text);
    const runRpr = /<w:r\b[^>]*>\s*<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/.exec(body);
    return {
        styleId: attrValue(text, 'w:pStyle'),
        ind: indTag ? indAttrs(attrsOf(indTag[0])) : null,
        numbered: numId ? numId[1] !== '0' : (/<w:numPr\b/.test(text) ? true : undefined),
        outlineLvl: toInt(attrValue(text, 'w:outlineLvl')),
        sz: toInt(attrValue(runRpr ? runRpr[1] : '', 'w:sz')) ?? toInt(attrValue(markRpr ? markRpr[1] : '', 'w:sz')),
    };
}

function paragraphMarkers(props, styles) {
    const chain = styleChain(styles, props.styleId || styles.defaultParagraphId);
    const caption = chain.some((style) => style.isCaption);
    const heading = isHeadingLevel(props.outlineLvl) || chain.some((style) => style.isHeading || isHeadingLevel(style.outlineLvl));
    const numbered = props.numbered === undefined ? chain.some((style) => style.numbered) : props.numbered;
    const indent = heading || numbered ? 0 : firstLineChars(props, chain, styles.defaults);
    return `${indent > 0 ? indentMarker(indent) : ''}${caption ? MARKERS.CAPTION : ''}`;
}

const isHeadingLevel = (level) => Number.isInteger(level) && level >= 0 && level < BODY_OUTLINE_LEVEL;

// firstLine 与 hanging 同属「首行偏移」一项、Chars 变体又是另一项：各取最近一处声明它的层级；字符单位优先
function firstLineChars(props, chain, defaults) {
    const levels = [props.ind, ...chain.map((style) => style.ind), defaults.ind].filter(Boolean);
    const chars = levels.find((ind) => ind.firstLineChars !== undefined || ind.hangingChars !== undefined);
    const twips = levels.find((ind) => ind.firstLine !== undefined || ind.hanging !== undefined);
    if (chars && chars.hangingChars > 0) return 0;
    if (chars && chars.firstLineChars > 0) return clampChars(chars.firstLineChars / CHARS_UNIT);
    if (!twips || twips.hanging > 0 || !(twips.firstLine > 0)) return 0;
    const halfPoints = props.sz || (chain.find((style) => style.sz) || {}).sz || defaults.sz || DEFAULT_HALF_POINTS;
    return clampChars(twips.firstLine / (halfPoints * TWIPS_PER_HALF_POINT));
}

function clampChars(value) {
    const rounded = Math.round(value);
    if (!Number.isFinite(rounded) || rounded < 1) return 0;
    return Math.min(MAX_INDENT_CHARS, rounded);
}

function indAttrs(attrs) {
    return {
        firstLine: toInt(attrs.get('w:firstLine')),
        firstLineChars: toInt(attrs.get('w:firstLineChars')),
        hanging: toInt(attrs.get('w:hanging')),
        hangingChars: toInt(attrs.get('w:hangingChars')),
    };
}

function attrValue(text, tagName) {
    const matched = new RegExp(`<${tagName}\\b[^>]*\\bw:val="([^"]*)"`).exec(text);
    return matched ? matched[1] : undefined;
}

function toInt(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const number = parseInt(value, 10);
    return Number.isFinite(number) ? number : undefined;
}

// ============================================================
// 制表符
// ============================================================

function collectTabEdits(xml, edits) {
    const re = /<w:tab\s*\/>/g;
    for (let matched = re.exec(xml); matched; matched = re.exec(xml)) {
        edits.push({ at: matched.index, remove: matched[0].length, insert: `<w:t xml:space="preserve">${MARKERS.TAB}</w:t>` });
    }
}

// ============================================================
// styles.xml
// ============================================================

const sel = (name) => name.replace(/:/g, '\\:');

function readStyles(xml) {
    const empty = { byId: new Map(), defaults: {}, defaultParagraphId: null };
    if (!xml) return empty;
    let $;
    try {
        $ = cheerio.load(xml, { xmlMode: true });
    } catch (err) {
        return empty;
    }
    const byId = new Map();
    let defaultParagraphId = null;
    $(sel('w:style')).each((_, node) => {
        const $node = $(node);
        const id = $node.attr('w:styleId');
        const type = $node.attr('w:type');
        if (!id || (type && type !== 'paragraph')) return;
        const name = $node.children(sel('w:name')).attr('w:val') || '';
        const $pPr = $node.children(sel('w:pPr'));
        const $ind = $pPr.children(sel('w:ind')).first();
        const numId = $pPr.children(sel('w:numPr')).children(sel('w:numId')).attr('w:val');
        byId.set(id, {
            id,
            basedOn: $node.children(sel('w:basedOn')).attr('w:val') || null,
            ind: $ind.length ? indAttrs(new Map(Object.entries($ind.attr() || {}))) : null,
            numbered: $pPr.children(sel('w:numPr')).length > 0 && numId !== '0',
            outlineLvl: toInt($pPr.children(sel('w:outlineLvl')).attr('w:val')),
            sz: toInt($node.children(sel('w:rPr')).children(sel('w:sz')).attr('w:val')),
            isHeading: HEADING_NAME_RE.test(name) || HEADING_ID_RE.test(id),
            isCaption: CAPTION_NAME_RE.test(name.trim()),
        });
        const isDefault = $node.attr('w:default');
        if (isDefault === '1' || isDefault === 'true') defaultParagraphId = id;
    });
    const $ind = $(`${sel('w:pPrDefault')} ${sel('w:ind')}`).first();
    return {
        byId,
        defaultParagraphId,
        defaults: {
            ind: $ind.length ? indAttrs(new Map(Object.entries($ind.attr() || {}))) : null,
            sz: toInt($(`${sel('w:rPrDefault')} ${sel('w:sz')}`).first().attr('w:val')),
        },
    };
}

function styleChain(styles, id) {
    const chain = [];
    const seen = new Set();
    for (let current = id; current && styles.byId.has(current) && !seen.has(current) && chain.length < MAX_STYLE_DEPTH;) {
        seen.add(current);
        const style = styles.byId.get(current);
        chain.push(style);
        current = style.basedOn;
    }
    return chain;
}

module.exports = { prepareLayout, parseImageMarker };
