/**
 * converters/web/extract.js 单元测试
 * 覆盖：Readability 链路的两处可见性判定——可读性预判（isProbablyReaderable）的 visibilityChecker 与 Readability 实例的
 *       _isProbablyVisible——改为按 linkedom 的取值规则线性求值（inlineStyleValue），不再经 linkedom 的 el.style：
 *       长空白 style 分别只经可读性预判、只经 Readability 与位于 svg 上时，extractContent 全链路在绝对上限内（耗时），
 *       且结果与把该段空白换成单个空格的短页面一致、svg 的 style 原样保留；
 *       inlineStyleValue 与 linkedom 的 el.style[name] 逐字等价（随机 style 差分，含改写与删去 style 之后）；
 *       isProbablyVisible 与 Readability 0.6.0 的 _isProbablyVisible、isNodeVisible 与可读性预判缺省的 isNodeVisible
 *       逐元素等价（随机属性差分，含 svg 子树内的元素）；
 *       随机短页面经 extractContent 与替换之前的 Readability 链路逐字等价（全链路差分），以及 style 原值进入输出的
 *       三处固定用例（svg 子树的 style、noscript 替换时的 data-old-style、懒加载从 style 复制出的 src）
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const cheerio = require('cheerio');
const { parseHTML } = require('linkedom');
const { Readability, isProbablyReaderable } = require('@mozilla/readability');

// 以解构导入：未修复的实现没有后三个导出，此时它们只是 undefined，依赖它们的用例各自报错，不致在导入时整体崩溃
const {
    extractContent, annotateLayout, READERABLE_OPTIONS, MIN_READABILITY_TEXT_LENGTH,
    inlineStyleValue, isNodeVisible, isProbablyVisible,
} = require('../converters/web/extract');

// 制表符、换行、回车、换页与垂直制表符写作转义序列，其余不可见字符以码点生成，源码里不出现看不见的字面量
const NBSP = String.fromCharCode(0xa0);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

// 页面 URL 不命中站点表，extractContent 依次走 Readability 与兜底链路
const PAGE_URL = 'https://example.com/article';
const wrapPage = (body) => `<!DOCTYPE html><html><head><title>标题</title></head><body>${body}</body></html>`;

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

const elapsedMsSince = (started) => Number(process.hrtime.bigint() - started) / 1e6;
const emptyHits = (branches) => Object.fromEntries(branches.map(([key]) => [key, 0]));

// 覆盖自证：先把各分支的命中数印进诊断，再逐个断言大于 0，差分才不是对某一分支空转
function assertBranchesCovered(t, label, hits, branches) {
    t.diagnostic(`${label}：${branches.map(([key, description]) => `${description} ${hits[key]}`).join('，')}`);
    for (const [key, description] of branches) {
        assert.ok(hits[key] > 0, `${label}中「${description}」的样本数为 0`);
    }
}

// ============================================================
// 替换之前的 Readability 链路（差分参照）
// ============================================================

// 仅作短输入的差分参照：照录 3132d9f 版 web/extract 的 extractByReadability 与 isReaderable，可见性判定用库缺省的实现——
// 可读性预判的 isNodeVisible 与 Readability 的 _isProbablyVisible 都经 linkedom 的 el.style 取值，长空白 style 上平方级，
// 不可用于耗时用例的输入规模。READABILITY_OPTIONS 未导出，照录其值；annotateLayout、READERABLE_OPTIONS 与
// MIN_READABILITY_TEXT_LENGTH 已导出且未改动，直接引用
const LEGACY_READABILITY_OPTIONS = Object.freeze({ charThreshold: 100 });

function legacyExtractByReadability(html) {
    let document;
    try {
        ({ document } = parseHTML(String(html || '')));
    } catch (err) {
        return null;
    }
    if (!document || !legacyIsReaderable(document)) return null;
    annotateLayout(document);

    let article;
    try {
        article = new Readability(document, { ...LEGACY_READABILITY_OPTIONS }).parse();
    } catch (err) {
        return null;
    }
    if (!article || !article.content) return null;
    const textLength = String(article.textContent || '').trim().length;
    if (textLength < MIN_READABILITY_TEXT_LENGTH) return null;
    return { html: article.content, extraction: 'readability', article };
}

function legacyIsReaderable(document) {
    try {
        return isProbablyReaderable(document, { ...READERABLE_OPTIONS });
    } catch (err) {
        return false;
    }
}

// ============================================================
// 长空白 style：extractContent 全链路线性于页面长度
// ============================================================

// 耗时用例的输入规模：style 为 64 KB（65536 个字符）空白后接 x。linkedom 的平方级只取决于不邻接分号的空白段长度，
// 与段后有无字符无关；x 使短页面的 style（单个空格后接 x）在输出里有可定位的原样片段
const LONG_WHITESPACE_LENGTH = 64 * 1024;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。300 ms 使两侧余量都不小于 5 倍——
// 未修复的实现在这一规模上，新起进程只跑单个用例各实测 2 次，三例依次约 2.0 至 2.2、3.0 至 4.9、2.4 至 2.5 秒（整份文件
// 连跑时约 2.6、3.1、2.6 秒；耗时随空白段长平方增长，8、16、32 KB 时约 0.04、0.15、0.55 秒），最小值也是上限的 6.8 倍；
// 修复之后单独运行本文件 10 次，三例至多约 2.1、3.7、2.3 毫秒；18 核上全量并行 6 次至多约 31 毫秒（与同机其他测试进程
// 并发时），仍不到上限的九分之一
const LONG_WHITESPACE_BUDGET_MS = 300;
// 短页面的 style 属性在输出中的原样片段（svg 用例据此换回长空白）
const SHORT_STYLE = ' x';
const SHORT_STYLE_ATTRIBUTE = `style="${SHORT_STYLE}"`;

const LEAD_PARAGRAPH = '正文内容足够长，用于通过可读性预判并参与正文打分。'.repeat(8);
const TAIL_PARAGRAPH = '第二段落同样足够长，使 Readability 取得正文。'.repeat(8);

// 只经可读性预判：带该 style 的 <p> 是全页第一个、也是唯一的 p／pre／article 候选（页内也没有 div > br），正文短于
// minContentLength，预判读过它的 style 后判负，Readability 不运行。正文放在 <main> 里，兜底链路取 main、不带出该 <p>
const readerableOnlyPage = (style) => wrapPage(
    `<p style="${style}">短句。</p><main><h2>小标题</h2><ul><li>条目一</li><li>条目二</li></ul></main>`,
);
// 只经 Readability：article 是首个候选、正文足够长，预判在读到其他元素之前即为真；<span> 不是预判的候选，其 style
// 只由 Readability 读取，随后被 _cleanStyles 删去
const readabilityOnlyPage = (style) => wrapPage(
    `<article><h1>标题</h1><p>${LEAD_PARAGRAPH}</p><p>前文<span style="${style}">行内文字</span>后文。${TAIL_PARAGRAPH}</p></article>`,
);
// svg：Readability 读取其 style 判定可见性；_cleanStyles 遇 svg 即停，该 style 原样进入输出
const svgPage = (style) => wrapPage(
    `<article><h1>标题</h1><p>${LEAD_PARAGRAPH}</p><svg style="${style}"><text>图</text></svg><p>${TAIL_PARAGRAPH}</p></article>`,
);

// Readability 用例的长空白混用五类空白：都属正则的 \s，旧实现同样平方级；U+00A0 与 U+3000 使该串成为双字节串
const MIXED_WHITESPACE_UNIT = [' ', '\t', '\n', NBSP, IDEOGRAPHIC_SPACE].join('');
const mixedWhitespace = (length) => MIXED_WHITESPACE_UNIT
    .repeat(Math.ceil(length / MIXED_WHITESPACE_UNIT.length))
    .slice(0, length);

// cheerio 载入放在计时区间之外（载入方式与 url 解析器相同），计时区间只包一次 extractContent
function timedExtract(html) {
    const $ = cheerio.load(html);
    const started = process.hrtime.bigint();
    const result = extractContent({ $, html, url: PAGE_URL });
    return { result, elapsedMs: elapsedMsSince(started) };
}

function assertWithinBudget(t, elapsedMs) {
    t.diagnostic(`extractContent 实测 ${elapsedMs.toFixed(1)} ms，上限 ${LONG_WHITESPACE_BUDGET_MS} ms`);
    assert.ok(
        elapsedMs < LONG_WHITESPACE_BUDGET_MS,
        `extractContent 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${LONG_WHITESPACE_BUDGET_MS} ms`,
    );
}

// 长串逐字比较：不一致时只报长度与首个差异位置前后的片段，免得断言信息带出整段 64 KB 空白
function assertSameText(actual, expected, label) {
    if (actual === expected) return;
    let at = 0;
    while (at < actual.length && at < expected.length && actual[at] === expected[at]) at += 1;
    const excerpt = (text) => toVisible(text.slice(Math.max(0, at - 40), at + 40));
    assert.fail(`${label} 与期望不一致：长度 ${actual.length}／${expected.length}，首个差异在第 ${at} 个字符，`
        + `实际「${excerpt(actual)}」，期望「${excerpt(expected)}」`);
}

describe('长空白 style：extractContent 全链路线性于页面长度', () => {
    test(`只经可读性预判：唯一候选 <p> 的 style 为 ${LONG_WHITESPACE_LENGTH} 个空格时，单次调用在绝对上限内，结果与短页面相同（兜底链路）`, (t) => {
        // Arrange ①：短页面的参照。预判判负、Readability 不运行（旧链路返回 null），新旧都走同一兜底链路
        const shortHtml = readerableOnlyPage(SHORT_STYLE);
        assert.equal(legacyExtractByReadability(shortHtml), null, '短页面的可读性预判应判负');
        const expected = extractContent({ $: cheerio.load(shortHtml), html: shortHtml, url: PAGE_URL });
        assert.ok(expected.extraction.startsWith('fallback:'), `短页面的 extraction 为 ${expected.extraction}`);
        // Arrange ②：在计时区间外新构造长页面
        const html = readerableOnlyPage(`${' '.repeat(LONG_WHITESPACE_LENGTH)}x`);

        // Act
        const { result, elapsedMs } = timedExtract(html);

        // Assert：先验结果正确，以免「快」来自少做了事
        assert.deepEqual(result, expected);
        assertWithinBudget(t, elapsedMs);
    });

    test(`只经 Readability：正文 <span> 的 style 为 ${LONG_WHITESPACE_LENGTH} 个混合空白时，单次调用在绝对上限内，结果与短页面相同`, (t) => {
        // Arrange ①：短页面的参照，取自替换之前的 Readability 链路
        const shortHtml = readabilityOnlyPage(SHORT_STYLE);
        const expected = legacyExtractByReadability(shortHtml);
        assert.ok(expected, '短页面应经 Readability 取得正文');
        // Arrange ②
        const html = readabilityOnlyPage(`${mixedWhitespace(LONG_WHITESPACE_LENGTH)}x`);

        // Act
        const { result, elapsedMs } = timedExtract(html);

        // Assert：<span> 的 style 已被 _cleanStyles 删去，结果与短页面深相等
        assert.deepEqual(result, expected);
        assertWithinBudget(t, elapsedMs);
    });

    test(`svg：正文 <svg> 的 style 为 ${LONG_WHITESPACE_LENGTH} 个空格时，单次调用在绝对上限内，该 style 原样保留，其余与短页面相同`, (t) => {
        // Arrange ①：短页面的参照；其中短 style 的原样片段须恰出现一次，才能无歧义地换回长空白
        const shortHtml = svgPage(SHORT_STYLE);
        const expected = legacyExtractByReadability(shortHtml);
        assert.ok(expected, '短页面应经 Readability 取得正文');
        assert.equal(expected.html.split(SHORT_STYLE_ATTRIBUTE).length - 1, 1, `参照中 ${SHORT_STYLE_ATTRIBUTE} 应恰出现一次`);
        // Arrange ②：纯空格，linkedom 序列化属性值时原样写出（U+00A0 会被写成字符引用）
        const whitespace = ' '.repeat(LONG_WHITESPACE_LENGTH);
        const html = svgPage(`${whitespace}x`);

        // Act
        const { result, elapsedMs } = timedExtract(html);

        // Assert：html 与 article.content 等于把参照中那一处短 style 换回长空白后的串，其余字段深相等
        const expectedHtml = expected.html.replace(SHORT_STYLE_ATTRIBUTE, () => `style="${whitespace}x"`);
        assertSameText(result.html, expectedHtml, 'html');
        assertSameText(result.article.content, expectedHtml, 'article.content');
        const withoutContent = ({ article, ...rest }) => ({ ...rest, html: null, article: { ...article, content: null } });
        assert.deepEqual(withoutContent(result), withoutContent(expected));
        assertWithinBudget(t, elapsedMs);
    });
});

// ============================================================
// inlineStyleValue：与 linkedom 的 el.style[name] 逐字等价
// ============================================================

// 随机 style 的构件：各类空白（\s 的多类成员，含 U+2028 与 U+FEFF）；键（三个待查属性名、大小写变体、中间带空格者、
// 其他属性名与空键）；冒号（单个、连写、中间隔空白、缺失）；值（none、hidden、block、空值、大小写变体与含冒号者）
const STYLE_WHITESPACE = [' ', '\t', '\n', '\r', '\f', '\v', NBSP, IDEOGRAPHIC_SPACE, LINE_SEPARATOR, BYTE_ORDER_MARK];
const STYLE_KEYS = ['display', 'display', 'visibility', 'visibility', 'text-align', 'Display', 'VISIBILITY', 'dis play', 'color', ''];
const STYLE_COLONS = [':', ':', ':', '::', ': :', ''];
const STYLE_VALUES = ['none', 'none', 'hidden', 'hidden', 'block', 'center', '', '', 'None', 'HIDDEN', 'a:b', 'url(x:y)'];
const STYLE_SEPARATORS = [';', ';', ';', ';;', '; ;'];
// 随机增删的字母表：各类空白、分号与冒号，以及拼得出 none、display 片段的字母
const STYLE_MUTATION_ALPHABET = [...STYLE_WHITESPACE, ';', ';', ':', ':', 'd', 'n', 'o', 'e', 'x'];
// 待查的属性名：两处可见性判定所用的两个，另加一个带连字符的其他属性名
const QUERIED_NAMES = ['display', 'visibility', 'text-align'];
const STYLE_SAMPLE_COUNT = 50000;
const STYLE_BRANCHES = [
    ['noAttribute', '无 style 属性'],
    ['noColon', '段内无冒号'],
    ['keyMismatch', '键不符'],
    ['caseMismatch', '键仅大小写不符'],
    ['emptyValue', '键符而值空'],
    ['emptyAfterValue', '键符而值空、出现在同名非空值之后（不得覆盖）'],
    ['valued', '键符且值非空'],
    ['valueWithColon', '键符且值含冒号'],
    ['overridden', '同名多次覆盖'],
    ['overriddenDiffering', '同名多次覆盖且首末值不同'],
    ['returnedNone', '返回 none'],
    ['returnedHidden', '返回 hidden'],
    ['returnedOther', '返回其他非空值'],
    ['returnedEmpty', '返回空串'],
    ['reassigned', '同一元素改写 style 后再比较'],
    ['removed', '同一元素删去 style 后再比较'],
];

// 随机 style 的生成器：0 至 3 条声明以同一种分隔写法相连，首尾可带分号，再随机增删 0 至 3 个字符
function createStyleGenerator(random) {
    const pick = (items) => items[Math.floor(random() * items.length)];
    const whitespace = () => Array.from({ length: Math.floor(random() * 3) }, () => pick(STYLE_WHITESPACE)).join('');
    const declaration = () => [
        whitespace(), pick(STYLE_KEYS), whitespace(), pick(STYLE_COLONS), whitespace(), pick(STYLE_VALUES), whitespace(),
    ].join('');
    const mutate = (text) => {
        let out = text;
        const edits = Math.floor(random() * 4);
        for (let i = 0; i < edits; i += 1) {
            if (out.length > 0 && random() < 0.5) {
                const at = Math.floor(random() * out.length);
                out = out.slice(0, at) + out.slice(at + 1);
            } else {
                const at = Math.floor(random() * (out.length + 1));
                out = out.slice(0, at) + pick(STYLE_MUTATION_ALPHABET) + out.slice(at);
            }
        }
        return out;
    };
    return () => {
        const declarations = Array.from({ length: Math.floor(random() * 4) }, declaration);
        const leading = random() < 0.15 ? ';' : '';
        const trailing = random() < 0.3 ? ';' : '';
        return mutate(leading + declarations.join(pick(STYLE_SEPARATORS)) + trailing);
    };
}

// 覆盖计数：照录 linkedom 的切分规则（css-style-declaration.js 的 updateKeys）逐段归类，只计数、不参与比对
function noteStyleBranches(style, name, hits) {
    const values = [];
    for (const rule of style.split(/\s*;\s*/)) {
        const [rawKey, ...rest] = rule.split(':');
        if (rest.length === 0) {
            hits.noColon += 1;
            continue;
        }
        const key = rawKey.trim();
        const value = rest.join(':').trim();
        if (key !== name) {
            hits.keyMismatch += 1;
            if (key.toLowerCase() === name) hits.caseMismatch += 1;
        } else if (!value) {
            hits.emptyValue += 1;
            if (values.length > 0) hits.emptyAfterValue += 1;
        } else {
            hits.valued += 1;
            if (rest.length > 1) hits.valueWithColon += 1;
            values.push(value);
        }
    }
    if (values.length > 1) {
        hits.overridden += 1;
        if (values[0] !== values[values.length - 1]) hits.overriddenDiffering += 1;
    }
}

