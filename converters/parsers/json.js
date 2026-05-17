/**
 * JSON → IR（回灌路径）
 *
 * 输入必须是 MarkFlow JSON schema：{ schemaVersion: 1, kind, ir, data, meta }
 */
const { SCHEMA_VERSION } = require('../ir/schema');

async function parse(text, meta = {}) {
    let doc;
    try {
        doc = typeof text === 'string' ? JSON.parse(text) : text;
    } catch (e) {
        throw new Error(`JSON 解析失败：${e.message}`);
    }

    if (!doc || typeof doc !== 'object') {
        throw new Error('JSON 不是有效的 MarkFlow 文档对象');
    }

    if (doc.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(
            `JSON schemaVersion=${doc.schemaVersion} 不受支持（当前仅 v${SCHEMA_VERSION}）`,
        );
    }

    if (!doc.ir || doc.ir.type !== 'root') {
        throw new Error('JSON 缺少有效的 ir 字段（应为 mdast root 节点）');
    }

    return {
        ...doc,
        meta: { ...(doc.meta || {}), ...meta, sourceType: 'json' },
    };
}

module.exports = { parse };
