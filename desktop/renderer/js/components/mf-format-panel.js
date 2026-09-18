/**
 * <mf-format-panel>：对比预览的格式面板（方案 §3.4.7）
 *
 * 字段随目标（与 xml profile、输入类型）切换，取值范围一律来自主进程 mf:formats:describe 回包里的
 * describeOptions() 描述树——枚举取 values，数字取 min/max/integer，布尔取 default，
 * 五书子集取 parts 的 values；面板自身不硬编码任何取值范围。
 *
 * 分三组：
 *   排版   主题、字体、字号、行高、栏宽、段距、纸张、横向（改动只需重渲染）
 *   XML    方言、缩进、段号起止与位数、五书子集、分节识别、表格 / 公式栅格、图片密度
 *   解析   图片格式、JPEG 分辨率、文档公式、PDF 解析后端、五书 XML 反向导入的段号
 * 带「需重新解析」标记的字段改动后，主进程会在同一会话内重新 parseDocument（见 preview-session.REPARSE_KEYS），
 * 面板在该组标题上给出提示。
 *
 * 「显式值」语义：面板只提交会话选项里本来就显式存在的键，以及用户在本面板上实际改动过的键（this.touched）。
 * 未给出又未改动的字段不提交，交内核按 profile 补缺省值；其显示值取 format-options.effectiveDefault，
 * 故 patent 方言下「JPG 分辨率」显示的是实际会生效的 300 而非通用默认 330。判定与字段表见 ../format-options.mjs。
 *
 * 用法：panel.context = { formats, sessionId, target, type, options, busy }；改动经 300 ms 防抖后
 * 冒泡 mf-options-change（detail = { options, reparse }），由 <mf-compare-view> 决定实时重渲染还是等「刷新预览」。
 * sessionId 变化即换了预览会话，改动记录随之清空。
 */
import { escapeHtml, escapeAttr } from '../dom.js';
import {
    FIELDS, GROUPS, labelOf, pickNode as pick,
    effectiveDefault, shouldSubmit, visibleFields as pickVisibleFields,
} from '../format-options.mjs';

const DEBOUNCE_MS = 300;

