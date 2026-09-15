/**
 * docx 标题选取回归夹具（JSZip 按 OOXML 模板现造，不引入二进制文件）
 *
 * 用法：测试中 `await buildTitleSample()` 取 Buffer；也可 `node test/fixtures/build-title-sample.js <输出路径>` 落盘查看。
 *
 * 触发结构仿中文版 Word：样式 ID 与样式名不同（Title 样式 w:styleId="a4"、heading 1 样式 w:styleId="1"），
 * 封面题名段套 Title 样式而非标题 1，正文首个 heading 1 段是章标题。
 * 夹具内容（document.xml 顺序）：
 *   1. 空段落
 *   2. Title 样式段「样例评价手册」（title 参数可改写；传空串得无文字的 Title 段）
 *   3. 普通段「目录」
 *   4. heading 1 段「第一章 概述」
 *   5. 普通段正文
 * titleList 为 'ordered' / 'unordered' 时，第 2 段另带编号（numId 1、ilvl 0），其后插入同一编号定义下的
 * 下级段「适用范围」（ilvl 1）与同级段「编写说明」（ilvl 0），并附 numbering.xml 部件及其关系与内容类型
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 测试用的期望值：Title 样式段文本与首个 heading 1 的文本 */
const TITLE_EXPECTED = Object.freeze({ title: '样例评价手册', heading: '第一章 概述' });
/** headingTab: true 时，heading 1 段落用 <w:tab/> 分隔「第一章」与「总则」，meta.title 的期望值 */
const TAB_HEADING_EXPECTED = Object.freeze({ expected: '第一章 总则' });
/** titleList 模式下插入的两个普通编号段：child 为下级段（ilvl 1），sibling 为同级段（ilvl 0） */
const TITLE_LIST_EXPECTED = Object.freeze({ child: '适用范围', sibling: '编写说明' });

// ---------- document.xml 片段 ----------

const run = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const tabRun = () => '<w:r><w:tab/></w:r>';
const paragraph = (content, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`;
const pStyle = (id) => `<w:pStyle w:val="${id}"/>`;
const NUM_ID = 1;
const numPr = (ilvl) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${NUM_ID}"/></w:numPr>`;

function documentXml(title, headingTab, numbered) {
    const headingContent = headingTab
        ? `${run('第一章')}${tabRun()}${run('总则')}`
        : run(TITLE_EXPECTED.heading);
    const listParagraphs = numbered
        ? [paragraph(run(TITLE_LIST_EXPECTED.child), numPr(1)), paragraph(run(TITLE_LIST_EXPECTED.sibling), numPr(0))]
        : [];
    const body = [
        paragraph(''),
        paragraph(title ? run(title) : '', `${pStyle('a4')}${numbered ? numPr(0) : ''}`),
        ...listParagraphs,
        paragraph(run('目录')),
        paragraph(headingContent, pStyle('1')),
        paragraph(run('正文段落。')),
    ].join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W_NS}">`
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="21"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr/></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="a4"><w:name w:val="Title"/><w:basedOn w:val="a"/><w:rPr><w:sz w:val="72"/></w:rPr></w:style>'
    + '</w:styles>';

// ---------- numbering.xml（仅 titleList 模式）----------

// titleList 取值 → 各级 numFmt；mammoth 以 numFmt 是否为 bullet 判定有序或无序
const LIST_NUM_FMT = Object.freeze({ ordered: 'decimal', unordered: 'bullet' });

// 定义 ilvl 0、1 两级，夹具只用到这两级
const numberingXml = (numFmt) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${W_NS}">`
    + '<w:abstractNum w:abstractNumId="0">'
    + [0, 1].map((ilvl) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${numFmt}"/>`
        + `<w:lvlText w:val="${numFmt === 'bullet' ? '-' : `%${ilvl + 1}.`}"/></w:lvl>`).join('')
    + `</w:abstractNum><w:num w:numId="${NUM_ID}"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '</Types>';
const NUMBERING_OVERRIDE = '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>';

const relationships = (items) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R_NS}/${type}" Target="${target}"/>`).join('')
    + '</Relationships>';

function listNumFmt(titleList) {
    if (titleList === null) return null;
    if (!Object.hasOwn(LIST_NUM_FMT, titleList)) {
        throw new Error(`titleList 只接受 'ordered'、'unordered' 或 null，收到 ${String(titleList)}`);
    }
    return LIST_NUM_FMT[titleList];
}

/**
 * @param {{ title?: string, headingTab?: boolean, titleList?: 'ordered' | 'unordered' | null }} [options]
 *   title 为 Title 样式段的文本，缺省取 TITLE_EXPECTED.title；
 *   headingTab 为 true 时，heading 1 段落改用 <w:tab/> 分隔「第一章」与「总则」（见 TAB_HEADING_EXPECTED）；
 *   titleList 为 'ordered' / 'unordered' 时，Title 段带有序 / 无序编号，并插入两个同一编号定义下的普通段
 *   （见 TITLE_LIST_EXPECTED）；缺省 null，不带编号、不生成 numbering.xml
 */
async function buildTitleSample({ title = TITLE_EXPECTED.title, headingTab = false, titleList = null } = {}) {
    const numFmt = listNumFmt(titleList);
    const documentRels = [['rId1', 'styles', 'styles.xml']];
    const zip = new JSZip();
    zip.file('[Content_Types].xml', numFmt ? CONTENT_TYPES_XML.replace('</Types>', `${NUMBERING_OVERRIDE}</Types>`) : CONTENT_TYPES_XML);
    zip.file('_rels/.rels', relationships([['rId1', 'officeDocument', 'word/document.xml']]));
    zip.file('word/_rels/document.xml.rels', relationships(numFmt ? [...documentRels, ['rId2', 'numbering', 'numbering.xml']] : documentRels));
    zip.file('word/document.xml', documentXml(title, headingTab, Boolean(numFmt)));
    zip.file('word/styles.xml', STYLES_XML);
    if (numFmt) zip.file('word/numbering.xml', numberingXml(numFmt));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

if (require.main === module) {
    const target = path.resolve(process.argv[2] || path.join(__dirname, 'title-sample.docx'));
    buildTitleSample()
        .then((buffer) => {
            fs.writeFileSync(target, buffer);
            console.log(`已生成 ${target}（${buffer.length} 字节）`);
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}

module.exports = { buildTitleSample, TITLE_EXPECTED, TAB_HEADING_EXPECTED, TITLE_LIST_EXPECTED };
