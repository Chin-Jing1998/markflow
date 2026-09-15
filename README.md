# MarkFlow

**v3.0.0**

文档转换工具：把办公文档、PDF 与网页转成 Markdown 知识库包，把 Markdown 转成 Word 或 PDF，并把以上全部输入转成 HTML 或 XML（含国家知识产权局专利五书 XML）。同一套转换内核由三个入口共用——桌面应用、命令行与 MCP 服务。

形态沿革：v1.0.0 为 Electron 桌面应用；v2.0.0 移除界面，改为纯命令行与 MCP；v3.0.0 重新提供桌面应用，与命令行、MCP 共用 `converters/` 内核，三端能力同步。相较 v2.0.0 的主要变化：

- 新增 `html` 与 `xml` 两个转换目标，`xml` 含 `generic` 与 `patent` 两套方言。
- PDF 输入改以 MinerU 云端解析为主，可拿到图片、版面、表格与公式；无令牌时回退本地文本层解析并告警。
- 图片统一归一为 JPG；docx 公式默认栅格为图片。
- 不再支持 `.doc`、`.xls`、`.ppt` 三种旧二进制格式，请先另存为 `.docx`、`.xlsx`、`.pptx`。
- 新增桌面应用：拖放转换、网页链接批量转换、双栏对比预览与格式面板、直接打开阅读、文件库管理。

## 输入与转换目标

输入按类别决定可选目标，规则的唯一定义处为 `converters/targets.js`。

| 输入类别 | 扩展名 / 形式 | 可选目标 | 省略 `--to` 时的默认目标 |
|---|---|---|---|
| Office / PDF | `.docx` `.xlsx` `.pptx` `.pdf` | `bundle` `html` `xml` | `bundle` |
| Markdown | `.md` `.markdown` | `docx` `pdf` `html` `xml` | `docx` |
| 网页链接 | `http` / `https` | `bundle` `html` `xml` | `bundle` |

各目标的产物形态：

| 目标 | 落盘布局 | 产物 |
|---|---|---|
| `bundle` | 目录 | 仿照 MinerU 结果包：`{名称}/{名称}.md` + `{名称}.json` + `{名称}_content_list.json` + `images/`（原图）；PDF 走 MinerU 时另有 `{名称}_content_list_v2.json`、`{名称}_model.json`、`{名称}_layout.json`、`{名称}_origin.pdf` |
| `docx` | 单文件 | `{名称}.docx` |
| `pdf` | 单文件 | `{名称}.pdf` |
| `html` | 目录 | `{名称}/{名称}.html` + `images/` |
| `xml`（`generic`） | 目录 | `{名称}/{名称}.xml` + `images/` |
| `xml`（`patent`） | 目录 | `{名称}/` 下五书 XML + 平铺的 JPG + `{名称}.zip` + `precheck.json` |

`pdf` 目标只在 PDF 出图后端可用时列出；后端状态见 `markflow formats`。

## 安装

要求 Node.js 22 或更高版本。

```bash
npm ci
```

仓库内可直接执行 `node bin/markflow.js`，或 `npm link` 后全局使用 `markflow` 命令。

依赖说明：

- **electron** 位于 `devDependencies`，用作 PDF 出图与栅格化（表格、公式转图片）的渲染引擎，同时是桌面应用的运行时。命令行用户必须执行完整的 `npm ci`：加 `--omit=dev` 会同时失去 PDF 输出与栅格化能力，此时 `markflow formats` 会把两个后端标为不可用。
- **libxml2-wasm** 位于 `optionalDependencies`，仅 `--validate` 的 DTD 校验用到。未安装时校验步骤跳过并记入 warnings，转换本身不受影响。
- **LibreOffice** 非必需，仅在两处作为兜底：PDF 出图的第三级后端，以及 `patent` profile 下 EMF/WMF 图元的栅格化。未安装时对应路径降级并告警。

## 桌面应用

```bash
npm start
```

界面为 Apple 风格，深浅色跟随系统设置，也可在设置页固定为浅色或深色。功能分四页：

