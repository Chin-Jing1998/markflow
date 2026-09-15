/**
 * desktop/renderer/js/doc-tools.mjs 单元测试（渲染层纯逻辑，Node 经 import() 载入）
 * 覆盖：字号百分比的取整、夹紧与步进；Markdown 大纲（ATX、Setext、front matter、围栏代码、闭合井号、行内标记、
 *       列表续行与缩进代码不误判）；HTML 大纲（实体、嵌套标签、脚本与注释剔除）；导航历史（截断前进分支、
 *       跳过失效项与当前项、上限）；查找匹配与选取（不区分大小写、正则元字符按字面、回绕、reset）；查找高亮切片（首尾命中、
 *       相邻命中、当前命中、换行与制表符、异常区间）；行首偏移与所在文件夹。
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mod;
before(async () => {
    mod = await import(pathToFileURL(path.join(__dirname, '..', 'desktop', 'renderer', 'js', 'doc-tools.mjs')).href);
});

test('字号：取整到 10% 档位并夹在 80%–160%，无法解析时回退 100%', () => {
    assert.deepEqual({ ...mod.DOC_ZOOM }, { min: 80, max: 160, step: 10, fallback: 100 });
    assert.equal(mod.normalizeZoom(undefined), 100);
    assert.equal(mod.normalizeZoom(''), 100);
    assert.equal(mod.normalizeZoom('abc'), 100);
    assert.equal(mod.normalizeZoom('120'), 120);
    assert.equal(mod.normalizeZoom(114), 110);
    assert.equal(mod.normalizeZoom(30), 80);
    assert.equal(mod.normalizeZoom(999), 160);
    assert.equal(mod.stepZoom(100, 1), 110);
    assert.equal(mod.stepZoom(100, -1), 90);
    assert.equal(mod.stepZoom(160, 1), 160, '上限不再放大');
    assert.equal(mod.stepZoom(80, -1), 80, '下限不再缩小');
    assert.equal(mod.stepZoom('bad', 1), 110);
});

test('Markdown 大纲：ATX 与 Setext，闭合井号去掉，行内标记转纯文本，行号指向标题文字首行', () => {
    const text = [
        '# 总述 #', '', '正文', '', '第二章', '========', '', '## [链接](https://a.b) 与 `代码` **加粗**', '',
        '多行段落', '合并为标题', '---', '', '###### 六级', '####### 七个井号不是标题', '#没有空格不是标题', '#', '### 转义\\#号',
    ].join('\n');
    assert.deepEqual(mod.extractMarkdownOutline(text), [
        { level: 1, text: '总述', index: 0, line: 0 },
        { level: 1, text: '第二章', index: 1, line: 4 },
        { level: 2, text: '链接 与 代码 加粗', index: 2, line: 7 },
        { level: 2, text: '多行段落 合并为标题', index: 3, line: 9 },
        { level: 6, text: '六级', index: 4, line: 13 },
        { level: 3, text: '转义#号', index: 5, line: 17 },
    ]);
});

test('Markdown 大纲：跳过 front matter、围栏代码块（含 ~~~ 与更长围栏）、缩进代码，分隔线与列表续行不误判', () => {
    const text = [
        '---', 'title: 元数据', '---', '# 真标题', '```', '# 代码里的井号', '```', '~~~~', '# 仍在代码中', '~~~', '# 还在代码中', '~~~~',
        '', '    # 缩进代码', '', '---', '', '- 列表项', '  续行', '---', '', '> 引用', '---', '', 'snake_case_name 与 *强调*', '---',
    ].join('\r\n');
    assert.deepEqual(mod.extractMarkdownOutline(text).map((item) => [item.level, item.text, item.line]), [
        [1, '真标题', 3],
        [2, 'snake_case_name 与 强调', 24],
    ]);
    assert.deepEqual(mod.extractMarkdownOutline(''), []);
    assert.deepEqual(mod.extractMarkdownOutline(null), []);
    assert.deepEqual(mod.extractMarkdownOutline('---\nkey: 标题样的值\n---'), [], '首行 --- 与收尾 --- 之间按 front matter 跳过，收尾行不当作 Setext 下划线');
    assert.deepEqual(mod.extractMarkdownOutline('---\n# 标题').map((item) => item.text), ['标题'], '文首 --- 无收尾时不当作 front matter');
});

test('HTML 大纲：按顺序取 h1–h6，解码实体并去掉内层标签，剔除脚本、样式、注释与空标题', () => {
    const html = '<style>h1{}</style><h1 class="book-title">说明书</h1><!-- <h2>注释</h2> --><h2 class="invention-title">A &amp; B<sup>2</sup></h2>'
        + '<script><h3>脚本</h3></script><h3 class="heading"> 技术\n领域 </h3><h4></h4><H5>&#x4E2D;&#25991;&nbsp;x&bogus;</H5>';
    assert.deepEqual(mod.extractHtmlOutline(html), [
        { level: 1, text: '说明书', index: 0 },
        { level: 2, text: 'A & B2', index: 1 },
        { level: 3, text: '技术 领域', index: 2 },
        { level: 5, text: '中文 x&bogus;', index: 3 },
    ]);
    assert.deepEqual(mod.extractHtmlOutline(''), []);
});

test('headingKey 与 plainHeadingText：宽松键忽略标点、空白与大小写', () => {
    assert.equal(mod.headingKey('  Hello, World！ '), 'helloworld');
    assert.equal(mod.headingKey('第 1 章：概述'), '第1章概述');
    assert.equal(mod.plainHeadingText('![图](a.png) *斜体* _下划线_ ~~删除~~ <b>粗</b> &lt;x&gt;'), '图 斜体 下划线 删除 粗 <x>');
});

test('导航历史：访问截断前进分支，后退与前进跳过失效项与当前项，游标只在导航成功后移动', () => {
    let history = mod.EMPTY_HISTORY;
    assert.equal(mod.canStepHistory(history, -1), false);
    for (const key of ['a', 'b', 'c']) history = mod.visitHistory(history, key);
    assert.deepEqual([...history.entries], ['a', 'b', 'c']);
    assert.equal(history.cursor, 2);
    assert.equal(mod.visitHistory(history, 'c'), history, '与当前项相同时不变');
    assert.equal(mod.visitHistory(history, ''), history, '空键忽略');
    const open = new Set(['a', 'c']);
    const back = mod.findHistoryStep(history, -1, (key) => open.has(key));
    assert.equal(back, 0, 'b 已关闭，跳到 a');
    history = mod.moveHistory(history, back);
    assert.equal(mod.canStepHistory(history, -1, (key) => open.has(key)), false);
    assert.equal(mod.findHistoryStep(history, 1, (key) => open.has(key)), 2, '前进同样跳过 b');
    history = mod.visitHistory(history, 'd');
    assert.deepEqual([...history.entries], ['a', 'd'], '从中间访问新项截掉前进分支');
    const loop = ['x', 'y', 'x'].reduce((acc, key) => mod.visitHistory(acc, key), mod.EMPTY_HISTORY);
    assert.equal(mod.findHistoryStep(loop, -1), 1, '后退一步是 y');
    assert.equal(mod.findHistoryStep(mod.moveHistory(loop, 1), -1), 0);
    assert.equal(mod.findHistoryStep(['x', 'x'].reduce((acc) => acc, loop), -1, (key) => key !== 'y'), -1, '只剩与当前项相同的 x 时无处可退');
    assert.equal(mod.moveHistory(loop, 9), loop, '越界下标原样返回');
    const capped = Array.from({ length: 5 }, (_, i) => `k${i}`).reduce((acc, key) => mod.visitHistory(acc, key, 3), mod.EMPTY_HISTORY);
    assert.deepEqual([...capped.entries], ['k2', 'k3', 'k4']);
    assert.equal(capped.cursor, 2);
    assert.ok(Object.isFrozen(capped) && Object.isFrozen(capped.entries), '历史对象不可变');
});

test('查找：不区分大小写、元字符按字面、Unicode 大小写折叠，最多 limit 处', () => {
    assert.deepEqual(mod.findMatches('Foo foo FOO', 'foo'), [{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 11 }]);
    assert.deepEqual(mod.findMatches('a.b axb (x)', '.'), [{ start: 1, end: 2 }]);
    assert.deepEqual(mod.findMatches('a.b (x) [y]', '(x)'), [{ start: 4, end: 7 }]);
    assert.deepEqual(mod.findMatches('ÄRGER ärger', 'ärger').length, 2);
    assert.deepEqual(mod.findMatches('abc', ''), []);
    assert.equal(mod.findMatches('aaaa', 'a', 2).length, 2);
});

test('pickMatch：按选区取下一处或上一处并回绕；reset 从选区起点起找；无匹配为 -1', () => {
    const matches = [{ start: 2, end: 4 }, { start: 10, end: 12 }, { start: 20, end: 22 }];
    assert.equal(mod.pickMatch([], {}), -1);
    assert.equal(mod.pickMatch(matches, {}), 0, '无选区从第一处开始');
    assert.equal(mod.pickMatch(matches, { selStart: 10, selEnd: 12 }), 2);
    assert.equal(mod.pickMatch(matches, { selStart: 20, selEnd: 22 }), 0, '末处回绕到首处');
    assert.equal(mod.pickMatch(matches, { selStart: 2, selEnd: 4, backwards: true }), 2, '首处向上回绕到末处');
    assert.equal(mod.pickMatch(matches, { selStart: 5, selEnd: 5 }), 1, '光标在两处之间向后取下一处');
    assert.equal(mod.pickMatch(matches, { selStart: 15, selEnd: 15, backwards: true }), 1);
    assert.equal(mod.pickMatch(matches, { selStart: 25, selEnd: 25 }), 0, '光标在末处之后回绕');
    assert.equal(mod.pickMatch(matches, { selStart: 10, selEnd: 11, reset: true }), 1, 'reset 时选区起点正好是匹配处则保持');
    assert.equal(mod.pickMatch(matches, { selStart: 21, selEnd: 21, reset: true }), 0, 'reset 越过末处回绕');
    assert.equal(mod.pickMatch(matches, { selStart: 12, selEnd: 12, reset: true, backwards: true }), 1);
});

test('splitByMatches：文本按命中切为高亮片段，拼接即原文，不产生空片段，标出当前命中', () => {
    const plain = (text) => ({ text, index: -1, current: false });
    const mark = (text, index, current = false) => ({ text, index, current });
    assert.deepEqual(mod.splitByMatches('abc', []), [plain('abc')], '无命中时整段为普通文本');
    assert.deepEqual(mod.splitByMatches('', []), [], '空文本没有片段');
    assert.deepEqual(mod.splitByMatches(null, undefined), []);
    const head = 'Foo bar';
    assert.deepEqual(mod.splitByMatches(head, mod.findMatches(head, 'foo')), [mark('Foo', 0), plain(' bar')], '命中在开头不产生空的前导片段');
    const tail = 'bar foo';
    assert.deepEqual(mod.splitByMatches(tail, mod.findMatches(tail, 'foo'), 0), [plain('bar '), mark('foo', 0, true)], '命中在结尾不产生空的尾随片段');
    assert.deepEqual(mod.splitByMatches('aaaa', mod.findMatches('aaaa', 'aa'), 1), [mark('aa', 0), mark('aa', 1, true)], '相邻命中之间没有空片段');
    const text = 'x\tfoo\n\nfoo\tFOO\n';
    const segments = mod.splitByMatches(text, mod.findMatches(text, 'foo'), 1);
    assert.deepEqual(segments, [plain('x\t'), mark('foo', 0), plain('\n\n'), mark('foo', 1, true), plain('\t'), mark('FOO', 2), plain('\n')], '制表符与换行原样留在片段中');
    assert.equal(segments.map((segment) => segment.text).join(''), text, '各段依次拼接即原文');
    assert.equal(mod.splitByMatches(text, mod.findMatches(text, 'foo'), 7).filter((segment) => segment.current).length, 0, '当前下标越界时没有当前命中');
    assert.equal(mod.splitByMatches(text, mod.findMatches(text, 'foo')).filter((segment) => segment.current).length, 0, '缺省没有当前命中');
    assert.deepEqual(
        mod.splitByMatches('abcdef', [{ start: 1, end: 3 }, { start: 2, end: 4 }, { start: 4, end: 4 }, { start: 5, end: 99 }]),
        [plain('a'), mark('bc', 0), plain('de'), mark('f', 3)],
        '与前一处重叠的、空区间的命中跳过，越界终点截到文末，index 仍为原下标',
    );
});

test('lineStartOffset 与 docLocation', () => {
    assert.equal(mod.lineStartOffset('a\nbb\nccc', 0), 0);
    assert.equal(mod.lineStartOffset('a\nbb\nccc', 2), 5);
    assert.equal(mod.lineStartOffset('a\nbb', 9), 4, '超出末行时为文本长度');
    assert.equal(mod.lineStartOffset('a\nbb', -3), 0);
    assert.deepEqual(mod.docLocation('/Users/me/笔记/a.md'), { folder: '/Users/me/笔记', folderName: '笔记' });
    assert.deepEqual(mod.docLocation('C:\\docs\\x\\b.xml'), { folder: 'C:\\docs\\x', folderName: 'x' });
    assert.deepEqual(mod.docLocation('/a.md'), { folder: '/', folderName: '/' });
    assert.deepEqual(mod.docLocation('a.md'), { folder: '', folderName: '' });
});

test('outlineHintFor 与 toSaveState', () => {
    assert.equal(mod.outlineHintFor('md', 'rendered', 3), '', '有标题时无说明');
    assert.equal(mod.outlineHintFor('md', 'edit', 0), '当前文档没有标题');
    assert.equal(mod.outlineHintFor('xml', 'raw', 0), '切换到「结构视图」后可用大纲');
    assert.equal(mod.outlineHintFor('xml', 'rendered', 0), '当前文档没有可列出的章节标题');
    assert.equal(mod.outlineHintFor('pdf', 'rendered', 0), '当前文件类型不支持大纲');
    assert.equal(mod.toSaveState(null), null);
    assert.equal(mod.toSaveState({ state: 'idle', label: '' }), null, '无文案（idle）不显示');
    assert.deepEqual(mod.toSaveState({ state: 'conflict', label: '文件已在外部修改', message: '文件已被删除或移动' }), { state: 'conflict', label: '文件已在外部修改', message: '文件已被删除或移动' });
    assert.deepEqual(mod.toSaveState({ state: 'saved', label: '已保存' }), { state: 'saved', label: '已保存', message: '' });
});
