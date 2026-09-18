'use strict';
/**
 * EMF+ 对象解析：点数组的三种编码、七类对象（Brush／Pen／Path／Region／Image／Font／StringFormat）、
 * 跨记录续接的拼装，以及路径对象到 SVG path 数据的转换
 *
 * 职责边界：本模块只认二进制布局，不持有回放状态、不产出元素——状态机在 emf-plus.js，出图在 svg-writer.js。
 *   - 传入的 data 是 reader.readPlusRecords 已校验过长度的切片；本模块内的越界读取抛 RangeError，
 *     由 emf-plus.js 的 handleRecord 收敛为「该条记录解析失败」的诊断项，不中断整份转换。
 *   - 只有「续接对象总长超过上限」是真正的失败，抛 MetafileError('LIMIT_EXCEEDED')，逐层上抛。
 *   - 解析不下来的子特性（渐变画刷、复合线、自定义线帽等）经 context.note 计入诊断，取近似值继续。
 *
 * 与调研原型 proto/emf2svg-proto2.js 的两处有意偏离，均已对照 forensics/emfplus_dump.py 的取证脚本：
 *   ① StringFormat 的 LeadingMargin／TrailingMargin 在偏移 36／40（原型取 40／44，整体后移了一个字段）；
 *   ② 路径类型的 RLE 游程为 0 时立即收尾，避免畸形输入下的空转。
 */
const { MetafileError } = require('./reader');
const { transformPoint, formatNumber } = require('./svg-writer');

/** EmfPlusObjectType（[MS-EMFPLUS] 2.1.1.22） */
const PLUS_OBJECT = Object.freeze({
    BRUSH: 1, PEN: 2, PATH: 3, REGION: 4, IMAGE: 5, FONT: 6, STRING_FORMAT: 7,
    IMAGE_ATTRIBUTES: 8, CUSTOM_LINE_CAP: 9,
});
/** EmfPlusUnitType（[MS-EMFPLUS] 2.1.1.33） */
const UNIT = Object.freeze({
    WORLD: 0, DISPLAY: 1, PIXEL: 2, POINT: 3, INCH: 4, DOCUMENT: 5, MILLIMETER: 6,
});
/** RegionNode 的节点类型（[MS-EMFPLUS] 2.1.1.27） */
const REGION_NODE = Object.freeze({
    RECT: 0x10000000, PATH: 0x10000001, EMPTY: 0x10000002, INFINITE: 0x10000003,
});
/** 点编码：C 位为 16 位整数点，P 位为 7／15 位相对点，两者都不置位时为 32 位浮点点 */
const POINT_COMPRESSED_FLAG = 0x4000;
const POINT_RELATIVE_FLAG = 0x0800;
/** EmfPlusObject 记录的 C 位：对象数据跨多条记录续接 */
const OBJECT_CONTINUED_FLAG = 0x8000;
/** 续接记录的前 4 字节是 TotalObjectSize */
const TOTAL_OBJECT_SIZE_BYTES = 4;
/** BrushType：0 为实心色 */
const BRUSH_SOLID = 0;
/** ImageDataType：1 为位图，2 为图元 */
const IMAGE_METAFILE = 2;
/** PenData 的可选字段位（[MS-EMFPLUS] 2.1.2.7 PenDataFlags） */
const PEN_DATA = Object.freeze({
    TRANSFORM: 0x0001, START_CAP: 0x0002, END_CAP: 0x0004, JOIN: 0x0008, MITER_LIMIT: 0x0010,
    LINE_STYLE: 0x0020, DASHED_LINE_CAP: 0x0040, DASHED_LINE_OFFSET: 0x0080, DASHED_LINE: 0x0100,
    NON_CENTER: 0x0200, COMPOUND_LINE: 0x0400, CUSTOM_START_CAP: 0x0800, CUSTOM_END_CAP: 0x1000,
});
/** PenData 内 2×3 变换矩阵的字节数 */
const PEN_TRANSFORM_BYTES = 24;
/** 虚线节距数组的读取上限（超出部分忽略，节距只影响观感） */
const MAX_DASH_ENTRIES = 64;
/** PathPointType：低三位为点类型，高位为标志 */
const PATH_POINT_TYPE_MASK = 0x07;
const PATH_POINT_CLOSE_FLAG = 0x80;
const PATH_POINT_START = 0;
const PATH_POINT_LINE = 1;
const PATH_POINT_BEZIER = 3;
/** PathPointFlags 的 R 位：类型数组按游程压缩 */
const PATH_TYPES_RLE_FLAG = 0x1000;
/** RLE 游程计数占低 6 位 */
const PATH_RLE_RUN_MASK = 0x3F;
/** 7 位相对整数的符号位与 15 位相对整数的标志位、符号位 */
const RELATIVE_WIDE_FLAG = 0x80;
const RELATIVE_BYTE_SIGN = 0x40;
const RELATIVE_BYTE_BIAS = 0x80;
const RELATIVE_WORD_SIGN = 0x4000;
const RELATIVE_WORD_BIAS = 0x8000;
/** EmfPlusStringFormat 的字段偏移（对照 forensics/emfplus_dump.py） */
const FORMAT_ALIGN_OFFSET = 12;
const FORMAT_LINE_ALIGN_OFFSET = 16;
const FORMAT_LEADING_MARGIN_OFFSET = 36;
const FORMAT_TRAILING_MARGIN_OFFSET = 40;
/** EmfPlusFont 的字段偏移 */
const FONT_EM_OFFSET = 4;
const FONT_UNIT_OFFSET = 8;
const FONT_STYLE_OFFSET = 12;
const FONT_NAME_LENGTH_OFFSET = 20;
const FONT_NAME_OFFSET = 24;
/** 字体名长度上限（LOGFONT 同量级，超出即判为畸形） */
const MAX_FONT_NAME_CHARS = 128;
/** EmfPlusImage：Type 在 4，MetafileType 在 8，MetafileDataSize 在 12，数据自 16 起 */
const IMAGE_TYPE_OFFSET = 4;
const IMAGE_METAFILE_TYPE_OFFSET = 8;
const IMAGE_METAFILE_SIZE_OFFSET = 12;
const IMAGE_METAFILE_DATA_OFFSET = 16;

