/**
 * 图片归一化：把转档产生的位图统一转为 JPEG
 *
 * 契约：normalizeImages(doc, options) → Promise<{ doc, converted, kept, warnings }>
 *   - doc        处理后的 MarkFlowDocument；入参绝不就地改动，IR 按「改动路径才新建节点」的方式重建
 *   - converted  转为 JPEG 的资源数；kept 保持原格式的资源数（两者之和等于 doc.assets.length）
 *   - warnings   中文提示（string[]）：单图失败不抛错，一律降级为「保持原格式 + warning」
 *
 * 归一范围（按 mime 判定，不看扩展名；mime 缺失或为 application/octet-stream 时用魔数嗅探）：
 *   png / bmp / tiff / webp / 静态 gif → JPEG（压缩质量 options.jpegQuality，JFIF 密度 options.jpegPpi，默认 330 PPI；
 *                                        patent profile 下 jpegPpi 的默认值由 converters/options.js 调为 300）
 *   已是 JPEG                          → 不重编码、不告警，仅补写 JFIF 密度（缺 APP0 则插入），计入 kept
 *                                        —— docx 内嵌的 JPEG 多为 units=0、密度 1×1，不补写则阶段 2 的
 *                                        px × 25.4 / dpi 毫米换算失真；专利预检要求密度落在官方的 72–300 DPI。
 *                                        patent profile 下需重采样的 JPEG 例外：像素要变，故照常解码重编码，
 *                                        但仍按「格式未变」计入 kept
 *   svg / emf / wmf / 动图 gif / 未知 mime / 超体量护栏 / 解码失败 → 原样保留 + 中文 warning
 *   patent profile（options.xml.profile === 'patent'）下的 emf 由 assets/metafile-normalize.js 在串行主循环
 *   之前批量预处理：内置图元渲染器出 SVG → 只调用一次 Electron 栅格后端得 PNG → 铺白转 JPEG（详见该文件
 *   的文件头）。WMF 本版本不渲染；任一步失败都降级为 warning（不抛错，避免单张图元废掉整份转换）。
 *   其余 profile 的 emf/wmf 一律原样保留 + warning。
 *
 * patent profile 的显示尺寸重采样（对齐国知局「WORD 转 XML 编辑器」的实测行为）：
 *   官方对每幅图按其在 Word 中的显示尺寸在 300 DPI 下重采样，而非沿用嵌入像素——源图内嵌 981×569 的 PNG，
 *   wp:extent 为 146.46×72.16 mm 时官方输出 1730×852。本模块据 IR 上的 data.displayWidthMm /
 *   displayHeightMm（parsers/docx 写入）算目标像素：round(mm ÷ 25.4 × options.jpegPpi)，再写入同密度的
 *   JFIF，使下游 px × 25.4 ÷ dpi 能原样换回毫米。jpegPpi 取默认 300 时，17 幅实测样图与官方逐幅零像素偏差。
 *   仅 patent profile 生效，其余 profile 的像素与既有行为逐字节一致。
 *   降级（均保留嵌入像素并记 warning，不阻断转换）：IR 上取不到毫米显示尺寸（仅 DISPLAY_MM_SOURCES
 *   之内的来源才告警）；目标像素超出 MAX_RESAMPLE_PIXELS / MAX_RESAMPLE_EDGE 护栏。
 *
 * 处理次序与护栏（依据 R5 基准：本机 macOS + Node 22，20 张 4000×3000 带 alpha 的 PNG，
 * 单张源文件约 8.6 MB、解码后的 RGBA 位图 48 MB）：
 *   - 串行处理：默认 maxWidth=1600 时 20 张共 12.0 秒（单张均值 599 ms）、峰值 RSS 239 MB；
 *     patent 不缩放时共 26.3 秒（单张均值 1313 ms）、峰值 RSS 643 MB。峰值几乎全部来自单张位图与
 *     编码缓冲，并发解码会按并发数成倍放大，故逐张处理。
 *   - 宽度上限 options.raster.maxWidth（默认 1600）：耗时减半（1313 → 599 ms）、单张产物由 1.2 MB
 *     降至 0.3 MB、峰值 RSS 由 643 MB 降至 239 MB；patent profile 下禁用该上限（附图尺寸由显示尺寸
 *     重采样决定，不得再按宽度截断）。
 *   - 重采样护栏：目标像素数 > 4000 万或单边 > 20000 px 时不重采样、保留嵌入像素并记 warning。
 *     4000 万像素即 160 MB 的 RGBA 位图，仍在体量护栏（8000 万）之内；A4 幅面在 300 DPI 下约
 *     2480×3508 ≈ 870 万像素，护栏留出十余倍余量，正常语料不可能触发。
 *   - 体量护栏是「像素数 + 字节数」双阈值，任一命中才保留原图 + warning：像素数 > 8000 万
 *     （约 10000×8000）或字节数 > 200 MB。像素阈值按「解码后的 RGBA 位图 = 像素数 × 4 字节」定——
 *     8000 万像素即 320 MB 位图，叠加 jimp 的编码缓冲已逼近 GB 量级；字节阈值只用于拦畸形大文件
 *     （高压缩比的炸弹图、误当图片的大二进制）。两条阈值都远高于实际语料：本基准的 4000×3000 扫描图
 *     为 1200 万像素、8.6 MB，逐像素高熵时也仅 66 MB，必定走转码。
 *     像素尺寸由 image-size 按文件头读出（PNG IHDR、JPEG SOF、GIF / BMP / TIFF / WebP 头），不解码像素；
 *     读不出尺寸时只按字节数判，余下的交给解码器自行失败并降级为 warning。
 *   - 多页 TIFF 由解码器取首页（40×30 + 80×60 两页的 TIFF 解码得 40×30）；动图 GIF 不解码直接保留。
 *
 * IR 同步：renameMap（旧资产名 → 新资产名）改写全部 image 节点的 url（等于旧资产名者）与 data.assetName；
 * md 文档的 data.asset.buffer/mime/width/height 同步为 JPG 结果，absPath 保留并置 data.asset.normalized = true。
 *
 * 原图留存：凡字节被改动的资产（转码或只补密度）都带 original = { name, buffer, mime }（多次归一只记最初那份）。
 * restoreOriginals(doc) → doc：把带 original 的资产换回原图与原资产名，IR 中的 url / data.assetName /
 * data.asset 同步改回；没有可恢复的资产时原样返回同一引用。bundle 目标（images/ 须存原图）在「先解析后导出」
 * 路径上据此还原——桌面端预览先按无目标解析（已归一），导出 bundle 时再调用。
 *
 * converters/index.js 的 parseDocument 在 parser 之后、rasterizeNodes 之前经 moduleLoader 懒加载本模块。
 * 本模块顶层不得 require 重依赖：jimp 经 assets/jimp-loader.js 动态加载；图元预处理模块
 * assets/metafile-normalize（其下又懒加载 converters/metafile 与 raster/backend）与 converters/metafile
 * 本身都只在用到时 require；image-size 是纯文件头解析器（assets/md-images.js 已在顶层引用同一份），不在此列。
 */
