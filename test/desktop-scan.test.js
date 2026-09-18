/**
 * desktop/main/scan.js 单元测试（纯逻辑）
 * 覆盖：目录递归、扩展名过滤、隐藏项与 node_modules/.git 跳过、直接给出的不支持文件记入 unsupported、
 *       去重（重复给出 / 文件与其父目录同时给出）、稳定排序、不存在路径忽略、maxFiles 截断、maxDepth、符号链接成环。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { scanPaths, expandPaths, normalizeExts, DEFAULT_MAX_DEPTH, DEFAULT_MAX_FILES } = require('../desktop/main/scan');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'scan-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (rel, content = 'x') => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
};

const tree = path.join(root, 'tree');
const files = {
    a: write('tree/a.md', '# a'),
    b: write('tree/B.docx', 'docx'),
    c: write('tree/sub/c.pptx', 'pptx'),
    d: write('tree/sub/deep/d.xlsx', 'xlsx'),
    e: write('tree/sub/e.PDF', '%PDF'),
    markdown: write('tree/notes.markdown', '# n'),
};
write('tree/unsupported.txt');
write('tree/sub/.hidden.md');
write('tree/.hiddendir/x.md');
write('tree/node_modules/pkg/readme.md');
write('tree/.git/HEAD');
const looseUnsupported = write('loose.txt');
const looseHidden = write('.hidden-loose.md', '# hidden');
let loopReady = true;
try {
    fs.symlinkSync('..', path.join(tree, 'sub', 'loop'));
} catch (err) {
    loopReady = false;
}

test('目录递归收集、过滤扩展名、跳过隐藏项与 node_modules / .git', async () => {
    const { files: found, unsupported, truncated } = await scanPaths([tree]);
    assert.deepEqual(found.map((entry) => entry.path), [files.b, files.a, files.markdown, files.d, files.c, files.e]
        .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    assert.equal(unsupported.length, 0, '目录内的不支持文件静默跳过');
    assert.equal(truncated, false);
    const md = found.find((entry) => entry.path === files.a);
    assert.deepEqual(md, { path: files.a, name: 'a.md', ext: '.md', type: 'md', size: 3 });
    assert.equal(found.find((entry) => entry.path === files.e).type, 'pdf', '扩展名大小写不敏感');
    assert.ok(found.every((entry) => !entry.path.includes('node_modules') && !entry.path.includes('.hidden')));
});

test('直接给出的文件：不支持的记入 unsupported，隐藏文件仍接受，不存在的忽略', async () => {
    const { files: found, unsupported } = await scanPaths([looseUnsupported, looseHidden, path.join(root, 'missing.md')]);
    assert.deepEqual(found.map((entry) => entry.path), [looseHidden]);
    assert.deepEqual(unsupported, [looseUnsupported]);
});

test('去重：重复路径、文件与父目录同时给出只出现一次；结果稳定排序', async () => {
    const once = await expandPaths([files.a, files.a, tree, path.join(tree, '..', 'tree', 'a.md')]);
    const paths = once.map((entry) => entry.path);
    assert.equal(new Set(paths).size, paths.length);
    assert.equal(paths.filter((item) => item === files.a).length, 1);
    const reversed = await expandPaths([tree, files.a]);
    assert.deepEqual(reversed.map((entry) => entry.path), paths, '入参顺序不影响输出顺序');
    const sorted = [...paths].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    assert.deepEqual(paths, sorted);
});

test('maxDepth 与 maxFiles 生效并标记 truncated', async () => {
    const shallow = await scanPaths([tree], { maxDepth: 0 });
    assert.deepEqual(shallow.files.map((entry) => entry.name), ['B.docx', 'a.md', 'notes.markdown']);
    const capped = await scanPaths([tree], { maxFiles: 2 });
    assert.equal(capped.files.length, 2);
    assert.equal(capped.truncated, true);
    assert.equal(DEFAULT_MAX_DEPTH, 8);
    assert.equal(DEFAULT_MAX_FILES, 2000);
});

test('exts 可覆盖白名单；非法值回退默认', async () => {
    const onlyMd = await scanPaths([tree], { exts: ['md', '.MARKDOWN'] });
    assert.deepEqual(onlyMd.files.map((entry) => entry.name), ['a.md', 'notes.markdown']);
    assert.deepEqual([...normalizeExts(['', 42])], ['.docx', '.xlsx', '.pptx', '.pdf', '.md', '.markdown']);
    assert.deepEqual([...normalizeExts(undefined)], ['.docx', '.xlsx', '.pptx', '.pdf', '.md', '.markdown']);
});

test('符号链接成环不重复进入，非字符串入参忽略', async (t) => {
    if (!loopReady) {
        t.skip('本机无法创建符号链接');
        return;
    }
    const { files: found } = await scanPaths([tree, null, 42, '']);
    assert.equal(found.filter((entry) => entry.name === 'a.md').length, 1);
    assert.ok(found.every((entry) => !entry.path.includes(`${path.sep}loop${path.sep}loop${path.sep}`)));
});

test('空入参与非数组入参返回空结果', async () => {
    assert.deepEqual(await scanPaths([]), { files: [], unsupported: [], truncated: false });
    assert.deepEqual(await scanPaths('not-an-array'), { files: [], unsupported: [], truncated: false });
});

// ============================================================
// 文件库浏览范围（mf:paths:expand scope:'browse'）
// ============================================================

const { BROWSE_EXTENSIONS, READER_EXTENSIONS } = require('../desktop/main/file-kinds');
const { SUPPORTED_EXTENSIONS, DIRECTORY_SCAN_EXTENSIONS, EXPLICIT_ONLY_EXTENSIONS } = require('../converters/targets');

const browse = path.join(root, 'browse');
const browseFiles = ['browse/page.html', 'browse/old.htm', 'browse/sub/data.xml', 'browse/sub/data.json', 'browse/note.md', 'browse/skip.txt'];
for (const rel of browseFiles) write(rel, 'x');

test('browse 范围列出 .html / .htm / .xml / .json 与转档白名单内的文件', async () => {
    const { files: found } = await scanPaths([browse], { exts: BROWSE_EXTENSIONS });
    assert.deepEqual(found.map((entry) => path.relative(root, entry.path).split(path.sep).join('/')).sort(),
        ['browse/note.md', 'browse/old.htm', 'browse/page.html', 'browse/sub/data.json', 'browse/sub/data.xml']);
});

test('默认范围（转档入口）仍不含 html / xml / json（回归守卫）', async () => {
    const { files: found } = await scanPaths([browse]);
    assert.deepEqual(found.map((entry) => entry.name), ['note.md']);
    // .xml 与 .zip 自专利五书反向导入起列入 SUPPORTED_EXTENSIONS，但只在显式给出时受理：
    // 转档入口的默认扫描范围（DIRECTORY_SCAN_EXTENSIONS）不得因此放宽
    assert.ok(![...normalizeExts(undefined)].some((ext) => ['.html', '.htm', '.xml', '.json', '.zip'].includes(ext)), '转档入口的默认扫描范围不得放宽');
    assert.deepEqual(DIRECTORY_SCAN_EXTENSIONS, SUPPORTED_EXTENSIONS.filter((ext) => !EXPLICIT_ONLY_EXTENSIONS.includes(ext)));
    assert.deepEqual(EXPLICIT_ONLY_EXTENSIONS, ['.xml', '.zip']);
});

test('直接给出的 .xml / .zip 仍记为不支持：桌面端转档入口尚未接入专利五书反向导入', async () => {
    const xml = write('direct/case.xml', '<cn-application-body/>');
    const zip = write('direct/case.zip', 'PK');
    const { files: found, unsupported } = await scanPaths([xml, zip]);
    assert.deepEqual(found, []);
    assert.deepEqual(unsupported.sort(), [xml, zip].sort());
});

test('BROWSE_EXTENSIONS ⊇ READER_EXTENSIONS ∪ 转档入口的扫描白名单；不含 .zip（它同时是「用默认应用打开」白名单的来源）', () => {
    for (const ext of [...READER_EXTENSIONS, ...DIRECTORY_SCAN_EXTENSIONS]) assert.ok(BROWSE_EXTENSIONS.includes(ext), ext);
    assert.ok(READER_EXTENSIONS.includes('.json'));
    assert.equal(BROWSE_EXTENSIONS.includes('.zip'), false);
});
