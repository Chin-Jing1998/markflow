/**
 * IR → Markdown
 *
 * 用 remark-stringify + remark-gfm 链支持 GFM 表格/删除线等扩展；
 * 扩展节点（slideBreak/sheetSection）先降级为 H1/H2/thematicBreak；
 * math 节点转为线性化文本并套 TeX 定界符（块级 $$…$$ 独立成段，行内 $…$），
 * 不引入 remark-math，故定界符只是文本约定，往返解析时按普通文本处理。
 * 带 data.safeTable 的 html 节点与其它 html 节点一样按原样输出（remark-stringify 直出 value）。
 *
 * 版面与格式（与 ir/markers、ir/inline-html 配套）：
 *   - 残留私用区标记兜底剥除；paragraph.data.indent → 段首 n 个 U+3000；非代码文本中的 \t → 两个 U+3000
 *   - 带 data.display 的图片输出 <img src="…" width="W" alt="…">（只写宽度，属性值转义）；无 display 仍为 ![]()
 *   - underline / superscript / subscript → <u>…</u> / <sup>…</sup> / <sub>…</sub>（Markdown 无对应语法，
 *     行内 HTML 经 ir/inline-html 再解析后仍是同一节点）
 *   - strong / emphasis / delete：定界符两侧按 CommonMark flanking 规则（标点含 \p{P}\p{S}）判定安全、且不与相邻
 *     兄弟的同一定界符字符首尾相接时写 ** / * / ~~，否则回退 <strong> / <em> / <del>——中文标点旁的字面星号会被
 *     转义成 \*\*，默认处理器还会把相邻汉字写成 &#x…; 字符引用；两对同字符定界符首尾相接会并成一个定界符串，
 *     重新解析时配对错位、残留字面星号或波浪号。处在同类型格式节点之内的格式节点一律写标签，免得内层定界符
 *     与外层配对；相邻兄弟产物为空（看不到真实邻居）时同样保守写标签：前侧以外侧字符为空串识别，后侧另须直接
 *     判定后一兄弟的产物是否为空，因为无内容的格式节点与空 html 的 peek 仍报「*」「~」或「<」，外侧字符并不为空串。
 *     render() 已先行剔除行内语境中产物为空的节点（见下条），这两条回退规则在常规 IR 中不再触发，保留作兜底
 *   - 产物为空的行内节点（空文本、空 html、内容为空的六种行内格式）与值为空的行内代码段在 stringify 之前从 paragraph、
 *     heading、tableCell、行内格式与链接的子节点中剔除：空节点会遮住相邻节点的 before / after 与 peek 语境，使行首
 *     记号、首尾空白、末尾反斜杠等的转义与定界符的判定落空；值为空的行内代码段由上游写作「``」，CommonMark 没有空代码段
 *     的写法，重新解析为字面文本。剔除后含这些节点的 IR 与去掉它们后的 IR 产物逐字相同
 *   - 剔除之后仍相邻的两个 inlineCode 之间插入空 HTML 注释 <!---->：inlineCode 按值内的反引号串选定围栏长度，相邻
 *     两段的闭围栏与开围栏会并成一个更长的反引号串，重新解析时配对错位，只调围栏长度无法分开；注释重新解析为 html
 *     节点，html、docx、xml、content-list 渲染器均将其剥除。插入与剔除在同一趟遍历中进行，只在剔除空节点之后、父节点
 *     属 PHRASING_PARENTS（即上条所列父类型）时插入，因此两段之间原有的空节点先被剔除，剔除后相邻的两段同样分隔
 *   - 同一趟遍历中、同样只在 PHRASING_PARENTS 各类型中，剔除之后相邻的两个 text 在数字边界处合并：前一段以 ASCII
 *     数字结尾、后一段以 ASCII 数字或「.」「)」开头时并为一个节点。有序列表记号模式要求「换行 + 可选空白 + 数字 +
 *     记号」同在一个 value 之内，safe() 只在单个节点的 before + 文本 + after 中匹配、只转义本节点文本，数字与记号分属
 *     相邻 text 时两侧都不转义，位于行首时可能重新解析为有序列表。只在数字边界合并而不合并全部相邻 text：全部合并会
 *     把任意相邻 text 中的转义位置集中到一次 safe() 调用，而 safe() 对转义位置的去重为平方级
 *   - 经 remark-stringify 的 unsafe 选项补入「+」「-」「数字 + .」三条行首记号模式的前瞻版（LINE_MARKER_UNSAFE）：默认
 *     模式的 after 吃掉行尾换行，同一个 text 内一行只有记号、下一行又以同种记号开头时第二行不转义，重新解析为列表或
 *     setext 标题；inlineCode 处理器把值内「换行 + 记号」的换行改为空格时同样漏掉第二行
 *   - paragraph 与 heading 末尾的连续硬换行在同一趟遍历中并为一个 html 节点、写作同样个数的 <br>：CommonMark 只认块内
 *     两行之间的硬换行，段尾的「\ + 换行」重新解析为字面反斜杠、「两个空格 + 换行」被删去，上游 break 处理器一律写
 *     「\ + 换行」，段尾的硬换行因而丢失并留下反斜杠；heading 含 break 时 1–2 级被上游改走 setext 形式、末尾的「\ + 换行」
 *     使下划线长度为 0 而整个丢失，3 级起在 ATX 形式中写成空格而被丢弃。写作 <br> 后重新解析为 html 节点，由 ir/inline-html
 *     提升为 break；html、docx、xml、content-list 渲染器都把 break 写成各自的换行。只改块末（含列表项与引用块内的段落与
 *     标题）：处在块末格式节点或链接末尾的硬换行，其后紧随闭标签或「](」，仍是硬换行；heading 段中与 tableCell 内的硬换行
 *     由上游另行处理（见 pruneEmptyInline）。并为一个节点而不逐个改写：上游对 heading 的 setext 判定按子节点个数呈平方级
 *     （见 rewriteTrailingBreaks）
 *   - root 的子节点含上游 phrasing 类型时，先把 root 的全部子节点包进一个 paragraph 再剔除与渲染：上游 root 处理器以
 *     containerPhrasing 拼接这类子节点，却不进入 phrasing 语境，只在该语境中转义的写法照原样写出；root 也不在上述剔除、
 *     合并、分隔与块末硬换行改写的范围内。包进 paragraph 后，这组子节点的产物与放在段落中逐字相同。块级子节点仍与行内
 *     内容直接拼接、不另起一块，但随之处在 phrasing 语境中，其处理器经 safe() 写出的部分多出该语境的转义，涉及围栏代码
 *     的信息串、定义的标签、地址与标题，以及脚注定义的标签（见 wrapPhrasingRoot）
 */
