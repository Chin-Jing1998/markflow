/**
 * converters/parsers/docx-tables.js 单元测试
 * 覆盖：HTML 表格 → grid（colspan / rowspan 的非法值与越界回落、thead / th → header、单元格内多段、
 *       各行内格式、script / style / 注释连内容丢弃、图片占位与 warning、嵌套表格展开与 warning）、
 *       标记只注入顶层表格的首个单元格、
 *       回收后 grid 挂到正确的表格节点（含中间表格被丢弃的错位场景）、兜底清理后整棵 IR 不含标记、
 *       入参不变，以及合成 docx 经 parsers/docx 的端到端跨度与非 patent 目标零回归；
 *       单元格文字含相邻两个低位代理项时不抛错（HTML 直入与 document.xml 字符引用经 parsers/docx 两条路径）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { collectTableGrids, restoreTableGrids, tableMarker, MAX_CELL_SPAN } = require('../converters/parsers/docx-tables');
const { parse } = require('../converters/parsers/docx');
const { createTurndownService } = require('../converters/ir/turndown');
const { loadUnified } = require('../converters/ir/unified-loader');
const {
    createRoot, createParagraph, createText, createTable, createTableRow, createTableCell,
} = require('../converters/ir/schema');
const mdRenderer = require('../converters/renderers/md');
const { buildTableSample, INLINE_TEXTS } = require('./fixtures/build-table-sample');

/** 标记里的两个方括号以码点生成，源码不出现看不见或私用区的字面字符 */
const MARKER_SOURCE = `${String.fromCharCode(0x27E6)}MFT:\\d+${String.fromCharCode(0x27E7)}`;
const MARKER_RE = new RegExp(MARKER_SOURCE);
const ALL_MARKERS_RE = new RegExp(MARKER_SOURCE, 'g');

const gridOf = (html, index = 1) => collectTableGrids(html).grids.get(index);
const cellsOf = (grid, row) => grid.rows[row].cells;
/** 一段行内节点的直接文字（行内容器里的文字另行断言） */
const textOf = (nodes) => nodes.map((node) => (node.type === 'text' ? node.value : '')).join('');

async function parseMarkdown(markdown) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    return unified().use(remarkParse).use(remarkGfm).parse(markdown);
}

/** 走真实链路：HTML → 注入标记 → turndown → remark → 回收 grid */
async function throughPipeline(html) {
    const collected = collectTableGrids(html);
    const markdown = createTurndownService('word').turndown(collected.html);
    const restored = restoreTableGrids(await parseMarkdown(markdown), collected.grids);
    return { ...restored, markdown, collected };
}

function findTables(node, found = []) {
    if (!node || typeof node !== 'object') return found;
    if (node.type === 'table') found.push(node);
    (node.children || []).forEach((child) => findTables(child, found));
    return found;
}

/** 整棵树的全部字符串字段拼起来，供「不含标记」断言 */
function allStrings(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    for (const key of ['value', 'alt', 'title']) {
        if (typeof node[key] === 'string') out.push(node[key]);
    }
    (node.children || []).forEach((child) => allStrings(child, out));
    return out;
}

const assertNoMarker = (node, hint) => assert.ok(!MARKER_RE.test(allStrings(node).join('\n')), `${hint}：树里不应残留表格标记`);

// ============================================================
// HTML 表格 → grid
// ============================================================

test('grid：colspan / rowspan 取整数值，非法值与越界一律回落到 1', () => {
    // Arrange
    const spans = ['2', '0', '-3', '2.5', 'abc', '', String(MAX_CELL_SPAN), String(MAX_CELL_SPAN + 1), '99999'];
    const html = `<table><tr>${spans.map((span) => `<td colspan="${span}">x</td>`).join('')}</tr></table>`;

    // Act
    const cells = cellsOf(gridOf(html), 0);

    // Assert
    assert.deepEqual(cells.map((cell) => cell.colspan), [2, 1, 1, 1, 1, 1, MAX_CELL_SPAN, 1, 1]);
    assert.deepEqual(cells.map((cell) => cell.rowspan), spans.map(() => 1), '未写 rowspan 的单元格取 1');
});

