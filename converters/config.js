/**
 * 用户配置与凭据读取
 *
 * 配置文件：~/.markflow/config.json（目录 0700、文件 0600、临时文件 + rename 原子写）；
 * 目录可由环境变量 MARKFLOW_CONFIG_DIR 覆盖（测试隔离与便携部署）。
 *
 *   readConfig()                        → 配置对象；文件不存在返回 {}；文件损坏抛中文错误（指明文件路径）
 *   setConfig(patch)                    → 合并后的配置；patch 中值为 null 的键被删除
 *   getMineruToken({ explicit })        → { token, source }，token 取不到时为 null。优先级：
 *                                         explicit（调用方显式传入）→ 环境变量 MINERU_TOKEN → MINERU_API_TOKEN
 *                                         → config.json 的 mineruToken → ~/.mineru/config.yaml（官方 CLI 配置，只读兼容）
 *                                         source 取 'explicit' | 'env:MINERU_TOKEN' | 'env:MINERU_API_TOKEN' | 'config' | 'mineru-cli' | null
 *
 * 本模块不打印任何内容；调用方向用户展示时只能透出 source 与「是否已配置」，不得输出 token。
 * ~/.mineru/config.yaml 只按正则提取 token / api_token / api-key 一类键，不引入 YAML 依赖。
 */
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { errText } = require('./util');

const CONFIG_DIR_ENV = 'MARKFLOW_CONFIG_DIR';
const CONFIG_DIRNAME = '.markflow';
const CONFIG_FILENAME = 'config.json';
const MINERU_CLI_CONFIG = Object.freeze(['.mineru', 'config.yaml']);
const CONFIG_TOKEN_KEY = 'mineruToken';
const TOKEN_ENV_VARS = Object.freeze(['MINERU_TOKEN', 'MINERU_API_TOKEN']);
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const JSON_INDENT = 2;
// 官方 CLI 的 YAML：token: xxx / api_token: "xxx" / api-key: 'xxx' / mineru_token: xxx，允许缩进与行尾注释
const YAML_TOKEN_RE = /^[ \t]*(?:mineru[_-]?)?(?:api[_-]?)?(?:token|key)[ \t]*:[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#'"\s][^\r\n]*?))[ \t]*(?:#[^\r\n]*)?$/im;
// YAML 中表示空值的字面量
const YAML_EMPTY_VALUES = new Set(['', 'null', '~']);

const noop = () => undefined;
let deps = {};

const getEnv = () => deps.env || process.env;
const getHomeDir = () => (typeof deps.homeDir === 'string' && deps.homeDir ? deps.homeDir : os.homedir());

function getConfigDir() {
    const override = typeof getEnv()[CONFIG_DIR_ENV] === 'string' ? getEnv()[CONFIG_DIR_ENV].trim() : '';
    return override ? path.resolve(override) : path.join(getHomeDir(), CONFIG_DIRNAME);
}

const getConfigPath = () => path.join(getConfigDir(), CONFIG_FILENAME);

async function readConfig() {
    const file = getConfigPath();
    let text;
    try {
        text = await fsp.readFile(file, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return {};
        throw new Error(`读取配置文件失败：${file}（${errText(err)}）`);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new Error(`配置文件不是合法 JSON：${file}（${errText(err)}）`);
    }
    if (!isPlainObject(parsed)) throw new Error(`配置文件顶层须为 JSON 对象：${file}`);
    return parsed;
}

async function setConfig(patch) {
    if (!isPlainObject(patch)) throw new Error('setConfig 需要对象形式的 patch');
    for (const [key, value] of Object.entries(patch)) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error(`配置键名非法：${key}`);
        if (value !== null && value !== undefined && !['string', 'number', 'boolean'].includes(typeof value)) {
            throw new Error(`配置项 ${key} 只接受字符串、数字、布尔值或 null`);
        }
    }
    const next = { ...(await readConfig()) };
    for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) delete next[key];
        else next[key] = value;
    }
    await writeConfigAtomic(next);
    return next;
}

// 先写同目录临时文件（wx + 0600），再 rename 覆盖；任一步失败都清掉临时文件
async function writeConfigAtomic(config) {
    const dir = getConfigDir();
    const file = getConfigPath();
    await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
    // 目录已存在时 mkdir 不改权限，显式收紧；不支持 POSIX 权限的平台（Windows）失败静默
    await fsp.chmod(dir, DIR_MODE).catch(noop);
    const tmp = path.join(dir, `${CONFIG_FILENAME}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
        await fsp.writeFile(tmp, `${JSON.stringify(config, null, JSON_INDENT)}\n`, { mode: FILE_MODE, flag: 'wx' });
        await fsp.rename(tmp, file);
    } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(noop);
        throw new Error(`写入配置文件失败：${file}（${errText(err)}）`);
    }
    await fsp.chmod(file, FILE_MODE).catch(noop);
}

async function getMineruToken({ explicit } = {}) {
    const given = cleanToken(explicit);
    if (given) return { token: given, source: 'explicit' };

    const env = getEnv();
    for (const name of TOKEN_ENV_VARS) {
        const value = cleanToken(env[name]);
        if (value) return { token: value, source: `env:${name}` };
    }

    const config = await readConfig();
    const fromConfig = cleanToken(config[CONFIG_TOKEN_KEY]);
    if (fromConfig) return { token: fromConfig, source: 'config' };

    const fromCli = await readMineruCliToken();
    if (fromCli) return { token: fromCli, source: 'mineru-cli' };

    return { token: null, source: null };
}

// 官方 CLI 配置只读兼容：文件缺失、不可读或没有可识别的键一律视为未配置
async function readMineruCliToken() {
    const file = path.join(getHomeDir(), ...MINERU_CLI_CONFIG);
    let text;
    try {
        text = await fsp.readFile(file, 'utf8');
    } catch (err) {
        return null;
    }
    const matched = YAML_TOKEN_RE.exec(text);
    if (!matched) return null;
    const value = cleanToken(matched[1] !== undefined ? matched[1] : (matched[2] !== undefined ? matched[2] : matched[3]));
    return value && !YAML_EMPTY_VALUES.has(value.toLowerCase()) ? value : null;
}

const cleanToken = (value) => (typeof value === 'string' ? value.trim() : '');

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/** 测试钩子：{ env, homeDir } 覆盖环境变量与用户主目录 */
function _setDeps(next = {}) { deps = { ...deps, ...next }; }
function _reset() { deps = {}; }

module.exports = {
    readConfig, setConfig, getMineruToken, getConfigDir, getConfigPath,
    CONFIG_DIR_ENV, CONFIG_TOKEN_KEY, TOKEN_ENV_VARS,
    _setDeps, _reset,
};
