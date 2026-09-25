/**
 * converters/renderers/md.js：root 的子节点含上游 phrasing 类型时不进入 phrasing 语境，render() 在行内语境中所做的剔除、
 * 合并、分隔与块末硬换行改写也都不作用于 root 的子节点
 * 成因：mdast-util-to-markdown 2.1.2 的 root 处理器（lib/handle/root.js）在子节点含 phrasing 类型时改用 containerPhrasing，
 * 把全部子节点当作一段行内内容拼接；phrasing 类型取自 mdast-util-phrasing 4.1.0 的列表，不含 html 与本项目自定义的
 * underline、superscript、subscript。与 paragraph 处理器不同，root 处理器不进入 paragraph 与 phrasing 语境，lib/unsafe.js
 * 中限定 inConstruct: 'phrasing' 的转义模式一概不生效：「*」「_」「`」「~」「&」「<」、「!」加「[」、行首行尾空白、反斜杠加
 * 换行照原样写出，如修复前 [text('*甲*')] 输出「*甲*」、重新解析为强调。render() 的 pruneEmptyInline 又只处理
 * paragraph、heading、tableCell、六种行内格式与链接的子节点，root 不在其列，三类问题照样出现：空节点遮住相邻节点的转义
 * 语境（d332ef0 修复的一类），如 [strong(), text('# 标题')] 输出「# 标题」、重新解析为标题；数字与记号分属相邻 text
 * （a48ad6a 修复的一类），如 [text('1'), text('. 项')] 输出「1. 项」、重新解析为有序列表；相邻代码段粘连（00b479f 修复的
 * 一类），如 [code(x), code(y)] 输出「`x``y`」、重新解析为单个代码段。定界符式格式紧邻空节点时由兜底规则回退标签，如
 * [strong(甲), text('')] 输出「<strong>甲</strong>」，往返正确，但与去掉空节点后的产物「**甲**」不同。值为空的代码段与
 * 段尾硬换行在 root 之下同样不经处理，本文件不生成（见范围外）。
 * 修法：root 的子节点含上游 phrasing 类型时，render() 在剔除空节点之前把全部子节点包进一个 paragraph。paragraph 处理器
 * 进入 paragraph 与 phrasing 语境、同样以 containerPhrasing 拼接子节点，产物与这组子节点放在段落中逐字相同；
 * pruneEmptyInline 照 paragraph 处理它们。块级子节点仍与行内内容直接拼接、不另起一块，但随之处在 phrasing 语境中，经
 * safe() 写出的部分多出该语境的转义（见范围外）。
 * 覆盖：
 *   - 已列形态：实测确认出错的 13 种形态（空节点遮住行首记号与末尾反斜杠、数字与记号分属相邻 text、相邻代码段、空 html
 *     之前的换行，以及 phrasing 语境缺失的 5 种），逐字比对产物并断言往返。
 *   - 敏感边界矩阵：10 种产物为空的节点 × 60 种敏感边界形态（沿用 test/md-empty-inline-context.test.js 的矩阵），共 600 例。
 *   - 数字边界矩阵：数字 0、1、12、123456789 × 记号「.」「)」× 3–4 种切分方式 × 3 种位置（root 开头、换行结尾的文本之后、
 *     硬换行之后）× 4 种切分点填充（无、空文本、无内容的 strong、空 html），共 336 例。
 *   - 相邻代码段矩阵：9 种代码值的两段全排列 81 组与三段 27 组 × 3 种间隔（直接相邻、夹空文本、夹无内容的 strong），共
 *     324 例。
 *   - 定界符式格式紧邻空节点：3 种定界符式格式 × 5 种核心内容 × 11 种产物为空的兄弟 × 6 种邻居，正向与镜像各 990 例
 *     （沿用 test/md-emphasis-empty-sibling.test.js 的矩阵）。
 *   - 已知行为变化：定界符式格式紧邻空节点时不再由兜底规则回退标签，产物回到去掉空节点后的写法。
 *   - 拼接方式（子节点直接拼接还是以空行分隔）：剔除后仍含 phrasing 类型、剔除后至多剩一个子节点、剔除后剩余两个以上
 *     非 phrasing 节点、root 本就按块级渲染四类共 8 例，产物逐字等于修复前的产物（包装在剔除之前进行，剔除掉仅有的
 *     phrasing 节点也不改变拼接方式）；其中的块级子节点只取段落。
 *   - 兜底规则仍可达：表格单元格中前一字为空白的硬换行产物为空串，其后的加粗仍由前侧兜底规则回退标签；列表项直接挂
 *     [strong(甲), text('')] 时，列表项以 containerFlow 渲染子节点、不在剔除范围内，加粗由后侧兜底规则（isEmptyOutput
 *     判定后一兄弟产物为空）回退标签；产物逐字等于修复前的产物。
 *   - 种子随机往返：固定种子生成 2000 个 root，每个 1–6 个位置，各位置按 20% 取产物为空的节点、35% 取文本（含「*」「~」
 *     「&」「<」、感叹号、首尾空白与以反斜杠结尾的文本）、15% 取非空代码段（1–2 段依次相邻）、20% 取非空格式节点（六种），
 *     余下取链接；容器嵌套深度 ≤ 2，链接不嵌套链接。子节点不含 phrasing 类型的 root（只有 html 与自定义的三种行内格式）
 *     上游按块级渲染、不包装，只计数、不断言。
 * 断言口径：缺陷类用例（已列形态、四组矩阵、种子随机往返）断言两项。其一，往返正确：逐例经 remark-parse + remark-gfm +
 * liftInlineHtml 重新解析后只有一个段落，「文本 + 格式集合」与「代码 + 格式集合」片段序列与原 IR 一致，且不出现原文没有
 * 的「*」「~」；展平时略去空 html 与 render() 在相邻代码段之间插入的分隔注释，相邻且格式集合相同的代码片段拼接为一个，
 * 理由同 test/md-inline-code-adjacent.test.js 的断言口径。其二，产物与同一组子节点放在段落中的产物逐字相同。四组矩阵先
 * 断言对照形态往返正确，以确认形态本身在范围内：敏感边界、数字边界与定界符矩阵的对照形态为参照归并后的同一组子节点放在
 * 段落中（参照归并为本文件独立实现的剔除空节点，数字边界矩阵另合并全部相邻 text，该矩阵的切分点都在数字边界上，两种
 * 合并等价），相邻代码段矩阵的对照形态为各代码值单独直挂在 root 之下。已知行为变化、拼接方式与兜底规则三项逐字比对产物。
 * 范围外（矩阵与随机文本均已避开）：
 *   - 值为空的 inlineCode：已由剔除值为空的代码段一项处理（专测见 test/md-empty-inline-code.test.js），包进段落后同样
 *     剔除，本文件不生成；
 *   - 段尾硬换行：本文件写就时属范围外——上游在段尾写「\ + 换行」，重新解析为字面反斜杠，段落中同样出错——现已由 f77d817
 *     把段落与标题末尾的连续硬换行并为 <br> 串修复，覆盖见 test/md-trailing-break.test.js；包进段落后 root 直挂的段尾硬换行
 *     同样改写，本文件的硬换行仍只出现在段中；
 *   - 可见内容只有空白的格式节点：本文件写就时属范围外——只能写 HTML 标签，liftInlineHtml 把只包着空白的格式标签直接
 *     拆除，格式丢失——现已由 liftInlineHtml 在提升时保留这类标签修复（cea59b1），覆盖见 test/md-whitespace-format.test.js；
 *     本文件各用例的文本仍均含非空白字符；
 *   - 子节点不含 phrasing 类型的 root（如只有 html 与自定义的三种行内格式）：上游以 containerFlow 渲染，逐个子节点成段，
 *     空节点也各占一段（如 [underline(), underline()] 输出两个换行），不在本修复之列；
 *   - 列表项、引用块等块级容器直接挂行内节点：上游以 containerFlow 渲染，逐个子节点成块，不在本修复之列；
 *   - 兼挂块级与行内节点的 root：块级节点紧接在行内内容之后、不另起一块，修复前后都如此；包装后块级节点处在 phrasing
 *     语境中，围栏代码的信息串、定义的标签、地址与标题以及脚注定义的标签经 safe() 写出，多出该语境的转义（如信息串
 *     a*b_c 写作 a\*b\_c、定义的地址 http:// 写作 http\://）。本文件只在拼接方式一项取段落作块级子节点；
 *   - 含「www」「@」「:」的文本、段首段尾的换行、连续两个换行、制表符；
 *   - 同一个 text 节点内「数字 + .」一行紧接下一行行首记号的形态：本文件写就时属范围外——记号不转义，段落中同样出错（见
 *     test/md-list-marker-split.test.js 的范围外）——现已由 render() 补入的前瞻版模式（LINE_MARKER_UNSAFE）修复（e12b1db），
 *     覆盖见 test/md-line-marker-newline.test.js；本文件的随机文本仍不以数字结尾。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');

const mdRenderer = require('../converters/renderers/md');
const { loadUnified } = require('../converters/ir/unified-loader');
const { liftInlineHtml } = require('../converters/ir/inline-html');
const {
    createDocument, createRoot, createParagraph, createTable, createTableRow, createTableCell, createText,
} = require('../converters/ir/schema');

// 片段展平所认的格式类型：定界符式三种与只写 HTML 标签的三种
const FORMAT_TYPES = ['strong', 'emphasis', 'delete', 'underline', 'superscript', 'subscript'];
// 定界符式格式
const ATTENTION_TYPES = ['strong', 'emphasis', 'delete'];
const DELIMITER_CHARS = ['*', '~'];
// 上游 root 处理器认作行内内容的类型：照录 mdast-util-phrasing 4.1.0 的 lib/index.js，供种子随机往返区分块级渲染的 root
const UPSTREAM_PHRASING_TYPES = [
    'break', 'delete', 'emphasis', 'footnote', 'footnoteReference', 'image', 'imageReference', 'inlineCode',
    'inlineMath', 'link', 'linkReference', 'mdxJsxTextElement', 'mdxTextExpression', 'strong', 'text', 'textDirective',
];
// 失败信息最多列出的用例数
const MAX_REPORTED = 10;
// 换行、反斜杠、反引号与辅助平面表情一律以码点生成，源码中不出现转义序列与不可见字面量
const NL = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);
const BACKTICK = String.fromCharCode(96);
const EMOJI = String.fromCodePoint(0x1f600);
// 用例中链接的地址：不含空白与括号；链接文本均与之不同，产物恒为「[文本](地址)」
const LINK_URL = 'https://a.com';
// render() 在相邻代码段之间插入的分隔注释：值以 COMMENT_OPEN 开头、以 COMMENT_CLOSE 结尾的 html 节点在展平时略去
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
// 兜底规则用例的表头单元格
const TABLE_HEAD = '表头';

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
const superscript = format('superscript');
const subscript = format('subscript');
const text = createText;
const html = (value) => ({ type: 'html', value });
/** 链接工厂：地址恒为 LINK_URL */
const link = (...children) => ({ type: 'link', url: LINK_URL, title: null, children: wrapChildren(children) });
const inlineCode = (value) => ({ type: 'inlineCode', value });
const hardBreak = () => ({ type: 'break' });
const paragraph = (...children) => createParagraph(wrapChildren(children));

