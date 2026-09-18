/**
 * 专利五书反向导入的往返测试：XML → docx（parsers/xml + renderers/docx）→ XML（既有正向链路，即判据）
 * 覆盖：
 *   自产物不动点——合成的官方模板形态 docx → XML₁ → docx → XML₂，五份 XML 与全部图片逐字节相同（zip 与目录两种输入形态）；
 *   官方形态的案卷（合成）→ docx → XML：权项、发明名称、小标题、段落与段号、附图 id/num/figure-labels、img 属性
 *     （含「像素换回的毫米越过整数线」的那一幅）与图片字节逐项复原，产物目录与案卷同形；
 *   单书输入、v3.0.0 平铺形态、人工参照夹具的往返：正文文字不丢；
 *   已知必丢项清单（与 README「XML 反向导入」一节逐条对应）；
 *   段落与段号保真——XML 里「文字 + 段尾大图」的一个 p，转成 Word 再转回仍是一个 p、段号不顺延
 *     （解析层为 Markdown 可读性拆出的块由专利渲染层按同组标记并回）；
 *   convert() 直接受理五书目录，产物名取目录名（目录名里的点不是扩展名）。
 * 公式 / 表格 / 化学式的角色经图片替换文字 markflow:role=… 往返，读取侧在 parsers/docx；读取侧尚未就绪时 maths 会退化为
 * 段内 img，故相关断言按「XML₂ 里有没有 maths」两种情形分别核对，读取侧就绪后自动收紧为严格相等。
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { convert } = require('../converters');
const { parseXml } = require('../converters/xml/dom');
const { LOSS_KINDS } = require('../converters/parsers/xml/report');
const {
    buildOfficialBundle, buildFlatBundle, buildPatentDocx, writeFiles, zipFiles,
    OFFICIAL_EXPECTED, OFFICIAL_IMAGES, FLAT_EXPECTED, DOCX_EXPECTED,
} = require('./fixtures/patent/roundtrip/build-roundtrip-fixtures');

const REFERENCE_DIR = path.join(__dirname, 'fixtures', 'patent', 'reference');
const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'xml-roundtrip-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const BOOK_FILES = ['100001/100001.xml', '100002/100002.xml', '100003/100003.xml', '100004/100004.xml', '100005/100005.xml'];
const PATENT = { xml: { profile: 'patent' } };

let seq = 0;
const makeDir = (label) => {
    seq += 1;
    const dir = path.join(root, `${label}-${seq}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 目录树 → 排序后的 posix 相对路径 */
function treeOf(dir, base = dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? treeOf(full, base) : [path.relative(base, full).split(path.sep).join('/')];
    }).sort();
}

const toDocx = (input, options) => convert({ input: { path: input }, target: 'docx', outputDir: makeDir('docx'), options });
const toXml = (input) => convert({ input: { path: input }, target: 'xml', outputDir: makeDir('xml'), options: PATENT });

// ---------- XML 读取 ----------

function readBook(productDir, relative) {
    const file = path.join(productDir, ...relative.split('/'));
    if (!fs.existsSync(file)) return null;
    const parsed = parseXml(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.ok, true, `${relative}：${parsed.error}`);
    return parsed.root;
}
function findAll(node, name, out = []) {
    for (const child of node.children || []) {
        if (child.type !== 'element') continue;
        if (child.name === name) out.push(child);
        findAll(child, name, out);
    }
    return out;
}
const textOf = (node) => (node.type === 'text' ? node.value : (node.children || []).map(textOf).join(''));
const squeeze = (value) => value.replace(/\s+/g, '');
const textsOf = (rootNode, name) => findAll(rootNode, name).map((node) => squeeze(textOf(node)));

// ============================================================
// 自产物不动点
// ============================================================

