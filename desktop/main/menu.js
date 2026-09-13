/**
 * 应用菜单
 *
 * buildMenuTemplate({ platform, theme, actions }) → Menu 模板（纯函数，可单测）
 *   文件：打开文件…（md / html / xml / pdf 交阅读模式，其余扩展名入转换队列）、打开输出目录、关闭 / 退出
 *   编辑：撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选
 *   视图：外观（跟随系统 / 浅色 / 深色，radio）、刷新、缩放、全屏
 *   窗口：最小化 / 缩放 / 全部置前（macOS）
 *   帮助：关于 MarkFlow
 * installMenu(electron, opts) → Menu：构建并设为应用菜单；主题变化时重建以刷新 radio 选中态。
 */
const THEME_ITEMS = Object.freeze([
    ['system', '跟随系统'],
    ['light', '浅色'],
    ['dark', '深色'],
]);

const SEP = Object.freeze({ type: 'separator' });
const roleItem = (role, label) => ({ role, label });
const call = (fn) => () => { if (typeof fn === 'function') fn(); };

function buildMenuTemplate({ platform = process.platform, theme = 'system', actions = {} } = {}) {
    const isMac = platform === 'darwin';
    const appMenu = {
        label: 'MarkFlow',
        submenu: [
            roleItem('about', '关于 MarkFlow'), SEP,
            roleItem('services', '服务'), SEP,
            roleItem('hide', '隐藏 MarkFlow'), roleItem('hideOthers', '隐藏其他'), roleItem('unhide', '显示全部'), SEP,
            roleItem('quit', '退出 MarkFlow'),
        ],
    };
    const fileMenu = {
        label: '文件',
        submenu: [
            { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: call(actions.openFiles) },
            { label: '打开输出目录', accelerator: 'CmdOrCtrl+Shift+O', click: call(actions.openOutputDir) },
            SEP,
            isMac ? roleItem('close', '关闭窗口') : roleItem('quit', '退出'),
        ],
    };
    const editMenu = {
        label: '编辑',
        submenu: [
            roleItem('undo', '撤销'), roleItem('redo', '重做'), SEP,
            roleItem('cut', '剪切'), roleItem('copy', '复制'), roleItem('paste', '粘贴'), roleItem('selectAll', '全选'),
        ],
    };
    const viewMenu = {
        label: '视图',
        submenu: [
            {
                label: '外观',
                submenu: THEME_ITEMS.map(([value, label]) => ({
                    label, type: 'radio', checked: theme === value, click: () => { if (typeof actions.setTheme === 'function') actions.setTheme(value); },
                })),
            },
            SEP,
            roleItem('reload', '刷新'), roleItem('forceReload', '强制刷新'), SEP,
            roleItem('resetZoom', '重置缩放'), roleItem('zoomIn', '放大'), roleItem('zoomOut', '缩小'), SEP,
            roleItem('togglefullscreen', '全屏'),
        ],
    };
    const windowMenu = {
        label: '窗口',
        submenu: [
            roleItem('minimize', '最小化'),
            ...(isMac ? [roleItem('zoom', '缩放'), SEP, roleItem('front', '全部置前')] : [roleItem('close', '关闭')]),
        ],
    };
    const helpMenu = {
        label: '帮助',
        submenu: [{ label: '关于 MarkFlow', click: call(actions.about) }],
    };
    return [...(isMac ? [appMenu] : []), fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}

function installMenu(electron, opts = {}) {
    const { Menu } = electron;
    const menu = Menu.buildFromTemplate(buildMenuTemplate(opts));
    Menu.setApplicationMenu(menu);
    return menu;
}

module.exports = { buildMenuTemplate, installMenu, THEME_ITEMS };
