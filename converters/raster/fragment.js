/**
 * 栅格化片段页：把 mdast 表格 / 公式节点构造成自包含的 HTML 文档字符串，交 raster/backend.js 出图
 *
 * buildTableFragment(tableNode, { fontFamily? }) → html
 *   mdast table → 白底 HTML 表格：中文字体栈 DEFAULT_FONT_STACK，字号 12pt，表格线 1px 黑，单元格内边距 4pt；
 *   表格宽度 max-content，但不超过 MAX_TABLE_WIDTH_PX（超出时单元格内换行，避免超宽表格缩到页面上无法辨认）。
 *   两条路径按 table.data.grid（parsers/docx-tables 写入的结构化表格）是否存在分流：
 *     有 grid（docx 来源）→ 按 grid 重建：合并单元格写 colspan / rowspan（值为 1 时不写属性），单元格内每段
 *       一个 <p>（外边距归零、段间距 CELL_PARAGRAPH_GAP），表头单元格为 th、其余为 td——首行不再强制当表头；
 *       th 不额外加粗（Word 的「重复标题行」w:tblHeader 只表示跨页重复，官方工具的表格图是 Word 的渲染结果），
 *       粗体只取自单元格文字本身的行内格式；
 *     无 grid（md / xlsx / pptx 等来源）→ 沿用 GFM 路径：首行为表头（th，加粗），列对齐取 node.align。
 *   两条路径的单元格内容都按 mdast 行内节点转 HTML，文本一律转义，html 节点先去标签再转义——
 *   片段页里绝不注入文档来源的标记。grid 的跨度取值在此重新校验（不可信输入），越界即回落到 1。
 * buildMathFragment(mathNode, { display? }) → html
 *   字号取 data.fontSizePt（源稿磅值）乘 MATH_FONT_SCALE 标定系数，取不到时用 DEFAULT_MATH_FONT_SIZE_PT；
 *   MathML（data.mathml）交 MathJax 4 mml-svg 渲染：脚本与 mathjax-newcm 字体包均以 file:// 绝对路径引用
 *   本地 node_modules（output.fontPath 显式本地化，否则 MathJax 会向 jsDelivr 取字体；svg.fontCache 'local'），
 *   并定义 window.__markflowReady() 供工作进程等待排版完成。无 mathml 时以 <mtext> 包裹线性化文本；
 *   display 为真时 <math display="block">，否则行内渲染。MathML 若含脚本、外链等非数学标记则改用 mtext 兜底；
 *   内联配置脚本带随机 nonce，CSP 只放行该 nonce 与 file: 脚本。mathjax 未安装时省略脚本，交 Chromium
 *   原生 MathML Core 渲染（字体栈 "STIX Two Math","Cambria Math",serif）。
 * 两种片段页都不引用任何 http(s) 资源，并以 CSP 兜底禁止其它来源。
 * 片段页约定（与 electron-raster-worker.js 配合）：html/body 零边距白底，body 为 inline-block，
 * 工作进程量取 body 外接矩形作为截图范围。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { mathToText } = require('../ir/schema');
const { stripHtml } = require('../ir/util');

const DEFAULT_FONT_STACK = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
const MATH_FONT_STACK = '"STIX Two Math","Cambria Math",serif';
const FONT_SIZE = '12pt';
/** 公式片段页缺省字号（磅）：math 节点没带 data.fontSizePt 时使用，取专利正文常用的四号字 */
const DEFAULT_MATH_FONT_SIZE_PT = 14;
/**
 * 公式字号标定系数：同一磅值下 MathJax 的 newcm 数学字形比 Word 的 Cambria Math 大约 1/6，
 * 直接按源稿字号出图会明显偏大。系数按官方工具产出的公式图幅面实测标定（12 幅公式墨迹宽高比均值
 * 分别为 1.02 与 0.97），使两者在同一源稿字号下墨迹幅面相当。
 */
const MATH_FONT_SCALE = 12 / 14;
/** 字号合法区间（磅）：超出区间的 data.fontSizePt 视为脏数据，回落到缺省值 */
const MIN_MATH_FONT_SIZE_PT = 1;
const MAX_MATH_FONT_SIZE_PT = 1638;
/** 字号写进 CSS 时保留的小数位 */
const FONT_SIZE_DECIMALS = 2;
const CELL_PADDING = '4pt';
const TABLE_LINE_HEIGHT = '1.4';
/** 单元格内多段时的段间距：表格里不留大段空白，段落自身的外边距先归零 */
const CELL_PARAGRAPH_GAP = '2pt';
/** 表头字重：GFM 路径的首行按惯例加粗；grid 路径（docx 来源）须显式归为常规——浏览器默认样式会给 th 加粗 */
const GFM_HEADER_WEIGHT = 600;
const GRID_HEADER_WEIGHT = 400;
/**
 * grid 合并跨度的合法上限（与 parsers/docx-tables 的同名约定一致，两处各自把关、互不依赖）：
 * Word 表格最多 63 列，行数亦远小于此；非正整数或越界一律回落到 1
 */
