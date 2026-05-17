/**
 * 转换调度器
 *
 * 输入约定（source 类型）：
 *   docx/pdf/xlsx/pptx/doc/xls/ppt → Buffer（文件二进制）
 *   url/text/md/html/json          → string
 *
 * 调用：
 *   convert({ inputType, outputFormat, source, name, options, outputDir, reportProgress })
 *   reportProgress(phase, pct, name?)  // 可选，用于 SSE 进度推送
 *
 * 返回（统一结构）：
 *   { format, content?, folderName, outputPath, title, imagesCount?, raw? }
 *     content 仅文本格式（md/html/json）携带，二进制（docx/pdf/xlsx/pptx）只返回 outputPath
 *     raw 是 legacy 通路的原始返回（旧端点适配层用）
 *
 * P0 能力矩阵（getCapabilities）：
 *   docx/url/text → md（走 legacy 快路径，零回归）
 *   md/html/json  ↔ md/html/json（通用 IR 路径）
 *   其他组合在 P1/P2 增量接入。
 */

const path = require('path');

// === Parser/Renderer 注册表 ===
const parsers = {
    md: require('./parsers/md'),
    html: require('./parsers/html'),
    json: require('./parsers/json'),
    docx: require('./parsers/docx'),
    url: require('./parsers/url'),
    text: require('./parsers/text'),
    pdf: require('./parsers/pdf'),
    xlsx: require('./parsers/xlsx'),
    pptx: require('./parsers/pptx'),
    doc: require('./parsers/doc'),
    xls: require('./parsers/xls'),
    ppt: require('./parsers/ppt'),
};

const renderers = {
    md: require('./renderers/md'),
    html: require('./renderers/html'),
    json: require('./renderers/json'),
    docx: require('./renderers/docx'),
    pdf: require('./renderers/pdf'),
    xlsx: require('./renderers/xlsx'),
    pptx: require('./renderers/pptx'),
};

// === Legacy 快路径（仅当 outputFormat=md 时启用，保证零回归） ===
const legacyConverters = {
    docx: require('./legacy/word'),
    url: require('./legacy/url'),
    text: require('./legacy/text'),
};

// === 能力矩阵（根据运行时能力动态生成） ===
// 注：xlsx / html / ppt(含 pptx) 相关转换已按用户要求从矩阵中移除
// 后端 parser/renderer 文件保留，将来可一行恢复
function getCapabilities({ sofficeAvailable = false, electronPrintToPdf = false } = {}) {
    const textOutputs = ['md', 'json', 'docx'];
    const documentOutputs = electronPrintToPdf ? [...textOutputs, 'pdf'] : textOutputs;
    const legacyBinaryOutputs = sofficeAvailable ? documentOutputs : [];

    return {
        capabilities: { sofficeAvailable, electronPrintToPdf },
        matrix: {
            // 文档类
            docx: documentOutputs,
            url: documentOutputs,
            text: documentOutputs,
            md: documentOutputs,
            json: documentOutputs,
            // PDF（输入只读）
            pdf: ['md', 'json'],
            // 旧二进制 DOC（依赖 soffice）；xls/ppt 已禁用
            doc: legacyBinaryOutputs,
            // ===== 以下输入类型已禁用（保留后端文件，矩阵置空让前端 chip 自然全部 disabled）=====
            html: [],
            xlsx: [],
            pptx: [],
            xls: [],
            ppt: [],
        },
    };
}

// === 主调度 ===
async function convert(params) {
    const {
        inputType,
        outputFormat,
        source,
        name,
        options = {},
        outputDir,
        reportProgress,
    } = params;

    if (!inputType) throw new Error('缺少 inputType');
    if (!outputFormat) throw new Error('缺少 outputFormat');
    if (source === undefined || source === null) throw new Error('缺少 source');
    if (!outputDir) throw new Error('缺少 outputDir');

    // 快路径：legacy converter（仅 outputFormat=md）
    if (outputFormat === 'md' && legacyConverters[inputType]) {
        return convertWithLegacy({ inputType, source, name, options, outputDir, reportProgress });
    }

    // 通用 IR 路径
    return convertWithIR({ inputType, outputFormat, source, name, options, outputDir, reportProgress });
}

async function convertWithLegacy({ inputType, source, name, options, outputDir, reportProgress }) {
    reportProgress && reportProgress('parsing', 20);
    const legacy = legacyConverters[inputType];
    let raw;
    if (inputType === 'docx') {
        raw = await legacy.convert(source, name, outputDir);
    } else if (inputType === 'url') {
        raw = await legacy.convert(source, outputDir);
    } else if (inputType === 'text') {
        raw = await legacy.convert(source, options.title, outputDir);
    } else {
        throw new Error(`legacy 不支持的 inputType: ${inputType}`);
    }
    reportProgress && reportProgress('writing', 100);
    return {
        format: 'md',
        content: raw.markdown,
        folderName: raw.folderName,
        outputPath: raw.mdPath,
        title: raw.title,
        imagesCount: raw.imagesCount || 0,
        raw,
    };
}

async function convertWithIR({ inputType, outputFormat, source, name, options, outputDir, reportProgress }) {
    const parser = parsers[inputType];
    if (!parser) {
        throw new Error(`暂不支持的输入类型: ${inputType}`);
    }
    const renderer = renderers[outputFormat];
    if (!renderer) {
        throw new Error(`暂不支持的输出格式: ${outputFormat}`);
    }

    reportProgress && reportProgress('parsing', 20);
    const doc = await parser.parse(source, {
        sourceName: name,
        outputDir,
        ...options,
    });

    reportProgress && reportProgress('rendering', 60);
    const content = await renderer.render(doc);

    reportProgress && reportProgress('writing', 80);

    // 写文件 —— folderName 优先用 parser 已经决定的（保证多格式共享一个目录）
    const { sanitizeFolderName, ensureOutputFolder, writeOutputFile } = require('./ir/util');
    const title =
        (doc.meta && doc.meta.title) ||
        extractTitleFromIR(doc.ir) ||
        stripExt(name) ||
        '未命名文档';
    const folderName =
        (doc.meta && doc.meta.folderName) || sanitizeFolderName(title);
    const { outputFolder } = ensureOutputFolder(outputDir, folderName, false);
    const outputPath = writeOutputFile(outputFolder, folderName, outputFormat, content);

    // 更新 meta.title 回灌
    if (doc.meta && !doc.meta.title) doc.meta.title = title;

    reportProgress && reportProgress('writing', 100);
    return {
        format: outputFormat,
        content: ['md', 'html', 'json'].includes(outputFormat) ? content : undefined,
        folderName,
        outputPath,
        title,
        imagesCount: 0,
    };
}

function extractTitleFromIR(ir) {
    if (!ir || !Array.isArray(ir.children)) return null;
    const h1 = ir.children.find((c) => c.type === 'heading' && c.depth === 1);
    if (!h1 || !Array.isArray(h1.children)) return null;
    return h1.children.map((c) => c.value || '').join('').trim() || null;
}

function stripExt(filename) {
    if (!filename) return '';
    return path.basename(filename, path.extname(filename));
}

module.exports = {
    convert,
    getCapabilities,
    // 暴露注册表方便扩展（P1/P2 直接 push 新 parser/renderer）
    _registry: { parsers, renderers, legacyConverters },
};
