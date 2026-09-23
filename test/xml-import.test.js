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
 *   末尾修剪——trimInline 在 8 万个空格或回车长段上的耗时上限，与线性化之前的实现逐字等价（差分）；
 *   图号段判定——figureLabelNumber 在 figure-labels 里 8 万个空格长段上的耗时上限（经 booksToIr），与线性化之前的实现逐字等价（差分）；
 *   换行归一的耗时——joinLineBreaks 在不以换行结尾的 8 万个空格（或空格与制表符交替）长段上的耗时上限，与自换行起匹配
 *     之前的实现逐字等价（差分）；
 *   首尾空白节点剥离——trimInline 在段首、段尾各 6 万个空白节点（换行与空白文本交替）上的耗时上限，与一次切片之前的
 *     实现逐项等价、不改动入参（差分）；
 *   增补平面汉字——joinLineBreaks 把换行两侧的 U+20000–U+3FFFF（扩展 B、G）按汉字判定，含文本节点边界；第 1 平面字符与孤立
 *     代理不算汉字、行为不变（对照组）；BMP 逐码元与修改前的实现逐字相同，随机串与占位替换参照逐字相同（差分，各分支设命中计数）；
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

// ============================================================
// trimInline：末尾修剪线性于串长（耗时上限与逐字等价）
// ============================================================

const { isDeepStrictEqual } = require('node:util');
const { trimInline } = require('../converters/parsers/xml/inline');

// 耗时用例的输入规模：a 与 b 之间夹 8 万个同一种半角空白，这一长段不处于串尾
const EDGE_SPACE_STRESS_LENGTH = 80000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。200 ms 使两侧余量都不小于 5 倍——
// 逐字符扫描之前的 /[ \t\r\n]+$/ 在这一规模上两种形态实测约 1.8 至 2.4 秒（耗时随段长平方增长），是上限的 9 倍以上；
// 逐字符扫描之后单次调用实测至多约 0.2 毫秒（每次新起进程的冷调用），约为上限的千分之一
const EDGE_SPACE_STRESS_BUDGET_MS = 200;
// 串尾须删去的空白：半角空格、制表符、回车与换行各一个
const TRAILING_EDGE_SPACES = ' \t\r\n';

const elapsedMsSince = (started) => Number(process.hrtime.bigint() - started) / 1e6;

// 宽义空白以码点生成，源码里不出现看不见的字面量；不间断空格沿用文件头自夹具模块导入的 NBSP（U+00A0）
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

// 逐字符扫描之前的实现，仅作短输入的差分参照：/[ \t\r\n]+$/ 在不处于串尾的长段上逐位回溯，不可用于耗时用例的输入规模。
// 两个正则、textNode、isBlankEdge 与 trimInline 照录旧文件，只把末尾修剪的结果拆成变量，以便在 hits 上记下覆盖计数
const LEGACY_EDGE_SPACE_START_RE = /^[ \t\r\n]+/;
const LEGACY_EDGE_SPACE_END_RE = /[ \t\r\n]+$/;
const legacyTextNode = (value) => ({ type: 'text', value });
const legacyIsBlankEdge = (node) => node.type === 'break' || (node.type === 'text' && node.value.replace(LEGACY_EDGE_SPACE_START_RE, '') === '');

function legacyTrimInline(nodes, hits) {
    let list = [...nodes];
    while (list.length > 0 && legacyIsBlankEdge(list[0])) list = list.slice(1);
    while (list.length > 0 && legacyIsBlankEdge(list[list.length - 1])) list = list.slice(0, -1);
    if (list.length === 0) return list;
    const first = list[0];
    if (first.type === 'text') list[0] = legacyTextNode(first.value.replace(LEGACY_EDGE_SPACE_START_RE, ''));
    const last = list[list.length - 1];
    if (last.type === 'text') {
        const trimmed = last.value.replace(LEGACY_EDGE_SPACE_END_RE, '');
        if (trimmed !== last.value) hits.removed += 1;
        if (trimmed !== last.value && trimmed.endsWith(NBSP)) hits.stoppedAtNbsp += 1;
        if (trimmed === last.value && last.value.endsWith(NBSP)) hits.nbspKept += 1;
        list[list.length - 1] = legacyTextNode(trimmed);
    }
    return list;
}

// 差分字母表：旧字符类 [ \t\r\n] 的四个成员；不在其内、trimEnd 却会删去的三种宽义空白（U+00A0、U+3000、U+2028）；
// 西文与汉字的可见字符各一个
const TRIM_DIFF_ALPHABET = [' ', '\t', '\r', '\n', NBSP, IDEOGRAPHIC_SPACE, LINE_SEPARATOR, 'a', '文'];
// 其它行内节点：修剪不改动它们，只决定首尾是否落在文本上；每次新建，样本之间不共享对象
const OTHER_INLINE_NODE_BUILDERS = [
    () => ({ type: 'image', url: 'images/1.png', alt: '' }),
    () => ({ type: 'strong', children: [{ type: 'text', value: ' 加粗 ' }] }),
    () => ({ type: 'superscript', children: [{ type: 'text', value: '2' }] }),
];

// 字母表上长度 0 到 maxLength 的全部字符串
function everyStringUpTo(maxLength, alphabet) {
    const all = [''];
    let level = [''];
    for (let length = 1; length <= maxLength; length += 1) {
        level = level.flatMap((prefix) => alphabet.map((token) => prefix + token));
        for (const text of level) all.push(text);
    }
    return all;
}

