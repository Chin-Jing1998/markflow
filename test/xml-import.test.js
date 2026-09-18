/**
 * converters/parsers/xml.js（专利五书 XML 反向导入）的解析层测试
 * 覆盖：
 *   输入形态——官方形态的目录 / zip / 外套一层文件夹的 zip / 单个 XML，v3.0.0 平铺形态，人工参照夹具五份，
 *     一份 XML 含多个书目容器，同一书目多份，GBK 编码；非专利 XML（generic profile、未知根元素、非 XML）的中文错误；
 *   IR 映射——书目顺序与 data.section、书目标题节点、权项编号与 claim-text 拍平、发明名称（含超长改字段段）、
 *     heading 的 level、Italic、行内标记、换行归一、语义分节容器、段号选项、附图图号段的新旧形态合并、摘要附图；
 *   图片——角色、显示尺寸的取法、资产去重与改名、缺图占位；
 *   安全——img/@file 越界、符号链接逃逸、魔数与扩展名、zip 条目数 / 单条目 / 谎报大小 / 总量上限、
 *     不安全条目名、符号链接条目、XML 大小与嵌套深度上限；
 *   问题清单——全部带「导入：」前缀，人工参照夹具的丢失项清单不多不少。
 * 夹具一律程序化合成（test/fixtures/patent/roundtrip/build-roundtrip-fixtures.js），正文为虚构示例。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const { parse } = require('../converters/parsers/xml');
const zipParser = require('../converters/parsers/zip');
const { normalizeOptions } = require('../converters/options');
const { collectText } = require('../converters/ir/util');
const { displaySize, isAcceptableFileName } = require('../converters/parsers/xml/images');
const { IMPORT_PREFIX, LOSS_KINDS, createReport, MAX_WARNINGS } = require('../converters/parsers/xml/report');
const { LIMITS, isUnsafeEntryName } = require('../converters/parsers/xml/source');
const {
    makeJpeg, makePng, buildOfficialBundle, buildFlatBundle, writeFiles, zipFiles, OFFICIAL_EXPECTED, FLAT_EXPECTED, NBSP,
} = require('./fixtures/patent/roundtrip/build-roundtrip-fixtures');

const REFERENCE_DIR = path.join(__dirname, 'fixtures', 'patent', 'reference');
const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'xml-import-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BOOK_HEADERS = ['说明书摘要', '摘要附图', '权利要求书', '说明书', '说明书附图'];
const EMU_PER_MM = 36000;

let official;
let flat;
let jpeg;
before(async () => {
    official = await buildOfficialBundle();
    flat = await buildFlatBundle();
    jpeg = await makeJpeg({ width: 300, height: 150 });
});

// ---------- 辅助 ----------

let seq = 0;
const makeDir = (label) => {
    seq += 1;
    const dir = path.join(root, `${label}-${seq}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};
const writeTemp = (label, files) => writeFiles(makeDir(label), files);
const writeZip = async (label, files, options) => {
    const file = path.join(makeDir(label), `${label}.zip`);
    fs.writeFileSync(file, await zipFiles(files, options));
    return file;
};
const importFrom = (inputPath, { options, limits } = {}) => parse({ path: inputPath }, { options: normalizeOptions(options || {}), limits });
const wrap = (inner) => `<?xml version="1.0" encoding="UTF-8"?>\n<cn-application-body lang="zh" country="CN">${inner}</cn-application-body>`;
const xmlFile = (inner) => Buffer.from(wrap(inner), 'utf8');

const textOf = (node) => collectText(node);
const sectionsOf = (doc) => [...new Map(doc.ir.children.map((node) => [node.data.section.index, node.data.section.header])).values()];
const bookNodes = (doc, header) => doc.ir.children.filter((node) => node.data.section.header === header && node.data.role !== 'section-title');
const paragraphsOf = (doc, header) => bookNodes(doc, header).filter((node) => node.type === 'paragraph');
function imagesIn(node, out = []) {
    if (node && node.type === 'image') out.push(node);
    for (const child of (node && node.children) || []) imagesIn(child, out);
    return out;
}
const lossLine = (key) => `${IMPORT_PREFIX}${LOSS_KINDS[key]}`;
const hasLoss = (doc, key) => doc.warnings.some((warning) => warning.startsWith(lossLine(key)));

// 去掉会随输入形态变化的字段后比较 IR 与资产
const comparable = (doc) => JSON.parse(JSON.stringify({ ir: doc.ir, assets: doc.assets.map((asset) => [asset.name, asset.mime, asset.buffer.length]), title: doc.meta.title },
    (key, value) => (key === 'buffer' ? undefined : value)));

// ============================================================
// 输入形态
// ============================================================

describe('输入形态', () => {
    test('官方形态的目录：五书合并为一份文档，分节顺序为 摘要 → 摘要附图 → 权利要求书 → 说明书 → 说明书附图', async () => {
        const doc = await importFrom(writeTemp('official-dir', official.files));

        assert.deepEqual(sectionsOf(doc), BOOK_HEADERS);
        assert.equal(doc.meta.title, OFFICIAL_EXPECTED.inventionTitle);
        assert.equal(doc.meta.sourceType, 'xml');
        assert.equal(doc.kind, 'document');
        assert.deepEqual(doc.assets.map((asset) => asset.name).sort(),
            ['images/100002_1.jpg', 'images/100003_1.jpg', 'images/100003_2.jpg', 'images/100005_1.jpg']);
        assert.ok(doc.assets.every((asset) => asset.mime === 'image/jpeg' && Buffer.isBuffer(asset.buffer)));
        assert.deepEqual(paragraphsOf(doc, '说明书摘要').map(textOf), [OFFICIAL_EXPECTED.abstract]);
        assert.deepEqual(paragraphsOf(doc, '说明书附图').filter((node) => imagesIn(node).length === 0).map(textOf), OFFICIAL_EXPECTED.figureLabels);
        assert.equal(doc.warnings[0], `${IMPORT_PREFIX}已读取 说明书摘要（1 段）、摘要附图（1 幅）、权利要求书（3 项）、说明书（7 段、5 个小标题）、说明书附图（2 幅）；内嵌图片 4 幅`);
        assert.ok(doc.warnings.every((warning) => warning.startsWith(IMPORT_PREFIX)), '全部问题项带稳定前缀');
    });

    test('官方形态的 zip、外套一层文件夹并带 macOS 杂项条目的 zip，与目录形态得到同一份 IR', async () => {
        const fromDir = await importFrom(writeTemp('same-dir', official.files));
        const fromZip = await importFrom(await writeZip('same-zip', official.files));
        const nested = await importFrom(await writeZip('nested-zip', {
            ...official.files,
            '__MACOSX/._100001.xml': Buffer.from([0, 5, 22, 7]),
            '.DS_Store': Buffer.from('x'),
        }, { prefix: '案卷/' }));

        assert.deepEqual(comparable(fromZip), comparable(fromDir));
        assert.deepEqual(comparable(nested), comparable(fromDir));
        assert.deepEqual(fromZip.warnings, fromDir.warnings);
        assert.deepEqual(nested.warnings, fromDir.warnings, '杂项条目不产生告警');
    });

    test('parsers/zip 与 parsers/xml 是同一个入口', () => {
        assert.equal(zipParser.parse, parse);
    });

    test('单个 XML：只导入该书，图片取自同级目录；无发明名称时标题取文件名', async () => {
        const dir = writeTemp('single', official.files);

        const description = await importFrom(path.join(dir, '100002', '100002.xml'));
        assert.deepEqual(sectionsOf(description), ['说明书']);
        assert.equal(description.meta.title, OFFICIAL_EXPECTED.inventionTitle);
        assert.deepEqual(description.assets.map((asset) => asset.name), ['images/100002_1.jpg']);

        const claims = await importFrom(path.join(dir, '100001', '100001.xml'));
        assert.deepEqual(sectionsOf(claims), ['权利要求书']);
        assert.equal(claims.meta.title, '100001');
        assert.deepEqual(claims.assets, []);
    });

    test('v3.0.0 平铺形态（目录与 zip）：书目按内容判定而非文件名，cn-drawing-p、claim-ref、figref 一并容忍', async () => {
        for (const input of [writeTemp('flat-dir', flat.files), await writeZip('flat-zip', flat.files)]) {
            const doc = await importFrom(input);

            assert.deepEqual(sectionsOf(doc), BOOK_HEADERS);
            assert.equal(doc.meta.title, FLAT_EXPECTED.inventionTitle);
            assert.deepEqual(paragraphsOf(doc, '权利要求书').map(textOf), ['1. ' + FLAT_EXPECTED.claims[0][0], '2. ' + FLAT_EXPECTED.claims[1][0]]);
            assert.deepEqual(paragraphsOf(doc, '说明书').map(textOf), FLAT_EXPECTED.paragraphs, 'figref 按纯文本取其内容');
            assert.deepEqual(paragraphsOf(doc, '说明书附图').map(textOf), ['', '图1'], '图片段在前、图号段在后，图号只出现一次');
            assert.deepEqual(doc.assets.map((asset) => asset.name), ['images/drawing-1.jpg'], '两书引用同一文件只登记一份');
            assert.ok(hasLoss(doc, 'references'));
            assert.ok(!doc.warnings.some((warning) => warning.includes('wi/he')), '四舍五入写的 wi/he 相差不足 1 mm，不算冲突');
        }
    });

    test('v3.0.0 平铺形态的单个 XML：图片取自同级目录，旧形态的图号段并入该图', async () => {
        const dir = writeTemp('flat-single', flat.files);
        const drawings = await importFrom(path.join(dir, 'drawings.xml'));
        assert.deepEqual(sectionsOf(drawings), ['说明书附图']);
        assert.deepEqual(drawings.assets.map((asset) => asset.name), ['images/drawing-1.jpg']);
        assert.deepEqual(paragraphsOf(drawings, '说明书附图').map(textOf), ['', '图1']);
        const figure = await importFrom(path.join(dir, 'abstract-figure.xml'));
        assert.deepEqual(sectionsOf(figure), ['摘要附图'], 'cn-abstract 内只有 cn-abst-figure 的是摘要附图，不是摘要');
    });

    test('文件名不参与书目判定：五书改成任意文件名后结果不变', async () => {
        const renamed = Object.fromEntries(Object.entries(flat.files).map(([name, buffer], index) => [name.endsWith('.xml') ? `任意名称-${index}.xml` : name, buffer]));
        const doc = await importFrom(writeTemp('renamed', renamed));
        assert.deepEqual(sectionsOf(doc), BOOK_HEADERS);
    });

    test('人工参照夹具五份（目录形态）：图片全缺也能导入，丢失项清单不多不少', async () => {
        const doc = await importFrom(REFERENCE_DIR);

        assert.deepEqual(sectionsOf(doc), BOOK_HEADERS);
        assert.equal(doc.meta.title, '横向校对和输出双层PDF的方法和装置');
        assert.deepEqual(doc.assets, []);
        const claims = paragraphsOf(doc, '权利要求书').map(textOf);
        assert.equal(claims.length, 5);
        assert.ok(claims[3].startsWith('2. 根据权利要求1所述的'), 'claim-ref 取其文字');
        assert.ok(claims[4].includes('1或2') && claims[4].includes('［缺图：omath-3-1.jpg］'), '缺图写成占位文字');
        assert.deepEqual(paragraphsOf(doc, '说明书附图').map(textOf), ['［缺图：图1（drawing-1.jpg）］', '［缺图：图2 装置结构示意图（drawing-2.jpg）］'],
            '附图区的缺图不留图号段，免得回转时错配给下一幅图');

        const losses = doc.warnings.filter((warning) => Object.values(LOSS_KINDS).some((text) => warning.startsWith(`${IMPORT_PREFIX}${text}`)));
        assert.deepEqual(losses, [
            `${lossLine('references')}（4 处：claim-ref×2、figref×2）`,
            `${lossLine('pageBreak')}（2 处）`,
            `${lossLine('tempParagraph')}（1 处）`,
        ]);
        const missing = doc.warnings.filter((warning) => warning.includes('已按缺图处理'));
        assert.equal(missing.length, 5, '五个不同的图片文件各报一次（同一文件被两书引用只报一次）');
    });

    test('一份 XML 含多个书目容器时逐个导入；同一书目出现多份时取文件名码点序的第一份并提示', async () => {
        const combined = xmlFile('<cn-claims><claim num="1"><claim-text>一种甲装置。</claim-text></claim></cn-claims>'
            + '<description><invention-title>甲装置</invention-title><p num="0001">甲段。</p></description>');
        const doc = await importFrom(writeTemp('multi', {
            'a.xml': combined,
            'b.xml': xmlFile('<cn-claims><claim num="1"><claim-text>一种乙装置。</claim-text></claim></cn-claims>'),
        }));

        assert.deepEqual(sectionsOf(doc), ['权利要求书', '说明书']);
        assert.deepEqual(paragraphsOf(doc, '权利要求书').map(textOf), ['1. 一种甲装置。']);
        assert.ok(doc.warnings.includes(`${IMPORT_PREFIX}权利要求书出现了多份，已采用 a.xml，忽略 b.xml`));
    });

    test('GBK 编码的 XML 按其声明的 encoding 解码', async () => {
        // 「权利」的 GBK 编码为 C8 A8 C0 FB
        const gbk = Buffer.concat([
            Buffer.from('<?xml version="1.0" encoding="GBK"?><cn-application-body><cn-claims><claim num="1"><claim-text>', 'latin1'),
            Buffer.from([0xC8, 0xA8, 0xC0, 0xFB]),
            Buffer.from('</claim-text></claim></cn-claims></cn-application-body>', 'latin1'),
        ]);
        const doc = await importFrom(path.join(writeTemp('gbk', { 'claims.xml': gbk }), 'claims.xml'));
        assert.deepEqual(paragraphsOf(doc, '权利要求书').map(textOf), ['1. 权利']);
    });
});

describe('非专利与畸形输入：中文错误，绝不抛栈外的异常', () => {
    const rejects = async (input, pattern) => {
        await assert.rejects(() => importFrom(input), (err) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, pattern);
            assert.equal(err.message.includes(root), false, '错误信息不带输入之外的路径');
            return true;
        });
    };

    test('generic profile 的 XML：指明是 MarkFlow 通用 XML，反向导入只受理专利五书', async () => {
        const dir = writeTemp('generic', { 'doc.xml': Buffer.from('<?xml version="1.0"?><document xmlns="urn:markflow:document:1" version="1"><body><p>正文</p></body></document>') });
        await rejects(path.join(dir, 'doc.xml'), /doc\.xml 是 MarkFlow 通用 XML（generic profile，根元素 document），反向导入只受理国知局专利五书 XML（根元素 cn-application-body）/);
    });

    test('未知根元素与非 XML 内容：指明实际的根元素', async () => {
        const dir = writeTemp('foreign', { 'pom.xml': Buffer.from('<project><name>x</name></project>'), 'text.xml': Buffer.from('随便一段文字') });
        await rejects(path.join(dir, 'pom.xml'), /pom\.xml 不是国知局专利五书 XML：根元素为 project，应为 cn-application-body/);
        await rejects(path.join(dir, 'text.xml'), /text\.xml 不是国知局专利五书 XML：未找到根元素，内容可能不是 XML/);
    });

    test('不含专利 XML 的 zip、损坏的 zip 与空目录', async () => {
        await rejects(await writeZip('other-zip', { 'readme.txt': Buffer.from('x'), 'data.xml': Buffer.from('<data/>') }), /zip 内未找到国知局专利五书 XML/);
        const broken = path.join(makeDir('broken'), 'broken.zip');
        fs.writeFileSync(broken, 'PK 这不是 zip');
        await rejects(broken, /无法读取 zip（文件已损坏、已加密或不是 zip）/);
        await rejects(makeDir('empty-dir'), /目录内未找到国知局专利五书 XML/);
    });

    test('畸形 XML：单文件输入直接报错；案卷里的某一份畸形只作废这一份并提示，其余照常导入', async () => {
        const bad = Buffer.from('<cn-application-body><cn-claims><claim num="1"><claim-text>未闭合</claim></cn-claims></cn-application-body>');
        const dir = writeTemp('malformed', { ...official.files, '100001/100001.xml': bad });

        await rejects(path.join(dir, '100001', '100001.xml'), /未能读出任何一份合法的国知局专利五书 XML/);
        const doc = await importFrom(dir);
        assert.deepEqual(sectionsOf(doc), ['说明书摘要', '摘要附图', '说明书', '说明书附图']);
        assert.ok(doc.warnings.some((warning) => /^导入：100001\/100001\.xml 不是合法的 XML，已忽略：结束标记 <\/claim> 与开始标记 <claim-text> 不匹配/.test(warning)));
    });

    test('五个书目容器均为空的 XML', async () => {
        const dir = writeTemp('hollow', { 'empty.xml': xmlFile('<cn-claims></cn-claims><description>\n</description>') });
        await rejects(path.join(dir, 'empty.xml'), /XML 内没有可导入的内容/);
    });
});

// ============================================================
// IR 映射
// ============================================================

describe('IR 映射', () => {
    const importXml = async (inner, extra = {}, settings) => {
        const dir = writeTemp('ir', { 'book.xml': xmlFile(inner), ...extra });
        return importFrom(path.join(dir, 'book.xml'), settings);
    };

    test('每个顶层节点带 data.section；每书首节点是 depth 1 的书目标题节点（data.role = section-title）', async () => {
        const doc = await importFrom(writeTemp('sections', official.files));
        assert.ok(doc.ir.children.every((node) => Number.isInteger(node.data.section.index) && typeof node.data.section.header === 'string'));
        const titles = doc.ir.children.filter((node) => node.data.role === 'section-title');
        assert.deepEqual(titles.map((node) => [node.type, node.depth, textOf(node), node.data.section.index]),
            BOOK_HEADERS.map((header, index) => ['heading', 1, header, index + 1]));
        for (const title of titles) {
            const first = doc.ir.children.find((node) => node.data.section.index === title.data.section.index);
            assert.equal(first, title, '书目标题节点是该节的首个节点');
        }
    });

    test('权利要求：首个 claim-text 冠以「N. 」，其余各成一段；不产出 list；嵌套的 claim-text 拍平并记丢失项', async () => {
        const doc = await importXml('<cn-claims>'
            + '<p num="XXXX">前言段。</p>'
            + '<claim id="cl001" num="1" claim-type="independent"><claim-text>一种装置，包括：<claim-text>部件甲；</claim-text><claim-text>部件乙。</claim-text></claim-text></claim>'
            + '<claim id="cl002" num="2"><claim-text>根据<claim-ref idref="cl001">权利要求1</claim-ref>所述的装置。</claim-text><claim-text>3. 以数字开头的后续段。</claim-text></claim>'
            + '<claim id="cl003" num="甲"><claim-text>项号不是数字。</claim-text></claim>'
            + '<claim id="cl004" num="04"><claim-text>项号补了零。</claim-text></claim>'
            + '</cn-claims>');

        assert.deepEqual(bookNodes(doc, '权利要求书').map((node) => node.type), Array(8).fill('paragraph'));
        assert.deepEqual(paragraphsOf(doc, '权利要求书').map(textOf), [
            '前言段。', '1. 一种装置，包括：', '部件甲；', '部件乙。', '2. 根据权利要求1所述的装置。', '3. 以数字开头的后续段。', '3. 项号不是数字。',
            '4. 项号补了零。',
        ]);
        assert.equal(doc.warnings.filter((warning) => warning.includes('不是数字')).length, 1, '补零的项号是数字，不提示');
        for (const key of ['nestedClaimText', 'claimType', 'references', 'claimContinuation']) assert.ok(hasLoss(doc, key), key);
        assert.ok(doc.warnings.includes(`${IMPORT_PREFIX}第 3 项权利要求的 num「甲」不是数字，已按顺序编为 3`));
        assert.ok(!hasLoss(doc, 'tempParagraph'), '权利要求书的前言段本就回转为临时段，不算丢失');
    });

    test('说明书：发明名称为 depth 1 标题，heading 的 depth 取 level，Italic="1" 整段包成 emphasis，行内标记逐一映射', async () => {
        const doc = await importXml('<description>'
            + '<invention-title>一种<b>测试</b>装置</invention-title>'
            + '<heading id="h0001" level="2">技术领域</heading>'
            + '<p id="p0001" num="0001" Italic="0">第<sub>i</sub>行第<sup>j</sup>列，<b>粗<i>粗斜</i></b>、<u style="double">双线</u>、<smallcaps>小型大写</smallcaps>。<br/>换行后。</p>'
            + '<heading id="h0002" level="3">三级标题</heading>'
            + '<p id="p0002" num="0002" Italic="1">整段斜体，含<b>粗体</b>。</p>'
            + '<p id="l0001" num="XXXX" Italic="0">图中：1、外壳。</p>'
            + '</description>');
        const nodes = bookNodes(doc, '说明书');

        assert.deepEqual(nodes.map((node) => [node.type, node.depth || 0, textOf(node)]), [
            ['heading', 1, '一种测试装置'], ['heading', 2, '技术领域'],
            ['paragraph', 0, '第i行第j列，粗粗斜、双线、小型大写。换行后。'],
            ['heading', 3, '三级标题'], ['paragraph', 0, '整段斜体，含粗体。'], ['paragraph', 0, '图中：1、外壳。'],
        ]);
        assert.deepEqual(nodes[2].children.map((node) => node.type),
            ['text', 'subscript', 'text', 'superscript', 'text', 'strong', 'text', 'underline', 'text', 'break', 'text']);
        assert.deepEqual(nodes[2].children[5].children.map((node) => node.type), ['text', 'emphasis'], '粗体内嵌斜体');
        assert.deepEqual(nodes[4].children.map((node) => node.type), ['emphasis'], 'Italic="1" 整段斜体');
        assert.deepEqual(nodes[4].children[0].children.map((node) => node.type), ['text', 'strong', 'text']);
        assert.equal(doc.meta.title, '一种测试装置');
        for (const key of ['titleMarkup', 'headingLevel', 'inlineStyle', 'tempParagraph']) assert.ok(hasLoss(doc, key), key);
        assert.ok(doc.warnings.some((warning) => warning.includes('u style="double"') && warning.includes('smallcaps')));
    });

    test('发明名称超过正向链路认标题的 40 字上限时改写成「发明名称：X」字段段', async () => {
        const long = `一种${'很长的'.repeat(14)}装置`;
        assert.ok(long.length > 40);
        const doc = await importXml(`<description><invention-title>${long}</invention-title><p num="0001">正文。</p></description>`);
        const [first] = bookNodes(doc, '说明书');
        assert.deepEqual([first.type, textOf(first)], ['paragraph', `发明名称：${long}`]);
        assert.equal(doc.meta.title, long);
    });

    test('XML 里的换行是排版而非内容：汉字之间与节点边界处删除，西文之间留一个空格；只含排版空白的文本节点丢弃', async () => {
        const doc = await importXml([
            '<description>',
            '  <p id="p0001" num="0001" Italic="0">前一行',
            '      后一行 and',
            '      English words',
            '  </p>',
            '  <p id="p0002" num="0002" Italic="0">',
            '    <b>粗体</b>',
            '    <i>斜体</i>',
            '  </p>',
            `  <p id="p0003" num="0003" Italic="0">${NBSP}${NBSP}段首的不间断空格保留</p>`,
            '</description>',
        ].join('\r\n'));
        const [first, second, third] = paragraphsOf(doc, '说明书');

        assert.equal(textOf(first), '前一行后一行 and English words');
        assert.deepEqual(second.children.map((node) => [node.type, textOf(node)]), [['strong', '粗体'], ['emphasis', '斜体']]);
        assert.equal(textOf(third), `${NBSP}${NBSP}段首的不间断空格保留`);
    });

    test('technical-field 等语义分节容器展开为其内的 heading 与 p；未映射的元素只留文字并记丢失项', async () => {
        const doc = await importXml('<description><invention-title>甲</invention-title>'
            + '<technical-field><heading level="2">技术领域</heading><p num="0001">领域段。</p></technical-field>'
            + '<background-art><p num="0002">背景段，见<patcit num="1">文献一</patcit>。</p><ul><li>列表项</li></ul></background-art>'
            + '<disclosure><tech-problem><p num="0003">嵌套两层的段。</p></tech-problem><note><b>未知容器里的<i>行内标记</i></b></note></disclosure>'
            + '<pb pnum="1"/></description>');

        assert.deepEqual(bookNodes(doc, '说明书').map((node) => [node.type, textOf(node)]), [
            ['heading', '甲'], ['heading', '技术领域'], ['paragraph', '领域段。'], ['paragraph', '背景段，见文献一。'], ['paragraph', '列表项'],
            ['paragraph', '嵌套两层的段。'], ['paragraph', '未知容器里的行内标记'],
        ]);
        const last = bookNodes(doc, '说明书')[6];
        assert.deepEqual([last.children[0].type, last.children[0].children[1].type], ['strong', 'emphasis'], '未知容器里的行内标记照常保留');
        assert.ok(hasLoss(doc, 'unmapped') && hasLoss(doc, 'pageBreak'));
        assert.ok(doc.warnings.some((warning) => warning.includes('<patcit>') && warning.includes('<ul>')));
    });

    test('段号：缺省不写进正文，非自 1 连续时记丢失项；xmlImport.paragraphNumbers 开启时写回段首', async () => {
        const inner = '<description><p num="0005">甲。</p><p num="0006">乙。</p><p num="XXXX">临时。</p></description>'
            + '<cn-abstract><p num="0001">摘要。</p></cn-abstract>';

        const plain = await importXml(inner);
        assert.deepEqual(paragraphsOf(plain, '说明书').map(textOf), ['甲。', '乙。', '临时。']);
        assert.ok(plain.warnings.some((warning) => warning.startsWith(lossLine('paragraphNumber')) && warning.includes('1 处：[0005]')));

        const numbered = await importXml(inner, {}, { options: { xmlImport: { paragraphNumbers: true } } });
        assert.deepEqual(paragraphsOf(numbered, '说明书').map(textOf), ['[0005]  甲。', '[0006]  乙。', '临时。']);
        assert.deepEqual(paragraphsOf(numbered, '说明书摘要').map(textOf), ['[0001]  摘要。']);
        assert.ok(!hasLoss(numbered, 'paragraphNumber'));
    });

    test('附图：官方形态取 figure-labels；旧形态把 cn-drawing-p 的图号与只含图注的 figure-labels 合并；图号段只出现一次', async () => {
        const images = { 'a.jpg': jpeg, 'b.jpg': jpeg, 'c.jpg': jpeg, 'd.jpg': jpeg };
        const figure = (attrs, file) => `<figure ${attrs}><img file="${file}" wi="25" he="12" img-format="jpg"/></figure>`;
        const doc = await importXml('<cn-drawings>'
            + figure('num="0001" figure-labels="图1"', 'a.jpg')
            + `<cn-drawing-p><p num="XXXX">图2</p></cn-drawing-p>${figure('num="2" figure-labels="装置结构示意图"', 'b.jpg')}<pb pnum="1"/>`
            + `${figure('num="3"', 'c.jpg')}<cn-drawing-p><p num="XXXX">图3：局部放大图</p></cn-drawing-p>`
            + `<cn-drawing-p><p num="XXXX">附图的杂散说明。</p>${figure('', 'd.jpg')}</cn-drawing-p>`
            + '</cn-drawings>', images);
        const nodes = paragraphsOf(doc, '说明书附图');

        assert.deepEqual(nodes.map((node) => (imagesIn(node).length > 0 ? `［${imagesIn(node)[0].url}］` : textOf(node))), [
            '［images/a.jpg］', '图1', '［images/b.jpg］', '图2 装置结构示意图', '［images/c.jpg］', '图3：局部放大图',
            '附图的杂散说明。', '［images/d.jpg］', '图4',
        ]);
        assert.ok(hasLoss(doc, 'pageBreak'));
    });

    test('摘要附图：只写图片段；figure/@num 与顺序不符时补一个图号段，使回转后的 num 不变', async () => {
        const figure = (num, file) => `<figure id="f000${num}" num="000${num}" figure-labels="图${num}"><img file="${file}" wi="25" he="12"/></figure>`;
        const sequential = await importXml(`<cn-abstract><p num="0001">摘要。</p><cn-abst-figure>${figure(1, 'a.jpg')}</cn-abst-figure></cn-abstract>`, { 'a.jpg': jpeg });
        assert.deepEqual(sectionsOf(sequential), ['说明书摘要', '摘要附图'], '同一个 cn-abstract 里的摘要与摘要附图分属两书');
        assert.deepEqual(paragraphsOf(sequential, '摘要附图').map(textOf), ['']);
        assert.ok(hasLoss(sequential, 'figureAttributes'));

        const third = await importXml(`<cn-abstract><cn-abst-figure>${figure(3, 'a.jpg')}</cn-abst-figure></cn-abstract>`, { 'a.jpg': jpeg });
        assert.deepEqual(paragraphsOf(third, '摘要附图').map(textOf), ['', '图3']);
    });
});

// ============================================================
// 图片
// ============================================================

describe('图片', () => {
    test('maths / tables / chemistry 内的图带 data.role；代码化分支不导入；没有图片的退为其文字', async () => {
        const dir = writeTemp('roles', {
            'book.xml': xmlFile('<description><p num="0001">式<maths id="math0001" num="0001"><img file="f.jpg" wi="25" he="12"/></maths>、'
                + '表<tables num="1"><table><tgroup cols="1"><tbody><row><entry>格</entry></row></tbody></tgroup></table><img file="t.jpg" wi="25" he="12"/></tables>、'
                + '化学式<chemistry num="1"><img file="c.jpg" wi="25" he="12" alt="苯环"/></chemistry>、'
                + '纯代码<maths num="2"><math><mi>x</mi><mo>+</mo><mn>1</mn></math></maths>。</p></description>'),
            'f.jpg': jpeg, 't.jpg': jpeg, 'c.jpg': jpeg,
        });
        const doc = await importFrom(path.join(dir, 'book.xml'));
        const [paragraph] = paragraphsOf(doc, '说明书');

        assert.deepEqual(imagesIn(paragraph).map((node) => [node.url, node.data.role, node.alt]),
            [['images/f.jpg', 'formula', ''], ['images/t.jpg', 'table', ''], ['images/c.jpg', 'chemistry', '苯环']]);
        assert.equal(textOf(paragraph), '式、表、化学式、纯代码x+1。');
        assert.ok(hasLoss(doc, 'codedObject'));
        assert.ok(doc.warnings.includes(`${IMPORT_PREFIX}公式、表格与化学式共 3 处为图片，Word 中不能编辑其内容；其替换文字里的 markflow:role 标记用于回转时还原为 maths / tables / chemistry，请勿删改`));
    });

    test('image 节点带内嵌资产、96 DPI 显示像素与物理显示尺寸；同名文件出现在不同目录时依次改名', async () => {
        const doc = await importFrom(await writeZip('names', {
            'a/claims.xml': xmlFile('<cn-claims><claim num="1"><claim-text>见<img file="x.jpg" wi="25" he="12"/></claim-text></claim></cn-claims>'),
            'b/abstract.xml': xmlFile('<cn-abstract><p num="0001">见<img file="x.jpg" wi="25" he="12"/>与<img file="X.JPG" wi="25" he="12"/></p></cn-abstract>'),
            'a/x.jpg': jpeg,
            'b/x.jpg': await makeJpeg({ width: 600, height: 300 }),
        }));

        assert.deepEqual(doc.assets.map((asset) => asset.name), ['images/x.jpg', 'images/x_2.jpg', 'images/X_3.JPG'],
            '摘要在前、权利要求书在后；大小写不同的文件名按不分大小写判重');
        const [first] = imagesIn({ children: paragraphsOf(doc, '说明书摘要') });
        assert.equal(first.data.assetName, first.url);
        assert.deepEqual(first.data.display, { width: 192, height: 96, unit: 'px', source: 'xml' }, '600 px @300 DPI = 50.8 mm = 192 px @96 DPI');
        assert.equal(first.data.displayWidthMm, (600 * 3048) / EMU_PER_MM);
        assert.equal(first.data.asset.mime, 'image/jpeg');
        assert.deepEqual([first.data.asset.width, first.data.asset.height], [600, 300]);
        assert.ok(Buffer.isBuffer(first.data.asset.buffer));
    });

    test('显示尺寸：以像素与密度为准，在半个像素内向 wi/he 对齐；对不齐即以像素为准，相差 1 mm 以上才提示', () => {
        const mm = (size) => [size.width / EMU_PER_MM, size.height / EMU_PER_MM];
        const at300 = (px) => (px * 3048) / EMU_PER_MM;

        // 官方样稿的实测情形：2138 px → 181.02 mm，而 he="180"；挪到 181 mm 以下 1 EMU，回转后仍是 2138 px 与 he="180"
        const crossed = displaySize({ width: 1353, height: 2138, dpi: 300 }, { wi: '114', he: '180' });
        assert.deepEqual(mm(crossed), [at300(1353), 181 - 1 / EMU_PER_MM]);
        assert.equal(Math.round((crossed.height / EMU_PER_MM / 25.4) * 300), 2138);
        assert.equal(Math.floor(crossed.height / EMU_PER_MM), 180);
        // 恰为整数毫米：多留 1 EMU，免得浮点误差让向下取整少 1
        assert.deepEqual(mm(displaySize({ width: 1500, height: 1500, dpi: 300 }, { wi: '127', he: '127' })), [127 + 1 / EMU_PER_MM, 127 + 1 / EMU_PER_MM]);
        // 一致的无需挪动；四舍五入写的 wi/he（旧产物）以像素为准且不提示
        assert.deepEqual(mm(displaySize({ width: 1730, height: 852, dpi: 300 }, { wi: '146', he: '72' })), [at300(1730), at300(852)]);
        const rounded = displaySize({ width: 600, height: 360, dpi: 330 }, { wi: '46', he: '28' });
        assert.equal(rounded.conflict, undefined);
        assert.equal(Math.round(rounded.height), Math.round((360 * 914400) / 330));
        // 手写 XML：wi/he 与图片对不上，以像素与密度为准并提示
        const conflict = displaySize({ width: 800, height: 600, dpi: 96 }, { wi: '120', he: '90' });
        assert.deepEqual(conflict.conflict, { declared: '120×90', natural: '211.7×158.8' });
        // 图片不带密度：取 wi/he；只有 wi 时高度按宽高比补；都没有按 300 DPI 估算
        assert.deepEqual(mm(displaySize({ width: 800, height: 600, dpi: null }, { wi: '120', he: '90' })), [120 + 1 / EMU_PER_MM, 90 + 1 / EMU_PER_MM]);
        assert.equal(displaySize({ width: 800, height: 600, dpi: null }, { wi: '120' }).height, Math.round(((120 * EMU_PER_MM + 1) * 600) / 800));
        assert.deepEqual(mm(displaySize({ width: 600, height: 300, dpi: null }, {})), [at300(600), at300(300)]);
        // 不可信的密度（30 DPI 以下、5000 DPI 以上）按无密度处理；超大尺寸按比例缩回 1000 mm 以内
        assert.deepEqual(mm(displaySize({ width: 600, height: 300, dpi: 1 }, {})), [at300(600), at300(300)]);
        assert.deepEqual(mm(displaySize({ width: 30000, height: 15000, dpi: 300 }, {})), [1000, 500]);
        assert.equal(displaySize({ width: 0, height: 10, dpi: 300 }, {}), null);
    });

    test('导入时 wi/he 与图片对不上：以像素与密度为准，并提示一次', async () => {
        const dir = writeTemp('conflict', {
            'book.xml': xmlFile('<cn-drawings><figure num="1"><img file="a.jpg" wi="120" he="90"/></figure></cn-drawings>'),
            'a.jpg': jpeg,
        });
        const doc = await importFrom(path.join(dir, 'book.xml'));
        assert.ok(doc.warnings.includes(`${IMPORT_PREFIX}图片 a.jpg 的 wi/he（120×90 mm）与按其像素和密度换算的尺寸（25.4×12.7 mm）不一致，已按像素与密度确定显示尺寸`));
        const [image] = imagesIn({ children: doc.ir.children });
        assert.equal(image.data.displayWidthMm, (300 * 3048) / EMU_PER_MM);
    });

    test('PNG 等不带密度的图片按 wi/he 定尺寸；扩展名与内容不符时以魔数为准', async () => {
        const dir = writeTemp('png', {
            'book.xml': xmlFile('<cn-drawings><figure num="1"><img file="a.jpg" wi="40" he="20"/></figure></cn-drawings>'),
            'a.jpg': await makePng({ width: 80, height: 40 }),
        });
        const doc = await importFrom(path.join(dir, 'book.xml'));
        const [image] = imagesIn({ children: doc.ir.children });
        assert.equal(image.data.asset.mime, 'image/png');
        assert.deepEqual([image.data.displayWidthMm, image.data.displayHeightMm], [40 + 1 / EMU_PER_MM, 20 + 1 / EMU_PER_MM]);
    });
});

// ============================================================
// 安全边界
// ============================================================

describe('安全边界：img/@file、符号链接与体量上限', () => {
    const drawingsXml = (file) => xmlFile(`<cn-drawings><figure num="1"><img file="${file}" wi="25" he="12"/></figure></cn-drawings>`);

    test('img/@file 只接受同目录下的裸文件名与白名单扩展名；越界引用不读盘，按缺图处理', async () => {
        assert.deepEqual(['a.jpg', 'A.JPEG', '图 1.tif', 'x.tiff', 'y.png', 'z.gif', 'w.bmp'].filter((name) => !isAcceptableFileName(name)), []);
        const rejected = ['', '.', '..', '../a.jpg', 'sub/a.jpg', 'sub\\a.jpg', '/etc/passwd', '/abs/a.jpg', 'C:\\a.jpg', 'C:a.jpg', 'file:///a.jpg',
            '.hidden.jpg', 'a.exe', 'a.svg', 'a.jpg.txt', 'a', `${'x'.repeat(300)}.jpg`, `a${String.fromCharCode(0)}.jpg`, `a${String.fromCharCode(10)}.jpg`];
        assert.deepEqual(rejected.filter((name) => isAcceptableFileName(name)), []);

        // 目录之外真有一张同名图片：若越界读盘，它会被导入
        const outer = makeDir('escape');
        fs.writeFileSync(path.join(outer, 'outside.jpg'), jpeg);
        for (const file of ['../outside.jpg', path.join(outer, 'outside.jpg'), 'inner/../../outside.jpg']) {
            const dir = writeFiles(path.join(outer, `case-${seq += 1}`), { 'drawings.xml': drawingsXml(file) });
            const doc = await importFrom(path.join(dir, 'drawings.xml'));
            assert.deepEqual(doc.assets, [], file);
            assert.ok(doc.warnings.some((warning) => warning.includes('不是同目录下受支持的裸文件名') && warning.includes('已按缺图处理')), file);
            assert.deepEqual(paragraphsOf(doc, '说明书附图').map(textOf), [`［缺图：图1（${file}）］`]);
        }
    });

    test('目录形态：指向目录之外的符号链接（图片与 XML）按缺失处理，不跟随', async (t) => {
        const outer = makeDir('symlink');
        fs.writeFileSync(path.join(outer, 'secret.jpg'), jpeg);
        fs.writeFileSync(path.join(outer, 'secret.xml'), xmlFile('<cn-abstract><p num="0001">目录之外的摘要。</p></cn-abstract>'));
        const dir = writeFiles(path.join(outer, 'case'), { 'drawings.xml': drawingsXml('link.jpg') });
        try {
            fs.symlinkSync(path.join(outer, 'secret.jpg'), path.join(dir, 'link.jpg'));
            fs.symlinkSync(path.join(outer, 'secret.xml'), path.join(dir, 'abstract.xml'));
        } catch (err) {
            t.skip(`当前环境无法创建符号链接：${err.message}`);
            return;
        }

        const doc = await importFrom(dir);

        assert.deepEqual(sectionsOf(doc), ['说明书附图'], '链接进来的摘要不导入');
        assert.deepEqual(doc.assets, []);
        assert.ok(doc.warnings.includes(`${IMPORT_PREFIX}abstract.xml 是指向输入目录之外的链接，已忽略`));
        assert.ok(doc.warnings.includes(`${IMPORT_PREFIX}图片 link.jpg 是指向 XML 所在目录之外的链接，已按缺图处理`));
    });

    test('扩展名是图片而内容不是：魔数不认识的一律不导入', async () => {
        const dir = writeTemp('magic', { 'drawings.xml': drawingsXml('a.jpg'), 'a.jpg': Buffer.from('#!/bin/sh\necho 这不是图片\n') });
        const doc = await importFrom(path.join(dir, 'drawings.xml'));
        assert.deepEqual(doc.assets, []);
        assert.ok(doc.warnings.includes(`${IMPORT_PREFIX}图片 a.jpg 的内容不是受支持的图片格式（jpg / tif / png / gif / bmp），已按缺图处理`));
    });

    test('zip：含 .. 片段、绝对路径或盘符的条目名一经发现，整个 zip 拒绝导入', async () => {
        assert.deepEqual(['../a.xml', 'a/../../b.xml', '/abs.xml', 'C:/win.xml', 'c:\\win.xml'.replace(/\\/g, '/')].filter((name) => !isUnsafeEntryName(name)), []);
        assert.deepEqual(['a.xml', '100001/100001.xml', '案卷/100003/100003_1.jpg', 'a..b/c.xml', ''].filter((name) => isUnsafeEntryName(name)), []);
        for (const evil of ['../evil.xml', 'x/../../evil.jpg', '/abs.xml', 'C:/win.xml', '..\\evil.xml']) {
            const input = await writeZip('unsafe', { ...official.files, [evil]: Buffer.from('x') });
            await assert.rejects(() => importFrom(input), /zip 内含不安全的条目名（\.\. 片段、绝对路径或盘符），已拒绝导入/, evil);
        }
    });

    test('zip：符号链接条目忽略并提示，其余照常导入', async () => {
        const zip = new JSZip();
        for (const [name, buffer] of Object.entries(official.files)) if (name !== '100005/100005_1.jpg') zip.file(name, buffer, { createFolders: false });
        zip.file('100005/100005_1.jpg', '../../../outside.jpg', { unixPermissions: 0o120777, createFolders: false });
        const input = path.join(makeDir('zip-symlink'), 'case.zip');
        fs.writeFileSync(input, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));

        const doc = await importFrom(input);

        assert.ok(doc.warnings.includes(`${IMPORT_PREFIX}zip 条目 100005/100005_1.jpg 是符号链接，已忽略`));
        assert.deepEqual(paragraphsOf(doc, '摘要附图').map(textOf), ['［缺图：图1（100005_1.jpg）］']);
        assert.equal(doc.assets.length, 3);
    });

    test('zip：条目数、单条目（含谎报大小的 zip bomb）与总量上限', async () => {
        const input = await writeZip('limits', official.files);
        await assert.rejects(() => importFrom(input, { limits: { MAX_ZIP_ENTRIES: 5 } }), /zip 条目数 9 超过 5 上限，已拒绝导入/);
        await assert.rejects(() => importFrom(input, { limits: { MAX_ZIP_BYTES: 1024 } }), /zip 文件超过 1024 字节 上限，已拒绝导入/);
        await assert.rejects(() => importFrom(input, { limits: { MAX_TOTAL_BYTES: 4096 } }), /案卷内容合计超过 4096 字节 上限，已拒绝导入/);

        // 申报大小超限：不解压即忽略该条目，该图按缺图处理
        const declared = await importFrom(input, { limits: { MAX_IMAGE_BYTES: 2048 } });
        assert.ok(declared.warnings.some((warning) => /^导入：zip 条目 100003\/100003_1\.jpg 解压后超过 2048 字节 上限，已忽略$/.test(warning)));
        assert.ok(declared.assets.length < 4);

        // 谎报大小：中央目录与本地文件头都写 100 字节，实际解压出 4 MB；边解压边计数，超限即停
        const bomb = await zipFiles({ ...official.files, '100003/100003_1.jpg': Buffer.alloc(4 * 1024 * 1024) });
        const lying = path.join(makeDir('bomb'), 'bomb.zip');
        fs.writeFileSync(lying, forgeUncompressedSize(bomb, '100003/100003_1.jpg', 100));
        const forged = (await JSZip.loadAsync(fs.readFileSync(lying))).file('100003/100003_1.jpg');
        assert.equal(forged._data.uncompressedSize, 100, '夹具须确实谎报了大小，否则下面验到的只是申报大小的提前拒绝');
        const started = Date.now();
        const doc = await importFrom(lying, { limits: { MAX_IMAGE_BYTES: 64 * 1024 } });
        assert.ok(doc.warnings.includes(`${IMPORT_PREFIX}zip 条目 100003/100003_1.jpg 解压后超过 65536 字节 上限，已忽略`));
        assert.ok(Date.now() - started < 5000);
        assert.deepEqual(sectionsOf(doc), BOOK_HEADERS, '其余内容照常导入');
    });

    test('XML 体量与嵌套深度上限；缺省上限留足余量', async () => {
        const dir = writeTemp('xml-limits', official.files);
        await assert.rejects(() => importFrom(path.join(dir, '100002', '100002.xml'), { limits: { MAX_XML_BYTES: 512 } }),
            /XML 文件 100002\.xml 超过 512 字节 上限，已拒绝导入/);
        const partial = await importFrom(dir, { limits: { MAX_XML_BYTES: 1500 } });
        assert.ok(partial.warnings.includes(`${IMPORT_PREFIX}100002/100002.xml 超过 1500 字节 上限，已忽略`));
        assert.equal(sectionsOf(partial).includes('说明书'), false);

        const deep = writeTemp('deep', { 'deep.xml': xmlFile(`<description><p num="0001">${'<b>'.repeat(100)}深${'</b>'.repeat(100)}</p></description>`) });
        await assert.rejects(() => importFrom(path.join(deep, 'deep.xml')), /未能读出任何一份合法的国知局专利五书 XML/);

        assert.deepEqual(LIMITS, {
            MAX_XML_BYTES: 32 * 1024 * 1024, MAX_IMAGE_BYTES: 64 * 1024 * 1024, MAX_ZIP_BYTES: 512 * 1024 * 1024,
            MAX_TOTAL_BYTES: 1024 * 1024 * 1024, MAX_ZIP_ENTRIES: 2000, MAX_XML_CANDIDATES: 64,
        });
    });

    test('问题清单：同一文案只留一条，条目总数封顶，未登记的丢失项直接报错', () => {
        const report = createReport();
        for (let i = 0; i < MAX_WARNINGS + 50; i += 1) report.warn(`第 ${i} 条`);
        report.warn('第 0 条');
        report.loss('pageBreak');
        const warnings = report.toWarnings();
        assert.equal(warnings.length, MAX_WARNINGS);
        assert.equal(warnings[MAX_WARNINGS - 1], `${IMPORT_PREFIX}另有 52 条提示未列出`);
        assert.ok(warnings.every((warning) => warning.startsWith(IMPORT_PREFIX)));
        assert.throws(() => report.loss('no-such-kind'), /未登记的导入丢失项/);
    });
});

/**
 * 把 zip 里某个条目申报的「解压后大小」改写为 fake（本地文件头偏移 22、中央目录偏移 24，均为 4 字节小端），
 * 模拟谎报大小的 zip bomb；压缩数据本身不动。
 */
function forgeUncompressedSize(zipBuffer, entryName, fake) {
    const out = Buffer.from(zipBuffer);
    const name = Buffer.from(entryName, 'utf8');
    const patch = (signature, sizeOffset, nameLengthOffset, nameOffset) => {
        for (let at = out.indexOf(signature); at >= 0; at = out.indexOf(signature, at + 4)) {
            const length = out.readUInt16LE(at + nameLengthOffset);
            if (length === name.length && out.subarray(at + nameOffset, at + nameOffset + length).equals(name)) out.writeUInt32LE(fake, at + sizeOffset);
        }
    };
    patch(Buffer.from([0x50, 0x4B, 0x03, 0x04]), 22, 26, 30);
    patch(Buffer.from([0x50, 0x4B, 0x01, 0x02]), 24, 28, 46);
    return out;
}
