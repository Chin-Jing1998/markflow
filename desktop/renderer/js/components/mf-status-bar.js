/**
 * <mf-status-bar>：全宽顶部状态栏（即窗口标题栏区域：空白处可拖动窗口，控件与弹层为 no-drag）。
 * 默认仅显示应用名称；路由到文件库页或阅读页时换显该页的搜索 / 仅显示收藏 / 折叠侧栏三个按钮（参考 Obsidian 顶栏图标行，
 * 位置贴近红绿灯；侧栏折叠时只留折叠按钮）。该页有打开的文件时（store.libraryDoc / store.readerDoc 非 null）另显文档功能：
 *   左区：三个按钮之后接「后退 / 前进」（⌘[ / ⌘]；焦点在输入框或编辑区时不拦截）；
 *   中区：文件名、Markdown 保存状态与所在文件夹（小字），过长时省略；
 *   右区：视图分段控件、内联查找框（⌘F；Enter 或 ⌘G 下一个、⇧Enter 或 ⇧⌘G 上一个、Esc 关闭）、阅读辅助（大纲、查找、A−、A+）、
 *         当前文件操作（收藏、在访达中显示、用默认应用打开）与「⋯」菜单（复制路径；文件库另有重新转换，阅读页另有关闭文件）。
 *         窗口变窄时先收起文件操作、再收起阅读辅助，均改入「⋯」，视图分段控件保留到最后。
 * 本组件与 <mf-library-page>/<mf-reader-page> 互不直接引用：状态只从 store 读，操作经 window 上的 mf-doc-command 事件
 * { route, command, value } 下发；需要回包的命令（outline、find）由页面同步写入 event.detail.result。
 * ⌘+ / ⌘- 不在此绑定，留给应用菜单的整窗缩放。
 */
import { store } from '../store.js';
import { icon } from '../icons.js';
import { platform } from '../api.js';
import { escapeHtml, escapeAttr } from '../dom.js';
import { DOC_ZOOM } from '../doc-tools.mjs';

// 两个路由各自的状态字段名；库与阅读页各自独立，互不影响。
const ROUTE_FIELDS = Object.freeze({
    library: { collapsed: 'librarySidebarCollapsed', favorites: 'libraryFavoritesOnly', search: 'librarySearchOpen', doc: 'libraryDoc' },
    reader: { collapsed: 'readerSidebarCollapsed', favorites: 'readerFavoritesOnly', search: 'readerSearchOpen', doc: 'readerDoc' },
});
const IS_MAC = platform === 'darwin';
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
const FIND_NEXT_KEYS = IS_MAC ? '⌘G' : 'Ctrl+G';
const FIND_PREV_KEYS = IS_MAC ? '⇧⌘G' : 'Ctrl+Shift+G';
const REVEAL_LABEL = IS_MAC ? '在访达中显示' : (platform === 'win32' ? '在资源管理器中显示' : '在文件管理器中显示');
// 右区可收进「⋯」的分组，按收起先后排列：先收文件操作，再收阅读辅助
const COLLAPSIBLE_GROUPS = Object.freeze(['file', 'aids']);
const MIN_TITLE_WIDTH = 140;
const POPOVER_MARGIN = 8;
const TEXT_ENTRY = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const MENU_SEPARATOR = '<div class="status-bar-menu-separator" role="separator"></div>';

const docButton = (action, iconName, label, extra = '') => `<button class="icon-btn icon-btn-sm" type="button" data-action="${action}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}"${extra}>${icon(iconName)}</button>`;
const menuItem = (command, label, disabled = false) => `<button type="button" role="menuitem" data-menu-command="${command}"${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`;

/** 文档按钮的可用态用 aria-disabled 而非 disabled：禁用时仍可悬停看到说明（如「未登记为记录，无法收藏」） */
function setButton(button, { enabled = true, label = null, pressed = null } = {}) {
    if (!button) return;
    button.setAttribute('aria-disabled', String(!enabled));
    if (label !== null) {
        button.title = label;
        button.setAttribute('aria-label', label);
    }
    if (pressed !== null) button.setAttribute('aria-pressed', String(pressed));
}

