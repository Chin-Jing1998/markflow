/** DOC（旧 Word 二进制）→ IR：经 soffice 转 .docx 后委派 parsers/docx，细节见 _via-soffice.js */
const { createSofficeParser } = require('./_via-soffice');

module.exports = { parse: createSofficeParser('doc', 'docx', require('./docx')) };
