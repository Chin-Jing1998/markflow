# 中国专利电子申请 XML 研究报告

> 面向 MarkFlow v3 的 `xml` 目标 `patent` profile。本报告的一手依据是国家知识产权局
> 「WORD 转 ACXML 编辑器」V4.3_2_20251218 安装包的解包件、官方用户手册，以及官方
> 《专利电子申请数据规范（20240120全量）》；二手依据是官方通知与 WIPO ST.36 标准文本。
> 凡属推定而未经官方产物或官方规范验证的结论，均在正文与第 5 章决策表中显式标注
> 「待 R2 核对」。
>
> 编写日期：2026-09-13。对应方案：MarkFlow v3 实施方案 §2.1.1、§2.4、§3.4.2、§3.6（R1/R3）。
>
> **修订记录**：2026-09-13 补 R-6 核对。官方数据规范经核实不含更新版 DTD（3.12 节），
> 其附带的《案卷包目录结构规范》则关闭了原 R-1（`img/@file` 引用方式）与 R-5（压缩包
> 内部布局）两个开放问题（4.4 节），并新增 R-13、R-14 两项实现任务。

---

## 1 背景与政策

### 1.1 强制 XML 递交的时间线

| 时间 | 政策 |
|---|---|
| 2025-05-26 | 申请日在 2025-10-01 及之后、且请求优先审查／快速审查／PPH／延迟审查／集中审查的申请，须以 XML 格式提交。 |
| 2025-11-12 | 自 2026-01-01 起，电子申请**一律**以 XML 格式提交，不再受理非 XML 电子文件。核苷酸与氨基酸序列表适用 WIPO ST.26，不在此列。 |

由此，「把 Word 专利文稿转成合规 XML」从可选能力变成刚性需求，且窗口期已过。

### 1.2 官方工具的形态与其局限

官方在专利业务办理系统「工具下载」栏目提供「WORD 转 ACXML 编辑器」，当前版本
V4.3_2_20251218。它是一个 **VSTO Word 加载项**，运行前提为：

- 操作系统：Windows 10 及以上；
- 办公软件：MS Office 2013 及以上，或 WPS 专业版 2015 及以上；
- 运行时：.NET Framework 4.6.1、VSTO 4.0 Runtime、VC++ 2015–2022 x86（加载项自身为 32 位）；
- 预览功能：另需安装「预览插件」（`XMLPreviewer.exe`）；
- 一键提交：另需运行「专利业务办理系统客户端」。

对本项目而言，这套前提有三层意义。其一，macOS 用户完全无法使用官方工具；其二，
即便在 Windows 上，必须装 Office/WPS 才能转档，对无 Office 的流水线不可用；其三，
官方工具要求用户先套用五书模板、按规范插入显式标记，人工成本高。MarkFlow 直接
解析 OOXML，三层限制都可以绕开，这正是本 profile 的差异化所在。

### 1.3 相关标准

- **WIPO ST.36**：专利文献 XML 处理标准，`application-body` 一支给出 description／claims／
  abstract／drawings 的基本结构以及 `p[@id][@num]`、`claim[@num]/claim-text`、`figref`、
  `img`、`maths`、`tables` 等元素。
- **ICE（2005-02-20）**：WIPO 电子申请交换格式。
- **ZC 0012.2—2006**：行业标准《用 XML 处理中国发明专利／实用新型专利文献数据》。
- 国知局在前两者之上做了本地化扩展，产出 `cn-application-body-20080416.dtd`——即本报告
  第 3 章的对象。DTD 文件头注释明载「This DTD is based on WIPO ST36(2005-09-22) and
  ICE(2005-02-20)」。

---

## 2 官方编辑器内部结构与工作流

本章结论均来自 `word转xml编辑器.msi` → `disk1.cab` 解包所得的 221 个文件。取证方法：
`file` 按内容判型；`.NET` 程序集的字符串常量经自写的 `#US`（用户字符串堆）解析器逐条
切分读出——macOS 的 `strings` 不支持 `-e l`，按字节扫描又会把长度前缀和相邻常量粘连，
因此必须解析 PE → CLI header → 元数据根 → `#US` 流，按压缩长度前缀切分。

### 2.1 程序集构成

| 程序集 | 职责 |
|---|---|
| `PatentTool.dll` | VSTO 加载项主体（注册表项 `Software\Microsoft\Office\Word\Addins\CNIPR.PatentToolWord`），负责 Word 交互、标记插入、业务校验 |
| `WordToolKit.dll` | 转换内核：OOXML → 中间 XML → 五书 XML；OMML → MathML；图片抽取与属性换算；DTD 校验；压缩包 |
| `DocumentFormat.OpenXml.dll` | 读写 OOXML |
| `OpenMcdf.dll` | 读 OLE 复合文档（MathType／Equation 3.0 对象） |
| `MathTypeGetMML.exe` + `MTSDKDN.dll`／`MTEFSharp.dll` | MathType OLE → MathML |
| `ChemEditor.exe` + `NCDK*.dll` + `osra.exe` | 化学式编辑与图像识别 |
| `fmlEditor.exe` + `AxInterop.FMLAXCLib.dll` | Formulator 公式编辑器 |
| `Tesseract.dll` + `chi_sim.traineddata` | 生僻字／截图 OCR |
| `pdftoppm.exe`、`GraphicsMagick`／`FreeImage` 系、`ChangeDPI.exe` | 图片格式与 DPI 归一、EMF/WMF 栅格化 |
| `SnapLib.dll` | 自由／矩形截图 |
| `XMLPreviewer.exe` | 预览（独立安装） |
| `checkNew.dll`／`Updater.exe` | 在线更新 |

`config.xml` 全文仅两项：

```xml
<config>
<defaultapp>word</defaultapp>
<generateimagetype>false</generateimagetype>
</config>
```

### 2.2 五书 = 五个独立 XML 文件（逐字骨架）

`WordToolKit.dll` 的 `#US` 堆中存有八条完整的文档骨架常量，逐字如下（`\r\n` 为原文
CRLF，骨架本身为单行）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE cn-application-body SYSTEM "/dtdandxsl/cn-application-body-20080416.dtd">
<?xml-stylesheet type="text/xsl" href="/dtdandxsl/showxml.xsl"?>
<cn-application-body lang="zh" country="CN"><cn-claims></cn-claims></cn-application-body>
```

把末行的第一层子元素依次替换，即得其余七种：

| 文件类型 | 第一层子元素 | 定位 XPath（DLL 中与骨架成对出现） |
|---|---|---|
| 权利要求书 | `<cn-claims>` | `//cn-application-body/cn-claims` |
| 说明书 | `<description>` | `//cn-application-body/description` |
| 说明书附图 | `<cn-drawings>` | `//cn-application-body/cn-drawings` |
| 说明书摘要 | `<cn-abstract>` | `//cn-application-body/cn-abstract` |
| 摘要附图 | `<cn-abstract><cn-abst-figure>` | `//cn-application-body/cn-abstract/cn-abst-figure` |
| 序列表 | `<description><sequence-list-text>` | `//cn-application-body/description/sequence-list-text` |
| 外观设计简要说明 | `<cn-design-application-body …><cn-brief>` | `//cn-design-application-body/cn-brief` |
| 其它文件（意见陈述等） | `<cn-other-file lang="zh" country="CN">` | `//cn-other-file` |

后两种换用各自的 DOCTYPE：`cn-design-application-body-20080416.dtd` 与
`cn-other-file-20080416.dtd`；`xml-stylesheet` 一律仍指向 `showxml.xsl`。另有两条骨架：
`<authorization/>`（无 DOCTYPE，仅 stylesheet）与 `<文档/>`（样式表为
`xsl-book-20160305.xsl`），分别用于委托书与「书式」文档，不在本期范围。

**结论**：五书必须是五个独立文件，不能合并为一份 XML。这与 DTD 允许
`cn-application-body` 同时容纳四个子元素并不矛盾——DTD 允许，但工具与受理系统按单书
组织。

### 2.3 对 `*.head` / `*.end` 文件的更正

解包件中有 40 个 `*.head` 与 26 个 `*.end` 文件，文件名恰好是 XML 元素名或标记功能名
（`ApplicationBody`、`Claims`、`Claim`、`ClaimText`、`Description`、`Drawings`、`Figure`、
`Heading1/2/3`、`InventionTitle`、`Paragraph`、`Tables`、`Bold`、`Italic`、`Subscript`、
`Superscript`、`UnderLine`、`BreakLine`、`Image`、`BiaoTou`、`BiaoLianJie`、`DanWei1-3`、
`ZuoZhe1-3`、`TuZhu` 等），大小 4–6 KB，很容易被误判为「官方拼装 XML 时的片段模板」。

**实测结论：它们全部是 32×32 的 8 位 RGBA PNG 图标，不含任何 XML 文本。** 逐个 `file`
判型的结果无一例外。同时核对了解包件内其余文件（`config.xml` 是 XML、八个 `dotx` 是
Word 2007+ 包、各 DLL 是 PE32 程序集），名实均相符，因此这**不是 CAB 解包的文件名
错位**，而是这批文件本来就是加载项功能区（Ribbon）的图标资源，以其触发的标记／元素
命名。

这条更正有两层价值：其一，不必再去它们里面找片段模板，真正的骨架在 `WordToolKit.dll`
的 `#US` 堆里（见 2.2）；其二，图标命名本身泄露了加载项的完整标记动作集合，可以反推
官方支持的元素范围——`BiaoTou`（表头）、`BiaoLianJie`（表连接）、`DanWei1-3`（单位）、
`ZuoZhe1-3`（作者）、`TuZhu`（图注）、`TuZhuLianJie`（图注连接）等，属于序列表与外观
设计场景的专用标记，不在发明／实用新型五书的常规路径上。

### 2.4 八个五书模板（`dotx` … `dotx_7`）

CAB 解包后模板文件名被抹成 `dotx`、`dotx_1` … `dotx_7`。用 `docProps/app.xml` 的
`<Template>` 字段与 `word/header1.xml` 的页眉文本可以逐一还原：

| 解包名 | `<Template>` | 页眉 | 正文骨架 |
|---|---|---|---|
| `dotx` | 说明书摘要模版1.dotx | 说明书摘要 | 单段「在此处键入说明书摘要内容。」 |
| `dotx_1` | 摘要附图模版1.dotx | 摘要附图 | 空段（仅供插图） |
| `dotx_2` | 权利要求书模版1.dotx | 权利要求书 | `1. `／`2. `／`3. ` 三段 |
| `dotx_3` | 外观设计简要说明模版1.dotx | 外观设计简要说明 | `1. `／`2. ` 两段 |
| `dotx_4` | 说明书模版1.dotx | 说明书 | 标题 + 五个固定小标题 + `[000N]  ` 前缀段 |
| `dotx_5` | 说明书附图模版1.dotx | 说明书附图 | 空段（仅供插图） |
| `dotx_6` | 外观设计图片或照片模版1.dotx | 外观设计图片或照片 | 两个空段 |
| `dotx_7` | 序列表模版1.dotx | 序列表 | 单段「在此处键入序列表内容」 |

说明书模板（`dotx_4`）的正文为：

