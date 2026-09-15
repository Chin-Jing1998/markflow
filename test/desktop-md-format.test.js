/**
 * desktop/renderer/js/md-format.mjs 单元测试（渲染层纯函数，Node 经 import() 载入）
 * 覆盖：行内标记的加 / 去（选区自带、紧贴两侧、空选区）、* 与 ** 的区分、首尾空白挪到标记外、多行逐行包裹且跳过列表前缀、
 *       行内代码含反引号；lineStyleAt；setHeading（含引用前缀、多行跳过空行）；toggleLinePrefix 四种前缀的加 / 去 / 互换；
 *       insertBlock 自动补空行与块内选区；buildTable；insertFootnote 编号与文末定义；buildLink 与 buildImageTag 的转义。
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let fmt;
before(async () => {
    fmt = await import(pathToFileURL(path.join(__dirname, '..', 'desktop', 'renderer', 'js', 'md-format.mjs')).href);
});

/** 把编辑结果套回原文，返回新文本与新选区 */
function apply(value, edit) {
    return { value: `${value.slice(0, edit.from)}${edit.text}${value.slice(edit.to)}`, start: edit.selStart, end: edit.selEnd };
}
const selected = (after) => after.value.slice(after.start, after.end);
const run = (value, start, end, fn) => apply(value, fn({ value, start, end }));

// ============================================================
// 行内标记
// ============================================================

test('toggleInline：加粗加上后选区仍是原文字，再切换即去掉（选区在标记内 / 连标记一起选中）', () => {
    const added = run('hello world', 6, 11, (state) => fmt.toggleInline(state, '**'));
    assert.equal(added.value, 'hello **world**');
    assert.equal(selected(added), 'world');
    const removedInside = run(added.value, added.start, added.end, (state) => fmt.toggleInline(state, '**'));
    assert.equal(removedInside.value, 'hello world');
    assert.equal(selected(removedInside), 'world');
    const removedWhole = run('hello **world**', 6, 15, (state) => fmt.toggleInline(state, '**'));
    assert.equal(removedWhole.value, 'hello world');
});

test('toggleInline：判断斜体时排除 **（按两侧星号连续数的奇偶）', () => {
    const italicOnBold = run('a **b** c', 4, 5, (state) => fmt.toggleInline(state, '*'));
    assert.equal(italicOnBold.value, 'a ***b*** c', '粗体里再加斜体');
    const boldOff = run(italicOnBold.value, 5, 6, (state) => fmt.toggleInline(state, '**'));
    assert.equal(boldOff.value, 'a *b* c', '去掉粗体留下斜体');
    const italicOff = run('a *b* c', 3, 4, (state) => fmt.toggleInline(state, '*'));
    assert.equal(italicOff.value, 'a b c');
    const boldOnItalic = run('*x*', 0, 3, (state) => fmt.toggleInline(state, '**'));
    assert.equal(boldOnItalic.value, '***x***', '整段选中的斜体不是粗体，应加上粗体');
});

test('toggleInline：首尾空白挪到标记外；多行逐行包裹并跳过列表前缀；空行原样', () => {
    const spaced = run('say  hi  there', 3, 9, (state) => fmt.toggleInline(state, '~~'));
    assert.equal(spaced.value, 'say  ~~hi~~  there');
    assert.equal(selected(spaced), 'hi');
    const multi = run('- a\n\n- b', 0, 8, (state) => fmt.toggleInline(state, '**'));
    assert.equal(multi.value, '- **a**\n\n- **b**');
    const plain = run('one\ntwo', 0, 7, (state) => fmt.toggleInline(state, '<u>', '</u>'));
    assert.equal(plain.value, '<u>one</u>\n<u>two</u>');
});

test('toggleInline：空选区插入一对标记、光标居中；光标夹在空标记之间再切换即去掉', () => {
    const inserted = run('ab', 1, 1, (state) => fmt.toggleInline(state, '**'));
    assert.equal(inserted.value, 'a****b');
    assert.equal(inserted.start, 3);
    assert.equal(inserted.end, 3);
    const removed = run(inserted.value, inserted.start, inserted.end, (state) => fmt.toggleInline(state, '**'));
    assert.equal(removed.value, 'ab');
    assert.equal(removed.start, 1);
});

