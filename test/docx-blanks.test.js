/**
 * docx 填空横线（converters/parsers/docx-blanks.js 与 parsers/docx 的接线）
 * 成因：Word 的填空是带下划线的空格串，mammoth 输出 <u>      </u>；turndown 先把连续的 ASCII 空白折成一个空格，再把只含空白的
 *       行内元素判为空白元素、连标签一起删除，只在元素外留下一个普通空格，段首段尾时连它也被 trim 掉，填空连同宽度一起丢失。
 *       修法是在 turndown 之前把只含空白的 <u> / <s> 里的空白换成私用区占位符，remark 解析之后换回。
 * 覆盖：
 *   - 修复对象：只含空白的下划线 run 在段中、段尾、段首、整段、标题、列表项与表格单元格中；半角空格、全角空格、U+00A0、
 *     制表符混合，长短不一；与加粗、斜体、删除线嵌套或相邻；同段多个填空。修复前这些 run 连同空白一起丢失或折成一个空格
 *   - 回归护栏（修复前后 IR 相同）：有文字的下划线、有文字的下划线带尾空格与同格式相邻的填空（mammoth 并成一个元素，
 *     已知限制）、加粗空格、只含换行或空白夹换行的下划线
 *   - 单元：占位符表与 \s 同集；protectBlanks 只改只含空白的 <u> / <s>、其余原样、无改动时返回原引用；TAB 标记混在填空里
 *     时保留；restoreBlanks 不改动入参、无占位符时返回原引用；十万个空格的填空个数不变
 *   - 端到端：md 产物重新解析后结构不变；generic XML 保留 <u> 与空格；docx 渲染后再解析，空格个数与格式不变
 * 删除线：只含空白的 <s> 经保护后由 word profile 的删除线规则写成标签，经 ir/inline-html 还原为带原空白的 delete 节点（B15）；
 *         与下划线嵌套时 delete 在内层（B14）
 * 夹具一律由 JSZip 按 OOXML 现造，run 的 XML 逐字可控，正文为虚构示例。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { load } = require('cheerio');

const { parse } = require('../converters/parsers/docx');
const { protectBlanks, restoreBlanks, BLANK_CODES } = require('../converters/parsers/docx-blanks');
const mdRenderer = require('../converters/renderers/md');
const docxRenderer = require('../converters/renderers/docx');
const xmlRenderer = require('../converters/renderers/xml');
const { normalizeOptions } = require('../converters/options');
const { loadUnified } = require('../converters/ir/unified-loader');
const { liftInlineHtml } = require('../converters/ir/inline-html');
const { MARKERS } = require('../converters/ir/markers');

// 不可见字符以码点生成，源码不出现看不见的字面量：U+3000 全角空格、U+00A0 不换行空格、U+0009 制表符
const IDEO = String.fromCharCode(0x3000);
const NBSP = String.fromCharCode(0xa0);
const TAB = String.fromCharCode(0x09);
const SP = (count) => ' '.repeat(count);
// 占位符码位（与 converters/parsers/docx-blanks 一致），用于断言不外泄
const PLACEHOLDER_FIRST = 0xef40;
const PLACEHOLDER_LAST = PLACEHOLDER_FIRST + BLANK_CODES.length - 1;
const PLACEHOLDER_RE = new RegExp(`[${String.fromCharCode(PLACEHOLDER_FIRST)}-${String.fromCharCode(PLACEHOLDER_LAST)}]`);
const BMP_LAST = 0xffff;
const HUGE_BLANK = 100000;

// ============================================================
// 夹具：JSZip 现造的最小 docx（正文段 + 第二段「下一段」，另带 heading 1 样式与一个无序编号定义）
// ============================================================

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NEXT = '下一段';

const text = (value) => `<w:t xml:space="preserve">${value}</w:t>`;
const BR = '<w:br/>';
const WTAB = '<w:tab/>';
const BOLD = '<w:b/>';
const ITALIC = '<w:i/>';
const STRIKE = '<w:strike/>';
const UNDERLINE = '<w:u w:val="single"/>';
const HEADING_1 = '<w:pStyle w:val="1"/>';
const BULLET = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>';
const run = (content, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${content}</w:r>`;
const plain = (value) => run(text(value));
const blank = (value, rPr = UNDERLINE) => run(text(value), rPr);
const paragraph = (runs, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs.join('')}</w:p>`;
const cell = (runs) => `<w:tc>${paragraph(runs)}</w:tc>`;
const table = (cells) => `<w:tbl><w:tr>${cells.join('')}</w:tr></w:tbl>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W_NS}">`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>'
    + '</w:styles>';
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

/** 被测块（默认为段落）+ 第二段「下一段」→ parsers/docx 全链路 → MarkFlowDocument */
async function convertBlock(bodyXml) {
    return parse({ buffer: await buildDocx(bodyXml + paragraph([plain(NEXT)])) }, { sourceName: '填空样例.docx' });
}

