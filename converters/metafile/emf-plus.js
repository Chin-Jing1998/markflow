'use strict';
/**
 * EMF+ 记录回放：页面与世界变换、Save／Restore、三类裁剪、对象表与续接、各绘图记录、内嵌图元
 *
 * 职责边界：本模块只管「一条 EMF+ 记录如何改变 GDI+ 状态、如何变成一个图形」。记录怎么从
 * EMR_GDICOMMENT 里迭代出来由 reader.js 负责，二进制对象怎么解析由 emf-plus-objects.js 负责，
 * 图形怎么落成字符串由 svg-writer.js 负责，两套记录如何仲裁由 index.js 负责。
 *
 *   createPlusReplayer({ writer, budget, diagnostics, scope, minStrokeDev, drawNested })
 *     → { handleRecord(type, flags, data), scanRecord(type, flags, data), inGetDcSection(), info() }
 *
 *   - handleRecord 用于 stream='auto'：完整回放。单条记录解析失败只记诊断项、不中断整份转换
 *     （记录边界已由 reader.readPlusRecords 校验过，失败的只可能是记录内部的字段）；
 *     唯有 LIMIT_EXCEEDED 逐层上抛，因为它意味着资源护栏被触发。
 *   - scanRecord 用于 stream='classic'：只清点记录数并读 EmfPlusHeader，不回放、不出图。
 *   - inGetDcSection 给 index.js 判定经典绘图记录是否放行：[MS-EMFPLUS] 1.3.1 规定 EmfPlusGetDC
 *     之后的 EMF 记录一直回放到「下一条任意类型的 EMF+ 记录」为止。
 *   - drawNested(metafileBuffer, matrix, clip) 由 index.js 注入：递归深度、序号与片段包裹都在那里，
 *     本模块只负责算出「内嵌设备坐标 → 外层设备坐标」的仿射矩阵。
 *
 * 坐标链：EMF+ 逻辑坐标 —世界变换—→ 页面坐标 —页面单位与页面缩放—→ 设备坐标。页面缩放同时作用于
 * 坐标、笔宽与字号（样稿的 A 族缩放 0.24 即由此而来，见调研报告 2.4 的实测取值表）。
 */
const { MetafileError } = require('./reader');
const {
    IDENTITY_MATRIX, multiplyMatrix, transformPoint, matrixScale, isAxisAligned,
    formatNumber, subpathData,
} = require('./svg-writer');
const { ascentOf } = require('./fonts');
const {
    UNIT, REGION_NODE, OBJECT_CONTINUED_FLAG,
    argbColor, readPlusPoints, readPlusRect, rectBytes, parsePlusObject, objectChunk, pathData,
} = require('./emf-plus-objects');

/** EmfPlusRecordType（[MS-EMFPLUS] 2.1.1.1）本模块用到的子集 */
const PLUS = Object.freeze({
    HEADER: 0x4001, EOF: 0x4002, COMMENT: 0x4003, GET_DC: 0x4004, OBJECT: 0x4008,
    FILL_RECTS: 0x400A, DRAW_RECTS: 0x400B, FILL_POLYGON: 0x400C, DRAW_LINES: 0x400D,
    FILL_ELLIPSE: 0x400E, DRAW_ELLIPSE: 0x400F, FILL_PATH: 0x4014, DRAW_PATH: 0x4015,
    DRAW_IMAGE: 0x401A, DRAW_IMAGE_POINTS: 0x401B, DRAW_STRING: 0x401C,
    SAVE: 0x4025, RESTORE: 0x4026, BEGIN_CONTAINER: 0x4027,
    BEGIN_CONTAINER_NO_PARAMS: 0x4028, END_CONTAINER: 0x4029,
    SET_WORLD_TRANSFORM: 0x402A, RESET_WORLD_TRANSFORM: 0x402B, MULTIPLY_WORLD_TRANSFORM: 0x402C,
    TRANSLATE_WORLD_TRANSFORM: 0x402D, SCALE_WORLD_TRANSFORM: 0x402E, ROTATE_WORLD_TRANSFORM: 0x402F,
    SET_PAGE_TRANSFORM: 0x4030, RESET_CLIP: 0x4031, SET_CLIP_RECT: 0x4032,
    SET_CLIP_PATH: 0x4033, SET_CLIP_REGION: 0x4034,
});

