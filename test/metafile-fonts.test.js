/**
 * converters/metafile/fonts.js 单元测试
 *
 * 覆盖：字体名净化（剔除引号、分号与尖括号）、Windows 字体到 macOS 回退栈的映射、
 * 字体上升部取值，以及 Symbol／Wingdings 系列字体与私用区字符的判定（本批只出诊断项）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_FACE, FALLBACK_ASCENT, SYMBOL_CHARSET,
    sanitizeFontName, fontStack, ascentOf, isSymbolFont, hasPrivateUseChars,
} = require('../converters/metafile/fonts');

test('字体名净化：剔除引号、分号、花括号与尖括号；净化后为空则回落', () => {
    assert.equal(sanitizeFontName('Arial'), 'Arial');
    assert.equal(sanitizeFontName('Ar"ial'), 'Arial');
    assert.equal(sanitizeFontName("A'r;i{a}l<b>"), 'Arialb');
    assert.equal(sanitizeFontName('  Times New Roman  '), 'Times New Roman');
    assert.equal(sanitizeFontName('A\x00B\x1fC'), 'ABC');
    assert.equal(sanitizeFontName(''), DEFAULT_FACE);
    assert.equal(sanitizeFontName(';;;'), DEFAULT_FACE);
    assert.equal(sanitizeFontName(null), DEFAULT_FACE);
    assert.equal(sanitizeFontName(undefined), DEFAULT_FACE);
});

test('字体栈：中文字体给出 macOS 回退，未知字体走通用无衬线栈', () => {
    assert.equal(fontStack('Arial'), "'Arial', Arial, Helvetica, sans-serif");
    assert.equal(fontStack('宋体'), "'宋体', 'Songti SC', STSong, serif");
    assert.equal(fontStack('SimSun'), "'SimSun', 'Songti SC', STSong, serif");
    assert.equal(fontStack('simsun'), "'simsun', 'Songti SC', STSong, serif", '映射不区分大小写');
    assert.equal(fontStack('Microsoft YaHei'), "'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif");
    assert.equal(fontStack('Times New Roman'), "'Times New Roman', Times, serif");
    assert.equal(fontStack('Courier New'), "'Courier New', Courier, monospace");
    assert.equal(fontStack('Cambria Math'), "'Cambria Math', 'STIX Two Math', 'Times New Roman', serif");
    assert.equal(fontStack('某个不存在的字体'), "'某个不存在的字体', Arial, Helvetica, sans-serif");
    // 净化发生在拼栈之前：危险字符无法闭合 font-family 声明
    assert.ok(!fontStack('Evil;} body{x').includes(';}'));
});

test('字体上升部：查表命中取实测值，未列出的取兜底值', () => {
    assert.equal(ascentOf('Arial'), 0.905);
    assert.equal(ascentOf('ARIAL'), 0.905);
    assert.equal(ascentOf('Times New Roman'), 0.891);
    assert.equal(ascentOf('宋体'), 0.859);
    assert.equal(ascentOf('Symbol'), 1.005);
    assert.equal(ascentOf('某个不存在的字体'), FALLBACK_ASCENT);
    assert.equal(ascentOf(''), FALLBACK_ASCENT);
    assert.equal(ascentOf(null), FALLBACK_ASCENT);
});

test('符号字体判定：按 lfCharSet 与字体名前缀两条判据', () => {
    assert.equal(isSymbolFont('Arial', 0), false);
    assert.equal(isSymbolFont('Arial', SYMBOL_CHARSET), true, 'lfCharSet = 2 即符号字符集');
    assert.equal(isSymbolFont('Symbol', 0), true);
    assert.equal(isSymbolFont('Wingdings 2', 0), true);
    assert.equal(isSymbolFont('Webdings', 0), true);
    assert.equal(isSymbolFont('Marlett', 0), true);
    assert.equal(isSymbolFont('Zapf Dingbats', 0), true);
    assert.equal(isSymbolFont('', 0), false);
});

test('私用区字符：U+F000–U+F0FF 被识别出来（Symbol 类字体常用来写 α、β、→）', () => {
    assert.equal(hasPrivateUseChars('abc'), false);
    assert.equal(hasPrivateUseChars('a\uf061b'), true);
    assert.equal(hasPrivateUseChars('\uf0ff'), true);
    assert.equal(hasPrivateUseChars('\uf100'), false);
    assert.equal(hasPrivateUseChars(''), false);
    assert.equal(hasPrivateUseChars(null), false);
});