```
在此处键入说明书标题
技术领域
[0001]  在此处键入技术领域描述段落。
背景技术
[0002]  在此处键入技术领域描述段落。
发明内容
[0003]  在此处键入技术领域描述段落。
附图说明
[0004]  在此处键入技术领域描述段落。
具体实施方式
[0005]  在此处键入技术领域描述段落。
```

三点值得注意。第一，段号前缀是 `[0001]` 后跟**两个半角空格**。第二，模板不依赖任何
自定义样式，样式 ID 只有 Word 默认的 `a`／`1`／`2`／`a0` 等——这意味着分节识别不能
靠样式名，只能靠标题文本。第三，页面设置为 A4（`pgSz w=11906 h=16838`）、左右边距
1800 twip（约 31.75 mm）、上下 1440 twip（25.4 mm）。

### 2.5 官方 Word 标记语法

官方工作流要求在 Word 正文里插入**显式标记字符**，转换时据此切分结构。标记字符取自
随包字体 `Cnipr.ttf`（`#US` 堆中与字体名 `Cnpir` 相邻的私用区码位 `U+E201`、
`U+E204`–`U+E20F`），显示为单个汉字：

| 标记 | 显示字符 | 用法 | 生成的 XML |
|---|---|---|---|
| 名标记 | 名…名 | 发明名称 | `<invention-title>` |
| 题标记 | 题…题 | 五部分标题 | `<heading level="2">` |
| 段标记＋号标记 | 段号[0001]号… | 带段号的段落 | `<p id="p0001" num="0001" Italic="0">` |
| 临标记 | 临… | 不加段号的临时段 | `<p id="l0001" num="XXXX" Italic="0">` |
| 条标记＋号标记 | 条号1.号… | 权利要求项 | `<claim id="cl001" num="1"><claim-text>` |
| 号标记（图号） | 号图1号 | 附图图号 | `figure/@num` |
| 序标记 | 序 | 序列表 | `<sequence-list-text>` |
| 扉标记 | 扉 | 外观设计扉页图 | `figure/img/@img-content` 置为扉页图 |
| 其余 | 补／表／数／化／权／页 | 补正、表格、公式、化学式、权项、分页 | 对应 `tables`／`maths`／`chemistry`／`pb` |

加载项在内部中间 XML 里用一组成对的哨兵元素承载这些标记：`title-begin`／`title-end`、
`heading-begin`／`heading-end`、`num-begin`／`num-end`、`table-begin`／`table-end`、
`math-begin`／`math-end`、`chemistry-begin`／`chemistry-end`、`feng-pi`，以及换行哨兵
`p-br`／`pp-br`／`claim-br`。标记不成对时报「发明名称标签不匹配」「五部分标题标签不
匹配」「段号(权项号)标签不匹配」「图号标签不匹配」。

「一键添加标记」即自动识别并插入这些字符，「一键删除标记」即清除。自动识别用到的
判据在 `PatentTool.dll`／`WordToolKit.dll` 中可见：

- 单书归属（整段文本匹配，允许字间空白）：
  `^(\s)*权(\s)*利(\s)*要(\s)*求(\s)*书(\s)*$`、`^(\s)*说(\s)*明(\s)*书(\s)*$`、
  `^(\s)*说(\s)*明(\s)*书(\s)*摘(\s)*要(\s)*$`、`^(\s)*说(\s)*明(\s)*书(\s)*附(\s)*图(\s)*$`、
  `^(\s)*摘(\s)*要(\s)*附(\s)*图(\s)*$`、`^(\s)*序(\s)*列(\s)*表(\s)*$`、
  `^(\s)*简(\s)*要(\s)*说(\s)*明(\s)*$`。
- 五部分标题文本：`技术领域`、`背景技术`、`发明内容`／`实用新型内容`、`附图说明`、
  `具体实施方式`（另接受 `实施例`／`具体实施例`）。
- 通用小标题（转 `heading`）：`^(?<heading>[^:：]+)(\:|：)$` 以及被
  `()`／`（）`／`〔〕`／`[]`／`［］`／`【】`／`〖〗`／`〈〉`／`《》`／`{}`／`｛｝`
  整体包裹的单行。
- 权项起始：`^[[1-9][0-9]*[0-9]*[\.．、]`。

### 2.6 公式、化学式与图片链路

- **OMML**：`OMML2MML.XSL` 把 Word 的 `m:oMath` 转 MathML2。`WordToolKit.dll` 内自带一套
  XPath 驱动的 OMML→MathML 映射，覆盖 `m:r`／`m:f`／`m:d`／`m:rad`／`m:nary`／`m:func`／
  `m:sSub`／`m:sSup`／`m:sSubSup`／`m:sPre`／`m:bar`／`m:acc`／`m:groupChr`／`m:limLow`／
  `m:limUpp`／`m:m`／`m:eqArr`／`m:box`／`m:borderBox`／`m:phant`，未知结构降级并写入
  `----未知数学公式------`。
- **MathType／Equation 3.0**：经 `OpenMcdf` 读 OLE 流 `Equation Native`，交
  `MathTypeGetMML.exe` 转 MathML。
- **MathML → 图片**：`MathJax.zip`（MathJax 2，配置 `MML_HTMLorMML-full`）在内嵌浏览器
  中渲染后截图为 JPG。公式图片命名前缀 `omath-`，`#US` 堆中留有一个完整实例
  `omath-1-1.jpg`，即 `omath-<段序>-<段内序>.jpg`。
- **附图**：中间表示的图片文件名前缀为 `drawing-`；Word 域对象另有 `field-` 前缀与
  `f` + 六位序号的临时名。
- **化学式**：`ChemEditor.exe` + `NCDK` 编辑、`osra.exe` 识别；CML 代码存入图片属性
  （`<SIPOChemFile` 标记）。
- **图片归一**：`pdftoppm.exe -f 1 -l 1 -r 300 -jpeg` 用于 PDF 对象转 300 DPI JPG；
  `ChangeDPI.exe`／`FreeImage`／`GraphicsMagick` 负责格式与 DPI 归一、EMF/WMF 栅格化。
- **转图保持原尺寸**：手册 3.5.4 与 3.5.5 明载「转换后图片的长度与宽度保持与转换前原始
  对象一致」。

### 2.7 预览、压缩包与提交

- **预览**：`XMLPreviewer.exe` 用 `showxml.xsl` 把 XML 渲染成 HTML，效果与专利业务办理
  系统一致。样式表运行期还会加载 `MathJax/MathJax.js`、`scaleimage.js`（必要时
  `UTIF.js` 处理 TIFF、`lens.js`/`lens.css` 做放大镜）。
- **压缩包**：手册 3.3.3 明载「压缩包位于原始 WORD 文件所在同级目录」。`WordToolKit.dll`
  中与之配套的常量为 `\WordToolKitZIP`、`WordToolKitZIP`、`.zip`，收集图片用的 XPath 为
  `//img/@file | //physical-name`（另有一处 `//img | //文件名称`），并伴随通配符 `*.jpg`。
  紧随其后的一串常量 `<data-bus/>`、`\List.xml`、`QINGQIUXX`、`DIANZISQAJID`、
  `SHENQINGFS`、`YEWULX`、`WENJIANLX`、`TIJIAORDM`、`FAMINGMC`、`SHENQINGH`、
  `WEINEIBH`、`GUOJISQH`、`NEIBUBH`、`WENJIANBYSXX`、`BAOTOUXX`、`WENJIANBBZ`、
  `WENJIANGS`、`BAONEIWJXX`、`WENJIANBZ`、`GESHILX`、`BIAOGEDM`、`XIANGDUILJ`，与
  《国家阶段电子申请案卷包目录结构规范》所载 `List.xml` 的元素名**逐个对应**——即编辑器
  的「制作压缩包」直接产出官方案卷包。其目录结构与文件命名规范见 4.4 节。
- **一键提交**：经本地回环接口 `http://localhost:9999/common/wsImport?zltype=` 投递到
  专利业务办理客户端草稿箱，需先启动客户端。该接口未公开，本项目不移植。
- **在线更新**：`checkNew.dll`／`Updater.exe`，更新服务器 `wordtoxmlupdate.cnipa.gov.cn`。

### 2.8 官方内置的校验与预检

转换与提交前，`PatentTool.dll` 会跑一批业务校验。从其字符串常量可完整还原检查项，这
是 MarkFlow `precheck.js` 最好的需求清单：

**结构类**：权利要求书项号缺失／不连续／重复；`' 项后怀疑项号标签错误`；权项引用关系
错误；说明书缺少所有五大标题／缺少某个五大标题／五大标题内容错误；说明书附图未编号；
说明书附图图号不连续／重复；摘要附图超过 1 张。

**内容类**：说明书含有敏感词；项中连续出现重复字；出现异常符号；英文字母或特殊符号
不能紧挨着重复出现；仅由一种重复的字符组成。

**文档格式类**（阻断性）：
- 「文件中存在浮动对象，请先将浮动对象转为文中对象，再进行 XML 格式转换。」
- 「存在表格嵌套，结束操作。请先处理嵌套的表格。」
- 「存在复杂表格，请将其转为图片后再进行格式转换。」
- 「文件中存在特殊字体，详见 XML 检查窗口中标红，请截图处理或用常规字体（楷体、黑体、
  宋体、仿宋）编写。」
- 「请先处理修订信息」。

**DTD 校验**：转换完成后以 .NET 的 DTD 校验器复核，错误格式为
`DTD校验出错:XML文件第{行}行,第{列}个字符处有错误:` 并附 `内容如下:`。

另有一条免责提示：「本软件仅为专利文档转换工具，不保证最终结果的准确性，请用户在转换
后自行校对转换结果。」

---

## 3 DTD 解读

对象：`converters/renderers/xml/dtd/cn-application-body-20080416.dtd`（69 KB，UTF-8，
自身版本 v1.0 / 2008-04-16）。

### 3.1 引用闭包

该 DTD 的全部外部引用都包在条件节内，由文件第 39–45 行的六个开关参数实体控制，出厂
取值为：

```
<!ENTITY % UNICODE_PLANE1D_ESCAPE "IGNORE">
<!ENTITY % WIPO_ENT               "IGNORE">
<!ENTITY % SIPO_ENT               "IGNORE">
<!ENTITY % MATHML2_DTD            "IGNORE">
<!ENTITY % TABLE_DTD              "INCLUDE">
<!ENTITY % MATH_PLACEHOLDER       "INCLUDE">
<!ENTITY % TABLE_PLACEHOLDER      "IGNORE">
```

因此实际引用闭包只有两个文件：

```
cn-application-body-20080416.dtd
└── soextblx.dtd   （%calstblx;，OASIS Open XML Exchange Table Model 19990315）
```

`wipo.ent`、`sipo.ent`、`mathml2.dtd` 及其递归依赖（`mathml2-qname-1.mod`、
`iso8879/*.ent`、`iso9573-13/*.ent`、`mathml/*.ent`）全被 `IGNORE`，不进闭包。
`soextblx.dtd` 自身无外部引用。该结论已用 libxml2 的输入提供器跟踪实测复核，解析器
对外部资源的请求恰为两次（详见 `converters/renderers/xml/dtd/SOURCE.md` 第三节）。

**由此产生的一个关键后果**：`MATHML2_DTD` 被关掉、`MATH_PLACEHOLDER` 被打开，DTD 里
`math` 的声明退化为

