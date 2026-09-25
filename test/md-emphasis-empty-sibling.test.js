/**
 * converters/renderers/md.js：定界符式格式（strong／emphasis／delete）后接产物为空的兄弟节点时看不到真实邻居
 * 成因：containerPhrasing（mdast-util-to-markdown 2.1.2）以后一兄弟 peek 结果的首字作本节点的 info.after；定界符式格式的
 * peek 恒报「*」或「~」，html 与 underline／superscript／subscript 的 peek 恒报「<」，节点产物为空时也是如此。修复前，
 * 格式节点以这个标点作后一字、判为可写定界符，闭定界符实际紧贴更远的真实邻居，重新解析时不能闭合，残留字面星号或
 * 波浪号，如 [strong(《甲》), delete(), text(乙)] 的产物曾为「**《甲》**乙」。
 * 修法：render() 在 stringify 之前剔除行内语境中产物为空的节点，格式节点按真实邻居判定，含空节点的 IR 与去掉空节点
 * 后的 IR 产物逐字相同。d5d6823 所加的后侧规则（后一兄弟产物为空时回退标签，peek 不改，以免以反斜杠结尾的文本失去
 * 转义）与 f4a1567 的前侧规则（前一兄弟产物为空时回退标签）保留作兜底，常规 IR 中不再触发；本文件的正向与镜像形态
 * 作两侧的护栏。
 * 覆盖：
 *   - 已报告形态：加粗后接无内容的删除线、空 html、只含空文本的删除线，删除线后接无内容的加粗；另含加粗后接无内容的
 *     下划线、上标、下标。逐例比对产物，并断言往返正确。
 *   - 矩阵：定界符式格式 A × 核心内容 × 产物为空的兄弟 E（含嵌套的空格式节点与空 html）× E 之后的邻居（段尾、汉字、
 *     中文标点、ASCII 字母、空格加汉字、与 A 同类型的另一格式节点）；另含 E 在 A 之前的镜像形态。
 *   - 连续多个空节点；格式节点内部的空兄弟（其后为文本、位于末尾、其后仍是格式节点）。
 *   - 已知行为变化：d5d6823 因后一兄弟产物为空而由定界符改写为标签的形态，现空节点先行剔除，产物回到定界符写法。
 *   - 回归护栏：以反斜杠结尾的文本后接空节点、再后为 ASCII 标点时反斜杠仍须转义（d5d6823 靠空节点 peek 报出的 ASCII
 *     标点转义，peek 若改报空串即会失败；现空节点先行剔除，改由真实邻居给出 after）；不含空节点的形态产物逐字不变。
 *   - 种子随机往返：固定种子生成的段落（每段 1–5 个行内节点、格式嵌套深度 ≤ 2、六种格式），各位置以 20% 的概率取
 *     产物为空的节点；只由空节点构成的段落断言产物为空串。
 * 断言口径：已报告形态与已知行为变化逐字比对产物，其余缺陷类用例只断言往返正确、不约束具体写法。逐例经 remark-parse
 * + remark-gfm + liftInlineHtml 重新解析，断言只有一个段落、「文本 + 格式集合」片段序列与原 IR 一致、不出现原文没有的
 * 「*」「~」；产物为空的节点不产生片段。
 * 范围外：空节点还会遮住文本节点的转义语境，如以反斜杠结尾的文本后接空文本再接 ASCII 标点、段首空节点后接以「#」
 * 「1.」或空白开头的文本、段尾空节点之前以空白结尾的文本；该类已由剔除空节点一并处理，用例见
 * test/md-empty-inline-context.test.js，本文件不覆盖：矩阵中带空格的邻居只在朝向 E 的一侧含空格；随机文本池不含
 * 行首敏感的开头与首尾空白，也不生成段落或格式节点直属的空文本兄弟（空文本只作为空格式节点的唯一子节点出现）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');

const mdRenderer = require('../converters/renderers/md');
const { loadUnified } = require('../converters/ir/unified-loader');
const { liftInlineHtml } = require('../converters/ir/inline-html');
const { createDocument, createRoot, createParagraph, createText } = require('../converters/ir/schema');

// 片段展平所认的格式类型：定界符式三种与只写 HTML 标签的三种
const FORMAT_TYPES = ['strong', 'emphasis', 'delete', 'underline', 'superscript', 'subscript'];
// 定界符式格式（矩阵中的 A）
const ATTENTION_TYPES = ['strong', 'emphasis', 'delete'];
const DELIMITER_CHARS = ['*', '~'];
// 失败信息最多列出的用例数
const MAX_REPORTED = 10;
const BACKSLASH = String.fromCharCode(92);

// ============================================================
// 构造、渲染与重新解析
// ============================================================

/** 格式节点工厂：字符串子项包装为 text 节点；不传子项即为无内容的格式节点 */
const format = (type) => (...children) => ({ type, children: children.map((c) => (typeof c === 'string' ? createText(c) : c)) });
const strong = format('strong');
const emphasis = format('emphasis');
const del = format('delete');
const underline = format('underline');
const superscript = format('superscript');
const subscript = format('subscript');
const text = createText;
const html = (value) => ({ type: 'html', value });