/** 记录类型 → 规范名（诊断项与 inspectMetafile 的直方图都用它） */
const PLUS_NAMES = Object.freeze({
    0x4001: 'EmfPlusHeader', 0x4002: 'EmfPlusEndOfFile', 0x4003: 'EmfPlusComment', 0x4004: 'EmfPlusGetDC',
    0x4005: 'EmfPlusMultiFormatStart', 0x4006: 'EmfPlusMultiFormatSection', 0x4007: 'EmfPlusMultiFormatEnd',
    0x4008: 'EmfPlusObject', 0x4009: 'EmfPlusClear', 0x400A: 'EmfPlusFillRects', 0x400B: 'EmfPlusDrawRects',
    0x400C: 'EmfPlusFillPolygon', 0x400D: 'EmfPlusDrawLines', 0x400E: 'EmfPlusFillEllipse',
    0x400F: 'EmfPlusDrawEllipse', 0x4010: 'EmfPlusFillPie', 0x4011: 'EmfPlusDrawPie', 0x4012: 'EmfPlusDrawArc',
    0x4013: 'EmfPlusFillRegion', 0x4014: 'EmfPlusFillPath', 0x4015: 'EmfPlusDrawPath',
    0x4016: 'EmfPlusFillClosedCurve', 0x4017: 'EmfPlusDrawClosedCurve', 0x4018: 'EmfPlusDrawCurve',
    0x4019: 'EmfPlusDrawBeziers', 0x401A: 'EmfPlusDrawImage', 0x401B: 'EmfPlusDrawImagePoints',
    0x401C: 'EmfPlusDrawString', 0x401D: 'EmfPlusSetRenderingOrigin', 0x401E: 'EmfPlusSetAntiAliasMode',
    0x401F: 'EmfPlusSetTextRenderingHint', 0x4020: 'EmfPlusSetTextContrast',
    0x4021: 'EmfPlusSetInterpolationMode', 0x4022: 'EmfPlusSetPixelOffsetMode',
    0x4023: 'EmfPlusSetCompositingMode', 0x4024: 'EmfPlusSetCompositingQuality',
    0x4025: 'EmfPlusSave', 0x4026: 'EmfPlusRestore', 0x4027: 'EmfPlusBeginContainer',
    0x4028: 'EmfPlusBeginContainerNoParams', 0x4029: 'EmfPlusEndContainer',
    0x402A: 'EmfPlusSetWorldTransform', 0x402B: 'EmfPlusResetWorldTransform',
    0x402C: 'EmfPlusMultiplyWorldTransform', 0x402D: 'EmfPlusTranslateWorldTransform',
    0x402E: 'EmfPlusScaleWorldTransform', 0x402F: 'EmfPlusRotateWorldTransform',
    0x4030: 'EmfPlusSetPageTransform', 0x4031: 'EmfPlusResetClip', 0x4032: 'EmfPlusSetClipRect',
    0x4033: 'EmfPlusSetClipPath', 0x4034: 'EmfPlusSetClipRegion', 0x4035: 'EmfPlusOffsetClip',
    0x4036: 'EmfPlusDrawDriverString', 0x4037: 'EmfPlusStrokeFillPath',
    0x4038: 'EmfPlusSerializableObject', 0x4039: 'EmfPlusSetTSGraphics', 0x403A: 'EmfPlusSetTSClip',
});
/** 记录类型 → 诊断用名称；表外的按 EmfPlus0x<号> 生成 */
const plusName = (type) => PLUS_NAMES[type] || `EmfPlus0x${type.toString(16)}`;

/** 会产生画面的记录（未实现时按 kind: 'drawing' 记诊断） */
const PLUS_DRAWING_TYPES = Object.freeze(new Set([
    0x4009, 0x400A, 0x400B, 0x400C, 0x400D, 0x400E, 0x400F, 0x4010, 0x4011, 0x4012, 0x4013,
    0x4014, 0x4015, 0x4016, 0x4017, 0x4018, 0x4019, 0x401A, 0x401B, 0x401C, 0x4036, 0x4037,
]));
/** 只影响渲染质量、不影响几何的记录：静默忽略，不进诊断 */
const PLUS_IGNORABLE_TYPES = Object.freeze(new Set([
    0x4002, 0x401D, 0x401E, 0x401F, 0x4020, 0x4021, 0x4022, 0x4023, 0x4024,
]));
/** 本模块实际处理（或按无害忽略）的记录类型，供 inspectMetafile 判定未支持项 */
const PLUS_SUPPORTED_TYPES = Object.freeze(new Set([
    ...Object.values(PLUS), ...PLUS_IGNORABLE_TYPES,
]));

