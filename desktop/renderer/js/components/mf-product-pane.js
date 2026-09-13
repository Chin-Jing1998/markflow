/**
 * <mf-product-pane>：对比预览右栏 —— 产物视图（方案 §3.4.7）
 *
 * 用法：pane.product = mf:preview:open / render 回包里的 product。
 *   html   → { kind:'html', html }                 渲染与源码两个页签
 *   xml    → { kind:'xml', xml, structuredHtml, parts, precheck, profile }
 *            结构视图 / 原文两个页签 + 分文件切换 + 预检清单（patent profile 的 precheck.json 与
 *            带「预检：」「分节：」「发明名称：」「权项：」「段号：」「附图：」「栅格化：」「DTD 校验：」前缀的 warnings）
 *   md     → { kind:'md', html, raw }              bundle 目标：渲染与 Markdown 原文两个页签
 *   pdf    → { kind:'pdf', url }                   临时 PDF 交 Chromium 内置阅读器（该帧不带 sandbox）
 * 页脚列出本次将导出的文件名与渲染告警；docx 目标另提示「快速预览由生成的 DOCX 反读而来」。
 */
import { escapeHtml, escapeAttr, mountFrame, textDocument } from '../dom.js';

const LEVEL_LABELS = Object.freeze({ blocking: '阻断', error: '阻断', warning: '提示', info: '说明' });

class MfProductPane extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.tab = 'rendered';
        this.partIndex = 0;
        this.innerHTML = `
            <header class="pane-header">
                <span class="pane-title">产物</span>
                <span class="pane-label"></span>
                <span class="pane-tabs" role="tablist"></span>
                <select class="select select-slim pane-parts" hidden aria-label="分文件"></select>
            </header>
            <div class="pane-frame-host"></div>
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
    }

    set product(value) {
        const next = value || null;
        const sameTarget = this._product && next && this._product.target === next.target;
        this._product = next;
        if (!sameTarget) {
            this.tab = 'rendered';
            // 切目标时回到主视图（xml 为说明书那一份）；属性名不能叫 part —— Element.part 是 DOMTokenList
            this.partIndex = Number(next && next.view && next.view.primary) || 0;
        }
        this.sync();
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
        if (view.kind === 'md') return [['rendered', '渲染'], ['raw', 'Markdown 原文']];
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
        const foot = this.querySelector('.pane-foot');
        const precheck = this.querySelector('.precheck');
        if (!view) {
            label.textContent = '';
            tabs.replaceChildren();
            parts.hidden = true;
            host.replaceChildren();
            foot.hidden = true;
            precheck.hidden = true;
            return;
        }

        label.innerHTML = `<span class="chip chip-target">${escapeHtml(String(product.target || '').toUpperCase())}</span>${view.profile ? `<span class="chip">${escapeHtml(view.profile)}</span>` : ''}`;
        const available = this.tabsFor(view);
        if (!available.some(([key]) => key === this.tab)) this.tab = available.length > 0 ? available[0][0] : 'rendered';
        tabs.innerHTML = available.map(([key, text]) => `<button class="pane-tab${this.tab === key ? ' is-active' : ''}" type="button" role="tab" data-tab="${key}">${escapeHtml(text)}</button>`).join('');

        this.syncParts(view, parts);
        this.mount(view, host);
        this.syncPrecheck(view, precheck);

        const files = Array.isArray(product.files) ? product.files : [];
        const warnings = Array.isArray(product.warnings) ? product.warnings : [];
        const hint = view.hint ? `<p class="pane-hint">${escapeHtml(view.hint)}</p>` : '';
        const fileLine = files.length > 0 ? `<p class="pane-files">导出后得到：${files.map((name) => `<code>${escapeHtml(name)}</code>`).join('、')}</p>` : '';
        const warnLine = warnings.length > 0
            ? `<details class="pane-warnings"><summary>转换提示 ${warnings.length} 条</summary><ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></details>`
            : '';
        foot.innerHTML = `${hint}${fileLine}${warnLine}`;
        foot.hidden = !hint && !fileLine && !warnLine;
    }

    syncParts(view, select) {
        const list = view.kind === 'xml' && Array.isArray(view.parts) ? view.parts : [];
        select.hidden = list.length < 2;
        if (list.length < 2) return;
        if (this.partIndex >= list.length) this.partIndex = 0;
        select.innerHTML = list.map((part, index) => `<option value="${index}"${index === this.partIndex ? ' selected' : ''}>${escapeHtml(part.name)}</option>`).join('');
    }

    mount(view, host) {
        if (view.kind === 'pdf') {
            mountFrame(host, { src: view.url, title: '产物 PDF' });
            return;
        }
        if (view.kind === 'xml') {
            const part = this.activePart;
            if (this.tab === 'rendered' && part && part.structuredHtml) mountFrame(host, { srcdoc: part.structuredHtml, title: '产物结构视图' });
            else mountFrame(host, { srcdoc: textDocument(part ? part.xml : '', { title: 'XML 原文' }), title: 'XML 原文' });
            return;
        }
        if (this.tab === 'raw') {
            const raw = view.kind === 'md' ? view.raw : view.html;
            mountFrame(host, { srcdoc: textDocument(raw || '', { title: '原文' }), title: '产物原文' });
            return;
        }
        mountFrame(host, { srcdoc: view.html || '', title: '产物' });
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
