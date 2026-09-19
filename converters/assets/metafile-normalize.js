'use strict';
/**
 * 图元批量预处理（只在 patent profile 下由 assets/image-normalize.js 调用）
 *
 * 契约：rasterizeMetafiles(items, { settings, displayMm }) → Promise<{ results, warnings }>
 *   - items      [{ asset, buffer }]：调用方按 mime（或魔数）判定为 EMF／WMF 的全部资产，非空 buffer
 *   - settings   image-normalize 的 readSettings 快照，本模块只用 quality（JPEG 质量）与 ppi（JFIF 密度）
 *   - displayMm  Map<资产名, { width, height } | null>（毫米）；缺键表示没有 image 节点引用该资产
 *   - results    Map<asset 对象, outcome>，逐个入参资产各有一条；键用资产对象而非资产名，避免重名资产互相覆盖
 *                outcome = { jpeg, width, height, note } 出图成功（note 为该图的中文提示，可为 null）
 *                        | { failReason }              保持原格式，failReason 为中文原因（不含句式外壳）
 *   - warnings   整批级别的中文提示（S0 汇总），逐图提示一律经 outcome.note 交调用方
 *
 * 数据流（调研报告 4.1）：扫描（sniffMetafile / inspectMetafile）→ 目标像素 → metafileToSvg →
 *   raster/svg-fragment 片段页 → 只调用一次 raster/backend.rasterize(jobs, { dpi: 96 }) → 尺寸与墨量
 *   自检 → jimp 铺白 + JPEG + JFIF 密度。同一份转换内「字节哈希 + 目标像素」相同的图元只出一次图，
 *   结果分发给各资产。
 *
 * 目标像素：round(显示毫米 ÷ 25.4 × settings.ppi)。显示毫米优先取 IR 上的 displayWidthMm／
 *   displayHeightMm；取不到（例如 VML 承载的 OLE 预览图）时退回 inspectMetafile 的 header.frameMm
 *   并告警。超出像素护栏时按比例缩小并告警。
 *
 * 双流互校（调研报告 4.7）：EmfPlusHeader 的 D 位为真的图元多出一个 stream: 'classic' 的栅格作业，
 *   比较两张图的非白像素数；EMF+ 路径的墨量不足经典路径的 DUAL_INK_RATIO 时改用经典路径出图并告警，
 *   其余情形以 auto 为准、不告警。
 *
 * 失败隔离：单个资产（或单个去重组）的任何失败都只落为该资产的 failReason，其余资产与整份转换不受影响；
 *   本模块不抛出业务错误。S3 的完整句式由 image-normalize.js 拼装，本模块只给出括号内的原因。
 *
 * 顶层不 require 重依赖：converters/metafile 与 raster/backend 在用到时才 require（前者虽轻，也保持
 *   一致写法），jimp 经 assets/jimp-loader.js 动态加载；image-size 是纯文件头解析器，不在此列。
 *   本模块 require 同目录的 image-normalize 只为取 setJpegDensity（与 raster/rasterize-nodes.js 相同），
 *   而 image-normalize 对本模块的 require 发生在函数体内，故两者不构成加载期循环。
 */
const crypto = require('crypto');
const { imageSize } = require('image-size');
const { errText } = require('../util');
const { loadJimp } = require('./jimp-loader');
const { setJpegDensity } = require('./image-normalize');
const { buildSvgImageFragment, MAX_EDGE_PX } = require('../raster/svg-fragment');

const JPEG_MIME = 'image/jpeg';
const UNNAMED_LABEL = '(未命名图片)';
const INCH_MM = 25.4;
/** 以 96 DPI 出图即 scale = 1，PNG 像素恒等于片段页里 <img> 的 CSS 像素 */
const RENDER_DPI = 96;
/** 目标像素护栏：总量与 image-normalize.js 的 MAX_RESAMPLE_PIXELS 同值；单边取片段页的 MAX_EDGE_PX
 *  （即工作进程的 16000，比重采样护栏的 20000 更严），两处必须同值，故直接引用而不另设常量 */
const MAX_TARGET_PIXELS = 40_000_000;
const MAX_TARGET_PIXELS_LABEL = '4000 万像素';
/** 双流互校阈值：EMF+ 路径的非白像素数不足经典路径的该比例时，判为漏画并改用经典路径出图 */
const DUAL_INK_RATIO = 0.9;
/** 告警里最多列出几类未支持记录，其余折叠为「等 N 类」 */
const MAX_LISTED_RECORDS = 5;
/** 去重键里字节哈希的截取长度（64 位，足以区分同一份文档内的图元） */
const HASH_HEX_CHARS = 16;

