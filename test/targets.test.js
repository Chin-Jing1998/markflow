/**
 * converters/targets.js 单元测试
 * 覆盖：默认目标、显式目标校验、非法目标与非法输入类型、规则表五项（classes/layout/ext/hint）、
 *       html/xml 接受三类输入、listTargets 由规则派生、旧二进制格式不再受理、路径归一化、URL 识别
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    resolveTarget, classifyInput, assertTargetAllowed, getTargetRule, listTargets, detectInputType,
    DEFAULT_TARGETS, TARGETS, TARGET_RULES, INPUT_CLASS, SUPPORTED_EXTENSIONS,
} = require('../converters/targets');

// ============================================================
// resolveTarget
// ============================================================

test('未指定目标时，办公文档与网页取 bundle，Markdown 取 docx', () => {
    // Arrange
    const officeTypes = ['docx', 'xlsx', 'pptx', 'pdf'];

    // Act & Assert
    officeTypes.forEach((type) => assert.equal(resolveTarget(type), 'bundle'));
    assert.equal(resolveTarget('url'), 'bundle');
    assert.equal(resolveTarget('md'), 'docx');
});

test('旧二进制格式 doc/xls/ppt 不再受理', () => {
    for (const ext of ['.doc', '.xls', '.ppt']) assert.equal(SUPPORTED_EXTENSIONS.includes(ext), false, ext);
    assert.equal(detectInputType('x.doc'), null);
    assert.equal(detectInputType('x.XLS'), null);
    assert.equal(detectInputType('x.ppt'), null);
    assert.equal('doc' in INPUT_CLASS, false);
    assert.throws(() => resolveTarget('doc', 'bundle'), /不支持的输入类型：doc/);
    assert.throws(() => classifyInput('a.doc', '/tmp'), /不支持的输入格式：a\.doc/);
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
    assert.throws(() => resolveTarget('md', 'epub'), /不支持的目标格式：epub（可选：bundle、docx、pdf、html、xml）/);
    assert.throws(() => getTargetRule('epub'), /不支持的目标格式：epub/);
});

test('未知输入类型抛错；空值以「(空)」占位', () => {
    assert.throws(() => resolveTarget('txt', 'docx'), /不支持的输入类型：txt/);
    assert.throws(() => resolveTarget(null), /不支持的输入类型：\(空\)/);
});

test('导出的常量与实现一致', () => {
    assert.deepEqual(TARGETS, ['bundle', 'docx', 'pdf', 'html', 'xml']);
    assert.equal(DEFAULT_TARGETS.md, 'docx');
    assert.equal(DEFAULT_TARGETS.url, 'bundle');
    assert.ok(Object.isFrozen(TARGET_RULES));
});

// ============================================================
// 规则表
// ============================================================

test('规则表五项各含 classes / layout / ext / hint，单文件布局只有 docx 与 pdf', () => {
    for (const target of TARGETS) {
        const rule = TARGET_RULES[target];
        assert.ok(Array.isArray(rule.classes) && rule.classes.length > 0, target);
        assert.ok(['single', 'folder'].includes(rule.layout), target);
        assert.equal(typeof rule.ext, 'string', target);
        assert.equal(typeof rule.hint, 'string', target);
        assert.equal(getTargetRule(target), rule);
    }
    assert.deepEqual(TARGETS.filter((target) => TARGET_RULES[target].layout === 'single'), ['docx', 'pdf']);
    assert.deepEqual(
        Object.fromEntries(TARGETS.map((target) => [target, TARGET_RULES[target].ext])),
        { bundle: 'md', docx: 'docx', pdf: 'pdf', html: 'html', xml: 'xml' },
    );
});

test('html 与 xml 接受 office、markup、url 三类输入', () => {
    for (const target of ['html', 'xml']) {
        for (const type of ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'url']) {
            assert.doesNotThrow(() => assertTargetAllowed(target, type), `${target} ← ${type}`);
            assert.equal(resolveTarget(type, target), target);
        }
    }
});

// ============================================================
// listTargets
// ============================================================

test('listTargets 由规则派生：pdf 目标仅在 PDF 后端可用时列出，不再有 sofficeAvailable', () => {
    assert.deepEqual(listTargets(), {
        office: ['bundle', 'html', 'xml'],
        markup: ['docx', 'html', 'xml'],
        url: ['bundle', 'html', 'xml'],
        inputs: { docx: 'office', xlsx: 'office', pptx: 'office', pdf: 'office', md: 'markup', url: 'url' },
        capabilities: { pdfBackend: null },
    });

    const backend = { name: 'electron-worker', available: true, hint: '' };
    const withPdf = listTargets({ pdfBackend: backend });
    assert.deepEqual(withPdf.markup, ['docx', 'pdf', 'html', 'xml']);
    assert.deepEqual(withPdf.office, ['bundle', 'html', 'xml']);
    assert.deepEqual(withPdf.url, ['bundle', 'html', 'xml']);
    assert.deepEqual(withPdf.capabilities, { pdfBackend: backend });
    assert.equal('sofficeAvailable' in withPdf.capabilities, false);
    assert.equal('markdown' in withPdf.inputs, false);
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
