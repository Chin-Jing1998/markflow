/**
 * MarkFlow 前端（P2 重构版）
 *
 * 4 tab：tab-office / tab-markup / tab-link / tab-text
 * 每 tab 内有输出格式 chip 组（根据 /api/formats matrix 动态启用/禁用）
 * 转换走 POST /api/convert（统一） + SSE 进度订阅
 * 预览状态机：kind-md / kind-html / kind-json / kind-binary
 */

// ============================================================
// 全局状态
// ============================================================
const FILE_TABS = ['tab-office', 'tab-markup'];
const filesByTab = { 'tab-office': [], 'tab-markup': [] };

let currentOutputDir = '';
let currentResult = null; // 最近一次成功结果（来自 SSE done）
let currentFolderName = '';
let currentFormat = 'md';
let formatMatrix = null;
let sofficeHint = '';
let isElectron = !!(window.electronAPI && window.electronAPI.isElectron);

const HISTORY_KEY = 'markflow-history';
const HISTORY_MAX = 20;
const THEME_KEY = 'markflow-theme';

// ============================================================
// 入口
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    initTabs();
    initDropZones();
    initFormatChips();
    initPreviewToggles();
    initEditor();
    initConversion();
    initSettings();
    initToolbar();
    initKeyboardShortcuts();
    initBinaryCard();

    // 异步加载能力矩阵，决定 chip 启用/禁用
    await loadCapabilities();
});

// ============================================================
// Tab 切换
// ============================================================
function initTabs() {
    const tabs = document.querySelectorAll('.tab-btn');
    const contents = document.querySelectorAll('.tab-content');
    const indicator = document.querySelector('.tab-indicator');

    function updateIndicator(activeTab) {
        if (!indicator) return;
        indicator.style.width = activeTab.offsetWidth + 'px';
        indicator.style.transform = `translateX(${activeTab.offsetLeft}px)`;
    }

    const activeTab = document.querySelector('.tab-btn.active');
    if (activeTab) updateIndicator(activeTab);
    window.addEventListener('resize', () => {
        const at = document.querySelector('.tab-btn.active');
        if (at) updateIndicator(at);
    });

    tabs.forEach((tab) => {
        tab.addEventListener('click', () => {
            tabs.forEach((t) => t.classList.remove('active'));
            contents.forEach((c) => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.getAttribute('data-tab')).classList.add('active');
            updateIndicator(tab);
            // tab 切换时刷新 chip 启用状态
            refreshChipAvailability();
        });
    });
}

// ============================================================
// 上传区（office / markup 两个）
// ============================================================
function initDropZones() {
    setupZone('tab-office', 'drop-zone-office', 'file-input-office', 'file-list-office', 'ph-file-doc');
    setupZone('tab-markup', 'drop-zone-markup', 'file-input-markup', 'file-list-markup', 'ph-brackets-angle');
}

function setupZone(tabId, zoneId, inputId, listId, iconClass) {
    const zone = document.getElementById(zoneId);
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    if (!zone || !input || !list) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((e) =>
        zone.addEventListener(e, (ev) => { ev.preventDefault(); ev.stopPropagation(); }, false),
    );
    ['dragenter', 'dragover'].forEach((e) =>
        zone.addEventListener(e, () => zone.classList.add('dragover'), false),
    );
    ['dragleave', 'drop'].forEach((e) =>
        zone.addEventListener(e, () => zone.classList.remove('dragover'), false),
    );

    zone.addEventListener('drop', (e) => handleFiles(tabId, e.dataTransfer.files), false);
    input.addEventListener('change', function () { handleFiles(tabId, this.files); });

    // "浏览文件"按钮触发
    const browseBtns = zone.querySelectorAll('[data-trigger]');
    browseBtns.forEach((b) => {
        b.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById(b.dataset.trigger).click();
        });
    });
}

function handleFiles(tabId, files) {
    if (!files || files.length === 0) return;
    const accepted = filterByTab(tabId, Array.from(files));
    if (accepted.length === 0) {
        showToast('文件类型不受当前 tab 支持', 'error');
        return;
    }
    accepted.forEach((f) => {
        if (!filesByTab[tabId].find((c) => c.name === f.name && c.size === f.size)) {
            filesByTab[tabId].push(f);
        }
    });
    renderFileList(tabId);
    refreshChipAvailability();
}

