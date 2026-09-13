/**
 * XML 视图构建（方案 §3.4.6「直接打开 xml」与 §3.4.7「产物栏 xml 原文 / 结构双视图」）
 *
 * 纯逻辑，不依赖 Electron 与文件系统，可在普通 Node 中单测。
 *
 *   parseXml(text)                      → { ok: true, prolog, root } | { ok: false, error }
 *       自带的极简 XML 扫描器：声明 / DOCTYPE（含内部子集）/ 处理指令 / 注释 / CDATA / 元素 / 文本；
 *       标签不闭合、闭合名不匹配、多根、根后有内容一律判为不合法并给出中文错误，绝不抛出。
 *       预定义实体与数字引用解码，未知命名实体原样保留（官方 DTD 实体集不在本应用内解析）。
 *   formatXml(text, { indent })         → { xml, ok, error }   合法则按缩进重排，非法则原样回吐
 *   detectProfile(root)                 → 'patent' | 'generic' | null
 *       patent：根元素 cn-application-body（国知局五书）；generic：根为 urn:markflow:document:1 的 document
 *   buildXmlView(text, { assetBase?, indent?, label? }) → { kind: 'xml', xml, structuredHtml, profile, warnings, error }
 *       structuredHtml 为自包含的 HTML 文档（供 <iframe sandbox srcdoc> 直接承载），未知 profile 或
 *       解析失败时为 null，此时界面只显示美化原文。
 *
 * patent 结构视图按官方 showxml.xsl 观感：段号 @num 红色粗体前置、权项分条编号、
 * img 按 @wi/@he（毫米）定尺寸、maths/tables/chemistry 内的图按 inline 决定行内或独立成块。
 * 图片地址一律经 assetBase（mf-asset://<sid>/）拼装，且只接受不含 .. 的相对路径与白名单扩展名；
 * 不满足者只保留替代文字，杜绝从 XML 正文里读到的路径越界取文件。
 */
const path = require('path');

const { ASSET_EXTENSIONS } = require('./asset-protocol');

const PROFILES = Object.freeze({ patent: 'patent', generic: 'generic' });
const PATENT_ROOT = 'cn-application-body';
const GENERIC_ROOT = 'document';
const GENERIC_NAMESPACE = 'urn:markflow:document:1';
const DEFAULT_INDENT = 2;
const MAX_INDENT = 8;
const PROFILE_LABELS = Object.freeze({ patent: '国知局专利五书', generic: 'MarkFlow 通用文档' });

