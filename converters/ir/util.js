/**
 * IR 层公共工具
 * 源自 converters/legacy/{word,url,text}.js 的共享函数
 * 注意：legacy 三文件保持原状不改写（P0 零行为保证），本文件供新 parsers/renderers 使用
 */
const path = require('path');
const fs = require('fs');
const TurndownService = require('turndown');

// ============================================================
// 文件/文件夹名清洗
// ============================================================

function sanitizeFolderName(name, defaultName = '未命名文档') {
    return String(name || '')
        .replace(/^#+\s*/, '')
        .replace(/[<>:"/\\|?*#]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 100) || defaultName;
}

// multer 用 latin1 解析中文文件名，需要还原为 utf8（server.js:124 现有修复）
function decodeUtf8Filename(name) {
    return Buffer.from(name, 'latin1').toString('utf8');
}

// 根据 (outputDir, folderName) 创建输出文件夹 + images 子目录，返回路径
function ensureOutputFolder(outputDir, folderName, withImages = true) {
    const outputFolder = path.join(outputDir, folderName);
    const imagesFolder = path.join(outputFolder, 'images');
    if (withImages) {
        fs.mkdirSync(imagesFolder, { recursive: true });
    } else {
        fs.mkdirSync(outputFolder, { recursive: true });
    }
    return { outputFolder, imagesFolder };
}

// ============================================================
// 扩展名推断
// ============================================================

function getExtFromContentType(contentType) {
    const map = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/bmp': '.bmp',
        'image/svg+xml': '.svg',
        'image/webp': '.webp',
        'image/tiff': '.tiff',
        'image/x-emf': '.emf',
        'image/x-wmf': '.wmf',
        'image/emf': '.emf',
        'image/wmf': '.wmf',
    };
    return map[contentType] || '.png';
}

function getExtFromUrl(url) {
    try {
        const pathname = new URL(url).pathname;
        const ext = path.extname(pathname).toLowerCase().split('?')[0];
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'].includes(ext)) {
            return ext;
        }
    } catch (e) {}
    return '.jpg';
}

// ============================================================
// Turndown 工厂（三种风格对应三种来源）
// ============================================================

// 基础版：text.js 风格，无表格无图片处理
function createBasicTurndownService() {
    const service = new TurndownService({
        headingStyle: 'atx',
        hr: '---',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
        strongDelimiter: '**',
    });
    service.remove(['script', 'style', 'noscript']);
    return service;
}

// Word 风格：基础 + 表格转 Markdown + 移除空 img
function createWordTurndownService() {
    const service = createBasicTurndownService();

    service.addRule('table', {
        filter: 'table',
        replacement: (content, node) => convertTableToMarkdown(node),
    });

    service.addRule('emptyImg', {
        filter: (node) =>
            node.nodeName === 'IMG' &&
            (!node.getAttribute('src') || node.getAttribute('src') === ''),
        replacement: () => '',
    });

    return service;
}

// URL 风格：基础 + 内联样式识别 + figcaption + section 透传等（适配微信/知乎等）
function createRichTurndownService() {
    const service = new TurndownService({
        headingStyle: 'atx',
        hr: '---',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
        strongDelimiter: '**',
    });

    service.addRule('lineBreak', {
        filter: 'br',
        replacement: () => '\n',
    });

    service.addRule('inlineBold', {
        filter: (node) => {
            if (!['SPAN', 'P', 'SECTION'].includes(node.nodeName)) return false;
            const style = node.getAttribute('style') || '';
            return /font-weight\s*:\s*(bold|[6-9]\d{2}|1000)/i.test(style);
        },
        replacement: (c) => (c.trim() ? `**${c.trim()}**` : ''),
    });

    service.addRule('inlineItalic', {
        filter: (node) => {
            if (node.nodeName !== 'SPAN') return false;
            const style = node.getAttribute('style') || '';
            return /font-style\s*:\s*italic/i.test(style);
        },
        replacement: (c) => (c.trim() ? `*${c.trim()}*` : ''),
    });

    service.addRule('inlineStrikethrough', {
        filter: (node) => {
            const style = node.getAttribute('style') || '';
            return /text-decoration\s*:\s*line-through/i.test(style);
        },
        replacement: (c) => (c.trim() ? `~~${c.trim()}~~` : ''),
    });

    service.addRule('delTag', {
        filter: ['del', 's'],
        replacement: (c) => (c.trim() ? `~~${c.trim()}~~` : ''),
    });

    service.addRule('mark', {
        filter: 'mark',
        replacement: (c) => (c.trim() ? `==${c.trim()}==` : ''),
    });

    service.addRule('figcaption', {
        filter: 'figcaption',
        replacement: (c) => (c.trim() ? `\n*${c.trim()}*\n` : ''),
    });

    service.addRule('figure', {
        filter: 'figure',
        replacement: (c) => `\n${c.trim()}\n`,
    });

    service.addRule('sectionPassthrough', {
        filter: 'section',
        replacement: (c) => c,
    });

    service.remove(['script', 'style', 'noscript', 'iframe', 'nav', 'footer', 'aside']);

    return service;
}

// ============================================================
// HTML 表格 → Markdown 表格（source: word.js:164）
// ============================================================

function convertTableToMarkdown(tableNode) {
    const rows = tableNode.querySelectorAll
        ? Array.from(tableNode.querySelectorAll('tr'))
        : [];
    if (rows.length === 0) return '';

    let md = '\n\n';
    rows.forEach((row, rowIndex) => {
        const cells = Array.from(row.querySelectorAll('td, th'));
        const cellTexts = cells.map((cell) => cell.textContent.trim());
        md += '| ' + cellTexts.join(' | ') + ' |\n';
        if (rowIndex === 0) {
            md += '| ' + cellTexts.map(() => '---').join(' | ') + ' |\n';
        }
    });
    md += '\n';
    return md;
}

// ============================================================
// Markdown 产物清理（source: word.js:101-110）
// ============================================================

function cleanupMarkdownArtifacts(markdown) {
    return String(markdown || '')
        .replace(/(?:!\[[^\]]*\]\(data:image\/[^)]+\))/g, '')
        .replace(/[A-Za-z0-9+/=]{100,}/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ============================================================
// 输出文件名拼装
// ============================================================

function buildOutputFilename(folderName, format) {
    const extMap = {
        md: '.md',
        html: '.html',
        json: '.json',
        docx: '.docx',
        pdf: '.pdf',
        xlsx: '.xlsx',
        pptx: '.pptx',
    };
    return `${folderName}${extMap[format] || ''}`;
}

// ============================================================
// 写出内容（统一 utf8 文本 / Buffer 二进制）
// ============================================================

function writeOutputFile(outputFolder, folderName, format, content, { useExportsSubdir = false } = {}) {
    const filename = buildOutputFilename(folderName, format);
    const targetDir = useExportsSubdir
        ? path.join(outputFolder, 'exports')
        : outputFolder;
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, filename);
    if (Buffer.isBuffer(content)) {
        fs.writeFileSync(targetPath, content);
    } else {
        fs.writeFileSync(targetPath, content, 'utf8');
    }
    return targetPath;
}

module.exports = {
    sanitizeFolderName,
    decodeUtf8Filename,
    ensureOutputFolder,
    getExtFromContentType,
    getExtFromUrl,
    createBasicTurndownService,
    createWordTurndownService,
    createRichTurndownService,
    convertTableToMarkdown,
    cleanupMarkdownArtifacts,
    buildOutputFilename,
    writeOutputFile,
};
