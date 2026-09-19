/**
 * VML 图片回归夹具（JSZip 按 OOXML 模板现造，不引入二进制文件，正文与替换文字全部虚构）
 *
 * 用法：测试中 `await buildVmlSample()` 取 Buffer；也可 `node test/fixtures/build-vml-sample.js <输出路径>` 落盘查看。
 *
 * 夹具内容（document.xml 顺序）：覆盖 docx-layout 把 v:imagedata 改写成 DrawingML 的各条分支。
 *   1. 引言文字段
 *   2. w:object + o:OLEObject ProgID="ChemDraw.Document.6.0"，预览图是不带 CDX 签名的普通 PNG
 *      → 角色只能来自判据 a（OLE ProgID），60pt × 30pt
 *   3. w:pict，v:imagedata 带 o:title                       → 还原该替换文字，45pt × 15pt
 *   4. w:pict，替换文字写在 v:shape 的 alt 上（无 o:title）  → 还原该替换文字（含 XML 实体），36pt × 12pt
 *   5. w:pict，同一 v:shape 内既有 v:imagedata 又有 v:textbox → 图片与文本框文字都要在，50pt × 20pt
 *   6. w:pict，style 带 position:absolute                    → data.floating，30pt × 10pt
 *   7. mc:AlternateContent：mc:Choice 为 DrawingML、mc:Fallback 为 VML
 *      → mammoth 只取 Fallback，故只应得一张图，尺寸按 VML 的 24pt × 8pt
 *   8. 普通 DrawingML 内嵌图，extent 120 × 60 px             → 与前面各 VML 图混排，尺寸不得串位
 * 各图的 pt 尺寸两两不等，据此验证显示尺寸按资产名对位而非按出现顺序凑对。
 *
 * mammoth 对 w:pict 的处置是「把内容提到所属段落之后」（body-reader 的 toExtra），故 3–7 的图片与
 * 文本框文字在 IR 里是段落的同级兄弟而非段内行内元素；本夹具只逐图比对，不约束它们落在哪个段落。
 * 8×8 的 PNG 直接取自 build-chemistry-sample 的导出，不再复制一份 PNG 构造代码。
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { PNG } = require('./build-chemistry-sample');

const EMU_PER_PX = 9525;
const PT_PER_INCH = 72;
const INCH_MM = 25.4;
const CSS_DPI = 96;
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DOC_NS = [
    `xmlns:w="${W_NS}"`,
    `xmlns:r="${R_NS}"`,
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
    'xmlns:v="urn:schemas-microsoft-com:vml"',
    'xmlns:o="urn:schemas-microsoft-com:office:office"',
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
].join(' ');

// CSS 长度换算（与 docx-layout 同一套定义，但在此按字面常量独立算一遍，供测试交叉核对）
const ptToMm = (pt) => (pt * INCH_MM) / PT_PER_INCH;
const ptToPx = (pt) => Math.round((pt * CSS_DPI) / PT_PER_INCH);
const pxToMm = (px) => (px * INCH_MM) / CSS_DPI;

const TEXTBOX_TEXT = '文本框里的字';
// 带 XML 实体的替换文字：源属性里是 &amp; 与 &quot;，改写时不得二次转义，还原后须是字面量
const SHAPE_ALT = '形状替换文字 & "引号"';
const CHOICE_DESCR = 'mc:Choice 里的图，mammoth 看不到';

/** 按 mammoth 截获顺序编号的资产与期望值；note 说明该图对应哪条分支 */
const VML_EXPECTED = Object.freeze({
    images: Object.freeze([
        Object.freeze({
            name: 'images/image_1.png', alt: '', role: 'chemistry', floating: false, pt: [60, 30],
            note: 'w:object 的 ChemDraw 预览图，判据 a',
        }),
        Object.freeze({
            name: 'images/image_2.png', alt: '标题替代文字', role: null, floating: false, pt: [45, 15],
            note: 'w:pict，替换文字取自 v:imagedata 的 o:title',
        }),
        Object.freeze({
            name: 'images/image_3.png', alt: SHAPE_ALT, role: null, floating: false, pt: [36, 12],
            note: 'w:pict，替换文字取自 v:shape 的 alt',
        }),
        Object.freeze({
            name: 'images/image_4.png', alt: '', role: null, floating: false, pt: [50, 20],
            note: 'w:pict，同一形状内还有文本框',
        }),
        Object.freeze({
            name: 'images/image_5.png', alt: '', role: null, floating: true, pt: [30, 10],
            note: 'w:pict，position:absolute',
        }),
        Object.freeze({
            name: 'images/image_6.png', alt: '', role: null, floating: false, pt: [24, 8],
            note: 'mc:Fallback 里的 VML 图（mc:Choice 的 DrawingML 不进 IR）',
        }),
    ]),
    // 末尾的 DrawingML 内嵌图：尺寸来自 wp:extent 的像素值，与前面各 VML 图不得串位
    drawing: Object.freeze({ name: 'images/image_7.png', alt: '内嵌图', px: [120, 60] }),
    textboxText: TEXTBOX_TEXT,
    choiceDescr: CHOICE_DESCR,
    ptToMm,
    ptToPx,
    pxToMm,
});

// ---------- document.xml 片段 ----------

