/**
 * converters/parsers/xlsx.js 单元测试
 * 覆盖：{ path } 契约、多 sheet → sheetSection + table、单元格取值规则（公式/日期/富文本）、
 *       kind/meta/data 快照、assets 为空
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { parse } = require('../converters/parsers/xlsx');

// ============================================================
// 测试夹具：用 exceljs 现场生成两个 sheet 的工作簿
// ============================================================

async function makeWorkbookFile(fileName = '季度数据.xlsx') {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-xlsx-parser-')));
    const filePath = path.join(dir, fileName);

    const wb = new ExcelJS.Workbook();

    const s1 = wb.addWorksheet('销售');
    s1.addRow(['地区', '金额', '备注']);
    s1.addRow(['华东', 120, '达标']);
    s1.addRow(['华南', 80]); // 故意缺列，验证补齐

    const s2 = wb.addWorksheet('汇总');
    s2.addRow(['指标', '值']);
    s2.addRow(['合计', { formula: 'SUM(销售!B2:B3)', result: 200 }]);
    s2.addRow(['日期', new Date(Date.UTC(2026, 0, 2, 3, 4, 5))]);
    s2.addRow(['富文本', { richText: [{ text: '加' }, { text: '粗' }] }]);

    await wb.xlsx.writeFile(filePath);
    return { dir, filePath };
}

// ============================================================
// IR 遍历辅助
// ============================================================

function collect(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) {
        for (const child of node.children) collect(child, predicate, out);
    }
    return out;
}

function plainText(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text' || node.type === 'inlineCode') return String(node.value || '');
    if (!Array.isArray(node.children)) return '';
    return node.children.map(plainText).join('');
}

function rowTexts(table) {
    return collect(table, (n) => n.type === 'tableRow').map((row) =>
        collect(row, (n) => n.type === 'tableCell').map(plainText),
    );
}

// ============================================================
// 用例
// ============================================================

test('两个 sheet 各产出一个 sheetSection 与一个 table', async () => {
    // Arrange
    const { filePath } = await makeWorkbookFile();

    // Act
    const doc = await parse({ path: filePath });

    // Assert
    const sections = collect(doc.ir, (n) => n.type === 'sheetSection');
    assert.equal(sections.length, 2);
    assert.deepEqual(
        sections.map((s) => s.data.name),
        ['销售', '汇总'],
    );
    assert.deepEqual(
        sections.map((s) => s.data.index),
        [0, 1],
    );

    const tables = collect(doc.ir, (n) => n.type === 'table');
    assert.equal(tables.length, 2);
    assert.deepEqual(rowTexts(tables[0]), [
        ['地区', '金额', '备注'],
        ['华东', '120', '达标'],
        ['华南', '80', ''], // 缺列被补齐为空串
    ]);
});

test('kind 为 workbook，data.sheets 保留两个 sheet 快照', async () => {
    // Arrange
    const { filePath } = await makeWorkbookFile();

    // Act
    const doc = await parse({ path: filePath });

    // Assert
    assert.equal(doc.kind, 'workbook');
    assert.equal(doc.data.sheets.length, 2);
    assert.deepEqual(
        doc.data.sheets.map((s) => s.name),
        ['销售', '汇总'],
    );
    assert.equal(doc.data.sheets[0].rowCount, 3);
    assert.equal(doc.data.sheets[0].columnCount, 3);
    assert.deepEqual(doc.assets, []);
    assert.deepEqual(doc.warnings, []);
});

test('单元格取值：公式取 result、日期归一化、富文本拼接', async () => {
    // Arrange
    const { filePath } = await makeWorkbookFile();

    // Act
    const doc = await parse({ path: filePath });
    const summary = doc.data.sheets[1];

    // Assert
    assert.deepEqual(summary.rows[1], ['合计', '200']);
    assert.deepEqual(summary.rows[2], ['日期', '2026-01-02 03:04:05']);
    assert.deepEqual(summary.rows[3], ['富文本', '加粗']);
});

test('meta：title 取去扩展名的文件名，sheetCount 与 sheet 数一致', async () => {
    // Arrange
    const { filePath } = await makeWorkbookFile();

    // Act
    const doc = await parse({ path: filePath });

    // Assert
    assert.equal(doc.meta.title, '季度数据');
    assert.equal(doc.meta.sourceType, 'xlsx');
    assert.equal(doc.meta.sourceName, '季度数据.xlsx');
    assert.equal(doc.meta.sheetCount, 2);
});

test('ctx.sourceName 覆盖文件名', async () => {
    // Arrange
    const { filePath } = await makeWorkbookFile('tmp-upload-1234.xlsx');

    // Act
    const doc = await parse({ path: filePath }, { sourceName: '原始报表.xlsx' });

    // Assert
    assert.equal(doc.meta.sourceName, '原始报表.xlsx');
    assert.equal(doc.meta.title, '原始报表');
});

test('缺少 input.path 时抛出中文错误', async () => {
    // Arrange & Act & Assert
    await assert.rejects(() => parse({}), /parsers\/xlsx 需要 input\.path/);
});

test('源文件不存在时抛出 ENOENT', async () => {
    // Arrange
    const missing = path.join(os.tmpdir(), 'markflow-not-exist-xyz.xlsx');

    // Act & Assert
    await assert.rejects(() => parse({ path: missing }), (err) => err.code === 'ENOENT');
});
