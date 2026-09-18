/**
 * xml 目标 generic profile 单元测试（converters/renderers/xml.js + xml/generic.js + xml/builder.js）
 * 覆盖：文件头与命名空间、meta 段、块级与行内节点映射、slideBreak/sheetSection 保真、MathML 内嵌与降级、
 *       非法控制字符剔除与实体转义、indent=0 单行输出、well-formed（cheerio xmlMode + libxml2-wasm）、
 *       validate 选项、经调度器 renderDocument 时 images/ 资产照常合并
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('cheerio');

const xmlRenderer = require('../converters/renderers/xml');
const builder = require('../converters/renderers/xml/builder');
const { validateXml } = require('../converters/renderers/xml/validate');
const { normalizeOptions } = require('../converters/options');
const { renderDocument } = require('../converters');
const {
    createDocument, createRoot, createHeading, createParagraph, createText, createMath,
    createTable, createTableRow, createTableCell, createBlockquote, createThematicBreak, createSlideBreak, createSheetSection,
} = require('../converters/ir/schema');

const MATHML = '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mrow><mi>x</mi><mo>=</mo><mn>1</mn></mrow></math>';

function makeDoc(children, extra = {}) {
    return createDocument({ ir: createRoot(children), meta: { title: '样例 & 标题', sourceType: 'md', sourceName: 'a.md' }, ...extra });
}

async function renderXml(children, options = {}, extra = {}) {
    const result = await xmlRenderer.render(makeDoc(children, extra), normalizeOptions({ xml: { profile: 'generic', ...options } }));
    return { ...result, xml: result.files['{name}.xml'] };
}

const $of = (xml) => load(xml, { xmlMode: true });

describe('generic profile', () => {
    test('文件头、命名空间根元素与 meta 段；产物只有 {name}.xml，图片沿用 images/ 引用', async () => {
        // Act
        const { xml, files, assets, warnings, omitDocAssets } = await renderXml(
            [createHeading(1, '标题'), createParagraph([{ type: 'image', url: 'images/image_1.jpg', alt: '图', data: { assetName: 'images/image_1.jpg' } }])],
            {},
            { warnings: ['解析提示'] },
        );

        // Assert
        assert.deepEqual(Object.keys(files), ['{name}.xml']);
        assert.deepEqual(assets, []);
        assert.deepEqual(warnings, []);
        assert.equal(omitDocAssets, false);
        const lines = xml.split('\n');
        assert.equal(lines[0], '<?xml version="1.0" encoding="UTF-8"?>');
        assert.equal(lines[1], '<document xmlns="urn:markflow:document:1" version="1">');
        const $ = $of(xml);
        assert.equal($('meta > title').text(), '样例 & 标题');
        assert.equal($('meta > source').text(), 'a.md');
        assert.equal($('meta > sourceType').text(), 'md');
        assert.match($('meta > convertedAt').text(), /^\d{4}-\d{2}-\d{2}T/);
        assert.equal($('meta > warning').text(), '解析提示');
        assert.equal($('body > figure > image').attr('src'), 'images/image_1.jpg');
        assert.equal($('body > figure > image').attr('alt'), '图');
        assert.ok(xml.includes('<title>样例 &amp; 标题</title>'), '文本须实体转义');
    });

    test('块级与行内节点逐一映射（方案 §3.4.2 generic）', async () => {
        // Arrange
        const children = [
            createHeading(2, '二级'),
            createParagraph([
                createText('正文 '), { type: 'strong', children: [createText('粗')] }, { type: 'emphasis', children: [createText('斜')] },
                { type: 'delete', children: [createText('删')] }, { type: 'inlineCode', value: 'code' },
                { type: 'link', url: 'https://example.com', children: [createText('链')] }, { type: 'break' }, createText('换行后'),
            ]),
            { type: 'list', ordered: true, start: 3, children: [
                { type: 'listItem', checked: true, children: [createParagraph('已做')] },
                { type: 'listItem', children: [createParagraph('未标')] },
            ] },
            createTable(['left', null], [createTableRow([createTableCell('甲'), createTableCell('乙')]), createTableRow([createTableCell('1'), createTableCell('2')])]),
            { type: 'code', lang: 'js', value: 'if (a < b) {}' },
            createBlockquote([createParagraph('引')]),
            createThematicBreak(),
            createSlideBreak({ title: '第二页', index: 1 }),
            createSheetSection({ name: '表一', index: 0 }),
        ];

        // Act
        const { xml } = await renderXml(children);
        const $ = $of(xml);

        // Assert
        assert.equal($('body > heading').attr('level'), '2');
        const p = $('body > p').first();
        assert.equal(p.find('b').text(), '粗');
        assert.equal(p.find('i').text(), '斜');
        assert.equal(p.find('s').text(), '删');
        assert.equal(p.find('code').text(), 'code');
        assert.equal(p.find('a').attr('href'), 'https://example.com');
        assert.equal(p.find('br').length, 1);
        assert.ok(xml.includes('<p>正文 <b>粗</b><i>斜</i><s>删</s><code>code</code><a href="https://example.com">链</a><br/>换行后</p>'), '混合内容须单行输出');
        const list = $('body > list');
        assert.equal(list.attr('ordered'), 'true');
        assert.equal(list.attr('start'), '3');
        assert.equal(list.find('item').first().attr('checked'), 'true');
        assert.equal(list.find('item').eq(1).attr('checked'), undefined);
        assert.equal($('table > row').first().attr('header'), 'true');
        assert.equal($('table > row').eq(1).attr('header'), undefined);
        assert.equal($('table > row > cell').first().attr('align'), 'left');
        assert.equal($('table > row > cell').eq(1).attr('align'), undefined);
        assert.equal($('body > code').attr('lang'), 'js');
        assert.equal($('body > code').text(), 'if (a < b) {}');
        assert.equal($('body > quote > p').text(), '引');
        assert.equal($('body > hr').length, 1);
        const breaks = $('body > section-break');
        assert.equal(breaks.length, 2);
        assert.deepEqual([breaks.eq(0).attr('kind'), breaks.eq(0).attr('index'), breaks.eq(0).attr('title')], ['slide', '1', '第二页']);
        assert.deepEqual([breaks.eq(1).attr('kind'), breaks.eq(1).attr('index'), breaks.eq(1).attr('title')], ['sheet', '0', '表一']);
    });

    test('underline / superscript / subscript 映射为 u / sup / sub，可嵌套', async () => {
        // Arrange
        const children = [createParagraph([
            createText('C'), { type: 'subscript', children: [createText('1')] },
            createText('~C'), { type: 'subscript', children: [createText('30')] },
            createText('，R'), { type: 'superscript', children: [createText('2')] },
            createText('，'), { type: 'underline', children: [{ type: 'superscript', children: [createText('注')] }] },
        ])];

        // Act
        const { xml } = await renderXml(children);
        const $ = $of(xml);

        // Assert
        assert.deepEqual($('p > sub').toArray().map((n) => $(n).text()), ['1', '30']);
        assert.deepEqual($('p > sup').toArray().map((n) => $(n).text()), ['2']);
        assert.equal($('p > u > sup').text(), '注');
        assert.ok(xml.includes('<p>C<sub>1</sub>~C<sub>30</sub>，R<sup>2</sup>，<u><sup>注</sup></u></p>'), xml);
    });

    test('math 节点内嵌 MathML（重建后 well-formed，display 合并到 math 根），MathML 缺失或损坏时降级为线性化文本', async () => {
        const children = [
            createParagraph([createText('见 '), createMath({ mathml: MATHML, text: 'x=1', display: false })]),
            createMath({ mathml: MATHML, text: 'x=1', display: true }),
            createParagraph([createMath({ mathml: '<mrow><mi>y</mi>', text: 'y', display: false })]),
            createParagraph([createMath({ text: 'a+b', display: false })]),
        ];

        const { xml } = await renderXml(children);
        const $ = $of(xml);

        const maths = $('math');
        assert.equal(maths.length, 4);
        assert.equal(maths.eq(0).attr('display'), 'false');
        assert.equal(maths.eq(0).attr('xmlns'), 'http://www.w3.org/1998/Math/MathML');
        assert.equal(maths.eq(0).find('mi').text(), 'x');
        assert.equal(maths.eq(1).attr('display'), 'true');
        assert.equal(maths.eq(1).find('mrow > mn').text(), '1');
        assert.equal($('body > p').eq(1).find('math').length, 1, '块级公式独立成段');
        assert.equal(maths.eq(2).text(), 'y');
        assert.equal(maths.eq(2).children().length, 0);
        assert.equal(maths.eq(3).text(), 'a+b');
    });

    test('非法控制字符被剔除、保留 TAB/LF，属性与文本实体转义；indent=0 整份单行', async () => {
        const children = [
            createParagraph([createText('前\x00中\x07后\x1F\uFFFE末\t制表 < & >')]),
            { type: 'paragraph', children: [{ type: 'link', url: 'https://x.y/?a=1&b="2"<', children: [createText('链')] }] },
        ];

        const { xml } = await renderXml(children);
        const compact = (await renderXml(children, { indent: 0 })).xml;

        assert.ok(xml.includes('<p>前中后末\t制表 &lt; &amp; &gt;</p>'), xml);
        assert.ok(xml.includes('href="https://x.y/?a=1&amp;b=&quot;2&quot;&lt;"'), xml);
        assert.equal(builder.cleanText('a\x00b\uD800c'), 'abc');
        assert.deepEqual(compact.split('\n').map((line) => line.slice(0, 5)), ['<?xml', '<docu', ''], 'indent=0 时声明一行、文档一行、末尾换行');
        assert.ok(compact.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<document xmlns="urn:markflow:document:1" version="1"><meta>'));
    });

    test('产物 well-formed：cheerio xmlMode 可解析且 libxml2-wasm 检查通过；validate 选项下 warnings 为空', async () => {
        const children = [createHeading(1, '标题'), createParagraph('正文 <b> & 文'), createSlideBreak({ title: '页', index: 2 })];

        const { xml, warnings } = await renderXml(children, { validate: true });

        assert.deepEqual(warnings, []);
        assert.equal($of(xml)('body').children().length, 3);
        const checked = await validateXml(xml, { requireDtd: false });
        if (checked.available) assert.equal(checked.valid, true, JSON.stringify(checked.errors));
    });

    test('经调度器 renderDocument：generic 不省略 doc.assets，图片仍走 images/ 落盘；未知 profile 拒绝', async () => {
        const doc = makeDoc([createParagraph('x')], { assets: [{ name: 'images/image_1.jpg', buffer: Buffer.from('ffd8', 'hex'), mime: 'image/jpeg' }] });

        const rendered = await renderDocument(doc, 'xml');

        assert.deepEqual(Object.keys(rendered.files), ['{name}.xml']);
        assert.deepEqual(rendered.assets.map((asset) => asset.name), ['images/image_1.jpg']);
        assert.deepEqual(rendered.warnings, []);
        await assert.rejects(xmlRenderer.render(doc, { xml: { profile: 'cnipa' } }), /选项 xml\.profile 须为 generic \| patent 之一/);
        await assert.rejects(xmlRenderer.render(null), /xml 渲染器需要 doc 对象/);
    });
});

describe('builder', () => {
    test('容器缩进换行、混合内容单行、空元素自闭合、非法元素名拒绝', () => {
        const { el, serialize, serializeDocument } = builder;
        const root = el('r', { a: '1' }, [el('p', {}, ['文', el('b', {}, ['粗']), el('br'), '尾']), el('e')]);
        assert.equal(serialize(root), '<r a="1">\n  <p>文<b>粗</b><br/>尾</p>\n  <e/>\n</r>');
        assert.equal(serialize(root, { indent: 0 }), '<r a="1"><p>文<b>粗</b><br/>尾</p><e/></r>');
        assert.equal(
            serializeDocument({ root: el('a'), doctype: { name: 'a', systemId: '/x/a.dtd' }, instructions: [{ target: 'xml-stylesheet', data: 'href="s.xsl"' }] }),
            '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE a SYSTEM "/x/a.dtd">\n<?xml-stylesheet href="s.xsl"?>\n<a/>\n',
        );
        assert.throws(() => el('bad name'), /XML 元素名非法/);
        assert.throws(() => el('a', { 'x y': '1' }), /XML 属性名非法/);
        assert.equal(builder.textOf(root), '文粗尾');
    });
});
