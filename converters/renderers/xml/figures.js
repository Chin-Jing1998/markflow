/**
 * 附图与图片元素（patent profile）：说明书附图、摘要附图、段内 img 的构造
 *
 * isPureLabel(text)                  纯图号段：^\s*图\s*(\d+)\s*$
 * parseLabel(text, { allowCaption }) → { num, caption } | null；allowCaption 时接受「图1 结构示意图」「图1：…」
 * buildFigures(blocks, ctx) → { children: builderNode[], count }
 *   blocks 为附图区域的块序列（image 块与图号段交替，图号段可在图片之前或之后）。每幅 figure 前置
 *   <cn-drawing-p><p id="l000N" num="XXXX" Italic="0">图N</p></cn-drawing-p>；figure/@num 取图号，缺图号
 *   按顺序补号；图号不连续记「附图：」问题项。ctx.labels 为 false（摘要附图，DTD 的 cn-abst-figure 不含
 *   cn-drawing-p）时不输出图号段。图片资源经 ctx.assets.use(名, { kind: 'drawing' }) 取平铺文件名。
 * buildImg(ctx, { asset, file, inline, orientation }) → <img id he wi file img-format img-content inline [orientation]/>
 *   he/wi 为毫米：像素 × 25.4 / JFIF 密度（缺密度按 ctx.dpi，默认 300），四舍五入取整。
 */
const { ISSUE_CODES, createIssue } = require('./precheck');
const { readImageInfo, pixelsToMm } = require('./image-info');

const LABEL_RE = /^\s*图\s*(\d+)\s*$/;
const CAPTION_RE = /^\s*图\s*(\d+)(?:\s*[:：、.．\-—]\s*|\s+)(.*\S)\s*$/;
const DEFAULT_DPI = 300;
const IMG_FORMATS = new Set(['jpg', 'tif']);
const DEFAULT_IMG_FORMAT = 'jpg';
const IMG_CONTENT = 'drawing';

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
            if (ctx.labels !== false) children.push(drawingParagraph(ctx, entry.text));
            continue;
        }
        const resolved = ctx.assets.use(assetNameOf(entry.node), { kind: 'drawing' });
        if (!resolved) {
            ctx.issues.push(createIssue(ISSUE_CODES.FIGURE_MISSING_ASSET, `图${entry.num} 的图片（${assetNameOf(entry.node) || '无地址'}）没有本地文件，已跳过`));
            continue;
        }
        if (ctx.labels !== false) children.push(drawingParagraph(ctx, `图${entry.num}`));
        const figureAttrs = { id: ctx.ids.next('f').id, num: String(entry.num) };
        if (entry.caption) figureAttrs['figure-labels'] = entry.caption;
        children.push(ctx.el('figure', figureAttrs, [buildImg(ctx, { ...resolved, inline: false, withOrientation: true })]));
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
                const entry = { kind: 'figure', node, num: pending ? pending.num : null, caption: pending ? pending.caption : '' };
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
        if (lastFigure) {
            lastFigure.num = label.num;
            lastFigure.caption = label.caption;
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

function drawingParagraph(ctx, text) {
    const temp = ctx.temp.next();
    return ctx.el('cn-drawing-p', {}, [ctx.el('p', { id: temp.id, num: temp.num, Italic: '0' }, [text])]);
}

function buildImg(ctx, { asset, file, inline = false, withOrientation = false }) {
    const info = readImageInfo(asset.buffer, asset.mime) || {};
    const dpi = Number.isFinite(info.dpi) && info.dpi > 0 ? info.dpi : (ctx.dpi || DEFAULT_DPI);
    const wi = pixelsToMm(info.width, dpi);
    const he = pixelsToMm(info.height, dpi);
    if (wi === null || he === null) {
        ctx.issues.push(createIssue(ISSUE_CODES.FIGURE_MISSING_ASSET, `无法读取图片 ${file} 的像素尺寸，wi/he 已写为 0，请手工核对`, { location: file }));
    }
    const attrs = {
        id: ctx.ids.next('i').id,
        he: String(he === null ? 0 : he),
        wi: String(wi === null ? 0 : wi),
        file,
        'img-format': IMG_FORMATS.has(info.format) ? info.format : DEFAULT_IMG_FORMAT,
        'img-content': IMG_CONTENT,
        inline: inline ? 'yes' : 'no',
    };
    if (withOrientation) attrs.orientation = wi !== null && he !== null && wi > he ? 'landscape' : 'portrait';
    return ctx.el('img', attrs);
}

const assetNameOf = (node) => {
    if (!node) return '';
    if (node.data && typeof node.data.assetName === 'string' && node.data.assetName) return node.data.assetName;
    return typeof node.url === 'string' ? node.url : '';
};

// ============================================================
// 说明书正文中的图号引用
// ============================================================

// 「图4」「如图4、5所示」「图3、4、5」「图4和5」「图4与5」「图4-6」「图4～6」「图4至6」
const FIGREF_RE = /图\s*\d+(?:\s*[、,，和与及或\-~～至]\s*\d+)*(?![\dA-Za-z])/g;
const FIGREF_TOKEN_RE = /\d+|[、,，和与及或\-~～至]/g;
const FIGREF_RANGE_CONNECTORS = new Set(['-', '~', '～', '至']);
// 区间展开上限：超出（多为笔误）只为两端生成 figref
const FIGREF_RANGE_LIMIT = 50;

/**
 * 一处图号引用 → 节点与字符串序列：每个图号一个 <figref num="N">，正文原样保留（「图」与首个图号同入首个
 * figref，连接符留在元素外）；区间按数字展开，中间图号以空 figref 置于区间末图号之前。
 */
function expandFigrefs(text, el) {
    const out = [];
    let cursor = 0;
    let previous = null;
    let connector = null;
    for (const token of text.matchAll(FIGREF_TOKEN_RE)) {
        const value = token[0];
        if (!/^\d+$/.test(value)) { connector = value; continue; }
        const num = Number(value);
        const lead = text.slice(cursor, token.index);
        if (previous === null) {
            out.push(el('figref', { num: String(num) }, [lead + value]));
        } else {
            if (lead) out.push(lead);
            if (FIGREF_RANGE_CONNECTORS.has(connector) && previous < num && num - previous <= FIGREF_RANGE_LIMIT) {
                for (let middle = previous + 1; middle < num; middle += 1) out.push(el('figref', { num: String(middle) }));
            }
            out.push(el('figref', { num: String(num) }, [value]));
        }
        cursor = token.index + value.length;
        previous = num;
        connector = null;
    }
    if (cursor < text.length) out.push(text.slice(cursor));
    return out;
}

module.exports = { isPureLabel, parseLabel, buildFigures, buildImg, assetNameOf, expandFigrefs, LABEL_RE, FIGREF_RE };
