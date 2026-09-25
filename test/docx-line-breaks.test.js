/**
 * docx 段内换行与强调定界符（converters/ir/turndown.js 的 word profile：换行规则与加粗、斜体规则）
 * 覆盖：强调 run 首尾含 <w:br/>（段中、段首、段尾，1–3 个，加粗、斜体、加粗斜体、只含换行、带首部空格）不再产出
 *       字面星号或拆段；非加粗段中连续换行不再拆段；非加粗换行、普通加粗、加粗中间换行、下划线、标题与列表项内换行
 *       维持原有 IR；md 与 generic XML 端到端产物；换行与全角空格相邻（全角空格落在换行外侧，属已知限制，按现状断言）；
 *       列表项首个加粗 run 以连续换行开头时内容不被挤成代码块；turndown 层的三种换行写法、剥下的段首段尾与标题内换行
 *       不再输出、下划线与链接内侧首尾换行不再被 trim 吞掉、尾部剥离的反斜杠奇偶判定。
 * 夹具一律由 JSZip 按 OOXML 现造，run 的 XML 逐字可控，正文为虚构示例。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const JSZip = require('jszip');
const { load } = require('cheerio');

const { parse } = require('../converters/parsers/docx');
const mdRenderer = require('../converters/renderers/md');
const xmlRenderer = require('../converters/renderers/xml');
const { normalizeOptions } = require('../converters/options');
const { loadUnified } = require('../converters/ir/unified-loader');
const { liftInlineHtml } = require('../converters/ir/inline-html');
const { createTurndownService } = require('../converters/ir/turndown');

// 不可见字符以码点生成，源码不出现看不见的字面量：U+3000 全角空格
const IDEO = String.fromCharCode(0x3000);

// ============================================================
// 夹具：JSZip 现造的最小 docx（正文段 + 第二段「下一段」，另带 heading 1 样式与一个无序编号定义）
// ============================================================

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NEXT = '下一段';

const text = (value) => `<w:t xml:space="preserve">${value}</w:t>`;
const BR = '<w:br/>';
const BOLD = '<w:b/>';
const ITALIC = '<w:i/>';
const UNDERLINE = '<w:u w:val="single"/>';
const HEADING_1 = '<w:pStyle w:val="1"/>';
const BULLET = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>';
const run = (content, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${content}</w:r>`;
const plain = (value) => run(text(value));
const paragraph = (runs, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs.join('')}</w:p>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W_NS}">`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>'
    + '</w:styles>';
// mammoth 以 numFmt 是否为 bullet 判定有序或无序
const NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W_NS}">`
    + '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="-"/></w:lvl></w:abstractNum>'
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';
const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '</Types>';
const relationships = (items) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R_NS}/${type}" Target="${target}"/>`).join('')
    + '</Relationships>';

async function buildDocx(bodyXml) {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
    zip.file('_rels/.rels', relationships([['rId1', 'officeDocument', 'word/document.xml']]));
    zip.file('word/_rels/document.xml.rels', relationships([['rId1', 'styles', 'styles.xml'], ['rId2', 'numbering', 'numbering.xml']]));
    zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`);
    zip.file('word/styles.xml', STYLES_XML);
    zip.file('word/numbering.xml', NUMBERING_XML);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** 被测段落 + 第二段「下一段」→ parsers/docx 全链路 → MarkFlowDocument */
async function convertParagraph(runs, pPr = '') {
    const buffer = await buildDocx(paragraph(runs, pPr) + paragraph([plain(NEXT)]));
    return parse({ buffer }, { sourceName: '换行样例.docx' });
}

// ============================================================
// IR 简式与共同断言
// ============================================================

/** 文本 → 字符串，break → 'BR'，其余 → { 类型: 子节点简式 } */
function brief(node) {
    if (node.type === 'text') return node.value;
    if (node.type === 'break') return 'BR';
    return { [node.type]: (node.children || []).map(brief) };
}

function walk(node, visit) {
    visit(node);
    for (const child of node.children || []) walk(child, visit);
}

