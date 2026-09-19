/**
 * <mf-compare-view>：预览页 = 双栏对比（来源 | 产物）+ 格式面板（方案 §3.4.7）
 *
 * 打开方式：选择本地文件，或粘贴一条 http(s) 网址（网页来源的目标限 bundle / html / xml）。
 * 会话在主进程侧：open 解析一次并缓存，改选项只走 render；html / xml / bundle 目标随格式面板
 * 300 ms 防抖实时重渲染，docx / pdf 目标改完选项点「刷新预览」再出图；
 * 命中「需重新解析」的选项时主进程会在同一会话内重新解析，界面显示「正在重新解析…」。
 * 导出交 mf:preview:export 落盘并写入文件库，随后可在文件库页定位或用系统程序打开。
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { classOf, escapeHtml, escapeAttr, targetLabel, typeLabel } from '../dom.js';
import { notify } from './mf-toast.js';
import { describeKeys } from '../format-options.mjs';
import './mf-source-pane.js';
import './mf-product-pane.js';
import './mf-format-panel.js';

const URL_RE = /^https?:\/\//i;
const REPARSE_HINT = '正在重新解析源文件…';
const CONTENT_LIST_SUFFIX = '_content_list.json';
const SIDEBAR_WIDTH = Object.freeze({ min: 220, max: 360, default: 248 });

class MfCompareView extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.pending = null;
        this.scrollSync = null;
        this.resizeState = null;
        this.innerHTML = `
            <header class="page-header">
                <h1>预览</h1>
                <div class="page-header-actions">
                    <span class="preview-name"></span>
                    <label class="field-inline" hidden data-role="target-field"><span>目标</span>
                        <select class="select select-slim" data-action="target" aria-label="目标格式"></select>
                    </label>
                    <button class="btn btn-secondary btn-small" type="button" data-action="refresh" hidden>${icon('refresh')}刷新预览</button>
                    <button class="btn btn-primary btn-small" type="button" data-action="export" hidden>${icon('check')}导出</button>
                    <button class="icon-btn icon-btn-sm" type="button" data-action="close" title="关闭预览" hidden>${icon('x')}</button>
                </div>
            </header>
            <div class="page-body page-layout compare-body">
                <aside class="page-sidebar compare-sidebar" aria-label="预览设置">
                    <div class="page-sidebar-heading">预览设置</div>
                    <p class="page-sidebar-note" data-role="sidebar-note">打开来源文件后，可在此调整导出格式。</p>
                    <mf-format-panel class="panel" data-role="format-panel" hidden></mf-format-panel>
                </aside>
                <div class="sidebar-resize-handle" data-role="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="调整预览设置侧栏宽度" aria-valuemin="${SIDEBAR_WIDTH.min}" aria-valuemax="${SIDEBAR_WIDTH.max}" aria-valuenow="${SIDEBAR_WIDTH.default}" tabindex="0"></div>
                <section class="compare-main">
                    <section class="compare-empty" data-role="empty">
                        <div class="dropzone-icon">${icon('preview')}</div>
                        <h3>对比预览</h3>
                        <p>左侧为格式设置，中间是来源文档，右侧是将要导出的产物；改动格式选项即可实时看到效果。</p>
                        <div class="dropzone-actions">
                            <button class="btn btn-primary" type="button" data-action="pick">${icon('file')}选择文件…</button>
                        </div>
                        <div class="field-row compare-url">
                            <input class="input" type="url" data-role="url" placeholder="或粘贴一条网页链接（http / https）" spellcheck="false">
                            <button class="btn btn-secondary" type="button" data-action="open-url">${icon('link')}预览网页</button>
                        </div>
                        <p class="compare-error" data-role="error" hidden></p>
                    </section>
                    <div class="compare-grid" data-role="grid" hidden>
                        <mf-source-pane class="pane pane-source"></mf-source-pane>
                        <mf-product-pane class="pane pane-product"></mf-product-pane>
                    </div>
                    <div class="compare-busy" data-role="busy" hidden><span class="spinner">${icon('spinner')}</span><span data-role="busy-text">正在准备预览…</span></div>
                </section>
            </div>
            <footer class="page-footer">
                <div class="footer-summary" data-role="status"></div>
            </footer>`;
        this.addEventListener('click', (event) => this.onClick(event));
        this.addEventListener('change', (event) => {
            if (event.target instanceof Element && event.target.matches('[data-action="target"]')) this.setTarget(event.target.value);
        });
        this.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && event.target instanceof Element && event.target.matches('[data-role="url"]')) this.openUrl();
        });
        this.addEventListener('mf-options-change', (event) => this.onOptions(event.detail));
        // 产物 Markdown 编辑器：保存状态显示在标题旁；未导出时 ⌘S 等同「导出」
        this.mdStatus = null;
        this.boundPath = null;
        this.addEventListener('mf-md-status', (event) => this.onMdStatus(event.detail));
        this.addEventListener('mf-md-save', (event) => this.onMdSave(event));
        this.bindSidebarResizer();
        this.unsubscribe = store.subscribe((state) => this.sync(state));
        this.sync(store.get());
    }

    disconnectedCallback() {
        if (this.unsubscribe) this.unsubscribe();
        this.unbindScrollSync();
        this.endSidebarResize();
    }

    bindSidebarResizer() {
        const handle = this.querySelector('[data-role="sidebar-resizer"]');
        if (!handle) return;
        handle.addEventListener('pointerdown', (event) => {
            const sidebar = this.querySelector('.compare-sidebar');
            if (!sidebar) return;
            event.preventDefault();
            this.resizeState = { pointerId: event.pointerId, startX: event.clientX, startWidth: sidebar.getBoundingClientRect().width };
            handle.setPointerCapture(event.pointerId);
            this.querySelector('.compare-body').classList.add('is-resizing');
            document.body.classList.add('is-resizing-sidebar');
        });
        handle.addEventListener('pointermove', (event) => {
            if (!this.resizeState || event.pointerId !== this.resizeState.pointerId) return;
            const width = Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, this.resizeState.startWidth + event.clientX - this.resizeState.startX));
            const body = this.querySelector('.compare-body');
            body.style.setProperty('--compare-sidebar-width', `${Math.round(width)}px`);
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
            const body = this.querySelector('.compare-body');
            const handleWidth = Number(handle.getAttribute('aria-valuenow')) || SIDEBAR_WIDTH.default;
            const delta = event.key === 'ArrowLeft' ? -16 : 16;
            const width = Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, handleWidth + delta));
            body.style.setProperty('--compare-sidebar-width', `${width}px`);
            handle.setAttribute('aria-valuenow', String(width));
        });
    }

    endSidebarResize() {
        if (!this.resizeState) return;
        this.resizeState = null;
        const body = this.querySelector('.compare-body');
        if (body) body.classList.remove('is-resizing');
        document.body.classList.remove('is-resizing-sidebar');
    }

    refresh() {
        const state = store.get();
        if (!state.formats) api.describeFormats().then((formats) => store.set({ formats })).catch(() => undefined);
    }

    // ---------- 状态 ----------

    sync(state) {
        const preview = state.preview;
        const busy = state.previewBusy;
        this.querySelector('[data-role="grid"]').hidden = !preview;
        this.querySelector('[data-role="empty"]').hidden = Boolean(preview);
        this.querySelector('[data-role="busy"]').hidden = !busy;
        this.querySelector('[data-role="sidebar-note"]').hidden = Boolean(preview);
        this.querySelector('[data-role="format-panel"]').hidden = !preview;
        const error = this.querySelector('[data-role="error"]');
        error.hidden = !state.previewError || Boolean(preview);
        error.textContent = state.previewError || '';

        for (const action of ['refresh', 'export', 'close']) {
            const button = this.querySelector(`[data-action="${action}"]`);
            button.hidden = !preview;
            button.disabled = busy;
        }
        this.querySelector('[data-role="target-field"]').hidden = !preview;
        if (!preview) {
            this.unbindScrollSync();
            this.querySelector('mf-product-pane').sessionId = null;
            this.mdStatus = null;
            this.boundPath = null;
            this.querySelector('.preview-name').textContent = '';
            const status = this.querySelector('[data-role="status"]');
            status.textContent = '';
            status.removeAttribute('title');
            return;
        }

        this.querySelector('.preview-name').innerHTML = `<span class="chip">${escapeHtml(typeLabel(preview.type))}</span><span class="preview-title" title="${escapeAttr(preview.source.value)}">${escapeHtml(preview.title || preview.name)}</span>${this.mdStatusHtml()}`;
        this.syncTargets(state, preview);
        this.querySelector('[data-action="refresh"]').hidden = preview.live && !this.pending;
        // 仅在引用变化时赋值：任何 store 变化都会走到这里，重复赋值会让两栏 iframe 全量重建
        const sourcePane = this.querySelector('mf-source-pane');
        const productPane = this.querySelector('mf-product-pane');
        if (sourcePane.view !== preview.sourceView) sourcePane.view = preview.sourceView;
        productPane.sessionId = preview.sessionId;
        if (productPane.product !== preview.product) productPane.product = preview.product;
        this.bindScrollSync();
        this.querySelector('mf-format-panel').context = {
            formats: state.formats, sessionId: preview.sessionId, target: preview.target, type: preview.type,
            options: this.pending || preview.options, busy,
        };
        const files = preview.product && Array.isArray(preview.product.files) ? preview.product.files : [];
        const warnings = preview.product && Array.isArray(preview.product.warnings) ? preview.product.warnings.length : 0;
        const bits = [`目标 ${targetLabel(preview.target)}`, preview.live ? '改动实时生效' : '改动后点「刷新预览」'];
        if (files.length > 0) {
            const title = preview.title || preview.name || '';
            // bundle 目标另写 {name}_content_list.json，只列扩展名会与 {name}.json 重名，故该文件保留完整后缀
            const types = files.map((name) => {
                const file = String(name);
                return file.endsWith(CONTENT_LIST_SUFFIX) ? CONTENT_LIST_SUFFIX.slice(1) : (file.split('.').pop() || file);
            }).join('、');
            bits.push(`导出后得到：${title}（${types}）`);
        }
        if (warnings > 0) bits.push(`转换提示 ${warnings} 条`);
        if (this.pending) bits.push('有未应用的改动');
        const status = this.querySelector('[data-role="status"]');
        status.textContent = bits.join(' · ');
        status.title = status.textContent;
    }

    syncTargets(state, preview) {
        const select = this.querySelector('[data-action="target"]');
        const targets = state.formats && state.formats.targets ? state.formats.targets : null;
        const cls = classOf(preview.type);
        const allowed = targets && cls && Array.isArray(targets[cls]) ? targets[cls] : [preview.target];
        const signature = allowed.join(',');
        if (select.dataset.signature !== signature) {
            select.dataset.signature = signature;
            select.innerHTML = allowed.map((target) => `<option value="${escapeAttr(target)}">${escapeHtml(targetLabel(target))}</option>`).join('');
        }
        select.value = preview.target;
    }

    // ---------- 动作 ----------

    onClick(event) {
        const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
        if (!button) return;
        const actions = {
            pick: () => this.pickFile(),
            'open-url': () => this.openUrl(),
            refresh: () => this.rerender(this.pending || this.effectiveOptions(), { force: true }),
            export: () => this.exportProduct(),
            close: () => this.close(),
        };
        const run = actions[button.dataset.action];
        if (run) run();
    }

    async pickFile() {
        try {
            const picked = await api.pickFiles();
            if (picked.canceled || picked.paths.length === 0) return;
            await this.open({ path: picked.paths[0] });
        } catch (err) {
            notify(err.message, 'error');
        }
    }

    openUrl() {
        const input = this.querySelector('[data-role="url"]');
        const url = input.value.trim();
        if (!URL_RE.test(url)) {
            notify('请输入以 http:// 或 https:// 开头的网址', 'warning');
            return;
        }
        this.open({ url }).then((opened) => { if (opened !== false) input.value = ''; }).catch(() => undefined);
    }

    /** 打开新会话前先关掉旧会话，避免临时目录与 mf-asset 授权堆积；产物有未导出的修改时先征得确认（取消回 false） */
    async open(payload) {
        if (!(await this.guardProductEdits('产物 Markdown 的修改尚未导出，打开新文件会丢弃这些修改。是否继续？'))) return false;
        const previous = store.get().preview;
        store.set({ previewBusy: true, previewError: '' });
        this.setBusyText('正在解析并生成预览…');
        this.pending = null;
        try {
            const opened = await api.previewOpen(payload);
            this.boundPath = null;
            this.mdStatus = null;
            store.set({ preview: opened, previewBusy: false });
            if (previous) api.previewClose(previous.sessionId).catch(() => undefined);
            return true;
        } catch (err) {
            store.set({ previewBusy: false, previewError: err.message, preview: null });
            notify(err.message, 'error', 6000);
            throw err;
        }
    }

    onOptions({ options, reparse }) {
        const preview = store.get().preview;
        if (!preview) return;
        if (!preview.live) {
            this.pending = options;
            this.sync(store.get());
            return;
        }
        this.rerender(options, { reparse });
    }

    setTarget(target) {
        const preview = store.get().preview;
        if (!preview || preview.target === target) return;
        this.rerender(this.pending || preview.options, { force: true, target });
    }

    /**
     * 当前生效的扁平选项。「刷新预览」必须带上它：主进程每次 render 都按 { ...设置默认项, ...本次入参 }
     * 重算会话选项，不带就等于把用户在面板上设过的项全部撤回（实时目标下 pending 为空，尤其容易踩到）。
     */
    effectiveOptions() {
        const preview = store.get().preview;
        return preview && preview.options ? preview.options : null;
    }

    async rerender(options, { reparse = false, force = false, target = null } = {}) {
        const preview = store.get().preview;
        if (!preview) return;
        if (!force && !options) return;
        // 重渲染会丢弃产物 Markdown 的编辑：有修改或已绑定导出文件时先确认，取消则让格式面板与目标下拉复位
        if (!(await this.confirmRerender())) {
            this.revertControls();
            return;
        }
        store.set({ previewBusy: true, previewError: '' });
        this.setBusyText(reparse ? REPARSE_HINT : '正在重新渲染…');
        try {
            const next = await api.previewRender({
                sessionId: preview.sessionId,
                ...(target ? { target } : {}),
                ...(options ? { options } : {}),
            });
            this.pending = null;
            const { editDiscarded, ...update } = next;
            if (editDiscarded) {
                this.boundPath = null;
                this.mdStatus = null;
            }
            store.set((state) => ({
                previewBusy: false,
                preview: state.preview ? { ...state.preview, ...update, sourceView: update.sourceView || state.preview.sourceView, live: update.product.live } : state.preview,
            }));
            // 提示里给字段的中文标签而不是扁平键名（describeKeys 取不到标签的键回退为键名）
            if (next.reparsed) notify(`已按「${describeKeys(next.changedKeys)}」重新解析源文件`, 'info');
        } catch (err) {
            store.set({ previewBusy: false, previewError: err.message });
            notify(err.message, 'error', 6000);
        }
    }

    /** 导出前先把编辑器文本暂存（已绑定时写盘）；导出回包带 boundPath 即绑定成功，编辑器转「已保存」 */
    async exportProduct() {
        const preview = store.get().preview;
        if (!preview) return;
        const editor = this.productEditor();
        if (editor && !(await editor.flush())) {
            notify('产物 Markdown 的修改未能暂存或保存，已取消导出', 'error', 6000);
            return;
        }
        store.set({ previewBusy: true });
        this.setBusyText('正在导出…');
        try {
            const result = await api.previewExport({ sessionId: preview.sessionId });
            if (result.boundPath) {
                this.boundPath = result.boundPath;
                if (editor) editor.markExported();
            }
            store.set((state) => ({ previewBusy: false, libraryVersion: state.libraryVersion + 1 }));
            notify(`已导出到 ${result.outputPath}${result.libraryId ? '，并写入文件库' : ''}`, 'success', 6000);
            for (const warning of (result.warnings || []).filter((item) => /旁路 JSON|未能定位导出/.test(String(item)))) notify(warning, 'warning', 6000);
        } catch (err) {
            store.set({ previewBusy: false });
            notify(`导出失败：${err.message}`, 'error', 6000);
        }
    }

    async close() {
        if (!(await this.guardProductEdits('产物 Markdown 的修改尚未导出，关闭预览会丢弃这些修改。是否继续？'))) return;
        const preview = store.get().preview;
        store.set({ preview: null, previewError: '' });
        this.pending = null;
        if (preview) await api.previewClose(preview.sessionId).catch(() => undefined);
    }

    // ---------- 产物 Markdown 编辑 ----------

    productEditor() {
        const pane = this.querySelector('mf-product-pane');
        return pane && pane.editor ? pane.editor : null;
    }

    /** 打开新文件 / 关闭预览前：已绑定则先把修改写进导出文件；未导出的修改须用户确认才丢弃 */
    async guardProductEdits(message) {
        const editor = this.productEditor();
        if (!editor) return true;
        if (this.boundPath) {
            if (await editor.flush()) return true;
            return window.confirm('产物 Markdown 的最新修改未能保存到导出文件，仍要继续并放弃这些修改？');
        }
        return !editor.modified || window.confirm(message);
    }

    /** 改格式选项 / 目标：有修改或已绑定时先确认；已绑定的先把挂起的修改写盘 */
    async confirmRerender() {
        const editor = this.productEditor();
        if (!editor) return true;
        if (this.boundPath) {
            const saved = await editor.flush();
            return window.confirm(saved
                ? '产物将按新的选项重新生成，编辑器会载入新产物，之后的修改需再次导出；已导出的文件不受影响。是否继续？'
                : '产物 Markdown 的最新修改未能保存到导出文件，重新生成产物会丢弃这些修改。是否继续？');
        }
        if (!editor.modified) return true;
        return window.confirm('产物 Markdown 的修改尚未导出，改动格式选项或目标会重新生成产物并丢弃这些修改。是否继续？');
    }

    /** 取消重渲染：格式面板与目标下拉回到会话当前的选项（正在操作的控件先失焦，否则面板不会覆盖它的值） */
    revertControls() {
        const active = document.activeElement;
        if (active instanceof HTMLElement && this.contains(active)) active.blur();
        this.sync(store.get());
    }

    onMdStatus(detail) {
        this.mdStatus = detail && detail.label ? { ...detail } : null;
        const name = this.querySelector('.preview-name');
        const existing = name.querySelector('[data-role="md-status"]');
        if (existing) existing.remove();
        if (store.get().preview && this.mdStatus) name.insertAdjacentHTML('beforeend', this.mdStatusHtml());
    }

    mdStatusHtml() {
        const status = this.mdStatus;
        if (!status || !status.label) return '';
        return `<span class="md-editor-status" data-role="md-status" data-state="${escapeAttr(status.state)}" title="${escapeAttr(status.message || status.label)}">${escapeHtml(status.label)}</span>`;
    }

    /** 未导出时 ⌘S 等同「导出」（导出前会先暂存编辑器文本）；已绑定时照常保存到导出文件 */
    onMdSave(event) {
        const detail = event.detail || {};
        if (detail.reason !== 'shortcut' || this.boundPath) return;
        event.preventDefault();
        if (!store.get().previewBusy) this.exportProduct();
    }

    setBusyText(text) {
        this.querySelector('[data-role="busy-text"]').textContent = text;
    }

    bindScrollSync() {
        // 只认两栏主视图的帧，排除产物编辑器里的实时预览帧
        const sourceFrame = this.querySelector('.pane-source .pane-frame-host > .view-frame');
        const productFrame = this.querySelector('.pane-product .pane-frame-host > .view-frame');
        if (this.scrollSync && this.scrollSync.sourceFrame === sourceFrame && this.scrollSync.productFrame === productFrame) return;
        this.unbindScrollSync();
        if (!sourceFrame || !productFrame) return;

        const refresh = () => this.attachScrollers(sourceFrame, productFrame);
        sourceFrame.addEventListener('load', refresh);
        productFrame.addEventListener('load', refresh);
        this.scrollSync = { sourceFrame, productFrame, refresh, source: null, product: null, locked: false };
        refresh();
    }

    attachScrollers(sourceFrame, productFrame) {
        const state = this.scrollSync;
        if (!state || state.sourceFrame !== sourceFrame || state.productFrame !== productFrame) return;
        const source = this.getScrollTarget(sourceFrame);
        const product = this.getScrollTarget(productFrame);
        if (!source || !product || (state.source === source && state.product === product)) return;
        this.removeScrollListeners(state.source, state.onSource);
        this.removeScrollListeners(state.product, state.onProduct);
        state.source = source;
        state.product = product;
        state.onSource = () => this.syncScroll(source, product);
        state.onProduct = () => this.syncScroll(product, source);
        this.addScrollListeners(source, state.onSource);
        this.addScrollListeners(product, state.onProduct);
    }

    getScrollTarget(frame) {
        const document = frame.contentDocument;
        const window = frame.contentWindow;
        if (!document || !window) return null;
        return { frame, document, window };
    }

    addScrollListeners(target, handler) {
        if (!target) return;
        target.window.addEventListener('scroll', handler, { passive: true });
        target.document.addEventListener('scroll', handler, { passive: true });
        target.document.documentElement?.addEventListener('scroll', handler, { passive: true });
        target.document.body?.addEventListener('scroll', handler, { passive: true });
    }

    removeScrollListeners(target, handler) {
        if (!target || !handler) return;
        target.window.removeEventListener('scroll', handler);
        target.document.removeEventListener('scroll', handler);
        target.document.documentElement?.removeEventListener('scroll', handler);
        target.document.body?.removeEventListener('scroll', handler);
    }

    readScrollTop(target) {
        const { document, window } = target;
        return Math.max(
            Number(window.scrollY) || 0,
            Number(document.documentElement?.scrollTop) || 0,
            Number(document.body?.scrollTop) || 0,
        );
    }

    readScrollMax(target) {
        const { document, frame } = target;
        const scrollHeight = Math.max(
            Number(document.documentElement?.scrollHeight) || 0,
            Number(document.body?.scrollHeight) || 0,
        );
        return Math.max(0, scrollHeight - frame.clientHeight);
    }

    writeScrollTop(target, value) {
        const top = Math.max(0, Number(value) || 0);
        target.window.scrollTo(0, top);
        if (target.document.documentElement) target.document.documentElement.scrollTop = top;
        if (target.document.body) target.document.body.scrollTop = top;
    }

    syncScroll(from, to) {
        const state = this.scrollSync;
        if (!state || state.locked) return;
        const fromMax = this.readScrollMax(from);
        const toMax = this.readScrollMax(to);
        const ratio = fromMax > 0 ? this.readScrollTop(from) / fromMax : 0;
        state.locked = true;
        this.writeScrollTop(to, ratio * toMax);
        requestAnimationFrame(() => {
            if (this.scrollSync === state) state.locked = false;
        });
    }

    unbindScrollSync() {
        const state = this.scrollSync;
        if (!state) return;
        state.sourceFrame.removeEventListener('load', state.refresh);
        state.productFrame.removeEventListener('load', state.refresh);
        this.removeScrollListeners(state.source, state.onSource);
        this.removeScrollListeners(state.product, state.onProduct);
        this.scrollSync = null;
    }
}

customElements.define('mf-compare-view', MfCompareView);
