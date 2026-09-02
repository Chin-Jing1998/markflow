/**
 * IR → JSON
 *
 * 只序列化 { schemaVersion, kind, ir, data, meta }，不含 assets 与 warnings；
 * 2 空格缩进，便于人读。
 * IR 内挂载的二进制（如 image 节点 data.asset.buffer）一律略过，避免字节数组灌入 JSON。
 */

const JSON_INDENT = 2;

async function render(doc) {
    if (!doc || typeof doc !== 'object') {
        throw new Error('renderers/json 需要 MarkFlowDocument 对象');
    }
    const payload = {
        schemaVersion: doc.schemaVersion,
        kind: doc.kind,
        ir: doc.ir,
        data: doc.data === undefined ? null : doc.data,
        meta: doc.meta || {},
    };
    return JSON.stringify(payload, omitBinary, JSON_INDENT);
}

// JSON.stringify 会先调用 Buffer#toJSON 再交给 replacer，故须从 holder（this）上取原值判断
function omitBinary(key, value) {
    const raw = this[key];
    if (Buffer.isBuffer(raw) || raw instanceof Uint8Array || raw instanceof ArrayBuffer) {
        return undefined;
    }
    return value;
}

module.exports = { render };
