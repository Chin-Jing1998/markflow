/**
 * MarkFlow - Electron Preload 脚本
 * 安全地将原生功能暴露给渲染进程
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // 打开原生目录选择对话框
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    // 在文件管理器中打开目录
    openInFinder: (folderPath) => ipcRenderer.invoke('open-in-finder', folderPath),
    // 监听主进程设置输出目录的消息
    onSetOutputDir: (callback) => ipcRenderer.on('set-output-dir', (event, dir) => callback(dir)),
    // HTML → PDF（通过主进程隐藏窗口 printToPDF）
    printToPdf: (html, options) => ipcRenderer.invoke('print-to-pdf', { html, options }),
    // 判断是否在 Electron 中运行
    isElectron: true
});