function filterByTab(tabId, files) {
    // 已禁用：xlsx / xls / pptx / ppt / html / htm（后端文件保留，UI 不暴露）
    const officeExt = ['.docx', '.pdf', '.doc'];
    const markupExt = ['.md', '.markdown', '.json'];
    const allowed = tabId === 'tab-office' ? officeExt : markupExt;
    return files.filter((f) => allowed.some((ext) => f.name.toLowerCase().endsWith(ext)));
}

function renderFileList(tabId) {
    const list = document.getElementById(`file-list-${tabId.replace('tab-', '')}`);
    const zone = document.getElementById(`drop-zone-${tabId.replace('tab-', '')}`);
    const files = filesByTab[tabId];
    if (!list || !zone) return;

    if (files.length === 0) {
        list.innerHTML = '';
        zone.style.display = 'flex';
        return;
    }
    zone.style.display = 'none';
    list.innerHTML = files
        .map(
            (f, i) => `
        <div class="file-item" data-tab="${tabId}" data-index="${i}">
            <div class="file-item-info">
                <i class="ph ${fileTypeIcon(f.name)} file-item-icon"></i>
                <div>
                    <span class="file-item-name">${escapeHtml(f.name)}</span>
                    <span class="file-item-size">${formatFileSize(f.size)}</span>
                </div>
            </div>
            <button class="icon-btn" onclick="removeFile('${tabId}', ${i})" title="移除"><i class="ph ph-x"></i></button>
        </div>`,
        )
        .join('') +
        `<button class="btn btn-secondary full-width" onclick="document.getElementById('file-input-${tabId.replace('tab-', '')}').click()" style="margin-top: 8px">
            <i class="ph ph-plus"></i> 添加更多文件
        </button>`;
}

window.removeFile = (tabId, idx) => {
    filesByTab[tabId].splice(idx, 1);
    renderFileList(tabId);
    refreshChipAvailability();
};

function fileTypeIcon(name) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.pdf')) return 'ph-file-pdf';
    if (lower.match(/\.(xlsx|xls)$/)) return 'ph-file-xls';
    if (lower.match(/\.(pptx|ppt)$/)) return 'ph-file-ppt';
    if (lower.match(/\.(docx|doc)$/)) return 'ph-file-doc';
    if (lower.match(/\.(md|markdown)$/)) return 'ph-file-text';
    if (lower.match(/\.(html|htm)$/)) return 'ph-file-html';
    if (lower.endsWith('.json')) return 'ph-brackets-curly';
    return 'ph-file';
}

// ============================================================
// 输出格式 chip
// ============================================================
function initFormatChips() {
    document.querySelectorAll('.format-chips').forEach((group) => {
        group.addEventListener('click', (e) => {
            const chip = e.target.closest('.format-chip');
            if (!chip || chip.disabled) return;
            group.querySelectorAll('.format-chip').forEach((c) => c.classList.remove('active'));
            chip.classList.add('active');
        });
    });
}

async function loadCapabilities() {
    try {
        const res = await fetch('/api/formats');
        const data = await res.json();
        formatMatrix = data.matrix || {};
        sofficeHint = data.sofficeHint || '';

        // 设置弹窗能力探测显示
        renderCapabilityStatus(data.capabilities || {}, data.sofficeHint);
        refreshChipAvailability();
    } catch (e) {
        console.warn('加载能力矩阵失败:', e);
    }
}

function renderCapabilityStatus(caps, hint) {
    const pdf = document.getElementById('cap-pdf');
    const sof = document.getElementById('cap-soffice');
    if (pdf) {
        pdf.textContent = caps.electronPrintToPdf ? '可用' : '需 Electron 模式';
        pdf.className = 'capability-status ' + (caps.electronPrintToPdf ? 'ok' : 'fail');
    }
    if (sof) {
        sof.textContent = caps.sofficeAvailable ? '已检测到' : '未安装';
        sof.className = 'capability-status ' + (caps.sofficeAvailable ? 'ok' : 'fail');
    }
    const hintEl = document.getElementById('soffice-hint');
    if (hintEl) {
        if (!caps.sofficeAvailable && hint) {
            hintEl.textContent = hint;
            hintEl.hidden = false;
        } else {
            hintEl.hidden = true;
        }
    }
}

