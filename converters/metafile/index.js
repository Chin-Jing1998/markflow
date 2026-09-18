'use strict';
/**
 * 图元模块入口：EMF／WMF 嗅探、只扫描不渲染的记录盘点、EMF → SVG 转换
 *
 * 契约（调研报告 4.2）：
 *   sniffMetafile(buffer) → 'emf' | 'wmf' | 'wmf-placeable' | null            只看魔数，不解析、不抛错
 *   inspectMetafile(buffer, { limits }) → {
 *     format, header: { bounds, frameMm: { width, height }, device: { px, mm } },
 *     plus: { present, dual, logicalDpi } | null,
 *     records: { classic: { [name]: count }, plus: {} },
 *     unsupported: [{ name, count, kind: 'drawing' | 'state' }],
 *     nestedDepth, hasChemDrawCdx,
 *   }
 *   metafileToSvg(buffer, { width, height, minStrokePx = 1, stream = 'auto', limits }) → {
 *     svg, width, height, viewBox: [x, y, w, h], format: 'emf', plus: { present, dual }, diagnostics,
 *   }
 *
 * 本批（W1）的边界：
 *   - 只回放经典 EMR 记录。stream 取 'auto' 时若文件含 EMF+ 记录，仍按 'classic' 回放，并在
 *     diagnostics.notes 里注明「EMF+ 回放尚未实现」；EMF+ 记录只被计数（plusRecords）与读取
 *     EmfPlusHeader（present／dual／logicalDpi），不参与绘制。
 *   - inspectMetafile 只统计经典记录：records.plus 恒为空对象，nestedDepth 恒为 0，
 *     hasChemDrawCdx 恒为 false（EmfPlusComment 的 CDIF／VjCD0100 判据属 W2）。
 *
 * 纯函数保证：metafileToSvg 同步、不读写文件、不访问网络、不依赖本机字体；同一输入两次调用
 * 的 svg 逐字节相同。随时间变化的量只有 diagnostics.elapsedMs，绝不进入 svg。
 *
 * 失败一律抛 MetafileError：NOT_METAFILE（不是图元）、UNSUPPORTED_FORMAT（WMF，W5 之前）、
 * MALFORMED（截断、长度非法、记录内偏移越界）、LIMIT_EXCEEDED（各项上限）。未支持的记录不抛错，
 * 计入 diagnostics.unsupported，由调用方决定告警或回落。
 */
const {
    MetafileError, EMR, resolveLimits, createBudget, createDiagnostics, emrName,
    sniffFormat, createReader, readEmfHeader, readRecords, plusCommentData, readPlusRecords,
} = require('./reader');
const { createSvgWriter } = require('./svg-writer');
const { createClassicReplayer, DRAWING_TYPES, SUPPORTED_TYPES } = require('./emf-classic');

/** EmfPlusRecordType 的 EmfPlusHeader */
const EMF_PLUS_HEADER = 0x4001;
/** EmfPlusHeader.EmfPlusFlags 的 D 位：置位表示 Dual（经典记录与 EMF+ 记录并存） */
const EMF_PLUS_DUAL_FLAG = 0x0001;
/** EmfPlusHeader 数据段里 LogicalDpiX 的偏移 */
const LOGICAL_DPI_OFFSET = 8;
/** frame 字段的单位是 0.01 毫米 */
const FRAME_UNITS_PER_MM = 100;
/** 顶层图元的裁剪 id 作用域前缀；W2 的内嵌图元按深度与序号另取前缀，保证 id 全局唯一 */
const ROOT_SCOPE = 'd0:';
const DEFAULT_MIN_STROKE_PX = 1;

function toBuffer(input) {
    if (Buffer.isBuffer(input)) return input;
    if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (input instanceof ArrayBuffer) return Buffer.from(input);
    throw new MetafileError('NOT_METAFILE', '图元输入不是 Buffer');
}

