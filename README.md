# MarkFlow

**v3.0.0**

文档转换工具：把办公文档、PDF 与网页转成 Markdown 知识库包，把 Markdown 转成 Word 或 PDF，并把以上全部输入转成 HTML 或 XML（含国家知识产权局专利五书 XML）。同一套转换内核由三个入口共用——桌面应用、命令行与 MCP 服务。

形态沿革：v1.0.0 为 Electron 桌面应用；v2.0.0 移除界面，改为纯命令行与 MCP；v3.0.0 重新提供桌面应用，与命令行、MCP 共用 `converters/` 内核。三端共用同一套转换内核与选项定义（`converters/options.js`），转换结果的结构也一致；但三端的交互面并不等同：桌面端格式面板的 33 项转换选项在命令行（36 个旗标）与 MCP（15 个选项入参，含嵌套段）中均有对应，页边距三端都未开放，且命令行会预检输入文件是否存在、MCP 不预检（缺失项记入 `errors`）。相较 v2.0.0 的主要变化：

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
| 国知局专利五书 XML | 单个 `.xml`、案卷 `.zip`、五书目录（内含 `10000N/10000N.xml` 或五书 XML） | `docx` `pdf` `html` `xml` | `docx` |
| 网页链接 | `http` / `https` | `bundle` `html` `xml` | `bundle` |

各目标的产物形态：

| 目标 | 落盘布局 | 产物 |
|---|---|---|
| `bundle` | 目录 | 仿照 MinerU 结果包：`{名称}/{名称}.md` + `{名称}.json` + `{名称}_content_list.json` + `images/`（原图）；PDF 走 MinerU 时另有 `{名称}_content_list_v2.json`、`{名称}_model.json`、`{名称}_layout.json`、`{名称}_origin.pdf` |
| `docx` | 单文件 | `{名称}.docx` |
| `pdf` | 单文件 | `{名称}.pdf` |
| `html` | 目录 | `{名称}/{名称}.html` + `images/` |
| `xml`（`generic`） | 目录 | `{名称}/{名称}.xml` + `images/` |
| `xml`（`patent`） | 目录 | `{名称}/` 下按表格代码分目录的五书 XML 与图片（`100001/100001.xml`、`100003/100003_1.jpg` 等）+ `{名称}.zip` + `precheck.json` |

`pdf` 目标只在 PDF 出图后端可用时列出；后端状态见 `markflow formats`。

目录输入展开为其下受支持的文件；`.xml` 与 `.zip` 只在显式给出时受理，不随目录展开（文档目录里的这两类文件绝大多数与专利无关），成套的五书目录则整体作为一项输入，详见「专利五书 XML 反向导入」。

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
- **设置**：外观、默认输出目录、各输入类别的默认目标、转换默认项、MinerU 令牌的保存与连通性测试、文件库模式、Word 加载项的启用与安装（见下文「Word for Mac 加载项」）、运行能力自检，以及「关于」——三端使用方法、联系与反馈、版本比对式的检测更新。

MinerU 令牌在桌面端经系统 `safeStorage` 加密后单独存于 `secrets.json`，不下发界面、不写入日志、不进入任何 IPC 回包。

平台与签名：Electron 44.3.0，支持 macOS 13 及以上与 Windows 10 及以上。本期不做代码签名与公证，首次打开需要手动放行：

```bash
# macOS：解除隔离属性后正常启动，或在 Finder 中右键选「打开」
xattr -dr com.apple.quarantine /Applications/MarkFlow.app
```

Windows 上 SmartScreen 会拦截未签名安装包，点「更多信息」后选择「仍要运行」。

## Word for Mac 加载项

在 Mac 版 Word 里打开任务窗格、点一次按钮，即由本机的 MarkFlow 把**当前文档（含未保存的编辑）**转换为国知局专利五书 XML 并写入磁盘，任务窗格随后显示发明名称、识别到的各书、预检阻断项、分组告警与产物路径，并可在访达中定位产物、在 MarkFlow 的阅读页中预览。转换等价于命令行 `markflow convert <docx> --to xml --xml-profile patent --validate`，产物逐字节相同；「设置 › 转换默认项」中的图片格式、JPG 分辨率等同样作用于加载项的转换。

使用前提：macOS 版 Word（2026-09-18 在 Word for Mac 16.107 实测通过）；**不要求登录 Microsoft 账户，也不要求 Microsoft 365 订阅**；使用期间 MarkFlow 须保持运行；任务窗格首次加载需要联网，从微软官方 CDN 取 `office.js`（文档本身不离开本机）。Windows 版 Word 暂不支持。

安装分三步，均在 MarkFlow 的「设置 › Word 加载项」中完成：

1. 勾选「启用 Word 加载项」，确认服务状态为「监听中」。该开关**默认关闭**，不启用时 MarkFlow 不监听任何端口。
2. 点「安装到 Word」。MarkFlow 把清单写入 Word 的旁加载目录 `~/Library/Containers/com.microsoft.Word/Data/Documents/wef/`（不存在则创建）；macOS 询问是否允许访问其他 App 的数据时选择允许。被拒绝时界面会给出一条可粘贴到「终端」的手动安装命令。
3. 完全退出 Word（⌘Q，关窗口不算）后重新打开，在「开始 › 加载项」中选择「MarkFlow 专利 XML」；旧版界面在「插入 › 我的加载项 › 开发人员加载项」。清单只在 Word 启动时读取，故安装与移除之后都要重开 Word。