test('grid：rowspan 与 colspan 同时存在时各自独立读取', () => {
    // Arrange / Act
    const cells = cellsOf(gridOf('<table><tr><td colspan="3" rowspan="2">x</td></tr></table>'), 0);

    // Assert
    assert.equal(cells[0].colspan, 3);
    assert.equal(cells[0].rowspan, 2);
});

test('grid：thead 内的行与全 th 的行都算表头，混有 td 的行不算', () => {
    // Arrange
    const html = '<table><thead><tr><td>甲</td></tr></thead>'
        + '<tbody><tr><th>乙</th><th>丙</th></tr><tr><th>丁</th><td>戊</td></tr></tbody></table>';

    // Act
    const grid = gridOf(html);

    // Assert
    assert.deepEqual(grid.rows.map((row) => row.header), [true, true, false]);
    assert.deepEqual(grid.rows.map((row) => row.cells.map((cell) => cell.header)), [[false], [true, true], [true, false]]);
});

test('grid：单元格内每个 <p> 一段，只剩空白的段丢弃', () => {
    // Arrange / Act
    const grid = gridOf('<table><tr><td><p>第一段</p><p>第二段</p><p>  </p></td></tr></table>');

    // Assert
    const { paragraphs } = cellsOf(grid, 0)[0];
    assert.equal(paragraphs.length, 2);
    assert.deepEqual(paragraphs.map(textOf), ['第一段', '第二段']);
});

test('grid：行内格式转成 IR 行内节点，换行转 break，未知容器只留内容', () => {
    // Arrange
    const html = '<table><tr><td><p>甲<strong>粗</strong><em>斜</em><u>下</u><sup>上</sup><sub>标</sub>'
        + '<del>删</del><code>码</code><br><span>跨</span></p></td></tr></table>';

    // Act
    const [paragraph] = cellsOf(gridOf(html), 0)[0].paragraphs;

    // Assert
    assert.deepEqual(paragraph.map((node) => node.type), [
        'text', 'strong', 'emphasis', 'underline', 'superscript', 'subscript', 'delete', 'inlineCode', 'break', 'text',
    ]);
    assert.deepEqual(paragraph[1].children, [{ type: 'text', value: '粗' }]);
    assert.equal(paragraph[7].value, '码');
    assert.equal(paragraph[9].value, '跨');
});

test('grid：script / style 与注释连内容一并丢弃，其文字不进入 grid', () => {
    // Arrange：cheerio 给 script / style 另立节点类型，且它们的文本会被 .text() 一并取回，故须单独把关
    const html = '<table><tr><td><p>甲<script>alert(1)</script><style>p{color:red}</style><!--注释-->乙</p>'
        + '<code>码<script>bad()</script></code></td></tr></table>';

    // Act
    const { paragraphs } = cellsOf(gridOf(html), 0)[0];

    // Assert
    const flat = JSON.stringify(paragraphs);
    for (const leaked of ['alert', 'color:red', '注释', 'bad(']) {
        assert.ok(!flat.includes(leaked), `grid 里不应出现 ${leaked}：${flat}`);
    }
    assert.deepEqual(paragraphs.map(textOf), ['甲乙', '']);
    assert.deepEqual(paragraphs[1], [{ type: 'inlineCode', value: '码' }]);
});

test('grid：嵌套表格展开成纯文本时，其中的 script 内容同样不计入', () => {
    // Arrange
    const html = '<table><tr><td><table><tr><td>内甲<script>alert(2)</script></td></tr></table></td></tr></table>';

    // Act
    const { paragraphs } = cellsOf(gridOf(html), 0)[0];

    // Assert
    assert.deepEqual(paragraphs.map(textOf), ['内甲']);
});