function renderParagraph(children) {
    return mdRenderer.render(createDocument({ ir: createRoot([createParagraph(children)]) }));
}

async function reparse(md) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    return liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(md));
}

/** 节点简式：文本 → 字符串，html → { html: 原值 }（便于定位残留），其余 → { 类型: 子节点简式 } */
function brief(node) {
    if (node.type === 'text') return node.value;
    if (node.type === 'html') return { html: node.value };
    return { [node.type]: (node.children || []).map(brief) };
}

/**
 * IR 描述，用于失败信息：段落直属文本写作 text(…)，格式节点内的文本只写原文，如「[text(前), strong(加粗)]」；
 * 空文本一律写作 text('')、html 节点写作 html(原值)，以便区分 strong() 与 strong(text(''))
 */
function describeIr(nodes) {
    const one = (node, top) => {
        if (node.type === 'text') {
            if (!node.value) return "text('')";
            return top ? `text(${node.value})` : node.value;
        }
        if (node.type === 'html') return `html(${node.value || "''"})`;
        return `${node.type}(${(node.children || []).map((child) => one(child, false)).join(', ')})`;
    };
    return `[${nodes.map((node) => one(node, true)).join(', ')}]`;
}

/**
 * 行内节点序列展平为片段序列 [{ text, formats }]：formats 为祖先中 FORMAT_TYPES 各类型的集合（排序后以「+」连接）；
 * 相邻且格式集合相同的片段合并，空文本与值为空串的 html 节点略去，产物为空的节点因而不产生片段。容许 liftInlineHtml
 * 合并相邻同类节点与嵌套次序变化；其余类型的节点（如残留的非空 html）记为 { unexpected } 片段，与原 IR 的任何片段都不相等
 */
function flatten(nodes, formats = [], out = []) {
    for (const node of nodes) {
        if (node.type === 'text') {
            appendSegment(out, node.value, formats);
        } else if (FORMAT_TYPES.includes(node.type)) {
            const next = formats.includes(node.type) ? formats : [...formats, node.type].sort();
            flatten(node.children || [], next, out);
        } else if (node.type !== 'html' || node.value) {
            out.push({ unexpected: node.type, value: node.value });
        }
    }
    return out;
}

function appendSegment(out, value, formats) {
    if (!value) return;
    const key = formats.join('+');
    const last = out[out.length - 1];
    if (last && last.formats === key) last.text += value;
    else out.push({ text: value, formats: key });
}

const plainText = (nodes) => nodes.map((node) => (node.type === 'text' ? node.value : plainText(node.children || []))).join('');

