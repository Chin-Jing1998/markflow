/**
 * IR → Markdown
 * mdast-util-to-markdown 直接序列化；扩展节点先降级为 H1/H2/thematicBreak
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
    const { toMarkdown } = await loadUnified();
    const downgraded = downgradeCustomNodes(doc.ir);
    return toMarkdown(downgraded, MD_OPTIONS);
}

module.exports = { render };
