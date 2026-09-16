/**
 * 产物落盘
 *
 * writeFolder({ outputDir, name, files, assets, extras, clean })
 *   → { outputPath, outputs }
 *   目录 {outputDir}/{name}/。files 为 { '<posix 相对路径>': string | Buffer }（字符串按 utf8 写入），
 *   键中的 {name} 占位符（NAME_TOKEN）替换为产物名；assets 按 assets[].name 写入（形如 images/image_1.png，
 *   仅当某个资产名以 images/ 开头才创建 images/ 并报告 imagesDir；裸文件名的资产平铺在目录根下）；
 *   extras 为 [{ name, buffer }] 的附属文件（sidecar），name 中的 {name} 同样替换为产物名后写入。
 *   outputs 的键（方案 §3.3.3）：主产物（键为 {name}.<ext>）取 ext（md / json / html / xml / zip）；
 *   以 {name}_ 开头的文件（files 或根目录 extras）取 {name}_ 之后主干的 camelCase，非 json 再接上扩展名
 *   （{name}_content_list.json → contentList，{name}_content_list_v2.json → contentListV2，
 *   {name}_origin.pdf → originPdf）；其余文件取去扩展名的文件名并转 camelCase（claims.xml → claims，
 *   abstract-figure.xml → abstractFigure）；写入了 images/ 则有 imagesDir；extras 的每个顶层目录记为
 *   <目录名>Dir（mineru/full.md → mineruDir）；根目录下不以 {name}_ 开头的 extras 不进 outputs。
 *   clean 为 true 时，全部路径与内容校验通过之后、写入之前，先清理产物目录中 MarkFlow 会生成的旧文件（范围见下）；
 *   缺省不清理。
 * writeBundle({ outputDir, name, md, json, assets })
 *   → { dir, mdPath, jsonPath, imagesDir | null }，writeFolder 的薄封装，保留 v2 返回形状
 * writeSingle({ outputDir, name, ext, buffer })
 *   → 绝对路径 {outputDir}/{name}.{ext}
 *
 * 三者的相对路径均限定在目标目录之内：拒绝绝对路径、Windows 盘符与 ".." 穿越；
 * 全部路径与内容先校验再统一写盘，避免半途失败留下部分产物。
 * 均覆盖写、全部使用 fs.promises；除 writeFolder 的 clean 之外不删除任何既有文件。
 *
 * clean 的清理范围只限产物目录 {outputDir}/{name}/ 本层（名称区分大小写，{name} 为产物名）：
 *   目录 images/（整体删除；为符号链接时只删链接本身，不触及链接目标）；
 *   文件 {name}.md、{name}.json、{name}.html、{name}.xml、{name}.zip、{name}_content_list*.json、{name}_model.json、
 *   {name}_layout.json、{name}_origin.pdf，专利五书 claims.xml、description.xml、drawings.xml、abstract.xml、
 *   abstract-figure.xml 与 precheck.json，patent profile 平铺在根下的图片 drawing-N、table-N、omath-N-N、image_N
 *   （可带 -K 冲突后缀）。与上述文件同名的子目录、其余文件与子目录（用户放入的笔记等）一律保留，
 *   产物目录之外的任何文件都不触碰；产物目录不存在时不做任何事；产物目录本身是符号链接时拒绝清理并抛中文错误，
 *   以免删到链接目标中的文件。
 */
const path = require('path');
const fsp = require('fs').promises;
const { ensureDir } = require('./ir/util');
const { toBuffer } = require('./util');

const IMAGES_DIRNAME = 'images';
const NAME_TOKEN = '{name}';
// 旁路文件（MinerU 式产物包的 {name}_content_list.json 等）的命名前缀
const SIDECAR_PREFIX = `${NAME_TOKEN}_`;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;
// clean 按原名删除的产物文件（{name} 为产物名占位符）
const CLEAN_FILES = Object.freeze([
    `${NAME_TOKEN}.md`, `${NAME_TOKEN}.json`, `${NAME_TOKEN}.html`, `${NAME_TOKEN}.xml`, `${NAME_TOKEN}.zip`,
    `${NAME_TOKEN}_model.json`, `${NAME_TOKEN}_layout.json`, `${NAME_TOKEN}_origin.pdf`,
    'claims.xml', 'description.xml', 'drawings.xml', 'abstract.xml', 'abstract-figure.xml', 'precheck.json',
]);
// clean 按前缀删除的旁路 JSON：{name}_content_list.json、{name}_content_list_v2.json 等
const CLEAN_CONTENT_LIST_PREFIX = `${NAME_TOKEN}_content_list`;
// patent profile 平铺在产物目录根下的图片：附图 drawing-N、栅格化的 table-N 与 omath-段-序、段内图片 image_N，冲突时带 -K
const PATENT_FLAT_IMAGE_RE = /^(?:drawing-\d+|table-\d+|omath-\d+-\d+|image_\d+)(?:-\d+)?\.[A-Za-z0-9]+$/;

