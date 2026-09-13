/**
 * preload 桥接的薄封装：window.markflow 不存在（非桌面环境）时所有调用以中文错误拒绝。
 */
const bridge = typeof window !== 'undefined' && window.markflow ? window.markflow : null;
const NOT_DESKTOP = '桌面桥接不可用：请在 MarkFlow 桌面版中运行';

export const isDesktop = Boolean(bridge);
export const platform = bridge ? bridge.platform() : 'web';

function call(name, ...args) {
    if (!bridge || typeof bridge[name] !== 'function') return Promise.reject(new Error(NOT_DESKTOP));
    return bridge[name](...args);
}

export const api = {
    describeFormats: () => call('describeFormats'),
    pickFiles: (options) => call('pickFiles', options),
    pickDirectory: (options) => call('pickDirectory', options),
    expandPaths: (paths) => call('expandPaths', paths),
    convertRun: (payload) => call('convertRun', payload),
    convertCancel: (runId) => call('convertCancel', runId),
    libraryList: (params) => call('libraryList', params),
    libraryUpdate: (id, patch) => call('libraryUpdate', id, patch),
    libraryRemove: (id, trash) => call('libraryRemove', id, trash),
    libraryReveal: (id) => call('libraryReveal', id),
    libraryOpen: (id) => call('libraryOpen', id),
    libraryReconvert: (id, target) => call('libraryReconvert', id, target),
    libraryMigrate: (dryRun) => call('libraryMigrate', dryRun),
    settingsGet: () => call('settingsGet'),
    settingsSet: (patch) => call('settingsSet', patch),
    setMineruToken: (token) => call('setMineruToken', token),
    testMineru: (token) => call('testMineru', token),
    themeGet: () => call('themeGet'),
    themeSet: (theme) => call('themeSet', theme),
    openExternal: (url) => call('openExternal', url),
    previewOpen: (payload) => call('previewOpen', payload),
    previewRender: (payload) => call('previewRender', payload),
    previewExport: (payload) => call('previewExport', payload),
    previewClose: (sessionId) => call('previewClose', { sessionId }),
    readerOpen: (payload) => call('readerOpen', payload),
};

export function pathForFile(file) {
    try {
        return bridge ? bridge.getPathForFile(file) : '';
    } catch (err) {
        return '';
    }
}

export function onConvertEvent(callback) {
    return bridge ? bridge.onConvertEvent(callback) : () => undefined;
}

export function onThemeChanged(callback) {
    return bridge ? bridge.onThemeChanged(callback) : () => undefined;
}

/** 主进程 → 渲染进程的预览 / 阅读推送（菜单「打开文件…」选中 md/html/xml/pdf 时到达） */
export function onPreviewEvent(callback) {
    return bridge && typeof bridge.onPreviewEvent === 'function' ? bridge.onPreviewEvent(callback) : () => undefined;
}