产物位置由 MarkFlow 决定，任务窗格不能指定任意目录：文档已保存在本机时，产物目录与源文件同级（与命令行的习惯一致）；文档尚未保存、位于云端、或所在目录不可写时，产物存入设置里的输出目录，未保存的文档以「未命名文档-时间戳」命名，原因会显示在任务窗格中。

卸载：点「从 Word 移除」后重开 Word。MarkFlow 只删除自己的清单文件，旁加载目录因此为空时一并删除。若加载项仍出现在 Word 中，须按微软的说明整体清空 Office 的加载项缓存；该操作会同时移除其他旁加载的加载项，故 MarkFlow 不代为执行。

端口固定为 `49731`（写在 Word 的清单里，因此不会自动改用其他端口）。被其他程序占用时，设置页显示「端口被占用」并给出排查命令 `lsof -nP -iTCP:49731 -sTCP:LISTEN`；退出占用者后取消勾选再重新勾选「启用」即可。本期没有功能区按钮，加载项只能从加载项列表打开。

## 命令行

```bash
markflow convert <输入...> [--to bundle|docx|pdf|html|xml] [--out <目录>] [--json] [--concurrency <n>] [转换选项...]
markflow extract <网址> [--json] [--max-chars <n>]
markflow formats [--json]
markflow config get [--json] | config set <项> <值> | config unset <项>
markflow mcp
```

### 通用选项

| 选项 | 说明 |
|---|---|
| `--to <目标>` | `bundle` \| `docx` \| `pdf` \| `html` \| `xml`；省略时按输入类型取默认目标 |
| `--out <目录>` | 输出目录，必须已存在；省略时取环境变量 `MARKFLOW_OUTPUT_DIR`，再回退到当前目录 |
| `--json` | 标准输出只有一行 JSON 结果；**不输出进度**，告警随结果进 JSON，参数错误与运行异常走标准错误 |
| `--concurrency <n>` | `convert` 的并发数，默认 2；取值非法时在标准错误给出告警并按默认值继续，不中断转换 |
| `--max-chars <n>` | `extract` 返回 Markdown 的字符上限，默认 50000，超出即截断并提示 |
| `--no-<开关>` | 关闭任一布尔开关，如 `--no-mineru-formula`；同一开关以最后一次出现为准 |
| `-h, --help` | 显示帮助 |
| `-v, --version` | 显示版本号 |

人类模式（不加 `--json`）下标准输出只有产物路径，进度、告警与汇总走标准错误：每项完成后逐条打印该项告警（`  告警：…`），汇总行在有告警时追加告警条数。参数解析的报错一律为中文。

退出码：0 为全部成功，1 为参数错误或运行异常，2 为存在失败项（`extract` 为提取失败）。

### convert 的转换选项

取值范围与默认值的唯一定义处为 `converters/options.js`，下表与 `markflow --help` 同源。布尔开关写旗标即开启，写 `--no-<旗标>` 即关闭（如 `--no-mineru-formula`）。

选项按本批目标校验：某段只服务于本批之外的目标时，越界取值跳过写入并保留该段默认值，不让整批失败。例如 `--to docx --font-size 9` 中 9 超出 html 段的 10–32 但落在 docx 段的 8–36 内，于是只写入 docx 段（html 段保留 16）；`--to html --font-size 34` 则照常报错。

