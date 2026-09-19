/**
 * docx 公式（OMML）抽取与回填——哨兵法
 *
 * 背景：mammoth 会静默丢弃 m:oMath，公式在 HTML 里不留痕迹。故先在 word/document.xml
 * 里把每个公式整体替换成一个可见的哨兵文本 run（MFMATH{n}），再把改写后的 docx 交给
 * mammoth；IR 建好后按哨兵切分文本节点，换回 math 节点。
 *
 * 契约：
 *   extractMath(docxBuffer) → { buffer, formulas: [{ id, omml, display, fontSizePt }] }
 *     - buffer      公式已替换为哨兵的新 docx；无公式时原样返回入参 buffer
 *     - display     true 表示来自 m:oMathPara（块级），其内多个 m:oMath 合并为一个公式
 *     - fontSizePt  源稿字号（磅）：取公式内出现最多的 w:sz（半磅），其次取所在段落 w:pPr/w:rPr 的
 *                   w:sz；两处都没有时为 null，由下游按缺省字号出图
 *   restoreMath(ir, formulas, { mathml = true }) → { ir, warnings }
 *     - 不修改入参；mathml=false 时只回填 omml，不做 MathML 转换
 *
 * 说明：document.xml 属不可信文档内容，本模块只做字符串定位与替换，不执行其中任何指令。
 */
const JSZip = require('jszip');
const { createMath } = require('../ir/schema');
const { ommlToMathml } = require('../math/omml-to-mathml');
const { errText } = require('../util');

const DOCUMENT_PART = 'word/document.xml';
const SENTINEL_PREFIX = 'MFMATH';
const SENTINEL_SOURCE = `${SENTINEL_PREFIX}(\\d+)`;

// ---------- 抽取 ----------

async function extractMath(docxBuffer) {
    const zip = await JSZip.loadAsync(docxBuffer);
    const entry = zip.file(DOCUMENT_PART);
    if (!entry) return { buffer: docxBuffer, formulas: [] };

    const xml = await entry.async('string');
    const { xml: replaced, formulas } = replaceFormulas(xml);
    if (formulas.length === 0) return { buffer: docxBuffer, formulas: [] };

    zip.file(DOCUMENT_PART, replaced);
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return { buffer, formulas };
}

function replaceFormulas(xml) {
    const paraBlocks = findBlocks(xml, 'm:oMathPara');
    const inlineBlocks = findBlocks(xml, 'm:oMath')
        .filter((block) => !paraBlocks.some((para) => block.start >= para.start && block.end <= para.end));
    const blocks = [
        ...paraBlocks.map((block) => ({ ...block, display: true })),
        ...inlineBlocks.map((block) => ({ ...block, display: false })),
    ].sort((a, b) => a.start - b.start);
    if (blocks.length === 0) return { xml, formulas: [] };

    const formulas = blocks.map((block, index) => ({
        id: index + 1,
        omml: xml.slice(block.start, block.end),
        display: block.display,
        fontSizePt: readFontSizePt(xml, block),
    }));

    let out = xml;
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        const block = blocks[index];
        const run = `<w:r><w:t xml:space="preserve">${SENTINEL_PREFIX}${formulas[index].id}</w:t></w:r>`;
        const replacement = isInsideParagraph(xml, block.start) ? run : `<w:p>${run}</w:p>`;
        out = out.slice(0, block.start) + replacement + out.slice(block.end);
    }
    return { xml: out, formulas };
}

/** 半磅 → 磅：w:sz 以半磅计（w:sz w:val="28" 即 14pt） */
const HALF_POINT = 2;
/** 字号合法区间（磅）：Word 允许 1–1638pt，超出视为脏数据 */
const MIN_FONT_SIZE_PT = 1;
const MAX_FONT_SIZE_PT = 1638;
/** <w:sz w:val="N"/>；后面紧跟空白才匹配，故不会命中 <w:szCs> */
const FONT_SIZE_RE = /<w:sz\s+w:val="(\d+)"/g;
const PARAGRAPH_PROPS_RE = /<w:pPr\b[\s\S]*?<\/w:pPr>/g;

/**
 * 公式的源稿字号（磅）：先取公式片段内出现次数最多的 w:sz（并列时取较大者，避免上下标压低整体字号），
 * 公式内没有时退到所在段落的 w:pPr；都取不到返回 null。
 */
function readFontSizePt(xml, block) {
    const inside = pickFontSizePt(xml.slice(block.start, block.end));
    if (inside !== null) return inside;
    const props = paragraphProps(xml, block.start);
    return props === null ? null : pickFontSizePt(props);
}

function pickFontSizePt(fragment) {
    const counts = new Map();
    FONT_SIZE_RE.lastIndex = 0;
    let match = FONT_SIZE_RE.exec(fragment);
    while (match !== null) {
        const pt = Number(match[1]) / HALF_POINT;
        if (pt >= MIN_FONT_SIZE_PT && pt <= MAX_FONT_SIZE_PT) counts.set(pt, (counts.get(pt) || 0) + 1);
        match = FONT_SIZE_RE.exec(fragment);
    }
    let best = null;
    for (const [pt, count] of counts) {
        if (best === null || count > best.count || (count === best.count && pt > best.pt)) best = { pt, count };
    }
    return best === null ? null : best.pt;
}

