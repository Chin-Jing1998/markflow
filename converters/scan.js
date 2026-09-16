/**
 * 输入路径展开（纯逻辑，不依赖 Electron）
 *
 * 桌面端（desktop/main/scan.js 转引本模块）与 CLI / MCP 共用同一套目录遍历规则。
 *
 * scanPaths(paths, opts)   → Promise<{ files: Entry[], unsupported: string[], truncated: boolean }>
 * expandPaths(paths, opts) → Promise<Entry[]>（scanPaths().files 的简写）
 *   Entry = { path, name, ext, type, size }，path 为绝对路径，type 取 converters/targets.detectInputType 的结果
 *   opts = { exts?: string[], maxDepth?: number, maxFiles?: number }
 * expandInputs(raws, opts) → Promise<{ inputs: Array, directories: [{ path, count }], skipped: string[], truncated: boolean }>
 *   CLI / MCP 的目录输入展开；opts = { cwd?: string, maxDepth?: number, maxFiles?: number }
 *
 * scanPaths 规则（桌面端「添加文件 / 文件夹」与文件库浏览）：
 *   - 入参逐项 path.resolve；不存在的路径忽略。直接给出的文件不受隐藏项规则约束，但仍须命中扩展名白名单
 *     （默认 SUPPORTED_EXTENSIONS），未命中的记入 unsupported，供界面提示「已忽略 N 个不支持的文件」。
 *   - 目录递归收集：跳过点开头的隐藏项（文件与目录）、node_modules 与 .git；深度上限 maxDepth（默认 8）；
 *     目录内的符号链接按其目标类型处理，目录以 realpath 去环。
 *   - 结果按绝对路径去重（同一文件多次给出，或既给文件又给其父目录，只出现一次），按路径码点顺序稳定排序。
 *   - 总数上限 maxFiles（默认 2000）：目录遍历按名称排序进行，命中上限即停止并置 truncated。
 *
 * expandInputs 规则（目录遍历沿用 scanPaths；入参不含目录时 inputs 与入参逐项相同，既有调用行为不变）：
 *   - 逐项判定：字符串经 trim、targets.resolveUserPath（~、file://）与 path.resolve(cwd，缺省 process.cwd())
 *     后为已存在的目录才展开；网址、文件、不存在的路径、无法转换的 file:// 地址与非字符串值一律原样留在原位，
 *     交由 planTasks 按原有规则归类或报错。
 *   - 目录项就地替换为其下转档受支持文件（SUPPORTED_EXTENSIONS）的绝对路径，同一目录内按路径码点序。
 *   - 去重：同一真实目录只遍历一次（重复给出或嵌套给出时，后者展开为空）；目录内命中的文件若已作为显式输入
 *     给出则不再展开。显式输入本身从不去重、从不删除。
 *   - maxFiles 限定全部目录展开所得文件的总数（显式输入不计），命中上限即停止遍历并置 truncated。
 *   - directories：每个目录项一条 { path: 绝对路径, count: 该项展开所得文件数 }，按给出顺序。
 *   - skipped：目录内因扩展名不受支持而跳过的文件（绝对路径，码点序，至多 maxFiles 项）；隐藏项与
 *     node_modules、.git 内的文件不计，显式给出的文件不计。
 *   - 产物布局与桌面端文件夹转换一致：展开所得文件各自转换到同一输出目录，产物平铺为 {outputDir}/{name}…，
 *     不保留源目录的子目录结构。
 */
const path = require('path');
const fsp = require('fs').promises;

const { SUPPORTED_EXTENSIONS, REMOTE_URL_RE, detectInputType, resolveUserPath } = require('./targets');

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
        } else if (kind === 'file') {
            await collectFile(full, entry.name, ctx);
        }
    }
}

// 命中扩展名白名单的收入 found；未命中的仅在 ctx.skipped 存在时（expandInputs）记为跳过项，scanPaths 不记
async function collectFile(full, name, ctx) {
    if (ctx.exts.has(path.extname(name).toLowerCase())) {
        const stat = await statOrNull(full);
        if (stat) ctx.found.set(full, toEntry(full, stat));
    } else if (ctx.skipped && ctx.skipped.length < ctx.limits.maxFiles) {
        ctx.skipped.push(full);
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

async function expandInputs(raws, opts = {}) {
    const options = opts || {};
    const cwd = typeof options.cwd === 'string' && options.cwd ? options.cwd : process.cwd();
    const items = await Promise.all((Array.isArray(raws) ? raws : []).map((raw) => classifyRaw(raw, cwd)));
    // 显式给出的本地文件：目录展开时不再重复收入，也不计入 skipped
    const explicit = new Set(items.filter((item) => item.kind === 'file').map((item) => item.abs));
    const ctx = {
        exts: new Set(SUPPORTED_EXTENSIONS),
        limits: normalizeLimits(options),
        found: new Map(),
        seenDirs: new Set(),
        truncated: false,
        skipped: [],
    };
    const inputs = [];
    const directories = [];
    for (const item of items) {
        if (item.kind !== 'dir') {
            inputs.push(item.raw);
            continue;
        }
        const before = ctx.found.size;
        await walk(item.abs, 0, ctx);
        // found 按插入顺序保存，本次遍历新收入的即第 before 项之后的部分
        const added = [...ctx.found.keys()].slice(before).filter((file) => !explicit.has(file)).sort(compareText);
        inputs.push(...added);
        directories.push({ path: item.abs, count: added.length });
    }
    return {
        inputs,
        directories,
        skipped: ctx.skipped.filter((file) => !explicit.has(file)).sort(compareText),
        truncated: ctx.truncated,
    };
}

// 单项判定：已存在的目录为 dir，已存在的文件为 file（供去重），其余为 other；均保留原始值 raw
async function classifyRaw(raw, cwd) {
    if (typeof raw !== 'string') return { raw, kind: 'other' };
    const value = raw.trim();
    if (!value || REMOTE_URL_RE.test(value)) return { raw, kind: 'other' };
    let abs;
    try {
        abs = path.resolve(cwd, resolveUserPath(value));
    } catch (err) {
        // 无法转换的 file:// 地址原样交还调用方，由 planTasks 按同一规则抛出中文错误
        return { raw, kind: 'other' };
    }
    const stat = await statOrNull(abs);
    if (stat && stat.isDirectory()) return { raw, kind: 'dir', abs };
    return { raw, kind: stat && stat.isFile() ? 'file' : 'other', abs };
}

module.exports = { scanPaths, expandPaths, expandInputs, normalizeExts, DEFAULT_MAX_DEPTH, DEFAULT_MAX_FILES };
