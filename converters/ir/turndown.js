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

/** @param {'basic'|'word'|'url'} profile @returns {TurndownService} */
function createTurndownService(profile = 'basic') {
    const configure = PROFILE_BUILDERS[profile];
    if (!configure) {
        throw new Error(`未知的 turndown profile: ${String(profile)}（可选 basic | word | url）`);
    }
    const service = new TurndownService(BASE_OPTIONS);
    configure(service);
    return service;
}

// ---------- 规则辅助 ----------

function styleOf(node) {
    return (node.getAttribute && node.getAttribute('style')) || '';
}

function wrapTrimmed(content, marker) {
    const text = content.trim();
    return text ? `${marker}${text}${marker}` : '';
}

// 图片说明统一转为独立成行的斜体
const italicLine = (content) => (content.trim() ? `\n*${content.trim()}*\n` : '');

// 微信公众号图片说明：紧跟在图片后面、字号较小的短文本
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

// ---------- 各 profile 配置 ----------

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

// [规则名, filter, 包裹符]；turndown 后注册的规则优先级更高，顺序不可调整
const URL_WRAP_RULES = [
    ['inlineBold', (node) => ['SPAN', 'P', 'SECTION'].includes(node.nodeName) && BOLD_STYLE_RE.test(styleOf(node)), '**'],
    ['inlineItalic', (node) => node.nodeName === 'SPAN' && ITALIC_STYLE_RE.test(styleOf(node)), '*'],
    ['inlineStrikethrough', (node) => STRIKE_STYLE_RE.test(styleOf(node)), '~~'],
    ['delTag', ['del', 's'], '~~'],
    ['mark', 'mark', '=='],
];

function configureUrl(service) {
    service.addRule('lineBreak', { filter: 'br', replacement: () => '\n' });
    for (const [name, filter, marker] of URL_WRAP_RULES) {
        service.addRule(name, { filter, replacement: (content) => wrapTrimmed(content, marker) });
    }
    service.addRule('figcaption', { filter: 'figcaption', replacement: italicLine });
    service.addRule('figure', { filter: 'figure', replacement: (content) => `\n${content.trim()}\n` });
    service.addRule('wxImgCaption', { filter: isWxImageCaption, replacement: italicLine });
    service.addRule('sectionPassthrough', { filter: 'section', replacement: (content) => content });
    addTableRule(service);
    service.remove(URL_REMOVED_TAGS);
}

const PROFILE_BUILDERS = { basic: configureBasic, word: configureWord, url: configureUrl };

// ---------- HTML 表格 → GFM 表格（源自 旧版 word.js:164）----------
// 单元格取纯文本；折叠换行并转义竖线，避免破坏 GFM 表格结构

function convertTableToMarkdown(tableNode) {
    const rows = ownRows(tableNode);
    if (rows.length === 0) return '';
    const matrix = rows.map((row) => ownCells(row).map(cellText));
    // 列数取各行最大值：首行是表头时常比数据行短，只按首行算会截断整表
    const columnCount = matrix.reduce((max, cells) => Math.max(max, cells.length), 0);
    const lines = matrix.map((cells) => {
        const padded = [...cells];
        while (padded.length < columnCount) padded.push('');
        return `| ${padded.join(' | ')} |`;
    });
    const separator = `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`;
    return `\n\n${[lines[0], separator, ...lines.slice(1)].join('\n')}\n\n`;
}

// querySelectorAll 会连嵌套表格的行一并取回，须按「最近的 table 祖先」筛出直属本表格的行
function ownRows(tableNode) {
    const rows = tableNode.querySelectorAll ? Array.from(tableNode.querySelectorAll('tr')) : [];
    return rows.filter((row) => closestByName(row, 'TABLE') === tableNode);
}

// 单元格必为 tr 的直接子节点，取子节点即可天然排除嵌套表格的单元格
function ownCells(row) {
    return Array.from(row.children || []).filter((el) => el.nodeName === 'TD' || el.nodeName === 'TH');
}

function closestByName(node, nodeName) {
    for (let current = node.parentNode; current; current = current.parentNode) {
        if (current.nodeName === nodeName) return current;
    }
    return null;
}

function cellText(cell) {
    return cell.textContent.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

module.exports = { createTurndownService };
