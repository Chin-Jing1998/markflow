/**
 * 段内内容的中间表示（runs）：mdast 行内节点 → 扁平片段 → DTD 行内元素
 *
 * run 形态：
 *   { kind: 'text', text, marks: Set<'b'|'i'|'u'|'sup'|'sub'> }
 *   { kind: 'br' }                      软换行 → <br/>
 *   { kind: 'image', node }             图片（附图、栅格化的表格/公式）
 *   { kind: 'math', node }              未栅格化的公式
 *   { kind: 'element', node }           已构造好的 builder 节点（claim-ref / figref 等，由 splitText 产生）
 * 扁平表示便于三件事：剥离段首编号（前缀可能跨越加粗片段）、判断整段加粗/斜体、在未加标记的文本上
 * 包裹 claim-ref / figref（二者在 DTD 中只能直接位于 claim-text / p 之下，不能嵌在 b/i 内）。
 * docx 经 mammoth → turndown 链路后，上下标与下划线以 html 节点（<sub>、</sub>…）成对出现，此处按
 * 开闭标记维护当前标记集，使其还原为 DTD 的 sub / sup / u 元素。
 */
const { stripHtml } = require('../../ir/util');

// 元素嵌套顺序（外 → 内）
const MARK_ORDER = Object.freeze(['b', 'i', 'u', 'sup', 'sub']);
const HTML_TAG_RE = /^<(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?>$/;
const HTML_MARKS = Object.freeze({ b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', sup: 'sup', sub: 'sub' });
const SOFT_BREAK_RE = /[ \t]*\n[ \t]*/g;
// 汉字、全角标点两侧的软换行直接删除，其余换成空格
const CJK_RE = /[⺀-⿿　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;

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
        if (list[i].kind === 'text') { list[i] = textRun(list[i].text.replace(/\s+$/, ''), list[i].marks); break; }
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

/**
 * 在未加标记的文本片段上按正则切分：每个匹配交给 wrap(match) 生成 builder 节点（或节点与字符串的数组），
 * 返回 null 则保留原文。
 */
function splitText(runs, regex, wrap) {
    const pattern = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
    const out = [];
    for (const run of runs) {
        if (run.kind !== 'text' || run.marks.size > 0) { out.push(run); continue; }
        let cursor = 0;
        for (const match of run.text.matchAll(pattern)) {
            const produced = wrap(match);
            if (!produced) continue;
            if (match.index > cursor) out.push(textRun(run.text.slice(cursor, match.index), run.marks));
            for (const item of Array.isArray(produced) ? produced : [produced]) {
                out.push(typeof item === 'string' ? textRun(item, run.marks) : { kind: 'element', node: item });
            }
            cursor = match.index + match[0].length;
        }
        if (cursor < run.text.length) out.push(textRun(run.text.slice(cursor), run.marks));
    }
    return out;
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
    flattenInline, runsText, trimRuns, stripPrefix, isWholeMark, withoutMark, splitText, emitRuns, textRun, MARK_ORDER,
};