// 逐个属性名比较 inlineStyleValue 与 linkedom 的取值；style 为 null 表示元素没有 style 属性
function compareStyleValues(el, style, hits, label) {
    for (const name of QUERIED_NAMES) {
        const expected = el.style[name];
        const actual = inlineStyleValue(el, name);
        // 只在不一致时拼装诊断信息
        if (actual !== expected) {
            assert.equal(actual, expected, `${label}：name=${name}，style=${style === null ? '（无）' : toVisible(style)}`);
        }
        if (style === null) hits.noAttribute += 1;
        else noteStyleBranches(style, name, hits);
        if (expected === 'none') hits.returnedNone += 1;
        else if (expected === 'hidden') hits.returnedHidden += 1;
        else if (expected) hits.returnedOther += 1;
        else hits.returnedEmpty += 1;
    }
}

describe('inlineStyleValue：与 linkedom 的 el.style[name] 逐字等价', () => {
    test('随机 style 差分：每个样本新建元素，display、visibility 与 text-align 三个属性名的取值均与 linkedom 相同，各分支均有样本', (t) => {
        // Arrange
        const random = createSeededRandom(20260923);
        const pick = (items) => items[Math.floor(random() * items.length)];
        const nextStyle = createStyleGenerator(random);
        const { document } = parseHTML(wrapPage(''));
        const hits = emptyHits(STYLE_BRANCHES);

        for (let index = 0; index < STYLE_SAMPLE_COUNT; index += 1) {
            // Act & Assert ①：新建元素，约 5% 不设 style 属性
            const el = document.createElement(pick(['p', 'div', 'span']));
            const style = random() < 0.05 ? null : nextStyle();
            if (style !== null) el.setAttribute('style', style);
            compareStyleValues(el, style, hits, `第 ${index} 个样本`);

            // Act & Assert ②：同一元素改写或删去 style 后再比较——linkedom 须丢弃已缓存的切分结果，inlineStyleValue 每次直读
            // 属性的当前值
            const roll = random();
            if (roll < 0.2) {
                const next = nextStyle();
                el.setAttribute('style', next);
                hits.reassigned += 1;
                compareStyleValues(el, next, hits, `第 ${index} 个样本改写之后`);
            } else if (roll < 0.25 && style !== null) {
                el.removeAttribute('style');
                hits.removed += 1;
                compareStyleValues(el, null, hits, `第 ${index} 个样本删去之后`);
            }
        }

        assertBranchesCovered(t, `随机 style ${STYLE_SAMPLE_COUNT} 个`, hits, STYLE_BRANCHES);
    });
});

