/**
 * MarkFlow 桌面端前端脚本
 *
 * 职责：三个输入 tab（办公文档 / 标记文档 / 网页链接）→ 以本地路径或 URL 提交 POST /api/convert
 *       → 逐行解析 NDJSON 进度流 → 右栏结果面板展示并联动 Finder；设置弹窗管理三态主题与输出目录。
 * 约定：所有 /api 请求附带 X-MarkFlow-Token；插入 DOM 的动态文本一律先经 escapeHtml；
 *       事件全部委托绑定，不使用内联事件属性；本地文件读取依赖 preload 注入的 window.electronAPI。
 */
'use strict';

// ---------- 常量与运行环境 ----------
const ELECTRON = window.electronAPI && window.electronAPI.isElectron ? window.electronAPI : null;
const API_TOKEN = ELECTRON && typeof ELECTRON.apiToken === 'string' ? ELECTRON.apiToken : '';
// 页面由同一 HTTP 服务提供时走同源相对路径，天然满足 CSP connect-src 'self'；仅 file:// 等场景才用注入的 apiBase
const API_BASE = ELECTRON && typeof ELECTRON.apiBase === 'string' && !/^https?:$/.test(window.location.protocol) ? ELECTRON.apiBase : '';

const TAB_EXTENSIONS = Object.freeze({ office: ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'pdf'], markup: ['md', 'markdown'] });
const LEGACY_EXTENSIONS = Object.freeze(['doc', 'xls', 'ppt']);
const FILE_ICONS = Object.freeze({
    docx: 'file-doc', doc: 'file-doc', xlsx: 'file-xls', xls: 'file-xls', pptx: 'file-ppt', ppt: 'file-ppt',
    pdf: 'file-pdf', md: 'file-text', markdown: 'file-text',
});
const STATUS_ICONS = Object.freeze({ running: 'spinner', success: 'check-circle', failed: 'x-circle' });
const TOAST_ICONS = Object.freeze({ success: 'check-circle', error: 'x-circle', warning: 'warning', info: 'info' });
const PHASE_LABELS = Object.freeze({ parsing: '解析中', rendering: '渲染中', writing: '写入中' });
const TARGET_LABELS = Object.freeze({ bundle: 'MD + JSON', docx: 'DOCX', pdf: 'PDF' });
const THEMES = Object.freeze(['system', 'light', 'dark']);
const THEME_KEY = 'theme';
const TOAST_DURATION_MS = 3000;
const TOAST_EXIT_MS = 300;
const URL_PATTERN = /^https?:\/\//i;
const DESKTOP_ONLY_MESSAGE = '请使用 MarkFlow 桌面版';
const SOFFICE_HINT = '安装 LibreOffice 后即可转换 .doc / .xls / .ppt';

// 运行时状态：文件列表按 tab 分开，避免序号跨 tab 串扰
const state = { activeTab: 'office', filesByTab: { office: [], markup: [] }, caps: null, outputDir: '', isConverting: false, runSeq: 0 };

const $ = (id) => document.getElementById(id);

// ---------- 通用工具 ----------
function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function icon(name, extraClass = '') {
    return `<svg class="icon${extraClass ? ` ${extraClass}` : ''}" aria-hidden="true"><use href="assets/icons.svg#${name}"/></svg>`;
}

function fileExt(name) {
    const match = /\.([^./\\]+)$/.exec(String(name || ''));
    return match ? match[1].toLowerCase() : '';
}

function baseName(filePath) {
    return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    return size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// 事件委托：在 root 上监听 click，命中 selector 时回调
function delegate(root, selector, handler) {
    root.addEventListener('click', (e) => {
        const target = e.target.closest(selector);
        if (target) handler(target, e);
    });
}

function showToast(message, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'status');
    toast.innerHTML = `${icon(TOAST_ICONS[type] || TOAST_ICONS.info)}<span>${escapeHtml(message)}</span>`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), TOAST_EXIT_MS); }, TOAST_DURATION_MS);
}

