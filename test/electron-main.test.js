/**
 * electron/main.js 纯逻辑单元测试（不启动 Electron）
 * 覆盖：普通 Node 进程 require 主进程文件无副作用；expandPaths（递归收集全部支持扩展名、exts 覆盖、
 * 符号链接解析与成环保护、跳过目录、深度与总数上限、入参数组截断、文件原样返回、忽略不存在路径与
 * 非法入参）；isOpenablePath 白名单；主题文件读写与非法值回退。
 */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = require('../electron/main');
const { expandPaths, isOpenablePath, readThemeFile, writeThemeFile, normalizeTheme } = main._internal;

/** 与 electron/main.js 的 MAX_SCAN_FILES 保持一致 */
const MAX_SCAN_FILES = 500;

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'electron-main-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

/** 在 root 下按相对路径批量建文件（自动建父目录） */
function writeFiles(files) {
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
}

// ============================================================
// require 无副作用
// ============================================================

describe('require 主进程文件', () => {
    test('普通 Node 进程中不抛错，只导出 _internal', () => {
        assert.deepEqual(Object.keys(main), ['_internal']);
        for (const fn of ['normalizeTheme', 'readThemeFile', 'writeThemeFile', 'expandPaths', 'isOpenablePath']) {
            assert.equal(typeof main._internal[fn], 'function', `_internal.${fn} 应为函数`);
        }
    });
});

// ============================================================
// expandPaths
// ============================================================

describe('expandPaths', () => {
    const tree = path.join(root, 'tree');
    writeFiles({
        'tree/a.md': '# a',
        'tree/b.markdown': '# b',
        'tree/c.txt': 'text',
        'tree/office.docx': 'docx',
        'tree/sheet.XLSX': 'xlsx',
        'tree/sub/d.md': '# d',
        'tree/sub/deep/E.MD': '# e',
        'tree/.git/skip.md': '# skipped',
        'tree/node_modules/skip.md': '# skipped',
        'tree/.hidden/skip.md': '# skipped',
    });

    test('目录递归收集全部支持扩展名（含 .docx/.xlsx），不含 .txt，跳过 .git、node_modules 与点开头目录', async () => {
        // Act
        const result = await expandPaths([tree]);

        // Assert
        const rel = result.map((f) => path.relative(tree, f.path)).sort();
        assert.deepEqual(rel, ['a.md', 'b.markdown', 'office.docx', 'sheet.XLSX', 'sub/d.md', 'sub/deep/E.MD']);
        for (const f of result) {
            assert.equal(f.name, path.basename(f.path));
            assert.equal(f.size, fs.statSync(f.path).size);
        }
    });

    test('传入 exts 时只收集指定扩展名（大小写不敏感，可省略前导点）', async () => {
        // Act
        const onlyMd = await expandPaths([tree], ['.md']);
        const officeOnly = await expandPaths([tree], ['docx', 'XLSX']);

        // Assert
        assert.deepEqual(onlyMd.map((f) => path.relative(tree, f.path)).sort(), ['a.md', 'sub/d.md', 'sub/deep/E.MD']);
        assert.deepEqual(officeOnly.map((f) => f.name).sort(), ['office.docx', 'sheet.XLSX']);
    });

    test('exts 为空数组或非数组时回退到全部支持扩展名', async () => {
        const withEmpty = await expandPaths([tree], []);
        const withGarbage = await expandPaths([tree], 'not-array');
        const expected = ['a.md', 'b.markdown', 'office.docx', 'sheet.XLSX', 'sub/d.md', 'sub/deep/E.MD'];
        assert.deepEqual(withEmpty.map((f) => path.relative(tree, f.path)).sort(), expected);
        assert.deepEqual(withGarbage.map((f) => path.relative(tree, f.path)).sort(), expected);
    });

    test('目录内的符号链接文件被解析后收集，不再静默跳过', async () => {
        // Arrange：Dirent.isFile() 对符号链接为 false，需 stat 解析目标类型
        writeFiles({ 'links/real/target.md': '# target' });
        const alias = path.join(root, 'links', 'alias.md');
        fs.symlinkSync(path.join(root, 'links', 'real', 'target.md'), alias);

        // Act
        const result = await expandPaths([path.join(root, 'links')]);

        // Assert
        assert.deepEqual(result.map((f) => f.name).sort(), ['alias.md', 'target.md']);
        assert.equal(result.find((f) => f.name === 'alias.md').size, fs.statSync(alias).size);
    });

    test('目录符号链接成环时不重复进入、不死循环', async () => {
        // Arrange：cycle/inner/back → cycle，构成自引用
        writeFiles({ 'cycle/inner/x.md': '# x' });
        fs.symlinkSync(path.join(root, 'cycle'), path.join(root, 'cycle', 'inner', 'back'));

        // Act
        const result = await expandPaths([path.join(root, 'cycle')]);

        // Assert
        assert.deepEqual(result.map((f) => f.name), ['x.md']);
    });

    test('文件路径原样返回（不按扩展名过滤），带 name 与 size', async () => {
        const txt = path.join(tree, 'c.txt');
        const result = await expandPaths([txt]);
        assert.deepEqual(result, [{ path: txt, name: 'c.txt', size: 4 }]);
    });

    test('不存在的路径被忽略，其余正常返回', async () => {
        const result = await expandPaths([path.join(root, 'nope.md'), path.join(tree, 'a.md')]);
        assert.deepEqual(result.map((f) => f.name), ['a.md']);
    });

    test('非数组入参返回空数组，数组内非字符串项被忽略', async () => {
        assert.deepEqual(await expandPaths(null), []);
        assert.deepEqual(await expandPaths('not-array'), []);
        assert.deepEqual(await expandPaths([42, '', null, path.join(tree, 'a.md')]).then((r) => r.map((f) => f.name)), ['a.md']);
    });

    test('递归深度不超过 8 层：第 8 层收集、第 9 层跳过', async () => {
        const chain = Array.from({ length: 9 }, (_, i) => `d${i + 1}`);
        const depth8 = path.join('deep', ...chain.slice(0, 8), 'in.md');
        const depth9 = path.join('deep', ...chain, 'out.md');
        writeFiles({ [depth8]: '# in', [depth9]: '# out' });

        const result = await expandPaths([path.join(root, 'deep')]);
        assert.deepEqual(result.map((f) => f.name), ['in.md']);
    });

    test('总数上限 500', async () => {
        const many = {};
        for (let i = 0; i < 510; i += 1) many[`many/f${String(i).padStart(3, '0')}.md`] = '#';
        writeFiles(many);

        const result = await expandPaths([path.join(root, 'many')]);
        assert.equal(result.length, 500);
    });

    test('入参数组超过上限时先截断，超出部分不再被 stat 或展开', async () => {
        // Arrange：前 500 项是不存在的占位路径，真实文件排在截断线之外
        const padding = Array.from({ length: MAX_SCAN_FILES }, (_, i) => path.join(root, `absent-${i}.md`));
        const beyond = path.join(root, 'tree', 'a.md');

        // Act
        const result = await expandPaths([...padding, beyond]);

        // Assert：若未截断则会返回 a.md，返回空数组即证明第 501 项未被处理
        assert.deepEqual(result, []);
        assert.equal(fs.existsSync(beyond), true, '截断线外的文件本身确实存在');
    });
});