test('grid：单元格内的图片以替换文字占位并记 warning，无替换文字时占位为「图」', () => {
    // Arrange
    const html = '<table><tr><td><p><img src="images/image_1.png" alt="结构式"></p></td>'
        + '<td><p><img src="images/image_2.png"></p></td></tr></table>';

    // Act
    const collected = collectTableGrids(html);
    const cells = cellsOf(collected.grids.get(1), 0);

    // Assert
    assert.deepEqual(cells.map((cell) => textOf(cell.paragraphs[0])), ['结构式', '图']);
    assert.equal(collected.warnings.length, 2);
    collected.warnings.forEach((warning) => assert.match(warning, /表格内的图片未进入表格图/));
});

test('grid：嵌套表格按纯文本展开并记 warning，且不单独登记为顶层表格', () => {
    // Arrange
    const html = '<table><tr><td><p>外层</p><table><tr><td>内甲</td><td>内乙</td></tr></table></td></tr></table>';

    // Act
    const collected = collectTableGrids(html);

    // Assert
    assert.equal(collected.grids.size, 1, '嵌套表格不占序号');
    const { paragraphs } = cellsOf(collected.grids.get(1), 0)[0];
    assert.deepEqual(paragraphs.map(textOf), ['外层', '内甲内乙']);
    assert.deepEqual(collected.warnings, ['表格内的嵌套表格已按纯文本展开']);
});

// ============================================================
// 标记注入
// ============================================================

test('标记只注入顶层表格的首个单元格，嵌套表格不注入', () => {
    // Arrange
    const html = '<p>前</p><table><tr><td>甲<table><tr><td>内</td></tr></table></td><td>乙</td></tr></table>'
        + '<table><tr><th>丙</th></tr></table><p>后</p>';

    // Act
    const { html: marked, grids } = collectTableGrids(html);

    // Assert
    assert.equal(grids.size, 2);
    assert.equal(marked.match(ALL_MARKERS_RE).length, 2, '整份 HTML 里只有两处标记');
    assert.ok(marked.includes(`<td>${tableMarker(1)}甲`), '顶层表一的首个单元格');
    assert.ok(marked.includes(`<th>${tableMarker(2)}丙`), '顶层表二的首个单元格');
    assert.ok(marked.includes('<tr><td>内</td></tr>'), '嵌套表格原样不动');
});

test('无单元格的表格不登记也不注入，但仍占一个序号', () => {
    // Arrange / Act
    const { html: marked, grids } = collectTableGrids('<table></table><table><tr><td>甲</td></tr></table>');

    // Assert
    assert.deepEqual([...grids.keys()], [2]);
    assert.ok(marked.includes(`<td>${tableMarker(2)}甲`));
});

test('无表格的 HTML 原样返回同一引用', () => {
    // Arrange
    const html = '<p>正文</p>';

    // Act
    const collected = collectTableGrids(html);

    // Assert
    assert.equal(collected.html, html);
    assert.equal(collected.grids.size, 0);
});

// ============================================================
// 回收与兜底清理
// ============================================================

test('回收：走 turndown 与 remark 的真实链路，grid 挂到表格节点且标记被剥干净', async () => {
    // Arrange
    const html = '<p>前言</p><table><thead><tr><th colspan="2"><p>表头</p></th></tr></thead>'
        + '<tbody><tr><td><p>甲</p><p>乙</p></td><td rowspan="2"><p>丙</p></td></tr>'
        + '<tr><td><p>丁</p></td></tr></tbody></table>';

    // Act
    const { ir, warnings } = await throughPipeline(html);

    // Assert
    const [table] = findTables(ir);
    assert.equal(table.data.grid.rows[0].cells[0].colspan, 2);
    assert.equal(table.data.grid.rows[1].cells[1].rowspan, 2);
    assert.deepEqual(table.data.grid.rows[1].cells[0].paragraphs.map(textOf), ['甲', '乙']);
    assert.equal(table.children[0].children[0].children[0].value, '表头', '标记从首个单元格剥掉');
    assertNoMarker(ir, '真实链路');
    assert.deepEqual(warnings, []);
});

