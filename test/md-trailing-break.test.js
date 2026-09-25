/**
 * converters/renderers/md.js：段落与标题末尾的硬换行输出为「\ + 换行」或空格，重新解析为字面反斜杠或丢失
 * 成因：mdast-util-to-markdown 2.1.2 的 break 处理器（lib/handle/break.js）只在不能含换行的构造（headingAtx、tableCell 等）
 * 中写空格（前一字已是空白时写空串），其余一律写「\ + 换行」；而 CommonMark 只认块内两行之间的硬换行，段尾的「\ + 换行」
 * 是字面反斜杠加段落结束，「两个空格 + 换行」的写法则被删去。以下均为 a48ad6a 的实测产物：
 *   - [text('甲'), break] 输出「甲\」加换行，重新解析为文本「甲\」；列表项与引用块内的段落同样，如「- 甲\」「> 甲\」。
 *   - [text('甲'), break, break] 输出「甲\」「\」两行，重新解析为文本「甲」、硬换行、文本「\」：只有最后一个硬换行丢失。
 *   - [text('甲\'), break] 输出「甲\\\」加换行（文本的反斜杠因 after 为 ASCII 标点而转义），重新解析为文本「甲\\」。
 *   - 只由硬换行构成的段落 [break] 输出「\」加换行，重新解析为文本「\」。
 *   - 前面是行内代码、定界符式格式、HTML 标签格式或链接时同样，如 [strong(text('甲')), break] 输出「**甲**\」加换行。
 *   - 标题末尾的硬换行另有两种丢法。1–2 级标题含 break 时上游 formatHeadingAsSetext 改走 setext 形式，末尾的「\ + 换行」使
 *     下划线长度为 0：[heading2(text('甲'), break)] 输出「甲\」加换行再加空行，重新解析为段落「甲\」，标题整个丢失；
 *     [heading2(text('甲'), break, break)] 输出「甲\」「\」两行再加空行，重新解析为段落「甲」、硬换行、「\」。3 级起走 ATX
 *     形式，break 处理器写空格：[heading3(text('甲'), break)] 输出「### 甲 」，重新解析为标题「甲」，硬换行丢失；连续的硬换行
 *     只有首个写成空格（其后前一字已是空白），[heading3(text('甲'), break, break)] 同样输出「### 甲 」。列表项与引用块内的
 *     标题同样，如「- 甲\」加换行再加空行、「> ### 甲 」。
 * 处在段尾格式节点或链接末尾的硬换行不在此列：定界符式格式的内容以换行结尾时 isDelimiterSafe 回退为标签，
 * [strong(text('甲'), break)] 输出「<strong>甲\」加换行再加「</strong>」，「\ + 换行」之后有闭标签，仍是硬换行；链接文本
 * 之后紧随「](」，[link(text('甲'), break)] 输出「[甲\」加换行再加「](https://a.com)」，同样是硬换行。
 * 修法：块末的硬换行没有 Markdown 写法，故与 underline 等一样写行内 HTML。render() 的 pruneEmptyInline 对 paragraph 与
 * heading 剔除空节点之后，把末尾连续的 k 个 break 并为一个 html 节点、值为 k 个「<br>」的拼接，[text('甲'), break] 的产物改为
 * 「甲<br>」、[heading3(text('甲'), break, break)] 改为「### 甲<br><br>」，重新解析为文本加 html 节点，由 ir/inline-html 提升为
 * break（<br> 不分大小写、可自闭合、可带属性）。改写后标题内不再有 break 节点，1–2 级标题只要文本不含换行就回到 ATX 形式。
 * html 的 peek 为「<」：段落与 setext 形式的标题中，break 产物的首字「\」与「<」同属 ASCII 标点，前一兄弟据 after 所作的末尾
 * 反斜杠转义与定界符判定不变；3 级起的 ATX 标题中 break 产物为空格或空串，after 改为「<」后定界符判定不变，末尾的反斜杠则
 * 由不转义改为转义（不转义时「\<」会使 <br> 成为字面文本）。
 * 并为一个节点而不逐个改写：上游 heading 处理器的 setext 判定用 unist-util-visit 遍历标题的子节点，遇到 break 即退出，而
 * unist-util-visit 对每个访问到的节点以 parent.children.indexOf 取下标；逐个改写会把末尾 k 个 break 换成 k 个 html 节点，
 * 遍历不再提前退出，标题末尾 k 个硬换行的耗时成 O(k²)，并为一个节点后线性于换行个数，产物逐字相同。只改 paragraph 与
 * heading（含列表项与引用块内的）。
 * 覆盖：
 *   - 已列形态（段落）：实测确认的 18 种形态（单个、两个、三个段尾硬换行；前面为末尾空格、末尾反斜杠、空节点、行内代码、
 *     定界符式格式、标点结尾的粗体、HTML 标签格式、链接、以硬换行结尾的粗体；硬换行之后夹空文本或空 html；列表项与引用块内；
 *     只由两个硬换行构成的段落）。
 *   - 已列形态（标题）：实测确认的 23 种形态（1–6 级各一个末尾硬换行；2 级与 3 级两个、3 级三个；前面为末尾空格、末尾
 *     反斜杠、粗体、行内代码、链接；硬换行前后夹空节点；只由硬换行构成的 2 级与 3 级标题；列表项与引用块内的 2 级与 3 级
 *     标题）。
 *   - 矩阵（段落）：33 种前缀（各类文本、六种格式节点、嵌套格式、链接、自动链接、行内代码、段中硬换行、以硬换行结尾的格式
 *     节点与链接、末尾夹空节点）× 段尾 1–3 个硬换行 × 5 种尾随空节点（无、空文本、空 html、无内容的 strong、嵌套空格式）×
 *     3 种容器（段落、列表项、引用块），另加只由 2–3 个硬换行构成的段落，共 1515 例。
 *   - 矩阵（标题）：同一组前缀（3 级起去掉段中硬换行与以硬换行结尾的格式节点、链接三种，见范围外）× 1–6 级 × 末尾 1–3 个
 *     硬换行 × 3 种容器，另加 2 级与 3 级 × 4 种非空的尾随空节点，以及只由 1–3 个硬换行构成的 1–6 级标题（3 种容器）与其
 *     2 级、3 级的尾随空节点变体，共 2508 例。
 *   - 回归护栏：不含块末硬换行的 30 种形态（段首与段中的硬换行、六种格式节点与链接末尾的硬换行、只含硬换行的 strong、
 *     嵌套格式末尾、格式节点末尾硬换行之后有文本、硬换行后接以空格开头的文本、标题段首与段中的硬换行、标题末尾格式节点内
 *     的硬换行、表格单元格内的硬换行、硬换行后紧接非空 html），产物逐字等于 a48ad6a 的产物；其中格式节点与链接末尾的硬换行、
 *     1–2 级标题的段首与段中硬换行、1–2 级标题末尾格式节点内的硬换行往返正确。
 *   - 已知限制：只由一个硬换行构成的段落输出「<br>」独占一行，按 CommonMark 属第 7 类 HTML 块，重新解析为块级 html 节点；
 *     标题有「#」前缀，只由硬换行构成时输出「## <br>」，仍为标题。块末硬换行之前的文本以换行结尾时，containerPhrasing 在
 *     html 之前把该换行改为空格：[text('甲' + 换行), break] 输出「甲 <br>」，重新解析为文本「甲 」与硬换行（修复前为文本
 *     「甲」换行「\」），硬换行保住；前一兄弟为格式节点时产物以闭标签收尾，不触发该规则。
 *   - 种子随机往返（段落）：固定种子生成 2000 段，每段 1–5 个可见项（文本、六种格式节点、链接、行内代码、以硬换行结尾的
 *     格式节点或链接），项间按 15% 插硬换行、按 20% 插空节点，随后按 70% 追加 1–3 个段尾硬换行（之间与之后按 30% 各插一个
 *     空节点）；容器为段落 70%、列表项 15%、引用块 15%。
 *   - 种子随机往返（标题）：另一固定种子生成 2000 个标题，级别 1–6 均匀，子节点生成同段落，3 级起不插段中硬换行、不取以
 *     硬换行结尾的格式节点或链接（见范围外）。
 * 断言口径：缺陷类用例（已列形态、矩阵、种子随机往返）逐例经 remark-parse + remark-gfm + liftInlineHtml 重新解析，断言两项。
 * 其一，往返正确：块结构与容器一致（单个段落或指定级别的单个标题；单个列表的单个列表项内的单个段落或标题；单个引用块内的
 * 单个段落或标题），「文本 + 格式集合」片段序列与原 IR 一致（硬换行与行内代码为原子片段，链接视作带 url 的格式，产物为空
 * 的节点不产生片段，render() 在相邻行内代码之间插入的空注释不计），且不出现原文没有的「*」「~」。其二，产物与参照改写后的
 * 同一 IR 逐字相同：参照改写由本文件独立实现，先剔除产物为空的节点，再把块末连续的 break 换成一个 html('<br>' × 个数)。
 * 已列形态与矩阵先断言对照形态（去掉块末硬换行后的 IR）往返正确，以确认形态本身在范围内。回归护栏逐字比对产物。
 * 范围外（矩阵与随机语料均已避开）：
 *   - 只由一个硬换行构成的段落（见已知限制）；
 *   - 只含硬换行的格式节点：liftInlineHtml 把只包着换行的格式标签直接拆除（converters/ir/inline-html.js 的 wrapFrame），
 *     [text('甲'), strong(break)] 重新解析为文本加硬换行，格式丢失，属解析侧既有行为；
 *   - 硬换行之后紧接非空 html 节点：containerPhrasing 把 html 之前的行尾换行改为空格，[text('甲'), break, html('<!---->')]
 *     输出「甲\ <!---->」，属上游既有行为；
 *   - 3 级起标题的段中硬换行与处在标题末尾格式节点或链接内的硬换行：上游在 ATX 形式中写成空格，[heading3(text('甲'), break,
 *     text('乙'))] 输出「### 甲 乙」，硬换行丢失（1–2 级保留 setext 形式，往返正确）；tableCell 内改为空格；
 *   - 含换行、制表符、「www」「@」「:」的文本，链接嵌套链接。
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
// 换行、反斜杠与辅助平面表情一律以码点生成，源码中不出现转义序列与不可见字面量
const NL = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);
const EMOJI = String.fromCodePoint(0x1f600);
// 用例中链接的地址：不含空白与括号；文本与地址不同时产物恒为「[文本](地址)」
const LINK_URL = 'https://a.com';
// 块末硬换行的期望写法（与渲染器的 HTML_BREAK 一致），供参照改写使用
const HTML_BREAK = '<br>';
// render() 在相邻行内代码之间插入的空注释：值以 COMMENT_OPEN 开头、以 COMMENT_CLOSE 结尾的 html 节点在展平时略去
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
// 段落或标题所处的容器
const CONTAINERS = ['paragraph', 'listItem', 'blockquote'];
const CONTAINER_NAMES = { paragraph: '段落', listItem: '列表项', blockquote: '引用块' };
const CONTAINER_PREFIXES = { paragraph: '', listItem: '列表项内', blockquote: '引用块内' };
// 标题级别：0 表示段落
const DEPTHS = [1, 2, 3, 4, 5, 6];
const DEPTH_NAMES = ['', '一级', '二级', '三级', '四级', '五级', '六级'];
// 表格语境的表头
const TABLE_HEAD = '表头';

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
/** 链接工厂：地址恒为 LINK_URL */
const link = (...children) => ({ type: 'link', url: LINK_URL, title: null, children: wrapChildren(children) });
const inlineCode = (value) => ({ type: 'inlineCode', value });
const hardBreak = () => ({ type: 'break' });

