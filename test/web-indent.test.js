/**
 * converters/web/indent.js 单元测试
 * 覆盖：indentFromStyleChain 的 text-indent 识别——数值之后的长段空白不触发回溯（耗时上限），
 *       以及改写后的正则与线性化之前的写法逐字等价（差分）；
 *       叶子块缩进的逐元素缓存（createIndentResolver）——url 解析器的 markIndents 与 web/extract 的
 *       annotateLayout 在众多叶子块共享一个长空白 style 的祖先时，只匹配该 style 一次（耗时上限），
 *       以及二者与逐叶重扫祖先 style 链的旧实现逐字等价（随机 HTML 差分，cheerio 与 linkedom 两条路径）
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const { parseHTML } = require('linkedom');

const {
    indentFromStyleChain, leadingIndentRun, LEAF_BLOCK_SELECTOR, NESTED_BLOCK_SELECTOR, INDENT_SPACE_CLASS,
} = require('../converters/web/indent');
const { markIndents } = require('../converters/parsers/url');
const { annotateLayout } = require('../converters/web/extract');
const { isAttached } = require('../converters/web/noise');
const { indentMarker } = require('../converters/ir/markers');
const { BUDGET_FACTOR, budgetMs } = require('./helpers/timing-budget');

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

// ============================================================
// 逐叶重扫祖先 style 链的实现（差分参照）
// ============================================================

// 仅作短输入的差分参照：每个叶子块都重建整条祖先 style 链，并对链上各 style 从头匹配，n 个叶子块共享一个长为 L 的
// 祖先 style 时合计 O(n·L)，不可用于耗时用例的输入规模。以下照录缓存之前的 web/indent 的 indentFromStyleChain 与
// textFontSize、url 解析器的 markIndents、styleChainOf、takeLeadingSpaces 与 collectLeadingTexts、web/extract 的
// annotateLayout 与 styleChainOf；已导出且未改动者（isAttached、indentMarker、leadingIndentRun、两个选择器、
// INDENT_SPACE_CLASS）直接引用。改动只有两类：在 hits 上记下各分支的命中数，以及把「缩进 + 段首空白」拆成
// 先后两步求值以便分别计数（求值顺序不变）
const UNCACHED_TEXT_INDENT_RE = /(?:^|;)\s*text-indent\s*:\s*(-?\d+(?:\.\d+)?)\s*(?:(em|rem|px)\s*)?(?:!important\s*)?(?=;|$)/i;
const UNCACHED_FONT_SIZE_RE = /(?:^|;)\s*font-size\s*:\s*(\d+(?:\.\d+)?)px/i;
const UNCACHED_DEFAULT_FONT_PX = 16;
const UNCACHED_ROOT_FONT_PX = 16;
const UNCACHED_MIN_INDENT = 1;
const UNCACHED_MAX_INDENT = 4;
const UNCACHED_INDENT_SPACE_ONLY_RE = new RegExp(`^[${INDENT_SPACE_CLASS}]*$`);
const UNCACHED_VISIBLE_TEXT_RE = /[^\s]/;
const UNCACHED_STYLE_WIDTH_RE = /(?:^|;)\s*width\s*:\s*(\d{1,5}(?:\.\d+)?)\s*(px|%)/i;
// 仅供覆盖计数：同一 style 串里的全部 font-size（px）声明
const EVERY_FONT_SIZE_RE = /(?:^|;)\s*font-size\s*:\s*(\d+(?:\.\d+)?)px/gi;
// 仅供覆盖计数：两种 DOM 上「链是否延续」与「父节点」的取法，与各自的 styleChainOf 同一口径
const CHEERIO_CHAIN = Object.freeze({ isElement: (node) => Boolean(node && node.type === 'tag'), parentOf: (node) => node.parent });
const DOM_CHAIN = Object.freeze({ isElement: (node) => Boolean(node && node.nodeType === 1), parentOf: (node) => node.parentElement });

function uncachedIndentFromStyleChain(styles, hits) {
    const list = Array.isArray(styles) ? styles : [];
    const at = list.findIndex((style) => UNCACHED_TEXT_INDENT_RE.test(String(style || '')));
    if (at < 0) {
        hits.noDeclaration += 1;
        return 0;
    }
    const matched = UNCACHED_TEXT_INDENT_RE.exec(String(list[at]));
    noteDeclaration(matched, at, hits);
    const [, rawValue, rawUnit] = matched;
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) {
        hits.nonPositive += 1;
        return 0;
    }
    const unit = String(rawUnit || '').toLowerCase();
    let chars;
    if (unit === 'em') chars = value;
    else if (unit === 'rem') chars = (value * UNCACHED_ROOT_FONT_PX) / uncachedTextFontSize(list, hits);
    else if (unit === 'px') chars = value / uncachedTextFontSize(list, hits);
    else {
        hits.unitless += 1;
        return 0;
    }
    hits[unit] += 1;
    const rounded = Math.round(chars);
    if (rounded < UNCACHED_MIN_INDENT) {
        hits.belowOne += 1;
        return 0;
    }
    if (rounded > UNCACHED_MAX_INDENT) hits.clamped += 1;
    return Math.min(UNCACHED_MAX_INDENT, rounded);
}

function uncachedTextFontSize(styles, hits) {
    for (const style of styles) {
        const matched = UNCACHED_FONT_SIZE_RE.exec(String(style || ''));
        const px = matched ? Number(matched[1]) : 0;
        if (matched && !(px > 0)) noteZeroFontSize(String(style || ''), hits);
        if (px > 0) {
            hits.fontFromChain += 1;
            return px;
        }
    }
    hits.fontDefault += 1;
    return UNCACHED_DEFAULT_FONT_PX;
}

function uncachedMarkIndents($, hits) {
    const seen = new Set();
    $(LEAF_BLOCK_SELECTOR).each((_, el) => {
        if (!isAttached(el)) return;
        const $el = $(el);
        if ($el.find(NESTED_BLOCK_SELECTOR).length > 0) return;
        if (!UNCACHED_VISIBLE_TEXT_RE.test($el.text())) return;
        noteChainReuse(el, CHEERIO_CHAIN, seen, hits);
        const indent = uncachedIndentFromStyleChain(uncachedCheerioStyleChainOf(el), hits);
        const leading = uncachedTakeLeadingSpaces(el);
        if (leading > 0) hits.leadingSpaces += 1;
        if (indent > 0 && leading > 0) hits.indentAndLeading += 1;
        const count = indent + leading;
        noteResult(count, hits);
        if (count > 0) $el.prepend(indentMarker(count));
    });
}

function uncachedCheerioStyleChainOf(el) {
    const styles = [];
    for (let node = el; node && node.type === 'tag'; node = node.parent) styles.push((node.attribs && node.attribs.style) || '');
    return styles;
}

function uncachedTakeLeadingSpaces(el) {
    const texts = [];
    uncachedCollectLeadingTexts(el, texts);
    const run = leadingIndentRun(texts.map((node) => node.data || '').join(''));
    if (!run) return 0;
    let remaining = run.length;
    for (const node of texts) {
        if (remaining <= 0) break;
        const data = node.data || '';
        const take = Math.min(remaining, data.length);
        node.data = data.slice(take);
        remaining -= take;
    }
    return run.count;
}

function uncachedCollectLeadingTexts(node, out) {
    for (const child of node.children || []) {
        if (child.type === 'text') {
            out.push(child);
            if (!UNCACHED_INDENT_SPACE_ONLY_RE.test(child.data || '')) return true;
            continue;
        }
        if (child.type === 'tag') {
            if (child.name === 'img' || child.name === 'br') return true;
            if (uncachedCollectLeadingTexts(child, out)) return true;
        }
    }
    return false;
}

function uncachedAnnotateLayout(document, hits) {
    const seen = new Set();
    try {
        for (const img of Array.from(document.querySelectorAll('img'))) {
            const matched = UNCACHED_STYLE_WIDTH_RE.exec(img.getAttribute('style') || '');
            if (matched && !img.getAttribute('data-mf-width')) img.setAttribute('data-mf-width', `${matched[1]}${matched[2].toLowerCase()}`);
        }
        for (const el of Array.from(document.querySelectorAll(LEAF_BLOCK_SELECTOR))) {
            if (el.querySelector(NESTED_BLOCK_SELECTOR)) continue;
            if (!/[^\s]/.test(el.textContent || '')) continue;
            noteChainReuse(el, DOM_CHAIN, seen, hits);
            const count = uncachedIndentFromStyleChain(uncachedDomStyleChainOf(el), hits);
            noteResult(count, hits);
            if (count > 0) el.insertBefore(document.createTextNode(indentMarker(count)), el.firstChild);
        }
    } catch (err) {
        /* 预标注只为保真，DOM 能力不足时按未标注继续 */
    }
}

