/**
 * 段内内容的中间表示（runs）：mdast 行内节点 → 扁平片段 → DTD 行内元素
 *
 * run 形态：
 *   { kind: 'text', text, marks: Set<'b'|'i'|'u'|'sup'|'sub'> }
 *   { kind: 'br' }                      软换行 → <br/>
 *   { kind: 'image', node }             图片（附图、栅格化的表格/公式）
 *   { kind: 'math', node }              未栅格化的公式
 *   { kind: 'element', node }           已构造好的 builder 节点，由 emitRuns 原样放行
 * 扁平表示便于两件事：剥离段首编号（前缀可能跨越加粗片段）、判断整段加粗/斜体。
 * 下划线与上下标在 IR 中已是 underline / superscript / subscript 节点（ir/inline-html 从 <u>/<sup>/<sub>
 * 提升），此处转成 u / sup / sub 标记；未被提升而以成对 html 节点残留的（<sub>、</sub>…）按开闭标记
 * 维护当前标记集，走同一条兜底路径，最终都还原为 DTD 的 u / sup / sub 元素。
 */
const { stripHtml } = require('../../ir/util');

// 元素嵌套顺序（外 → 内）
const MARK_ORDER = Object.freeze(['b', 'i', 'u', 'sup', 'sub']);
const HTML_TAG_RE = /^<(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?>$/;
const HTML_MARKS = Object.freeze({ b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', sup: 'sup', sub: 'sub' });
// 软换行：换行及其后紧邻的空格与制表符。首字符即必需的换行，非换行位置一步即弃，尾部的贪婪量词后无后续项、不回溯；
// 紧邻换行之前的空格与制表符不写进正则，改由 joinSoftBreaks 向前回看并入——写成前导的 [ \t]* 时，不以换行结尾的
// 长空格制表符段上每个起点都要吞到段尾、再因缺换行逐位回退而失败，耗时随段长平方增长
const SOFT_BREAK_RE = /\n[ \t]*/g;
// 汉字、全角标点两侧的软换行直接删除，其余换成空格
// 汉字、全角标点：与 parsers/xml/inline.js 的 CJK_RANGES 同一范围，两份须同步修改。按码点声明——首个区间端点 U+3000 不可见，
// 兼容表意字与常用字字形相同，写成字面量无从分辨。
// 末项 U+20000–U+3FFFF 为第 2、3 平面整段，据 Unicode 官方路线图（2026 年版）整段计为汉字：第 2 平面 SIP 专收中日韩统一表意文字
// 扩展 B、C、D、E、F、I，兼容表意文字补充与统一表意文字部件 A、B（https://www.unicode.org/roadmaps/sip/）；第 3 平面 TIP 专收
// 扩展 G、H、J 与篆书（https://www.unicode.org/roadmaps/tip/）；两个平面都不收其他文字。第 1 平面的西夏文、女书、表情符号等不计入
const CJK_RANGES = Object.freeze([
    [0x2E80, 0x2FFF], [0x3000, 0x303F], [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xF900, 0xFAFF], [0xFF00, 0xFFEF], [0x20000, 0x3FFFF],
]);
// 按码点做数值判定。原先由 String.fromCharCode 拼成的字符类不带 u 标志、逐个 UTF-16 码元比对，写不出增补平面的区间；
// BMP 码点的判定与原字符类逐一相同——前六项未变，末项只含大于 0xFFFF 的码点
const isCjkCodePoint = (codePoint) => CJK_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
// 一个完整字符（单个码元或一对代理）是否为汉字、全角标点；空串（串首、串尾，即没有字符）不是
const isCjkChar = (char) => char !== '' && isCjkCodePoint(char.codePointAt(0));

const textRun = (text, marks) => ({ kind: 'text', text, marks: new Set(marks) });

/** mdast 行内子节点 → runs */
function flattenInline(children) {
    const runs = [];
    const state = { htmlMarks: new Set() };
    walk(Array.isArray(children) ? children : [], new Set(), state, runs);
    return mergeText(runs);
}

function walk(nodes, marks, state, runs) {
    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const current = () => new Set([...marks, ...state.htmlMarks]);
        switch (node.type) {
            case 'text':
                runs.push(textRun(joinSoftBreaks(node.value), current()));
                break;
            case 'strong': walk(node.children || [], new Set([...marks, 'b']), state, runs); break;
            case 'emphasis': walk(node.children || [], new Set([...marks, 'i']), state, runs); break;
            case 'underline': walk(node.children || [], new Set([...marks, 'u']), state, runs); break;
            case 'superscript': walk(node.children || [], new Set([...marks, 'sup']), state, runs); break;
            case 'subscript': walk(node.children || [], new Set([...marks, 'sub']), state, runs); break;
            case 'inlineCode': runs.push(textRun(String(node.value == null ? '' : node.value), current())); break;
            case 'break': runs.push({ kind: 'br' }); break;
            case 'image': runs.push({ kind: 'image', node }); break;
            case 'math': runs.push({ kind: 'math', node }); break;
            case 'html': handleHtml(node, state, runs, current); break;
            case 'footnoteReference': break;
            default:
                if (Array.isArray(node.children)) walk(node.children, marks, state, runs);
                else if (node.value !== undefined && node.value !== null) runs.push(textRun(joinSoftBreaks(node.value), current()));
        }
    }
}

// <sub>…</sub> 一类成对标签只切换标记集；<br> 成软换行；其余标签去标签后保留文本
function handleHtml(node, state, runs, current) {
    const raw = typeof node.value === 'string' ? node.value.trim() : '';
    const match = HTML_TAG_RE.exec(raw);
    if (match) {
        const tag = match[2].toLowerCase();
        if (tag === 'br') { runs.push({ kind: 'br' }); return; }
        const mark = HTML_MARKS[tag];
        if (mark) {
            if (match[1]) state.htmlMarks.delete(mark);
            else state.htmlMarks.add(mark);
            return;
        }
    }
    const text = stripHtml(raw);
    if (text) runs.push(textRun(text, current()));
}

/**
 * 软换行合并：每段「换行及其前后紧邻的空格与制表符」两侧都是汉字或全角标点时删除，否则换成一个空格。
 *
 * SOFT_BREAK_RE 只匹配换行及其后的空格制表符，紧邻换行之前的极大空格制表符段在此逐段向前回看并入，回看不越过上一段的
 * 结束位置。所得各段与旧写法（前导 [ \t]* + 换行 + [ \t]*）的各次匹配逐字相同：设 cursor 为上一段的结束位置、q 为
 * 不小于 cursor 的首个换行。自 q 起即可匹配，故旧匹配的起点不晚于 q；其换行若落在 q 之后，q 便落在前导段内而须为空格或
 * 制表符，与 q 处是换行矛盾，故其换行正是 q，起点为 cursor 与「q 之前极大空格制表符段的起点」二者中的较大者，即回看
 * 所得；尾部同为贪婪的 [ \t]*，段终点也相同，传给判定的前后字符因而相同。尾部不含换行，连续换行拆成多段：如 'x\n \ny'
 * 的第二段起于第二个换行，其前一位的空格已归第一段，回看须在此止步。各段回看扫过的区间互不重叠，总成本线性于串长。
 *
 * 两侧字符按完整码点取（charEndingAt、charStartingAt），串首、串尾为空串、不算汉字。增补平面的汉字在 UTF-16 串里是一对代理，
 * 原先按码元取 whole[start - 1] 与 whole[end]，换行前只取到低代理、换行后只取到高代理，都判为非汉字，于是多出一个空格。新取法
 * 只在一侧是成对代理时与按码元取不同，而成对代理的码点不在 U+20000–U+3FFFF 时仍判为非汉字；BMP 字符与孤立代理照旧取该码元，
 * 判定与改动前逐一相同。因此结果只在一侧是增补平面汉字时改变；上段所证的逐字等价就段的划分与回看而言依然成立
 */
function joinSoftBreaks(value) {
    const whole = String(value == null ? '' : value);
    const pieces = [];
    let cursor = 0;
    for (const match of whole.matchAll(SOFT_BREAK_RE)) {
        let start = match.index;
        while (start > cursor && (whole[start - 1] === ' ' || whole[start - 1] === '\t')) start -= 1;
        const end = match.index + match[0].length;
        const before = charEndingAt(whole, start);
        const after = charStartingAt(whole, end);
        pieces.push(whole.slice(cursor, start), isCjkChar(before) && isCjkChar(after) ? '' : ' ');
        cursor = end;
    }
    pieces.push(whole.slice(cursor));
    return pieces.join('');
}

// 段两侧的完整字符，串首、串尾为空串，与 parsers/xml/inline.js 的同名函数相同。charEndingAt 取止于下标 index 的字符：前一位是
// 低代理、再前一位是高代理时二者合为一个码点，否则取前一位的码元；charStartingAt 取始于 index 的字符：codePointAt 在高代理后接
// 低代理处得整个码点，否则得该码元。孤立代理因而照旧按单个码元判定，不算汉字
function charEndingAt(whole, index) {
    if (index <= 0) return '';
    const paired = index >= 2 && isLowSurrogate(whole.charCodeAt(index - 1)) && isHighSurrogate(whole.charCodeAt(index - 2));
    return whole.slice(paired ? index - 2 : index - 1, index);
}

function charStartingAt(whole, index) {
    if (index >= whole.length) return '';
    return whole.slice(index, index + (whole.codePointAt(index) > 0xFFFF ? 2 : 1));
}

const isHighSurrogate = (unit) => unit >= 0xD800 && unit <= 0xDBFF;
const isLowSurrogate = (unit) => unit >= 0xDC00 && unit <= 0xDFFF;

// 相邻且标记相同的文本片段合并
function mergeText(runs) {
    const out = [];
    for (const run of runs) {
        const last = out[out.length - 1];
        if (run.kind === 'text' && last && last.kind === 'text' && sameMarks(last.marks, run.marks)) {
            out[out.length - 1] = textRun(last.text + run.text, last.marks);
        } else {
            out.push(run);
        }
    }
    return out;
}

const sameMarks = (a, b) => a.size === b.size && [...a].every((mark) => b.has(mark));

// ============================================================
// 查询与变换（均返回新数组，不改动入参）
// ============================================================

/** 文本片段拼接（图片、公式、换行不计） */
function runsText(runs) {
    return runs.filter((run) => run.kind === 'text').map((run) => run.text).join('');
}

/** 去掉首尾空白、删除空文本片段；首尾的软换行一并去掉 */
function trimRuns(runs) {
    let list = runs.map((run) => (run.kind === 'text' ? textRun(run.text, run.marks) : run));
    const first = list.findIndex((run) => run.kind === 'text');
    if (first >= 0) list[first] = textRun(list[first].text.replace(/^\s+/, ''), list[first].marks);
    for (let i = list.length - 1; i >= 0; i -= 1) {
        // 尾部空白用 trimEnd 去除：它删的正是 \s 所指的 WhiteSpace 与 LineTerminator 两类字符，而 /\s+$/
        // 在不处于串尾的长空白段上从每个起点都吃到段尾再逐位回溯，耗时随段长平方增长
        if (list[i].kind === 'text') { list[i] = textRun(list[i].text.trimEnd(), list[i].marks); break; }
    }
    list = list.filter((run) => !(run.kind === 'text' && run.text === ''));
    // 首尾的软换行：先求首个非软换行片段的下标 start（没有则为长度），再自尾向前求末个非软换行片段的下标加一 end
    // （下限为 start），只切片一次。逐个 slice 的旧写法每删一个就复制整个数组，首尾各 N 个软换行时复制量随 N 平方增长；
    // 下标法每个片段至多看一次，线性于片段数。二者删去的是同一段：旧写法第一个循环删去极大软换行前缀、第二个循环删去
    // 余下部分的极大软换行后缀，下标法求出的边界相同；全为软换行时旧写法第一个循环删光、第二个循环不执行，下标法
    // start 等于长度、end 取下限 start，结果同为空数组。两式都返回新数组，不改动入参
    let start = 0;
    while (start < list.length && list[start].kind === 'br') start += 1;
    let end = list.length;
    while (end > start && list[end - 1].kind === 'br') end -= 1;
    return list.slice(start, end);
}

/**
 * 从 runs 的开头文本剥离正则匹配的前缀（前缀可跨越多个文本片段）。
 * @returns {{ match: RegExpExecArray | null, runs }}
 */
function stripPrefix(runs, regex) {
    const match = new RegExp(regex.source, regex.flags.replace('g', '')).exec(runsText(runs));
    if (!match || match.index !== 0) return { match: null, runs };
    let remaining = match[0].length;
    const out = [];
    for (const run of runs) {
        if (remaining <= 0 || run.kind !== 'text') { out.push(run); continue; }
        if (run.text.length <= remaining) { remaining -= run.text.length; continue; }
        out.push(textRun(run.text.slice(remaining), run.marks));
        remaining = 0;
    }
    return { match, runs: trimRuns(out) };
}

/** 所有非空白文本片段都带有该标记（且至少有一个） */
function isWholeMark(runs, mark) {
    const texts = runs.filter((run) => run.kind === 'text' && run.text.trim() !== '');
    return texts.length > 0 && texts.every((run) => run.marks.has(mark));
}

function withoutMark(runs, mark) {
    return mergeText(runs.map((run) => (run.kind === 'text' ? textRun(run.text, [...run.marks].filter((item) => item !== mark)) : run)));
}

// ============================================================
// 输出为 builder 子节点
// ============================================================

/**
 * runs → builder 子节点数组。handlers.image(node) / handlers.math(node) 返回 builder 节点、字符串或 null；
 * br 由 handlers.br() 生成（缺省 <br/>）。带标记的文本按 MARK_ORDER 嵌套为 b / i / u / sup / sub。
 */
function emitRuns(runs, el, handlers = {}) {
    const out = [];
    for (const run of runs) {
        if (run.kind === 'text') { out.push(wrapMarks(run.text, run.marks, el)); continue; }
        if (run.kind === 'br') { out.push(handlers.br ? handlers.br() : el('br')); continue; }
        if (run.kind === 'element') { out.push(run.node); continue; }
        const handler = handlers[run.kind];
        const result = handler ? handler(run.node) : null;
        if (result !== null && result !== undefined && result !== '') out.push(result);
    }
    return out;
}

function wrapMarks(text, marks, el) {
    const ordered = MARK_ORDER.filter((mark) => marks.has(mark));
    return ordered.reduceRight((inner, mark) => el(mark, {}, [inner]), text);
}

module.exports = {
    flattenInline, runsText, trimRuns, stripPrefix, isWholeMark, withoutMark, emitRuns, textRun, MARK_ORDER,
};