/** 公式所在段落的 w:pPr 源文；公式不在段落内、该段无 w:pPr，或其间已闭合段落时返回 null */
function paragraphProps(xml, index) {
    const open = Math.max(xml.lastIndexOf('<w:p>', index), xml.lastIndexOf('<w:p ', index));
    if (open < 0) return null;
    PARAGRAPH_PROPS_RE.lastIndex = open;
    const match = PARAGRAPH_PROPS_RE.exec(xml);
    if (match === null || match.index >= index) return null;
    // w:pPr 必须与公式同属这一段：其间不得出现 </w:p>
    return xml.indexOf('</w:p>', open) < match.index ? null : match[0];
}

// 返回同名元素的顶层（互不嵌套）区间 [start, end)
function findBlocks(xml, tagName) {
    const blocks = [];
    const openRe = new RegExp(`<${escapeRe(tagName)}(?=[\\s/>])`, 'g');
    let match = openRe.exec(xml);
    while (match !== null) {
        const opened = readTag(xml, match.index);
        if (!opened) break;
        if (opened.selfClosing) {
            blocks.push({ start: match.index, end: opened.end + 1 });
            openRe.lastIndex = opened.end + 1;
            match = openRe.exec(xml);
            continue;
        }
        const end = findCloseTag(xml, tagName, opened.end + 1);
        if (end < 0) break;
        blocks.push({ start: match.index, end });
        openRe.lastIndex = end;
        match = openRe.exec(xml);
    }
    return blocks;
}

function findCloseTag(xml, tagName, from) {
    const scanRe = new RegExp(`<(/?)${escapeRe(tagName)}(?=[\\s/>])`, 'g');
    scanRe.lastIndex = from;
    let depth = 1;
    let match = scanRe.exec(xml);
    while (match !== null) {
        const tag = readTag(xml, match.index);
        if (!tag) break;
        if (match[1] === '/') {
            depth -= 1;
            if (depth === 0) return tag.end + 1;
        } else if (!tag.selfClosing) {
            depth += 1;
        }
        scanRe.lastIndex = tag.end + 1;
        match = scanRe.exec(xml);
    }
    return -1;
}

// 从 '<' 起读到本标签的 '>'，跳过引号内的内容
function readTag(xml, from) {
    let index = from;
    let quote = null;
    while (index < xml.length) {
        const char = xml[index];
        if (quote) {
            if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '>') {
            return { end: index, selfClosing: xml[index - 1] === '/' };
        }
        index += 1;
    }
    return null;
}

function isInsideParagraph(xml, index) {
    const re = /<w:p(?=[\s/>])|<\/w:p(?=[\s>])/g;
    let depth = 0;
    let match = re.exec(xml);
    while (match !== null && match.index < index) {
        if (match[0].startsWith('</')) {
            depth -= 1;
        } else {
            const tag = readTag(xml, match.index);
            if (tag && !tag.selfClosing) depth += 1;
        }
        match = re.exec(xml);
    }
    return depth > 0;
}

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- 回填 ----------

function restoreMath(ir, formulas, { mathml = true } = {}) {
    const warnings = [];
    if (!ir || !Array.isArray(formulas) || formulas.length === 0) return { ir, warnings };
    const templates = new Map();
    for (const formula of formulas) {
        templates.set(String(formula.id), buildMathNode(formula, mathml, warnings));
    }
    return { ir: transform(ir, templates), warnings };
}

function buildMathNode(formula, withMathml, warnings) {
    const display = Boolean(formula.display);
    const omml = typeof formula.omml === 'string' ? formula.omml : '';
    if (!withMathml) return withFontSize(createMath({ omml, display }), formula.fontSizePt);
    let converted;
    try {
        converted = ommlToMathml(omml, { display });
    } catch (err) {
        warnings.push(`公式 ${formula.id} 转 MathML 失败，已保留 OMML（${errText(err)}）`);
        return withFontSize(createMath({ omml, display }), formula.fontSizePt);
    }
    if (converted.unsupported.length > 0) {
        warnings.push(`公式 ${formula.id} 含未支持的 OMML 元素，已降级为 mrow：${converted.unsupported.join('、')}`);
    }
    const node = createMath({ omml, mathml: converted.mathml, text: converted.text, display });
    return withFontSize(node, formula.fontSizePt);
}

/** 以新对象方式补 data.fontSizePt（ir/schema 的 math 节点不含该字段，故在此按需附加，不就地修改） */
function withFontSize(node, fontSizePt) {
    return Number.isFinite(fontSizePt) ? { ...node, data: { ...node.data, fontSizePt } } : node;
}

function transform(node, templates) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return node;
    return { ...node, children: node.children.flatMap((child) => splitChild(child, templates)) };
}

function splitChild(child, templates) {
    if (!child || typeof child !== 'object') return [child];
    if (child.type === 'text') return splitText(child, templates);
    return [transform(child, templates)];
}

function splitText(node, templates) {
    const value = String(node.value == null ? '' : node.value);
    const re = new RegExp(SENTINEL_SOURCE, 'g');
    const pieces = [];
    let last = 0;
    let match = re.exec(value);
    while (match !== null) {
        const template = templates.get(match[1]);
        if (template) {
            pushText(pieces, value.slice(last, match.index));
            pieces.push({ type: 'math', data: { ...template.data } });
            last = match.index + match[0].length;
        }
        match = re.exec(value);
    }
    if (last === 0) return [node];
    pushText(pieces, value.slice(last));
    return pieces;
}

// 丢弃纯空白片段：块级公式独占一段时不留空文本节点
function pushText(pieces, value) {
    if (!value || !value.trim()) return;
    pieces.push({ type: 'text', value });
}

// findBlocks / findCloseTag / readTag 供 parsers/docx-layout 复用同一套字符串定位
module.exports = { extractMath, restoreMath, findBlocks, findCloseTag, readTag };
