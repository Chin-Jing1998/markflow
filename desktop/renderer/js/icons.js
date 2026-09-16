/**
 * 行内 SVG 图标（线性风格，24 视口，stroke 取 currentColor）；不依赖外部 sprite 或字体。
 * icon(name, className) → 可直接插入 innerHTML 的字符串；未知名称返回空串。
 */
const PATHS = Object.freeze({
    convert: '<path d="M4 7h11l-3-3"/><path d="M20 17H9l3 3"/><path d="M4 7l3 3"/><path d="M20 17l-3-3"/>',
    library: '<path d="M4 4h4v16H4z"/><path d="M10 4h4v16h-4z"/><path d="M16.5 5.2l3.8-1 4 15.5-3.8 1z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    reader: '<path d="M2 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H2z"/><path d="M22 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z"/>',
    preview: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    folderOpen: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 10h18l-2 8H5z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    upload: '<path d="M12 16V4"/><path d="M6 10l6-6 6 6"/><path d="M4 20h16"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    x: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    spinner: '<path d="M12 3a9 9 0 1 0 9 9"/>',
    star: '<path d="M12 3.5l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 10l6.1-.9z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    sort: '<path d="M5 7h14"/><path d="M5 12h10"/><path d="M5 17h6"/>',
    filter: '<path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/>',
    folderMove: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v3"/><path d="M3 10h10"/><path d="M15 16h6"/><path d="M18 13l3 3-3 3"/><path d="M3 10l2 8h7"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
    open: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    warning: '<path d="M12 3l10 18H2z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.9 4.9l1.4 1.4"/><path d="M17.7 17.7l1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M4.9 19.1l1.4-1.4"/><path d="M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    tag: '<path d="M3 12V4h8l9 9-8 8z"/><path d="M7.5 7.5h.01"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9"/><path d="M16 4l3 3"/><path d="M13 7l3 3"/>',
    move: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 6.8"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/>',
    more: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
    expandAll: '<path d="M7 8l5 4 5-4"/><path d="M7 13l5 4 5-4"/>',
    collapseAll: '<path d="M7 16l5-4 5 4"/><path d="M7 11l5-4 5 4"/>',
    locate: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/>',
    panelLeftClose: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m14 9-3 3 3 3"/>',
    panelLeftOpen: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><path d="m13 9 3 3-3 3"/>',
    // 顶部栏文档功能：后退 / 前进、大纲、文档内查找（带放大镜的文档，与文件树搜索的放大镜区分）
    chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
    chevronRight: '<path d="M9 5l7 7-7 7"/>',
    chevronUp: '<path d="M5 15l7-7 7 7"/>',
    chevronDown: '<path d="M5 9l7 7 7-7"/>',
    outline: '<path d="M4 5h16"/><path d="M8 10h12"/><path d="M8 15h12"/><path d="M12 20h8"/>',
    findInPage: '<path d="M19 11V8l-5-5H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4"/><path d="M14 3v5h5"/><circle cx="16.5" cy="16.5" r="2.8"/><path d="M18.6 18.6L21 21"/>',
    // Markdown 编辑器工具栏
    bold: '<path d="M7 5h5.5a3.5 3.5 0 0 1 0 7H7z"/><path d="M7 12h6.5a3.5 3.5 0 0 1 0 7H7z"/>',
    italic: '<path d="M10 5h8"/><path d="M6 19h8"/><path d="M14 5l-4 14"/>',
    underline: '<path d="M7 4v7a5 5 0 0 0 10 0V4"/><path d="M5 20h14"/>',
    strikethrough: '<path d="M4 12h16"/><path d="M16.5 7.5C15.8 6 14.2 5 12 5 9.5 5 7.5 6.3 7.5 8.3c0 1.5 1.1 2.4 2.8 3"/><path d="M8 16.3c.6 1.6 2.2 2.7 4.3 2.7 2.6 0 4.2-1.3 4.2-3.3 0-.6-.1-1.2-.5-1.7"/>',
    code: '<path d="M8.5 7.5L4 12l4.5 4.5"/><path d="M15.5 7.5L20 12l-4.5 4.5"/>',
    codeBlock: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9.5 9.5L7 12l2.5 2.5"/><path d="M14.5 9.5L17 12l-2.5 2.5"/>',
    quote: '<path d="M5 5v14"/><path d="M9 7h10"/><path d="M9 12h10"/><path d="M9 17h7"/>',
    listBullet: '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1" fill="currentColor" stroke="none"/>',
    listOrdered: '<path d="M10 6h10"/><path d="M10 12h10"/><path d="M10 18h10"/><path d="M4 4.5l1.5-.8V9"/><path d="M3.7 14.3a1.4 1.4 0 0 1 2.6.7c0 1-2.6 2-2.6 3.5h2.8"/>',
    listTask: '<rect x="3.5" y="4" width="5.5" height="5.5" rx="1.2"/><path d="M4.3 17l1.5 1.5 2.7-3"/><path d="M12 6.8h8.5"/><path d="M12 16.8h8.5"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18"/><path d="M3 14.8h18"/><path d="M9.5 9.5V20"/><path d="M14.5 9.5V20"/>',
    horizontalRule: '<path d="M3 12h18"/><path d="M7 6.5h10"/><path d="M7 17.5h10"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.8"/><path d="M21 15.5l-5-5L5.5 20"/>',
    footnote: '<path d="M4 8h9"/><path d="M4 13h12"/><path d="M4 18h8"/><path d="M17.5 3.5l1.5-.8V8"/><path d="M16.8 8h3.4"/>',
});

export function icon(name, className = '') {
    const body = PATHS[name];
    if (!body) return '';
    const cls = className ? `icon ${className}` : 'icon';
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export const ICON_NAMES = Object.freeze(Object.keys(PATHS));
