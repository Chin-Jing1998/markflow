/**
 * docx 标题选取回归夹具（JSZip 按 OOXML 模板现造，不引入二进制文件）
 *
 * 用法：测试中 `await buildTitleSample()` 取 Buffer；也可 `node test/fixtures/build-title-sample.js <输出路径>` 落盘查看。
 *
 * 触发结构仿中文版 Word：样式 ID 与样式名不同（Title 样式 w:styleId="a4"、heading 1 样式 w:styleId="1"），
 * 封面题名段套 Title 样式而非标题 1，正文首个 heading 1 段是章标题。
 * 夹具内容（document.xml 顺序）：
 *   1. 空段落
 *   2. Title 样式段「样例评价手册」（title 参数可改写；传空串得无文字的 Title 段）
 *   3. 普通段「目录」
 *   4. heading 1 段「第一章 概述」
 *   5. 普通段正文
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 测试用的期望值：Title 样式段文本与首个 heading 1 的文本 */
const TITLE_EXPECTED = Object.freeze({ title: '样例评价手册', heading: '第一章 概述' });

// ---------- document.xml 片段 ----------

const run = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (content, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`;
const pStyle = (id) => `<w:pStyle w:val="${id}"/>`;

function documentXml(title) {
    const body = [
        paragraph(''),
        paragraph(title ? run(title) : '', pStyle('a4')),
        paragraph(run('目录')),
        paragraph(run(TITLE_EXPECTED.heading), pStyle('1')),
        paragraph(run('正文段落。')),
    ].join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W_NS}">`
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="a4"><w:name w:val="Title"/><w:basedOn w:val="a"/><w:rPr><w:sz w:val="72"/></w:rPr></w:style>'
    + '</w:styles>';

const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '</Types>';

const relationships = (items) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R_NS}/${type}" Target="${target}"/>`).join('')
    + '</Relationships>';

/** @param {{ title?: string }} [options] title 为 Title 样式段的文本，缺省取 TITLE_EXPECTED.title */
async function buildTitleSample({ title = TITLE_EXPECTED.title } = {}) {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
    zip.file('_rels/.rels', relationships([['rId1', 'officeDocument', 'word/document.xml']]));
    zip.file('word/_rels/document.xml.rels', relationships([['rId1', 'styles', 'styles.xml']]));
    zip.file('word/document.xml', documentXml(title));
    zip.file('word/styles.xml', STYLES_XML);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

if (require.main === module) {
    const target = path.resolve(process.argv[2] || path.join(__dirname, 'title-sample.docx'));
    buildTitleSample()
        .then((buffer) => {
            fs.writeFileSync(target, buffer);
            console.log(`已生成 ${target}（${buffer.length} 字节）`);
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { buildTitleSample, TITLE_EXPECTED };
