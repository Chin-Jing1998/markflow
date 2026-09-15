/**
 * 文档阅读辅助的纯逻辑（渲染层，无 DOM 依赖；Node 测试经 import() 载入）
 *
 * 供顶部栏（mf-status-bar）与文件库页、阅读页共用，DOM 侧操作（帧内查找、滚动、字号注入）见 doc-view.js：
 *   字号：百分比整数，DOC_ZOOM.min–max，步长 DOC_ZOOM.step；normalizeZoom / stepZoom。
 *   大纲：extractMarkdownOutline（ATX 与 Setext，跳过 front matter 与围栏代码块）、extractHtmlOutline（h1–h6），
 *         条目形如 { level, text, index, line? }；headingKey 供帧内按文字匹配标题。
 *   导航历史：不可变结构 { entries, cursor }；visitHistory / findHistoryStep / canStepHistory / moveHistory。
 *   查找：findMatches（不区分大小写，按字面匹配）与 pickMatch（按当前选区决定下一处或上一处，首尾回绕）；
 *         splitByMatches（文本按命中切为高亮片段，供编辑页的查找高亮镜像层）。
 *   其他：lineStartOffset（LF 文本的行首偏移）、docLocation（路径 → 所在文件夹与文件夹名）。
 */

// ---------- 字号 ----------

export const DOC_ZOOM = Object.freeze({ min: 80, max: 160, step: 10, fallback: 100 });

/** 任意输入 → 合法的字号百分比（按步长取整并夹在上下限内；无法解析时回退 100） */
export function normalizeZoom(value) {
    const number = typeof value === 'number' ? value : Number.parseFloat(value);
    if (!Number.isFinite(number)) return DOC_ZOOM.fallback;
    const stepped = Math.round(number / DOC_ZOOM.step) * DOC_ZOOM.step;
    return Math.min(DOC_ZOOM.max, Math.max(DOC_ZOOM.min, stepped));
}

/** direction < 0 缩小一档，否则放大一档 */
export function stepZoom(value, direction) {
    const delta = direction < 0 ? -DOC_ZOOM.step : DOC_ZOOM.step;
    return normalizeZoom(normalizeZoom(value) + delta);
}

// ---------- 大纲 ----------

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const QUOTE_RE = /^ {0,3}>/;
const THEMATIC_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FRONT_MATTER_OPEN_RE = /^---[ \t]*$/;
const FRONT_MATTER_CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/;
const NAMED_ENTITIES = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', ' ']]);

function decodeEntities(value) {
    return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
        if (body[0] === '#') {
            const hex = body[1] === 'x' || body[1] === 'X';
            const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        const named = NAMED_ENTITIES.get(body.toLowerCase());
        return named === undefined ? whole : named;
    });
}

/** 标题的行内 Markdown → 纯文本：去掉链接与图片语法、行内代码反引号、强调标记、HTML 标签与反斜杠转义 */
export function plainHeadingText(value) {
    const text = String(value == null ? '' : value)
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
        .replace(/`+([^`]*?)`+/g, '$1')
        .replace(/<[^>]*>/g, '')
        .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
        .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1$2')
        .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2')
        .replace(/\\([!-/:-@[-`{-~])/g, '$1');
    return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

