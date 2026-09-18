/**
 * desktop/main/reader.js 单元测试（授权表与临时目录用真实实现；转换内核多数用例以桩替代，另有一例走真实内核）
 * 覆盖：JSON 合法 / 非法视图；md 打开即渲染、按代次写资产并删 g<gen-2>、文本未变复用缓存、保存写盘与冲突；
 *       第 5 个 md 会话回收最旧会话的资产且再渲染自动恢复（sid 变化、旧 sid 撤销）；
 *       会话硬上限不驱逐编辑中的会话；非 md 调编辑接口报错；close 先等挂起的保存；插图落到 md 所在目录。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createReader, MAX_SESSIONS, MAX_ASSET_SESSIONS, READER_EXTENSIONS } = require('../desktop/main/reader');
const { createAssetGrants } = require('../desktop/main/asset-protocol');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.join(TMP_ROOT, 'reader-')));
const readers = [];
after(async () => {
    for (const reader of readers) await reader.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
});

const write = (rel, content) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
};

/** 桩内核：每次解析给出一张图，渲染结果带图片前缀与原文，便于断言代次目录与文本 */
function stubCore() {
    const calls = { parse: 0, render: 0 };
    return {
        calls,
        parseMarkdown: async (input) => {
            calls.parse += 1;
            return { ir: { type: 'root', children: [] }, meta: { text: input.text }, assets: [{ name: 'images/image_1.png', buffer: Buffer.from('png') }], warnings: [] };
        },
        renderDocument: async (doc, target, options, context) => {
            calls.render += 1;
            return { files: { '{name}.html': `<img src="${context.imageMode.base}images/image_1.png"><pre>${doc.meta.text}</pre>` }, warnings: [] };
        },
        normalizeOptions: (raw) => raw,
    };
}

function makeReader({ real = false } = {}) {
    const grants = createAssetGrants();
    const core = real ? null : stubCore();
    const reader = createReader({ grants, ...(core ? { core } : {}), log: () => undefined });
    readers.push(reader);
    return { reader, grants, core };
}

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

// ============================================================
// JSON
// ============================================================

test('JSON：去 BOM 后格式化为两空格缩进，授权根为文件所在目录', async () => {
    const { reader, grants } = makeReader();
    const file = write('json/ok.json', '\ufeff{"a":1,"b":[1,2]}');
    const opened = await reader.open({ path: file });
    assert.ok(READER_EXTENSIONS.includes('.json'));
    assert.equal(opened.kind, 'json');
    assert.equal(opened.editable, false);
    assert.deepEqual(opened.view, { kind: 'json', json: JSON.stringify({ a: 1, b: [1, 2] }, null, 2), valid: true });
    assert.deepEqual(opened.warnings, []);
    const session = reader.sessions.get(opened.sessionId);
    assert.deepEqual(grants.get(session.sid).roots, [path.dirname(file)]);
});

test('JSON：解析失败按原文显示并给中文提示', async () => {
    const { reader } = makeReader();
    const opened = await reader.open({ path: write('json/bad.json', '{bad') });
    assert.deepEqual(opened.view, { kind: 'json', json: '{bad', valid: false });
    assert.equal(opened.warnings.length, 1);
    assert.match(opened.warnings[0], /^JSON 解析失败，按原文显示：/);
});

// ============================================================
// md 渲染与保存
// ============================================================

