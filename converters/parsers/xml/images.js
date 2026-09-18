/**
 * 五书反向导入的图片：img 元素 → IR image 节点，并登记为文档资产
 *
 * createImageImporter({ readImage, report, defaultDpi }) → importer
 *   importer.importImage(dir, attrs, { role? }) → Promise<imageNode | null>
 *     dir 为该 img 所属 XML 的目录键（见 source.js），attrs 为 img 元素的属性，role 为 'formula' | 'table' | 'chemistry'
 *     （img 位于 maths / tables / chemistry 内时给出）。取不到可用图片返回 null，原因已记入 report，由调用方写缺图占位。
 *   importer.assets() → [{ name: 'images/<原文件名>', buffer, mime }]，同一文件被多处引用只登记一份
 *   importer.count / importer.roleCount → 已导入的图片节点数 / 其中带角色（公式、表格、化学式）的节点数
 *
 * image 节点：{ type: 'image', url, alt, title: null, data: { assetName, asset: { buffer, mime, width, height },
 *   display: { width, height, unit: 'px', source: 'xml' }, displayWidthMm, displayHeightMm, role? } }
 *   data.asset 供 docx / pdf 渲染器内嵌；display 为 96 DPI 下的像素，供 md / html 按物理幅面显示；
 *   displayWidthMm / displayHeightMm 为物理显示尺寸，docx 渲染器据此写 wp:extent，XML 渲染层据此写 img/@wi、@he。
 *
 * 显示尺寸的取法（往返不动点的关键，对齐正向链路「按 Word 显示尺寸在 300 DPI 重采样、wi/he 向下取整」的规则）：
 *   以图片自身的像素与 JFIF 密度为准（毫米 = 像素 × 25.4 ÷ 密度），不直接用 img/@wi、@he——那是向下取整过的毫米，
 *   用它回转会让像素漂移。但 wi/he 仍要参与微调：官方的 wi/he 取自原稿的显示毫米，像素则是该毫米四舍五入到 300 DPI
 *   的结果，二者偶有「像素换回的毫米刚好越过整数线」的情形（实测样稿 16 幅附图中有 1 幅：2138 px → 181.02 mm，
 *   而 he="180"）。故在半个像素的范围内把显示尺寸挪进 [wi, wi + 1) 区间，使回转后像素与 wi/he 同时复原；
 *   挪不进去（手写 XML、按四舍五入写 wi/he 的旧产物）即以像素与密度为准。
 *   尺寸一律先换成整数 EMU 再换回毫米（1 mm = 36000 EMU），与 docx 渲染器写出的 wp:extent 逐值一致，
 *   区间两端各留 1 EMU，免得浮点误差让恰为整数的毫米值向下取整时少 1。
 *   图片不带密度（PNG、无 JFIF 单位的 JPEG）时改用 wi/he；两者都没有按 defaultDpi（缺省 300）估算。
 *
 * 安全：img/@file 只接受裸文件名（无路径分隔符、盘符、控制字符，不以点开头）与白名单扩展名；字节按魔数判定类型，
 * 与扩展名不符时以魔数为准，魔数不认识的一律不导入。读取由 source.js 限定在所属 XML 的同级目录内。
 */
const path = require('path');
const { readImageInfo } = require('../../renderers/xml/image-info');

const ASSET_DIR = 'images';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.tif', '.tiff', '.png', '.gif', '.bmp']);
const MAX_FILE_NAME = 255;
const PATH_CHARS_RE = /[\\/:]/;
const FIRST_PRINTABLE_CODE = 32;
const EMU_PER_MM = 36000;
const EMU_PER_INCH = 914400;
const EMU_PER_PX = 9525;
const DEFAULT_DPI = 300;
// 密度与显示尺寸的可信范围：超出即视为图片没有可用的物理尺寸信息
const MIN_DPI = 30;
const MAX_DPI = 5000;
const MAX_DISPLAY_MM = 1000;
const SOURCE = 'xml';
const MAX_SHOWN_NAME = 60;

