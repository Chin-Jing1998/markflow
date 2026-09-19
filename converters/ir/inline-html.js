/**
 * 行内 HTML 提升：mdast 中可识别的原始 HTML 片段 → 标准节点
 *
 * 背景：Markdown 里的 <img width>、<u>、<strong> 等 HTML 片段经 remark 解析后只是 html 节点，图片收集
 * （assets/md-images 只认 type 'image'）与各渲染器都认不出来。本模块在解析后把其中安全、可识别的部分提升为节点：
 *   - 只含一个 <img> 的 html 节点 → image 节点；处于块级位置时包进段落
 *   - 块级的 <p|div|figure> 只包着 img / br（与 figcaption）→ 图片段落 + 图注段落（data.role = 'caption'）
 *   - 同级兄弟中成对的 <u> / <strong|b> / <em|i> / <del|s> / <sup> / <sub>
 *     → underline / strong / emphasis / delete / superscript / subscript，<br> → break；
 *     按栈配对，配不上的标签删除、保留其间内容；只包着图片的格式标签直接拆除（图片不承载粗斜体）
 *   - 其余 HTML 维持 html 节点，仍由各渲染器剥离
 *   - 发生过提升的兄弟序列里，相邻同类格式节点与相邻文本合并，同类嵌套拍平
 *
 * <img> 属性白名单：
 *   src     仅相对路径、data:image/*、http(s)；先解码实体、剔除控制字符再判定，拒绝 javascript: / vbscript: 等
 *           一切其它协议、协议相对地址（//host）与绝对路径；data:image/* 中另拒绝 svg+xml（不带 +xml 的
 *           image/svg 同拒，不区分大小写），纵深防御 SVG 内嵌脚本。不合规的 <img> 原样保留为 html 节点
 *   alt / title  纯文本，解码实体
 *   width / height  须匹配 ^\d{1,5}$（px）或 ^\d{1,3}(\.\d+)?%$；另认 style 中的 width / height: Npx；
 *           得到 data.display = { width, height?, unit: 'px' | '%', source }，height 只在宽高都是 px 时记录
 *   其余属性一律丢弃
 *
 * 契约：liftInlineHtml(tree, { source = 'html' } = {}) → 新树（不改动入参；无可提升内容时返回原引用）
 * 说明：HTML 片段属不可信内容，本模块只做词法识别与白名单重建，不执行其中任何指令。
 */

const FORMAT_TYPES = Object.freeze({
    u: 'underline', strong: 'strong', b: 'strong', em: 'emphasis', i: 'emphasis', del: 'delete', s: 'delete',
    sup: 'superscript', sub: 'subscript',
});
const PHRASING_PARENTS = new Set([
    'paragraph', 'heading', 'tableCell', 'emphasis', 'strong', 'delete', 'underline',
    'superscript', 'subscript', 'link', 'linkReference',
]);
const MERGEABLE_TYPES = new Set(['strong', 'emphasis', 'delete', 'underline', 'superscript', 'subscript']);

// 属性段：允许引号内出现 > 与 <，其余位置不允许
const ATTR_BODY = `(?:[^<>"']|"[^"]*"|'[^']*')*`;
const IMG_RE = new RegExp(`^<img\\b(${ATTR_BODY}?)\\s*\\/?>$`, 'i');
const TAG_RE = new RegExp(`^<(\\/)?([a-zA-Z][a-zA-Z0-9]*)(\\s${ATTR_BODY}?)?\\s*(\\/)?>$`);
const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const WRAPPER_RE = new RegExp(`^<(p|div|figure)\\b${ATTR_BODY}>([\\s\\S]*)<\\/\\1\\s*>$`, 'i');
const WRAPPER_TOKEN_SOURCE = `\\s+|<img\\b${ATTR_BODY}>|<br\\s*\\/?>|<figcaption\\b${ATTR_BODY}>([\\s\\S]*?)<\\/figcaption\\s*>`;