/** 以 children 为 root 的直属子节点渲染 */
function renderRoot(children) {
    return mdRenderer.render(createDocument({ ir: createRoot(children) }));
}

/** 把同一组子节点放进段落渲染：root 直挂的产物应与之逐字相同 */
function renderInParagraph(children) {
    return mdRenderer.render(createDocument({ ir: createRoot([createParagraph(children)]) }));
}

async function reparse(md) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    return liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(md));
}

/** 节点简式，用于失败信息：文本 → 字符串，html → { html }，行内代码 → { code }，链接另带地址，其余 → { 类型: 子节点简式 } */
function brief(node) {
    if (node.type === 'text') return node.value;
    if (node.type === 'html') return { html: node.value };
    if (node.type === 'inlineCode') return { code: node.value };
    if (node.type === 'link') return { link: node.url, children: (node.children || []).map(brief) };
    if (Array.isArray(node.children)) return { [node.type]: node.children.map(brief) };
    return { [node.type]: node.value === undefined ? null : node.value };
}

/**
 * 单个节点的描述：root 直属文本写作 text("…")，容器内的文本只写 JSON 字符串；空文本写作 text('')、空 html 写作 html('')；
 * 行内代码写作 code("…")；链接只写子节点，如 link("乙")；硬换行写作 break()
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

const describeRoot = (nodes) => `root[${nodes.map((node) => describeNode(node)).join(', ')}]`;

/**
 * 展平时略去的 html 节点：值为空串（产物为空），或值以 COMMENT_OPEN 开头、以 COMMENT_CLOSE 结尾（render() 插入的分隔
 * 注释）；以 startsWith 与 endsWith 判定，不用正则
 */