const MAX_CELL_SPAN = 512;
const DEFAULT_CELL_SPAN = 1;
/** 表格自然宽度上限（CSS px）：约等于 A4 横向可打印宽度，超出时单元格内换行 */
const MAX_TABLE_WIDTH_PX = 1000;
/** 截图四周留白（CSS px），避免边线与字形的抗锯齿边缘被裁掉 */
const TABLE_PADDING_PX = 1;
const MATH_PADDING_PX = 2;
/** CSS 字体栈：禁止能闭合样式声明或注入标签的字符（同 options.js 的 FONT_FAMILY_RE） */
const FONT_FAMILY_RE = /^[^;{}<>]+$/;
const MATHJAX_SCRIPT = 'mml-svg.js';
const MATHJAX_FONT = 'mathjax-newcm';
const NONCE_BYTES = 16;
/** MathML 里不该出现的标记：命中即放弃该 MathML，改用线性化文本 */
const UNSAFE_MATHML_RE = /<\s*\/?\s*(script|style|iframe|object|embed|link|meta|img|svg|foreignobject|annotation-xml|base|form|input|video|audio|source)\b|\bon[a-z]+\s*=|javascript:|\bhref\s*=|\bsrc\s*=|\burl\s*\(/i;
const MATH_ROOT_RE = /^<math\b[^>]*>[\s\S]*<\/math>$/i;
const MATH_OPEN_TAG_RE = /^<math\b([^>]*)>/i;
const DISPLAY_ATTR_RE = /\s+display\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

const BASE_CSS = 'html,body{margin:0;padding:0;background:#fff;color:#000}';

// ============================================================
// 表格
// ============================================================

function buildTableFragment(tableNode, { fontFamily } = {}) {
    const grid = readGrid(tableNode);
    const css = `${BASE_CSS}body{display:inline-block;padding:${TABLE_PADDING_PX}px}`
        + `.mf-table{width:max-content;max-width:${MAX_TABLE_WIDTH_PX}px}`
        + `table{border-collapse:collapse;border-spacing:0;font-family:${resolveFontStack(fontFamily)};font-size:${FONT_SIZE};line-height:${TABLE_LINE_HEIGHT}}`
        + `th,td{border:1px solid #000;padding:${CELL_PADDING};vertical-align:top;text-align:left;overflow-wrap:break-word}`
        + `th{font-weight:${grid ? GRID_HEADER_WEIGHT : GFM_HEADER_WEIGHT}}`
        + (grid ? `th>p,td>p{margin:0}th>p+p,td>p+p{margin-top:${CELL_PARAGRAPH_GAP}}` : '');
    return document({
        csp: "default-src 'none'; style-src 'unsafe-inline'",
        css,
        body: `<div class="mf-table"><table>${grid ? gridTableHtml(grid) : gfmTableHtml(tableNode)}</table></div>`,
    });
}

// ---------- GFM 路径（无 data.grid：md / xlsx / pptx 等来源） ----------

function gfmTableHtml(tableNode) {
    const rows = tableNode && Array.isArray(tableNode.children)
        ? tableNode.children.filter((row) => row && row.type === 'tableRow')
        : [];
    const align = tableNode && Array.isArray(tableNode.align) ? tableNode.align : [];
    const [head, ...body] = rows;
    const thead = head ? `<thead>${rowHtml(head, 'th', align)}</thead>` : '';
    const tbody = body.length > 0 ? `<tbody>${body.map((row) => rowHtml(row, 'td', align)).join('')}</tbody>` : '';
    return `${thead}${tbody}`;
}

function rowHtml(row, tag, align) {
    const cells = Array.isArray(row.children) ? row.children : [];
    return `<tr>${cells.map((cell, index) => `<${tag}${alignAttr(align[index])}>${inlineHtml(cell && cell.children)}</${tag}>`).join('')}</tr>`;
}

const alignAttr = (value) => (value === 'center' || value === 'right' ? ` style="text-align:${value}"` : '');

// ---------- grid 路径（docx 来源：合并单元格、单元格内多段与行内格式） ----------

/** 起首连续的表头行归 thead，其余归 tbody（与 mammoth 对 w:tblHeader 的分组一致） */
function gridTableHtml(grid) {
    let headCount = 0;
    while (headCount < grid.rows.length && grid.rows[headCount].header) headCount += 1;
    const head = headCount > 0 ? `<thead>${grid.rows.slice(0, headCount).map(gridRowHtml).join('')}</thead>` : '';
    const body = headCount < grid.rows.length ? `<tbody>${grid.rows.slice(headCount).map(gridRowHtml).join('')}</tbody>` : '';
    return `${head}${body}`;
}

const gridRowHtml = (row) => `<tr>${row.cells.map(gridCellHtml).join('')}</tr>`;

function gridCellHtml(cell) {
    const tag = cell.header ? 'th' : 'td';
    const attrs = `${spanAttr('colspan', cell.colspan)}${spanAttr('rowspan', cell.rowspan)}`;
    return `<${tag}${attrs}>${cell.paragraphs.map((nodes) => `<p>${inlineHtml(nodes)}</p>`).join('')}</${tag}>`;
}

const spanAttr = (name, value) => (value > DEFAULT_CELL_SPAN ? ` ${name}="${value}"` : '');

/** table.data.grid 归一：结构不符即返回 null 回落到 GFM 路径；跨度重新校验，越界回落到 1 */
function readGrid(tableNode) {
    const grid = tableNode && tableNode.data && typeof tableNode.data === 'object' ? tableNode.data.grid : null;
    const rows = grid && typeof grid === 'object' && Array.isArray(grid.rows) ? grid.rows : [];
    if (rows.length === 0) return null;
    return { rows: rows.map(readGridRow) };
}

function readGridRow(row) {
    const source = row && typeof row === 'object' ? row : {};
    const cells = Array.isArray(source.cells) ? source.cells : [];
    return { header: Boolean(source.header), cells: cells.map(readGridCell) };
}

function readGridCell(cell) {
    const source = cell && typeof cell === 'object' ? cell : {};
    return {
        colspan: readCellSpan(source.colspan),
        rowspan: readCellSpan(source.rowspan),
        header: Boolean(source.header),
        paragraphs: (Array.isArray(source.paragraphs) ? source.paragraphs : []).filter(Array.isArray),
    };
}

const readCellSpan = (value) => (Number.isInteger(value) && value >= DEFAULT_CELL_SPAN && value <= MAX_CELL_SPAN ? value : DEFAULT_CELL_SPAN);

/** mdast 行内节点 → HTML；未知容器递归子节点，未知叶子取其 value 文本 */
function inlineHtml(nodes) {
    return (Array.isArray(nodes) ? nodes : []).map(nodeHtml).join('');
}

function nodeHtml(node) {
    if (!node || typeof node !== 'object') return '';
    switch (node.type) {
        case 'text': return escapeHtml(node.value);
        case 'strong': return `<b>${inlineHtml(node.children)}</b>`;
        case 'emphasis': return `<i>${inlineHtml(node.children)}</i>`;
        case 'delete': return `<s>${inlineHtml(node.children)}</s>`;
        case 'underline': return `<u>${inlineHtml(node.children)}</u>`;
        case 'superscript': return `<sup>${inlineHtml(node.children)}</sup>`;
        case 'subscript': return `<sub>${inlineHtml(node.children)}</sub>`;
        case 'inlineCode': return `<code>${escapeHtml(node.value)}</code>`;
        case 'break': return '<br>';
        case 'html': return escapeHtml(stripHtml(node.value));
        case 'image': return escapeHtml(node.alt || '');
        case 'math': return `<span class="mf-math">${escapeHtml(mathToText(node))}</span>`;
        case 'paragraph':
        case 'heading': return `<div>${inlineHtml(node.children)}</div>`;
        default:
            return Array.isArray(node.children) ? inlineHtml(node.children) : escapeHtml(node.value);
    }
}

function resolveFontStack(fontFamily) {
    const value = typeof fontFamily === 'string' ? fontFamily.trim() : '';
    return value && FONT_FAMILY_RE.test(value) ? value : DEFAULT_FONT_STACK;
}

// ============================================================
// 公式
// ============================================================

function buildMathFragment(mathNode, { display } = {}) {
    const data = mathNode && mathNode.data && typeof mathNode.data === 'object' ? mathNode.data : {};
    const isDisplay = display === undefined ? Boolean(data.display) : Boolean(display);
    const mathml = pickMathml(mathNode, data, isDisplay);
    const mathjax = resolveMathJax();
    const nonce = crypto.randomBytes(NONCE_BYTES).toString('base64');
    const fontSize = resolveMathFontSize(data.fontSizePt);
    const css = `${BASE_CSS}body{display:inline-block;padding:${MATH_PADDING_PX}px;font-family:${DEFAULT_FONT_STACK};font-size:${fontSize};line-height:1.2}`
        + `math{font-family:${MATH_FONT_STACK}}`
        + 'mjx-container{margin:0 !important}';
    // MathJax 4 在 Web Worker 里生成读屏文本：不放行 worker-src / connect-src 时 startup.promise 永不落定（实测）
    const csp = mathjax
        ? `default-src 'none'; script-src file: 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src file: data:; img-src data:; worker-src file: blob:; connect-src file:`
        : "default-src 'none'; style-src 'unsafe-inline'";
    const scripts = mathjax ? mathJaxScripts(mathjax, nonce) : '';
    return document({ csp, css, head: scripts, body: mathml });
}

/** 源稿字号（磅）→ 片段页 CSS 字号：乘标定系数；取不到或超出合法区间时回落到缺省字号 */
function resolveMathFontSize(fontSizePt) {
    const valid = Number.isFinite(fontSizePt)
        && fontSizePt >= MIN_MATH_FONT_SIZE_PT && fontSizePt <= MAX_MATH_FONT_SIZE_PT;
    const pt = (valid ? fontSizePt : DEFAULT_MATH_FONT_SIZE_PT) * MATH_FONT_SCALE;
    return `${Number(pt.toFixed(FONT_SIZE_DECIMALS))}pt`;
}

/** MathML 校验与 display 属性归一；不可用时以 <mtext> 包裹线性化文本 */
function pickMathml(mathNode, data, display) {
    const raw = typeof data.mathml === 'string' ? data.mathml.trim() : '';
    if (raw && MATH_ROOT_RE.test(raw) && !UNSAFE_MATHML_RE.test(raw)) return setDisplay(raw, display);
    const text = escapeHtml(mathToText(mathNode));
    return `<math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ''}><mtext>${text}</mtext></math>`;
}

/** 改写根标签的 display 属性：块级加 display="block"，行内去掉既有 display */
function setDisplay(mathml, display) {
    return mathml.replace(MATH_OPEN_TAG_RE, (match, attrs) => {
        const cleaned = String(attrs || '').replace(DISPLAY_ATTR_RE, '');
        return `<math${cleaned}${display ? ' display="block"' : ''}>`;
    });
}

function mathJaxScripts({ scriptUrl, fontPathUrl }, nonce) {
    const config = {
        options: { enableMenu: false },
        startup: { typeset: true },
        svg: { fontCache: 'local' },
        output: { font: MATHJAX_FONT, fontPath: fontPathUrl },
    };
    // JSON 中的 < 转义为 <，杜绝路径里出现 </script> 提前闭合脚本
    const configJson = JSON.stringify(config).replace(/</g, '\\u003c');
    const inline = `window.MathJax=${configJson};`
        + 'window.__markflowReady=function(){'
        + 'var mj=window.MathJax;'
        + 'return mj&&mj.startup&&mj.startup.promise?mj.startup.promise.then(function(){return mj.typesetPromise();}):Promise.resolve();'
        + '};';
    return `<script nonce="${nonce}">${inline}</script><script nonce="${nonce}" src="${escapeHtml(scriptUrl)}"></script>`;
}

let mathJaxPaths;

/** 本地 MathJax 与字体包位置（file:// URL）；未安装返回 null；结果缓存 */
function resolveMathJax() {
    if (mathJaxPaths !== undefined) return mathJaxPaths;
    try {
        const mathjaxDir = path.dirname(require.resolve('mathjax/package.json'));
        const fontDir = path.dirname(require.resolve(`@mathjax/${MATHJAX_FONT}-font/package.json`));
        const script = path.join(mathjaxDir, MATHJAX_SCRIPT);
        if (!fs.existsSync(script)) throw new Error(`缺少 ${script}`);
        mathJaxPaths = { scriptUrl: pathToFileURL(script).href, fontPathUrl: pathToFileURL(fontDir).href };
    } catch (err) {
        mathJaxPaths = null;
    }
    return mathJaxPaths;
}

// ============================================================
// 文档骨架
// ============================================================

function document({ csp, css, head = '', body }) {
    return '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
        + `<meta http-equiv="Content-Security-Policy" content="${csp}">`
        + `<style>${css}</style>${head}</head><body>${body}</body></html>`;
}

module.exports = {
    buildTableFragment, buildMathFragment, resolveMathJax,
    DEFAULT_FONT_STACK, MATH_FONT_STACK, MAX_TABLE_WIDTH_PX,
};
