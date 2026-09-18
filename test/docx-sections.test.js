/**
 * converters/parsers/docx-sections.js 单元测试与 parsers/docx 的接线测试
 * 覆盖：多分节 + 页眉读取（官方五书模板形态：w:sectPr 落在空壳段、纯图片段、空段、内容段上）；哨兵段的插入位置；
 *       w:headerReference 缺省时沿用上一节；first / even 页眉仅在 w:titlePg / w:evenAndOddHeaders 开启时生效；
 *       页眉多段以换行连接；w:sectPrChange 里的旧 w:sectPr 不计为一节；单节文档与页眉全空的文档原样返回；
 *       分节首块为空段、纯图片段、列表项、表格时不串节，跨节列表拆成两个列表；applySections 的消去、盖章、
 *       嵌套哨兵清理与不改入参；parse 全链路不留哨兵残留；分节读取失败只记 warning、不阻断解析。
 * 夹具一律由 test/fixtures/patent/build-official-template-docx.js 现造，正文为虚构示例。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const {
    Paragraph, Table, TableRow, TableCell, LevelFormat, AlignmentType,
} = require('docx');

const { markSections, applySections } = require('../converters/parsers/docx-sections');
const { parse } = require('../converters/parsers/docx');
const mdRenderer = require('../converters/renderers/md');
const { collectText } = require('../converters/ir/util');
const {
    buildSectionedDocx, buildOfficialTemplateDocx, OFFICIAL_EXPECTED, text, empty, picture,
} = require('./fixtures/patent/build-official-template-docx');

const DOCUMENT_PART = 'word/document.xml';
const SENTINEL_TOKEN = 'MFSECT';
const sentinel = (index) => `⟦${SENTINEL_TOKEN}:${index}⟧`;
const sentinelParagraph = (index) => `<w:p><w:r><w:t xml:space="preserve">${sentinel(index)}</w:t></w:r></w:p>`;
const NUMBERING = {
    config: [{ reference: 'steps', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START }] }],
};
const listItem = (value) => new Paragraph({ text: value, numbering: { reference: 'steps', level: 0 } });
const table1x1 = (value) => new Table({ rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph(value)] })] })] });

const documentXml = async (buffer) => (await JSZip.loadAsync(buffer)).file(DOCUMENT_PART).async('string');
const sectionIndexOf = (node) => (node.data && node.data.section ? node.data.section.index : null);
const headersOf = (sections) => sections.map((section) => section.header);

// 顶层节点按分节序号分组：Map<index, node[]>
function groupBySection(ir) {
    const groups = new Map();
    for (const node of ir.children) {
        const index = sectionIndexOf(node);
        groups.set(index, [...(groups.get(index) || []), node]);
    }
    return groups;
}

// ============================================================
// markSections
// ============================================================

describe('markSections：分节与页眉', () => {
    test('官方五书模板形态：五节页眉依次读出，每节起点插入一个哨兵段', async () => {
        const source = await buildOfficialTemplateDocx();

        const { buffer, sections } = await markSections(source);

        assert.deepEqual(sections, OFFICIAL_EXPECTED.headers.map((header, order) => ({ index: order + 1, header })));
        assert.notEqual(buffer, source, '有分节信息时返回改写后的新 buffer');
        const xml = await documentXml(buffer);
        assert.equal(xml.split(SENTINEL_TOKEN).length - 1, 5, '哨兵段恰为分节数');
        assert.match(xml, new RegExp(`<w:body>${sentinelParagraph(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '首节哨兵紧跟 w:body 开标签');
        // 其余哨兵紧跟在带 w:sectPr 的段落之后（w:sectPr 在该段的 w:pPr 内）
        for (const index of [2, 3, 4, 5]) {
            const at = xml.indexOf(sentinelParagraph(index));
            const before = xml.slice(0, at);
            const lastParagraph = before.slice(before.lastIndexOf('<w:p>'));
            assert.ok(before.endsWith('</w:p>'), `第 ${index} 节哨兵位于段落之后`);
            assert.ok(lastParagraph.includes('<w:sectPr>'), `第 ${index} 节哨兵之前的段落带分节符`);
        }
        assert.equal((await documentXml(source)).includes(SENTINEL_TOKEN), false, '不改动入参');
    });

    test('w:headerReference 缺省时沿用上一节的页眉', async () => {
        const source = await buildSectionedDocx([
            { header: '权利要求书', children: [text('甲一')] },
            { children: [text('乙一')] },
            { header: '说明书', children: [text('丙一')] },
            { children: [text('丁一')] },
        ]);

        const { sections } = await markSections(source);

        assert.deepEqual(headersOf(sections), ['权利要求书', '权利要求书', '说明书', '说明书']);
    });

    test('first 页眉仅在 w:titlePg 开启时生效，even 页眉仅在 w:evenAndOddHeaders 开启时生效；default 有文字时优先', async () => {
        const build = (options) => buildSectionedDocx([
            { header: '', firstHeader: '说明书摘要', titlePage: true, children: [text('甲一')] },
            { header: '', firstHeader: '权利要求书', children: [text('乙一')] },
            { header: '', evenHeader: '说明书', children: [text('丙一')] },
            { header: '说明书附图', firstHeader: '封面', evenHeader: '偶数页', titlePage: true, children: [text('丁一')] },
        ], options);

        const plain = await markSections(await build({ evenAndOdd: false }));
        const evenOdd = await markSections(await build({ evenAndOdd: true }));

        // 第 2 节未开 titlePg：自己声明的 first 页眉不生效，default 又是空的 → 无文字
        assert.deepEqual(headersOf(plain.sections), ['说明书摘要', '', '', '说明书附图']);
        assert.deepEqual(headersOf(evenOdd.sections), ['说明书摘要', '', '说明书', '说明书附图']);
    });

    test('页眉内多个段落以换行连接，段内空白折叠；w:sectPrChange 里的旧 w:sectPr 不计为一节、其旧属性不参与判定', async () => {
        const source = await buildSectionedDocx([
            { header: ['案号 AB-001', '权　 利　 要　 求　 书 '], children: [text('甲一')] },
            { header: '', firstHeader: '封面页眉', children: [text('乙一')] },
            { header: '说明书', children: [text('丙一')] },
        ]);
        const zip = await JSZip.loadAsync(source);
        const xml = await zip.file(DOCUMENT_PART).async('string');
        // 三节的 w:sectPr 各塞进一份修订前的旧属性：旧属性里开着 w:titlePg，现行属性里没有
        const revised = xml.replaceAll('<w:sectPr>', '<w:sectPr><w:sectPrChange w:id="9" w:author="x"><w:sectPr><w:titlePg/></w:sectPr></w:sectPrChange>');
        assert.equal(revised.split('<w:sectPrChange').length - 1, 3);
        zip.file(DOCUMENT_PART, revised);

        const { sections } = await markSections(await zip.generateAsync({ type: 'nodebuffer' }));

        assert.deepEqual(sections, [
            { index: 1, header: '案号 AB-001\n权 利 要 求 书' },
            { index: 2, header: '' },
            { index: 3, header: '说明书' },
        ]);
    });

    test('带分节符的段落内嵌文本框段落时，哨兵段落在外层段落之后；框内的 w:sectPr、自闭合的 w:pPr 与 w:pPrChange 不干扰判断', async () => {
        const source = await buildSectionedDocx([
            { header: '权利要求书', children: [text('甲一')] },
            { header: '说明书', children: [text('乙一')] },
        ]);
        const zip = await JSZip.loadAsync(source);
        const xml = await zip.file(DOCUMENT_PART).async('string');
        // 文本框里的段落自带一个不合规范的 w:sectPr：落在上一节末段之内，不计为一节
        const textbox = '<w:r><w:pict><v:textbox><w:txbxContent><w:p><w:pPr><w:sectPr><w:pgSz w:w="1" w:h="1"/></w:sectPr></w:pPr>'
            + '<w:r><w:t>框内文字</w:t></w:r></w:p></w:txbxContent></v:textbox></w:pict></w:r>';
        const tracked = '<w:pPrChange w:id="8" w:author="x"><w:pPr><w:jc w:val="left"/></w:pPr></w:pPrChange>';
        // 第 1 节末段：w:sectPr 之后跟 w:pPrChange，段内再嵌一个文本框段落；文末段落带自闭合的 w:pPr
        const crafted = xml
            .replace('</w:sectPr></w:pPr>', `</w:sectPr>${tracked}</w:pPr>`)
            .replace('甲一</w:t></w:r>', `甲一</w:t></w:r>${textbox}`)
            .replace('<w:p><w:r><w:t xml:space="preserve">乙一', '<w:p><w:pPr/><w:r><w:t xml:space="preserve">乙一');
        assert.ok(crafted.includes(tracked) && crafted.includes(textbox) && crafted.includes('<w:p><w:pPr/><w:r>'), '夹具改写生效');
        zip.file(DOCUMENT_PART, crafted);

        const { buffer, sections } = await markSections(await zip.generateAsync({ type: 'nodebuffer' }));

        assert.deepEqual(headersOf(sections), ['权利要求书', '说明书']);
        const marked = await documentXml(buffer);
        assert.ok(marked.includes(`${textbox}</w:p>${sentinelParagraph(2)}`), '第 2 节哨兵紧跟外层段落的结束标签');
        assert.equal(marked.split(SENTINEL_TOKEN).length - 1, 2);
    });

    test('单节文档、页眉全空的多节文档、非 docx 结构：原样返回入参 buffer 且 sections 为空', async () => {
        const single = await buildSectionedDocx([{ header: '权利要求书', children: [text('甲一')] }]);
        const blank = await buildSectionedDocx([{ header: '', children: [text('甲一')] }, { children: [text('乙一')] }]);
        const zip = new JSZip();
        zip.file('other.txt', 'x');
        const noDocument = await zip.generateAsync({ type: 'nodebuffer' });

        for (const source of [single, blank, noDocument]) {
            const result = await markSections(source);
            assert.equal(result.buffer, source, '同一引用');
            assert.deepEqual(result.sections, []);
        }
    });
});

// ============================================================
// applySections
// ============================================================

describe('applySections：哨兵段 → data.section', () => {
    const paragraph = (value, data) => ({ type: 'paragraph', children: [{ type: 'text', value }], ...(data ? { data } : {}) });
    const SECTIONS = Object.freeze([Object.freeze({ index: 1, header: '权利要求书' }), Object.freeze({ index: 2, header: '' })]);

    test('消去哨兵段，其后的顶层节点盖章；已有 data 保留；不改动入参', () => {
        const ir = {
            type: 'root',
            children: [
                paragraph('哨兵之前'),
                paragraph(sentinel(1)),
                paragraph('甲', { indent: 2 }),
                { type: 'table', children: [{ type: 'tableRow', children: [{ type: 'tableCell', children: [{ type: 'text', value: '格' }] }] }] },
                paragraph(` ${sentinel(2)} `),
                { type: 'list', ordered: true, children: [{ type: 'listItem', children: [paragraph('项')] }] },
            ],
        };
        const snapshot = JSON.stringify(ir);

        const out = applySections(ir, SECTIONS);

        assert.equal(JSON.stringify(ir), snapshot, '入参未被改动');
        assert.deepEqual(out.children.map((node) => node.type), ['paragraph', 'paragraph', 'table', 'list']);
        assert.equal(out.children[0].data, undefined, '首个哨兵之前的节点不盖章');
        assert.deepEqual(out.children[1].data, { indent: 2, section: { index: 1, header: '权利要求书' } });
        assert.deepEqual(out.children[2].data, { section: { index: 1, header: '权利要求书' } });
        assert.deepEqual(out.children[3].data, { section: { index: 2, header: '' } });
        assert.equal(JSON.stringify(out).includes(SENTINEL_TOKEN), false);
    });

    test('sections 为空时原样返回同一引用；序号不在表内的哨兵照样消去但不盖章；嵌套位置的哨兵一并清理', () => {
        const ir = { type: 'root', children: [paragraph(sentinel(1)), paragraph('甲')] };
        assert.equal(applySections(ir, []), ir);
        assert.equal(applySections(ir, null), ir);

        const unknown = applySections({ type: 'root', children: [paragraph(sentinel(7)), paragraph('甲')] }, SECTIONS);
        assert.deepEqual(unknown.children, [paragraph('甲')]);

        const nested = applySections({
            type: 'root',
            children: [paragraph(sentinel(1)), { type: 'blockquote', children: [paragraph(sentinel(2)), paragraph('引文')] }],
        }, SECTIONS);
        assert.deepEqual(nested.children, [{ type: 'blockquote', children: [paragraph('引文')], data: { section: { index: 1, header: '权利要求书' } } }]);
    });
});

// ============================================================
// parsers/docx 接线
// ============================================================

describe('parsers/docx：data.section 契约', () => {
    test('官方五书模板形态：每个顶层节点带 data.section，w:sectPr 所在的空壳段、纯图片段不串节，全链路无哨兵残留', async () => {
        const doc = await parse({ buffer: await buildOfficialTemplateDocx() }, { sourceName: '样稿.docx' });

        assert.ok(doc.ir.children.every((node) => sectionIndexOf(node) !== null), '顶层节点全部带分节信息');
        const groups = groupBySection(doc.ir);
        assert.deepEqual([...groups.keys()], [1, 2, 3, 4, 5]);
        OFFICIAL_EXPECTED.headers.forEach((header, order) => {
            assert.ok(groups.get(order + 1).every((node) => node.data.section.header === header), `第 ${order + 1} 节页眉`);
        });
        // 第 1 节：摘要段 + 只含「段落起始」码位的空壳段（w:sectPr 在其上）；第 2 节：纯图片段（w:sectPr 在其上）
        assert.equal(groups.get(1).length, 2);
        assert.ok(collectText(groups.get(1)[0]).includes(OFFICIAL_EXPECTED.abstract));
        assert.deepEqual(groups.get(2).map((node) => node.children.map((child) => child.type)), [['image']]);
        assert.equal(groups.get(3).length, 4, '权利要求书 4 段（空段被 mammoth 丢弃）');
        assert.equal(groups.get(4).length, 15);
        assert.ok(collectText(groups.get(4)[14]).includes(OFFICIAL_EXPECTED.paragraphs[8]), 'w:sectPr 所在的内容段仍属本节');
        assert.deepEqual(groups.get(5).map((node) => (node.children[0].type === 'image' ? 'image' : collectText(node).replace(/[^图\d]/g, ''))), ['image', '图1', 'image', '图2']);

        assert.equal(JSON.stringify(doc.ir).includes(SENTINEL_TOKEN), false, 'IR 无哨兵残留');
        const md = await mdRenderer.render(doc, { math: 'text' });
        assert.equal(JSON.stringify(md).includes(SENTINEL_TOKEN), false, 'Markdown 产物无哨兵残留');
        assert.deepEqual(doc.warnings.filter((item) => item.includes('分节')), []);
    });

    test('分节首块为空段、纯图片段、列表项、表格时不串节；跨节列表拆成两个列表', async () => {
        const source = await buildSectionedDocx([
            { header: '甲节', children: [text('甲一'), listItem('甲列一'), listItem('甲列二')] },
            { header: '乙节', children: [listItem('乙列一'), text('乙一')] },
            { header: '丙节', children: [empty(), text('丙一')] },
            { header: '丁节', children: [picture(), text('丁一')] },
            { header: '戊节', children: [table1x1('戊格'), text('戊一')] },
        ], { numbering: NUMBERING });

        const doc = await parse({ buffer: source }, { sourceName: '分节.docx' });

        const summary = doc.ir.children.map((node) => [sectionIndexOf(node), node.type, collectText(node).replace(/\s+/g, '')]);
        assert.deepEqual(summary, [
            [1, 'paragraph', '甲一'], [1, 'list', '甲列一甲列二'],
            [2, 'list', '乙列一'], [2, 'paragraph', '乙一'],
            [3, 'paragraph', '丙一'],
            [4, 'paragraph', ''], [4, 'paragraph', '丁一'],
            [5, 'table', '戊格'], [5, 'paragraph', '戊一'],
        ]);
        assert.equal(doc.ir.children[5].children[0].type, 'image', '第 4 节首块是纯图片段');
    });

    test('无分节信息的文档：不写 data.section（单节带页眉、多节但页眉全空）', async () => {
        const single = await parse({ buffer: await buildSectionedDocx([{ header: '权利要求书', children: [text('甲一'), picture()] }]) });
        const blank = await parse({ buffer: await buildSectionedDocx([{ header: '', children: [text('甲一')] }, { children: [text('乙一')] }]) });

        for (const doc of [single, blank]) {
            assert.ok(doc.ir.children.length > 0);
            assert.ok(doc.ir.children.every((node) => !(node.data && 'section' in node.data)));
        }
    });

    test('分节读取失败只记 warning，不阻断解析，IR 不带 data.section', async () => {
        const sectionsPath = require.resolve('../converters/parsers/docx-sections');
        const docxPath = require.resolve('../converters/parsers/docx');
        const real = require.cache[sectionsPath].exports;
        const cachedDocx = require.cache[docxPath];
        require.cache[sectionsPath].exports = { ...real, markSections: async () => { throw new Error('模拟失败'); } };
        delete require.cache[docxPath];
        try {
            const { parse: parseWithBrokenSections } = require(docxPath);

            const doc = await parseWithBrokenSections({ buffer: await buildOfficialTemplateDocx() });

            assert.ok(doc.warnings.includes('分节与页眉读取失败，已按无分节处理（模拟失败）'), JSON.stringify(doc.warnings));
            assert.ok(doc.ir.children.length > 0);
            assert.ok(doc.ir.children.every((node) => !(node.data && 'section' in node.data)));
        } finally {
            require.cache[sectionsPath].exports = real;
            require.cache[docxPath] = cachedDocx;
        }
    });
});