test('md：打开即渲染（资产在 g1），带文本渲染递增代次并删 g<gen-2>，文本未变复用缓存', async () => {
    const { reader, core } = makeReader();
    const file = write('md/a.md', '# 原文\r\n');
    const opened = await reader.open({ path: file });
    const session = reader.sessions.get(opened.sessionId);
    assert.equal(opened.editable, true);
    assert.equal(opened.view.raw, '# 原文\r\n', '原文逐字给出');
    assert.equal(opened.mtimeMs, fs.statSync(file).mtimeMs);
    assert.ok(opened.view.html.includes(`mf-asset://${session.sid}/g1/images/image_1.png`));
    assert.ok(fs.existsSync(path.join(session.tempDir, 'g1', 'images', 'image_1.png')));

    const second = await reader.renderMarkdown({ sessionId: opened.sessionId, text: '# 改\n' });
    assert.equal(second.gen, 2);
    assert.ok(second.html.includes('# 改') && second.html.includes('/g2/'));
    const parses = core.calls.parse;
    const cached = await reader.renderMarkdown({ sessionId: opened.sessionId, text: '# 改\n' });
    assert.equal(cached.gen, 2, '文本与 sid 未变时复用上次渲染');
    assert.equal(core.calls.parse, parses);

    await reader.renderMarkdown({ sessionId: opened.sessionId, text: '# 再改\n' });
    assert.equal(fs.existsSync(path.join(session.tempDir, 'g1')), false, 'g<gen-2> 已删除');
    assert.ok(fs.existsSync(path.join(session.tempDir, 'g2')), '上一代保留给仍在显示的预览帧');
    const fromDisk = await reader.renderMarkdown({ sessionId: opened.sessionId });
    assert.ok(fromDisk.html.includes('# 原文'), '不传 text 时读盘');
});

test('md：保存写盘并更新基线；外部修改报冲突且不覆盖；force 覆盖', async () => {
    const { reader } = makeReader();
    const file = write('md/save.md', 'v1');
    const opened = await reader.open({ path: file });
    const session = reader.sessions.get(opened.sessionId);
    const saved = await reader.saveMarkdown({ sessionId: opened.sessionId, text: '# 保存\n' });
    assert.equal(saved.saved, true);
    assert.equal(saved.sessionId, opened.sessionId);
    assert.equal(fs.readFileSync(file, 'utf8'), '# 保存\n');
    assert.deepEqual(session.base, { mtimeMs: fs.statSync(file).mtimeMs, size: fs.statSync(file).size });
    assert.equal(session.editing, true);

    fs.writeFileSync(file, 'external');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    const conflict = await reader.saveMarkdown({ sessionId: opened.sessionId, text: 'mine' });
    assert.equal(conflict.saved, false);
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.missing, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'external');
    const forced = await reader.saveMarkdown({ sessionId: opened.sessionId, text: 'mine', force: true });
    assert.equal(forced.saved, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'mine');
});

test('非 md 会话调编辑接口报「只有 Markdown 文件可以编辑」，未知会话报中文错误', async () => {
    const { reader } = makeReader();
    const opened = await reader.open({ path: write('json/x.json', '{}') });
    await assert.rejects(reader.renderMarkdown({ sessionId: opened.sessionId }), /只有 Markdown 文件可以编辑/);
    await assert.rejects(reader.saveMarkdown({ sessionId: opened.sessionId, text: 'x' }), /只有 Markdown 文件可以编辑/);
    await assert.rejects(reader.importImage({ sessionId: opened.sessionId, sourcePath: '/tmp/a.png' }), /只有 Markdown 文件可以编辑/);
    await assert.rejects(reader.renderMarkdown({ sessionId: 'nope' }), /编辑会话不存在或已关闭，请重新打开文件/);
    await assert.rejects(reader.open({ path: write('json/x.txt', 'x') }), /阅读模式只支持/);
});

// ============================================================
// 资产回收与会话上限
// ============================================================

test('第 5 个 md 会话回收最旧会话的资产；再渲染时自动恢复（sid 变化、旧 sid 撤销）', async () => {
    const { reader, grants } = makeReader();
    const first = await reader.open({ path: write('many/f0.md', '# 0\n') });
    const oldSid = reader.sessions.get(first.sessionId).sid;
    const oldDir = reader.sessions.get(first.sessionId).tempDir;
    const ids = [first.sessionId];
    for (let index = 1; index < 5; index += 1) ids.push((await reader.open({ path: write(`many/f${index}.md`, `# ${index}\n`) })).sessionId);

    const holders = () => [...reader.sessions.values()].filter((item) => item.sid).map((item) => item.id);
    assert.equal(reader.sessions.size, 5, '回收只动资产，会话仍在');
    assert.equal(holders().length, MAX_ASSET_SESSIONS);
    assert.equal(reader.sessions.get(ids[0]).sid, null);
    assert.equal(grants.get(oldSid), null, '旧 sid 已撤销');
    assert.equal(fs.existsSync(oldDir), false, '旧临时目录已删除');

    const revived = await reader.renderMarkdown({ sessionId: ids[0] });
    const session = reader.sessions.get(ids[0]);
    assert.ok(session.sid && session.sid !== oldSid, '重新授权得到新 sid');
    assert.ok(revived.html.includes(`mf-asset://${session.sid}/`));
    assert.ok(grants.get(session.sid));
    assert.equal(holders().length, MAX_ASSET_SESSIONS);
    assert.ok(!holders().includes(ids[1]), '接着回收的是次旧的会话');
});