const convertParagraph = (runs, pPr = '') => convertBlock(paragraph(runs, pPr));

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

function plainText(node) {
    if (node.type === 'text') return node.value;
    return (node.children || []).map(plainText).join('');
}

/** 不残留 html 节点，任一文本节点不含字面星号，也不含占位符 */
function assertClean(ir) {
    walk(ir, (node) => {
        assert.notEqual(node.type, 'html', `残留 html 节点：${JSON.stringify(node.value)}`);
        if (node.type === 'text') {
            assert.ok(!node.value.includes('*'), `文本含字面星号：${JSON.stringify(node.value)}`);
            assert.ok(!PLACEHOLDER_RE.test(node.value), `占位符外泄：${JSON.stringify(node.value)}`);
        }
    });
}

/** 顶层恰为两个段落（检出拆段与丢段），第二段为「下一段」；返回首段子节点的简式 */
function firstOfTwoParagraphs(doc) {
    assertClean(doc.ir);
    assert.deepEqual(doc.ir.children.map((node) => node.type), ['paragraph', 'paragraph'], '被测段落不得拆段或丢失');
    assert.deepEqual(brief(doc.ir.children[1]), { paragraph: [NEXT] });
    return doc.ir.children[0].children.map(brief);
}

const strong = (...children) => ({ strong: children });
const emphasis = (...children) => ({ emphasis: children });
const underline = (...children) => ({ underline: children });
const del = (...children) => ({ delete: children });

// ============================================================
// 修复对象（修复前填空连同空白丢失，或只剩一个普通空格）
// ============================================================

const FIX_CASES = [
    {
        name: 'B1 段中 6 个半角空格',
        runs: [plain('甲方：'), blank(SP(6)), plain('（盖章）')],
        expected: ['甲方：', underline(SP(6)), '（盖章）'],
    },
    {
        name: 'B2 段尾 6 个半角空格',
        runs: [plain('甲方：'), blank(SP(6))],
        expected: ['甲方：', underline(SP(6))],
    },
    {
        name: 'B3 段首 6 个半角空格',
        runs: [blank(SP(6)), plain('（盖章）')],
        expected: [underline(SP(6)), '（盖章）'],
    },
    {
        name: 'B4 整段只有填空：段落保留',
        runs: [blank(SP(6))],
        expected: [underline(SP(6))],
    },
    {
        name: 'B5 3 个全角空格',
        runs: [plain('甲方：'), blank(IDEO.repeat(3)), plain('（盖章）')],
        expected: ['甲方：', underline(IDEO.repeat(3)), '（盖章）'],
    },
    {
        name: 'B6 3 个 U+00A0',
        runs: [plain('甲方：'), blank(NBSP.repeat(3)), plain('（盖章）')],
        expected: ['甲方：', underline(NBSP.repeat(3)), '（盖章）'],
    },
    {
        name: 'B7 半角空格、全角空格、制表符混合：制表符经 TAB 标记还原为 \\t，次序不变',
        runs: [plain('甲方：'), run(text(` ${IDEO}`) + WTAB + text('  '), UNDERLINE), plain('（盖章）')],
        expected: ['甲方：', underline(` ${IDEO}${TAB}  `), '（盖章）'],
    },
    {
        name: 'B8 单个半角空格',
        runs: [plain('甲'), blank(' '), plain('乙')],
        expected: ['甲', underline(' '), '乙'],
    },
    {
        name: 'B9 30 个半角空格（长填空）',
        runs: [plain('签名：'), blank(SP(30))],
        expected: ['签名：', underline(SP(30))],
    },
    {
        name: 'B10 加粗下划线空格：strong 包着 underline',
        runs: [plain('甲方：'), blank(SP(4), BOLD + UNDERLINE), plain('（盖章）')],
        expected: ['甲方：', strong(underline(SP(4))), '（盖章）'],
    },
    {
        name: 'B11 斜体下划线空格：emphasis 包着 underline',
        runs: [plain('甲方：'), blank(SP(4), ITALIC + UNDERLINE), plain('（盖章）')],
        expected: ['甲方：', emphasis(underline(SP(4))), '（盖章）'],
    },
    {
        name: 'B12 同段两个填空，长短各异',
        runs: [plain('日期：'), blank(SP(4)), plain('年'), blank(SP(2)), plain('月')],
        expected: ['日期：', underline(SP(4)), '年', underline(SP(2)), '月'],
    },
    {
        name: 'B13 相邻的不同格式填空：mammoth 不合并，各自保留',
        runs: [plain('甲'), blank(SP(2)), blank(SP(3), BOLD + UNDERLINE), plain('乙')],
        expected: ['甲', underline(SP(2)), strong(underline(SP(3))), '乙'],
    },
];