function uncachedDomStyleChainOf(el) {
    const styles = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) styles.push(node.getAttribute('style') || '');
    return styles;
}

// 覆盖计数：命中的声明在叶子块自身还是祖先上，以及其写法（大写单位、!important、小数）
function noteDeclaration(matched, at, hits) {
    hits[at === 0 ? 'onLeaf' : 'onAncestor'] += 1;
    const [whole, rawValue, rawUnit] = matched;
    if (rawUnit && rawUnit !== rawUnit.toLowerCase()) hits.upperUnit += 1;
    // 正则里能消耗 ! 的只有 !important 一项，故匹配串含 ! 即说明该项参与了匹配
    if (whole.includes('!')) hits.important += 1;
    if (rawValue.includes('.')) hits.fraction += 1;
}

// 覆盖计数：首个 font-size（px）为 0 的元素被整体跳过；同一 style 里其后另有正值时另记一笔
function noteZeroFontSize(style, hits) {
    hits.zeroFontSkipped += 1;
    if ([...style.matchAll(EVERY_FONT_SIZE_RE)].some((matched) => Number(matched[1]) > 0)) hits.zeroFontBeforePositive += 1;
}

// 覆盖计数：叶子块的父元素已出现在先前叶子块的链上时，逐元素缓存的实现只需求值叶子块自身，其余取自缓存
function noteChainReuse(el, { isElement, parentOf }, seen, hits) {
    const parent = parentOf(el);
    if (isElement(parent) && seen.has(parent)) hits.cacheReuse += 1;
    for (let node = el; isElement(node); node = parentOf(node)) seen.add(node);
}

