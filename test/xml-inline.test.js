/**
 * converters/renderers/xml/inline.js 单元测试
 * 覆盖：superscript / subscript 节点摊平为 sup / sub 标记，与 b / i / u 嵌套时按 MARK_ORDER 出元素；
 *       残留的 <sup>/<sub> html 节点（未被 ir/inline-html 提升时的兜底）同样还原；
 *       p 与 claim-text 两种语境下的输出形态一致；
 *       trimRuns 尾部空白修剪在 8 万个全角空格长段上的耗时上限，与线性化之前的实现逐字等价（差分）；
 *       flattenInline 的软换行合并（joinSoftBreaks）在 8 万个不以换行结尾的 ASCII 空格长段上的耗时上限，
 *       与改为自换行起匹配之前的实现逐字等价（差分，BMP 逐码元与随机串，各分支设命中计数）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { flattenInline, emitRuns } = require('../converters/renderers/xml/inline');
const { el, serialize } = require('../converters/renderers/xml/builder');

const text = (value) => ({ type: 'text', value });
const node = (type, children) => ({ type, children });

/** 行内子节点 → 指定容器元素的 XML 字符串（indent 0：整体单行，便于逐字比对） */
function renderInline(children, name = 'p') {
    return serialize(el(name, {}, emitRuns(flattenInline(children), el)), { indent: 0 });
}

test('superscript / subscript 节点输出 sup / sub 元素，p 与 claim-text 语境一致', () => {
    // Arrange：C₁~C₃₀ 的烷基；R² 基团
    const children = [
        text('C'), node('subscript', [text('1')]), text('~C'), node('subscript', [text('30')]),
        text('的烷基，R'), node('superscript', [text('2')]), text('基团'),
    ];

    // Act
    const asParagraph = renderInline(children, 'p');
    const asClaimText = renderInline(children, 'claim-text');

    // Assert
    const inner = 'C<sub>1</sub>~C<sub>30</sub>的烷基，R<sup>2</sup>基团';
    assert.equal(asParagraph, `<p>${inner}</p>`);
    assert.equal(asClaimText, `<claim-text>${inner}</claim-text>`);
});

test('上下标与加粗、斜体、下划线嵌套时按 b → i → u → sup → sub 的次序出元素', () => {
    // Arrange
    const children = [node('strong', [node('underline', [node('subscript', [text('甲')])])])];

    // Act
    const xml = renderInline(children);

    // Assert
    assert.equal(xml, '<p><b><u><sub>甲</sub></u></b></p>');
});

test('相邻同标记片段合并，标记不外溢到其后的普通文本', () => {
    // Arrange
    const children = [
        node('superscript', [text('1')]), node('superscript', [text('2')]), text('尾'),
    ];

    // Act
    const xml = renderInline(children);

    // Assert
    assert.equal(xml, '<p><sup>12</sup>尾</p>');
});

test('未被提升的 <sup>/<sub> html 节点仍按开闭标记还原（兜底路径）', () => {
    // Arrange：ir/inline-html 未提升时，mdast 中上下标是成对的 html 节点
    const children = [
        text('C'), { type: 'html', value: '<sub>' }, text('1'), { type: 'html', value: '</sub>' }, text('烷基'),
    ];

    // Act
    const xml = renderInline(children);

    // Assert
    assert.equal(xml, '<p>C<sub>1</sub>烷基</p>');
});

// ============================================================
// trimRuns：尾部空白修剪线性于串长（耗时上限与逐字等价）
// ============================================================

const { trimRuns, textRun } = require('../converters/renderers/xml/inline');

// 不可见字符一律以码点生成，源码里不出现看不见的字面量
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
// 耗时用例的输入规模：a 与 b 之间夹 8 万个全角空格（U+3000），这一长段不处于串尾。取全角空格而非 ASCII 空格，
// 是因为网页路径上 flattenInline 的软换行合并（SOFT_BREAK_RE）只认空格与制表符，全角空格段原样到达 trimRuns；
// 用例直接调用 trimRuns，与软换行合并隔离
const TRAILING_STRESS_LENGTH = 80000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。200 ms 使两侧余量都不小于 5 倍——
// 旧式 /\s+$/ 在这一规模上实测约 3.2 至 4.4 秒（全角空格比 ASCII 空格慢，后者约 1.8 秒；耗时随段长平方增长），
// 是上限的 15 倍以上；改用 trimEnd 之后单次调用至多约 0.2 毫秒，不到上限的千分之一
const TRAILING_STRESS_BUDGET_MS = 200;