| 选项 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `--theme <主题>` | `apple` \| `apple-dark` \| `github` \| `academic` \| `reader` \| `print` | html `apple`、pdf `print` | 同时作用于 `html` 与 `pdf` 目标，两者缺省值不同 |
| `--xml-profile <profile>` | `generic` \| `patent` | `generic` | XML 方言：`generic` 通用文档结构，`patent` 国知局专利五书 |
| `--patent-parts <部分列表>` | `claims` \| `description` \| `drawings` \| `abstract` \| `abstract-figure`，逗号分隔 | `auto` | `patent` profile 下输出的五书子集；`auto` 按识别结果输出 |
| `--pdf-backend <后端>` | `auto` \| `mineru` \| `local` | `auto` | PDF 解析后端：`auto` 有令牌走云端否则本地，`mineru` 强制云端，`local` 强制本地 |
| `--image-format <格式>` | `jpg` \| `keep` | `jpg` | 图片归一格式：`jpg` 把位图统一转为 JPEG，`keep` 保持原格式 |
| `--jpeg-quality <n>` | 整数 60–100 | `90` | JPEG 压缩质量 |
| `--jpeg-ppi <n>` | 整数 72–600 | `330` | JPEG 分辨率（PPI） |
| `--math <方式>` | `image` \| `text` | `image` | docx 公式：`image` 栅格为图片，`text` 降级为线性化文本 |
| `--mineru-model <模型>` | `pipeline` \| `vlm` | `pipeline` | MinerU 解析模型 |
| `--mineru-ocr` | 布尔开关 | `false` | 强制 OCR |
| `--mineru-formula` | 布尔开关 | `true` | 识别公式；关闭写 `--no-mineru-formula` |
| `--mineru-table` | 布尔开关 | `true` | 识别表格；关闭写 `--no-mineru-table` |
| `--mineru-lang <语言>` | 1–32 位字母、数字、`_`、`-` | `ch` | 文档语言代码 |
| `--mineru-timeout <秒>` | 整数 30–3600 | `600` | MinerU 云端解析超时 |
| `--page-ranges <范围>` | 形如 `1-5,8` | 无 | MinerU 解析的页码范围 |
| `--font <字体栈>` | CSS `font-family` 值 | 无 | 正文字体栈；省略时取主题默认栈 |
| `--font-size <n>` | html 10–32，docx 8–36 | html `16`、docx `11` | 正文字号：`html` 与 `pdf` 目标按 px，`docx` 目标按 pt |
| `--docx-font-size <n>` | 8–36 | `11` | `docx` 正文字号（pt）；与 `--font-size` 同给时以本项为准 |
| `--font-ascii <字体>` | 字体名 | `Calibri` | `docx` 西文字体 |
| `--font-east-asia <字体>` | 字体名 | `微软雅黑` | `docx` 中文字体 |
| `--line-height <n>` | 1–3 | `1.7` | 行高倍数 |
| `--content-width <n>` | 整数 480–1600 | `760` | HTML 正文栏宽（px） |
| `--spacing <档位>` | `compact` \| `normal` \| `loose` | `normal` | 段落间距档位 |
| `--inline-images` | 布尔开关 | `false` | HTML 图片以 data URI 内联，不再引用 `images/` |
| `--page-size <纸张>` | `A4` \| `Letter` | `A4` | `pdf` 与 `docx` 目标的纸张 |
| `--landscape` | 布尔开关 | `false` | `pdf` 横向 |
| `--xml-indent <n>` | 整数 0–8 | `2` | XML 缩进空格数 |
| `--numbering-start <n>` | 整数 1–9999 | `1` | 说明书段号起始值 |
| `--numbering-width <n>` | 整数 1–6 | `4` | 说明书段号补零位数 |
| `--patent-image-dpi <n>` | 整数 72–600 | `300` | `patent` profile 的图片密度（DPI） |
| `--section-detection <方式>` | `auto` \| `headings` | `auto` | `patent` 分节识别：`auto` 标题或加粗短段，`headings` 仅标题 |
| `--rasterize-tables` | 布尔开关 | `true` | `patent` 表格栅格为图片；关闭写 `--no-rasterize-tables` |
| `--rasterize-formulas` | 布尔开关 | `true` | `patent` 公式栅格为图片；关闭写 `--no-rasterize-formulas` |
| `--xml-import-paragraph-numbers` | 布尔开关 | `false` | 仅专利五书 XML 输入：把说明书与摘要的段号写回段首（`[0001]`），转回 XML 时原样复用；缺省不写，转回时按顺序重编 |
| `--raster-scale <倍数>` | 1–4 | `2` | 栅格化缩放倍数（`patent` profile 下忽略） |
| `--raster-max-width <n>` | 整数 200–10000 | `1600` | 图片最大宽度（px，`patent` profile 下忽略） |
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