const { loadUnified } = require('../ir/unified-loader');
const { downgradeCustomNodes, mathToText } = require('../ir/schema');
const { stripMarkersTree, applyTextLayout } = require('../ir/markers');

// 与 legacy turndown 配置对齐：bullet '-'、rule '---'、emphasis '*'、strong '**'、fences、atx
const MD_OPTIONS = {
    bullet: '-',
    rule: '-',
    emphasis: '*',
    strong: '*',
    fences: true,
    setext: false,
    listItemIndent: 'one',
};

const PUNCTUATION_RE = /[\p{P}\p{S}]/u;
const WHITESPACE_RE = /[\s\p{Zs}]/u;
const PX_RE = /^\d{1,5}$/;
const MAX_PERCENT = 100;

/**
 * 补入的行首记号转义模式：与 mdast-util-to-markdown 2.1.2 lib/unsafe.js 中「+」「-」「数字 + .」三条 atBreak 模式同构，
 * 只把 after 由消耗性的 (?:…) 改为前瞻 (?=…)。
 * 为何补入：默认三条模式的 after 可含换行，safe() 对每条模式各做一次全局 exec 循环，前一次匹配把行尾换行吃进 after，
 * 下一行开头缺少 atBreak 所需的换行，同一模式在下一行的记号不再匹配。同一个 text 内一行只有「1.」「-」或「+」、下一行
 * 又以同种记号开头时（如「0.」加换行加「1. 项」），第二行的记号不转义，重新解析为列表或 setext 标题；inlineCode 处理器
 * 用同一组 atBreak 模式把值内「换行 + 记号」的换行改为空格，同样漏掉第二行。前瞻不消耗换行，下一次匹配仍能从该换行
 * 起步；三条模式所匹配的位置是默认模式的超集，多出的位置只有被吃掉换行的那些，其余位置与默认模式重复，safe() 以
 * positions.includes 去重且 before / after 两项标记与默认模式相同，产物只在缺陷形态上改变。configure 把 unsafe 追加到
 * 默认列表之后，无 inConstruct 限制，与默认模式的适用范围相同。
 * 线性：编译后的正则以 [\r\n] 起步，每个换行之后只沿其后的空白与数字串扫描一次，前瞻为常数时间，整体线性于文本长度。
 * 不冻结这些对象：compilePattern 把编译结果缓存在模式对象的 _compiled 属性上。
 */
const LINE_MARKER_UNSAFE = [
    { atBreak: true, character: '+', after: '(?=[ \\t\\r\\n])' },
    { atBreak: true, character: '-', after: '(?=[ \\t\\r\\n-])' },
    { atBreak: true, before: '\\d+', character: '.', after: '(?=[ \\t\\r\\n]|$)' },
];

async function render(doc) {
    const { unified, remarkStringify, remarkGfm } = await loadUnified();
    const prepared = displayImagesToHtml(applyTextLayout(stripMarkersTree(doc.ir)));
    const downgraded = pruneEmptyInline(wrapPhrasingRoot(downgradeCustomNodes(wrapMath(prepared))));
    const result = unified()
        .use(remarkGfm)
        .use(remarkStringify, { ...MD_OPTIONS, handlers: HANDLERS, unsafe: LINE_MARKER_UNSAFE })
        .stringify(downgraded);
    return String(result);
}

/** math → 文本：display 为真时独立成段并用 $$…$$ 包裹，否则行内 $…$。不修改入参，返回新树 */
function wrapMath(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(wrapMath);
    if (node.type === 'math') {
        const display = Boolean(node.data && node.data.display);
        const text = mathToText(node);
        const value = display ? `$$${text}$$` : `$${text}$`;
        return display ? { type: 'paragraph', children: [{ type: 'text', value }] } : { type: 'text', value };
    }
    if (Array.isArray(node.children)) return { ...node, children: node.children.map(wrapMath) };
    return node;
}

// ============================================================
// root 的子节点含上游 phrasing 类型：包进段落
// ============================================================

