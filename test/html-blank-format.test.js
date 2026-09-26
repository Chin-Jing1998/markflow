/**
 * converters/renderers/html.js：填空横线（只含空白的 underline / delete 节点）里的半角空格在 HTML 产物中改写为 U+00A0
 * 成因：浏览器按 CSS 空白处理把连续半角空格折成一个、块首块尾的整段删除，<u>      </u> 在段中只剩一个空格宽的横线，
 *       在段首段尾整个不见；U+00A0 不属可折叠空白，六个即六个字宽。
 * 覆盖：段中、段首、段尾、整段只有填空、删除线填空、加粗包着下划线、下划线包着加粗、表格单元格与标题内的填空改写为 U+00A0；
 *       混合空白只改半角空格；有文字的下划线、夹着换行的帧、只含全角空格或 U+00A0 的填空原样输出；入参 IR 不改动；
 *       与 docx 解析器串联：现造 docx 的填空在 html 产物中为 U+00A0。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const htmlRenderer = require('../converters/renderers/html');
const { normalizeOptions } = require('../converters/options');
const { parse } = require('../converters/parsers/docx');

// 不可见字符以码点生成：U+00A0 不换行空格、U+3000 全角空格
const NBSP = String.fromCharCode(0xa0);
const IDEO = String.fromCharCode(0x3000);
const SP = (count) => ' '.repeat(count);
const NB = (count) => NBSP.repeat(count);

const text = (value) => ({ type: 'text', value });
const underline = (...children) => ({ type: 'underline', children });
const del = (...children) => ({ type: 'delete', children });
const strong = (...children) => ({ type: 'strong', children });
const paragraph = (...children) => ({ type: 'paragraph', children });
const heading = (...children) => ({ type: 'heading', depth: 2, children });
const makeDoc = (...blocks) => ({
    schemaVersion: 1, kind: 'document', ir: { type: 'root', children: blocks }, meta: { title: '填空' }, assets: [], warnings: [], data: null,
});

async function renderBody(doc) {
    const page = await htmlRenderer.render(doc, normalizeOptions({}), { imageMode: 'relative' });
    return page.slice(page.indexOf('<body>') + '<body>'.length, page.indexOf('</body>')).trim();
}

test('段中、段首、段尾与整段只有填空：<u> 内的半角空格全部改写为 U+00A0，其余文本不变', async () => {
    assert.equal(await renderBody(makeDoc(paragraph(text('甲方：'), underline(text(SP(6))), text('（盖章）')))), `<p>甲方：<u>${NB(6)}</u>（盖章）</p>`);
    assert.equal(await renderBody(makeDoc(paragraph(underline(text(SP(6))), text('（盖章）')))), `<p><u>${NB(6)}</u>（盖章）</p>`);
    assert.equal(await renderBody(makeDoc(paragraph(text('甲方：'), underline(text(SP(6)))))), `<p>甲方：<u>${NB(6)}</u></p>`);
    assert.equal(await renderBody(makeDoc(paragraph(underline(text(SP(6)))))), `<p><u>${NB(6)}</u></p>`);
});

test('删除线填空、加粗包着下划线、下划线包着加粗、标题与表格单元格内的填空同样改写', async () => {
    assert.equal(await renderBody(makeDoc(paragraph(text('甲'), del(text(SP(4))), text('乙')))), `<p>甲<del>${NB(4)}</del>乙</p>`);
    assert.equal(await renderBody(makeDoc(paragraph(text('甲'), strong(underline(text(SP(4)))), text('乙')))), `<p>甲<strong><u>${NB(4)}</u></strong>乙</p>`);
    assert.equal(await renderBody(makeDoc(paragraph(text('甲'), underline(strong(text(SP(4)))), text('乙')))), `<p>甲<u><strong>${NB(4)}</strong></u>乙</p>`);
    assert.equal(await renderBody(makeDoc(heading(text('第'), underline(text(SP(3))), text('条')))), `<h2>第<u>${NB(3)}</u>条</h2>`);
    const table = {
        type: 'table',
        align: [null],
        children: [
            { type: 'tableRow', children: [{ type: 'tableCell', children: [text('名称')] }] },
            { type: 'tableRow', children: [{ type: 'tableCell', children: [text('甲：'), underline(text(SP(5)))] }] },
        ],
    };
    const body = await renderBody(makeDoc(table));
    assert.ok(body.includes(`<td>甲：<u>${NB(5)}</u></td>`), body);
});

test('混合空白只改半角空格；有文字的下划线、夹着换行的帧、只含全角空格或 U+00A0 的填空原样输出', async () => {
    assert.equal(await renderBody(makeDoc(paragraph(underline(text(` ${IDEO}${NBSP} `))))), `<p><u>${NBSP}${IDEO}${NBSP}${NBSP}</u></p>`);
    assert.equal(await renderBody(makeDoc(paragraph(underline(text('张三   ')), text('乙')))), '<p><u>张三   </u>乙</p>');
    // 夹着换行的帧不改写：产物与改动前逐字相同（换行之后的空白由 mdast-util-to-hast 丢弃，属既有表现）
    assert.equal(await renderBody(makeDoc(paragraph(text('甲'), underline(text('  '), { type: 'break' }, text('  ')), text('乙')))), '<p>甲<u>  <br>\n</u>乙</p>');
    assert.equal(await renderBody(makeDoc(paragraph(underline(text(IDEO.repeat(3)))))), `<p><u>${IDEO.repeat(3)}</u></p>`);
    assert.equal(await renderBody(makeDoc(paragraph(underline(text(NB(3)))))), `<p><u>${NB(3)}</u></p>`);
    // 只有加粗的空格没有可见形态，不改写
    assert.equal(await renderBody(makeDoc(paragraph(text('甲'), strong(text(SP(3))), text('乙')))), '<p>甲<strong>   </strong>乙</p>');
});

test('入参 IR 不改动', async () => {
    const doc = makeDoc(paragraph(text('甲方：'), underline(text(SP(6))), text('（盖章）')));
    const snapshot = JSON.stringify(doc.ir);
    await renderBody(doc);
    assert.equal(JSON.stringify(doc.ir), snapshot);
});

// ---------- 与 docx 解析器串联 ----------

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
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

async function buildDocx(bodyXml) {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
    zip.file('_rels/.rels', relationships([['rId1', 'officeDocument', 'word/document.xml']]));
    zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('docx → html：现造 docx 中带下划线的 6 个空格在 html 产物中为 <u> 包着 6 个 U+00A0', async () => {
    const body = '<w:p><w:r><w:t>甲方：</w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">      </w:t></w:r><w:r><w:t>（盖章）</w:t></w:r></w:p>';
    const doc = await parse({ buffer: await buildDocx(body) }, { sourceName: '填空.docx' });

    assert.equal(await renderBody(doc), `<p>甲方：<u>${NB(6)}</u>（盖章）</p>`);
});
