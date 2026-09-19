/**
 * converters/parsers/docx-math.js 单元测试
 * 覆盖：哨兵替换（document.xml 不再含 m:oMath）、公式数量与 display 标记、
 *       无公式 docx 原样返回、restoreMath 的节点位置与相邻文本、入参不被修改、
 *       源稿字号读取（公式内 w:sz 优先、退到段落 w:pPr、取不到为 null）与写入 data.fontSizePt
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const {
    Document, Packer, Paragraph, TextRun,
    Math: OMath, MathRun, MathFraction, MathSum, MathRadical,
} = require('docx');

const { extractMath, restoreMath } = require('../converters/parsers/docx-math');
const { parse } = require('../converters/parsers/docx');

// ============================================================
// 夹具
// ============================================================

// docx 包只生成行内 m:oMath；块级公式须是 m:oMathPara，故整段只有公式的段落再包一层
const STANDALONE_MATH_RE = /<w:p>(<m:oMath>[\s\S]*?<\/m:oMath>)<\/w:p>/g;

async function wrapDisplayEquations(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('word/document.xml').async('string');
    zip.file('word/document.xml', xml.replace(STANDALONE_MATH_RE, '<w:p><m:oMathPara>$1</m:oMathPara></w:p>'));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function buildDocument(children) {
    return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

// 一行内公式（分式）＋ 一块级公式（∑ 与根式）＋ 两段纯文本
async function buildWithFormulas() {
    const buffer = await buildDocument([
        new Paragraph({
            children: [
                new TextRun('前文 '),
                new OMath({ children: [new MathFraction({ numerator: [new MathRun('a')], denominator: [new MathRun('b')] })] }),
                new TextRun(' 后文。'),
            ],
        }),
        new Paragraph({
            children: [
                new OMath({
                    children: [
                        new MathSum({ children: [new MathRun('i')], subScript: [new MathRun('i=1')], superScript: [new MathRun('n')] }),
                        new MathRadical({ children: [new MathRun('x')] }),
                    ],
                }),
            ],
        }),
        new Paragraph({ children: [new TextRun('尾段')] }),
    ]);
    return wrapDisplayEquations(buffer);
}

/** 合成一个只含 word/document.xml 的包：extractMath 只读写该部件，不必是完整 docx */
function buildPackage(body) {
    const zip = new JSZip();
    zip.file('word/document.xml', `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`);
    return zip.generateAsync({ type: 'nodebuffer' });
}

const mathRun = (props) => `<m:oMath><m:r>${props}<m:t>a</m:t></m:r></m:oMath>`;

async function readDocumentXml(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    return zip.file('word/document.xml').async('string');
}

function collect(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) {
        for (const child of node.children) collect(child, predicate, out);
    }
    return out;
}

// ============================================================
// 用例
// ============================================================

test('extractMath：公式换成哨兵 run，document.xml 不再含 m:oMath', async () => {
    // Arrange
    const source = await buildWithFormulas();

    // Act
    const { buffer, formulas } = await extractMath(source);
    const xml = await readDocumentXml(buffer);

    // Assert
    assert.equal(/<m:oMath[\s/>]/.test(xml), false, '哨兵替换后不应残留 m:oMath');
    assert.equal(/<m:oMathPara[\s/>]/.test(xml), false, '哨兵替换后不应残留 m:oMathPara');
    assert.deepEqual(xml.match(/MFMATH\d+/g), ['MFMATH1', 'MFMATH2']);
    assert.equal(formulas.length, 2);
    assert.deepEqual(formulas.map((f) => f.id), [1, 2]);
    assert.deepEqual(formulas.map((f) => f.display), [false, true]);
    assert.ok(formulas[0].omml.startsWith('<m:oMath>'), '行内公式保留原 OMML');
    assert.ok(formulas[1].omml.startsWith('<m:oMathPara>'), '块级公式保留整个 oMathPara');
    assert.ok(formulas[1].omml.includes('∑'));
});

test('extractMath：无公式的 docx 原样返回入参 buffer', async () => {
    // Arrange
    const source = await buildDocument([new Paragraph({ children: [new TextRun('没有公式')] })]);

    // Act
    const result = await extractMath(source);

    // Assert
    assert.equal(result.buffer, source, '应返回同一个 Buffer 引用，不做重打包');
    assert.deepEqual(result.formulas, []);
});

test('restoreMath：行内哨兵按位置切开文本，块级哨兵独占段落', async () => {
    // Arrange
    const source = await buildWithFormulas();

    // Act
    const doc = await parse({ buffer: source }, { sourceName: '公式.docx' });

    // Assert：行内公式夹在两段文本之间
    const first = doc.ir.children[0];
    assert.deepEqual(first.children.map((n) => n.type), ['text', 'math', 'text']);
    assert.equal(first.children[0].value, '前文 ');
    assert.equal(first.children[2].value, ' 后文。');
    assert.equal(first.children[1].data.display, false);
    assert.equal(first.children[1].data.text, '(a)/(b)');
    assert.ok(first.children[1].data.mathml.includes('<mfrac>'));
    assert.ok(first.children[1].data.omml.includes('<m:f>'));

    // Assert：块级公式独占一段
    const second = doc.ir.children[1];
    assert.equal(second.type, 'paragraph');
    assert.deepEqual(second.children.map((n) => n.type), ['math']);
    assert.equal(second.children[0].data.display, true);
    assert.equal(second.children[0].data.text, '∑_{i=1}^{n}i√(x)');
    assert.ok(second.children[0].data.mathml.includes('display="block"'));

    // Assert：其余正文不受影响
    assert.equal(doc.ir.children[2].children[0].value, '尾段');
    assert.equal(collect(doc.ir, (n) => n.type === 'math').length, 2);
    assert.deepEqual(doc.warnings, []);
});

