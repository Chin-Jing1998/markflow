/**
 * <mf-library-page>：文件库页 = 工具栏（搜索、排序、刷新、迁移）+ 分面侧栏 + 记录列表。
 * 记录操作：收藏、标签、定位、打开、重新转换、删除（仅删记录 / 连同产物移到废纸篓）；
 * 托管迁移先 dryRun 预览再执行。文件库模块未就绪时显示提示。
 */
import { store, addTasks } from '../store.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { escapeHtml, escapeAttr, formatDate, targetLabel, typeLabel } from '../dom.js';
import { notify } from './mf-toast.js';
import './mf-facets.js';

const SORTS = Object.freeze([['createdAt', '按创建时间'], ['updatedAt', '按更新时间'], ['title', '按标题']]);
const NOT_READY_RE = /文件库模块未就绪/;

class MfLibraryPage extends HTMLElement {
    constructor() {
        super();
        this.state = {
            query: '', facets: {}, sort: 'createdAt', order: 'desc',
            items: [], total: 0, facetData: null, busy: false, ready: true, error: '',
            editingTags: null, confirming: null, plan: null, planResult: null, migrating: false,
        };
        this.seenLibraryVersion = 0;
    }

    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.innerHTML = `
            <header class="page-header">
                <h1>文件库</h1>
                <div class="page-header-actions">
                    <label class="search"><span class="search-icon">${icon('search')}</span><input type="search" placeholder="搜索标题、名称、来源或标签" data-role="query" spellcheck="false"></label>
                    <select class="select" data-role="sort" aria-label="排序">${SORTS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>
                    <button class="icon-btn" type="button" data-action="order" title="切换升降序" aria-label="切换升降序">${icon('move')}</button>
                    <button class="icon-btn" type="button" data-action="refresh" title="刷新" aria-label="刷新">${icon('refresh')}</button>
                    <button class="btn btn-secondary btn-small" type="button" data-action="migrate">${icon('move')}迁移到托管目录</button>
                </div>
            </header>
            <div class="page-body page-layout library-body">
                <aside class="page-sidebar library-facets" aria-label="文件库筛选">
                    <div class="page-sidebar-heading">筛选</div>
                    <mf-facets></mf-facets>
                </aside>
                <section class="library-main">
                    <div class="library-status"></div>
                    <div class="migration-panel" hidden></div>
                    <ul class="record-list" role="list"></ul>
                </section>
            </div>`;
        this.querySelector('[data-role="query"]').addEventListener('input', (event) => {
            this.state.query = event.target.value;
            clearTimeout(this.debounce);
            this.debounce = setTimeout(() => this.load(), 250);
        });
        this.querySelector('[data-role="sort"]').addEventListener('change', (event) => {
            this.state.sort = event.target.value;
            this.load();
        });
        this.addEventListener('mf-facet-change', (event) => {
            const { key, value } = event.detail;
            const facets = { ...this.state.facets };
            if (value === null || value === undefined) delete facets[key];
            else facets[key] = value;
            this.state.facets = facets;
            this.load();
        });
        this.addEventListener('click', (event) => this.onClick(event));
        this.unsubscribe = store.subscribe((state) => {
            if (state.route === 'library' && state.libraryVersion !== this.seenLibraryVersion) {
                this.seenLibraryVersion = state.libraryVersion;
                this.load();
            }
        });
        this.renderStatus();
    }

    disconnectedCallback() {
        if (this.unsubscribe) this.unsubscribe();
    }

    /** 路由切换到本页时由 app.js 调用 */
    refresh() {
        this.seenLibraryVersion = store.get().libraryVersion;
        this.load();
    }

    async load() {
        this.state.busy = true;
        this.renderStatus();
        try {
            const params = { query: this.state.query, facets: this.state.facets, sort: this.state.sort, order: this.state.order };
            const result = await api.libraryList(params);
            this.state.items = result.items;
            this.state.total = result.total;
            this.state.facetData = result.facets;
            this.state.ready = true;
            this.state.error = '';
        } catch (err) {
            this.state.ready = !NOT_READY_RE.test(err.message);
            this.state.error = err.message;
            this.state.items = [];
            this.state.total = 0;
            this.state.facetData = null;
        } finally {
            this.state.busy = false;
        }
        this.render();
    }

    renderStatus() {
        const status = this.querySelector('.library-status');
        if (!status) return;
        if (!this.state.ready) {
            status.textContent = '文件库模块未就绪';
            status.dataset.kind = 'error';
            return;
        }
        if (this.state.error) {
            status.textContent = this.state.error;
            status.dataset.kind = 'error';
            return;
        }
        status.dataset.kind = 'info';
        status.textContent = this.state.busy ? '加载中…' : `${this.state.total} 条记录`;
    }

    render() {
        this.renderStatus();
        this.querySelector('mf-facets').data = { facets: this.state.facetData, selected: this.state.facets };
        const list = this.querySelector('.record-list');
        if (this.state.items.length === 0) {
            list.innerHTML = this.state.ready && !this.state.error ? '<li class="record-empty">没有匹配的记录：转换完成的产物会自动登记到这里</li>' : '';
        } else {
            list.innerHTML = this.state.items.map((record) => this.rowTemplate(record)).join('');
        }
        this.renderMigration();
    }

    rowTemplate(record) {
        const source = record.source || {};
        const chips = [
            `<span class="chip chip-target">${escapeHtml(targetLabel(record.target))}</span>`,
            `<span class="chip">${escapeHtml(typeLabel(source.type))}</span>`,
            record.managed ? '<span class="chip chip-managed">托管</span>' : '',
            record.missing ? '<span class="chip chip-missing">产物缺失</span>' : '',
        ].join('');
        const tags = (record.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
        const editing = this.state.editingTags === record.id;
        const confirming = this.state.confirming === record.id;
        const warnings = Array.isArray(record.warnings) ? record.warnings.length : 0;
        return `
            <li class="record${record.missing ? ' is-missing' : ''}" data-id="${escapeAttr(record.id)}">
                <div class="record-main">
                    <div class="record-title">
                        <button class="star${record.favorite ? ' is-on' : ''}" type="button" data-action="favorite" title="${record.favorite ? '取消收藏' : '收藏'}" aria-label="收藏">${icon('star')}</button>
                        <span class="title">${escapeHtml(record.title || record.name)}</span>${chips}
                    </div>
                    <div class="record-meta">
                        <span>${escapeHtml(source.value || '')}</span>
                        <span>${escapeHtml(formatDate(record.createdAt))}</span>
                        ${record.imagesCount ? `<span>${record.imagesCount} 张图片</span>` : ''}
                        ${warnings ? `<span class="record-warn" title="${escapeAttr((record.warnings || []).join('\n'))}">${warnings} 条提示</span>` : ''}
                    </div>
                    <div class="record-path">${escapeHtml(record.outputPath || '')}</div>
                    <div class="record-tags">${tags}<button class="link-btn" type="button" data-action="edit-tags">${icon('tag')}${tags ? '编辑标签' : '添加标签'}</button></div>
                    <div class="record-editor" ${editing ? '' : 'hidden'}>
                        <input type="text" class="input" data-role="tags" value="${escapeAttr((record.tags || []).join(', '))}" placeholder="标签以逗号分隔" spellcheck="false">
                        <button class="btn btn-small btn-primary" type="button" data-action="save-tags">保存</button>
                        <button class="btn btn-small btn-secondary" type="button" data-action="cancel-tags">取消</button>
                    </div>
                    <div class="record-confirm" ${confirming ? '' : 'hidden'}>
                        <span>删除这条记录？</span>
                        <button class="btn btn-small btn-secondary" type="button" data-action="remove-index">仅删记录</button>
                        <button class="btn btn-small btn-danger" type="button" data-action="remove-trash">连同产物移到废纸篓</button>
                        <button class="btn btn-small btn-secondary" type="button" data-action="cancel-remove">取消</button>
                    </div>
                </div>
                <div class="record-actions">
                    <button class="btn btn-small btn-secondary" type="button" data-action="reveal" ${record.missing ? 'disabled' : ''}>${icon('folderOpen')}定位</button>
                    <button class="btn btn-small btn-secondary" type="button" data-action="open" ${record.missing ? 'disabled' : ''}>${icon('open')}打开</button>
                    <button class="btn btn-small btn-secondary" type="button" data-action="reconvert">${icon('refresh')}重新转换</button>
                    <button class="icon-btn icon-btn-sm" type="button" data-action="remove" title="删除" aria-label="删除">${icon('trash')}</button>
                </div>
            </li>`;
    }

    renderMigration() {
        const panel = this.querySelector('.migration-panel');
        const { plan, planResult, migrating } = this.state;
        if (!plan && !planResult) {
            panel.hidden = true;
            panel.innerHTML = '';
            return;
        }
        panel.hidden = false;
        if (planResult) {
            const { moved, failed } = planResult;
            panel.innerHTML = `
                <h3>迁移结果</h3>
                <p>已迁移 ${moved.length} 条${failed.length ? `，失败 ${failed.length} 条` : ''}。</p>
                ${failed.length ? `<ul class="plan-list">${failed.map((item) => `<li class="is-conflict">${escapeHtml(item.from)}<br><small>${escapeHtml(item.error)}</small></li>`).join('')}</ul>` : ''}
                <div class="plan-actions"><button class="btn btn-small btn-secondary" type="button" data-action="close-plan">关闭</button></div>`;
            return;
        }
        const moves = plan.moves.map((move) => `<li${move.conflict ? ' class="is-conflict"' : ''}>${escapeHtml(move.from)}<br>→ ${escapeHtml(move.to)}${move.conflict ? '<small>（同名，已加后缀）</small>' : ''}</li>`).join('');
        const skipped = plan.skipped.map((item) => `<li><small>${escapeHtml(item.reason)}</small></li>`).join('');
        panel.innerHTML = `
            <h3>迁移预览（dryRun）</h3>
            <p>将移动 ${plan.moves.length} 条产物到托管目录，跳过 ${plan.skipped.length} 条。</p>
            ${moves ? `<ul class="plan-list">${moves}</ul>` : ''}
            ${skipped ? `<details><summary>跳过明细</summary><ul class="plan-list">${skipped}</ul></details>` : ''}
            <div class="plan-actions">
                <button class="btn btn-small btn-primary" type="button" data-action="run-plan" ${plan.moves.length === 0 || migrating ? 'disabled' : ''}>${migrating ? '迁移中…' : '执行迁移'}</button>
                <button class="btn btn-small btn-secondary" type="button" data-action="close-plan">取消</button>
            </div>`;
    }

    async onClick(event) {
        const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
        if (!button || button.closest('mf-facets')) return;
        const { action } = button.dataset;
        const row = button.closest('li.record');
        const id = row ? row.dataset.id : null;
        const record = id ? this.state.items.find((item) => item.id === id) : null;
        try {
            switch (action) {
                case 'refresh': await this.load(); break;
                case 'order':
                    this.state.order = this.state.order === 'desc' ? 'asc' : 'desc';
                    await this.load();
                    break;
                case 'migrate': await this.previewMigration(); break;
                case 'run-plan': await this.runMigration(); break;
                case 'close-plan':
                    this.state.plan = null;
                    this.state.planResult = null;
                    this.renderMigration();
                    break;
                case 'favorite':
                    if (record) { await api.libraryUpdate(id, { favorite: !record.favorite }); await this.load(); }
                    break;
                case 'edit-tags':
                    this.state.editingTags = id;
                    this.render();
                    this.querySelector(`li[data-id="${CSS.escape(id)}"] input[data-role="tags"]`).focus();
                    break;
                case 'cancel-tags':
                    this.state.editingTags = null;
                    this.render();
                    break;
                case 'save-tags': {
                    const input = row.querySelector('input[data-role="tags"]');
                    const tags = input.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
                    await api.libraryUpdate(id, { tags });
                    this.state.editingTags = null;
                    notify('标签已更新', 'success');
                    await this.load();
                    break;
                }
                case 'reveal': await api.libraryReveal(id); break;
                case 'open': await api.libraryOpen(id); break;
                case 'reconvert': await this.reconvert(id); break;
                case 'remove':
                    this.state.confirming = id;
                    this.render();
                    break;
                case 'cancel-remove':
                    this.state.confirming = null;
                    this.render();
                    break;
                case 'remove-index':
                case 'remove-trash': {
                    const result = await api.libraryRemove(id, action === 'remove-trash');
                    this.state.confirming = null;
                    notify(result.trashed ? '记录已删除，产物已移到废纸篓' : '记录已删除', 'success');
                    await this.load();
                    break;
                }
                default: break;
            }
        } catch (err) {
            notify(err.message, 'error', 6000);
        }
    }

    async reconvert(id) {
        const res = await api.libraryReconvert(id);
        addTasks(res.tasks.map((task) => ({
            id: task.taskId,
            ...(task.input && /^https?:\/\//i.test(task.input) ? { url: task.input } : { path: task.input }),
            name: task.name, type: task.type, target: task.target, status: 'queued', runId: res.runId,
        })));
        store.set({ run: { runId: res.runId, outputDir: res.outputDir } });
        notify('已加入转换队列', 'info');
        location.hash = '#/convert';
    }

    async previewMigration() {
        const res = await api.libraryMigrate(true);
        this.state.plan = res.plan;
        this.state.planResult = null;
        this.renderMigration();
    }

    async runMigration() {
        this.state.migrating = true;
        this.renderMigration();
        try {
            const res = await api.libraryMigrate(false);
            this.state.planResult = res.result;
            this.state.plan = null;
            notify(`迁移完成：${res.result.moved.length} 条`, res.result.failed.length ? 'warning' : 'success');
            await this.load();
        } finally {
            this.state.migrating = false;
            this.renderMigration();
        }
    }
}

customElements.define('mf-library-page', MfLibraryPage);
