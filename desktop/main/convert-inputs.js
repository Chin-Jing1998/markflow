/**
 * 转档入口的输入展开与专利五书目录判定（纯逻辑，不依赖 Electron）
 *
 * 目录遍历规则仍由 converters/scan.js 定义（桌面端与 CLI / MCP 共用），本模块只补两条转档入口独有的规则：
 *   - 显式给出的 .xml 与 .zip 受理为一项输入（converters/targets.EXPLICIT_ONLY_EXTENSIONS）。它们不随目录展开，
 *     故 scanPaths 会把直接给出的这两类文件记入 unsupported，此处先行截下，不让它们落到「不支持的文件」里；
 *   - 显式给出的目录若命中专利五书目录签名（converters/scan.isPatentBundleDir），整个目录作为一项输入、不再展开。
 *     签名判定要读盘，故一律在主进程侧做：渲染进程从不触碰文件系统。
 *
 * expandConvertPaths(paths, { scanPaths?, maxFiles? }) → Promise<{ files, unsupported, truncated }>
 *   供 IPC 通道 mf:paths:expand 的转档作用域使用。files 的元素形状同 converters/scan.scanPaths 的 Entry
 *   （{ path, name, ext, type, size }），另带 kind：
 *     'file'   普通文件，含显式给出的 .xml 与 .zip；
 *     'bundle' 专利五书目录，type 为 BUNDLE_DIR_TYPE（'xml'）、ext 为空串、size 为 0。
 *   结果按绝对路径去重并按码点序排列，unsupported 与 truncated 沿用 scanPaths 的语义。
 *   scanPaths 可注入（ipc.js 传入注入给它的 scan 模块），缺省取 converters/scan 的实现。
 *
 * resolveBundleInputs(raws, cwd?) → Promise<{ bundles, isBundle }>
 *   转换批次开跑前判定本批里哪些输入是五书目录：bundles 为其绝对路径数组，原样交 service.planTasks 的
 *   hints.bundles；isBundle(raw) 按调用方给出的原始写法回答，供调用方决定该项的输入类型。
 *   路径归一与 converters/targets.classifyInput 同法（resolveUserPath 后按 cwd 解析），两侧判定因此一致。
 *   每项至多一次 stat，只有目录才继续做签名判定（其自身有界：至多 5 次 stat、一次 readdir 与 16 次读文首）。
 */
const path = require('path');

const { scanPaths: defaultScanPaths, isPatentBundleDir } = require('../../converters/scan');
const { EXPLICIT_ONLY_EXTENSIONS, BUNDLE_DIR_TYPE, detectInputType, resolveUserPath } = require('../../converters/targets');
const { statOrNull } = require('../../converters/util');

/** files 元素的 kind：普通文件 / 专利五书目录 */
const FILE_KIND = 'file';
const PATENT_BUNDLE_KIND = 'bundle';
/** 合并后的总数上限，与 converters/scan.js 的 DEFAULT_MAX_FILES 取同一值 */
const MAX_FILES = 2000;

const EXPLICIT_ONLY = new Set(EXPLICIT_ONLY_EXTENSIONS);
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const isNonEmpty = (value) => typeof value === 'string' && value.trim() !== '';

const bundleEntry = (abs) => ({
    path: abs, name: path.basename(abs), ext: '', type: BUNDLE_DIR_TYPE, size: 0, kind: PATENT_BUNDLE_KIND,
});

const explicitEntry = (abs, size) => ({
    path: abs, name: path.basename(abs), ext: path.extname(abs).toLowerCase(), type: detectInputType(abs), size, kind: FILE_KIND,
});

/**
 * 单项判定：'bundle' 五书目录 / 'explicit' 显式给出的 .xml 或 .zip / 'scan' 其余（原样交 scanPaths 照旧处理）。
 * 路径解析与 scanPaths 一致（直接 path.resolve），使两条分支对同一入参得到同一绝对路径。
 */
async function classifyConvertPath(raw) {
    const abs = path.resolve(raw);
    const stat = await statOrNull(abs);
    if (!stat) return { raw, abs, kind: 'scan' };
    if (stat.isDirectory()) return { raw, abs, kind: (await isPatentBundleDir(abs)) ? 'bundle' : 'scan' };
    if (stat.isFile() && EXPLICIT_ONLY.has(path.extname(abs).toLowerCase())) return { raw, abs, kind: 'explicit', size: stat.size };
    return { raw, abs, kind: 'scan' };
}

async function expandConvertPaths(paths, { scanPaths = defaultScanPaths, maxFiles = MAX_FILES } = {}) {
    const list = (Array.isArray(paths) ? paths : []).filter(isNonEmpty);
    const marked = await Promise.all(list.map((raw) => classifyConvertPath(raw)));
    const scanned = await scanPaths(marked.filter((item) => item.kind === 'scan').map((item) => item.raw));
    // 显式项后写入：同一路径既被目录展开收入又被显式给出时，以显式项的 kind 为准
    const merged = new Map((scanned.files || []).map((entry) => [entry.path, { ...entry, kind: FILE_KIND }]));
    for (const item of marked) {
        if (item.kind === 'bundle') merged.set(item.abs, bundleEntry(item.abs));
        else if (item.kind === 'explicit') merged.set(item.abs, explicitEntry(item.abs, item.size));
    }
    const files = [...merged.values()].sort(byPath);
    return {
        files: files.slice(0, maxFiles),
        unsupported: scanned.unsupported || [],
        truncated: Boolean(scanned.truncated) || files.length > maxFiles,
    };
}

/** 归一为绝对路径；无法转换的 file:// 地址回 null，由调用方按「不是五书目录」处理 */
function toAbsolute(raw, cwd) {
    try {
        return path.resolve(cwd, resolveUserPath(raw.trim()));
    } catch (err) {
        return null;
    }
}

async function resolveBundleInputs(raws, cwd = process.cwd()) {
    const list = (Array.isArray(raws) ? raws : []).filter(isNonEmpty);
    const hits = await Promise.all(list.map(async (raw) => {
        const abs = toAbsolute(raw, cwd);
        if (!abs) return null;
        const stat = await statOrNull(abs);
        return stat && stat.isDirectory() && (await isPatentBundleDir(abs)) ? { raw: raw.trim(), abs } : null;
    }));
    const found = hits.filter(Boolean);
    const rawHits = new Set(found.map((item) => item.raw));
    return {
        bundles: [...new Set(found.map((item) => item.abs))],
        isBundle: (value) => typeof value === 'string' && rawHits.has(value.trim()),
    };
}

module.exports = { expandConvertPaths, resolveBundleInputs, FILE_KIND, PATENT_BUNDLE_KIND, MAX_FILES };
