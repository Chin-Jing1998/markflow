# MarkFlow 专利 XML：Word for Mac 任务窗格加载项

本目录随 MarkFlow 应用分发，内容全部是静态文件，不需要构建。用户面向的安装与使用说明见仓库根目录 `README.md` 的「Word for Mac 加载项」一章。

| 文件 | 作用 |
|---|---|
| `manifest.xml` | 加载项清单模板。设置页的「安装到 Word」把它原样写入 `~/Library/Containers/com.microsoft.Word/Data/Documents/wef/markflow-patent-xml.xml` |
| `taskpane/taskpane.html` | 任务窗格页面。三个 `<meta>` 的占位符（令牌、版本号、上传上限）由回环服务在每次响应时注入 |
| `taskpane/taskpane.js` | 页面脚本：`Office.onReady` → 探活 → 分片取当前文档 → 上传 → 轮询 → 展示结果。动态内容一律经 `textContent` 写入 |
| `taskpane/taskpane.css` | 样式。深浅色默认跟随系统，读到 `Office.context.officeTheme` 后以 Office 的主题为准 |

## 运行方式

页面与接口由 MarkFlow 主进程内的回环服务（`desktop/main/addin/`）在 `http://localhost:49731` 同源提供，因此不需要 HTTPS、证书与钥匙串操作。该形态已于 2026-09-18 在本机 Word for Mac 16.107 实测通过：Word 接受 `SourceLocation` 为 `http://localhost` 的清单，`getFileAsync(Office.FileType.Compressed)` 取到的字节包含未保存的编辑。

唯一的外部依赖是微软官方 CDN 上的 `office.js`，由页面在运行时加载，不落盘；微软要求加载项始终从该 CDN 引用它。

## 清单的约束

- `<Id>` 是固定的 GUID，改动它 Word 会把加载项当成另一个。
- `SourceLocation` 里的端口必须与 `desktop/main/addin/server.js` 的 `DEFAULT_PORT` 一致，`test/desktop-addin-installer.test.js` 守护这一点。
- 保持最小形态：不写 `VersionOverrides`（官方示例注明其 `Resources` 里的 URL 须为 HTTPS），因此没有功能区按钮，加载项从「开始 › 加载项」或「插入 › 我的加载项 › 开发人员加载项」打开。
- 修改清单后，已安装的副本在设置页显示为「需要重新安装」。

## 手动安装与移除

设置页的按钮失败时（多为 macOS 未授权 MarkFlow 访问 Word 的数据目录），界面给出的错误文案里带有一条路径已填好、可直接粘贴到「终端」的命令，以它为准。其形态如下：`<数据目录>` 指设置页底部「设置文件」所在的目录，点过一次「安装到 Word」之后，清单副本即出现在其下的 `word-addin/` 中（打包后的清单模板位于 `app.asar` 内，终端里的 `cp` 读不到，故命令引用的是这份副本）。

```bash
mkdir -p ~/Library/Containers/com.microsoft.Word/Data/Documents/wef
cp "<数据目录>/word-addin/markflow-patent-xml.xml" ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/
```

```bash
rm -f ~/Library/Containers/com.microsoft.Word/Data/Documents/wef/markflow-patent-xml.xml
```

安装与移除之后都要完全退出并重开 Word。

## 不经 Word 的自验

`test/desktop-addin-taskpane.test.js` 用桩 Office 对象加 linkedom 解析真实的 `taskpane.html`，请求打到监听临时端口的真实回环服务，覆盖主流程与各错误态；`taskpane.js` 在 Node 下以 `module.exports` 导出各函数供该测试使用。
