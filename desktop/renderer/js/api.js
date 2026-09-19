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
    /** options.scope：'browse' 为文件库仓库树（另列 html / xml / json），缺省为转档入口的白名单 */
    expandPaths: (paths, options) => call('expandPaths', paths, options),
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
    /** 更新检测：force 为真时无视 24 小时缓存立即向 GitHub 请求；地址由主进程写死 */
    updateCheck: (force) => call('updateCheck', force),
    themeGet: () => call('themeGet'),
    themeSet: (theme) => call('themeSet', theme),
    openExternal: (url) => call('openExternal', url),
    previewOpen: (payload) => call('previewOpen', payload),
    previewRender: (payload) => call('previewRender', payload),
    previewExport: (payload) => call('previewExport', payload),
    previewClose: (sessionId) => call('previewClose', { sessionId }),
    readerOpen: (payload) => call('readerOpen', payload),
    /** Markdown 编辑：写入路径一律由主进程按 sessionId 取，渲染层只给文本 */
    mdRender: (payload) => call('mdRender', payload),
    mdSave: (payload) => call('mdSave', payload),
    mdInsertImage: (sessionId) => call('mdInsertImage', { sessionId }),
    /** 当前文件操作（action：reveal 在访达中显示 | open 用默认应用打开 | copyPath 复制路径）：路径由主进程按 sessionId 取 */
    fileAction: (sessionId, action) => call('fileAction', sessionId, action),
    /** Word for Mac 加载项：状态、启停开关、安装 / 移除清单；四者都回同一份状态对象 */
    addinStatus: () => call('addinStatus'),
    addinSetEnabled: (enabled) => call('addinSetEnabled', enabled),
    addinInstall: () => call('addinInstall'),
    addinUninstall: () => call('addinUninstall'),
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
