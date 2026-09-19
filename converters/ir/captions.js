/**
 * 图注识别与大图拆段
 *
 * splitImageParagraphs(ir) → 新树：
 *   - 段首或段尾、显示宽度 ≥ 200px（百分比按 600px 参照栏宽折算）的图片拆成独立段落，
 *     使 Markdown 中的 <img> 独占一行、其后的图注能被识别为「紧随图片」；
 *   - 浮动图片（data.floating，来自 docx 的 wp:anchor）不论位置一律从文字中取出，按原顺序排在该段文字之后
 *     ——锚定在段落上的浮动图在版面上位于文字之外，常见排布是「标签段 → 浮动图 → 图号段」；
 *   - 只含图片的段落里有多张可拆图片时，逐张成段；
 *   - 同一原段落拆出的每一块写 data.splitGroup = <整数>（同组同值，按文档顺序递增），未被拆的段落不写该键。
 *     专利渲染层据此在正文三书里把同组的相邻块并回一个段落（一个 Word 段落 = 一个 <p>，段号不顺延），
 *     见 renderers/xml/blocks 的 mergeSplitGroups；md / html / docx 渲染器不读该键，产物不受影响。
 * markCaptions(ir) → 新树：先 splitImageParagraphs，再在块级兄弟序列里给紧随「只含图片的段落」的段落定角色：
 *   ≤ 60 字且匹配 ^(图|附图|Fig\.?|Figure)\s*序号、^图\s*[|｜:：]、^[▲△↑] → data.role = 'caption'；
 *   匹配 ^(注|来源|图源|图片来源|资料来源)[:：] → 'image_footnote'；
 *   一张图后最多连续认 3 段；已带 role 的段落（解析器标记的图注）保持不变。
 * 图注与图片只靠「紧邻」对应，不在 IR 里记图片名。两者均不改动入参。
 */
const { collectText } = require('./util');

const CAPTION_RE = /^(?:(?:图|附图|Fig\.?|Figure)\s*[\d一二三四五六七八九十]+|图\s*[|｜:：]|[▲△↑])/i;
const FOOTNOTE_RE = /^(?:注|来源|图源|图片来源|资料来源)\s*[:：]/;
const CAPTION_MAX_CHARS = 60;
const MAX_CAPTION_CHAIN = 3;
const BIG_IMAGE_PX = 200;
// 百分比宽度折算 px 的参照栏宽，取 docx 渲染器的图片宽度上限
const REFERENCE_COLUMN_PX = 600;
const PERCENT_BASE = 100;
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);
const CAPTION_ROLES = new Set(['caption', 'image_footnote']);

// ============================================================
// splitImageParagraphs
// ============================================================

function splitImageParagraphs(ir) {
    return splitNode(ir, createGroupCounter());
}

// 分组号发生器：每调用一次给出下一个号，同一原段落拆出的各块共用一个号
function createGroupCounter() {
    let issued = 0;
    return () => {
        issued += 1;
        return issued;
    };
}

function splitNode(node, nextGroup) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return node;
    const isBlockParent = BLOCK_PARENTS.has(node.type);
    let changed = false;
    const children = [];
    for (const child of node.children) {
        const next = splitNode(child, nextGroup);
        const parts = isBlockParent && next && next.type === 'paragraph' ? splitParagraph(next, nextGroup) : [next];
        if (parts.length !== 1 || parts[0] !== child) changed = true;
        children.push(...parts);
    }
    return changed ? { ...node, children } : node;
}

function splitParagraph(node, nextGroup) {
    const items = Array.isArray(node.children) ? node.children : [];
    if (!items.some((item) => isImage(item) && (isBig(item) || isFloating(item)))) return [node];

    const floating = items.filter((item) => isImage(item) && isFloating(item));
    const flow = items.filter((item) => !(isImage(item) && isFloating(item)));
    const leading = peel(flow, 'start');
    const trailing = peel(flow.slice(leading.consumed), 'end');
    const middle = trimBlankEdges(flow.slice(leading.consumed, flow.length - trailing.consumed));

    const detached = leading.images.length + floating.length + trailing.images.length;
    if (detached === 1 && middle.length === 0) return [node];

    const blocks = leading.images.map(imageParagraph);
    if (middle.length > 0) blocks.push({ ...node, children: middle });
    blocks.push(...floating.map(imageParagraph), ...trailing.images.map(imageParagraph));
    return blocks.length > 1 ? stampGroup(blocks, nextGroup()) : blocks;
}

