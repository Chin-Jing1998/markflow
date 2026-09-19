/**
 * 渲染层公用工具：转义、格式化、事件委托、文案表与视图帧。插入 DOM 的动态文本一律先经 escapeHtml。
 */
export function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export const escapeAttr = escapeHtml;

export function formatSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function baseName(value) {
    return String(value || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

export function formatDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 事件委托：root 上监听 type，命中 selector 时回调 handler(target, event) */
export function delegate(root, type, selector, handler) {
    root.addEventListener(type, (event) => {
        const target = event.target instanceof Element ? event.target.closest(selector) : null;
        if (target && root.contains(target)) handler(target, event);
    });
}

export const TARGET_LABELS = Object.freeze({ bundle: 'MD 包', docx: 'DOCX', pdf: 'PDF', html: 'HTML', xml: 'XML' });
export const TYPE_LABELS = Object.freeze({
    docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint', pdf: 'PDF', md: 'Markdown', xml: '专利 XML', zip: '专利案卷', url: '网页',
});
/** 转档入口给出的输入项类别（mf:paths:expand 回包里 files[].kind）→ 标签；有 kind 时优先于 TYPE_LABELS */
export const KIND_LABELS = Object.freeze({ bundle: '专利五书目录' });
export const PHASE_LABELS = Object.freeze({ parsing: '解析中', rendering: '渲染中', writing: '写入中', done: '已完成', failed: '失败' });
export const STATUS_LABELS = Object.freeze({ idle: '待转换', queued: '排队中', running: '转换中', done: '已完成', failed: '失败', cancelled: '已取消' });
export const THEME_LABELS = Object.freeze({ system: '跟随系统', light: '浅色', dark: '深色' });

export const targetLabel = (target) => TARGET_LABELS[target] || String(target || '').toUpperCase();
export const typeLabel = (type, kind) => KIND_LABELS[kind] || TYPE_LABELS[type] || String(type || '');

/** 输入类型 → 目标类别（与 converters/targets.INPUT_CLASS 逐键一致，desktop-main.test.js 守护两份表不漂移） */
export const INPUT_CLASS = Object.freeze({
    docx: 'office', xlsx: 'office', pptx: 'office', pdf: 'office', md: 'markup', xml: 'markup', zip: 'markup', url: 'url',
});

export function classOf(type) {
    return INPUT_CLASS[type] || null;
}

// ---------- 视图帧（对比预览与阅读模式共用） ----------

/**
 * 产物与来源一律放 <iframe sandbox srcdoc>：沙箱帧继承本页 CSP，内联脚本与 javascript: 被拦，
 * 远程图在请求前就被 img-src 拦掉。只放开 allow-popups，使帧内的 target="_blank" 外链
 * 走主窗口的 setWindowOpenHandler → shell.openExternal；不放开 allow-scripts。
 * 对比预览的滚动同步按需增加 allow-same-origin，以便宿主读取两帧的滚动位置；仍不放开脚本执行。
 * PDF 例外：交 Chromium 内置阅读器的 iframe 不得带 sandbox，否则整帧被 ERR_BLOCKED_BY_CLIENT 拦掉。
 */
export const FRAME_SANDBOX = 'allow-popups';

const FRAME_SCROLLBAR_STYLE = `<style data-markflow-scrollbar>
html { scrollbar-color: color-mix(in oklch, currentColor 20%, transparent) transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; background: transparent; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
    background: color-mix(in oklch, currentColor 20%, transparent);
    border-radius: 999px;
    background-clip: padding-box;
    border: 3px solid transparent;
}
::-webkit-scrollbar-thumb:hover {
    background: color-mix(in oklch, currentColor 35%, transparent);
    background-clip: padding-box;
    border: 3px solid transparent;
}
::-webkit-scrollbar-corner { background: transparent; }
</style>`;

function withFrameScrollbar(srcdoc) {
    const documentHtml = String(srcdoc || '');
    return /<\/head\s*>/i.test(documentHtml)
        ? documentHtml.replace(/<\/head\s*>/i, `${FRAME_SCROLLBAR_STYLE}</head>`)
        : `${FRAME_SCROLLBAR_STYLE}${documentHtml}`;
}

/**
 * 视图帧外观（createViewFrame / mountFrame 的 appearance 选项）：
 *   'adaptive' —— 注入 FRAME_APPEARANCE_STYLE：应用为深色时，帧内文档改用与 --doc-surface 一致的深色纸面；
 *                 用于来源栏的 srcdoc 帧、文件库与阅读页的 md 渲染视图及编辑页实时预览、各类原文文本视图（textDocument）。
 *   'paper'    —— 不注入，帧底色固定白纸（--doc-paper），与帧内浅色文档一致：对比预览产物栏（含其编辑页预览）、html 原样渲染。
 *   缺省       —— 不注入，帧底色取 --doc-surface：PDF 帧、自带深色样式的 XML 结构视图。
 * 帧内 prefers-color-scheme 与应用主题一致（用户固定主题时主进程同步 nativeTheme.themeSource），注入样式只需一条媒体查询。
 * 注入只作用于应用内显示，导出的 HTML 与主题 CSS 不变。
 */
const FRAME_APPEARANCES = Object.freeze(['adaptive', 'paper']);

const FRAME_APPEARANCE_STYLE = `<style data-markflow-appearance>
@media (prefers-color-scheme: dark) {
    :root { color-scheme: dark; }
    html, body { background: #1c1c1e !important; color: #e6e6ea !important; }
    a { color: #4da3ff; }
    blockquote { color: #a1a1a6; border-left-color: rgba(255, 255, 255, 0.24); }
    hr { border-top-color: rgba(255, 255, 255, 0.16); }
    th, td { border-color: rgba(255, 255, 255, 0.16); }
    th { background: rgba(255, 255, 255, 0.06); }
    code, pre { background: rgba(255, 255, 255, 0.08); }
    pre code { background: none; }
    img { background-color: #ffffff; }
}
</style>`;

/** 向 srcdoc 注入深色覆盖样式（写法同 withFrameScrollbar）：有 </head> 时插在其前，否则前置 */
export function withFrameAppearance(srcdoc) {
    const documentHtml = String(srcdoc || '');
    return /<\/head\s*>/i.test(documentHtml)
        ? documentHtml.replace(/<\/head\s*>/i, `${FRAME_APPEARANCE_STYLE}</head>`)
        : `${FRAME_APPEARANCE_STYLE}${documentHtml}`;
}

/** 把一段 <style> 注入 srcdoc：有 </head> 时插在其前，否则前置（与 withFrameScrollbar / withFrameAppearance 同法） */
function injectFrameStyle(srcdoc, styleTag) {
    const documentHtml = String(srcdoc || '');
    return /<\/head\s*>/i.test(documentHtml)
        ? documentHtml.replace(/<\/head\s*>/i, () => `${styleTag}</head>`)
        : `${styleTag}${documentHtml}`;
}

/**
 * 视图帧版式（createViewFrame / mountFrame 的 layout 选项）：只用于文件库页与阅读页的帧；对比预览用于对照导出保真，不注入。
 *   'compact'      —— Markdown 渲染视图：取消主题的窄栏 max-width 与居中外边距，内边距收到 16px 22px 40px；
 *   'compact-text' —— 原文文本视图（textDocument）、JSON 与 XML 结构视图：内边距收到 12px 14px 32px。
 * 注入只作用于应用内显示，导出的 HTML、主题 CSS 与 xml-view 自带样式不变。
 */
const FRAME_LAYOUT_ATTR = 'data-markflow-layout';
const FRAME_LAYOUT_CSS = Object.freeze({
    compact: 'html > body { max-width: none !important; margin: 0 !important; padding: 16px 22px 40px !important; }',
    'compact-text': 'html > body { padding: 12px 14px 32px !important; }',
});

const layoutCss = (layout) => (Object.prototype.hasOwnProperty.call(FRAME_LAYOUT_CSS, layout) ? FRAME_LAYOUT_CSS[layout] : '');

/** 同源帧的文档；帧不可访问（非同源或已卸载）时为 null */
function sameOriginDocument(frame) {
    try {
        const doc = frame ? frame.contentDocument : null;
        return doc && doc.documentElement ? doc : null;
    } catch (err) {
        return null;
    }
}

export function withFrameLayout(srcdoc, layout) {
    const css = layoutCss(layout);
    return css ? injectFrameStyle(srcdoc, `<style ${FRAME_LAYOUT_ATTR}="${layout}">${css}</style>`) : String(srcdoc || '');
}

/** 同源帧装载后补注版式：Markdown 编辑器的实时预览帧由编辑器自建，宿主在其 load 时经此注入同一份样式；已注入时不重复 */
export function applyFrameLayout(frame, layout) {
    const css = layoutCss(layout);
    const doc = sameOriginDocument(frame);
    if (!css || !doc) return false;
    if (doc.querySelector(`style[${FRAME_LAYOUT_ATTR}]`)) return true;
    const style = doc.createElement('style');
    style.setAttribute(FRAME_LAYOUT_ATTR, layout);
    style.textContent = css;
    (doc.head || doc.documentElement).append(style);
    return true;
}

/**
 * 视图帧字号（createViewFrame 的 zoom 选项，百分比）：注入 html { zoom }；同源帧可经 applyFrameZoom 实时改写，无需重建帧。
 * 帧内 getBoundingClientRect 与 scrollTop 同处缩放后的坐标系，滚动定位无需换算。
 */
const FRAME_ZOOM_ATTR = 'data-markflow-zoom';

function zoomFactor(percent) {
    const value = Number(percent);
    return Number.isFinite(value) && value > 0 ? Math.round(value) / 100 : null;
}

export function withFrameZoom(srcdoc, percent) {
    const factor = zoomFactor(percent);
    return factor === null ? String(srcdoc || '') : injectFrameStyle(srcdoc, `<style ${FRAME_ZOOM_ATTR}>html { zoom: ${factor}; }</style>`);
}

/** 同源帧实时换字号：改写（或补建）帧内的缩放样式，并按滚动比例保持阅读位置；帧不可访问时回 false */
export function applyFrameZoom(frame, percent) {
    const factor = zoomFactor(percent);
    const doc = sameOriginDocument(frame);
    if (!doc || factor === null) return false;
    const scroller = doc.scrollingElement || doc.documentElement;
    const span = scroller.scrollHeight - scroller.clientHeight;
    const ratio = span > 0 ? scroller.scrollTop / span : 0;
    let style = doc.querySelector(`style[${FRAME_ZOOM_ATTR}]`);
    if (!style) {
        style = doc.createElement('style');
        style.setAttribute(FRAME_ZOOM_ATTR, '');
        (doc.head || doc.documentElement).append(style);
    }
    style.textContent = `html { zoom: ${factor}; }`;
    scroller.scrollTop = ratio * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    return true;
}

/**
 * 建一个视图帧但不挂载：调用方可先隐藏装载、load 后再替换旧帧（Markdown 编辑器的实时预览据此避免闪烁）。
 * sandbox 规则同 mountFrame：srcdoc 帧只放开 allow-popups（sameOrigin 时加 allow-same-origin），从不放开脚本；src 帧（PDF）不带 sandbox。
 * appearance 见 FRAME_APPEARANCES 注释：写入 data-appearance 供 CSS 取帧底色；仅 'adaptive' 的 srcdoc 帧注入深色覆盖样式。
 * layout 见 FRAME_LAYOUT_STYLES，zoom 见 withFrameZoom：均只注入 srcdoc 帧，缺省不注入。
 */
export function createViewFrame({ srcdoc = null, src = null, title = '预览', scrollbar = false, sameOrigin = false, layout = null, zoom = null, appearance = null } = {}) {
    const frame = document.createElement('iframe');
    frame.className = 'view-frame';
    frame.title = title;
    frame.referrerPolicy = 'no-referrer';
    if (FRAME_APPEARANCES.includes(appearance)) frame.dataset.appearance = appearance;
    if (src) frame.src = src;
    else {
        frame.setAttribute('sandbox', [FRAME_SANDBOX, sameOrigin ? 'allow-same-origin' : ''].filter(Boolean).join(' '));
        const scrolled = scrollbar ? withFrameScrollbar(srcdoc) : (srcdoc || '');
        const documentHtml = withFrameZoom(withFrameLayout(scrolled, layout), zoom);
        frame.srcdoc = appearance === 'adaptive' ? withFrameAppearance(documentHtml) : documentHtml;
    }
    return frame;
}

/** 每次换视图都重建 iframe：sandbox 属性无法在已加载的帧上切换，PDF 帧也应随视图关闭一并移除 */
export function mountFrame(host, options = {}) {
    host.replaceChildren();
    const frame = createViewFrame(options);
    host.append(frame);
    return frame;
}

/** 纯文本（XML 原文、Markdown 原文）包成一份可直接放进 srcdoc 的 HTML */
export function textDocument(text, { title = '原文' } = {}) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title><style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 16px 18px 40px; background: #ffffff; color: #1c1c1e; }
@media (prefers-color-scheme: dark) { body { background: #1c1c1e; color: #e6e6ea; } }
body > pre { margin: 0; background: none; font: 12.5px/1.7 ui-monospace, "SF Mono", Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
</style></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
}

let seq = 0;
export function nextId(prefix = 'id') {
    seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${seq}`;
}
