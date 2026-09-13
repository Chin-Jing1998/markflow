/**
 * HTML 主题注册表与样式拼装
 *
 * 六款主题各自一份 CSS 文件，名单与 converters/options.js 的 OPTION_ENUMS.htmlThemes 一一对应
 * （test/html-themes.test.js 守护两者一致）：
 *   apple       浅色苹果风（默认）      apple-dark  深色苹果风
 *   github      仿 GitHub Markdown      academic    衬线论文风（宋体优先）
 *   reader      长文阅读（大字距）      print       打印样式，逐字沿用 v2 的 PAGE_CSS
 *
 * buildStyles(htmlOptions, { theme }) 先输出一段 :root 自定义属性，再拼接主题 CSS：
 *   --mf-font   正文字体栈（htmlOptions.fontFamily 为空时取主题默认栈）
 *   --mf-mono   等宽字体栈（全主题共用）
 *   --mf-size   正文字号（px）        --mf-lh     行高倍数
 *   --mf-width  正文栏宽（px）        --mf-space  段落间距基准（spacing 档位换算而来）
 * 主题 CSS 只引用这些变量与自身色值，不含 url()、不下载远程字体，故渲染页面在
 * default-src 'none' 的 CSP 下也不会发起任何网络请求。print.css 是 v2 打印样式的逐字副本，
 * 不消费上述变量，注入变量后视觉不变。
 *
 * CSS 文件以 fs.readFileSync 同步读入并按主题名缓存，进程内只读盘一次。
 */
const fs = require('fs');
const path = require('path');
const { DEFAULT_OPTIONS } = require('../../options');

/** 苹果系统字体栈：apple / apple-dark / print 共用 */
const APPLE_FONT_STACK =
    '-apple-system, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Segoe UI", sans-serif';
const GITHUB_FONT_STACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, "PingFang SC", "Microsoft YaHei", sans-serif';
/** 论文风衬线栈：中文显式列出宋体，避免落到无衬线回退 */
const ACADEMIC_FONT_STACK =
    '"Songti SC", SimSun, "Source Han Serif SC", "Noto Serif CJK SC", "Times New Roman", Georgia, serif';
const READER_FONT_STACK =
    'Georgia, "Iowan Old Style", "Songti SC", "Source Han Serif SC", "Microsoft YaHei", serif';
const MONO_FONT_STACK = '"SF Mono", Menlo, Consolas, "Courier New", monospace';

/** 段落间距档位 → --mf-space 取值 */
const SPACING_SCALE = Object.freeze({ compact: '0.45em', normal: '0.7em', loose: '1em' });

/** 主题名 → { file, fontStack }；名单即 THEMES，须与 OPTION_ENUMS.htmlThemes 完全一致 */
const REGISTRY = Object.freeze({
    apple: { file: 'apple.css', fontStack: APPLE_FONT_STACK },
    'apple-dark': { file: 'apple-dark.css', fontStack: APPLE_FONT_STACK },
    github: { file: 'github.css', fontStack: GITHUB_FONT_STACK },
    academic: { file: 'academic.css', fontStack: ACADEMIC_FONT_STACK },
    reader: { file: 'reader.css', fontStack: READER_FONT_STACK },
    print: { file: 'print.css', fontStack: APPLE_FONT_STACK },
});

const THEMES = Object.freeze(Object.keys(REGISTRY));
const DEFAULT_THEME = DEFAULT_OPTIONS.html.theme;
const DEFAULT_HTML_OPTIONS = DEFAULT_OPTIONS.html;

// CSS 值里能闭合声明块、越出 <style> 或做转义的字符：字体栈已在 options.js 校验过，此处再防一次直调。
// 引号不在其列——字体名带空格时须保留引号，且引号无法越出 <style>（HTML 分词器只认字面量 </style）
const CSS_UNSAFE_RE = /[;{}<>\\]|[\x00-\x1f\x7f]/g;

const cssCache = new Map();

/**
 * @param {object} [htmlOptions] options.html（缺省项按默认值补齐）
 * @param {{ theme?: string }} [context] 显式主题；省略时取 htmlOptions.theme，再省略取默认主题
 * @returns {string} :root 变量块 + 主题 CSS
 */
function buildStyles(htmlOptions, context = {}) {
    const opts = htmlOptions && typeof htmlOptions === 'object' ? htmlOptions : {};
    const requested = context && context.theme !== undefined && context.theme !== null ? context.theme : opts.theme;
    const theme = resolveTheme(requested);
    return `${rootBlock(opts, theme)}\n${readThemeCss(theme)}`;
}

/** 未知主题一律抛中文错误：调用方传到这里的值应当已经过 options.js 校验 */
function resolveTheme(value) {
    if (value === undefined || value === null) return DEFAULT_THEME;
    if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(REGISTRY, value)) return value;
    throw new Error(`未知的 HTML 主题：${JSON.stringify(value)}（可用：${THEMES.join('、')}）`);
}

function rootBlock(opts, theme) {
    const fontFamily = cssValue(opts.fontFamily) || REGISTRY[theme].fontStack;
    const vars = [
        `--mf-font:${fontFamily}`,
        `--mf-mono:${MONO_FONT_STACK}`,
        `--mf-size:${numberValue(opts.fontSize, DEFAULT_HTML_OPTIONS.fontSize)}px`,
        `--mf-lh:${numberValue(opts.lineHeight, DEFAULT_HTML_OPTIONS.lineHeight)}`,
        `--mf-width:${numberValue(opts.contentWidth, DEFAULT_HTML_OPTIONS.contentWidth)}px`,
        `--mf-space:${SPACING_SCALE[opts.spacing] || SPACING_SCALE[DEFAULT_HTML_OPTIONS.spacing]}`,
    ];
    return `:root{${vars.join(';')}}`;
}

function readThemeCss(theme) {
    if (!cssCache.has(theme)) {
        cssCache.set(theme, fs.readFileSync(path.join(__dirname, REGISTRY[theme].file), 'utf8'));
    }
    return cssCache.get(theme);
}

/** 字体栈等字符串值：剔除能越出声明的字符，全空则返回空串交由调用方回退 */
function cssValue(value) {
    if (typeof value !== 'string') return '';
    return value.replace(CSS_UNSAFE_RE, '').trim();
}

function numberValue(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

module.exports = { THEMES, buildStyles };
