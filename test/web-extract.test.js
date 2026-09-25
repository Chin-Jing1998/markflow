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
 *       Readability 的懒加载修正 _fixLazyImages 改为照录实现 fixLazyImages，其中判定「属性值为单个图片地址」的正则换成线性的
 *       等价判定 isSingleImageToken：病态属性值（a.jpg 重复后接空格与 b，128 KB）位于正文 <p> 内无 src 的 img、正文中的
 *       figure 与四轮重试的短正文页时，extractContent 全链路在绝对上限内（耗时），且结果与短值页的输出换回长值后逐字相同；
 *       isSingleImageToken 与原正则逐值同真假（随机串与结构化串差分）；fixLazyImages 与库自身的 _fixLazyImages 逐字等价
 *       （随机懒加载元素差分，含 picture、figure 与 svg 内的 img）；随机懒加载页面经 extractContent 与替换之前的 Readability
 *       链路逐字等价（全链路差分，含多轮重试的短正文页）
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');
const cheerio = require('cheerio');
const { parseHTML } = require('linkedom');
const { Readability, isProbablyReaderable } = require('@mozilla/readability');

// 以解构导入：可见性判定的三个导出（第二行）与懒加载修正的两个导出（第三行）在各自修复之前都不存在，此时它们只是 undefined，
// 依赖它们的用例各自报错，不致在导入时整体崩溃
const {
    extractContent, annotateLayout, READERABLE_OPTIONS, MIN_READABILITY_TEXT_LENGTH,
    inlineStyleValue, isNodeVisible, isProbablyVisible,
    isSingleImageToken, fixLazyImages,
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

// ============================================================
// 懒加载修正：病态属性值上 extractContent 全链路线性于页面长度
// ============================================================

// 病态属性值：a.jpg 重复后接空格与 b，共 128 KB（131072 个字符）。首条正则 /\.(jpg|jpeg|png|webp)\s+\d/ 因空格后不是数字而不命中，
// 于是求值决定 copyTo = 'src' 的原正则：它在首段内每一处「.jpg」都让 \S* 吞到段尾、\s* 吞下空格，遇 b 失败后逐位回溯，耗时随长度
// 平方增长。两条正则都不命中，该值原样进入输出；值中含 .jpg，_unwrapNoscriptImages 不删这个没有 src 的 img。参照一侧的
// legacyExtractByReadability 用库缺省的 _fixLazyImages，病态值上同样平方级，故只用于短值页
const LAZY_VALUE_UNIT = 'a.jpg';
const LAZY_VALUE_TAIL = ' b';
const LAZY_VALUE_LENGTH = 128 * 1024;
const longLazyValue = () => LAZY_VALUE_UNIT.repeat((LAZY_VALUE_LENGTH - LAZY_VALUE_TAIL.length) / LAZY_VALUE_UNIT.length)
    + LAZY_VALUE_TAIL;
// 短值页用同一形状只重复一次的值，其原样片段在参照输出中换回长值
const SHORT_LAZY_VALUE = `${LAZY_VALUE_UNIT}${LAZY_VALUE_TAIL}`;
const SHORT_LAZY_ATTRIBUTE = `data-x="${SHORT_LAZY_VALUE}"`;
// 耗时上限同样取绝对值（理由见 LONG_WHITESPACE_BUDGET_MS），300 ms 使两侧余量都不小于 5 倍——未修复的实现在这一规模上，新起进程
// 只跑单个用例各实测 3 次，三例依次约 3.60 至 3.66、3.62 至 3.77、14.3 至 14.9 秒（整份文件运行 3 次时约 3.6 至 3.8、3.6 至 3.8、
// 14.0 至 14.8 秒；四轮重试页的 _fixLazyImages 执行四次），最小值也是上限的 11.9 倍；修复之后单独运行本文件三批各 10 次，三例至多约
// 2.6、1.7、6.0 毫秒，新起进程只跑单个用例各 6 次至多约 3.5、6.4、7.2 毫秒；18 核上三个全量进程并发五轮（与同机其他测试进程并发时）
// 至多约 2.4、2.1、41.8 毫秒（末者为一次离群值，其余 14 次至多 6.6 毫秒），仍不到上限的七分之一
const LAZY_IMAGE_BUDGET_MS = 300;

// 正文 <p> 内无 src 的 img：没有 src 与 srcset，_fixLazyImages 逐个检查它的属性
const lazyImagePage = (value) => wrapPage(
    `<article><h1>标题</h1><p>${LEAD_PARAGRAPH}</p><p>前文<img data-x="${value}">后文。${TAIL_PARAGRAPH}</p></article>`,
);
// 正文中的 figure：linkedom 的 figure 没有 src 与 srcset 取值器，必定逐个检查属性；两条正则都不命中，不新建 img
const lazyFigurePage = (value) => wrapPage(
    `<article><h1>标题</h1><p>${LEAD_PARAGRAPH}</p><figure data-x="${value}"><figcaption>图注</figcaption></figure>`
    + `<p>${TAIL_PARAGRAPH}</p></article>`,
);
// 四轮重试的短正文页：Hello 与 world 之间隔 200 个空格。可读性预判按 trim 后的 210 个字符判为可读；Readability 按压缩空白后的
// 11 个字符计，每轮都不足 charThreshold，逐个去掉三个标志各重试一轮，_grabArticle 共执行四轮，_fixLazyImages 随之执行四次；
// 最终取正文最长的一轮，其 textContent 不压缩空白，达到 MIN_READABILITY_TEXT_LENGTH，extraction 仍为 readability
const lazyRetryPage = (value) => '<!DOCTYPE html><html><head><title>t</title></head><body>'
    + `<p>Hello${' '.repeat(200)}world</p><img data-x="${value}"></body></html>`;
// 三例：名称、页面构造与参照一侧 _fixLazyImages 的执行次数
const LAZY_TIMING_CASES = [
    ['正文 <p> 内无 src 的 img', lazyImagePage, 1],
    ['正文中的 figure', lazyFigurePage, 1],
    ['四轮重试的短正文页', lazyRetryPage, 4],
];

// 统计 run 期间库原型上 _fixLazyImages 的执行次数：临时换成计数包装，用完即恢复。只包住参照链路的调用，extractContent 不受影响
function countLibraryFixLazyImages(run) {
    const original = Readability.prototype._fixLazyImages;
    let calls = 0;
    Readability.prototype._fixLazyImages = function countedFixLazyImages(root) {
        calls += 1;
        return original.call(this, root);
    };
    try {
        const value = run();
        return { value, calls };
    } finally {
        Readability.prototype._fixLazyImages = original;
    }
}

function assertWithinLazyImageBudget(t, elapsedMs) {
    t.diagnostic(`extractContent 实测 ${elapsedMs.toFixed(1)} ms，上限 ${LAZY_IMAGE_BUDGET_MS} ms`);
    assert.ok(
        elapsedMs < LAZY_IMAGE_BUDGET_MS,
        `extractContent 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${LAZY_IMAGE_BUDGET_MS} ms`,
    );
}

// 去掉结果中的两处正文串（html 与 article.content），其余字段留作深比较；article 为 null 时照样保留，差异由深比较报出
const withoutMarkup = ({ article, ...rest }) => ({ ...rest, html: null, article: article && { ...article, content: null } });

describe('懒加载修正：病态属性值上 extractContent 全链路线性于页面长度', () => {
    for (const [label, buildPage, rounds] of LAZY_TIMING_CASES) {
        test(`${label}：data-x 为 ${LAZY_VALUE_LENGTH} 个字符的病态值时，单次调用在绝对上限内，结果与短值页的输出换回长值后逐字相同`, (t) => {
            // Arrange ①：短值页的参照取自替换之前的 Readability 链路，并核对其中 _fixLazyImages 的执行次数；短值片段须恰出现一次，
            // 才能无歧义地换回长值
            const shortHtml = buildPage(SHORT_LAZY_VALUE);
            const { value: expected, calls } = countLibraryFixLazyImages(() => legacyExtractByReadability(shortHtml));
            assert.ok(expected, '短值页应经 Readability 取得正文');
            assert.equal(calls, rounds, `参照一侧 _fixLazyImages 应执行 ${rounds} 次`);
            assert.equal(expected.html.split(SHORT_LAZY_ATTRIBUTE).length - 1, 1, `参照中 ${SHORT_LAZY_ATTRIBUTE} 应恰出现一次`);
            // Arrange ②：在计时区间外新构造长值页
            const value = longLazyValue();
            const html = buildPage(value);

            // Act
            const { result, elapsedMs } = timedExtract(html);

            // Assert：先验结果正确——其余字段深相等，html 与 article.content 等于把参照中那一处短值换回长值后的串
            assert.deepEqual(withoutMarkup(result), withoutMarkup(expected));
            const expectedHtml = expected.html.replace(SHORT_LAZY_ATTRIBUTE, () => `data-x="${value}"`);
            assertSameText(result.html, expectedHtml, 'html');
            assertSameText(result.article.content, expectedHtml, 'article.content');
            assertWithinLazyImageBudget(t, elapsedMs);
        });
    }
});

// ============================================================
// isSingleImageToken：与原正则逐值同真假
// ============================================================

// 差分参照：与 Readability 0.6.0 _fixLazyImages 中决定 copyTo = 'src' 的正则字面量逐字相同，用例先核对库源码中确有此字面量
const SINGLE_IMAGE_TOKEN_RE = /^\s*\S+\.(jpg|jpeg|png|webp)\S*\s*$/;
// 正则空白类的各类成员：空格、制表符、换行、回车、垂直制表符、换页、U+00A0、U+1680、U+2000、U+200A、U+2028、U+2029、U+202F、
// U+205F、U+3000、U+FEFF；以及不属于该类的易混字符 U+180E（蒙古文元音分隔符）与 U+200B（零宽空格）。一律以码点生成
const TOKEN_WHITESPACE = [0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c, 0xa0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]
    .map((code) => String.fromCharCode(code));
const TOKEN_CONFUSABLES = [0x180e, 0x200b].map((code) => String.fromCharCode(code));
// 非空白字符：拼得出四个扩展名的小写字母、点号、大写的 J、P、G 与易混字符
const TOKEN_NON_WHITESPACE = ['a', 'b', 'j', 'p', 'g', 'e', 'n', 'w', '.', 'J', 'P', 'G', ...TOKEN_CONFUSABLES];
const TOKEN_ALPHABET = [...TOKEN_NON_WHITESPACE, ...TOKEN_WHITESPACE];
// 扩展名片段：四个扩展名、大写者，以及近似而不成立者（.jpe、缺点号、.pn）；结构化串另加单个点号、空串与连写
const TOKEN_EXTENSION_PARTS = ['.jpg', '.jpeg', '.png', '.webp', '.JPG', '.jpe', 'jpg', '.pn'];
const STRUCTURED_EXTENSION_PARTS = [...TOKEN_EXTENSION_PARTS, '.', '', '.jpg.png'];
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const RANDOM_TOKEN_COUNT = 200000;
const STRUCTURED_TOKEN_COUNT = 100000;
const IMAGE_TOKEN_BRANCHES = [
    ['matchBare', '原正则为真、无首尾空白'],
    ['matchPadded', '原正则为真、带首尾空白'],
    ['noExtension', '原正则为假：无扩展名'],
    ['extensionAtStart', '原正则为假：扩展名居段首'],
    ['multiSegment', '原正则为假：多段（首段后的空白之后仍有非空白）'],
    ['upperCaseOnly', '原正则为假：扩展名只以大写或大小写混写出现'],
    ['blank', '原正则为假：空串或全空白'],
];
const IMAGE_TOKEN_MATCH_KINDS = new Set(['matchBare', 'matchPadded']);

// 随机串：逐个取片段，四分之一取扩展名片段、五分之一取空白、其余取非空白字符，再截到 0 至 30 的随机长度
function createRandomTokenGenerator(random) {
    const pick = (items) => items[Math.floor(random() * items.length)];
    return () => {
        const length = Math.floor(random() * 31);
        let text = '';
        while (text.length < length) {
            const roll = random();
            if (roll < 0.25) text += pick(TOKEN_EXTENSION_PARTS);
            else if (roll < 0.45) text += pick(TOKEN_WHITESPACE);
            else text += pick(TOKEN_NON_WHITESPACE);
        }
        return text.slice(0, length);
    };
}

// 结构化串：前导空白 + 段 + 扩展名片段 + 段 + 尾随空白，半数另接尾巴（段与空白），十分之一再在首字符之后任一处插入一个空白
function createStructuredTokenGenerator(random) {
    const pick = (items) => items[Math.floor(random() * items.length)];
    const run = (items, max) => Array.from({ length: Math.floor(random() * (max + 1)) }, () => pick(items)).join('');
    return () => {
        let text = run(TOKEN_WHITESPACE, 3) + run(TOKEN_NON_WHITESPACE, 5) + pick(STRUCTURED_EXTENSION_PARTS)
            + run(TOKEN_NON_WHITESPACE, 4) + run(TOKEN_WHITESPACE, 3);
        if (random() < 0.5) text += run(TOKEN_NON_WHITESPACE, 3) + run(TOKEN_WHITESPACE, 2);
        if (random() < 0.1 && text.length > 2) {
            const at = 1 + Math.floor(random() * (text.length - 1));
            text = text.slice(0, at) + pick(TOKEN_WHITESPACE) + text.slice(at);
        }
        return text;
    };
}

// 覆盖归类：只用 trim、indexOf 等字符串运算，不经被测函数，也不用正则。trim 去除的字符集与正则空白类相同，故逐个码元以 trim
// 判空白；原正则为真，当且仅当去掉首尾空白后是单独一段，且下标 1 及之后有小写的「.扩展名」
function classifyImageToken(value) {
    const core = value.trim();
    if (core === '') return 'blank';
    for (let at = 0; at < core.length; at += 1) {
        if (core[at].trim() === '') return 'multiSegment';
    }
    if (IMAGE_EXTENSIONS.some((extension) => core.indexOf(extension, 1) >= 0)) return core === value ? 'matchBare' : 'matchPadded';
    if (IMAGE_EXTENSIONS.some((extension) => core.startsWith(extension))) return 'extensionAtStart';
    if (IMAGE_EXTENSIONS.some((extension) => core.toLowerCase().includes(extension))) return 'upperCaseOnly';
    return 'noExtension';
}

describe('isSingleImageToken：与原正则逐值同真假', () => {
    test('随机串与结构化串差分：与原正则逐值相同，覆盖归类与原正则一致，各分支均有样本，字母表的每个字符都出现过', (t) => {
        // Arrange ①：参照正则即库源码中的字面量；字母表中的空白都属正则空白类，易混字符都不属
        assert.ok(
            Readability.prototype._fixLazyImages.toString().includes(`/${SINGLE_IMAGE_TOKEN_RE.source}/.test(attr.value)`),
            '库源码中应有与参照相同的正则字面量',
        );
        assert.ok(TOKEN_WHITESPACE.every((unit) => /^\s$/.test(unit)), '字母表中的空白应都属正则空白类');
        assert.ok(TOKEN_CONFUSABLES.every((unit) => !/\s/.test(unit)), '易混字符应都不属正则空白类');
        // Arrange ②：两个生成器共用一个固定种子的随机源
        const random = createSeededRandom(20260927);
        const generators = [
            ['随机串', createRandomTokenGenerator(random), RANDOM_TOKEN_COUNT],
            ['结构化串', createStructuredTokenGenerator(random), STRUCTURED_TOKEN_COUNT],
        ];
        const hits = emptyHits(IMAGE_TOKEN_BRANCHES);
        const seen = new Set();

        for (const [source, nextToken, count] of generators) {
            for (let index = 0; index < count; index += 1) {
                const value = nextToken();
                // Act
                const expected = SINGLE_IMAGE_TOKEN_RE.test(value);
                const actual = isSingleImageToken(value);
                // Assert：只在不一致时拼装诊断信息；归类须与原正则的真假一致，分支名才名副其实
                if (actual !== expected) assert.equal(actual, expected, `${source}第 ${index} 个：${toVisible(value)}`);
                const kind = classifyImageToken(value);
                if (IMAGE_TOKEN_MATCH_KINDS.has(kind) !== expected) {
                    assert.fail(`${source}第 ${index} 个归为 ${kind}，与原正则的结果 ${expected} 不符：${toVisible(value)}`);
                }
                hits[kind] += 1;
                for (let at = 0; at < value.length; at += 1) seen.add(value[at]);
            }
        }

        assertBranchesCovered(t, `随机串 ${RANDOM_TOKEN_COUNT} 个、结构化串 ${STRUCTURED_TOKEN_COUNT} 个`, hits, IMAGE_TOKEN_BRANCHES);
        const missing = TOKEN_ALPHABET.filter((unit) => !seen.has(unit));
        assert.equal(missing.length, 0, `字母表中未出现的字符：${missing.map((unit) => toVisible(unit)).join(' ')}`);
    });
});

// ============================================================
// fixLazyImages：与库自身的 _fixLazyImages 逐字等价
// ============================================================

// 覆盖归类用：库中决定 copyTo = 'srcset' 的首条正则（字面量相同），与 SINGLE_IMAGE_TOKEN_RE 合用即库对「属性值会被复制」的判定
const SRCSET_TOKEN_RE = /\.(jpg|jpeg|png|webp)\s+\d/;
const isCopyableValue = (value) => SRCSET_TOKEN_RE.test(value) || SINGLE_IMAGE_TOKEN_RE.test(value);
// 第二个属性循环按名跳过的三个属性
const LOOP_SKIPPED_NAMES = new Set(['src', 'srcset', 'alt']);
const LAZY_ELEMENT_COUNT = 4000;
// 样本元素：img（权重加倍）、picture、figure 与 svg 内的 img
const LAZY_ELEMENT_KINDS = ['img', 'img', 'picture', 'figure', 'svgImg'];
// src 的取法：缺、空串、普通地址、短 base64 占位、长 base64、前缀各处带空格且 BASE64 大写者、MIME 段含 .png 的短 base64（首段
// 循环须按名跳过 src 本身，否则它自己就使 src 可删）、svg 的 data URL
const LAZY_SRC_KINDS = ['none', 'empty', 'url', 'base64Short', 'base64Long', 'base64Spaced', 'base64DottedMime', 'svgData'];
const BASE64_SRC_KINDS = new Set(['base64Short', 'base64Long', 'base64Spaced', 'base64DottedMime']);
const LAZY_ELEMENT_BRANCHES = [
    ['earlyReturn', '提前返回（有 src 或有效 srcset，class 不含 lazy）'],
    ['svgBase64', 'src 为 svg 的 base64 时返回'],
    ['placeholderRemoved', 'base64 占位图的 src 被删'],
    ['base64Kept', 'base64 的 src 保留'],
    ['copiedSrcset', '复制进 srcset'],
    ['copiedSrc', '复制进 src'],
    ['figureCreated', 'figure 新建 img'],
    ['figureHasMedia', 'figure 已含 img 或 picture 而不新建'],
    ['pictureSet', 'picture 直接设置'],
    ['svgImageSet', 'svg 内的 img 被处理'],
    ['altSkipped', 'alt 本可命中而被跳过'],
];

// base64 载荷：库以编码后不足 133 个字符为占位图，长度取阈值两侧的边界值与更远的值
const base64Payload = (length) => 'R0lGODlh'.repeat(Math.ceil(length / 8)).slice(0, length);

function lazySrcOf(kind, pick) {
    switch (kind) {
        case 'none': return null;
        case 'empty': return '';
        case 'url': return 'https://example.com/real.png';
        case 'base64Short': return `data:image/gif;base64,${base64Payload(pick([40, 132]))}`;
        case 'base64Long': return `data:image/png;base64,${base64Payload(pick([133, 200]))}`;
        case 'base64Spaced': return `data: image/png ; BASE64 ,${base64Payload(pick([60, 140]))}`;
        case 'base64DottedMime': return `data:image/x.png;base64,${base64Payload(40)}`;
        default: return `data:image/svg+xml;base64,${base64Payload(pick([40, 200]))}`;
    }
}

// 属性值池：单个地址、带首尾空白的地址、扩展名后紧接数字的地址（首条正则要求扩展名与数字之间至少一个空白，故此值复制进 src 而非
// srcset）、srcset 写法（a.jpg 1x, b.jpg 2x 与同形的带序号地址）、两段（病态值的短形）、扩展名居首、仅大写扩展名、普通文字、空串，
// 以及单个或成串的空白（取自 TOKEN_WHITESPACE）。地址带序号，同一元素上先后复制的值可以区分
function createLazyValueGenerator(random) {
    const pick = (items) => items[Math.floor(random() * items.length)];
    const whitespace = () => Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(TOKEN_WHITESPACE)).join('');
    let serial = 0;
    const address = (extension) => {
        serial += 1;
        return `https://cdn.example.com/p${serial}.${extension}`;
    };
    const makers = [
        () => address(pick(['jpg', 'jpeg', 'png', 'webp'])),
        () => `${whitespace()}${address('png')}${whitespace()}`,
        () => `${address('png')}2`,
        () => 'a.jpg 1x, b.jpg 2x',
        () => `${address('jpg')} 1x, ${address('jpg')} 2x`,
        () => 'a.jpg b',
        () => '.jpg',
        () => 'x.JPG',
        () => '普通文字',
        () => '',
        () => whitespace(),
    ];
    return () => pick(makers)();
}

