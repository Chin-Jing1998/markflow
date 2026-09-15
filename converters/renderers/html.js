/**
 * IR → HTML 字符串
 *
 * 职责：mdast → hast（remark-rehype）→ HTML（rehype-stringify），套主题样式输出完整页面。
 * 既是 html 目标的产物，也是 PDF 渲染的中间产物（Electron/Chromium 打印），因此：
 *   - 关闭 remark-rehype 的 allowDangerousHtml，IR 中的原始 HTML 只保留去标签后的文本，杜绝脚本注入；
 *     例外只有两处，且都经本文件的白名单校验后才以 raw 节点原样输出：
 *       ① 带 data.safeTable 的 html 节点（上游 ir/sanitize-table.js 清洗过的 <table>）；
 *       ② math 节点里的 MathML（根须为 <math>，标签与属性均须命中 MathML 白名单）。
 *     校验不通过一律降级为纯文本，绝不放行半信半疑的片段。
 *   - 图片寻址由调用方经 imageMode 指定（converters/index.js 按目标推导）：
 *       'file'      仅 data.asset.absPath → file://，供打印进程读盘（PDF 目标）；
 *       'relative'  src = 资产名（images/image_N.jpg），与 writeFolder 落盘的 images/ 对应；
 *       'inline'    从 doc.assets 或 data.asset.buffer 取字节转 data URI；
 *       { base }    src = base + 资产名，供桌面端经 mf-asset://<sid>/ 授权取图。
 *     无本地资产的图片一律丢弃 src 只留 alt：打印窗口与预览窗口都在本机运行，若保留远程或内网 URL，
 *     Chromium 会实际发起请求，等于把已被 SSRF 守卫拦下的地址重新放行，并暴露本机可达性。
 *   - <head> 声明 CSP，img-src 随寻址模式收紧（file: / 'self' / data: / 自定义协议），
 *     其余 default-src 'none' 与 style-src 'unsafe-inline' 不变，从浏览器侧再封一道外发通道。
 *   - 样式来自 renderers/html-themes：:root 变量（字体、字号、行高、栏宽、间距）+ 主题 CSS，
 *     不引用任何远程资源。省略 options 时按打印场景取值（print 主题 + file 寻址），与 v2 行为一致。
 */
const { pathToFileURL } = require('url');
const { stripHtml } = require('../ir/util');
const { loadUnified } = require('../ir/unified-loader');
const { downgradeCustomNodes, mathToText } = require('../ir/schema');
const { stripMarkersTree, applyTextLayout } = require('../ir/markers');
const { normalizeOptions, DEFAULT_OPTIONS } = require('../options');
const { buildStyles } = require('./html-themes');

/** 省略 options 时的取值：PDF 中间产物与直调沿用 v2 的打印样式 */
const PRINT_HTML_OPTIONS = Object.freeze({ ...DEFAULT_OPTIONS.html, theme: 'print' });
const DEFAULT_IMAGE_MODE = 'file';

/** 图片寻址模式 → CSP 的 img-src 值；{ base } 模式由 base 的协议派生 */
const IMG_SRC_BY_MODE = Object.freeze({
    file: 'file: data:',
    relative: "'self' file: data:",
    inline: 'data:',
});
const IMAGE_MODES = Object.freeze(Object.keys(IMG_SRC_BY_MODE));
const URL_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\//;
const IMAGE_MIME_RE = /^image\/[a-z0-9.+-]+$/;
const PX_RE = /^\d{1,5}$/;
const MAX_PERCENT = 100;

// ============================================================
// 入口
// ============================================================

/**
 * @param {object} doc MarkFlowDocument
 * @param {object} [options] 经 converters/options.js 归一的选项；省略则按打印场景取默认值
 * @param {{ imageMode?: 'file'|'relative'|'inline'|{ base: string } }} [context]
 * @returns {Promise<string>} 完整 HTML 页面
 */
