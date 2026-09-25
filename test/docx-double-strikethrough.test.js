/**
 * docx 双删除线（w:dstrike）：parsers/docx-layout 在交给 mammoth 之前把开启的双删除线改写为单删除线
 * 覆盖：预处理 + mammoth 层——<s> 恰好包住双删除线文字，HTML 与对照文档（开启者把该元素换成 <w:strike/>，关闭者去掉
 *       该元素）逐字一致：段中、段首、段尾；w:val 为 true、1、on 与缺省为开启，false、0、off 为关闭；同一 run 兼带
 *       w:strike 的各组合（开/开只出一层 <s>、关/开、开/关、关/关、开启的 dstrike 在关闭的 strike 之前）；与加粗、下划线
 *       组合；w:rPrChange 内的旧格式不改写；显式闭标签、单引号属性、标签内换行与多余空白；段落标记；脚注与尾注。
 *       全链路 IR 层——parse 的 IR 与 warnings 同对照文档逐项相等（段落级删除线进 IR 的支持合入后，此层即保证双删除线
 *       同样成为 delete 节点）。表格单元格全链路——table.data.grid 中双删除线文字恰在 delete 节点内。
 *       rewriteDoubleStrike 的字符串级改写与原样返回；prepareLayout 无改写时原样返回入参 buffer、脚注与尾注部件各自改写、
 *       部件缺失即跳过；畸形输入上 rewriteDoubleStrike 的耗时上限。
 * 夹具一律由 JSZip 按 OOXML 现造（正文、可选的脚注与尾注部件），run 的 XML 逐字可控，正文为虚构示例。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const mammoth = require('mammoth');
const { load } = require('cheerio');

const { parse } = require('../converters/parsers/docx');
const { prepareLayout, rewriteDoubleStrike } = require('../converters/parsers/docx-layout');
const { BUDGET_FACTOR, budgetMs } = require('./helpers/timing-budget');

// ============================================================
// 夹具：JSZip 现造的最小 docx
// ============================================================

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DOCUMENT_PART = 'word/document.xml';
const NOTE_PARTS = Object.freeze({ footnote: 'word/footnotes.xml', endnote: 'word/endnotes.xml' });
const CONTENT_TYPE_OF = Object.freeze({
    [DOCUMENT_PART]: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    [NOTE_PARTS.footnote]: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
    [NOTE_PARTS.endnote]: 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml',
});
// 与解析器一样把下划线映射为 <u>（parsers/docx 的 STYLE_MAP），加粗、下划线组合的 HTML 据此完整可见
const MAMMOTH_OPTIONS = Object.freeze({ styleMap: ['u => u'] });

const text = (value) => `<w:t xml:space="preserve">${value}</w:t>`;
const run = (value, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${text(value)}</w:r>`;
const plain = (value) => run(value);
const paragraph = (runs, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs.join('')}</w:p>`;
const STRIKE = '<w:strike/>';
const BOLD = '<w:b/>';
const UNDERLINE = '<w:u w:val="single"/>';
// 修订前的旧格式：w:rPrChange 内的 w:rPr
const revision = (inner) => `<w:rPrChange w:id="1" w:author="示例" w:date="2026-01-01T00:00:00Z"><w:rPr>${inner}</w:rPr></w:rPrChange>`;

// 2×2 表格：表头行 + 数据行，被测 run 在数据行的首个单元格
const table = (cellRuns) => '<w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>'
    + `<w:tr><w:tc>${paragraph([plain('表头甲')])}</w:tc><w:tc>${paragraph([plain('表头乙')])}</w:tc></w:tr>`
    + `<w:tr><w:tc>${paragraph(cellRuns)}</w:tc><w:tc>${paragraph([plain('丙')])}</w:tc></w:tr></w:tbl>`;

const relationships = (items) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${R_NS}/${type}" Target="${target}"/>`).join('')
    + '</Relationships>';
const contentTypes = (parts) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + parts.map((part) => `<Override PartName="/${part}" ContentType="${CONTENT_TYPE_OF[part]}"/>`).join('')
    + '</Types>';
// 脚注或尾注部件：两条分隔符（mammoth 按 w:type 滤掉）+ 编号 1 的被测注释
const notesXml = (kind, paragraphXml) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${kind}s xmlns:w="${W_NS}">`
    + `<w:${kind} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${kind}>`
    + `<w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>`
    + `<w:${kind} w:id="1">${paragraphXml}</w:${kind}></w:${kind}s>`;

/** 正文 + 可选的脚注、尾注部件（notes 的键为 footnote / endnote，值为该条注释的段落 XML）→ 最小 docx */
async function buildDocx(bodyXml, notes = {}) {
    const zip = new JSZip();
    const parts = [DOCUMENT_PART];
    const rels = [];
    for (const [kind, paragraphXml] of Object.entries(notes)) {
        parts.push(NOTE_PARTS[kind]);
        rels.push([`rId${rels.length + 1}`, `${kind}s`, `${kind}s.xml`]);
        zip.file(NOTE_PARTS[kind], notesXml(kind, paragraphXml));
    }
    zip.file('[Content_Types].xml', contentTypes(parts));
    zip.file('_rels/.rels', relationships([['rId1', 'officeDocument', DOCUMENT_PART]]));
    zip.file('word/_rels/document.xml.rels', relationships(rels));
    zip.file(DOCUMENT_PART, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body>${bodyXml}<w:sectPr/></w:body></w:document>`);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function partOf(buffer, part) {
    const entry = (await JSZip.loadAsync(buffer)).file(part);
    return entry ? entry.async('string') : null;
}

// ============================================================
// 三层观测：预处理 + mammoth 的 HTML、全链路 IR、表格 grid
// ============================================================

/** prepareLayout 的产物交给 mammoth，与解析器同一顺序 */
async function preparedHtml(buffer) {
    const { buffer: prepared } = await prepareLayout(buffer);
    return (await mammoth.convertToHtml({ buffer: prepared }, MAMMOTH_OPTIONS)).value;
}

/** HTML 中每个 <s> 的文字，按出现顺序；嵌套的两层 <s> 各计一次 */
function struckTexts(html) {
    const $ = load(html);
    return $('s').map((_, element) => $(element).text()).get();
}

const convert = (buffer) => parse({ buffer }, { sourceName: '双删除线样例.docx' });

const textOf = (node) => (node.type === 'text' ? node.value : (node.children || []).map(textOf).join(''));

/** grid 中每个 delete 节点的文字，按出现顺序；嵌套的两层 delete 各计一次 */
function deletedTexts(grid) {
    const found = [];
    const visit = (node) => {
        if (node.type === 'delete') found.push(textOf(node));
        for (const child of node.children || []) visit(child);
    };
    for (const row of grid.rows) {
        for (const cell of row.cells) {
            for (const inlines of cell.paragraphs) inlines.forEach(visit);
        }
    }
    return found;
}

function gridOf(ir) {
    const node = ir.children.find((child) => child.type === 'table');
    assert.ok(node && node.data && node.data.grid, '应有带 data.grid 的表格节点');
    return node.data.grid;
}

// ============================================================
// 被测 run 的属性组合
// rPr 为被测 run 的属性，control 为对照：开启者把双删除线换成 <w:strike/>（已有开启的单删除线时去掉双删除线），
// 关闭者去掉该元素；struck 为该 run 是否应成删除线
// ============================================================

const TARGET = '双删';
const CELL_TARGET = '格删';
const NOTE_TARGET = '注删';

const CASES = [
    { name: '缺省 w:val（开启）', rPr: '<w:dstrike/>', control: STRIKE, struck: true },
    { name: 'w:val="true"（开启）', rPr: '<w:dstrike w:val="true"/>', control: STRIKE, struck: true },
    { name: 'w:val="1"（开启）', rPr: '<w:dstrike w:val="1"/>', control: STRIKE, struck: true },
    { name: 'w:val="on"（开启）', rPr: '<w:dstrike w:val="on"/>', control: STRIKE, struck: true },
    { name: 'w:val="false"（关闭）', rPr: '<w:dstrike w:val="false"/>', control: '', struck: false },
    { name: 'w:val="0"（关闭）', rPr: '<w:dstrike w:val="0"/>', control: '', struck: false },
    { name: 'w:val="off"（关闭）', rPr: '<w:dstrike w:val="off"/>', control: '', struck: false },
    { name: 'strike 开、dstrike 开：只出一层 <s>', rPr: '<w:strike/><w:dstrike/>', control: STRIKE, struck: true },
    { name: 'strike 关（false）、dstrike 开', rPr: '<w:strike w:val="false"/><w:dstrike/>', control: STRIKE, struck: true },
    { name: 'strike 开、dstrike 关（0）', rPr: '<w:strike/><w:dstrike w:val="0"/>', control: STRIKE, struck: true },
    { name: 'strike 关、dstrike 关（均为 false）', rPr: '<w:strike w:val="false"/><w:dstrike w:val="false"/>', control: '', struck: false },
    { name: 'strike 关、dstrike 关（均为 0）', rPr: '<w:strike w:val="0"/><w:dstrike w:val="0"/>', control: '', struck: false },
    { name: '非规范次序：开启的 dstrike 在关闭的 strike（0）之前', rPr: '<w:dstrike/><w:strike w:val="0"/>', control: STRIKE, struck: true },
    { name: '与加粗、下划线组合（开启）', rPr: `${BOLD}<w:dstrike/>${UNDERLINE}`, control: `${BOLD}${STRIKE}${UNDERLINE}`, struck: true },
    { name: '与加粗、下划线组合（dstrike 关闭）', rPr: `${BOLD}<w:dstrike w:val="false"/>${UNDERLINE}`, control: `${BOLD}${UNDERLINE}`, struck: false },
    { name: '护栏：w:rPrChange 内旧格式的双删除线不改写', rPr: revision('<w:dstrike/>'), control: revision(''), struck: false },
    {
        name: '护栏：当前格式开启，w:rPrChange 内另有双删除线',
        rPr: `<w:dstrike/>${revision('<w:dstrike/>')}`,
        control: `${STRIKE}${revision('<w:dstrike/>')}`,
        struck: true,
    },
    { name: '护栏：显式闭标签（缺省 w:val）', rPr: '<w:dstrike></w:dstrike>', control: STRIKE, struck: true },
    { name: '护栏：显式闭标签，w:val="true"，其间换行、闭标签内带空白', rPr: '<w:dstrike w:val="true">\n</w:dstrike >', control: STRIKE, struck: true },
    { name: '护栏：显式闭标签，w:val="0"', rPr: '<w:dstrike w:val="0"></w:dstrike>', control: '', struck: false },
    { name: "护栏：单引号属性 w:val='1'", rPr: "<w:dstrike w:val='1'/>", control: STRIKE, struck: true },
    { name: "护栏：单引号属性 w:val='off'", rPr: "<w:dstrike w:val='off'/>", control: '', struck: false },
    { name: '护栏：标签内换行与多余空白（开启）', rPr: '<w:dstrike\n    w:val = "on"\n/>', control: STRIKE, struck: true },
    { name: '护栏：标签内换行与多余空白（关闭）', rPr: '<w:dstrike\n\tw:val=\n"false"  />', control: '', struck: false },
];

const caseNamed = (name) => CASES.find((item) => item.name === name);
const POSITIONS = [
    { name: '段中', runs: (target) => [plain('前文'), target, plain('后文')] },
    { name: '段首', runs: (target) => [target, plain('后文')] },
    { name: '段尾', runs: (target) => [plain('前文'), target] },
];
// 全部组合放在段中；段首、段尾各取开启与关闭的代表各一
const EDGE_CASES = [caseNamed('缺省 w:val（开启）'), caseNamed('w:val="off"（关闭）')];
const POSITIONED_CASES = [
    ...CASES.map((item) => ({ ...item, position: POSITIONS[0] })),
    ...POSITIONS.slice(1).flatMap((position) => EDGE_CASES.map((item) => ({ ...item, position }))),
];

const paragraphDocx = (position, rPr) => buildDocx(paragraph(position.runs(run(TARGET, rPr))));
const tableDocx = (rPr) => buildDocx(table([plain('格前'), run(CELL_TARGET, rPr), plain('格后')]));

// ============================================================
// a) 预处理 + mammoth（修复前可判别：开启情形 mammoth 不出 <s>）
// ============================================================

describe('预处理 + mammoth：<s> 恰好包住双删除线文字，HTML 与对照文档逐字一致', () => {
    for (const { name, rPr, control, struck, position } of POSITIONED_CASES) {
        test(`${position.name}：${name}`, async () => {
            const html = await preparedHtml(await paragraphDocx(position, rPr));
            const expected = await preparedHtml(await paragraphDocx(position, control));

            assert.deepEqual(struckTexts(html), struck ? [TARGET] : [], html);
            assert.equal(html, expected);
        });
    }
});

// ============================================================
// b) 全链路 IR 等价（面向段落级删除线进 IR 的支持合入之后：届时单删除线成为 delete 节点，本层保证双删除线同样如此）
// ============================================================

describe('全链路：parse 的 IR 与 warnings 同对照文档逐项相等', () => {
    // 全部组合放在段中；段首、段尾取开启的代表
    const cases = [
        ...CASES.map((item) => ({ ...item, position: POSITIONS[0] })),
        ...POSITIONS.slice(1).map((position) => ({ ...EDGE_CASES[0], position })),
    ];
    for (const { name, rPr, control, position } of cases) {
        test(`${position.name}：${name}`, async () => {
            const doc = await convert(await paragraphDocx(position, rPr));
            const expected = await convert(await paragraphDocx(position, control));

            assert.deepStrictEqual(doc.ir, expected.ir);
            assert.deepStrictEqual(doc.warnings, expected.warnings);
        });
    }
});

// ============================================================
// c) 表格单元格全链路（修复前可判别：docx-tables 已把 <s> 留存为 delete，开启情形缺的是 mammoth 这一环）
// ============================================================

describe('表格单元格：table.data.grid 中双删除线文字恰在 delete 节点内', () => {
    for (const { name, rPr, control, struck } of CASES) {
        test(name, async () => {
            const doc = await convert(await tableDocx(rPr));
            const expected = await convert(await tableDocx(control));

            assert.deepEqual(deletedTexts(gridOf(doc.ir)), struck ? [CELL_TARGET] : []);
            assert.deepStrictEqual(doc.ir, expected.ir);
        });
    }
});

// ============================================================
// 护栏：段落标记、脚注与尾注
// ============================================================

describe('护栏：段落标记、脚注与尾注', () => {
    const markDocx = (markRpr) => buildDocx(paragraph([plain('前文'), plain('后文')], `<w:rPr>${markRpr}</w:rPr>`));

    test('段落标记（w:pPr/w:rPr）的双删除线：mammoth 不据段落标记输出格式，HTML 与 IR 同对照文档一致', async () => {
        const html = await preparedHtml(await markDocx('<w:dstrike/>'));

        assert.deepEqual(struckTexts(html), []);
        assert.equal(html, await preparedHtml(await markDocx(STRIKE)));
        assert.deepStrictEqual((await convert(await markDocx('<w:dstrike/>'))).ir, (await convert(await markDocx(STRIKE))).ir);
    });

    for (const kind of Object.keys(NOTE_PARTS)) {
        const label = kind === 'footnote' ? '脚注' : '尾注';
        const body = paragraph([plain('正文'), `<w:r><w:${kind}Reference w:id="1"/></w:r>`]);
        const noteDocx = (rPr) => buildDocx(body, { [kind]: paragraph([plain('注前'), run(NOTE_TARGET, rPr), plain('注后')]) });

        test(`${label}内开启的双删除线：<s> 恰好包住该文字，HTML 与对照文档逐字一致`, async () => {
            const html = await preparedHtml(await noteDocx('<w:dstrike/>'));

            assert.deepEqual(struckTexts(html), [NOTE_TARGET], html);
            assert.equal(html, await preparedHtml(await noteDocx(STRIKE)));
        });

        test(`${label}内关闭的双删除线（off）：不出 <s>，HTML 与去掉该元素的对照文档逐字一致`, async () => {
            const html = await preparedHtml(await noteDocx('<w:dstrike w:val="off"/>'));

            assert.deepEqual(struckTexts(html), [], html);
            assert.equal(html, await preparedHtml(await noteDocx('')));
        });

        test(`${label}内开启的双删除线：全链路 IR 与 warnings 同对照文档逐项相等`, async () => {
            const doc = await convert(await noteDocx('<w:dstrike/>'));
            const expected = await convert(await noteDocx(STRIKE));

            assert.deepStrictEqual(doc.ir, expected.ir);
            assert.deepStrictEqual(doc.warnings, expected.warnings);
        });
    }
});

// ============================================================
// prepareLayout：部件处理与原样返回
// ============================================================

describe('prepareLayout：各部件独立改写，无改写时原样返回入参 buffer', () => {
    test('正文与脚注都没有开启的双删除线时原样返回入参 buffer（同一对象）', async () => {
        const input = await buildDocx(
            paragraph([run(TARGET, '<w:dstrike w:val="off"/>'), run('乙', '<w:strike/><w:dstrike/>'), run('丙', revision('<w:dstrike/>'))]),
            { footnote: paragraph([run(NOTE_TARGET, '<w:dstrike w:val="0"/>')]) },
        );

        assert.equal((await prepareLayout(input)).buffer, input);
    });

    for (const [kind, other] of [['footnote', 'endnote'], ['endnote', 'footnote']]) {
        test(`只有 ${NOTE_PARTS[kind]} 含开启的双删除线：该部件改写，正文与 ${NOTE_PARTS[other]} 逐字不变`, async () => {
            const input = await buildDocx(paragraph([run(TARGET, '<w:dstrike w:val="false"/>')]), {
                [kind]: paragraph([run(NOTE_TARGET, '<w:dstrike/>')]),
                [other]: paragraph([run(NOTE_TARGET, '<w:dstrike w:val="0"/>')]),
            });
            const output = (await prepareLayout(input)).buffer;

            assert.notEqual(output, input);
            assert.equal(await partOf(output, DOCUMENT_PART), await partOf(input, DOCUMENT_PART));
            assert.equal(await partOf(output, NOTE_PARTS[other]), await partOf(input, NOTE_PARTS[other]));
            assert.equal(await partOf(output, NOTE_PARTS[kind]), (await partOf(input, NOTE_PARTS[kind])).replace('<w:dstrike/>', STRIKE));
        });
    }

    test('没有脚注、尾注部件时照常改写正文，也不新建这两个部件', async () => {
        const input = await buildDocx(paragraph([run(TARGET, '<w:dstrike/>')]));
        const output = (await prepareLayout(input)).buffer;

        assert.equal(await partOf(output, DOCUMENT_PART), (await partOf(input, DOCUMENT_PART)).replace('<w:dstrike/>', STRIKE));
        assert.equal(await partOf(output, NOTE_PARTS.footnote), null);
        assert.equal(await partOf(output, NOTE_PARTS.endnote), null);
    });
});

// ============================================================
// rewriteDoubleStrike：字符串级改写
// ============================================================

describe('rewriteDoubleStrike：字符串级改写', () => {
    const inRun = (rPr) => `<w:r><w:rPr>${rPr}</w:rPr>${text('甲')}</w:r>`;

    const REWRITES = [
        ['缺省开启：原位换成 <w:strike/>，前后的兄弟元素不动', `${BOLD}<w:dstrike/><w:sz w:val="21"/>`, `${BOLD}${STRIKE}<w:sz w:val="21"/>`],
        ['显式闭标签：连同其间空白与闭标签一并换掉', '<w:dstrike w:val="true">\n</w:dstrike >', STRIKE],
        ['标签内换行、等号两侧空白', '<w:dstrike\n  w:val = "1"\n/>', STRIKE],
        ["单引号属性 w:val='on'", "<w:dstrike w:val='on'/>", STRIKE],
        ['属性名须恰为 w:val：w:value 不算，按缺省开启', '<w:dstrike w:value="0"/>', STRIKE],
        ['其他属性的引号值里出现 w:val 字样不算', `<w:dstrike w:rsid=' w:val="0"' w:val="1"/>`, STRIKE],
        ['关闭的 strike 在前：删去，dstrike 原位换成 <w:strike/>', `${BOLD}<w:strike w:val="false"/><w:dstrike/>`, `${BOLD}${STRIKE}`],
        ['非规范次序：dstrike 在关闭的 strike 之前', '<w:dstrike/><w:strike w:val="0"/>', STRIKE],
        ['strike 为 off（按 ST_OnOff 为关闭，mammoth 却判为开启）：同样只留一个开启的 strike', '<w:strike w:val="off"/><w:dstrike/>', STRIKE],
        ['首个 strike 关闭、其后另有 strike：一并删去，只留一个开启的 strike', '<w:strike w:val="0"/><w:strike/><w:dstrike/>', STRIKE],
        [
            '只改当前格式，w:rPrChange 内的旧格式原样保留',
            `<w:dstrike/>${revision('<w:dstrike/><w:strike w:val="0"/>')}`,
            `${STRIKE}${revision('<w:dstrike/><w:strike w:val="0"/>')}`,
        ],
    ];
    for (const [name, rPr, expected] of REWRITES) {
        test(`改写：${name}`, () => {
            assert.equal(rewriteDoubleStrike(inRun(rPr)), inRun(expected));
        });
    }

    const UNCHANGED = [
        ['w:val="false"', '<w:dstrike w:val="false"/>'],
        ['w:val="0"', '<w:dstrike w:val="0"/>'],
        ['w:val="off"', '<w:dstrike w:val="off"/>'],
        ["单引号 w:val='0'", "<w:dstrike w:val='0'/>"],
        ['同名前缀的属性不干扰 w:val 的判定', '<w:dstrike w:vals="1" w:val="0"/>'],
        ['strike 开、dstrike 开', '<w:strike/><w:dstrike/>'],
        ['开启的 strike（w:val="true"）在 dstrike 之后', '<w:dstrike/><w:strike w:val="true"/>'],
        ['只有 w:rPrChange 内有双删除线', revision('<w:dstrike/>')],
        ['没有双删除线', `${BOLD}${STRIKE}`],
    ];
    for (const [name, rPr] of UNCHANGED) {
        test(`不改：${name}`, () => {
            const xml = inRun(rPr);
            assert.equal(rewriteDoubleStrike(xml), xml);
        });
    }

    test('多个 run 各自判定，段落标记的 w:pPr/w:rPr 一并改写；自闭合的 w:rPr、不带 w:rPr 的 run 不受影响', () => {
        const xml = paragraph([
            inRun('<w:dstrike/>'),
            inRun('<w:dstrike w:val="0"/>'),
            inRun('<w:strike/><w:dstrike/>'),
            `<w:r><w:rPr/>${text('乙')}</w:r>`,
            plain('丙'),
            inRun(`${BOLD}<w:dstrike w:val="1"/>`),
        ], '<w:rPr><w:dstrike/></w:rPr>');
        const expected = paragraph([
            inRun(STRIKE),
            inRun('<w:dstrike w:val="0"/>'),
            inRun('<w:strike/><w:dstrike/>'),
            `<w:r><w:rPr/>${text('乙')}</w:r>`,
            plain('丙'),
            inRun(`${BOLD}${STRIKE}`),
        ], `<w:rPr>${STRIKE}</w:rPr>`);

        assert.equal(rewriteDoubleStrike(xml), expected);
    });

    test('不在 w:rPr 之内的 w:dstrike 不受影响', () => {
        const xml = `<w:r><w:dstrike/>${text('甲')}</w:r>`;
        assert.equal(rewriteDoubleStrike(xml), xml);
    });
});

// ============================================================
// 耗时护栏：畸形输入上 rewriteDoubleStrike 线性于输入长度
// ============================================================

// 耗时用例的输入规模：每种形态 2^17 个重复单位
const STRESS_UNITS = 2 ** 17;
// 耗时上限取绝对值而非倍率：毫秒级测量噪声大，倍率断言不稳。2500 ms 为本机实测最大值的 10 倍以上——单独运行本文件
// 十一次，各形态单次调用至多约 105 ms（大量 rPr 各带开启的双删除线），全量测试并发运行六次至多约 201 ms；各形态的规模
// 加到 2、4、8 倍时，耗时约为 2、4、8 倍。CI 上按 test/helpers/timing-budget.js 的系数放宽为 10000 ms：CI 最坏比本机
// 全量并行慢约 9 倍，估计最大值约 1.8 s，放宽后余量约 5.6 倍；平方级实现在该规模上耗时远超此数，检出力不受影响
const STRESS_BUDGET_MS = 2500;
const elapsedMsSince = (started) => Number(process.hrtime.bigint() - started) / 1e6;
const same = (input) => input;
// 串首放一个带开启双删除线的 rPr：既让改写走完整条扫描路径（通篇没有 <w:dstrike 时直接返回），也核对畸形段之前的块照常改写
const LEAD = '<w:rPr><w:dstrike/></w:rPr>';
const LEAD_REWRITTEN = `<w:rPr>${STRIKE}</w:rPr>`;

const STRESS_SHAPES = [
    {
        name: '大量无「>」的 <w:rPr',
        input: () => `${LEAD}${'<w:rPr'.repeat(STRESS_UNITS)}`,
        expected: () => `${LEAD_REWRITTEN}${'<w:rPr'.repeat(STRESS_UNITS)}`,
    },
    {
        name: '大量未闭合的 <w:rPr>',
        input: () => `${LEAD}${'<w:rPr>'.repeat(STRESS_UNITS)}`,
        expected: () => `${LEAD_REWRITTEN}${'<w:rPr>'.repeat(STRESS_UNITS)}`,
    },
    {
        name: '深度嵌套的 w:rPr，最内层带开启的双删除线（不是顶层 rPr 的直接子元素）',
        input: () => `${'<w:rPr>'.repeat(STRESS_UNITS)}<w:dstrike/>${'</w:rPr>'.repeat(STRESS_UNITS)}`,
        expected: same,
    },
    { name: 'rPr 内大量无「>」的 <w:dstrike', input: () => `<w:rPr>${'<w:dstrike'.repeat(STRESS_UNITS)}</w:rPr>`, expected: same },
    {
        name: '超长 rPr：大量关闭的 w:strike 之后一个开启的双删除线',
        input: () => `<w:rPr>${'<w:strike w:val="0"/>'.repeat(STRESS_UNITS)}<w:dstrike/></w:rPr>`,
        expected: () => `<w:rPr>${STRIKE}</w:rPr>`,
    },
    {
        name: '双删除线开标签内大量不带等号的 w:val',
        input: () => `<w:rPr><w:dstrike${' w:val'.repeat(STRESS_UNITS)}/></w:rPr>`,
        expected: () => `<w:rPr>${STRIKE}</w:rPr>`,
    },
    {
        name: '大量 rPr 的双删除线开标签内引号不闭合（每个引号都延伸到下一个 rPr 块）',
        input: () => '<w:rPr><w:dstrike w:val="</w:rPr>'.repeat(STRESS_UNITS),
        expected: same,
    },
    {
        name: '大量 rPr 各带开启的双删除线',
        input: () => '<w:rPr><w:dstrike/></w:rPr>'.repeat(STRESS_UNITS),
        expected: () => `<w:rPr>${STRIKE}</w:rPr>`.repeat(STRESS_UNITS),
    },
];

describe(`耗时护栏：${STRESS_UNITS} 个单位的畸形输入上 rewriteDoubleStrike 单次调用在绝对上限内，输出逐字正确`, () => {
    for (const shape of STRESS_SHAPES) {
        test(shape.name, (t) => {
            // Arrange：在计时区间外构造输入与期望
            const input = shape.input();
            const expected = shape.expected(input);

            // Act：计时区间只包这一次调用
            const started = process.hrtime.bigint();
            const output = rewriteDoubleStrike(input);
            const elapsedMs = elapsedMsSince(started);
            const budget = budgetMs(STRESS_BUDGET_MS);
            t.diagnostic(`rewriteDoubleStrike 实测 ${elapsedMs.toFixed(2)} ms，输入 ${input.length} 字符，上限 ${budget} ms`);

            // Assert：先验输出正确，以免「快」来自少做了事
            assert.ok(output === expected, `输出不符：长 ${output.length}，期望长 ${expected.length}`);
            assert.ok(
                elapsedMs < budget,
                `rewriteDoubleStrike 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${budget} ms（${STRESS_BUDGET_MS} ms × 系数 ${BUDGET_FACTOR}）`,
            );
        });
    }
});
