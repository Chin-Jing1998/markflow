/**
 * docx 版面回归夹具（JSZip 按 OOXML 模板现造，不引入二进制文件）
 *
 * 用法：测试中 `await buildLayoutSample()` 取 Buffer；也可 `node test/fixtures/build-layout-sample.js <输出路径>` 落盘查看。
 *
 * 夹具内容（document.xml 顺序）：
 *   1. 标题段（heading 1，自带 firstLineChars=200）            → 标题段不加缩进
 *   2. 段落 w:ind firstLineChars=200                           → data.indent 2
 *   3. 段落 pStyle=BodyIndent（样式 firstLine=480、sz=24）       → 经样式链得 480 / 240 = 2
 *   4. 悬挂缩进段落（hanging=420）                              → 不加缩进
 *   5. 「制表符<w:tab/>之后」                                   → 文本含 \t
 *   6. 不含 a:blip 的 drawing（矩形形状）+ 文字                  → 不占图片序号，后续图片不错位
 *   7. 内嵌图 1：rId10（8×8 PNG），extent 200×100 px，descr「示意图甲」
 *   8. 题注样式段（样式名 caption）「图 1 示意图甲」             → data.role caption
 *   9. 两张浮动图 + 文字「【示例】」：rId11（12×6 PNG）extent 320×160、rId10 extent 100×50（只有 title「标题替代」）
 *  10. 「图 2<w:tab/>图 3」                                      → 紧随图片，按图号识别为 caption
 *  11. 下划线 run「下划线文字」                                   → underline 节点
 * 各图的 extent 均不等于像素尺寸，据此验证显示尺寸取自 extent 且按资产名对位。
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
    'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
].join(' ');
const REL_TYPE = `${R_NS}`;

// ---------- PNG ----------

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

const PNG_A = makePng(8, 8);
const PNG_B = makePng(12, 6);

/** 测试用的期望值：按 mammoth 截获顺序编号的资产与各自的显示尺寸 */
const LAYOUT_EXPECTED = Object.freeze({
    images: Object.freeze([
        Object.freeze({ name: 'images/image_1.png', width: 200, height: 100, floating: false, alt: '示意图甲', buffer: PNG_A }),
        Object.freeze({ name: 'images/image_2.png', width: 320, height: 160, floating: true, alt: '示意图乙', buffer: PNG_B }),
        Object.freeze({ name: 'images/image_3.png', width: 100, height: 50, floating: true, alt: '标题替代', buffer: PNG_A }),
    ]),
});

// ---------- document.xml 片段 ----------

const run = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const tab = () => '<w:r><w:tab/></w:r>';
const paragraph = (content, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`;
const pStyle = (id) => `<w:pStyle w:val="${id}"/>`;
const emu = (px) => px * EMU_PER_PX;

function picGraphic(rid, widthPx, heightPx) {
    return '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
        + '<pic:nvPicPr><pic:cNvPr id="0" name="pic"/><pic:cNvPicPr/></pic:nvPicPr>'
        + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
        + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(widthPx)}" cy="${emu(heightPx)}"/></a:xfrm>`
        + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>';
}

function docPr(id, { descr, title } = {}) {
    const attrs = [`id="${id}"`, `name="Picture ${id}"`];
    if (descr !== undefined) attrs.push(`descr="${descr}"`);
    if (title !== undefined) attrs.push(`title="${title}"`);
    return `<wp:docPr ${attrs.join(' ')}/>`;
}

function inlineImage({ id, rid, widthPx, heightPx, descr }) {
    return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
        + `<wp:extent cx="${emu(widthPx)}" cy="${emu(heightPx)}"/>${docPr(id, { descr })}`
        + `${picGraphic(rid, widthPx, heightPx)}</wp:inline></w:drawing></w:r>`;
}

const ANCHOR_OPEN = '<wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="1" '
    + 'behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>'
    + '<wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>'
    + '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>';