// ============================================================
// isProbablyVisible、isNodeVisible：与库自身的可见性判定逐元素等价
// ============================================================

// 可见性判定的常见写法：隐藏、显式可见、同名覆盖（先隐藏后可见与先可见后隐藏）、大小写变体与空值；与随机 style 各占一半
const VISIBILITY_STYLES = [
    'display:none', ' display : none ;', 'color:red; display:none', 'display:none; display:block', 'display:block;display:none',
    'display:', 'Display:none', 'display:None', 'display:block',
    'visibility:hidden', 'visibility : hidden ;', 'visibility:hidden;visibility:visible', 'visibility:visible; visibility:hidden',
    'VISIBILITY:hidden', 'visibility:Hidden', 'visibility:visible',
    'display:none;visibility:hidden', 'display:block; visibility:hidden', '',
];
const HIDDEN_ATTRIBUTES = [' hidden', ' hidden=""', ' hidden="false"'];
const ARIA_HIDDEN_VALUES = ['true', 'true', 'true', 'false', 'TRUE', '', 'yes'];
// class 取值都不含可读性预判 unlikelyCandidates 的词，使单候选文档的预判结果只取决于可见性
const CLASS_VALUES = ['fallback-image', 'mwe-math-fallback-image-inline', 'photo fallback-image', 'note', 'photo'];
const HTML_SAMPLE_TAGS = ['p', 'div', 'span'];
const ELEMENT_KINDS = ['p', 'div', 'span', 'svg', 'g', 'img'];
// isProbablyVisible 与 isNodeVisible 的逐元素差分共用的一批元素：样本数（其中约四分之一是 svg、g、img 三个一组的
// svg 子树）与种子
const VISIBILITY_SAMPLE_COUNT = 6000;
const VISIBILITY_SAMPLE_SEED = 20260924;
// 单候选文档的份数与唯一 <p> 的正文：169 个字符，超过 150 时 sqrt(长度 - minContentLength 50) > minScore 10，
// 故「可见 ⇔ isProbablyReaderable 为真」
const READERABLE_SAMPLE_COUNT = 4000;
const CANDIDATE_TEXT = '可见性差分所用的正文段落。'.repeat(13);
const READABILITY_VISIBILITY_BRANCHES = [
    ['displayNone', 'display 为 none'],
    ['visibilityHidden', 'visibility 为 hidden（display 不为 none）'],
    ['hiddenAttribute', '有 hidden 属性（style 未隐藏）'],
    ['ariaHidden', 'aria-hidden 为 true 且无 fallback-image'],
    ['ariaHiddenFallback', 'aria-hidden 为 true 且有 fallback-image'],
    ['ariaOther', 'aria-hidden 为其他值'],
    ['visible', '无任何隐藏因素、全部可见'],
];
const READERABLE_VISIBILITY_BRANCHES = [
    ['displayNone', 'display 为 none'],
    ['hiddenAttribute', '有 hidden 属性（display 不为 none）'],
    ['ariaHidden', 'aria-hidden 为 true 且无 fallback-image'],
    ['ariaHiddenFallback', 'aria-hidden 为 true 且有 fallback-image'],
    ['ariaOther', 'aria-hidden 为其他值'],
    ['visible', '无任何隐藏因素、全部可见'],
    ['visibilityIgnored', 'visibility 为 hidden 而仍判为可见（可读性预判不看 visibility）'],
    ['judgedVisible', '判为可见'],
    ['judgedHidden', '判为不可见'],
];
const KIND_BRANCHES = ELEMENT_KINDS.map((kind) => [kind, `<${kind}>`]);