// 覆盖计数：参与求值的叶子块数与其中得到缩进标记者
function noteResult(count, hits) {
    hits.leaves += 1;
    if (count > 0) hits.marked += 1;
}

// ============================================================
// 叶子块缩进的逐元素缓存：祖先 style 只匹配一次
// ============================================================

// 耗时用例的输入规模：外层 div 声明 text-indent:2em，中层 div 的 style 为 2 MB 空格（不含任何声明），其下是
// 1000 个叶子块 p。逐叶重扫时，每个叶子块都要把中层那段 style 从头匹配一遍，才落到外层的声明。style 取 2 MB 而非
// 1 MB：旧实现的耗时随「叶子块数 × style 长度」增长，新实现只多出一次约每 MB 5 毫秒的匹配，另有与本项无关、随叶子块数
// 增长的 cheerio 逐叶开销（1000 个约 11 毫秒），故加长 style 能同时拉开两侧余量
const SHARED_STYLE_MB = 2;
const SHARED_STYLE_LENGTH = SHARED_STYLE_MB * 1024 * 1024;
const SHARED_STYLE_LEAF_COUNT = 1000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。300 ms 使两侧余量都不小于 5 倍——
// 逐叶重扫的旧实现在这一规模上实测 markIndents 约 2.7 至 2.8 秒、annotateLayout 约 2.6 至 2.7 秒（二者都随叶子块数
// 与 style 长度线性增长，合计 O(n·L)），是上限的 8.5 倍以上；逐元素缓存之后在本文件内单独运行 22 次，markIndents
// 至多约 41 毫秒、annotateLayout 至多约 15 毫秒，不到上限的七分之一。18 个测试进程同时抢占 18 核时，二者至多约
// 130 与 82 毫秒，仍在上限之内
// CI 上按 test/helpers/timing-budget.js 的系数放宽：CI 三平台上诊断行实测的最大值为 markIndents 194 毫秒（ubuntu）、
// annotateLayout 132 毫秒（Windows），放宽后余量分别为 6.2、9.1 倍
const SHARED_STYLE_BUDGET_MS = 300;

