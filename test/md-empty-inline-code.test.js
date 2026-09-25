/**
 * converters/renderers/md.js：值为空的行内代码段（inlineCode）输出「``」，重新解析为字面文本
 * 成因：mdast-util-to-markdown 2.1.2 的 inlineCode 处理器（lib/handle/inline-code.js）以 node.value || '' 取值、以单个
 * 反引号起选围栏，值为空时产物为两个反引号「``」。CommonMark 没有空代码段的写法，找不到等长闭围栏的反引号串按字面文本
 * 处理，「``」因而重新解析为文本，原文没有的两个反引号成为可见内容。render() 在 stringify 之前只剔除空文本、空 html 与
 * 内容为空的格式节点（d332ef0），空代码段不在其列，还夹在两侧节点之间：两侧的代码段各自与它之间插入分隔注释（00b479f），
 * 两侧的数字与记号不能在数字边界合并（a48ad6a）。修复前（a48ad6a）的实测产物：[code('')] 为「``」；
 * [text(甲), code(''), text(乙)] 为「甲``乙」，重新解析为文本「甲``乙」；[code(x), code(''), code(y)] 为
 * 「`x`<!---->``<!---->`y`」，中间一段重新解析为文本「``」；[strong(code(''))] 为「**``**」；值缺失、为 null 或 0 时同样
 * 写出「``」。跟在块末硬换行之后时，空代码段还使硬换行不在块末、不按块末规则改写（f77d817），修复前后的产物见
 * 「覆盖」一节。
 * 修法：render() 把值为空的 inlineCode 与空文本、空 html 一样从 paragraph、heading、tableCell、六种行内格式与链接的子节点
 * 中剔除；剔除后相邻的两个代码段照常以空 HTML 注释分隔，数字与记号照常在数字边界合并，只含空代码段的格式节点剔除后已无
 * 子节点，一并剔除。块末硬换行之后只剩空代码段时，剔除后硬换行成为块末硬换行，照常改写为 <br>（f77d817 的规则）。
 * 值以真假判定，与上游处理器的 node.value || '' 一致：缺失、null、0 一并剔除，非字符串的真值（如数字
 * 5）照常写出。上游对这些假值都只写出「``」，剔除不丢失 md 产物原有的可见内容。其他渲染器中空代码段也无可见内容，
 * 只限于值为空串：html 输出 <code></code>，docx 输出等宽字体的空 run，xml 的 generic profile 输出 <code/>，
 * content-list 不为其产生文本；值缺失、为 null 或为 0 时 html 渲染器抛错，值为 0 时 xml 与 content-list 写出「0」。
 * 覆盖：
 *   - 已列形态：实测确认的 13 种形态逐字比对产物并断言往返；另有 3 种只由空代码段（或只含空代码段的格式节点）构成的
 *     段落，产物为空串。
 *   - 块末硬换行之后只有空代码段：3 种空代码段 × 3 种容器（段落、2 级标题、3 级标题）的 [text(甲), break, 空代码段]，
 *     另加段落 [text(甲), break, break, code('')]，共 10 例，逐字比对产物，并以自带断言核对往返（见断言口径）。修复前
 *     （f77d817）空代码段使硬换行不在块末，块末硬换行的改写（rewriteTrailingBreaks）不触发：段落输出「甲\」加换行再加
 *     「``」，重新解析为文本「甲」、硬换行与文本「``」，两个硬换行时同样多出文本「``」；2 级标题走 setext 形式，重新解析
 *     为 2 级标题，文本「甲」、硬换行与文本「``」；3 级标题输出「### 甲 ``」，重新解析为 3 级标题「甲 ``」，硬换行丢失。
 *     修复后空代码段先被剔除，硬换行成为块末硬换行，依次输出「甲<br>」「## 甲<br>」「### 甲<br>」与「甲<br><br>」。
 *   - 敏感边界矩阵：3 种空代码段（值为空串、值缺失、值为 null）× 60 种敏感边界形态（沿用
 *     test/md-empty-inline-context.test.js 的矩阵：段首与段中换行后的行首记号与行首空白、行首记号与其后必需的字符被
 *     隔开、段尾行尾空白、反斜杠加 ASCII 标点或换行、空格加换行、感叹号加链接、「&」加实体形态、「<」加标签形态、空
 *     html 之前以换行结尾的文本），共 180 例。
 *   - 代码段、数字边界与定界符矩阵：3 种空代码段 × 12 种形态（空代码段夹在两个代码段之间、连续两个空代码段、夹在数字与
 *     记号之间、夹在两个同字符定界符式格式之间或其一侧），共 36 例。
 *   - 语境矩阵：3 种空代码段 × 4 种位置（夹在两段文本之间、夹在两个代码段之间、位于容器开头、位于容器末尾）× 10 种语境
 *     （段落直属、六种格式节点与 link 内部、heading 与 tableCell 内），共 120 例。
 *   - 回归护栏：不含空代码段的 10 种形态（值为空格、反引号、字符串「0」与数字 5 的代码段，文本中的反引号，两段之间夹
 *     空文本的代码段，heading 与 tableCell 内的代码段），产物逐字等于 a48ad6a 的产物，且往返正确。
 *   - 种子随机往返：固定种子生成 2000 个段落，每段 1–6 个位置，各位置按 20% 取空代码段、10% 取其他产物为空的节点、
 *     20% 取 1–2 个依次相邻的非空代码段（两段之间以 30% 的概率夹一个空代码段）、25% 取文本、15% 取非空格式节点（六种），
 *     余下取链接；容器嵌套深度 ≤ 2，链接不嵌套链接。每段产物须与本文件独立实现的参照剔除（referencePrune）后的 IR 产物
 *     逐字相同；只由空节点构成的段落产物为空串，其余逐例往返正确。
 * 断言口径：缺陷类用例（已列形态、三组矩阵、种子随机往返）断言两项。其一，往返正确：逐例经 remark-parse + remark-gfm
 * + liftInlineHtml 重新解析后块的类型与形状不变（段落、2 级标题或两行一列的表格），「文本 + 格式集合」与「代码 + 格式
 * 集合」片段序列与原 IR 一致，且不出现原文没有的「*」「~」「`」。展平时值为空的代码段与空文本一样不产生片段（CommonMark
 * 无从表示空代码段，值为空串时其他渲染器中它也没有可见内容）；略去值以「<!--」开头、以「-->」结尾的 html 节点（render()
 * 在相邻代码段之间插入的分隔注释），并把相邻且格式集合相同的代码片段拼接为一个，理由同
 * test/md-inline-code-adjacent.test.js 的断言口径；链接视作带 url 的格式。其二，产物与参照剔除后的同一 IR 逐字相同。
 * 三组矩阵先断言对照形态（参照剔除后的 IR）往返正确，以确认形态本身在范围内。已列形态与回归护栏逐字比对产物。
 * 块末硬换行一组自带断言：上述往返判定只认段落、2 级标题与两行一列的表格三种块形状，展平也只把硬换行记作 unexpected
 * 片段，本组另含 3 级标题并须核对硬换行的个数与位置。本组逐字比对产物；逐例经同一解析链重新解析后须为单个同类型的块，
 * 标题级数不变；块的子节点依次为 text「甲」与硬换行，硬换行个数与原 IR 一致；重新解析后的文本与代码值不出现原文没有的
 * 「\」「`」。
 * 范围外（矩阵与随机段落均已避开）：
 *   - 本文件只渲染段落、2 级标题与两行一列表格中的行内节点，不涉及 root 直接挂行内节点；
 *   - 含换行的代码值：上游 inlineCode 处理器把其后紧接行首记号的换行改为空格，属原有行为；
 *   - 含「www」「@」「:」的文本（remark-gfm 在解析后的文本上识别自动链接）、段首段尾的换行、连续两个换行、制表符；
 *   - 可见内容只有空白的格式节点：本文件写就时属范围外——只能写 HTML 标签，liftInlineHtml 把只包着空白的格式标签
 *     直接拆除，格式丢失——现已由 liftInlineHtml 在提升时保留这类标签修复，覆盖见 test/md-whitespace-format.test.js；
 *     本文件各用例的文本仍均含非空白字符；
 *   - 同一个 text 节点内只有「数字 + .」「-」或「+」的一行紧接换行、下一行行首又是同一种记号加空白：本文件写就时属
 *     范围外——记号不转义，属 a48ad6a 记录的原有问题——现已由 render() 补入的前瞻版模式（LINE_MARKER_UNSAFE）修复，
 *     覆盖见 test/md-line-marker-newline.test.js；本文件的随机文本仍不以数字结尾。
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
// 重新解析后不应凭空出现的字符：定界符与反引号
const SUSPECT_CHARS = ['*', '~', '`'];
// 失败信息最多列出的用例数
const MAX_REPORTED = 10;
// 换行、反斜杠、反引号与辅助平面表情一律以码点生成，源码中不出现转义序列与不可见字面量
const NL = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);
const BACKTICK = String.fromCharCode(96);
const EMOJI = String.fromCodePoint(0x1f600);
// 用例中链接的默认地址：不含空白与括号，文本与地址不同时产物恒为「[文本](地址)」
const LINK_URL = 'https://a.com';
// render() 在相邻代码段之间插入的分隔注释：值以 COMMENT_OPEN 开头、以 COMMENT_CLOSE 结尾的 html 节点在展平时略去
const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
// heading 语境的标题级别；tableCell 语境为两行一列的表格，表头单元格为 TABLE_HEAD，行内节点放在表体单元格
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
const superscript = format('superscript');
const subscript = format('subscript');
const text = createText;
const html = (value) => ({ type: 'html', value });
/** 链接工厂：linkTo(地址)(子项…)；link 指向默认地址 LINK_URL */
const linkTo = (url) => (...children) => ({ type: 'link', url, title: null, children: wrapChildren(children) });
const link = linkTo(LINK_URL);
const inlineCode = (value) => ({ type: 'inlineCode', value });
/** 值缺失的代码段：不带 value 属性 */
const missingCode = () => ({ type: 'inlineCode' });

