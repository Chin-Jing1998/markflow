/**
 * IR 顶层节点 → 扁平块序列（patent profile 的分节、权项、附图与段落输出共用）
 *
 * flattenBlocks(root) → block[]，block 形态：
 *   { kind: 'heading',   depth, runs, text, node }
 *   { kind: 'paragraph', runs, text, node, isBold, isItalic }   文本段（可含行内图片、公式）
 *   { kind: 'image',     images: [imageNode...], node }         仅由未标注角色的图片组成的段（候选附图）
 *   { kind: 'table',     rows: [[cellText...]], node }          未栅格化的 mdast 表格
 *   { kind: 'math',      node }                                 未栅格化的块级公式
 * 列表展开为段：有序列表项的首段冠以「N. 」前缀（权项常以列表形态出现在 Markdown 输入中），
 * 无序列表项不加前缀；引用块与列表项内的块递归展开；代码块按行以软换行连接成一段；
 * 分隔线、幻灯片/工作表标记、脚注定义等对专利文稿无意义的节点丢弃。
 * 块引用原节点（node），供调用方回写识别结果；本模块不改动入参。
 */
const { collectText, stripHtml } = require('../../ir/util');
const { flattenInline, runsText, trimRuns, isWholeMark, textRun } = require('./inline');

const SKIPPED_TYPES = new Set(['thematicBreak', 'slideBreak', 'sheetSection', 'definition', 'footnoteDefinition', 'yaml', 'toml']);

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

// 只含未标注角色图片的段 → image 块；空段丢弃；其余为 paragraph 块
function paragraphBlocks(rawRuns, node, origin) {
    const runs = trimRuns(rawRuns);
    if (runs.length === 0) return [];
    const images = runs.filter((run) => run.kind === 'image').map((run) => run.node);
    const isPlainImages = images.length > 0 && runs.every((run) => run.kind === 'image' && !(run.node.data && run.node.data.role));
    if (isPlainImages) return [{ kind: 'image', images, node, origin }];
    return [{
        kind: 'paragraph', runs, text: runsText(runs).trim(), node, origin,
        isBold: isWholeMark(runs, 'b'), isItalic: isWholeMark(runs, 'i'),
    }];
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

module.exports = { flattenBlocks };
