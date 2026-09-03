/**
 * 临时目录设施（全仓唯一一份）
 *
 * 三处消费者：md 图片内嵌（进程私有目录，长期驻留至退出）、PDF 后端（单次转换的短命目录）、
 * LibreOffice profile（同前）。统一在此提供创建、退出清理与残留回收。
 *
 * 残留回收一律用 lstat 而非 stat：同名符号链接不会被当作目录参与判断。
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

// 上次运行的残留目录超过此时长即回收
const STALE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// stderr 摘要默认长度上限
const EXCERPT_LIMIT = 500;
/** POSIX 风格绝对路径（连续的 /段）；用于把 stderr 摘要中的本机路径脱敏为 <path> */
const ABSOLUTE_PATH_RE = /(?:\/[^\s/]+)+/g;

const noop = () => undefined;

/** 建一次性临时目录（权限由 mkdtemp 保证为 0700，路径不可预测） */
const makeTempDir = (prefix) => fsp.mkdtemp(path.join(os.tmpdir(), prefix));

/** 删除目录，失败静默 */
const removeTempDir = (dir) => fsp.rm(dir, { recursive: true, force: true }).catch(noop);

/**
 * 建进程私有临时目录并登记退出时清理，返回缓存的 promise 以免重复创建。
 * 创建失败不缓存失败态，允许下次重试；调用方仍从原 promise 收到错误。
 * @returns {() => Promise<string>} 幂等的取目录函数
 */
function createTempDirFactory(prefix) {
    let pending = null;
    return () => {
        if (!pending) {
            pending = makeTempDir(prefix).then((dir) => {
                process.once('exit', () => {
                    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* 退出阶段静默 */ }
                });
                return dir;
            });
            pending.catch(() => { pending = null; });
        }
        return pending;
    };
}

/**
 * 回收 os.tmpdir() 下修改时间超过 maxAgeMs 的 matchPrefix* 目录（上次异常退出的残留）。
 * matchPrefix 可比创建前缀更宽，以便一并回收历史命名。
 * @returns {Promise<number>} 删除的目录数
 */
async function cleanupStaleTempDirs({ matchPrefix, maxAgeMs = STALE_TEMP_MAX_AGE_MS, now = Date.now() } = {}) {
    if (typeof matchPrefix !== 'string' || !matchPrefix) throw new Error('cleanupStaleTempDirs 需要 matchPrefix');
    const base = os.tmpdir();
    const names = await fsp.readdir(base).catch(() => []);
    let removed = 0;
    for (const name of names) {
        if (!name.startsWith(matchPrefix)) continue;
        const full = path.join(base, name);
        const stat = await fsp.lstat(full).catch(() => null);
        if (!stat || !stat.isDirectory() || now - stat.mtimeMs < maxAgeMs) continue;
        try {
            await fsp.rm(full, { recursive: true, force: true });
            removed += 1;
        } catch (err) {
            // 单个目录清理失败不影响其余
        }
    }
    return removed;
}

/**
 * 子进程 stderr 的用户可见摘要。
 * firstLineOnly：首行之后通常是调用栈，既无助于排障，又会把本机目录结构暴露到日志中。
 * redactPaths：把绝对路径脱敏为 <path>，用于会带出项目路径的 Electron 工作进程。
 */
function excerpt(text, { limit = EXCERPT_LIMIT, firstLineOnly = false, redactPaths = false } = {}) {
    const trimmed = String(text || '').trim();
    const picked = firstLineOnly ? (trimmed.split(/\r?\n/)[0] || '') : trimmed;
    const redacted = redactPaths ? picked.replace(ABSOLUTE_PATH_RE, '<path>') : picked;
    return redacted.slice(0, limit);
}

module.exports = {
    makeTempDir, removeTempDir, createTempDirFactory, cleanupStaleTempDirs, excerpt,
    STALE_TEMP_MAX_AGE_MS,
};
