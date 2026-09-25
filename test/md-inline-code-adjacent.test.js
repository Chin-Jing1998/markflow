/**
 * converters/renderers/md.js：相邻的行内代码段（inlineCode）渲染后粘连
 * 成因：mdast-util-to-markdown 2.1.2 的 inlineCode 处理器（lib/handle/inline-code.js）按值内的反引号串选定围栏长度，值以
 * 反引号开头或结尾、或首尾都是空格（且不全为空格）时首尾各补一个空格，产物为「围栏 + 值 + 围栏」；containerPhrasing 把
 * 兄弟节点的产物首尾直接拼接。两个代码段相邻时，前一段的闭围栏与后一段的开围栏连成一个更长的反引号串，其长度不等于前一
 * 段的开围栏，不能闭合前一段，重新解析时配对错位。例如修复前（d332ef0）[code(x), code(y)] 的产物为「`x``y`」，重新解析为
 * 单个代码段「x``y」；[code(a`b), code(c)] 的产物为「``a`b```c`」，重新解析为文本「``a」加代码段「b```c」。相邻的反引号
 * 总会并成同一个串，只调整围栏长度无法把两段分开。两段之间的空文本、空 html 与无内容的格式节点已由 render() 在 stringify
 * 之前剔除（d332ef0），剔除后两段同样相邻。
 * 修法：render() 在剔除空节点之后仍相邻的两个代码段之间插入空 HTML 注释，[code(x), code(y)] 的产物改为
 * 「`x`<!---->`y`」，重新解析为代码段、html(<!---->)、代码段。往返判据不绑定这一写法，理由见「断言口径」。
 * 覆盖：
 *   - 已列形态：实测确认的 7 种形态（两段、三段、值含反引号、值以反引号开头、值首尾为空格、两段之间夹空文本或无内容的
 *     strong）。
 *   - 矩阵：9 种代码值（x、a`b、`a、a`、``、首尾各一个空格的 x、单个空格、a  b、中文）的两段全排列 81 组与三段 27 组
 *     （三段按步长 0、1、4 取值），× 16 种语境：段落直属，六种格式节点与 link 内部，前后有文本，heading 与 tableCell 内，
 *     两段之间插入空文本、空 html、无内容的 strong 与 underline、嵌套的 delete(strong(text(''))) 五种空节点；共 1728 例。
 *   - 回归护栏：不相邻的 25 种形态（九种代码值各自单独成段，被文本、格式节点、链接或硬换行隔开的代码段，处在不同容器中
 *     的代码段，文本中的反引号与末尾反斜杠紧邻代码段，heading 与 tableCell 内被文本隔开的代码段），产物逐字等于 d332ef0
 *     的产物。
 *   - 种子随机往返：固定种子生成 2000 个段落，每段 1–6 个位置，各位置按 35% 取代码段串（1–3 个代码段依次相邻，相邻两段
 *     之间以 30% 的概率夹一个产物为空的节点）、15% 取产物为空的节点、25% 取文本（可含反引号与末尾反斜杠，均含非空白
 *     字符）、15% 取非空格式节点（六种），余下取链接（文本与地址不同）；容器嵌套深度 ≤ 2，链接不嵌套链接。剔除空节点后
 *     含相邻代码段的段落有 1422 个，其余段落作对照。
 * 断言口径：缺陷类用例（已列形态、矩阵、种子随机往返）逐例经 remark-parse + remark-gfm + liftInlineHtml 重新解析，断言
 * 块的类型与形状不变（段落、2 级标题或两行一列的表格），「文本 + 格式集合」与「代码 + 格式集合」片段序列与原 IR 一致
 * （链接视作带 url 的格式，产物为空的节点不产生片段），且不出现原文没有的「*」「~」。展平时略去值以「<!--」开头、以
 * 「-->」结尾的 html 节点（即 render() 插入的分隔注释），并把相邻且格式集合相同的代码片段拼接为一个。这样设计的理由：
 * 缺陷的实质是反引号串配对错位，使代码内容改变、反引号外溢为文本，判据因此只核对重新解析后代码、文本与格式的内容是否
 * 保持，不绑定分隔注释的具体写法，也不核对代码段的分段边界，合并相邻代码段的写法同样判为往返正确；其余 html 与零宽
 * 字符照常计入，以免把插入其他分隔物的写法错判为正确。已列形态与矩阵先断言对照形态（各代码段单独放入同一语境）往返
 * 正确，以确认形态本身在范围内。回归护栏逐字比对产物，并断言往返正确。
 * 范围外（矩阵与随机段落均已避开）：
 *   - 空值代码段：单独输出「``」，重新解析为文本「``」，属另一处原有问题；
 *   - 含换行的代码值：上游 inlineCode 处理器把其后紧接行首记号的换行改为空格（值「a + 换行 + # b」输出「`a # b`」），
 *     属原有行为，其余换行往返后保留；
 *   - 含「www」「@」「:」的文本（remark-gfm 在解析后的文本上识别自动链接）、段首段尾的换行、连续两个换行、制表符；
 *   - 以数字结尾或以「.」「)」开头的文本：数字与其后的「.」「)」分属两个文本节点时行首记号的判定落空，属另一缺陷，
 *     已由后续修复在数字边界合并相邻 text 处理，专测见 test/md-list-marker-split.test.js；本文件的随机文本仍避开这类
 *     文本；
 *   - 可见内容只有空白的格式节点（如 delete(" ")）：内容首尾是空白，只能写 HTML 标签，而 liftInlineHtml 把只包着空白的
 *     格式标签直接拆除（converters/ir/inline-html.js 的 wrapFrame），格式丢失；随机文本因此均含非空白字符；
 *   - root 直接挂行内节点：render() 的剔除与分隔只作用于 paragraph、heading、tableCell、行内格式与链接的子节点，root 下
 *     相邻的代码段仍粘连，与 d332ef0 的剔除范围一致。
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
// 反引号、换行与反斜杠一律以码点生成，源码中不出现转义序列与不可见字面量
const BACKTICK = String.fromCharCode(96);
const NL = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);
// 用例中链接的地址：不含空白与括号；链接文本均与之不同，产物恒为「[文本](地址)」
const LINK_URL = 'https://a.com';
// render() 在相邻代码段之间插入的分隔注释：值以 COMMENT_OPEN 开头、以 COMMENT_CLOSE 结尾的 html 节点在展平时略去
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
// heading 语境的标题级别；tableCell 语境为两行一列的表格，表头单元格为 TABLE_HEAD，代码段放在表体单元格
const HEADING_DEPTH = 2;
const TABLE_HEAD = '表头';
// 各块类型在失败信息中的名称
const BLOCK_NAMES = { paragraph: '段落', heading: `${HEADING_DEPTH} 级标题`, tableCell: '两行一列的表格' };

/** 以「^」代表反引号书写的字符串：逐个换成以码点生成的反引号；用例中的文本与期望产物均不含「^」 */
const tick = (source) => source.split('^').join(BACKTICK);

