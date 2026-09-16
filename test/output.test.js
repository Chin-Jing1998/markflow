/**
 * converters/output.js 单元测试
 * 覆盖：writeFolder（files/assets/extras 落盘与 outputs 键、字符串与 Buffer 内容、穿越拒绝、参数校验）、
 *       writeBundle（含/不含 assets、覆盖写、路径穿越防护、参数校验）、writeSingle、
 *       writeFolder 的 clean（只清 MarkFlow 产物、缺省不删、符号链接防护）
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

    test('extras 名中的 {name} 替换为产物名；根目录 {name}_ 附属文件进 outputs（camelCase，非 json 接扩展名），其余根目录附属文件不进', async () => {
        // Act
        const res = await writeFolder({
            outputDir: root,
            name: '包G',
            files: { '{name}.md': '# G', '{name}_content_list.json': '[]' },
            extras: [
                { name: '{name}_content_list_v2.json', buffer: Buffer.from('[]') },
                { name: '{name}_model.json', buffer: Buffer.from('[]') },
                { name: '{name}_layout.json', buffer: Buffer.from('{}') },
                { name: '{name}_origin.pdf', buffer: Buffer.from('%PDF') },
                { name: 'notes.txt', buffer: Buffer.from('n') },
                { name: 'sub/{name}_x.json', buffer: Buffer.from('{}') },
            ],
        });

        // Assert
        const dir = path.join(root, '包G');
        assert.deepEqual(res.outputs, {
            md: path.join(dir, '包G.md'),
            contentList: path.join(dir, '包G_content_list.json'),
            contentListV2: path.join(dir, '包G_content_list_v2.json'),
            model: path.join(dir, '包G_model.json'),
            layout: path.join(dir, '包G_layout.json'),
            originPdf: path.join(dir, '包G_origin.pdf'),
            subDir: path.join(dir, 'sub'),
        });
        assert.equal(fs.readFileSync(res.outputs.originPdf, 'utf8'), '%PDF');
        assert.ok(fs.existsSync(path.join(dir, 'sub', '包G_x.json')));
        assert.ok(fs.existsSync(path.join(dir, 'notes.txt')));
        assert.equal(outputKeyFor('{name}_content_list_v2.json'), 'contentListV2');
        assert.equal(outputKeyFor('{name}_origin.pdf'), 'originPdf');
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

// ============================================================
// writeFolder：clean（重跑前清理旧产物）
// ============================================================

describe('writeFolder：clean 只清理 MarkFlow 产物', () => {
    const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const seed = (dir, rels) => {
        for (const rel of rels) {
            const file = path.join(dir, rel);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, 'old');
        }
    };
    // 目录下全部文件的 posix 相对路径（码点序）
    const listTree = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
        .sort(byCodePoint);
    const GENERATED = [
        'images/image_99.jpg', 'images/sub/x.png',
        '报告.md', '报告.json', '报告.html', '报告.xml', '报告.zip',
        '报告_content_list.json', '报告_content_list_v2.json', '报告_model.json', '报告_layout.json', '报告_origin.pdf',
        'claims.xml', 'description.xml', 'drawings.xml', 'abstract.xml', 'abstract-figure.xml', 'precheck.json',
        'drawing-3.jpg', 'drawing-1-2.png', 'table-2.jpg', 'omath-1-1.jpg', 'omath-2-3-2.jpg', 'image_7.png',
    ];
    const USER = [
        '旧笔记.txt', '报告_备注.txt', '报告 副本.md', 'notes/keep.md', 'images.bak/a.png',
        'drawing.jpg', 'drawing-a.jpg', 'claims.xml.bak', 'Claims.txt',
    ];

    test('删除旧 images/、主产物、旁路 JSON、专利五书与预检、平铺图片；保留用户文件与产物目录外的一切', async () => {
        // Arrange
        const outDir = fs.mkdtempSync(path.join(root, 'clean-'));
        const dir = path.join(outDir, '报告');
        seed(dir, [...GENERATED, ...USER]);
        seed(outDir, ['其他/images/image_1.png', '其他/其他.md', '根目录文件.txt', '报告.docx']);

        // Act
        const res = await writeFolder({
            outputDir: outDir, name: '报告', files: { '{name}.md': '# 新\n', '{name}.json': '{}' }, assets: [ASSET], clean: true,
        });

        // Assert
        assert.deepEqual(listTree(dir), [...USER, '报告.md', '报告.json', 'images/image_1.png'].sort(byCodePoint));
        assert.equal(fs.readFileSync(res.outputs.md, 'utf8'), '# 新\n');
        assert.deepEqual(res, { outputPath: dir, outputs: { md: path.join(dir, '报告.md'), json: path.join(dir, '报告.json'), imagesDir: path.join(dir, 'images') } });
        assert.deepEqual(
            listTree(outDir).filter((rel) => !rel.startsWith('报告/')),
            ['其他/images/image_1.png', '其他/其他.md', '报告.docx', '根目录文件.txt'].sort(byCodePoint),
        );
    });

    test('未传 clean 时不删除任何既有文件（回归守卫）', async () => {
        const outDir = fs.mkdtempSync(path.join(root, 'noclean-'));
        const dir = path.join(outDir, '报告');
        seed(dir, ['images/image_99.jpg', '旧笔记.txt', '报告_origin.pdf']);

        await writeFolder({ outputDir: outDir, name: '报告', files: { '{name}.md': '# 新\n' }, assets: [ASSET] });

        assert.deepEqual(listTree(dir), ['images/image_1.png', 'images/image_99.jpg', '报告.md', '报告_origin.pdf', '旧笔记.txt'].sort(byCodePoint));
    });

    test('产物目录尚不存在时 clean 照常写入；校验失败时不做任何清理', async () => {
        const outDir = fs.mkdtempSync(path.join(root, 'clean-new-'));
        await writeFolder({ outputDir: outDir, name: '新产物', files: { '{name}.md': 'x' }, clean: true });
        assert.deepEqual(listTree(outDir), ['新产物/新产物.md']);

        seed(path.join(outDir, '旧产物'), ['images/image_1.png', '旧产物.md']);
        await assert.rejects(
            writeFolder({ outputDir: outDir, name: '旧产物', files: { '../x.md': 'x' }, clean: true }),
            /产物名不得包含 "\.\."/,
        );
        assert.deepEqual(listTree(path.join(outDir, '旧产物')), ['images/image_1.png', '旧产物.md']);
    });

    test('产物目录经符号链接指向输出目录之外时拒绝清理，链接目标中的文件原样保留', async (t) => {
        const outDir = fs.mkdtempSync(path.join(root, 'clean-link-'));
        const outside = fs.mkdtempSync(path.join(root, 'outside-'));
        seed(outside, ['images/image_1.png', '报告.md']);
        try {
            fs.symlinkSync(outside, path.join(outDir, '报告'), 'dir');
        } catch (err) {
            t.skip('本机无法创建符号链接');
            return;
        }

        await assert.rejects(
            writeFolder({ outputDir: outDir, name: '报告', files: { '{name}.md': 'x' }, clean: true }),
            /清理中止/,
        );
        assert.deepEqual(listTree(outside), ['images/image_1.png', '报告.md']);
        assert.equal(fs.readFileSync(path.join(outside, '报告.md'), 'utf8'), 'old');
    });

    test('产物目录内的 images 为符号链接时只移除链接本身，不删除链接目标', async (t) => {
        const outDir = fs.mkdtempSync(path.join(root, 'clean-imglink-'));
        const outside = fs.mkdtempSync(path.join(root, 'outside-img-'));
        seed(outside, ['keep.png']);
        fs.mkdirSync(path.join(outDir, '报告'));
        try {
            fs.symlinkSync(outside, path.join(outDir, '报告', 'images'), 'dir');
        } catch (err) {
            t.skip('本机无法创建符号链接');
            return;
        }

        await writeFolder({ outputDir: outDir, name: '报告', files: { '{name}.md': 'x' }, assets: [ASSET], clean: true });

        assert.deepEqual(listTree(outside), ['keep.png']);
        assert.equal(fs.lstatSync(path.join(outDir, '报告', 'images')).isSymbolicLink(), false);
        assert.deepEqual(fs.readdirSync(path.join(outDir, '报告', 'images')), ['image_1.png']);
    });
});
