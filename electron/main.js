/**
 * MarkFlow - Electron 主进程
 * 职责：与 Chromium 初始化并行拉起内嵌后端（127.0.0.1 随机端口 + 每次启动生成的 token）；创建主窗口
 * （跟随系统主题、深色启动不闪白、显示兜底、限制导航与外链）；提供本地路径类 IPC。
 * 在普通 Node 进程中 require 本文件不产生任何副作用，仅通过 module.exports._internal 暴露纯逻辑供单元测试。
 */
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

/** 普通 Node 进程里 require('electron') 得到的是可执行文件路径字符串（或抛错），此时返回 null */
function loadElectron() {
    try {
        const mod = require('electron');
        return mod && typeof mod === 'object' && mod.app ? mod : null;
    } catch { return null; }
}
const electron = loadElectron();
const { app, BrowserWindow, Menu, shell, dialog, ipcMain, nativeTheme, session } = electron || {};

const HOST = '127.0.0.1';
const SHOW_FALLBACK_MS = 1500;          // ready-to-show 迟迟不来时的显示兜底
const BACKEND_CLOSE_TIMEOUT_MS = 1500;  // 退出时等待后端关闭的上限
const THEMES = ['system', 'light', 'dark'];
const MARKDOWN_EXTS = new Set(['.md', '.markdown']);
const SKIP_DIRS = new Set(['node_modules', '.git']);
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_FILES = 500;

let mainWindow = null;
let backend = null;   // startServer 返回的句柄 { server, port, token, close() }
let apiToken = '';
let isClosingBackend = false;

// ===== 纯逻辑：不依赖 Electron，可独立测试 =====

/** 主题值校验，非法值回退 'system' */
function normalizeTheme(value) {
    return THEMES.includes(value) ? value : 'system';
}

/** 读取主题文件；文件缺失、JSON 损坏或值非法时返回 'system' */
function readThemeFile(file) {
    try {
        return normalizeTheme(JSON.parse(fs.readFileSync(file, 'utf8')).theme);
    } catch { return 'system'; }
}

/** 写入主题文件（自动建目录），返回实际写入的规范值 */
function writeThemeFile(file, value) {
    const theme = normalizeTheme(value);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ theme }, null, 2));
    return theme;
}

/** 递归收集目录下的 Markdown 文件到 out：跳过 node_modules、.git 与点开头目录，受深度与总数上限约束 */
async function collectMarkdownFiles(dir, depth, out) {
    if (depth > MAX_SCAN_DEPTH || out.length >= MAX_SCAN_FILES) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (out.length >= MAX_SCAN_FILES) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
            await collectMarkdownFiles(full, depth + 1, out);
        } else if (entry.isFile() && MARKDOWN_EXTS.has(path.extname(entry.name).toLowerCase())) {
            const stat = await fsp.stat(full).catch(() => null);
            if (stat) out.push({ path: full, name: entry.name, size: stat.size });
        }
    }
}

/** 展开路径列表：文件原样返回，目录递归收集 .md/.markdown，不存在的路径忽略 */
async function expandPaths(paths) {
    const out = [];
    for (const p of Array.isArray(paths) ? paths : []) {
        if (out.length >= MAX_SCAN_FILES) break;
        if (typeof p !== 'string' || p === '') continue;
        const stat = await fsp.stat(p).catch(() => null);
        if (!stat) continue;
        if (stat.isFile()) out.push({ path: p, name: path.basename(p), size: stat.size });
        else if (stat.isDirectory()) await collectMarkdownFiles(p, 0, out);
    }
    return out.slice(0, MAX_SCAN_FILES);
}

// ===== 后端：模块加载时即启动，与 Chromium 初始化并行 =====

/** 启动内嵌后端；失败时在 ready 之后弹框并退出，返回 null（不抛出，避免 unhandledRejection） */
async function startBackend() {
    apiToken = crypto.randomBytes(24).toString('hex');
    try {
        const { startServer } = require(path.join(__dirname, '..', 'server'));
        backend = await startServer({ host: HOST, port: 0, token: apiToken });
        return backend;
    } catch (err) {
        console.error('后端启动失败:', err);
        await app.whenReady();
        dialog.showErrorBox('启动失败', `无法启动后端服务：${err.message}`);
        app.quit();
        return null;
    }
}

/** before-quit：等待后端关闭（容错且有上限）后再真正退出，避免残留子进程与端口 */
function closeBackendThenQuit(event) {
    if (isClosingBackend || !backend) return;
    isClosingBackend = true;
    event.preventDefault();
    const timeout = new Promise((resolve) => setTimeout(resolve, BACKEND_CLOSE_TIMEOUT_MS));
    Promise.race([Promise.resolve().then(() => backend.close()), timeout])
        .catch((err) => console.error('后端关闭失败:', err))
        .finally(() => app.quit());
}

// ===== 主题：持久化到 userData/theme.json，并驱动 nativeTheme =====

function themeFilePath() {
    return path.join(app.getPath('userData'), 'theme.json');
}

// ===== 窗口 =====