// 上游 root 处理器据以改用 containerPhrasing 的节点类型：照录 mdast-util-phrasing 4.1.0 的 lib/index.js
// （mdast-util-to-markdown 2.1.2 的 lib/handle/root.js 以其 phrasing() 判定），不含 html 与本项目自定义的 underline、
// superscript、subscript
const UPSTREAM_PHRASING_TYPES = new Set([
    'break', 'delete', 'emphasis', 'footnote', 'footnoteReference', 'image', 'imageReference', 'inlineCode',
    'inlineMath', 'link', 'linkReference', 'mdxJsxTextElement', 'mdxTextExpression', 'strong', 'text', 'textDirective',
]);

/**
 * root 的子节点含上游 phrasing 类型时，把全部子节点包进一个 paragraph，返回新树；无须包装时返回原对象，不修改入参。
 * 为何包装：上游 root 处理器（lib/handle/root.js）在子节点含 phrasing 类型时改用 containerPhrasing，把全部子节点当作
 * 一段行内内容拼接，却不进入 paragraph 与 phrasing 语境，「*」「_」「`」「~」「&」「<」、「!」加「[」、行首行尾空白、
 * 反斜杠加换行等只在 phrasing 语境中转义的写法照原样写出，如 [text('*甲*')] 输出「*甲*」、重新解析为强调。root 又不在
 * pruneEmptyInline 的处理范围内，空节点遮住转义语境、数字与记号分属相邻 text、相邻代码段粘连、值为空的代码段写作「``」、
 * 块末硬换行写作「\ + 换行」等问题照样出现，如 [strong(), text('# 标题')] 输出「# 标题」、重新解析为标题，
 * [text('甲'), break] 输出「甲\」加换行、重新解析为文本「甲\」。paragraph 处理器进入 paragraph 与 phrasing 语境、同样
 * 以 containerPhrasing 拼接子节点，包装后的产物与这组子节点放在段落中逐字相同，pruneEmptyInline 也照 paragraph 处理
 * 它们。
 * 对块级子节点的影响：它们仍与行内内容直接拼接、不另起一块（包装前后都如此），但构造栈多出 paragraph 与 phrasing 两层，
 * 处理器经 safe() 写出的部分随之多出只在 phrasing 语境中生效的转义。上游块级处理器中直接调用 safe() 的只有围栏代码
 * （信息串的 lang 与 meta）、定义（标签、地址与标题）与脚注定义（标签）三种，如 [text(甲), code(lang: a*b_c)] 的信息串
 * 由「a*b_c」变为「a\*b\_c」，[text(甲), definition(url: http://x.com)] 的地址由「http://x.com」变为「http\://x.com」；
 * 标题、列表、引用块与表格的内容本就由各自的处理器放进 phrasing 语境，html 块与分隔线不经 safe()，产物不变。
 * 为何在剔除之前包装：是否含 phrasing 类型按剔除前的子节点判定，与修复前上游看到的子节点一致；剔除之后才判定，剔除掉
 * 仅有的 phrasing 节点（如 [paragraph(甲), text(''), paragraph(乙)] 中的空文本）会使 root 改按 containerFlow 渲染，
 * 两个段落由直接拼接改为以空行分隔。phrasing 类型照录上游列表（UPSTREAM_PHRASING_TYPES），子节点不含这些类型的 root
 * 上游按 containerFlow 渲染，不包装。
 * 线性：只对 root 的直属子节点做一次 some()，包装时新建两个对象。
 */
function wrapPhrasingRoot(node) {
    if (!node || node.type !== 'root' || !Array.isArray(node.children) || !node.children.some(isUpstreamPhrasing)) {
        return node;
    }
    return { ...node, children: [{ type: 'paragraph', children: node.children }] };
}

/** 上游 root 处理器是否把该节点认作行内内容（phrasing 类型，见 UPSTREAM_PHRASING_TYPES） */
const isUpstreamPhrasing = (node) => Boolean(node) && UPSTREAM_PHRASING_TYPES.has(node.type);

// ============================================================
// 行内语境：剔除产物为空的节点与值为空的 inlineCode，在数字边界合并相邻 text，分隔相邻的 inlineCode，改写块末硬换行
// ============================================================

// 可含行内子节点的父类型：paragraph / heading / tableCell / link / linkReference 与六种行内格式
const PHRASING_PARENTS = new Set([
    'paragraph', 'heading', 'tableCell', 'strong', 'emphasis', 'delete', 'underline', 'superscript', 'subscript',
    'link', 'linkReference',
]);
// 相邻 inlineCode 之间插入的分隔注释：各版 CommonMark 都认作 HTML 注释的最短写法（<!--> 与 <!---> 自 0.31 起才算）
const CODE_SEPARATOR = '<!---->';
// paragraph 与 heading 末尾的硬换行改写成的行内 HTML：ir/inline-html 把 <br>（不分大小写、可自闭合、可带属性）提升为 break
const HTML_BREAK = '<br>';
// 有序列表记号的组成字符的 charCode：ASCII 数字「0」–「9」与记号「.」「)」
const CHAR_ZERO = '0'.charCodeAt(0);
const CHAR_NINE = '9'.charCodeAt(0);
const CHAR_DOT = '.'.charCodeAt(0);
const CHAR_RIGHT_PAREN = ')'.charCodeAt(0);