// 随机懒加载元素：src、srcset、class 与 alt、data-src、data-srcset、data-x、title 各自随机出现，属性次序随机打乱；figure 有时
// 内含 img（带真实 src，自身提前返回）、picture 或图注
function createLazyElementGenerator(random) {
    const pick = (items) => items[Math.floor(random() * items.length)];
    const nextValue = createLazyValueGenerator(random);
    return () => {
        const kind = pick(LAZY_ELEMENT_KINDS);
        const srcKind = pick(LAZY_SRC_KINDS);
        const attributes = [];
        const src = lazySrcOf(srcKind, pick);
        if (src !== null) attributes.push(['src', src]);
        const srcset = pick([null, null, 'null', 'x.jpg 1x']);
        if (srcset !== null) attributes.push(['srcset', srcset]);
        const className = pick([null, null, 'lazy', 'LAZY-load', 'photo']);
        if (className !== null) attributes.push(['class', className]);
        for (const name of ['alt', 'data-src', 'data-srcset', 'data-x', 'title']) {
            if (random() < 0.35) attributes.push([name, nextValue()]);
        }
        for (let at = attributes.length - 1; at > 0; at -= 1) {
            const other = Math.floor(random() * (at + 1));
            [attributes[at], attributes[other]] = [attributes[other], attributes[at]];
        }
        const markup = attributes.map(([name, value]) => ` ${name}="${value}"`).join('');
        let html;
        if (kind === 'img') html = `<img${markup}>`;
        else if (kind === 'picture') html = `<picture${markup}></picture>`;
        else if (kind === 'figure') {
            const inner = pick(['', '<figcaption>图注</figcaption>', '<img src="https://example.com/inner.png">', '<picture></picture>']);
            html = `<figure${markup}>${inner}</figure>`;
        } else html = `<svg><img${markup}></svg>`;
        return { kind, srcKind, html };
    };
}

