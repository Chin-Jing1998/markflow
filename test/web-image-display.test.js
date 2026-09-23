/**
 * converters/web/image-display.js 单元测试
 * 覆盖：displaySizeOf 的属性尺寸识别（matchDimension）在数值之后 8 万个半角空格长段上的耗时上限，
 *       与线性化之前的实现逐字等价（差分）。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const { displaySizeOf, matchDimension } = require('../converters/web/image-display');

// 制表符、换行与回车写作转义序列，其余不可见字符与宽义空白以码点生成，源码里不出现看不见的字面量
const fromCode = (code) => String.fromCharCode(code);
const LINE_TABULATION = fromCode(0x000b);
const NBSP = fromCode(0x00a0);
const BYTE_ORDER_MARK = fromCode(0xfeff);
const IDEOGRAPHIC_SPACE = fromCode(0x3000);
const LINE_SEPARATOR = fromCode(0x2028);
const PARAGRAPH_SEPARATOR = fromCode(0x2029);
// 形似空白而不属 \s 的两个码元：下一行（U+0085）与零宽空格（U+200B），trim 同样不删
const NEXT_LINE = fromCode(0x0085);
const ZERO_WIDTH_SPACE = fromCode(0x200b);

// ============================================================
// displaySizeOf：属性尺寸识别线性于串长（耗时上限与逐字等价）
// ============================================================

// 耗时用例的输入规模：width 属性为数值 5 之后接 8 万个半角空格、以 x 收尾
const DIMENSION_STRESS_LENGTH = 80000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。200 ms 使两侧余量都不小于 5 倍——
// 线性化之前的正则经由 displaySizeOf 在这一规模上实测约 2.2 秒（2 万、4 万时约 0.15、0.55 秒，耗时随段长平方增长），
// 是上限的 10 倍以上；线性化之后单次调用单独计时约 0.2 至 0.3 毫秒，18 个测试进程同时抢占 18 核时至多约 2.3 毫秒，
// 仍不到上限的八十分之一
const DIMENSION_STRESS_BUDGET_MS = 200;

const elapsedMsSince = (started) => Number(process.hrtime.bigint() - started) / 1e6;

// 线性化之前的正则，仅作短输入的差分参照：数值之后并排两个 \s*，其间只隔可空的 (px|%)?，长段空白上平方级回溯，
// 不可用于耗时用例的输入规模。取第 1、2 组的方式照录旧版 parseDimension
const LEGACY_ATTR_DIMENSION_RE = /^\s*(\d{1,5}(?:\.\d+)?)\s*(px|%)?\s*$/i;
const legacyMatchDimension = (raw) => {
    const matched = LEGACY_ATTR_DIMENSION_RE.exec(raw);
    return matched ? [matched[1], matched[2]] : null;
};

// 分支归类的独立判据：数值前缀成立，当且仅当串首的空白之后紧接一个 ASCII 数字——\d{1,5} 至少要一位，小数部分可空
const LEADING_DIGIT_RE = /^\s*\d/;
// 差分覆盖的五个分支：旧式不匹配的两种成因，以及旧式匹配时单位捕获的三种取值
const DIMENSION_BRANCH_LABELS = Object.freeze({
    prefixMismatch: '数值前缀不符',
    noUnit: '匹配且无单位',
    px: '匹配且单位为 px',
    percent: '匹配且单位为 %',
    tailMismatch: '数值之后的余下部分不合尾部',
});

// 按旧式的结果与输入特征把样本归入分支，单位为 px 时另记下所见的大小写写法
function classifyDimensionSample(sample, expected, hits) {
    if (expected === null) {
        if (LEADING_DIGIT_RE.test(sample)) hits.tailMismatch += 1;
        else hits.prefixMismatch += 1;
    } else if (expected[1] === undefined) {
        hits.noUnit += 1;
    } else if (expected[1] === '%') {
        hits.percent += 1;
    } else {
        hits.px += 1;
        hits.pxSpellings.add(expected[1]);
    }
}

// 差分字母表 21 个记号：\s 的十个成员（半角空格、制表符、LF、CR、U+000B、U+00A0、U+FEFF、U+3000、U+2028、U+2029），
// 形似空白而不属 \s 的 U+0085 与 U+200B，数字 0、5、9，小数点，单位用字 p、x、P、X、%
const DIMENSION_DIFF_ALPHABET = [
    ' ', '\t', '\n', '\r', LINE_TABULATION, NBSP, BYTE_ORDER_MARK, IDEOGRAPHIC_SPACE, LINE_SEPARATOR, PARAGRAPH_SEPARATOR,
    NEXT_LINE, ZERO_WIDTH_SPACE, '0', '5', '9', '.', 'p', 'x', 'P', 'X', '%',
];
// 结构化随机串的空白段取 \s 的成员，半角空格加权
const DIMENSION_DIFF_SPACES = [
    ' ', ' ', ' ', '\t', '\n', '\r', LINE_TABULATION, NBSP, BYTE_ORDER_MARK, IDEOGRAPHIC_SPACE, LINE_SEPARATOR, PARAGRAPH_SEPARATOR,
];
const DIMENSION_DIFF_DIGITS = [...'0123456789'];
// 单位片段：合法单位（px 的四种大小写与 %）、缺省，以及残缺、颠倒、重复与不被接受的单位
const DIMENSION_DIFF_UNITS = ['', '', 'px', 'PX', 'Px', 'pX', '%', '%', 'p', 'x', 'X', 'xp', 'p x', 'px%', '%px', '%%', 'pt', 'em'];
// 串尾杂字：多数为空，其余取数字、小数点、单位用字、形似空白的两个码元与汉字
const DIMENSION_DIFF_JUNK = ['', '', '', '', '', '', 'x', '5', '.', '%', 'p', NEXT_LINE, ZERO_WIDTH_SPACE, '文'];
// 手选样本：五个分支各有典型，尾部不合的一组含「5 p x」「5px%」「123456」「1.5.5」
const DIMENSION_HANDPICKED_SAMPLES = [
    '', ' ', 'px', '%', '.5', 'x5',
    '5', ' 5 ', '12345', '1.25', `${IDEOGRAPHIC_SPACE}5${LINE_SEPARATOR}`,
    '5px', '5 PX', `5${NBSP}Px `, '5pX',
    '50%', ' 50 % ',
    '5 p x', '5px%', '123456', '1.5.5', '5.', '5%%', `5${NEXT_LINE}px`, `5${ZERO_WIDTH_SPACE}`,
];

// 两组捕获逐项全等：未参与匹配的 undefined 与空串有别
const sameGroups = (actual, expected) => (Array.isArray(actual) && Array.isArray(expected)
    ? actual.length === expected.length && actual.every((group, index) => group === expected[index])
    : actual === expected);

// 字母表上由 0 到 maxLength 个记号拼成的全部字符串
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

describe('displaySizeOf：属性尺寸识别线性于串长', () => {
    test('width 属性里数值之后接 8 万个半角空格、以 x 收尾时不触发回溯：单次调用在绝对上限内，取值回落到 style 的 50%', (t) => {
        // Arrange：在计时区间外新构造元素与属性值。x 既非单位也非空白，width 属性不成尺寸，取值按优先级回落到 style 的
        // width: 50%；旧式在判定不匹配之前，要把这段空白在数值之后两个 \s* 之间的各种分法逐一试遍
        const $ = cheerio.load('<img src="a.png">');
        const $img = $('img');
        $img.attr('width', `5${' '.repeat(DIMENSION_STRESS_LENGTH)}x`);
        $img.attr('style', 'width: 50%');

        // Act：计时区间只包这一次调用
        const started = process.hrtime.bigint();
        const result = displaySizeOf($img, 'example.com');
        const elapsedMs = elapsedMsSince(started);
        t.diagnostic(`displaySizeOf 实测 ${elapsedMs.toFixed(2)} ms`);

        // Assert：先验输出正确，以免「快」来自少做了事——width 属性被跳过，非微信站点的百分比原样保留
        assert.deepStrictEqual(result, { width: 50, unit: '%', source: 'web' });
        assert.ok(
            elapsedMs < DIMENSION_STRESS_BUDGET_MS,
            `displaySizeOf 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${DIMENSION_STRESS_BUDGET_MS} ms`,
        );
    });

    test('matchDimension 与线性化之前的正则逐字等价：BMP 逐码元、穷举短串与种子固定的随机串，五个分支均有样本，px 的四种大小写俱全', (t) => {
        // Arrange ①：手选样本 25 个
        const samples = [...DIMENSION_HANDPICKED_SAMPLES];
        // ② BMP 逐码元 393216 个：每个码元放进六处——串首、数值与单位之间、串尾三处同放（前缀与尾部两处 \s 的取舍须
        // 一致）、单放串首（前缀里的 \s 与 \d）、数值与 % 之间（trim 从左删的字符集）、单位之后（trim 从右删的字符集）、
        // 单位的第一字与第二字（不区分大小写时折叠为 p、x 的码元）
        for (let code = 0; code <= 0xffff; code += 1) {
            const codeUnit = fromCode(code);
            samples.push(
                `${codeUnit}5${codeUnit}px${codeUnit}`, `${codeUnit}5`, `5${codeUnit}%`, `5px${codeUnit}`, `5${codeUnit}x`, `5p${codeUnit}`,
            );
        }
        // ③ 穷举 204205 个：字母表上由 0 到 4 个记号拼成的全部字符串
        const exhaustive = everyStringUpTo(4, DIMENSION_DIFF_ALPHABET);
        assert.equal(exhaustive.length, 204205);
        for (const text of exhaustive) samples.push(text);

        const random = createSeededRandom(20260923);
        const pick = (items) => items[Math.floor(random() * items.length)];
        const randomTokens = (tokens, count) => Array.from({ length: count }, () => pick(tokens)).join('');
        // ④ 一般随机串 40000 个：字母表上 0 到 12 个记号
        for (let i = 0; i < 40000; i += 1) samples.push(randomTokens(DIMENSION_DIFF_ALPHABET, Math.floor(random() * 13)));
        // ⑤ 结构化随机串 40000 个：若干空白 + 数值 + 空白 + 单位片段 + 空白 + 可选杂字。数值的整数部分 0 至 7 位——0 位使
        // 前缀不成立，6、7 位是超出 \d{1,5} 的畸形；小数 0 至 2 段，每段为小数点加 0 至 3 位数字——两段是多段小数的畸形，
        // 0 位数字是悬空的小数点
        const spaces = () => randomTokens(DIMENSION_DIFF_SPACES, Math.floor(random() * 3));
        const fraction = () => `.${randomTokens(DIMENSION_DIFF_DIGITS, Math.floor(random() * 4))}`;
        const randomNumber = () => randomTokens(DIMENSION_DIFF_DIGITS, pick([0, 1, 1, 2, 2, 3, 3, 4, 5, 6, 7]))
            + Array.from({ length: pick([0, 0, 0, 1, 1, 2]) }, fraction).join('');
        for (let i = 0; i < 40000; i += 1) {
            samples.push(spaces() + randomNumber() + spaces() + pick(DIMENSION_DIFF_UNITS) + spaces() + pick(DIMENSION_DIFF_JUNK));
        }
        assert.equal(samples.length, 677446);

        // Act & Assert
        const hits = { prefixMismatch: 0, noUnit: 0, px: 0, percent: 0, tailMismatch: 0, pxSpellings: new Set() };
        for (const sample of samples) {
            const expected = legacyMatchDimension(sample);
            const actual = matchDimension(sample);
            // 只在不一致时拼装诊断信息，免得六十余万次调用都付这笔开销
            if (!sameGroups(actual, expected)) assert.deepStrictEqual(actual, expected, `输入 [${toCodePoints(sample)}]`);
            classifyDimensionSample(sample, expected, hits);
        }
        // 覆盖自证：五个分支都须有样本，px 的四种大小写写法都须出现，差分才不是对某一分支空转
        const pxSpellings = [...hits.pxSpellings].sort();
        t.diagnostic(`样本 ${samples.length} 个；`
            + `${Object.entries(DIMENSION_BRANCH_LABELS).map(([key, label]) => `${label} ${hits[key]}`).join('，')}；`
            + `px 的写法 ${pxSpellings.join('、')}`);
        for (const [key, label] of Object.entries(DIMENSION_BRANCH_LABELS)) assert.ok(hits[key] > 0, `没有「${label}」的样本`);
        assert.deepStrictEqual(pxSpellings, ['PX', 'Px', 'pX', 'px'], 'px 的四种大小写写法不全');
    });
});