/** 任一文本节点均不含「*」，不残留 html 节点 */
function assertClean(ir) {
    walk(ir, (node) => {
        assert.notEqual(node.type, 'html', `残留 html 节点：${JSON.stringify(node.value)}`);
        if (node.type === 'text') assert.ok(!node.value.includes('*'), `文本含字面星号：${JSON.stringify(node.value)}`);
    });
}

/** 顶层恰为两个段落（检出拆段），第二段为「下一段」；返回首段子节点的简式 */
function firstOfTwoParagraphs(doc) {
    assertClean(doc.ir);
    assert.deepEqual(doc.ir.children.map((node) => node.type), ['paragraph', 'paragraph'], '被测段落不得拆段');
    assert.deepEqual(brief(doc.ir.children[1]), { paragraph: [NEXT] });
    return doc.ir.children[0].children.map(brief);
}

const strong = (...children) => ({ strong: children });
const emphasis = (...children) => ({ emphasis: children });
const underline = (...children) => ({ underline: children });

// ============================================================
// 修复对象（修复前产出字面星号、拆段或丢失换行）
// ============================================================

const FIX_CASES = [
    {
        name: 'C1 加粗 run 以 1 个换行开头（段中）',
        runs: [plain('前文'), run(BR + text('加粗'), BOLD), plain('后文')],
        expected: ['前文', 'BR', strong('加粗'), '后文'],
    },
    {
        name: 'C2 加粗 run 以 2 个换行开头（段中）：两个 BR，不拆段',
        runs: [plain('前文'), run(BR + BR + text('加粗'), BOLD), plain('后文')],
        expected: ['前文', 'BR', 'BR', strong('加粗'), '后文'],
    },
    {
        name: 'C3 加粗 run 以 3 个换行开头（段中）：三个 BR，不拆段',
        runs: [plain('前文'), run(BR + BR + BR + text('加粗'), BOLD), plain('后文')],
        expected: ['前文', 'BR', 'BR', 'BR', strong('加粗'), '后文'],
    },
    {
        name: 'C4 加粗 run 以 1 个换行开头且在段首：段首换行与非加粗一致地被舍弃',
        runs: [run(BR + text('加粗'), BOLD), plain('后文')],
        expected: [strong('加粗'), '后文'],
    },
    {
        name: 'C5 加粗 run 以 2 个换行开头且在段首：结果同 C4',
        runs: [run(BR + BR + text('加粗'), BOLD), plain('后文')],
        expected: [strong('加粗'), '后文'],
    },
    {
        name: 'C7 斜体 run 以换行开头（段中）',
        runs: [plain('前文'), run(BR + text('斜体'), ITALIC), plain('后文')],
        expected: ['前文', 'BR', emphasis('斜体'), '后文'],
    },
    {
        name: 'C8 加粗 run 以换行结尾（段中）',
        runs: [plain('前文'), run(text('加粗') + BR, BOLD), plain('后文')],
        expected: ['前文', strong('加粗'), 'BR', '后文'],
    },
    {
        name: 'C9 加粗 run 以换行结尾（段尾）：段尾换行被舍弃',
        runs: [plain('前文'), run(text('加粗') + BR, BOLD)],
        expected: ['前文', strong('加粗')],
    },
    {
        name: 'C10 加粗 run 只含一个换行（段中）：换行保住',
        runs: [plain('前文'), run(BR, BOLD), plain('后文')],
        expected: ['前文', 'BR', '后文'],
    },
    {
        name: 'C11 非加粗段中连续 2 个换行：两个 BR，不再拆段（经用户同意的行为变化）',
        runs: [plain('前文'), run(BR + BR), plain('普通')],
        expected: ['前文', 'BR', 'BR', '普通'],
    },
    {
        name: 'C12 带首部空格的加粗 run 以换行结尾（段中）：换行不丢，strong 只含「加粗」',
        runs: [plain('前文'), run(text(' 加粗') + BR, BOLD), plain('后文')],
        expected: ['前文 ', strong('加粗'), 'BR', '后文'],
    },
];