describe('自产物不动点：docx → XML₁ → docx → XML₂', () => {
    let first;
    before(async () => {
        const source = path.join(makeDir('source'), '保温杯盖.docx');
        fs.writeFileSync(source, await buildPatentDocx());
        first = await toXml(source);
    });

    const assertSameProduct = (second) => {
        assert.deepEqual(treeOf(second.outputPath), treeOf(first.outputPath), '产物目录的相对路径集合一致');
        for (const relative of treeOf(first.outputPath).filter((name) => /\.(xml|jpg)$/.test(name))) {
            assert.equal(sha(path.join(second.outputPath, ...relative.split('/'))), sha(path.join(first.outputPath, ...relative.split('/'))), `${relative} 逐字节相同`);
        }
        assert.deepEqual(second.warnings.filter((warning) => /^(分节|权项|段号|DTD 校验)：/.test(warning)), []);
    };

    test('XML₁ 本身覆盖了待验证的内容：五书齐全，含行内标记、整段斜体、段内图片与越过毫米整数线的附图', () => {
        assert.deepEqual(treeOf(first.outputPath).filter((name) => name.endsWith('.xml')), BOOK_FILES);
        const description = fs.readFileSync(path.join(first.outputPath, '100002', '100002.xml'), 'utf8');
        for (const fragment of ['<b>一体成型</b>', '<u>难以清洗</u>', '<br />', 'Δ<sub>r</sub>', 'Italic="1"', `<invention-title>${DOCX_EXPECTED.inventionTitle}</invention-title>`, 'file="100002_1.jpg"']) {
            assert.ok(description.includes(fragment), fragment);
        }
        assert.ok(fs.readFileSync(path.join(first.outputPath, '100001', '100001.xml'), 'utf8').includes('100<sup>o</sup>C'));
        const drawings = fs.readFileSync(path.join(first.outputPath, '100003', '100003.xml'), 'utf8');
        assert.ok(drawings.includes('figure-labels="图2 局部放大图"'));
        assert.ok(drawings.includes('wi="40" he="42"'), '42.97 mm 向下取整为 42，而其 508 px 换回毫米是 43.01');
        assert.equal(first.title, DOCX_EXPECTED.inventionTitle);
    });

    test('经案卷 zip 导入再转回：五份 XML 与全部图片逐字节相同', async () => {
        const imported = await toDocx(first.outputs.zip);
        assert.equal(imported.sourceType, 'zip');
        assert.equal(imported.title, DOCX_EXPECTED.inventionTitle);
        assert.ok(imported.warnings.every((warning) => warning.startsWith('导入：')), imported.warnings.join('\n'));
        assertSameProduct(await toXml(imported.outputPath));
    });

    test('经产物目录导入再转回：同样逐字节相同（目录里的 precheck.json 与 zip 不碍事）', async () => {
        const imported = await toDocx(first.outputPath);
        assert.equal(imported.sourceType, 'xml');
        assert.equal(imported.name, path.basename(first.outputPath));
        assertSameProduct(await toXml(imported.outputPath));
    });

    test('开启 xmlImport.paragraphNumbers：段号写进 Word 段首，回转时原样剥离并复用，结果仍逐字节相同', async () => {
        const imported = await toDocx(first.outputs.zip, { xmlImport: { paragraphNumbers: true } });
        assert.equal(imported.options.xmlImport.paragraphNumbers, true);
        assertSameProduct(await toXml(imported.outputPath));
    });
});

// ============================================================
// 官方形态的案卷
// ============================================================

