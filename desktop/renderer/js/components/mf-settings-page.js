/**
 * <mf-settings-page>：设置页。
 * 外观主题即时生效（mf:theme:set）；输出目录、默认目标、转换默认项、文件库模式经「保存设置」一次提交（mf:settings:set）；
 * MinerU 令牌单独保存 / 清除 / 测试连接（只显示「已配置 / 未配置」与测试结果，不回显令牌）。
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { icon } from '../icons.js';
import { escapeHtml, escapeAttr, targetLabel, THEME_LABELS } from '../dom.js';
import { notify } from './mf-toast.js';

const THEMES = Object.freeze(['system', 'light', 'dark']);
const THEME_ICONS = Object.freeze({ system: 'monitor', light: 'sun', dark: 'moon' });
const CLASS_LABELS = Object.freeze({ office: 'Office / PDF', markup: 'Markdown', url: '网页' });
const DEFAULT_FIELDS = Object.freeze([
    { key: 'theme', label: 'HTML 主题', enumKey: 'htmlThemes', placeholder: '主题默认（apple）' },
    { key: 'imageFormat', label: '图片格式', enumKey: 'imageFormats', placeholder: '默认（jpg）' },
    { key: 'pdfBackend', label: 'PDF 解析后端', enumKey: 'pdfBackends', placeholder: '默认（auto）' },
    { key: 'math', label: 'docx 公式', enumKey: 'mathModes', placeholder: '默认（image）' },
    { key: 'mineruModel', label: 'MinerU 模型', enumKey: 'mineruModels', placeholder: '默认（pipeline）' },
]);
const ENUM_LABELS = Object.freeze({
    jpg: 'JPG 归一', keep: '保持原格式',
    auto: '自动', mineru: 'MinerU 云端', local: '本地 pdfjs',
    image: '栅格为图片', text: '线性化文本',
    pipeline: 'pipeline', vlm: 'vlm',
});

const option = (value, label, selected) => `<option value="${escapeAttr(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;

class MfSettingsPage extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.lastSettings = null;
        this.innerHTML = `
            <header class="page-header"><h1>设置</h1></header>
            <div class="page-body settings-body">
                <section class="card">
                    <h2>外观</h2>
                    <div class="segmented" role="group" aria-label="外观主题">
                        ${THEMES.map((theme) => `<button class="segment" type="button" data-theme="${theme}">${icon(THEME_ICONS[theme])}${THEME_LABELS[theme]}</button>`).join('')}
                    </div>
                </section>
                <section class="card">
                    <h2>输出</h2>
                    <label class="field"><span>输出目录</span>
                        <span class="field-row"><input class="input" type="text" data-field="outputDir" spellcheck="false"><button class="btn btn-secondary" type="button" data-action="pick-output">${icon('folder')}选择</button></span>
                    </label>
                    <div class="field-grid" data-role="default-targets"></div>
                </section>
                <section class="card">
                    <h2>转换默认项</h2>
                    <div class="field-grid" data-role="defaults"></div>
                    <label class="field"><span>JPG 分辨率（PPI）</span><input class="input" type="number" min="72" max="600" step="1" data-field="jpegPpi" placeholder="330"></label>
                </section>
                <section class="card">
                    <h2>MinerU 令牌</h2>
                    <p class="hint">用于 PDF 云端解析；令牌经系统安全存储加密保存在本机，不会显示、不会写入日志。</p>
                    <div class="field-row">
                        <span class="status-pill" data-role="token-status">未配置</span>
                        <input class="input" type="password" data-field="token" placeholder="粘贴 MinerU API 令牌" autocomplete="off" spellcheck="false">
                    </div>
                    <div class="field-row">
                        <button class="btn btn-primary btn-small" type="button" data-action="save-token">${icon('key')}保存令牌</button>
                        <button class="btn btn-secondary btn-small" type="button" data-action="clear-token">清除</button>
                        <button class="btn btn-secondary btn-small" type="button" data-action="test-token">${icon('link')}测试连接</button>
                    </div>
                    <p class="mineru-result" data-role="token-result" hidden></p>
                </section>
                <section class="card">
                    <h2>文件库</h2>
                    <label class="field"><span>模式</span>
                        <select class="select" data-field="libraryMode">
                            <option value="index">索引模式：只记录产物位置</option>
                            <option value="managed">托管模式：新产物固定写入托管目录</option>
                        </select>
                    </label>
                    <label class="field"><span>托管根目录</span>
                        <span class="field-row"><input class="input" type="text" data-field="libraryRoot" spellcheck="false"><button class="btn btn-secondary" type="button" data-action="pick-library">${icon('folder')}选择</button></span>
                    </label>
                </section>
                <section class="card">
                    <h2>运行能力</h2>
                    <ul class="capabilities" data-role="capabilities"></ul>
                </section>
            </div>
            <footer class="page-footer">
                <div class="footer-summary" data-role="paths"></div>
                <div class="footer-actions"><button class="btn btn-primary" type="button" data-action="save">${icon('check')}保存设置</button></div>
            </footer>`;
        this.addEventListener('click', (event) => this.onClick(event));
        this.addEventListener('input', (event) => {
            if (event.target instanceof Element && event.target.matches('[data-field]') && event.target.dataset.field !== 'token') this.dirty = true;
        });
        this.unsubscribe = store.subscribe((state) => this.fill(state));
        this.fill(store.get());
    }

    disconnectedCallback() {
        if (this.unsubscribe) this.unsubscribe();
    }

    refresh() {
        this.dirty = false;
        api.settingsGet().then((described) => store.set({ settings: described })).catch((err) => notify(err.message, 'error'));
        api.describeFormats().then((formats) => store.set({ formats })).catch(() => undefined);
    }

    fill(state) {
        for (const button of this.querySelectorAll('.segment[data-theme]')) button.classList.toggle('is-active', button.dataset.theme === state.theme);
        this.renderCapabilities(state.formats, state.settings);
        const described = state.settings;
        if (!described || !described.settings) return;
        const tokenStatus = this.querySelector('[data-role="token-status"]');
        tokenStatus.textContent = described.mineruTokenConfigured ? '已配置' : '未配置';
        tokenStatus.dataset.state = described.mineruTokenConfigured ? 'on' : 'off';
        this.querySelector('[data-role="paths"]').textContent = `设置文件：${described.paths.settingsPath}`;
        if (described.settings === this.lastSettings || this.dirty) return;
        this.lastSettings = described.settings;
        const settings = described.settings;
        this.querySelector('[data-field="outputDir"]').value = settings.outputDir;
        this.querySelector('[data-field="libraryMode"]').value = settings.library.mode;
        this.querySelector('[data-field="libraryRoot"]').value = settings.library.root;
        this.querySelector('[data-field="jpegPpi"]').value = settings.defaults.jpegPpi != null ? settings.defaults.jpegPpi : 330;
        this.renderDefaultTargets(settings, state.formats);
        this.renderDefaults(settings, state.formats);
    }

    renderDefaultTargets(settings, formats) {
        const host = this.querySelector('[data-role="default-targets"]');
        const targets = formats && formats.targets ? formats.targets : { office: ['bundle', 'html', 'xml'], markup: ['docx', 'html', 'xml'], url: ['bundle', 'html', 'xml'] };
        host.innerHTML = Object.entries(CLASS_LABELS).map(([cls, label]) => {
            const allowed = Array.isArray(targets[cls]) ? targets[cls] : [];
            const current = settings.defaultTargets[cls];
            return `<label class="field"><span>${label} 默认目标</span><select class="select" data-field="target-${cls}">${allowed.map((target) => option(target, targetLabel(target), target === current)).join('')}</select></label>`;
        }).join('');
    }

    renderDefaults(settings, formats) {
        const host = this.querySelector('[data-role="defaults"]');
        const enums = formats && formats.options ? this.enumsFromOptions(formats.options) : {};
        host.innerHTML = DEFAULT_FIELDS.map(({ key, label, enumKey, placeholder }) => {
            const values = enums[enumKey] || [];
            const current = settings.defaults[key];
            return `<label class="field"><span>${label}</span><select class="select" data-field="default-${key}">${option('', placeholder, !current)}${values.map((value) => option(value, ENUM_LABELS[value] || value, value === current)).join('')}</select></label>`;
        }).join('');
    }

    /** 从 describeOptions() 的描述树取各枚举取值 */
    enumsFromOptions(options) {
        const pick = (node) => (node && Array.isArray(node.values) ? node.values : []);
        return {
            htmlThemes: pick(options.html && options.html.fields && options.html.fields.theme),
            imageFormats: pick(options.imageFormat),
            pdfBackends: pick(options.pdfBackend),
            mathModes: pick(options.math),
            mineruModels: pick(options.mineru && options.mineru.fields && options.mineru.fields.model),
        };
    }

    renderCapabilities(formats, described) {
        const host = this.querySelector('[data-role="capabilities"]');
        if (!formats || !formats.capabilities) {
            host.innerHTML = '<li>探测中…</li>';
            return;
        }
        const caps = formats.capabilities;
        const inProcess = formats.inProcess || {};
        const rows = [
            ['PDF 输出后端', caps.pdfBackend && caps.pdfBackend.available ? `可用（${caps.pdfBackend.name}${inProcess.pdf ? '，已注册进程内后端' : ''}）` : `不可用：${(caps.pdfBackend && caps.pdfBackend.hint) || ''}`, Boolean(caps.pdfBackend && caps.pdfBackend.available)],
            ['栅格化后端', caps.raster && caps.raster.available ? `可用（${caps.raster.name}${inProcess.raster ? '，已注册进程内后端' : ''}）` : `不可用：${(caps.raster && caps.raster.hint) || ''}`, Boolean(caps.raster && caps.raster.available)],
            ['MinerU 令牌', described && described.mineruTokenConfigured ? '已配置（桌面端安全存储）' : (caps.mineru && caps.mineru.configured ? `已配置（来源：${caps.mineru.source}）` : '未配置'), Boolean((described && described.mineruTokenConfigured) || (caps.mineru && caps.mineru.configured))],
            ['文件库', formats.library ? '已就绪' : '模块未就绪', Boolean(formats.library)],
            ['安全存储', described && described.encryptionAvailable ? '可用' : '不可用（无法保存令牌）', Boolean(described && described.encryptionAvailable)],
        ];
        host.innerHTML = rows.map(([name, text, ok]) => `<li><span>${escapeHtml(name)}</span><span class="status-pill" data-state="${ok ? 'on' : 'off'}">${escapeHtml(text)}</span></li>`).join('');
    }

    collectPatch() {
        const value = (selector) => this.querySelector(selector).value;
        const defaults = {};
        for (const { key } of DEFAULT_FIELDS) {
            const chosen = value(`[data-field="default-${key}"]`);
            defaults[key] = chosen ? chosen : null;
        }
        const ppi = value('[data-field="jpegPpi"]').trim();
        defaults.jpegPpi = ppi === '' ? null : Number(ppi);
        return {
            outputDir: value('[data-field="outputDir"]').trim(),
            defaultTargets: Object.fromEntries(Object.keys(CLASS_LABELS).map((cls) => [cls, value(`[data-field="target-${cls}"]`)])),
            defaults,
            library: { mode: value('[data-field="libraryMode"]'), root: value('[data-field="libraryRoot"]').trim() },
        };
    }

    async onClick(event) {
        const themeButton = event.target instanceof Element ? event.target.closest('.segment[data-theme]') : null;
        if (themeButton) {
            try {
                const res = await api.themeSet(themeButton.dataset.theme);
                store.set({ theme: res.theme, isDark: res.shouldUseDarkColors });
            } catch (err) {
                notify(err.message, 'error');
            }
            return;
        }
        const button = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
        if (!button) return;
        const tokenInput = this.querySelector('[data-field="token"]');
        try {
            switch (button.dataset.action) {
                case 'save': {
                    const described = await api.settingsSet(this.collectPatch());
                    this.dirty = false;
                    store.set({ settings: described });
                    notify('设置已保存', 'success');
                    break;
                }
                case 'pick-output': {
                    const res = await api.pickDirectory({ title: '选择输出目录', defaultPath: this.querySelector('[data-field="outputDir"]').value || undefined });
                    if (!res.canceled && res.path) { this.querySelector('[data-field="outputDir"]').value = res.path; this.dirty = true; }
                    break;
                }
                case 'pick-library': {
                    const res = await api.pickDirectory({ title: '选择托管根目录', defaultPath: this.querySelector('[data-field="libraryRoot"]').value || undefined });
                    if (!res.canceled && res.path) { this.querySelector('[data-field="libraryRoot"]').value = res.path; this.dirty = true; }
                    break;
                }
                case 'save-token': {
                    const token = tokenInput.value.trim();
                    if (!token) { notify('请先粘贴令牌', 'warning'); break; }
                    await api.setMineruToken(token);
                    tokenInput.value = '';
                    this.showTokenResult('令牌已加密保存', 'ok');
                    this.refresh();
                    break;
                }
                case 'clear-token':
                    await api.setMineruToken(null);
                    tokenInput.value = '';
                    this.showTokenResult('令牌已清除', 'ok');
                    this.refresh();
                    break;
                case 'test-token': {
                    button.disabled = true;
                    this.showTokenResult('正在测试连接…', 'info');
                    try {
                        const res = await api.testMineru(tokenInput.value.trim() || undefined);
                        this.showTokenResult(res.message, res.ok ? 'ok' : 'error');
                    } finally {
                        button.disabled = false;
                    }
                    break;
                }
                default: break;
            }
        } catch (err) {
            notify(err.message, 'error', 6000);
        }
    }

    showTokenResult(message, kind) {
        const el = this.querySelector('[data-role="token-result"]');
        el.hidden = false;
        el.textContent = message;
        el.dataset.kind = kind;
    }
}

customElements.define('mf-settings-page', MfSettingsPage);