class MfStatusBar extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.doc = null;
        this.docKey = '';
        this.findOpen = false;
        // 当前展开的弹层（'' | 'menu' | 'outline'）。字段不可取名 popover：HTMLElement 上同名属性属 Popover API，赋值会把本元素变成弹层
        this.activePopover = '';
        this.activePopoverAnchor = null;
        this.outlineItems = [];
        this.collapsedGroups = [];
        this.innerHTML = `
            <span class="status-bar-brand">MarkFlow</span>
            <div class="status-bar-library-tools" data-role="library-tools" hidden>
                <button class="icon-btn icon-btn-sm" type="button" data-action="toggle-search" data-role="search-btn" title="搜索" aria-label="搜索" aria-expanded="false">${icon('search')}</button>
                <button class="icon-btn icon-btn-sm" type="button" data-action="toggle-favorites" data-role="favorites-btn" title="仅显示收藏" aria-label="仅显示收藏" aria-pressed="false">${icon('star')}</button>
                <button class="icon-btn icon-btn-sm" type="button" data-action="toggle-sidebar" title="折叠侧边栏" aria-label="折叠侧边栏">${icon('panelLeftClose')}</button>
                <span class="status-bar-doc-nav" data-role="doc-nav" hidden>
                    <span class="status-bar-sep" aria-hidden="true"></span>
                    ${docButton('doc-back', 'chevronLeft', `后退（${MOD}[）`)}
                    ${docButton('doc-forward', 'chevronRight', `前进（${MOD}]）`)}
                </span>
            </div>
            <div class="status-bar-doc-title" data-role="doc-title" hidden></div>
            <div class="status-bar-doc-tools" data-role="doc-tools" hidden>
                <span class="pane-tabs status-bar-doc-views" data-role="doc-views" role="tablist" aria-label="文件视图" hidden></span>
                <div class="status-bar-find" data-role="find" role="search" hidden>
                    <input class="input input-slim status-bar-find-input" type="search" data-role="find-input" placeholder="在文档中查找" aria-label="在文档中查找" spellcheck="false">
                    <span class="status-bar-find-count" data-role="find-count" aria-live="polite"></span>
                    ${docButton('find-prev', 'chevronUp', `上一个（⇧Enter 或 ${FIND_PREV_KEYS}）`)}
                    ${docButton('find-next', 'chevronDown', `下一个（Enter 或 ${FIND_NEXT_KEYS}）`)}
                    ${docButton('find-close', 'x', '关闭查找（Esc）')}
                </div>
                <div class="status-bar-doc-group" data-group="aids">
                    ${docButton('doc-outline', 'outline', '大纲', ' data-role="outline-btn" aria-haspopup="menu" aria-expanded="false"')}
                    ${docButton('doc-find', 'findInPage', `在文档中查找（${MOD}F）`, ' data-role="find-btn" aria-pressed="false"')}
                    <button class="icon-btn icon-btn-sm status-bar-zoom-btn" type="button" data-action="doc-zoom-out" data-role="zoom-out" title="缩小字号" aria-label="缩小字号">A−</button>
                    <button class="icon-btn icon-btn-sm status-bar-zoom-btn" type="button" data-action="doc-zoom-in" data-role="zoom-in" title="放大字号" aria-label="放大字号">A+</button>
                </div>
                <div class="status-bar-doc-group" data-group="file">
                    <button class="icon-btn icon-btn-sm status-bar-doc-star" type="button" data-action="doc-favorite" data-role="favorite-btn" title="收藏当前文件" aria-label="收藏当前文件" aria-pressed="false">${icon('star')}</button>
                    ${docButton('doc-reveal', 'folderOpen', REVEAL_LABEL)}
                    ${docButton('doc-open', 'open', '用默认应用打开')}
                </div>
                ${docButton('doc-more', 'more', '更多操作', ' data-role="more-btn" aria-haspopup="menu" aria-expanded="false"')}
                <div class="status-bar-popover status-bar-menu" data-role="doc-menu" role="menu" aria-label="更多操作" hidden></div>
                <div class="status-bar-popover status-bar-outline" data-role="doc-outline" role="menu" aria-label="大纲" hidden></div>
            </div>`;
        const input = this.querySelector('[data-role="find-input"]');
        input.addEventListener('input', (event) => { if (!event.isComposing) this.runFind({ reset: true }); });
        input.addEventListener('compositionend', () => this.runFind({ reset: true }));
        input.addEventListener('keydown', (event) => this.onFindKey(event));
        this.addEventListener('click', (event) => this.onClick(event));
        this.onDocumentKey = (event) => this.onShortcut(event);
        this.onDocumentPointer = (event) => {
            const target = event.target instanceof Element ? event.target : null;
            if (!target || !target.closest('.status-bar-popover, [data-role="more-btn"], [data-role="outline-btn"]')) this.closePopover();
        };
        // 点进帧内时父页收不到 pointerdown，但窗口会失焦：借此收起弹层
        this.onWindowBlur = () => this.closePopover();
        document.addEventListener('keydown', this.onDocumentKey);
        document.addEventListener('pointerdown', this.onDocumentPointer, true);
        window.addEventListener('blur', this.onWindowBlur);
        if (typeof ResizeObserver === 'function') {
            this.resizeObserver = new ResizeObserver(() => this.layoutDocTools());
            this.resizeObserver.observe(this);
        }
        this.unsubscribe = store.subscribe((state) => this.sync(state));
        this.sync(store.get());
    }

    disconnectedCallback() {
        if (this.unsubscribe) this.unsubscribe();
        document.removeEventListener('keydown', this.onDocumentKey);
        document.removeEventListener('pointerdown', this.onDocumentPointer, true);
        window.removeEventListener('blur', this.onWindowBlur);
        if (this.resizeObserver) this.resizeObserver.disconnect();
    }

    /** 向当前路由的页面下发文档命令；页面同步写入的 detail.result 作为回包 */
    command(name, value) {
        const route = store.get().route;
        if (!ROUTE_FIELDS[route]) return undefined;
        const detail = { route, command: name, value };
        window.dispatchEvent(new CustomEvent('mf-doc-command', { detail }));
        return detail.result;
    }

    onClick(event) {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const view = target.closest('[data-doc-view]');
        if (view) {
            this.command('view', view.dataset.docView);
            return;
        }
        const outlineEntry = target.closest('[data-outline-index]');
        if (outlineEntry) {
            this.closePopover();
            const item = this.outlineItems[Number(outlineEntry.dataset.outlineIndex)];
            if (item) this.command('outline-go', item);
            return;
        }
        const menuEntry = target.closest('[data-menu-command]');
        if (menuEntry) {
            this.closePopover();
            this.runMenuCommand(menuEntry.dataset.menuCommand);
            return;
        }
        const button = target.closest('button[data-action]');
        if (!button || button.getAttribute('aria-disabled') === 'true') return;
        const state = store.get();
        const fields = ROUTE_FIELDS[state.route];
        if (!fields) return;
        switch (button.dataset.action) {
            case 'toggle-search': store.set({ [fields.search]: !state[fields.search] }); break;
            case 'toggle-favorites': store.set({ [fields.favorites]: !state[fields.favorites] }); break;
            case 'toggle-sidebar': store.set({ [fields.collapsed]: !state[fields.collapsed] }); break;
            case 'doc-back': this.command('back'); break;
            case 'doc-forward': this.command('forward'); break;
            case 'doc-outline': this.toggleOutline(button); break;
            case 'doc-find': if (this.findOpen) this.closeFind(); else this.openFind(); break;
            case 'doc-zoom-out': this.command('zoom', -1); break;
            case 'doc-zoom-in': this.command('zoom', 1); break;
            case 'doc-favorite': this.command('favorite'); break;
            case 'doc-reveal': this.command('reveal'); break;
            case 'doc-open': this.command('open'); break;
            case 'doc-more': this.toggleMenu(button); break;
            case 'find-prev': this.runFind({ backwards: true }); break;
            case 'find-next': this.runFind({}); break;
            case 'find-close': this.closeFind(); break;
            default: break;
        }
    }

    runMenuCommand(name) {
        if (name === 'outline') this.toggleOutline(this.querySelector('[data-role="more-btn"]'));
        else if (name === 'find') this.openFind();
        else if (name === 'zoom-out' || name === 'zoom-in') this.command('zoom', name === 'zoom-in' ? 1 : -1);
        else this.command(name);
    }

    sync(state) {
        const fields = ROUTE_FIELDS[state.route];
        this.querySelector('.status-bar-brand').hidden = Boolean(fields);
        const tools = this.querySelector('[data-role="library-tools"]');
        tools.hidden = !fields;
        this.syncDoc(fields ? state[fields.doc] || null : null, state.route);
        if (!fields) return;
        // 侧栏折叠后搜索与「仅显示收藏」都作用不到已隐藏的文件树，一并隐藏；折叠按钮始终留在原位（贴近红绿灯），单独可见。
        const collapsed = state[fields.collapsed];
        this.querySelector('[data-role="search-btn"]').hidden = collapsed;
        this.querySelector('[data-role="favorites-btn"]').hidden = collapsed;
        this.querySelector('[data-action="toggle-search"]').setAttribute('aria-expanded', String(state[fields.search]));
        this.querySelector('[data-action="toggle-favorites"]').setAttribute('aria-pressed', String(state[fields.favorites]));
        const collapseButton = this.querySelector('[data-action="toggle-sidebar"]');
        const label = collapsed ? '展开侧边栏' : '折叠侧边栏';
        collapseButton.title = label;
        collapseButton.setAttribute('aria-label', label);
        collapseButton.innerHTML = icon(collapsed ? 'panelLeftOpen' : 'panelLeftClose');
    }

    /** 文档三区：无打开文件时全部隐藏（顶部栏保持原样）；换文件或换视图时收起弹层并清空查找计数 */
    syncDoc(doc, route) {
        const hasDoc = Boolean(doc);
        this.classList.toggle('has-doc', hasDoc);
        for (const role of ['doc-nav', 'doc-title', 'doc-tools']) this.querySelector(`[data-role="${role}"]`).hidden = !hasDoc;
        const key = hasDoc ? `${route}|${doc.sessionId}|${doc.activeView}` : '';
        if (key !== this.docKey) {
            this.docKey = key;
            this.closePopover();
            this.setFindCount('');
        }
        this.doc = doc;
        if (!hasDoc || !doc.canFind) this.closeFind({ silent: true });
        if (!hasDoc) return;
        this.renderTitle(doc);
        this.renderViews(doc);
        this.renderButtons(doc);
        if (this.activePopover === 'menu') this.renderMenu(doc);
        this.layoutDocTools();
    }

    renderTitle(doc) {
        const save = doc.saveState && doc.saveState.label
            ? `<span class="md-editor-status status-bar-doc-save" data-state="${escapeAttr(doc.saveState.state)}" title="${escapeAttr(doc.saveState.message || doc.saveState.label)}">${escapeHtml(doc.saveState.label)}</span>`
            : '';
        const folder = doc.folderName ? `<span class="status-bar-doc-folder" title="${escapeAttr(doc.folder)}">${escapeHtml(doc.folderName)}</span>` : '';
        const html = `<span class="status-bar-doc-name" title="${escapeAttr(doc.path || doc.title)}">${escapeHtml(doc.title)}</span>${save}${folder}`;
        if (html === this.titleHtml) return;
        this.titleHtml = html;
        this.querySelector('[data-role="doc-title"]').innerHTML = html;
    }

    /** 视图分段控件复用 .pane-tabs / .pane-tab 配方；只有一个视图（json、html、pdf、无结构视图的 xml）时不显示 */
    renderViews(doc) {
        const views = Array.isArray(doc.views) ? doc.views : [];
        const html = views.length > 1
            ? views.map(([key, label]) => `<button class="pane-tab${key === doc.activeView ? ' is-active' : ''}" type="button" role="tab" data-doc-view="${escapeAttr(key)}" aria-selected="${key === doc.activeView}">${escapeHtml(label)}</button>`).join('')
            : '';
        const host = this.querySelector('[data-role="doc-views"]');
        host.hidden = !html;
        if (html === this.viewsHtml) return;
        this.viewsHtml = html;
        host.innerHTML = html;
    }

    renderButtons(doc) {
        const zoom = Number(doc.zoom) || DOC_ZOOM.fallback;
        const byRole = (role) => this.querySelector(`[data-role="${role}"]`);
        setButton(this.querySelector('[data-action="doc-back"]'), { enabled: Boolean(doc.canBack) });
        setButton(this.querySelector('[data-action="doc-forward"]'), { enabled: Boolean(doc.canForward) });
        setButton(byRole('outline-btn'), { enabled: Boolean(doc.hasOutline), label: doc.hasOutline ? '大纲' : (doc.outlineHint || '当前视图没有可列出的标题') });
        setButton(byRole('find-btn'), { enabled: Boolean(doc.canFind), label: doc.canFind ? `在文档中查找（${MOD}F）` : '当前视图不支持文档内查找', pressed: this.findOpen });
        const zoomHint = '当前视图不支持调整字号';
        setButton(byRole('zoom-out'), { enabled: Boolean(doc.canZoom) && zoom > DOC_ZOOM.min, label: doc.canZoom ? `缩小字号（当前 ${zoom}%）` : zoomHint });
        setButton(byRole('zoom-in'), { enabled: Boolean(doc.canZoom) && zoom < DOC_ZOOM.max, label: doc.canZoom ? `放大字号（当前 ${zoom}%）` : zoomHint });
        const favoriteLabel = doc.canFavorite ? (doc.favorite ? '取消收藏当前文件' : '收藏当前文件') : (doc.favoriteHint || '当前文件无法收藏');
        setButton(byRole('favorite-btn'), { enabled: Boolean(doc.canFavorite), label: favoriteLabel, pressed: Boolean(doc.favorite) });
    }

    /** 「⋯」菜单：被收起的分组在前，其后是复制路径与各页专属项（文件库：重新转换；阅读页：关闭文件） */
    renderMenu(doc) {
        if (!doc) return;
        const zoom = Number(doc.zoom) || DOC_ZOOM.fallback;
        const sections = [];
        if (this.collapsedGroups.includes('aids')) {
            sections.push([
                menuItem('outline', '大纲…', !doc.hasOutline),
                menuItem('find', `查找…（${MOD}F）`, !doc.canFind),
                menuItem('zoom-out', `缩小字号（当前 ${zoom}%）`, !doc.canZoom || zoom <= DOC_ZOOM.min),
                menuItem('zoom-in', '放大字号', !doc.canZoom || zoom >= DOC_ZOOM.max),
            ].join(''));
        }
        if (this.collapsedGroups.includes('file')) {
            sections.push([
                menuItem('favorite', doc.favorite ? '取消收藏当前文件' : '收藏当前文件', !doc.canFavorite),
                menuItem('reveal', REVEAL_LABEL),
                menuItem('open', '用默认应用打开'),
            ].join(''));
        }
        sections.push(`${menuItem('copyPath', '复制文件路径')}${doc.canReconvert ? menuItem('reconvert', '重新转换') : ''}`);
        if (doc.canClose) sections.push(menuItem('close', '关闭文件'));
        this.querySelector('[data-role="doc-menu"]').innerHTML = sections.join(MENU_SEPARATOR);
    }

    toggleMenu(anchor) {
        if (this.activePopover === 'menu') {
            this.closePopover();
            return;
        }
        this.renderMenu(this.doc);
        this.showPopover('menu', this.querySelector('[data-role="doc-menu"]'), anchor);
    }

    /** 大纲弹层：打开时向页面取最新大纲（编辑页按编辑区当前文本），取不到时退回 store 里发布的那份 */
    toggleOutline(anchor) {
        if (this.activePopover === 'outline') {
            this.closePopover();
            return;
        }
        if (!this.doc || !this.doc.hasOutline || !anchor) return;
        const fresh = this.command('outline');
        this.outlineItems = Array.isArray(fresh) ? fresh : (this.doc.outline || []);
        const host = this.querySelector('[data-role="doc-outline"]');
        host.innerHTML = this.outlineItems.length > 0
            ? `<div class="status-bar-popover-title">大纲</div>${this.outlineItems.map((item, position) => `<button class="status-bar-outline-item" type="button" role="menuitem" data-outline-index="${position}" data-level="${Math.min(6, Math.max(1, Number(item.level) || 1))}" title="${escapeAttr(item.text)}">${escapeHtml(item.text)}</button>`).join('')}`
            : '<div class="status-bar-popover-empty">当前视图没有可列出的标题</div>';
        this.showPopover('outline', host, anchor);
    }

    /** 弹层右缘对齐触发按钮右缘，并夹在窗口内 */
    showPopover(name, node, anchor) {
        this.closePopover();
        this.activePopover = name;
        this.activePopoverAnchor = anchor;
        node.hidden = false;
        anchor.setAttribute('aria-expanded', 'true');
        const barRect = this.getBoundingClientRect();
        const width = node.offsetWidth;
        const left = anchor.getBoundingClientRect().right - barRect.left - width;
        node.style.left = `${Math.round(Math.max(POPOVER_MARGIN, Math.min(left, barRect.width - width - POPOVER_MARGIN)))}px`;
    }

    closePopover() {
        if (!this.activePopover) return;
        for (const node of this.querySelectorAll('.status-bar-popover')) node.hidden = true;
        if (this.activePopoverAnchor) this.activePopoverAnchor.setAttribute('aria-expanded', 'false');
        this.activePopover = '';
        this.activePopoverAnchor = null;
    }

    /** 窗口变窄时按 COLLAPSIBLE_GROUPS 的顺序把分组收进「⋯」，直到中区文件名留出 MIN_TITLE_WIDTH；视图分段控件不收 */
    layoutDocTools() {
        const tools = this.querySelector('[data-role="doc-tools"]');
        const title = this.querySelector('[data-role="doc-title"]');
        if (!tools || tools.hidden || !this.clientWidth) return;
        const groups = COLLAPSIBLE_GROUPS.map((key) => tools.querySelector(`[data-group="${key}"]`));
        for (const group of groups) group.hidden = false;
        const collapsed = [];
        for (let index = 0; index < groups.length && title.clientWidth < MIN_TITLE_WIDTH; index += 1) {
            groups[index].hidden = true;
            collapsed.push(COLLAPSIBLE_GROUPS[index]);
        }
        if (collapsed.join(',') === this.collapsedGroups.join(',')) return;
        this.collapsedGroups = collapsed;
        this.closePopover();
    }

    // ---------- 查找 ----------

    openFind() {
        if (!this.doc || !this.doc.canFind) return;
        this.closePopover();
        this.findOpen = true;
        this.querySelector('[data-role="find"]').hidden = false;
        this.querySelector('[data-role="find-btn"]').setAttribute('aria-pressed', 'true');
        this.layoutDocTools();
        const input = this.querySelector('[data-role="find-input"]');
        input.focus();
        input.select();
        if (input.value) this.runFind({ reset: true });
    }

    /** silent：换到不支持查找的视图或文件关闭时只收起查找框，不再通知页面 */
    closeFind({ silent = false } = {}) {
        if (!this.findOpen) return;
        this.findOpen = false;
        this.querySelector('[data-role="find"]').hidden = true;
        this.querySelector('[data-role="find-btn"]').setAttribute('aria-pressed', 'false');
        this.setFindCount('');
        if (!silent) this.command('find-close');
        this.layoutDocTools();
    }

    runFind({ backwards = false, reset = false } = {}) {
        if (!this.findOpen) return;
        const query = this.querySelector('[data-role="find-input"]').value;
        // 查询串清空时同样下发：编辑页据此撤掉高亮，帧内视图对空串不做处理
        const result = this.command('find', { query, backwards, reset });
        if (!query) this.setFindCount('');
        else if (result && result.total > 0) this.setFindCount(`${result.current}/${result.total}`);
        else this.setFindCount('无结果', true);
    }

    setFindCount(text, empty = false) {
        const count = this.querySelector('[data-role="find-count"]');
        count.textContent = text;
        count.toggleAttribute('data-empty', empty);
    }

    onFindKey(event) {
        if (event.isComposing) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            this.runFind({ backwards: event.shiftKey });
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.closeFind();
        }
    }

    /** ⌘F 查找、⌘G / ⇧⌘G 下一处 / 上一处、⌘[ / ⌘] 后退前进、Esc 收起弹层或查找框；焦点在帧内时按键经 doc-view.prepareDocFrame 转发到这里 */
    onShortcut(event) {
        if (event.defaultPrevented || event.isComposing || !this.doc) return;
        if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey) {
            if (this.activePopover) {
                event.preventDefault();
                this.closePopover();
            } else if (this.findOpen) {
                event.preventDefault();
                this.closeFind();
            }
            return;
        }
        const mod = IS_MAC ? event.metaKey : event.ctrlKey;
        if (!mod || event.altKey) return;
        if (String(event.key || '').toLowerCase() === 'f' && !event.shiftKey) {
            if (!this.doc.canFind) return;
            event.preventDefault();
            this.openFind();
            return;
        }
        // ⌘G / ⇧⌘G：查找框已开时为下一处 / 上一处（焦点在查找框、编辑区或帧内均可）；未开时与 ⌘F 相同，打开查找框
        if (String(event.key || '').toLowerCase() === 'g') {
            if (!this.doc.canFind) return;
            event.preventDefault();
            if (this.findOpen) this.runFind({ backwards: event.shiftKey });
            else this.openFind();
            return;
        }
        const back = event.key === '[' || event.code === 'BracketLeft';
        const forward = event.key === ']' || event.code === 'BracketRight';
        if (event.shiftKey || (!back && !forward)) return;
        const target = event.target instanceof Element ? event.target : null;
        if (target && target.closest(TEXT_ENTRY)) return;
        event.preventDefault();
        this.command(back ? 'back' : 'forward');
    }
}

customElements.define('mf-status-bar', MfStatusBar);