function refreshChipAvailability() {
    if (!formatMatrix) return;
    const activeTab = document.querySelector('.tab-content.active');
    if (!activeTab) return;
    const tabId = activeTab.id;

    // 推断当前 tab 的输入类型集合（取交集决定可用输出）
    let inputTypes = [];
    if (tabId === 'tab-office' || tabId === 'tab-markup') {
        const files = filesByTab[tabId];
        if (files.length > 0) {
            inputTypes = Array.from(new Set(files.map((f) => detectInputType(f.name)))).filter(Boolean);
        } else {
            // 没文件时按 tab 的全部支持类型联合（让用户能看到可能性）
            inputTypes = tabId === 'tab-office'
                ? ['docx', 'pdf', 'doc']
                : ['md', 'json'];
        }
    } else if (tabId === 'tab-link') {
        inputTypes = ['url'];
    }

    // 输出可用 = 所有 input 类型的支持输出的交集
    let allowedOutputs = null;
    for (const t of inputTypes) {
        const supported = new Set(formatMatrix[t] || []);
        allowedOutputs = allowedOutputs ? intersect(allowedOutputs, supported) : supported;
    }
    allowedOutputs = allowedOutputs || new Set();

    const group = activeTab.querySelector('.format-chips');
    if (!group) return;
    let activeStillValid = false;
    group.querySelectorAll('.format-chip').forEach((chip) => {
        const fmt = chip.dataset.format;
        const allowed = allowedOutputs.has(fmt);
        chip.disabled = !allowed;
        if (chip.classList.contains('active') && allowed) activeStillValid = true;
    });
    // 当前激活 chip 失效时，自动切到第一个可用的
    if (!activeStillValid) {
        const firstAvail = group.querySelector('.format-chip:not([disabled])');
        if (firstAvail) {
            group.querySelectorAll('.format-chip').forEach((c) => c.classList.remove('active'));
            firstAvail.classList.add('active');
        }
    }
}

function intersect(setA, setB) {
    const out = new Set();
    for (const x of setA) if (setB.has(x)) out.add(x);
    return out;
}

function detectInputType(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.pdf')) return 'pdf';
    if (lower.endsWith('.xlsx')) return 'xlsx';
    if (lower.endsWith('.xls')) return 'xls';
    if (lower.endsWith('.pptx')) return 'pptx';
    if (lower.endsWith('.ppt')) return 'ppt';
    if (lower.endsWith('.docx')) return 'docx';
    if (lower.endsWith('.doc')) return 'doc';
    if (lower.match(/\.(md|markdown)$/)) return 'md';
    if (lower.match(/\.(html|htm)$/)) return 'html';
    if (lower.endsWith('.json')) return 'json';
    return null;
}

function getActiveFormat() {
    const activeTab = document.querySelector('.tab-content.active');
    const chip = activeTab.querySelector('.format-chip.active:not([disabled])');
    return chip ? chip.dataset.format : 'md';
}

// ============================================================
// 转换入口（统一）
// ============================================================
function initConversion() {
    document.getElementById('convert-btn').addEventListener('click', async () => {
        try {
            await runConvert();
        } catch (err) {
            showLoading(false);
            showToast(`转换失败：${err.message}`, 'error');
        }
    });
}

async function runConvert() {
    const activeTab = document.querySelector('.tab-content.active');
    if (!activeTab) return;
    const tabId = activeTab.id;
    const outputFormat = getActiveFormat();
    currentFormat = outputFormat;

    let body, headers;
    const manifest = { items: [], commonOutputDir: currentOutputDir };

    if (tabId === 'tab-office' || tabId === 'tab-markup') {
        const files = filesByTab[tabId];
        if (files.length === 0) {
            showToast('请先添加文件', 'warning');
            return;
        }
        const fd = new FormData();
        files.forEach((f, i) => {
            const inputType = detectInputType(f.name);
            if (!inputType) {
                showToast(`未识别文件类型：${f.name}`, 'warning');
                return;
            }
            fd.append('files', f);
            manifest.items.push({ idx: i, inputType, outputFormat });
        });
        if (manifest.items.length === 0) return;
        fd.append('manifest', JSON.stringify(manifest));
        body = fd;
    } else if (tabId === 'tab-link') {
        const text = document.getElementById('url-input').value.trim();
        const urls = text.split('\n').map((u) => u.trim()).filter((u) => u && u.startsWith('http'));
        if (urls.length === 0) {
            showToast('未检测到有效链接', 'warning');
            return;
        }
        manifest.items = urls.map((u, i) => ({ idx: i, inputType: 'url', outputFormat, source: u }));
        body = JSON.stringify(manifest);
        headers = { 'Content-Type': 'application/json' };
    }

    // 提交任务
    showLoading(true, '正在转换', '提交任务...');
    if (manifest.items.length > 1) showBatchProgressUI(manifest.items.length);

    const res = await fetch('/api/convert', { method: 'POST', body, headers });
    const data = await res.json();
    if (!data.success) {
        showLoading(false);
        showToast(`提交失败：${data.error}`, 'error');
        return;
    }

    subscribeJob(data.jobId, manifest.items.length);
}