describe('修复对象：强调 run 首尾的换行与段中连续换行', () => {
    for (const { name, runs, expected } of FIX_CASES) {
        test(name, async () => {
            const doc = await convertParagraph(runs);
            assert.deepEqual(firstOfTwoParagraphs(doc), expected);
        });
    }

    test('C6 加粗斜体 run 以换行开头（段中）：BR 之后的「粗斜」同时处于 strong 与 emphasis 之内（不限定嵌套次序）', async () => {
        const doc = await convertParagraph([plain('前文'), run(BR + text('粗斜'), BOLD + ITALIC), plain('后文')]);

        const first = firstOfTwoParagraphs(doc);
        assert.equal(first.length, 4, JSON.stringify(first));
        assert.deepEqual([first[0], first[1], first[3]], ['前文', 'BR', '后文']);
        const nested = [strong(emphasis('粗斜')), emphasis(strong('粗斜'))];
        assert.ok(nested.some((shape) => isDeepStrictEqual(first[2], shape)), JSON.stringify(first[2]));
    });
});

// ============================================================
// 回归守护（修复前后都应通过）
// ============================================================

const GUARD_CASES = [
    {
        name: 'G1 非加粗单个段中换行',
        runs: [plain('前文'), run(BR), plain('普通')],
        expected: ['前文', 'BR', '普通'],
    },
    {
        name: 'G2 非加粗换行在段首：换行被舍弃',
        runs: [run(BR + text('普通'))],
        expected: ['普通'],
    },
    {
        name: 'G2 非加粗换行在段尾：换行被舍弃',
        runs: [run(text('普通') + BR)],
        expected: ['普通'],
    },
    {
        name: 'G3 无换行的普通加粗',
        runs: [plain('前文'), run(text('加粗'), BOLD), plain('后文')],
        expected: ['前文', strong('加粗'), '后文'],
    },
    {
        name: 'G4 加粗 run 中间含换行',
        runs: [plain('前文'), run(text('甲') + BR + text('乙'), BOLD), plain('后文')],
        expected: ['前文', strong('甲', 'BR', '乙'), '后文'],
    },
    {
        name: 'G5 下划线 run 以换行开头',
        runs: [plain('前文'), run(BR + text('下划线'), UNDERLINE), plain('后文')],
        expected: ['前文', underline('BR', '下划线'), '后文'],
    },
];

describe('回归守护：原本正常的换行形态 IR 不变', () => {
    for (const { name, runs, expected } of GUARD_CASES) {
        test(name, async () => {
            const doc = await convertParagraph(runs);
            assert.deepEqual(firstOfTwoParagraphs(doc), expected);
        });
    }

    test('G6 标题段内换行：维持现状，拆为标题 + 段落（既有表现，非本次范围）', async () => {
        const doc = await convertParagraph([run(text('标题甲') + BR + text('标题乙'))], HEADING_1);

        assertClean(doc.ir);
        assert.deepEqual(doc.ir.children.map(brief), [{ heading: ['标题甲'] }, { paragraph: ['标题乙'] }, { paragraph: [NEXT] }]);
    });

    test('G7 列表项内换行：listItem 内单段含 BR', async () => {
        const doc = await convertParagraph([run(text('项甲') + BR + text('项乙'))], BULLET);

        assertClean(doc.ir);
        assert.deepEqual(doc.ir.children.map((node) => node.type), ['list', 'paragraph']);
        assert.deepEqual(brief(doc.ir.children[0]), { list: [{ listItem: [{ paragraph: ['项甲', 'BR', '项乙'] }] }] });
        assert.deepEqual(brief(doc.ir.children[1]), { paragraph: [NEXT] });
    });
});

// ============================================================
// 端到端产物：md 渲染器与 generic XML
// ============================================================

async function renderGenericXml(doc) {
    const result = await xmlRenderer.render(doc, normalizeOptions({ xml: { profile: 'generic' } }));
    return load(result.files['{name}.xml'], { xmlMode: true });
}

/** md 产物经 remark（+ GFM）重新解析、再经 liftInlineHtml 提升后的顶层简式 */
async function reparseMarkdown(markdown) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    const tree = liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(markdown), { source: 'md' });
    return tree.children.map(brief);
}

