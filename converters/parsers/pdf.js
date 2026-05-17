/**
 * PDF → IR
 *
 * 用 pdfjs-dist 的 legacy build（CJS、无 worker，Node 同步友好）：
 *   - 逐页 getTextContent() 拿文字块
 *   - 按 y 坐标分组成行（容差 2px），同行按 x 排
 *   - 行间字号阈值（基于全文档字号中位数 × 1.4）识别可能的小标题，输出 H3
 *   - 多页时每页前插入 H2 "第 N 页" 便于结构化
 *   - data 字段保留每页原始行数据快照，方便 JSON 输出
 *
 * P1 不做图片提取与表格识别（pdfjs operatorList 解析复杂度高，推 P2/P3）。
 */
const path = require('path');
const {
    createDocument,
    createRoot,
    createHeading,
    createParagraph,
} = require('../ir/schema');

let pdfjsLib = null;
async function loadPdfjs() {
    if (pdfjsLib) return pdfjsLib;
    try {
        pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    } catch (e) {
        const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
        pdfjsLib = mod.default || mod;
    }
    return pdfjsLib;
}

async function parse(buffer, meta = {}) {
    if (!Buffer.isBuffer(buffer)) {
        throw new Error('parsers/pdf 期望 source 为 Buffer');
    }

    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(buffer);

    const loadingTask = pdfjs.getDocument({
        data,
        disableFontFace: true,
        useSystemFonts: true,
    });
    const pdf = await loadingTask.promise;

    const numPages = pdf.numPages;
    const pagesData = [];
    const allFontSizes = [];

    // 第一遍：收集每页行 + 字号样本
    for (let i = 1; i <= numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const lines = groupByLine(textContent.items);
        const lineRecords = lines.map((line) => {
            const text = line.map((it) => it.str).join('').trim();
            const avgSize =
                line.reduce((sum, it) => sum + Math.abs(it.transform[0]), 0) /
                Math.max(line.length, 1);
            allFontSizes.push(avgSize);
            return { text, fontSize: avgSize };
        }).filter((r) => r.text);
        pagesData.push({ pageNum: i, lines: lineRecords });
    }

    // 字号阈值：中位数 × 1.4
    const headingFontSizeThreshold = computeMedian(allFontSizes) * 1.4;

    // 构建 IR
    const ir = createRoot();
    for (const page of pagesData) {
        if (numPages > 1) {
            ir.children.push(createHeading(2, `第 ${page.pageNum} 页`));
        }
        for (const line of page.lines) {
            if (
                headingFontSizeThreshold > 0 &&
                line.fontSize >= headingFontSizeThreshold &&
                line.text.length < 80
            ) {
                ir.children.push(createHeading(3, line.text));
            } else {
                ir.children.push(createParagraph(line.text));
            }
        }
    }

    // 元数据
    let pdfMeta = null;
    try {
        const m = await pdf.getMetadata();
        pdfMeta = m && m.info ? m.info : null;
    } catch (e) {
        pdfMeta = null;
    }

    const title =
        (pdfMeta && (pdfMeta.Title || pdfMeta.title)) ||
        firstHeadingText(ir) ||
        stripExt(meta.sourceName) ||
        '未命名PDF';

    return createDocument({
        kind: 'document',
        ir,
        data: {
            numPages,
            pages: pagesData,
            metadata: pdfMeta,
        },
        meta: {
            sourceType: 'pdf',
            title,
            ...meta,
        },
    });
}

// 按 y 坐标分组成行（PDF 坐标系：y 大的在上方）
function groupByLine(items, tolerance = 2) {
    const sorted = [...items].sort((a, b) => {
        const ya = a.transform[5];
        const yb = b.transform[5];
        if (Math.abs(ya - yb) > tolerance) return yb - ya;
        return a.transform[4] - b.transform[4];
    });

    const lines = [];
    let currentLine = [];
    let currentY = null;
    for (const item of sorted) {
        if (!item.str) continue;
        const y = item.transform[5];
        if (currentY === null || Math.abs(y - currentY) <= tolerance) {
            currentLine.push(item);
            currentY = y;
        } else {
            if (currentLine.length) lines.push(currentLine);
            currentLine = [item];
            currentY = y;
        }
    }
    if (currentLine.length) lines.push(currentLine);
    return lines;
}

function computeMedian(nums) {
    if (!nums || nums.length === 0) return 0;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function firstHeadingText(ir) {
    const h = (ir.children || []).find((c) => c.type === 'heading');
    if (!h || !Array.isArray(h.children)) return null;
    return h.children.map((c) => c.value || '').join('').trim() || null;
}

function stripExt(name) {
    if (!name) return '';
    return path.basename(name, path.extname(name));
}

module.exports = { parse };
