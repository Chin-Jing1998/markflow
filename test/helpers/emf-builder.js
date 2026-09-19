'use strict';
/**
 * 合成 EMF 构造器（测试夹具）：按 [MS-EMF] 的小端布局逐条拼记录，不入库任何二进制图元
 *
 * 用法：buildEmf([记录…], 文件头选项) → Buffer。记录由本文件的各构造函数产出，一律是完整记录
 * （4 字节类型 + 4 字节长度 + 载荷，长度补齐到 4 的倍数）；buildEmf 负责补文件头与 EMR_EOF，
 * 并回填文件头的 nBytes 与 nRecords。
 *
 * 默认文件头：bounds [0,0,999,999]、frame [0,0,25400,25400]（0.01 毫米，即 254 毫米见方）、
 * 参考设备 1000×1000 像素 / 254000×254000 微米 —— 即每 0.01 毫米 1/25.4 像素，
 * 故默认 viewBox 恰为 [0, 0, 1000, 1000]，便于断言。
 *
 * 函数签名对 W2 稳定：W2 只在文件末尾追加 EMF+ 记录与对象的构造函数，不改本文件已有函数的签名。
 * plusRecord／emfPlusComment／plusHeader 已经就位，W2 的 EmfPlusObject、DrawLines 等可直接复用。
 */

/** EMR_HEADER 的固定长度（含 HeaderExtension1、2） */
const HEADER_BYTES = 108;
/** ' EMF' 签名 */
const EMF_SIGNATURE = 0x464D4520;
/** 'EMF+' 注释标识 */
const EMF_PLUS_SIGNATURE = 0x2B464D45;
/** EmrText 头部长度：Reference + Chars + offString + Options + Rectangle + offDx */
const EMRTEXT_HEADER_BYTES = 40;
/** EmrText 在记录内的起点（记录头 8 + Bounds 16 + iGraphicsMode 4 + exScale 4 + eyScale 4） */
const EMRTEXT_OFFSET = 36;
/** RegionDataHeader 长度 */
const REGION_HEADER_BYTES = 32;

const pad4 = (buffer) => (buffer.length % 4 === 0
    ? buffer
    : Buffer.concat([buffer, Buffer.alloc(4 - (buffer.length % 4))]));

const int32 = (...values) => {
    const out = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => out.writeInt32LE(Math.trunc(value), index * 4));
    return out;
};
const uint32 = (...values) => {
    const out = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => out.writeUInt32LE(value >>> 0, index * 4));
    return out;
};
const float32 = (...values) => {
    const out = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => out.writeFloatLE(value, index * 4));
    return out;
};
const int16 = (...values) => {
    const out = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => out.writeInt16LE(Math.trunc(value), index * 2));
    return out;
};
/** COLORREF：0x00BBGGRR */
const rgb = (r, g, b) => ((b << 16) | (g << 8) | r) >>> 0;
/** RECTL */
const rect = (box) => int32(box[0], box[1], box[2], box[3]);
/** 16 位点数组 */
const points16 = (points) => int16(...points.flat());
/** 32 位点数组 */
const points32 = (points) => int32(...points.flat());

/** 一条完整记录：类型 + 长度 + 载荷（补齐 4 字节） */
function record(type, payload = Buffer.alloc(0)) {
    const body = pad4(payload);
    const out = Buffer.alloc(8 + body.length);
    out.writeUInt32LE(type, 0);
    out.writeUInt32LE(out.length, 4);
    body.copy(out, 8);
    return out;
}

/** EMR_HEADER。nBytes 与 nRecords 由 buildEmf 回填。 */
function emfHeader(options = {}) {
    const bounds = options.bounds || [0, 0, 999, 999];
    const frame = options.frame || [0, 0, 25400, 25400];
    const devicePx = options.devicePx || [1000, 1000];
    const deviceMm = options.deviceMm || [254, 254];
    const deviceUm = options.deviceUm || [254000, 254000];
    const headerSize = options.headerSize || HEADER_BYTES;
    const out = Buffer.alloc(headerSize);
    out.writeUInt32LE(1, 0);
    out.writeUInt32LE(headerSize, 4);
    rect(bounds).copy(out, 8);
    rect(frame).copy(out, 24);
    out.writeUInt32LE(EMF_SIGNATURE, 40);
    out.writeUInt32LE(0x00010000, 44);
    out.writeUInt16LE(options.handles === undefined ? 16 : options.handles, 56);
    int32(devicePx[0], devicePx[1]).copy(out, 72);
    int32(deviceMm[0], deviceMm[1]).copy(out, 80);
    if (headerSize >= 108) int32(deviceUm[0], deviceUm[1]).copy(out, 100);
    return out;
}

