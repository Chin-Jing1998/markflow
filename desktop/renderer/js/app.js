/**
 * MarkFlow 桌面端渲染层入口（原生 ES 模块 + Custom Elements，零构建）。
 * 路由：hash（#/convert | #/library | #/reader | #/preview | #/settings）；
 * 页面元素只创建一次并以 hidden 切换，切到某页时调用其 refresh()。
 * 阅读页常驻订阅 mf:preview:event，故菜单「打开文件…」推来的阅读请求在任何路由下都能接住。
 * 主题：页面跟随 prefers-color-scheme（主进程按用户设置同步 nativeTheme.themeSource），
 * 这里只把主进程广播的主题状态写入 store 与 <html data-theme>。
 */
import './components/mf-toast.js';
import './components/mf-sidebar.js';
import './components/mf-status-bar.js';
import './components/mf-convert-page.js';
import './components/mf-library-page.js';
import './components/mf-settings-page.js';
import './components/mf-reader-page.js';
import './components/mf-compare-view.js';
import { store } from './store.js';
import { api, isDesktop, onThemeChanged, platform } from './api.js';
import { notify } from './components/mf-toast.js';

const ROUTES = Object.freeze({
    convert: { tag: 'mf-convert-page' },
    library: { tag: 'mf-library-page' },
    settings: { tag: 'mf-settings-page' },
    reader: { tag: 'mf-reader-page' },
    preview: { tag: 'mf-compare-view' },
});
const DEFAULT_ROUTE = 'convert';
const pages = new Map();

function routeFromHash() {
    const matched = /^#\/([a-z]+)/.exec(location.hash || '');
    return matched && ROUTES[matched[1]] ? matched[1] : DEFAULT_ROUTE;
}

function mountPages() {
    const content = document.getElementById('content');
    for (const [route, spec] of Object.entries(ROUTES)) {
        const el = document.createElement(spec.tag);
        el.classList.add('page');
        el.hidden = true;
        content.append(el);
        pages.set(route, el);
    }
}

function showRoute(route) {
    store.set({ route });
    for (const [key, el] of pages) {
        const active = key === route;
        el.hidden = !active;
        if (active && typeof el.refresh === 'function') el.refresh();
    }
}

function applyTheme({ theme, shouldUseDarkColors }) {
    store.set({ theme, isDark: Boolean(shouldUseDarkColors) });
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle('is-dark', Boolean(shouldUseDarkColors));
}

async function loadInitial() {
    const [formats, settings, theme] = await Promise.allSettled([api.describeFormats(), api.settingsGet(), api.themeGet()]);
    if (formats.status === 'fulfilled') store.set({ formats: formats.value });
    else notify(`读取转换能力失败：${formats.reason.message}`, 'error');
    if (settings.status === 'fulfilled') store.set({ settings: settings.value });
    else notify(`读取设置失败：${settings.reason.message}`, 'error');
    if (theme.status === 'fulfilled') applyTheme(theme.value);
    if (settings.status === 'fulfilled' && settings.value.warnings) {
        for (const warning of settings.value.warnings) notify(warning, 'warning', 6000);
    }
}

function boot() {
    document.documentElement.dataset.platform = platform;
    document.addEventListener('dragover', (event) => event.preventDefault());
    document.addEventListener('drop', (event) => event.preventDefault());
    mountPages();
    window.addEventListener('hashchange', () => showRoute(routeFromHash()));
    showRoute(routeFromHash());
    if (!isDesktop) {
        notify('桌面桥接不可用：请通过 MarkFlow 桌面版打开', 'warning', 8000);
        return;
    }
    onThemeChanged((payload) => applyTheme(payload));
    loadInitial().catch((err) => notify(err.message, 'error'));
}

boot();
