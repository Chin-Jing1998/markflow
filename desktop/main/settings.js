/**
 * 桌面端设置与令牌保管（纯逻辑，可在普通 Node 中单测）
 *
 * createSettingsStore({ dir, safeStorage, defaults }) → store
 *   dir          userData 目录：settings.json（普通设置）与 secrets.json（密文令牌，0600）分文件存放
 *   safeStorage  Electron safeStorage 或同形桩 { isEncryptionAvailable(), encryptString(str)→Buffer, decryptString(buf)→str }
 *   defaults     { outputDir, libraryRoot }：首次运行的默认输出目录与托管根目录
 *
 *   load()                 同步读取 settings.json（启动时在 app.ready 前调用，以便恢复 nativeTheme）；
 *                          文件缺失取默认值，损坏或不合法时保留默认值并记入 warnings()
 *   get()                  当前设置（深拷贝）
 *   set(patch)             深合并 + zod 校验 + 原子写（tmp → rename），返回新设置；写操作串行；
 *                          patch.defaults 中值为 null 的键表示删除该默认项
 *   hasMineruToken()       secrets.json 是否存有令牌（同步，不解密）
 *   getMineruToken()       解密令牌；不可用或解密失败返回 null，绝不抛出
 *   setMineruToken(token)  加密后写入 secrets.json；token 为 null / 空串时清除；
 *                          safeStorage.isEncryptionAvailable() 为 false 时拒绝并抛中文错误
 *   describe()             { settings, mineruTokenConfigured, encryptionAvailable, paths, warnings }（供 IPC 回包，不含令牌）
 *   warnings()             最近一次 load 的警告
 *
 * settings.json（version 1）：
 *   { version: 1, theme: 'system'|'light'|'dark', outputDir,
 *     defaultTargets: { office, markup, url },
 *     defaults: { theme?, imageFormat?, jpegQuality?, jpegPpi?, math?, pdfBackend?, mineruModel?, xmlProfile? }（扁平转换选项，交 service.buildOptions），
 *     library: { mode: 'index'|'managed', root, repositories?, activeRepository? } }
 * secrets.json：{ mineruToken: <base64 密文> }。令牌永不进入 settings.json、日志与 IPC 回包。
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');

const { OPTION_ENUMS } = require('../../converters/options');
const { TARGETS, DEFAULT_TARGETS, INPUT_CLASS } = require('../../converters/targets');
const { errText } = require('../../converters/util');

const SETTINGS_VERSION = 1;
const SETTINGS_FILENAME = 'settings.json';
const SECRETS_FILENAME = 'secrets.json';
const SECRET_KEY = 'mineruToken';
const SECRETS_MODE = 0o600;
const MAX_TOKEN_LENGTH = 512;
const MAX_REPOSITORIES = 32;
const JSON_INDENT = 2;
const THEMES = Object.freeze(['system', 'light', 'dark']);
const LIBRARY_MODES = Object.freeze(['index', 'managed']);

const noop = () => undefined;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// ============================================================
// schema
// ============================================================

const nonEmptyPath = z.string().min(1, '不能为空').max(4096);
const targetEnum = z.enum([...TARGETS]);
const themeEnum = z.enum([...THEMES]);

const DEFAULTS_FIELDS = Object.freeze({
    theme: z.enum([...OPTION_ENUMS.htmlThemes]),
    imageFormat: z.enum([...OPTION_ENUMS.imageFormats]),
    jpegQuality: z.number().int().min(60).max(100),
    jpegPpi: z.number().int().min(72).max(600),
    math: z.enum([...OPTION_ENUMS.mathModes]),
    pdfBackend: z.enum([...OPTION_ENUMS.pdfBackends]),
    mineruModel: z.enum([...OPTION_ENUMS.mineruModels]),
    xmlProfile: z.enum([...OPTION_ENUMS.xmlProfiles]),
});
const DefaultsSchema = z.object(Object.fromEntries(Object.entries(DEFAULTS_FIELDS).map(([key, schema]) => [key, schema.optional()]))).strict();
// patch 形态：null 表示删除该默认项
const DefaultsPatchSchema = z.object(Object.fromEntries(Object.entries(DEFAULTS_FIELDS).map(([key, schema]) => [key, schema.nullable().optional()]))).strict();
const DefaultTargetsSchema = z.object({ office: targetEnum, markup: targetEnum, url: targetEnum }).strict();
const LibrarySchema = z.object({
    mode: z.enum([...LIBRARY_MODES]),
    root: nonEmptyPath,
    repositories: z.array(nonEmptyPath).max(MAX_REPOSITORIES).optional(),
    activeRepository: nonEmptyPath.optional(),
}).strict();

const SettingsSchema = z.object({
    version: z.literal(SETTINGS_VERSION),
    theme: themeEnum,
    outputDir: nonEmptyPath,
    defaultTargets: DefaultTargetsSchema,
    defaults: DefaultsSchema,
    library: LibrarySchema,
}).strict();

const SettingsPatchSchema = z.object({
    theme: themeEnum.optional(),
    outputDir: nonEmptyPath.optional(),
    defaultTargets: DefaultTargetsSchema.partial().optional(),
    defaults: DefaultsPatchSchema.optional(),
    library: LibrarySchema.partial().optional(),
}).strict();

/** zod 报错 → 单行中文 */
function formatIssues(error) {
    const issues = error && Array.isArray(error.issues) ? error.issues : [];
    return issues.map((issue) => `${issue.path && issue.path.length ? issue.path.join('.') : '(根)'}：${issue.message}`).join('；') || '未知原因';
}