# 五书 XML 案卷反向导入为可再编辑的 Word
markflow convert 专利案卷.zip --out ~/Desktop
```

### extract：网页正文只读提取

```bash
markflow extract https://example.com/a                      # Markdown 正文写标准输出
markflow extract https://example.com/a --json               # 一行 JSON：正文与元数据
markflow extract https://example.com/a --max-chars 200000   # 调大正文上限
```

抓取一个 `http`/`https` 网页，只返回提取后的 Markdown 正文与元数据：不落盘、不下载图片（图片只列原始地址）。人类模式下正文走标准输出，标题、提取方式、字数与图片数走标准错误；`--json` 时标准输出为一行 JSON，字段与 MCP 的 `extract_article` 完全一致：`url`、`finalUrl`、`title`、`wordCount`、`extraction`、`markdown`、`truncated`、`images`，以及取得到时才出现的 `author`、`publishedAt`、`siteName`、`excerpt`、`lang`。正文超过 `--max-chars`（默认 5 万字符）即截断并把 `truncated` 置为 `true`，`wordCount` 仍按全文统计。抓取失败以退出码 2 结束，说明写标准错误。

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
        "contentList": "/Users/you/Documents/知识库/季度报告/季度报告_content_list.json",
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

字段说明：`options` 为本次生效的完整选项（`mineru.token` 一律置 `null`）；`extras` 为已落盘附属文件在产物目录内的相对路径（MinerU 产物即在此列）；`backends` 记录实际生效的 PDF 解析后端与栅格化后端；`--validate` 时信封另有 `validate: true`。告警不单列字段，逐项写在各结果的 `warnings` 中；`--json` 模式不输出进度。

`outputs` 的键由产物文件名派生（规则的唯一定义处为 `converters/output.js`）：主产物 `{名称}.<扩展名>` 取扩展名（`md`、`json`、`html`、`xml`、`docx`、`pdf`、`zip`）；以 `{名称}_` 开头的旁路文件取其后主干的 camelCase，非 `.json` 的再接扩展名；patent profile 的五书按表格代码显式映射为固定键（`100001/100001.xml` → `claims`、`100002/100002.xml` → `description`、`100003/100003.xml` → `drawings`、`100004/100004.xml` → `abstract`、`100005/100005.xml` → `abstractFigure`，另有 `zip` 与 `precheck`），键名是对外契约，不随文件名变化；其余文件取去扩展名的文件名转 camelCase（`precheck.json` → `precheck`）；写入了 `images/` 则另有 `imagesDir`。因此 `bundle` 目标恒有 `md`、`json`、`contentList`，有图片时有 `imagesDir`；PDF 走 MinerU 时另有 `contentListV2`、`model`、`layout`、`originPdf`。

## MCP 服务

以标准输入输出提供三个工具，供 Claude Code、Codex 等 agent 直接调用。工具描述、枚举与取值范围由 `converters/options.js` 的描述树生成，与 `markflow --help` 同源；入参校验的拒绝文案为中文。

| 工具 | 用途 | annotations |
|---|---|---|
| `convert_document` | 转换本地文件或网页，返回结构与命令行 `--json` 一致 | `destructiveHint`、`openWorldHint` |
| `extract_article` | 抓取网页只返回正文 Markdown 与元数据，不落盘、不下载图片 | `readOnlyHint` |
| `list_formats` | 返回输入与目标的对应矩阵、受理扩展名、可选主题与 XML profile，以及本机 PDF 后端、栅格化后端、DTD 校验器、LibreOffice 与 MinerU 令牌状态 | `readOnlyHint` |

`initialize` 回包的 `instructions` 写明三件事：`outputDir` 必须已存在（服务端不创建目录）、PDF 缺省可能走按量计费的 MinerU 云端（传 `pdfBackend:"local"` 可留在本机）、只读网页用 `extract_article`。

`convert_document` 入参：

| 入参 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `paths` | `string[]` | 与 `urls` 至少一项 | 本地文件路径列表；建议绝对路径。专利五书可给单个 `.xml`、案卷 `.zip` 或整个五书目录 |
| `urls` | `string[]` | 与 `paths` 至少一项 | 网页 URL 列表 |
| `outputDir` | `string` | 是 | 已存在的输出目录；服务端不创建目录 |
| `target` | `bundle` \| `docx` \| `pdf` \| `html` \| `xml` | 否 | 省略时按输入类型取默认目标 |
| `returnContent` | `boolean` | 否 | 为真时在 `bundle` 目标的结果项 `content` 中附带 Markdown 正文，上限 20 万字符，超出截断并置 `contentTruncated`；其它目标不返回正文，只在该项 `warnings` 中说明 |
| `theme` | 六款主题之一 | 否 | `html` 与 `pdf` 目标的主题（html 默认 `apple`，pdf 默认 `print`） |
| `xmlProfile` | `generic` \| `patent` | 否 | XML 方言 |
| `patentParts` | 五书名数组 | 否 | `patent` profile 下输出的五书子集 |
| `pdfBackend` | `auto` \| `mineru` \| `local` | 否 | PDF 解析后端 |
| `imageFormat` | `jpg` \| `keep` | 否 | 图片归一格式 |
| `jpegQuality` | `integer` | 否 | JPEG 压缩质量，60–100，默认 90 |
| `jpegPpi` | `integer` | 否 | JPEG 分辨率，72–600 PPI，默认 330 |
| `math` | `image` \| `text` | 否 | docx 公式处理方式 |
| `validate` | `boolean` | 否 | `xml` 目标的校验开关 |
| `mineru` | `{ model, ocr, formula, table, language, pageRanges, timeoutSec }` | 否 | MinerU 解析参数；令牌只取自本机环境变量、`~/.markflow/config.json` 或 `~/.mineru/config.yaml`，不接受经此传入 |
| `html` | `{ fontFamily, fontSize, lineHeight, contentWidth, spacing, inlineImages }` | 否 | HTML 目标参数：字体栈、字号（px）、行高、栏宽（px）、段距档位与图片内联；`pdf` 目标同样以本段排版，只有主题另取 `pdf.theme` |
| `pdf` | `{ pageSize, landscape }` | 否 | PDF 目标参数：纸张与横向 |
| `docx` | `{ pageSize, fontSize, fontAscii, fontEastAsia }` | 否 | DOCX 目标参数：纸张、正文字号（pt）与中西文字体 |
| `xml` | `{ indent, numberingStart, numberingWidth, imageDpi, sectionDetection, rasterizeTables, rasterizeFormulas }` | 否 | XML 目标参数：缩进与说明书段号；后四项仅 `patent` profile 生效 |
| `xmlImport` | `{ paragraphNumbers }` | 否 | 专利五书 XML 反向导入参数：是否把段号写回段首，默认否 |
| `raster` | `{ scale, maxWidth }` | 否 | 栅格化参数（`patent` profile 下忽略） |

返回结构与命令行 `--json` 相同，另有三处只出现在 MCP 的字段：`validate` 为真时信封带 `validate: true`；传入本工具不认得的键时信封带 `ignoredArguments`（形如 `["font", "html.colour"]`，段内未知字段记为 `段.字段`），这些键被忽略而非静默丢弃，转换照常进行；`returnContent` 为真时结果项带 `content` 与 `contentTruncated`。调用时在 `_meta` 中带上 `progressToken` 即可收到 `notifications/progress`，进度单调递增，`message` 为中文阶段名。

与命令行的两点差异：其一，命令行在转换前预检每个输入文件是否存在，任一缺失即以退出码 1 结束且不启动转换；MCP 不预检，缺失项记入 `errors`，`isError` 仍为 `false`，同批其余项照常转换。其二，命令行的相对路径按当前工作目录解析，MCP 的 `paths`、`urls` 与 `outputDir` 按 MCP 服务进程的工作目录解析，故建议一律传绝对路径。

`extract_article` 入参为 `url`（必填）与 `maxChars`（可选，默认 5 万字符，超出截断并以 `truncated` 标记）；返回 `url`、`finalUrl`、`title`、`wordCount`、`extraction`、`markdown`、`truncated`、`images`，以及取得时才出现的 `author`、`publishedAt`、`siteName`、`excerpt`、`lang`。与命令行的 `markflow extract` 共用同一实现，字段与截断语义完全一致。`list_formats` 无入参。

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

产物为 `{名称}/` 目录，含 `{名称}.md`、`{名称}.json`、`{名称}_content_list.json` 与 `images/`（结果 `outputs` 中对应 `md`、`json`、`contentList`、`imagesDir`）。Markdown 带 YAML front matter，字段顺序固定，缺失字段整条省略：标题、作者、发布时间、原文链接、最终地址、来源类型、PDF 解析后端、MinerU 模型、站点名、摘要、语言、字数、提取方式、抓取与转换时间。Obsidian、basic-memory 等工具可直接索引并回溯出处。

JSON 产物结构为 `{ schemaVersion, kind, ir, data, meta }`，其中 `ir` 为 mdast 语法树，`kind` 取 `document`、`workbook` 或 `presentation`。

网页正文提取为三级策略：微信、知乎、CSDN、简书、掘金、思否、少数派、博客园的专属选择器优先命中；未命中走 Mozilla Readability 评分；再不行回退通用容器识别。实际命中的方式记录在 `meta.extraction`。噪声清洗在图片下载之前完成，被剔除区域内的图片不会产生网络请求。

### html：六款主题

主题名单与各自定位：`apple`（默认，浅色苹果风）、`apple-dark`（深色苹果风）、`github`（仿 GitHub Markdown）、`academic`（衬线论文风，中文优先宋体）、`reader`（长文阅读，大字距）、`print`（打印样式，逐字沿用 v2）。

主题 CSS 不引用任何远程资源，页面在 `default-src 'none'` 的 CSP 下也不发起网络请求。`--font`、`--font-size`、`--line-height` 与 MCP 的 `html.contentWidth`、`html.spacing` 以 CSS 自定义属性注入，主题样式本身不变。图片默认以 `images/` 相对路径引用，`html.inlineImages` 为真时改为 data URI 内联。

### xml：generic profile

命名空间 `urn:markflow:document:1`，把 mdast 逐节点映射为 XML：块级含 `heading`、`p`、`list`、`item`、`table`、`row`、`cell`、`code`、`quote`、`figure`、`hr`、`section-break`（幻灯片分页与工作表分节保真不降级），行内含 `b`、`i`、`s`、`code`、`a`、`br`、`image`、`math`。`--validate` 对 `generic` 只做 well-formed 检查。

### xml：patent profile（国知局专利五书）

自 2026-01-01 起，中国专利电子申请一律以 XML 格式提交。本 profile 直接对齐官方「WORD 转 ACXML 编辑器」的输出结构，把 docx 底稿转为可提交的五书 XML。

产物落在 `{名称}/` 目录下，目录结构、文件命名与官方「WORD 转 ACXML 编辑器」的真实产出一致：每书一个以表格代码命名的目录，图片与所属 XML 同目录。

```
{名称}/
  100001/
    100001.xml          权利要求书  <cn-claims>
    100001_1.jpg        权利要求内的图片（化学结构式、公式图），有则生成
  100002/
    100002.xml          说明书      <description>
    100002_1.jpg        说明书内的公式、表格、化学式与段内图片，按出现顺序统一编号
  100003/
    100003.xml          说明书附图  <cn-drawings>
    100003_1.jpg        附图，按出现顺序编号
  100004/
    100004.xml          说明书摘要  <cn-abstract>
  100005/
    100005.xml          摘要附图    仅识别到时生成
    100005_1.jpg
  {名称}.zip            上述各目录的同一集合：条目名即相对路径（100001/100001.xml …），无外层文件夹、无目录条目
  precheck.json         预检问题清单与校验记录，不入 zip
