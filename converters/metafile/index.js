'use strict';
/**
 * 图元模块入口：EMF／WMF 嗅探、只扫描不渲染的记录盘点、EMF → SVG 转换，以及两套记录的仲裁
 *
 * 契约（调研报告 4.2）：
 *   sniffMetafile(buffer) → 'emf' | 'wmf' | 'wmf-placeable' | null            只看魔数，不解析、不抛错
 *   inspectMetafile(buffer, { limits }) → {
 *     format, header: { bounds, frameMm: { width, height }, device: { px, mm } },
 *     plus: { present, dual, logicalDpi } | null,
 *     records: { classic: { [name]: count }, plus: { [name]: count } },
 *     unsupported: [{ name, count, kind: 'drawing' | 'state' }],
 *     nestedDepth, hasChemDrawCdx,
 *   }
 *   metafileToSvg(buffer, { width, height, minStrokePx = 1, stream = 'auto', limits }) → {
 *     svg, width, height, viewBox: [x, y, w, h], format: 'emf', plus: { present, dual }, diagnostics,
 *   }
 *
 * 仲裁（[MS-EMFPLUS] 1.3.1）：
 *   - stream = 'auto' 且文件带 EmfPlusHeader 时按「EMF+ Only」回放——EMF+ 记录为准，经典绘图记录
 *     只在 EmfPlusGetDC 之后、下一条任意 EMF+ 记录之前生效（被抑制的记录计入 classicSuppressed）。
 *     样稿里有 4 个文件的经典回退段被录制器裁剔（调研报告 2.6 表 H），只回放经典记录会静默出残图，
 *     因此这条语义是正确性要求而非优化。
 *   - stream = 'auto' 但文件不含 EMF+ 记录，或 stream = 'classic' 时，回放经典记录；后者只清点
 *     EMF+ 记录并读取 EmfPlusHeader，供双流互校与回落使用。
 *   - 内嵌图元（EmfPlusObject 的 Image／Metafile，含跨记录续接）经 DrawImage(Points) 递归回放，
 *     内容包在 <g transform="matrix(…)"> 里；递归深度、记录数与耗时共用同一份预算。
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
const { createSvgWriter, matrixAttr, matrixScale } = require('./svg-writer');
const { createClassicReplayer, DRAWING_TYPES, SUPPORTED_TYPES } = require('./emf-classic');
const {
    PLUS, PLUS_DRAWING_TYPES, PLUS_SUPPORTED_TYPES, OBJECT_ID_MASK, OBJECT_TYPE_SHIFT, OBJECT_TYPE_MASK,
    plusName, readHeaderInfo, isChemDrawComment, createPlusReplayer,
} = require('./emf-plus');
const { PLUS_OBJECT, OBJECT_CONTINUED_FLAG, parsePlusObject, objectChunk } = require('./emf-plus-objects');

/** frame 字段的单位是 0.01 毫米 */
const FRAME_UNITS_PER_MM = 100;
/** 顶层图元的裁剪 id 作用域前缀；内嵌图元按「深度 + 内嵌序号」另取前缀，保证 id 全局唯一 */
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

/** 输出像素：调用方未给定时按 viewBox 取整 */
const outputSize = (given, fallback) => (Number.isFinite(given) && given > 0 ? Math.round(given) : Math.round(fallback));

/**
 * 取 EMR_GDICOMMENT 里的 EMF+ 载荷并交给 EMF+ 回放器。
 * classic 流下容忍畸形的 EMF+ 注释：该模式本就是 EMF+ 出问题时的回落路径，不应因注释畸形而失败。
 */
function handlePlusComment(reader, record, plus, session) {
    try {
        const data = plusCommentData(reader, record);
        if (!data) return;
        for (const item of readPlusRecords(data)) {
            if (session.stream === 'classic') plus.scanRecord(item.type, item.flags, item.data);
            else plus.handleRecord(item.type, item.flags, item.data);
        }
    } catch (error) {
        if (session.stream !== 'classic') throw error;
        session.diagnostics.note('EMF+(注释解析失败)', 'state');
    }
}

/**
 * 回放一个图元（顶层或内嵌）的全部记录。
 * deviceScale 为「该层的一个设备单位对应多少输出像素」，线宽下限据此换算。
 */
