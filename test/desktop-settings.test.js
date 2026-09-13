/**
 * desktop/main/settings.js 单元测试（纯逻辑，safeStorage 以桩替代）
 * 覆盖：默认值、settings.json 原子写与读回、非法 patch 拒绝、defaults 的 null 删除语义、
 *       secrets.json 与 settings.json 分离、令牌不出现在 settings.json / describe() 回包、
 *       解密失败返回 null、safeStorage 不可用时拒绝保存、损坏文件回退默认并告警、secrets 文件权限。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSettingsStore, buildDefaultSettings, THEMES, SETTINGS_FILENAME, SECRETS_FILENAME } = require('../desktop/main/settings');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'settings-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let seq = 0;
const workDir = () => path.join(root, `case-${(seq += 1)}`);

/** 可逆桩：密文 = 'enc:' + 明文；非该形态的密文解密抛错（模拟 safeStorage 对非密文的行为） */
function fakeSafeStorage({ available = true } = {}) {
    return {
        isEncryptionAvailable: () => available,
        encryptString: (text) => Buffer.from(`enc:${text}`, 'utf8'),
        decryptString: (buffer) => {
            const text = Buffer.from(buffer).toString('utf8');
            if (!text.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
            return text.slice(4);
        },
    };
}

const DEFAULTS = (dir) => ({ outputDir: path.join(dir, 'out'), libraryRoot: path.join(dir, 'lib') });
const makeStore = (dir, safeStorage = fakeSafeStorage()) => createSettingsStore({ dir, safeStorage, defaults: DEFAULTS(dir) });

test('首次运行：文件缺失时取默认值，不落盘', () => {
    const dir = workDir();
    const store = makeStore(dir);
    const settings = store.load();
    assert.deepEqual(settings, buildDefaultSettings(DEFAULTS(dir)));
    assert.equal(settings.version, 1);
    assert.equal(settings.theme, 'system');
    assert.deepEqual(settings.defaultTargets, { office: 'bundle', markup: 'docx', url: 'bundle' });
    assert.deepEqual(settings.library, { mode: 'index', root: path.join(dir, 'lib') });
    assert.equal(fs.existsSync(path.join(dir, SETTINGS_FILENAME)), false);
    assert.deepEqual(store.warnings(), []);
    assert.deepEqual(THEMES, ['system', 'light', 'dark']);
});

test('set：深合并 + 原子写，重新加载得到同样内容，不留临时文件', async () => {
    const dir = workDir();
    const store = makeStore(dir);
    const next = await store.set({ theme: 'dark', outputDir: path.join(dir, 'custom'), defaults: { theme: 'github', jpegQuality: 85 }, library: { mode: 'managed' } });
    assert.equal(next.theme, 'dark');
    assert.equal(next.outputDir, path.join(dir, 'custom'));
    assert.deepEqual(next.defaults, { theme: 'github', jpegQuality: 85 });
    assert.equal(next.library.mode, 'managed');
    assert.equal(next.library.root, path.join(dir, 'lib'), '未改的字段保留默认');

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, SETTINGS_FILENAME), 'utf8'));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.theme, 'dark');
    assert.ok(fs.readdirSync(dir).every((name) => !name.endsWith('.tmp')), '不留临时文件');

    const again = makeStore(dir);
    assert.deepEqual(again.load(), next);
    // get() 返回副本，改动不影响内部状态
    const copy = again.get();
    copy.theme = 'light';
    assert.equal(again.get().theme, 'dark');
});

test('set：非法值与未知键一律拒绝，磁盘不变', async () => {
    const dir = workDir();
    const store = makeStore(dir);
    await assert.rejects(store.set({ theme: 'blue' }), /设置项不合法/);
    await assert.rejects(store.set({ unknown: 1 }), /设置项不合法/);
    await assert.rejects(store.set({ defaults: { pdfBackend: 'cloud' } }), /设置项不合法/);
    await assert.rejects(store.set({ defaults: { mineruToken: 'x' } }), /设置项不合法/, 'defaults 不接受令牌');
    await assert.rejects(store.set({ library: { mode: 'cloud' } }), /设置项不合法/);
    await assert.rejects(store.set({ defaultTargets: { office: 'nope' } }), /设置项不合法/);
    assert.equal(fs.existsSync(path.join(dir, SETTINGS_FILENAME)), false);
});

test('defaults 的 null 表示删除该默认项', async () => {
    const dir = workDir();
    const store = makeStore(dir);
    await store.set({ defaults: { theme: 'academic', imageFormat: 'keep' } });
    const next = await store.set({ defaults: { theme: null } });
    assert.deepEqual(next.defaults, { imageFormat: 'keep' });
});