const PX_RE = /^\d{1,5}$/;
const PERCENT_RE = /^\d{1,3}(?:\.\d+)?%$/;
const MAX_PERCENT = 100;
const styleDimensionRe = (prop) => new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d{1,5}(?:\\.\\d+)?)px\\b`, 'i');
const STYLE_WIDTH_RE = styleDimensionRe('width');
const STYLE_HEIGHT_RE = styleDimensionRe('height');

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+[;,]/i;
// SVG 可内嵌脚本；经 <img> 引用虽不会执行，仍按纵深防御一律拒绝（不区分大小写，image/svg 与 image/svg+xml 均在内）
const DATA_IMAGE_SVG_RE = /^data:image\/svg(?:\+xml)?[;,]/i;
// 浏览器解析 URL 前会剔除的 C0 控制字符与空白，判定协议时一并去掉，防止 "java\tscript:" 一类绕过
const URL_CONTROL_RE = /[\x00-\x20\x7F-\x9F]/g;
const TEXT_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const NAMED_ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\xA0' });
const MAX_CODE_POINT = 0x10ffff;

function liftInlineHtml(tree, { source = 'html' } = {}) {
    return liftNode(tree, { source: String(source || 'html') });
}

function liftNode(node, ctx) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return node;
    const children = PHRASING_PARENTS.has(node.type) ? liftInline(node.children, ctx) : liftBlocks(node.children, ctx);
    return children === node.children ? node : { ...node, children };
}

// ============================================================
// 块级位置
// ============================================================

function liftBlocks(children, ctx) {
    let changed = false;
    const out = [];
    for (const child of children) {
        if (child && child.type === 'html') {
            const lifted = liftBlockHtml(child, ctx);
            if (lifted) {
                out.push(...lifted);
                changed = true;
                continue;
            }
            out.push(child);
            continue;
        }
        const next = liftNode(child, ctx);
        if (next !== child) changed = true;
        out.push(next);
    }
    return changed ? out : children;
}

function liftBlockHtml(node, ctx) {
    const value = String(node.value || '').trim();
    if (/^<img\b/i.test(value)) {
        const image = imageFromTag(value, ctx.source);
        return image ? [paragraph([image])] : null;
    }
    return liftWrapper(value, ctx);
}

/** <p|div|figure> 只包着 img / br / figcaption 时拆成图片段落 + 图注段落；夹杂其它任何内容即不提升 */
function liftWrapper(value, ctx) {
    const matched = WRAPPER_RE.exec(value);
    if (!matched) return null;
    const inner = matched[2];
    const tokenRe = new RegExp(WRAPPER_TOKEN_SOURCE, 'giy');
    const items = [];
    const captions = [];
    let index = 0;
    while (index < inner.length) {
        tokenRe.lastIndex = index;
        const token = tokenRe.exec(inner);
        if (!token || token.index !== index || token[0].length === 0) return null;
        const text = token[0];
        if (/^<img\b/i.test(text)) {
            const image = imageFromTag(text, ctx.source);
            if (!image) return null;
            items.push(image);
        } else if (/^<br/i.test(text)) {
            items.push({ type: 'break' });
        } else if (/^<figcaption/i.test(text)) {
            const caption = plainText(String(token[1] || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
            if (caption) captions.push(caption);
        }
        index = tokenRe.lastIndex;
    }
    const images = trimBreaks(items);
    if (!images.some((item) => item.type === 'image')) return null;
    return [
        paragraph(images),
        ...captions.map((caption) => ({ type: 'paragraph', data: { role: 'caption' }, children: [{ type: 'text', value: caption }] })),
    ];
}

function trimBreaks(items) {
    let start = 0;
    let end = items.length;
    while (start < end && items[start].type === 'break') start += 1;
    while (end > start && items[end - 1].type === 'break') end -= 1;
    return items.slice(start, end);
}

const paragraph = (children) => ({ type: 'paragraph', children });

// ============================================================
// 行内位置：按栈配对
// ============================================================

function liftInline(children, ctx) {
    const root = { type: null, nodes: [] };
    const stack = [root];
    const top = () => stack[stack.length - 1];
    let tokenSeen = false;
    let changed = false;

    for (const child of children) {
        const token = child && child.type === 'html' ? classifyInline(child.value, ctx.source) : null;
        if (!token) {
            const next = liftNode(child, ctx);
            if (next !== child) changed = true;
            top().nodes.push(next);
            continue;
        }
        tokenSeen = true;
        if (token.kind === 'image') top().nodes.push(token.node);
        else if (token.kind === 'break') top().nodes.push({ type: 'break' });
        else if (token.kind === 'open') stack.push({ type: token.type, nodes: [] });
        else closeFrame(stack, token.type);
    }
    // 未闭合的开标签：删标签，内容并回上一层
    while (stack.length > 1) {
        const orphan = stack.pop();
        top().nodes.push(...orphan.nodes);
    }
    if (tokenSeen) return mergeAdjacent(root.nodes);
    return changed ? root.nodes : children;
}

function closeFrame(stack, type) {
    let at = -1;
    for (let i = stack.length - 1; i >= 1; i -= 1) {
        if (stack[i].type === type) { at = i; break; }
    }
    // 无对应开标签：闭标签直接删除
    if (at < 1) return;
    // 夹在中间、先于它关闭的开标签视为未配对：删标签留内容
    while (stack.length - 1 > at) {
        const orphan = stack.pop();
        stack[stack.length - 1].nodes.push(...orphan.nodes);
    }
    const frame = stack.pop();
    stack[stack.length - 1].nodes.push(...wrapFrame(frame));
}

function wrapFrame(frame) {
    const nodes = frame.nodes;
    if (nodes.length === 0) return [];
    // 只包着图片（与换行、空白）的格式标签直接拆除
    if (nodes.every(isImageLike)) return nodes;
    const children = nodes.flatMap((node) => (node.type === frame.type && Array.isArray(node.children) ? node.children : [node]));
    return [{ type: frame.type, children: mergeAdjacent(children) }];
}

const isImageLike = (node) => node.type === 'image' || node.type === 'break'
    || (node.type === 'text' && !/\S/.test(String(node.value || '')));

function mergeAdjacent(nodes) {
    const out = [];
    for (const node of nodes) {
        const last = out[out.length - 1];
        if (last && node.type === 'text' && last.type === 'text') {
            out[out.length - 1] = { type: 'text', value: String(last.value || '') + String(node.value || '') };
            continue;
        }
        if (last && MERGEABLE_TYPES.has(node.type) && node.type === last.type) {
            out[out.length - 1] = { ...last, children: mergeAdjacent([...last.children, ...node.children]) };
            continue;
        }
        out.push(node);
    }
    return out;
}

/** 行内 html 节点 → { kind: 'image' | 'break' | 'open' | 'close', ... }；不认识的返回 null */
function classifyInline(raw, source) {
    const value = String(raw || '').trim();
    if (/^<img\b/i.test(value)) {
        const image = imageFromTag(value, source);
        return image ? { kind: 'image', node: image } : null;
    }
    const matched = TAG_RE.exec(value);
    if (!matched) return null;
    const [, closing, rawName, attrText, selfClosing] = matched;
    const name = rawName.toLowerCase();
    if (name === 'br') return closing ? null : { kind: 'break' };
    const type = FORMAT_TYPES[name];
    if (!type || selfClosing) return null;
    if (closing) return attrText && attrText.trim() ? null : { kind: 'close', type };
    return { kind: 'open', type };
}

// ============================================================
// <img> 白名单重建
// ============================================================

function imageFromTag(value, source) {
    const matched = IMG_RE.exec(String(value || '').trim());
    if (!matched) return null;
    const attrs = parseAttributes(matched[1] || '');
    const src = attrs.has('src') ? safeSrc(attrs.get('src')) : null;
    if (!src) return null;
    const node = {
        type: 'image',
        url: src,
        alt: attrs.has('alt') ? plainText(attrs.get('alt')) : '',
        title: attrs.has('title') ? plainText(attrs.get('title')) : null,
    };
    const display = displayFrom(attrs, source);
    if (display) node.data = { display };
    return node;
}

// 同名属性取首个（与浏览器一致）；属性名小写，值保持原样（未解码）
function parseAttributes(text) {
    const attrs = new Map();
    ATTR_RE.lastIndex = 0;
    for (let matched = ATTR_RE.exec(text); matched; matched = ATTR_RE.exec(text)) {
        const name = matched[1].toLowerCase();
        if (attrs.has(name)) continue;
        attrs.set(name, matched[2] ?? matched[3] ?? matched[4] ?? '');
    }
    return attrs;
}

function safeSrc(raw) {
    const value = decodeEntities(raw).trim();
    if (!value) return null;
    const probe = value.replace(URL_CONTROL_RE, '');
    const scheme = SCHEME_RE.exec(probe);
    if (scheme) {
        const name = scheme[1].toLowerCase();
        if (name === 'http' || name === 'https') return /^https?:\/\/[^/\s]/i.test(probe) ? value : null;
        if (name === 'data') return DATA_IMAGE_RE.test(probe) && !DATA_IMAGE_SVG_RE.test(probe) ? value : null;
        return null;
    }
    // 协议相对地址、绝对路径与反斜杠开头的路径一律拒绝，只收相对路径
    if (/^[/\\]/.test(probe)) return null;
    return value;
}

function displayFrom(attrs, source) {
    const style = attrs.get('style') || '';
    const width = dimensionOf(attrs.get('width')) || styleDimension(style, STYLE_WIDTH_RE);
    if (!width) return null;
    const display = { width: width.value };
    if (width.unit === 'px') {
        const height = dimensionOf(attrs.get('height')) || styleDimension(style, STYLE_HEIGHT_RE);
        if (height && height.unit === 'px') display.height = height.value;
    }
    display.unit = width.unit;
    display.source = source;
    return display;
}

function dimensionOf(raw) {
    const value = decodeEntities(String(raw == null ? '' : raw)).trim();
    if (PX_RE.test(value)) {
        const px = Number(value);
        return px > 0 ? { value: px, unit: 'px' } : null;
    }
    if (PERCENT_RE.test(value)) {
        const percent = Number(value.slice(0, -1));
        return percent > 0 && percent <= MAX_PERCENT ? { value: percent, unit: '%' } : null;
    }
    return null;
}

function styleDimension(style, re) {
    const matched = re.exec(decodeEntities(style));
    if (!matched) return null;
    const px = Math.round(Number(matched[1]));
    return px > 0 ? { value: px, unit: 'px' } : null;
}

function plainText(raw) {
    return decodeEntities(String(raw == null ? '' : raw)).replace(TEXT_CONTROL_RE, '');
}

function decodeEntities(text) {
    return String(text).replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (entity, body) => {
        if (body[0] === '#') {
            const hex = body[1] === 'x' || body[1] === 'X';
            const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : entity;
        }
        const named = NAMED_ENTITIES[body.toLowerCase()];
        return named === undefined ? entity : named;
    });
}

module.exports = { liftInlineHtml, decodeEntities };
