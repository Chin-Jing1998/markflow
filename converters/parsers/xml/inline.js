/**
 * 五书反向导入的行内映射：DTD 行内元素 → mdast 行内节点（renderers/xml/inline.js 的逆映射）
 *
 * toInline(children, ctx) → Promise<mdast 行内节点[]>
 *   ctx = { dir, images, report }：dir 为所属 XML 的目录键，images 为 images.js 的 importer，report 为导入问题清单
 *   b → strong，i → emphasis，u → underline，sup → superscript，sub → subscript，br → break，img → image；
 *   maths / tables / chemistry → 其内首个 img 对应的 image 节点，并带 data.role（formula / table / chemistry），
 *     正向渲染器据此重新包成同名元素；代码化分支（math、table、chem、cn-mathf、cn-tablef）不导入，没有图片时退为其文字；
 *   claim-ref / figref / crossref → 元素内的文字（官方转换器不生成这些元素，引用一律是纯文本）；
 *   pb 丢弃；smallcaps、overscore 与其它未映射元素只取其文字。丢失的信息逐处记入 report。
 *   缺图（文件缺失、引用越界、格式不认）写成文字占位 missingImageText(file)，让使用者在 Word 里看得见缺了哪张图。
 * trimInline(nodes) → 去掉首尾的空白文本与换行（只认半角空格、制表符与换行，不动不间断空格——官方样稿段首段尾的
 *   U+00A0 是原稿手工缩进的一部分）
 * plainText(node) → 元素内全部文字（不含图片），供图号段、发明名称长度等判定使用
 *
 * 文本归一：XML 里的换行是排版而非内容（本工具的序列化器会把只含元素的 p 缩进成多行，手写 XML 也常折行）。
 * 含换行的空白串按两侧字符处理：两侧皆有字符时，任一侧是汉字或全角标点即删除，否则换成一个空格；落在文本节点边界上时
 * 只看另一侧，另一侧是汉字、全角标点或同样落在边界上（整个节点只有排版空白）即删除，是西文等其余字符则换成一个空格。
 * 正向链路 renderers/xml/inline.js 的 joinSoftBreaks 口径与此不同：只在两侧都是汉字或全角标点时删除，
 * 其余情形（含节点边界处）一律换成一个空格。
 */
const ROLE_BY_WRAPPER = Object.freeze({ maths: 'formula', tables: 'table', chemistry: 'chemistry' });
const MARK_NODE_TYPES = Object.freeze({ b: 'strong', i: 'emphasis', u: 'underline', sup: 'superscript', sub: 'subscript' });
const REFERENCE_ELEMENTS = new Set(['claim-ref', 'figref', 'crossref']);
const STYLE_ONLY_ELEMENTS = new Set(['smallcaps', 'overscore']);
const CODED_OBJECT_ELEMENTS = new Set(['math', 'table', 'chem', 'cn-mathf', 'cn-tablef']);
const IMG = 'img';
const DEFAULT_UNDERLINE_STYLE = 'single';
// 换行归一只匹配自换行起的部分：「\r?\n」及其后的极大空白；紧邻其前的空格与制表符由 joinLineBreaks 向前回看并入。首项在每个
// 位置只做常数步判定，尾部贪婪量词后无后续项、不回溯。不写成 /[ \t]*\r?\n[ \t\r\n]*/g：其前导量词在不以换行结尾的空格制表符
// 长段上从每个起点都吞到段尾、再因缺换行逐位回退而失败，耗时随段长平方增长
const LINE_BREAK_RE = /\r?\n[ \t\r\n]*/g;
const EDGE_SPACE_START_RE = /^[ \t\r\n]+/;
// 末尾修剪逐字符判定用的单字符正则，字符集与 EDGE_SPACE_START_RE 相同
const EDGE_SPACE_CHAR_RE = /[ \t\r\n]/;
// 汉字、全角标点：与 renderers/xml/inline.js 的 CJK_RANGES 同一范围，两份须同步修改。按码点声明——区间端点里的兼容表意字与
// 常用字字形相同，写成字面量无从分辨。
// 末项 U+20000–U+3FFFF 为第 2、3 平面整段，据 Unicode 官方路线图（2026 年版）整段计为汉字：第 2 平面 SIP 专收中日韩统一表意文字
// 扩展 B、C、D、E、F、I，兼容表意文字补充与统一表意文字部件 A、B（https://www.unicode.org/roadmaps/sip/）；第 3 平面 TIP 专收
// 扩展 G、H、J 与篆书（https://www.unicode.org/roadmaps/tip/）；两个平面都不收其他文字。第 1 平面的西夏文、女书、表情符号等不计入
const CJK_RANGES = Object.freeze([
    [0x2E80, 0x2FFF], [0x3000, 0x303F], [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xF900, 0xFAFF], [0xFF00, 0xFFEF], [0x20000, 0x3FFFF],
]);
// 按码点做数值判定。原先由 String.fromCharCode 拼成的字符类不带 u 标志、逐个 UTF-16 码元比对，写不出增补平面的区间；
// BMP 码点的判定与原字符类逐一相同——前六项未变，末项只含大于 0xFFFF 的码点
const isCjkCodePoint = (codePoint) => CJK_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
// 一个完整字符（单个码元或一对代理）是否为汉字、全角标点；空串（串首、串尾，即没有字符）不是
const isCjkChar = (char) => char !== '' && isCjkCodePoint(char.codePointAt(0));