const path = require('path');
const { imageSize } = require('image-size');
const { errText, toBuffer } = require('../util');
const { loadJimp } = require('./jimp-loader');

const JPEG_MIME = 'image/jpeg';
const JPEG_EXT = '.jpg';
const GIF_MIME = 'image/gif';
const OCTET_STREAM_MIME = 'application/octet-stream';

// 可归一为 JPEG 的位图 mime（gif 仅限静态，动图另行判定）
const CONVERTIBLE_MIMES = new Set(['image/png', 'image/bmp', 'image/x-ms-bmp', 'image/tiff', 'image/webp', GIF_MIME]);
// 矢量图：转位图会丢失可缩放性，保持原样
const VECTOR_MIMES = new Set(['image/svg+xml']);
// Windows 图元格式：仅 patent profile 下经内置图元渲染器（converters/metafile）栅格为 JPG，其余 profile 保持原样
const METAFILE_MIMES = new Set([
    'image/emf', 'image/x-emf', 'image/wmf', 'image/x-wmf',
    'application/emf', 'application/x-msmetafile', 'windows/metafile',
]);

// 体量护栏（双阈值，任一命中即保留原图）：像素数对应解码后的位图占用，字节数只拦畸形大文件
const MAX_ASSET_PIXELS = 80_000_000;
const MAX_ASSET_PIXELS_LABEL = '8000 万像素上限（约 10000×8000）';
const MAX_ASSET_BYTES = 200 * 1024 * 1024;
const MAX_ASSET_BYTES_LABEL = '200 MB';
const UNNAMED_LABEL = '(未命名图片)';
const DEFAULT_JPEG_QUALITY = 90;
const DEFAULT_JPEG_PPI = 330;

// patent profile 的显示尺寸重采样护栏：目标像素数与单边上限，任一超出即保留嵌入像素并告警
const MAX_RESAMPLE_PIXELS = 40_000_000;
const MAX_RESAMPLE_PIXELS_LABEL = '4000 万像素';
const MAX_RESAMPLE_EDGE = 20_000;
const INCH_MM = 25.4;
// 该资产未被任何 image 节点引用：不参与重采样，也不告警
const NO_RESAMPLE = Object.freeze({ size: null, warning: null });
// 会在 IR 上记下显示尺寸的来源；只有这些来源缺尺寸才值得告警——Markdown、PDF、网页本就没有
// 「文档中的显示尺寸」这一说，逐图报缺失是纯噪声。新增记录显示尺寸的 parser 时一并加入本表
const DISPLAY_MM_SOURCES = new Set(['docx']);