// ============================================================
// open-path 白名单
// ============================================================

describe('isOpenablePath', () => {
    const dir = path.join(root, 'openable');
    writeFiles({
        'openable/doc.md': '# md',
        'openable/data.json': '{}',
        'openable/report.DOCX': 'docx',
        'openable/report.pdf': '%PDF-1.4',
        'openable/script.sh': 'echo 1',
        'openable/noext': 'x',
    });
    fs.mkdirSync(path.join(dir, 'Some.app'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'plain-dir'), { recursive: true });

    test('放行 .md/.json/.docx/.pdf 文件（扩展名大小写不敏感）', async () => {
        for (const name of ['doc.md', 'data.json', 'report.DOCX', 'report.pdf']) {
            assert.equal(await isOpenablePath(path.join(dir, name)), true, `${name} 应被放行`);
        }
    });

    test('拒绝白名单外的扩展名、无扩展名文件与不存在的路径', async () => {
        assert.equal(await isOpenablePath(path.join(dir, 'script.sh')), false);
        assert.equal(await isOpenablePath(path.join(dir, 'noext')), false);
        assert.equal(await isOpenablePath(path.join(dir, 'no-such-file.md')), false);
        assert.equal(await isOpenablePath('/etc/hosts'), false);
    });

    test('放行普通目录，拒绝 .app 应用包（含尾部分隔符形态）', async () => {
        assert.equal(await isOpenablePath(path.join(dir, 'plain-dir')), true);
        assert.equal(await isOpenablePath(dir), true);
        assert.equal(await isOpenablePath(path.join(dir, 'Some.app')), false);
        assert.equal(await isOpenablePath(`${path.join(dir, 'Some.app')}${path.sep}`), false);
    });
});

// ============================================================
// 主题文件
// ============================================================

describe('主题文件读写', () => {
    test('normalizeTheme 只接受 system/light/dark，其余回退 system', () => {
        assert.equal(normalizeTheme('dark'), 'dark');
        assert.equal(normalizeTheme('light'), 'light');
        assert.equal(normalizeTheme('system'), 'system');
        assert.equal(normalizeTheme('purple'), 'system');
        assert.equal(normalizeTheme(undefined), 'system');
    });

    test('文件不存在时返回 system', () => {
        assert.equal(readThemeFile(path.join(root, 'no-such-dir', 'theme.json')), 'system');
    });

    test('写入 dark 后读回 dark（父目录自动创建）', () => {
        const file = path.join(root, 'userData', 'theme.json');
        assert.equal(writeThemeFile(file, 'dark'), 'dark');
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'dark' });
        assert.equal(readThemeFile(file), 'dark');
    });

    test('写入非法值时落盘并读回 system', () => {
        const file = path.join(root, 'userData', 'theme.json');
        assert.equal(writeThemeFile(file, 'purple'), 'system');
        assert.equal(readThemeFile(file), 'system');
    });

    test('文件内容非法（JSON 损坏或 theme 值非法）时回退 system', () => {
        const broken = path.join(root, 'broken.json');
        fs.writeFileSync(broken, '{not json');
        assert.equal(readThemeFile(broken), 'system');
        const wrongValue = path.join(root, 'wrong.json');
        fs.writeFileSync(wrongValue, JSON.stringify({ theme: 'blue' }));
        assert.equal(readThemeFile(wrongValue), 'system');
    });
});
