/**
 * desktop/main/md-edit.js 单元测试（纯 Node；契约函数 renderBundleSidecars 一律用桩）
 * 覆盖：writeFileAtomic 不留临时文件、保留 mode、经符号链接写到目标、失败不留残片；
 *       saveMarkdownFile 的 mtime/size 冲突、文件被删除、force 覆盖、超限拒绝；
 *       importImage 重名依次 -1 / -2、文件名清洗、源在文档目录内不复制、扩展名白名单与大小上限、宽高；
 *       referencedImages 只列被引用的图片（含 encodeURI 形式）；
 *       旁路文件：可识别的 bundle json 按新文本重建（图片 url 还原为相对路径、data URL 保持原样、不含绝对路径、保留旧 meta），
 *       非 MarkFlow JSON 不动，契约函数缺席时只记 warning 而不回滚 md，content_list 不存在时不凭空创建。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mdEdit = require('../desktop/main/md-edit');
const { MAX_TEXT_BYTES, MAX_IMAGE_IMPORT_BYTES } = require('../desktop/main/file-kinds');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(TMP_ROOT, 'md-edit-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let dirSeq = 0;
const freshDir = (label) => {
    dirSeq += 1;
    const dir = path.join(root, `${label}-${dirSeq}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

/** 只含签名与 IHDR 的 PNG 头：image-size 据此即可读出宽高 */
function pngHeader(width, height) {
    const buffer = Buffer.alloc(33);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    buffer.writeUInt8(8, 24);
    buffer.writeUInt8(6, 25);
    return buffer;
}

const baseOf = (file) => {
    const stat = fs.statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
};
const leftovers = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith(mdEdit.TEMP_SUFFIX));

function sidecarStub() {
    const calls = [];
    return {
        calls,
        core: {
            renderBundleSidecars: async (doc, { name, options }) => {
                calls.push({ doc: JSON.parse(JSON.stringify(doc)), name, hasOptions: Boolean(options && options.html) });
                const images = [];
                (function walk(node) {
                    if (!node || typeof node !== 'object') return;
                    if (node.type === 'image') images.push(node.url);
                    for (const child of node.children || []) walk(child);
                }(doc.ir));
                return {
                    json: JSON.stringify({ schemaVersion: 1, kind: 'document', ir: doc.ir, meta: doc.meta }),
                    contentList: JSON.stringify(images.map((url) => ({ type: 'image', img_path: url }))),
                };
            },
        },
    };
}

// ============================================================
// 原子写
// ============================================================

test('writeFileAtomic：内容写入、不留 .mftmp 临时文件、保留原 mode', () => {
    return (async () => {
        const dir = freshDir('atomic');
        const file = path.join(dir, 'a.md');
        fs.writeFileSync(file, 'old');
        fs.chmodSync(file, 0o640);
        const written = await mdEdit.writeFileAtomic(file, '新内容\n');
        assert.equal(written, file);
        assert.equal(fs.readFileSync(file, 'utf8'), '新内容\n');
        // Windows 无 POSIX 权限位，该断言只在类 Unix 上有意义：chmod(0o640) 在 win32 上不落地，
        // stat 读回的恒是 0o666，「保留原 mode」无从验证。内容与临时文件的断言照常执行。
        if (process.platform !== 'win32') {
            assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'mode 须与原文件一致');
        }
        assert.deepEqual(leftovers(dir), []);
        const created = await mdEdit.writeFileAtomic(path.join(dir, 'new.md'), 'x');
        assert.equal(fs.readFileSync(created, 'utf8'), 'x', '文件不存在时新建');
    })();
});

test('writeFileAtomic：经符号链接写入时改写链接目标，链接本身保留', async (t) => {
    const dir = freshDir('link');
    const target = path.join(dir, 'real.md');
    const link = path.join(dir, 'link.md');
    fs.writeFileSync(target, 'a');
    try {
        fs.symlinkSync(target, link);
    } catch (err) {
        t.skip('本机无法创建符号链接');
        return;
    }
    await mdEdit.writeFileAtomic(link, 'b');
    assert.equal(fs.readFileSync(target, 'utf8'), 'b');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), '链接不得被替换成普通文件');
});

