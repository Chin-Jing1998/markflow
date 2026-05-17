/**
 * Word 文档转换模块
 * 将 .docx 文件转换为 Markdown，提取并保存图片到 images 文件夹
 */
const mammoth = require('mammoth');
const path = require('path');
const fs = require('fs');
const TurndownService = require('turndown');

/**
 * 将 Word 文件 buffer 转换为 Markdown
 * @param {Buffer} buffer - Word 文件的二进制内容
 * @param {string} originalName - 原始文件名
 * @param {string} outputDir - 输出根目录
 * @returns {Object} { markdown, title, folderName, imagesCount }
 */
async function convert(buffer, originalName, outputDir) {
    // 从文件名推导标题（去掉扩展名）
    const baseName = path.basename(originalName, path.extname(originalName));

    // 清理文件名中的特殊字符，用作文件夹名
    const folderName = sanitizeFolderName(baseName);
    const outputFolder = path.join(outputDir, folderName);
    const imagesFolder = path.join(outputFolder, 'images');

    // 创建输出目录
    fs.mkdirSync(imagesFolder, { recursive: true });

    // 图片计数器
    let imageIndex = 0;

    // mammoth 转换选项：提取内嵌图片
    const options = {
        buffer: buffer,
        convertImage: mammoth.images.imgElement(function (image) {
            return image.read('base64').then(function (imageBase64) {
                // 跳过过小的图片（可能是占位符或无效数据）
                if (imageBase64.length < 100) {
                    return { src: '' };
                }

                imageIndex++;
                const ext = getExtFromContentType(image.contentType);
                const imageName = `image_${imageIndex}${ext}`;
                const imagePath = path.join(imagesFolder, imageName);

                // 将 base64 写入文件
                const imageBuffer = Buffer.from(imageBase64, 'base64');
                fs.writeFileSync(imagePath, imageBuffer);

                // 返回相对路径，用于 Markdown 中引用
                return { src: `images/${imageName}` };
            });
        })
    };

    // 使用 mammoth 将 Word 转为 HTML
    const result = await mammoth.convertToHtml(options);
    let html = result.value;
    const warnings = result.messages;

    if (warnings.length > 0) {
        console.log('Mammoth 警告:', warnings.map(m => m.message).join('; '));
    }

    // ===== 关键修复：清理 HTML 中残留的 base64 图片数据 =====
    // 1. 将 base64 src 的 img 标签替换为已保存的本地图片引用
    html = html.replace(/<img\s+src="data:image\/([^;]+);base64,([^"]+)"\s*\/?>/gi, 
        function (match, format, base64Data) {
            // 将漏网的 base64 图片也保存到本地
            imageIndex++;
            const ext = '.' + format.replace('jpeg', 'jpg');
            const imageName = `image_${imageIndex}${ext}`;
            const imagePath = path.join(imagesFolder, imageName);

            try {
                const imageBuffer = Buffer.from(base64Data, 'base64');
                fs.writeFileSync(imagePath, imageBuffer);
                return `<img src="images/${imageName}" />`;
            } catch (e) {
                console.warn(`保存 base64 图片失败: ${e.message}`);
                return ''; // 移除无法保存的图片
            }
        }
    );

    // 2. 移除任何残留的 data:image 文本（非 img 标签内的）
    html = html.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]{50,}/g, '');

    // 从 HTML 中提取标题（如果有 h1）
    let title = baseName;
    const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
    if (h1Match) {
        title = h1Match[1].replace(/<[^>]+>/g, '').trim();
    }

    // 使用 Turndown 将 HTML 转为 Markdown
    const turndownService = createTurndownService();
    let markdown = turndownService.turndown(html);

    // ===== 关键修复：清理 Markdown 中残留的 base64 数据 =====
    // 移除 Markdown 中任何残留的超长 base64 字符串（连续50+个字母数字）
    markdown = markdown.replace(/(?:!\[[^\]]*\]\(data:image\/[^)]+\))/g, '');
    // 移除游离的大块 base64 编码文本（连续100+个大写字母和斜杠的片段）
    markdown = markdown.replace(/[A-Za-z0-9+/=]{100,}/g, '');

    // 清理多余空行
    markdown = markdown.replace(/\n{3,}/g, '\n\n');
    // 清理首尾空白
    markdown = markdown.trim();

    // 保存 Markdown 文件
    const mdFileName = `${folderName}.md`;
    const mdPath = path.join(outputFolder, mdFileName);
    fs.writeFileSync(mdPath, markdown, 'utf8');

    return {
        markdown,
        title,
        folderName,
        imagesCount: imageIndex,
        outputPath: outputFolder,
        mdPath
    };
}

/**
 * 创建配置好的 Turndown 服务实例
 */
function createTurndownService() {
    const service = new TurndownService({
        headingStyle: 'atx',          // 使用 # 号表示标题
        hr: '---',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
        strongDelimiter: '**',
    });

    // 保留表格（如果有的话）
    service.addRule('table', {
        filter: 'table',
        replacement: function (content, node) {
            return convertTableToMarkdown(node);
        }
    });

    // 移除空的 img 标签（src 为空的）
    service.addRule('emptyImg', {
        filter: function (node) {
            return node.nodeName === 'IMG' && (!node.getAttribute('src') || node.getAttribute('src') === '');
        },
        replacement: function () {
            return '';
        }
    });

    return service;
}

/**
 * 将 HTML 表格节点转为 Markdown 格式
 */
function convertTableToMarkdown(tableNode) {
    const rows = tableNode.querySelectorAll ? 
        Array.from(tableNode.querySelectorAll('tr')) : [];
    
    if (rows.length === 0) return '';

    let md = '\n\n';
    rows.forEach((row, rowIndex) => {
        const cells = Array.from(row.querySelectorAll('td, th'));
        const cellTexts = cells.map(cell => cell.textContent.trim());
        md += '| ' + cellTexts.join(' | ') + ' |\n';
        
        // 在第一行后添加分隔行
        if (rowIndex === 0) {
            md += '| ' + cellTexts.map(() => '---').join(' | ') + ' |\n';
        }
    });
    md += '\n';
    return md;
}

/**
 * 根据 MIME 类型获取文件扩展名
 */
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

/**
 * 清理文件/文件夹名称中的非法字符
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