function buildDefaultSettings({ outputDir, libraryRoot } = {}) {
    if (typeof outputDir !== 'string' || !outputDir.trim()) throw new Error('createSettingsStore 需要 defaults.outputDir');
    if (typeof libraryRoot !== 'string' || !libraryRoot.trim()) throw new Error('createSettingsStore 需要 defaults.libraryRoot');
    return {
        version: SETTINGS_VERSION,
        theme: 'system',
        outputDir: path.resolve(outputDir),
        defaultTargets: {
            office: DEFAULT_TARGETS.docx,
            markup: DEFAULT_TARGETS.md,
            url: DEFAULT_TARGETS.url,
        },
        defaults: {},
        library: { mode: 'index', root: path.resolve(libraryRoot) },
    };
}

// ============================================================
// 文件读写
// ============================================================

function readJsonSync(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err && err.code === 'ENOENT') return { ok: true, data: null };
        return { ok: false, reason: `无法读取：${errText(err)}` };
    }
    try {
        const parsed = JSON.parse(text);
        if (!isPlainObject(parsed)) return { ok: false, reason: '顶层不是 JSON 对象' };
        return { ok: true, data: parsed };
    } catch (err) {
        return { ok: false, reason: `不是合法 JSON：${errText(err)}` };
    }
}

/** 先写同目录临时文件（wx），再 rename 覆盖；任一步失败都清掉临时文件 */
async function writeJsonAtomic(file, data, mode) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const text = `${JSON.stringify(data, null, JSON_INDENT)}\n`;
    try {
        await fsp.writeFile(tmp, text, mode ? { mode, flag: 'wx' } : { flag: 'wx' });
        await fsp.rename(tmp, file);
    } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(noop);
        throw new Error(`写入 ${path.basename(file)} 失败：${errText(err)}`);
    }
    if (mode) await fsp.chmod(file, mode).catch(noop);
}

const clone = (value) => JSON.parse(JSON.stringify(value));

// ============================================================
// 实例
// ============================================================

