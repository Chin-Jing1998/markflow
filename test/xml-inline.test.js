/**
 * converters/renderers/xml/inline.js 单元测试
 * 覆盖：superscript / subscript 节点摊平为 sup / sub 标记，与 b / i / u 嵌套时按 MARK_ORDER 出元素；
 *       残留的 <sup>/<sub> html 节点（未被 ir/inline-html 提升时的兜底）同样还原；
 *       p 与 claim-text 两种语境下的输出形态一致；
 *       trimRuns 尾部空白修剪在 8 万个全角空格长段上的耗时上限，与线性化之前的实现逐字等价（差分）
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