// 同组标记只写 data.splitGroup，块的其它内容原样保留
const stampGroup = (blocks, group) => blocks.map((block) => ({ ...block, data: { ...(block.data || {}), splitGroup: group } }));

// 从一端连续取可拆的大图（其间的空白与换行一并跳过）；返回图片与消耗的项数
function peel(items, side) {
    const order = side === 'start' ? items : [...items].reverse();
    const images = [];
    let consumed = 0;
    for (let i = 0; i < order.length; i += 1) {
        const item = order[i];
        if (isBlankInline(item)) continue;
        if (!isImage(item) || !isBig(item)) break;
        images.push(item);
        consumed = i + 1;
    }
    return { images: side === 'start' ? images : images.reverse(), consumed };
}

function trimBlankEdges(items) {
    let start = 0;
    let end = items.length;
    while (start < end && isBlankInline(items[start])) start += 1;
    while (end > start && isBlankInline(items[end - 1])) end -= 1;
    return items.slice(start, end);
}

const imageParagraph = (image) => ({ type: 'paragraph', children: [image] });
const isImage = (node) => Boolean(node) && node.type === 'image';
const isFloating = (node) => Boolean(node.data && node.data.floating === true);
const isBlankInline = (node) => Boolean(node) && (node.type === 'break' || (node.type === 'text' && !/\S/.test(String(node.value || ''))));

function isBig(node) {
    const display = node.data && node.data.display;
    if (!display || !Number.isFinite(display.width)) return false;
    const px = display.unit === '%' ? (display.width * REFERENCE_COLUMN_PX) / PERCENT_BASE : display.width;
    return px >= BIG_IMAGE_PX;
}

// ============================================================
// markCaptions
// ============================================================

function markCaptions(ir) {
    return markNode(splitImageParagraphs(ir));
}

function markNode(node) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return node;
    const mapped = node.children.map(markNode);
    const children = BLOCK_PARENTS.has(node.type) ? markSiblings(mapped) : mapped;
    return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
}

function markSiblings(children) {
    let chain = -1;
    return children.map((child) => {
        if (isImageParagraph(child)) {
            chain = 0;
            return child;
        }
        if (!child || child.type !== 'paragraph' || chain < 0 || chain >= MAX_CAPTION_CHAIN) {
            chain = -1;
            return child;
        }
        const existing = child.data && child.data.role;
        if (CAPTION_ROLES.has(existing)) {
            chain += 1;
            return child;
        }
        const role = captionRole(child);
        if (!role) {
            chain = -1;
            return child;
        }
        chain += 1;
        return { ...child, data: { ...(child.data || {}), role } };
    });
}

function captionRole(node) {
    if (containsImage(node)) return null;
    const text = collectText(node).replace(/\s+/g, ' ').trim();
    if (!text || Array.from(text).length > CAPTION_MAX_CHARS) return null;
    if (FOOTNOTE_RE.test(text)) return 'image_footnote';
    if (CAPTION_RE.test(text)) return 'caption';
    return null;
}

/** 只含图片（及包着图片的链接）与空白、换行的段落，且至少一张图 */
function isImageParagraph(node) {
    if (!node || node.type !== 'paragraph' || !Array.isArray(node.children)) return false;
    let images = 0;
    for (const child of node.children) {
        if (isBlankInline(child)) continue;
        if (isImage(child) || (child.type === 'link' && Array.isArray(child.children) && child.children.length > 0 && child.children.every(isImage))) {
            images += 1;
            continue;
        }
        return false;
    }
    return images > 0;
}

function containsImage(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'image') return true;
    return Array.isArray(node.children) && node.children.some(containsImage);
}

module.exports = { markCaptions, splitImageParagraphs, isImageParagraph, CAPTION_RE, FOOTNOTE_RE };