// 值为空的代码段 E：值为空串、值缺失、值为 null，以工厂给出，每例新建节点
const EMPTY_CODES = [
    () => inlineCode(''),
    missingCode,
    () => inlineCode(null),
];

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
 * 节点简式，用于失败信息：文本 → 字符串，html → { html }，行内代码 → { code }，链接与图片另带地址，
 * 其余 → { 类型: 子节点简式 }
 */
function brief(node) {
    if (node.type === 'text') return node.value;
    if (node.type === 'html') return { html: node.value };
    if (node.type === 'inlineCode') return { code: node.value };
    if (node.type === 'link') return { link: node.url, children: (node.children || []).map(brief) };
    if (node.type === 'image') return { image: node.url, alt: node.alt };
    if (Array.isArray(node.children)) return { [node.type]: node.children.map(brief) };
    return { [node.type]: node.value === undefined ? null : node.value };
}

/**
 * 单个节点的描述：块直属文本写作 text("…")，容器内的文本只写 JSON 字符串；空文本写作 text('')、空 html 写作 html('')；
 * 行内代码写作 code("…")，值缺失写作 code(缺失)、值为 null 或其他非字符串写作 code(null) 一类；指向 LINK_URL 的链接只写
 * 子节点，其余链接另写地址；硬换行写作 break()
 */
function describeNode(node, top = true) {
    if (node.type === 'text') {
        if (!node.value) return "text('')";
        return top ? `text(${JSON.stringify(node.value)})` : JSON.stringify(node.value);
    }
    if (node.type === 'html') return node.value ? `html(${JSON.stringify(node.value)})` : "html('')";
    if (node.type === 'inlineCode') {
        if (!('value' in node)) return 'code(缺失)';
        return typeof node.value === 'string' ? `code(${JSON.stringify(node.value)})` : `code(${String(node.value)})`;
    }
    const inner = (node.children || []).map((child) => describeNode(child, false)).join(', ');
    if (node.type === 'link' && node.url !== LINK_URL) return `link[${node.url}](${inner})`;
    return `${node.type}(${inner})`;
}

/** 用例描述：段落写作行内子节点列表，heading 与 tableCell 另冠块类型，如 heading[text("甲"), code(""), text("乙")] */
function describeCase(kind, nodes) {
    const list = `[${nodes.map((node) => describeNode(node)).join(', ')}]`;
    return kind === 'paragraph' ? list : `${kind}${list}`;
}

