/**
 * desktop/main/convert-inputs.js 单元测试（纯逻辑，不依赖 Electron）
 * 覆盖：显式给出的 .xml / .zip 受理为一项输入（不再记入 unsupported）、专利五书目录整项收为 kind 'bundle'、
 *       普通目录照旧按转档白名单展开且不带入其中的 .xml / .zip、不支持的显式文件仍记入 unsupported、
 *       按绝对路径去重与码点序排列、名字带 .xml 的普通目录不被当作文件；
 *       resolveBundleInputs 的目录签名判定、isBundle 按调用方原始写法作答、相对路径按 cwd 解析。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { expandConvertPaths, resolveBundleInputs, PATENT_BUNDLE_KIND, FILE_KIND } = require('../desktop/main/convert-inputs');
const { BUNDLE_DIR_TYPE } = require('../converters/targets');
const { buildOfficialBundle, writeFiles, zipFiles } = require('./fixtures/patent/roundtrip/build-roundtrip-fixtures');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'convert-inputs-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const bundleDir = path.join(root, '官方案卷');
const zipPath = path.join(root, '案卷.zip');
const xmlPath = path.join(root, '说明书.xml');
const plainDir = path.join(root, '普通目录');
const xmlNamedDir = path.join(root, '看着像文件.xml');
const txtPath = path.join(root, '笔记.txt');
const mdInDir = path.join(plainDir, 'a.md');
const docxInDir = path.join(plainDir, 'sub', 'b.docx');

before(async () => {
    const { files } = await buildOfficialBundle();
    await writeFiles(bundleDir, files);
    fs.writeFileSync(zipPath, await zipFiles(files));
    // 单个五书 XML：取案卷里的说明书那一份，挪到与其图片同级之外也能解析（图片缺失只降级为文字占位）
    fs.copyFileSync(path.join(bundleDir, '100002', '100002.xml'), xmlPath);
    fs.mkdirSync(path.join(plainDir, 'sub'), { recursive: true });
    fs.writeFileSync(mdInDir, '# a');
    fs.writeFileSync(docxInDir, 'docx');
    fs.writeFileSync(path.join(plainDir, '无关.zip'), 'zip');
    fs.writeFileSync(path.join(plainDir, '无关.xml'), '<foo/>');
    fs.mkdirSync(xmlNamedDir, { recursive: true });
    fs.writeFileSync(path.join(xmlNamedDir, 'c.md'), '# c');
    fs.writeFileSync(txtPath, 'text');
});

const describe = (files) => files.map((entry) => [path.basename(entry.path), entry.type, entry.kind]);

test('显式给出的 .xml 与 .zip 受理为一项输入，不再记入 unsupported', async () => {
    const { files, unsupported, truncated } = await expandConvertPaths([xmlPath, zipPath]);
    assert.deepEqual(describe(files), [['案卷.zip', 'zip', FILE_KIND], ['说明书.xml', 'xml', FILE_KIND]]);
    assert.deepEqual(unsupported, []);
    assert.equal(truncated, false);
    assert.ok(files.every((entry) => entry.size > 0), '显式文件带真实大小');
    assert.deepEqual(files.map((entry) => entry.ext), ['.zip', '.xml']);
});

test('专利五书目录整项收为 kind bundle：type 为 BUNDLE_DIR_TYPE，ext 为空、size 为 0，不展开其下文件', async () => {
    const { files, unsupported } = await expandConvertPaths([bundleDir]);
    assert.equal(files.length, 1, '整个目录只出一项输入');
    assert.deepEqual(files[0], {
        path: bundleDir, name: '官方案卷', ext: '', type: BUNDLE_DIR_TYPE, size: 0, kind: PATENT_BUNDLE_KIND,
    });
    assert.deepEqual(unsupported, []);
});

test('普通目录照旧按转档白名单展开，目录里的 .xml / .zip 不随之带入', async () => {
    const { files, unsupported } = await expandConvertPaths([plainDir]);
    assert.deepEqual(files.map((entry) => entry.path), [mdInDir, docxInDir].sort());
    assert.ok(files.every((entry) => entry.kind === FILE_KIND));
    assert.ok(!files.some((entry) => entry.path.includes('无关')), '目录内的 .xml / .zip 不受理');
    assert.deepEqual(unsupported, [], '目录内跳过的文件不记入 unsupported（沿用 scanPaths 的语义）');
});

test('名字带 .xml 的普通目录按目录展开，不被当作单个 XML 文件', async () => {
    const { files } = await expandConvertPaths([xmlNamedDir]);
    assert.deepEqual(describe(files), [['c.md', 'md', FILE_KIND]]);
});

test('不支持的显式文件仍记入 unsupported', async () => {
    const { files, unsupported } = await expandConvertPaths([txtPath]);
    assert.deepEqual(files, []);
    assert.deepEqual(unsupported, [txtPath]);
});

test('按绝对路径去重、按码点序排列：重复给出与「目录 + 其中的文件」都只出现一次', async () => {
    const { files } = await expandConvertPaths([zipPath, xmlPath, xmlPath, bundleDir, plainDir, plainDir, mdInDir]);
    const paths = files.map((entry) => entry.path);
    assert.deepEqual(paths, [...new Set(paths)], '无重复项');
    assert.deepEqual(paths, [...paths].sort(), '按码点序');
    assert.deepEqual(new Set(paths), new Set([zipPath, xmlPath, bundleDir, mdInDir, docxInDir]));
    assert.equal(files.find((entry) => entry.path === bundleDir).kind, PATENT_BUNDLE_KIND);
});

test('maxFiles 截断置 truncated；空入参与非数组按空处理', async () => {
    const limited = await expandConvertPaths([xmlPath, zipPath], { maxFiles: 1 });
    assert.equal(limited.files.length, 1);
    assert.equal(limited.truncated, true);
    assert.deepEqual(await expandConvertPaths([]), { files: [], unsupported: [], truncated: false });
    assert.deepEqual(await expandConvertPaths(null), { files: [], unsupported: [], truncated: false });
    assert.deepEqual(await expandConvertPaths(['', '   ']), { files: [], unsupported: [], truncated: false });
});

test('scanPaths 可注入：只有交回 scanPaths 的项进得去，显式 .xml / .zip 与五书目录先行截下', async () => {
    const calls = [];
    const scanPaths = async (paths) => { calls.push(paths); return { files: [], unsupported: [], truncated: false }; };
    await expandConvertPaths([xmlPath, zipPath, bundleDir, plainDir, txtPath], { scanPaths });
    assert.deepEqual(calls, [[plainDir, txtPath]]);
});

// ============================================================
// resolveBundleInputs
// ============================================================

test('resolveBundleInputs：只有命中目录签名的项进 bundles，isBundle 按调用方的原始写法作答', async () => {
    const missing = path.join(root, '不存在的目录');
    const { bundles, isBundle } = await resolveBundleInputs([bundleDir, plainDir, xmlPath, zipPath, missing, xmlNamedDir]);
    assert.deepEqual(bundles, [bundleDir]);
    assert.equal(isBundle(bundleDir), true);
    for (const raw of [plainDir, xmlPath, zipPath, missing, xmlNamedDir, '', null, undefined]) {
        assert.equal(isBundle(raw), false, String(raw));
    }
});

test('resolveBundleInputs：相对路径按 cwd 解析，bundles 为绝对路径；重复给出只留一条', async () => {
    const { bundles, isBundle } = await resolveBundleInputs(['官方案卷', './官方案卷/', '官方案卷'], root);
    assert.deepEqual(bundles, [bundleDir], '三种写法归一到同一绝对路径，只记一条');
    assert.equal(isBundle('官方案卷'), true, 'isBundle 认的是调用方给出的原始写法');
    assert.equal(isBundle(bundleDir), false, '绝对路径不在本次入参里，故不认');
});

test('resolveBundleInputs：空入参与非数组按空处理，不读盘', async () => {
    for (const input of [[], null, undefined, 'x', ['', '  ']]) {
        const { bundles, isBundle } = await resolveBundleInputs(input);
        assert.deepEqual(bundles, []);
        assert.equal(isBundle('任意'), false);
    }
});