test('writeFileAtomic：目录不可写时抛错且不留临时文件', async (t) => {
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
        t.skip('当前平台或 root 身份无法模拟不可写目录');
        return;
    }
    const dir = freshDir('readonly');
    const file = path.join(dir, 'a.md');
    fs.writeFileSync(file, 'keep');
    fs.chmodSync(dir, 0o500);
    try {
        await assert.rejects(mdEdit.writeFileAtomic(file, 'nope'));
    } finally {
        fs.chmodSync(dir, 0o700);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
    assert.deepEqual(leftovers(dir), []);
});

// ============================================================
// 保存与冲突
// ============================================================

test('saveMarkdownFile：基线一致时写盘并回新基线；无 bundle json 时不碰旁路文件', async () => {
    const dir = freshDir('save');
    const file = path.join(dir, 'note.md');
    fs.writeFileSync(file, '# 旧\n');
    const result = await mdEdit.saveMarkdownFile({ filePath: file, text: '# 新\n', base: baseOf(file) });
    assert.equal(result.saved, true);
    assert.equal(result.conflict, false);
    assert.deepEqual(result.base, baseOf(file));
    assert.deepEqual(result.sidecars, []);
    assert.equal(fs.readFileSync(file, 'utf8'), '# 新\n');
    assert.deepEqual(leftovers(dir), []);
});

test('saveMarkdownFile：外部修改报冲突且不覆盖；文件被删报 missing；force 覆盖', async () => {
    const dir = freshDir('conflict');
    const file = path.join(dir, 'note.md');
    fs.writeFileSync(file, 'v1');
    const base = baseOf(file);
    fs.writeFileSync(file, 'external v2');
    const past = new Date(Date.now() + 5000);
    fs.utimesSync(file, past, past);
    assert.deepEqual(await mdEdit.saveMarkdownFile({ filePath: file, text: 'mine', base }), { saved: false, conflict: true, missing: false });
    assert.equal(fs.readFileSync(file, 'utf8'), 'external v2', '冲突时不得写盘');

    const forced = await mdEdit.saveMarkdownFile({ filePath: file, text: 'mine', base, force: true });
    assert.equal(forced.saved, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'mine');

    fs.rmSync(file);
    assert.deepEqual(await mdEdit.saveMarkdownFile({ filePath: file, text: 'again', base: forced.base }), { saved: false, conflict: true, missing: true });
    assert.equal(fs.existsSync(file), false);
    const recreated = await mdEdit.saveMarkdownFile({ filePath: file, text: 'again', base: forced.base, force: true });
    assert.equal(recreated.saved, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'again');
});

test('saveMarkdownFile：超过文本上限以中文错误拒绝', async () => {
    const dir = freshDir('limit');
    const file = path.join(dir, 'big.md');
    fs.writeFileSync(file, 'x');
    await assert.rejects(mdEdit.saveMarkdownFile({ filePath: file, text: 'a'.repeat(MAX_TEXT_BYTES + 1), base: baseOf(file) }), /文本过大/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'x');
});

// ============================================================
// 插图
// ============================================================

test('importImage：复制到 images/ 不覆盖，重名依次 -1、-2；文件名清洗；返回宽高与 alt', async () => {
    const docDir = freshDir('doc');
    const outside = freshDir('pictures');
    const source = path.join(outside, 'my pic#1.png');
    fs.writeFileSync(source, pngHeader(320, 200));
    const first = await mdEdit.importImage({ sourcePath: source, docDir });
    assert.deepEqual(first, { relPath: 'images/my_pic_1.png', width: 320, height: 200, alt: 'my pic#1' });
    const second = await mdEdit.importImage({ sourcePath: source, docDir });
    const third = await mdEdit.importImage({ sourcePath: source, docDir });
    assert.equal(second.relPath, 'images/my_pic_1-1.png');
    assert.equal(third.relPath, 'images/my_pic_1-2.png');
    assert.deepEqual(fs.readdirSync(path.join(docDir, 'images')).sort(), ['my_pic_1-1.png', 'my_pic_1-2.png', 'my_pic_1.png']);
    assert.deepEqual(fs.readFileSync(path.join(docDir, 'images', 'my_pic_1.png')), fs.readFileSync(source), '复制的是原图字节');
});

