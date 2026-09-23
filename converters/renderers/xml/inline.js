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
const SOFT_BREAK_RE = /[ \t]*\n[ \t]*/g;
// 汉字、全角标点两侧的软换行直接删除，其余换成空格
// 汉字、全角标点：与 parsers/xml/inline.js 的 CJK_RANGES 同一范围。按码点声明——首个区间端点 U+3000 不可见，
// 兼容表意字与常用字字形相同，写成字面量无从分辨
const CJK_RANGES = Object.freeze([[0x2E80, 0x2FFF], [0x3000, 0x303F], [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xF900, 0xFAFF], [0xFF00, 0xFFEF]]);
const CJK_RE = new RegExp(`[${CJK_RANGES.map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('')}]`);

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

function joinSoftBreaks(value) {
    return String(value == null ? '' : value).replace(SOFT_BREAK_RE, (match, offset, whole) => {
        const before = whole[offset - 1] || '';
        const after = whole[offset + match.length] || '';
        return CJK_RE.test(before) && CJK_RE.test(after) ? '' : ' ';
    });
}

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
    while (list.length && list[0].kind === 'br') list = list.slice(1);
    while (list.length && list[list.length - 1].kind === 'br') list = list.slice(0, -1);
    return list;
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
