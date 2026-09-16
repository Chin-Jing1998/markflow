/**
 * <mf-settings-page>：设置页，抽屉式布局。
 * 左侧 .settings-nav 为分类栏（role="tablist"），右侧 .settings-panel 承载 7 张分区卡片，一次只显示一张；
 * 切换分类只改卡片的 hidden，未选中分区的节点一律保留在 DOM 中（原因见 selectSection 的注释）。
 * 页脚的「保存设置」与设置文件路径不随分类变化，任何分类下都可见。
 * 外观主题即时生效（mf:theme:set）；输出目录、默认目标、转换默认项、文件库模式经「保存设置」一次提交（mf:settings:set）；
 * MinerU 令牌单独保存 / 清除 / 测试连接（只显示「已配置 / 未配置」与测试结果，不回显令牌）；
 * 「关于」一节写明三端使用方法，并经 mf:update:check 取 GitHub 最新 release 与当前版本比对
 * （请求一律由主进程发起，渲染层既不发网络请求也不指定地址；挂载时读缓存，点按钮才强制重新检测）。
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

const REPOSITORY_URL = 'https://github.com/Chin-Jing1998/markflow';
const REPOSITORY_LABEL = 'github.com/Chin-Jing1998/markflow';
const ISSUES_URL = 'https://github.com/Chin-Jing1998/markflow/issues';
/** 更新检测四态 → .mineru-result 的显示档位（ok 绿 / error 红 / info 灰） */
const UPDATE_KINDS = Object.freeze({ latest: 'ok', 'update-available': 'info', unknown: 'info', failed: 'error' });

/**
 * 抽屉式设置页的 7 个分区：分类栏的每一项与同 key 的 <section class="card" data-section="…"> 一一对应。
 * data-section 同时是 app.css 的定位钩子（分段控件三等分、「转换默认项」三列网格都按它取），
 * 故 key 不可随意改名；顺序即分类栏与面板中的排列顺序。
 */
const SECTIONS = Object.freeze([
    { key: 'appearance', label: '外观', icon: 'sun' },
    { key: 'output', label: '输出', icon: 'folder' },
    { key: 'defaults', label: '转换默认项', icon: 'convert' },
    { key: 'mineru', label: 'MinerU 令牌', icon: 'key' },
    { key: 'library', label: '文件库', icon: 'library' },
    { key: 'capabilities', label: '运行能力', icon: 'monitor' },
    { key: 'about', label: '关于', icon: 'info' },
]);
const DEFAULT_SECTION = SECTIONS[0].key;

/**
 * 「关于」中的联系方式，逐条照录。
 * 邮箱不做成按钮：外链通道 mf:shell:openExternal 的入参校验只放行 http(s)
 * （desktop/main/ipc.js 的 EXTERNAL_URL_RE = /^https?:\/\//i），mailto: 会被直接拒掉，
 * 做成按钮等于点了没反应，故一律渲染为可选中复制的纯文本。
 */
const CONTACT_ROWS = Object.freeze([
    ['姓名', '张京京'],
    ['电话', '18291402342'],
    ['微信', 'China_Jing1998'],
    ['QQ', '3480989683'],
    ['邮箱', 'zhangjingjing962464@gmail.com'],
    ['邮箱', 'zhangjingjing962464@icloud.com'],
]);
const CONTACT_NOTE = '发现转换错漏、格式丢失或功能异常时，请提供源文件类型、目标格式与可复现步骤，以便定位；功能建议亦可经以下方式提交。';

