/**
 * 文档视图的 DOM 侧操作（文件库页与阅读页共用；纯逻辑见 doc-tools.mjs，帧内注入样式见 dom.js）
 *
 * 两页的 srcdoc 帧一律为同源沙箱帧（sandbox="allow-popups allow-same-origin"，不放开脚本）：
 * 父页可读写帧内 DOM、在帧内 window 上挂监听，帧内不执行任何脚本。
 *   字号：readDocZoom / writeDocZoom 读写 localStorage（均 try/catch；存储不可用时回退 100%，改动仅本次生效）。
 *   prepareDocFrame(frame, getZoom)：帧装载后补齐当前字号（装载期间换过字号时以最新值为准），并转发帧内快捷键。
 *   查找：findInFrame / clearFrameFind 以 TreeWalker 拼接文本节点，按匹配建 Range 选中并滚到可见（帧尚未装载完时回 pending）；
 *         findInTextarea 在编辑区选中，并交所属编辑器的镜像层高亮全部命中（restore 时不动选区与滚动、只重现高亮；
 *         关闭查找时 endFindInView 撤掉高亮、聚焦编辑区并选中当前命中）。
 *   大纲定位：scrollFrameToHeading（渲染视图）、scrollFrameToLine（原文视图）、revealTextareaLine（编辑页）。
 * 帧内 getBoundingClientRect 与 scrollTop 同处 html { zoom } 缩放后的坐标系（Chromium 实测），滚动量可直接相加。
 */
import { applyFrameLayout, applyFrameZoom } from './dom.js';
import { DOC_ZOOM, normalizeZoom, findMatches, pickMatch, headingKey, lineStartOffset } from './doc-tools.mjs';

const ZOOM_STORAGE_KEY = 'markflow.doc.zoom';
const FIND_STYLE_ATTR = 'data-markflow-find';
// 查找命中用高对比度的黄底深字（macOS 查找高亮色），深浅两种纸面下都清楚；关闭查找时移除
const FIND_STYLE = '::selection { background: #ffd60a; color: #1c1c1e; }';
const SCROLL_MARGIN = 12;
const SKIPPED_TEXT_PARENTS = 'script, style, noscript, template';
const MIRROR_PROPS = Object.freeze([
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'letterSpacing', 'wordSpacing', 'lineHeight',
    'textIndent', 'textTransform', 'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
]);

// ---------- 字号 ----------

export function readDocZoom() {
    try {
        return normalizeZoom(localStorage.getItem(ZOOM_STORAGE_KEY));
    } catch (err) {
        return DOC_ZOOM.fallback;
    }
}

export function writeDocZoom(value) {
    const zoom = normalizeZoom(value);
    try {
        localStorage.setItem(ZOOM_STORAGE_KEY, String(zoom));
    } catch (err) {
        // 本地存储不可用：字号仍在本次会话内生效
    }
    return zoom;
}

// ---------- 帧 ----------

/** 同源帧的文档；帧不可访问或尚无 body 时为 null */
export function frameDocument(frame) {
    try {
        const doc = frame ? frame.contentDocument : null;
        return doc && doc.body ? doc : null;
    } catch (err) {
        return null;
    }
}

/** 帧内按住 ⌘ / Ctrl 的按键与 Esc 转发到帧元素上冒泡，顶部栏的快捷键监听据此在帧获得焦点时照常生效 */
function forwardFrameKeys(frame) {
    let win = null;
    try {
        win = frame.contentDocument ? frame.contentWindow : null;
    } catch (err) {
        win = null;
    }
    if (!win) return;
    win.addEventListener('keydown', (event) => {
        if (!(event.metaKey || event.ctrlKey || event.key === 'Escape')) return;
        const forwarded = new KeyboardEvent('keydown', {
            key: event.key, code: event.code, metaKey: event.metaKey, ctrlKey: event.ctrlKey,
            shiftKey: event.shiftKey, altKey: event.altKey, bubbles: true, cancelable: true,
        });
        if (!frame.dispatchEvent(forwarded)) event.preventDefault();
    });
}

/** 挂载 srcdoc 帧后调用：load 时补齐字号并转发快捷键 */
export function prepareDocFrame(frame, getZoom) {
    if (!frame || frame.dataset.docPrepared) return;
    frame.dataset.docPrepared = '1';
    frame.addEventListener('load', () => {
        applyFrameZoom(frame, getZoom());
        forwardFrameKeys(frame);
    });
}

