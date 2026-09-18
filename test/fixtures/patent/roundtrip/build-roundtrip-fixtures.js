#!/usr/bin/env node
/**
 * 专利五书反向导入（XML → Word）的夹具生成器
 *
 *   node test/fixtures/patent/roundtrip/build-roundtrip-fixtures.js <输出目录>   落盘查看全部夹具
 *
 * 夹具一律在测试运行时程序化合成，不入库二进制；正文为虚构示例，不对应任何真实专利申请。
 *
 * makeJpeg({ width, height, dpi?, color? }) → Promise<Buffer>
 *   纯色 JPEG，JFIF 密度写为 dpi（缺省 300；传 null 则保留编码器的「无单位」密度，用于「图片不带密度」的用例）
 * buildOfficialBundle() → Promise<{ files: { '<posix 相对路径>': Buffer }, expected }>
 *   官方「WORD 转 XML 编辑器」真实产出的形态：10000N/10000N.xml + 同目录图片；UTF-8 BOM、CRLF、DOCTYPE 带 []、
 *   空元素写作 " />"、块间不规则空行、附图 XML 整体一行、figure 带 figure-labels 与四位补零的 num、img 的 id
 *   前缀分 if / iaf / idf、不生成 claim-ref 与 figref、段首段尾带 U+00A0。
 *   其中第 2 幅附图的高度取「像素换回的毫米刚好越过整数线」的情形（508 px @300 DPI = 43.01 mm，而 he="42"）。
 * buildFlatBundle() → Promise<{ files, expected }>
 *   本工具 v3.0.0 的平铺产物形态：claims.xml、description.xml…与图片同层；LF、无 BOM、带缩进；cn-drawing-p 承载图号、
 *   生成 claim-ref 与 figref、num 不补零、img 的 id 前缀一律为 i、wi/he 四舍五入、密度 330。
 * writeFiles(dir, files) / zipFiles(files, { prefix? }) → 落盘到目录 / 打成 zip（prefix 给出时外面多套一层文件夹）
 * buildPatentDocx() → Promise<Buffer>
 *   官方模板形态的五节 docx（书目名只在页眉里），供「docx → XML₁ → docx → XML₂」不动点测试使用；含粗体、斜体、
 *   下划线、上下标、段内换行、整段斜体、带 markflow:role 替换文字的段内图片，以及显示尺寸落在毫米整数线附近的附图。
 */
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const {
    Paragraph, TextRun, ImageRun, HeadingLevel,
} = require('docx');

const { loadJimp } = require('../../../../converters/assets/jimp-loader');
const { setJpegDensity } = require('../../../../converters/assets/image-normalize');
const { buildSectionedDocx } = require('../build-official-template-docx');

const JPEG_MIME = 'image/jpeg';
const PNG_MIME = 'image/png';
const DEFAULT_DPI = 300;
const EMU_PER_PX = 9525;
const EMU_PER_MM = 36000;
const BOM = String.fromCharCode(0xFEFF);
const NBSP = String.fromCharCode(0xA0);
const CRLF = '\r\n';
const HEAD = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE cn-application-body SYSTEM "/dtdandxsl/cn-application-body-20080416.dtd"[]>',
    '<?xml-stylesheet type="text/xsl" href="/dtdandxsl/showxml.xsl"?>',
];
const ROOT_OPEN = '<cn-application-body lang="zh" country="CN">';
const ROOT_CLOSE = '</cn-application-body>';

// ============================================================
// 图片
// ============================================================

async function makeImage(mime, { width, height, color = 0x3366CCFF }) {
    const { Jimp } = await loadJimp();
    return new Jimp({ width, height, color }).getBuffer(mime);
}

async function makeJpeg({ width, height, dpi = DEFAULT_DPI, color }) {
    const buffer = await makeImage(JPEG_MIME, { width, height, color });
    return dpi === null ? buffer : setJpegDensity(buffer, dpi);
}

const makePng = (options) => makeImage(PNG_MIME, options);