class MfFormatPanel extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.shape = '';
        this.timer = null;
        // 用户在本面板上实际改动过的键；换会话时清空
        this.touched = new Set();
        this.sessionId = null;
        this.innerHTML = '<header class="panel-header">格式</header><div class="panel-body"></div>';
        this.addEventListener('input', (event) => this.onEdit(event));
        this.addEventListener('change', (event) => this.onEdit(event));
    }

    disconnectedCallback() {
        if (this.timer) clearTimeout(this.timer);
    }

    set context(value) {
        const next = value || null;
        const sessionId = next && next.sessionId ? next.sessionId : null;
        // 换了预览会话即另起一份改动记录：上一份文件的改动不该被当成这一份的显式值
        if (sessionId !== this.sessionId) {
            this.sessionId = sessionId;
            this.touched = new Set();
        }
        this.ctx = next;
        this.sync();
    }

    /** 当前 xml 方言：决定按 profile 的缺省值与哪些字段可见 */
    get profile() {
        const options = this.ctx && this.ctx.options;
        return options && options.xmlProfile ? options.xmlProfile : 'generic';
    }

    get tree() {
        const formats = this.ctx && this.ctx.formats;
        return formats && formats.options ? formats.options : null;
    }

    /** 当前目标 / profile / 输入类型下应显示的字段 */
    visibleFields() {
        const { target, type } = this.ctx;
        return pickVisibleFields({ target, type, profile: this.profile }, (field) => pick(this.tree, field.path));
    }

    sync() {
        const body = this.querySelector('.panel-body');
        if (!this.ctx || !this.tree) {
            this.shape = '';
            body.innerHTML = '<p class="hint">正在读取可用选项…</p>';
            return;
        }
        const { target, type, options = {}, busy } = this.ctx;
        const shape = `${target}|${type}|${options.xmlProfile || 'generic'}`;
        const fields = this.visibleFields();
        if (shape !== this.shape) {
            this.shape = shape;
            body.innerHTML = GROUPS.map((group) => this.renderGroup(group, fields.filter((field) => field.group === group.key))).join('');
        }
        // 先按 busy 统一开关，再 fill —— 五书子集的「自动识别」会在 fill 里把分项重新置灰
        for (const control of this.querySelectorAll('input, select')) control.disabled = Boolean(busy);
        this.fill(fields, options);
    }

    renderGroup(group, fields) {
        if (fields.length === 0) return '';
        const reparse = fields.some((field) => field.reparse);
        return `
            <section class="panel-group">
                <h3>${escapeHtml(group.title)}${reparse ? '<span class="panel-badge" title="改动这些项会重新解析源文件">需重新解析</span>' : ''}</h3>
                ${fields.map((field) => this.renderField(field)).join('')}
            </section>`;
    }

    renderField(field) {
        const node = pick(this.tree, field.path);
        const name = escapeAttr(field.key);
        const title = escapeAttr(field.hint || node.description || '');
        if (node.type === 'enum') {
            return `<label class="field" title="${title}"><span>${escapeHtml(field.label)}</span>
                <select class="select select-slim" data-key="${name}">${node.values.map((value) => `<option value="${escapeAttr(value)}">${escapeHtml(labelOf(value))}</option>`).join('')}</select></label>`;
        }
        if (node.type === 'boolean') {
            return `<label class="field field-check" title="${title}"><input type="checkbox" data-key="${name}"><span>${escapeHtml(field.label)}</span></label>`;
        }
        if (node.type === 'number') {
            const step = field.step || (node.integer ? 1 : 0.1);
            return `<label class="field" title="${title}"><span>${escapeHtml(field.label)}<em class="field-range">${node.min}–${node.max}</em></span>
                <input class="input input-slim" type="number" data-key="${name}" min="${node.min}" max="${node.max}" step="${step}"></label>`;
        }
        if (node.type === 'parts') {
            return `<div class="field" title="${title}"><span>${escapeHtml(field.label)}</span>
                <label class="field-check"><input type="checkbox" data-key="${name}" data-parts-auto><span>自动识别</span></label>
                <div class="parts-grid" data-parts="${name}">${node.values.map((value) => `<label class="field-check"><input type="checkbox" data-part="${escapeAttr(value)}"><span>${escapeHtml(labelOf(value))}</span></label>`).join('')}</div></div>`;
        }
        return `<label class="field" title="${title}"><span>${escapeHtml(field.label)}</span>
            <input class="input input-slim" type="text" data-key="${name}" placeholder="${escapeAttr(field.placeholder || '')}" spellcheck="false"></label>`;
    }

    /**
     * 填值：正在输入的控件不覆盖，避免防抖回包把光标里的内容顶掉。
     * 未给出的字段显示「实际会生效的缺省值」（effectiveDefault 按当前 xml 方言取，如 patent 下 jpegPpi 为 300）。
     */
    fill(fields, options) {
        const active = document.activeElement;
        const { profile } = this;
        for (const field of fields) {
            const node = pick(this.tree, field.path);
            const control = this.querySelector(`[data-key="${field.key}"]`);
            if (!control || control === active) continue;
            const value = options[field.key];
            const fallback = effectiveDefault(node, profile);
            if (node.type === 'boolean') control.checked = value === undefined || value === null ? Boolean(fallback) : Boolean(value);
            else if (node.type === 'parts') this.fillParts(field, node, value);
            else if (node.type === 'number') control.value = value === undefined || value === null || value === '' ? String(fallback) : String(value);
            else if (node.type === 'enum') control.value = value === undefined || value === null || value === '' ? fallback : value;
            else control.value = value === undefined || value === null ? (fallback || '') : value;
        }
    }

    fillParts(field, node, value) {
        const auto = this.querySelector(`[data-key="${field.key}"][data-parts-auto]`);
        const chosen = Array.isArray(value) ? value : null;
        if (auto) auto.checked = !chosen;
        for (const box of this.querySelectorAll(`[data-parts="${field.key}"] [data-part]`)) {
            box.checked = chosen ? chosen.includes(box.dataset.part) : node.values.includes(box.dataset.part);
            box.disabled = !chosen;
        }
    }

    /**
     * 面板 → 扁平选项：数字取数值，空文本视为未给出（交由默认值），五书子集为 'auto' 或数组。
     * 只收「会话里本来就显式给出的」与「用户在本面板改动过的」两类键（见 format-options.shouldSubmit）：
     * 其余字段虽有显示值也不提交，否则会把按 profile 的缺省值（如 patent 的 jpegPpi=300）顶掉。
     */
    collect() {
        const options = {};
        const state = { touched: this.touched, options: (this.ctx && this.ctx.options) || {} };
        for (const field of this.visibleFields()) {
            if (!shouldSubmit(field.key, state)) continue;
            const node = pick(this.tree, field.path);
            const control = this.querySelector(`[data-key="${field.key}"]`);
            if (!control) continue;
            if (node.type === 'boolean') options[field.key] = control.checked;
            else if (node.type === 'parts') {
                const picked = [...this.querySelectorAll(`[data-parts="${field.key}"] [data-part]`)].filter((box) => box.checked).map((box) => box.dataset.part);
                options[field.key] = control.checked || picked.length === 0 ? 'auto' : picked;
            } else if (node.type === 'number') {
                const parsed = Number(control.value);
                if (control.value !== '' && Number.isFinite(parsed)) options[field.key] = parsed;
            } else if (control.value !== '') options[field.key] = control.value;
        }
        return options;
    }

    onEdit(event) {
        const control = event.target instanceof Element ? event.target.closest('[data-key], [data-part]') : null;
        if (!control) return;
        if (control.matches('[data-parts-auto]')) {
            for (const box of this.querySelectorAll('[data-parts] [data-part]')) box.disabled = control.checked;
        }
        const partsHost = control.closest('[data-parts]');
        const key = control.dataset.key || (partsHost ? partsHost.dataset.parts : '');
        const field = FIELDS.find((item) => item.key === key);
        const reparse = Boolean(field && field.reparse);
        // 用户动过的键此后一律作为显式值提交，即便取值恰好等于缺省值
        if (key) this.touched.add(key);
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.dispatchEvent(new CustomEvent('mf-options-change', { bubbles: true, detail: { options: this.collect(), reparse } }));
        }, DEBOUNCE_MS);
    }
}

customElements.define('mf-format-panel', MfFormatPanel);

export { FIELDS, GROUPS, DEBOUNCE_MS };
