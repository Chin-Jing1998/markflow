/**
 * Markdown 图片资源解析
 *
 * 职责：遍历 IR 中所有 image 节点，把可获取的图片读成 Buffer 并挂到节点上，
 * 供 docx/pdf/pptx 等二进制渲染器直接内嵌，避免下游各自重复实现路径解析。
 *
 * 挂载形状：node.data.asset = { absPath, buffer, mime, width, height }
 *
 * 支持的地址形态：
 *   - 相对路径 / 绝对路径   → 相对 baseDir 解析后读盘，且必须落在 baseDir 之内
 *   - file:// URL           → 转本地路径后读盘，同样受 baseDir 约束
 *   - http(s):// URL        → 仅当注入 opts.fetchRemote 时下载，否则记 warning
 *   - data: URL             → 解码后落进程私有临时目录（下游 HTML 渲染需要 file:// 可达路径）
 *
 * 安全边界：本地路径先做词法包含判定（path.relative 不得越出 baseDir），
 * 命中磁盘后再用 realpath 二次判定，阻断 "../"、绝对路径与符号链接三类逃逸。
 *
 * 契约：resolveImages(ir, baseDir, opts?) → { resolved, warnings }，绝不抛出，
 * 所有失败以 warnings 字符串返回；除挂载 asset 外不改动 IR。
 */
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const { imageSize } = require('image-size');
const { errText, toBuffer } = require('../util');
const { createTempDirFactory, cleanupStaleTempDirs } = require('../tmp');

// 扩展名 → mime；另两张表由它派生，保证三者始终一致
const MIME_BY_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};
// image-size 返回的 type 字段（无点扩展名）→ mime
const MIME_BY_TYPE = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([ext, mime]) => [ext.slice(1), mime]));
// mime → 扩展名，同一 mime 取先出现的那个扩展名（image/jpeg → .jpg）
const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME_BY_EXT).toReversed().map(([ext, mime]) => [mime, ext]));

const DEFAULT_MIME = 'application/octet-stream';
// 临时目录前缀；实际目录由 mkdtemp 追加随机后缀，形如 markflow-md-assets-Ab3xY9。
// 回收时按无连字符的前缀匹配，以便一并清掉旧版的固定名目录
const TEMP_DIR_PREFIX = 'markflow-md-assets-';
const TEMP_DIR_MATCH_PREFIX = 'markflow-md-assets';
const TEMP_HASH_LEN = 16;
const TEMP_FILE_MODE = 0o600;

// 模块加载时异步清理超过 1 天未修改的历史临时目录（上次运行残留），失败静默
cleanupStaleTempDirs({ matchPrefix: TEMP_DIR_MATCH_PREFIX }).catch(() => {});

// 本进程私有临时目录（首次落盘时才创建）与「内容摘要 → 已落盘路径」缓存
const ensureTempDir = createTempDirFactory(TEMP_DIR_PREFIX);
const tempFileByKey = new Map();

async function resolveImages(ir, baseDir, opts = {}) {
    const warnings = [];
    const base = baseDir || process.cwd();
    let resolved = 0;

    for (const node of collectImageNodes(ir)) {
        const url = typeof node.url === 'string' ? node.url.trim() : '';
        if (!url) continue;
        let asset = null;
        try {
            asset = await resolveOne(url, base, opts, warnings);
        } catch (err) {
            asset = warn(warnings, `图片解析失败: ${url}（${errText(err)}）`);
        }
        if (asset) {
            node.data = { ...node.data, asset };
            resolved += 1;
        }
    }
    return { resolved, warnings };
}

// 记一条 warning，并以 null 表示该图片未解析成功
function warn(warnings, message) {
    warnings.push(message);
    return null;
}