/** 内部异常一律收敛为 MetafileError：不可信输入不得让宿主见到其它异常类型 */
function asMetafileError(error) {
    if (error && error.name === 'MetafileError') return error;
    const detail = error && error.message ? error.message : String(error);
    return new MetafileError('MALFORMED', `图元解析失败：${detail}`);
}

/** 格式与体量护栏：先判魔数再判体量，两者都在解析之前 */
function guardInput(buffer, limits) {
    const format = sniffFormat(buffer);
    if (format === null) throw new MetafileError('NOT_METAFILE', '不是 EMF／WMF 图元（魔数不符）');
    if (format !== 'emf') {
        throw new MetafileError('UNSUPPORTED_FORMAT', `暂不支持 ${format} 图元（WMF 回放属后续批次）`);
    }
    if (buffer.length > limits.maxBytes) {
        throw new MetafileError('LIMIT_EXCEEDED', `图元字节数 ${buffer.length} 超过上限（${limits.maxBytes}）`);
    }
    return format;
}

/** 只扫描 EMF+ 记录：计数并读取 EmfPlusHeader，本批不参与绘制 */
function scanPlusRecords(data, plus, diagnostics) {
    for (const record of readPlusRecords(data)) {
        diagnostics.counters.plusRecords += 1;
        if (record.type !== EMF_PLUS_HEADER) continue;
        plus.present = true;
        plus.dual = (record.flags & EMF_PLUS_DUAL_FLAG) === EMF_PLUS_DUAL_FLAG;
        if (record.data.length >= LOGICAL_DPI_OFFSET + 8) {
            plus.logicalDpi = [
                record.data.readUInt32LE(LOGICAL_DPI_OFFSET),
                record.data.readUInt32LE(LOGICAL_DPI_OFFSET + 4),
            ];
        }
    }
}

/**
 * 取 EMR_GDICOMMENT 里的 EMF+ 载荷并扫描。
 * classic 流下容忍畸形的 EMF+ 注释：该模式本就是 EMF+ 出问题时的回落路径，不应因注释畸形而失败。
 */
function handlePlusComment(reader, record, plus, diagnostics, stream) {
    let data = null;
    try {
        data = plusCommentData(reader, record);
        if (data) scanPlusRecords(data, plus, diagnostics);
    } catch (error) {
        if (stream !== 'classic') throw error;
        diagnostics.note('EMF+(注释解析失败)', 'state');
        return true;
    }
    return data !== null;
}

/** 输出像素：调用方未给定时按 viewBox 取整 */
const outputSize = (given, fallback) => (Number.isFinite(given) && given > 0 ? Math.round(given) : Math.round(fallback));

function replayClassic(buffer, options, limits) {
    const reader = createReader(buffer);
    const header = readEmfHeader(reader);
    const budget = createBudget(limits);
    const diagnostics = createDiagnostics();
    const writer = createSvgWriter({
        viewBox: header.viewBox,
        width: outputSize(options.width, header.viewBox[2]),
        height: outputSize(options.height, header.viewBox[3]),
        limits,
        diagnostics,
    });
    const minStrokePx = Number.isFinite(options.minStrokePx) && options.minStrokePx > 0
        ? options.minStrokePx
        : DEFAULT_MIN_STROKE_PX;
    const replayer = createClassicReplayer({
        reader, header, writer, budget, diagnostics, scope: ROOT_SCOPE, minStrokeDev: minStrokePx / writer.outScale,
    });
    const stream = options.stream === 'classic' ? 'classic' : 'auto';
    const plus = { present: false, dual: false, logicalDpi: null };
    for (const record of readRecords(reader, budget)) {
        diagnostics.counters.records = budget.records;
        // 注释记录一律由本层处理：EMF+ 载荷在这里扫描，其余（如 Origin 的私有注释）不参与绘制也不告警
        if (record.type === EMR.COMMENT) { handlePlusComment(reader, record, plus, diagnostics, stream); continue; }
        if (record.type === EMR.HEADER) continue;
        replayer.handleRecord(record.type, record, true);
    }
    diagnostics.counters.records = budget.records;
    if (plus.present) {
        diagnostics.addNote(stream === 'classic'
            ? `文件含 EMF+ 记录（${diagnostics.counters.plusRecords} 条）：已按调用方要求只回放经典 EMR 记录`
            : `文件含 EMF+ 记录（${diagnostics.counters.plusRecords} 条）：本版本按经典 EMR 记录回放，EMF+ 回放尚未实现`);
    }
    return { writer, header, plus, budget, diagnostics };
}