/** EMR_EOF：nPalEntries、offPalEntries、SizeLast */
const eof = () => record(14, uint32(0, 16, 20));

/** 文件头 + 记录 + EMR_EOF，并回填 nBytes / nRecords */
function buildEmf(records = [], headerOptions = {}) {
    const header = emfHeader(headerOptions);
    const body = Buffer.concat(records);
    const tail = headerOptions.omitEof ? Buffer.alloc(0) : eof();
    const total = header.length + body.length + tail.length;
    header.writeUInt32LE(headerOptions.declaredBytes === undefined ? total : headerOptions.declaredBytes, 48);
    const count = records.length + (headerOptions.omitEof ? 1 : 2);
    header.writeUInt32LE(headerOptions.declaredRecords === undefined ? count : headerOptions.declaredRecords, 52);
    return Buffer.concat([header, body, tail]);
}

// ---------------- 状态与变换 ----------------

const setWorldTransform = (matrix) => record(35, float32(...matrix));
const modifyWorldTransform = (matrix, mode) => record(36, Buffer.concat([float32(...matrix), uint32(mode)]));
const saveDc = () => record(33);
const restoreDc = (saved) => record(34, int32(saved));
const setMapMode = (mode) => record(17, uint32(mode));
const setWindowExtEx = (cx, cy) => record(9, int32(cx, cy));
const setWindowOrgEx = (x, y) => record(10, int32(x, y));
const setViewportExtEx = (cx, cy) => record(11, int32(cx, cy));
const setViewportOrgEx = (x, y) => record(12, int32(x, y));
const scaleViewportExtEx = (xNum, xDen, yNum, yDen) => record(31, int32(xNum, xDen, yNum, yDen));
const scaleWindowExtEx = (xNum, xDen, yNum, yDen) => record(32, int32(xNum, xDen, yNum, yDen));
const setBkMode = (mode) => record(18, uint32(mode));
const setBkColor = (color) => record(25, uint32(color));
const setTextColor = (color) => record(24, uint32(color));
const setTextAlign = (align) => record(22, uint32(align));
const setPolyFillMode = (mode) => record(19, uint32(mode));
const setMiterLimit = (limit) => record(58, uint32(limit));
const setRop2 = (mode) => record(20, uint32(mode));
const setIcmMode = (mode) => record(98, uint32(mode));
const moveToEx = (x, y) => record(27, int32(x, y));
const lineTo = (x, y) => record(54, int32(x, y));

// ---------------- 对象 ----------------

/** EMR_CREATEPEN：width 为 0 即装饰笔 */
const createPen = ({ handle, style = 0, width = 0, color = 0 }) => record(38, Buffer.concat([
    uint32(handle), uint32(style), int32(width, 0), uint32(color),
]));
/** EMR_EXTCREATEPEN：style 需自带 PS_GEOMETRIC（0x10000）等高位 */
const extCreatePen = ({ handle, style = 0x00010000, width = 1, color = 0, brushStyle = 0, hatch = 0 }) => record(95, Buffer.concat([
    uint32(handle), uint32(0, 0, 0, 0), uint32(style), uint32(width), uint32(brushStyle), uint32(color), uint32(hatch), uint32(0),
]));
const createBrushIndirect = ({ handle, style = 0, color = 0, hatch = 0 }) => record(39, Buffer.concat([
    uint32(handle), uint32(style), uint32(color), uint32(hatch),
]));

/** EMR_EXTCREATEFONTINDIRECTW：LogFont 的 lfFaceName 为 32 个 UTF-16 字符 */
function extCreateFontIndirectW({
    handle, face = 'Arial', height = -100, escapement = 0, orientation = 0,
    weight = 400, italic = 0, underline = 0, strikeOut = 0, charSet = 0, width = 0,
}) {
    const logFont = Buffer.alloc(92);
    logFont.writeInt32LE(height, 0);
    logFont.writeInt32LE(width, 4);
    logFont.writeInt32LE(escapement, 8);
    logFont.writeInt32LE(orientation, 12);
    logFont.writeInt32LE(weight, 16);
    logFont.writeUInt8(italic, 20);
    logFont.writeUInt8(underline, 21);
    logFont.writeUInt8(strikeOut, 22);
    logFont.writeUInt8(charSet, 23);
    logFont.write(String(face).slice(0, 31), 28, 'utf16le');
    return record(82, Buffer.concat([uint32(handle), logFont]));
}
const selectObject = (handle) => record(37, uint32(handle));
const deleteObject = (handle) => record(40, uint32(handle));

