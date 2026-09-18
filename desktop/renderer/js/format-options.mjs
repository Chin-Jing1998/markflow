/**
 * 格式选项的纯逻辑（不碰 DOM，Node 可直接 import 作单元测试）
 *
 * 由 <mf-format-panel> 的字段表与三处共用的取值文案构成，另含三个判定函数：
 *   effectiveDefault(node, profile)          描述树节点在该 xml 方言下实际会生效的缺省值
 *   shouldSubmit(key, { touched, options })  某个键这次该不该作为「显式值」提交
 *   describeKeys(keys)                       扁平键名数组 → 中文标签串（用于重新解析的轻提示）
 *
 * 「显式值」语义（本模块存在的理由）：面板上每个控件都有当前显示值，但显示值不等于用户的选择。
 * 无差别提交全部可见字段会把「用户没动过、只是显示着缺省值」的项变成显式值，越过内核按 profile 补默认值的逻辑
 * （典型后果：patent 方言下 jpegPpi 本应取 300，却被面板提交的 330 盖掉，出图密度超出官方受理的 72–300 DPI）。
 * 故只提交两类键：会话当前选项里本来就显式存在的，以及用户在本面板上实际改动过的。
 */

/** 字段对全部目标都有意义时 targets 取该标记 */
export const ALL_TARGETS = '*';

export const GROUPS = Object.freeze([
    { key: 'layout', title: '排版', hint: '改动即时重渲染' },
    { key: 'xml', title: 'XML', hint: '' },
    { key: 'parse', title: '解析', hint: '改动后需重新解析源文件' },
]);

/**
 * path 为 describeOptions() 描述树中的路径（对象层用 fields 下钻）；
 * targets / types 限定该字段对哪些目标与输入类型有意义；profile 限定只在该 xml 方言下出现；
 * hint 给出时替代描述树里的 description 作为该字段的悬停说明；reparse 为真表示改动后须重新解析源文件。
 */
export const FIELDS = Object.freeze([
    { key: 'theme', label: '主题', group: 'layout', targets: ['html', 'pdf'], path: ['html', 'theme'] },
    { key: 'font', label: '正文字体', group: 'layout', targets: ['html', 'pdf'], path: ['html', 'fontFamily'], placeholder: '留空取主题默认' },
    { key: 'fontSize', label: '正文字号', group: 'layout', targets: ['html', 'pdf', 'docx'], path: ['html', 'fontSize'] },
    { key: 'lineHeight', label: '行高', group: 'layout', targets: ['html', 'pdf'], path: ['html', 'lineHeight'], step: 0.05 },
    { key: 'contentWidth', label: '正文栏宽', group: 'layout', targets: ['html'], path: ['html', 'contentWidth'] },
    { key: 'spacing', label: '段落间距', group: 'layout', targets: ['html', 'pdf'], path: ['html', 'spacing'] },
    { key: 'inlineImages', label: '图片内联为 data URI', group: 'layout', targets: ['html'], path: ['html', 'inlineImages'] },
    { key: 'pageSize', label: '纸张', group: 'layout', targets: ['pdf', 'docx'], path: ['pdf', 'pageSize'] },
    { key: 'landscape', label: '横向', group: 'layout', targets: ['pdf'], path: ['pdf', 'landscape'] },

    { key: 'xmlProfile', label: 'XML 方言', group: 'xml', targets: ['xml'], path: ['xml', 'profile'], reparse: true },
    { key: 'xmlIndent', label: '缩进空格数', group: 'xml', targets: ['xml'], path: ['xml', 'indent'] },
    // DTD 校验只在渲染阶段发生（不进 REPARSE_KEYS），勾选后重渲染即可拿到 precheck.json 的 validation
    { key: 'validate', label: 'DTD 校验（官方 DTD）', group: 'xml', targets: ['xml'], path: ['xml', 'validate'], profile: 'patent' },
    { key: 'numberingStart', label: '段号起始', group: 'xml', targets: ['xml'], path: ['xml', 'numbering', 'start'], profile: 'patent' },
    { key: 'numberingWidth', label: '段号补零位数', group: 'xml', targets: ['xml'], path: ['xml', 'numbering', 'width'], profile: 'patent' },
    { key: 'patentParts', label: '输出的五书', group: 'xml', targets: ['xml'], path: ['xml', 'patent', 'parts'], profile: 'patent', reparse: true },
    { key: 'sectionDetection', label: '分节识别', group: 'xml', targets: ['xml'], path: ['xml', 'patent', 'sectionDetection'], profile: 'patent', reparse: true },
    { key: 'rasterizeTables', label: '表格栅格为图片', group: 'xml', targets: ['xml'], path: ['xml', 'patent', 'rasterizeTables'], profile: 'patent', reparse: true },
    { key: 'rasterizeFormulas', label: '公式栅格为图片', group: 'xml', targets: ['xml'], path: ['xml', 'patent', 'rasterizeFormulas'], profile: 'patent', reparse: true },
    { key: 'imageDpi', label: '图片密度（DPI）', group: 'xml', targets: ['xml'], path: ['xml', 'patent', 'imageDpi'], profile: 'patent', reparse: true },

    { key: 'imageFormat', label: '图片格式', group: 'parse', targets: ALL_TARGETS, path: ['imageFormat'], reparse: true },
    { key: 'jpegPpi', label: 'JPG 分辨率（PPI）', group: 'parse', targets: ALL_TARGETS, path: ['jpegPpi'], reparse: true },
    { key: 'math', label: '文档公式', group: 'parse', targets: ALL_TARGETS, path: ['math'], types: ['docx'], reparse: true },
    { key: 'pdfBackend', label: 'PDF 解析后端', group: 'parse', targets: ALL_TARGETS, path: ['pdfBackend'], types: ['pdf'], reparse: true },
    // 专利五书 XML 反向导入：只对 xml / zip 输入有意义，作用于解析阶段，故与目标无关且需重新解析
    {
        key: 'xmlImportParagraphNumbers', label: '段号写进正文', group: 'parse', targets: ALL_TARGETS,
        path: ['xmlImport', 'paragraphNumbers'], types: ['xml', 'zip'], reparse: true,
        hint: '把五书 XML 的段号写进 Word 正文（[0001]），便于对照审查意见里的段号；代价是段号留在正文里会妨碍增删段落。不勾选时段号不写入，转回 XML 时按顺序重编',
    },
]);

