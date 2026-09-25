/**
 * converters/renderers/md.js：同一个 text 内一行只有「数字 + .」「-」或「+」、下一行又以同种记号开头时，第二行的记号不转义
 * 成因：mdast-util-to-markdown 2.1.2 lib/unsafe.js 中三条行首记号模式的 after 可含换行——第 93 行「+」的 after 为
 * (?:[ \t\r\n])，第 96 行「-」的 after 为 (?:[ \t\r\n-])，第 98 行「数字 + .」的 after 为 (?:[ \t\r\n]|$)。
 * lib/util/compile-pattern.js 把 after 编译为消耗性的 (?:after)，lib/util/safe.js 对每条模式各做一次全局 exec 循环：一行
 * 只有记号时，记号之后紧接的换行被吃进 after，下一次匹配从换行之后起步，下一行开头缺少 atBreak 所需的 [\r\n]，同一模式
 * 在下一行的记号不再匹配。两侧只有第一行转义，第二行的记号原样写出：「0.」加换行加「1. 项」写作「0\.」加换行加「1. 项」，
 * 第二行重新解析为有序列表；「-」加换行加「- 项」、「+」加换行加「+ 项」同理成为无序列表；「甲」加换行加「-」加换行加「-」
 * 的第三行成为 setext 标题下划线，整段成为二级标题；连续多行只有记号时第 1、3、5…行转义、第 2、4、6…行不转义。「)」模式
 * 没有 after、「*」另有行内规则恒转义，不受影响；记号之后有空格或制表符时 after 吃掉的是空白而非换行，也不受影响。
 * 数字与「.」分属相邻 text、而「.」与下一行同在后一节点时（如 [text('1'), text('.' + 换行 + '1. 项')]），a48ad6a 在数字
 * 边界合并后即成此形态：合并前第一行成为列表，合并后第二行成为列表。含换行的 1–2 级标题被 formatHeadingAsSetext 强制写成
 * setext，标题内容按段落语境转义，故标题内同样可达。inlineCode 处理器（lib/handle/inline-code.js）用同一组 atBreak 模式
 * 把值内「换行 + 记号」的换行改为空格，同样漏掉第二行：code('a' + 换行 + '0.' + 换行 + '1. y') 写作「`a 0.」加换行加「1. y`」，
 * 第二行成为列表、代码段被拆散。
 * 修法：render() 经 remark-stringify 的 unsafe 选项补入三条同构模式，只把 after 改为前瞻 (?=…)：前瞻不消耗换行，下一次匹配
 * 仍能从该换行起步。三条模式匹配的位置是默认模式的超集，多出的只有被吃掉换行的位置，重复位置由 safe() 去重且标记相同，
 * 产物只在缺陷形态上改变；inlineCode 处理器同样遍历补入的模式，把默认模式漏掉的换行改为空格。
 * 覆盖：
 *   - 已列形态：实测确认出错的 12 种形态，产物逐字比对并断言往返。
 *   - 矩阵：第一行只有记号 6 种（1.、0.、12.、123456789.、-、+）× 同种记号的第二行（「.」4 种：1. 项、1.、2. 项、12. 项；
 *     「-」5 种：- 项、-、--、---、- - 项；「+」2 种：+ 项、+）共 23 对，× 13 种语境（段首、前文同节点以换行结尾、前一文本以
 *     换行结尾、硬换行之后、段首空节点之后、六种格式节点与链接内换行之后、二级标题），另加「.」16 对的数字边界合并形态
 *     （[text(数字), text('.' + 换行 + 第二行)]），共 315 例。其中第二行能打断段落（1. 项、- 项、- - 项、+ 项）或单个「-」
 *     构成 setext 下划线的 101 例修复前往返出错；第二行为空列表项（1.、+）或起始编号不是 1（2. 项、12. 项）的 146 例修复前
 *     往返正确、只是第二行不转义，一并断言以锁定修复后的写法；其余 68 例修复前后产物相同——「--」「---」由 remark-gfm 表格
 *     扩展的分隔行模式（atBreak「-」后接「:|-」，after 不含换行）转义，容器内的「-」「+」「1.」之后紧接闭定界符、闭标签
 *     或「]」而不是换行，本就不是记号。
 *   - 回归护栏：不受影响的形态 28 种（「)」「*」记号、跨模式的两行、记号后有空格、--、-x、1.x、单行、CR LF、段首粗体内、
 *     切在换行处的两行、「#」「>」「=」等无 after 的模式、只含一处换行的代码值）产物逐字等于 a48ad6a 的产物。
 *   - 行首有空格的两行：修复前空格编码为 &#x20; 已使第二行不成列表，修复后第二行的记号另加转义；只断言往返与写法一致。
 *   - inlineCode：值内「换行 + 只有记号的行 + 换行 + 以记号开头的行」4 种形态改为空格，产物逐字比对并断言重新解析后仍是
 *     单个代码段；3 种不受影响的代码值产物不变。
 *   - 种子随机往返：固定种子生成 2000 个段落，每段 1–5 个可见项（多行文本、六种格式节点、链接），行池以只有记号的行与
 *     以记号开头的行为主，文本按 60% 在随机码点处切成 2–4 个相邻 text 并按 30% 插入空节点，可见项之间按比例插入硬换行与
 *     空节点，容器嵌套深度 ≤ 2。逐例往返正确。
 * 断言口径：往返正确指逐例经 remark-parse + remark-gfm + liftInlineHtml 重新解析后只有一个段落（或同级标题），「文本 + 格式
 * 集合」片段序列与原 IR 一致（链接视作带 url 的格式，硬换行视作原子片段，相邻 text 与产物为空的节点不影响片段序列），且
 * 不出现原文没有的「*」「~」。写法一致指产物逐字等于同一 IR 在两行之间的换行之后切成相邻 text 的产物：切在换行处的两个节点
 * 各自转义，修复前即往返正确（见 md-list-marker-split.test.js 的两行记号护栏），修复后单个节点与切开的节点产物相同，节点
 * 边界落在哪一行不再影响转义。
 * 范围外（修复前后都会出错，或属解析器的固有行为）：
 *   - 含「www」「@」「:」的文本：remark-gfm 在解析后的文本上识别自动链接，转义拦不住；
 *   - 段首或段尾的换行、连续两个换行：解析器丢弃或分段；
 *   - 段尾的硬换行：本文件写就时属范围外——产物以「\ + 换行」收尾，重新解析为字面反斜杠——现已由 render() 把段落与标题
 *     末尾连续的硬换行改写为 <br> 修复，覆盖见 test/md-trailing-break.test.js；本文件仍只在可见项之间插入硬换行；
 *   - 3 级以上标题与表格单元格内的换行：编码为 &#xA;，内容只有一行，不涉及行首记号；
 *   - 代码值内的换行：记号之前的换行改为空格，其余换行原样写出，重新解析后的代码值随之改变，属 inlineCode 处理器的既有行为，
 *     本文件的代码用例只比对产物与改写后的代码值；
 *   - 制表符：ir/markers 的 applyTextLayout 把非代码文本中的制表符改为两个全角空格，用例不含制表符。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');

const mdRenderer = require('../converters/renderers/md');
const { loadUnified } = require('../converters/ir/unified-loader');
const { liftInlineHtml } = require('../converters/ir/inline-html');
const { createDocument, createRoot, createHeading, createParagraph, createText } = require('../converters/ir/schema');

// 片段展平所认的格式类型：定界符式三种与只写 HTML 标签的三种
const FORMAT_TYPES = ['strong', 'emphasis', 'delete', 'underline', 'superscript', 'subscript'];
const DELIMITER_CHARS = ['*', '~'];
// 失败信息最多列出的用例数
const MAX_REPORTED = 10;
// 换行、回车、反斜杠与反引号一律以码点生成，源码中不出现转义序列与不可见字面量
const NL = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const BACKSLASH = String.fromCharCode(92);
const BACKTICK = String.fromCharCode(96);
// 用例中链接的默认地址：不含空白与括号，文本与地址不同时产物恒为「[文本](地址)」
const LINK_URL = 'https://a.com';

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
const superscript = format('superscript');
const subscript = format('subscript');
const text = createText;
const html = (value) => ({ type: 'html', value });
const hardBreak = () => ({ type: 'break' });
const inlineCode = (value) => ({ type: 'inlineCode', value });
/** 链接工厂：linkTo(地址)(子项…)；link 指向默认地址 LINK_URL */
const linkTo = (url) => (...children) => ({ type: 'link', url, title: null, children: wrapChildren(children) });
const link = linkTo(LINK_URL);
/** 切分后的各段文本依次建为相邻的 text 节点 */
const texts = (pieces) => pieces.map((piece) => text(piece));

