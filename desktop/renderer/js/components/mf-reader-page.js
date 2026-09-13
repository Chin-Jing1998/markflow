/**
 * <mf-reader-page>：阅读页 —— 直接打开 md / html / xml / pdf（方案 §3.4.6）
 *
 * 视图由主进程 mf:reader:open 构建：md 经 parsers/md + reader 主题渲染，html 经 html-sanitize 清洗，
 * xml 给「结构视图 / 原文」两个页签，pdf 交 Chromium 内置阅读器。图片一律走 mf-asset://<sid>/，
 * 远程图与脚本在渲染前就已被拦掉。菜单「打开文件…」选中这四类文件时经 mf:preview:event 推到这里。
 */
import { store } from '../store.js';
import { api, onPreviewEvent } from '../api.js';
import { icon } from '../icons.js';
import { escapeHtml, escapeAttr, formatSize, mountFrame, textDocument } from '../dom.js';
import { notify } from './mf-toast.js';

const KIND_LABELS = Object.freeze({ md: 'Markdown', html: 'HTML', xml: 'XML', pdf: 'PDF' });

class MfReaderPage extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.tab = 'rendered';
        this.innerHTML = `
            <header class="page-header">
                <h1>阅读</h1>
                <div class="page-header-actions">
                    <span class="preview-name"></span>
                    <span class="pane-tabs" role="tablist"></span>
                    <button class="btn btn-secondary btn-small" type="button" data-action="pick">${icon('file')}打开文件…</button>
                    <button class="icon-btn icon-btn-sm" type="button" data-action="close" title="关闭" hidden>${icon('x')}</button>
                </div>
            </header>
            <div class="page-body reader-body">
                <section class="compare-empty" data-role="empty">
                    <div class="dropzone-icon">${icon('reader')}</div>
                    <h3>直接打开阅读</h3>
                    <p>支持 Markdown、HTML、XML 与 PDF：图片按原位显示，脚本与远程资源一律拦截，外链交系统浏览器打开。</p>
                    <div class="dropzone-actions"><button class="btn btn-primary" type="button" data-action="pick">${icon('file')}选择文件…</button></div>
                    <p class="compare-error" data-role="error" hidden></p>
                </section>
                <div class="reader-frame" data-role="frame" hidden></div>
                <div class="compare-busy" data-role="busy" hidden><span class="spinner">${icon('spinner')}</span><span>正在打开…</span></div>
            </div>
            <footer class="page-footer">
                <div class="footer-summary" data-role="status"></div>
                <div class="footer-actions"></div>
            </footer>`;
        this.addEventListener('click', (event) => this.onClick(event));
        this.unsubs = [
            store.subscribe((state) => this.sync(state)),
            onPreviewEvent((payload) => this.onPush(payload)),
        ];
        this.sync(store.get());
    }

    disconnectedCallback() {
        for (const off of this.unsubs || []) off();
    }

    refresh() { /* 阅读页无需拉取数据 */ }

    onPush(payload) {
        if (!payload || payload.type !== 'reader-open' || !payload.path) return;
        if (location.hash !== '#/reader') location.hash = '#/reader';
        if (Array.isArray(payload.pending) && payload.pending.length > 0) {
            notify(`阅读模式一次显示一份文件，其余 ${payload.pending.length} 个已跳过`, 'info');
        }
        this.open(payload.path);
    }

    onClick(event) {
        const tab = event.target instanceof Element ? event.target.closest('[data-tab]') : null;
        if (tab) {
            this.tab = tab.dataset.tab;
            this.sync(store.get());
            return;
        }
        const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
        if (!button) return;
        if (button.dataset.action === 'pick') this.pick();
        else if (button.dataset.action === 'close') this.close();
    }

    async pick() {
        try {
            const picked = await api.pickFiles();
            if (picked.canceled || picked.paths.length === 0) return;
            await this.open(picked.paths[0]);
        } catch (err) {
            notify(err.message, 'error');
        }
    }

    /** 打开新文件前先关旧会话：撤销 mf-asset 授权并删掉临时目录 */
    async open(path) {
        const previous = store.get().reader;
        store.set({ readerBusy: true, readerError: '' });
        this.tab = 'rendered';
        try {
            const opened = await api.readerOpen({ path });
            store.set({ reader: opened, readerBusy: false });
            if (previous) api.previewClose(previous.sessionId).catch(() => undefined);
            for (const warning of opened.warnings || []) notify(warning, 'warning', 6000);
        } catch (err) {
            store.set({ readerBusy: false, readerError: err.message, reader: null });
            notify(err.message, 'error', 6000);
        }
    }

    async close() {
        const reader = store.get().reader;
        store.set({ reader: null, readerError: '' });
        if (reader) await api.previewClose(reader.sessionId).catch(() => undefined);
    }

    tabsFor(view) {
        if (!view) return [];
        if (view.kind === 'xml') return view.structuredHtml ? [['rendered', '结构视图'], ['raw', 'XML 原文']] : [['raw', 'XML 原文']];
        if (view.kind === 'md') return [['rendered', '渲染'], ['raw', 'Markdown 原文']];
        return [];
    }

    sync(state) {
        const reader = state.reader;
        const view = reader && reader.view;
        this.querySelector('[data-role="empty"]').hidden = Boolean(reader);
        this.querySelector('[data-role="frame"]').hidden = !reader;
        this.querySelector('[data-role="busy"]').hidden = !state.readerBusy;
        this.querySelector('[data-action="close"]').hidden = !reader;
        const error = this.querySelector('[data-role="error"]');
        error.hidden = !state.readerError || Boolean(reader);
        error.textContent = state.readerError || '';

        const tabs = this.querySelector('.pane-tabs');
        if (!reader) {
            this.querySelector('.preview-name').textContent = '';
            this.querySelector('[data-role="status"]').textContent = '';
            tabs.replaceChildren();
            this.querySelector('[data-role="frame"]').replaceChildren();
            return;
        }

        this.querySelector('.preview-name').innerHTML =
            `<span class="chip">${escapeHtml(KIND_LABELS[reader.kind] || reader.kind)}</span><span class="preview-title" title="${escapeAttr(reader.path)}">${escapeHtml(reader.name)}</span>`;
        const available = this.tabsFor(view);
        if (!available.some(([key]) => key === this.tab)) this.tab = available.length > 0 ? available[0][0] : 'rendered';
        tabs.innerHTML = available.map(([key, text]) => `<button class="pane-tab${this.tab === key ? ' is-active' : ''}" type="button" role="tab" data-tab="${key}">${escapeHtml(text)}</button>`).join('');

        this.mount(view);
        const bits = [reader.path];
        if (reader.size) bits.push(formatSize(reader.size));
        if (reader.warnings && reader.warnings.length > 0) bits.push(`提示 ${reader.warnings.length} 条`);
        this.querySelector('[data-role="status"]').textContent = bits.join(' · ');
    }

    mount(view) {
        const host = this.querySelector('[data-role="frame"]');
        if (!view) {
            host.replaceChildren();
            return;
        }
        if (view.kind === 'pdf') mountFrame(host, { src: view.url, title: 'PDF 阅读器' });
        else if (view.kind === 'xml') {
            if (this.tab === 'rendered' && view.structuredHtml) mountFrame(host, { srcdoc: view.structuredHtml, title: 'XML 结构视图' });
            else mountFrame(host, { srcdoc: textDocument(view.xml || '', { title: 'XML 原文' }), title: 'XML 原文' });
        } else if (view.kind === 'md' && this.tab === 'raw') mountFrame(host, { srcdoc: textDocument(view.raw || '', { title: 'Markdown 原文' }), title: 'Markdown 原文' });
        else mountFrame(host, { srcdoc: view.html || '', title: '阅读视图' });
    }
}

customElements.define('mf-reader-page', MfReaderPage);
