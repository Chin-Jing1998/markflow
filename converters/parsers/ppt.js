/** PPT（旧 PowerPoint 二进制）→ IR：经 soffice 转 .pptx 后委派 parsers/pptx，细节见 _via-soffice.js */
const { createSofficeParser } = require('./_via-soffice');

module.exports = { parse: createSofficeParser('ppt', 'pptx', require('./pptx')) };
