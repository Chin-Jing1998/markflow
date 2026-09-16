/**
 * converters/scan.js 单元测试：expandInputs（CLI / MCP 的目录输入展开）
 * 目录遍历规则（隐藏项、node_modules / .git、深度、符号链接去环）由 test/desktop-scan.test.js 覆盖；
 * 本文件覆盖：desktop/main/scan.js 转引同一实现、目录就地展开与码点排序、网址与非目录项原样保留、
 *       skipped 只记目录内不支持的文件、去重（重复目录、嵌套目录、目录与显式文件）、~ / file:// / 相对路径、
 *       maxFiles 截断与 maxDepth、无目录时 inputs 与入参逐项相同（向后兼容）、非数组入参。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');

const scan = require('../converters/scan');

const { expandInputs } = scan;

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(TMP_ROOT, 'expand-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (rel, content = 'x') => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
};
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const tree = path.join(root, 'tree');
const files = {
    a: write('tree/a.md'),
    b: write('tree/B.docx'),
    c: write('tree/sub/c.pptx'),
    d: write('tree/sub/deep/d.xlsx'),
};
const legacy = write('tree/legacy.doc');
const notes = write('tree/sub/notes.txt');
write('tree/.hidden.md');
write('tree/.cache/x.md');
write('tree/node_modules/pkg/readme.md');
write('tree/node_modules/pkg/skip.txt');
write('tree/.git/HEAD');
write('loose.docx');
const treeFiles = Object.values(files).sort(byCodePoint);

test('desktop/main/scan.js 转引 converters/scan.js 的同一实现', () => {
    const desktop = require('../desktop/main/scan');
    for (const key of ['scanPaths', 'expandPaths', 'normalizeExts', 'DEFAULT_MAX_DEPTH', 'DEFAULT_MAX_FILES']) {
        assert.equal(desktop[key], scan[key], key);
    }
});

test('目录就地展开为受支持文件的绝对路径（码点序），网址与非目录项原样保留在原位', async () => {
    // Act
    const res = await expandInputs(['https://example.com/a', 'loose.docx', 'tree', 'missing.md'], { cwd: root });

    // Assert
    assert.deepEqual(res.inputs, ['https://example.com/a', 'loose.docx', ...treeFiles, 'missing.md']);
    assert.deepEqual(res.directories, [{ path: tree, count: treeFiles.length }]);
    assert.deepEqual(res.skipped, [legacy, notes].sort(byCodePoint), '只记目录内扩展名不受支持的文件，隐藏项与 node_modules 不计');
    assert.equal(res.truncated, false);
});

test('没有目录时 inputs 与入参逐项相同（向后兼容）', async () => {
    const raws = ['a.md', ' b.docx ', 'https://example.com', 42, '', null, 'nope/', 'file:///tmp/a%2Fb.md'];
    const res = await expandInputs(raws, { cwd: root });
    assert.deepEqual(res, { inputs: raws, directories: [], skipped: [], truncated: false });
});

test('~、file:// 与相对路径形式的目录同样展开', async (t) => {
    assert.deepEqual((await expandInputs([url.pathToFileURL(tree).href])).inputs, treeFiles);
    assert.deepEqual((await expandInputs([path.relative(process.cwd(), tree)])).inputs, treeFiles);

    const rel = path.relative(os.homedir(), tree);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        t.skip('测试目录不在主目录之下');
        return;
    }
    assert.deepEqual((await expandInputs([`~/${rel.split(path.sep).join('/')}`])).inputs, treeFiles);
});

test('去重：重复目录与嵌套目录不重复展开，显式给出的文件不被目录展开重复', async () => {
    // Act
    const res = await expandInputs([tree, path.join(tree, 'sub'), tree, files.a, legacy]);

    // Assert：显式文件原位保留，目录展开跳过它们；显式给出的不支持文件同样不记入 skipped
    const expanded = treeFiles.filter((file) => file !== files.a);
    assert.deepEqual(res.inputs, [...expanded, files.a, legacy]);
    assert.deepEqual(res.directories.map((entry) => entry.count), [expanded.length, 0, 0]);
    assert.deepEqual(res.skipped, [notes]);
});

test('maxFiles 截断置 truncated，maxDepth 限制深度；默认上限沿用桌面端', async () => {
    const capped = await expandInputs([tree], { maxFiles: 2 });
    assert.equal(capped.inputs.length, 2);
    assert.equal(capped.truncated, true);

    const shallow = await expandInputs([tree], { maxDepth: 0 });
    assert.deepEqual(shallow.inputs, [files.a, files.b].sort(byCodePoint));
    assert.deepEqual(shallow.skipped, [legacy]);

    assert.equal(scan.DEFAULT_MAX_DEPTH, 8);
    assert.equal(scan.DEFAULT_MAX_FILES, 2000);
});

test('非数组入参返回空结果', async () => {
    assert.deepEqual(await expandInputs('tree'), { inputs: [], directories: [], skipped: [], truncated: false });
    assert.deepEqual(await expandInputs(), { inputs: [], directories: [], skipped: [], truncated: false });
});