function createImageImporter({ readImage, report, defaultDpi = DEFAULT_DPI }) {
    // 目录键 → 文件名 → 资产（读不到的记为 null，免得同一缺图重复告警）
    const assetsByDir = new Map();
    const usedNames = new Set();
    let count = 0;
    let roleCount = 0;

    async function importImage(dir, attrs, { role } = {}) {
        const file = String((attrs && attrs.file) || '').trim();
        if (!isAcceptableFileName(file)) {
            report.warn(`图片引用「${clip(file) || '（空）'}」不是同目录下受支持的裸文件名（不得含路径、盘符，扩展名须为 jpg / tif / png / gif / bmp），已按缺图处理`);
            return null;
        }
        const asset = await loadAsset(dir, file);
        if (!asset) return null;
        count += 1;
        if (role) roleCount += 1;
        return buildNode(asset, attrs, role, { report, defaultDpi });
    }

    // 同一目录下的同一文件只读一次、只登记一份
    async function loadAsset(dir, file) {
        if (!assetsByDir.has(dir)) assetsByDir.set(dir, new Map());
        const known = assetsByDir.get(dir);
        if (known.has(file)) return known.get(file);
        const buffer = await readImage(dir, file);
        const mime = buffer ? sniffMime(buffer) : null;
        if (buffer && !mime) report.warn(`图片 ${file} 的内容不是受支持的图片格式（jpg / tif / png / gif / bmp），已按缺图处理`);
        const asset = mime ? { name: claimName(file, usedNames), buffer, mime, file } : null;
        known.set(file, asset);
        return asset;
    }

    const listAssets = () => [...assetsByDir.values()].flatMap((known) => [...known.values()])
        .filter(Boolean).map(({ name, buffer, mime }) => ({ name, buffer, mime }));

    return { importImage, assets: listAssets, get count() { return count; }, get roleCount() { return roleCount; } };
}

function isAcceptableFileName(file) {
    if (!file || file.length > MAX_FILE_NAME || file.startsWith('.') || PATH_CHARS_RE.test(file)) return false;
    if ([...file].some((char) => char.charCodeAt(0) < FIRST_PRINTABLE_CODE)) return false;
    return IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

// images/<原文件名>；不同目录下的同名文件依次改名为 <主干>_2.<扩展名>、_3……（比较不分大小写）
function claimName(file, usedNames) {
    const ext = path.extname(file);
    const stem = file.slice(0, file.length - ext.length);
    let name = `${ASSET_DIR}/${file}`;
    for (let n = 2; usedNames.has(name.toLowerCase()); n += 1) name = `${ASSET_DIR}/${stem}_${n}${ext}`;
    usedNames.add(name.toLowerCase());
    return name;
}

function sniffMime(buffer) {
    if (buffer.length < 4) return null;
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
    if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504E47 && buffer.readUInt32BE(4) === 0x0D0A1A0A) return 'image/png';
    if (buffer.readUInt32BE(0) === 0x49492A00 || buffer.readUInt32BE(0) === 0x4D4D002A) return 'image/tiff';
    if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('latin1', 0, 6))) return 'image/gif';
    if (buffer[0] === 0x42 && buffer[1] === 0x4D) return 'image/bmp';
    return null;
}

function buildNode(asset, attrs, role, { report, defaultDpi }) {
    const info = readImageInfo(asset.buffer, asset.mime) || {};
    const size = displaySize(info, attrs, defaultDpi);
    if (size && size.conflict) {
        report.warn(`图片 ${asset.file} 的 wi/he（${size.conflict.declared} mm）与按其像素和密度换算的尺寸（${size.conflict.natural} mm）不一致，已按像素与密度确定显示尺寸`);
    }
    const data = { assetName: asset.name, asset: { buffer: asset.buffer, mime: asset.mime, width: info.width || undefined, height: info.height || undefined } };
    if (size) {
        data.display = { width: emuToPx(size.width), height: emuToPx(size.height), unit: 'px', source: SOURCE };
        data.displayWidthMm = size.width / EMU_PER_MM;
        data.displayHeightMm = size.height / EMU_PER_MM;
    } else {
        report.warn(`图片 ${asset.file} 的像素尺寸读不出来，Word 中将按其默认大小显示`);
    }
    if (role) data.role = role;
    return { type: 'image', url: asset.name, alt: String((attrs && attrs.alt) || '').trim(), title: null, data };
}