test('回收：中间的表格被 turndown 丢弃时，后一张表仍拿到自己的 grid（不按出现顺序配对）', async () => {
    // Arrange：空表格被 turndown 整体丢弃，序号 2 随之落空
    const html = '<table><tr><td><p>表一</p></td></tr></table><table></table>'
        + '<table><tr><td colspan="4"><p>表三</p></td></tr></table>';

    // Act
    const { ir, collected } = await throughPipeline(html);

    // Assert
    const tables = findTables(ir);
    assert.equal(tables.length, 2);
    assert.deepEqual([...collected.grids.keys()], [1, 3]);
    assert.equal(tables[0].data.grid.rows[0].cells[0].colspan, 1);
    assert.equal(tables[1].data.grid.rows[0].cells[0].colspan, 4, '第二张 mdast 表格挂的是 3 号 grid');
    assertNoMarker(ir, '错位场景');
});

test('兜底清理：落在表格之外的残留标记一律删除、删空的文本节点移除，并记 warning', () => {
    // Arrange
    const ir = createRoot([
        createParagraph([createText(`前${tableMarker(7)}后`)]),
        createParagraph([createText(tableMarker(8))]),
        { type: 'paragraph', children: [{ type: 'image', url: 'a.png', alt: `图${tableMarker(9)}`, title: tableMarker(9) }] },
        createParagraph([{ type: 'inlineCode', value: `code${tableMarker(9)}` }]),
    ]);
    const snapshot = JSON.stringify(ir);

    // Act
    const { ir: cleaned, warnings } = restoreTableGrids(ir, new Map());

    // Assert
    assertNoMarker(cleaned, '兜底清理');
    assert.equal(cleaned.children[0].children[0].value, '前后');
    assert.deepEqual(cleaned.children[1].children, [], '只剩标记的文本节点被移除');
    assert.equal(cleaned.children[2].children[0].alt, '图');
    assert.equal(cleaned.children[2].children[0].title, '');
    assert.equal(cleaned.children[3].children[0].value, 'code');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /表格标记有残留/);
    assert.equal(JSON.stringify(ir), snapshot, '不改动入参');
});

test('兜底清理：无标记可剥也无残留时原样返回同一引用且无 warning', () => {
    // Arrange
    const ir = createRoot([createTable(null, [createTableRow([createTableCell('甲')])])]);

    // Act
    const { ir: cleaned, warnings } = restoreTableGrids(ir, new Map());

    // Assert
    assert.equal(cleaned, ir);
    assert.deepEqual(warnings, []);
});

test('回收：标记取到的号没有对应 grid 时只剥标记，不挂 data.grid', () => {
    // Arrange
    const ir = createRoot([createTable(null, [
        createTableRow([createTableCell(`${tableMarker(5)}甲`)]),
    ])]);

    // Act
    const { ir: restored, warnings } = restoreTableGrids(ir, new Map([[1, { rows: [] }]]));

    // Assert
    const [table] = findTables(restored);
    assert.equal(table.data, undefined);
    assert.equal(table.children[0].children[0].children[0].value, '甲');
    assert.deepEqual(warnings, [], '标记被正常取走，不算残留');
});

// ============================================================
// 端到端：合成 docx
// ============================================================