// 像素合成：8 位通道，255 为不透明 / 纯白
const CHANNEL_MAX = 255;
const RGBA_STRIDE = 4;
const ALPHA_OFFSET = 3;

// JFIF APP0 段：FF E0 + 长度(2) + "JFIF\0"(5) + 版本(2) + 单位(1) + X 密度(2) + Y 密度(2) + 缩略图宽高(2)
const JFIF_SEGMENT_BYTES = 18;
const JFIF_UNIT_INCH = 1;
const JFIF_IDENTIFIER = 'JFIF\x00';
const JFIF_UNITS_OFFSET = 11;
const JFIF_X_DENSITY_OFFSET = 12;
const JFIF_Y_DENSITY_OFFSET = 14;
const JFIF_MIN_DPI = 1;
const JFIF_MAX_DPI = 65535;

// 图元的处置文案（调研报告 4.7）：S3 的完整句式在本模块拼装，括号内的原因由 metafile-normalize 给出
const METAFILE_NON_PATENT_REASON = 'EMF/WMF 图元只在专利（patent）profile 下栅格化为 JPG';
const METAFILE_FAIL_TAIL = '。国知局只受理 JPG 与 TIF，请在 Word 中把该图另存为图片后替换';

// ============================================================
// 主流程
// ============================================================

async function normalizeImages(doc, options) {
    const assets = Array.isArray(doc && doc.assets) ? doc.assets : [];
    if (!doc || assets.length === 0 || !options || options.imageFormat !== 'jpg') {
        return { doc, converted: 0, kept: assets.length, warnings: [] };
    }

    const settings = readSettings(options, doc);
    // patent profile 才按显示尺寸重采样；其余 profile 传 undefined，走与既有行为逐字节一致的路径
    const displayMm = settings.isPatent ? collectDisplayMm(doc.ir) : null;
    // 图元预处理：patent profile 下收齐全部图元资产，只调用一次栅格后端（assets/metafile-normalize.js）
    const metafiles = settings.isPatent ? await prepareMetafiles(assets, settings, displayMm) : null;
    const warnings = [];
    const renameMap = new Map();
    const nextAssets = [];
    let converted = 0;
    // 已是 JPEG 的资源只补密度、不算「转换」，但其 buffer 同样变了，故另行记录是否需要重建 doc
    let changed = false;

    // 串行：单张大图解码后的位图占用可达数十 MB，并发会把内存峰值抬到不可控
    for (const asset of assets) {
        const result = await convertAsset(
            asset,
            settings,
            displayMm ? displayMm.get(asset.name) : undefined,
            metafiles ? metafiles.results.get(asset) : undefined,
        );
        if (result.warning) warnings.push(result.warning);
        if (!result.jpeg) {
            nextAssets.push(asset);
            continue;
        }
        const next = { ...asset, name: toJpegName(asset.name), buffer: result.jpeg, mime: JPEG_MIME, original: originalOf(asset) };
        nextAssets.push(next);
        changed = true;
        if (!result.keptFormat) converted += 1;
        if (typeof asset.name === 'string' && asset.name) {
            renameMap.set(asset.name, { ...next, width: result.width, height: result.height });
        }
    }

    // 整批级别的提示（图元汇总）排在逐图提示之后
    if (metafiles) warnings.push(...metafiles.warnings);

    if (!changed) return { doc, converted: 0, kept: assets.length, warnings };
    return {
        doc: { ...doc, assets: nextAssets, ir: rewriteNode(doc.ir, (node) => imagePatch(node, renameMap)) },
        converted,
        kept: assets.length - converted,
        warnings,
    };
}

// 原图只记最初那份：已归一过的资产再次归一时沿用它的 original
function originalOf(asset) {
    if (asset.original && toBuffer(asset.original.buffer)) return asset.original;
    return { name: asset.name, buffer: asset.buffer, mime: asset.mime };
}

// ============================================================
// 原图还原（bundle 目标）
// ============================================================

function restoreOriginals(doc) {
    const assets = Array.isArray(doc && doc.assets) ? doc.assets : [];
    const byCurrentName = new Map();
    let changed = false;
    const nextAssets = assets.map((asset) => {
        const original = asset && asset.original;
        if (!original || !toBuffer(original.buffer)) return asset;
        changed = true;
        const { original: _dropped, ...rest } = asset;
        const restored = {
            ...rest,
            name: typeof original.name === 'string' && original.name ? original.name : asset.name,
            buffer: toBuffer(original.buffer),
            mime: original.mime || asset.mime,
        };
        if (typeof asset.name === 'string' && asset.name) byCurrentName.set(asset.name, restored);
        return restored;
    });
    if (!changed) return doc;
    return { ...doc, assets: nextAssets, ir: rewriteNode(doc.ir, (node) => originalPatch(node, byCurrentName)) };
}

