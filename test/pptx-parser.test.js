/**
 * converters/parsers/pptx.js 单元测试
 * 覆盖：{ path } 契约、标题/正文抽取、内嵌图片抽取为 assets（含跨页去重、外链与失效引用告警）、
 *       备注、meta.title 优先级、kind
 *
 * 测试用 pptx 由 jszip 现场构造，不引入二进制测试资源。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const JSZip = require('jszip');

const { parse } = require('../converters/parsers/pptx');
const { downgradeCustomNodes } = require('../converters/ir/schema');

// ============================================================
// 测试夹具：手工生成合法 PNG
// ============================================================

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
    for (let i = 0; i < buf.length; i += 1) {
        crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(width, height) {
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // color type: truecolor
    const raw = Buffer.alloc((width * 3 + 1) * height, 0);
    return Buffer.concat([
        signature,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

const PNG_8X8 = makePng(8, 8);

// ============================================================
// 测试夹具：手工构造最小 PPTX
// ============================================================

const NS =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const IMAGE_REL_TYPE = `${REL_NS.replace('/package/', '/officeDocument/')}/image`;
const NOTES_REL_TYPE = `${REL_NS.replace('/package/', '/officeDocument/')}/notesSlide`;

function shapeXml(text, phType) {
    const ph = phType ? `<p:ph type="${phType}"/>` : '';
    const paragraphs = String(text)
        .split('\n')
        .map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`)
        .join('');
    return (
        `<p:sp><p:nvSpPr><p:cNvPr id="2" name="shape"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
        `<p:spPr/><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`
    );
}

function picXml(rid) {
    return (
        '<p:pic><p:nvPicPr><p:cNvPr id="3" name="pic"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
        `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
        '<p:spPr/></p:pic>'
    );
}

function slideXml({ title, subTitle, bodies = [], picRids = [] }) {
    const shapes = [];
    if (title) shapes.push(shapeXml(title, 'title'));
    if (subTitle) shapes.push(shapeXml(subTitle, 'subTitle'));
    for (const body of bodies) shapes.push(shapeXml(body, null));
    for (const rid of picRids) shapes.push(picXml(rid));
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<p:sld ${NS}><p:cSld><p:spTree>` +
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
        `${shapes.join('')}</p:spTree></p:cSld></p:sld>`
    );
}

function relsXml(rels) {
    const items = rels
        .map(
            (r) =>
                `<Relationship Id="${r.id}" Type="${r.type || IMAGE_REL_TYPE}" Target="${r.target}"` +
                `${r.external ? ' TargetMode="External"' : ''}/>`,
        )
        .join('');
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<Relationships xmlns="${REL_NS}">${items}</Relationships>`
    );
}

function notesXml(text) {
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<p:notes ${NS}><p:cSld><p:spTree>${shapeXml(text, null)}</p:spTree></p:cSld></p:notes>`
    );
}

function contentTypesXml() {
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
        '<Default Extension="jpg" ContentType="image/jpeg"/>' +
        '</Types>'
    );
}

/**
 * @param {object} spec
 * @param {Array} spec.slides 每页 { title?, subTitle?, bodies?, picRids?, rels?, notes?, notesFile? }
 *   notes 给定时写入 ppt/notesSlides/<notesFile 或 notesSlideN.xml> 并在本页 rels 中登记 notesSlide 关系
 * @param {string} [spec.coreTitle] docProps/core.xml 的 dc:title
 * @param {object} [spec.media] zip 内媒体路径 → Buffer，默认放一张 ppt/media/image1.png
 */