// 随机属性的生成器：style（常见写法与随机 style 各半）、hidden、aria-hidden 与 class 各自独立地随机出现
function createAttributeGenerator(random) {
    const pick = (items) => items[Math.floor(random() * items.length)];
    const nextStyle = createStyleGenerator(random);
    return () => {
        let attributes = '';
        if (random() < 0.7) attributes += ` style="${random() < 0.5 ? pick(VISIBILITY_STYLES) : nextStyle()}"`;
        if (random() < 0.15) attributes += pick(HIDDEN_ATTRIBUTES);
        if (random() < 0.35) attributes += ` aria-hidden="${pick(ARIA_HIDDEN_VALUES)}"`;
        if (random() < 0.4) attributes += ` class="${pick(CLASS_VALUES)}"`;
        return attributes;
    };
}

// 两组逐元素差分共用的一批元素所在的页面：固定种子，每次调用得到同一个串。元素为 p、div、span，以及 svg 子树内的 svg、g、img
// （linkedom 中三者都是 SVGElement，tagName 为大写，className 为不带 includes 的对象）
function visibilitySamplePage() {
    const random = createSeededRandom(VISIBILITY_SAMPLE_SEED);
    const pick = (items) => items[Math.floor(random() * items.length)];
    const nextAttributes = createAttributeGenerator(random);
    const samples = Array.from({ length: VISIBILITY_SAMPLE_COUNT }, () => {
        if (random() < 0.25) return `<svg${nextAttributes()}><g${nextAttributes()}><img${nextAttributes()}></g></svg>`;
        const tag = pick(HTML_SAMPLE_TAGS);
        return `<${tag}${nextAttributes()}>文字</${tag}>`;
    });
    return wrapPage(samples.join(''));
}