function subscribeJob(jobId, totalItems) {
    let lastResult = null;
    let successCount = 0;
    let failCount = 0;

    const es = new EventSource(`/api/jobs/${jobId}/events`);

    es.addEventListener('hello', () => {});

    es.addEventListener('progress', (e) => {
        const d = JSON.parse(e.data);
        if (totalItems > 1) {
            updateProgress(successCount + failCount, totalItems, d.name);
            document.getElementById('loading-desc').textContent =
                `第 ${d.idx + 1} 项 · ${d.phase} · ${d.name}`;
        } else {
            document.getElementById('loading-desc').textContent = `${d.phase}...`;
        }
    });

    es.addEventListener('item', (e) => {
        const d = JSON.parse(e.data);
        if (d.success) {
            successCount++;
            lastResult = d.data;
        } else {
            failCount++;
        }
        markFileStatus(d.idx, d.success);
        if (totalItems > 1) {
            updateProgress(successCount + failCount, totalItems, '');
        }
    });

    es.addEventListener('done', (e) => {
        const d = JSON.parse(e.data);
        es.close();
        showLoading(false);
        if (lastResult) {
            currentResult = lastResult;
            displayResult(lastResult);
            saveToHistory(lastResult);
        }
        const total = d.summary.total;
        const ok = d.summary.success;
        if (ok === total) {
            showToast(`转换完成 ${ok}/${total}`, 'success');
        } else if (ok > 0) {
            showToast(`部分成功 ${ok}/${total}`, 'warning');
        } else {
            showToast(`全部失败 ${total}/${total}`, 'error');
        }
    });

    es.onerror = () => {
        es.close();
        showLoading(false);
    };
}

function markFileStatus(idx, success) {
    const item = document.querySelector(`.file-item[data-index="${idx}"]`);
    if (!item) return;
    let status = item.querySelector('.file-item-status');
    if (!status) {
        status = document.createElement('span');
        status.className = 'file-item-status';
        item.appendChild(status);
    }
    // 颜色由 CSS .file-item-status .ph-check-circle / .ph-x-circle 控制（token: --system-green/red）
    status.innerHTML = success
        ? '<i class="ph ph-check-circle"></i>'
        : '<i class="ph ph-x-circle"></i>';
}

// ============================================================
// 预览状态机 + 结果展示
// ============================================================
function displayResult(data) {
    currentFolderName = data.folderName;
    currentFormat = data.format;

    const body = document.getElementById('preview-body');
    body.classList.remove('kind-md', 'kind-html', 'kind-json', 'kind-binary');

    const editor = document.getElementById('markdown-editor');
    const tag = document.getElementById('preview-kind-tag');
    const exportBtn = document.getElementById('export-btn');
    const saveBtn = document.getElementById('save-btn');

    tag.textContent = (data.format || '').toUpperCase();

    if (data.format === 'md') {
        body.classList.add('kind-md');
        editor.value = data.content || '';
        renderMarkdownToPane(data.content || '');
        if (exportBtn) exportBtn.hidden = false;
        if (saveBtn) saveBtn.hidden = false;
    } else if (data.format === 'html') {
        body.classList.add('kind-html');
        editor.value = data.content || '';
        const frame = document.getElementById('html-preview-frame');
        frame.srcdoc = data.content || '';
        if (exportBtn) exportBtn.hidden = false;
        if (saveBtn) saveBtn.hidden = false;
    } else if (data.format === 'json') {
        body.classList.add('kind-json');
        const pretty = data.content
            ? JSON.stringify(JSON.parse(data.content), null, 2)
            : '';
        editor.value = pretty;
        document.getElementById('json-preview').textContent = pretty;
        if (exportBtn) exportBtn.hidden = false;
        if (saveBtn) saveBtn.hidden = false;
    } else {
        // binary：docx / pdf / xlsx / pptx
        body.classList.add('kind-binary');
        document.getElementById('binary-icon').className = `ph ${formatIcon(data.format)}`;
        document.getElementById('binary-filename').textContent =
            data.outputPath ? data.outputPath.split('/').pop() : `${data.format}`;
        document.getElementById('binary-info').textContent = data.outputPath || '';
        if (exportBtn) exportBtn.hidden = true;
        if (saveBtn) saveBtn.hidden = true;
    }

    // 切回分屏
    document.querySelector('[data-view="split"]').click();
    const label = document.getElementById('output-path-label');
    if (label) label.textContent = `${currentOutputDir}/${data.folderName}/`;
}