// ---------------- 折线族 ----------------

const polyPayload = (points, small, bounds) => Buffer.concat([
    rect(bounds || [0, 0, 0, 0]), uint32(points.length), small ? points16(points) : points32(points),
]);
const polyline16 = (points, bounds) => record(87, polyPayload(points, true, bounds));
const polygon16 = (points, bounds) => record(86, polyPayload(points, true, bounds));
const polyBezier16 = (points, bounds) => record(85, polyPayload(points, true, bounds));
const polylineTo16 = (points, bounds) => record(89, polyPayload(points, true, bounds));
const polyBezierTo16 = (points, bounds) => record(88, polyPayload(points, true, bounds));
const polyline = (points, bounds) => record(4, polyPayload(points, false, bounds));
const polygon = (points, bounds) => record(3, polyPayload(points, false, bounds));
const polyBezier = (points, bounds) => record(2, polyPayload(points, false, bounds));

const polyPolyPayload = (polys, small, bounds) => {
    const flat = polys.flat();
    return Buffer.concat([
        rect(bounds || [0, 0, 0, 0]),
        uint32(polys.length),
        uint32(flat.length),
        uint32(...polys.map((poly) => poly.length)),
        small ? points16(flat) : points32(flat),
    ]);
};
const polyPolyline16 = (polys, bounds) => record(90, polyPolyPayload(polys, true, bounds));
const polyPolygon16 = (polys, bounds) => record(91, polyPolyPayload(polys, true, bounds));
const polyPolygon = (polys, bounds) => record(8, polyPolyPayload(polys, false, bounds));

// ---------------- 图形与路径 ----------------

const rectangle = (box) => record(43, rect(box));
const ellipse = (box) => record(42, rect(box));
const roundRect = (box, cornerW, cornerH) => record(44, Buffer.concat([rect(box), int32(cornerW, cornerH)]));
const beginPath = () => record(59);
const endPath = () => record(60);
const closeFigure = () => record(61);
const abortPath = () => record(68);
const fillPath = (bounds) => record(62, rect(bounds || [0, 0, 0, 0]));
const strokeAndFillPath = (bounds) => record(63, rect(bounds || [0, 0, 0, 0]));
const strokePath = (bounds) => record(64, rect(bounds || [0, 0, 0, 0]));

// ---------------- 裁剪 ----------------

const intersectClipRect = (box) => record(30, rect(box));
const excludeClipRect = (box) => record(29, rect(box));
const selectClipPath = (mode) => record(67, uint32(mode));

/** EMR_EXTSELECTCLIPRGN：RgnDataSize、RegionMode、RegionData（头 32 字节 + 矩形数组） */
function extSelectClipRgn(rects, mode = 5) {
    if (!rects || rects.length === 0) return record(75, uint32(0, mode));
    const header = Buffer.alloc(REGION_HEADER_BYTES);
    header.writeUInt32LE(REGION_HEADER_BYTES, 0);
    header.writeUInt32LE(1, 4);
    header.writeUInt32LE(rects.length, 8);
    header.writeUInt32LE(rects.length * 16, 12);
    rect(rects[0]).copy(header, 16);
    const body = Buffer.concat([header, ...rects.map(rect)]);
    return record(75, Buffer.concat([uint32(body.length), uint32(mode), body]));
}

// ---------------- 文字与位图 ----------------

/**
 * EMR_EXTTEXTOUTW / EMR_EXTTEXTOUTA
 * options.dx 给定时写入 Dx 数组；options.wide 为 false 时按 EXTTEXTOUTA（单字节）写。
 * offString／offDx 均相对记录起点，由本函数按实际布局算出。
 */
