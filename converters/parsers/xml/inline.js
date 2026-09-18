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
 * 含换行的空白串按两侧字符处理：任一侧是汉字、全角标点或节点边界即删除，否则换成一个空格——与正向链路
 * renderers/xml/inline.js 的 joinSoftBreaks 同一口径。
 */
const ROLE_BY_WRAPPER = Object.freeze({ maths: 'formula', tables: 'table', chemistry: 'chemistry' });
const MARK_NODE_TYPES = Object.freeze({ b: 'strong', i: 'emphasis', u: 'underline', sup: 'superscript', sub: 'subscript' });
const REFERENCE_ELEMENTS = new Set(['claim-ref', 'figref', 'crossref']);
const STYLE_ONLY_ELEMENTS = new Set(['smallcaps', 'overscore']);
const CODED_OBJECT_ELEMENTS = new Set(['math', 'table', 'chem', 'cn-mathf', 'cn-tablef']);
const IMG = 'img';
const DEFAULT_UNDERLINE_STYLE = 'single';
const LINE_BREAK_RE = /[ \t]*\r?\n[ \t\r\n]*/g;
const EDGE_SPACE_START_RE = /^[ \t\r\n]+/;
const EDGE_SPACE_END_RE = /[ \t\r\n]+$/;
// 汉字、全角标点：与 renderers/xml/inline.js 的 CJK_RE 同一范围。按码点声明——区间端点里的兼容表意字与常用字字形相同，
// 写成字面量无从分辨
const CJK_RANGES = Object.freeze([[0x2E80, 0x2FFF], [0x3000, 0x303F], [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xF900, 0xFAFF], [0xFF00, 0xFFEF]]);
const CJK_RE = new RegExp(`[${CJK_RANGES.map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('')}]`);

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

function joinLineBreaks(value) {
    return String(value == null ? '' : value).replace(LINE_BREAK_RE, (match, offset, whole) => {
        const before = whole[offset - 1] || '';
        const after = whole[offset + match.length] || '';
        if (!before || !after) return edgeJoin(before || after);
        return CJK_RE.test(before) || CJK_RE.test(after) ? '' : ' ';
    });
}

// 换行落在文本节点的边界上：另一侧是汉字或同样为空（整个节点只有排版空白）即删除，西文留一个空格
const edgeJoin = (neighbor) => (!neighbor || CJK_RE.test(neighbor) ? '' : ' ');

function mergeText(nodes) {
    const out = [];
    for (const node of nodes) {
        const last = out[out.length - 1];
        if (node.type === 'text' && last && last.type === 'text') out[out.length - 1] = textNode(last.value + node.value);
        else out.push(node);
    }
    return out;
}

function trimInline(nodes) {
    let list = [...nodes];
    while (list.length > 0 && isBlankEdge(list[0])) list = list.slice(1);
    while (list.length > 0 && isBlankEdge(list[list.length - 1])) list = list.slice(0, -1);
    if (list.length === 0) return list;
    const first = list[0];
    if (first.type === 'text') list[0] = textNode(first.value.replace(EDGE_SPACE_START_RE, ''));
    const last = list[list.length - 1];
    if (last.type === 'text') list[list.length - 1] = textNode(last.value.replace(EDGE_SPACE_END_RE, ''));
    return list;
}

const isBlankEdge = (node) => node.type === 'break' || (node.type === 'text' && node.value.replace(EDGE_SPACE_START_RE, '') === '');

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