async function render(doc, options, context = {}) {
    if (!doc || typeof doc !== 'object') throw new Error('html 渲染器需要 doc 对象');
    const htmlOptions = options === undefined || options === null ? PRINT_HTML_OPTIONS : normalizeOptions(options).html;
    const mode = normalizeImageMode(context && context.imageMode);
    const resolveSrc = createImageResolver(doc, mode);

    const { unified, remarkRehype, rehypeStringify } = await loadUnified();
    // 残留标记兜底剥除；段首缩进与制表符按 md 渲染器的同一约定落为全角空格（HTML 不折叠 U+3000）
    const root = downgradeCustomNodes(applyTextLayout(stripMarkersTree(doc.ir || { type: 'root', children: [] })));

    const hast = await unified()
        .use(remarkRehype, {
            allowDangerousHtml: false,
            handlers: { image: createImageHandler(resolveSrc), html: htmlHandler, math: mathHandler, underline: underlineHandler },
        })
        .run(root);
    // stringify 的 allowDangerousHtml 只影响 raw 节点，而 raw 节点仅由本文件在白名单校验通过后自建；
    // remark-rehype 侧仍为 false，IR 的 html 节点不会自动变成 raw
    const body = unified().use(rehypeStringify, { allowDangerousHtml: true }).stringify(hast);

    const title = escapeHtml((doc.meta && doc.meta.title) || '');
    const styles = buildStyles(htmlOptions, { theme: htmlOptions.theme });
    return wrapDocument(title, body, styles, buildCsp(mode));
}

// ============================================================
// 图片寻址
// ============================================================

/** 归一为 { kind, base?, scheme? }；非法值抛中文错误，绝不静默回退到宽松模式 */
function normalizeImageMode(mode) {
    if (mode === undefined || mode === null) return { kind: DEFAULT_IMAGE_MODE };
    if (typeof mode === 'string') {
        if (!Object.prototype.hasOwnProperty.call(IMG_SRC_BY_MODE, mode)) {
            throw new Error(`未知的图片寻址模式：${JSON.stringify(mode)}（可用：${IMAGE_MODES.join(' | ')} 或 { base }）`);
        }
        return { kind: mode };
    }
    if (typeof mode === 'object' && typeof mode.base === 'string') {
        const base = mode.base.trim();
        const matched = URL_SCHEME_RE.exec(base);
        if (!matched) {
            throw new Error(`图片寻址 base 须为带协议的前缀（形如 mf-asset://<sid>/），实际：${JSON.stringify(mode.base)}`);
        }
        return { kind: 'base', base: base.endsWith('/') ? base : `${base}/`, scheme: matched[1].toLowerCase() };
    }
    throw new Error(`图片寻址模式须为 ${IMAGE_MODES.join(' | ')} 之一或 { base } 对象`);
}

function buildCsp(mode) {
    const imgSrc = mode.kind === 'base' ? `${mode.scheme}: data:` : IMG_SRC_BY_MODE[mode.kind];
    return `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src file: data:`;
}

/**
 * 按模式返回 (imageNode) → src 字符串（无本地来源时返回空串）。
 * 资产名寻址优先 data.assetName（md 文档由 parsers/md.js 写入），其次 node.url 命中 doc.assets 的
 * 某个资产名（docx/pptx/url 三类 parser 直接以资产名作节点地址）。两条路径都要求资产确实在
 * doc.assets 中，以保证 src 指向的文件必然随产物一起落盘。
 */
function createImageResolver(doc, mode) {
    const byName = new Map();
    for (const asset of Array.isArray(doc.assets) ? doc.assets : []) {
        if (!asset || typeof asset.name !== 'string' || !asset.name) continue;
        if (!byName.has(asset.name)) byName.set(asset.name, asset);
    }

    const assetNameOf = (node) => {
        const data = (node && node.data) || {};
        if (typeof data.assetName === 'string' && byName.has(data.assetName)) return data.assetName;
        if (typeof node.url === 'string' && byName.has(node.url)) return node.url;
        return '';
    };

    if (mode.kind === 'file') return (node) => fileUrlOf(node);
    if (mode.kind === 'inline') return (node) => dataUriOf(node, byName.get(assetNameOf(node)));
    if (mode.kind === 'relative') return (node) => encodeAssetPath(assetNameOf(node));
    return (node) => {
        const name = assetNameOf(node);
        return name ? `${mode.base}${encodeAssetPath(name)}` : '';
    };
}

/** file 模式只认 data.asset.absPath；解析失败或根本没有本地文件时返回空串，绝不回退到原始 url */
function fileUrlOf(node) {
    const asset = node.data && node.data.asset;
    if (!asset || typeof asset.absPath !== 'string' || !asset.absPath) return '';
    try {
        return pathToFileURL(asset.absPath).href;
    } catch (err) {
        return '';
    }
}

/** inline 模式：优先用 doc.assets 中的字节（已经过图片归一），回退到节点自带的 data.asset */
function dataUriOf(node, asset) {
    const local = (node.data && node.data.asset) || {};
    const buffer = (asset && Buffer.isBuffer(asset.buffer) && asset.buffer)
        || (Buffer.isBuffer(local.buffer) && local.buffer)
        || null;
    const mime = imageMime(asset && asset.mime) || imageMime(local.mime);
    if (!buffer || buffer.length === 0 || !mime) return '';
    return `data:${mime};base64,${buffer.toString('base64')}`;
}