test('restoreMath：不修改入参，mathml=false 时只回填 omml', () => {
    // Arrange
    const ir = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: '甲MFMATH1乙' }] }] };
    const formulas = [{ id: 1, omml: '<m:oMath><m:r><m:t>a</m:t></m:r></m:oMath>', display: false }];

    // Act
    const withMathml = restoreMath(ir, formulas);
    const withoutMathml = restoreMath(ir, formulas, { mathml: false });

    // Assert
    assert.deepEqual(ir.children[0].children, [{ type: 'text', value: '甲MFMATH1乙' }], '入参应保持原样');
    assert.deepEqual(withMathml.ir.children[0].children.map((n) => n.type), ['text', 'math', 'text']);
    assert.equal(withMathml.ir.children[0].children[0].value, '甲');
    assert.equal(withMathml.ir.children[0].children[2].value, '乙');
    assert.ok(withMathml.ir.children[0].children[1].data.mathml.includes('<mi>a</mi>'));
    assert.equal(withoutMathml.ir.children[0].children[1].data.mathml, null);
    assert.equal(withoutMathml.ir.children[0].children[1].data.omml, formulas[0].omml);
});

test('restoreMath：未知 OMML 元素记入 warnings，公式为空时原样返回', () => {
    // Arrange
    const ir = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'MFMATH1' }] }] };
    const formulas = [{ id: 1, omml: '<m:oMath><m:weird><m:r><m:t>z</m:t></m:r></m:weird></m:oMath>', display: true }];

    // Act
    const restored = restoreMath(ir, formulas);
    const untouched = restoreMath(ir, []);

    // Assert
    assert.equal(restored.warnings.length, 1);
    assert.ok(restored.warnings[0].includes('m:weird'));
    assert.equal(untouched.ir, ir);
    assert.deepEqual(untouched.warnings, []);
});

test('extractMath：字号取自公式内的 w:sz，公式内没有时退到段落 w:pPr，都没有时为 null', async () => {
    // Arrange：① 公式内 28 半磅；② 公式内无 w:sz、段落 w:pPr 为 24 半磅；③ 两处都没有；④ 只有 w:szCs
    const source = await buildPackage(
        `<w:p>${mathRun('<w:rPr><w:sz w:val="28"/><w:szCs w:val="21"/></w:rPr>')}</w:p>`
        + `<w:p><w:pPr><w:rPr><w:sz w:val="24"/></w:rPr></w:pPr>${mathRun('')}</w:p>`
        + `<w:p>${mathRun('')}</w:p>`
        + `<w:p>${mathRun('<w:rPr><w:szCs w:val="30"/></w:rPr>')}</w:p>`,
    );

    // Act
    const { formulas } = await extractMath(source);

    // Assert
    assert.deepEqual(formulas.map((f) => f.fontSizePt), [14, 12, null, null], 'w:szCs 不得被当成 w:sz');
});

test('extractMath：字号取公式内出现最多的 w:sz，并列时取较大者，越界值忽略', async () => {
    // Arrange
    const many = (sizes) => `<w:p><m:oMath>${sizes.map((v) => `<m:r><w:rPr><w:sz w:val="${v}"/></w:rPr><m:t>a</m:t></m:r>`).join('')}</m:oMath></w:p>`;
    const source = await buildPackage(many(['28', '28', '18']) + many(['24', '20']) + many(['0', '99999']));

    // Act
    const { formulas } = await extractMath(source);

    // Assert
    assert.equal(formulas[0].fontSizePt, 14, '出现两次的 28 半磅胜过一次的 18');
    assert.equal(formulas[1].fontSizePt, 12, '各出现一次时取较大的 24 半磅');
    assert.equal(formulas[2].fontSizePt, null, '0 与 99999 半磅均越界');
});

test('extractMath：相邻段落的 w:pPr 不会串到本段公式上', async () => {
    // Arrange：前一段有 w:pPr 且已闭合，公式所在段没有
    const source = await buildPackage(
        '<w:p><w:pPr><w:rPr><w:sz w:val="52"/></w:rPr></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>'
        + `<w:p>${mathRun('')}</w:p>`,
    );

    // Act
    const { formulas } = await extractMath(source);

    // Assert
    assert.equal(formulas[0].fontSizePt, null);
});

test('restoreMath：字号写进 math 节点的 data.fontSizePt，缺省时不写该字段', () => {
    // Arrange
    const ir = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'MFMATH1MFMATH2' }] }] };
    const omml = '<m:oMath><m:r><m:t>a</m:t></m:r></m:oMath>';
    const formulas = [{ id: 1, omml, display: false, fontSizePt: 14 }, { id: 2, omml, display: false, fontSizePt: null }];

    // Act
    const nodes = restoreMath(ir, formulas).ir.children[0].children;
    const withoutMathml = restoreMath(ir, formulas, { mathml: false }).ir.children[0].children;

    // Assert
    assert.equal(nodes[0].data.fontSizePt, 14);
    assert.ok(!('fontSizePt' in nodes[1].data), '取不到字号时不写入该字段，由下游按缺省字号出图');
    assert.equal(withoutMathml[0].data.fontSizePt, 14, 'mathml=false 时同样带上字号');
});