/** 对象 id 在标志位的低 8 位，对象类型在第 8–14 位 */
const OBJECT_ID_MASK = 0x00FF;
const OBJECT_TYPE_SHIFT = 8;
const OBJECT_TYPE_MASK = 0x7F;
/** 裁剪合并方式在标志位的第 8–11 位 */
const COMBINE_MODE_SHIFT = 8;
const COMBINE_MODE_MASK = 0x0F;
const COMBINE_REPLACE = 0;
const COMBINE_INTERSECT = 1;
/** 绘图记录的 S 位：画刷 id 字段改为内联 ARGB */
const INLINE_COLOR_FLAG = 0x8000;
/** DrawLines 的 L 位：闭合折线 */
const CLOSE_FIGURE_FLAG = 0x2000;
/** 变换记录的 O 位：后乘（置位）或前乘（复位） */
const POST_MULTIPLY_FLAG = 0x2000;
/** EmfPlusHeader 的 D 位：Dual（经典记录与 EMF+ 记录并存） */
const DUAL_FLAG = 0x0001;
/** EmfPlusHeader 数据段：Version、EmfPlusFlags、LogicalDpiX、LogicalDpiY */
const HEADER_DPI_OFFSET = 8;
const DEFAULT_DPI = 96;
/** SetPageTransform 的页面单位在标志位低 8 位 */
const PAGE_UNIT_MASK = 0x00FF;
/** 单位 → 每单位的设备像素数（World 与 Pixel 由页面缩放决定，因此取 1） */
const UNIT_FACTORS = Object.freeze({
    [UNIT.WORLD]: () => 1,
    [UNIT.DISPLAY]: () => 1,
    [UNIT.PIXEL]: () => 1,
    [UNIT.POINT]: (dpi) => dpi / 72,
    [UNIT.INCH]: (dpi) => dpi,
    [UNIT.DOCUMENT]: (dpi) => dpi / 300,
    [UNIT.MILLIMETER]: (dpi) => dpi / 25.4,
});
/** 线帽与接头的取值映射（[MS-EMFPLUS] 2.1.1.19 LineCapType、2.1.1.20 LineJoinType） */
const LINE_CAPS = Object.freeze({ 0: 'butt', 1: 'square', 2: 'round' });
const LINE_JOINS = Object.freeze({ 0: 'miter', 1: 'bevel', 2: 'round', 3: 'miter' });
/** DashedLineCapType 未给出节距时按线宽比例的近似节距 */
const LINE_STYLE_DASHES = Object.freeze({ 1: [3, 1], 2: [1, 1], 3: [3, 1, 1, 1], 4: [3, 1, 1, 1, 1, 1] });
/** StringAlignment：Near／Center／Far */
const ALIGN_CENTER = 1;
const ALIGN_FAR = 2;
/** 缺省 StringFormat 的左右留白（GenericDefault 为 1/6 em） */
const DEFAULT_MARGIN_EM = 1 / 6;
/** 行高相对 em 的比例，只用于 LineAlignment 的居中与靠下 */
const LINE_HEIGHT_EM = 1.15;
/** 字体样式位：粗体、斜体 */
const FONT_STYLE_BOLD = 0x01;
const FONT_STYLE_ITALIC = 0x02;
/** DrawString 的字符数上限由 limits.maxTextChars 约束 */
const STRING_LAYOUT_OFFSET = 12;
const STRING_TEXT_OFFSET = 28;
/** DrawImage(Points) 的 SrcRect 偏移与三点平行四边形的点数 */
const IMAGE_SRC_OFFSET = 8;
const IMAGE_DEST_OFFSET = 24;
const IMAGE_POINT_COUNT = 3;
/** ChemDraw 的 CDX 载荷判据：注释以 CDIF 开头且含 CDX 文档魔数 */
const CDIF_TAG = 'CDIF';
const CDX_MAGIC = 'VjCD0100';
/** 椭圆的四段三次贝塞尔近似系数 */
const ELLIPSE_KAPPA = 0.5522847498307936;

/** 椭圆 → 四段贝塞尔的 13 个控制点（首尾重合） */
function ellipsePoints(rect) {
    const [x, y, w, h] = rect;
    const [cx, cy, rx, ry] = [x + w / 2, y + h / 2, w / 2, h / 2];
    const [kx, ky] = [ELLIPSE_KAPPA * rx, ELLIPSE_KAPPA * ry];
    return [
        [cx + rx, cy], [cx + rx, cy + ky], [cx + kx, cy + ry], [cx, cy + ry],
        [cx - kx, cy + ry], [cx - rx, cy + ky], [cx - rx, cy], [cx - rx, cy - ky],
        [cx - kx, cy - ry], [cx, cy - ry], [cx + kx, cy - ry], [cx + rx, cy - ky], [cx + rx, cy],
    ];
}

/** 矩形的四角（按左上、右上、右下、左下） */
const rectCorners = (rect) => [
    [rect[0], rect[1]], [rect[0] + rect[2], rect[1]],
    [rect[0] + rect[2], rect[1] + rect[3]], [rect[0], rect[1] + rect[3]],
];

/** EmfPlusHeader 的 D 位与 LogicalDpi；回放器与 inspectMetafile 共用，二进制布局只写一处 */
function readHeaderInfo(flags, data) {
    const info = { dual: (flags & DUAL_FLAG) === DUAL_FLAG, logicalDpi: null };
    if (data.length >= HEADER_DPI_OFFSET + 8) {
        info.logicalDpi = [data.readUInt32LE(HEADER_DPI_OFFSET), data.readUInt32LE(HEADER_DPI_OFFSET + 4)];
    }
    return info;
}

/** ChemDraw 判据：EmfPlusComment 以 CDIF 开头且含 CDX 文档魔数（ChemDraw 把 CDX 切块塞进注释） */
function isChemDrawComment(data) {
    if (data.length < CDIF_TAG.length) return false;
    if (data.toString('latin1', 0, CDIF_TAG.length) !== CDIF_TAG) return false;
    return data.includes(CDX_MAGIC, 0, 'latin1');
}

