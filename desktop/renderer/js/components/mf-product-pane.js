/**
 * <mf-product-pane>：对比预览右栏 —— 产物视图（方案 §3.4.7）
 *
 * 用法：pane.sessionId = 预览会话 id；pane.product = mf:preview:open / render 回包里的 product。
 *   html   → { kind:'html', html }                 渲染与源码两个页签
 *   xml    → { kind:'xml', xml, structuredHtml, parts, precheck, profile }
 *            结构视图 / 原文两个页签 + 分文件切换 + 预检清单（patent profile 的 precheck.json 与
 *            带「预检：」「分节：」「发明名称：」「权项：」「段号：」「附图：」「栅格化：」「DTD 校验：」前缀的 warnings）
 *   md     → { kind:'md', html, raw }              bundle 目标：渲染 / Markdown 原文 / 编辑 三个页签
 *   pdf    → { kind:'pdf', url }                   临时 PDF 交 Chromium 内置阅读器（该帧不带 sandbox）
 * 页脚列出本次将导出的文件名与渲染告警；docx 目标另提示「快速预览由生成的 DOCX 反读而来」。
 *
 * 编辑页签：挂一个常驻的 <mf-md-editor>（栏窄，内置预览默认收起，保存状态由对比页显示在标题旁），切页签只改 hidden；
 * md 有改动时「渲染」页签显示编辑器最近一次的实时渲染；产物对象更换（改选项后）时编辑器载入新产物，换会话则销毁编辑器。
 * 帧键（产物版本 | 页签 | 分文件 | 编辑器渲染版本）未变时不重建 iframe。
 */
import { escapeHtml, escapeAttr, mountFrame, textDocument } from '../dom.js';
import './mf-md-editor.js';

const LEVEL_LABELS = Object.freeze({ blocking: '阻断', error: '阻断', warning: '提示', info: '说明' });

