/**
 * converters/targets.js 单元测试
 * 覆盖：默认目标、显式目标校验、非法目标与非法输入类型、规则表五项（classes/layout/ext/hint）、
 *       html/xml 接受三类输入、listTargets 由规则派生、旧二进制格式不再受理、路径归一化、URL 识别、
 *       resolveUserPath（~ 展开、file:// 转换、Windows 写法、错误文案）与 classifyInput 受理 ~ / file://、
 *       专利五书 XML 的三种输入（.xml、案卷 .zip、由调用方判定的五书目录）归入 markup 类且默认目标为 docx、
 *       目录展开白名单 DIRECTORY_SCAN_EXTENSIONS 不含只在显式给出时受理的 .xml 与 .zip
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    resolveTarget, classifyInput, assertTargetAllowed, getTargetRule, listTargets, detectInputType,
    DEFAULT_TARGETS, TARGETS, TARGET_RULES, INPUT_CLASS, SUPPORTED_EXTENSIONS,
    DIRECTORY_SCAN_EXTENSIONS, EXPLICIT_ONLY_EXTENSIONS, BUNDLE_DIR_TYPE,
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
    assert.throws(() => resolveTarget('pdf', 'docx'), /目标 docx 不接受 pdf 输入：docx 仅接受 Markdown 与专利五书 XML（\.xml、案卷 \.zip、五书目录）输入/);
    assert.throws(() => resolveTarget('url', 'pdf'), /目标 pdf 不接受 url 输入：pdf 仅接受 Markdown 与专利五书 XML（\.xml、案卷 \.zip、五书目录）输入/);
    assert.throws(() => resolveTarget('zip', 'bundle'), /目标 bundle 不接受 zip 输入：bundle 仅接受 Office、PDF 文件与网页输入/);
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
        inputs: { docx: 'office', xlsx: 'office', pptx: 'office', pdf: 'office', md: 'markup', xml: 'markup', zip: 'markup', url: 'url' },
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

// ============================================================
// resolveUserPath 与 classifyInput 的本地路径写法（~、file://）
// ============================================================

const os = require('node:os');
const url = require('node:url');
const { resolveUserPath } = require('../converters/targets');

test('resolveUserPath：~ 与 ~/ 展开为主目录，其余写法原样返回', () => {
    assert.equal(resolveUserPath('~'), os.homedir());
    assert.equal(resolveUserPath('~/'), os.homedir());
    assert.equal(resolveUserPath('~/资料/a.docx'), path.join(os.homedir(), '资料', 'a.docx'));
    for (const raw of ['docs/a.md', '/abs/a.md', '~other/a.md', 'a~/b.md', ' ~/a.md', 'https://example.com/a', '']) {
        assert.equal(resolveUserPath(raw), raw, JSON.stringify(raw));
    }
    assert.equal(resolveUserPath(null), null);
    assert.equal(resolveUserPath(42), 42);
});

test('resolveUserPath：~\\ 仅在 Windows 下展开；homedir 与 platform 可注入', () => {
    const win = { homedir: 'C:\\Users\\me', platform: 'win32' };
    assert.equal(resolveUserPath('~\\资料\\a.docx', win), 'C:\\Users\\me\\资料\\a.docx');
    assert.equal(resolveUserPath('~/资料/a.docx', win), 'C:\\Users\\me\\资料\\a.docx');
    assert.equal(resolveUserPath('~', win), 'C:\\Users\\me');
    assert.equal(resolveUserPath('~\\资料', { homedir: '/home/me', platform: 'linux' }), '~\\资料');
    assert.equal(resolveUserPath('~/资料', { homedir: '/home/me', platform: 'linux' }), '/home/me/资料');
});

test('resolveUserPath：file:// 地址转为本地路径（百分号解码、scheme 不分大小写、Windows 盘符）', () => {
    assert.equal(resolveUserPath('file:///tmp/%E6%8A%A5%E5%91%8A%20v1.docx', { platform: 'darwin' }), '/tmp/报告 v1.docx');
    assert.equal(resolveUserPath('FILE:///tmp/a.md', { platform: 'linux' }), '/tmp/a.md');
    assert.equal(resolveUserPath('file://localhost/tmp/a.md', { platform: 'linux' }), '/tmp/a.md');
    assert.equal(resolveUserPath('file:///C:/Users/me/a.docx', { platform: 'win32' }), 'C:\\Users\\me\\a.docx');
});

test('resolveUserPath：无法转换的 file:// 地址抛中文错误', () => {
    assert.throws(
        () => resolveUserPath('file://server/share/a.docx', { platform: 'darwin' }),
        /无法识别的 file:\/\/ 地址：file:\/\/server\/share\/a\.docx/,
    );
    assert.throws(() => resolveUserPath('file:///tmp/a%2Fb.md', { platform: 'linux' }), /无法识别的 file:\/\/ 地址/);
});

test('classifyInput：~ 与 file:// 输入按本地文件归类为绝对路径', () => {
    assert.deepEqual(classifyInput('~/资料/a.docx', '/other'), {
        input: { path: path.join(os.homedir(), '资料', 'a.docx') },
        type: 'docx',
    });
    const abs = path.resolve('/tmp/markflow-cwd/报告 1.pdf');
    assert.deepEqual(classifyInput(`  ${url.pathToFileURL(abs).href}  `, '/other'), { input: { path: abs }, type: 'pdf' });
});

test('classifyInput：file:// 指向不支持的格式或无法转换时抛中文错误', () => {
    // file:///tmp/a.txt 只在类 Unix 上是合法的本地文件 URL；Windows 要求带盘符，
    // fileURLToPath 会先以「File URL path must be absolute」抛错，落不到「格式不受支持」这一分支。
    // 故按本机语义构造 URL（与上一用例同法），三平台断言的都是同一条分支。
    const txtUrl = url.pathToFileURL(path.resolve('/tmp/a.txt')).href;
    assert.throws(() => classifyInput(txtUrl, '/tmp'), (err) => {
        assert.ok(err.message.startsWith(`不支持的输入格式：${txtUrl}`), err.message);
        return true;
    });
    assert.throws(() => classifyInput('file:///tmp/a%2Fb.md', '/tmp'), /无法识别的 file:\/\/ 地址/);
});

// ============================================================
// 专利五书 XML 反向导入的输入类型
// ============================================================

test('.xml 与 .zip 识别为 xml / zip 输入，归入 markup 类，未指定目标时取 docx；bundle 不受理', () => {
    assert.equal(detectInputType('/案卷/100001.XML'), 'xml');
    assert.equal(detectInputType('案卷.Zip'), 'zip');
    for (const type of ['xml', 'zip']) {
        assert.equal(INPUT_CLASS[type], 'markup');
        assert.equal(DEFAULT_TARGETS[type], 'docx');
        assert.equal(resolveTarget(type), 'docx');
        for (const target of ['docx', 'pdf', 'html', 'xml']) assert.equal(resolveTarget(type, target), target);
        assert.throws(() => resolveTarget(type, 'bundle'), new RegExp(`目标 bundle 不接受 ${type} 输入`));
    }
    assert.deepEqual(classifyInput('sub/案卷.zip', '/work'), { input: { path: path.resolve('/work', 'sub/案卷.zip') }, type: 'zip' });
});

test('目录展开白名单 = 受理扩展名去掉只在显式给出时受理的 .xml 与 .zip', () => {
    assert.deepEqual(EXPLICIT_ONLY_EXTENSIONS, ['.xml', '.zip']);
    assert.deepEqual(DIRECTORY_SCAN_EXTENSIONS, ['.docx', '.xlsx', '.pptx', '.pdf', '.md', '.markdown']);
    assert.deepEqual(SUPPORTED_EXTENSIONS, [...DIRECTORY_SCAN_EXTENSIONS, ...EXPLICIT_ONLY_EXTENSIONS]);
    for (const list of [EXPLICIT_ONLY_EXTENSIONS, DIRECTORY_SCAN_EXTENSIONS, SUPPORTED_EXTENSIONS]) assert.ok(Object.isFrozen(list));
});

test('classifyInput：调用方判定的专利五书目录不看扩展名，类型为 xml；未列入的目录照旧按扩展名拒绝', () => {
    const dir = path.resolve('/work', '案卷-2026.09.18');
    assert.equal(BUNDLE_DIR_TYPE, 'xml');
    assert.deepEqual(classifyInput('案卷-2026.09.18', '/work', { bundleDirs: [dir] }), { input: { path: dir }, type: 'xml' });
    assert.deepEqual(classifyInput('案卷-2026.09.18', '/work', { bundleDirs: new Set([dir]) }), { input: { path: dir }, type: 'xml' });
    assert.throws(() => classifyInput('案卷-2026.09.18', '/work'), /不支持的输入格式：案卷-2026\.09\.18（支持 .*\.xml \.zip、专利五书目录与 http\(s\) 网址）/);
    assert.throws(() => classifyInput('别的目录', '/work', { bundleDirs: [dir] }), /不支持的输入格式/);
    // 列入的目录即便名字像别的类型也按五书目录处理；网址不受影响
    assert.deepEqual(classifyInput('x.md', '/work', { bundleDirs: [path.resolve('/work', 'x.md')] }).type, 'xml');
    assert.equal(classifyInput('https://example.com/a.zip', '/work', { bundleDirs: [dir] }).type, 'url');
});