function replayRecords(reader, header, session, depth, deviceScale) {
    const { writer, budget, diagnostics } = session;
    const scope = depth === 0 ? ROOT_SCOPE : `d${depth}n${session.nestedSeq}:`;
    const minStrokeDev = session.minStrokePx / (deviceScale || 1);
    const classic = createClassicReplayer({
        reader, header, writer, budget, diagnostics, scope, minStrokeDev,
    });
    const plus = createPlusReplayer({
        writer,
        budget,
        diagnostics,
        scope,
        minStrokeDev,
        drawNested: (inner, matrix, clip) => replayNested(session, depth, deviceScale, inner, matrix, clip),
    });
    for (const record of readRecords(reader, budget)) {
        diagnostics.counters.records = budget.records;
        // 注释记录一律由本层处理：EMF+ 载荷在这里回放，其余（如 Origin 的私有注释）不参与绘制也不告警
        if (record.type === EMR.COMMENT) { handlePlusComment(reader, record, plus, session); continue; }
        if (record.type === EMR.HEADER) continue;
        classic.handleRecord(record.type, record, drawClassic(session, plus));
    }
    diagnostics.counters.records = budget.records;
    return plus.info();
}

/** 经典绘图记录是否落笔：只回放经典记录时恒放行，否则只在 GetDC 区段内放行 */
const drawClassic = (session, plus) => (
    session.stream === 'classic' || !plus.hasPlus() || plus.inGetDcSection()
);

/**
 * 内嵌图元：在独立片段里回放，再整体包进 <g transform="matrix(…)">。
 * defs、裁剪 id、字节计量与各项预算全程与外层共用，因此 id 全局唯一、上限也覆盖内嵌层。
 */
function replayNested(session, depth, deviceScale, inner, matrix, clip) {
    const { writer, diagnostics, limits } = session;
    if (depth + 1 > limits.maxNestedDepth) {
        diagnostics.note('EmfPlusDrawImage(内嵌图元超过递归深度)', 'drawing');
        return;
    }
    const reader = createReader(inner);
    const header = readEmfHeader(reader);
    session.nestedSeq += 1;
    diagnostics.counters.nested += 1;
    writer.pushFragment();
    try {
        replayRecords(reader, header, session, depth + 1, deviceScale * matrixScale(matrix));
    } finally {
        const fragment = writer.popFragment();
        if (fragment) writer.emit(`<g transform="${matrixAttr(matrix)}">${fragment}</g>`, clip);
    }
}

/** 顶层回放：建出图器与各项预算，回放后由调用方拼装结果 */
function replayMetafile(buffer, options, limits) {
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
    const session = {
        writer,
        budget,
        diagnostics,
        limits,
        stream: options.stream === 'classic' ? 'classic' : 'auto',
        minStrokePx: Number.isFinite(options.minStrokePx) && options.minStrokePx > 0
            ? options.minStrokePx
            : DEFAULT_MIN_STROKE_PX,
        nestedSeq: 0,
    };
    const plus = replayRecords(reader, header, session, 0, writer.outScale);
    if (plus.present) diagnostics.addNote(streamNote(session, diagnostics));
    return { writer, header, plus, budget, diagnostics };
}

const streamNote = (session, diagnostics) => (session.stream === 'classic'
    ? `文件含 EMF+ 记录（${diagnostics.counters.plusRecords} 条）：已按调用方要求只回放经典 EMR 记录`
    : `文件含 EMF+ 记录（${diagnostics.counters.plusRecords} 条）：已按 [MS-EMFPLUS] 1.3.1 以 EMF+ 记录为准回放，`
        + '经典绘图记录只在 EmfPlusGetDC 区段内生效');

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
    const totals = {
        classic: new Map(),
        plus: new Map(),
        unsupported: new Map(),
        nestedDepth: 0,
        hasChemDrawCdx: false,
        limits,
        budget: createBudget(limits),
    };
    const root = scanMetafile(buffer, totals, 0);
    return {
        format: 'emf',
        header: {
            bounds: root.header.bounds,
            frameMm: {
                width: (root.header.frame[2] - root.header.frame[0]) / FRAME_UNITS_PER_MM,
                height: (root.header.frame[3] - root.header.frame[1]) / FRAME_UNITS_PER_MM,
            },
            device: { px: root.header.device.px, mm: root.header.device.mm },
        },
        plus: root.plus.present ? { ...root.plus } : null,
        records: { classic: Object.fromEntries(totals.classic), plus: Object.fromEntries(totals.plus) },
        unsupported: [...totals.unsupported.values()],
        nestedDepth: totals.nestedDepth,
        hasChemDrawCdx: totals.hasChemDrawCdx,
    };
}