test('importImage：源文件已在文档目录内时直接引用、不复制', async () => {
    const docDir = freshDir('inside');
    fs.mkdirSync(path.join(docDir, 'assets'));
    const inner = path.join(docDir, 'assets', 'in.png');
    fs.writeFileSync(inner, pngHeader(10, 20));
    const result = await mdEdit.importImage({ sourcePath: inner, docDir });
    assert.deepEqual(result, { relPath: 'assets/in.png', width: 10, height: 20, alt: 'in' });
    assert.equal(fs.existsSync(path.join(docDir, 'images')), false, '不应建 images/');
});

test('importImage：非白名单扩展名与超限图片以中文错误拒绝；无法识别尺寸时宽高为 null', async () => {
    const docDir = freshDir('reject');
    const outside = freshDir('reject-src');
    const tiff = path.join(outside, 'scan.tiff');
    fs.writeFileSync(tiff, 'II*');
    await assert.rejects(mdEdit.importImage({ sourcePath: tiff, docDir }), /只能插入/);
    const huge = path.join(outside, 'huge.png');
    fs.writeFileSync(huge, '');
    fs.truncateSync(huge, MAX_IMAGE_IMPORT_BYTES + 1);
    await assert.rejects(mdEdit.importImage({ sourcePath: huge, docDir }), /图片过大/);
    await assert.rejects(mdEdit.importImage({ sourcePath: path.join(outside, 'missing.png'), docDir }), /图片不存在/);
    const broken = path.join(outside, 'broken.png');
    fs.writeFileSync(broken, 'not a png');
    const imported = await mdEdit.importImage({ sourcePath: broken, docDir });
    assert.equal(imported.width, null);
    assert.equal(imported.height, null);
});

test('sanitizeStem：清洗 Windows 保留字符、# %、控制字符与空白，去掉开头的点', () => {
    assert.equal(mdEdit.sanitizeStem('a<b>c:"d"/e\\f|g?h*i#j%k'), 'a_b_c_d_e_f_g_h_i_j_k');
    assert.equal(mdEdit.sanitizeStem('  .hidden  file\t'), 'hidden_file');
    assert.equal(mdEdit.sanitizeStem('...'), 'image');
    assert.equal(mdEdit.sanitizeStem('图 片'), '图_片');
});

test('referencedImages：只列出文本里引用到的 images/ 文件（含 encodeURI 形式），孤儿图不带', async () => {
    const dir = freshDir('refs');
    fs.mkdirSync(path.join(dir, 'images', 'sub'), { recursive: true });
    for (const name of ['images/a.png', 'images/b.png', 'images/sub/c 1.png']) fs.writeFileSync(path.join(dir, ...name.split('/')), 'x');
    const text = '![a](images/a.png)\n\n<img src="images/sub/c%201.png" alt="c">\n';
    const refs = await mdEdit.referencedImages(text, dir);
    assert.deepEqual(refs.map((item) => item.name), ['images/a.png', 'images/sub/c 1.png']);
    assert.equal(refs[1].absPath, path.join(dir, 'images', 'sub', 'c 1.png'));
    assert.deepEqual(await mdEdit.referencedImages(text, freshDir('empty')), [], '没有 images/ 目录时为空');
});

// ============================================================
// 旁路文件
// ============================================================

function makeBundle(label, { withContentList = true, json = null } = {}) {
    const dir = freshDir(label);
    fs.mkdirSync(path.join(dir, 'images'));
    fs.writeFileSync(path.join(dir, 'images', 'pic.png'), pngHeader(64, 32));
    const mdPath = path.join(dir, 'doc.md');
    fs.writeFileSync(mdPath, '---\ntitle: 原标题\n---\n\n# 原标题\n');
    const meta = { title: '原标题', sourceType: 'docx', sourceName: 'src.docx', baseDir: '/abs/should/drop', source: '/abs/src.docx', lang: 'zh' };
    fs.writeFileSync(path.join(dir, 'doc.json'), json === null ? JSON.stringify({ schemaVersion: 1, kind: 'document', ir: { type: 'root', children: [] }, data: null, meta }) : json);
    if (withContentList) fs.writeFileSync(path.join(dir, 'doc_content_list.json'), '[]');
    return { dir, mdPath };
}

