/**
 * xml 目标 patent profile 单元测试（converters/renderers/xml/patent.js 及 sections/claims/numbering/figures/precheck）
 * 覆盖：常量表；heading 分节与加粗短段分节两条路径下的五书分文件、文件头三行逐字（含 BOM 与 DOCTYPE 的
 *       空内部子集）、根元素；官方标记剥离；无标题行样稿（摘要前导段 + 顿号权项含续行 + depth=1 五部分
 *       标题 + 附图说明 + 尾部图片与纯图号段）；发明名称回退链；段号连续四位、[000N] 复用与跳变、
 *       numbering.start/width；权项引用与正文图号一律保留纯文本（不生成 claim-ref / figref）；
 *       表格/公式 image 节点 → tables/maths；1C 未就绪的 table/math 降级 + warning；缺节 warning；
 *       parts 显式子集；预检各项与 precheck.json；zip 条目清单；平铺落盘无 images/；
 *       每份产物与参考夹具经 validateXml 均 valid；夹具 docx 端到端。
 *       另设「官方产出一致性」一组，逐项断言与官方「WORD 转 XML 编辑器」真实产出的对齐：wi/he 取 IR 的
 *       displayWidthMm / displayHeightMm 并向下取整（缺失时回退像素换算）、img id 前缀 if / iaf / idf
 *       各自独立编号、figure 与 maths / tables 的 @num 四位补零、figure-labels 承载图注、img 的
 *       top/left/orientation/inline 取值与属性顺序、BOM 与 DOCTYPE 的 []、附图部分杂散文字丢弃并告警
 */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('cheerio');
const JSZip = require('jszip');

const xmlRenderer = require('../converters/renderers/xml');
const patent = require('../converters/renderers/xml/patent');
const { validateXml } = require('../converters/renderers/xml/validate');
const { ISSUE_CODES, CATEGORIES, precheck } = require('../converters/renderers/xml/precheck');
const { readJpegInfo } = require('../converters/renderers/xml/image-info');
const { normalizeOptions } = require('../converters/options');
const { convert, renderDocument, writeDocument } = require('../converters');
const {
    createDocument, createRoot, createHeading, createParagraph, createText, createMath, createTable, createTableRow, createTableCell,
} = require('../converters/ir/schema');

const FIXTURES = path.join(__dirname, 'fixtures');
const REFERENCE_DIR = path.join(FIXTURES, 'patent', 'reference');
const PNG = fs.readFileSync(path.join(FIXTURES, 'images', 'pic.png'));
const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(TMP_ROOT, 'xml-patent-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// 官方产出带 UTF-8 BOM，DOCTYPE 带空内部子集 []
const BOM = '\ufeff';
const BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);
const HEADER_LINES = [
    `${BOM}<?xml version="1.0" encoding="UTF-8"?>`,
    '<!DOCTYPE cn-application-body SYSTEM "/dtdandxsl/cn-application-body-20080416.dtd"[]>',
    '<?xml-stylesheet type="text/xsl" href="/dtdandxsl/showxml.xsl"?>',
    '<cn-application-body lang="zh" country="CN">',
];
const XML_FILES = ['claims.xml', 'description.xml', 'drawings.xml', 'abstract.xml', 'abstract-figure.xml'];

// ============================================================
// 辅助
// ============================================================

// 只含标记段的最小 JPEG：SOI + APP0(JFIF 密度) + SOF0(尺寸) + EOI，供尺寸/密度读取（不解码像素）
function makeJpeg({ width, height, dpi = null }) {
    const app0 = Buffer.alloc(18);
    app0.writeUInt16BE(0xffe0, 0);
    app0.writeUInt16BE(16, 2);
    app0.write('JFIF\0', 4, 'latin1');
    app0[9] = 1; app0[10] = 1;
    app0[11] = dpi ? 1 : 0;
    app0.writeUInt16BE(dpi || 1, 12);
    app0.writeUInt16BE(dpi || 1, 14);
    const sof = Buffer.alloc(19);
    sof.writeUInt16BE(0xffc0, 0);
    sof.writeUInt16BE(17, 2);
    sof[4] = 8;
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);
    sof[9] = 3;
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
const JPG_WIDE = makeJpeg({ width: 600, height: 300, dpi: 300 });   // 51 × 25 mm，横向
const JPG_TALL = makeJpeg({ width: 300, height: 600, dpi: 300 });   // 25 × 51 mm，纵向

const p = (text) => createParagraph(text);
const bold = (text) => createParagraph([{ type: 'strong', children: [createText(text)] }]);
const italic = (text) => createParagraph([{ type: 'emphasis', children: [createText(text)] }]);
const h = (depth, text) => createHeading(depth, text);
const image = (name, data = {}) => ({ type: 'image', url: name, alt: '', data: { assetName: name, ...data } });
const imgP = (name, data) => createParagraph([image(name, data)]);
const asset = (name, buffer = JPG_WIDE, mime = 'image/jpeg') => ({ name, buffer, mime });
const $of = (xml) => load(xml, { xmlMode: true });
// 递归取 DOM 节点文本（cheerio 的 load(node) 会把节点移入新文档，不能用于反复查询）
const textOf = (node) => (node.type === 'text' ? node.data : (node.children || []).map(textOf).join(''));

async function renderPatent(children, { assets = [], meta = {}, data = null, options = {}, warnings = [] } = {}) {
    const doc = createDocument({ ir: createRoot(children), meta: { title: '文档标题', sourceType: 'docx', ...meta }, assets, data, warnings });
    const { xml: xmlOptions = {}, ...rest } = options;
    const result = await xmlRenderer.render(doc, normalizeOptions({ ...rest, xml: { profile: 'patent', ...xmlOptions } }));
    return { ...result, precheck: JSON.parse(result.files['precheck.json']) };
}

const codesOf = (result) => result.issues.map((issue) => issue.code);

// 规范稿：四书标题（heading 或加粗短段）+ 五部分标题（depth=1 heading）
function standardDoc(title) {
    return [
        p('发明名称：一种测试装置'),
        title('权利要求书'),
        p('1. 一种测试装置，其特征在于，包括壳体。'),
        p('2. 根据权利要求1所述的测试装置，其特征在于，所述壳体为筒状。'),
        p('3. 根据权利要求1或2所述的测试装置，其特征在于，所述壳体为金属。'),
        title('说明书'),
        h(1, '技术领域'), p('本发明涉及医疗器械。'),
        h(1, '背景技术'), p('现有装置操作繁琐。'),
        h(1, '发明内容'), p('本发明提供一种测试装置。'),
        h(1, '附图说明'), p('图1为整体结构示意图；图2为局部放大图。'),
        h(1, '具体实施方式'), p('如图1所示，壳体呈筒状。'),
        title('说明书附图'), imgP('images/image_1.jpg'), p('图1'), imgP('images/image_2.jpg'), p('图2'),
        title('说明书摘要'), p('本发明公开了一种测试装置。'),
        title('摘要附图'), imgP('images/image_1.jpg'),
    ];
}
const standardAssets = () => [asset('images/image_1.jpg', JPG_WIDE), asset('images/image_2.jpg', JPG_TALL)];

