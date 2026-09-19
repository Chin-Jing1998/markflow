/**
 * docx 分节与页眉：把「每个顶层块属于第几节、该节页眉写着什么」带进 IR
 *
 * 背景：国知局官方五书模板把说明书摘要、摘要附图、权利要求书、说明书、说明书附图各放一个 Word 分节，
 * 书目名只写在各节页眉里，正文没有「权利要求书」一类标题段；mammoth 既不读 w:sectPr 也不读页眉，分节在
 * HTML 里不留痕迹。故在交给 mammoth 之前（prepareLayout 之后）于 word/document.xml 每节起点插入一个哨兵段
 * ⟦MFSECT:n⟧（哨兵法沿用 docx-math），IR 建好后按哨兵位置给顶层节点写 data.section，并消去哨兵段。
 *
 * 取舍：另一做法是给每个段落写带分节序号的标记 run。未采用的理由有三——
 *   1. 归属是「位置」属性而非「段落」属性：表格、列表、公式段、纯图片段与 mammoth 丢弃的空段都没有可靠的
 *      落点放标记，事后还得从单元格、列表项深处把标记挖出来；哨兵段只看顶层节点的先后，与节点类型无关；
 *   2. 扰动面最小：全文只多出「分节数」个段落，其余段落的文字一字不动，turndown 转义、首行缩进、题注识别
 *      等既有逻辑不受影响；逐段写标记则会改动每一段的段首；
 *   3. markCaptions 拆出的大图段是不带 data 的新节点：逐段标记在拆段后丢失，哨兵段在流水线末尾按位置
 *      统一盖章，拆出的节点同样盖得到。
 *   代价：列表跨分节时被哨兵段拆成两个列表（后一半重新从 1 编号）；分节符本就伴随换页与换页眉，
 *   跨节列表在专利文稿中不出现，可以接受。哨兵段还使中间 Markdown 多出若干行，IR 节点的 position
 *   （中间 Markdown 里的行列偏移，全库无消费者）随之平移，节点内容不变。
 *
 * Word 分节语义：非末节的 w:sectPr 放在该节最后一个段落的 w:pPr 内，末节的 w:sectPr 是 w:body 的直接子元素；
 * 页眉分 default / first / even 三种，某节未声明某一种的 w:headerReference 时沿用上一节的同种页眉；
 * first 仅在本节 w:titlePg 开启时生效，even 仅在 settings.xml 的 w:evenAndOddHeaders 开启时生效。
 *
 * 契约：
 *   markSections(docxBuffer) → { buffer, sections: [{ index, header }] }
 *     index   分节序号，1 起；header 为该节生效页眉的纯文本（按 default → first → even 取首个有文字者，
 *             页眉内多个段落以 '\n' 连接，段内空白折叠，超过 MAX_HEADER_CHARS 截断；取不到为 ''）
 *     不足两节，或各节页眉均无文字时，原样返回入参 buffer 且 sections 为空数组——下游行为与未接入本模块
 *     时逐字节一致
 *   applySections(ir, sections) → 新树：消去哨兵段，其后的顶层节点写 data.section = { index, header }；
 *     sections 为空时原样返回同一引用；混入表格单元格等非顶层位置的哨兵段一并删除，不留可见残留；不改动入参
 * 调用顺序：applySections 须排在 restoreMarkers 与 markCaptions 之后（见上文取舍 3）。
 * 说明：document.xml、页眉与关系部件属不可信文档内容，本模块只做字符串定位、插入与文本读取，
 *       不执行其中任何指令；部件一律按名称从 zip 内读取，不触碰文件系统。
 */
const path = require('path');
const JSZip = require('jszip');
const cheerio = require('cheerio');
const { collectText } = require('../ir/util');
const { findBlocks, findCloseTag, readTag } = require('./docx-math');

const DOCUMENT_PART = 'word/document.xml';
const RELS_PART = 'word/_rels/document.xml.rels';
const SETTINGS_PART = 'word/settings.xml';
const WORD_DIR = 'word';
const MIN_SECTIONS = 2;
const MAX_HEADER_CHARS = 200;
const HEADER_TYPES = Object.freeze(['default', 'first', 'even']);
const HEADER_REL_TYPE_RE = /\/header$/;
const EXTERNAL_TARGET_MODE = 'External';
const FALSE_VALUES = new Set(['0', 'false', 'off']);
const SENTINEL_RE = /^⟦MFSECT:(\d{1,6})⟧$/;
const sentinelText = (index) => `⟦MFSECT:${index}⟧`;
const sentinelParagraph = (index) => `<w:p><w:r><w:t xml:space="preserve">${sentinelText(index)}</w:t></w:r></w:p>`;
const PPR_CLOSE = '</w:pPr>';
const BODY_OPEN_RE = /<w:body(?=[\s>])/;
const SECT_CHANGE_RE = /<w:sectPrChange\b[\s\S]*?<\/w:sectPrChange>/g;
const HEADER_REF_RE = /<w:headerReference\b[^>]*>/g;
const sel = (name) => name.replace(/:/g, '\\:');