// 样本元素当时的属性表与 img、picture 后代数：svg 样本取 svg 内的 img，其余取容器的首个子元素
function snapshotLazySample(container, kind) {
    const element = kind === 'svgImg' ? container.firstElementChild.firstElementChild : container.firstElementChild;
    return {
        attributes: new Map(Array.from(element.attributes, (attr) => [attr.name, attr.value])),
        media: element.querySelectorAll('img, picture').length,
    };
}

const sameAttributeMaps = (left, right) => left.size === right.size
    && Array.from(left).every(([name, value]) => right.get(name) === value);

// 覆盖归类：只看输入的属性与参照输出相对输入的差异，不插桩被测函数。第二个循环只写不删，故参照输出缺 src 即首段删去了它；提前
// 返回的条件按首段之后的状态、照库的表达式求值，只在 src 与 srcset 都未被复制时成立
function noteLazyElementBranches({ kind, srcKind }, before, after, hits) {
    const srcBefore = before.attributes.get('src');
    const srcAfter = after.attributes.get('src');
    const srcsetBefore = before.attributes.get('srcset');
    const copiedSrc = srcAfter !== undefined && srcAfter !== srcBefore;
    const copiedSrcset = after.attributes.get('srcset') !== srcsetBefore;
    const returnedOnSvg = kind === 'img' && srcKind === 'svgData';
    const srcState = srcAfter === undefined ? '' : srcAfter;
    const lazy = (before.attributes.get('class') || '').toLowerCase().includes('lazy');
    const earlyReturn = kind === 'img' && !returnedOnSvg && !copiedSrc && !copiedSrcset
        && Boolean((srcState || (srcsetBefore && srcsetBefore !== 'null')) && !lazy);
    const enteredLoop = !returnedOnSvg && !earlyReturn;
    const copyableOther = Array.from(before.attributes)
        .some(([name, value]) => !LOOP_SKIPPED_NAMES.has(name) && isCopyableValue(value));

    if (earlyReturn) hits.earlyReturn += 1;
    if (returnedOnSvg && sameAttributeMaps(before.attributes, after.attributes)) hits.svgBase64 += 1;
    if (kind === 'img' && BASE64_SRC_KINDS.has(srcKind)) {
        if (srcAfter === undefined) hits.placeholderRemoved += 1;
        else if (srcAfter === srcBefore) hits.base64Kept += 1;
    }
    if (kind !== 'figure' && copiedSrcset) hits.copiedSrcset += 1;
    if (kind !== 'figure' && copiedSrc) hits.copiedSrc += 1;
    if (kind === 'picture' && (copiedSrc || copiedSrcset)) hits.pictureSet += 1;
    if (kind === 'svgImg' && (copiedSrc || copiedSrcset)) hits.svgImageSet += 1;
    if (kind === 'figure' && after.media > before.media) hits.figureCreated += 1;
    if (kind === 'figure' && before.media > 0 && copyableOther && after.media === before.media) hits.figureHasMedia += 1;
    // alt 的值本可复制、别的属性都不可复制，而元素进入了第二个循环：若不跳过 alt，其值必写进 src 或 srcset（figure 则新建 img）
    const alt = before.attributes.get('alt');
    if (enteredLoop && alt !== undefined && isCopyableValue(alt) && !copyableOther) {
        const skipped = kind === 'figure'
            ? before.media === 0 && after.media === 0
            : after.attributes.get(SRCSET_TOKEN_RE.test(alt) ? 'srcset' : 'src') !== alt;
        if (skipped) hits.altSkipped += 1;
    }
}

