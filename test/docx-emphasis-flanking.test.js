/**
 * docx 强调定界符的 flanking 失效与定界符串合并（converters/ir/turndown.js 的 word profile：加粗、斜体规则与定界符后处理）
 * 覆盖：核心两端为中文标点、ASCII 标点或符号而外侧为汉字时不再残留字面星号；加粗内嵌的下划线、上下标、链接、图片处在
 *       边界上；加粗、斜体、加粗斜体两两相邻的各种次序（含斜体核心只有「。」的形态）；同类嵌套；上述形态与段中换行的
 *       组合，以及处在标题、列表项内的情形；md、generic XML 与 patent XML 端到端产物不含字面星号；turndown 层的写法
 *       （只在定界符会失效时改用 HTML 标签、加粗恰好整段包住斜体时保留 ***X***、哨兵不外泄、混入同码点字符时的确定行为）。
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

// 控制字符以码点生成，源码不出现字面量：XML 1.0 不允许的 C0 控制字符（制表符、换行与回车除外）
const fromCode = (code) => String.fromCharCode(code);
const C0_CONTROL_RE = new RegExp(`[${fromCode(0x00)}-${fromCode(0x08)}${fromCode(0x0b)}${fromCode(0x0c)}${fromCode(0x0e)}-${fromCode(0x1f)}]`);

// ============================================================
// 夹具：JSZip 现造的最小 docx（正文段 + 第二段「下一段」，另带 heading 1 样式、无序编号定义、外部超链接与 1×1 PNG）
// ============================================================

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const NEXT = '下一段';
const LINK_URL = 'https://example.com/';
const IMAGE_ALT = '示意图';
const IMAGE_NAME = 'images/image_1.png';
// 1×1 PNG，70 字节
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const text = (value) => `<w:t xml:space="preserve">${value}</w:t>`;
const BR = '<w:br/>';
const BOLD = '<w:b/>';
const ITALIC = '<w:i/>';
const BOLD_ITALIC = BOLD + ITALIC;
const UNDERLINE = '<w:u w:val="single"/>';
const SUP = '<w:vertAlign w:val="superscript"/>';
const SUB = '<w:vertAlign w:val="subscript"/>';
const HEADING_1 = '<w:pStyle w:val="1"/>';
const BULLET = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>';
const run = (content, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${content}</w:r>`;
const plain = (value) => run(text(value));
const bold = (value) => run(text(value), BOLD);
const italic = (value) => run(text(value), ITALIC);
const boldItalic = (value) => run(text(value), BOLD_ITALIC);
const link = (runs) => `<w:hyperlink r:id="rIdLink">${runs.join('')}</w:hyperlink>`;
// 行内图片：mammoth 以 wp:docPr@descr 作 alt，经 pic:blipFill/a:blip@r:embed 找图片部件
const image = (rPr = '') => run(`<w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="图片 1" descr="${IMAGE_ALT}"/>`
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill>'
    + '<a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>', rPr);
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
    + '<Default Extension="png" ContentType="image/png"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '</Types>';
const relationships = (items) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map(([id, type, target, external]) => `<Relationship Id="${id}" Type="${R_NS}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`).join('')
    + '</Relationships>';

async function buildDocx(bodyXml) {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
    zip.file('_rels/.rels', relationships([['rId1', 'officeDocument', 'word/document.xml']]));
    zip.file('word/_rels/document.xml.rels', relationships([
        ['rId1', 'styles', 'styles.xml'], ['rId2', 'numbering', 'numbering.xml'],
        ['rIdLink', 'hyperlink', LINK_URL, true], ['rIdImg', 'image', 'media/image1.png'],
    ]));
    zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}">`
        + `<w:body>${bodyXml}<w:sectPr/></w:body></w:document>`);
    zip.file('word/styles.xml', STYLES_XML);
    zip.file('word/numbering.xml', NUMBERING_XML);
    zip.file('word/media/image1.png', PNG);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** 被测段落 + 第二段「下一段」→ parsers/docx 全链路 → MarkFlowDocument */
async function convertParagraph(runs, pPr = '') {
    const buffer = await buildDocx(paragraph(runs, pPr) + paragraph([plain(NEXT)]));
    return parse({ buffer }, { sourceName: '强调样例.docx' });
}