- **转换**：拖放文件或文件夹，或在「网页链接」输入框中每行粘贴一个 `http`/`https` 地址批量提交；任务列表实时显示进度与告警，并发为 2。
- **对比预览**：左栏为来源、右栏为产物；侧边格式面板按目标切换可调字段，排版类改动实时重渲染，解析类改动（图片格式、公式处理、PDF 后端、XML profile 及其子项）在同一会话内重新解析后重渲染；确认后导出并写入文件库。
- **阅读**：直接打开 `.md`、`.html`、`.xml`、`.pdf`、`.json` 渲染阅读，图片位置与原文一致；`.json` 按格式化文本展示，解析失败时按原文显示并提示错误。`.md` 支持渲染｜原文｜编辑三页签切换；左侧打开记录按所在文件夹分组，可收藏。
- **文件库**：默认索引模式，只记录产物位置不搬动文件；可在设置页切换为托管模式并把既有产物迁移到 `~/Documents/MarkFlow Library/{YYYY-MM}/`。支持按来源类型、目标、月份、目录、主机名、标签与收藏分面，支持搜索、定位、重新转换与删除（可选一并把产物移到废纸篓）；除转档输入格式外另列出并可打开 `.html`、`.htm`、`.xml`、`.json`，其中 `.md` 同样支持渲染｜原文｜编辑三页签。
- **Markdown 编辑**：文件库、阅读页与对比预览中的 `.md` 编辑页均为源码与实时预览左右分栏，工具栏含标题级别、加粗、斜体、下划线、删除线、行内代码、代码块、引用、无序/有序列表、任务列表、表格、链接、图片、分隔线、脚注；停止输入约 1 秒自动保存，⌘S 立即保存，文件被外部修改时提示覆盖保存或重新载入。对比预览中的编辑改动在导出前暂存，确认后随导出写入文件库。
- **顶部功能栏与查找**：文件库、阅读页打开文件时显示，含视图切换（渲染｜原文｜编辑）、后退／前进（⌘[／⌘]）与居中文件名；当前文件操作（收藏、在访达中显示、用默认应用打开，「⋯」菜单另有复制路径，文件库另有重新转换）；阅读辅助为大纲、文内查找与字号缩放（A−／A+）。文内查找 ⌘F 打开，Enter 或 ⌘G 下一处，⇧Enter 或 ⇧⌘G 上一处，Esc 关闭；编辑页查找时全部命中以浅色标出、当前命中以深色标出，关闭后焦点回到编辑区并选中当前命中。
- **设置**：外观、默认输出目录、各输入类别的默认目标、转换默认项、MinerU 令牌的保存与连通性测试、文件库模式。

MinerU 令牌在桌面端经系统 `safeStorage` 加密后单独存于 `secrets.json`，不下发界面、不写入日志、不进入任何 IPC 回包。

平台与签名：Electron 44.3.0，支持 macOS 13 及以上与 Windows 10 及以上。本期不做代码签名与公证，首次打开需要手动放行：

```bash
# macOS：解除隔离属性后正常启动，或在 Finder 中右键选「打开」
xattr -dr com.apple.quarantine /Applications/MarkFlow.app
```

Windows 上 SmartScreen 会拦截未签名安装包，点「更多信息」后选择「仍要运行」。

## 命令行

```bash
markflow convert <输入...> [--to bundle|docx|pdf|html|xml] [--out <目录>] [--json] [--concurrency <n>] [转换选项...]
markflow formats [--json]
markflow config get [--json] | config set <项> <值> | config unset <项>
markflow mcp
```

### 通用选项

| 选项 | 说明 |
|---|---|
| `--to <目标>` | `bundle` \| `docx` \| `pdf` \| `html` \| `xml`；省略时按输入类型取默认目标 |
| `--out <目录>` | 输出目录，必须已存在；省略时取环境变量 `MARKFLOW_OUTPUT_DIR`，再回退到当前目录 |
| `--json` | 标准输出只有一行 JSON 结果，进度与错误一律走标准错误 |
| `--concurrency <n>` | `convert` 的并发数，默认 2 |
| `-h, --help` | 显示帮助 |
| `-v, --version` | 显示版本号 |

退出码：0 为全部成功，1 为参数错误或运行异常，2 为存在失败项。

### convert 的转换选项

取值范围与默认值的唯一定义处为 `converters/options.js`，下表与 `markflow convert --help` 同源。