const img = (attrs) => `<img ${Object.entries(attrs).map(([key, value]) => `${key}="${value}"`).join(' ')} />`;
const officialImg = (id, file, wi, he, inline) => img({
    id, file, wi, he, top: 0, left: 0, 'img-content': 'drawing', 'img-format': 'jpg', orientation: 'portrait', inline,
});

// ============================================================
// 官方形态
// ============================================================

const OFFICIAL_EXPECTED = Object.freeze({
    inventionTitle: '一种可折叠的便携式晾衣架',
    headings: Object.freeze(['技术领域', '背景技术', '发明内容', '附图说明', '具体实施方式']),
    claims: Object.freeze([
        Object.freeze(['一种可折叠的便携式晾衣架，其特征在于，包括：', '立柱(1)；', '横杆(2)，铰接于所述立柱(1)的顶端。']),
        Object.freeze(['根据权利要求1所述的便携式晾衣架，其特征在于：所述横杆(2)上设有防滑纹。']),
        Object.freeze(['根据权利要求1或2所述的便携式晾衣架，其特征在于：所述立柱(1)为伸缩杆。']),
    ]),
    paragraphs: Object.freeze([
        '本申请涉及日用品技术领域，尤其是涉及一种可折叠的便携式晾衣架。',
        '现有晾衣架体积较大，外出携带不便。',
        '本申请的目的是提供一种可折叠的便携式晾衣架，收拢后长度不超过30cm。',
        '横杆的挠度按下式估算：，其中L为横杆长度。',
        '图1是本申请实施例的整体结构示意图；',
        '图2是本申请实施例收拢状态的示意图。',
        '参照图1，立柱1的顶端铰接有横杆2。',
    ]),
    abstract: '本申请公开了一种可折叠的便携式晾衣架，包括立柱与铰接于立柱顶端的横杆，收拢后便于携带。',
    figureLabels: Object.freeze(['图1', '图2']),
    figures: 2,
    formulas: 1,
});

// 像素与 wi/he：第 2 幅附图的高度 508 px @300 DPI = 43.01 mm，官方按原稿显示毫米（42.97）向下取整写 he="42"
const OFFICIAL_IMAGES = Object.freeze({
    '100002/100002_1.jpg': { width: 274, height: 106, wi: 23, he: 8 },
    '100003/100003_1.jpg': { width: 600, height: 300, wi: 50, he: 25 },
    '100003/100003_2.jpg': { width: 480, height: 508, wi: 40, he: 42 },
    '100005/100005_1.jpg': { width: 600, height: 296, wi: 50, he: 25 },
});

function officialXml(lines, { singleLineBody = false } = {}) {
    const body = singleLineBody ? [`${ROOT_OPEN}${lines.join('')}${ROOT_CLOSE}`] : [ROOT_OPEN, ...lines, '', ROOT_CLOSE];
    return Buffer.from(BOM + [...HEAD, ...body].join(CRLF), 'utf8');
}

