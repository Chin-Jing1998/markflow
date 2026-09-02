<p align="center">
  <img src="build/icon.png" alt="MarkFlow" width="128" height="128">
</p>

<h1 align="center">MarkFlow</h1>

<p align="center">
  <b>知识库文件转换工具</b> —— Electron 桌面应用 + 命令行工具 + MCP 服务三合一
</p>

<p align="center">
  <a href="#功能一览">功能一览</a> • <a href="#安装与运行">安装与运行</a> • <a href="#http-api">HTTP API</a> • <a href="#pdf-输出说明">PDF 输出</a> • <a href="#安全说明">安全说明</a> • <a href="#目录结构">目录结构</a> • <a href="#开发与测试">开发与测试</a> • <a href="#已知限制">已知限制</a> • <a href="#许可证">许可证</a>
</p>

---

MarkFlow 面向知识库建设场景，把办公文档、Markdown 文档与网页统一转换为结构化产物。三种使用方式共享同一套转换内核（`converters/`）：桌面应用提供图形界面与拖拽交互，命令行工具面向批处理与脚本集成，MCP 服务面向 Claude Code、Codex 等 agent 客户端。

## 功能一览

| 输入类型 | 支持格式 | 输出产物 | 说明 |
|---|---|---|---|
| 办公文档 | `.docx` `.xlsx` `.pptx` `.pdf`；`.doc` `.xls` `.ppt` 需本机安装 LibreOffice | `{输出目录}/{名称}/{名称}.md` + `{名称}.json` + `images/` | docx、pptx 抽取内嵌图片；pdf、xlsx 不提取图片 |
| 标记文档 | `.md` `.markdown`（桌面端可拖入文件夹，递归收集） | `{输出目录}/{名称}.docx` 或 `.pdf`（二选一） | 图片按 md 所在目录解析相对路径并内嵌；支持 GFM 表格、删除线、任务列表、代码块、引用块、超链接；井号后无空格的 `#标题` 也按标题处理 |
| 网页链接 | 每行一个 URL，仅 `http://` `https://`，拒绝内网与本机地址 | 同办公文档的 bundle 产物 | 文章正文与图片下载后内嵌，图片存入 `images/` |

bundle 产物中的 JSON 结构固定为：

```json
{
  "schemaVersion": 1,
  "kind": "document | workbook | presentation",
  "ir": "<mdast 语法树>",
  "data": "…",
  "meta": { "title": "…", "sourceType": "…" }
}
```

### 桌面端界面

左栏为三个 tab：办公文档、标记文档、网页链接；右栏为转换结果面板，逐项显示状态、输出路径、图片数、告警与错误，并提供「在 Finder 中显示」「打开」操作。设置中可选择输出目录（默认 `~/Documents/MarkFlow`，设置持久化在 `~/.markflow/settings.json`）与外观主题（跟随系统 / 浅色 / 深色，默认跟随系统）。界面不加载任何远程资源。

## 安装与运行

环境要求：Node.js ≥ 22。

```bash
git clone <本仓库地址>
cd 知识库文件转换程序
npm ci
```

### 桌面端

```bash
npm run electron
```

### 命令行（CLI）

仓库内运行 `node bin/markflow.js <子命令>`（或 `npm run cli -- <子命令>`）；执行 `npm link` 后可使用全局命令 `markflow`。`--help` 输出：

```
用法：markflow <子命令> [选项]

  convert <输入...>   转换本地文件或 http(s) 网页，输入可多个
  formats             列出可用的输入类型、转换目标与运行时能力
  serve               启动本地 HTTP 服务（地址与令牌打印到 stderr）
  mcp                 以 stdio 方式启动 MCP 服务，供 agent 调用

选项：
  --to <目标>         bundle | docx | pdf；省略时按输入类型取默认值（Office/PDF/网页 → bundle，Markdown → docx）
  --out <目录>        输出目录，必须已存在；默认取 MARKFLOW_OUTPUT_DIR，再回退到当前目录
  --json              stdout 只输出一行 JSON 结果，其余信息走 stderr
  --concurrency <n>   convert 的并发数，默认 2
  --host <地址>       serve 监听地址，默认 127.0.0.1
  --port <端口>       serve 监听端口，默认 0（由系统分配）
  -h, --help          显示本说明
  -v, --version       显示版本号

退出码：0 全部成功；1 参数错误或运行异常；2 存在失败项
```

人类可读模式下，成功项的产物路径逐行写入 stdout，进度与汇总信息写入 stderr；`--json` 模式下 stdout 仅输出一行：

```json
{
  "ok": true,
  "outputDir": "…",
  "results": [
    { "input": "…", "target": "…", "name": "…", "title": "…", "outputPath": "…", "outputs": {}, "imagesCount": 0, "warnings": [] }
  ],
  "errors": [{ "input": "…", "error": "…" }]
}
```

查看当前环境可用的转换目标与能力探测：`markflow formats --json`。

启动本地 HTTP 服务（供浏览器或脚本调用，URL 与访问令牌打印到 stderr）：`markflow serve --port 0 --host 127.0.0.1 --out ~/Documents/MarkFlow`。

### MCP 服务

以 stdio 方式启动：

```bash
markflow mcp
```

提供两个工具：

