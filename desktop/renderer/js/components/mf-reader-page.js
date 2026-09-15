/**
 * <mf-reader-page>：阅读页 —— 直接打开 md / html / xml / pdf（方案 §3.4.6）
 *
 * 视图由主进程 mf:reader:open 构建：md 经 parsers/md + reader 主题渲染，html 经 html-sanitize 清洗，
 * xml 给「结构视图 / 原文」两个页签，pdf 交 Chromium 内置阅读器。图片一律走 mf-asset://<sid>/，
 * 远程图与脚本在渲染前就已被拦掉。菜单「打开文件…」选中这四类文件时经 mf:preview:event 推到这里。
 *
 * 左侧栏：打开记录按所在文件夹分组展示；顶部工具行（排序 / 自动显示当前文件 / 全部展开）与顶部状态栏的
 * 搜索 / 仅显示收藏 / 折叠侧栏三个按钮，均照搬文件库页同名功能（收藏为本地打开记录独立维护，与文件库记录无关）。
 */
import { store } from '../store.js';
import { api, onPreviewEvent } from '../api.js';
import { icon } from '../icons.js';
import { escapeHtml, escapeAttr, mountFrame, textDocument } from '../dom.js';
import {
    EMPTY_HISTORY, visitHistory, findHistoryStep, canStepHistory, moveHistory,
    extractMarkdownOutline, extractHtmlOutline, outlineHintFor, toSaveState, docLocation, stepZoom,
} from '../doc-tools.mjs';
import {
    readDocZoom, writeDocZoom, prepareDocFrame, bindEditorPreviewFrames, applyDocZoom, findInView, endFindInView, gotoOutlineItem,
} from '../doc-view.js';
import { readOpenHistory, rememberOpenFile, toggleFavoriteOpenFile } from '../reader-history.js';
import { notify } from './mf-toast.js';
import './mf-md-editor.js';

const SIDEBAR_WIDTH = Object.freeze({ min: 220, max: 320, default: 220 });
// 排序菜单：打开记录没有独立时间戳，「打开时间」即历史数组的原始顺序（最近打开的在前）。
const SORT_MENU_OPTIONS = Object.freeze([
    ['name', 'asc', '文件名（A-Z）'],
    ['name', 'desc', '文件名（Z-A）'],
    ['opened', 'desc', '打开时间（从新到旧）'],
    ['opened', 'asc', '打开时间（从旧到新）'],
]);

function folderOf(path) {
    const normalized = String(path || '').replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    return idx > 0 ? normalized.slice(0, idx) : '';
}

function folderLabel(folder) {
    if (!folder) return '其他文件';
    const idx = folder.lastIndexOf('/');
    return idx >= 0 ? folder.slice(idx + 1) : folder;
}

/** 按所在文件夹分组，组内顺序沿用传入顺序；分组先后顺序取各组第一次出现的位置。 */
function groupByFolder(entries) {
    const groups = new Map();
    for (const entry of entries) {
        const folder = folderOf(entry.path);
        if (!groups.has(folder)) groups.set(folder, []);
        groups.get(folder).push(entry);
    }
    return groups;
}

