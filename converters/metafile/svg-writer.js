'use strict';
/**
 * SVG 输出层：2×3 仿射矩阵基元、数值格式化、XML 转义、元素封闭集合、裁剪定义与去重、输出体积上限
 *
 * 职责边界：本模块是「字节进 SVG」的唯一出口——回放层只描述画什么，元素与属性怎么落成字符串全在这里。
 *   - 矩阵基元与本层同处一处的理由：坐标最终要落到设备坐标再格式化，变换与输出是同一件事的两端。
 *     emf-classic.js 与（W2 的）emf-plus.js 都从本模块取 multiplyMatrix／transformPoint／matrixScale。
 *   - 元素封闭集合（ALLOWED_ELEMENTS，共 11 种，见调研报告 4.6 第二层）：element() 只认这些名字，
 *     其余一律抛错。不输出 script、foreignObject、style、事件属性与任何外链。
 *   - 来自文件的字符串只有两处进入 SVG：文字内容与字体名。前者经 escapeXml 转义并剔除控制字符与
 *     非字符码位，后者先经 fonts.js 剔除引号与 ; { } < > 再由本层转义。
 *   - 所有数值经 formatNumber／formatNumber4 输出，NaN 与无穷一律写 0，因此畸形输入不会产出非法属性值。
 *   - 输出体积按 limits.maxSvgBytes 计量（元素、裁剪定义与分组包裹都计入），超限抛 LIMIT_EXCEEDED。
 *
 * 片段栈（pushFragment／popFragment）是给 W2 的内嵌图元准备的：内嵌图元回放到独立片段里，
 * 再由调用方包进 <g transform="matrix(…)">；defs、字节计数与裁剪 id 全程共用同一份，保证 id 全局唯一。
 */
const { MetafileError } = require('./reader');
const { fontStack } = require('./fonts');

