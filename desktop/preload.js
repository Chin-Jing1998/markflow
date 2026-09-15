/**
 * MarkFlow 桌面端 preload（sandbox:true 下运行，只能 require('electron')）
 *
 * 经 contextBridge 暴露 window.markflow：仅函数，不暴露 ipcRenderer 本体；
 * 事件订阅只开放三个白名单通道（mf:convert:event、mf:theme:changed、mf:preview:event），订阅函数返回取消函数。
 * 主进程拒绝的调用以 Error 抛回渲染层，错误文案去掉 Electron 的「Error invoking remote method」前缀。
 * 令牌与任何密文不经此处传递。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENT_CHANNELS = Object.freeze(['mf:convert:event', 'mf:theme:changed', 'mf:preview:event']);
const REMOTE_ERROR_PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/;

function cleanMessage(err) {
    const raw = err && typeof err.message === 'string' ? err.message : String(err);
    return raw.replace(REMOTE_ERROR_PREFIX, '');
}

function invoke(channel, payload) {
    return ipcRenderer.invoke(channel, payload).catch((err) => {
        throw new Error(cleanMessage(err));
    });
}

/** 白名单通道订阅；返回取消函数 */
function subscribe(channel, callback) {
    if (!EVENT_CHANNELS.includes(channel)) throw new Error(`不允许订阅通道：${channel}`);
    if (typeof callback !== 'function') throw new Error('订阅需要回调函数');
    const listener = (event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('markflow', {
    platform: () => process.platform,
    version: () => process.versions.electron,
    // 拖入 / 选择的 File 对象 → 本地绝对路径（File.path 已在 Electron 32+ 移除）
    getPathForFile: (file) => webUtils.getPathForFile(file),

    describeFormats: () => invoke('mf:formats:describe'),
    pickFiles: (options) => invoke('mf:dialog:pickFiles', options),
    pickDirectory: (options) => invoke('mf:dialog:pickDirectory', options),
    expandPaths: (paths, options) => invoke('mf:paths:expand', options && options.scope ? { paths, scope: options.scope } : { paths }),

    convertRun: (payload) => invoke('mf:convert:run', payload),
    convertCancel: (runId) => invoke('mf:convert:cancel', { runId }),
    onConvertEvent: (callback) => subscribe('mf:convert:event', callback),

    previewOpen: (payload) => invoke('mf:preview:open', payload),
    previewRender: (payload) => invoke('mf:preview:render', payload),
    previewExport: (payload) => invoke('mf:preview:export', payload),
    previewClose: (payload) => invoke('mf:preview:close', payload),
    readerOpen: (payload) => invoke('mf:reader:open', payload),
    mdRender: (payload) => invoke('mf:md:render', payload),
    mdSave: (payload) => invoke('mf:md:save', payload),
    mdInsertImage: (payload) => invoke('mf:md:insertImage', payload),
    onPreviewEvent: (callback) => subscribe('mf:preview:event', callback),

    libraryList: (params) => invoke('mf:library:list', params),
    libraryUpdate: (id, patch) => invoke('mf:library:update', { id, patch }),
    libraryRemove: (id, trash) => invoke('mf:library:remove', { id, trash: Boolean(trash) }),
    libraryReveal: (id) => invoke('mf:library:reveal', { id }),
    libraryOpen: (id) => invoke('mf:library:open', { id }),
    libraryReconvert: (id, target) => invoke('mf:library:reconvert', target ? { id, target } : { id }),
    libraryMigrate: (dryRun) => invoke('mf:library:migrate', { dryRun: Boolean(dryRun) }),

    settingsGet: () => invoke('mf:settings:get'),
    settingsSet: (patch) => invoke('mf:settings:set', { patch }),
    setMineruToken: (token) => invoke('mf:settings:setMineruToken', { token: token == null ? null : String(token) }),
    testMineru: (token) => invoke('mf:settings:testMineru', token ? { token: String(token) } : undefined),

    themeGet: () => invoke('mf:theme:get'),
    themeSet: (theme) => invoke('mf:theme:set', { theme }),
    onThemeChanged: (callback) => subscribe('mf:theme:changed', callback),

    openExternal: (url) => invoke('mf:shell:openExternal', { url }),
    // 当前文件操作：只传会话与动作，文件路径由主进程按 sessionId 取
    fileAction: (sessionId, action) => invoke('mf:file:action', { sessionId, action }),
});
