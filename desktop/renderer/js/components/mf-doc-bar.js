/**
 * <mf-doc-bar>：文档状态栏，只占主内容区宽度，左缘与页面文件树的右缘齐，不横跨左侧图标栏与文件树。
 * 由文件库页与阅读页各挂一份：文件库页挂在已打开文件标签条之下（标签条选的是「哪个文档」，本栏描述「当前这个文档」，
 * 由外到内自上而下排，且本栏紧贴它所描述的内容），阅读页无标签条，挂在主内容区最上方。
 * 无打开文件时整条 hidden、不占高度，内容区自然上移。
 * 承载三块：文件名 + Markdown 保存状态 + 所在文件夹（过长时省略）；视图分段控件；内联查找框
 * （Enter 或 ⌘G 下一个、⇧Enter 或 ⇧⌘G 上一个、Esc 关闭）。
 *
 * route 由宿主页面以 data-route（library | reader）指定，组件据此从 store 读该页的文档状态与查找开关，
 * 与页面之间只用既有的两条通道，不另立机制：
 *   - 操作经 window 上的 mf-doc-command 事件 { route, command, value } 下发，需要回包的命令（find）由页面同步写入 detail.result；
 *     查找命令的 value 为 { query, backwards, reset, restore }，回包 { total, current, pending? }，计数文案统一由 findCountLabel 给出；
 *   - 编辑页另经编辑器冒泡到 window 的 mf-md-find 事件边改边更新计数。
 * 查找框的开关状态存于 store（libraryFindOpen / readerFindOpen），与「搜索面板」「仅显示收藏」同一套做法：
 * 顶部状态栏的「查找」按钮与 ⌘F / Esc 只翻转该字段，查找本身的全部状态与逻辑（查询串、计数、重发、编辑页实时计数）都在本组件内。
 * 顶部状态栏另经 mf-doc-command 下发一个命令名 find-step（⌘G / ⇧⌘G）：查找框未开时先开，已开则跳到下 / 上一处——
 * 「跳到下一处」不是状态而是动作，无法用 store 字段表达，故走命令通道。
 * 查找框开着时换视图或换文件，自动按当前查询串重查：编辑页只重现高亮与计数、不动选区与滚动；帧内视图同按 Enter，帧未装载完（pending）时限次重发。
 */
import { store } from '../store.js';
import { icon } from '../icons.js';
import { platform } from '../api.js';
import { escapeHtml, escapeAttr } from '../dom.js';
import { findCountLabel } from '../doc-tools.mjs';

// 两个路由各自的状态字段名；库与阅读页各自独立，互不影响。
const ROUTE_FIELDS = Object.freeze({
    library: { doc: 'libraryDoc', find: 'libraryFindOpen' },
    reader: { doc: 'readerDoc', find: 'readerFindOpen' },
});
const IS_MAC = platform === 'darwin';
const FIND_NEXT_KEYS = IS_MAC ? '⌘G' : 'Ctrl+G';
const FIND_PREV_KEYS = IS_MAC ? '⇧⌘G' : 'Ctrl+Shift+G';
// 查找目标还没装载完（帧内视图的帧未装载完，回包 pending）时的重发间隔与次数上限：每 50 ms 一次、最多 200 次（约 10 s），届时仍未装载完则计数留空
const FIND_RETRY_MS = 50;
const FIND_RETRY_LIMIT = 200;

const findButton = (action, iconName, label) => `<button class="icon-btn icon-btn-sm" type="button" data-action="${action}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}">${icon(iconName)}</button>`;