// 覆盖计数：按库实现的短路次序，归类首个起决定作用的条件；style 经 linkedom 的 el.style 读取，与库实现同一口径
function classifyVisibility(node, checksVisibility) {
    if (node.style.display == 'none') return 'displayNone';
    if (checksVisibility && node.style.visibility == 'hidden') return 'visibilityHidden';
    if (node.hasAttribute('hidden')) return 'hiddenAttribute';
    if (!node.hasAttribute('aria-hidden')) return 'visible';
    if (node.getAttribute('aria-hidden') != 'true') return 'ariaOther';
    return node.className && node.className.includes && node.className.includes('fallback-image')
        ? 'ariaHiddenFallback'
        : 'ariaHidden';
}

// 可读性预判一侧的计数：归类之外，另记判定结果，以及 visibility 为 hidden 而仍判为可见者
function noteReaderableVisibility(node, judgedVisible, hits) {
    hits[classifyVisibility(node, false)] += 1;
    hits[judgedVisible ? 'judgedVisible' : 'judgedHidden'] += 1;
    if (judgedVisible && node.style.visibility == 'hidden') hits.visibilityIgnored += 1;
}

// 单候选的替身文档：isProbablyReaderable 只经 querySelectorAll 取候选（'p, pre, article' 与 'div > br' 两次查询），
// 替身令前者只返回 node、后者为空，使 span 与 svg 子树内的元素也能成为唯一候选。候选正文足够长、class 与 id 不含
// unlikelyCandidates 的词且不在 li 内时，预判为真当且仅当库缺省的 isNodeVisible 判其可见
const singleCandidateDocument = (node) => ({
    querySelectorAll: (selector) => (selector === 'p, pre, article' ? [node] : []),
});

