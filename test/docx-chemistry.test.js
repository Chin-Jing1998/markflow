/**
 * converters/parsers/docx-chemistry.js 单元测试与化学式判据的端到端回归
 * 覆盖：ProgID 白名单（大小写、版本后缀、Chem3D 的「3」不被误剥、公式与绘图 ProgID 不命中）；
 *       化学区间（OLE 对象、简单域 w:fldSimple、复合域 fldChar/instrText 跨 run 拼接与嵌套、
 *       区间自 separate 之后起算、非化学域无区间、空入参）；EMF 判据（签名命中、非 EMF 不扫、
 *       无签名、截断、非 Buffer、超上限只扫尾部，均不抛错）；角色标记（三种取值、带分号余文、
 *       不匹配时 alt 原样）与判据优先级；合成夹具端到端（角色与 alt 逐图比对、CML 不入 alt、
 *       prepareLayout 的 OOXML 侧角色）；md / html / docx 三个目标对带角色图片的产物与无角色时逐字相同；
 *       版本后缀剥离在「.1」长段上的耗时上限，stripVersionSuffix 与 isChemistryProgId 同线性化之前的实现逐字等价（差分）。
 * 样稿正文与结构式内容一律为虚构示例。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const {
    CHEMISTRY_ROLE, CHEMISTRY_PROG_ID_LIST,
    isChemistryProgId, collectChemistryRanges, inChemistryRange, hasChemistryEmf, resolveImageRole,
} = require('../converters/parsers/docx-chemistry');
const { prepareLayout } = require('../converters/parsers/docx-layout');
const { parse } = require('../converters/parsers/docx');
const mdRenderer = require('../converters/renderers/md');
const htmlRenderer = require('../converters/renderers/html');
const docxRenderer = require('../converters/renderers/docx');
const { normalizeOptions } = require('../converters/options');
const { createDocument, createRoot, createParagraph, createText } = require('../converters/ir/schema');
const {
    buildChemistrySample, CHEMISTRY_EXPECTED, SIPO_CHEM_ALT, EMF_CDX, EMF_PLAIN, EMF_TRUNCATED, PNG,
} = require('./fixtures/build-chemistry-sample');

const EMF_MIME = 'image/x-emf';
// 与 docx-chemistry 的 MAX_EMF_SCAN_BYTES 对齐；超过它的文件只扫尾部
const MAX_EMF_SCAN_BYTES = 8 * 1024 * 1024;
const CDX_SIGNATURE = Buffer.from('CDIF\x00VjCD0100', 'latin1');

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const wrapXml = (body) => `<w:document xmlns:w="${W_NS}" xmlns:o="urn:schemas-microsoft-com:office:office" `
    + `xmlns:v="urn:schemas-microsoft-com:vml" xmlns:r="${W_NS}"><w:body>${body}</w:body></w:document>`;

// 收集 IR 里的全部 image 节点（文档顺序）
function collectImages(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (node.type === 'image') out.push(node);
    (node.children || []).forEach((child) => collectImages(child, out));
    return out;
}

// 返回新树：删掉每个 image 节点的 data.role，其余逐字保留
function withoutRoles(node) {
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'image' && node.data && node.data.role !== undefined) {
        const { role, ...rest } = node.data;
        return { ...node, data: rest };
    }
    if (!Array.isArray(node.children)) return node;
    return { ...node, children: node.children.map(withoutRoles) };
}

// ============================================================
// 判据 a：OLE ProgID 白名单
// ============================================================

describe('isChemistryProgId', () => {
    test('白名单逐项命中，大小写不敏感', () => {
        for (const progId of CHEMISTRY_PROG_ID_LIST) {
            assert.equal(isChemistryProgId(progId), true, progId);
            assert.equal(isChemistryProgId(progId.toUpperCase()), true, progId);
            assert.equal(isChemistryProgId(`  ${progId.toLowerCase()}  `), true, progId);
        }
        assert.equal(CHEMISTRY_PROG_ID_LIST.length, 8);
    });

    test('容忍版本后缀，但不误剥 ProgID 自带的数字', () => {
        assert.equal(isChemistryProgId('ChemDraw.Document.6.0'), true);
        assert.equal(isChemistryProgId('ChemDraw_x64.Document.20'), true);
        assert.equal(isChemistryProgId('Chem3D.Document'), true, 'Chem3D 的 3 不在点号之后，不构成版本后缀');
        assert.equal(isChemistryProgId('Chem3D_x64.Document.1.2.3'), true);
        assert.equal(isChemistryProgId('ChemDraw.Document.beta'), false, '后缀非纯数字时不剥');
    });

    test('公式与绘图 ProgID、空值一律不命中', () => {
        for (const progId of ['Equation.DSMT4', 'Equation.3', 'MathMagic', 'Visio.Drawing', 'MSGraph.Chart', 'ChemDraw', 'Document']) {
            assert.equal(isChemistryProgId(progId), false, progId);
        }
        for (const value of ['', '   ', null, undefined, 0]) assert.equal(isChemistryProgId(value), false, String(value));
    });
});

// ============================================================
// 判据 a 与 c：document.xml 上的化学区间
// ============================================================

describe('collectChemistryRanges', () => {
    const oleXml = (progId) => wrapXml('<w:p><w:r><w:object><v:shape id="s1">'
        + '<v:imagedata r:id="rId5" o:title=""/></v:shape>'
        + `<o:OLEObject Type="Embed" ProgID="${progId}" r:id="rId6"/></w:object></w:r></w:p>`);

    test('OLE 对象：ProgID 命中白名单时整个 w:object 为化学区间，其内的预览图落在区间里', () => {
        const xml = oleXml('ChemDraw.Document.6.0');
        const ranges = collectChemistryRanges(xml);
        assert.equal(ranges.length, 1);
        const at = xml.indexOf('<v:imagedata');
        assert.equal(inChemistryRange(ranges, at), true);
        assert.equal(inChemistryRange(ranges, xml.indexOf('<w:body>')), false, '区间之外不命中');
    });

    test('OLE 对象：ProgID 是公式编辑器时没有区间', () => {
        assert.deepEqual(collectChemistryRanges(oleXml('Equation.DSMT4')), []);
    });

    test('简单域：w:fldSimple 的 w:instr 为 EMBED <化学 ProgID> 时整个元素为区间', () => {
        const xml = wrapXml('<w:p><w:fldSimple w:instr=" EMBED FXChem.Equation \\* MERGEFORMAT ">'
            + '<w:r><w:drawing/></w:r></w:fldSimple></w:p>');
        const ranges = collectChemistryRanges(xml);
        assert.equal(ranges.length, 1);
        assert.equal(inChemistryRange(ranges, xml.indexOf('<w:drawing/>')), true);
    });

    test('简单域：非化学 ProgID 与非 EMBED 指令都不成区间', () => {
        assert.deepEqual(collectChemistryRanges(wrapXml('<w:fldSimple w:instr=" EMBED Equation.3 "><w:r/></w:fldSimple>')), []);
        assert.deepEqual(collectChemistryRanges(wrapXml('<w:fldSimple w:instr=" PAGE "><w:r/></w:fldSimple>')), []);
    });

    const complexXml = (parts) => wrapXml('<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        + parts.map((text) => `<w:r><w:instrText xml:space="preserve">${text}</w:instrText></w:r>`).join('')
        + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        + '<w:r><w:drawing/></w:r>'
        + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>');

    test('复合域：instrText 跨 run 拼接后判定，区间自 separate 之后起算', () => {
        const xml = complexXml([' EMBED ', 'KingDrawObject.Document \\* MERGEFORMAT ']);
        const ranges = collectChemistryRanges(xml);
        assert.equal(ranges.length, 1);
        assert.equal(inChemistryRange(ranges, xml.indexOf('<w:drawing/>')), true, '域结果里的图片命中');
        assert.equal(inChemistryRange(ranges, xml.indexOf('KingDrawObject')), false, '域指令本身不在区间内');
    });

    test('复合域：非化学 ProgID 不成区间', () => {
        assert.deepEqual(collectChemistryRanges(complexXml([' EMBED Equation.DSMT4 '])), []);
    });

    test('复合域：嵌套域按最内层归属，外层非化学时只留内层区间', () => {
        const xml = wrapXml('<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            + '<w:r><w:instrText> IF </w:instrText></w:r>'
            + '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            + '<w:r><w:instrText> EMBED Chem3D.Document </w:instrText></w:r>'
            + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
            + '<w:r><w:drawing/></w:r>'
            + '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
            + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>');
        const ranges = collectChemistryRanges(xml);
        assert.equal(ranges.length, 1);
        assert.equal(inChemistryRange(ranges, xml.indexOf('<w:drawing/>')), true);
    });

    test('空入参与无化学内容的文档一律返回空数组', () => {
        for (const value of ['', null, undefined, wrapXml('<w:p><w:r><w:t>正文</w:t></w:r></w:p>')]) {
            assert.deepEqual(collectChemistryRanges(value), []);
        }
        assert.equal(inChemistryRange([], 0), false);
    });
});

// ============================================================
// 判据 d：EMF 内的 ChemDraw 原生数据
// ============================================================

describe('hasChemistryEmf', () => {
    test('EMF 字节内含 CDIF + CDX 魔数时命中', () => {
        assert.equal(hasChemistryEmf(EMF_CDX, EMF_MIME), true);
        assert.equal(hasChemistryEmf(EMF_CDX, 'image/emf'), true);
        assert.equal(hasChemistryEmf(EMF_CDX, 'image/x-emf; charset=binary'), true, '带参数的 MIME 取分号之前');
    });

    test('只对 EMF 生效：同样的字节挂在别的 MIME 上不扫', () => {
        assert.equal(hasChemistryEmf(EMF_CDX, 'image/png'), false);
        assert.equal(hasChemistryEmf(EMF_CDX, ''), false);
        assert.equal(hasChemistryEmf(EMF_CDX, undefined), false);
    });

    test('无签名、截断与非 Buffer 一律不命中且不抛错', () => {
        assert.equal(hasChemistryEmf(EMF_PLAIN, EMF_MIME), false);
        assert.equal(hasChemistryEmf(EMF_TRUNCATED, EMF_MIME), false);
        assert.equal(hasChemistryEmf(Buffer.alloc(0), EMF_MIME), false);
        assert.equal(hasChemistryEmf(null, EMF_MIME), false);
        assert.equal(hasChemistryEmf('CDIF\x00VjCD0100', EMF_MIME), false, '字符串不是 Buffer');
        assert.equal(hasChemistryEmf(PNG, EMF_MIME), false);
    });

    test('超出扫描上限的文件只扫尾部：签名在末尾命中，在开头不命中，均不抛错', () => {
        const oversized = Buffer.alloc(MAX_EMF_SCAN_BYTES + 4096);
        CDX_SIGNATURE.copy(oversized, 0);
        assert.equal(hasChemistryEmf(oversized, EMF_MIME), false, '超限时不扫文件开头');
        oversized.fill(0, 0, CDX_SIGNATURE.length);
        CDX_SIGNATURE.copy(oversized, oversized.length - CDX_SIGNATURE.length);
        assert.equal(hasChemistryEmf(oversized, EMF_MIME), true);
    });
});

// ============================================================
// 角色标记与判据优先级
// ============================================================

describe('resolveImageRole', () => {
    test('角色标记三种取值均识别，前缀与紧随的一个分号从 alt 剥离', () => {
        assert.deepEqual(resolveImageRole({ alt: 'markflow:role=chemistry' }), { role: 'chemistry', alt: '' });
        assert.deepEqual(resolveImageRole({ alt: 'markflow:role=formula;反应式甲' }), { role: 'formula', alt: '反应式甲' });
        assert.deepEqual(resolveImageRole({ alt: 'markflow:role=table;表 1；含全角分号' }),
            { role: 'table', alt: '表 1；含全角分号' });
        assert.deepEqual(resolveImageRole({ alt: 'markflow:role=chemistry;;余文' }), { role: 'chemistry', alt: ';余文' },
            '只剥一个分号');
    });

    test('角色名后既非分号也非结尾、角色名不在表内、前缀不在开头时一律不匹配，alt 原样', () => {
        for (const alt of ['markflow:role=chemistryX', 'markflow:role=caption;甲', '前置文字 markflow:role=table', 'markflow:role=']) {
            assert.deepEqual(resolveImageRole({ alt }), { role: null, alt });
        }
    });

    test('判据 b：alt 以 <SIPOChemFile 开头时判为化学式并清空 alt', () => {
        assert.deepEqual(resolveImageRole({ alt: SIPO_CHEM_ALT }), { role: CHEMISTRY_ROLE, alt: '' });
        assert.deepEqual(resolveImageRole({ alt: '<SIPOChemFile' }), { role: CHEMISTRY_ROLE, alt: '' });
        const notChem = '<math xmlns="http://www.w3.org/1998/Math/MathML"/>';
        assert.deepEqual(resolveImageRole({ alt: notChem }), { role: null, alt: notChem }, '公式的替换文字不归本判据');
    });

    test('OOXML 侧判据与 EMF 判据命中时保留原 alt', () => {
        assert.deepEqual(resolveImageRole({ alt: '结构式一', ooxmlChemistry: true }), { role: CHEMISTRY_ROLE, alt: '结构式一' });
        assert.deepEqual(resolveImageRole({ alt: '结构式二', buffer: EMF_CDX, mime: EMF_MIME }),
            { role: CHEMISTRY_ROLE, alt: '结构式二' });
    });

    test('显式角色标记优先于化学四条判据', () => {
        assert.deepEqual(
            resolveImageRole({ alt: 'markflow:role=table;表 1', buffer: EMF_CDX, mime: EMF_MIME, ooxmlChemistry: true }),
            { role: 'table', alt: '表 1' },
        );
    });

    test('无入参与全不命中时返回空角色', () => {
        assert.deepEqual(resolveImageRole(), { role: null, alt: '' });
        assert.deepEqual(resolveImageRole({ alt: '普通图', buffer: EMF_PLAIN, mime: EMF_MIME }), { role: null, alt: '普通图' });
    });
});

// ============================================================
// 合成夹具端到端
// ============================================================

describe('化学式判据端到端（合成夹具）', () => {
    test('prepareLayout 按化学区间给 OOXML 侧判据命中的图片序号记角色', async () => {
        const roles = (await prepareLayout(await buildChemistrySample())).roles;
        assert.deepEqual([...roles.entries()].sort((a, b) => a[0] - b[0]), CHEMISTRY_EXPECTED.layoutRoles);
    });

    test('解析后逐图的 data.role 与 alt 与期望一致，CML 不流入任何 alt', async () => {
        const doc = await parse({ buffer: await buildChemistrySample() }, { sourceName: 'chem.docx' });
        const images = collectImages(doc.ir);
        assert.deepEqual(
            images.map((node) => ({ name: node.url, role: (node.data && node.data.role) || null, alt: node.alt || '' })),
            CHEMISTRY_EXPECTED.images.map(({ name, role, alt }) => ({ name, role, alt })),
        );
        const allText = JSON.stringify(doc.ir);
        assert.equal(allText.includes('SIPOChemFile'), false, 'CML 不得留在 IR 里');
        assert.equal(allText.includes('markflow:role=formula'), false, '角色标记前缀已剥离');
        assert.equal(doc.assets.length, CHEMISTRY_EXPECTED.images.length);
    });

    test('截断的 EMF 与被忽略的简单域不抛错，只留 mammoth 的提示', async () => {
        const doc = await parse({ buffer: await buildChemistrySample() }, { sourceName: 'chem.docx' });
        assert.ok(doc.warnings.some((text) => text.includes('w:fldSimple')), doc.warnings.join('\n'));
        assert.equal(doc.warnings.some((text) => text.includes('失败') || text.includes('错误')), false, doc.warnings.join('\n'));
    });
});

// ============================================================
// 其它目标不受角色影响
// ============================================================

describe('md / html 目标不读图片角色，docx 目标只把角色写进替换文字', () => {
    const roledIr = () => createRoot([
        createParagraph([createText('化合物 '), { type: 'image', url: 'images/image_1.png', alt: '结构式', data: { role: 'chemistry' } }, createText(' 的制备。')]),
        createParagraph([{ type: 'image', url: 'images/image_2.png', alt: '公式', data: { role: 'formula' } }]),
        createParagraph([{ type: 'image', url: 'images/image_3.png', alt: '表格', data: { role: 'table' } }]),
    ]);
    const makeDoc = (ir) => createDocument({
        ir,
        meta: { title: '角色对照', sourceType: 'docx' },
        assets: [1, 2, 3].map((n) => ({ name: `images/image_${n}.png`, buffer: PNG, mime: 'image/png' })),
    });
    const options = () => normalizeOptions({});

    const documentXmlOf = async (buffer) => (await JSZip.loadAsync(buffer)).file('word/document.xml').async('string');

    test('md 产物与去掉角色后逐字相同', async () => {
        const withRole = await mdRenderer.render(makeDoc(roledIr()));
        assert.ok(withRole.includes('![结构式](images/image_1.png)'), withRole);
        assert.equal(withRole, await mdRenderer.render(makeDoc(withoutRoles(roledIr()))));
    });

    test('html 产物与去掉角色后逐字相同', async () => {
        const withRole = await htmlRenderer.render(makeDoc(roledIr()), options());
        assert.ok(/<img[^>]*alt="结构式"/.test(withRole), '带角色的图片照常输出为 img');
        assert.equal(withRole, await htmlRenderer.render(makeDoc(withoutRoles(roledIr())), options()));
    });

    // docx 渲染器是角色标记的写入侧（五书 XML 反向导入的往返载体）：角色只进替换文字的前缀，版式与其余内容不变
    test('docx 产物只在替换文字里多出 markflow:role= 前缀，去掉前缀后与无角色的产物逐字相同', async () => {
        const withRole = await documentXmlOf(await docxRenderer.render(makeDoc(roledIr()), options()));
        const without = await documentXmlOf(await docxRenderer.render(makeDoc(withoutRoles(roledIr())), options()));
        for (const marker of ['markflow:role=chemistry;结构式', 'markflow:role=formula;公式', 'markflow:role=table;表格']) {
            assert.ok(withRole.includes(marker), `缺少 ${marker}`);
        }
        assert.equal(without.includes('markflow:role='), false);
        assert.equal(withRole.replace(/markflow:role=(?:formula|table|chemistry);/g, ''), without);
    });
});

// ============================================================
// 判据 a：版本后缀的剥离线性于串长（耗时上限与逐字等价）
// ============================================================

const { stripVersionSuffix } = require('../converters/parsers/docx-chemistry');

// 耗时用例的输入规模：两个 x 之间夹 4 万组「.1」，共 8 万个字符，这一长段不处于串尾
const VERSION_STRESS_LENGTH = 80000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。200 ms 使两侧余量都不小于 5 倍——
// 逐段剥离之前的 /\.\d+(?:\.\d+)*$/ 在这一规模上实测约 3.4 至 3.8 秒（耗时随段长平方增长），是上限的 16 倍以上；
// 逐段剥离之后单次调用实测至多约 0.09 毫秒，不到上限的两千分之一
const VERSION_STRESS_BUDGET_MS = 200;

const elapsedMsSince = (started) => Number(process.hrtime.bigint() - started) / 1e6;

// 不算 \d 的数字，以码点生成：阿拉伯-印度数字一（U+0661）与全角数字一（U+FF11）
const ARABIC_INDIC_ONE = String.fromCharCode(0x0661);
const FULLWIDTH_ONE = String.fromCharCode(0xff11);

// 逐段剥离之前的实现，仅作短输入的差分参照：/\.\d+(?:\.\d+)*$/ 在不处于串尾的「.数字」长段上逐位回溯，不可用于耗时用例的
// 输入规模。正则与 isChemistryProgId 照录旧文件；白名单集合照旧文件的写法由导出的 CHEMISTRY_PROG_ID_LIST 构造
const LEGACY_VERSION_SUFFIX_RE = /\.\d+(?:\.\d+)*$/;
const LEGACY_CHEMISTRY_PROG_IDS = new Set(CHEMISTRY_PROG_ID_LIST.map((id) => id.toLowerCase()));

function legacyIsChemistryProgId(progId) {
    const value = String(progId == null ? '' : progId).trim().toLowerCase();
    if (!value) return false;
    return LEGACY_CHEMISTRY_PROG_IDS.has(value) || LEGACY_CHEMISTRY_PROG_IDS.has(value.replace(LEGACY_VERSION_SUFFIX_RE, ''));
}

// 剥离差分的字母表：点号；ASCII 数字 0、1、9；字母 a、x；不算 \d 的两种数字；连字符与空格
const VERSION_DIFF_ALPHABET = ['.', '0', '1', '9', 'a', 'x', ARABIC_INDIC_ONE, FULLWIDTH_ONE, '-', ' '];

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

// 逐码点列出，失败输出里的不可见字符也能看清；非字符串入参按 String() 显示
const toCodePoints = (text) => (typeof text !== 'string'
    ? String(text)
    : Array.from(text, (ch) => ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' '));

describe('isChemistryProgId：版本后缀的剥离线性于串长', () => {
    test('夹在两个 x 之间的 8 万个字符的「.1」长段不触发回溯：单次调用在绝对上限内，判定逐字正确', () => {
        // Arrange：在计时区间外新构造字符串
        const input = `x${'.1'.repeat(VERSION_STRESS_LENGTH / 2)}x`;

        // Act：计时区间只包这一次调用
        const started = process.hrtime.bigint();
        const result = isChemistryProgId(input);
        const elapsedMs = elapsedMsSince(started);

        // Assert：先验判定正确，以免「快」来自少做了事——长段不处于串尾，不构成版本后缀；
        // 同样长度的真版本后缀则须整段剥去，剥后命中白名单
        assert.equal(result, false);
        assert.equal(isChemistryProgId(`ChemDraw.Document${'.1'.repeat(VERSION_STRESS_LENGTH / 2)}`), true);
        assert.ok(
            elapsedMs < VERSION_STRESS_BUDGET_MS,
            `isChemistryProgId 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${VERSION_STRESS_BUDGET_MS} ms`,
        );
    });

    test('剥离与旧正则逐字等价：穷举短串与种子固定的结构化随机串，须有样本确实剥去后缀', (t) => {
        // Arrange：10 个字符的字母表上长度 0 到 5 的全部字符串共 111111 个
        const samples = everyStringUpTo(5, VERSION_DIFF_ALPHABET);
        assert.equal(samples.length, 111111);

        // 结构化随机串 50000 个：前缀 + 0 到 5 段「点号 + 1 到 3 位数字」+ 尾巴，再随机删去或插入 0 到 2 个字符。
        // 数字偶尔取不算 \d 的两种，使后缀在中途断开；前缀含 chem3d 一类点号之前带数字的写法
        const random = createSeededRandom(20260923);
        const pick = (items) => items[Math.floor(random() * items.length)];
        const prefixes = ['', 'chemdraw.document', 'chem3d.document', 'x', 'a-', '.', '1', ARABIC_INDIC_ONE, ' '];
        const segmentDigits = ['0', '1', '9', '0', '1', '9', '0', '1', '9', ARABIC_INDIC_ONE, FULLWIDTH_ONE];
        const tails = ['', '', '', '', 'x', '.', '..', '.0', 'a1', '-', ' ', ARABIC_INDIC_ONE, FULLWIDTH_ONE];
        const mutate = (text) => {
            const at = Math.floor(random() * (text.length + 1));
            if (random() < 0.5) return text.slice(0, at) + text.slice(at + 1);
            return text.slice(0, at) + pick(VERSION_DIFF_ALPHABET) + text.slice(at);
        };
        for (let i = 0; i < 50000; i += 1) {
            let text = pick(prefixes);
            for (let k = Math.floor(random() * 6); k > 0; k -= 1) {
                text += `.${Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(segmentDigits)).join('')}`;
            }
            text += pick(tails);
            for (let m = Math.floor(random() * 3); m > 0; m -= 1) text = mutate(text);
            samples.push(text);
        }
        assert.equal(samples.length, 161111);

        // Act & Assert
        let stripped = 0;
        for (const value of samples) {
            const expected = value.replace(LEGACY_VERSION_SUFFIX_RE, '');
            const actual = stripVersionSuffix(value);
            // 只在不一致时拼装诊断信息，免得十余万次调用都付这笔开销
            if (actual !== expected) assert.equal(actual, expected, `value=[${toCodePoints(value)}]`);
            if (expected !== value) stripped += 1;
        }
        // 覆盖自证：须有样本确实剥去了后缀，差分才不是只对「无事可做」的输入空转
        t.diagnostic(`样本 ${samples.length} 个；确有剥离的样本 ${stripped} 个`);
        assert.ok(stripped > 0, '没有样本确实剥去后缀');
    });

    test('判定与旧实现逐一相同：白名单与近似 ProgID 随机大小写后接随机后缀，判定为 true 与经剥离才命中的样本均有', (t) => {
        // Arrange：白名单 8 项与 5 个不在白名单内的近似写法，逐字符随机大小写，前后随机补空白（判定前会 trim），再接随机后缀，
        // 共 30000 个：后缀一半由 0 到 6 个随机记号拼成，一半为 0 到 3 段「点号 + 1 到 2 位数字」、其中四成再补一个随机记号。
        // 另加非字符串与空值 7 个
        const random = createSeededRandom(20260924);
        const pick = (items) => items[Math.floor(random() * items.length)];
        const baseIds = [...CHEMISTRY_PROG_ID_LIST, 'ChemDraw', 'Chem3D', 'Equation.3', 'ChemDraw.Documents', 'KingDraw.Document'];
        const suffixTokens = ['.', '.', '6', '0', '1', '20', '.6.0', '..', 'x', 'beta', ' ', '-', ARABIC_INDIC_ONE, FULLWIDTH_ONE];
        const edgeSpaces = ['', '', ' ', '\t', ' \n'];
        const randomCase = (text) => Array.from(text, (ch) => (random() < 0.5 ? ch.toUpperCase() : ch.toLowerCase())).join('');
        const versionSegment = () => `.${Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(['0', '1', '6', '9'])).join('')}`;
        const randomSuffix = () => (random() < 0.5
            ? Array.from({ length: Math.floor(random() * 7) }, () => pick(suffixTokens)).join('')
            : Array.from({ length: Math.floor(random() * 4) }, versionSegment).join('') + (random() < 0.4 ? pick(suffixTokens) : ''));
        const samples = [];
        for (let i = 0; i < 30000; i += 1) samples.push(pick(edgeSpaces) + randomCase(pick(baseIds)) + randomSuffix() + pick(edgeSpaces));
        samples.push(null, undefined, 0, 6, 1.25, '', '   ');
        assert.equal(samples.length, 30007);

        // Act & Assert
        const counts = { hit: 0, hitViaStrip: 0, miss: 0 };
        for (const progId of samples) {
            const expected = legacyIsChemistryProgId(progId);
            const actual = isChemistryProgId(progId);
            if (actual !== expected) assert.equal(actual, expected, `progId=[${toCodePoints(progId)}]`);
            if (!expected) {
                counts.miss += 1;
            } else {
                counts.hit += 1;
                if (!LEGACY_CHEMISTRY_PROG_IDS.has(String(progId).trim().toLowerCase())) counts.hitViaStrip += 1;
            }
        }
        // 覆盖自证：须有样本判定为 true，其中须有样本是剥去版本后缀之后才命中白名单，也须有样本判定为 false
        t.diagnostic(`样本 ${samples.length} 个；判定为 true ${counts.hit} 个（其中剥去版本后缀后才命中 ${counts.hitViaStrip} 个），`
            + `判定为 false ${counts.miss} 个`);
        assert.ok(counts.hit > 0, '没有样本判定为 true');
        assert.ok(counts.hitViaStrip > 0, '没有样本在剥去版本后缀后才命中白名单');
        assert.ok(counts.miss > 0, '没有样本判定为 false');
    });
});