/** 值为空的代码段：value 为假（缺失、null、空串、0），与渲染器及上游处理器的 node.value || '' 一致 */
const isEmptyCode = (node) => node.type === 'inlineCode' && !node.value;

/**
 * 展平时略去的 html 节点：值为空串（产物为空），或值以 COMMENT_OPEN 开头、以 COMMENT_CLOSE 结尾（render() 插入的分隔
 * 注释）；以 startsWith 与 endsWith 判定，不用正则
 */
const isSkippedHtml = (node) => node.type === 'html'
    && (!node.value || (node.value.startsWith(COMMENT_OPEN) && node.value.endsWith(COMMENT_CLOSE)));

/**
 * 行内节点序列展平为片段序列：文本片段为 { text, formats }，代码片段为 { code, formats }，formats 为祖先中各格式类型与
 * 「link=地址」的集合（排序后以「+」连接）。相邻且格式集合相同的文本片段合并，相邻且格式集合相同的代码片段同样拼接为
 * 一个；空文本、值为空的代码段与 isSkippedHtml 所指的 html 节点略去，产物为空的节点、空代码段与分隔注释因而不产生片段。
 * 其余类型的节点（其余 html、图片、硬换行等）记为 { unexpected } 片段，只与原 IR 同一位置的同类节点相等
 */
