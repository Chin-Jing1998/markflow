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
 *   - 产物为空的行内节点（空文本、空 html、内容为空的六种行内格式）在 stringify 之前从 paragraph、heading、
 *     tableCell、行内格式与链接的子节点中剔除：空节点会遮住相邻节点的 before / after 与 peek 语境，使行首记号、
 *     首尾空白、末尾反斜杠等的转义与定界符的判定落空；剔除后含空节点的 IR 与去掉空节点后的 IR 产物逐字相同
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

async function render(doc) {
    const { unified, remarkStringify, remarkGfm } = await loadUnified();
    const prepared = displayImagesToHtml(applyTextLayout(stripMarkersTree(doc.ir)));
    const downgraded = pruneEmptyInline(downgradeCustomNodes(wrapMath(prepared)));
    const result = unified()
        .use(remarkGfm)
        .use(remarkStringify, { ...MD_OPTIONS, handlers: HANDLERS })
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
// 行内语境：剔除产物为空的节点
// ============================================================

// 可含行内子节点的父类型：paragraph / heading / tableCell / link / linkReference 与六种行内格式
const PHRASING_PARENTS = new Set([
    'paragraph', 'heading', 'tableCell', 'strong', 'emphasis', 'delete', 'underline', 'superscript', 'subscript',
    'link', 'linkReference',
]);

/**
 * 剔除行内语境中产物为空的节点，返回新树；子树未变时返回原对象，不修改入参。
 * 对象与范围：PHRASING_PARENTS 各类型的子节点中，value 为空串的 text 与 html，以及子节点剔除完毕后已无子节点的
 * 六种行内格式（EMPTY_CAPABLE_TYPES）；link / linkReference 只剔除其子节点、不剔除自身（产物含地址，不为空）；
 * root、list 等块级父节点的子节点不在范围内。
 * 为何在 stringify 之前剔除：containerPhrasing 只凭紧邻兄弟给出 before / after。前一兄弟产物为空时 before 为空串，
 * 看不到更前的真实字符与段首换行；后一兄弟为空文本时 after 为空串，为无内容的格式节点或空 html 时 after 取其 peek
 * 报出的「*」「~」或「<」；紧接 html 节点之前的行尾换行还会改为空格，html 值为空时同样如此。safe() 据此决定行首
 * 记号、首尾空白、「&」「<」「!」与末尾反斜杠的转义，定界符式格式据此判定能否写定界符，空节点使这些判定落空。
 * 剔除后各节点看到的都是真实邻居，含空节点的 IR 与去掉空节点后的 IR 产物逐字相同。
 * 线性：先递归剔除子节点、再过滤本层，格式节点是否为空只看剔除后的 children 是否为空数组，判定为 O(1)，无须再向
 * 下遍历；每个节点只访问一次。
 */
function pruneEmptyInline(node) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return node;
    let children = node.children.map(pruneEmptyInline);
    if (PHRASING_PARENTS.has(node.type)) children = children.filter((child) => !isPrunedEmpty(child));
    const changed = children.length !== node.children.length || children.some((child, i) => child !== node.children[i]);
    return changed ? { ...node, children } : node;
}

/** 子节点已剔除完毕的行内节点是否产物为空：text 与 html 看 value 是否为空串，六种行内格式看是否已无子节点 */
function isPrunedEmpty(node) {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'text' || node.type === 'html') return !node.value;
    return EMPTY_CAPABLE_TYPES.has(node.type) && (!Array.isArray(node.children) || node.children.length === 0);
}

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
 * render() 已先行剔除 paragraph、heading、tableCell、行内格式与链接中产物为空的子节点（pruneEmptyInline），这两侧
 * 的空邻居判定在常规 IR 中不再触发，保留作兜底。仍可达的情形有二：其一，表格单元格中前一字为空白的硬换行产物为
 * 空串，不属剔除对象，其后格式节点的 before 为空串，由前侧回退，如单元格 [text(甲 ), break, strong(乙)] 输出
 * 「甲 <strong>乙</strong>」；其二，root 直接挂行内节点时不在剔除范围内，[strong(甲), text('')] 由 after 为空串
 * 回退，[strong(甲), delete()] 由 isEmptyOutput 回退，均输出「<strong>甲</strong>」。
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
 * （如 root 直接挂行内节点）才会判为空，保留作 isGluedToSibling 后侧的兜底。
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