// ---------- 帧内文本索引 ----------

function textIndex(doc) {
    const nodes = [];
    const starts = new Map();
    let text = '';
    const root = doc.body || doc.documentElement;
    if (!root) return { nodes, starts, text };
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement && node.parentElement.closest(SKIPPED_TEXT_PARENTS) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push(node);
        starts.set(node, text.length);
        text += node.data;
    }
    return { nodes, starts, text };
}

/** 拼接文本里的偏移 → 所在文本节点与节点内偏移（二分查找） */
function pointAt(index, offset) {
    let low = 0;
    let high = index.nodes.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (index.starts.get(index.nodes[mid]) <= offset) low = mid;
        else high = mid - 1;
    }
    const node = index.nodes[low];
    return { node, offset: Math.max(0, Math.min(offset - index.starts.get(node), node.data.length)) };
}

function rangeFor(doc, index, start, end) {
    if (index.nodes.length === 0) return null;
    const from = pointAt(index, start);
    const to = pointAt(index, end);
    const range = doc.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
}

function selectionOffsets(index, selection) {
    if (!selection || selection.rangeCount === 0) return { selStart: -1, selEnd: -1 };
    const range = selection.getRangeAt(0);
    const start = index.starts.get(range.startContainer);
    const end = index.starts.get(range.endContainer);
    if (start === undefined || end === undefined) return { selStart: -1, selEnd: -1 };
    return { selStart: start + range.startOffset, selEnd: end + range.endOffset };
}

/** 把一处矩形滚到可见：已在视口内时不动；toTop 时顶到视口上沿，否则落在视口上三分之一处 */
function scrollRectIntoView(doc, rect, { toTop = false } = {}) {
    if (!rect) return;
    const scroller = doc.scrollingElement || doc.documentElement;
    const view = scroller.clientHeight;
    if (!toTop && rect.top >= SCROLL_MARGIN && rect.bottom <= view - SCROLL_MARGIN) return;
    scroller.scrollTop += toTop ? rect.top - SCROLL_MARGIN : rect.top - Math.round(view / 3);
}

const firstRect = (range) => (range.getClientRects()[0] || range.getBoundingClientRect());

// ---------- 查找 ----------

/**
 * 帧是否已装载出正文：srcdoc 帧装载完成前 contentDocument 仍是初始的空白文档（about:blank，body 为空），此时查找只会得到 0 处；
 * 换视图时帧总是重建，须等 readyState 为 complete 且文档已换成 about:srcdoc。
 */
function frameLoaded(frame, doc) {
    if (doc.readyState !== 'complete') return false;
    return !frame.hasAttribute('srcdoc') || doc.URL === 'about:srcdoc';
}

/**
 * 帧内查找：选中下一处（backwards 为上一处）并滚到可见；回 { total, current }，无结果时 total 为 0。
 * 帧尚未挂上或还没装载完时回 { total: 0, current: 0, pending: true }，由顶部栏稍后重发，不当作无结果。
 */
export function findInFrame(frame, query, { backwards = false, reset = false } = {}) {
    const doc = frameDocument(frame);
    if (!doc || !frameLoaded(frame, doc)) return { total: 0, current: 0, pending: true };
    const index = textIndex(doc);
    const matches = findMatches(index.text, query);
    const selection = doc.getSelection();
    if (matches.length === 0) {
        if (selection) selection.removeAllRanges();
        return { total: 0, current: 0 };
    }
    const picked = pickMatch(matches, { ...selectionOffsets(index, selection), backwards, reset });
    const range = rangeFor(doc, index, matches[picked].start, matches[picked].end);
    if (!doc.querySelector(`style[${FIND_STYLE_ATTR}]`)) {
        const style = doc.createElement('style');
        style.setAttribute(FIND_STYLE_ATTR, '');
        style.textContent = FIND_STYLE;
        (doc.head || doc.documentElement).append(style);
    }
    if (selection && range) {
        selection.removeAllRanges();
        selection.addRange(range);
        scrollRectIntoView(doc, firstRect(range));
    }
    return { total: matches.length, current: picked + 1 };
}

/** 关闭查找：移除命中高亮样式，选区保留（便于复制） */
export function clearFrameFind(frame) {
    const doc = frameDocument(frame);
    const style = doc ? doc.querySelector(`style[${FIND_STYLE_ATTR}]`) : null;
    if (style) style.remove();
}

