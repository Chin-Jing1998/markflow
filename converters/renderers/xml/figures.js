/**
 * 附图与图片元素（patent profile）：说明书附图、摘要附图、段内 img 的构造
 *
 * isPureLabel(text)                  纯图号段：^\s*图\s*(\d+)\s*$
 * parseLabel(text, { allowCaption }) → { num, caption } | null；allowCaption 时接受「图1 结构示意图」「图1：…」
 * buildFigures(blocks, ctx) → { children: builderNode[], count }
 *   blocks 为附图区域的块序列（image 块与图号段交替，图号段可在图片之前或之后）。图注由
 *   figure/@figure-labels 承载（取值为原稿图号段的文本，缺图号段时回退为「图N」），官方产出不含
 *   cn-drawing-p，故本模块不再输出该元素。figure/@num 为四位补零的图号，缺图号按顺序补号；图号不
 *   连续记「附图：」问题项。ctx.labels 为 false（摘要附图，官方 cn-abst-figure 下的 figure 无
 *   figure-labels）时不写图注属性；附图区域内非图号段的杂散文本无处安放，丢弃并记问题项。
 *   图片资源经 ctx.assets.use(名) 取该书的裸文件名（<表格代码>_<序号>.<扩展名>，见 assets.js），img 的 id 前缀取 ctx.imgPrefix。
 * buildImg(ctx, { asset, file, node, prefix, inline })
 *   → <img id file wi he top left img-content img-format orientation inline/>（属性顺序与官方逐字一致）
 *   wi/he 为毫米：优先取解析层写入的源 Word 显示尺寸 data.displayWidthMm / data.displayHeightMm，
 *   缺失时回退为像素 × 25.4 / JFIF 密度（缺密度按 ctx.dpi，默认 300）；两条路径一律向下取整。
 *   top/left 恒为 "0"，orientation 恒为 "portrait"（官方不按宽高比判定）。
 */
const { ISSUE_CODES, createIssue } = require('./precheck');
const { readImageInfo, pixelsToMm } = require('./image-info');
const { padNumber } = require('./numbering');

const LABEL_RE = /^\s*图\s*(\d+)\s*$/;
const CAPTION_RE = /^\s*图\s*(\d+)(?:\s*[:：、.．\-—]\s*|\s+)(.*\S)\s*$/;
const DEFAULT_DPI = 300;
const IMG_FORMATS = new Set(['jpg', 'tif']);
const DEFAULT_IMG_FORMAT = 'jpg';
const IMG_CONTENT = 'drawing';
const IMG_TOP = '0';
const IMG_LEFT = '0';
const IMG_ORIENTATION = 'portrait';
const NUM_WIDTH = 4;

const isPureLabel = (text) => LABEL_RE.test(String(text == null ? '' : text));

function parseLabel(text, { allowCaption = false } = {}) {
    const value = String(text == null ? '' : text);
    const pure = LABEL_RE.exec(value);
    if (pure) return { num: Number(pure[1]), caption: '' };
    if (!allowCaption) return null;
    const captioned = CAPTION_RE.exec(value);
    return captioned ? { num: Number(captioned[1]), caption: captioned[2].trim() } : null;
}

function buildFigures(blocks, ctx) {
    const entries = collectEntries(blocks, ctx);
    assignNumbers(entries, ctx);
    const children = [];
    for (const entry of entries) {
        if (entry.kind === 'note') {
            ctx.issues.push(createIssue(ISSUE_CODES.FIGURE_TEXT_DROPPED,
                `附图部分的文字“${preview(entry.text)}”不是图号段，官方 cn-drawings 只容纳 figure，已丢弃`));
            continue;
        }
        const resolved = ctx.assets.use(assetNameOf(entry.node));
        if (!resolved) {
            ctx.issues.push(createIssue(ISSUE_CODES.FIGURE_MISSING_ASSET, `图${entry.num} 的图片（${assetNameOf(entry.node) || '无地址'}）没有本地文件，已跳过`));
            continue;
        }
        const figureAttrs = { id: ctx.ids.next('f').id, num: padNumber(entry.num, NUM_WIDTH) };
        if (ctx.labels !== false) figureAttrs['figure-labels'] = entry.label || `图${entry.num}`;
        children.push(ctx.el('figure', figureAttrs, [buildImg(ctx, { ...resolved, node: entry.node, prefix: ctx.imgPrefix, inline: true })]));
    }
    return { children, count: entries.filter((entry) => entry.kind === 'figure').length };
}