/**
 * 段落或标题放进容器：depth 为 0 时为段落，否则为该级标题；paragraph 直接为该块；listItem 为无序列表的单个列表项；
 * blockquote 为引用块
 */
function blockOf(container, children, depth = 0) {
    const block = depth ? createHeading(depth, children) : createParagraph(children);
    if (container === 'listItem') return { type: 'list', ordered: false, spread: false, children: [{ type: 'listItem', spread: false, children: [block] }] };
    if (container === 'blockquote') return { type: 'blockquote', children: [block] };
    return block;
}

function renderBlock(block) {
    return mdRenderer.render(createDocument({ ir: createRoot([block]) }));
}

const renderIn = (container, children, depth = 0) => renderBlock(blockOf(container, children, depth));

async function reparse(md) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    return liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(md));
}

/**
 * 节点简式，用于失败信息：文本 → 字符串，硬换行 → 'BR'，html → { html }，行内代码 → { code }，链接另带地址，
 * 其余 → { 类型: 子节点简式 }
 */
function brief(node) {
    if (node.type === 'text') return node.value;
    if (node.type === 'break') return 'BR';
    if (node.type === 'html') return { html: node.value };
    if (node.type === 'inlineCode') return { code: node.value };
    if (node.type === 'link') return { link: node.url, children: (node.children || []).map(brief) };
    if (Array.isArray(node.children)) return { [node.type]: node.children.map(brief) };
    return { [node.type]: node.value === undefined ? null : node.value };
}

/**
 * 单个节点的描述：块直属文本写作 text("…")，容器内的文本只写 JSON 字符串；空文本写作 text('')、空 html 写作
 * html('')，硬换行写作 break，行内代码写作 code("…")，链接只写子节点，如 link("甲")
 */
function describeNode(node, top = true) {
    if (node.type === 'text') {
        if (!node.value) return "text('')";
        return top ? `text(${JSON.stringify(node.value)})` : JSON.stringify(node.value);
    }
    if (node.type === 'html') return node.value ? `html(${JSON.stringify(node.value)})` : "html('')";
    if (node.type === 'break') return 'break';
    if (node.type === 'inlineCode') return `code(${JSON.stringify(node.value)})`;
    return `${node.type}(${(node.children || []).map((child) => describeNode(child, false)).join(', ')})`;
}

/** 块的名称：段落按容器写「段落」「列表项」「引用块」，标题写「二级标题」「列表项内二级标题」等 */
const kindName = (container, depth = 0) => (depth ? `${CONTAINER_PREFIXES[container]}${DEPTH_NAMES[depth]}标题` : CONTAINER_NAMES[container]);

const describeIr = (container, children, depth = 0) => `${kindName(container, depth)}[${children.map((node) => describeNode(node)).join(', ')}]`;

/**
 * 行内节点序列展平为片段序列：文本片段为 { text, formats }，formats 为祖先中各格式类型与「link=地址」的集合（排序后
 * 以「+」连接）；硬换行为原子片段 { break, formats }，行内代码为原子片段 { code, formats }。相邻且格式集合相同的文本片段
 * 合并，空文本、值为空串的 html 与空注释 html 略去，产物为空的节点因而不产生片段。容许 liftInlineHtml 合并相邻同类节点
 * 与嵌套次序变化；其余类型的节点（残留的非空 html、图片等）记为 { unexpected } 片段，与原 IR 的任何片段都不相等
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
        } else if (node.type === 'inlineCode') {
            out.push({ code: node.value, formats: formats.join('+') });
        } else if (node.type !== 'html' || (node.value && !isComment(node.value))) {
            out.push({ unexpected: node.type, value: node.value });
        }
    }
    return out;
}

const isComment = (value) => value.startsWith(COMMENT_OPEN) && value.endsWith(COMMENT_CLOSE);

function appendSegment(out, value, formats) {
    if (!value) return;
    const key = formats.join('+');
    const last = out[out.length - 1];
    if (last && last.text !== undefined && last.formats === key) last.text += value;
    else out.push({ text: value, formats: key });
}

/** 文本与行内代码的原文串接（硬换行不计入），用于核对重新解析后是否多出定界符字符 */
const plainText = (nodes) => nodes.map((node) => {
    if (node.type === 'text' || node.type === 'inlineCode') return node.value;
    return plainText(node.children || []);
}).join('');