const escapeXml = (text) => String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const run = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (content) => `<w:p>${content}</w:p>`;
const emu = (px) => px * EMU_PER_PX;
const shapeStyle = ([widthPt, heightPt], extra = '') => `${extra}width:${widthPt}pt;height:${heightPt}pt`;

function picGraphic(rid) {
    return '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
        + '<pic:nvPicPr><pic:cNvPr id="0" name="pic"/><pic:cNvPicPr/></pic:nvPicPr>'
        + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
        + '<pic:spPr/></pic:pic></a:graphicData></a:graphic>';
}

function inlineImage({ id, rid, descr, widthPx, heightPx }) {
    return '<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
        + `<wp:extent cx="${emu(widthPx)}" cy="${emu(heightPx)}"/>`
        + `<wp:docPr id="${id}" name="Picture ${id}" descr="${escapeXml(descr)}"/>`
        + `${picGraphic(rid)}</wp:inline></w:drawing>`;
}

// VML 图片：attrs 里的 title 写成 v:imagedata 的 o:title，alt 写成 v:shape 的 alt
function vmlShape({ shapeId, rid, pt, absolute = false, title, alt, inner = '' }) {
    const style = shapeStyle(pt, absolute ? 'position:absolute;' : '');
    return `<v:shape id="${shapeId}" type="#_x0000_t75" style="${style}"`
        + `${alt === undefined ? '' : ` alt="${escapeXml(alt)}"`}>`
        + `<v:imagedata r:id="${rid}"${title === undefined ? '' : ` o:title="${escapeXml(title)}"`}/>`
        + `${inner}</v:shape>`;
}

const pict = (shape) => `<w:r><w:pict>${shape}</w:pict></w:r>`;

// OLE 对象：v:imagedata 是预览图，o:OLEObject 带 ProgID
function oleObject({ shapeId, rid, progId, pt }) {
    return `<w:r><w:object w:dxaOrig="1200" w:dyaOrig="600">${vmlShape({ shapeId, rid, pt, title: '' })}`
        + `<o:OLEObject Type="Embed" ProgID="${progId}" ShapeID="${shapeId}" DrawAspect="Content" ObjectID="_1" r:id="${rid}"/>`
        + '</w:object></w:r>';
}

const textbox = (text) => `<v:textbox><w:txbxContent><w:p>${run(text)}</w:p></w:txbxContent></v:textbox>`;

function alternateContent({ shapeId, rid, pt, choicePx }) {
    return '<w:r><mc:AlternateContent><mc:Choice Requires="wps">'
        + inlineImage({ id: 90, rid, descr: CHOICE_DESCR, widthPx: choicePx[0], heightPx: choicePx[1] })
        + `</mc:Choice><mc:Fallback><w:pict>${vmlShape({ shapeId, rid, pt })}</w:pict></mc:Fallback>`
        + '</mc:AlternateContent></w:r>';
}

function documentXml() {
    const body = [
        paragraph(run('VML 图片样例')),
        paragraph(oleObject({ shapeId: '_x0000_i1026', rid: 'rId10', progId: 'ChemDraw.Document.6.0', pt: [60, 30] })),
        paragraph(pict(vmlShape({ shapeId: '_x0000_s1027', rid: 'rId10', pt: [45, 15], title: '标题替代文字' }))),
        paragraph(pict(vmlShape({ shapeId: '_x0000_s1028', rid: 'rId10', pt: [36, 12], alt: SHAPE_ALT }))),
        paragraph(pict(vmlShape({
            shapeId: '_x0000_s1029', rid: 'rId10', pt: [50, 20], inner: textbox(TEXTBOX_TEXT),
        }))),
        paragraph(pict(vmlShape({ shapeId: '_x0000_s1030', rid: 'rId10', pt: [30, 10], absolute: true }))),
        // 隔开浮动图与下一张图：ir/captions 会把浮动图从所在段落的文字中取出并排到该段之后，
        // 两张图落进同一段时顺序就不再是文档顺序（既有行为，与本夹具要验的事无关）
        paragraph(run('浮动图与替代内容之间的过渡文字')),
        paragraph(alternateContent({ shapeId: '_x0000_s1031', rid: 'rId10', pt: [24, 8], choicePx: [800, 400] })),
        paragraph(`<w:r>${inlineImage({ id: 8, rid: 'rId10', descr: '内嵌图', widthPx: 120, heightPx: 60 })}</w:r>`),
    ].join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${DOC_NS}><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';

const relationships = (items) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R_NS}/${type}" Target="${target}"/>`).join('')
    + '</Relationships>';

async function buildVmlSample() {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
    zip.file('_rels/.rels', relationships([['rId1', 'officeDocument', 'word/document.xml']]));
    zip.file('word/_rels/document.xml.rels', relationships([['rId10', 'image', 'media/image1.png']]));
    zip.file('word/document.xml', documentXml());
    zip.file('word/media/image1.png', PNG);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

if (require.main === module) {
    const target = path.resolve(process.argv[2] || path.join(__dirname, 'vml-sample.docx'));
    buildVmlSample()
        .then((buffer) => {
            fs.writeFileSync(target, buffer);
            console.log(`已生成 ${target}（${buffer.length} 字节）`);
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { buildVmlSample, VML_EXPECTED, documentXml };