const isSkippedHtml = (node) => node.type === 'html'
    && (!node.value || (node.value.startsWith(COMMENT_OPEN) && node.value.endsWith(COMMENT_CLOSE)));

/**
 * 行内节点序列展平为片段序列：文本片段为 { text, formats }，代码片段为 { code, formats }，formats 为祖先中各格式类型与
 * 「link=地址」的集合（排序后以「+」连接）。相邻且格式集合相同的文本片段合并，相邻且格式集合相同的代码片段同样拼接为
 * 一个；空文本与 isSkippedHtml 所指的 html 节点略去。其余类型的节点（其余 html、硬换行等）记为 { unexpected } 片段，只与
 * 原 IR 同一位置的同类节点相等
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
 * 参照剔除：本文件独立实现的「去掉空节点」，不调用渲染器的内部函数。去掉 value 为空串的 text 与 html，以及子节点去掉之后
 * 已无子节点的六种格式节点；链接只剔除其子节点、不剔除自身。返回新数组，不修改入参
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

/** 合并同一层中全部相邻的 text 节点（只用于切分点都在数字边界上的数字边界矩阵），返回新数组，不修改入参 */
function mergeAllText(nodes) {
    const out = [];
    for (const node of nodes) {
        const last = out[out.length - 1];
        if (node.type === 'text' && last && last.type === 'text') out[out.length - 1] = { ...last, value: last.value + node.value };
        else out.push(node);
    }
    return out;
}

/** 子节点中是否有上游认作行内内容的类型（按本文件照录的类型列表判定，不调用渲染器的内部函数） */
const hasUpstreamPhrasing = (nodes) => nodes.some((node) => UPSTREAM_PHRASING_TYPES.includes(node.type));

/** 重新解析 md 并与原 IR 比对：往返正确时返回 null，否则返回 { ir, md, reparsed, reasons } */
async function roundTripFailureOf(children, md, describe = describeRoot) {
    const tree = await reparse(md);
    const reasons = [];
    const [block] = tree.children;
    if (tree.children.length !== 1 || block.type !== 'paragraph') {
        reasons.push('重新解析后不是单个段落');
    } else {
        if (!isDeepStrictEqual(flatten(block.children), flatten(children))) reasons.push('片段序列与原 IR 不一致');
        const original = plainText(children);
        const reparsed = plainText(block.children);
        for (const char of DELIMITER_CHARS) {
            if (!original.includes(char) && reparsed.includes(char)) reasons.push(`重新解析文本出现原文没有的「${char}」`);
        }
    }
    return reasons.length ? { ir: describe(children), md, reparsed: tree.children.map(brief), reasons } : null;
}

/** 往返失败的逐项说明：前 limit 项的用例描述、md 产物、失败原因与重新解析结果 */
function reportLines(failures, limit = MAX_REPORTED) {
    return failures.slice(0, limit).map((f, i) => `${i + 1}. ${f.ir} → ${JSON.stringify(f.md)}；`
        + `${f.reasons.join('、')}；重新解析：${JSON.stringify(f.reparsed)}`);
}

/**
 * 逐例检查 root 直挂的往返，先收集失败项再一次断言；失败信息列出总数、失败数与前若干项。比对基准取渲染前的深拷贝，修法
 * 若就地改动入参，不会连同基准一起改掉而掩盖错误
 */
async function assertAllRoundTrip(label, cases) {
    const failures = [];
    for (const { children } of cases) {
        const original = structuredClone(children);
        const failure = await roundTripFailureOf(original, await renderRoot(children));
        if (failure) failures.push(failure);
    }
    const lines = reportLines(failures);
    assert.equal(failures.length, 0, `${label}：${cases.length} 例中 ${failures.length} 例失败，前 ${lines.length} 例：${NL}${lines.join(NL)}`);
}

/**
 * 先断言对照形态往返正确：对照形态本身出错时该形态属范围外，不能用来判定 root 直挂的影响。controls 为 { children, inParagraph }
 * 列表，inParagraph 为真时把子节点放进段落渲染，否则直挂在 root 之下；按内容去重后逐例检查
 */
async function assertControlsRoundTrip(label, controls) {
    const unique = [...new Map(controls.map((item) => [JSON.stringify(item), item])).values()];
    const failures = [];
    for (const { children, inParagraph } of unique) {
        const md = inParagraph ? await renderInParagraph(structuredClone(children)) : await renderRoot(structuredClone(children));
        const failure = await roundTripFailureOf(children, md, (nodes) => (inParagraph ? `paragraph${describeRoot(nodes).slice(4)}` : describeRoot(nodes)));
        if (failure) failures.push(failure);
    }
    const lines = reportLines(failures);
    assert.equal(failures.length, 0, `${label}：对照形态 ${unique.length} 例中 ${failures.length} 例往返失败（形态本身属范围外），`
        + `前 ${lines.length} 例：${NL}${lines.join(NL)}`);
}

/** 逐例比对产物与期望值，先收集不符项再一次断言；失败信息列出前若干项的用例描述、实际产物与期望产物 */
async function assertOutputs(label, cases) {
    const mismatches = [];
    for (const { children, md: expected } of cases) {
        const md = await renderRoot(children);
        if (md !== expected) mismatches.push(`${describeRoot(children)} → ${JSON.stringify(md)}；期望 ${JSON.stringify(expected)}`);
    }
    const lines = mismatches.slice(0, MAX_REPORTED).map((line, i) => `${i + 1}. ${line}`);
    assert.equal(mismatches.length, 0, `${label}：${cases.length} 例中 ${mismatches.length} 例产物与期望不符，前 ${lines.length} 例：`
        + `${NL}${lines.join(NL)}`);
}

// ============================================================
// 带对照的形态：往返与逐字比对
// ============================================================

/** 形态：children 为 root 的直属子节点，control 为对照形态（参照归并后的同一组子节点，放进段落），另记类别 */
const shapeCase = (children, category, normalize = referencePrune) => ({
    children, control: { children: structuredClone(normalize(children)), inParagraph: true }, category,
});