describe('官方形态的案卷 → docx → XML', () => {
    let bundle;
    let bundleDir;
    let product;
    let result;
    before(async () => {
        bundle = await buildOfficialBundle();
        bundleDir = writeFiles(path.join(makeDir('official'), '晾衣架案卷'), bundle.files);
        const zip = path.join(makeDir('official-zip'), '晾衣架案卷.zip');
        fs.writeFileSync(zip, await zipFiles(bundle.files));
        const imported = await toDocx(zip);
        result = await toXml(imported.outputPath);
        product = result.outputPath;
    });

    test('五书全部由页眉认回：没有「分节：」推定告警，标题为发明名称，产物目录与案卷同形', () => {
        assert.deepEqual(result.warnings.filter((warning) => warning.startsWith('分节：')), []);
        assert.equal(result.title, OFFICIAL_EXPECTED.inventionTitle);
        const expectedTree = [...Object.keys(bundle.files), 'precheck.json', '晾衣架案卷.zip'].sort();
        assert.deepEqual(treeOf(product), expectedTree);
    });

    test('权项、发明名称、小标题、段落文字与段号逐项复原', () => {
        const claims = readBook(product, BOOK_FILES[0]);
        assert.deepEqual(findAll(claims, 'claim').map((node) => [node.attrs.id, node.attrs.num]), [['cl001', '1'], ['cl002', '2'], ['cl003', '3']]);
        assert.deepEqual(textsOf(claims, 'claim-text'), OFFICIAL_EXPECTED.claims.flat().map(squeeze));

        const description = readBook(product, BOOK_FILES[1]);
        assert.deepEqual(textsOf(description, 'invention-title'), [OFFICIAL_EXPECTED.inventionTitle]);
        assert.deepEqual(textsOf(description, 'heading'), OFFICIAL_EXPECTED.headings);
        assert.deepEqual(textsOf(description, 'p'), OFFICIAL_EXPECTED.paragraphs.map(squeeze));
        assert.deepEqual(findAll(description, 'p').map((node) => node.attrs.num), ['0001', '0002', '0003', '0004', '0005', '0006', '0007']);
        assert.deepEqual(textsOf(readBook(product, BOOK_FILES[3]), 'p'), [squeeze(OFFICIAL_EXPECTED.abstract)]);
    });

    test('附图的 id / num / figure-labels、img 属性（含越过毫米整数线的那一幅）与图片字节逐项复原', () => {
        const drawings = readBook(product, BOOK_FILES[2]);
        assert.deepEqual(findAll(drawings, 'figure').map((node) => node.attrs),
            [{ id: 'f0001', num: '0001', 'figure-labels': '图1' }, { id: 'f0002', num: '0002', 'figure-labels': '图2' }]);
        assert.deepEqual(findAll(readBook(product, BOOK_FILES[4]), 'figure').map((node) => node.attrs), [{ id: 'f0001', num: '0001' }]);

        for (const [relative, size] of Object.entries(OFFICIAL_IMAGES)) {
            const [code, file] = relative.split('/');
            const source = readBook(bundleDir, `${code}/${code}.xml`);
            const ours = readBook(product, `${code}/${code}.xml`);
            const pick = (rootNode) => findAll(rootNode, 'img').find((node) => node.attrs.file === file).attrs;
            assert.deepEqual(pick(ours), pick(source), `${relative} 的 img 属性`);
            assert.deepEqual([pick(ours).wi, pick(ours).he], [String(size.wi), String(size.he)]);
            assert.equal(sha(path.join(product, code, file)), sha(path.join(bundleDir, code, file)), `${relative} 逐字节相同`);
        }
    });

    test('公式图的角色：读取侧就绪时还原为 maths（id / num 与案卷一致），否则退化为同一段内的 img', () => {
        const description = readBook(product, BOOK_FILES[1]);
        const maths = findAll(description, 'maths');
        const paragraph = findAll(description, 'p')[3];
        assert.equal(findAll(paragraph, 'img').length, 1, '公式图仍在原段落内');
        if (maths.length > 0) assert.deepEqual(maths.map((node) => node.attrs), [{ id: 'math0001', num: '0001' }]);
    });

    test('单书输入：只有一节的 docx 靠保留下来的书目标题段认回书目', async () => {
        for (const [relative, element] of [[BOOK_FILES[3], 'cn-abstract'], [BOOK_FILES[4], 'cn-abst-figure'], [BOOK_FILES[2], 'cn-drawings']]) {
            const imported = await toDocx(path.join(bundleDir, ...relative.split('/')));
            const back = await toXml(imported.outputPath);
            assert.deepEqual(treeOf(back.outputPath).filter((name) => name.endsWith('.xml')), [relative], relative);
            assert.equal(findAll(readBook(back.outputPath, relative), element).length, 1);
            assert.deepEqual(back.warnings.filter((warning) => /按位置推定|无法归类/.test(warning)), []);
        }
    });
});

