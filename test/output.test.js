/**
 * converters/output.js 单元测试
 * 覆盖：writeFolder（files/assets/extras 落盘与 outputs 键、字符串与 Buffer 内容、穿越拒绝、参数校验）、
 *       writeBundle（含/不含 assets、覆盖写、路径穿越防护、参数校验）、writeSingle
 */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { writeFolder, writeBundle, writeSingle, outputKeyFor, NAME_TOKEN } = require('../converters/output');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'output-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const PNG = fs.readFileSync(path.join(__dirname, 'fixtures', 'images', 'pic.png'));
const ASSET = { name: 'images/image_1.png', buffer: PNG, mime: 'image/png' };

// ============================================================
// writeBundle
// ============================================================

describe('writeBundle', () => {
    test('含 assets：生成 {name}/{name}.md、{name}.json 与 images/', async () => {
        // Act
        const res = await writeBundle({
            outputDir: root,
            name: '文档A',
            md: '# A\n',
            json: '{"a":1}',
            assets: [ASSET],
        });

        // Assert
        const dir = path.join(root, '文档A');
        assert.deepEqual(res, {
            dir,
            mdPath: path.join(dir, '文档A.md'),
            jsonPath: path.join(dir, '文档A.json'),
            imagesDir: path.join(dir, 'images'),
        });
        assert.equal(fs.readFileSync(res.mdPath, 'utf8'), '# A\n');
        assert.equal(fs.readFileSync(res.jsonPath, 'utf8'), '{"a":1}');
        assert.ok(fs.readFileSync(path.join(res.imagesDir, 'image_1.png')).equals(PNG));
    });

    test('无 assets：不创建 images 目录，imagesDir 为 null', async () => {
        const res = await writeBundle({ outputDir: root, name: '文档B', md: 'b', json: '{}' });

        assert.equal(res.imagesDir, null);
        assert.equal(fs.existsSync(path.join(root, '文档B', 'images')), false);
        assert.equal(fs.readFileSync(res.mdPath, 'utf8'), 'b');
    });

    test('同名目录直接覆盖写', async () => {
        await writeBundle({ outputDir: root, name: '文档C', md: '旧', json: '{"v":1}', assets: [ASSET] });
        const res = await writeBundle({ outputDir: root, name: '文档C', md: '新', json: '{"v":2}', assets: [ASSET] });

        assert.equal(fs.readFileSync(res.mdPath, 'utf8'), '新');
        assert.equal(fs.readFileSync(res.jsonPath, 'utf8'), '{"v":2}');
    });

    test('相对 outputDir 也返回绝对路径', async () => {
        const relative = path.relative(process.cwd(), root);
        const res = await writeBundle({ outputDir: relative, name: '文档D', md: 'd', json: '{}' });

        assert.ok(path.isAbsolute(res.dir));
        assert.equal(res.dir, path.join(root, '文档D'));
    });

    test('拒绝路径穿越与绝对路径的资源名', async () => {
        const base = { outputDir: root, name: '文档E', md: 'e', json: '{}' };
        await assert.rejects(
            writeBundle({ ...base, assets: [{ name: '../evil.png', buffer: PNG }] }),
            /\.\./,
        );
        await assert.rejects(
            writeBundle({ ...base, assets: [{ name: '/tmp/evil.png', buffer: PNG }] }),
            /绝对路径/,
        );
        await assert.rejects(
            writeBundle({ ...base, assets: [{ name: 'images/x.png', buffer: 'not-a-buffer' }] }),
            /Buffer/,
        );
        assert.equal(fs.existsSync(path.join(root, 'evil.png')), false);
    });

    test('缺少参数时抛中文错误', async () => {
        await assert.rejects(writeBundle({ outputDir: root, md: 'x', json: '{}' }), /name/);
        await assert.rejects(writeBundle({ outputDir: root, name: 'a/b', md: 'x', json: '{}' }), /路径分隔符/);
        await assert.rejects(writeBundle({ outputDir: root, name: 'x', json: '{}' }), /md/);
        await assert.rejects(writeBundle({ outputDir: root, name: 'x', md: 'x' }), /json/);
        await assert.rejects(writeBundle({ name: 'x', md: 'x', json: '{}' }), /outputDir/);
    });
});

// ============================================================
// writeSingle
// ============================================================

