/**
 * PDF → IR
 *
 * 契约：parse({ path }, ctx) → MarkFlowDocument，按绝对路径读取、不写盘。
 *
 * 用 pdfjs-dist 的 legacy ESM build（pdf.mjs，无 worker，Node 友好）：逐页 getTextContent()
 * 拿文字块，按 y 坐标分桶成行（桶宽 2px、桶内按 x 排），行间以字号阈值（全文档非空行字号
 * 中位数 × 1.4）识别可能的小标题输出 H3，多页时每页前插入 H2 "第 N 页" 便于结构化。
 * 解析结束后销毁 loadingTask，释放 pdfjs 持有的解析缓存。
 *
 * 不做图片提取与表格识别（pdfjs operatorList 解析复杂度高），assets 恒为空数组。
 * data 只保留页数等轻量元信息，不再快照整页文本 —— 否则 JSON 输出体积翻倍。
 */
const fsp = require('fs').promises;
const path = require('path');
const { createDocument, createRoot, createHeading, createParagraph } = require('../ir/schema');
const { stripExt } = require('../ir/util');
const { notify } = require('../util');

/** 行分组的 y 坐标容差（PDF 用户空间单位） */
const LINE_Y_TOLERANCE = 2;
/** 小标题判定：字号 ≥ 全文中位数 × 该系数，且文本长度小于该上限 */
const HEADING_FONT_RATIO = 1.4;
const HEADING_MAX_LENGTH = 80;
// 进度百分比区间：parser 只报 parsing 阶段，按已解析页数比例映射到该区间
const PROGRESS_MIN = 20;
const PROGRESS_MAX = 55;

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
    if (!input || typeof input.path !== 'string' || !input.path) {
        throw new Error('parsers/pdf 需要 input.path（文件绝对路径）');
    }
    const absPath = path.resolve(input.path);
    const sourceName = ctx.sourceName || path.basename(absPath);

    const buffer = await fsp.readFile(absPath);
    const pdfjs = await loadPdfjs();
    const loadingTask = pdfjs.getDocument({
        data: new Uint8Array(buffer),
        disableFontFace: true,
        useSystemFonts: true,
    });
    try {
        return await buildDocument(await loadingTask.promise, { sourceName, ctx });
    } finally {
        // 不释放的话 pdfjs 会把整份文档的解析缓存留在内存里，批量转换时逐份累积
        await loadingTask.destroy().catch(() => {});
    }
}

/** 逐页取文本 → 行 → IR；与文档生命周期解耦，便于在 finally 里统一释放 loadingTask */
async function buildDocument(pdf, { sourceName, ctx }) {
    const numPages = pdf.numPages;
    const pagesData = [];
    const allFontSizes = [];

    // 第一遍：收集每页行 + 字号样本
    for (let i = 1; i <= numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const lines = groupByLine(textContent.items)
            .map((line) => {
                const text = line.map((it) => it.str).join('').trim();
                const avgSize = line.reduce((sum, it) => sum + Math.abs(it.transform[0]), 0)
                    / Math.max(line.length, 1);
                return { text, fontSize: avgSize };
            })
            .filter((r) => r.text);
        // 空行的字号不参与中位数，否则空白行会把阈值拉偏
        for (const line of lines) allFontSizes.push(line.fontSize);
        pagesData.push({ pageNum: i, lines });
        notify(ctx, 'parsing', PROGRESS_MIN + Math.round((i / numPages) * (PROGRESS_MAX - PROGRESS_MIN)));
    }

    // 第二遍：按字号阈值（中位数 × 1.4）区分小标题与正文，构建 IR
    const headingFontSizeThreshold = computeMedian(allFontSizes) * HEADING_FONT_RATIO;
    const isHeading = (line) => headingFontSizeThreshold > 0
        && line.fontSize >= headingFontSizeThreshold
        && line.text.length < HEADING_MAX_LENGTH;

    const ir = createRoot();
    for (const page of pagesData) {
        if (numPages > 1) ir.children.push(createHeading(2, `第 ${page.pageNum} 页`));
        for (const line of page.lines) {
            ir.children.push(isHeading(line) ? createHeading(3, line.text) : createParagraph(line.text));
        }
    }

    // PDF 内嵌元数据（读取失败或缺失时回退文件名）
    const pdfMeta = await Promise.resolve()
        .then(() => pdf.getMetadata())
        .then((m) => (m && m.info) || null, () => null);
    const embeddedTitle = pdfMeta && (pdfMeta.Title || pdfMeta.title);

    return createDocument({
        kind: 'document',
        ir,
        data: { numPages, pageLineCounts: pagesData.map((p) => p.lines.length), metadata: pdfMeta },
        meta: {
            title: (embeddedTitle && String(embeddedTitle).trim()) || stripExt(sourceName),
            sourceType: 'pdf',
            sourceName,
        },
        assets: [],
        warnings: [],
    });
}

/**
 * 按 y 坐标分桶成行（PDF 坐标系：y 大的在上方），桶内按 x 升序。
 * 不用「相邻比较 + 容差」的比较器排序：那种比较器不满足传递性（a≈b、b≈c 但 a≢c），
 * 排序结果依赖实现细节，会把同页文字排乱。先按 round(y / tolerance) 分桶即可保证稳定。
 */
function groupByLine(items, tolerance = LINE_Y_TOLERANCE) {
    const buckets = new Map();
    for (const item of items) {
        if (!item.str) continue;
        const key = Math.round(item.transform[5] / tolerance);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(item);
    }
    return [...buckets.keys()]
        .sort((a, b) => b - a)
        .map((key) => buckets.get(key).sort((a, b) => a.transform[4] - b.transform[4]));
}

function computeMedian(nums) {
    if (!nums || nums.length === 0) return 0;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}


module.exports = { parse };
