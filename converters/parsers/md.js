/**
 * Markdown → IR
 * remark-parse 把 MD 字符串解析为 mdast
 */
const { loadUnified } = require('../ir/unified-loader');
const { createDocument } = require('../ir/schema');

async function parse(text, meta = {}) {
    const { unified, remarkParse } = await loadUnified();
    const ir = unified().use(remarkParse).parse(String(text || ''));
    return createDocument({
        kind: 'document',
        ir,
        meta: { sourceType: 'md', ...meta },
    });
}

module.exports = { parse };
