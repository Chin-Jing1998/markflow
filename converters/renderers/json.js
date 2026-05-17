/**
 * IR → JSON
 * 直接 stringify MarkFlowDocument（{schemaVersion, kind, ir, data, meta}）
 * 序列化时使用 2 空格缩进，便于人读。
 */

async function render(doc) {
    return JSON.stringify(doc, null, 2);
}

module.exports = { render };
