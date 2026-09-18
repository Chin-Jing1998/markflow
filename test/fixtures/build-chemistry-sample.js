/**
 * 化学式判据回归夹具（JSZip 按 OOXML 模板现造，不引入二进制文件，正文与结构式内容全部虚构）
 *
 * 用法：测试中 `await buildChemistrySample()` 取 Buffer；也可 `node test/fixtures/build-chemistry-sample.js <输出路径>` 落盘查看。
 *
 * 夹具内容（document.xml 顺序，方括号内为 docx-layout 分配的图片序号 k）：逐段一张图，覆盖
 * parsers/docx-chemistry 的四条化学式判据与通用角色标记的命中与不命中：
 *   [1]  DrawingML，descr「普通图」                                   → 无角色，alt 原样
 *   [2]  DrawingML，descr 以 <SIPOChemFile 开头                       → 判据 b；alt 清空
 *   [3]  DrawingML，descr「markflow:role=formula;公式甲」             → 角色标记 formula；alt 余「公式甲」
 *   [4]  DrawingML，descr「markflow:role=table」（无分号余文）          → 角色标记 table；alt 空
 *   [5]  DrawingML，descr「markflow:role=chemistryX」                 → 角色名后既非 ; 也非结尾，不匹配；alt 原样
 *   [12] w:object + o:OLEObject ProgID="ChemDraw.Document.6.0" 的预览图 → 判据 a，含版本后缀
 *   [13] w:object + o:OLEObject ProgID="Equation.DSMT4" 的预览图       → 公式编辑器，不命中
 *   [6]  复合域 EMBED KingDrawObject.Document 的域结果图               → 判据 c
 *   [7]  简单域 w:fldSimple EMBED FXChem.Equation 的域结果图           → 判据 c
 *   [8]  复合域 EMBED Equation.DSMT4 的域结果图                        → 不命中
 *   [9]  EMF，字节内含 CDIF + CDX 魔数                                 → 判据 d
 *   [10] EMF，字节内无该签名                                           → 不命中
 *   [11] EMF，只有 4 字节的截断文件                                     → 不命中且不抛错
 * 序号按 docx-layout 的收集次序分配：先全部 DrawingML（1–11），再全部 VML（12–13）。
 *
 * 两处 mammoth 行为决定了 CHEMISTRY_EXPECTED 只列 12 张图（源文档共 13 张）：
 *   - w:fldSimple 整体被 mammoth 忽略（warnings 里有 unrecognised element），故 [7] 的图不进 IR；
 *     判据 c 的简单域分支由 collectChemistryRanges 的单元测试直接覆盖。
 *   - VML 图片的序号标记写在 o:title 上，而 mammoth 的命名空间表不含
 *     urn:schemas-microsoft-com:office:office，该属性在它那里的键名是 Clark 记法，读不出来，
 *     故 [12][13] 的 altText 为 undefined、序号丢失，判据 a 到不了 IR（同一原因也让 OLE 预览图拿不到显示尺寸）。
 *     这是既有的标记传递缺口，不在本夹具的修复范围内；判据 a 由 prepareLayout 的 roles 与
 *     collectChemistryRanges 两级单元测试覆盖。
 *
 * 图片本体：PNG 为 8×8 单色，三张 EMF 按最小必要结构拼（EMF 头 + 一条注释记录 + EOF），
 * 只为让判据有字节可扫，不要求能被任何渲染器画出来。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const JSZip = require('jszip');

const EMU_PER_PX = 9525;
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
].join(' ');

// ---------- PNG（8×8 单色，写法沿用 build-layout-sample） ----------

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i += 1) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

function makePng(width, height) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(Buffer.alloc((width * 3 + 1) * height, 0))),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ---------- EMF（最小必要结构：EMR_HEADER + EMR_COMMENT + EMR_EOF） ----------

const EMR_HEADER = 1;
const EMR_COMMENT = 70;
const EMR_EOF = 14;
const EMF_SIGNATURE = 0x464D4520; // ' EMF'
const EMF_HEADER_SIZE = 88;
const EMF_EOF_SIZE = 20;
// EmfPlusComment 的注释数据首块：`CDIF\0` 标记后紧接 CDX 文档魔数（判据 d 的签名）
const CDX_COMMENT = Buffer.from('CDIF\x00VjCD0100 虚构结构式数据', 'latin1');
const PLAIN_COMMENT = Buffer.from('EMF+ 普通注释，不含化学数据', 'latin1');

function emrComment(payload) {
    const padded = Buffer.concat([payload, Buffer.alloc((4 - (payload.length % 4)) % 4)]);
    const record = Buffer.alloc(12 + padded.length);
    record.writeUInt32LE(EMR_COMMENT, 0);
    record.writeUInt32LE(record.length, 4);
    record.writeUInt32LE(padded.length, 8);
    padded.copy(record, 12);
    return record;
}

function makeEmf(commentPayload) {
    const comment = emrComment(commentPayload);
    const header = Buffer.alloc(EMF_HEADER_SIZE);
    header.writeUInt32LE(EMR_HEADER, 0);
    header.writeUInt32LE(EMF_HEADER_SIZE, 4);
    header.writeUInt32LE(EMF_SIGNATURE, 40);
    header.writeUInt32LE(0x00010000, 44);
    header.writeUInt32LE(EMF_HEADER_SIZE + comment.length + EMF_EOF_SIZE, 48);
    header.writeUInt32LE(3, 52);
    const eof = Buffer.alloc(EMF_EOF_SIZE);
    eof.writeUInt32LE(EMR_EOF, 0);
    eof.writeUInt32LE(EMF_EOF_SIZE, 4);
    eof.writeUInt32LE(EMF_EOF_SIZE, 16);
    return Buffer.concat([header, comment, eof]);
}

const PNG = makePng(8, 8);
const EMF_CDX = makeEmf(CDX_COMMENT);
const EMF_PLAIN = makeEmf(PLAIN_COMMENT);
// 截断文件：连 EMR_HEADER 都不完整，判据须按未命中处理而不是抛错
const EMF_TRUNCATED = Buffer.from([0x01, 0x00, 0x00, 0x00]);

// ---------- 期望值 ----------

const SIPO_CHEM_ALT = '<SIPOChemFile xmlns:xsd="http://www.w3.org/2001/XMLSchema"><chemObject>虚构 CML</chemObject></SIPOChemFile>';

/** 按 mammoth 截获顺序编号的资产、期望角色与期望 alt；note 说明该图对应哪条判据 */
const CHEMISTRY_EXPECTED = Object.freeze({
    images: Object.freeze([
        Object.freeze({ name: 'images/image_1.png', role: null, alt: '普通图', note: '普通图片，不命中' }),
        Object.freeze({ name: 'images/image_2.png', role: 'chemistry', alt: '', note: '判据 b：alt 清空' }),
        Object.freeze({ name: 'images/image_3.png', role: 'formula', alt: '公式甲', note: '角色标记，带分号余文' }),
        Object.freeze({ name: 'images/image_4.png', role: 'table', alt: '', note: '角色标记，无余文' }),
        Object.freeze({ name: 'images/image_5.png', role: null, alt: 'markflow:role=chemistryX', note: '角色标记不匹配，alt 原样' }),
        Object.freeze({ name: 'images/image_6.png', role: null, alt: '', note: 'ChemDraw 预览图；VML 序号标记到不了 mammoth' }),
        Object.freeze({ name: 'images/image_7.png', role: null, alt: '', note: 'Equation 预览图，不命中' }),
        Object.freeze({ name: 'images/image_8.png', role: 'chemistry', alt: '', note: '判据 c：复合域 KingDrawObject.Document' }),
        Object.freeze({ name: 'images/image_9.png', role: null, alt: '', note: '复合域 Equation.DSMT4，不命中' }),
        Object.freeze({ name: 'images/image_10.emf', role: 'chemistry', alt: '', note: '判据 d：EMF 内含 CDX 签名' }),
        Object.freeze({ name: 'images/image_11.emf', role: null, alt: '', note: 'EMF 无签名，不命中' }),
        Object.freeze({ name: 'images/image_12.emf', role: null, alt: '', note: '截断 EMF，不命中且不抛错' }),
    ]),
    // prepareLayout 给出的 OOXML 侧角色（判据 a 与 c）：图片序号 → 角色
    layoutRoles: Object.freeze([[6, 'chemistry'], [7, 'chemistry'], [12, 'chemistry']]),
});