// 图号段附着规则：图片之后紧跟的图号段归该图；否则作为待用图号赋给下一幅图
function collectEntries(blocks, ctx) {
    const entries = [];
    let pending = null;
    let lastFigure = null;
    for (const block of blocks) {
        if (block.kind === 'image') {
            for (const node of block.images) {
                const entry = { kind: 'figure', node, num: pending ? pending.num : null, label: pending ? pending.label : '' };
                entries.push(entry);
                lastFigure = pending ? null : entry;
                pending = null;
            }
            continue;
        }
        if (block.kind !== 'paragraph' && block.kind !== 'heading') continue;
        const label = parseLabel(block.text, { allowCaption: ctx.allowCaption });
        if (!label) {
            entries.push({ kind: 'note', text: block.text });
            continue;
        }
        // 图注原样保留原稿图号段的文本（官方样例为「图1」，带说明时如「图1 结构示意图」）
        label.label = String(block.text == null ? '' : block.text).trim();
        if (lastFigure) {
            lastFigure.num = label.num;
            lastFigure.label = label.label;
            lastFigure = null;
        } else {
            pending = label;
        }
    }
    return entries;
}

function assignNumbers(entries, ctx) {
    let next = 1;
    const nums = [];
    for (const entry of entries) {
        if (entry.kind !== 'figure') continue;
        if (!Number.isInteger(entry.num)) entry.num = next;
        next = entry.num + 1;
        nums.push(entry.num);
    }
    if (nums.length > 0 && !nums.every((num, index) => num === index + 1)) {
        ctx.issues.push(createIssue(ISSUE_CODES.FIGURE_NUMBER_GAP, `图号不连续或重复：实际为 ${nums.join('、')}，应为 1–${nums.length} 连续编号`));
    }
}

function buildImg(ctx, { asset, file, node = null, prefix, inline = false }) {
    const info = readImageInfo(asset.buffer, asset.mime) || {};
    const { wi, he } = measure(node, info, ctx);
    if (wi === null || he === null) {
        ctx.issues.push(createIssue(ISSUE_CODES.FIGURE_MISSING_ASSET, `无法读取图片 ${file} 的尺寸，wi/he 已写为 0，请手工核对`, { location: file }));
    }
    // 属性写入顺序即序列化顺序，与官方 img 逐字一致
    return ctx.el('img', {
        id: ctx.ids.next(prefix).id,
        file,
        wi: String(wi === null ? 0 : wi),
        he: String(he === null ? 0 : he),
        top: IMG_TOP,
        left: IMG_LEFT,
        'img-content': IMG_CONTENT,
        'img-format': IMG_FORMATS.has(info.format) ? info.format : DEFAULT_IMG_FORMAT,
        orientation: IMG_ORIENTATION,
        inline: inline ? 'yes' : 'no',
    });
}

// 源 Word 的显示尺寸优先（解析层写入，毫米浮点）；缺失时按像素与密度换算
function measure(node, info, ctx) {
    const display = displayMm(node);
    if (display) return display;
    const dpi = Number.isFinite(info.dpi) && info.dpi > 0 ? info.dpi : (ctx.dpi || DEFAULT_DPI);
    return { wi: pixelsToMm(info.width, dpi), he: pixelsToMm(info.height, dpi) };
}

function displayMm(node) {
    const data = node && node.data;
    if (!data) return null;
    const wi = floorMm(data.displayWidthMm);
    const he = floorMm(data.displayHeightMm);
    return wi === null || he === null ? null : { wi, he };
}

const floorMm = (value) => (Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : null);

const assetNameOf = (node) => {
    if (!node) return '';
    if (node.data && typeof node.data.assetName === 'string' && node.data.assetName) return node.data.assetName;
    return typeof node.url === 'string' ? node.url : '';
};

const TEXT_PREVIEW = 20;
const preview = (text) => {
    const value = String(text == null ? '' : text).trim();
    return value.length > TEXT_PREVIEW ? `${value.slice(0, TEXT_PREVIEW)}…` : value;
};

module.exports = { isPureLabel, parseLabel, buildFigures, buildImg, assetNameOf, LABEL_RE };
