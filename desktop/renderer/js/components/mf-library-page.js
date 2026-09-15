/**
 * <mf-library-page>：文件库页 = 工具栏（搜索、排序、刷新、迁移）+ 托管目录树 + 记录列表。
 * 记录操作：收藏、标签、定位、打开、重新转换、删除（仅删记录 / 连同产物移到废纸篓）；
 * 左侧目录中的文件可在本页主区以标签页打开阅读。
 * 托管迁移先 dryRun 预览再执行。文件库模块未就绪时显示提示。
 */
import { store, addTasks } from '../store.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { escapeHtml, escapeAttr, formatDate, formatSize, mountFrame, targetLabel, textDocument, typeLabel } from '../dom.js';
import { rememberOpenFile } from '../reader-history.js';
import { readablePathForRecord } from '../library-paths.mjs';
import {
    EMPTY_HISTORY, visitHistory, findHistoryStep, canStepHistory, moveHistory,
    extractMarkdownOutline, extractHtmlOutline, outlineHintFor, toSaveState, docLocation, stepZoom,
} from '../doc-tools.mjs';
import {
    readDocZoom, writeDocZoom, prepareDocFrame, bindEditorPreviewFrames, applyDocZoom, findInView, endFindInView, gotoOutlineItem,
} from '../doc-view.js';
import { notify } from './mf-toast.js';
import './mf-md-editor.js';

// 排序菜单：字段 + 方向的六种组合，参考 Obsidian 文件浏览器排序菜单的排布与措辞。
const SORT_MENU_OPTIONS = Object.freeze([
    ['title', 'asc', '文件名（A-Z）'],
    ['title', 'desc', '文件名（Z-A）'],
    ['updatedAt', 'desc', '编辑时间（从新到旧）'],
    ['updatedAt', 'asc', '编辑时间（从旧到新）'],
    ['createdAt', 'desc', '创建时间（从新到旧）'],
    ['createdAt', 'asc', '创建时间（从旧到新）'],
]);
const NOT_READY_RE = /文件库模块未就绪/;
const SIDEBAR_WIDTH = Object.freeze({ min: 220, max: 320, default: 220 });
const MAX_REPOSITORIES = 32;
const LIBRARY_VIEW_LABELS = Object.freeze({ md: 'Markdown', html: 'HTML', xml: 'XML', pdf: 'PDF', json: 'JSON' });

function settingsValue(state = store.get()) {
    const described = state.settings;
    return described && described.settings ? described.settings : (described || {});
}

const pathParts = (value) => String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
const basenamePath = (value) => pathParts(value).pop() || '';
const monthOf = (value) => String(value || '').slice(0, 7);
function siblingPath(value, name) {
    const raw = String(value || '').replace(/[\\/]+$/, '');
    const slash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
    return slash >= 0 ? `${raw.slice(0, slash + 1)}${name}` : name;
}

function normalizeRepositoryPath(value) {
    const raw = String(value || '').trim();
    return raw ? raw.replace(/[\\/]+$/, '') || raw : '';
}

function repositoryList(library) {
    const values = library && Array.isArray(library.repositories) ? library.repositories : [];
    return [...new Set(values.map(normalizeRepositoryPath).filter(Boolean))].slice(0, MAX_REPOSITORIES);
}

function managedRepositoryPath(settings) {
    const library = settings && settings.library ? settings.library : {};
    return normalizeRepositoryPath(library.root);
}
const sourceDirOf = (record) => {
    const source = record && record.source ? record.source : {};
    return source.kind === 'url' ? source.host : source.dir;
};

function relativePathParts(root, value) {
    const rootParts = pathParts(root);
    const valueParts = pathParts(value);
    if (rootParts.length > 0 && rootParts.every((part, index) => valueParts[index] === part)) return valueParts.slice(rootParts.length);
    return [];
}

function monthAndProject(record, root) {
    const relative = relativePathParts(root, record.outputPath);
    const managedMonth = /^\d{4}-\d{2}$/.test(relative[0] || '') ? relative[0] : '';
    return {
        month: managedMonth || monthOf(record.createdAt) || '未分类时间',
        projectKey: record.outputPath || record.id,
        projectLabel: relative[1] || basenamePath(record.outputPath) || record.title || record.name || '未命名项目',
    };
}

function buildLibraryTree(records, root) {
    const months = new Map();
    for (const record of Array.isArray(records) ? records : []) {
        const location = monthAndProject(record, root);
        const month = months.get(location.month) || { key: location.month, label: location.month, records: [], projects: new Map() };
        month.records.push(record);
        const project = month.projects.get(location.projectKey) || { key: location.projectKey, label: location.projectLabel, records: [] };
        project.records.push(record);
        month.projects.set(location.projectKey, project);
        months.set(location.month, month);
    }
    const sortProjects = (a, b) => a.label.localeCompare(b.label, 'zh') || a.key.localeCompare(b.key, 'zh');
    return {
        label: basenamePath(root) || '托管目录',
        path: root || '',
        total: Array.isArray(records) ? records.length : 0,
        months: [...months.values()]
            .sort((a, b) => b.label.localeCompare(a.label, 'zh'))
            .map((month) => ({ ...month, projects: [...month.projects.values()].sort(sortProjects) })),
    };
}

function joinRepositoryPath(root, parts) {
    const base = String(root || '').replace(/[\\/]+$/, '');
    return [base, ...parts].filter(Boolean).join('/');
}

function repositoryFileCount(node) {
    if (!node) return 0;
    return node.files.length + [...node.folders.values()].reduce((total, child) => total + repositoryFileCount(child), 0);
}

function buildRepositoryTree(root, entries, records) {
    const recordByPath = new Map();
    for (const record of Array.isArray(records) ? records : []) {
        const readablePath = readablePathForRecord(record);
        if (readablePath) recordByPath.set(readablePath, record);
        const outputs = record && record.outputs && typeof record.outputs === 'object' ? record.outputs : {};
        for (const value of Object.values(outputs)) {
            if (typeof value === 'string' && value.trim()) recordByPath.set(value.trim(), record);
        }
    }
    const tree = { label: basenamePath(root) || '仓库', path: root || '', folders: new Map(), files: [] };
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || typeof entry.path !== 'string') continue;
        const relative = relativePathParts(root, entry.path);
        if (relative.length === 0) continue;
        const fileName = relative.pop();
        let folder = tree;
        const folderParts = [];
        for (const part of relative) {
            folderParts.push(part);
            let child = folder.folders.get(part);
            if (!child) {
                child = { label: part, path: joinRepositoryPath(root, folderParts), folders: new Map(), files: [] };
                folder.folders.set(part, child);
            }
            folder = child;
        }
        folder.files.push({ ...entry, name: fileName, record: recordByPath.get(entry.path) || null });
    }
    const sortText = (a, b) => a.label.localeCompare(b.label, 'zh') || a.path.localeCompare(b.path, 'zh');
    const sortFiles = (a, b) => a.name.localeCompare(b.name, 'zh') || a.path.localeCompare(b.path, 'zh');
    const sortNode = (node) => {
        node.folders = new Map([...node.folders.entries()].sort(([, a], [, b]) => sortText(a, b)));
        node.files.sort(sortFiles);
        for (const child of node.folders.values()) sortNode(child);
        return node;
    };
    return sortNode(tree);
}

/** 「仅显示收藏」过滤托管库树：按月/项目分组的记录树逐层筛掉非收藏记录，空项目与空月份一并剔除。 */
function filterFavoriteMonths(months) {
    return months
        .map((month) => {
            const projects = month.projects
                .map((project) => ({ ...project, records: project.records.filter((record) => record.favorite) }))
                .filter((project) => project.records.length > 0);
            return { ...month, projects, records: month.records.filter((record) => record.favorite) };
        })
        .filter((month) => month.projects.length > 0);
}

/** 「仅显示收藏」过滤仓库浏览树：文件按关联记录的收藏状态筛选，未登记为记录的文件视为未收藏；空文件夹递归剔除。 */
function filterFavoriteRepositoryNode(node) {
    const files = node.files.filter((entry) => entry.record && entry.record.favorite);
    const folders = new Map();
    for (const [key, child] of node.folders) {
        const filteredChild = filterFavoriteRepositoryNode(child);
        if (filteredChild.files.length > 0 || filteredChild.folders.size > 0) folders.set(key, filteredChild);
    }
    return { ...node, files, folders };
}

