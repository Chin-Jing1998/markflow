/**
 * XML 树构造与序列化（xml 渲染器 generic / patent 两个 profile 共用）
 *
 * 节点模型：{ name, attrs: { 名: 值 }, children: [ 节点 | 字符串 ] }，一律由 el() 构造，
 * 字符串子节点即文本。序列化规则：
 *   - 含文本子节点的元素（p、claim-text、heading 一类混合内容）整体单行输出，
 *     不在文本前后插入任何缩进或换行——插入的空白会进入段落正文，而受理端存储的是
 *     XML 文本本身，不像浏览器那样折叠空白；
 *   - 只含元素子节点的容器按 indent 缩进换行；indent 为 0 时整份文档单行输出，
 *     与官方 WordToolKit 的骨架常量形态一致；
 *   - 文本与属性值一律经 cleanText 剔除 XML 1.0 不允许的控制字符与孤立代理项，再做实体转义。
 * 不用 xmlbuilder2：其 prettyPrint 会把混合内容元素的每个子节点各放一行，无法在段内保持文本原样，
 * 而 prettyPrint 关闭后文件头三行也无法独立成行；本模块 60 行即可完整覆盖上述两条规则。
 */

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
// XML 1.0 Char 产生式之外的码点：C0 控制字符（保留 TAB/LF/CR）与 U+FFFE/U+FFFF
const ILLEGAL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;
// 孤立的高位或低位代理项（成对的代理项构成合法的辅助平面字符）
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const DEFAULT_INDENT = 2;

/** 剔除 XML 1.0 非法字符；非字符串值先 String 化，null/undefined 视为空串 */
function cleanText(value) {
    return String(value == null ? '' : value).replace(ILLEGAL_CHARS_RE, '').replace(LONE_SURROGATE_RE, '');
}

/** 构造元素节点：属性值与文本子节点在此即完成清洗；非法元素名或属性名抛中文错误 */
function el(name, attrs = {}, children = []) {
    assertName(name, '元素');
    const cleanAttrs = {};
    for (const [key, value] of Object.entries(attrs || {})) {
        if (value === undefined || value === null) continue;
        assertName(key, '属性');
        cleanAttrs[key] = cleanText(value);
    }
    const list = Array.isArray(children) ? children : [children];
    return { name, attrs: cleanAttrs, children: list.filter((child) => child !== null && child !== undefined).map(normalizeChild) };
}

function normalizeChild(child) {
    if (typeof child === 'string') return cleanText(child);
    if (child && typeof child === 'object' && typeof child.name === 'string') return child;
    return cleanText(child);
}

function assertName(name, label) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`XML ${label}名非法：${String(name)}`);
}

/** 返回追加了子节点的新节点（不改动入参） */
function append(node, ...children) {
    return el(node.name, node.attrs, [...node.children, ...children]);
}

/** 递归拼接节点的文本内容 */
function textOf(node) {
    if (typeof node === 'string') return node;
    if (!node || !Array.isArray(node.children)) return '';
    return node.children.map(textOf).join('');
}

// ============================================================
// 序列化
// ============================================================

const escapeText = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (value) => escapeText(value).replace(/"/g, '&quot;').replace(/\r?\n/g, ' ').replace(/\t/g, ' ');

/**
 * 序列化元素子树。indent > 0 时容器元素缩进换行、混合内容元素单行；indent 为 0 时整体单行。
 * 返回值不带结尾换行。
 */
function serialize(node, { indent = DEFAULT_INDENT } = {}) {
    const width = Number.isInteger(indent) && indent > 0 ? indent : 0;
    const out = [];
    writeNode(node, 0, width, out);
    return out.join('');
}

function writeNode(node, depth, width, out) {
    const pad = width > 0 ? ' '.repeat(width * depth) : '';
    const attrs = Object.entries(node.attrs).map(([key, value]) => ` ${key}="${escapeAttr(value)}"`).join('');
    const children = node.children.filter((child) => !(typeof child === 'string' && child === ''));
    if (children.length === 0) {
        out.push(`${pad}<${node.name}${attrs}/>`);
        return;
    }
    if (width === 0 || children.some((child) => typeof child === 'string')) {
        out.push(`${pad}<${node.name}${attrs}>`);
        writeInline(children, out);
        out.push(`</${node.name}>`);
        return;
    }
    out.push(`${pad}<${node.name}${attrs}>\n`);
    for (const child of children) {
        writeNode(child, depth + 1, width, out);
        out.push('\n');
    }
    out.push(`${pad}</${node.name}>`);
}

// 混合内容：文本与元素连续输出，不插入任何空白
function writeInline(children, out) {
    for (const child of children) {
        if (typeof child === 'string') {
            out.push(escapeText(child));
            continue;
        }
        const attrs = Object.entries(child.attrs).map(([key, value]) => ` ${key}="${escapeAttr(value)}"`).join('');
        const inner = child.children.filter((item) => !(typeof item === 'string' && item === ''));
        if (inner.length === 0) {
            out.push(`<${child.name}${attrs}/>`);
            continue;
        }
        out.push(`<${child.name}${attrs}>`);
        writeInline(inner, out);
        out.push(`</${child.name}>`);
    }
}

/**
 * 完整文档：XML 声明 + 可选 DOCTYPE（SYSTEM 标识）+ 可选处理指令 + 根元素，各占一行，末尾换行。
 * doctype.internalSubset 为字符串时在系统标识符之后写出内部子集方括号（空串即 `[]`，官方
 * WORD 转 XML 编辑器的产出即此形态）；该字段缺省或非字符串时不写方括号。
 * @param {{ root: object, doctype?: { name: string, systemId: string, internalSubset?: string } | null,
 *           instructions?: Array<{ target: string, data: string }>, indent?: number }} params
 */
function serializeDocument({ root, doctype = null, instructions = [], indent = DEFAULT_INDENT } = {}) {
    if (!root || typeof root.name !== 'string') throw new Error('serializeDocument 需要根元素');
    const lines = [XML_DECLARATION];
    if (doctype) {
        assertName(doctype.name, '文档类型');
        const subset = typeof doctype.internalSubset === 'string' ? `[${cleanText(doctype.internalSubset)}]` : '';
        lines.push(`<!DOCTYPE ${doctype.name} SYSTEM "${escapeAttr(cleanText(doctype.systemId))}"${subset}>`);
    }
    for (const pi of instructions) {
        assertName(pi.target, '处理指令');
        lines.push(`<?${pi.target} ${cleanText(pi.data).replace(/\?>/g, '? >')}?>`);
    }
    lines.push(serialize(root, { indent }));
    return `${lines.join('\n')}\n`;
}

module.exports = { el, append, textOf, cleanText, serialize, serializeDocument, XML_DECLARATION };