// 差分样本：随机 HTML 页面的份数（每份在 cheerio 与 linkedom 上各跑新旧两遍），以及块元素的最大嵌套层数
const RANDOM_PAGE_COUNT = 1500;
const MAX_NESTING_DEPTH = 5;
// style 的构件：text-indent 的属性名大小写、数值（负值、0、小数，小值使 em 的结果散布于 0 至 4 以上，大值配合字号
// 使 px 与 rem 的折算结果同样散布）、单位（三种合法单位及其大写、无单位、不被接受的单位）与 !important；
// font-size 的正值、0px、非 px 单位；声明内外的空白（含不换行空格）与分号的写法
const INDENT_PROPERTY_NAMES = ['text-indent', 'text-indent', 'TEXT-INDENT'];
const INDENT_VALUES = [
    '-2', '-0.5', '0', '0.0', '0.3', '0.5', '1', '1.4', '1.5', '2', '2.5', '3', '4', '4.5', '6', '8',
    '12', '16', '24', '32', '48', '64', '96',
];
const INDENT_UNITS = ['em', 'em', 'EM', 'Em', 'rem', 'REM', 'px', 'px', 'PX', '', '', 'pt', '%'];
const IMPORTANT_SUFFIXES = ['', '', '', ' !important', '!IMPORTANT'];
const FONT_SIZE_VALUES = ['0px', '0PX', '0.0px', '8px', '10px', '12px', '14px', '16px', '20px', '24px', '32px', '1.5em', '14pt', '120%', '0.5rem'];
const STYLE_SPACES = ['', '', '', ' ', '  ', '\t', '\n', NBSP];
const STYLE_SEPARATORS = [';', ';', '; ', ' ;', ';;'];
// 元素与文本的构件：块元素（叶子块标签与只作嵌套块的标签）、行内元素、正文词语，以及段首空白——
// 不换行空格与全角空格计入缩进，ASCII 空格与换行不计
const BLOCK_TAGS = ['div', 'div', 'section', 'blockquote', 'p', 'p', 'p', 'ul', 'h2', 'pre', 'figure'];
const PHRASING_BLOCK_TAGS = new Set(['p', 'h2', 'pre']);
const INLINE_TAGS = ['span', 'span', 'strong', 'em', 'b'];
const TEXT_WORDS = ['正文', '段落', 'text', '42', '甲乙丙'];
const LEADING_SPACE_TOKENS = [NBSP, NBSP, IDEOGRAPHIC_SPACE, ' ', '\n'];
// 覆盖自证的分支：键为 hits 上的计数名，值为诊断与断言信息里的说明
const RESOLVER_BRANCHES = [
    ['noDeclaration', '链上无 text-indent'],
    ['onLeaf', 'text-indent 在叶子块自身'],
    ['onAncestor', 'text-indent 在祖先上'],
    ['nonPositive', '数值 ≤ 0'],
    ['unitless', '无单位'],
    ['em', 'em'],
    ['rem', 'rem'],
    ['px', 'px'],
    ['upperUnit', '大写单位'],
    ['important', '!important'],
    ['fraction', '小数'],
    ['belowOne', '四舍五入后不足 1'],
    ['clamped', '钳制到 4'],
    ['fontFromChain', '字号取自链上正值'],
    ['fontDefault', '字号取缺省 16'],
    ['zeroFontSkipped', 'font-size 为 0px 的元素被跳过'],
    ['zeroFontBeforePositive', '同一 style 里 0px 在前、正值在后，仍整体跳过'],
    ['cacheReuse', '父元素已在先前叶子块的链上（新实现命中缓存）'],
    ['leaves', '参与求值的叶子块'],
    ['marked', '得到缩进标记的叶子块'],
];
const CHEERIO_ONLY_BRANCHES = [
    ['leadingSpaces', '段首空白折算出字数（takeLeadingSpaces 参与求和）'],
    ['indentAndLeading', 'text-indent 与段首空白同时计入'],
];

const wrapDocument = (fragment) => `<!DOCTYPE html><html><head></head><body>${fragment}</body></html>`;
const emptyHits = (branches) => Object.fromEntries(branches.map(([key]) => [key, 0]));

// 耗时用例的片段与各叶子块的期望文本（段首 2 字缩进标记 + 原文）
function sharedStyleFragment() {
    const leaves = Array.from({ length: SHARED_STYLE_LEAF_COUNT }, (_, index) => `<p>第 ${index + 1} 段</p>`).join('');
    return `<div style="text-indent:2em"><div style="${' '.repeat(SHARED_STYLE_LENGTH)}">${leaves}</div></div>`;
}
const expectedSharedStyleTexts = () => Array.from({ length: SHARED_STYLE_LEAF_COUNT }, (_, index) => `${indentMarker(2)}第 ${index + 1} 段`);