describe('fixLazyImages：与库自身的 _fixLazyImages 逐字等价', () => {
    test('随机懒加载元素差分：同一 HTML 解析两份，分别经库实现与照录实现，序列化结果逐字相同，各分支均有样本', (t) => {
        // Arrange：每个样本各占一个 <div>，比对与归类都按下标对应；两份文档各配一个 Readability 实例作 this
        const nextElement = createLazyElementGenerator(createSeededRandom(20260928));
        const samples = Array.from({ length: LAZY_ELEMENT_COUNT }, () => nextElement());
        const html = wrapPage(samples.map((sample) => `<div>${sample.html}</div>`).join(''));
        const { document: expectedDocument } = parseHTML(html);
        const { document: actualDocument } = parseHTML(html);
        const containersOf = (document) => Array.from(document.body.children);
        const before = containersOf(expectedDocument).map((container, index) => snapshotLazySample(container, samples[index].kind));

        // Act
        Readability.prototype._fixLazyImages.call(new Readability(expectedDocument), expectedDocument.body);
        fixLazyImages.call(new Readability(actualDocument), actualDocument.body);

        // Assert ①：整份文档的序列化逐字相同；不同时报出首个不同的样本
        if (actualDocument.toString() !== expectedDocument.toString()) {
            const expectedContainers = containersOf(expectedDocument);
            const actualContainers = containersOf(actualDocument);
            const at = expectedContainers.findIndex((container, index) => String(container) !== String(actualContainers[index]));
            if (at < 0) assert.fail('序列化结果不同，但各样本容器逐个相同');
            assert.fail(`第 ${at} 个样本不同：输入 ${toVisible(samples[at].html)}，库实现 ${toVisible(String(expectedContainers[at]))}，`
                + `照录实现 ${toVisible(String(actualContainers[at]))}`);
        }
        // Assert ②：覆盖归类
        const hits = emptyHits(LAZY_ELEMENT_BRANCHES);
        containersOf(expectedDocument).forEach((container, index) => {
            noteLazyElementBranches(samples[index], before[index], snapshotLazySample(container, samples[index].kind), hits);
        });
        assertBranchesCovered(t, `随机懒加载元素 ${LAZY_ELEMENT_COUNT} 个`, hits, LAZY_ELEMENT_BRANCHES);
    });
});