/**
 * 剔除行内语境中产物为空的节点与值为空的 inlineCode，在数字边界合并剔除后相邻的 text，在仍相邻的两个 inlineCode
 * 之间插入分隔注释，并把 paragraph 与 heading 末尾连续的 break 并为一个 html 节点，返回新树；子树未变时返回原对象，
 * 不修改入参。
 * 对象与范围：PHRASING_PARENTS 各类型的子节点中，value 为空串的 text 与 html，值为空的 inlineCode，以及子节点剔除
 * 完毕后已无子节点的六种行内格式（EMPTY_CAPABLE_TYPES）；link / linkReference 只剔除其子节点、不剔除自身（产物含
 * 地址，不为空）。子节点含上游 phrasing 类型的 root 已由 wrapPhrasingRoot 把全部子节点包进 paragraph，照 paragraph
 * 处理；其余 root 与 list 等块级父节点的子节点不在范围内。
 * 为何在 stringify 之前剔除：containerPhrasing 只凭紧邻兄弟给出 before / after。前一兄弟产物为空时 before 为空串，
 * 看不到更前的真实字符与段首换行；后一兄弟为空文本时 after 为空串，为无内容的格式节点或空 html 时 after 取其 peek
 * 报出的「*」「~」或「<」；紧接 html 节点之前的行尾换行还会改为空格，html 值为空时同样如此。safe() 据此决定行首
 * 记号、首尾空白、「&」「<」「!」与末尾反斜杠的转义，定界符式格式据此判定能否写定界符，空节点使这些判定落空。
 * 剔除后各节点看到的都是真实邻居，含空节点的 IR 与去掉空节点后的 IR 产物逐字相同。
 * 为何剔除值为空的 inlineCode：其产物并不为空。上游处理器（lib/handle/inline-code.js）以 node.value || '' 取值、以单个
 * 反引号起选围栏，值为空时写出两个反引号「``」；CommonMark 没有空代码段的写法，找不到等长闭围栏的反引号串按字面文本
 * 处理，「``」因而重新解析为文本，原文没有的两个反引号成为可见内容，如 [text(甲), code(''), text(乙)] 输出「甲``乙」；
 * 它还夹在两侧节点之间，使 [text('1'), code(''), text('. 项')] 这类数字与记号不能在数字边界合并。值缺失、为 null 或为
 * 0 时上游同样只写出「``」，剔除只去掉这两个反引号，不丢失 md 产物原有的可见内容。其他渲染器中空代码段也无可见内容，
 * 只限于值为空串：html、docx、xml 渲染器输出无内容的元素或 run，content-list 不产生文本；值缺失、为 null 或为 0 时
 * html 渲染器抛错，值为 0 时 xml 与 content-list 写出「0」。
 * 为何在数字边界合并相邻 text：有序列表记号模式要求「换行 + 可选空白 + 数字 + 记号」同在一个 value 之内，而 safe()
 * 以 before + 本节点文本 + after 为 value 匹配、只转义本节点文本所在区间，containerPhrasing 给 text 的 before 又只有
 * 前一兄弟产物的末字。数字与其后的「.」「)」分属相邻 text 时，前一节点只在 after 里看到记号，记号不在其转义区间内；
 * 后一节点的 before 只有一个数字、没有换行，模式匹配不上；两侧都不转义，位于段首、换行后或硬换行之后时可能重新解析
 * 为有序列表。数字与记号须同处一个节点，safe() 才能匹配到记号前的数字串（模式的 before 为 \d+），故剔除之后，前一段
 * 以 ASCII 数字结尾、后一段以 ASCII 数字或「.」「)」开头时并为一个节点，多段组成的数字串逐段并入；其余转义模式的
 * 前文只需一个字符，containerPhrasing 已能给出。不合并全部相邻 text 的理由：safe() 以 positions.includes 对转义位置
 * 去重，单个 value 内有 p 个转义位置时耗时为 O(p²)；全部合并会把任意相邻 text 中的转义位置集中到一次调用，如 n 个相邻
 * text('*') 由线性变为平方级。只有每个切分点都在数字边界上的文本才会并成一个 value，耗时与同一文本放在单个节点中相同。
 * 切在换行处的两行记号（如 [text('1.'), text(换行 + '1. 项')]）并入同一 value 后，默认「.」「-」「+」模式的 after 会把
 * 行尾换行吃进前一次匹配、下一行的记号不再转义，这曾是另一条理由；LINE_MARKER_UNSAFE 补入前瞻版模式后（见 render），该
 * 形态无论切在何处都转义。合并同样只在 PHRASING_PARENTS 各类型的子节点中进行。
 * 为何插入分隔注释：inlineCode 处理器按值内的反引号串选定围栏长度，containerPhrasing 把相邻产物首尾直接拼接，前一段
 * 的闭围栏与后一段的开围栏并成一个更长的反引号串，不能闭合前一段，重新解析时配对错位，如 [code(x), code(y)] 输出
 * 「`x``y`」、重新解析为单个代码段「x``y」。相邻的反引号总会并成同一串，只调围栏长度分不开，故在两段之间插入值为
 * CODE_SEPARATOR 的 html 节点，输出「`x`<!---->`y`」，重新解析为代码段、html 节点、代码段。插入的位置：只在本层剔除
 * 空节点之后，因此两段之间原有的空节点先被剔除，剔除后相邻的两段同样分隔；只在父节点属 PHRASING_PARENTS 时，与剔除
 * 的范围相同。分隔节点只处在两个 inlineCode 之间，inlineCode 与 html 的处理器都不读 before / after，前一段的产物
 * 以反引号收尾，也不会触发 html 之前的换行改写，故插入不改变其余节点的转义与定界符判定。
 * 为何改写块末硬换行：上游 break 处理器（lib/handle/break.js）在 headingAtx 与 tableCell 等不能含换行的构造中写空格或
 * 空串，其余一律写「\ + 换行」；而 CommonMark 只认块内两行之间的硬换行，段尾的「\ + 换行」重新解析为字面反斜杠（「两个
 * 空格 + 换行」则被删去），如 [text('甲'), break] 输出「甲\」加换行、重新解析为文本「甲\」，[text('甲'), break, break]
 * 只剩一个硬换行加字面反斜杠。heading 末尾的硬换行另有两种丢法：1–2 级标题含 break 时 formatHeadingAsSetext 改走 setext
 * 形式，末尾的「\ + 换行」使下划线长度为 0，[heading2(text('甲'), break)] 输出「甲\」加换行再加空行，标题整个变成带
 * 反斜杠的段落；3 级起走 ATX 形式，break 处理器写空格或空串，[heading3(text('甲'), break)] 输出「### 甲 」，硬换行被
 * 丢弃。块末的硬换行没有 Markdown 写法，故与 underline 等一样写行内 HTML：paragraph 与 heading 的子节点剔除空节点之后，
 * 末尾连续的 k 个 break 并为一个 html 节点，值为 k 个 HTML_BREAK 的拼接（并为一个而不逐个改写的理由见
 * rewriteTrailingBreaks），重新解析为 html 节点后由 ir/inline-html 提升为 break，html、docx、xml、content-list 渲染器都把
 * break 写成各自的换行；改写后 heading 内不再有 break 节点，1–2 级标题只要文本不含换行就回到 ATX 形式。html 的 peek 为
 * 「<」：段落与 setext 形式的标题中，上游 break 产物的首字为「\」，与「<」同属 ASCII 标点，前一兄弟据 after 所作的末尾
 * 反斜杠转义与定界符判定不变；3 级起的标题走 ATX 形式，break 产物为空格或空串，after 改为「<」后定界符判定不变（空格、
 * 空串与「<」都满足 isDelimiterSafe 对后一字的要求，且都不是「*」「~」），末尾的反斜杠则由不转义改为转义，如
 * [heading3(text('甲\'), break)] 由「### 甲\ 」改为「### 甲\\<br>」，不转义时「\<」会使 <br> 成为字面文本。
 * containerPhrasing 在 html 之前把前一兄弟产物末尾的换行改为空格，块末硬换行之前的产物以换行结尾时即触发该规则：
 * [text('甲' + 换行), break] 由「甲」换行「\」换行（重新解析为文本「甲」换行「\」，硬换行丢失）改为「甲 <br>」（重新解
 * 析为文本「甲 」与硬换行），硬换行保住、换行变为空格；前一兄弟为格式节点、链接或行内代码时产物不以换行结尾，不触发该规
 * 则，如 [strong(text('甲' + 换行)), break] 输出「<strong>甲」换行「</strong><br>」。不改的范围：处在块末格式节点或链接
 * 末尾的硬换行，其后紧随闭标签或「](」，重新解析时仍是硬换行（定界符式格式的内容以换行结尾时已由 isDelimiterSafe 回退为
 * 标签）；heading 段中的硬换行仍由上游处理（1–2 级保留 setext 形式，3 级起改为空格）；tableCell 内改为空格。已知限制：
 * 只由一个硬换行构成的段落输出「<br>」独占一行，按 CommonMark 属第 7 类 HTML 块，重新解析为块级 html 节点而非 break；两
 * 个及以上时（「<br><br>」）一行内有两个标签，不构成 HTML 块，仍为段落；heading 有「#」前缀，只由硬换行构成时输出
 * 「## <br>」，仍为标题；块末硬换行之前的产物以换行结尾时，该换行改为空格（见上）。
 * 线性：先递归剔除子节点、再过滤本层，格式节点是否为空只看剔除后的 children 是否为空数组，判定为 O(1)，无须再向
 * 下遍历；每个节点只访问一次。合并相邻 text、插入分隔注释与改写块末硬换行都在过滤后的本层子节点上单趟进行，先合并、
 * 后分隔、再改写：合并只改 text，分隔只在两个 inlineCode 之间插入 html，改写只把末尾的 break 并成一个 html，三者互不
 * 制造对方的处理对象。
 */