const elapsedMsSince = (started) => Number(process.hrtime.bigint() - started) / 1e6;
// 码点序列形式的片段文字，失败输出里的不可见字符也能看清
const toCodePoints = (value) => Array.from(value, (ch) => ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');

test('末个文本片段里夹在可见字符之间的 8 万个全角空格不触发回溯：单次调用在绝对上限内，输出逐项正确', (t) => {
    // Arrange：在计时区间外新构造字符串与片段列表——首个文本片段带前导空白，末个文本片段带尾随空白，其后是软换行
    const runs = [
        textRun(`${IDEOGRAPHIC_SPACE}甲`, ['b']),
        textRun(`a${IDEOGRAPHIC_SPACE.repeat(TRAILING_STRESS_LENGTH)}b${IDEOGRAPHIC_SPACE}`, []),
        { kind: 'br' },
    ];
    const expectedLast = `a${IDEOGRAPHIC_SPACE.repeat(TRAILING_STRESS_LENGTH)}b`;

    // Act：计时区间只包这一次调用
    const started = process.hrtime.bigint();
    const result = trimRuns(runs);
    const elapsedMs = elapsedMsSince(started);
    t.diagnostic(`trimRuns 实测 ${elapsedMs.toFixed(2)} ms`);

    // Assert：先验输出正确，以免「快」来自少做了事——首个片段去掉前导空白，末个文本片段只去掉串尾的一个全角空格、
    // 中段原样保留，其后的软换行删去。末个片段长达 8 万字，不一致时只报长度与末 3 字的码点
    assert.equal(result.length, 2);
    assert.deepEqual([result[0].kind, result[0].text, [...result[0].marks]], ['text', '甲', ['b']]);
    const last = result[1];
    assert.ok(last.kind === 'text' && last.text === expectedLast && last.marks.size === 0,
        `末个片段不符：kind ${last.kind}，长度 ${String(last.text).length}（应为 ${expectedLast.length}），`
        + `末 3 字 [${toCodePoints(String(last.text).slice(-3))}]，标记 ${JSON.stringify([...(last.marks || [])])}`);
    assert.ok(
        elapsedMs < TRAILING_STRESS_BUDGET_MS,
        `trimRuns 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${TRAILING_STRESS_BUDGET_MS} ms`,
    );
});

// 改用 trimEnd 之前的实现，仅作短输入的差分参照：末个文本片段一步的 /\s+$/ 在不处于串尾的长空白段上逐位回溯，不可用于
// 耗时用例的输入规模。函数体照录旧文件，只在末个文本片段一步记下确实删去字符的样本数，供差分用例自证没有空转；
// textRun 未改动，直接取模块导出
function legacyTrimRuns(runs, hits) {
    let list = runs.map((run) => (run.kind === 'text' ? textRun(run.text, run.marks) : run));
    const first = list.findIndex((run) => run.kind === 'text');
    if (first >= 0) list[first] = textRun(list[first].text.replace(/^\s+/, ''), list[first].marks);
    for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].kind === 'text') {
            const trimmed = list[i].text.replace(/\s+$/, '');
            if (trimmed !== list[i].text) {
                hits.trailing += 1;
                if (i !== first) hits.trailingNotFirst += 1;
            }
            list[i] = textRun(trimmed, list[i].marks);
            break;
        }
    }
    list = list.filter((run) => !(run.kind === 'text' && run.text === ''));
    while (list.length && list[0].kind === 'br') list = list.slice(1);
    while (list.length && list[list.length - 1].kind === 'br') list = list.slice(0, -1);
    return list;
}

// 两份片段列表逐项比较：kind 须相同；文本片段再比 text 与标记集，其余片段须为同一对象（trimRuns 原样放行非文本片段）
function sameRuns(actual, expected) {
    return actual.length === expected.length && actual.every((run, index) => {
        const other = expected[index];
        if (run.kind !== other.kind) return false;
        if (run.kind !== 'text') return run === other;
        return run.text === other.text && run.marks.size === other.marks.size && [...run.marks].every((mark) => other.marks.has(mark));
    });
}

// 片段列表的可读形式：文本片段列出码点与标记，其余片段只列 kind
const describeRuns = (runs) => runs.map((run) => (run.kind === 'text'
    ? `text[${toCodePoints(run.text)}]{${[...run.marks].join(',')}}`
    : run.kind)).join(' | ');

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