/** 按文字匹配标题用的宽松键：Unicode 规范化、转小写，只保留字母与数字 */
export function headingKey(value) {
    return String(value == null ? '' : value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function stripClosingHashes(raw) {
    const content = String(raw || '').trim();
    if (/^#+$/.test(content)) return '';
    return content.replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
}

/** 文首 front matter（首行为 ---，其后出现 --- 或 ... 收尾）之后的首行下标；没有 front matter 时为 0 */
function frontMatterEnd(lines) {
    if (lines.length === 0 || !FRONT_MATTER_OPEN_RE.test(lines[0])) return 0;
    for (let index = 1; index < lines.length; index += 1) {
        if (FRONT_MATTER_CLOSE_RE.test(lines[index])) return index + 1;
    }
    return 0;
}

/**
 * Markdown 原文 → 大纲 [{ level, text, index, line }]；line 为标题所在行（0 起，Setext 取标题文字的首行）。
 * 跳过 front matter、围栏代码块与缩进代码；列表项与引用的续行不当作 Setext 标题的正文。
 */
export function extractMarkdownOutline(text) {
    const lines = String(text == null ? '' : text).split(/\r\n|\r|\n/);
    const outline = [];
    const push = (level, raw, line) => {
        const title = plainHeadingText(raw);
        if (title) outline.push({ level, text: title, index: outline.length, line });
    };
    let fence = null;
    let paragraphStart = -1;
    let paragraph = [];
    let lastBlock = 'other';
    const endParagraph = () => { paragraphStart = -1; paragraph = []; };
    for (let index = frontMatterEnd(lines); index < lines.length; index += 1) {
        const line = lines[index];
        if (fence) {
            const close = FENCE_CLOSE_RE.exec(line);
            if (close && close[1][0] === fence.char && close[1].length >= fence.size) fence = null;
            continue;
        }
        const open = FENCE_OPEN_RE.exec(line);
        if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
            fence = { char: open[1][0], size: open[1].length };
            endParagraph();
            lastBlock = 'other';
            continue;
        }
        if (!line.trim()) {
            endParagraph();
            continue;
        }
        const atx = ATX_RE.exec(line);
        if (atx) {
            push(atx[1].length, stripClosingHashes(atx[2]), index);
            endParagraph();
            lastBlock = 'other';
            continue;
        }
        const setext = SETEXT_RE.exec(line);
        if (setext && paragraphStart >= 0) {
            push(setext[1][0] === '=' ? 1 : 2, paragraph.join(' '), paragraphStart);
            endParagraph();
            lastBlock = 'other';
            continue;
        }
        if (THEMATIC_RE.test(line)) {
            endParagraph();
            lastBlock = 'other';
            continue;
        }
        if (LIST_ITEM_RE.test(line) || QUOTE_RE.test(line)) {
            endParagraph();
            lastBlock = 'container';
            continue;
        }
        const indented = /^[ \t]/.test(line);
        if (paragraphStart < 0) {
            // 列表 / 引用的续行与缩进代码不开启新段落
            if (indented && (lastBlock === 'container' || /^(?: {4,}|\t)/.test(line))) continue;
            paragraphStart = index;
            lastBlock = 'paragraph';
        }
        paragraph.push(line.trim());
    }
    return outline;
}

const HEADING_TAG_RE = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;

/** HTML 文本 → 大纲 [{ level, text, index }]：按出现顺序取 h1–h6，去掉脚本、样式与注释，空标题不列 */
export function extractHtmlOutline(html) {
    const source = String(html == null ? '' : html)
        .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');
    const outline = [];
    for (const match of source.matchAll(HEADING_TAG_RE)) {
        const title = decodeEntities(match[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
        if (title) outline.push({ level: Number(match[1]), text: title, index: outline.length });
    }
    return outline;
}

// ---------- 导航历史（不可变） ----------

export const MAX_HISTORY_ENTRIES = 100;
export const EMPTY_HISTORY = Object.freeze({ entries: Object.freeze([]), cursor: -1 });

/** 访问一个键：与当前项相同时不变；否则截掉前进分支后追加，超过上限时丢弃最早的 */
export function visitHistory(history, key, limit = MAX_HISTORY_ENTRIES) {
    const current = history || EMPTY_HISTORY;
    const value = String(key == null ? '' : key);
    if (!value || current.entries[current.cursor] === value) return current;
    const entries = [...current.entries.slice(0, current.cursor + 1), value].slice(-Math.max(1, limit));
    return Object.freeze({ entries: Object.freeze(entries), cursor: entries.length - 1 });
}

/** 后退（direction < 0）或前进一步的目标下标：跳过已失效的项与当前项；无处可去时为 -1 */
export function findHistoryStep(history, direction, isValid = () => true) {
    const current = history || EMPTY_HISTORY;
    const here = current.entries[current.cursor];
    const delta = direction < 0 ? -1 : 1;
    for (let index = current.cursor + delta; index >= 0 && index < current.entries.length; index += delta) {
        const key = current.entries[index];
        if (key !== here && isValid(key)) return index;
    }
    return -1;
}

export function canStepHistory(history, direction, isValid) {
    return findHistoryStep(history, direction, isValid) !== -1;
}

/** 把游标移到指定下标（导航成功后调用）；下标越界时原样返回 */
export function moveHistory(history, index) {
    const current = history || EMPTY_HISTORY;
    if (!Number.isInteger(index) || index < 0 || index >= current.entries.length) return current;
    return Object.freeze({ entries: current.entries, cursor: index });
}

// ---------- 查找 ----------

export const MAX_FIND_MATCHES = 5000;

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 文本中查询串的全部出现位置 [{ start, end }]（按字面、不区分大小写；最多 limit 处） */
export function findMatches(text, query, limit = MAX_FIND_MATCHES) {
    const needle = String(query == null ? '' : query);
    if (!needle) return [];
    const pattern = new RegExp(escapeRegExp(needle), 'giu');
    const matches = [];
    for (const match of String(text == null ? '' : text).matchAll(pattern)) {
        matches.push({ start: match.index, end: match.index + match[0].length });
        if (matches.length >= limit) break;
    }
    return matches;
}

/**
 * 按当前选区 [selStart, selEnd) 选下一处（backwards 为上一处）匹配的下标，首尾回绕；无匹配时为 -1。
 * reset（查询串刚改变）：从选区起点开始找第一处，选区正好是某处匹配时保持不动。
 */
export function pickMatch(matches, { selStart = -1, selEnd = -1, backwards = false, reset = false } = {}) {
    if (!Array.isArray(matches) || matches.length === 0) return -1;
    const last = matches.length - 1;
    const from = selStart >= 0 ? selStart : 0;
    if (reset) {
        if (backwards) {
            for (let index = last; index >= 0; index -= 1) if (matches[index].start <= from) return index;
            return last;
        }
        const next = matches.findIndex((match) => match.start >= from);
        return next >= 0 ? next : 0;
    }
    const current = matches.findIndex((match) => match.start === selStart && match.end === selEnd);
    if (current >= 0) return backwards ? (current === 0 ? last : current - 1) : (current === last ? 0 : current + 1);
    if (backwards) {
        for (let index = last; index >= 0; index -= 1) if (matches[index].end <= from) return index;
        return last;
    }
    const next = matches.findIndex((match) => match.start >= (selEnd >= 0 ? selEnd : 0));
    return next >= 0 ? next : 0;
}

/**
 * 查找高亮切片：text 按命中切为 [{ text, index, current }]，供编辑页镜像层依次生成文本节点与 <mark>；
 * index 为该段对应的命中下标（普通文本为 -1），current 标出下标等于 current 的那处命中。
 * matches 按 start 升序（findMatches 的结果即如此）；与前一处重叠或区间为空的命中跳过，越界终点截到文末；
 * 不产生空片段，各段依次拼接即原文。
 */
export function splitByMatches(text, matches, current = -1) {
    const value = String(text == null ? '' : text);
    const list = Array.isArray(matches) ? matches : [];
    const segments = [];
    let cursor = 0;
    for (let index = 0; index < list.length; index += 1) {
        const match = list[index] || {};
        const start = Number(match.start);
        const end = Math.min(value.length, Number(match.end));
        if (!Number.isInteger(start) || start < cursor || !(end > start)) continue;
        if (start > cursor) segments.push({ text: value.slice(cursor, start), index: -1, current: false });
        segments.push({ text: value.slice(start, end), index, current: index === current });
        cursor = end;
    }
    if (cursor < value.length) segments.push({ text: value.slice(cursor), index: -1, current: false });
    return segments;
}

// ---------- 其他 ----------

/** LF 文本（textarea.value、帧内 DOM 文本均已归一为 LF）第 line 行（0 起）的行首偏移；超出末行时为文本长度 */
export function lineStartOffset(text, line) {
    const value = String(text == null ? '' : text);
    const target = Math.max(0, Math.floor(Number(line) || 0));
    let offset = 0;
    for (let current = 0; current < target; current += 1) {
        const next = value.indexOf('\n', offset);
        if (next === -1) return value.length;
        offset = next + 1;
    }
    return offset;
}

/** 大纲按钮不可用时的说明：kind 为文件类型，view 为当前视图页签，count 为已提取的标题数（有标题时回空串） */
export function outlineHintFor(kind, view, count) {
    if (count > 0) return '';
    if (kind === 'md') return '当前文档没有标题';
    if (kind === 'xml') return view === 'rendered' ? '当前文档没有可列出的章节标题' : '切换到「结构视图」后可用大纲';
    return '当前文件类型不支持大纲';
}

/** Markdown 编辑器的 mf-md-status 事件明细 → 顶部栏的保存状态 { state, label, message }；无文案时为 null */
export function toSaveState(status) {
    if (!status || !status.label) return null;
    return { state: String(status.state || ''), label: String(status.label), message: String(status.message || '') };
}

/** 文件路径 → { folder, folderName }：folder 为所在目录（保留原分隔符），folderName 为其末级名称 */
export function docLocation(filePath) {
    const raw = String(filePath == null ? '' : filePath);
    const slash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
    const folder = slash > 0 ? raw.slice(0, slash) : (slash === 0 ? raw.slice(0, 1) : '');
    const parts = folder.split(/[\\/]/).filter(Boolean);
    return { folder, folderName: parts.length > 0 ? parts[parts.length - 1] : folder };
}
