/**
 * Markdown 图片资源解析
 *
 * 职责：遍历 IR 中所有 image 节点，把可获取的图片读成 Buffer 并挂到节点上，
 * 供 docx/pdf/pptx 等二进制渲染器直接内嵌，避免下游各自重复实现路径解析。
 *
 * 挂载形状：node.data.asset = { absPath, buffer, mime, width, height }
 *
 * 支持的地址形态：
 *   - 相对路径 / 绝对路径   → 相对 baseDir 解析后读盘
 *   - file:// URL           → 转本地路径后读盘
 *   - http(s):// URL        → 仅当注入 opts.fetchRemote 时下载，否则记 warning
 *   - data: URL             → 解码后落临时文件（下游 HTML 渲染需要 file:// 可达路径）
 *
 * 契约：本函数绝不抛出，所有失败以 warnings 字符串返回；除挂载 asset 外不改动 IR。
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const { imageSize } = require('image-size');

const MIME_BY_EXT = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
};

// image-size 返回的 type 字段 → mime
const MIME_BY_TYPE = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
};

const EXT_BY_MIME = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
};

const DEFAULT_MIME = 'application/octet-stream';
const TEMP_SUBDIR = 'markflow-md-assets';
const TEMP_HASH_LEN = 16;
const STALE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// 模块加载时异步清理超过 1 天未修改的临时图片（上次运行残留），失败静默
function cleanupStaleTempFiles() {
    const dir = path.join(os.tmpdir(), TEMP_SUBDIR);
    return fs.promises.readdir(dir).then(async (names) => {
        const now = Date.now();
        for (const name of names) {
            const target = path.join(dir, name);
            const stat = await fs.promises.stat(target).catch(() => null);
            if (!stat || !stat.isFile() || now - stat.mtimeMs < STALE_TEMP_MAX_AGE_MS) continue;
            await fs.promises.rm(target, { force: true }).catch(() => {});
        }
    }).catch(() => {});
}
cleanupStaleTempFiles();

// ============================================================
// 对外入口
// ============================================================

/**
 * @param {object} ir      mdast root
 * @param {string} baseDir 相对路径基准目录
 * @param {object} opts    { fetchRemote?: (url) => Promise<{buffer, mime}> }
 * @returns {Promise<{resolved: number, warnings: string[]}>}
 */
async function resolveImages(ir, baseDir, opts = {}) {
    const warnings = [];
    const nodes = collectImageNodes(ir);
    const base = baseDir || process.cwd();
    let resolved = 0;

    for (const node of nodes) {
        const url = typeof node.url === 'string' ? node.url.trim() : '';
        if (!url) continue;

        let asset = null;
        try {
            asset = await resolveOne(url, base, opts, warnings);
        } catch (err) {
            warnings.push(`图片解析失败: ${url}（${errText(err)}）`);
            asset = null;
        }

        if (asset) {
            node.data = { ...node.data, asset };
            resolved += 1;
        }
    }

    return { resolved, warnings };
}

// ============================================================
// 单个地址解析
// ============================================================

async function resolveOne(url, baseDir, opts, warnings) {
    if (isDataUrl(url)) return resolveDataUrl(url, warnings);
    if (isRemoteUrl(url)) return resolveRemoteUrl(url, opts, warnings);
    return resolveLocalPath(url, baseDir, warnings);
}

function isDataUrl(url) {
    return /^data:/i.test(url);
}

function isRemoteUrl(url) {
    return /^https?:\/\//i.test(url);
}

async function resolveLocalPath(url, baseDir, warnings) {
    const absPath = await pickExistingPath(url, baseDir);
    if (!absPath) {
        warnings.push(`图片未找到: ${url}`);
        return null;
    }

    let buffer;
    try {
        buffer = await fsp.readFile(absPath);
    } catch (err) {
        warnings.push(`图片未找到: ${url}（${errText(err)}）`);
        return null;
    }

    return buildAsset({ absPath, buffer, mimeHint: guessMimeByExt(absPath), url, warnings });
}

async function resolveRemoteUrl(url, opts, warnings) {
    if (typeof opts.fetchRemote !== 'function') {
        warnings.push(`远程图片未内嵌: ${url}`);
        return null;
    }

    let fetched;
    try {
        fetched = await opts.fetchRemote(url);
    } catch (err) {
        warnings.push(`远程图片下载失败: ${url}（${errText(err)}）`);
        return null;
    }

    const buffer = toBuffer(fetched && fetched.buffer);
    if (!buffer || buffer.length === 0) {
        warnings.push(`远程图片下载失败: ${url}（返回内容为空）`);
        return null;
    }

    const mimeHint = (fetched && fetched.mime) || guessMimeByExt(stripQuery(url));
    return buildAsset({ absPath: null, buffer, mimeHint, url, warnings });
}

