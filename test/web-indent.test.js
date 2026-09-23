/**
 * converters/web/indent.js 单元测试
 * 覆盖：indentFromStyleChain 的 text-indent 识别——数值之后的长段空白不触发回溯（耗时上限），
 *       以及改写后的正则与线性化之前的写法逐字等价（差分）
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { indentFromStyleChain } = require('../converters/web/indent');

// 制表符与换行写作转义序列，其余不可见字符以码点生成，源码里不出现看不见的字面量
const NBSP = String.fromCharCode(0xa0);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

// ============================================================
// 线性化之前的实现（差分参照）
// ============================================================

// 仅作短输入的差分参照：数值之后并排三个 \s*，其间只隔两个可空项，长段空白上立方级回溯，不可用于耗时用例的
// 输入规模。正则、常量与两个函数照录旧文件，只把 exec 的结果先存入变量，以便在 hits 上记下命中样本的
// 「单位有无 × !important 有无」组合与未命中的样本数，供差分用例自证覆盖
const LEGACY_TEXT_INDENT_RE = /(?:^|;)\s*text-indent\s*:\s*(-?\d+(?:\.\d+)?)\s*(em|rem|px)?\s*(?:!important)?\s*(?=;|$)/i;
const LEGACY_FONT_SIZE_RE = /(?:^|;)\s*font-size\s*:\s*(\d+(?:\.\d+)?)px/i;
const LEGACY_DEFAULT_FONT_PX = 16;
const LEGACY_ROOT_FONT_PX = 16;
const LEGACY_MIN_INDENT = 1;
const LEGACY_MAX_INDENT = 4;

function legacyIndentFromStyleChain(styles, hits) {
    const list = Array.isArray(styles) ? styles : [];
    const at = list.findIndex((style) => LEGACY_TEXT_INDENT_RE.test(String(style || '')));
    if (at < 0) {
        hits.unmatched += 1;
        return 0;
    }
    const matched = LEGACY_TEXT_INDENT_RE.exec(String(list[at]));
    // 正则里能消耗 ! 的只有 !important 一项，故匹配串含 ! 即说明该项参与了匹配
    hits.combos[(matched[2] === undefined ? 0 : 1) + (matched[0].includes('!') ? 2 : 0)] += 1;
    const [, rawValue, rawUnit] = matched;
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) return 0;
    const unit = String(rawUnit || '').toLowerCase();
    let chars;
    if (unit === 'em') chars = value;
    else if (unit === 'rem') chars = (value * LEGACY_ROOT_FONT_PX) / legacyTextFontSize(list);
    else if (unit === 'px') chars = value / legacyTextFontSize(list);
    else return 0;
    const rounded = Math.round(chars);
    if (rounded < LEGACY_MIN_INDENT) return 0;
    return Math.min(LEGACY_MAX_INDENT, rounded);
}

function legacyTextFontSize(styles) {
    for (const style of styles) {
        const matched = LEGACY_FONT_SIZE_RE.exec(String(style || ''));
        const px = matched ? Number(matched[1]) : 0;
        if (px > 0) return px;
    }
    return LEGACY_DEFAULT_FONT_PX;
}

// 覆盖计数的四种组合，下标为「有单位记 1」与「有 !important 记 2」之和
const COMBO_LABELS = ['无单位、无 !important', '有单位、无 !important', '无单位、有 !important', '有单位、有 !important'];

// ============================================================
// 差分样本的构造
// ============================================================

// 数值之后的尾部记号：两类空白、三种单位（大小写各异）、!important、单独的 !、分号、非法字符 x，
// 以及不成单位的 e
const TAIL_TOKENS = [' ', NBSP, 'em', 'Rem', 'PX', '!important', '!', ';', 'x', 'e'];
// 声明内各处的空白：涵盖 \s 的多类成员，含宽义空白
const WHITESPACE_TOKENS = [' ', ' ', '\t', '\n', NBSP, IDEOGRAPHIC_SPACE, LINE_SEPARATOR, BYTE_ORDER_MARK];
// 属性名：大小写变体，以及相近而不相符的名称
const PROPERTY_NAMES = ['text-indent', 'text-indent', 'text-indent', 'TEXT-INDENT', 'Text-Indent', 'text-indentx', 'textindent'];
// 数值的整数部分：小值使 em 的结果散布于 0 至 4，大值配合下方字号使 px 与 rem 的折算结果同样散布
const INTEGER_PARTS = ['0', '1', '2', '3', '4', '6', '02', '8', '12', '16', '24', '32', '48', '64'];
const FRACTION_PARTS = ['.5', '.25', '.4', '.75', '.0', '.9'];
// 单位：三种合法单位及其大小写变体、缺省，以及不被接受的单位与残缺单位
const UNITS = ['em', 'EM', 'Em', 'rem', 'REM', 'rEm', 'px', 'PX', 'Px', '', '', 'pt', 'e'];
const IMPORTANT_MARKS = ['', '', '', '!important', '!IMPORTANT', '!Important', '!imp'];
// 字号：px 与 rem 的折算依赖最近一处 font-size，取值有意避开单一的 16
const FONT_SIZES = ['4', '8', '12', '14', '16', '20', '24', '32'];
const OTHER_DECLARATIONS = ['color: #333', 'margin: 0 auto', 'line-height: 1.75', 'text-align: justify', 'letter-spacing: 1px'];
// 随机增删的字母表：各类空白、分隔与数值相关的标点、数字，以及拼得出单位与 !important 片段的字母
const MUTATION_ALPHABET = [
    ' ', '\t', '\n', NBSP, IDEOGRAPHIC_SPACE, LINE_SEPARATOR, BYTE_ORDER_MARK,
    ';', ':', '-', '.', '!', 'e', 'r', 'm', 'p', 'x', ...'0123456789',
];
// 随机 style 链的条数：连同穷举的尾部，整例在本机单独运行约 0.5 秒
const RANDOM_CHAIN_COUNT = 100000;

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

// 失败输出里 ASCII 可见字符照录，其余字符写成码点，空白与不可见字符也能看清
const toVisible = (text) => Array.from(text, (ch) => (/[!-~]/.test(ch)
    ? ch
    : `<${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`)).join('');

// 逐个样本比对新旧实现，不一致即断言失败；同时记下旧正则的命中组合、未命中数与返回值分布，供覆盖自证
function compareWithLegacy(samples) {
    const hits = { combos: [0, 0, 0, 0], unmatched: 0 };
    const resultCounts = [0, 0, 0, 0, 0];
    for (const styles of samples) {
        const expected = legacyIndentFromStyleChain(styles, hits);
        const actual = indentFromStyleChain(styles);
        // 只在不一致时拼装诊断信息，免得二十余万次调用都付这笔开销
        if (actual !== expected) {
            assert.equal(actual, expected, `styles=[${styles.map(toVisible).join(' | ')}]`);
        }
        resultCounts[expected] += 1;
    }
    return { hits, resultCounts };
}

const elapsedMsSince = (started) => Number(process.hrtime.bigint() - started) / 1e6;

// ============================================================
// indentFromStyleChain：text-indent 识别线性于串长
// ============================================================

// 耗时用例的输入规模：数值 1 之后接 2000 个空格，再以 x 收尾
const TRAILING_SPACE_LENGTH = 2000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。200 ms 使两侧余量都不小于 5 倍——
// 线性化之前的正则在这一规模上实测 2.4 至 2.8 秒（1000、4000 个空格时约 0.3、22 秒，耗时随段长立方增长），
// 是上限的 10 倍以上；线性化之后单独计时约 0.2 毫秒，40 个测试进程同时抢占 18 核时至多约 3 毫秒，仍不到
// 上限的六十分之一，故慢机以及 node --test 多文件并行时都不会误报
const TRAILING_SPACE_BUDGET_MS = 200;

describe('indentFromStyleChain：text-indent 识别线性于串长', () => {
    test(`数值之后接 ${TRAILING_SPACE_LENGTH} 个空格、以非分号字符收尾时不触发回溯：单次调用在绝对上限内，返回 0`, () => {
        // Arrange：在计时区间外新构造字符串。x 既非分号也非串尾，匹配必然失败；旧式在判定失败之前，
        // 要把这段空白在数值之后三个 \s* 之间的各种分法逐一试遍
        const style = `text-indent:1${' '.repeat(TRAILING_SPACE_LENGTH)}x`;

        // Act：计时区间只包这一次调用
        const started = process.hrtime.bigint();
        const result = indentFromStyleChain([style]);
        const elapsedMs = elapsedMsSince(started);

        // Assert：先验返回值正确，以免「快」来自少做了事——该串不构成合法声明，不命中即返回 0
        assert.equal(result, 0);
        assert.ok(
            elapsedMs < TRAILING_SPACE_BUDGET_MS,
            `indentFromStyleChain 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${TRAILING_SPACE_BUDGET_MS} ms`,
        );
    });

    test('与线性化之前的正则逐字等价：穷举数值之后的尾部，另按声明语法生成并随机增删 style 链，四种「单位 × !important」组合与未命中均有样本', (t) => {
        // Arrange ①：改写只涉及数值之后的一段，故对其记号序列穷举——10 个记号上由 0 到 5 个记号拼成的全部尾部
        // 共 111111 个，长度 5 恰好容纳「空白、单位、空白、!important、空白」三处空白都不空的完整形态。
        // 祖先字号取 4px 时，2em、2rem、2px 与无单位的结果依次为 2、4（钳制）、1、0；首个 style 不命中时落到
        // 更远祖先的 3em，结果为 3。五种情形的结果两两不同，命中与否、单位捕获的任何差异都会反映在返回值上
        const tailSamples = everyStringUpTo(5, TAIL_TOKENS)
            .map((tail) => [`text-indent:2${tail}`, 'font-size:4px', 'text-indent:3em']);
        assert.equal(tailSamples.length, 111111);

        // Arrange ②：按声明语法生成 style 链，每个 style 再随机增删若干字符
        const random = createSeededRandom(20260923);
        const pick = (items) => items[Math.floor(random() * items.length)];
        const randomTokens = (tokens, count) => Array.from({ length: count }, () => pick(tokens)).join('');
        const whitespace = () => randomTokens(WHITESPACE_TOKENS, Math.floor(random() * 3));
        const randomNumber = () => `${random() < 0.1 ? '-' : ''}${pick(INTEGER_PARTS)}${random() < 0.3 ? pick(FRACTION_PARTS) : ''}`;
        const textIndentDeclaration = () => [
            whitespace(), pick(PROPERTY_NAMES), whitespace(), random() < 0.95 ? ':' : '', whitespace(),
            randomNumber(), whitespace(), pick(UNITS), whitespace(), pick(IMPORTANT_MARKS), whitespace(),
        ].join('');
        const fontSizeDeclaration = () => `${whitespace()}font-size:${whitespace()}${pick(FONT_SIZES)}px${whitespace()}`;
        const otherDeclaration = () => `${whitespace()}${pick(OTHER_DECLARATIONS)}${whitespace()}`;
        // textIndentChance 为每条声明取 text-indent 的概率，其余声明在 font-size 与其他属性之间各半
        const randomStyle = (textIndentChance) => {
            const declarations = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
                const roll = random();
                if (roll < textIndentChance) return textIndentDeclaration();
                return roll < (1 + textIndentChance) / 2 ? fontSizeDeclaration() : otherDeclaration();
            });
            const leading = random() < 0.15 ? ';' : '';
            const trailing = random() < 0.4 ? ';' : '';
            return leading + declarations.join(pick([';', ';', '; ', ';;'])) + trailing;
        };
        // 随机增删：0 至 3 次，每次在随机位置插入变异字母表中的一个字符，或删去一个字符
        const mutate = (text) => {
            let out = text;
            const edits = Math.floor(random() * 4);
            for (let i = 0; i < edits; i += 1) {
                if (out.length > 0 && random() < 0.5) {
                    const at = Math.floor(random() * out.length);
                    out = out.slice(0, at) + out.slice(at + 1);
                } else {
                    const at = Math.floor(random() * (out.length + 1));
                    out = out.slice(0, at) + pick(MUTATION_ALPHABET) + out.slice(at);
                }
            }
            return out;
        };
        // 链首是叶子块自身的 style，text-indent 居多；其后 0 至 2 个祖先，font-size 与其他属性居多
        const chainSamples = Array.from({ length: RANDOM_CHAIN_COUNT }, () => {
            const chain = [mutate(randomStyle(0.7))];
            const ancestorCount = Math.floor(random() * 3);
            for (let i = 0; i < ancestorCount; i += 1) chain.push(mutate(randomStyle(0.3)));
            return chain;
        });

        // Act & Assert：逐个样本比对新旧实现
        const tailCoverage = compareWithLegacy(tailSamples);
        const chainCoverage = compareWithLegacy(chainSamples);

        // 覆盖自证：两部分各自都须有四种组合的命中样本，返回值 0 至 4 也都须出现，差分才不是对某一分支空转。
        // 穷举部分的链尾 3em 总能命中，故其「有单位、无 !important」含落到链尾的样本，未命中恒为 0；
        // 未命中的样本由随机部分提供
        for (const [label, count, { hits, resultCounts }] of [
            ['穷举尾部', tailSamples.length, tailCoverage],
            ['随机 style 链', chainSamples.length, chainCoverage],
        ]) {
            t.diagnostic(`${label} ${count} 个：旧正则命中 `
                + `${COMBO_LABELS.map((combo, index) => `${combo} ${hits.combos[index]}`).join('，')}；`
                + `未命中 ${hits.unmatched}；返回值 0 至 4 的样本数依次为 ${resultCounts.join('、')}`);
            COMBO_LABELS.forEach((combo, index) => {
                assert.ok(hits.combos[index] > 0, `${label}中旧正则命中且为「${combo}」的样本数为 0`);
            });
            resultCounts.forEach((resultCount, value) => {
                assert.ok(resultCount > 0, `${label}中返回值为 ${value} 的样本数为 0`);
            });
        }
        assert.ok(chainCoverage.hits.unmatched > 0, '随机 style 链中旧正则未命中的样本数为 0');
    });
});