const emuToPx = (emu) => Math.max(1, Math.round(emu / EMU_PER_PX));

/**
 * → { width, height, conflict? }（整数 EMU）| null。
 * 有可信密度：逐维按像素与密度换算，再在半个像素内向 wi / he 对齐；无密度：取 wi / he，缺项按宽高比补齐，
 * 两者皆无按 defaultDpi 估算。任一维超出 MAX_DISPLAY_MM 时按比例缩回（这类尺寸只可能来自错误的密度信息）。
 */
function displaySize(info, attrs, defaultDpi) {
    const { width: pxW, height: pxH } = info;
    if (!(pxW > 0) || !(pxH > 0)) return null;
    const declared = { width: positiveInt(attrs && attrs.wi), height: positiveInt(attrs && attrs.he) };
    const dpi = Number.isFinite(info.dpi) && info.dpi >= MIN_DPI && info.dpi <= MAX_DPI ? info.dpi : null;
    if (dpi) {
        const width = alignToDeclared(pxW, dpi, declared.width);
        const height = alignToDeclared(pxH, dpi, declared.height);
        const conflict = width.conflict || height.conflict
            ? { declared: `${declared.width || '?'}×${declared.height || '?'}`, natural: `${mmText(width.natural)}×${mmText(height.natural)}` }
            : undefined;
        return fitWithin({ width: width.emu, height: height.emu, conflict });
    }
    if (declared.width && declared.height) return fitWithin({ width: declaredEmu(declared.width), height: declaredEmu(declared.height) });
    if (declared.width) return fitWithin(scaleFrom(declaredEmu(declared.width), pxW, pxH));
    const fallbackDpi = Number.isFinite(defaultDpi) && defaultDpi >= MIN_DPI ? defaultDpi : DEFAULT_DPI;
    return fitWithin({ width: Math.round((pxW * EMU_PER_INCH) / fallbackDpi), height: Math.round((pxH * EMU_PER_INCH) / fallbackDpi) });
}

// 单维：像素与密度换算出的 EMU，在半个像素之内挪进 [declared, declared + 1) 毫米区间（两端各留 1 EMU）
function alignToDeclared(px, dpi, declared) {
    const natural = (px * EMU_PER_INCH) / dpi;
    const rounded = Math.round(natural);
    if (!declared) return { emu: rounded, natural, conflict: false };
    const low = declared * EMU_PER_MM + 1;
    const high = (declared + 1) * EMU_PER_MM - 1;
    const aligned = Math.min(Math.max(rounded, low), high);
    const halfPixel = (EMU_PER_INCH / dpi) / 2;
    if (Math.abs(aligned - natural) < halfPixel) return { emu: aligned, natural, conflict: false };
    // 相差不足 1 mm 的是取整口径不同（四舍五入写的 wi/he），不算冲突；差得更多才提示
    return { emu: rounded, natural, conflict: Math.abs(natural - (low + high) / 2) > EMU_PER_MM + halfPixel };
}

const declaredEmu = (mm) => mm * EMU_PER_MM + 1;

const scaleFrom = (widthEmu, pxW, pxH) => ({ width: widthEmu, height: Math.max(1, Math.round((widthEmu * pxH) / pxW)) });

function fitWithin(size) {
    const limit = MAX_DISPLAY_MM * EMU_PER_MM;
    const over = Math.max(size.width, size.height) / limit;
    if (over <= 1) return size;
    return { ...size, width: Math.max(1, Math.round(size.width / over)), height: Math.max(1, Math.round(size.height / over)) };
}

function positiveInt(value) {
    const text = String(value == null ? '' : value).trim();
    if (!/^\d{1,5}$/.test(text)) return null;
    const number = Number(text);
    return number >= 1 ? number : null;
}

const mmText = (emu) => (emu / EMU_PER_MM).toFixed(1);
const clip = (text) => Array.from(String(text == null ? '' : text)).slice(0, MAX_SHOWN_NAME).join('');

module.exports = { createImageImporter, displaySize, isAcceptableFileName, sniffMime, IMAGE_EXTENSIONS, EMU_PER_MM };
