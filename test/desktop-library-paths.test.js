/**
 * desktop/renderer/js/library-paths.mjs 单元测试（渲染层纯逻辑，Node 经 import() 载入）
 * 覆盖：输出键优先级（md → html → xml → 专利五书 → pdf → json）、专利 xml 记录打开说明书、
 *       非可阅读扩展名的键被跳过、outputPath 回退（含 .json）与缺省。
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mod;
before(async () => {
    mod = await import(pathToFileURL(path.join(__dirname, '..', 'desktop', 'renderer', 'js', 'library-paths.mjs')).href);
});

test('READABLE_OUTPUT_KEYS 按方案给定的优先级排列', () => {
    assert.deepEqual([...mod.READABLE_OUTPUT_KEYS], ['md', 'html', 'xml', 'description', 'claims', 'abstract', 'drawings', 'abstractFigure', 'pdf', 'json']);
});

test('bundle 记录打开 md；generic xml 打开 xml；专利 xml 记录（无 xml 键）打开说明书', () => {
    assert.equal(mod.readablePathForRecord({ outputs: { json: '/lib/a/a.json', md: '/lib/a/a.md', imagesDir: '/lib/a/images' } }), '/lib/a/a.md');
    assert.equal(mod.readablePathForRecord({ outputs: { xml: '/lib/b/b.xml' } }), '/lib/b/b.xml');
    const patent = {
        outputs: {
            claims: '/lib/p/claims.xml', description: '/lib/p/description.xml', drawings: '/lib/p/drawings.xml',
            abstract: '/lib/p/abstract.xml', abstractFigure: '/lib/p/abstract-figure.xml', zip: '/lib/p/p.zip', precheck: '/lib/p/precheck.json',
        },
    };
    assert.equal(mod.readablePathForRecord(patent), '/lib/p/description.xml');
    assert.equal(mod.readablePathForRecord({ outputs: { claims: '/lib/p/claims.xml', zip: '/lib/p/p.zip' } }), '/lib/p/claims.xml');
});

test('只有 json 时打开 json；非可阅读扩展名的值被跳过；首尾空白去掉', () => {
    assert.equal(mod.readablePathForRecord({ outputs: { imagesDir: '/lib/c/images', json: ' /lib/c/c.json ' } }), '/lib/c/c.json');
    assert.equal(mod.readablePathForRecord({ outputs: { md: '/lib/d/images' } }), '', 'md 键指向目录时不可阅读');
});

test('outputs 没有可阅读项时回退 outputPath（须以可阅读扩展名结尾），否则为空', () => {
    assert.equal(mod.readablePathForRecord({ outputs: {}, outputPath: '/out/x.json' }), '/out/x.json');
    assert.equal(mod.readablePathForRecord({ outputs: {}, outputPath: '/out/x.HTM' }), '/out/x.HTM');
    assert.equal(mod.readablePathForRecord({ outputs: {}, outputPath: '/out/x.docx' }), '');
    assert.equal(mod.readablePathForRecord({ outputPath: '/out/folder' }), '');
    assert.equal(mod.readablePathForRecord(null), '');
});
