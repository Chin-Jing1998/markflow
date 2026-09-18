/**
 * 表格结构回归夹具（JSZip 按 OOXML 模板现造，不引入二进制文件，正文内容全部虚构）
 *
 * 用法：测试中 `await buildTableSample()` 取 Buffer；也可 `node test/fixtures/build-table-sample.js <输出路径>` 落盘查看。
 *
 * 夹具内容（document.xml 顺序）：
 *   段落「前言」
 *   表一（3 个网格列，覆盖表头行、横向合并、纵向合并、单元格内多段与各行内格式）：
 *     行 1  w:tblHeader 表头行：[gridSpan=2「表头甲」][「表头乙」]
 *     行 2  [gridSpan=2「横合并」][vMerge=restart「纵合并起」]
 *     行 3  [两段：「普通」/「第二段 」+粗+斜+下划线+上标+下标][「丙」][vMerge=continue 空]
 *   表二（2 个网格列，无合并、无表头）：行 1 [「甲」][「乙」]
 *   段落「结尾」
 *
 * mammoth 的既定行为（夹具的判据据此写）：
 *   - w:tblHeader 的行转成 <thead> 内的 <th>，其余行转成 <tbody> 内的 <td>
 *   - w:gridSpan → colspan 属性；vMerge restart/continue 合成 rowspan 属性并删去 continue 单元格
 *   - 单元格内每个 w:p 转成一个 <p>；属性为 1 的 colspan / rowspan 不写入属性
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DOC_NS = `xmlns:w="${W_NS}" xmlns:r="${R_NS}"`;

/** 表一的第 3 行第 1 个单元格里，第二段各行内格式对应的文字 */
const INLINE_TEXTS = Object.freeze({
    plain: '第二段 ', bold: '粗', italic: '斜', underline: '下', superscript: '上', subscript: '标',
});

// ---------- OOXML 片段 ----------

const text = (value) => `<w:t xml:space="preserve">${value}</w:t>`;
const run = (value, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${text(value)}</w:r>`;
const paragraph = (inner = '') => `<w:p>${inner}</w:p>`;
const textParagraph = (value) => paragraph(run(value));

/** @param {{ gridSpan?: number, vMerge?: 'restart' | 'continue' }} props */
function cell(paragraphs, props = {}) {
    const parts = [
        props.gridSpan ? `<w:gridSpan w:val="${props.gridSpan}"/>` : '',
        props.vMerge ? `<w:vMerge w:val="${props.vMerge}"/>` : '',
    ].join('');
    return `<w:tc>${parts ? `<w:tcPr>${parts}</w:tcPr>` : ''}${paragraphs}</w:tc>`;
}

const row = (cells, { header = false } = {}) => `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.join('')}</w:tr>`;

const table = (rows, columns) => '<w:tbl><w:tblPr><w:tblW w:type="auto" w:w="0"/></w:tblPr>'
    + `<w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(columns)}</w:tblGrid>${rows.join('')}</w:tbl>`;

/** 表一第 3 行首个单元格的第二段：一段里连用五种行内格式 */
function formattedParagraph() {
    const { plain, bold, italic, underline, superscript, subscript } = INLINE_TEXTS;
    return paragraph([
        run(plain),
        run(bold, '<w:b/>'),
        run(italic, '<w:i/>'),
        run(underline, '<w:u w:val="single"/>'),
        run(superscript, '<w:vertAlign w:val="superscript"/>'),
        run(subscript, '<w:vertAlign w:val="subscript"/>'),
    ].join(''));
}

function mergedTable() {
    return table([
        row([cell(textParagraph('表头甲'), { gridSpan: 2 }), cell(textParagraph('表头乙'))], { header: true }),
        row([cell(textParagraph('横合并'), { gridSpan: 2 }), cell(textParagraph('纵合并起'), { vMerge: 'restart' })]),
        row([
            cell(`${textParagraph('普通')}${formattedParagraph()}`),
            cell(textParagraph('丙')),
            cell(paragraph(), { vMerge: 'continue' }),
        ]),
    ], 3);
}

const plainTable = () => table([row([cell(textParagraph('甲')), cell(textParagraph('乙'))])], 2);

function documentXml() {
    const body = [textParagraph('前言'), mergedTable(), plainTable(), textParagraph('结尾')].join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${DOC_NS}><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

// ---------- 包体 ----------

const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';

const relationships = (items) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R_NS}/${type}" Target="${target}"/>`).join('')
    + '</Relationships>';

async function buildTableSample() {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
    zip.file('_rels/.rels', relationships([['rId1', 'officeDocument', 'word/document.xml']]));
    zip.file('word/_rels/document.xml.rels', relationships([]));
    zip.file('word/document.xml', documentXml());
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

if (require.main === module) {
    const target = path.resolve(process.argv[2] || path.join(__dirname, 'table-sample.docx'));
    buildTableSample()
        .then((buffer) => {
            fs.writeFileSync(target, buffer);
            console.log(`已生成 ${target}（${buffer.length} 字节）`);
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { buildTableSample, INLINE_TEXTS };