function createSettingsStore({ dir, safeStorage, defaults } = {}) {
    if (typeof dir !== 'string' || !dir.trim()) throw new Error('createSettingsStore 需要目录 dir');
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
        throw new Error('createSettingsStore 需要 safeStorage（isEncryptionAvailable / encryptString / decryptString）');
    }
    const baseDir = path.resolve(dir);
    const settingsPath = path.join(baseDir, SETTINGS_FILENAME);
    const secretsPath = path.join(baseDir, SECRETS_FILENAME);
    const defaultSettings = buildDefaultSettings(defaults);

    const state = { settings: clone(defaultSettings), warnings: [], loaded: false };
    let queue = Promise.resolve();
    const enqueue = (task) => {
        const run = queue.then(task, task);
        queue = run.then(noop, noop);
        return run;
    };

    // ---------- settings.json ----------

    function load() {
        const warnings = [];
        const read = readJsonSync(settingsPath);
        let next = clone(defaultSettings);
        if (!read.ok) {
            warnings.push(`${SETTINGS_FILENAME} ${read.reason}，已改用默认设置`);
        } else if (read.data) {
            const merged = mergeSettings(defaultSettings, read.data);
            const parsed = SettingsSchema.safeParse(merged);
            if (parsed.success) next = parsed.data;
            else warnings.push(`${SETTINGS_FILENAME} 内容不合法（${formatIssues(parsed.error)}），已改用默认设置`);
        }
        state.settings = next;
        state.warnings = warnings;
        state.loaded = true;
        return clone(next);
    }

    // 顶层与 library / defaultTargets / defaults 各深合并一层；version 以当前程序为准
    function mergeSettings(base, patch) {
        const out = { ...clone(base) };
        for (const [key, value] of Object.entries(patch)) {
            if (key === 'version') continue;
            if (isPlainObject(value) && isPlainObject(out[key])) out[key] = { ...out[key], ...clone(value) };
            else out[key] = clone(value);
        }
        out.version = SETTINGS_VERSION;
        return out;
    }

    function get() {
        if (!state.loaded) load();
        return clone(state.settings);
    }

    const set = (patch) => enqueue(async () => {
        if (!state.loaded) load();
        const checked = SettingsPatchSchema.safeParse(patch);
        if (!checked.success) throw new Error(`设置项不合法：${formatIssues(checked.error)}`);
        const next = applyPatch(state.settings, checked.data);
        const validated = SettingsSchema.safeParse(next);
        if (!validated.success) throw new Error(`设置项不合法：${formatIssues(validated.error)}`);
        await writeJsonAtomic(settingsPath, validated.data);
        state.settings = validated.data;
        return clone(validated.data);
    });

    function applyPatch(current, patch) {
        const next = clone(current);
        if (patch.theme !== undefined) next.theme = patch.theme;
        if (patch.outputDir !== undefined) next.outputDir = path.resolve(patch.outputDir);
        if (patch.defaultTargets) next.defaultTargets = { ...next.defaultTargets, ...patch.defaultTargets };
        if (patch.library) {
            next.library = { ...next.library, ...patch.library };
            next.library.root = path.resolve(next.library.root);
            if (Array.isArray(next.library.repositories)) {
                next.library.repositories = [...new Set(next.library.repositories.map((item) => path.resolve(item)))].slice(0, MAX_REPOSITORIES);
            }
            if (next.library.activeRepository !== undefined) next.library.activeRepository = path.resolve(next.library.activeRepository);
        }
        if (patch.defaults) {
            const merged = { ...next.defaults };
            for (const [key, value] of Object.entries(patch.defaults)) {
                if (value === null) delete merged[key];
                else if (value !== undefined) merged[key] = value;
            }
            next.defaults = merged;
        }
        return next;
    }

    // ---------- secrets.json ----------

    function readSecrets() {
        const read = readJsonSync(secretsPath);
        return read.ok && read.data ? read.data : {};
    }

    function hasMineruToken() {
        const cipher = readSecrets()[SECRET_KEY];
        return typeof cipher === 'string' && cipher.length > 0;
    }

    /** 解密失败（密钥变更、文件损坏、safeStorage 不可用）一律视为未配置 */
    function getMineruToken() {
        try {
            const cipher = readSecrets()[SECRET_KEY];
            if (typeof cipher !== 'string' || !cipher) return null;
            if (!safeStorage.isEncryptionAvailable()) return null;
            const plain = safeStorage.decryptString(Buffer.from(cipher, 'base64'));
            const token = typeof plain === 'string' ? plain.trim() : '';
            return token || null;
        } catch (err) {
            return null;
        }
    }

    const setMineruToken = (token) => enqueue(async () => {
        const value = typeof token === 'string' ? token.trim() : '';
        if (token !== null && token !== undefined && typeof token !== 'string') throw new Error('令牌须为字符串或 null');
        if (value.length > MAX_TOKEN_LENGTH) throw new Error(`令牌过长（上限 ${MAX_TOKEN_LENGTH} 字符）`);
        const secrets = { ...readSecrets() };
        if (!value) {
            delete secrets[SECRET_KEY];
            await writeJsonAtomic(secretsPath, secrets, SECRETS_MODE);
            return false;
        }
        if (!safeStorage.isEncryptionAvailable()) {
            throw new Error('当前系统无法安全加密令牌（safeStorage 不可用），已拒绝保存；请在系统钥匙串可用的环境中重试');
        }
        secrets[SECRET_KEY] = safeStorage.encryptString(value).toString('base64');
        await writeJsonAtomic(secretsPath, secrets, SECRETS_MODE);
        return true;
    });

    function describe() {
        return {
            settings: get(),
            mineruTokenConfigured: hasMineruToken(),
            encryptionAvailable: safeEncryptionAvailable(),
            paths: { dir: baseDir, settingsPath, secretsPath },
            warnings: [...state.warnings],
        };
    }

    function safeEncryptionAvailable() {
        try {
            return Boolean(safeStorage.isEncryptionAvailable());
        } catch (err) {
            return false;
        }
    }

    return {
        load, get, set, hasMineruToken, getMineruToken, setMineruToken, describe,
        warnings: () => [...state.warnings],
        paths: { dir: baseDir, settingsPath, secretsPath },
    };
}

/** 输入类型 → settings.defaultTargets 的键（office / markup / url） */
const targetClassOf = (inputType) => INPUT_CLASS[inputType] || null;

module.exports = {
    createSettingsStore, buildDefaultSettings, targetClassOf,
    SettingsSchema, SettingsPatchSchema, DefaultsPatchSchema,
    THEMES, LIBRARY_MODES, SETTINGS_VERSION, SETTINGS_FILENAME, SECRETS_FILENAME,
};