```

命名约定：图片名为 `<表格代码>_<序号>.<扩展名>`，序号自 1 起、不补零，各书独立计数，同一书内的全部图片共用一个计数器（官方样稿的说明书内只有公式图，几类图片混排时是否分别计数尚无样本，此为推定）；`img/@file` 只写裸文件名；尚未栅格化的非 JPG 图片（如 EMF）保留原扩展名并告警。官方产出没有 `List.xml`，本工具同样不生成。`--clean` 重跑时一并清理书目目录内上一轮的文件与旧版的平铺产物（`claims.xml`、`drawing-N.jpg` 等），目录内的其它文件保留。

字节级形态同样对齐官方：UTF-8 BOM、换行统一为 CRLF、空元素写作 `<img … />`；官方产出中不规则的空行与缩进不模仿。generic profile 不受影响，仍为无 BOM、LF、`<hr/>`。

结构约定：每份文件头三行固定为 XML 声明、`<!DOCTYPE cn-application-body SYSTEM "/dtdandxsl/cn-application-body-20080416.dtd"[]>` 与 `showxml.xsl` 样式处理指令，根元素为 `<cn-application-body lang="zh" country="CN">`。说明书段号四位补零连续编排（段首已有 `[0001]` 者剥离并复用，与预期不一致时记「段号跳变」告警）；权项 id 形如 `cl001`，`根据权利要求 N 所述` 自动解析为 `<claim-ref>`；附图 id 形如 `f0001`、图片 id 形如 `i0001`，`wi`/`he` 由像素与 JPEG 密度换算为毫米。表格与公式在本 profile 下一律栅格为 JPG，栅格化后端不可用时降级为逐行文本或线性化文本并告警。权利要求内的图片输出为 `claim-text` 内的 `img`；标注为化学式的图片输出为 `<chemistry id="chem0001" num="0001">` 内的 `img`，不写 `chem` 元素（官方转换器从不输出它）。

转档前预检覆盖：GB18030 之外的字符、图片格式与密度（官方只受理 JPG/TIF、72–300 DPI）、浮动对象与文本框、OLE 对象、Word 自动编号、修订痕迹、文档保护、批注、非常规中文字体、公式后标点、缺节。问题项分 `blocking`（官方工具会拒绝转换）与 `warning` 两级，全部写入 `precheck.json` 并进入结果的 `warnings`。因此，patent profile 提交前应使用 `--jpeg-ppi 72–300`；通用 JPG 默认值仍为 330 PPI。

加 `--validate` 后，随包分发的官方 DTD 会逐份校验五书。交叉核对可用 `xmllint`，在仓库根目录执行：

```bash
xmllint --nonet --noout --dtdvalid converters/renderers/xml/dtd/cn-application-body-20080416.dtd <file.xml>
```

两点须知：`xmllint` 把 `--dtdvalid` 的参数当 URI 处理，含中文的绝对路径会报 `Could not parse DTD`，故须用上面的相对路径；stderr 中的 `failed to load external entity "/dtdandxsl/…"` 属预期（文档内的 SYSTEM 标识符指向官方部署路径，本地不存在），说明书附图（`100003/100003.xml`）的 `Content model of cn-drawings is not deterministic` 是官方 DTD 自身的缺陷，两者都不影响校验结论。

与官方编辑器的差异——本工具跨平台运行、不依赖 Office 或 WPS、不要求套用五书模板、公式按目标 DPI 放大后再栅格、转档前即给出预检清单。本期不覆盖：化学式识别、一键提交到客户端草稿箱。

完整的政策背景、官方编辑器内部结构、DTD 解读与映射决策见 [docs/patent-xml-research.md](docs/patent-xml-research.md)。

### 专利五书 XML 反向导入（XML → Word）

国知局专利五书 XML 可以反向导入为可再编辑的 Word：在 Word 里改完，再按上一节转回五书 XML。受理三种输入，书目一律按内容判定（根元素 `cn-application-body` 下的 `cn-claims`、`description`、`cn-drawings`、`cn-abstract`、`cn-abst-figure`），与文件名无关：

| 输入 | 说明 |
|---|---|
| 单个 `.xml` | 五书中的一书；图片取自该 XML 的同级目录 |
| 案卷 `.zip` | 官方「WORD 转 ACXML 编辑器」与本工具现行产物（`10000N/10000N.xml` + 同目录图片）、v3.0.0 的平铺产物、外面多套一层文件夹的 zip 均可 |
| 五书目录 | 目录下直接含 `10000N/10000N.xml`，或含根元素为 `cn-application-body` 的 `.xml`；整个目录作为一项输入 |

```bash
# 省略 --to 即转 docx；多书合并为一份文档
markflow convert 专利案卷.zip --out ~/Desktop
markflow convert ./专利案卷目录 --out ~/Desktop

