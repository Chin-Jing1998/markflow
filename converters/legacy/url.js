/**
 * URL 文章转换模块
 * 抓取网页/微信公众号文章内容，转换为 Markdown，下载图片到本地
 */
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const TurndownService = require('turndown');
const { URL } = require('url');

/**
 * 将 URL 指向的文章转换为 Markdown
 * @param {string} url - 文章链接
 * @param {string} outputDir - 输出根目录
 * @returns {Object} { markdown, title, folderName, imagesCount }
 */
async function convert(url, outputDir) {
    // 抓取页面 HTML
    const html = await fetchPage(url);
    const $ = cheerio.load(html);

    // 提取标题
    let title = extractTitle($, url);

    // 清理文件名
    const folderName = sanitizeFolderName(title);
    const outputFolder = path.join(outputDir, folderName);
    const imagesFolder = path.join(outputFolder, 'images');
    fs.mkdirSync(imagesFolder, { recursive: true });

    // 提取文章主体内容
    const contentHtml = extractArticleContent($, url);

    // 下载文章中的图片并替换路径
    const { processedHtml, imagesCount } = await downloadImages(contentHtml, imagesFolder, url);

    // HTML 预处理：将内联样式（如 font-weight:bold）转为语义标签（<strong>）
    const cleanedHtml = preprocessHtml(processedHtml);

    // 将处理后的 HTML 转为 Markdown
    const turndownService = createTurndownService();
    let markdown = turndownService.turndown(cleanedHtml);

    // 清理多余空行
    markdown = markdown.replace(/\n{3,}/g, '\n\n');

    // 如果提取到的 markdown 没有一级标题，手动加上
    if (!markdown.startsWith('# ')) {
        markdown = `# ${title}\n\n${markdown}`;
    }

    // 保存
    const mdPath = path.join(outputFolder, `${folderName}.md`);
    fs.writeFileSync(mdPath, markdown, 'utf8');

    return {
        markdown,
        title,
        folderName,
        imagesCount,
        outputPath: outputFolder,
        mdPath
    };
}

/**
 * 抓取页面 HTML
 */
async function fetchPage(url) {
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        timeout: 15000,
        maxRedirects: 5,
    });
    return response.data;
}

/**
 * 提取文章标题
 */
function extractTitle($, url) {
    // 微信公众号
    if (url.includes('mp.weixin.qq.com')) {
        const wxTitle = $('#activity-name').text().trim();
        if (wxTitle) return wxTitle;
    }

    // 通用：尝试 <title>、<h1>、og:title
    const ogTitle = $('meta[property="og:title"]').attr('content');
    if (ogTitle) return ogTitle.trim();

    const h1 = $('h1').first().text().trim();
    if (h1) return h1;

    const titleTag = $('title').text().trim();
    if (titleTag) return titleTag;

    return '未命名文章';
}

/**
 * 提取文章主体 HTML 内容
 */
function extractArticleContent($, url) {
    // 微信公众号
    if (url.includes('mp.weixin.qq.com')) {
        const content = $('#js_content').html();
        if (content) return content;
    }

    // 知乎
    if (url.includes('zhihu.com')) {
        const content = $('.Post-RichTextContainer').html() || $('.RichContent-inner').html();
        if (content) return content;
    }

    // CSDN
    if (url.includes('csdn.net')) {
        const content = $('#content_views').html() || $('#article_content').html();
        if (content) return content;
    }

    // 简书
    if (url.includes('jianshu.com')) {
        const content = $('article').html() || $('._2rhmJa').html();
        if (content) return content;
    }

    // 通用策略：尝试 article 标签 -> main 标签 -> 最大的内容块
    const article = $('article').html();
    if (article) return article;

    const main = $('main').html();
    if (main) return main;

    // 查找内容最长的 div
    let bestContent = '';
    let maxLength = 0;
    $('div').each((i, el) => {
        const text = $(el).text().trim();
        if (text.length > maxLength && text.length > 200) {
            maxLength = text.length;
            bestContent = $(el).html();
        }
    });

    if (bestContent) return bestContent;

    // 兜底：返回 body 内容
    return $('body').html() || '';
}

/**
 * 下载文章中的所有图片并替换路径
 */
async function downloadImages(html, imagesFolder, pageUrl) {
    const $ = cheerio.load(html);
    const imgElements = $('img');
    let imagesCount = 0;

    const downloadPromises = [];

    imgElements.each((i, el) => {
        const $img = $(el);
        // 微信公众号的懒加载图片可能在 data-src
        let src = $img.attr('data-src') || $img.attr('src') || '';

        if (!src || src.startsWith('data:')) return;

        // 解析绝对 URL
        try {
            src = new URL(src, pageUrl).href;
        } catch (e) {
            return; // 无效 URL 跳过
        }

        const imgIndex = i + 1;
        const ext = getExtFromUrl(src);
        const imageName = `image_${imgIndex}${ext}`;

        // 替换 HTML 中的图片路径为本地相对路径
        $img.attr('src', `images/${imageName}`);
        $img.removeAttr('data-src');

        downloadPromises.push(
            downloadImage(src, path.join(imagesFolder, imageName))
                .then(() => { imagesCount++; })
                .catch(err => {
                    console.warn(`图片下载失败 [${src}]:`, err.message);
                })
        );
    });

    await Promise.all(downloadPromises);

    return {
        processedHtml: $.html(),
        imagesCount
    };
}

/**
 * 下载单张图片
 */