describe('writeSingle', () => {
    test('写出 {outputDir}/{name}.{ext} 并返回绝对路径', async () => {
        const buffer = Buffer.from('PK-docx');

        const target = await writeSingle({ outputDir: root, name: '报告', ext: 'docx', buffer });

        assert.equal(target, path.join(root, '报告.docx'));
        assert.ok(fs.readFileSync(target).equals(buffer));
    });

    test('ext 的前导点被归一，同名覆盖', async () => {
        await writeSingle({ outputDir: root, name: '报告', ext: '.pdf', buffer: Buffer.from('v1') });
        const target = await writeSingle({ outputDir: root, name: '报告', ext: '.pdf', buffer: Buffer.from('v2') });

        assert.equal(target, path.join(root, '报告.pdf'));
        assert.equal(fs.readFileSync(target, 'utf8'), 'v2');
    });

    test('非 Buffer 内容与缺失 ext 拒绝', async () => {
        await assert.rejects(writeSingle({ outputDir: root, name: 'x', ext: 'pdf', buffer: 'text' }), /Buffer/);
        await assert.rejects(writeSingle({ outputDir: root, name: 'x', ext: '', buffer: Buffer.alloc(1) }), /ext/);
    });
});

// ============================================================
// writeFolder
// ============================================================

describe('writeFolder', () => {
    test('files + assets + extras：目录结构、{name} 替换、outputs 键（扩展名 / camelCase / imagesDir / <dir>Dir）', async () => {
        // Act
        const res = await writeFolder({
            outputDir: root,
            name: '专利A',
            files: {
                '{name}.xml': '<doc/>',
                'claims.xml': '<cn-claims/>',
                'abstract-figure.xml': Buffer.from('<cn-abstract/>'),
                '{name}.zip': Buffer.from('PK'),
            },
            assets: [ASSET],
            extras: [
                { name: 'mineru/full.md', buffer: Buffer.from('# full') },
                { name: 'mineru/layout.json', buffer: Buffer.from('{}') },
                { name: 'notes.txt', buffer: Buffer.from('n') },
            ],
        });

        // Assert
        const dir = path.join(root, '专利A');
        assert.deepEqual(res, {
            outputPath: dir,
            outputs: {
                xml: path.join(dir, '专利A.xml'),
                claims: path.join(dir, 'claims.xml'),
                abstractFigure: path.join(dir, 'abstract-figure.xml'),
                zip: path.join(dir, '专利A.zip'),
                imagesDir: path.join(dir, 'images'),
                mineruDir: path.join(dir, 'mineru'),
            },
        });
        assert.equal(fs.readFileSync(res.outputs.xml, 'utf8'), '<doc/>');
        assert.equal(fs.readFileSync(res.outputs.abstractFigure, 'utf8'), '<cn-abstract/>');
        assert.ok(fs.readFileSync(path.join(res.outputs.imagesDir, 'image_1.png')).equals(PNG));
        assert.equal(fs.readFileSync(path.join(res.outputs.mineruDir, 'full.md'), 'utf8'), '# full');
        assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'n');
        assert.equal(NAME_TOKEN, '{name}');
        assert.equal(outputKeyFor('{name}.HTML'), 'html');
        assert.equal(outputKeyFor('sub/abstract-figure.xml'), 'abstractFigure');
    });

    test('字符串按 utf8、Buffer 原样、子目录自动创建；无 assets 时不建 images/，返回绝对路径', async () => {
        // Arrange
        const relative = path.relative(process.cwd(), root);

        // Act
        const res = await writeFolder({
            outputDir: relative,
            name: '网页B',
            files: { '{name}.html': '<p>中文</p>', 'assets/site.css': Buffer.from('p{}') },
        });

        // Assert
        const dir = path.join(root, '网页B');
        assert.ok(path.isAbsolute(res.outputPath));
        assert.deepEqual(res, { outputPath: dir, outputs: { html: path.join(dir, '网页B.html'), site: path.join(dir, 'assets', 'site.css') } });
        assert.equal(fs.readFileSync(res.outputs.html, 'utf8'), '<p>中文</p>');
        assert.equal(fs.readFileSync(res.outputs.site, 'utf8'), 'p{}');
        assert.equal(fs.existsSync(path.join(dir, 'images')), false);

        // 覆盖写
        const again = await writeFolder({ outputDir: root, name: '网页B', files: { '{name}.html': 'v2' } });
        assert.equal(fs.readFileSync(again.outputs.html, 'utf8'), 'v2');
    });

    test('裸文件名的资产平铺在目录根下：不创建 images/，outputs 无 imagesDir；混有 images/ 前缀时仍建目录', async () => {
        // Act
        const flat = await writeFolder({
            outputDir: root, name: '平铺E',
            files: { 'claims.xml': '<cn-claims/>' },
            assets: [{ name: 'drawing-1.jpg', buffer: PNG, mime: 'image/jpeg' }],
        });
        const mixed = await writeFolder({
            outputDir: root, name: '平铺F',
            files: { 'a.xml': '<a/>' },
            assets: [{ name: 'drawing-1.jpg', buffer: PNG, mime: 'image/jpeg' }, ASSET],
        });

        // Assert
        const dir = path.join(root, '平铺E');
        assert.deepEqual(flat, { outputPath: dir, outputs: { claims: path.join(dir, 'claims.xml') } });
        assert.ok(fs.readFileSync(path.join(dir, 'drawing-1.jpg')).equals(PNG));
        assert.equal(fs.existsSync(path.join(dir, 'images')), false);
        assert.equal(mixed.outputs.imagesDir, path.join(root, '平铺F', 'images'));
        assert.ok(fs.existsSync(path.join(root, '平铺F', 'images', 'image_1.png')));
        assert.ok(fs.existsSync(path.join(root, '平铺F', 'drawing-1.jpg')));
    });

    test('拒绝穿越：files 键与 extras 名的 ../ 与绝对路径、Windows 盘符；校验失败时目录内外都不落盘', async () => {
        const base = { outputDir: root, name: '穿越C' };
        const good = { '{name}.html': 'ok' };

        await assert.rejects(writeFolder({ ...base, files: { '../evil.html': 'x' } }), /产物名不得包含 "\.\."：\.\.\/evil\.html/);
        await assert.rejects(writeFolder({ ...base, files: { '/tmp/evil.html': 'x' } }), /产物名不得为绝对路径/);
        await assert.rejects(writeFolder({ ...base, files: { 'C:\\\\evil.html': 'x' } }), /产物名不得为绝对路径/);
        await assert.rejects(writeFolder({ ...base, files: { '{name}/../../x.html': 'x' } }), /产物名不得包含 "\.\."/);
        await assert.rejects(writeFolder({ ...base, files: good, extras: [{ name: '../evil.txt', buffer: PNG }] }), /附属文件名不得包含 "\.\."/);
        await assert.rejects(writeFolder({ ...base, files: good, extras: [{ name: '/etc/evil.txt', buffer: PNG }] }), /附属文件名不得为绝对路径/);
        await assert.rejects(writeFolder({ ...base, files: good, assets: [{ name: '..\\\\evil.png', buffer: PNG }] }), /资源名不得包含 "\.\."/);
        await assert.rejects(writeFolder({ ...base, files: good, extras: [{ buffer: PNG }] }), /附属文件缺少 name/);

        assert.equal(fs.existsSync(path.join(root, 'evil.html')), false);
        assert.equal(fs.existsSync(path.join(root, 'evil.txt')), false);
        assert.equal(fs.existsSync(path.join(root, '穿越C')), false, '校验失败时不得创建产物目录');
    });

    test('参数校验：files 缺失或为空、内容类型非法、路径重复、outputs 键冲突', async () => {
        const base = { outputDir: root, name: '校验D' };
        await assert.rejects(writeFolder({ ...base }), /writeFolder 需要非空的 files 对象/);
        await assert.rejects(writeFolder({ ...base, files: {} }), /writeFolder 需要非空的 files 对象/);
        await assert.rejects(writeFolder({ ...base, files: [] }), /writeFolder 需要非空的 files 对象/);
        await assert.rejects(writeFolder({ ...base, files: { '{name}.html': 42 } }), /产物 \{name\}\.html 的内容须为字符串或 Buffer/);
        await assert.rejects(writeFolder({ ...base, files: { '{name}.html': 'x' }, extras: [{ name: '{name}.html'.replace('{name}', '校验D'), buffer: PNG }] }), /产物路径重复：校验D\.html/);
        await assert.rejects(writeFolder({ ...base, files: { 'a-b.xml': 'x', 'aB.xml': 'y' } }), /产物键冲突：aB/);
        await assert.rejects(writeFolder({ outputDir: root, files: { '{name}.html': 'x' } }), /缺少产物名 name/);
        await assert.rejects(writeFolder({ ...base, name: 'a/b', files: { '{name}.html': 'x' } }), /产物名不得包含路径分隔符/);
        await assert.rejects(writeFolder({ name: 'x', files: { '{name}.html': 'x' } }), /缺少输出目录 outputDir/);
        assert.equal(fs.existsSync(path.join(root, '校验D')), false);
    });
});
