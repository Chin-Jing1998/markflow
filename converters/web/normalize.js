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
 * 网页转出的行尾空格绝大多数是排版噪声。清理按「空白段 + 段后一个字符」判定，不用量词
 * 加行尾锚——后者在不处于行尾的超长空白串上逐位回溯，成本随段长平方增长，而网页正文属
 * 不可信输入（与 web/whitespace 同一考量）。
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
// U+000A LF、U+000D CR、U+2028 行分隔符、U+2029 段分隔符：无 u 标志时，m 标志下的 $ 断言的
// 正是「已到串尾，或其后紧跟这四个字符之一」。CRLF 在上一步已归一，孤立的 CR 仍可能存在
const LINE_TERMINATOR_CODE_POINTS = Object.freeze([0x000a, 0x000d, 0x2028, 0x2029]);
const LINE_TERMINATORS = new Set(LINE_TERMINATOR_CODE_POINTS.map((cp) => String.fromCharCode(cp)));
// 一段极大的行尾空白候选（含制表符）。无必需后缀，极大串一次匹配即成功，不存在失败后的
// 逐位回溯；是否处于行尾改由回调查看段后一个字符判定
const SPACE_RUN_RE = /[ \t]+/g;
// 三个及以上换行折叠为两个（即最多留一个空行）
const EXTRA_BLANK_LINES_RE = /\n{3,}/g;

/**
 * 删除处于行尾的空白段，其余空白段逐字保留。
 *
 * 与 /[ \t]+$/gm 逐字等价：该正则从空白段内任一位置起匹配，贪婪吃到段尾 e 之后才验 $，
 * 而段内各位置都不是行终止符，故 e 之外无处可成；能否匹配只取决于 e 处是否满足 $，
 * 与起点无关——整段要么全删、要么全留。
 *
 * @param {string} text
 * @returns {string}
 */
function stripTrailingSpaces(text) {
    return text.replace(SPACE_RUN_RE, (run, offset) => {
        // 段尾即串尾时 charAt 返回空串，对应 $ 的串尾分支
        const next = text.charAt(offset + run.length);
        return next === '' || LINE_TERMINATORS.has(next) ? '' : run;
    });
}

/**
 * @param {string} markdown
 * @returns {string}
 */
function normalizeMarkdown(markdown) {
    const withoutInvisibles = String(markdown == null ? '' : markdown)
        .replace(/\r\n/g, '\n')
        .replace(ZERO_WIDTH_RE, '')
        .replace(NBSP_RE, ' ');
    return stripTrailingSpaces(withoutInvisibles)
        .replace(EXTRA_BLANK_LINES_RE, '\n\n')
        .trim();
}

module.exports = { normalizeMarkdown, ZERO_WIDTH_CODE_POINTS, NBSP_CODE_POINTS };