// image 节点改回原图：url / data.assetName 等于归一后资产名者换回原名，data.asset 换回原字节并重测尺寸
function originalPatch(node, byCurrentName) {
    const data = node.data && typeof node.data === 'object' ? node.data : null;
    const current = [data && data.assetName, node.url].find((name) => typeof name === 'string' && byCurrentName.has(name));
    if (current === undefined) return null;
    const restored = byCurrentName.get(current);
    const patch = {};
    if (node.url === current) patch.url = restored.name;
    const nextData = { ...(data || {}), assetName: restored.name };
    if (data && data.asset && typeof data.asset === 'object') {
        const { normalized: _normalized, ...asset } = data.asset;
        const size = readPixelSize(restored.buffer);
        nextData.asset = { ...asset, buffer: restored.buffer, mime: restored.mime, ...(size || {}) };
    }
    patch.data = nextData;
    return patch;
}

// 归一化用到的选项与来源快照；options 由 converters/options.js 归一并深冻结，此处仅做缺省兜底
function readSettings(options, doc) {
    const xml = (options && options.xml) || {};
    const patent = xml.patent || {};
    const raster = (options && options.raster) || {};
    const isPatent = xml.profile === 'patent';
    return {
        quality: numberOr(options && options.jpegQuality, DEFAULT_JPEG_QUALITY),
        ppi: numberOr(options && options.jpegPpi, DEFAULT_JPEG_PPI),
        // patent profile 下禁用宽度上限：附图像素由显示尺寸重采样决定，不得再按宽度截断
        maxWidth: isPatent ? 0 : numberOr(raster.maxWidth, 1600),
        isPatent,
        expectsDisplayMm: DISPLAY_MM_SOURCES.has((doc && doc.meta && doc.meta.sourceType) || ''),
    };
}

const numberOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/**
 * 单张资产 → { jpeg?, width?, height?, keptFormat?, warning? }；jpeg 缺省即表示保持原格式与原内容。
 * keptFormat 表示「格式本就是 JPEG」：buffer 变了（补密度，patent 下还可能重采样）但不计入 converted。
 * displayMm 三态：undefined 不参与重采样；null 参与但取不到显示尺寸（降级并告警）；{ width, height? } 为目标显示尺寸。
 * prepared 为该资产的图元预处理结果（只对图元资产有值），形态见 assets/metafile-normalize.js 的契约。
 */
async function convertAsset(asset, settings, displayMm, prepared) {
    const label = asset && typeof asset.name === 'string' && asset.name ? asset.name : UNNAMED_LABEL;
    const buffer = toBuffer(asset && asset.buffer);
    if (!buffer || buffer.length === 0) return { warning: keepText(label, '资源内容为空') };

    const mime = resolveMime(asset, buffer);
    const resample = planResample(buffer, displayMm, label, settings);
    const oversize = oversizeReason(buffer);
    // 像素不动的 JPEG：只补密度，故不返回 width/height，避免把 data.asset 上已测得的尺寸覆盖掉。
    // 体量超护栏的 JPEG 也走这条——解不动的图宁可只改密度，也好过连密度一起丢掉
    if (mime === JPEG_MIME && (!resample.size || oversize)) {
        const note = oversize && resample.size ? skipResampleText(label, oversize) : resample.warning;
        return withNote({ jpeg: setJpegDensity(buffer, settings.ppi), keptFormat: true }, note);
    }
    if (oversize) return { warning: keepText(label, oversize) };
    if (mime !== JPEG_MIME) {
        // 图元的目标像素由预处理自行计算（含 frame 毫米回落），故不沿用 resample 的计划与提示
        if (METAFILE_MIMES.has(mime)) return metafileResult(prepared, label, settings);
        if (VECTOR_MIMES.has(mime)) return { warning: keepText(label, '矢量图 SVG 转位图会丢失可缩放性') };
        if (!CONVERTIBLE_MIMES.has(mime)) return { warning: keepText(label, `不支持的图片类型 ${mime || '未知'}`) };
        if (mime === GIF_MIME && isAnimatedGif(buffer)) return { warning: keepText(label, '动图 GIF 转 JPEG 会丢失动画') };
    }

    try {
        const encoded = await encodeJpeg(buffer, settings, resample.size);
        return withNote(mime === JPEG_MIME ? { ...encoded, keptFormat: true } : encoded, resample.warning);
    } catch (err) {
        return { warning: keepText(label, `解码或编码失败（${errText(err)}）`) };
    }
}

// 重采样降级提示只在真出了图、且没有更要紧的 warning 时附上（一条资产只报一条）
const withNote = (result, note) => (note && result.jpeg && !result.warning ? { ...result, warning: note } : result);

