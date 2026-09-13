/**
 * 主窗口（参数照 R4 探针 REPORT.md「阶段 4」第 5 条）
 *
 * windowOptionsFor({ platform, isDark, osRelease, preloadPath }) → BrowserWindow 构造参数（纯函数，可单测）
 *   macOS：titleBarStyle 'hiddenInset' + trafficLightPosition {16,16} + vibrancy 'sidebar'（visualEffectState 'active'）
 *          + roundedCorners，transparent 保持 false；
 *   Windows：titleBarStyle 'hidden' + titleBarOverlay（高 52，按钮区由页面 env(titlebar-area-*) 让位），
 *          backgroundMaterial 'mica' 仅 Win11 22H2（build ≥ 22621）及以上，Win10 纯色回退；
 *   共同：show:false 配合 ready-to-show（1.5 s 显示兜底），backgroundColor 按深浅色取 #1c1c1e / #f5f5f7 避免深色启动闪白；
 *   webPreferences：contextIsolation / sandbox / webSecurity 开，nodeIntegration 关，plugins 开（阶段 5 内置 PDF 阅读器）。
 * createMainWindow(electron, { preloadPath, url, isDark, onClosed }) → BrowserWindow
 *   仅 http(s) 外链交 shell.openExternal 且一律 deny 新窗口；will-navigate 全拒。
 * applyWindowTheme(win, { platform, isDark })：切换主题时同步底色与（非 macOS 的）标题栏按钮配色。
 */
const os = require('os');

const DARK_BACKGROUND = '#1c1c1e';
const LIGHT_BACKGROUND = '#f5f5f7';
const DARK_SYMBOL = '#f5f5f7';
const LIGHT_SYMBOL = '#1c1c1e';
const TITLEBAR_HEIGHT = 52;
const TRAFFIC_LIGHT_POSITION = Object.freeze({ x: 16, y: 16 });
const WIN11_MICA_MIN_BUILD = 22621;
const SHOW_FALLBACK_MS = 1500;
const DEFAULT_BOUNDS = Object.freeze({ width: 1280, height: 820, minWidth: 960, minHeight: 640 });
const EXTERNAL_URL_RE = /^https?:\/\//i;

const backgroundFor = (isDark) => (isDark ? DARK_BACKGROUND : LIGHT_BACKGROUND);
const overlayFor = (isDark) => ({ color: backgroundFor(isDark), symbolColor: isDark ? DARK_SYMBOL : LIGHT_SYMBOL, height: TITLEBAR_HEIGHT });

function windowsBuildOf(release) {
    const build = Number(String(release || '').split('.')[2]);
    return Number.isFinite(build) ? build : 0;
}

const supportsMica = (platform, release) => platform === 'win32' && windowsBuildOf(release) >= WIN11_MICA_MIN_BUILD;

function windowOptionsFor({ platform = process.platform, isDark = false, osRelease = os.release(), preloadPath } = {}) {
    const base = {
        ...DEFAULT_BOUNDS,
        title: 'MarkFlow',
        show: false,
        backgroundColor: backgroundFor(isDark),
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
            plugins: true,
            spellcheck: false,
        },
    };
    if (platform === 'darwin') {
        return {
            ...base,
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION },
            vibrancy: 'sidebar',
            visualEffectState: 'active',
            transparent: false,
            roundedCorners: true,
        };
    }
    if (platform === 'win32') {
        return {
            ...base,
            titleBarStyle: 'hidden',
            titleBarOverlay: overlayFor(isDark),
            ...(supportsMica(platform, osRelease) ? { backgroundMaterial: 'mica' } : {}),
        };
    }
    return base;
}

function createMainWindow(electron, { preloadPath, url, isDark = false, platform = process.platform, osRelease, onClosed, log = console.error } = {}) {
    const { BrowserWindow, shell } = electron;
    const win = new BrowserWindow(windowOptionsFor({ platform, isDark, osRelease, preloadPath }));

    // ready-to-show 与兜底计时器先到者显示窗口，且只显示一次
    const showOnce = () => { if (!win.isDestroyed() && !win.isVisible()) win.show(); };
    const fallback = setTimeout(showOnce, SHOW_FALLBACK_MS);
    win.once('ready-to-show', () => { clearTimeout(fallback); showOnce(); });
    win.on('closed', () => {
        clearTimeout(fallback);
        if (typeof onClosed === 'function') onClosed(win);
    });

    win.webContents.setWindowOpenHandler(({ url: target }) => {
        if (EXTERNAL_URL_RE.test(target)) shell.openExternal(target).catch((err) => log(`打开外链失败：${err && err.message ? err.message : err}`));
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-attach-webview', (event) => event.preventDefault());

    win.loadURL(url).catch((err) => log(`加载主页面失败：${err && err.message ? err.message : err}`));
    return win;
}

function applyWindowTheme(win, { platform = process.platform, isDark = false } = {}) {
    if (!win || win.isDestroyed()) return;
    win.setBackgroundColor(backgroundFor(isDark));
    // macOS 上不存在 setTitleBarOverlay
    if (platform !== 'darwin' && typeof win.setTitleBarOverlay === 'function') {
        try { win.setTitleBarOverlay(overlayFor(isDark)); } catch (err) { /* 非 hidden 标题栏时忽略 */ }
    }
}

module.exports = {
    windowOptionsFor, createMainWindow, applyWindowTheme, supportsMica, windowsBuildOf, backgroundFor, overlayFor,
    DARK_BACKGROUND, LIGHT_BACKGROUND, TITLEBAR_HEIGHT, SHOW_FALLBACK_MS, WIN11_MICA_MIN_BUILD,
};