describe('isProbablyVisible、isNodeVisible：与库自身的可见性判定逐元素等价', () => {
    test('isProbablyVisible 与 Readability.prototype._isProbablyVisible 逐元素相同：p、div、span 与 svg 子树内的元素，各分支均有样本', (t) => {
        // Arrange：_isProbablyVisible 的方法体只用参数 node、不用 this，故以 null 为 this 直接调用库实现
        const { document } = parseHTML(visibilitySamplePage());
        const elements = Array.from(document.body.querySelectorAll('*'));
        const hits = emptyHits([...READABILITY_VISIBILITY_BRANCHES, ...KIND_BRANCHES]);

        for (const el of elements) {
            // Act
            const expected = Readability.prototype._isProbablyVisible.call(null, el);
            const actual = isProbablyVisible(el);
            // Assert：只在不一致时拼装诊断信息
            if (actual !== expected) {
                assert.equal(actual, expected, `<${el.localName}> 的属性：${toVisible(el.cloneNode(false).toString())}`);
            }
            hits[classifyVisibility(el, true)] += 1;
            hits[el.localName] += 1;
        }

        assertBranchesCovered(t, `${elements.length} 个元素`, hits, [...READABILITY_VISIBILITY_BRANCHES, ...KIND_BRANCHES]);
    });

    test('isNodeVisible 与可读性预判缺省的 isNodeVisible 等价：只含一个 <p> 的文档上 isProbablyReaderable 的结果相同，真假两种结果都有样本', (t) => {
        // Arrange：每份文档只有一个 <p> 候选，正文 169 个字符，预判结果即该 <p> 的可见性
        const random = createSeededRandom(20260925);
        const nextAttributes = createAttributeGenerator(random);
        const hits = emptyHits(READERABLE_VISIBILITY_BRANCHES);

        for (let index = 0; index < READERABLE_SAMPLE_COUNT; index += 1) {
            const { document } = parseHTML(wrapPage(`<p${nextAttributes()}>${CANDIDATE_TEXT}</p>`));

            // Act：缺省的 visibilityChecker 即库自身的 isNodeVisible
            const expected = isProbablyReaderable(document, READERABLE_OPTIONS);
            const actual = isProbablyReaderable(document, { ...READERABLE_OPTIONS, visibilityChecker: isNodeVisible });

            // Assert
            const p = document.querySelector('p');
            if (actual !== expected) {
                assert.equal(actual, expected, `第 ${index} 份文档，<p> 的属性：${toVisible(p.cloneNode(false).toString())}`);
            }
            noteReaderableVisibility(p, expected, hits);
        }

        assertBranchesCovered(t, `单候选文档 ${READERABLE_SAMPLE_COUNT} 份`, hits, READERABLE_VISIBILITY_BRANCHES);
    });

    test('isNodeVisible 与可读性预判缺省的 isNodeVisible 逐元素相同：与上一组同一批元素（含 span 与 svg 子树），参照经单候选替身文档求得', (t) => {
        // Arrange：同一种子重建上一组的元素；为每个元素补上足够长的正文，使预判结果只取决于其可见性
        const { document } = parseHTML(visibilitySamplePage());
        const elements = Array.from(document.body.querySelectorAll('*'));
        for (const el of elements) el.appendChild(document.createTextNode(CANDIDATE_TEXT));
        const hits = emptyHits([...READERABLE_VISIBILITY_BRANCHES, ...KIND_BRANCHES]);

        for (const el of elements) {
            // Act：库实现与照录者都可能返回空串等假值（className 为空串时），isProbablyReaderable 只取其真假，故按真假比较
            const expected = isProbablyReaderable(singleCandidateDocument(el), READERABLE_OPTIONS);
            const actual = Boolean(isNodeVisible(el));
            // Assert
            if (actual !== expected) {
                assert.equal(actual, expected, `<${el.localName}> 的属性：${toVisible(el.cloneNode(false).toString())}`);
            }
            noteReaderableVisibility(el, expected, hits);
            hits[el.localName] += 1;
        }

        assertBranchesCovered(t, `${elements.length} 个元素`, hits, [...READERABLE_VISIBILITY_BRANCHES, ...KIND_BRANCHES]);
    });
});

