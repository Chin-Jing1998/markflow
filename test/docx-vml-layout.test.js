/**
 * VML 图片（v:imagedata）的序号标记与显示尺寸
 *
 * 覆盖 parsers/docx-layout 把 v:imagedata 改写成最小 DrawingML 的全过程：改写后的 document.xml
 * 形态、displays 与 roles 两张表的取值、mc:Choice 分支不占序号，以及经 parsers/docx 的 parse
 * 走到 IR 后逐图的 alt、角色与显示尺寸。夹具见 fixtures/build-vml-sample。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const { parse } = require('../converters/parsers/docx');
const { prepareLayout } = require('../converters/parsers/docx-layout');
const { buildVmlSample, VML_EXPECTED } = require('./fixtures/build-vml-sample');
const { PNG } = require('./fixtures/build-chemistry-sample');

const DOCUMENT_PART = 'word/document.xml';
// Strict 版 OOXML 的命名空间：mammoth 的命名空间表把它与 Transitional 映到同一批短名
const STRICT_W_NS = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const STRICT_R_NS = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const PACKAGE_R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const { ptToMm, ptToPx, pxToMm } = VML_EXPECTED;
// 毫米是浮点换算的结果，按精度比对而非全等
const MM_EPSILON = 1e-9;

const countOf = (xml, pattern) => (xml.match(pattern) || []).length;

async function documentXmlOf(buffer) {
    return (await JSZip.loadAsync(buffer)).file(DOCUMENT_PART).async('string');
}

/** 只装一份 document.xml 的最小 docx：供只看改写结果、不跑 mammoth 的用例使用 */
async function buildBareDocx(bodyXml) {
    const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
        + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
        + 'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"';
    const zip = new JSZip();
    zip.file(DOCUMENT_PART, `<?xml version="1.0"?><w:document ${ns}><w:body>${bodyXml}</w:body></w:document>`);
    return zip.generateAsync({ type: 'nodebuffer' });
}

/** Strict 版命名空间的最小 docx：正文只有一张 w:pict 的 VML 图，宽高由 style 给出 */
async function buildStrictDocx({ widthPt, heightPt, title }) {
    const ns = `xmlns:w="${STRICT_W_NS}" xmlns:r="${STRICT_R_NS}" `
        + 'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"';
    const body = `<w:p><w:r><w:pict><v:shape style="width:${widthPt}pt;height:${heightPt}pt">`
        + `<v:imagedata r:id="rId10" o:title="${title}"/></v:shape></w:pict></w:r></w:p>`;
    const rels = (items) => '<?xml version="1.0"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${PACKAGE_R_NS}/${type}" Target="${target}"/>`).join('')
        + '</Relationships>';
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Default Extension="png" ContentType="image/png"/>'
        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        + '</Types>');
    zip.file('_rels/.rels', rels([['rId1', 'officeDocument', 'word/document.xml']]));
    zip.file('word/_rels/document.xml.rels', rels([['rId10', 'image', 'media/image1.png']]));
    zip.file(DOCUMENT_PART, `<?xml version="1.0"?><w:document ${ns}><w:body>${body}<w:sectPr/></w:body></w:document>`);
    zip.file('word/media/image1.png', PNG);
    return zip.generateAsync({ type: 'nodebuffer' });
}

function imagesOf(node, found = []) {
    if (!node || typeof node !== 'object') return found;
    if (node.type === 'image') found.push(node);
    for (const child of node.children || []) imagesOf(child, found);
    return found;
}

function textOf(node, parts = []) {
    if (!node || typeof node !== 'object') return parts;
    if (node.type === 'text') parts.push(node.value);
    for (const child of node.children || []) textOf(child, parts);
    return parts;
}