# 改完后转回五书 XML
markflow convert ~/Desktop/专利案卷.docx --to xml --xml-profile patent --validate --out ~/Desktop
```

产物形态：多书合并为一份 docx，每书一个 Word 分节（下一页起），书目名写在该节页眉里，顺序为 说明书摘要 → 摘要附图 → 权利要求书 → 说明书 → 说明书附图——与官方五书模板同一做法，转回 XML 时按页眉直接归书，不经位置推定，书目名也不会混进正文。只导入一书时文档只有一节，单节文档的页眉不足以认回书目，故正文首段另留一个书目标题段。权项首段冠以「N. 」，发明名称与小标题为 Word 标题样式，附图为「图片段 + 图号段」。段号缺省不写进正文（官方模板里段号由转换器生成，留在 Word 里反而妨碍增删段落），转回时按顺序重编；需要对照审查意见里的段号时加 `--xml-import-paragraph-numbers`，段首会写入 `[0001]`，转回时原样剥离并复用。`--to html`、`--to pdf` 与 `--to xml` 同样可用；`bundle` 目标不接受本类输入。

图片按其自身的像素与 JFIF 密度定显示尺寸（1 像素 @300 DPI 恰为 3048 EMU），再在半个像素之内向 `img/@wi`、`@he` 对齐，不直接采用向下取整过的 `wi`/`he`；因此转回 XML 时像素尺寸、JFIF 密度与 `wi`/`he` 同时复原，未经重采样的图片逐字节不变。公式、表格与化学式在五书 XML 里本就是图片，导入后仍是图片（Word 中不能编辑其内容），其替换文字写作 `markflow:role=formula`（或 `table`、`chemistry`，原 alt 非空时以分号接在其后），转回时据此还原为 `maths`／`tables`／`chemistry`，请勿删改。

往返保真度：对本工具自己产出的五书，`XML → docx → XML` 逐字节相同（五份 XML 与全部图片）；对官方编辑器产出的五书，权项、发明名称、小标题、段落与段号、附图的 id／num／figure-labels、`img` 的全部属性、图片字节与案卷目录结构逐项复原。以下信息回转时无法恢复，导入时逐项计数并以「导入：」开头写入 warnings（清单的唯一定义处为 `converters/parsers/xml/report.js`）：

| 已知必丢项 | 回转后的结果 |
|---|---|
| `claim-ref`、`figref`、`crossref` 引用元素 | 按纯文本导入；官方转换器不生成这些元素，回转时不恢复 |
| `pb` 分页标记 | 丢弃 |
| 说明书与摘要内的临时段（`num="XXXX"`） | 按普通段落导入，回转时编入顺序段号 |
| 非自 1 连续的段号 | 回转时按顺序重编（开启 `--xml-import-paragraph-numbers` 可保留向前跳变的段号） |
| `heading` 的 `level` 不是 2 | 回转后一律 `level="2"` |
| `invention-title` 内的行内标记与图片 | 回转后只保留纯文本 |
| `claim-text` 的嵌套 | 拍平为并列的 `claim-text` |
| `claim` 的 `claim-type` | 丢弃 |
| 权项内以「数字＋. 、」开头的后续 `claim-text` | 回转时会被识别为新的权项，须在 Word 中核对 |
| `maths`／`tables`／`chemistry` 的代码化内容（`math`、`table`、`chem`、`cn-mathf`、`cn-tablef`） | 只保留其图片；没有图片时退为文字 |
| `smallcaps`、`overscore` 与 `u` 的 `style` | 只保留文字与普通下划线 |
| `img` 的 `top`／`left`／`img-content` 非缺省取值，`orientation` 与 `inline` | 回转时按官方转换器的固定取值重写 |
| 摘要附图的 `figure-labels`、附图区内非图号的说明文字 | 不写回 XML |
| 其它未映射的元素（`dl`／`ul`／`ol`、`patcit`、`nplcit`、`pre`、`bio-deposit`、`doc-page`、`cn-unregulated-part` 等） | 只保留其文字 |

另有一处由转回链路决定的差异：段首或段尾、显示宽度不小于约 53 mm（96 DPI 下 200 px）的段内图片，转回时会被 docx 解析层的「大图拆段」规则拆成独立段落，该段之后的段号随之顺延。

安全边界（输入属不可信内容）：XML 扫描器不解析实体声明、不读取外部实体，元素嵌套上限 64 层；单份 XML 不超过 32 MB、单张图片 64 MB、zip 本体 512 MB、条目 2000 个、全部已读内容 1 GB，zip 条目边解压边计数（中央目录申报的大小不作为依据）；含 `..` 片段、绝对路径或盘符的 zip 条目名一经发现即整包拒绝，符号链接条目忽略；`img/@file` 只接受同目录下的裸文件名与 jpg／tif／png／gif／bmp 扩展名，类型按魔数判定，目录形态下解开符号链接后仍须落在该 XML 所在目录之内；缺图、越界引用与超限只让该图降级为文字占位（`［缺图：…］`），不中断导入。非专利 XML（含 `generic` profile）与不含五书的 zip 给出中文错误。

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

docx 中的 OMML 公式默认栅格为图片（`--math image`）：先转 MathML，再由 Chromium 内的 MathJax 渲染后截图。出图字号取源稿该公式的 `w:sz`（公式内没有时取所在段落的段落属性，两处都取不到时按 14pt），并乘一个标定系数以抵消 MathJax 字形与 Word 数学字体的大小差异。`patent` profile 下公式图另按墨迹紧裁——取墨迹外接矩形后四周各补 4 px 白边，使幅面贴近官方工具的公式出图（官方按 Word 的公式版面盒出图，字形不同，故不追求逐像素相等）；表格图与其它 profile 不做紧裁。`--math text` 降级为线性化文本。旧版 Equation 3.0 公式（OLE + WMF）按图片处理并告警。

PDF 出图与栅格化各有一条回退链，两者都以桌面端主进程内的 Electron 渲染为首选，其次为派生的独立 Electron 工作进程；PDF 出图另有第三级 LibreOffice，栅格化没有。两条链当前生效的后端由 `markflow formats` 分别报出。

## 同批同名产物的命名

同一次 `convert` 内，不同输入可能派生出相同的产物名（同基名不同扩展名、不同目录下的同名文件、标题相同的网页）。登记表按批内序号裁决：首个保留原名；本地文件且扩展名与占用者不同时取 `名称 (扩展名)`，如 `sample (pptx)`；其余情形取 `名称 (2)` 并递增。落盘形态不同的产物分槽登记，`sample.md → sample.docx` 与 `sample.docx → sample/` 同批互不改名。

登记表的生命周期即一批任务：跨批次仍为同名产物直接覆盖，故重复转换同一输入依然幂等。

## 安全说明

- **网页抓取**内置 SSRF 防护：只放行 `http` 与 `https`；主机名解析出的全部地址若命中环回、私网、链路本地、组播或保留段一律拒绝；连接钉扎在刚校验通过的地址上以消除 DNS 重绑定；重定向逐跳复验，最多 5 跳；页面上限 20 MB，图片上限 10 MB。桌面端不提供私网开关。
- **Markdown 中的图片**只允许引用文档所在目录之内的本地文件，绝对路径、`../` 越界与指向外部的符号链接一律拒绝并记录告警。
- **原始 HTML** 在 Word 与 PDF 输出中只保留去标签后的文本，例外只有两处且各有白名单校验：上游清洗过的 `<table>` 与 MathML 片段。HTML 与 PDF 页面均声明 CSP，`img-src` 随图片寻址模式收紧，无本地资产的图片一律丢弃 `src` 只留 `alt`——打印与预览都在本机运行，保留远程地址等于把已被守卫拦下的请求重新放行。
- **桌面端**渲染进程不开放 `file://`：界面自身经 `mf-app://` 加载，本地图片与 PDF 一律经主进程授权的 `mf-asset://<会话>/` 协议供给，处理器逐项做目录边界、符号链接与扩展名白名单校验。渲染进程 CSP 为 `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' mf-asset: data:; frame-src mf-asset: about:; connect-src 'none'; object-src 'none'`；产物与来源视图一律置于不带 `allow-scripts` 的 `<iframe sandbox srcdoc>` 内；外链仅 `http`/`https` 交系统浏览器，页面内导航全部拒绝。
- **Word 加载项的回环服务**默认关闭，启用后只绑 `127.0.0.1:49731`，同源提供任务窗格页面与接口。防的是浏览器里的网页与误用：`Host` 只认 `localhost:49731` 与 `127.0.0.1:49731`（防 DNS 重绑定）；`Origin` 出现时必须等于本源；写操作必须带自定义请求头，且服务不发任何 CORS 头，跨源预检因此必然失败；除探活外的接口校验每次启动随机生成的 32 字节令牌（恒定时间比较），令牌只存内存、只随同源页面下发，不进脚本文件、URL 与日志。静态资源按白名单精确匹配，请求体上限 200 MB，同一时刻只跑一个转换，排队数、任务记录数与存活时间均有上限；上传的 docx 只写入应用临时目录（目录 0700、文件 0600），任务结束即删除。以当前用户身份运行的本机恶意进程不在防护范围内——它本就能直接读写该用户的文件。
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
  parsers/                 docx / xlsx / pptx / pdf / md / url / xml（专利五书 XML、案卷 zip 与五书目录）解析为中间表示
  xml/dom.js               无依赖 XML 扫描器（反向导入与桌面端 XML 视图共用）
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
    addin/                 Word 加载项：回环服务、请求守卫、任务编排、输出位置裁决、清单安装器
  preload.js               受控的 window.markflow.* 暴露面
  renderer/                零构建渲染层（原生 ES 模块 + Web Components）