```dtd
<!ELEMENT math (#PCDATA)>
```

即 `<maths>` 下的 `<math>` **只能装文本，装不了展开的 MathML 元素树**。官方工具把所有
公式一律转成图片提交，根子就在这里；MarkFlow 的 patent profile 必须照做。

### 3.2 根元素与五书容器

```dtd
<!ELEMENT cn-application-body (application-reference?, cn-abnormal-formats?,
          (doc-page+ | (cn-claims?, description?, cn-drawings?, cn-abstract?)))>
<!ATTLIST cn-application-body
	lang CDATA #REQUIRED
	dtd-version CDATA #IMPLIED
	file CDATA #IMPLIED
	status CDATA #IMPLIED
	id ID #IMPLIED
	country CDATA #REQUIRED
	file-reference-id CDATA #IMPLIED>
```

`lang` 与 `country` 必填，官方固定为 `lang="zh" country="CN"`。`doc-page+` 分支是「整页
扫描图」形态，用于纸件数字化，与 Word 转档路径无关。

四个容器共用参数实体 `%body_sections;`（`id`／`lang`／`status`，均可选）：

```dtd
<!ELEMENT cn-claims   (doc-page+ | (p*, claim+))>
<!ELEMENT description (doc-page+ | (invention-title?,
                        (technical-field | background-art | disclosure
                       | description-of-drawings | best-mode | mode-for-invention
                       | industrial-applicability | sequence-list-text
                       | (heading*, p+)+)+))>
<!ELEMENT cn-drawings (doc-page+ | ((br?, cn-drawing-p*, figure+, pb?), cn-drawing-p*)+)>
<!ELEMENT cn-abstract (doc-page+ | (abst-problem, abst-solution, cn-abst-figure?)
                                 | (p*, cn-abst-figure?))>
```

注意 `description` 的真实写法是 `invention-title?` **在内层括号内**，与常见转述略有
出入；`cn-claims` 允许在 `claim+` 之前有零个或多个 `p`（用于「权利要求书」前的说明性
文字）。

### 3.3 `description` 分节、`heading`、`p`

DTD 给出了八个语义分节元素（`technical-field`、`background-art`、`disclosure`、
`description-of-drawings`、`best-mode`、`mode-for-invention`、`industrial-applicability`、
`sequence-list-text`），另有中国扩展的 `tech-solution`、`tech-problem`；它们的内容模型
一律是 `(heading*, p+)+`。

但**官方工具不用这些语义元素**，而是走 `description` 的最后一个分支 `(heading*, p+)+`，
把 `heading` 与 `p` 直接平铺在 `description` 下。手册 3.4.7／3.4.8 的 XMLSpy 截图可证：

```xml
<description><invention-title>横向校对和输出双层PDF的方法和装置</invention-title>
<heading id="h0001" level="2">技术领域</heading>
<p id="p0001" num="0001" Italic="0">
本发明属于文字处理领域，涉及一种数据校对和输出双层PDF的方法和装置，……</p>
<heading id="h0002" level="2">背景技术</heading>
```

元素声明：

```dtd
<!ELEMENT invention-title (#PCDATA | b | pb | br | i | u | sup | sub | smallcaps | overscore | img)*>
<!ATTLIST invention-title id ID #IMPLIED  lang CDATA #IMPLIED>

<!ELEMENT heading (#PCDATA | img | b | br | pb | i | u | sup | sub | smallcaps | overscore)*>
<!ATTLIST heading level (1 | 2 | 3) #IMPLIED  id ID #IMPLIED>

<!ELEMENT p (#PCDATA | cn-unregulated-part | cn-abnormal-formats | b | pb | i | u
           | sup | sub | smallcaps | overscore | br | dl | ul | ol | figref
           | patcit | nplcit | crossref | img | chemistry | maths | tables
           | table-external-doc | pre | bio-deposit)*>
<!ATTLIST p
	id ID #IMPLIED
	num CDATA #REQUIRED
	Italic (1 | 0) #REQUIRED>
```

`p` 的 `num` 与 `Italic` 都是**必填**，`Italic` 是国知局在 ST.36 之上加的扩展（注意大写
首字母）。DTD 注释建议 `id = p0001, p0002 …`、`num = 0001, 0002 …`，官方工具照此执行。

### 3.4 `cn-claims` / `claim` / `claim-text` / `claim-ref`

```dtd
<!ELEMENT claim (claim-text+)>
<!ATTLIST claim  id ID #IMPLIED  num CDATA #REQUIRED  claim-type CDATA #IMPLIED>

<!ELEMENT claim-text (#PCDATA | cn-unregulated-part | cn-abnormal-formats | claim-text
                    | claim-ref | b | pb | i | u | sup | sub | smallcaps | overscore
                    | br | pre | crossref | figref | img | chemistry | maths | tables)*>
<!ATTLIST claim-text %body_sections;>

<!ELEMENT claim-ref (#PCDATA)>
<!ATTLIST claim-ref idref IDREFS #REQUIRED>
```

三点要害。第一，`claim-text` 可**自嵌套**，因此权项内的分步骤可以分层；官方工具的
实际做法是平铺多个 `claim-text` 兄弟。第二，`claim-ref/@idref` 类型是 **IDREFS**——空格
分隔的多值，且每个值必须指向本文档内已声明的 ID，所以「根据权利要求 1 或 2 所述」应写
成 `idref="cl001 cl002"`。第三，`claim/@num` 必填。

DTD 注释在此处**自相矛盾**：继承自 WIPO 的英文注释建议 `id = c0001 …; num = 0001 …`，
国知局补写的中文注释建议 `id = cl0001, cl0002……`、`num = 0001, 0002`，而官方工具的
实际输出（手册 3.4.5／3.4.6 两处 XMLSpy 截图，互相印证）是：

```xml
<cn-claims><claim id="cl001" num="1"><claim-text>
一种横向校对和输出双层PDF的方法，包括以下步骤：</claim-text>
```

即 **`id` 为 `cl` + 三位、`num` 为不带前导零的阿拉伯数字**。以工具实际输出为准。

### 3.5 `cn-drawings` / `figure` / `img`

```dtd
<!ELEMENT figure (img)>
<!ATTLIST figure  id ID #IMPLIED  num CDATA #REQUIRED  figure-labels CDATA #IMPLIED>

<!ELEMENT img (cn-img-p*)>
<!ATTLIST img
	id ID #IMPLIED
	he NMTOKEN #REQUIRED
	wi NMTOKEN #REQUIRED
	top NMTOKEN #IMPLIED
	left NMTOKEN #IMPLIED
	file CDATA #REQUIRED
	alt CDATA #IMPLIED
	img-content (drawing | photograph | character | dna | undefined) "drawing"
	img-format (jpg | tif | st33 | st35) #REQUIRED
	orientation (portrait | landscape) "portrait"
	inline (yes | no) "no">

<!ELEMENT cn-drawing-p (p)>
<!ELEMENT cn-img-p (p)>
```

`figure` 的内容模型是严格的 `(img)`——**恰好一个 `img`，不多不少**，图号只能写进
`@num`／`@figure-labels`，图注只能放在同级的 `cn-drawing-p`（内含恰好一个 `p`）里。

DTD 注释明载 `he, wi 建议以毫米为单位 - 高，宽`、`top,left 左上角定点坐标 - 以毫米为
单位`、`id Recommended i0001, i0002, etc.`。`img-format` 必填且是枚举，可选值只有
`jpg | tif | st33 | st35`，**没有 png**——这与「Word 编写建议里允许 png」并不冲突：
png 是源文档里的允许格式，提交前必须转成 jpg 或 tif。

### 3.6 `cn-abstract` / `cn-abst-figure`

```dtd
<!ELEMENT cn-abst-figure (doc-page+ | (br?, figure+, pb?)+)>
<!ELEMENT abst-problem (p+)>
<!ELEMENT abst-solution (p+)>
```

`cn-abstract` 的三个分支中，官方走的是 `(p*, cn-abst-figure?)`。摘要段落仍须带 `num` 与
`Italic`（DTD 必填），但 `showxml.xsl` 明确不渲染它们（见 4.1）。手册另有备注：「如文档
中存在摘要附图，进行 XML 转换时会弹出提示：含有摘要附图，专利申请改为指定方式不再
单独接收，建议提交申请前将其删除。」——摘要附图正在被官方淡出，本项目仍生成但应给
warning。

### 3.7 `tables` / `maths` / `chemistry`

```dtd
<!ELEMENT tables    (img | ((table | cn-tablef), img?))>
<!ATTLIST tables    id ID #IMPLIED  num CDATA #REQUIRED>

<!ELEMENT maths     (img | ((math | cn-mathf), img?))>
<!ATTLIST maths     id ID #IMPLIED  num CDATA #REQUIRED>

<!ELEMENT chemistry (img | (chem, img?))>
<!ATTLIST chemistry id ID #IMPLIED  num CDATA #REQUIRED>

<!ELEMENT cn-tablef EMPTY>  <!ATTLIST cn-tablef id ID #IMPLIED file CDATA #REQUIRED table-type CDATA #IMPLIED>
<!ELEMENT cn-mathf  EMPTY>  <!ATTLIST cn-mathf  id ID #IMPLIED file CDATA #REQUIRED math-type  CDATA #IMPLIED>
<!ELEMENT chem      EMPTY>  <!ATTLIST chem      id ID #IMPLIED file CDATA #REQUIRED chem-type  CDATA #IMPLIED>
```

三者结构同构，第一分支都是**只含一个 `img`**。这正是「表格、公式、化学式一律转 JPG」
在 DTD 层面的合法依据，与用户要求一致。`num` 三者皆必填。

`table` 来自 `soextblx.dtd`（OASIS 交换表格模型），国知局在引入前重写了两个参数实体：
`%title;` 允许表标题内含 `img`／`b`／`br` 等，`%tbl.entry.mdl;` 把单元格内容扩到
`img | dl | ul | ol | chemistry | maths` 等。若将来要输出 OASIS 表格而非图片，这两处是
落点。

### 3.8 `br` / `pb` 与行内标记

```dtd
<!ELEMENT br EMPTY>  <!ATTLIST br rnum CDATA #IMPLIED>
<!ELEMENT pb EMPTY>  <!ATTLIST pb pnum CDATA #IMPLIED  rnum CDATA #IMPLIED>
<!ELEMENT b (#PCDATA | i | u | pb | br | smallcaps | overscore | sub | sup | img)*>
<!ELEMENT i (…同构…)>
<!ELEMENT u (…)>  <!ATTLIST u style (single | double | dash | dots) "single">
<!ELEMENT sup (#PCDATA | b | pb | br | u | i | sup | sub | img)*>
<!ELEMENT sub (…同构…)>
<!ELEMENT figref (#PCDATA | b | pb | br | i | u | sup | sub | smallcaps | overscore)*>
<!ATTLIST figref idref IDREFS #IMPLIED  num CDATA #IMPLIED>
```

`br` 为段内软换行，官方工具的中间表示用 `p-br`／`pp-br`／`claim-br` 三个哨兵区分场景。
`pb` 为分页，`@pnum` 记页码。`figref/@idref` 同样是 IDREFS，跨文件引用会指向不存在的
ID——由于五书分属五个文件，说明书里的 `figref` **不能**用 `idref` 指向附图文件里的
`figure`，只能用 `@num`。

