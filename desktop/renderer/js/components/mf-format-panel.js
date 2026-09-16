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
 *   解析   图片格式、JPEG 分辨率、文档公式、PDF 解析后端
 * 带「需重新解析」标记的字段改动后，主进程会在同一会话内重新 parseDocument（见 preview-session.REPARSE_KEYS），
 * 面板在该组标题上给出提示。
 *
 * 用法：panel.context = { formats, target, type, options, busy }；改动经 300 ms 防抖后
 * 冒泡 mf-options-change（detail = { options, reparse }），由 <mf-compare-view> 决定实时重渲染还是等「刷新预览」。
 */
import { escapeHtml, escapeAttr } from '../dom.js';

const DEBOUNCE_MS = 300;
const ALL_TARGETS = '*';

const GROUPS = Object.freeze([
    { key: 'layout', title: '排版', hint: '改动即时重渲染' },
    { key: 'xml', title: 'XML', hint: '' },
    { key: 'parse', title: '解析', hint: '改动后需重新解析源文件' },
]);

/**
 * path 为 describeOptions() 描述树中的路径（对象层用 fields 下钻）；
 * targets / types 限定该字段对哪些目标与输入类型有意义；profile 限定只在该 xml profile 下出现。
 */
const FIELDS = Object.freeze([
    { key: 'theme', label: '主题', group: 'layout', targets: ['html', 'pdf'], path: ['html', 'theme'] },
    { key: 'font', label: '正文字体', group: 'layout', targets: ['html', 'pdf'], path: ['html', 'fontFamily'], placeholder: '留空取主题默认' },
    { key: 'fontSize', label: '正文字号', group: 'layout', targets: ['html', 'pdf', 'docx'], path: ['html', 'fontSize'] },
    { key: 'lineHeight', label: '行高', group: 'layout', targets: ['html', 'pdf'], path: ['html', 'lineHeight'], step: 0.05 },
    { key: 'contentWidth', label: '正文栏宽', group: 'layout', targets: ['html'], path: ['html', 'contentWidth'] },
    { key: 'spacing', label: '段落间距', group: 'layout', targets: ['html', 'pdf'], path: ['html', 'spacing'] },
    { key: 'inlineImages', label: '图片内联为 data URI', group: 'layout', targets: ['html'], path: ['html', 'inlineImages'] },
    { key: 'pageSize', label: '纸张', group: 'layout', targets: ['pdf', 'docx'], path: ['pdf', 'pageSize'] },
    { key: 'landscape', label: '横向', group: 'layout', targets: ['pdf'], path: ['pdf', 'landscape'] },

    { key: 'xmlProfile', label: 'XML 方言', group: 'xml', targets: ['xml'], path: ['xml', 'profile'], reparse: true },
    { key: 'xmlIndent', label: '缩进空格数', group: 'xml', targets: ['xml'], path: ['xml', 'indent'] },
    // DTD 校验只在渲染阶段发生（不进 REPARSE_KEYS），勾选后重渲染即可拿到 precheck.json 的 validation
    { key: 'validate', label: 'DTD 校验（官方 DTD）', group: 'xml', targets: ['xml'], path: ['xml', 'validate'], profile: 'patent' },
    { key: 'numberingStart', label: '段号起始', group: 'xml', targets: ['xml'], path: ['xml', 'numbering', 'start'], profile: 'patent' },
    { key: 'numberingWidth', label: '段号补零位数', group: 'xml', targets: ['xml'], path: ['xml', 'numbering', 'width'], profile: 'patent' },
    { key: 'patentParts', label: '输出的五书', group: 'xml', targets: ['xml'], path: ['xml', 'patent', 'parts'], profile: 'patent', reparse: true },
    { key: 'sectionDetection', label: '分节识别', group: 'xml', targets: ['xml'], path: ['xml', 'patent', 'sectionDetection'], profile: 'patent', reparse: true },
    { key: 'rasterizeTables', label: '表格栅格为图片', group: 'xml', targets: ['xml'], path: ['xml', 'patent', 'rasterizeTables'], profile: 'patent', reparse: true },
    { key: 'rasterizeFormulas', label: '公式栅格为图片', group: 'xml', targets: ['xml'], path: ['xml', 'patent', 'rasterizeFormulas'], profile: 'patent', reparse: true },
    { key: 'imageDpi', label: '图片密度（DPI）', group: 'xml', targets: ['xml'], path: ['xml', 'patent', 'imageDpi'], profile: 'patent', reparse: true },

    { key: 'imageFormat', label: '图片格式', group: 'parse', targets: ALL_TARGETS, path: ['imageFormat'], reparse: true },
    { key: 'jpegPpi', label: 'JPG 分辨率（PPI）', group: 'parse', targets: ALL_TARGETS, path: ['jpegPpi'], reparse: true },
    { key: 'math', label: '文档公式', group: 'parse', targets: ALL_TARGETS, path: ['math'], types: ['docx'], reparse: true },
    { key: 'pdfBackend', label: 'PDF 解析后端', group: 'parse', targets: ALL_TARGETS, path: ['pdfBackend'], types: ['pdf'], reparse: true },
]);