// ============================================================
// 全链路：随机懒加载页面经 extractContent 与替换之前的 Readability 链路逐字等价
// ============================================================

const LAZY_PAGE_COUNT = 1000;
const LAZY_PAGE_BRANCHES = [
    ['readability', 'Readability 取得结果'],
    ['fallback', '落入兜底链路'],
    ['copiedSrc', '输出含从 data-* 复制出的 src'],
    ['copiedSrcset', '输出含复制出的 srcset'],
    ['figureImg', '输出含 figure 新建的 img'],
    ['multiRound', '参照一侧 _fixLazyImages 执行两次以上'],
    ['multiRoundReadability', '多轮重试后 Readability 取得结果'],
];
// 输出中据主机名认出复制结果：img、picture 与 svg 内 img 的懒加载值以 lazy.example.com 为主机，figure 的以 fig.example.com 为
// 主机；页面中的 src 与 srcset 从不直接写这两个主机
const COPIED_SRC_RE = /\ssrc="[^"]*lazy\.example\.com\//;
const COPIED_SRCSET_RE = /\ssrcset="[^"]*lazy\.example\.com\//;
const FIGURE_IMAGE_RE = /<img\b[^>]*\ssrc(?:set)?="[^"]*fig\.example\.com\//;

// 随机懒加载页面：约三成是短正文页，Hello 与 world 之间隔 0 至 260 个空格——超过 140 个时预判为可读，Readability 按压缩空白后的
// 长度计而每轮都不足 charThreshold，重试四轮；超过 189 个时 textContent 达到 MIN_READABILITY_TEXT_LENGTH 而取得结果，否则落入
// 兜底。其余是段落与懒加载元素交错的文章页
function createLazyPageGenerator(random) {
    const pick = (items) => items[Math.floor(random() * items.length)];
    const upTo = (max) => Math.floor(random() * (max + 1));
    let serial = 0;
    const address = (host, extension) => {
        serial += 1;
        return `https://${host}.example.com/${serial}.${extension}`;
    };
    const lazyValue = (host) => pick([
        () => address(host, pick(['jpg', 'jpeg', 'png', 'webp'])),
        () => `${pick(TOKEN_WHITESPACE)}${address(host, 'jpg')}${pick(TOKEN_WHITESPACE)}`,
        () => `${address(host, 'jpg')} 1x, ${address(host, 'png')} 2x`,
        () => 'a.jpg b',
        () => 'x.JPG',
        () => '说明文字',
    ])();
    // 一至两个懒加载属性，属性名互不相同
    const lazyAttributes = (host) => {
        const names = ['data-src', 'data-srcset', 'data-original'];
        let markup = '';
        for (let count = 1 + upTo(1); count > 0; count -= 1) {
            const [name] = names.splice(Math.floor(random() * names.length), 1);
            markup += ` ${name}="${lazyValue(host)}"`;
        }
        return markup;
    };
    // 懒加载元素：img 的五种开头（无 src；lazy 类加占位 src；base64 占位图；srcset 为 "null"；已有真实 src 而提前返回），figure
    // （空、带图注或已含 img），picture 与 svg 内的 img
    const media = () => {
        const roll = random();
        if (roll < 0.45) {
            const lead = pick([
                '', ' class="lazy" src="https://example.com/placeholder.gif"', ` src="data:image/gif;base64,${base64Payload(40)}"`,
                ' srcset="null"', ' src="https://example.com/real.png"',
            ]);
            return `<img${lead}${lazyAttributes('lazy')}>`;
        }
        if (roll < 0.7) {
            const inner = pick(['', '<figcaption>图注</figcaption>', '<img src="https://example.com/inner.png">']);
            return `<figure${lazyAttributes('fig')}>${inner}</figure>`;
        }
        if (roll < 0.85) return `<picture${lazyAttributes('lazy')}></picture>`;
        return `<svg><img${lazyAttributes('lazy')}></svg>`;
    };
    const paragraph = () => `<p>${Array.from({ length: 4 + upTo(4) }, () => pick(ARTICLE_SENTENCES)).join('')}</p>`;
    return () => {
        if (random() < 0.3) {
            const extra = random() < 0.5 ? media() : '';
            return '<!DOCTYPE html><html><head><title>t</title></head><body>'
                + `<p>Hello${' '.repeat(upTo(260))}world</p>${media()}${extra}</body></html>`;
        }
        const parts = Array.from({ length: 2 + upTo(4) }, () => (random() < 0.5 ? paragraph() : media()));
        const container = pick(['article', 'div', 'section']);
        return wrapPage(`<${container}><h1>标题</h1>${parts.join('')}</${container}>`);
    };
}

