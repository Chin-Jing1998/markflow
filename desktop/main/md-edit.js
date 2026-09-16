/**
 * Markdown 编辑的主进程侧设施（纯 Node，不依赖 Electron；reader 与 preview-session 共用）
 *
 *   renderMarkdownText({ text, baseDir, sourceName, assetDir, assetBase, theme?, options?, core? })
 *       → { html, warnings, doc }   未保存的文本 → parsers/md → 资产写 assetDir → html（图片经 assetBase 取用）
 *   writeFileAtomic(target, data) → 实际写入的绝对路径
 *       先 realpath 解开符号链接；同目录 `.<base>.<pid>.<rand>.mftmp` 以 wx 打开、写入、fsync、rename；
 *       保留原文件 mode；任一步失败删除临时文件。
 *   saveMarkdownFile({ filePath, text, base, force?, core?, log? })
 *       → { saved:false, conflict:true, missing } | { saved:true, conflict:false, base, mtimeMs, size, sidecars, warnings }
 *       磁盘 mtimeMs / size 与 base 不符或文件已消失且未 force 时报冲突，不写盘；
 *       写盘成功后若同目录同名 json 可识别为 MarkFlow bundle，则按新文本重建旁路文件（失败只记 warning，不回滚 md）。
 *   findBundleJson(mdPath) → null | { jsonPath, contentListPath, hasContentList, name, meta }
 *       同名 .json 须解析后含 schemaVersion、ir、meta 三键才认作 bundle，否则一概不碰。
 *   buildBundleSidecars({ text, baseDir, sourceName, previousMeta, name, core? }) → null | { json, contentList }
 *       解析 md → 本地图片 url 还原为 posix 相对路径、其余登记过的图片（data URL 等）还原为 md 里的原样地址，
 *       并剥掉 data.asset（绝对路径与 buffer 不进 json）
 *       → meta 取 { ...previousMeta（去掉绝对路径）, title, editedAt } → 调转换内核契约 renderBundleSidecars。
 *       契约函数不存在时返回 null，由调用方记 warning。
 *   importImage({ sourcePath, docDir }) → { relPath, width, height, alt }
 *       扩展名白名单与 20 MB 上限；源文件已在 docDir 内直接引用，否则复制到 docDir/images/（不覆盖，重名依次加 -1、-2…）。
 *   referencedImages(text, dir) → [{ name: 'images/<rel>', absPath }]   dir/images/** 中被文本引用到的文件
 *
 * core（测试注入桩）：{ parseMarkdown?, renderDocument?, normalizeOptions?, renderBundleSidecars? }，
 * 缺省时懒加载 converters/parsers/md、converters/index、converters/options。
 * renderBundleSidecars 键若在 core 上显式给出（哪怕为 null）即以其为准，不再回落到 converters/index。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fsp = fs.promises;

const { errText, isWithinDir, statOrNull } = require('../../converters/util');
const { IMAGE_IMPORT_EXTENSIONS, MAX_IMAGE_IMPORT_BYTES, MAX_TEXT_BYTES } = require('./file-kinds');

const READER_THEME = 'reader';
const IMAGES_DIRNAME = 'images';
const TEMP_SUFFIX = '.mftmp';
const MAX_COPY_ATTEMPTS = 1000;
const MAX_FILE_STEM_LENGTH = 120;
const FILE_MODE_MASK = 0o7777;
const DEFAULT_FILE_MODE = 0o644;
/** 文件名清洗：Windows 保留字符、URL 与 Markdown 里有特殊含义的 # %、控制字符与空白一律换成下划线 */
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_RE = /[<>:"/\\|?*#%\x00-\x1F\x7F\s]+/g;
const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/;
/** 旁路文件里保留的图片节点 data 键：资产名与显示尺寸；绝对路径、buffer 一律不进 json */
const KEPT_IMAGE_DATA_KEYS = Object.freeze(['assetName', 'display']);

const noop = () => undefined;
const asArray = (value) => (Array.isArray(value) ? value : []);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
const toPosix = (value) => String(value).split(path.sep).join('/');

function loadMdCore(core) {
    return {
        parseMarkdown: (core && core.parseMarkdown) || ((input, ctx) => require('../../converters/parsers/md').parse(input, ctx)),
        renderDocument: (core && core.renderDocument) || ((doc, target, options, context) => require('../../converters/index').renderDocument(doc, target, options, context)),
        normalizeOptions: (core && core.normalizeOptions) || ((raw) => require('../../converters/options').normalizeOptions(raw)),
    };
}

/** 契约函数 renderBundleSidecars：core 上显式给出（含 null）即以其为准；否则取 converters/index 的导出，不存在返回 null */
function sidecarRendererOf(core) {
    if (core && Object.prototype.hasOwnProperty.call(core, 'renderBundleSidecars')) {
        return typeof core.renderBundleSidecars === 'function' ? core.renderBundleSidecars : null;
    }
    const fn = require('../../converters/index').renderBundleSidecars;
    return typeof fn === 'function' ? fn : null;
}

// ============================================================
// 资产落盘（reader 与 preview 共用）
// ============================================================

/**
 * 把 doc.assets / 渲染器 assets 写进目录，返回实际写入的资产名。
 * 资产名来自转换内核（images/image_1.jpg 或裸文件名），仍逐项做穿越校验，绝不写到目录之外。
 */
async function writeAssets(dir, assets = []) {
    const written = [];
    for (const asset of asArray(assets)) {
        if (!asset || typeof asset.name !== 'string' || !asset.buffer) continue;
        const rel = asset.name.split(/[\\/]/).filter((segment) => segment && segment !== '.').join(path.sep);
        if (!rel || rel.split(path.sep).includes('..')) continue;
        const abs = path.resolve(dir, rel);
        if (!isWithinDir(dir, abs)) continue;
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, asset.buffer);
        written.push(asset.name);
    }
    return written;
}