const keepText = (label, reason) => `图片 ${label} 保持原格式：${reason}`;
const skipResampleText = (label, reason) => `图片 ${label} 未按 Word 显示尺寸重采样：${reason}，已按嵌入像素输出`;

// mime 优先取资产自带值，缺失或为通用二进制时用魔数嗅探
function resolveMime(asset, buffer) {
    const declared = String((asset && asset.mime) || '').split(';')[0].trim().toLowerCase();
    if (declared && declared !== OCTET_STREAM_MIME) return declared === 'image/jpg' ? JPEG_MIME : declared;
    return sniffImageMime(buffer) || declared;
}

/**
 * 体量护栏：先判字节数（零成本），再按文件头判像素数；两者都不超即返回 null 表示可以解码。
 * 命中时返回中文原因（含实际值），由调用方拼进 warning。
 */
function oversizeReason(buffer) {
    if (buffer.length > MAX_ASSET_BYTES) {
        return `单图 ${mbText(buffer.length)} 超过 ${MAX_ASSET_BYTES_LABEL} 上限`;
    }
    const size = readPixelSize(buffer);
    if (size && size.width * size.height > MAX_ASSET_PIXELS) {
        return `单图 ${size.width}×${size.height} 超过 ${MAX_ASSET_PIXELS_LABEL}`;
    }
    return null;
}

// image-size 只解析文件头（PNG IHDR、JPEG SOF、GIF / BMP / TIFF / WebP 头），不解码像素；
// 格式不识别或文件头残缺时抛错，此处一律按「尺寸未知」处理，只让字节阈值生效
function readPixelSize(buffer) {
    try {
        const { width, height } = imageSize(buffer);
        return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
            ? { width, height }
            : null;
    } catch (err) {
        return null;
    }
}

const mbText = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function encodeJpeg(buffer, settings, resample) {
    const { Jimp } = await loadJimp();
    // 多页 TIFF 由解码器取首页；动图 GIF 在调用前已被拦下
    const image = await Jimp.read(buffer);
    // 先铺白再缩放：带 alpha 的像素若先参与插值，透明区会把邻近像素拖暗
    flattenOnWhite(image.bitmap);
    if (resample) {
        // 高度缺省时只给宽度，由 jimp 按原始宽高比补齐
        image.resize(resample.height >= 1 ? { w: resample.width, h: resample.height } : { w: resample.width });
    } else if (settings.maxWidth > 0 && image.width > settings.maxWidth) {
        image.resize({ w: settings.maxWidth });
    }
    const encoded = await image.getBuffer(JPEG_MIME, { quality: settings.quality });
    return { jpeg: setJpegDensity(encoded, settings.ppi), width: image.width, height: image.height };
}

// ============================================================
// 显示尺寸重采样（仅 patent profile）
// ============================================================

/**
 * IR 上的 image 节点 → Map<资产名, { width, height } | null>（毫米）。
 * 值为 null 表示该资产有 image 节点但节点上没有毫米显示尺寸；不在表内表示压根没有 image 节点引用它。
 * 同名资产被多个节点引用时，带尺寸的那条优先。
 */
function collectDisplayMm(node, into = new Map()) {
    if (Array.isArray(node)) {
        for (const item of node) collectDisplayMm(item, into);
        return into;
    }
    if (!node || typeof node !== 'object') return into;
    if (node.type === 'image') {
        const data = node.data && typeof node.data === 'object' ? node.data : {};
        const name = [data.assetName, node.url].find((value) => typeof value === 'string' && value);
        const size = displayMmOf(data);
        if (name && (!into.has(name) || (size && !into.get(name)))) into.set(name, size);
    }
    if (Array.isArray(node.children)) collectDisplayMm(node.children, into);
    return into;
}

// 宽度是必需项：只有高度无法定幅面。高度缺省时留 0，由 encodeJpeg 按原图宽高比补齐
function displayMmOf(data) {
    const width = Number(data.displayWidthMm);
    if (!Number.isFinite(width) || width <= 0) return null;
    const height = Number(data.displayHeightMm);
    return { width, height: Number.isFinite(height) && height > 0 ? height : 0 };
}

/**
 * 重采样计划 → { size: { width, height } | null, warning: string | null }。
 * 目标像素 = round(毫米 ÷ 25.4 × settings.ppi)，与随后写入的 JFIF 密度同源，使下游能原样换回毫米。
 */