/**
 * 参照剔除：本文件独立实现的「去掉产物为空的节点」，不调用渲染器的内部函数。去掉 value 为空串的 text 与 html，以及子节点
 * 去掉之后已无子节点的六种格式节点；链接只剔除其子节点、不剔除自身。返回新数组，不修改入参
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

/** 参照改写：参照剔除之后，块末连续的 k 个 break 换成一个 html（k 个 HTML_BREAK 的拼接）。返回新数组，不修改入参 */
function referenceRewrite(nodes) {
    const pruned = referencePrune(nodes);
    let end = pruned.length;
    while (end > 0 && pruned[end - 1].type === 'break') end -= 1;
    return end === pruned.length ? pruned : [...pruned.slice(0, end), html(HTML_BREAK.repeat(pruned.length - end))];
}

/** 去掉块末硬换行的对照形态：参照剔除之后，末尾连续的 break 直接去掉 */
function withoutTrailingBreaks(nodes) {
    const pruned = referencePrune(nodes);
    let end = pruned.length;
    while (end > 0 && pruned[end - 1].type === 'break') end -= 1;
    return pruned.slice(0, end);
}

/** 期望的块类型是否相符：depth 为 0 时须为段落，否则须为该级标题 */
const isExpectedBlock = (block, depth) => Boolean(block) && (depth ? block.type === 'heading' && block.depth === depth : block.type === 'paragraph');

/** 按容器取出重新解析结果中对应的段落或标题；块结构不符时返回 null */
function blockNodeOf(tree, container, depth = 0) {
    const blocks = tree.children;
    if (container === 'paragraph') return blocks.length === 1 && isExpectedBlock(blocks[0], depth) ? blocks[0] : null;
    if (container === 'listItem') {
        if (blocks.length !== 1 || blocks[0].type !== 'list' || blocks[0].children.length !== 1) return null;
        const item = blocks[0].children[0];
        return item.type === 'listItem' && item.children.length === 1 && isExpectedBlock(item.children[0], depth) ? item.children[0] : null;
    }
    if (blocks.length !== 1 || blocks[0].type !== 'blockquote' || blocks[0].children.length !== 1) return null;
    return isExpectedBlock(blocks[0].children[0], depth) ? blocks[0].children[0] : null;
}

/** 重新解析 md 并与原 IR 比对：往返正确时返回 null，否则返回 { ir, md, reparsed, reasons } */
async function roundTripFailureOf(container, children, md, depth = 0) {
    const tree = await reparse(md);
    const reasons = [];
    const block = blockNodeOf(tree, container, depth);
    if (!block) {
        reasons.push('重新解析后的块结构与容器不符');
    } else {
        if (!isDeepStrictEqual(flatten(block.children), flatten(children))) reasons.push('片段序列与原 IR 不一致');
        const original = plainText(children);
        const reparsed = plainText(block.children);
        for (const char of DELIMITER_CHARS) {
            if (!original.includes(char) && reparsed.includes(char)) reasons.push(`重新解析文本出现原文没有的「${char}」`);
        }
    }
    return reasons.length ? { ir: describeIr(container, children, depth), md, reparsed: tree.children.map(brief), reasons } : null;
}

/** 渲染并重新解析，返回 { md, failure }：往返正确时 failure 为 null */
async function renderAndReparse(container, children, depth = 0) {
    const md = await renderIn(container, children, depth);
    return { md, failure: await roundTripFailureOf(container, children, md, depth) };
}

/** 逐例检查往返，返回失败项 */
async function roundTripFailures(cases) {
    const failures = [];
    for (const { container, children, depth = 0 } of cases) {
        const { failure } = await renderAndReparse(container, children, depth);
        if (failure) failures.push(failure);
    }
    return failures;
}

/** 往返失败的逐项说明：前 limit 项的 IR 描述、md 产物、失败原因与重新解析结果 */
function reportLines(failures, limit = MAX_REPORTED) {
    return failures.slice(0, limit).map((f, i) => `${i + 1}. ${f.ir} → ${JSON.stringify(f.md)}；`
        + `${f.reasons.join('、')}；重新解析：${JSON.stringify(f.reparsed)}`);
}

// ============================================================
// 带对照的形态：往返与逐字比对
// ============================================================

/**
 * 带对照的形态：container 与 children 为块所处容器及其子节点，depth 为标题级别（0 为段落，可由 extra 给出）；control 为
 * 去掉块末硬换行后的同一 IR，reference 为参照改写后的同一 IR（均先深拷贝，不与 children 共享节点）；extra 另记分类
 * 字段，供分类计数
 */
const withControl = (container, children, extra = {}) => ({
    container, children, depth: 0,
    control: withoutTrailingBreaks(structuredClone(children)),
    reference: referenceRewrite(structuredClone(children)),
    ...extra,
});

/**
 * 逐例检查带对照的形态，返回 { roundTrip, identity }：roundTrip 为往返失败项，identity 为产物与参照改写后的产物不同的项。
 * 各失败项另带原用例 item，供分类计数
 */
async function checkShapes(shapes) {
    const roundTrip = [];
    const identity = [];
    for (const item of shapes) {
        const { md, failure } = await renderAndReparse(item.container, item.children, item.depth);
        if (failure) roundTrip.push({ ...failure, item });
        const referenceMd = await renderIn(item.container, item.reference, item.depth);
        if (md !== referenceMd) identity.push({ ir: describeIr(item.container, item.children, item.depth), md, referenceMd, item });
    }
    return { roundTrip, identity };
}