test('toggleInline：下划线写 <u>…</u>，行内代码内容含反引号时改用更长的反引号串', () => {
    const underline = run('x y', 0, 1, (state) => fmt.toggleInline(state, '<u>', '</u>'));
    assert.equal(underline.value, '<u>x</u> y');
    assert.equal(run(underline.value, 3, 4, (state) => fmt.toggleInline(state, '<u>', '</u>')).value, 'x y');
    assert.equal(run('a`b', 0, 3, (state) => fmt.toggleInline(state, '`')).value, '``a`b``');
    assert.equal(run('`x', 0, 2, (state) => fmt.toggleInline(state, '`')).value, '`` `x ``');
});

// ============================================================
// 行级样式
// ============================================================

test('lineStyleAt：识别标题级别（含引用里的标题）与行前缀类型', () => {
    const doc = '# T\n## U\nbody\n> ### Q\n- [ ] task\n1. one\n- item';
    assert.deepEqual(fmt.lineStyleAt(doc, 1), { heading: 1, prefix: null });
    assert.deepEqual(fmt.lineStyleAt(doc, 5), { heading: 2, prefix: null });
    assert.deepEqual(fmt.lineStyleAt(doc, 10), { heading: 0, prefix: null });
    assert.deepEqual(fmt.lineStyleAt(doc, doc.indexOf('Q')), { heading: 3, prefix: 'quote' });
    assert.equal(fmt.lineStyleAt(doc, doc.indexOf('task')).prefix, 'task');
    assert.equal(fmt.lineStyleAt(doc, doc.indexOf('one')).prefix, 'ordered');
    assert.equal(fmt.lineStyleAt(doc, doc.length).prefix, 'bullet');
    assert.equal(fmt.lineStyleAt('#hashtag', 0).heading, 0, '井号后无空格不是标题');
});

test('setHeading：设级别 / 改级别 / 回正文，光标随前缀平移；引用前缀保留；多行跳过空行', () => {
    const h2 = run('Title', 0, 0, (state) => fmt.setHeading(state, 2));
    assert.equal(h2.value, '## Title');
    assert.equal(h2.start, 3);
    assert.equal(run('### Title', 6, 6, (state) => fmt.setHeading(state, 0)).value, 'Title');
    assert.equal(run('# A', 3, 3, (state) => fmt.setHeading(state, 3)).value, '### A');
    assert.equal(run('> x', 2, 2, (state) => fmt.setHeading(state, 2)).value, '> ## x');
    assert.equal(run('a\n\nb', 0, 4, (state) => fmt.setHeading(state, 1)).value, '# a\n\n# b');
    assert.equal(run('a\nb\nc', 0, 4, (state) => fmt.setHeading(state, 1)).value, '# a\n# b\nc', '选区止于下一行行首时不改那一行');
});

test('toggleLinePrefix：无序 / 有序 / 任务列表的加、去与互换，缩进保留', () => {
    const bullet = run('a\nb', 0, 3, (state) => fmt.toggleLinePrefix(state, 'bullet'));
    assert.equal(bullet.value, '- a\n- b');
    assert.equal(run(bullet.value, 0, bullet.value.length, (state) => fmt.toggleLinePrefix(state, 'bullet')).value, 'a\nb');
    assert.equal(run('a\nb\nc', 0, 5, (state) => fmt.toggleLinePrefix(state, 'ordered')).value, '1. a\n2. b\n3. c');
    assert.equal(run('- a', 0, 0, (state) => fmt.toggleLinePrefix(state, 'task')).value, '- [ ] a');
    assert.equal(run('- [ ] a', 0, 0, (state) => fmt.toggleLinePrefix(state, 'bullet')).value, '- a');
    assert.equal(run('  - a', 4, 4, (state) => fmt.toggleLinePrefix(state, 'ordered')).value, '  1. a');
    const caret = run('text', 2, 2, (state) => fmt.toggleLinePrefix(state, 'bullet'));
    assert.equal(caret.start, 4, '光标随前缀右移');
    assert.throws(() => fmt.toggleLinePrefix({ value: 'a', start: 0, end: 0 }, 'heading'), /未知的行前缀类型/);
});

test('toggleLinePrefix：引用逐行加 > （选区内空行补 >），全是引用时去掉', () => {
    const quoted = run('a\n\nb', 0, 4, (state) => fmt.toggleLinePrefix(state, 'quote'));
    assert.equal(quoted.value, '> a\n>\n> b');
    assert.equal(run(quoted.value, 0, quoted.value.length, (state) => fmt.toggleLinePrefix(state, 'quote')).value, 'a\n\nb');
    assert.equal(run('', 0, 0, (state) => fmt.toggleLinePrefix(state, 'quote')).value, '> ');
});

