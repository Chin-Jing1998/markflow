/**
 * MarkFlow 桌面端主进程入口（方案 §3.2「新增（桌面端）」、§3.4.9）
 *
 * 职责：单实例锁；app.ready 前注册 mf-app / mf-asset 特权 scheme 并恢复主题；ready 后安装协议处理器、
 * 权限处理器（仅放行剪贴板写入）、进程内 PDF / 栅格后端、文件库、IPC、菜单与主窗口；
 * window-all-closed / activate 按平台差异处理；未捕获异常写 stderr 并弹窗。
 *
 * 在普通 Node 进程中 require 本文件不产生任何副作用（require('electron') 得到的是路径字符串，
 * shouldBootstrap 为 false），仅经 module.exports._internal 暴露纯逻辑供单元测试（同 v1 的 _internal 模式）。
 */
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

const { errText } = require('../../converters/util');
const { SUPPORTED_EXTENSIONS } = require('../../converters/targets');
const { createSettingsStore } = require('./settings');
const { createAssetGrants, registerSchemesAsPrivileged, installProtocols } = require('./asset-protocol');
const { createMainWindow, applyWindowTheme } = require('./window');
const { installMenu } = require('./menu');
const { createChromiumJobs } = require('./chromium-jobs');
const { createIpcHandlers, registerIpc, CHANNELS } = require('./ipc');
const { scanPaths } = require('./scan');
const { createReader, isReaderPath, READER_EXTENSIONS } = require('./reader');
const { createPreviewSessions } = require('./preview-session');
const pkg = require('../../package.json');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD_PATH = path.join(__dirname, '..', 'preload.js');
const ICON_PNG = path.join(__dirname, '..', '..', 'build', 'icon.png');
const APP_URL = 'mf-app://app/';
const LIBRARY_DIRNAME = 'library';
const OUTPUT_DIRNAME = 'MarkFlow';
const LIBRARY_ROOT_DIRNAME = 'MarkFlow Library';
/** 渲染进程可申请的权限：只放行剪贴板写入（复制路径），其余一律拒绝 */
const PERMISSIONS_ALLOWED = Object.freeze(new Set(['clipboard-sanitized-write']));

/**
 * 仅在 Electron 进程内返回 electron 模块，普通 Node 进程返回 null。
 * 先查 process.versions.electron：只有 Electron 进程才有该字段。普通 Node 里不能贸然
 * require('electron')——那是 npm 包的路径解析逻辑，二进制缺失时会当场下载（往 stdout
 * 打印并以 stdio:'inherit' 拉起 install.js），测试与命令行都不该有这种副作用。
 */
function loadElectron() {
    if (!process.versions || !process.versions.electron) return null;
    try {
        const mod = require('electron');
        return mod && typeof mod === 'object' && mod.app ? mod : null;
    } catch (err) {
        return null;
    }
}

/** 仅在 Electron 主进程中且本文件为入口（或 process.type 为 browser）时启动 */
function shouldBootstrap(electron, { mainModule = require.main, currentModule = module, processType = process.type } = {}) {
    return Boolean(electron) && (mainModule === currentModule || processType === 'browser');
}

/** 文件库内核归阶段 6：模块缺失时返回 null，文件库页显示「文件库模块未就绪」 */
function loadLibraryModules(log = () => undefined) {
    try {
        return { library: require('./library'), migrate: require('./library-migrate') };
    } catch (err) {
        log(`[desktop] 文件库模块未就绪：${errText(err)}`);
        return null;
    }
}

function defaultDirs(app) {
    let documents;
    try {
        documents = app.getPath('documents');
    } catch (err) {
        documents = path.join(os.homedir(), 'Documents');
    }
    return { outputDir: path.join(documents, OUTPUT_DIRNAME), libraryRoot: path.join(documents, LIBRARY_ROOT_DIRNAME) };
}

// ============================================================
// 生命周期（仅在 Electron 主进程执行）
// ============================================================