function officialBooks() {
    const e = OFFICIAL_EXPECTED;
    const [p1, p2, p3, p4, p5, p6, p7] = e.paragraphs;
    const [before, after] = p4.split('，其中');
    const formula = `<maths id="math0001" num="0001">${officialImg('idf0001', '100002_1.jpg', 23, 8, 'no')}</maths>`;
    const claimsXml = e.claims.map((texts, index) => `<claim id="cl${String(index + 1).padStart(3, '0')}" num="${index + 1}">`
        + `${texts.map((text) => `<claim-text>${text}</claim-text>`).join(`${CRLF}${CRLF}`)}</claim>`);
    const paragraph = (num, inner) => `<p id="p${num}" num="${num}" Italic="0">${inner}</p>`;
    return {
        '100001/100001.xml': officialXml([`<cn-claims>${claimsXml.join(`${CRLF}${CRLF}`)}`, '', '', '</cn-claims>']),
        '100002/100002.xml': officialXml([
            `<description><invention-title>${e.inventionTitle}</invention-title>`, '',
            `<heading id="h0001" level="2">${e.headings[0]}</heading>`, '', paragraph('0001', `${NBSP}${p1}`), '',
            `<heading id="h0002" level="2">${e.headings[1]}</heading>`, '', paragraph('0002', `${p2}${NBSP}`), '',
            `<heading id="h0003" level="2">${e.headings[2]}</heading>`, '', paragraph('0003', p3), '',
            paragraph('0004', `${before}${formula}，其中${after}`), '',
            `<heading id="h0004" level="2">${e.headings[3]}</heading>`, '', paragraph('0005', p5), '', paragraph('0006', p6), '',
            `<heading id="h0005" level="2">${e.headings[4]}</heading>`, '', paragraph('0007', p7), '', '', '</description>',
        ]),
        '100003/100003.xml': officialXml([
            '<cn-drawings>',
            `<figure id="f0001" num="0001" figure-labels="图1">${officialImg('if0001', '100003_1.jpg', 50, 25, 'yes')}</figure>`,
            `<figure id="f0002" num="0002" figure-labels="图2">${officialImg('if0002', '100003_2.jpg', 40, 42, 'yes')}</figure>`,
            '</cn-drawings>',
        ], { singleLineBody: true }),
        '100004/100004.xml': officialXml([`<cn-abstract>${paragraph('0001', e.abstract)}`, '', '', '</cn-abstract>']),
        '100005/100005.xml': officialXml([
            `<cn-abstract><cn-abst-figure><figure id="f0001" num="0001">${officialImg('iaf0001', '100005_1.jpg', 50, 25, 'yes')}</figure></cn-abst-figure>`,
            '', '</cn-abstract>',
        ]),
    };
}

async function buildOfficialBundle() {
    const files = { ...officialBooks() };
    for (const [name, { width, height }] of Object.entries(OFFICIAL_IMAGES)) files[name] = await makeJpeg({ width, height });
    return { files, expected: OFFICIAL_EXPECTED, images: OFFICIAL_IMAGES };
}

// ============================================================
// v3.0.0 平铺形态
// ============================================================

const FLAT_HEAD = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE cn-application-body SYSTEM "/dtdandxsl/cn-application-body-20080416.dtd">',
    '<?xml-stylesheet type="text/xsl" href="/dtdandxsl/showxml.xsl"?>',
];
const flatXml = (lines) => Buffer.from([...FLAT_HEAD, ROOT_OPEN, ...lines, ROOT_CLOSE, ''].join('\n'), 'utf8');
const flatImg = (id, file, wi, he, inline) => `<img id="${id}" file="${file}" wi="${wi}" he="${he}" img-content="drawing" img-format="jpg" orientation="landscape" inline="${inline}"/>`;

const FLAT_EXPECTED = Object.freeze({
    inventionTitle: '一种带刻度的折叠量杯',
    claims: Object.freeze([
        Object.freeze(['一种带刻度的折叠量杯，其特征在于，包括杯体(1)与设于杯体(1)外壁的刻度线(2)。']),
        Object.freeze(['根据权利要求1所述的折叠量杯，其特征在于：所述杯体(1)由硅胶制成。']),
    ]),
    paragraphs: Object.freeze(['本申请涉及厨房用具技术领域。', '如图1所示，杯体1的外壁设有刻度线2。']),
    abstract: '本申请公开了一种带刻度的折叠量杯。',
    figureLabels: Object.freeze(['图1']),
});

