/**
 * converters/xml/dom.js 单元测试
 * 覆盖：桌面端 XML 视图与反向导入共用同一份扫描器（同一函数引用）；maxDepth 的边界与缺省不限；
 *       sniffRootName（BOM、声明、DOCTYPE 内部子集、注释、处理指令、非 XML、未闭合的序言）；
 *       不展开 DOCTYPE 内声明的实体、不读取外部实体（XXE 与实体膨胀样本原样保留引用）；任意畸形输入绝不抛出。
 * 扫描器的语法覆盖（声明 / PI / 注释 / CDATA / 实体 / 自闭合与各类中文错误）仍由 test/desktop-xml-view.test.js 守护，
 * 此处不重复。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseXml, sniffRootName, decodeEntities } = require('../converters/xml/dom');
const xmlView = require('../desktop/main/xml-view');

const BOM = String.fromCharCode(0xFEFF);

test('桌面端 xml-view 转出的 parseXml 即 converters/xml/dom 的同一实现', () => {
    assert.equal(xmlView.parseXml, parseXml);
});

test('maxDepth：缺省不限；给出后按元素嵌套层数（根为第 1 层，含自闭合元素）封顶并给出中文错误', () => {
    const nested = (depth) => `${'<a>'.repeat(depth)}${'</a>'.repeat(depth)}`;
    assert.equal(parseXml(nested(500)).ok, true, '缺省不限深度');
    assert.equal(parseXml(nested(3), { maxDepth: 3 }).ok, true);
    assert.equal(parseXml('<a><b><c/></b></a>', { maxDepth: 3 }).ok, true, '自闭合元素同样计层');

    const tooDeep = parseXml(nested(4), { maxDepth: 3 });
    assert.equal(tooDeep.ok, false);
    assert.match(tooDeep.error, /元素嵌套超过 3 层（位置 第 1 行第 10 列）/);
    assert.equal(parseXml('<a><b><c><d/></c></b></a>', { maxDepth: 3 }).ok, false);
    // 非法取值按缺省处理，不改变既有行为
    for (const value of [0, -1, 2.5, '3', null]) assert.equal(parseXml(nested(10), { maxDepth: value }).ok, true, String(value));
});

test('sniffRootName：跳过 BOM、声明、DOCTYPE（含内部子集）、注释与处理指令后取根元素名', () => {
    const official = [
        `${BOM}<?xml version="1.0" encoding="UTF-8"?>`,
        '<!DOCTYPE cn-application-body SYSTEM "/dtdandxsl/cn-application-body-20080416.dtd"[]>',
        '<?xml-stylesheet type="text/xsl" href="/dtdandxsl/showxml.xsl"?>',
        '<cn-application-body lang="zh" country="CN">',
    ].join('\r\n');
    assert.equal(sniffRootName(official), 'cn-application-body');
    assert.equal(sniffRootName('<!-- 注释 --><!DOCTYPE r [ <!ENTITY a "<b>"> ]>\n<document xmlns="urn:markflow:document:1"/>'), 'document');
    assert.equal(sniffRootName('  \n<root>只看文首，其后不合法也无妨<<<'), 'root');
});

test('sniffRootName：非 XML、空输入与未闭合的序言一律返回 null，绝不抛出', () => {
    for (const input of ['', null, undefined, '随便一段文字', '<!-- 没闭合', '<?xml version="1.0"', '<!DOCTYPE r [', '<', '< a>', 42]) {
        assert.equal(sniffRootName(input), null, String(input));
    }
});

test('不展开 DOCTYPE 内声明的实体，也不读取外部实体：引用原样保留为文字', () => {
    const xxe = '<!DOCTYPE r [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]><r>&xxe;</r>';
    const parsed = parseXml(xxe);
    assert.equal(parsed.ok, true, parsed.error);
    assert.equal(parsed.root.children[0].value, '&xxe;');

    const laughs = [
        '<!DOCTYPE lolz [', ' <!ENTITY lol "lol">',
        ...Array.from({ length: 9 }, (_, i) => ` <!ENTITY lol${i + 1} "${`&lol${i || ''};`.repeat(10)}">`),
        ']>', '<lolz>&lol9;</lolz>',
    ].join('\n');
    const started = process.hrtime.bigint();
    const bomb = parseXml(laughs);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(bomb.ok, true, bomb.error);
    assert.equal(bomb.root.children[0].value, '&lol9;', '实体膨胀样本不得被展开');
    assert.ok(elapsedMs < 200, `解析耗时 ${elapsedMs} ms`);
});

test('decodeEntities：预定义实体与数字引用解码，未知命名实体与越界码点原样保留', () => {
    assert.equal(decodeEntities('&lt;a&gt; &amp; &quot;x&quot; &apos;y&apos; &#65;&#x4E2D;'), '<a> & "x" \'y\' A中');
    assert.equal(decodeEntities('&nbsp;&unknown;&#x110000;'), '&nbsp;&unknown;&#x110000;');
});

test('任意畸形输入绝不抛出：返回 ok:false 与中文错误', () => {
    const samples = [
        '<a', '<a b', '<a b=', '<a b="1', '<a></b>', '</a>', '<a><![CDATA[x', '<a>&#xZZ;</a>x', '<a/>尾巴', `${'<a>'.repeat(50)}`,
        String.fromCharCode(0, 1, 2), '<a b="1" b="2"/><c/>',
    ];
    for (const sample of samples) {
        let result;
        assert.doesNotThrow(() => { result = parseXml(sample, { maxDepth: 8 }); }, sample);
        assert.equal(typeof result.ok, 'boolean');
        if (!result.ok) assert.match(result.error, /[一-鿿]/, `错误信息应为中文：${result.error}`);
    }
});
