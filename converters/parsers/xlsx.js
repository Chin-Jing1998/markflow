/**
 * XLSX → IR
 *
 * 契约：parse({ path }, ctx) → MarkFlowDocument，按绝对路径读取、不写盘。
 *
 * 用 exceljs 的 readFile 直读磁盘。每个 sheet 在 IR 里：
 *   - 先输出一个 sheetSection 扩展节点（带 sheet 名）
 *   - 再输出一个 table 节点（行/列还原为 markdown 表格）
 *
 * data 字段同时保留 sheets 数组快照（{name, rows:[[...]]}），
 * 便于 JSON 输出与 XLSX 反向写。
 *
 * 简化约定：
 *   - 不处理合并单元格（merged cells 输出为分散数据）
 *   - 公式取 result 值（不重算）
 *   - 富文本只取 text 字段
 *   - 不提取内嵌图片，assets 恒为空数组
 */
const fsp = require('fs').promises;
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
const { stripExt } = require('../ir/util');
const { notify } = require('../util');

// 进度百分比区间：parser 只报 parsing 阶段，按已解析 sheet 比例映射到该区间
const PROGRESS_MIN = 20;
const PROGRESS_MAX = 55;

let ExcelJS = null;
function loadExcelJS() {
    if (!ExcelJS) ExcelJS = require('exceljs');
    return ExcelJS;
}

/**
 * @param {{ path: string }} input 源文件绝对路径
 * @param {{ sourceName?: string, onProgress?: Function }} [ctx]
 */
async function parse(input, ctx = {}) {
    const absPath = resolveInputPath(input);
    const sourceName = ctx.sourceName || path.basename(absPath);

    // exceljs 的 readFile 不校验存在性错误信息，先自行探一次给出可读提示
    await fsp.access(absPath);

    const Excel = loadExcelJS();
    const wb = new Excel.Workbook();
    await wb.xlsx.readFile(absPath);

    const sheetsData = [];
    const ir = createRoot();
    const sheetTotal = Math.max(wb.worksheets.length, 1);
    let sheetIdx = 0;

    wb.eachSheet((ws) => {
        const rows = [];
        ws.eachRow({ includeEmpty: false }, (row) => {
            // row.values 是 sparse 数组 [undefined, v1, v2, ...]
            const values = (row.values || []).slice(1).map(formatCell);
            rows.push(values);
        });

        const columnCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
        sheetsData.push({
            name: ws.name,
            rowCount: rows.length,
            columnCount,
            rows,
        });

        // IR：每 sheet 一个 sheetSection
        ir.children.push(createSheetSection({ name: ws.name, index: sheetIdx }));

        if (rows.length > 0) {
            const tableRows = rows.map((rowVals) => {
                // 补齐列数，保证表格矩形
                const padded = [...rowVals];
                while (padded.length < columnCount) padded.push('');
                return createTableRow(
                    padded.map((v) => createTableCell([createText(String(v ?? ''))])),
                );
            });
            ir.children.push(createTable(null, tableRows));
        }

        sheetIdx++;
        notify(ctx, 'parsing', PROGRESS_MIN + Math.round((sheetIdx / sheetTotal) * (PROGRESS_MAX - PROGRESS_MIN)));
    });

    return createDocument({
        kind: 'workbook',
        ir,
        data: { sheets: sheetsData },
        meta: {
            title: stripExt(sourceName),
            sourceType: 'xlsx',
            sourceName,
            sheetCount: sheetsData.length,
        },
        assets: [],
        warnings: [],
    });
}

// ============================================================
// 工具
// ============================================================

function resolveInputPath(input) {
    if (input && typeof input.path === 'string' && input.path) {
        return path.resolve(input.path);
    }
    throw new Error('parsers/xlsx 需要 input.path（文件绝对路径）');
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

// 进度回调异常不得影响解析

module.exports = { parse };