/**
 * 逐例检查形态，返回 { roundTrip, identity }：roundTrip 为 root 直挂往返失败的项，identity 为 root 直挂的产物与同一组子节点
 * 放在段落中的产物不同的项。各失败项另带原用例 item，供分类计数
 */
async function checkShapes(shapes) {
    const roundTrip = [];
    const identity = [];
    for (const item of shapes) {
        const original = structuredClone(item.children);
        const md = await renderRoot(structuredClone(item.children));
        const failure = await roundTripFailureOf(original, md);
        if (failure) roundTrip.push({ ...failure, item });
        const paragraphMd = await renderInParagraph(structuredClone(item.children));
        if (md !== paragraphMd) identity.push({ ir: describeRoot(original), md, paragraphMd, item });
    }
    return { roundTrip, identity };
}

/** 逐字比对失败的逐项说明：前 limit 项的用例描述、root 直挂的产物与放在段落中的产物 */
function identityLines(failures, limit = MAX_REPORTED) {
    return failures.slice(0, limit).map((f, i) => `${i + 1}. ${f.ir} → ${JSON.stringify(f.md)}；`
        + `放在段落中为 ${JSON.stringify(f.paragraphMd)}`);
}

/** 按键抽样：每个键只取首个失败项 */
function firstPerKey(failures, keyOf) {
    const seen = new Set();
    return failures.filter((f) => {
        const key = keyOf(f.item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** 按键统计出错的用例：返回「键 出错数/总数」的列表，只列出错数非零的键；同一用例往返与逐字比对都失败时只计一次 */
function tally(shapes, failedItems, keyOf) {
    const stats = new Map();
    for (const item of shapes) {
        const key = keyOf(item);
        const entry = stats.get(key) || { total: 0, failed: 0 };
        entry.total += 1;
        if (failedItems.has(item)) entry.failed += 1;
        stats.set(key, entry);
    }
    return [...stats].filter(([, entry]) => entry.failed > 0).map(([key, entry]) => `${key} ${entry.failed}/${entry.total}`);
}

/** 一次断言往返与逐字比对的结果：按类别列出出错的用例数，失败信息每个类别列出首例 */
function assertShapes(label, shapes, { roundTrip, identity }) {
    const byCategory = (item) => item.category;
    const failedItems = new Set([...roundTrip, ...identity].map((f) => f.item));
    assert.equal(roundTrip.length + identity.length, 0, [
        `${label}：${shapes.length} 例中往返失败 ${roundTrip.length} 例、与放在段落中的产物不一致 ${identity.length} 例；`
            + `出错用例（往返或逐字比对失败）共 ${failedItems.size} 例`,
        `按类别：${tally(shapes, failedItems, byCategory).join('、')}`,
        '往返失败（每类首例）：', ...reportLines(firstPerKey(roundTrip, byCategory), Infinity),
        '逐字比对失败（每类首例）：', ...identityLines(firstPerKey(identity, byCategory), Infinity),
    ].join(NL));
}

// ============================================================
// 已列形态
// ============================================================

/** root 用例：期望产物以「^」代表反引号书写，末尾补段尾换行 */
const rootCase = (children, md) => ({ children, md: `${tick(md)}${NL}` });

/** 实测确认出错的 13 种形态；各行注释为修复前的产物与重新解析的结果 */
function listedCases() {
    return [
        // 「# 标题」：空 strong 使 before 为空串，「#」不转义，重新解析为一级标题
        rootCase([strong(), text('# 标题')], `${BACKSLASH}# 标题`),
        // 「1. 项」：数字与记号分属相邻 text，两侧都不转义，重新解析为有序列表
        rootCase([text('1'), text('. 项')], `1${BACKSLASH}. 项`),
        // 同上，另夹一个空文本
        rootCase([text('1'), text(''), text('. 项')], `1${BACKSLASH}. 项`),
        // 「甲\」加换行再加「1. 项」：硬换行之后成为有序列表
        rootCase([text('甲'), hardBreak(), text('1'), text('. 项')], `甲${BACKSLASH}${NL}1${BACKSLASH}. 项`),
        // 「`x``y`」：重新解析为单个代码段「x``y」
        rootCase([inlineCode('x'), inlineCode('y')], '^x^<!---->^y^'),
        // 同上，两段之间的空文本不隔开两段
        rootCase([inlineCode('x'), text(''), inlineCode('y')], '^x^<!---->^y^'),
        // 「甲\!」：空文本使 after 为空串，末尾反斜杠不转义，反斜杠转义了感叹号
        rootCase([text(`甲${BACKSLASH}`), text(''), text('!')], `甲${BACKSLASH}${BACKSLASH}!`),
        // 「甲 乙」：紧接 html 节点之前的行尾换行改为空格
        rootCase([text(`甲${NL}`), html(''), text('乙')], `甲${NL}乙`),
        // phrasing 语境缺失：「*甲*」重新解析为强调
        rootCase([text('*甲*')], `${BACKSLASH}*甲${BACKSLASH}*`),
        // 「甲&amp;」：「&」不转义，重新解析为字符引用
        rootCase([text('甲&'), text('amp;')], `甲${BACKSLASH}&amp;`),
        // 「甲<b>乙」：「<」不转义，重新解析为 HTML 标签
        rootCase([text('甲<'), text('b>乙')], `甲${BACKSLASH}<b>乙`),
        // 「 甲」：行首空格不转义，被解析器去掉
        rootCase([text(' 甲')], '&#x20;甲'),
        // 「甲![甲站](https://a.com)」：感叹号不转义，重新解析为图片
        rootCase([text('甲!'), link('甲站')], `甲${BACKSLASH}![甲站](${LINK_URL})`),
    ];
}

// ============================================================
// 敏感边界矩阵（沿用 test/md-empty-inline-context.test.js 的 60 种形态）
// ============================================================

// 产物为空的节点 E：以工厂给出，每例新建节点
const EMPTY_NODES = [
    () => text(''),
    () => html(''),
    () => strong(),
    () => emphasis(),
    () => del(),
    () => strong(text('')),
    () => underline(),
    () => superscript(),
    () => subscript(),
    () => del(strong(text(''))),
];
// root 开头的行首记号：去掉 E 后均转义
const START_MARKERS = ['# 标题', '#', '1. 项', '1.', '1) 项', '- 项', '-', '+ 项', '> 引', '---'];
// 换行后的行首记号：单独的「1.」是空列表项，不能打断段落；「=」只在段中才构成 setext 标题下划线
const LINE_BREAK_MARKERS = ['# 标题', '#', '1. 项', '1) 项', '- 项', '-', '+ 项', '> 引', '---', '='];
// 行首空白：一个、两个与四个空格
const LEADING_SPACES = [' 甲', '  甲', '    缩进'];

/** 矩阵形态：E 之前与之后的节点以工厂给出，每例新建节点 */
const boundary = (category, before, after) => ({ category, before, after });

const BOUNDARY_SHAPES = [
    ...START_MARKERS.map((x) => boundary('root 开头的行首记号', () => [], () => [text(x)])),
    ...LEADING_SPACES.map((x) => boundary('root 开头的行首空白', () => [], () => [text(x)])),
    ...[...LINE_BREAK_MARKERS, ...LEADING_SPACES].map((x) => boundary('换行后', () => [text(`甲${NL}`)], () => [text(x)])),
    boundary('行首记号与其后的必需字符被隔开', () => [text('-')], () => [text(' 项')]),
    boundary('行首记号与其后的必需字符被隔开', () => [text('+')], () => [text(' 项')]),
    boundary('行首记号与其后的必需字符被隔开', () => [text('1.')], () => [text(' 项')]),
    boundary('行首记号与其后的必需字符被隔开', () => [text('-')], () => [text('--')]),
    boundary('行首记号与其后的必需字符被隔开', () => [text(`甲${NL}-`)], () => [text(' 项')]),
    boundary('末尾行尾空白', () => [text('甲 ')], () => []),
    boundary('末尾行尾空白', () => [text('甲  ')], () => []),
    ...[
        () => text('!'), () => text('(注)'), () => link('乙'), () => inlineCode('x'), () => underline('乙'),
        () => strong('乙'), () => emphasis('乙'), () => del('乙'),
    ].map((next) => boundary('反斜杠加 ASCII 标点', () => [text(`甲${BACKSLASH}`)], () => [next()])),
    boundary('反斜杠加换行', () => [text(`甲${BACKSLASH}`)], () => [text(`${NL}乙`)]),
    boundary('空格加换行', () => [text('甲  ')], () => [text(`${NL}乙`)]),
    boundary('空格加换行', () => [text('甲 ')], () => [text(`${NL}乙`)]),
    boundary('感叹号加链接', () => [text('甲!')], () => [link('甲站')]),
    boundary('感叹号加链接', () => [text('!')], () => [link('乙')]),
    boundary('感叹号加链接', () => [text('甲!')], () => [link(strong('乙'))]),
    boundary('& 加实体形态', () => [text('甲&')], () => [text('amp;')]),
    boundary('& 加实体形态', () => [text('甲&')], () => [text('#x41;')]),
    boundary('& 加实体形态', () => [text('&')], () => [text('lt;乙')]),
    ...['b>乙', '/b>乙', 'u>乙', '!-- 注 -->', '?x?>乙'].map((x) => boundary('< 加标签形态', () => [text('甲<')], () => [text(x)])),
    ...[() => text('乙'), () => link('乙'), () => underline('乙'), () => inlineCode('x'), () => strong('乙')]
        .map((next) => boundary('换行结尾的文本之后', () => [text(`甲${NL}`)], () => [next()])),
];

function buildBoundaryMatrix() {
    return BOUNDARY_SHAPES.flatMap((item) => EMPTY_NODES.map((makeEmpty) => shapeCase(
        [...item.before(), makeEmpty(), ...item.after()], item.category,
    )));
}

// ============================================================
// 数字边界矩阵
// ============================================================

const DIGITS = ['0', '1', '12', '123456789'];
const MARKERS = ['.', ')'];
// 位置：root 开头、换行结尾的文本之后、硬换行之后
const DIGIT_PLACES = [
    ['root 开头', () => []],
    ['换行结尾的文本之后', () => [text(`甲${NL}`)]],
    ['硬换行之后', () => [text('甲'), hardBreak()]],
];
// 切分点的填充：无、空文本、无内容的 strong、空 html
const FILLERS = [null, () => text(''), () => strong(), () => html('')];

/** 切分方式：返回各段文本；数字前半 | 数字后半加记号只适用于多位数 */
function splitsOf(digits, marker) {
    const splits = [
        ['数字 | 记号加后文', [digits, `${marker} 项`]],
        ['数字 | 记号 | 空格加后文', [digits, marker, ' 项']],
        ['数字 | 记号（位于末尾）', [digits, marker]],
    ];
    if (digits.length > 1) {
        const half = Math.ceil(digits.length / 2);
        splits.push(['数字前半 | 数字后半加记号加后文', [digits.slice(0, half), `${digits.slice(half)}${marker} 项`]]);
    }
    return splits;
}

/** 各段文本依次建为相邻的 text 节点，切分点插入 filler 新建的节点（filler 为 null 时直接相邻） */
const piecesOf = (pieces, filler) => pieces.flatMap((piece, i) => (i === 0 || !filler ? [text(piece)] : [filler(), text(piece)]));

function buildDigitMatrix() {
    const cases = [];
    for (const [place, prefix] of DIGIT_PLACES) {
        for (const digits of DIGITS) {
            for (const marker of MARKERS) {
                for (const [split, pieces] of splitsOf(digits, marker)) {
                    for (const filler of FILLERS) {
                        const children = [...prefix(), ...piecesOf(pieces, filler)];
                        cases.push(shapeCase(children, `${place}：${split}`, (nodes) => mergeAllText(referencePrune(nodes))));
                    }
                }
            }
        }
    }
    return cases;
}

// ============================================================
// 相邻代码段矩阵
// ============================================================

// 代码值：普通字母、值内含单个反引号（居中、开头、结尾）、值为两个反引号、首尾各一个空格、单个空格、内部连续空格、汉字
const CODE_VALUES = ['x', tick('a^b'), tick('^a'), tick('a^'), tick('^^'), ' x ', ' ', 'a  b', '中文'];
// 三段取值的步长：第 i 组为 CODE_VALUES 的第 i、i+s、i+2s 项（下标模 9），步长 0 为同值三段
const TRIPLE_STEPS = [0, 1, 4];
// 相邻两段之间的间隔：直接相邻、夹空文本、夹无内容的 strong
const GAPS = [['直接相邻', null], ["夹 text('')", () => text('')], ['夹 strong()', () => strong()]];

function buildCodeMatrix() {
    const size = CODE_VALUES.length;
    const pairs = CODE_VALUES.flatMap((a) => CODE_VALUES.map((b) => [a, b]));
    const triples = TRIPLE_STEPS.flatMap((step) => CODE_VALUES.map((_, i) => [0, 1, 2].map((k) => CODE_VALUES[(i + k * step) % size])));
    return GAPS.flatMap(([name, gap]) => [...pairs, ...triples].map((values) => shapeCase(
        values.flatMap((value, i) => (i === 0 || !gap ? [inlineCode(value)] : [gap(), inlineCode(value)])),
        `${values.length} 段，${name}`,
    )));
}

// ============================================================
// 定界符式格式紧邻空节点（沿用 test/md-emphasis-empty-sibling.test.js 的矩阵）
// ============================================================

// 核心内容：书名号首末、汉字开头句号结尾、纯汉字、ASCII 括号首末、ASCII 字母开头句点结尾
const MATRIX_CORES = ['《甲》', '甲。', '甲', '(A)', 'A.'];
// 产物为空的兄弟节点 E
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
// E 之后的邻居（正向形态）：null 为末尾；字符串为 root 直属文本
const NEIGHBORS_AFTER = [null, '乙', '。', 'a', ' 乙', SAME_TYPE];
// E 之前的邻居（镜像形态）：null 为开头；空格仍放在朝向 E 的一侧
const NEIGHBORS_BEFORE = [null, '乙', '。', 'a', '乙 ', SAME_TYPE];

function neighborNodes(neighbor, type) {
    if (neighbor === null) return [];
    if (neighbor === SAME_TYPE) return [format(type)('乙')];
    return [text(neighbor)];
}

/** 正向 [A(核心), E, 邻居?] 与镜像 [邻居?, E, A(核心)] 两组 */
function buildAttentionMatrix() {
    const cases = [];
    for (const type of ATTENTION_TYPES) {
        for (const core of MATRIX_CORES) {
            for (const makeEmpty of EMPTY_SIBLINGS) {
                for (const neighbor of NEIGHBORS_AFTER) {
                    cases.push(shapeCase([format(type)(core), makeEmpty(), ...neighborNodes(neighbor, type)], '正向'));
                }
                for (const neighbor of NEIGHBORS_BEFORE) {
                    cases.push(shapeCase([...neighborNodes(neighbor, type), makeEmpty(), format(type)(core)], '镜像'));
                }
            }
        }
    }
    return cases;
}

// ============================================================
// 拼接方式与兜底规则
// ============================================================

// 拼接方式（子节点直接拼接还是以空行分隔）：期望值取自修复前的实际产物
const MODE_CASES = [
    // 剔除后仍含 phrasing 类型
    { children: [paragraph('甲'), text('乙'), text('')], md: `甲乙${NL}` },
    // 剔除后至多剩一个子节点
    { children: [paragraph('甲'), text('')], md: `甲${NL}` },
    { children: [underline('甲'), text('')], md: `<u>甲</u>${NL}` },
    { children: [text(''), strong()], md: '' },
    // 剔除后剩余两个以上非 phrasing 节点：包装在剔除之前进行，仍按行内语境直接拼接
    { children: [paragraph('甲'), text(''), paragraph('乙')], md: `甲乙${NL}` },
    { children: [underline('甲'), text(''), underline('乙')], md: `<u>甲</u><u>乙</u>${NL}` },
    // root 本就按块级渲染（子节点不含 phrasing 类型）：不包装
    { children: [paragraph('甲'), html(''), paragraph('乙')], md: `甲${NL}${NL}${NL}${NL}乙${NL}` },
    { children: [underline('甲'), superscript('乙')], md: `<u>甲</u>${NL}${NL}<sup>乙</sup>${NL}` },
];

/** 两行一列的表格，表体单元格的子节点为 cell */
const tableOf = (cell) => createTable(null, [
    createTableRow([createTableCell([text(TABLE_HEAD)])]),
    createTableRow([createTableCell(cell)]),
]);

/** 只有一个列表项的无序列表，列表项直接挂 items（不经段落） */
const listOf = (...items) => ({
    type: 'list',
    ordered: false,
    spread: false,
    children: [{ type: 'listItem', spread: false, children: wrapChildren(items) }],
});

// 兜底规则仍可达：
//   - 表格单元格中的硬换行写作空格，前一字为空白时写作空串，其后格式节点的 before 为空串，由前侧兜底规则回退标签；前一字
//     不是空白时硬换行写作空格，加粗照常写定界符；
//   - 列表项以 containerFlow 渲染子节点，不在剔除范围内，子节点的 before / after 恒为换行；加粗之后的空文本不被剔除，由
//     后侧兜底规则（isEmptyOutput 判定后一兄弟产物为空）回退标签。
// 期望值取自修复前的实际产物
const FALLBACK_CASES = [
    {
        children: [tableOf([text('甲 '), hardBreak(), strong('乙')])],
        md: `| ${TABLE_HEAD}                   |${NL}| -------------------- |${NL}| 甲 <strong>乙</strong> |${NL}`,
    },
    {
        children: [tableOf([text('甲'), hardBreak(), strong('乙')])],
        md: `| ${TABLE_HEAD}      |${NL}| ------- |${NL}| 甲 **乙** |${NL}`,
    },
    { children: [listOf(strong('甲'), text(''))], md: `- <strong>甲</strong>${NL}` },
];

// ============================================================
// 种子随机 root
// ============================================================

// 文本池：行首记号、首尾空白、以反斜杠结尾的文本与可被其转义的 ASCII 标点、感叹号、「&」「<」与实体、标签形态、普通文本、
// 字面「*」「~」；不含「w」「@」「:」，不以数字结尾，不以「.」「)」开头
const RANDOM_TEXTS = [
    '# 标题', '#', '1. 项', '1) 项', '- 项', '-', '+ 项', '> 引', '---', '=',
    ' 甲', '    缩进', '甲 ', '甲  ',
    `甲${BACKSLASH}`, BACKSLASH, '!', '(注)',
    '甲!', '甲&', '&', 'amp;', '#x41;', 'lt;乙', '甲<', '<', 'b>乙', '/b>乙',
    '甲', '乙丙', '。', '，', '《乙》', '「甲', 'ab', 'a b', EMOJI, '（注）', '*', '~',
];
// 含换行的文本：只作 root 直属文本，每个 root 至多一个
const NEWLINE_TEXTS = [`甲${NL}`, `${NL}乙`];
const RANDOM_SEED = 20260929;
const RANDOM_COUNT = 2000;
// 各位置的取值概率：产物为空的节点、文本、非空代码段串、非空格式节点，余下为链接
const EMPTY_RATE = 0.2;
const TEXT_RATE = 0.35;
const CODE_RATE = 0.15;
const FORMAT_RATE = 0.2;
// 抽中文本时改取含换行文本的概率（仅 root 直属、每个 root 至多一次）
const NEWLINE_RATE = 0.15;
// 容器（格式节点与链接）的嵌套深度上限
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

/** 产物为空的节点：四分之一为空文本，五分之一为空 html，其余为六种格式之一的无内容格式节点或只含空文本的格式节点 */
function randomEmpty(rand) {
    const roll = rand();
    if (roll < 0.25) return text('');
    if (roll < 0.45) return html('');
    return rand() < 0.5 ? format(pick(rand, FORMAT_TYPES))() : format(pick(rand, FORMAT_TYPES))(text(''));
}

/**
 * 一个位置上的行内节点（代码段串可含两个节点）：按上列概率依次取产物为空的节点、文本、1–2 个依次相邻的非空代码段与含
 * 1–3 个位置的格式节点，余下为链接。深度达到上限时格式节点与链接改取文本；链接之内不再嵌套链接，改取格式节点。链接的
 * 首个子节点为非空文本（与地址不同），另以 50% 的概率再接一个位置
 */
function randomPosition(rand, depth, ctx) {
    const roll = rand();
    if (roll < EMPTY_RATE) return [randomEmpty(rand)];
    if (roll < EMPTY_RATE + TEXT_RATE || (depth >= MAX_DEPTH && roll >= EMPTY_RATE + TEXT_RATE + CODE_RATE)) {
        if (depth === 0 && !ctx.newlineUsed && rand() < NEWLINE_RATE) {
            ctx.newlineUsed = true;
            return [text(pick(rand, NEWLINE_TEXTS))];
        }
        return [text(pick(rand, RANDOM_TEXTS))];
    }
    if (roll < EMPTY_RATE + TEXT_RATE + CODE_RATE) {
        const codes = [inlineCode(pick(rand, CODE_VALUES))];
        if (rand() < 0.4) codes.push(inlineCode(pick(rand, CODE_VALUES)));
        return codes;
    }
    if (roll < EMPTY_RATE + TEXT_RATE + CODE_RATE + FORMAT_RATE || ctx.inLink) {
        const count = 1 + Math.floor(rand() * 3);
        const children = [];
        for (let i = 0; i < count; i += 1) children.push(...randomPosition(rand, depth + 1, ctx));
        return [format(pick(rand, FORMAT_TYPES))(...children)];
    }
    const children = [text(pick(rand, RANDOM_TEXTS))];
    if (rand() < 0.5) children.push(...randomPosition(rand, depth + 1, { ...ctx, inLink: true }));
    return [link(...children)];
}

/**
 * count 个 root，每个 1–6 个位置；可见文本以换行开头或结尾时在开头补「前」、末尾补「后」，避开解析器丢弃的段首段尾换行
 */
function randomRoots(seed, count) {
    const rand = mulberry32(seed);
    const roots = [];
    for (let k = 0; k < count; k += 1) {
        const size = 1 + Math.floor(rand() * 6);
        const ctx = { newlineUsed: false, inLink: false };
        const children = [];
        for (let i = 0; i < size; i += 1) children.push(...randomPosition(rand, 0, ctx));
        const visible = plainText(children);
        if (visible.startsWith(NL)) children.unshift(text('前'));
        if (visible.endsWith(NL)) children.push(text('后'));
        roots.push(children);
    }
    return roots;
}

// ============================================================
// 用例：已列形态
// ============================================================

test('已列形态：root 直挂行内节点的 13 种出错形态（空节点遮住行首记号与末尾反斜杠、数字与记号分属相邻 text、相邻代码段、空 html 之前的换行，以及 phrasing 语境缺失使「*」「&」「<」、行首空格与感叹号不转义），产物逐字符合修复后的写法、往返正确', async () => {
    // Arrange
    const cases = listedCases();
    assert.equal(cases.length, 13);

    // Act & Assert
    await assertOutputs('已列形态', cases);
    await assertAllRoundTrip('已列形态', cases);
});

// ============================================================
// 用例：四组矩阵
// ============================================================

test('敏感边界矩阵：10 种产物为空的节点 × 60 种敏感边界形态，root 直挂，对照形态往返正确；各例往返正确，产物与同一组子节点放在段落中的产物逐字相同', async () => {
    // Arrange
    const shapes = buildBoundaryMatrix();
    assert.equal(BOUNDARY_SHAPES.length, 60);
    assert.equal(shapes.length, BOUNDARY_SHAPES.length * EMPTY_NODES.length);
    await assertControlsRoundTrip('敏感边界矩阵', shapes.map((item) => item.control));

    // Act
    const result = await checkShapes(shapes);

    // Assert
    assertShapes('敏感边界矩阵', shapes, result);
});

test('数字边界矩阵：4 种数字 × 2 种记号 × 3–4 种切分 × 3 种位置 × 4 种切分点填充，root 直挂，对照形态往返正确；各例往返正确，产物与同一组子节点放在段落中的产物逐字相同', async () => {
    // Arrange
    const shapes = buildDigitMatrix();
    assert.equal(shapes.length, 336);
    await assertControlsRoundTrip('数字边界矩阵', shapes.map((item) => item.control));

    // Act
    const result = await checkShapes(shapes);

    // Assert
    assertShapes('数字边界矩阵', shapes, result);
});

test('相邻代码段矩阵：9 种代码值的两段全排列 81 组与三段 27 组 × 3 种间隔，root 直挂，对照形态往返正确；各例重新解析后代码段的内容与文本不变，产物与同一组子节点放在段落中的产物逐字相同', async () => {
    // Arrange
    const shapes = buildCodeMatrix();
    assert.equal(shapes.length, 108 * GAPS.length);
    // 对照形态：各代码值单独直挂在 root 之下（相邻两段的参照剔除结果仍相邻，不能作对照）
    await assertControlsRoundTrip('相邻代码段矩阵', CODE_VALUES.map((value) => ({ children: [inlineCode(value)], inParagraph: false })));

    // Act
    const result = await checkShapes(shapes);

    // Assert
    assertShapes('相邻代码段矩阵', shapes, result);
});

test('定界符式格式紧邻空节点：3 种定界符式格式 × 5 种核心 × 11 种产物为空的兄弟 × 6 种邻居的正向与镜像形态，root 直挂，对照形态往返正确；各例往返正确，产物与同一组子节点放在段落中的产物逐字相同', async () => {
    // Arrange
    const shapes = buildAttentionMatrix();
    assert.equal(shapes.length, 2 * ATTENTION_TYPES.length * MATRIX_CORES.length * EMPTY_SIBLINGS.length * NEIGHBORS_AFTER.length);
    await assertControlsRoundTrip('定界符式格式紧邻空节点', shapes.map((item) => item.control));

    // Act
    const result = await checkShapes(shapes);

    // Assert
    assertShapes('定界符式格式紧邻空节点', shapes, result);
});

// ============================================================
// 用例：已知行为变化、拼接方式与兜底规则
// ============================================================

test('已知行为变化：root 直挂的定界符式格式紧邻空节点时曾由兜底规则回退标签，现空节点先行剔除、按真实邻居判定，产物回到去掉空节点后的写法，重新解析后格式与文本均不变', async () => {
    // Arrange：修复前依次为「<strong>甲</strong>」两例、「<strong>加粗</strong>」与「<strong>A</strong><em>B</em>」：
    // 第 1、2 例由后侧、第 3 例由前侧的兜底规则回退标签，第 4 例的加粗由后侧、强调由前侧回退；现各例产物与同一组子节点
    // 放在段落中相同，第 4 例的两个格式节点直接相邻，只有前一方因同字符粘连回退标签
    const cases = [
        rootCase([strong('甲'), text('')], '**甲**'),
        rootCase([strong('甲'), del()], '**甲**'),
        rootCase([text(''), strong('加粗')], '**加粗**'),
        rootCase([strong('A'), text(''), emphasis('B')], '<strong>A</strong>*B*'),
    ];

    // Act & Assert
    await assertOutputs('已知行为变化', cases);
    await assertAllRoundTrip('已知行为变化', cases);
});

test('拼接方式：剔除后仍含 phrasing 类型、剔除后至多剩一个子节点、剔除后剩余两个以上非 phrasing 节点、root 本就按块级渲染四类共 8 例，子节点直接拼接还是以空行分隔与修复前相同，产物逐字等于修复前的产物', async () => {
    // Arrange：期望值取自修复前的实际产物；第 5、6 例若在剔除之后才判定是否包装，root 会改按块级渲染，两个节点由直接
    // 拼接改为以空行分隔
    assert.equal(MODE_CASES.length, 8);

    // Act & Assert
    await assertOutputs('拼接方式', MODE_CASES);
});

test('兜底规则仍可达：表格单元格中前一字为空白的硬换行产物为空串，其后的加粗由前侧兜底规则回退标签，前一字不是空白时照常写定界符；列表项直接挂的加粗后接空文本时由后侧兜底规则回退标签；产物逐字等于修复前的产物', async () => {
    // Arrange
    assert.equal(FALLBACK_CASES.length, 3);

    // Act & Assert：硬换行在表格单元格中写作空格或空串，重新解析后不再是硬换行；列表项中加粗的内容与两侧的换行都满足写
    // 定界符的条件，产物仍为标签即说明经后侧兜底规则回退。三例都只比对产物
    await assertOutputs('兜底规则仍可达', FALLBACK_CASES);
});

// ============================================================
// 用例：种子随机往返
// ============================================================

test(`种子随机往返：种子 ${RANDOM_SEED} 生成 ${RANDOM_COUNT} 个 root（每个 1–6 个位置，取自产物为空的节点、含「*」「~」「&」「<」与首尾空白的文本、非空代码段、非空格式节点与链接，容器嵌套深度 ≤ ${MAX_DEPTH}），子节点含 phrasing 类型的 root 产物与同一组子节点放在段落中的产物逐字相同，只由空节点构成的产物为空串，其余往返正确`, async () => {
    // Arrange：各类 root 的数目随生成器固定；子节点不含 phrasing 类型的 root 上游按块级渲染、不包装，属范围外，只计数
    const cases = randomRoots(RANDOM_SEED, RANDOM_COUNT);
    const block = cases.filter((children) => !hasUpstreamPhrasing(children));
    const blank = cases.filter((children) => hasUpstreamPhrasing(children) && children.every(isEmptyOutput));
    assert.equal(cases.length, RANDOM_COUNT);
    assert.equal(block.length, 63);
    assert.equal(blank.length, 66);

    // Act
    const identity = [];
    const nonBlank = [];
    const roundTrip = [];
    for (const children of cases) {
        if (!hasUpstreamPhrasing(children)) continue;
        const original = structuredClone(children);
        const md = await renderRoot(structuredClone(children));
        const paragraphMd = await renderInParagraph(structuredClone(children));
        if (md !== paragraphMd) identity.push({ ir: describeRoot(original), md, paragraphMd });
        if (original.every(isEmptyOutput)) {
            if (md !== '') nonBlank.push(`${describeRoot(original)} → ${JSON.stringify(md)}`);
            continue;
        }
        const failure = await roundTripFailureOf(original, md);
        if (failure) roundTrip.push(failure);
    }

    // Assert：三项一并断言，失败信息分别计数
    const idLines = identityLines(identity);
    const blankLines = nonBlank.slice(0, MAX_REPORTED).map((line, i) => `${i + 1}. ${line}`);
    const rtLines = reportLines(roundTrip);
    const inScope = cases.length - block.length;
    assert.equal(identity.length + nonBlank.length + roundTrip.length, 0, [
        `种子随机往返：${cases.length} 个 root 中按块级渲染（范围外）${block.length} 个；其余 ${inScope} 个中与放在段落中的产物`
            + `不一致 ${identity.length} 个；只由空节点构成的 ${blank.length} 个里产物非空 ${nonBlank.length} 个；其余 `
            + `${inScope - blank.length} 个中往返失败 ${roundTrip.length} 个`,
        `逐字比对失败（前 ${idLines.length} 个）：`, ...idLines,
        `产物非空（前 ${blankLines.length} 个）：`, ...blankLines,
        `往返失败（前 ${rtLines.length} 个）：`, ...rtLines,
    ].join(NL));
});