test('与改用 trimEnd 之前的实现逐项等价：BMP 逐码元与种子固定的随机片段列表，尾部修剪均有样本确实删去字符', (t) => {
    // Arrange：本机 \s 的全部成员在测试内遍历 BMP 求得；另加看似空白而不属 \s 的 U+0085、U+180E、U+200B 作对照
    const spaces = [];
    for (let code = 0; code <= 0xffff; code += 1) {
        if (/\s/.test(String.fromCharCode(code))) spaces.push(String.fromCharCode(code));
    }
    const lookalikes = [0x85, 0x180e, 0x200b].map((code) => String.fromCharCode(code));
    const alphabet = [...spaces, 'a', '文', ...lookalikes];
    const marks = ['b', 'i', 'u', 'sup', 'sub'];

    // BMP 逐码元 65536 个：每个码元放在首个文本片段的串首、末个文本片段的串尾，trimEnd 与 \s 的字符集多一个或少一个都会暴露
    const samples = [];
    for (let code = 0; code <= 0xffff; code += 1) {
        const unit = String.fromCharCode(code);
        samples.push([textRun(`${unit}甲`, ['b']), { kind: 'br' }, textRun(`a${unit}${unit}`, [])]);
    }
    // 随机片段列表 60000 个：0 到 6 个片段；文本片段约占一半（0 到 6 个字符，各标记以 0.3 的概率带上），
    // 其余为软换行，以及图片、公式与已构造节点三类原样放行的片段
    const random = createSeededRandom(20260923);
    const pick = (items) => items[Math.floor(random() * items.length)];
    const randomRun = () => {
        const roll = random();
        if (roll < 0.5) {
            const chars = Array.from({ length: Math.floor(random() * 7) }, () => pick(alphabet)).join('');
            return textRun(chars, marks.filter(() => random() < 0.3));
        }
        if (roll < 0.75) return { kind: 'br' };
        return { kind: pick(['image', 'math', 'element']), node: {} };
    };
    for (let i = 0; i < 60000; i += 1) samples.push(Array.from({ length: Math.floor(random() * 7) }, randomRun));
    assert.equal(samples.length, 125536);

    // Act & Assert
    const hits = { trailing: 0, trailingNotFirst: 0 };
    for (const runs of samples) {
        const expected = legacyTrimRuns(runs, hits);
        const actual = trimRuns(runs);
        // 只在不一致时拼装诊断信息，免得十余万次调用都付这笔开销
        if (!sameRuns(actual, expected)) {
            assert.fail(`输入 ${describeRuns(runs)}；实际 ${describeRuns(actual)}；应为 ${describeRuns(expected)}`);
        }
    }
    // 覆盖自证：末个文本片段的尾部修剪须有样本确实删去字符，且其中须有末个文本片段不是首个文本片段的样本
    // （二者为同一片段时，前导修剪先行，尾部修剪面对的是已去掉前导空白的文字），差分才不是空转
    t.diagnostic(`本机 \\s 成员 ${spaces.length} 个；样本 ${samples.length} 个；尾部修剪删去字符的样本数 ${hits.trailing}，`
        + `其中末个文本片段不是首个文本片段的 ${hits.trailingNotFirst}`);
    assert.ok(hits.trailing > 0, '尾部修剪没有样本删去字符');
    assert.ok(hits.trailingNotFirst > 0, '末个文本片段不是首个文本片段时，尾部修剪没有样本删去字符');
});

// ============================================================
// joinSoftBreaks：软换行合并线性于串长（耗时上限与逐字等价）
// ============================================================

const { runsText } = require('../converters/renderers/xml/inline');

const NO_BREAK_SPACE = String.fromCharCode(0x00a0);
// 耗时用例的输入规模：两个各 8 万字的长段。其一是夹在 a 与 b 之间的 ASCII 空格段，其后不是换行——旧式正则的前导 [ \t]*
// 从段内每个起点都吞到段尾，再因缺换行逐位回退而失败，耗时随段长平方增长；其二是空格与制表符交替、以换行结尾的长段，
// 须经向前回看整段并入软换行，连同换行只剩一个空格。md 输入里段落正文的 ASCII 空格原样进入 text 节点，经 flattenInline
// 送到软换行合并（网页路径上的 ASCII 空格已被 turndown 折叠），用例即经这一导出入口调用
const SOFT_BREAK_STRESS_LENGTH = 80000;
// 耗时上限取绝对值，理由同上。200 ms 使两侧余量都不小于 5 倍——旧式 /[ \t]*\n[ \t]*/g 在这一规模上实测约 2.7 秒
// （flattenInline 处理 'a' + n 个空格 + 'b'，n 为 2 万、4 万、8 万时依次约 0.17、0.67、2.7 秒），是上限的 13 倍以上；
// 改为自换行起匹配、向前回看并入之后单次调用至多约 0.7 毫秒，不到上限的百分之一
const SOFT_BREAK_STRESS_BUDGET_MS = 200;