const ENUM_LABELS = Object.freeze({
    apple: '苹果浅色', 'apple-dark': '苹果深色', github: 'GitHub', academic: '论文（衬线）', reader: '长文阅读', print: '打印',
    compact: '紧凑', normal: '标准', loose: '宽松',
    jpg: 'JPG 归一', keep: '保持原格式',
    image: '栅格为图片', text: '线性化文本',
    auto: '自动', mineru: 'MinerU 云端', local: '本地 pdfjs',
    generic: 'generic 通用结构', patent: 'patent 国知局五书',
    headings: '仅标题',
    claims: '权利要求书', description: '说明书', drawings: '说明书附图', abstract: '摘要', 'abstract-figure': '摘要附图',
});
const labelOf = (value) => ENUM_LABELS[value] || String(value);

/** 描述树下钻：对象层的子字段挂在 fields 下 */
function pick(tree, path) {
    let node = tree;
    for (let i = 0; i < path.length; i += 1) {
        if (!node) return null;
        node = i === 0 ? node[path[i]] : (node.fields ? node.fields[path[i]] : null);
    }
    return node || null;
}

class MfFormatPanel extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.shape = '';
        this.timer = null;
        this.innerHTML = '<header class="panel-header">格式</header><div class="panel-body"></div>';
        this.addEventListener('input', (event) => this.onEdit(event));
        this.addEventListener('change', (event) => this.onEdit(event));
    }

    disconnectedCallback() {
        if (this.timer) clearTimeout(this.timer);
    }

    set context(value) {
        this.ctx = value || null;
        this.sync();
    }

    get tree() {
        const formats = this.ctx && this.ctx.formats;
        return formats && formats.options ? formats.options : null;
    }

    /** 当前目标 / profile / 输入类型下应显示的字段 */
    visibleFields() {
        const { target, type, options } = this.ctx;
        const profile = options && options.xmlProfile ? options.xmlProfile : 'generic';
        return FIELDS.filter((field) => {
            if (field.targets !== ALL_TARGETS && !field.targets.includes(target)) return false;
            if (field.types && !field.types.includes(type)) return false;
            if (field.profile && field.profile !== profile) return false;
            return Boolean(pick(this.tree, field.path));
        });
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
        const title = escapeAttr(node.description || '');
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

    /** 填值：正在输入的控件不覆盖，避免防抖回包把光标里的内容顶掉 */
    fill(fields, options) {
        const active = document.activeElement;
        for (const field of fields) {
            const node = pick(this.tree, field.path);
            const control = this.querySelector(`[data-key="${field.key}"]`);
            if (!control || control === active) continue;
            const value = options[field.key];
            if (node.type === 'boolean') control.checked = value === undefined || value === null ? Boolean(node.default) : Boolean(value);
            else if (node.type === 'parts') this.fillParts(field, node, value);
            else if (node.type === 'number') control.value = value === undefined || value === null || value === '' ? String(node.default) : String(value);
            else if (node.type === 'enum') control.value = value === undefined || value === null || value === '' ? node.default : value;
            else control.value = value === undefined || value === null ? (node.default || '') : value;
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

    /** 面板 → 扁平选项：数字取数值，空文本视为未给出（交由默认值），五书子集为 'auto' 或数组 */
    collect() {
        const options = {};
        for (const field of this.visibleFields()) {
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
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.dispatchEvent(new CustomEvent('mf-options-change', { bubbles: true, detail: { options: this.collect(), reparse } }));
        }, DEBOUNCE_MS);
    }
}

customElements.define('mf-format-panel', MfFormatPanel);

export { FIELDS, GROUPS, DEBOUNCE_MS };