async function writeFolder({ outputDir, name, files, assets = [], extras = [], clean = false } = {}) {
    const baseDir = resolveOutputDir(outputDir);
    assertName(name);
    const dir = path.join(baseDir, name);

    const fileJobs = planFiles(dir, name, files);
    const assetJobs = planEntries(dir, assets, '资源');
    const extraJobs = planEntries(dir, extras, '附属文件', name);
    assertNoDuplicateTargets([...fileJobs, ...assetJobs, ...extraJobs]);
    const outputs = buildOutputs(dir, { fileJobs, assetJobs, extraJobs });

    if (clean === true) await cleanFolder(dir, name);
    await ensureDir(dir);
    if (hasImagesDir(assetJobs)) await ensureDir(path.join(dir, IMAGES_DIRNAME));
    await writeJobs([...fileJobs, ...assetJobs, ...extraJobs]);
    return { outputPath: dir, outputs };
}

// 只有资产名以 images/ 开头才涉及 images/ 目录；裸文件名的资产（patent profile 平铺的图片）直接落在目录根下
const hasImagesDir = (assetJobs) => assetJobs.some((job) => job.rel.startsWith(`${IMAGES_DIRNAME}/`));

async function writeBundle({ outputDir, name, md, json, assets = [] } = {}) {
    resolveOutputDir(outputDir);
    assertName(name);
    if (typeof md !== 'string') throw new Error('writeBundle 需要字符串形式的 md');
    if (typeof json !== 'string') throw new Error('writeBundle 需要字符串形式的 json');
    const { outputPath, outputs } = await writeFolder({
        outputDir, name, assets,
        files: { [`${NAME_TOKEN}.md`]: md, [`${NAME_TOKEN}.json`]: json },
    });
    return { dir: outputPath, mdPath: outputs.md, jsonPath: outputs.json, imagesDir: outputs.imagesDir || null };
}

async function writeSingle({ outputDir, name, ext, buffer } = {}) {
    const baseDir = resolveOutputDir(outputDir);
    assertName(name);
    const cleanExt = String(ext == null ? '' : ext).trim().replace(/^\.+/, '');
    if (!cleanExt) throw new Error('writeSingle 需要扩展名 ext');
    const body = toBuffer(buffer);
    if (!body) throw new Error('writeSingle 需要 Buffer 内容');

    await ensureDir(baseDir);
    const target = path.join(baseDir, `${name}.${cleanExt}`);
    await fsp.writeFile(target, body);
    return target;
}

// ============================================================
// 写盘计划
// ============================================================

// files → [{ key, rel, target, buffer }]；key 为替换占位符前的原键，供 outputs 取键名
function planFiles(dir, name, files) {
    if (!isPlainObject(files) || Object.keys(files).length === 0) throw new Error('writeFolder 需要非空的 files 对象');
    return Object.entries(files).map(([key, content]) => {
        const rel = key.split(NAME_TOKEN).join(name);
        const target = resolveInsidePath(dir, rel, '产物');
        const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : toBuffer(content);
        if (!buffer) throw new Error(`产物 ${key} 的内容须为字符串或 Buffer`);
        return { key, rel: normalizeSlashes(rel), target, buffer };
    });
}

// assets / extras → [{ key, rel, target, buffer }]；给出 name 时把名字中的 {name} 占位符替换为产物名，
// key 为替换前的原名（供 outputs 取键）
function planEntries(dir, list, label, name) {
    const entries = Array.isArray(list) ? list : [];
    return entries.map((entry) => {
        const raw = entry && entry.name;
        const rel = typeof raw === 'string' && name ? raw.split(NAME_TOKEN).join(name) : raw;
        const target = resolveInsidePath(dir, rel, label);
        const buffer = toBuffer(entry && entry.buffer);
        if (!buffer) throw new Error(`${label} ${raw} 缺少 Buffer 内容`);
        return { key: raw.trim(), rel: normalizeSlashes(rel.trim()), target, buffer };
    });
}

function assertNoDuplicateTargets(jobs) {
    const seen = new Set();
    for (const job of jobs) {
        if (seen.has(job.target)) throw new Error(`产物路径重复：${job.rel}`);
        seen.add(job.target);
    }
}

async function writeJobs(jobs) {
    await Promise.all(jobs.map(async ({ target, buffer }) => {
        await ensureDir(path.dirname(target));
        await fsp.writeFile(target, buffer);
    }));
}

// ============================================================
// clean：重跑前清理旧产物（范围见文件头）
// ============================================================

async function cleanFolder(dir, name) {
    const stat = await lstatOrNull(dir);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`清理中止：产物目录是符号链接，为免误删链接目标中的文件，未做任何清理：${dir}`);
    if (!stat.isDirectory()) return;
    const exactNames = new Set(CLEAN_FILES.map((file) => file.split(NAME_TOKEN).join(name)));
    const contentListPrefix = CLEAN_CONTENT_LIST_PREFIX.split(NAME_TOKEN).join(name);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const doomed = entries.filter((entry) => isCleanTarget(entry, exactNames, contentListPrefix));
    // images 为目录时整体删除；为符号链接时 fs.rm 只删链接本身（按 lstat 判定，不跟随链接）
    await Promise.all(doomed.map((entry) => fsp.rm(path.join(dir, entry.name), { recursive: entry.name === IMAGES_DIRNAME, force: true })));
}