// ============================================================
// 全链路：随机短页面经 extractContent 与替换之前的 Readability 链路逐字等价
// ============================================================

const ARTICLE_PAGE_COUNT = 1000;
// 正文句子：每句 20 余字，长段落由 4 至 8 句拼成，超过可读性预判与 Readability 的门槛；短段落只有 1 句
const ARTICLE_SENTENCES = [
    '这是一段用于全链路差分的正文，句子足够长以便参与打分。',
    'Readability 依据段落长度、逗号数量与类名给候选元素打分，',
    '中文段落的字数决定它能否越过可读性预判的门槛。',
    '隐藏的块在新旧两条实现中都应被同样地移除，',
    '图片、矢量图与 noscript 的组合也一并参与比较。',
];
// 四种隐藏方式：隐藏声明写在块的开始标签上，去掉隐藏声明的对照页只删这一处
const HIDING_KINDS = ['display', 'visibility', 'hidden', 'aria'];
const HIDING_ATTRIBUTES = {
    display: [' style="display:none"', ' style="color:red; display : none;"', ' style="display:none ;"'],
    visibility: [' style="visibility:hidden"', ' style="color:red;visibility : hidden"'],
    hidden: [' hidden'],
    aria: [' aria-hidden="true"'],
};
// svg 与其子元素的 style：多个空格、同名覆盖与隐藏声明都有
const SVG_STYLES = ['fill:red;   stroke:blue', 'stroke-width : 2 ;  opacity:0.5', 'color:#333;  fill:none;', 'display:none;  fill:red', 'visibility:hidden', ''];
// 带图片的段落里 img 的 style：宽度声明，以及含图片扩展名者
const IMG_STYLES = ['width:120px', 'q.png', 'width: 50% ;  q.webp', 'r.jpg  x'];
const ARTICLE_BRANCHES = [
    ['readability', 'Readability 取得结果'],
    ['fallback', '落入兜底链路'],
    ...HIDING_KINDS.map((kind) => [`hidden:${kind}`, `以 ${kind} 隐藏的块被移除（去掉隐藏声明后结果不同）`]),
    ['svgStyleKept', '输出中保留 svg 的 style'],
    ['dataOld', '输出中含 data-old-'],
    ['lazySrc', '懒加载从 style 复制出 src'],
];