async function resolveOne(url, baseDir, opts, warnings) {
    if (/^data:/i.test(url)) return resolveDataUrl(url, warnings);
    if (/^https?:\/\//i.test(url)) return resolveRemoteUrl(url, opts, warnings);
    return resolveLocalPath(url, baseDir, warnings);
}

async function resolveLocalPath(url, baseDir, warnings) {
    const { absPath, blocked } = await pickSafePath(url, baseDir);
    if (!absPath) {
        // 越界优先报告：文件存在与否都不泄露，避免把 baseDir 外的存在性当作探测信道
        if (blocked) return warn(warnings, `图片超出文档目录，未内嵌: ${url}`);
        return warn(warnings, `图片未找到: ${url}`);
    }
    let buffer;
    try {
        buffer = await fsp.readFile(absPath);
    } catch (err) {
        return warn(warnings, `图片未找到: ${url}（${errText(err)}）`);
    }
    return buildAsset({ absPath, buffer, mimeHint: guessMimeByExt(absPath), url, warnings });
}

async function resolveRemoteUrl(url, opts, warnings) {
    if (typeof opts.fetchRemote !== 'function') return warn(warnings, `远程图片未内嵌: ${url}`);
    let fetched;
    try {
        fetched = await opts.fetchRemote(url);
    } catch (err) {
        return warn(warnings, `远程图片下载失败: ${url}（${errText(err)}）`);
    }
    const buffer = toBuffer(fetched && fetched.buffer);
    if (!buffer || buffer.length === 0) return warn(warnings, `远程图片下载失败: ${url}（返回内容为空）`);
    // 猜扩展名前先剥掉查询串与锚点
    const mimeHint = (fetched && fetched.mime) || guessMimeByExt(String(url).split('?')[0].split('#')[0]);
    return buildAsset({ absPath: null, buffer, mimeHint, url, warnings });
}

async function resolveDataUrl(url, warnings) {
    const matched = /^data:([^,]*),([\s\S]*)$/i.exec(url);
    if (!matched) return warn(warnings, '图片解析失败: data URL 格式非法');
    const descriptor = matched[1] || '';
    const mimeHint = (descriptor.split(';')[0] || '').trim() || DEFAULT_MIME;
    let buffer;
    try {
        buffer = /;base64/i.test(descriptor)
            ? Buffer.from(matched[2], 'base64')
            : Buffer.from(decodeURIComponent(matched[2]), 'utf8');
    } catch (err) {
        return warn(warnings, `图片解析失败: data URL 解码失败（${errText(err)}）`);
    }
    if (buffer.length === 0) return warn(warnings, '图片解析失败: data URL 内容为空');
    return buildAsset({ absPath: null, buffer, mimeHint, url: 'data URL', warnings });
}

// absPath 为空表示来源非磁盘（远程/data URL），落临时文件以便 HTML 渲染用 file:// 引用
async function buildAsset({ absPath, buffer, mimeHint, url, warnings }) {
    const measured = measure(buffer);
    if (measured.width === null) warnings.push(`图片尺寸解析失败: ${url}`);
    const mime = normalizeMime(mimeHint, measured.type);
    const finalPath = absPath || await writeTempFile(buffer, mime, warnings);
    return { absPath: finalPath, buffer, mime, width: measured.width, height: measured.height };
}

function measure(buffer) {
    try {
        const { width, height, type } = imageSize(buffer);
        const finite = (v) => (Number.isFinite(v) ? v : null);
        return { width: finite(width), height: finite(height), type: type || null };
    } catch (err) {
        return { width: null, height: null, type: null };
    }
}

// ============================================================
// 进程私有临时目录
// ============================================================

// 同一进程内同内容只落盘一次；wx + 0600 保证不覆盖已有文件、不对同组同其他用户开放
async function writeTempFile(buffer, mime, warnings) {
    const key = `${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, TEMP_HASH_LEN)}${EXT_BY_MIME[mime] || '.bin'}`;
    const cached = tempFileByKey.get(key);
    if (cached) return cached;
    try {
        const target = path.join(await ensureTempDir(), key);
        // 目录为本进程私有，EEXIST 只可能源于并发写同一内容，视同成功
        await fsp.writeFile(target, buffer, { flag: 'wx', mode: TEMP_FILE_MODE })
            .catch((err) => { if (!err || err.code !== 'EEXIST') throw err; });
        tempFileByKey.set(key, target);
        return target;
    } catch (err) {
        return warn(warnings, `图片临时落盘失败（${errText(err)}）`);
    }
}

// ============================================================
// 本地路径解析与目录边界判定
// ============================================================

// 逐个候选路径判定：先词法包含，再存在性，最后 realpath 二次包含；
// 返回 { absPath, blocked }，blocked 表示至少有一个候选因越界被拒。
// 先用 decodeURIComponent 结果，取不到再回退原字符串（文件名含字面量 % 时）
async function pickSafePath(url, baseDir) {
    const candidates = new Set(toPathCandidates(url).map((raw) => path.resolve(baseDir, raw)));
    let blocked = false;
    for (const abs of candidates) {
        if (!isWithinDir(baseDir, abs)) { blocked = true; continue; }
        if (!await isReadableFile(abs)) continue;
        if (!await isRealWithinDir(baseDir, abs)) { blocked = true; continue; }
        return { absPath: abs, blocked };
    }
    return { absPath: null, blocked };
}

// 词法判定：absPath 位于 baseDir 之内（含 baseDir 自身）
function isWithinDir(baseDir, absPath) {
    const rel = path.relative(path.resolve(baseDir), absPath);
    if (rel === '') return true;
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// realpath 判定：解开符号链接后仍在 baseDir 之内；任一端 realpath 失败即视为越界
async function isRealWithinDir(baseDir, absPath) {
    try {
        const [realBase, realTarget] = await Promise.all([fsp.realpath(baseDir), fsp.realpath(absPath)]);
        return isWithinDir(realBase, realTarget);
    } catch (err) {
        return false;
    }
}

function toPathCandidates(url) {
    if (!/^file:\/\//i.test(url)) {
        const decoded = safeDecode(url);
        return decoded === url ? [url] : [decoded, url];
    }
    const list = [];
    try {
        list.push(fileURLToPath(url));
    } catch (err) { /* 非规范 file:// 写法，退化为剥离协议头 */ }
    const stripped = url.replace(/^file:\/\//i, '');
    return [...list, safeDecode(stripped), stripped].filter(Boolean);
}

function safeDecode(value) {
    try { return decodeURIComponent(value); } catch (err) { return value; }
}

async function isReadableFile(absPath) {
    try { return (await fsp.stat(absPath)).isFile(); } catch (err) { return false; }
}

function guessMimeByExt(target) {
    const ext = path.extname(String(target || '')).toLowerCase();
    return MIME_BY_EXT[ext] || null;
}

function normalizeMime(mimeHint, detectedType) {
    const hint = String(mimeHint || '').trim().toLowerCase();
    if (hint && hint !== DEFAULT_MIME) return hint;
    return (detectedType && MIME_BY_TYPE[String(detectedType).toLowerCase()]) || DEFAULT_MIME;
}


// 递归收集 image 节点，覆盖表格单元格、列表项、引用等任意嵌套层级
function collectImageNodes(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
        for (const item of node) collectImageNodes(item, out);
        return out;
    }
    if (node.type === 'image') out.push(node);
    if (Array.isArray(node.children)) for (const child of node.children) collectImageNodes(child, out);
    return out;
}

module.exports = { resolveImages, collectImageNodes };