/** 像素合成：8 位通道，255 为纯白 */
const CHANNEL_MAX = 255;
const RGBA_STRIDE = 4;
const WHITE = 0xffffffff;

// ============================================================
// 主流程
// ============================================================

async function rasterizeMetafiles(items, { settings, displayMm } = {}) {
    const results = new Map();
    const plans = (Array.isArray(items) ? items : []).map((item) => planMetafile(item, settings, displayMm));
    const groups = groupPlans(plans.filter((plan) => !plan.failReason));
    for (const plan of plans) {
        if (plan.failReason) results.set(plan.asset, { failReason: plan.failReason });
    }

    const jobs = [];
    for (const group of groups) buildGroupJobs(group, jobs);
    const rendered = await renderJobs(jobs);
    // 串行：单张位图解码后可达数十 MB，并发会把内存峰值按并发数成倍放大
    for (const group of groups) await finishGroup(group, rendered, settings, results);

    const converted = [...results.values()].filter((outcome) => outcome.jpeg).length;
    return { results, warnings: converted > 0 ? [summaryText(converted)] : [] };
}

/**
 * 后端探测与唯一一次 rasterize → { images, failReason }。
 * failReason 非空即整批失败（后端不可用或 rasterize 抛错），由各组共用同一条原因降级。
 */
async function renderJobs(jobs) {
    if (jobs.length === 0) return { images: new Map(), failReason: null };
    const backend = require('../raster/backend');
    const detected = await backend.detect();
    if (!detected.available) return { images: new Map(), failReason: `栅格化后端不可用：${detected.hint}` };
    try {
        return { images: await backend.rasterize(jobs, { dpi: RENDER_DPI }), failReason: null };
    } catch (error) {
        return { images: new Map(), failReason: `栅格化失败：${errText(error)}` };
    }
}

// ============================================================
// 先扫描、后渲染
// ============================================================

/** 单个资产的扫描与出图计划；任一步失败即给出 failReason，该资产保持原格式 */
function planMetafile({ asset, buffer }, settings, displayMm) {
    const label = assetLabel(asset);
    const metafile = require('../metafile');
    const format = metafile.sniffMetafile(buffer);
    if (format === null) return { asset, label, failReason: '文件不是 EMF/WMF 图元（魔数不符）' };
    if (format !== 'emf') return { asset, label, failReason: '文件是 WMF 图元，本版本只能渲染 EMF' };

    let inspected;
    try {
        inspected = metafile.inspectMetafile(buffer);
    } catch (error) {
        return { asset, label, failReason: `扫描失败：${errText(error)}` };
    }

    const sizing = planSize(inspected, displayMm ? displayMm.get(asset.name) : undefined, settings);
    if (sizing.failReason) return { asset, label, failReason: sizing.failReason };
    return {
        asset,
        label,
        buffer,
        size: sizing.size,
        dual: Boolean(inspected.plus && inspected.plus.dual),
        key: `${hashOf(buffer)}-${sizing.size.width}x${sizing.size.height}`,
        unsupportedNote: unsupportedNote(label, inspected.unsupported),
        scaleNote: sizing.reason ? scaleText(label, sizing.reason, sizing.size) : null,
        frameNote: sizing.fromFrame ? frameText(label, sizing.mm) : null,
    };
}

/** 目标像素 = round(显示毫米 ÷ 25.4 × ppi)，超护栏时按比例缩小 */
function planSize(inspected, given, settings) {
    const mm = pickDisplayMm(given, inspected.header.frameMm);
    if (!mm) return { failReason: '无法确定出图尺寸（源文档未记录显示尺寸，图元自身也没有幅面）' };
    if (!isPositive(settings && settings.ppi)) return { failReason: 'JPEG 密度选项非法，无法确定目标像素' };
    const wanted = { width: mmToPx(mm.width, settings.ppi), height: mmToPx(mm.height, settings.ppi) };
    return { ...capSize(wanted), mm, fromFrame: mm.fromFrame };
}

/**
 * 显示毫米的取用次序：IR 的宽高 → IR 只有宽度时按图元幅面补高 → 图元自身的 frame 毫米（fromFrame）。
 * 三者都取不到时返回 null。
 */
