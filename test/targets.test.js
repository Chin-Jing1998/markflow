/**
 * converters/targets.js 单元测试
 * 覆盖：默认目标、显式目标校验、非法目标与非法输入类型、路径归一化、URL 识别
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveTarget, classifyInput, DEFAULT_TARGETS, TARGETS } = require('../converters/targets');

// ============================================================
// resolveTarget
// ============================================================

test('未指定目标时，办公文档与网页取 bundle，Markdown 取 docx', () => {
    // Arrange
    const officeTypes = ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'pdf'];

    // Act & Assert
    officeTypes.forEach((type) => assert.equal(resolveTarget(type), 'bundle'));
    assert.equal(resolveTarget('url'), 'bundle');
    assert.equal(resolveTarget('md'), 'docx');
});

test('空字符串与 null 视同未指定目标，回退默认值', () => {
    assert.equal(resolveTarget('md', ''), 'docx');
    assert.equal(resolveTarget('md', null), 'docx');
    assert.equal(resolveTarget('pdf', undefined), 'bundle');
});

test('显式目标与输入类型匹配时原样返回', () => {
    assert.equal(resolveTarget('md', 'docx'), 'docx');
    assert.equal(resolveTarget('md', 'pdf'), 'pdf');
    assert.equal(resolveTarget('docx', 'bundle'), 'bundle');
    assert.equal(resolveTarget('url', 'bundle'), 'bundle');
});

test('目标与输入类型不匹配时抛中文错误并说明原因', () => {
    assert.throws(() => resolveTarget('md', 'bundle'), /目标 bundle 不接受 md 输入：bundle 仅接受 Office、PDF 文件与网页输入/);
    assert.throws(() => resolveTarget('pdf', 'docx'), /目标 docx 不接受 pdf 输入：docx 仅接受 Markdown 输入/);
    assert.throws(() => resolveTarget('url', 'pdf'), /目标 pdf 不接受 url 输入：pdf 仅接受 Markdown 输入/);
});

test('未知目标格式抛错并列出可选值', () => {
    assert.throws(() => resolveTarget('md', 'html'), /不支持的目标格式：html（可选：bundle、docx、pdf）/);
});

test('未知输入类型抛错；空值以「(空)」占位', () => {
    assert.throws(() => resolveTarget('txt', 'docx'), /不支持的输入类型：txt/);
    assert.throws(() => resolveTarget(null), /不支持的输入类型：\(空\)/);
});

test('导出的常量与实现一致', () => {
    assert.deepEqual(TARGETS, ['bundle', 'docx', 'pdf']);
    assert.equal(DEFAULT_TARGETS.md, 'docx');
    assert.equal(DEFAULT_TARGETS.url, 'bundle');
});

// ============================================================
// classifyInput
// ============================================================

test('相对路径按 cwd 解析为绝对路径，并识别输入类型', () => {
    // Arrange
    const cwd = path.resolve('/tmp/markflow-cwd');

    // Act
    const result = classifyInput('docs/a.md', cwd);

    // Assert
    assert.deepEqual(result, { input: { path: path.join(cwd, 'docs', 'a.md') }, type: 'md' });
});

test('绝对路径原样保留', () => {
    const abs = path.resolve('/tmp/markflow-cwd/b.docx');
    assert.deepEqual(classifyInput(abs, '/other'), { input: { path: abs }, type: 'docx' });
});

test('http(s) 网址归类为 url，不做路径解析', () => {
    assert.deepEqual(classifyInput('https://example.com/a', '/tmp'), {
        input: { url: 'https://example.com/a' },
        type: 'url',
    });
    assert.equal(classifyInput('http://example.com', '/tmp').type, 'url');
});

test('首尾空白被裁剪后再识别', () => {
    const result = classifyInput('  https://example.com  ', '/tmp');
    assert.deepEqual(result.input, { url: 'https://example.com' });
});

test('省略 cwd 时按 process.cwd() 解析', () => {
    const result = classifyInput('a.md');
    assert.equal(result.input.path, path.join(process.cwd(), 'a.md'));
});

test('空输入与非字符串输入抛「输入不能为空」', () => {
    assert.throws(() => classifyInput('', '/tmp'), /输入不能为空/);
    assert.throws(() => classifyInput('   ', '/tmp'), /输入不能为空/);
    assert.throws(() => classifyInput(null, '/tmp'), /输入不能为空/);
});

test('不支持的扩展名抛错并列出受支持格式', () => {
    assert.throws(() => classifyInput('a.txt', '/tmp'), /不支持的输入格式：a\.txt（支持 .*\.md.*http\(s\) 网址）/);
    assert.throws(() => classifyInput('ftp://example.com/a', '/tmp'), /不支持的输入格式/);
});