function createWindow(port) {
    const origin = `http://${HOST}:${port}`;
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 680,
        title: 'MarkFlow',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 16 },
        // transparent:true + vibrancy 在 Electron 35 + macOS Tahoe 下拖动区域偶发失效，故保持 false
        transparent: false,
        vibrancy: 'sidebar',
        visualEffectState: 'active',
        // 底色跟随当前主题，深色模式启动不闪白（也是 vibrancy 不可用时的回退色）
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
        roundedCorners: true,
        backgroundMaterial: 'mica',
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
            additionalArguments: [`--markflow-port=${port}`, `--markflow-token=${apiToken}`],
        },
    });
    mainWindow = win;

    // ready-to-show 与兜底计时器先到者显示窗口，且只显示一次
    const showOnce = () => { if (!win.isDestroyed() && !win.isVisible()) win.show(); };
    const fallback = setTimeout(showOnce, SHOW_FALLBACK_MS);
    win.once('ready-to-show', () => { clearTimeout(fallback); showOnce(); });
    win.on('closed', () => { clearTimeout(fallback); if (mainWindow === win) mainWindow = null; });

    // 仅 http(s) 外链交给系统浏览器，其余一律拒绝；页面内导航只允许本地后端（url 已是规范化绝对地址）
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch((err) => console.error('打开外链失败:', err));
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${origin}/`)) event.preventDefault(); });
    win.loadURL(origin);
}

// ===== 菜单与对话框 =====

/** 原生目录选择对话框；取消时返回 null */
async function pickOutputDir(parent) {
    const result = await dialog.showOpenDialog(parent, { properties: ['openDirectory', 'createDirectory'], title: '选择输出目录' });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
}

async function sendOutputDirFromMenu() {
    if (!mainWindow) return;
    const dir = await pickOutputDir(mainWindow);
    if (dir && mainWindow) mainWindow.webContents.send('set-output-dir', dir);
}

const SEP = { type: 'separator' };
const roleItem = (role, label) => ({ role, label });

function buildMenu() {
    const isMac = process.platform === 'darwin';
    const appMenu = { label: 'MarkFlow', submenu: [
        roleItem('about', '关于 MarkFlow'), SEP, roleItem('services', '服务'), SEP,
        roleItem('hide', '隐藏 MarkFlow'), roleItem('hideOthers', '隐藏其他'), roleItem('unhide', '显示全部'), SEP,
        roleItem('quit', '退出 MarkFlow'),
    ] };
    const template = [
        ...(isMac ? [appMenu] : []),
        { label: '文件', submenu: [
            { label: '选择输出目录...', accelerator: 'CmdOrCtrl+Shift+O', click: sendOutputDirFromMenu }, SEP,
            isMac ? roleItem('close', '关闭窗口') : roleItem('quit', '退出'),
        ] },
        { label: '编辑', submenu: [
            roleItem('undo', '撤销'), roleItem('redo', '重做'), SEP,
            roleItem('cut', '剪切'), roleItem('copy', '复制'), roleItem('paste', '粘贴'), roleItem('selectAll', '全选'),
        ] },
        { label: '视图', submenu: [
            roleItem('reload', '刷新'), roleItem('forceReload', '强制刷新'), SEP,
            roleItem('resetZoom', '重置缩放'), roleItem('zoomIn', '放大'), roleItem('zoomOut', '缩小'), SEP,
            roleItem('togglefullscreen', '全屏'),
        ] },
        { label: '窗口', submenu: [
            roleItem('minimize', '最小化'),
            ...(isMac ? [roleItem('zoom', '缩放'), SEP, roleItem('front', '全部置前')] : [roleItem('close', '关闭')]),
        ] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ===== IPC（ipcMain.handle）=====

function requireNonEmptyString(value) {
    if (typeof value !== 'string' || value === '') throw new Error('参数必须是非空字符串');
    return value;
}

function registerIpc() {
    ipcMain.handle('select-directory', (event) => {
        const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        return parent ? pickOutputDir(parent) : null;
    });
    ipcMain.handle('open-in-finder', (event, target) => { shell.showItemInFolder(requireNonEmptyString(target)); });
    ipcMain.handle('open-path', (event, target) => shell.openPath(requireNonEmptyString(target)));
    ipcMain.handle('expand-paths', (event, paths) => expandPaths(paths));
    ipcMain.handle('set-theme', (event, value) => {
        const theme = normalizeTheme(value);
        nativeTheme.themeSource = theme;
        writeThemeFile(themeFilePath(), theme);
    });
    ipcMain.handle('get-theme', () => nativeTheme.themeSource);
}

// ===== 生命周期（仅在 Electron 主进程执行）=====

function bootstrap() {
    const backendReady = startBackend();   // 不等 app.whenReady，与 Chromium 初始化并行
    // ready 之前恢复主题，保证窗口创建时 shouldUseDarkColors 已反映用户选择
    try { nativeTheme.themeSource = readThemeFile(themeFilePath()); } catch (err) { console.error('读取主题设置失败:', err); }
    registerIpc();

    app.whenReady().then(async () => {
        const handle = await backendReady;
        if (!handle) return;   // 启动失败已在 startBackend 内提示并退出
        session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
            // 仅放行剪贴板写入（前端「复制路径」等需要），其余权限一律拒绝
            callback(permission === 'clipboard-sanitized-write');
        });
        buildMenu();
        createWindow(handle.port);
        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow(handle.port);
        });
    }).catch((err) => console.error('初始化失败:', err));

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
    app.on('before-quit', closeBackendThenQuit);
}

module.exports = {
    _internal: { normalizeTheme, readThemeFile, writeThemeFile, collectMarkdownFiles, expandPaths },
};

if (electron) bootstrap();
