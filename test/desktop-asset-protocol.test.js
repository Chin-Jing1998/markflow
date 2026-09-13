/**
 * desktop/main/asset-protocol.js 单元测试（纯逻辑，不依赖 Electron）
 * 覆盖：R4 探针 REPORT.md「阶段 4」第 1 条的 22 例（mf-app 目录边界与 MIME、mf-asset 的越界 ..、绝对路径、
 *       目录 / 文件符号链接、未授权 sid、大小写 sid、非白名单扩展名、目录、不存在文件、正常 jpg / pdf）
 *       以及授权表、CSP 与特权 scheme 参数。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    createAssetGrants, resolveAssetRequest, resolveAppRequest,
    ASSET_EXTENSIONS, DEFAULT_CSP, SCHEME_PRIVILEGES, APP_MIME,
} = require('../desktop/main/asset-protocol');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'asset-protocol-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const ASSET_ROOT = path.join(root, 'assets');
const OUTSIDE_DIR = path.join(root, 'outside');
const APP_DIR = path.join(root, 'app');
const SECRET = path.join(OUTSIDE_DIR, 'secret.jpg');

// ---------- 夹具 ----------
fs.mkdirSync(path.join(ASSET_ROOT, 'sub'), { recursive: true });
fs.mkdirSync(path.join(ASSET_ROOT, 'folder.jpg'), { recursive: true });
fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
fs.mkdirSync(APP_DIR, { recursive: true });
fs.writeFileSync(path.join(ASSET_ROOT, 'sample.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
fs.writeFileSync(path.join(ASSET_ROOT, 'sample.pdf'), '%PDF-1.4\n%mock\n');
fs.writeFileSync(path.join(ASSET_ROOT, 'sub', 'inner.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
fs.writeFileSync(path.join(ASSET_ROOT, 'script.js'), 'console.log(1)');
fs.writeFileSync(SECRET, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
fs.writeFileSync(path.join(root, 'package.json'), '{"name":"outside"}');
fs.writeFileSync(path.join(APP_DIR, 'index.html'), '<!doctype html><title>app</title>');
fs.writeFileSync(path.join(APP_DIR, 'main.js'), 'export const x = 1;');
fs.writeFileSync(path.join(APP_DIR, 'style.css'), 'body{}');
fs.writeFileSync(path.join(APP_DIR, 'secret.txt'), 'nope');
let symlinksReady = true;
try {
    fs.symlinkSync('../outside', path.join(ASSET_ROOT, 'link-out'));
    fs.symlinkSync('../outside/secret.jpg', path.join(ASSET_ROOT, 'link-file.jpg'));
} catch (err) {
    symlinksReady = false;
}

const grants = createAssetGrants();
const sid = grants.grant([ASSET_ROOT]);
const asset = (rel) => `mf-asset://${sid}/${rel}`;
const resolveAsset = (url) => resolveAssetRequest({ grants: grants.grants, url });
const resolveApp = (url) => resolveAppRequest({ rendererDir: APP_DIR, url });

// ---------- 授权表 ----------

test('grant 生成 16 字节小写十六进制 sid，revoke 后查不到', () => {
    assert.match(sid, /^[0-9a-f]{32}$/);
    assert.deepEqual(grants.get(sid), { roots: [ASSET_ROOT] });
    assert.equal(grants.get(sid.toUpperCase()).roots[0], ASSET_ROOT, 'get 按小写查找');
    const temp = grants.grant(ASSET_ROOT);
    assert.equal(grants.size(), 2);
    assert.equal(grants.revoke(temp), true);
    assert.equal(grants.get(temp), null);
    assert.throws(() => grants.grant([]), /至少一个目录/);
});

test('CSP、特权 scheme 与扩展名白名单照 R4 结论', () => {
    assert.equal(DEFAULT_CSP, "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' mf-asset: data:; frame-src mf-asset: about:; connect-src 'none'; object-src 'none'");
    assert.deepEqual(SCHEME_PRIVILEGES.map((item) => item.scheme), ['mf-app', 'mf-asset']);
    assert.deepEqual(SCHEME_PRIVILEGES[0].privileges, { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false });
    assert.deepEqual(SCHEME_PRIVILEGES[1].privileges, { standard: true, secure: true, supportFetchAPI: true, stream: true });
    assert.deepEqual([...ASSET_EXTENSIONS], ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tif', '.tiff', '.pdf']);
    assert.equal(APP_MIME['.js'], 'text/javascript; charset=utf-8');
});

// ---------- 22 例 ----------

const CASES = [
    // mf-app
    { label: 'app index', app: true, url: 'mf-app://app/', status: 200, file: path.join(APP_DIR, 'index.html'), mime: 'text/html; charset=utf-8' },
    { label: 'app module js（MIME 为 text/javascript）', app: true, url: 'mf-app://app/main.js', status: 200, file: path.join(APP_DIR, 'main.js'), mime: 'text/javascript; charset=utf-8' },
    { label: 'app css', app: true, url: 'mf-app://app/style.css', status: 200, mime: 'text/css; charset=utf-8' },
    { label: 'app ..（URL 层归一化后不越界）', app: true, url: 'mf-app://app/../package.json', reject: ['not-found'] },
    { label: 'app 编码 ..%2F', app: true, url: 'mf-app://app/%2e%2e%2Fpackage.json', reject: ['outside-app-dir'] },
    { label: 'app ..%2F 白名单类型', app: true, url: 'mf-app://app/..%2Fpackage.json', reject: ['outside-app-dir'] },
    { label: 'app 非法 host', app: true, url: 'mf-app://other/index.html', reject: ['bad-host'] },
    { label: 'app 非白名单类型', app: true, url: 'mf-app://app/secret.txt', reject: ['unsupported-type'] },
    // mf-asset
    { label: 'asset 正常 jpg', url: asset('sample.jpg'), status: 200, file: path.join(ASSET_ROOT, 'sample.jpg') },
    { label: 'asset 正常 pdf', url: asset('sample.pdf'), status: 200, file: path.join(ASSET_ROOT, 'sample.pdf') },
    { label: 'asset 子目录', url: asset('sub/inner.jpg'), status: 200, file: path.join(ASSET_ROOT, 'sub', 'inner.jpg') },
    { label: 'asset .. 由 URL 归一化', url: asset('sub/../sample.jpg'), status: 200, file: path.join(ASSET_ROOT, 'sample.jpg') },
    { label: 'asset 编码 ..%2F 越界', url: asset('..%2Foutside%2Fsecret.jpg'), reject: ['outside-root'] },
    { label: 'asset %2e%2e 段', url: asset('%2e%2e/outside/secret.jpg'), reject: ['outside-root', 'not-found'] },
    { label: 'asset 绝对路径（整段编码）', url: asset(encodeURIComponent(SECRET)), reject: ['not-found', 'outside-root'] },
    { label: 'asset 绝对路径（双斜杠）', url: `mf-asset://${sid}//${SECRET.replace(/^[\\/]+/, '')}`, reject: ['not-found', 'outside-root'] },
    { label: 'asset 目录符号链接越界', url: asset('link-out/secret.jpg'), reject: ['symlink-escape'], symlink: true },
    { label: 'asset 文件符号链接越界', url: asset('link-file.jpg'), reject: ['symlink-escape'], symlink: true },
    { label: 'asset 未授权 sid', url: `mf-asset://${'0'.repeat(32)}/sample.jpg`, reject: ['sid-not-granted'] },
    { label: 'asset 大写 sid（标准 scheme 的 host 会被小写化，命中同一授权）', url: `mf-asset://${sid.toUpperCase()}/sample.jpg`, status: 200, file: path.join(ASSET_ROOT, 'sample.jpg') },
    { label: 'asset 扩展名不在白名单', url: asset('script.js'), reject: ['ext-not-allowed'] },
    { label: 'asset 目录（无扩展名）', url: asset('sub'), reject: ['ext-not-allowed'] },
    { label: 'asset 目录（带 .jpg 扩展名）', url: asset('folder.jpg'), reject: ['not-a-file'] },
    { label: 'asset 不存在', url: asset('nope.jpg'), reject: ['not-found'] },
    { label: 'asset 非法 URL', url: 'mf-asset://', reject: ['bad-url', 'sid-not-granted'] },
    { label: 'asset 其它 scheme', url: 'file:///etc/passwd', reject: ['bad-url'] },
];

for (const item of CASES) {
    test(`协议处理：${item.label}`, async (t) => {
        if (item.symlink && !symlinksReady) {
            t.skip('本机无法创建符号链接');
            return;
        }
        const hit = item.app ? await resolveApp(item.url) : await resolveAsset(item.url);
        if (item.status === 200) {
            assert.equal(hit.status, 200, `${item.url} → ${JSON.stringify(hit)}`);
            if (item.file) assert.equal(hit.filePath, item.file);
            if (item.mime) assert.equal(hit.mime, item.mime);
            return;
        }
        assert.notEqual(hit.status, 200, `${item.url} 不应放行：${JSON.stringify(hit)}`);
        assert.ok(hit.status === 403 || hit.status === 404 || hit.status === 400, `状态码应为 4xx：${hit.status}`);
        assert.ok(item.reject.includes(hit.reason), `${item.url} 拒绝原因应为 ${item.reject.join(' / ')}，实际 ${hit.reason}`);
    });
}

test('revoke 后同一 sid 立即失效', async () => {
    const temp = grants.grant(ASSET_ROOT);
    assert.equal((await resolveAssetRequest({ grants: grants.grants, url: `mf-asset://${temp}/sample.jpg` })).status, 200);
    grants.revoke(temp);
    const hit = await resolveAssetRequest({ grants: grants.grants, url: `mf-asset://${temp}/sample.jpg` });
    assert.deepEqual(hit, { status: 403, reason: 'sid-not-granted' });
});

test('多个 root 按顺序查找，任一 root 命中即返回', async () => {
    const temp = grants.grant([OUTSIDE_DIR, ASSET_ROOT]);
    const hit = await resolveAssetRequest({ grants: grants.grants, url: `mf-asset://${temp}/sub/inner.jpg` });
    assert.equal(hit.status, 200);
    assert.equal(hit.filePath, path.join(ASSET_ROOT, 'sub', 'inner.jpg'));
    const secret = await resolveAssetRequest({ grants: grants.grants, url: `mf-asset://${temp}/secret.jpg` });
    assert.equal(secret.filePath, SECRET, '第一个 root 内的文件正常放行');
});

test('allowedExts 可收窄白名单', async () => {
    const hit = await resolveAssetRequest({ grants: grants.grants, url: asset('sample.pdf'), allowedExts: ['.jpg'] });
    assert.deepEqual(hit, { status: 403, reason: 'ext-not-allowed' });
});