test('prepareLayout：VML 图片改写为 DrawingML', async (t) => {
    const sample = await buildVmlSample();
    const layout = await prepareLayout(sample);
    const xml = await documentXmlOf(layout.buffer);

    await t.test('带 r:id 的 v:imagedata 全部换成 w:drawing，关系 id 沿用', () => {
        assert.equal(countOf(xml, /<v:imagedata\b/g), 0, '改写后不应再有 v:imagedata');
        // 6 张 VML 图各换出一个 w:drawing，另有 mc:Choice 内与文末各一个夹具自带的 w:drawing
        assert.equal(countOf(xml, /<w:drawing\b/g), VML_EXPECTED.images.length + 2);
        assert.equal(countOf(xml, /<a:blip r:embed="rId10"\/>/g), VML_EXPECTED.images.length + 2,
            '夹具全部图片同用 rId10，改写后每个 w:drawing 都应带一个指向它的 a:blip');
    });

    await t.test('形状、文本框与 OLE 声明原样保留，文本框内容不丢', () => {
        assert.equal(countOf(xml, /<v:shape\b/g), VML_EXPECTED.images.length);
        assert.equal(countOf(xml, /<v:textbox\b/g), 1);
        assert.ok(xml.includes(VML_EXPECTED.textboxText), '文本框里的文字仍在改写后的 XML 内');
        assert.equal(countOf(xml, /<o:OLEObject\b/g), 1);
    });

    await t.test('序号标记与原替换文字一起写进合成的 wp:docPr/@descr，实体不二次转义', () => {
        const descrs = [...xml.matchAll(/<wp:docPr\b[^>]*\bdescr="([^"]*)"/g)].map((matched) => matched[1]);
        // 6 个来自 VML 改写，另两个是夹具自带的 DrawingML（mc:Choice 内与文末）
        assert.equal(descrs.length, VML_EXPECTED.images.length + 2);
        assert.ok(descrs.some((value) => value.includes('形状替换文字 &amp; &quot;引号&quot;')),
            'v:shape 的 alt 应按源文档的转义形态原样带过去');
        assert.equal(countOf(xml, /标题替代文字/g), 1, 'o:title 的取值只应出现在改写后的 descr 里一次');
    });

    await t.test('displays 与 roles：mc:Choice 里的图不占序号，OLE 预览图记为化学式', () => {
        const { displays, roles } = layout;
        assert.equal(displays.size, VML_EXPECTED.images.length + 1,
            'mc:Choice 里的 DrawingML 不编号，序号数应等于会进 IR 的图片数');
        assert.equal(roles.size, 1);
        const [chemistryKey] = [...roles.keys()];
        assert.equal(roles.get(chemistryKey), 'chemistry');
        const chemistry = displays.get(chemistryKey);
        assert.deepEqual([chemistry.width, chemistry.height], [ptToPx(60), ptToPx(30)],
            '化学角色应落在 w:object 那张 60pt × 30pt 的预览图上');
        assert.ok([...displays.values()].every((size) => size.width !== 800),
            'mc:Choice 里 800px 宽的图不应出现在 displays 表内');
    });
});

test('prepareLayout：VML 图片改写的边界情形', async (t) => {
    await t.test('没有 r:id 的 v:imagedata 原样保留，不占序号', async () => {
        const body = '<w:p><w:r><w:pict><v:shape style="width:10pt;height:10pt">'
            + '<v:imagedata o:title="无关系 id"/></v:shape></w:pict></w:r></w:p>';
        const layout = await prepareLayout(await buildBareDocx(body));
        const xml = await documentXmlOf(layout.buffer);
        assert.equal(countOf(xml, /<v:imagedata\b/g), 1);
        assert.equal(countOf(xml, /<w:drawing\b/g), 0);
        assert.equal(layout.displays.size, 0);
    });

    await t.test('写成开闭标签对的 v:imagedata 整个元素被换掉', async () => {
        const body = '<w:p><w:r><w:pict><v:shape style="width:20pt;height:10pt">'
            + '<v:imagedata r:id="rId9"></v:imagedata></v:shape></w:pict></w:r></w:p>';
        const layout = await prepareLayout(await buildBareDocx(body));
        const xml = await documentXmlOf(layout.buffer);
        assert.equal(countOf(xml, /v:imagedata/g), 0, '开闭标签与其间的内容都应被替换掉');
        assert.equal(countOf(xml, /<a:blip r:embed="rId9"\/>/g), 1);
        assert.deepEqual([...layout.displays.values()], [{
            width: ptToPx(20), height: ptToPx(10), floating: false, widthMm: ptToMm(20), heightMm: ptToMm(10),
        }]);
    });

    await t.test('取不到显示尺寸时不写 wp:extent，序号标记照常写入', async () => {
        const body = '<w:p><w:r><w:pict><v:shape><v:imagedata r:id="rId9"/></v:shape></w:pict></w:r></w:p>';
        const layout = await prepareLayout(await buildBareDocx(body));
        const xml = await documentXmlOf(layout.buffer);
        assert.equal(countOf(xml, /<wp:extent\b/g), 0);
        assert.equal(countOf(xml, /<wp:docPr\b/g), 1);
        assert.deepEqual([...layout.displays.values()], [{ width: 0, floating: false }]);
    });
});