/** ARGB → { color, alpha }；alpha 为 0–1 */
const argbColor = (value) => ({
    color: `#${((value >>> 0) & 0xFFFFFF).toString(16).padStart(6, '0')}`,
    alpha: ((value >>> 24) & 0xFF) / 255,
});

/** 7 位或 15 位相对整数（[MS-EMFPLUS] 2.2.2.21 EmfPlusPointR） */
function readRelativeInt(data, offset) {
    const head = data.readUInt8(offset);
    if (head & RELATIVE_WIDE_FLAG) {
        const value = ((head & ~RELATIVE_WIDE_FLAG) << 8) | data.readUInt8(offset + 1);
        return { value: value & RELATIVE_WORD_SIGN ? value - RELATIVE_WORD_BIAS : value, next: offset + 2 };
    }
    return { value: head & RELATIVE_BYTE_SIGN ? head - RELATIVE_BYTE_BIAS : head, next: offset + 1 };
}

/**
 * 点数组：按记录标志在浮点、16 位整数、7／15 位相对三种编码里择一
 * checkPoints 为预算回调（超过单条记录点数上限时抛 LIMIT_EXCEEDED）
 */
function readPlusPoints(data, offset, count, flags, checkPoints) {
    checkPoints(count);
    const points = new Array(count);
    let at = offset;
    for (let index = 0; index < count; index += 1) {
        if (flags & POINT_RELATIVE_FLAG) {
            const dx = readRelativeInt(data, at);
            const dy = readRelativeInt(data, dx.next);
            const prior = index ? points[index - 1] : [0, 0];
            points[index] = [prior[0] + dx.value, prior[1] + dy.value];
            at = dy.next;
        } else if (flags & POINT_COMPRESSED_FLAG) {
            points[index] = [data.readInt16LE(at), data.readInt16LE(at + 2)];
            at += 4;
        } else {
            points[index] = [data.readFloatLE(at), data.readFloatLE(at + 4)];
            at += 8;
        }
    }
    return { points, end: at };
}

/** 矩形：C 位置位时为四个 16 位整数，否则为四个浮点数 */
function readPlusRect(data, offset, flags) {
    if (flags & POINT_COMPRESSED_FLAG) {
        return [data.readInt16LE(offset), data.readInt16LE(offset + 2),
            data.readInt16LE(offset + 4), data.readInt16LE(offset + 6)];
    }
    return [data.readFloatLE(offset), data.readFloatLE(offset + 4),
        data.readFloatLE(offset + 8), data.readFloatLE(offset + 12)];
}
/** 矩形的字节数，随 C 位变化 */
const rectBytes = (flags) => ((flags & POINT_COMPRESSED_FLAG) ? 8 : 16);

/** 实心画刷；渐变、纹理等取近似黑并记诊断 */
function parseBrush(data, context) {
    const type = data.readUInt32LE(4);
    if (type === BRUSH_SOLID) return { kind: 'brush', ...argbColor(data.readUInt32LE(8)) };
    context.note(`EmfPlusBrush(type=${type})`, 'drawing');
    return { kind: 'brush', color: '#000000', alpha: 1, approximate: true };
}

