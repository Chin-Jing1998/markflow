/**
 * desktop/main/addin/guard.js 与 output-location.js 单元测试（纯逻辑，脱离 Electron）
 * 覆盖：令牌生成与恒定时间比较；Host / Origin 判定；checkRequest 的判定顺序与状态码
 *       （Host 403 → Origin 403 → 非 GET 缺自定义头 403 → 令牌 401）；请求头的百分号解码与畸形输入；
 *       输出位置裁决：合法源路径存到源文件旁、非法源路径（相对、含 ..、不存在、目录不可写、云端地址）
 *       与未保存文档一律改存输出目录，产物名取自文件名，取不到时用「未命名文档-时间戳」。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const guard = require('../desktop/main/addin/guard');
const { resolveOutputLocation, normalizeSourcePath, baseNameFromFileName, BASIS } = require('../desktop/main/addin/output-location');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'addin-guard-'));
after(() => {
    fs.chmodSync(path.join(root, 'readonly'), 0o755);
    fs.rmSync(root, { recursive: true, force: true });
});

const PORT = 49731;
const TOKEN = guard.createToken();
const okHeaders = (extra = {}) => ({ host: `localhost:${PORT}`, ...extra });

// ============================================================
// 令牌
// ============================================================

test('createToken：32 字节 base64url，每次不同', () => {
    assert.match(TOKEN, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(TOKEN, 'base64url').length, guard.TOKEN_BYTES);
    assert.notEqual(guard.createToken(), guard.createToken());
});

test('tokenMatches：只有完全相同才通过；空令牌、缺席、长度不同与数组一律不通过且不抛出', () => {
    assert.equal(guard.tokenMatches(TOKEN, TOKEN), true);
    assert.equal(guard.tokenMatches(TOKEN, `${TOKEN}x`), false);
    assert.equal(guard.tokenMatches(TOKEN, TOKEN.slice(0, -1)), false);
    assert.equal(guard.tokenMatches(TOKEN, ''), false);
    assert.equal(guard.tokenMatches(TOKEN, undefined), false);
    assert.equal(guard.tokenMatches(TOKEN, [TOKEN, TOKEN]), false, '重复的头在 Node 里是数组');
    assert.equal(guard.tokenMatches('', ''), false, '服务端没有令牌时任何请求都不通过');
    assert.equal(guard.tokenMatches(undefined, undefined), false);
});

// ============================================================
// Host / Origin / checkRequest
// ============================================================

test('isHostAllowed：只认 localhost 与 127.0.0.1 加本服务端口', () => {
    assert.equal(guard.isHostAllowed(`localhost:${PORT}`, PORT), true);
    assert.equal(guard.isHostAllowed(`127.0.0.1:${PORT}`, PORT), true);
    for (const bad of [undefined, '', 'localhost', `localhost:${PORT + 1}`, `evil.example:${PORT}`, `localhost.evil.example:${PORT}`,
        `LOCALHOST:${PORT}`, `[::1]:${PORT}`, `0.0.0.0:${PORT}`, `127.0.0.1:${PORT}.evil.example`, ` localhost:${PORT}`]) {
        assert.equal(guard.isHostAllowed(bad, PORT), false, String(bad));
    }
});

test('isOriginAllowed：缺席放行；出现则必须是本源，null 与 https 同名源也拒绝', () => {
    assert.equal(guard.isOriginAllowed(undefined, PORT), true);
    assert.equal(guard.isOriginAllowed(`http://localhost:${PORT}`, PORT), true);
    assert.equal(guard.isOriginAllowed(`http://127.0.0.1:${PORT}`, PORT), true);
    for (const bad of ['null', '', `https://localhost:${PORT}`, `http://localhost:${PORT}/`, 'http://localhost', `http://evil.example:${PORT}`, 'https://evil.example']) {
        assert.equal(guard.isOriginAllowed(bad, PORT), false, bad);
    }
});

test('checkRequest：判定顺序 Host → Origin → 自定义头 → 令牌，状态码分别为 403 / 403 / 403 / 401', () => {
    const base = { port: PORT, token: TOKEN, needsToken: true };
    const full = okHeaders({ origin: `http://localhost:${PORT}`, [guard.CLIENT_HEADER]: guard.CLIENT_HEADER_VALUE, [guard.TOKEN_HEADER]: TOKEN });
    assert.equal(guard.checkRequest({ ...base, method: 'POST', headers: full }), null);
    assert.equal(guard.checkRequest({ ...base, method: 'GET', headers: okHeaders({ [guard.TOKEN_HEADER]: TOKEN }) }), null, 'GET 不要求自定义头');

    const badHost = guard.checkRequest({ ...base, method: 'POST', headers: { ...full, host: `evil.example:${PORT}` } });
    assert.deepEqual([badHost.status, badHost.code], [403, 'bad-host']);
    const badOrigin = guard.checkRequest({ ...base, method: 'POST', headers: { ...full, origin: 'https://evil.example' } });
    assert.deepEqual([badOrigin.status, badOrigin.code], [403, 'bad-origin']);
    const { [guard.CLIENT_HEADER]: dropped, ...noClient } = full;
    const missing = guard.checkRequest({ ...base, method: 'POST', headers: noClient });
    assert.deepEqual([missing.status, missing.code], [403, 'missing-client-header'], '带着正确令牌也不行');
    const wrongClient = guard.checkRequest({ ...base, method: 'DELETE', headers: { ...full, [guard.CLIENT_HEADER]: 'x' } });
    assert.equal(wrongClient.code, 'missing-client-header');
    const noToken = guard.checkRequest({ ...base, method: 'GET', headers: okHeaders() });
    assert.deepEqual([noToken.status, noToken.code], [401, 'unauthorized']);
    const wrongToken = guard.checkRequest({ ...base, method: 'POST', headers: { ...full, [guard.TOKEN_HEADER]: guard.createToken() } });
    assert.deepEqual([wrongToken.status, wrongToken.code], [401, 'unauthorized']);
    assert.equal(guard.checkRequest({ port: PORT, token: TOKEN, needsToken: false, method: 'GET', headers: okHeaders() }), null, '探活与静态资源免令牌');
    assert.equal(guard.checkRequest({ port: PORT, token: TOKEN, needsToken: false, method: 'GET', headers: undefined }).code, 'bad-host', '没有头即没有 Host');
});

test('拒绝文案不含令牌', () => {
    const denied = guard.checkRequest({ port: PORT, token: TOKEN, needsToken: true, method: 'GET', headers: okHeaders({ [guard.TOKEN_HEADER]: 'wrong' }) });
    assert.ok(!JSON.stringify(denied).includes(TOKEN));
});

test('decodeHeaderValue：百分号解码；缺席回空串；畸形、重复、超长与控制字符抛 400', () => {
    assert.equal(guard.decodeHeaderValue(undefined), '');
    assert.equal(guard.decodeHeaderValue(''), '');
    assert.equal(guard.decodeHeaderValue(encodeURIComponent('/Users/张三/案件 A/申请 文件.docx')), '/Users/张三/案件 A/申请 文件.docx');
    const bad = [['%E0%A4%A', '畸形编码'], [['a', 'b'], '重复的头'], [encodeURIComponent('a\u0000b'), 'NUL'], [encodeURIComponent('a\nb'), '换行'], ['x'.repeat(11), '超长']];
    for (const [raw, label] of bad) {
        assert.throws(() => guard.decodeHeaderValue(raw, { name: '文件名', maxLength: 10 }), (err) => err instanceof guard.GuardError && err.status === 400 && err.code === 'bad-header', label);
    }
});

// ============================================================
// 输出位置
// ============================================================

const fallbackDir = path.join(root, 'fallback');
const caseDir = path.join(root, '案件 A');
fs.mkdirSync(caseDir, { recursive: true });
const savedDoc = path.join(caseDir, '一种装置-发明.docx');
fs.writeFileSync(savedDoc, 'x');
/** Word 加载项只面向 macOS；Windows 没有 POSIX 权限位，chmod 造不出只读目录，「a:」在那里又是盘符前缀——相关断言只在 POSIX 上执行 */
const IS_POSIX = process.platform !== 'win32';
const readonlyDir = path.join(root, 'readonly');
fs.mkdirSync(readonlyDir);
fs.writeFileSync(path.join(readonlyDir, '只读.docx'), 'x');
fs.chmodSync(readonlyDir, 0o555);
const FIXED_NOW = () => new Date(2026, 8, 18, 9, 5, 7);