// 非桌面环境统一提示；返回是否可继续
function requireDesktop() {
    if (ELECTRON) return true;
    showToast(DESKTOP_ONLY_MESSAGE, 'warning');
    return false;
}

function closeModals() {
    document.querySelectorAll('.modal-overlay.active').forEach((el) => el.classList.remove('active'));
}

// ---------- HTTP：token 请求 + NDJSON 流 ----------
function api(path, init = {}) {
    const headers = { 'X-MarkFlow-Token': API_TOKEN, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) };
    return fetch(API_BASE + path, { ...init, headers });
}

// 统一解析 JSON 响应：HTTP 非 2xx 或 success=false 一律抛出服务端错误文案
async function readJson(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

// 逐行读取 NDJSON 流，每解析出一行即回调 onEvent(event)
async function readNdjson(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const consume = (chunk, isFinal) => {
        const lines = (buffer + chunk).split('\n');
        buffer = isFinal ? '' : lines.pop();
        lines.map((line) => line.trim()).filter(Boolean).forEach((line) => onEvent(JSON.parse(line)));
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consume(decoder.decode(value, { stream: true }), false);
    }
    consume(decoder.decode(), true);
}

// ---------- Tab 切换 ----------
function initTabs() {
    delegate(document.querySelector('.tabs'), '.tab-btn', (btn) => activateTab(btn.dataset.tab));
    window.addEventListener('resize', updateTabIndicator);
    activateTab(state.activeTab);
}

function activateTab(name) {
    state.activeTab = name;
    document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === name);
        btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
    });
    document.querySelectorAll('.tab-content').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${name}`));
    updateTabIndicator();
}

function updateTabIndicator() {
    const indicator = document.querySelector('.tab-indicator');
    const active = document.querySelector('.tab-btn.active');
    if (!indicator || !active) return;
    indicator.style.width = `${active.offsetWidth}px`;
    indicator.style.transform = `translateX(${active.offsetLeft}px)`;
}

// ---------- 文件加入：拖拽 / 文件选择 → 本地路径 → expandPaths 展开目录 → 过滤 → 按路径去重 ----------
function initDropZones() {
    // 文件落在页面其它位置时不得触发窗口导航
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());
    ['office', 'markup'].forEach(bindDropZone);
}

function bindDropZone(tab) {
    const panel = $(`tab-${tab}`);
    const input = $(`file-input-${tab}`);
    const setDragover = (on) => panel.querySelectorAll('.upload-area, .file-list').forEach((el) => el.classList.toggle('is-dragover', on));
    panel.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragover(true); });
    panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) setDragover(false); });
    panel.addEventListener('drop', (e) => { e.preventDefault(); setDragover(false); addFiles(tab, Array.from(e.dataTransfer.files)); });
    input.addEventListener('change', () => {
        const files = Array.from(input.files);
        input.value = '';   // 允许再次选择同一文件
        addFiles(tab, files);
    });
    delegate(panel, '[data-trigger]', (btn) => $(btn.dataset.trigger).click());
    delegate(panel, '[data-remove]', (btn) => setTabFiles(tab, state.filesByTab[tab].filter((f) => f.path !== btn.dataset.remove)));
    delegate(panel, '[data-clear-files]', () => setTabFiles(tab, []));
}

async function addFiles(tab, files) {
    if (files.length === 0 || !requireDesktop()) return;
    try {
        const paths = files.map((file) => ELECTRON.getPathForFile(file)).filter(Boolean);
        const entries = await ELECTRON.expandPaths(paths);
        const { accepted, legacy, unsupported } = filterEntries(tab, Array.isArray(entries) ? entries : []);
        mergeFiles(tab, accepted);
        if (legacy.length > 0) showToast(`需要安装 LibreOffice：${legacy.map((e) => baseName(e.name || e.path)).join('、')}`, 'warning');
        else if (unsupported.length > 0) showToast(`已忽略 ${unsupported.length} 个不支持的文件`, 'warning');
    } catch (err) {
        showToast(`读取文件失败：${err.message}`, 'error');
    }
}

// doc / xls / ppt 只有在服务端探测到 LibreOffice（inputs 含该类型）时才接受
function filterEntries(tab, entries) {
    const allowed = TAB_EXTENSIONS[tab];
    const inputs = (state.caps && state.caps.targets && state.caps.targets.inputs) || {};
    const bucketOf = (ext) => (!allowed.includes(ext) ? 'unsupported' : (LEGACY_EXTENSIONS.includes(ext) && !inputs[ext] ? 'legacy' : 'accepted'));
    const result = { accepted: [], legacy: [], unsupported: [] };
    entries.forEach((entry) => result[bucketOf(fileExt(entry.name || entry.path))].push(entry));
    return result;
}

function mergeFiles(tab, entries) {
    const byPath = new Map(state.filesByTab[tab].map((file) => [file.path, file]));
    entries.forEach((entry) => {
        if (!entry.path || byPath.has(entry.path)) return;
        const name = entry.name || baseName(entry.path);
        byPath.set(entry.path, { path: entry.path, name, size: entry.size || 0, type: fileExt(name), status: 'idle' });
    });
    setTabFiles(tab, [...byPath.values()]);
}

// 写入新数组并整体重绘该 tab 的文件列表；无文件时恢复显示拖拽区
function setTabFiles(tab, files) {
    state.filesByTab = { ...state.filesByTab, [tab]: files };
    $(`drop-zone-${tab}`).hidden = files.length > 0;
    const actions = `<div class="file-list-actions"><button class="btn btn-small btn-secondary" type="button" data-trigger="file-input-${tab}">${icon('plus')} 添加更多</button>
        <button class="btn btn-small btn-secondary" type="button" data-clear-files>${icon('trash')} 清空</button></div>`;
    $(`file-list-${tab}`).innerHTML = files.length === 0 ? '' : files.map(fileItemHtml).join('') + actions;
}

function fileItemHtml(file) {
    const path = escapeHtml(file.path);
    return `<div class="file-item is-${file.status}" data-path="${path}">
        <div class="file-item-info">
            <span class="file-item-icon">${icon(FILE_ICONS[file.type] || 'file')}</span>
            <div class="file-item-text"><span class="file-item-name" title="${path}">${escapeHtml(file.name)}</span><span class="file-item-size">${formatFileSize(file.size)}</span></div>
        </div>
        <span class="file-item-status">${statusIcon(file.status)}</span>
        <button class="icon-btn icon-btn-sm" type="button" title="移除" aria-label="移除" data-remove="${path}">${icon('x')}</button>
    </div>`;
}

function statusIcon(status) {
    return STATUS_ICONS[status] ? icon(STATUS_ICONS[status], status === 'running' ? 'icon-spin' : '') : '';
}

function setFileStatus(tab, filePath, status) {
    state.filesByTab = { ...state.filesByTab, [tab]: state.filesByTab[tab].map((f) => (f.path === filePath ? { ...f, status } : f)) };
    const item = $(`file-list-${tab}`).querySelector(`.file-item[data-path="${CSS.escape(filePath)}"]`);
    if (!item) return;
    item.className = `file-item is-${status}`;
    item.querySelector('.file-item-status').innerHTML = statusIcon(status);
}

// ---------- 输出格式 chip（仅标记文档 tab）与运行能力 ----------
function selectChip(chip) {
    chip.parentElement.querySelectorAll('.format-chip').forEach((c) => {
        c.classList.toggle('active', c === chip);
        c.setAttribute('aria-pressed', String(c === chip));
    });
}

async function loadCapabilities() {
    try {
        const data = await readJson(await api('/api/formats'));
        state.caps = data;
        if (data.outputDir) setOutputDir(data.outputDir);
        applyCapabilities(data);
    } catch (err) {
        renderCapabilityStatus(null);
        showToast(`能力探测失败：${err.message}`, 'error');
    }
}

function applyCapabilities(data) {
    const backend = (data.capabilities && data.capabilities.pdfBackend) || { available: false, hint: '' };
    const pdfReady = Boolean(backend.available) && ((data.targets && data.targets.markup) || []).includes('pdf');
    const pdfChip = document.querySelector('#format-chips-markup .format-chip[data-format="pdf"]');
    pdfChip.disabled = !pdfReady;
    pdfChip.title = pdfReady ? 'PDF 文档' : backend.hint || 'PDF 输出不可用';
    if (!pdfReady && pdfChip.classList.contains('active')) selectChip(document.querySelector('#format-chips-markup .format-chip[data-format="docx"]'));
    renderCapabilityStatus(data.capabilities || {});
}

function renderCapabilityStatus(caps) {
    const pdf = (caps && caps.pdfBackend) || { available: false, hint: '' };
    const soffice = Boolean(caps && caps.sofficeAvailable);
    setCapability('cap-pdf', Boolean(pdf.available), pdf.available ? `可用（${pdf.name}）` : '不可用', pdf.available ? '' : pdf.hint || '');
    setCapability('cap-soffice', soffice, soffice ? '可用' : '不可用', soffice ? '' : SOFFICE_HINT);
}

function setCapability(id, ok, text, hint) {
    $(id).textContent = text;
    $(id).className = `capability-status ${ok ? 'ok' : 'fail'}`;
    $(`${id}-hint`).textContent = hint;
    $(`${id}-hint`).hidden = !hint;
}

// ---------- 转换：组装 items → POST /api/convert → 消费 NDJSON 事件 ----------
function buildItems() {
    const tab = state.activeTab;
    if (tab === 'link') return collectUrlItems();
    const files = state.filesByTab[tab];
    if (files.length === 0) { showToast('请先添加文件', 'warning'); return []; }
    const chip = document.querySelector('#format-chips-markup .format-chip.active:not(:disabled)');
    const target = tab === 'markup' ? (chip ? chip.dataset.format : 'docx') : 'bundle';
    return files.map((file) => ({ path: file.path, target }));
}

function collectUrlItems() {
    const lines = [...new Set($('url-input').value.split('\n').map((s) => s.trim()).filter(Boolean))];
    const urls = lines.filter((line) => URL_PATTERN.test(line));
    const invalidCount = lines.length - urls.length;
    if (invalidCount > 0) showToast(`已跳过 ${invalidCount} 行无效链接（须以 http:// 或 https:// 开头）`, 'warning');
    else if (urls.length === 0) showToast('请先输入链接', 'warning');
    return urls.map((url) => ({ url, target: 'bundle' }));
}

