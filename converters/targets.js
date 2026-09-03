/**
 * 输入识别、归类与目标裁决（全仓单一来源）
 *
 * 本模块是「什么输入能转成什么目标」这一规则的唯一定义处：转换调度器
 * （converters/index.js）与两个入口（CLI、MCP）都从这里取用，不再各写一份。
 * 为此本模块不依赖 index.js，保持为叶子模块。
 *
 * detectInputType(pathOrUrl)          → 输入类型，无法识别返回 null
 * classifyInput(raw, cwd)             → { input: { path } | { url }, type }；相对路径按 cwd 解析为绝对路径
 * resolveTarget(inputType, requested) → 目标格式；未指定时按输入类型取默认值，不合法时抛中文错误
 * assertTargetAllowed(target, type)   → 不合法即抛中文错误，供 convert 复用同一套判定与措辞
 *
 * 本模块只做纯逻辑判断，不触碰文件系统：存在性由调用方（CLI 预检）或 convert 负责。
 */
const path = require('path');

// 扩展名 → 输入类型
const EXT_TO_TYPE = Object.freeze({
    '.docx': 'docx', '.doc': 'doc', '.xlsx': 'xlsx', '.xls': 'xls', '.pptx': 'pptx',
    '.ppt': 'ppt', '.pdf': 'pdf', '.md': 'md', '.markdown': 'md',
});
const SUPPORTED_EXTENSIONS = Object.freeze(Object.keys(EXT_TO_TYPE));

// 输入类型 → 输入类别（决定可选目标）；键序即 listTargets().inputs 的键序。
// 键必须与 detectInputType 的返回值一一对应：.markdown 已归入 md，故此处没有 markdown 键
const INPUT_CLASS = Object.freeze({
    docx: 'office', doc: 'office', xlsx: 'office', xls: 'office', pptx: 'office',
    ppt: 'office', pdf: 'office', md: 'markup', url: 'url',
});
// 旧二进制格式依赖 soffice 转码
const LEGACY_INPUT_TYPES = Object.freeze(['doc', 'xls', 'ppt']);
// 输入类别 → 未指定 --to 时的默认目标
const DEFAULT_TARGET_BY_CLASS = Object.freeze({ office: 'bundle', markup: 'docx', url: 'bundle' });
// 目标 → { 接受的输入类别, 拒绝时的提示 }；键序即错误提示中「可选」的罗列顺序
const TARGET_RULES = Object.freeze({
    bundle: { classes: ['office', 'url'], hint: 'bundle 仅接受 Office、PDF 文件与网页输入' },
    docx: { classes: ['markup'], hint: 'docx 仅接受 Markdown 输入' },
    pdf: { classes: ['markup'], hint: 'pdf 仅接受 Markdown 输入' },
});
const TARGETS = Object.freeze(Object.keys(TARGET_RULES));
// 输入类型 → 默认目标，由上面两张表派生，不另行维护
const DEFAULT_TARGETS = Object.freeze(Object.fromEntries(
    Object.entries(INPUT_CLASS).map(([type, cls]) => [type, DEFAULT_TARGET_BY_CLASS[cls]]),
));

const REMOTE_URL_RE = /^https?:\/\//i;

// 'docx'|'doc'|'xlsx'|'xls'|'pptx'|'ppt'|'pdf'|'md'|'url'|null
function detectInputType(pathOrUrl) {
    if (typeof pathOrUrl !== 'string' || !pathOrUrl.trim()) return null;
    const value = pathOrUrl.trim();
    if (REMOTE_URL_RE.test(value)) return 'url';
    return EXT_TO_TYPE[path.extname(value).toLowerCase()] || null;
}

function assertTargetAllowed(target, inputType) {
    const rule = TARGET_RULES[target];
    if (!rule) throw new Error(`不支持的目标格式：${target}（可选：${TARGETS.join('、')}）`);
    if (!rule.classes.includes(INPUT_CLASS[inputType])) {
        throw new Error(`目标 ${target} 不接受 ${inputType} 输入：${rule.hint}`);
    }
}

function resolveTarget(inputType, requested) {
    const fallback = DEFAULT_TARGETS[inputType];
    if (!fallback) throw new Error(`不支持的输入类型：${inputType || '(空)'}`);
    if (requested === undefined || requested === null || requested === '') return fallback;
    assertTargetAllowed(requested, inputType);
    return requested;
}

function classifyInput(raw, cwd) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) throw new Error('输入不能为空');
    const type = detectInputType(value);
    if (!type) {
        throw new Error(`不支持的输入格式：${value}（支持 ${SUPPORTED_EXTENSIONS.join(' ')} 与 http(s) 网址）`);
    }
    if (type === 'url') return { input: { url: value }, type };
    return { input: { path: path.resolve(cwd || process.cwd(), value) }, type };
}

module.exports = {
    detectInputType, classifyInput, resolveTarget, assertTargetAllowed,
    SUPPORTED_EXTENSIONS, INPUT_CLASS, LEGACY_INPUT_TYPES, DEFAULT_TARGETS, TARGETS, REMOTE_URL_RE,
};
