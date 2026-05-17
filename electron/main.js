/**
 * MarkFlow - Electron 主进程
 * 将 Express 后端嵌入 Electron，作为桌面应用运行
 */
const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('path');

// 服务端口（支持环境变量覆盖，方便与 server.js 联动）
const PORT = parseInt(process.env.PORT, 10) || 3000;
let mainWindow = null;
let server = null;

/**
 * 创建主窗口
 */
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 680,
        title: 'MarkFlow',
        titleBarStyle: 'hiddenInset',  // macOS 原生标题栏样式
        trafficLightPosition: { x: 16, y: 16 },
        // ===== Apple26 / Liquid Glass =====
        // 注：transparent:true + vibrancy 在 Electron 35 + macOS Tahoe 下 drag region
        // 偶发失效（GitHub known issue）。改用 transparent:false 让 OS 接管标题栏拖动，
        // vibrancy 仍生效（macOS 原生模糊材质独立工作，不依赖 transparent）。
        transparent: false,
        vibrancy: 'sidebar',
        visualEffectState: 'active',
        backgroundColor: '#F5F5F7',         // vibrancy 失败时的浅色 fallback
        roundedCorners: true,
        backgroundMaterial: 'mica',         // Windows 11 等效（其他平台忽略）
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        show: false, // 等加载完成再显示，避免白屏闪烁
    });

    // 加载 Express 提供的页面
    mainWindow.loadURL(`http://localhost:${PORT}`);

    // 页面加载完成后平滑显示
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // 窗口关闭
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // 外部链接用系统浏览器打开
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

/**
 * 构建应用菜单
 */
function buildMenu() {
    const isMac = process.platform === 'darwin';

    const template = [
        ...(isMac ? [{
            label: 'MarkFlow',
            submenu: [
                { role: 'about', label: '关于 MarkFlow' },
                { type: 'separator' },
                { role: 'services', label: '服务' },
                { type: 'separator' },
                { role: 'hide', label: '隐藏 MarkFlow' },
                { role: 'hideOthers', label: '隐藏其他' },
                { role: 'unhide', label: '显示全部' },
                { type: 'separator' },
                { role: 'quit', label: '退出 MarkFlow' }
            ]
        }] : []),
        {
            label: '文件',
            submenu: [
                {
                    label: '选择输出目录...',
                    accelerator: 'CmdOrCtrl+Shift+O',
                    click: async () => {
                        if (!mainWindow) return;
                        const result = await dialog.showOpenDialog(mainWindow, {
                            properties: ['openDirectory', 'createDirectory'],
                            title: '选择输出目录'
                        });
                        if (!result.canceled && result.filePaths.length > 0) {
                            mainWindow.webContents.send('set-output-dir', result.filePaths[0]);
                        }
                    }
                },
                { type: 'separator' },
                isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }
            ]
        },
        {
            label: '编辑',
            submenu: [
                { role: 'undo', label: '撤销' },
                { role: 'redo', label: '重做' },
                { type: 'separator' },
                { role: 'cut', label: '剪切' },
                { role: 'copy', label: '复制' },
                { role: 'paste', label: '粘贴' },
                { role: 'selectAll', label: '全选' }
            ]
        },
        {
            label: '视图',
            submenu: [
                { role: 'reload', label: '刷新' },
                { role: 'forceReload', label: '强制刷新' },
                { type: 'separator' },
                { role: 'resetZoom', label: '重置缩放' },
                { role: 'zoomIn', label: '放大' },
                { role: 'zoomOut', label: '缩小' },
                { type: 'separator' },
                { role: 'togglefullscreen', label: '全屏' }
            ]
        },
        {
            label: '窗口',
            submenu: [
                { role: 'minimize', label: '最小化' },
                ...(isMac ? [
                    { role: 'zoom', label: '缩放' },
                    { type: 'separator' },
                    { role: 'front', label: '全部置前' }
                ] : [
                    { role: 'close', label: '关闭' }
                ])
            ]
        }
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * 启动内嵌的 Express 服务
 */
async function startBackend() {
    try {
        // 把 PORT 传给 server（server.js 也读 process.env.PORT，保持一致）
        process.env.PORT = String(PORT);
        const { startServer } = require(path.join(__dirname, '..', 'server'));
        server = await startServer(PORT);
        console.log('✅ 后端服务已启动 on port', PORT);
    } catch (err) {
        console.error('❌ 后端启动失败:', err);
        dialog.showErrorBox('启动失败', `无法启动后端服务：${err.message}`);
        app.quit();
    }
}

// ===== IPC 通信：原生文件对话框 =====
ipcMain.handle('select-directory', async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'createDirectory'],
        title: '选择输出目录'
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.handle('open-in-finder', async (event, folderPath) => {
    shell.showItemInFolder(folderPath);
});

// PDF 打印 IPC：渲染进程 → 主进程隐藏窗口 printToPDF
const pdfPrinter = require('./pdf-printer');
ipcMain.handle('print-to-pdf', async (event, { html, options } = {}) => {
    if (!pdfPrinter.isAvailable()) {
        throw new Error('PDF 打印功能不可用');
    }
    const buf = await pdfPrinter.printToPdf(html, options);
    return buf; // Buffer 经 IPC 自动转 Uint8Array
});

// 另存为：复制已生成的文件到用户选择的路径（用于 binary 输出"另存为副本"）
ipcMain.handle('save-as', async (event, { sourcePath, defaultName } = {}) => {
    if (!mainWindow) return null;
    if (!sourcePath) throw new Error('save-as 需要 sourcePath');
    const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: defaultName || path.basename(sourcePath),
        title: '另存为',
    });
    if (result.canceled || !result.filePath) return null;
    require('fs').copyFileSync(sourcePath, result.filePath);
    return result.filePath;
});

// 多文件选择（原生体验，可选；前端也可用 <input type="file">）
ipcMain.handle('select-files', async (event, options = {}) => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        title: options.title || '选择文件',
        filters: options.filters || [
            {
                name: '所有支持的格式',
                extensions: ['docx', 'pdf', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'md', 'markdown', 'html', 'htm', 'json'],
            },
            { name: '办公文档', extensions: ['docx', 'pdf', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'] },
            { name: '标记文档', extensions: ['md', 'markdown', 'html', 'htm', 'json'] },
            { name: '全部', extensions: ['*'] },
        ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const fs = require('fs');
    return result.filePaths.map((p) => ({
        path: p,
        name: path.basename(p),
        size: fs.statSync(p).size,
    }));
});

// ===== Electron 应用生命周期 =====
app.whenReady().then(async () => {
    await startBackend();
    buildMenu();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    if (server) {
        server.close();
    }
});