### 3.9 非规范内容的兜底

```dtd
<!ELEMENT cn-unregulated-part (cn-unregulated-img, cn-unregulated-p)>
<!ELEMENT cn-unregulated-img  (img+)>
<!ELEMENT cn-unregulated-p    (p*)>

<!ELEMENT cn-abnormal-formats (cn-abnormal-format+)>
<!ELEMENT cn-abnormal-format  (cn-operator-note, cn-abnormal-original-img*)>
<!ATTLIST cn-abnormal-format  id ID #REQUIRED  cn-abnormal-format-type CDATA #REQUIRED>
<!ELEMENT cn-operator-note    (#PCDATA)>
<!ELEMENT cn-abnormal-original-img (img+)>
```

`cn-unregulated-part` 是「切图 + 代码化文本」的配对兜底，可出现在 `p` 与 `claim-text`
内部；`cn-abnormal-formats` 是文档级的异常记录（加工者说明 + 原图），挂在
`cn-application-body` 的第二个位置或 `p`／`claim-text` 内。二者都属于受理端加工流程的
产物，MarkFlow 本期只做只读支持（能校验通过即可），不主动生成。

### 3.10 DTD 自带的 id 命名建议（完整表）

DTD 注释里逐个元素给出了推荐 id 形态，这是本项目 `ID_STYLE` 常量最权威的一手依据：

| 元素 | DTD 推荐 id | 官方工具实测 |
|---|---|---|
| `p` | `p0001, p0002 …`（`num = 0001 …`） | 一致 |
| `heading` | `h0001, h0002 …` | 一致 |
| `claim` | 中文注释 `cl0001 …`；英文注释 `c0001 …` | **`cl001`**（三位），`num="1"` |
| `figure` | `f0001, f0002 …` | 未见样本（待 R2） |
| `img` | `i0001, i0002 …` | 与 DLL 中 `drawing-` 相邻的 `i` 前缀一致 |
| `tables` | `tabl0001 …` | DLL 中有 `tabl` 常量，一致 |
| `maths` | `math0001 …` | DLL 中有 `math` 常量，一致 |
| `chemistry` | `chem0001 …` | DLL 中有 `chem` 常量，一致 |
| `dl` | `dlis0001 …` | — |
| `dt`/`dd` 项 | `dtrm0001 …` | — |
| `ul` | `ulis0001 …` | — |
| `ol` | `list0001 …` | — |
| `doc-page` | `docp0001 …` | — |
| `description` | `'desc'` | 官方不写 `id` |
| `cn-claims` | `'claim'`（多组时 `claim0001`） | 官方不写 `id` |
| `cn-drawings` | `'draw'` | 官方不写 `id` |
| `cn-abstract` | `'abst'`（多份时 `abst0001`） | 官方不写 `id` |
| `abst-problem` / `abst-solution` | `'absp'` / `'abss'` | — |
| `sequence-list-text` | `'seqt'` | — |
| `technical-field` 等语义分节 | `'tech'`/`'bart'`/`'disc'`/`'desd'`/`'bmod'`/`'mode'`/`'inap'` | 官方不用这些元素 |

另有一个官方工具专有、DTD 未提及的约定：**无段号的「临标记」段落写作
`<p id="l0001" num="XXXX" Italic="0">`**——`id` 前缀是小写字母 `l` 加四位序号，`num`
是字面量 `XXXX`。三重佐证：手册 3.4.4 的 XMLSpy 截图；`WordToolKit.dll` 的 `#US` 堆中
`'l'`、`'D4'`、`'num'`、`'XXXX'`、`'Italic'` 五个常量连续出现；`PatentTool.dll` 中用于
挑出临时段的 XPath `./p[substring(@id,1,1)="l"]`。

### 3.11 DTD 自身的两处缺陷

1. **`cn-drawings` 的内容模型不满足确定性约束。**
   `(doc-page+ | ((br?, cn-drawing-p*, figure+, pb?), cn-drawing-p*)+)` 中，尾部的
   `cn-drawing-p*` 与下一轮迭代开头的 `br?, cn-drawing-p*` 无法用单符号前瞻区分，违反
   XML 1.0 的 VC: Deterministic Content Model。libxml2 对**任何** `cn-drawings` 元素都会
   报 `Content model of cn-drawings is not deterministic`，与被校验文档无关。实测已确认：
   即使 `cn-drawings` 只含一个 `figure`，该诊断照样出现。处置见第 7 章。
2. **`math` 被降级为 `(#PCDATA)`**（见 3.1），无法承载结构化 MathML。

### 3.12 版本核对：官方数据规范内的同一 DTD

《专利电子申请数据规范（20240120全量）》的 `国家阶段电子申请文件格式表格的XSD定义/`
下有两处 DTD：参考目录 `DTD/`，以及按业务代码编号的 `XSD/<代码>/1.0/<代码>.dtd`
（152 个代码目录，其中 63 个含 `.dtd`）。核对结果：

- `DTD/cn-application-body-20080416.dtd` 与 `DTD/soextblx.dtd` 的 SHA-256 与随转换工具
  分发的版本、与本仓库 `converters/renderers/xml/dtd/` 副本**三者完全一致**
  （`0ebab47a…9985d6`、`68caa8ae…44330`）。
- 63 个业务 DTD 中**恰好 26 个与基础 DTD 逐字节相同**（`diff` 差异行数为 0，SHA-256 同为
  `0ebab47a…`），即它们只是按业务代码改名的副本，**没有任何加表头、加包装元素、改内容
  模型或改 `INCLUDE`／`IGNORE` 开关的情形**。其余 37 个是与申请文件正文无关的独立 DTD
  （请求书等表格类）。

**结论：不存在更新版 `cn-application-body` DTD，也不存在按文书类型分化的变体。** 对
MarkFlow patent profile 的影响为零——一份 DTD 通吃全部 26 类文书，`validate.js` 无需按
业务代码分派。

这 26 个代码结合《附件1-受理递交主业务与附加文件及关联业务关系对照说明.xls》
（974 行，191 个六位代码；用 Node 的 `xlsx` 包读取）与两个 DLL 的文书类型选择器常量，
可映射为：

| 代码 | 文书名称 | 名称来源 | 与五书的关系 |
|---|---|---|---|
| **100001** | **权利要求书** | XLS | 五书之一 |
| **100002** | **说明书** | XLS | 五书之一 |
| **100003** | **说明书附图** | XLS | 五书之一 |
| **100004** | **说明书摘要** | XLS | 五书之一 |
| **100005** | **摘要附图** | XLS | 五书之一 |
| 150127 | 按照条约第19条修改的权利要求书 | XLS | 权利要求书同构 |
| 150130 | 按照条约第34条修改的权利要求书 | XLS | 同上 |
| 150137 | 按照条约第28或41条修改的权利要求书 | XLS | 同上 |
| 150131 | 按照条约第34条修改的说明书 | XLS | 说明书同构 |
| 150138 | 按照条约第28或41条修改的说明书 | XLS | 同上 |
| 150132 | 按照条约第34条修改的说明书附图 | XLS | 说明书附图同构 |
| 150139 | 按照条约第28或41条修改的说明书附图 | XLS | 同上 |
| 150128 | 按照条约第34条修改的说明书摘要 | XLS | 摘要同构 |
| 150135 | 按照条约第28或41条修改的说明书摘要 | XLS | 同上 |
| 150129 | 按照条约第34条修改的说明书摘要附图 | XLS | 摘要附图同构 |
| 150136 | 按照条约第28或41条修改的说明书摘要附图 | XLS | 同上 |
| 150133 | 按照条约第34条修改的核苷酸或氨基酸序列表 | XLS | 序列表 |
| 150140 | 按照条约第28或41条修改的核苷酸或氨基酸序列表 | XLS | 序列表 |
| 150123 | 按照条约第19条修改的声明或说明 | XLS | 声明或说明 |
| 150145 | 核苷酸或氨基酸序列表（推定） | DLL 分组 | 序列表 |
| 150141 | 说明书类（推定） | DLL 分组 | 说明书同构 |
| 150142 / 150147 | 权利要求书类（推定） | DLL 分组 | 权利要求书同构 |
| 150143 | 说明书附图类（推定） | DLL 分组 | 说明书附图同构 |
| 150148 | 声明或说明类（推定） | DLL 分组 | 声明或说明 |
| 100107 | 未知 | — | 未映射 |

「DLL 分组」的依据是 `WordToolKit.dll` 的 `#US` 堆中，这批 `_<代码>` 常量按文书族连续
排列——`_100001, _150142, _150147, _150127, _150130, _150137`（权利要求书族）、
`_100002, _150141, _150131, _150138`（说明书族）、`_100003, _150143, _150132, _150139`
（说明书附图族）、`_100004, _150128, _150135`（摘要族）、`_100005, _150129, _150136`
（摘要附图族）、`_150145, _150133, _150140`（序列表族）、`_150123, _150148`
（声明或说明族）。这七个代码不在 XLS 的 191 个代码内（该表只覆盖受理递交主业务与
附加文件的关联关系），故归属为**推定**，不影响本期实现。

**对本项目的实际意义**：五书代码 100001–100005 由 XLS 逐字确证，与 `PatentTool.dll` 的
定位 XPath（`/100001` 旁为 `claim`、`/cn-application-body/cn-claims`；`/100002` 旁为
`/cn-application-body/description/invention-title`；`/100003` 旁为 `figure`、
`说明书附图未编号`；`/100005` 旁为 `/cn-application-body/cn-abstract/cn-abst-figure`、
`摘要附图超过1张`）以及手册 3.4.5／3.4.6 截图里 XMLSpy 的窗口标题 `[100001]`／`[100002]`
三方互证。据此可确定五书在提交包内的文件名（见 4.4）。

---

## 4 预览样式表、Word 编写规范与文件规则

### 4.1 `showxml.xsl` 的渲染规则

`showxml.xsl`（XSLT 1.1 声明，实为 1.0 语法）把 XML 渲染成一张单列 HTML 表格。三个
样式表参数：`dtddir`（默认 `/dtdandxsl/`，用于取 MathJax 与脚本）、`workingdir`
（默认空串，作图片路径前缀）、`space`（占位空串）。

**段号**：`p` 模板把 `@num` 渲染成红色粗体，且对摘要下的段落不渲染——

```xml
<xsl:template match="p">
  <tr><td style="word-break: break-all">
    <b style="color:red;">
      <xsl:if test="name(..)!='cn-abstract'"><xsl:value-of select="@num"/></xsl:if>
    </b>
    <font face="宋体" size="4">&#160;&#160;<xsl:apply-templates/></font>
  </td></tr>
</xsl:template>
```

段号后接两个 `&#160;`，正文字体宋体、`size="4"`。

**权项号**：`claim` 模板本身不渲染 `@num`（该行被注释掉），改由 `claim-text` 的第一个
兄弟渲染父元素的 `@num`：

```xml
<xsl:template match="claim-text">
  <tr><td style="word-break: break-all">
    <xsl:if test="position()=1"><b style="color:red;"><xsl:value-of select="../@num"/></b></xsl:if>
    <font face="宋体" size="4">&#160;&#160;&#160;&#160;<xsl:apply-templates/></font>
  </td></tr>
</xsl:template>
```