test('text 节点里 8 万个不以换行结尾的 ASCII 空格不触发回溯：软换行合并单次调用在绝对上限内，输出逐字正确', (t) => {
    // Arrange：在计时区间外新构造字符串（V8 对同一字符串与同一全局正则的匹配结果有缓存，复用会测到缓存）。
    // 两个汉字之间的软换行删除；空格与制表符交替的长段连同其后的换行、制表符换成一个空格
    const longSpaces = ' '.repeat(SOFT_BREAK_STRESS_LENGTH);
    const children = [text(`甲\n乙a${longSpaces}b${' \t'.repeat(SOFT_BREAK_STRESS_LENGTH / 2)}\n\tc`)];
    const expected = `甲乙a${longSpaces}b c`;

    // Act：计时区间只包这一次调用
    const started = process.hrtime.bigint();
    const result = flattenInline(children);
    const elapsedMs = elapsedMsSince(started);
    t.diagnostic(`flattenInline 实测 ${elapsedMs.toFixed(2)} ms`);

    // Assert：先验输出正确，以免「快」来自少做了事。片段长达 8 万余字，不一致时只报长度与首末各 4 字的码点
    const [first] = result;
    const firstText = first && first.kind === 'text' ? first.text : '';
    assert.ok(result.length === 1 && first.kind === 'text' && first.text === expected && first.marks.size === 0,
        `输出不符：片段 ${result.length} 个，首个 kind ${first && first.kind}，长度 ${firstText.length}（应为 ${expected.length}），`
        + `首 4 字 [${toCodePoints(firstText.slice(0, 4))}]，末 4 字 [${toCodePoints(firstText.slice(-4))}]，`
        + `标记 ${JSON.stringify(first && first.marks ? [...first.marks] : null)}`);
    assert.ok(
        elapsedMs < SOFT_BREAK_STRESS_BUDGET_MS,
        `flattenInline 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${SOFT_BREAK_STRESS_BUDGET_MS} ms`,
    );
});

// 改为自换行起匹配之前的实现，仅作短输入的差分参照：正则的前导 [ \t]* 在不以换行结尾的长空格制表符段上逐位回溯，
// 不可用于耗时用例的输入规模。正则、回调与 CJK_RE 的构造照录旧文件，只在回调里记下本段命中的分支，供差分用例自证没有空转
const LEGACY_SOFT_BREAK_RE = /[ \t]*\n[ \t]*/g;
const LEGACY_CJK_RANGES = Object.freeze([[0x2E80, 0x2FFF], [0x3000, 0x303F], [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xF900, 0xFAFF], [0xFF00, 0xFFEF]]);
const LEGACY_CJK_RE = new RegExp(`[${LEGACY_CJK_RANGES.map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('')}]`);

function legacyJoinSoftBreaks(value, seen) {
    let segments = 0;
    let previousEnd = 0;
    return String(value == null ? '' : value).replace(LEGACY_SOFT_BREAK_RE, (match, offset, whole) => {
        const before = whole[offset - 1] || '';
        const after = whole[offset + match.length] || '';
        segments += 1;
        recordSoftBreakBranches(seen, { match, offset, whole, before, after, previousEnd, segments });
        previousEnd = offset + match.length;
        return LEGACY_CJK_RE.test(before) && LEGACY_CJK_RE.test(after) ? '' : ' ';
    });
}

// 差分用例须有样本命中的分支（键 → 失败信息与诊断输出里的说明）
const SOFT_BREAK_BRANCHES = Object.freeze({
    lookbackMerged: '换行前的空格制表符经回看并入',
    lookbackStopped: '回看止于上一段结束位置（其前一位是空格或制表符）',
    noLookback: '无回看（换行前一位不是空格制表符，或段起于串首）',
    deleted: '两侧皆为汉字或全角标点而删除',
    oneSideCjk: '仅一侧为汉字或全角标点而换成空格',
    neitherCjk: '两侧都不是汉字或全角标点而换成空格',
    atStart: '段起于串首',
    atEnd: '段止于串尾',
    crBefore: '段前一位是回车',
    crAfter: '段后一位是回车',
    ideographicSpaceSide: '段的一侧是 U+3000',
    noBreakSpaceSide: '段的一侧是 U+00A0',
    multiSegment: '同一串含多段',
});