- `convert_document`：入参 `paths?: string[]`、`urls?: string[]`、`target?: 'bundle' | 'docx' | 'pdf'`、`outputDir: string`（须已存在）、`returnContent?: boolean`（为 `true` 时在 bundle 结果中附带 Markdown 正文，上限 200000 字符）；返回结构与 CLI 的 `--json` 一致。
- `list_formats`：无入参，返回输入类型与转换目标的对应矩阵，以及 LibreOffice、PDF 后端的可用性。

**Claude Code**：仓库根目录已提供 `.mcp.json`，在本仓库目录内启动会话即自动识别；也可在任意目录执行：

```bash
claude mcp add markflow -- node /绝对路径/mcp/server.js
```

**Codex**：在 `~/.codex/config.toml` 追加：

```toml
[mcp_servers.markflow]
command = "node"
args = ["/绝对路径/mcp/server.js"]
```

## HTTP API

服务默认仅监听 `127.0.0.1`，随机分配端口；全部 `/api/*` 端点须携带请求头 `X-MarkFlow-Token`。令牌于每次启动时随机生成：`markflow serve` 会把地址与令牌打印到 stderr，供脚本自行携带；桌面端则由 Electron 主进程在请求发出前注入该请求头，页面代码不接触令牌。

| 方法与路径 | 说明 |
|---|---|
| `GET /api/formats` | 返回能力矩阵与实时探测结果 |
| `POST /api/convert` | 请求体 `{ items: [{ path\|url, target }], outputDir? }`；响应为 NDJSON 事件流，依次为 `accepted`、`start`、`progress`、`item`、`done` |
| `GET /api/settings/output-dir` | 读取当前输出目录 |
| `POST /api/settings/output-dir` | 设置输出目录，须为已存在且可写的绝对路径 |

## PDF 输出说明

PDF 渲染按以下顺序选择后端：

1. 桌面端内运行时，使用 Electron 内置 Chromium 直接打印；
2. CLI / MCP 场景下，优先 spawn 仓库内的 Electron 二进制（开发环境或执行 `npm install` 后可用），以独立进程打印；
3. 以上均不可用时，尝试本机 LibreOffice（`soffice --headless --convert-to pdf`，先由 DOCX 中转再转出 PDF）；
4. 三者都不可用则报错，并在错误信息中给出安装提示。

## 安全说明

- HTTP 服务仅绑定本机回环地址，并使用每次启动时生成的令牌进行鉴权。
- 桌面端的访问令牌由主进程在 `webRequest` 层为 `/api/*` 请求注入请求头，既不写入命令行参数（同机其他进程可读），也不下发给渲染进程；渲染进程无从读取令牌，即便伪造该请求头也会被主进程覆盖。
- 静态资源仅开放 `index.html`、`css/`、`js/`、`assets/` 四处，其余路径一律 404。
- 网页抓取内置 SSRF 守卫：拒绝解析到内网或保留网段的地址，限制页面正文不超过 20 MB、单张图片不超过 10 MB。
- Markdown 中的原始 HTML 标签在转换为 docx、pdf 时只保留其文本内容。
- PDF 打印页面启用 CSP（`default-src 'none'; img-src file: data:`）。Markdown 中的图片只允许引用文档所在目录内的本地文件；远程与内网图片不进入打印页面，仅保留 `alt` 文本占位，因此隐藏的打印窗口不会向任何地址发起请求。
- 桌面端「打开」操作限定于转换产物：仅放行 `.md`、`.json`、`.docx`、`.pdf` 文件与普通目录，`.app` 应用包及其他类型一律拒绝。
- 桌面端界面启用 CSP（`default-src 'self'`），不加载任何外部资源。

## 目录结构

```
知识库文件转换程序/
├── bin/                 CLI 入口（markflow.js）
├── mcp/                 MCP stdio 服务
├── electron/            Electron 主进程、preload、PDF 打印 worker
├── server.js            HTTP 服务入口
├── server/               安全中间件、LibreOffice 适配
├── converters/           转换内核
│   ├── index.js          调度：解析 → IR → 渲染 → 落盘
│   ├── batch.js           批量并发控制
│   ├── output.js          产物落盘
│   ├── targets.js         输入类型与目标裁决
│   ├── parsers/           各输入格式解析器（docx/xlsx/pptx/pdf/md/url 及旧二进制格式）
│   ├── renderers/         输出渲染器（md/json/html/docx/pdf）
│   ├── ir/                中间表示（IR）定义与工具函数
│   ├── assets/            Markdown 图片路径解析
│   ├── net/               SSRF 守卫与限长 fetch
│   └── pdf/               PDF 后端选择
├── index.html / js/ / css/ / assets/   前端（桌面端界面）
├── test/                 测试与 fixture
└── package.json
```

## 开发与测试

```bash
npm ci                # 安装依赖
npm run electron       # 启动桌面端
npm test               # 运行测试（node:test，306 项）
npm run build:mac      # 打包 macOS 安装包
npm run build:win      # 打包 Windows 安装包
```

CI 在 `v*` 标签推送时触发，先运行测试再执行打包。

可选依赖：LibreOffice（用于旧二进制格式 `.doc` `.xls` `.ppt` 的转换，以及 CLI/MCP 场景下的 PDF 输出兜底）。

## 已知限制

- pdf 输入不提取图片。
- pptx 仅提取幻灯片中的 `p:pic` 图片，不含背景图与母版图。
- xlsx 不提取图片。
- 纯浏览器模式（执行 `node server.js` 后用浏览器打开）仅供调试，文件拖拽功能需在桌面端中使用。

## 许可证

[MIT License](LICENSE) © 2026 MarkFlow
