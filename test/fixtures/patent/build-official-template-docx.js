#!/usr/bin/env node
/**
 * 多分节 docx 夹具生成器：官方五书模板形态（书目名只在各节页眉里，正文带 Cnipr 私用区标记码位）
 *
 *   node test/fixtures/patent/build-official-template-docx.js <输出路径>     落盘查看官方模板样稿
 *
 * 夹具在测试运行时现造成 Buffer，不入库二进制；正文为虚构示例，不对应任何真实专利申请。
 *
 * buildSectionedDocx(sections, { wordShape = true, evenAndOdd = false }) → Promise<Buffer>
 *   sections: [{ header?, firstHeader?, evenHeader?, titlePage?, children }]
 *     header / firstHeader / evenHeader 为字符串或字符串数组（数组即页眉内的多个段落）；三者都省略时该节不写
 *     w:headerReference（Word 语义：沿用上一节的页眉）；children 为 docx 包的块级元素
 *   wordShape：docx 包把非末节的 w:sectPr 放进一个追加的空段，真实 Word 文档里它在该节最后一个内容段的
 *     w:pPr 内（该段可以是空段、纯图片段或列表项）。为 true 时把 w:sectPr 挪进前一段并删去追加的空段；
 *     前一个元素不是段落（如表格）时保持原状
 * buildOfficialTemplateDocx() → Promise<Buffer>
 *   五节依次为 说明书摘要 / 摘要附图 / 权利要求书 / 说明书 / 说明书附图；标记码位与官方模板一致：
 *   U+E205 段落起始、U+E206 权项起始、U+E208 成对包裹编号与图号、U+E209 成对包裹发明名称、U+E20A 成对包裹小标题
 * OFFICIAL_EXPECTED：上述样稿的期望值，供测试断言
 */
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const {
    Document, Packer, Paragraph, TextRun, ImageRun, Header,
} = require('docx');

const PNG = fs.readFileSync(path.join(__dirname, '..', 'images', 'pic.png'));
const IMAGE_SIZE = { width: 96, height: 48 };
const DOCUMENT_PART = 'word/document.xml';
// docx 包为非末节追加的「只含 w:sectPr 的空段」
const SECTION_PARAGRAPH_RE = /<w:p><w:pPr>(<w:sectPr>[\s\S]*?<\/w:sectPr>)<\/w:pPr><\/w:p>/g;
const PARAGRAPH_CLOSE = '</w:p>';
const PARAGRAPH_OPEN = '<w:p>';
const PPR_OPEN = '<w:pPr>';
const PPR_CLOSE = '</w:pPr>';

// 不可见字符一律以码点生成，源码里不出现看不见的字面量
const fromCode = (code) => String.fromCharCode(code);
const MARK = Object.freeze({
    PARAGRAPH: fromCode(0xE205), CLAIM: fromCode(0xE206), NUMBER: fromCode(0xE208),
    TITLE: fromCode(0xE209), HEADING: fromCode(0xE20A),
});

// ---------- 段落构件 ----------

const text = (value) => new Paragraph({ children: [new TextRun(value)] });
const empty = () => new Paragraph({ children: [] });
const picture = () => new Paragraph({ children: [new ImageRun({ type: 'png', data: PNG, transformation: IMAGE_SIZE })] });
const marked = (value) => text(`${MARK.PARAGRAPH}${value}`);
const claim = (num, value) => text(`${MARK.CLAIM}${MARK.NUMBER}${num}. ${MARK.NUMBER}${value}`);
const inventionTitle = (value) => text(`${MARK.TITLE}${value}${MARK.TITLE}`);
const partHeading = (value) => text(`${MARK.HEADING}${value}${MARK.HEADING}`);
const figureLabel = (num) => text(`${MARK.NUMBER}图${num}${MARK.NUMBER}`);

const OFFICIAL_EXPECTED = Object.freeze({
    headers: Object.freeze(['说明书摘要', '摘要附图', '权利要求书', '说明书', '说明书附图']),
    inventionTitle: '一种试验用夹持装置',
    headings: Object.freeze(['技术领域', '背景技术', '发明内容', '附图说明', '具体实施方式']),
    abstract: '本申请公开了一种试验用夹持装置，包括底座、设于底座上的夹爪以及驱动夹爪开合的丝杆。',
    claims: Object.freeze([
        Object.freeze(['一种试验用夹持装置，其特征在于，包括：', '底座(1)；', '夹爪(2)，滑动设于所述底座(1)上。']),
        Object.freeze(['根据权利要求1所述的试验用夹持装置，其特征在于：所述夹爪(2)由丝杆(3)驱动。']),
    ]),
    paragraphs: Object.freeze([
        '本申请涉及试验工装技术领域，尤其是涉及一种试验用夹持装置。',
        '现有夹具更换试样时需要反复拧紧螺栓，效率较低。',
        '本申请的目的是提供一种试验用夹持装置，以改善上述问题。',
        '1、夹爪由丝杆驱动，装夹一次到位。',
        '图1是本申请实施例的整体结构示意图。',
        '图2是本申请实施例中夹爪的局部放大图。',
        '下面结合附图对本申请作进一步详细说明。',
        '实施例一',
        '参照图1，底座1上滑动设有夹爪2，丝杆3穿设于夹爪2内。',
    ]),
    figureLabels: Object.freeze(['图1', '图2']),
});