class MfDocBar extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.route = ROUTE_FIELDS[this.dataset.route] ? this.dataset.route : 'library';
        this.fields = ROUTE_FIELDS[this.route];
        this.doc = null;
        this.docKey = '';
        // 查找框当前是否已渲染出来；只是 store 开关字段的渲染缓存，开关本身不在这里判定
        this.findShown = false;
        // 查找目标未装载完时的重发计时器；新的查找、换视图或换文件、关闭查找时作废
        this.findRetryTimer = null;
        this.titleHtml = '';
        this.viewsHtml = '';
        this.innerHTML = `
            <div class="doc-bar-title" data-role="doc-title"></div>
            <span class="pane-tabs doc-bar-views" data-role="doc-views" role="tablist" aria-label="文件视图" hidden></span>
            <div class="doc-bar-find" data-role="find" role="search" hidden>
                <input class="input input-slim doc-bar-find-input" type="search" data-role="find-input" placeholder="在文档中查找" aria-label="在文档中查找" spellcheck="false">
                <span class="doc-bar-find-count" data-role="find-count" aria-live="polite"></span>
                ${findButton('find-prev', 'chevronUp', `上一个（⇧Enter 或 ${FIND_PREV_KEYS}）`)}
                ${findButton('find-next', 'chevronDown', `下一个（Enter 或 ${FIND_NEXT_KEYS}）`)}
                ${findButton('find-close', 'x', '关闭查找（Esc）')}
            </div>`;
        const input = this.querySelector('[data-role="find-input"]');
        input.addEventListener('input', (event) => { if (!event.isComposing) this.runFind({ reset: true }); });
        input.addEventListener('compositionend', () => this.runFind({ reset: true }));
        input.addEventListener('keydown', (event) => this.onFindKey(event));
        this.addEventListener('click', (event) => this.onClick(event));
        // 顶部状态栏下发的 find-step（⌘G / ⇧⌘G）；只认本路由的那份，另一页的实例不响应
        this.onDocCommandEvent = (event) => {
            const detail = event.detail;
            if (!detail || detail.route !== this.route || detail.command !== 'find-step') return;
            this.step(Boolean(detail.value && detail.value.backwards));
        };
        // 编辑页实时计数：编辑器重建查找高亮或换当前命中后派发 mf-md-find，冒泡到 window
        this.onEditorFindEvent = (event) => this.onEditorFind(event.detail);
        window.addEventListener('mf-doc-command', this.onDocCommandEvent);
        window.addEventListener('mf-md-find', this.onEditorFindEvent);
        this.unsubscribe = store.subscribe((state) => this.sync(state));
        this.sync(store.get());
    }

    disconnectedCallback() {
        if (this.unsubscribe) this.unsubscribe();
        window.removeEventListener('mf-doc-command', this.onDocCommandEvent);
        window.removeEventListener('mf-md-find', this.onEditorFindEvent);
        this.stopFindRetry();
    }

    /** 向本路由的页面下发文档命令；页面同步写入的 detail.result 作为回包 */
    command(name, value) {
        const detail = { route: this.route, command: name, value };
        window.dispatchEvent(new CustomEvent('mf-doc-command', { detail }));
        return detail.result;
    }

    /** 翻转 store 里本路由的查找开关；真正的开合在 syncFind 里跟随该字段完成 */
    setFindOpen(open) {
        if (Boolean(store.get()[this.fields.find]) !== open) store.set({ [this.fields.find]: open });
    }

    onClick(event) {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        const view = target.closest('[data-doc-view]');
        if (view) {
            this.command('view', view.dataset.docView);
            return;
        }
        const button = target.closest('button[data-action]');
        if (!button) return;
        switch (button.dataset.action) {
            case 'find-prev': this.runFind({ backwards: true }); break;
            case 'find-next': this.runFind({}); break;
            case 'find-close': this.setFindOpen(false); break;
            default: break;
        }
    }

    /**
     * 无打开文件时整条隐藏；换文件或换视图时清空查找计数并作废尚在等待的重发，
     * 查找框仍开着且新视图可查找时按当前查询串自动重查（refind），不可查找时静默收起。
     */
    sync(state) {
        const doc = state[this.fields.doc] || null;
        const hasDoc = Boolean(doc);
        this.hidden = !hasDoc;
        const key = hasDoc ? `${doc.sessionId}|${doc.activeView}` : '';
        const switched = key !== this.docKey;
        if (switched) {
            this.docKey = key;
            this.setFindCount('');
            this.stopFindRetry();
        }
        this.doc = doc;
        if (hasDoc) {
            this.renderTitle(doc);
            this.renderViews(doc);
        }
        this.syncFind(state, switched);
    }

    /**
     * 查找框只跟随 store 的开关字段开合。换到不支持查找的视图或文件关闭时把字段复位，
     * 并且不再通知页面（页面已经换掉或拆掉了那个视图，再发 find-close 无处可去）。
     */
    syncFind(state, switched) {
        const canFind = Boolean(this.doc && this.doc.canFind);
        if (!canFind) {
            if (this.findShown) this.applyFindOpen(false, { silent: true });
            this.setFindOpen(false);
            return;
        }
        const open = Boolean(state[this.fields.find]);
        if (open !== this.findShown) this.applyFindOpen(open);
        else if (open && switched) this.refind();
    }

    /** silent：换到不支持查找的视图或文件关闭时只收起查找框，不再通知页面 */
    applyFindOpen(open, { silent = false } = {}) {
        this.findShown = open;
        this.querySelector('[data-role="find"]').hidden = !open;
        if (!open) {
            this.stopFindRetry();
            this.setFindCount('');
            if (!silent) this.command('find-close');
            return;
        }
        const input = this.querySelector('[data-role="find-input"]');
        // 另一页在后台改了文档状态也会走到这里，只有本页是当前路由时才抢焦点
        if (store.get().route === this.route) {
            input.focus();
            input.select();
        }
        if (input.value) this.runFind({ reset: true });
    }

    /** ⌘G / ⇧⌘G：查找框未开时先开（开的那一刻自动按已有查询串查一次），已开则跳到下 / 上一处 */
    step(backwards) {
        if (!this.doc || !this.doc.canFind) return;
        if (this.findShown) this.runFind({ backwards });
        else this.setFindOpen(true);
    }

    renderTitle(doc) {
        const save = doc.saveState && doc.saveState.label
            ? `<span class="md-editor-status doc-bar-save" data-state="${escapeAttr(doc.saveState.state)}" title="${escapeAttr(doc.saveState.message || doc.saveState.label)}">${escapeHtml(doc.saveState.label)}</span>`
            : '';
        const folder = doc.folderName ? `<span class="doc-bar-folder" title="${escapeAttr(doc.folder)}">${escapeHtml(doc.folderName)}</span>` : '';
        const html = `<span class="doc-bar-name" title="${escapeAttr(doc.path || doc.title)}">${escapeHtml(doc.title)}</span>${save}${folder}`;
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

    // ---------- 查找 ----------

    /**
     * 下发查找并按回包显示计数。restore 为换视图或换文件后的自动重查：编辑页不动选区与滚动，帧内视图同 reset。
     * 回包 pending（帧还没装载完）时计数留空，每 FIND_RETRY_MS 重发一次、最多 FIND_RETRY_LIMIT 次；
     * 每次下发都先作废尚在等待的重发，快速连续的查找或切换只有最后一次生效。
     */
    runFind({ backwards = false, reset = false, restore = false } = {}, attempt = 0) {
        this.stopFindRetry();
        if (!this.findShown) return;
        const query = this.querySelector('[data-role="find-input"]').value;
        // 查询串清空时同样下发：编辑页据此撤掉高亮，帧内视图对空串不做处理
        const result = this.command('find', { query, backwards, reset, restore });
        if (query && result && result.pending && attempt < FIND_RETRY_LIMIT) {
            this.findRetryTimer = setTimeout(() => this.runFind({ backwards, reset, restore }, attempt + 1), FIND_RETRY_MS);
        }
        this.showFindCount(query, result);
    }

    /** 换视图或换文件后的重查：延到本轮同步渲染之后下发（页面已挂好新视图、store 通知已走完）；查询串为空时不重查 */
    refind() {
        this.stopFindRetry();
        if (!this.querySelector('[data-role="find-input"]').value) return;
        this.findRetryTimer = setTimeout(() => this.runFind({ reset: true, restore: true }), 0);
    }

    stopFindRetry() {
        clearTimeout(this.findRetryTimer);
        this.findRetryTimer = null;
    }

    /**
     * 编辑页实时计数（mf-md-find）：只认查找框开着、当前文档可查找、事件出自当前文档（同会话）的编辑器、
     * 且查询串与查找框一致的那次，对比预览等其他编辑器或已失效的查找不改写计数。事件的 current 为 0 起下标（无为 -1）。
     */
    onEditorFind(detail) {
        if (!detail || !this.findShown || !this.doc || !this.doc.canFind) return;
        if (String(detail.sessionId || '') !== String(this.doc.sessionId || '')) return;
        const query = this.querySelector('[data-role="find-input"]').value;
        if (!query || detail.query !== query) return;
        this.showFindCount(query, { total: detail.total, current: Number(detail.current) + 1 });
    }

    showFindCount(query, result) {
        const { text, empty } = findCountLabel(query, result);
        this.setFindCount(text, empty);
    }

    setFindCount(text, empty = false) {
        const count = this.querySelector('[data-role="find-count"]');
        count.textContent = text;
        count.toggleAttribute('data-empty', empty);
    }

    /** 查找框内的 Enter / ⇧Enter 与 Esc；Esc 就地拦下不再上冒，顶部状态栏的全局 Esc 不重复处理 */
    onFindKey(event) {
        if (event.isComposing) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            this.runFind({ backwards: event.shiftKey });
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.setFindOpen(false);
        }
    }
}

customElements.define('mf-doc-bar', MfDocBar);