test('normalizeSourcePath：绝对路径与 file:// 通过；空、相对、含 ..、云端地址不通过', () => {
    assert.deepEqual(normalizeSourcePath(savedDoc), { ok: true, path: savedDoc });
    assert.deepEqual(normalizeSourcePath(pathToFileURL(savedDoc).href), { ok: true, path: savedDoc });
    for (const bad of ['', '   ', undefined, null, 42, 'a.docx', './a.docx', '../a.docx', '/a/../etc/passwd', '/a/b/..', 'https://x.sharepoint.com/a.docx', 'file://%E0%A4%A']) {
        assert.equal(normalizeSourcePath(bad).ok, false, String(bad));
    }
    assert.match(normalizeSourcePath('').note, /尚未保存/);
    assert.match(normalizeSourcePath('https://x.sharepoint.com/a.docx').note, /云端/);
    assert.match(normalizeSourcePath('/a/../b.docx').note, /\.\. 段/);
});

test('合法源路径：产物存到源文件所在目录，产物名取自文件名', async () => {
    const location = await resolveOutputLocation({ sourcePath: savedDoc, fileName: '别的名字.docx', fallbackDir, now: FIXED_NOW });
    assert.deepEqual(location, { outputDir: caseDir, baseName: '一种装置-发明', basis: BASIS.SOURCE_DIR, sourcePath: savedDoc, note: null });
    assert.equal(fs.existsSync(fallbackDir), false, '用不到输出目录时不创建它');
});

