# MarkFlow

知识库文件转换命令行工具。把办公文档、PDF 与网页转成 Markdown 知识库包，把 Markdown 转回 Word 或 PDF。提供命令行与 MCP 两种用法，供人直接调用，也供 Claude Code、Codex 等 agent 直接操作。

## 功能一览

三类输入，各自对应固定的产物形态。

| 输入 | 扩展名 | 产物 |
|---|---|---|
| 办公文档 | `.docx` `.xlsx` `.pptx` `.pdf`；`.doc` `.xls` `.ppt` 需 LibreOffice | `{输出目录}/{名称}/` 下的 `{名称}.md` + `{名称}.json` + `images/` |
| 标记文档 | `.md` `.markdown` | `{输出目录}/{名称}.docx` 或 `{名称}.pdf`，二选一 |
| 网页链接 | `http` / `https` | 同办公文档，文章图片一并下载到 `images/` |

要点说明：

- **图片**：Word 与 PowerPoint 的内嵌图片、网页文章的图片会被提取到 `images/` 并在 Markdown 中以相对路径引用。PDF 与 Excel 不提取图片。
- **Markdown 转 Word 与 PDF**：支持 GFM 表格、删除线、任务列表、代码块、引用块与超链接；图片按 Markdown 文件所在目录解析相对路径并内嵌。井号后缺空格的 `#标题` 也按标题处理。
- **网页正文提取**：三级策略——微信、知乎、CSDN、简书、掘金、思否、少数派、博客园的专属选择器优先命中；未命中走 Mozilla Readability 评分；再不行回退通用容器识别。实际命中的方式记录在 `meta.extraction` 中。
- **噪声清洗**：自动剔除分享栏、相关阅读、推荐位、评论区、面包屑、页内目录，以及「点击关注」「长按识别二维码」「转载请注明出处」一类整段引导语；清洗在图片下载之前完成，被剔除区域内的图片不会产生无谓的网络请求。
- **YAML front matter**：知识库包的 Markdown 带有元数据头，含标题、作者、发布时间、原文链接、站点名、摘要、语言、字数、提取方式、抓取与转换时间；办公文档只写它拥有的字段。Obsidian、basic-memory 等工具可直接索引与回溯出处。Markdown 输入自带的 front matter 会被剥离并合并进元数据，不会混入 Word 与 PDF 正文。
- **JSON 产物**：结构为 `{ schemaVersion, kind, ir, data, meta }`，其中 `ir` 是 mdast 语法树，`kind` 取 `document`、`workbook` 或 `presentation`，便于后续程序化处理。
- **同名产物直接覆盖**，重复转换结果幂等。

## 安装

要求 Node.js 22 或更高版本。

```bash
npm ci
```

仓库内可直接用 `node bin/markflow.js`，或 `npm link` 后全局使用 `markflow` 命令。

可选依赖两项，缺失时相关功能自动降级并给出提示：

- **Electron**：用作 PDF 输出的排版引擎，随 `npm ci` 一并安装。
- **LibreOffice**：转换 `.doc`、`.xls`、`.ppt` 三种旧二进制格式必需；同时作为 PDF 输出的备用后端。macOS 用 `brew install --cask libreoffice` 安装。

## 命令行

```bash
markflow convert <输入...> [--to bundle|docx|pdf] [--out <目录>] [--json] [--concurrency <n>]
markflow formats [--json]
markflow mcp
```

**convert** 接受多个输入，可以是本地文件路径或网页地址，混合传入也可以。

- `--to` 省略时按输入类型取默认值：办公文档、PDF 与网页转 `bundle`，Markdown 转 `docx`。
- `--out` 指定输出目录，必须已存在；省略时取环境变量 `MARKFLOW_OUTPUT_DIR`，再回退到当前目录。
- `--json` 让标准输出只有一行 JSON 结果，进度与日志走标准错误，便于程序解析。省略时成功项的产物路径逐行打印到标准输出。
- 退出码：全部成功为 0，参数错误为 1，存在失败项为 2。

```bash
markflow convert 季度报告.docx 会议纪要.pptx --out ~/Documents/知识库
markflow convert 技术方案.md --to pdf --out ~/Desktop
markflow convert https://example.com/article --out ~/Documents/知识库
markflow convert ~/笔记/*.md --to docx --out ~/Documents/输出 --json
```

`--json` 模式的输出结构：

```json
{
  "ok": true,
  "outputDir": "/Users/you/Documents/知识库",
  "results": [
    {
      "input": "季度报告.docx",
      "target": "bundle",
      "name": "季度报告",
      "title": "2026 年第一季度经营分析",
      "outputPath": "/Users/you/Documents/知识库/季度报告",
      "outputs": {
        "md": "/Users/you/Documents/知识库/季度报告/季度报告.md",
        "json": "/Users/you/Documents/知识库/季度报告/季度报告.json",
        "imagesDir": "/Users/you/Documents/知识库/季度报告/images"
      },
      "imagesCount": 7,
      "warnings": []
    }
  ],
  "errors": []
}
```