// 随机 HTML 片段的生成器：块元素多层嵌套，块内混排行内元素、<br>、带宽度的 <img> 与段首空白；各元素的 style
// 从上面的构件拼出，也可能缺省或为空串。p、h2、pre 只含行内内容，ul 只含 li，使两种解析器得到相近的树
function createPageGenerator(random) {
    const pick = (items) => items[Math.floor(random() * items.length)];
    const upTo = (max) => Math.floor(random() * (max + 1));
    const space = () => pick(STYLE_SPACES);
    const indentDeclaration = () => `${space()}${pick(INDENT_PROPERTY_NAMES)}${space()}:${space()}`
        + `${pick(INDENT_VALUES)}${space()}${pick(INDENT_UNITS)}${pick(IMPORTANT_SUFFIXES)}${space()}`;
    const fontSizeDeclaration = () => `${space()}font-size${space()}:${space()}${pick(FONT_SIZE_VALUES)}${space()}`;
    // 首个 font-size 为 0px、其后另有正值：该元素整体跳过，不取其后的正值
    const zeroThenPositive = () => `font-size:0px;${space()}font-size:${pick(['12px', '20px', '32px'])}`;
    const declaration = () => {
        const roll = random();
        if (roll < 0.35) return indentDeclaration();
        if (roll < 0.6) return fontSizeDeclaration();
        if (roll < 0.7) return zeroThenPositive();
        return `${space()}${pick(OTHER_DECLARATIONS)}${space()}`;
    };
    const style = () => {
        const declarations = Array.from({ length: 1 + upTo(2) }, declaration);
        return `${random() < 0.1 ? ';' : ''}${declarations.join(pick(STYLE_SEPARATORS))}${random() < 0.3 ? ';' : ''}`;
    };
    const styleAttribute = () => {
        const roll = random();
        if (roll < 0.35) return '';
        if (roll < 0.4) return ' style=""';
        return ` style="${style()}"`;
    };
    const phrasing = (depth) => {
        const pieces = [];
        if (random() < 0.45) pieces.push(Array.from({ length: 1 + upTo(3) }, () => pick(LEADING_SPACE_TOKENS)).join(''));
        const count = upTo(2);
        for (let i = 0; i < count; i += 1) {
            const roll = random();
            if (roll < 0.55 || depth >= MAX_NESTING_DEPTH) {
                pieces.push(pick(TEXT_WORDS));
            } else if (roll < 0.85) {
                const tag = pick(INLINE_TAGS);
                pieces.push(`<${tag}${styleAttribute()}>${phrasing(depth + 1)}</${tag}>`);
            } else if (roll < 0.93) {
                pieces.push('<br>');
            } else {
                pieces.push(`<img src="a.png" style="width:${1 + upTo(400)}px">`);
            }
        }
        return pieces.join('');
    };
    const block = (depth) => {
        const tag = depth >= MAX_NESTING_DEPTH ? 'p' : pick(BLOCK_TAGS);
        if (tag === 'ul') {
            const items = Array.from({ length: 1 + upTo(2) }, () => `<li${styleAttribute()}>${flow(depth + 1)}</li>`);
            return `<ul${styleAttribute()}>${items.join('')}</ul>`;
        }
        const content = PHRASING_BLOCK_TAGS.has(tag) ? phrasing(depth + 1) : flow(depth + 1);
        return `<${tag}${styleAttribute()}>${content}</${tag}>`;
    };
    const flow = (depth) => Array.from({ length: 1 + upTo(2) },
        () => (depth < MAX_NESTING_DEPTH && random() < 0.6 ? block(depth) : phrasing(depth))).join('');
    return () => `<div${styleAttribute()}>${flow(1)}</div>`;
}