async function buildFlatBundle() {
    const e = FLAT_EXPECTED;
    const files = {
        'claims.xml': flatXml([
            '  <cn-claims>',
            `    <claim id="cl001" num="1">\n      <claim-text>${e.claims[0][0]}</claim-text>\n    </claim>`,
            '    <claim id="cl002" num="2">',
            '      <claim-text>根据<claim-ref idref="cl001">权利要求1</claim-ref>所述的折叠量杯，其特征在于：所述杯体(1)由硅胶制成。</claim-text>',
            '    </claim>',
            '  </cn-claims>',
        ]),
        'description.xml': flatXml([
            '  <description>',
            `    <invention-title>${e.inventionTitle}</invention-title>`,
            '    <heading id="h0001" level="2">技术领域</heading>',
            `    <p id="p0001" num="0001" Italic="0">${e.paragraphs[0]}</p>`,
            '    <heading id="h0002" level="2">具体实施方式</heading>',
            '    <p id="p0002" num="0002" Italic="0">如<figref num="1">图1</figref>所示，杯体1的外壁设有刻度线2。</p>',
            '  </description>',
        ]),
        'drawings.xml': flatXml([
            '  <cn-drawings>',
            '    <cn-drawing-p>\n      <p id="l0001" num="XXXX" Italic="0">图1</p>\n    </cn-drawing-p>',
            `    <figure id="f0001" num="1">\n      ${flatImg('i0001', 'drawing-1.jpg', 46, 28, 'no')}\n    </figure>`,
            '  </cn-drawings>',
        ]),
        'abstract.xml': flatXml(['  <cn-abstract>', `    <p id="p0001" num="0001" Italic="0">${e.abstract}</p>`, '  </cn-abstract>']),
        'abstract-figure.xml': flatXml([
            '  <cn-abstract>', '    <cn-abst-figure>',
            `      <figure id="f0001" num="1">\n        ${flatImg('i0001', 'drawing-1.jpg', 46, 28, 'no')}\n      </figure>`,
            '    </cn-abst-figure>', '  </cn-abstract>',
        ]),
        // 600×360 px @330 DPI = 46.18×27.71 mm；v3.0.0 按四舍五入写 wi="46" he="28"
        'drawing-1.jpg': await makeJpeg({ width: 600, height: 360, dpi: 330 }),
        'precheck.json': Buffer.from('{"profile":"patent"}', 'utf8'),
    };
    return { files, expected: FLAT_EXPECTED };
}

// ============================================================
// 落盘与打包
// ============================================================

function writeFiles(dir, files) {
    for (const [name, buffer] of Object.entries(files)) {
        const target = path.join(dir, ...name.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buffer);
    }
    return dir;
}