test('令牌：加密写入 secrets.json，settings.json 与 describe() 不含明文', async () => {
    const dir = workDir();
    const store = makeStore(dir);
    await store.set({ theme: 'light' });
    assert.equal(store.hasMineruToken(), false);
    assert.equal(store.getMineruToken(), null);

    assert.equal(await store.setMineruToken('  secret-token-xyz  '), true);
    assert.equal(store.hasMineruToken(), true);
    assert.equal(store.getMineruToken(), 'secret-token-xyz');

    const secrets = JSON.parse(fs.readFileSync(path.join(dir, SECRETS_FILENAME), 'utf8'));
    assert.deepEqual(Object.keys(secrets), ['mineruToken']);
    assert.equal(Buffer.from(secrets.mineruToken, 'base64').toString('utf8'), 'enc:secret-token-xyz', '存的是密文的 base64');
    assert.ok(!fs.readFileSync(path.join(dir, SETTINGS_FILENAME), 'utf8').includes('secret-token-xyz'));
    assert.ok(!fs.readFileSync(path.join(dir, SECRETS_FILENAME), 'utf8').includes('secret-token-xyz'), '密文文件不含明文');

    const described = store.describe();
    assert.equal(described.mineruTokenConfigured, true);
    assert.equal(described.encryptionAvailable, true);
    assert.ok(!JSON.stringify(described).includes('secret-token-xyz'));
    assert.ok(!JSON.stringify(described).includes(secrets.mineruToken), '密文也不下发');
    assert.equal(described.paths.secretsPath, path.join(dir, SECRETS_FILENAME));

    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(path.join(dir, SECRETS_FILENAME)).mode & 0o777, 0o600);
    }

    assert.equal(await store.setMineruToken(null), false);
    assert.equal(store.hasMineruToken(), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, SECRETS_FILENAME), 'utf8')), {});
});

test('令牌：解密失败或密文损坏时返回 null，不抛出', async () => {
    const dir = workDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, SECRETS_FILENAME), JSON.stringify({ mineruToken: Buffer.from('garbage').toString('base64') }));
    const store = makeStore(dir);
    assert.equal(store.hasMineruToken(), true, '有密文即视为已配置');
    assert.equal(store.getMineruToken(), null);
    fs.writeFileSync(path.join(dir, SECRETS_FILENAME), 'not json');
    assert.equal(store.hasMineruToken(), false);
    assert.equal(store.getMineruToken(), null);
});

test('safeStorage 不可用时拒绝保存并给中文提示，清除仍可执行', async () => {
    const dir = workDir();
    const store = makeStore(dir, fakeSafeStorage({ available: false }));
    await assert.rejects(store.setMineruToken('abc'), /safeStorage 不可用/);
    assert.equal(fs.existsSync(path.join(dir, SECRETS_FILENAME)), false);
    assert.equal(store.describe().encryptionAvailable, false);
    assert.equal(await store.setMineruToken(null), false);
});

test('令牌：超长与非字符串拒绝', async () => {
    const dir = workDir();
    const store = makeStore(dir);
    await assert.rejects(store.setMineruToken('x'.repeat(513)), /过长/);
    await assert.rejects(store.setMineruToken(123), /字符串/);
});

test('损坏或不合法的 settings.json：回退默认并记录警告，后续 set 可覆盖', async () => {
    const dir = workDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, SETTINGS_FILENAME), '{ broken');
    const store = makeStore(dir);
    const settings = store.load();
    assert.equal(settings.theme, 'system');
    assert.equal(store.warnings().length, 1);
    assert.match(store.warnings()[0], /settings\.json/);

    fs.writeFileSync(path.join(dir, SETTINGS_FILENAME), JSON.stringify({ version: 1, theme: 'purple' }));
    const again = makeStore(dir);
    again.load();
    assert.match(again.warnings()[0], /不合法/);
    const fixed = await again.set({ theme: 'light' });
    assert.equal(fixed.theme, 'light');
    assert.deepEqual(makeStore(dir).load().theme, 'light');
});

test('旧文件缺少新字段时以默认值补齐', () => {
    const dir = workDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, SETTINGS_FILENAME), JSON.stringify({ version: 1, theme: 'dark', outputDir: path.join(dir, 'x') }));
    const store = makeStore(dir);
    const settings = store.load();
    assert.equal(settings.theme, 'dark');
    assert.equal(settings.outputDir, path.join(dir, 'x'));
    assert.deepEqual(settings.library, { mode: 'index', root: path.join(dir, 'lib') });
    assert.deepEqual(store.warnings(), []);
});

test('createSettingsStore 参数校验', () => {
    assert.throws(() => createSettingsStore({ safeStorage: fakeSafeStorage(), defaults: DEFAULTS(root) }), /目录 dir/);
    assert.throws(() => createSettingsStore({ dir: root, defaults: DEFAULTS(root) }), /safeStorage/);
    assert.throws(() => createSettingsStore({ dir: root, safeStorage: fakeSafeStorage(), defaults: {} }), /outputDir/);
});