const textNode = (value) => ({ type: 'text', value });
const missingImageText = (file) => `［缺图：${file || '未注明文件名'}］`;

async function toInline(children, ctx) {
    const out = [];
    for (const child of Array.isArray(children) ? children : []) out.push(...await inlineOf(child, ctx));
    return mergeText(out);
}

async function inlineOf(node, ctx) {
    if (!node) return [];
    if (node.type === 'text') {
        const value = joinLineBreaks(node.value);
        return value ? [textNode(value)] : [];
    }
    if (node.type !== 'element') return [];
    const { name } = node;
    if (MARK_NODE_TYPES[name]) return markOf(node, ctx);
    if (name === 'br') return [{ type: 'break' }];
    if (name === IMG) return [await imageOf(node, ctx)];
    if (ROLE_BY_WRAPPER[name]) return wrapperOf(node, ctx);
    if (name === 'pb') { ctx.report.loss('pageBreak'); return []; }
    if (REFERENCE_ELEMENTS.has(name)) ctx.report.loss('references', name);
    else if (STYLE_ONLY_ELEMENTS.has(name)) ctx.report.loss('inlineStyle', name);
    else ctx.report.loss('unmapped', `<${name}>`);
    return toInline(node.children, ctx);
}

async function markOf(node, ctx) {
    if (node.name === 'u' && node.attrs.style && node.attrs.style !== DEFAULT_UNDERLINE_STYLE) ctx.report.loss('inlineStyle', `u style="${node.attrs.style}"`);
    const children = await toInline(node.children, ctx);
    return children.length > 0 ? [{ type: MARK_NODE_TYPES[node.name], children }] : [];
}

async function imageOf(node, ctx, role) {
    noteImageAttributes(node, ctx.report);
    const image = await ctx.images.importImage(ctx.dir, node.attrs, { role });
    return image || textNode(missingImageText(String(node.attrs.file || '').trim()));
}

// img 上回转时会被改写的属性：只在取值偏离官方固定值时才记（官方产物自身不触发）
function noteImageAttributes(node, report) {
    const { attrs } = node;
    if ((attrs.top && attrs.top !== '0') || (attrs.left && attrs.left !== '0')) report.loss('imageAttributes', 'top / left');
    if (attrs['img-content'] && attrs['img-content'] !== 'drawing') report.loss('imageAttributes', `img-content="${attrs['img-content']}"`);
    if (node.children.some((child) => child.type === 'element')) report.loss('unmapped', '<cn-img-p>');
}

// maths / tables / chemistry：取其内的 img（DTD 规定至多一个，多出的照样导入）；代码化内容记为丢失
async function wrapperOf(node, ctx) {
    const role = ROLE_BY_WRAPPER[node.name];
    const images = findImages(node);
    if (hasCodedContent(node)) ctx.report.loss('codedObject', `<${node.name}>`);
    if (images.length === 0) return toInline(node.children.filter((child) => !(child.type === 'element' && child.name === IMG)), codedTextCtx(ctx));
    const out = [];
    for (const image of images) out.push(await imageOf(image, ctx, role));
    return out;
}

// 没有图片的 maths / tables：退为其文字，内部元素不再逐个记「未映射」（已整体记过 codedObject）
const codedTextCtx = (ctx) => ({ ...ctx, report: { ...ctx.report, loss: () => {} } });