function pruneEmptyInline(node) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return node;
    let children = node.children.map(pruneEmptyInline);
    if (PHRASING_PARENTS.has(node.type)) {
        children = separateAdjacentInlineCode(mergeListMarkerText(children.filter((child) => !isPrunedEmpty(child))));
        if (node.type === 'paragraph' || node.type === 'heading') children = rewriteTrailingBreaks(children);
    }
    const changed = children.length !== node.children.length || children.some((child, i) => child !== node.children[i]);
    return changed ? { ...node, children } : node;
}

/**
 * 子节点已剔除完毕的行内节点是否应剔除：text 与 html 看 value 是否为空（产物为空），inlineCode 看 value 是否为空（产物
 * 为「``」，理由见 pruneEmptyInline），六种行内格式看是否已无子节点。三类值节点都以 value 为假判定，与上游 text、html、
 * inlineCode 处理器把缺失或为假的 value 当作空串一致；非字符串的真值由上游转为字符串写出，不在剔除之列
 */
function isPrunedEmpty(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'text' || node.type === 'html' || node.type === 'inlineCode') return !node.value;
    return EMPTY_CAPABLE_TYPES.has(node.type) && (!Array.isArray(node.children) || node.children.length === 0);
}

/**
 * 在数字边界合并相邻的 text 节点，返回新数组；未发生合并时返回原数组，不修改入参。当前一串的末段以 ASCII 数字结尾、
 * 下一个 text 以 ASCII 数字或「.」「)」开头时并入同一串（见 joinsListMarker），多段组成的数字串因而逐段并入；每串以
 * 其中首个节点为底、各段 value 按原次序拼接为新值，其余节点原样保留。理由见 pruneEmptyInline，只由它对
 * PHRASING_PARENTS 各类型剔除空节点后的子节点调用。线性：单趟扫描，首次合并时才建立新数组，每串的各段 value 收集后
 * 一次 join。
 */