/** 「关于」中的使用方法：事实以 README.md 为准，逐条为「标题 + 说明」两栏，复用 .capabilities 的排布 */
const USAGE_SECTIONS = Object.freeze([
    {
        title: '桌面端使用方法',
        items: [
            ['转换', '拖放文件或文件夹，或在「网页链接」框中每行粘贴一个 http／https 地址批量提交；任务列表实时显示进度与告警，并发为 2。'],
            ['对比预览', '左栏为来源、右栏为产物，侧边格式面板按目标切换可调字段；排版类改动实时重渲染，解析类改动在同一会话内重新解析后重渲染，确认后导出并写入文件库。'],
            ['阅读', '直接打开 .md、.html、.xml、.pdf 与 .json；.md 提供渲染｜原文｜编辑三页签，左侧打开记录按所在文件夹分组并可收藏。'],
            ['文件库', '默认索引模式只记录产物位置，可在上方「文件库」一节切换为托管模式并迁移既有产物；支持按来源类型、目标、月份、目录、标签与收藏分面筛选，以及搜索、定位、重新转换与删除。'],
            ['Markdown 编辑', '源码与实时预览左右分栏，工具栏含标题级别、加粗、斜体、列表、表格、链接、图片与脚注等；停止输入约 1 秒自动保存，⌘S 立即保存，文件被外部修改时提示覆盖保存或重新载入。'],
            ['文内查找', '⌘F 打开查找条，Enter 或 ⌘G 跳到下一处，⇧Enter 或 ⇧⌘G 跳到上一处，Esc 关闭。'],
        ],
    },
    {
        title: '命令行使用方法',
        items: [
            ['基本式', 'markflow convert <输入...> --to <目标> --out <目录>；目标取 bundle、docx、pdf、html、xml，省略 --to 时按输入类型取默认目标，--out 指定的目录必须已存在。'],
            ['常用旗标', '--json 让标准输出只有一行 JSON 结果；--theme 指定 html 与 pdf 的主题；--xml-profile patent 输出专利五书 XML；--pdf-backend auto|mineru|local 选择 PDF 解析后端；--validate 对 XML 产物做 DTD 校验；--concurrency 调整并发数，默认 2。'],
            ['网页正文提取', 'markflow extract <网址> 只返回 Markdown 正文与元数据，不落盘、不下载图片；--max-chars 调整正文字符上限，默认 5 万。'],
            ['示例', 'markflow convert 季度报告.docx --out ~/Documents/知识库'],
        ],
    },
    {
        title: 'MCP 使用方法',
        items: [
            ['convert_document', '转换本地文件或网页，返回结构与命令行 --json 一致。'],
            ['extract_article', '抓取网页并只返回正文 Markdown 与元数据，不落盘、不下载图片。'],
            ['list_formats', '返回输入与目标的对应矩阵、受理扩展名、可选主题与 XML profile，以及本机 PDF 后端、栅格化后端与 MinerU 令牌状态。'],
            ['在 Claude Code 中接入', '仓库根已有 .mcp.json，在该目录启动会话即自动识别；其它目录执行 claude mcp add markflow -- node /绝对路径/mcp/server.js。'],
        ],
    },
]);

const option = (value, label, selected) => `<option value="${escapeAttr(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;

const usageBlock = ({ title, items }) => `<details class="about-block">
    <summary>${escapeHtml(title)}</summary>
    <ul class="capabilities">${items.map(([name, text]) => `<li><span><strong>${escapeHtml(name)}</strong>：${escapeHtml(text)}</span></li>`).join('')}</ul>
</details>`;

/** 分类栏的一项：roving tabindex，只有当前项可 Tab 进入，其余靠 ↑／↓ 与 Home／End 到达 */
const navItem = ({ key, label, icon: iconName }, index) => `<button class="settings-nav-item" type="button" role="tab"
    id="settings-tab-${key}" aria-controls="settings-panel-${key}"
    aria-selected="${index === 0 ? 'true' : 'false'}" tabindex="${index === 0 ? '0' : '-1'}"
    data-section-tab="${key}">${icon(iconName)}<span>${escapeHtml(label)}</span></button>`;

/** 分区卡片：非当前分区只置 hidden 不拆节点，理由见 MfSettingsPage.selectSection 的注释 */
const sectionCard = (key, inner) => `<section class="card" data-section="${key}" role="tabpanel"
    id="settings-panel-${key}" aria-labelledby="settings-tab-${key}"${key === DEFAULT_SECTION ? '' : ' hidden'}>${inner}</section>`;

const contactBlock = () => `<div class="about-block">
    <h3>联系与反馈</h3>
    <p class="hint">${escapeHtml(CONTACT_NOTE)}</p>
    <ul class="capabilities">${CONTACT_ROWS.map(([name, value]) => `<li><span>${escapeHtml(name)}</span><span class="contact-value">${escapeHtml(value)}</span></li>`).join('')}</ul>
    <div class="field-row"><button class="btn btn-secondary btn-small" type="button" data-action="open-issues">${icon('open')}提交 Issue</button></div>
