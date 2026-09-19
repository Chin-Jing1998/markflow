'use strict';
/**
 * 图元读取层：有界读取器、EMF 文件头、记录迭代器，以及本模块共用的错误类型、上限、预算与诊断收集器
 *
 * 职责边界：converters/metafile 内的最底层，不 require 同目录任何模块（fonts.js 同样无依赖，二者互不引用）。
 *   - MetafileError    本模块一切失败的唯一异常类型；code ∈ NOT_METAFILE | UNSUPPORTED_FORMAT | MALFORMED | LIMIT_EXCEEDED
 *   - DEFAULT_LIMITS / resolveLimits
 *                      安全上限表。调用方经 limits 只能「收紧」不能放宽：每项取默认值与传入值的较小者，
 *                      非有限数或负数一律忽略。测试据此触发各项 LIMIT_EXCEEDED。
 *   - createBudget     记录数、单条记录点数与转换耗时的共用预算。耗时在第一条记录与其后每
 *                      TIME_CHECK_RECORDS 条记录各查一次时钟（限额为 0 时第一条即触发，便于测试）。
 *   - createDiagnostics
 *                      未支持记录（{ name, count, kind }）、字体名、各项计数与中文备注的共用收集器；
 *                      回放层与出图层都往同一份里写，最后由 index.js 汇总成 diagnostics。
 *   - createReader     一切读取先做越界检查的 Buffer 视图。EMF 来自用户文档，属不可信输入，绝不裸读。
 *   - readEmfHeader    文件头：bounds、frame、参考设备（像素／毫米／微米扩展）与由 frame 换算的 viewBox
 *   - readRecords      经典记录迭代器（长度须为 4 的倍数且不小于 8、不得越过文件尾、必须见到 EMR_EOF）
 *   - plusCommentData / readPlusRecords
 *                      EMR_GDICOMMENT 内的 EMF+ 载荷与 12 字节记录头迭代器。W1 只用它数记录与读 EmfPlusHeader；
 *                      W2 回放时应把 yield 出来的 data 再用 createReader 包一层，取得同样的越界保护。
 *
 * 越界、长度非法、记录内偏移越界、缺 EMR_EOF 一律抛 MALFORMED；上限触发一律抛 LIMIT_EXCEEDED。
 */

/** EMR_HEADER 的 dSignature：' EMF' 的小端 u32 */
const EMF_SIGNATURE = 0x464D4520;
/** EMR_GDICOMMENT 内标识 EMF+ 记录的注释标识：'EMF+' 的小端 u32 */
const EMF_PLUS_SIGNATURE = 0x2B464D45;
/** WMF 可置放文件头（Aldus placeable）的魔数 */
const WMF_PLACEABLE_MAGIC = 0x9AC6CDD7;
/** EmfMetafileHeader 的最小长度（不含任何扩展） */
const EMF_HEADER_MIN_BYTES = 88;
/** EmfMetafileHeaderExtension2 起处：szlMicrometers */
const EMF_HEADER_MICROMETERS_OFFSET = 100;
/** 每隔多少条记录查一次时钟 */
const TIME_CHECK_RECORDS = 256;
/** EMF+ 记录头长度：Type(2) + Flags(2) + Size(4) + DataSize(4) */
const PLUS_RECORD_HEADER_BYTES = 12;

