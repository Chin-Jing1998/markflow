/**
 * 产物落盘
 *
 * writeBundle({ outputDir, name, md, json, assets })
 *   → { dir, mdPath, jsonPath, imagesDir | null }
 *   目录 {outputDir}/{name}/，文件 {name}.md 与 {name}.json；
 *   assets 非空时创建 images/ 并按 assets[].name（形如 images/image_1.png）写入。
 * writeSingle({ outputDir, name, ext, buffer })
 *   → 绝对路径 {outputDir}/{name}.{ext}
 *
 * 均覆盖写、全部使用 fs.promises、不删除任何既有文件。
 */
const path = require('path');
const fsp = require('fs').promises;
const { ensureDir } = require('./ir/util');

const IMAGES_DIRNAME = 'images';
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

// ============================================================
// bundle：md + json + images/
// ============================================================

async function writeBundle({ outputDir, name, md, json, assets = [] } = {}) {
    const baseDir = resolveOutputDir(outputDir);
    assertName(name);
    if (typeof md !== 'string') throw new Error('writeBundle 需要字符串形式的 md');
    if (typeof json !== 'string') throw new Error('writeBundle 需要字符串形式的 json');
    const assetList = Array.isArray(assets) ? assets : [];

    const dir = path.join(baseDir, name);
    await ensureDir(dir);

    const mdPath = path.join(dir, `${name}.md`);
    const jsonPath = path.join(dir, `${name}.json`);
    await Promise.all([
        fsp.writeFile(mdPath, md, 'utf8'),
        fsp.writeFile(jsonPath, json, 'utf8'),
    ]);

    const imagesDir = assetList.length > 0 ? await writeAssets(dir, assetList) : null;
    return { dir, mdPath, jsonPath, imagesDir };
}

async function writeAssets(dir, assets) {
    // 先解析并校验全部目标路径，再统一写盘，避免半途失败留下部分产物
    const jobs = assets.map((asset) => ({
        target: resolveAssetPath(dir, asset),
        buffer: toBuffer(asset),
    }));

    const imagesDir = path.join(dir, IMAGES_DIRNAME);
    await ensureDir(imagesDir);
    await Promise.all(jobs.map(async ({ target, buffer }) => {
        await ensureDir(path.dirname(target));
        await fsp.writeFile(target, buffer);
    }));
    return imagesDir;
}

// 资源名限定为 dir 内的相对路径，拒绝绝对路径与 ".." 穿越
function resolveAssetPath(dir, asset) {
    const name = asset && typeof asset.name === 'string' ? asset.name.trim() : '';
    if (!name) throw new Error('资源缺少 name');

    const normalized = name.replace(/\\/g, '/');
    if (path.isAbsolute(normalized) || WINDOWS_DRIVE_RE.test(normalized)) {
        throw new Error(`资源名不得为绝对路径：${name}`);
    }
    if (normalized.split('/').includes('..')) {
        throw new Error(`资源名不得包含 ".."：${name}`);
    }

    const target = path.resolve(dir, normalized);
    const relative = path.relative(dir, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`资源名越出输出目录：${name}`);
    }
    return target;
}

function toBuffer(asset) {
    const buffer = asset && asset.buffer;
    if (Buffer.isBuffer(buffer)) return buffer;
    if (buffer instanceof Uint8Array) return Buffer.from(buffer);
    throw new Error(`资源 ${asset && asset.name} 缺少 Buffer 内容`);
}

// ============================================================
// 单文件：docx / pdf
// ============================================================

async function writeSingle({ outputDir, name, ext, buffer } = {}) {
    const baseDir = resolveOutputDir(outputDir);
    assertName(name);

    const cleanExt = String(ext == null ? '' : ext).trim().replace(/^\.+/, '');
    if (!cleanExt) throw new Error('writeSingle 需要扩展名 ext');

    const body = Buffer.isBuffer(buffer)
        ? buffer
        : (buffer instanceof Uint8Array ? Buffer.from(buffer) : null);
    if (!body) throw new Error('writeSingle 需要 Buffer 内容');

    await ensureDir(baseDir);
    const target = path.join(baseDir, `${name}.${cleanExt}`);
    await fsp.writeFile(target, body);
    return target;
}

// ============================================================
// 参数校验
// ============================================================

function resolveOutputDir(outputDir) {
    if (typeof outputDir !== 'string' || !outputDir.trim()) {
        throw new Error('缺少输出目录 outputDir');
    }
    return path.resolve(outputDir);
}

function assertName(name) {
    if (typeof name !== 'string' || !name.trim()) {
        throw new Error('缺少产物名 name');
    }
    if (/[\\/]/.test(name) || name === '.' || name === '..') {
        throw new Error(`产物名不得包含路径分隔符：${name}`);
    }
}

module.exports = { writeBundle, writeSingle };
