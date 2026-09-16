/**
 * converters/renderers/html-themes 单元测试
 * 覆盖：主题名单与 OPTION_ENUMS.htmlThemes 一致、:root 变量注入（字体/字号/行高/栏宽/间距）、
 *       主题默认字体栈、print 主题以 v2 PAGE_CSS 为前缀（前缀逐字相同）、六主题均定义公式样式、
 *       fontFamily 注入不破坏 CSS、主题 CSS 不引用远程资源、未知主题报中文错
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { THEMES, buildStyles } = require('../converters/renderers/html-themes');
const { OPTION_ENUMS, DEFAULT_OPTIONS } = require('../converters/options');

const THEMES_DIR = path.join(__dirname, '..', 'converters', 'renderers', 'html-themes');

/** v2 converters/renderers/html.js 的 PAGE_CSS 逐字副本：print 主题须以它为前缀，其后只允许追加公式样式 */
const V2_PAGE_CSS = `
@page { margin: 1.5cm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: -apple-system, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Segoe UI", sans-serif; font-size: 11pt; line-height: 1.7; color: #1d1d1f; margin: 0; padding: 0; overflow-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.4em 0 0.5em; page-break-after: avoid; }
h1 { font-size: 1.8em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; }
p { margin: 0.6em 0; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #d2d2d7; padding: 0.4em 0.7em; text-align: left; vertical-align: top; }
th { background: #f5f5f7; font-weight: 600; }
tr { page-break-inside: avoid; }
code, pre { font-family: "SF Mono", Menlo, Consolas, "Courier New", monospace; }
code { background: #f5f5f7; padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; }
pre { background: #f5f5f7; padding: 0.8em 1em; border-radius: 6px; white-space: pre-wrap; word-break: break-all; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #d2d2d7; margin: 1em 0; padding: 0.2em 1em; color: #6e6e73; }
hr { border: none; border-top: 1px solid #d2d2d7; margin: 2em 0; }
a { color: #0071e3; text-decoration: none; }
ul.contains-task-list { list-style: none; padding-left: 1.2em; }
.task-list-item input[type="checkbox"] { margin-right: 0.4em; vertical-align: middle; }
`;

/**
 * 行尾归一：Windows 上 git 默认 core.autocrlf=true，检出的 .css 会变成 CRLF；
 * 而 V2_PAGE_CSS 写在 .js 模板字面量里，ECMAScript 规定模板字面量的 CRLF 一律归一为 LF，
 * 两侧行尾表示法因此在 Windows 上必然不同。行尾属版本控制的检出形态，不是样式内容的一部分，
 * 故比较前统一为 LF——断言的实质（前缀逐字相同、其后只追加公式样式）不受影响。
 */
const toLf = (text) => text.replace(/\r\n/g, '\n');

// 只取 :root 变量块，避免主题 CSS 里的同名片段干扰断言
function rootBlock(css) {
    const matched = /^:root\{([^}]*)\}/.exec(css);
    assert.ok(matched, ':root 变量块应位于样式开头');
    return matched[1];
}

// ============================================================
// 用例
// ============================================================

test('THEMES 与 OPTION_ENUMS.htmlThemes 完全一致，且每个主题都有非空 CSS 文件', () => {
    // Assert
    assert.deepEqual([...THEMES], [...OPTION_ENUMS.htmlThemes]);
    assert.ok(Object.isFrozen(THEMES));
    for (const theme of THEMES) {
        const css = buildStyles(DEFAULT_OPTIONS.html, { theme });
        assert.ok(css.length > 200, `${theme} 的样式应非空`);
        assert.ok(css.includes('body {') || css.includes('body{'), `${theme} 应定义 body 样式`);
    }
});

test('buildStyles 先输出 :root 变量：字号、行高、栏宽与间距档位均由 htmlOptions 生成', () => {
    // Arrange
    const options = { ...DEFAULT_OPTIONS.html, fontSize: 18, lineHeight: 2, contentWidth: 900, spacing: 'loose' };

    // Act
    const vars = rootBlock(buildStyles(options, { theme: 'apple' }));

    // Assert
    assert.ok(vars.includes('--mf-size:18px'), vars);
    assert.ok(vars.includes('--mf-lh:2'), vars);
    assert.ok(vars.includes('--mf-width:900px'), vars);
    assert.ok(vars.includes('--mf-space:1em'), vars);
    assert.ok(vars.includes('--mf-mono:"SF Mono"'), vars);

    // Assert：三档间距互不相同
    const spaceOf = (spacing) => /--mf-space:([^;]*)/.exec(rootBlock(buildStyles({ ...options, spacing }, { theme: 'apple' })))[1];
    assert.deepEqual(new Set(['compact', 'normal', 'loose'].map(spaceOf)).size, 3);
});