// ============================================================
// 构造、渲染与重新解析
// ============================================================

/** 容器节点的子项：字符串包装为 text 节点 */
const wrapChildren = (children) => children.map((c) => (typeof c === 'string' ? createText(c) : c));
/** 格式节点工厂：不传子项即为无内容的格式节点 */
const format = (type) => (...children) => ({ type, children: wrapChildren(children) });
const strong = format('strong');
const emphasis = format('emphasis');
const del = format('delete');
const underline = format('underline');
const text = createText;
const html = (value) => ({ type: 'html', value });
/** 链接工厂：地址恒为 LINK_URL */
const link = (...children) => ({ type: 'link', url: LINK_URL, title: null, children: wrapChildren(children) });
const inlineCode = (value) => ({ type: 'inlineCode', value });
const hardBreak = () => ({ type: 'break' });

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

async function reparse(md) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    return liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(md));
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

/**
 * 节点简式，用于失败信息：文本 → 字符串，html → { html }，行内代码 → { code }，链接另带地址，其余 → { 类型: 子节点简式 }
 */
function brief(node) {
    if (node.type === 'text') return node.value;
    if (node.type === 'html') return { html: node.value };
    if (node.type === 'inlineCode') return { code: node.value };
    if (node.type === 'link') return { link: node.url, children: (node.children || []).map(brief) };
    if (Array.isArray(node.children)) return { [node.type]: node.children.map(brief) };
    return { [node.type]: node.value === undefined ? null : node.value };
}

/**
 * 单个节点的描述：块直属文本写作 text("…")，容器内的文本只写 JSON 字符串；空文本写作 text('')、空 html 写作 html('')；
 * 行内代码写作 code("…")；链接只写子节点，如 link(code("x"))；硬换行写作 break()
 */
function describeNode(node, top = true) {
    if (node.type === 'text') {
        if (!node.value) return "text('')";
        return top ? `text(${JSON.stringify(node.value)})` : JSON.stringify(node.value);
    }
    if (node.type === 'html') return node.value ? `html(${JSON.stringify(node.value)})` : "html('')";
    if (node.type === 'inlineCode') return `code(${JSON.stringify(node.value)})`;
    const inner = (node.children || []).map((child) => describeNode(child, false)).join(', ');
    return `${node.type}(${inner})`;
}

/** 用例描述：段落写作行内子节点列表，heading 与 tableCell 另冠块类型，如 heading[code("x"), code("y")] */
function describeCase(kind, nodes) {
    const list = `[${nodes.map((node) => describeNode(node)).join(', ')}]`;
    return kind === 'paragraph' ? list : `${kind}${list}`;
}

/**
 * 展平时略去的 html 节点：值为空串（产物为空），或值以 COMMENT_OPEN 开头、以 COMMENT_CLOSE 结尾（render() 插入的分隔
 * 注释）；以 startsWith 与 endsWith 判定，不用正则
 */