/** 格式面板里各枚举取值的中文文案 */
export const ENUM_LABELS = Object.freeze({
    apple: '苹果浅色', 'apple-dark': '苹果深色', github: 'GitHub', academic: '论文（衬线）', reader: '长文阅读', print: '打印',
    compact: '紧凑', normal: '标准', loose: '宽松',
    jpg: 'JPG 归一', keep: '保持原格式',
    image: '栅格为图片', text: '线性化文本',
    auto: '自动', mineru: 'MinerU 云端', local: '本地 pdfjs',
    generic: 'generic 通用结构', patent: 'patent 国知局五书',
    headings: '仅标题',
    claims: '权利要求书', description: '说明书', drawings: '说明书附图', abstract: '摘要', 'abstract-figure': '摘要附图',
});

/** XML 方言的简短文案：转换页底栏与设置页的下拉用它（格式面板沿用上面带原值前缀的长文案） */
export const XML_PROFILE_LABELS = Object.freeze({ generic: '通用结构', patent: '国知局五书' });

export const labelOf = (value) => ENUM_LABELS[value] || String(value);
export const profileLabel = (value) => XML_PROFILE_LABELS[value] || String(value);

const FIELD_BY_KEY = new Map(FIELDS.map((field) => [field.key, field]));

/** 扁平键名 → 该字段的中文标签；不是面板字段的键回退为键名本身 */
export const fieldLabel = (key) => {
    const field = FIELD_BY_KEY.get(key);
    return field ? field.label : String(key == null ? '' : key);
};

/** 一组扁平键名 → 顿号分隔的中文标签串（重新解析的轻提示用） */
export const describeKeys = (keys) => (Array.isArray(keys) ? keys : []).map(fieldLabel).join('、');

/** 描述树下钻：对象层的子字段挂在 fields 下 */
export function pickNode(tree, path) {
    let node = tree;
    for (let i = 0; i < path.length; i += 1) {
        if (!node) return null;
        node = i === 0 ? node[path[i]] : (node.fields ? node.fields[path[i]] : null);
    }
    return node || null;
}

/**
 * 该节点在这个 xml 方言下实际会生效的缺省值：节点带 profileDefaults 且命中当前方言时取它，否则取 default。
 * 取值一律来自描述树（converters/options.js 下发），界面不硬编码。
 */
export function effectiveDefault(node, profile) {
    if (!node) return undefined;
    const byProfile = node.profileDefaults && profile ? node.profileDefaults[profile] : undefined;
    return byProfile === undefined ? node.default : byProfile;
}

/** 选项里该键是否为「已显式给出」：undefined、null 与空串都算未给出 */
export const isExplicit = (options, key) => {
    const value = options ? options[key] : undefined;
    return value !== undefined && value !== null && value !== '';
};

/**
 * 某个键这次该不该提交：会话选项里本来就显式存在的要原样带上（否则等于把它撤回），
 * 用户在面板上改动过的要提交；其余一律不提交，交内核取缺省值。
 */
export function shouldSubmit(key, { touched, options } = {}) {
    const edited = touched instanceof Set ? touched.has(key) : Array.isArray(touched) && touched.includes(key);
    return edited || isExplicit(options, key);
}

/** 在可见字段里筛出这次该提交的键，顺序与 FIELDS 一致 */
export function submittedKeys(visibleFields, state) {
    return (visibleFields || []).map((field) => field.key).filter((key) => shouldSubmit(key, state));
}

/** 当前目标 / 输入类型 / xml 方言下应显示的字段；hasNode 用来剔除描述树里没有的项 */
export function visibleFields({ target, type, profile }, hasNode = () => true) {
    return FIELDS.filter((field) => {
        if (field.targets !== ALL_TARGETS && !field.targets.includes(target)) return false;
        if (field.types && !field.types.includes(type)) return false;
        if (field.profile && field.profile !== (profile || 'generic')) return false;
        return Boolean(hasNode(field));
    });
}
