/**
 * converters/math/omml-to-mathml.js 单元测试
 * 覆盖：各类 OMML 结构 → MathML 关键元素与线性化文本、未知元素降级、
 *       m:sty / m:scr → Unicode 数学字母数字符号、XML 转义、display 标记
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ommlToMathml } = require('../converters/math/omml-to-mathml');

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
const run = (text) => `<m:r><m:t>${text}</m:t></m:r>`;
const oMath = (inner) => `<m:oMath>${inner}</m:oMath>`;

// 只留 <math> 内部，便于断言结构
const inner = (mathml) => mathml.replace(/^<math[^>]*>/, '').replace(/<\/math>$/, '');

test('分式：m:f 的四种 m:type 分别落到 mfrac 与线性分式', () => {
    // Arrange
    const frac = (type) => oMath(`<m:f>${type ? `<m:fPr><m:type m:val="${type}"/></m:fPr>` : ''}<m:num>${run('a')}</m:num><m:den>${run('b')}</m:den></m:f>`);

    // Act
    const bar = ommlToMathml(frac(''));
    const noBar = ommlToMathml(frac('noBar'));
    const skew = ommlToMathml(frac('skw'));
    const linear = ommlToMathml(frac('lin'));

    // Assert
    assert.equal(inner(bar.mathml), '<mfrac><mi>a</mi><mi>b</mi></mfrac>');
    assert.equal(bar.text, '(a)/(b)');
    assert.ok(inner(noBar.mathml).startsWith('<mfrac linethickness="0">'));
    assert.ok(inner(skew.mathml).startsWith('<mfrac bevelled="true">'));
    assert.equal(inner(linear.mathml), '<mrow><mi>a</mi><mo>/</mo><mi>b</mi></mrow>');
    assert.equal(linear.text, 'a/b');
});

test('上下标：sSup / sSub / sSubSup / sPre 分别落到 msup / msub / msubsup / mmultiscripts', () => {
    // Arrange
    const base = `<m:e>${run('x')}</m:e>`;
    const sub = `<m:sub>${run('i')}</m:sub>`;
    const sup = `<m:sup>${run('2')}</m:sup>`;

    // Act
    const superScript = ommlToMathml(oMath(`<m:sSup>${base}${sup}</m:sSup>`));
    const subScript = ommlToMathml(oMath(`<m:sSub>${base}${sub}</m:sSub>`));
    const both = ommlToMathml(oMath(`<m:sSubSup>${base}${sub}${sup}</m:sSubSup>`));
    const pre = ommlToMathml(oMath(`<m:sPre>${base}${sub}${sup}</m:sPre>`));

    // Assert
    assert.equal(inner(superScript.mathml), '<msup><mi>x</mi><mn>2</mn></msup>');
    assert.equal(superScript.text, 'x^{2}');
    assert.equal(inner(subScript.mathml), '<msub><mi>x</mi><mi>i</mi></msub>');
    assert.equal(subScript.text, 'x_{i}');
    assert.ok(inner(both.mathml).startsWith('<msubsup>'));
    assert.equal(both.text, 'x_{i}^{2}');
    assert.ok(inner(pre.mathml).includes('<mprescripts></mprescripts>'));
    assert.equal(pre.text, '_{i}^{2}x');
});

test('根式：无次数或 degHide 取 msqrt，有次数取 mroot', () => {
    // Arrange
    const withDegree = oMath(`<m:rad><m:radPr/><m:deg>${run('3')}</m:deg><m:e>${run('x')}</m:e></m:rad>`);
    const hidden = oMath(`<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${run('x')}</m:e></m:rad>`);

    // Act
    const rooted = ommlToMathml(withDegree);
    const squared = ommlToMathml(hidden);

    // Assert
    assert.equal(inner(rooted.mathml), '<mroot><mi>x</mi><mn>3</mn></mroot>');
    assert.equal(rooted.text, '3√(x)');
    assert.equal(inner(squared.mathml), '<msqrt><mi>x</mi></msqrt>');
    assert.equal(squared.text, '√(x)');
});

test('围栏 m:d：默认圆括号，begChr / endChr / sepChr 可覆盖', () => {
    // Arrange
    const defaults = oMath(`<m:d><m:dPr/><m:e>${run('x')}</m:e></m:d>`);
    const custom = oMath(`<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/><m:sepChr m:val=";"/></m:dPr><m:e>${run('a')}</m:e><m:e>${run('b')}</m:e></m:d>`);

    // Act
    const round = ommlToMathml(defaults);
    const square = ommlToMathml(custom);

    // Assert
    assert.equal(round.text, '(x)');
    assert.ok(inner(round.mathml).includes('<mo fence="true" stretchy="true">(</mo>'));
    assert.equal(square.text, '[a;b]');
    assert.ok(inner(square.mathml).includes('<mo separator="true" stretchy="false">;</mo>'));
});

test('n 元运算 m:nary：limLoc=undOvr 取 munderover，缺省字符为积分号', () => {
    // Arrange
    const sum = oMath(`<m:nary><m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr><m:sub>${run('i=1')}</m:sub><m:sup>${run('n')}</m:sup><m:e>${run('i')}</m:e></m:nary>`);
    const integral = oMath(`<m:nary><m:naryPr><m:limLoc m:val="subSup"/></m:naryPr><m:sub>${run('0')}</m:sub><m:sup>${run('1')}</m:sup><m:e>${run('f')}</m:e></m:nary>`);

    // Act
    const summed = ommlToMathml(sum);
    const integrated = ommlToMathml(integral);

    // Assert
    assert.ok(inner(summed.mathml).includes('<munderover>'));
    assert.equal(summed.text, '∑_{i=1}^{n}i');
    assert.ok(inner(integrated.mathml).includes('<msubsup>'));
    assert.equal(integrated.text, '∫_{0}^{1}f');
});

test('函数 m:func：函数名走 mi，参数加括号', () => {
    // Act
    const result = ommlToMathml(oMath(`<m:func><m:fName>${run('sin')}</m:fName><m:e>${run('x')}</m:e></m:func>`));

    // Assert
    assert.equal(inner(result.mathml), '<mrow><mi>sin</mi><mo>&#x2061;</mo><mi>x</mi></mrow>');
    assert.equal(result.text, 'sin(x)');
});

test('标线与重音：m:bar 按 pos 取 mover/munder，m:acc 缺省重音为 U+0302', () => {
    // Act
    const top = ommlToMathml(oMath(`<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${run('AB')}</m:e></m:bar>`));
    const bottom = ommlToMathml(oMath(`<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr><m:e>${run('AB')}</m:e></m:bar>`));
    const accent = ommlToMathml(oMath(`<m:acc><m:accPr/><m:e>${run('x')}</m:e></m:acc>`));

    // Assert
    assert.ok(inner(top.mathml).startsWith('<mover accent="true">'));
    assert.ok(inner(bottom.mathml).startsWith('<munder accentunder="true">'));
    assert.equal(top.text, 'AB̅');
    assert.equal(bottom.text, 'AB̲');
    assert.equal(accent.text, 'x̂');
});

test('分组符与极限：m:groupChr / m:limLow / m:limUpp 取 munder 或 mover', () => {
    // Act
    const group = ommlToMathml(oMath(`<m:groupChr><m:groupChrPr><m:chr m:val="⏞"/><m:pos m:val="top"/></m:groupChrPr><m:e>${run('a')}</m:e></m:groupChr>`));
    const low = ommlToMathml(oMath(`<m:limLow><m:e>${run('lim')}</m:e><m:lim>${run('n')}</m:lim></m:limLow>`));
    const upp = ommlToMathml(oMath(`<m:limUpp><m:e>${run('lim')}</m:e><m:lim>${run('n')}</m:lim></m:limUpp>`));

    // Assert
    assert.ok(inner(group.mathml).startsWith('<mover>'));
    assert.equal(group.text, '⏞a');
    assert.equal(inner(low.mathml), '<munder><mi>lim</mi><mi>n</mi></munder>');
    assert.equal(low.text, 'lim_{n}');
    assert.equal(inner(upp.mathml), '<mover><mi>lim</mi><mi>n</mi></mover>');
    assert.equal(upp.text, 'lim^{n}');
});

test('矩阵 m:m 与方程组 m:eqArr 取 mtable，线性文本用分号分行', () => {
    // Arrange
    const matrix = oMath(`<m:m><m:mr><m:e>${run('a')}</m:e><m:e>${run('b')}</m:e></m:mr><m:mr><m:e>${run('c')}</m:e><m:e>${run('d')}</m:e></m:mr></m:m>`);
    const eqArr = oMath(`<m:eqArr><m:e>${run('x=1')}</m:e><m:e>${run('y=2')}</m:e></m:eqArr>`);

    // Act
    const table = ommlToMathml(matrix);
    const rows = ommlToMathml(eqArr);

    // Assert
    assert.equal(inner(table.mathml), '<mtable><mtr><mtd><mi>a</mi></mtd><mtd><mi>b</mi></mtd></mtr><mtr><mtd><mi>c</mi></mtd><mtd><mi>d</mi></mtd></mtr></mtable>');
    assert.equal(table.text, '[a, b; c, d]');
    assert.equal(rows.mathml.match(/<mtr>/g).length, 2);
    assert.equal(rows.text, 'x=1; y=2');
});

test('框与幻影：m:box → mrow、m:borderBox → menclose、m:phant → mphantom 且不产出文本', () => {
    // Act
    const box = ommlToMathml(oMath(`<m:box><m:e>${run('E')}</m:e></m:box>`));
    const border = ommlToMathml(oMath(`<m:borderBox><m:e>${run('E')}</m:e></m:borderBox>`));
    const phantom = ommlToMathml(oMath(`<m:phant><m:e>${run('E')}</m:e></m:phant>`));

    // Assert
    assert.equal(inner(box.mathml), '<mrow><mi>E</mi></mrow>');
    assert.equal(inner(border.mathml), '<menclose notation="box"><mi>E</mi></menclose>');
    assert.equal(inner(phantom.mathml), '<mphantom><mi>E</mi></mphantom>');
    assert.equal(phantom.text, '');
});

test('未知元素降级为 mrow 并记入 unsupported（去重）', () => {
    // Act
    const result = ommlToMathml(oMath(`<m:weird>${run('z')}</m:weird><m:weird>${run('y')}</m:weird>`));

    // Assert
    assert.deepEqual(result.unsupported, ['m:weird']);
    assert.equal(inner(result.mathml), '<mrow><mrow><mi>z</mi></mrow><mrow><mi>y</mi></mrow></mrow>');
    assert.equal(result.text, 'zy');
});

test('文本分类：数字串 mn、运算符 mo、其余 mi', () => {
    // Act
    const result = ommlToMathml(oMath(run('12.5+x≥3')));

    // Assert
    assert.equal(inner(result.mathml), '<mrow><mn>12.5</mn><mo>+</mo><mi>x</mi><mo>≥</mo><mn>3</mn></mrow>');
});

test('m:sty="b" 映射到 U+1D400 起的数学粗体，不写 mathvariant', () => {
    // Act
    const result = ommlToMathml(oMath('<m:r><m:rPr><m:sty m:val="b"/></m:rPr><m:t>A1</m:t></m:r>'));

    // Assert
    assert.equal(result.text, '\u{1D400}\u{1D7CF}');
    assert.equal(inner(result.mathml), '<mrow><mi>\u{1D400}</mi><mn>\u{1D7CF}</mn></mrow>');
    assert.ok(!result.mathml.includes('mathvariant="bold"'));
});

test('m:scr 映射到对应字母区，空洞码位回落到 BMP 字母式符号', () => {
    // Act
    const doubleStruck = ommlToMathml(oMath('<m:r><m:rPr><m:scr m:val="double-struck"/><m:sty m:val="p"/></m:rPr><m:t>RA</m:t></m:r>'));
    const fraktur = ommlToMathml(oMath('<m:r><m:rPr><m:scr m:val="fraktur"/><m:sty m:val="p"/></m:rPr><m:t>C</m:t></m:r>'));

    // Assert
    assert.equal(doubleStruck.text, 'ℝ\u{1D538}');
    assert.equal(fraktur.text, 'ℭ');
});

test('m:sty="p" 只对单字符写 mathvariant="normal"，不改码位', () => {
    // Act
    const result = ommlToMathml(oMath('<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>d</m:t></m:r>'));

    // Assert
    assert.equal(result.text, 'd');
    assert.equal(inner(result.mathml), '<mi mathvariant="normal">d</mi>');
});

test('文本转义：& < > 进入 MathML 时被转义，text 保留原字符', () => {
    // Act
    const result = ommlToMathml(oMath(run('a&lt;b &amp; c&gt;d')));

    // Assert
    assert.ok(result.mathml.includes('<mo>&lt;</mo>'));
    assert.ok(result.mathml.includes('<mo>&amp;</mo>'));
    assert.ok(result.mathml.includes('<mo>&gt;</mo>'));
    assert.equal(result.text, 'a<b & c>d');
});

test('display：m:oMathPara 内多个 m:oMath 合并且标为 block，行内公式标为 inline', () => {
    // Act
    const block = ommlToMathml(`<m:oMathPara>${oMath(run('a'))}${oMath(run('=b'))}</m:oMathPara>`);
    const inline = ommlToMathml(oMath(run('a')));
    const forced = ommlToMathml(oMath(run('a')), { display: true });

    // Assert
    assert.ok(block.mathml.startsWith(`<math xmlns="${MATHML_NS}" display="block">`));
    assert.equal(block.text, 'a=b');
    assert.ok(inline.mathml.includes('display="inline"'));
    assert.ok(forced.mathml.includes('display="block"'));
});

test('空输入返回空结果', () => {
    // Act
    const result = ommlToMathml('   ');

    // Assert
    assert.deepEqual(result, { mathml: '', text: '', unsupported: [] });
});