async function runConvert() {
    if (state.isConverting || !ELECTRON) return;
    const items = buildItems();
    if (items.length === 0) return;
    state.runSeq += 1;
    const ctx = { runId: state.runSeq, tab: state.activeTab, items, names: new Map(), pct: new Map(), completed: 0 };
    setConverting(true);
    showProgress(items.length);
    try {
        const response = await api('/api/convert', { method: 'POST', body: JSON.stringify({ items }) });
        if (!response.ok) await readJson(response);   // 400 等非流式错误：readJson 抛出服务端错误文案
        await readNdjson(response, (event) => handleConvertEvent(ctx, event));
    } catch (err) {
        showToast(`转换失败：${err.message}`, 'error');
    } finally {
        $('loading-modal').classList.remove('active');
        setConverting(false);
    }
}

function setConverting(on) {
    state.isConverting = on;
    $('convert-btn').disabled = on || !ELECTRON;
    $('convert-btn').classList.toggle('is-busy', on);
}

function handleConvertEvent(ctx, event) {
    const handlers = { accepted: updateProgress, start: onItemStart, progress: onItemProgress, item: onItemFinished, done: onBatchDone };
    if (handlers[event.type]) handlers[event.type](ctx, event);
}

function onItemStart(ctx, event) {
    const item = ctx.items[event.idx] || {};
    const name = event.name || baseName(item.path) || item.url || `第 ${event.idx + 1} 项`;
    ctx.names.set(event.idx, name);
    insertResultItem(`run${ctx.runId}-${event.idx}`, name, item);
    if (item.path) setFileStatus(ctx.tab, item.path, 'running');
    $('loading-name').textContent = name;
}