describe('修复对象：只含空白的下划线 run 保留为带原空白的 underline 节点', () => {
    for (const { name, runs, expected } of FIX_CASES) {
        test(name, async () => {
            const doc = await convertParagraph(runs);
            assert.deepEqual(firstOfTwoParagraphs(doc), expected);
        });
    }

    test('B14 下划线加删除线嵌套的空格：underline 包着 delete，空格个数保住', async () => {
        const doc = await convertParagraph([plain('甲方：'), blank(SP(4), STRIKE + UNDERLINE), plain('（盖章）')]);

        assert.deepEqual(firstOfTwoParagraphs(doc), ['甲方：', underline(del(SP(4))), '（盖章）']);
    });

    test('B15 只有删除线的空格：保留为带原空白的 delete 节点（修复前折成一个空格）', async () => {
        const doc = await convertParagraph([plain('甲方：'), blank(SP(4), STRIKE), plain('（盖章）')]);

        assert.deepEqual(firstOfTwoParagraphs(doc), ['甲方：', del(SP(4)), '（盖章）']);
    });

    test('B16 标题内的填空', async () => {
        const doc = await convertParagraph([plain('第'), blank(SP(3)), plain('条')], HEADING_1);

        assertClean(doc.ir);
        assert.deepEqual(doc.ir.children.map(brief), [{ heading: ['第', underline(SP(3)), '条'] }, { paragraph: [NEXT] }]);
    });

    test('B17 列表项内的填空', async () => {
        const doc = await convertParagraph([plain('项：'), blank(SP(4)), plain('元')], BULLET);

        assertClean(doc.ir);
        assert.deepEqual(doc.ir.children.map(brief), [
            { list: [{ listItem: [{ paragraph: ['项：', underline(SP(4)), '元'] }] }] },
            { paragraph: [NEXT] },
        ]);
    });

    test('B18 表格单元格内的填空：单元格文本保住空格个数（GFM 单元格不留格式），grid 保留 underline 节点', async () => {
        const doc = await convertBlock(table([cell([plain('名称：'), blank(SP(6))]), cell([blank(SP(4)), plain('元')])]));

        assertClean(doc.ir);
        const [tableNode, next] = doc.ir.children;
        assert.equal(tableNode.type, 'table');
        assert.deepEqual(brief(next), { paragraph: [NEXT] });
        const cells = tableNode.children[0].children;
        assert.deepEqual(cells.map((node) => plainText(node)), [`名称：${SP(6)}`, `${SP(4)}元`]);
        assert.deepEqual(tableNode.data.grid.rows[0].cells.map((item) => item.paragraphs), [
            [[{ type: 'text', value: '名称：' }, { type: 'underline', children: [{ type: 'text', value: SP(6) }] }]],
            [[{ type: 'underline', children: [{ type: 'text', value: SP(4) }] }, { type: 'text', value: '元' }]],
        ]);
    });
});

// ============================================================
// 回归护栏（修复前后都应通过）
// ============================================================