/** 渲染单段 IR 并重新解析；通过时返回 null，否则返回 { ir, md, reparsed, reasons } */
async function roundTripFailure(children) {
    const md = await renderParagraph(children);
    const tree = await reparse(md);
    const reasons = [];
    const [paragraph] = tree.children;
    if (tree.children.length !== 1 || paragraph.type !== 'paragraph') {
        reasons.push('重新解析后不是单个段落');
    } else {
        if (!isDeepStrictEqual(flatten(paragraph.children), flatten(children))) reasons.push('片段序列与原 IR 不一致');
        const original = plainText(children);
        const reparsed = plainText(paragraph.children);
        for (const char of DELIMITER_CHARS) {
            if (!original.includes(char) && reparsed.includes(char)) reasons.push(`重新解析文本出现原文没有的「${char}」`);
        }
    }
    return reasons.length ? { ir: describeIr(children), md, reparsed: tree.children.map(brief), reasons } : null;
}

/** 逐例检查，返回失败项 */
async function roundTripFailures(cases) {
    const failures = [];
    for (const children of cases) {
        const failure = await roundTripFailure(children);
        if (failure) failures.push(failure);
    }
    return failures;
}

/** 失败信息的逐项说明：前 MAX_REPORTED 项的 IR 描述、md 产物、失败原因与重新解析结果 */
function reportLines(failures) {
    return failures.slice(0, MAX_REPORTED).map((f, i) => `${i + 1}. ${f.ir} → ${JSON.stringify(f.md)}；`
        + `${f.reasons.join('、')}；重新解析：${JSON.stringify(f.reparsed)}`);
}

/** 逐例检查，先收集失败项再一次断言；失败信息列出总数、失败数与前若干项 */
async function assertAllRoundTrip(label, cases) {
    const failures = await roundTripFailures(cases);
    const lines = reportLines(failures);
    assert.equal(failures.length, 0, `${label}：${cases.length} 例中 ${failures.length} 例失败，前 ${lines.length} 例：\n${lines.join('\n')}`);
}

// ============================================================
// 矩阵
// ============================================================

// 核心内容：书名号首末、汉字开头句号结尾、纯汉字、ASCII 括号首末、ASCII 字母开头句点结尾
const MATRIX_CORES = ['《甲》', '甲。', '甲', '(A)', 'A.'];
// 产物为空的兄弟节点 E：以工厂给出，每例新建节点，不在用例之间共享对象
const EMPTY_SIBLINGS = [
    () => strong(),
    () => emphasis(),
    () => del(),
    () => strong(text('')),
    () => del(text('')),
    () => underline(),
    () => superscript(),
    () => subscript(),
    () => html(''),
    () => del(strong(text(''))),
    () => emphasis(underline()),
];
// 与 A 同类型、内容为「乙」的另一格式节点
const SAME_TYPE = Symbol('与 A 同类型的格式节点');
// E 之后的邻居（正向形态）：null 为段尾；字符串为段落直属文本
const NEIGHBORS_AFTER = [null, '乙', '。', 'a', ' 乙', SAME_TYPE];
// E 之前的邻居（镜像形态）：null 为段首；空格仍放在朝向 E 的一侧
const NEIGHBORS_BEFORE = [null, '乙', '。', 'a', '乙 ', SAME_TYPE];

function neighborNodes(neighbor, type) {
    if (neighbor === null) return [];
    if (neighbor === SAME_TYPE) return [format(type)('乙')];
    return [text(neighbor)];
}

/** 正向 [A(核心), E, 邻居?] 与镜像 [邻居?, E, A(核心)] 两组 */
function buildMatrix() {
    const forward = [];
    const mirror = [];
    for (const type of ATTENTION_TYPES) {
        for (const core of MATRIX_CORES) {
            for (const makeEmpty of EMPTY_SIBLINGS) {
                for (const neighbor of NEIGHBORS_AFTER) forward.push([format(type)(core), makeEmpty(), ...neighborNodes(neighbor, type)]);
                for (const neighbor of NEIGHBORS_BEFORE) mirror.push([...neighborNodes(neighbor, type), makeEmpty(), format(type)(core)]);
            }
        }
    }
    return { forward, mirror };
}

// ============================================================
// 种子随机段落
// ============================================================