office-addin/
  manifest.xml             Word 任务窗格加载项的清单模板（由设置页写入 Word 的旁加载目录）
  taskpane/                任务窗格页面、脚本与样式（零构建，由回环服务同源提供）
docs/patent-xml-research.md  专利 XML 研究报告
test/                      测试与固定样本
```

## 开发与测试

```bash
npm test        # node:test，1069 项（2026-09-16 实测）
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
- `bundle` 只接受 Office、PDF 与网页输入；`docx` 与 `pdf` 只接受 Markdown 与专利五书 XML 输入。
- `patent` profile 不识别化学式，不生成案卷包，不支持一键提交。
- 专利五书 XML 反向导入只受理 `patent` 方言（根元素 `cn-application-body`），不受理 `generic` profile 的 XML；公式、表格与化学式导入后仍是图片；桌面端的转档入口尚未接入 `.xml` 与 `.zip`（命令行与 MCP 可用）；其余必丢项见「专利五书 XML 反向导入」。
- `--validate` 需要可选依赖 libxml2-wasm；未安装时跳过校验并在 warnings 中说明。
- Readability 的可读性阈值已按中文段落长度下调（中文段落多在 50 至 150 字，默认阈值会把多数中文文章判为不可读）；判定失误时由字符数下限双重兜底，回退通用提取。

## 许可证

MIT，见 [LICENSE](LICENSE)。