function mergeListMarkerText(children) {
    let out = null;
    // 当前一串首个 text 的下标（无则为 -1），以及该串多于一段时的各段 value
    let head = -1;
    let values = null;
    const flush = () => {
        if (out && head >= 0) out.push(values ? { ...children[head], value: values.join('') } : children[head]);
        values = null;
    };
    for (let i = 0; i < children.length; i += 1) {
        const child = children[i];
        // head >= 0 时 children[i - 1] 即当前一串的末段
        if (head >= 0 && isText(child) && joinsListMarker(children[i - 1].value, child.value)) {
            if (!out) out = children.slice(0, head);
            if (!values) values = [children[head].value];
            values.push(child.value);
            continue;
        }
        flush();
        head = isText(child) ? i : -1;
        if (out && head < 0) out.push(child);
    }
    flush();
    return out || children;
}

/** 前一段以 ASCII 数字结尾、后一段以 ASCII 数字或「.」「)」开头：两段拼接后才可能在同一 value 内构成有序列表记号 */
function joinsListMarker(prev, next) {
    if (typeof prev !== 'string' || typeof next !== 'string' || !prev || !next) return false;
    if (!isAsciiDigit(prev.charCodeAt(prev.length - 1))) return false;
    const first = next.charCodeAt(0);
    return isAsciiDigit(first) || first === CHAR_DOT || first === CHAR_RIGHT_PAREN;
}

const isAsciiDigit = (code) => code >= CHAR_ZERO && code <= CHAR_NINE;
const isText = (node) => Boolean(node) && node.type === 'text';

/**
 * 在相邻的两个 inlineCode 之间插入值为 CODE_SEPARATOR 的 html 节点，返回新数组；无相邻时返回原数组，不修改入参。
 * 只由 pruneEmptyInline 对 PHRASING_PARENTS 各类型剔除空节点后的子节点调用。线性：单趟扫描，逐对比较相邻两项。
 */
function separateAdjacentInlineCode(children) {
    let out = null;
    for (let i = 1; i < children.length; i += 1) {
        if (isInlineCode(children[i - 1]) && isInlineCode(children[i])) {
            if (!out) out = children.slice(0, i);
            out.push({ type: 'html', value: CODE_SEPARATOR });
        }
        if (out) out.push(children[i]);
    }
    return out || children;
}

const isInlineCode = (node) => Boolean(node) && node.type === 'inlineCode';

/**
 * 把块末连续的 k 个 break 并为一个 html 节点（值为 k 个 HTML_BREAK 的拼接），返回新数组；末尾没有 break 时返回原数组，
 * 不修改入参。只由 pruneEmptyInline 对 paragraph 与 heading 剔除空节点后的子节点调用。
 * 为何并为一个节点而不逐个改写：上游 heading 处理器先经 formatHeadingAsSetext 判定是否改走 setext 形式，该函数用
 * unist-util-visit 遍历标题的子节点，遇到 break 或 value 含换行的节点即退出；unist-util-visit 的 overload 对每个访问到的
 * 节点调用 parent.children.indexOf(node) 取下标，遍历 k 个不含换行的子节点耗时为 O(k²)。逐个改写会把末尾 k 个 break
 * （遍历原本在首个 break 处退出）换成 k 个 html 节点，遍历不再提前退出，标题末尾硬换行的耗时因而成平方级；并为一个节点
 * 后标题只多一个子节点，耗时线性于换行个数。段落不经此判定，两种写法都线性。产物逐字相同：html 处理器直出 value，peek
 * 恒报「<」，一个节点与 k 个节点拼接出的字符串一样。线性：自末尾回扫到首个非 break 节点，复制一次，值由 repeat 一次生成。
 */
function rewriteTrailingBreaks(children) {
    let end = children.length;
    while (end > 0 && isBreak(children[end - 1])) end -= 1;
    if (end === children.length) return children;
    return [...children.slice(0, end), { type: 'html', value: HTML_BREAK.repeat(children.length - end) }];
}

const isBreak = (node) => Boolean(node) && node.type === 'break';

// ============================================================
// 图片：带显示尺寸的输出为 <img>
// ============================================================

function displayImagesToHtml(node) {
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'image') {
        const width = displayWidth(node);
        if (!width || !node.url) return node;
        const alt = typeof node.alt === 'string' ? node.alt : '';
        return { type: 'html', value: `<img src="${escapeAttr(node.url)}" width="${width}" alt="${escapeAttr(alt)}">` };
    }
    if (!Array.isArray(node.children)) return node;
    const children = node.children.map(displayImagesToHtml);
    return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
}