// 种子固定的 32 位伪随机数发生器（mulberry32）：每次运行抽到同一批样本，失败可原样复现
function createSeededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = Math.imul(state ^ (state >>> 15), state | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

// 逐码点列出，失败输出里的不可见字符也能看清
const toCodePoints = (text) => Array.from(text, (ch) => ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
const describeNodes = (nodes) => nodes.map((node) => (node.type === 'text' ? `text[${toCodePoints(node.value)}]` : node.type)).join(', ');

describe('trimInline：末尾修剪线性于串长', () => {
    // [形态说明, 长段所用字符]：导入链路上文本先经 joinLineBreaks，空格与制表符的长段在其 LINE_BREAK_RE 上另有回溯，
    // 纯回车的长段在该正则的首个回车处即失配、只落在末尾修剪上。这里直接调用 trimInline，只考察末尾修剪本身
    const stressShapes = [
        ['8 万个空格', ' '],
        ['8 万个回车（CR）', '\r'],
    ];

    for (const [label, spaceChar] of stressShapes) {
        test(`末尾文本节点里夹在可见字符之间的 ${label}不触发回溯：单次调用在绝对上限内，输出逐字正确`, () => {
            // Arrange：在计时区间外新构造字符串与节点
            const run = spaceChar.repeat(EDGE_SPACE_STRESS_LENGTH);
            const nodes = [{ type: 'text', value: `a${run}b${TRAILING_EDGE_SPACES}` }];

            // Act：计时区间只包这一次调用
            const started = process.hrtime.bigint();
            const result = trimInline(nodes);
            const elapsedMs = elapsedMsSince(started);

            // Assert：先验输出正确，以免「快」来自少做了事——串尾的空白删去，夹在中间的长段原样保留
            assert.deepEqual(result, [{ type: 'text', value: `a${run}b` }]);
            assert.ok(
                elapsedMs < EDGE_SPACE_STRESS_BUDGET_MS,
                `trimInline 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${EDGE_SPACE_STRESS_BUDGET_MS} ms`,
            );
        });
    }

    test('与逐字符扫描之前的实现逐字等价：穷举短串与种子固定的随机节点列表，末尾的删除与 U+00A0 的保留均有样本', (t) => {
        // Arrange：9 个字符的字母表上长度 0 到 5 的全部字符串共 66430 个，各以两种形态成列：单个文本节点（首尾修剪落在
        // 同一节点上），以及「图片 + 文本 + 换行」（末尾的换行先被丢弃，文本成为末节点，首部修剪不碰它）
        const samples = [];
        for (const text of everyStringUpTo(5, TRIM_DIFF_ALPHABET)) {
            samples.push([{ type: 'text', value: text }]);
            samples.push([OTHER_INLINE_NODE_BUILDERS[0](), { type: 'text', value: text }, { type: 'break' }]);
        }
        assert.equal(samples.length, 132860);

        // 种子固定的随机节点列表 30000 个：0 到 6 个节点，文本、换行与其它行内节点混排，文本长 0 到 8 个字符
        const random = createSeededRandom(20260923);
        const pick = (items) => items[Math.floor(random() * items.length)];
        const randomText = () => Array.from({ length: Math.floor(random() * 9) }, () => pick(TRIM_DIFF_ALPHABET)).join('');
        const randomNode = () => {
            const roll = random();
            if (roll < 0.55) return { type: 'text', value: randomText() };
            if (roll < 0.75) return { type: 'break' };
            return pick(OTHER_INLINE_NODE_BUILDERS)();
        };
        for (let i = 0; i < 30000; i += 1) samples.push(Array.from({ length: Math.floor(random() * 7) }, randomNode));
        assert.equal(samples.length, 162860);

        // Act & Assert
        const hits = { removed: 0, stoppedAtNbsp: 0, nbspKept: 0 };
        for (const nodes of samples) {
            const expected = legacyTrimInline(nodes, hits);
            const actual = trimInline(nodes);
            // 只在不一致时拼装诊断信息，免得十余万次调用都付这笔开销
            if (!isDeepStrictEqual(actual, expected)) assert.deepEqual(actual, expected, `nodes=${describeNodes(nodes)}`);
        }
        // 覆盖自证：须有样本的末尾修剪确实删去了字符，也须有样本以 U+00A0 结尾而原样保留、删去空白后止于 U+00A0，
        // 差分才不是只对「无事可做」的输入空转
        t.diagnostic(`样本 ${samples.length} 个；末尾修剪删去字符 ${hits.removed} 个，其中删后止于 U+00A0 ${hits.stoppedAtNbsp} 个；`
            + `以 U+00A0 结尾而原样保留 ${hits.nbspKept} 个`);
        assert.ok(hits.removed > 0, '末尾修剪没有样本删去字符');
        assert.ok(hits.stoppedAtNbsp > 0, '没有样本在删去空白后止于 U+00A0');
        assert.ok(hits.nbspKept > 0, '没有样本以 U+00A0 结尾而原样保留');
    });
});

// ============================================================
// figureLabelNumber：图号段判定线性于串长（耗时上限与逐字等价）
// ============================================================

const { booksToIr, figureLabelNumber } = require('../converters/parsers/xml/patent');

// 耗时用例的输入规模：figure-labels 里「图7」与「a」之间夹 8 万个半角空格，「a」之后接回车与「b」
const FIGURE_LABEL_STRESS_LENGTH = 80000;
// 耗时上限取绝对值，理由同上一节。200 ms 使两侧余量都不小于 5 倍——线性化之前的 /^\s*图\s*(\d+)\s*(.*)$/ 在这一规模上
// 经 booksToIr 实测约 1.9 至 2.2 秒，是上限的 9 倍以上：(\d+) 后的 \s* 与 (.*) 都能取这段空白，. 跨不过回车而 $ 只认串尾，
// 引擎对这段空白的每一种切分都重扫到回车，耗时随段长平方增长；线性化之后经 booksToIr 实测约 1.1 至 1.4 毫秒（每次新起进程），
// 不到上限的百分之一
const FIGURE_LABEL_STRESS_BUDGET_MS = 200;

// 线性化之前的图号段正则，逐字照录，仅作短输入的差分参照：(\d+) 后的 \s* 与 (.*) 在同一段空白上互相回溯，
// 不可用于耗时用例的输入规模
const LEGACY_FIGURE_LABEL_RE = /^\s*图\s*(\d+)\s*(.*)$/;
// 本节另需的不可见字符以码点生成：U+2029（段分隔符）、U+FEFF（零宽不换行空格）、U+000B（垂直制表符）
const FIGURE_LABEL_PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const FIGURE_LABEL_ZERO_WIDTH_NO_BREAK_SPACE = String.fromCharCode(0xFEFF);
const FIGURE_LABEL_VERTICAL_TAB = String.fromCharCode(0x0B);
// 行终止符：正则的 . 不匹配的恰是这四个，它们却都属 \s——旧式的判定正卡在这一出入上
const FIGURE_LABEL_LINE_TERMINATORS = ['\n', '\r', LINE_SEPARATOR, FIGURE_LABEL_PARAGRAPH_SEPARATOR];
// 结构化随机串的空白段从这十个 \s 成员中抽取：六个空白（U+00A0 沿用文件头导入的 NBSP）与四个行终止符
const FIGURE_LABEL_SPACE_TOKENS = [
    ' ', '\t', IDEOGRAPHIC_SPACE, NBSP, FIGURE_LABEL_ZERO_WIDTH_NO_BREAK_SPACE, FIGURE_LABEL_VERTICAL_TAB, ...FIGURE_LABEL_LINE_TERMINATORS,
];
// 差分字母表：上述十个 \s 成员，加「图」、两个数字、西文可见字符与半角、全角冒号，共 16 个记号
const FIGURE_LABEL_DIFF_ALPHABET = [...FIGURE_LABEL_SPACE_TOKENS, '图', '1', '2', 'a', ':', '：'];
// 分支 → 诊断用的说明，声明顺序即报出顺序
const FIGURE_LABEL_BRANCHES = Object.freeze({
    prefixMismatch: '前缀不符',
    matchedWithRest: '匹配且余下部分非空',
    matchedEmptyRest: '匹配且余下部分为空',
    lineTerminatorAfterSpaces: '极大空白之后含行终止符而不匹配（一位数字）',
    longDigitsThenLineTerminator: '长数字段后接行终止符而不匹配（两位以上数字）',
});

// 分支归类：只用旧式的 exec 结果与测试内独立算出的输入特征，不借用 figureLabelNumber 的内部状态。空白一律以 trimStart 剥离——
// 它删去的字符集（WhiteSpace 与 LineTerminator）与 \s 相同，却不经正则。末两个分支同属「前缀相符、极大空白之后的余下部分含行终止符」，
// 按数字段长短分开：一位数字只有其后的空白可供回溯，两位以上的数字段另可逐位回退。前缀相符、旧式不匹配而余下部分不含行终止符，
// 即与等价判据矛盾，返回 null 交调用方报错
function classifyFigureLabelSample(text, legacyMatch) {
    if (legacyMatch) return legacyMatch[2] === '' ? 'matchedEmptyRest' : 'matchedWithRest';
    const afterLead = text.trimStart();
    if (!afterLead.startsWith('图')) return 'prefixMismatch';
    const afterMark = afterLead.slice(1).trimStart();
    let digitCount = 0;
    while (digitCount < afterMark.length && afterMark[digitCount] >= '0' && afterMark[digitCount] <= '9') digitCount += 1;
    if (digitCount === 0) return 'prefixMismatch';
    const rest = afterMark.slice(digitCount).trimStart();
    if (!FIGURE_LABEL_LINE_TERMINATORS.some((terminator) => rest.includes(terminator))) return null;
    return digitCount >= 2 ? 'longDigitsThenLineTerminator' : 'lineTerminatorAfterSpaces';
}

describe('figureLabelNumber：图号段判定线性于串长', () => {
    test('figure-labels 在「图7」与回车之间夹 8 万个半角空格不触发回溯：booksToIr 单次调用在绝对上限内，输出逐字正确，后一幅图仍接续为图 2', async (t) => {
        // Arrange：在计时区间外新构造 DOM 树与导入上下文。第一幅图的 figure-labels 在极大空白之后含回车，旧式判为不是图号段，
        // 图号取上一幅加一即 1；第二幅不带任何属性，图号接续为 2——若新实现误从第一幅取出 7，第二幅会变成图 8。
        // 两幅图都没有 img，导入不读图，importer 只需备好 importImage
        const element = (name, attrs = {}, children = []) => ({ type: 'element', name, attrs, children });
        const labels = `图7${' '.repeat(FIGURE_LABEL_STRESS_LENGTH)}a\rb`;
        const documentRoot = element('cn-application-body', {}, [
            element('cn-drawings', {}, [element('figure', { 'figure-labels': labels }), element('figure')]),
        ]);
        const ctx = { images: { importImage: async () => null }, report: createReport(), paragraphNumbers: false };

        // Act：计时区间只包这一次调用
        const started = process.hrtime.bigint();
        const result = await booksToIr([{ name: '100002.xml', dir: '.', root: documentRoot }], ctx);
        const elapsedMs = elapsedMsSince(started);
        t.diagnostic(`booksToIr 实测 ${elapsedMs.toFixed(1)} ms`);

        // Assert：先验输出正确，以免「快」来自少做了事——第一幅的 figure-labels 经空白归一后是图号段，原样写进缺图占位；
        // 第二幅没有图号段，占位里是接续的图号
        const section = { index: 1, header: '说明书附图' };
        assert.deepStrictEqual(result, {
            children: [
                { type: 'heading', depth: 1, children: [{ type: 'text', value: '说明书附图' }], data: { role: 'section-title', section } },
                { type: 'paragraph', children: [{ type: 'text', value: '［缺图：图7 a b］' }], data: { section } },
                { type: 'paragraph', children: [{ type: 'text', value: '［缺图：图2］' }], data: { section } },
            ],
            inventionTitle: '',
            summary: { drawings: { figures: 2 } },
        });
        assert.ok(
            elapsedMs < FIGURE_LABEL_STRESS_BUDGET_MS,
            `booksToIr 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${FIGURE_LABEL_STRESS_BUDGET_MS} ms`,
        );
    });

    test('与线性化之前的正则逐字等价：BMP 逐码元扫描、穷举短串与种子固定的随机串，五个分支均有样本', (t) => {
        // Arrange：BMP 逐码元扫描，每个码元放进三个位置——「图1」之后与余下部分之中（行终止符集合的出入）；「图」的前后
        // （前缀里 \s 的出入）；「图1」之后紧接换行（跳过极大空白所用字符集的出入：该码元属 \s 则连同换行一并跳过而匹配，
        // 否则余下部分含换行而不匹配）
        const samples = [];
        for (let code = 0; code <= 0xFFFF; code += 1) {
            const c = String.fromCharCode(code);
            samples.push(`图1${c}a${c}b`, `${c}图${c}1`, `图1${c}\n`);
        }
        assert.equal(samples.length, 196608);

        // 穷举短串：字母表上 0 到 3 个记号的全部组合共 4369 个，各以原样、接在「图1」之后、接在「图12」之后三种形态放入
        for (const tail of everyStringUpTo(3, FIGURE_LABEL_DIFF_ALPHABET)) samples.push(tail, `图1${tail}`, `图12${tail}`);
        assert.equal(samples.length, 209715);

        // 种子固定的随机串各 40000 个：一般随机串为字母表上 0 到 10 个记号；结构化随机串贴近真实的图号段，依次为空白 0 到 2 个、
        // 「图」、空白 0 到 2 个、1 到 4 位数字、空白 0 到 3 个、字母表上 0 到 6 个记号
        const random = createSeededRandom(20260923);
        const pick = (items) => items[Math.floor(random() * items.length)];
        const randomTokens = (alphabet, maxCount) => Array.from({ length: Math.floor(random() * (maxCount + 1)) }, () => pick(alphabet)).join('');
        const randomSpaces = (maxCount) => randomTokens(FIGURE_LABEL_SPACE_TOKENS, maxCount);
        const randomDigits = () => Array.from({ length: 1 + Math.floor(random() * 4) }, () => String(Math.floor(random() * 10))).join('');
        for (let i = 0; i < 40000; i += 1) samples.push(randomTokens(FIGURE_LABEL_DIFF_ALPHABET, 10));
        for (let i = 0; i < 40000; i += 1) {
            samples.push(`${randomSpaces(2)}图${randomSpaces(2)}${randomDigits()}${randomSpaces(3)}${randomTokens(FIGURE_LABEL_DIFF_ALPHABET, 6)}`);
        }
        assert.equal(samples.length, 289715);

        // Act & Assert：逐个比较第 1 组，旧式不匹配时对应 null
        const counts = Object.fromEntries(Object.keys(FIGURE_LABEL_BRANCHES).map((branch) => [branch, 0]));
        for (const text of samples) {
            const legacyMatch = LEGACY_FIGURE_LABEL_RE.exec(text);
            const expected = legacyMatch ? legacyMatch[1] : null;
            const actual = figureLabelNumber(text);
            // 只在不一致时拼装诊断信息，免得近 29 万次调用都付这笔开销
            if (actual !== expected) assert.equal(actual, expected, `text=${toCodePoints(text)}`);
            const branch = classifyFigureLabelSample(text, legacyMatch);
            if (branch === null) assert.fail(`前缀相符、旧式不匹配，极大空白之后却不含行终止符：text=${toCodePoints(text)}`);
            counts[branch] += 1;
        }
        // 覆盖自证：五个分支都须有样本，差分才不是只对某一类输入空转
        t.diagnostic(`样本 ${samples.length} 个；`
            + Object.entries(FIGURE_LABEL_BRANCHES).map(([branch, label]) => `${label} ${counts[branch]} 个`).join('；'));
        for (const [branch, label] of Object.entries(FIGURE_LABEL_BRANCHES)) assert.ok(counts[branch] > 0, `没有样本落入「${label}」分支`);
    });
});

// ============================================================
// joinLineBreaks：换行归一线性于串长（耗时上限与逐字等价）
// ============================================================

const { joinLineBreaks } = require('../converters/parsers/xml/inline');

// 耗时用例的输入规模：a 与 b 之间夹 8 万个空格（或空格与制表符交替），这一长段之后是可见字符而非换行
const LINE_BREAK_STRESS_LENGTH = 80000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。200 ms 使两侧余量都不小于 5 倍——
// 自换行起匹配之前的 /[ \t]*\r?\n[ \t\r\n]*/g 在这一规模上两种形态实测约 2.6 至 3.0 秒（耗时随段长平方增长），
// 是上限的 13 倍以上；自换行起匹配之后单次调用实测至多约 0.2 毫秒（每次新起进程的冷调用，本文件内至多约 0.03 毫秒），
// 约为上限的千分之一
const LINE_BREAK_STRESS_BUDGET_MS = 200;

// 自换行起匹配之前的实现，仅作短输入的差分参照：旧正则的前导 [ \t]* 在不以换行结尾的长空格制表符段上逐位回溯，
// 不可用于耗时用例的输入规模。旧正则、替换回调、edgeJoin 与按码点构造的 CJK_RE 照录旧文件，只在回调里记下本样本
// 命中的分支，供差分用例自证没有空转
const LEGACY_LINE_BREAK_RE = /[ \t]*\r?\n[ \t\r\n]*/g;
const LEGACY_CJK_RANGES = Object.freeze([[0x2E80, 0x2FFF], [0x3000, 0x303F], [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xF900, 0xFAFF], [0xFF00, 0xFFEF]]);
const LEGACY_CJK_RE = new RegExp(`[${LEGACY_CJK_RANGES.map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('')}]`);
const legacyEdgeJoin = (neighbor) => (!neighbor || LEGACY_CJK_RE.test(neighbor) ? '' : ' ');

function legacyJoinLineBreaks(value, hits) {
    const branches = new Set();
    let segments = 0;
    const result = String(value == null ? '' : value).replace(LEGACY_LINE_BREAK_RE, (match, offset, whole) => {
        const before = whole[offset - 1] || '';
        const after = whole[offset + match.length] || '';
        segments += 1;
        noteLineBreakBranches(branches, match, before, after);
        if (!before || !after) return legacyEdgeJoin(before || after);
        return LEGACY_CJK_RE.test(before) || LEGACY_CJK_RE.test(after) ? '' : ' ';
    });
    if (segments >= 2) branches.add('multiSegment');
    // 替换所得只会是空串或一个空格，结果里的回车只能来自段外；段外的回车之后必不是换行，否则旧正则会在此或更早处起一段
    if (result.includes('\r')) branches.add('loneCrKept');
    for (const key of branches) hits[key] += 1;
    return result;
}

// 差分用例须有样本命中的分支：键为计数名，值为未命中时的说明。计数以样本为单位，同一样本内多段命中同一分支只计一次。
// 「回看不越过上一段的结束位置」不设计数：尾部字符集含空格与制表符，上一段结束位置上的字符不可能是空格或制表符（除非已到
// 串尾），回看总是先止于别的字符或串首，该条件只起防御作用、无从命中
const LINE_BREAK_HIT_LABELS = Object.freeze({
    lookback: '段起点早于换行（向前回看并入空格或制表符）',
    noLookback: '段起点即换行（无回看）',
    crlf: '换行为 CRLF',
    loneCrKept: '不跟 LF 的孤立 CR 在段外原样保留',
    loneCrInTail: '不跟 LF 的孤立 CR 被段尾吞入',
    loneCrBefore: '段前紧邻孤立 CR（回看止于此）',
    wideSpaceBefore: '段前紧邻 U+00A0 或 U+3000（回看不越过宽义空白）',
    edgeBothEmpty: '边界段两侧皆空（整串只有排版空白）',
    edgeStartCjk: '串首边界段、后邻汉字或全角标点',
    edgeStartLatin: '串首边界段、后邻西文',
    edgeEndCjk: '串尾边界段、前邻汉字或全角标点',
    edgeEndLatin: '串尾边界段、前邻西文',
    innerCjk: '两侧皆有字符、因汉字或全角标点删除',
    innerLatin: '两侧皆有字符、西文之间换成一个空格',
    multiSegment: '同一串含两段及以上',
});

// 记下一段命中的分支：match 为旧正则的整段匹配，before、after 为其两侧的字符（串首、串尾为空串）
function noteLineBreakBranches(branches, match, before, after) {
    // 前导只有空格与制表符，首个回车或换行即「\r?\n」的起点；该处为回车时其后必是换行
    const breakAt = match.search(/[\r\n]/);
    const isCrlf = match[breakAt] === '\r';
    branches.add(breakAt > 0 ? 'lookback' : 'noLookback');
    if (isCrlf) branches.add('crlf');
    if (/\r(?!\n)/.test(match.slice(breakAt + (isCrlf ? 2 : 1)))) branches.add('loneCrInTail');
    if (before === '\r') branches.add('loneCrBefore');
    if (before === NBSP || before === IDEOGRAPHIC_SPACE) branches.add('wideSpaceBefore');
    if (!before && !after) branches.add('edgeBothEmpty');
    else if (!before) branches.add(LEGACY_CJK_RE.test(after) ? 'edgeStartCjk' : 'edgeStartLatin');
    else if (!after) branches.add(LEGACY_CJK_RE.test(before) ? 'edgeEndCjk' : 'edgeEndLatin');
    else branches.add(LEGACY_CJK_RE.test(before) || LEGACY_CJK_RE.test(after) ? 'innerCjk' : 'innerLatin');
}

describe('joinLineBreaks：换行归一线性于串长', () => {
    // [形态说明, 长段的重复单元]：长段之后是可见字符 b 而非换行，旧式的前导 [ \t]* 正是在这种段上从每个起点吞到段尾、再因缺换行
    // 逐位回退。b 与 c 之间另有「空格制表符 + 换行 + 制表符空格」一段，须向前回看并入、整段换成一个空格，输出才不平凡
    const stressShapes = [
        ['全为空格', ' '],
        ['由空格与制表符交替组成', ' \t'],
    ];

    for (const [label, unit] of stressShapes) {
        test(`8 万字长段${label}且不以换行结尾时不触发回溯：单次调用在绝对上限内，输出逐字正确`, (t) => {
            // Arrange：在计时区间外新构造字符串
            const run = unit.repeat(LINE_BREAK_STRESS_LENGTH / unit.length);
            const value = `a${run}b \t\n\t c`;
            const expected = `a${run}b c`;

            // Act：计时区间只包这一次调用
            const started = process.hrtime.bigint();
            const result = joinLineBreaks(value);
            const elapsedMs = elapsedMsSince(started);
            t.diagnostic(`joinLineBreaks 实测 ${elapsedMs.toFixed(2)} ms`);

            // Assert：先验输出正确，以免「快」来自少做了事——长段原样保留，b 与 c 之间的一段换成一个空格。输出长达 8 万字，
            // 不一致时只报长度与末 4 字的码点
            assert.ok(result === expected,
                `输出不符：长度 ${result.length}（应为 ${expected.length}），末 4 字 [${toCodePoints(result.slice(-4))}]`);
            assert.ok(
                elapsedMs < LINE_BREAK_STRESS_BUDGET_MS,
                `joinLineBreaks 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${LINE_BREAK_STRESS_BUDGET_MS} ms`,
            );
        });
    }

    test('与自换行起匹配之前的实现逐字等价：种子固定的随机短串，回看并入、CRLF、孤立 CR、边界段与多段均有样本', (t) => {
        // Arrange：字母表 9 个字符——旧正则涉及的空格、制表符、回车与换行；ASCII 字母；CJK_RE 之内的汉字与全角标点；
        // 以码点生成的 U+00A0（CJK_RE 之外）与 U+3000（CJK_RE 之内），二者都不在回看的字符集里
        const alphabet = [' ', '\t', '\r', '\n', 'a', '文', '，', NBSP, IDEOGRAPHIC_SPACE];
        // 旧实现把 null 与 undefined 归为空串，各放一个；其后是种子固定的随机串 60000 个，长 0 到 16 个字符
        const random = createSeededRandom(20260923);
        const randomChar = () => alphabet[Math.floor(random() * alphabet.length)];
        const samples = [null, undefined];
        for (let i = 0; i < 60000; i += 1) samples.push(Array.from({ length: Math.floor(random() * 17) }, randomChar).join(''));
        assert.equal(samples.length, 60002);
        const describeValue = (value) => (value == null ? String(value) : toCodePoints(value));

        // Act & Assert
        const hits = Object.fromEntries(Object.keys(LINE_BREAK_HIT_LABELS).map((key) => [key, 0]));
        for (const value of samples) {
            const expected = legacyJoinLineBreaks(value, hits);
            const actual = joinLineBreaks(value);
            // 只在不一致时拼装诊断信息，免得六万次调用都付这笔开销
            if (actual !== expected) {
                assert.equal(actual, expected, `输入 [${describeValue(value)}]；实际 [${toCodePoints(actual)}]；应为 [${toCodePoints(expected)}]`);
            }
        }
        // 覆盖自证：各可达分支须有样本命中，差分才不是只对「无事可做」的输入空转
        t.diagnostic(`样本 ${samples.length} 个；各分支命中样本数 ${Object.entries(hits).map(([key, count]) => `${key}=${count}`).join('，')}`);
        for (const [key, label] of Object.entries(LINE_BREAK_HIT_LABELS)) assert.ok(hits[key] > 0, `没有样本命中：${label}`);
    });
});

// ============================================================
// trimInline：首尾空白节点的剥离线性于节点数（耗时上限与逐项等价）
// ============================================================

// 耗时用例的输入规模：段首、段尾各 6 万个空白节点（换行与只含 [ \t\r\n] 的文本交替），中间夹 3 个须保留的节点。
// 每侧 4 万个时旧写法在新起进程中只要约 1.0 至 1.1 秒、离上限的 5 倍太近，故取 6 万
const BLANK_EDGE_STRESS_COUNT = 60000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。200 ms 使两侧余量都不小于 5 倍——
// 逐个 slice 的旧写法在这一规模上实测约 2.2 至 3.2 秒（复制量随空白节点数平方增长；新起进程中最快），是上限的 10 倍以上；
// 改为一次切片之后单次调用实测至多约 2.2 毫秒（新起进程；本文件内约 1.6 至 1.8 毫秒），约为上限的百分之一
const BLANK_EDGE_STRESS_BUDGET_MS = 200;

// 一次切片之前的实现（本项修改前的 trimInline），仅作短输入的差分参照：首尾每剥去一个空白节点就复制一次整个数组，不可用于
// 耗时用例的输入规模。trimInline 与 trimEdgeSpaceEnd 照录旧文件；其所用的 textNode、EDGE_SPACE_START_RE 与 isBlankEdge 同上文
// 的 legacyTextNode、LEGACY_EDGE_SPACE_START_RE、legacyIsBlankEdge 逐字相同，直接复用。只在两处循环与首末修剪处记下本样本命中的分支
const LEGACY_EDGE_SPACE_CHAR_RE = /[ \t\r\n]/;

function legacyTrimEdgeSpaceEnd(text) {
    let end = text.length;
    while (end > 0 && LEGACY_EDGE_SPACE_CHAR_RE.test(text[end - 1])) end -= 1;
    return text.slice(0, end);
}

function legacyTrimInlineBySlices(nodes, branches) {
    let list = [...nodes];
    while (list.length > 0 && legacyIsBlankEdge(list[0])) {
        branches.add(list[0].type === 'break' ? 'leadingBreak' : 'leadingBlankText');
        list = list.slice(1);
    }
    while (list.length > 0 && legacyIsBlankEdge(list[list.length - 1])) {
        branches.add(list[list.length - 1].type === 'break' ? 'trailingBreak' : 'trailingBlankText');
        list = list.slice(0, -1);
    }
    noteStripOutcome(branches, nodes, list);
    if (list.length === 0) return list;
    const first = list[0];
    if (first.type === 'text') {
        list[0] = legacyTextNode(first.value.replace(LEGACY_EDGE_SPACE_START_RE, ''));
        if (list[0].value !== first.value) branches.add('firstTextTrimmed');
    }
    const last = list[list.length - 1];
    if (last.type === 'text') {
        list[list.length - 1] = legacyTextNode(legacyTrimEdgeSpaceEnd(last.value));
        if (list[list.length - 1].value !== last.value) branches.add('lastTextTrimmed');
    }
    return list;
}

// 剥去首尾空白节点之后、修剪首末文本之前，按保留下来的节点记下分支：nodes 为入参，list 为保留的节点
function noteStripOutcome(branches, nodes, list) {
    if (list.length === 0) {
        if (nodes.length > 0) branches.add('allBlank');
        return;
    }
    if (list.length === nodes.length) branches.add('nothingToStrip');
    const first = list[0];
    const last = list[list.length - 1];
    if (isNbspOnlyText(first)) branches.add('nbspStopsLeading');
    if (isNbspOnlyText(last)) branches.add('nbspStopsTrailing');
    if (first.type !== 'text' && first.type !== 'break') branches.add('otherStopsLeading');
    if (last.type !== 'text' && last.type !== 'break') branches.add('otherStopsTrailing');
    if (list.length === 1 && first.type === 'text') branches.add('singleText');
}

// 只由 [ \t\r\n] 与 U+00A0 组成、且至少含一个 U+00A0 的文本：不是空白节点，若把 U+00A0 也当作空白（trim、\s）就会被误剥
const isNbspOnlyText = (node) => node.type === 'text' && node.value.includes(NBSP)
    && Array.from(node.value).every((ch) => ch === NBSP || LEGACY_EDGE_SPACE_CHAR_RE.test(ch));

// 差分用例须有样本命中的分支：键为计数名，值为未命中时的说明。计数以样本为单位，同一样本内多次命中同一分支只计一次
const STRIP_HIT_LABELS = Object.freeze({
    leadingBreak: '首部剥去换行',
    leadingBlankText: '首部剥去空白文本节点',
    trailingBreak: '尾部剥去换行',
    trailingBlankText: '尾部剥去空白文本节点',
    allBlank: '非空列表全为空白节点、结果为空',
    nothingToStrip: '首尾无可剥离、原样保留',
    firstTextTrimmed: '首个保留节点是文本、被去前导空白',
    lastTextTrimmed: '末个保留节点是文本、被去尾部空白',
    singleText: '首末保留节点为同一文本节点（先去前导、再去尾部）',
    nbspStopsLeading: '首部剥离止于只含空白与 U+00A0 的文本（U+00A0 不算空白）',
    nbspStopsTrailing: '尾部剥离止于只含空白与 U+00A0 的文本（U+00A0 不算空白）',
    otherStopsLeading: '首部剥离止于 strong、image 等非文本非换行节点',
    otherStopsTrailing: '尾部剥离止于 strong、image 等非文本非换行节点',
});

// 差分样本的节点来源：换行；只含 [ \t\r\n] 的文本（0 到 3 个字符，含空串）；TRIM_DIFF_ALPHABET 上的任意文本（0 到 5 个字符）；
// 其它行内节点——OTHER_INLINE_NODE_BUILDERS 之外另加内容只有空白的 emphasis，它不是文本，不能当作空白节点剥去
const BLANK_EDGE_CHARS = [' ', '\t', '\r', '\n'];
const STRIP_OTHER_NODE_BUILDERS = [
    ...OTHER_INLINE_NODE_BUILDERS,
    () => ({ type: 'emphasis', children: [{ type: 'text', value: ' \t' }] }),
];

describe('trimInline：首尾空白节点的剥离线性于节点数', () => {
    test('段首、段尾各 6 万个空白节点（换行与空白文本交替）不触发逐个复制：单次调用在绝对上限内，输出逐项正确', (t) => {
        // Arrange：在计时区间外新构造节点列表——中段依次为首个文本（带前导空白与 U+00A0）、加粗、末个文本（带 U+00A0 与尾部空白）
        const blankText = () => ({ type: 'text', value: TRAILING_EDGE_SPACES });
        const nodes = [
            ...Array.from({ length: BLANK_EDGE_STRESS_COUNT }, (_, i) => (i % 2 === 0 ? { type: 'break' } : blankText())),
            { type: 'text', value: ` \t${NBSP}甲 ` },
            { type: 'strong', children: [{ type: 'text', value: '乙' }] },
            { type: 'text', value: ` 丙${NBSP} \r\n` },
            ...Array.from({ length: BLANK_EDGE_STRESS_COUNT }, (_, i) => (i % 2 === 0 ? blankText() : { type: 'break' })),
        ];

        // Act：计时区间只包这一次调用
        const started = process.hrtime.bigint();
        const result = trimInline(nodes);
        const elapsedMs = elapsedMsSince(started);
        t.diagnostic(`trimInline 实测 ${elapsedMs.toFixed(2)} ms`);

        // Assert：先验输出正确，以免「快」来自少做了事——首尾空白节点全部剥去；首个文本只去前导的半角空白、保留 U+00A0，
        // 末个文本只去尾部的半角空白、保留 U+00A0，中段的加粗原样。先比长度，免得剥离失败时打出八万项的差异
        assert.equal(result.length, 3, `保留节点数 ${result.length}，应为 3`);
        assert.deepEqual(result, [
            { type: 'text', value: `${NBSP}甲 ` },
            { type: 'strong', children: [{ type: 'text', value: '乙' }] },
            { type: 'text', value: ` 丙${NBSP}` },
        ]);
        assert.ok(
            elapsedMs < BLANK_EDGE_STRESS_BUDGET_MS,
            `trimInline 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${BLANK_EDGE_STRESS_BUDGET_MS} ms`,
        );
    });

    test('与一次切片之前的实现逐项等价：种子固定的随机节点列表，首尾各类剥离与挡住剥离的节点均有样本，入参不被改动', (t) => {
        // Arrange：种子固定的随机节点列表 40000 个，各含 0 到 10 个节点；换行约占三成、只含半角空白的文本约占四分之一，
        // 首尾常有成串的空白节点
        const random = createSeededRandom(20260923);
        const pick = (items) => items[Math.floor(random() * items.length)];
        const randomText = (alphabet, maxLength) => Array.from({ length: Math.floor(random() * (maxLength + 1)) }, () => pick(alphabet)).join('');
        const randomNode = () => {
            const roll = random();
            if (roll < 0.3) return { type: 'break' };
            if (roll < 0.55) return { type: 'text', value: randomText(BLANK_EDGE_CHARS, 3) };
            if (roll < 0.85) return { type: 'text', value: randomText(TRIM_DIFF_ALPHABET, 5) };
            return pick(STRIP_OTHER_NODE_BUILDERS)();
        };
        const samples = Array.from({ length: 40000 }, () => Array.from({ length: Math.floor(random() * 11) }, randomNode));
        assert.equal(samples.length, 40000);

        // Act & Assert
        const hits = Object.fromEntries(Object.keys(STRIP_HIT_LABELS).map((key) => [key, 0]));
        for (const nodes of samples) {
            const snapshot = structuredClone(nodes);
            const branches = new Set();
            const expected = legacyTrimInlineBySlices(nodes, branches);
            for (const key of branches) hits[key] += 1;
            const actual = trimInline(nodes);
            // 只在不一致时拼装诊断信息，免得四万次调用都付这笔开销
            if (!isDeepStrictEqual(actual, expected)) assert.deepEqual(actual, expected, `nodes=${describeNodes(nodes)}`);
            // 两式都返回新数组、只在新数组上替换首末元素：不得返回入参本身，入参列表及其中的节点也不得被改动
            if (actual === nodes || !isDeepStrictEqual(nodes, snapshot)) assert.fail(`返回了入参本身或改动了入参：nodes=${describeNodes(snapshot)}`);
        }
        // 覆盖自证：各可达分支须有样本命中，差分才不是只对「无事可做」的输入空转
        t.diagnostic(`样本 ${samples.length} 个；各分支命中样本数 ${Object.entries(hits).map(([key, count]) => `${key}=${count}`).join('，')}`);
        for (const [key, label] of Object.entries(STRIP_HIT_LABELS)) assert.ok(hits[key] > 0, `没有样本命中：${label}`);
    });
});

// ============================================================
// joinLineBreaks：增补平面汉字按汉字判定（确定性用例与占位替换差分）
// ============================================================

// 增补平面的字符一律以码点生成，源码里不出现代理对字面量。扩展 B 取 U+20000 与 U+2A6D6，扩展 G 取 U+30000；对照组取第 1 平面的
// 表情 U+1F600 与西夏文 U+17000，以及孤立的高代理 U+D840 与低代理 U+DC00——二者恰是 U+20000 的前后两半，相连即成该字
const EXT_B_FIRST = String.fromCodePoint(0x20000);
const EXT_B_LATE = String.fromCodePoint(0x2A6D6);
const EXT_G_FIRST = String.fromCodePoint(0x30000);
const EMOJI_GRINNING = String.fromCodePoint(0x1F600);
const TANGUT_FIRST = String.fromCodePoint(0x17000);
const LONE_HIGH_SURROGATE = String.fromCharCode(0xD840);
const LONE_LOW_SURROGATE = String.fromCharCode(0xDC00);

// 逐行比对 [说明, 输入, 应得]，返回不符的行：逐码点列出输入、实际与应得，一次报全所有不符的行
function mismatchedRows(rows, join) {
    return rows.flatMap(([label, input, expected]) => {
        const actual = join(input);
        if (actual === expected) return [];
        return [`${label}：输入 [${toCodePoints(input)}]，实际 [${toCodePoints(actual)}]，应为 [${toCodePoints(expected)}]`];
    });
}

// 本次修改前的实现（增补平面汉字尚不计入），仅作短输入的差分参照：joinLineBreaks、joinOneLineBreak、edgeJoin 与 LINE_BREAK_RE
// 照录修改前的文件，只改名以免与上文冲突；其所用的 CJK_RE 与上文的 LEGACY_CJK_RE 逐字相同（只含 BMP 六个区间、由 fromCharCode
// 拼成的字符类），直接复用。两侧字符按 UTF-16 码元取，增补平面汉字在换行之前取到其低代理、在换行之后取到其高代理
const BMP_ONLY_LINE_BREAK_RE = /\r?\n[ \t\r\n]*/g;

function bmpOnlyJoinLineBreaks(value) {
    const whole = String(value == null ? '' : value);
    const pieces = [];
    let cursor = 0;
    for (const match of whole.matchAll(BMP_ONLY_LINE_BREAK_RE)) {
        let start = match.index;
        while (start > cursor && (whole[start - 1] === ' ' || whole[start - 1] === '\t')) start -= 1;
        pieces.push(whole.slice(cursor, start));
        cursor = match.index + match[0].length;
        pieces.push(bmpOnlyJoinOneLineBreak(whole[start - 1] || '', whole[cursor] || ''));
    }
    pieces.push(whole.slice(cursor));
    return pieces.join('');
}

function bmpOnlyJoinOneLineBreak(before, after) {
    if (!before || !after) return bmpOnlyEdgeJoin(before || after);
    return LEGACY_CJK_RE.test(before) || LEGACY_CJK_RE.test(after) ? '' : ' ';
}

const bmpOnlyEdgeJoin = (neighbor) => (!neighbor || LEGACY_CJK_RE.test(neighbor) ? '' : ' ');

// 占位符：BMP 汉字「汉」（U+6C49），落在修改前的 CJK_RE 之内，且不在差分字母表中——输出里的每个「汉」都来自占位
const SUPPLEMENTARY_PLACEHOLDER = '汉';
const isSupplementaryCjkChar = (char) => char.length === 2 && char.codePointAt(0) >= 0x20000 && char.codePointAt(0) <= 0x3FFFF;

// 占位替换参照：按字符串迭代器切分 value（成对代理合为一项，孤立代理单独一项），把每个增补平面汉字依次换成占位符，交给修改前的
// 实现 joinBmpOnly，再按出现次序把占位符依次换回原字符。修改前的实现只增删空白与换行——含换行的空白段删去或换成一个空格，段外的
// 字符原样拼回——不重排、不改动非空白字符，占位符在输出里的个数与次序都同输入，故依次换回可逆（个数不符即判失败）。占位符是
// BMP 汉字、旧实现按汉字判定它，参照值因而正是「增补平面汉字按汉字判定、其余与修改前相同」
function supplementaryPlaceholderReference(value, joinBmpOnly) {
    const originals = [];
    const masked = Array.from(value, (char) => {
        if (!isSupplementaryCjkChar(char)) return char;
        originals.push(char);
        return SUPPLEMENTARY_PLACEHOLDER;
    }).join('');
    const parts = joinBmpOnly(masked).split(SUPPLEMENTARY_PLACEHOLDER);
    if (parts.length !== originals.length + 1) assert.fail(`占位符个数不符：输入 [${toCodePoints(value)}]`);
    return parts.map((part, index) => (index === 0 ? part : originals[index - 1] + part)).join('');
}

// 含代理码元（无论成对与否）即不是纯 BMP 样本
function hasSurrogate(value) {
    for (let i = 0; i < value.length; i += 1) {
        const unit = value.charCodeAt(i);
        if (unit >= 0xD800 && unit <= 0xDFFF) return true;
    }
    return false;
}

// 各段两侧的完整字符 [前, 后]：段取自 segmentRe 的各次匹配（整段，含向前回看并入的空格制表符）；两侧按字符串迭代器的切分取整个
// 码点，串首、串尾为空串。取法与被测实现相互独立，只供分支统计
function sidesOfSegments(value, segmentRe) {
    const startingAt = new Map();
    const endingAt = new Map();
    let offset = 0;
    for (const char of value) {
        startingAt.set(offset, char);
        offset += char.length;
        endingAt.set(offset, char);
    }
    return Array.from(value.matchAll(segmentRe), (match) => [endingAt.get(match.index) || '', startingAt.get(match.index + match[0].length) || '']);
}

// 段一侧字符的类别：none 为串首串尾；supplementaryCjk 为增补平面汉字；plane1 为其余成对代理（字母表里只有第 1 平面的表情与
// 西夏文）；loneHigh、loneLow 为孤立代理；其余为 bmp
function sideKind(char) {
    if (char === '') return 'none';
    if (char.length === 2) return isSupplementaryCjkChar(char) ? 'supplementaryCjk' : 'plane1';
    const unit = char.charCodeAt(0);
    if (unit >= 0xD800 && unit <= 0xDBFF) return 'loneHigh';
    if (unit >= 0xDC00 && unit <= 0xDFFF) return 'loneLow';
    return 'bmp';
}

// 差分用例须有样本命中的分支：键为计数名，值为未命中时的说明。计数以样本为单位，同一样本内多段命中同一分支只计一次
const SUPPLEMENTARY_LINE_BREAK_HIT_LABELS = Object.freeze({
    supplementaryBefore: '两侧皆有字符、换行前为增补平面汉字',
    supplementaryAfter: '两侧皆有字符、换行后为增补平面汉字',
    supplementaryBoth: '两侧皆为增补平面汉字',
    edgeStartSupplementary: '串首边界段（文本节点边界）、后邻增补平面汉字',
    edgeEndSupplementary: '串尾边界段（文本节点边界）、前邻增补平面汉字',
    plane1Before: '换行前为第 1 平面字符',
    plane1After: '换行后为第 1 平面字符',
    loneHighBefore: '换行前为孤立高代理',
    loneLowBefore: '换行前为孤立低代理（其前一位不是高代理，不合为一个码点）',
    loneHighAfter: '换行后为孤立高代理（其后一位不是低代理，不合为一个码点）',
    loneLowAfter: '换行后为孤立低代理',
    pureBmp: '不含任何代理且含换行段的纯 BMP 样本（与修改前的实现直接比对）',
    changed: '参照值与修改前的实现直接所得不同（行为确有变更）',
});

// 其余类别在换行前、换行后各记一个分支
const SIDE_KIND_BRANCHES = Object.freeze({
    plane1: ['plane1Before', 'plane1After'],
    loneHigh: ['loneHighBefore', 'loneHighAfter'],
    loneLow: ['loneLowBefore', 'loneLowAfter'],
});

// 记下一段命中的分支：before、after 为段两侧的完整字符（串首、串尾为空串）
function noteSupplementaryLineBreakBranches(branches, before, after) {
    const beforeKind = sideKind(before);
    const afterKind = sideKind(after);
    if (beforeKind === 'none' || afterKind === 'none') {
        if (afterKind === 'supplementaryCjk') branches.add('edgeStartSupplementary');
        if (beforeKind === 'supplementaryCjk') branches.add('edgeEndSupplementary');
    } else {
        if (beforeKind === 'supplementaryCjk') branches.add('supplementaryBefore');
        if (afterKind === 'supplementaryCjk') branches.add('supplementaryAfter');
        if (beforeKind === 'supplementaryCjk' && afterKind === 'supplementaryCjk') branches.add('supplementaryBoth');
    }
    if (SIDE_KIND_BRANCHES[beforeKind]) branches.add(SIDE_KIND_BRANCHES[beforeKind][0]);
    if (SIDE_KIND_BRANCHES[afterKind]) branches.add(SIDE_KIND_BRANCHES[afterKind][1]);
}

describe('joinLineBreaks：增补平面汉字按汉字判定', () => {
    test('扩展 B、G 位于换行一侧或两侧时删除换行，落在文本节点边界上时同样删除', () => {
        // Arrange：两侧皆有字符时任一侧是汉字即删除；落在节点边界上时由 edgeJoin 只看另一侧，另一侧是汉字即删除
        const rows = [
            ['两侧皆为扩展 B', `${EXT_B_FIRST}\n${EXT_B_FIRST}`, `${EXT_B_FIRST}${EXT_B_FIRST}`],
            ['扩展 B 接扩展 G', `${EXT_B_LATE}\n${EXT_G_FIRST}`, `${EXT_B_LATE}${EXT_G_FIRST}`],
            ['换行前为西文、后为扩展 B', `abc\n${EXT_B_FIRST}`, `abc${EXT_B_FIRST}`],
            ['换行前为扩展 G、后为西文', `${EXT_G_FIRST}\nabc`, `${EXT_G_FIRST}abc`],
            ['回看并入空格制表符，CRLF 与多行空白', `x \t\r\n\t \n ${EXT_B_LATE}y`, `x${EXT_B_LATE}y`],
            ['同一串两段', `${EXT_B_FIRST}\na\n${EXT_G_FIRST}`, `${EXT_B_FIRST}a${EXT_G_FIRST}`],
            ['扩展 B 之前另有孤立高代理', `${LONE_HIGH_SURROGATE}${EXT_B_FIRST}\na`, `${LONE_HIGH_SURROGATE}${EXT_B_FIRST}a`],
            ['串首边界段、后邻扩展 B', `\n  ${EXT_B_FIRST}a`, `${EXT_B_FIRST}a`],
            ['串尾边界段、前邻扩展 G', `a${EXT_G_FIRST} \t\n`, `a${EXT_G_FIRST}`],
            ['首尾皆为边界段', `\r\n${EXT_B_LATE}\n`, EXT_B_LATE],
        ];

        // Act & Assert
        assert.deepEqual(mismatchedRows(rows, joinLineBreaks), []);
    });

    test('对照组：第 1 平面字符（表情、西夏文）与孤立代理不算汉字，与西文相邻或落在文本节点边界上时照旧换成一个空格', () => {
        // Arrange：孤立代理按单个码元判定；低代理只与紧邻其前的高代理合为一个码点，高代理只与紧随其后的低代理合为一个码点
        const rows = [
            ['两侧皆为表情', `${EMOJI_GRINNING}\n${EMOJI_GRINNING}`, `${EMOJI_GRINNING} ${EMOJI_GRINNING}`],
            ['西文接西夏文', `a\n${TANGUT_FIRST}`, `a ${TANGUT_FIRST}`],
            ['西夏文接西文', `${TANGUT_FIRST}\na`, `${TANGUT_FIRST} a`],
            ['串首边界段、后邻表情', `\n${EMOJI_GRINNING}`, ` ${EMOJI_GRINNING}`],
            ['串尾边界段、前邻西夏文', `${TANGUT_FIRST}\n`, `${TANGUT_FIRST} `],
            ['U+20000 的前后两半被换行隔开、各自孤立', `a${LONE_HIGH_SURROGATE}\n${LONE_LOW_SURROGATE}b`, `a${LONE_HIGH_SURROGATE} ${LONE_LOW_SURROGATE}b`],
            ['孤立低代理之前是扩展 B 的后半（低代理），不合为一个码点', `${EXT_B_FIRST}${LONE_LOW_SURROGATE}\na`, `${EXT_B_FIRST}${LONE_LOW_SURROGATE} a`],
            ['孤立低代理之前是 BMP 汉字，不合为一个码点', `文${LONE_LOW_SURROGATE}\na`, `文${LONE_LOW_SURROGATE} a`],
            ['孤立高代理之后是表情的前半（高代理），不合为一个码点', `a\n${LONE_HIGH_SURROGATE}${EMOJI_GRINNING}`, `a ${LONE_HIGH_SURROGATE}${EMOJI_GRINNING}`],
            ['串首边界段、后邻孤立低代理', `\n${LONE_LOW_SURROGATE}`, ` ${LONE_LOW_SURROGATE}`],
            ['串尾边界段、前邻孤立高代理', `${LONE_HIGH_SURROGATE}\n`, `${LONE_HIGH_SURROGATE} `],
        ];

        // Act & Assert
        assert.deepEqual(mismatchedRows(rows, joinLineBreaks), []);
    });

    test('与占位替换参照逐字相同：BMP 逐码元与修改前直接相等，种子固定的随机串覆盖增补平面汉字、第 1 平面字符、孤立代理与纯 BMP 各分支', (t) => {
        // Arrange：BMP 逐码元 65536 个——每个码元 c 组成「换行 c 换行 a 换行 c 换行」，c 依次紧邻串首边界段之后、换行之前、换行之后与
        // 串尾边界段之前；串里没有成对的代理，结果须与修改前的实现直接相等，汉字判定对任一 BMP 码元多认或少认都会暴露
        const sweep = [];
        for (let code = 0; code <= 0xffff; code += 1) {
            const unit = String.fromCharCode(code);
            sweep.push(`\n${unit}\na\n${unit}\n`);
        }
        // 随机串 60000 个：长 0 到 12 个字元，每个字元以一半概率取自空格、制表符、回车与换行，否则取自其余 12 个——ASCII 字母、
        // BMP 汉字、全角标点、U+00A0、U+3000、扩展 B 两字与扩展 G 一字、表情与西夏文（成对代理整对插入），以及孤立的高代理与低代理
        const random = createSeededRandom(20260923);
        const pick = (items) => items[Math.floor(random() * items.length)];
        const blanks = [' ', '\t', '\r', '\n'];
        const others = [
            'a', '文', '，', NBSP, IDEOGRAPHIC_SPACE, EXT_B_FIRST, EXT_B_LATE, EXT_G_FIRST, EMOJI_GRINNING, TANGUT_FIRST,
            LONE_HIGH_SURROGATE, LONE_LOW_SURROGATE,
        ];
        const randomToken = () => (random() < 0.5 ? pick(blanks) : pick(others));
        const samples = Array.from({ length: 60000 }, () => Array.from({ length: Math.floor(random() * 13) }, randomToken).join(''));
        assert.equal(samples.length, 60000);
        const mismatch = (value, actual, expected) => `输入 [${toCodePoints(value)}]；实际 [${toCodePoints(actual)}]；应为 [${toCodePoints(expected)}]`;

        // Act & Assert：BMP 逐码元直接比对。只在不一致时拼装诊断信息，免得十余万次调用都付这笔开销
        for (const value of sweep) {
            const expected = bmpOnlyJoinLineBreaks(value);
            const actual = joinLineBreaks(value);
            if (actual !== expected) assert.equal(actual, expected, mismatch(value, actual, expected));
        }
        // 随机串：纯 BMP 样本与修改前的实现直接比对，不经占位替换；其余与占位替换参照比对
        const hits = Object.fromEntries(Object.keys(SUPPLEMENTARY_LINE_BREAK_HIT_LABELS).map((key) => [key, 0]));
        for (const value of samples) {
            const bmpOnly = bmpOnlyJoinLineBreaks(value);
            const pureBmp = !hasSurrogate(value);
            const expected = pureBmp ? bmpOnly : supplementaryPlaceholderReference(value, bmpOnlyJoinLineBreaks);
            const actual = joinLineBreaks(value);
            if (actual !== expected) assert.equal(actual, expected, mismatch(value, actual, expected));
            const branches = new Set();
            const sides = sidesOfSegments(value, LEGACY_LINE_BREAK_RE);
            for (const [before, after] of sides) noteSupplementaryLineBreakBranches(branches, before, after);
            if (pureBmp && sides.length > 0) branches.add('pureBmp');
            if (expected !== bmpOnly) branches.add('changed');
            for (const key of branches) hits[key] += 1;
        }
        // 覆盖自证：各分支须有样本命中，差分才不是只对「无事可做」的输入空转
        t.diagnostic(`BMP 逐码元 ${sweep.length} 个；随机串 ${samples.length} 个；各分支命中样本数 `
            + `${Object.entries(hits).map(([key, count]) => `${key}=${count}`).join('，')}`);
        for (const [key, label] of Object.entries(SUPPLEMENTARY_LINE_BREAK_HIT_LABELS)) assert.ok(hits[key] > 0, `没有样本命中：${label}`);
    });
});