function planResample(buffer, displayMm, label, settings) {
    if (displayMm === undefined) return NO_RESAMPLE;
    if (displayMm === null) {
        // 来源本就不带显示尺寸（md / pdf / 网页）时不告警，否则每张图都要报一条噪声
        return settings.expectsDisplayMm
            ? { size: null, warning: skipResampleText(label, '源文档中未记录该图的显示尺寸') }
            : NO_RESAMPLE;
    }

    const width = mmToPx(displayMm.width, settings.ppi);
    const height = displayMm.height > 0 ? mmToPx(displayMm.height, settings.ppi) : 0;
    const source = readPixelSize(buffer);
    // 只给宽度时按原图宽高比估出高度，护栏与「尺寸已一致」的判定都按估值来
    const estimated = height >= 1 || !source ? height : Math.max(1, Math.round((width * source.height) / source.width));
    const oversize = resampleOversizeReason(width, estimated);
    if (oversize) return { size: null, warning: skipResampleText(label, oversize) };
    if (source && source.width === width && (estimated < 1 || source.height === estimated)) return NO_RESAMPLE;
    return { size: { width, height }, warning: null };
}

const mmToPx = (mm, ppi) => Math.max(1, Math.round((mm / INCH_MM) * ppi));

function resampleOversizeReason(width, height) {
    if (width > MAX_RESAMPLE_EDGE || height > MAX_RESAMPLE_EDGE) {
        return `目标 ${width}×${height || '?'} 的单边超过 ${MAX_RESAMPLE_EDGE} px 上限`;
    }
    if (height >= 1 && width * height > MAX_RESAMPLE_PIXELS) {
        return `目标 ${width}×${height} 超过 ${MAX_RESAMPLE_PIXELS_LABEL}上限`;
    }
    return null;
}

/** 透明像素与白底合成（JPEG 无 alpha 通道，不铺白会让透明区变黑） */
function flattenOnWhite(bitmap) {
    const data = bitmap && bitmap.data;
    if (!data || typeof data.length !== 'number') return;
    for (let i = 0; i + ALPHA_OFFSET < data.length; i += RGBA_STRIDE) {
        const alpha = data[i + ALPHA_OFFSET];
        if (alpha === CHANNEL_MAX) continue;
        const inverse = CHANNEL_MAX - alpha;
        data[i] = blendOnWhite(data[i], alpha, inverse);
        data[i + 1] = blendOnWhite(data[i + 1], alpha, inverse);
        data[i + 2] = blendOnWhite(data[i + 2], alpha, inverse);
        data[i + ALPHA_OFFSET] = CHANNEL_MAX;
    }
}

// 非预乘 alpha 的 over 合成：(src × a + 255 × (255 - a)) / 255，四舍五入
const blendOnWhite = (channel, alpha, inverse) =>
    ((channel * alpha + CHANNEL_MAX * inverse + (CHANNEL_MAX >> 1)) / CHANNEL_MAX) | 0;

// ============================================================
// EMF / WMF（仅 patent profile）
// ============================================================

/**
 * 图元批量预处理 → { results: Map<asset, outcome>, warnings }；本文档没有图元资产时返回 null。
 * 预处理整体异常不得中断归一化：各图元资产退回「保持原格式 + 告警」，其余资产不受影响。
 */
async function prepareMetafiles(assets, settings, displayMm) {
    const items = collectMetafileItems(assets);
    if (items.length === 0) return null;
    try {
        return await require('./metafile-normalize').rasterizeMetafiles(items, { settings, displayMm });
    } catch (err) {
        const failReason = `图元预处理异常：${errText(err)}`;
        return { results: new Map(items.map((item) => [item.asset, { failReason }])), warnings: [] };
    }
}

/** 参与预处理的资产：mime（缺失时按魔数）判定为图元、内容非空、未被体量护栏拦下 */
function collectMetafileItems(assets) {
    const items = [];
    for (const asset of assets) {
        const buffer = toBuffer(asset && asset.buffer);
        if (!buffer || buffer.length === 0) continue;
        if (!METAFILE_MIMES.has(resolveMime(asset, buffer))) continue;
        // 体量超护栏的资产由主循环统一告警，不进批次
        if (oversizeReason(buffer)) continue;
        items.push({ asset, buffer });
    }
    return items;
}

/** 图元资产的处置：patent 下取预处理结果，其余 profile 一律保持原格式并告警 */
function metafileResult(prepared, label, settings) {
    if (!settings.isPatent) return { warning: keepText(label, METAFILE_NON_PATENT_REASON) };
    const outcome = prepared || { failReason: '图元预处理未产出结果' };
    if (!outcome.jpeg) return { warning: keepText(label, metafileFailReason(outcome.failReason)) };
    return { jpeg: outcome.jpeg, width: outcome.width, height: outcome.height, warning: outcome.note || null };
}

const metafileFailReason = (reason) => `EMF/WMF 图元渲染失败（${reason}）${METAFILE_FAIL_TAIL}`;

// ============================================================
// 资产名与 IR 同步
// ============================================================

// images/image_3.png → images/image_3.jpg（编号不变）
function toJpegName(name) {
    const text = typeof name === 'string' ? name : '';
    if (!text) return `image${JPEG_EXT}`;
    const ext = path.posix.extname(text);
    return `${ext ? text.slice(0, text.length - ext.length) : text}${JPEG_EXT}`;
}

