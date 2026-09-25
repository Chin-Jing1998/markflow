/**
 * converters/ir/inline-html.js：只含空白的格式标签在提升时被拆除，md 渲染器写出的 <del> </del>、<u>      </u> 重新解析后格式丢失
 * 成因：liftInlineHtml 的 wrapFrame 把「只包着图片（与换行、空白）」的格式帧直接拆除，判定为 nodes.every(isImageLike)，而
 * isImageLike 把只含空白的 text 也算在内。本意是让 <strong> <img> </strong> 这类图片两侧夹空白的帧同样拆除（图片不承载
 * 粗斜体），副作用是帧内只有空白 text 时同样满足 every，格式随之拆掉。md 渲染器对只含空白的格式节点只能写 HTML 标签
 * （定界符不能包住首尾为空白的内容；underline / superscript / subscript 本就写标签），因此修复前 [text('甲'), delete(' '),
 * text('乙')] 的产物「甲<del> </del>乙」重新解析为 text('甲 乙')，[link('甲', strong(' '))] 的产物
 * 「[甲<strong> </strong>](https://a.com)」重新解析为 link('甲 ')，Markdown 源文本「姓名：<u>      </u>」（填空横线）解析后
 * 只剩「姓名：      」。
 * 修法：wrapFrame 只在帧内至少有一个 image 或 break、其余都是空白 text 时拆除；只含空白 text 的帧保留为格式节点。
 * 覆盖：
 *   - 已列形态：任务实测的三种形态、填空横线与段中只含换行的下划线，共 5 例；
 *   - 矩阵：6 种空白值（一个、两个、六个半角空格，U+00A0，U+3000，半角空格夹 U+3000）× 8 种格式（六种行内格式与
 *     strong(underline(…))、emphasis(delete(…)) 两种嵌套）× 9 种位置（段落中单独、段首、段中、段尾、链接内单独、链接内
 *     文本之后、夹在两个定界符式格式之间、二级标题的段中、表格单元格的段中），对照形态（空白换成「中」）往返正确；
 *   - Markdown 源文本直接解析：只含空白的 <u>/<del>/<strong> 等提升为格式节点，字符引用写法解码后同样保留，嵌套与相邻
 *     的只含空白标签按既有规则还原与合并；
 *   - 回归护栏（修复前后均应通过）：只包着图片、换行或图片夹空白的格式标签仍拆除，空标签对仍删除；
 *   - 种子随机往返：固定种子生成 2000 个段落，每段 1–6 个槽位且至少一个槽位为只含空白的格式节点，其余按比例取只含空白的
 *     格式节点、普通文本、非空格式节点（子节点可含只含空白的格式节点）、链接与两个相邻的只含空白的格式节点。
 * 断言口径：往返正确指逐例经 remark-parse + remark-gfm + liftInlineHtml 重新解析后只有一个块、块类型不变，「文本 + 格式集合」
 * 片段序列与原 IR 一致（链接视作带 url 的格式，相邻同集合的片段合并，liftInlineHtml 合并相邻同类节点因而不计），且不出现
 * 原文没有的「*」「~」；Markdown 源文本直接解析与回归护栏两项逐节点比对提升结果。
 * 范围外（用例均已避开）：
 *   - 制表符：ir/markers 的 applyTextLayout 把非代码文本中的制表符改为两个 U+3000，往返后文本本身不同；
 *   - 只含换行的格式节点处在段首或单独成段：产物中的开标签独占一行，CommonMark 第 7 类 HTML 块的条件成立，整段解析为
 *     html 节点，属解析器固有行为；段中的形态不受影响，收入已列形态；
 *   - 换行之前的空格：解析器在软换行处去掉行尾空格，[underline(' ' + 换行)] 一类文本本身即不往返；
 *   - 空白与换行、图片混杂的帧（如 underline(' ', break, ' ')）：仍按既有设计拆除，本修复不改动；
 *   - docx 与网页管线：turndown 把只含空白的行内元素判为空白元素（isBlank）、连标签一起删除，并先把连续的 ASCII 空白
 *     折叠为一个空格，这类帧不会到达 liftInlineHtml；docx 里带下划线的空格在 docx → md 一程即已丢失，与本修复无关。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');

const mdRenderer = require('../converters/renderers/md');
const { loadUnified } = require('../converters/ir/unified-loader');
const { liftInlineHtml } = require('../converters/ir/inline-html');
const {
    createDocument, createRoot, createParagraph, createHeading, createTable, createTableRow, createTableCell, createText,
} = require('../converters/ir/schema');

// 片段展平所认的格式类型：定界符式三种与只写 HTML 标签的三种
const FORMAT_TYPES = ['strong', 'emphasis', 'delete', 'underline', 'superscript', 'subscript'];
const DELIMITER_CHARS = ['*', '~'];
// 失败信息最多列出的用例数
const MAX_REPORTED = 10;
// 各类空白、换行与辅助平面表情一律以码点生成，源码中不出现不可见字面量与转义序列
const NBSP = String.fromCharCode(0xa0);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const NL = String.fromCharCode(10);
const EMOJI = String.fromCodePoint(0x1f600);
// 用例中链接的地址：不含空白与括号；链接文本均与之不同，产物恒为「[文本](地址)」
const LINK_URL = 'https://a.com';
// heading 语境的标题级别；tableCell 语境为两行一列的表格，表头单元格为 TABLE_HEAD，被测子节点放在表体单元格
const HEADING_DEPTH = 2;
const TABLE_HEAD = '表头';

// ============================================================
// 构造、渲染与重新解析
// ============================================================

/** 容器节点的子项：字符串包装为 text 节点 */
const wrapChildren = (children) => children.map((c) => (typeof c === 'string' ? createText(c) : c));
/** 格式节点工厂 */
const format = (type) => (...children) => ({ type, children: wrapChildren(children) });
const strong = format('strong');
const emphasis = format('emphasis');
const del = format('delete');
const underline = format('underline');
const superscript = format('superscript');
const subscript = format('subscript');
const text = createText;
/** 链接工厂：地址恒为 LINK_URL */
const link = (...children) => ({ type: 'link', url: LINK_URL, title: null, children: wrapChildren(children) });

