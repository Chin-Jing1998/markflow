/**
 * 网页 Markdown 文本规范化
 *
 * 作用时机：turndown 产出 Markdown 之后、remark-parse 之前。网页里大量存在
 * 零宽字符与不换行空格，它们既看不见又会让「空行」不空、让标题匹配失效，
 * 必须在进入 mdast 之前清掉。
 *
 * 处理顺序不可调换：先删零宽 → 再把不换行空格归一为普通空格 → 再清行尾空白
 * → 最后合并空行。倒过来做会残留只含不可见字符的「假空行」。
 *
 * 行尾两空格的硬换行语法一并清理：本项目的 Markdown 产物不依赖该写法，
 * 网页转出的行尾空格绝大多数是排版噪声。
 *
 * 不可见字符一律以码点列表声明、运行时拼成字符类，源码里不出现看不见的字面量。
 */

// U+200B 零宽空格、U+200C 零宽非连接符、U+200D 零宽连接符、U+2060 Word Joiner、
// U+FEFF 零宽不换行空格（兼作 BOM）
const ZERO_WIDTH_CODE_POINTS = Object.freeze([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
// U+00A0 不换行空格、U+202F 窄不换行空格
const NBSP_CODE_POINTS = Object.freeze([0x00a0, 0x202f]);

// 码点列表 → 匹配其中任一字符的全局正则
function charClassRegExp(codePoints) {
    const body = codePoints.map((cp) => `\\u${cp.toString(16).padStart(4, '0')}`).join('');
    return new RegExp(`[${body}]`, 'g');
}

const ZERO_WIDTH_RE = charClassRegExp(ZERO_WIDTH_CODE_POINTS);
const NBSP_RE = charClassRegExp(NBSP_CODE_POINTS);
// 行尾空白（含制表符）
const TRAILING_SPACE_RE = /[ \t]+$/gm;
// 三个及以上换行折叠为两个（即最多留一个空行）
const EXTRA_BLANK_LINES_RE = /\n{3,}/g;

/**
 * @param {string} markdown
 * @returns {string}
 */
function normalizeMarkdown(markdown) {
    return String(markdown == null ? '' : markdown)
        .replace(/\r\n/g, '\n')
        .replace(ZERO_WIDTH_RE, '')
        .replace(NBSP_RE, ' ')
        .replace(TRAILING_SPACE_RE, '')
        .replace(EXTRA_BLANK_LINES_RE, '\n\n')
        .trim();
}

module.exports = { normalizeMarkdown, ZERO_WIDTH_CODE_POINTS, NBSP_CODE_POINTS };