function resolveDataUrl(url, warnings) {
    const matched = /^data:([^,]*),([\s\S]*)$/i.exec(url);
    if (!matched) {
        warnings.push(`图片解析失败: data URL 格式非法`);
        return null;
    }

    const descriptor = matched[1] || '';
    const mimeHint = (descriptor.split(';')[0] || '').trim() || DEFAULT_MIME;
    let buffer;
    try {
        buffer = /;base64/i.test(descriptor)
            ? Buffer.from(matched[2], 'base64')
            : Buffer.from(decodeURIComponent(matched[2]), 'utf8');
    } catch (err) {
        warnings.push(`图片解析失败: data URL 解码失败（${errText(err)}）`);
        return null;
    }

    if (buffer.length === 0) {
        warnings.push(`图片解析失败: data URL 内容为空`);
        return null;
    }

    return buildAsset({ absPath: null, buffer, mimeHint, url: 'data URL', warnings });
}

// ============================================================
// asset 组装
// ============================================================

// absPath 为空表示来源非磁盘（远程/data URL），落临时文件以便 HTML 渲染用 file:// 引用
function buildAsset({ absPath, buffer, mimeHint, url, warnings }) {
    const measured = measure(buffer);
    if (measured.width === null) {
        warnings.push(`图片尺寸解析失败: ${url}`);
    }

    const mime = normalizeMime(mimeHint, measured.type);
    const finalPath = absPath || writeTempFile(buffer, mime, warnings);

    return {
        absPath: finalPath,
        buffer,
        mime,
        width: measured.width,
        height: measured.height,
    };
}

function measure(buffer) {
    try {
        const size = imageSize(buffer);
        return {
            width: Number.isFinite(size.width) ? size.width : null,
            height: Number.isFinite(size.height) ? size.height : null,
            type: size.type || null,
        };
    } catch (err) {
        return { width: null, height: null, type: null };
    }
}

function writeTempFile(buffer, mime, warnings) {
    try {
        const dir = path.join(os.tmpdir(), TEMP_SUBDIR);
        fs.mkdirSync(dir, { recursive: true });
        const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, TEMP_HASH_LEN);
        const target = path.join(dir, `${hash}${EXT_BY_MIME[mime] || '.bin'}`);
        if (!fs.existsSync(target)) {
            fs.writeFileSync(target, buffer);
        }
        return target;
    } catch (err) {
        warnings.push(`图片临时落盘失败（${errText(err)}）`);
        return null;
    }
}

// ============================================================
// 路径与 mime 工具
// ============================================================

// 先用 decodeURIComponent 结果，取不到再回退原字符串（文件名含字面量 % 时）
async function pickExistingPath(url, baseDir) {
    const candidates = [];
    for (const raw of toPathCandidates(url)) {
        const abs = path.resolve(baseDir, raw);
        if (!candidates.includes(abs)) candidates.push(abs);
    }
    for (const abs of candidates) {
        if (await isReadableFile(abs)) return abs;
    }
    return null;
}

function toPathCandidates(url) {
    if (/^file:\/\//i.test(url)) {
        const list = [];
        try {
            list.push(fileURLToPath(url));
        } catch (err) {
            // 非规范 file:// 写法，退化为剥离协议头
        }
        const stripped = url.replace(/^file:\/\//i, '');
        list.push(safeDecode(stripped), stripped);
        return list.filter(Boolean);
    }
    const decoded = safeDecode(url);
    return decoded === url ? [url] : [decoded, url];
}

function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch (err) {
        return value;
    }
}

async function isReadableFile(absPath) {
    try {
        const stat = await fsp.stat(absPath);
        return stat.isFile();
    } catch (err) {
        return false;
    }
}

function stripQuery(url) {
    return String(url).split('?')[0].split('#')[0];
}

function guessMimeByExt(target) {
    const ext = path.extname(String(target || '')).toLowerCase();
    return MIME_BY_EXT[ext] || null;
}

function normalizeMime(mimeHint, detectedType) {
    const hint = String(mimeHint || '').trim().toLowerCase();
    if (hint && hint !== DEFAULT_MIME) return hint;
    const byType = detectedType && MIME_BY_TYPE[String(detectedType).toLowerCase()];
    return byType || DEFAULT_MIME;
}

function toBuffer(value) {
    if (!value) return null;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) return Buffer.from(value);
    return null;
}

function errText(err) {
    return (err && err.message) ? err.message : String(err);
}

// ============================================================
// IR 遍历
// ============================================================

// 递归收集 image 节点，覆盖表格单元格、列表项、引用等任意嵌套层级
function collectImageNodes(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
        for (const item of node) collectImageNodes(item, out);
        return out;
    }
    if (node.type === 'image') out.push(node);
    if (Array.isArray(node.children)) {
        for (const child of node.children) collectImageNodes(child, out);
    }
    return out;
}

module.exports = { resolveImages, collectImageNodes,
    _cleanupStaleTempFiles: cleanupStaleTempFiles,
};
