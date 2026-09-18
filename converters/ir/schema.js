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
 * 另有三个行内扩展节点，形态一致（{ type, children }），均由 ir/inline-html 从同名 HTML 标签提升而来：
 *   - underline    下划线，源自 <u>（docx 由 mammoth 的 styleMap 'u => u' 产出）
 *   - superscript  上标，源自 <sup>（docx 由 w:vertAlign superscript 产出）
 *   - subscript    下标，源自 <sub>（docx 由 w:vertAlign subscript 产出）
 * 三者可互相嵌套，也可与 strong / emphasis 嵌套。downgradeCustomNodes 按普通容器原样递归保留它们；
 * md / html / docx / xml 各渲染器均有专门处理（行内 HTML 标签、同名 hast 元素、run 属性、DTD 行内元素），
 * 新增渲染器须同样认识它们；只取文字的场合（collectText 一类）按普通容器递归即可。
 *
 * 节点 data 上的版面约定（解析器写入，渲染器读取）：
 *   image.data.display   = { width, height?, unit: 'px' | '%', source }   显示尺寸，与原文档 / 原网页一致；
 *                          source 为 'web' | 'docx' | 'pptx' | 'mineru' | 'html'（Markdown 输入的 <img>）。
 *                          与栅格化用的像素尺寸 data.{width, height, dpi}（raster/rasterize-nodes 写入）分开存放
 *   image.data.displayWidthMm / image.data.displayHeightMm = number
 *                          该图在源文档中的物理显示尺寸（毫米，浮点，不取整）。docx 由 wp:extent
 *                          （EMU ÷ 914400 × 25.4）或 VML 的 v:shape style 算出；取不到即不写该键。
 *                          与 data.display 的 px 并存而不互相换算——px 按 96 DPI 定义且已取整，反推毫米会先丢一次精度。
 *                          assets/image-normalize 据此在 patent profile 下把图重采样到 jpegPpi 对应的目标像素；
 *                          XML 渲染层据此写 img/@wi、@he（向下取整的毫米）
 *   image.data.floating  = true   docx 浮动图（wp:anchor）；ir/captions 据此把它从文字中取出
 *   image.data.role      = 'table' | 'formula' | 'chemistry'   该图的内容性质：表格图与公式图由
 *                          raster/rasterize-nodes 栅格化时写入，化学结构式由 parsers/docx-chemistry 按四条判据
 *                          （OLE ProgID、替换文字 `<SIPOChemFile` 前缀、EMBED 域代码、EMF 内的 ChemDraw CDX）
 *                          写入；三者亦可由替换文字里的 `markflow:role=<角色>` 前缀显式指定（XML 反向导入的往返）。
 *                          patent profile 据此把图包进 tables / maths / chemistry 元素；其中 chemistry 仍可作附图
 *                          （落在说明书附图 / 摘要附图里输出为 figure > img，见 renderers/xml/blocks 的 FIGURE_ROLES）。
 *                          md / html / docx 渲染器不读该键，带角色的图片按普通图片输出
 *   image.data.sourcePath       来源包内的原始路径（MinerU 的 images/<sha256>.jpg），附属 JSON 的路径改写据此进行
 *   paragraph.data.indent = n   段首缩进的全角字数；段落文本本身不带全角空格，由 md 渲染器插入
 *   paragraph.data.role   = 'caption' | 'image_footnote'   图注 / 图片脚注；与图片靠「紧随其后」对应，不存图片名
 *   table.data.grid      = { rows: [ { header, cells: [ { colspan, rowspan, header, paragraphs } ] } ] }
 *                          docx 表格的结构化留存（parsers/docx-tables 写入）。GFM 表格表达不了合并单元格，
 *                          单元格内多段与行内格式也在 turndown 取 textContent 时一并丢失，故在解析层另存一份：
 *                          colspan / rowspan 为 ≥ 1 的整数，header 表示表头行 / 表头单元格，
 *                          paragraphs 为 [[行内节点…], …]（每段一个数组），行内节点只用 raster/fragment.js 的
 *                          nodeHtml 认得的类型（text / strong / emphasis / delete / underline / superscript /
 *                          subscript / break / inlineCode），不含任何 HTML 字符串。
 *                          目前只有 patent profile 的表格出图（raster/fragment.js 的 buildTableFragment）读该键；
 *                          md / html / docx / xml 渲染器不读它，表格照旧按 tableRow / tableCell 输出。
 *                          非 docx 来源的表格没有该键，出图走原先的 GFM 路径（首行为表头）
 *   <顶层节点>.data.section = { index, header }   docx 的 Word 分节序号（1 起）与该节生效页眉的纯文本；仅当文档
 *                          至少两节且至少一节页眉有文字时写入（parsers/docx-sections），patent profile 据此按页眉识别五书
 *
 * 顶层包装结构（MarkFlowDocument）：
 * {
 *   schemaVersion: 1,
 *   kind: 'document' | 'workbook' | 'presentation',
 *   ir:   <mdast root>,
 *   data: <格式特有数据快照，无则 null>,
 *   meta: { title?, sourceType, sourceName?, baseDir? },
 *   assets:   [{ name: 'images/image_1.png', buffer, mime }],
 *   extras:   [{ name: '{name}_layout.json', buffer }],   // sidecar 附属文件：落盘时按 name（posix 相对路径）写入产物目录，
 *                                                        // 其中的 {name} 占位符替换为产物名（见 converters/output.js）
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