function createPlusReplayer(context) {
    const { writer, budget, diagnostics, scope, minStrokeDev, drawNested } = context;
    const objects = new Map();
    const pending = new Map();
    const saved = new Map();
    const state = {
        present: false,
        dual: false,
        logicalDpi: null,
        dpi: [DEFAULT_DPI, DEFAULT_DPI],
        world: IDENTITY_MATRIX,
        pageUnit: UNIT.PIXEL,
        pageScale: 1,
        clip: null,
        getDc: false,
        hasChemDrawCdx: false,
    };

    const note = (name, kind) => diagnostics.note(name, kind);
    const parseContext = { note, checkPoints: (count) => budget.checkPoints(count) };
    const unitFactor = (unit, axis) => (UNIT_FACTORS[unit] || UNIT_FACTORS[UNIT.WORLD])(state.dpi[axis]);
    /** 逻辑坐标 → 设备坐标的总矩阵 */
    const pageMatrix = () => multiplyMatrix(state.world, [
        state.pageScale * unitFactor(state.pageUnit, 0), 0,
        0, state.pageScale * unitFactor(state.pageUnit, 1), 0, 0,
    ]);
    const devicePoints = (points, matrix) => points.map((point) => transformPoint(matrix, point[0], point[1]));

    // ---------------- 属性 ----------------

    /** 笔宽的单位换算：World 随变换缩放，Pixel 为设备单位，其余按 DPI 折算 */
    function penFactor(pen, matrix) {
        if (pen.unit === UNIT.WORLD) return matrixScale(matrix);
        if (pen.unit === UNIT.PIXEL || pen.unit === UNIT.DISPLAY) return 1;
        return unitFactor(pen.unit, 0);
    }
    function strokeAttrs(pen, matrix) {
        if (!pen || pen.kind !== 'pen') {
            return { stroke: '#000000', 'stroke-width': formatNumber(Math.max(1, minStrokeDev)) };
        }
        const factor = penFactor(pen, matrix);
        const width = Math.max((pen.width > 0 ? pen.width : 1 / factor) * factor, minStrokeDev);
        const join = LINE_JOINS[pen.join] || 'miter';
        const pattern = pen.dash || LINE_STYLE_DASHES[pen.lineStyle];
        return {
            stroke: pen.color,
            'stroke-opacity': pen.alpha < 1 ? formatNumber(pen.alpha) : undefined,
            'stroke-width': formatNumber(width),
            'stroke-linecap': LINE_CAPS[pen.startCap] || 'butt',
            'stroke-linejoin': join,
            'stroke-miterlimit': join === 'miter' ? formatNumber(Math.max(1, pen.miterLimit)) : undefined,
            'stroke-dasharray': pattern ? pattern.map((step) => formatNumber(step * width)).join(' ') : undefined,
        };
    }
    /** 填充属性：S 位置位时 brushId 字段本身就是 ARGB */
    function fillAttrs(flags, brushId) {
        const brush = (flags & INLINE_COLOR_FLAG)
            ? argbColor(brushId)
            : (objects.get(brushId & OBJECT_ID_MASK) || { color: '#000000', alpha: 1 });
        return {
            fill: brush.color,
            'fill-opacity': brush.alpha < 1 ? formatNumber(brush.alpha) : undefined,
        };
    }
    const penOf = (flags) => objects.get(flags & OBJECT_ID_MASK);
    const emitShape = (markup) => {
        diagnostics.counters.shapes += 1;
        diagnostics.counters.plusDrawn += 1;
        writer.emit(markup, state.clip);
    };

    // ---------------- 控制与对象 ----------------

    function readHeader(flags, data) {
        const info = readHeaderInfo(flags, data);
        state.present = true;
        state.dual = info.dual;
        if (!info.logicalDpi) return;
        state.logicalDpi = info.logicalDpi;
        state.dpi = [info.logicalDpi[0] || DEFAULT_DPI, info.logicalDpi[1] || DEFAULT_DPI];
    }
    function readComment(data) {
        if (isChemDrawComment(data)) state.hasChemDrawCdx = true;
    }
    function applyObjectRecord(flags, data) {
        const id = flags & OBJECT_ID_MASK;
        const objectType = (flags >> OBJECT_TYPE_SHIFT) & OBJECT_TYPE_MASK;
        let blob = data;
        if (flags & OBJECT_CONTINUED_FLAG) {
            blob = objectChunk(pending, id, data, budget.limits.maxObjectBytes);
            if (blob === null) return;
        }
        try {
            objects.set(id, parsePlusObject(objectType, blob, parseContext));
        } catch (error) {
            if (error instanceof MetafileError) throw error;
            note(`EmfPlusObject(type=${objectType} 解析失败)`, 'state');
        }
    }
    function applyControlRecord(type, flags, data) {
        switch (type) {
            case PLUS.HEADER: readHeader(flags, data); return true;
            case PLUS.COMMENT: readComment(data); return true;
            case PLUS.GET_DC:
                state.getDc = true;
                diagnostics.counters.getDcSections += 1;
                return true;
            case PLUS.OBJECT: applyObjectRecord(flags, data); return true;
            case PLUS.SAVE: case PLUS.BEGIN_CONTAINER_NO_PARAMS: pushState(data.readUInt32LE(0)); return true;
            case PLUS.RESTORE: case PLUS.END_CONTAINER: popState(data.readUInt32LE(0)); return true;
            default: return false;
        }
    }
    function pushState(index) {
        budget.checkStack(saved.size);
        saved.set(index, {
            world: state.world, pageUnit: state.pageUnit, pageScale: state.pageScale, clip: state.clip,
        });
    }
    function popState(index) {
        const prior = saved.get(index);
        if (!prior) return;
        state.world = prior.world;
        state.pageUnit = prior.pageUnit;
        state.pageScale = prior.pageScale;
        state.clip = prior.clip;
        saved.delete(index);
    }

    // ---------------- 变换 ----------------

    const readMatrix = (data) => [0, 1, 2, 3, 4, 5].map((index) => data.readFloatLE(index * 4));
    /** O 位置位为后乘，复位为前乘 */
    const composeWorld = (matrix, flags) => ((flags & POST_MULTIPLY_FLAG)
        ? multiplyMatrix(state.world, matrix)
        : multiplyMatrix(matrix, state.world));
    function applyTransformRecord(type, flags, data) {
        switch (type) {
            case PLUS.SET_WORLD_TRANSFORM: state.world = readMatrix(data); return true;
            case PLUS.RESET_WORLD_TRANSFORM: state.world = IDENTITY_MATRIX; return true;
            case PLUS.MULTIPLY_WORLD_TRANSFORM: state.world = composeWorld(readMatrix(data), flags); return true;
            case PLUS.TRANSLATE_WORLD_TRANSFORM:
                state.world = composeWorld([1, 0, 0, 1, data.readFloatLE(0), data.readFloatLE(4)], flags);
                return true;
            case PLUS.SCALE_WORLD_TRANSFORM:
                state.world = composeWorld([data.readFloatLE(0), 0, 0, data.readFloatLE(4), 0, 0], flags);
                return true;
            case PLUS.ROTATE_WORLD_TRANSFORM: state.world = composeWorld(rotation(data.readFloatLE(0)), flags); return true;
            case PLUS.SET_PAGE_TRANSFORM:
                state.pageUnit = flags & PAGE_UNIT_MASK;
                state.pageScale = data.readFloatLE(0);
                return true;
            default: return false;
        }
    }
    function rotation(degrees) {
        const radians = degrees * Math.PI / 180;
        return [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), 0, 0];
    }

    // ---------------- 裁剪 ----------------

    /** 只支持 Replace 与 Intersect，其余合并方式记诊断并保持原裁剪 */
    function setClip(mode, next) {
        if (mode === COMBINE_REPLACE) { state.clip = next; return; }
        if (mode === COMBINE_INTERSECT) {
            state.clip = next ? writer.intersectClip(scope, state.clip, next) : state.clip;
            return;
        }
        note(`EmfPlusClip(CombineMode=${mode})`, 'state');
    }
    /** 轴对齐时用矩形裁剪，含旋转或切变时退化为四边形路径 */
    function quadClip(rect, matrix, key) {
        if (isAxisAligned(matrix)) {
            const a = transformPoint(matrix, rect[0], rect[1]);
            const b = transformPoint(matrix, rect[0] + rect[2], rect[1] + rect[3]);
            return writer.rectClip(scope, [a[0], a[1], b[0], b[1]]);
        }
        return writer.pathClip(key, subpathData(devicePoints(rectCorners(rect), matrix), true), undefined);
    }
    /** 区域节点：矩形、路径、空、无限；组合节点与其余类型记诊断 */
    function regionClip(data, matrix, key) {
        const node = data.readUInt32LE(8);
        if (node === REGION_NODE.INFINITE) return { infinite: true };
        if (node === REGION_NODE.EMPTY) return { clip: writer.rectClip(scope, [0, 0, 0, 0]) };
        if (node === REGION_NODE.RECT) {
            const rect = [data.readFloatLE(12), data.readFloatLE(16), data.readFloatLE(20), data.readFloatLE(24)];
            return { clip: quadClip(rect, matrix, key) };
        }
        if (node === REGION_NODE.PATH) {
            const length = data.readUInt32LE(12);
            const path = parsePlusObject(3, data.subarray(16, 16 + length), parseContext);
            return { clip: writer.pathClip(key, pathData(path, matrix), undefined) };
        }
        note(`EmfPlusRegion(node=0x${node.toString(16)})`, 'state');
        return { infinite: true };
    }
    function applyClipRegion(flags, matrix, key) {
        const object = objects.get(flags & OBJECT_ID_MASK);
        const mode = (flags >> COMBINE_MODE_SHIFT) & COMBINE_MODE_MASK;
        if (!object || object.kind !== 'region') { note('EmfPlusSetClipRegion(对象缺失)', 'state'); return; }
        const region = regionClip(object.data, matrix, key);
        if (!region.infinite) { setClip(mode, region.clip); return; }
        if (mode === COMBINE_REPLACE) state.clip = null;
    }
    function applyClipPath(flags, matrix, key) {
        const object = objects.get(flags & OBJECT_ID_MASK);
        if (!object || object.kind !== 'path') { note('EmfPlusSetClipPath(对象缺失)', 'state'); return; }
        setClip((flags >> COMBINE_MODE_SHIFT) & COMBINE_MODE_MASK, writer.pathClip(key, pathData(object, matrix), undefined));
    }
    function applyClipRecord(type, flags, data) {
        const key = `${scope}${type.toString(16)}:${diagnostics.counters.plusRecords}`;
        switch (type) {
            case PLUS.RESET_CLIP: state.clip = null; return true;
            case PLUS.SET_CLIP_RECT: {
                const rect = [data.readFloatLE(0), data.readFloatLE(4), data.readFloatLE(8), data.readFloatLE(12)];
                setClip((flags >> COMBINE_MODE_SHIFT) & COMBINE_MODE_MASK, quadClip(rect, pageMatrix(), key));
                return true;
            }
            case PLUS.SET_CLIP_PATH: applyClipPath(flags, pageMatrix(), key); return true;
            case PLUS.SET_CLIP_REGION: applyClipRegion(flags, pageMatrix(), key); return true;
            default: return false;
        }
    }

    // ---------------- 绘图 ----------------

    function drawLines(flags, data) {
        const matrix = pageMatrix();
        const { points } = readPlusPoints(data, 4, data.readUInt32LE(0), flags, parseContext.checkPoints);
        if (points.length < 2) return;
        const device = devicePoints(points, matrix);
        emitShape(writer.element('path', {
            d: subpathData(device, (flags & CLOSE_FIGURE_FLAG) !== 0),
            fill: 'none',
            ...strokeAttrs(penOf(flags), matrix),
        }));
    }
    function fillPolygon(flags, data) {
        const matrix = pageMatrix();
        const { points } = readPlusPoints(data, 8, data.readUInt32LE(4), flags, parseContext.checkPoints);
        if (points.length < 2) return;
        emitShape(writer.element('polygon', {
            points: devicePoints(points, matrix).map((p) => `${formatNumber(p[0])},${formatNumber(p[1])}`).join(' '),
            ...fillAttrs(flags, data.readUInt32LE(0)),
            'fill-rule': 'evenodd',
        }));
    }
    /** FillRects 的画刷 id 在前，DrawRects 直接从计数开始 */
    function rectsData(flags, data, fill) {
        const base = fill ? 4 : 0;
        const count = data.readUInt32LE(base);
        budget.checkPoints(count);
        const matrix = pageMatrix();
        const stride = rectBytes(flags);
        let out = '';
        for (let index = 0; index < count; index += 1) {
            const rect = readPlusRect(data, base + 4 + index * stride, flags);
            out += subpathData(devicePoints(rectCorners(rect), matrix), true);
        }
        return { data: out, matrix };
    }
    function drawRects(flags, data, fill) {
        const shape = rectsData(flags, data, fill);
        if (!shape.data) return;
        emitShape(writer.element('path', fill
            ? { d: shape.data, ...fillAttrs(flags, data.readUInt32LE(0)) }
            : { d: shape.data, fill: 'none', ...strokeAttrs(penOf(flags), shape.matrix) }));
    }
    function drawEllipse(flags, data, fill) {
        const matrix = pageMatrix();
        const rect = readPlusRect(data, fill ? 4 : 0, flags);
        const points = devicePoints(ellipsePoints(rect), matrix);
        let out = `M${formatNumber(points[0][0])} ${formatNumber(points[0][1])}`;
        for (const start of [1, 4, 7, 10]) {
            out += `C${formatNumber(points[start][0])} ${formatNumber(points[start][1])}`
                + ` ${formatNumber(points[start + 1][0])} ${formatNumber(points[start + 1][1])}`
                + ` ${formatNumber(points[start + 2][0])} ${formatNumber(points[start + 2][1])}`;
        }
        emitShape(writer.element('path', fill
            ? { d: `${out}Z`, ...fillAttrs(flags, data.readUInt32LE(0)) }
            : { d: `${out}Z`, fill: 'none', ...strokeAttrs(penOf(flags), matrix) }));
    }
    function drawPathObject(flags, data, fill) {
        const object = objects.get(flags & OBJECT_ID_MASK);
        const matrix = pageMatrix();
        if (!object || object.kind !== 'path') {
            note(fill ? 'EmfPlusFillPath(对象缺失)' : 'EmfPlusDrawPath(对象缺失)', 'drawing');
            return;
        }
        emitShape(writer.element('path', fill
            ? { d: pathData(object, matrix), ...fillAttrs(flags, data.readUInt32LE(0)), 'fill-rule': 'evenodd' }
            : { d: pathData(object, matrix), fill: 'none', ...strokeAttrs(objects.get(data.readUInt32LE(0) & OBJECT_ID_MASK), matrix) }));
    }

    // ---------------- 文字 ----------------

    /** em 以字体自身单位计，先换算到页面单位，再由页面矩阵统一作用 */
    function logicalEm(font) {
        if (!(font.em > 0)) return 0;
        if (font.unit === UNIT.WORLD || font.unit === state.pageUnit) return font.em;
        const pageFactor = unitFactor(state.pageUnit, 1) * (state.pageScale || 1);
        return pageFactor ? font.em * unitFactor(font.unit, 1) / pageFactor : font.em;
    }
    /** 布局矩形的宽高为 0 时是点定位；否则按 StringAlignment 在矩形内对齐 */
    function stringPlacement(format, rect, em) {
        const [x, y, width, height] = rect;
        if (format.align === ALIGN_CENTER) return { x0: x + width / 2, y0: y, anchor: 'middle' };
        if (format.align === ALIGN_FAR) return { x0: x + width - format.trailingMargin * em, y0: y, anchor: 'end' };
        return { x0: x + format.leadingMargin * em, y0: y, anchor: '' };
    }
    function lineOffset(format, rect, em) {
        if (format.lineAlign === ALIGN_CENTER) return (rect[3] - LINE_HEIGHT_EM * em) / 2;
        if (format.lineAlign === ALIGN_FAR) return rect[3] - LINE_HEIGHT_EM * em;
        return 0;
    }
    function drawString(flags, data) {
        const font = objects.get(flags & OBJECT_ID_MASK);
        if (!font || font.kind !== 'font') { note('EmfPlusDrawString(字体对象缺失)', 'drawing'); return; }
        const chars = data.readUInt32LE(8);
        if (chars > budget.limits.maxTextChars) {
            throw new MetafileError('LIMIT_EXCEEDED', `单条文字记录 ${chars} 字符超过上限（${budget.limits.maxTextChars}）`);
        }
        if (STRING_TEXT_OFFSET + chars * 2 > data.length) throw new RangeError('EMF+ DrawString 字符串越界');
        const raw = data.toString('utf16le', STRING_TEXT_OFFSET, STRING_TEXT_OFFSET + chars * 2);
        if (/[\r\n]/.test(raw)) note('EmfPlusDrawString(多行文本按单行输出)', 'drawing');
        const stored = objects.get(data.readUInt32LE(4) & OBJECT_ID_MASK);
        const format = stored && stored.kind === 'format'
            ? stored
            : { align: 0, lineAlign: 0, leadingMargin: DEFAULT_MARGIN_EM, trailingMargin: DEFAULT_MARGIN_EM };
        const rect = [0, 1, 2, 3].map((index) => data.readFloatLE(STRING_LAYOUT_OFFSET + index * 4));
        const em = logicalEm(font);
        const { x0, y0, anchor } = stringPlacement(format, rect, em);
        const brush = (flags & INLINE_COLOR_FLAG)
            ? argbColor(data.readUInt32LE(0))
            : (objects.get(data.readUInt32LE(0) & OBJECT_ID_MASK) || { color: '#000000', alpha: 1 });
        diagnostics.counters.text += 1;
        diagnostics.counters.plusDrawn += 1;
        writer.emit(writer.textMarkup({
            text: raw.replace(/[\r\n]+/g, ' '),
            x0,
            y0: y0 + lineOffset(format, rect, em),
            matrix: pageMatrix(),
            face: font.face,
            em,
            bold: (font.style & FONT_STYLE_BOLD) !== 0,
            italic: (font.style & FONT_STYLE_ITALIC) !== 0,
            color: brush.color,
            alpha: brush.alpha,
            baselineOffsetEm: ascentOf(font.face),
            anchor,
            dxs: null,
            rotateDeg: 0,
        }), state.clip);
    }

    // ---------------- 内嵌图元 ----------------

    /** 三点平行四边形：DrawImagePoints 直接给出，DrawImage 由目标矩形推出 */
    function imageCorners(type, flags, data) {
        if (type !== PLUS.DRAW_IMAGE_POINTS) {
            const rect = readPlusRect(data, IMAGE_DEST_OFFSET, flags);
            return [[rect[0], rect[1]], [rect[0] + rect[2], rect[1]], [rect[0], rect[1] + rect[3]]];
        }
        const count = data.readUInt32LE(IMAGE_DEST_OFFSET);
        if (count !== IMAGE_POINT_COUNT) { note('EmfPlusDrawImagePoints(点数不为 3)', 'drawing'); return null; }
        return readPlusPoints(data, IMAGE_DEST_OFFSET + 4, count, flags, parseContext.checkPoints).points;
    }
    /** 内嵌设备坐标 → 外层世界坐标（源矩形映到三点平行四边形）→ 外层设备坐标 */
    function nestedMatrix(src, corners, matrix) {
        const ux = [(corners[1][0] - corners[0][0]) / src[2], (corners[1][1] - corners[0][1]) / src[2]];
        const uy = [(corners[2][0] - corners[0][0]) / src[3], (corners[2][1] - corners[0][1]) / src[3]];
        return multiplyMatrix([
            ux[0], ux[1], uy[0], uy[1],
            corners[0][0] - src[0] * ux[0] - src[1] * uy[0],
            corners[0][1] - src[0] * ux[1] - src[1] * uy[1],
        ], matrix);
    }
    function drawImage(type, flags, data) {
        const image = objects.get(flags & OBJECT_ID_MASK);
        const src = [0, 1, 2, 3].map((index) => data.readFloatLE(IMAGE_SRC_OFFSET + index * 4));
        const corners = imageCorners(type, flags, data);
        if (!corners) return;
        if (!(src[2] > 0 && src[3] > 0)) { note('EmfPlusDrawImage(源矩形为空)', 'drawing'); return; }
        if (!image || image.kind !== 'image') { note('EmfPlusDrawImage(对象缺失)', 'drawing'); return; }
        if (!image.metafile) { note('EmfPlusDrawImage(位图)', 'drawing'); return; }
        drawNested(image.metafile, nestedMatrix(src, corners, pageMatrix()), state.clip);
    }

    // ---------------- 分发 ----------------

    function drawRecord(type, flags, data) {
        switch (type) {
            case PLUS.DRAW_LINES: drawLines(flags, data); return true;
            case PLUS.FILL_POLYGON: fillPolygon(flags, data); return true;
            case PLUS.FILL_RECTS: drawRects(flags, data, true); return true;
            case PLUS.DRAW_RECTS: drawRects(flags, data, false); return true;
            case PLUS.FILL_ELLIPSE: drawEllipse(flags, data, true); return true;
            case PLUS.DRAW_ELLIPSE: drawEllipse(flags, data, false); return true;
            case PLUS.FILL_PATH: drawPathObject(flags, data, true); return true;
            case PLUS.DRAW_PATH: drawPathObject(flags, data, false); return true;
            case PLUS.DRAW_STRING: drawString(flags, data); return true;
            case PLUS.DRAW_IMAGE: case PLUS.DRAW_IMAGE_POINTS: drawImage(type, flags, data); return true;
            default: return false;
        }
    }
    function dispatch(type, flags, data) {
        if (PLUS_IGNORABLE_TYPES.has(type)) return;
        if (applyControlRecord(type, flags, data)) return;
        if (applyTransformRecord(type, flags, data)) return;
        if (applyClipRecord(type, flags, data)) return;
        if (drawRecord(type, flags, data)) return;
        note(plusName(type), PLUS_DRAWING_TYPES.has(type) ? 'drawing' : 'state');
    }

    /**
     * 回放一条 EMF+ 记录。记录内部的字段畸形只记诊断项，不中断整份转换；
     * 资源护栏（LIMIT_EXCEEDED）逐层上抛。
     */
    function handleRecord(type, flags, data) {
        diagnostics.counters.plusRecords += 1;
        // [MS-EMFPLUS] 1.3.1：GetDC 之后的经典记录一直回放到下一条任意类型的 EMF+ 记录为止
        if (type !== PLUS.GET_DC) state.getDc = false;
        try {
            dispatch(type, flags, data);
        } catch (error) {
            if (error instanceof MetafileError && error.code === 'LIMIT_EXCEEDED') throw error;
            note(`${plusName(type)}(解析失败)`, PLUS_DRAWING_TYPES.has(type) ? 'drawing' : 'state');
        }
    }

    /** classic 流：只清点并读取 EmfPlusHeader，不回放 */
    function scanRecord(type, flags, data) {
        diagnostics.counters.plusRecords += 1;
        if (type === PLUS.HEADER) readHeader(flags, data);
    }

    return {
        handleRecord,
        scanRecord,
        hasPlus: () => state.present,
        inGetDcSection: () => state.getDc,
        info: () => ({
            present: state.present,
            dual: state.dual,
            logicalDpi: state.logicalDpi,
            hasChemDrawCdx: state.hasChemDrawCdx,
        }),
    };
}

module.exports = {
    PLUS,
    PLUS_NAMES,
    PLUS_DRAWING_TYPES,
    PLUS_IGNORABLE_TYPES,
    PLUS_SUPPORTED_TYPES,
    OBJECT_ID_MASK,
    OBJECT_TYPE_SHIFT,
    OBJECT_TYPE_MASK,
    plusName,
    readHeaderInfo,
    isChemDrawComment,
    createPlusReplayer,
};
