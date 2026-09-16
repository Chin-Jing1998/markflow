/**
 * <mf-md-editor>：Markdown 源码编辑器 = 格式工具栏 + textarea + 可收起的实时渲染预览（方案 B）
 *
 * 形态：源码编辑（非所见即所得），md 原文逐字保留；写入一律经 focus → setSelectionRange →
 * document.execCommand('insertText')，保留浏览器原生撤销栈（⌘Z），execCommand 失败时退回 setRangeText 并补发 input。
 * CRLF 文件：textarea 会把换行归一为 LF，value 取值时按载入时的换行风格还原。
 *
 * 结构：.md-editor[data-preview] > .md-editor-toolbar[role=toolbar]（按钮只用 data-cmd，不用宿主页面点击委托所认的
 * 动作 / 页签属性，以免被截走）+ .md-editor-banner（冲突 / 失败：覆盖保存、重新载入）+ .md-editor-linkbar
 * （文字、网址两个输入框；Electron 不支持 window.prompt）+ .md-editor-body（查找高亮层 .md-editor-find-layer + textarea +
 * .md-editor-preview）。工具栏按 Apple 式分组（组间分隔线），栏窄时从末组起收进「…」更多菜单。
 *
 * 查找高亮（镜像层）：textarea 下垫一层镜像，排版与 textarea 共用 CSS 规则（含 --doc-zoom 缩放），文字透明、命中处以
 * <mark> 涂色（全部命中浅色，与选区重合的当前命中深色），查找期间 textarea 改透明底；镜像文字块宽度取 textarea.clientWidth
 * （扣除滚动条）、位移在 scroll 事件里跟随 scrollTop，尺寸变化由 ResizeObserver 重对齐。文字仍在原生 textarea 中编辑，
 * 撤销栈、输入法与自动保存不受影响。输入后按帧合并重建（超长文本停手后重建）；编辑区被隐藏时自动撤掉。
 * 重建后或当前命中切换后派发 mf-md-find，顶部栏据此边改边更新查找计数。
 *
 * 快捷键（macOS 用 ⌘，其他平台用 Ctrl）：⌘B 加粗、⌘I 斜体、⌘U 下划线、⌘K 链接、⌘⇧X 删除线、⌘⌥0–6 标题级别、
 * ⌘S 立即保存（挂在编辑器根元素上，工具栏与链接栏里同样生效）。
 *
 * 预览：输入停止 300 ms（文本超过 1 MB 时 1 s）后调 mf:md:render，按请求序号丢弃过期回包；新帧先隐藏装载，
 * load 后替换旧帧并按 textarea 的滚动比例恢复位置。中文输入法组合期间不排程渲染与保存。
 * 保存：输入停止 1 s 自动保存，⌘S 立即保存；先派发可取消的 mf-md-save { reason: 'autosave'|'shortcut'|'flush'|'force' }，
 * 宿主 preventDefault 即跳过（对比预览未导出时 ⌘S 改为导出），否则调 mf:md:save；同一时刻只有一个保存在跑，
 * 结束后若又有保存请求则再存一次。
 *
 * 事件（均冒泡）：mf-md-change { dirty }（脏状态翻转时）、mf-md-status { state, message, label }、
 * mf-md-saved { text, result }、mf-md-rendered { html }、mf-md-reload-request、
 * mf-md-find { query, total, current, sessionId }（查找高亮重建或当前命中切换后；current 为 0 起下标，无当前命中为 -1；
 * 编辑区不可见时与 clearFind（含查询串清空）时不派发）。
 * API：sessionId、previewVisible、showStatus、setContent(text, { html?, status? })、value、dirty、modified、saving、
 * status、lastHtml、flush(): Promise<boolean>、renderNow()、markExported()、focusEditor()、dispose()；
 * 查找高亮 highlightFind(query, matches?)、endFind()（撤掉高亮并聚焦编辑区、保留选区）、clearFind()（只撤掉高亮）。
 * disconnectedCallback 只摘全局监听，不清编辑状态（宿主可把编辑器挪到别处再挂回）。
 */
import { api, platform } from '../api.js';
import { icon } from '../icons.js';
import { escapeHtml, escapeAttr, createViewFrame } from '../dom.js';
import {
    toggleInline, lineStyleAt, setHeading, toggleLinePrefix, insertBlock, buildTable, insertFootnote,
    buildLink, buildImageTag, TABLE_TEMPLATE,
} from '../md-format.mjs';
import { findMatches, splitByMatches } from '../doc-tools.mjs';
import { notify } from './mf-toast.js';

const RENDER_DELAY_MS = 300;
const RENDER_DELAY_LARGE_MS = 1000;
const LARGE_TEXT_CHARS = 1024 * 1024;
const SAVE_DELAY_MS = 1000;
const MAX_IMAGE_WIDTH = 600;
const TABLE_GRID = Object.freeze({ rows: 8, cols: 8 });
const POPOVER_GAP = 4;
const POPOVER_MARGIN = 8;
// 查找高亮层：文本不超过 FIND_LIVE_CHARS 时，输入后的下一帧即按新文本重建；更长时输入期间先撤下高亮（旧位置已错开），
// 停手 FIND_IDLE_MS 后再重建，免得逐键全量重排（实测重建约 0.25 ms / 千字符，32K 字符约 8 ms）
const FIND_LIVE_CHARS = 32 * 1024;
const FIND_IDLE_MS = 300;
const IS_MAC = platform === 'darwin';
const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl+';

export const MD_STATUS_LABELS = Object.freeze({
    idle: '', saved: '已保存', dirty: '未保存', saving: '正在保存…', staged: '已暂存（未导出）', failed: '保存失败', conflict: '文件已在外部修改',
});

const HEADING_OPTIONS = Object.freeze([['0', '正文'], ['1', 'H1'], ['2', 'H2'], ['3', 'H3'], ['4', 'H4'], ['5', 'H5'], ['6', 'H6']]);

