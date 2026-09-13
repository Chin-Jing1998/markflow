/**
 * MarkFlow 内部中间表示（IR）schema
 *
 * 主体复用 mdast（unified 生态的 Markdown AST），渲染时直接喂给 remark/rehype。
 * 为非线性与非文本内容引入三个自定义扩展节点：
 *   - slideBreak    幻灯片分隔（MD/HTML → H2(title) + ---；DOCX/PDF → 分页 + 标题）
 *   - sheetSection  工作表段标记（MD/HTML → H1(name)；DOCX/PDF → 标题 + 表格内容）
 *   - math          公式（docx 的 OMML 等）：{ type: 'math', data: { omml, mathml, text, display } }
 *                   display=true 表示独立成段的公式，须放在块级位置；false 表示行内公式，须放在段落内。
 *                   不支持公式的渲染器先经 degradeMath 把它降为线性化文本。
 *
 * 顶层包装结构（MarkFlowDocument）：
 * {
 *   schemaVersion: 1,
 *   kind: 'document' | 'workbook' | 'presentation',
 *   ir:   <mdast root>,
 *   data: <格式特有数据快照，无则 null>,
 *   meta: { title?, sourceType, sourceName?, baseDir? },
 *   assets:   [{ name: 'images/image_1.png', buffer, mime }],
 *   extras:   [{ name: 'mineru/full.md', buffer }],   // sidecar 附属文件：落盘时按 name（posix 相对路径）原样写入产物目录
 *   warnings: [string],
 * }
 *
 * 本文件只保留有消费者的节点工厂；行内节点（strong/link/image 等）由 remark 解析生成，
 * 不再提供手工工厂。
 */

const SCHEMA_VERSION = 1;

function createDocument({ kind = 'document', ir, data = null, meta = {}, assets = [], extras = [], warnings = [] } = {}) {
    return {
        schemaVersion: SCHEMA_VERSION,
        kind,
        ir: ir || createRoot(),
        data,
        meta: { ...(meta || {}) },
        assets: Array.isArray(assets) ? assets : [],
        extras: Array.isArray(extras) ? extras : [],
        warnings: Array.isArray(warnings) ? warnings : [],
    };
}

// mdast 标准块级节点工厂
const createRoot = (children = []) => ({ type: 'root', children });
const createHeading = (depth, children) => ({ type: 'heading', depth, children: normalizeChildren(children) });
const createParagraph = (children) => ({ type: 'paragraph', children: normalizeChildren(children) });
const createText = (value) => ({ type: 'text', value: String(value == null ? '' : value) });
const createBlockquote = (children) => ({ type: 'blockquote', children: normalizeChildren(children) });
const createThematicBreak = () => ({ type: 'thematicBreak' });
const createTable = (align, children) => ({
    type: 'table',
    align: Array.isArray(align) ? align : null,
    children: normalizeChildren(children),
});
const createTableRow = (children) => ({ type: 'tableRow', children: normalizeChildren(children) });
const createTableCell = (children) => ({ type: 'tableCell', children: normalizeChildren(children) });

// 自定义扩展节点
const createSlideBreak = ({ title = '', index = 0, notes = '' } = {}) => ({ type: 'slideBreak', data: { title, index, notes } });
const createSheetSection = ({ name = '', index = 0 } = {}) => ({ type: 'sheetSection', data: { name, index } });

/**
 * 公式节点：omml 为源 XML 片段，mathml 为转换结果，text 为线性化文本（降级用），三者均可缺省；
 * display 标记块级公式。字符串以外的 omml/mathml 归一为 null。
 */
const createMath = ({ omml = null, mathml = null, text = '', display = false } = {}) => ({
    type: 'math',
    data: {
        omml: typeof omml === 'string' && omml ? omml : null,
        mathml: typeof mathml === 'string' && mathml ? mathml : null,
        text: String(text == null ? '' : text),
        display: Boolean(display),
    },
});

// 容错：把字符串自动包装成 text 节点
function normalizeChildren(children) {
    if (!children) return [];
    const arr = Array.isArray(children) ? children : [children];
    return arr.map((c) => (typeof c === 'string' ? createText(c) : c));
}

// 自定义节点降级：在喂给 remark-stringify / remark-rehype 前把 slideBreak/sheetSection
// 转换为标准 mdast 节点（H1/H2 + thematicBreak）。不修改入参，返回新树。
function downgradeCustomNodes(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.flatMap(downgradeCustomNodes);
    if (node.type === 'slideBreak') return downgradeSection(node.data, 2, node.data && node.data.title);
    if (node.type === 'sheetSection') return downgradeSection(node.data, 1, node.data && node.data.name);
    if (Array.isArray(node.children)) return { ...node, children: node.children.flatMap(downgradeCustomNodes) };
    return node;
}

// 非首段前置分隔线，有标题则追加对应层级的 heading
function downgradeSection(data, depth, title) {
    const result = [];
    if (data && data.index > 0) result.push(createThematicBreak());
    if (title) result.push(createHeading(depth, title));
    return result;
}

/**
 * 公式的线性化文本：优先取 data.text；没有时从 MathML 去标签后取纯文本作兜底；都没有返回空串。
 */
function mathToText(node) {
    const data = node && node.data && typeof node.data === 'object' ? node.data : {};
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (text) return text;
    const mathml = typeof data.mathml === 'string' ? data.mathml : '';
    return mathml.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 公式降级：把 math 节点替换为线性化文本——行内公式变 text 节点，块级公式（display=true）
 * 变只含一个 text 节点的 paragraph。不修改入参，返回新树；供不支持公式的渲染器在喂给
 * remark/rehype 前调用，与 downgradeCustomNodes 相互独立、可任意组合。
 */
function degradeMath(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(degradeMath);
    if (node.type === 'math') {
        const text = createText(mathToText(node));
        return node.data && node.data.display ? createParagraph([text]) : text;
    }
    if (Array.isArray(node.children)) return { ...node, children: node.children.map(degradeMath) };
    return node;
}

module.exports = {
    SCHEMA_VERSION,
    createDocument,
    // 标准 mdast 节点
    createRoot, createHeading, createParagraph, createText, createBlockquote,
    createThematicBreak, createTable, createTableRow, createTableCell,
    // 扩展节点
    createSlideBreak, createSheetSection, createMath,
    // 工具
    normalizeChildren, downgradeCustomNodes, mathToText, degradeMath,
};
