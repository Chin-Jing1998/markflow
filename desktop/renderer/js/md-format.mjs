/**
 * Markdown 源码编辑的纯函数（渲染层与 Node 测试共用，无 DOM 依赖）
 *
 * 输入状态 state = { value, start, end }：textarea 的全文与选区（start ≤ end 不作要求，内部归一）。
 * 输出编辑 edit  = { from, to, text, selStart, selEnd }：把 value[from, to) 换成 text，
 *   随后选区置为新文本中的 [selStart, selEnd]。编辑器据此 setSelectionRange + execCommand('insertText')，保留撤销栈。
 *
 *   toggleInline(state, open, close?)   行内标记切换：** * ~~ ` <u></u>。选区自带或紧贴标记则去掉，否则加上：
 *                                        首尾空白挪到标记外，多行逐行包裹（跳过列表 / 引用 / 标题前缀），
 *                                        空选区插入一对标记并把光标放中间；判断 * 时排除 **（按星号连续数的奇偶判定）
 *   lineStyleAt(value, pos)             → { heading: 0–6, prefix: 'quote'|'bullet'|'ordered'|'task'|null }
 *   setHeading(state, level)            选区所涉各行设为 level 级标题，0 为正文（保留引用前缀）
 *   toggleLinePrefix(state, kind)       kind：quote | bullet | ordered | task；各行已全是该前缀则去掉，否则加上（列表间互换）
 *   insertBlock(state, block, opts?)    插入块级内容并自动补前后空行；opts.selectFrom / selectTo 为块内相对选区
 *   buildTable(rows, cols)              GFM 表格模板（rows 含表头行，最少 2 行 1 列）
 *   insertFootnote(value, caret)        插入 [^n]（n 取已有数字编号最大值 + 1），文末追加定义并把光标放到定义处
 *   buildLink({ text, url })            [文字](网址)：文字中的 \ 与 ] 转义；网址含空白或括号时写成 <网址>
 *   buildImageTag({ src, width, alt })  <img src="…" width="W" alt="…">，属性值转义；无有效宽度不写 width
 */

export const HEADING_LEVELS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
export const TABLE_TEMPLATE = Object.freeze({ rows: 3, cols: 3 });

const MAX_TABLE_ROWS = 64;
const MAX_TABLE_COLS = 32;
const HEADING_RE = /^(#{1,6})(?:[ \t]+|$)/;
const QUOTE_PREFIX_RE = /^(?:[ \t]{0,3}>[ \t]?)+/;
const LIST_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/;
const TASK_RE = /^[ \t]*[-*+][ \t]+\[[ xX]\](?:[ \t]|$)/;
const BULLET_RE = /^[ \t]*[-*+](?:[ \t]|$)/;
const ORDERED_RE = /^[ \t]*\d{1,9}[.)](?:[ \t]|$)/;
/** 多行包裹时跳过的行首块级前缀：引用、列表（含任务框）、ATX 标题 */
const BLOCK_PREFIX_RE = /^(?:[ \t]{0,3}>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)?/;
const FOOTNOTE_REF_RE = /\[\^(\d+)\]/g;
const FOOTNOTE_DEF_LINE_RE = /^\[\^[^\]\s]+\]:/;

const clampInt = (value, min, max, fallback) => {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
};

function normalize(state) {
    const value = String(state && state.value != null ? state.value : '');
    const a = clampInt(state && state.start, 0, value.length, value.length);
    const b = clampInt(state && state.end, 0, value.length, a);
    return { value, start: Math.min(a, b), end: Math.max(a, b) };
}

const lineStartOf = (value, index) => value.lastIndexOf('\n', index - 1) + 1;
function lineEndOf(value, index) {
    const next = value.indexOf('\n', index);
    return next === -1 ? value.length : next;
}

function countBack(value, index, ch) {
    let n = 0;
    while (index - n - 1 >= 0 && value[index - n - 1] === ch) n += 1;
    return n;
}

function countForward(value, index, ch) {
    let n = 0;
    while (index + n < value.length && value[index + n] === ch) n += 1;
    return n;
}

// ============================================================
// 行内标记
// ============================================================

const starMode = (open, close) => {
    if (open === '*' && close === '*') return 'italic';
    if (open === '**' && close === '**') return 'bold';
    return null;
};

