/**
 * 图元栅格化的端到端集成测试：内嵌合成 EMF 的 docx → 产物
 *
 * 覆盖：① bundle 目标跳过归一化，images/ 里仍是原始 .emf 且字节与 docx 内的媒体一致；
 *       ② xml 目标 + patent profile 走真实的 Electron 栅格后端：案卷内出现 <表格代码>_<序号>.jpg，
 *          img/@file 指向它，wi／he 等于显示毫米向下取整，JPG 为目标像素、JFIF 密度 300 且非空白，
 *          precheck.json 不出现与 .emf 有关的问题项。②在探测不到 Electron 时跳过（做法同现有栅格测试）。
 *
 * 夹具由本文件用 JSZip 按 OOXML 模板现造，EMF 由 test/helpers/emf-builder.js 合成；
 * 正文为虚构示例，不对应任何真实专利申请，也不使用任何客户材料。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const { load } = require('cheerio');

const { convert } = require('../converters');
const backend = require('../converters/raster/backend');
const { loadJimp } = require('../converters/assets/jimp-loader');
const {
    buildEmf, rgb, extCreatePen, selectObject, polyline16, polygon16, createBrushIndirect,
} = require('./helpers/emf-builder');

const TMP_ROOT = path.join(__dirname, 'tmp');
const EMU_PER_MM = 36000;
/** Word 显示尺寸：50.8 × 25.4 毫米，在 patent 默认的 300 PPI 下即 600 × 300 像素，wi／he 向下取整为 50／25 */
const DISPLAY_MM = { width: 50.8, height: 25.4 };
const TARGET_PX = { width: 600, height: 300 };
const EXPECTED_WI = 50;
const EXPECTED_HE = 25;
/** 图元自身的幅面 25.4 × 12.7 毫米（frame 单位为 0.01 毫米），与显示尺寸同为 2:1 */
const EMF_HEADER = { bounds: [0, 0, 99, 49], frame: [0, 0, 2540, 1270] };

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DOC_NS = [
    `xmlns:w="${W_NS}"`,
    `xmlns:r="${R_NS}"`,
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
].join(' ');

// ============================================================
// 夹具：内嵌一张合成 EMF 的最简专利来稿
// ============================================================

/** 粗折线 + 实心三角形，保证出图明显非空白 */
const SAMPLE_EMF = buildEmf([
    extCreatePen({ handle: 1, width: 4, color: rgb(0, 0, 0) }),
    selectObject(1),
    createBrushIndirect({ handle: 2, style: 0, color: rgb(0, 0, 0) }),
    selectObject(2),
    polyline16([[5, 5], [95, 5], [95, 45], [5, 45], [5, 5]]),
    polygon16([[20, 15], [50, 40], [80, 15]]),
], EMF_HEADER);

const emu = (mm) => Math.round(mm * EMU_PER_MM);

function picGraphic(rid) {
    return '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
        + '<pic:nvPicPr><pic:cNvPr id="0" name="pic"/><pic:cNvPicPr/></pic:nvPicPr>'
        + `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
        + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(DISPLAY_MM.width)}" cy="${emu(DISPLAY_MM.height)}"/></a:xfrm>`
        + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>';
}

const imageRun = (rid) => '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
    + `<wp:extent cx="${emu(DISPLAY_MM.width)}" cy="${emu(DISPLAY_MM.height)}"/>`
    + '<wp:docPr id="1" name="Picture 1" descr=""/>'
    + `${picGraphic(rid)}</wp:inline></w:drawing></w:r>`;

const textRun = (text, bold) => `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (content, center) => `<w:p>${center ? '<w:pPr><w:jc w:val="center"/></w:pPr>' : ''}${content}</w:p>`;
const bookTitle = (text) => paragraph(textRun(text, true), true);
const bodyText = (text) => paragraph(textRun(text, false), false);

function documentXml() {
    const body = [
        bodyText('一种合成图元测试装置'),
        bookTitle('权利要求书'),
        bodyText('1. 一种合成图元测试装置，其特征在于，包括壳体以及设于所述壳体内的标记件。'),
        bookTitle('说明书'),
        bodyText('本样稿用于验证内置图元渲染器的产物，正文内容为虚构示例。'),
        bookTitle('说明书附图'),
        paragraph(imageRun('rId10'), false),
        bodyText('图1'),
        bookTitle('说明书摘要'),
        bodyText('本样稿用于验证内置图元渲染器的产物。'),
    ].join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${DOC_NS}><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="emf" ContentType="image/x-emf"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';

const relationships = (items) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R_NS}/${type}" Target="${target}"/>`).join('')
    + '</Relationships>';