function pickDisplayMm(given, frame) {
    const frameOk = isPositive(frame && frame.width) && isPositive(frame && frame.height);
    if (given && isPositive(given.width)) {
        if (isPositive(given.height)) return { width: given.width, height: given.height, fromFrame: false };
        if (!frameOk) return null;
        return { width: given.width, height: (given.width * frame.height) / frame.width, fromFrame: false };
    }
    if (!frameOk) return null;
    return { width: frame.width, height: frame.height, fromFrame: true };
}

/** 像素护栏：单边与总量任一超出即按比例缩小，并给出中文原因 */
function capSize(size) {
    const edge = Math.max(size.width, size.height);
    const pixels = size.width * size.height;
    if (edge <= MAX_EDGE_PX && pixels <= MAX_TARGET_PIXELS) return { size, reason: null };
    const factor = Math.min(MAX_EDGE_PX / edge, Math.sqrt(MAX_TARGET_PIXELS / pixels));
    const next = {
        width: Math.max(1, Math.floor(size.width * factor)),
        height: Math.max(1, Math.floor(size.height * factor)),
    };
    const limit = edge > MAX_EDGE_PX ? `单边 ${MAX_EDGE_PX} px 的上限` : `${MAX_TARGET_PIXELS_LABEL}的上限`;
    return { size: next, reason: `目标 ${size.width}×${size.height} 超过${limit}` };
}

const mmToPx = (mm, ppi) => Math.max(1, Math.round((mm / INCH_MM) * ppi));
const isPositive = (value) => Number.isFinite(value) && value > 0;
const hashOf = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex').slice(0, HASH_HEX_CHARS);
const assetLabel = (asset) => (asset && typeof asset.name === 'string' && asset.name ? asset.name : UNNAMED_LABEL);

// ============================================================
// 去重与片段页
// ============================================================

/** 内容与目标像素都相同的图元并为一组，只出一次图 */
function groupPlans(plans) {
    const byKey = new Map();
    for (const plan of plans) {
        const known = byKey.get(plan.key);
        if (known) { known.members.push(plan); continue; }
        byKey.set(plan.key, { id: `emf-${byKey.size + 1}`, plan, members: [plan], classicId: null });
    }
    return [...byKey.values()];
}

/** 一组图元 → 一个（Dual 时两个）栅格作业；转换失败即整组降级 */
function buildGroupJobs(group, jobs) {
    const { buffer, size } = group.plan;
    const metafile = require('../metafile');
    try {
        const primary = metafile.metafileToSvg(buffer, { ...size, stream: 'auto' });
        group.expectsInk = primary.diagnostics.shapes > 0 || primary.diagnostics.text > 0;
        jobs.push({ id: group.id, html: buildSvgImageFragment(primary.svg, size) });
    } catch (error) {
        group.failReason = `转换失败：${errText(error)}`;
        return;
    }
    if (!group.plan.dual) return;
    // 互校作业失败不影响出图：拿不到经典路径的图就跳过互校
    try {
        const classic = metafile.metafileToSvg(buffer, { ...size, stream: 'classic' });
        group.classicId = `${group.id}c`;
        jobs.push({ id: group.classicId, html: buildSvgImageFragment(classic.svg, size) });
    } catch (error) {
        group.classicId = null;
    }
}

// ============================================================
// 自检与出图
// ============================================================

/** 取图 → 尺寸自检 → 双流互校 → 空白自检 → JPEG；结果按组内各资产分发 */
async function finishGroup(group, rendered, settings, results) {
    const failReason = group.failReason || rendered.failReason;
    const outcome = failReason ? { failReason } : await renderGroup(group, rendered.images, settings);
    for (const plan of group.members) {
        if (outcome.failReason) { results.set(plan.asset, { failReason: outcome.failReason }); continue; }
        // 一条资产只报一条提示，按要紧程度取第一条
        const dualNote = outcome.dual ? dualText(plan.label, outcome.dual.plusInk, outcome.dual.classicInk) : null;
        const note = plan.unsupportedNote || dualNote || plan.scaleNote || plan.frameNote || null;
        results.set(plan.asset, { jpeg: outcome.jpeg, width: outcome.width, height: outcome.height, note });
    }
}

async function renderGroup(group, images, settings) {
    const { size } = group.plan;
    const primary = takePng(images.get(group.id), size);
    if (primary.failReason) return primary;
    try {
        const shot = await measurePng(primary.png);
        const cross = await crossCheck(group, images, shot);
        if (group.expectsInk && cross.shot.ink === 0) {
            return { failReason: '出图为空白，但扫描显示该图元含绘图记录' };
        }
        const jpeg = await encodeJpeg(cross.shot.image, settings);
        return { jpeg, width: size.width, height: size.height, dual: cross.dual };
    } catch (error) {
        return { failReason: `出图处理失败：${errText(error)}` };
    }
}