| 选项 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `--theme <主题>` | `apple` \| `apple-dark` \| `github` \| `academic` \| `reader` \| `print` | `apple` | HTML 主题；同时作用于 `html` 与 `pdf` 目标 |
| `--xml-profile <profile>` | `generic` \| `patent` | `generic` | XML 方言：`generic` 通用文档结构，`patent` 国知局专利五书 |
| `--patent-parts <部分列表>` | `claims` \| `description` \| `drawings` \| `abstract` \| `abstract-figure`，逗号分隔 | `auto` | `patent` profile 下输出的五书子集；`auto` 按识别结果输出 |
| `--pdf-backend <后端>` | `auto` \| `mineru` \| `local` | `auto` | PDF 解析后端：`auto` 有令牌走云端否则本地，`mineru` 强制云端，`local` 强制本地 |
| `--image-format <格式>` | `jpg` \| `keep` | `jpg` | 图片归一格式：`jpg` 把位图统一转为 JPEG，`keep` 保持原格式 |
| `--jpeg-quality <n>` | 整数 60–100 | `90` | JPEG 压缩质量 |
| `--jpeg-ppi <n>` | 整数 72–600 | `330` | JPEG 分辨率（PPI） |
| `--math <方式>` | `image` \| `text` | `image` | docx 公式：`image` 栅格为图片，`text` 降级为线性化文本 |
| `--mineru-model <模型>` | `pipeline` \| `vlm` | `pipeline` | MinerU 解析模型 |
| `--mineru-ocr` | 布尔开关 | `false` | 强制 OCR |
| `--mineru-lang <语言>` | 1–32 位字母、数字、`_`、`-` | `ch` | 文档语言代码 |
| `--page-ranges <范围>` | 形如 `1-5,8` | 无 | MinerU 解析的页码范围 |
| `--font <字体栈>` | CSS `font-family` 值 | 无 | 正文字体栈；省略时取主题默认栈 |
| `--font-size <n>` | 10–32 | `16` | 正文字号（px）；`docx` 目标按 pt 取同一取值，范围 8–36 |
| `--line-height <n>` | 1–3 | `1.7` | 行高倍数 |
| `--numbering-start <n>` | 整数 1–9999 | `1` | 说明书段号起始值 |
| `--validate` | 布尔开关 | `false` | 仅 `xml` 目标生效：渲染后用官方 DTD 校验，结果写入 warnings 与 `precheck.json` |

使用示例：

```bash
# 办公文档转知识库包
markflow convert 季度报告.docx 会议纪要.pptx --out ~/Documents/知识库

# Markdown 转 PDF
markflow convert 技术方案.md --to pdf --out ~/Desktop

# 任意输入转 HTML，指定主题
markflow convert 产品手册.docx --to html --theme academic --out ~/Desktop

# 网页批量转知识库包
markflow convert https://example.com/a https://example.com/b --out ~/Documents/知识库

# 专利底稿转五书 XML 并做 DTD 校验
markflow convert 专利底稿.docx --to xml --xml-profile patent --validate --out ~/Desktop
```

### 配置

`markflow config` 读写 `~/.markflow/config.json`（目录 0700、文件 0600、临时文件加 rename 原子写）。目前可配置项只有 `mineru-token`。

```bash
markflow config set mineru-token <令牌>   # 写入配置文件，取值不回显
markflow config get                        # 只报是否已配置与当前生效来源
markflow config unset mineru-token         # 从配置文件移除；其它来源仍可能提供取值，会另行提示
```

