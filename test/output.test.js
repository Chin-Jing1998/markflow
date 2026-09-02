/**
 * converters/output.js 单元测试
 * 覆盖：writeBundle（含/不含 assets、覆盖写、路径穿越防护、参数校验）、writeSingle
 */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { writeBundle, writeSingle } = require('../converters/output');

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