async function makePptxFile({ slides, coreTitle, fileName = '产品发布.pptx', media } = {}) {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', contentTypesXml());
    zip.file(
        '_rels/.rels',
        relsXml([
            {
                id: 'rId1',
                type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
                target: 'ppt/presentation.xml',
            },
        ]),
    );
    zip.file(
        'ppt/presentation.xml',
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS}><p:sldIdLst/></p:presentation>`,
    );

    const mediaFiles = media || { 'ppt/media/image1.png': PNG_8X8 };
    for (const [zipPath, buf] of Object.entries(mediaFiles)) zip.file(zipPath, buf);

    if (coreTitle !== undefined) {
        zip.file(
            'docProps/core.xml',
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
                'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
                `<dc:title>${coreTitle}</dc:title></cp:coreProperties>`,
        );
    }

    slides.forEach((slide, i) => {
        const n = i + 1;
        const rels = [...(slide.rels || [])];
        if (slide.notes) {
            // 备注文件名允许与页码不一致，关联关系一律写进本页 rels
            const notesFile = slide.notesFile || `notesSlide${n}.xml`;
            zip.file(`ppt/notesSlides/${notesFile}`, notesXml(slide.notes));
            rels.push({ id: 'rIdNotes', type: NOTES_REL_TYPE, target: `../notesSlides/${notesFile}` });
        }
        zip.file(`ppt/slides/slide${n}.xml`, slideXml(slide));
        zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, relsXml(rels));
    });

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-pptx-parser-')));
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, buffer);
    return { dir, filePath };
}

/** 单页最小 PPTX：标题 + 两段正文 + 一张内嵌 PNG */
function minimalSpec() {
    return {
        slides: [
            {
                title: '第一页标题',
                bodies: ['正文第一段\n正文第二段'],
                picRids: ['rId2'],
                rels: [{ id: 'rId2', target: '../media/image1.png' }],
            },
        ],
    };
}

// ============================================================
// IR 遍历辅助
// ============================================================

function collect(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) {
        for (const child of node.children) collect(child, predicate, out);
    }
    return out;
}

function plainText(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text' || node.type === 'inlineCode') return String(node.value || '');
    if (!Array.isArray(node.children)) return '';
    return node.children.map(plainText).join('');
}

// ============================================================
// 用例
// ============================================================

test('最小 PPTX：标题、正文与内嵌图片全部进入 IR', async () => {
    // Arrange
    const { filePath } = await makePptxFile(minimalSpec());

    // Act
    const doc = await parse({ path: filePath });

    // Assert
    assert.equal(doc.kind, 'presentation');

    const slideBreaks = collect(doc.ir, (n) => n.type === 'slideBreak');
    assert.equal(slideBreaks.length, 1);
    assert.equal(slideBreaks[0].data.title, '第一页标题');

    // 自定义节点降级后标题呈现为 H2，便于 MD/HTML 渲染
    const headings = collect(downgradeCustomNodes(doc.ir), (n) => n.type === 'heading');
    assert.equal(headings.length, 1);
    assert.equal(headings[0].depth, 2);
    assert.equal(plainText(headings[0]), '第一页标题');

    const paragraphTexts = collect(doc.ir, (n) => n.type === 'paragraph').map(plainText);
    assert.ok(paragraphTexts.includes('正文第一段'));
    assert.ok(paragraphTexts.includes('正文第二段'));

    const images = collect(doc.ir, (n) => n.type === 'image');
    assert.equal(images.length, 1);
    assert.equal(images[0].url, 'images/image_1.png');
    assert.equal(images[0].alt, '');
});

test('内嵌图片以 assets 返回，内容与原图字节一致', async () => {
    // Arrange
    const { filePath } = await makePptxFile(minimalSpec());

    // Act
    const doc = await parse({ path: filePath });

    // Assert
    assert.equal(doc.assets.length, 1);
    assert.equal(doc.assets[0].name, 'images/image_1.png');
    assert.equal(doc.assets[0].mime, 'image/png');
    assert.ok(Buffer.isBuffer(doc.assets[0].buffer));
    assert.ok(
        doc.assets[0].buffer.equals(PNG_8X8),
        'asset.buffer 应与写入 zip 的 PNG 字节完全一致',
    );
    assert.deepEqual(doc.warnings, []);
});

test('图片段落排在该页标题与正文之后', async () => {
    // Arrange
    const { filePath } = await makePptxFile(minimalSpec());

    // Act
    const doc = await parse({ path: filePath });
    const shape = doc.ir.children.map((n) =>
        n.type === 'paragraph' && n.children[0] && n.children[0].type === 'image'
            ? 'image'
            : n.type,
    );

    // Assert
    assert.deepEqual(shape, ['slideBreak', 'paragraph', 'paragraph', 'image']);
});

test('同一媒体被多页引用时只生成一份 asset，两页共用同一 url', async () => {
    // Arrange
    const rels = [{ id: 'rId2', target: '../media/image1.png' }];
    const { filePath } = await makePptxFile({
        slides: [
            { title: '首页', bodies: ['甲'], picRids: ['rId2'], rels },
            { title: '次页', bodies: ['乙'], picRids: ['rId2'], rels },
        ],
    });

    // Act
    const doc = await parse({ path: filePath });

    // Assert
    assert.equal(doc.assets.length, 1);
    const urls = collect(doc.ir, (n) => n.type === 'image').map((n) => n.url);
    assert.deepEqual(urls, ['images/image_1.png', 'images/image_1.png']);
    assert.deepEqual(
        doc.data.slides.map((s) => s.images),
        [['images/image_1.png'], ['images/image_1.png']],
    );
});

test('多张不同图片按出现顺序编号，MIME 依扩展名判定', async () => {
    // Arrange
    const jpg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
    const { filePath } = await makePptxFile({
        slides: [
            {
                title: '图集',
                picRids: ['rId2', 'rId3'],
                rels: [
                    { id: 'rId2', target: '../media/image1.png' },
                    { id: 'rId3', target: '../media/photo.jpg' },
                ],
            },
        ],
        media: { 'ppt/media/image1.png': PNG_8X8, 'ppt/media/photo.jpg': jpg },
    });

    // Act
    const doc = await parse({ path: filePath });

    // Assert
    assert.deepEqual(
        doc.assets.map((a) => [a.name, a.mime]),
        [
            ['images/image_1.png', 'image/png'],
            ['images/image_2.jpg', 'image/jpeg'],
        ],
    );
    assert.ok(doc.assets[1].buffer.equals(jpg));
});

test('外部链接图片记 warning 且不进入 assets', async () => {
    // Arrange
    const { filePath } = await makePptxFile({
        slides: [
            {
                title: '外链页',
                picRids: ['rId2'],
                rels: [{ id: 'rId2', target: 'https://example.com/a.png', external: true }],
            },
        ],
    });

    // Act
    const doc = await parse({ path: filePath });

    // Assert
    assert.equal(doc.assets.length, 0);
    assert.equal(collect(doc.ir, (n) => n.type === 'image').length, 0);
    assert.ok(
        doc.warnings.some((w) => w.includes('外部链接')),
        `warnings 应提示外链未内嵌，实际为 ${JSON.stringify(doc.warnings)}`,
    );
});

test('关系表缺失或媒体丢失时记 warning，解析继续', async () => {
    // Arrange：rId2 未在 rels 中声明；rId3 指向包内不存在的文件
    const { filePath } = await makePptxFile({
        slides: [
            {
                title: '残缺页',
                bodies: ['正文仍应保留'],
                picRids: ['rId2', 'rId3'],
                rels: [{ id: 'rId3', target: '../media/missing.png' }],
            },
        ],
    });

    // Act
    const doc = await parse({ path: filePath });

    // Assert
    assert.equal(doc.assets.length, 0);
    assert.equal(doc.warnings.length, 2);
    assert.ok(doc.warnings.some((w) => w.includes('关系表中缺失')));
    assert.ok(doc.warnings.some((w) => w.includes('包内不存在')));
    assert.ok(collect(doc.ir, (n) => n.type === 'paragraph').map(plainText).includes('正文仍应保留'));
});

test('备注写入 slideBreak.data.notes 并输出为引用块', async () => {
    // Arrange
    const { filePath } = await makePptxFile({
        slides: [{ title: '带备注', bodies: ['正文'], notes: '这是演讲备注' }],
    });

    // Act
    const doc = await parse({ path: filePath });

    // Assert
    const [slideBreak] = collect(doc.ir, (n) => n.type === 'slideBreak');
    assert.equal(slideBreak.data.notes, '这是演讲备注');
    const [quote] = collect(doc.ir, (n) => n.type === 'blockquote');
    assert.equal(plainText(quote), '备注：这是演讲备注');
});

test('无 title 占位符时首段升格为标题', async () => {
    // Arrange
    const { filePath } = await makePptxFile({
        slides: [{ bodies: ['升格为标题', '留作正文'] }],
    });

    // Act
    const doc = await parse({ path: filePath });

    // Assert
    const [slideBreak] = collect(doc.ir, (n) => n.type === 'slideBreak');
    assert.equal(slideBreak.data.title, '升格为标题');
    assert.deepEqual(
        collect(doc.ir, (n) => n.type === 'paragraph').map(plainText),
        ['留作正文'],
    );
});

test('meta.title 优先取 docProps 的 dc:title，其次首页标题', async () => {
    // Arrange
    const withCore = await makePptxFile({ ...minimalSpec(), coreTitle: '正式标题' });
    const withoutCore = await makePptxFile(minimalSpec());

    // Act
    const docA = await parse({ path: withCore.filePath });
    const docB = await parse({ path: withoutCore.filePath });

    // Assert
    assert.equal(docA.meta.title, '正式标题');
    assert.equal(docB.meta.title, '第一页标题');
    assert.equal(docB.meta.sourceType, 'pptx');
    assert.equal(docB.meta.sourceName, '产品发布.pptx');
    assert.equal(docB.meta.slideCount, 1);
});

test('无任何标题时 title 回退为去扩展名的文件名', async () => {
    // Arrange
    const { filePath } = await makePptxFile({
        slides: [{ picRids: [] }],
        fileName: '空白演示.pptx',
    });

    // Act
    const doc = await parse({ path: filePath });

    // Assert
    assert.equal(doc.meta.title, '空白演示');
});

test('ctx.sourceName 覆盖文件名', async () => {
    // Arrange
    const { filePath } = await makePptxFile({ slides: [{ bodies: [] }], fileName: 'tmp-9527.pptx' });

    // Act
    const doc = await parse({ path: filePath }, { sourceName: '年度汇报.pptx' });

    // Assert
    assert.equal(doc.meta.sourceName, '年度汇报.pptx');
    assert.equal(doc.meta.title, '年度汇报');
});

test('缺少 input.path 时抛出中文错误', async () => {
    // Arrange & Act & Assert
    await assert.rejects(() => parse({}), /parsers\/pptx 需要 input\.path/);
});

test('包内没有 slide 时抛出中文错误', async () => {
    // Arrange
    const zip = new JSZip();
    zip.file('[Content_Types].xml', contentTypesXml());
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-pptx-parser-')));
    const filePath = path.join(dir, 'empty.pptx');
    fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));

    // Act & Assert
    await assert.rejects(() => parse({ path: filePath }), /未找到 slide 文件/);
});

test('备注按本页 rels 关联，备注文件名与页码不一致时不错位', async () => {
    // Arrange：只有第 2 页有备注，但备注文件名是 notesSlide1.xml
    const { filePath } = await makePptxFile({
        slides: [
            { title: '第一页' },
            { title: '第二页', notes: '只属于第二页的备注', notesFile: 'notesSlide1.xml' },
        ],
    });

    // Act
    const doc = await parse({ path: filePath });
    const slideBreaks = collect(doc.ir, (n) => n.type === 'slideBreak');

    // Assert
    assert.equal(slideBreaks[0].data.notes, '');
    assert.equal(slideBreaks[1].data.notes, '只属于第二页的备注');
    assert.deepEqual(doc.data.slides.map((s) => s.notes), ['', '只属于第二页的备注']);
    const quotes = collect(doc.ir, (n) => n.type === 'blockquote');
    assert.equal(quotes.length, 1);
    assert.equal(plainText(quotes[0]), '备注：只属于第二页的备注');
});

test('subTitle 占位符归入正文，不顶替 title', async () => {
    // Arrange
    const { filePath } = await makePptxFile({
        slides: [{ title: '正标题', subTitle: '副标题', bodies: ['正文'] }],
    });

    // Act
    const doc = await parse({ path: filePath });
    const [slideBreak] = collect(doc.ir, (n) => n.type === 'slideBreak');

    // Assert
    assert.equal(slideBreak.data.title, '正标题');
    assert.deepEqual(
        collect(doc.ir, (n) => n.type === 'paragraph').map(plainText),
        ['副标题', '正文'],
    );
});

test('dc:title 中的 XML 实体被还原', async () => {
    // Arrange
    const { filePath } = await makePptxFile({ ...minimalSpec(), coreTitle: '研发 &amp; 市场' });

    // Act
    const doc = await parse({ path: filePath });

    // Assert
    assert.equal(doc.meta.title, '研发 & 市场');
});

test('onProgress 只报 parsing 阶段，百分比单调且落在 20–55', async () => {
    // Arrange
    const { filePath } = await makePptxFile({
        slides: [{ title: '一' }, { title: '二' }, { title: '三' }],
    });
    const calls = [];

    // Act
    await parse({ path: filePath }, { onProgress: (phase, pct) => calls.push([phase, pct]) });

    // Assert
    assert.equal(calls.length, 3);
    assert.ok(calls.every(([phase]) => phase === 'parsing'), JSON.stringify(calls));
    const pcts = calls.map(([, pct]) => pct);
    assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b), '百分比应单调不降');
    assert.ok(pcts.every((pct) => pct >= 20 && pct <= 55), JSON.stringify(pcts));
});