test('findBundleJson：同名 json 含 schemaVersion、ir、meta 才认作 bundle', async () => {
    const bundle = makeBundle('find');
    const found = await mdEdit.findBundleJson(bundle.mdPath);
    assert.equal(found.jsonPath, path.join(bundle.dir, 'doc.json'));
    assert.equal(found.contentListPath, path.join(bundle.dir, 'doc_content_list.json'));
    assert.equal(found.hasContentList, true);
    assert.equal(found.name, 'doc');
    assert.equal(found.meta.sourceType, 'docx');
    for (const json of ['{"foo":1}', '{bad json', '{"schemaVersion":1,"ir":{}}', '{"schemaVersion":1,"ir":[],"meta":{}}']) {
        const other = makeBundle('not-bundle', { json });
        assert.equal(await mdEdit.findBundleJson(other.mdPath), null, json);
    }
    assert.equal(await mdEdit.findBundleJson(path.join(freshDir('no-json'), 'x.md')), null);
});

test('保存 bundle md：按新文本重建 json 与 content_list，图片 url 还原为相对路径、不含绝对路径、保留旧 meta', async () => {
    const bundle = makeBundle('rebuild');
    const stub = sidecarStub();
    const text = '---\ntitle: 新标题\n---\n\n# 新标题\n\n![图](images/pic.png)\n\n![远程](https://example.com/x.png)\n';
    const result = await mdEdit.saveMarkdownFile({ filePath: bundle.mdPath, text, base: baseOf(bundle.mdPath), core: stub.core });
    assert.equal(result.saved, true);
    assert.deepEqual(result.sidecars, [path.join(bundle.dir, 'doc.json'), path.join(bundle.dir, 'doc_content_list.json')]);
    assert.equal(fs.readFileSync(bundle.mdPath, 'utf8'), text, 'md 逐字写入');

    assert.equal(stub.calls.length, 1);
    const { doc, name, hasOptions } = stub.calls[0];
    assert.equal(name, 'doc');
    assert.equal(hasOptions, true);
    const serialized = JSON.stringify(doc);
    assert.ok(!serialized.includes(bundle.dir), '旁路文件的输入不得含本机绝对路径');
    assert.ok(!serialized.includes('/abs/'), '旧 meta 里的绝对路径须去掉');
    assert.equal(doc.meta.title, '新标题');
    assert.equal(doc.meta.sourceType, 'docx');
    assert.equal(doc.meta.sourceName, 'src.docx');
    assert.equal(doc.meta.lang, 'zh');
    assert.equal(doc.meta.baseDir, undefined);
    assert.match(doc.meta.editedAt, /^\d{4}-\d{2}-\d{2}T/);

    const written = JSON.parse(fs.readFileSync(path.join(bundle.dir, 'doc_content_list.json'), 'utf8'));
    assert.deepEqual(written.map((item) => item.img_path), ['images/pic.png', 'https://example.com/x.png']);
    const json = JSON.parse(fs.readFileSync(path.join(bundle.dir, 'doc.json'), 'utf8'));
    assert.equal(json.meta.title, '新标题');
    assert.deepEqual(leftovers(bundle.dir), []);
});

test('保存 bundle md：data URL 图片在 json 与 content_list 中保持 md 里的原样地址，不写成不存在的 images/image_N', async () => {
    const bundle = makeBundle('data-url');
    const stub = sidecarStub();
    const pngUrl = `data:image/png;base64,${pngHeader(4, 4).toString('base64')}`;
    const svgUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')}`;
    const text = `# 内嵌\n\n![图](images/pic.png)\n\n![png](${pngUrl})\n\n![svg](${svgUrl})\n\n<img src="${pngUrl}" width="120">\n`;
    const result = await mdEdit.saveMarkdownFile({ filePath: bundle.mdPath, text, base: baseOf(bundle.mdPath), core: stub.core });
    assert.equal(result.saved, true);
    assert.deepEqual(result.warnings, []);
    assert.equal(fs.readFileSync(bundle.mdPath, 'utf8'), text, 'md 逐字写入，data URL 不外置');

    const expected = ['images/pic.png', pngUrl, svgUrl, pngUrl];
    const listText = fs.readFileSync(path.join(bundle.dir, 'doc_content_list.json'), 'utf8');
    assert.deepEqual(JSON.parse(listText).map((item) => item.img_path), expected);
    const jsonText = fs.readFileSync(path.join(bundle.dir, 'doc.json'), 'utf8');
    const images = [];
    (function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'image') images.push(node);
        for (const child of node.children || []) walk(child);
    }(JSON.parse(jsonText).ir));
    assert.deepEqual(images.map((node) => node.url), expected);
    assert.ok(!/images\/image_\d/.test(jsonText + listText), '旁路文件不得引用解析时临时编号的 images/image_N');
    assert.deepEqual(images[1].data, {}, 'data URL 图片不留 assetName 与 data.asset');
    assert.equal(images[3].data.assetName, undefined);
    assert.deepEqual(images[3].data.display, { width: 120, unit: 'px', source: 'html' }, '<img width> 的显示尺寸保留');
});