const isSkippedHtml = (node) => node.type === 'html'
    && (!node.value || (node.value.startsWith(COMMENT_OPEN) && node.value.endsWith(COMMENT_CLOSE)));

/**
 * 行内节点序列展平为片段序列：文本片段为 { text, formats }，代码片段为 { code, formats }，formats 为祖先中各格式类型与
 * 「link=地址」的集合（排序后以「+」连接）。相邻且格式集合相同的文本片段合并，相邻且格式集合相同的代码片段同样拼接为
 * 一个，同一内容无论是单个代码段还是分成多段，都得出同一序列（分段边界不在核对之列，理由见文件头「断言口径」）；空文本
 * 与 isSkippedHtml 所指的 html 节点略去，产物为空的节点与 render() 插入的分隔注释因而不产生片段。其余类型的节点（其余
 * html、图片、硬换行等）记为 { unexpected } 片段，只与原 IR 同一位置的同类节点相等；零宽字符作普通文本计入。插入其他
 * html 或零宽字符作分隔物的写法因而判为不一致
 */
function flatten(nodes, formats = [], out = []) {
    for (const node of nodes) {
        if (node.type === 'text') {
            appendSegment(out, 'text', node.value, formats);
        } else if (node.type === 'inlineCode') {
            appendSegment(out, 'code', node.value, formats);
        } else if (FORMAT_TYPES.includes(node.type) || node.type === 'link') {
            const key = node.type === 'link' ? `link=${node.url}` : node.type;
            const next = formats.includes(key) ? formats : [...formats, key].sort();
            flatten(node.children || [], next, out);
        } else if (!isSkippedHtml(node)) {
            out.push({ unexpected: node.type, value: node.value });
        }
    }
    return out;
}

/** 追加 field（'text' 或 'code'）片段：末个片段同为该类且格式集合相同时拼接，否则另起一个；空值不产生片段 */
function appendSegment(out, field, value, formats) {
    if (!value) return;
    const key = formats.join('+');
    const last = out[out.length - 1];
    if (last && last[field] !== undefined && last.formats === key) last[field] += value;
    else out.push({ [field]: value, formats: key });
}

/** 文本与行内代码的原文串接，用于核对重新解析后是否多出定界符字符 */
const plainText = (nodes) => nodes.map((node) => {
    if (node.type === 'text' || node.type === 'inlineCode') return node.value;
    return plainText(node.children || []);
}).join('');

/** 重新解析 md 并与原 IR 比对：往返正确时返回 null，否则返回 { ir, md, reparsed, reasons } */
async function roundTripFailureOf(kind, children, md) {
    const tree = await reparse(md);
    const reasons = [];
    const phrasing = phrasingOf(kind, tree);
    if (!phrasing) {
        reasons.push(`重新解析后不是单个${BLOCK_NAMES[kind]}`);
    } else {
        if (!isDeepStrictEqual(flatten(phrasing), flatten(children))) reasons.push('片段序列与原 IR 不一致');
        const original = plainText(children);
        const reparsed = plainText(phrasing);
        for (const char of DELIMITER_CHARS) {
            if (!original.includes(char) && reparsed.includes(char)) reasons.push(`重新解析文本出现原文没有的「${char}」`);
        }
    }
    return reasons.length ? { ir: describeCase(kind, children), md, reparsed: tree.children.map(brief), reasons } : null;
}

/**
 * 渲染单个块并重新解析，返回 { md, failure }：往返正确时 failure 为 null。比对基准取渲染前的深拷贝，修法若就地改动入参
 * （如就地合并或改写代码值），不会连同基准一起改掉而掩盖错误
 */
async function renderAndReparse(kind, children) {
    const original = structuredClone(children);
    const md = await renderBlock(kind, children);
    return { md, failure: await roundTripFailureOf(kind, original, md) };
}

/** 逐例检查往返，返回失败项；各失败项另带原用例 item，供分类计数 */
async function roundTripFailures(cases) {
    const failures = [];
    for (const item of cases) {
        const { failure } = await renderAndReparse(item.kind, item.children);
        if (failure) failures.push({ ...failure, item });
    }
    return failures;
}

/** 往返失败的逐项说明：前 limit 项的用例描述、md 产物、失败原因与重新解析结果 */
function reportLines(failures, limit = MAX_REPORTED) {
    return failures.slice(0, limit).map((f, i) => `${i + 1}. ${f.ir} → ${JSON.stringify(f.md)}；`
        + `${f.reasons.join('、')}；重新解析：${JSON.stringify(f.reparsed)}`);
}

/** 逐例检查往返，先收集失败项再一次断言；失败信息列出总数、失败数与前若干项 */
async function assertAllRoundTrip(label, cases) {
    const failures = await roundTripFailures(cases);
    const lines = reportLines(failures);
    assert.equal(failures.length, 0, `${label}：${cases.length} 例中 ${failures.length} 例失败，前 ${lines.length} 例：${NL}${lines.join(NL)}`);
}

