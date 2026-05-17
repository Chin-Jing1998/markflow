/**
 * IR → Markdown
 *
 * 用 remark-stringify + remark-gfm 链支持 GFM 表格/删除线等扩展；
 * 扩展节点（slideBreak/sheetSection）先降级为 H1/H2/thematicBreak。
 */
const { loadUnified } = require('../ir/unified-loader');
const { downgradeCustomNodes } = require('../ir/schema');

// 与 legacy turndown 配置对齐：bullet '-'、rule '---'、emphasis '*'、strong '**'、fences、atx
const MD_OPTIONS = {
    bullet: '-',
    rule: '-',
    emphasis: '*',
    strong: '*',
    fences: true,
    setext: false,
    listItemIndent: 'one',
};

async function render(doc) {
    const { unified, remarkStringify, remarkGfm } = await loadUnified();
    const downgraded = downgradeCustomNodes(doc.ir);
    const result = unified()
        .use(remarkGfm)
        .use(remarkStringify, MD_OPTIONS)
        .stringify(downgraded);
    return String(result);
}

module.exports = { render };