// ============================================================
// IR 简式与共同断言
// ============================================================

/** 文本 → 字符串，break → 'BR'，image → 'IMG'，其余 → { 类型: 子节点简式 } */
function brief(node) {
    if (node.type === 'text') return node.value;
    if (node.type === 'break') return 'BR';
    if (node.type === 'image') return 'IMG';
    return { [node.type]: (node.children || []).map(brief) };
}

function walk(node, visit) {
    visit(node);
    for (const child of node.children || []) walk(child, visit);
}

/** 任一文本节点均不含「*」与 C0 控制字符（哨兵不外泄），不残留 html 节点 */
function assertClean(ir) {
    walk(ir, (node) => {
        assert.notEqual(node.type, 'html', `残留 html 节点：${JSON.stringify(node.value)}`);
        if (node.type !== 'text') return;
        assert.ok(!node.value.includes('*'), `文本含字面星号：${JSON.stringify(node.value)}`);
        assert.ok(!C0_CONTROL_RE.test(node.value), `文本含控制字符：${JSON.stringify(node.value)}`);
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
const superscript = (...children) => ({ superscript: children });
const subscript = (...children) => ({ subscript: children });
const linkNode = (...children) => ({ link: children });

/**
 * 加粗斜体：同一文字同时处于 strong 与 emphasis 之内，不限定嵌套次序（定界符 ***X*** 解析为 emphasis(strong)，
 * HTML 标签则按 mammoth 的嵌套为 strong(emphasis)）。expected 中以 BOTH(text) 标记，比对时两种形状都接受
 */
const BOTH = (...children) => ({ both: children });
function matches(actual, expected) {
    if (Array.isArray(expected)) {
        return Array.isArray(actual) && actual.length === expected.length && expected.every((item, i) => matches(actual[i], item));
    }
    if (expected && typeof expected === 'object') {
        if (expected.both) {
            return matches(actual, strong(emphasis(...expected.both))) || matches(actual, emphasis(strong(...expected.both)));
        }
        const [type] = Object.keys(expected);
        return Boolean(actual) && typeof actual === 'object' && Array.isArray(actual[type]) && matches(actual[type], expected[type]);
    }
    return isDeepStrictEqual(actual, expected);
}
function assertShape(actual, expected) {
    assert.ok(matches(actual, expected), `实际 ${JSON.stringify(actual)}\n期望 ${JSON.stringify(expected)}`);
}

// ============================================================
// 修复对象：用户报告的形态（修复前产出字面星号或错配的强调）
// ============================================================

describe('修复对象：用户报告的形态', () => {
    const cases = [
        ['U1 加粗核心两端为书名号、外侧为汉字', [plain('依据'), bold('《专利法》'), plain('的规定')], ['依据', strong('《专利法》'), '的规定']],
        ['U2 加粗内只有下划线、外侧为汉字', [plain('前文'), run(text('加粗'), BOLD + UNDERLINE), plain('后文')], ['前文', strong(underline('加粗')), '后文']],
        ['U3 加粗斜体后紧接斜体', [boldItalic('甲'), italic('乙')], [BOTH('甲'), emphasis('乙')]],
        ['U4 加粗后紧接只含「。」的斜体', [bold('加粗'), italic('。')], [strong('加粗'), emphasis('。')]],
        ['U5 加粗以冒号结尾、后接汉字', [bold('注意：'), plain('本发明')], [strong('注意：'), '本发明']],
    ];
    for (const [name, runs, expected] of cases) {
        test(name, async () => {
            assertShape(firstOfTwoParagraphs(await convertParagraph(runs)), expected);
        });
    }
});

// ============================================================
// 标点矩阵：核心两端的标点或符号 × 外侧环境 × 加粗 / 斜体 / 加粗斜体
// ============================================================

// 核心：两端、仅首、仅尾为中文标点、ASCII 标点或符号（\p{P} 与 \p{S}），另含一个纯汉字对照
const CORES = [
    '《专利法》', '「引号」', '（括号）', '“引文”', '……', '——', '。', '，', '：', '；', '、',
    '"ascii"', '(ascii)', '[注]', '$100', 'a+b', '注意：', '结论。', '《专利法》第一条', '第一条《专利法》', '甲',
];
// 外侧环境：[名称, 前 run 文本 | null, 后 run 文本 | null]
const CONTEXTS = [
    ['两侧汉字', '前文', '后文'],
    ['两侧标点', '（', '）'],
    ['两侧空格', '前文 ', ' 后文'],
    ['独占一段', null, null],
    ['段首后接汉字', null, '后文'],
    ['汉字后处于段尾', '前文', null],
];
const FORMATS = [
    ['加粗', BOLD, (core) => strong(core)],
    ['斜体', ITALIC, (core) => emphasis(core)],
    ['加粗斜体', BOLD_ITALIC, (core) => BOTH(core)],
];

describe('标点矩阵：核心两端为标点或符号时各外侧环境下强调成立、文本逐字保留', () => {
    for (const [formatName, rPr, wrap] of FORMATS) {
        for (const [contextName, before, after] of CONTEXTS) {
            test(`${formatName} × ${contextName}`, async () => {
                for (const core of CORES) {
                    const runs = [before === null ? '' : plain(before), run(text(core), rPr), after === null ? '' : plain(after)].filter(Boolean);
                    const expected = [before, wrap(core), after].filter((item) => item !== null);
                    const doc = await convertParagraph(runs);
                    const actual = firstOfTwoParagraphs(doc);
                    assert.ok(matches(actual, expected), `核心 ${JSON.stringify(core)}：实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
                }
            });
        }
    }
});

// ============================================================
// 边界嵌套：加粗内的下划线、上下标、链接、图片处在边界上
// ============================================================

describe('边界嵌套：加粗内的下划线、上下标、链接与图片处在边界上', () => {
    const cases = [
        ['下划线在加粗首部', [plain('前文'), run(text('甲'), BOLD + UNDERLINE), bold('乙'), plain('后文')], ['前文', strong(underline('甲'), '乙'), '后文']],
        ['下划线在加粗尾部', [plain('前文'), bold('甲'), run(text('乙'), BOLD + UNDERLINE), plain('后文')], ['前文', strong('甲', underline('乙')), '后文']],
        ['上标在加粗首部', [plain('前文'), run(text('2'), BOLD + SUP), bold('甲'), plain('后文')], ['前文', strong(superscript('2'), '甲'), '后文']],
        ['下标在加粗尾部', [plain('前文'), bold('甲'), run(text('2'), BOLD + SUB), plain('后文')], ['前文', strong('甲', subscript('2')), '后文']],
        ['加粗内只有上标、外侧为汉字', [plain('前文'), run(text('2'), BOLD + SUP), plain('后文')], ['前文', strong(superscript('2')), '后文']],
        ['斜体内只有下划线、外侧为汉字', [plain('前文'), run(text('甲'), ITALIC + UNDERLINE), plain('后文')], ['前文', emphasis(underline('甲')), '后文']],
        ['加粗斜体内只有下划线、外侧为汉字', [plain('前文'), run(text('甲'), BOLD_ITALIC + UNDERLINE), plain('后文')], ['前文', BOTH(underline('甲')), '后文']],
        ['加粗的超链接后紧接加粗文字', [plain('前文'), link([bold('链接')]), bold('甲'), plain('后文')], ['前文', linkNode(strong('链接')), strong('甲'), '后文']],
        ['加粗文字后紧接加粗的超链接', [plain('前文'), bold('甲'), link([bold('链接')]), plain('后文')], ['前文', strong('甲'), linkNode(strong('链接')), '后文']],
        ['加粗以图片结尾、外侧为汉字', [plain('前文'), bold('甲'), image(BOLD), plain('后文')], ['前文', strong('甲', 'IMG'), '后文']],
        ['加粗以图片开头、外侧为汉字', [plain('前文'), image(BOLD), bold('乙'), plain('后文')], ['前文', strong('IMG', '乙'), '后文']],
    ];
    for (const [name, runs, expected] of cases) {
        test(name, async () => {
            assertShape(firstOfTwoParagraphs(await convertParagraph(runs)), expected);
        });
    }

    test('加粗内只有图片、外侧为汉字：图片不承载加粗，直接成为段内图片', async () => {
        const actual = firstOfTwoParagraphs(await convertParagraph([plain('前文'), image(BOLD), plain('后文')]));
        assert.ok(matches(actual, ['前文', 'IMG', '后文']) || matches(actual, ['前文', strong('IMG'), '后文']), JSON.stringify(actual));
    });
});

// ============================================================
// 相邻：加粗、斜体、加粗斜体两两紧邻（mammoth 会合并相邻的同类元素，故同类相邻不在其列）
// ============================================================

describe('相邻：加粗、斜体、加粗斜体两两紧邻的各种次序', () => {
    const cases = [
        ['加粗 + 斜体', [bold('甲'), italic('乙')], [strong('甲'), emphasis('乙')]],
        ['斜体 + 加粗', [italic('甲'), bold('乙')], [emphasis('甲'), strong('乙')]],
        ['加粗 + 加粗斜体（mammoth 合并为加粗内含斜体）', [bold('甲'), boldItalic('乙')], [strong('甲', emphasis('乙'))]],
        ['加粗斜体 + 加粗（mammoth 合并为加粗内含斜体）', [boldItalic('甲'), bold('乙')], [strong(emphasis('甲'), '乙')]],
        ['斜体 + 加粗斜体', [italic('甲'), boldItalic('乙')], [emphasis('甲'), BOTH('乙')]],
        ['加粗斜体 + 斜体', [boldItalic('甲'), italic('乙')], [BOTH('甲'), emphasis('乙')]],
        ['加粗 + 斜体 + 加粗', [bold('甲'), italic('乙'), bold('丙')], [strong('甲'), emphasis('乙'), strong('丙')]],
        ['斜体 + 加粗 + 斜体', [italic('甲'), bold('乙'), italic('丙')], [emphasis('甲'), strong('乙'), emphasis('丙')]],
        ['加粗 + 斜体，核心为标点', [bold('注意：'), italic('《专利法》')], [strong('注意：'), emphasis('《专利法》')]],
        ['加粗斜体 + 斜体，核心为标点', [boldItalic('《甲》'), italic('。')], [BOTH('《甲》'), emphasis('。')]],
        ['加粗 + 加粗斜体 + 斜体', [bold('甲'), boldItalic('乙'), italic('丙')], [strong('甲', emphasis('乙')), emphasis('丙')]],
    ];
    for (const [name, runs, expected] of cases) {
        for (const [contextName, before, after] of [['独占一段', null, null], ['两侧汉字', '前文', '后文']]) {
            test(`${name} × ${contextName}`, async () => {
                const full = [before === null ? '' : plain(before), ...runs, after === null ? '' : plain(after)].filter(Boolean);
                const shape = [before, ...expected, after].filter((item) => item !== null);
                assertShape(firstOfTwoParagraphs(await convertParagraph(full)), shape);
            });
        }
    }
});

// ============================================================
// 与段中换行的组合
// ============================================================

describe('与段中换行的组合', () => {
    const cases = [
        ['加粗核心为标点、run 以换行结尾', [plain('前文'), run(text('《专利法》') + BR, BOLD), plain('后文')], ['前文', strong('《专利法》'), 'BR', '后文']],
        ['加粗核心为标点、run 以换行开头', [plain('前文'), run(BR + text('《专利法》'), BOLD), plain('后文')], ['前文', 'BR', strong('《专利法》'), '后文']],
        ['加粗核心中间换行、两端为标点', [plain('前文'), run(text('注意：') + BR + text('结论。'), BOLD), plain('后文')], ['前文', strong('注意：', 'BR', '结论。'), '后文']],
        ['加粗后接以换行开头的斜体', [bold('甲'), run(BR + text('乙'), ITALIC), plain('后文')], [strong('甲'), 'BR', emphasis('乙'), '后文']],
        ['以换行结尾的加粗后接斜体', [plain('前文'), run(text('甲') + BR, BOLD), italic('乙')], ['前文', strong('甲'), 'BR', emphasis('乙')]],
        ['加粗斜体内含换行且核心为标点', [plain('前文'), run(text('《甲》') + BR + text('《乙》'), BOLD_ITALIC), plain('后文')], ['前文', BOTH('《甲》', 'BR', '《乙》'), '后文']],
        ['加粗内斜体在首部且斜体以换行结尾', [plain('前文'), run(text('甲') + BR, BOLD_ITALIC), bold('乙'), plain('后文')], ['前文', strong(emphasis('甲'), 'BR', '乙'), '后文']],
    ];
    for (const [name, runs, expected] of cases) {
        test(name, async () => {
            assertShape(firstOfTwoParagraphs(await convertParagraph(runs)), expected);
        });
    }
});

// ============================================================
// 标题与列表项内
// ============================================================

function onlyBlockBefore(doc) {
    assertClean(doc.ir);
    assert.equal(doc.ir.children.length, 2, JSON.stringify(doc.ir.children.map(brief)));
    assert.deepEqual(brief(doc.ir.children[1]), { paragraph: [NEXT] });
    return brief(doc.ir.children[0]);
}

describe('标题与列表项内', () => {
    const cases = [
        ['书名号加粗、外侧汉字', [plain('依据'), bold('《专利法》'), plain('的规定')], ['依据', strong('《专利法》'), '的规定']],
        ['加粗以冒号结尾、后接汉字', [bold('注意：'), plain('本发明')], [strong('注意：'), '本发明']],
        ['加粗后紧接斜体', [bold('甲'), italic('乙')], [strong('甲'), emphasis('乙')]],
        ['加粗斜体后紧接斜体', [boldItalic('甲'), italic('乙')], [BOTH('甲'), emphasis('乙')]],
        ['加粗内只有下划线、外侧汉字', [plain('前文'), run(text('甲'), BOLD + UNDERLINE), plain('后文')], ['前文', strong(underline('甲')), '后文']],
    ];
    for (const [name, runs, expected] of cases) {
        test(`标题：${name}`, async () => {
            assertShape(onlyBlockBefore(await convertParagraph(runs, HEADING_1)), { heading: expected });
        });
        test(`列表项：${name}`, async () => {
            assertShape(onlyBlockBefore(await convertParagraph(runs, BULLET)), { list: [{ listItem: [{ paragraph: expected }] }] });
        });
    }
});

// ============================================================
// 辅助平面字符：micromark 4 按 UTF-16 码元归类，辅助平面的标点、符号在其眼中一律为「其他」；实现对外侧字符按此从严，
// 对核心首末字符按码点从严，两种归类下都不得写出会失效的定界符
// ============================================================

const EMOJI = String.fromCodePoint(0x1f600);   // So，辅助平面符号
const EXT_B = String.fromCodePoint(0x20000);   // Lo，辅助平面汉字（扩展 B）

describe('辅助平面字符作外侧字符或核心首末字符', () => {
    const ASTRAL = [['辅助平面符号 U+1F600', EMOJI], ['辅助平面汉字 U+20000', EXT_B]];
    // [名称, 前 run 文本 | null, 核心, 后 run 文本 | null]
    const contexts = (astral) => [
        ['外侧为辅助平面字符、核心两端为书名号', astral, '《甲》', astral],
        ['外侧为辅助平面字符、核心为汉字', astral, '甲', astral],
        ['外侧为汉字、核心只有辅助平面字符', '甲', astral, '乙'],
        ['外侧为汉字、核心以辅助平面字符开头', '甲', `${astral}文`, '乙'],
        ['外侧为汉字、核心以辅助平面字符结尾', '甲', `文${astral}`, '乙'],
        ['外侧与核心都是辅助平面字符', astral, astral, astral],
        ['外侧为全角括号、核心为书名号包着辅助平面字符', '（', `《${astral}》`, '）'],
        ['外侧为辅助平面字符、核心以书名号开头并以辅助平面字符结尾', astral, `《甲${astral}`, astral],
        ['段首、核心以辅助平面字符开头并以句号结尾、后接汉字', null, `${astral}结论。`, '乙'],
    ];
    for (const [formatName, rPr, wrap] of FORMATS) {
        for (const [charName, astral] of ASTRAL) {
            test(`${formatName} × ${charName}`, async () => {
                for (const [name, before, core, after] of contexts(astral)) {
                    const runs = [before === null ? '' : plain(before), run(text(core), rPr), after === null ? '' : plain(after)].filter(Boolean);
                    const expected = [before, wrap(core), after].filter((item) => item !== null);
                    const actual = firstOfTwoParagraphs(await convertParagraph(runs));
                    assert.ok(matches(actual, expected), `${name}：实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
                }
            });
        }
    }
});

// ============================================================
// 端到端产物：md 渲染器、generic XML 与 patent XML
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

// roundTrip 为 false 的形态：IR 正确，但 renderers/md 自身在两对定界符相邻时同样会把星号串合并（「**加粗***。*」），
// 属该渲染器的独立缺陷、不在本次范围，故只断言 md 产物无转义星号，不做重新解析比对
const E2E_CASES = [
    { name: 'U1', runs: [plain('依据'), bold('《专利法》'), plain('的规定')], text: '依据《专利法》的规定', b: ['《专利法》'], i: [], roundTrip: true },
    { name: 'U2', runs: [plain('前文'), run(text('加粗'), BOLD + UNDERLINE), plain('后文')], text: '前文加粗后文', b: ['加粗'], i: [], roundTrip: true },
    { name: 'U3', runs: [boldItalic('甲'), italic('乙')], text: '甲乙', b: ['甲'], i: ['甲', '乙'], roundTrip: true },
    { name: 'U4', runs: [bold('加粗'), italic('。')], text: '加粗。', b: ['加粗'], i: ['。'], roundTrip: false },
    { name: 'U5', runs: [bold('注意：'), plain('本发明')], text: '注意：本发明', b: ['注意：'], i: [], roundTrip: true },
];
// generic XML 对只含元素的容器按缩进排版，比对文字时去掉全部空白
const squash = (value) => value.replace(/\s/g, '');

describe('端到端产物：无字面星号，加粗与斜体落到对应元素', () => {
    for (const { name, runs, text: plainText, b, i, roundTrip } of E2E_CASES) {
        test(`${name}：generic XML 只有一个 <p>，<b>/<i> 文字与原文一致`, async () => {
            const doc = await convertParagraph(runs);
            const $ = await renderGenericXml(doc);

            const paragraphs = $('body > p');
            assert.equal(paragraphs.length, 2, 'Word 的两段各对应一个 <p>');
            const first = paragraphs.first();
            assert.equal(squash(first.text()), plainText);
            assert.ok(!first.text().includes('*'));
            assert.deepEqual(first.find('b').map((_, el) => squash($(el).text())).get(), b);
            assert.deepEqual(first.find('i').map((_, el) => squash($(el).text())).get(), i);
            assert.equal(paragraphs.last().text(), NEXT);
        });

        test(`${name}：md 产物无转义星号${roundTrip ? '，经 remark 重新解析得到同样的两段结构' : '（重新解析比对见 roundTrip 说明）'}`, async () => {
            const doc = await convertParagraph(runs);
            const markdown = await mdRenderer.render(doc);

            assert.ok(!markdown.includes('\\*'), JSON.stringify(markdown));
            if (roundTrip) assert.deepEqual(await reparseMarkdown(markdown), doc.ir.children.map(brief), JSON.stringify(markdown));
        });
    }

    test('patent XML：说明书段落中的书名号加粗与冒号加粗落为 <b>，产物不含字面星号', async () => {
        // 分节按书目标题段（短段）识别；只给权利要求书、说明书与摘要，其余缺节仅产生提示
        const body = [
            paragraph([plain('发明名称：一种测试装置')]),
            paragraph([plain('权利要求书')]),
            paragraph([plain('1. 一种测试装置，其特征在于，包括壳体。')]),
            paragraph([plain('说明书')]),
            paragraph([plain('技术领域')]),
            paragraph([plain('本发明依据'), bold('《专利法》'), plain('的规定；'), bold('注意：'), plain('壳体为筒状。')]),
            paragraph([plain('说明书摘要')]),
            paragraph([plain('本发明公开了一种测试装置。')]),
        ].join('');
        const doc = await parse({ buffer: await buildDocx(body) }, { sourceName: '专利样例.docx' });
        assertClean(doc.ir);
        const result = await xmlRenderer.render(doc, normalizeOptions({ xml: { profile: 'patent' } }));
        const description = result.files['100002/100002.xml'];
        assert.ok(description, `说明书文件缺失：${Object.keys(result.files).join(', ')}`);
        assert.ok(!description.includes('*'), description);
        const $ = load(description, { xmlMode: true });
        assert.deepEqual($('b').map((_, el) => $(el).text()).get(), ['《专利法》', '注意：']);
    });
});

// ============================================================
// turndown 层：word profile 的定界符写法
// ============================================================

describe('turndown word profile：只在定界符会失效时改用 HTML 标签', () => {
    const toMarkdown = (html) => createTurndownService('word').turndown(html);

    test('核心两端为标点：外侧是空白、标点、串首或串尾时仍写定界符，外侧是汉字或字母时改写为标签', () => {
        assert.equal(toMarkdown('<p>依据<strong>《专利法》</strong>的规定</p>'), '依据<strong>《专利法》</strong>的规定');
        assert.equal(toMarkdown('<p>（<strong>《专利法》</strong>）</p>'), '（**《专利法》**）');
        assert.equal(toMarkdown('<p>前文 <strong>《专利法》</strong> 后文</p>'), '前文 **《专利法》** 后文');
        assert.equal(toMarkdown('<p><strong>《专利法》</strong></p>'), '**《专利法》**');
        assert.equal(toMarkdown('<p><strong>注意：</strong>本发明</p>'), '<strong>注意：</strong>本发明');
        assert.equal(toMarkdown('<p>依据<em>《专利法》</em>规定</p>'), '依据<em>《专利法》</em>规定');
        assert.equal(toMarkdown('<p>see <em>"quoted"</em>.</p>'), 'see *"quoted"*.');
        assert.equal(toMarkdown('<p>a<em>"quoted"</em>b</p>'), 'a<em>"quoted"</em>b');
        // 核心两端是汉字或字母时与外侧无关
        assert.equal(toMarkdown('<p>依据<strong>专利法</strong>的规定</p>'), '依据**专利法**的规定');
    });

    test('内层标签与图片处在边界上时按最终输出的相邻字符判定', () => {
        assert.equal(toMarkdown('<p>前文<strong><u>加粗</u></strong>后文</p>'), '前文<strong><u>加粗</u></strong>后文');
        assert.equal(toMarkdown('<p><strong><u>加粗</u></strong></p>'), '**<u>加粗</u>**');
        assert.equal(toMarkdown('<p>前文<strong>甲<sup>2</sup></strong>后文</p>'), '前文<strong>甲<sup>2</sup></strong>后文');
        assert.equal(toMarkdown('<p>前文<strong>甲<img src="a.png" alt="图"></strong>后文</p>'), '前文<strong>甲![图](a.png)</strong>后文');
        assert.equal(toMarkdown('<p><strong>甲<img src="a.png" alt="图"></strong></p>'), '**甲![图](a.png)**');
    });

    test('两对定界符相邻时改写为标签；加粗恰好整段包住斜体时保留 ***X***', () => {
        assert.equal(toMarkdown('<p><strong><em>甲</em></strong></p>'), '***甲***');
        assert.equal(toMarkdown('<p>前文<strong><em>甲</em></strong>后文</p>'), '前文***甲***后文');
        assert.equal(toMarkdown('<p>依据<strong><em>《专利法》</em></strong>规定</p>'), '依据<strong><em>《专利法》</em></strong>规定');
        assert.equal(toMarkdown('<p><strong><em>甲</em></strong><em>乙</em></p>'), '<strong><em>甲</em></strong><em>乙</em>');
        assert.equal(toMarkdown('<p><strong>加粗</strong><em>。</em></p>'), '<strong>加粗</strong><em>。</em>');
        assert.equal(toMarkdown('<p><strong>甲</strong><em>乙</em></p>'), '<strong>甲</strong><em>乙</em>');
        assert.equal(toMarkdown('<p><strong>甲<em>乙</em></strong></p>'), '<strong>甲<em>乙</em></strong>');
        assert.equal(toMarkdown('<p><strong>甲</strong> <em>乙</em></p>'), '**甲** *乙*');
        assert.equal(toMarkdown('<p><strong>甲<em>乙</em>丙</strong></p>'), '**甲*乙*丙**');
    });

    test('辅助平面字符：作外侧字符时按「其他」归类，作核心首末字符时按码点归类，两种归类取其严', () => {
        // 外侧是辅助平面符号、核心两端为标点：micromark 把代理项码元归为「其他」，写定界符即失效，故改写为标签
        assert.equal(toMarkdown(`<p>${EMOJI}<strong>《甲》</strong>${EMOJI}</p>`), `${EMOJI}<strong>《甲》</strong>${EMOJI}`);
        assert.equal(toMarkdown(`<p>${EXT_B}<strong>《甲》</strong>${EXT_B}</p>`), `${EXT_B}<strong>《甲》</strong>${EXT_B}`);
        // 外侧是辅助平面字符、核心两端为汉字：与外侧无关，仍写定界符
        assert.equal(toMarkdown(`<p>${EMOJI}<strong>甲</strong>${EMOJI}</p>`), `${EMOJI}**甲**${EMOJI}`);
        // 核心首末是辅助平面符号（按码点为符号）而外侧为汉字：从严改写为标签；辅助平面汉字按码点为「其他」，仍写定界符
        assert.equal(toMarkdown(`<p>甲<strong>${EMOJI}</strong>乙</p>`), `甲<strong>${EMOJI}</strong>乙`);
        assert.equal(toMarkdown(`<p>甲<strong>${EXT_B}</strong>乙</p>`), `甲**${EXT_B}**乙`);
        assert.equal(toMarkdown(`<p><strong>${EMOJI}</strong> 乙</p>`), `**${EMOJI}** 乙`);
        // 整段包住走同一规则：外侧为汉字时改写（嵌套次序随之为 strong(emphasis)），外侧为串首串尾时保留 ***X***
        assert.equal(toMarkdown(`<p>甲<strong><em>${EMOJI}</em></strong>乙</p>`), `甲<strong><em>${EMOJI}</em></strong>乙`);
        assert.equal(toMarkdown(`<p><strong><em>${EMOJI}</em></strong></p>`), `***${EMOJI}***`);
        assert.equal(toMarkdown(`<p>${EMOJI}<strong><em>《甲》</em></strong>${EMOJI}</p>`), `${EMOJI}<strong><em>《甲》</em></strong>${EMOJI}`);
    });

    test('同类嵌套：内外两对都改写为标签（内层的开定界符会与外层配对），提升后拍平为一个节点', async () => {
        assert.equal(toMarkdown('<p><strong>甲<strong>乙</strong>丙</strong></p>'), '<strong>甲<strong>乙</strong>丙</strong>');
        assert.equal(toMarkdown('<p><em>甲<em>乙</em>丙</em></p>'), '<em>甲<em>乙</em>丙</em>');
        assert.deepEqual(await reparseMarkdown(toMarkdown('<p><strong>甲<strong>乙</strong>丙</strong></p>')), [{ paragraph: [strong('甲乙丙')] }]);
    });

    test('核心含换行时改写为标签：标题内处在强调中段的换行不再产出字面星号', () => {
        assert.equal(toMarkdown('<h1>前<strong>标题<br />乙</strong></h1>'), '# 前<strong>标题  \n乙</strong>');
    });

    test('输入混入与哨兵同码点的控制字符：按栈配对，配不成对的一律删除，不外泄', () => {
        // 与实现约定相同的四个码点：U+001C–U+001F（加粗开、加粗闭、斜体开、斜体闭）
        for (const code of [0x1c, 0x1d, 0x1e, 0x1f]) {
            const stray = fromCode(code);
            const markdown = toMarkdown(`<p>前${stray}文<strong>加粗</strong>后${stray}文</p>`);
            assert.ok(!C0_CONTROL_RE.test(markdown), JSON.stringify(markdown));
            assert.equal(markdown, '前文**加粗**后文');
        }
        // 混入强调内部时与真正的哨兵就近配对：混入的闭哨兵与规则写出的开哨兵成对，规则写出的闭哨兵成为孤儿；混入的开哨兵反之
        assert.equal(toMarkdown(`<p>前<strong>甲${fromCode(0x1d)}乙</strong>后</p>`), '前**甲**乙后');
        assert.equal(toMarkdown(`<p>前<strong>甲${fromCode(0x1c)}乙</strong>后</p>`), '前甲**乙**后');
        // 核心只剩孤儿时整对删除
        assert.equal(toMarkdown(`<p>前<strong>${fromCode(0x1f)}</strong>后</p>`), '前后');
    });
});