// 与官方 zip 同形：只有文件条目、正斜杠、DEFLATE；prefix 给出时外面多套一层文件夹
async function zipFiles(files, { prefix = '' } = {}) {
    const zip = new JSZip();
    for (const [name, buffer] of Object.entries(files)) zip.file(`${prefix}${name}`, buffer, { createFolders: false });
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ============================================================
// 不动点测试用的源 docx
// ============================================================

const DOCX_EXPECTED = Object.freeze({
    headers: Object.freeze(['说明书摘要', '摘要附图', '权利要求书', '说明书', '说明书附图']),
    inventionTitle: '一种便于清洗的保温杯盖',
    roleAlt: 'markflow:role=formula;挠度估算式',
});

const run = (text, props = {}) => new TextRun({ text, ...props });
const para = (...runs) => new Paragraph({ children: runs.map((item) => (typeof item === 'string' ? run(item) : item)) });
const heading = (text, level) => new Paragraph({ heading: level, children: [run(text)] });
// 显示尺寸以毫米给出：docx 包按「像素 × 9525」取整得 EMU，故折成可带小数的像素
const picture = (data, type, widthMm, heightMm, alt) => new ImageRun({
    type, data,
    transformation: { width: (widthMm * EMU_PER_MM) / EMU_PER_PX, height: (heightMm * EMU_PER_MM) / EMU_PER_PX },
    ...(alt ? { altText: { name: alt, description: alt, title: alt } } : {}),
});

async function buildPatentDocx() {
    const drawing = await makePng({ width: 96, height: 48 });
    const tall = await makePng({ width: 60, height: 64, color: 0x228833FF });
    const formula = await makeJpeg({ width: 120, height: 40, color: 0xCCCCCCFF });
    const title = DOCX_EXPECTED.inventionTitle;
    const [hAbstract, hAbstractFigure, hClaims, hDescription, hDrawings] = DOCX_EXPECTED.headers;
    return buildSectionedDocx([
        { header: hAbstract, children: [para('本申请公开了一种便于清洗的保温杯盖，包括盖体与可拆卸的密封圈，拆下密封圈后可彻底清洗。')] },
        { header: hAbstractFigure, children: [new Paragraph({ children: [picture(drawing, 'png', 50, 25)] })] },
        {
            header: hClaims,
            children: [
                para('1. 一种便于清洗的保温杯盖，其特征在于，包括：'), para('盖体(1)；'), para('密封圈(2)，可拆卸地嵌设于所述盖体(1)的环槽内。'),
                para('2. 根据权利要求1所述的保温杯盖，其特征在于：所述密封圈(2)上设有拉环(21)。'),
                para('3. 根据权利要求1或2所述的保温杯盖，其特征在于：所述盖体(1)的材质为PP，耐温不低于100', run('o', { superScript: true }), 'C。'),
            ],
        },
        {
            header: hDescription,
            children: [
                heading(title, HeadingLevel.HEADING_1),
                heading('技术领域', HeadingLevel.HEADING_2),
                para('本申请涉及日用品技术领域，尤其是涉及一种便于清洗的保温杯盖。'),
                heading('背景技术', HeadingLevel.HEADING_2),
                para('现有保温杯盖的密封圈与盖体', run('一体成型', { bold: true }), '，缝隙处易藏污垢，', run('难以清洗', { underline: {} }), '。'),
                heading('发明内容', HeadingLevel.HEADING_2),
                para('本申请的目的是提供一种便于清洗的保温杯盖。', run('', { break: 1 }), '技术方案如下所述。'),
                para('密封圈的压缩量记为Δ', run('r', { subScript: true }), '，按下式估算：', picture(formula, 'jpg', 10.16, 3.3867, DOCX_EXPECTED.roleAlt), '，其中各量的含义见下文。'),
                new Paragraph({ children: [run('实施例仅用于说明本申请，并不限制其范围。', { italics: true })] }),
                heading('附图说明', HeadingLevel.HEADING_2),
                para('图1是本申请实施例的整体结构示意图；'),
                para('图2是本申请实施例中密封圈的局部放大图。'),
                heading('具体实施方式', HeadingLevel.HEADING_2),
                para('参照图1，盖体1的环槽内嵌设有密封圈2，密封圈2上设有拉环21。'),
            ],
        },
        {
            header: hDrawings,
            children: [
                new Paragraph({ children: [picture(drawing, 'png', 50.8, 25.4)] }), para('图1'),
                // 高 42.97 mm：300 DPI 下四舍五入为 508 px，换回毫米是 43.01——回转时 he 仍须为 42
                new Paragraph({ children: [picture(tall, 'png', 40.3, 42.97)] }), para('图2 局部放大图'),
            ],
        },
    ], { wordShape: false });
}

if (require.main === module) {
    const target = process.argv[2];
    if (!target) {
        process.stderr.write('用法：node test/fixtures/patent/roundtrip/build-roundtrip-fixtures.js <输出目录>\n');
        process.exitCode = 1;
    } else {
        (async () => {
            writeFiles(path.join(target, 'official'), (await buildOfficialBundle()).files);
            writeFiles(path.join(target, 'flat'), (await buildFlatBundle()).files);
            writeFiles(target, { 'official.zip': await zipFiles((await buildOfficialBundle()).files), 'source.docx': await buildPatentDocx() });
            process.stdout.write(`${target}\n`);
        })().catch((err) => {
            process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
            process.exitCode = 1;
        });
    }
}

module.exports = {
    makeJpeg, makePng, buildOfficialBundle, buildFlatBundle, buildPatentDocx, writeFiles, zipFiles,
    OFFICIAL_EXPECTED, OFFICIAL_IMAGES, FLAT_EXPECTED, DOCX_EXPECTED, NBSP,
};