class MfLibraryPage extends HTMLElement {
    constructor() {
        super();
        // 已打开 md 标签的常驻编辑器：tabId → <mf-md-editor>，切换标签只改 hidden
        this.editors = new Map();
        this.state = {
            query: '', sort: 'createdAt', order: 'desc', sortMenuOpen: false, revealActiveFile: false,
            items: [], total: 0, treeItems: [], tree: null, repositoryRoot: '', repositoryRoots: [], managedRepositoryRoot: '', repositoryTree: null, repositoryBusy: false, repositoryError: '', repositoryMenuOpen: false, repositoryManagerOpen: false, repositoryManagerMenuPath: '', busy: false, ready: true, error: '',
            editingTags: null, confirming: null, contextRecordId: null, plan: null, planResult: null, migrating: false,
            openTabs: [], activeTabId: null, libraryReaderBusy: false, libraryReaderError: '',
        };
        // 折叠侧栏 / 仅显示收藏 / 搜索面板展开：由顶部状态栏的按钮驱动，状态存于全局 store，这里只记「上次已同步到的值」用于去重。
        this.seenSidebarCollapsed = false;
        this.seenFavoritesOnly = false;
        this.seenSearchOpen = false;
        this.seenLibraryVersion = 0;
        this.loadSequence = 0;
        this.resizeState = null;
        this.libraryOpening = new Set();
        // 顶部栏文档功能：标签激活历史（按文件路径记，后退 / 前进跳过已关闭的标签）、文档字号（百分比，与阅读页共用 localStorage）、
        // 上次发布到 store 的文档状态（序列化后比较，未变不重复发布）
        this.navHistory = EMPTY_HISTORY;
        this.docZoom = readDocZoom();
        this.publishedDoc = '';
    }

    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.innerHTML = `
            <div class="page-body page-layout library-body">
                <aside class="page-sidebar library-facets" aria-label="文件库侧栏">
                    <div class="library-sidebar-top">
                        <div class="library-sidebar-tools-row" aria-label="文件库操作">
                            <div class="library-sort-switcher" data-role="sort-switcher"></div>
                            <button class="icon-btn icon-btn-sm" type="button" data-action="toggle-reveal-active" data-role="reveal-toggle" title="自动显示当前文件" aria-label="自动显示当前文件" aria-pressed="false">${icon('locate')}</button>
                            <button class="icon-btn icon-btn-sm" type="button" data-action="toggle-expand-all" data-role="expand-toggle" title="全部展开" aria-label="全部展开">${icon('expandAll')}</button>
                            <button class="icon-btn icon-btn-sm" type="button" data-action="migrate" title="迁移到托管目录" aria-label="迁移到托管目录">${icon('folderMove')}</button>
                        </div>
                        <div class="library-sidebar-tool-panel library-search-tools" id="library-search-panel" data-role="search-panel" hidden>
                            <label class="search library-sidebar-search"><span class="search-icon">${icon('search')}</span><input type="search" placeholder="搜索标题、名称、来源或标签" data-role="query" spellcheck="false"></label>
                        </div>
                    </div>
                    <div class="library-sidebar-divider"></div>
                    <div class="library-tree" data-role="library-tree"></div>
                    <div class="library-repository-switcher-wrap" data-role="repository-switcher"></div>
                </aside>
                <div class="sidebar-resize-handle" data-role="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="调整文件库侧栏宽度" aria-valuemin="${SIDEBAR_WIDTH.min}" aria-valuemax="${SIDEBAR_WIDTH.max}" aria-valuenow="${SIDEBAR_WIDTH.default}" tabindex="0"></div>
                <section class="library-main">
                    <div class="migration-panel" hidden></div>
                    <div class="library-open-tabs" data-role="open-tabs" role="tablist" aria-label="已打开文件" hidden></div>
                    <section class="library-reader-workspace" data-role="reader-workspace">
                        <section class="compare-empty" data-role="reader-empty">
                            <div class="dropzone-icon">${icon('reader')}</div>
                            <h3>直接打开阅读</h3>
                            <p>从左侧文件库目录选择文件，文件将在此处打开；支持 Markdown、HTML、XML、JSON 与 PDF。</p>
                            <div class="dropzone-actions"><button class="btn btn-primary" type="button" data-action="pick-reader">${icon('file')}选择文件…</button></div>
                        </section>
                        <div class="library-reader-frame" data-role="reader-frame"></div>
                        <div class="md-editor-host" data-role="editor-host" hidden></div>
                        <div class="library-reader-busy" data-role="reader-busy" hidden><span class="spinner">${icon('spinner')}</span><span>正在打开…</span></div>
                        <p class="library-reader-error" data-role="reader-error" hidden></p>
                    </section>
                </section>
                <div class="library-context-menu" data-role="library-context-menu" role="menu" hidden></div>
            </div>
            <div class="library-repository-manager-backdrop" data-role="repository-manager" hidden>
                <section class="library-repository-manager" role="dialog" aria-modal="true" aria-labelledby="repository-manager-title">
                    <header class="library-repository-manager-header">
                        <div>
                            <p class="library-repository-manager-eyebrow">本地文件管理</p>
                            <h2 id="repository-manager-title">仓库管理</h2>
                        </div>
                        <button class="icon-btn" type="button" data-action="close-repository-manager" title="关闭" aria-label="关闭仓库管理">${icon('x')}</button>
                    </header>
                    <div class="library-repository-manager-content">
                        <aside class="library-repository-manager-list-pane" aria-label="本地仓库列表">
                            <div class="library-repository-manager-managed" data-role="repository-manager-managed"></div>
                            <div class="library-repository-manager-list-heading">
                                <h3>本地仓库</h3><span data-role="repository-manager-count"></span>
                            </div>
                            <div class="library-repository-manager-list" data-role="repository-manager-list"></div>
                        </aside>
                        <main class="library-repository-manager-main">
                            <div class="library-repository-manager-intro">
                                <div class="library-repository-manager-mark">${icon('folder')}</div>
                                <h3>MarkFlow 仓库</h3>
                                <p>管理用于阅读的本地文件夹。转档产物仍统一迁移到 MarkFlow Library。</p>
                            </div>
                            <div class="library-repository-manager-actions">
                                <article class="library-repository-manager-action">
                                    <div><h4>新建本地仓库</h4><p>在指定位置创建或选择一个新的本地文件夹。</p></div>
                                    <button class="btn btn-primary" type="button" data-action="create-library-repository">创建</button>
                                </article>
                                <article class="library-repository-manager-action">
                                    <div><h4>打开本地仓库</h4><p>将已有的本地文件夹添加到仓库列表并打开。</p></div>
                                    <button class="btn btn-secondary" type="button" data-action="open-library-repository">打开</button>
                                </article>
                            </div>
                            <p class="library-repository-manager-note">MarkFlow Library 是固定的转档目录，可切换查看其中已转档的文件，但不能从仓库列表中移除；如需变更其存储位置，请在设置页修改托管根目录。</p>
                        </main>
                    </div>
                </section>
            </div>
            <footer class="page-footer library-page-footer" aria-label="当前文件信息">
                <div class="footer-summary library-file-status" data-role="library-status"></div>
            </footer>`;
        this.bindSidebarResizer();
        this.querySelector('[data-role="query"]').addEventListener('input', (event) => {
            this.state.query = event.target.value;
            clearTimeout(this.debounce);
            this.debounce = setTimeout(() => this.load(), 250);
        });
        this.addEventListener('click', (event) => this.onClick(event));
        this.addEventListener('contextmenu', (event) => this.onContextMenu(event));
        // md 标签的常驻编辑器：脏状态只重绘标签条；保存成功更新该标签的原文与渲染（不递增 libraryVersion，免得整页重载）
        this.addEventListener('mf-md-change', (event) => this.onEditorChange(event));
        this.addEventListener('mf-md-saved', (event) => this.onEditorSaved(event));
        this.addEventListener('mf-md-reload-request', (event) => this.onEditorReload(event));
        // 编辑器保存状态经 store.libraryDoc 显示在顶部栏标题旁（编辑器自身工具栏不再重复显示）
        this.addEventListener('mf-md-status', (event) => this.onEditorStatus(event));
        // 顶部栏文档命令；编辑器实时预览帧装载时补注紧凑版式与字号
        this.onDocCommandEvent = (event) => this.onDocCommand(event.detail);
        window.addEventListener('mf-doc-command', this.onDocCommandEvent);
        const editorHost = this.querySelector('[data-role="editor-host"]');
        bindEditorPreviewFrames(editorHost, () => this.docZoom);
        applyDocZoom({ editorHost }, this.docZoom);
        // <details> 的 toggle 事件不冒泡，只能在捕获阶段接住；用户手动展开/折叠单个文件夹时同步展开/折叠按钮。
        this.querySelector('[data-role="library-tree"]').addEventListener('toggle', () => this.syncExpandToggle(), true);
        this.addEventListener('pointerdown', (event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target || !target.closest('[data-role="library-context-menu"]')) this.closeContextMenu();
            if (!target || !target.closest('[data-role="repository-switcher"]')) this.closeRepositoryMenu();
            if (!target || !target.closest('[data-role="sort-switcher"]')) this.closeSortMenu();
            if (!target || !target.closest('[data-role="repository-manager-list"]')) this.state.repositoryManagerMenuPath = '';
        });
        this.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.state.repositoryManagerOpen) {
                event.preventDefault();
                this.closeRepositoryManager();
            }
        });
        this.unsubscribe = store.subscribe((state) => {
            if (state.route !== 'library') return;
            if (state.librarySidebarCollapsed !== this.seenSidebarCollapsed) {
                this.seenSidebarCollapsed = state.librarySidebarCollapsed;
                this.syncSidebarCollapse();
            }
            if (state.libraryFavoritesOnly !== this.seenFavoritesOnly) {
                this.seenFavoritesOnly = state.libraryFavoritesOnly;
                this.renderTree();
            }
            if (state.librarySearchOpen !== this.seenSearchOpen) {
                this.seenSearchOpen = state.librarySearchOpen;
                this.syncSearchPanel();
            }
            if (state.libraryVersion !== this.seenLibraryVersion) {
                this.seenLibraryVersion = state.libraryVersion;
                this.load();
                return;
            }
            // 本页首次 load() 抢在 app.js 的 loadInitial() 之前跑（冷启动 / 刷新后仍停在 #/library 时），
            // 当时 store.settings 还是 null，仓库列表与托管根目录都会退化为空；设置到位后在此补一次。
            if (!this.settingsReadyAtLoad && state.settings) this.load();
        });
        this.renderStatus();
        this.renderSortMenu();
        this.renderRepositorySwitcher();
        this.renderRepositoryManager();
    }

    disconnectedCallback() {
        if (this.unsubscribe) this.unsubscribe();
        window.removeEventListener('mf-doc-command', this.onDocCommandEvent);
        this.endSidebarResize();
    }

    bindSidebarResizer() {
        const handle = this.querySelector('[data-role="sidebar-resizer"]');
        if (!handle) return;
        handle.addEventListener('pointerdown', (event) => {
            const sidebar = this.querySelector('.library-facets');
            if (!sidebar) return;
            event.preventDefault();
            this.resizeState = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebar.getBoundingClientRect().width };
            handle.setPointerCapture(event.pointerId);
            this.querySelector('.library-body').classList.add('is-resizing');
            document.body.classList.add('is-resizing-sidebar');
        });
        handle.addEventListener('pointermove', (event) => {
            if (!this.resizeState || event.pointerId !== this.resizeState.pointerId) return;
            const width = Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, this.resizeState.startWidth + event.clientX - this.resizeState.startX));
            const body = this.querySelector('.library-body');
            body.style.setProperty('--library-sidebar-width', `${Math.round(width)}px`);
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
            const body = this.querySelector('.library-body');
            const handleWidth = Number(handle.getAttribute('aria-valuenow')) || SIDEBAR_WIDTH.default;
            const delta = event.key === 'ArrowLeft' ? -16 : 16;
            const width = Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, handleWidth + delta));
            body.style.setProperty('--library-sidebar-width', `${width}px`);
            handle.setAttribute('aria-valuenow', String(width));
        });
    }

    endSidebarResize() {
        if (!this.resizeState) return;
        this.resizeState = null;
        const body = this.querySelector('.library-body');
        if (body) body.classList.remove('is-resizing');
        document.body.classList.remove('is-resizing-sidebar');
    }

    /** 折叠/展开侧栏：折叠按钮已移到顶部状态栏（跨组件，经 store 驱动），这里只负责按当前状态切换侧栏与拖拽手柄的显隐。 */
    syncSidebarCollapse() {
        const body = this.querySelector('.library-body');
        if (!body) return;
        body.classList.toggle('is-sidebar-collapsed', store.get().librarySidebarCollapsed);
    }

    /** 搜索面板的展开/收起按钮同样已移到顶部状态栏，这里只负责显隐输入框并在展开时聚焦。 */
    syncSearchPanel() {
        const panel = this.querySelector('[data-role="search-panel"]');
        if (!panel) return;
        const open = store.get().librarySearchOpen;
        panel.hidden = !open;
        if (open) this.querySelector('[data-role="query"]')?.focus();
    }

    /** 路由切换到本页时由 app.js 调用；字号可能已在阅读页改过，先读回并作用到当前帧与编辑器 */
    refresh() {
        this.seenLibraryVersion = store.get().libraryVersion;
        this.docZoom = readDocZoom();
        this.applyZoom();
        this.load();
    }

    async load(rootOverride = null) {
        const sequence = ++this.loadSequence;
        this.state.busy = true;
        // 冷启动 / 刷新后若路由本就停在文件库，此时 loadInitial() 的设置尚未落到 store，
        // settingsValue() 会退化为 {}；记下这一情形，subscribe 回调等设置到位后据此补一次 load()。
        this.settingsReadyAtLoad = Boolean(store.get().settings);
        let settings = settingsValue();
        settings = await this.migrateLegacyRepositorySettings(settings);
        const library = settings.library || {};
        const managedRoot = managedRepositoryPath(settings);
        const repositories = repositoryList(library);
        const requestedRoot = normalizeRepositoryPath(rootOverride);
        const configuredRoot = normalizeRepositoryPath(library.activeRepository);
        // 转档目录不在 repositories 名单里（它固定常在、不可移除），但同样可被选中翻阅，故单独并入候选集合。
        const selectableRoots = new Set(repositories);
        if (managedRoot) selectableRoots.add(managedRoot);
        const root = requestedRoot && selectableRoots.has(requestedRoot)
            ? requestedRoot
            : (configuredRoot && selectableRoots.has(configuredRoot) ? configuredRoot : (repositories[0] || managedRoot || ''));
        this.state.repositoryRoots = repositories;
        this.state.managedRepositoryRoot = managedRoot;
        this.state.repositoryRoot = root;
        this.state.repositoryBusy = Boolean(root);
        this.state.repositoryError = '';
        this.renderStatus();
        this.renderTree();
        this.renderRepositorySwitcher();
        this.renderRepositoryManager();
        try {
            const params = { query: this.state.query, sort: this.state.sort, order: this.state.order };
            const [result, scanned] = await Promise.all([
                api.libraryList(params),
                // 仓库树按浏览范围列出（另含 html / xml / json）；转档入口仍按转档白名单，互不影响
                root ? api.expandPaths([root], { scope: 'browse' }) : Promise.resolve({ files: [] }),
            ]);
            if (sequence !== this.loadSequence) return;
            this.state.items = result.items;
            this.state.total = result.total;
            this.state.treeItems = result.items;
            this.state.tree = buildLibraryTree(this.state.treeItems, root);
            const entries = scanned && Array.isArray(scanned.files) ? scanned.files : (Array.isArray(scanned) ? scanned : []);
            this.state.repositoryTree = root ? buildRepositoryTree(root, entries, this.state.treeItems) : null;
            this.state.ready = true;
            this.state.error = '';
        } catch (err) {
            if (sequence !== this.loadSequence) return;
            this.state.ready = !NOT_READY_RE.test(err.message);
            this.state.error = err.message;
            this.state.items = [];
            this.state.treeItems = [];
            this.state.tree = null;
            this.state.repositoryTree = null;
            this.state.repositoryError = root ? '无法读取当前仓库' : '';
            this.state.total = 0;
        } finally {
            if (sequence === this.loadSequence) this.state.busy = false;
        }
        if (sequence !== this.loadSequence) return;
        this.state.repositoryBusy = false;
        this.render();
    }

    async migrateLegacyRepositorySettings(settings) {
        const library = settings && settings.library ? settings.library : {};
        if (Array.isArray(library.repositories) || !library.root || !settings.outputDir) return settings;
        const legacyRoot = normalizeRepositoryPath(library.root);
        const candidate = siblingPath(settings.outputDir, 'MarkFlow Library');
        if (!legacyRoot || !candidate || legacyRoot === candidate || basenamePath(legacyRoot) === 'MarkFlow Library') return settings;
        try {
            const described = await api.settingsSet({ library: { root: candidate, repositories: [legacyRoot], activeRepository: legacyRoot } });
            store.set({ settings: described });
            return described && described.settings ? described.settings : settings;
        } catch (err) {
            return settings;
        }
    }

    renderStatus() {
        const status = this.querySelector('.library-status');
        if (!status) return;
        if (!this.state.ready) {
            status.textContent = '文件库模块未就绪';
            status.dataset.kind = 'error';
            return;
        }
        if (this.state.error) {
            status.textContent = this.state.error;
            status.dataset.kind = 'error';
            return;
        }
        status.dataset.kind = 'info';
        status.textContent = this.state.busy ? '加载中…' : `${this.state.total} 条记录`;
    }

    render() {
        this.renderStatus();
        this.renderTree();
        this.renderSortMenu();
        this.renderRepositorySwitcher();
        this.renderRepositoryManager();
        const list = this.querySelector('.record-list');
        if (list) {
            if (this.state.items.length === 0) {
                list.innerHTML = this.state.ready && !this.state.error ? '<li class="record-empty">没有匹配的记录：转换完成的产物会自动登记到这里</li>' : '';
            } else {
                list.innerHTML = this.state.items.map((record) => this.rowTemplate(record)).join('');
            }
        }
        this.renderMigration();
        this.renderWorkspace();
    }

    renderRepositorySwitcher() {
        const host = this.querySelector('[data-role="repository-switcher"]');
        if (!host) return;
        const root = this.state.repositoryRoot;
        const model = this.state.repositoryTree;
        const label = model && model.label ? model.label : (basenamePath(root) || '选择仓库');
        const disabled = this.state.repositoryBusy ? ' disabled' : '';
        const expanded = this.state.repositoryMenuOpen;
        const managedRoot = this.state.managedRepositoryRoot;
        // 转档目录固定常在、不可从列表移除，但同样可选中翻阅；单独渲染一项并钉在最前面。
        const managedItem = managedRoot ? `
                    <button class="library-repository-menu-item${managedRoot === root ? ' is-current' : ''}" type="button" role="menuitem" data-action="select-library-repository" data-repository-path="${escapeAttr(managedRoot)}" title="切换仓库：MarkFlow Library（转档目录）" aria-label="切换仓库：MarkFlow Library（转档目录）">
                        <span class="library-repository-menu-check" aria-hidden="true">${managedRoot === root ? '✓' : ''}</span><span class="library-repository-menu-label">MarkFlow Library</span>
                    </button>` : '';
        const repositories = this.state.repositoryRoots.map((repository) => {
            const repositoryLabel = basenamePath(repository) || '未命名仓库';
            const current = repository === root;
            return `
                    <button class="library-repository-menu-item${current ? ' is-current' : ''}" type="button" role="menuitem" data-action="select-library-repository" data-repository-path="${escapeAttr(repository)}" title="切换仓库：${escapeAttr(repositoryLabel)}" aria-label="切换仓库：${escapeAttr(repositoryLabel)}">
                        <span class="library-repository-menu-check" aria-hidden="true">${current ? '✓' : ''}</span><span class="library-repository-menu-label">${escapeHtml(repositoryLabel)}</span>
                    </button>`;
        }).join('');
        host.innerHTML = `
            <div class="library-repository-picker${expanded ? ' is-open' : ''}">
                <button class="library-repository-switcher" type="button" data-action="toggle-repository-menu" title="切换仓库" aria-label="切换仓库：${escapeAttr(label)}" aria-haspopup="menu" aria-expanded="${expanded}"${disabled}>
                    <span class="library-repository-switcher-label">${escapeHtml(label)}</span>
                </button>
                <div class="library-repository-menu" data-role="repository-menu" role="menu" aria-label="仓库选择"${expanded ? '' : ' hidden'}>
                    <div class="library-repository-menu-title">本地仓库</div>
                    ${managedItem}
                    ${repositories || '<div class="library-repository-menu-empty">暂无其它可切换的本地仓库</div>'}
                    <div class="library-repository-menu-separator" role="separator"></div>
                    <button class="library-repository-menu-item" type="button" role="menuitem" data-action="manage-repositories">管理仓库…</button>
                </div>
            </div>`;
    }

    closeRepositoryMenu() {
        if (!this.state.repositoryMenuOpen) return;
        this.state.repositoryMenuOpen = false;
        this.renderRepositorySwitcher();
    }

    /** 排序菜单：参考 Obsidian 文件浏览器的排序下拉——字段+方向共六项，当前项打勾。 */
    renderSortMenu() {
        const host = this.querySelector('[data-role="sort-switcher"]');
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
        const sidebar = this.querySelector('.library-facets');
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

    openRepositoryManager() {
        this.closeRepositoryMenu();
        this.state.repositoryManagerOpen = true;
        this.state.repositoryManagerMenuPath = '';
        this.renderRepositoryManager();
        this.querySelector('[data-action="close-repository-manager"]')?.focus();
    }

    closeRepositoryManager() {
        if (!this.state.repositoryManagerOpen) return;
        this.state.repositoryManagerOpen = false;
        this.state.repositoryManagerMenuPath = '';
        this.renderRepositoryManager();
    }

    renderRepositoryManager() {
        const manager = this.querySelector('[data-role="repository-manager"]');
        const list = this.querySelector('[data-role="repository-manager-list"]');
        const count = this.querySelector('[data-role="repository-manager-count"]');
        const managedSlot = this.querySelector('[data-role="repository-manager-managed"]');
        if (!manager || !list || !count || !managedSlot) return;
        manager.hidden = !this.state.repositoryManagerOpen;
        if (!this.state.repositoryManagerOpen) return;
        const managedRoot = this.state.managedRepositoryRoot;
        const repositories = this.state.repositoryRoots;
        count.textContent = `${repositories.length} 个`;
        // 转档目录固定常在、不可从列表移除，独立渲染在可移除的仓库列表之外，避免和下方卡片混同；
        // 但同样可点选切换以便翻阅转档产物，故仍是一个可点击按钮，只是没有「移除」这个操作。
        const managedCurrent = managedRoot === this.state.repositoryRoot;
        managedSlot.innerHTML = managedRoot ? `
            <button class="library-repository-manager-managed-item${managedCurrent ? ' is-current' : ''}" type="button" data-action="select-library-repository" data-repository-path="${escapeAttr(managedRoot)}" aria-label="切换仓库：MarkFlow Library（转档目录）">
                <span class="library-repository-manager-item-icon">${icon('folder')}</span>
                <span class="library-repository-manager-item-copy"><strong>MarkFlow Library</strong><small>${escapeHtml(managedRoot)}</small></span>
            </button>` : '';
        const items = repositories.map((repository) => {
            const label = basenamePath(repository) || '未命名仓库';
            const current = repository === this.state.repositoryRoot;
            const menuOpen = repository === this.state.repositoryManagerMenuPath;
            return `
                <div class="library-repository-manager-item${current ? ' is-current' : ''}">
                    <button class="library-repository-manager-item-main" type="button" data-action="select-library-repository" data-repository-path="${escapeAttr(repository)}" aria-label="切换仓库：${escapeAttr(label)}">
                        <span class="library-repository-manager-item-icon">${icon('folder')}</span>
                        <span class="library-repository-manager-item-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(repository)}</small></span>
                    </button>
                    <button class="icon-btn icon-btn-sm library-repository-manager-more" type="button" data-action="toggle-repository-manager-menu" data-repository-path="${escapeAttr(repository)}" title="更多操作" aria-label="${escapeAttr(label)} 的更多操作" aria-expanded="${menuOpen}">${icon('more')}</button>
                    ${menuOpen ? `<div class="library-repository-manager-item-menu" role="menu">
                        <button type="button" role="menuitem" data-action="select-manager-repository" data-repository-path="${escapeAttr(repository)}">切换到此仓库</button>
                        <button type="button" role="menuitem" class="is-danger" data-action="remove-library-repository" data-repository-path="${escapeAttr(repository)}">从列表移除</button>
                    </div>` : ''}
                </div>`;
        }).join('');
        list.innerHTML = items || '<div class="library-repository-manager-empty">暂无本地仓库，请从右侧添加。</div>';
    }

    async selectRepository(value) {
        const repository = normalizeRepositoryPath(value);
        // 转档目录不在 repositoryRoots 名单里（它固定常在、不可移除），但仍是合法的可选中目标。
        const isManaged = Boolean(repository) && repository === this.state.managedRepositoryRoot;
        if (!repository || (!isManaged && !this.state.repositoryRoots.includes(repository))) {
            this.closeRepositoryMenu();
            return;
        }
        this.closeRepositoryMenu();
        this.state.repositoryManagerMenuPath = '';
        try {
            const described = await api.settingsSet({
                library: {
                    repositories: this.state.repositoryRoots,
                    activeRepository: repository,
                },
            });
            store.set({ settings: described });
            await this.load(repository);
        } catch (err) {
            notify(err.message, 'error', 6000);
        }
    }

    /** 侧栏树的文件夹节点统一用 <details>，展开/折叠全部只需批量置 open，无需重新渲染。 */
    setAllTreeFolders(open) {
        const tree = this.querySelector('[data-role="library-tree"]');
        if (!tree) return;
        for (const node of tree.querySelectorAll('details.library-tree-node')) node.open = open;
        this.syncExpandToggle();
    }

    /** 展开/折叠合并为一个按钮：图标与文案按「当前是否已全部展开」决定下一次点击的动作。 */
    syncExpandToggle() {
        const button = this.querySelector('[data-role="expand-toggle"]');
        if (!button) return;
        const tree = this.querySelector('[data-role="library-tree"]');
        const nodes = tree ? [...tree.querySelectorAll('details.library-tree-node')] : [];
        const allOpen = nodes.length > 0 && nodes.every((node) => node.open);
        const label = allOpen ? '全部折叠' : '全部展开';
        button.innerHTML = icon(allOpen ? 'collapseAll' : 'expandAll');
        button.title = label;
        button.setAttribute('aria-label', label);
        button.disabled = nodes.length === 0;
    }

    renderTree() {
        this.renderTreeContent();
        this.syncExpandToggle();
    }

    renderTreeContent() {
        const tree = this.querySelector('[data-role="library-tree"]');
        if (!tree) return;
        if (this.state.repositoryBusy) {
            tree.innerHTML = '<div class="facets-empty">正在读取仓库…</div>';
            return;
        }
        const favoritesOnly = store.get().libraryFavoritesOnly;
        if (this.state.repositoryRoot && this.state.repositoryTree) {
            const model = favoritesOnly ? filterFavoriteRepositoryNode(this.state.repositoryTree) : this.state.repositoryTree;
            const folders = [...model.folders.values()].map((folder) => this.repositoryFolderTree(folder)).join('');
            const files = this.repositoryFiles(model.files);
            const emptyLabel = favoritesOnly ? '当前仓库暂无收藏文件' : '当前仓库暂无可阅读文件';
            tree.setAttribute('aria-label', `仓库：${model.label}`);
            tree.innerHTML = `
                <div class="library-tree-all" aria-current="page">
                    <span class="library-tree-summary-main">${icon('library')}<span class="library-tree-label">全部文件</span></span><span class="library-tree-count">${repositoryFileCount(model)}</span>
                </div>
                ${folders}${files || (!folders ? `<div class="facets-empty">${emptyLabel}</div>` : '')}`;
            return;
        }
        tree.removeAttribute('aria-label');
        const source = this.state.tree;
        if (!source) {
            tree.innerHTML = this.state.ready && !this.state.error ? '<div class="facets-empty">暂无记录</div>' : '';
            return;
        }
        const monthList = favoritesOnly ? filterFavoriteMonths(source.months) : source.months;
        const total = favoritesOnly ? monthList.reduce((sum, month) => sum + month.records.length, 0) : source.total;
        const emptyLabel = favoritesOnly ? '暂无收藏文件' : '暂无记录';
        const months = monthList.map((month) => `
            <details class="library-tree-node library-tree-month" open>
                <summary><span class="library-tree-summary-main">${icon('folder')}<span class="library-tree-label">${escapeHtml(month.label)}</span></span><span class="library-tree-count">${month.records.length}</span></summary>
                <div class="library-tree-children">${month.projects.map((project) => this.projectTree(project)).join('')}</div>
            </details>`).join('');
        tree.innerHTML = `
            <div class="library-tree-all" aria-current="page">
                <span class="library-tree-summary-main">${icon('library')}<span class="library-tree-label">全部文件</span></span><span class="library-tree-count">${total}</span>
            </div>
            ${months || `<div class="facets-empty">${emptyLabel}</div>`}`;
    }

    repositoryFolderTree(folder) {
        const folders = [...folder.folders.values()].map((child) => this.repositoryFolderTree(child)).join('');
        const files = this.repositoryFiles(folder.files);
        return `
            <details class="library-tree-node library-tree-project" open>
                <summary><span class="library-tree-summary-main">${icon('folder')}<span class="library-tree-label">${escapeHtml(folder.label)}</span></span><span class="library-tree-count">${repositoryFileCount(folder)}</span></summary>
                <div class="library-tree-children">${folders}${files}</div>
            </details>`;
    }

    /** 只有记录的主文件（readablePathForRecord）用记录标题并带 data-tree-record；同一记录的旁路文件显示文件名，避免重复条目 */
    repositoryFiles(files) {
        return (Array.isArray(files) ? files : []).map((entry) => {
            const record = entry.record && readablePathForRecord(entry.record) === entry.path ? entry.record : null;
            const recordAttr = record ? ` data-tree-record="${escapeAttr(record.id)}"` : '';
            const label = record && (record.title || record.name) ? (record.title || record.name) : entry.name;
            return `
                <button class="library-tree-file${record && record.highlighted ? ' is-highlighted' : ''}" type="button" data-tree-path="${escapeAttr(entry.path)}"${recordAttr} title="${escapeAttr(entry.path)}" aria-label="打开 ${escapeAttr(label || '未命名文件')}">
                    ${icon('file')}<span class="library-tree-label">${escapeHtml(label || '未命名文件')}</span>
                </button>`;
        }).join('');
    }

    projectTree(project) {
        const files = project.records.map((record) => `
            <button class="library-tree-file${record.highlighted ? ' is-highlighted' : ''}" type="button" data-tree-record="${escapeAttr(record.id)}" title="${escapeAttr(record.title || record.name || '')}" aria-label="打开 ${escapeAttr(record.title || record.name || '未命名文件')}">
                ${icon('file')}<span class="library-tree-label">${escapeHtml(record.title || record.name || '未命名文件')}</span>
            </button>`).join('');
        return `
            <details class="library-tree-node library-tree-project" open>
                <summary><span class="library-tree-summary-main">${icon('folder')}<span class="library-tree-label">${escapeHtml(project.label)}</span></span><span class="library-tree-count">${project.records.length}</span></summary>
                <div class="library-tree-children">${files}</div>
            </details>`;
    }

    rowTemplate(record) {
        const source = record.source || {};
        const chips = [
            `<span class="chip chip-target">${escapeHtml(targetLabel(record.target))}</span>`,
            `<span class="chip">${escapeHtml(typeLabel(source.type))}</span>`,
            record.managed ? '<span class="chip chip-managed">托管</span>' : '',
            record.missing ? '<span class="chip chip-missing">产物缺失</span>' : '',
        ].join('');
        const tags = (record.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
        const editing = this.state.editingTags === record.id;
        const confirming = this.state.confirming === record.id;
        const warnings = Array.isArray(record.warnings) ? record.warnings.length : 0;
        return `
            <li class="record${record.missing ? ' is-missing' : ''}" data-id="${escapeAttr(record.id)}">
                <div class="record-main">
                    <div class="record-title">
                        <button class="star${record.favorite ? ' is-on' : ''}" type="button" data-action="favorite" title="${record.favorite ? '取消收藏' : '收藏'}" aria-label="收藏">${icon('star')}</button>
                        <span class="title">${escapeHtml(record.title || record.name)}</span>${chips}
                    </div>
                    <div class="record-meta">
                        <span>${escapeHtml(source.value || '')}</span>
                        <span>${escapeHtml(formatDate(record.createdAt))}</span>
                        ${record.imagesCount ? `<span>${record.imagesCount} 张图片</span>` : ''}
                        ${warnings ? `<span class="record-warn" title="${escapeAttr((record.warnings || []).join('\n'))}">${warnings} 条提示</span>` : ''}
                    </div>
                    <div class="record-path">${escapeHtml(record.outputPath || '')}</div>
                    <div class="record-tags">${tags}<button class="link-btn" type="button" data-action="edit-tags">${icon('tag')}${tags ? '编辑标签' : '添加标签'}</button></div>
                    <div class="record-editor" ${editing ? '' : 'hidden'}>
                        <input type="text" class="input" data-role="tags" value="${escapeAttr((record.tags || []).join(', '))}" placeholder="标签以逗号分隔" spellcheck="false">
                        <button class="btn btn-small btn-primary" type="button" data-action="save-tags">保存</button>
                        <button class="btn btn-small btn-secondary" type="button" data-action="cancel-tags">取消</button>
                    </div>
                    <div class="record-confirm" ${confirming ? '' : 'hidden'}>
                        <span>删除这条记录？</span>
                        <button class="btn btn-small btn-secondary" type="button" data-action="remove-index">仅删记录</button>
                        <button class="btn btn-small btn-danger" type="button" data-action="remove-trash">连同产物移到废纸篓</button>
                        <button class="btn btn-small btn-secondary" type="button" data-action="cancel-remove">取消</button>
                    </div>
                </div>
            </li>`;
    }

    libraryTabsFor(tab) {
        if (!tab) return [];
        if (tab.kind === 'xml') return tab.view && tab.view.structuredHtml ? [['rendered', '结构视图'], ['raw', 'XML 原文']] : [['raw', 'XML 原文']];
        if (tab.kind === 'md') return [['rendered', '渲染'], ['raw', '原文'], ['edit', '编辑']];
        return [];
    }

    renderWorkspaceTabs(active) {
        const tabs = this.querySelector('[data-role="open-tabs"]');
        if (!tabs) return;
        const fileTabs = this.state.openTabs.map((tab) => `
            <div class="library-file-tab${tab.id === this.state.activeTabId ? ' is-active' : ''}${tab.dirty ? ' is-dirty' : ''}">
                <button class="library-file-tab-label" type="button" role="tab" data-library-tab="${escapeAttr(tab.id)}" aria-selected="${tab.id === this.state.activeTabId}" title="${escapeAttr(tab.path)}">
                    <span class="library-file-tab-name">${escapeHtml(tab.label || tab.name || tab.path)}</span>
                </button>
                <button class="icon-btn icon-btn-sm library-file-tab-close" type="button" data-action="close-library-tab" data-tab-id="${escapeAttr(tab.id)}" title="关闭标签" aria-label="关闭 ${escapeAttr(tab.label || tab.name || '文件')}标签">${icon('x')}</button>
            </div>`).join('');
        tabs.hidden = this.state.openTabs.length === 0;
        tabs.innerHTML = `<div class="library-file-tabs">${fileTabs}<button class="icon-btn icon-btn-sm library-new-tab" type="button" data-action="pick-reader" title="打开新文件" aria-label="打开新文件">${icon('plus')}</button></div>`;
    }

    /**
     * 帧键（标签 | 视图页签 | 视图版本）未变时不重建 iframe；「编辑」页签改为显示该标签的常驻编辑器。
     * md 渲染视图重新激活时先按编辑器文本（无编辑器则按磁盘）重取渲染：资产被回收后图片不再 403，文本未变时主进程直接复用缓存。
     */
    renderLibraryFrame(tab) {
        const host = this.querySelector('[data-role="reader-frame"]');
        if (!host) return;
        const editing = Boolean(tab && tab.view && tab.view.kind === 'md' && tab.tab === 'edit');
        for (const [id, editor] of this.editors) editor.hidden = !editing || id !== tab.id;
        if (!tab || !tab.view) {
            host.replaceChildren();
            delete host.dataset.frameKey;
            return;
        }
        if (editing) {
            this.ensureEditor(tab);
            return;
        }
        if (tab.view.kind === 'md' && tab.tab === 'rendered' && !tab.htmlFresh) {
            host.replaceChildren();
            delete host.dataset.frameKey;
            this.refreshTabHtml(tab);
            return;
        }
        const key = `${tab.id}|${tab.tab}|${tab.viewRev || 0}`;
        if (host.dataset.frameKey === key && host.firstElementChild) return;
        host.dataset.frameKey = key;
        // srcdoc 帧为同源沙箱帧（仍不放开脚本）：顶部栏的查找、大纲定位与字号需读写帧内 DOM；PDF 帧交内置阅读器，不注入
        const mountReaderFrame = (options) => {
            const frame = mountFrame(host, { ...options, scrollbar: true, sameOrigin: !options.src, zoom: options.src ? null : this.docZoom });
            if (!options.src) prepareDocFrame(frame, () => this.docZoom);
            return frame;
        };
        if (tab.view.kind === 'pdf') mountReaderFrame({ src: tab.view.url, title: `${tab.name || 'PDF'} 阅读器` });
        else if (tab.view.kind === 'xml') {
            if (tab.tab === 'rendered' && tab.view.structuredHtml) mountReaderFrame({ srcdoc: tab.view.structuredHtml, title: `${tab.name || 'XML'} 结构视图`, layout: 'compact-text' });
            else mountReaderFrame({ srcdoc: textDocument(tab.view.xml || '', { title: `${tab.name || 'XML'} 原文` }), title: `${tab.name || 'XML'} 原文`, layout: 'compact-text', appearance: 'adaptive' });
        } else if (tab.view.kind === 'json') {
            mountReaderFrame({ srcdoc: textDocument(tab.view.json || '', { title: `${tab.name || 'JSON'}` }), title: `${tab.name || 'JSON'} 原文`, layout: 'compact-text', appearance: 'adaptive' });
        } else if (tab.view.kind === 'md' && tab.tab === 'raw') {
            mountReaderFrame({ srcdoc: textDocument(tab.view.raw || '', { title: `${tab.name || 'Markdown'} 原文` }), title: `${tab.name || 'Markdown'} 原文`, layout: 'compact-text', appearance: 'adaptive' });
        } else mountReaderFrame({ srcdoc: tab.view.html || '', title: tab.name || '阅读视图', layout: tab.view.kind === 'md' ? 'compact' : null, appearance: tab.view.kind === 'md' ? 'adaptive' : 'paper' });
    }

    /** md 标签的常驻编辑器：首次进入「编辑」时创建并载入原文，之后只切 hidden */
    ensureEditor(tab) {
        let editor = this.editors.get(tab.id);
        if (!editor) {
            editor = document.createElement('mf-md-editor');
            editor.frameAppearance = 'adaptive';
            // 保存状态改由顶部栏标题旁显示（store.libraryDoc.saveState），编辑器工具栏不再重复
            editor.showStatus = false;
            editor.dataset.tabId = tab.id;
            editor.sessionId = tab.sessionId;
            this.querySelector('[data-role="editor-host"]').append(editor);
            this.editors.set(tab.id, editor);
            editor.setContent(tab.view.raw || '', { html: tab.view.html || '' });
        }
        for (const [id, item] of this.editors) item.hidden = id !== tab.id;
        return editor;
    }

    async refreshTabHtml(tab) {
        if (tab.refreshing) return;
        tab.refreshing = true;
        const editor = this.editors.get(tab.id);
        try {
            const result = await api.mdRender({ sessionId: tab.sessionId, ...(editor ? { text: editor.value } : {}) });
            if (result && typeof result.html === 'string' && result.html !== tab.view.html) {
                tab.view = { ...tab.view, html: result.html };
                tab.viewRev = (tab.viewRev || 0) + 1;
            }
        } catch (err) {
            // 会话已关闭等：沿用现有 html
        } finally {
            tab.refreshing = false;
            tab.htmlFresh = true;
        }
        const active = this.state.openTabs.find((item) => item.id === this.state.activeTabId);
        if (active === tab && tab.tab === 'rendered' && !this.state.libraryReaderBusy && !this.state.libraryReaderError) this.renderLibraryFrame(tab);
    }

    tabForEditorEvent(event) {
        const editor = event.target instanceof Element ? event.target.closest('mf-md-editor') : null;
        const tabId = editor ? editor.dataset.tabId : '';
        return tabId ? this.state.openTabs.find((tab) => tab.id === tabId) || null : null;
    }

    onEditorChange(event) {
        const tab = this.tabForEditorEvent(event);
        if (!tab) return;
        tab.dirty = Boolean(event.detail && event.detail.dirty);
        this.renderWorkspaceTabs(this.state.openTabs.find((item) => item.id === this.state.activeTabId) || null);
    }

    onEditorSaved(event) {
        const tab = this.tabForEditorEvent(event);
        const detail = event.detail || {};
        if (!tab || typeof detail.text !== 'string') return;
        const editor = this.editors.get(tab.id);
        tab.view = { ...tab.view, raw: detail.text, html: (editor && editor.lastHtml) || tab.view.html };
        tab.viewRev = (tab.viewRev || 0) + 1;
        for (const warning of (detail.result && detail.result.warnings) || []) notify(warning, 'warning', 6000);
        if (tab.id === this.state.activeTabId && tab.tab !== 'edit' && !this.state.libraryReaderBusy && !this.state.libraryReaderError) this.renderLibraryFrame(tab);
    }

    /** 「重新载入」：丢弃编辑器里的修改，关闭该会话并按同路径在原位置重开，停在「编辑」页签 */
    async onEditorReload(event) {
        const tab = this.tabForEditorEvent(event);
        if (!tab) return;
        const index = this.state.openTabs.indexOf(tab);
        this.disposeEditor(tab.id);
        this.state.openTabs.splice(index, 1);
        if (this.state.activeTabId === tab.id) this.state.activeTabId = null;
        this.renderWorkspace();
        await api.previewClose(tab.sessionId).catch(() => undefined);
        const record = tab.recordId ? this.findRecord(tab.recordId) : null;
        await this.openLibraryFile(tab.path, record, { index, viewTab: 'edit' });
    }

    disposeEditor(tabId) {
        const editor = this.editors.get(tabId);
        if (!editor) return;
        editor.dispose();
        editor.remove();
        this.editors.delete(tabId);
    }

    findRecord(id) {
        return this.state.treeItems.find((item) => item.id === id) || this.state.items.find((item) => item.id === id) || null;
    }

    recordForPath(filePath) {
        const path = String(filePath || '').trim();
        if (!path) return null;
        for (const record of [...this.state.treeItems, ...this.state.items]) {
            if (readablePathForRecord(record) === path) return record;
            const outputs = record && record.outputs && typeof record.outputs === 'object' ? record.outputs : {};
            if (Object.values(outputs).some((value) => typeof value === 'string' && value.trim() === path)) return record;
        }
        return null;
    }

    recordForTab(tab) {
        if (!tab) return null;
        if (tab.recordId) {
            return [...this.state.treeItems, ...this.state.items].find((record) => record.id === tab.recordId) || null;
        }
        return this.recordForPath(tab.path);
    }

    renderLibraryStatus(active) {
        const status = this.querySelector('[data-role="library-status"]');
        if (!status) return;
        if (!active) {
            status.innerHTML = '<span class="library-status-empty">未打开文件</span>';
            return;
        }
        const record = this.recordForTab(active);
        const source = record && record.source ? record.source : {};
        const documentType = source.type ? (LIBRARY_VIEW_LABELS[source.type] || typeLabel(source.type)) : (LIBRARY_VIEW_LABELS[active.kind] || active.kind);
        const metadata = [
            ['来源', source.value || active.path || '—'],
            ['文档类型', documentType || '—'],
            ['时间', record ? (formatDate(record.createdAt) || '—') : '—'],
            ['来源目录', sourceDirOf(record) || '—'],
        ];
        if (record && record.target) metadata.push(['目标', targetLabel(record.target)]);
        status.innerHTML = metadata.map(([label, value]) => `<span class="library-status-item" title="${escapeAttr(value)}"><span class="library-status-label">${escapeHtml(label)}</span><span class="library-status-value">${escapeHtml(value)}</span></span>`).join('');
    }

    renderWorkspace() {
        const workspace = this.querySelector('[data-role="reader-workspace"]');
        const empty = this.querySelector('[data-role="reader-empty"]');
        const busy = this.querySelector('[data-role="reader-busy"]');
        const error = this.querySelector('[data-role="reader-error"]');
        if (!workspace || !empty || !busy || !error) return;
        const active = this.state.openTabs.find((tab) => tab.id === this.state.activeTabId) || null;
        const hasActive = Boolean(active);
        this.renderLibraryStatus(active);
        workspace.hidden = false;
        empty.hidden = hasActive || this.state.libraryReaderBusy || Boolean(this.state.libraryReaderError);
        busy.hidden = !this.state.libraryReaderBusy;
        error.hidden = !this.state.libraryReaderError || this.state.libraryReaderBusy;
        error.textContent = this.state.libraryReaderError || '';
        this.renderWorkspaceTabs(active);
        const showContent = hasActive && !this.state.libraryReaderBusy && !this.state.libraryReaderError;
        const editing = showContent && Boolean(active.view) && active.view.kind === 'md' && active.tab === 'edit';
        const frameHost = this.querySelector('[data-role="reader-frame"]');
        const editorHost = this.querySelector('[data-role="editor-host"]');
        frameHost.hidden = !showContent || editing;
        if (editorHost) editorHost.hidden = !editing;
        if (showContent) this.renderLibraryFrame(active);
        else {
            frameHost.replaceChildren();
            delete frameHost.dataset.frameKey;
        }
        this.revealActiveFileInTree();
        // 标签激活历史按文件路径记：后退 / 前进先移动游标再激活，此处与当前项相同即不重复记
        if (active) this.navHistory = visitHistory(this.navHistory, active.path);
        this.publishDoc();
    }

    /** 「自动显示当前文件」开启时，随当前打开的文件在侧栏树中展开所在文件夹并高亮、滚动可见；参考 Obsidian 同名功能。 */
    revealActiveFileInTree() {
        const tree = this.querySelector('[data-role="library-tree"]');
        if (!tree) return;
        for (const button of tree.querySelectorAll('.library-tree-file.is-active-file')) button.classList.remove('is-active-file');
        if (!this.state.revealActiveFile) return;
        const active = this.state.openTabs.find((tab) => tab.id === this.state.activeTabId);
        if (!active) return;
        // 先按路径找（同一记录的旁路文件各自成条），找不到再按记录的主文件条目
        let target = active.path ? tree.querySelector(`[data-tree-path="${CSS.escape(active.path)}"]`) : null;
        if (!target && active.recordId) target = tree.querySelector(`[data-tree-record="${CSS.escape(active.recordId)}"]`);
        if (!target) return;
        target.classList.add('is-active-file');
        for (let node = target.closest('details.library-tree-node'); node; node = node.parentElement ? node.parentElement.closest('details.library-tree-node') : null) node.open = true;
        target.scrollIntoView({ block: 'nearest' });
        this.syncExpandToggle();
    }

    /** 离开一个标签：其编辑器先把修改落盘（失败由编辑器自身的横幅与状态提示），其 md 渲染视图下次激活时重取 */
    leaveTab(id) {
        if (!id) return;
        const leaving = this.state.openTabs.find((tab) => tab.id === id);
        if (leaving) leaving.htmlFresh = false;
        const editor = this.editors.get(id);
        if (editor) editor.flush().catch(() => undefined);
    }

    activateLibraryTab(id) {
        if (!this.state.openTabs.some((tab) => tab.id === id)) return;
        if (this.state.activeTabId !== id) this.leaveTab(this.state.activeTabId);
        this.state.activeTabId = id;
        this.renderWorkspace();
    }

    /** 关闭标签：编辑器先 flush，落盘失败（冲突或出错）须确认才放弃修改；随后销毁编辑器并关闭会话 */
    async closeLibraryTab(id) {
        const target = this.state.openTabs.find((tab) => tab.id === id);
        if (!target) return;
        const editor = this.editors.get(id);
        if (editor && !(await editor.flush())) {
            const name = target.label || target.name || '该文件';
            if (!window.confirm(`「${name}」的修改尚未保存，仍要关闭并放弃修改？`)) return;
        }
        this.disposeEditor(id);
        const index = this.state.openTabs.findIndex((tab) => tab.id === id);
        if (index === -1) return;
        const [tab] = this.state.openTabs.splice(index, 1);
        if (this.state.activeTabId === id) {
            const next = this.state.openTabs[index] || this.state.openTabs[index - 1] || this.state.openTabs[0];
            this.state.activeTabId = next ? next.id : null;
        }
        this.state.libraryReaderError = '';
        this.renderWorkspace();
        if (tab.sessionId) await api.previewClose(tab.sessionId).catch(() => undefined);
    }

    async openLibraryRecord(id) {
        const record = this.state.treeItems.find((item) => item.id === id) || this.state.items.find((item) => item.id === id);
        if (!record) throw new Error('未找到文件库记录');
        const filePath = readablePathForRecord(record);
        if (!filePath) {
            notify('该记录没有可直接阅读的 Markdown、HTML、XML、JSON 或 PDF 文件', 'info');
            return;
        }
        await this.openLibraryFile(filePath, record);
    }

    /**
     * options.index：插入位置（「重新载入」在原位置重开）；options.viewTab：打开后停在的视图页签。
     * 标签名只有记录的主文件（readablePathForRecord）才用记录标题，同一记录的旁路文件显示文件名。
     */
    async openLibraryFile(filePath, record = null, { index = -1, viewTab = 'rendered' } = {}) {
        const path = String(filePath || '').trim();
        if (!path) return;
        const matchedRecord = record || this.recordForPath(path);
        const existing = this.state.openTabs.find((tab) => tab.path === path);
        if (existing) {
            if (matchedRecord && !existing.recordId) existing.recordId = matchedRecord.id;
            this.activateLibraryTab(existing.id);
            return;
        }
        if (this.libraryOpening.has(path)) return;
        this.libraryOpening.add(path);
        this.state.libraryReaderBusy = true;
        this.state.libraryReaderError = '';
        this.renderWorkspace();
        try {
            const opened = await api.readerOpen({ path });
            rememberOpenFile(opened.path || path, opened.name);
            const isMainFile = Boolean(matchedRecord) && readablePathForRecord(matchedRecord) === path;
            const tab = {
                ...opened,
                id: opened.sessionId,
                label: isMainFile ? (matchedRecord.title || matchedRecord.name || opened.name) : opened.name,
                recordId: matchedRecord ? matchedRecord.id : '',
                tab: viewTab,
                dirty: false,
                viewRev: 0,
                htmlFresh: true,
            };
            if (this.state.activeTabId) this.leaveTab(this.state.activeTabId);
            if (index >= 0 && index <= this.state.openTabs.length) this.state.openTabs.splice(index, 0, tab);
            else this.state.openTabs.push(tab);
            this.state.activeTabId = tab.id;
            for (const warning of opened.warnings || []) notify(warning, 'warning', 6000);
        } catch (err) {
            this.state.libraryReaderError = err.message || '打开文件失败';
            notify(this.state.libraryReaderError, 'error', 6000);
        } finally {
            this.libraryOpening.delete(path);
            this.state.libraryReaderBusy = false;
            this.renderWorkspace();
        }
    }

    async pickLibraryFile() {
        try {
            const picked = await api.pickFiles({ purpose: 'read' });
            if (picked.canceled || picked.paths.length === 0) return;
            await this.openLibraryFile(picked.paths[0]);
        } catch (err) {
            notify(err.message, 'error', 6000);
        }
    }

    renderMigration() {
        const panel = this.querySelector('.migration-panel');
        const { plan, planResult, migrating } = this.state;
        if (!plan && !planResult) {
            panel.hidden = true;
            panel.innerHTML = '';
            return;
        }
        panel.hidden = false;
        if (planResult) {
            const { moved, failed } = planResult;
            panel.innerHTML = `
                <h3>迁移结果</h3>
                <p>已迁移 ${moved.length} 条${failed.length ? `，失败 ${failed.length} 条` : ''}。</p>
                ${failed.length ? `<ul class="plan-list">${failed.map((item) => `<li class="is-conflict">${escapeHtml(item.from)}<br><small>${escapeHtml(item.error)}</small></li>`).join('')}</ul>` : ''}
                <div class="plan-actions"><button class="btn btn-small btn-secondary" type="button" data-action="close-plan">关闭</button></div>`;
            return;
        }
        const moves = plan.moves.map((move) => `<li${move.conflict ? ' class="is-conflict"' : ''}>${escapeHtml(move.from)}<br>→ ${escapeHtml(move.to)}${move.conflict ? '<small>（同名，已加后缀）</small>' : ''}</li>`).join('');
        const skipped = plan.skipped.map((item) => `<li><small>${escapeHtml(item.reason)}</small></li>`).join('');
        panel.innerHTML = `
            <h3>迁移预览（dryRun）</h3>
            <p>将移动 ${plan.moves.length} 条产物到托管目录，跳过 ${plan.skipped.length} 条。</p>
            ${moves ? `<ul class="plan-list">${moves}</ul>` : ''}
            ${skipped ? `<details><summary>跳过明细</summary><ul class="plan-list">${skipped}</ul></details>` : ''}
            <div class="plan-actions">
                <button class="btn btn-small btn-primary" type="button" data-action="run-plan" ${plan.moves.length === 0 || migrating ? 'disabled' : ''}>${migrating ? '迁移中…' : '执行迁移'}</button>
                <button class="btn btn-small btn-secondary" type="button" data-action="close-plan">取消</button>
            </div>`;
    }

    closeContextMenu() {
        const menu = this.querySelector('[data-role="library-context-menu"]');
        if (menu) {
            menu.hidden = true;
            menu.replaceChildren();
        }
        this.state.contextRecordId = null;
    }

    onContextMenu(event) {
        const target = event.target instanceof Element ? event.target : null;
        const file = target ? target.closest('button.library-tree-file[data-tree-record]') : null;
        const row = target ? target.closest('li.record[data-id]') : null;
        const recordId = file ? file.dataset.treeRecord : (row ? row.dataset.id : '');
        if (!recordId) return;
        const record = this.state.treeItems.find((item) => item.id === recordId)
            || this.state.items.find((item) => item.id === recordId);
        if (!record) return;
        event.preventDefault();
        const menu = this.querySelector('[data-role="library-context-menu"]');
        if (!menu) return;
        this.state.contextRecordId = record.id;
        const unavailable = record.missing ? ' disabled' : '';
        menu.innerHTML = [
            '<button type="button" role="menuitem" data-context-action="open-reader">在文件库中打开</button>',
            `<button type="button" role="menuitem" data-context-action="reveal"${unavailable}>定位</button>`,
            `<button type="button" role="menuitem" data-context-action="open"${unavailable}>打开文件</button>`,
            '<button type="button" role="menuitem" data-context-action="reconvert">重新转换</button>',
            '<div class="library-context-menu-separator" role="separator"></div>',
            '<button type="button" role="menuitem" data-context-action="favorite">',
            record.favorite ? '取消收藏' : '收藏',
            '</button>',
            '<button type="button" role="menuitem" data-context-action="highlight">',
            record.highlighted ? '取消高亮' : '高亮',
            '</button>',
            '<div class="library-context-menu-separator" role="separator"></div>',
            '<button type="button" role="menuitem" data-context-action="delete" class="is-danger">删除</button>',
        ].join('');
        menu.hidden = false;
        const gap = 8;
        const maxX = Math.max(gap, window.innerWidth - menu.offsetWidth - gap);
        const maxY = Math.max(gap, window.innerHeight - menu.offsetHeight - gap);
        menu.style.left = String(Math.min(event.clientX, maxX)) + 'px';
        menu.style.top = String(Math.min(event.clientY, maxY)) + 'px';
    }

    async onClick(event) {
        const managerBackdrop = event.target instanceof Element
            ? event.target.closest('[data-role="repository-manager"]')
            : null;
        if (managerBackdrop && event.target === managerBackdrop) {
            this.closeRepositoryManager();
            return;
        }
        const recordRow = event.target instanceof Element
            ? event.target.closest('li.record[data-id]')
            : null;
        const interactiveTarget = event.target instanceof Element
            ? event.target.closest('button, a, input, textarea, select, summary, [contenteditable="true"], .record-actions, .record-editor, .record-confirm')
            : null;
        if (recordRow && !interactiveTarget) {
            try {
                await this.openLibraryRecord(recordRow.dataset.id);
            } catch (err) {
                notify(err.message, 'error', 6000);
            }
            return;
        }
        const contextButton = event.target instanceof Element
            ? event.target.closest('button[data-context-action]')
            : null;
        if (contextButton) {
            const id = this.state.contextRecordId;
            const record = this.state.treeItems.find((item) => item.id === id);
            const action = contextButton.dataset.contextAction;
            this.closeContextMenu();
            if (!record) return;
            try {
                if (action === 'open-reader') await this.openLibraryRecord(id);
                else if (action === 'reveal') await api.libraryReveal(id);
                else if (action === 'open') await api.libraryOpen(id);
                else if (action === 'reconvert') await this.reconvert(id);
                else if (action === 'favorite') {
                    await api.libraryUpdate(id, { favorite: !record.favorite });
                    await this.load();
                } else if (action === 'highlight') {
                    await api.libraryUpdate(id, { highlighted: !record.highlighted });
                    await this.load();
                } else if (action === 'delete') {
                    this.state.confirming = id;
                    this.render();
                }
            } catch (err) {
                notify(err.message, 'error', 6000);
            }
            return;
        }
        const fileButton = event.target instanceof Element
            ? event.target.closest('button[data-tree-record], button[data-tree-path]')
            : null;
        if (fileButton) {
            try {
                // 条目带路径时按路径打开（同一记录的旁路文件各自成条）；只有记录、没有路径的条目（托管树）按记录打开
                if (fileButton.dataset.treePath) {
                    const record = fileButton.dataset.treeRecord ? this.findRecord(fileButton.dataset.treeRecord) : null;
                    await this.openLibraryFile(fileButton.dataset.treePath, record);
                } else await this.openLibraryRecord(fileButton.dataset.treeRecord);
            } catch (err) {
                notify(err.message, 'error', 6000);
            }
            return;
        }
        const libraryTab = event.target instanceof Element ? event.target.closest('[data-library-tab]') : null;
        if (libraryTab) {
            this.activateLibraryTab(libraryTab.dataset.libraryTab);
            return;
        }
        const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
        if (!button || button.closest('mf-facets')) return;
        const { action } = button.dataset;
        const row = button.closest('li.record');
        const id = row ? row.dataset.id : null;
        const record = id ? this.state.items.find((item) => item.id === id) : null;
        try {
            switch (action) {
                case 'toggle-sort-menu':
                    this.state.sortMenuOpen = !this.state.sortMenuOpen;
                    this.renderSortMenu();
                    if (this.state.sortMenuOpen) this.querySelector('[data-action="toggle-sort-menu"]')?.focus();
                    break;
                case 'select-sort': {
                    const { sortField, sortOrder } = button.dataset;
                    if (sortField && sortOrder && (sortField !== this.state.sort || sortOrder !== this.state.order)) {
                        this.state.sort = sortField;
                        this.state.order = sortOrder;
                        this.state.sortMenuOpen = false;
                        await this.load();
                    } else {
                        this.closeSortMenu();
                    }
                    break;
                }
                case 'toggle-reveal-active':
                    this.state.revealActiveFile = !this.state.revealActiveFile;
                    this.querySelector('[data-role="reveal-toggle"]')?.setAttribute('aria-pressed', String(this.state.revealActiveFile));
                    this.revealActiveFileInTree();
                    break;
                case 'toggle-repository-menu':
                    this.state.repositoryMenuOpen = !this.state.repositoryMenuOpen;
                    this.renderRepositorySwitcher();
                    if (this.state.repositoryMenuOpen) this.querySelector('[data-action="toggle-repository-menu"]')?.focus();
                    break;
                case 'manage-repositories':
                    this.openRepositoryManager();
                    break;
                case 'select-library-repository':
                    await this.selectRepository(button.dataset.repositoryPath);
                    break;
                case 'toggle-repository-manager-menu':
                    this.state.repositoryManagerMenuPath = this.state.repositoryManagerMenuPath === button.dataset.repositoryPath ? '' : button.dataset.repositoryPath;
                    this.renderRepositoryManager();
                    break;
                case 'select-manager-repository':
                    await this.selectRepository(button.dataset.repositoryPath);
                    break;
                case 'remove-library-repository':
                    await this.removeRepository(button.dataset.repositoryPath);
                    break;
                case 'create-library-repository':
                    await this.createLibraryRepository();
                    break;
                case 'open-library-repository':
                    await this.openLibraryRepository();
                    break;
                case 'close-repository-manager':
                    this.closeRepositoryManager();
                    break;
                case 'pick-reader': await this.pickLibraryFile(); break;
                case 'toggle-expand-all': {
                    const tree = this.querySelector('[data-role="library-tree"]');
                    const nodes = tree ? [...tree.querySelectorAll('details.library-tree-node')] : [];
                    const allOpen = nodes.length > 0 && nodes.every((node) => node.open);
                    this.setAllTreeFolders(!allOpen);
                    break;
                }
                case 'migrate': await this.previewMigration(); break;
                case 'run-plan': await this.runMigration(); break;
                case 'close-plan':
                    this.state.plan = null;
                    this.state.planResult = null;
                    this.renderMigration();
                    break;
                case 'close-library-tab': await this.closeLibraryTab(button.dataset.tabId); break;
                case 'favorite':
                    if (record) { await api.libraryUpdate(id, { favorite: !record.favorite }); await this.load(); }
                    break;
                case 'edit-tags':
                    this.state.editingTags = id;
                    this.render();
                    this.querySelector(`li[data-id="${CSS.escape(id)}"] input[data-role="tags"]`).focus();
                    break;
                case 'cancel-tags':
                    this.state.editingTags = null;
                    this.render();
                    break;
                case 'save-tags': {
                    const input = row.querySelector('input[data-role="tags"]');
                    const tags = input.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
                    await api.libraryUpdate(id, { tags });
                    this.state.editingTags = null;
                    notify('标签已更新', 'success');
                    await this.load();
                    break;
                }
                case 'remove':
                    this.state.confirming = id;
                    this.render();
                    break;
                case 'cancel-remove':
                    this.state.confirming = null;
                    this.render();
                    break;
                case 'remove-index':
                case 'remove-trash': {
                    const result = await api.libraryRemove(id, action === 'remove-trash');
                    this.state.confirming = null;
                    notify(result.trashed ? '记录已删除，产物已移到废纸篓' : '记录已删除', 'success');
                    await this.load();
                    break;
                }
                default: break;
            }
        } catch (err) {
            notify(err.message, 'error', 6000);
        }
    }

    // ---------- 顶部栏文档功能（状态经 store.libraryDoc 发布，命令经 mf-doc-command 接收） ----------

    activeTab() {
        return this.state.openTabs.find((tab) => tab.id === this.state.activeTabId) || null;
    }

    /** 切换视图页签（按钮在顶部栏）：切进「渲染」时按编辑器当前文本（无编辑器则按磁盘）重取渲染 */
    switchLibraryView(key) {
        const active = this.activeTab();
        if (!active || key === active.tab || !this.libraryTabsFor(active).some(([value]) => value === key)) return;
        if (key === 'rendered' && active.tab !== 'rendered') active.htmlFresh = false;
        active.tab = key;
        this.renderWorkspace();
    }

    /** 编辑器保存状态记在所属标签上；当前标签的状态经 store.libraryDoc 显示在顶部栏标题旁 */
    onEditorStatus(event) {
        const tab = this.tabForEditorEvent(event);
        if (!tab) return;
        tab.mdStatus = toSaveState(event.detail);
        if (tab.id === this.state.activeTabId) this.publishDoc();
    }

    /** 查找与大纲定位的目标：编辑页为编辑区；其余为视图帧，md 原文按行定位，渲染视图与 XML 结构视图按标题元素定位 */
    viewContext() {
        const active = this.activeTab();
        if (!active || !active.view || this.state.libraryReaderBusy || this.state.libraryReaderError) return null;
        if (active.view.kind === 'md' && active.tab === 'edit') {
            const editor = this.editors.get(active.id);
            return { mode: 'edit', textarea: editor ? editor.textarea : null, frame: null };
        }
        return { mode: active.view.kind === 'md' && active.tab === 'raw' ? 'raw' : 'rendered', frame: this.querySelector('[data-role="reader-frame"] .view-frame'), textarea: null };
    }

    /** 大纲：md 在渲染与编辑页取编辑器当前文本（原文页取已保存的原文，与原文帧一致）；xml 只在结构视图取章节标题 */
    outlineFor(tab) {
        const view = tab && tab.view;
        if (!view) return [];
        if (view.kind === 'md') {
            const editor = this.editors.get(tab.id);
            return extractMarkdownOutline(editor && tab.tab !== 'raw' ? editor.value : view.raw);
        }
        if (view.kind === 'xml' && tab.tab === 'rendered' && view.structuredHtml) return extractHtmlOutline(view.structuredHtml);
        return [];
    }

    isTabPathOpen(key) {
        return this.state.openTabs.some((tab) => tab.path === key);
    }

    buildDoc() {
        const active = this.activeTab();
        if (!active) return null;
        const view = active.view || {};
        const kind = view.kind || active.kind || '';
        const record = this.recordForTab(active);
        const outline = this.outlineFor(active);
        const isOpen = (key) => this.isTabPathOpen(key);
        return {
            sessionId: active.sessionId,
            title: active.label || active.name || active.path,
            path: active.path,
            ...docLocation(active.path),
            kind,
            views: this.libraryTabsFor(active),
            activeView: active.tab,
            canBack: canStepHistory(this.navHistory, -1, isOpen),
            canForward: canStepHistory(this.navHistory, 1, isOpen),
            favorite: Boolean(record && record.favorite),
            canFavorite: Boolean(record),
            favoriteHint: record ? '' : '该文件未登记为文件库记录，无法收藏（转换产物会自动登记）',
            canReconvert: Boolean(record),
            canClose: false,
            hasOutline: outline.length > 0,
            outlineHint: outlineHintFor(kind, active.tab, outline.length),
            outline,
            canFind: kind !== 'pdf',
            canZoom: kind !== 'pdf',
            zoom: this.docZoom,
            saveState: kind === 'md' ? active.mdStatus || null : null,
        };
    }

    /** 文档状态序列化后与上次比较，未变不重复写 store */
    publishDoc() {
        const doc = this.buildDoc();
        const serialized = doc ? JSON.stringify(doc) : '';
        if (serialized === this.publishedDoc) return;
        this.publishedDoc = serialized;
        store.set({ libraryDoc: doc });
    }

    onDocCommand(detail) {
        const active = this.activeTab();
        if (!detail || detail.route !== 'library' || !active) return;
        switch (detail.command) {
            case 'back': this.navigate(-1); break;
            case 'forward': this.navigate(1); break;
            case 'view': this.switchLibraryView(detail.value); break;
            case 'outline': detail.result = this.outlineFor(active); break;
            case 'outline-go': gotoOutlineItem(this.viewContext(), detail.value, this.outlineFor(active)); break;
            case 'find': detail.result = findInView(this.viewContext(), detail.value || {}); break;
            case 'find-close': endFindInView(this.viewContext()); break;
            case 'zoom': this.changeZoom(detail.value); break;
            case 'favorite': this.toggleActiveFavorite(active); break;
            case 'reveal':
            case 'open':
            case 'copyPath': this.runFileAction(active.sessionId, detail.command); break;
            case 'reconvert': {
                const record = this.recordForTab(active);
                if (record) this.reconvert(record.id).catch((err) => notify(err.message, 'error', 6000));
                break;
            }
            default: break;
        }
    }

    /** 后退 / 前进：按标签激活历史，跳过已关闭的标签；先移动游标再激活，renderWorkspace 里的访问记录即与当前项相同而不重复记 */
    navigate(direction) {
        const index = findHistoryStep(this.navHistory, direction, (key) => this.isTabPathOpen(key));
        if (index < 0) return;
        const target = this.state.openTabs.find((tab) => tab.path === this.navHistory.entries[index]);
        if (!target) return;
        this.navHistory = moveHistory(this.navHistory, index);
        this.activateLibraryTab(target.id);
    }

    /** 字号：先读回最新值（阅读页可能改过）再步进一档，写回 localStorage，当前帧与编辑器实时生效 */
    changeZoom(direction) {
        this.docZoom = writeDocZoom(stepZoom(readDocZoom(), direction));
        this.applyZoom();
        this.publishDoc();
    }

    applyZoom() {
        applyDocZoom({ frame: this.querySelector('[data-role="reader-frame"] .view-frame'), editorHost: this.querySelector('[data-role="editor-host"]') }, this.docZoom);
    }

    /** 收藏当前文件：沿用右键菜单的 libraryUpdate 与重载；文件不属于任何记录时顶部栏按钮已禁用 */
    async toggleActiveFavorite(active) {
        const record = this.recordForTab(active);
        if (!record) return;
        try {
            await api.libraryUpdate(record.id, { favorite: !record.favorite });
            await this.load();
        } catch (err) {
            notify(err.message, 'error', 6000);
        }
    }

    async runFileAction(sessionId, action) {
        try {
            await api.fileAction(sessionId, action);
            if (action === 'copyPath') notify('已复制文件路径', 'success');
        } catch (err) {
            notify(err.message, 'error', 6000);
        }
    }

    async reconvert(id) {
        const res = await api.libraryReconvert(id);
        addTasks(res.tasks.map((task) => ({
            id: task.taskId,
            ...(task.input && /^https?:\/\//i.test(task.input) ? { url: task.input } : { path: task.input }),
            name: task.name, type: task.type, target: task.target, status: 'queued', runId: res.runId,
        })));
        store.set({ run: { runId: res.runId, outputDir: res.outputDir } });
        notify('已加入转换队列', 'info');
        location.hash = '#/convert';
    }

    async chooseLibraryFolder() {
        return this.openLocalRepository({ title: '选择知识库仓库文件夹', message: '本地仓库已添加并切换' });
    }

    async createLibraryRepository() {
        return this.openLocalRepository({ title: '新建本地仓库', message: '本地仓库已创建并切换' });
    }

    async openLibraryRepository() {
        return this.openLocalRepository({ title: '打开本地仓库', message: '本地仓库已添加并打开' });
    }

    async openLocalRepository({ title, message } = {}) {
        const current = this.state.repositoryRoot || this.state.repositoryRoots[0] || '';
        try {
            const result = await api.pickDirectory({ title: title || '选择知识库仓库文件夹', defaultPath: current || undefined });
            if (result.canceled || !result.path) return;
            const repository = normalizeRepositoryPath(result.path);
            if (!repository) return;
            if (repository === this.state.managedRepositoryRoot) {
                notify('MarkFlow Library 已固定列在仓库列表最前，无需再添加', 'warning');
                return;
            }
            const repositories = [...this.state.repositoryRoots.filter((item) => item !== repository), repository].slice(0, MAX_REPOSITORIES);
            const described = await api.settingsSet({ library: { repositories, activeRepository: repository } });
            store.set({ settings: described });
            await this.load(repository);
            this.state.repositoryManagerOpen = true;
            this.renderRepositoryManager();
            notify(message || '本地仓库已添加并切换', 'success');
        } catch (err) {
            notify(err.message, 'error', 6000);
        }
    }

    async removeRepository(value) {
        const repository = normalizeRepositoryPath(value);
        if (!repository || !this.state.repositoryRoots.includes(repository)) return;
        if (this.state.repositoryRoots.length <= 1) {
            notify('至少保留一个本地仓库', 'warning');
            this.state.repositoryManagerMenuPath = '';
            this.renderRepositoryManager();
            return;
        }
        const repositories = this.state.repositoryRoots.filter((item) => item !== repository);
        const activeRepository = repository === this.state.repositoryRoot ? repositories[0] : this.state.repositoryRoot;
        try {
            const described = await api.settingsSet({ library: { repositories, activeRepository } });
            store.set({ settings: described });
            this.state.repositoryManagerMenuPath = '';
            await this.load(activeRepository);
            notify('仓库已从列表移除，本地文件夹未删除', 'success');
        } catch (err) {
            notify(err.message, 'error', 6000);
        }
    }

    async previewMigration() {
        const res = await api.libraryMigrate(true);
        this.state.plan = res.plan;
        this.state.planResult = null;
        this.renderMigration();
    }

    async runMigration() {
        this.state.migrating = true;
        this.renderMigration();
        try {
            const res = await api.libraryMigrate(false);
            this.state.planResult = res.result;
            this.state.plan = null;
            notify(`迁移完成：${res.result.moved.length} 条`, res.result.failed.length ? 'warning' : 'success');
            await this.load();
        } finally {
            this.state.migrating = false;
            this.renderMigration();
        }
    }
}

customElements.define('mf-library-page', MfLibraryPage);