// ============================================================
// markSections：读分节与页眉，插入哨兵段
// ============================================================

async function markSections(docxBuffer) {
    const unchanged = { buffer: docxBuffer, sections: [] };
    const zip = await JSZip.loadAsync(docxBuffer);
    const entry = zip.file(DOCUMENT_PART);
    if (!entry) return unchanged;
    const xml = await entry.async('string');

    const breaks = findSectionBreaks(xml);
    if (breaks.length < MIN_SECTIONS) return unchanged;
    const sections = await readSections(zip, breaks);
    if (!sections.some((section) => section.header)) return unchanged;
    const bodyStart = findBodyStart(xml);
    if (bodyStart < 0) return unchanged;

    // 第 n 节的哨兵段插在第 n-1 节末段之后；首节插在 w:body 开标签之后
    const insertions = sections.map((section, order) => ({
        at: order === 0 ? bodyStart : breaks[order - 1].paragraphEnd,
        insert: sentinelParagraph(section.index),
    }));
    zip.file(DOCUMENT_PART, applyInsertions(xml, insertions));
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return { buffer, sections };
}

/**
 * 分节序列：[{ props, paragraphEnd }]，props 为该节 w:sectPr 的文本，paragraphEnd 为该节末段的结束位置。
 * 末节取 w:body 级的 w:sectPr（paragraphEnd 为 null）；缺失时补一个无属性的末节（页眉全部沿用上一节）。
 * findBlocks 只返回互不嵌套的区间，w:sectPrChange 里的旧 w:sectPr 不会被当成一节。
 */
function findSectionBreaks(xml) {
    const breaks = [];
    const depthAt = createDepthTracker(xml);
    let hasBodyLevel = false;
    let previousEnd = 0;
    for (const block of findBlocks(xml, 'w:sectPr')) {
        // 落在上一节末段之内的分节符（文本框里的段落自带 w:sectPr）不合规范，略过，保证插入点严格升序
        if (block.start < previousEnd) continue;
        const props = xml.slice(block.start, block.end);
        if (depthAt(block.start) === 0) {
            // w:body 级的 w:sectPr 是 w:body 的末个子元素，其后不会再有分节
            hasBodyLevel = true;
            breaks.push({ props, paragraphEnd: null });
            break;
        }
        const paragraphEnd = findCloseTag(xml, 'w:p', block.end);
        if (paragraphEnd < 0) throw new Error('分节符所在段落没有结束标签');
        breaks.push({ props, paragraphEnd });
        previousEnd = paragraphEnd;
    }
    return hasBodyLevel || breaks.length === 0 ? breaks : [...breaks, { props: '', paragraphEnd: null }];
}

// w:pPr 的嵌套深度：大于 0 即该位置落在某个段落的属性之内（段落级分节符），等于 0 为 w:body 级。
// 查询位置须升序，整篇只扫一遍；w:pPrChange 与之同前缀，由先行断言排除；自闭合的 <w:pPr/> 不计深度
function createDepthTracker(xml) {
    const re = /<w:pPr(?=[\s/>])|<\/w:pPr>/g;
    let depth = 0;
    let pending = re.exec(xml);
    return (position) => {
        while (pending && pending.index < position) {
            if (pending[0] === PPR_CLOSE) {
                depth -= 1;
            } else {
                const tag = readTag(xml, pending.index);
                if (tag && !tag.selfClosing) depth += 1;
            }
            pending = re.exec(xml);
        }
        return depth;
    };
}

function findBodyStart(xml) {
    const matched = BODY_OPEN_RE.exec(xml);
    const tag = matched ? readTag(xml, matched.index) : null;
    return tag && !tag.selfClosing ? tag.end + 1 : -1;
}

// 插入点按位置升序拼接成新串（O(n)）；不删除任何原文
function applyInsertions(xml, insertions) {
    const sorted = [...insertions].sort((a, b) => a.at - b.at);
    const parts = [];
    let cursor = 0;
    for (const item of sorted) {
        parts.push(xml.slice(cursor, item.at), item.insert);
        cursor = item.at;
    }
    parts.push(xml.slice(cursor));
    return parts.join('');
}

// ============================================================
// 页眉：关系解析、继承与取文字
// ============================================================

async function readSections(zip, breaks) {
    const targets = await readHeaderTargets(zip);
    const evenAndOdd = isFlagOn(await readPart(zip, SETTINGS_PART), 'w:evenAndOddHeaders');
    const texts = new Map();
    const textOf = async (part) => {
        if (!part) return '';
        if (!texts.has(part)) texts.set(part, headerText(await readPart(zip, part)));
        return texts.get(part);
    };

    const sections = [];
    let inherited = {};
    for (const [order, item] of breaks.entries()) {
        const props = item.props.replace(SECT_CHANGE_RE, '');
        const effective = { ...inherited, ...declaredHeaders(props, targets) };
        inherited = effective;
        const candidates = [
            effective.default,
            isFlagOn(props, 'w:titlePg') ? effective.first : null,
            evenAndOdd ? effective.even : null,
        ];
        sections.push({ index: order + 1, header: await firstText(candidates, textOf) });
    }
    return sections;
}