权项正文缩进为四个 `&#160;`，比说明书段落多两个。

**图片尺寸换算**：

```xml
<img src="{$workingdir}{@file}" width="{@wi*4.25}" height="{@he*4.25}" class="zoom" big="{@file}"/>
```

`wi`／`he` 以毫米计，预览按 **4.25 px/mm**（≈108 dpi）换算成 CSS 像素。非 jpg 后缀的
图片走 `<object>`／TIFF 分支（`UTIF.js`）。另有 `scaleimage.js` 的 `ScaleAllImage()` 在
最宽图超过 800 px 时按比例整体缩放。

**`src` 的组装方式很关键**：`{$workingdir}{@file}`，而 `workingdir` 默认是空串。也就是
说，官方预览的默认假设是「XML 与图片同目录、`@file` 直接就是可用的相对路径」。

**各书表头**：`cn-claims` 渲染「权利要求书」、`cn-drawings` 渲染「说明书附图」、
`cn-abstract` 渲染「摘要」（若首子元素是 `cn-abst-figure` 则渲染「摘要附图」）、
`description` 渲染「说明书」（若首子元素是 `sequence-list-text` 则渲染「序列表」），
统一黑体。`invention-title` 为仿宋、`size="5"`、紫色、居中。`heading` 为黑体 `size="4"`。

**表格与公式**：`tables` 渲染成带蓝色「表格」标签的外框表；`maths` 渲染成 1pt 宽的
内联表，上格放 MathML（交 MathJax）、下格放 `img`；`chemistry` 优先渲染 `chem`（以
`<iframe src="{@file}">` 嵌入），否则渲染 `img`。

### 4.2 Word 编写格式建议（`WORDXML.docx` 全文要点）

1. **字体规格**：中文宋体，英文 Times New Roman。
2. **自动编号、行号及链接**：一律不得使用，含 Word／WPS 自动编号与 MathType 的插入公式
   编号。
3. **公式编辑器**：规范使用；公式内不得含文字；一个完整公式内字符统一；同一文件内公式
   编辑器也要统一。
4. **截图**：公式不要截图，应复制粘贴用公式编辑器书写的版本，截图递交后更不清晰。
5. **特殊字体等其他格式**：斜体或特殊字体请用公式编辑器，否则无法保留格式甚至无法显示。
6. **附图**：图片转换为 jpg 或 png 形式；Visio 可选择另存为。
7. **图片布局**：设置为嵌入式，图片单独放置，不要用表格形式。
8. **公式后标点符号**：公式后要有标点（逗号、分号或标号「（1）」），且标点不要放在公式
   编辑器里。

### 4.3 电子申请文件格式要求

- 图片格式 JPG 或 TIF，分辨率 72–300 DPI；图号以文字标注，不得嵌入图内。
- 说明书段号为四位数字，形如 `[0001]`。
- 权利要求项号为阿拉伯数字。
- 数学公式与化学式以图片提交。
- 仅规则的 N×M 表格可由编辑器代码化，其余表格作图片提交；表格不得嵌套。
- 字符限 GB18030 字符集，不得使用自造字；超出者「生僻字转图」。
- Word 文档不得加密或设置保护，不得带修订信息。
- 常规字体限楷体、黑体、宋体、仿宋，其余为「特殊字体」需截图处理。

### 4.4 案卷包目录结构与文件命名（国家阶段）

依据《国家阶段电子申请案卷包目录结构规范》（2022-12-30，`专利电子申请数据规范
（20240120全量）` 内，以 `textutil -convert txt` 读取）。**这一节回答了本项目此前
两个悬而未决的问题：`img/@file` 的引用方式，以及压缩包的内部布局。**

规范给出的案卷包结构示例（原文照录）：

```
0b9a2058-350b-4f6e-8045-366c45348c19 (案卷包标识)
      110101（表格代码）
              110101.xml
      100001
              100001.xml
      100002
              100002.xml
              0001.jpg
              0002.jpg
      100111
              100111-1.xml
              0001.jpg
              0002.jpg
              100111-2.xml
              0003.jpg
              0004.jpg
              100111-3.xml
              100111.pdf
      其他文件
              。。。。。。。。。。。。
       List.xml （描述文件）
```

原文说明四条：

> （1）案卷包目录（无要求，但必须保证唯一）；
> （2）文件目录（必须采用文件编码命名）；
> （3）申请文件（只能包括 xml 文件, jpg 文件，tiff 文件，txt 文件，pdf 文件，doc 文件，
> docx 文件……）；
> （4）案卷包目录下必须提交 list.xml 文件，用于描述案卷包内的结构。

由此可确立五条硬规则：

1. **每类文书各占一个目录，目录名必须是该文书的表格代码**（如 `100002/`）。
2. **XML 文件名 = 表格代码 + `.xml`**（如 `100002.xml`）；同类文书提交多份时以
   `-1`／`-2`／`-3` 后缀区分（如 `100111-1.xml`）。
3. **图片与 XML 平铺在同一个表格代码目录内，没有 `images/` 子目录**，图片名为四位序号
   （`0001.jpg`、`0002.jpg`……），按其在该 XML 中的出现顺序编号。
4. 因此 **`img/@file` 只能是裸文件名**——包内不存在任何可作前缀的子目录。这与
   `showxml.xsl` 用 `{$workingdir}{@file}`（`workingdir` 默认空串）取图、以及编辑器
   打包时用 `*.jpg` 在同级目录取图，三条证据完全自洽。
5. `List.xml` 的 `<XIANGDUILJ>`（文件相对路径）形如 `110101\110101.xml`，即「表格代码
   目录 + 反斜杠 + 文件名」，相对案卷包根。同条目还记 `<BIAOGEDM>`（表格代码）、
   `<GESHILX>`（格式类型，如 `.XML`）、`<DTDVersion>`（如 `1.0`）、`<PAGES>`（页数）、
   `<COUNTS>`（项数或幅数，权利要求书与外观图片用）、`<WENJIANMC>`（文件名称）。

`<DTDVersion>1.0</DTDVersion>` 与数据规范里 `XSD/<代码>/1.0/<代码>.dtd` 的目录层次对应：
**受理端是按「表格代码 + 版本号」定位 DTD 的**，文档 DOCTYPE 里那条
`SYSTEM "/dtdandxsl/cn-application-body-20080416.dtd"` 在受理端更接近一个逻辑标识符，
不必真的按该路径取文件。但提交物必须原样保留这行，因为官方工具与预览插件都按它工作。

**实测补充（官方「WORD 转 ACXML 编辑器」的真实产出，逐项核对一份发明稿的产出目录与压缩包）。**
目录层次与上文规范一致，图片命名与 `List.xml` 两处则与规范示例不同，MarkFlow 以实测为准：

```
<原稿名>/
  100001/100001.xml
  100002/100002.xml   100002_1.jpg … 100002_12.jpg   （说明书；该稿 12 幅全为公式图）
  100003/100003.xml   100003_1.jpg … 100003_16.jpg   （说明书附图）
  100004/100004.xml
  100005/100005.xml   100005_1.jpg                   （摘要附图）
```

1. **图片名为 `<表格代码>_<序号>.jpg`**（如 `100003_1.jpg`），序号自 1 起、**不补零**、按该书内出现顺序，
   而非规范示例里的四位序号 `0001.jpg`；`img/@file` 为裸文件名（`file="100003_1.jpg"`），图片与所属 XML 同目录。
2. **没有 `List.xml`**，也没有其它文件：规范所述的 `List.xml` 不在转换器的产出之内，产出目录与压缩包里都找不到它。
3. **压缩包**（`<原稿名>.zip`，与原稿同级）：条目名形如 `100001/100001.xml`，正斜杠分隔，**没有外层文件夹，
   也没有目录条目**，DEFLATE 压缩，条目的通用标志位带 UTF-8 文件名标志（`0x0800`）。
4. **XML 的字节级形态**：UTF-8 BOM；DOCTYPE 带空内部子集 `…dtd"[]>`；换行为 CRLF、无裸 LF；空元素写作
   `<img … />`（`/>` 前一个空格）。官方的空行与缩进并不规则（`100003.xml` 文件头之后整份在一行，其余文件在块
   元素之间夹多个空行），MarkFlow 只对齐前述四项，不模仿不规则的空白。
5. 同一书内公式、表格、化学式与段内图片混排时是否共用一个序号计数器，该样稿无法验证（`100002` 内只有公式图）；
   MarkFlow 按「同一书内全部图片共用一个自 1 起的计数器」实现，规则集中在 `converters/renderers/xml/assets.js`
   顶部的常量，取得混排样稿后据实调整。

### 4.5 PCT 国际申请案卷包（对照）

《PCT国际电子申请案卷包目录结构规范》走的是 WIPO ePCT 惯例，结构完全不同，但在
「图片与 XML 同级、裸文件名引用」这一点上结论一致（原文照录）：

```
  20221129103345  (案卷包名称)
      10000500002346（案卷包标识）
              2682168726e-appb.xml               申请体文件（四书）
              2682168726e-appb-D000001.tif        引用附图图片
              2682168726e-fees.xml                费用文件
              2682168726e-pkda.xml               包内文件列表
              2682168726e-requ.xml               请求书xml
              2682168726e-vlog.xml               日志文件
              Pct101.pdf                         请求书PDF
```

四书合并为**一个** `-appb.xml`（与国家阶段的五个独立文件相反），附图图片以
`<文件参考号>-appb-D<六位序号>.tif` 命名并与 XML 平铺，包内清单为 `-pkda.xml`
（根元素 `package-data`，DTD `package-data-v1-6.dtd`）。本项目本期只做国家阶段，
PCT 路径仅作记录。

---

## 5 MarkFlow patent profile 映射决策

### 5.1 元素与属性决策表

「证据强度」一栏：**A** = 官方产物、官方规范文本或 DLL 常量逐字可证；**B** = DTD 注释
明文推荐且有 DLL 常量旁证；**C** = 由渲染逻辑或打包逻辑反推，无直接样本。

