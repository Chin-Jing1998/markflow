/**
 * 文本转换模块
 * 将粘贴的纯文本或 HTML 文本转换为 Markdown 格式
 */
const path = require('path');
const fs = require('fs');
const TurndownService = require('turndown');

/**
 * 将文本内容转换为 Markdown
 * @param {string} text - 粘贴的文本内容（可以是纯文本或 HTML）
 * @param {string} title - 用户指定的标题（可选）
 * @param {string} outputDir - 输出根目录
 * @returns {Object} { markdown, title, folderName }
 */
async function convert(text, title, outputDir) {
    // 判断文本是否为 HTML
    const isHtml = /<[a-z][\s\S]*>/i.test(text);

    let markdown;
    if (isHtml) {
        // HTML 文本 -> Markdown
        const turndownService = createTurndownService();
        markdown = turndownService.turndown(text);
    } else {
        // 纯文本 -> 直接使用，做简单的智能格式化
        markdown = formatPlainText(text);
    }

    // 如果没有指定标题，从内容中提取
    if (!title || title.trim() === '') {
        title = extractTitleFromMarkdown(markdown) || extractTitleFromText(text);
    }

    // 清理文件名
    const folderName = sanitizeFolderName(title);
    const outputFolder = path.join(outputDir, folderName);
    const imagesFolder = path.join(outputFolder, 'images');
    fs.mkdirSync(imagesFolder, { recursive: true });

    // 清理多余空行
    markdown = markdown.replace(/\n{3,}/g, '\n\n');

    // 保存
    const mdPath = path.join(outputFolder, `${folderName}.md`);
    fs.writeFileSync(mdPath, markdown, 'utf8');

    return {
        markdown,
        title,
        folderName,
        imagesCount: 0,
        outputPath: outputFolder,
        mdPath
    };
}

/**
 * 对纯文本做智能格式化
 */
function formatPlainText(text) {
    const lines = text.split('\n');
    let result = [];

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        
        // 已经是 Markdown 标题格式的行保持不变
        if (/^#{1,6}\s/.test(line)) {
            result.push(line);
            continue;
        }

        // 检测可能的标题行（短行 + 紧随内容）
        const trimmed = line.trim();
        if (trimmed.length > 0 && trimmed.length <= 50) {
            const nextLine = (i + 1 < lines.length) ? lines[i + 1].trim() : '';
            const prevLine = (i - 1 >= 0) ? lines[i - 1].trim() : '';
            
            // 如果前后都是空行，且这行比较短，可能是标题
            if (prevLine === '' && nextLine === '' && i > 0) {
                // 不做自动标题推断，保留原格式
                result.push(trimmed);
            } else {
                result.push(line);
            }
        } else {
            result.push(line);
        }
    }

    return result.join('\n');
}

/**
 * 从 Markdown 内容中提取第一个标题
 */
function extractTitleFromMarkdown(markdown) {
    const match = markdown.match(/^#\s+(.+)$/m);
    if (match) return match[1].trim();
    return null;
}

/**
 * 从纯文本中提取第一行作为标题
 */
function extractTitleFromText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length > 0) {
        const firstLine = lines[0].substring(0, 80);
        return firstLine;
    }
    return '未命名文档';
}

/**
 * 创建配置好的 Turndown 服务实例
 */
function createTurndownService() {
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

/**
 * 清理文件/文件夹名称
 */
function sanitizeFolderName(name) {
    return name
        .replace(/^#+\s*/, '')                // 去掉 Markdown 标题前缀 #
        .replace(/[<>:"/\\|?*#]/g, '_')       // 替换文件系统非法字符和 #
        .replace(/\s+/g, '_')                 // 空格替换为下划线
        .replace(/_+/g, '_')                  // 合并连续下划线
        .replace(/^_|_$/g, '')                // 去掉首尾下划线
        .substring(0, 100) || '未命名文档';   // 限制长度并兜底
}

module.exports = { convert };