/** textarea 所属的 <mf-md-editor>（提供查找高亮）；不在编辑器内时为 null */
function editorOf(textarea) {
    const editor = textarea ? textarea.closest('mf-md-editor') : null;
    return editor && typeof editor.highlightFind === 'function' ? editor : null;
}

/**
 * 编辑区查找：选中下一处（backwards 为上一处）并滚到可见，焦点仍留在查找框。
 * 失焦 textarea 的选区不绘制，命中改由编辑器的镜像高亮层标出（全部命中浅色、与选区重合的当前命中深色）；
 * 查询串为空时撤掉高亮，无命中时隐藏高亮层。
 * restore（切回编辑页后的自动重查）：不动选区与滚动位置，只重现高亮；current 取与选区正好重合的命中，没有时为 0。
 */
export function findInTextarea(textarea, query, { backwards = false, reset = false, restore = false } = {}) {
    if (!textarea) return { total: 0, current: 0 };
    const editor = editorOf(textarea);
    const matches = findMatches(textarea.value, query);
    if (matches.length === 0) {
        if (editor) editor.highlightFind(query, matches);
        return { total: 0, current: 0 };
    }
    if (restore) {
        const { selectionStart, selectionEnd } = textarea;
        if (editor) editor.highlightFind(query, matches);
        return { total: matches.length, current: matches.findIndex((match) => match.start === selectionStart && match.end === selectionEnd) + 1 };
    }
    const picked = pickMatch(matches, { selStart: textarea.selectionStart, selEnd: textarea.selectionEnd, backwards, reset });
    textarea.setSelectionRange(matches[picked].start, matches[picked].end);
    revealTextareaOffset(textarea, matches[picked].start);
    if (editor) editor.highlightFind(query, matches);
    return { total: matches.length, current: picked + 1 };
}

// ---------- 编辑区定位 ----------

/** 以隐藏的镜像块测出 textarea 内某偏移所在行的顶边（与 scrollTop 同坐标，含上内边距） */
function caretTop(textarea, offset) {
    const style = getComputedStyle(textarea);
    const mirror = document.createElement('div');
    for (const prop of MIRROR_PROPS) mirror.style[prop] = style[prop];
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.left = '-99999px';
    mirror.style.top = '0';
    mirror.style.boxSizing = 'content-box';
    mirror.style.border = '0';
    mirror.style.width = `${Math.max(0, textarea.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight))}px`;
    mirror.textContent = textarea.value.slice(0, offset);
    const marker = document.createElement('span');
    marker.textContent = '​';
    mirror.append(marker);
    document.body.append(mirror);
    const top = marker.offsetTop;
    mirror.remove();
    return top;
}

function revealTextareaOffset(textarea, offset) {
    const top = caretTop(textarea, offset);
    const view = textarea.clientHeight;
    if (top >= textarea.scrollTop + SCROLL_MARGIN && top <= textarea.scrollTop + view - SCROLL_MARGIN * 3) return;
    textarea.scrollTop = Math.max(0, top - Math.round(view / 3));
}

/** 编辑页的大纲定位：光标移到该行行首并滚到可见 */
export function revealTextareaLine(textarea, line) {
    if (!textarea) return false;
    const offset = lineStartOffset(textarea.value, line);
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(offset, offset);
    revealTextareaOffset(textarea, offset);
    return true;
}

// ---------- 帧内大纲定位 ----------

/** 渲染视图：按标题文字（同名取第几次出现）找标题元素，找不到时按序号，滚到视口上沿 */
export function scrollFrameToHeading(frame, item, outline = []) {
    const doc = frameDocument(frame);
    if (!doc || !item) return false;
    const headings = [...doc.querySelectorAll('h1, h2, h3, h4, h5, h6')];
    const key = headingKey(item.text);
    const sameText = key ? headings.filter((node) => headingKey(node.textContent) === key) : [];
    const occurrence = outline.slice(0, item.index).filter((entry) => headingKey(entry.text) === key).length;
    const target = sameText[occurrence] || sameText[0] || headings[item.index] || null;
    if (!target) return false;
    scrollRectIntoView(doc, target.getBoundingClientRect(), { toTop: true });
    return true;
}