| 对象 | 生成结果 | 证据 | 强度 | 状态 |
|---|---|---|---|---|
| 文件头三行 | `<?xml version="1.0" encoding="UTF-8"?>` + `<!DOCTYPE cn-application-body SYSTEM "/dtdandxsl/cn-application-body-20080416.dtd">` + `<?xml-stylesheet type="text/xsl" href="/dtdandxsl/showxml.xsl"?>` | `WordToolKit.dll` `#US` 堆逐字 | A | 定稿 |
| 根元素 | `<cn-application-body lang="zh" country="CN">` | 同上 | A | 定稿 |
| 五书分文件 | 五个独立 XML 文件，产物即按表格代码分目录落盘（见下两行）；早期版本在工作目录用可读名 `claims.xml` 等平铺，已废弃，`--clean` 仍负责清理这些旧文件 | 八条骨架常量 + 手册 3.3.1 + 官方真实产出 | A | 定稿 |
| **提交包内的文件名** | **按表格代码命名**：`100001/100001.xml`（权利要求书）、`100002/100002.xml`（说明书）、`100003/100003.xml`（说明书附图）、`100004/100004.xml`（说明书摘要）、`100005/100005.xml`（摘要附图） | 《国家阶段电子申请案卷包目录结构规范》第一节结构示例与说明（2）「文件目录（必须采用文件编码命名）」；代码含义由 XLS 对照表逐字确证 | A | **本轮定稿**（原「待 R2 核对」） |
| **提交包布局** | 产物根 → 每类文书一个表格代码目录 → 目录内平铺 XML 与图片；**不生成 `List.xml`**（官方转换器的真实产出没有它，见 4.4 实测补充）；`{name}.zip` 为同一集合，条目名即相对路径，无外层文件夹、无目录条目；`precheck.json` 与 zip 留在产物根下、不入 zip | 规范第一节示例 + 官方真实产出目录与压缩包 | A | 定稿（已实现） |
| 说明书容器 | `<description>`，**不写 `id`** | 手册 3.4.7 截图 | A | 定稿 |
| 发明名称 | `<invention-title>`，不写 `id` | 同上 | A | 定稿 |
| 分节标题 | `<heading id="h0001" level="2">` | 手册 3.4.3／3.4.8 截图 + DTD 建议 | A | 定稿 |
| 说明书段落 | `<p id="p0001" num="0001" Italic="0">`，`id`／`num` 均四位补零、连续 | 手册 3.4.3 截图 + DTD 建议 | A | 定稿 |
| 无段号段落 | `<p id="l0001" num="XXXX" Italic="0">`，`l` + 四位，独立计数 | 手册 3.4.4 截图 + DLL(`l`,`D4`,`XXXX`) + XPath `substring(@id,1,1)="l"` | A | 定稿 |
| 斜体标记 | 整段斜体 `Italic="1"`，否则 `"0"` | DTD 必填枚举 | A | 定稿 |
| 段内换行 | `<br/>` | 手册 3.4.4／3.4.9 截图 | A | 定稿 |
| 权项 | `<claim id="cl001" num="1">`，`id` 为 `cl` + **三位**补零，`num` 为**不带前导零**的十进制 | 手册 3.4.5／3.4.6 两处截图互证 | A | 定稿（与 DTD 注释 `cl0001`/`0001` 不符，以工具为准） |
| 权项文本 | `<claim-text>`，不写 `id`；多步骤平铺为兄弟节点 | 手册截图 | A | 定稿 |
| 权项引用 | `<claim-ref idref="cl001">1</claim-ref>`；引用多项时 `idref="cl001 cl002"`（IDREFS 空格分隔） | DTD 类型 + `cl` 风格推定 | C | **待 R2 核对**（官方是否真的生成 `claim-ref` 尚无样本） |
| 附图 | `<figure id="f0001" num="1">`；`id` 为 `f` + 四位 | DTD 建议 `f0001` | B | `num` 格式**待 R2 核对**（推定同 `claim/@num`，不带前导零） |
| 图注 | `<cn-drawing-p><p id="l0001" num="XXXX" Italic="0">图1</p></cn-drawing-p>` | DTD 结构 + 临时段约定 | C | **待 R2 核对** |
| 图片 | `<img id="i0001" he="…" wi="…" file="…" img-format="jpg" img-content="drawing" inline="no" orientation="portrait"/>` | DTD 建议 `i0001` + DLL 中 `img/src/height/wi/he/top/left/img-content/drawing/img-format/jpg/orientation/portrait/inline/no` 连续常量序列 | B | 定稿 |
| 图片尺寸 | `wi`／`he` 单位毫米，由像素与 DPI 换算 `px × 25.4 / dpi`，四舍五入取整 | DTD 注释「建议以毫米为单位」+ XSL 的 `@wi*4.25` | A | 定稿 |
| `img/@file` 引用方式 | **裸文件名**，不带 `images/` 或任何前缀 | ①《国家阶段电子申请案卷包目录结构规范》示例中图片 `0001.jpg`／`0002.jpg` 与 `100002.xml` 平铺在同一表格代码目录内，包内**不存在**任何子目录可作前缀；② PCT 规范同样把 `-appb-D000001.tif` 与 `-appb.xml` 平铺；③ `showxml.xsl` 用 `{$workingdir}{@file}` 且 `workingdir` 默认空串；④ 打包时以 `//img/@file \| //physical-name` 收集名单、配合通配符 `*.jpg` 在同级目录取图 | A | **本轮定稿**（原「待 R2 核对」；`FILE_REF_STYLE` 仍集中以备变） |
| 图片文件名 | **`<表格代码>_<序号>.<扩展名>`**（`100003_1.jpg`），序号自 1 起、不补零、按该书内出现顺序，各书独立计数；同一书内全部图片共用一个计数器（推定，见 4.4 实测补充第 5 点）；非 JPG 的遗留图片保留原扩展名 | 官方真实产出（规范示例的 `0001.jpg` 与实测不符，以实测为准） | A | 定稿（已实现，`assets.js`） |
| 表格 | `<tables id="tabl0001" num="1"><img …/></tables>`，一律栅格为 JPG | DTD 建议 `tabl0001` + DLL 常量 `tabl` | B | `num` 格式**待 R2 核对** |
| 公式 | `<maths id="math0001" num="1"><img …/></maths>` | DTD 建议 `math0001` + DLL 常量 `math` | B | 同上 |
| 化学式 | `<chemistry id="chem0001" num="1"><img …/></chemistry>` | DTD 建议 `chem0001` + DLL 常量 `chem` | B | 同上 |
| 公式图片的中间资产名 | `images/omath-<段序>-<段内序>.jpg`，仅为栅格化阶段写入 IR 的资产名；落盘时按上一行改名为 `100002_<序号>.jpg` | DLL 常量 `\omath-` 与完整实例 `\omath-1-1.jpg` | A | 定稿 |
| 附图图片文件名 | `100003_<序号>.jpg`（摘要附图为 `100005_<序号>.jpg`）；早期版本的 `drawing-<序>.jpg` 已废弃 | 官方真实产出（DLL 常量 `\drawing-` 对应的文件名未出现在最终产出中） | A | 定稿 |
| 表格图片的中间资产名 | `images/table-<序>.jpg`，仅为栅格化阶段写入 IR 的资产名；落盘时改名为 `100002_<序号>.jpg` | 无官方对应常量，本项目自定 | — | 本项目约定 |
| 摘要段落 | `<p id="p0001" num="0001" Italic="0">`，仍带四位 `num`（DTD 必填），预览时不显示 | DTD + `showxml.xsl` 的 `name(..)!='cn-abstract'` 判断 | C | **待 R2 核对**（官方摘要段的 `num` 是顺序号还是 `XXXX` 无样本） |
| 摘要附图 | `<cn-abstract><cn-abst-figure><figure …/></cn-abst-figure></cn-abstract>` | 骨架常量 | A | 定稿；生成时附「官方建议删除摘要附图」warning |
| 序列表 | `<description><sequence-list-text><p …/></sequence-list-text></description>` | 骨架常量 + 手册 3.4.9 截图 | A | 定稿（本期不做，留接口） |
| 分节容器 `id` | `cn-claims`／`description`／`cn-drawings`／`cn-abstract` 一律**不写 `id`** | 手册截图中均无 `id` | A | 定稿 |
| 语义分节元素 | **不生成** `technical-field` 等，统一走 `(heading*, p+)+` | 手册 3.4.8 截图 | A | 定稿 |
| `figref` | 说明书内用 `<figref num="1">图1</figref>`，**不写 `idref`** | 五书分文件导致跨文件 IDREFS 不可解析 | A（逻辑必然） | 定稿 |

### 5.2 分节识别与编号规则

- **五书归属**：沿用官方的整段文本正则（允许字间空白），见 2.5。识别不到时把前导内容
  归入 `description` 并 warning。
- **五部分标题**：`技术领域`／`背景技术`／`发明内容`（或 `实用新型内容`）／`附图说明`／
  `具体实施方式`，命中即 `heading level="2"`；另接受 `实施例`／`具体实施例`。
- **段号**：只对 `description`（含 `sequence-list-text`）下的 `p` 编号，四位补零连续。
  段首已有 `[0001]`／`［0001］` 的剥离并复用；与预期不一致时记「段号跳变」warning。
  `heading`、摘要、权项不参与该计数。无段号段另起 `l` 系列计数。
- **权项**：按 `^\s*(\d+)\s*[.、．]` 拆分（官方正则为 `^[[1-9][0-9]*[0-9]*[\.．、]`）；
  `根据权利要求\s*(\d+([-~至或]\d+)*)所述` 生成 `claim-ref`。
- **图号**：优先取相邻段落的「图N」文本，其次按出现顺序补号。
- **官方标记剥离**：吃官方模板文档时，先剥离 `名…名`、`题…题`、`段号[0001]号`、`临…`、
  `条号1.号`、`号图1号`、`序`、`扉` 这八类显式标记再走识别，以便直接复用用户已按官方
  流程标注好的稿件。

### 5.3 与官方工具的差异（改进点）

| 维度 | 官方 | MarkFlow |
|---|---|---|
| 平台与依赖 | Windows 10+ 且必装 Office/WPS | 直接解析 OOXML，macOS/Windows 通用，无 Office 依赖 |
| 标记方式 | 必须在正文插入显式标记字符 | 从 IR 自动识别，不改动源文档，预览中可逐项修正 |
| 模板约束 | 必须套五书模板 | 按标题文本自动分节，容错 |
| 公式转图 | MathJax 2 按原尺寸截图，字号过小难辨 | MathJax 按目标 DPI 放大渲染，尺寸可调 |
| 段号反馈 | 转换后才能看到 | 双栏预览即时显示 `[0001]` 与图片替换结果 |
| 校验时机 | 转换完成／提交时 | 转档前预检（字符集、图片 DPI、表格规则、浮动对象、修订信息） |
| 复杂表格 | 提示「请将其转为图片」后由人工截图 | 一律自动栅格化，合并单元格无需人工干预 |
| 生僻字 | 逐个手工「生僻字转图」 | 一次性扫描出全部越界字符并定位 |
| 预览 | 需另装 `XMLPreviewer.exe` | 桌面端内置 |

---

## 6 覆盖与未覆盖项

### 6.1 本期覆盖

- 发明／实用新型五书：权利要求书、说明书、说明书附图、说明书摘要、摘要附图。
- 段号自动编号与复用、`Italic` 判定、段内 `br`。
- 权项拆分、`claim-ref` 生成。
- 附图 `figure`/`img`，`wi`/`he` 毫米换算。
- 表格、公式、化学式一律栅格化为 JPG。
- OMML → MathML → 图片。
- 预检报告（GB18030、图片 DPI 与格式、浮动对象、自动编号、文档保护、公式后标点）。
- DTD 校验（见第 7 章）。
- `{name}.zip` 打包。

### 6.2 本期不覆盖