/** 本模块用到的经典记录类型号（[MS-EMF] 2.1.1 RecordType 的子集） */
const EMR = Object.freeze({
    HEADER: 1, POLYBEZIER: 2, POLYGON: 3, POLYLINE: 4, POLYBEZIERTO: 5, POLYLINETO: 6,
    POLYPOLYLINE: 7, POLYPOLYGON: 8, SETWINDOWEXTEX: 9, SETWINDOWORGEX: 10,
    SETVIEWPORTEXTEX: 11, SETVIEWPORTORGEX: 12, EOF: 14, SETMAPMODE: 17, SETBKMODE: 18,
    SETPOLYFILLMODE: 19, SETTEXTALIGN: 22, SETTEXTCOLOR: 24, SETBKCOLOR: 25,
    OFFSETCLIPRGN: 26, MOVETOEX: 27, EXCLUDECLIPRECT: 29, INTERSECTCLIPRECT: 30,
    SCALEVIEWPORTEXTEX: 31, SCALEWINDOWEXTEX: 32, SAVEDC: 33, RESTOREDC: 34,
    SETWORLDTRANSFORM: 35, MODIFYWORLDTRANSFORM: 36, SELECTOBJECT: 37, CREATEPEN: 38,
    CREATEBRUSHINDIRECT: 39, DELETEOBJECT: 40, ELLIPSE: 42, RECTANGLE: 43, ROUNDRECT: 44,
    LINETO: 54, SETMITERLIMIT: 58, BEGINPATH: 59, ENDPATH: 60, CLOSEFIGURE: 61,
    FILLPATH: 62, STROKEANDFILLPATH: 63, STROKEPATH: 64, SELECTCLIPPATH: 67, ABORTPATH: 68,
    COMMENT: 70, EXTSELECTCLIPRGN: 75, BITBLT: 76, EXTCREATEFONTINDIRECTW: 82,
    EXTTEXTOUTA: 83, EXTTEXTOUTW: 84, POLYBEZIER16: 85, POLYGON16: 86, POLYLINE16: 87,
    POLYBEZIERTO16: 88, POLYLINETO16: 89, POLYPOLYLINE16: 90, POLYPOLYGON16: 91,
    EXTCREATEPEN: 95,
});

/** 记录类型号 → 规范名（只列 [MS-EMF] 定义过的类型；缺口按 EMR_<号> 生成） */
const EMR_NAMES = Object.freeze([
    null, 'HEADER', 'POLYBEZIER', 'POLYGON', 'POLYLINE', 'POLYBEZIERTO', 'POLYLINETO',
    'POLYPOLYLINE', 'POLYPOLYGON', 'SETWINDOWEXTEX', 'SETWINDOWORGEX', 'SETVIEWPORTEXTEX',
    'SETVIEWPORTORGEX', 'SETBRUSHORGEX', 'EOF', 'SETPIXELV', 'SETMAPPERFLAGS', 'SETMAPMODE',
    'SETBKMODE', 'SETPOLYFILLMODE', 'SETROP2', 'SETSTRETCHBLTMODE', 'SETTEXTALIGN',
    'SETCOLORADJUSTMENT', 'SETTEXTCOLOR', 'SETBKCOLOR', 'OFFSETCLIPRGN', 'MOVETOEX',
    'SETMETARGN', 'EXCLUDECLIPRECT', 'INTERSECTCLIPRECT', 'SCALEVIEWPORTEXTEX',
    'SCALEWINDOWEXTEX', 'SAVEDC', 'RESTOREDC', 'SETWORLDTRANSFORM', 'MODIFYWORLDTRANSFORM',
    'SELECTOBJECT', 'CREATEPEN', 'CREATEBRUSHINDIRECT', 'DELETEOBJECT', 'ANGLEARC', 'ELLIPSE',
    'RECTANGLE', 'ROUNDRECT', 'ARC', 'CHORD', 'PIE', 'SELECTPALETTE', 'CREATEPALETTE',
    'SETPALETTEENTRIES', 'RESIZEPALETTE', 'REALIZEPALETTE', 'EXTFLOODFILL', 'LINETO', 'ARCTO',
    'POLYDRAW', 'SETARCDIRECTION', 'SETMITERLIMIT', 'BEGINPATH', 'ENDPATH', 'CLOSEFIGURE',
    'FILLPATH', 'STROKEANDFILLPATH', 'STROKEPATH', 'FLATTENPATH', 'WIDENPATH', 'SELECTCLIPPATH',
    'ABORTPATH', null, 'COMMENT', 'FILLRGN', 'FRAMERGN', 'INVERTRGN', 'PAINTRGN',
    'EXTSELECTCLIPRGN', 'BITBLT', 'STRETCHBLT', 'MASKBLT', 'PLGBLT', 'SETDIBITSTODEVICE',
    'STRETCHDIBITS', 'EXTCREATEFONTINDIRECTW', 'EXTTEXTOUTA', 'EXTTEXTOUTW', 'POLYBEZIER16',
    'POLYGON16', 'POLYLINE16', 'POLYBEZIERTO16', 'POLYLINETO16', 'POLYPOLYLINE16',
    'POLYPOLYGON16', 'POLYDRAW16', 'CREATEMONOBRUSH', 'CREATEDIBPATTERNBRUSHPT', 'EXTCREATEPEN',
    'POLYTEXTOUTA', 'POLYTEXTOUTW', 'SETICMMODE', 'CREATECOLORSPACE', 'SETCOLORSPACE',
    'DELETECOLORSPACE', 'GLSRECORD', 'GLSBOUNDEDRECORD', 'PIXELFORMAT', 'DRAWESCAPE',
    'EXTESCAPE', null, 'SMALLTEXTOUT', 'FORCEUFIMAPPING', 'NAMEDESCAPE', 'COLORCORRECTPALETTE',
    'SETICMPROFILEA', 'SETICMPROFILEW', 'ALPHABLEND', 'SETLAYOUT', 'TRANSPARENTBLT', null,
    'GRADIENTFILL', 'SETLINKEDUFIS', 'SETTEXTJUSTIFICATION', 'COLORMATCHTOTARGETW',
    'CREATECOLORSPACEW',
]);

