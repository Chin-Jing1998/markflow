/**
 * MarkFlow - Electron Preload 脚本
 * 在 sandbox:true 下运行（只能 require('electron')）：从主进程注入的启动参数解析后端地址与 token，
 * 经 contextBridge 暴露最小 API 给渲染进程；不暴露 ipcRenderer 本体。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** 从 process.argv 解析 --name=value 形式的启动参数（由主进程 additionalArguments 注入） */
function readArg(name) {
    const prefix = `--${name}=`;
    const hit = process.argv.find((arg) => arg.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : '';
}

const port = readArg('markflow-port');
const token = readArg('markflow-token');

contextBridge.exposeInMainWorld('electronAPI', {
    // 判断是否在 Electron 中运行
    isElectron: true,
    // 后端地址与本次启动的一次性 token（/api/* 请求需带请求头 X-MarkFlow-Token）
    apiBase: `http://127.0.0.1:${port}`,
    apiToken: token,
    // 取拖入 / 选择的 File 对象的本地绝对路径（File.path 已在 Electron 32+ 移除）
    getPathForFile: (file) => webUtils.getPathForFile(file),
    // 展开路径列表：文件原样返回，目录递归收集 .md/.markdown，返回 [{ path, name, size }]
    expandPaths: (paths) => ipcRenderer.invoke('expand-paths', paths),
    // 原生目录选择对话框，取消时返回 null
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    // 在 Finder / 资源管理器中定位该路径
    openInFinder: (target) => ipcRenderer.invoke('open-in-finder', target),
    // 用系统默认程序打开路径；返回空串表示成功，否则为错误信息
    openPath: (target) => ipcRenderer.invoke('open-path', target),
    // 主题：'system' | 'light' | 'dark'，持久化于主进程
    setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
    getTheme: () => ipcRenderer.invoke('get-theme'),
    // 监听菜单「选择输出目录」推送
    onSetOutputDir: (callback) => ipcRenderer.on('set-output-dir', (event, dir) => callback(dir)),
});