### --json 输出结构

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
      "sourceType": "docx",
      "outputPath": "/Users/you/Documents/知识库/季度报告",
      "outputs": {
        "md": "/Users/you/Documents/知识库/季度报告/季度报告.md",
        "json": "/Users/you/Documents/知识库/季度报告/季度报告.json",
        "imagesDir": "/Users/you/Documents/知识库/季度报告/images"
      },
      "imagesCount": 7,
      "warnings": [],
      "options": { "imageFormat": "jpg", "jpegQuality": 90 },
      "extras": [],
      "backends": { "pdfParser": null, "raster": "electron-worker" }
    }
  ],
  "errors": []
}
```

字段说明：`options` 为本次生效的完整选项（`mineru.token` 一律置 `null`）；`extras` 为已落盘附属文件在产物目录内的相对路径（MinerU 产物即在此列）；`backends` 记录实际生效的 PDF 解析后端与栅格化后端；`--validate` 时信封另有 `validate: true`。

## MCP 服务

以标准输入输出提供三个工具，供 Claude Code、Codex 等 agent 直接调用。

| 工具 | 用途 |
|---|---|
| `convert_document` | 转换本地文件或网页，返回结构与命令行 `--json` 一致 |
| `extract_article` | 抓取网页只返回正文 Markdown 与元数据，不落盘、不下载图片 |
| `list_formats` | 返回输入与目标的对应矩阵、可选主题与 XML profile，以及本机 PDF 后端、栅格化后端与 MinerU 令牌状态 |

`convert_document` 入参：

| 入参 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `paths` | `string[]` | 与 `urls` 至少一项 | 本地文件绝对路径列表 |
| `urls` | `string[]` | 与 `paths` 至少一项 | 网页 URL 列表 |
| `outputDir` | `string` | 是 | 已存在的输出目录绝对路径 |
| `target` | `bundle` \| `docx` \| `pdf` \| `html` \| `xml` | 否 | 省略时按输入类型取默认目标 |
| `returnContent` | `boolean` | 否 | 为真时附带生成的 Markdown 正文，上限 20 万字符 |
| `theme` | 六款主题之一 | 否 | `html` 与 `pdf` 目标的主题 |
| `xmlProfile` | `generic` \| `patent` | 否 | XML 方言 |
| `patentParts` | 五书名数组 | 否 | `patent` profile 下输出的五书子集 |
| `pdfBackend` | `auto` \| `mineru` \| `local` | 否 | PDF 解析后端 |
| `imageFormat` | `jpg` \| `keep` | 否 | 图片归一格式 |
| `jpegQuality` | `integer` | 否 | JPEG 压缩质量，60–100 |
| `jpegPpi` | `integer` | 否 | JPEG 分辨率，72–600 PPI，默认 330 |
| `math` | `image` \| `text` | 否 | docx 公式处理方式 |
| `validate` | `boolean` | 否 | `xml` 目标的校验开关 |
| `mineru` | `{ model, ocr, language, pageRanges }` | 否 | MinerU 解析参数；令牌不接受经此传入 |
| `html` | `{ fontFamily, fontSize, lineHeight, contentWidth, spacing, inlineImages }` | 否 | HTML 目标参数：字体栈、字号（px）、行高、栏宽（px）、段距档位与图片内联 |
| `docx` | `{ pageSize, fontSize, fontAscii, fontEastAsia }` | 否 | DOCX 目标参数：纸张、正文字号（pt）与中西文字体 |
| `xml` | `{ indent, numberingStart, numberingWidth }` | 否 | XML 目标参数：缩进空格数与说明书段号的起始值、补零位数 |

`extract_article` 入参为 `url`（必填）与 `maxChars`（可选，默认 5 万字符，超出截断并以 `truncated` 标记）；返回 `url`、`finalUrl`、`title`、`wordCount`、`extraction`、`markdown`、`truncated`、`images`，以及取得时才出现的 `author`、`publishedAt`、`siteName`、`excerpt`、`lang`。`list_formats` 无入参。

**Claude Code**：仓库根已有 `.mcp.json`，在本目录启动会话即自动识别。其他目录执行：

```bash
claude mcp add markflow -- node /绝对路径/mcp/server.js
```

**Codex**：在 `~/.codex/config.toml` 追加：

```toml
[mcp_servers.markflow]
command = "node"
args = ["/绝对路径/mcp/server.js"]
```

## 各目标的产物说明

### bundle：Markdown 知识库包

产物为 `{名称}/` 目录，含 `{名称}.md`、`{名称}.json` 与 `images/`。Markdown 带 YAML front matter，字段顺序固定，缺失字段整条省略：标题、作者、发布时间、原文链接、最终地址、来源类型、PDF 解析后端、MinerU 模型、站点名、摘要、语言、字数、提取方式、抓取与转换时间。Obsidian、basic-memory 等工具可直接索引并回溯出处。

JSON 产物结构为 `{ schemaVersion, kind, ir, data, meta }`，其中 `ir` 为 mdast 语法树，`kind` 取 `document`、`workbook` 或 `presentation`。

网页正文提取为三级策略：微信、知乎、CSDN、简书、掘金、思否、少数派、博客园的专属选择器优先命中；未命中走 Mozilla Readability 评分；再不行回退通用容器识别。实际命中的方式记录在 `meta.extraction`。噪声清洗在图片下载之前完成，被剔除区域内的图片不会产生网络请求。

### html：六款主题

主题名单与各自定位：`apple`（默认，浅色苹果风）、`apple-dark`（深色苹果风）、`github`（仿 GitHub Markdown）、`academic`（衬线论文风，中文优先宋体）、`reader`（长文阅读，大字距）、`print`（打印样式，逐字沿用 v2）。

主题 CSS 不引用任何远程资源，页面在 `default-src 'none'` 的 CSP 下也不发起网络请求。`--font`、`--font-size`、`--line-height` 与 MCP 的 `html.contentWidth`、`html.spacing` 以 CSS 自定义属性注入，主题样式本身不变。图片默认以 `images/` 相对路径引用，`html.inlineImages` 为真时改为 data URI 内联。

### xml：generic profile

命名空间 `urn:markflow:document:1`，把 mdast 逐节点映射为 XML：块级含 `heading`、`p`、`list`、`item`、`table`、`row`、`cell`、`code`、`quote`、`figure`、`hr`、`section-break`（幻灯片分页与工作表分节保真不降级），行内含 `b`、`i`、`s`、`code`、`a`、`br`、`image`、`math`。`--validate` 对 `generic` 只做 well-formed 检查。

### xml：patent profile（国知局专利五书）

自 2026-01-01 起，中国专利电子申请一律以 XML 格式提交。本 profile 直接对齐官方「WORD 转 ACXML 编辑器」的输出结构，把 docx 底稿转为可提交的五书 XML。

产物落在 `{名称}/` 目录下：

```
{名称}/
  claims.xml            权利要求书  <cn-claims>
  description.xml       说明书      <description>
  drawings.xml          说明书附图  <cn-drawings>
  abstract.xml          说明书摘要  <cn-abstract>
  abstract-figure.xml   摘要附图    仅识别到时生成
  drawing-1.jpg         图片以裸文件名平铺在目录根下，不建 images/
  table-1.jpg           表格栅格化产物
  omath-14-1.jpg        公式栅格化产物，命名为 omath-<段号>-<序号>.jpg
  {名称}.zip            五书 XML 与全部图片的同一平铺集合
  precheck.json         预检问题清单与校验记录，不入 zip