// 校验后的 width 属性值：px 为 1–99999 的整数，百分比为 (0, 100]；不合规返回空串
function displayWidth(node) {
    const display = node.data && node.data.display;
    if (!display || !Number.isFinite(display.width) || display.width <= 0) return '';
    if (display.unit === '%') return display.width <= MAX_PERCENT ? `${display.width}%` : '';
    const px = String(Math.round(display.width));
    return PX_RE.test(px) ? px : '';
}

function escapeAttr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================
// 行内格式处理器
// ============================================================

// 定界符式格式按 construct 计的祖先层数：以 state 为键存于模块级 WeakMap，不给 state 挂新属性，随 state 一并回收
const ATTENTION_DEPTHS = new WeakMap();
// 行内节点产物是否为空的记忆表：同样以 state 为键，值为「节点 → 布尔值」的 WeakMap
const EMPTY_OUTPUTS = new WeakMap();
// 内容为空时处理器返回空串的行内格式节点类型（即 HANDLERS 中的六种）；isPrunedEmpty 与 isEmptyOutput 共用
const EMPTY_CAPABLE_TYPES = new Set(['strong', 'emphasis', 'delete', 'underline', 'superscript', 'subscript']);

/**
 * 定界符式格式（** / * / ~~）：两侧 flanking 安全、不与相邻兄弟粘连且不处在同类型祖先之内时写定界符，
 * 否则写 HTML 标签。
 * 安全条件：内容首尾不是空白、不是定界符字符；首字是标点时前一字须为空白或标点（或行首），
 * 尾字是标点时后一字须为空白或标点（或行尾）。
 * 粘连：外侧字符来自相邻兄弟且与本定界符是同一字符（前一兄弟的产物以它收尾，或后一兄弟的 peek 报出它）时，
 * 两对定界符会并成一个定界符串：合并后的星号串按整串两侧字符判定能否开合，并按剩余长度套用「3 的倍数」规则，
 * 配对因而错位；波浪号串长于两个即不算定界符。重新解析都会残留字面字符，故同样写标签。
 * peek 恒报定界符字符，因此相邻两对中先出现的一方回退标签，后一方的前一字变为「>」，仍可写定界符。
 * 相邻兄弟的产物为空时，containerPhrasing 看不到更远的真实邻居，粘连与 flanking 都无从判定，同样写标签：
 * 前侧以 before 为空串识别；后侧的空文本使 after 为空串，无内容的格式节点与空 html 的 peek 却仍报非空字符，
 * 故直接判定后一兄弟的产物是否为空。render() 已先行剔除行内语境中产物为空的节点（pruneEmptyInline），这两条
 * 规则在常规 IR 中不再触发，保留作兜底，仍可达的情形见 isGluedToSibling。peek 不改报空串：peek 同时充当前一
 * 兄弟文本节点的 after，safe() 据此决定末尾反斜杠是否转义，改报空串会使以反斜杠结尾的文本失去转义。
 * 不同定界符字符（* 与 ~）不会并成同一串，不作粘连判定；首个子节点的前侧与末个子节点的后侧来自父级，
 * 父级已按内容首末字符是否为自身定界符字符自行回退，同样不作粘连判定。
 * 同类型嵌套：同类定界符嵌套时，内层定界符两侧都不是空白即可能兼具左右 flanking，从而与外层配对
 * （如 *甲*乙*丙* 重新解析为 emphasis(甲)、乙、emphasis(丙)），故处在同类型祖先之内的节点一律写标签。
 * 按 construct 判定，strong 与 emphasis 互相嵌套不在此列；祖先层数在 containerPhrasing 之前加一、之后恢复。
 */
function attention(marker, tag, construct) {
    const handler = (node, parent, state, info) => {
        // 下标取自 state.indexStack 栈顶，须在 containerPhrasing 压栈之前读取
        const glued = isGluedToSibling(node, parent, state, info, marker[0]);
        const depths = attentionDepths(state);
        const depth = depths.get(construct) || 0;
        const exit = state.enter(construct);
        depths.set(construct, depth + 1);
        let inner;
        try {
            inner = state.containerPhrasing(node, { ...info, before: marker[0], after: marker[0] });
        } finally {
            depths.set(construct, depth);
        }
        exit();
        if (!inner) return '';
        return !glued && depth === 0 && isDelimiterSafe(info.before, inner, info.after, marker[0])
            ? `${marker}${inner}${marker}`
            : `<${tag}>${inner}</${tag}>`;
    };
    handler.peek = () => marker[0];
    return handler;
}

/** 本次序列化（以 state 区分）的祖先层数表：construct → 层数，首次访问时建立 */
function attentionDepths(state) {
    let depths = ATTENTION_DEPTHS.get(state);
    if (!depths) {
        depths = new Map();
        ATTENTION_DEPTHS.set(state, depths);
    }
    return depths;
}