/** 原文视图：先核对 item.line 行是否含该标题文字，对不上时取最近的含该文字的行，滚到视口上沿 */
export function scrollFrameToLine(frame, item) {
    const doc = frameDocument(frame);
    if (!doc || !item) return false;
    const index = textIndex(doc);
    const lines = index.text.split('\n');
    const key = headingKey(item.text);
    const matchesLine = (lineNo) => {
        const lineKey = lineNo >= 0 && lineNo < lines.length ? headingKey(lines[lineNo]) : '';
        return Boolean(key && lineKey && (lineKey.includes(key) || key.startsWith(lineKey)));
    };
    let lineNo = Number.isInteger(item.line) ? item.line : -1;
    if (!matchesLine(lineNo)) {
        let best = -1;
        for (let current = 0; current < lines.length; current += 1) {
            if (matchesLine(current) && (best < 0 || Math.abs(current - lineNo) < Math.abs(best - lineNo))) best = current;
        }
        if (best >= 0) lineNo = best;
        else if (lineNo < 0 || lineNo >= lines.length) return false;
    }
    const start = lineStartOffset(index.text, lineNo);
    const range = rangeFor(doc, index, start, Math.min(index.text.length, start + Math.max(1, lines[lineNo].length)));
    if (!range) return false;
    scrollRectIntoView(doc, firstRect(range), { toTop: true });
    return true;
}

// ---------- 页面接入（文件库页与阅读页共用） ----------

/**
 * 编辑器的实时预览帧由 <mf-md-editor> 自建：宿主在编辑器容器上以捕获阶段监听 load（iframe 的 load 不冒泡，但捕获阶段经过祖先），
 * 先于编辑器自身的 load 处理注入紧凑版式与当前字号，新帧显出时已是最终排版。
 */
export function bindEditorPreviewFrames(host, getZoom) {
    if (!host) return;
    host.addEventListener('load', (event) => {
        const frame = event.target;
        if (!(frame instanceof HTMLIFrameElement) || !frame.classList.contains('view-frame')) return;
        applyFrameLayout(frame, 'compact');
        applyFrameZoom(frame, getZoom());
    }, true);
}

/** 字号生效：主视图帧实时改写；编辑器容器写入 --doc-zoom（编辑区字号按比例放缩），其内实时预览帧同步改写 */
export function applyDocZoom({ frame = null, editorHost = null } = {}, zoom) {
    const percent = normalizeZoom(zoom);
    if (frame) applyFrameZoom(frame, percent);
    if (!editorHost) return;
    editorHost.style.setProperty('--doc-zoom', String(percent / 100));
    for (const preview of editorHost.querySelectorAll('.view-frame')) applyFrameZoom(preview, percent);
}

/**
 * 查找分派：编辑页在编辑区内查找，其余视图在帧内查找；context = { mode: 'edit' | 'raw' | 'rendered', frame, textarea }。
 * restore 为换视图或换文件后的自动重查：编辑页不动选区与滚动、只重现高亮；帧内视图不认 restore，与按 Enter 相同。
 */
export function findInView(context, { query = '', backwards = false, reset = false, restore = false } = {}) {
    if (!context) return { total: 0, current: 0 };
    if (context.mode === 'edit') return findInTextarea(context.textarea, query, { backwards, reset, restore });
    // 查询串清空时顶部栏也会下发（供编辑页撤掉高亮）：帧内视图不做处理，原选区保留
    if (!query) return { total: 0, current: 0 };
    return findInFrame(context.frame, query, { backwards, reset });
}

/** 关闭查找：编辑页撤掉镜像高亮，焦点回到编辑区并选中当前命中；其余视图移除帧内高亮样式 */
export function endFindInView(context) {
    if (!context) return;
    if (context.mode === 'edit') {
        const editor = editorOf(context.textarea);
        if (editor) editor.endFind();
        else if (context.textarea) context.textarea.focus({ preventScroll: true });
        return;
    }
    clearFrameFind(context.frame);
}

/** 大纲定位分派：编辑页移光标到该行，原文视图按行文字滚动，渲染视图（含 XML 结构视图）按标题元素滚动 */
export function gotoOutlineItem(context, item, outline = []) {
    if (!context || !item) return false;
    if (context.mode === 'edit') return revealTextareaLine(context.textarea, item.line);
    if (context.mode === 'raw') return scrollFrameToLine(context.frame, item);
    return scrollFrameToHeading(context.frame, item, outline);
}
