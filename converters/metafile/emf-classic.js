'use strict';
/**
 * 经典 EMR 记录回放：DC 状态、SaveDC／RestoreDC 栈、对象表与库存对象、路径括号、各绘图记录
 *
 * 职责边界：本模块只管「一条记录如何改变 DC 状态、如何变成一个图形」，不管记录怎么迭代（reader.js），
 * 也不管图形怎么落成字符串（svg-writer.js）。对外只有 createClassicReplayer(context).handleRecord。
 *
 *   createClassicReplayer({ reader, header, writer, budget, diagnostics, scope, minStrokeDev })
 *     → { handleRecord(type, record, draw), state(), stackDepth() }
 *
 *   - record 为 reader.readRecords 产出的 { type, offset, size, dataOffset, dataSize }。
 *   - draw 为 false 时，绘图记录只计入 diagnostics.counters.classicSuppressed 而不落笔，状态记录照常生效。
 *     这是 [MS-EMFPLUS] 1.3.1 的 GDI+ 回放语义所需的开关：W1 恒传 true（EMF+ 回放尚未实现），
 *     W2 接入 EMF+ 后由 index.js 按 EmfPlusGetDC 区段控制。路径括号内的累积不受 draw 影响，
 *     否则 BeginPath…EndPath 的配对会在被抑制时断掉。
 *   - 坐标链：逻辑坐标 —世界变换—→ 页面坐标 —映射模式／窗口视口—→ 设备坐标，最终由 svg-writer 格式化。
 *   - DC 状态栈与对象表是天然可变的结构，集中封装在本模块内部；对外只读（state()）。
 *
 * 未实现的记录（弧、扇形、弦、区域填充、DIB 位图、渐变等）不抛错，按 drawing／state 计入
 * diagnostics.unsupported，由调用方决定告警或回落。
 */
const { MetafileError, EMR, emrName } = require('./reader');
const {
    IDENTITY_MATRIX, multiplyMatrix, transformPoint, matrixScale,
    formatNumber, pointsAttr, subpathData,
} = require('./svg-writer');
const { ascentOf, isSymbolFont, hasPrivateUseChars } = require('./fonts');

/** 库存对象句柄（[MS-EMF] 2.1.31 StockObject） */
const STOCK_OBJECTS = Object.freeze({
    0x80000000: { kind: 'brush', style: 0, color: '#ffffff' },
    0x80000001: { kind: 'brush', style: 0, color: '#c0c0c0' },
    0x80000002: { kind: 'brush', style: 0, color: '#808080' },
    0x80000003: { kind: 'brush', style: 0, color: '#404040' },
    0x80000004: { kind: 'brush', style: 0, color: '#000000' },
    0x80000005: { kind: 'brush', style: 1, color: '#000000' },
    0x80000006: { kind: 'pen', style: 0, width: 0, color: '#ffffff', cosmetic: true, endCap: 0, join: 0 },
    0x80000007: { kind: 'pen', style: 0, width: 0, color: '#000000', cosmetic: true, endCap: 0, join: 0 },
    0x80000008: { kind: 'pen', style: 5, width: 0, color: '#000000', cosmetic: true, endCap: 0, join: 0 },
    0x8000000D: { kind: 'font', face: 'System', height: 16, weight: 700, italic: 0, escapement: 0, charSet: 0 },
    0x8000000E: { kind: 'font', face: 'System', height: 16, weight: 400, italic: 0, escapement: 0, charSet: 0 },
    0x80000011: { kind: 'font', face: 'Tahoma', height: -11, weight: 400, italic: 0, escapement: 0, charSet: 0 },
});
/** 库存句柄的起始值 */
const STOCK_HANDLE_BASE = 0x80000000;

/** 会产生画面的记录（GDI+ 仲裁时可被抑制的那一批） */
const DRAWING_TYPES = Object.freeze(new Set([
    2, 3, 4, 5, 6, 7, 8, 15, 41, 42, 43, 44, 45, 46, 47, 53, 54, 55, 56, 62, 63, 64,
    71, 72, 73, 74, 76, 77, 78, 79, 80, 81, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92,
    96, 97, 108, 114, 116, 118,
]));
/** 路径括号内需要继续累积的记录（被抑制时也要走完，否则子路径会断） */
const PATH_ACCUMULATING_TYPES = Object.freeze(new Set([2, 3, 4, 5, 6, 7, 8, 54, 85, 86, 87, 88, 89, 90, 91, 92]));
/** 不影响画面、无须实现也无须告警的记录 */
const IGNORABLE_TYPES = Object.freeze(new Set([
    13, 16, 20, 21, 23, 28, 48, 49, 50, 51, 52, 57, 65, 66, 98, 99, 100, 101,
    104, 112, 113, 115, 120,
]));
/** 16 位点坐标的折线族记录 */
const SMALL_POINT_TYPES = Object.freeze(new Set([85, 86, 87, 88, 89, 90, 91, 92]));
/** 本模块实际处理（或按无害忽略）的记录类型，供 inspectMetafile 判定未支持项 */
const SUPPORTED_TYPES = Object.freeze(new Set([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 17, 18, 19, 22, 24, 25, 26, 27, 29, 30,
    31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 42, 43, 44, 54, 58, 59, 60, 61, 62, 63, 64,
    67, 68, 70, 75, 76, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 95,
    ...IGNORABLE_TYPES,
]));