function anchorImage({ id, rid, widthPx, heightPx, descr, title }) {
    return `<w:r><w:drawing>${ANCHOR_OPEN}<wp:extent cx="${emu(widthPx)}" cy="${emu(heightPx)}"/><wp:wrapTopAndBottom/>`
        + `${docPr(id, { descr, title })}${picGraphic(rid, widthPx, heightPx)}</wp:anchor></w:drawing></w:r>`;
}

// 不含 a:blip 的 drawing：mammoth 不产出图片，旧的「按顺序配对 extent」会因它错位
function anchorShape({ id, widthPx, heightPx }) {
    return `<w:r><w:drawing>${ANCHOR_OPEN}<wp:extent cx="${emu(widthPx)}" cy="${emu(heightPx)}"/><wp:wrapNone/>`
        + `<wp:docPr id="${id}" name="Shape ${id}"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">`
        + '<wps:wsp><wps:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr><wps:bodyPr/></wps:wsp>'
        + '</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>';
}

function documentXml() {
    const body = [
        paragraph(run('版面样例'), `${pStyle('1')}<w:ind w:firstLineChars="200"/>`),
        paragraph(run('首行缩进两字（firstLineChars）。'), '<w:ind w:firstLineChars="200"/>'),
        paragraph(run('样式链继承的首行缩进（firstLine 480，sz 24）。'), pStyle('BodyIndent')),
        paragraph(run('悬挂缩进的段落不加缩进。'), '<w:ind w:left="420" w:hanging="420"/>'),
        paragraph(`${run('制表符')}${tab()}${run('之后')}`),
        paragraph(`${anchorShape({ id: 1, widthPx: 100, heightPx: 100 })}${run('形状段落')}`),
        paragraph(inlineImage({ id: 2, rid: 'rId10', widthPx: 200, heightPx: 100, descr: '示意图甲' })),
        paragraph(run('图 1 示意图甲'), pStyle('Caption')),
        paragraph(`${anchorImage({ id: 3, rid: 'rId11', widthPx: 320, heightPx: 160, descr: '示意图乙' })}`
            + `${anchorImage({ id: 4, rid: 'rId10', widthPx: 100, heightPx: 50, title: '标题替代' })}${run('【示例】')}`),
        paragraph(`${run('图 2')}${tab()}${run('图 3')}`),
        paragraph(`<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>下划线文字</w:t></w:r>${run('之后')}`),
    ].join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${DOC_NS}><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W_NS}">`
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="BodyIndent"><w:name w:val="Body Indent"/><w:basedOn w:val="a"/>'
    + '<w:pPr><w:ind w:firstLine="480"/></w:pPr><w:rPr><w:sz w:val="24"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="a"/></w:style>'
    + '</w:styles>';

const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '</Types>';

const relationships = (items) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL_TYPE}/${type}" Target="${target}"/>`).join('')
    + '</Relationships>';

async function buildLayoutSample() {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
    zip.file('_rels/.rels', relationships([['rId1', 'officeDocument', 'word/document.xml']]));
    zip.file('word/_rels/document.xml.rels', relationships([
        ['rId1', 'styles', 'styles.xml'],
        ['rId10', 'image', 'media/image1.png'],
        ['rId11', 'image', 'media/image2.png'],
    ]));
    zip.file('word/document.xml', documentXml());
    zip.file('word/styles.xml', STYLES_XML);
    zip.file('word/media/image1.png', PNG_A);
    zip.file('word/media/image2.png', PNG_B);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

if (require.main === module) {
    const target = path.resolve(process.argv[2] || path.join(__dirname, 'layout-sample.docx'));
    buildLayoutSample()
        .then((buffer) => {
            fs.writeFileSync(target, buffer);
            console.log(`已生成 ${target}（${buffer.length} 字节）`);
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { buildLayoutSample, LAYOUT_EXPECTED, PNG_A, PNG_B };