// 只在子树确有改动时新建节点，未触及的分支沿用原引用（入参 IR 不被改动）；
// patchImage(imageNode) 返回要合并的字段，或 null 表示不改
function rewriteNode(node, patchImage) {
    if (Array.isArray(node)) return rewriteList(node, patchImage);
    if (!node || typeof node !== 'object') return node;

    let next = node;
    if (node.type === 'image') {
        const patch = patchImage(node);
        if (patch) next = { ...node, ...patch };
    }
    if (Array.isArray(next.children)) {
        const children = rewriteList(next.children, patchImage);
        if (children !== next.children) next = { ...next, children };
    }
    return next;
}

function rewriteList(list, patchImage) {
    const mapped = list.map((item) => rewriteNode(item, patchImage));
    return mapped.some((item, index) => item !== list[index]) ? mapped : list;
}

// image 节点的改写：url 仅在等于旧资产名时改写；data.assetName 同理；md 的 data.asset 同步为 JPG
function imagePatch(node, renameMap) {
    const data = node.data && typeof node.data === 'object' ? node.data : null;
    const oldName = [data && data.assetName, node.url].find((name) => typeof name === 'string' && renameMap.has(name));
    if (oldName === undefined) return null;

    const entry = renameMap.get(oldName);
    const patch = {};
    if (node.url === oldName) patch.url = entry.name;

    const nextData = { ...(data || {}), assetName: entry.name };
    if (data && data.asset && typeof data.asset === 'object') {
        // 只补密度的 JPEG 不带新尺寸，此时沿用 data.asset 上已测得的 width/height，不置为 undefined
        nextData.asset = { ...data.asset, buffer: entry.buffer, mime: entry.mime, normalized: true };
        if (Number.isFinite(entry.width)) nextData.asset.width = entry.width;
        if (Number.isFinite(entry.height)) nextData.asset.height = entry.height;
    }
    patch.data = nextData;
    return patch;
}

// ============================================================
// JPEG JFIF 密度
// ============================================================

/**
 * 写入 JFIF APP0 的密度（单位=每英寸，X/Y 密度 = dpi）。
 * jimp 输出的 JPEG 其 APP0 单位固定为 0（无单位）、密度 1×1，专利递交要求 72–300 DPI，故须补丁。
 * 返回新 Buffer；无 APP0 时在 SOI 之后插入一段标准 APP0；非 JPEG 原样返回。
 */
function setJpegDensity(buffer, dpi) {
    const buf = toBuffer(buffer);
    if (!buf || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return buf;
    const density = clampDensity(dpi);

    const at = findJfifApp0(buf);
    if (at < 0) return Buffer.concat([buf.subarray(0, 2), buildJfifApp0(density), buf.subarray(2)]);

    const out = Buffer.from(buf);
    out[at + JFIF_UNITS_OFFSET] = JFIF_UNIT_INCH;
    out.writeUInt16BE(density, at + JFIF_X_DENSITY_OFFSET);
    out.writeUInt16BE(density, at + JFIF_Y_DENSITY_OFFSET);
    return out;
}

function clampDensity(dpi) {
    const value = Math.round(Number(dpi));
    if (!Number.isFinite(value)) return 300;
    return Math.min(JFIF_MAX_DPI, Math.max(JFIF_MIN_DPI, value));
}

// 逐段扫描，遇到 SOS(FFDA) 或非法标记即停；返回 APP0 段的起始下标，未找到返回 -1
function findJfifApp0(buf) {
    let at = 2;
    while (at + 4 <= buf.length) {
        if (buf[at] !== 0xFF) return -1;
        const marker = buf[at + 1];
        if (marker === 0xD8 || marker === 0xD9 || marker === 0xDA) return -1;
        const length = buf.readUInt16BE(at + 2);
        if (length < 2 || at + 2 + length > buf.length) return -1;
        if (marker === 0xE0 && length >= JFIF_SEGMENT_BYTES - 2
            && buf.subarray(at + 4, at + 9).toString('latin1') === JFIF_IDENTIFIER) {
            return at;
        }
        at += 2 + length;
    }
    return -1;
}

function buildJfifApp0(density) {
    const segment = Buffer.alloc(JFIF_SEGMENT_BYTES);
    segment.writeUInt16BE(0xFFE0, 0);
    segment.writeUInt16BE(JFIF_SEGMENT_BYTES - 2, 2);
    segment.write(JFIF_IDENTIFIER, 4, 'latin1');
    segment[9] = 1;
    segment[10] = 1;
    segment[JFIF_UNITS_OFFSET] = JFIF_UNIT_INCH;
    segment.writeUInt16BE(density, JFIF_X_DENSITY_OFFSET);
    segment.writeUInt16BE(density, JFIF_Y_DENSITY_OFFSET);
    return segment;
}

// ============================================================
// 魔数嗅探与动图判定
// ============================================================

const SVG_PROBE_BYTES = 1024;
const SVG_TAG_RE = /<svg[\s/>]/i;

/** 魔数嗅探：返回 mime 字符串，识别不出返回 null */
function sniffImageMime(buffer) {
    const buf = toBuffer(buffer);
    if (!buf || buf.length < 4) return null;
    if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504E47 && buf.readUInt32BE(4) === 0x0D0A1A0A) return 'image/png';
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return JPEG_MIME;
    if (isGifSignature(buf)) return GIF_MIME;
    if (buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp';
    if (buf.readUInt32BE(0) === 0x49492A00 || buf.readUInt32BE(0) === 0x4D4D002A) return 'image/tiff';
    if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF'
        && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    const metafile = sniffMetafileMime(buf);
    if (metafile) return metafile;
    if (SVG_TAG_RE.test(buf.subarray(0, SVG_PROBE_BYTES).toString('utf8'))) return 'image/svg+xml';
    return null;
}

/**
 * EMF／WMF 魔数：复用图元模块的 sniffMetafile（EMF 为首 4 字节 01 00 00 00 且偏移 40 处为 ' EMF'），
 * 覆盖资产 mime 缺失或为 application/octet-stream 的情形。图元模块在此才 require，且失败一律按未识别处理。
 */
function sniffMetafileMime(buf) {
    try {
        const format = require('../metafile').sniffMetafile(buf);
        if (format === null) return null;
        return format === 'emf' ? 'image/x-emf' : 'image/x-wmf';
    } catch (err) {
        return null;
    }
}

const isGifSignature = (buf) => buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString('latin1'));