function extTextOutW({
    x, y, text, dx = null, options = 0, graphicsMode = 1, scale = 1, bounds = [0, 0, 0, 0], wide = true,
}) {
    // EMF 的 Chars 计的是 UTF-16 码元数（EXTTEXTOUTA 为字节数）
    const chars = String(text).length;
    const stringBytes = pad4(wide ? Buffer.from(String(text), 'utf16le') : Buffer.from(String(text), 'latin1'));
    const offString = EMRTEXT_OFFSET + EMRTEXT_HEADER_BYTES;
    const dxBytes = dx ? uint32(...dx) : Buffer.alloc(0);
    const offDx = dx ? offString + stringBytes.length : 0;
    const emrText = Buffer.alloc(EMRTEXT_HEADER_BYTES);
    int32(x, y).copy(emrText, 0);
    emrText.writeUInt32LE(chars, 8);
    emrText.writeUInt32LE(offString, 12);
    emrText.writeUInt32LE(options, 16);
    rect(bounds).copy(emrText, 20);
    emrText.writeUInt32LE(offDx, 36);
    return record(wide ? 84 : 83, Buffer.concat([
        rect(bounds), uint32(graphicsMode), float32(scale, scale), emrText, stringBytes, dxBytes,
    ]));
}

/** EMR_BITBLT：默认写 GDI+ 录制器的空操作 ROP 0x00AA0029 且不带位图 */
function bitBlt({ rop = 0x00AA0029, dest = [0, 0], size = [10, 10], bitmapBytes = 0 } = {}) {
    const payload = Buffer.alloc(92);
    rect([dest[0], dest[1], dest[0] + size[0], dest[1] + size[1]]).copy(payload, 0);
    int32(dest[0], dest[1], size[0], size[1]).copy(payload, 16);
    payload.writeUInt32LE(rop >>> 0, 32);
    payload.writeUInt32LE(bitmapBytes >>> 0, 88);
    return record(76, payload);
}

// ---------------- 注释与 EMF+ ----------------

const gdiComment = (payload) => record(70, Buffer.concat([uint32(payload.length), payload]));

/** 一条 EMF+ 记录：Type、Flags、Size、DataSize、数据（补齐 4 字节） */
function plusRecord(type, flags, data = Buffer.alloc(0)) {
    const body = pad4(data);
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt16LE(type, 0);
    out.writeUInt16LE(flags, 2);
    out.writeUInt32LE(out.length, 4);
    out.writeUInt32LE(data.length, 8);
    body.copy(out, 12);
    return out;
}

/** EmfPlusHeader：D 位在记录头 Flags 上，DPI 在数据段 */
const plusHeader = ({ dual = true, logicalDpi = [96, 96], version = 0xDBC01002, flags = 0 } = {}) => plusRecord(
    0x4001, dual ? 1 : 0, Buffer.concat([uint32(version), uint32(flags), uint32(logicalDpi[0], logicalDpi[1])]),
);

/** 装进 EMR_GDICOMMENT 的 EMF+ 记录块：DataSize、'EMF+'、各条记录 */
function emfPlusComment(plusRecords) {
    const body = Buffer.concat(Array.isArray(plusRecords) ? plusRecords : [plusRecords]);
    return record(70, Buffer.concat([uint32(body.length + 4), uint32(EMF_PLUS_SIGNATURE), body]));
}

// ---------------- EMF+ 对象（W2 追加） ----------------

/** GDI+ 1.1 的对象版本号；各对象数据段的首个字段 */
const PLUS_VERSION = 0xDBC01002;
/** EmfPlusObject 的 Flags 布局：id 在低 8 位，对象类型在第 8–14 位，C 位表示续接 */
const objectFlags = (objectType, id, continued) => ((id & 0xFF) | ((objectType & 0x7F) << 8) | (continued ? 0x8000 : 0));
/** 绘图记录的点编码位：C 为 16 位整数点，P 为 7／15 位相对点 */
const pointFlags = ({ compressed = false, relative = false } = {}) => ((compressed ? 0x4000 : 0) | (relative ? 0x0800 : 0));
/** S 位：画刷字段按 ARGB 内联而非对象 id */
const brushFlag = (options) => (options.inlineBrush === false ? 0 : 0x8000);

