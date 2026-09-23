/**
 * converters/web/frontmatter.js 单元测试
 *
 * 生成侧覆盖：字段顺序固定、缺失字段整条省略、值转义（冒号/引号/换行/特殊起始字符/
 * 控制字符）、数值裸写、finalUrl 仅在与 source 不同时出现、办公文档只写它拥有的字段。
 * 剥离侧覆盖：标准块、CRLF、BOM、缺闭合、注释与非法行、流式与块式数组、引号值，
 * 以及「生成 → 剥离」的往返一致性；键值行识别（matchKeyLine）在冒号后 8 万个空格长段上的耗时上限，
 * 与线性化之前的实现逐字等价（差分）；列表项识别（matchListItem）在短横后 8 万个空格长段上的耗时上限，
 * 与线性化之前的实现逐字等价（差分）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildFrontMatter, prependFrontMatter, stripFrontMatter } = require('../converters/web/frontmatter');

const CONVERTED_AT = '2026-09-03T01:00:00.000Z';
const FULL_META = Object.freeze({
    title: '网页标题',
    author: '张三',
    publishedAt: '2026-01-02T03:04:05.000Z',
    sourceUrl: 'https://example.com/a',
    finalUrl: 'https://example.com/a-final',
    sourceType: 'url',
    siteName: '示例站',
    excerpt: '一句话摘要',
    lang: 'zh-CN',
    wordCount: 1234,
    extraction: 'readability',
    fetchedAt: '2026-09-03T00:00:00.000Z',
});

const keysOf = (yaml) => yaml.split('\n').filter((line) => line.includes(': ')).map((line) => line.split(':')[0]);

// ============================================================
// 生成
// ============================================================

test('字段顺序固定，键序不随 meta 的属性顺序变化', () => {
    // Arrange：把 meta 的属性顺序完全打乱
    const shuffled = Object.fromEntries(Object.entries(FULL_META).reverse());

    // Act
    const yaml = buildFrontMatter(shuffled, { convertedAt: CONVERTED_AT });

    // Assert
    assert.deepEqual(keysOf(yaml), [
        'title', 'author', 'date', 'source', 'finalUrl', 'sourceType',
        'siteName', 'excerpt', 'lang', 'wordCount', 'extraction', 'fetchedAt', 'convertedAt',
    ]);
    assert.ok(yaml.startsWith('---\n') && yaml.endsWith('---\n'));
});

test('缺失字段整条省略，不写空值占位', () => {
    // Act
    const yaml = buildFrontMatter({ title: '只有标题', sourceType: 'url', author: '', excerpt: null }, { convertedAt: CONVERTED_AT });

    // Assert
    assert.deepEqual(keysOf(yaml), ['title', 'sourceType', 'convertedAt']);
    assert.ok(!yaml.includes('author'));
    assert.ok(!yaml.includes('excerpt'));
});

test('办公文档 bundle 只写它拥有的字段', () => {
    // Act
    const yaml = buildFrontMatter({ title: '季度报告', sourceType: 'docx', sourceName: '季度报告.docx' }, { convertedAt: CONVERTED_AT });

    // Assert
    assert.equal(yaml, [
        '---',
        'title: "季度报告"',
        'source: "季度报告.docx"',
        'sourceType: "docx"',
        `convertedAt: "${CONVERTED_AT}"`,
        '---',
        '',
    ].join('\n'));
});

test('finalUrl 仅在与 source 不同时写出', () => {
    // Act
    const differs = buildFrontMatter(FULL_META, { convertedAt: CONVERTED_AT });
    const same = buildFrontMatter({ ...FULL_META, finalUrl: FULL_META.sourceUrl }, { convertedAt: CONVERTED_AT });

    // Assert
    assert.ok(differs.includes('finalUrl: "https://example.com/a-final"'));
    assert.ok(!same.includes('finalUrl'));
});

test('数值字段裸写为数字，字符串字段一律加引号', () => {
    // Act
    const yaml = buildFrontMatter(FULL_META, { convertedAt: CONVERTED_AT });

    // Assert
    assert.ok(yaml.includes('wordCount: 1234'), yaml);
    assert.ok(yaml.includes('title: "网页标题"'), yaml);
});

const ESCAPE_CASES = [
    ['冒号', '标题: 副标题', 'title: "标题: 副标题"'],
    ['双引号', '他说"你好"', 'title: "他说\\"你好\\""'],
    ['反斜杠', 'C:\\path\\to', 'title: "C:\\\\path\\\\to"'],
    ['换行折叠为单行', '第一行\n第二行', 'title: "第一行\\n第二行"'],
    ['制表符', '前\t后', 'title: "前\\t后"'],
    ['以短横线开头', '- 起始', 'title: "- 起始"'],
    ['以井号开头', '#标签', 'title: "#标签"'],
    ['以 at 开头', '@提及', 'title: "@提及"'],
    ['形如布尔值', 'true', 'title: "true"'],
    ['形如数字', '2026', 'title: "2026"'],
];

for (const [name, title, expectedLine] of ESCAPE_CASES) {
    test(`YAML 值转义：${name}`, () => {
        // Act
        const yaml = buildFrontMatter({ title }, { convertedAt: CONVERTED_AT });

        // Assert
        assert.ok(yaml.includes(expectedLine), `期望包含 ${expectedLine}，实际：\n${yaml}`);
        // 转义后整块仍是「三行栅栏 + 键值行」结构，值里的换行不会撑出多余行
        assert.equal(yaml.split('\n').length, 5, yaml);
    });
}

test('控制字符被转义为 \\xNN，不进入产物原文', () => {
    // Act
    const yaml = buildFrontMatter({ title: `前${String.fromCharCode(1)}后` }, { convertedAt: CONVERTED_AT });

    // Assert
    assert.ok(yaml.includes('title: "前\\x01后"'), yaml);
});

test('prependFrontMatter 把头部置于正文之前，两者之间恰有一个空行', () => {
    // Act
    const md = prependFrontMatter('# 正文\n\n段落\n', { title: 'T', sourceType: 'url' }, { convertedAt: CONVERTED_AT });

    // Assert
    assert.match(md, /^---\ntitle: "T"\nsourceType: "url"\nconvertedAt: "[^"]+"\n---\n\n# 正文\n\n段落\n$/);
});

// ============================================================
// 剥离
// ============================================================

test('剥离标准 front matter，正文与键值都正确', () => {
    // Arrange
    const text = '---\ntitle: 我的笔记\ntags: [技术, 笔记]\ndraft: false\ncount: 12\n---\n\n# 正文\n\n段落\n';

    // Act
    const { body, data, found } = stripFrontMatter(text);

    // Assert
    assert.equal(found, true);
    assert.equal(body, '# 正文\n\n段落\n');
    assert.deepEqual(data, { title: '我的笔记', tags: ['技术', '笔记'], draft: false, count: 12 });
});

test('剥离支持块式数组、引号值、注释与非法行', () => {
    // Arrange
    const text = [
        '---',
        '# 这是注释',
        'title: "带: 冒号的标题"',
        "subtitle: '单引号里的 it''s'",
        'tags:',
        '  - 甲',
        '  - 乙',
        '这一行没有冒号，应被忽略',
        'empty:',
        '---',
        '正文',
    ].join('\n');

    // Act
    const { body, data } = stripFrontMatter(text);

    // Assert
    assert.equal(body, '正文');
    assert.deepEqual(data, {
        title: '带: 冒号的标题',
        subtitle: "单引号里的 it's",
        tags: ['甲', '乙'],
        empty: '',
    });
});

test('剥离兼容 CRLF 与 BOM 开头', () => {
    // Arrange
    const bom = String.fromCharCode(0xfeff);
    const text = `${bom}---\r\ntitle: CRLF 标题\r\n---\r\n正文\r\n`;

    // Act
    const { body, data, found } = stripFrontMatter(text);

    // Assert
    assert.equal(found, true);
    assert.equal(data.title, 'CRLF 标题');
    assert.equal(body, '正文\r\n');
});

test('没有闭合栅栏时原样返回，正文开头的分隔线不被误认为 front matter', () => {
    // Arrange
    const text = '---\n\n# 这其实是一条分隔线加正文\n\n段落\n';

    // Act
    const { body, data, found } = stripFrontMatter(text);

    // Assert
    assert.equal(found, false);
    assert.equal(body, text);
    assert.deepEqual(data, {});
});

test('没有 front matter 的文本原样返回', () => {
    // Act
    const { body, data, found } = stripFrontMatter('# 标题\n\n正文\n');

    // Assert
    assert.equal(found, false);
    assert.equal(body, '# 标题\n\n正文\n');
    assert.deepEqual(data, {});
    assert.deepEqual(stripFrontMatter(null), { body: '', data: {}, found: false });
});

// ============================================================
// 往返
// ============================================================

test('生成的 front matter 能被自身的剥离逻辑读回，值不失真', () => {
    // Arrange：标题同时含冒号、引号与换行
    const meta = { ...FULL_META, title: '标题: 含"引号"\n与换行' };

    // Act
    const md = prependFrontMatter('# 正文\n', meta, { convertedAt: CONVERTED_AT });
    const { body, data } = stripFrontMatter(md);

    // Assert
    assert.equal(body, '# 正文\n');
    assert.equal(data.title, '标题: 含"引号"\n与换行');
    assert.equal(data.wordCount, 1234);
    assert.equal(data.source, FULL_META.sourceUrl);
    assert.equal(data.date, FULL_META.publishedAt);
});

// ============================================================
// matchKeyLine：键值行识别线性于串长（耗时上限与逐字等价）
// ============================================================

const { isDeepStrictEqual } = require('node:util');
const { matchKeyLine } = require('../converters/web/frontmatter');

// 不可见字符一律以码点生成，源码里不出现看不见的字面量
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const NO_BREAK_SPACE = String.fromCharCode(0x00a0);

// 耗时用例的输入规模：键值行的冒号之后夹 8 万个半角空格，其后的余下部分「a + CR + b」含行终止符
const KEY_LINE_STRESS_LENGTH = 80000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。200 ms 使两侧余量都不小于 5 倍——
// 线性化之前的 /^([A-Za-z_][\w.-]*)[ \t]*:[ \t]*(.*)$/ 在这一规模上经 stripFrontMatter 实测约 2.0 至 2.1 秒（2 万、4 万时
// 约 0.13、0.53 秒，耗时随段长平方增长），是上限的 10 倍以上；线性化之后单次调用实测约 0.1 毫秒，不到上限的千分之一
const KEY_LINE_STRESS_BUDGET_MS = 200;

const elapsedMsSince = (started) => Number(process.hrtime.bigint() - started) / 1e6;
// 逐码点列出，失败输出里的不可见字符也能看清
const toCodePoints = (text) => Array.from(text, (ch) => ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
// 断言信息用的 JSON：长于 40 个码元的字符串只列长度与首尾 3 字的码点，免得诊断被 8 万字的长串淹没
const toBriefJson = (value) => JSON.stringify(value, (key, item) => (typeof item === 'string' && item.length > 40
    ? `〈长 ${item.length}，首 [${toCodePoints(item.slice(0, 3))}]，末 [${toCodePoints(item.slice(-3))}]〉`
    : item));

test('冒号之后 8 万个空格、余下部分含回车的键值行不触发回溯：单次调用在绝对上限内，输出逐项正确', (t) => {
    // Arrange：在计时区间外新构造字符串。按行切分后只去掉行尾的一个 CR，行中的 CR 原样到达键值行识别
    const input = `---\ntitle: T\nkey:${' '.repeat(KEY_LINE_STRESS_LENGTH)}a\rb\n---\n正文\n`;
    const expected = { body: '正文\n', data: { title: 'T' }, found: true };

    // Act：计时区间只包这一次调用
    const started = process.hrtime.bigint();
    const result = stripFrontMatter(input);
    const elapsedMs = elapsedMsSince(started);
    t.diagnostic(`stripFrontMatter 实测 ${elapsedMs.toFixed(2)} ms`);

    // Assert：先验输出正确，以免「快」来自少做了事——title 照常读出；长键值行的余下部分含 CR，旧式对它整行失配，
    // 该行按非法行忽略、不产出 key
    if (!isDeepStrictEqual(result, expected)) assert.fail(`输出不符：${toBriefJson(result)}`);
    assert.ok(
        elapsedMs < KEY_LINE_STRESS_BUDGET_MS,
        `stripFrontMatter 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${KEY_LINE_STRESS_BUDGET_MS} ms`,
    );
});

// 线性化之前的键值行正则，逐字照录旧文件，仅作短输入的差分参照：冒号之后的空白段一长、余下部分又含行终止符，就会逐位回溯，
// 不可用于耗时用例的输入规模
const LEGACY_KEY_LINE_RE = /^([A-Za-z_][\w.-]*)[ \t]*:[ \t]*(.*)$/;
// 分支归类的独立判据：旧式加 s 标志后 . 也匹配行终止符，(.*)$ 总能吃到串尾，只剩前缀约束——它匹配而旧式不匹配，
// 即前缀相符、余下部分含行终止符
const LEGACY_KEY_LINE_DOTALL_RE = new RegExp(LEGACY_KEY_LINE_RE.source, 's');

// 差分字母表共 18 个记号：旧式空白类 [ \t] 的两个成员；不在其内的 U+3000 与 U+00A0；四个行终止符 LF、CR、U+2028、U+2029；
// 冒号、短横、点号与下划线；字母、数字、双引号、单引号与井号
const LINE_DIFF_ALPHABET = [
    ' ', '\t', IDEOGRAPHIC_SPACE, NO_BREAK_SPACE, '\n', '\r', LINE_SEPARATOR, PARAGRAPH_SEPARATOR,
    ':', '-', '.', '_', 'k', 'Z', '7', '"', "'", '#',
];

// 字母表上由 0 到 maxLength 个记号拼成的全部字符串
function everyStringUpTo(maxLength, alphabet) {
    const all = [''];
    let level = [''];
    for (let length = 1; length <= maxLength; length += 1) {
        level = level.flatMap((prefix) => alphabet.map((token) => prefix + token));
        for (const item of level) all.push(item);
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

// 匹配结果的可读形式：字符串逐码点列出并加方括号，数组逐项如此，null 原样
const describeMatch = (value) => {
    if (Array.isArray(value)) return `(${value.map(describeMatch).join(', ')})`;
    return typeof value === 'string' ? `[${toCodePoints(value)}]` : String(value);
};

test('与线性化之前的键值行正则逐组等价：BMP 逐码元、穷举短串与种子固定的随机串，前缀不符、值非空、值为空、余下部分含行终止符均有样本', (t) => {
    // Arrange：BMP 逐码元 262144 个，每个码元放进下列四个模板。第一个模板里它同时落在键名之后、冒号之后与值中，考察 [\w.-]
    // 与 [ \t]；第二个落在行首，考察键名首字 [A-Za-z_]；第三个落在冒号之后且为行尾，考察冒号后空白、空值与行终止符；
    // 第四个落在值中，考察行终止符集合。新式的任一字符集比旧式多一个或少一个字符都会暴露
    const samples = [];
    for (let code = 0; code <= 0xffff; code += 1) {
        const unit = String.fromCharCode(code);
        samples.push(`k${unit}:${unit}a${unit}b`, `${unit}k:a`, `k:${unit}`, `k:a${unit}b`);
    }
    // 穷举 6175 个：字母表上由 0 到 3 个记号拼成的全部字符串
    const exhaustive = everyStringUpTo(3, LINE_DIFF_ALPHABET);
    assert.equal(exhaustive.length, 6175);
    samples.push(...exhaustive);

    const random = createSeededRandom(20260923);
    const pick = (items) => items[Math.floor(random() * items.length)];
    const randomTokens = (tokens, count) => Array.from({ length: count }, () => pick(tokens)).join('');
    // 一般随机串 30000 个：字母表上 0 到 12 个记号
    for (let i = 0; i < 30000; i += 1) samples.push(randomTokens(LINE_DIFF_ALPHABET, Math.floor(random() * 13)));
    // 结构化随机串 30000 个：键名 + 空白 + 冒号 + 空白 + 值，贴近「title: 标题」一类键值行。键名合法与不合法的都有，
    // 冒号偶尔换成全角冒号或缺失，空白段夹杂 U+3000 与 U+00A0，值取自字母表（含四个行终止符）
    const keyNames = ['title', 'k', '_x', 'a.b-c_d', 'Z9', '1a', '-k', '.k', '键', ''];
    const colons = [':', ':', ':', '：', ''];
    const gap = () => randomTokens([' ', ' ', '\t', IDEOGRAPHIC_SPACE, NO_BREAK_SPACE], Math.floor(random() * 4));
    for (let i = 0; i < 30000; i += 1) {
        samples.push(pick(keyNames) + gap() + pick(colons) + gap() + randomTokens(LINE_DIFF_ALPHABET, Math.floor(random() * 7)));
    }
    assert.equal(samples.length, 328319);

    // Act & Assert
    const hits = { headMismatch: 0, valueFilled: 0, valueEmpty: 0, terminatorInRest: 0 };
    for (const sample of samples) {
        const legacy = LEGACY_KEY_LINE_RE.exec(sample);
        const expected = legacy ? [legacy[1], legacy[2]] : null;
        const actual = matchKeyLine(sample);
        // 只在不一致时拼装诊断信息，免得三十余万次调用都付这笔开销
        if (!isDeepStrictEqual(actual, expected)) {
            assert.fail(`输入 [${toCodePoints(sample)}]；实际 ${describeMatch(actual)}；应为 ${describeMatch(expected)}`);
        }
        // 分支归类只看旧式的结果与测试内的独立判据，不借用新实现的中间结果
        if (legacy) {
            if (legacy[2] === '') hits.valueEmpty += 1;
            else hits.valueFilled += 1;
        } else if (LEGACY_KEY_LINE_DOTALL_RE.test(sample)) {
            hits.terminatorInRest += 1;
        } else {
            hits.headMismatch += 1;
        }
    }
    // 覆盖自证：四个分支都须有样本，差分才不是对某一分支空转
    t.diagnostic(`样本 ${samples.length} 个；前缀不符 ${hits.headMismatch}，匹配且值非空 ${hits.valueFilled}，`
        + `匹配且值为空 ${hits.valueEmpty}，余下部分含行终止符而不匹配 ${hits.terminatorInRest}`);
    assert.ok(hits.headMismatch > 0, '没有前缀不符的样本');
    assert.ok(hits.valueFilled > 0, '没有匹配且值非空的样本');
    assert.ok(hits.valueEmpty > 0, '没有匹配且值为空的样本');
    assert.ok(hits.terminatorInRest > 0, '没有余下部分含行终止符而不匹配的样本');
});

// ============================================================
// matchListItem：列表项识别线性于串长（耗时上限与逐字等价）
// ============================================================

const { matchListItem } = require('../converters/web/frontmatter');

// 耗时用例的输入规模：列表项的短横之后夹 8 万个半角空格，其后的余下部分「a + U+2028 + b」含行终止符
const LIST_ITEM_STRESS_LENGTH = 80000;
// 耗时上限取绝对值而非「新旧耗时之比」，理由见键值行一节。200 ms 使两侧余量都不小于 5 倍——线性化之前的
// /^[ \t]*-[ \t]+(.*)$/ 在这一规模上经 stripFrontMatter 实测约 2.0 至 2.2 秒（2 万、4 万时约 0.13、0.51 秒，耗时随段长平方
// 增长），是上限的 9 倍以上；线性化之后单次调用实测约 0.1 至 0.2 毫秒，不到上限的千分之一
const LIST_ITEM_STRESS_BUDGET_MS = 200;

test('短横之后 8 万个空格、余下部分含 U+2028 的列表项不触发回溯：单次调用在绝对上限内，输出逐项正确', (t) => {
    // Arrange：在计时区间外新构造字符串。按行切分只认 LF，行中的 U+2028 原样到达列表项识别
    const input = `---\ntags:\n-${' '.repeat(LIST_ITEM_STRESS_LENGTH)}a${LINE_SEPARATOR}b\n- c\n---\n正文\n`;
    const expected = { body: '正文\n', data: { tags: ['c'] }, found: true };

    // Act：计时区间只包这一次调用
    const started = process.hrtime.bigint();
    const result = stripFrontMatter(input);
    const elapsedMs = elapsedMsSince(started);
    t.diagnostic(`stripFrontMatter 实测 ${elapsedMs.toFixed(2)} ms`);

    // Assert：先验输出正确，以免「快」来自少做了事——长列表项的余下部分含 U+2028，旧式对它整行失配，该行又不是键值行，
    // 按非法行忽略；其后的「- c」照常收进 tags
    if (!isDeepStrictEqual(result, expected)) assert.fail(`输出不符：${toBriefJson(result)}`);
    assert.ok(
        elapsedMs < LIST_ITEM_STRESS_BUDGET_MS,
        `stripFrontMatter 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${LIST_ITEM_STRESS_BUDGET_MS} ms`,
    );
});

// 线性化之前的列表项正则，逐字照录旧文件，仅作短输入的差分参照：短横之后的空白段一长、余下部分又含行终止符，就会逐位回溯，
// 不可用于耗时用例的输入规模
const LEGACY_LIST_ITEM_RE = /^[ \t]*-[ \t]+(.*)$/;
// 分支归类的独立判据：加 s 标志的旧式只剩前缀约束，它匹配而旧式不匹配即前缀相符、余下部分含行终止符（同键值行一节）；
// 另以「行首空白之后的短横紧跟的不是空格或制表符」（含「--」与行尾的短横）在前缀不符的样本里单列一类
const LEGACY_LIST_ITEM_DOTALL_RE = new RegExp(LEGACY_LIST_ITEM_RE.source, 's');
const LIST_DASH_WITHOUT_BLANK_RE = /^[ \t]*-(?![ \t])/;

test('与线性化之前的列表项正则逐组等价：BMP 逐码元、穷举短串与种子固定的随机串，前缀不符、值非空、值为空、余下部分含行终止符均有样本', (t) => {
    // Arrange：BMP 逐码元 262144 个，每个码元放进下列四个模板。第一个模板里它同时落在短横之后与值中，考察短横后的 [ \t]；
    // 第二个落在行首，考察短横前的 [ \t]；第三个落在「短横 + 空格」之后且为行尾，考察空白的极大延伸、空值与行终止符；
    // 第四个落在值中，考察行终止符集合。新式的任一字符集比旧式多一个或少一个字符都会暴露
    const samples = [];
    for (let code = 0; code <= 0xffff; code += 1) {
        const unit = String.fromCharCode(code);
        samples.push(`-${unit}a${unit}b`, `${unit}- a`, `- ${unit}`, `- a${unit}b`);
    }
    // 穷举 6175 个：沿用键值行一节的字母表，由 0 到 3 个记号拼成的全部字符串
    const exhaustive = everyStringUpTo(3, LINE_DIFF_ALPHABET);
    assert.equal(exhaustive.length, 6175);
    samples.push(...exhaustive);

    const random = createSeededRandom(20260923);
    const pick = (items) => items[Math.floor(random() * items.length)];
    const randomTokens = (tokens, count) => Array.from({ length: count }, () => pick(tokens)).join('');
    // 一般随机串 30000 个：字母表上 0 到 12 个记号
    for (let i = 0; i < 30000; i += 1) samples.push(randomTokens(LINE_DIFF_ALPHABET, Math.floor(random() * 13)));
    // 结构化随机串 30000 个：缩进 + 条目记号 + 空白 + 值，贴近「  - 甲」一类块式数组条目。条目记号以短横为主，夹杂「--」
    // 与其他列表记号；缩进与空白段夹杂 U+3000 与 U+00A0，值取自字母表（含四个行终止符）
    const markers = ['-', '-', '-', '--', '*', '+', ''];
    const gap = () => randomTokens([' ', ' ', '\t', IDEOGRAPHIC_SPACE, NO_BREAK_SPACE], Math.floor(random() * 4));
    for (let i = 0; i < 30000; i += 1) {
        samples.push(gap() + pick(markers) + gap() + randomTokens(LINE_DIFF_ALPHABET, Math.floor(random() * 7)));
    }
    assert.equal(samples.length, 328319);

    // Act & Assert
    const hits = { headMismatch: 0, dashWithoutBlank: 0, valueFilled: 0, valueEmpty: 0, terminatorInRest: 0 };
    for (const sample of samples) {
        const legacy = LEGACY_LIST_ITEM_RE.exec(sample);
        const expected = legacy ? legacy[1] : null;
        const actual = matchListItem(sample);
        // 只在不一致时拼装诊断信息，免得三十余万次调用都付这笔开销
        if (actual !== expected) {
            assert.fail(`输入 [${toCodePoints(sample)}]；实际 ${describeMatch(actual)}；应为 ${describeMatch(expected)}`);
        }
        // 分支归类只看旧式的结果与测试内的独立判据，不借用新实现的中间结果
        if (legacy) {
            if (legacy[1] === '') hits.valueEmpty += 1;
            else hits.valueFilled += 1;
        } else if (LEGACY_LIST_ITEM_DOTALL_RE.test(sample)) {
            hits.terminatorInRest += 1;
        } else {
            hits.headMismatch += 1;
            if (LIST_DASH_WITHOUT_BLANK_RE.test(sample)) hits.dashWithoutBlank += 1;
        }
    }
    // 覆盖自证：四个分支都须有样本，前缀不符之中也须有短横之后缺空白的样本，差分才不是对某一分支空转
    t.diagnostic(`样本 ${samples.length} 个；前缀不符 ${hits.headMismatch}（其中短横之后缺空白 ${hits.dashWithoutBlank}），`
        + `匹配且值非空 ${hits.valueFilled}，匹配且值为空 ${hits.valueEmpty}，余下部分含行终止符而不匹配 ${hits.terminatorInRest}`);
    assert.ok(hits.headMismatch > 0, '没有前缀不符的样本');
    assert.ok(hits.dashWithoutBlank > 0, '前缀不符的样本里没有短横之后缺空白的');
    assert.ok(hits.valueFilled > 0, '没有匹配且值非空的样本');
    assert.ok(hits.valueEmpty > 0, '没有匹配且值为空的样本');
    assert.ok(hits.terminatorInRest > 0, '没有余下部分含行终止符而不匹配的样本');
});
