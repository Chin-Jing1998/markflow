/**
 * MarkFlow 内部中间表示（IR）schema
 *
 * 主体复用 mdast（unified 生态的 Markdown AST），渲染时直接喂给 remark/rehype。
 * 为非线性内容（PPTX 幻灯片、XLSX 工作表）引入两个自定义扩展节点：
 *   - slideBreak    幻灯片分隔（渲染到 MD 时降级为 H2 + ---）
 *   - sheetSection  工作表段标记（渲染到 MD 时降级为 H1）
 *
 * 顶层包装结构（MarkFlowDocument）：
 * {
 *   schemaVersion: 1,
 *   kind: 'document' | 'workbook' | 'presentation',
 *   ir:   <mdast root>,
 *   data: <格式特有数据快照，无则 null>,
 *   meta: { title?, sourceType, sourceName?, baseDir? },
 *   assets:   [{ name: 'images/image_1.png', buffer, mime }],
 *   warnings: [string],
 * }
 *
 * 本文件只保留有消费者的节点工厂；行内节点（strong/link/image 等）由 remark 解析生成，
 * 不再提供手工工厂。
 */

const SCHEMA_VERSION = 1;

// ============================================================
// 顶层包装
// ============================================================

function createDocument({
    kind = 'document',
    ir,
    data = null,
    meta = {},
    assets = [],
    warnings = [],
} = {}) {
    return {
        schemaVersion: SCHEMA_VERSION,
        kind,
        ir: ir || createRoot(),
        data,
        meta: { ...(meta || {}) },
        assets: Array.isArray(assets) ? assets : [],
        warnings: Array.isArray(warnings) ? warnings : [],
    };
}

// ============================================================
// mdast 标准节点工厂（块级）
// ============================================================

function createRoot(children = []) {
    return { type: 'root', children };
}

function createHeading(depth, children) {
    return { type: 'heading', depth, children: normalizeChildren(children) };
}

function createParagraph(children) {
    return { type: 'paragraph', children: normalizeChildren(children) };
}

function createText(value) {
    return { type: 'text', value: String(value == null ? '' : value) };
}

function createBlockquote(children) {
    return { type: 'blockquote', children: normalizeChildren(children) };
}

function createThematicBreak() {
    return { type: 'thematicBreak' };
}

function createTable(align, children) {
    return {
        type: 'table',
        align: Array.isArray(align) ? align : null,
        children: normalizeChildren(children),
    };
}

function createTableRow(children) {
    return { type: 'tableRow', children: normalizeChildren(children) };
}

function createTableCell(children) {
    return { type: 'tableCell', children: normalizeChildren(children) };
}

// ============================================================
// 自定义扩展节点
// ============================================================

/**
 * 幻灯片分隔节点
 * 渲染策略：MD/HTML → H2(title) + thematicBreak；DOCX/PDF → 分页 + 标题
 */
function createSlideBreak({ title = '', index = 0, notes = '' } = {}) {
    return {
        type: 'slideBreak',
        data: { title, index, notes },
    };
}

/**
 * 工作表段标记节点
 * 渲染策略：MD/HTML → H1(name)；DOCX/PDF → 标题 + 表格内容
 */
function createSheetSection({ name = '', index = 0 } = {}) {
    return {
        type: 'sheetSection',
        data: { name, index },
    };
}

// ============================================================
// 工具函数
// ============================================================

// 容错：把字符串自动包装成 text 节点
function normalizeChildren(children) {
    if (!children) return [];
    const arr = Array.isArray(children) ? children : [children];
    return arr.map((c) => (typeof c === 'string' ? createText(c) : c));
}

// 自定义节点降级：在喂给 remark-stringify / remark-rehype 前
// 把 slideBreak/sheetSection 转换为标准 mdast 节点（H1/H2 + thematicBreak）。
// 不修改入参，返回新树。
function downgradeCustomNodes(node) {
    if (!node || typeof node !== 'object') return node;

    if (Array.isArray(node)) {
        return node.flatMap(downgradeCustomNodes);
    }

    if (node.type === 'slideBreak') {
        return downgradeSection(node.data, 2, node.data && node.data.title);
    }

    if (node.type === 'sheetSection') {
        return downgradeSection(node.data, 1, node.data && node.data.name);
    }

    if (Array.isArray(node.children)) {
        return { ...node, children: node.children.flatMap(downgradeCustomNodes) };
    }

    return node;
}

// 非首段前置分隔线，有标题则追加对应层级的 heading
function downgradeSection(data, depth, title) {
    const result = [];
    if (data && data.index > 0) {
        result.push(createThematicBreak());
    }
    if (title) {
        result.push(createHeading(depth, title));
    }
    return result;
}

module.exports = {
    SCHEMA_VERSION,
    createDocument,
    // 标准 mdast 节点
    createRoot,
    createHeading,
    createParagraph,
    createText,
    createBlockquote,
    createThematicBreak,
    createTable,
    createTableRow,
    createTableCell,
    // 扩展节点
    createSlideBreak,
    createSheetSection,
    // 工具
    normalizeChildren,
    downgradeCustomNodes,
};