test('非 MarkFlow JSON 不动；契约函数缺席时只记 warning 不回滚 md；content_list 不存在时不凭空创建', async () => {
    const foreign = makeBundle('foreign', { json: '{"foo":1}' });
    const stub = sidecarStub();
    const kept = await mdEdit.saveMarkdownFile({ filePath: foreign.mdPath, text: '# x\n', base: baseOf(foreign.mdPath), core: stub.core });
    assert.deepEqual(kept.sidecars, []);
    assert.equal(stub.calls.length, 0);
    assert.equal(fs.readFileSync(path.join(foreign.dir, 'doc.json'), 'utf8'), '{"foo":1}');

    const absent = makeBundle('absent');
    const before = fs.readFileSync(path.join(absent.dir, 'doc.json'), 'utf8');
    const result = await mdEdit.saveMarkdownFile({ filePath: absent.mdPath, text: '# y\n', base: baseOf(absent.mdPath), core: { renderBundleSidecars: null } });
    assert.equal(result.saved, true);
    assert.equal(fs.readFileSync(absent.mdPath, 'utf8'), '# y\n');
    assert.ok(result.warnings.some((item) => /renderBundleSidecars/.test(item)));
    assert.equal(fs.readFileSync(path.join(absent.dir, 'doc.json'), 'utf8'), before);

    const legacy = makeBundle('legacy', { withContentList: false });
    const legacyStub = sidecarStub();
    const legacyResult = await mdEdit.saveMarkdownFile({ filePath: legacy.mdPath, text: '# z\n', base: baseOf(legacy.mdPath), core: legacyStub.core });
    assert.deepEqual(legacyResult.sidecars, [path.join(legacy.dir, 'doc.json')]);
    assert.equal(fs.existsSync(path.join(legacy.dir, 'doc_content_list.json')), false);
});

test('契约函数抛错：md 已保存，旁路失败记 warning', async () => {
    const bundle = makeBundle('throws');
    const result = await mdEdit.saveMarkdownFile({
        filePath: bundle.mdPath, text: '# t\n', base: baseOf(bundle.mdPath),
        core: { renderBundleSidecars: async () => { throw new Error('boom'); } },
    });
    assert.equal(result.saved, true);
    assert.equal(fs.readFileSync(bundle.mdPath, 'utf8'), '# t\n');
    assert.ok(result.warnings.some((item) => /旁路 JSON 重建失败：boom/.test(item)));
});

test('stripAbsolutePaths 与 restoreLocalImageUrls：只留相对路径与白名单 data 键', () => {
    assert.deepEqual(mdEdit.stripAbsolutePaths({ a: 1, baseDir: 'rel', p: '/abs/x', w: 'C:\\x\\y', u: 'https://x' }), { a: 1, u: 'https://x' });
    assert.deepEqual(mdEdit.stripAbsolutePaths(null), {});
    const base = path.join(root, 'restore');
    const ir = {
        type: 'root',
        children: [
            { type: 'image', url: 'images/image_1.png', data: { assetName: 'images/image_1.png', display: { width: 300, unit: 'px' }, asset: { absPath: path.join(base, 'images', 'orig.png'), buffer: Buffer.from('x') } } },
            { type: 'image', url: 'images/image_2.png', data: { assetName: 'images/image_2.png', asset: { absPath: path.join(root, 'elsewhere.png'), buffer: Buffer.from('y') } } },
        ],
    };
    mdEdit.restoreLocalImageUrls(ir, base);
    assert.equal(ir.children[0].url, 'images/orig.png');
    assert.deepEqual(ir.children[0].data, { display: { width: 300, unit: 'px' }, assetName: 'images/orig.png' });
    assert.deepEqual(ir.children[1].data, { assetName: 'images/image_2.png' }, '目录外的图片只剥掉 data.asset');
});