class MfProductPane extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.tab = 'rendered';
        this.partIndex = 0;
        this.productRev = this.productRev || 0;
        this.editorHtmlRev = 0;
        this.frameKey = '';
        this.innerHTML = `
            <header class="pane-header">
                <span class="pane-title">产物</span>
                <span class="pane-label"></span>
                <span class="pane-tabs" role="tablist"></span>
                <select class="select select-slim pane-parts" hidden aria-label="分文件"></select>
            </header>
            <div class="pane-frame-host"></div>
            <div class="md-editor-host" data-role="editor-host" hidden></div>
            <section class="precheck" hidden></section>
            <footer class="pane-foot" hidden></footer>`;
        this.addEventListener('click', (event) => {
            const tab = event.target instanceof Element ? event.target.closest('[data-tab]') : null;
            if (!tab) return;
            this.tab = tab.dataset.tab;
            this.sync();
        });
        this.addEventListener('change', (event) => {
            if (!(event.target instanceof Element) || !event.target.matches('.pane-parts')) return;
            this.partIndex = Number(event.target.value) || 0;
            this.sync();
        });
        this.addEventListener('mf-md-rendered', () => { this.editorHtmlRev += 1; });
        if (this._product) this.sync();
    }

    /** 预览会话 id：换会话时销毁旧编辑器（其暂存的修改随旧会话一并作废） */
    set sessionId(value) {
        const next = value ? String(value) : null;
        if (next === this._sessionId) return;
        this._sessionId = next;
        this.disposeEditor();
    }

    get sessionId() {
        return this._sessionId || null;
    }

    set product(value) {
        const next = value || null;
        if (next === this._product) return;
        const sameTarget = this._product && next && this._product.target === next.target;
        this._product = next;
        this.productRev = (this.productRev || 0) + 1;
        if (!sameTarget) {
            this.tab = 'rendered';
            // 切目标时回到主视图（xml 为说明书那一份）；属性名不能叫 part —— Element.part 是 DOMTokenList
            this.partIndex = Number(next && next.view && next.view.primary) || 0;
        }
        if (this.editor) {
            const view = next && next.view;
            if (view && view.kind === 'md') this.editor.setContent(view.raw || '', { html: view.html || '', status: 'idle' });
            else this.disposeEditor();
        }
        if (this.dataset.ready) this.sync();
    }

    get product() {
        return this._product || null;
    }

    /** 当前展示的 xml 分文件（parts 为空时退回视图本身） */
    get activePart() {
        const view = this.product && this.product.view;
        if (!view || view.kind !== 'xml') return null;
        const parts = Array.isArray(view.parts) ? view.parts : [];
        return parts[this.partIndex] || parts[0] || { name: '', xml: view.xml, structuredHtml: view.structuredHtml };
    }

    tabsFor(view) {
        if (!view) return [];
        if (view.kind === 'xml') {
            const part = this.activePart;
            return part && part.structuredHtml ? [['rendered', '结构视图'], ['raw', 'XML 原文']] : [['raw', 'XML 原文']];
        }
        if (view.kind === 'md') {
            const tabs = [['rendered', '渲染'], ['raw', 'Markdown 原文']];
            return this.product && this.product.target === 'bundle' ? [...tabs, ['edit', '编辑']] : tabs;
        }
        if (view.kind === 'html') return [['rendered', '渲染'], ['raw', 'HTML 源码']];
        return [];
    }

    sync() {
        const product = this.product;
        const view = product && product.view;
        const label = this.querySelector('.pane-label');
        const tabs = this.querySelector('.pane-tabs');
        const parts = this.querySelector('.pane-parts');
        const host = this.querySelector('.pane-frame-host');
        const editorHost = this.querySelector('[data-role="editor-host"]');
        const foot = this.querySelector('.pane-foot');
        const precheck = this.querySelector('.precheck');
        if (!view) {
            label.textContent = '';
            tabs.replaceChildren();
            parts.hidden = true;
            host.replaceChildren();
            host.hidden = false;
            editorHost.hidden = true;
            this.frameKey = '';
            foot.hidden = true;
            precheck.hidden = true;
            return;
        }

        label.innerHTML = `<span class="chip chip-target">${escapeHtml(String(product.target || '').toUpperCase())}</span>${view.profile ? `<span class="chip">${escapeHtml(view.profile)}</span>` : ''}`;
        const available = this.tabsFor(view);
        if (!available.some(([key]) => key === this.tab)) this.tab = available.length > 0 ? available[0][0] : 'rendered';
        tabs.innerHTML = available.map(([key, text]) => `<button class="pane-tab${this.tab === key ? ' is-active' : ''}" type="button" role="tab" data-tab="${key}" aria-selected="${this.tab === key}">${escapeHtml(text)}</button>`).join('');

        this.syncParts(view, parts);
        const editing = this.tab === 'edit' && view.kind === 'md';
        host.hidden = editing;
        editorHost.hidden = !editing;
        if (editing) this.showEditor(view, editorHost);
        else this.mount(view, host);
        this.syncPrecheck(view, precheck);

        const warnings = Array.isArray(product.warnings) ? product.warnings : [];
        const hint = view.hint ? `<p class="pane-hint">${escapeHtml(view.hint)}</p>` : '';
        const warnLine = warnings.length > 0
            ? `<details class="pane-warnings"><summary>转换提示 ${warnings.length} 条</summary><ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>`
            : '';
        foot.innerHTML = `${hint}${warnLine}`;
        foot.hidden = !hint && !warnLine;
    }

    syncParts(view, select) {
        const list = view.kind === 'xml' && Array.isArray(view.parts) ? view.parts : [];
        select.hidden = list.length < 2;
        if (list.length < 2) return;
        if (this.partIndex >= list.length) this.partIndex = 0;
        select.innerHTML = list.map((part, index) => `<option value="${index}"${index === this.partIndex ? ' selected' : ''}>${escapeHtml(part.name)}</option>`).join('');
    }

    /** 编辑页签：首次进入时建常驻编辑器并载入产物 md 原文；之后切页签只改 hidden */
    showEditor(view, host) {
        if (this.editor) return;
        const editor = document.createElement('mf-md-editor');
        editor.frameAppearance = 'paper';
        editor.previewVisible = false;
        editor.showStatus = false;
        editor.sessionId = this._sessionId;
        host.append(editor);
        this.editor = editor;
        editor.setContent(view.raw || '', { html: view.html || '', status: 'idle' });
    }

    disposeEditor() {
        if (!this.editor) return;
        this.editor.dispose();
        this.editor.remove();
        this.editor = null;
        this.editorHtmlRev = 0;
        this.frameKey = '';
    }

    /** md 有改动时「渲染」显示编辑器的实时渲染；否则显示产物本身 */
    renderedHtml(view) {
        if (view.kind === 'md' && this.editor && this.editor.modified && this.editor.lastHtml) return { html: this.editor.lastHtml, rev: `e${this.editorHtmlRev}` };
        return { html: view.html || '', rev: 'p' };
    }

    mount(view, host) {
        const rendered = this.tab === 'rendered' ? this.renderedHtml(view) : null;
        const key = [this.productRev, this.tab, this.partIndex, rendered ? rendered.rev : ''].join('|');
        if (key === this.frameKey && host.firstElementChild) return;
        this.frameKey = key;
        const mountCompareFrame = (options) => mountFrame(host, { ...options, scrollbar: true, sameOrigin: true });
        if (view.kind === 'pdf') {
            mountCompareFrame({ src: view.url, title: '产物 PDF' });
            return;
        }
        if (view.kind === 'xml') {
            const part = this.activePart;
            if (this.tab === 'rendered' && part && part.structuredHtml) mountCompareFrame({ srcdoc: part.structuredHtml, title: '产物结构视图' });
            else mountCompareFrame({ srcdoc: textDocument(part ? part.xml : '', { title: 'XML 原文' }), title: 'XML 原文' });
            return;
        }
        if (this.tab === 'raw') {
            const raw = view.kind === 'md' ? view.raw : view.html;
            mountCompareFrame({ srcdoc: textDocument(raw || '', { title: '原文' }), title: '产物原文' });
            return;
        }
        mountCompareFrame({ srcdoc: rendered ? rendered.html : (view.html || ''), title: '产物', appearance: 'paper' });
    }

    /** 预检清单：patent profile 的 precheck.json，按 blocking / warning 分组显示，并附 DTD 校验结果 */
    syncPrecheck(view, host) {
        const report = view.kind === 'xml' ? view.precheck : null;
        const items = report && Array.isArray(report.items) ? report.items : [];
        const validation = report && report.validation && report.validation.requested ? report.validation : null;
        host.hidden = items.length === 0 && !validation;
        if (host.hidden) return;
        const blocking = items.filter((item) => item.level === 'blocking' || item.level === 'error').length;
        const list = items.length === 0 ? '' : `
            <details${blocking > 0 ? ' open' : ''}>
                <summary>预检清单 ${items.length} 项${blocking > 0 ? `（阻断 ${blocking}）` : ''}</summary>
                <ul>${items.map((item) => `
                    <li data-level="${escapeAttr(item.level || 'warning')}">
                        <span class="precheck-level">${escapeHtml(LEVEL_LABELS[item.level] || '提示')}</span>
                        <span class="precheck-message">${escapeHtml(item.message || '')}</span>
                        ${item.location ? `<code class="precheck-location">${escapeHtml(item.location)}</code>` : ''}
                    </li>`).join('')}</ul>
            </details>`;
        host.innerHTML = `${list}${validation ? renderValidation(validation) : ''}`;
    }
}