test('会话总数硬上限只驱逐未编辑的最旧会话', async () => {
    const { reader } = makeReader();
    const md = await reader.open({ path: write('hard/edit.md', '# e\n') });
    await reader.saveMarkdown({ sessionId: md.sessionId, text: '# edited\n' });
    const jsonIds = [];
    for (let index = 0; index < MAX_SESSIONS - 1; index += 1) jsonIds.push((await reader.open({ path: write(`hard/j${index}.json`, '{}') })).sessionId);
    assert.equal(reader.sessions.size, MAX_SESSIONS);
    const extra = await reader.open({ path: write('hard/extra.json', '{}') });
    assert.equal(reader.sessions.size, MAX_SESSIONS);
    assert.ok(reader.sessions.has(md.sessionId), '编辑中的会话即使最旧也不驱逐');
    assert.ok(!reader.sessions.has(jsonIds[0]), '驱逐最旧的未编辑会话');
    assert.ok(reader.sessions.has(extra.sessionId));
});

// ============================================================
// close 与插图
// ============================================================

test('close 先等挂起的保存跑完，再撤销授权、删临时目录', async () => {
    const { reader, grants } = makeReader();
    const file = write('close/a.md', 'v1');
    const opened = await reader.open({ path: file });
    const { sid, tempDir } = reader.sessions.get(opened.sessionId);
    const pending = reader.saveMarkdown({ sessionId: opened.sessionId, text: 'v2' });
    assert.deepEqual(await reader.close({ sessionId: opened.sessionId }), { closed: true });
    assert.equal(fs.readFileSync(file, 'utf8'), 'v2');
    assert.equal((await pending).saved, true);
    assert.equal(grants.get(sid), null);
    assert.equal(fs.existsSync(tempDir), false);
    assert.deepEqual(await reader.close({ sessionId: opened.sessionId }), { closed: false });
});

test('importImage 复制到 md 所在目录的 images/；插图对话框默认目录为 md 所在目录', async () => {
    const { reader } = makeReader();
    const file = write('img/doc.md', '# d\n');
    const source = write('img-src/p.png', pngHeader(40, 30));
    const opened = await reader.open({ path: file });
    const result = await reader.importImage({ sessionId: opened.sessionId, sourcePath: source });
    assert.deepEqual(result, { relPath: 'images/p.png', width: 40, height: 30, alt: 'p' });
    assert.ok(fs.existsSync(path.join(path.dirname(file), 'images', 'p.png')));
    assert.equal(reader.imageDialogDir({ sessionId: opened.sessionId }), path.dirname(file));
});

test('真实转换内核：md 图片落到 g1 并经 mf-asset 寻址', async () => {
    const { reader } = makeReader({ real: true });
    const dir = path.join(root, 'real');
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images', 'real.png'), pngHeader(16, 16));
    const file = write('real/doc.md', '# 标题\n\n![图](images/real.png)\n');
    const opened = await reader.open({ path: file });
    const session = reader.sessions.get(opened.sessionId);
    assert.ok(opened.view.html.includes('标题'));
    const match = opened.view.html.match(new RegExp(`mf-asset://${session.sid}/g1/(images/[^"'\\s)]+)`));
    assert.ok(match, `图片未经 mf-asset 的 g1 目录寻址：${opened.view.html.slice(0, 400)}`);
    assert.ok(fs.existsSync(path.join(session.tempDir, 'g1', ...match[1].split('/'))), '资产已写入 g1');
});