function onItemProgress(ctx, event) {
    ctx.pct.set(event.idx, Math.min(100, Math.max(0, Number(event.pct) || 0)));
    $('loading-name').textContent = `${ctx.names.get(event.idx) || ''} · ${PHASE_LABELS[event.phase] || event.phase || ''}`;
    updateProgress(ctx);
}

function onItemFinished(ctx, event) {
    ctx.completed += 1;
    ctx.pct.set(event.idx, 100);
    updateResultItem(`run${ctx.runId}-${event.idx}`, event);
    const item = ctx.items[event.idx] || {};
    if (item.path) setFileStatus(ctx.tab, item.path, event.ok ? 'success' : 'failed');
    updateProgress(ctx);
}

function onBatchDone(ctx, event) {
    const total = event.total || ctx.items.length;
    const ok = event.succeeded || 0;
    if (event.error) showToast(`转换中断：${event.error}`, 'error');
    else if (ok === total) showToast(`转换完成 ${ok}/${total}`, 'success');
    else if (ok > 0) showToast(`部分成功 ${ok}/${total}`, 'warning');
    else showToast(`全部失败 ${total}/${total}`, 'error');
}

// ---------- 进度弹窗：当前项名称 + n/total + 进度条（多项并发时按各项 pct 汇总） ----------
function showProgress(total) {
    $('loading-name').textContent = '准备中...';
    $('progress-fill').style.width = '0%';
    $('progress-text').textContent = `0/${total}`;
    $('loading-modal').classList.add('active');
}