/**
 * 盘点一个图元（含内嵌层）的记录。内嵌图元的记录并入同一份直方图：
 * 「先扫描后渲染」判定告警级别时，内嵌层的未支持记录同样会画到最终产物上。
 */
function scanMetafile(buffer, totals, depth) {
    const reader = createReader(buffer);
    const header = readEmfHeader(reader);
    const plus = { present: false, dual: false, logicalDpi: null };
    const pending = new Map();
    for (const record of readRecords(reader, totals.budget)) {
        tallyClassic(record.type, totals);
        if (record.type !== EMR.COMMENT) continue;
        const data = plusCommentData(reader, record);
        if (data) scanPlusPayload(data, totals, depth, plus, pending);
    }
    tallyClassic(EMR.EOF, totals);
    return { header, plus };
}

function scanPlusPayload(data, totals, depth, plus, pending) {
    for (const record of readPlusRecords(data)) {
        tallyPlus(record.type, totals);
        if (record.type === PLUS.HEADER) scanPlusHeader(record, plus);
        else if (record.type === PLUS.COMMENT) scanPlusComment(record.data, totals);
        else if (record.type === PLUS.OBJECT) scanPlusObject(record, totals, depth, pending);
    }
}

function scanPlusHeader(record, plus) {
    const info = readHeaderInfo(record.flags, record.data);
    plus.present = true;
    plus.dual = info.dual;
    if (info.logicalDpi) plus.logicalDpi = info.logicalDpi;
}

/** ChemDraw 判据对内嵌图元里的注释同样适用 */
function scanPlusComment(data, totals) {
    if (isChemDrawComment(data)) totals.hasChemDrawCdx = true;
}

/** 只解析 Image 对象：它承载内嵌图元，是 nestedDepth 与内嵌层直方图的来源 */
function scanPlusObject(record, totals, depth, pending) {
    const objectType = (record.flags >> OBJECT_TYPE_SHIFT) & OBJECT_TYPE_MASK;
    if (objectType !== PLUS_OBJECT.IMAGE) return;
    let blob = record.data;
    if (record.flags & OBJECT_CONTINUED_FLAG) {
        blob = objectChunk(pending, record.flags & OBJECT_ID_MASK, record.data, totals.limits.maxObjectBytes);
        if (blob === null) return;
    }
    const context = {
        note: (name, kind) => tallyNote(totals, name, kind),
        checkPoints: (count) => totals.budget.checkPoints(count),
    };
    let image = null;
    try {
        image = parsePlusObject(PLUS_OBJECT.IMAGE, blob, context);
    } catch (error) {
        if (error instanceof MetafileError) throw error;
        tallyNote(totals, 'EmfPlusObject(type=5 解析失败)', 'state');
        return;
    }
    if (!image.metafile || depth + 1 > totals.limits.maxNestedDepth) return;
    totals.nestedDepth = Math.max(totals.nestedDepth, depth + 1);
    scanMetafile(image.metafile, totals, depth + 1);
}

function tallyNote(totals, name, kind) {
    const prior = totals.unsupported.get(name);
    if (prior) prior.count += 1;
    else totals.unsupported.set(name, { name, count: 1, kind: kind === 'drawing' ? 'drawing' : 'state' });
}

function tallyClassic(type, totals) {
    const name = emrName(type);
    totals.classic.set(name, (totals.classic.get(name) || 0) + 1);
    if (SUPPORTED_TYPES.has(type)) return;
    tallyNote(totals, name, DRAWING_TYPES.has(type) ? 'drawing' : 'state');
}

function tallyPlus(type, totals) {
    const name = plusName(type);
    totals.plus.set(name, (totals.plus.get(name) || 0) + 1);
    if (PLUS_SUPPORTED_TYPES.has(type)) return;
    tallyNote(totals, name, PLUS_DRAWING_TYPES.has(type) ? 'drawing' : 'state');
}

/** EMF → SVG。同步纯函数，同一输入恒得同一 svg。 */
function metafileToSvg(input, options = {}) {
    const buffer = toBuffer(input);
    const limits = resolveLimits(options.limits);
    const format = guardInput(buffer, limits);
    try {
        const { writer, plus, budget, diagnostics } = replayMetafile(buffer, options, limits);
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