function imageMime(value) {
    const mime = String(value || '').trim().toLowerCase();
    return IMAGE_MIME_RE.test(mime) ? mime : '';
}

/** 资产名逐段百分号编码：空格、引号等字符不会破坏属性，'/' 保持为路径分隔符 */
function encodeAssetPath(name) {
    if (!name) return '';
    return name.split('/').map(encodeURIComponent).join('/');
}

// ============================================================
// 自定义 handler
// ============================================================

/** image：按 imageMode 解析 src；无本地来源时不输出 src，只保留 alt 占位；有来源时带校验后的显示宽高 */
function createImageHandler(resolveSrc) {
    return (state, node) => {
        const src = resolveSrc(node) || '';
        const properties = src ? { src } : {};
        if (node.alt !== null && node.alt !== undefined) properties.alt = node.alt;
        // title 仅在图片确有本地来源时保留，无来源的图片降级为纯 alt 占位
        if (src && node.title !== null && node.title !== undefined) properties.title = node.title;
        if (src) Object.assign(properties, displayAttributes(node));
        const result = { type: 'element', tagName: 'img', properties, children: [] };
        state.patch(node, result);
        return state.applyData(node, result);
    };
}

/** data.display → width / height 属性：px 为 1–99999 的整数（height 仅 px），百分比为 (0, 100]；不合规不输出 */
function displayAttributes(node) {
    const display = node.data && node.data.display;
    if (!display || !Number.isFinite(display.width) || display.width <= 0) return {};
    if (display.unit === '%') return display.width <= MAX_PERCENT ? { width: `${display.width}%` } : {};
    const width = String(Math.round(display.width));
    if (!PX_RE.test(width)) return {};
    const attrs = { width };
    const height = Number.isFinite(display.height) ? String(Math.round(display.height)) : '';
    if (height && PX_RE.test(height) && Number(height) > 0) attrs.height = height;
    return attrs;
}

/** underline：<u> 元素 */
function underlineHandler(state, node) {
    const result = { type: 'element', tagName: 'u', properties: {}, children: state.all(node) };
    state.patch(node, result);
    return state.applyData(node, result);
}

/**
 * html：带 data.safeTable 的节点是上游白名单清洗过的 <table>，再校验一次标签与属性后原样输出；
 * 其余原始 HTML 不透传，去标签后仅保留文本（script/style 连同内容一并丢弃）
 */
function htmlHandler(state, node) {
    const raw = typeof node.value === 'string' ? node.value.trim() : '';
    if (node.data && node.data.safeTable === true && isSafeMarkup(raw, SAFE_TABLE_SPEC)) {
        const result = { type: 'raw', value: raw };
        state.patch(node, result);
        return result;
    }
    const value = stripHtml(raw);
    if (!value.trim()) return undefined;
    const result = { type: 'text', value };
    state.patch(node, result);
    return result;
}

/** math：MathML 通过白名单校验则原样输出，否则降级为 <span class="mf-math"> 线性化文本 */
function mathHandler(state, node) {
    const data = (node && node.data) || {};
    const mathml = typeof data.mathml === 'string' ? data.mathml.trim() : '';
    const result = isSafeMarkup(mathml, MATHML_SPEC)
        ? { type: 'raw', value: mathml }
        : mathSpan(mathToText(node), data.display === true);
    state.patch(node, result);
    return result;
}

function mathSpan(text, display) {
    return {
        type: 'element',
        tagName: 'span',
        properties: { className: display ? ['mf-math', 'mf-math-display'] : ['mf-math'] },
        children: [{ type: 'text', value: text }],
    };
}

// ============================================================
// 原样输出片段的白名单校验
// ============================================================

const SAFE_TABLE_SPEC = Object.freeze({
    root: 'table',
    tags: new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td']),
    attrs: new Set(['colspan', 'rowspan']),
    valueRe: /^[0-9]{1,3}$/,
});