/**
 * 外侧字符是否来自相邻兄弟且等于本定界符字符：非首个子节点比 info.before 的末字（前一兄弟产物的末个码元），
 * 非末个子节点比 info.after 的首字（后一兄弟 peek 结果的首个码元，无 peek 的节点取其处理器产物）。
 * 相邻兄弟的产物为空时同样视为粘连：containerPhrasing 看不到更远的真实邻居，粘连与 flanking 都无从判定，故保守
 * 回退。before 侧的空文本、无内容的格式节点与空 html 都使 before 为空串；after 侧只有无 peek 的空文本使 after
 * 为空串，无内容的格式节点与空 html 的 peek 仍报非空字符，故在两项字符比较之后再以 isEmptyOutput 直接判定
 * 后一兄弟的产物是否为空。
 * render() 已先行剔除 paragraph、heading、tableCell、行内格式与链接中产物为空的子节点（pruneEmptyInline），子节点
 * 含上游 phrasing 类型的 root 也已把全部子节点包进 paragraph（wrapPhrasingRoot），这两侧的空邻居判定在常规 IR 中不再
 * 触发，保留作兜底。仍可达的情形有二：其一，表格单元格中前一字为空白的硬换行产物为空串，不属剔除对象，其后格式节点的
 * before 为空串，由前侧回退，如单元格 [text(甲 ), break, strong(乙)] 输出「甲 <strong>乙</strong>」；其二，列表项、
 * 引用块等以 containerFlow 渲染子节点的块级容器直接挂行内节点时不在剔除范围内，其子节点的 before / after 恒为换行，
 * 后一兄弟产物为空时由 isEmptyOutput 回退，如列表项 [strong(甲), text('')] 输出「- <strong>甲</strong>」。
 * 下标取 state.indexStack 栈顶（containerPhrasing 调用子节点处理器前写入）；parent 缺失或栈顶不指向本节点时
 * 两侧都不判定。
 */
function isGluedToSibling(node, parent, state, info, markerChar) {
    const siblings = parent && Array.isArray(parent.children) ? parent.children : null;
    const stack = state.indexStack;
    const index = Array.isArray(stack) ? stack[stack.length - 1] : -1;
    if (!siblings || siblings[index] !== node) return false;
    const before = String(info.before || '');
    const after = String(info.after || '');
    if (index > 0 && (before === '' || before.slice(-1) === markerChar)) return true;
    if (index >= siblings.length - 1) return false;
    return after === '' || after.charAt(0) === markerChar || isEmptyOutput(siblings[index + 1], state);
}

/**
 * 行内节点的产物是否为空：text 与 html 以 value 是否为空串判定；strong / emphasis / delete / underline /
 * superscript / subscript 在全部子节点产物为空时为空（无 children 视同为空），与各自处理器在内容为空时返回空串
 * 一致；其余类型一律视为非空。常规 IR 中产物为空的行内节点已由 pruneEmptyInline 剔除，本函数只在剔除范围之外
 * （如列表项、引用块直接挂行内节点）才会判为空，保留作 isGluedToSibling 后侧的兜底。
 * 格式节点的判定结果按 state 分表记忆化：一次序列化中每个格式节点至多判定一次，每次只遍历直属子节点，整体线性于
 * 节点数。不记忆化时，若深链的每层都是「产物为空的定界符式格式节点 + 下一层」，每层都要沿链下探到首个非空节点，
 * 耗时随深度平方增长。
 */
function isEmptyOutput(node, state) {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'text' || node.type === 'html') return !node.value;
    if (!EMPTY_CAPABLE_TYPES.has(node.type)) return false;
    const memo = emptyOutputs(state);
    if (memo.has(node)) return memo.get(node);
    const empty = !Array.isArray(node.children) || node.children.every((child) => isEmptyOutput(child, state));
    memo.set(node, empty);
    return empty;
}

/** 本次序列化（以 state 区分）的产物为空记忆表：节点 → 布尔值，首次访问时建立 */
function emptyOutputs(state) {
    let memo = EMPTY_OUTPUTS.get(state);
    if (!memo) {
        memo = new WeakMap();
        EMPTY_OUTPUTS.set(state, memo);
    }
    return memo;
}

function isDelimiterSafe(before, inner, after, markerChar) {
    const chars = Array.from(inner);
    const first = chars[0];
    const last = chars[chars.length - 1];
    if (!first || !last || first === markerChar || last === markerChar) return false;
    if (isWhitespace(first) || isWhitespace(last)) return false;
    const prev = Array.from(String(before || '')).pop() || '';
    const next = Array.from(String(after || ''))[0] || '';
    if (isPunctuation(first) && prev && !isWhitespace(prev) && !isPunctuation(prev)) return false;
    if (isPunctuation(last) && next && !isWhitespace(next) && !isPunctuation(next)) return false;
    return true;
}

const isWhitespace = (char) => WHITESPACE_RE.test(char);
const isPunctuation = (char) => PUNCTUATION_RE.test(char);

/** Markdown 无对应语法的行内格式（下划线、上下标）：一律输出同名 HTML 标签，往返解析后仍是同一节点 */
function htmlTag(tag) {
    const handler = (node, _parent, state, info) => {
        const inner = state.containerPhrasing(node, { ...info, before: '>', after: '<' });
        return inner ? `<${tag}>${inner}</${tag}>` : '';
    };
    handler.peek = () => '<';
    return handler;
}

const HANDLERS = Object.freeze({
    strong: attention('**', 'strong', 'strong'),
    emphasis: attention('*', 'em', 'emphasis'),
    delete: attention('~~', 'del', 'strikethrough'),
    underline: htmlTag('u'),
    superscript: htmlTag('sup'),
    subscript: htmlTag('sub'),
});

module.exports = { render, isDelimiterSafe };