describe('叶子块缩进的逐元素缓存：祖先 style 只匹配一次', () => {
    test(`markIndents：${SHARED_STYLE_LEAF_COUNT} 个叶子块共享一个 ${SHARED_STYLE_MB} MB 空白 style 的祖先时，单次调用在绝对上限内，每个叶子块都得到 2 字缩进标记`, (t) => {
        // Arrange：在计时区间外新构造输入，载入方式与 url 解析器的 preprocessHtml 相同
        const $ = cheerio.load(sharedStyleFragment(), null, false);

        // Act：计时区间只包这一次调用
        const started = process.hrtime.bigint();
        markIndents($);
        const elapsedMs = elapsedMsSince(started);

        // Assert：先验结果正确，以免「快」来自少做了事——外层的 2em 经中层继承到每个叶子块
        assert.deepEqual($('p').map((_, el) => $(el).text()).get(), expectedSharedStyleTexts());
        const budget = budgetMs(SHARED_STYLE_BUDGET_MS);
        t.diagnostic(`markIndents 实测 ${elapsedMs.toFixed(1)} ms，上限 ${budget} ms`);
        assert.ok(
            elapsedMs < budget,
            `markIndents 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${budget} ms（${SHARED_STYLE_BUDGET_MS} ms × 系数 ${BUDGET_FACTOR}）`,
        );
    });

    test(`annotateLayout：${SHARED_STYLE_LEAF_COUNT} 个叶子块共享一个 ${SHARED_STYLE_MB} MB 空白 style 的祖先时，单次调用在绝对上限内，每个叶子块都得到 2 字缩进标记`, (t) => {
        // Arrange：在计时区间外新构造输入，载入方式与 web/extract 的 Readability 分支相同
        const { document } = parseHTML(wrapDocument(sharedStyleFragment()));

        // Act：计时区间只包这一次调用
        const started = process.hrtime.bigint();
        annotateLayout(document);
        const elapsedMs = elapsedMsSince(started);

        // Assert：先验结果正确——标记作为文本节点插在每个叶子块之首
        assert.deepEqual(Array.from(document.querySelectorAll('p'), (p) => p.textContent), expectedSharedStyleTexts());
        const budget = budgetMs(SHARED_STYLE_BUDGET_MS);
        t.diagnostic(`annotateLayout 实测 ${elapsedMs.toFixed(1)} ms，上限 ${budget} ms`);
        assert.ok(
            elapsedMs < budget,
            `annotateLayout 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${budget} ms（${SHARED_STYLE_BUDGET_MS} ms × 系数 ${BUDGET_FACTOR}）`,
        );
    });

    test('与逐叶重扫祖先 style 链的旧实现逐字等价：随机 HTML 经 markIndents（cheerio）与 annotateLayout（linkedom）的序列化结果相同，各分支均有样本', (t) => {
        // Arrange：种子固定的随机片段；两条路径各自的命中计数
        const nextPage = createPageGenerator(createSeededRandom(20260924));
        const cheerioHits = emptyHits([...RESOLVER_BRANCHES, ...CHEERIO_ONLY_BRANCHES]);
        const domHits = emptyHits(RESOLVER_BRANCHES);

        for (let index = 0; index < RANDOM_PAGE_COUNT; index += 1) {
            const fragment = nextPage();

            // Act ①：同一片段载入两次，一份跑逐叶重扫的旧实现，一份跑逐元素缓存的新实现
            const $expected = cheerio.load(fragment, null, false);
            uncachedMarkIndents($expected, cheerioHits);
            const $actual = cheerio.load(fragment, null, false);
            markIndents($actual);
            // Assert ①：序列化结果逐字相同；只在不一致时拼装诊断信息
            const expectedHtml = $expected.html();
            const actualHtml = $actual.html();
            if (actualHtml !== expectedHtml) {
                assert.equal(actualHtml, expectedHtml, `cheerio 路径第 ${index} 份样本：${toVisible(fragment)}`);
            }

            // Act ②：linkedom 路径同理
            const { document: expectedDocument } = parseHTML(wrapDocument(fragment));
            uncachedAnnotateLayout(expectedDocument, domHits);
            const { document: actualDocument } = parseHTML(wrapDocument(fragment));
            annotateLayout(actualDocument);
            // Assert ②
            const expectedDom = expectedDocument.toString();
            const actualDom = actualDocument.toString();
            if (actualDom !== expectedDom) {
                assert.equal(actualDom, expectedDom, `linkedom 路径第 ${index} 份样本：${toVisible(fragment)}`);
            }
        }

        // 覆盖自证：两条路径各自的每个分支都须有命中样本，差分才不是对某一分支空转
        for (const [label, hits, branches] of [
            ['cheerio（markIndents）', cheerioHits, [...RESOLVER_BRANCHES, ...CHEERIO_ONLY_BRANCHES]],
            ['linkedom（annotateLayout）', domHits, RESOLVER_BRANCHES],
        ]) {
            t.diagnostic(`${label} 路径 ${RANDOM_PAGE_COUNT} 份样本：`
                + `${branches.map(([key, description]) => `${description} ${hits[key]}`).join('，')}`);
            for (const [key, description] of branches) {
                assert.ok(hits[key] > 0, `${label} 路径中「${description}」的样本数为 0`);
            }
        }
    });
});