test('VML 图片端到端（合成夹具）', async (t) => {
    const doc = await parse({ buffer: await buildVmlSample() });
    const images = imagesOf(doc.ir);
    const text = textOf(doc.ir).join('\n');

    await t.test('mc:AlternateContent 只出一张图，图片总数与资产数一致', () => {
        const total = VML_EXPECTED.images.length + 1;
        assert.equal(images.length, total);
        assert.equal(doc.assets.length, total);
        assert.ok(images.every((node) => !node.alt.includes(VML_EXPECTED.choiceDescr)),
            'mc:Choice 里的替换文字不应出现在任何 alt 上');
    });

    await t.test('逐张 VML 图的 url、alt、角色与浮动标志与期望一致', () => {
        assert.deepEqual(
            images.slice(0, VML_EXPECTED.images.length).map((node) => ({
                name: node.url,
                alt: node.alt || '',
                role: (node.data && node.data.role) || null,
                floating: Boolean(node.data && node.data.floating),
            })),
            VML_EXPECTED.images.map(({ name, alt, role, floating }) => ({ name, alt, role, floating })),
        );
    });

    await t.test('逐张 VML 图的显示尺寸按 v:shape 的 style 换算，px 与 mm 各自成立', () => {
        VML_EXPECTED.images.forEach((expected, index) => {
            const [widthPt, heightPt] = expected.pt;
            const { data } = images[index];
            assert.deepEqual([data.display.width, data.display.height], [ptToPx(widthPt), ptToPx(heightPt)], expected.note);
            assert.equal(data.display.unit, 'px');
            assert.ok(Math.abs(data.displayWidthMm - ptToMm(widthPt)) < MM_EPSILON, `${expected.note}：宽度毫米`);
            assert.ok(Math.abs(data.displayHeightMm - ptToMm(heightPt)) < MM_EPSILON, `${expected.note}：高度毫米`);
        });
    });

    await t.test('同文档内的 DrawingML 图不受影响，尺寸不与 VML 图串位', () => {
        const drawing = images[images.length - 1];
        const [widthPx, heightPx] = VML_EXPECTED.drawing.px;
        assert.equal(drawing.url, VML_EXPECTED.drawing.name);
        assert.equal(drawing.alt, VML_EXPECTED.drawing.alt);
        assert.deepEqual([drawing.data.display.width, drawing.data.display.height], [widthPx, heightPx]);
        assert.ok(Math.abs(drawing.data.displayWidthMm - pxToMm(widthPx)) < MM_EPSILON);
        assert.ok(Math.abs(drawing.data.displayHeightMm - pxToMm(heightPx)) < MM_EPSILON);
    });

    await t.test('文本框里的文字仍在 IR 内', () => {
        assert.ok(text.includes(VML_EXPECTED.textboxText));
    });
});

test('Strict 版命名空间的文档同样取得标记与显示尺寸', async () => {
    const doc = await parse({ buffer: await buildStrictDocx({ widthPt: 42, heightPt: 21, title: '严格版替换文字' }) });
    const images = imagesOf(doc.ir);
    assert.equal(images.length, 1);
    assert.equal(images[0].alt, '严格版替换文字');
    assert.deepEqual([images[0].data.display.width, images[0].data.display.height], [ptToPx(42), ptToPx(21)]);
    assert.ok(Math.abs(images[0].data.displayWidthMm - ptToMm(42)) < MM_EPSILON);
});
