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
    for (const rel of ['css/tokens.css', 'css/app.css', 'js/app.js', 'js/api.js', 'js/store.js', 'js/dom.js', 'js/icons.js', 'js/url-lines.mjs']) {
        assert.ok(fs.existsSync(path.join(rendererDir, rel)), rel);
    }
    const components = fs.readdirSync(path.join(rendererDir, 'js', 'components')).sort();
    assert.deepEqual(components, [
        'mf-compare-view.js', 'mf-convert-page.js', 'mf-dropzone.js', 'mf-facets.js', 'mf-format-panel.js',
        'mf-library-page.js', 'mf-product-pane.js', 'mf-progress.js', 'mf-reader-page.js', 'mf-settings-page.js',
        'mf-sidebar.js', 'mf-source-pane.js', 'mf-status-bar.js', 'mf-task-list.js', 'mf-toast.js', 'mf-url-input.js',
    ]);
});