```

结构约定：每份文件头三行固定为 XML 声明、`<!DOCTYPE cn-application-body SYSTEM "/dtdandxsl/cn-application-body-20080416.dtd">` 与 `showxml.xsl` 样式处理指令，根元素为 `<cn-application-body lang="zh" country="CN">`。说明书段号四位补零连续编排（段首已有 `[0001]` 者剥离并复用，与预期不一致时记「段号跳变」告警）；权项 id 形如 `cl001`，`根据权利要求 N 所述` 自动解析为 `<claim-ref>`；附图 id 形如 `f0001`、图片 id 形如 `i0001`，`wi`/`he` 由像素与 JPEG 密度换算为毫米。表格与公式在本 profile 下一律栅格为 JPG，栅格化后端不可用时降级为逐行文本或线性化文本并告警。

转档前预检覆盖：GB18030 之外的字符、图片格式与密度（官方只受理 JPG/TIF、72–300 DPI）、浮动对象与文本框、OLE 对象、Word 自动编号、修订痕迹、文档保护、批注、非常规中文字体、公式后标点、缺节。问题项分 `blocking`（官方工具会拒绝转换）与 `warning` 两级，全部写入 `precheck.json` 并进入结果的 `warnings`。因此，patent profile 提交前应使用 `--jpeg-ppi 72–300`；通用 JPG 默认值仍为 330 PPI。

加 `--validate` 后，随包分发的官方 DTD 会逐份校验五书。交叉核对可用 `xmllint`，在仓库根目录执行：

```bash
xmllint --nonet --noout --dtdvalid converters/renderers/xml/dtd/cn-application-body-20080416.dtd <file.xml>
```

两点须知：`xmllint` 把 `--dtdvalid` 的参数当 URI 处理，含中文的绝对路径会报 `Could not parse DTD`，故须用上面的相对路径；stderr 中的 `failed to load external entity "/dtdandxsl/…"` 属预期（文档内的 SYSTEM 标识符指向官方部署路径，本地不存在），`drawings.xml` 的 `Content model of cn-drawings is not deterministic` 是官方 DTD 自身的缺陷，两者都不影响校验结论。

与官方编辑器的差异——本工具跨平台运行、不依赖 Office 或 WPS、不要求套用五书模板、公式按目标 DPI 放大后再栅格、转档前即给出预检清单。本期不覆盖：案卷包（表格代码目录 100001–100005 与 `List.xml`）、化学式识别、XML 反向导入、一键提交到客户端草稿箱。

完整的政策背景、官方编辑器内部结构、DTD 解读与映射决策见 [docs/patent-xml-research.md](docs/patent-xml-research.md)。

## PDF 输入：MinerU 与本地后端

`--pdf-backend` 三种取值的行为：

- `auto`（默认）：取得令牌走 MinerU 云端解析；取不到则回退本地 pdfjs 文本层解析，并追加告警「未配置 MinerU 令牌，已回退本地文本层解析：无图片、无版面」。
- `mineru`：强制云端；取不到令牌直接报错并给出配置方式，不回退。
- `local`：强制本地，不读取任何令牌来源。

云端解析失败时不会静默降级为本地解析——回退会悄悄产出一份缺图少版面的文档，显式报错并提示 `--pdf-backend local` 才能把选择权交回使用者。常见错误码（令牌无效、超出 200 MB、超出页数上限、额度耗尽、解析超时）均已中文化，并附具体处置建议；超时文案带 `batch_id` 便于到控制台查任务。

MinerU 结果包按文档名改名后与主产物平铺在同一目录：`*_content_list.json` → `{名称}_content_list.json`（图片块补 `display` 显示尺寸，由 0–1000 归一化 `bbox` × `layout.json` 的 `page_size` × 96/72 算出）、`*_content_list_v2.json` → `{名称}_content_list_v2.json`、`*_model.json` → `{名称}_model.json`、`layout.json` → `{名称}_layout.json`、`*_origin.pdf` → `{名称}_origin.pdf`，其余文件加 `{名称}_` 前缀。`full.md` 只用于构建中间表示、不再落盘；包内图片（含 `full.md` 未引用的表格截图）统一编号为 `images/image_N.*` 并保留原字节，各 JSON 中的哈希图名随之改写为 `images/image_N.*`（`layout` 中为裸文件名）。content_list 的 `image_caption` / `image_footnote` 文字会移到对应图片之后成段。

令牌按以下优先级解析，任一环节取到即停止：

1. 显式传入（桌面端由主进程解密后注入，命令行与 MCP 不接受明文传入）
2. 环境变量 `MINERU_TOKEN`
3. 环境变量 `MINERU_API_TOKEN`
4. `~/.markflow/config.json`（`markflow config set mineru-token <令牌>` 写入，文件权限 0600；适用于宿主清洗环境变量的场景）
5. `~/.mineru/config.yaml`（MinerU 官方命令行的配置，只读兼容）

`markflow config get` 与 `markflow formats` 只显示是否已配置与当前生效来源，任何路径都不回显令牌本身；错误信息在输出前统一抹除令牌与 `Bearer` 片段。

## 图片与公式处理

图片默认统一为 JPG：png、bmp、tiff、webp 与静态 gif 解码后铺白合成，以 `--jpeg-quality`（默认 90）控制压缩质量，并以 `--jpeg-ppi`（默认 330 PPI）写入 JFIF 密度；已是 JPEG 的只补写密度、不重编码。svg、emf、wmf 与动图 gif 保持原格式并告警。`--image-format keep` 关闭整条归一链路。

`bundle` 目标例外：`images/` 存与原件逐字节一致的原图（不转码、不改 JFIF 密度），归一与上述选项只作用于 html、xml 等其它目标；tiff、emf、wmf 原样保留并告警「多数 Markdown 查看器无法显示」。Markdown 中的图片取得到原文档或原网页的显示尺寸时写成 `<img src="images/image_N.ext" width="W" alt="…">`（docx 取 `wp:extent`、pptx 取形状 `a:ext`、网页取 width 属性或样式、MinerU 取 `bbox`），段首缩进写为全角空格，图注为紧随图片的独立段落。

护栏与降级：默认按 `raster.maxWidth`（1600 px）等比缩小，`patent` profile 下禁用缩放以保留原始像素；像素数超过 8000 万或字节数超过 200 MB 的图片保留原图并告警；多页 TIFF 取首页；单张失败只降级为告警，不影响整份转换。`patent` profile 下的 EMF/WMF 先试栅格化后端，再试 LibreOffice，两者皆不可用时告警。

docx 中的 OMML 公式默认栅格为图片（`--math image`）：先转 MathML，再由 Chromium 内的 MathJax 渲染后截图。`--math text` 降级为线性化文本。旧版 Equation 3.0 公式（OLE + WMF）按图片处理并告警。

PDF 出图与栅格化各有一条回退链，两者都以桌面端主进程内的 Electron 渲染为首选，其次为派生的独立 Electron 工作进程；PDF 出图另有第三级 LibreOffice，栅格化没有。两条链当前生效的后端由 `markflow formats` 分别报出。

## 同批同名产物的命名

同一次 `convert` 内，不同输入可能派生出相同的产物名（同基名不同扩展名、不同目录下的同名文件、标题相同的网页）。登记表按批内序号裁决：首个保留原名；本地文件且扩展名与占用者不同时取 `名称 (扩展名)`，如 `sample (pptx)`；其余情形取 `名称 (2)` 并递增。落盘形态不同的产物分槽登记，`sample.md → sample.docx` 与 `sample.docx → sample/` 同批互不改名。

登记表的生命周期即一批任务：跨批次仍为同名产物直接覆盖，故重复转换同一输入依然幂等。

## 安全说明

- **网页抓取**内置 SSRF 防护：只放行 `http` 与 `https`；主机名解析出的全部地址若命中环回、私网、链路本地、组播或保留段一律拒绝；连接钉扎在刚校验通过的地址上以消除 DNS 重绑定；重定向逐跳复验，最多 5 跳；页面上限 20 MB，图片上限 10 MB。桌面端不提供私网开关。
- **Markdown 中的图片**只允许引用文档所在目录之内的本地文件，绝对路径、`../` 越界与指向外部的符号链接一律拒绝并记录告警。
- **原始 HTML** 在 Word 与 PDF 输出中只保留去标签后的文本，例外只有两处且各有白名单校验：上游清洗过的 `<table>` 与 MathML 片段。HTML 与 PDF 页面均声明 CSP，`img-src` 随图片寻址模式收紧，无本地资产的图片一律丢弃 `src` 只留 `alt`——打印与预览都在本机运行，保留远程地址等于把已被守卫拦下的请求重新放行。
- **桌面端**渲染进程不开放 `file://`：界面自身经 `mf-app://` 加载，本地图片与 PDF 一律经主进程授权的 `mf-asset://<会话>/` 协议供给，处理器逐项做目录边界、符号链接与扩展名白名单校验。渲染进程 CSP 为 `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' mf-asset: data:; frame-src mf-asset: about:; connect-src 'none'; object-src 'none'`；产物与来源视图一律置于不带 `allow-scripts` 的 `<iframe sandbox srcdoc>` 内；外链仅 `http`/`https` 交系统浏览器，页面内导航全部拒绝。
- **令牌**：命令行侧写入 `~/.markflow/config.json`（目录 0700、文件 0600、原子写），桌面端侧经系统 `safeStorage` 加密单独存放；两端都不回显、不进日志、不进结果信封。
- **临时文件**写入进程私有目录，进程退出时清理，超过一天的残留定期回收；stderr 摘要中的本机绝对路径统一脱敏。