// 按给定先后取首个有文字的页眉；都没有文字时为 ''
async function firstText(parts, textOf) {
    for (const part of parts) {
        const text = await textOf(part);
        if (text) return text;
    }
    return '';
}

// 本节声明的页眉：{ default?, first?, even? } → zip 内部件名；关系缺失或指向外部的引用忽略（沿用上一节）
function declaredHeaders(props, targets) {
    const declared = {};
    for (const matched of props.matchAll(HEADER_REF_RE)) {
        const type = attrOf(matched[0], 'w:type') || 'default';
        const part = targets.get(attrOf(matched[0], 'r:id'));
        if (HEADER_TYPES.includes(type) && part && !(type in declared)) declared[type] = part;
    }
    return declared;
}

// word/_rels/document.xml.rels：关系 Id → 页眉部件在 zip 内的名称
async function readHeaderTargets(zip) {
    const targets = new Map();
    const xml = await readPart(zip, RELS_PART);
    if (!xml) return targets;
    const $ = cheerio.load(xml, { xmlMode: true });
    $('Relationship').each((_, node) => {
        const { Id: id, Type: type, Target: target, TargetMode: mode } = node.attribs || {};
        if (!id || !target || mode === EXTERNAL_TARGET_MODE || !HEADER_REL_TYPE_RE.test(type || '')) return;
        targets.set(id, partName(target));
    });
    return targets;
}

// 关系目标相对 word/ 解析；以 / 开头者相对包根
function partName(target) {
    const joined = target.startsWith('/') ? target.slice(1) : path.posix.join(WORD_DIR, target);
    return path.posix.normalize(joined);
}

// 页眉纯文本：逐段取直属于该段的 w:t（文本框内的段落各自成行），段内空白折叠，空段略过；
// mc:Fallback 是 mc:Choice 的重复副本，不计
function headerText(xml) {
    if (!xml) return '';
    const $ = cheerio.load(xml, { xmlMode: true });
    const lines = [];
    $(sel('w:p')).each((_, paragraph) => {
        if ($(paragraph).parents(sel('mc:Fallback')).length > 0) return;
        const text = $(paragraph).find(sel('w:t'))
            .filter((__, node) => $(node).closest(sel('w:p'))[0] === paragraph)
            .map((__, node) => $(node).text()).get().join('');
        const line = text.replace(/\s+/g, ' ').trim();
        if (line) lines.push(line);
    });
    return Array.from(lines.join('\n')).slice(0, MAX_HEADER_CHARS).join('');
}

async function readPart(zip, name) {
    const entry = zip.file(name);
    return entry ? entry.async('string') : '';
}

// 开关元素（w:titlePg、w:evenAndOddHeaders）：元素在且 w:val 不是 0 / false / off 即为开
function isFlagOn(xml, tagName) {
    const matched = new RegExp(`<${tagName}(?=[\\s/>])[^>]*>`).exec(xml || '');
    if (!matched) return false;
    const value = attrOf(matched[0], 'w:val');
    return value === undefined || !FALSE_VALUES.has(value.toLowerCase());
}

function attrOf(tagText, name) {
    const matched = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tagText);
    return matched ? (matched[1] ?? matched[2]) : undefined;
}

// ============================================================
// applySections：哨兵段 → 顶层节点的 data.section
// ============================================================

function applySections(ir, sections) {
    if (!ir || !Array.isArray(ir.children) || !Array.isArray(sections) || sections.length === 0) return ir;
    const byIndex = new Map(sections.map((section) => [section.index, section]));
    const children = [];
    let current = null;
    for (const node of ir.children) {
        const index = sentinelIndex(node);
        if (index !== null) {
            current = byIndex.get(index) || null;
            continue;
        }
        const cleaned = dropNestedSentinels(node);
        children.push(current ? withSection(cleaned, current) : cleaned);
    }
    return { ...ir, children };
}

function sentinelIndex(node) {
    if (!node || node.type !== 'paragraph') return null;
    const matched = SENTINEL_RE.exec(collectText(node).trim());
    return matched ? Number(matched[1]) : null;
}

const withSection = (node, section) => (node && typeof node === 'object'
    ? { ...node, data: { ...(node.data || {}), section: { index: section.index, header: section.header } } }
    : node);

// 分节符所在段落按规范只会是 w:body 级段落；万一落进表格单元格等容器，哨兵段到不了顶层，在此删除。
// 无改动时返回原引用
function dropNestedSentinels(node) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return node;
    const children = node.children.filter((child) => sentinelIndex(child) === null).map(dropNestedSentinels);
    const changed = children.length !== node.children.length || children.some((child, i) => child !== node.children[i]);
    return changed ? { ...node, children } : node;
}

module.exports = { markSections, applySections };
