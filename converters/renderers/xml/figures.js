/**
 * 附图与图片元素（patent profile）：说明书附图、摘要附图、段内 img 的构造
 *
 * isPureLabel(text)                  纯图号段：^\s*图\s*(\d+)\s*$
 * parseLabel(text, { allowCaption }) → { num, caption } | null；allowCaption 时经 matchCaption 接受「图1 结构示意图」「图1：…」
 * matchCaption(text)                 → [图号, 图注] | null：带图注图号段的匹配，线性扫描（导出供测试与旧正则逐字比对）
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
// 带图注图号段的前缀「图 + 数字」：数字只能取极大——少取一位，紧随其后的数字既非空白也非分隔标点，旧式两个备选都接不住
const CAPTION_HEAD_RE = /^\s*图\s*(\d+)/;
const CAPTION_SEPARATORS = new Set([':', '：', '、', '.', '．', '-', '—']);
// 「.」不匹配的四个行终止符 LF、CR、U+2028、U+2029，以码点构造；空白逐字符判定用单字符 \s，与旧式同一集合
const LINE_TERMINATOR_RE = new RegExp(`[${[0x0a, 0x0d, 0x2028, 0x2029].map((code) => String.fromCharCode(code)).join('')}]`);
const SPACE_RE = /\s/;
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
    const captioned = matchCaption(value);
    return captioned ? { num: Number(captioned[0]), caption: captioned[1].trim() } : null;
}

// 带图注图号段的匹配：返回旧式 /^\s*图\s*(\d+)(?:\s*[:：、.．\-—]\s*|\s+)(.*\S)\s*$/ 的第 1、2 组，不匹配为 null。
// 旧式为平方级：分隔符的 \s+（或标点两侧的 \s*）与图注的 (.*\S) 都能吃下同一段空白，.* 又跨不过行终止符，图注含行终止符
// 而失配时，对每一个分隔长度都把余下的空白重扫一遍。新式各段只扫一遍：前缀之后的首部空白、可选的分隔标点及其后的空白各取
// 极大，末尾由 trimEnd 定位。等价的判据：两个备选合起来，图注起点恰可取 1 至 top（分隔片段的末尾）的每一个位置且由大到小
// 尝试；起点 p 成功当且仅当 p < end（trimEnd 之后的长度）且 [p, end) 不含行终止符。p 越小区间越大，最大可取的起点
// min(top, end - 1) 失败则更小的起点也都失败，故只需检验这一个
function matchCaption(text) {
    const head = CAPTION_HEAD_RE.exec(text);
    if (!head) return null;
    const rest = text.slice(head[0].length);
    const lead = skipSpaces(rest, 0);
    const top = CAPTION_SEPARATORS.has(rest[lead]) ? skipSpaces(rest, lead + 1) : lead;
    const end = rest.trimEnd().length;
    const start = Math.min(top, end - 1);
    if (start < 1) return null;
    const caption = rest.slice(start, end);
    return LINE_TERMINATOR_RE.test(caption) ? null : [head[1], caption];
}

function skipSpaces(text, from) {
    let at = from;
    while (at < text.length && SPACE_RE.test(text[at])) at += 1;
    return at;
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

module.exports = { isPureLabel, parseLabel, matchCaption, buildFigures, buildImg, assetNameOf, LABEL_RE };
