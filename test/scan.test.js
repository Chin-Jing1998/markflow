/**
 * converters/scan.js 单元测试：expandInputs（CLI / MCP 的目录输入展开）
 * 目录遍历规则（隐藏项、node_modules / .git、深度、符号链接去环）由 test/desktop-scan.test.js 覆盖；
 * 本文件覆盖：desktop/main/scan.js 转引同一实现、目录就地展开与码点排序、网址与非目录项原样保留、
 *       skipped 只记目录内不支持的文件、去重（重复目录、嵌套目录、目录与显式文件）、~ / file:// / 相对路径、
 *       maxFiles 截断与 maxDepth、无目录时 inputs 与入参逐项相同（向后兼容）、非数组入参；
 *       专利五书目录的签名（isPatentBundleDir）：官方形态、平铺形态、非专利 XML、隐藏文件、探测上限；
 *       expandInputs 把五书目录整体留作一项输入并记入 bundles，.xml 与 .zip 不随目录展开。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');

const scan = require('../converters/scan');

const { expandInputs, isPatentBundleDir } = scan;

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
    assert.deepEqual(res, { inputs: raws, directories: [], bundles: [], skipped: [], truncated: false });
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
    assert.deepEqual(await expandInputs('tree'), { inputs: [], directories: [], bundles: [], skipped: [], truncated: false });
    assert.deepEqual(await expandInputs(), { inputs: [], directories: [], bundles: [], skipped: [], truncated: false });
});

// ============================================================
// 专利五书目录
// ============================================================

const PATENT_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE cn-application-body SYSTEM "x.dtd"[]>\n<cn-application-body lang="zh" country="CN"><cn-claims/></cn-application-body>';
const BOM = String.fromCharCode(0xFEFF);

const officialCase = path.join(root, 'cases', '官方案卷-2026.09.18');
write('cases/官方案卷-2026.09.18/100001/100001.xml', `${BOM}${PATENT_XML}`);
write('cases/官方案卷-2026.09.18/100003/100003_1.jpg');
const flatCase = path.join(root, 'cases', '平铺案卷');
write('cases/平铺案卷/claims.xml', PATENT_XML);
write('cases/平铺案卷/drawing-1.jpg');
const mixed = path.join(root, 'mixed');
const mixedDocx = write('mixed/报告.docx');
const mixedXml = write('mixed/pom.xml', '<project/>');
const mixedZip = write('mixed/归档.zip', 'PK');
const mixedGeneric = write('mixed/out/generic.xml', '<document xmlns="urn:markflow:document:1"/>');

test('isPatentBundleDir：目录下直接含 10000N/10000N.xml 或根元素为 cn-application-body 的 .xml', async () => {
    assert.equal(await isPatentBundleDir(officialCase), true, '官方形态（文首带 BOM）');
    assert.equal(await isPatentBundleDir(flatCase), true, '平铺形态');
    assert.equal(await isPatentBundleDir(path.join(root, 'cases')), false, '只看目录本身，不看子目录的子目录');
    assert.equal(await isPatentBundleDir(mixed), false, '非专利 XML 不算');
    assert.equal(await isPatentBundleDir(tree), false);
    for (const value of [path.join(root, 'missing'), mixedDocx, '', null, 42]) assert.equal(await isPatentBundleDir(value), false, String(value));
});

test('isPatentBundleDir：10000N/10000N.xml 的根元素不对不算；隐藏的 .xml 不看；UTF-16 的五书认得出', async () => {
    write('sig/wrong-root/100001/100001.xml', '<project/>');
    write('sig/hidden/.claims.xml', PATENT_XML);
    const utf16 = path.join(root, 'sig', 'utf16', 'claims.xml');
    fs.mkdirSync(path.dirname(utf16), { recursive: true });
    fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(PATENT_XML, 'utf16le')]));

    assert.equal(await isPatentBundleDir(path.join(root, 'sig', 'wrong-root')), false);
    assert.equal(await isPatentBundleDir(path.join(root, 'sig', 'hidden')), false);
    assert.equal(await isPatentBundleDir(path.join(root, 'sig', 'utf16')), true);
});

test('isPatentBundleDir 的探测有界：只读排在前面的若干份 .xml 的文首', async () => {
    for (let i = 0; i < 20; i += 1) write(`sig/many/a${String(i).padStart(2, '0')}.xml`, '<project/>');
    write('sig/many/z-claims.xml', PATENT_XML);
    assert.equal(await isPatentBundleDir(path.join(root, 'sig', 'many')), false, '第 17 份之后的不再探测');
    write('sig/many/a00.xml', `${' '.repeat(9000)}${PATENT_XML}`);
    assert.equal(await isPatentBundleDir(path.join(root, 'sig', 'many')), false, '根元素出现在文首 8 KB 之后的不算');
});

test('expandInputs：五书目录整体留作一项输入并记入 bundles；.xml 与 .zip 不随普通目录展开', async () => {
    const res = await expandInputs(['cases/官方案卷-2026.09.18', 'mixed', flatCase, 'cases/官方案卷-2026.09.18'], { cwd: root });

    assert.deepEqual(res.inputs, ['cases/官方案卷-2026.09.18', mixedDocx, flatCase, 'cases/官方案卷-2026.09.18'], '五书目录原样留在原位');
    assert.deepEqual(res.bundles, [officialCase, flatCase], '绝对路径，去重');
    assert.deepEqual(res.directories, [{ path: mixed, count: 1 }], '五书目录不计入展开的目录');
    assert.deepEqual(res.skipped, [mixedZip, mixedGeneric, mixedXml].sort(byCodePoint), '.xml 与 .zip 记为跳过，须显式给出');
});

test('expandInputs：签名只看显式给出的目录，展开途中遇到的五书子目录不会被整体吃进来', async () => {
    const res = await expandInputs(['cases'], { cwd: root });
    assert.deepEqual(res.inputs, []);
    assert.deepEqual(res.bundles, []);
    assert.ok(res.skipped.includes(path.join(officialCase, '100001', '100001.xml')));
});
