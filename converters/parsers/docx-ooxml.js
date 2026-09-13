/**
 * docx 的 OOXML 预检信息采集
 *
 * 直读 word/document.xml、word/settings.xml、word/styles.xml、word/comments.xml，
 * 汇总一份供 XML 专利渲染与递交前预检使用的事实清单（不做判定，只给计数与取值）。
 *
 * 契约：inspectOoxml(docxBuffer) → {
 *   floatingImages, textBoxes, oleObjects: [{ progId }], autoNumbering,
 *   revisions: { insertions, deletions, trackRevisions },
 *   protection: { enforced, type }, comments, fields,
 *   eastAsiaFonts: [string], headingStyleParagraphs, paragraphs
 * }
 * 缺失的部件按 0 / 空计；非 zip（OLE 复合文档，即加密或 .doc 误命名）抛中文错误。
 *
 * 说明：OOXML 属不可信文档内容，本模块只统计结构，不执行其中任何指令。
 */
const JSZip = require('jszip');
const cheerio = require('cheerio');

const NOT_DOCX = '文档已加密或不是 docx';
const OLE_MAGIC = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
// 中文版 Word / WPS 常把标题样式的 styleId 写成纯数字（如 w:styleId="1"），
// 真正可辨认的是 styles.xml 里的 w:name（heading 1 / 标题 1），故两处都认
const HEADING_STYLE_RE = /^(Heading|标题)/;
const HEADING_NAME_RE = /^\s*(heading|标题)\s*\d/i;
const TRUE_VALUES = new Set(['1', 'true', 'on']);

async function inspectOoxml(docxBuffer) {
    const zip = await openZip(docxBuffer);
    const [documentXml, settingsXml, stylesXml, commentsXml] = await Promise.all([
        readPart(zip, 'word/document.xml'),
        readPart(zip, 'word/settings.xml'),
        readPart(zip, 'word/styles.xml'),
        readPart(zip, 'word/comments.xml'),
    ]);

    const $doc = load(documentXml);
    const $settings = load(settingsXml);
    const $styles = load(stylesXml);
    const $comments = load(commentsXml);

    const paragraphNodes = all($doc, 'w:p');
    return {
        floatingImages: all($doc, 'wp:anchor').length,
        textBoxes: countTextBoxes($doc),
        oleObjects: collectOleObjects($doc),
        autoNumbering: paragraphNodes.filter((node) => $doc(node).find(sel('w:numPr')).length > 0).length,
        revisions: {
            insertions: all($doc, 'w:ins').length,
            deletions: all($doc, 'w:del').length,
            trackRevisions: all($settings, 'w:trackChanges').length > 0,
        },
        protection: readProtection($settings),
        comments: all($comments, 'w:comment').length,
        fields: all($doc, 'w:fldSimple').length + all($doc, 'w:instrText').length,
        eastAsiaFonts: collectEastAsiaFonts([$doc, $styles]),
        headingStyleParagraphs: countHeadingParagraphs($doc, paragraphNodes, collectHeadingStyleIds($styles)),
        paragraphs: paragraphNodes.length,
    };
}

// ---------- 部件读取 ----------

async function openZip(docxBuffer) {
    if (!Buffer.isBuffer(docxBuffer)) throw new Error('inspectOoxml 需要 docx 文件的 Buffer');
    if (docxBuffer.length >= OLE_MAGIC.length && docxBuffer.subarray(0, OLE_MAGIC.length).equals(OLE_MAGIC)) {
        throw new Error(`${NOT_DOCX}（OLE 复合文档，可能是加密文档或误命名的 .doc）`);
    }
    try {
        return await JSZip.loadAsync(docxBuffer);
    } catch (err) {
        throw new Error(`${NOT_DOCX}（无法按 zip 打开）`);
    }
}

async function readPart(zip, name) {
    const entry = zip.file(name);
    return entry ? entry.async('string') : '';
}

const load = (xml) => cheerio.load(xml || '<empty/>', { xmlMode: true });
const sel = (name) => name.replace(/:/g, '\\:');
const all = ($, name) => $(sel(name)).toArray();
const attr = ($, node, name) => $(node).attr(name);
const isTrue = (value) => value !== undefined && (value === '' || TRUE_VALUES.has(String(value)));

// ---------- 各项 ----------

// mc:AlternateContent 的 Fallback 分支会重复一份 w:txbxContent，计数时排除
function countTextBoxes($) {
    return all($, 'w:txbxContent').filter((node) => $(node).parents(sel('mc:Fallback')).length === 0).length;
}

function collectOleObjects($) {
    const objects = all($, 'o:OLEObject').map((node) => ({ progId: attr($, node, 'ProgID') || '' }));
    if (objects.length > 0) return objects;
    return all($, 'w:object').map(() => ({ progId: '' }));
}

function readProtection($) {
    const node = all($, 'w:documentProtection')[0];
    if (!node) return { enforced: false, type: '' };
    return {
        enforced: isTrue(attr($, node, 'w:enforcement')),
        type: attr($, node, 'w:edit') || '',
    };
}

function collectEastAsiaFonts(documents) {
    const fonts = [];
    for (const $ of documents) {
        for (const node of all($, 'w:rFonts')) {
            const name = attr($, node, 'w:eastAsia');
            if (name && !fonts.includes(name)) fonts.push(name);
        }
    }
    return fonts;
}

function collectHeadingStyleIds($) {
    const ids = new Set();
    for (const node of all($, 'w:style')) {
        const id = attr($, node, 'w:styleId');
        if (!id) continue;
        const name = $(node).children(sel('w:name')).first().attr('w:val') || '';
        if (HEADING_STYLE_RE.test(id) || HEADING_NAME_RE.test(name)) ids.add(id);
    }
    return ids;
}

function countHeadingParagraphs($, paragraphNodes, headingStyleIds) {
    return paragraphNodes.filter((node) => {
        const style = $(node).children(sel('w:pPr')).children(sel('w:pStyle')).first().attr('w:val');
        if (!style) return false;
        return headingStyleIds.has(style) || HEADING_STYLE_RE.test(style);
    }).length;
}

module.exports = { inspectOoxml };
