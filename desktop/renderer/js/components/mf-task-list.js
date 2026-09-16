/**
 * <mf-task-list>：转换任务列表（键控增量渲染，进度更新不重建整行）。
 * 属性（JS property）：tasks（store.tasks）、targets（formats.targets：{ office, markup, url }）、libraryReady（布尔）。
 * 事件（冒泡）：mf-task-change { id, target }、mf-task-remove { id }、mf-task-action { id, action: 'reveal'|'open' }。
 */
import { escapeHtml, escapeAttr, formatSize, targetLabel, typeLabel, classOf, STATUS_LABELS, PHASE_LABELS } from '../dom.js';
import { icon } from '../icons.js';
import './mf-progress.js';

const TYPE_ICONS = Object.freeze({ docx: 'file', xlsx: 'file', pptx: 'file', pdf: 'file', md: 'file', url: 'link' });
const REMOVABLE = new Set(['idle', 'done', 'failed', 'cancelled']);
const EDITABLE = new Set(['idle', 'failed', 'cancelled']);

class MfTaskList extends HTMLElement {
    constructor() {
        super();
        this._tasks = [];
        this._targets = null;
        this._libraryReady = false;
    }

    set tasks(list) { this._tasks = Array.isArray(list) ? list : []; this.render(); }
    get tasks() { return this._tasks; }
    set targets(map) { this._targets = map || null; this.render(); }
    get targets() { return this._targets; }
    set libraryReady(flag) { this._libraryReady = Boolean(flag); this.render(); }
    get libraryReady() { return this._libraryReady; }

    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.innerHTML = '<ul class="task-list" role="list"></ul><div class="task-empty">尚未添加文件：拖入文件或点击「浏览文件」</div>';
        this.addEventListener('change', (event) => {
            const select = event.target instanceof Element ? event.target.closest('select[data-role="target"]') : null;
            if (!select) return;
            const row = select.closest('li[data-id]');
            if (row) this.dispatchEvent(new CustomEvent('mf-task-change', { detail: { id: row.dataset.id, target: select.value }, bubbles: true }));
        });
        this.addEventListener('click', (event) => {
            const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
            if (!button) return;
            const row = button.closest('li[data-id]');
            if (!row) return;
            const { action } = button.dataset;
            if (action === 'remove') this.dispatchEvent(new CustomEvent('mf-task-remove', { detail: { id: row.dataset.id }, bubbles: true }));
            else this.dispatchEvent(new CustomEvent('mf-task-action', { detail: { id: row.dataset.id, action }, bubbles: true }));
        });
        this.render();
    }

    allowedTargets(type) {
        const cls = classOf(type);
        const list = this._targets && cls && Array.isArray(this._targets[cls]) ? this._targets[cls] : [];
        return list;
    }

    render() {
        const list = this.querySelector('ul.task-list');
        const empty = this.querySelector('.task-empty');
        if (!list || !empty) return;
        empty.hidden = this._tasks.length > 0;
        const existing = new Map(Array.from(list.children).map((row) => [row.dataset.id, row]));
        const keep = new Set();
        this._tasks.forEach((task, index) => {
            keep.add(task.id);
            let row = existing.get(task.id);
            if (!row) {
                row = document.createElement('li');
                row.className = 'task';
                row.dataset.id = task.id;
                row.innerHTML = this.rowTemplate(task);
            }
            // 只在次序变化时移动节点，避免进度刷新打断下拉框焦点
            const current = list.children[index] || null;
            if (current !== row) list.insertBefore(row, current);
            this.updateRow(row, task);
        });
        for (const [id, row] of existing) {
            if (!keep.has(id)) row.remove();
        }
    }

    rowTemplate(task) {
        return `
            <div class="task-icon">${icon(TYPE_ICONS[task.type] || 'file')}</div>
            <div class="task-main">
                <div class="task-title">
                    <span class="task-name"></span>
                    <span class="task-type"></span>
                    <span class="task-size"></span>
                </div>
                <div class="task-path"></div>
                <mf-progress class="task-progress" value="0" hidden></mf-progress>
                <div class="task-error" hidden></div>
                <div class="task-output" hidden></div>
            </div>
            <div class="task-side">
                <select class="select task-target" data-role="target" aria-label="目标格式"></select>
                <span class="task-status"></span>
                <div class="task-actions"></div>
            </div>`;
    }

    updateRow(row, task) {
        row.dataset.status = task.status;
        row.querySelector('.task-name').textContent = task.name || task.path || task.url || '';
        row.querySelector('.task-type').textContent = typeLabel(task.type);
        row.querySelector('.task-size').textContent = task.size ? formatSize(task.size) : '';
        const pathEl = row.querySelector('.task-path');
        pathEl.textContent = task.path || task.url || '';
        pathEl.title = task.path || task.url || '';

        const select = row.querySelector('select.task-target');
        const options = this.allowedTargets(task.type);
        const wanted = options.map((target) => `<option value="${escapeAttr(target)}">${escapeHtml(targetLabel(target))}</option>`).join('');
        if (select.dataset.options !== wanted) {
            select.innerHTML = wanted;
            select.dataset.options = wanted;
        }
        if (task.target && select.value !== task.target) select.value = task.target;
        select.disabled = !EDITABLE.has(task.status) || options.length === 0;

        const status = row.querySelector('.task-status');
        status.textContent = STATUS_LABELS[task.status] || task.status;
        status.dataset.status = task.status;

        const progress = row.querySelector('mf-progress');
        const showProgress = task.status === 'running' || task.status === 'queued' || task.status === 'done';
        progress.hidden = !showProgress;
        if (showProgress) {
            progress.setAttribute('value', String(task.status === 'done' ? 100 : task.pct || 0));
            progress.setAttribute('label', task.status === 'queued' ? '排队中' : (PHASE_LABELS[task.phase] || ''));
            progress.setAttribute('state', task.status);
        }

        const error = row.querySelector('.task-error');
        error.hidden = task.status !== 'failed' || !task.error;
        error.textContent = task.error || '';

        const output = row.querySelector('.task-output');
        const outputPath = task.result && task.result.outputPath;
        output.hidden = task.status !== 'done' || !outputPath;
        if (!output.hidden) {
            const warnings = Array.isArray(task.result.warnings) ? task.result.warnings : [];
            output.innerHTML = `<span class="task-output-path">${escapeHtml(outputPath)}</span>${warnings.length ? `<span class="task-warning">${warnings.length} 条提示</span>` : ''}`;
            output.title = warnings.join('\n');
        }

        const actions = row.querySelector('.task-actions');
        const buttons = [];
        if (task.status === 'done' && task.libraryId && this._libraryReady) {
            buttons.push(`<button class="btn btn-small btn-secondary" type="button" data-action="reveal">${icon('folderOpen')}${this.revealLabel()}</button>`);
            buttons.push(`<button class="btn btn-small btn-secondary" type="button" data-action="open">${icon('open')}打开</button>`);
        }
        if (REMOVABLE.has(task.status)) buttons.push(`<button class="icon-btn icon-btn-sm" type="button" data-action="remove" title="移除" aria-label="移除">${icon('x')}</button>`);
        const html = buttons.join('');
        if (actions.dataset.html !== html) {
            actions.innerHTML = html;
            actions.dataset.html = html;
        }
    }

    revealLabel() {
        return navigator.platform.toLowerCase().includes('mac') ? '在 Finder 中显示' : '在资源管理器中显示';
    }
}

customElements.define('mf-task-list', MfTaskList);