/** 7 位相对整数；超出 [-64, 64) 时改用 15 位形式 */
function relativeInt(value) {
    if (value >= -64 && value < 64) return Buffer.from([value & 0x7F]);
    const raw = value & 0x7FFF;
    return Buffer.from([0x80 | ((raw >> 8) & 0x7F), raw & 0xFF]);
}
/** 点数组：浮点、16 位整数、相对三种编码 */
function plusPoints(points, options = {}) {
    if (options.relative) {
        const parts = [];
        let prior = [0, 0];
        for (const point of points) {
            parts.push(relativeInt(Math.trunc(point[0] - prior[0])), relativeInt(Math.trunc(point[1] - prior[1])));
            prior = point;
        }
        return Buffer.concat(parts);
    }
    return options.compressed ? int16(...points.flat()) : float32(...points.flat());
}
/** 矩形数组：[x, y, w, h] 逐个 */
const plusRects = (rects, compressed) => (compressed
    ? int16(...rects.flat())
    : float32(...rects.flat()));

/** 一条 EmfPlusObject 记录；continued 为真时数据段前置 4 字节 TotalObjectSize */
function plusObject(objectType, id, data, { continued = false, totalSize = null } = {}) {
    const payload = continued
        ? Buffer.concat([uint32(totalSize === null ? data.length : totalSize), data])
        : data;
    return plusRecord(0x4008, objectFlags(objectType, id, continued), payload);
}
/** 把一个对象载荷切成若干条带 C 位的续接记录（末条凑齐 TotalObjectSize） */
function plusObjectChunks(objectType, id, data, chunkSize, { totalSize = null } = {}) {
    const out = [];
    for (let at = 0; at < data.length; at += chunkSize) {
        out.push(plusObject(objectType, id, data.subarray(at, Math.min(at + chunkSize, data.length)), {
            continued: true,
            totalSize: totalSize === null ? data.length : totalSize,
        }));
    }
    return out;
}

/** EmfPlusBrush：实心色 */
const plusBrushData = (argb = 0xFF000000) => Buffer.concat([uint32(PLUS_VERSION), uint32(0), uint32(argb)]);
/** EmfPlusPen：可选字段由调用方按 dataFlags 自行拼在 optional 里，末尾内嵌画刷 */
const plusPenData = ({ argb = 0xFF000000, width = 1, unit = 0, dataFlags = 0, optional = Buffer.alloc(0) } = {}) => Buffer.concat([
    uint32(PLUS_VERSION), uint32(0), uint32(dataFlags), uint32(unit), float32(width), optional, plusBrushData(argb),
]);
/** EmfPlusPath：点数组 + 类型数组（0 起点、1 直线、3 贝塞尔，0x80 为闭合位） */
const plusPathData = (points, types, options = {}) => Buffer.concat([
    uint32(PLUS_VERSION), uint32(points.length), uint32(pointFlags(options)),
    plusPoints(points, options), Buffer.from(types),
]);
/** EmfPlusRegion：四种节点 */
const plusRegionRectData = (box) => Buffer.concat([uint32(PLUS_VERSION), uint32(0), uint32(0x10000000), float32(...box)]);
const plusRegionPathData = (pathData) => Buffer.concat([uint32(PLUS_VERSION), uint32(0), uint32(0x10000001), uint32(pathData.length), pathData]);
const plusRegionEmptyData = () => Buffer.concat([uint32(PLUS_VERSION), uint32(0), uint32(0x10000002)]);
const plusRegionInfiniteData = () => Buffer.concat([uint32(PLUS_VERSION), uint32(0), uint32(0x10000003)]);
/** EmfPlusImage：内嵌图元（MetafileDataType 4 即 EmfPlusOnly） */
const plusImageMetafileData = (metafile, { metafileType = 4 } = {}) => Buffer.concat([
    uint32(PLUS_VERSION), uint32(2), uint32(metafileType), uint32(metafile.length), metafile,
]);
/** EmfPlusImage：位图（本批不绘制，只用于断言诊断项） */
const plusImageBitmapData = () => Buffer.concat([uint32(PLUS_VERSION), uint32(1), uint32(0)]);
/** EmfPlusFont：EmSize 以 SizeUnit 计，样式位 1 粗体、2 斜体 */
const plusFontData = ({ em = 100, unit = 2, style = 0, face = 'Arial' } = {}) => Buffer.concat([
    uint32(PLUS_VERSION), float32(em), uint32(unit), uint32(style), uint32(0),
    uint32(String(face).length), Buffer.from(String(face), 'utf16le'),
]);
/** EmfPlusStringFormat：对齐与左右留白（LeadingMargin 在偏移 36） */
function plusStringFormatData({ align = 0, lineAlign = 0, leadingMargin = 0, trailingMargin = 0, tracking = 1, formatFlags = 0 } = {}) {
    const out = Buffer.alloc(60);
    out.writeUInt32LE(PLUS_VERSION, 0);
    out.writeUInt32LE(formatFlags, 4);
    out.writeUInt32LE(align, 12);
    out.writeUInt32LE(lineAlign, 16);
    out.writeFloatLE(leadingMargin, 36);
    out.writeFloatLE(trailingMargin, 40);
    out.writeFloatLE(tracking, 44);
    return out;
}
/** 内嵌图元对象：一条或（给定 chunkSize 时）多条续接记录 */
function nestedMetafile(inner, { id = 1, chunkSize = 0, metafileType = 4, totalSize = null } = {}) {
    const data = plusImageMetafileData(inner, { metafileType });
    if (!chunkSize) return [plusObject(5, id, data)];
    return plusObjectChunks(5, id, data, chunkSize, { totalSize });
}