/** 记录类型号 → 诊断用名称 */
const emrName = (type) => `EMR_${EMR_NAMES[type] || String(type)}`;

/** 本模块一切失败的唯一异常类型 */
class MetafileError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'MetafileError';
        this.code = code;
    }
}

/** 安全上限（依据调研报告 4.6）。样稿的实际用量比每一项都低两个数量级以上。 */
const DEFAULT_LIMITS = Object.freeze({
    maxBytes: 64 * 1024 * 1024,
    maxRecords: 500000,
    maxPoints: 200000,
    maxTextChars: 65535,
    maxStackDepth: 256,
    maxObjectBytes: 64 * 1024 * 1024,
    maxNestedDepth: 3,
    maxClipRects: 10000,
    maxSvgBytes: 64 * 1024 * 1024,
    maxElapsedMs: 5000,
});

/** 调用方只能收紧上限：逐项取较小者，非有限数或负数忽略 */
function resolveLimits(overrides) {
    if (!overrides || typeof overrides !== 'object') return DEFAULT_LIMITS;
    const merged = {};
    for (const [key, fallback] of Object.entries(DEFAULT_LIMITS)) {
        const given = overrides[key];
        merged[key] = Number.isFinite(given) && given >= 0 ? Math.min(fallback, given) : fallback;
    }
    return Object.freeze(merged);
}

/** 记录数、单条点数与耗时的共用预算；耗时只进诊断，绝不进 SVG */
function createBudget(limits) {
    const startedAt = Date.now();
    const state = { records: 0 };
    const checkDeadline = () => {
        if (Date.now() - startedAt >= limits.maxElapsedMs) {
            throw new MetafileError('LIMIT_EXCEEDED', `图元转换耗时超过上限（${limits.maxElapsedMs} 毫秒）`);
        }
    };
    return {
        limits,
        get records() { return state.records; },
        elapsedMs: () => Date.now() - startedAt,
        checkDeadline,
        countRecord() {
            state.records += 1;
            if (state.records > limits.maxRecords) {
                throw new MetafileError('LIMIT_EXCEEDED', `EMF 记录数超过上限（${limits.maxRecords}）`);
            }
            if (state.records === 1 || state.records % TIME_CHECK_RECORDS === 0) checkDeadline();
        },
        checkPoints(count) {
            if (!(count >= 0) || count > limits.maxPoints) {
                throw new MetafileError('LIMIT_EXCEEDED', `单条记录点数 ${count} 超过上限（${limits.maxPoints}）`);
            }
        },
        checkStack(depth) {
            if (depth >= limits.maxStackDepth) {
                throw new MetafileError('LIMIT_EXCEEDED', `状态栈嵌套超过上限（${limits.maxStackDepth}）`);
            }
        },
    };
}

