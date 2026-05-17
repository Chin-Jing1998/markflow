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
 *   kind: 'document' | 'spreadsheet' | 'presentation',
 *   ir:   <mdast root>,
 *   data: <格式特有数据快照>,
 *   meta: { title, sourceType, sourceName, createdAt, ... }
 * }
 */

const SCHEMA_VERSION = 1;

// ============================================================
// 顶层包装
// ============================================================

function createDocument({ kind = 'document', ir, data = null, meta = {} } = {}) {
    return {
        schemaVersion: SCHEMA_VERSION,
        kind,
        ir: ir || createRoot(),
        data,
        meta: {
            createdAt: new Date().toISOString(),
            ...meta,
        },
    };
}

// ============================================================
// mdast 标准节点工厂
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
    return { type: 'text', value: String(value || '') };
}

function createImage(url, alt = '', title = null) {
    return { type: 'image', url, alt, title };
}

function createLink(url, children, title = null) {
    return { type: 'link', url, title, children: normalizeChildren(children) };
}

function createStrong(children) {
    return { type: 'strong', children: normalizeChildren(children) };
}

function createEmphasis(children) {
    return { type: 'emphasis', children: normalizeChildren(children) };
}

function createDelete(children) {
    return { type: 'delete', children: normalizeChildren(children) };
}

function createInlineCode(value) {
    return { type: 'inlineCode', value: String(value || '') };
}

function createCode(value, lang = null) {
    return { type: 'code', lang, value: String(value || '') };
}

function createBlockquote(children) {
    return { type: 'blockquote', children: normalizeChildren(children) };
}

function createList(ordered, children, start = null) {
    return {
        type: 'list',
        ordered: !!ordered,
        spread: false,
        start: ordered ? (start || 1) : null,
        children: normalizeChildren(children),
    };
}

function createListItem(children, checked = null) {
    return {
        type: 'listItem',
        spread: false,
        checked,
        children: normalizeChildren(children),
    };
}

function createThematicBreak() {
    return { type: 'thematicBreak' };
}

function createBreak() {
    return { type: 'break' };
}

function createHtml(value) {
    return { type: 'html', value: String(value || '') };
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
 * 渲染策略：
 *   MD/HTML → 输出 H2(title) + thematicBreak
 *   DOCX    → 分页符 + 标题
 *   PDF     → 分页
 *   PPTX    → 新建 slide（这是它的"原生"语义）
 */
function createSlideBreak({ title = '', index = 0, notes = '' } = {}) {
    return {
        type: 'slideBreak',
        data: { title, index, notes },
    };
}

/**
 * 工作表段标记节点
 * 渲染策略：
 *   MD/HTML → 输出 H1(name)
 *   XLSX    → 新建 sheet（原生语义）
 *   DOCX/PDF → 标题 + 表格内容
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

// 自定义节点降级：在喂给 mdast-util-to-markdown / remark-rehype 前
// 把 slideBreak/sheetSection 转换为标准 mdast 节点（H1/H2 + thematicBreak）
function downgradeCustomNodes(node) {
    if (!node || typeof node !== 'object') return node;

    if (Array.isArray(node)) {
        return node.flatMap(downgradeCustomNodes);
    }

    if (node.type === 'slideBreak') {
        const result = [];
        if (node.data && node.data.index > 0) {
            result.push(createThematicBreak());
        }
        if (node.data && node.data.title) {
            result.push(createHeading(2, node.data.title));
        }
        return result;
    }

    if (node.type === 'sheetSection') {
        const result = [];
        if (node.data && node.data.index > 0) {
            result.push(createThematicBreak());
        }
        if (node.data && node.data.name) {
            result.push(createHeading(1, node.data.name));
        }
        return result;
    }

    if (Array.isArray(node.children)) {
        const newChildren = [];
        for (const child of node.children) {
            const downgraded = downgradeCustomNodes(child);
            if (Array.isArray(downgraded)) {
                newChildren.push(...downgraded);
            } else {
                newChildren.push(downgraded);
            }
        }
        return { ...node, children: newChildren };
    }

    return node;
}

module.exports = {
    SCHEMA_VERSION,
    createDocument,
    // 标准 mdast 节点
    createRoot,
    createHeading,
    createParagraph,
    createText,
    createImage,
    createLink,
    createStrong,
    createEmphasis,
    createDelete,
    createInlineCode,
    createCode,
    createBlockquote,
    createList,
    createListItem,
    createThematicBreak,
    createBreak,
    createHtml,
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
