/**
 * docx 段落中的删除线进入 IR（converters/ir/turndown.js 的 word profile：mammoth 输出的 <s> 写成 <s> 标签，首尾换行剥到
 * 标签之外，由 ir/inline-html 还原为 delete 节点）
 * 覆盖：全链路——段中、段首、段尾、整段；双删除线（经 parsers/docx-layout 改写为单删除线）；删除线文字含「~」「*」「_」「<」
 *       「&」「\」与反引号、以中文标点开头或结尾而两侧紧贴汉字、两侧紧贴字面「~」；与加粗、斜体、下划线、上下标组合（mammoth
 *       把 <s> 置于最内层）；与加粗、斜体 run 相邻；加粗 run 中段的删除线与删除线 run 中段的加粗；段中换行留在 delete 之内，
 *       删除线 run 首尾的换行留在 delete 之外，处在段首、段尾、列表项开头与超链接开头时不输出，整段不因此成为 html 块、列表项
 *       不因此变空；标题内的换行照旧拆开标题，拆开的两侧各自成为 delete；超链接、列表项、标题、脚注与脚注引用标号中的删除线；
 *       正文段落与标题中，换行与空白处在删除线首、尾、中段的各种写法去掉 delete 后与不带删除线的对照文档逐项相等。
 *       turndown 层——word profile 输出 <s> 标签而非 ~~，文本中的「~」照常转义；url 与 basic profile 的产物不变。
 * 夹具一律由 JSZip 按 OOXML 现造，run 的 XML 逐字可控，正文为虚构示例。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const { parse } = require('../converters/parsers/docx');
const { createTurndownService } = require('../converters/ir/turndown');

// ============================================================
// 夹具：JSZip 现造的最小 docx（heading 1 样式、无序编号定义、外部超链接，可选脚注部件）
// ============================================================

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const LINK_URL = 'https://example.com/';
const FOOTNOTES_PART = 'word/footnotes.xml';

const xmlText = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (value) => `<w:t xml:space="preserve">${xmlText(value)}</w:t>`;
const BR = '<w:br/>';
const BOLD = '<w:b/>';
const ITALIC = '<w:i/>';
const UNDERLINE = '<w:u w:val="single"/>';
const STRIKE = '<w:strike/>';
const SUP = '<w:vertAlign w:val="superscript"/>';
const SUB = '<w:vertAlign w:val="subscript"/>';
const HEADING_1 = '<w:pStyle w:val="1"/>';
const BULLET = '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>';
const run = (content, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${content}</w:r>`;
const plain = (value) => run(text(value));
const bold = (value) => run(text(value), BOLD);
const italic = (value) => run(text(value), ITALIC);
const struck = (value, rPr = '') => run(text(value), `${rPr}${STRIKE}`);
const link = (runs) => `<w:hyperlink r:id="rIdLink">${runs.join('')}</w:hyperlink>`;
const paragraph = (runs, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs.join('')}</w:p>`;
const footnoteReference = (rPr = '') => run('<w:footnoteReference w:id="1"/>', rPr);

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W_NS}">`
    + '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>'
    + '</w:styles>';
// mammoth 以 numFmt 是否为 bullet 判定有序或无序
const NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W_NS}">`
    + '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="-"/></w:lvl></w:abstractNum>'
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';
const contentTypes = (withNotes) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + (withNotes ? `<Override PartName="/${FOOTNOTES_PART}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>` : '')
    + '</Types>';
const relationships = (items) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map(([id, type, target, external]) => `<Relationship Id="${id}" Type="${R_NS}/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`).join('')
    + '</Relationships>';
// 脚注部件：两条分隔符（mammoth 按 w:type 滤掉）+ 编号 1 的被测脚注
const footnotesXml = (paragraphXml) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="${W_NS}">`
    + '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>'
    + '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
    + `<w:footnote w:id="1">${paragraphXml}</w:footnote></w:footnotes>`;

/** 正文 + 可选的脚注段落 → 最小 docx */
async function buildDocx(bodyXml, footnoteXml = null) {
    const zip = new JSZip();
    const withNotes = footnoteXml !== null;
    zip.file('[Content_Types].xml', contentTypes(withNotes));
    zip.file('_rels/.rels', relationships([['rId1', 'officeDocument', 'word/document.xml']]));
    zip.file('word/_rels/document.xml.rels', relationships([
        ['rId1', 'styles', 'styles.xml'], ['rId2', 'numbering', 'numbering.xml'], ['rIdLink', 'hyperlink', LINK_URL, true],
        ...(withNotes ? [['rId3', 'footnotes', 'footnotes.xml']] : []),
    ]));
    zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`);
    zip.file('word/styles.xml', STYLES_XML);
    zip.file('word/numbering.xml', NUMBERING_XML);
    if (withNotes) zip.file(FOOTNOTES_PART, footnotesXml(footnoteXml));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const convert = async (bodyXml, footnoteXml) => parse({ buffer: await buildDocx(bodyXml, footnoteXml) }, { sourceName: '删除线样例.docx' });

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

/** 不残留 html 节点（<s> 标签未被提升、或整段成为 html 块时即残留） */
function assertNoHtml(ir) {
    walk(ir, (node) => assert.notEqual(node.type, 'html', `残留 html 节点：${JSON.stringify(node.value)}`));
}

/** 顶层恰为一个段落，返回其子节点的简式 */
async function onlyParagraph(runs) {
    const doc = await convert(paragraph(runs));
    assertNoHtml(doc.ir);
    assert.deepEqual(doc.ir.children.map((node) => node.type), ['paragraph'], '被测段落不得拆段或丢失');
    return doc.ir.children[0].children.map(brief);
}

const del = (...children) => ({ delete: children });
const strong = (...children) => ({ strong: children });
const emphasis = (...children) => ({ emphasis: children });
const underline = (...children) => ({ underline: children });
const superscript = (...children) => ({ superscript: children });
const subscript = (...children) => ({ subscript: children });
const linkNode = (...children) => ({ link: children });

// ============================================================
// 全链路：段落中的删除线成为 delete 节点
// ============================================================

describe('全链路：段落中的删除线成为 delete 节点', () => {
    const cases = [
        ['段中', [plain('前文'), struck('删去'), plain('后文')], ['前文', del('删去'), '后文']],
        ['段首', [struck('删去'), plain('后文')], [del('删去'), '后文']],
        ['段尾', [plain('前文'), struck('删去')], ['前文', del('删去')]],
        ['整段', [struck('删去')], [del('删去')]],
        ['两处删除线之间隔着文字', [struck('甲'), plain('乙'), struck('丙')], [del('甲'), '乙', del('丙')]],
        ['双删除线（w:dstrike）同样成为 delete', [plain('前文'), run(text('删去'), '<w:dstrike/>'), plain('后文')], ['前文', del('删去'), '后文']],
    ];
    for (const [name, runs, expected] of cases) {
        test(name, async () => {
            assert.deepEqual(await onlyParagraph(runs), expected);
        });
    }
});

describe('删除线文字的字面记号与标点逐字保留，不受 flanking 规则与「~」转义影响', () => {
    const cases = [
        ['删除线文字含 Markdown 与 HTML 记号', [plain('前文'), struck('3~5元*注*_下_<s>&amp;\\反`码`'), plain('后文')], ['前文', del('3~5元*注*_下_<s>&amp;\\反`码`'), '后文']],
        ['删除线文字两端为书名号、外侧为汉字', [plain('依据'), struck('《专利法》'), plain('的规定')], ['依据', del('《专利法》'), '的规定']],
        ['删除线文字以冒号结尾、后接汉字', [struck('注意：'), plain('本发明')], [del('注意：'), '本发明']],
        ['删除线两侧紧贴字面「~」，删除线文字首尾也是「~」', [plain('约~'), struck('~删~'), plain('~止')], ['约~', del('~删~'), '~止']],
    ];
    for (const [name, runs, expected] of cases) {
        test(name, async () => {
            assert.deepEqual(await onlyParagraph(runs), expected);
        });
    }
});

// ============================================================
// 与加粗、斜体、下划线、上下标组合与相邻
// ============================================================

describe('与加粗、斜体、下划线、上下标组合：delete 位于最内层，与 mammoth 的嵌套一致', () => {
    const cases = [
        ['删除线 + 加粗', [plain('前文'), struck('删去', BOLD), plain('后文')], ['前文', strong(del('删去')), '后文']],
        ['删除线 + 斜体', [plain('前文'), struck('删去', ITALIC), plain('后文')], ['前文', emphasis(del('删去')), '后文']],
        ['删除线 + 下划线', [plain('前文'), struck('删去', UNDERLINE), plain('后文')], ['前文', underline(del('删去')), '后文']],
        ['删除线 + 上标', [plain('R'), struck('2', SUP), plain('基')], ['R', superscript(del('2')), '基']],
        ['删除线 + 下标', [plain('C'), struck('1', SUB), plain('烷基')], ['C', subscript(del('1')), '烷基']],
        ['删除线 + 加粗 + 斜体', [plain('前文'), struck('删去', BOLD + ITALIC), plain('后文')], ['前文', strong(emphasis(del('删去'))), '后文']],
        [
            '删除线 + 加粗 + 斜体 + 下划线 + 上标',
            [plain('前文'), struck('删去', BOLD + ITALIC + UNDERLINE + SUP), plain('后文')],
            ['前文', strong(emphasis(superscript(underline(del('删去'))))), '后文'],
        ],
        ['前接加粗 run、后接斜体 run', [bold('加粗'), struck('删去'), italic('斜体')], [strong('加粗'), del('删去'), emphasis('斜体')]],
        ['加粗 run 中段的删除线', [bold('甲'), struck('乙', BOLD), bold('丙')], [strong('甲', del('乙'), '丙')]],
        ['删除线 run 中段的加粗', [struck('甲'), struck('乙', BOLD), struck('丙')], [del('甲'), strong(del('乙')), del('丙')]],
    ];
    for (const [name, runs, expected] of cases) {
        test(name, async () => {
            assert.deepEqual(await onlyParagraph(runs), expected);
        });
    }
});

// ============================================================
// 换行：段中换行留在 delete 之内，首尾换行剥到 delete 之外
// ============================================================

describe('换行：段中换行留在 delete 之内，删除线 run 首尾的换行剥到 delete 之外', () => {
    const cases = [
        ['删除线 run 中段的换行', [plain('前文'), run(text('删') + BR + text('去'), STRIKE), plain('后文')], ['前文', del('删', 'BR', '去'), '后文']],
        ['删除线 run 末尾的段中换行', [plain('前文'), run(text('删去') + BR, STRIKE), plain('后文')], ['前文', del('删去'), 'BR', '后文']],
        ['删除线 run 开头的段中换行', [plain('前文'), run(BR + text('删去'), STRIKE), plain('后文')], ['前文', 'BR', del('删去'), '后文']],
        ['只含换行的删除线 run 处在段中', [plain('前文'), run(BR, STRIKE), plain('后文')], ['前文', 'BR', '后文']],
        // 以下三例：换行处在段首或段尾，与不带删除线时一样由块边界舍弃；<s> 不写在行首的换行之后，整段不成为 html 块
        ['段首的删除线 run 以换行开头', [run(BR + text('删去'), STRIKE), plain('后文')], [del('删去'), '后文']],
        ['段首的删除线 run 以两个换行开头', [run(BR + BR + text('删去'), STRIKE), plain('后文')], [del('删去'), '后文']],
        ['段尾的删除线 run 以换行结尾', [plain('前文'), run(text('删去') + BR, STRIKE)], ['前文', del('删去')]],
    ];
    for (const [name, runs, expected] of cases) {
        test(name, async () => {
            assert.deepEqual(await onlyParagraph(runs), expected);
        });
    }

    test('列表项开头的删除线 run 以两个换行开头：列表项不变空，内容不变成缩进代码块', async () => {
        const doc = await convert(paragraph([run(BR + BR + text('项删'), STRIKE)], BULLET));

        assertNoHtml(doc.ir);
        assert.deepEqual(doc.ir.children.map(brief), [{ list: [{ listItem: [{ paragraph: [del('项删')] }] }] }]);
    });

    test('超链接开头处在段首的删除线 run 以换行开头：该换行与加粗、斜体中的一样不输出', async () => {
        assert.deepEqual(await onlyParagraph([link([run(BR + text('链删'), STRIKE), plain('链后')])]), [linkNode(del('链删'), '链后')]);
    });

    test('标题内删除线 run 末尾的换行：标题照旧拆成标题与段落，删除线留在标题内', async () => {
        const doc = await convert(paragraph([plain('标前'), run(text('标删') + BR, STRIKE), plain('标后')], HEADING_1));

        assertNoHtml(doc.ir);
        assert.deepEqual(doc.ir.children.map(brief), [{ heading: ['标前', del('标删')] }, { paragraph: ['标后'] }]);
    });

    test('标题内删除线 run 中段的换行：标题照旧拆开，拆开的两侧各自成为 delete', async () => {
        const doc = await convert(paragraph([plain('标前'), run(text('甲') + BR + text('乙'), STRIKE), plain('标后')], HEADING_1));

        assertNoHtml(doc.ir);
        assert.deepEqual(doc.ir.children.map(brief), [{ heading: ['标前', del('甲')] }, { paragraph: [del('乙'), '标后'] }]);
    });
});

// ============================================================
// 删除线只增添 delete 节点：去掉 delete 后，IR 与不带删除线的对照文档逐项相等
// ============================================================

// 全角空格：以码点生成，测试源码里不出现看不见的字面量
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const STRUCK_TEXT = '删去';

/** 去掉 position、拆掉 delete 并合并相邻文本后的 IR：删除线之外的一切逐项可比 */
function withoutDelete(node) {
    if (Array.isArray(node)) {
        const out = [];
        for (const item of node.flatMap((child) => (child.type === 'delete' ? withoutDelete(child.children) : [withoutDelete(child)]))) {
            const previous = out[out.length - 1];
            if (previous && previous.type === 'text' && item.type === 'text') out[out.length - 1] = { type: 'text', value: previous.value + item.value };
            else out.push(item);
        }
        return out;
    }
    const { position, ...rest } = node;
    return Array.isArray(rest.children) ? { ...rest, children: withoutDelete(rest.children) } : rest;
}

/** 各 delete 节点内的文字（不含换行）依次相连 */
function deletedText(ir) {
    const texts = [];
    walk(ir, (node) => {
        if (node.type === 'delete') texts.push(node.children.map(function textOf(child) {
            return child.type === 'text' ? child.value : (child.children || []).map(textOf).join('');
        }).join(''));
    });
    return texts.join('');
}

describe('删除线只增添 delete 节点：去掉 delete 后与不带删除线的对照文档逐项相等，delete 恰好覆盖删除线文字', () => {
    // 被测 run 的内容：换行处在首、尾、中段，全角与半角空白处在首尾。全角空格贴着换行处在首尾的不在此列：turndown 把元素文本
    // 首尾的非 ASCII 空白另补一份在元素之外，<s> 不论是否写成标签都有这一份（修复前同样如此），不带删除线的 run 没有外层元素、
    // 也就没有这一份，二者无从逐字相等
    const CONTENTS = [
        ['只有文字', text(STRUCK_TEXT)],
        ['换行开头', BR + text(STRUCK_TEXT)],
        ['换行结尾', text(STRUCK_TEXT) + BR],
        ['首尾都是换行', BR + text(STRUCK_TEXT) + BR],
        ['中段一个换行', text('删') + BR + text('去')],
        ['中段两个换行', text('删') + BR + BR + text('去')],
        ['全角空格开头', text(`${IDEOGRAPHIC_SPACE}${STRUCK_TEXT}`)],
        ['全角空格结尾', text(`${STRUCK_TEXT}${IDEOGRAPHIC_SPACE}`)],
        ['半角空格包着文字', text(` ${STRUCK_TEXT} `)],
    ];
    const LAYOUTS = [
        ['段中', (target) => [plain('前文'), target, plain('后文')]],
        ['段首', (target) => [target, plain('后文')]],
        ['段尾', (target) => [plain('前文'), target]],
    ];
    // 处在超链接、下划线、上下标之内的段首段尾换行不在此列：删除线首尾的这类换行不输出（与加粗、斜体一致），见上方用例
    const BLOCKS = [['正文段落', ''], ['标题', HEADING_1]];
    const FORMATS = [['删除线', ''], ['删除线 + 加粗', BOLD]];
    for (const [blockName, pPr] of BLOCKS) {
        for (const [formatName, rPr] of FORMATS) {
            test(`${blockName} × ${formatName}`, async () => {
                for (const [contentName, content] of CONTENTS) {
                    for (const [layoutName, layout] of LAYOUTS) {
                        const label = `${contentName} × ${layoutName}`;
                        const doc = await convert(paragraph(layout(run(content, `${rPr}${STRIKE}`)), pPr));
                        const control = await convert(paragraph(layout(run(content, rPr)), pPr));

                        assertNoHtml(doc.ir);
                        assert.deepStrictEqual(withoutDelete(doc.ir), withoutDelete(control.ir), label);
                        assert.equal(deletedText(doc.ir).replace(/\s/g, ''), STRUCK_TEXT, label);
                    }
                }
            });
        }
    }
});

// ============================================================
// 语境：超链接、列表项、标题、脚注
// ============================================================

describe('语境：超链接、列表项、标题、脚注中的删除线', () => {
    test('超链接内的删除线', async () => {
        const doc = await convert(paragraph([plain('甲'), link([plain('链前'), struck('链删'), plain('链后')]), plain('乙')]));

        assertNoHtml(doc.ir);
        const [first] = doc.ir.children;
        assert.deepEqual(first.children.map(brief), ['甲', linkNode('链前', del('链删'), '链后'), '乙']);
        assert.equal(first.children[1].url, LINK_URL);
    });

    test('超链接文字整段都是删除线', async () => {
        assert.deepEqual(await onlyParagraph([link([struck('全删')])]), [linkNode(del('全删'))]);
    });

    test('列表项内的删除线：项末尾一处、整项一处', async () => {
        const doc = await convert(paragraph([plain('项前'), struck('项删')], BULLET) + paragraph([struck('次项')], BULLET));

        assertNoHtml(doc.ir);
        assert.deepEqual(doc.ir.children.map(brief), [{
            list: [
                { listItem: [{ paragraph: ['项前', del('项删')] }] },
                { listItem: [{ paragraph: [del('次项')] }] },
            ],
        }]);
    });

    test('标题内的删除线', async () => {
        const doc = await convert(paragraph([plain('标前'), struck('标删'), plain('标后')], HEADING_1));

        assertNoHtml(doc.ir);
        assert.deepEqual(doc.ir.children.map((node) => [node.type, node.depth]), [['heading', 1]]);
        assert.deepEqual(doc.ir.children[0].children.map(brief), ['标前', del('标删'), '标后']);
    });

    test('脚注内的删除线：mammoth 置于文末的脚注列表项中', async () => {
        const doc = await convert(paragraph([plain('正文'), footnoteReference()]), paragraph([plain('注前'), struck('注删'), plain('注后')]));

        assertNoHtml(doc.ir);
        const notes = doc.ir.children[doc.ir.children.length - 1];
        assert.equal(notes.type, 'list');
        assert.deepEqual(notes.children.map(brief), [{ listItem: [{ paragraph: ['注前', del('注删'), '注后 ', linkNode('↑')] }] }]);
    });

    test('脚注引用标号本身带删除线', async () => {
        const doc = await convert(paragraph([plain('正文'), footnoteReference(STRIKE)]), paragraph([plain('注')]));

        assertNoHtml(doc.ir);
        assert.deepEqual(doc.ir.children[0].children.map(brief), ['正文', del(superscript(linkNode('[1]')))]);
    });
});

// ============================================================
// turndown 层：word profile 的写法；url 与 basic profile 不变
// ============================================================

describe('turndown 层：word profile 输出 <s> 标签，首尾换行剥到标签之外', () => {
    const toMarkdown = (html, profile = 'word') => createTurndownService(profile).turndown(html).trim();
    const cases = [
        ['段中', '<p>前文<s>删去</s>后文</p>', '前文<s>删去</s>后文'],
        ['文本中的「~」照常转义，不写 ~~', '<p>前文<s>3~5</s>后文</p>', '前文<s>3\\~5</s>后文'],
        ['段中换行在标签之内写 <br>', '<p>前文<s>删<br />去</s>后文</p>', '前文<s>删<br>去</s>后文'],
        ['末尾的段中换行剥到标签之后', '<p>前文<s>删去<br /></s>后文</p>', '前文<s>删去</s><br>后文'],
        ['段首的换行剥去，<s> 不落在换行之后的行首', '<p><s><br />删去</s>后文</p>', '<s>删去</s>后文'],
        ['段尾的换行剥去', '<p>前文<s>删去<br /></s></p>', '前文<s>删去</s>'],
        ['加粗内的删除线：加粗定界符贴着标签而失效，改写为 <strong>', '<p>前文<strong><s>删去</s></strong>后文</p>', '前文<strong><s>删去</s></strong>后文'],
        ['标题内末尾的换行原样留在标签之后', '<h1><s>甲<br /></s>乙</h1>', '# <s>甲</s>  \n乙'],
        ['标题内中段的换行原样保留，两侧各自包进标签', '<h1><s>甲<br />乙</s>丙</h1>', '# <s>甲</s>  \n<s>乙</s>丙'],
        ['只含换行的删除线处在段中：一个标签也不写', '<p>前文<s><br /></s>后文</p>', '前文<br>后文'],
    ];
    for (const [name, html, expected] of cases) {
        test(name, () => {
            assert.equal(toMarkdown(html), expected);
        });
    }

    test('url 与 basic profile 的产物不变', () => {
        assert.equal(toMarkdown('<p>前文<s>删去</s>后文</p>', 'url'), '前文<del>删去</del>后文');
        assert.equal(toMarkdown('<p>前文<s>删去</s>后文</p>', 'basic'), '前文删去后文');
    });
});