test('端到端：合成 docx 的横向与纵向合并、单元格内多段与行内格式都进入 table.data.grid', async () => {
    // Arrange / Act
    const doc = await parse({ buffer: await buildTableSample() }, { sourceName: 'table-sample.docx' });
    const tables = findTables(doc.ir);

    // Assert
    assert.equal(tables.length, 2);
    const grid = tables[0].data.grid;
    assert.deepEqual(grid.rows.map((row) => row.header), [true, false, false]);
    assert.deepEqual(grid.rows.map((row) => row.cells.map((cell) => [cell.colspan, cell.rowspan])), [
        [[2, 1], [1, 1]], [[2, 1], [1, 2]], [[1, 1], [1, 1]],
    ]);
    const cell = grid.rows[2].cells[0];
    assert.deepEqual(cell.paragraphs.map(textOf), ['普通', INLINE_TEXTS.plain]);
    assert.deepEqual(cell.paragraphs[1].slice(1).map((node) => node.type), [
        'strong', 'emphasis', 'underline', 'superscript', 'subscript',
    ]);
    assert.equal(tables[1].data.grid.rows.length, 1, '第二张表也拿到自己的 grid');
    assertNoMarker(doc.ir, '端到端');
    assert.deepEqual(doc.warnings, []);
});

test('端到端：md 产物不含标记，表格输出与引入 grid 之前一致', async () => {
    // Arrange
    const doc = await parse({ buffer: await buildTableSample() }, { sourceName: 'table-sample.docx' });

    // Act
    const markdown = await mdRenderer.render(doc);

    // Assert
    assert.ok(!MARKER_RE.test(markdown), 'md 产物不应出现表格标记');
    assert.equal(markdown, [
        '前言',
        '',
        '| 表头甲         | 表头乙  |',
        '| ----------- | ---- |',
        '| 横合并         | 纵合并起 |',
        '| 普通第二段 粗斜下上标 | 丙    |',
        '',
        '| 甲 | 乙 |',
        '| - | - |',
        '',
        '结尾',
        '',
    ].join('\n'));
});

// ============================================================
// 孤立代理项：parse5 7.3.0 遇到「低位代理项后紧跟低位代理项」抛 RangeError: Invalid code point
// ============================================================

/** 代理项与替换字符以码点生成，源码不出现孤立代理项的字面量或转义序列 */
const LOW_SURROGATE = String.fromCharCode(0xDC00);
const REPLACEMENT = String.fromCharCode(0xFFFD);

test('grid：单元格文字含相邻两个低位代理项时不抛错，grid 里各换成 U+FFFD', () => {
    // Arrange：mammoth 的输出可含孤立代理项（xmldom 0.8 把 document.xml 的 &#xDC00; 原样解码），parse5 载入即抛错
    const html = `<table><tr><td>甲${LOW_SURROGATE}${LOW_SURROGATE}乙</td><td>丁</td></tr></table>`;

    // Act
    const collected = collectTableGrids(html);

    // Assert
    const cells = cellsOf(collected.grids.get(1), 0);
    assert.deepEqual(cells[0].paragraphs.map(textOf), [`甲${REPLACEMENT}${REPLACEMENT}乙`]);
    assert.deepEqual(cells[1].paragraphs.map(textOf), ['丁']);
    assert.ok(MARKER_RE.test(collected.html), '标记照常注入');
    assert.deepEqual(collected.warnings, []);
});

test('端到端：document.xml 的表格单元格以字符引用写入两个低位代理项时，parsers/docx 不抛错且该格进入 grid', async () => {
    // Arrange：取表格夹具，把「丙」所在单元格改写为「丙&#xDC00;&#xDC00;」
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(await buildTableSample());
    const xml = await zip.file('word/document.xml').async('string');
    assert.equal(xml.split('>丙<').length, 2, '夹具里「丙」须恰好出现一次');
    zip.file('word/document.xml', xml.replace('>丙<', '>丙&#xDC00;&#xDC00;<'));
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    // Act
    const doc = await parse({ buffer }, { sourceName: 'table-sample.docx' });

    // Assert
    const tables = findTables(doc.ir);
    assert.equal(tables.length, 2);
    assert.deepEqual(tables[0].data.grid.rows[2].cells[1].paragraphs.map(textOf), [`丙${REPLACEMENT}${REPLACEMENT}`]);
    assert.equal(tables[1].data.grid.rows.length, 1, '第二张表也拿到自己的 grid');
    assertNoMarker(doc.ir, '孤立代理项端到端');
});
