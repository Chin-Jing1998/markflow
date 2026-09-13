/**
 * 路径展开（纯逻辑，不依赖 Electron）
 *
 * scanPaths(paths, opts)   → Promise<{ files: Entry[], unsupported: string[], truncated: boolean }>
 * expandPaths(paths, opts) → Promise<Entry[]>（scanPaths().files 的简写）
 *   Entry = { path, name, ext, type, size }，path 为绝对路径，type 取 converters/targets.detectInputType 的结果
 *   opts = { exts?: string[], maxDepth?: number, maxFiles?: number }
 *
 * 规则：
 *   - 入参逐项 path.resolve；不存在的路径忽略。直接给出的文件不受隐藏项规则约束，但仍须命中扩展名白名单
 *     （默认 SUPPORTED_EXTENSIONS），未命中的记入 unsupported，供界面提示「已忽略 N 个不支持的文件」。
 *   - 目录递归收集：跳过点开头的隐藏项（文件与目录）、node_modules 与 .git；深度上限 maxDepth（默认 8）；
 *     目录内的符号链接按其目标类型处理，目录以 realpath 去环。
 *   - 结果按绝对路径去重（同一文件多次给出，或既给文件又给其父目录，只出现一次），按路径码点顺序稳定排序。
 *   - 总数上限 maxFiles（默认 2000）：目录遍历按名称排序进行，命中上限即停止并置 truncated。
 */
const path = require('path');
const fsp = require('fs').promises;

const { SUPPORTED_EXTENSIONS, detectInputType } = require('../../converters/targets');

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FILES = 2000;
const MAX_INPUT_PATHS = 2000;
const SKIP_DIR_NAMES = new Set(['node_modules', '.git']);

const isHidden = (name) => name.startsWith('.');
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byPath = (a, b) => compareText(a.path, b.path);

async function statOrNull(target) {
    try {
        return await fsp.stat(target);
    } catch (err) {
        return null;
    }
}

/** 扩展名过滤集：缺省或全为非法项时回退到 SUPPORTED_EXTENSIONS；元素可带或不带前导点 */
function normalizeExts(exts) {
    const list = Array.isArray(exts)
        ? exts.filter((item) => typeof item === 'string' && item.trim()).map((item) => (item.startsWith('.') ? item : `.${item}`).toLowerCase())
        : [];
    return new Set(list.length > 0 ? list : SUPPORTED_EXTENSIONS);
}

function normalizeLimits({ maxDepth, maxFiles } = {}) {
    return {
        maxDepth: Number.isInteger(maxDepth) && maxDepth >= 0 ? maxDepth : DEFAULT_MAX_DEPTH,
        maxFiles: Number.isInteger(maxFiles) && maxFiles > 0 ? maxFiles : DEFAULT_MAX_FILES,
    };
}

const toEntry = (abs, stat) => ({
    path: abs,
    name: path.basename(abs),
    ext: path.extname(abs).toLowerCase(),
    type: detectInputType(abs),
    size: stat.size,
});

/** Dirent 已给出结论就直接采用，符号链接等未知项再 stat 解析目标 */
async function entryKind(entry, full) {
    if (entry.isDirectory()) return 'dir';
    if (entry.isFile()) return 'file';
    const stat = await statOrNull(full);
    if (!stat) return 'other';
    if (stat.isDirectory()) return 'dir';
    return stat.isFile() ? 'file' : 'other';
}

async function walk(dir, depth, ctx) {
    if (depth > ctx.limits.maxDepth) return;
    const real = await fsp.realpath(dir).catch(() => dir);
    if (ctx.seenDirs.has(real)) return;
    ctx.seenDirs.add(real);

    let entries;
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
        return;
    }
    entries.sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
        if (ctx.found.size >= ctx.limits.maxFiles) {
            ctx.truncated = true;
            return;
        }
        if (isHidden(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const kind = await entryKind(entry, full);
        if (kind === 'dir') {
            if (SKIP_DIR_NAMES.has(entry.name)) continue;
            await walk(full, depth + 1, ctx);
        } else if (kind === 'file' && ctx.exts.has(path.extname(entry.name).toLowerCase())) {
            const stat = await statOrNull(full);
            if (stat) ctx.found.set(full, toEntry(full, stat));
        }
    }
}

async function scanPaths(paths, opts = {}) {
    const ctx = {
        exts: normalizeExts(opts && opts.exts),
        limits: normalizeLimits(opts || {}),
        found: new Map(),
        seenDirs: new Set(),
        truncated: false,
    };
    const unsupported = [];
    const inputs = (Array.isArray(paths) ? paths : []).slice(0, MAX_INPUT_PATHS);
    for (const raw of inputs) {
        if (typeof raw !== 'string' || raw.trim() === '') continue;
        const abs = path.resolve(raw);
        const stat = await statOrNull(abs);
        if (!stat) continue;
        if (stat.isFile()) {
            if (ctx.exts.has(path.extname(abs).toLowerCase())) ctx.found.set(abs, toEntry(abs, stat));
            else unsupported.push(abs);
        } else if (stat.isDirectory()) {
            await walk(abs, 0, ctx);
        }
    }
    const sorted = [...ctx.found.values()].sort(byPath);
    return {
        files: sorted.slice(0, ctx.limits.maxFiles),
        unsupported,
        truncated: ctx.truncated || sorted.length > ctx.limits.maxFiles,
    };
}

async function expandPaths(paths, opts = {}) {
    return (await scanPaths(paths, opts)).files;
}

module.exports = { scanPaths, expandPaths, normalizeExts, DEFAULT_MAX_DEPTH, DEFAULT_MAX_FILES };