// 文本池：沿用 md-emphasis-adjacency 的 RANDOM_TEXTS（不含空文本与首尾空白），另加两个以反斜杠结尾的文本；
// 均不以「#」「1.」一类行首敏感的写法开头
const RANDOM_TEXTS = ['加粗', '。', '《乙》', '甲。', '「甲', 'ab', '!', '😀', '前', '，', 'a b', '*', '~', '1', '》', '（注）', `甲${BACKSLASH}`, BACKSLASH];
const RANDOM_SEED = 20260926;
const RANDOM_COUNT = 2000;
// 各位置取产物为空的节点的概率
const EMPTY_RATE = 0.2;

/** mulberry32：32 位状态的确定性伪随机数发生器，返回 [0, 1) 内的数 */
function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

/**
 * 产物为空的节点：深度 ≤ 1 时三分之一为 html('')，其余为六种格式之一的空格式节点，无子节点与只含空文本各占一半；
 * 深度 2 只取 html('')，格式嵌套深度因此 ≤ 2
 */
function randomEmpty(rand, depth) {
    if (depth >= 2 || rand() < 1 / 3) return html('');
    const type = pick(rand, FORMAT_TYPES);
    return rand() < 0.5 ? format(type)() : format(type)(text(''));
}

/**
 * 行内节点：以 EMPTY_RATE 的概率取产物为空的节点；否则深度达到 2 或抽中小于 0.45 时为文本池中的文本，其余为含 1–3 个
 * 子节点的格式节点（六种之一）。子节点全为空节点的格式节点同样产物为空，由此得到嵌套的空节点
 */
function randomInline(rand, depth) {
    if (rand() < EMPTY_RATE) return randomEmpty(rand, depth);
    const roll = rand();
    if (depth >= 2 || roll < 0.45) return text(pick(rand, RANDOM_TEXTS));
    const type = pick(rand, FORMAT_TYPES);
    const count = 1 + Math.floor(rand() * 3);
    const children = [];
    for (let i = 0; i < count; i += 1) children.push(randomInline(rand, depth + 1));
    return format(type)(...children);
}

/** count 个段落，每段 1–5 个行内节点 */
function randomParagraphs(seed, count) {
    const rand = mulberry32(seed);
    const paragraphs = [];
    for (let k = 0; k < count; k += 1) {
        const size = 1 + Math.floor(rand() * 5);
        const children = [];
        for (let i = 0; i < size; i += 1) children.push(randomInline(rand, 0));
        paragraphs.push(children);
    }
    return paragraphs;
}

// ============================================================
// 用例：已报告形态
// ============================================================

test('已报告形态：加粗后接无内容的删除线、空 html 或只含空文本的删除线，删除线后接无内容的加粗，以及加粗后接无内容的下划线、上标、下标，前面的格式节点一律回退标签，重新解析后格式与文本均不变、不出现原文没有的「*」「~」', async () => {
    // Arrange：修复前产物均为「**《甲》**乙」或「~~甲。~~乙」：空兄弟的 peek 报出标点，闭定界符被判为可写，实际紧贴「乙」而不能闭合
    const cases = [
        { children: [strong('《甲》'), del(), text('乙')], md: '<strong>《甲》</strong>乙\n' },
        { children: [strong('《甲》'), html(''), text('乙')], md: '<strong>《甲》</strong>乙\n' },
        { children: [strong('《甲》'), del(text('')), text('乙')], md: '<strong>《甲》</strong>乙\n' },
        { children: [del('甲。'), strong(), text('乙')], md: '<del>甲。</del>乙\n' },
        { children: [strong('《甲》'), underline(), text('乙')], md: '<strong>《甲》</strong>乙\n' },
        { children: [strong('《甲》'), superscript(), text('乙')], md: '<strong>《甲》</strong>乙\n' },
        { children: [strong('《甲》'), subscript(), text('乙')], md: '<strong>《甲》</strong>乙\n' },
    ];

    for (const { children, md: expected } of cases) {
        // Act
        const md = await renderParagraph(children);

        // Assert
        assert.equal(md, expected, describeIr(children));
    }
    await assertAllRoundTrip('已报告形态', cases.map(({ children }) => children));
});