// ---------- document.xml 片段 ----------

const escapeXml = (text) => String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const run = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (content) => `<w:p>${content}</w:p>`;
const emu = (px) => px * EMU_PER_PX;

function picGraphic(rid, widthPx, heightPx) {
    return '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
        + '<pic:nvPicPr><pic:cNvPr id="0" name="pic"/><pic:cNvPicPr/></pic:nvPicPr>'
        + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
        + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(widthPx)}" cy="${emu(heightPx)}"/></a:xfrm>`
        + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>';
}

function inlineImage({ id, rid, descr = '', widthPx = 40, heightPx = 20 }) {
    return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
        + `<wp:extent cx="${emu(widthPx)}" cy="${emu(heightPx)}"/>`
        + `<wp:docPr id="${id}" name="Picture ${id}" descr="${escapeXml(descr)}"/>`
        + `${picGraphic(rid, widthPx, heightPx)}</wp:inline></w:drawing></w:r>`;
}

// OLE 对象：v:imagedata 是预览图，o:OLEObject 带 ProgID
function oleObject({ shapeId, rid, progId }) {
    return `<w:r><w:object w:dxaOrig="1200" w:dyaOrig="600"><v:shape id="${shapeId}" type="#_x0000_t75" `
        + `style="width:60pt;height:30pt" o:ole=""><v:imagedata r:id="${rid}" o:title=""/></v:shape>`
        + `<o:OLEObject Type="Embed" ProgID="${progId}" ShapeID="${shapeId}" DrawAspect="Content" ObjectID="_1" r:id="${rid}"/>`
        + '</w:object></w:r>';
}

