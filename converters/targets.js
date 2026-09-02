/**
 * 目标裁决与输入归类（CLI 与 MCP 共用）
 *
 * resolveTarget(inputType, requested) → 目标格式；未指定时按输入类型取默认值，不合法时抛中文错误。
 * classifyInput(raw, cwd)             → { input: { path } | { url }, type }；相对路径按 cwd 解析为绝对路径。
 *
 * 本模块只做纯逻辑判断，不触碰文件系统：存在性由调用方（CLI 预检）或 converters.convert 负责。
 */
const path = require('path');
const { detectInputType, SUPPORTED_EXTENSIONS } = require('./index');

// 输入类型 → 默认目标：办公文档与网页出 bundle，Markdown 出 docx
const DEFAULT_TARGETS = Object.freeze({
    docx: 'bundle',
    doc: 'bundle',
    xlsx: 'bundle',
    xls: 'bundle',
    pptx: 'bundle',
    ppt: 'bundle',
    pdf: 'bundle',
    url: 'bundle',
    md: 'docx',
});
// 目标 → 接受的输入类型（与 converters/index.js 的 TARGET_CLASSES 保持一致）
const TARGET_INPUTS = Object.freeze({
    bundle: ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'pdf', 'url'],
    docx: ['md'],
    pdf: ['md'],
});
const TARGET_HINTS = Object.freeze({
    bundle: 'bundle 仅接受 Office、PDF 文件与网页输入',
    docx: 'docx 仅接受 Markdown 输入',
    pdf: 'pdf 仅接受 Markdown 输入',
});
const TARGETS = Object.freeze(Object.keys(TARGET_INPUTS));

function resolveTarget(inputType, requested) {
    const fallback = DEFAULT_TARGETS[inputType];
    if (!fallback) throw new Error(`不支持的输入类型：${inputType || '(空)'}`);
    if (requested === undefined || requested === null || requested === '') return fallback;
    const accepted = TARGET_INPUTS[requested];
    if (!accepted) throw new Error(`不支持的目标格式：${requested}（可选：${TARGETS.join('、')}）`);
    if (!accepted.includes(inputType)) {
        throw new Error(`目标 ${requested} 不接受 ${inputType} 输入：${TARGET_HINTS[requested]}`);
    }
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

module.exports = { resolveTarget, classifyInput, DEFAULT_TARGETS, TARGETS };