// ---------------- EMF+ 记录（W2 追加） ----------------

const plusEndOfFile = () => plusRecord(0x4002, 0);
const plusComment = (payload) => plusRecord(0x4003, 0, Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'latin1'));
const plusGetDc = () => plusRecord(0x4004, 0);
const plusDrawLines = (penId, points, options = {}) => plusRecord(
    0x400D, (penId & 0xFF) | (options.closed ? 0x2000 : 0) | pointFlags(options),
    Buffer.concat([uint32(points.length), plusPoints(points, options)]),
);
const plusFillPolygon = (brush, points, options = {}) => plusRecord(
    0x400C, brushFlag(options) | pointFlags(options),
    Buffer.concat([uint32(brush >>> 0), uint32(points.length), plusPoints(points, options)]),
);
const plusFillRects = (brush, rects, options = {}) => plusRecord(
    0x400A, brushFlag(options) | pointFlags(options),
    Buffer.concat([uint32(brush >>> 0), uint32(rects.length), plusRects(rects, options.compressed)]),
);
const plusDrawRects = (penId, rects, options = {}) => plusRecord(
    0x400B, (penId & 0xFF) | pointFlags(options),
    Buffer.concat([uint32(rects.length), plusRects(rects, options.compressed)]),
);
const plusFillEllipse = (brush, box, options = {}) => plusRecord(
    0x400E, brushFlag(options) | pointFlags(options),
    Buffer.concat([uint32(brush >>> 0), plusRects([box], options.compressed)]),
);
const plusDrawEllipse = (penId, box, options = {}) => plusRecord(
    0x400F, (penId & 0xFF) | pointFlags(options), plusRects([box], options.compressed),
);
const plusFillPath = (pathId, brush, options = {}) => plusRecord(
    0x4014, (pathId & 0xFF) | brushFlag(options), uint32(brush >>> 0),
);
const plusDrawPath = (pathId, penId) => plusRecord(0x4015, pathId & 0xFF, uint32(penId >>> 0));
const plusDrawString = ({
    fontId = 0, brush = 0xFF000000, formatId = 0, text = '', x = 0, y = 0, width = 0, height = 0, inlineBrush = true,
}) => plusRecord(
    0x401C, (fontId & 0xFF) | (inlineBrush ? 0x8000 : 0),
    Buffer.concat([
        uint32(brush >>> 0), uint32(formatId), uint32(String(text).length),
        float32(x, y, width, height), Buffer.from(String(text), 'utf16le'),
    ]),
);
const plusDrawImage = (imageId, srcRect, destRect, options = {}) => plusRecord(
    0x401A, (imageId & 0xFF) | pointFlags(options),
    Buffer.concat([uint32(0), uint32(options.srcUnit === undefined ? 2 : options.srcUnit),
        float32(...srcRect), plusRects([destRect], options.compressed)]),
);
const plusDrawImagePoints = (imageId, srcRect, points, options = {}) => plusRecord(
    0x401B, (imageId & 0xFF) | pointFlags(options),
    Buffer.concat([uint32(0), uint32(options.srcUnit === undefined ? 2 : options.srcUnit),
        float32(...srcRect), uint32(points.length), plusPoints(points, options)]),
);
const plusSave = (index = 0) => plusRecord(0x4025, 0, uint32(index));
const plusRestore = (index = 0) => plusRecord(0x4026, 0, uint32(index));
const plusBeginContainerNoParams = (index = 0) => plusRecord(0x4028, 0, uint32(index));
const plusEndContainer = (index = 0) => plusRecord(0x4029, 0, uint32(index));
const plusSetWorldTransform = (matrix) => plusRecord(0x402A, 0, float32(...matrix));
const plusResetWorldTransform = () => plusRecord(0x402B, 0);
const plusMultiplyWorldTransform = (matrix, post = false) => plusRecord(0x402C, post ? 0x2000 : 0, float32(...matrix));
const plusTranslateWorldTransform = (dx, dy, post = false) => plusRecord(0x402D, post ? 0x2000 : 0, float32(dx, dy));
const plusScaleWorldTransform = (sx, sy, post = false) => plusRecord(0x402E, post ? 0x2000 : 0, float32(sx, sy));
const plusRotateWorldTransform = (degrees, post = false) => plusRecord(0x402F, post ? 0x2000 : 0, float32(degrees));
const plusSetPageTransform = (scale, unit = 2) => plusRecord(0x4030, unit & 0xFF, float32(scale));
const plusResetClip = () => plusRecord(0x4031, 0);
const plusSetClipRect = (box, mode = 0) => plusRecord(0x4032, (mode & 0xF) << 8, float32(...box));
const plusSetClipPath = (pathId, mode = 0) => plusRecord(0x4033, (pathId & 0xFF) | ((mode & 0xF) << 8));
const plusSetClipRegion = (regionId, mode = 0) => plusRecord(0x4034, (regionId & 0xFF) | ((mode & 0xF) << 8));

