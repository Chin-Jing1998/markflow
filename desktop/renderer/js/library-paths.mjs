/**
 * 文件库记录 → 可直接阅读的主文件（渲染层纯逻辑，无 DOM 依赖；Node 测试经 import() 载入）
 *
 * READABLE_OUTPUT_KEYS：outputs 键的优先级 —— md → html → xml → 专利五书（说明书优先，其次权利要求书、摘要、附图、
 * 摘要附图）→ pdf → json。专利 xml 记录没有 xml 键，按此顺序即打开说明书。
 * readablePathForRecord(record)：按上表取第一个可阅读扩展名的路径；都没有时回退 outputPath（须以可阅读扩展名结尾），否则 ''。
 */
export const READABLE_OUTPUT_KEYS = Object.freeze([
    'md', 'html', 'xml', 'description', 'claims', 'abstract', 'drawings', 'abstractFigure', 'pdf', 'json',
]);

const READABLE_PATH_RE = /\.(?:md|html?|xml|pdf|json)$/i;

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

export function readablePathForRecord(record) {
    const outputs = record && record.outputs && typeof record.outputs === 'object' ? record.outputs : {};
    for (const key of READABLE_OUTPUT_KEYS) {
        const value = trimmed(outputs[key]);
        if (value && READABLE_PATH_RE.test(value)) return value;
    }
    const outputPath = trimmed(record && record.outputPath);
    return READABLE_PATH_RE.test(outputPath) ? outputPath : '';
}
