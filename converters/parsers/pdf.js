/**
 * PDF → IR
 *
 * 契约：parse({ path }, ctx) → MarkFlowDocument，按绝对路径读取、不写盘。
 *
 * 用 pdfjs-dist 的 legacy ESM build（pdf.mjs，无 worker，Node 友好）：
 *   - 逐页 getTextContent() 拿文字块
 *   - 按 y 坐标分组成行（容差 2px），同行按 x 排
 *   - 行间字号阈值（基于全文档字号中位数 × 1.4）识别可能的小标题，输出 H3
 *   - 多页时每页前插入 H2 "第 N 页" 便于结构化
 *
 * 不做图片提取与表格识别（pdfjs operatorList 解析复杂度高），assets 恒为空数组。
 * data 只保留页数等轻量元信息，不再快照整页文本 —— 否则 JSON 输出体积翻倍。
 */
const fsp = require('fs').promises;
const path = require('path');
const {
    createDocument,
    createRoot,
    createHeading,
    createParagraph,
} = require('../ir/schema');
const { stripExt } = require('../ir/util');

/** 行分组的 y 坐标容差（PDF 用户空间单位） */
const LINE_Y_TOLERANCE = 2;
/** 小标题判定：字号 ≥ 全文中位数 × 该系数 */
const HEADING_FONT_RATIO = 1.4;
/** 小标题判定：文本长度上限（过长的大字号行按正文处理） */
const HEADING_MAX_LENGTH = 80;

let pdfjsLib = null;

/** 加载 pdfjs legacy ESM build 并缓存（该包 4.x 起只发布 .mjs） */
async function loadPdfjs() {
    if (pdfjsLib) return pdfjsLib;
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjsLib = mod.default || mod;
    return pdfjsLib;
}

/**
 * @param {{ path: string }} input 源文件绝对路径
 * @param {{ sourceName?: string, onProgress?: Function }} [ctx]
 */
async function parse(input, ctx = {}) {
    const absPath = resolveInputPath(input);
    const sourceName = ctx.sourceName || path.basename(absPath);

    const buffer = await fsp.readFile(absPath);
    const pdfjs = await loadPdfjs();

    const loadingTask = pdfjs.getDocument({
        data: new Uint8Array(buffer),
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
        const lineRecords = lines
            .map((line) => {
                const text = line.map((it) => it.str).join('').trim();
                const avgSize =
                    line.reduce((sum, it) => sum + Math.abs(it.transform[0]), 0) /
                    Math.max(line.length, 1);
                allFontSizes.push(avgSize);
                return { text, fontSize: avgSize };
            })
            .filter((r) => r.text);
        pagesData.push({ pageNum: i, lines: lineRecords });
        notify(ctx, 'parse', Math.round((i / numPages) * 100));
    }

    // 字号阈值：中位数 × 1.4
    const headingFontSizeThreshold = computeMedian(allFontSizes) * HEADING_FONT_RATIO;

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
                line.text.length < HEADING_MAX_LENGTH
            ) {
                ir.children.push(createHeading(3, line.text));
            } else {
                ir.children.push(createParagraph(line.text));
            }
        }
    }

    // PDF 内嵌元数据（无则回退文件名）
    let pdfMeta = null;
    try {
        const m = await pdf.getMetadata();
        pdfMeta = m && m.info ? m.info : null;
    } catch (e) {
        pdfMeta = null;
    }

    const embeddedTitle = pdfMeta && (pdfMeta.Title || pdfMeta.title);
    const title = (embeddedTitle && String(embeddedTitle).trim()) || stripExt(sourceName);

    return createDocument({
        kind: 'document',
        ir,
        data: {
            numPages,
            pageLineCounts: pagesData.map((p) => p.lines.length),
            metadata: pdfMeta,
        },
        meta: { title, sourceType: 'pdf', sourceName },
        assets: [],
        warnings: [],
    });
}

// ============================================================
// 输入与文本处理
// ============================================================

function resolveInputPath(input) {
    if (input && typeof input.path === 'string' && input.path) {
        return path.resolve(input.path);
    }
    throw new Error('parsers/pdf 需要 input.path（文件绝对路径）');
}

// 按 y 坐标分组成行（PDF 坐标系：y 大的在上方）
function groupByLine(items, tolerance = LINE_Y_TOLERANCE) {
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

// 进度回调异常不得影响解析
function notify(ctx, phase, pct) {
    if (!ctx || typeof ctx.onProgress !== 'function') return;
    try {
        ctx.onProgress(phase, pct);
    } catch (err) {
        // 忽略调用方回调自身的异常
    }
}

module.exports = { parse };