class MfReaderPage extends HTMLElement {
    constructor() {
        super();
        this.tab = 'rendered';
        this.state = { query: '', sort: 'opened', order: 'desc', sortMenuOpen: false, revealActiveFile: false };
        this.currentPath = '';
        this.openHistory = [];
        this.resizeState = null;
        // 折叠侧栏 / 仅显示收藏 / 搜索面板展开：由顶部状态栏的按钮驱动，状态存于全局 store，这里只记「上次已同步到的值」用于去重。
        this.seenSidebarCollapsed = false;
        this.seenFavoritesOnly = false;
        this.seenSearchOpen = false;
        // md 编辑：一个编辑器随会话替换；帧键（会话 | 页签 | 视图版本）未变时不重建 iframe
        this.editor = null;
        this.viewRev = 0;
        this.refreshSeq = 0;
        this.frameKey = '';
        this.mdStatus = null;
        // 顶部栏文档功能：本次会话打开过的路径（后退 / 前进）、文档字号（百分比，与文件库页共用 localStorage）、上次发布到 store 的文档状态
        this.navHistory = EMPTY_HISTORY;
        this.docZoom = readDocZoom();
        this.publishedDoc = '';
    }

    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.openHistory = readOpenHistory();
        this.innerHTML = `
            <div class="page-body page-layout reader-body">
                <aside class="page-sidebar reader-sidebar" aria-label="打开文件历史">
                    <div class="library-sidebar-top">
                        <div class="library-sidebar-tools-row" aria-label="阅读页操作">
                            <div class="library-sort-switcher" data-role="reader-sort-switcher"></div>
                            <button class="icon-btn icon-btn-sm" type="button" data-action="toggle-reveal-active" data-role="reveal-toggle" title="自动显示当前文件" aria-label="自动显示当前文件" aria-pressed="false">${icon('locate')}</button>
                            <button class="icon-btn icon-btn-sm" type="button" data-action="toggle-expand-all" data-role="expand-toggle" title="全部展开" aria-label="全部展开">${icon('expandAll')}</button>
                        </div>
                        <div class="library-sidebar-tool-panel library-search-tools" data-role="search-panel" hidden>
                            <label class="search library-sidebar-search"><span class="search-icon">${icon('search')}</span><input type="search" placeholder="搜索打开记录" data-role="query" spellcheck="false"></label>
                        </div>
                    </div>
                    <div class="library-sidebar-divider"></div>
                    <div class="library-tree" data-role="reader-tree"></div>
                </aside>
                <div class="sidebar-resize-handle" data-role="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="调整阅读页侧栏宽度" aria-valuemin="${SIDEBAR_WIDTH.min}" aria-valuemax="${SIDEBAR_WIDTH.max}" aria-valuenow="${SIDEBAR_WIDTH.default}" tabindex="0"></div>
                <section class="reader-main">
                    <section class="compare-empty" data-role="empty">
                        <div class="dropzone-icon">${icon('reader')}</div>
                        <h3>直接打开阅读</h3>
                        <p>支持 Markdown、HTML、XML 与 PDF：图片按原位显示，脚本与远程资源一律拦截，外链交系统浏览器打开。</p>
                        <div class="dropzone-actions"><button class="btn btn-primary" type="button" data-action="pick">${icon('file')}选择文件…</button></div>
                        <p class="compare-error" data-role="error" hidden></p>
                    </section>
                    <div class="reader-frame" data-role="frame" hidden></div>
                    <div class="md-editor-host" data-role="editor-host" hidden></div>
                    <div class="compare-busy" data-role="busy" hidden><span class="spinner">${icon('spinner')}</span><span>正在打开…</span></div>
                </section>
            </div>
            `;
        this.bindSidebarResizer();
        this.querySelector('[data-role="query"]').addEventListener('input', (event) => {
            this.state.query = event.target.value;
            this.renderTree(this.currentPath);
        });
        this.addEventListener('click', (event) => this.onClick(event));
        // md 编辑器：保存状态经 store.readerDoc 显示在顶部栏标题旁；保存成功同步「Markdown 原文」；「重新载入」丢弃修改并按同路径重开
        this.addEventListener('mf-md-status', (event) => this.onMdStatus(event.detail));
        this.addEventListener('mf-md-saved', (event) => this.onMdSaved(event.detail));
        this.addEventListener('mf-md-reload-request', () => this.reloadCurrent());
        // 顶部栏文档命令；编辑器实时预览帧装载时补注紧凑版式与字号
        this.onDocCommandEvent = (event) => this.onDocCommand(event.detail);
        window.addEventListener('mf-doc-command', this.onDocCommandEvent);
        const editorHost = this.querySelector('[data-role="editor-host"]');
        bindEditorPreviewFrames(editorHost, () => this.docZoom);
        applyDocZoom({ editorHost }, this.docZoom);
        // <details> 的 toggle 事件不冒泡，只能在捕获阶段接住；用户手动展开/折叠单个文件夹时同步展开/折叠按钮。
        this.querySelector('[data-role="reader-tree"]').addEventListener('toggle', () => this.syncExpandToggle(), true);
        this.addEventListener('pointerdown', (event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target || !target.closest('[data-role="reader-sort-switcher"]')) this.closeSortMenu();
        });
        this.unsubs = [
            store.subscribe((state) => {
                if (state.readerSidebarCollapsed !== this.seenSidebarCollapsed) {
                    this.seenSidebarCollapsed = state.readerSidebarCollapsed;
                    this.syncSidebarCollapse();
                }
                if (state.readerFavoritesOnly !== this.seenFavoritesOnly) {
                    this.seenFavoritesOnly = state.readerFavoritesOnly;
                    this.renderTree(this.currentPath);
                }
                if (state.readerSearchOpen !== this.seenSearchOpen) {
                    this.seenSearchOpen = state.readerSearchOpen;
                    this.syncSearchPanel();
                }
                this.sync(state);
            }),
            onPreviewEvent((payload) => this.onPush(payload)),
            () => window.removeEventListener('mf-doc-command', this.onDocCommandEvent),
        ];
        this.renderSortMenu();
        this.sync(store.get());
    }

    disconnectedCallback() {
        for (const off of this.unsubs || []) off();
        this.endSidebarResize();
    }

    bindSidebarResizer() {
        const handle = this.querySelector('[data-role="sidebar-resizer"]');
        if (!handle) return;
        handle.addEventListener('pointerdown', (event) => {
            const sidebar = this.querySelector('.reader-sidebar');
            if (!sidebar) return;
            event.preventDefault();
            this.resizeState = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebar.getBoundingClientRect().width };
            handle.setPointerCapture(event.pointerId);
            this.querySelector('.reader-body').classList.add('is-resizing');
            document.body.classList.add('is-resizing-sidebar');
        });
        handle.addEventListener('pointermove', (event) => {
            if (!this.resizeState || event.pointerId !== this.resizeState.pointerId) return;
            const width = Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, this.resizeState.startWidth + event.clientX - this.resizeState.startX));
            const body = this.querySelector('.reader-body');
            body.style.setProperty('--reader-sidebar-width', `${Math.round(width)}px`);
            handle.setAttribute('aria-valuenow', String(Math.round(width)));
        });
        handle.addEventListener('pointerup', (event) => {
            if (this.resizeState && event.pointerId === this.resizeState.pointerId) this.endSidebarResize();
        });
        handle.addEventListener('pointercancel', () => this.endSidebarResize());
        handle.addEventListener('lostpointercapture', () => {
            if (this.resizeState) this.endSidebarResize();
        });
        handle.addEventListener('keydown', (event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const body = this.querySelector('.reader-body');
            const handleWidth = Number(handle.getAttribute('aria-valuenow')) || SIDEBAR_WIDTH.default;
            const delta = event.key === 'ArrowLeft' ? -16 : 16;
            const width = Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, handleWidth + delta));
            body.style.setProperty('--reader-sidebar-width', `${width}px`);
            handle.setAttribute('aria-valuenow', String(width));
        });
    }

    endSidebarResize() {
        if (!this.resizeState) return;
        this.resizeState = null;
        const body = this.querySelector('.reader-body');
        if (body) body.classList.remove('is-resizing');
        document.body.classList.remove('is-resizing-sidebar');
    }

    /** 折叠/展开侧栏：折叠按钮在顶部状态栏（跨组件，经 store 驱动），这里只负责按当前状态切换侧栏与拖拽手柄的显隐。 */
    syncSidebarCollapse() {
        const body = this.querySelector('.reader-body');
        if (!body) return;
        body.classList.toggle('is-sidebar-collapsed', store.get().readerSidebarCollapsed);
    }

    /** 搜索面板的展开/收起按钮同样在顶部状态栏，这里只负责显隐输入框并在展开时聚焦。 */
    syncSearchPanel() {
        const panel = this.querySelector('[data-role="search-panel"]');
        if (!panel) return;
        const open = store.get().readerSearchOpen;
        panel.hidden = !open;
        if (open) this.querySelector('[data-role="query"]')?.focus();
    }

    /** 路由切到本页时由 app.js 调用：字号可能已在文件库页改过，先读回并作用到当前帧与编辑器 */
    refresh() {
        this.docZoom = readDocZoom();
        this.applyZoom();
        this.sync(store.get());
    }

    onPush(payload) {
        if (!payload || payload.type !== 'reader-open' || !payload.path) return;
        if (location.hash !== '#/reader') location.hash = '#/reader';
        if (Array.isArray(payload.pending) && payload.pending.length > 0) {
            notify(`阅读模式一次显示一份文件，其余 ${payload.pending.length} 个已跳过`, 'info');
        }
        this.open(payload.path);
    }

    async onClick(event) {
        const favoriteButton = event.target instanceof Element ? event.target.closest('[data-favorite-path]') : null;
        if (favoriteButton) {
            this.openHistory = toggleFavoriteOpenFile(favoriteButton.dataset.favoritePath);
            this.renderTree(this.currentPath);
            this.publishDoc();
            return;
        }
        const historyFile = event.target instanceof Element ? event.target.closest('[data-history-path]') : null;
        if (historyFile) {
            await this.open(historyFile.dataset.historyPath);
            return;
        }
        const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
        if (!button) return;
        const action = button.dataset.action;
        if (action === 'pick') await this.pick();
        else if (action === 'toggle-sort-menu') {
            this.state.sortMenuOpen = !this.state.sortMenuOpen;
            this.renderSortMenu();
            if (this.state.sortMenuOpen) this.querySelector('[data-action="toggle-sort-menu"]')?.focus();
        } else if (action === 'select-sort') {
            const { sortField, sortOrder } = button.dataset;
            if (sortField && sortOrder) {
                this.state.sort = sortField;
                this.state.order = sortOrder;
            }
            this.state.sortMenuOpen = false;
            this.renderSortMenu();
            this.renderTree(this.currentPath);
        } else if (action === 'toggle-reveal-active') {
            this.state.revealActiveFile = !this.state.revealActiveFile;
            this.querySelector('[data-role="reveal-toggle"]')?.setAttribute('aria-pressed', String(this.state.revealActiveFile));
            this.revealActiveFileInTree();
        } else if (action === 'toggle-expand-all') {
            const tree = this.querySelector('[data-role="reader-tree"]');
            const nodes = tree ? [...tree.querySelectorAll('details.library-tree-node')] : [];
            const allOpen = nodes.length > 0 && nodes.every((node) => node.open);
            this.setAllTreeFolders(!allOpen);
        }
    }

    async pick() {
        try {
            const picked = await api.pickFiles({ purpose: 'read' });
            if (picked.canceled || picked.paths.length === 0) return;
            await this.open(picked.paths[0]);
        } catch (err) {
            notify(err.message, 'error');
        }
    }

    /**
     * 打开新文件前先关旧会话：撤销 mf-asset 授权并删掉临时目录。
     * 当前 md 有修改时先落盘，落盘失败须用户确认才丢弃；skipGuard 供「重新载入」直接丢弃修改。
     * fromHistory：顶部栏后退 / 前进触发，不再记入导航历史（游标由调用方在打开成功后移动）。回 true 表示已打开。
     */
    async open(path, { skipGuard = false, tab = 'rendered', fromHistory = false } = {}) {
        if (!skipGuard && !(await this.guardEditor('当前文件的修改尚未保存，仍要打开其他文件并放弃这些修改？'))) return false;
        const previous = store.get().reader;
        store.set({ readerBusy: true, readerError: '' });
        try {
            const opened = await api.readerOpen({ path });
            this.disposeEditor();
            this.tab = tab;
            this.viewRev += 1;
            if (!fromHistory) this.navHistory = visitHistory(this.navHistory, opened.path || path);
            store.set({ reader: opened, readerBusy: false });
            this.openHistory = rememberOpenFile(opened.path || path, opened.name);
            this.renderTree(opened.path || path);
            if (previous) api.previewClose(previous.sessionId).catch(() => undefined);
            for (const warning of opened.warnings || []) notify(warning, 'warning', 6000);
            return true;
        } catch (err) {
            this.disposeEditor();
            store.set({ readerBusy: false, readerError: err.message, reader: null });
            notify(err.message, 'error', 6000);
            return false;
        }
    }

    async close() {
        if (!(await this.guardEditor('当前文件的修改尚未保存，仍要关闭并放弃这些修改？'))) return;
        const reader = store.get().reader;
        this.disposeEditor();
        store.set({ reader: null, readerError: '' });
        if (reader) await api.previewClose(reader.sessionId).catch(() => undefined);
    }

    // ---------- Markdown 编辑 ----------

    /** 有编辑器时先 flush；落盘失败（冲突或出错）须用户确认才放弃修改 */
    async guardEditor(message) {
        const editor = this.editor;
        if (!editor || !editor.sessionId) return true;
        if (await editor.flush()) return true;
        return window.confirm(message);
    }

    disposeEditor() {
        if (this.editor) {
            this.editor.dispose();
            this.editor.remove();
            this.editor = null;
        }
        this.mdStatus = null;
    }

    /** 一个编辑器随会话替换：会话变了就销毁旧的、按新会话的原文重建 */
    ensureEditor(reader) {
        if (this.editor && this.editor.sessionId === reader.sessionId) return this.editor;
        this.disposeEditor();
        const editor = document.createElement('mf-md-editor');
        editor.frameAppearance = 'adaptive';
        editor.showStatus = false;
        editor.sessionId = reader.sessionId;
        this.querySelector('[data-role="editor-host"]').append(editor);
        this.editor = editor;
        editor.setContent(reader.view.raw || '', { html: reader.view.html || '' });
        return editor;
    }

    async refreshRendered(reader) {
        this.refreshSeq += 1;
        const seq = this.refreshSeq;
        const editor = this.editor && this.editor.sessionId === reader.sessionId ? this.editor : null;
        try {
            const result = await api.mdRender({ sessionId: reader.sessionId, ...(editor ? { text: editor.value } : {}) });
            const current = store.get().reader;
            if (seq !== this.refreshSeq || !current || current.sessionId !== reader.sessionId || !result) return;
            if (typeof result.html === 'string' && result.html !== current.view.html) {
                this.viewRev += 1;
                store.set({ reader: { ...current, view: { ...current.view, html: result.html } } });
            }
        } catch (err) {
            // 会话已关闭等：保持现有视图
        }
    }

    /** 编辑器保存状态 → store.readerDoc.saveState，顶部栏显示在标题旁 */
    onMdStatus(detail) {
        this.mdStatus = toSaveState(detail);
        this.publishDoc();
    }

    onMdSaved(detail) {
        const reader = store.get().reader;
        if (!reader || !detail || typeof detail.text !== 'string' || !this.editor || this.editor.sessionId !== reader.sessionId) return;
        this.viewRev += 1;
        store.set({ reader: { ...reader, view: { ...reader.view, raw: detail.text } } });
        for (const warning of (detail.result && detail.result.warnings) || []) notify(warning, 'warning', 6000);
    }

    /** 「重新载入」：丢弃编辑器里的修改，按同路径重开并停在「编辑」页签 */
    async reloadCurrent() {
        const reader = store.get().reader;
        if (!reader) return;
        this.disposeEditor();
        await this.open(reader.path, { skipGuard: true, tab: 'edit' });
    }

    /** 排序菜单：字段 + 方向，与文件库页同款下拉。 */
    renderSortMenu() {
        const host = this.querySelector('[data-role="reader-sort-switcher"]');
        if (!host) return;
        const expanded = this.state.sortMenuOpen;
        const items = SORT_MENU_OPTIONS.map(([field, order, label]) => {
            const current = this.state.sort === field && this.state.order === order;
            return `
                    <button class="library-sort-menu-item${current ? ' is-current' : ''}" type="button" role="menuitemradio" aria-checked="${current}" data-action="select-sort" data-sort-field="${field}" data-sort-order="${order}">
                        <span class="library-sort-menu-check" aria-hidden="true">${current ? '✓' : ''}</span><span class="library-sort-menu-label">${escapeHtml(label)}</span>
                    </button>`;
        }).join('');
        host.innerHTML = `
                <button class="icon-btn icon-btn-sm" type="button" data-action="toggle-sort-menu" title="排序" aria-label="排序" aria-haspopup="menu" aria-expanded="${expanded}">${icon('sort')}</button>
                <div class="library-sort-menu" data-role="sort-menu" role="menu" aria-label="排序方式"${expanded ? '' : ' hidden'}>
                    <div class="library-sort-menu-title">排序方式</div>
                    ${items}
                </div>`;
        if (expanded) this.clampSortMenuPosition();
    }

    /** 工具栏图标行居中后，排序按钮位置随侧栏宽度浮动；侧栏窄到最小宽度时菜单可能溢出，按几何位置纠偏。 */
    clampSortMenuPosition() {
        const menu = this.querySelector('[data-role="sort-menu"]');
        const sidebar = this.querySelector('.reader-sidebar');
        if (!menu || !sidebar) return;
        menu.style.transform = '';
        const margin = 8;
        const sidebarRect = sidebar.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        let shift = 0;
        if (menuRect.right > sidebarRect.right - margin) shift = (sidebarRect.right - margin) - menuRect.right;
        if (menuRect.left + shift < sidebarRect.left + margin) shift = (sidebarRect.left + margin) - menuRect.left;
        if (shift) menu.style.transform = `translateX(${Math.round(shift)}px)`;
    }

    closeSortMenu() {
        if (!this.state.sortMenuOpen) return;
        this.state.sortMenuOpen = false;
        this.renderSortMenu();
    }

    /** 侧栏树的文件夹节点统一用 <details>，展开/折叠全部只需批量置 open，无需重新渲染。 */
    setAllTreeFolders(open) {
        const tree = this.querySelector('[data-role="reader-tree"]');
        if (!tree) return;
        for (const node of tree.querySelectorAll('details.library-tree-node')) node.open = open;
        this.syncExpandToggle();
    }

    /** 展开/折叠合并为一个按钮：图标与文案按「当前是否已全部展开」决定下一次点击的动作。 */
    syncExpandToggle() {
        const button = this.querySelector('[data-role="expand-toggle"]');
        if (!button) return;
        const tree = this.querySelector('[data-role="reader-tree"]');
        const nodes = tree ? [...tree.querySelectorAll('details.library-tree-node')] : [];
        const allOpen = nodes.length > 0 && nodes.every((node) => node.open);
        const label = allOpen ? '全部折叠' : '全部展开';
        button.innerHTML = icon(allOpen ? 'collapseAll' : 'expandAll');
        button.title = label;
        button.setAttribute('aria-label', label);
        button.disabled = nodes.length === 0;
    }

    sortEntries(entries) {
        const sorted = [...entries];
        if (this.state.sort === 'name') {
            sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
            if (this.state.order === 'desc') sorted.reverse();
        } else if (this.state.order === 'asc') {
            sorted.reverse();
        }
        return sorted;
    }

    renderTree(activePath = '') {
        this.currentPath = activePath;
        this.renderTreeContent();
        this.syncExpandToggle();
        this.revealActiveFileInTree();
    }

    renderTreeContent() {
        const tree = this.querySelector('[data-role="reader-tree"]');
        if (!tree) return;
        this.openHistory = readOpenHistory();
        const favoritesOnly = store.get().readerFavoritesOnly;
        const query = this.state.query.trim().toLowerCase();
        let entries = this.openHistory;
        if (favoritesOnly) entries = entries.filter((item) => item.favorite);
        if (query) entries = entries.filter((item) => item.name.toLowerCase().includes(query) || item.path.toLowerCase().includes(query));
        if (entries.length === 0) {
            const empty = favoritesOnly ? '暂无收藏的打开记录' : (query ? '未找到匹配的打开记录' : '暂无打开记录');
            tree.innerHTML = `<div class="facets-empty">${empty}</div>`;
            return;
        }
        entries = this.sortEntries(entries);
        const groups = [...groupByFolder(entries)];
        if (this.state.sort === 'name') groups.sort((a, b) => folderLabel(a[0]).localeCompare(folderLabel(b[0]), 'zh-Hans-CN'));
        tree.innerHTML = groups.map(([folder, items]) => this.folderGroupTree(folder, items)).join('');
    }

    folderGroupTree(folder, items) {
        const files = items.map((item) => this.fileRowTemplate(item)).join('');
        return `
            <details class="library-tree-node library-tree-project" open>
                <summary title="${escapeAttr(folder)}"><span class="library-tree-summary-main">${icon('folder')}<span class="library-tree-label">${escapeHtml(folderLabel(folder))}</span></span><span class="library-tree-count">${items.length}</span></summary>
                <div class="library-tree-children">${files}</div>
            </details>`;
    }

    fileRowTemplate(item) {
        return `
            <div class="reader-tree-file-row">
                <button class="library-tree-file" type="button" data-history-path="${escapeAttr(item.path)}" title="${escapeAttr(item.path)}" aria-label="打开 ${escapeAttr(item.name)}">
                    ${icon('file')}<span class="library-tree-label">${escapeHtml(item.name)}</span>
                </button>
                <button class="star${item.favorite ? ' is-on' : ''} icon-btn-sm" type="button" data-favorite-path="${escapeAttr(item.path)}" title="${item.favorite ? '取消收藏' : '收藏'}" aria-label="${item.favorite ? '取消收藏' : '收藏'}">${icon('star')}</button>
            </div>`;
    }

    /** 「自动显示当前文件」开启时，随当前打开的文件在侧栏树中展开所在文件夹并高亮、滚动可见；参考文件库页同名功能。 */
    revealActiveFileInTree() {
        const tree = this.querySelector('[data-role="reader-tree"]');
        if (!tree) return;
        for (const button of tree.querySelectorAll('.library-tree-file.is-active-file')) button.classList.remove('is-active-file');
        if (!this.state.revealActiveFile || !this.currentPath) return;
        const target = tree.querySelector(`[data-history-path="${CSS.escape(this.currentPath)}"]`);
        if (!target) return;
        target.classList.add('is-active-file');
        for (let node = target.closest('details.library-tree-node'); node; node = node.parentElement ? node.parentElement.closest('details.library-tree-node') : null) node.open = true;
        target.scrollIntoView({ block: 'nearest' });
        this.syncExpandToggle();
    }

    tabsFor(view) {
        if (!view) return [];
        if (view.kind === 'xml') return view.structuredHtml ? [['rendered', '结构视图'], ['raw', 'XML 原文']] : [['raw', 'XML 原文']];
        if (view.kind === 'md') return [['rendered', '渲染'], ['raw', '原文'], ['edit', '编辑']];
        return [];
    }

    /** 视图页签（在顶部栏）与文档状态（store.readerDoc）随 sync 一并更新；页面自身不再有页脚 */
    sync(state) {
        const reader = state.reader;
        const view = reader && reader.view;
        this.renderTree(reader && reader.path);
        const frameHost = this.querySelector('[data-role="frame"]');
        const editorHost = this.querySelector('[data-role="editor-host"]');
        this.querySelector('[data-role="empty"]').hidden = Boolean(reader);
        this.querySelector('[data-role="busy"]').hidden = !state.readerBusy;
        const error = this.querySelector('[data-role="error"]');
        error.hidden = !state.readerError || Boolean(reader);
        error.textContent = state.readerError || '';

        if (!reader) {
            frameHost.hidden = true;
            frameHost.replaceChildren();
            this.frameKey = '';
            editorHost.hidden = true;
            this.publishDoc();
            return;
        }

        const available = this.tabsFor(view);
        if (!available.some(([key]) => key === this.tab)) this.tab = available.length > 0 ? available[0][0] : 'rendered';
        const editing = Boolean(view) && view.kind === 'md' && this.tab === 'edit';
        frameHost.hidden = editing;
        editorHost.hidden = !editing;
        if (editing) this.ensureEditor(reader);
        else this.mount(view, reader);
        this.publishDoc();
    }

    /** 帧键（会话 | 页签 | 视图版本）未变时不重建 iframe：store 的任何变化都会走到 sync */
    mount(view, reader) {
        const host = this.querySelector('[data-role="frame"]');
        if (!view) {
            host.replaceChildren();
            this.frameKey = '';
            return;
        }
        const key = `${reader ? reader.sessionId : ''}|${this.tab}|${this.viewRev}`;
        if (key === this.frameKey && host.firstElementChild) return;
        this.frameKey = key;
        // srcdoc 帧为同源沙箱帧（仍不放开脚本）：顶部栏的查找、大纲定位与字号需读写帧内 DOM；PDF 帧交内置阅读器，不注入
        const mountReaderFrame = (options) => {
            const frame = mountFrame(host, { ...options, scrollbar: true, sameOrigin: !options.src, zoom: options.src ? null : this.docZoom });
            if (!options.src) prepareDocFrame(frame, () => this.docZoom);
            return frame;
        };
        if (view.kind === 'pdf') mountReaderFrame({ src: view.url, title: 'PDF 阅读器' });
        else if (view.kind === 'xml') {
            if (this.tab === 'rendered' && view.structuredHtml) mountReaderFrame({ srcdoc: view.structuredHtml, title: 'XML 结构视图', layout: 'compact-text' });
            else mountReaderFrame({ srcdoc: textDocument(view.xml || '', { title: 'XML 原文' }), title: 'XML 原文', layout: 'compact-text', appearance: 'adaptive' });
        } else if (view.kind === 'json') mountReaderFrame({ srcdoc: textDocument(view.json || '', { title: 'JSON' }), title: 'JSON 原文', layout: 'compact-text', appearance: 'adaptive' });
        else if (view.kind === 'md' && this.tab === 'raw') mountReaderFrame({ srcdoc: textDocument(view.raw || '', { title: 'Markdown 原文' }), title: 'Markdown 原文', layout: 'compact-text', appearance: 'adaptive' });
        else mountReaderFrame({ srcdoc: view.html || '', title: '阅读视图', layout: view.kind === 'md' ? 'compact' : null, appearance: view.kind === 'md' ? 'adaptive' : 'paper' });
    }

    // ---------- 顶部栏文档功能（状态经 store.readerDoc 发布，命令经 mf-doc-command 接收） ----------

    /** 切换视图页签：切回「渲染」时按编辑器当前文本（无编辑器则按磁盘）重取渲染，资产被回收后也能恢复图片，文本未变时主进程直接复用缓存 */
    switchView(key) {
        const reader = store.get().reader;
        if (!reader || key === this.tab || !this.tabsFor(reader.view).some(([value]) => value === key)) return;
        const previous = this.tab;
        this.tab = key;
        if (key === 'rendered' && previous !== 'rendered' && reader.kind === 'md') this.refreshRendered(reader);
        this.sync(store.get());
    }

    currentEditor(reader) {
        return this.editor && reader && this.editor.sessionId === reader.sessionId ? this.editor : null;
    }

    /** 查找与大纲定位的目标：编辑页为编辑区；其余为视图帧，md 原文按行定位，渲染视图与 XML 结构视图按标题元素定位 */
    viewContext() {
        const reader = store.get().reader;
        const view = reader && reader.view;
        if (!view) return null;
        if (view.kind === 'md' && this.tab === 'edit') {
            const editor = this.currentEditor(reader);
            return { mode: 'edit', textarea: editor ? editor.textarea : null, frame: null };
        }
        return { mode: view.kind === 'md' && this.tab === 'raw' ? 'raw' : 'rendered', frame: this.querySelector('[data-role="frame"] .view-frame'), textarea: null };
    }

    /** 大纲：md 在渲染与编辑页取编辑器当前文本（原文页取已保存的原文，与原文帧一致）；xml 只在结构视图取章节标题 */
    outlineFor(reader) {
        const view = reader && reader.view;
        if (!view) return [];
        if (view.kind === 'md') {
            const editor = this.currentEditor(reader);
            return extractMarkdownOutline(editor && this.tab !== 'raw' ? editor.value : view.raw);
        }
        if (view.kind === 'xml' && this.tab === 'rendered' && view.structuredHtml) return extractHtmlOutline(view.structuredHtml);
        return [];
    }

    buildDoc() {
        const reader = store.get().reader;
        if (!reader) return null;
        const view = reader.view || {};
        const kind = view.kind || reader.kind || '';
        const outline = this.outlineFor(reader);
        const entry = this.openHistory.find((item) => item.path === reader.path);
        return {
            sessionId: reader.sessionId,
            title: reader.name || reader.path,
            path: reader.path,
            ...docLocation(reader.path),
            kind,
            views: this.tabsFor(view),
            activeView: this.tab,
            canBack: canStepHistory(this.navHistory, -1),
            canForward: canStepHistory(this.navHistory, 1),
            favorite: Boolean(entry && entry.favorite),
            canFavorite: true,
            favoriteHint: '',
            canReconvert: false,
            canClose: true,
            hasOutline: outline.length > 0,
            outlineHint: outlineHintFor(kind, this.tab, outline.length),
            outline,
            canFind: kind !== 'pdf',
            canZoom: kind !== 'pdf',
            zoom: this.docZoom,
            saveState: kind === 'md' ? this.mdStatus : null,
        };
    }

    /** 文档状态序列化后与上次比较，未变不重复写 store（sync 在任何 store 变化时都会跑） */
    publishDoc() {
        const doc = this.buildDoc();
        const serialized = doc ? JSON.stringify(doc) : '';
        if (serialized === this.publishedDoc) return;
        this.publishedDoc = serialized;
        store.set({ readerDoc: doc });
    }

    onDocCommand(detail) {
        const reader = store.get().reader;
        if (!detail || detail.route !== 'reader' || !reader) return;
        switch (detail.command) {
            case 'back': this.navigate(-1); break;
            case 'forward': this.navigate(1); break;
            case 'view': this.switchView(detail.value); break;
            case 'outline': detail.result = this.outlineFor(reader); break;
            case 'outline-go': gotoOutlineItem(this.viewContext(), detail.value, this.outlineFor(reader)); break;
            case 'find': detail.result = findInView(this.viewContext(), detail.value || {}); break;
            case 'find-close': endFindInView(this.viewContext()); break;
            case 'zoom': this.changeZoom(detail.value); break;
            case 'favorite':
                this.openHistory = toggleFavoriteOpenFile(reader.path);
                this.renderTree(this.currentPath);
                this.publishDoc();
                break;
            case 'reveal':
            case 'open':
            case 'copyPath': this.runFileAction(reader.sessionId, detail.command); break;
            case 'close': this.close(); break;
            default: break;
        }
    }

    /** 后退 / 前进：按本次会话打开过的路径；打开成功（未被未保存修改的确认拦下）后才移动历史游标 */
    async navigate(direction) {
        const index = findHistoryStep(this.navHistory, direction);
        if (index < 0) return;
        if (await this.open(this.navHistory.entries[index], { fromHistory: true })) {
            this.navHistory = moveHistory(this.navHistory, index);
            this.publishDoc();
        }
    }

    /** 字号：先读回最新值（文件库页可能改过）再步进一档，写回 localStorage，当前帧与编辑器实时生效 */
    changeZoom(direction) {
        this.docZoom = writeDocZoom(stepZoom(readDocZoom(), direction));
        this.applyZoom();
        this.publishDoc();
    }

    applyZoom() {
        applyDocZoom({ frame: this.querySelector('[data-role="frame"] .view-frame'), editorHost: this.querySelector('[data-role="editor-host"]') }, this.docZoom);
    }

    async runFileAction(sessionId, action) {
        try {
            await api.fileAction(sessionId, action);
            if (action === 'copyPath') notify('已复制文件路径', 'success');
        } catch (err) {
            notify(err.message, 'error', 6000);
        }
    }
}

customElements.define('mf-reader-page', MfReaderPage);