function formatIcon(format) {
    return {
        docx: 'ph-file-doc',
        pdf: 'ph-file-pdf',
        xlsx: 'ph-file-xls',
        pptx: 'ph-file-ppt',
    }[format] || 'ph-file-archive';
}

function renderMarkdownToPane(text) {
    const pane = document.getElementById('markdown-render');
    if (!text.trim()) {
        pane.innerHTML = `<div class="empty-state"><i class="ph ph-magic-wand"></i><p>转换后的内容将在此预览</p></div>`;
        return;
    }
    if (typeof marked === 'undefined') {
        pane.textContent = text;
        return;
    }
    let html = marked.parse(text);
    if (currentFolderName) {
        html = html.replace(
            /src="images\//g,
            `src="/output-files/${encodeURIComponent(currentFolderName)}/images/`,
        );
    }
    pane.innerHTML = html;
}

// ============================================================
// Binary card 操作（打开目录 / 另存为）
// ============================================================
function initBinaryCard() {
    document.getElementById('binary-open-folder').addEventListener('click', () => {
        if (!currentResult || !currentResult.outputPath) return;
        if (isElectron && window.electronAPI && window.electronAPI.openInFinder) {
            window.electronAPI.openInFinder(currentResult.outputPath);
        } else {
            showToast('请在 Electron 模式下使用，或前往: ' + currentResult.outputPath, 'info');
        }
    });

    document.getElementById('binary-save-as').addEventListener('click', async () => {
        if (!currentResult || !currentResult.outputPath) return;
        if (isElectron && window.electronAPI && window.electronAPI.saveAs) {
            const defaultName = currentResult.outputPath.split('/').pop();
            try {
                const p = await window.electronAPI.saveAs(currentResult.outputPath, defaultName);
                if (p) showToast(`已保存到 ${p}`, 'success');
            } catch (e) {
                showToast(`另存为失败：${e.message || e}`, 'error');
            }
        } else {
            // Web 模式：链接下载
            const folder = currentResult.folderName;
            const filename = currentResult.outputPath.split('/').pop();
            const a = document.createElement('a');
            a.href = `/output-files/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
        }
    });
}

// ============================================================
// 预览视图切换
// ============================================================
function initPreviewToggles() {
    const toggles = document.querySelectorAll('.toggle-btn');
    const body = document.getElementById('preview-body');
    toggles.forEach((btn) => {
        btn.addEventListener('click', () => {
            toggles.forEach((t) => t.classList.remove('active'));
            btn.classList.add('active');
            const v = btn.getAttribute('data-view');
            body.classList.remove('view-split', 'view-edit', 'view-render');
            body.classList.add(`view-${v}`);
        });
    });
}

// ============================================================
// 编辑器（保存 / 复制 / 导出）
// ============================================================
function initEditor() {
    const editor = document.getElementById('markdown-editor');
    if (!editor) return;

    editor.addEventListener('input', () => {
        if (currentFormat === 'md') {
            renderMarkdownToPane(editor.value);
        } else if (currentFormat === 'html') {
            document.getElementById('html-preview-frame').srcdoc = editor.value;
        } else if (currentFormat === 'json') {
            document.getElementById('json-preview').textContent = editor.value;
        }
    });

    document.getElementById('copy-btn').addEventListener('click', () => {
        if (!editor.value.trim()) return;
        navigator.clipboard.writeText(editor.value).then(() => {
            const btn = document.getElementById('copy-btn');
            const orig = btn.innerHTML;
            btn.innerHTML = '<i class="ph ph-check"></i> 已复制';
            setTimeout(() => { btn.innerHTML = orig; }, 1500);
        });
    });

    document.getElementById('save-btn').addEventListener('click', async () => {
        if (!editor.value.trim()) { showToast('没有可保存内容', 'warning'); return; }
        // 没做过转换时，从编辑器内容自动派生 folderName
        const folderName = currentFolderName || deriveFolderName(editor.value);
        const body = currentFormat === 'md'
            ? { markdown: editor.value, folderName }
            : { content: editor.value, folderName, format: currentFormat };
        try {
            const res = await fetch('/api/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const r = await res.json();
            if (r.success) {
                currentFolderName = folderName;   // 记住，便于后续多次保存/导出
                showToast(`已保存到 ${folderName}/`, 'success');
            } else {
                showToast(`保存失败：${r.error}`, 'error');
            }
        } catch (e) {
            showToast(`保存失败：${e.message}`, 'error');
        }
    });

    document.getElementById('export-btn').addEventListener('click', async () => {
        if (!editor.value.trim()) {
            showToast('编辑器没有内容', 'warning');
            return;
        }
        const target = await pickExportTarget();
        if (!target) return;
        // 没做过转换时，从编辑器内容自动派生 folderName
        const folderName = currentFolderName || deriveFolderName(editor.value);
        showLoading(true, '正在导出', `${currentFormat.toUpperCase()} → ${target.toUpperCase()}`);
        try {
            const res = await fetch('/api/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: editor.value,
                    sourceFormat: currentFormat,
                    targetFormat: target,
                    folderName,
                }),
            });
            const r = await res.json();
            showLoading(false);
            if (r.success) {
                currentFolderName = folderName;
                currentResult = { format: target, folderName, outputPath: r.path };
                showToast(`已导出 ${r.filename}`, 'success');
            } else {
                showToast(`导出失败：${r.error}`, 'error');
            }
        } catch (e) {
            showLoading(false);
            showToast(`导出失败：${e.message}`, 'error');
        }
    });
}

// 从编辑器内容派生 folderName（用户没做过转换时用）
function deriveFolderName(content) {
    const s = String(content || '');
    // 1) 优先取第一个 ATX H1（# 标题）
    const h1 = s.match(/^#\s+(.+)$/m);
    if (h1) return sanitizeBasename(h1[1]);
    // 2) 取第一行非空文本
    const firstLine = s.split('\n').map((l) => l.trim()).find((l) => l);
    if (firstLine) return sanitizeBasename(firstLine);
    // 3) 兜底
    return `untitled-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
}

function sanitizeBasename(name) {
    return String(name || '')
        .replace(/^#+\s*/, '')
        .replace(/[<>:"/\\|?*#]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 60) || `untitled-${Date.now()}`;
}

async function pickExportTarget() {
    // 简单：弹出 prompt 让用户选择目标格式
    const supported = ['md', 'json', 'docx', 'pdf']
        .filter((f) => f !== currentFormat);
    const choice = window.prompt(`导出为哪种格式？\n可选: ${supported.join(' / ')}`, 'docx');
    if (!choice) return null;
    const t = choice.trim().toLowerCase();
    if (!supported.includes(t)) {
        showToast(`不支持的目标格式：${t}`, 'error');
        return null;
    }
    return t;
}

// ============================================================
// 历史记录（localStorage）
// ============================================================
function saveToHistory(result) {
    try {
        const list = loadHistory();
        list.unshift({
            ts: Date.now(),
            folderName: result.folderName,
            format: result.format,
            title: result.title || result.folderName,
            outputPath: result.outputPath,
        });
        localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
        renderHistoryList();
    } catch (e) {}
}

function loadHistory() {
    try {
        return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    } catch (e) { return []; }
}

function renderHistoryList() {
    const list = document.getElementById('recent-conversions-list');
    if (!list) return;
    const items = loadHistory();
    if (items.length === 0) {
        list.innerHTML = '<p class="empty-state-mini">暂无记录</p>';
        return;
    }
    list.innerHTML = items.map((it, i) => `
        <div class="history-item" data-index="${i}">
            <div class="history-item-info">
                <div class="history-item-name">${escapeHtml(it.title || it.folderName)}</div>
                <div class="history-item-meta">${new Date(it.ts).toLocaleString('zh-CN')}</div>
            </div>
            <span class="history-item-format">${escapeHtml(it.format)}</span>
        </div>
    `).join('');
    list.querySelectorAll('.history-item').forEach((el) => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.index, 10);
            const it = items[idx];
            if (!it) return;
            // 简单：把信息回灌到 currentResult/folderName，让 binary card / save 能用
            currentFolderName = it.folderName;
            currentFormat = it.format;
            currentResult = it;
            const tag = document.getElementById('preview-kind-tag');
            if (tag) tag.textContent = (it.format || '').toUpperCase();
            showToast(`已恢复：${it.folderName}（点击"打开目录"或"另存为"操作产物）`, 'info');
            document.getElementById('settings-modal').classList.remove('active');
        });
    });
}

// ============================================================
// 设置弹窗
// ============================================================
function initSettings() {
    const modal = document.getElementById('settings-modal');
    const settingsBtn = document.getElementById('settingsBtn');
    const closeBtn = document.getElementById('close-settings');
    const saveBtn = document.getElementById('save-output-dir');
    const resetBtn = document.getElementById('reset-output-dir');
    const dirInput = document.getElementById('output-dir-input');
    const previewDir = document.getElementById('preview-dir');

    loadOutputDir();

    // 主题
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme === 'dark') applyTheme('dark');
    document.getElementById('theme-light').addEventListener('click', () => applyTheme('light'));
    document.getElementById('theme-dark').addEventListener('click', () => applyTheme('dark'));

    function open() {
        dirInput.value = currentOutputDir;
        previewDir.textContent = currentOutputDir;
        renderHistoryList();
        modal.classList.add('active');
    }

    settingsBtn.addEventListener('click', open);
    closeBtn.addEventListener('click', () => modal.classList.remove('active'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('active'); });
    dirInput.addEventListener('input', () => {
        previewDir.textContent = dirInput.value || '/path/to/output';
    });

    if (isElectron) {
        const inputWrapper = dirInput.closest('.settings-input-row');
        const browseBtn = document.createElement('button');
        browseBtn.className = 'btn btn-secondary';
        browseBtn.innerHTML = '<i class="ph ph-folder-open"></i> 浏览';
        browseBtn.style.marginTop = '8px';
        browseBtn.addEventListener('click', async () => {
            const dir = await window.electronAPI.selectDirectory();
            if (dir) {
                dirInput.value = dir;
                previewDir.textContent = dir;
            }
        });
        inputWrapper.appendChild(browseBtn);

        if (window.electronAPI.onSetOutputDir) {
            window.electronAPI.onSetOutputDir(async (dir) => {
                dirInput.value = dir;
                previewDir.textContent = dir;
                await persistOutputDir(dir);
            });
        }
    }

    saveBtn.addEventListener('click', async () => {
        const newDir = dirInput.value.trim();
        if (!newDir) { showToast('路径不能为空', 'warning'); return; }
        if (await persistOutputDir(newDir)) {
            modal.classList.remove('active');
            showToast('输出目录已更新', 'success');
        }
    });

    resetBtn.addEventListener('click', async () => {
        if (await persistOutputDir('./output')) {
            dirInput.value = currentOutputDir;
            previewDir.textContent = currentOutputDir;
            showToast('已恢复默认', 'success');
        }
    });
}

async function persistOutputDir(dir) {
    try {
        const res = await fetch('/api/settings/output-dir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir }),
        });
        const r = await res.json();
        if (r.success) {
            currentOutputDir = r.outputDir;
            updatePathLabel();
            return true;
        }
        showToast(r.error, 'error');
    } catch (e) {
        showToast(`保存失败：${e.message}`, 'error');
    }
    return false;
}

