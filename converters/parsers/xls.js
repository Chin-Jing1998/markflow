/**
 * XLS (旧 Excel 二进制) → IR
 * 通过 soffice 转为 .xlsx，再交给 parsers/xlsx
 */
const { convertWithSoffice } = require('../../server/soffice');
const xlsxParser = require('./xlsx');

async function parse(buffer, meta = {}) {
    if (!Buffer.isBuffer(buffer)) {
        throw new Error('parsers/xls 期望 source 为 Buffer');
    }
    const xlsxBuffer = await convertWithSoffice(buffer, 'xls', 'xlsx');
    return await xlsxParser.parse(xlsxBuffer, meta);
}

module.exports = { parse };