| 项 | 原因 |
|---|---|
| 化学式识别与编辑（OSRA／NCDK／CML 内嵌） | 范围外；源文档中的化学式对象按图片处理 |
| XML → Word 反向导入 | 范围外；XML 可被应用直接打开阅读 |
| 一键提交到专利业务办理客户端 | 依赖未公开的本地接口 `http://localhost:9999/common/wsImport` |
| 外观设计（`cn-design-application-body` / `cn-brief` / 外观图片） | 单独 DTD，另行评估 |
| 其它文件（`cn-other-file`，意见陈述书等） | 单独 DTD，另行评估 |
| 序列表（`sequence-list-text`） | 骨架已知，但 ST.26 序列表另有专用流程 |
| OASIS 代码化表格（`table`/`tgroup`/`row`/`entry`） | 用户明确要求表格转图；保留 `--tables-as-xml` 开关备用 |
| LaTeX → MathML | MinerU 产出的 LaTeX 本期保留为文本 |
| 生僻字 OCR 识别 | 只做检出与定位，不做识别；越界字符按单字栅格化 |
| `cn-unregulated-part` / `cn-abnormal-formats` 的生成 | 属受理端加工产物，只做只读兼容 |
| 补正、修改文本（`cn-amendment-request-20080416.dtd`） | 范围外 |

---

## 7 校验方案与回归夹具

### 7.1 校验器选型

在会话临时目录安装两个候选包的最新版实测（Node.js v22.23.1，macOS）：

| 维度 | `libxml2-wasm@0.7.2` | `xmllint-wasm@5.3.0` |
|---|---|---|
| **能否做 DTD 校验** | **能**（`XmlDtd`、`DtdValidator`、`ParseOption.XML_PARSE_DTDVALID`） | **不能** |
| 出口 | **仅 ESM**（`main: lib/index.mjs`，无 `exports`、无 CJS 构建） | CJS（`main: index-node.js`）+ 浏览器 ESM |
| 安装体积 | 1.3 MB | 888 KB |
| 原生依赖 | 无 | 无 |
| wasm 文件位置 | **无独立 `.wasm`**，二进制内联在 `lib/libxml2raw.mjs`（963 KB） | **独立 `xmllint.wasm`（779 KB）** |
| asar 影响 | 无需 `asarUnpack` | 需 `asarUnpack: ["**/*.wasm"]` |
| 运行期依赖 | 0 | 0（`@types/node` 为 devDep 传递） |
| 许可 | MIT（libxml2 本体 MIT） | MIT |

`xmllint-wasm` 被排除的原因是硬性的：它随包的 `xmllint.wasm` 在编译 libxml2 时**关掉了
校验模块**（`LIBXML_VALID_ENABLED`）。实测传 `--dtdvalid` 与 `--valid` 均返回
`Unknown option`，其 usage 列表里只有 `--relaxng`／`--schema`／`--schematron`，并且在
wasm 二进制中检索不到任何 DTD 校验诊断字符串。它做 XSD 可以，做 DTD 不行。

**结论：选用 `libxml2-wasm`，放入 `optionalDependencies`。**

### 7.2 接入方式：按 DOCTYPE 加载 + 输入提供器

两种接法实测结果不同，必须用后者：

- `XmlDtd.fromString(dtdText)` + `DtdValidator`：DTD 从内存字符串解析，**没有 base URI**，
  因而 `%calstblx; SYSTEM "soextblx.dtd"` 永远解析不到，`table`／`tgroup`／`row`／`entry`
  全部「无声明」。实测确认：注册输入提供器也救不回来，因为解析器根本不发起请求。
- `XmlDocument.fromString(xml, { url, option: XML_PARSE_DTDVALID })`：libxml2 按文档
  DOCTYPE 的 SYSTEM 标识符请求外部 DTD，经输入提供器拿到后**带 base URI**，`soextblx.dtd`
  随即被解析为 `/dtdandxsl/soextblx.dtd` 并成功加载。这是唯一能让闭包完整生效的接法。

跟踪输出（实测）：

```
[provider] match(/dtdandxsl/cn-application-body-20080416.dtd) -> true
[provider] open(/dtdandxsl/cn-application-body-20080416.dtd) -> …/converters/renderers/xml/dtd/cn-application-body-20080416.dtd
[provider] match(/dtdandxsl/soextblx.dtd) -> true
[provider] open(/dtdandxsl/soextblx.dtd) -> …/converters/renderers/xml/dtd/soextblx.dtd
```

### 7.3 `validateXml(xml, { dtdPath })` 接入伪码

```js
// converters/renderers/xml/validate.js
// 懒加载：libxml2-wasm 在 optionalDependencies，未安装时返回「校验器不可用」而非抛错。
// 该模块不得在 converters/index.js 顶层被 require（顶层零重依赖由 index.test.js 守护）。

import path from 'node:path';
import fs from 'node:fs';

const DTD_DIR = path.join(__dirname, 'dtd');
// 白名单杜绝路径穿越与网络取用：只认闭包内这两个文件名。
const ALLOWED_DTD = new Set(['cn-application-body-20080416.dtd', 'soextblx.dtd']);
// 官方 DTD 的 cn-drawings 内容模型违反 XML 1.0 确定性约束，是 DTD 自身缺陷，
// 与被校验文档无关，单列为 warning。代价：cn-drawings 的直接子元素序列不受约束
// （其子元素自身的属性与内容仍照常校验，已实测确认）。
const DTD_DEFECT = /Content model of \S+ is not deterministic/;

let lib = null;      // 模块单例
let registered = false;

async function loadLib() {
  if (lib) return lib;
  try {
    lib = await import('libxml2-wasm');
  } catch {
    return null;     // 未安装
  }
  if (!registered) {
    lib.xmlRegisterInputProvider(createDtdProvider(lib));
    registered = true;
  }
  return lib;
}

// 输入提供器：把 DOCTYPE 里的绝对路径 /dtdandxsl/xxx.dtd 按 basename 映射到本地 dtd 目录。
function createDtdProvider() {
  const open = new Map();
  let nextFd = 1;
  const resolve = (name) => {
    const base = path.basename(String(name));
    return ALLOWED_DTD.has(base) ? path.join(DTD_DIR, base) : null;
  };
  return {
    match: (name) => resolve(name) !== null,
    open(name) {
      const abs = resolve(name);
      if (!abs) return undefined;
      const fd = nextFd++;
      open.set(fd, { buf: fs.readFileSync(abs), pos: 0 });
      return fd;
    },
    read(fd, out) {
      const s = open.get(fd);
      if (!s) return -1;
      const n = Math.min(out.length, s.buf.length - s.pos);
      if (n <= 0) return 0;
      out.set(s.buf.subarray(s.pos, s.pos + n));
      s.pos += n;
      return n;
    },
    close: (fd) => open.delete(fd),
  };
}

/**
 * @param {string} xml  待校验的 XML 文本
 * @param {{ dtdPath?: string, url?: string }} [options]
 *   dtdPath 预留给将来换用其它 DTD（外观设计、其它文件）；默认走文档自身 DOCTYPE。
 * @returns {Promise<{ available: boolean, valid: boolean,
 *                     errors: Array<{line:number,message:string}>,
 *                     warnings: Array<{line:number,message:string}> }>}
 */
export async function validateXml(xml, options = {}) {
  const m = await loadLib();
  if (!m) {
    return { available: false, valid: false, errors: [], warnings: [],
             reason: '校验器不可用：未安装 libxml2-wasm（可选依赖）。' };
  }
  const errors = [];
  const warnings = [];
  let doc = null;
  try {
    // 必须走 DOCTYPE + 输入提供器，XmlDtd.fromString 无 base URI，解析不到 soextblx.dtd。
    doc = m.XmlDocument.fromString(xml, {
      url: options.url,
      option: m.ParseOption.XML_PARSE_DTDVALID,
    });
  } catch (err) {
    if (!(err instanceof m.XmlParseError)) throw err;
    for (const d of err.details ?? []) {
      const item = { line: d.line, message: String(d.message).trim() };
      (DTD_DEFECT.test(item.message) ? warnings : errors).push(item);
    }
    if (!err.details?.length) errors.push({ line: 0, message: String(err.message).trim() });
  } finally {
    doc?.dispose();      // wasm 内存必须显式释放
  }
  return { available: true, valid: errors.length === 0, errors, warnings };
}
```

配套约定：

- `package.json` 的 `optionalDependencies` 加 `"libxml2-wasm": "^0.7.2"`。
- 因为它是 **ESM-only**，CommonJS 侧只能用动态 `import()`，这与
  `converters/index.js` 既有的 `moduleLoader` 懒加载模式一致。
- 无独立 `.wasm` 文件，`asarUnpack` 不必为它开口子（`@jimp/wasm-webp` 仍需要）。
- CLI 暴露为 `--validate`，桌面端暴露为预览面板的「校验」按钮，两处都调同一函数。

### 7.4 回归夹具

`test/fixtures/patent/reference/` 下五份 XML 为**按 DTD 手工编写**的最小样例（非官方
工具输出，性质声明见该目录 `README.md`）。定稿时的实测校验结果：

```
valid    claims.xml
valid    description.xml
valid    drawings.xml  [warning 1 条]
  warning  line 20: Content model of cn-drawings is not deterministic: (doc-page+ | ((br? , cn-drawing-p* , figure+ , pb?) , cn-drawing-p*)+)
valid    abstract.xml
valid    abstract-figure.xml

合计 5 份，失败 0 份
```

负例验证（把 `description.xml` 中 `p0002` 的 `num` 属性删掉）确认校验真实生效：

```
INVALID  bad-description.xml
           line 10: Element p does not carry attribute num
```

另已实测确认：即使 `cn-drawings` 因内容模型缺陷无法建自动机，libxml2 仍会继续校验其
**后代**元素——对一份刻意做坏的附图文档，除那条 warning 外还能同时报出
`Element figure content does not follow the DTD, expecting (img), got (img p )`、
`Element figure does not carry attribute num`、`Element img does not carry attribute file`、
`Value "png" for attribute img-format of img is not among the enumerated set`。因此
把该条诊断降级为 warning 只损失 `cn-drawings` 的直接子元素序列约束，不会形成大洞；
这部分改由 `precheck.js` 自行核对（图号连续性、每个 `figure` 恰含一个 `img`）。

阶段 2 的 `xml-patent.test.js` 应把这五份样例同时用作**输出比对基线**与**校验器自测
输入**：先断言 profile 产出的 XML 结构与之同构，再断言 `validateXml` 对二者都返回
`valid: true`。

---

## 8 风险与开放问题

