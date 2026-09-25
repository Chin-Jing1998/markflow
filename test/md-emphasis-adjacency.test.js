/**
 * converters/renderers/md.js：定界符式格式（strong／emphasis／delete）的相邻粘连、同类型嵌套与邻居产物为空
 * 覆盖：
 *   - 相邻粘连：两种已报告形态（加粗后接只含「。」的斜体、斜体后接首末均为书名号的加粗）修复后的产物与重新解析结果；
 *     九种有序相邻对（含同类相邻）× 两个节点的核心内容组合 × 外侧语境的矩阵（中文核心与 ASCII 核心各一组）；
 *     三个及以上相邻；格式节点内部相邻的子节点。
 *   - 同类型嵌套：粘连修复暴露的倒退样例；修复前即出错的形态（如 *甲*乙*丙*）；T(前缀?, T(核心), 后缀?) 与
 *     T 内部相邻两类形态的矩阵。
 *   - 邻居产物为空：格式节点之间或之前夹着空文本、无内容的格式节点时，外侧字符为空串，一律回退标签；同类型嵌套规则
 *     在该类中暴露的倒退样例。
 *   - 已知行为变化：纯字母内容的相邻强调、同类型嵌套的内层、段首空文本后接的加粗均改写为标签，重新解析后格式不变。
 *   - 种子随机往返：固定种子生成的段落（每段 1–5 个行内节点、格式嵌套深度 ≤ 2）；另一组让段落直属的文本位置以 15%
 *     的概率取空文本，只由空文本构成的段落断言产物为空串。
 *   - 回归护栏：辅助平面表情作外侧字符时回退标签、异类型的同字符嵌套与嵌套后接同字符兄弟的产物逐字不变、
 *     两侧为文本时仍写定界符、不同定界符字符相邻时仍写定界符。
 * 矩阵与随机用例逐例经 remark-parse + remark-gfm + liftInlineHtml 重新解析，断言只有一个段落、「文本 + 格式集合」
 * 片段序列与原 IR 一致、不出现原文没有的「*」「~」。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');

const mdRenderer = require('../converters/renderers/md');
const { loadUnified } = require('../converters/ir/unified-loader');
const { liftInlineHtml } = require('../converters/ir/inline-html');
const { createDocument, createRoot, createParagraph, createText } = require('../converters/ir/schema');

const FORMAT_TYPES = ['strong', 'emphasis', 'delete'];
const DELIMITER_CHARS = ['*', '~'];
// 失败信息最多列出的用例数
const MAX_REPORTED = 10;

// ============================================================
// 构造、渲染与重新解析
// ============================================================

/** 格式节点工厂：字符串子项包装为 text 节点 */
const format = (type) => (...children) => ({ type, children: children.map((c) => (typeof c === 'string' ? createText(c) : c)) });
const strong = format('strong');
const emphasis = format('emphasis');
const del = format('delete');
const text = createText;

/** 段落直属的外侧文本：before／after 为空串时省略 */
const withContext = (nodes, { before, after }) => [...(before ? [text(before)] : []), ...nodes, ...(after ? [text(after)] : [])];

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

/** IR 描述，用于失败信息：段落直属文本写作 text(…)，格式节点内的文本只写原文，如「[text(前), strong(加粗)]」 */
function describeIr(nodes) {
    const one = (node, top) => (node.type === 'text'
        ? (top ? `text(${node.value})` : node.value)
        : `${node.type}(${(node.children || []).map((child) => one(child, false)).join(', ')})`);
    return `[${nodes.map((node) => one(node, true)).join(', ')}]`;
}

/**
 * 行内节点序列展平为片段序列 [{ text, formats }]：formats 为祖先中 strong／emphasis／delete 的类型集合（排序后以「+」连接）；
 * 相邻且格式集合相同的片段合并，空文本略去。容许 liftInlineHtml 合并相邻同类节点与嵌套次序变化；
 * 其余类型的节点（如残留的 html）记为 { unexpected } 片段，与原 IR 的任何片段都不相等
 */