/** MathML 表现层元素子集：不含 annotation-xml（可嵌 XHTML）、maction、mglyph（带 src） */
const MATHML_SPEC = Object.freeze({
    root: 'math',
    tags: new Set([
        'math', 'semantics', 'annotation', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace',
        'mfrac', 'msqrt', 'mroot', 'mstyle', 'merror', 'mpadded', 'mphantom', 'menclose', 'mfenced',
        'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover', 'mmultiscripts', 'mprescripts', 'none',
        'mtable', 'mtr', 'mtd', 'mlabeledtr',
    ]),
    // 只放行表现属性：不含 href/xlink:href 等可点击跳转的属性，事件属性（on*）自然落在白名单之外
    attrs: new Set([
        'xmlns', 'class', 'id', 'display', 'displaystyle', 'scriptlevel', 'dir', 'encoding', 'alttext',
        'mathvariant', 'mathsize', 'mathcolor', 'mathbackground', 'fontweight', 'fontstyle',
        'stretchy', 'fence', 'separator', 'largeop', 'movablelimits', 'accent', 'accentunder', 'form',
        'lspace', 'rspace', 'linethickness', 'numalign', 'denomalign', 'bevelled', 'notation',
        'width', 'height', 'depth', 'voffset', 'align', 'columnalign', 'rowalign', 'columnspan', 'rowspan',
        'columnlines', 'rowlines', 'columnspacing', 'rowspacing', 'frame', 'framespacing',
        'equalrows', 'equalcolumns', 'side', 'minlabelspacing', 'open', 'close', 'separators',
        'subscriptshift', 'superscriptshift', 'maxsize', 'minsize', 'symmetric', 'linebreak',
    ]),
    valueRe: /^[^<>"'`\\]*$/,
});

const TAG_RE = /<[^>]*>/g;
const TAG_SHAPE_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^>]*)?)(\/?)>$/;
const ATTR_RE = /([^\s=/]+)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/**
 * 白名单校验：根元素、标签名、属性名与属性值全部命中 spec 才算安全，标签须成对闭合，
 * 且不得出现注释、DOCTYPE、处理指令或游离的 '<'。任何不确定的形态一律判为不安全（默认拒绝）。
 */
function isSafeMarkup(value, spec) {
    if (typeof value !== 'string') return false;
    const text = value.trim();
    if (!text || text.includes('<!') || text.includes('<?')) return false;
    if (!new RegExp(`^<${spec.root}[\\s/>]`, 'i').test(text)) return false;
    if (!new RegExp(`</${spec.root}\\s*>$`, 'i').test(text)) return false;

    let cursor = 0;
    let depth = 0;
    TAG_RE.lastIndex = 0;
    for (let matched = TAG_RE.exec(text); matched; matched = TAG_RE.exec(text)) {
        if (text.slice(cursor, matched.index).includes('<')) return false;
        const tag = parseTag(matched[0]);
        if (!tag || !spec.tags.has(tag.name)) return false;
        if (tag.closing) {
            if (tag.attrText.trim()) return false;
            depth -= 1;
            if (depth < 0) return false;
        } else {
            if (!attrsAllowed(tag.attrText, spec)) return false;
            if (!tag.selfClosing) depth += 1;
        }
        cursor = TAG_RE.lastIndex;
    }
    return depth === 0 && !text.slice(cursor).includes('<');
}

function parseTag(raw) {
    const matched = TAG_SHAPE_RE.exec(raw);
    if (!matched) return null;
    let attrText = matched[3] || '';
    let selfClosing = matched[4] === '/';
    // `<mspace width="1em"/>` 中的 '/' 会被贪婪的属性段吃掉，此处补回自闭合判定
    if (!selfClosing && /\/\s*$/.test(attrText)) {
        selfClosing = true;
        attrText = attrText.replace(/\/\s*$/, '');
    }
    return { closing: matched[1] === '/', name: matched[2].toLowerCase(), attrText, selfClosing };
}

/** 属性段须被 ATTR_RE 完整覆盖：留下任何未识别的碎片即判为不安全 */
function attrsAllowed(attrText, spec) {
    const text = String(attrText || '').trim();
    if (!text) return true;
    let consumed = 0;
    ATTR_RE.lastIndex = 0;
    for (let matched = ATTR_RE.exec(text); matched; matched = ATTR_RE.exec(text)) {
        if (text.slice(consumed, matched.index).trim()) return false;
        if (!spec.attrs.has(matched[1].toLowerCase())) return false;
        if (!spec.valueRe.test(unquote(matched[2]))) return false;
        consumed = ATTR_RE.lastIndex;
    }
    return !text.slice(consumed).trim();
}

function unquote(value) {
    if (typeof value !== 'string') return '';
    const first = value[0];
    return (first === '"' || first === "'") && value.endsWith(first) ? value.slice(1, -1) : value;
}

// ============================================================
// 页面包装与工具
// ============================================================

function wrapDocument(title, body, styles, csp) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${styles}</style>
</head>
<body>
${body}
</body>
</html>`;
}


function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

module.exports = { render };