/** 未支持记录、字体与各项计数的共用收集器；计数器就地自增（可变状态集中在此，不外泄） */
function createDiagnostics() {
    const unsupported = new Map();
    const fonts = new Set();
    const notes = [];
    const counters = {
        records: 0, plusRecords: 0, shapes: 0, text: 0, clipped: 0, nested: 0,
        getDcSections: 0, classicDrawn: 0, plusDrawn: 0, classicSuppressed: 0,
    };
    return {
        counters,
        /** kind：drawing 表示会影响画面，state 表示只影响状态 */
        note(name, kind) {
            const prior = unsupported.get(name);
            if (prior) prior.count += 1;
            else unsupported.set(name, { name, count: 1, kind: kind === 'drawing' ? 'drawing' : 'state' });
        },
        addFont(face) { if (face) fonts.add(String(face)); },
        addNote(text) { if (text && !notes.includes(text)) notes.push(text); },
        unsupportedList: () => [...unsupported.values()].map((item) => ({ ...item })),
        fontList: () => [...fonts],
        noteList: () => [...notes],
    };
}

/** 只看魔数判定格式，不解析内容 */
function sniffFormat(input) {
    if (!Buffer.isBuffer(input) || input.length < 8) return null;
    if (input.length >= 44 && input.readUInt32LE(0) === EMR.HEADER && input.readUInt32LE(40) === EMF_SIGNATURE) return 'emf';
    if (input.readUInt32LE(0) === WMF_PLACEABLE_MAGIC) return 'wmf-placeable';
    const type = input.readUInt16LE(0);
    if ((type === 1 || type === 2) && input.readUInt16LE(2) === 9) return 'wmf';
    return null;
}

/** 越界即抛 MALFORMED 的 Buffer 视图 */
function createReader(buffer) {
    const require_ = (offset, length) => {
        if (!Number.isInteger(offset) || !Number.isInteger(length)
            || offset < 0 || length < 0 || offset + length > buffer.length) {
            throw new MetafileError('MALFORMED', `图元读取越界（偏移 ${offset}，长度 ${length}）`);
        }
    };
    const at = (offset, length, read) => { require_(offset, length); return read(offset); };
    return {
        buffer,
        length: buffer.length,
        require: require_,
        u8: (o) => at(o, 1, (p) => buffer.readUInt8(p)),
        u16: (o) => at(o, 2, (p) => buffer.readUInt16LE(p)),
        i16: (o) => at(o, 2, (p) => buffer.readInt16LE(p)),
        u32: (o) => at(o, 4, (p) => buffer.readUInt32LE(p)),
        i32: (o) => at(o, 4, (p) => buffer.readInt32LE(p)),
        f32: (o) => at(o, 4, (p) => buffer.readFloatLE(p)),
        latin1: (o, len) => at(o, len, (p) => buffer.toString('latin1', p, p + len)),
        utf16: (o, chars) => at(o, chars * 2, (p) => buffer.toString('utf16le', p, p + chars * 2)),
        slice: (o, len) => at(o, len, (p) => buffer.subarray(p, p + len)),
    };
}

/** 参考设备的「像素／0.01 毫米」：优先用微米扩展，退回毫米字段 */
function devicePixelsPer001Mm(devicePx, deviceMm, deviceUm) {
    return [0, 1].map((axis) => {
        if (deviceUm[axis] > 0) return devicePx[axis] / (deviceUm[axis] / 10);
        return deviceMm[axis] > 0 ? devicePx[axis] / (deviceMm[axis] * 100) : 0;
    });
}

