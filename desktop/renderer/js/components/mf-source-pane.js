/**
 * <mf-source-pane>：对比预览左栏 —— 来源视图（方案 §3.4.7）
 *
 * 用法：pane.view = 视图对象（主进程 mf:preview:open / render 的 sourceView）。
 *   docx → { kind:'html', html }          mammoth 直转并经 html-sanitize 清洗的版式还原
 *   xlsx / pptx / url → { kind:'html', html, structured:true, host?, url? }   IR 的结构视图
 *   md   → { kind:'md', html, raw }       与「直接打开」一致，可在渲染与原文之间切换
 *   pdf  → { kind:'pdf', url }            交 Chromium 内置阅读器（该帧不带 sandbox）
 * 网页来源的标题栏显示主机名与完整链接，点击链接经 mf:shell:openExternal 交系统浏览器。
 */
import { escapeHtml, escapeAttr, mountFrame, textDocument } from '../dom.js';
import { api } from '../api.js';
import { notify } from './mf-toast.js';

const TABS = Object.freeze({ rendered: '渲染', raw: '原文' });

class MfSourcePane extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.tab = 'rendered';
        this.innerHTML = `
            <header class="pane-header">
                <span class="pane-title">来源</span>
                <span class="pane-label"></span>
                <span class="pane-tabs" role="tablist"></span>
            </header>
            <div class="pane-frame-host"></div>
            <footer class="pane-foot" hidden></footer>`;
        this.addEventListener('click', (event) => this.onClick(event));
    }

    set view(value) {
        this._view = value || null;
        this.tab = 'rendered';
        this.sync();
    }

    get view() {
        return this._view || null;
    }

    onClick(event) {
        const tab = event.target instanceof Element ? event.target.closest('[data-tab]') : null;
        if (tab) {
            this.tab = tab.dataset.tab;
            this.sync();
            return;
        }
        const link = event.target instanceof Element ? event.target.closest('[data-external]') : null;
        if (link) {
            event.preventDefault();
            api.openExternal(link.dataset.external).catch((err) => notify(err.message, 'error'));
        }
    }

    sync() {
        const view = this.view;
        const label = this.querySelector('.pane-label');
        const tabs = this.querySelector('.pane-tabs');
        const host = this.querySelector('.pane-frame-host');
        const foot = this.querySelector('.pane-foot');
        if (!view) {
            label.textContent = '';
            tabs.replaceChildren();
            host.replaceChildren();
            foot.hidden = true;
            return;
        }
        label.innerHTML = view.url
            ? `<span class="chip">${escapeHtml(view.host || '网页')}</span><a class="link-btn" href="#" data-external="${escapeAttr(view.url)}" title="${escapeAttr(view.url)}">${escapeHtml(view.url)}</a>`
            : `<span class="chip">${escapeHtml(view.label || '原文')}</span>`;

        const hasRaw = view.kind === 'md' && typeof view.raw === 'string';
        tabs.innerHTML = hasRaw
            ? Object.entries(TABS).map(([key, text]) => `<button class="pane-tab${this.tab === key ? ' is-active' : ''}" type="button" role="tab" data-tab="${key}">${text}</button>`).join('')
            : '';

        if (view.kind === 'pdf') mountFrame(host, { src: view.url, title: '来源 PDF' });
        else if (hasRaw && this.tab === 'raw') mountFrame(host, { srcdoc: textDocument(view.raw, { title: 'Markdown 原文' }), title: '来源原文' });
        else mountFrame(host, { srcdoc: view.html || '', title: '来源' });

        foot.hidden = !view.structured;
        if (view.structured) foot.textContent = '该格式没有可直接还原的版式，左栏显示的是解析所得的结构视图。';
    }
}

customElements.define('mf-source-pane', MfSourcePane);