| 编号 | 问题 | 影响 | 处置 |
|---|---|---|---|
| ~~R-1~~ | `img/@file` 是裸文件名还是带 `images/` 前缀 | 受理端取不到图则整份申请被退 | **已关闭**：官方案卷包规范证实包内无任何子目录，只能是裸文件名（见 4.4 与下文） |
| R-2 | `figure`／`tables`／`maths`／`chemistry` 的 `@num` 是否带前导零 | 校验能过（CDATA），但与官方产物不一致 | 按 `claim/@num` 的实测风格推定为不带前导零；R2 核对 |
| R-3 | 官方是否真的生成 `claim-ref` | 不生成则本项目多写了元素（DTD 允许，不致命） | R2 核对；不确定时可加 `--no-claim-ref` 开关 |
| R-4 | 摘要段落的 `num` 取顺序号还是 `XXXX` | 预览不显示，影响小；但受理端可能校验 | R2 核对；当前取顺序号 |
| ~~R-5~~ | 压缩包内部布局（XML 与图片是否同级、有无子目录） | 决定 `writeFolder` 与 zip 的目录结构 | **已关闭**：官方案卷包规范给出完整结构与命名规则（见 4.4） |
| ~~R-6~~ | 更新版 DTD/XSD 是否存在 | 若 2024 版数据规范含更新 DTD，本副本需替换 | **已关闭**：不存在更新版，见下文与 3.12 |
| ~~R-13~~ | 图片需按案卷结构命名，`img/@file` 须与实际文件一致 | 不一致则 XML 与包内实际文件对不上 | **已关闭**：按官方真实产出命名为 `<表格代码>_<序号>.<扩展名>`（不是规范示例的 `0001.jpg`），由 `assets.js` 在渲染时一次分配，`img/@file`、落盘路径与 zip 条目同源；`xml-patent.test.js` 有断言 |
| ~~R-14~~ | 五书需按表格代码建目录（`100001`…`100005`）；是否要生成 `List.xml` | 结构不符则客户端无法导入 | **已关闭**：产物目录与 `{name}.zip` 均按表格代码分目录，与官方转换器的真实产出逐项一致；官方转换器本身不产出 `List.xml`（见 4.4 实测补充），故不生成 |
| R-7 | `cn-drawings` 内容模型缺陷 | 直接子元素序列不受 DTD 约束 | 已定方案：降级为 warning + `precheck.js` 自查（见 7.4） |
| R-8 | `libxml2-wasm` 为 ESM-only | CJS 侧只能动态 `import()` | 与既有 `moduleLoader` 模式一致，无额外成本 |
| R-9 | DTD 把 `math` 降级为 `(#PCDATA)` | 无法提交结构化 MathML | 与官方一致：公式一律转图；MathML 仅作中间表示 |
| R-10 | `figref` 无法跨文件 `idref` | 说明书引用附图只能靠 `@num` | 已定：只写 `@num`，不写 `idref` |
| R-11 | 外观设计与「其它文件」用另外两个 DTD | 本期未覆盖 | 明确排除；`cn-design-application-body-20080416.dtd` 与 `cn-other-file-20080416.DTD` 已在解包件内，需要时按同法追踪闭包 |
| R-12 | `WordToolKit.dll` 中出现内网地址 `http://10.76.112.30:8003/api/v1/image` | 疑为官方内部图片服务；对本项目无影响 | 仅记录 |

### 关于 R-6（数据规范压缩包核对）——已核对

`专利电子申请数据规范（20240120全量）.zip`
（`https://resources.cponline.cnipa.gov.cn/resources/zlywbl_user/2024/01/17/14/zip/13b3a2216758ffa70ab2b249c9a46995.zip`，
自官方「工具下载」页 `selectToolsById?weihuRid=248`，无需登录）已下载并解包，核对结论
分三条：

1. **不存在更新版 DTD。** 规范内 `国家阶段电子申请文件格式表格的XSD定义/DTD/` 下的
   `cn-application-body-20080416.dtd` 与 `soextblx.dtd`，其 SHA-256 与随转换工具
   V4.3_2_20251218 分发的版本、与本仓库 `converters/renderers/xml/dtd/` 的副本三者完全
   一致（`0ebab47a…9985d6`、`68caa8ae…44330`）。本副本无需替换。
2. **按业务代码编号的 26 份 `cn-application-body` DTD 全部是逐字节相同的改名副本**，
   没有任何内容模型或开关差异（详见 3.12）。对 patent profile 的影响为零。
3. **规范另附两份案卷包目录结构说明，反而解决了 R-1 与 R-5。** 这是本轮最大的收获：
   《国家阶段电子申请案卷包目录结构规范》给出了提交包的完整目录层次、XML 命名规则与
   图片存放位置，据此把「`img/@file` 引用方式」与「压缩包内部布局」两项从推定升级为
   有据结论（见 4.4）。原先担心的「页面自述该规范只针对请求类表格」并不成立——它同时
   覆盖了申请文件正文。

规范内与申请文件正文无关的部分一并记录，以免后续重复排查：`XSD/` 下 152 个业务代码
目录中，`200105`／`200109`／`200112`／`200113`／`200603` 五个目录里的 `.htm`（另各带一份
`*.files/header.htm`）是 Word 另存 HTML 的**通知书与回执模板**——分别为电子申请回执类
（200105、200109）、《电子申请待处理回执》（200112）、《电子申请拒收回执》（200113）与
《专利电子申请审查信息提示》（200603）。其正文只有「发明创造名称／提交人姓名或名称／
国家知识产权局收到时间／收到文件情况／拒收原因」等表单标签与固定话术，**与申请文件
正文 XML 无任何关系**，本项目不使用。同理，`XSD/` 下另 121 份 `.xsd` 与 37 份非
`cn-application-body` 的 `.dtd` 均为请求书等表格类定义，不在本期范围。

---

## 来源清单

### 一手：官方安装包解包件（本地，不入库）

根目录 `<仓库根>/.reference/cnipa-word2xml/`（已
`.gitignore`）。下列为相对该根目录的路径。

| 路径 | 用途 |
|---|---|
| `msi-files/dtdandxsl/cn-application-body-20080416.dtd` | 第 3 章全部内容模型与 id 命名建议 |
| `msi-files/dtdandxsl/soextblx.dtd` | OASIS 表格模型，引用闭包第二环 |
| `msi-files/dtdandxsl/showxml.xsl` | 第 4.1 节渲染规则 |
| `msi-files/dtdandxsl/scaleimage.js` | 预览图片整体缩放逻辑 |
| `msi-files/dtdandxsl/cn-design-application-body-20080416.dtd`、`cn-other-file-20080416.DTD`、`cn-amendment-request-20080416.dtd` | 外观设计／其它文件／补正的 DTD（本期未覆盖） |
| `msi-files/dtdandxsl/mathml2.dtd`、`mathml2-qname-1.mod`、`iso8879/`、`iso9573-13/`、`mathml/`、`isogrk*.ent`、`wipo.ent` | 被出厂开关 `IGNORE`，不在引用闭包内 |
| `msi-files/WordToolKit.dll` | 八条文档骨架常量、`img` 属性序列、id 前缀（`l`/`h`/`cl`/`i`/`tabl`/`math`/`chem`）、图片命名前缀、分节正则、DTD 校验提示、打包常量 |
| `msi-files/PatentTool.dll` | 业务校验提示语全集、五部分标题文本、定位 XPath |
| `msi-files/dotx` … `dotx_7` | 八个五书模板（经 `docProps/app.xml` 的 `<Template>` 与 `word/header1.xml` 还原文件名） |
| `msi-files/config.xml` | 两项配置 |
| `msi-files/*.head`、`*.end` | **实为 32×32 PNG 图标**，非 XML 片段模板（见 2.3） |
| `manual-mineru/WORD转ACXML编辑器用户操作手册-Word版/full.md` | 手册正文（mineru 解析，582 行）；3.4 节的 XMLSpy 截图给出官方真实输出片段 |
| `wordxml-docx-md/WORDXML-/WORDXML-.md` | `WORDXML.docx`（Word 编写格式建议）全文，markflow 转换 |

### 一手：官方数据规范解包件（本地，不入库）

`专利电子申请数据规范（20240120全量）.zip`，下载自
`https://resources.cponline.cnipa.gov.cn/resources/zlywbl_user/2024/01/17/14/zip/13b3a2216758ffa70ab2b249c9a46995.zip`
（官方「工具下载」页 `selectToolsById?weihuRid=248`，无需登录）。解包根目录
`<仓库根>/.reference/cnipa-word2xml/data-spec/unpacked/专利电子申请数据规范（20240120全量）/`（已 `.gitignore`）。下列为相对该根目录的路径。

| 路径 | 用途 |
|---|---|
| `国家阶段电子申请文件格式表格的XSD定义/国家阶段电子申请案卷包目录结构规范.doc` | **4.4 节全部内容**；案卷包目录层次、XML 与图片命名、`List.xml` 结构。旧式 `.doc`，以 `textutil -convert txt -stdout` 读取 |
| `PCT国际申请文件格式表格的DTD定义/PCT国际电子申请案卷包目录结构规范.doc` | 4.5 节；PCT 路径对照，同法读取 |
| `国家阶段电子申请文件格式表格的XSD定义/附件1-受理递交主业务与附加文件及关联业务关系对照说明.xls` | 3.12 节代码↔文书名称对照（974 行、191 个六位代码）；以 Node `xlsx` 包读取 |
| `国家阶段电子申请文件格式表格的XSD定义/DTD/cn-application-body-20080416.dtd`、`soextblx.dtd` | 版本核对基准，SHA-256 与本仓库副本一致 |
| `国家阶段电子申请文件格式表格的XSD定义/XSD/<代码>/1.0/<代码>.dtd` | 63 份业务 DTD，其中 26 份与基础 DTD 逐字节相同（3.12 节） |
| `国家阶段电子申请文件格式表格的XSD定义/XSD/{200105,200109,200112,200113,200603}/*.htm` | 通知书与回执模板，与申请文件正文无关（第 8 章 R-6 条） |

### 二手：官方通知与标准

- https://www.cnipa.gov.cn/art/2025/11/12/art_75_202551.html —— 2026-01-01 起一律 XML 提交
- https://www.cnipa.gov.cn/art/2025/5/26/art_75_199841.html —— 2025-10-01 起部分类型强制 XML
- https://cponline.cnipa.gov.cn/GzfwYwblGlwhTMVC/GzfwYwblGlwhT/selectToolsById?weihuRid=157 —— WORD 转 ACXML 编辑器下载页
- https://cponline.cnipa.gov.cn/GzfwYwblGlwhTMVC/GzfwYwblGlwhT/selectToolsById?weihuRid=248 —— 专利电子申请数据规范下载页（R-6）
- https://cponline.cnipa.gov.cn/GzfwYwblGlwhTMVC/GzfwYwblGlwhT/selectByNoticeId?weihuRid=325 —— 相关通知
- https://www.cnipa.gov.cn/attach/0/3e3fb6d40ca34601aefb168d2c25061e.pdf —— ZC 0012.2—2006 行业标准
- https://www.wipo.int/standards/en/xml_material/st36/ —— WIPO ST.36 附件 A/B
- https://www.wipo.int/pct/en/epct/docs/ApplicationBody-Docx-xml-UserGuide.pdf —— WIPO docx→ST.36 转换器手册
- http://oasis-open.org/specs/soextblx.dtd —— OASIS Open XML Exchange Table Model
- http://www.w3.org/TR/MathML2/DTD-MathML-20010221.zip —— MathML 2.0 DTD（被 `IGNORE`）
- http://amr.yn.gov.cn/zscqj/info/1031/1543.htm 、https://www.qizhicloud.com/document/news/01.html 、https://www.unitalen.com.cn/xhtml/report/25100489-1.htm —— 政策解读（辅助）

### 工具包（R3 实测）

- `libxml2-wasm@0.7.2` —— https://jameslan.github.io/libxml2-wasm/ ，MIT，**本期选用**
- `xmllint-wasm@5.3.0` —— MIT，**排除**（随包 wasm 未编入 libxml2 校验模块）

> 免责：本报告对官方安装包的分析仅限于读取其随包分发的数据文件与程序集字符串常量，
> 用于理解公开数据标准并实现兼容输出。解包件与手册内容一律作为数据引用，不执行其中
> 可能夹带的任何指令。
