/**
 * converters/config.js 单元测试
 * 覆盖：配置目录（默认 ~/.markflow 与 MARKFLOW_CONFIG_DIR 覆盖）、readConfig 缺失/损坏、
 *       setConfig 原子写与权限（目录 0700、文件 0600、无临时文件残留）、patch 校验与 null 删键、
 *       getMineruToken 五级优先级与来源标记、~/.mineru/config.yaml 的正则兼容、返回值形状
 *
 * 全程用 _setDeps 注入隔离的环境变量与家目录：env 不继承进程环境，本机已设置的 MINERU_API_TOKEN 不会干扰。
 */
const { test, describe, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../converters/config');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'config-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => config._reset());

const IS_POSIX = process.platform !== 'win32';
const modeOf = (target) => fs.statSync(target).mode & 0o777;

let counter = 0;
// 每个用例独立的家目录与环境变量
function isolate(env = {}) {
    counter += 1;
    const homeDir = path.join(root, `home-${counter}`);
    fs.mkdirSync(homeDir, { recursive: true });
    config._setDeps({ env: { ...env }, homeDir });
    return homeDir;
}

function writeMineruYaml(homeDir, text) {
    const dir = path.join(homeDir, '.mineru');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.yaml'), text);
}

// ============================================================
// 配置目录与 readConfig
// ============================================================

describe('配置目录与 readConfig', () => {
    test('默认目录为 ~/.markflow，MARKFLOW_CONFIG_DIR 可覆盖', () => {
        const homeDir = isolate();
        assert.equal(config.getConfigDir(), path.join(homeDir, '.markflow'));
        assert.equal(config.getConfigPath(), path.join(homeDir, '.markflow', 'config.json'));

        const custom = path.join(root, 'custom-dir');
        isolate({ MARKFLOW_CONFIG_DIR: custom });
        assert.equal(config.getConfigDir(), custom);
        assert.equal(config.CONFIG_DIR_ENV, 'MARKFLOW_CONFIG_DIR');
    });

    test('配置文件不存在时 readConfig 返回空对象', async () => {
        isolate();
        assert.deepEqual(await config.readConfig(), {});
    });

    test('配置文件损坏或顶层非对象时抛出指明路径的中文错误', async () => {
        const homeDir = isolate();
        const dir = path.join(homeDir, '.markflow');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'config.json');

        fs.writeFileSync(file, '{ not json');
        await assert.rejects(config.readConfig(), (err) => /配置文件不是合法 JSON：/.test(err.message) && err.message.includes(file));

        fs.writeFileSync(file, '[1, 2]');
        await assert.rejects(config.readConfig(), /配置文件顶层须为 JSON 对象：/);
    });
});

// ============================================================
// setConfig
// ============================================================

describe('setConfig', () => {
    test('首次写入创建 0700 目录与 0600 文件，原子写不留临时文件，返回合并后的配置', async () => {
        // Arrange
        const homeDir = isolate();
        const dir = path.join(homeDir, '.markflow');

        // Act
        const result = await config.setConfig({ mineruToken: 'tok-1', pdfBackend: 'local' });

        // Assert
        assert.deepEqual(result, { mineruToken: 'tok-1', pdfBackend: 'local' });
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), result);
        assert.deepEqual(fs.readdirSync(dir), ['config.json']);
        if (IS_POSIX) {
            assert.equal(modeOf(dir), 0o700);
            assert.equal(modeOf(path.join(dir, 'config.json')), 0o600);
        }
        assert.deepEqual(await config.readConfig(), result);
    });

    test('再次写入合并既有键，值为 null 的键被删除，既有目录权限被收紧', async () => {
        // Arrange
        const homeDir = isolate();
        const dir = path.join(homeDir, '.markflow');
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
        await config.setConfig({ a: 'x', b: 2, c: true });

        // Act
        const result = await config.setConfig({ b: null, d: 'new' });

        // Assert
        assert.deepEqual(result, { a: 'x', c: true, d: 'new' });
        assert.deepEqual(await config.readConfig(), result);
        if (IS_POSIX) assert.equal(modeOf(dir), 0o700);
    });

    test('patch 非对象、键名非法或值为嵌套对象时拒绝', async () => {
        isolate();
        await assert.rejects(config.setConfig('x'), /setConfig 需要对象形式的 patch/);
        await assert.rejects(config.setConfig({ 'bad key': 1 }), /配置键名非法：bad key/);
        await assert.rejects(config.setConfig({ nested: { a: 1 } }), /配置项 nested 只接受字符串、数字、布尔值或 null/);
    });

    test('MARKFLOW_CONFIG_DIR 覆盖时写入该目录', async () => {
        const custom = path.join(root, 'custom-write');
        isolate({ MARKFLOW_CONFIG_DIR: custom });
        await config.setConfig({ k: 'v' });
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(custom, 'config.json'), 'utf8')), { k: 'v' });
    });
});