function findImages(node) {
    const found = [];
    const stack = [...node.children].reverse();
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current || current.type !== 'element') continue;
        if (current.name === IMG) { found.push(current); continue; }
        stack.push(...[...current.children].reverse());
    }
    return found;
}

const hasCodedContent = (node) => node.children.some((child) => child.type === 'element' && CODED_OBJECT_ELEMENTS.has(child.name));

// ============================================================
// 文本归一与整理
// ============================================================

/**
 * 含换行的空白串按两侧字符归一（口径见文件头与 edgeJoin）。LINE_BREAK_RE 只匹配自换行起的部分，紧邻其前的极大空格制表符段
 * 在此逐段向前回看并入，回看不越过上一段的结束位置 cursor（首段为 0）；各段回看扫过的区间互不重叠，总成本线性于串长。
 *
 * 与旧式全局正则「[ \t]*\r?\n[ \t\r\n]*」的 replace 逐字等价。两种写法都自上一段的结束位置 cursor 续查。设 q 为不小于 cursor、
 * 「\r?\n」能在此匹配的首个位置；旧的最左匹配起点为 p、其中换行的位置为 r。[p, r) 全为空格或制表符，且 r 同为「\r?\n」能匹配
 * 的位置，故 r ≥ q；q 本身又是旧正则的可行起点，故 p ≤ q。若 r > q，则 q 落在 [p, r) 内而须为空格或制表符，与 whole[q] 为
 * 回车或换行矛盾，故 r = q，p 取可行起点中最左者，即 max(cursor, 紧邻 q 之前的极大空格制表符段的起点)，恰为回看所得。换行部分
 * 二者都在 q 处以同样的贪婪方式匹配「\r?\n」，尾部 [ \t\r\n]* 同为极大匹配，故段终点相同，传给判定的 before、after 逐字一致。
 * 尾部字符集含空格与制表符，上一段结束位置上的字符不可能是空格或制表符（除非已到串尾），故回看实际总是先止于别的字符或串首，
 * 「不越过 cursor」只起防御作用。
 *
 * 两侧字符按完整码点取（charEndingAt、charStartingAt）。增补平面的汉字在 UTF-16 串里是一对代理，原先按码元取 whole[start - 1]
 * 与 whole[cursor]，换行前只取到低代理、换行后只取到高代理，都判为非汉字，于是多出一个空格。新取法只在一侧是成对代理时与按
 * 码元取不同，而成对代理的码点不在 U+20000–U+3FFFF 时仍判为非汉字；BMP 字符与孤立代理照旧取该码元，判定与改动前逐一相同。
 * 因此结果只在一侧是增补平面汉字时改变；上段所证的逐字等价就段的划分与回看而言依然成立
 */
function joinLineBreaks(value) {
    const whole = String(value == null ? '' : value);
    const pieces = [];
    let cursor = 0;
    for (const match of whole.matchAll(LINE_BREAK_RE)) {
        let start = match.index;
        while (start > cursor && (whole[start - 1] === ' ' || whole[start - 1] === '\t')) start -= 1;
        pieces.push(whole.slice(cursor, start));
        cursor = match.index + match[0].length;
        pieces.push(joinOneLineBreak(charEndingAt(whole, start), charStartingAt(whole, cursor)));
    }
    pieces.push(whole.slice(cursor));
    return pieces.join('');
}

// 单段的替换判定，与改写前的回调相同：before、after 为段两侧的完整字符（成对代理合为一个，串首、串尾为空串）。任一侧为空即落在
// 文本节点边界上，交 edgeJoin；两侧皆有字符时，任一侧为汉字或全角标点即删除，否则换成一个空格
function joinOneLineBreak(before, after) {
    if (!before || !after) return edgeJoin(before || after);
    return isCjkChar(before) || isCjkChar(after) ? '' : ' ';
}

// 换行落在文本节点的边界上：另一侧是汉字或同样为空（整个节点只有排版空白）即删除，西文留一个空格
const edgeJoin = (neighbor) => (!neighbor || isCjkChar(neighbor) ? '' : ' ');