function flatten(nodes, formats = [], out = []) {
    for (const node of nodes) {
        if (node.type === 'text') {
            appendSegment(out, 'text', node.value, formats);
        } else if (node.type === 'inlineCode') {
            if (!isEmptyCode(node)) appendSegment(out, 'code', String(node.value), formats);
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

/** 文本与行内代码的原文串接（空代码段计为空串），用于核对重新解析后是否多出定界符或反引号 */
const plainText = (nodes) => nodes.map((node) => {
    if (node.type === 'text') return node.value;
    if (node.type === 'inlineCode') return isEmptyCode(node) ? '' : String(node.value);
    return plainText(node.children || []);
}).join('');

/**
 * 行内节点的产物是否为空（空代码段一并算作应剔除）：text、html 看 value 是否为空串，inlineCode 看 value 是否为假；六种
 * 格式节点在全部子节点均应剔除时应剔除（无子节点视同）；链接与其余类型一律不剔除
 */
function isPrunable(node) {
    if (node.type === 'text' || node.type === 'html') return !node.value;
    if (node.type === 'inlineCode') return isEmptyCode(node);
    if (!FORMAT_TYPES.includes(node.type)) return false;
    return !Array.isArray(node.children) || node.children.every(isPrunable);
}

/**
 * 参照剔除：本文件独立实现的「去掉空节点与空代码段」，不调用渲染器的内部函数。去掉 value 为空串的 text 与 html、value
 * 为假的 inlineCode，以及子节点去掉之后已无子节点的六种格式节点；链接只剔除其子节点、不剔除自身。返回新数组，不修改入参
 */
function referencePrune(nodes) {
    const out = [];
    for (const node of nodes) {
        if (((node.type === 'text' || node.type === 'html') && !node.value) || isEmptyCode(node)) continue;
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
        for (const char of SUSPECT_CHARS) {
            if (!original.includes(char) && reparsed.includes(char)) reasons.push(`重新解析文本出现原文没有的「${char}」`);
        }
    }
    return reasons.length ? { ir: describeCase(kind, children), md, reparsed: tree.children.map(brief), reasons } : null;
}

/**
 * 渲染单个块并重新解析，返回 { md, failure }：往返正确时 failure 为 null。比对基准取渲染前的深拷贝，修法若就地改动入参，
 * 不会连同基准一起改掉而掩盖错误
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

/** 先断言对照形态（参照剔除后的 IR）往返正确：对照形态本身出错时该形态属范围外，不能用来判定空代码段的影响 */
async function assertControlsRoundTrip(label, controls) {
    const failures = await roundTripFailures(controls);
    const lines = reportLines(failures);
    assert.equal(failures.length, 0, `${label}：参照剔除后的对照形态 ${controls.length} 例中 ${failures.length} 例往返失败（形态`
        + `本身属范围外），前 ${lines.length} 例：${NL}${lines.join(NL)}`);
}

/** 逐例比对产物与期望值，先收集不符项再一次断言；失败信息列出前若干项的用例描述、实际产物与期望产物 */
async function assertOutputs(label, cases) {
    const mismatches = [];
    for (const { kind = 'paragraph', children, md: expected } of cases) {
        const md = await renderBlock(kind, children);
        if (md !== expected) mismatches.push(`${describeCase(kind, children)} → ${JSON.stringify(md)}；期望 ${JSON.stringify(expected)}`);
    }
    const lines = mismatches.slice(0, MAX_REPORTED).map((line, i) => `${i + 1}. ${line}`);
    assert.equal(mismatches.length, 0, `${label}：${cases.length} 例中 ${mismatches.length} 例产物与期望不符，前 ${lines.length} 例：`
        + `${NL}${lines.join(NL)}`);
}

// ============================================================
// 带对照的形态：往返与逐字比对
// ============================================================

/**
 * 空代码段所在的形态：children 为用例，control 为参照剔除后的同一 IR（深拷贝，不与 children 共享节点），另记类别与空代码段
 * 的描述，供分类计数
 */
function shapeCase(kind, children, category) {
    const empties = [];
    const collect = (nodes) => nodes.forEach((node) => {
        if (isEmptyCode(node)) empties.push(describeNode(node));
        if (Array.isArray(node.children)) collect(node.children);
    });
    collect(children);
    return { kind, children, control: structuredClone(referencePrune(children)), category, empty: empties[0] || '无' };
}

/**
 * 逐例检查带对照的形态，返回 { roundTrip, identity }：roundTrip 为往返失败项，identity 为产物与对照形态不同的项。
 * 各失败项另带原用例 item，供分类计数
 */
async function checkShapes(shapes) {
    const roundTrip = [];
    const identity = [];
    for (const item of shapes) {
        const { md, failure } = await renderAndReparse(item.kind, item.children);
        if (failure) roundTrip.push({ ...failure, item });
        const controlMd = await renderBlock(item.kind, item.control);
        if (md !== controlMd) identity.push({ ir: describeCase(item.kind, item.children), md, controlMd, item });
    }
    return { roundTrip, identity };
}

/** 逐字比对失败的逐项说明：前 limit 项的用例描述、md 产物与参照剔除后的产物 */
function identityLines(failures, limit = MAX_REPORTED) {
    return failures.slice(0, limit).map((f, i) => `${i + 1}. ${f.ir} → ${JSON.stringify(f.md)}；`
        + `参照剔除后为 ${JSON.stringify(f.controlMd)}`);
}

/** 按键抽样：每个键只取首个失败项，失败信息因而覆盖各类别，不被同一形态的三种空代码段占满 */
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

/**
 * 一次断言往返与逐字比对的结果：按类别与空代码段种类列出出错的用例数，失败信息每个类别列出首例
 */
function assertShapes(label, shapes, { roundTrip, identity }) {
    const byCategory = (item) => item.category;
    const failedItems = new Set([...roundTrip, ...identity].map((f) => f.item));
    const summary = [['按类别', byCategory], ['按空代码段', (item) => item.empty]]
        .map(([title, keyOf]) => `${title}：${tally(shapes, failedItems, keyOf).join('、')}`);
    assert.equal(roundTrip.length + identity.length, 0, [
        `${label}：${shapes.length} 例中往返失败 ${roundTrip.length} 例、与参照剔除后的产物不一致 ${identity.length} 例；`
            + `出错用例（往返或逐字比对失败）共 ${failedItems.size} 例`,
        ...summary,
        '往返失败（每类首例）：', ...reportLines(firstPerKey(roundTrip, byCategory), Infinity),
        '逐字比对失败（每类首例）：', ...identityLines(firstPerKey(identity, byCategory), Infinity),
    ].join(NL));
}

// ============================================================
// 已列形态
// ============================================================

/** 段落用例：期望产物以「^」代表反引号书写，末尾补段尾换行 */
const paragraphCase = (children, md) => ({ kind: 'paragraph', children, md: `${tick(md)}${NL}` });

/** 实测确认的 13 种形态；各行注释为修复前（a48ad6a）的产物与重新解析的结果 */
function listedCases() {
    return [
        // 「甲``乙」：重新解析为文本「甲``乙」
        paragraphCase([text('甲'), inlineCode(''), text('乙')], '甲乙'),
        // 「`x`<!---->``<!---->`y`」：中间一段重新解析为文本「``」
        paragraphCase([inlineCode('x'), inlineCode(''), inlineCode('y')], '^x^<!---->^y^'),
        // 「甲<strong>``</strong>乙」：重新解析为加粗的文本「``」
        paragraphCase([text('甲'), strong(inlineCode('')), text('乙')], '甲乙'),
        // 「1``. 项」：空代码段隔开数字与记号，重新解析为文本「1``. 项」
        paragraphCase([text('1'), inlineCode(''), text('. 项')], `1${BACKSLASH}. 项`),
        // 「[``](https://a.com)」：链接文本重新解析为「``」；剔除后链接只剩地址
        paragraphCase([link(inlineCode(''))], `[](${LINK_URL})`),
        // 「甲[``乙](https://a.com)」
        paragraphCase([text('甲'), link(inlineCode(''), text('乙'))], `甲[乙](${LINK_URL})`),
        // 「``# 标题」：空代码段写在段首，「#」不在行首而未转义；剔除后「#」位于段首，照常转义
        paragraphCase([inlineCode(''), text('# 标题')], `${BACKSLASH}# 标题`),
        // 「甲\\``!」：反斜杠按代码段 peek 报出的反引号转义，重新解析为「甲\``!」；剔除后按真实邻居「!」转义
        paragraphCase([text(`甲${BACKSLASH}`), inlineCode(''), text('!')], `甲${BACKSLASH}${BACKSLASH}!`),
        // 值缺失、为 null、为 0：上游同样以 node.value || '' 取空值，产物均为「甲``乙」
        paragraphCase([text('甲'), missingCode(), text('乙')], '甲乙'),
        paragraphCase([text('甲'), inlineCode(null), text('乙')], '甲乙'),
        paragraphCase([text('甲'), inlineCode(0), text('乙')], '甲乙'),
        // heading 与 tableCell：「## 甲``乙」与表体「甲``乙」
        { kind: 'heading', children: [text('甲'), inlineCode(''), text('乙')], md: `## 甲乙${NL}` },
        { kind: 'tableCell', children: [text('甲'), inlineCode(''), text('乙')], md: `| ${TABLE_HEAD} |${NL}| -- |${NL}| 甲乙 |${NL}` },
    ];
}

/** 只由空代码段（或只含空代码段的格式节点）构成的段落：修复前依次为「``」「**``**」与「``」，修复后产物为空串 */
function blankCases() {
    return [
        { children: [inlineCode('')], md: '' },
        { children: [strong(inlineCode(''))], md: '' },
        { children: [missingCode(), html('')], md: '' },
    ];
}

// ============================================================
// 块末硬换行之后只有空代码段
// ============================================================

// 块末硬换行的写法：与渲染器的 HTML_BREAK 一致，块末连续的 k 个硬换行写作 k 个 HTML_BREAK 的拼接
const HTML_BREAK = '<br>';
// 本组节点简式中硬换行的记法
const BREAK_MARK = 'BR';
// 本组重新解析后不应凭空出现的字符：字面反斜杠（块末的「\ + 换行」）与反引号（空代码段写出的「``」）
const BREAK_SUSPECT_CHARS = [BACKSLASH, BACKTICK];

/**
 * 本组的容器：depth 为 0 时为段落，否则为该级标题；prefix 为期望产物中的 ATX 前缀。1–2 级标题含硬换行时上游改走 setext
 * 形式，3 级起走 ATX 形式，两种形式各取一级。各行注释为修复前（f77d817）[text(甲), break, 空代码段] 的产物与重新解析
 * 的结果
 */
const BREAK_BLOCKS = [
    // 「甲\」加换行再加「``」：重新解析为文本「甲」、硬换行与文本「``」
    { name: '段落', depth: 0, prefix: '' },
    // setext 形式，「甲\」加换行、「``」加换行再加下划线「--」：重新解析为 2 级标题，文本「甲」、硬换行与文本「``」
    { name: '2 级标题', depth: 2, prefix: '## ' },
    // ATX 形式，硬换行写作空格，「### 甲 ``」：重新解析为 3 级标题「甲 ``」，硬换行丢失
    { name: '3 级标题', depth: 3, prefix: '### ' },
];

const hardBreak = () => ({ type: 'break' });

/** 渲染 depth 所指的块：0 为段落，否则为该级标题。blockOf 的标题固定为 HEADING_DEPTH 级，本组另需 3 级标题，故另写 */
function renderAtDepth(depth, children) {
    const block = depth ? createHeading(depth, children) : createParagraph(children);
    return mdRenderer.render(createDocument({ ir: createRoot([block]) }));
}

/** 本组的节点简式：硬换行 → BREAK_MARK，段落写作 { paragraph }，标题另带级数写作 { heading3 } 一类，其余沿用 brief */
function breakBrief(node) {
    if (node.type === 'break') return BREAK_MARK;
    if (node.type === 'paragraph') return { paragraph: node.children.map(breakBrief) };
    if (node.type === 'heading') return { [`heading${node.depth}`]: node.children.map(breakBrief) };
    return brief(node);
}

/** 本层子节点中硬换行的个数 */
const breakCount = (nodes) => nodes.filter((node) => node.type === 'break').length;

/**
 * 块末硬换行之后只有空代码段的 10 例：3 种容器 × 3 种空代码段的 [text(甲), break, 空代码段]，另加段落
 * [text(甲), break, break, code('')]；期望产物为剔除空代码段后块末硬换行的写法，末尾 k 个硬换行写作 k 个 HTML_BREAK
 */
function trailingBreakCases() {
    const cases = BREAK_BLOCKS.flatMap((block) => EMPTY_CODES.map((makeEmpty) => ({
        ...block, children: [text('甲'), hardBreak(), makeEmpty()], md: `${block.prefix}甲${HTML_BREAK}${NL}`,
    })));
    // 修复前为「甲\」「\」「``」三行：重新解析为文本「甲」、两个硬换行与文本「``」
    cases.push({
        ...BREAK_BLOCKS[0], children: [text('甲'), hardBreak(), hardBreak(), inlineCode('')], md: `甲${HTML_BREAK}${HTML_BREAK}${NL}`,
    });
    return cases;
}

/**
 * 核对一例：逐字比对产物；重新解析后须为单个同类型的块、标题级数不变；块的子节点简式须依次等于原 IR 参照剔除后的简式
 * （text「甲」与硬换行），硬换行个数与原 IR 一致；重新解析后的文本与代码值不出现原文没有的 BREAK_SUSPECT_CHARS。返回
 * { md, reparsed, reasons }，全部符合时 reasons 为空。比对基准取渲染前的深拷贝，理由同 renderAndReparse
 */
async function trailingBreakCheck(item) {
    const original = structuredClone(item.children);
    const md = await renderAtDepth(item.depth, item.children);
    const tree = await reparse(md);
    const reasons = [];
    if (md !== item.md) reasons.push(`产物应为 ${JSON.stringify(item.md)}`);
    const [block] = tree.children;
    const sameBlock = tree.children.length === 1
        && (item.depth ? block.type === 'heading' && block.depth === item.depth : block.type === 'paragraph');
    if (!sameBlock) {
        reasons.push(`重新解析后不是单个${item.depth ? '同级数的标题' : '段落'}`);
    } else {
        const expected = referencePrune(original).map(breakBrief);
        if (!isDeepStrictEqual(block.children.map(breakBrief), expected)) reasons.push(`子节点应依次为 ${JSON.stringify(expected)}`);
        const [actualBreaks, originalBreaks] = [breakCount(block.children), breakCount(original)];
        if (actualBreaks !== originalBreaks) reasons.push(`硬换行 ${actualBreaks} 个，原 IR 为 ${originalBreaks} 个`);
        for (const char of BREAK_SUSPECT_CHARS) {
            if (!plainText(original).includes(char) && plainText(block.children).includes(char)) {
                reasons.push(`重新解析文本出现原文没有的「${char}」`);
            }
        }
    }
    return { md, reparsed: tree.children.map(breakBrief), reasons };
}

// ============================================================
// 敏感边界矩阵（沿用 test/md-empty-inline-context.test.js 的 60 种形态）
// ============================================================

// 段首的行首记号：去掉 E 后均转义
const PARAGRAPH_START_MARKERS = ['# 标题', '#', '1. 项', '1.', '1) 项', '- 项', '-', '+ 项', '> 引', '---'];
// 段中换行后的行首记号：单独的「1.」是空列表项，不能打断段落；「=」只在段中才构成 setext 标题下划线
const LINE_BREAK_MARKERS = ['# 标题', '#', '1. 项', '1) 项', '- 项', '-', '+ 项', '> 引', '---', '='];
// 行首空白：一个、两个与四个空格
const LEADING_SPACES = [' 甲', '  甲', '    缩进'];

/** 矩阵形态：E 之前与之后的节点以工厂给出，每例新建节点 */
const boundary = (category, before, after) => ({ category, before, after });

const BOUNDARY_SHAPES = [
    ...PARAGRAPH_START_MARKERS.map((x) => boundary('段首行首记号', () => [], () => [text(x)])),
    ...LEADING_SPACES.map((x) => boundary('段首行首空白', () => [], () => [text(x)])),
    ...[...LINE_BREAK_MARKERS, ...LEADING_SPACES].map((x) => boundary('段中换行后', () => [text(`甲${NL}`)], () => [text(x)])),
    boundary('行首记号与其后的必需字符被隔开', () => [text('-')], () => [text(' 项')]),
    boundary('行首记号与其后的必需字符被隔开', () => [text('+')], () => [text(' 项')]),
    boundary('行首记号与其后的必需字符被隔开', () => [text('1.')], () => [text(' 项')]),
    boundary('行首记号与其后的必需字符被隔开', () => [text('-')], () => [text('--')]),
    boundary('行首记号与其后的必需字符被隔开', () => [text(`甲${NL}-`)], () => [text(' 项')]),
    boundary('段尾行尾空白', () => [text('甲 ')], () => []),
    boundary('段尾行尾空白', () => [text('甲  ')], () => []),
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

/** 敏感边界矩阵各例：形态 × 空代码段 */
function buildBoundaryMatrix() {
    return BOUNDARY_SHAPES.flatMap((item) => EMPTY_CODES.map((makeEmpty) => shapeCase(
        'paragraph', [...item.before(), makeEmpty(), ...item.after()], item.category,
    )));
}

// ============================================================
// 代码段、数字边界与定界符矩阵
// ============================================================

/** 形态：以 E 工厂构造行内子节点，每例新建节点 */
const CODE_SHAPES = [
    ['夹在两个代码段之间', (e) => [inlineCode('x'), e(), inlineCode('y')]],
    ['夹在两个代码段之间', (e) => [inlineCode(tick('a^b')), e(), inlineCode('c')]],
    ['夹在两个代码段之间', (e) => [inlineCode(' x '), e(), inlineCode(tick('^'))]],
    ['连续两个空代码段', (e) => [inlineCode('x'), e(), e(), inlineCode('y')]],
    ['连续两个空代码段', (e) => [text('甲'), e(), e(), text('乙')]],
    ['夹在数字与记号之间', (e) => [text('1'), e(), text('. 项')]],
    ['夹在数字与记号之间', (e) => [text(`甲${NL}12`), e(), text(') 项')]],
    ['夹在数字与记号之间', (e) => [text('1'), e(), text('2'), e(), text('. 项')]],
    ['定界符式格式两侧', (e) => [strong('A'), e(), emphasis('B')]],
    ['定界符式格式两侧', (e) => [strong('《甲》'), e(), text('乙')]],
    ['定界符式格式两侧', (e) => [text('甲'), e(), strong('《乙》')]],
    ['定界符式格式两侧', (e) => [del('甲。'), e(), del('乙')]],
];

function buildCodeMatrix() {
    return CODE_SHAPES.flatMap(([category, make]) => EMPTY_CODES.map((e) => shapeCase('paragraph', make(e), category)));
}

// ============================================================
// 语境矩阵
// ============================================================

// 空代码段所在的位置：夹在两段文本之间、夹在两个代码段之间、位于容器开头、位于容器末尾
const POSITIONS = [
    ['夹在两段文本之间', (e) => [text('甲'), e(), text('乙')]],
    ['夹在两个代码段之间', (e) => [inlineCode('x'), e(), inlineCode('y')]],
    ['位于开头', (e) => [e(), text('乙')]],
    ['位于末尾', (e) => [text('甲'), e()]],
];
// 语境：name 为名称，kind 为块类型，wrap 把行内子节点放进该语境，返回块的行内子节点
const CONTEXTS = [
    { name: '段落直属', kind: 'paragraph', wrap: (nodes) => nodes },
    ...FORMAT_TYPES.map((type) => ({ name: `${type} 内部`, kind: 'paragraph', wrap: (nodes) => [format(type)(...nodes)] })),
    { name: 'link 内部', kind: 'paragraph', wrap: (nodes) => [link(...nodes)] },
    { name: 'heading 内', kind: 'heading', wrap: (nodes) => nodes },
    { name: 'tableCell 内', kind: 'tableCell', wrap: (nodes) => nodes },
];

function buildContextMatrix() {
    return CONTEXTS.flatMap((ctx) => POSITIONS.flatMap(([position, make]) => EMPTY_CODES.map((e) => shapeCase(
        ctx.kind, ctx.wrap(make(e)), `${ctx.name}：${position}`,
    ))));
}

// ============================================================
// 回归护栏
// ============================================================

// 不含空代码段的形态：期望值取自修复前（a48ad6a）的实际产物
const GUARD_CASES = [
    // 值为空白、反引号或字符串「0」的代码段不为空，照常写出
    paragraphCase([inlineCode(' ')], '^ ^'),
    paragraphCase([inlineCode('  ')], '^  ^'),
    paragraphCase([inlineCode(tick('^'))], '^^ ^ ^^'),
    paragraphCase([inlineCode(tick('^^'))], '^ ^^ ^'),
    paragraphCase([text('甲'), inlineCode('0'), text('乙')], '甲^0^乙'),
    // 非字符串的真值由上游转为字符串写出
    paragraphCase([text('甲'), inlineCode(5), text('乙')], '甲^5^乙'),
    // 文本中的反引号逐个转义
    paragraphCase([text(tick('甲^乙'))], `甲${BACKSLASH}^乙`),
    // 两段之间夹空文本的代码段：空文本先被剔除，两段以分隔注释隔开
    paragraphCase([inlineCode('x'), text(''), inlineCode('y')], '^x^<!---->^y^'),
    // heading 与 tableCell 内的代码段
    { kind: 'heading', children: [text('甲'), inlineCode(' ')], md: `${tick('## 甲^ ^')}${NL}` },
    { kind: 'tableCell', children: [inlineCode('x'), text('、'), inlineCode('y')], md: `${tick(`| ${TABLE_HEAD}      |${NL}| ------- |${NL}| ^x^、^y^ |`)}${NL}` },
];

// ============================================================
// 种子随机段落
// ============================================================

// 敏感边界文本与普通文本：沿用 test/md-empty-inline-context.test.js 的文本池，不含「w」「@」「:」，不以数字结尾、不以
// 「.」「)」开头；另加含反引号的文本
const BOUNDARY_TEXTS = [
    '# 标题', '#', '1. 项', '1) 项', '- 项', '-', '+ 项', '> 引', '---', '=',
    ' 甲', '    缩进', '甲 ', '甲  ',
    `甲${BACKSLASH}`, BACKSLASH, '!', '(注)',
    '甲!', '甲&', '&', 'amp;', '#x41;', 'lt;乙', '甲<', '<', 'b>乙', '/b>乙',
    BACKTICK, tick('甲^'), tick('^乙'),
];
const ORDINARY_TEXTS = ['甲', '乙丙', '。', '，', '《乙》', '「甲', 'ab', 'a b', EMOJI, '（注）', '*', '~'];
// 含换行的文本：只作段落直属文本，每段至多一个，因而不会出现连续两个换行
const NEWLINE_TEXTS = [`甲${NL}`, `${NL}乙`];
// 非空代码段的值：沿用 test/md-inline-code-adjacent.test.js 的九种代码值
const CODE_VALUES = ['x', tick('a^b'), tick('^a'), tick('a^'), tick('^^'), ' x ', ' ', 'a  b', '中文'];
const RANDOM_SEED = 20260928;
const RANDOM_COUNT = 2000;
// 各位置的取值概率：空代码段、其他产物为空的节点、非空代码段串、文本、非空格式节点，余下为链接
const EMPTY_CODE_RATE = 0.2;
const EMPTY_RATE = 0.1;
const CODE_RUN_RATE = 0.2;
const TEXT_RATE = 0.25;
const FORMAT_RATE = 0.15;
// 非空代码段串内相邻两段之间夹一个空代码段的概率；抽中文本时改取含换行文本的概率（仅段落直属、每段至多一次）
const GAP_RATE = 0.3;
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

/** 其他产物为空的节点：三分之一为空文本，三分之一为空 html，其余为六种格式之一的无内容格式节点或只含空代码段的格式节点 */
function randomEmpty(rand) {
    const roll = rand();
    if (roll < 1 / 3) return text('');
    if (roll < 2 / 3) return html('');
    return rand() < 0.5 ? format(pick(rand, FORMAT_TYPES))() : format(pick(rand, FORMAT_TYPES))(pick(rand, EMPTY_CODES)());
}

/** 非空代码段串：1–2 个非空代码段依次相邻，两段之间以 GAP_RATE 的概率夹一个空代码段 */
function randomCodeRun(rand) {
    const nodes = [inlineCode(pick(rand, CODE_VALUES))];
    if (rand() < 0.5) {
        if (rand() < GAP_RATE) nodes.push(pick(rand, EMPTY_CODES)());
        nodes.push(inlineCode(pick(rand, CODE_VALUES)));
    }
    return nodes;
}

/** 文本：段落直属且本段尚未用过含换行文本时，以 NEWLINE_RATE 的概率取含换行文本，否则取敏感边界文本或普通文本 */
function randomText(rand, depth, ctx) {
    if (depth === 0 && !ctx.newlineUsed && rand() < NEWLINE_RATE) {
        ctx.newlineUsed = true;
        return text(pick(rand, NEWLINE_TEXTS));
    }
    return text(pick(rand, rand() < 0.6 ? BOUNDARY_TEXTS : ORDINARY_TEXTS));
}

/**
 * 一个位置上的行内节点（代码段串可含多个节点）：按上列概率依次取空代码段、其他空节点、非空代码段串、文本与含 1–3 个
 * 位置的格式节点，余下为链接。深度达到上限时格式节点与链接改取文本；链接之内不再嵌套链接，改取格式节点。链接的首个
 * 子节点为非空文本（与地址不同），另以 50% 的概率再接一个位置
 */
function randomPosition(rand, depth, ctx) {
    const roll = rand();
    let edge = EMPTY_CODE_RATE;
    if (roll < edge) return [pick(rand, EMPTY_CODES)()];
    edge += EMPTY_RATE;
    if (roll < edge) return [randomEmpty(rand)];
    edge += CODE_RUN_RATE;
    if (roll < edge) return randomCodeRun(rand);
    edge += TEXT_RATE;
    if (roll < edge || depth >= MAX_DEPTH) return [randomText(rand, depth, ctx)];
    edge += FORMAT_RATE;
    if (roll < edge || ctx.inLink) {
        const count = 1 + Math.floor(rand() * 3);
        const children = [];
        for (let i = 0; i < count; i += 1) children.push(...randomPosition(rand, depth + 1, ctx));
        return [format(pick(rand, FORMAT_TYPES))(...children)];
    }
    const children = [text(pick(rand, ORDINARY_TEXTS))];
    if (rand() < 0.5) children.push(...randomPosition(rand, depth + 1, { ...ctx, inLink: true }));
    return [link(...children)];
}

/**
 * count 个段落，每段 1–6 个位置；可见文本以换行开头或结尾时在段首补「前」、段尾补「后」，避开解析器丢弃的段首段尾换行
 */
function randomParagraphs(seed, count) {
    const rand = mulberry32(seed);
    const paragraphs = [];
    for (let k = 0; k < count; k += 1) {
        const size = 1 + Math.floor(rand() * 6);
        const ctx = { newlineUsed: false, inLink: false };
        const children = [];
        for (let i = 0; i < size; i += 1) children.push(...randomPosition(rand, 0, ctx));
        const visible = plainText(children);
        if (visible.startsWith(NL)) children.unshift(text('前'));
        if (visible.endsWith(NL)) children.push(text('后'));
        paragraphs.push(children);
    }
    return paragraphs;
}

/** 行内节点序列中是否含空代码段（任意深度） */
const hasEmptyCode = (nodes) => nodes.some((node) => isEmptyCode(node) || (Array.isArray(node.children) && hasEmptyCode(node.children)));

// ============================================================
// 用例：已列形态
// ============================================================

test('已列形态：空代码段的 13 种形态（夹在文本、代码段、数字与记号之间，位于格式节点、链接、段首、heading 与 tableCell 内，值缺失、为 null 或 0）产物逐字符合剔除后的写法、往返正确；只由空代码段构成的段落产物为空串', async () => {
    // Arrange
    const cases = listedCases();
    const blank = blankCases();
    assert.equal(cases.length, 13);

    // Act & Assert
    await assertOutputs('已列形态', cases);
    await assertAllRoundTrip('已列形态', cases);
    await assertOutputs('只由空代码段构成的段落', blank);
});

// ============================================================
// 用例：块末硬换行之后只有空代码段
// ============================================================

test(`块末硬换行之后只有空代码段：3 种空代码段 × 3 种容器（段落、2 级标题、3 级标题）的 [text(甲), break, 空代码段]，另加段落 [text(甲), break, break, code('')]，产物逐字为剔除空代码段后块末硬换行的 <br> 写法；重新解析后块类型与标题级数不变，子节点依次为 text「甲」与硬换行、硬换行个数与原 IR 一致，不出现原文没有的「${BACKSLASH}」「${BACKTICK}」`, async () => {
    // Arrange：修复前（f77d817）空代码段使硬换行不在块末，块末硬换行的改写不触发，10 例均多出文本「``」，
    // 3 级标题另丢失硬换行
    const cases = trailingBreakCases();
    assert.equal(cases.length, 10);

    // Act：逐例渲染并重新解析，先收集失败项
    const failures = [];
    for (const item of cases) {
        const label = `${item.name}[${item.children.map((node) => describeNode(node)).join(', ')}]`;
        const { md, reparsed, reasons } = await trailingBreakCheck(item);
        if (reasons.length) failures.push(`${label} → ${JSON.stringify(md)}；${reasons.join('、')}；重新解析：${JSON.stringify(reparsed)}`);
    }

    // Assert：一次断言，失败信息列出前若干例
    const lines = failures.slice(0, MAX_REPORTED).map((line, i) => `${i + 1}. ${line}`);
    assert.equal(failures.length, 0, `块末硬换行之后只有空代码段：${cases.length} 例中 ${failures.length} 例失败，前 ${lines.length} 例：`
        + `${NL}${lines.join(NL)}`);
});

// ============================================================
// 用例：三组矩阵
// ============================================================

test('敏感边界矩阵：3 种空代码段 × 60 种敏感边界形态，对照形态往返正确；各例重新解析后格式、链接、代码与文本均不变，产物与参照剔除后的同一 IR 逐字相同', async () => {
    // Arrange
    const shapes = buildBoundaryMatrix();
    assert.equal(BOUNDARY_SHAPES.length, 60);
    assert.equal(shapes.length, BOUNDARY_SHAPES.length * EMPTY_CODES.length);
    await assertControlsRoundTrip('敏感边界矩阵', shapes.filter((_, i) => i % EMPTY_CODES.length === 0).map((item) => ({ kind: item.kind, children: item.control })));

    // Act
    const result = await checkShapes(shapes);

    // Assert
    assertShapes('敏感边界矩阵', shapes, result);
});

test('代码段、数字边界与定界符矩阵：3 种空代码段 × 12 种形态（夹在代码段之间、连续两个、夹在数字与记号之间、位于定界符式格式两侧），对照形态往返正确；各例往返正确，产物与参照剔除后的同一 IR 逐字相同', async () => {
    // Arrange
    const shapes = buildCodeMatrix();
    assert.equal(shapes.length, CODE_SHAPES.length * EMPTY_CODES.length);
    await assertControlsRoundTrip('代码段、数字边界与定界符矩阵', shapes.map((item) => ({ kind: item.kind, children: item.control })));

    // Act
    const result = await checkShapes(shapes);

    // Assert
    assertShapes('代码段、数字边界与定界符矩阵', shapes, result);
});

test('语境矩阵：3 种空代码段 × 4 种位置 × 10 种语境（段落直属、六种格式节点与 link 内部、heading 与 tableCell 内），对照形态往返正确；各例往返正确，产物与参照剔除后的同一 IR 逐字相同', async () => {
    // Arrange
    const shapes = buildContextMatrix();
    assert.equal(shapes.length, CONTEXTS.length * POSITIONS.length * EMPTY_CODES.length);
    await assertControlsRoundTrip('语境矩阵', shapes.map((item) => ({ kind: item.kind, children: item.control })));

    // Act
    const result = await checkShapes(shapes);

    // Assert
    assertShapes('语境矩阵', shapes, result);
});

// ============================================================
// 用例：回归护栏（修复前后均应通过）
// ============================================================

test('回归护栏：不含空代码段的 10 种形态（值为空白、反引号、字符串「0」与数字 5 的代码段，文本中的反引号，两段之间夹空文本的代码段，heading 与 tableCell 内的代码段）产物逐字等于 a48ad6a 的产物，且往返正确', async () => {
    // Arrange：期望值取自修复前（a48ad6a）的实际产物
    assert.equal(GUARD_CASES.length, 10);

    // Act & Assert
    await assertOutputs('回归护栏', GUARD_CASES);
    await assertAllRoundTrip('回归护栏', GUARD_CASES);
});

// ============================================================
// 用例：种子随机往返
// ============================================================

test(`种子随机往返：种子 ${RANDOM_SEED} 生成 ${RANDOM_COUNT} 个段落（每段 1–6 个位置，各位置以 ${EMPTY_CODE_RATE * 100}% 的概率取空代码段，其余取自其他空节点、非空代码段、敏感边界文本、普通文本、非空格式节点与链接，容器嵌套深度 ≤ ${MAX_DEPTH}），每段产物与参照剔除后的 IR 产物逐字相同，只由空节点构成的段落产物为空串，其余重新解析后格式、链接、代码与文本均不变`, async () => {
    // Arrange：含空代码段的段落数与只由空节点构成的段落数随生成器固定
    const cases = randomParagraphs(RANDOM_SEED, RANDOM_COUNT);
    const withEmptyCode = cases.filter(hasEmptyCode);
    const blank = cases.filter((children) => children.every(isPrunable));
    assert.equal(cases.length, RANDOM_COUNT);
    assert.equal(withEmptyCode.length, 1418);
    assert.equal(blank.length, 171);

    // Act：逐段渲染并与参照剔除后的 IR 的产物比对；只由空节点构成的段落核对产物为空串，其余段落核对往返
    const identity = [];
    const nonBlank = [];
    const roundTrip = [];
    for (const children of cases) {
        const original = structuredClone(children);
        const md = await renderBlock('paragraph', children);
        const controlMd = await renderBlock('paragraph', referencePrune(original));
        if (md !== controlMd) identity.push({ ir: describeCase('paragraph', original), md, controlMd });
        if (original.every(isPrunable)) {
            if (md !== '') nonBlank.push(`${describeCase('paragraph', original)} → ${JSON.stringify(md)}`);
            continue;
        }
        const failure = await roundTripFailureOf('paragraph', original, md);
        if (failure) roundTrip.push(failure);
    }

    // Assert：三项一并断言，失败信息分别计数
    const idLines = identityLines(identity);
    const blankLines = nonBlank.slice(0, MAX_REPORTED).map((line, i) => `${i + 1}. ${line}`);
    const rtLines = reportLines(roundTrip);
    assert.equal(identity.length + nonBlank.length + roundTrip.length, 0, [
        `种子随机往返：${cases.length} 段（含空代码段 ${withEmptyCode.length} 段）中与参照剔除后的产物不一致 ${identity.length} 段；`
            + `只由空节点构成的 ${blank.length} 段中产物非空 ${nonBlank.length} 段；其余 ${cases.length - blank.length} 段中往返失败 `
            + `${roundTrip.length} 段`,
        `逐字比对失败（前 ${idLines.length} 段）：`, ...idLines,
        `产物非空（前 ${blankLines.length} 段）：`, ...blankLines,
        `往返失败（前 ${rtLines.length} 段）：`, ...rtLines,
    ].join(NL));
});
