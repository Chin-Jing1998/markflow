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
import './mf-source-pane.js';
import './mf-product-pane.js';
import './mf-format-panel.js';

const URL_RE = /^https?:\/\//i;
const REPARSE_HINT = '正在重新解析源文件…';

class MfCompareView extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.pending = null;
        this.scrollSync = null;
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
                <div class="footer-actions"></div>
            </footer>`;
        this.addEventListener('click', (event) => this.onClick(event));
        this.addEventListener('change', (event) => {
            if (event.target instanceof Element && event.target.matches('[data-action="target"]')) this.setTarget(event.target.value);
        });
        this.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && event.target instanceof Element && event.target.matches('[data-role="url"]')) this.openUrl();
        });
        this.addEventListener('mf-options-change', (event) => this.onOptions(event.detail));
        this.unsubscribe = store.subscribe((state) => this.sync(state));
        this.sync(store.get());
    }

    disconnectedCallback() {
        if (this.unsubscribe) this.unsubscribe();
        this.unbindScrollSync();
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
            this.querySelector('.preview-name').textContent = '';
            this.querySelector('[data-role="status"]').textContent = '';
            return;
        }

        this.querySelector('.preview-name').innerHTML = `<span class="chip">${escapeHtml(typeLabel(preview.type))}</span><span class="preview-title" title="${escapeAttr(preview.source.value)}">${escapeHtml(preview.title || preview.name)}</span>`;
        this.syncTargets(state, preview);
        this.querySelector('[data-action="refresh"]').hidden = preview.live && !this.pending;
        this.querySelector('mf-source-pane').view = preview.sourceView;
        this.querySelector('mf-product-pane').product = preview.product;
        this.bindScrollSync();
        this.querySelector('mf-format-panel').context = {
            formats: state.formats, target: preview.target, type: preview.type,
            options: this.pending || preview.options, busy,
        };
        const warnings = preview.product && Array.isArray(preview.product.warnings) ? preview.product.warnings.length : 0;
        const bits = [`目标 ${targetLabel(preview.target)}`, preview.live ? '改动实时生效' : '改动后点「刷新预览」'];
        if (warnings > 0) bits.push(`转换提示 ${warnings} 条`);
        if (this.pending) bits.push('有未应用的改动');
        this.querySelector('[data-role="status"]').textContent = bits.join(' · ');
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
            refresh: () => this.rerender(this.pending || null, { force: true }),
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
        this.open({ url }).then(() => { input.value = ''; }).catch(() => undefined);
    }

    /** 打开新会话前先关掉旧会话，避免临时目录与 mf-asset 授权堆积 */
    async open(payload) {
        const previous = store.get().preview;
        store.set({ previewBusy: true, previewError: '' });
        this.setBusyText('正在解析并生成预览…');
        this.pending = null;
        try {
            const opened = await api.previewOpen(payload);
            store.set({ preview: opened, previewBusy: false });
            if (previous) api.previewClose(previous.sessionId).catch(() => undefined);
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

    async rerender(options, { reparse = false, force = false, target = null } = {}) {
        const preview = store.get().preview;
        if (!preview) return;
        if (!force && !options) return;
        store.set({ previewBusy: true, previewError: '' });
        this.setBusyText(reparse ? REPARSE_HINT : '正在重新渲染…');
        try {
            const next = await api.previewRender({
                sessionId: preview.sessionId,
                ...(target ? { target } : {}),
                ...(options ? { options } : {}),
            });
            this.pending = null;
            store.set((state) => ({
                previewBusy: false,
                preview: state.preview ? { ...state.preview, ...next, sourceView: next.sourceView || state.preview.sourceView, live: next.product.live } : state.preview,
            }));
            if (next.reparsed) notify(`已按「${next.changedKeys.join('、')}」重新解析源文件`, 'info');
        } catch (err) {
            store.set({ previewBusy: false, previewError: err.message });
            notify(err.message, 'error', 6000);
        }
    }

    async exportProduct() {
        const preview = store.get().preview;
        if (!preview) return;
        store.set({ previewBusy: true });
        this.setBusyText('正在导出…');
        try {
            const result = await api.previewExport({ sessionId: preview.sessionId });
            store.set((state) => ({ previewBusy: false, libraryVersion: state.libraryVersion + 1 }));
            notify(`已导出到 ${result.outputPath}${result.libraryId ? '，并写入文件库' : ''}`, 'success', 6000);
        } catch (err) {
            store.set({ previewBusy: false });
            notify(`导出失败：${err.message}`, 'error', 6000);
        }
    }

    async close() {
        const preview = store.get().preview;
        store.set({ preview: null, previewError: '' });
        this.pending = null;
        if (preview) await api.previewClose(preview.sessionId).catch(() => undefined);
    }

    setBusyText(text) {
        this.querySelector('[data-role="busy-text"]').textContent = text;
    }

    bindScrollSync() {
        const sourceFrame = this.querySelector('.pane-source .view-frame');
        const productFrame = this.querySelector('.pane-product .view-frame');
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