/** PenData 的可选字段按位依序排布，只能顺读一遍 */
function readPenOptionals(data, flags, start, pen, context) {
    let at = start;
    if (flags & PEN_DATA.TRANSFORM) at += PEN_TRANSFORM_BYTES;
    if (flags & PEN_DATA.START_CAP) { pen.startCap = data.readUInt32LE(at); at += 4; }
    if (flags & PEN_DATA.END_CAP) { pen.endCap = data.readUInt32LE(at); at += 4; }
    if (flags & PEN_DATA.JOIN) { pen.join = data.readUInt32LE(at); at += 4; }
    if (flags & PEN_DATA.MITER_LIMIT) { pen.miterLimit = data.readFloatLE(at); at += 4; }
    if (flags & PEN_DATA.LINE_STYLE) { pen.lineStyle = data.readUInt32LE(at); at += 4; }
    if (flags & PEN_DATA.DASHED_LINE_CAP) at += 4;
    if (flags & PEN_DATA.DASHED_LINE_OFFSET) at += 4;
    if (flags & PEN_DATA.DASHED_LINE) {
        const count = data.readUInt32LE(at);
        at += 4;
        pen.dash = [];
        for (let index = 0; index < count && index < MAX_DASH_ENTRIES; index += 1) {
            pen.dash.push(data.readFloatLE(at + index * 4));
        }
        at += count * 4;
    }
    if (flags & PEN_DATA.NON_CENTER) at += 4;
    if (flags & PEN_DATA.COMPOUND_LINE) {
        const count = data.readUInt32LE(at);
        at += 4 + count * 4;
        context.note('EmfPlusPen(CompoundLine)', 'drawing');
    }
    if (flags & PEN_DATA.CUSTOM_START_CAP) { at += 4 + data.readUInt32LE(at); context.note('EmfPlusPen(CustomStartCap)', 'drawing'); }
    if (flags & PEN_DATA.CUSTOM_END_CAP) { at += 4 + data.readUInt32LE(at); context.note('EmfPlusPen(CustomEndCap)', 'drawing'); }
    return at;
}

/** 笔：宽度与单位在前，可选字段随 PenDataFlags，末尾内嵌一个画刷对象 */
function parsePen(data, context) {
    const flags = data.readUInt32LE(8);
    const pen = {
        kind: 'pen',
        unit: data.readUInt32LE(12),
        width: data.readFloatLE(16),
        startCap: 0,
        endCap: 0,
        join: 0,
        miterLimit: 10,
        dash: null,
    };
    const at = readPenOptionals(data, flags, 20, pen, context);
    const brush = parseBrush(data.subarray(at), context);
    pen.color = brush.color;
    pen.alpha = brush.alpha;
    return pen;
}

/** 路径类型数组：可按游程压缩，游程为 0 时立即收尾（畸形输入不得空转） */
function readPathTypes(data, offset, count, flags) {
    const types = [];
    let at = offset;
    if (!(flags & PATH_TYPES_RLE_FLAG)) {
        for (let index = 0; index < count; index += 1) types.push(data.readUInt8(offset + index));
        return types;
    }
    while (types.length < count) {
        const run = data.readUInt8(at) & PATH_RLE_RUN_MASK;
        const type = data.readUInt8(at + 1);
        at += 2;
        if (run === 0) break;
        for (let index = 0; index < run && types.length < count; index += 1) types.push(type);
    }
    return types;
}

/** 路径：点数组 + 类型数组 */
function parsePath(data, context) {
    const count = data.readUInt32LE(4);
    const flags = data.readUInt32LE(8);
    const { points, end } = readPlusPoints(data, 12, count, flags, context.checkPoints);
    return { kind: 'path', points, types: readPathTypes(data, end, count, flags) };
}

/** 图像：只取内嵌图元，位图留待后续批次 */
function parseImage(data, context) {
    if (data.readUInt32LE(IMAGE_TYPE_OFFSET) !== IMAGE_METAFILE) {
        context.note('EmfPlusImage(位图)', 'drawing');
        return { kind: 'image', bitmap: true };
    }
    const size = data.readUInt32LE(IMAGE_METAFILE_SIZE_OFFSET);
    const end = IMAGE_METAFILE_DATA_OFFSET + size;
    if (size <= 0 || end > data.length) throw new RangeError('EMF+ 内嵌图元长度越界');
    return {
        kind: 'image',
        metafileType: data.readUInt32LE(IMAGE_METAFILE_TYPE_OFFSET),
        metafile: data.subarray(IMAGE_METAFILE_DATA_OFFSET, end),
    };
}

