/**
 * patent profile 的图片资源登记：把 IR 里的资产名（images/image_3.jpg）映射为平铺在产物目录根下的裸文件名
 *
 * createAssetRegistry(docAssets) → registry
 *   use(assetName, { kind }) → { file, asset } | null
 *     首次使用时分配裸文件名：kind 为 'drawing'（附图）时命名为 drawing-<序>.<扩展名>，序按附图首次使用顺序
 *     从 1 起；其它（栅格化的 table-*.jpg / omath-*.jpg 与段内图片）沿用资产名的 basename。同一资产多次
 *     使用返回同一文件名；文件名冲突时追加 -2、-3。资产不存在返回 null。
 *   list()   → [{ name, buffer, mime }]，按首次使用顺序，供渲染器作为 assets 返回（裸文件名，不带 images/）
 *   unused() → 未被任何部分引用的资产名列表
 * 官方案卷包内 XML 与图片平铺于同一目录且不存在任何子目录，故 img/@file 只能是裸文件名（研究报告 §4.4）。
 */
const path = require('path');

const DRAWING_PREFIX = 'drawing-';

function createAssetRegistry(docAssets) {
    const byName = new Map();
    for (const asset of Array.isArray(docAssets) ? docAssets : []) {
        if (asset && typeof asset.name === 'string' && asset.name && Buffer.isBuffer(asset.buffer) && !byName.has(asset.name)) {
            byName.set(asset.name, asset);
        }
    }
    const used = new Map();
    const takenFiles = new Set();
    let drawingCount = 0;

    function use(assetName, { kind = 'inline' } = {}) {
        if (typeof assetName !== 'string' || !byName.has(assetName)) return null;
        if (used.has(assetName)) return used.get(assetName);
        const asset = byName.get(assetName);
        const ext = path.posix.extname(assetName).toLowerCase() || '.jpg';
        let base;
        if (kind === 'drawing') {
            drawingCount += 1;
            base = `${DRAWING_PREFIX}${drawingCount}${ext}`;
        } else {
            base = path.posix.basename(assetName);
        }
        const file = uniqueFile(base, takenFiles);
        takenFiles.add(file);
        const entry = { file, asset };
        used.set(assetName, entry);
        return entry;
    }

    return {
        use,
        list: () => [...used.entries()].map(([, { file, asset }]) => ({ name: file, buffer: asset.buffer, mime: asset.mime })),
        unused: () => [...byName.keys()].filter((name) => !used.has(name)),
    };
}

function uniqueFile(base, taken) {
    if (!taken.has(base)) return base;
    const ext = path.posix.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let counter = 2;
    while (taken.has(`${stem}-${counter}${ext}`)) counter += 1;
    return `${stem}-${counter}${ext}`;
}

module.exports = { createAssetRegistry };