describe('全链路：随机懒加载页面经 extractContent 与替换之前的 Readability 链路逐字等价', () => {
    test('随机懒加载页面差分：Readability 取得结果时二者深相等，否则都落入兜底链路；各分支均有样本', (t) => {
        // Arrange
        const nextPage = createLazyPageGenerator(createSeededRandom(20260929));
        const hits = emptyHits(LAZY_PAGE_BRANCHES);

        for (let index = 0; index < LAZY_PAGE_COUNT; index += 1) {
            const html = nextPage();

            // Act：参照取自替换之前的链路，并记下其中 _fixLazyImages 的执行次数；新实现每次用新载入的 cheerio 实例
            const { value: expected, calls } = countLibraryFixLazyImages(() => legacyExtractByReadability(html));
            const actual = extractContent({ $: cheerio.load(html), html, url: PAGE_URL });

            // Assert：只在不一致时拼装诊断信息
            if (expected) {
                if (!isDeepStrictEqual(actual, expected)) assert.deepEqual(actual, expected, `第 ${index} 份页面：${toVisible(html)}`);
                hits.readability += 1;
                if (COPIED_SRC_RE.test(expected.html)) hits.copiedSrc += 1;
                if (COPIED_SRCSET_RE.test(expected.html)) hits.copiedSrcset += 1;
                if (FIGURE_IMAGE_RE.test(expected.html)) hits.figureImg += 1;
                if (calls >= 2) hits.multiRoundReadability += 1;
            } else {
                if (!actual.extraction.startsWith('fallback:')) {
                    assert.fail(`第 ${index} 份页面：旧链路未取得结果，新实现的 extraction 却为 ${actual.extraction}：${toVisible(html)}`);
                }
                hits.fallback += 1;
            }
            if (calls >= 2) hits.multiRound += 1;
        }

        assertBranchesCovered(t, `随机懒加载页面 ${LAZY_PAGE_COUNT} 份`, hits, LAZY_PAGE_BRANCHES);
    });
});