/** 字体：EmSize 以 SizeUnit 计，样式位 1 为粗体、2 为斜体 */
function parseFont(data) {
    const length = data.readUInt32LE(FONT_NAME_LENGTH_OFFSET);
    if (length > MAX_FONT_NAME_CHARS) throw new RangeError('EMF+ 字体名长度异常');
    return {
        kind: 'font',
        em: data.readFloatLE(FONT_EM_OFFSET),
        unit: data.readUInt32LE(FONT_UNIT_OFFSET),
        style: data.readUInt32LE(FONT_STYLE_OFFSET),
        face: data.toString('utf16le', FONT_NAME_OFFSET, FONT_NAME_OFFSET + length * 2),
    };
}

/** 字符串格式：对齐方式与左右留白 */
const parseStringFormat = (data) => ({
    kind: 'format',
    align: data.readUInt32LE(FORMAT_ALIGN_OFFSET),
    lineAlign: data.readUInt32LE(FORMAT_LINE_ALIGN_OFFSET),
    leadingMargin: data.readFloatLE(FORMAT_LEADING_MARGIN_OFFSET),
    trailingMargin: data.readFloatLE(FORMAT_TRAILING_MARGIN_OFFSET),
});

/**
 * 七类对象的分发；未实现的类型只记类型号，不影响其余记录。
 * ImageAttributes（类型 8）只规定位图的色键与环绕方式，对内嵌图元与本模块的输出没有作用，
 * 因此按无害对象静默收下——位图支持（W5）落地时须重新评估这一条。
 */
function parsePlusObject(objectType, data, context) {
    switch (objectType) {
        case PLUS_OBJECT.BRUSH: return parseBrush(data, context);
        case PLUS_OBJECT.PEN: return parsePen(data, context);
        case PLUS_OBJECT.PATH: return parsePath(data, context);
        case PLUS_OBJECT.REGION: return { kind: 'region', data };
        case PLUS_OBJECT.IMAGE: return parseImage(data, context);
        case PLUS_OBJECT.FONT: return parseFont(data);
        case PLUS_OBJECT.STRING_FORMAT: return parseStringFormat(data);
        case PLUS_OBJECT.IMAGE_ATTRIBUTES: return { kind: 'imageAttributes' };
        default:
            context.note(`EmfPlusObject(type=${objectType})`, 'state');
            return { kind: `object${objectType}` };
    }
}

/**
 * 续接对象的拼装：C 位置位的记录每条带 4 字节 TotalObjectSize，凑齐后才算一个完整对象。
 * pending 为调用方持有的 Map（键为对象 id）；未凑齐时返回 null。
 */
function objectChunk(pending, id, data, maxObjectBytes) {
    const total = data.readUInt32LE(0);
    if (total > maxObjectBytes) {
        throw new MetafileError('LIMIT_EXCEEDED', `EMF+ 续接对象总长 ${total} 超过上限（${maxObjectBytes}）`);
    }
    const entry = pending.get(id) || { total, chunks: [], size: 0 };
    entry.chunks.push(data.subarray(TOTAL_OBJECT_SIZE_BYTES));
    entry.size += Math.max(0, data.length - TOTAL_OBJECT_SIZE_BYTES);
    if (entry.size > maxObjectBytes) {
        throw new MetafileError('LIMIT_EXCEEDED', `EMF+ 续接对象总长 ${entry.size} 超过上限（${maxObjectBytes}）`);
    }
    if (entry.size < entry.total) {
        pending.set(id, entry);
        return null;
    }
    pending.delete(id);
    return Buffer.concat(entry.chunks).subarray(0, entry.total);
}

/** 路径对象 → SVG path 的 d 属性：起点、直线、三点一组的三次贝塞尔，CloseSubpath 位收尾 */
function pathData(path, matrix) {
    const { points, types } = path;
    let data = '';
    let index = 0;
    const at = (position) => {
        const point = transformPoint(matrix, points[position][0], points[position][1]);
        return `${formatNumber(point[0])} ${formatNumber(point[1])}`;
    };
    const close = (position) => ((types[position] & PATH_POINT_CLOSE_FLAG) ? 'Z' : '');
    while (index < points.length) {
        const type = types[index] & PATH_POINT_TYPE_MASK;
        if (type === PATH_POINT_START) { data += `M${at(index)}${close(index)}`; index += 1; continue; }
        if (type === PATH_POINT_LINE) { data += `L${at(index)}${close(index)}`; index += 1; continue; }
        if (type === PATH_POINT_BEZIER && index + 2 < points.length) {
            data += `C${at(index)} ${at(index + 1)} ${at(index + 2)}${close(index + 2)}`;
            index += 3;
            continue;
        }
        index += 1;
    }
    return data;
}

module.exports = {
    PLUS_OBJECT,
    UNIT,
    REGION_NODE,
    POINT_COMPRESSED_FLAG,
    POINT_RELATIVE_FLAG,
    OBJECT_CONTINUED_FLAG,
    argbColor,
    readPlusPoints,
    readPlusRect,
    rectBytes,
    parsePlusObject,
    objectChunk,
    pathData,
};