// Dirent 按 lstat 语义给出类型：images 须为目录或符号链接，其余须为文件或符号链接，同名的子目录一律保留
function isCleanTarget(entry, exactNames, contentListPrefix) {
    if (entry.name === IMAGES_DIRNAME) return entry.isDirectory() || entry.isSymbolicLink();
    if (!entry.isFile() && !entry.isSymbolicLink()) return false;
    return exactNames.has(entry.name)
        || (entry.name.startsWith(contentListPrefix) && entry.name.endsWith('.json'))
        || PATENT_FLAT_IMAGE_RE.test(entry.name);
}

// 路径不存在返回 null；其余错误（权限等）原样抛出，不做静默处理
async function lstatOrNull(target) {
    try {
        return await fsp.lstat(target);
    } catch (err) {
        if (err && err.code === 'ENOENT') return null;
        throw err;
    }
}

// ============================================================
// outputs 键
// ============================================================

function buildOutputs(dir, { fileJobs, assetJobs, extraJobs }) {
    const outputs = {};
    const put = (key, value) => {
        if (key in outputs && outputs[key] !== value) throw new Error(`产物键冲突：${key}`);
        outputs[key] = value;
    };
    for (const job of fileJobs) put(outputKeyFor(job.key), job.target);
    if (hasImagesDir(assetJobs)) put('imagesDir', path.join(dir, IMAGES_DIRNAME));
    for (const job of extraJobs) {
        if (!job.rel.includes('/') && job.key.startsWith(SIDECAR_PREFIX)) put(outputKeyFor(job.key), job.target);
    }
    for (const top of topLevelDirs(extraJobs)) put(`${camelCase(top)}Dir`, path.join(dir, top));
    return outputs;
}

// {name}.md → md；{name}_content_list.json → contentList；{name}_origin.pdf → originPdf；
// claims.xml → claims；abstract-figure.xml → abstractFigure
function outputKeyFor(key) {
    const base = path.posix.basename(normalizeSlashes(key));
    const ext = path.posix.extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    if (stem === NAME_TOKEN && ext) return ext.slice(1).toLowerCase();
    if (stem.startsWith(SIDECAR_PREFIX) && stem.length > SIDECAR_PREFIX.length) {
        const core = camelCase(stem.slice(SIDECAR_PREFIX.length));
        const suffix = ext && ext.toLowerCase() !== '.json' ? capitalize(ext.slice(1).toLowerCase()) : '';
        return core ? `${core}${suffix}` : 'file';
    }
    return camelCase(stem) || camelCase(base) || 'file';
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function topLevelDirs(jobs) {
    const dirs = new Set();
    for (const job of jobs) {
        const segments = job.rel.split('/').filter(Boolean);
        if (segments.length > 1) dirs.add(segments[0]);
    }
    return [...dirs];
}

function camelCase(text) {
    const parts = String(text || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return parts
        .map((part, index) => (index === 0 ? part.charAt(0).toLowerCase() : part.charAt(0).toUpperCase()) + part.slice(1))
        .join('');
}

// ============================================================
// 路径校验
// ============================================================

// 相对路径限定为 dir 内：拒绝空值、绝对路径、Windows 盘符、".." 穿越与越出 dir 的解析结果
function resolveInsidePath(dir, rawName, label) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) throw new Error(`${label}缺少 name`);
    if (name.includes('\0')) throw new Error(`${label}名含非法字符：${rawName}`);
    const normalized = normalizeSlashes(name);
    if (path.isAbsolute(normalized) || WINDOWS_DRIVE_RE.test(normalized)) throw new Error(`${label}名不得为绝对路径：${name}`);
    if (normalized.split('/').includes('..')) throw new Error(`${label}名不得包含 ".."：${name}`);
    const target = path.resolve(dir, normalized);
    const relative = path.relative(dir, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label}名越出输出目录：${name}`);
    return target;
}

const normalizeSlashes = (value) => String(value).replace(/\\/g, '/');

// 与 bin/markflow.js 的 resolveCliOutputDir 分工不同：这里只做路径解析，不校验存在性、不读环境变量
function resolveOutputDir(outputDir) {
    if (typeof outputDir !== 'string' || !outputDir.trim()) throw new Error('缺少输出目录 outputDir');
    return path.resolve(outputDir);
}

function assertName(name) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('缺少产物名 name');
    if (/[\\/]/.test(name) || name === '.' || name === '..') throw new Error(`产物名不得包含路径分隔符：${name}`);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

module.exports = { writeFolder, writeBundle, writeSingle, outputKeyFor, NAME_TOKEN };