function bootstrap(electron) {
    const { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, net, session, shell, safeStorage } = electron;
    const log = (line) => process.stderr.write(`${line}\n`);

    if (!app.requestSingleInstanceLock()) {
        app.quit();
        return;
    }
    registerSchemesAsPrivileged(protocol);

    const userData = app.getPath('userData');
    const settings = createSettingsStore({ dir: userData, safeStorage, defaults: defaultDirs(app) });
    settings.load();
    for (const warning of settings.warnings()) log(`[desktop] ${warning}`);
    // ready 之前恢复主题，保证窗口创建时 shouldUseDarkColors 已反映用户选择
    nativeTheme.themeSource = settings.get().theme;

    const grants = createAssetGrants();
    const state = {
        mainWindow: null, chromiumJobs: null, library: null, libraryMigrate: null,
        preview: null, reader: null, backendStatus: { pdf: false, raster: false },
    };

    /** 关闭全部预览 / 阅读会话：撤销 mf-asset 授权并删掉会话临时目录（窗口关闭与退出时各调一次） */
    function closeViewSessions() {
        const tasks = [state.preview ? state.preview.closeAll() : null, state.reader ? state.reader.closeAll() : null];
        return Promise.all(tasks.filter(Boolean)).catch((err) => log(`[desktop] 清理预览会话失败：${errText(err)}`));
    }

    const reportFatal = (label, err) => {
        log(`[desktop] ${label}：${err && err.stack ? err.stack : err}`);
        if (!app.isReady()) return;
        try { dialog.showErrorBox('MarkFlow 出现错误', `${label}：${errText(err)}`); } catch (dialogErr) { /* 退出阶段忽略 */ }
    };
    process.on('uncaughtException', (err) => reportFatal('未捕获的异常', err));
    process.on('unhandledRejection', (err) => reportFatal('未处理的 Promise 拒绝', err));

    const isDark = () => nativeTheme.shouldUseDarkColors;
    const broadcast = (channel, payload) => {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send(channel, payload);
        }
    };
    const themePayload = (theme) => ({ theme, shouldUseDarkColors: isDark() });

    function rebuildMenu() {
        installMenu(electron, { theme: settings.get().theme, actions: menuActions });
    }

    /** 用户固定主题时同步 nativeTheme.themeSource（vibrancy 材质随 nativeTheme 而非页面配色） */
    function applyTheme(theme) {
        nativeTheme.themeSource = theme;
        applyWindowTheme(state.mainWindow, { isDark: isDark() });
        rebuildMenu();
        broadcast(CHANNELS.themeChanged, themePayload(theme));
    }
    nativeTheme.on('updated', () => {
        applyWindowTheme(state.mainWindow, { isDark: isDark() });
        broadcast(CHANNELS.themeChanged, themePayload(settings.get().theme));
    });

    function createWindow() {
        state.mainWindow = createMainWindow(electron, {
            preloadPath: PRELOAD_PATH, url: APP_URL, isDark: isDark(), log,
            onClosed: (win) => {
                if (state.mainWindow === win) state.mainWindow = null;
                closeViewSessions();
            },
        });
        return state.mainWindow;
    }

    function focusMainWindow() {
        if (!state.mainWindow) {
            createWindow();
            return;
        }
        if (state.mainWindow.isMinimized()) state.mainWindow.restore();
        state.mainWindow.focus();
    }

    // ---------- 菜单动作 ----------

    /**
     * 「打开文件…」：md / html / xml / pdf 交阅读模式直接打开（只取第一个，阅读模式一次显示一份），
     * 其余扩展名照旧进转换队列；两类都选中时各走各的通道。
     */
    async function openFilesFromMenu() {
        const win = state.mainWindow;
        if (!win) return;
        const result = await dialog.showOpenDialog(win, {
            title: '打开文件',
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: '可阅读的文档', extensions: READER_EXTENSIONS.map((ext) => ext.slice(1)) },
                { name: '可转换的文档', extensions: SUPPORTED_EXTENSIONS.map((ext) => ext.slice(1)) },
                { name: '全部文件', extensions: ['*'] },
            ],
        });
        if (result.canceled || result.filePaths.length === 0 || win.isDestroyed()) return;
        const readable = result.filePaths.filter((item) => isReaderPath(item));
        const convertible = result.filePaths.filter((item) => !isReaderPath(item));
        if (convertible.length > 0) {
            const { files, unsupported } = await scanPaths(convertible);
            win.webContents.send(CHANNELS.convertEvent, { runId: null, type: 'enqueue', files, unsupported });
        }
        if (readable.length > 0 && !win.isDestroyed()) {
            win.webContents.send(CHANNELS.previewEvent, { type: 'reader-open', path: readable[0], pending: readable.slice(1) });
        }
        win.focus();
    }

    async function openOutputDir() {
        const dir = settings.get().outputDir;
        await fsp.mkdir(dir, { recursive: true });
        const failure = await shell.openPath(dir);
        if (failure) log(`[desktop] 打开输出目录失败：${failure}`);
    }

    function showAbout() {
        dialog.showMessageBox(state.mainWindow || undefined, {
            type: 'info',
            title: '关于 MarkFlow',
            message: `MarkFlow ${pkg.version}`,
            detail: `知识库文件转换工具\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
        }).catch((err) => log(`[desktop] 关于对话框失败：${errText(err)}`));
    }

    const menuActions = {
        openFiles: () => openFilesFromMenu().catch((err) => log(`[desktop] 打开文件失败：${errText(err)}`)),
        openOutputDir: () => openOutputDir().catch((err) => log(`[desktop] 打开输出目录失败：${errText(err)}`)),
        setTheme: (theme) => settings.set({ theme }).then(() => applyTheme(theme)).catch((err) => log(`[desktop] 切换主题失败：${errText(err)}`)),
        about: showAbout,
    };

    // ---------- 文件库（阶段 6 内核；load() 仅在启动时调用一次） ----------

    async function setupLibrary() {
        const mods = loadLibraryModules(log);
        if (!mods) return;
        try {
            const lib = mods.library.createLibrary({ dir: path.join(userData, LIBRARY_DIRNAME) });
            const { warnings } = await lib.load();
            for (const warning of warnings) log(`[desktop] 文件库：${warning}`);
            state.library = lib;
            state.libraryMigrate = mods.migrate;
        } catch (err) {
            log(`[desktop] 文件库初始化失败：${errText(err)}`);
        }
    }

    // ---------- 启动 ----------

    app.on('second-instance', () => focusMainWindow());
    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
    app.on('before-quit', () => { closeViewSessions(); });
    app.on('web-contents-created', (event, contents) => {
        contents.on('will-attach-webview', (attachEvent) => attachEvent.preventDefault());
    });

    app.whenReady().then(async () => {
        installProtocols({ protocol, net, rendererDir: RENDERER_DIR, grants: grants.grants });
        const ses = session.defaultSession;
        // RequestHandler 管异步申请，CheckHandler 管同步查询，二者须同时收紧
        ses.setPermissionRequestHandler((wc, permission, callback) => callback(PERMISSIONS_ALLOWED.has(permission)));
        ses.setPermissionCheckHandler((wc, permission) => PERMISSIONS_ALLOWED.has(permission));

        state.chromiumJobs = createChromiumJobs(electron, { log });
        state.backendStatus = state.chromiumJobs.registerBackends();
        await setupLibrary();

        // 预览与阅读会话：两者共用 grants（mf-asset 授权表），预览另需设置（选项默认值、MinerU 令牌）与文件库
        state.reader = createReader({ grants, log });
        state.preview = createPreviewSessions({ grants, settings, library: state.library, log });

        const { handlers } = createIpcHandlers({
            electron, settings, grants,
            library: state.library, libraryMigrate: state.libraryMigrate,
            preview: state.preview, reader: state.reader,
            service: require('../../converters/service'),
            scan: { scanPaths },
            backendStatus: state.backendStatus,
            getMainWindow: () => state.mainWindow,
            applyTheme, log,
        });
        registerIpc(ipcMain, handlers);
        rebuildMenu();
        if (process.platform === 'darwin' && !app.isPackaged && app.dock && fs.existsSync(ICON_PNG)) app.dock.setIcon(ICON_PNG);
        createWindow();
        app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
    }).catch((err) => {
        reportFatal('初始化失败', err);
        app.quit();
    });
}

module.exports = {
    _internal: {
        loadElectron, shouldBootstrap, loadLibraryModules, defaultDirs, bootstrap,
        RENDERER_DIR, PRELOAD_PATH, ICON_PNG, APP_URL, PERMISSIONS_ALLOWED, LIBRARY_DIRNAME,
    },
};

const electron = loadElectron();
if (shouldBootstrap(electron)) bootstrap(electron);
