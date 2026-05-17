/**
 * DOC (旧 Word 二进制) → IR
 * 通过 soffice 转为 .docx，再交给 parsers/docx
 */
const { convertWithSoffice } = require('../../server/soffice');
const docxParser = require('./docx');

async function parse(buffer, meta = {}) {
    if (!Buffer.isBuffer(buffer)) {
        throw new Error('parsers/doc 期望 source 为 Buffer');
    }
    const docxBuffer = await convertWithSoffice(buffer, 'doc', 'docx');
    return await docxParser.parse(docxBuffer, meta);
}

module.exports = { parse };