function flatten(nodes, formats = [], out = []) {
    for (const node of nodes) {
        if (node.type === 'text') {
            appendSegment(out, node.value, formats);
        } else if (FORMAT_TYPES.includes(node.type)) {
            const next = formats.includes(node.type) ? formats : [...formats, node.type].sort();
            flatten(node.children || [], next, out);
        } else {
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

/** 逐例检查，先收集失败项再一次断言；失败信息列出总数、失败数与前若干项的 IR 描述、md 产物与重新解析结果 */
async function assertAllRoundTrip(label, cases) {
    const failures = [];
    for (const children of cases) {
        const failure = await roundTripFailure(children);
        if (failure) failures.push(failure);
    }
    const lines = failures.slice(0, MAX_REPORTED).map((f, i) => `${i + 1}. ${f.ir} → ${JSON.stringify(f.md)}；`
        + `${f.reasons.join('、')}；重新解析：${JSON.stringify(f.reparsed)}`);
    assert.equal(failures.length, 0, `${label}：${cases.length} 例中 ${failures.length} 例失败，前 ${lines.length} 例：\n${lines.join('\n')}`);
}

// ============================================================
// 矩阵
// ============================================================

// 纯汉字、单个中文标点、首末均为标点、汉字开头标点结尾、标点开头汉字结尾
const CJK_CORES = ['加粗', '。', '《乙》', '甲。', '「甲'];
const CJK_CONTEXTS = [
    { name: '段首段尾', before: '', after: '' },
    { name: '两侧为汉字', before: '前', after: '后' },
    { name: '两侧为中文标点', before: '，', after: '。' },
];
// ASCII 字母、首末均为 ASCII 标点、字母开头标点结尾
const ASCII_CORES = ['A', '(A)', 'A.'];
const ASCII_CONTEXTS = [
    { name: '段首段尾', before: '', after: '' },
    { name: '两侧为 ASCII 字母', before: 'x', after: 'y' },
    { name: '两侧为 ASCII 标点', before: '(', after: ')' },
];

/** 相邻对矩阵：九种有序相邻对 × 核心内容两两组合 × 外侧语境 */
function buildMatrix(cores, contexts) {
    const cases = [];
    for (const firstType of FORMAT_TYPES) {
        for (const secondType of FORMAT_TYPES) {
            for (const firstCore of cores) {
                for (const secondCore of cores) {
                    for (const context of contexts) {
                        cases.push(withContext([format(firstType)(firstCore), format(secondType)(secondCore)], context));
                    }
                }
            }
        }
    }
    return cases;
}

// 同类型嵌套矩阵：核心取中文与 ASCII 集合的子集；前后缀含汉字、中文标点与朝向内层的空格；外侧语境取段首段尾与两侧汉字
const NEST_CORES = ['加粗', '《乙》', '(A)'];
const NEST_PREFIXES = ['', '甲', '，', '外 '];
const NEST_SUFFIXES = ['', '乙', '。', ' 外'];
const NEST_CONTEXTS = [CJK_CONTEXTS[0], CJK_CONTEXTS[1]];
// 内部相邻形态：X(核心1) 为任一类型，T(核心2) 与外层同类型，另有一段文本
const ADJACENT_FIRST_CORES = ['，', 'A'];
const ADJACENT_SECOND_CORES = ['《乙》', '乙'];
const ADJACENT_TAILS = ['。', '丙'];

/** 同类型嵌套矩阵：对每种类型 T 构造 T(前缀?, T(核心), 后缀?)，以及 T(X(核心1), T(核心2), 文本) 与其倒序 */
function buildNestingMatrix() {
    const cases = [];
    for (const type of FORMAT_TYPES) {
        const outer = format(type);
        for (const core of NEST_CORES) {
            for (const prefix of NEST_PREFIXES) {
                for (const suffix of NEST_SUFFIXES) {
                    const children = [...(prefix ? [prefix] : []), outer(core), ...(suffix ? [suffix] : [])];
                    for (const context of NEST_CONTEXTS) cases.push(withContext([outer(...children)], context));
                }
            }
        }
        for (const otherType of FORMAT_TYPES) {
            for (const firstCore of ADJACENT_FIRST_CORES) {
                for (const secondCore of ADJACENT_SECOND_CORES) {
                    for (const tail of ADJACENT_TAILS) {
                        cases.push([outer(format(otherType)(firstCore), outer(secondCore), tail)]);
                        cases.push([outer(tail, outer(secondCore), format(otherType)(firstCore))]);
                    }
                }
            }
        }
    }
    return cases;
}

// ============================================================
// 种子随机段落
// ============================================================

// 文本池：不含空文本与首尾空白；含字面「*」「~」、辅助平面表情与 ASCII 空格
const RANDOM_TEXTS = ['加粗', '。', '《乙》', '甲。', '「甲', 'ab', '!', '😀', '前', '，', 'a b', '*', '~', '1', '》', '（注）'];
const RANDOM_SEED = 20260925;
const RANDOM_COUNT = 2000;

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

/**
 * 行内节点：深度达到 2 或抽中小于 0.45 时为文本，否则为含 1–3 个子节点的格式节点，格式嵌套深度因此 ≤ 2；
 * emptyRate 大于 0 时，段落直属的文本位置以该概率取空文本（格式节点内不生成空文本）
 */
function randomInline(rand, depth, emptyRate = 0) {
    const roll = rand();
    if (depth >= 2 || roll < 0.45) {
        if (emptyRate > 0 && rand() < emptyRate) return text('');
        return text(RANDOM_TEXTS[Math.floor(rand() * RANDOM_TEXTS.length)]);
    }
    const type = FORMAT_TYPES[Math.floor(rand() * FORMAT_TYPES.length)];
    const count = 1 + Math.floor(rand() * 3);
    const children = [];
    for (let i = 0; i < count; i += 1) children.push(randomInline(rand, depth + 1));
    return format(type)(...children);
}

/** count 个段落，每段 1–5 个行内节点 */
function randomParagraphs(seed, count, emptyRate = 0) {
    const rand = mulberry32(seed);
    const paragraphs = [];
    for (let k = 0; k < count; k += 1) {
        const size = 1 + Math.floor(rand() * 5);
        const children = [];
        for (let i = 0; i < size; i += 1) children.push(randomInline(rand, 0, emptyRate));
        paragraphs.push(children);
    }
    return paragraphs;
}

// 含空文本的随机语料：从 EMPTY_POOL 个候选段落中保留含空文本节点的各段
const EMPTY_SEED = 7;
const EMPTY_POOL = 5000;
const EMPTY_TEXT_RATE = 0.15;
const hasEmptyText = (children) => children.some((node) => node.type === 'text' && node.value === '');

// ============================================================
// 用例：已报告形态
// ============================================================

test('已报告形态：加粗后接只含「。」的斜体、斜体后接首末为书名号的加粗，先出现的一方回退标签，重新解析无字面星号', async () => {
    // Arrange
    const cases = [
        { children: [strong('加粗'), emphasis('。')], md: '<strong>加粗</strong>*。*\n', reparsed: [{ strong: ['加粗'] }, { emphasis: ['。'] }] },
        { children: [emphasis('甲'), strong('《乙》')], md: '<em>甲</em>**《乙》**\n', reparsed: [{ emphasis: ['甲'] }, { strong: ['《乙》'] }] },
    ];

    for (const { children, md: expected, reparsed } of cases) {
        // Act
        const md = await renderParagraph(children);
        const tree = await reparse(md);

        // Assert
        assert.equal(md, expected, describeIr(children));
        assert.deepEqual(tree.children.map(brief), [{ paragraph: reparsed }], md);
    }
});

// ============================================================
// 用例：相邻对矩阵
// ============================================================

test('矩阵（中文核心）：九种有序相邻对 × 核心内容组合 × 段首段尾／两侧汉字／两侧中文标点，重新解析后格式与文本均不变', async () => {
    const cases = buildMatrix(CJK_CORES, CJK_CONTEXTS);
    assert.equal(cases.length, 9 * CJK_CORES.length ** 2 * CJK_CONTEXTS.length);
    await assertAllRoundTrip('中文核心矩阵', cases);
});

test('矩阵（ASCII 核心）：九种有序相邻对 × 核心内容组合 × 段首段尾／两侧 ASCII 字母／两侧 ASCII 标点，重新解析后格式与文本均不变', async () => {
    const cases = buildMatrix(ASCII_CORES, ASCII_CONTEXTS);
    assert.equal(cases.length, 9 * ASCII_CORES.length ** 2 * ASCII_CONTEXTS.length);
    await assertAllRoundTrip('ASCII 核心矩阵', cases);
});

// ============================================================
// 用例：三个及以上相邻、格式节点内部相邻
// ============================================================

test('三个及以上相邻：同字符的前一方逐个回退标签，不同定界符字符之间仍写定界符', async () => {
    // Arrange
    const cases = [
        { children: [strong('加粗'), emphasis('。'), strong('《乙》')], md: '<strong>加粗</strong><em>。</em>**《乙》**\n' },
        { children: [strong('甲'), emphasis('乙'), del('丙'), strong('丁')], md: '<strong>甲</strong>*乙*~~丙~~**丁**\n' },
    ];

    for (const { children, md: expected } of cases) {
        // Act
        const md = await renderParagraph(children);

        // Assert
        assert.equal(md, expected, describeIr(children));
    }
    await assertAllRoundTrip('三个及以上相邻', [
        ...cases.map(({ children }) => children),
        [emphasis('甲'), emphasis('乙'), emphasis('丙')],
        [text('前'), del('《甲》'), del('乙'), del('丙。'), text('后')],
    ]);
});

test('格式节点内部相邻的同字符子节点同样回退标签，重新解析无字面星号', async () => {
    // Arrange
    const cases = [
        { children: [strong(emphasis('A'), emphasis('B'))], md: '<strong><em>A</em>*B*</strong>\n' },
        { children: [strong(emphasis('甲'), emphasis('。'))], md: '<strong><em>甲</em>*。*</strong>\n' },
    ];

    for (const { children, md: expected } of cases) {
        // Act
        const md = await renderParagraph(children);

        // Assert
        assert.equal(md, expected, describeIr(children));
    }
    await assertAllRoundTrip('格式节点内部相邻', cases.map(({ children }) => children));
});

// ============================================================
// 用例：同类型嵌套
// ============================================================

test('同类型嵌套：粘连修复暴露的倒退样例，内层 emphasis 改写为标签，重新解析后格式不变', async () => {
    // Arrange：外层首个子节点 strong 因粘连写标签后，外层内容不再以「*」开头而改写定界符，内层 emphasis 若仍写定界符即与外层配错
    const children = [emphasis(strong('，'), emphasis('~', '《乙》'), '。')];

    // Act
    const md = await renderParagraph(children);

    // Assert
    assert.equal(md, '*<strong>，</strong><em>\\~《乙》</em>。*\n');
    await assertAllRoundTrip('倒退样例', [children]);
});

test('同类型嵌套：修复前即出错的形态（如 *甲*乙*丙*），内层一律写标签，重新解析后格式不变', async () => {
    // Arrange
    const cases = [
        { children: [emphasis('甲', emphasis('乙'), '丙')], md: '*甲<em>乙</em>丙*\n' },
        { children: [strong('1', strong('加粗'), '。')], md: '**1<strong>加粗</strong>。**\n' },
        { children: [del('甲', del('乙'), '丙')], md: '~~甲<del>乙</del>丙~~\n' },
    ];

    for (const { children, md: expected } of cases) {
        // Act
        const md = await renderParagraph(children);

        // Assert
        assert.equal(md, expected, describeIr(children));
    }
    await assertAllRoundTrip('修复前即出错的同类型嵌套', cases.map(({ children }) => children));
});

test('同类型嵌套矩阵：T(前缀?, T(核心), 后缀?) 与 T 内部相邻两类形态，重新解析后格式与文本均不变', async () => {
    const cases = buildNestingMatrix();
    // 3 种类型 ×（3 核心 × 4 前缀 × 4 后缀 × 2 语境 + 3 种相邻类型 × 2 × 2 核心 × 2 文本 × 2 种次序）
    assert.equal(cases.length, 3 * (3 * 4 * 4 * 2 + 3 * 2 * 2 * 2 * 2));
    await assertAllRoundTrip('同类型嵌套矩阵', cases);
});

// ============================================================
// 用例：邻居产物为空
// ============================================================

test('邻居产物为空：格式节点之间或之前夹着空文本、无内容的格式节点时，外侧字符为空串或后一兄弟产物为空的一方回退标签，重新解析后格式不变', async () => {
    // Arrange：修复前依次为「**A***B*」「甲**《乙》**」「**加粗***。*」「**A****B**」，后三例重新解析残留字面星号。
    // 第 4 例的前一个 strong 在只按外侧字符判定时写定界符（「**A**<strong>B</strong>」）：后一兄弟为无内容的删除线，
    // 其 peek 报「~」，外侧字符不为空串；加入后一兄弟产物为空的判定后同样回退标签
    const cases = [
        { children: [strong('A'), text(''), emphasis('B')], md: '<strong>A</strong><em>B</em>\n' },
        { children: [text('甲'), text(''), strong('《乙》')], md: '甲<strong>《乙》</strong>\n' },
        { children: [strong('加粗'), text(''), emphasis('。')], md: '<strong>加粗</strong><em>。</em>\n' },
        { children: [strong('A'), del(), strong('B')], md: '<strong>A</strong><strong>B</strong>\n' },
    ];

    for (const { children, md: expected } of cases) {
        // Act
        const md = await renderParagraph(children);

        // Assert
        assert.equal(md, expected, describeIr(children));
    }
    await assertAllRoundTrip('邻居产物为空', cases.map(({ children }) => children));
});

test('邻居产物为空：同类型嵌套规则暴露的倒退样例，隔着空文本的外层 strong 回退标签，重新解析后格式不变', async () => {
    // 仅有粘连与同类型嵌套规则时，外层 strong 与前面的斜体之间隔着空文本、前一字为空串而写定界符，产物为
    // 「\~*<del>甲。</del>a b***<strong>《乙》</strong>**」，与斜体的闭定界符并成「***」
    await assertAllRoundTrip('空文本倒退样例', [
        [text('~'), text(''), emphasis(del('甲。'), 'a b'), text(''), strong(strong('《乙》'))],
    ]);
});

// ============================================================
// 用例：已知行为变化
// ============================================================

test('已知行为变化：纯字母内容的相邻强调原为「**A***B*」，现改写为标签，重新解析后格式不变', async () => {
    // Act
    const md = await renderParagraph([strong('A'), emphasis('B')]);
    const tree = await reparse(md);

    // Assert
    assert.equal(md, '<strong>A</strong>*B*\n');
    assert.deepEqual(tree.children.map(brief), [{ paragraph: [{ strong: ['A'] }, { emphasis: ['B'] }] }], md);
});

test('已知行为变化：同类型嵌套的内层原写定界符，现改写为标签，重新解析后格式不变', async () => {
    // Arrange：修复前依次为「<strong>**X**</strong>」与「*外层 *内层* 外层*」，重新解析同样正确
    const cases = [
        { children: [strong(strong('X'))], md: '**<strong>X</strong>**\n' },
        { children: [emphasis('外层 ', emphasis('内层'), ' 外层')], md: '*外层 <em>内层</em> 外层*\n' },
    ];

    for (const { children, md: expected } of cases) {
        // Act
        const md = await renderParagraph(children);

        // Assert
        assert.equal(md, expected, describeIr(children));
    }
    await assertAllRoundTrip('同类型嵌套的行为变化', cases.map(({ children }) => children));
});

test('已知行为变化：段首空文本后接的加粗原为「**加粗**」，现因前一字为空串改写为标签，重新解析后格式不变', async () => {
    // Arrange
    const children = [text(''), strong('加粗')];

    // Act
    const md = await renderParagraph(children);

    // Assert
    assert.equal(md, '<strong>加粗</strong>\n');
    await assertAllRoundTrip('段首空文本', [children]);
});

// ============================================================
// 用例：种子随机往返
// ============================================================

test(`种子随机往返：种子 ${RANDOM_SEED} 生成 ${RANDOM_COUNT} 个段落（每段 1–5 个行内节点、格式嵌套深度 ≤ 2），重新解析后格式与文本均不变`, async () => {
    const cases = randomParagraphs(RANDOM_SEED, RANDOM_COUNT);
    assert.equal(cases.length, RANDOM_COUNT);
    await assertAllRoundTrip('种子随机往返', cases);
});

test(`含空文本的种子随机往返：种子 ${EMPTY_SEED} 的 ${EMPTY_POOL} 个候选段落中含空文本节点的各段，重新解析后格式与文本均不变，只由空文本构成的段落产物为空串`, async () => {
    // Arrange：段落直属的文本位置以 15% 的概率取空文本；只由空文本构成的段落渲染为空串，不产生段落节点
    const cases = randomParagraphs(EMPTY_SEED, EMPTY_POOL, EMPTY_TEXT_RATE).filter(hasEmptyText);
    const blank = cases.filter((children) => flatten(children).length === 0);
    const visible = cases.filter((children) => flatten(children).length > 0);
    assert.equal(cases.length, 948);
    assert.equal(blank.length, 78);

    // Act & Assert
    for (const children of blank) assert.equal(await renderParagraph(children), '', describeIr(children));
    await assertAllRoundTrip('含空文本的种子随机往返', visible);
});

// ============================================================
// 用例：回归护栏（修复前后均应通过）
// ============================================================

test('回归护栏：辅助平面表情作外侧字符时，首末为书名号的加粗仍回退 <strong>', async () => {
    // Act
    const md = await renderParagraph([text('😀'), strong('《甲》'), text('😀')]);
    const tree = await reparse(md);

    // Assert
    assert.equal(md, '😀<strong>《甲》</strong>😀\n');
    assert.deepEqual(tree.children.map(brief), [{ paragraph: ['😀', { strong: ['《甲》'] }, '😀'] }], md);
});

test('回归护栏：同字符嵌套与嵌套后接同字符兄弟的产物逐字不变', async () => {
    // Arrange：期望值取自修复前的实际产物
    const cases = [
        { children: [strong(emphasis('X'))], md: '<strong>*X*</strong>\n' },
        { children: [emphasis(strong('X'))], md: '<em>**X**</em>\n' },
        { children: [strong(emphasis('《甲》'))], md: '<strong>*《甲》*</strong>\n' },
        { children: [emphasis(strong('《甲》'))], md: '<em>**《甲》**</em>\n' },
        { children: [strong(emphasis('甲')), emphasis('乙')], md: '<strong>*甲*</strong>*乙*\n' },
    ];

    for (const { children, md: expected } of cases) {
        // Act
        const md = await renderParagraph(children);

        // Assert
        assert.equal(md, expected, describeIr(children));
    }
    await assertAllRoundTrip('同字符嵌套', cases.map(({ children }) => children));
});

test('回归护栏：两侧为文本时加粗仍写定界符', async () => {
    // Act
    const md = await renderParagraph([text('前'), strong('加粗'), text('后')]);

    // Assert
    assert.equal(md, '前**加粗**后\n');
});

test('回归护栏：不同定界符字符（「*」与「~」）相邻时两侧仍写定界符', async () => {
    // Arrange
    const cases = [
        { children: [strong('甲'), del('乙')], md: '**甲**~~乙~~\n' },
        { children: [del('甲'), strong('乙')], md: '~~甲~~**乙**\n' },
    ];

    for (const { children, md: expected } of cases) {
        // Act
        const md = await renderParagraph(children);

        // Assert
        assert.equal(md, expected, describeIr(children));
    }
    await assertAllRoundTrip('不同定界符字符相邻', cases.map(({ children }) => children));
});
