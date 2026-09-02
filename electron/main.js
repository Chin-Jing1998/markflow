/**
 * MarkFlow - Electron 主进程
 * 职责：与 Chromium 初始化并行拉起内嵌后端（127.0.0.1 随机端口 + 每次启动生成的 token）；创建主窗口
 * （跟随系统主题、深色启动不闪白、显示兜底、限制导航与外链）；在 webRequest 层为 /api/* 注入访问令牌，
 * 令牌不下发给渲染进程；提供本地路径类 IPC（打开路径经白名单校验）。
 * 在普通 Node 进程中 require 本文件不产生任何副作用，仅通过 module.exports._internal 暴露纯逻辑供单元测试。
 */
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

/** 普通 Node 进程里 require('electron') 得到的是可执行文件路径字符串（或抛错），此时返回 null */
function loadElectron() {
    try { const mod = require('electron'); return mod && typeof mod === 'object' && mod.app ? mod : null; } catch { return null; }
}
const electron = loadElectron();
const { app, BrowserWindow, Menu, shell, dialog, ipcMain, nativeTheme, session } = electron || {};

const HOST = '127.0.0.1';
const TOKEN_HEADER = 'X-MarkFlow-Token';
const SHOW_FALLBACK_MS = 1500;          // ready-to-show 迟迟不来时的显示兜底
const BACKEND_CLOSE_TIMEOUT_MS = 1500;  // 退出时等待后端关闭的上限
const THEMES = ['system', 'light', 'dark'];
/** 目录扫描默认收集的扩展名：全部支持的输入类型，前端按当前 tab 二次过滤 */
const SCAN_EXTS = new Set(['.md', '.markdown', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf']);
/** open-path 允许用系统默认程序打开的文件扩展名（转换产物），其余一律拒绝 */
const OPENABLE_EXTS = new Set(['.md', '.json', '.docx', '.pdf']);
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
    try { return normalizeTheme(JSON.parse(fs.readFileSync(file, 'utf8')).theme); } catch { return 'system'; }
}

/** 写入主题文件（自动建目录），返回实际写入的规范值 */
function writeThemeFile(file, value) {
    const theme = normalizeTheme(value);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ theme }, null, 2));
    return theme;
}

/** 判定目录项的实际类型：Dirent 已给出结论就直接采用，符号链接等未知项再 stat 解析目标 */
async function entryKind(entry, full) {
    if (entry.isDirectory()) return 'dir';
    if (entry.isFile()) return 'file';
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat) return 'other';
    if (stat.isDirectory()) return 'dir';
    return stat.isFile() ? 'file' : 'other';
}

/**
 * 递归收集目录下扩展名命中 exts 的文件到 out：跳过 node_modules、.git 与点开头目录，
 * 受深度与总数上限约束；seen 记录已进入目录的真实路径，符号链接成环时不重复进入。
 */
async function collectFiles(dir, depth, out, exts, seen) {
    if (depth > MAX_SCAN_DEPTH || out.length >= MAX_SCAN_FILES) return;
    const real = await fsp.realpath(dir).catch(() => dir);
    if (seen.has(real)) return;
    seen.add(real);
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (out.length >= MAX_SCAN_FILES) return;
        const full = path.join(dir, entry.name);
        const kind = await entryKind(entry, full);
        if (kind === 'dir') {
            if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
            await collectFiles(full, depth + 1, out, exts, seen);
        } else if (kind === 'file' && exts.has(path.extname(entry.name).toLowerCase())) {
            const stat = await fsp.stat(full).catch(() => null);
            if (stat) out.push({ path: full, name: entry.name, size: stat.size });
        }
    }
}

/** 归一化扩展名过滤集：缺省、非数组或全为非法项时回退到 SCAN_EXTS；元素可带或不带前导点 */
function normalizeExts(exts) {
    if (!Array.isArray(exts)) return SCAN_EXTS;
    const list = exts
        .filter((e) => typeof e === 'string' && e !== '')
        .map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
    return list.length > 0 ? new Set(list) : SCAN_EXTS;
}

/**
 * 展开路径列表：文件原样返回，目录递归收集命中 exts 的文件，不存在的路径忽略。
 * 入参数组先按 MAX_SCAN_FILES 截断，避免渲染进程传入超长数组导致大量 stat 系统调用。
 */
async function expandPaths(paths, exts) {
    const out = [];
    const filter = normalizeExts(exts);
    const seen = new Set();
    for (const p of (Array.isArray(paths) ? paths : []).slice(0, MAX_SCAN_FILES)) {
        if (out.length >= MAX_SCAN_FILES) break;
        if (typeof p !== 'string' || p === '') continue;
        const stat = await fsp.stat(p).catch(() => null);
        if (!stat) continue;
        if (stat.isFile()) out.push({ path: p, name: path.basename(p), size: stat.size });
        else if (stat.isDirectory()) await collectFiles(p, 0, out, filter, seen);
    }
    return out.slice(0, MAX_SCAN_FILES);
}

