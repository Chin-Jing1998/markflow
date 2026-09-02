/** XLS（旧 Excel 二进制）→ IR：经 soffice 转 .xlsx 后委派 parsers/xlsx，细节见 _via-soffice.js */
const { createSofficeParser } = require('./_via-soffice');

module.exports = { parse: createSofficeParser('xls', 'xlsx', require('./xlsx')) };
