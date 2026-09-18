/**
 * IR 顶层节点 → 扁平块序列（patent profile 的分节、权项、附图与段落输出共用）
 *
 * flattenBlocks(root) → block[]，block 形态：
 *   { kind: 'heading',   depth, runs, text, node }
 *   { kind: 'paragraph', runs, text, node, isBold, isItalic }   文本段（可含行内图片、公式）
 *   { kind: 'image',     images: [imageNode...], node }         仅由候选附图图片组成的段（见 FIGURE_ROLES）
 *   { kind: 'table',     rows: [[cellText...]], node }          未栅格化的 mdast 表格
 *   { kind: 'math',      node }                                 未栅格化的块级公式
 * 列表展开为段：有序列表项的首段冠以「N. 」前缀（权项常以列表形态出现在 Markdown 输入中），
 * 无序列表项不加前缀；引用块与列表项内的块递归展开；代码块按行以软换行连接成一段；
 * 分隔线、幻灯片/工作表标记、脚注定义等对专利文稿无意义的节点丢弃。
 * 块引用原节点（node），供调用方回写识别结果；本模块不改动入参。
 *
 * mergeSplitGroups(blocks) → block[]：相邻且同组（node.data.splitGroup 相同，由 ir/captions 的大图拆段写入）
 *   的块并回一个块。官方转换器逐个 Word 段落出一个 <p>，拆段不得让正文段落变多、段号顺延，故专利正文三书
 *   （权利要求书、说明书、摘要）渲染前先并回；说明书附图与摘要附图不调用本函数——那两本书里「图片 + 同段图号」
 *   必须保持拆开才能认成 figure 与图号。分节把同组的块切到两本不同的书里时，各书的块序列中它们不再相邻，
 *   自然各归各书、不并。
 */
const { collectText, stripHtml } = require('../../ir/util');
const { flattenInline, runsText, trimRuns, isWholeMark, textRun } = require('./inline');

const SKIPPED_TYPES = new Set(['thematicBreak', 'slideBreak', 'sheetSection', 'definition', 'footnoteDefinition', 'yaml', 'toml']);
// 可以成为附图的图片角色：无角色，或 chemistry——化学式图片可能就是附图（说明书附图里的反应式、
// 作为摘要附图的结构式），落在正文里才包成 chemistry 元素。table / formula 由栅格化产生、永远不会是附图，
// 带这两种角色的图片一律当行内内容，不形成 image 块
const FIGURE_ROLES = new Set(['chemistry']);

function flattenBlocks(root) {
    const children = root && Array.isArray(root.children) ? root.children : [];
    return children.flatMap((node) => flattenNode(node, node));
}

// origin：块所属的顶层节点（列表项内的段落回写识别结果时落到列表节点上）
function flattenNode(node, origin) {
    if (!node || typeof node !== 'object' || SKIPPED_TYPES.has(node.type)) return [];
    switch (node.type) {
        case 'heading': return [headingBlock(node, origin)];
        case 'paragraph': return paragraphBlocks(flattenInline(node.children), node, origin);
        case 'image': return paragraphBlocks([{ kind: 'image', node }], node, origin);
        case 'math': return node.data && node.data.display ? [{ kind: 'math', node, origin }] : paragraphBlocks([{ kind: 'math', node }], node, origin);
        case 'table': return [tableBlock(node, origin)];
        case 'list': return listBlocks(node, origin);
        case 'blockquote': return (node.children || []).flatMap((child) => flattenNode(child, origin));
        case 'code': return codeBlocks(node, origin);
        case 'html': return paragraphBlocks([textRun(stripHtml(node.value), [])], node, origin);
        default:
            if (Array.isArray(node.children)) return paragraphBlocks(flattenInline(node.children), node, origin);
            if (node.value !== undefined) return paragraphBlocks([textRun(String(node.value), [])], node, origin);
            return [];
    }
}

function headingBlock(node, origin) {
    const runs = trimRuns(flattenInline(node.children));
    return { kind: 'heading', depth: Number.isInteger(node.depth) ? node.depth : 1, runs, text: runsText(runs).trim(), node, origin };
}