/** 先断言对照形态（各代码段单独放入同一语境）往返正确：对照形态本身出错时该形态属范围外，不能用来判定相邻的影响 */
async function assertControlsRoundTrip(label, controls) {
    const failures = await roundTripFailures(controls);
    const lines = reportLines(failures);
    assert.equal(failures.length, 0, `${label}：对照形态 ${controls.length} 例中 ${failures.length} 例往返失败（形态本身属范围外），`
        + `前 ${lines.length} 例：${NL}${lines.join(NL)}`);
}

/** 按键抽样：每个键只取首个失败项，失败信息因而覆盖各类别，不被同一语境的用例占满 */
function firstPerKey(failures, keyOf) {
    const seen = new Set();
    return failures.filter((f) => {
        const key = keyOf(f.item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** 按键统计出错的用例：返回「键 出错数/总数」的列表，只列出错数非零的键 */
function tally(cases, failedItems, keyOf) {
    const stats = new Map();
    for (const item of cases) {
        const key = keyOf(item);
        const entry = stats.get(key) || { total: 0, failed: 0 };
        entry.total += 1;
        if (failedItems.has(item)) entry.failed += 1;
        stats.set(key, entry);
    }
    return [...stats].filter(([, entry]) => entry.failed > 0).map(([key, entry]) => `${key} ${entry.failed}/${entry.total}`);
}

/**
 * 一次断言往返结果。breakdowns 为 [标题, keyOf] 列表，按键列出出错的用例数；给出 sampleBy 时失败信息每个键列出首例，
 * 否则列出前 MAX_REPORTED 例
 */
function assertNoFailures(label, cases, failures, { breakdowns = [], sampleBy = null } = {}) {
    const failedItems = new Set(failures.map((f) => f.item));
    const summary = breakdowns.map(([title, keyOf]) => `${title}：${tally(cases, failedItems, keyOf).join('、')}`);
    const lines = sampleBy ? reportLines(firstPerKey(failures, sampleBy), Infinity) : reportLines(failures);
    const scope = sampleBy ? '每类首例' : `前 ${lines.length} 例`;
    assert.equal(failures.length, 0, [
        `${label}：${cases.length} 例中往返失败 ${failures.length} 例`,
        ...summary,
        `往返失败（${scope}）：`, ...lines,
    ].join(NL));
}

/** 逐例比对产物与期望值，先收集不符项再一次断言；失败信息列出前若干项的用例描述、实际产物与期望产物 */
async function assertOutputs(label, cases) {
    const mismatches = [];
    for (const { kind, children, md: expected } of cases) {
        const md = await renderBlock(kind, children);
        if (md !== expected) mismatches.push(`${describeCase(kind, children)} → ${JSON.stringify(md)}；期望 ${JSON.stringify(expected)}`);
    }
    const lines = mismatches.slice(0, MAX_REPORTED).map((line, i) => `${i + 1}. ${line}`);
    assert.equal(mismatches.length, 0, `${label}：${cases.length} 例中 ${mismatches.length} 例产物与期望不符，前 ${lines.length} 例：`
        + `${NL}${lines.join(NL)}`);
}

// ============================================================
// 语境与相邻形态
// ============================================================

/** 语境：name 为名称，kind 为块类型，wrap 把代码段列表放进该语境，返回块的行内子节点；每次调用新建节点 */
const context = (name, kind, wrap) => ({ name, kind, wrap });
/** 相邻代码段之间逐处插入 make() 新建的节点 */
const interleave = (codes, make) => codes.flatMap((code, i) => (i === 0 ? [code] : [make(), code]));
/** 两段之间插入产物为空的节点：render() 先行剔除该节点，剔除后两段仍相邻 */
const betweenContext = (name, make) => context(`两段之间插入 ${name}`, 'paragraph', (codes) => interleave(codes, make));

const DIRECT = context('段落直属', 'paragraph', (codes) => codes);
// 两段之间插入的空节点：空文本、空 html、无内容的定界符式与标签式格式节点、嵌套的空格式节点
const EMPTY_SEPARATORS = [
    ["text('')", () => text('')],
    ["html('')", () => html('')],
    ['strong()', () => strong()],
    ['underline()', () => underline()],
    ["delete(strong(text('')))", () => del(strong(text('')))],
];
const CONTEXTS = [
    DIRECT,
    ...FORMAT_TYPES.map((type) => context(`${type} 内部`, 'paragraph', (codes) => [format(type)(...codes)])),
    context('link 内部', 'paragraph', (codes) => [link(...codes)]),
    context('前后有文本', 'paragraph', (codes) => [text('前'), ...codes, text('后')]),
    context('heading 内', 'heading', (codes) => codes),
    context('tableCell 内', 'tableCell', (codes) => codes),
    ...EMPTY_SEPARATORS.map(([name, make]) => betweenContext(name, make)),
];

/**
 * 语境 ctx 中值为 values 的代码段依次相邻的用例；controls 为各代码段单独放入同一语境的对照形态，另记语境名称与段数，
 * 供分类计数
 */
function adjacent(ctx, values) {
    return {
        kind: ctx.kind,
        children: ctx.wrap(values.map(inlineCode)),
        controls: values.map((value) => ({ kind: ctx.kind, children: ctx.wrap([inlineCode(value)]) })),
        context: ctx.name,
        segments: values.length,
    };
}

// ============================================================
// 已列形态
// ============================================================

/** 实测确认的 7 种形态；各行注释为修复前（d332ef0）的产物与重新解析的结果 */
function listedShapes() {
    return [
        // 「`x``y`」：重新解析为单个代码段「x``y」
        adjacent(DIRECT, ['x', 'y']),
        // 「`x``y``z`」：重新解析为单个代码段「x``y``z」
        adjacent(DIRECT, ['x', 'y', 'z']),
        // 「``a`b```c`」：前一段的闭围栏与后一段的开围栏并成三个反引号，重新解析为文本「``a」加代码段「b```c」
        adjacent(DIRECT, [tick('a^b'), 'c']),
        // 「`` `a ```b`」：重新解析为文本「`` 」加代码段「a ```b」
        adjacent(DIRECT, [tick('^a'), 'b']),
        // 「`  x  ``y`」：重新解析为单个代码段「  x  ``y」
        adjacent(DIRECT, [' x ', 'y']),
        // 空文本先被剔除，产物与重新解析的结果同 [code(x), code(y)]
        adjacent(betweenContext("text('')", () => text('')), ['x', 'y']),
        // 无内容的 strong 先被剔除，同上
        adjacent(betweenContext('strong()', () => strong()), ['x', 'y']),
    ];
}

// ============================================================
// 矩阵
// ============================================================

// 代码值：普通字母、值内含单个反引号（居中、开头、结尾）、值为两个反引号、首尾各一个空格、单个空格、内部连续空格、汉字；
// 不取空值与含换行的值（范围外）
const CODE_VALUES = ['x', tick('a^b'), tick('^a'), tick('a^'), tick('^^'), ' x ', ' ', 'a  b', '中文'];
// 三段取值的步长：第 i 组为 CODE_VALUES 的第 i、i+s、i+2s 项（下标模 9），步长 0 为同值三段
const TRIPLE_STEPS = [0, 1, 4];

/** 相邻代码段的取值组：两段取 CODE_VALUES 的全部有序对，三段按 TRIPLE_STEPS 每个步长取 9 组 */
function valueRuns() {
    const size = CODE_VALUES.length;
    const pairs = CODE_VALUES.flatMap((a) => CODE_VALUES.map((b) => [a, b]));
    const triples = TRIPLE_STEPS.flatMap((step) => CODE_VALUES.map((_, i) => [0, 1, 2].map((k) => CODE_VALUES[(i + k * step) % size])));
    return [...pairs, ...triples];
}

/** 矩阵各例：语境 × 取值组 */
function buildMatrix() {
    return CONTEXTS.flatMap((ctx) => valueRuns().map((values) => adjacent(ctx, values)));
}

/** 矩阵的对照形态：每种语境中每个代码值单独成段 */
function matrixControls() {
    return CONTEXTS.flatMap((ctx) => CODE_VALUES.map((value) => ({ kind: ctx.kind, children: ctx.wrap([inlineCode(value)]) })));
}

// ============================================================
// 回归护栏
// ============================================================

/** 段落用例：期望产物以「^」代表反引号书写，末尾补段尾换行 */
const paragraphCase = (children, md) => ({ kind: 'paragraph', children, md: `${tick(md)}${NL}` });

// 不相邻的形态：期望值取自修复前（d332ef0）的实际产物
const GUARD_CASES = [
    // 单个代码段：九种代码值各自的围栏长度与首尾补空格
    paragraphCase([inlineCode('x')], '^x^'),
    paragraphCase([inlineCode(tick('a^b'))], '^^a^b^^'),
    paragraphCase([inlineCode(tick('^a'))], '^^ ^a ^^'),
    paragraphCase([inlineCode(tick('a^'))], '^^ a^ ^^'),
    paragraphCase([inlineCode(tick('^^'))], '^ ^^ ^'),
    paragraphCase([inlineCode(' x ')], '^  x  ^'),
    paragraphCase([inlineCode(' ')], '^ ^'),
    paragraphCase([inlineCode('a  b')], '^a  b^'),
    paragraphCase([inlineCode('中文')], '^中文^'),
    // 被文本、格式节点、链接或硬换行隔开的代码段
    paragraphCase([text('a'), inlineCode('x'), text('b')], 'a^x^b'),
    paragraphCase([inlineCode('x'), text(' '), inlineCode('y')], '^x^ ^y^'),
    paragraphCase([inlineCode('x'), text('、'), inlineCode('y')], '^x^、^y^'),
    paragraphCase([inlineCode('x'), strong('y')], '^x^**y**'),
    paragraphCase([inlineCode('x'), strong('y'), inlineCode('z')], '^x^**y**^z^'),
    paragraphCase([inlineCode('x'), underline('乙'), inlineCode('y')], '^x^<u>乙</u>^y^'),
    paragraphCase([inlineCode('x'), link('乙'), inlineCode('y')], `^x^[乙](${LINK_URL})^y^`),
    paragraphCase([inlineCode('x'), hardBreak(), inlineCode('y')], `^x^${BACKSLASH}${NL}^y^`),
    // 处在不同容器中的代码段：产物之间隔着定界符或链接语法，不相邻
    paragraphCase([strong(inlineCode('x')), inlineCode('y')], '**^x^**^y^'),
    paragraphCase([inlineCode('x'), emphasis(inlineCode('y'))], '^x^*^y^*'),
    paragraphCase([link(inlineCode('x')), inlineCode('y')], `[^x^](${LINK_URL})^y^`),
    // 文本中的反引号逐个转义，只含一个反引号的文本同样隔开两段；以反斜杠结尾的文本紧邻代码段时，反斜杠按代码段 peek
    // 报出的反引号转义
    paragraphCase([inlineCode('x'), text(BACKTICK), inlineCode('y')], `^x^${BACKSLASH}^^y^`),
    paragraphCase([text(tick('a^')), inlineCode('x'), text(tick('^b'))], `a${BACKSLASH}^^x^${BACKSLASH}^b`),
    paragraphCase([text(`甲${BACKSLASH}`), inlineCode('x')], `甲${BACKSLASH}${BACKSLASH}^x^`),
    // heading 与 tableCell 内被文本隔开的代码段
    { kind: 'heading', children: [inlineCode('x'), text(' '), inlineCode('y')], md: `${tick('## ^x^ ^y^')}${NL}` },
    {
        kind: 'tableCell',
        children: [inlineCode('x'), text('、'), inlineCode('y')],
        md: `${tick(`| ${TABLE_HEAD}      |${NL}| ------- |${NL}| ^x^、^y^ |`)}${NL}`,
    },
];

// ============================================================
// 种子随机段落
// ============================================================

// 随机文本：含反引号的文本（渲染时逐个转义）、首尾空白、以反斜杠结尾的文本、段首记号与普通文本。避开范围外形态：不含
// 「w」「@」「:」，不含制表符与换行；另避开已有专测的数字记号切分形态：不以数字结尾，不以「.」「)」开头（专测见
// test/md-list-marker-split.test.js）；各项均含非空白字符，格式节点因而不会只包着空白
const RANDOM_TEXTS = [
    BACKTICK, tick('^^'), tick('甲^'), tick('^乙'), tick('a^b'),
    '甲 ', ' 乙', `甲${BACKSLASH}`, BACKSLASH,
    '# 标题', '- 项', '> 引', '甲!', '&', '甲<',
    '甲', '乙丙', 'ab', 'a b', '，', '（注）', '*', '~',
];
// 含换行的文本：只作段落直属文本，每段至多一个，因而不会出现连续两个换行
const NEWLINE_TEXTS = [`甲${NL}`, `${NL}乙`];
const RANDOM_SEED = 20260925;
const RANDOM_COUNT = 2000;
// 各位置的取值概率：代码段串、产物为空的节点、文本、非空格式节点，余下为链接
const CODE_RUN_RATE = 0.35;
const EMPTY_RATE = 0.15;
const TEXT_RATE = 0.25;
const FORMAT_RATE = 0.15;
// 代码段串的段数上限；串内相邻两段之间夹一个产物为空的节点的概率
const MAX_RUN = 3;
const GAP_RATE = 0.3;
// 抽中文本时改取含换行文本的概率（仅段落直属、每段至多一次）
const NEWLINE_RATE = 0.15;
// 容器（格式节点与链接）的嵌套深度上限：深度达到该值的位置不再取格式节点与链接
const MAX_DEPTH = 2;

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
 * 产物为空的节点：四分之一为空文本，五分之一为空 html，其余为六种格式之一的空格式节点，其子节点无、只含空文本、只含
 * 空 html、只含一个无内容的格式节点四种（最后一种只在深度 0 出现）；深度达到上限时空格式节点一律改为空 html
 */
function randomEmpty(rand, depth) {
    const roll = rand();
    if (roll < 0.25) return text('');
    if (roll < 0.45 || depth >= MAX_DEPTH) return html('');
    const type = pick(rand, FORMAT_TYPES);
    const shapeRoll = rand();
    if (shapeRoll < 0.4) return format(type)();
    if (shapeRoll < 0.7) return format(type)(text(''));
    if (shapeRoll < 0.85 || depth > 0) return format(type)(html(''));
    return format(type)(format(pick(rand, FORMAT_TYPES))());
}

/** 代码段串：1–MAX_RUN 个代码段依次相邻，相邻两段之间以 GAP_RATE 的概率夹一个产物为空的节点（剔除后仍相邻） */
function randomCodeRun(rand, depth) {
    const count = 1 + Math.floor(rand() * MAX_RUN);
    const nodes = [];
    for (let i = 0; i < count; i += 1) {
        if (i > 0 && rand() < GAP_RATE) nodes.push(randomEmpty(rand, depth));
        nodes.push(inlineCode(pick(rand, CODE_VALUES)));
    }
    return nodes;
}

/** 文本：段落直属且本段尚未用过含换行文本时，以 NEWLINE_RATE 的概率取含换行文本，否则取自 RANDOM_TEXTS */
function randomText(rand, depth, ctx) {
    if (depth === 0 && !ctx.newlineUsed && rand() < NEWLINE_RATE) {
        ctx.newlineUsed = true;
        return text(pick(rand, NEWLINE_TEXTS));
    }
    return text(pick(rand, RANDOM_TEXTS));
}

/**
 * 一个位置上的行内节点（代码段串可含多个节点）：按 CODE_RUN_RATE、EMPTY_RATE、TEXT_RATE、FORMAT_RATE 依次取代码段串、
 * 产物为空的节点、文本与含 1–3 个位置的格式节点，余下为链接。深度达到上限时格式节点与链接改取文本；链接之内不再嵌套
 * 链接，改取格式节点。链接的首个子节点为非空文本（与地址不同），另以 50% 的概率再接一个位置
 */
function randomPosition(rand, depth, ctx) {
    const roll = rand();
    if (roll < CODE_RUN_RATE) return randomCodeRun(rand, depth);
    if (roll < CODE_RUN_RATE + EMPTY_RATE) return [randomEmpty(rand, depth)];
    if (roll < CODE_RUN_RATE + EMPTY_RATE + TEXT_RATE || depth >= MAX_DEPTH) return [randomText(rand, depth, ctx)];
    if (roll < CODE_RUN_RATE + EMPTY_RATE + TEXT_RATE + FORMAT_RATE || ctx.inLink) {
        const type = pick(rand, FORMAT_TYPES);
        const count = 1 + Math.floor(rand() * 3);
        const children = [];
        for (let i = 0; i < count; i += 1) children.push(...randomPosition(rand, depth + 1, ctx));
        return [format(type)(...children)];
    }
    const children = [text(pick(rand, RANDOM_TEXTS))];
    if (rand() < 0.5) children.push(...randomPosition(rand, depth + 1, { ...ctx, inLink: true }));
    return [link(...children)];
}

/**
 * 行内节点的产物是否为空，与渲染器的判定一致：text 与 html 看 value 是否为空串；六种格式节点在全部子节点产物为空时
 * 为空（无子节点视同为空）；链接、行内代码与其余类型一律视为非空
 */
function isEmptyOutput(node) {
    if (node.type === 'text' || node.type === 'html') return !node.value;
    if (!FORMAT_TYPES.includes(node.type)) return false;
    return !Array.isArray(node.children) || node.children.every(isEmptyOutput);
}

/**
 * count 个段落，每段 1–6 个位置；只由空节点构成的段落补一个代码段，避开产物为空串的段落；可见文本以换行开头或结尾时
 * 在段首补「前」、段尾补「后」，避开解析器丢弃的段首段尾换行
 */
function randomParagraphs(seed, count) {
    const rand = mulberry32(seed);
    const paragraphs = [];
    for (let k = 0; k < count; k += 1) {
        const size = 1 + Math.floor(rand() * 6);
        const ctx = { newlineUsed: false, inLink: false };
        const children = [];
        for (let i = 0; i < size; i += 1) children.push(...randomPosition(rand, 0, ctx));
        if (children.every(isEmptyOutput)) children.push(inlineCode(pick(rand, CODE_VALUES)));
        const visible = plainText(children);
        if (visible.startsWith(NL)) children.unshift(text('前'));
        if (visible.endsWith(NL)) children.push(text('后'));
        paragraphs.push(children);
    }
    return paragraphs;
}

/**
 * 参照剔除：本文件独立实现的「去掉产物为空的节点」，不调用渲染器的内部函数。去掉 value 为空串的 text 与 html，以及子
 * 节点去掉之后已无子节点的六种格式节点；链接只剔除其子节点、不剔除自身。返回新数组，不修改入参
 */
function referencePrune(nodes) {
    const out = [];
    for (const node of nodes) {
        if ((node.type === 'text' || node.type === 'html') && !node.value) continue;
        if (!Array.isArray(node.children)) {
            out.push(node);
            continue;
        }
        const children = referencePrune(node.children);
        if (FORMAT_TYPES.includes(node.type) && children.length === 0) continue;
        out.push({ ...node, children });
    }
    return out;
}

/** 同一父节点下是否有两个相邻的行内代码段（任意深度） */
function hasAdjacentCodes(nodes) {
    return nodes.some((node, i) => (node.type === 'inlineCode' && i > 0 && nodes[i - 1].type === 'inlineCode')
        || (Array.isArray(node.children) && hasAdjacentCodes(node.children)));
}

// ============================================================
// 用例：已列形态
// ============================================================

test('已列形态：相邻代码段的 7 种形态（两段、三段、值含反引号、值以反引号开头、值首尾为空格、两段之间夹空文本或无内容的 strong），对照形态往返正确；各例重新解析后代码段的内容、文本与格式均不变（合并为一段或以 HTML 注释分隔均可）', async () => {
    // Arrange
    const shapes = listedShapes();
    assert.equal(shapes.length, 7);
    await assertControlsRoundTrip('已列形态', shapes.flatMap((item) => item.controls));

    // Act
    const failures = await roundTripFailures(shapes);

    // Assert
    assertNoFailures('已列形态', shapes, failures);
});

// ============================================================
// 用例：矩阵
// ============================================================

test('矩阵：9 种代码值的两段全排列 81 组与三段 27 组 × 16 种语境（段落直属、六种格式节点与 link 内部、前后有文本、heading 与 tableCell 内、两段之间插入五种空节点），对照形态往返正确；各例重新解析后代码段的内容、文本与格式均不变', async () => {
    // Arrange
    const cases = buildMatrix();
    assert.equal(CONTEXTS.length, 16);
    assert.equal(valueRuns().length, 108);
    assert.equal(cases.length, CONTEXTS.length * 108);
    await assertControlsRoundTrip('矩阵', matrixControls());

    // Act
    const failures = await roundTripFailures(cases);

    // Assert：失败信息按语境与段数分别计数，每种语境列出首例
    const byContext = (item) => item.context;
    assertNoFailures('矩阵', cases, failures, {
        breakdowns: [['按语境', byContext], ['按段数', (item) => `${item.segments} 段`]],
        sampleBy: byContext,
    });
});

// ============================================================
// 用例：回归护栏（修复前后均应通过）
// ============================================================

test('回归护栏：不相邻的 25 种形态（九种代码值各自单独成段，被文本、格式节点、链接或硬换行隔开的代码段，处在不同容器中的代码段，文本中的反引号与末尾反斜杠紧邻代码段，heading 与 tableCell 内被文本隔开的代码段）产物逐字等于 d332ef0 的产物，且往返正确', async () => {
    // Arrange：期望值取自修复前（d332ef0）的实际产物
    assert.equal(GUARD_CASES.length, 25);

    // Act & Assert
    await assertOutputs('回归护栏', GUARD_CASES);
    await assertAllRoundTrip('回归护栏', GUARD_CASES);
});

// ============================================================
// 用例：种子随机往返
// ============================================================

test(`种子随机往返：种子 ${RANDOM_SEED} 生成 ${RANDOM_COUNT} 个段落（每段 1–6 个位置，各位置以 ${CODE_RUN_RATE * 100}% 的概率取 1–${MAX_RUN} 个依次相邻的代码段，其余取自含反引号的文本、各类空节点、非空格式节点与链接，容器嵌套深度 ≤ ${MAX_DEPTH}），各段重新解析后代码段的内容、文本、格式与链接均不变`, async () => {
    // Arrange：剔除空节点后含相邻代码段的段落数随生成器固定
    const cases = randomParagraphs(RANDOM_SEED, RANDOM_COUNT);
    const adjacentCases = new Set(cases.filter((children) => hasAdjacentCodes(referencePrune(children))));
    assert.equal(cases.length, RANDOM_COUNT);
    assert.equal(adjacentCases.size, 1422);

    // Act
    const failures = [];
    for (const children of cases) {
        const { failure } = await renderAndReparse('paragraph', children);
        if (failure) failures.push({ ...failure, adjacent: adjacentCases.has(children) });
    }

    // Assert：失败信息按段落是否含相邻代码段分别计数
    const inAdjacent = failures.filter((f) => f.adjacent);
    const others = failures.filter((f) => !f.adjacent);
    const adjacentLines = reportLines(inAdjacent);
    const otherLines = reportLines(others);
    assert.equal(failures.length, 0, [
        `种子随机往返：${cases.length} 段中往返失败 ${failures.length} 段；剔除空节点后含相邻代码段的 ${adjacentCases.size} 段中失败 `
            + `${inAdjacent.length} 段，其余 ${cases.length - adjacentCases.size} 段中失败 ${others.length} 段`,
        `含相邻代码段的段落（前 ${adjacentLines.length} 段）：`, ...adjacentLines,
        `其余段落（前 ${otherLines.length} 段）：`, ...otherLines,
    ].join(NL));
});