// 段两侧的完整字符，串首、串尾为空串，与 renderers/xml/inline.js 的同名函数相同。charEndingAt 取止于下标 index 的字符：前一位是
// 低代理、再前一位是高代理时二者合为一个码点，否则取前一位的码元；charStartingAt 取始于 index 的字符：codePointAt 在高代理后接
// 低代理处得整个码点，否则得该码元。孤立代理因而照旧按单个码元判定，不算汉字
function charEndingAt(whole, index) {
    if (index <= 0) return '';
    const paired = index >= 2 && isLowSurrogate(whole.charCodeAt(index - 1)) && isHighSurrogate(whole.charCodeAt(index - 2));
    return whole.slice(paired ? index - 2 : index - 1, index);
}

function charStartingAt(whole, index) {
    if (index >= whole.length) return '';
    return whole.slice(index, index + (whole.codePointAt(index) > 0xFFFF ? 2 : 1));
}

const isHighSurrogate = (unit) => unit >= 0xD800 && unit <= 0xDBFF;
const isLowSurrogate = (unit) => unit >= 0xDC00 && unit <= 0xDFFF;

function mergeText(nodes) {
    const out = [];
    for (const node of nodes) {
        const last = out[out.length - 1];
        if (node.type === 'text' && last && last.type === 'text') out[out.length - 1] = textNode(last.value + node.value);
        else out.push(node);
    }
    return out;
}

/**
 * 剥去首尾的空白节点（换行，或只含 [ \t\r\n] 的文本），再去首个文本节点的前导空白、末个文本节点的尾部空白。
 * 保留区间 [start, end) 先以下标求出、只切片一次。旧写法每剥去一个首尾节点就 slice 一次整个数组，首尾有 n 个空白节点时
 * 复制量随 n 平方增长（一段里段首连写 8 万个 <br/>、XML 约 400 KB 即耗时约 2 秒）；现各节点至多判定一次，数组只在展开与
 * 切片时各复制一次，总成本线性于节点数。
 *
 * 与逐个 slice 的旧写法等价：旧式第一个循环删去极大的空白前缀，第二个循环删去剩余部分的极大空白后缀。start 为首个非空白
 * 节点的下标（没有则为长度），end 为最后一个非空白节点的下标加一（没有则等于 start），[start, end) 正是旧式剩下的区间；
 * isBlankEdge 无副作用，且两式对它的调用次序与次数本就相同。全为空白时旧式第一个循环删光、第二个循环不执行，新式 start
 * 为长度、end 等于 start，结果同为空数组。两式都在新数组上替换首末元素，不改动入参 nodes
 */
function trimInline(nodes) {
    const all = [...nodes];
    let start = 0;
    while (start < all.length && isBlankEdge(all[start])) start += 1;
    let end = all.length;
    while (end > start && isBlankEdge(all[end - 1])) end -= 1;
    const list = all.slice(start, end);
    if (list.length === 0) return list;
    const first = list[0];
    if (first.type === 'text') list[0] = textNode(first.value.replace(EDGE_SPACE_START_RE, ''));
    const last = list[list.length - 1];
    if (last.type === 'text') list[list.length - 1] = textNode(trimEdgeSpaceEnd(last.value));
    return list;
}

const isBlankEdge = (node) => node.type === 'break' || (node.type === 'text' && node.value.replace(EDGE_SPACE_START_RE, '') === '');

// 自串尾逐字符回退，代替「量词 + 行尾锚」的 /[ \t\r\n]+$/：该正则在不处于串尾的空白长段上从每个起点都贪婪吃到段尾再逐位回溯，
// 耗时随段长平方增长。只认 EDGE_SPACE_CHAR_RE 的四个字符，不能换成 trimEnd（它会删去 U+00A0，见文件头）
function trimEdgeSpaceEnd(text) {
    let end = text.length;
    while (end > 0 && EDGE_SPACE_CHAR_RE.test(text[end - 1])) end -= 1;
    return text.slice(0, end);
}

function plainText(node) {
    if (!node) return '';
    if (node.type === 'text') return node.value;
    if (node.type !== 'element' || !Array.isArray(node.children)) return '';
    return node.children.map(plainText).join('');
}

/** mdast 行内节点的纯文字（图片不计） */
function inlineText(nodes) {
    return (Array.isArray(nodes) ? nodes : []).map((node) => {
        if (node.type === 'text') return node.value;
        return Array.isArray(node.children) ? inlineText(node.children) : '';
    }).join('');
}

module.exports = { toInline, trimInline, plainText, inlineText, missingImageText, joinLineBreaks, ROLE_BY_WRAPPER };