const TOOL_GROUPS = Object.freeze([
    { key: 'inline', items: [
        { cmd: 'bold', icon: 'bold', label: '加粗', keys: `${MOD_LABEL}B` },
        { cmd: 'italic', icon: 'italic', label: '斜体', keys: `${MOD_LABEL}I` },
        { cmd: 'underline', icon: 'underline', label: '下划线', keys: `${MOD_LABEL}U` },
        { cmd: 'strike', icon: 'strikethrough', label: '删除线', keys: IS_MAC ? '⌘⇧X' : 'Ctrl+Shift+X' },
        { cmd: 'code', icon: 'code', label: '行内代码' },
    ] },
    { key: 'block', items: [
        { cmd: 'codeBlock', icon: 'codeBlock', label: '代码块' },
        { cmd: 'quote', icon: 'quote', label: '引用' },
    ] },
    { key: 'list', items: [
        { cmd: 'bullet', icon: 'listBullet', label: '无序列表' },
        { cmd: 'ordered', icon: 'listOrdered', label: '有序列表' },
        { cmd: 'task', icon: 'listTask', label: '任务列表' },
    ] },
    { key: 'insert', items: [
        { cmd: 'table', icon: 'table', label: '表格' },
        { cmd: 'link', icon: 'link', label: '链接', keys: `${MOD_LABEL}K` },
        { cmd: 'image', icon: 'image', label: '图片' },
        { cmd: 'hr', icon: 'horizontalRule', label: '分隔线' },
        { cmd: 'footnote', icon: 'footnote', label: '脚注' },
    ] },
]);

const titleOf = (item) => (item.keys ? `${item.label}（${item.keys}）` : item.label);

/** 在场编辑器登记表：窗口卸载前若有未保存、正在保存或仅暂存的修改，先 flush 并拦下卸载（主进程随后弹确认框） */
const liveEditors = new Set();
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', (event) => {
        const pending = [...liveEditors].filter((editor) => editor.needsProtection());
        if (pending.length === 0) return;
        for (const editor of pending) editor.flush().catch(() => undefined);
        event.preventDefault();
        event.returnValue = '';
    });
}