// 只含候选附图图片（FIGURE_ROLES）的段 → image 块；空段丢弃；其余为 paragraph 块
function paragraphBlocks(rawRuns, node, origin) {
    const runs = trimRuns(rawRuns);
    if (runs.length === 0) return [];
    const images = runs.filter((run) => run.kind === 'image').map((run) => run.node);
    const isFigureImages = images.length > 0 && runs.every((run) => run.kind === 'image' && canBeFigure(run.node));
    if (isFigureImages) return [{ kind: 'image', images, node, origin }];
    return [{
        kind: 'paragraph', runs, text: runsText(runs).trim(), node, origin,
        isBold: isWholeMark(runs, 'b'), isItalic: isWholeMark(runs, 'i'),
    }];
}

function canBeFigure(node) {
    const role = node.data && node.data.role;
    return !role || FIGURE_ROLES.has(role);
}

function tableBlock(node, origin) {
    const rows = (node.children || [])
        .filter((row) => row && row.type === 'tableRow')
        .map((row) => (row.children || []).map((cell) => collectText(cell).replace(/\s+/g, ' ').trim()));
    return { kind: 'table', rows, node, origin };
}

function listBlocks(node, origin) {
    const ordered = Boolean(node.ordered);
    const start = Number.isInteger(node.start) ? node.start : 1;
    const out = [];
    (node.children || []).forEach((item, index) => {
        if (!item || item.type !== 'listItem') return;
        const blocks = (item.children || []).flatMap((child) => flattenNode(child, origin));
        if (!ordered || blocks.length === 0) { out.push(...blocks); return; }
        const prefix = `${start + index}. `;
        const first = blocks[0];
        if (first.kind === 'paragraph') {
            const runs = [textRun(prefix, []), ...first.runs];
            out.push({ ...first, runs, text: runsText(runs).trim() }, ...blocks.slice(1));
        } else {
            out.push(...blocks);
        }
    });
    return out;
}

function codeBlocks(node, origin) {
    const lines = String(node.value == null ? '' : node.value).split(/\r?\n/);
    const runs = lines.flatMap((line, index) => (index === 0 ? [textRun(line, [])] : [{ kind: 'br' }, textRun(line, [])]));
    return paragraphBlocks(runs, node, origin);
}

// ---------- 大图拆段的并回 ----------

// 拆段拆出的块只会是 paragraph 或 image（拆出的都是段落节点），其余块型不参与并回
const MERGEABLE_KINDS = new Set(['paragraph', 'image']);

/** 块所属的拆段分组号；未被拆的块、不可并回的块型均为 null */
function groupOf(block) {
    if (!block || !MERGEABLE_KINDS.has(block.kind)) return null;
    const group = block.node && block.node.data ? block.node.data.splitGroup : undefined;
    return Number.isInteger(group) ? group : null;
}

function mergeSplitGroups(blocks) {
    const out = [];
    for (const block of blocks) {
        const group = groupOf(block);
        const last = out.length > 0 ? out[out.length - 1] : null;
        const merged = group !== null && groupOf(last) === group ? mergePair(last, block) : null;
        if (merged) out[out.length - 1] = merged;
        else out.push(block);
    }
    return out;
}

// runs 按块的现有顺序拼接（拆段时为浮动图调整过的顺序不还原），再按 paragraphBlocks 的规则重新定 kind：
// 并回后仍只含候选附图图片的块还是 image 块（正文里照旧提示「如为附图请移至…」），含文字的成为 paragraph 块。
// 归书阶段附加的 index 与 role 沿用前一块——并回的块内不会有小标题，role 一律是 paragraph 或 figure
function mergePair(first, second) {
    const merged = paragraphBlocks([...runsOf(first), ...runsOf(second)], first.node, first.origin);
    return merged.length === 1 ? { ...merged[0], index: first.index, role: first.role } : null;
}

const runsOf = (block) => (block.kind === 'image' ? block.images.map((node) => ({ kind: 'image', node })) : block.runs);

module.exports = { flattenBlocks, mergeSplitGroups };