/** 承载行内子节点的块：paragraph；HEADING_DEPTH 级 heading；两行一列的 table，子节点放在表体单元格 */
function blockOf(kind, children) {
    if (kind === 'heading') return createHeading(HEADING_DEPTH, children);
    if (kind === 'tableCell') {
        return createTable(null, [createTableRow([createTableCell([text(TABLE_HEAD)])]), createTableRow([createTableCell(children)])]);
    }
    return createParagraph(children);
}

function renderBlock(kind, children) {
    return mdRenderer.render(createDocument({ ir: createRoot([blockOf(kind, children)]) }));
}

async function parseMarkdown(md) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    return unified().use(remarkParse).use(remarkGfm).parse(md);
}

async function reparse(md) {
    return liftInlineHtml(await parseMarkdown(md));
}

/**
 * 重新解析结果中与原块对应的行内子节点：须只有一个块且类型相同；heading 另须级别相同，table 另须仍为两行一列且表头
 * 单元格只有文本 TABLE_HEAD。任一不符时返回 null
 */
function phrasingOf(kind, tree) {
    if (tree.children.length !== 1) return null;
    const [block] = tree.children;
    if (kind === 'heading') return block.type === 'heading' && block.depth === HEADING_DEPTH ? block.children : null;
    if (kind === 'tableCell') {
        const rows = block.type === 'table' ? block.children : [];
        if (rows.length !== 2 || rows.some((row) => row.children.length !== 1)) return null;
        const head = rows[0].children[0].children;
        const headIntact = head.length === 1 && head[0].type === 'text' && head[0].value === TABLE_HEAD;
        return headIntact ? rows[1].children[0].children : null;
    }
    return block.type === 'paragraph' ? block.children : null;
}