function updateProgress(ctx) {
    const total = ctx.items.length;
    const sum = [...ctx.pct.values()].reduce((acc, v) => acc + v, 0);
    $('progress-fill').style.width = `${total > 0 ? Math.round(sum / total) : 0}%`;
    $('progress-text').textContent = `${ctx.completed}/${total}`;
}

// ---------- 结果面板 ----------
function initResultsPanel() {
    $('results-clear-btn').addEventListener('click', () => {
        $('results-list').querySelectorAll('.result-item').forEach((el) => el.remove());
        updateResultsCount();
    });
    delegate($('results-list'), '[data-action]', (btn) => {
        if (btn.dataset.action === 'reveal') revealPath(btn.dataset.path);
        else if (btn.dataset.action === 'open') openPath(btn.dataset.path);
    });
}

function insertResultItem(key, name, item) {
    const el = document.createElement('article');
    el.className = 'result-item is-running';
    el.dataset.key = key;
    el.innerHTML = `<header class="result-head"><span class="result-badge">${icon('spinner', 'icon-spin')}转换中</span>
            <span class="result-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <span class="result-target">${escapeHtml(TARGET_LABELS[item.target] || item.target || '')}</span></header>
        <div class="result-body"><p class="result-source">${escapeHtml(item.url || item.path || '')}</p></div>`;
    $('results-list').prepend(el);
    updateResultsCount();
}

function updateResultItem(key, event) {
    const el = $('results-list').querySelector(`.result-item[data-key="${key}"]`);
    if (!el) return;
    el.classList.remove('is-running');
    el.classList.add(event.ok ? 'is-success' : 'is-failed');
    el.querySelector('.result-badge').innerHTML = event.ok ? `${icon('check-circle')}成功` : `${icon('x-circle')}失败`;
    el.querySelector('.result-body').innerHTML = event.ok
        ? resultSuccessHtml(event.result || {})
        : `<p class="result-error">${escapeHtml(event.error || '未知错误')}</p>`;
}