/** 逐字比对失败的逐项说明：前 limit 项的 IR 描述、md 产物与参照改写后的产物 */
function identityLines(failures, limit = MAX_REPORTED) {
    return failures.slice(0, limit).map((f, i) => `${i + 1}. ${f.ir} → ${JSON.stringify(f.md)}；`
        + `参照改写后为 ${JSON.stringify(f.referenceMd)}`);
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

/**
 * 先断言对照形态（去掉块末硬换行后的 IR）往返正确：对照形态本身出错时该形态属范围外，不能用来判定块末硬换行的影响。
 * 只由硬换行构成的段落或标题去掉硬换行后为空块、没有对照形态，不在此列
 */
async function assertControlsRoundTrip(label, shapes) {
    const controls = shapes.filter((item) => item.control.length > 0)
        .map((item) => ({ container: item.container, children: item.control, depth: item.depth }));
    const failures = await roundTripFailures(controls);
    const lines = reportLines(failures);
    assert.equal(failures.length, 0, `${label}：去掉块末硬换行后的对照形态 ${controls.length} 例中 ${failures.length} 例往返失败（形态`
        + `本身属范围外），前 ${lines.length} 例：${NL}${lines.join(NL)}`);
}

/**
 * 按键统计：返回「键 出错数/总数（往返失败数、逐字比对失败数）」的列表，列出全部键；同一用例往返与逐字比对都失败时
 * 出错数只计一次
 */
function tally(shapes, { roundTrip, identity }, keyOf) {
    const roundTripItems = new Set(roundTrip.map((f) => f.item));
    const identityItems = new Set(identity.map((f) => f.item));
    const stats = new Map();
    for (const item of shapes) {
        const key = keyOf(item);
        const entry = stats.get(key) || { total: 0, failed: 0, roundTrip: 0, identity: 0 };
        entry.total += 1;
        if (roundTripItems.has(item)) entry.roundTrip += 1;
        if (identityItems.has(item)) entry.identity += 1;
        if (roundTripItems.has(item) || identityItems.has(item)) entry.failed += 1;
        stats.set(key, entry);
    }
    return [...stats].map(([key, e]) => `${key} ${e.failed}/${e.total}（往返 ${e.roundTrip}、逐字 ${e.identity}）`);
}

/**
 * 一次断言往返与逐字比对的结果。breakdowns 为 [标题, keyOf] 列表，按键列出各类的出错数与总数；给出 sampleBy 时
 * 失败信息每个键列出首例，否则列出前 limit 例
 */
function assertShapes(label, shapes, result, { breakdowns = [], sampleBy = null, limit = MAX_REPORTED } = {}) {
    const { roundTrip, identity } = result;
    const failedItems = new Set([...roundTrip, ...identity].map((f) => f.item));
    const summary = breakdowns.map(([title, keyOf]) => `${title}：${tally(shapes, result, keyOf).join('、')}`);
    const rtLines = sampleBy ? reportLines(firstPerKey(roundTrip, sampleBy), Infinity) : reportLines(roundTrip, limit);
    const idLines = sampleBy ? identityLines(firstPerKey(identity, sampleBy), Infinity) : identityLines(identity, limit);
    const scope = sampleBy ? '每类首例' : `前 ${limit} 例`;
    assert.equal(roundTrip.length + identity.length, 0, [
        `${label}：${shapes.length} 例中往返失败 ${roundTrip.length} 例、与参照改写后的产物不一致 ${identity.length} 例；`
            + `出错用例（往返或逐字比对失败）共 ${failedItems.size} 例`,
        ...summary,
        `往返失败（${scope}）：`, ...rtLines,
        `逐字比对失败（${scope}）：`, ...idLines,
    ].join(NL));
}

// 分类键：按容器、按级别
const byContainer = (item) => CONTAINER_NAMES[item.container];
const byDepth = (item) => `${DEPTH_NAMES[item.depth]}标题`;

// ============================================================
// 已列形态
// ============================================================

/** 段落：实测确认的 18 种形态；各行注释为修复前（a48ad6a）的产物与重新解析的结果 */
function listedShapes() {
    return [
        // 「甲\」加换行：重新解析为文本「甲\」
        withControl('paragraph', [text('甲'), hardBreak()]),
        // 「甲\」「\」两行：重新解析为「甲」、硬换行、「\」，只丢最后一个硬换行
        withControl('paragraph', [text('甲'), hardBreak(), hardBreak()]),
        // 「甲\」「\」「\」三行：重新解析为「甲」、两个硬换行、「\」
        withControl('paragraph', [text('甲'), hardBreak(), hardBreak(), hardBreak()]),
        // 「甲 \」加换行：重新解析为文本「甲 \」
        withControl('paragraph', [text('甲 '), hardBreak()]),
        // 「甲\\\」加换行：文本的反斜杠转义为两个，重新解析为文本「甲\\」
        withControl('paragraph', [text(`甲${BACKSLASH}`), hardBreak()]),
        // 空文本先被剔除，产物同第一例
        withControl('paragraph', [text('甲'), text(''), hardBreak()]),
        withControl('paragraph', [text('甲'), hardBreak(), text('')]),
        withControl('paragraph', [text('甲'), hardBreak(), html('')]),
        // 「`x`\」加换行：重新解析为行内代码加文本「\」
        withControl('paragraph', [inlineCode('x'), hardBreak()]),
        // 「**甲**\」加换行：重新解析为粗体加文本「\」
        withControl('paragraph', [strong('甲'), hardBreak()]),
        // 「**甲。**\」加换行：闭定界符后为 ASCII 标点，定界符仍成立，重新解析为粗体加文本「\」
        withControl('paragraph', [strong('甲。'), hardBreak()]),
        // 「<u>甲</u>\」加换行：重新解析为下划线加文本「\」
        withControl('paragraph', [underline('甲'), hardBreak()]),
        // 「[甲](https://a.com)\」加换行：重新解析为链接加文本「\」
        withControl('paragraph', [link('甲'), hardBreak()]),
        // 「<strong>甲\」「</strong>\」两行：粗体内的硬换行保住，段尾的成为文本「\」
        withControl('paragraph', [strong('甲', hardBreak()), hardBreak()]),
        // 「- 甲\」加换行：列表项内的段落同样
        withControl('listItem', [text('甲'), hardBreak()]),
        // 「> 甲\」加换行：引用块内的段落同样
        withControl('blockquote', [text('甲'), hardBreak()]),
        // 「> 甲\」「> \」两行
        withControl('blockquote', [text('甲'), hardBreak(), hardBreak()]),
        // 「\」「\」两行：只由两个硬换行构成的段落重新解析为硬换行加文本「\」
        withControl('paragraph', [hardBreak(), hardBreak()]),
    ];
}

/** 标题：实测确认的 23 种形态；各行注释为修复前（a48ad6a）的产物与重新解析的结果 */
function listedHeadingShapes() {
    const heading = (depth, container, children) => withControl(container, children, { depth });
    return [
        // 1–2 级：「甲\」加换行再加空行（setext 形式，下划线长度为 0），重新解析为段落「甲\」，标题丢失
        heading(1, 'paragraph', [text('甲'), hardBreak()]),
        heading(2, 'paragraph', [text('甲'), hardBreak()]),
        // 3–6 级：「### 甲 」（ATX 形式，硬换行写成空格），重新解析为标题「甲」，硬换行丢失
        heading(3, 'paragraph', [text('甲'), hardBreak()]),
        heading(4, 'paragraph', [text('甲'), hardBreak()]),
        heading(5, 'paragraph', [text('甲'), hardBreak()]),
        heading(6, 'paragraph', [text('甲'), hardBreak()]),
        // 「甲\」「\」两行再加空行：重新解析为段落「甲」、硬换行、「\」
        heading(2, 'paragraph', [text('甲'), hardBreak(), hardBreak()]),
        // 「### 甲 」：第二个硬换行的前一字已是空格，写成空串；重新解析为标题「甲」
        heading(3, 'paragraph', [text('甲'), hardBreak(), hardBreak()]),
        // 「### 甲  」：三个硬换行写成两个空格
        heading(3, 'paragraph', [text('甲'), hardBreak(), hardBreak(), hardBreak()]),
        // 「甲 \」加换行再加空行：重新解析为段落「甲 \」
        heading(2, 'paragraph', [text('甲 '), hardBreak()]),
        // 「### 甲 」：末尾空格之后的硬换行写成空串，重新解析为标题「甲」，末尾空格与硬换行都丢失
        heading(3, 'paragraph', [text('甲 '), hardBreak()]),
        // 「甲\\\」加换行再加空行：文本的反斜杠转义为两个，重新解析为段落「甲\\」
        heading(2, 'paragraph', [text(`甲${BACKSLASH}`), hardBreak()]),
        // 「**甲**\」加换行再加空行：重新解析为段落，粗体加文本「\」
        heading(2, 'paragraph', [strong('甲'), hardBreak()]),
        // 「### `x` 」：重新解析为只含行内代码的标题
        heading(3, 'paragraph', [inlineCode('x'), hardBreak()]),
        // 「[甲](https://a.com)\」加换行再加空行：重新解析为段落，链接加文本「\」
        heading(2, 'paragraph', [link('甲'), hardBreak()]),
        // 空节点先被剔除，产物同前
        heading(2, 'paragraph', [text('甲'), hardBreak(), text('')]),
        heading(3, 'paragraph', [text('甲'), text(''), hardBreak(), html('')]),
        // 只由硬换行构成的标题：「##」为空标题；「### &#x20;」（首个写空格、第二个写空串，行首空格转义为字符引用）为只含
        // 一个空格的标题
        heading(2, 'paragraph', [hardBreak()]),
        heading(3, 'paragraph', [hardBreak(), hardBreak()]),
        // 列表项与引用块内：「- 甲\」加换行再加空行、「> 甲\」「>」「>」三行，标题都变成段落；「- ### 甲 」「> ### 甲 」硬换行丢失
        heading(2, 'listItem', [text('甲'), hardBreak()]),
        heading(2, 'blockquote', [text('甲'), hardBreak()]),
        heading(3, 'listItem', [text('甲'), hardBreak(), hardBreak()]),
        heading(3, 'blockquote', [text('甲'), hardBreak()]),
    ];
}

// ============================================================
// 矩阵
// ============================================================

// 块末硬换行之前的内容（前缀）：以工厂给出，每例新建节点
const PREFIXES = [
    ['汉字', () => [text('甲')]],
    ['中文标点', () => [text('甲。')]],
    ['ASCII', () => [text('ab')]],
    ['末尾空格', () => [text('甲 ')]],
    ['末尾反斜杠', () => [text(`甲${BACKSLASH}`)]],
    ['两个反斜杠', () => [text(`甲${BACKSLASH}${BACKSLASH}`)]],
    ['星号', () => [text('*')]],
    ['波浪号', () => [text('~')]],
    ['小于号', () => [text('甲<')]],
    ['小于号加字母', () => [text('甲<b')]],
    ['和号', () => [text('甲&')]],
    ['感叹号', () => [text('甲!')]],
    ['数字结尾', () => [text('第1')]],
    ['行首记号', () => [text('1. 项')]],
    ['井号', () => [text('# 标题')]],
    ['表情', () => [text(EMOJI)]],
    ['粗体', () => [strong('甲')]],
    ['标点结尾的粗体', () => [strong('甲。')]],
    ['斜体', () => [emphasis('a')]],
    ['删除线', () => [del('甲')]],
    ['下划线', () => [underline('甲')]],
    ['上标', () => [superscript('2')]],
    ['下标', () => [subscript('n')]],
    ['嵌套格式', () => [strong(emphasis('甲'))]],
    ['链接', () => [link('甲')]],
    ['自动链接', () => [link(LINK_URL)]],
    ['行内代码', () => [inlineCode('x')]],
    ['带反引号的行内代码', () => [inlineCode('a`b')]],
    ['段中硬换行', () => [text('甲'), hardBreak(), text('乙')]],
    ['以硬换行结尾的粗体', () => [strong('甲', hardBreak())]],
    ['以硬换行结尾的链接', () => [link('甲', hardBreak())]],
    ['末尾夹空文本', () => [text('甲'), text('')]],
    ['末尾夹空格式', () => [text('甲'), strong()]],
];
// 前缀内部含硬换行的三种：3 级起的标题走 ATX 形式，上游把这些硬换行写成空格（范围外），标题矩阵在 3 级起不取
const INNER_BREAK_PREFIXES = new Set(['段中硬换行', '以硬换行结尾的粗体', '以硬换行结尾的链接']);
const headingPrefixes = (depth) => (depth <= 2 ? PREFIXES : PREFIXES.filter(([name]) => !INNER_BREAK_PREFIXES.has(name)));
// 块末硬换行之间与之后插入的空节点：以工厂给出
const TRAILING_EMPTIES = [
    ['无', () => []],
    ['空文本', () => [text('')]],
    ['空 html', () => [html('')]],
    ['空 strong', () => [strong()]],
    ['嵌套空格式', () => [del(strong(text('')))]],
];
const NONEMPTY_TRAILING_EMPTIES = TRAILING_EMPTIES.filter(([name]) => name !== '无');
const TRAILING_COUNTS = [1, 2, 3];
// 标题矩阵中带尾随空节点变体的级别：setext 倾向的 2 级与 ATX 的 3 级各取一个
const EMPTY_VARIANT_DEPTHS = [2, 3];

/** 一例的子节点：前缀，随后 count 个硬换行，首个硬换行之后与末尾各插一组空节点 */
function matrixChildren(prefix, count, empty) {
    const children = [...prefix()];
    for (let i = 0; i < count; i += 1) {
        children.push(hardBreak());
        if (i === 0) children.push(...empty());
    }
    children.push(...empty());
    return children;
}

/** 段落矩阵：前缀 × 段尾硬换行个数 × 尾随空节点 × 容器，另加只由 2–3 个硬换行构成的段落 */
function buildMatrix() {
    const cases = [];
    const push = (container, prefixName, count, emptyName, prefix, empty) => {
        cases.push(withControl(container, matrixChildren(prefix, count, empty), { prefix: prefixName, count: `段尾 ${count} 个`, empty: emptyName }));
    };
    for (const [prefixName, prefix] of PREFIXES) {
        for (const count of TRAILING_COUNTS) {
            for (const [emptyName, empty] of TRAILING_EMPTIES) {
                for (const container of CONTAINERS) push(container, prefixName, count, emptyName, prefix, empty);
            }
        }
    }
    for (const count of TRAILING_COUNTS.filter((n) => n >= 2)) {
        for (const [emptyName, empty] of TRAILING_EMPTIES) {
            for (const container of CONTAINERS) push(container, '只由硬换行构成', count, emptyName, () => [], empty);
        }
    }
    return cases;
}

/**
 * 标题矩阵：前缀（3 级起去掉内部含硬换行的三种）× 1–6 级 × 末尾硬换行个数 × 容器（无尾随空节点），另加 2 级与 3 级 ×
 * 4 种非空的尾随空节点（段落容器），以及只由 1–3 个硬换行构成的 1–6 级标题（3 种容器）与其 2 级、3 级的尾随空节点变体
 */
function buildHeadingMatrix() {
    const cases = [];
    const push = (depth, container, prefixName, count, emptyName, prefix, empty) => {
        cases.push(withControl(container, matrixChildren(prefix, count, empty), {
            depth, prefix: prefixName, count: `末尾 ${count} 个`, empty: emptyName,
        }));
    };
    const [noEmptyName, noEmpty] = TRAILING_EMPTIES[0];
    for (const depth of DEPTHS) {
        for (const [prefixName, prefix] of headingPrefixes(depth)) {
            for (const count of TRAILING_COUNTS) {
                for (const container of CONTAINERS) push(depth, container, prefixName, count, noEmptyName, prefix, noEmpty);
                if (EMPTY_VARIANT_DEPTHS.includes(depth)) {
                    for (const [emptyName, empty] of NONEMPTY_TRAILING_EMPTIES) push(depth, 'paragraph', prefixName, count, emptyName, prefix, empty);
                }
            }
        }
        for (const count of TRAILING_COUNTS) {
            for (const container of CONTAINERS) push(depth, container, '只由硬换行构成', count, noEmptyName, () => [], noEmpty);
            if (EMPTY_VARIANT_DEPTHS.includes(depth)) {
                for (const [emptyName, empty] of NONEMPTY_TRAILING_EMPTIES) push(depth, 'paragraph', '只由硬换行构成', count, emptyName, () => [], empty);
            }
        }
    }
    return cases;
}

/** 标题矩阵的期望规模：按上述维度算出 */
function headingMatrixSize() {
    let size = 0;
    for (const depth of DEPTHS) {
        const prefixCount = headingPrefixes(depth).length + 1;
        size += prefixCount * TRAILING_COUNTS.length * CONTAINERS.length;
        if (EMPTY_VARIANT_DEPTHS.includes(depth)) size += prefixCount * TRAILING_COUNTS.length * NONEMPTY_TRAILING_EMPTIES.length;
    }
    return size;
}

// ============================================================
// 种子随机往返
// ============================================================

const SEED = 20260928;
const HEADING_SEED = 20260930;
const RANDOM_COUNT = 2000;
const MAX_ITEMS = 5;
const MAX_DEPTH = 2;
const TRAILING_RATE = 0.7;
const MID_BREAK_RATE = 0.15;
const MID_EMPTY_RATE = 0.2;
const RUN_EMPTY_RATE = 0.3;

// 随机文本池：汉字、中文标点、ASCII 与标点、定界符字符、末尾反斜杠、首尾空格、数字结尾、行首记号、辅助平面表情；
// 不含换行、制表符与「www」「@」「:」
const TEXT_POOL = [
    '甲', '乙丙', '加粗', '前', '后',
    '。', '，', '《乙》', '甲。', '「甲', '》', '（注）',
    'ab', '!', 'a b', 'x.', '(y)', 'A-b', 'a_b', '[x]', '<', '&', '&amp', '<b',
    '*', '~', '**', '~~', 'a*b',
    `甲${BACKSLASH}`, `ab${BACKSLASH}`, BACKSLASH, `${BACKSLASH}${BACKSLASH}`,
    '甲 ', 'ab  ', ' 甲',
    '第1', '2026', '1.', '1)', '1. 项', '# 标题', '- 项', '+ 项', '> 引',
    EMOJI, `甲${EMOJI}`, `${EMOJI}。`,
];
const CODE_VALUES = ['x', 'a b', '甲', '`', 'a`b', ' x '];

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

/** 产物为空的节点：空文本 40%、空 html 25%、无子节点的格式 20%、只含空文本的格式 10%、嵌套空格式 5% */
function randomEmpty(rand) {
    const roll = rand();
    if (roll < 0.4) return text('');
    if (roll < 0.65) return html('');
    if (roll < 0.85) return format(pick(rand, FORMAT_TYPES))();
    if (roll < 0.95) return format(pick(rand, FORMAT_TYPES))(text(''));
    return del(strong(text('')));
}

/**
 * 格式节点或链接的子节点：1–3 个可见项，项间按 10% 插硬换行、按 15% 插空节点；链接之内不再嵌套链接。innerBreak 为假时
 * 不插硬换行（掷点照常，只是不插）
 */
function randomInnerChildren(rand, depth, inLink, innerBreak) {
    const count = 1 + Math.floor(rand() * 3);
    const nodes = [];
    for (let i = 0; i < count; i += 1) {
        if (i > 0) {
            const roll = rand();
            if (roll < 0.1) {
                if (innerBreak) nodes.push(hardBreak());
            } else if (roll < 0.25) nodes.push(randomEmpty(rand));
        }
        nodes.push(...randomVisible(rand, depth, inLink, innerBreak));
    }
    return nodes;
}

/**
 * 一个可见项：文本 55%、格式节点 20%、链接 10%、行内代码 10%、以硬换行结尾的格式节点或链接 5%；深度达到上限时只取文本，
 * 链接之内不取链接。innerBreak 为假时末一类不再以硬换行结尾
 */
function randomVisible(rand, depth, inLink, innerBreak) {
    const roll = rand();
    if (depth >= MAX_DEPTH || roll < 0.55) return [text(pick(rand, TEXT_POOL))];
    if (roll < 0.75 || inLink) return [format(pick(rand, FORMAT_TYPES))(...randomInnerChildren(rand, depth + 1, inLink, innerBreak))];
    if (roll < 0.85) return [link(...randomInnerChildren(rand, depth + 1, true, innerBreak))];
    if (roll < 0.95) return [inlineCode(pick(rand, CODE_VALUES))];
    const asLink = rand() < 0.5;
    const inner = [...randomInnerChildren(rand, depth + 1, inLink || asLink, innerBreak), ...(innerBreak ? [hardBreak()] : [])];
    return [asLink ? link(...inner) : format(pick(rand, FORMAT_TYPES))(...inner)];
}

/**
 * 一个随机块的容器与子节点：1–MAX_ITEMS 个可见项，项间按 MID_BREAK_RATE 插硬换行、按 MID_EMPTY_RATE 插空节点；随后按
 * TRAILING_RATE 追加 1–3 个块末硬换行，硬换行之间与之后按 RUN_EMPTY_RATE 各插一个空节点。innerBreak 为假时项间与格式
 * 节点内不插硬换行（掷点照常）。返回 { container, children, trailing }
 */
function randomBlock(rand, innerBreak = true) {
    const containerRoll = rand();
    const container = containerRoll < 0.7 ? 'paragraph' : containerRoll < 0.85 ? 'listItem' : 'blockquote';
    const children = [];
    const size = 1 + Math.floor(rand() * MAX_ITEMS);
    for (let i = 0; i < size; i += 1) {
        if (i > 0) {
            const roll = rand();
            if (roll < MID_BREAK_RATE) {
                if (innerBreak) children.push(hardBreak());
            } else if (roll < MID_BREAK_RATE + MID_EMPTY_RATE) children.push(randomEmpty(rand));
        }
        children.push(...randomVisible(rand, 0, false, innerBreak));
    }
    let trailing = 0;
    if (rand() < TRAILING_RATE) {
        trailing = 1 + Math.floor(rand() * 3);
        for (let i = 0; i < trailing; i += 1) {
            if (i > 0 && rand() < RUN_EMPTY_RATE) children.push(randomEmpty(rand));
            children.push(hardBreak());
        }
        if (rand() < RUN_EMPTY_RATE) children.push(randomEmpty(rand));
    }
    return { container, children, trailing };
}

/** count 个随机段落 */
function randomParagraphs(seed, count) {
    const rand = mulberry32(seed);
    const paragraphs = [];
    for (let k = 0; k < count; k += 1) paragraphs.push(randomBlock(rand));
    return paragraphs;
}

/** count 个随机标题：级别 1–6 均匀；3 级起不插段中硬换行、不取以硬换行结尾的格式节点或链接（范围外） */
function randomHeadings(seed, count) {
    const rand = mulberry32(seed);
    const headings = [];
    for (let k = 0; k < count; k += 1) {
        const depth = 1 + Math.floor(rand() * DEPTHS.length);
        headings.push({ ...randomBlock(rand, depth <= 2), depth });
    }
    return headings;
}

// ============================================================
// 用例：已列形态
// ============================================================

test('已列形态（段落）：段尾硬换行的 18 种形态（单个、两个、三个；前面为末尾空格、末尾反斜杠、空节点、行内代码、粗体、标点结尾的粗体、下划线、链接、以硬换行结尾的粗体；之后夹空文本或空 html；列表项与引用块内；只由两个硬换行构成），对照形态往返正确；各例重新解析后硬换行个数与位置、格式与文本均不变，产物与参照改写后的同一 IR 逐字相同', async () => {
    // Arrange
    const shapes = listedShapes();
    assert.equal(shapes.length, 18);
    await assertControlsRoundTrip('已列形态（段落）', shapes);

    // Act
    const result = await checkShapes(shapes);

    // Assert：失败信息列出全部 18 例
    assertShapes('已列形态（段落）', shapes, result, { limit: shapes.length });
});

test('已列形态（标题）：末尾硬换行的 23 种形态（1–6 级各一个；2 级与 3 级两个、3 级三个；前面为末尾空格、末尾反斜杠、粗体、行内代码、链接；前后夹空节点；只由硬换行构成的 2 级与 3 级标题；列表项与引用块内的 2 级与 3 级标题），对照形态往返正确；各例重新解析后仍为同级标题，硬换行个数与位置、格式与文本均不变，产物与参照改写后的同一 IR 逐字相同', async () => {
    // Arrange
    const shapes = listedHeadingShapes();
    assert.equal(shapes.length, 23);
    await assertControlsRoundTrip('已列形态（标题）', shapes);

    // Act
    const result = await checkShapes(shapes);

    // Assert：失败信息列出全部 23 例
    assertShapes('已列形态（标题）', shapes, result, { limit: shapes.length });
});

// ============================================================
// 用例：矩阵
// ============================================================

test('矩阵（段落）：33 种前缀 × 段尾 1–3 个硬换行 × 5 种尾随空节点 × 3 种容器，另加只由 2–3 个硬换行构成的段落，共 1515 例，对照形态往返正确；各例重新解析后硬换行个数与位置、格式与文本均不变，产物与参照改写后的同一 IR 逐字相同', async () => {
    // Arrange
    const cases = buildMatrix();
    assert.equal(cases.length, PREFIXES.length * TRAILING_COUNTS.length * TRAILING_EMPTIES.length * CONTAINERS.length
        + 2 * TRAILING_EMPTIES.length * CONTAINERS.length);
    assert.equal(cases.length, 1515);
    await assertControlsRoundTrip('矩阵（段落）', cases);

    // Act
    const result = await checkShapes(cases);

    // Assert：失败信息按前缀、个数、空节点与容器分别计数，每种前缀列出首例
    const byPrefix = (item) => item.prefix;
    assertShapes('矩阵（段落）', cases, result, {
        breakdowns: [
            ['按前缀', byPrefix], ['按个数', (item) => item.count], ['按空节点', (item) => item.empty], ['按容器', byContainer],
        ],
        sampleBy: byPrefix,
    });
});

test('矩阵（标题）：前缀（3 级起去掉内部含硬换行的三种）× 1–6 级 × 末尾 1–3 个硬换行 × 3 种容器，另加 2 级与 3 级的 4 种尾随空节点变体，以及只由 1–3 个硬换行构成的标题，共 2508 例，对照形态往返正确；各例重新解析后仍为同级标题，硬换行个数与位置、格式与文本均不变，产物与参照改写后的同一 IR 逐字相同', async () => {
    // Arrange
    const cases = buildHeadingMatrix();
    assert.equal(cases.length, headingMatrixSize());
    assert.equal(cases.length, 2508);
    await assertControlsRoundTrip('矩阵（标题）', cases);

    // Act
    const result = await checkShapes(cases);

    // Assert：失败信息按级别、前缀、个数、空节点与容器分别计数，每个「级别 + 前缀」列出首例
    const byDepthAndPrefix = (item) => `${byDepth(item)}/${item.prefix}`;
    assertShapes('矩阵（标题）', cases, result, {
        breakdowns: [
            ['按级别', byDepth], ['按前缀', (item) => item.prefix], ['按个数', (item) => item.count],
            ['按空节点', (item) => item.empty], ['按容器', byContainer],
        ],
        sampleBy: byDepthAndPrefix,
    });
});

// ============================================================
// 用例：回归护栏（修复前后均应通过）
// ============================================================

test('回归护栏：不含块末硬换行的 30 种形态（段首与段中的硬换行、六种格式节点与链接末尾的硬换行、只含硬换行的 strong、嵌套格式末尾、格式节点末尾硬换行之后有文本、硬换行后接以空格开头的文本、标题段首与段中的硬换行、标题末尾格式节点内的硬换行、表格单元格内的硬换行、硬换行后紧接非空 html）产物逐字不变，其中格式节点与链接末尾的硬换行、1–2 级标题的段首与段中硬换行及末尾格式节点内的硬换行往返正确', async () => {
    // Arrange：期望值取自现行代码（a48ad6a）的实际产物；roundTrip 标出重新解析后硬换行保住的形态
    const BR = `${BACKSLASH}${NL}`;
    const table = (cell) => createTable([null], [createTableRow([createTableCell([text(TABLE_HEAD)])]), createTableRow([createTableCell(cell)])]);
    const cases = [
        // 段首与段中的硬换行：解析器认「\ + 换行」
        { block: createParagraph([hardBreak(), text('甲')]), md: `${BR}甲${NL}`, roundTrip: true },
        { block: createParagraph([text('甲'), hardBreak(), text('乙')]), md: `甲${BR}乙${NL}`, roundTrip: true },
        { block: createParagraph([text('甲'), hardBreak(), hardBreak(), text('乙')]), md: `甲${BR}${BR}乙${NL}`, roundTrip: true },
        { block: createParagraph([text('甲'), hardBreak(), text(' 乙')]), md: `甲${BR}&#x20;乙${NL}`, roundTrip: true },
        // 六种格式节点末尾的硬换行：内容以换行结尾，定界符式格式回退为标签，「\ + 换行」之后有闭标签
        { block: createParagraph([strong('甲', hardBreak())]), md: `<strong>甲${BR}</strong>${NL}`, roundTrip: true },
        { block: createParagraph([emphasis('甲', hardBreak())]), md: `<em>甲${BR}</em>${NL}`, roundTrip: true },
        { block: createParagraph([del('甲', hardBreak())]), md: `<del>甲${BR}</del>${NL}`, roundTrip: true },
        { block: createParagraph([underline('甲', hardBreak())]), md: `<u>甲${BR}</u>${NL}`, roundTrip: true },
        { block: createParagraph([superscript('甲', hardBreak())]), md: `<sup>甲${BR}</sup>${NL}`, roundTrip: true },
        { block: createParagraph([subscript('甲', hardBreak())]), md: `<sub>甲${BR}</sub>${NL}`, roundTrip: true },
        { block: createParagraph([text('前'), strong('甲', hardBreak())]), md: `前<strong>甲${BR}</strong>${NL}`, roundTrip: true },
        { block: createParagraph([strong('甲', hardBreak(), hardBreak())]), md: `<strong>甲${BR}${BR}</strong>${NL}`, roundTrip: true },
        { block: createParagraph([strong(emphasis('甲', hardBreak()))]), md: `**<em>甲${BR}</em>**${NL}`, roundTrip: true },
        { block: createParagraph([strong('甲', hardBreak()), text('乙')]), md: `<strong>甲${BR}</strong>乙${NL}`, roundTrip: true },
        { block: createParagraph([underline('甲', hardBreak()), text('乙')]), md: `<u>甲${BR}</u>乙${NL}`, roundTrip: true },
        { block: createParagraph([strong('甲', hardBreak(), '乙')]), md: `**甲${BR}乙**${NL}`, roundTrip: true },
        { block: createParagraph([text('前'), strong(hardBreak(), '甲')]), md: `前<strong>${BR}甲</strong>${NL}`, roundTrip: true },
        // 只含硬换行的 strong：liftInlineHtml 拆除只包着换行的格式标签，格式丢失、硬换行保住（范围外，按现状断言）
        { block: createParagraph([text('甲'), strong(hardBreak())]), md: `甲<strong>${BR}</strong>${NL}`, roundTrip: false },
        // 链接末尾与中间的硬换行：「\ + 换行」之后紧随「](」或文本
        { block: createParagraph([link('甲', hardBreak())]), md: `[甲${BR}](${LINK_URL})${NL}`, roundTrip: true },
        { block: createParagraph([link('甲', hardBreak()), text('乙')]), md: `[甲${BR}](${LINK_URL})乙${NL}`, roundTrip: true },
        { block: createParagraph([link('甲', hardBreak(), '乙')]), md: `[甲${BR}乙](${LINK_URL})${NL}`, roundTrip: true },
        // 标题段首与段中的硬换行：1–2 级由上游改走 setext 形式，往返正确；3 级起在 ATX 形式中写成空格（段首的写成空串），
        // 硬换行丢失（上游行为，范围外，按现状断言）
        { block: createHeading(1, [hardBreak(), text('甲')]), md: `${BR}甲${NL}=${NL}`, roundTrip: true },
        { block: createHeading(2, [text('甲'), hardBreak(), text('乙')]), md: `甲${BR}乙${NL}-${NL}`, roundTrip: true },
        { block: createHeading(3, [hardBreak(), text('甲')]), md: `### 甲${NL}`, roundTrip: false },
        { block: createHeading(3, [text('甲'), hardBreak(), text('乙')]), md: `### 甲 乙${NL}`, roundTrip: false },
        // 标题末尾格式节点内的硬换行：2 级走 setext 形式，「\ + 换行」之后有闭标签，往返正确；3 级写成空格（范围外，按现状断言）
        { block: createHeading(2, [strong('甲', hardBreak())]), md: `<strong>甲${BR}</strong>${NL}${'-'.repeat(9)}${NL}`, roundTrip: true },
        { block: createHeading(3, [strong('甲', hardBreak())]), md: `### <strong>甲 </strong>${NL}`, roundTrip: false },
        // 表格单元格内的硬换行：上游改为空格，段尾的空格随单元格对齐留在竖线之前（范围外，按现状断言）
        { block: table([text('甲'), hardBreak()]), md: `| ${TABLE_HEAD} |${NL}| -- |${NL}| 甲  |${NL}`, roundTrip: false },
        { block: table([text('甲'), hardBreak(), text('乙')]), md: `| ${TABLE_HEAD}  |${NL}| --- |${NL}| 甲 乙 |${NL}`, roundTrip: false },
        // 硬换行之后紧接非空 html：containerPhrasing 把 html 之前的行尾换行改为空格（上游既有行为，范围外，按现状断言）
        { block: createParagraph([text('甲'), hardBreak(), html('<!---->')]), md: `甲${BACKSLASH} <!---->${NL}`, roundTrip: false },
    ];
    assert.equal(cases.length, 30);

    for (const { block, md: expected, roundTrip } of cases) {
        // Act
        const md = await renderBlock(block);

        // Assert
        const depth = block.type === 'heading' ? block.depth : 0;
        const label = block.type === 'table' ? block.type : describeIr('paragraph', block.children, depth);
        assert.equal(md, expected, `${label} 的产物`);
        if (roundTrip) {
            const failure = await roundTripFailureOf('paragraph', block.children, md, depth);
            assert.equal(failure, null, failure && reportLines([failure]).join(NL));
        }
    }
});

// ============================================================
// 用例：已知限制
// ============================================================

test('已知限制：只由一个硬换行构成的段落输出「<br>」独占一行，重新解析为块级 html 节点（第 7 类 HTML 块）；只由两个硬换行构成的段落输出「<br><br>」，仍为段落；只由一个硬换行构成的标题有「#」前缀，输出「## <br>」，仍为标题', async () => {
    // Arrange
    const single = [
        { container: 'paragraph', children: [hardBreak()], md: `${HTML_BREAK}${NL}`, blocks: [{ html: HTML_BREAK }] },
        { container: 'paragraph', children: [text(''), hardBreak(), strong()], md: `${HTML_BREAK}${NL}`, blocks: [{ html: HTML_BREAK }] },
        { container: 'listItem', children: [hardBreak()], md: `- ${HTML_BREAK}${NL}`, blocks: [{ list: [{ listItem: [{ html: HTML_BREAK }] }] }] },
        { container: 'blockquote', children: [hardBreak()], md: `> ${HTML_BREAK}${NL}`, blocks: [{ blockquote: [{ html: HTML_BREAK }] }] },
    ];

    for (const { container, children, md: expected, blocks } of single) {
        // Act
        const md = await renderIn(container, children);
        const tree = await reparse(md);

        // Assert
        assert.equal(md, expected, describeIr(container, children));
        assert.deepEqual(tree.children.map(brief), blocks, describeIr(container, children));
    }

    // 两个硬换行：一行内有两个标签，不构成 HTML 块
    const md = await renderIn('paragraph', [hardBreak(), hardBreak()]);
    assert.equal(md, `${HTML_BREAK}${HTML_BREAK}${NL}`);
    assert.deepEqual((await reparse(md)).children.map(brief), [{ paragraph: ['BR', 'BR'] }]);

    // 标题：「#」前缀在前，「<br>」不在行首，仍为标题
    const headingMd = await renderIn('paragraph', [hardBreak()], 2);
    assert.equal(headingMd, `## ${HTML_BREAK}${NL}`);
    assert.deepEqual((await reparse(headingMd)).children.map(brief), [{ heading: ['BR'] }]);
});

test('已知限制：块末硬换行之前的文本以换行结尾时，containerPhrasing 把该换行改为空格，输出「甲 <br>」，重新解析后硬换行仍在、文本末尾的换行变为空格；前一兄弟为格式节点时产物以闭标签收尾，不触发该规则', async () => {
    // Arrange：修复前（cea59b1，与 a48ad6a 相同）三例依次输出「甲」换行「\」换行、「甲」换行「\」换行「\」换行、
    // 「<strong>甲」换行「</strong>\」换行，块末的硬换行都重新解析为字面反斜杠
    const cases = [
        { children: [text(`甲${NL}`), hardBreak()], md: `甲 ${HTML_BREAK}${NL}`, blocks: [{ paragraph: ['甲 ', 'BR'] }] },
        { children: [text(`甲${NL}`), hardBreak(), hardBreak()], md: `甲 ${HTML_BREAK}${HTML_BREAK}${NL}`, blocks: [{ paragraph: ['甲 ', 'BR', 'BR'] }] },
        // 对照：粗体的内容以换行结尾，回退为标签，产物以「</strong>」收尾，换行留在粗体之内
        { children: [strong(`甲${NL}`), hardBreak()], md: `<strong>甲${NL}</strong>${HTML_BREAK}${NL}`, blocks: [{ paragraph: [{ strong: [`甲${NL}`] }, 'BR'] }] },
    ];

    for (const { children, md: expected, blocks } of cases) {
        // Act
        const md = await renderIn('paragraph', children);
        const tree = await reparse(md);

        // Assert
        const label = describeIr('paragraph', children);
        assert.equal(md, expected, label);
        assert.deepEqual(tree.children.map(brief), blocks, label);
        const breaks = blockNodeOf(tree, 'paragraph').children.filter((node) => node.type === 'break').length;
        assert.equal(breaks, children.filter((node) => node.type === 'break').length, `${label} 重新解析后的硬换行个数`);
    }
});

// ============================================================
// 用例：种子随机往返
// ============================================================

test(`种子随机往返（段落）：种子 ${SEED} 生成 ${RANDOM_COUNT} 段（段落、列表项与引用块内），含段尾硬换行的段不少于 1200 个；逐例往返正确，产物与参照改写后的同一 IR 逐字相同`, async () => {
    // Arrange
    const paragraphs = randomParagraphs(SEED, RANDOM_COUNT);
    const withTrailing = paragraphs.filter((item) => item.trailing > 0).length;
    assert.ok(withTrailing >= 1200, `含段尾硬换行的段只有 ${withTrailing} 个`);
    const shapes = paragraphs.map(({ container, children, trailing }) => withControl(container, children, {
        trailing: trailing ? `段尾 ${trailing} 个` : '无段尾硬换行',
    }));

    // Act
    const result = await checkShapes(shapes);

    // Assert：失败信息按段尾硬换行个数与容器分别计数
    assertShapes('种子随机往返（段落）', shapes, result, {
        breakdowns: [['按段尾硬换行个数', (item) => item.trailing], ['按容器', byContainer]],
    });
});

test(`种子随机往返（标题）：种子 ${HEADING_SEED} 生成 ${RANDOM_COUNT} 个 1–6 级标题（段落、列表项与引用块内，3 级起不含段中硬换行），含末尾硬换行的不少于 1200 个、每级不少于 250 个；逐例往返正确，产物与参照改写后的同一 IR 逐字相同`, async () => {
    // Arrange
    const headings = randomHeadings(HEADING_SEED, RANDOM_COUNT);
    const withTrailing = headings.filter((item) => item.trailing > 0).length;
    assert.ok(withTrailing >= 1200, `含末尾硬换行的标题只有 ${withTrailing} 个`);
    for (const depth of DEPTHS) {
        const count = headings.filter((item) => item.depth === depth).length;
        assert.ok(count >= 250, `${DEPTH_NAMES[depth]}标题只有 ${count} 个`);
    }
    const shapes = headings.map(({ container, children, trailing, depth }) => withControl(container, children, {
        depth, trailing: trailing ? `末尾 ${trailing} 个` : '无末尾硬换行',
    }));

    // Act
    const result = await checkShapes(shapes);

    // Assert：失败信息按级别、末尾硬换行个数与容器分别计数
    assertShapes('种子随机往返（标题）', shapes, result, {
        breakdowns: [['按级别', byDepth], ['按末尾硬换行个数', (item) => item.trailing], ['按容器', byContainer]],
    });
});