const fldChar = (type) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
// 域指令分两段写，验证 w:instrText 跨 run 后拼接判定
const instrText = (text) => `<w:r><w:instrText xml:space="preserve">${escapeXml(text)}</w:instrText></w:r>`;

function complexField({ progId, image }) {
    return `${fldChar('begin')}${instrText(' EMBED ')}${instrText(`${progId} \\* MERGEFORMAT `)}`
        + `${fldChar('separate')}${image}${fldChar('end')}`;
}

const simpleField = ({ progId, image }) => `<w:fldSimple w:instr=" EMBED ${escapeXml(progId)} \\* MERGEFORMAT ">${image}</w:fldSimple>`;

function documentXml() {
    const body = [
        paragraph(run('化学式判据样例')),
        paragraph(inlineImage({ id: 1, rid: 'rId10', descr: '普通图' })),
        paragraph(inlineImage({ id: 2, rid: 'rId10', descr: SIPO_CHEM_ALT })),
        paragraph(inlineImage({ id: 3, rid: 'rId10', descr: 'markflow:role=formula;公式甲' })),
        paragraph(inlineImage({ id: 4, rid: 'rId10', descr: 'markflow:role=table' })),
        paragraph(inlineImage({ id: 5, rid: 'rId10', descr: 'markflow:role=chemistryX' })),
        paragraph(oleObject({ shapeId: '_x0000_i1026', rid: 'rId10', progId: 'ChemDraw.Document.6.0' })),
        paragraph(oleObject({ shapeId: '_x0000_i1027', rid: 'rId10', progId: 'Equation.DSMT4' })),
        paragraph(complexField({ progId: 'KingDrawObject.Document', image: inlineImage({ id: 8, rid: 'rId10' }) })),
        paragraph(simpleField({ progId: 'FXChem.Equation', image: inlineImage({ id: 9, rid: 'rId10' }) })),
        paragraph(complexField({ progId: 'Equation.DSMT4', image: inlineImage({ id: 10, rid: 'rId10' }) })),
        paragraph(inlineImage({ id: 11, rid: 'rId20' })),
        paragraph(inlineImage({ id: 12, rid: 'rId21' })),
        paragraph(inlineImage({ id: 13, rid: 'rId22' })),
    ].join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${DOC_NS}><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/><Default Extension="emf" ContentType="image/x-emf"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';

const relationships = (items) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R_NS}/${type}" Target="${target}"/>`).join('')
    + '</Relationships>';

async function buildChemistrySample() {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
    zip.file('_rels/.rels', relationships([['rId1', 'officeDocument', 'word/document.xml']]));
    zip.file('word/_rels/document.xml.rels', relationships([
        ['rId10', 'image', 'media/image1.png'],
        ['rId20', 'image', 'media/image2.emf'],
        ['rId21', 'image', 'media/image3.emf'],
        ['rId22', 'image', 'media/image4.emf'],
    ]));
    zip.file('word/document.xml', documentXml());
    zip.file('word/media/image1.png', PNG);
    zip.file('word/media/image2.emf', EMF_CDX);
    zip.file('word/media/image3.emf', EMF_PLAIN);
    zip.file('word/media/image4.emf', EMF_TRUNCATED);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

if (require.main === module) {
    const target = path.resolve(process.argv[2] || path.join(__dirname, 'chemistry-sample.docx'));
    buildChemistrySample()
        .then((buffer) => {
            fs.writeFileSync(target, buffer);
            console.log(`已生成 ${target}（${buffer.length} 字节）`);
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = {
    buildChemistrySample, CHEMISTRY_EXPECTED, SIPO_CHEM_ALT,
    PNG, EMF_CDX, EMF_PLAIN, EMF_TRUNCATED,
};