// ============================================================
// 渲染
// ============================================================

/** 未保存的 Markdown 文本 → html；图片先落 assetDir，再经 assetBase 取用 */
async function renderMarkdownText({ text, baseDir, sourceName, assetDir, assetBase, theme = READER_THEME, options = null, core = null } = {}) {
    const api = loadMdCore(core);
    const doc = await api.parseMarkdown({ text: String(text == null ? '' : text) }, { baseDir, sourceName });
    const raw = isPlainObject(options) ? { ...options, html: { ...(options.html || {}), theme } } : { html: { theme } };
    const normalized = api.normalizeOptions(raw);
    await writeAssets(assetDir, doc.assets);
    const rendered = await api.renderDocument(doc, 'html', normalized, { imageMode: { base: assetBase } });
    return {
        html: String(Object.values(rendered.files)[0] || ''),
        warnings: [...asArray(doc.warnings), ...asArray(rendered.warnings)],
        doc,
    };
}

// ============================================================
// 原子写入与保存
// ============================================================

async function resolveRealTarget(target) {
    const abs = path.resolve(String(target || ''));
    try {
        return await fsp.realpath(abs);
    } catch (err) {
        if (err && err.code === 'ENOENT') return abs;
        throw err;
    }
}

/** 同目录临时文件 + fsync + rename：写到一半崩溃也不会留下半截的原文件 */
async function writeFileAtomic(target, data) {
    const real = await resolveRealTarget(target);
    const dir = path.dirname(real);
    const previous = await statOrNull(real);
    if (previous && !previous.isFile()) throw new Error(`目标不是普通文件：${real}`);
    const mode = previous ? previous.mode & FILE_MODE_MASK : DEFAULT_FILE_MODE;
    const temp = path.join(dir, `.${path.basename(real)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}${TEMP_SUFFIX}`);
    let handle = null;
    try {
        handle = await fsp.open(temp, 'wx', mode);
        await handle.writeFile(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
        await handle.sync();
        await handle.close();
        handle = null;
        // open 的 mode 受 umask 影响，显式 chmod 才能与原文件一致
        if (previous) await fsp.chmod(temp, mode);
        await fsp.rename(temp, real);
    } catch (err) {
        if (handle) await handle.close().catch(noop);
        await fsp.rm(temp, { force: true }).catch(noop);
        throw err;
    }
    await syncDirectory(dir);
    return real;
}

/** rename 落到目录项上：尽力 fsync 目录（Windows 打不开目录句柄，失败忽略） */
async function syncDirectory(dir) {
    let handle = null;
    try {
        handle = await fsp.open(dir, 'r');
        await handle.sync();
    } catch (err) {
        /* 平台不支持目录 fsync 时忽略 */
    } finally {
        if (handle) await handle.close().catch(noop);
    }
}

const baseOf = (stat) => ({ mtimeMs: stat.mtimeMs, size: stat.size });

function assertTextSize(text) {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_TEXT_BYTES) {
        throw new Error(`文本过大（${(bytes / 1024 / 1024).toFixed(1)} MB），保存上限为 ${MAX_TEXT_BYTES / 1024 / 1024} MB`);
    }
}