// ============================================================
// 用例：矩阵
// ============================================================

test('矩阵：定界符式格式 A × 核心内容 × 产物为空的兄弟 E × E 之后的邻居，另含 E 在 A 之前的镜像形态，重新解析后格式与文本均不变', async () => {
    // Arrange
    const { forward, mirror } = buildMatrix();
    // 3 种 A × 5 种核心 × 11 种 E × 6 种邻居
    assert.equal(forward.length, ATTENTION_TYPES.length * MATRIX_CORES.length * EMPTY_SIBLINGS.length * NEIGHBORS_AFTER.length);
    assert.equal(mirror.length, forward.length);

    // Act
    const forwardFailures = await roundTripFailures(forward);
    const mirrorFailures = await roundTripFailures(mirror);

    // Assert：两组分别计数，失败信息合并列出前若干项
    const lines = reportLines([...forwardFailures, ...mirrorFailures]);
    assert.equal(forwardFailures.length + mirrorFailures.length, 0,
        `矩阵：E 在 A 之后 ${forward.length} 例中 ${forwardFailures.length} 例失败，E 在 A 之前 ${mirror.length} 例中 `
        + `${mirrorFailures.length} 例失败，前 ${lines.length} 例：\n${lines.join('\n')}`);
});

// ============================================================
// 用例：连续多个空节点、格式节点内部的空兄弟
// ============================================================

test('连续多个空节点：格式节点之后连续夹着多个产物为空的节点（另含空节点在格式节点之前、夹在两个格式节点之间、位于段首的形态），重新解析后格式与文本均不变', async () => {
    await assertAllRoundTrip('连续多个空节点', [
        [strong('《甲》'), del(), html(''), emphasis(text('')), text('乙')],
        [del('甲。'), strong(), underline(), html(''), text('a')],
        [emphasis('(A)'), html(''), html(''), subscript(text('')), text('乙')],
        [strong('A.'), del(strong(text(''))), emphasis(underline()), superscript(), text('乙')],
        [text('乙'), del(), html(''), emphasis(text('')), strong('《甲》')],
        [del('甲。'), strong(), html(''), emphasis(text('')), del('乙')],
        [html(''), strong(), del('《甲》'), underline(), text('乙')],
    ]);
});

test('格式节点内部的空兄弟：格式节点的子节点之间或末尾夹着产物为空的节点，重新解析后格式与文本均不变', async () => {
    await assertAllRoundTrip('格式节点内部的空兄弟', [
        // 空兄弟位于末尾，或其后仍是格式节点
        [emphasis(strong('《甲》'), del())],
        [strong(text('甲'), del(), emphasis('。'))],
        [strong(text('乙'), del(), html(''), emphasis('《甲》'))],
        // 空兄弟之后是文本
        [emphasis(strong('《甲》'), del(), '乙')],
        [strong(del('甲。'), html(''), '乙')],
        [del(emphasis('(A)'), underline(), 'a')],
        [underline(strong('《甲》'), superscript(), '乙')],
        [text('前'), emphasis(strong('A.'), subscript(text('')), '乙'), text('后')],
    ]);
});

// ============================================================
// 用例：已知行为变化
// ============================================================