/** MODIFYWORLDTRANSFORM 的合成方式 */
const MWT = Object.freeze({ IDENTITY: 1, LEFTMULTIPLY: 2, RIGHTMULTIPLY: 3, SET: 4 });
/** 区域合并方式：RGN_AND 求交、RGN_COPY 替换 */
const RGN = Object.freeze({ AND: 1, COPY: 5 });
/** 笔样式低四位 */
const PS_NULL = 5;
/** ExtLogPen 的 PS_GEOMETRIC 位 */
const PS_TYPE_MASK = 0x000F0000;
const PS_GEOMETRIC = 0x00010000;
/** 端帽与接头位 */
const PS_ENDCAP_MASK = 0x00000F00;
const PS_JOIN_MASK = 0x0000F000;
const ENDCAP_NAMES = Object.freeze({ 0x000: 'round', 0x100: 'square', 0x200: 'butt' });
const JOIN_NAMES = Object.freeze({ 0x0000: 'round', 0x1000: 'bevel', 0x2000: 'miter' });
/** 笔样式 → 虚线节距（相对线宽的比例，除以 3 后乘线宽） */
const DASH_PATTERNS = Object.freeze({ 1: [18, 6], 2: [3, 3], 3: [9, 6, 3, 6], 4: [9, 3, 3, 3, 3, 3] });
const DASH_UNIT = 3;
/** 画刷样式：BS_SOLID 实心、BS_NULL 空 */
const BS_NULL = 1;
/** 填充规则：ALTERNATE 对应 evenodd */
const POLYFILL_ALTERNATE = 1;
/** 背景模式 OPAQUE */
const BKMODE_OPAQUE = 2;
/** TA_* 文字对齐位 */
const TA_HORIZONTAL_MASK = 0x06;
const TA_VERTICAL_MASK = 0x18;
const TA_CENTER = 0x06;
const TA_RIGHT = 0x02;
const TA_BOTTOM = 0x08;
const TA_BASELINE = 0x18;
/** 字体整体高度相对 em 的比例：lfHeight 为正时按此折算字号 */
const CELL_HEIGHT_TO_EM = 0.895;
/** TA_BOTTOM 的基线偏移：整体高度 1.117 em 减去上升部 */
const CELL_TOTAL_EM = 1.117;
/** ExtTextOut 选项位 */
const ETO_GLYPH_INDEX = 0x0010;
const ETO_PDY = 0x2000;
/** EmrText 相对记录起点的偏移；其后依次为 Reference、Chars、offString、Options、Rectangle、offDx */
const EMRTEXT_OFFSET = 36;
/** LOGFONT.lfFaceName 的字符数 */
const FACE_NAME_CHARS = 32;
/** BITBLT 的空操作 ROP：GDI+ 录制器的占位记录，不得当作填充 */
const ROP_NOOP = 0x00AA0029;
/** 不带位图时可按矩形填充处理的 ROP：PATCOPY、BLACKNESS、WHITENESS */
const ROP_PATCOPY = 0x00F00021;
const ROP_BLACKNESS = 0x00000042;
const ROP_WHITENESS = 0x00FF0062;
/** 映射模式 → 每逻辑单位的毫米数 */
const MAPMODE_UNIT_MM = Object.freeze({ 2: 0.1, 3: 0.01, 4: 0.254, 5: 0.0254, 6: 25.4 / 1440 });
const MM_TEXT = 1;
const MM_ISOTROPIC = 7;
const MM_ANISOTROPIC = 8;
/** 0.01 毫米为单位换算毫米时的倍数 */
const MM_PER_UNIT = 100;
/** RegionDataHeader 的长度，其后接矩形数组 */
const REGION_HEADER_BYTES = 32;
/** lfEscapement 的单位是 0.1 度，且方向与 SVG rotate 相反 */
const ESCAPEMENT_PER_DEGREE = 10;

