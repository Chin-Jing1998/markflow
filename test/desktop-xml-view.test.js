/**
 * desktop/main/xml-view.js 单元测试（纯逻辑，不依赖 Electron）
 * 覆盖：扫描器（声明 / DOCTYPE 内部子集 / PI / 注释 / CDATA / 实体 / 自闭合）与不合法输入的中文错误；
 *       美化原文（混合内容不被缩进破坏、属性转义）；
 *       patent 结构视图（段号红色粗体、权项分条与 claim-ref、img 按 wi/he 毫米定尺寸、行内与独立公式表格）；
 *       generic 结构视图（meta、标题层级、列表、表格、代码、图片、外链 noopener）；
 *       test/fixtures/patent/reference/*.xml 五份官方风格样例全部可解析且识别为 patent；
 *       非本应用 XML 只给美化原文；畸形 XML 返回错误文案而不抛出；
 *       图片地址越界 / 非白名单扩展名 / 缺 assetBase 时只留替代文字。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildXmlView, parseXml, formatXml, detectProfile, PROFILES } = require('../desktop/main/xml-view');

const REFERENCE_DIR = path.join(__dirname, 'fixtures', 'patent', 'reference');
const ASSET_BASE = 'mf-asset://0123456789abcdef0123456789abcdef/';

const PATENT_DESCRIPTION = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE cn-application-body SYSTEM "/dtdandxsl/cn-application-body-20080416.dtd">',
    '<?xml-stylesheet type="text/xsl" href="/dtdandxsl/showxml.xsl"?>',
    '<cn-application-body lang="zh" country="CN">',
    '  <description>',
    '    <invention-title>一种测试装置</invention-title>',
    '    <heading id="h0001" level="2">技术领域</heading>',
    '    <p id="p0001" num="0001" Italic="0">本发明涉及<b>测试</b>领域，第<sub>i</sub>项。</p>',
    '    <p id="p0002" num="0002" Italic="1">整段斜体。<br/>换行后。</p>',
    '    <p id="p0003" num="0003" Italic="0">公式：<maths id="m0001" num="1"><img id="i0001" he="9" wi="46" file="omath-3-1.jpg" img-format="jpg" img-content="drawing" inline="yes"/></maths>。</p>',
    '    <p id="p0004" num="0004" Italic="0">表：<tables id="t0001" num="1"><img id="i0002" he="38" wi="120" file="table-1.jpg" img-format="jpg" img-content="drawing" inline="no"/></tables></p>',
    '    <p id="p0005" num="0005" Italic="0"><figref num="1">图1</figref>为流程图。</p>',
    '    <p id="l0001" num="XXXX" Italic="0">图中：1、外壳。</p>',
    '  </description>',
    '</cn-application-body>',
].join('\n');

const PATENT_CLAIMS = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<cn-application-body lang="zh" country="CN">',
    '  <cn-claims>',
    '    <claim id="cl001" num="1"><claim-text>一种测试装置，其特征在于包括外壳。</claim-text></claim>',
    '    <claim id="cl002" num="2"><claim-text>根据<claim-ref idref="cl001">权利要求1</claim-ref>所述的装置，其特征在于还包括盖板。</claim-text></claim>',
    '  </cn-claims>',
    '</cn-application-body>',
].join('\n');

const GENERIC = [
    '<?xml version="1.0"?>',
    '<document xmlns="urn:markflow:document:1" version="1">',
    '  <meta><title>通用样例</title><sourceType>docx</sourceType></meta>',
    '  <body>',
    '    <heading level="2">小标题</heading>',
    '    <p>正文<b>加粗</b>与<a href="https://example.com/">外链</a>与<a href="javascript:alert(1)">坏链</a>。</p>',
    '    <list ordered="true" start="3"><item><p>第一项</p></item><item><p>第二项</p></item></list>',
    '    <table><row header="true"><cell align="center">列头</cell></row><row><cell>数据</cell></row></table>',
    '    <code lang="js">const a = 1 &lt; 2;</code>',
    '    <quote><p>引文</p></quote>',
    '    <figure><image src="images/image_1.jpg" alt="插图"/></figure>',
    '    <hr/>',
    '    <section-break kind="slide" index="2" title="第 2 页"/>',
    '  </body>',
    '</document>',
].join('\n');

// ============================================================
// 扫描器
// ============================================================

test('扫描器：声明 / DOCTYPE 内部子集 / PI / 注释 / CDATA / 实体 / 自闭合', () => {
    const src = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE root [ <!ENTITY x "y"> ]>',
        '<?pi data?>',
        '<!-- 注释 -->',
        '<root a="1&amp;2" b=\'单引号\'><child/><t>文本 &lt;标签&gt; &#65;&#x42;</t><![CDATA[<原样>]]></root>',
    ].join('\n');
    const parsed = parseXml(src);
    assert.equal(parsed.ok, true, parsed.error);
    assert.deepEqual(parsed.prolog.map((item) => item.kind), ['declaration', 'doctype', 'instruction']);
    assert.equal(parsed.root.name, 'root');
    assert.equal(parsed.root.attrs.a, '1&2');
    assert.equal(parsed.root.attrs.b, '单引号');
    const textNode = parsed.root.children.find((child) => child.type === 'element' && child.name === 't');
    assert.equal(textNode.children[0].value, '文本 <标签> AB');
    assert.ok(parsed.root.children.some((child) => child.type === 'text' && child.value === '<原样>'), 'CDATA 内容应原样进文本');
});

test('扫描器：不合法输入一律返回中文错误而不抛出', () => {
    const cases = [
        ['<a><b></a>', /不匹配/],
        ['<a>', /没有对应的结束标记/],
        ['随便一段文字', /文本/],
        ['<a/><b/>', /第二个根元素/],
        ['<a x=1/>', /引号括起/],
        ['<a><!-- 没闭合', /注释没有结束标记/],
        ['', /没有找到根元素/],
    ];
    for (const [src, pattern] of cases) {
        const parsed = parseXml(src);
        assert.equal(parsed.ok, false, `应判为不合法：${src}`);
        assert.match(parsed.error, pattern);
    }
    assert.equal(parseXml(null).ok, false);
});

test('美化原文：混合内容整体排一行，属性转义，非法输入原样回吐', () => {
    const { xml, ok } = formatXml('<r><p id="1">前<b>粗</b>后</p><e/><n><m/></n></r>', { indent: 2 });
    assert.equal(ok, true);
    assert.equal(xml, [
        '<r>',
        '  <p id="1">前<b>粗</b>后</p>',
        '  <e/>',
        '  <n>',
        '    <m/>',
        '  </n>',
        '</r>',
        '',
    ].join('\n'));
    const bad = formatXml('<a><b></a>');
    assert.equal(bad.ok, false);
    assert.equal(bad.xml, '<a><b></a>');
    assert.match(bad.error, /不匹配/);
    assert.equal(formatXml('<r a="&quot;引&quot;&amp;"/>').xml.trim(), '<r a="&quot;引&quot;&amp;"/>');
});

// ============================================================
// patent 结构视图
// ============================================================

test('patent 结构视图：段号红色粗体、斜体段、行内公式与独立表格、图号引用', () => {
    const view = buildXmlView(PATENT_DESCRIPTION, { assetBase: ASSET_BASE });
    assert.equal(view.kind, 'xml');
    assert.equal(view.profile, PROFILES.patent);
    assert.equal(view.error, null);
    assert.deepEqual(view.warnings, []);
    const html = view.structuredHtml;

    assert.ok(html.includes('<h2 class="invention-title">一种测试装置</h2>'), '发明名称未渲染');
    assert.ok(html.includes('<h3 class="heading">技术领域</h3>'), '分节标题未渲染');
    assert.ok(html.includes('<span class="pnum">[0001]</span>'), '段号未渲染');
    assert.ok(html.includes('<span class="pnum">[XXXX]</span>'), '临时段号应原样显示');
    assert.match(html, /\.pnum \{ color: #c0362c; font-weight: 700;/, '段号样式须为红色粗体');
    assert.ok(html.includes('<p class="para is-italic">'), 'Italic="1" 未映射为斜体');
    assert.ok(html.includes('<strong>测试</strong>') && html.includes('<sub>i</sub>'), '行内标签未映射');
    assert.ok(html.includes('<br>'), '软换行未映射');
    assert.ok(html.includes('<span class="figref">图1</span>'), 'figref 未渲染');

    // 图片按 wi/he（毫米）定尺寸；行内公式与独立表格分别走行内与块级容器
    assert.ok(html.includes(`<span class="object-inline"><img class="img inline" src="${ASSET_BASE}omath-3-1.jpg" alt="omath-3-1.jpg" style="width:46mm;height:9mm">`), `行内公式渲染不符：${html}`);
    assert.ok(html.includes(`<figure class="figure object"><img class="img" src="${ASSET_BASE}table-1.jpg" alt="table-1.jpg" style="width:120mm;height:38mm"><figcaption>表 1</figcaption></figure>`), '表格渲染不符');
});

test('patent 结构视图：权项分条编号与 claim-ref', () => {
    const view = buildXmlView(PATENT_CLAIMS, { assetBase: ASSET_BASE });
    assert.equal(view.profile, PROFILES.patent);
    const html = view.structuredHtml;
    assert.ok(html.includes('<h1 class="book-title">权利要求书</h1>'), '书名未渲染');
    assert.ok(html.includes('<span class="claim-num">1.</span>'), '权项 1 序号未渲染');
    assert.ok(html.includes('<span class="claim-num">2.</span>'), '权项 2 序号未渲染');
    assert.ok(html.includes('<p class="claim-text">一种测试装置，其特征在于包括外壳。</p>'), '权项正文未渲染');
    assert.ok(html.includes('<span class="claim-ref">权利要求1</span>'), 'claim-ref 未渲染');
});

test('patent 附图：figure 的 num 转为图注', () => {
    const view = buildXmlView([
        '<cn-application-body><cn-drawings><cn-drawing-p>',
        '<figure id="f0001" num="2"><img id="i0001" he="80" wi="120" file="image_1.jpg" inline="no"/></figure>',
        '</cn-drawing-p></cn-drawings></cn-application-body>',
    ].join(''), { assetBase: ASSET_BASE });
    assert.equal(view.profile, PROFILES.patent);
    assert.ok(view.structuredHtml.includes('<figcaption>图 2</figcaption>'), '图注未按 @num 生成');
    assert.ok(view.structuredHtml.includes('style="width:120mm;height:80mm"'), '附图尺寸未按 wi/he 生成');
});

test('官方风格样例五份全部可解析且识别为 patent', () => {
    const files = fs.readdirSync(REFERENCE_DIR).filter((name) => name.endsWith('.xml')).sort();
    assert.equal(files.length, 5, `参考样例应为五份，实际 ${files.join('、')}`);
    for (const name of files) {
        const view = buildXmlView(fs.readFileSync(path.join(REFERENCE_DIR, name), 'utf8'), { assetBase: ASSET_BASE, label: name });
        assert.equal(view.error, null, `${name} 解析失败：${view.error}`);
        assert.equal(view.profile, PROFILES.patent, `${name} 未识别为 patent`);
        assert.ok(view.structuredHtml && view.structuredHtml.includes('<body>'), `${name} 没有结构视图`);
        assert.ok(view.xml.trim().length > 0, `${name} 美化原文为空`);
    }
    const description = buildXmlView(fs.readFileSync(path.join(REFERENCE_DIR, 'description.xml'), 'utf8'), { assetBase: ASSET_BASE });
    assert.ok(description.structuredHtml.includes('<span class="pnum">[0011]</span>'), '官方样例的段号未渲染');
    assert.ok(description.structuredHtml.includes(`${ASSET_BASE}table-1.jpg`), '官方样例的表格图未寻址');
});

// ============================================================
// generic 结构视图
// ============================================================

test('generic 结构视图：meta、块级映射与外链策略', () => {
    const view = buildXmlView(GENERIC, { assetBase: ASSET_BASE });
    assert.equal(view.profile, PROFILES.generic);
    const html = view.structuredHtml;
    assert.ok(html.includes('<dt>title</dt><dd>通用样例</dd>'), 'meta 未渲染');
    assert.ok(html.includes('<h2>小标题</h2>'), '标题层级未映射');
    assert.ok(html.includes('<ol start="3">') && html.includes('<li><p>第一项</p></li>'), '有序列表未映射');
    assert.ok(html.includes('<th style="text-align:center">列头</th>') && html.includes('<td>数据</td>'), '表格未映射');
    assert.ok(html.includes('<pre class="code"><code>const a = 1 &lt; 2;</code></pre>'), '代码块未映射');
    assert.ok(html.includes('<blockquote><p>引文</p></blockquote>'), '引用未映射');
    assert.ok(html.includes('<hr>'), '分隔线未映射');
    assert.ok(html.includes('<div class="section-break">第 2 页</div>'), '分节标记未映射');
    assert.ok(html.includes(`<img class="img" src="${ASSET_BASE}images/image_1.jpg" alt="插图">`), '图片未寻址');
    assert.ok(html.includes('<a href="https://example.com/" rel="noopener noreferrer" target="_blank">外链</a>'), '外链未加 noopener');
    assert.ok(!html.includes('javascript:'), 'javascript: 链接应被剥成纯文本');
    assert.ok(html.includes('坏链'), '被剥链接的文字应保留');
});

// ============================================================
// 边界
// ============================================================

test('非本应用 XML 只给美化原文，不给结构视图', () => {
    const view = buildXmlView('<rss version="2.0"><channel><title>标题</title></channel></rss>', { assetBase: ASSET_BASE });
    assert.equal(view.kind, 'xml');
    assert.equal(view.profile, null);
    assert.equal(view.structuredHtml, null);
    assert.deepEqual(view.warnings, ['未识别的 XML 结构，只显示美化原文']);
    assert.equal(view.xml, '<rss version="2.0">\n  <channel>\n    <title>标题</title>\n  </channel>\n</rss>\n');
    // 同名但无命名空间的 document 不算 generic
    assert.equal(detectProfile(parseXml('<document version="1"><body/></document>').root), null);
});

test('畸形 XML 返回错误文案而不抛出，原文原样回吐', () => {
    const view = buildXmlView('<cn-application-body><description><p>未闭合</description></cn-application-body>', { assetBase: ASSET_BASE });
    assert.equal(view.kind, 'xml');
    assert.equal(view.profile, null);
    assert.equal(view.structuredHtml, null);
    assert.match(view.error, /不匹配/);
    assert.match(view.warnings[0], /^XML 解析失败，只能显示原文：/);
    assert.ok(view.xml.includes('未闭合'), '原文应原样保留');
    assert.doesNotThrow(() => buildXmlView(null));
    assert.doesNotThrow(() => buildXmlView('<a>'));
});

test('图片地址越界 / 非白名单扩展名 / 缺 assetBase 时只留替代文字', () => {
    const xml = [
        '<cn-application-body><cn-drawings><cn-drawing-p>',
        '<figure num="1"><img file="../secret.jpg" wi="10" he="10"/></figure>',
        '<figure num="2"><img file="/etc/secret.jpg" wi="10" he="10"/></figure>',
        '<figure num="3"><img file="a.exe" wi="10" he="10"/></figure>',
        '<figure num="4"><img file="https://evil/x.jpg" wi="10" he="10"/></figure>',
        '</cn-drawing-p></cn-drawings></cn-application-body>',
    ].join('');
    const view = buildXmlView(xml, { assetBase: ASSET_BASE });
    assert.ok(!view.structuredHtml.includes('<img'), `不应生成任何 img：${view.structuredHtml}`);
    assert.equal((view.structuredHtml.match(/class="img-missing"/g) || []).length, 4);
    assert.ok(view.warnings.some((item) => item.includes('4 处图片地址不可用')));

    const noBase = buildXmlView('<cn-application-body><cn-drawings><cn-drawing-p><figure num="1"><img file="a.jpg"/></figure></cn-drawing-p></cn-drawings></cn-application-body>');
    assert.ok(noBase.structuredHtml.includes('img-missing'), '缺 assetBase 时不得输出 img');
});