/** open-path 白名单：产物类扩展名的普通文件，或非 .app 包的目录；其余（设备文件、可执行文件等）拒绝 */
async function isOpenablePath(target) {
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat) return false;
    if (stat.isFile()) return OPENABLE_EXTS.has(path.extname(target).toLowerCase());
    if (stat.isDirectory()) return !/\.app[\\/]?$/i.test(target);
    return false;
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

/** 主题持久化位置：userData/theme.json，读写后驱动 nativeTheme */
function themeFilePath() {
    return path.join(app.getPath('userData'), 'theme.json');
}

// ===== 窗口 =====

function createWindow(port) {
    const origin = `http://${HOST}:${port}`;
    const win = new BrowserWindow({
        width: 1440, height: 900, minWidth: 1024, minHeight: 680,
        title: 'MarkFlow', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 },
        // transparent:true + vibrancy 在 Electron 35 + macOS Tahoe 下拖动区域偶发失效，故保持 false
        transparent: false, vibrancy: 'sidebar', visualEffectState: 'active',
        // 底色跟随当前主题，深色模式启动不闪白（也是 vibrancy 不可用时的回退色）
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
        roundedCorners: true, backgroundMaterial: 'mica', show: false,
        webPreferences: {
            nodeIntegration: false, contextIsolation: true, sandbox: true,
            preload: path.join(__dirname, 'preload.js'),
            // 只下发端口；token 由主进程在 onBeforeSendHeaders 注入，渲染进程与 preload 均不持有
            additionalArguments: [`--markflow-port=${port}`],
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

/**
 * 在默认会话上为本地后端的 /api/* 请求注入访问令牌请求头。
 * 令牌只存在于主进程内存，既不进命令行参数（对同机其他进程可见），也不进渲染进程；
 * 渲染进程即便自带该头也会被此处覆盖。
 */
function registerApiTokenHeader(port) {
    const filter = { urls: [`http://${HOST}:${port}/api/*`] };
    session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
        details.requestHeaders[TOKEN_HEADER] = apiToken;
        callback({ requestHeaders: details.requestHeaders });
    });
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
        roleItem('about', '关于 MarkFlow'), SEP, roleItem('services', '服务'), SEP, roleItem('hide', '隐藏 MarkFlow'),
        roleItem('hideOthers', '隐藏其他'), roleItem('unhide', '显示全部'), SEP, roleItem('quit', '退出 MarkFlow'),
    ] };
    const template = [
        ...(isMac ? [appMenu] : []),
        { label: '文件', submenu: [{ label: '选择输出目录...', accelerator: 'CmdOrCtrl+Shift+O', click: sendOutputDirFromMenu },
            SEP, isMac ? roleItem('close', '关闭窗口') : roleItem('quit', '退出')] },
        { label: '编辑', submenu: [roleItem('undo', '撤销'), roleItem('redo', '重做'), SEP, roleItem('cut', '剪切'),
            roleItem('copy', '复制'), roleItem('paste', '粘贴'), roleItem('selectAll', '全选')] },
        { label: '视图', submenu: [roleItem('reload', '刷新'), roleItem('forceReload', '强制刷新'), SEP,
            roleItem('resetZoom', '重置缩放'), roleItem('zoomIn', '放大'), roleItem('zoomOut', '缩小'), SEP,
            roleItem('togglefullscreen', '全屏')] },
        { label: '窗口', submenu: [roleItem('minimize', '最小化'),
            ...(isMac ? [roleItem('zoom', '缩放'), SEP, roleItem('front', '全部置前')] : [roleItem('close', '关闭')])] },
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
    // 路径不存在时不调用 shell，返回 false 而非抛错，避免渲染进程出现未捕获的 Promise 拒绝
    ipcMain.handle('open-in-finder', async (event, target) => {
        const p = requireNonEmptyString(target);
        if (!(await fsp.stat(p).catch(() => null))) return false;
        shell.showItemInFolder(p);
        return true;
    });
    ipcMain.handle('open-path', async (event, target) => {
        const p = requireNonEmptyString(target);
        if (!(await isOpenablePath(p))) return '不允许打开该路径';
        return shell.openPath(p);
    });
    ipcMain.handle('expand-paths', (event, paths, exts) => expandPaths(paths, exts));
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
        // 仅放行剪贴板写入（前端「复制路径」等需要），其余权限一律拒绝；
        // RequestHandler 管异步申请，CheckHandler 管同步查询，二者须同时收紧才没有绕过口子
        session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
        session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'clipboard-sanitized-write');
        registerApiTokenHeader(handle.port);
        buildMenu();
        createWindow(handle.port);
        app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(handle.port); });
    }).catch((err) => console.error('初始化失败:', err));

    app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
    app.on('before-quit', closeBackendThenQuit);
}

module.exports = { _internal: { normalizeTheme, readThemeFile, writeThemeFile, collectFiles, expandPaths, isOpenablePath } };

if (electron) bootstrap();
