/**
 * IR → Markdown
 *
 * 用 remark-stringify + remark-gfm 链支持 GFM 表格/删除线等扩展；
 * 扩展节点（slideBreak/sheetSection）先降级为 H1/H2/thematicBreak；
 * math 节点转为线性化文本并套 TeX 定界符（块级 $$…$$ 独立成段，行内 $…$），
 * 不引入 remark-math，故定界符只是文本约定，往返解析时按普通文本处理。
 * 带 data.safeTable 的 html 节点与其它 html 节点一样按原样输出（remark-stringify 直出 value）。
 */
const { loadUnified } = require('../ir/unified-loader');
const { downgradeCustomNodes, mathToText } = require('../ir/schema');

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
    const downgraded = downgradeCustomNodes(wrapMath(doc.ir));
    const result = unified()
        .use(remarkGfm)
        .use(remarkStringify, MD_OPTIONS)
        .stringify(downgraded);
    return String(result);
}

/** math → 文本：display 为真时独立成段并用 $$…$$ 包裹，否则行内 $…$。不修改入参，返回新树 */
function wrapMath(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(wrapMath);
    if (node.type === 'math') {
        const display = Boolean(node.data && node.data.display);
        const text = mathToText(node);
        const value = display ? `$$${text}$$` : `$${text}$`;
        return display ? { type: 'paragraph', children: [{ type: 'text', value }] } : { type: 'text', value };
    }
    if (Array.isArray(node.children)) return { ...node, children: node.children.map(wrapMath) };
    return node;
}

module.exports = { render };