const GUARD_CASES = [
    {
        name: 'G1 有文字的下划线',
        runs: [plain('甲方：'), blank('张三'), plain('（盖章）')],
        expected: ['甲方：', underline('张三'), '（盖章）'],
    },
    {
        name: 'G2 有文字的下划线带尾空格：尾空格仍由 turndown 移到元素外并折叠（已知限制，按现状断言）',
        runs: [plain('甲方：'), blank(`张三${SP(3)}`), plain('（盖章）')],
        expected: ['甲方：', underline('张三'), ' （盖章）'],
    },
    {
        name: 'G3 文字 run 与填空 run 同为下划线：mammoth 并成一个元素，同 G2（已知限制，按现状断言）',
        runs: [plain('甲方：'), blank('张三'), blank(SP(3)), plain('（盖章）')],
        expected: ['甲方：', underline('张三'), ' （盖章）'],
    },
    {
        name: 'G4 只有加粗的空格：无可见形态，仍折叠为一个空格',
        runs: [plain('甲方：'), blank(SP(4), BOLD), plain('（盖章）')],
        expected: ['甲方： （盖章）'],
    },
    {
        name: 'G5 下划线只含换行：格式帧仍拆除',
        runs: [plain('前文'), run(BR, UNDERLINE), plain('后文')],
        expected: ['前文', 'BR', '后文'],
    },
    {
        name: 'G6 下划线空白夹换行：不算填空，仍按既有路径处理',
        runs: [plain('前文'), run(text('  ') + BR + text('  '), UNDERLINE), plain('后文')],
        expected: ['前文', 'BR', '后文'],
    },
];

describe('回归护栏：有文字的下划线、无可见形态的空格与含换行的帧 IR 不变', () => {
    for (const { name, runs, expected } of GUARD_CASES) {
        test(name, async () => {
            const doc = await convertParagraph(runs);
            assert.deepEqual(firstOfTwoParagraphs(doc), expected);
        });
    }
});

// ============================================================
// 单元：protectBlanks / restoreBlanks
// ============================================================

describe('单元：protectBlanks 与 restoreBlanks', () => {
    const ALL_BLANKS = BLANK_CODES.map((code) => String.fromCharCode(code)).join('');

    test('占位符表 BLANK_CODES 与 /\\s/ 在基本多文种平面上同集', () => {
        const matched = [];
        for (let code = 0; code <= BMP_LAST; code += 1) {
            if (/\s/.test(String.fromCharCode(code))) matched.push(code);
        }
        assert.deepEqual(matched, [...BLANK_CODES]);
    });

    test('只含空白的 <u> / <s> 逐字符换成占位符，元素内不再有空白；restoreBlanks 逐字换回', () => {
        const html = `<p>甲<u>${ALL_BLANKS}</u>乙<s>${SP(3)}</s>丙</p>`;
        const protectedHtml = protectBlanks(html);

        const inner = /<u>(.*?)<\/u>/su.exec(protectedHtml)[1];
        assert.equal(inner.length, ALL_BLANKS.length);
        assert.ok(!/\s/.test(inner), '元素内不得残留空白字符');
        assert.ok(/<s>[^\s<]{3}<\/s>/.test(protectedHtml));
        assert.equal(protectedHtml.replace(/<u>.*?<\/u>|<s>.*?<\/s>/gsu, ''), '<p>甲乙丙</p>');

        const tree = { type: 'paragraph', children: [{ type: 'text', value: inner }, { type: 'text', value: '乙' }] };
        const restored = restoreBlanks(tree);
        assert.equal(restored.children[0].value, ALL_BLANKS);
        assert.equal(restored.children[1], tree.children[1], '未变的子节点保持原引用');
        assert.equal(tree.children[0].value, inner, '不改动入参');
    });

    test('有文字、夹着 <br>、只含 TAB 标记、加粗与未闭合的元素不处理；嵌套时只处理最内层的空白元素', () => {
        const untouched = [
            '<u>张三 </u>', '<u> 张三</u>', '<u> <br /> </u>', `<u>${MARKERS.TAB}${MARKERS.TAB}</u>`, '<strong>    </strong>',
            '<em>  </em>', '<sup> </sup>', '<u>    ', '<u></u>', '<s>甲</s>',
        ];
        for (const html of untouched) assert.equal(protectBlanks(html), html, html);
        // 无可保护的元素时返回原引用
        const source = '<p>甲<u>乙</u></p>';
        assert.equal(protectBlanks(source), source);

        const nested = protectBlanks('<p><u><s>   </s></u></p>');
        assert.ok(/^<p><u><s>[^\s<]{3}<\/s><\/u><\/p>$/.test(nested), nested);
        // TAB 标记混在空白里时算填空内容、原样保留，只换其余两个空格
        const mixed = protectBlanks(`<u> ${MARKERS.TAB} </u>`);
        assert.equal(mixed.length, `<u> ${MARKERS.TAB} </u>`.length);
        assert.ok(/^<u>[^\s<]{2}<\/u>$/.test(mixed.replace(MARKERS.TAB, '')), JSON.stringify(mixed));
        assert.equal(mixed[4], MARKERS.TAB);
    });

    test('restoreBlanks 无占位符时返回原引用，有占位符时不改动入参', () => {
        const tree = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: '甲 乙' }] }] };
        assert.equal(restoreBlanks(tree), tree);

        const placeholder = String.fromCharCode(PLACEHOLDER_FIRST + BLANK_CODES.indexOf(0x20));
        const withPlaceholder = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: `甲${placeholder}乙` }] }] };
        const restored = restoreBlanks(withPlaceholder);
        assert.equal(restored.children[0].children[0].value, '甲 乙');
        assert.equal(withPlaceholder.children[0].children[0].value, `甲${placeholder}乙`);
        assert.notEqual(restored, withPlaceholder);
    });

    test('十万个空格的填空：空格个数不变', async () => {
        const doc = await convertParagraph([plain('签名：'), blank(SP(HUGE_BLANK))]);

        assert.deepEqual(firstOfTwoParagraphs(doc), ['签名：', underline(SP(HUGE_BLANK))]);
    });
});