/** 节点简式，用于失败信息：文本 → 字符串，html → { html }，链接另带地址，图片带地址，其余 → { 类型: 子节点简式 } */
function brief(node) {
    if (node.type === 'text') return node.value;
    if (node.type === 'html') return { html: node.value };
    if (node.type === 'link') return { link: node.url, children: (node.children || []).map(brief) };
    if (node.type === 'image') return { image: node.url };
    if (Array.isArray(node.children)) return { [node.type]: node.children.map(brief) };
    return { [node.type]: node.value === undefined ? null : node.value };
}

/** 单个节点的描述：段落直属文本写作 text("…")，容器内的文本只写 JSON 字符串，链接写作 link(…)，其余写作 类型(…) */
function describeNode(node, top = true) {
    if (node.type === 'text') return top ? `text(${JSON.stringify(node.value)})` : JSON.stringify(node.value);
    if (node.type === 'html') return `html(${JSON.stringify(node.value)})`;
    const inner = (node.children || []).map((child) => describeNode(child, false)).join(', ');
    return `${node.type}(${inner})`;
}

const describeIr = (nodes) => `[${nodes.map((node) => describeNode(node)).join(', ')}]`;

/**
 * 行内节点序列展平为片段序列：文本片段为 { text, formats }，formats 为祖先中各格式类型与「link=地址」的集合（排序后以「+」
 * 连接）。相邻且格式集合相同的文本片段合并，空文本与值为空串的 html 节点略去；容许 liftInlineHtml 合并相邻同类节点与
 * 嵌套次序变化。其余类型的节点（残留的非空 html、图片、硬换行等）记为 { unexpected } 片段，与原 IR 的任何片段都不相等
 */