const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9._:]/;
const WHITESPACE = /\s/;
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g;
const NAMED_ENTITIES = Object.freeze({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" });
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

// ============================================================
// 扫描器
// ============================================================

const element = (name, attrs) => ({ type: 'element', name, attrs, children: [] });
const text = (value) => ({ type: 'text', value });

function parseXml(input) {
    const src = String(input == null ? '' : input);
    const prolog = [];
    const stack = [];
    let root = null;
    let i = 0;

    const fail = (message, at) => ({ ok: false, error: `${message}（位置 ${describePosition(src, at)}）` });

    while (i < src.length) {
        if (src[i] !== '<') {
            const next = src.indexOf('<', i);
            const end = next === -1 ? src.length : next;
            const chunk = src.slice(i, end);
            if (stack.length === 0) {
                if (chunk.trim() !== '') return fail(root ? '根元素之外出现了文本' : 'XML 序言之后、根元素之前出现了文本', i);
            } else {
                stack[stack.length - 1].children.push(text(decodeEntities(chunk)));
            }
            i = end;
            continue;
        }
        if (src.startsWith('<!--', i)) {
            const end = src.indexOf('-->', i + 4);
            if (end === -1) return fail('注释没有结束标记 -->', i);
            i = end + 3;
            continue;
        }
        if (src.startsWith('<![CDATA[', i)) {
            const end = src.indexOf(']]>', i + 9);
            if (end === -1) return fail('CDATA 段没有结束标记 ]]>', i);
            if (stack.length > 0) stack[stack.length - 1].children.push(text(src.slice(i + 9, end)));
            i = end + 3;
            continue;
        }
        if (src.startsWith('<?', i)) {
            const end = src.indexOf('?>', i + 2);
            if (end === -1) return fail('处理指令没有结束标记 ?>', i);
            const raw = src.slice(i, end + 2);
            if (stack.length === 0) prolog.push({ kind: raw.startsWith('<?xml ') || raw === '<?xml?>' ? 'declaration' : 'instruction', raw });
            i = end + 2;
            continue;
        }
        if (src.startsWith('<!DOCTYPE', i)) {
            const end = findDoctypeEnd(src, i);
            if (end === -1) return fail('DOCTYPE 声明没有结束标记 >', i);
            if (stack.length === 0) prolog.push({ kind: 'doctype', raw: src.slice(i, end + 1) });
            i = end + 1;
            continue;
        }
        if (src.startsWith('</', i)) {
            const parsed = readName(src, i + 2);
            if (!parsed) return fail('结束标记缺少元素名', i);
            let cursor = parsed.next;
            while (cursor < src.length && WHITESPACE.test(src[cursor])) cursor += 1;
            if (src[cursor] !== '>') return fail(`结束标记 </${parsed.name}> 格式不正确`, i);
            const open = stack.pop();
            if (!open) return fail(`多余的结束标记 </${parsed.name}>`, i);
            if (open.name !== parsed.name) return fail(`结束标记 </${parsed.name}> 与开始标记 <${open.name}> 不匹配`, i);
            i = cursor + 1;
            continue;
        }

        const parsed = readName(src, i + 1);
        if (!parsed) return fail('开始标记缺少元素名', i);
        const attrs = readAttributes(src, parsed.next);
        if (attrs.error) return fail(attrs.error, i);
        const node = element(parsed.name, attrs.attrs);
        if (stack.length === 0) {
            if (root) return fail(`出现了第二个根元素 <${parsed.name}>，XML 只允许一个根元素`, i);
            root = node;
        } else {
            stack[stack.length - 1].children.push(node);
        }
        if (!attrs.selfClosing) stack.push(node);
        i = attrs.next;
    }

    if (stack.length > 0) return { ok: false, error: `元素 <${stack[stack.length - 1].name}> 没有对应的结束标记` };
    if (!root) return { ok: false, error: '没有找到根元素，内容可能不是 XML' };
    return { ok: true, prolog, root };
}

function readName(src, start) {
    if (start >= src.length || !NAME_START.test(src[start])) return null;
    let i = start + 1;
    while (i < src.length && NAME_CHAR.test(src[i])) i += 1;
    return { name: src.slice(start, i), next: i };
}

function readAttributes(src, start) {
    const attrs = {};
    let i = start;
    while (i < src.length) {
        while (i < src.length && WHITESPACE.test(src[i])) i += 1;
        if (src.startsWith('/>', i)) return { attrs, selfClosing: true, next: i + 2 };
        if (src[i] === '>') return { attrs, selfClosing: false, next: i + 1 };
        const name = readName(src, i);
        if (!name) return { error: '属性名不合法' };
        i = name.next;
        while (i < src.length && WHITESPACE.test(src[i])) i += 1;
        if (src[i] !== '=') return { error: `属性 ${name.name} 缺少取值` };
        i += 1;
        while (i < src.length && WHITESPACE.test(src[i])) i += 1;
        const quote = src[i];
        if (quote !== '"' && quote !== "'") return { error: `属性 ${name.name} 的取值必须用引号括起` };
        const end = src.indexOf(quote, i + 1);
        if (end === -1) return { error: `属性 ${name.name} 的引号没有闭合` };
        attrs[name.name] = decodeEntities(src.slice(i + 1, end));
        i = end + 1;
    }
    return { error: '标记没有闭合' };
}

/** DOCTYPE 可带 [ ... ] 内部子集，其中的 > 不算结束 */
function findDoctypeEnd(src, start) {
    let depth = 0;
    for (let i = start; i < src.length; i += 1) {
        if (src[i] === '[') depth += 1;
        else if (src[i] === ']') depth -= 1;
        else if (src[i] === '>' && depth <= 0) return i;
    }
    return -1;
}

function decodeEntities(value) {
    return String(value).replace(ENTITY_RE, (match, name) => {
        if (name.startsWith('#x') || name.startsWith('#X')) return codePoint(parseInt(name.slice(2), 16), match);
        if (name.startsWith('#')) return codePoint(parseInt(name.slice(1), 10), match);
        return NAMED_ENTITIES[name] !== undefined ? NAMED_ENTITIES[name] : match;
    });
}

function codePoint(value, fallback) {
    if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return fallback;
    try {
        return String.fromCodePoint(value);
    } catch (err) {
        return fallback;
    }
}

function describePosition(src, at) {
    const before = src.slice(0, Math.max(0, at));
    const line = before.split('\n').length;
    const column = before.length - (before.lastIndexOf('\n') + 1) + 1;
    return `第 ${line} 行第 ${column} 列`;
}

// ============================================================
// 美化原文
// ============================================================

function formatXml(input, { indent = DEFAULT_INDENT } = {}) {
    const raw = String(input == null ? '' : input);
    const parsed = parseXml(raw);
    if (!parsed.ok) return { ok: false, xml: raw, error: parsed.error };
    const pad = ' '.repeat(Math.min(Math.max(Number(indent) || 0, 0), MAX_INDENT));
    const lines = parsed.prolog.map((item) => item.raw);
    lines.push(...serializeElement(parsed.root, 0, pad));
    return { ok: true, xml: `${lines.join('\n')}\n`, error: null };
}

/** 含非空文本子节点的元素整体排一行，保证混合内容（段内行内标签）不被缩进破坏 */
function serializeElement(node, depth, pad) {
    const prefix = pad.repeat(depth);
    const open = `<${node.name}${serializeAttrs(node.attrs)}`;
    const children = node.children.filter((child) => child.type === 'element' || (child.type === 'text' && child.value.trim() !== ''));
    if (children.length === 0) return [`${prefix}${open}/>`];
    if (children.some((child) => child.type === 'text')) return [`${prefix}${open}>${serializeInline(node.children)}</${node.name}>`];
    const out = [`${prefix}${open}>`];
    for (const child of children) out.push(...serializeElement(child, depth + 1, pad));
    out.push(`${prefix}</${node.name}>`);
    return out;
}

function serializeInline(children) {
    return children.map((child) => {
        if (child.type === 'text') return escapeXml(child.value);
        const inner = child.children.length === 0 ? null : serializeInline(child.children);
        const open = `<${child.name}${serializeAttrs(child.attrs)}`;
        return inner === null ? `${open}/>` : `${open}>${inner}</${child.name}>`;
    }).join('');
}

const serializeAttrs = (attrs) => Object.entries(attrs || {}).map(([key, value]) => ` ${key}="${escapeAttr(value)}"`).join('');
const escapeXml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (value) => escapeXml(value).replace(/"/g, '&quot;');

// ============================================================
// 视图
// ============================================================

function detectProfile(root) {
    if (!root || root.type !== 'element') return null;
    if (root.name === PATENT_ROOT) return PROFILES.patent;
    if (root.name === GENERIC_ROOT && root.attrs && root.attrs.xmlns === GENERIC_NAMESPACE) return PROFILES.generic;
    return null;
}

/**
 * @param {string} input XML 全文
 * @param {{ assetBase?: string, indent?: number, label?: string, allowedExts?: string[] }} [options]
 * @returns {{ kind: 'xml', xml: string, structuredHtml: string|null, profile: string|null, profileLabel: string, warnings: string[], error: string|null }}
 */
function buildXmlView(input, { assetBase = null, indent = DEFAULT_INDENT, label = '', allowedExts = ASSET_EXTENSIONS } = {}) {
    const raw = String(input == null ? '' : input);
    const parsed = parseXml(raw);
    if (!parsed.ok) {
        return {
            kind: 'xml', xml: raw, structuredHtml: null, profile: null, profileLabel: '',
            warnings: [`XML 解析失败，只能显示原文：${parsed.error}`], error: parsed.error,
        };
    }
    const formatted = formatXml(raw, { indent });
    const profile = detectProfile(parsed.root);
    const ctx = { assetBase, exts: new Set((allowedExts || ASSET_EXTENSIONS).map((ext) => String(ext).toLowerCase())), missingAssets: 0 };
    const structuredHtml = profile ? wrapDocument(label || PROFILE_LABELS[profile], bodyFor(profile, parsed.root, ctx)) : null;
    const warnings = [];
    if (!profile) warnings.push('未识别的 XML 结构，只显示美化原文');
    if (ctx.missingAssets > 0) warnings.push(`有 ${ctx.missingAssets} 处图片地址不可用，已只保留替代文字`);
    return { kind: 'xml', xml: formatted.xml, structuredHtml, profile, profileLabel: profile ? PROFILE_LABELS[profile] : '', warnings, error: null };
}

const bodyFor = (profile, root, ctx) => (profile === PROFILES.patent ? patentBody(root, ctx) : genericBody(root, ctx));

// ---------- patent ----------

const PATENT_BOOK_LABELS = Object.freeze({
    'cn-claims': '权利要求书', description: '说明书', 'cn-drawings': '说明书附图',
    'cn-abstract': '说明书摘要', 'cn-abst-figure': '摘要附图',
});

function patentBody(root, ctx) {
    const books = root.children.filter((child) => child.type === 'element');
    if (books.length === 0) return '<p class="empty">该文件没有可显示的内容。</p>';
    return books.map((book) => {
        const label = PATENT_BOOK_LABELS[book.name] || book.name;
        return `<section class="book"><h1 class="book-title">${escapeHtml(label)}</h1>${patentBlocks(book, ctx)}</section>`;
    }).join('');
}

function patentBlocks(node, ctx) {
    return node.children.map((child) => {
        if (child.type === 'text') return child.value.trim() ? `<p>${escapeHtml(child.value)}</p>` : '';
        if (child.type !== 'element') return '';
        switch (child.name) {
            case 'invention-title': return `<h2 class="invention-title">${patentInline(child, ctx)}</h2>`;
            case 'heading': return `<h3 class="heading">${patentInline(child, ctx)}</h3>`;
            case 'p': return patentParagraph(child, ctx);
            case 'claim': return patentClaim(child, ctx);
            case 'claim-text': return `<p class="claim-text">${patentInline(child, ctx)}</p>`;
            case 'cn-drawing-p': return `<div class="drawing-p">${patentBlocks(child, ctx)}</div>`;
            case 'figure': return patentFigure(child, ctx);
            case 'cn-abst-figure': return `<section class="book-sub"><h3 class="heading">摘要附图</h3>${patentBlocks(child, ctx)}</section>`;
            case 'tables': case 'maths': case 'chemistry': return patentObject(child, ctx);
            default: return patentBlocks(child, ctx);
        }
    }).join('');
}

function patentParagraph(node, ctx) {
    const num = node.attrs.num ? `<span class="pnum">[${escapeHtml(node.attrs.num)}]</span>` : '';
    const italic = node.attrs.Italic === '1' ? ' is-italic' : '';
    return `<p class="para${italic}">${num}${patentInline(node, ctx)}</p>`;
}

function patentClaim(node, ctx) {
    const num = node.attrs.num ? escapeHtml(node.attrs.num) : '';
    return `<div class="claim"><span class="claim-num">${num}.</span><div class="claim-body">${patentBlocks(node, ctx)}</div></div>`;
}

function patentFigure(node, ctx) {
    const num = node.attrs.num ? `图 ${escapeHtml(node.attrs.num)}` : '附图';
    return `<figure class="figure">${patentInline(node, ctx)}<figcaption>${num}</figcaption></figure>`;
}

function patentObject(node, ctx) {
    const labels = { tables: '表', maths: '式', chemistry: '化学式' };
    const inline = node.children.some((child) => child.type === 'element' && child.name === 'img' && child.attrs.inline === 'yes');
    const caption = node.attrs.num ? `<figcaption>${labels[node.name] || ''} ${escapeHtml(node.attrs.num)}</figcaption>` : '';
    const body = patentInline(node, ctx);
    return inline ? `<span class="object-inline">${body}</span>` : `<figure class="figure object">${body}${caption}</figure>`;
}

const PATENT_INLINE_TAGS = Object.freeze({ b: 'strong', i: 'em', u: 'u', sub: 'sub', sup: 'sup', smallcaps: 'span' });

function patentInline(node, ctx) {
    return node.children.map((child) => {
        if (child.type === 'text') return escapeHtml(child.value);
        if (child.type !== 'element') return '';
        if (child.name === 'br') return '<br>';
        if (child.name === 'img') return patentImg(child, ctx);
        if (child.name === 'figref') return `<span class="figref">${patentInline(child, ctx)}</span>`;
        if (child.name === 'claim-ref') return `<span class="claim-ref">${patentInline(child, ctx)}</span>`;
        if (child.name === 'claim-text') return `<p class="claim-text">${patentInline(child, ctx)}</p>`;
        if (child.name === 'tables' || child.name === 'maths' || child.name === 'chemistry') return patentObject(child, ctx);
        const mapped = PATENT_INLINE_TAGS[child.name];
        if (mapped) return `<${mapped}>${patentInline(child, ctx)}</${mapped}>`;
        return patentInline(child, ctx);
    }).join('');
}

function patentImg(node, ctx) {
    const file = String(node.attrs.file || '');
    const src = assetSrc(file, ctx);
    const size = mmStyle(node.attrs.wi, node.attrs.he);
    const cls = node.attrs.inline === 'yes' ? 'img inline' : 'img';
    if (!src) return `<span class="img-missing" title="${escapeAttr(file)}">［图片 ${escapeHtml(file || '未命名')}］</span>`;
    return `<img class="${cls}" src="${escapeAttr(src)}" alt="${escapeAttr(file)}"${size}>`;
}

/** wi / he 为毫米，直接交 CSS 的 mm 单位，观感与官方 showxml.xsl 一致 */
function mmStyle(wi, he) {
    const width = Number(wi);
    const height = Number(he);
    const parts = [];
    if (Number.isFinite(width) && width > 0) parts.push(`width:${width}mm`);
    if (Number.isFinite(height) && height > 0) parts.push(`height:${height}mm`);
    return parts.length > 0 ? ` style="${parts.join(';')}"` : '';
}

// ---------- generic ----------

function genericBody(root, ctx) {
    const meta = root.children.find((child) => child.type === 'element' && child.name === 'meta');
    const body = root.children.find((child) => child.type === 'element' && child.name === 'body');
    const metaHtml = meta ? `<dl class="meta">${meta.children.filter((child) => child.type === 'element')
        .map((child) => `<dt>${escapeHtml(child.name)}</dt><dd>${escapeHtml(textOf(child))}</dd>`).join('')}</dl>` : '';
    const bodyHtml = body ? genericBlocks(body, ctx) : '<p class="empty">该文件没有 body 元素。</p>';
    return `<section class="book">${metaHtml}${bodyHtml}</section>`;
}

function genericBlocks(node, ctx) {
    return node.children.map((child) => {
        if (child.type !== 'element') return '';
        switch (child.name) {
            case 'heading': {
                const level = Math.min(Math.max(parseInt(child.attrs.level, 10) || 1, 1), 6);
                return `<h${level}>${genericInline(child, ctx)}</h${level}>`;
            }
            case 'p': return `<p>${genericInline(child, ctx)}</p>`;
            case 'list': {
                const tag = child.attrs.ordered === 'true' ? 'ol' : 'ul';
                const start = child.attrs.start && child.attrs.start !== '1' ? ` start="${escapeAttr(child.attrs.start)}"` : '';
                return `<${tag}${start}>${child.children.filter((item) => item.type === 'element').map((item) => `<li>${genericBlocks(item, ctx) || genericInline(item, ctx)}</li>`).join('')}</${tag}>`;
            }
            case 'table': return `<table>${child.children.filter((row) => row.type === 'element').map((row) => genericRow(row, ctx)).join('')}</table>`;
            case 'code': return `<pre class="code"><code>${escapeHtml(textOf(child))}</code></pre>`;
            case 'quote': return `<blockquote>${genericBlocks(child, ctx)}</blockquote>`;
            case 'figure': return `<figure class="figure">${genericInline(child, ctx)}</figure>`;
            case 'hr': return '<hr>';
            case 'section-break': return `<div class="section-break">${escapeHtml(child.attrs.title || child.attrs.kind || '分节')}</div>`;
            default: return `<p>${genericInline(child, ctx)}</p>`;
        }
    }).join('');
}

function genericRow(row, ctx) {
    const tag = row.attrs.header === 'true' ? 'th' : 'td';
    const cells = row.children.filter((cell) => cell.type === 'element').map((cell) => {
        const align = cell.attrs.align ? ` style="text-align:${escapeAttr(cell.attrs.align)}"` : '';
        return `<${tag}${align}>${genericInline(cell, ctx)}</${tag}>`;
    }).join('');
    return `<tr>${cells}</tr>`;
}

const GENERIC_INLINE_TAGS = Object.freeze({ b: 'strong', i: 'em', s: 's', code: 'code' });

function genericInline(node, ctx) {
    return node.children.map((child) => {
        if (child.type === 'text') return escapeHtml(child.value);
        if (child.type !== 'element') return '';
        if (child.name === 'br') return '<br>';
        if (child.name === 'image') return genericImage(child, ctx);
        if (child.name === 'math') return `<span class="math">${escapeHtml(textOf(child))}</span>`;
        if (child.name === 'a') {
            const href = externalHref(child.attrs.href);
            const inner = genericInline(child, ctx);
            return href ? `<a href="${escapeAttr(href)}" rel="noopener noreferrer" target="_blank">${inner}</a>` : inner;
        }
        const mapped = GENERIC_INLINE_TAGS[child.name];
        if (mapped) return `<${mapped}>${genericInline(child, ctx)}</${mapped}>`;
        return genericInline(child, ctx);
    }).join('');
}

function genericImage(node, ctx) {
    const alt = String(node.attrs.alt || node.attrs.src || '');
    const src = assetSrc(String(node.attrs.src || ''), ctx);
    if (!src) return `<span class="img-missing">［图片 ${escapeHtml(alt || '未命名')}］</span>`;
    return `<img class="img" src="${escapeAttr(src)}" alt="${escapeAttr(alt)}">`;
}

// ---------- 公用 ----------

/** XML 正文里的图片名只接受不含 .. 的相对路径与白名单扩展名；不满足即只留替代文字 */
function assetSrc(file, ctx) {
    const clean = String(file || '').trim().split('#')[0].split('?')[0];
    if (!clean || !ctx.assetBase) {
        if (clean) ctx.missingAssets += 1;
        return null;
    }
    if (SCHEME_RE.test(clean) || clean.startsWith('//') || path.isAbsolute(clean) || /^[A-Za-z]:/.test(clean)) {
        ctx.missingAssets += 1;
        return null;
    }
    const segments = clean.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');
    if (segments.length === 0 || segments.includes('..')) {
        ctx.missingAssets += 1;
        return null;
    }
    if (!ctx.exts.has(path.extname(segments[segments.length - 1]).toLowerCase())) {
        ctx.missingAssets += 1;
        return null;
    }
    return `${String(ctx.assetBase).replace(/\/+$/, '')}/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

function externalHref(href) {
    const value = String(href || '').trim();
    if (!/^https?:\/\//i.test(value)) return null;
    try {
        return new URL(value).href;
    } catch (err) {
        return null;
    }
}

function textOf(node) {
    if (!node) return '';
    if (node.type === 'text') return node.value;
    if (node.type !== 'element') return '';
    return node.children.map(textOf).join('');
}

const escapeHtml = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const VIEW_STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 24px 28px 48px; font: 15px/1.75 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #1c1c1e; background: #ffffff; }
@media (prefers-color-scheme: dark) { body { color: #e6e6ea; background: #1c1c1e; } }
.book + .book { margin-top: 40px; padding-top: 24px; border-top: 1px solid rgba(128,128,128,.35); }
.book-title { font-size: 13px; font-weight: 600; letter-spacing: 2px; color: #8a8a8e; margin: 0 0 16px; }
.invention-title { font-size: 20px; font-weight: 700; text-align: center; margin: 8px 0 24px; }
.heading { font-size: 16px; font-weight: 700; margin: 24px 0 8px; }
.para { margin: 0 0 10px; text-indent: 0; }
.para.is-italic { font-style: italic; }
.pnum { color: #c0362c; font-weight: 700; margin-right: 6px; }
.claim { display: flex; gap: 8px; margin: 0 0 12px; }
.claim-num { color: #c0362c; font-weight: 700; flex: none; }
.claim-body { flex: 1; min-width: 0; }
.claim-text { margin: 0 0 6px; }
.claim-ref { color: #0a66c2; }
.figref { color: #0a66c2; }
.figure { margin: 16px 0; text-align: center; }
.figure figcaption { font-size: 13px; color: #8a8a8e; margin-top: 6px; }
.object-inline { display: inline-block; vertical-align: middle; }
img.img { max-width: 100%; height: auto; }
img.img.inline { vertical-align: middle; margin: 0 2px; }
.img-missing { color: #8a8a8e; font-size: 13px; }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-size: 13px; color: #8a8a8e;
    margin: 0 0 24px; padding-bottom: 16px; border-bottom: 1px solid rgba(128,128,128,.3); }
.meta dt { font-weight: 600; }
.meta dd { margin: 0; }
table { border-collapse: collapse; margin: 12px 0; font-size: 14px; }
th, td { border: 1px solid rgba(128,128,128,.5); padding: 5px 10px; }
pre.code { background: rgba(128,128,128,.12); padding: 12px 14px; border-radius: 8px; overflow-x: auto; }
blockquote { margin: 12px 0; padding-left: 14px; border-left: 3px solid rgba(128,128,128,.4); color: #6b6b70; }
.section-break { margin: 24px 0; text-align: center; font-size: 12px; color: #8a8a8e; }
.empty { color: #8a8a8e; }
`;

function wrapDocument(title, body) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(title)}</title><style>${VIEW_STYLE}</style></head><body>${body}</body></html>`;
}

module.exports = {
    buildXmlView, parseXml, formatXml, detectProfile, wrapDocument,
    PROFILES, PROFILE_LABELS, PATENT_ROOT, GENERIC_ROOT, GENERIC_NAMESPACE,
};