async function loadOutputDir() {
    try {
        const res = await fetch('/api/settings/output-dir');
        const r = await res.json();
        if (r.success) { currentOutputDir = r.outputDir; updatePathLabel(); }
    } catch (e) { console.warn(e); }
}

function updatePathLabel() {
    const label = document.getElementById('output-path-label');
    if (label) label.textContent = currentOutputDir;
}

function applyTheme(theme) {
    if (theme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.getElementById('theme-dark').classList.add('active');
        document.getElementById('theme-light').classList.remove('active');
    } else {
        document.documentElement.removeAttribute('data-theme');
        document.getElementById('theme-light').classList.add('active');
        document.getElementById('theme-dark').classList.remove('active');
    }
    localStorage.setItem(THEME_KEY, theme);
}

// ============================================================
// Markdown 工具栏（仅 kind-md 有效）
// ============================================================
function initToolbar() {
    const toolbar = document.getElementById('editor-toolbar');
    const editor = document.getElementById('markdown-editor');
    toolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('.toolbar-btn');
        if (!btn) return;
        applyToolbarAction(editor, btn.dataset.action);
    });
}

function applyToolbarAction(editor, action) {
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const text = editor.value;
    const selected = text.substring(start, end);
    let before = '', after = '', insert = '';

    switch (action) {
        case 'bold': before = '**'; after = '**'; insert = selected || '加粗文字'; break;
        case 'italic': before = '*'; after = '*'; insert = selected || '斜体文字'; break;
        case 'strikethrough': before = '~~'; after = '~~'; insert = selected || '删除线文字'; break;
        case 'h1': before = '\n# '; insert = selected || '一级标题'; break;
        case 'h2': before = '\n## '; insert = selected || '二级标题'; break;
        case 'h3': before = '\n### '; insert = selected || '三级标题'; break;
        case 'ul': before = '\n- '; insert = selected || '列表项'; break;
        case 'ol': before = '\n1. '; insert = selected || '列表项'; break;
        case 'quote': before = '\n> '; insert = selected || '引用文字'; break;
        case 'code': before = '\n```\n'; after = '\n```'; insert = selected || '代码'; break;
        case 'link': before = '['; after = '](url)'; insert = selected || '链接文字'; break;
        case 'image': before = '!['; after = '](url)'; insert = selected || '图片描述'; break;
        case 'table': insert = '\n| 标题1 | 标题2 | 标题3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n'; break;
        case 'hr': insert = '\n---\n'; break;
        default: return;
    }

    const replacement = before + insert + (after || '');
    editor.value = text.substring(0, start) + replacement + text.substring(end);
    editor.focus();
    editor.setSelectionRange(start + before.length, start + before.length + insert.length);
    if (currentFormat === 'md') renderMarkdownToPane(editor.value);
}

