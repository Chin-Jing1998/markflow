/**
 * IR → XLSX (Buffer)
 *
 * 优先策略：用 doc.data.sheets（来自 xlsx parser 的快照）直接还原工作簿，
 *   保证 XLSX → XLSX 高保真。
 * 兜底策略：扫描 mdast，把 sheetSection + 紧随的 table 节点配对成 sheet；
 *   找不到 sheetSection 但有 table 时全部塞到 Sheet1；
 *   无表格时把所有标题/段落转为 Sheet1 第一列。
 */

const ExcelJS = require('exceljs');
const { downgradeCustomNodes } = require('../ir/schema');

async function render(doc) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'MarkFlow';
    wb.created = new Date();

    // 路径 A：使用 data 快照
    const dataSheets =
        doc.data && Array.isArray(doc.data.sheets) ? doc.data.sheets : null;
    if (dataSheets && dataSheets.length > 0) {
        for (let i = 0; i < dataSheets.length; i++) {
            const s = dataSheets[i];
            const ws = wb.addWorksheet(sanitizeSheetName(s.name, i));
            for (const row of s.rows || []) {
                ws.addRow(row);
            }
            if (s.rows && s.rows.length > 0) ws.getRow(1).font = { bold: true };
        }
    } else {
        // 路径 B：mdast 提取（先降级扩展节点为标准 mdast 以方便处理）
        const ir = doc.ir; // 这里不降级 sheetSection（我们要用它）
        const sheets = extractSheetsFromIR(ir);
        if (sheets.length > 0) {
            for (let i = 0; i < sheets.length; i++) {
                const s = sheets[i];
                const ws = wb.addWorksheet(sanitizeSheetName(s.name, i));
                for (const row of s.rows) {
                    ws.addRow(row);
                }
                if (s.rows.length > 0) ws.getRow(1).font = { bold: true };
            }
        } else {
            // 兜底：所有文本作第一列
            const ws = wb.addWorksheet('Sheet1');
            const lines = mdastToLines(downgradeCustomNodes(ir));
            for (const line of lines) {
                ws.addRow([line]);
            }
        }
    }

    const ab = await wb.xlsx.writeBuffer();
    return Buffer.isBuffer(ab) ? ab : Buffer.from(ab);
}

function extractSheetsFromIR(ir) {
    const sheets = [];
    let currentSheet = null;

    for (const node of (ir && ir.children) || []) {
        if (node.type === 'sheetSection') {
            currentSheet = {
                name: (node.data && node.data.name) || `Sheet${sheets.length + 1}`,
                rows: [],
            };
            sheets.push(currentSheet);
        } else if (node.type === 'table') {
            const rows = (node.children || []).map((tr) =>
                (tr.children || []).map((td) => collectText(td)),
            );
            if (!currentSheet) {
                currentSheet = { name: 'Sheet1', rows: [] };
                sheets.push(currentSheet);
            }
            currentSheet.rows.push(...rows);
        }
    }

    return sheets;
}

function mdastToLines(node, lines = []) {
    if (!node) return lines;
    if (node.type === 'heading' || node.type === 'paragraph') {
        const t = collectText(node);
        if (t && t.trim()) lines.push(t.trim());
        return lines;
    }
    if (Array.isArray(node.children)) {
        for (const c of node.children) mdastToLines(c, lines);
    }
    return lines;
}

function collectText(node) {
    if (!node) return '';
    if (node.value !== undefined) return String(node.value);
    if (Array.isArray(node.children)) {
        return node.children.map(collectText).join('');
    }
    return '';
}

// Excel sheet 名长度 ≤ 31 且不能含 \ / ? * [ ]
function sanitizeSheetName(name, idx) {
    const fallback = `Sheet${idx + 1}`;
    if (!name) return fallback;
    let s = String(name).replace(/[\\/?*\[\]:]/g, '_').slice(0, 31);
    return s.trim() || fallback;
}

module.exports = { render };