// ============================================================
// 旧形态与手写形态
// ============================================================

describe('v3.0.0 平铺形态与人工参照夹具的往返', () => {
    test('v3.0.0 平铺形态：文字与图号复原；330 DPI 的旧图按正向链路的规则重采样到 300 DPI', async () => {
        const dir = writeFiles(path.join(makeDir('flat'), '量杯'), (await buildFlatBundle()).files);
        const back = await toXml((await toDocx(dir)).outputPath);

        assert.deepEqual(textsOf(readBook(back.outputPath, BOOK_FILES[0]), 'claim-text'), FLAT_EXPECTED.claims.flat().map(squeeze));
        const description = readBook(back.outputPath, BOOK_FILES[1]);
        assert.deepEqual(textsOf(description, 'invention-title'), [FLAT_EXPECTED.inventionTitle]);
        assert.deepEqual(textsOf(description, 'p'), FLAT_EXPECTED.paragraphs.map(squeeze));
        const [figure] = findAll(readBook(back.outputPath, BOOK_FILES[2]), 'figure');
        assert.deepEqual([figure.attrs.num, figure.attrs['figure-labels']], ['0001', '图1']);
        // 600×360 px @330 DPI = 46.18×27.71 mm → 向下取整 46×27
        const [image] = findAll(figure, 'img');
        assert.deepEqual([image.attrs.wi, image.attrs.he], ['46', '27']);
        assert.deepEqual(back.warnings.filter((warning) => warning.startsWith('分节：')), []);
    });

    test('人工参照夹具：图片全缺，正文文字不丢，缺图占位随文字回到 XML', async () => {
        const back = await toXml((await toDocx(REFERENCE_DIR)).outputPath);

        const claims = readBook(back.outputPath, BOOK_FILES[0]);
        assert.equal(findAll(claims, 'claim').length, 3);
        assert.equal(findAll(claims, 'claim-text').length, 5);
        assert.ok(textsOf(claims, 'claim-text')[3].startsWith('根据权利要求1所述的'));
        const description = readBook(back.outputPath, BOOK_FILES[1]);
        assert.deepEqual(textsOf(description, 'invention-title'), ['横向校对和输出双层PDF的方法和装置']);
        assert.deepEqual(textsOf(description, 'heading'), ['技术领域', '背景技术', '发明内容', '附图说明', '具体实施方式']);
        const paragraphs = findAll(description, 'p');
        assert.equal(paragraphs.length, 12, '11 个编号段 + 1 个临时段（回转时编入顺序段号）');
        assert.equal(paragraphs[11].attrs.num, '0012');
        assert.ok(squeeze(textOf(paragraphs[2])).includes('第i行、第j列'));
        assert.deepEqual(findAll(paragraphs[2], 'sub').map(textOf), ['i']);
        assert.deepEqual(findAll(paragraphs[2], 'sup').map(textOf), ['j']);
        assert.equal(findAll(paragraphs[3], 'br').length, 1);
        assert.equal(paragraphs[9].attrs.Italic, '1');
        assert.ok(textOf(paragraphs[4]).includes('［缺图：omath-5-1.jpg］'));
        assert.equal(findAll(readBook(back.outputPath, BOOK_FILES[3]), 'p').length, 2);
    });
});

// ============================================================
// 转回链路的段落与段号保真
// ============================================================