// 随机页面的生成器：返回 { kind, hasHidden, render }，render(true) 为原页面，render(false) 为去掉隐藏声明的对照页。
// 每页只用一种隐藏方式，结果不同时可归到该方式名下
function createArticlePageGenerator(random) {
    const pick = (items) => items[Math.floor(random() * items.length)];
    const upTo = (max) => Math.floor(random() * (max + 1));
    const paragraphText = (long) => Array.from({ length: long ? 4 + upTo(4) : 1 }, () => pick(ARTICLE_SENTENCES)).join('');
    const fixed = (html) => () => html;
    const hiddenBlock = (kind) => {
        const attribute = pick(HIDING_ATTRIBUTES[kind]);
        const text = paragraphText(random() < 0.6);
        const [open, close] = random() < 0.5 ? ['<div', `<p>${text}</p></div>`] : ['<p', `${text}</p>`];
        return (withHiding) => `${open}${withHiding ? attribute : ''}>${close}`;
    };
    const svgBlock = () => `<svg style="${pick(SVG_STYLES)}"><g style="${pick(SVG_STYLES)}"><text>图示</text></g></svg>`;
    const noscriptBlock = () => {
        const image = `n${upTo(9)}.jpg`;
        return `<div><img style="${image}${' '.repeat(1 + upTo(2))}x"><noscript><img src="m${upTo(9)}.png" style="${image} x"></noscript></div>`;
    };
    const lazySvgImage = () => `<svg><img style="lazy-${upTo(9)}.jpg${' '.repeat(upTo(3))}"></svg>`;
    const imageParagraph = () => `<p>${paragraphText(false)}<img src="p${upTo(9)}.png" style="${pick(IMG_STYLES)}">${paragraphText(false)}</p>`;
    return () => {
        const kind = pick(HIDING_KINDS);
        let hasHidden = false;
        const parts = Array.from({ length: 2 + upTo(5) }, () => {
            const roll = random();
            if (roll < 0.4) return fixed(`<p>${paragraphText(random() < 0.5)}</p>`);
            if (roll < 0.58) {
                hasHidden = true;
                return hiddenBlock(kind);
            }
            if (roll < 0.7) return fixed(svgBlock());
            if (roll < 0.8) return fixed(noscriptBlock());
            if (roll < 0.9) return fixed(lazySvgImage());
            return fixed(imageParagraph());
        });
        const container = pick(['article', 'div', 'main', 'section']);
        const render = (withHiding) => wrapPage(`<${container}><h1>标题</h1>${parts.map((part) => part(withHiding)).join('')}</${container}>`);
        return { kind, hasHidden, render };
    };
}

// 固定用例：三处 style 原值进入输出的短输入，若先截短 style 中的连续空白，输出即改变；新实现须与旧链路逐字相同
const fixedCasePage = (inner) => `<html><head><title>T</title></head><body><article><h1>标题</h1><p>${'正文内容足够长。'.repeat(40)}</p>`
    + `${inner}<p>${'第二段同样足够长。'.repeat(40)}</p></article></body></html>`;
const FIXED_CASES = [
    ['svg 子树的 style 原样进入正文', '<svg style="fill:red;   stroke:blue"><text>图</text></svg>', 'style="fill:red;   stroke:blue"'],
    ['noscript 替换时含图片扩展名的 style 复制为 data-old-style', '<div><img style="a.jpg  x"><noscript><img src="b.png" style="a.jpg x"></noscript></div>', 'data-old-style="a.jpg  x"'],
    ['svg 内 img 的 style 经懒加载修正复制进 src', '<svg><img style="a.jpg   "></svg>', 'src="a.jpg   "'],
];

describe('全链路：随机短页面经 extractContent 与替换之前的 Readability 链路逐字等价', () => {
    test('随机短页面差分：Readability 取得结果时二者深相等，否则都落入兜底链路；各分支均有样本', (t) => {
        // Arrange
        const nextPage = createArticlePageGenerator(createSeededRandom(20260926));
        const hits = emptyHits(ARTICLE_BRANCHES);

        for (let index = 0; index < ARTICLE_PAGE_COUNT; index += 1) {
            const page = nextPage();
            const html = page.render(true);

            // Act：参照取自替换之前的链路；新实现每次用新载入的 cheerio 实例
            const expected = legacyExtractByReadability(html);
            const actual = extractContent({ $: cheerio.load(html), html, url: PAGE_URL });

            // Assert：只在不一致时拼装诊断信息
            if (expected) {
                if (!isDeepStrictEqual(actual, expected)) assert.deepEqual(actual, expected, `第 ${index} 份页面：${toVisible(html)}`);
                hits.readability += 1;
                if (/<svg\b[^>]*\sstyle="/.test(expected.html)) hits.svgStyleKept += 1;
                if (expected.html.includes('data-old-')) hits.dataOld += 1;
                if (/<img\b[^>]*\ssrc="lazy-/.test(expected.html)) hits.lazySrc += 1;
            } else {
                if (!actual.extraction.startsWith('fallback:')) {
                    assert.fail(`第 ${index} 份页面：旧链路未取得结果，新实现的 extraction 却为 ${actual.extraction}：${toVisible(html)}`);
                }
                hits.fallback += 1;
            }
            // 覆盖计数：去掉隐藏声明后结果不同，说明该页的隐藏块确实被移除（或使预判判负）
            if (page.hasHidden && !isDeepStrictEqual(legacyExtractByReadability(page.render(false)), expected)) {
                hits[`hidden:${page.kind}`] += 1;
            }
        }

        assertBranchesCovered(t, `随机短页面 ${ARTICLE_PAGE_COUNT} 份`, hits, ARTICLE_BRANCHES);
    });

    for (const [label, inner, fragment] of FIXED_CASES) {
        test(`固定用例：${label}，新旧逐字相同，输出含原样片段 ${fragment}`, () => {
            // Arrange
            const html = fixedCasePage(inner);
            const expected = legacyExtractByReadability(html);
            assert.ok(expected, '旧链路应经 Readability 取得正文');

            // Act
            const actual = extractContent({ $: cheerio.load(html), html, url: PAGE_URL });

            // Assert
            assert.deepEqual(actual, expected);
            assert.ok(actual.html.includes(fragment), `输出应含 ${fragment}：${toVisible(actual.html)}`);
        });
    }
});