test('未保存文档：存到输出目录（不存在则创建），名字为「未命名文档-时间戳」', async () => {
    const location = await resolveOutputLocation({ sourcePath: '', fileName: '', fallbackDir, now: FIXED_NOW });
    assert.equal(location.outputDir, fallbackDir);
    assert.equal(location.baseName, '未命名文档-20260918-090507');
    assert.equal(location.basis, BASIS.OUTPUT_DIR);
    assert.equal(location.sourcePath, null);
    assert.match(location.note, /尚未保存/);
    assert.ok(fs.statSync(fallbackDir).isDirectory());
});

test('非法源路径：一律弃用并改存输出目录，绝不写到由该路径推导出的位置', async () => {
    const cases = [
        // 词法上就不合法的路径，连文件名部分也不借用
        ['../../etc/x.docx', /不是绝对路径/, '未命名文档-20260918-090507'],
        [`${caseDir}/../../逃逸.docx`, /\.\. 段/, '未命名文档-20260918-090507'],
        [path.join(caseDir, '不存在.docx'), /没有这个文件/, '不存在'],
        [caseDir, /没有这个文件/, '案件 A'],
        ...(IS_POSIX ? [[path.join(readonlyDir, '只读.docx'), /不可写/, '只读']] : []),
        ['https://contoso.sharepoint.com/sites/a/%E4%BA%91%E7%AB%AF.docx', /云端/, '未命名文档-20260918-090507'],
    ];
    for (const [sourcePath, noteRe, baseName] of cases) {
        const location = await resolveOutputLocation({ sourcePath, fileName: '', fallbackDir, now: FIXED_NOW });
        assert.equal(location.outputDir, fallbackDir, sourcePath);
        assert.equal(location.basis, BASIS.OUTPUT_DIR, sourcePath);
        assert.equal(location.sourcePath, null, sourcePath);
        assert.match(location.note, noteRe, sourcePath);
        assert.equal(location.baseName, baseName, sourcePath);
    }
});

test('文件名只用来起名：目录部分与扩展名被剥掉，非法字符被清洗', async () => {
    assert.equal(baseNameFromFileName('../../etc/cron.d/evil.docx'), 'evil');
    assert.equal(baseNameFromFileName('C:\\Users\\x\\申请.docx'), '申请');
    if (IS_POSIX) assert.equal(baseNameFromFileName('a:b*c?.docx'), 'a_b_c', '非法字符换成下划线，首尾的下划线由 sanitizeFolderName 剥掉');
    assert.equal(baseNameFromFileName('   '), '');
    assert.equal(baseNameFromFileName('..'), '');
    const location = await resolveOutputLocation({ sourcePath: 'https://x.example/云端.docx', fileName: '../../云端文档.docx', fallbackDir, now: FIXED_NOW });
    assert.equal(location.baseName, '云端文档');
    assert.equal(location.outputDir, fallbackDir);
});

test('输出目录未设置、不是绝对路径或无法创建时抛中文错误', async () => {
    await assert.rejects(resolveOutputLocation({ sourcePath: '', fallbackDir: '' }), /输出目录未设置/);
    await assert.rejects(resolveOutputLocation({ sourcePath: '', fallbackDir: 'relative/dir' }), /输出目录未设置或不是绝对路径/);
    await assert.rejects(resolveOutputLocation({ sourcePath: '', fallbackDir: path.join(savedDoc, 'under-a-file') }), /输出目录不可用/);
});
