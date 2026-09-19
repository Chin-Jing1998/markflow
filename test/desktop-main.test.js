/**
 * desktop/main/index.js 与纯逻辑模块的无副作用测试（普通 Node，不依赖 Electron）
 * 覆盖：普通 Node 中 require 入口不启动、不创建窗口、导出 _internal；shouldBootstrap 判定；
 *       window.js 三平台参数；menu.js 模板；chromium-jobs.js 的打印参数与任务校验；preload 语法。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('普通 Node 中 require 入口无副作用，仅导出 _internal', () => {
    let electronExport;
    try {
        electronExport = require('electron');
    } catch (err) {
        electronExport = null;
    }
    assert.ok(electronExport === null || typeof electronExport === 'string', '普通 Node 里 require(electron) 应为路径字符串');
    const mod = require('../desktop/main/index');
    assert.deepEqual(Object.keys(mod), ['_internal']);
    const internal = mod._internal;
    assert.equal(internal.loadElectron(), null);
    assert.equal(internal.shouldBootstrap(null), false);
    assert.equal(internal.APP_URL, 'mf-app://app/');
    assert.equal(internal.RENDERER_DIR, path.join(__dirname, '..', 'desktop', 'renderer'));
    assert.equal(internal.PRELOAD_PATH, path.join(__dirname, '..', 'desktop', 'preload.js'));
    assert.ok(fs.existsSync(path.join(internal.RENDERER_DIR, 'index.html')));
    assert.ok(fs.existsSync(internal.PRELOAD_PATH));
    assert.ok(fs.existsSync(internal.ICON_PNG));
    assert.deepEqual([...internal.PERMISSIONS_ALLOWED], ['clipboard-sanitized-write']);
});

test('shouldBootstrap：仅 Electron 主进程且为入口（或 process.type 为 browser）时启动', () => {
    const { shouldBootstrap } = require('../desktop/main/index')._internal;
    const fakeElectron = { app: {} };
    const a = {};
    const b = {};
    assert.equal(shouldBootstrap(fakeElectron, { mainModule: a, currentModule: b, processType: undefined }), false);
    assert.equal(shouldBootstrap(fakeElectron, { mainModule: a, currentModule: a, processType: undefined }), true);
    assert.equal(shouldBootstrap(fakeElectron, { mainModule: a, currentModule: b, processType: 'browser' }), true);
    assert.equal(shouldBootstrap(null, { mainModule: a, currentModule: a, processType: 'browser' }), false);
});

test('loadLibraryModules 与 defaultDirs', () => {
    const { loadLibraryModules, defaultDirs } = require('../desktop/main/index')._internal;
    const mods = loadLibraryModules(() => undefined);
    assert.ok(mods && typeof mods.library.createLibrary === 'function');
    assert.ok(typeof mods.migrate.planMigration === 'function' && typeof mods.migrate.runMigration === 'function');
    const dirs = defaultDirs({ getPath: (name) => (name === 'documents' ? '/tmp/docs' : '/tmp/other') });
    assert.deepEqual(dirs, { outputDir: path.join('/tmp/docs', 'MarkFlow'), libraryRoot: path.join('/tmp/docs', 'MarkFlow Library') });
    const fallback = defaultDirs({ getPath: () => { throw new Error('no documents'); } });
    assert.ok(fallback.outputDir.endsWith('MarkFlow'));
});

test('window.js：三平台窗口参数照 R4 结论', () => {
    const { windowOptionsFor, supportsMica, windowsBuildOf, backgroundFor, overlayFor, TITLEBAR_HEIGHT } = require('../desktop/main/window');
    const mac = windowOptionsFor({ platform: 'darwin', isDark: true, preloadPath: '/p/preload.js' });
    assert.equal(mac.titleBarStyle, 'hiddenInset');
    assert.deepEqual(mac.trafficLightPosition, { x: 16, y: 8 });
    assert.equal(mac.vibrancy, 'sidebar');
    assert.equal(mac.visualEffectState, 'active');
    assert.equal(mac.transparent, false);
    assert.equal(mac.roundedCorners, true);
    assert.equal(mac.backgroundColor, '#1c1c1e');
    assert.equal(mac.show, false);
    assert.equal(mac.backgroundMaterial, undefined);
    assert.deepEqual(mac.webPreferences, { preload: '/p/preload.js', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, plugins: true, spellcheck: false });

    const win11 = windowOptionsFor({ platform: 'win32', isDark: false, osRelease: '10.0.22631' });
    assert.equal(win11.titleBarStyle, 'hidden');
    assert.deepEqual(win11.titleBarOverlay, { color: '#f5f5f7', symbolColor: '#1c1c1e', height: TITLEBAR_HEIGHT });
    assert.equal(win11.backgroundMaterial, 'mica');
    assert.equal(win11.vibrancy, undefined);

    const win10 = windowOptionsFor({ platform: 'win32', isDark: true, osRelease: '10.0.19045' });
    assert.equal(win10.backgroundMaterial, undefined, 'Win10 纯色回退');
    assert.equal(win10.backgroundColor, '#1c1c1e');
    assert.equal(win10.titleBarOverlay.symbolColor, '#f5f5f7');

    const linux = windowOptionsFor({ platform: 'linux' });
    assert.equal(linux.titleBarStyle, undefined);
    assert.equal(supportsMica('win32', '10.0.22621'), true);
    assert.equal(supportsMica('win32', '10.0.22000'), false);
    assert.equal(supportsMica('darwin', '24.0.0'), false);
    assert.equal(windowsBuildOf('garbage'), 0);
    assert.equal(backgroundFor(true), '#1c1c1e');
    assert.equal(overlayFor(false).height, 52);
});

test('menu.js：中文菜单模板与主题 radio 选中态', () => {
    const { buildMenuTemplate } = require('../desktop/main/menu');
    const calls = [];
    const template = buildMenuTemplate({ platform: 'darwin', theme: 'dark', actions: { setTheme: (value) => calls.push(value), openFiles: () => calls.push('open') } });
    assert.deepEqual(template.map((item) => item.label), ['MarkFlow', '文件', '编辑', '视图', '窗口', '帮助']);
    const fileMenu = template[1].submenu;
    assert.equal(fileMenu[0].label, '打开文件…');
    assert.equal(fileMenu[0].accelerator, 'CmdOrCtrl+O');
    fileMenu[0].click();
    assert.deepEqual(calls, ['open']);
    const appearance = template[3].submenu[0];
    assert.equal(appearance.label, '外观');
    assert.deepEqual(appearance.submenu.map((item) => [item.label, item.type, item.checked]), [['跟随系统', 'radio', false], ['浅色', 'radio', false], ['深色', 'radio', true]]);
    appearance.submenu[1].click();
    assert.deepEqual(calls, ['open', 'light']);

    const win = buildMenuTemplate({ platform: 'win32', theme: 'system' });
    assert.deepEqual(win.map((item) => item.label), ['文件', '编辑', '视图', '窗口', '帮助']);
    assert.equal(win[0].submenu[win[0].submenu.length - 1].role, 'quit');
    assert.doesNotThrow(() => win[0].submenu[0].click(), '缺省动作可安全调用');
});

test('chromium-jobs.js：打印参数与任务表校验（不需要 Electron）', () => {
    const jobs = require('../desktop/main/chromium-jobs');
    assert.deepEqual(jobs.buildPrintOptions(undefined), {
        printBackground: true, pageSize: 'A4', margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }, preferCSSPageSize: true,
    });
    assert.deepEqual(jobs.buildPrintOptions({ pageSize: 'Letter', landscape: true, margins: { top: 1, bottom: 9, left: -1, right: 'x' } }), {
        printBackground: true, pageSize: 'Letter', landscape: true, margins: { top: 1, bottom: 0.6, left: 0.6, right: 0.6 }, preferCSSPageSize: false,
    });
    assert.equal(jobs.buildPrintOptions({ pageSize: 'A3' }).pageSize, 'A4');
    assert.deepEqual(jobs.validateJobs([{ id: 'table-1', html: '<p>x</p>', extra: 1 }]), [{ id: 'table-1', html: '<p>x</p>' }]);
    assert.throws(() => jobs.validateJobs([{ id: '../x', html: 'y' }]), /id 非法/);
    assert.throws(() => jobs.validateJobs([{ id: 'a', html: 'y' }, { id: 'a', html: 'z' }]), /重复/);
    assert.throws(() => jobs.validateJobs([{ id: 'a', html: '' }]), /缺少 html/);
    assert.throws(() => jobs.validateJobs('nope'), /任务数组/);
    assert.equal(jobs.clampDpi(undefined), 300);
    assert.equal(jobs.clampDpi(5000), 2400);
    assert.deepEqual(jobs.fitScale({ width: 100, height: 50 }, 3.125), { scale: 3.125, capped: false });
    assert.equal(jobs.fitScale({ width: 10000, height: 50 }, 3.125).capped, true);
    assert.equal(jobs.IN_PROCESS_NAME, 'in-process');
    assert.equal(jobs.JOB_PARTITION, 'markflow-jobs');
    assert.equal(jobs.LOCAL_URL_RE.test('https://example.com/x'), false);
    assert.equal(jobs.LOCAL_URL_RE.test('file:///tmp/x.html'), true);
    assert.throws(() => jobs.createChromiumJobs(null), /Electron 主进程/);
});

test('preload.js 只 require electron，且事件通道白名单为三个', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(requires)], ['electron']);
    assert.match(src, /EVENT_CHANNELS = Object\.freeze\(\['mf:convert:event', 'mf:theme:changed', 'mf:preview:event'\]\)/);
    assert.ok(!src.includes('exposeInMainWorld(\'ipcRenderer\''), '不暴露 ipcRenderer 本体');
});

test('渲染层：页面与模块文件齐备，脚本以 ES 模块加载', () => {
    const rendererDir = path.join(__dirname, '..', 'desktop', 'renderer');
    const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
    const sidebar = fs.readFileSync(path.join(rendererDir, 'js', 'components', 'mf-sidebar.js'), 'utf8');
    const statusBar = fs.readFileSync(path.join(rendererDir, 'js', 'components', 'mf-status-bar.js'), 'utf8');
    assert.match(html, /<script type="module" src="js\/app\.js"><\/script>/);
    assert.ok(!/<meta http-equiv="Content-Security-Policy"/.test(html), 'CSP 由协议处理器响应头下发，页面不重复声明');
    assert.match(html, /<mf-status-bar class="status-bar"[^>]*><\/mf-status-bar>\s*<mf-sidebar/, '状态栏应位于左标签栏与内容区之前');
    assert.ok(!sidebar.includes('brand-app-icon'), '左标签栏不应显示品牌图标');
    assert.ok(!sidebar.includes('brand-mark'), '左标签栏不应再使用 CSS 绘制的旧标志');
    assert.match(statusBar, /status-bar-brand.*MarkFlow/s, '顶部状态栏应仅显示居中的 MarkFlow');
    assert.ok(!statusBar.includes('就绪'), '顶部状态栏不应显示就绪状态');
    for (const rel of ['css/tokens.css', 'css/app.css', 'js/app.js', 'js/api.js', 'js/store.js', 'js/dom.js', 'js/icons.js', 'js/url-lines.mjs', 'js/md-format.mjs', 'js/library-paths.mjs']) {
        assert.ok(fs.existsSync(path.join(rendererDir, rel)), rel);
    }
    const components = fs.readdirSync(path.join(rendererDir, 'js', 'components')).sort();
    assert.deepEqual(components, [
        'mf-compare-view.js', 'mf-convert-page.js', 'mf-doc-bar.js', 'mf-dropzone.js', 'mf-facets.js', 'mf-format-panel.js',
        'mf-library-page.js', 'mf-md-editor.js', 'mf-product-pane.js', 'mf-progress.js', 'mf-reader-page.js', 'mf-settings-page.js',
        'mf-sidebar.js', 'mf-source-pane.js', 'mf-status-bar.js', 'mf-task-list.js', 'mf-toast.js', 'mf-url-input.js',
    ]);
    // Markdown 编辑器：工具栏按钮只用 data-cmd，不得带 data-action / data-tab（否则被宿主页面的点击委托截走）
    const editor = fs.readFileSync(path.join(rendererDir, 'js', 'components', 'mf-md-editor.js'), 'utf8');
    assert.ok(!editor.includes('data-action'), 'mf-md-editor 不得使用 data-action');
    assert.ok(!/data-tab[=\s"]/.test(editor), 'mf-md-editor 不得使用 data-tab');
    // 事件订阅白名单不因编辑功能扩大；编辑相关的三个调用只走 invoke
    const preload = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'preload.js'), 'utf8');
    for (const channel of ['mf:md:render', 'mf:md:save', 'mf:md:insertImage', 'mf:file:action']) assert.ok(preload.includes(`invoke('${channel}'`), channel);
});

const RENDERER_DIR = path.join(__dirname, '..', 'desktop', 'renderer');
const readComponent = (name) => fs.readFileSync(path.join(RENDERER_DIR, 'js', 'components', name), 'utf8');

/** dom.js 不含 import，按 data: URL 以 ES 模块载入，免去 package.json 无 type 字段时的模块类型探测告警 */
async function loadDomModule() {
    const src = fs.readFileSync(path.join(RENDERER_DIR, 'js', 'dom.js'), 'utf8');
    return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

test('专利五书反向导入的界面接线：拖放区说明、转换页底栏开关与格式面板字段各就各位', () => {
    const dropzone = readComponent('mf-dropzone.js');
    assert.match(dropzone, /\.xml[\s\S]{0,40}\.zip[\s\S]{0,40}五书目录/, '拖放区应说明新受理的三种输入');

    const convertPage = readComponent('mf-convert-page.js');
    assert.match(convertPage, /data-role="import-numbers-field"[\s\S]*?data-field="xmlImportParagraphNumbers"/, '底栏应有导入段号开关');
    assert.match(convertPage, /title="[^"]*审查意见[^"]*增删段落[^"]*"/, '开关文案须同时说明用途与代价');
    assert.match(convertPage, /IMPORT_TYPES = new Set\(\['xml', 'zip'\]\)/, '只对五书输入露出该开关');
    assert.ok(!convertPage.includes('data-field="validate"]\').checked'), '底栏开关统一由 footerOptions 收集');
    // 字段表已下沉到 format-options.mjs，其内容由 desktop-format-options.test.js 直接按对象断言
});

test('转换页底栏的「XML 方言」下拉：取值与默认值来自描述树，随 xml 目标露出，随本批选项提交', () => {
    const convertPage = readComponent('mf-convert-page.js');
    assert.match(convertPage, /data-role="xml-profile-field"[\s\S]*?data-field="xmlProfile"/, '底栏应有 XML 方言下拉');
    assert.match(convertPage, /xmlProfileNode\(state\)[\s\S]*?tree\.xml\.fields \? tree\.xml\.fields\.profile : null/, '取值范围取自描述树');
    assert.ok(!/\bvalues = \['generic', 'patent'\]/.test(convertPage), '页面不得硬编码方言取值');
    assert.match(convertPage, /field\.hidden = !node \|\| !pendingTasks\.some\(\(task\) => task\.target === 'xml'\)/, '只在队列里有 xml 任务时露出');
    // 底栏收集：复选框只在勾选时提交，下拉提交其取值；隐藏的控件一律不参与本批
    assert.match(convertPage, /control\.type === 'checkbox'[\s\S]*?control\.value !== ''/, 'footerOptions 需同时处理复选框与下拉');
    assert.match(convertPage, /if \(control\.closest\('\.footer-option'\)\.hidden\) continue;/, '隐藏的底栏控件不参与本批');

    const settingsPage = readComponent('mf-settings-page.js');
    assert.match(settingsPage, /key: 'xmlProfile', label: 'XML 方言', enumKey: 'xmlProfiles'/, '设置页默认项应含 XML 方言');
    assert.match(settingsPage, /xmlProfiles: pick\(options\.xml && options\.xml\.fields && options\.xml\.fields\.profile\)/, '设置页取值同样取自描述树');
});

test('渲染层的 INPUT_CLASS 副本与内核 converters/targets 逐键一致（两份表不得漂移）', async () => {
    const { INPUT_CLASS } = require('../converters/targets');
    const dom = await loadDomModule();
    assert.deepEqual(dom.INPUT_CLASS, { ...INPUT_CLASS }, '渲染层按类别取可选目标，漏一个输入类型就会让该输入选不到目标');
    // 专利五书反向导入的三种输入都归 markup：五书目录没有扩展名，主进程按目录签名判定后同样以 xml 下发
    assert.equal(dom.INPUT_CLASS.xml, 'markup');
    assert.equal(dom.INPUT_CLASS.zip, 'markup');
    assert.equal(dom.classOf('zip'), 'markup');
    assert.equal(dom.classOf('未知类型'), null);
});

test('渲染层类型标签：xml / zip 有中文标签，kind 为 bundle 时显示「专利五书目录」', async () => {
    const dom = await loadDomModule();
    assert.equal(dom.typeLabel('xml'), '专利 XML');
    assert.equal(dom.typeLabel('zip'), '专利案卷');
    assert.equal(dom.typeLabel('xml', 'bundle'), '专利五书目录', 'kind 优先于 type');
    assert.equal(dom.typeLabel('docx', 'file'), 'Word', '普通文件的 kind 不改标签');
    assert.equal(dom.typeLabel('docx'), 'Word', '既有调用只传一个参数，行为不变');
});

test('视图帧外观：adaptive 注入深色覆盖样式，paper 与缺省不注入，src 帧（PDF）不注入', async () => {
    const dom = await loadDomModule();
    const page = '<!DOCTYPE html><html><head><title>t</title></head><body><p>x</p></body></html>';
    assert.match(dom.withFrameAppearance(page), /<style data-markflow-appearance>[\s\S]*prefers-color-scheme: dark[\s\S]*<\/style><\/head>/);
    assert.ok(dom.withFrameAppearance('<p>x</p>').startsWith('<style data-markflow-appearance>'), '无 </head> 时前置');
    const previous = globalThis.document;
    globalThis.document = { createElement: () => ({ dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }) };
    try {
        const adaptive = dom.createViewFrame({ srcdoc: page, appearance: 'adaptive' });
        assert.equal(adaptive.dataset.appearance, 'adaptive');
        assert.ok(adaptive.srcdoc.includes('data-markflow-appearance'));
        const paper = dom.createViewFrame({ srcdoc: page, appearance: 'paper' });
        assert.equal(paper.dataset.appearance, 'paper');
        assert.equal(paper.srcdoc, page);
        const plain = dom.createViewFrame({ srcdoc: page, appearance: 'unknown' });
        assert.equal(plain.dataset.appearance, undefined, '未知取值不写 data-appearance');
        assert.equal(plain.srcdoc, page);
        const pdf = dom.createViewFrame({ src: 'mf-asset://s/a.pdf', appearance: 'adaptive' });
        assert.equal(pdf.srcdoc, undefined, 'src 帧无法注入');
        assert.equal(pdf.attributes.sandbox, undefined, 'PDF 帧仍不带 sandbox');
    } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
    // 原文文本视图整篇是一个 <pre>：其自身 background:none 的优先级高于注入样式，深色下不会被加上代码块底色
    assert.match(dom.textDocument('a'), /body > pre \{[^}]*background: none/);
});

test('页签：三处 .pane-tab（文档状态栏视图分段、对比预览两栏）均带 role="tab" 与 aria-selected，is-active 写在 class 引号内', () => {
    for (const name of ['mf-doc-bar.js', 'mf-product-pane.js', 'mf-source-pane.js']) {
        const buttons = readComponent(name).match(/<button class="pane-tab[^>]*>/g) || [];
        assert.ok(buttons.length > 0, `${name} 应渲染 .pane-tab`);
        for (const button of buttons) {
            assert.match(button, /class="pane-tab\$\{[^}]*' is-active'[^}]*\}"/, `${name}：is-active 须在 class 引号内`);
            assert.match(button, /role="tab"/, `${name}：role="tab"`);
            assert.match(button, /aria-selected="\$\{[^}]+\}"/, `${name}：aria-selected`);
        }
    }
    // 文件库页与阅读页的视图页签已移到文档状态栏 <mf-doc-bar>，页面自身不再渲染 .pane-tab
    for (const name of ['mf-library-page.js', 'mf-reader-page.js']) assert.ok(!readComponent(name).includes('class="pane-tab'), `${name} 不再渲染视图页签`);
});

test('视图帧版式与字号：compact / compact-text 注入紧凑样式，zoom 注入 html { zoom }，缺省不注入；只用于文件库页与阅读页', async () => {
    const dom = await loadDomModule();
    const page = '<!DOCTYPE html><html><head><title>t</title></head><body><p>x</p></body></html>';
    assert.match(dom.withFrameLayout(page, 'compact'), /<style data-markflow-layout="compact">html > body \{ max-width: none !important; margin: 0 !important; padding: 16px 22px 40px !important; \}<\/style><\/head>/);
    assert.match(dom.withFrameLayout(page, 'compact-text'), /<style data-markflow-layout="compact-text">html > body \{ padding: 12px 14px 32px !important; \}<\/style><\/head>/);
    assert.equal(dom.withFrameLayout(page, 'unknown'), page);
    assert.equal(dom.withFrameLayout(page, 'constructor'), page, '原型链上的键不当作版式');
    assert.match(dom.withFrameZoom(page, 120), /<style data-markflow-zoom>html \{ zoom: 1\.2; \}<\/style><\/head>/);
    assert.equal(dom.withFrameZoom(page, null), page);
    assert.equal(dom.withFrameZoom(page, 0), page);
    assert.ok(dom.withFrameZoom('<p>x</p>', 90).startsWith('<style data-markflow-zoom>html { zoom: 0.9; }</style>'), '无 </head> 时前置');
    const previous = globalThis.document;
    globalThis.document = { createElement: () => ({ dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }) };
    try {
        const frame = dom.createViewFrame({ srcdoc: page, sameOrigin: true, layout: 'compact', zoom: 110, appearance: 'adaptive' });
        assert.equal(frame.attributes.sandbox, 'allow-popups allow-same-origin', '同源但不放开脚本');
        assert.ok(frame.srcdoc.includes('data-markflow-layout="compact"') && frame.srcdoc.includes('zoom: 1.1') && frame.srcdoc.includes('data-markflow-appearance'));
        assert.equal(dom.createViewFrame({ srcdoc: page }).srcdoc, page, '缺省不注入');
    } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
    for (const name of ['mf-library-page.js', 'mf-reader-page.js']) {
        const src = readComponent(name);
        assert.match(src, /sameOrigin: !options\.src/, `${name}：srcdoc 帧为同源沙箱帧（查找、大纲定位与字号需读写帧内 DOM）`);
        assert.match(src, /layout: [\w.]*view\.kind === 'md' \? 'compact' : null/, `${name}：Markdown 渲染视图注入紧凑版式，html 原样渲染不注入`);
        assert.match(src, /layout: 'compact-text'/, `${name}：原文、JSON 与 XML 结构视图注入紧凑版式`);
    }
    for (const name of ['mf-compare-view.js', 'mf-product-pane.js', 'mf-source-pane.js']) {
        assert.ok(!readComponent(name).includes("layout: 'compact"), `${name}：对比预览不注入紧凑版式`);
    }
});

test('顶部栏：只经 store 与 mf-doc-command 事件与页面联动，不引用页面组件，不绑定 ⌘+ / ⌘-', () => {
    const statusBar = readComponent('mf-status-bar.js');
    const imports = [...statusBar.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(imports, ['../store.js', '../icons.js', '../api.js', '../dom.js', '../doc-tools.mjs']);
    assert.match(statusBar, /new CustomEvent\('mf-doc-command'/);
    assert.ok(!/key === '[=+-]'|'Equal'|'Minus'/.test(statusBar), '⌘+ / ⌘- 留给应用菜单的整窗缩放');
    // HTMLElement.popover 是 Popover API 的反射属性：给自定义元素赋值会使其按 UA 弹层样式收缩为 fit-content 宽并加边框
    assert.ok(!/this\.popover\b/.test(statusBar), '顶部栏不得占用 this.popover');
    for (const name of ['mf-library-page.js', 'mf-reader-page.js']) {
        const src = readComponent(name);
        assert.match(src, /addEventListener\('mf-doc-command'/, `${name} 监听顶部栏命令`);
        assert.ok(!src.includes('mf-status-bar'), `${name} 不引用顶部栏`);
    }
});

test('视图帧外观的注入范围：来源栏与阅读类视图 adaptive，对比预览产物栏 paper', () => {
    for (const name of ['mf-library-page.js', 'mf-reader-page.js', 'mf-source-pane.js']) {
        const lines = readComponent(name).split('\n').filter((line) => line.includes('srcdoc: textDocument('));
        assert.ok(lines.length > 0, name);
        for (const line of lines) assert.ok(line.includes("appearance: 'adaptive'"), `${name}：原文文本视图注入深色覆盖`);
    }
    for (const name of ['mf-library-page.js', 'mf-reader-page.js']) {
        const src = readComponent(name);
        assert.match(src, /appearance: [\w.]*view\.kind === 'md' \? 'adaptive' : 'paper'/, `${name}：md 渲染注入，html 原样渲染保持白纸`);
        assert.match(src, /editor\.frameAppearance = 'adaptive'/, `${name}：编辑页实时预览注入`);
    }
    assert.match(readComponent('mf-source-pane.js'), /srcdoc: view\.html \|\| '', title: '来源', appearance: 'adaptive'/);
    const product = readComponent('mf-product-pane.js');
    assert.ok(!product.includes("'adaptive'"), '对比预览产物栏（含其编辑页预览）不注入');
    assert.match(product, /title: '产物', appearance: 'paper'/);
    assert.match(product, /editor\.frameAppearance = 'paper'/);
    assert.match(readComponent('mf-md-editor.js'), /createViewFrame\(\{[^}]*appearance: this\.frameAppearance \}\)/);
});

test('样式令牌：字号阶梯、控件高度、焦点环与 --doc-surface 齐备，视图帧不再写死白底、悬停不再位移', () => {
    const tokens = fs.readFileSync(path.join(RENDERER_DIR, 'css', 'tokens.css'), 'utf8');
    const app = fs.readFileSync(path.join(RENDERER_DIR, 'css', 'app.css'), 'utf8');
    const expected = [
        ['--font-title-2', '17px'], ['--font-title-3', '15px'], ['--font-headline', '13px'], ['--font-body', '13px'],
        ['--font-callout', '12px'], ['--font-subheadline', '11px'], ['--font-footnote', '10px'],
        ['--control-height-sm', '24px'], ['--control-height', '28px'], ['--control-height-lg', '36px'],
        ['--icon-btn-size-sm', '24px'], ['--icon-btn-size', '28px'], ['--disabled-opacity', '0.4'],
    ];
    for (const [name, value] of expected) assert.match(tokens, new RegExp(`${name}: ${value};`), name);
    assert.match(tokens, /--doc-surface: light-dark\(/);
    assert.doesNotMatch(tokens, /--transition:[^;]*\ball\b/, '--transition 只过渡颜色类属性');
    assert.match(app, /\.view-frame \{[^}]*background: var\(--doc-surface\)/);
    assert.match(app, /:focus-visible \{[^}]*outline: var\(--focus-ring-width\) solid var\(--focus-ring-color\)/);
    assert.doesNotMatch(app, /:hover[^{]*\{[^}]*transform:/, '悬停不再位移或缩放');
});

test('window.js：will-prevent-unload 询问「取消 / 仍然关闭」，选关闭才放行卸载', () => {
    const { createUnloadGuard } = require('../desktop/main/window');
    const shown = [];
    let choice = 0;
    const dialog = { showMessageBoxSync: (...args) => { shown.push(args); return choice; } };
    const win = { isDestroyed: () => false };
    const guard = createUnloadGuard(dialog, win);
    let prevented = 0;
    const event = { preventDefault: () => { prevented += 1; } };
    guard(event);
    assert.equal(prevented, 0, '选「取消」时保持窗口');
    assert.equal(shown[0][0], win, '对话框挂在主窗口上');
    assert.deepEqual(shown[0][1].buttons, ['取消', '仍然关闭']);
    assert.equal(shown[0][1].message, '仍有 Markdown 修改未保存完毕');
    assert.equal(shown[0][1].cancelId, 0);
    choice = 1;
    guard(event);
    assert.equal(prevented, 1, '选「仍然关闭」时 preventDefault 放行卸载');
    assert.doesNotThrow(() => createUnloadGuard(null, win)(event), '缺少 dialog 时不抛错');
});