## 目录结构

```
bin/markflow.js            命令行入口
mcp/server.js              MCP stdio 服务
converters/
  index.js                 转换调度：解析 → 图片归一 → 栅格化 → 渲染 → 落盘
  service.js               三端共用的服务层（能力探测、选项映射、任务规划、结果信封）
  targets.js               输入识别、归类与目标裁决（规则的单一来源）
  options.js               转换选项的默认值、枚举、取值范围与中文错误文案
  config.js                ~/.markflow/config.json 与 MinerU 令牌的来源优先级
  naming.js                批内产物名登记表
  output.js                产物落盘（单文件与目录两种布局）
  batch.js                 并发批处理与事件流
  parsers/                 docx / xlsx / pptx / pdf / md / url 解析为中间表示
  renderers/               中间表示渲染为 md / json / html / docx / pdf / xml
    html-themes/           六款 HTML 主题
    xml/                   generic 与 patent 两套方言、预检、DTD 校验与随包 DTD
  ir/                      中间表示的结构、工具与表格清洗
  assets/                  Markdown 图片解析与 JPG 归一
  math/                    OMML → MathML
  raster/                  栅格化后端与节点栅格化
  chromium/                Electron 子进程派生
  pdf/                     PDF 出图后端、Electron 打印工作进程、MinerU 云端解析
  net/fetch-guard.js       SSRF 防护与限长抓取
  web/                     网页正文提取、噪声清洗、元数据与 front matter
desktop/
  main/                    主进程：窗口、IPC、自定义协议、设置、预览、阅读、文件库
  preload.js               受控的 window.markflow.* 暴露面
  renderer/                零构建渲染层（原生 ES 模块 + Web Components）
docs/patent-xml-research.md  专利 XML 研究报告
test/                      测试与固定样本
```