// 无标题行样稿（交接简报 §3 形态）
function noTitleDoc() {
    return [
        p('本实用新型公开了一种试剂灌装装置，解决了穿刺深度不可控的问题。'),
        p('1、一种试剂灌装装置，其特征在于，包括：'),
        p('机架；'),
        p('穿刺器座，安装于所述机架；'),
        p('2、根据权利要求1所述的试剂灌装装置，其特征在于，所述机架为铝合金。'),
        p('3、根据权利要求12-3任一项所述的试剂灌装装置，其特征在于，所述穿刺器座可拆卸。'),
        p('4、根据权利要求1-3任一项所述的试剂灌装装置，其特征在于，所述机架设有底座。'),
        h(1, '技术领域'), p('本实用新型涉及高压注射器技术领域。'),
        h(1, '背景技术'), p('现有装置使用不便。'),
        h(1, '发明内容'), p('本实用新型提供一种试剂灌装装置。'),
        h(1, '附图说明'), p('图1为试剂灌装装置结构图；'),
        h(1, '具体实施方式'), p('如图1所示，1、顶盖；2、底盖。'), p('下面结合实施例说明。'),
        imgP('images/image_1.jpg'), p('图1'), imgP('images/image_2.jpg'), p('图2'),
    ];
}

async function assertAllValid(files) {
    for (const [name, xml] of Object.entries(files)) {
        if (!name.endsWith('.xml')) continue;
        const result = await validateXml(xml);
        if (!result.available) return;
        assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.errors)}`);
    }
}

// ============================================================
// 常量与文件头
// ============================================================

describe('patent profile：常量与五书分文件', () => {
    test('FILE_NAMES / FILE_REF_STYLE / ELEMENT_NAMES 与研究报告 §5.1 一致', () => {
        assert.deepEqual(patent.FILE_NAMES, {
            claims: 'claims.xml', description: 'description.xml', drawings: 'drawings.xml',
            abstract: 'abstract.xml', abstractFigure: 'abstract-figure.xml',
        });
        assert.equal(patent.FILE_REF_STYLE, 'bare');
        assert.equal(patent.ELEMENT_NAMES.root, 'cn-application-body');
        assert.equal(patent.ELEMENT_NAMES.claims, 'cn-claims');
        assert.equal(patent.ELEMENT_NAMES.drawings, 'cn-drawings');
        assert.equal(patent.ELEMENT_NAMES.abstract, 'cn-abstract');
        assert.equal(patent.ELEMENT_NAMES.abstractFigure, 'cn-abst-figure');
        assert.equal(patent.ELEMENT_NAMES.drawingParagraph, undefined, '官方产出不含 cn-drawing-p');
        assert.equal(patent.ELEMENT_NAMES.claimRef, undefined, '官方产出不含 claim-ref');
        assert.equal(patent.ELEMENT_NAMES.figref, undefined, '官方产出不含 figref');
        assert.ok(Object.isFrozen(patent.ELEMENT_NAMES));
        assert.deepEqual(patent.ID_PREFIXES, {
            heading: 'h', figure: 'f', drawingImg: 'if', abstractImg: 'iaf', bodyImg: 'idf',
            tables: 'tabl', maths: 'math', chemistry: 'chem', claim: 'cl',
        });
        assert.deepEqual(patent.DOCTYPE, {
            name: 'cn-application-body',
            systemId: '/dtdandxsl/cn-application-body-20080416.dtd',
            internalSubset: '',
        });
        assert.deepEqual(patent.ROOT_ATTRS, { lang: 'zh', country: 'CN' });
        assert.equal(patent.PRECHECK_FILE, 'precheck.json');
    });

    for (const [label, title] of [['heading 分节', (text) => h(2, text)], ['加粗短段分节', bold]]) {
        test(`${label}：五书分文件 + zip + precheck.json，文件头三行逐字，各书结构与 id/num 约定，全部 DTD valid`, async () => {
            // Act
            const result = await renderPatent(standardDoc(title), { assets: standardAssets() });

            // Assert：产物集合与平铺资产
            assert.deepEqual(Object.keys(result.files).sort(), [...XML_FILES, '{name}.zip', 'precheck.json'].sort());
            assert.deepEqual(result.assets.map((item) => item.name), ['drawing-1.jpg', 'drawing-2.jpg']);
            assert.equal(result.omitDocAssets, true);
            for (const name of XML_FILES) {
                const lines = result.files[name].split('\n');
                assert.deepEqual(lines.slice(0, 4), HEADER_LINES, name);
                assert.deepEqual(Buffer.from(result.files[name], 'utf8').subarray(0, 3), BOM_BYTES, `${name} 文件头应为 UTF-8 BOM`);
                assert.equal(lines[lines.length - 2], '</cn-application-body>', name);
                assert.equal(lines[lines.length - 1], '', '末尾换行');
            }

            // Assert：权利要求书
            const claims = $of(result.files['claims.xml']);
            assert.equal(claims('cn-application-body > cn-claims > claim').length, 3);
            assert.deepEqual(claims('claim').toArray().map((node) => [node.attribs.id, node.attribs.num]), [['cl001', '1'], ['cl002', '2'], ['cl003', '3']]);
            assert.equal(claims('claim-ref').length, 0, '官方不生成 claim-ref');
            assert.equal(claims('claim').eq(2).find('claim-text').text(), '根据权利要求1或2所述的测试装置，其特征在于，所述壳体为金属。');
            assert.ok(result.files['claims.xml'].includes('<claim-text>根据权利要求1所述的测试装置，其特征在于，所述壳体为筒状。</claim-text>'));

            // Assert：说明书
            const desc = $of(result.files['description.xml']);
            assert.equal(desc('description > invention-title').text(), '一种测试装置');
            assert.deepEqual(desc('description > heading').toArray().map((node) => [node.attribs.id, node.attribs.level, textOf(node)]),
                [['h0001', '2', '技术领域'], ['h0002', '2', '背景技术'], ['h0003', '2', '发明内容'], ['h0004', '2', '附图说明'], ['h0005', '2', '具体实施方式']]);
            assert.deepEqual(desc('description > p').toArray().map((node) => [node.attribs.id, node.attribs.num, node.attribs.Italic]),
                [['p0001', '0001', '0'], ['p0002', '0002', '0'], ['p0003', '0003', '0'], ['p0004', '0004', '0'], ['p0005', '0005', '0']]);
            assert.equal(desc('description').attr('id'), undefined, '容器不写 id');
            assert.equal(desc('figref').length, 0, '官方不生成 figref');
            assert.equal(desc('description > p').eq(3).text(), '图1为整体结构示意图；图2为局部放大图。', '正文图号保留为纯文本');
            assert.equal(desc('description > p').eq(4).text(), '如图1所示，壳体呈筒状。');

            // Assert：说明书附图
            const drawings = $of(result.files['drawings.xml']);
            const children = drawings('cn-drawings').children().toArray().map((node) => node.name);
            assert.deepEqual(children, ['figure', 'figure'], '图注改由 figure-labels 承载，不再有 cn-drawing-p');
            assert.equal(drawings('cn-drawing-p').length, 0);
            assert.deepEqual(drawings('figure').toArray().map((node) => [node.attribs.id, node.attribs.num, node.attribs['figure-labels']]),
                [['f0001', '0001', '图1'], ['f0002', '0002', '图2']]);
            const img1 = drawings('figure').eq(0).find('img');
            assert.deepEqual(img1.attr(), {
                id: 'if0001', file: 'drawing-1.jpg', wi: '50', he: '25', top: '0', left: '0',
                'img-content': 'drawing', 'img-format': 'jpg', orientation: 'portrait', inline: 'yes',
            });
            assert.deepEqual(drawings('figure').eq(1).find('img').attr(), {
                id: 'if0002', file: 'drawing-2.jpg', wi: '25', he: '50', top: '0', left: '0',
                'img-content': 'drawing', 'img-format': 'jpg', orientation: 'portrait', inline: 'yes',
            }, '横图与竖图的 orientation 同为 portrait');
            assert.ok(result.files['drawings.xml'].includes(
                '<img id="if0001" file="drawing-1.jpg" wi="50" he="25" top="0" left="0" img-content="drawing" img-format="jpg" orientation="portrait" inline="yes"/>'),
            'img 属性顺序与官方逐字一致');

            // Assert：摘要与摘要附图（复用 image_1 → 同一裸文件名）
            const abstract = $of(result.files['abstract.xml']);
            assert.deepEqual(abstract('cn-abstract > p').toArray().map((node) => [node.attribs.id, node.attribs.num]), [['p0001', '0001']]);
            const abstractFigure = $of(result.files['abstract-figure.xml']);
            assert.equal(abstractFigure('cn-abstract > cn-abst-figure > figure > img').attr('file'), 'drawing-1.jpg');
            assert.equal(abstractFigure('figure > img').attr('id'), 'iaf0001', '摘要附图的 img 用 iaf 前缀');
            assert.equal(abstractFigure('figure > img').attr('inline'), 'yes');
            assert.equal(abstractFigure('figure').attr('num'), '0001');
            assert.equal(abstractFigure('figure').attr('figure-labels'), undefined, '官方摘要附图的 figure 不写 figure-labels');
            assert.equal(abstractFigure('cn-drawing-p').length, 0, 'cn-abst-figure 不含 cn-drawing-p');
            assert.ok(result.warnings.includes('附图：已生成摘要附图；官方提示摘要附图不再单独接收，建议提交前删除'));
            assert.ok(!codesOf(result).includes(ISSUE_CODES.SECTION_MISSING));

            await assertAllValid(result.files);
        });
    }

    test('sectionDetection=headings 时加粗短段不再作为分节标题，只认 heading 节点', async () => {
        const result = await renderPatent(standardDoc(bold), { assets: standardAssets(), options: { xml: { patent: { sectionDetection: 'headings' } } } });
        assert.equal('claims.xml' in result.files, true, '权项仍按位置推定');
        assert.ok(codesOf(result).includes(ISSUE_CODES.SECTION_UNCLASSIFIED) || codesOf(result).includes(ISSUE_CODES.SECTION_INFERRED));
        const headingOnly = await renderPatent(standardDoc((text) => h(2, text)), { assets: standardAssets(), options: { xml: { patent: { sectionDetection: 'headings' } } } });
        assert.deepEqual(Object.keys(headingOnly.files).sort(), [...XML_FILES, '{name}.zip', 'precheck.json'].sort());
    });

    test('官方显式标记剥离：名…名 / 题…题 / 段号[0001]号 / 条号1.号 / 号图1号 与私用区标记码位', async () => {
        const children = [
            bold('权利要求书'),
            p('条号1.号一种装置，其特征在于设有底座。'),
            bold('说明书'),
            p('名一种装置名'),
            p('题技术领域题'),
            p('段号[0001]号本发明涉及装置。'),
            p('段号[0002]号第二段。'),
            bold('说明书附图'),
            imgP('images/image_1.jpg'), p('号图1号'),
        ];
        const result = await renderPatent(children, { assets: [asset('images/image_1.jpg')] });

        const claims = $of(result.files['claims.xml']);
        assert.equal(claims('claim').attr('num'), '1');
        assert.equal(claims('claim-text').text(), '一种装置，其特征在于设有底座。');
        const desc = $of(result.files['description.xml']);
        assert.equal(desc('invention-title').text(), '一种装置');
        assert.equal(desc('heading').text(), '技术领域');
        assert.deepEqual(desc('description > p').toArray().map((node) => [node.attribs.num, textOf(node)]), [['0001', '本发明涉及装置。'], ['0002', '第二段。']]);
        assert.equal($of(result.files['drawings.xml'])('figure').attr('figure-labels'), '图1');
        assert.ok(!codesOf(result).includes(ISSUE_CODES.NUMBERING_JUMP));
        assert.ok(!codesOf(result).includes(ISSUE_CODES.PRECHECK_CHARSET), '官方标记码位不计入字符集问题');
        await assertAllValid(result.files);
    });
});

// ============================================================
// 无标题行样稿与发明名称回退
// ============================================================

describe('patent profile：无标题行样稿的位置推定', () => {
    test('四书归属、权 1 主题回退、权项引用保留纯文本、正文编号段不当权项、附图顺序', async () => {
        // Act
        const result = await renderPatent(noTitleDoc(), { assets: standardAssets(), meta: { title: '技术领域' } });

        // Assert：四书
        assert.deepEqual(Object.keys(result.files).sort(), ['abstract.xml', 'claims.xml', 'description.xml', 'drawings.xml', '{name}.zip', 'precheck.json'].sort());
        const abstract = $of(result.files['abstract.xml']);
        assert.equal(abstract('cn-abstract > p').length, 1);
        assert.match(abstract('cn-abstract > p').text(), /^本实用新型公开了一种试剂灌装装置/);
        assert.ok(result.warnings.includes('分节：未发现书目标题，按位置推定：说明书摘要=第 1 段；权利要求书=第 2–7 段；说明书=第 8–18 段；说明书附图=第 19 段起'), JSON.stringify(result.warnings));
        assert.equal(result.issues.filter((issue) => issue.code === ISSUE_CODES.SECTION_INFERRED).length, 1, 'SECTION_INFERRED 合并为一条');
        assert.equal(result.title, '一种试剂灌装装置', '渲染器以发明名称作为结果信封 title');

        // Assert：权项（续行段归权 1；权 3 引用悬空；权 4 范围展开）
        const claims = $of(result.files['claims.xml']);
        assert.equal(claims('claim').length, 4);
        assert.equal(claims('claim').eq(0).find('claim-text').length, 3);
        assert.equal(claims('claim').eq(0).find('claim-text').eq(1).text(), '机架；');
        assert.equal(claims('claim-ref').length, 0, '官方不生成 claim-ref');
        assert.ok(claims('claim').eq(2).find('claim-text').text().includes('根据权利要求12-3任一项'));
        assert.ok(claims('claim').eq(3).find('claim-text').text().includes('根据权利要求1-3任一项'));
        assert.ok(!result.warnings.some((item) => item.includes('claim-ref')), '不再产生权项引用问题项');

        // Assert：说明书（发明名称来自权 1；正文「1、顶盖；2、底盖」是段落不是权项；图号为纯文本）
        const desc = $of(result.files['description.xml']);
        assert.equal(desc('invention-title').text(), '一种试剂灌装装置');
        assert.ok(result.warnings.includes('发明名称：未找到发明名称段，已从权利要求 1 推定为“一种试剂灌装装置”'));
        assert.deepEqual(desc('heading').toArray().map((node) => textOf(node)), ['技术领域', '背景技术', '发明内容', '附图说明', '具体实施方式']);
        const texts = desc('description > p').toArray().map((node) => textOf(node));
        assert.ok(texts.includes('如图1所示，1、顶盖；2、底盖。'));
        assert.equal(desc('description > p').length, 6);
        assert.equal(desc('description > p').last().attr('num'), '0006');
        assert.equal(desc('figref').length, 0, '官方不生成 figref');

        // Assert：附图
        const drawings = $of(result.files['drawings.xml']);
        assert.deepEqual(drawings('cn-drawings').children().toArray().map((node) => node.name), ['figure', 'figure']);
        assert.deepEqual(drawings('figure').toArray().map((node) => [node.attribs.num, node.attribs['figure-labels']]), [['0001', '图1'], ['0002', '图2']]);
        assert.deepEqual(result.assets.map((item) => item.name), ['drawing-1.jpg', 'drawing-2.jpg']);
        await assertAllValid(result.files);
    });

    test('发明名称回退到文档标题；文档标题为分节名且无权项时缺失并 warning；说明书标题段优先于权 1', async () => {
        const noClaims = [h(1, '技术领域'), p('本发明涉及装置。')];
        const byMeta = await renderPatent(noClaims, { meta: { title: '一种装置' } });
        assert.equal($of(byMeta.files['description.xml'])('invention-title').text(), '一种装置');
        assert.ok(byMeta.warnings.includes('发明名称：未找到发明名称段，已回退为文档标题“一种装置”'));

        const missing = await renderPatent(noClaims, { meta: { title: '技术领域' } });
        assert.equal($of(missing.files['description.xml'])('invention-title').length, 0);
        assert.ok(codesOf(missing).includes(ISSUE_CODES.TITLE_MISSING));
        assert.ok(missing.warnings.some((item) => item.startsWith('发明名称：')));

        const titled = await renderPatent([bold('说明书'), bold('一种试剂灌装装置'), h(1, '技术领域'), p('正文。')]);
        assert.equal($of(titled.files['description.xml'])('invention-title').text(), '一种试剂灌装装置');
        assert.ok(!codesOf(titled).includes(ISSUE_CODES.TITLE_FALLBACK));
    });

    test('前导正文超过 3 段或含编号段时并入说明书并 warning；缺节逐项 warning', async () => {
        const result = await renderPatent([p('第一段。'), p('第二段。'), p('第三段。'), p('第四段。'), h(1, '技术领域'), p('正文。')]);
        assert.equal('abstract.xml' in result.files, false);
        assert.ok(result.warnings.some((item) => /^分节：4 个前导块无法归类/.test(item)));
        assert.equal($of(result.files['description.xml'])('description > p').length, 5);
        for (const label of ['权利要求书', '说明书附图', '说明书摘要']) {
            assert.ok(result.warnings.includes(`分节：未识别到${label}`), label);
        }
    });
});

// ============================================================
// 段号、行内标记、权项引用
// ============================================================

describe('patent profile：段号与行内', () => {
    test('段号连续四位；[000N] 向前复用并 warning、向后冲突按预期续编；numbering.start / width', async () => {
        const children = [h(2, '说明书'), h(1, '技术领域'), p('一'), p('二'), p('[0005] 五'), p('六'), p('［0003］ 冲突')];
        const result = await renderPatent(children);
        const desc = $of(result.files['description.xml']);
        assert.deepEqual(desc('description > p').toArray().map((node) => [node.attribs.id, node.attribs.num, textOf(node)]),
            [['p0001', '0001', '一'], ['p0002', '0002', '二'], ['p0005', '0005', '五'], ['p0006', '0006', '六'], ['p0007', '0007', '冲突']]);
        assert.ok(result.warnings.includes('段号：第 3 段标为 [0005]，预期 [0003]，已按原稿段号续编'));
        assert.ok(result.warnings.includes('段号：第 5 段标为 [0003]，预期 [0007]，原稿段号与已编段号冲突，已按预期续编'));
        await assertAllValid(result.files);

        const custom = await renderPatent([h(2, '说明书'), p('正文。')], { options: { xml: { numbering: { start: 3, width: 5 } } } });
        assert.deepEqual($of(custom.files['description.xml'])('description > p').toArray().map((node) => [node.attribs.id, node.attribs.num]), [['p00003', '00003']]);
    });

    test('整段斜体 Italic="1" 且不再包 i；局部斜体/加粗为 i/b；html 上下标还原为 sub/sup；软换行为 br', async () => {
        const children = [
            h(2, '说明书'),
            italic('整段斜体'),
            createParagraph([createText('部分'), { type: 'emphasis', children: [createText('斜')] }, { type: 'strong', children: [createText('粗')] }]),
            createParagraph([createText('H'), { type: 'html', value: '<sub>' }, createText('2'), { type: 'html', value: '</sub>' }, createText('O 与 x'), { type: 'html', value: '<sup>' }, createText('2'), { type: 'html', value: '</sup>' }]),
            createParagraph([createText('上行'), { type: 'break' }, createText('下行')]),
        ];
        const result = await renderPatent(children);
        const xml = result.files['description.xml'];
        assert.ok(xml.includes('<p id="p0001" num="0001" Italic="1">整段斜体</p>'), xml);
        assert.ok(xml.includes('<p id="p0002" num="0002" Italic="0">部分<i>斜</i><b>粗</b></p>'), xml);
        assert.ok(xml.includes('<p id="p0003" num="0003" Italic="0">H<sub>2</sub>O 与 x<sup>2</sup></p>'), xml);
        assert.ok(xml.includes('<p id="p0004" num="0004" Italic="0">上行<br/>下行</p>'), xml);
        await assertAllValid(result.files);
    });

    test('权项引用一律保留纯文本：「1至2」「1、3」「2-3」「9」均不生成 claim-ref；项号不连续 warning', async () => {
        const children = [
            h(2, '权利要求书'),
            p('1. 一种装置。'), p('2. 根据权利要求1所述的装置。'), p('3. 根据权利要求1至2所述的装置。'),
            p('4. 根据权利要求1、3所述的装置，且如权利要求2-3所述。'), p('6. 根据权利要求9所述的装置。'),
        ];
        const result = await renderPatent(children);
        const claims = $of(result.files['claims.xml']);
        assert.equal(claims('claim-ref').length, 0);
        assert.equal(claims('claim').eq(2).find('claim-text').text(), '根据权利要求1至2所述的装置。');
        assert.equal(claims('claim').eq(3).find('claim-text').text(), '根据权利要求1、3所述的装置，且如权利要求2-3所述。');
        assert.equal(claims('claim').eq(4).find('claim-text').text(), '根据权利要求9所述的装置。', '引用不存在的权项也只是纯文本');
        assert.equal(claims('claim').eq(4).attr('id'), 'cl006');
        assert.ok(!result.warnings.some((item) => item.includes('claim-ref')));
        assert.ok(result.warnings.some((item) => item.startsWith('权项：权利要求项号不连续或重复：实际为 1、2、3、4、6')));
        await assertAllValid(result.files);
    });
});

// ============================================================
// 附图、表格与公式
// ============================================================

describe('patent profile：附图、表格与公式', () => {
    test('图号取「图N」（图前或图后）、缺号顺序补号、图号不连续 warning、非 JPG 资产与缺失资产', async () => {
        const children = [
            h(2, '说明书附图'),
            p('图2'), imgP('images/image_1.jpg'),
            imgP('images/image_2.png'),
            imgP('images/missing.jpg'),
            imgP('images/image_3.jpg'), p('图5：装置示意图'),
        ];
        const result = await renderPatent(children, { assets: [asset('images/image_1.jpg'), asset('images/image_2.png', PNG, 'image/png'), asset('images/image_3.jpg', JPG_TALL)] });
        const drawings = $of(result.files['drawings.xml']);
        assert.deepEqual(drawings('figure').toArray().map((node) => [node.attribs.num, node.attribs['figure-labels']]),
            [['0002', '图2'], ['0003', '图3'], ['0005', '图5：装置示意图']], '图注取原稿图号段文本，缺图号段时回退为「图N」');
        assert.deepEqual(drawings('img').toArray().map((node) => [node.attribs.file, node.attribs['img-format'], node.attribs.wi, node.attribs.he]),
            [['drawing-1.jpg', 'jpg', '50', '25'], ['drawing-2.png', 'jpg', '1', '1'], ['drawing-3.jpg', 'jpg', '25', '50']], '毫米向下取整');
        assert.deepEqual(drawings('img').toArray().map((node) => [node.attribs.id, node.attribs.orientation, node.attribs.inline]),
            [['if0001', 'portrait', 'yes'], ['if0002', 'portrait', 'yes'], ['if0003', 'portrait', 'yes']], '缺图的编号不占用 img 序号');
        assert.ok(codesOf(result).includes(ISSUE_CODES.FIGURE_NUMBER_GAP));
        assert.ok(codesOf(result).includes(ISSUE_CODES.FIGURE_MISSING_ASSET));
        assert.ok(result.warnings.includes('预检：图片 images/image_2.png 为 png 格式，官方只受理 JPG/TIF'));
        assert.equal(readJpegInfo(JPG_WIDE).dpi, 300);
        assert.deepEqual(readJpegInfo(makeJpeg({ width: 10, height: 20 })), { width: 10, height: 20, dpi: null });
        await assertAllValid(result.files);
    });

    test('说明书正文的图号引用一律保留纯文本，不生成 figref', async () => {
        const children = [
            h(2, '权利要求书'), p('1. 一种装置，如图1、2所示。'),
            h(2, '说明书'), h(1, '附图说明'),
            p('如图4、5所示，图3、4、5，图4和5，图4与5，图4-6，图4～6，图4至6，图7。'),
            p('图 8 与图9a无关，图6-4为倒序。'),
        ];
        const result = await renderPatent(children);
        assert.equal($of(result.files['claims.xml'])('figref').length, 0);
        const xml = result.files['description.xml'];
        const desc = $of(xml);
        assert.equal(desc('figref').length, 0);
        assert.equal(xml.includes('<figref'), false, 'description.xml 内不出现 figref 元素');
        const first = desc('description > p').first();
        assert.equal(first.text(), '如图4、5所示，图3、4、5，图4和5，图4与5，图4-6，图4～6，图4至6，图7。', '正文原样保留');
        assert.equal(desc('description > p').eq(1).text(), '图 8 与图9a无关，图6-4为倒序。');
        await assertAllValid(result.files);
    });

    test('栅格化产物：role=table → tables 独立成段，role=formula → maths；正文内的图一律 inline="no"、id 前缀 idf、@num 四位补零', async () => {
        const children = [
            h(2, '说明书'), h(1, '技术领域'),
            createParagraph([createText('承压按 '), image('images/omath-2-1.jpg', { role: 'formula', inline: true }), createText(' 计算。')]),
            imgP('images/omath-3-1.jpg', { role: 'formula', inline: false }),
            imgP('images/table-1.jpg', { role: 'table' }),
        ];
        const result = await renderPatent(children, { assets: [asset('images/omath-2-1.jpg'), asset('images/omath-3-1.jpg'), asset('images/table-1.jpg')] });
        const xml = result.files['description.xml'];
        assert.ok(xml.includes('<p id="p0001" num="0001" Italic="0">承压按 <maths id="math0001" num="0001">'
            + '<img id="idf0001" file="omath-2-1.jpg" wi="50" he="25" top="0" left="0" img-content="drawing" img-format="jpg" orientation="portrait" inline="no"/>'
            + '</maths> 计算。</p>'), xml);
        const desc = $of(xml);
        assert.equal(desc('description > p').eq(1).find('maths > img').attr('inline'), 'no', '段内公式官方同样写 inline="no"');
        assert.deepEqual(desc('description > p').eq(1).find('maths').attr(), { id: 'math0002', num: '0002' });
        assert.deepEqual(desc('description > p').eq(2).find('tables').attr(), { id: 'tabl0001', num: '0001' });
        assert.equal(desc('tables > img').attr('file'), 'table-1.jpg');
        assert.deepEqual(desc('img').toArray().map((node) => node.attribs.id), ['idf0001', 'idf0002', 'idf0003'], '正文内的图独立编号');
        assert.deepEqual(result.assets.map((item) => item.name), ['omath-2-1.jpg', 'omath-3-1.jpg', 'table-1.jpg']);
        assert.ok(!codesOf(result).includes(ISSUE_CODES.RASTER_UNAVAILABLE));
        await assertAllValid(result.files);
    });

    test('栅格化未就绪：table 降级为逐行文本、math 降级为线性化文本，并记「栅格化：」warning', async () => {
        const children = [
            h(2, '说明书'), h(1, '技术领域'),
            createTable(null, [createTableRow([createTableCell('试样'), createTableCell('穿刺力')]), createTableRow([createTableCell('A'), createTableCell('12')])]),
            createMath({ text: 'x^2+y^2', display: true }),
            createParagraph([createText('行内'), createMath({ text: 'a+b' }), createText('之后')]),
        ];
        const result = await renderPatent(children);
        const texts = $of(result.files['description.xml'])('description > p').toArray().map((node) => textOf(node));
        assert.deepEqual(texts, ['试样 | 穿刺力', 'A | 12', 'x^2+y^2', '行内a+b之后']);
        const raster = result.issues.filter((issue) => issue.code === ISSUE_CODES.RASTER_UNAVAILABLE);
        assert.equal(raster.length, 3);
        assert.ok(raster.every((issue) => issue.message.startsWith('栅格化：')));
        assert.ok(result.warnings.includes('栅格化：表格未栅格化（栅格化后端不可用或已关闭），已降级为 2 行文本'));
        await assertAllValid(result.files);
    });
});

// ============================================================
// 官方「WORD 转 XML 编辑器」真实产出的逐项对齐
// ============================================================

describe('patent profile：官方产出一致性', () => {
    // 与官方样例同形的稿件：说明书正文含公式与表格，附图 2 幅，另有摘要与摘要附图
    function conformanceDoc({ display = false } = {}) {
        const dims = (wi, he) => (display ? { displayWidthMm: wi, displayHeightMm: he } : {});
        return [
            h(2, '权利要求书'),
            p('1. 一种测试装置，其特征在于，包括壳体。'),
            p('2. 根据权利要求1所述的测试装置，其特征在于，所述壳体为筒状。'),
            h(2, '说明书'),
            h(1, '技术领域'),
            createParagraph([createText('如图1所示，承压按 '), image('images/omath-1.jpg', { role: 'formula', inline: true, ...dims(23.7, 8.9) }), createText(' 计算。')]),
            imgP('images/table-1.jpg', { role: 'table', ...dims(120.9, 60.2) }),
            h(2, '说明书附图'),
            imgP('images/image_1.jpg', dims(146.5, 72.2)), p('图1'),
            imgP('images/image_2.jpg', dims(150.1, 182.6)), p('图2'),
            h(2, '说明书摘要'), p('本发明公开了一种测试装置。'),
            h(2, '摘要附图'), imgP('images/image_3.jpg', dims(146.5, 71.8)),
        ];
    }
    const conformanceAssets = () => [
        asset('images/omath-1.jpg'), asset('images/table-1.jpg'),
        asset('images/image_1.jpg'), asset('images/image_2.jpg', JPG_TALL), asset('images/image_3.jpg'),
    ];

    test('img 的 wi/he 取 IR 的源 Word 显示尺寸并向下取整（第 1、2 项契约）', async () => {
        // Arrange & Act
        const result = await renderPatent(conformanceDoc({ display: true }), { assets: conformanceAssets() });

        // Assert：三个部分各取各自节点上的毫米值，一律截尾而非四舍五入
        assert.deepEqual($of(result.files['drawings.xml'])('img').toArray().map((node) => [node.attribs.wi, node.attribs.he]),
            [['146', '72'], ['150', '182']]);
        assert.deepEqual($of(result.files['abstract-figure.xml'])('img').toArray().map((node) => [node.attribs.wi, node.attribs.he]),
            [['146', '71']]);
        assert.deepEqual($of(result.files['description.xml'])('img').toArray().map((node) => [node.attribs.wi, node.attribs.he]),
            [['23', '8'], ['120', '60']]);
        await assertAllValid(result.files);
    });

    test('显示尺寸缺失时回退为像素 ÷ 密度换算，取整同样向下（非 docx 来源）', async () => {
        // JPG_WIDE 为 600×300 @300dpi：600×25.4/300 = 50.8 → 50；300×25.4/300 = 25.4 → 25
        const result = await renderPatent(conformanceDoc({ display: false }), { assets: conformanceAssets() });
        assert.deepEqual($of(result.files['drawings.xml'])('img').toArray().map((node) => [node.attribs.wi, node.attribs.he]),
            [['50', '25'], ['25', '50']]);
        assert.deepEqual($of(result.files['description.xml'])('img').toArray().map((node) => [node.attribs.wi, node.attribs.he]),
            [['50', '25'], ['50', '25']]);
    });

    test('img/@id 前缀按用途分 if / iaf / idf 三种，各自独立四位编号（第 6 项）', async () => {
        const result = await renderPatent(conformanceDoc({ display: true }), { assets: conformanceAssets() });
        assert.deepEqual($of(result.files['drawings.xml'])('img').toArray().map((node) => node.attribs.id), ['if0001', 'if0002']);
        assert.deepEqual($of(result.files['abstract-figure.xml'])('img').toArray().map((node) => node.attribs.id), ['iaf0001']);
        assert.deepEqual($of(result.files['description.xml'])('img').toArray().map((node) => node.attribs.id), ['idf0001', 'idf0002']);
    });

    test('figure / maths / tables 的 @num 一律四位补零，figure-labels 承载图注（第 3、4、5 项）', async () => {
        const result = await renderPatent(conformanceDoc({ display: true }), { assets: conformanceAssets() });
        const drawings = $of(result.files['drawings.xml']);
        assert.deepEqual(drawings('figure').toArray().map((node) => [node.attribs.num, node.attribs['figure-labels']]),
            [['0001', '图1'], ['0002', '图2']]);
        assert.equal(drawings('cn-drawing-p').length, 0);
        const desc = $of(result.files['description.xml']);
        assert.deepEqual(desc('maths').toArray().map((node) => [node.attribs.id, node.attribs.num]), [['math0001', '0001']]);
        assert.deepEqual(desc('tables').toArray().map((node) => [node.attribs.id, node.attribs.num]), [['tabl0001', '0001']]);
        assert.equal($of(result.files['abstract-figure.xml'])('figure').attr('num'), '0001');
    });

    test('img 的 top/left/orientation/inline 与属性顺序逐字对齐官方（第 7、8、9 项）', async () => {
        const result = await renderPatent(conformanceDoc({ display: true }), { assets: conformanceAssets() });
        assert.ok(result.files['drawings.xml'].includes(
            '<img id="if0001" file="drawing-1.jpg" wi="146" he="72" top="0" left="0" img-content="drawing" img-format="jpg" orientation="portrait" inline="yes"/>'),
        result.files['drawings.xml']);
        assert.ok(result.files['abstract-figure.xml'].includes(
            '<img id="iaf0001" file="drawing-3.jpg" wi="146" he="71" top="0" left="0" img-content="drawing" img-format="jpg" orientation="portrait" inline="yes"/>'),
        result.files['abstract-figure.xml']);
        assert.ok(result.files['description.xml'].includes(
            '<img id="idf0001" file="omath-1.jpg" wi="23" he="8" top="0" left="0" img-content="drawing" img-format="jpg" orientation="portrait" inline="no"/>'),
        result.files['description.xml']);
        // 竖图（150×182）与横图的 orientation 同为 portrait，不再按宽高比判定
        assert.deepEqual($of(result.files['drawings.xml'])('img').toArray().map((node) => node.attribs.orientation), ['portrait', 'portrait']);
    });

    test('claim-ref 与 figref 一律不生成，引用与图号保留为纯文本（第 10、11 项）', async () => {
        const result = await renderPatent(conformanceDoc({ display: true }), { assets: conformanceAssets() });
        for (const name of XML_FILES) {
            assert.equal(result.files[name].includes('<claim-ref'), false, `${name} 不应含 claim-ref`);
            assert.equal(result.files[name].includes('<figref'), false, `${name} 不应含 figref`);
        }
        assert.equal($of(result.files['claims.xml'])('claim').eq(1).find('claim-text').text(),
            '根据权利要求1所述的测试装置，其特征在于，所述壳体为筒状。');
        assert.match($of(result.files['description.xml'])('description > p').first().text(), /^如图1所示，承压按/);
    });

    test('五份产物均带 UTF-8 BOM 且 DOCTYPE 带空内部子集（第 12、13 项）；generic profile 不受影响', async () => {
        const result = await renderPatent(conformanceDoc({ display: true }), { assets: conformanceAssets() });
        for (const name of XML_FILES) {
            assert.deepEqual(Buffer.from(result.files[name], 'utf8').subarray(0, 3), BOM_BYTES, name);
            assert.equal(result.files[name].split('\n')[1],
                '<!DOCTYPE cn-application-body SYSTEM "/dtdandxsl/cn-application-body-20080416.dtd"[]>', name);
        }
        await assertAllValid(result.files);

        const doc = createDocument({ ir: createRoot([h(1, '标题'), p('正文。')]), meta: { title: 'T' }, assets: [] });
        const generic = await xmlRenderer.render(doc, normalizeOptions({ xml: { profile: 'generic' } }));
        const genericXml = generic.files['{name}.xml'];
        assert.equal(genericXml.startsWith('\ufeff'), false, 'generic profile 不加 BOM');
        assert.equal(genericXml.includes('<!DOCTYPE'), false, 'generic profile 不写 DOCTYPE');
    });

    test('附图部分的杂散文字无处安放：丢弃并记「附图：」问题项', async () => {
        const children = [
            h(2, '说明书附图'),
            p('本申请的附图说明如下，仅为示例。'),
            imgP('images/image_1.jpg'), p('图1'),
        ];
        const result = await renderPatent(children, { assets: [asset('images/image_1.jpg')] });
        const drawings = $of(result.files['drawings.xml']);
        assert.deepEqual(drawings('cn-drawings').children().toArray().map((node) => node.name), ['figure']);
        assert.equal(drawings('figure').attr('figure-labels'), '图1');
        assert.ok(codesOf(result).includes(ISSUE_CODES.FIGURE_TEXT_DROPPED));
        assert.ok(result.warnings.includes('附图：附图部分的文字“本申请的附图说明如下，仅为示例。”不是图号段，官方 cn-drawings 只容纳 figure，已丢弃'),
            JSON.stringify(result.warnings));
        await assertAllValid(result.files);
    });
});

// ============================================================
// parts、预检与 precheck.json、zip、落盘
// ============================================================

describe('patent profile：parts、预检、zip 与落盘', () => {
    test('parts 显式子集只输出所列部分，缺节 warning；auto 只输出识别到的部分', async () => {
        const children = [h(2, '权利要求书'), p('1. 一种装置。'), h(2, '说明书'), h(1, '技术领域'), p('正文。')];
        const subset = await renderPatent(children, { options: { xml: { patent: { parts: ['claims', 'drawings'] } } } });
        assert.deepEqual(Object.keys(subset.files).sort(), ['claims.xml', '{name}.zip', 'precheck.json'].sort());
        assert.ok(subset.warnings.includes('分节：已指定输出说明书附图，但文档中未识别到该部分内容'));
        const auto = await renderPatent(children);
        assert.deepEqual(Object.keys(auto.files).sort(), ['claims.xml', 'description.xml', '{name}.zip', 'precheck.json'].sort());
    });

    test('预检各项：OOXML 特征（固定措辞）、字符集、图片格式与密度、公式后标点；precheck.json 形状', async () => {
        const data = {
            ooxml: {
                floatingImages: 2, textBoxes: 1, oleObjects: [{ progId: 'Equation.3' }], autoNumbering: 3,
                revisions: { insertions: 2, deletions: 1, trackRevisions: true }, protection: { enforced: true, type: 'readOnly' },
                comments: 1, fields: 0, eastAsiaFonts: ['宋体', '华文彩云'], headingStyleParagraphs: 5, paragraphs: 20,
            },
        };
        const children = [
            h(2, '说明书'), h(1, '技术领域'), p('含私用区\uE123与控制\x07字符。'),
            createParagraph([createMath({ text: 'a+b，' })]),
        ];
        const assets = [asset('images/image_1.png', PNG, 'image/png'), asset('images/image_2.jpg', makeJpeg({ width: 10, height: 10, dpi: 600 })), asset('images/image_3.jpg', makeJpeg({ width: 10, height: 10 }))];

        const result = await renderPatent(children, { data, assets, meta: { sourcePath: '/abs/源.docx' } });
        const report = result.precheck;

        assert.deepEqual(Object.keys(report), ['profile', 'generatedAt', 'source', 'blocking', 'warnings', 'items', 'validation']);
        assert.deepEqual(report.validation, { requested: false, engine: null, files: [] }, '未请求校验');
        assert.equal(report.profile, 'patent');
        assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(report.source, '/abs/源.docx');
        assert.ok(report.blocking.includes('预检：文档含修订痕迹（插入 2 处、删除 1 处，修订跟踪已开启），请先接受或拒绝全部修订'));
        assert.ok(report.blocking.some((item) => /^预检：文档含 2 个浮动对象/.test(item)));
        assert.ok(report.blocking.some((item) => /^预检：文档含 1 个文本框/.test(item)));
        assert.ok(report.blocking.some((item) => /^预检：文档已启用保护（readOnly）/.test(item)));
        assert.equal(report.blocking.length, 4);
        assert.ok(report.warnings.some((item) => /^预检：文档含 1 个 OLE 对象（Equation\.3）/.test(item)));
        assert.ok(report.warnings.some((item) => /^预检：3 段使用了 Word 自动编号/.test(item)));
        assert.ok(report.warnings.some((item) => /^预检：文档含 1 条批注/.test(item)));
        assert.ok(report.warnings.some((item) => /^预检：文档使用了常规字体之外的中文字体：华文彩云/.test(item)));
        assert.ok(report.warnings.some((item) => /^预检：第 3 段含 GB18030 不支持的字符：U\+E123（私用区）、U\+0007（控制字符）$/.test(item)));
        assert.ok(report.warnings.includes('预检：图片 images/image_1.png 为 png 格式，官方只受理 JPG/TIF'));
        assert.ok(report.warnings.includes('预检：图片 images/image_2.jpg 的密度为 600 DPI，超出官方要求的 72–300 DPI'));
        assert.ok(report.warnings.includes('预检：图片 images/image_3.jpg 未记录密度，尺寸将按 300 DPI 换算'));
        assert.ok(report.warnings.includes('预检：公式“a+b，”的线性化文本以标点结尾，标点应置于公式之外'));
        for (const item of report.items) {
            assert.deepEqual(Object.keys(item).filter((key) => key !== 'location'), ['code', 'level', 'category', 'message']);
            assert.ok(Object.values(ISSUE_CODES).includes(item.code), item.code);
            assert.ok(['blocking', 'warning'].includes(item.level));
            assert.ok(item.message.startsWith(CATEGORIES[item.category]), item.message);
        }
        const codes = report.items.map((item) => item.code);
        for (const code of ['PRECHECK_REVISIONS', 'PRECHECK_FLOATING_OBJECT', 'PRECHECK_TEXTBOX', 'PRECHECK_OLE', 'PRECHECK_AUTO_NUMBERING',
            'PRECHECK_PROTECTION', 'PRECHECK_CHARSET', 'PRECHECK_IMAGE_FORMAT', 'PRECHECK_IMAGE_DPI', 'PRECHECK_FORMULA_PUNCT', 'SECTION_MISSING', 'RASTER_UNAVAILABLE']) {
            assert.ok(codes.includes(code), code);
        }
        assert.deepEqual(result.warnings, [...report.items.map((item) => item.message)]);
        // 非 docx 来源无 ooxml：预检跳过对应项而不报错
        const plain = precheck({ ir: createRoot([p('正文')]), assets: [], data: null }, { profile: 'patent' });
        assert.deepEqual(plain, { blocking: [], warnings: [], items: [] });
        assert.equal(result.precheck.source, '/abs/源.docx');
    });

    test('zip 内条目 = 已输出的 XML + 平铺图片（不含 precheck.json）', async () => {
        const result = await renderPatent(standardDoc(bold), { assets: standardAssets() });
        const zip = await JSZip.loadAsync(result.files['{name}.zip']);
        assert.deepEqual(Object.keys(zip.files).sort(), [...XML_FILES, 'drawing-1.jpg', 'drawing-2.jpg'].sort());
        assert.equal(await zip.file('claims.xml').async('string'), result.files['claims.xml']);
        assert.ok((await zip.file('drawing-1.jpg').async('nodebuffer')).equals(JPG_WIDE));
    });

    test('经调度器落盘：五书、JPG、zip、precheck.json 同目录平铺，无 images/ 子目录', async () => {
        const doc = createDocument({ ir: createRoot(standardDoc(bold)), meta: { title: 'T', sourceType: 'docx' }, assets: standardAssets() });
        const rendered = await renderDocument(doc, 'xml', { xml: { profile: 'patent' } });
        const written = await writeDocument({ rendered, target: 'xml', outputDir: tmpDir, name: '专利' });

        const dir = path.join(tmpDir, '专利');
        assert.deepEqual(fs.readdirSync(dir).sort(), [...XML_FILES, 'drawing-1.jpg', 'drawing-2.jpg', 'precheck.json', '专利.zip'].sort());
        assert.equal(fs.existsSync(path.join(dir, 'images')), false);
        assert.deepEqual(Object.keys(written.outputs).sort(), ['abstract', 'abstractFigure', 'claims', 'description', 'drawings', 'precheck', 'zip'].sort());
        assert.equal(rendered.warnings.length, rendered.warnings.filter((item) => typeof item === 'string').length);
    });

    test('validate 选项：产物经 libxml2-wasm 校验并记入 precheck.json 的 validation；参考夹具五份 valid；校验错误以「DTD 校验：」进 warnings', async () => {
        const result = await renderPatent(standardDoc(bold), { assets: standardAssets(), options: { xml: { validate: true } } });
        assert.ok(!result.warnings.some((item) => item.startsWith('DTD 校验：')), JSON.stringify(result.warnings));
        const { validation } = result.precheck;
        assert.equal(validation.requested, true);
        assert.equal(validation.engine, 'libxml2-wasm');
        assert.deepEqual(validation.files.map((item) => [item.file, item.valid, item.errors.length]), XML_FILES.map((file) => [file, true, 0]));
        assert.match(validation.files.find((item) => item.file === 'drawings.xml').warnings[0], /^第 \d+ 行：Content model of cn-drawings is not determinist/);
        assert.deepEqual(validation.files.find((item) => item.file === 'claims.xml').warnings, []);

        // 校验器不可用：requested=true、engine=null、files=[]，并有 DTD_UNAVAILABLE 项
        const validate = require('../converters/renderers/xml/validate');
        validate._setImporter(async () => { throw new Error("Cannot find module 'libxml2-wasm'"); });
        try {
            const unavailable = await renderPatent(standardDoc(bold), { assets: standardAssets(), options: { xml: { validate: true } } });
            assert.deepEqual(unavailable.precheck.validation, { requested: true, engine: null, files: [] });
            assert.equal(unavailable.issues.filter((issue) => issue.code === ISSUE_CODES.DTD_UNAVAILABLE).length, 1);
        } finally {
            validate._reset();
        }
        for (const name of XML_FILES) {
            const checked = await validateXml(fs.readFileSync(path.join(REFERENCE_DIR, name), 'utf8'));
            if (!checked.available) return;
            assert.equal(checked.valid, true, name);
        }
        // 官方产出不含 claim-ref，悬空 idref 已不可能出现；改以重复 id 构造一份坏文件，确认错误文案进入 warnings 通道
        const { describeValidation } = require('../converters/renderers/xml/validate');
        const bad = await validateXml(result.files['claims.xml'].replace('id="cl002"', 'id="cl001"'));
        const issues = describeValidation('claims.xml', bad);
        assert.equal(issues.length, 1);
        assert.match(issues[0].message, /^DTD 校验：DTD 校验失败（claims\.xml 第 \d+ 行）：ID cl001 already defined/);
    });
});

// ============================================================
// 夹具 docx 端到端（阶段 2a 产出，栅格化关闭以免依赖 Electron）
// ============================================================

describe('patent profile：夹具 docx 端到端', () => {
    const options = { math: 'text', xml: { profile: 'patent', validate: true, patent: { rasterizeTables: false, rasterizeFormulas: false } } };

    test('sample-patent.docx：五书齐备、DTD 通过、段号跳变与降级 warning 分类正确', async () => {
        const res = await convert({ input: { path: path.join(FIXTURES, 'patent', 'sample-patent.docx') }, target: 'xml', outputDir: tmpDir, options });

        assert.equal(res.ok, true);
        assert.deepEqual(Object.keys(res.outputs).sort(), ['abstract', 'abstractFigure', 'claims', 'description', 'drawings', 'precheck', 'zip'].sort());
        assert.deepEqual(res.warnings.filter((item) => item.startsWith('DTD 校验：')), []);
        assert.ok(res.warnings.some((item) => /^段号：第 9 段标为 \[0003\]，预期 \[0009\]/.test(item)), JSON.stringify(res.warnings));
        assert.ok(res.warnings.some((item) => item.startsWith('栅格化：表格未栅格化')));
        assert.ok(res.warnings.some((item) => item.startsWith('栅格化：公式')));
        const report = JSON.parse(fs.readFileSync(res.outputs.precheck, 'utf8'));
        assert.equal(report.source, path.join(FIXTURES, 'patent', 'sample-patent.docx'));
        assert.deepEqual(report.blocking, []);
        const dir = path.dirname(res.outputs.claims);
        assert.equal(fs.existsSync(path.join(dir, 'images')), false);
        assert.ok(fs.readdirSync(dir).some((name) => /^drawing-\d+\.jpg$/.test(name)));
        assert.equal($of(fs.readFileSync(res.outputs.description, 'utf8'))('invention-title').text(), '一种测试装置');
        assert.equal(res.title, '一种测试装置', '结果信封 title 为发明名称');
        assert.equal(report.validation.engine, 'libxml2-wasm');
        assert.ok(report.validation.files.every((item) => item.valid));
    });

    test('sample-patent-notitle.docx：位置推定四书、发明名称回退、权项引用保留纯文本，DTD 通过', async () => {
        const res = await convert({ input: { path: path.join(FIXTURES, 'patent', 'sample-patent-notitle.docx') }, target: 'xml', outputDir: tmpDir, options });

        assert.equal(res.ok, true);
        assert.deepEqual(Object.keys(res.outputs).sort(), ['abstract', 'claims', 'description', 'drawings', 'precheck', 'zip'].sort());
        assert.deepEqual(res.warnings.filter((item) => item.startsWith('DTD 校验：')), []);
        assert.ok(res.warnings.includes('发明名称：未找到发明名称段，已从权利要求 1 推定为“一种液体容器”'));
        assert.ok(!res.warnings.some((item) => item.includes('claim-ref')), '不再产生权项引用问题项');
        assert.ok(res.warnings.some((item) => /^分节：未发现书目标题，按位置推定：说明书摘要=第 1 段；权利要求书=第 \d+–\d+ 段；说明书=第 \d+–\d+ 段；说明书附图=第 \d+ 段起$/.test(item)), JSON.stringify(res.warnings));
        assert.equal(res.title, '一种液体容器');
        const claims = $of(fs.readFileSync(res.outputs.claims, 'utf8'));
        assert.equal(claims('claim').length, 4);
        assert.equal(claims('claim').eq(0).find('claim-text').length, 3);
        assert.equal(claims('claim-ref').length, 0, '官方不生成 claim-ref');
        assert.ok(claims('claim').eq(3).find('claim-text').text().includes('权利要求1-3'));
    });
});