// ============================================================
// 快捷键
// ============================================================
function initKeyboardShortcuts() {
    const editor = document.getElementById('markdown-editor');
    document.addEventListener('keydown', (e) => {
        const isCtrl = e.ctrlKey || e.metaKey;
        if (isCtrl && e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('convert-btn').click();
            return;
        }
        if (isCtrl && e.key === 's') {
            e.preventDefault();
            document.getElementById('save-btn').click();
            return;
        }
        if (document.activeElement !== editor) return;
        if (isCtrl && e.key === 'b') { e.preventDefault(); applyToolbarAction(editor, 'bold'); }
        else if (isCtrl && e.key === 'i') { e.preventDefault(); applyToolbarAction(editor, 'italic'); }
        else if (isCtrl && e.key === 'k') { e.preventDefault(); applyToolbarAction(editor, 'link'); }
        else if (isCtrl && e.key === '`') { e.preventDefault(); applyToolbarAction(editor, 'code'); }
    });
}

// ============================================================
// 进度 UI / Toast / 文件大小
// ============================================================
function showLoading(show, title, desc) {
    const modal = document.getElementById('loading-modal');
    const batch = document.getElementById('batch-progress');
    if (show) {
        document.getElementById('loading-title').textContent = title || '正在转换';
        document.getElementById('loading-desc').textContent = desc || '请稍候...';
        batch.style.display = 'none';
        modal.classList.add('active');
    } else {
        modal.classList.remove('active');
    }
}

function showBatchProgressUI(total) {
    const modal = document.getElementById('loading-modal');
    const batch = document.getElementById('batch-progress');
    document.getElementById('loading-title').textContent = '批量转换中';
    document.getElementById('loading-desc').textContent = '准备中...';
    batch.style.display = 'flex';
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('progress-text').textContent = `0/${total}`;
    modal.classList.add('active');
}

function updateProgress(done, total, name) {
    const pct = total > 0 ? (done / total) * 100 : 0;
    const fill = document.getElementById('progress-fill');
    const text = document.getElementById('progress-text');
    if (fill) fill.style.width = pct + '%';
    if (text) text.textContent = `${done}/${total}`;
    if (name) document.getElementById('loading-desc').textContent = name;
}

function showToast(message, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: 'ph-check-circle', error: 'ph-x-circle', warning: 'ph-warning', info: 'ph-info' };
    toast.innerHTML = `<i class="ph ${icons[type] || icons.info}"></i><span>${escapeHtml(message)}</span>`;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3000);
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