</div>`;

class MfSettingsPage extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.lastSettings = null;
        this.updateUrl = null;
        this.innerHTML = `
            <header class="page-header"><h1>设置</h1></header>
            <div class="page-body settings-body">
                <div class="settings-nav" role="tablist" aria-label="设置分类" aria-orientation="vertical">
                    ${SECTIONS.map(navItem).join('')}
                </div>
                <div class="settings-panel">
                ${sectionCard('appearance', `
                    <h2>外观</h2>
                    <div class="segmented" role="group" aria-label="外观主题">
                        ${THEMES.map((theme) => `<button class="segment" type="button" data-theme="${theme}">${icon(THEME_ICONS[theme])}${THEME_LABELS[theme]}</button>`).join('')}
                    </div>`)}
                ${sectionCard('output', `
                    <h2>输出</h2>
                    <label class="field"><span>输出目录</span>
                        <span class="field-row"><input class="input" type="text" data-field="outputDir" spellcheck="false"><button class="btn btn-secondary" type="button" data-action="pick-output">${icon('folder')}选择</button></span>
                    </label>
                    <div class="field-grid" data-role="default-targets"></div>`)}
                ${sectionCard('defaults', `
                    <h2>转换默认项</h2>
                    <div class="field-grid" data-role="defaults"></div>
                    <label class="field"><span>JPG 分辨率（PPI）</span><input class="input" type="number" min="72" max="600" step="1" data-field="jpegPpi" placeholder="330"></label>`)}
                ${sectionCard('mineru', `
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
                    <p class="mineru-result" data-role="token-result" hidden></p>`)}
                ${sectionCard('library', `
                    <h2>文件库</h2>
                    <label class="field"><span>模式</span>
                        <select class="select" data-field="libraryMode">
                            <option value="index">索引模式：只记录产物位置</option>
                            <option value="managed">托管模式：新产物固定写入托管目录</option>
                        </select>
                    </label>
                    <label class="field"><span>托管根目录</span>
                        <span class="field-row"><input class="input" type="text" data-field="libraryRoot" spellcheck="false"><button class="btn btn-secondary" type="button" data-action="pick-library">${icon('folder')}选择</button></span>
                    </label>`)}
                ${sectionCard('capabilities', `
                    <h2>运行能力</h2>
                    <ul class="capabilities" data-role="capabilities"></ul>`)}
                ${sectionCard('about', `
                    <h2>关于</h2>
                    <p class="hint">MarkFlow 是文档转换工具：把办公文档、PDF 与网页转成 Markdown 知识库包，把 Markdown 转成 Word 或 PDF，并把以上全部输入转成 HTML 或 XML（含国家知识产权局专利五书 XML）。桌面端、命令行与 MCP 三个入口共用同一套转换内核。</p>
                    <ul class="capabilities">
                        <li><span>当前版本</span><span class="status-pill" data-role="app-version">读取中…</span></li>
                        <li><span>开源许可</span><span class="status-pill">MIT</span></li>
                        <li><span>代码仓库</span><button class="link-btn" type="button" data-action="open-repo">${REPOSITORY_LABEL}</button></li>
                    </ul>
                    <div class="field-row">
                        <button class="btn btn-secondary btn-small" type="button" data-action="check-update">${icon('refresh')}检测更新</button>
                        <button class="link-btn" type="button" data-action="open-release" hidden>${icon('open')}前往下载</button>
                    </div>
                    <p class="mineru-result" data-role="update-result" hidden></p>
                    <p class="hint">检测更新会向 GitHub（api.github.com）发送一次请求，取最新发布版本号与当前版本比对，不上传任何本机信息。应用启动时自动检测一次，结果缓存 24 小时；点击「检测更新」则立即重新检测。网络不通时只在此处提示检测失败，不影响其它功能。</p>
                    ${USAGE_SECTIONS.map(usageBlock).join('')}
                    ${contactBlock()}`)}
                </div>
            </div>
            <footer class="page-footer">
                <div class="footer-summary" data-role="paths"></div>
                <div class="footer-actions"><button class="btn btn-primary" type="button" data-action="save">${icon('check')}保存设置</button></div>
            </footer>`;
        this.addEventListener('click', (event) => this.onClick(event));
        this.addEventListener('keydown', (event) => this.onNavKeydown(event));
        this.addEventListener('input', (event) => {
            if (event.target instanceof Element && event.target.matches('[data-field]') && event.target.dataset.field !== 'token') this.dirty = true;
        });
        this.unsubscribe = store.subscribe((state) => this.fill(state));
        this.fill(store.get());
        // 不强制：启动时主进程已自动检测过，24 小时内直接回缓存，不会重复请求 GitHub
        this.loadUpdate({ force: false });
    }

    disconnectedCallback() {
        if (this.unsubscribe) this.unsubscribe();
    }

    /**
     * 切换分类：只改卡片的 hidden，绝不移除或重建卡片节点。
     * 原因：collectPatch() 以 this.querySelector('[data-field=…]') 一次性读取输出目录、三类默认目标、
     * 转换默认项与文件库四组值，而这些字段分散在「输出」「转换默认项」「文件库」三个分区中，
     * 依赖全部 [data-field] 始终留在 DOM 里可被查询。若切换时销毁未选中分区的节点，
     * 用户切到「关于」再点「保存设置」，这些 querySelector 就会取到 null 或空值，
     * 把输出目录与转换默认项一并清空后写回设置文件。故本方法只做显隐，不做增删。
     */
    selectSection(key, { focus = false } = {}) {
        for (const tab of this.querySelectorAll('[data-section-tab]')) {
            const active = tab.dataset.sectionTab === key;
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            tab.tabIndex = active ? 0 : -1;          // roving tabindex：只有当前项在 Tab 序列里
            if (active && focus) tab.focus();
        }
        for (const card of this.querySelectorAll('[data-section]')) card.hidden = card.dataset.section !== key;
        const panel = this.querySelector('.settings-panel');
        if (panel) panel.scrollTop = 0;
    }

    /** 分类栏内的键盘操作：↑／↓ 在分类间循环移动并即时切换，Home／End 跳首末 */
    onNavKeydown(event) {
        const tab = event.target instanceof Element ? event.target.closest('[data-section-tab]') : null;
        if (!tab) return;
        const step = { ArrowUp: -1, ArrowDown: 1 }[event.key];
        const current = SECTIONS.findIndex((section) => section.key === tab.dataset.sectionTab);
        let next = -1;
        if (step !== undefined && current >= 0) next = (current + step + SECTIONS.length) % SECTIONS.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = SECTIONS.length - 1;
        if (next < 0) return;
        event.preventDefault();
        this.selectSection(SECTIONS[next].key, { focus: true });
    }

    refresh() {
        this.dirty = false;
        api.settingsGet().then((described) => store.set({ settings: described })).catch((err) => notify(err.message, 'error'));
        api.describeFormats().then((formats) => store.set({ formats })).catch(() => undefined);
    }

    fill(state) {
        for (const button of this.querySelectorAll('.segment[data-theme]')) button.classList.toggle('is-active', button.dataset.theme === state.theme);
        this.renderCapabilities(state.formats, state.settings);
        this.renderVersion(state.formats);
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

    /** 版本号取自 describeFormats 的 version（即 package.json 的 version），未拿到时先留占位 */
    renderVersion(formats) {
        const version = formats && typeof formats.version === 'string' ? formats.version : '';
        this.querySelector('[data-role="app-version"]').textContent = version || '读取中…';
    }

    /**
     * 更新检测：force 为假时读主进程的 24 小时缓存（挂载即调，不额外请求 GitHub）；
     * force 为真时立即重新检测。自动检测失败保持静默，手动检测把失败原因显示在原处。
     */
    async loadUpdate({ force }) {
        const button = this.querySelector('[data-action="check-update"]');
        if (force) {
            button.disabled = true;
            this.showUpdateResult('正在向 GitHub 检测更新…', 'info');
        }
        try {
            this.renderUpdate(await api.updateCheck(force));
        } catch (err) {
            if (force) this.showUpdateResult(`检测失败：${err.message}`, 'error');
        } finally {
            if (force) button.disabled = false;
        }
    }

    /** 下载链接只在「有新版本」时给出，取值已由主进程按仓库前缀校验过 */
    renderUpdate(result) {
        if (!result || typeof result.message !== 'string') return;
        this.updateUrl = result.status === 'update-available' && typeof result.url === 'string' ? result.url : null;
        this.querySelector('[data-action="open-release"]').hidden = !this.updateUrl;
        this.showUpdateResult(result.message, UPDATE_KINDS[result.status] || 'info');
    }

    showUpdateResult(message, kind) {
        const el = this.querySelector('[data-role="update-result"]');
        el.hidden = false;
        el.textContent = message;
        el.dataset.kind = kind;
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
        const navTab = event.target instanceof Element ? event.target.closest('[data-section-tab]') : null;
        if (navTab) {
            this.selectSection(navTab.dataset.sectionTab);
            return;
        }
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
                case 'check-update':
                    await this.loadUpdate({ force: true });
                    break;
                case 'open-repo':
                    await api.openExternal(REPOSITORY_URL);
                    break;
                case 'open-issues':
                    await api.openExternal(ISSUES_URL);
                    break;
                case 'open-release':
                    if (this.updateUrl) await api.openExternal(this.updateUrl);
                    break;
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
