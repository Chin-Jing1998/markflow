/**
 * patent profile 分节模块（converters/renderers/xml/sections.js）单元测试：Word 分节页眉与官方标记码位
 * 覆盖：data.section 的页眉映射五书（整体与逐行比对、字间空白）且不报「按位置推定」「无法归类」；页眉认不出书目时
 *       回落到标题段与位置推定、产物与无分节信息时一致；页眉区域之后的无书目分节另起区域；同一分节内的书目
 *       标题段照旧生效；不带分节信息的块沿用前一块的分节；五种官方码位（U+E205 / E206 / E208 / E209 / E20A）
 *       各自的识别与剥离、产物无私用区残留；权项起始码位参与位置推定；字面汉字规则仅在全文无结构码位时启用；
 *       官方五书模板形态的合成 docx 端到端（解析 → 分节 → 五书 → DTD 校验）。
 * 样稿正文一律为虚构示例。
 */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('cheerio');

const xmlRenderer = require('../converters/renderers/xml');
const { validateXml } = require('../converters/renderers/xml/validate');
const { ISSUE_CODES } = require('../converters/renderers/xml/precheck');
const { normalizeOptions } = require('../converters/options');
const { convert } = require('../converters');
const { createDocument, createRoot, createHeading, createParagraph, createText } = require('../converters/ir/schema');
const { buildOfficialTemplateDocx, OFFICIAL_EXPECTED } = require('./fixtures/patent/build-official-template-docx');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(TMP_ROOT, 'xml-sections-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// 不可见字符一律以码点生成：官方标记码位与两段私用区（官方 U+E200–U+E20F、版面标记 U+EF00–U+EF1F）
const fromCode = (code) => String.fromCharCode(code);
const MARK = Object.freeze({
    PARAGRAPH: fromCode(0xE205), CLAIM: fromCode(0xE206), NUMBER: fromCode(0xE208), TITLE: fromCode(0xE209), HEADING: fromCode(0xE20A),
});
const PUA_RESIDUE_RE = new RegExp(`[${fromCode(0xE200)}-${fromCode(0xE20F)}${fromCode(0xEF00)}-${fromCode(0xEF1F)}]`);
const IDEOGRAPHIC_SPACE = fromCode(0x3000);
const XML_FILES = ['claims.xml', 'description.xml', 'drawings.xml', 'abstract.xml', 'abstract-figure.xml'];
const SECTION_FALLBACK_CODES = [ISSUE_CODES.SECTION_INFERRED, ISSUE_CODES.SECTION_UNCLASSIFIED, ISSUE_CODES.SECTION_MISSING];

// ============================================================
// 辅助
// ============================================================

// 只含标记段的最小 JPEG：SOI + APP0(JFIF 密度) + SOF0(尺寸) + EOI，供尺寸读取
function makeJpeg({ width, height, dpi }) {
    const app0 = Buffer.alloc(18);
    app0.writeUInt16BE(0xffe0, 0);
    app0.writeUInt16BE(16, 2);
    app0.write('JFIF\0', 4, 'latin1');
    app0[9] = 1; app0[10] = 1; app0[11] = 1;
    app0.writeUInt16BE(dpi, 12);
    app0.writeUInt16BE(dpi, 14);
    const sof = Buffer.alloc(19);
    sof.writeUInt16BE(0xffc0, 0);
    sof.writeUInt16BE(17, 2);
    sof[4] = 8;
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);
    sof[9] = 3;
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
const JPG = makeJpeg({ width: 600, height: 300, dpi: 300 });

const p = (text) => createParagraph(text);
const bold = (text) => createParagraph([{ type: 'strong', children: [createText(text)] }]);
const h = (depth, text) => createHeading(depth, text);
const imgP = (name) => createParagraph([{ type: 'image', url: name, alt: '', data: { assetName: name } }]);
const asset = (name) => ({ name, buffer: JPG, mime: 'image/jpeg' });
const $of = (xml) => load(xml, { xmlMode: true });
const textsOf = (xml, selector) => $of(xml)(selector).toArray().map((node) => $of(xml)(node).text());
const codesOf = (result) => result.issues.map((issue) => issue.code);

// 给一组顶层节点盖上解析层的分节信息（与 parsers/docx-sections 的 data.section 契约一致）
const inSection = (index, header, nodes) => nodes.map((node) => ({ ...node, data: { ...(node.data || {}), section: { index, header } } }));

const marked = (text) => p(`${MARK.PARAGRAPH}${text}`);
const claimP = (num, text) => p(`${MARK.CLAIM}${MARK.NUMBER}${num}. ${MARK.NUMBER}${text}`);
const titleP = (text) => p(`${MARK.TITLE}${text}${MARK.TITLE}`);
const headingP = (text) => p(`${MARK.HEADING}${text}${MARK.HEADING}`);
const labelP = (num) => p(`${MARK.NUMBER}图${num}${MARK.NUMBER}`);

async function renderPatent(children, { assets = [], meta = {} } = {}) {
    const doc = createDocument({ ir: createRoot(children), meta: { title: '文档标题', sourceType: 'docx', ...meta }, assets });
    return xmlRenderer.render(doc, normalizeOptions({ xml: { profile: 'patent' } }));
}

async function assertAllValid(files) {
    for (const name of XML_FILES.filter((file) => file in files)) {
        const checked = await validateXml(files[name]);
        if (!checked.available) return;
        assert.equal(checked.valid, true, `${name}：${JSON.stringify(checked.errors)}`);
    }
}

const assertNoResidue = (files) => {
    for (const name of XML_FILES.filter((file) => file in files)) assert.equal(PUA_RESIDUE_RE.test(files[name]), false, `${name} 残留私用区码位`);
};

// 官方五书模板形态（IR 级）：书目名只在页眉里，正文无任何书目标题段
function officialChildren(headers = ['说明书摘要', '摘要附图', '权利要求书', '说明书', '说明书附图']) {
    return [
        ...inSection(1, headers[0], [marked('本申请公开了一种夹持装置，包括底座与夹爪。'), marked('')]),
        ...inSection(2, headers[1], [imgP('images/image_1.jpg')]),
        ...inSection(3, headers[2], [
            claimP(1, '一种夹持装置，其特征在于，包括：'), p('底座(1)；'), p('夹爪(2)，滑动设于所述底座(1)上。'),
            claimP(2, '根据权利要求1所述的夹持装置，其特征在于：所述夹爪(2)由丝杆(3)驱动。'),
        ]),
        ...inSection(4, headers[3], [
            titleP('一种夹持装置'),
            headingP('技术领域'), marked('本申请涉及试验工装技术领域。'),
            headingP('发明内容'), marked('本申请的目的是提供一种夹持装置。'), marked('1、夹爪由丝杆驱动，装夹一次到位。'),
            headingP('具体实施方式'), marked('实施例一'), marked('参照图1，底座1上滑动设有夹爪2。'),
        ]),
        ...inSection(5, headers[4], [imgP('images/image_2.jpg'), labelP(1), imgP('images/image_3.jpg'), labelP(2)]),
    ];
}
const officialAssets = () => [asset('images/image_1.jpg'), asset('images/image_2.jpg'), asset('images/image_3.jpg')];

// ============================================================
// Word 分节页眉
// ============================================================

describe('patent profile：Word 分节页眉定书目', () => {
    test('五节页眉映射五书：整节直接归入，不报按位置推定、无法归类与缺节', async () => {
        const result = await renderPatent(officialChildren(), { assets: officialAssets() });

        assert.deepEqual(Object.keys(result.files).sort(), [...XML_FILES, '{name}.zip', 'precheck.json'].sort());
        for (const code of SECTION_FALLBACK_CODES) assert.ok(!codesOf(result).includes(code), `不应出现 ${code}：${JSON.stringify(result.warnings)}`);
        assert.deepEqual(result.warnings.filter((item) => item.startsWith('分节：')), []);
        const claims = $of(result.files['claims.xml']);
        assert.deepEqual(claims('claim').toArray().map((node) => [node.attribs.num, claims(node).find('claim-text').length]), [['1', 3], ['2', 1]]);
        assert.equal(claims('claim-text').first().text(), '一种夹持装置，其特征在于，包括：', '权 1 不含编号');
        assert.deepEqual(textsOf(result.files['abstract.xml'], 'cn-abstract > p'), ['本申请公开了一种夹持装置，包括底座与夹爪。'], '只含码位的空壳段不成段');
        assert.equal($of(result.files['abstract-figure.xml'])('cn-abst-figure > figure > img').length, 1);
        assert.ok(!codesOf(result).includes(ISSUE_CODES.FIGURE_INLINE_IMAGE), '摘要附图不再当作正文内图片');
        assert.deepEqual($of(result.files['drawings.xml'])('figure').toArray().map((node) => node.attribs['figure-labels']), ['图1', '图2']);
        assertNoResidue(result.files);
        await assertAllValid(result.files);
    });

    test('页眉文字带字间空白或多行（案号一行、书目名一行）同样认得出', async () => {
        const spaced = ['权', '利', '要', '求', '书'].join(`${IDEOGRAPHIC_SPACE} `);
        const headers = ['说 明 书 摘 要', '（摘要附图）', `案号 AB-001\n${spaced}`, '说明书：', '附图'];

        const result = await renderPatent(officialChildren(headers), { assets: officialAssets() });

        assert.deepEqual(Object.keys(result.files).sort(), [...XML_FILES, '{name}.zip', 'precheck.json'].sort());
        assert.deepEqual(result.warnings.filter((item) => item.startsWith('分节：')), []);
        assert.equal($of(result.files['claims.xml'])('claim').length, 2);
    });

    test('页眉认不出书目（事务所抬头、空页眉）时回落到标题段与位置推定，产物与无分节信息时逐字一致', async () => {
        const build = (stamp) => [
            ...stamp(1, '某某知识产权代理有限公司', [bold('权利要求书'), p('1. 一种装置，其特征在于设有底座。'), p('2. 根据权利要求1所述的装置，其特征在于还设有顶盖。')]),
            ...stamp(2, '', [bold('说明书'), p('一种装置'), h(1, '技术领域'), p('本发明涉及装置。')]),
            ...stamp(3, '某某知识产权代理有限公司', [h(1, '背景技术'), p('现有装置结构复杂。'), bold('说明书摘要'), p('本发明公开了一种装置。')]),
        ];

        const withSections = await renderPatent(build(inSection));
        const without = await renderPatent(build((index, header, nodes) => nodes));

        for (const name of XML_FILES.filter((file) => file in without.files)) assert.equal(withSections.files[name], without.files[name], name);
        assert.deepEqual(withSections.warnings, without.warnings);
        assert.equal(textsOf(withSections.files['description.xml'], 'description > p').length, 2, '分节边界不切断标题段区域');
    });

    test('页眉区域之后的无书目分节另起区域回落位置推定，不被前一书目吞并', async () => {
        const children = [
            ...inSection(1, '说明书摘要', [p('本发明公开了一种装置。')]),
            ...inSection(2, '某某事务所', [
                p('1. 一种装置，其特征在于设有底座。'), p('2. 根据权利要求1所述的装置，其特征在于还设有顶盖。'),
                p('一种装置'), h(1, '技术领域'), p('本发明涉及装置。'),
            ]),
        ];

        const result = await renderPatent(children);

        assert.deepEqual(textsOf(result.files['abstract.xml'], 'cn-abstract > p'), ['本发明公开了一种装置。']);
        assert.equal($of(result.files['claims.xml'])('claim').length, 2);
        assert.equal($of(result.files['description.xml'])('invention-title').text(), '一种装置');
        const inferred = result.warnings.find((item) => item.startsWith('分节：未发现书目标题，按位置推定：'));
        assert.ok(inferred && inferred.includes('权利要求书=') && inferred.includes('说明书='), JSON.stringify(result.warnings));
        assert.ok(!inferred.includes('说明书摘要='), '页眉定下的书目不列入按位置推定');
    });

    test('同一分节内的书目标题段照旧生效；不带分节信息的块沿用前一块的分节', async () => {
        const rasterizedTable = { type: 'image', url: 'images/table-1.jpg', alt: '表格 1', data: { assetName: 'images/table-1.jpg', role: 'table' } };
        const children = [
            ...inSection(1, '权利要求书', [p('1. 一种装置，其特征在于设有底座。')]),
            ...inSection(2, '说明书', [p('一种装置'), h(1, '技术领域'), p('本发明涉及装置。')]),
            rasterizedTable,
            ...inSection(2, '说明书', [p('表后的一段。'), bold('说明书附图'), imgP('images/image_1.jpg'), p('图1')]),
            ...inSection(3, '说明书摘要', [p('本发明公开了一种装置。')]),
        ];

        const result = await renderPatent(children, { assets: [asset('images/image_1.jpg'), asset('images/table-1.jpg')] });

        const desc = $of(result.files['description.xml']);
        assert.deepEqual(desc('description > p').toArray().map((node) => desc(node).text().trim()), ['本发明涉及装置。', '', '表后的一段。']);
        assert.equal(desc('description > p > tables > img').length, 1, '栅格化表格随前一块留在说明书');
        assert.equal($of(result.files['drawings.xml'])('figure').attr('figure-labels'), '图1');
        assert.deepEqual(textsOf(result.files['abstract.xml'], 'cn-abstract > p'), ['本发明公开了一种装置。']);
        assert.deepEqual(result.warnings.filter((item) => item.startsWith('分节：')), []);
        await assertAllValid(result.files);
    });
});

// ============================================================
// 官方标记码位
// ============================================================

describe('patent profile：官方标记码位', () => {
    test('U+E209 定发明名称、U+E20A 定小标题（不限五部分标题）、U+E205 标明的正文段不被猜成小标题或权项', async () => {
        const children = [
            ...inSection(1, '权利要求书', [claimP(1, '一种装置，其特征在于设有底座。')]),
            ...inSection(2, '说明书', [
                titleP('用于试样装夹的装置，及其使用方法'),
                headingP('技术领域'), marked('本申请涉及装置。'),
                headingP('有益效果'), marked('1、装夹一次到位。'), marked('实施例'),
            ]),
        ];

        const result = await renderPatent(children);

        const desc = $of(result.files['description.xml']);
        assert.equal(desc('invention-title').text(), '用于试样装夹的装置，及其使用方法', '带标点、不以「一种」起头也认');
        assert.equal(result.title, '用于试样装夹的装置，及其使用方法');
        assert.deepEqual(desc('heading').toArray().map((node) => desc(node).text()), ['技术领域', '有益效果']);
        assert.deepEqual(desc('description > p').toArray().map((node) => [node.attribs.num, desc(node).text()]),
            [['0001', '本申请涉及装置。'], ['0002', '1、装夹一次到位。'], ['0003', '实施例']]);
        assert.ok(!codesOf(result).includes(ISSUE_CODES.TITLE_FALLBACK));
        assert.ok(!codesOf(result).includes(ISSUE_CODES.PRECHECK_CHARSET), '官方标记码位不计入字符集问题');
        assertNoResidue(result.files);
        await assertAllValid(result.files);
    });

    test('U+E206 + U+E208：编号去壳后交权项模块，续行段归入当前权项；U+E208 图号去壳后定图注', async () => {
        const children = [
            ...inSection(1, '权利要求书', [
                claimP(1, '一种装置，其特征在于，包括：'), p('底座；'),
                claimP(2, '根据权利要求1所述的装置，其特征在于还设有顶盖。'),
            ]),
            ...inSection(2, '说明书', [titleP('一种装置'), headingP('技术领域'), marked('本申请涉及装置。')]),
            ...inSection(3, '说明书附图', [imgP('images/image_1.jpg'), labelP(13)]),
        ];

        const result = await renderPatent(children, { assets: [asset('images/image_1.jpg')] });

        const claims = $of(result.files['claims.xml']);
        assert.deepEqual(claims('claim').toArray().map((node) => [node.attribs.id, node.attribs.num]), [['cl001', '1'], ['cl002', '2']]);
        assert.deepEqual(claims('claim').first().find('claim-text').toArray().map((node) => claims(node).text()), ['一种装置，其特征在于，包括：', '底座；']);
        const figure = $of(result.files['drawings.xml'])('figure');
        assert.equal(figure.attr('figure-labels'), '图13');
        assert.equal(figure.attr('num'), '0013');
        assertNoResidue(result.files);
    });

    test('无分节信息时 U+E206 参与位置推定：未写编号的权项起始段同样划出权利要求书', async () => {
        const children = [
            marked('本申请公开了一种装置。'),
            p(`${MARK.CLAIM}一种装置，其特征在于设有底座。`),
            p(`${MARK.CLAIM}根据权利要求1所述的装置，其特征在于还设有顶盖。`),
            titleP('一种装置'), headingP('技术领域'), marked('本申请涉及装置。'),
        ];

        const result = await renderPatent(children);

        assert.equal($of(result.files['claims.xml'])('claim').length, 2);
        assert.ok(codesOf(result).includes(ISSUE_CODES.CLAIM_NONE), '无编号时由权项模块按段落顺序编号');
        assert.deepEqual(textsOf(result.files['abstract.xml'], 'cn-abstract > p'), ['本申请公开了一种装置。']);
        assert.deepEqual(textsOf(result.files['description.xml'], 'description > p'), ['本申请涉及装置。']);
        assertNoResidue(result.files);
    });

    test('字面汉字规则仅在全文无结构码位时启用：官方模板稿中首尾同字的段落不被削字、不改判角色', async () => {
        const literal = '名单以附件所列为准并逐一署名';
        const body = (wrap) => [
            bold('说明书'), p('一种装置'), h(1, '技术领域'), wrap('本发明涉及装置。'), p(literal),
        ];

        const official = await renderPatent(body(marked));
        const legacy = await renderPatent(body(p));

        assert.deepEqual(textsOf(official.files['description.xml'], 'description > p'), ['本发明涉及装置。', literal]);
        assert.deepEqual(textsOf(legacy.files['description.xml'], 'description > p'), ['本发明涉及装置。', literal.slice(1, -1)], '无码位文稿沿用既有字面规则');
    });
});

// ============================================================
// 合成 docx 端到端
// ============================================================

describe('patent profile：官方五书模板形态的 docx 端到端', () => {
    const options = { math: 'text', xml: { profile: 'patent', validate: true, patent: { rasterizeTables: false, rasterizeFormulas: false } } };

    test('解析 → 页眉定五书 → 码位定发明名称、小标题、权项与图号 → DTD 通过，无分节类提示、无私用区残留', async () => {
        const source = path.join(tmpDir, '官方模板样稿.docx');
        fs.writeFileSync(source, await buildOfficialTemplateDocx());

        const res = await convert({ input: { path: source }, target: 'xml', outputDir: tmpDir, options });

        assert.equal(res.ok, true);
        assert.deepEqual(Object.keys(res.outputs).sort(), ['abstract', 'abstractFigure', 'claims', 'description', 'drawings', 'precheck', 'zip'].sort());
        assert.deepEqual(res.warnings.filter((item) => item.startsWith('分节：') || item.startsWith('DTD 校验：')), [], JSON.stringify(res.warnings));
        assert.equal(res.title, OFFICIAL_EXPECTED.inventionTitle);
        const read = (key) => fs.readFileSync(res.outputs[key], 'utf8');
        const claims = $of(read('claims'));
        assert.deepEqual(claims('claim').toArray().map((node) => claims(node).find('claim-text').toArray().map((item) => claims(item).text())),
            OFFICIAL_EXPECTED.claims.map((parts) => [...parts]));
        const desc = $of(read('description'));
        assert.equal(desc('invention-title').text(), OFFICIAL_EXPECTED.inventionTitle);
        assert.deepEqual(desc('heading').toArray().map((node) => desc(node).text()), [...OFFICIAL_EXPECTED.headings]);
        assert.deepEqual(desc('description > p').toArray().map((node) => desc(node).text()), [...OFFICIAL_EXPECTED.paragraphs]);
        assert.deepEqual(textsOf(read('abstract'), 'cn-abstract > p'), [OFFICIAL_EXPECTED.abstract]);
        assert.equal($of(read('abstractFigure'))('cn-abst-figure > figure').length, 1);
        assert.deepEqual($of(read('drawings'))('figure').toArray().map((node) => node.attribs['figure-labels']), [...OFFICIAL_EXPECTED.figureLabels]);
        for (const key of ['claims', 'description', 'drawings', 'abstract', 'abstractFigure']) assert.equal(PUA_RESIDUE_RE.test(read(key)), false, key);
        const report = JSON.parse(read('precheck'));
        assert.ok(report.validation.files.every((item) => item.valid), JSON.stringify(report.validation));
    });
});
