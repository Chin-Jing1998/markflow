/**
 * PPT (旧 PowerPoint 二进制) → IR
 * 通过 soffice 转为 .pptx，再交给 parsers/pptx
 */
const { convertWithSoffice } = require('../../server/soffice');
const pptxParser = require('./pptx');

async function parse(buffer, meta = {}) {
    if (!Buffer.isBuffer(buffer)) {
        throw new Error('parsers/ppt 期望 source 为 Buffer');
    }
    const pptxBuffer = await convertWithSoffice(buffer, 'ppt', 'pptx');
    return await pptxParser.parse(pptxBuffer, meta);
}

module.exports = { parse };