function resultSuccessHtml(result) {
    const outputPath = escapeHtml(result.outputPath || '');
    const outputs = result.outputs || {};
    // bundle 打开其 .md，docx / pdf 打开文件本身
    const openTarget = escapeHtml((result.target === 'bundle' ? outputs.md : outputs[result.target]) || result.outputPath || '');
    const title = result.title ? ` · ${escapeHtml(result.title)}` : '';
    return `<button class="result-path" type="button" data-action="reveal" data-path="${outputPath}" title="在 Finder 中显示">${outputPath}</button>
        <p class="result-meta">${icon('image')} 图片 ${Number(result.imagesCount) || 0}${title}</p>${warningsHtml(result.warnings)}
        <div class="result-actions">
            <button class="btn btn-small btn-secondary" type="button" data-action="reveal" data-path="${outputPath}">${icon('folder-open')} 在 Finder 中显示</button>
            <button class="btn btn-small btn-primary" type="button" data-action="open" data-path="${openTarget}">${icon('arrow-square-out')} 打开</button>
        </div>`;
}

function warningsHtml(warnings) {
    if (!Array.isArray(warnings) || warnings.length === 0) return '';
    const items = warnings.map((w) => `<li>${escapeHtml(typeof w === 'string' ? w : (w && w.message) || JSON.stringify(w))}</li>`).join('');
    return `<details class="result-warnings"><summary>${icon('warning')} 警告 ${warnings.length} 条</summary><ul>${items}</ul></details>`;
}

function updateResultsCount() {
    const count = $('results-list').querySelectorAll('.result-item').length;
    $('results-empty').hidden = count > 0;
    $('results-count').textContent = String(count);
    $('results-count').hidden = count === 0;
}

function revealPath(filePath) {
    if (filePath && requireDesktop()) ELECTRON.openInFinder(filePath);
}

// openPath 与 shell.openPath 同约定：返回空串表示成功，非空为错误文案
async function openPath(filePath) {
    if (!filePath || !requireDesktop()) return;
    try {
        const failure = await ELECTRON.openPath(filePath);
        if (failure) showToast(`打开失败：${failure}`, 'error');
    } catch (err) {
        showToast(`打开失败：${err.message}`, 'error');
    }
}

// ---------- 主题：system / light / dark（CSS light-dark() 随 html.style.colorScheme 即时切换） ----------
async function syncThemeFromElectron() {
    if (!ELECTRON || typeof ELECTRON.getTheme !== 'function') return;
    try {
        const saved = await ELECTRON.getTheme();
        if (saved) applyTheme(saved);
    } catch (err) {
        showToast(`读取主题设置失败：${err.message}`, 'warning');
    }
}

// 桌面版由主进程持久化主题（theme.json）且实测启动期同步访问 window.localStorage 会阻塞约 4 s，故仅浏览器模式使用 localStorage
function applyTheme(value) {
    const theme = THEMES.includes(value) ? value : 'system';
    if (!ELECTRON) localStorage.setItem(THEME_KEY, theme);
    document.documentElement.style.colorScheme = theme === 'system' ? 'light dark' : theme;
    if (ELECTRON && typeof ELECTRON.setTheme === 'function') {
        Promise.resolve(ELECTRON.setTheme(theme)).catch((err) => showToast(`同步系统外观失败：${err.message}`, 'warning'));
    }
    document.querySelectorAll('.theme-option').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.scheme === theme);
        btn.setAttribute('aria-pressed', String(btn.dataset.scheme === theme));
    });
}

// ---------- 设置弹窗：输出目录 ----------
function initSettings() {
    const modal = $('settings-modal');
    $('settings-btn').addEventListener('click', () => {
        $('output-dir-input').value = state.outputDir;
        setPreviewDir(state.outputDir);
        modal.classList.add('active');
    });
    $('close-settings').addEventListener('click', closeModals);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModals(); });
    $('output-dir-input').addEventListener('input', () => setPreviewDir($('output-dir-input').value.trim()));
    $('pick-output-dir').addEventListener('click', pickOutputDir);
    $('save-output-dir').addEventListener('click', () => saveOutputDir($('output-dir-input').value.trim()));
    $('reset-output-dir').addEventListener('click', resetOutputDir);
    delegate($('theme-switcher'), '.theme-option', (btn) => applyTheme(btn.dataset.scheme));
    if (ELECTRON && typeof ELECTRON.onSetOutputDir === 'function') ELECTRON.onSetOutputDir((dir) => { if (dir) saveOutputDir(dir); });
}