/** EMF 文件头：bounds、frame、参考设备与 viewBox（frame 退化时回落到 bounds） */
function readEmfHeader(reader) {
    if (reader.length < EMF_HEADER_MIN_BYTES || reader.u32(0) !== EMR.HEADER || reader.u32(40) !== EMF_SIGNATURE) {
        throw new MetafileError('NOT_METAFILE', '不是 EMF 图元（EMR_HEADER 或 dSignature 不符）');
    }
    const headerSize = reader.u32(4);
    const bounds = [reader.i32(8), reader.i32(12), reader.i32(16), reader.i32(20)];
    const frame = [reader.i32(24), reader.i32(28), reader.i32(32), reader.i32(36)];
    const devicePx = [reader.i32(72), reader.i32(76)];
    const deviceMm = [reader.i32(80), reader.i32(84)];
    const hasMicrometers = headerSize >= EMF_HEADER_MICROMETERS_OFFSET + 8 && reader.length >= EMF_HEADER_MICROMETERS_OFFSET + 8;
    const deviceUm = hasMicrometers
        ? [reader.i32(EMF_HEADER_MICROMETERS_OFFSET), reader.i32(EMF_HEADER_MICROMETERS_OFFSET + 4)]
        : [0, 0];
    const pxPer001mm = devicePixelsPer001Mm(devicePx, deviceMm, deviceUm);
    let viewBox = [
        frame[0] * pxPer001mm[0], frame[1] * pxPer001mm[1],
        (frame[2] - frame[0]) * pxPer001mm[0], (frame[3] - frame[1]) * pxPer001mm[1],
    ];
    // frame 退化（为空、参考设备尺寸缺失）时回落到 bounds；bounds 也为空则判为畸形
    if (!(viewBox[2] > 0 && viewBox[3] > 0)) {
        viewBox = [bounds[0], bounds[1], bounds[2] - bounds[0] + 1, bounds[3] - bounds[1] + 1];
    }
    if (!(viewBox[2] > 0 && viewBox[3] > 0)) throw new MetafileError('MALFORMED', 'EMF 的 frame 与 bounds 均为空');
    return {
        headerSize,
        bounds,
        frame,
        device: { px: devicePx, mm: deviceMm, um: deviceUm },
        pxPer001mm,
        viewBox,
        declaredBytes: reader.u32(48),
        declaredRecords: reader.u32(52),
    };
}

/** 经典记录迭代器：逐条校验长度与边界，见到 EMR_EOF 收尾；未见 EMR_EOF 视为截断 */
function* readRecords(reader, budget) {
    let offset = 0;
    let sawEof = false;
    while (offset + 8 <= reader.length) {
        const type = reader.u32(offset);
        const size = reader.u32(offset + 4);
        if (size < 8 || size % 4 !== 0) {
            throw new MetafileError('MALFORMED', `EMF 记录长度非法（偏移 ${offset}，长度 ${size}）`);
        }
        reader.require(offset, size);
        budget.countRecord();
        if (type === EMR.EOF) { sawEof = true; break; }
        yield { type, offset, size, dataOffset: offset + 8, dataSize: size - 8 };
        offset += size;
    }
    if (!sawEof) throw new MetafileError('MALFORMED', 'EMF 缺少 EMR_EOF（文件截断）');
}

/** EMR_GDICOMMENT 的 EMF+ 载荷；不是 EMF+ 注释时返回 null */
function plusCommentData(reader, record) {
    if (record.type !== EMR.COMMENT || record.size < 16) return null;
    const dataSize = reader.u32(record.dataOffset);
    if (dataSize < 4 || reader.u32(record.dataOffset + 4) !== EMF_PLUS_SIGNATURE) return null;
    if (dataSize + 12 > record.size) throw new MetafileError('MALFORMED', 'EMF+ 注释长度越过记录边界');
    return reader.slice(record.dataOffset + 8, dataSize - 4);
}

/** EMF+ 记录迭代器（12 字节记录头）；W2 回放时把 data 再包一层 createReader */
function* readPlusRecords(data) {
    let offset = 0;
    while (offset + PLUS_RECORD_HEADER_BYTES <= data.length) {
        const size = data.readUInt32LE(offset + 4);
        const dataSize = data.readUInt32LE(offset + 8);
        if (size < PLUS_RECORD_HEADER_BYTES || offset + size > data.length || dataSize > size - PLUS_RECORD_HEADER_BYTES) {
            throw new MetafileError('MALFORMED', `EMF+ 记录长度非法（偏移 ${offset}，长度 ${size}）`);
        }
        yield {
            type: data.readUInt16LE(offset),
            flags: data.readUInt16LE(offset + 2),
            size,
            data: data.subarray(offset + PLUS_RECORD_HEADER_BYTES, offset + PLUS_RECORD_HEADER_BYTES + dataSize),
        };
        offset += size;
    }
}

module.exports = {
    MetafileError,
    DEFAULT_LIMITS,
    TIME_CHECK_RECORDS,
    EMR,
    EMF_SIGNATURE,
    EMF_PLUS_SIGNATURE,
    emrName,
    resolveLimits,
    createBudget,
    createDiagnostics,
    sniffFormat,
    createReader,
    readEmfHeader,
    readRecords,
    plusCommentData,
    readPlusRecords,
};