test('已知行为变化：后一兄弟产物为空的定界符（如「**甲**乙」、段尾的「**《甲》**」）曾一律改写为标签，现空节点先行剔除、按真实邻居判定，产物回到定界符写法，重新解析后格式与文本均不变', async () => {
    // Arrange：d5d6823 之前依次为「**甲**乙」「**《甲》**」「~~甲。~~。」，重新解析同样正确；d5d6823 让后一兄弟产物为空
    // 的一方一律回退标签，产物依次为「<strong>甲</strong>乙」「<strong>《甲》</strong>」「<del>甲。</del>。」。现空节点
    // 在 stringify 之前剔除，各例产物与去掉空节点后的 IR 相同，回到定界符写法
    const cases = [
        { children: [strong('甲'), del(), text('乙')], md: '**甲**乙\n' },
        { children: [strong('《甲》'), html('')], md: '**《甲》**\n' },
        { children: [del('甲。'), underline(), text('。')], md: '~~甲。~~。\n' },
    ];

    for (const { children, md: expected } of cases) {
        // Act
        const md = await renderParagraph(children);

        // Assert
        assert.equal(md, expected, describeIr(children));
    }
    await assertAllRoundTrip('已知行为变化', cases.map(({ children }) => children));
});

// ============================================================
// 用例：回归护栏（修复前后均应通过）
// ============================================================

test('回归护栏：以反斜杠结尾的文本后接空节点、再后为 ASCII 标点（闭定界符或字面星号）时，反斜杠仍须转义，重新解析后格式与文本均不变', async () => {
    // f4a1567 以来产物均依次为「**甲\\**」与「甲\\\*乙*丙*」。d5d6823 时空节点的 peek 报出「~」，文本末尾的反斜杠按后接
    // ASCII 标点转义；现空节点先行剔除，前者的文本成为 strong 的末个子节点，after 取 strong 传入的定界符「*」，后者的
    // after 取字面星号产物的首字即其转义符，均为 ASCII 标点，反斜杠照常转义。
    // 修法若让文本节点看到的 after 变为空串，反斜杠不再转义：前者的反斜杠转义了闭定界符的首个星号；后者的反斜杠与
    // 字面星号的转义符并成「\\」，字面星号失去转义，与「乙」之后本属斜体「丙」的开定界符配成斜体
    await assertAllRoundTrip('反斜杠转义', [
        [strong(text(`甲${BACKSLASH}`), del())],
        [text(`甲${BACKSLASH}`), del(), text('*'), text('乙'), emphasis('丙')],
    ]);
});

test('回归护栏：不含空节点的形态产物逐字不变（后接非空的下划线、非空 html 或只含空格的文本时仍按真实邻居判定）', async () => {
    // Arrange：期望值取自修复前（f4a1567）的实际产物
    const cases = [
        { children: [strong('加粗'), emphasis('。')], md: '<strong>加粗</strong>*。*\n' },
        { children: [text('前'), strong('加粗'), text('后')], md: '前**加粗**后\n' },
        { children: [strong('《甲》'), underline('乙'), text('丙')], md: '**《甲》**<u>乙</u>丙\n' },
        { children: [emphasis('甲'), text(' '), strong('《乙》')], md: '*甲* **《乙》**\n' },
        { children: [strong('A.'), html('<br>'), text('乙')], md: '**A.**<br>乙\n' },
    ];

    for (const { children, md: expected } of cases) {
        // Act
        const md = await renderParagraph(children);

        // Assert
        assert.equal(md, expected, describeIr(children));
    }
});

// ============================================================
// 用例：种子随机往返
// ============================================================

test(`种子随机往返：种子 ${RANDOM_SEED} 生成 ${RANDOM_COUNT} 个段落（每段 1–5 个行内节点、格式嵌套深度 ≤ 2、六种格式、各位置以 ${EMPTY_RATE * 100}% 的概率取产物为空的节点），只由空节点构成的段落产物为空串，其余重新解析后格式与文本均不变`, async () => {
    // Arrange：只由空节点构成的段落渲染为空串，不产生段落节点；其数目随生成器固定
    const cases = randomParagraphs(RANDOM_SEED, RANDOM_COUNT);
    const blank = cases.filter((children) => flatten(children).length === 0);
    const visible = cases.filter((children) => flatten(children).length > 0);
    assert.equal(cases.length, RANDOM_COUNT);
    assert.equal(blank.length, 130);

    // Act & Assert
    for (const children of blank) assert.equal(await renderParagraph(children), '', describeIr(children));
    await assertAllRoundTrip('种子随机往返', visible);
});