## 开发与测试

```bash
npm test        # node:test，953 项（2026-09-16 实测）
npm run cli     # 等同 node bin/markflow.js
npm run mcp     # 等同 node mcp/server.js
npm start       # 等同 electron .，启动桌面应用
```

测试不要求 Electron：无法启动时相关用例自动跳过。持续集成在 `ubuntu-latest`、`macos-latest` 与 `windows-latest` 三个平台运行完整测试，Ubuntu 侧经 `xvfb-run` 提供虚拟显示，使真实 Electron 用例得以实际执行。

## 打包与发布

```bash
npm run build:mac    # macOS：未签名 dmg 与 zip（universal，Intel 与 Apple 芯片通用）
npm run build:win    # Windows：NSIS 安装包（x64，Windows 10 及以上）
npm run build:all    # 两个平台一并打包
```

产物落在 `dist/`；Windows 安装包也可在 macOS 上直接构建，无需 Wine。推送 `v*` 标签时，持续集成在 macOS 与 Windows 运行器上各打一次包，并把 `dist/*.dmg`、`dist/*.zip` 与 `dist/*.exe` 附到对应 Release。构建不做代码签名与公证。

## 已知限制

- 本地 PDF 后端（`--pdf-backend local`）只取文本层，不提取图片、不还原版面与表格；完整能力需 MinerU 令牌。
- Excel 不提取内嵌图片；PowerPoint 只提取幻灯片正文中的图片，不含背景图与母版图，也不处理表格、SmartArt 与动画；Excel 不处理合并单元格，公式取结果值。Excel 解析依赖 exceljs，其不识别以命名空间前缀书写的工作簿部件（如 `<x:workbook>`，见于部分 Open XML SDK 系工具生成的文件），此类文件会报「Cannot read properties of undefined (reading 'sheets')」，用 Excel 或 WPS 另存一次即可。
- `.doc`、`.xls`、`.ppt` 三种旧二进制格式不再受理，请先另存为对应的 Open XML 格式。
- `bundle` 只接受 Office、PDF 与网页输入；`docx` 与 `pdf` 只接受 Markdown 输入。
- `patent` profile 不识别化学式，不生成案卷包，不支持 XML 反向导入与一键提交。
- `--validate` 需要可选依赖 libxml2-wasm；未安装时跳过校验并在 warnings 中说明。
- Readability 的可读性阈值已按中文段落长度下调（中文段落多在 50 至 150 字，默认阈值会把多数中文文章判为不可读）；判定失误时由字符数下限双重兜底，回退通用提取。

## 许可证

MIT，见 [LICENSE](LICENSE)。