async function writeSampleDocx(dir) {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
    zip.file('_rels/.rels', relationships([['rId1', 'officeDocument', 'word/document.xml']]));
    zip.file('word/_rels/document.xml.rels', relationships([['rId10', 'image', 'media/image1.emf']]));
    zip.file('word/document.xml', documentXml());
    zip.file('word/media/image1.emf', SAMPLE_EMF);
    const file = path.join(dir, 'metafile-sample.docx');
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    return file;
}

function makeTempDir(prefix) {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, prefix));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** JPEG 的 JFIF APP0 密度 */
function readJfifDensity(buffer) {
    let at = 2;
    while (at + 4 <= buffer.length && buffer[at] === 0xFF) {
        const marker = buffer[at + 1];
        if (marker === 0xDA) return null;
        const length = buffer.readUInt16BE(at + 2);
        if (marker === 0xE0 && buffer.subarray(at + 4, at + 9).toString('latin1') === 'JFIF\x00') {
            return { units: buffer[at + 11], x: buffer.readUInt16BE(at + 12), y: buffer.readUInt16BE(at + 14) };
        }
        at += 2 + length;
    }
    return null;
}

// ============================================================
// bundle 目标：图元原样保留
// ============================================================

test('bundle 目标跳过归一化：images/ 里仍是原始 .emf，字节与 docx 内的媒体一致', async () => {
    // Arrange
    const dir = makeTempDir('metafile-bundle-');
    const docx = await writeSampleDocx(dir);
    const outputDir = makeTempDir('metafile-bundle-out-');
    const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

    // Act
    const result = await convert({
        input: { path: docx },
        target: 'bundle',
        outputDir,
        options: { xml: { profile: 'patent' } },
    });

    // Assert
    const files = fs.readdirSync(result.outputs.imagesDir).sort();
    assert.deepEqual(files, ['image_1.emf']);
    const written = fs.readFileSync(path.join(result.outputs.imagesDir, 'image_1.emf'));
    assert.equal(sha256(written), sha256(SAMPLE_EMF));
});

// ============================================================
// xml + patent：真后端端到端
// ============================================================

test('xml 目标 + patent profile：EMF 经真实栅格后端转为案卷内的 JPG', async (t) => {
    // Arrange
    const detected = await backend.detect();
    if (!detected.available) return t.skip(`未探测到栅格化后端：${detected.hint}`);
    const dir = makeTempDir('metafile-xml-');
    const docx = await writeSampleDocx(dir);
    const outputDir = makeTempDir('metafile-xml-out-');

    // Act
    const result = await convert({
        input: { path: docx },
        target: 'xml',
        outputDir,
        options: { xml: { profile: 'patent' } },
    });

    // Assert：案卷内出现 <表格代码>/<表格代码>_<序号>.jpg
    const bookDir = path.dirname(result.outputs.drawings);
    const bookCode = path.basename(bookDir);
    const jpegs = fs.readdirSync(bookDir).filter((name) => name.endsWith('.jpg')).sort();
    assert.deepEqual(jpegs, [`${bookCode}_1.jpg`], `${bookCode} 目录下应恰有一张图元转出的 JPG`);

    // Assert：img/@file 指向它，wi／he 为显示毫米向下取整
    const $ = load(fs.readFileSync(result.outputs.drawings, 'utf8'), { xmlMode: true });
    const img = $('img').first();
    assert.equal(img.attr('file'), `${bookCode}_1.jpg`);
    assert.equal(Number(img.attr('wi')), EXPECTED_WI);
    assert.equal(Number(img.attr('he')), EXPECTED_HE);

    // Assert：JPG 为目标像素、密度 300、非空白
    const jpeg = fs.readFileSync(path.join(bookDir, `${bookCode}_1.jpg`));
    assert.equal(jpeg.subarray(0, 2).toString('hex'), 'ffd8');
    assert.deepEqual(readJfifDensity(jpeg), { units: 1, x: 300, y: 300 });
    const { Jimp } = await loadJimp();
    const image = await Jimp.read(jpeg);
    assert.deepEqual({ width: image.width, height: image.height }, TARGET_PX);
    const dark = countDarkPixels(image.bitmap.data);
    assert.ok(dark > 1000, `出图不应为空白，实际深色像素 ${dark}`);

    // Assert：预检没有与 .emf 有关的问题项
    const report = JSON.parse(fs.readFileSync(result.outputs.precheck, 'utf8'));
    assert.equal(JSON.stringify(report).includes('.emf'), false, '归一化后不应再有 .emf 相关的预检问题');
});

/** 深色像素数：JPEG 有压缩噪声，故按阈值判定而非严格非白 */
const DARK_THRESHOLD = 128;
function countDarkPixels(data) {
    let count = 0;
    for (let at = 0; at + 4 <= data.length; at += 4) {
        if (data[at] < DARK_THRESHOLD && data[at + 1] < DARK_THRESHOLD && data[at + 2] < DARK_THRESHOLD) count += 1;
    }
    return count;
}