/** 星号连续数判定：斜体须两侧均为奇数个 *，粗体须两侧均不少于 2 个 */
function starsMatch(mode, before, after) {
    if (mode === 'italic') return before % 2 === 1 && after % 2 === 1;
    return before >= 2 && after >= 2;
}

function hasInnerMarkers(selected, open, close) {
    if (selected.length < open.length + close.length) return false;
    const mode = starMode(open, close);
    if (mode) {
        const lead = countForward(selected, 0, '*');
        if (lead >= selected.length) return false;
        return starsMatch(mode, lead, countBack(selected, selected.length, '*'));
    }
    return selected.startsWith(open) && selected.endsWith(close);
}

function hasOuterMarkers(value, start, end, open, close) {
    const mode = starMode(open, close);
    if (mode) return starsMatch(mode, countBack(value, start, '*'), countForward(value, end, '*'));
    return start >= open.length && value.slice(start - open.length, start) === open && value.slice(end, end + close.length) === close;
}

/** 行内代码：内容含反引号时用更长的反引号串包裹，内容首尾是反引号时加空格 */
function fenceFor(core, open, close) {
    if (open !== '`' || close !== '`' || !core.includes('`')) return [open, close];
    const longest = Math.max(...(core.match(/`+/g) || ['']).map((run) => run.length));
    const fence = '`'.repeat(longest + 1);
    const pad = core.startsWith('`') || core.endsWith('`') ? ' ' : '';
    return [`${fence}${pad}`, `${pad}${fence}`];
}

function splitSpaces(text) {
    const lead = text.match(/^\s*/)[0];
    const rest = text.slice(lead.length);
    const trail = rest.match(/\s*$/)[0];
    return { lead, core: rest.slice(0, rest.length - trail.length), trail };
}

function wrapSegment(segment, open, close, skipPrefix) {
    const prefix = skipPrefix ? BLOCK_PREFIX_RE.exec(segment)[0] : '';
    const { lead, core, trail } = splitSpaces(segment.slice(prefix.length));
    if (!core) return { text: segment, coreStart: -1, coreLength: 0 };
    const [o, c] = fenceFor(core, open, close);
    return { text: `${prefix}${lead}${o}${core}${c}${trail}`, coreStart: prefix.length + lead.length + o.length, coreLength: core.length };
}

export function toggleInline(state, open, close = open) {
    const { value, start, end } = normalize(state);
    const opener = String(open || '');
    const closer = String(close == null ? opener : close);
    if (!opener) return { from: start, to: end, text: value.slice(start, end), selStart: start, selEnd: end };
    const mode = starMode(opener, closer);
    const removeBefore = mode ? opener.length : opener.length;
    const removeAfter = mode ? closer.length : closer.length;

    if (start === end) {
        if (hasOuterMarkers(value, start, end, opener, closer)) {
            return { from: start - removeBefore, to: end + removeAfter, text: '', selStart: start - removeBefore, selEnd: start - removeBefore };
        }
        const caret = start + opener.length;
        return { from: start, to: end, text: `${opener}${closer}`, selStart: caret, selEnd: caret };
    }

    const selected = value.slice(start, end);
    if (hasInnerMarkers(selected, opener, closer)) {
        const inner = selected.slice(removeBefore, selected.length - removeAfter);
        return { from: start, to: end, text: inner, selStart: start, selEnd: start + inner.length };
    }
    if (hasOuterMarkers(value, start, end, opener, closer)) {
        const from = start - removeBefore;
        return { from, to: end + removeAfter, text: selected, selStart: from, selEnd: from + selected.length };
    }

    const segments = selected.split('\n');
    const atLineStart = start === lineStartOf(value, start);
    if (segments.length === 1) {
        const wrapped = wrapSegment(selected, opener, closer, atLineStart);
        if (wrapped.coreStart < 0) {
            const caret = end + opener.length;
            return { from: end, to: end, text: `${opener}${closer}`, selStart: caret, selEnd: caret };
        }
        const selStart = start + wrapped.coreStart;
        return { from: start, to: end, text: wrapped.text, selStart, selEnd: selStart + wrapped.coreLength };
    }
    const text = segments.map((segment, index) => wrapSegment(segment, opener, closer, index > 0 || atLineStart).text).join('\n');
    return { from: start, to: end, text, selStart: start, selEnd: start + text.length };
}

// ============================================================
// 行级样式
// ============================================================

export function prefixKind(line) {
    const text = String(line || '');
    if (QUOTE_PREFIX_RE.test(text)) return 'quote';
    if (TASK_RE.test(text)) return 'task';
    if (BULLET_RE.test(text) && !/^[ \t]*[-*+][ \t]*[-*+][ \t]*[-*+]/.test(text)) return 'bullet';
    if (ORDERED_RE.test(text)) return 'ordered';
    return null;
}

export function lineStyleAt(value, pos) {
    const text = String(value == null ? '' : value);
    const index = clampInt(pos, 0, text.length, 0);
    const line = text.slice(lineStartOf(text, index), lineEndOf(text, index));
    const body = line.slice((QUOTE_PREFIX_RE.exec(line) || [''])[0].length);
    const heading = HEADING_RE.exec(body);
    return { heading: heading ? heading[1].length : 0, prefix: prefixKind(line) };
}

/**
 * 逐行改写选区所涉各行。fn(line, index, multi) → { line, removed, added }：removed / added 为行首被删 / 新增的字符数，
 * 用于把单行选区映射到新文本；多行时新选区覆盖整段改写结果。选区止于下一行行首时不把那一行算进来。
 */
function transformLines(state, fn, { applyToBlank = false } = {}) {
    const { value, start, end } = normalize(state);
    const from = lineStartOf(value, start);
    const effectiveEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
    const to = lineEndOf(value, Math.max(effectiveEnd, from));
    const lines = value.slice(from, to).split('\n');
    const multi = lines.length > 1;
    const results = lines.map((line, index) => (multi && !applyToBlank && !line.trim() ? { line, removed: 0, added: 0 } : fn(line, index, multi)));
    const text = results.map((item) => item.line).join('\n');
    if (multi) return { from, to, text, selStart: from, selEnd: from + text.length };
    const { removed, added } = results[0];
    const map = (pos) => {
        const offset = pos - from;
        return offset <= removed ? from + added : pos + (added - removed);
    };
    return { from, to, text, selStart: map(start), selEnd: map(end) };
}

export function setHeading(state, level) {
    const depth = clampInt(level, 0, 6, 0);
    return transformLines(state, (line) => {
        const quote = (QUOTE_PREFIX_RE.exec(line) || [''])[0];
        const body = line.slice(quote.length);
        const match = HEADING_RE.exec(body);
        const rest = match ? body.slice(match[0].length) : body;
        const marker = depth > 0 ? `${'#'.repeat(depth)} ` : '';
        return { line: `${quote}${marker}${rest}`, removed: quote.length + (match ? match[0].length : 0), added: quote.length + marker.length };
    });
}

const LIST_KINDS = Object.freeze(['bullet', 'ordered', 'task']);

function listKindOf(body) {
    if (TASK_RE.test(body)) return 'task';
    if (ORDERED_RE.test(body)) return 'ordered';
    if (BULLET_RE.test(body)) return 'bullet';
    return null;
}

export function toggleLinePrefix(state, kind) {
    const { value, start, end } = normalize(state);
    const from = lineStartOf(value, start);
    const effectiveEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
    const lines = value.slice(from, lineEndOf(value, Math.max(effectiveEnd, from))).split('\n');
    const nonBlank = lines.filter((line) => line.trim());
    if (kind === 'quote') {
        const allQuoted = nonBlank.length > 0 && nonBlank.every((line) => QUOTE_PREFIX_RE.test(line));
        return transformLines(state, (line, index, multi) => {
            if (allQuoted) {
                const match = /^[ \t]{0,3}>[ \t]?/.exec(line);
                const cut = match ? match[0].length : 0;
                return { line: line.slice(cut), removed: cut, added: 0 };
            }
            const marker = line ? '> ' : (multi ? '>' : '> ');
            return { line: `${marker}${line}`, removed: 0, added: marker.length };
        }, { applyToBlank: !allQuoted });
    }
    if (!LIST_KINDS.includes(kind)) throw new Error(`未知的行前缀类型：${kind}`);
    const bodyOf = (line) => line.slice((QUOTE_PREFIX_RE.exec(line) || [''])[0].length);
    const allSame = nonBlank.length > 0 && nonBlank.every((line) => listKindOf(bodyOf(line)) === kind);
    let counter = 0;
    return transformLines(state, (line) => {
        const quote = (QUOTE_PREFIX_RE.exec(line) || [''])[0];
        const body = line.slice(quote.length);
        const match = LIST_RE.exec(body);
        const indent = match ? match[1] : body.match(/^[ \t]*/)[0];
        const cut = match ? match[0].length : indent.length;
        const rest = body.slice(cut);
        if (allSame) return { line: `${quote}${indent}${rest}`, removed: quote.length + cut, added: quote.length + indent.length };
        counter += 1;
        const marker = kind === 'bullet' ? '- ' : kind === 'task' ? '- [ ] ' : `${counter}. `;
        return { line: `${quote}${indent}${marker}${rest}`, removed: quote.length + cut, added: quote.length + indent.length + marker.length };
    });
}

// ============================================================
// 块级插入
// ============================================================

function blockLead(value, index) {
    if (index === 0) return '';
    if (value[index - 1] !== '\n') return '\n\n';
    if (index === 1 || value[index - 2] === '\n') return '';
    return '\n';
}

function blockTrail(value, index) {
    if (index >= value.length) return '\n';
    if (value[index] !== '\n') return '\n\n';
    if (index + 1 >= value.length || value[index + 1] === '\n') return '';
    return '\n';
}

export function insertBlock(state, block, options = {}) {
    const { value, start, end } = normalize(state);
    const body = String(block == null ? '' : block);
    const lead = blockLead(value, start);
    const trail = blockTrail(value, end);
    const base = start + lead.length;
    const selectFrom = clampInt(options.selectFrom, 0, body.length, body.length);
    const selectTo = clampInt(options.selectTo, selectFrom, body.length, selectFrom);
    return { from: start, to: end, text: `${lead}${body}${trail}`, selStart: base + selectFrom, selEnd: base + selectTo };
}

export function buildTable(rows = TABLE_TEMPLATE.rows, cols = TABLE_TEMPLATE.cols) {
    const rowCount = clampInt(rows, 2, MAX_TABLE_ROWS, TABLE_TEMPLATE.rows);
    const colCount = clampInt(cols, 1, MAX_TABLE_COLS, TABLE_TEMPLATE.cols);
    const cells = (fill) => `| ${Array.from({ length: colCount }, (_, index) => fill(index)).join(' | ')} |`;
    return [
        cells((index) => `列 ${index + 1}`),
        cells(() => '---'),
        ...Array.from({ length: rowCount - 1 }, () => cells(() => ' ')),
    ].join('\n');
}

export function insertFootnote(value, caret) {
    const text = String(value == null ? '' : value);
    const pos = clampInt(caret, 0, text.length, text.length);
    let max = 0;
    for (const match of text.matchAll(FOOTNOTE_REF_RE)) max = Math.max(max, Number(match[1]) || 0);
    const label = `[^${max + 1}]`;
    const combined = `${text.slice(0, pos)}${label}${text.slice(pos)}`;
    const trimmedEnd = combined.replace(/\n+$/, '');
    const trailing = combined.length - trimmedEnd.length;
    const lastLine = trimmedEnd.slice(trimmedEnd.lastIndexOf('\n') + 1);
    const wanted = FOOTNOTE_DEF_LINE_RE.test(lastLine) ? 1 : 2;
    const separator = '\n'.repeat(Math.max(0, wanted - trailing));
    const replacement = `${label}${text.slice(pos)}${separator}${label}: \n`;
    const caretAt = pos + replacement.length - 1;
    return { from: pos, to: text.length, text: replacement, selStart: caretAt, selEnd: caretAt };
}

// ============================================================
// 链接与图片
// ============================================================

function escapeDestination(url) {
    const encoded = url.replace(/[<>]/g, (ch) => encodeURIComponent(ch));
    return /[\s()]/.test(encoded) ? `<${encoded}>` : encoded;
}

export function buildLink({ text = '', url = '' } = {}) {
    const href = String(url == null ? '' : url).trim();
    const rawLabel = String(text == null ? '' : text);
    const label = (rawLabel.trim() ? rawLabel : href).replace(/[\\\]]/g, (ch) => `\\${ch}`);
    return `[${label}](${escapeDestination(href)})`;
}

const escapeAttribute = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildImageTag({ src = '', width = null, alt = '' } = {}) {
    const number = Number(width);
    const widthAttr = width !== null && width !== undefined && width !== '' && Number.isFinite(number) && number > 0 ? ` width="${Math.round(number)}"` : '';
    return `<img src="${escapeAttribute(src)}"${widthAttr} alt="${escapeAttribute(alt)}">`;
}