const isSpaceOrTab = (ch) => ch === ' ' || ch === '\t';

// 记下一段软换行命中的分支。回看三类互斥：段首是空格制表符即有回看并入；段首是换行而其前一位是空格制表符时，那一位
// 必已归上一段——旧正则的前导 [ \t]* 是极大匹配，那一位若未归上一段就会并进本段——这正是新写法的回看须在上一段结束
// 位置止步的情形
function recordSoftBreakBranches(seen, { match, offset, whole, before, after, previousEnd, segments }) {
    if (isSpaceOrTab(match[0])) seen.add('lookbackMerged');
    else if (offset > 0 && offset === previousEnd && isSpaceOrTab(whole[offset - 1])) seen.add('lookbackStopped');
    else seen.add('noLookback');
    seen.add(['neitherCjk', 'oneSideCjk', 'deleted'][Number(LEGACY_CJK_RE.test(before)) + Number(LEGACY_CJK_RE.test(after))]);
    if (offset === 0) seen.add('atStart');
    if (offset + match.length === whole.length) seen.add('atEnd');
    if (before === '\r') seen.add('crBefore');
    if (after === '\r') seen.add('crAfter');
    if (before === IDEOGRAPHIC_SPACE || after === IDEOGRAPHIC_SPACE) seen.add('ideographicSpaceSide');
    if (before === NO_BREAK_SPACE || after === NO_BREAK_SPACE) seen.add('noBreakSpaceSide');
    if (segments >= 2) seen.add('multiSegment');
}

test('与改为自换行起匹配之前的软换行合并逐字等价：BMP 逐码元与种子固定的随机串，各分支均有样本命中', (t) => {
    // Arrange：BMP 逐码元 65536 个——每个码元 c 放在「甲 c 换行 c 乙」的换行两侧，回看与尾部并入认哪些字符、
    // 哪些字符算汉字或全角标点，任一处与旧实现多一个或少一个都会暴露
    const samples = [];
    for (let code = 0; code <= 0xffff; code += 1) {
        const unit = String.fromCharCode(code);
        samples.push(`甲${unit}\n${unit}乙`);
    }
    // 随机串 100000 个：长度 0 到 12，每个字符以一半概率取自空格、制表符与换行，否则取自回车、ASCII 字母、汉字、
    // 全角标点、U+00A0 与 U+3000，使短串里常有多段、相邻段与起止于串首串尾的段
    const random = createSeededRandom(20260923);
    const pick = (items) => items[Math.floor(random() * items.length)];
    const blanks = [' ', '\t', '\n'];
    const others = ['\r', 'a', 'Z', '甲', '乙', '，', '。', NO_BREAK_SPACE, IDEOGRAPHIC_SPACE];
    const randomChar = () => (random() < 0.5 ? pick(blanks) : pick(others));
    for (let i = 0; i < 100000; i += 1) samples.push(Array.from({ length: Math.floor(random() * 13) }, randomChar).join(''));
    assert.equal(samples.length, 165536);

    // Act & Assert：单个 text 节点摊平后的文字即软换行合并的结果
    const hits = Object.fromEntries(Object.keys(SOFT_BREAK_BRANCHES).map((key) => [key, 0]));
    for (const value of samples) {
        const seen = new Set();
        const expected = legacyJoinSoftBreaks(value, seen);
        const actual = runsText(flattenInline([text(value)]));
        // 只在不一致时拼装诊断信息，免得十余万次调用都付这笔开销
        if (actual !== expected) {
            assert.fail(`输入 [${toCodePoints(value)}]；实际 [${toCodePoints(actual)}]；应为 [${toCodePoints(expected)}]`);
        }
        for (const key of seen) hits[key] += 1;
    }
    // 覆盖自证：各分支都须有样本命中，差分才不是空转
    t.diagnostic(`样本 ${samples.length} 个；各分支命中样本数：`
        + Object.entries(SOFT_BREAK_BRANCHES).map(([key, label]) => `${label} ${hits[key]}`).join('；'));
    for (const [key, label] of Object.entries(SOFT_BREAK_BRANCHES)) assert.ok(hits[key] > 0, `分支「${label}」没有样本命中`);
});
