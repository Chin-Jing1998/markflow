# 官方 DTD 与预览样式表副本：来源说明

本目录存放国家知识产权局专利电子申请 XML 的官方 DTD 及其引用闭包，以及官方预览
样式表，供 `converters/renderers/xml` 的 patent profile 做 DTD 校验（阶段 2）与预览
渲染移植（阶段 5）使用。**本目录内所有文件均为原样复制，未作任何修改。**

## 一、来源

| 项 | 值 |
|---|---|
| 上游产品 | 国家知识产权局「WORD 转 ACXML 编辑器」 |
| 产品版本 | V4.3_2_20251218 |
| 安装包 | `word转xml-安装包-2025.12.18.zip` → `word转xml编辑器.msi` |
| 取得路径 | MSI 内 `disk1.cab` 解包后的 `dtdandxsl/` 目录 |
| 官方下载页 | https://cponline.cnipa.gov.cn/GzfwYwblGlwhTMVC/GzfwYwblGlwhT/selectToolsById?weihuRid=157 |
| DTD 自身版本 | v1.0，2008-04-16（见 DTD 文件头注释） |
| DTD 基线 | WIPO ST.36 (2005-09-22) 与 ICE (2005-02-20) |
| DTD 原始发布地址 | http://www.sipo.gov.cn/standards/xml/cn-application-body-20080416.dtd（注释所载，现已失效） |

## 二、文件清单

| 文件 | 大小 | SHA-256 | 用途 |
|---|---|---|---|
| `cn-application-body-20080416.dtd` | 69 KB | `0ebab47a286aae46fdb6a9783ce9fd2a2dbaa6dd9fc7e857fab461918b9985d6` | 发明与实用新型五书的根 DTD；五份 XML 的 DOCTYPE 均指向它 |
| `soextblx.dtd` | 13 KB | `68caa8ae83b2b5a7e78ef36c0678f075bf268fed52b875557f44340b3da44330` | OASIS Open XML Exchange Table Model（1999-03-15），由上一文件经参数实体 `%calstblx;` 引入 |
| `showxml.xsl` | 28 KB | `158d47f4338863914791d7f0fa84975722cc3b046ed704e3e5dcda30dd4e942e` | 官方预览样式表；五份 XML 的 `xml-stylesheet` 处理指令均指向它 |

## 三、引用闭包的确定依据

`cn-application-body-20080416.dtd` 不含任何 `<!ENTITY % … SYSTEM "…">` 形式的无条件
外部引用，其全部外部引用都包在 `<![%SWITCH; [ … ]]>` 条件节内，由文件第 39–45 行的
六个开关参数实体控制。本副本按该 DTD **出厂开关取值**逐级追踪，结论如下：

| 开关参数实体 | 出厂取值 | 受控的外部引用 | 是否进入闭包 |
|---|---|---|---|
| `UNICODE_PLANE1D_ESCAPE` | `IGNORE` | 无（仅定义 `%plane1D;`） | 否 |
| `WIPO_ENT` | `IGNORE` | `wipo.ent` | **否** |
| `SIPO_ENT` | `IGNORE` | `sipo.ent` | **否**（该文件本就不在安装包内） |
| `MATHML2_DTD` | `IGNORE` | `mathml2.dtd`（并经它递归引入 `mathml2-qname-1.mod`、`iso8879/*.ent`、`iso9573-13/*.ent`、`mathml/*.ent`） | **否** |
| `MATH_PLACEHOLDER` | `INCLUDE` | 无（就地声明 `<!ELEMENT math (#PCDATA)>`） | — |
| `TABLE_DTD` | `INCLUDE` | `soextblx.dtd`（参数实体 `%calstblx;`） | **是** |
| `TABLE_PLACEHOLDER` | `IGNORE` | 无 | 否 |

`soextblx.dtd` 自身无任何外部引用（全文仅在注释中提及自己的 FPI），因此闭包到此终止。

该结论已用 libxml2（libxml2-wasm 0.7.2）实测复核：开启输入提供器跟踪后，解析器对外
部资源的请求恰为两次且仅此两次——

```
[provider] open(/dtdandxsl/cn-application-body-20080416.dtd)
[provider] open(/dtdandxsl/soextblx.dtd)
```

因此本目录「不多不少」，既不缺 `soextblx.dtd`（缺它则 `table`/`tgroup`/`row`/`entry`
等 OASIS 表格元素全部无声明），也不含被 `IGNORE` 掉的 MathML 与实体集文件。

## 四、使用注意

1. **`math` 元素被降级。** 出厂开关把 MathML 2.0 DTD 关掉、改用占位声明
   `<!ELEMENT math (#PCDATA)>`。因此 `<maths>` 下的 `<math>` 只能承载文本，**不能**
   放展开的 MathML 元素树；官方工具也正是据此把公式一律以 `<img>` 形式提交。
2. **`cn-drawings` 的内容模型不满足确定性约束。** 官方 DTD 第 1630 行的
   `(doc-page+ | ((br?, cn-drawing-p*, figure+, pb?), cn-drawing-p*)+)` 违反 XML 1.0 的
   VC: Deterministic Content Model，libxml2 会对**任何** `cn-drawings` 元素报
   `Content model of cn-drawings is not deterministic`。这是 DTD 自身缺陷，与被校验
   文档无关，`validate.js` 须把该条诊断单列为 warning；其代价是 `cn-drawings` 的直接
   子元素序列不受 DTD 约束（子元素自身的属性与内容仍照常校验，已实测确认）。
3. **DOCTYPE 路径是绝对路径。** 五份 XML 的 DOCTYPE 写作
   `SYSTEM "/dtdandxsl/cn-application-body-20080416.dtd"`。校验时不要按该路径去磁盘
   取文件，而应注册输入提供器，把请求按 basename 映射到本目录，并以白名单限定可开
   文件名，杜绝路径穿越与网络取用。
4. **`showxml.xsl` 的运行期依赖未随附。** 该样式表在 `<head>` 内引用
   `{$dtddir}MathJax/MathJax.js` 与 `{$dtddir}scaleimage.js`，正文中还可能触及
   `UTIF.js`、`lens.js`、`lens.css`。这些是预览运行期资源而非 DTD 引用闭包的一部分，
   故不在本目录；阶段 5 移植预览时由 MarkFlow 自行提供等价实现。
5. **`workingdir` 与 `dtddir` 是样式表参数。** `showxml.xsl` 以
   `<xsl:param name="workingdir" select="string('')"/>` 作图片路径前缀，默认空串，即
   默认按「XML 与图片同目录」取图。

## 五、许可与合规

`soextblx.dtd` 为 OASIS 发布的公开表格模型 DTD。`cn-application-body-20080416.dtd`
与 `showxml.xsl` 为国家知识产权局为专利电子申请公开发布的数据标准与配套样式表，
随官方转换工具免费分发，本项目仅作原样再分发以支持离线校验与预览，未作修改。
如需核对最新版本，见官方「工具下载」页的「专利电子申请数据规范」条目。
