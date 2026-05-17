/**
 * XLSX → IR
 *
 * 用 exceljs 读取 workbook。每个 sheet 在 IR 里：
 *   - 先输出一个 sheetSection 扩展节点（带 sheet 名）
 *   - 再输出一个 table 节点（行/列还原为 markdown 表格）
 *
 * data 字段同时保留 sheets 数组快照（{name, rows:[[...]]}），
 * 便于 JSON 输出与回灌。
 *
 * P1 简化：
 *   - 不处理合并单元格（merged cells 输出为分散数据）
 *   - 公式取 result 值（不重算）
 *   - 富文本只取 text 字段
 */
const path = require('path');
const {
    createDocument,
    createRoot,
    createSheetSection,
    createTable,
    createTableRow,
    createTableCell,
    createText,
} = require('../ir/schema');

let ExcelJS = null;
function loadExcelJS() {
    if (!ExcelJS) ExcelJS = require('exceljs');
    return ExcelJS;
}

async function parse(buffer, meta = {}) {
    if (!Buffer.isBuffer(buffer)) {
        throw new Error('parsers/xlsx 期望 source 为 Buffer');
    }

    const Excel = loadExcelJS();
    const wb = new Excel.Workbook();
    await wb.xlsx.load(buffer);

    const sheetsData = [];
    const ir = createRoot();
    let sheetIdx = 0;

    wb.eachSheet((ws) => {
        const rows = [];
        ws.eachRow({ includeEmpty: false }, (row) => {
            // row.values 是 sparse 数组 [undefined, v1, v2, ...]
            const values = (row.values || []).slice(1).map(formatCell);
            rows.push(values);
        });

        sheetsData.push({
            name: ws.name,
            rowCount: rows.length,
            columnCount: rows.reduce((m, r) => Math.max(m, r.length), 0),
            rows,
        });

        // IR：每 sheet 一个 sheetSection
        ir.children.push(createSheetSection({ name: ws.name, index: sheetIdx }));

        if (rows.length > 0) {
            const colCount = sheetsData[sheetsData.length - 1].columnCount;
            const tableRows = rows.map((rowVals) => {
                // 补齐列数
                const padded = [...rowVals];
                while (padded.length < colCount) padded.push('');
                return createTableRow(
                    padded.map((v) =>
                        createTableCell([createText(String(v ?? ''))]),
                    ),
                );
            });
            ir.children.push(createTable(null, tableRows));
        }

        sheetIdx++;
    });

    const title =
        (wb.creator && `${stripExt(meta.sourceName)}` || '') ||
        stripExt(meta.sourceName) ||
        '未命名表格';

    return createDocument({
        kind: 'spreadsheet',
        ir,
        data: { sheets: sheetsData },
        meta: {
            sourceType: 'xlsx',
            title,
            sheetCount: sheetsData.length,
            ...meta,
        },
    });
}

function formatCell(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
    if (typeof v === 'object') {
        // exceljs: RichText { richText: [...] }
        if (Array.isArray(v.richText)) {
            return v.richText.map((r) => r.text || '').join('');
        }
        // exceljs: Formula { formula, result }
        if (v.result !== undefined) return v.result === null ? '' : String(v.result);
        // exceljs: Hyperlink { text, hyperlink }
        if (v.text !== undefined) return v.text;
        // exceljs: Error { error }
        if (v.error) return `#${v.error}`;
        return JSON.stringify(v);
    }
    return v;
}

function stripExt(name) {
    if (!name) return '';
    return path.basename(name, path.extname(name));
}

module.exports = { parse };