// ============================================================
// 块级插入
// ============================================================

test('insertBlock：自动补前后空行，文末补换行，块内选区按偏移定位', () => {
    assert.equal(run('text', 4, 4, (state) => fmt.insertBlock(state, '---')).value, 'text\n\n---\n');
    assert.equal(run('', 0, 0, (state) => fmt.insertBlock(state, '---')).value, '---\n');
    assert.equal(run('a\n', 2, 2, (state) => fmt.insertBlock(state, '---')).value, 'a\n\n---\n');
    assert.equal(run('a\nb', 1, 1, (state) => fmt.insertBlock(state, '---')).value, 'a\n\n---\n\nb');
    assert.equal(run('a\n\nb', 2, 2, (state) => fmt.insertBlock(state, '---')).value, 'a\n\n---\n\nb');
    const code = run('x', 1, 1, (state) => fmt.insertBlock(state, '```\n\n```', { selectFrom: 4, selectTo: 4 }));
    assert.equal(code.value, 'x\n\n```\n\n```\n');
    assert.equal(code.start, 'x\n\n```\n'.length);
});

test('buildTable：表头行 + 分隔行 + 表体，行数含表头且有下限', () => {
    const table = fmt.buildTable(3, 3).split('\n');
    assert.deepEqual(table, ['| 列 1 | 列 2 | 列 3 |', '| --- | --- | --- |', '|   |   |   |', '|   |   |   |']);
    assert.equal(fmt.buildTable().split('\n').length, 4, '默认 3×3');
    assert.deepEqual(fmt.buildTable(1, 0).split('\n'), ['| 列 1 |', '| --- |', '|   |']);
});

test('insertFootnote：编号取已有数字编号最大值 + 1，文末追加定义并把光标放到定义处', () => {
    const first = apply('text', fmt.insertFootnote('text', 4));
    assert.equal(first.value, 'text[^1]\n\n[^1]: \n');
    assert.equal(first.start, first.value.length - 1);
    const next = fmt.insertFootnote('a [^1] b [^3]', 0);
    assert.ok(next.text.startsWith('[^4]'));
    const appended = apply('a[^1]\n\n[^1]: x\n', fmt.insertFootnote('a[^1]\n\n[^1]: x\n', 1));
    assert.equal(appended.value, 'a[^2][^1]\n\n[^1]: x\n[^2]: \n', '文末已是脚注定义时紧接其后');
});

// ============================================================
// 链接与图片
// ============================================================

test('buildLink：文字中的 ] 与 \\ 转义；网址含空白或括号时写成 <网址>；文字为空时用网址', () => {
    assert.equal(fmt.buildLink({ text: 'a]b', url: 'https://x.com' }), '[a\\]b](https://x.com)');
    assert.equal(fmt.buildLink({ text: 'C:\\dir', url: 'https://x.com' }), '[C:\\\\dir](https://x.com)');
    assert.equal(fmt.buildLink({ text: '空格', url: 'https://x.com/a b' }), '[空格](<https://x.com/a b>)');
    assert.equal(fmt.buildLink({ text: '括号', url: 'https://x.com/(a)' }), '[括号](<https://x.com/(a)>)');
    assert.equal(fmt.buildLink({ text: '', url: 'https://x.com' }), '[https://x.com](https://x.com)');
    assert.equal(fmt.buildLink({ text: 't', url: 'https://x.com/<a>' }), '[t](https://x.com/%3Ca%3E)');
});

test('buildImageTag：属性值转义，宽度取整；无有效宽度不写 width', () => {
    assert.equal(fmt.buildImageTag({ src: 'images/a b.png', width: 320.4, alt: '图"1"' }), '<img src="images/a b.png" width="320" alt="图&quot;1&quot;">');
    assert.equal(fmt.buildImageTag({ src: 'images/x.png', alt: 'x' }), '<img src="images/x.png" alt="x">');
    assert.equal(fmt.buildImageTag({ src: 'a&b<c>.png', width: 0, alt: '' }), '<img src="a&amp;b&lt;c&gt;.png" alt="">');
    assert.equal(fmt.buildImageTag({ src: 'x.png', width: 'abc' }), '<img src="x.png" alt="">');
});