async function saveMarkdownFile({ filePath, text, base = null, force = false, core = null, log = noop } = {}) {
    const body = String(text == null ? '' : text);
    assertTextSize(body);
    const target = path.resolve(String(filePath || ''));
    const stat = await statOrNull(target);
    if (stat && !stat.isFile()) throw new Error(`目标不是普通文件：${target}`);
    if (!force) {
        if (!stat) return { saved: false, conflict: true, missing: true };
        if (base && (stat.mtimeMs !== base.mtimeMs || stat.size !== base.size)) return { saved: false, conflict: true, missing: false };
    }
    await writeFileAtomic(target, body);
    const after = await fsp.stat(target);
    const warnings = [];
    let sidecars = [];
    try {
        sidecars = await rebuildSidecars({ mdPath: target, text: body, core, warnings });
    } catch (err) {
        const message = `Markdown 已保存，但旁路 JSON 重建失败：${errText(err)}`;
        warnings.push(message);
        log(`[desktop] ${message}`);
    }
    return { saved: true, conflict: false, missing: false, base: baseOf(after), mtimeMs: after.mtimeMs, size: after.size, sidecars, warnings };
}

// ============================================================
// bundle 旁路文件
// ============================================================

async function readJsonOrNull(filePath) {
    const stat = await statOrNull(filePath);
    if (!stat || !stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
    try {
        return JSON.parse((await fsp.readFile(filePath, 'utf8')).replace(/^﻿/, ''));
    } catch (err) {
        return null;
    }
}

async function findBundleJson(mdPath) {
    const abs = path.resolve(String(mdPath || ''));
    const dir = path.dirname(abs);
    const name = path.basename(abs, path.extname(abs));
    const jsonPath = path.join(dir, `${name}.json`);
    const parsed = await readJsonOrNull(jsonPath);
    if (!isPlainObject(parsed) || !Object.prototype.hasOwnProperty.call(parsed, 'schemaVersion')
        || !isPlainObject(parsed.ir) || !isPlainObject(parsed.meta)) return null;
    const contentListPath = path.join(dir, `${name}_content_list.json`);
    const listStat = await statOrNull(contentListPath);
    return { jsonPath, contentListPath, hasContentList: Boolean(listStat && listStat.isFile()), name, meta: parsed.meta };
}

async function rebuildSidecars({ mdPath, text, core, warnings }) {
    const found = await findBundleJson(mdPath);
    if (!found) return [];
    const built = await buildBundleSidecars({
        text, baseDir: path.dirname(mdPath), sourceName: path.basename(mdPath), previousMeta: found.meta, name: found.name, core,
    });
    if (!built) {
        warnings.push('Markdown 已保存；当前转换内核未提供 renderBundleSidecars，旁路 JSON 未随之更新');
        return [];
    }
    await writeFileAtomic(found.jsonPath, built.json);
    const written = [found.jsonPath];
    // 旧版产物包没有 content_list：只在它已存在时一并重建，不给用户目录凭空添文件
    if (found.hasContentList) {
        await writeFileAtomic(found.contentListPath, built.contentList);
        written.push(found.contentListPath);
    }
    return written;
}

function visitImages(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const item of node) visitImages(item, visit);
        return;
    }
    if (node.type === 'image') visit(node);
    if (Array.isArray(node.children)) for (const child of node.children) visitImages(child, visit);
}