const colorRef = (value) => `#${[value & 0xFF, (value >> 8) & 0xFF, (value >> 16) & 0xFF]
    .map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;

/** 新建一份初始 DC 状态 */
const createDeviceContext = () => ({
    worldTransform: IDENTITY_MATRIX,
    mapMode: MM_TEXT,
    windowOrigin: [0, 0],
    windowExtent: [1, 1],
    viewportOrigin: [0, 0],
    viewportExtent: [1, 1],
    pen: STOCK_OBJECTS[0x80000007],
    brush: STOCK_OBJECTS[0x80000000],
    font: STOCK_OBJECTS[0x8000000D],
    textColor: '#000000',
    bkColor: '#ffffff',
    bkMode: BKMODE_OPAQUE,
    textAlign: 0,
    polyFillMode: POLYFILL_ALTERNATE,
    miterLimit: 10,
    clip: null,
    currentPoint: [0, 0],
});

function createClassicReplayer(context) {
    const { reader, header, writer, budget, diagnostics, scope, minStrokeDev } = context;
    const objects = new Map();
    const stack = [];
    let dc = createDeviceContext();
    let path = null;

    const note = (name, kind) => diagnostics.note(name, kind);

    /** 页面坐标 → 设备坐标：映射模式与窗口／视口 */
    function pageToDevice() {
        let sx = 1;
        let sy = 1;
        if (dc.mapMode === MM_ISOTROPIC || dc.mapMode === MM_ANISOTROPIC) {
            sx = dc.viewportExtent[0] / (dc.windowExtent[0] || 1);
            sy = dc.viewportExtent[1] / (dc.windowExtent[1] || 1);
        } else if (dc.mapMode !== MM_TEXT) {
            const unitMm = MAPMODE_UNIT_MM[dc.mapMode] || 0;
            if (unitMm) {
                // 公制映射模式的 y 轴向上，故取负
                sx = unitMm * MM_PER_UNIT * header.pxPer001mm[0];
                sy = -unitMm * MM_PER_UNIT * header.pxPer001mm[1];
            }
        }
        return [sx, 0, 0, sy, dc.viewportOrigin[0] - dc.windowOrigin[0] * sx, dc.viewportOrigin[1] - dc.windowOrigin[1] * sy];
    }
    /** 逻辑坐标 → 设备坐标的总矩阵 */
    const deviceMatrix = () => multiplyMatrix(dc.worldTransform, pageToDevice());

    /** 描边属性：几何笔随变换缩放，装饰笔恒为 1 个设备单位，两者都不低于 minStrokeDev */
    function strokeAttrs(matrix) {
        const pen = dc.pen;
        if (!pen || pen.style === PS_NULL) return { stroke: 'none' };
        const scaled = pen.cosmetic ? Math.max(pen.width, 1) : pen.width * matrixScale(matrix);
        const width = Math.max(scaled, minStrokeDev);
        const cap = pen.cosmetic ? 'round' : (ENDCAP_NAMES[pen.endCap] || 'round');
        const join = pen.cosmetic ? 'round' : (JOIN_NAMES[pen.join] || 'round');
        const pattern = DASH_PATTERNS[pen.style];
        return {
            stroke: pen.color,
            'stroke-width': formatNumber(width),
            'stroke-linecap': cap,
            'stroke-linejoin': join,
            'stroke-miterlimit': join === 'miter' ? formatNumber(Math.max(1, dc.miterLimit)) : undefined,
            'stroke-dasharray': pattern
                ? pattern.map((step) => formatNumber(step * width / DASH_UNIT)).join(' ')
                : undefined,
        };
    }

    /** 填充属性：只支持实心与空画刷，阴影线与图案画刷计入诊断 */
    function fillAttrs() {
        const brush = dc.brush;
        if (!brush || brush.style === BS_NULL) return { fill: 'none' };
        if (brush.style !== 0) note(`EMR_CREATEBRUSHINDIRECT(style=${brush.style})`, 'drawing');
        return {
            fill: brush.color,
            'fill-rule': dc.polyFillMode === POLYFILL_ALTERNATE ? 'evenodd' : undefined,
        };
    }

    const emitShape = (markup) => {
        diagnostics.counters.shapes += 1;
        diagnostics.counters.classicDrawn += 1;
        writer.emit(markup, dc.clip);
    };
    const emitPath = (data, matrix, fill, stroke) => {
        if (!data) return;
        emitShape(writer.element('path', {
            d: data,
            ...(fill ? fillAttrs() : { fill: 'none' }),
            ...(stroke ? strokeAttrs(matrix) : { stroke: 'none' }),
        }));
    };

    /** 读一组点并变换到设备坐标 */
    function readPoints(offset, count, small) {
        budget.checkPoints(count);
        const matrix = deviceMatrix();
        const points = new Array(count);
        for (let index = 0; index < count; index += 1) {
            const at = offset + index * (small ? 4 : 8);
            points[index] = small
                ? transformPoint(matrix, reader.i16(at), reader.i16(at + 2))
                : transformPoint(matrix, reader.i32(at), reader.i32(at + 4));
        }
        return { points, matrix };
    }
    /** 折线族记录的最后一个原始（未变换）点，用于更新当前点 */
    function lastRawPoint(offset, count, small) {
        const at = offset + (count - 1) * (small ? 4 : 8);
        return small ? [reader.i16(at), reader.i16(at + 2)] : [reader.i32(at), reader.i32(at + 4)];
    }
    /** 三点一组的三次贝塞尔 */
    function bezierData(points, start) {
        let data = '';
        for (let index = start; index + 2 < points.length; index += 3) {
            const [c1, c2, end] = [points[index], points[index + 1], points[index + 2]];
            data += `C${formatNumber(c1[0])} ${formatNumber(c1[1])} ${formatNumber(c2[0])} ${formatNumber(c2[1])}`
                + ` ${formatNumber(end[0])} ${formatNumber(end[1])}`;
        }
        return data;
    }

    // ---------------- 状态记录 ----------------

    function applyMappingRecord(type, d) {
        switch (type) {
            case EMR.SETMAPMODE: dc.mapMode = reader.u32(d); return true;
            case EMR.SETWINDOWEXTEX: dc.windowExtent = [reader.i32(d), reader.i32(d + 4)]; return true;
            case EMR.SETWINDOWORGEX: dc.windowOrigin = [reader.i32(d), reader.i32(d + 4)]; return true;
            case EMR.SETVIEWPORTEXTEX: dc.viewportExtent = [reader.i32(d), reader.i32(d + 4)]; return true;
            case EMR.SETVIEWPORTORGEX: dc.viewportOrigin = [reader.i32(d), reader.i32(d + 4)]; return true;
            case EMR.SCALEVIEWPORTEXTEX:
                dc.viewportExtent = scaleExtent(dc.viewportExtent, d);
                return true;
            case EMR.SCALEWINDOWEXTEX:
                dc.windowExtent = scaleExtent(dc.windowExtent, d);
                return true;
            default: return false;
        }
    }
    /** xNum／xDenom、yNum／yDenom 四个 i32 */
    function scaleExtent(extent, d) {
        const [xNum, xDen, yNum, yDen] = [reader.i32(d), reader.i32(d + 4), reader.i32(d + 8), reader.i32(d + 12)];
        return [xDen ? extent[0] * xNum / xDen : extent[0], yDen ? extent[1] * yNum / yDen : extent[1]];
    }

    function applyTransformRecord(type, d) {
        switch (type) {
            case EMR.SETWORLDTRANSFORM:
                dc.worldTransform = readXform(d);
                return true;
            case EMR.MODIFYWORLDTRANSFORM:
                dc.worldTransform = modifyWorldTransform(readXform(d), reader.u32(d + 24));
                return true;
            case EMR.SAVEDC:
                budget.checkStack(stack.length);
                stack.push({ ...dc });
                return true;
            case EMR.RESTOREDC:
                restoreDeviceContext(reader.i32(d));
                return true;
            default: return false;
        }
    }
    const readXform = (d) => [0, 1, 2, 3, 4, 5].map((k) => reader.f32(d + 4 * k));
    function modifyWorldTransform(xform, mode) {
        if (mode === MWT.IDENTITY) return IDENTITY_MATRIX;
        if (mode === MWT.LEFTMULTIPLY) return multiplyMatrix(xform, dc.worldTransform);
        if (mode === MWT.RIGHTMULTIPLY) return multiplyMatrix(dc.worldTransform, xform);
        if (mode === MWT.SET) return xform;
        note(`EMR_MODIFYWORLDTRANSFORM(mode=${mode})`, 'state');
        return dc.worldTransform;
    }
    /** 负数按相对层数回退，正数按保存层级（1 基）恢复 */
    function restoreDeviceContext(saved) {
        const index = saved < 0 ? stack.length + saved : saved - 1;
        if (index < 0 || index >= stack.length) return;
        dc = { ...stack[index] };
        stack.length = index;
    }

    function applyAttributeRecord(type, d) {
        switch (type) {
            case EMR.SETBKMODE: dc.bkMode = reader.u32(d); return true;
            case EMR.SETBKCOLOR: dc.bkColor = colorRef(reader.u32(d)); return true;
            case EMR.SETTEXTCOLOR: dc.textColor = colorRef(reader.u32(d)); return true;
            case EMR.SETTEXTALIGN: dc.textAlign = reader.u32(d); return true;
            case EMR.SETPOLYFILLMODE: dc.polyFillMode = reader.u32(d); return true;
            case EMR.SETMITERLIMIT: dc.miterLimit = reader.u32(d); return true;
            case EMR.MOVETOEX: moveTo([reader.i32(d), reader.i32(d + 4)]); return true;
            default: return false;
        }
    }
    function moveTo(point) {
        dc.currentPoint = point;
        if (!path) return;
        const device = transformPoint(deviceMatrix(), point[0], point[1]);
        path.data += `M${formatNumber(device[0])} ${formatNumber(device[1])}`;
    }

    // ---------------- 对象表 ----------------

    function applyObjectRecord(type, d) {
        switch (type) {
            case EMR.CREATEPEN: objects.set(reader.u32(d), readLogPen(d)); return true;
            case EMR.EXTCREATEPEN: objects.set(reader.u32(d), readExtLogPen(d)); return true;
            case EMR.CREATEBRUSHINDIRECT:
                objects.set(reader.u32(d), { kind: 'brush', style: reader.u32(d + 4), color: colorRef(reader.u32(d + 8)) });
                return true;
            case EMR.EXTCREATEFONTINDIRECTW: objects.set(reader.u32(d), readLogFont(d)); return true;
            case EMR.SELECTOBJECT: selectObject(reader.u32(d)); return true;
            case EMR.DELETEOBJECT: objects.delete(reader.u32(d)); return true;
            default: return false;
        }
    }
    const readLogPen = (d) => ({
        kind: 'pen',
        style: reader.u32(d + 4) & 0xF,
        width: reader.i32(d + 8),
        color: colorRef(reader.u32(d + 16)),
        cosmetic: reader.i32(d + 8) === 0,
        endCap: 0,
        join: 0,
    });
    function readExtLogPen(d) {
        const style = reader.u32(d + 20);
        return {
            kind: 'pen',
            style: style & 0xF,
            width: reader.u32(d + 24),
            color: colorRef(reader.u32(d + 32)),
            cosmetic: (style & PS_TYPE_MASK) !== PS_GEOMETRIC,
            endCap: style & PS_ENDCAP_MASK,
            join: style & PS_JOIN_MASK,
        };
    }
    function readLogFont(d) {
        const face = reader.utf16(d + 32, FACE_NAME_CHARS).split('\x00')[0];
        return {
            kind: 'font',
            face,
            height: reader.i32(d + 4),
            escapement: reader.i32(d + 12),
            weight: reader.i32(d + 20),
            italic: reader.u8(d + 24),
            charSet: reader.u8(d + 27),
        };
    }
    function selectObject(handle) {
        const object = handle >= STOCK_HANDLE_BASE ? STOCK_OBJECTS[handle] : objects.get(handle);
        if (object) dc[object.kind] = object;
    }

    // ---------------- 裁剪 ----------------

    function applyClipRecord(type, d) {
        switch (type) {
            case EMR.INTERSECTCLIPRECT: {
                const matrix = deviceMatrix();
                const a = transformPoint(matrix, reader.i32(d), reader.i32(d + 4));
                const b = transformPoint(matrix, reader.i32(d + 8), reader.i32(d + 12));
                const rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
                dc.clip = writer.intersectClip(scope, dc.clip, writer.rectClip(scope, rect));
                return true;
            }
            case EMR.EXCLUDECLIPRECT: note(emrName(type), 'state'); return true;
            case EMR.OFFSETCLIPRGN: note(emrName(type), 'state'); return true;
            case EMR.SELECTCLIPPATH: selectClipPath(reader.u32(d)); return true;
            case EMR.EXTSELECTCLIPRGN: extSelectClipRgn(d); return true;
            default: return false;
        }
    }
    function selectClipPath(mode) {
        const data = path ? path.data : '';
        path = null;
        if (!data || (mode !== RGN.COPY && mode !== RGN.AND)) {
            note(`EMR_SELECTCLIPPATH(mode=${mode})`, 'state');
            return;
        }
        const rule = dc.polyFillMode === POLYFILL_ALTERNATE ? 'evenodd' : 'nonzero';
        const next = writer.pathClip(`${scope}p:${diagnostics.counters.records}`, data, rule);
        dc.clip = mode === RGN.AND ? writer.intersectClip(scope, dc.clip, next) : next;
    }
    function extSelectClipRgn(d) {
        const regionBytes = reader.u32(d);
        const mode = reader.u32(d + 4);
        if (mode === RGN.COPY && regionBytes === 0) { dc.clip = null; return; }
        if ((mode !== RGN.COPY && mode !== RGN.AND) || regionBytes < REGION_HEADER_BYTES) {
            note(`EMR_EXTSELECTCLIPRGN(mode=${mode})`, 'state');
            return;
        }
        const next = readRegionClip(d + 8);
        dc.clip = mode === RGN.AND ? writer.intersectClip(scope, dc.clip, next) : next;
    }
    function readRegionClip(base) {
        const count = reader.u32(base + 8);
        if (count > budget.limits.maxClipRects) {
            throw new MetafileError('LIMIT_EXCEEDED', `裁剪区矩形数 ${count} 超过上限（${budget.limits.maxClipRects}）`);
        }
        const rects = [];
        for (let index = 0; index < count; index += 1) {
            const at = base + REGION_HEADER_BYTES + index * 16;
            rects.push([reader.i32(at), reader.i32(at + 4), reader.i32(at + 8), reader.i32(at + 12)]);
        }
        if (rects.length === 1) return writer.rectClip(scope, rects[0]);
        const markup = rects.map((rect) => writer.rectClip(scope, rect).markup).join('');
        return writer.listClip(`${scope}g:${diagnostics.counters.records}`, markup);
    }

    // ---------------- 路径括号 ----------------

    function applyPathRecord(type, draw) {
        switch (type) {
            case EMR.BEGINPATH: path = { data: '' }; return true;
            case EMR.ENDPATH: return true;
            case EMR.ABORTPATH: path = null; return true;
            case EMR.CLOSEFIGURE: if (path) path.data += 'Z'; return true;
            case EMR.FILLPATH: case EMR.STROKEANDFILLPATH: case EMR.STROKEPATH: {
                const data = path ? path.data : '';
                path = null;
                if (!draw) { diagnostics.counters.classicSuppressed += 1; return true; }
                emitPath(data, deviceMatrix(), type !== EMR.STROKEPATH, type !== EMR.FILLPATH);
                return true;
            }
            default: return false;
        }
    }

    // ---------------- 绘图记录 ----------------

    function drawPolyRecord(type, d) {
        const small = SMALL_POINT_TYPES.has(type);
        switch (type) {
            case EMR.POLYLINE16: case EMR.POLYLINE:
                return drawPolyList(d, small, false);
            case EMR.POLYGON16: case EMR.POLYGON:
                return drawPolyList(d, small, true);
            case EMR.POLYBEZIER16: case EMR.POLYBEZIER:
                return drawPolyBezier(d, small);
            case EMR.POLYLINETO16: case EMR.POLYLINETO: case EMR.POLYBEZIERTO16: case EMR.POLYBEZIERTO:
                return drawPolyTo(d, small, type === EMR.POLYBEZIERTO16 || type === EMR.POLYBEZIERTO);
            case EMR.POLYPOLYLINE16: case EMR.POLYPOLYLINE: case EMR.POLYPOLYGON16: case EMR.POLYPOLYGON:
                return drawPolyPoly(d, small, type === EMR.POLYPOLYGON16 || type === EMR.POLYPOLYGON);
            default: return false;
        }
    }
    function drawPolyList(d, small, closed) {
        const { points, matrix } = readPoints(d + 20, reader.u32(d + 16), small);
        if (points.length < 2) return true;
        if (path) { path.data += subpathData(points, closed); return true; }
        const attrs = closed
            ? { points: pointsAttr(points), ...fillAttrs(), ...strokeAttrs(matrix) }
            : { points: pointsAttr(points), fill: 'none', ...strokeAttrs(matrix) };
        emitShape(writer.element(closed ? 'polygon' : 'polyline', attrs));
        return true;
    }
    function drawPolyBezier(d, small) {
        const { points, matrix } = readPoints(d + 20, reader.u32(d + 16), small);
        if (points.length < 4) return true;
        const data = `M${formatNumber(points[0][0])} ${formatNumber(points[0][1])}${bezierData(points, 1)}`;
        if (path) path.data += data;
        else emitPath(data, matrix, false, true);
        return true;
    }
    function drawPolyTo(d, small, bezier) {
        const count = reader.u32(d + 16);
        const { points, matrix } = readPoints(d + 20, count, small);
        const start = transformPoint(matrix, dc.currentPoint[0], dc.currentPoint[1]);
        const segment = bezier
            ? bezierData(points, 0)
            : points.map((p) => `L${formatNumber(p[0])} ${formatNumber(p[1])}`).join('');
        if (path) {
            if (!path.data || path.data.endsWith('Z')) path.data += `M${formatNumber(start[0])} ${formatNumber(start[1])}`;
            path.data += segment;
        } else {
            emitPath(`M${formatNumber(start[0])} ${formatNumber(start[1])}${segment}`, matrix, false, true);
        }
        if (count > 0) dc.currentPoint = lastRawPoint(d + 20, count, small);
        return true;
    }
    function drawPolyPoly(d, small, closed) {
        const polyCount = reader.u32(d + 16);
        budget.checkPoints(polyCount);
        const counts = [];
        for (let index = 0; index < polyCount; index += 1) counts.push(reader.u32(d + 24 + 4 * index));
        const { points, matrix } = readPoints(d + 24 + 4 * polyCount, reader.u32(d + 20), small);
        let at = 0;
        let data = '';
        for (const count of counts) {
            const part = points.slice(at, at + count);
            at += count;
            if (part.length >= 2) data += subpathData(part, closed);
        }
        if (path) path.data += data;
        else emitPath(data, matrix, closed, true);
        return true;
    }

    function drawShapeRecord(type, record) {
        const d = record.dataOffset;
        switch (type) {
            case EMR.RECTANGLE: case EMR.ELLIPSE: case EMR.ROUNDRECT: return drawBoxRecord(type, d);
            case EMR.LINETO: return drawLineTo(d);
            case EMR.BITBLT: return drawBitBlt(d);
            case EMR.EXTTEXTOUTW: return drawText(record, true);
            case EMR.EXTTEXTOUTA: return drawText(record, false);
            default: return false;
        }
    }
    function drawBoxRecord(type, d) {
        const matrix = deviceMatrix();
        const a = transformPoint(matrix, reader.i32(d), reader.i32(d + 4));
        const b = transformPoint(matrix, reader.i32(d + 8), reader.i32(d + 12));
        const [x, y] = [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
        const [w, h] = [Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
        if (type === EMR.ELLIPSE) {
            emitShape(writer.element('ellipse', {
                cx: formatNumber(x + w / 2), cy: formatNumber(y + h / 2),
                rx: formatNumber(w / 2), ry: formatNumber(h / 2),
                ...fillAttrs(), ...strokeAttrs(matrix),
            }));
            return true;
        }
        const scale = matrixScale(matrix);
        const rx = type === EMR.ROUNDRECT ? reader.i32(d + 16) * scale / 2 : 0;
        const ry = type === EMR.ROUNDRECT ? reader.i32(d + 20) * scale / 2 : 0;
        emitShape(writer.element('rect', {
            x: formatNumber(x), y: formatNumber(y), width: formatNumber(w), height: formatNumber(h),
            rx: rx ? formatNumber(rx) : undefined, ry: ry ? formatNumber(ry) : undefined,
            ...fillAttrs(), ...strokeAttrs(matrix),
        }));
        return true;
    }
    function drawLineTo(d) {
        const matrix = deviceMatrix();
        const from = transformPoint(matrix, dc.currentPoint[0], dc.currentPoint[1]);
        const target = [reader.i32(d), reader.i32(d + 4)];
        const to = transformPoint(matrix, target[0], target[1]);
        if (path) path.data += `L${formatNumber(to[0])} ${formatNumber(to[1])}`;
        else {
            emitShape(writer.element('line', {
                x1: formatNumber(from[0]), y1: formatNumber(from[1]),
                x2: formatNumber(to[0]), y2: formatNumber(to[1]),
                ...strokeAttrs(matrix),
            }));
        }
        dc.currentPoint = target;
        return true;
    }
    /** BITBLT：空操作 ROP 与带位图的记录都不画；少数不带位图的 ROP 按矩形填充 */
    function drawBitBlt(d) {
        const rop = reader.u32(d + 32);
        const bitmapBytes = reader.u32(d + 88);
        if (rop === ROP_NOOP) return true;
        if (bitmapBytes !== 0 || (rop !== ROP_PATCOPY && rop !== ROP_BLACKNESS && rop !== ROP_WHITENESS)) {
            note(emrName(EMR.BITBLT), 'drawing');
            return true;
        }
        const matrix = deviceMatrix();
        const a = transformPoint(matrix, reader.i32(d + 16), reader.i32(d + 20));
        const b = transformPoint(matrix, reader.i32(d + 16) + reader.i32(d + 24), reader.i32(d + 20) + reader.i32(d + 28));
        let fill = dc.brush && dc.brush.style === 0 ? dc.brush.color : 'none';
        if (rop === ROP_BLACKNESS) fill = '#000000';
        if (rop === ROP_WHITENESS) fill = '#ffffff';
        emitShape(writer.element('rect', {
            x: formatNumber(Math.min(a[0], b[0])), y: formatNumber(Math.min(a[1], b[1])),
            width: formatNumber(Math.abs(b[0] - a[0])), height: formatNumber(Math.abs(b[1] - a[1])),
            fill,
        }));
        return true;
    }

    // ---------------- 文字 ----------------

    /** EmrText 的头部字段 */
    function readTextHeader(record) {
        const at = record.offset + EMRTEXT_OFFSET;
        return {
            referenceX: reader.i32(at),
            referenceY: reader.i32(at + 4),
            chars: reader.u32(at + 8),
            offString: reader.u32(at + 12),
            options: reader.u32(at + 16),
            offDx: reader.u32(at + 36),
        };
    }
    /** Dx 数组（逐字推进量）；偏移必须落在本记录之内 */
    function readDxArray(record, head) {
        if (!head.offDx) return null;
        const stride = (head.options & ETO_PDY) ? 8 : 4;
        if (head.offDx + head.chars * stride > record.size) {
            throw new MetafileError('MALFORMED', '文字记录的 offDx 越过记录边界');
        }
        const dxs = [];
        for (let index = 0; index < head.chars; index += 1) dxs.push(reader.u32(record.offset + head.offDx + index * stride));
        return dxs;
    }
    /** 水平对齐：有 Dx 时按总宽度回退参考点，无 Dx 时交给 text-anchor */
    function textPlacement(head, dxs) {
        const horizontal = dc.textAlign & TA_HORIZONTAL_MASK;
        if (!dxs) {
            if (horizontal === TA_CENTER) return { x0: head.referenceX, anchor: 'middle' };
            if (horizontal === TA_RIGHT) return { x0: head.referenceX, anchor: 'end' };
            return { x0: head.referenceX, anchor: '' };
        }
        const total = dxs.reduce((sum, step) => sum + step, 0);
        if (horizontal === TA_CENTER) return { x0: head.referenceX - total / 2, anchor: '' };
        if (horizontal === TA_RIGHT) return { x0: head.referenceX - total, anchor: '' };
        return { x0: head.referenceX, anchor: '' };
    }
    /** 垂直对齐 → 基线相对参考点的偏移（单位 em） */
    function baselineOffset(font) {
        const vertical = dc.textAlign & TA_VERTICAL_MASK;
        if (vertical === TA_BASELINE) return 0;
        const ascent = ascentOf(font.face);
        return vertical === TA_BOTTOM ? -(CELL_TOTAL_EM - ascent) : ascent;
    }
    function noteFontDiagnostics(font, text) {
        if (isSymbolFont(font.face, font.charSet)) note(`EMR_EXTTEXTOUTW(符号字体 ${font.face})`, 'drawing');
        else if (hasPrivateUseChars(text)) note('EMR_EXTTEXTOUTW(私用区字符)', 'drawing');
        if (dc.bkMode === BKMODE_OPAQUE) note('EMR_EXTTEXTOUTW(OPAQUE 背景未绘制)', 'drawing');
    }
    function drawText(record, wide) {
        const head = readTextHeader(record);
        if (head.chars === 0) return true;
        if (head.chars > budget.limits.maxTextChars) {
            throw new MetafileError('LIMIT_EXCEEDED', `单条文字记录 ${head.chars} 字符超过上限（${budget.limits.maxTextChars}）`);
        }
        if (head.options & ETO_GLYPH_INDEX) { note('EMR_EXTTEXTOUTW(ETO_GLYPH_INDEX)', 'drawing'); return true; }
        const bytes = head.chars * (wide ? 2 : 1);
        if (head.offString + bytes > record.size) throw new MetafileError('MALFORMED', '文字记录的 offString 越过记录边界');
        const at = record.offset + head.offString;
        const text = wide ? reader.utf16(at, head.chars) : reader.latin1(at, head.chars);
        const font = dc.font || STOCK_OBJECTS[0x8000000D];
        const dxs = readDxArray(record, head);
        noteFontDiagnostics(font, text);
        const { x0, anchor } = textPlacement(head, dxs);
        diagnostics.counters.text += 1;
        diagnostics.counters.classicDrawn += 1;
        writer.emit(writer.textMarkup({
            text,
            x0,
            y0: head.referenceY,
            matrix: deviceMatrix(),
            face: font.face,
            em: font.height < 0 ? -font.height : (font.height || 12) * CELL_HEIGHT_TO_EM,
            bold: font.weight >= 600,
            italic: !!font.italic,
            color: dc.textColor,
            alpha: 1,
            baselineOffsetEm: baselineOffset(font),
            anchor,
            dxs,
            rotateDeg: font.escapement ? -font.escapement / ESCAPEMENT_PER_DEGREE : 0,
        }), dc.clip);
        return true;
    }

    // ---------------- 分发 ----------------

    /** 一条经典记录；draw 为 false 时绘图记录只计数不落笔（GDI+ 仲裁语义，W2 使用） */
    function handleRecord(type, record, draw) {
        if (applyPathRecord(type, draw)) return;
        if (!draw && DRAWING_TYPES.has(type)) {
            diagnostics.counters.classicSuppressed += 1;
            if (!(path && PATH_ACCUMULATING_TYPES.has(type))) return;
        }
        const d = record.dataOffset;
        if (applyMappingRecord(type, d)) return;
        if (applyTransformRecord(type, d)) return;
        if (applyAttributeRecord(type, d)) return;
        if (applyObjectRecord(type, d)) return;
        if (applyClipRecord(type, d)) return;
        if (drawPolyRecord(type, d)) return;
        if (drawShapeRecord(type, record)) return;
        if (!IGNORABLE_TYPES.has(type)) note(emrName(type), DRAWING_TYPES.has(type) ? 'drawing' : 'state');
    }

    return {
        handleRecord,
        state: () => dc,
        stackDepth: () => stack.length,
    };
}

module.exports = {
    createClassicReplayer,
    createDeviceContext,
    STOCK_OBJECTS,
    DRAWING_TYPES,
    IGNORABLE_TYPES,
    SUPPORTED_TYPES,
};