/** 双流互校：EMF+ 路径墨量不足经典路径的 DUAL_INK_RATIO 时改用经典路径 */
async function crossCheck(group, images, shot) {
    if (!group.classicId) return { shot, dual: null };
    const classic = takePng(images.get(group.classicId), group.plan.size);
    if (classic.failReason) return { shot, dual: null };
    const other = await measurePng(classic.png);
    if (shot.ink >= other.ink * DUAL_INK_RATIO) return { shot, dual: null };
    return { shot: other, dual: { plusInk: shot.ink, classicInk: other.ink } };
}

/** 后端产物取用与尺寸自检：PNG 像素必须等于目标像素 */
function takePng(value, size) {
    if (!Buffer.isBuffer(value)) {
        return { failReason: `后端未出图：${value instanceof Error ? value.message : '后端未返回图像'}` };
    }
    const actual = pngSize(value);
    if (!actual) return { failReason: '后端产物不是可解析的 PNG' };
    if (actual.width !== size.width || actual.height !== size.height) {
        return { failReason: `出图尺寸 ${actual.width}×${actual.height} 与目标 ${size.width}×${size.height} 不符` };
    }
    return { png: value };
}

// image-size 只读 PNG 的 IHDR，不解码像素
function pngSize(buffer) {
    try {
        const { width, height } = imageSize(buffer);
        return isPositive(width) && isPositive(height) ? { width, height } : null;
    } catch (error) {
        return null;
    }
}

/** 解码一次，同时得到铺白后的位图与非白像素数（后端出图本就不透明，铺白只是兜底） */
async function measurePng(png) {
    const { Jimp } = await loadJimp();
    const decoded = await Jimp.read(png);
    const flat = new Jimp({ width: decoded.width, height: decoded.height, color: WHITE });
    flat.composite(decoded, 0, 0);
    return { image: flat, ink: countInk(flat.bitmap.data) };
}

function countInk(data) {
    let count = 0;
    for (let at = 0; at + RGBA_STRIDE <= data.length; at += RGBA_STRIDE) {
        if (data[at] !== CHANNEL_MAX || data[at + 1] !== CHANNEL_MAX || data[at + 2] !== CHANNEL_MAX) count += 1;
    }
    return count;
}

/** setJpegDensity 自带取整与钳位，此处直接传 settings.ppi */
async function encodeJpeg(image, settings) {
    return setJpegDensity(await image.getBuffer(JPEG_MIME, { quality: settings.quality }), settings.ppi);
}

// ============================================================
// 告警文案（调研报告 4.7；S3 的句式外壳由 image-normalize.js 拼装）
// ============================================================

/** S2：含未支持的绘图记录时照常出图，但必须强告警并列出记录名与次数 */
function unsupportedNote(label, unsupported) {
    const drawing = (Array.isArray(unsupported) ? unsupported : []).filter((item) => item && item.kind === 'drawing');
    if (drawing.length === 0) return null;
    const listed = drawing.slice(0, MAX_LISTED_RECORDS).map((item) => `${item.name}×${item.count}`).join('、');
    const more = drawing.length > MAX_LISTED_RECORDS ? ` 等 ${drawing.length} 类` : '';
    return `图片 ${label} 含内置渲染器尚未支持的图元记录（${listed}${more}），已按可识别部分出图，`
        + '该图可能缺失内容，提交前必须对照原稿核对';
}

const frameText = (label, mm) => `图片 ${label} 未按 Word 显示尺寸出图：源文档中未记录该图的显示尺寸，`
    + `已按图元自身的 ${round2(mm.width)}×${round2(mm.height)} 毫米幅面输出`;

const scaleText = (label, reason, size) =>
    `图片 ${label} 已按比例缩小出图：${reason}，实际输出 ${size.width}×${size.height}`;

const dualText = (label, plusInk, classicInk) => `图片 ${label} 改用经典 EMR 记录出图：`
    + `EMF+ 记录的墨量（${plusInk} 像素）不足经典记录（${classicInk} 像素）的 ${Math.round(DUAL_INK_RATIO * 100)}%，`
    + '该图可能有漏画，提交前请对照原稿核对';

const summaryText = (count) => `已由内置图元渲染器把 ${count} 幅 EMF 图转为 JPG，提交前请对照原稿目视核对`;

const round2 = (value) => Math.round(value * 100) / 100;

module.exports = { rasterizeMetafiles };
