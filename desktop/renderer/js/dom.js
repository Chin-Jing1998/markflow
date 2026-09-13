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
export const TYPE_LABELS = Object.freeze({ docx: 'Word', xlsx: 'Excel', pptx: 'PowerPoint', pdf: 'PDF', md: 'Markdown', url: '网页' });
export const PHASE_LABELS = Object.freeze({ parsing: '解析中', rendering: '渲染中', writing: '写入中', done: '已完成', failed: '失败' });
export const STATUS_LABELS = Object.freeze({ idle: '待转换', queued: '排队中', running: '转换中', done: '已完成', failed: '失败', cancelled: '已取消' });
export const THEME_LABELS = Object.freeze({ system: '跟随系统', light: '浅色', dark: '深色' });

export const targetLabel = (target) => TARGET_LABELS[target] || String(target || '').toUpperCase();
export const typeLabel = (type) => TYPE_LABELS[type] || String(type || '');

/** 输入类型 → 目标类别（与 converters/targets.INPUT_CLASS 一致） */
export const INPUT_CLASS = Object.freeze({ docx: 'office', xlsx: 'office', pptx: 'office', pdf: 'office', md: 'markup', url: 'url' });

export function classOf(type) {
    return INPUT_CLASS[type] || null;
}

// ---------- 视图帧（对比预览与阅读模式共用） ----------

/**
 * 产物与来源一律放 <iframe sandbox srcdoc>：沙箱帧继承本页 CSP，内联脚本与 javascript: 被拦，
 * 远程图在请求前就被 img-src 拦掉。只放开 allow-popups，使帧内的 target="_blank" 外链
 * 走主窗口的 setWindowOpenHandler → shell.openExternal；不放开 allow-scripts。
 * PDF 例外：交 Chromium 内置阅读器的 iframe 不得带 sandbox，否则整帧被 ERR_BLOCKED_BY_CLIENT 拦掉。
 */
export const FRAME_SANDBOX = 'allow-popups';

/** 每次换视图都重建 iframe：sandbox 属性无法在已加载的帧上切换，PDF 帧也应随视图关闭一并移除 */
export function mountFrame(host, { srcdoc = null, src = null, title = '预览' }) {
    host.replaceChildren();
    const frame = document.createElement('iframe');
    frame.className = 'view-frame';
    frame.title = title;
    frame.referrerPolicy = 'no-referrer';
    if (src) frame.src = src;
    else {
        frame.setAttribute('sandbox', FRAME_SANDBOX);
        frame.srcdoc = srcdoc || '';
    }
    host.append(frame);
    return frame;
}

/** 纯文本（XML 原文、Markdown 原文）包成一份可直接放进 srcdoc 的 HTML */
export function textDocument(text, { title = '原文' } = {}) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title><style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 16px 18px 40px; background: #ffffff; color: #1c1c1e; }
@media (prefers-color-scheme: dark) { body { background: #1c1c1e; color: #e6e6ea; } }
pre { margin: 0; font: 12.5px/1.7 ui-monospace, "SF Mono", Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }
</style></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
}

let seq = 0;
export function nextId(prefix = 'id') {
    seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${seq}`;
}