async function downloadImage(url, savePath) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Referer': url, // 处理防盗链
        }
    });
    fs.writeFileSync(savePath, response.data);
}

/**
 * 从 URL 中推断图片扩展名
 */
function getExtFromUrl(url) {
    try {
        const pathname = new URL(url).pathname;
        const ext = path.extname(pathname).toLowerCase().split('?')[0];
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'].includes(ext)) {
            return ext;
        }
    } catch (e) {}
    return '.jpg'; // 默认 jpg
}

/**
 * 创建配置好的 Turndown 服务实例（增强格式识别）
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

    // 保留换行
    service.addRule('lineBreak', {
        filter: 'br',
        replacement: () => '\n'
    });

    // ===== 内联样式识别：加粗 =====
    service.addRule('inlineBold', {
        filter: function (node) {
            if (node.nodeName !== 'SPAN' && node.nodeName !== 'P' && node.nodeName !== 'SECTION') return false;
            const style = node.getAttribute('style') || '';
            return /font-weight\s*:\s*(bold|[6-9]\d{2}|1000)/i.test(style);
        },
        replacement: (content) => content.trim() ? `**${content.trim()}**` : ''
    });

    // ===== 内联样式识别：斜体 =====
    service.addRule('inlineItalic', {
        filter: function (node) {
            if (node.nodeName !== 'SPAN') return false;
            const style = node.getAttribute('style') || '';
            return /font-style\s*:\s*italic/i.test(style);
        },
        replacement: (content) => content.trim() ? `*${content.trim()}*` : ''
    });

    // ===== 内联样式识别：删除线 =====
    service.addRule('inlineStrikethrough', {
        filter: function (node) {
            const style = node.getAttribute('style') || '';
            return /text-decoration\s*:\s*line-through/i.test(style);
        },
        replacement: (content) => content.trim() ? `~~${content.trim()}~~` : ''
    });

    // ===== HTML5 删除线标签 <del> <s> =====
    service.addRule('delTag', {
        filter: ['del', 's'],
        replacement: (content) => content.trim() ? `~~${content.trim()}~~` : ''
    });

    // ===== <mark> 高亮 =====
    service.addRule('mark', {
        filter: 'mark',
        replacement: (content) => content.trim() ? `==${content.trim()}==` : ''
    });

    // ===== 图片附注说明 <figcaption> =====
    service.addRule('figcaption', {
        filter: 'figcaption',
        replacement: (content) => content.trim() ? `\n*${content.trim()}*\n` : ''
    });

    // ===== <figure> 容器 =====
    service.addRule('figure', {
        filter: 'figure',
        replacement: (content) => `\n${content.trim()}\n`
    });

    // ===== 微信公众号图片说明（紧跟图片后的小字 span） =====
    service.addRule('wxImgCaption', {
        filter: function (node) {
            if (node.nodeName !== 'SPAN' && node.nodeName !== 'P') return false;
            const style = node.getAttribute('style') || '';
            const text = node.textContent.trim();
            // 小于 100 字符且字号 ≤ 14px 的跟在图片后面的文字
            if (text.length > 0 && text.length < 100 && /font-size\s*:\s*(1[0-4]|[0-9])px/i.test(style)) {
                const prev = node.previousElementSibling || (node.parentNode && node.parentNode.previousElementSibling);
                if (prev && prev.querySelector && prev.querySelector('img')) return true;
            }
            return false;
        },
        replacement: (content) => content.trim() ? `\n*${content.trim()}*\n` : ''
    });

    // ===== 微信 section 容器透传 =====
    service.addRule('sectionPassthrough', {
        filter: 'section',
        replacement: (content) => content
    });

    // 移除无用标签
    service.remove(['script', 'style', 'noscript', 'iframe', 'nav', 'footer', 'aside']);

    return service;
}

/**
 * HTML 预处理：将内联样式转为语义化标签（在 Turndown 之前调用）
 */
function preprocessHtml(html) {
    const $ = cheerio.load(html, { decodeEntities: false });

    // 将 <span style="font-weight:bold"> 转为 <strong>
    $('span, b').each((_, el) => {
        const style = $(el).attr('style') || '';
        if (/font-weight\s*:\s*(bold|[6-9]\d{2}|1000)/i.test(style)) {
            $(el).replaceWith(`<strong>${$(el).html()}</strong>`);
        }
    });

    // 将 <span style="font-style:italic"> 转为 <em>
    $('span').each((_, el) => {
        const style = $(el).attr('style') || '';
        if (/font-style\s*:\s*italic/i.test(style)) {
            $(el).replaceWith(`<em>${$(el).html()}</em>`);
        }
    });

    // 将 <span style="text-decoration:line-through"> 转为 <del>
    $('span').each((_, el) => {
        const style = $(el).attr('style') || '';
        if (/text-decoration[^;]*line-through/i.test(style)) {
            $(el).replaceWith(`<del>${$(el).html()}</del>`);
        }
    });

    // 微信公众号：data-src 图片修复
    $('img').each((_, el) => {
        const dataSrc = $(el).attr('data-src');
        if (dataSrc && !$(el).attr('src')) {
            $(el).attr('src', dataSrc);
        }
    });

    // 移除空的 span（无文本内容）
    $('span').each((_, el) => {
        if (!$(el).text().trim() && !$(el).find('img').length) {
            $(el).remove();
        }
    });

    return $.html();
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
        .substring(0, 100) || '未命名文章';   // 限制长度并兜底
}

module.exports = { convert };