/** 允许出现在输出里的元素（调研报告 4.6 第二层的封闭集合） */
const ALLOWED_ELEMENTS = Object.freeze(new Set([
    'svg', 'rect', 'defs', 'clipPath', 'g', 'path', 'polygon', 'polyline', 'line', 'ellipse', 'text',
]));
/** 单位矩阵 [a, b, c, d, e, f]，按行向量约定 p' = p · M */
const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 1, 0, 0]);
/** 几何坐标保留两位小数，矩阵与逻辑坐标保留四位 */
const COORD_PRECISION = 100;
const MATRIX_PRECISION = 10000;
/** 判定矩阵是否只含轴对齐的正向缩放与平移 */
const AXIS_EPSILON = 1e-9;
/** 轴对齐时两轴缩放比的允许偏差，超过则改用 matrix() 排字 */
const ANISOTROPY_TOLERANCE = 0.02;
const XML_ESCAPES = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' });
const XML_ESCAPE_RE = /[&<>"]/g;
/** XML 1.0 不允许的控制字符（保留 TAB、LF、CR） */
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
/** 非字符码位 U+FFFE、U+FFFF */
const NONCHAR_RE = /[￾￿]/g;

/** A · B（行向量约定：先 A 后 B） */
const multiplyMatrix = (a, b) => [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
];
const transformPoint = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
/** 矩阵的等比缩放因子（行列式的平方根）；退化时取 1，避免除零 */
const matrixScale = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
const isAxisAligned = (m) => Math.abs(m[1]) < AXIS_EPSILON && Math.abs(m[2]) < AXIS_EPSILON && m[0] > 0 && m[3] > 0;

const formatWith = (value, precision) => {
    const rounded = Math.round(value * precision) / precision;
    return Object.is(rounded, -0) || !Number.isFinite(rounded) ? '0' : String(rounded);
};
/** 几何坐标：两位小数；NaN 与无穷写 0 */
const formatNumber = (value) => formatWith(value, COORD_PRECISION);
/** 矩阵与逻辑坐标：四位小数 */
const formatNumber4 = (value) => formatWith(value, MATRIX_PRECISION);
/** XML 转义并剔除控制字符与非字符码位 */
const escapeXml = (value) => String(value)
    .replace(XML_ESCAPE_RE, (ch) => XML_ESCAPES[ch])
    .replace(CONTROL_CHARS_RE, '')
    .replace(NONCHAR_RE, '');

const pointsAttr = (points) => points.map((p) => `${formatNumber(p[0])},${formatNumber(p[1])}`).join(' ');
/** 折线／多边形的子路径；close 为真时闭合 */
const subpathData = (points, close) => (points.length
    ? `M${points.map((p) => `${formatNumber(p[0])} ${formatNumber(p[1])}`).join('L')}${close ? 'Z' : ''}`
    : '');

function serializeAttrs(attrs) {
    let out = '';
    for (const [name, value] of Object.entries(attrs)) {
        if (value === undefined || value === null) continue;
        out += ` ${name}="${escapeXml(value)}"`;
    }
    return out;
}

/** 矩阵字面量 matrix(a b c d e f) */
const matrixAttr = (m) => `matrix(${m.map(formatNumber4).join(' ')})`;

/** 轴对齐且近似等比时：直接按设备坐标排字 */
function deviceText(spec) {
    const scale = spec.matrix[3];
    const [dx, dy] = transformPoint(spec.matrix, spec.x0, spec.y0);
    const baseline = dy + spec.baselineOffsetEm * spec.em * scale;
    let xAttr = formatNumber(dx);
    if (spec.dxs && spec.dxs.length > 1) {
        const xs = [];
        let acc = dx;
        for (const step of spec.dxs) { xs.push(formatNumber(acc)); acc += step * spec.matrix[0]; }
        xAttr = xs.join(' ');
    }
    const transform = spec.rotateDeg ? `rotate(${formatNumber(spec.rotateDeg)} ${formatNumber(dx)} ${formatNumber(dy)})` : undefined;
    return { x: xAttr, y: formatNumber(baseline), 'font-size': formatNumber(spec.em * scale), transform };
}

/** 含旋转、切变或非等比缩放时：在逻辑坐标系内排字，整体套 matrix() */
function logicalText(spec) {
    let xAttr = formatNumber4(spec.x0);
    if (spec.dxs && spec.dxs.length > 1) {
        const xs = [];
        let acc = spec.x0;
        for (const step of spec.dxs) { xs.push(formatNumber4(acc)); acc += step; }
        xAttr = xs.join(' ');
    }
    const rotate = spec.rotateDeg
        ? ` rotate(${formatNumber(spec.rotateDeg)} ${formatNumber4(spec.x0)} ${formatNumber4(spec.y0)})`
        : '';
    return {
        x: xAttr,
        y: formatNumber4(spec.y0 + spec.baselineOffsetEm * spec.em),
        'font-size': formatNumber4(spec.em),
        transform: `${matrixAttr(spec.matrix)}${rotate}`,
    };
}

/**
 * 出图器：裁剪定义、分组、字节计量与最终拼装
 * options：{ viewBox: [x, y, w, h], width, height, limits, diagnostics }
 */
function createSvgWriter(options) {
    const { viewBox, width, height, limits, diagnostics } = options;
    const defs = [];
    const clipIds = new Map();
    const frames = [{ parts: [], openClipKey: '' }];
    const state = { bytes: 0, clipSeq: 0 };
    const top = () => frames[frames.length - 1];
    const spend = (markup) => {
        state.bytes += markup.length;
        if (state.bytes > limits.maxSvgBytes) {
            throw new MetafileError('LIMIT_EXCEEDED', `SVG 输出超过体积上限（${limits.maxSvgBytes} 字节）`);
        }
        return markup;
    };

    /** 定义（并去重）一个 clipPath，返回其 id */
    function clipId(clip) {
        const known = clipIds.get(clip.key);
        if (known) return known;
        state.clipSeq += 1;
        const id = `c${state.clipSeq}`;
        clipIds.set(clip.key, id);
        const parent = clip.parent ? ` clip-path="url(#${clip.parent})"` : '';
        defs.push(spend(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"${parent}>${clip.markup}</clipPath>`));
        return id;
    }

    /** 按裁剪状态分组输出：裁剪不变时复用同一个 <g> */
    function emit(markup, clip) {
        const frame = top();
        const key = clip ? clip.key : '';
        if (key !== frame.openClipKey) {
            if (frame.openClipKey) frame.parts.push('</g>');
            if (key) frame.parts.push(spend(`<g clip-path="url(#${clipId(clip)})">`));
            frame.openClipKey = key;
        }
        if (key) diagnostics.counters.clipped += 1;
        frame.parts.push(spend(markup));
    }

    function element(name, attrs) {
        if (!ALLOWED_ELEMENTS.has(name)) throw new MetafileError('MALFORMED', `SVG 元素 ${name} 不在允许集合内`);
        return `<${name}${serializeAttrs(attrs)}/>`;
    }

    function textElement(attrs, text) {
        return `<text${serializeAttrs(attrs)}>${escapeXml(text)}</text>`;
    }

    /**
     * 文字标记：spec = { text, x0, y0, matrix, face, em, bold, italic, color, alpha,
     *                   baselineOffsetEm, anchor, dxs, rotateDeg }
     * matrix 为「逻辑 → 设备」的总矩阵，(x0, y0) 为逻辑坐标的参考点，em 为逻辑单位的字号。
     */
    function textMarkup(spec) {
        diagnostics.addFont(spec.face);
        const aligned = isAxisAligned(spec.matrix)
            && Math.abs(spec.matrix[0] - spec.matrix[3]) / spec.matrix[0] < ANISOTROPY_TOLERANCE;
        const placement = aligned ? deviceText(spec) : logicalText(spec);
        return textElement({
            ...placement,
            'font-family': fontStack(spec.face),
            'font-weight': spec.bold ? 'bold' : undefined,
            'font-style': spec.italic ? 'italic' : undefined,
            fill: spec.color,
            'fill-opacity': spec.alpha < 1 ? formatNumber(spec.alpha) : undefined,
            'text-anchor': spec.anchor || undefined,
            'xml:space': 'preserve',
        }, spec.text);
    }

    const rectClip = (scope, rect) => ({
        key: `${scope}r:${rect.map(formatNumber).join(',')}`,
        rect,
        markup: element('rect', {
            x: formatNumber(rect[0]),
            y: formatNumber(rect[1]),
            width: formatNumber(Math.max(0, rect[2] - rect[0])),
            height: formatNumber(Math.max(0, rect[3] - rect[1])),
        }),
    });
    const pathClip = (key, data, clipRule) => ({ key, markup: element('path', { d: data, 'clip-rule': clipRule }) });
    const listClip = (key, markup) => ({ key, markup });

    /** 裁剪求交：两个矩形直接算交集矩形；否则把旧裁剪挂到新 clipPath 元素自身上 */
    function intersectClip(scope, prior, next) {
        if (!prior) return next;
        if (prior.rect && next.rect) {
            const [a, b] = [prior.rect, next.rect];
            return rectClip(scope, [
                Math.max(a[0], b[0]), Math.max(a[1], b[1]),
                Math.min(a[2], b[2]), Math.min(a[3], b[3]),
            ]);
        }
        return { key: `${prior.key}&${next.key}`, markup: next.markup, parent: clipId(prior) };
    }

    function closeOpenGroup(frame) {
        if (frame.openClipKey) { frame.parts.push('</g>'); frame.openClipKey = ''; }
    }

    return {
        viewBox,
        width,
        height,
        /** 输出像素与设备单位之比：线宽下限由它换算到设备单位 */
        outScale: Math.sqrt((width / viewBox[2]) * (height / viewBox[3])),
        get bytes() { return state.bytes; },
        emit,
        element,
        textMarkup,
        clipId,
        rectClip,
        pathClip,
        listClip,
        intersectClip,
        pushFragment() { frames.push({ parts: [], openClipKey: '' }); },
        popFragment() {
            const frame = frames.pop();
            closeOpenGroup(frame);
            if (!frames.length) frames.push({ parts: [], openClipKey: '' });
            return frame.parts.join('');
        },
        render() {
            closeOpenGroup(frames[0]);
            const background = element('rect', {
                x: formatNumber(viewBox[0]),
                y: formatNumber(viewBox[1]),
                width: formatNumber(viewBox[2]),
                height: formatNumber(viewBox[3]),
                fill: '#ffffff',
            });
            const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`
                + ` viewBox="${viewBox.map(formatNumber).join(' ')}" preserveAspectRatio="none">`;
            const defsBlock = defs.length ? `<defs>${defs.join('')}</defs>` : '';
            const svg = `${head}${background}${defsBlock}${frames[0].parts.join('')}</svg>`;
            spend(head + background + defsBlock + '</svg>');
            return svg;
        },
    };
}

module.exports = {
    ALLOWED_ELEMENTS,
    IDENTITY_MATRIX,
    multiplyMatrix,
    transformPoint,
    matrixScale,
    isAxisAligned,
    formatNumber,
    formatNumber4,
    escapeXml,
    matrixAttr,
    pointsAttr,
    subpathData,
    createSvgWriter,
};