module.exports = {
    uint32,
    int32,
    float32,
    int16,
    rgb,
    record,
    emfHeader,
    eof,
    buildEmf,
    setWorldTransform,
    modifyWorldTransform,
    saveDc,
    restoreDc,
    setMapMode,
    setWindowExtEx,
    setWindowOrgEx,
    setViewportExtEx,
    setViewportOrgEx,
    scaleViewportExtEx,
    scaleWindowExtEx,
    setBkMode,
    setBkColor,
    setTextColor,
    setTextAlign,
    setPolyFillMode,
    setMiterLimit,
    setRop2,
    setIcmMode,
    moveToEx,
    lineTo,
    createPen,
    extCreatePen,
    createBrushIndirect,
    extCreateFontIndirectW,
    selectObject,
    deleteObject,
    polyline16,
    polygon16,
    polyBezier16,
    polylineTo16,
    polyBezierTo16,
    polyline,
    polygon,
    polyBezier,
    polyPolyline16,
    polyPolygon16,
    polyPolygon,
    rectangle,
    ellipse,
    roundRect,
    beginPath,
    endPath,
    closeFigure,
    abortPath,
    fillPath,
    strokeAndFillPath,
    strokePath,
    intersectClipRect,
    excludeClipRect,
    selectClipPath,
    extSelectClipRgn,
    extTextOutW,
    bitBlt,
    gdiComment,
    plusRecord,
    plusHeader,
    emfPlusComment,
    plusObject,
    plusObjectChunks,
    plusPoints,
    plusBrushData,
    plusPenData,
    plusPathData,
    plusRegionRectData,
    plusRegionPathData,
    plusRegionEmptyData,
    plusRegionInfiniteData,
    plusImageMetafileData,
    plusImageBitmapData,
    plusFontData,
    plusStringFormatData,
    nestedMetafile,
    plusEndOfFile,
    plusComment,
    plusGetDc,
    plusDrawLines,
    plusFillPolygon,
    plusFillRects,
    plusDrawRects,
    plusFillEllipse,
    plusDrawEllipse,
    plusFillPath,
    plusDrawPath,
    plusDrawString,
    plusDrawImage,
    plusDrawImagePoints,
    plusSave,
    plusRestore,
    plusBeginContainerNoParams,
    plusEndContainer,
    plusSetWorldTransform,
    plusResetWorldTransform,
    plusMultiplyWorldTransform,
    plusTranslateWorldTransform,
    plusScaleWorldTransform,
    plusRotateWorldTransform,
    plusSetPageTransform,
    plusResetClip,
    plusSetClipRect,
    plusSetClipPath,
    plusSetClipRegion,
};