const caseOf = (id) => FIX_CASES.find((item) => item.name.startsWith(`${id} `));
const E2E_CASES = [
    { name: 'C1', breaks: 1, bold: '加粗', text: '前文加粗后文' },
    { name: 'C2', breaks: 2, bold: '加粗', text: '前文加粗后文' },
    { name: 'C11', breaks: 2, bold: null, text: '前文普通' },
];

describe('端到端产物：该 Word 段落只对应一个段落，换行个数正确，无字面星号', () => {
    for (const { name, breaks, bold, text: plainText } of E2E_CASES) {
        const { runs, expected } = caseOf(name);

        test(`${name}：generic XML 只有一个 <p>，<br/> 为 ${breaks} 个${bold ? '，加粗文字由 <b> 包住' : ''}`, async () => {
            const doc = await convertParagraph(runs);
            const $ = await renderGenericXml(doc);

            const paragraphs = $('body > p');
            assert.equal(paragraphs.length, 2, 'Word 的两段各对应一个 <p>');
            const first = paragraphs.first();
            assert.equal(first.find('br').length, breaks);
            assert.equal(first.text(), plainText);
            assert.ok(!first.text().includes('*'));
            if (bold) assert.deepEqual(first.find('b').map((i, el) => $(el).text()).get(), [bold]);
            else assert.equal(first.find('b').length, 0);
            assert.equal(paragraphs.last().text(), NEXT);
        });

        test(`${name}：md 产物无字面星号，经 remark 重新解析得到同样的两段结构`, async () => {
            const doc = await convertParagraph(runs);
            const markdown = await mdRenderer.render(doc);

            const structure = [{ paragraph: expected }, { paragraph: [NEXT] }];
            assert.deepEqual(doc.ir.children.map(brief), structure);
            assert.ok(!markdown.includes('\\*'), JSON.stringify(markdown));
            assert.deepEqual(await reparseMarkdown(markdown), structure, JSON.stringify(markdown));
        });
    }
});

// ============================================================
// 补充：换行与全角空格相邻（加粗规则把换行两侧的空白一并剥出定界符）
// 已知限制：全角空格落在剥出的换行外侧，与原文次序相反（成因见 converters/ir/turndown.js 的块注释），此处按现状逐项
// 断言，日后修正次序时须同步改写；修复前这类 run 的换行整个丢失
// ============================================================

describe('补充：强调 run 内换行与全角空格相邻', () => {
    const cases = [
        [
            '加粗 run 以换行加两个全角空格开头（段中）：全角空格移到换行之前',
            [plain('前文'), run(BR + text(`${IDEO}${IDEO}加粗`), BOLD), plain('后文')],
            [`前文${IDEO}${IDEO}`, 'BR', strong('加粗'), '后文'],
        ],
        [
            '加粗 run 以全角空格加换行结尾（段中）：全角空格移到换行之后',
            [plain('前文'), run(text(`加粗${IDEO}${IDEO}`) + BR, BOLD), plain('后文')],
            ['前文', strong('加粗'), 'BR', `${IDEO}${IDEO}后文`],
        ],
    ];
    for (const [name, runs, expected] of cases) {
        test(`${name}（已知限制）；换行保住、全角空格不重复、加粗只含「加粗」、无字面星号`, async () => {
            const doc = await convertParagraph(runs);
            assert.deepEqual(firstOfTwoParagraphs(doc), expected);
        });
    }
});

describe('补充：列表项的首个加粗 run 以连续换行开头', () => {
    test('内容留在列表项内且加粗成立，不因项首的空白行被挤成缩进代码块', async () => {
        const doc = await convertParagraph([run(BR + BR + text('加粗'), BOLD), plain('后文')], BULLET);

        assertClean(doc.ir);
        assert.deepEqual(doc.ir.children.map(brief), [
            { list: [{ listItem: [{ paragraph: [strong('加粗'), '后文'] }] }] },
            { paragraph: [NEXT] },
        ]);
    });
});