function pickImageData(data, assetName) {
    const kept = {};
    for (const key of KEPT_IMAGE_DATA_KEYS) {
        if (key === 'assetName') continue;
        if (data && data[key] !== undefined) kept[key] = data[key];
    }
    return { ...kept, assetName };
}

/**
 * 解析 md 时 collectAssets 把图片 url 改写成 images/image_N 的新编号；写旁路文件前还原，使 json 与 content_list 的
 * img_path 与 md 一致：md 所在目录里的本地文件还原为磁盘上的真实相对路径；其余登记过的图片（data URL 解析时
 * 落在临时目录）按 assets 条目的 sourceUrl 还原为 md 里的原样地址，并去掉已无对应文件的 assetName。
 * 两者都不适用时只剥掉 data.asset。
 */
function restoreLocalImageUrls(ir, baseDir, assets = []) {
    const base = path.resolve(String(baseDir || ''));
    const sourceUrlByName = new Map(asArray(assets)
        .filter((asset) => asset && typeof asset.name === 'string' && typeof asset.sourceUrl === 'string' && asset.sourceUrl)
        .map((asset) => [asset.name, asset.sourceUrl]));
    visitImages(ir, (node) => {
        const data = isPlainObject(node.data) ? node.data : null;
        const absPath = data && data.asset && typeof data.asset.absPath === 'string' ? data.asset.absPath : '';
        if (absPath && isWithinDir(base, path.resolve(absPath)) && path.resolve(absPath) !== base) {
            const rel = toPosix(path.relative(base, path.resolve(absPath)));
            node.url = rel;
            node.data = pickImageData(data, rel);
            return;
        }
        const sourceUrl = data ? sourceUrlByName.get(data.assetName) : undefined;
        if (sourceUrl) {
            const { asset, assetName, ...rest } = data;
            node.url = sourceUrl;
            node.data = rest;
            return;
        }
        if (data && Object.prototype.hasOwnProperty.call(data, 'asset')) {
            const { asset, ...rest } = data;
            node.data = rest;
        }
    });
    return ir;
}

const looksAbsolute = (value) => typeof value === 'string' && (path.isAbsolute(value) || WINDOWS_ABS_RE.test(value));

/** 旧 meta 里的绝对路径（baseDir、来源所在目录等）不写进可随目录分发的 json */
function stripAbsolutePaths(meta) {
    if (!isPlainObject(meta)) return {};
    const out = {};
    for (const [key, value] of Object.entries(meta)) {
        if (key === 'baseDir' || looksAbsolute(value)) continue;
        out[key] = value;
    }
    return out;
}

async function buildBundleSidecars({ text, baseDir, sourceName, previousMeta = null, name, core = null } = {}) {
    const render = sidecarRendererOf(core);
    if (!render) return null;
    const api = loadMdCore(core);
    const doc = await api.parseMarkdown({ text: String(text == null ? '' : text) }, { baseDir, sourceName });
    restoreLocalImageUrls(doc.ir, baseDir, doc.assets);
    const meta = { ...stripAbsolutePaths(previousMeta), title: doc.meta && doc.meta.title, editedAt: new Date().toISOString() };
    const sidecarDoc = { ...doc, meta, assets: [] };
    const options = api.normalizeOptions({});
    const out = await render(sidecarDoc, { name: String(name || path.basename(String(sourceName || 'document'), path.extname(String(sourceName || '')))), options });
    if (!out || typeof out.json !== 'string' || typeof out.contentList !== 'string') {
        throw new Error('renderBundleSidecars 须返回 { json: string, contentList: string }');
    }
    return { json: out.json, contentList: out.contentList };
}

