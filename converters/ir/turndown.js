/**
 * Turndown 工厂（全库唯一一份）
 *
 * profile 取值与行为来源：
 *   'basic' — 通用 HTML：基础选项 + 移除 script/style/noscript（源自 ir/util.js:78）
 *   'word'  — mammoth 输出：基础选项 + 表格转 GFM + 移除空 img（源自 旧版 word.js:130）
 *   'url'   — 网页正文：基础选项 + 内联样式识别 + figure/figcaption + section 透传
 *             + 移除 script/style/noscript/iframe/nav/footer/aside（源自 旧版 url.js:239）
 *             + 表格转 GFM（legacy 未挂此规则；turndown 核心不含表格支持，缺失时网页表格
 *               退化为逐行纯文本，IR 得不到 table 节点，故此处补挂）
 *
 * 表格规则 convertTableToMarkdown 为本文件内部函数，不再在其他文件重复实现。
 */
const TurndownService = require('turndown');

const BASE_OPTIONS = {
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
};

const BASIC_REMOVED_TAGS = ['script', 'style', 'noscript'];
const URL_REMOVED_TAGS = ['script', 'style', 'noscript', 'iframe', 'nav', 'footer', 'aside'];

// CSS font-weight 视为加粗的取值：bold、600-999、1000
const BOLD_STYLE_RE = /font-weight\s*:\s*(bold|[6-9]\d{2}|1000)/i;
const ITALIC_STYLE_RE = /font-style\s*:\s*italic/i;
const STRIKE_STYLE_RE = /text-decoration\s*:\s*line-through/i;
// 微信图片说明：字号 ≤ 14px 的小字
const SMALL_FONT_RE = /font-size\s*:\s*(1[0-4]|[0-9])px/i;
const CAPTION_MAX_LENGTH = 100;

// ============================================================
// 对外入口
// ============================================================

/**
 * @param {'basic'|'word'|'url'} profile
 * @returns {TurndownService}
 */
function createTurndownService(profile = 'basic') {
    const configure = PROFILE_BUILDERS[profile];
    if (!configure) {
        throw new Error(`未知的 turndown profile: ${String(profile)}（可选 basic | word | url）`);
    }
    const service = new TurndownService(BASE_OPTIONS);
    configure(service);
    return service;
}

// ============================================================
// 各 profile 配置
// ============================================================

function configureBasic(service) {
    service.remove(BASIC_REMOVED_TAGS);
}

function configureWord(service) {
    addTableRule(service);
    service.addRule('emptyImg', {
        filter: (node) => node.nodeName === 'IMG' && !node.getAttribute('src'),
        replacement: () => '',
    });
}

function configureUrl(service) {
    service.addRule('lineBreak', {
        filter: 'br',
        replacement: () => '\n',
    });

    service.addRule('inlineBold', {
        filter: (node) =>
            ['SPAN', 'P', 'SECTION'].includes(node.nodeName) && BOLD_STYLE_RE.test(styleOf(node)),
        replacement: (content) => wrapTrimmed(content, '**'),
    });

    service.addRule('inlineItalic', {
        filter: (node) => node.nodeName === 'SPAN' && ITALIC_STYLE_RE.test(styleOf(node)),
        replacement: (content) => wrapTrimmed(content, '*'),
    });

    service.addRule('inlineStrikethrough', {
        filter: (node) => STRIKE_STYLE_RE.test(styleOf(node)),
        replacement: (content) => wrapTrimmed(content, '~~'),
    });

    service.addRule('delTag', {
        filter: ['del', 's'],
        replacement: (content) => wrapTrimmed(content, '~~'),
    });

    service.addRule('mark', {
        filter: 'mark',
        replacement: (content) => wrapTrimmed(content, '=='),
    });

    service.addRule('figcaption', {
        filter: 'figcaption',
        replacement: (content) => (content.trim() ? `\n*${content.trim()}*\n` : ''),
    });

    service.addRule('figure', {
        filter: 'figure',
        replacement: (content) => `\n${content.trim()}\n`,
    });

    // 微信公众号图片说明：紧跟在图片后面、字号较小的短文本
    service.addRule('wxImgCaption', {
        filter: isWxImageCaption,
        replacement: (content) => (content.trim() ? `\n*${content.trim()}*\n` : ''),
    });

    service.addRule('sectionPassthrough', {
        filter: 'section',
        replacement: (content) => content,
    });

    addTableRule(service);
    service.remove(URL_REMOVED_TAGS);
}

const PROFILE_BUILDERS = {
    basic: configureBasic,
    word: configureWord,
    url: configureUrl,
};

// ============================================================
// 规则辅助
// ============================================================

function styleOf(node) {
    return (node.getAttribute && node.getAttribute('style')) || '';
}

function wrapTrimmed(content, marker) {
    const text = content.trim();
    return text ? `${marker}${text}${marker}` : '';
}

function isWxImageCaption(node) {
    if (node.nodeName !== 'SPAN' && node.nodeName !== 'P') return false;
    const text = node.textContent.trim();
    if (!text || text.length >= CAPTION_MAX_LENGTH) return false;
    if (!SMALL_FONT_RE.test(styleOf(node))) return false;
    const prev = node.previousElementSibling
        || (node.parentNode && node.parentNode.previousElementSibling);
    return !!(prev && prev.querySelector && prev.querySelector('img'));
}

function addTableRule(service) {
    service.addRule('table', {
        filter: 'table',
        replacement: (content, node) => convertTableToMarkdown(node),
    });
}

// ============================================================
// HTML 表格 → GFM 表格（源自 旧版 word.js:164）
// 单元格取纯文本；折叠换行并转义竖线，避免破坏 GFM 表格结构
// ============================================================

function convertTableToMarkdown(tableNode) {
    const rows = tableNode.querySelectorAll
        ? Array.from(tableNode.querySelectorAll('tr'))
        : [];
    if (rows.length === 0) return '';

    const lines = rows.map((row) => {
        const cells = Array.from(row.querySelectorAll('td, th')).map(cellText);
        return `| ${cells.join(' | ')} |`;
    });
    const columnCount = rows[0].querySelectorAll('td, th').length;
    const separator = `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`;

    return `\n\n${[lines[0], separator, ...lines.slice(1)].join('\n')}\n\n`;
}

function cellText(cell) {
    return cell.textContent.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

module.exports = { createTurndownService };