test('段尾的大幅段内图片：文字与图片都不丢，段落数与段号不变（解析层拆出的块由专利渲染层并回）', async () => {
    const { makeJpeg } = require('./fixtures/patent/roundtrip/build-roundtrip-fixtures');
    const xml = '<?xml version="1.0" encoding="UTF-8"?><cn-application-body lang="zh" country="CN"><description>'
        + '<invention-title>一种测试装置</invention-title><heading level="2">技术领域</heading>'
        + '<p num="0001">按下式计算：<maths id="math0001" num="0001"><img file="f.jpg" wi="60" he="8" img-format="jpg"/></maths></p>'
        + '<p num="0002">后一段。</p></description></cn-application-body>';
    // 709 px @300 DPI = 60 mm，约 227 px @96 DPI，超过大图拆段的 200 px 阈值
    const dir = writeFiles(makeDir('edge-image'), { 'description.xml': Buffer.from(xml), 'f.jpg': await makeJpeg({ width: 709, height: 100 }) });

    const back = await toXml((await toDocx(path.join(dir, 'description.xml'))).outputPath);
    const description = readBook(back.outputPath, BOOK_FILES[1]);

    assert.equal(findAll(description, 'img').length, 1, '图片不丢');
    assert.equal(textsOf(description, 'p').join(''), '按下式计算：后一段。', '文字不丢、顺序不变');
    assert.equal(findAll(description, 'p').length, 2, '一个 Word 段落 = 一个 p：段尾大图不再把段落拆多');
    assert.deepEqual(findAll(description, 'p').map((node) => node.attrs.num), ['0001', '0002'], '段号不顺延');
});

// ============================================================
// 已知必丢项清单
// ============================================================

test('已知必丢项清单：键与文案即契约，README「XML 反向导入」一节逐条对应', () => {
    assert.deepEqual(Object.keys(LOSS_KINDS), [
        'references', 'pageBreak', 'tempParagraph', 'paragraphNumber', 'headingLevel', 'titleMarkup', 'nestedClaimText', 'claimType',
        'claimContinuation', 'codedObject', 'inlineStyle', 'imageAttributes', 'figureAttributes', 'unmapped',
    ]);
    const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    for (const keyword of ['claim-ref', 'figref', 'pb', 'num="XXXX"', 'level', 'invention-title', 'claim-text', 'claim-type', 'smallcaps', 'figure-labels', 'markflow:role']) {
        assert.ok(readme.includes(keyword), `README 未提及 ${keyword}`);
    }
});

// ============================================================
// convert() 直接受理五书目录
// ============================================================

describe('convert()：五书目录作为一项输入', () => {
    test('目录名里的点不是扩展名：产物名与标题回退都取完整目录名', async () => {
        const bundle = await buildOfficialBundle();
        const claimsOnly = { '100001/100001.xml': bundle.files['100001/100001.xml'] };
        const dir = writeFiles(path.join(makeDir('dotted'), '案卷-2026.09.18'), claimsOnly);

        const result = await toDocx(dir);

        assert.equal(result.name, '案卷-2026.09.18');
        assert.equal(result.title, '案卷-2026.09.18');
        assert.equal(path.basename(result.outputPath), '案卷-2026.09.18.docx');
    });

    test('不带五书签名的目录仍按「输入路径不是文件」拒绝', async () => {
        const dir = writeFiles(makeDir('plain-dir'), { 'readme.md': Buffer.from('# 标题\n') });
        await assert.rejects(() => toDocx(dir), /输入路径不是文件/);
    });

    test('bundle 目标不接受专利五书 XML：目标矩阵里 Markdown 知识库包只收 Office、PDF 与网页', async () => {
        const dir = writeFiles(path.join(makeDir('bundle-target'), '案卷'), (await buildOfficialBundle()).files);
        await assert.rejects(() => convert({ input: { path: dir }, target: 'bundle', outputDir: makeDir('out') }), /目标 bundle 不接受 xml 输入/);
    });
});