/**
 * precheck.json 的 validation 段：{ requested, engine, files: [{ file, valid, errors:[{line,message}], warnings:[] }] }。
 * engine 为 null 表示本机没装校验器（libxml2-wasm 为可选依赖），此时如实说明而不报成校验失败。
 */
function renderValidation(validation) {
    const files = Array.isArray(validation.files) ? validation.files : [];
    if (!validation.engine) {
        return '<p class="precheck-validation" data-state="unavailable">DTD 校验：本机未安装校验器（可选依赖 libxml2-wasm），已跳过。</p>';
    }
    const failed = files.filter((item) => !item.valid);
    const summary = failed.length === 0
        ? `DTD 校验通过：${files.length} 份文件（${escapeHtml(validation.engine)}）`
        : `DTD 校验未通过：${failed.length}/${files.length} 份文件有错（${escapeHtml(validation.engine)}）`;
    return `
        <details class="precheck-validation" data-state="${failed.length === 0 ? 'ok' : 'error'}"${failed.length > 0 ? ' open' : ''}>
            <summary>${summary}</summary>
            <ul>${files.map((item) => `
                <li data-level="${item.valid ? 'info' : 'blocking'}">
                    <span class="precheck-level">${item.valid ? '通过' : '不合法'}</span>
                    <code class="precheck-location">${escapeHtml(item.file)}</code>
                    ${(item.errors || []).map((error) => `<span class="precheck-message">第 ${escapeHtml(error.line)} 行：${escapeHtml(error.message)}</span>`).join('')}
                </li>`).join('')}</ul>
        </details>`;
}

customElements.define('mf-product-pane', MfProductPane);