**formats** 列出当前可用的输入类型、转换目标与运行时能力，包括 LibreOffice 是否就绪、PDF 用的是哪个后端。

## MCP 服务

以标准输入输出方式提供三个工具，供 agent 直接调用。

| 工具 | 入参 | 用途 |
|---|---|---|
| `convert_document` | `paths` 与 `urls` 至少一项；`target` 可选；`outputDir` 必填且须已存在；`returnContent` 为真时附带 Markdown 正文，上限 20 万字符 | 转换文件或网页，返回结构同命令行的 `--json` |
| `extract_article` | `url` 必填；`maxChars` 可选，默认 5 万字符 | 只提取不落盘，直接返回正文 Markdown 与元数据；不下载图片，仅列出地址。适合「读一篇文章」而不需要文件的场合 |
| `list_formats` | 无 | 查询可用格式与运行时能力 |

**Claude Code**：仓库根已有 `.mcp.json`，在本目录启动会话即自动识别。其他目录可执行：

```bash
claude mcp add markflow -- node /绝对路径/mcp/server.js
```

**Codex**：在 `~/.codex/config.toml` 追加：

```toml
[mcp_servers.markflow]
command = "node"
args = ["/绝对路径/mcp/server.js"]
```

## PDF 输出

Markdown 转 PDF 的链路是「Markdown 语法树 → HTML → Chromium 打印」，中文字体栈与打印样式经过专门调整。后端按顺序尝试：

1. **Electron 工作进程**：派生无界面 Electron 子进程调用 Chromium 打印，排版质量最高，为默认路径。
2. **LibreOffice**：先渲染为 DOCX，再由 `soffice --headless --convert-to pdf` 转换，作为未安装 Electron 时的备用。

两者都不可用时报错并给出安装提示。用 `markflow formats` 可查看当前生效的后端。

## 安全说明

- **网页抓取**内置 SSRF 防护：只允许 `http` 与 `https`；域名解析后的全部地址若命中环回、私网、链路本地、组播或保留段一律拒绝；连接钉扎在已校验的地址上，规避 DNS 重绑定；重定向逐跳复验，最多 5 跳；页面上限 20 MB，图片上限 10 MB。
- **Markdown 中的图片**只允许引用文档所在目录之内的本地文件，绝对路径、`../` 越界与指向外部的符号链接一律拒绝并记录告警，避免转换第三方文档时泄露本机文件。
- **原始 HTML** 在 Word 与 PDF 输出中只保留文本，不执行也不外发；PDF 打印页面启用内容安全策略，未解析的远程图片不会进入打印过程。
- **临时文件**写入进程私有目录，权限 600，进程退出时清理，过期残留定期回收。

## 目录结构

```
bin/markflow.js            命令行入口
mcp/server.js              MCP stdio 服务
converters/
  index.js                 转换调度：输入类型识别、目标裁决、标题与命名
  batch.js                 并发批处理与事件流
  output.js                产物落盘（bundle 与单文件两种形态）
  targets.js               输入类型与转换目标的对应关系
  soffice.js               LibreOffice 适配（异步、串行队列）
  parsers/                 各格式解析为中间表示
  renderers/               中间表示渲染为 md / json / html / docx / pdf
  ir/                      中间表示的结构、工具与 Markdown 处理
  assets/md-images.js      Markdown 图片解析与内嵌
  net/fetch-guard.js       SSRF 防护与限长抓取
  pdf/                     PDF 后端选择与 Electron 打印工作进程
  web/                     网页正文提取、噪声清洗、元数据与 front matter
test/                      测试与固定样本
```

## 开发与测试

```bash
npm test        # node:test，325 项
npm run cli     # 等同 node bin/markflow.js
npm run mcp     # 等同 node mcp/server.js
```

持续集成在分支推送与拉取请求时运行完整测试。

## 已知限制

- PDF 输入不提取图片；PowerPoint 只提取幻灯片正文中的图片，不含背景图与母版图；Excel 不提取图片。
- `.doc`、`.xls`、`.ppt` 三种旧二进制格式必须安装 LibreOffice 才能转换。
- Markdown 只能转为 Word 或 PDF，不支持转为知识库包；办公文档与网页只能转为知识库包，不支持直接转 Word 或 PDF。
- Readability 的可读性阈值已按中文段落长度下调（中文段落多在 50 至 150 字，默认阈值会把多数中文文章判为不可读）；判定失误时由字符数下限双重兜底，回退通用提取。

## 许可证

MIT，见 [LICENSE](LICENSE)。