const toBufferSafe = (input) => {
    try { return toBuffer(input); } catch { return Buffer.alloc(0); }
};
/** 只看魔数判定格式，不解析内容；不是图元时返回 null 而非抛错 */
const sniffMetafile = (input) => sniffFormat(toBufferSafe(input));

/** 只扫描、不渲染：供「先扫描后渲染」的告警判定与化学式判据使用 */
function inspectMetafile(input, options = {}) {
    const buffer = toBuffer(input);
    const limits = resolveLimits(options.limits);
    guardInput(buffer, limits);
    try {
        return inspectEmf(buffer, limits);
    } catch (error) {
        throw asMetafileError(error);
    }
}

function inspectEmf(buffer, limits) {
    const reader = createReader(buffer);
    const header = readEmfHeader(reader);
    const budget = createBudget(limits);
    const diagnostics = createDiagnostics();
    const plus = { present: false, dual: false, logicalDpi: null };
    const classic = new Map();
    const unsupported = new Map();
    for (const record of readRecords(reader, budget)) {
        tallyRecord(record.type, classic, unsupported);
        if (record.type === EMR.COMMENT) {
            const data = plusCommentData(reader, record);
            if (data) scanPlusRecords(data, plus, diagnostics);
        }
    }
    tallyRecord(EMR.EOF, classic, unsupported);
    return {
        format: 'emf',
        header: {
            bounds: header.bounds,
            frameMm: {
                width: (header.frame[2] - header.frame[0]) / FRAME_UNITS_PER_MM,
                height: (header.frame[3] - header.frame[1]) / FRAME_UNITS_PER_MM,
            },
            device: { px: header.device.px, mm: header.device.mm },
        },
        plus: plus.present ? { ...plus } : null,
        records: { classic: Object.fromEntries(classic), plus: {} },
        unsupported: [...unsupported.values()],
        // W1 不递归内嵌图元，也不解析 EmfPlusComment 的 CDIF 载荷；两者均属 W2
        nestedDepth: 0,
        hasChemDrawCdx: false,
    };
}

function tallyRecord(type, classic, unsupported) {
    const name = emrName(type);
    classic.set(name, (classic.get(name) || 0) + 1);
    if (SUPPORTED_TYPES.has(type)) return;
    const prior = unsupported.get(name);
    if (prior) prior.count += 1;
    else unsupported.set(name, { name, count: 1, kind: DRAWING_TYPES.has(type) ? 'drawing' : 'state' });
}

/** EMF → SVG。同步纯函数，同一输入恒得同一 svg。 */
function metafileToSvg(input, options = {}) {
    const buffer = toBuffer(input);
    const limits = resolveLimits(options.limits);
    const format = guardInput(buffer, limits);
    try {
        const { writer, plus, budget, diagnostics } = replayClassic(buffer, options, limits);
        return {
            svg: writer.render(),
            width: writer.width,
            height: writer.height,
            viewBox: writer.viewBox,
            format,
            plus: { present: plus.present, dual: plus.dual },
            diagnostics: {
                ...diagnostics.counters,
                unsupported: diagnostics.unsupportedList(),
                fonts: diagnostics.fontList(),
                notes: diagnostics.noteList(),
                elapsedMs: budget.elapsedMs(),
            },
        };
    } catch (error) {
        throw asMetafileError(error);
    }
}

module.exports = { MetafileError, sniffMetafile, inspectMetafile, metafileToSvg };
