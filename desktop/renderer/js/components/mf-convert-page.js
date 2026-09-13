/**
 * <mf-convert-page>：转换页 = 拖放区 + 任务列表 + 底栏（输出目录、DTD 校验、开始 / 取消 / 清空）。
 * 任务状态存于全局 store.tasks；进度事件（mf:convert:event）在此消费并写回 store。
 * 底栏的「DTD 校验」只在队列里有 xml 目标的待转任务时出现，勾选后随本批 options 一起提交。
 */
import { store, addTasks, updateTask, removeTask, clearTasks } from '../store.js';
import { api, onConvertEvent } from '../api.js';
import { icon } from '../icons.js';
import { classOf, nextId } from '../dom.js';
import { notify } from './mf-toast.js';
import './mf-dropzone.js';
import './mf-task-list.js';
import './mf-url-input.js';
import { hostOf } from '../url-lines.mjs';

const PENDING = new Set(['idle', 'failed', 'cancelled']);
const FINISHED = new Set(['done', 'failed', 'cancelled']);
const URL_TARGET_HINT = '网页链接只能转为 bundle、html 或 xml';

class MfConvertPage extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.innerHTML = `
            <header class="page-header">
                <h1>转换</h1>
                <div class="page-header-actions">
                    <span class="output-dir" title="输出目录"></span>
                    <button class="btn btn-secondary btn-small" type="button" data-action="pick-output">${icon('folder')}输出目录</button>
                </div>
            </header>
            <div class="page-body convert-body">
                <mf-dropzone></mf-dropzone>
                <mf-url-input></mf-url-input>
                <mf-task-list></mf-task-list>
            </div>
            <footer class="page-footer">
                <div class="footer-summary"></div>
                <div class="footer-actions">
                    <label class="field-check footer-option" data-role="validate-field" hidden title="渲染后用官方 DTD 校验五书，结果写入 precheck.json 与转换提示">
                        <input type="checkbox" data-field="validate"><span>DTD 校验</span>
                    </label>
                    <button class="btn btn-secondary" type="button" data-action="clear">清空已完成</button>
                    <button class="btn btn-secondary" type="button" data-action="cancel" hidden>${icon('x')}取消</button>
                    <button class="btn btn-primary btn-convert" type="button" data-action="start">${icon('convert')}开始转换</button>
                </div>
            </footer>`;
        this.list = this.querySelector('mf-task-list');
        this.addEventListener('mf-files', (event) => this.enqueue(event.detail.paths));
        this.addEventListener('mf-urls', (event) => this.enqueueUrls(event.detail));
        this.addEventListener('mf-task-change', (event) => updateTask(event.detail.id, { target: event.detail.target }));
        this.addEventListener('mf-task-remove', (event) => removeTask(event.detail.id));
        this.addEventListener('mf-task-action', (event) => this.act(event.detail));
        this.addEventListener('click', (event) => {
            const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
            if (!button || button.closest('mf-task-list') || button.closest('mf-dropzone') || button.closest('mf-url-input')) return;
            const { action } = button.dataset;
            if (action === 'start') this.start();
            else if (action === 'cancel') this.cancel();
            else if (action === 'clear') clearTasks((task) => FINISHED.has(task.status));
            else if (action === 'pick-output') this.pickOutputDir();
        });
        this.unsubs = [store.subscribe((state) => this.sync(state)), onConvertEvent((event) => this.onEvent(event))];
        this.sync(store.get());
    }

    disconnectedCallback() {
        for (const off of this.unsubs || []) off();
    }

    refresh() { /* 页面显示时无需拉取 */ }

    get settings() {
        const wrapped = store.get().settings;
        return wrapped && wrapped.settings ? wrapped.settings : null;
    }

    get targets() {
        const formats = store.get().formats;
        return formats && formats.targets ? formats.targets : null;
    }

    defaultTarget(type) {
        const cls = classOf(type);
        const allowed = this.targets && cls && Array.isArray(this.targets[cls]) ? this.targets[cls] : [];
        const preferred = this.settings && this.settings.defaultTargets ? this.settings.defaultTargets[cls] : null;
        if (preferred && allowed.includes(preferred)) return preferred;
        return allowed[0] || null;
    }

    sync(state) {
        this.list.tasks = state.tasks;
        this.list.targets = state.formats ? state.formats.targets : null;
        this.list.libraryReady = Boolean(state.formats && state.formats.library);
        const settings = state.settings && state.settings.settings;
        const outputDir = state.run ? state.run.outputDir : (settings ? (settings.library.mode === 'managed' ? `${settings.library.root}（托管）` : settings.outputDir) : '…');
        this.querySelector('.output-dir').textContent = outputDir;
        const pending = state.tasks.filter((task) => PENDING.has(task.status)).length;
        const done = state.tasks.filter((task) => task.status === 'done').length;
        const failed = state.tasks.filter((task) => task.status === 'failed').length;
        const summary = state.tasks.length === 0 ? '' : `${state.tasks.length} 个任务 · 待转换 ${pending} · 完成 ${done}${failed ? ` · 失败 ${failed}` : ''}`;
        this.querySelector('.footer-summary').textContent = summary;
        const running = Boolean(state.run);
        const badUrlTargets = state.tasks.filter((task) => task.url && PENDING.has(task.status) && !this.isUrlTargetAllowed(task.target));
        this.querySelector('[data-action="start"]').disabled = running || pending === 0 || badUrlTargets.length > 0;
        this.querySelector('[data-action="start"]').title = badUrlTargets.length > 0 ? URL_TARGET_HINT : '';
        if (badUrlTargets.length > 0) this.querySelector('.footer-summary').textContent = `${summary} · ${URL_TARGET_HINT}`;
        this.querySelector('[data-action="cancel"]').hidden = !running;
        this.querySelector('[data-action="clear"]').disabled = state.tasks.every((task) => !FINISHED.has(task.status));
        // DTD 校验只对 xml 目标有意义，故只在队列里有 xml 任务时露出
        this.querySelector('[data-role="validate-field"]').hidden = !state.tasks.some((task) => task.target === 'xml' && PENDING.has(task.status));
    }

    async enqueue(paths) {
        try {
            const { files, unsupported, truncated } = await api.expandPaths(paths);
            this.addEntries(files);
            if (unsupported && unsupported.length > 0) notify(`已忽略 ${unsupported.length} 个不支持的文件`, 'warning');
            if (truncated) notify('文件过多，只保留了前 2000 个', 'warning');
            if (files.length === 0 && (!unsupported || unsupported.length === 0)) notify('未找到可转换的文件', 'warning');
        } catch (err) {
            notify(`读取文件失败：${err.message}`, 'error');
        }
    }

    /** 网页链接目标只能是 targets.url 列出的项（bundle / html / xml） */
    isUrlTargetAllowed(target) {
        const allowed = this.targets && Array.isArray(this.targets.url) ? this.targets.url : ['bundle', 'html', 'xml'];
        return allowed.includes(target);
    }

    enqueueUrls({ urls, duplicates } = {}) {
        const list = Array.isArray(urls) ? urls : [];
        const before = store.get().tasks.length;
        addTasks(list.map((url) => ({ id: nextId('url'), url, name: hostOf(url), type: 'url', size: 0, target: this.defaultTarget('url') })));
        const added = store.get().tasks.length - before;
        const skipped = list.length - added + (duplicates || 0);
        if (added > 0) notify(`已添加 ${added} 条链接${skipped > 0 ? `，跳过 ${skipped} 条重复` : ''}`, 'success');
        else if (list.length > 0) notify('链接已在任务列表中', 'info');
    }

    addEntries(files) {
        addTasks((files || []).map((file) => ({
            id: nextId('task'), path: file.path, name: file.name, type: file.type, size: file.size, target: this.defaultTarget(file.type),
        })));
    }

    async start() {
        const pending = store.get().tasks.filter((task) => PENDING.has(task.status));
        if (pending.length === 0) {
            notify('没有待转换的任务', 'info');
            return;
        }
        const items = pending.map((task) => ({
            id: task.id,
            ...(task.url ? { url: task.url } : { path: task.path }),
            ...(task.target ? { target: task.target } : {}),
        }));
        const validate = this.querySelector('[data-field="validate"]');
        const options = validate && !validate.closest('[data-role="validate-field"]').hidden && validate.checked ? { validate: true } : undefined;
        try {
            const res = await api.convertRun(options ? { items, options } : { items });
            store.set({ run: { runId: res.runId, outputDir: res.outputDir } });
            for (const task of res.tasks) updateTask(task.taskId, { status: 'queued', runId: res.runId, target: task.target, error: '', pct: 0, phase: '' });
        } catch (err) {
            notify(err.message, 'error', 6000);
        }
    }

    async cancel() {
        const run = store.get().run;
        if (!run) return;
        try {
            await api.convertCancel(run.runId);
            notify('已请求取消：未开始的任务将被跳过，进行中的任务会完成', 'info');
        } catch (err) {
            notify(err.message, 'error');
        }
    }

    async pickOutputDir() {
        try {
            const current = this.settings ? this.settings.outputDir : undefined;
            const result = await api.pickDirectory({ title: '选择输出目录', defaultPath: current });
            if (result.canceled || !result.path) return;
            const described = await api.settingsSet({ outputDir: result.path });
            store.set({ settings: described });
            notify('输出目录已更新', 'success');
        } catch (err) {
            notify(err.message, 'error');
        }
    }

    async act({ id, action }) {
        const task = store.get().tasks.find((item) => item.id === id);
        if (!task) return;
        if (!task.libraryId) {
            notify('文件库未记录该产物，无法定位', 'warning');
            return;
        }
        try {
            if (action === 'reveal') await api.libraryReveal(task.libraryId);
            else if (action === 'open') await api.libraryOpen(task.libraryId);
        } catch (err) {
            notify(err.message, 'error');
        }
    }

    onEvent(event) {
        if (!event) return;
        if (event.type === 'enqueue') {
            this.addEntries(event.files);
            if (event.unsupported && event.unsupported.length > 0) notify(`已忽略 ${event.unsupported.length} 个不支持的文件`, 'warning');
            if (location.hash !== '#/convert') location.hash = '#/convert';
            return;
        }
        if (event.status === 'finished') {
            store.set((state) => ({ run: null, libraryVersion: state.libraryVersion + 1 }));
            const summary = event.summary || {};
            const parts = [`成功 ${summary.succeeded || 0}`, `失败 ${summary.failed || 0}`];
            if (summary.cancelled) parts.push(`取消 ${summary.cancelled}`);
            notify(`转换结束：${parts.join('，')}`, summary.failed ? 'warning' : 'success');
            return;
        }
        if (!event.taskId) return;
        const patch = { status: event.status, phase: event.phase || '', pct: event.pct || 0 };
        if (event.error) patch.error = event.error;
        if (event.result) patch.result = event.result;
        if (event.libraryId) patch.libraryId = event.libraryId;
        updateTask(event.taskId, patch);
    }
}

customElements.define('mf-convert-page', MfConvertPage);