// ============================================================
// 端到端：md 往返、generic XML 与 docx 往返
// ============================================================

/** md 产物经 remark（+ GFM）重新解析、再经 liftInlineHtml 提升后的顶层简式 */
async function reparseMarkdown(markdown) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    const tree = liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(markdown), { source: 'md' });
    return tree.children.map(brief);
}

async function renderGenericXml(doc) {
    const result = await xmlRenderer.render(doc, normalizeOptions({ xml: { profile: 'generic' } }));
    return load(result.files['{name}.xml'], { xmlMode: true });
}

const caseOf = (id) => FIX_CASES.find((item) => item.name.startsWith(`${id} `));

describe('端到端：md 往返、generic XML 与 docx 往返均保住填空', () => {
    for (const id of ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B10', 'B12', 'B13']) {
        const { runs, expected } = caseOf(id);

        test(`${id}：md 产物经 remark 重新解析得到同样的结构`, async () => {
            const doc = await convertParagraph(runs);
            const markdown = await mdRenderer.render(doc);

            const structure = [{ paragraph: expected }, { paragraph: [NEXT] }];
            assert.deepEqual(doc.ir.children.map(brief), structure);
            assert.deepEqual(await reparseMarkdown(markdown), structure, JSON.stringify(markdown));
        });
    }

    test('B1：generic XML 的 <p> 内保留 <u> 与其中的 6 个空格', async () => {
        const doc = await convertParagraph(caseOf('B1').runs);
        const $ = await renderGenericXml(doc);

        const first = $('body > p').first();
        assert.equal(first.text(), `甲方：${SP(6)}（盖章）`);
        assert.deepEqual(first.find('u').map((i, el) => $(el).text()).get(), [SP(6)]);
    });

    for (const id of ['B1', 'B5', 'B7', 'B10']) {
        const { runs, expected } = caseOf(id);

        test(`${id}：docx 渲染后再解析，填空的空白与格式不变`, async () => {
            const doc = await convertParagraph(runs);
            const buffer = await docxRenderer.render(doc, normalizeOptions({}));
            const again = await parse({ buffer }, { sourceName: '往返.docx' });

            assert.deepEqual(firstOfTwoParagraphs(again), expected);
        });
    }
});