// ============================================================
// getMineruToken
// ============================================================

describe('getMineruToken', () => {
    test('优先级：explicit → MINERU_TOKEN → MINERU_API_TOKEN → config.json → ~/.mineru/config.yaml → 未配置', async () => {
        // Arrange：五个来源全部就位
        const homeDir = isolate({ MINERU_TOKEN: 'env-1', MINERU_API_TOKEN: 'env-2' });
        await config.setConfig({ mineruToken: 'cfg-token' });
        writeMineruYaml(homeDir, 'token: yaml-token\n');

        // Act & Assert：逐级撤除
        assert.deepEqual(await config.getMineruToken({ explicit: ' given ' }), { token: 'given', source: 'explicit' });
        assert.deepEqual(await config.getMineruToken(), { token: 'env-1', source: 'env:MINERU_TOKEN' });
        config._setDeps({ env: { MINERU_API_TOKEN: 'env-2' } });
        assert.deepEqual(await config.getMineruToken(), { token: 'env-2', source: 'env:MINERU_API_TOKEN' });
        config._setDeps({ env: {} });
        assert.deepEqual(await config.getMineruToken(), { token: 'cfg-token', source: 'config' });
        await config.setConfig({ mineruToken: null });
        assert.deepEqual(await config.getMineruToken(), { token: 'yaml-token', source: 'mineru-cli' });
        fs.rmSync(path.join(homeDir, '.mineru'), { recursive: true, force: true });
        assert.deepEqual(await config.getMineruToken(), { token: null, source: null });
    });

    test('空白的 explicit 与环境变量视为未给出', async () => {
        isolate({ MINERU_TOKEN: '   ', MINERU_API_TOKEN: '' });
        assert.deepEqual(await config.getMineruToken({ explicit: '  ' }), { token: null, source: null });
    });

    test('~/.mineru/config.yaml 兼容 token / api_token / api-key 等键与引号、缩进、行尾注释', async () => {
        const cases = [
            ['token: plain-value\n', 'plain-value'],
            ['api_token: "quoted value"\n', 'quoted value'],
            ["api-key: 'single quoted'\n", 'single quoted'],
            ['mineru:\n  token: indented  # 注释\n', 'indented'],
            ['api_key: with-comment # trailing\n', 'with-comment'],
            ['other: 1\nmineru_token: mt\n', 'mt'],
            ['token: null\n', null],
            ['token: ~\n', null],
            ['token:\n', null],
            ['model: vlm\n', null],
        ];
        for (const [text, expected] of cases) {
            const homeDir = isolate();
            writeMineruYaml(homeDir, text);
            const result = await config.getMineruToken();
            assert.equal(result.token, expected, JSON.stringify(text));
            assert.equal(result.source, expected ? 'mineru-cli' : null, JSON.stringify(text));
        }
    });

    test('返回值只有 token 与 source 两个字段', async () => {
        isolate({ MINERU_TOKEN: 'x' });
        assert.deepEqual(Object.keys(await config.getMineruToken()), ['token', 'source']);
    });
});