// ============================================================
// 插图
// ============================================================

function sanitizeStem(stem) {
    const cleaned = String(stem || '').replace(UNSAFE_NAME_RE, '_').replace(/_+/g, '_').replace(/^[._]+/, '').replace(/_+$/, '');
    const clipped = [...cleaned].slice(0, MAX_FILE_STEM_LENGTH).join('');
    return clipped || 'image';
}

async function copyWithoutOverwrite(sourcePath, dir, stem, ext) {
    for (let attempt = 0; attempt < MAX_COPY_ATTEMPTS; attempt += 1) {
        const fileName = attempt === 0 ? `${stem}${ext}` : `${stem}-${attempt}${ext}`;
        const target = path.join(dir, fileName);
        try {
            await fsp.copyFile(sourcePath, target, fs.constants.COPYFILE_EXCL);
            return target;
        } catch (err) {
            if (!err || err.code !== 'EEXIST') throw err;
        }
    }
    throw new Error(`images 目录下同名图片过多，无法再为「${stem}${ext}」取新名`);
}

async function measureImage(filePath) {
    try {
        const { imageSize } = require('image-size');
        const { width, height } = imageSize(await fsp.readFile(filePath));
        const finite = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : null);
        return { width: finite(width), height: finite(height) };
    } catch (err) {
        return { width: null, height: null };
    }
}

async function importImage({ sourcePath, docDir } = {}) {
    const source = path.resolve(String(sourcePath || ''));
    const ext = path.extname(source).toLowerCase();
    if (!IMAGE_IMPORT_EXTENSIONS.includes(ext)) {
        throw new Error(`只能插入 ${IMAGE_IMPORT_EXTENSIONS.join(' / ')} 格式的图片：${path.basename(source)}`);
    }
    const stat = await statOrNull(source);
    if (!stat || !stat.isFile()) throw new Error(`图片不存在或不是普通文件：${source}`);
    if (stat.size > MAX_IMAGE_IMPORT_BYTES) {
        throw new Error(`图片过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），插图上限为 ${MAX_IMAGE_IMPORT_BYTES / 1024 / 1024} MB`);
    }
    const realDir = await fsp.realpath(path.resolve(String(docDir || '')));
    const realSource = await fsp.realpath(source);
    const stem = path.basename(source, path.extname(source));
    let finalPath = realSource;
    if (!isWithinDir(realDir, realSource) || realSource === realDir) {
        const imagesDir = path.join(realDir, IMAGES_DIRNAME);
        await fsp.mkdir(imagesDir, { recursive: true });
        finalPath = await copyWithoutOverwrite(realSource, imagesDir, sanitizeStem(stem), ext);
    }
    const { width, height } = await measureImage(finalPath);
    return { relPath: toPosix(path.relative(realDir, finalPath)), width, height, alt: stem };
}

// ============================================================
// 被引用的图片
// ============================================================

async function listFiles(dir, prefix = '') {
    let entries;
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
        return [];
    }
    const out = [];
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)));
        else if (entry.isFile()) out.push(rel);
    }
    return out;
}

async function referencedImages(text, dir) {
    const body = String(text == null ? '' : text);
    const imagesDir = path.join(path.resolve(String(dir || '')), IMAGES_DIRNAME);
    const files = await listFiles(imagesDir);
    return files
        .map((rel) => ({ name: `${IMAGES_DIRNAME}/${rel}`, absPath: path.join(imagesDir, ...rel.split('/')) }))
        .filter(({ name }) => body.includes(name) || body.includes(encodeURI(name)));
}

module.exports = {
    renderMarkdownText, writeFileAtomic, saveMarkdownFile, findBundleJson, buildBundleSidecars,
    restoreLocalImageUrls, stripAbsolutePaths, importImage, referencedImages, writeAssets, sanitizeStem,
    loadMdCore, sidecarRendererOf, READER_THEME, IMAGES_DIRNAME, TEMP_SUFFIX,
};