/**
 * 动图判定：按 GIF 块结构逐块前进，统计图形控制扩展（0x21 0xF9）的个数，多于一个即为动图。
 * 结构异常时退回整段字节扫描（宁可误判为动图而保持原样，也不要把动画转成单帧 JPEG）。
 */
function isAnimatedGif(buffer) {
    const buf = toBuffer(buffer);
    if (!buf || !isGifSignature(buf)) return false;
    const counted = countGraphicControlBlocks(buf);
    return (counted === null ? scanGraphicControlBlocks(buf) : counted) > 1;
}

// 逻辑屏幕描述符 7 字节（下标 6–12），其 packed 字节的最高位表示存在全局颜色表
const GIF_PACKED_OFFSET = 10;
const GIF_BLOCKS_OFFSET = 13;
const GIF_COLOR_TABLE_FLAG = 0x80;
const GIF_COLOR_TABLE_SIZE_MASK = 0x07;
const GIF_EXTENSION = 0x21;
const GIF_GRAPHIC_CONTROL = 0xF9;
const GIF_IMAGE_DESCRIPTOR = 0x2C;
const GIF_TRAILER = 0x3B;
const GIF_IMAGE_DESCRIPTOR_BYTES = 10;

// 返回 GCE 块数；结构不可解析时返回 null
function countGraphicControlBlocks(buf) {
    let at = GIF_BLOCKS_OFFSET + colorTableBytes(buf[GIF_PACKED_OFFSET]);
    let count = 0;
    while (at < buf.length) {
        const kind = buf[at];
        if (kind === GIF_TRAILER) return count;
        if (kind === GIF_EXTENSION) {
            if (buf[at + 1] === GIF_GRAPHIC_CONTROL) count += 1;
            at = skipSubBlocks(buf, at + 2);
        } else if (kind === GIF_IMAGE_DESCRIPTOR) {
            const after = at + GIF_IMAGE_DESCRIPTOR_BYTES;
            at = skipSubBlocks(buf, after + colorTableBytes(buf[after - 1]) + 1);
        } else {
            return null;
        }
        if (at < 0) return null;
    }
    return count;
}

const colorTableBytes = (packed) =>
    ((packed & GIF_COLOR_TABLE_FLAG) ? 3 * (2 ** ((packed & GIF_COLOR_TABLE_SIZE_MASK) + 1)) : 0);

// 跳过以 0 长度块结尾的子块链；越界返回 -1
function skipSubBlocks(buf, start) {
    let at = start;
    while (at < buf.length) {
        const size = buf[at];
        at += 1;
        if (size === 0) return at;
        at += size;
    }
    return -1;
}

function scanGraphicControlBlocks(buf) {
    let count = 0;
    for (let at = 0; at + 1 < buf.length; at += 1) {
        if (buf[at] === GIF_EXTENSION && buf[at + 1] === GIF_GRAPHIC_CONTROL) count += 1;
    }
    return count;
}

module.exports = { normalizeImages, restoreOriginals, isAnimatedGif, setJpegDensity, sniffImageMime };