function setPreviewDir(dir) {
    $('preview-dir').textContent = dir || '<输出目录>';
}

function setOutputDir(dir) {
    state.outputDir = dir || '';
    $('output-path-label').textContent = state.outputDir || '未设置';
    $('output-path-label').title = state.outputDir;
    $('output-dir-input').value = state.outputDir;
    setPreviewDir(state.outputDir);
}

async function loadOutputDir() {
    try {
        setOutputDir((await readJson(await api('/api/settings/output-dir'))).outputDir);
    } catch (err) {
        $('output-path-label').textContent = '输出目录读取失败';
        showToast(`读取输出目录失败：${err.message}`, 'error');
    }
}

async function postOutputDir(dir) {
    const response = await api('/api/settings/output-dir', { method: 'POST', body: JSON.stringify({ dir }) });
    return (await readJson(response)).outputDir;
}

async function pickOutputDir() {
    if (!requireDesktop()) return;
    try {
        const dir = await ELECTRON.selectDirectory();
        if (dir) { $('output-dir-input').value = dir; setPreviewDir(dir); }
    } catch (err) {
        showToast(`选择目录失败：${err.message}`, 'error');
    }
}

async function saveOutputDir(dir) {
    if (!dir) { showToast('请输入或选择输出目录', 'warning'); return; }
    try {
        setOutputDir(await postOutputDir(dir));
        showToast('输出目录已更新', 'success');
    } catch (err) {
        showToast(`保存失败：${err.message}`, 'error');
    }
}

// 先按 API 约定提交空串恢复默认；服务端不支持时清空输入框并提示
async function resetOutputDir() {
    try {
        setOutputDir(await postOutputDir(''));
        showToast('已恢复默认输出目录', 'success');
    } catch (err) {
        $('output-dir-input').value = '';
        setPreviewDir('');
        showToast('当前服务不支持恢复默认，请重新选择目录后保存', 'info');
    }
}

// ---------- 快捷键 / 非桌面环境 / 入口 ----------
function initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); $('convert-btn').click(); }
        else if (e.key === 'Escape') closeModals();
    });
}

// 浏览器直开（无 preload）时无法取得本地路径：三个 tab 均提示改用桌面版并禁用转换
function applyBrowserMode() {
    document.querySelectorAll('.upload-area').forEach((zone) => {
        zone.classList.add('is-disabled');
        zone.querySelector('h3').textContent = DESKTOP_ONLY_MESSAGE;
        zone.querySelector('p').textContent = '浏览器模式无法读取本地文件路径';
        zone.querySelector('[data-trigger]').hidden = true;
    });
    $('desktop-notice-link').hidden = false;
    $('url-input').disabled = true;
    $('convert-btn').disabled = true;
    $('convert-btn').title = DESKTOP_ONLY_MESSAGE;
}

document.addEventListener('DOMContentLoaded', () => {
    // 桌面版：主进程已按持久化主题驱动 nativeTheme，首屏 CSS 即正确，只需异步回填按钮高亮
    if (ELECTRON) syncThemeFromElectron(); else applyTheme(localStorage.getItem(THEME_KEY));
    initTabs();
    initDropZones();
    initResultsPanel();
    initSettings();
    initKeyboardShortcuts();
    delegate($('format-chips-markup'), '.format-chip:not(:disabled)', selectChip);
    $('convert-btn').addEventListener('click', runConvert);
    if (!ELECTRON) applyBrowserMode();
    syncThemeFromElectron();
    loadCapabilities();
    loadOutputDir();
});