function officialSections() {
    const expected = OFFICIAL_EXPECTED;
    const [p1, p2, p3, p4, p5, p6, p7, p8, p9] = expected.paragraphs;
    return [
        // 末段是只含「段落起始」码位的空壳段，w:sectPr 落在它上面（真实样稿同此）
        { header: expected.headers[0], children: [marked(expected.abstract), marked('')] },
        // 整节只有一个纯图片段，w:sectPr 就在图片段上
        { header: expected.headers[1], children: [picture()] },
        // 末段是空段
        {
            header: expected.headers[2],
            children: [
                claim(1, expected.claims[0][0]), text(expected.claims[0][1]), text(expected.claims[0][2]),
                claim(2, expected.claims[1][0]), empty(),
            ],
        },
        {
            header: expected.headers[3],
            children: [
                inventionTitle(expected.inventionTitle),
                partHeading(expected.headings[0]), marked(p1),
                partHeading(expected.headings[1]), marked(p2),
                partHeading(expected.headings[2]), marked(p3), marked(p4),
                partHeading(expected.headings[3]), marked(p5), marked(p6),
                partHeading(expected.headings[4]), marked(p7), marked(p8), marked(p9),
            ],
        },
        { header: expected.headers[4], children: [picture(), figureLabel(1), empty(), picture(), figureLabel(2)] },
    ];
}

// ---------- 生成 ----------

const headerOf = (value) => new Header({ children: (Array.isArray(value) ? value : [value]).map((line) => new Paragraph(line)) });

function headersOf(section) {
    const headers = {};
    if (section.header !== undefined) headers.default = headerOf(section.header);
    if (section.firstHeader !== undefined) headers.first = headerOf(section.firstHeader);
    if (section.evenHeader !== undefined) headers.even = headerOf(section.evenHeader);
    return Object.keys(headers).length > 0 ? headers : undefined;
}

async function buildSectionedDocx(sections, { wordShape = true, evenAndOdd = false, numbering } = {}) {
    const document = new Document({
        evenAndOddHeaderAndFooters: evenAndOdd,
        ...(numbering ? { numbering } : {}),
        sections: sections.map((section) => ({
            properties: section.titlePage ? { titlePage: true } : {},
            headers: headersOf(section),
            children: section.children,
        })),
    });
    const buffer = await Packer.toBuffer(document);
    return wordShape ? moveSectionBreaksIntoContent(buffer) : buffer;
}

async function moveSectionBreaksIntoContent(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file(DOCUMENT_PART).async('string');
    zip.file(DOCUMENT_PART, mergeSectionParagraphs(xml));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// 自后向前处理，前面的偏移不受改写影响；夹具内段落互不嵌套，前一段的起点即最近的 <w:p>
function mergeSectionParagraphs(xml) {
    let out = xml;
    const matches = [...xml.matchAll(SECTION_PARAGRAPH_RE)].reverse();
    for (const matched of matches) {
        const before = out.slice(0, matched.index);
        if (!before.endsWith(PARAGRAPH_CLOSE)) continue;
        const start = before.lastIndexOf(PARAGRAPH_OPEN);
        if (start < 0) continue;
        const previous = before.slice(start);
        const merged = previous.startsWith(`${PARAGRAPH_OPEN}${PPR_OPEN}`)
            ? previous.replace(PPR_CLOSE, `${matched[1]}${PPR_CLOSE}`)
            : `${PARAGRAPH_OPEN}${PPR_OPEN}${matched[1]}${PPR_CLOSE}${previous.slice(PARAGRAPH_OPEN.length)}`;
        out = out.slice(0, start) + merged + out.slice(matched.index + matched[0].length);
    }
    return out;
}

const buildOfficialTemplateDocx = (options) => buildSectionedDocx(officialSections(), options);

if (require.main === module) {
    const target = process.argv[2];
    if (!target) {
        process.stderr.write('用法：node test/fixtures/patent/build-official-template-docx.js <输出路径>\n');
        process.exitCode = 1;
    } else {
        buildOfficialTemplateDocx().then((buffer) => {
            fs.writeFileSync(target, buffer);
            process.stdout.write(`${target} ${buffer.length} 字节\n`);
        }).catch((err) => {
            process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
            process.exitCode = 1;
        });
    }
}

module.exports = {
    buildSectionedDocx, buildOfficialTemplateDocx, OFFICIAL_EXPECTED, MARK,
    text, empty, picture, marked, claim, inventionTitle, partHeading, figureLabel,
};