/** 渲染单个块级节点（段落或标题） */
function renderBlock(block) {
    return mdRenderer.render(createDocument({ ir: createRoot([block]) }));
}

const renderParagraph = (children) => renderBlock(createParagraph(children));

async function reparse(md) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    return liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(md));
}

/**
 * 节点简式，用于失败信息：文本 → 字符串，html → { html }，链接与图片另带地址，其余 → { 类型: 子节点简式 }，无子节点
 * 的节点（硬换行、行内代码等）→ { 类型: value }
 */
function brief(node) {
    if (node.type === 'text') return node.value;
    if (node.type === 'html') return { html: node.value };
    if (node.type === 'link') return { link: node.url, children: (node.children || []).map(brief) };
    if (node.type === 'image') return { image: node.url, alt: node.alt };
    if (Array.isArray(node.children)) return { [node.type]: node.children.map(brief) };
    return { [node.type]: node.value === undefined ? null : node.value };
}

/**
 * 单个节点的描述：段落直属文本写作 text("…")，容器内的文本只写 JSON 字符串；空文本写作 text('')、空 html 写作
 * html('')，硬换行写作 break，行内代码写作 code("…")；指向 LINK_URL 的链接只写子节点，其余链接另写地址
 */
function describeNode(node, top = true) {
    if (node.type === 'text') {
        if (!node.value) return "text('')";
        return top ? `text(${JSON.stringify(node.value)})` : JSON.stringify(node.value);
    }
    if (node.type === 'html') return node.value ? `html(${JSON.stringify(node.value)})` : "html('')";
    if (node.type === 'break') return 'break';
    if (node.type === 'inlineCode') return `code(${JSON.stringify(node.value)})`;
    const inner = (node.children || []).map((child) => describeNode(child, false)).join(', ');
    if (node.type === 'link' && node.url !== LINK_URL) return `link[${node.url}](${inner})`;
    return `${node.type}(${inner})`;
}