function flatten(nodes, formats = [], out = []) {
    for (const node of nodes) {
        if (node.type === 'text') {
            appendSegment(out, node.value, formats);
        } else if (FORMAT_TYPES.includes(node.type) || node.type === 'link') {
            const key = node.type === 'link' ? `link=${node.url}` : node.type;
            const next = formats.includes(key) ? formats : [...formats, key].sort();
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
    if (last && last.text !== undefined && last.formats === key) last.text += value;
    else out.push({ text: value, formats: key });
}

/** 文本的原文串接，用于核对重新解析后是否多出定界符字符 */
const plainText = (nodes) => nodes.map((node) => (node.type === 'text' ? node.value : plainText(node.children || []))).join('');

/** 重新解析 md 并与原 IR 比对：往返正确时返回 null，否则返回 { ir, md, reparsed, reasons } */
async function roundTripFailureOf(kind, children, md) {
    const tree = await reparse(md);
    const reasons = [];
    const phrasing = phrasingOf(kind, tree);
    if (!phrasing) {
        reasons.push('重新解析后不是同一种块');
    } else {
        if (!isDeepStrictEqual(flatten(phrasing), flatten(children))) reasons.push('片段序列与原 IR 不一致');
        const original = plainText(children);
        const reparsed = plainText(phrasing);
        for (const char of DELIMITER_CHARS) {
            if (!original.includes(char) && reparsed.includes(char)) reasons.push(`重新解析文本出现原文没有的「${char}」`);
        }
    }
    return reasons.length ? { ir: describeIr(children), md, reparsed: tree.children.map(brief), reasons } : null;
}

/** 逐例检查往返，返回失败项；每例为 { kind, children }，kind 缺省为 paragraph */
async function roundTripFailures(cases) {
    const failures = [];
    for (const item of cases) {
        const kind = item.kind || 'paragraph';
        const md = await renderBlock(kind, item.children);
        const failure = await roundTripFailureOf(kind, item.children, md);
        if (failure) failures.push({ ...failure, item });
    }
    return failures;
}

/** 往返失败的逐项说明：前 limit 项的块类型、IR 描述、md 产物、失败原因与重新解析结果 */
function reportLines(failures, limit = MAX_REPORTED) {
    return failures.slice(0, limit).map((f, i) => `${i + 1}. [${f.item.kind || 'paragraph'}] ${f.ir} → ${JSON.stringify(f.md)}；`
        + `${f.reasons.join('、')}；重新解析：${JSON.stringify(f.reparsed)}`);
}

/** 逐例检查往返，先收集失败项再一次断言；失败信息列出总数、失败数与前若干项 */
async function assertAllRoundTrip(label, cases) {
    const failures = await roundTripFailures(cases);
    const lines = reportLines(failures);
    assert.equal(failures.length, 0, `${label}：${cases.length} 例中 ${failures.length} 例失败，前 ${lines.length} 例：${NL}${lines.join(NL)}`);
}

/** 按键统计出错的用例：返回「键 出错数/总数」的列表，只列出错数非零的键 */
function tally(cases, failures, keyOf) {
    const failed = new Set(failures.map((f) => f.item));
    const stats = new Map();
    for (const item of cases) {
        const key = keyOf(item);
        const entry = stats.get(key) || { total: 0, failed: 0 };
        entry.total += 1;
        if (failed.has(item)) entry.failed += 1;
        stats.set(key, entry);
    }
    return [...stats].filter(([, entry]) => entry.failed > 0).map(([key, entry]) => `${key} ${entry.failed}/${entry.total}`);
}

/** 按键抽样：每个键只取首个失败项，失败信息因而覆盖各类别 */
function firstPerKey(failures, keyOf) {
    const seen = new Set();
    return failures.filter((f) => {
        const key = keyOf(f.item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// ============================================================
// 已列形态
// ============================================================

/** 任务实测的形态；各行注释为修复前（a48ad6a）的产物与重新解析的结果 */
const LISTED_SHAPES = [
    // 「<del> </del>」→ text(' ')
    { children: [del(' ')] },
    // 「甲<del> </del>乙」→ text('甲 乙')
    { children: [text('甲'), del(' '), text('乙')] },
    // 「[甲<strong> </strong>](https://a.com)」→ link('甲 ')
    { children: [link(text('甲'), strong(' '))] },
    // 「姓名：<u>      </u>」→ text('姓名：      ')：填空横线
    { children: [text('姓名：'), underline('      ')] },
    // 「甲<u>」+ 换行 +「</u>乙」→ text('甲' + 换行 + '乙')：段中只含换行的下划线
    { children: [text('甲'), underline(NL), text('乙')] },
];

// ============================================================
// 矩阵
// ============================================================

// 空白值：[标签, 值]
const WHITESPACE_VALUES = [
    ['一个半角空格', ' '],
    ['两个半角空格', '  '],
    ['六个半角空格', '      '],
    ['U+00A0', NBSP],
    ['U+3000', IDEOGRAPHIC_SPACE],
    ['半角空格夹 U+3000', ` ${IDEOGRAPHIC_SPACE} `],
];
// 格式：[标签, 由内容构造节点的工厂]
const FORMAT_FACTORIES = [
    ['strong', (value) => strong(value)],
    ['emphasis', (value) => emphasis(value)],
    ['delete', (value) => del(value)],
    ['underline', (value) => underline(value)],
    ['superscript', (value) => superscript(value)],
    ['subscript', (value) => subscript(value)],
    ['strong(underline)', (value) => strong(underline(value))],
    ['emphasis(delete)', (value) => emphasis(del(value))],
];
// 位置：[标签, 块类型, 由格式节点构造子节点序列的工厂]
const POSITIONS = [
    ['段落中单独', 'paragraph', (node) => [node]],
    ['段首', 'paragraph', (node) => [node, text('乙')]],
    ['段中', 'paragraph', (node) => [text('甲'), node, text('乙')]],
    ['段尾', 'paragraph', (node) => [text('甲'), node]],
    ['链接内单独', 'paragraph', (node) => [link(node)]],
    ['链接内文本之后', 'paragraph', (node) => [link(text('甲'), node)]],
    ['夹在两个定界符式格式之间', 'paragraph', (node) => [strong('甲'), node, emphasis('乙')]],
    ['二级标题的段中', 'heading', (node) => [text('甲'), node, text('乙')]],
    ['表格单元格的段中', 'tableCell', (node) => [text('甲'), node, text('乙')]],
];
// 对照形态用的可见内容：与空白同处一格，替换后形态本身应往返正确
const CONTROL_CONTENT = '中';

/** 矩阵各例：空白值 × 格式 × 位置，另带 control（空白换成可见内容的同一形态）与分类标签 */
function buildMatrix() {
    const cases = [];
    for (const [wsLabel, value] of WHITESPACE_VALUES) {
        for (const [formatLabel, makeFormat] of FORMAT_FACTORIES) {
            for (const [positionLabel, kind, place] of POSITIONS) {
                cases.push({
                    kind,
                    children: place(makeFormat(value)),
                    control: { kind, children: place(makeFormat(CONTROL_CONTENT)) },
                    whitespace: wsLabel,
                    format: formatLabel,
                    position: positionLabel,
                });
            }
        }
    }
    return cases;
}

// ============================================================
// 种子随机段落
// ============================================================

const RANDOM_SEED = 20260928;
const RANDOM_COUNT = 2000;
// 随机段落用的空白值：不含制表符与换行（理由见文件头的范围外说明）
const RANDOM_WHITESPACE = [' ', '  ', NBSP, IDEOGRAPHIC_SPACE, ` ${IDEOGRAPHIC_SPACE}`];
// 普通文本：汉字、中文标点、ASCII 字母、辅助平面表情、字面星号与波浪号、带首尾空格的文本；不含范围外形态
const ORDINARY_TEXTS = ['甲', '乙丙', '。', '，', '《乙》', '「甲', 'ab', 'a b', EMOJI, '（注）', '*', '~', '甲 ', ' 乙'];
// 各槽位的取值概率：只含空白的格式节点、普通文本、非空格式节点、链接，余下为两个相邻的只含空白的格式节点
const WHITESPACE_RATE = 0.3;
const TEXT_RATE = 0.35;
const FORMAT_RATE = 0.15;
const LINK_RATE = 0.1;
// 只含空白的格式节点再套一层不同类型格式的概率
const NESTED_RATE = 0.15;

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

/** 只含空白的格式节点；按 NESTED_RATE 再套一层不同类型的格式 */
function randomWhitespaceFormat(rand) {
    const type = pick(rand, FORMAT_TYPES);
    const inner = format(type)(pick(rand, RANDOM_WHITESPACE));
    if (rand() >= NESTED_RATE) return inner;
    return format(pick(rand, FORMAT_TYPES.filter((candidate) => candidate !== type)))(inner);
}

/** 非空格式节点：1–2 个子节点，各为普通文本（70%）或只含空白的格式节点，至少一个普通文本 */
function randomVisibleFormat(rand) {
    const count = 1 + Math.floor(rand() * 2);
    const children = [];
    for (let i = 0; i < count; i += 1) children.push(rand() < 0.7 ? text(pick(rand, ORDINARY_TEXTS)) : randomWhitespaceFormat(rand));
    if (!children.some((child) => child.type === 'text')) children.unshift(text(pick(rand, ORDINARY_TEXTS)));
    return format(pick(rand, FORMAT_TYPES))(...children);
}

/** 一个槽位的节点（可为两个相邻节点） */
function randomSlot(rand) {
    const roll = rand();
    if (roll < WHITESPACE_RATE) return [randomWhitespaceFormat(rand)];
    if (roll < WHITESPACE_RATE + TEXT_RATE) return [text(pick(rand, ORDINARY_TEXTS))];
    if (roll < WHITESPACE_RATE + TEXT_RATE + FORMAT_RATE) return [randomVisibleFormat(rand)];
    if (roll < WHITESPACE_RATE + TEXT_RATE + FORMAT_RATE + LINK_RATE) {
        const children = [text(pick(rand, ORDINARY_TEXTS))];
        if (rand() < 0.5) children.push(randomWhitespaceFormat(rand));
        return [link(...children)];
    }
    return [randomWhitespaceFormat(rand), randomWhitespaceFormat(rand)];
}

/** count 个段落，每段 1–6 个槽位，其中随机一个槽位必为只含空白的格式节点 */
function randomParagraphs(seed, count) {
    const rand = mulberry32(seed);
    const paragraphs = [];
    for (let k = 0; k < count; k += 1) {
        const size = 1 + Math.floor(rand() * 6);
        const forced = Math.floor(rand() * size);
        const children = [];
        for (let i = 0; i < size; i += 1) children.push(...(i === forced ? [randomWhitespaceFormat(rand)] : randomSlot(rand)));
        paragraphs.push(children);
    }
    return paragraphs;
}

// ============================================================
// 用例：已列形态
// ============================================================

test('已列形态：只含一个空格的 delete 单独成段、夹在文本之间、处在链接内，六个空格的下划线（填空横线），以及段中只含换行的下划线，共 5 例，重新解析后格式与文本均不变', async () => {
    // Arrange
    assert.equal(LISTED_SHAPES.length, 5);

    // Act & Assert
    await assertAllRoundTrip('已列形态', LISTED_SHAPES);
});

// ============================================================
// 用例：矩阵
// ============================================================

test('矩阵：6 种空白值 × 8 种格式 × 9 种位置共 432 例，对照形态（空白换成「中」）往返正确；各例重新解析后块类型、格式与文本均不变', async () => {
    // Arrange
    const cases = buildMatrix();
    assert.equal(cases.length, WHITESPACE_VALUES.length * FORMAT_FACTORIES.length * POSITIONS.length);
    const controlFailures = await roundTripFailures(cases.map((item) => item.control));
    const controlLines = reportLines(controlFailures);
    assert.equal(controlFailures.length, 0, `矩阵：对照形态 ${cases.length} 例中 ${controlFailures.length} 例往返失败（形态本身属范围外），`
        + `前 ${controlLines.length} 例：${NL}${controlLines.join(NL)}`);

    // Act
    const failures = await roundTripFailures(cases);

    // Assert：失败信息按空白值、格式与位置分别计数，每种位置列出首例
    const lines = reportLines(firstPerKey(failures, (item) => item.position), Infinity);
    assert.equal(failures.length, 0, [
        `矩阵：${cases.length} 例中往返失败 ${failures.length} 例`,
        `按空白值：${tally(cases, failures, (item) => item.whitespace).join('、')}`,
        `按格式：${tally(cases, failures, (item) => item.format).join('、')}`,
        `按位置：${tally(cases, failures, (item) => item.position).join('、')}`,
        '往返失败（每种位置首例）：', ...lines,
    ].join(NL));
});

// ============================================================
// 用例：Markdown 源文本直接解析
// ============================================================

/** md 源文本经 remark-parse + remark-gfm + liftInlineHtml 后首个块的子节点简式 */
async function liftedPhrasing(md) {
    const tree = await reparse(md);
    assert.equal(tree.children.length, 1, `${JSON.stringify(md)} 解析后应只有一个块，实际 ${tree.children.length} 个`);
    return tree.children[0].children.map(brief);
}

test('Markdown 源文本直接解析：只含空白的 <u>/<del>/<strong>/<em>/<sup>/<sub> 提升为格式节点并保留空白原文，字符引用写法解码后同样保留，嵌套的只含空白标签按层次还原，相邻的同类标签合并', async () => {
    // Act & Assert：六种标签，空白原样保留在格式节点内
    assert.deepEqual(await liftedPhrasing(`甲<u> </u>乙${NL}`), ['甲', { underline: [' '] }, '乙']);
    assert.deepEqual(await liftedPhrasing(`姓名：<u>      </u>${NL}`), ['姓名：', { underline: ['      '] }]);
    assert.deepEqual(await liftedPhrasing(`甲<del> </del>乙${NL}`), ['甲', { delete: [' '] }, '乙']);
    assert.deepEqual(await liftedPhrasing(`甲<s>${NBSP}</s>乙${NL}`), ['甲', { delete: [NBSP] }, '乙']);
    assert.deepEqual(await liftedPhrasing(`甲<strong>  </strong>乙${NL}`), ['甲', { strong: ['  '] }, '乙']);
    assert.deepEqual(await liftedPhrasing(`甲<b>${IDEOGRAPHIC_SPACE}</b>乙${NL}`), ['甲', { strong: [IDEOGRAPHIC_SPACE] }, '乙']);
    assert.deepEqual(await liftedPhrasing(`甲<em> </em>乙${NL}`), ['甲', { emphasis: [' '] }, '乙']);
    assert.deepEqual(await liftedPhrasing(`甲<sup> </sup>乙${NL}`), ['甲', { superscript: [' '] }, '乙']);
    assert.deepEqual(await liftedPhrasing(`甲<sub> </sub>乙${NL}`), ['甲', { subscript: [' '] }, '乙']);

    // Assert：字符引用在 remark 解析时即解码为空白，提升结果与直接写空白相同
    assert.deepEqual(await liftedPhrasing(`甲<del>&#32;</del>乙${NL}`), ['甲', { delete: [' '] }, '乙']);
    assert.deepEqual(await liftedPhrasing(`甲<u>&nbsp;&nbsp;</u>乙${NL}`), ['甲', { underline: [NBSP + NBSP] }, '乙']);

    // Assert：嵌套按层次还原；相邻的同类标签合并为一个节点
    assert.deepEqual(await liftedPhrasing(`<strong><u> </u></strong>${NL}`), [{ strong: [{ underline: [' '] }] }]);
    assert.deepEqual(await liftedPhrasing(`甲<u> </u><u>  </u>乙${NL}`), ['甲', { underline: ['   '] }, '乙']);
});

// ============================================================
// 用例：回归护栏（修复前后均应通过）
// ============================================================

test('回归护栏：只包着图片、图片夹空白、换行或换行夹空白的格式标签仍直接拆除，空标签对仍删除，只含可见文字的标签照常提升', async () => {
    // Act & Assert：图片与换行不承载格式，帧内夹着的空白与相邻文本合并
    assert.deepEqual(await liftedPhrasing(`<strong><img src="a.png" width="677"></strong>${NL}`), [{ image: 'a.png' }]);
    assert.deepEqual(await liftedPhrasing(`<strong> <img src="a.png" width="677"> </strong>${NL}`), [' ', { image: 'a.png' }, ' ']);
    assert.deepEqual(await liftedPhrasing(`甲<u><br></u>乙${NL}`), ['甲', { break: null }, '乙']);
    assert.deepEqual(await liftedPhrasing(`甲<u> <br> </u>乙${NL}`), ['甲 ', { break: null }, ' 乙']);
    assert.deepEqual(await liftedPhrasing(`甲<u></u>乙${NL}`), ['甲乙']);
    assert.deepEqual(await liftedPhrasing(`甲<u>下划线</u>乙${NL}`), ['甲', { underline: ['下划线'] }, '乙']);
});

// ============================================================
// 用例：种子随机往返
// ============================================================

test(`种子随机往返：种子 ${RANDOM_SEED} 生成 ${RANDOM_COUNT} 个段落（每段 1–6 个槽位且至少一个为只含空白的格式节点，其余以 ${WHITESPACE_RATE * 100}% 取只含空白的格式节点、${TEXT_RATE * 100}% 取普通文本、${FORMAT_RATE * 100}% 取非空格式节点、${LINK_RATE * 100}% 取链接，余下取两个相邻的只含空白的格式节点），逐段重新解析后格式与文本均不变`, async () => {
    // Arrange
    const cases = randomParagraphs(RANDOM_SEED, RANDOM_COUNT).map((children) => ({ children }));
    assert.equal(cases.length, RANDOM_COUNT);

    // Act & Assert
    await assertAllRoundTrip('种子随机往返', cases);
});