// ============================================================
// turndown 层：word profile 的换行写法与强调规则细节
// ============================================================

describe('turndown word profile：换行写法与强调规则', () => {
    const toMarkdown = (html, service = createTurndownService('word')) => service.turndown(html);

    test('换行按所在块的上下文取写法：段中为 <br>，段首段尾与标题内沿用「两个空格 + 换行」', () => {
        assert.equal(toMarkdown('<p>甲<br />乙</p>'), '甲<br>乙');
        assert.equal(toMarkdown('<p>甲<br /><br />乙</p>'), '甲<br><br>乙');
        assert.equal(toMarkdown('<p><br />甲</p><p>乙<br /></p><p>丙</p>'), '  \n甲\n\n乙  \n\n丙');
        assert.equal(toMarkdown('<h1>甲<br />乙</h1>'), '# 甲  \n乙');
        // 列表项里嵌套的列表是行内连续区的边界：其前的换行后面没有内容，按段尾处理
        assert.equal(toMarkdown('<ul><li>甲<br /><ul><li>乙</li></ul></li></ul>'), '-   甲  \n    -   乙');
    });

    test('加粗、斜体：首尾的换行剥到定界符之外，嵌套时由内向外逐层剥离；只含换行时只输出段中换行', () => {
        assert.equal(toMarkdown('<p>甲<strong><br />乙</strong>丙</p>'), '甲<br>**乙**丙');
        assert.equal(toMarkdown('<p>甲<b>乙<br /></b>丙</p>'), '甲**乙**<br>丙');
        assert.equal(toMarkdown('<p>甲<em><br /><br />乙</em>丙</p>'), '甲<br><br>*乙*丙');
        assert.equal(toMarkdown('<p>甲<strong><em><br />乙</em></strong>丙</p>'), '甲<br>***乙***丙');
        assert.equal(toMarkdown('<p>甲<i><br /></i>丙</p>'), '甲<br>丙');
        // 剥下的段首段尾换行（「两个空格 + 换行」）不再输出：remark 本就舍弃它们，留下时外层链接会被空行拆开
        assert.equal(toMarkdown('<p><strong><br />乙</strong>丙</p>'), '**乙**丙');
        assert.equal(toMarkdown('<p><a href="u"><strong>丁<br /><br /></strong></a></p>'), '[**丁**](u)');
        // 标题内的换行沿用「两个空格 + 换行」，处在强调首尾者随剥离舍弃、标题不再被拆开（原先为字面星号并拆出段落）
        assert.equal(toMarkdown('<h1>前<strong><br />标题</strong></h1>'), '# 前**标题**');
        assert.equal(toMarkdown('<p><a href="u"><strong><br /><br /></strong></a>甲</p>'), '[](u)甲');
    });

    test('下划线与链接内侧首尾的段中换行不再被 turndown 的 trim 吞掉', () => {
        assert.equal(toMarkdown('<p>前文<u> 下划线<br /></u>后文</p>'), '前文 <u>下划线<br></u>后文');
        assert.equal(toMarkdown('<p>前文<a href="u"> 链接<br /></a>后文</p>'), '前文 [链接<br>](u)后文');
    });

    test('尾部剥离 <br> 前核对反斜杠奇偶：偶数个是字面反斜杠加真换行，奇数个说明「<」是被转义的字面文字', () => {
        // 文本末尾的字面反斜杠被 turndown 加倍为两个，其后的 <br> 是真换行，照常剥出定界符
        assert.equal(toMarkdown('<p>前文<strong>加粗\\<br /></strong>后文</p>'), '前文**加粗\\\\**<br>后文');
        // 文本里的「<」由工厂层的 escapeHtmlSyntax 转义为 \<，字面的「<br>」前恰有一个反斜杠，不得剥出。
        // 期望「前文**加粗\<br>**后文」本身即 flanking 失效（闭定界符前是「>」、后是汉字），按定界符后处理改写为标签
        assert.equal(toMarkdown('<p>前文<strong>加粗&lt;br&gt;</strong>后文</p>'), '前文<strong>加粗\\<br></strong>后文');
    });
});