const describeIr = (nodes) => `[${nodes.map((node) => describeNode(node)).join(', ')}]`;
/** 块级节点的描述：段落只写子节点，标题另写层级，如 heading2[text("1.\n1. 项")] */
const describeBlock = (block) => (block.type === 'heading' ? `heading${block.depth}` : '') + describeIr(block.children);

/**
 * 行内节点序列展平为片段序列：文本片段为 { text, formats }，formats 为祖先中各格式类型与「link=地址」的集合（排序后
 * 以「+」连接）；硬换行为原子片段 { break, formats }。相邻且格式集合相同的文本片段合并，空文本与值为空串的 html 节点
 * 略去，切分出的相邻 text 与产物为空的节点因而不影响片段序列。容许 liftInlineHtml 合并相邻同类节点与嵌套次序变化；
 * 其余类型的节点（残留的非空 html、图片、行内代码等）记为 { unexpected } 片段，与原 IR 的任何片段都不相等
 */
function flatten(nodes, formats = [], out = []) {
    for (const node of nodes) {
        if (node.type === 'text') {
            appendSegment(out, node.value, formats);
        } else if (FORMAT_TYPES.includes(node.type) || node.type === 'link') {
            const key = node.type === 'link' ? `link=${node.url}` : node.type;
            const next = formats.includes(key) ? formats : [...formats, key].sort();
            flatten(node.children || [], next, out);
        } else if (node.type === 'break') {
            out.push({ break: true, formats: formats.join('+') });
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

/** 文本的原文串接（硬换行不计入），用于核对重新解析后是否多出定界符字符 */
const plainText = (nodes) => nodes.map((node) => {
    if (node.type === 'text') return node.value;
    return plainText(node.children || []);
}).join('');

/** 重新解析 md 并与原块级节点比对：往返正确时返回 null，否则返回 { ir, md, reparsed, reasons } */
async function roundTripFailureOf(block, md) {
    const tree = await reparse(md);
    const reasons = [];
    const [first] = tree.children;
    if (tree.children.length !== 1 || first.type !== block.type || first.depth !== block.depth) {
        reasons.push(`重新解析后不是单个${block.type === 'heading' ? `${block.depth} 级标题` : '段落'}`);
    } else {
        if (!isDeepStrictEqual(flatten(first.children), flatten(block.children))) reasons.push('片段序列与原 IR 不一致');
        const original = plainText(block.children);
        const reparsed = plainText(first.children);
        for (const char of DELIMITER_CHARS) {
            if (!original.includes(char) && reparsed.includes(char)) reasons.push(`重新解析文本出现原文没有的「${char}」`);
        }
    }
    return reasons.length ? { ir: describeBlock(block), md, reparsed: tree.children.map(brief), reasons } : null;
}

/** 渲染块级节点并重新解析，返回 { md, failure }：往返正确时 failure 为 null */
async function renderAndReparse(block) {
    const md = await renderBlock(block);
    return { md, failure: await roundTripFailureOf(block, md) };
}

/** 往返失败的逐项说明：前 limit 项的 IR 描述、md 产物、失败原因与重新解析结果 */
function reportLines(failures, limit = MAX_REPORTED) {
    return failures.slice(0, limit).map((f, i) => `${i + 1}. ${f.ir} → ${JSON.stringify(f.md)}；`
        + `${f.reasons.join('、')}；重新解析：${JSON.stringify(f.reparsed)}`);
}

// ============================================================
// 带对照的形态：往返与写法一致
// ============================================================

/**
 * 带对照的用例：block 为待测块级节点，reference 为同一 IR 在两行之间的换行之后切成相邻 text 的块级节点；extra 另记分类
 * 字段，供分类计数
 */
const withReference = (block, reference, extra = {}) => ({ block, reference, ...extra });

/**
 * 逐例检查带对照的用例，返回 { roundTrip, identity }：roundTrip 为往返失败项，identity 为产物与对照形态不同的项。
 * 各失败项另带原用例 item，供分类计数
 */
async function checkCases(cases) {
    const roundTrip = [];
    const identity = [];
    for (const item of cases) {
        const { md, failure } = await renderAndReparse(item.block);
        if (failure) roundTrip.push({ ...failure, item });
        const referenceMd = await renderBlock(item.reference);
        if (md !== referenceMd) identity.push({ ir: describeBlock(item.block), md, referenceMd, item });
    }
    return { roundTrip, identity };
}

/** 写法比对失败的逐项说明：前 limit 项的 IR 描述、md 产物与切在换行处的对照产物 */
function identityLines(failures, limit = MAX_REPORTED) {
    return failures.slice(0, limit).map((f, i) => `${i + 1}. ${f.ir} → ${JSON.stringify(f.md)}；`
        + `切在换行处后为 ${JSON.stringify(f.referenceMd)}`);
}

/** 按键抽样：每个键只取首个失败项，失败信息因而覆盖各类别，不被同一语境的多个组合占满 */
function firstPerKey(failures, keyOf) {
    const seen = new Set();
    return failures.filter((f) => {
        const key = keyOf(f.item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** 先断言对照形态（切在换行处的 IR）往返正确：对照形态本身出错时该形态属范围外，不能用来判定单节点的影响 */
async function assertReferencesRoundTrip(label, cases) {
    const failures = [];
    for (const item of cases) {
        const { failure } = await renderAndReparse(item.reference);
        if (failure) failures.push(failure);
    }
    const lines = reportLines(failures);
    assert.equal(failures.length, 0, `${label}：切在换行处的对照形态 ${cases.length} 例中 ${failures.length} 例往返失败（形态本身属`
        + `范围外），前 ${lines.length} 例：${NL}${lines.join(NL)}`);
}

/**
 * 按键统计：返回「键 出错数/总数（往返失败数、写法比对失败数）」的列表，列出全部键；同一用例往返与写法比对都失败时
 * 出错数只计一次
 */
function tally(cases, { roundTrip, identity }, keyOf) {
    const roundTripItems = new Set(roundTrip.map((f) => f.item));
    const identityItems = new Set(identity.map((f) => f.item));
    const stats = new Map();
    for (const item of cases) {
        const key = keyOf(item);
        const entry = stats.get(key) || { total: 0, failed: 0, roundTrip: 0, identity: 0 };
        entry.total += 1;
        if (roundTripItems.has(item)) entry.roundTrip += 1;
        if (identityItems.has(item)) entry.identity += 1;
        if (roundTripItems.has(item) || identityItems.has(item)) entry.failed += 1;
        stats.set(key, entry);
    }
    return [...stats].map(([key, e]) => `${key} ${e.failed}/${e.total}（往返 ${e.roundTrip}、写法 ${e.identity}）`);
}

/**
 * 一次断言往返与写法比对的结果。breakdowns 为 [标题, keyOf] 列表，按键列出各类的出错数与总数；给出 sampleBy 时
 * 失败信息每个键列出首例，否则列出前 limit 例
 */
function assertCases(label, cases, result, { breakdowns = [], sampleBy = null, limit = MAX_REPORTED } = {}) {
    const { roundTrip, identity } = result;
    const failedItems = new Set([...roundTrip, ...identity].map((f) => f.item));
    const summary = breakdowns.map(([title, keyOf]) => `${title}：${tally(cases, result, keyOf).join('、')}`);
    const rtLines = sampleBy ? reportLines(firstPerKey(roundTrip, sampleBy), Infinity) : reportLines(roundTrip, limit);
    const idLines = sampleBy ? identityLines(firstPerKey(identity, sampleBy), Infinity) : identityLines(identity, limit);
    const scope = sampleBy ? '每类首例' : `前 ${Math.min(limit, cases.length)} 例`;
    assert.equal(roundTrip.length + identity.length, 0, [
        `${label}：${cases.length} 例中往返失败 ${roundTrip.length} 例、与切在换行处的产物不一致 ${identity.length} 例；`
            + `出错用例（往返或写法比对失败）共 ${failedItems.size} 例`,
        ...summary,
        `往返失败（${scope}）：`, ...rtLines,
        `写法比对失败（${scope}）：`, ...idLines,
    ].join(NL));
}

// ============================================================
// 已列形态
// ============================================================

/** 实测确认出错的 12 种形态：[块级节点, 修复后的产物]；各行注释为修复前（a48ad6a）的产物与重新解析的结果 */
function listedShapes() {
    return [
        // 「0\.」加换行加「1. 项」：第二行成为有序列表
        [createParagraph([text(`0.${NL}1. 项`)]), `0${BACKSLASH}.${NL}1${BACKSLASH}. 项${NL}`],
        // 「\-」加换行加「- 项」：第二行成为无序列表
        [createParagraph([text(`-${NL}- 项`)]), `${BACKSLASH}-${NL}${BACKSLASH}- 项${NL}`],
        // 「\+」加换行加「+ 项」：第二行成为无序列表
        [createParagraph([text(`+${NL}+ 项`)]), `${BACKSLASH}+${NL}${BACKSLASH}+ 项${NL}`],
        // 「甲」加换行加「\-」加换行加「-」：第三行成为 setext 下划线，整段成为二级标题
        [createParagraph([text(`甲${NL}-${NL}-`)]), `甲${NL}${BACKSLASH}-${NL}${BACKSLASH}-${NL}`],
        // 「\-」「-」「\-」「- 项」四行交错转义：二级标题、段落与列表
        [createParagraph([text(`-${NL}-${NL}-${NL}- 项`)]), `${BACKSLASH}-${NL}${BACKSLASH}-${NL}${BACKSLASH}-${NL}${BACKSLASH}- 项${NL}`],
        // 数字边界合并后的形态：「1\.」加换行加「1. 项」，第二行成为有序列表
        [createParagraph([text('1'), text(`.${NL}1. 项`)]), `1${BACKSLASH}.${NL}1${BACKSLASH}. 项${NL}`],
        // 第一行的编号不是 1 也吃掉换行：「2\.」加换行加「1. 项」，第二行成为有序列表
        [createParagraph([text(`2.${NL}1. 项`)]), `2${BACKSLASH}.${NL}1${BACKSLASH}. 项${NL}`],
        // 以 CR 换行：「0\.」加 CR 加「1. 项」，第二行成为有序列表
        [createParagraph([text(`0.${CR}1. 项`)]), `0${BACKSLASH}.${CR}1${BACKSLASH}. 项${NL}`],
        // 链接内：「[甲」加换行加「\-」加换行加「- 项](https://a.com)」，第三行成为列表，链接被拆散
        [createParagraph([link(text(`甲${NL}-${NL}- 项`))]), `[甲${NL}${BACKSLASH}-${NL}${BACKSLASH}- 项](${LINK_URL})${NL}`],
        // 硬换行之后：「甲\」加换行加「1\.」加换行加「1. 项」，第三行成为有序列表
        [createParagraph([text('甲'), hardBreak(), text(`1.${NL}1. 项`)]), `甲${BACKSLASH}${NL}1${BACKSLASH}.${NL}1${BACKSLASH}. 项${NL}`],
        // 粗体内换行之后：「**甲」加换行加「1\.」加换行加「1. 项**」，第三行成为有序列表，粗体被拆散
        [createParagraph([strong(text(`甲${NL}1.${NL}1. 项`))]), `**甲${NL}1${BACKSLASH}.${NL}1${BACKSLASH}. 项**${NL}`],
        // 二级标题（含换行时强制写成 setext）：「1\.」加换行加「1. 项」加换行加「----」，成为段落、列表与分隔线
        [createHeading(2, [text(`1.${NL}1. 项`)]), `1${BACKSLASH}.${NL}1${BACKSLASH}. 项${NL}-----${NL}`],
    ];
}

// ============================================================
// 矩阵
// ============================================================

// 第一行只有记号：受影响的三条模式各取代表——「数字 + .」取 0 与 1 两个起始编号、两位数与列表记号允许的最长 9 位
const FIRST_LINES = { '.': ['1.', '0.', '12.', '123456789.'], '-': ['-'], '+': ['+'] };
// 第二行以同种记号开头：能打断段落的（1. 项、- 项、+ 项、- - 项）、空列表项（1.、+）、起始编号不是 1 的（2. 项、12. 项）、
// setext 下划线（-、--、---）
const SECOND_LINES = { '.': ['1. 项', '1.', '2. 项', '12. 项'], '-': ['- 项', '-', '--', '---', '- - 项'], '+': ['+ 项', '+'] };
// 容器语境：六种格式节点与链接，容器即段落的全部内容
const CONTAINERS = [
    ['strong', strong], ['emphasis', emphasis], ['delete', del], ['underline', underline], ['superscript', superscript],
    ['subscript', subscript], ['link', link],
];
/** 在首个文本节点的值之前接上 prefix */
const prefixFirst = (nodes, prefix) => [text(prefix + nodes[0].value), ...nodes.slice(1)];
// 语境：给出两行文本所在的 text 节点（单个节点，或切在换行处的两个节点），返回块级节点
const CONTEXTS = [
    { name: '段首', block: (nodes) => createParagraph(nodes) },
    { name: '前文同节点以换行结尾', block: (nodes) => createParagraph(prefixFirst(nodes, `甲${NL}`)) },
    { name: '前一文本以换行结尾', block: (nodes) => createParagraph([text(`甲${NL}`), ...nodes]) },
    { name: '硬换行之后', block: (nodes) => createParagraph([text('甲'), hardBreak(), ...nodes]) },
    { name: '段首空节点之后', block: (nodes) => createParagraph([text(''), emphasis(), ...nodes]) },
    ...CONTAINERS.map(([name, make]) => ({ name: `${name} 内换行之后`, block: (nodes) => createParagraph([make(...prefixFirst(nodes, `甲${NL}`))]) })),
    { name: '二级标题', block: (nodes) => createHeading(2, nodes) },
];
const MERGE_CONTEXT = '数字边界合并';

/** 两行形态：记号 × 第一行 × 第二行，每项给出记号、第一行与第二行 */
function twoLinePairs() {
    const pairs = [];
    for (const marker of Object.keys(FIRST_LINES)) {
        for (const first of FIRST_LINES[marker]) {
            for (const second of SECOND_LINES[marker]) pairs.push({ marker, first, second });
        }
    }
    return pairs;
}

/**
 * 矩阵各例：两行形态 × 语境，单个节点为 text(第一行 + 换行 + 第二行)，对照为切在换行处的 [text(第一行 + 换行), text(第二行)]；
 * 「.」形态另加数字边界合并语境：[text(数字), text('.' + 换行 + 第二行)]，对照为 [text(数字), text('.' + 换行), text(第二行)]
 */
function buildMatrix() {
    const cases = [];
    for (const pair of twoLinePairs()) {
        const { first, second } = pair;
        for (const context of CONTEXTS) {
            const block = context.block([text(`${first}${NL}${second}`)]);
            const reference = context.block(texts([`${first}${NL}`, second]));
            cases.push(withReference(block, reference, { ...pair, context: context.name }));
        }
        if (pair.marker === '.') {
            const digits = first.slice(0, -1);
            const block = createParagraph(texts([digits, `.${NL}${second}`]));
            const reference = createParagraph(texts([digits, `.${NL}`, second]));
            cases.push(withReference(block, reference, { ...pair, context: MERGE_CONTEXT }));
        }
    }
    return cases;
}

// ============================================================
// 种子随机段落
// ============================================================

// 只有记号的行：受影响的「数字 + .」「-」「+」，与不受影响的「)」「*」、多个「-」、行首带空格的
const BARE_LINES = ['1.', '0.', '12.', '2.', '123456789.', '-', '+', '1)', '*', '--', '---', ' 1.', ' -'];
// 以记号开头的行
const HEAD_LINES = ['1. 项', '2. 项', '1) 项', '- 项', '+ 项', '* 项', '1.项', '-x', '12. 甲', '1. 1) 项', ' 1. 项', '- - 项'];
// 普通行
const PLAIN_LINES = ['甲', '乙丙', 'a b', '（注）', '1.5 版', '第 2 项', '甲。', '*', '~', 'ab'];
const RANDOM_SEED = 20260928;
const RANDOM_COUNT = 2000;
// 每段可见项数的上限；每个多行文本的行数上限；文本切分的段数上限
const MAX_ITEMS = 5;
const MAX_LINES = 4;
const MAX_PIECES = 4;
// 容器（格式节点与链接）的嵌套深度上限：深度达到该值的位置只取文本
const MAX_DEPTH = 2;
// 一行取只有记号的行、以记号开头的行的概率（其余为普通行）；文本被切分的概率；切分点插入空节点的概率
const BARE_RATE = 0.45;
const HEAD_RATE = 0.35;
const SPLIT_RATE = 0.6;
const GAP_EMPTY_RATE = 0.3;
// 可见项之间插硬换行、插空节点的概率；容器首尾各加一个空节点的概率
const BREAK_RATE = 0.15;
const GAP_RATE = 0.35;
const EDGE_EMPTY_RATE = 0.1;
// 可见项取文本、取格式节点的概率（其余为链接）
const TEXT_RATE = 0.7;
const FORMAT_RATE = 0.9;

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

/** 产物为空的节点：空文本 45%、空 html 25%、无子节点的空格式 20%、只含空文本的空格式 10% */
function randomEmpty(rand) {
    const roll = rand();
    if (roll < 0.45) return text('');
    if (roll < 0.7) return html('');
    if (roll < 0.9) return format(pick(rand, FORMAT_TYPES))();
    return format(pick(rand, FORMAT_TYPES))(text(''));
}

/** 一行：按 BARE_RATE 取只有记号的行、按 HEAD_RATE 取以记号开头的行，其余取普通行 */
function randomLine(rand) {
    const roll = rand();
    if (roll < BARE_RATE) return pick(rand, BARE_LINES);
    if (roll < BARE_RATE + HEAD_RATE) return pick(rand, HEAD_LINES);
    return pick(rand, PLAIN_LINES);
}

/** 多行文本：1–MAX_LINES 行以换行连接 */
function randomText(rand) {
    const count = 1 + Math.floor(rand() * MAX_LINES);
    const lines = [];
    for (let i = 0; i < count; i += 1) lines.push(randomLine(rand));
    return lines.join(NL);
}

/** 文本按 SPLIT_RATE 在随机码点处切成 2–MAX_PIECES 段相邻 text（段均非空，不拆开代理对），切分点按 GAP_EMPTY_RATE 插入空节点 */
function randomSplitText(rand, value, out) {
    const chars = Array.from(value);
    if (chars.length < 2 || rand() >= SPLIT_RATE) {
        out.push(text(value));
        return;
    }
    const pieces = Math.min(chars.length, 2 + Math.floor(rand() * (MAX_PIECES - 1)));
    const cuts = new Set();
    while (cuts.size < pieces - 1) cuts.add(1 + Math.floor(rand() * (chars.length - 1)));
    const sorted = [...cuts].sort((a, b) => a - b);
    sorted.push(chars.length);
    let start = 0;
    for (let i = 0; i < sorted.length; i += 1) {
        out.push(text(chars.slice(start, sorted[i]).join('')));
        if (i < sorted.length - 1 && rand() < GAP_EMPTY_RATE) out.push(randomEmpty(rand));
        start = sorted[i];
    }
}

/** 一个可见项的节点序列：按 TEXT_RATE 取切分文本（深度达上限时一律取文本），按 FORMAT_RATE 取格式节点，其余取链接（链接内不再嵌套链接） */
function randomVisibleItem(rand, depth, inLink) {
    const roll = rand();
    const out = [];
    if (roll < TEXT_RATE || depth >= MAX_DEPTH) randomSplitText(rand, randomText(rand), out);
    else if (roll < FORMAT_RATE || inLink) out.push(format(pick(rand, FORMAT_TYPES))(...randomContainer(rand, depth + 1, inLink, 1 + Math.floor(rand() * 2))));
    else out.push(link(...randomContainer(rand, depth + 1, true, 1 + Math.floor(rand() * 2))));
    return out;
}

/** 容器的子节点：count 个可见项，项间按 BREAK_RATE 插硬换行、按 GAP_RATE - BREAK_RATE 插空节点；容器首尾按 EDGE_EMPTY_RATE 各加一个空节点 */
function randomContainer(rand, depth, inLink, count) {
    const out = [];
    if (rand() < EDGE_EMPTY_RATE) out.push(randomEmpty(rand));
    for (let i = 0; i < count; i += 1) {
        if (i > 0) {
            const roll = rand();
            if (roll < BREAK_RATE) out.push(hardBreak());
            else if (roll < GAP_RATE) out.push(randomEmpty(rand));
        }
        out.push(...randomVisibleItem(rand, depth, inLink));
    }
    if (rand() < EDGE_EMPTY_RATE) out.push(randomEmpty(rand));
    return out;
}

/** count 个随机段落，每段 1–MAX_ITEMS 个可见项 */
function randomParagraphs(seed, count) {
    const rand = mulberry32(seed);
    const paragraphs = [];
    for (let k = 0; k < count; k += 1) paragraphs.push(randomContainer(rand, 0, false, 1 + Math.floor(rand() * MAX_ITEMS)));
    return paragraphs;
}

// ============================================================
// 用例：已列形态
// ============================================================

test('已列形态：一行只有记号、下一行以同种记号开头的 12 种形态（「.」「-」「+」三种记号、setext 下划线、四行交错、数字边界合并、CR 换行、链接内、硬换行之后、粗体内、二级标题），第二行的记号一并转义，产物逐字比对，重新解析后不成列表或标题', async () => {
    // Arrange
    const shapes = listedShapes();
    assert.equal(shapes.length, 12);

    for (const [block, expected] of shapes) {
        // Act
        const { md, failure } = await renderAndReparse(block);

        // Assert
        assert.equal(md, expected, describeBlock(block));
        assert.equal(failure, null, failure ? reportLines([failure])[0] : '');
    }
});

// ============================================================
// 用例：矩阵
// ============================================================

test('矩阵：第一行只有记号 6 种 × 同种记号的第二行共 23 对，× 13 种语境（段首、前文同节点以换行结尾、前一文本以换行结尾、硬换行之后、段首空节点之后、六种格式节点与链接内换行之后、二级标题）另加「.」形态的数字边界合并语境，共 315 例，对照形态往返正确；各例重新解析后格式、链接、硬换行与文本均不变，产物与切在换行处的同一 IR 逐字相同', async () => {
    // Arrange
    const pairs = twoLinePairs();
    const cases = buildMatrix();
    assert.equal(pairs.length, 23);
    assert.equal(CONTEXTS.length, 13);
    assert.equal(cases.length, pairs.length * CONTEXTS.length + FIRST_LINES['.'].length * SECOND_LINES['.'].length);
    assert.equal(cases.length, 315);
    await assertReferencesRoundTrip('矩阵', cases);

    // Act
    const result = await checkCases(cases);

    // Assert：失败信息按语境、记号、第一行与第二行分别计数，每种语境列出首例
    const byContext = (item) => item.context;
    assertCases('矩阵', cases, result, {
        breakdowns: [
            ['按语境', byContext], ['按记号', (item) => item.marker], ['按第一行', (item) => item.first], ['按第二行', (item) => item.second],
        ],
        sampleBy: byContext,
    });
});

// ============================================================
// 用例：回归护栏（修复前后均应通过）
// ============================================================

test('回归护栏：不受影响的形态（「)」「*」记号、跨模式的两行、记号后有空格、--、-x、1.x、CR LF、段首粗体内、切在换行处的两行、数字边界与换行的三段、「#」「>」「=」记号、只含一处换行的代码值）产物逐字不变', async () => {
    // Arrange：期望值取自现行代码（a48ad6a）的实际产物
    const cases = [
        // 「)」模式没有 after，「*」另有行内规则恒转义
        { block: createParagraph([text(`1)${NL}1) 项`)]), md: `1${BACKSLASH})${NL}1${BACKSLASH}) 项${NL}` },
        { block: createParagraph([text(`*${NL}* 项`)]), md: `${BACKSLASH}*${NL}${BACKSLASH}* 项${NL}` },
        // 两行属不同模式，各自的 exec 循环互不影响
        { block: createParagraph([text(`-${NL}+ 项`)]), md: `${BACKSLASH}-${NL}${BACKSLASH}+ 项${NL}` },
        { block: createParagraph([text(`+${NL}- 项`)]), md: `${BACKSLASH}+${NL}${BACKSLASH}- 项${NL}` },
        { block: createParagraph([text(`1.${NL}- 项`)]), md: `1${BACKSLASH}.${NL}${BACKSLASH}- 项${NL}` },
        { block: createParagraph([text(`-${NL}1. 项`)]), md: `${BACKSLASH}-${NL}1${BACKSLASH}. 项${NL}` },
        // 记号之后有空格：after 吃掉的是空格，换行仍在
        { block: createParagraph([text(`1. 项${NL}1. 项`)]), md: `1${BACKSLASH}. 项${NL}1${BACKSLASH}. 项${NL}` },
        { block: createParagraph([text(`- 项${NL}- 项`)]), md: `${BACKSLASH}- 项${NL}${BACKSLASH}- 项${NL}` },
        { block: createParagraph([text(`+ 项${NL}+ 项`)]), md: `${BACKSLASH}+ 项${NL}${BACKSLASH}+ 项${NL}` },
        { block: createParagraph([text(`甲 -${NL}- 项`)]), md: `甲 -${NL}${BACKSLASH}- 项${NL}` },
        // 「--」：after 吃掉的是第二个「-」
        { block: createParagraph([text(`--${NL}- 项`)]), md: `${BACKSLASH}--${NL}${BACKSLASH}- 项${NL}` },
        // 第二行的记号后不接空白，本就不是记号
        { block: createParagraph([text(`-${NL}-x`)]), md: `${BACKSLASH}-${NL}-x${NL}` },
        { block: createParagraph([text(`1.${NL}1.x`)]), md: `1${BACKSLASH}.${NL}1.x${NL}` },
        { block: createParagraph([text(`1.x${NL}1. 项`)]), md: `1.x${NL}1${BACKSLASH}. 项${NL}` },
        { block: createParagraph([text(`甲${NL}1. 项`)]), md: `甲${NL}1${BACKSLASH}. 项${NL}` },
        // 单行
        { block: createParagraph([text('-')]), md: `${BACKSLASH}-${NL}` },
        { block: createParagraph([text('1.')]), md: `1${BACKSLASH}.${NL}` },
        { block: createParagraph([text('+ 项')]), md: `${BACKSLASH}+ 项${NL}` },
        // CR LF：after 吃掉 CR，LF 仍在
        { block: createParagraph([text(`-${CR}${NL}- 项`)]), md: `${BACKSLASH}-${CR}${NL}${BACKSLASH}- 项${NL}` },
        // 段首粗体内：第一行前有「**」，不在行首
        { block: createParagraph([strong(text(`1.${NL}1. 项`))]), md: `**1.${NL}1${BACKSLASH}. 项**${NL}` },
        // 切在换行处的两行与数字边界合并后仍切在换行处的三段：两个节点各自转义
        { block: createParagraph([text('1.'), text(`${NL}1. 项`)]), md: `1${BACKSLASH}.${NL}1${BACKSLASH}. 项${NL}` },
        { block: createParagraph([text('1'), text('.'), text(`${NL}1. 项`)]), md: `1${BACKSLASH}.${NL}1${BACKSLASH}. 项${NL}` },
        // 没有 after 的 atBreak 模式
        { block: createParagraph([text(`#${NL}# 甲`)]), md: `${BACKSLASH}#${NL}${BACKSLASH}# 甲${NL}` },
        { block: createParagraph([text(`>${NL}> 甲`)]), md: `${BACKSLASH}>${NL}${BACKSLASH}> 甲${NL}` },
        { block: createParagraph([text(`=${NL}=`)]), md: `${BACKSLASH}=${NL}${BACKSLASH}=${NL}` },
        // 代码值：只有一处换行时默认模式即能改为空格；不接记号的换行原样保留
        { block: createParagraph([inlineCode(`1.${NL}1.`)]), md: `${BACKTICK}1. 1.${BACKTICK}${NL}` },
        { block: createParagraph([inlineCode(`x${NL}1. y`)]), md: `${BACKTICK}x 1. y${BACKTICK}${NL}` },
        { block: createParagraph([inlineCode(`甲${NL}乙`)]), md: `${BACKTICK}甲${NL}乙${BACKTICK}${NL}` },
    ];
    assert.equal(cases.length, 28);

    for (const { block, md: expected } of cases) {
        // Act
        const md = await renderBlock(block);

        // Assert
        assert.equal(md, expected, describeBlock(block));
    }
});

test('行首有空格的两行（修复前空格编码为 &#x20; 已使第二行不成列表）：重新解析后文本不变，产物与切在换行处的同一 IR 逐字相同', async () => {
    // Arrange：修复前的产物依次为「&#x20;1\.」加换行加「&#x20;1. 项」等，第二行的记号不转义；修复后另加转义
    const cases = [
        [` 1.${NL} 1. 项`], [` -${NL} - 项`], [`甲${NL} -${NL} - 项`], [` +${NL} + 项`],
    ].map(([value]) => {
        const at = value.lastIndexOf(NL) + 1;
        return withReference(createParagraph([text(value)]), createParagraph(texts([value.slice(0, at), value.slice(at)])));
    });
    assert.equal(cases.length, 4);
    await assertReferencesRoundTrip('行首有空格的两行', cases);

    // Act
    const result = await checkCases(cases);

    // Assert
    assertCases('行首有空格的两行', cases, result, { limit: cases.length });
});

// ============================================================
// 用例：inlineCode
// ============================================================

test('inlineCode：值内「换行 + 只有记号的行 + 换行 + 以记号开头的行」的 4 种形态，两处换行都改为空格，产物逐字比对，重新解析后仍是单个代码段', async () => {
    // Arrange：修复前只有第一处换行改为空格，如 code("a\n0.\n1. y") 写作「`a 0.」加换行加「1. y`」，第二行成为列表
    const cases = [
        [inlineCode(`a${NL}0.${NL}1. y`), 'a 0. 1. y'],
        [inlineCode(`a${NL}-${NL}- y`), 'a - - y'],
        [inlineCode(`a${NL}+${NL}+ y`), 'a + + y'],
        [inlineCode(`-${NL}-${NL}-${NL}- y`), '- - - - y'],
    ];
    assert.equal(cases.length, 4);

    for (const [node, inner] of cases) {
        // Act
        const md = await renderParagraph([node]);
        const tree = await reparse(md);

        // Assert
        assert.equal(md, `${BACKTICK}${inner}${BACKTICK}${NL}`, describeNode(node));
        assert.deepEqual(tree.children.map(brief), [{ paragraph: [{ inlineCode: inner }] }], describeNode(node));
    }
});

// ============================================================
// 用例：种子随机往返
// ============================================================

test(`种子随机往返：种子 ${RANDOM_SEED} 生成 ${RANDOM_COUNT} 个段落（行池以只有记号的行与以记号开头的行为主，每个文本 1–${MAX_LINES} 行并按比例切成 2–${MAX_PIECES} 个相邻 text，穿插空节点、硬换行、六种格式节点与链接，容器嵌套深度 ≤ ${MAX_DEPTH}），重新解析后格式、链接、硬换行与文本均不变`, async () => {
    // Arrange：每个可见项都有可见文本，不存在只由空节点构成的段落
    const cases = randomParagraphs(RANDOM_SEED, RANDOM_COUNT);
    assert.equal(cases.length, RANDOM_COUNT);
    assert.equal(cases.filter((children) => flatten(children).length === 0).length, 0);

    // Act
    const failures = [];
    for (const children of cases) {
        const { failure } = await renderAndReparse(createParagraph(children));
        if (failure) failures.push(failure);
    }

    // Assert
    const lines = reportLines(failures);
    assert.equal(failures.length, 0, [
        `种子随机往返：${cases.length} 段中往返失败 ${failures.length} 段`,
        `往返失败（前 ${lines.length} 段）：`, ...lines,
    ].join(NL));
});
