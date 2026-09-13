# 专利 XML 参考样例（手工编写）

## 一、性质声明

**本目录五份 XML 由人工按官方 DTD 编写，不是国家知识产权局「WORD 转 ACXML 编辑器」
的实际输出。** 编写依据是：

1. 官方 DTD `converters/renderers/xml/dtd/cn-application-body-20080416.dtd` 的内容模型
   与属性声明；
2. 官方安装包内 `WordToolKit.dll` 的 `#US` 字符串堆中逐字取出的文件头与根元素骨架；
3. 官方《WORD 转 ACXML 编辑器用户操作手册》3.4 节所附 XMLSpy 截图中可见的真实输出
   片段（`heading id="h0001" level="2"`、`p id="p0001" num="0001" Italic="0"`、
   `p id="l0001" num="XXXX"`、`claim id="cl001" num="1"` 等）。

手册截图未覆盖 `figure`/`img`/`tables`/`maths` 的实际写法，这部分属性取值由本项目按
DTD 与 `showxml.xsl` 的渲染逻辑推定，**待 R2（Windows 环境实跑官方编辑器）核对**，
详见 `docs/patent-xml-research.md` 第 5 章映射决策表中标注「待 R2 核对」的行。

上述文本内容为虚构示例，不对应任何真实专利申请。

## 二、文件清单

| 文件 | 根下第一层 | 覆盖要点 |
|---|---|---|
| `claims.xml` | `cn-claims` | 三项权利要求；`claim-text` 多段；`claim-ref` 单引用与多引用（`idref="cl001 cl002"`）；权项内嵌 `maths`（仅 `img`） |
| `description.xml` | `description` | `invention-title`；五个 `heading level="2"` 分节；`p` 的四位 `num` 与 `Italic`；`br` 段内换行；`sub`/`sup`/`b` 行内标记；`figref`；`maths` 与 `tables`（均仅 `img`）；末尾一个官方「临标记」段 `id="l0001" num="XXXX"` |
| `drawings.xml` | `cn-drawings` | 两幅 `figure`；`cn-drawing-p` 图号段；`pb` 分页；`img` 的 `wi`/`he`（毫米）、`orientation`、`figure-labels` |
| `abstract.xml` | `cn-abstract` | 摘要段落（走 DTD 的 `(p*, cn-abst-figure?)` 分支；`showxml.xsl` 对 `cn-abstract` 下的 `p` 不显示段号） |
| `abstract-figure.xml` | `cn-abstract` / `cn-abst-figure` | 摘要附图单图 |

五份文件的前三行完全一致，逐字取自 `WordToolKit.dll`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE cn-application-body SYSTEM "/dtdandxsl/cn-application-body-20080416.dtd">
<?xml-stylesheet type="text/xsl" href="/dtdandxsl/showxml.xsl"?>
```

根元素统一为 `<cn-application-body lang="zh" country="CN">`。

> 注意：官方 DLL 中的骨架为**单行**且行尾为 CRLF，本目录样例为便于阅读做了缩进与
> 换行，并统一为 LF。缩进产生的空白在 DTD 层面无影响（相关元素均为混合内容或允许
> 可忽略空白），已实测校验通过。

## 三、图片文件

样例中 `img/@file` 引用的 `omath-*.jpg`、`table-*.jpg`、`drawing-*.jpg` 为**裸文件名**，
对应图片文件本身不在本目录（夹具只校验 XML 结构，不校验图片存在性）。

裸文件名这一点已由官方《国家阶段电子申请案卷包目录结构规范》确证：案卷包内每类文书各占
一个以表格代码命名的目录，XML 与图片平铺其中，**不存在任何可作前缀的子目录**。详见
`docs/patent-xml-research.md` 第 4.4 节。

需注意本目录用的是**工作目录中间文件名**（`drawing-1.jpg` 等，取自官方编辑器的命名前缀）。
按官方规范，落入提交用案卷包时图片须重命名为四位序号 `0001.jpg`／`0002.jpg`……并同步回写
`img/@file`——该重命名属打包阶段职责（报告第 8 章 R-13），不影响本目录样例的 DTD 合规性。

## 四、如何复核

这五份样例必须能通过 DTD 校验。阶段 2 接入 `converters/renderers/xml/validate.js` 后，
以 `libxml2-wasm` 按文档自身 DOCTYPE 加载 `converters/renderers/xml/dtd/` 下的 DTD 校验
即可。定稿时的实测结果为：

```
valid    claims.xml
valid    description.xml
valid    drawings.xml  [warning 1 条]
  warning  line 20: Content model of cn-drawings is not deterministic: (doc-page+ | ((br? , cn-drawing-p* , figure+ , pb?) , cn-drawing-p*)+)
valid    abstract.xml
valid    abstract-figure.xml

合计 5 份，失败 0 份
```

`drawings.xml` 的那条 warning 来自官方 DTD 自身的内容模型缺陷，与样例无关，说明见
`converters/renderers/xml/dtd/SOURCE.md` 第四节第 2 条。