test('fontFamily 为 null 时取主题默认字体栈：academic 显式含宋体，apple 为系统字体栈', () => {
    // Act
    const academic = rootBlock(buildStyles({ ...DEFAULT_OPTIONS.html, fontFamily: null }, { theme: 'academic' }));
    const apple = rootBlock(buildStyles({ ...DEFAULT_OPTIONS.html, fontFamily: null }, { theme: 'apple' }));

    // Assert
    assert.ok(academic.includes('"Songti SC"') && academic.includes('SimSun'), academic);
    assert.ok(academic.includes('serif'));
    assert.ok(apple.includes('-apple-system') && apple.includes('"PingFang SC"') && apple.includes('"Microsoft YaHei"'), apple);
});

test('print 主题以 v2 的 PAGE_CSS 为前缀（前缀逐字相同），其后只追加公式样式', () => {
    // Arrange
    const printCss = toLf(fs.readFileSync(path.join(THEMES_DIR, 'print.css'), 'utf8'));

    // Act
    const css = toLf(buildStyles(DEFAULT_OPTIONS.html, { theme: 'print' }));

    // Assert：前缀逐字相同
    assert.equal(printCss.slice(0, V2_PAGE_CSS.length), V2_PAGE_CSS, 'print.css 须以 PAGE_CSS 原文为前缀');
    assert.ok(css.includes(V2_PAGE_CSS), 'print 主题样式应含 PAGE_CSS 原文');
    assert.ok(css.startsWith(':root{'), 'PAGE_CSS 之前只允许追加 :root 变量块');

    // Assert：PAGE_CSS 之后只允许公式样式，不得夹带其它选择器
    const appended = printCss.slice(V2_PAGE_CSS.length).replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = (appended.match(/^[^@\s][^{]*(?=\{)/gm) || []).map((item) => item.trim());
    assert.deepEqual(selectors, ['.mf-math', '.mf-math-display'], appended);
});

test('六主题均定义公式样式：.mf-math 与块级变体，类名与 html.js 输出一致', () => {
    // Assert
    for (const theme of THEMES) {
        const css = buildStyles(DEFAULT_OPTIONS.html, { theme });
        assert.ok(/^\.mf-math\s*\{/m.test(css), `${theme} 应定义 .mf-math`);
        assert.ok(/^\.mf-math-display\s*\{/m.test(css), `${theme} 应定义 .mf-math-display`);
    }
});

test('fontFamily 注入：合法字体栈原样保留，能闭合声明或越出 <style> 的字符被剔除', () => {
    // Arrange
    const legit = '"Noto Sans CJK SC", Arial, sans-serif';
    const attack = 'X}</style><script>alert(1)</script><style>a{color:red';

    // Act
    const safe = buildStyles({ ...DEFAULT_OPTIONS.html, fontFamily: legit }, { theme: 'apple' });
    const dirty = buildStyles({ ...DEFAULT_OPTIONS.html, fontFamily: attack }, { theme: 'apple' });

    // Assert
    assert.ok(rootBlock(safe).includes(`--mf-font:${legit}`), '合法字体栈应含引号原样保留');
    assert.ok(!dirty.includes('</style>') && !dirty.includes('<script'), dirty.slice(0, 200));
    const dirtyFont = /--mf-font:([^;]*)/.exec(rootBlock(dirty))[1];
    assert.ok(!/[;{}<>\\]/.test(dirtyFont), dirtyFont);
    assert.ok(rootBlock(dirty).includes('--mf-width:'), '注入值不得截断后续变量');
});

test('主题 CSS 不引用任何远程资源：无 url() 与 @import', () => {
    // Assert
    for (const theme of THEMES) {
        const css = buildStyles(DEFAULT_OPTIONS.html, { theme });
        assert.ok(!/url\s*\(/i.test(css), `${theme} 不得含 url()`);
        assert.ok(!css.includes('@import'), `${theme} 不得含 @import`);
        assert.ok(!/https?:/i.test(css), `${theme} 不得含远程地址`);
    }
});

test('主题缺省取默认主题，未知主题抛中文错误', () => {
    // Assert
    assert.equal(buildStyles(DEFAULT_OPTIONS.html), buildStyles(DEFAULT_OPTIONS.html, { theme: DEFAULT_OPTIONS.html.theme }));
    assert.throws(() => buildStyles(DEFAULT_OPTIONS.html, { theme: 'solarized' }), /未知的 HTML 主题/);
    assert.throws(() => buildStyles(DEFAULT_OPTIONS.html, { theme: 42 }), /未知的 HTML 主题/);
});