function fenceFor(text) {
    const longest = Math.max(0, ...(String(text).match(/`{3,}/g) || []).map((run) => run.length));
    return '`'.repeat(Math.max(3, longest + 1));
}

class MfMdEditor extends HTMLElement {
    constructor() {
        super();
        this._sessionId = null;
        this._previewVisible = true;
        this._showStatus = true;
        /** 实时预览帧的外观（dom.createViewFrame 的 appearance）：由宿主按所在栏设定，缺省不注入 */
        this.frameAppearance = null;
        this.version = 0;
        this.savedVersion = 0;
        this.contentEpoch = 0;
        this.renderSeq = 0;
        this.frameToken = 0;
        this.initialValue = '';
        this.lineEnding = '\n';
        this.lastHtml = '';
        this.mountedHtml = null;
        this.lastDirty = false;
        this.composing = false;
        this.blocked = false;
        this.lastSaveStaged = false;
        this.savingPromise = null;
        this.saveAgainReason = null;
        this.saveTimer = null;
        this.renderTimer = null;
        this.statusState = 'idle';
        this.statusMessage = '';
        this.linkRange = null;
        this.overflowGroups = [];
        // 查找高亮：查询串、按当前文本算出的命中、各命中对应的 <mark>、当前命中下标；findStale 表示镜像层待按新文本重建
        this.findQuery = '';
        this.findMatchList = [];
        this.findMarks = [];
        this.findCurrent = -1;
        this.findStale = false;
        this.findFrame = null;
        this.findSyncFrame = null;
        this.findTimer = null;
        this.findResizeObserver = null;
        this.onDocumentSelection = () => {
            this.scheduleHeadingSync();
            this.scheduleFindSync();
        };
        this.onDocumentPointer = (event) => this.closeMenusOutside(event);
    }

    connectedCallback() {
        this.ensureBuilt();
        document.addEventListener('selectionchange', this.onDocumentSelection);
        document.addEventListener('pointerdown', this.onDocumentPointer, true);
        if (typeof ResizeObserver === 'function') {
            this.resizeObserver = this.resizeObserver || new ResizeObserver(() => this.layoutToolbar());
            this.resizeObserver.observe(this);
        }
        this.layoutToolbar();
    }

    disconnectedCallback() {
        document.removeEventListener('selectionchange', this.onDocumentSelection);
        document.removeEventListener('pointerdown', this.onDocumentPointer, true);
        if (this.resizeObserver) this.resizeObserver.disconnect();
    }

    // ---------- 结构 ----------

    ensureBuilt() {
        if (this.built) return;
        this.built = true;
        this.classList.add('md-editor');
        this.dataset.preview = this._previewVisible ? 'shown' : 'hidden';
        const groups = TOOL_GROUPS.map((group) => `
            <div class="md-editor-group" data-group="${group.key}">
                <span class="md-editor-sep" aria-hidden="true"></span>
                ${group.items.map((item) => `<button class="icon-btn icon-btn-sm" type="button" data-cmd="${item.cmd}" title="${escapeAttr(titleOf(item))}" aria-label="${escapeAttr(item.label)}">${icon(item.icon)}</button>`).join('')}
            </div>`).join('');
        const cells = [];
        for (let row = 1; row <= TABLE_GRID.rows; row += 1) {
            for (let col = 1; col <= TABLE_GRID.cols; col += 1) {
                cells.push(`<button class="md-editor-table-cell" type="button" tabindex="-1" data-cmd="table-insert" data-rows="${row}" data-cols="${col}" aria-label="${row} 行 × ${col} 列"></button>`);
            }
        }
        this.innerHTML = `
            <div class="md-editor-toolbar" role="toolbar" aria-label="Markdown 格式">
                <select class="select select-slim md-editor-heading" data-cmd="heading" aria-label="标题级别" title="标题级别（${IS_MAC ? '⌘⌥0–6' : 'Ctrl+Alt+0–6'}）">
                    ${HEADING_OPTIONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
                </select>
                ${groups}
                <span class="md-editor-spacer"></span>
                <span class="md-editor-status" data-role="status" data-state="idle" aria-live="polite"></span>
                <button class="icon-btn icon-btn-sm md-editor-more" type="button" data-cmd="more" title="更多格式" aria-label="更多格式" aria-haspopup="menu" aria-expanded="false" hidden>${icon('more')}</button>
                <button class="icon-btn icon-btn-sm" type="button" data-cmd="toggle-preview" title="显示或隐藏实时预览" aria-label="实时预览" aria-pressed="${this._previewVisible}">${icon('preview')}</button>
            </div>
            <div class="md-editor-menu" data-role="more-menu" role="menu" aria-label="更多格式" hidden></div>
            <div class="md-editor-menu md-editor-table-picker" data-role="table-picker" role="dialog" aria-label="插入表格" hidden>
                <div class="md-editor-table-grid" data-role="table-grid">${cells.join('')}</div>
                <div class="md-editor-table-label" data-role="table-label">${TABLE_TEMPLATE.rows} 行 × ${TABLE_TEMPLATE.cols} 列</div>
                <button class="md-editor-menu-item" type="button" data-cmd="table-default">插入 ${TABLE_TEMPLATE.rows} × ${TABLE_TEMPLATE.cols} 表格</button>
            </div>
            <div class="md-editor-banner" data-role="banner" role="alert" hidden>
                <span class="md-editor-banner-text" data-role="banner-text"></span>
                <button class="btn btn-secondary btn-small" type="button" data-cmd="force-save">覆盖保存</button>
                <button class="btn btn-secondary btn-small" type="button" data-cmd="reload">重新载入</button>
            </div>
            <div class="md-editor-linkbar" data-role="linkbar" hidden>
                <input class="input input-slim md-editor-link-text" type="text" data-role="link-text" placeholder="链接文字" aria-label="链接文字" spellcheck="false">
                <input class="input input-slim md-editor-link-url" type="text" data-role="link-url" placeholder="网址，例如 https://example.com" aria-label="链接网址" spellcheck="false">
                <button class="btn btn-primary btn-small" type="button" data-cmd="link-apply">插入</button>
                <button class="btn btn-secondary btn-small" type="button" data-cmd="link-cancel">取消</button>
            </div>
            <div class="md-editor-body">
                <div class="md-editor-find-layer" data-role="find-layer" aria-hidden="true" hidden><div class="md-editor-find-text" data-role="find-text"></div></div>
                <textarea class="md-editor-input" spellcheck="false" autocomplete="off" aria-label="Markdown 源码"></textarea>
                <div class="md-editor-preview" data-role="preview" aria-label="实时预览">
                    <p class="md-editor-preview-error" data-role="preview-error" hidden></p>
                </div>
            </div>`;
        this.toolbar = this.querySelector('.md-editor-toolbar');
        this.textarea = this.querySelector('.md-editor-input');
        this.findLayer = this.querySelector('[data-role="find-layer"]');
        this.findText = this.querySelector('[data-role="find-text"]');
        this.previewHost = this.querySelector('[data-role="preview"]');
        this.headingSelect = this.querySelector('[data-cmd="heading"]');
        this.statusEl = this.querySelector('[data-role="status"]');
        this.statusEl.hidden = !this._showStatus;
        this.bindEvents();
        liveEditors.add(this);
    }

    bindEvents() {
        const ta = this.textarea;
        ta.addEventListener('input', (event) => this.onInput(event));
        ta.addEventListener('compositionstart', () => { this.composing = true; });
        ta.addEventListener('compositionend', () => {
            this.composing = false;
            this.scheduleRender();
            this.scheduleSave();
            this.scheduleHeadingSync();
        });
        ta.addEventListener('scroll', () => this.scheduleScrollSync(), { passive: true });
        // 查找高亮层随编辑区滚动：在 scroll 事件里直接改位移，与本帧绘制对齐
        ta.addEventListener('scroll', () => this.syncFindScroll(), { passive: true });
        for (const type of ['keyup', 'mouseup', 'focus']) ta.addEventListener(type, () => this.scheduleHeadingSync());
        this.addEventListener('keydown', (event) => this.onKeydown(event));
        this.addEventListener('click', (event) => this.onClick(event));
        this.addEventListener('change', (event) => {
            if (event.target === this.headingSelect) this.applyEdit(setHeading(this.state(), Number(this.headingSelect.value)));
        });
        // 工具栏按钮按下时不抢走 textarea 的焦点，选区与光标保持原位
        this.toolbar.addEventListener('mousedown', (event) => {
            if (event.target instanceof Element && event.target.closest('button[data-cmd]')) event.preventDefault();
        });
        const grid = this.querySelector('[data-role="table-grid"]');
        grid.addEventListener('pointerover', (event) => {
            const cell = event.target instanceof Element ? event.target.closest('[data-rows]') : null;
            if (cell) this.highlightTableCells(Number(cell.dataset.rows), Number(cell.dataset.cols));
        });
        for (const input of this.querySelectorAll('[data-role="link-text"], [data-role="link-url"]')) {
            input.addEventListener('keydown', (event) => {
                if (event.isComposing) return;
                if (event.key === 'Enter') {
                    event.preventDefault();
                    this.applyLink();
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    this.closeLinkBar(true);
                }
            });
        }
    }

    // ---------- 属性 ----------

    get sessionId() {
        return this._sessionId;
    }

    set sessionId(value) {
        this._sessionId = value ? String(value) : null;
    }

    get previewVisible() {
        return this._previewVisible;
    }

    set previewVisible(value) {
        this._previewVisible = Boolean(value);
        this.dataset.preview = this._previewVisible ? 'shown' : 'hidden';
        const toggle = this.querySelector('[data-cmd="toggle-preview"]');
        if (toggle) toggle.setAttribute('aria-pressed', String(this._previewVisible));
        if (this._previewVisible && this.built) {
            this.mountedHtml = null;
            this.mountPreview();
        }
        this.layoutToolbar();
    }

    get showStatus() {
        return this._showStatus;
    }

    set showStatus(value) {
        this._showStatus = Boolean(value);
        if (this.statusEl) this.statusEl.hidden = !this._showStatus;
        this.layoutToolbar();
    }

    get value() {
        const text = this.textarea ? this.textarea.value : '';
        return this.lineEnding === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
    }

    get dirty() {
        return this.version !== this.savedVersion;
    }

    /** 与 setContent 载入的文本相比是否有改动（不论是否已保存 / 暂存） */
    get modified() {
        return Boolean(this.textarea) && this.textarea.value !== this.initialValue;
    }

    get saving() {
        return Boolean(this.savingPromise);
    }

    get status() {
        return this.statusState;
    }

    needsProtection() {
        return this.dirty || this.saving || this.statusState === 'staged';
    }

    // ---------- 内容 ----------

    setContent(text, { html = null, status = 'saved' } = {}) {
        this.ensureBuilt();
        const raw = String(text == null ? '' : text);
        this.lineEnding = /\r\n/.test(raw) ? '\r\n' : '\n';
        this.contentEpoch += 1;
        this.clearTimers();
        this.textarea.value = raw;
        this.initialValue = this.textarea.value;
        this.version = 0;
        this.savedVersion = 0;
        this.blocked = false;
        this.lastSaveStaged = false;
        this.saveAgainReason = null;
        this.lastDirty = false;
        this.hideBanner();
        this.closeLinkBar(false);
        this.closeMenus();
        this.clearFind();
        this.lastHtml = typeof html === 'string' ? html : '';
        this.mountedHtml = null;
        this.setStatus(status);
        this.emit('mf-md-change', { dirty: false });
        this.scheduleHeadingSync();
        if (this.lastHtml) this.mountPreview();
        this.renderNow();
    }

    focusEditor() {
        if (this.textarea) this.textarea.focus();
    }

    state() {
        const ta = this.textarea;
        return { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
    }

    /** 按 md-format 的编辑结果改写 textarea：execCommand 保留撤销栈，失败时退回 setRangeText 并补发 input */
    applyEdit(edit) {
        if (!edit || !this.textarea) return;
        const ta = this.textarea;
        ta.focus();
        if (ta.value.slice(edit.from, edit.to) !== edit.text) {
            ta.setSelectionRange(edit.from, edit.to);
            let inserted = false;
            try {
                inserted = document.execCommand('insertText', false, edit.text);
            } catch (err) {
                inserted = false;
            }
            if (!inserted) {
                ta.setRangeText(edit.text, edit.from, edit.to, 'end');
                ta.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
        ta.setSelectionRange(edit.selStart, edit.selEnd);
        this.scheduleHeadingSync();
    }

    onInput(event) {
        this.version += 1;
        this.syncDirty();
        // 查找高亮不受输入法组合影响：组合中的文字已在 value 里，高亮随之重排
        this.scheduleFindRefresh();
        if (this.composing || (event && event.isComposing)) return;
        this.scheduleRender();
        this.scheduleSave();
    }

    syncDirty() {
        const dirty = this.dirty;
        if (dirty !== this.lastDirty) {
            this.lastDirty = dirty;
            this.emit('mf-md-change', { dirty });
        }
        if (dirty && !this.blocked && !this.savingPromise && this.statusState !== 'dirty') this.setStatus('dirty');
    }

    // ---------- 命令 ----------

    onClick(event) {
        const target = event.target instanceof Element ? event.target.closest('[data-cmd]') : null;
        if (!target || !this.contains(target) || target === this.headingSelect) return;
        event.preventDefault();
        this.runCommand(target.dataset.cmd, target);
    }

    runCommand(cmd, source = null) {
        const inMenu = source && source.closest('[data-role="more-menu"]');
        if (inMenu) this.closeMenus();
        const inline = { bold: ['**', '**'], italic: ['*', '*'], underline: ['<u>', '</u>'], strike: ['~~', '~~'], code: ['`', '`'] };
        if (inline[cmd]) {
            this.applyEdit(toggleInline(this.state(), inline[cmd][0], inline[cmd][1]));
            return;
        }
        if (['quote', 'bullet', 'ordered', 'task'].includes(cmd)) {
            this.applyEdit(toggleLinePrefix(this.state(), cmd));
            return;
        }
        const actions = {
            codeBlock: () => this.insertCodeBlock(),
            hr: () => this.applyEdit(insertBlock(this.state(), '---')),
            footnote: () => this.applyEdit(insertFootnote(this.textarea.value, this.textarea.selectionEnd)),
            table: () => this.toggleTablePicker(inMenu ? null : source),
            'table-insert': () => this.insertTable(Number(source.dataset.rows), Number(source.dataset.cols)),
            'table-default': () => this.insertTable(TABLE_TEMPLATE.rows, TABLE_TEMPLATE.cols),
            link: () => this.openLinkBar(),
            'link-apply': () => this.applyLink(),
            'link-cancel': () => this.closeLinkBar(true),
            image: () => this.insertImage(),
            more: () => this.toggleMoreMenu(source),
            'toggle-preview': () => { this.previewVisible = !this.previewVisible; },
            'force-save': () => this.forceSave(),
            reload: () => this.emit('mf-md-reload-request', { sessionId: this._sessionId }),
        };
        if (actions[cmd]) actions[cmd]();
    }

    onKeydown(event) {
        if (event.key === 'Escape' && this.closeMenus()) {
            event.preventDefault();
            return;
        }
        const mod = IS_MAC ? event.metaKey : event.ctrlKey;
        if (!mod || event.isComposing) return;
        const key = String(event.key || '').toLowerCase();
        if (key === 's' && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            this.requestSave('shortcut');
            return;
        }
        if (event.target !== this.textarea) return;
        if (event.altKey && !event.shiftKey && /^Digit[0-6]$/.test(event.code)) {
            event.preventDefault();
            this.applyEdit(setHeading(this.state(), Number(event.code.slice(5))));
            return;
        }
        if (event.altKey) return;
        if (event.shiftKey) {
            if (key === 'x') {
                event.preventDefault();
                this.runCommand('strike');
            }
            return;
        }
        const shortcuts = { b: 'bold', i: 'italic', u: 'underline', k: 'link' };
        if (shortcuts[key]) {
            event.preventDefault();
            this.runCommand(shortcuts[key]);
        }
    }

    insertCodeBlock() {
        const { value, start, end } = this.state();
        const inner = value.slice(start, end).replace(/\n$/, '');
        const fence = fenceFor(inner);
        const head = `${fence}\n`;
        const block = `${head}${inner}\n${fence}`;
        this.applyEdit(insertBlock({ value, start, end }, block, { selectFrom: head.length, selectTo: head.length + inner.length }));
    }

    insertTable(rows, cols) {
        this.closeMenus();
        const table = buildTable(rows, cols);
        const firstCell = '列 1';
        this.applyEdit(insertBlock(this.state(), table, { selectFrom: 2, selectTo: 2 + firstCell.length }));
    }

    openLinkBar() {
        const ta = this.textarea;
        this.closeMenus();
        this.linkRange = { start: ta.selectionStart, end: ta.selectionEnd };
        const selected = ta.value.slice(this.linkRange.start, this.linkRange.end);
        const looksLikeUrl = /^https?:\/\/\S+$/i.test(selected.trim());
        const textInput = this.querySelector('[data-role="link-text"]');
        const urlInput = this.querySelector('[data-role="link-url"]');
        textInput.value = looksLikeUrl ? '' : selected.replace(/\s*\n\s*/g, ' ');
        urlInput.value = looksLikeUrl ? selected.trim() : '';
        this.querySelector('[data-role="linkbar"]').hidden = false;
        (textInput.value ? urlInput : textInput).focus();
    }

    applyLink() {
        const urlInput = this.querySelector('[data-role="link-url"]');
        const url = urlInput.value.trim();
        if (!url) {
            urlInput.focus();
            return;
        }
        const ta = this.textarea;
        const range = this.linkRange || { start: ta.selectionStart, end: ta.selectionEnd };
        const text = buildLink({ text: this.querySelector('[data-role="link-text"]').value, url });
        this.closeLinkBar(false);
        const caret = range.start + text.length;
        this.applyEdit({ from: range.start, to: range.end, text, selStart: caret, selEnd: caret });
    }

    closeLinkBar(refocus) {
        const bar = this.querySelector('[data-role="linkbar"]');
        if (!bar) return;
        const wasOpen = !bar.hidden;
        bar.hidden = true;
        const range = this.linkRange;
        this.linkRange = null;
        if (refocus && wasOpen && this.textarea) {
            this.textarea.focus();
            if (range) this.textarea.setSelectionRange(range.start, range.end);
        }
    }

    async insertImage() {
        if (!this._sessionId) return;
        const ta = this.textarea;
        const range = { start: ta.selectionStart, end: ta.selectionEnd };
        const epoch = this.contentEpoch;
        try {
            const result = await api.mdInsertImage(this._sessionId);
            if (!result || result.canceled || epoch !== this.contentEpoch) return;
            const width = Number(result.width) > 0 ? Math.min(Number(result.width), MAX_IMAGE_WIDTH) : null;
            const tag = buildImageTag({ src: result.relPath, width, alt: result.alt || '' });
            this.applyEdit(insertBlock({ value: ta.value, start: range.start, end: range.end }, tag));
        } catch (err) {
            notify(err && err.message ? err.message : '插入图片失败', 'error', 6000);
        }
    }

    // ---------- 标题下拉同步 ----------

    scheduleHeadingSync() {
        if (this.headingFrame) return;
        this.headingFrame = requestAnimationFrame(() => {
            this.headingFrame = null;
            if (!this.textarea || !this.headingSelect) return;
            if (document.activeElement !== this.textarea && this.headingSelect.matches(':focus')) return;
            const next = String(lineStyleAt(this.textarea.value, this.textarea.selectionStart).heading);
            if (this.headingSelect.value !== next) this.headingSelect.value = next;
        });
    }

    // ---------- 查找高亮 ----------

    /**
     * 查找高亮：镜像层标出 query 的全部命中，与编辑区选区正好重合的那处为当前命中；query 为空时撤掉高亮。
     * matches 为调用方按当前文本算好的 findMatches 结果（可省，省去重算）。无命中时镜像层隐藏但记住 query，
     * 其后编辑出命中时随之显出；编辑区被隐藏（尺寸归零）时自动撤掉，免得查找关闭后回到编辑页仍见旧高亮。
     */
    highlightFind(query, matches = null) {
        this.ensureBuilt();
        const needle = String(query == null ? '' : query);
        if (!needle) {
            this.clearFind();
            return;
        }
        if (!this.findQuery) this.observeFindResize();
        if (needle !== this.findQuery) this.findStale = true;
        this.findQuery = needle;
        this.renderFind(matches);
    }

    /** 结束查找：撤掉高亮，焦点回到编辑区；查找期间的选区即当前命中（或在编辑区另选的位置），聚焦后原样重设，可直接修改 */
    endFind() {
        const ta = this.textarea;
        if (!ta) return;
        const { selectionStart, selectionEnd, selectionDirection } = ta;
        this.clearFind();
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
    }

    /** 撤掉查找高亮并清空查找状态，不动焦点与选区 */
    clearFind() {
        cancelAnimationFrame(this.findFrame);
        cancelAnimationFrame(this.findSyncFrame);
        clearTimeout(this.findTimer);
        this.findFrame = null;
        this.findSyncFrame = null;
        this.findTimer = null;
        this.findQuery = '';
        this.findMatchList = [];
        this.findMarks = [];
        this.findCurrent = -1;
        this.findStale = false;
        if (this.findResizeObserver) this.findResizeObserver.disconnect();
        if (this.findText) this.findText.replaceChildren();
        this.setFindLayerShown(false);
    }

    /**
     * 按当前文本重建镜像层（文本与查询串都没变时只换当前命中）；有命中且编辑区可见时显出并对齐。
     * 重建后、或当前命中有变时，编辑区可见即派发 mf-md-find，顶部栏据此实时更新计数。
     */
    renderFind(matches = null) {
        cancelAnimationFrame(this.findFrame);
        clearTimeout(this.findTimer);
        this.findFrame = null;
        this.findTimer = null;
        const ta = this.textarea;
        if (!this.findQuery || !ta) return;
        // 先读 textarea 的尺寸、滚动与选区，再改镜像层：改完不再读布局，镜像层只在本帧绘制前排版一次
        const width = ta.clientWidth;
        const { scrollTop, scrollLeft, selectionStart, selectionEnd } = ta;
        let changed = true;
        if (this.findStale) {
            const value = ta.value;
            this.findMatchList = Array.isArray(matches) ? matches : findMatches(value, this.findQuery);
            this.buildFindLayer(value, this.findMatchIndex(selectionStart, selectionEnd));
            this.findStale = false;
        } else {
            changed = this.setFindCurrent(this.findMatchIndex(selectionStart, selectionEnd));
        }
        const shown = width > 0 && this.findMatchList.length > 0;
        if (shown) this.findText.style.width = `${width}px`;
        this.setFindLayerShown(shown);
        if (shown) this.findText.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
        // 编辑区不可见（所在视图已切走、尺寸归零）时不派发：此时的查找已不属于当前视图
        if (changed && width > 0) this.emitFindState();
    }

    /** 镜像层内容：普通文本为文本节点，命中为 <mark>；文档内容一律经文本节点写入，不拼 HTML。无命中时清空 */
    buildFindLayer(value, current) {
        const fragment = document.createDocumentFragment();
        const marks = [];
        const segments = this.findMatchList.length > 0 ? splitByMatches(value, this.findMatchList, current) : [];
        for (const segment of segments) {
            if (segment.index < 0) {
                fragment.append(document.createTextNode(segment.text));
                continue;
            }
            const mark = document.createElement('mark');
            mark.textContent = segment.text;
            if (segment.current) mark.className = 'is-current';
            marks[segment.index] = mark;
            fragment.append(mark);
        }
        this.findText.replaceChildren(fragment);
        this.findMarks = marks;
        this.findCurrent = current;
    }

    /** 与区间 [start, end) 正好重合的命中下标；没有时为 -1 */
    findMatchIndex(start, end) {
        return this.findMatchList.findIndex((match) => match.start === start && match.end === end);
    }

    /** 把深色标记换到下标 next 的命中上；回 true 表示当前命中有变 */
    setFindCurrent(next) {
        if (next === this.findCurrent) return false;
        const previous = this.findMarks[this.findCurrent];
        if (previous) previous.classList.remove('is-current');
        if (this.findMarks[next]) this.findMarks[next].classList.add('is-current');
        this.findCurrent = next;
        return true;
    }

    /** 查找状态经 mf-md-find 通知顶部栏：total 为命中数，current 为当前命中的 0 起下标（无当前命中为 -1）；clearFind 时不派发 */
    emitFindState() {
        this.emit('mf-md-find', { query: this.findQuery, total: this.findMatchList.length, current: this.findCurrent, sessionId: this._sessionId });
    }

    /** 输入后刷新高亮：常规文本在下一帧重建；超长文本先撤下（旧位置已错开），停手 FIND_IDLE_MS 后再重建 */
    scheduleFindRefresh() {
        if (!this.findQuery) return;
        this.findStale = true;
        if (this.textarea.value.length > FIND_LIVE_CHARS) {
            this.setFindLayerShown(false);
            cancelAnimationFrame(this.findFrame);
            this.findFrame = null;
            clearTimeout(this.findTimer);
            this.findTimer = setTimeout(() => this.renderFind(), FIND_IDLE_MS);
            return;
        }
        if (!this.findFrame) this.findFrame = requestAnimationFrame(() => this.renderFind());
    }

    /** 选区变化后在下一帧按选区换当前命中，有变且编辑区可见时派发 mf-md-find；镜像层待重建时跳过（重建时自会按选区标出） */
    scheduleFindSync() {
        if (!this.findQuery || this.findSyncFrame) return;
        this.findSyncFrame = requestAnimationFrame(() => {
            this.findSyncFrame = null;
            const ta = this.textarea;
            if (!this.findQuery || this.findStale || !ta) return;
            const visible = ta.clientWidth > 0;
            if (this.setFindCurrent(this.findMatchIndex(ta.selectionStart, ta.selectionEnd)) && visible) this.emitFindState();
        });
    }

    setFindLayerShown(shown) {
        if (!this.findLayer || this.findLayer.hidden === !shown) return;
        this.findLayer.hidden = !shown;
        if (shown) this.dataset.find = 'shown';
        else delete this.dataset.find;
    }

    /** 镜像文字块宽度取 textarea.clientWidth（已扣除滚动条），两层折行宽度一致；再对齐滚动位置 */
    syncFindGeometry() {
        if (!this.findLayer || this.findLayer.hidden) return;
        this.findText.style.width = `${this.textarea.clientWidth}px`;
        this.syncFindScroll();
    }

    syncFindScroll() {
        if (!this.findLayer || this.findLayer.hidden) return;
        this.findText.style.transform = `translate(${-this.textarea.scrollLeft}px, ${-this.textarea.scrollTop}px)`;
    }

    /** 查找期间观察 textarea 尺寸：宽度变化（窗口、分栏、滚动条出没）时重对齐；尺寸归零（编辑页被隐藏）时撤掉高亮 */
    observeFindResize() {
        if (typeof ResizeObserver !== 'function' || !this.textarea) return;
        if (!this.findResizeObserver) {
            this.findResizeObserver = new ResizeObserver(() => {
                if (!this.findQuery || !this.textarea) return;
                if (this.textarea.clientWidth === 0 && this.textarea.clientHeight === 0) this.clearFind();
                else this.syncFindGeometry();
            });
        }
        this.findResizeObserver.observe(this.textarea);
    }

    // ---------- 实时预览 ----------

    scheduleRender() {
        clearTimeout(this.renderTimer);
        const delay = this.textarea && this.textarea.value.length > LARGE_TEXT_CHARS ? RENDER_DELAY_LARGE_MS : RENDER_DELAY_MS;
        this.renderTimer = setTimeout(() => { this.renderNow(); }, delay);
    }

    async renderNow() {
        clearTimeout(this.renderTimer);
        this.renderTimer = null;
        if (!this._sessionId || !this.textarea) return null;
        this.renderSeq += 1;
        const seq = this.renderSeq;
        const epoch = this.contentEpoch;
        try {
            const result = await api.mdRender({ sessionId: this._sessionId, text: this.value });
            if (seq !== this.renderSeq || epoch !== this.contentEpoch) return null;
            this.lastHtml = String((result && result.html) || '');
            this.showPreviewError('');
            this.mountPreview();
            this.emit('mf-md-rendered', { html: this.lastHtml });
            return this.lastHtml;
        } catch (err) {
            if (seq !== this.renderSeq || epoch !== this.contentEpoch) return null;
            this.showPreviewError(err && err.message ? `预览失败：${err.message}` : '预览失败');
            return null;
        }
    }

    showPreviewError(message) {
        const node = this.querySelector('[data-role="preview-error"]');
        if (!node) return;
        node.textContent = message;
        node.hidden = !message;
    }

    /** 新帧先隐藏装载，load 后替换旧帧并按 textarea 的滚动比例恢复位置，避免闪烁与跳顶 */
    mountPreview() {
        if (!this._previewVisible || !this.previewHost) return;
        const html = this.lastHtml;
        if (html === this.mountedHtml) return;
        this.mountedHtml = html;
        this.frameToken += 1;
        const token = this.frameToken;
        const frame = createViewFrame({ srcdoc: html, title: '实时预览', scrollbar: true, sameOrigin: true, appearance: this.frameAppearance });
        frame.classList.add('is-pending');
        frame.addEventListener('load', () => {
            if (token !== this.frameToken) {
                frame.remove();
                return;
            }
            for (const old of [...this.previewHost.querySelectorAll('.view-frame')]) if (old !== frame) old.remove();
            frame.classList.remove('is-pending');
            this.syncPreviewScroll(frame);
        }, { once: true });
        this.previewHost.append(frame);
    }

    scheduleScrollSync() {
        if (this.scrollFrame) return;
        this.scrollFrame = requestAnimationFrame(() => {
            this.scrollFrame = null;
            const frame = this.previewHost ? this.previewHost.querySelector('.view-frame:not(.is-pending)') : null;
            if (frame) this.syncPreviewScroll(frame);
        });
    }

    syncPreviewScroll(frame) {
        const ta = this.textarea;
        const doc = frame && frame.contentDocument;
        if (!ta || !doc) return;
        const max = ta.scrollHeight - ta.clientHeight;
        const ratio = max > 0 ? ta.scrollTop / max : 0;
        const scroller = doc.scrollingElement || doc.documentElement;
        if (!scroller) return;
        scroller.scrollTop = ratio * Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    }

    // ---------- 保存 ----------

    scheduleSave() {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        if (!this._sessionId || this.blocked || !this.dirty) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            if (!this.composing) this.requestSave('autosave');
        }, SAVE_DELAY_MS);
    }

    requestSave(reason = 'autosave', options = {}) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        if (this.savingPromise) {
            this.saveAgainReason = reason;
            this.saveAgainOptions = options;
            return this.savingPromise;
        }
        return this.runSave(reason, options);
    }

    runSave(reason, options = {}) {
        const promise = this.performSave(reason, options);
        this.savingPromise = promise;
        promise.then(() => {
            if (this.savingPromise === promise) this.savingPromise = null;
            const again = this.saveAgainReason;
            const againOptions = this.saveAgainOptions || {};
            this.saveAgainReason = null;
            this.saveAgainOptions = null;
            if (again && !this.blocked && (this.dirty || again === 'shortcut' || againOptions.force)) this.requestSave(again, againOptions);
        });
        return promise;
    }

    async performSave(reason, { force = false } = {}) {
        if (!this._sessionId) return false;
        const event = new CustomEvent('mf-md-save', { bubbles: true, cancelable: true, detail: { reason } });
        if (!this.dispatchEvent(event)) return !this.dirty;
        if (!this.dirty && !force) {
            if (!this.blocked && this.statusState === 'dirty') this.setStatus(this.lastSaveStaged ? 'staged' : 'saved');
            return !this.blocked;
        }
        const epoch = this.contentEpoch;
        const version = this.version;
        const text = this.value;
        this.setStatus('saving');
        try {
            const result = await api.mdSave({ sessionId: this._sessionId, text, ...(force ? { force: true } : {}) });
            if (epoch !== this.contentEpoch || (result && result.discarded)) return false;
            if (result && result.conflict) {
                this.blocked = true;
                const message = result.missing ? '文件已被删除或移动' : '文件已在外部修改';
                this.setStatus('conflict', message);
                this.showBanner('conflict', `${message}。可覆盖保存为编辑器中的内容，或重新载入磁盘上的版本（将丢弃编辑器里的修改）。`);
                return false;
            }
            this.blocked = false;
            this.hideBanner();
            this.savedVersion = version;
            this.lastSaveStaged = Boolean(result && result.staged);
            this.syncDirty();
            this.setStatus(this.dirty ? 'dirty' : (this.lastSaveStaged ? 'staged' : 'saved'));
            this.emit('mf-md-saved', { text, result: result || {} });
            return !this.dirty;
        } catch (err) {
            if (epoch !== this.contentEpoch) return false;
            const message = err && err.message ? err.message : '保存失败';
            this.setStatus('failed', message);
            this.showBanner('failed', `保存失败：${message}`);
            return false;
        }
    }

    forceSave() {
        this.blocked = false;
        this.hideBanner();
        return this.requestSave('force', { force: true });
    }

    /** 立即落盘：等在跑的保存结束，仍有未保存修改则再存一次；冲突未解决或失败时回 false */
    async flush() {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        while (this.savingPromise) await this.savingPromise.catch(() => undefined);
        if (this.blocked) return false;
        if (!this.dirty) return true;
        return this.runSave('flush');
    }

    /** 对比预览导出成功并绑定到导出文件后调用：暂存态转为已保存 */
    markExported() {
        this.lastSaveStaged = false;
        if (!this.blocked) this.setStatus(this.dirty ? 'dirty' : 'saved');
    }

    setStatus(state, message = '') {
        this.statusState = MD_STATUS_LABELS[state] !== undefined ? state : 'idle';
        this.statusMessage = message;
        const label = MD_STATUS_LABELS[this.statusState];
        if (this.statusEl) {
            this.statusEl.textContent = label;
            this.statusEl.dataset.state = this.statusState;
            if (message) this.statusEl.title = message;
            else this.statusEl.removeAttribute('title');
        }
        this.emit('mf-md-status', { state: this.statusState, message, label });
    }

    showBanner(kind, text) {
        const banner = this.querySelector('[data-role="banner"]');
        if (!banner) return;
        banner.dataset.kind = kind;
        this.querySelector('[data-role="banner-text"]').textContent = text;
        banner.hidden = false;
    }

    hideBanner() {
        const banner = this.querySelector('[data-role="banner"]');
        if (banner) banner.hidden = true;
    }

    // ---------- 工具栏布局与弹层 ----------

    /** 栏窄时从末组起收进「…」更多菜单：先全部显示再逐组隐藏，直到不再溢出 */
    layoutToolbar() {
        const bar = this.toolbar;
        if (!bar || !bar.clientWidth) return;
        const groups = [...bar.querySelectorAll('[data-group]')];
        const more = bar.querySelector('[data-cmd="more"]');
        for (const group of groups) group.hidden = false;
        more.hidden = true;
        const hidden = [];
        if (bar.scrollWidth > bar.clientWidth + 1) {
            more.hidden = false;
            for (let index = groups.length - 1; index >= 0 && bar.scrollWidth > bar.clientWidth + 1; index -= 1) {
                groups[index].hidden = true;
                hidden.unshift(groups[index].dataset.group);
            }
        }
        const changed = hidden.join(',') !== this.overflowGroups.join(',');
        this.overflowGroups = hidden;
        if (changed) this.closeMenus();
    }

    renderMoreMenu() {
        const menu = this.querySelector('[data-role="more-menu"]');
        const sections = TOOL_GROUPS.filter((group) => this.overflowGroups.includes(group.key)).map((group) => group.items.map((item) => `
            <button class="md-editor-menu-item" type="button" role="menuitem" data-cmd="${item.cmd}">
                ${icon(item.icon)}<span class="md-editor-menu-label">${escapeHtml(item.label)}</span>${item.keys ? `<kbd class="md-editor-menu-keys">${escapeHtml(item.keys)}</kbd>` : ''}
            </button>`).join(''));
        menu.innerHTML = sections.join('<div class="md-editor-menu-sep" role="separator"></div>');
    }

    toggleMoreMenu(anchor) {
        const menu = this.querySelector('[data-role="more-menu"]');
        const open = menu.hidden;
        this.closeMenus();
        if (!open) return;
        this.renderMoreMenu();
        this.openPopover(menu, anchor, { alignRight: true });
        anchor.setAttribute('aria-expanded', 'true');
    }

    toggleTablePicker(anchor) {
        const picker = this.querySelector('[data-role="table-picker"]');
        const open = picker.hidden;
        this.closeMenus();
        if (!open) return;
        this.highlightTableCells(TABLE_TEMPLATE.rows, TABLE_TEMPLATE.cols);
        this.openPopover(picker, anchor || this.querySelector('[data-cmd="more"]'), { alignRight: !anchor });
    }

    openPopover(node, anchor, { alignRight = false } = {}) {
        node.hidden = false;
        const rootRect = this.getBoundingClientRect();
        const barRect = this.toolbar.getBoundingClientRect();
        node.style.top = `${Math.round(barRect.bottom - rootRect.top + POPOVER_GAP)}px`;
        const width = node.offsetWidth;
        let left = alignRight || !anchor ? rootRect.width - width - POPOVER_MARGIN : anchor.getBoundingClientRect().left - rootRect.left;
        if (alignRight && anchor) left = anchor.getBoundingClientRect().right - rootRect.left - width;
        node.style.left = `${Math.round(Math.max(POPOVER_MARGIN, Math.min(left, rootRect.width - width - POPOVER_MARGIN)))}px`;
    }

    highlightTableCells(rows, cols) {
        for (const cell of this.querySelectorAll('.md-editor-table-cell')) {
            cell.classList.toggle('is-on', Number(cell.dataset.rows) <= rows && Number(cell.dataset.cols) <= cols);
        }
        const label = this.querySelector('[data-role="table-label"]');
        if (label) label.textContent = `${rows} 行 × ${cols} 列`;
    }

    /** 关闭更多菜单与表格选择器；有弹层被关闭时回 true */
    closeMenus() {
        let closed = false;
        for (const node of this.querySelectorAll('[data-role="more-menu"], [data-role="table-picker"]')) {
            if (!node.hidden) closed = true;
            node.hidden = true;
        }
        const more = this.querySelector('[data-cmd="more"]');
        if (more) more.setAttribute('aria-expanded', 'false');
        return closed;
    }

    closeMenusOutside(event) {
        const target = event.target instanceof Element ? event.target : null;
        if (target && target.closest('.md-editor-menu, [data-cmd="more"], [data-cmd="table"]') && this.contains(target)) return;
        this.closeMenus();
    }

    // ---------- 收尾 ----------

    clearTimers() {
        clearTimeout(this.saveTimer);
        clearTimeout(this.renderTimer);
        this.saveTimer = null;
        this.renderTimer = null;
    }

    emit(name, detail) {
        this.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
    }

    /** 宿主关闭标签或换会话时调用：停掉计时器与观察器、移出登记表、清空预览帧 */
    dispose() {
        this.clearTimers();
        this.clearFind();
        this.contentEpoch += 1;
        this.renderSeq += 1;
        this.frameToken += 1;
        liveEditors.delete(this);
        if (this.resizeObserver) this.resizeObserver.disconnect();
        document.removeEventListener('selectionchange', this.onDocumentSelection);
        document.removeEventListener('pointerdown', this.onDocumentPointer, true);
        if (this.previewHost) for (const frame of [...this.previewHost.querySelectorAll('.view-frame')]) frame.remove();
        this._sessionId = null;
        this.version = 0;
        this.savedVersion = 0;
        this.lastSaveStaged = false;
        this.statusState = 'idle';
    }
}

customElements.define('mf-md-editor', MfMdEditor);

export { MfMdEditor };
