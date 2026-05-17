/**
 * IR → DOCX (Buffer)
 *
 * 遍历 mdast 节点 → docx 包的 Document/Paragraph/Heading/Table。
 * 扩展节点（slideBreak/sheetSection）先经 downgradeCustomNodes 降级为 H1/H2/thematicBreak。
 *
 * P1 限制：
 *   - 图片节点输出为 `[图片: alt 或 url]` placeholder（不嵌入图片二进制）
 *   - 代码块用等宽字体 + 浅灰背景，不做语法高亮
 *   - 不支持嵌套列表（一层 bullet）
 *
 * 返回 Buffer（二进制 .docx）。
 */
const {
    Document,
    Packer,
    Paragraph,
    HeadingLevel,
    TextRun,
    Table,
    TableRow,
    TableCell,
    WidthType,
    AlignmentType,
    BorderStyle,
} = require('docx');
const { downgradeCustomNodes } = require('../ir/schema');

const HEADING_MAP = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6,
};

async function render(doc) {
    const downgraded = downgradeCustomNodes(doc.ir);
    const blocks = [];
    for (const child of downgraded.children || []) {
        const out = nodeToDocxBlock(child);
        if (Array.isArray(out)) blocks.push(...out);
        else if (out) blocks.push(out);
    }
    if (blocks.length === 0) {
        blocks.push(new Paragraph({ children: [new TextRun({ text: '' })] }));
    }

    const document = new Document({
        creator: 'MarkFlow',
        title: (doc.meta && doc.meta.title) || '',
        sections: [{ children: blocks }],
    });

    return await Packer.toBuffer(document);
}

function nodeToDocxBlock(node) {
    if (!node || typeof node !== 'object') return null;

    switch (node.type) {
        case 'heading': {
            const heading = HEADING_MAP[node.depth] || HeadingLevel.HEADING_6;
            return new Paragraph({
                heading,
                children: childrenToRuns(node.children),
            });
        }
        case 'paragraph':
            return new Paragraph({ children: childrenToRuns(node.children) });
        case 'list':
            return listToDocxBlocks(node, 0);
        case 'blockquote': {
            // 简化：每段加入引用样式（左缩进）
            const out = [];
            for (const c of node.children || []) {
                const block = nodeToDocxBlock(c);
                const arr = Array.isArray(block) ? block : block ? [block] : [];
                for (const b of arr) {
                    if (b instanceof Paragraph) {
                        // 在已有 Paragraph 上添加缩进不容易（docx API 限制），
                        // 用前缀 "> " 模拟（朴素方案）
                        out.push(b);
                    } else out.push(b);
                }
            }
            return out;
        }
        case 'code':
            return new Paragraph({
                children: [
                    new TextRun({
                        text: node.value || '',
                        font: { name: 'Courier New' },
                    }),
                ],
                shading: { fill: 'F5F5F7' },
            });
        case 'thematicBreak':
            return new Paragraph({
                border: {
                    bottom: {
                        color: 'D2D2D7',
                        space: 1,
                        style: BorderStyle.SINGLE,
                        size: 6,
                    },
                },
                children: [new TextRun({ text: '' })],
            });
        case 'table':
            return tableNodeToDocxTable(node);
        case 'html':
            // 原样输出 HTML 字符串（DOCX 不支持，转为段落文本）
            return new Paragraph({
                children: [new TextRun({ text: stripHtml(node.value || '') })],
            });
        default:
            return null;
    }
}

function listToDocxBlocks(listNode, depth) {
    const out = [];
    let order = listNode.start || 1;
    for (const li of listNode.children || []) {
        const prefix = listNode.ordered ? `${order}. ` : '';
        order++;
        // 一个 listItem 可能含多个 paragraph
        for (const child of li.children || []) {
            if (child.type === 'paragraph') {
                out.push(
                    new Paragraph({
                        bullet: listNode.ordered ? undefined : { level: depth },
                        children: listNode.ordered
                            ? [
                                  new TextRun({ text: prefix }),
                                  ...childrenToRuns(child.children),
                              ]
                            : childrenToRuns(child.children),
                    }),
                );
            } else if (child.type === 'list') {
                out.push(...listToDocxBlocks(child, Math.min(depth + 1, 5)));
            } else {
                const b = nodeToDocxBlock(child);
                if (Array.isArray(b)) out.push(...b);
                else if (b) out.push(b);
            }
        }
    }
    return out;
}

function tableNodeToDocxTable(tableNode) {
    const rows = (tableNode.children || []).map((tr, rowIdx) => {
        const cells = (tr.children || []).map((td) => {
            return new TableCell({
                children: [
                    new Paragraph({ children: childrenToRuns(td.children) }),
                ],
            });
        });
        return new TableRow({ children: cells, tableHeader: rowIdx === 0 });
    });
    return new Table({
        rows,
        width: { size: 100, type: WidthType.PERCENTAGE },
    });
}

function childrenToRuns(children) {
    const runs = [];
    for (const c of children || []) {
        const r = nodeToTextRun(c);
        if (Array.isArray(r)) runs.push(...r);
        else if (r) runs.push(r);
    }
    if (runs.length === 0) runs.push(new TextRun({ text: '' }));
    return runs;
}

function nodeToTextRun(node) {
    if (!node || typeof node !== 'object') return null;
    switch (node.type) {
        case 'text':
            return new TextRun({ text: node.value || '' });
        case 'strong':
            return new TextRun({
                text: collectText(node),
                bold: true,
            });
        case 'emphasis':
            return new TextRun({
                text: collectText(node),
                italics: true,
            });
        case 'delete':
            return new TextRun({
                text: collectText(node),
                strike: true,
            });
        case 'inlineCode':
            return new TextRun({
                text: node.value || '',
                font: { name: 'Courier New' },
            });
        case 'break':
            return new TextRun({ break: 1 });
        case 'link':
            return new TextRun({
                text: collectText(node),
                color: '0071E3',
                underline: {},
            });
        case 'image':
            return new TextRun({
                text: `[图片: ${node.alt || node.url || ''}]`,
                italics: true,
            });
        case 'html':
            return new TextRun({ text: stripHtml(node.value || '') });
        default:
            if (Array.isArray(node.children)) {
                return new TextRun({ text: collectText(node) });
            }
            return null;
    }
}

function collectText(node) {
    if (!node) return '';
    if (node.value !== undefined) return node.value;
    if (Array.isArray(node.children)) {
        return node.children.map(collectText).join('');
    }
    return '';
}

function stripHtml(s) {
    return String(s || '').replace(/<[^>]*>/g, '');
}

module.exports = { render };
