/**
 * YAML front matter 的生成与剥离
 *
 * 生成（buildFrontMatter / prependFrontMatter）：
 *   - 只服务 bundle 目标；docx/pdf 等单文件目标不加头。
 *   - 字段取自 doc.meta，顺序固定为 FIELD_ORDER，缺失字段整条省略，保证 diff 稳定。
 *   - 字符串值一律双引号包裹并转义。这是刻意的取舍：判定「哪些值可以裸写」的规则
 *     （冒号、井号、前后空白、形如数字/布尔/null 的字面量……）远比统一加引号更易出错，
 *     统一加引号后任何标题都不可能破坏 YAML 结构。数值字段（wordCount）例外，裸写为数字。
 *   - 多行值折叠成单行：换行转义成 \n，双引号标量支持该转义，读回来仍是原字符串。
 *
 * 剥离（stripFrontMatter）：
 *   Markdown 输入自带的 front matter 若不摘掉，remark 会把它解析成 thematicBreak
 *   加一堆段落，转出的 DOCX/PDF 正文里就会混进 YAML 文本。这里做最小 YAML 子集解析：
 *   单层 `key: value`、`[a, b]` 流式数组、`- item` 块式数组；解析不了的行直接忽略，
 *   一律不抛错——剥离本身必须成功，键值拿不到只是少一点元数据。
 */

// front matter 字段顺序（固定）：meta 键 → YAML 键
const FIELD_ORDER = Object.freeze([
    ['title', 'title'],
    ['author', 'author'],
    ['publishedAt', 'date'],
    ['source', 'source'],
    ['finalUrl', 'finalUrl'],
    ['sourceType', 'sourceType'],
    ['siteName', 'siteName'],
    ['excerpt', 'excerpt'],
    ['lang', 'lang'],
    ['wordCount', 'wordCount'],
    ['extraction', 'extraction'],
    ['fetchedAt', 'fetchedAt'],
    ['convertedAt', 'convertedAt'],
]);
const FENCE = '---';
// 双引号标量里必须转义的字符
const ESCAPES = Object.freeze({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' });
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// ============================================================
// 生成
// ============================================================

/**
 * 依据 doc.meta 生成 YAML front matter 块（含首尾 --- 与结尾换行）。
 * 没有任何可写字段时返回空串。
 * @param {object} meta
 * @param {{ convertedAt?: string }} options
 * @returns {string}
 */
function buildFrontMatter(meta, options = {}) {
    const source = toFieldSource(meta, options);
    const lines = [];
    for (const [key, yamlKey] of FIELD_ORDER) {
        const value = source[key];
        const rendered = renderValue(value);
        if (rendered !== null) lines.push(`${yamlKey}: ${rendered}`);
    }
    if (lines.length === 0) return '';
    return `${FENCE}\n${lines.join('\n')}\n${FENCE}\n`;
}

/** 把 front matter 前置到 Markdown 文本上；无可写字段时原样返回 */
function prependFrontMatter(markdown, meta, options = {}) {
    const header = buildFrontMatter(meta, options);
    const body = String(markdown == null ? '' : markdown);
    return header ? `${header}\n${body.replace(/^\n+/, '')}` : body;
}

// meta 的字段名与 front matter 的键不完全一致，这里做一次归一：
// source 取网页 URL，文件输入则取源文件名；finalUrl 只在与 source 不同时才写。
function toFieldSource(meta, options) {
    const m = meta && typeof meta === 'object' ? meta : {};
    const source = m.sourceUrl || m.sourceName || '';
    const finalUrl = m.finalUrl && m.finalUrl !== source ? m.finalUrl : '';
    return {
        ...m,
        source,
        finalUrl,
        convertedAt: options.convertedAt || new Date().toISOString(),
    };
}

// 数字裸写、字符串加引号、其余类型（含空串）返回 null 表示整条省略
function renderValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return text ? quote(text) : null;
}

function quote(text) {
    const escaped = String(text)
        .replace(/[\\"\n\r\t]/g, (ch) => ESCAPES[ch])
        .replace(CONTROL_CHAR_RE, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
    return `"${escaped}"`;
}

// ============================================================
// 剥离与解析
// ============================================================

// 首行必须是 ---（允许 BOM 与 CRLF），闭合行同样是 --- 或 ...
// BOM 以码点构造，源码里不出现不可见字面量
const BOM = String.fromCharCode(0xfeff);
const OPEN_FENCE_RE = new RegExp(`^${BOM}?---[ \\t]*\\r?\\n`);
const CLOSE_FENCE_RE = /^(---|\.\.\.)[ \t]*$/;
const KEY_LINE_RE = /^([A-Za-z_][\w.-]*)[ \t]*:[ \t]*(.*)$/;
const LIST_ITEM_RE = /^[ \t]*-[ \t]+(.*)$/;

/**
 * 摘掉 Markdown 文本开头的 YAML front matter。
 * @param {string} text
 * @returns {{ body: string, data: object, found: boolean }}
 */
function stripFrontMatter(text) {
    const source = String(text == null ? '' : text);
    if (!OPEN_FENCE_RE.test(source)) return { body: source, data: {}, found: false };

    const lines = (source.startsWith(BOM) ? source.slice(BOM.length) : source).split('\n');
    const closeIndex = lines.findIndex((line, index) => index > 0 && CLOSE_FENCE_RE.test(line.replace(/\r$/, '')));
    // 没有闭合行说明这不是 front matter（可能只是正文开头的一条分隔线），原样返回
    if (closeIndex === -1) return { body: source, data: {}, found: false };

    const block = lines.slice(1, closeIndex).map((line) => line.replace(/\r$/, ''));
    const body = lines.slice(closeIndex + 1).join('\n').replace(/^\n+/, '');
    return { body, data: parseBlock(block), found: true };
}

// 最小 YAML 子集：单层 key: value、[a, b] 流式数组、后续 "- item" 块式数组
function parseBlock(lines) {
    const data = {};
    let listKey = '';
    for (const line of lines) {
        if (!line.trim() || line.trim().startsWith('#')) continue;

        const item = LIST_ITEM_RE.exec(line);
        if (item && listKey) {
            data[listKey].push(parseScalar(item[1]));
            continue;
        }

        const matched = KEY_LINE_RE.exec(line);
        if (!matched) continue;
        const [, key, rawValue] = matched;
        const value = rawValue.trim();
        if (!value) {
            // 空值：后续可能跟着块式数组，先占位为数组，收不到条目就在收尾时降级为空串
            data[key] = [];
            listKey = key;
            continue;
        }
        data[key] = parseScalar(value);
        listKey = '';
    }
    return finalize(data);
}

// 收尾：始终没收到条目的占位数组降级为空串，避免出现 `key: []` 这种与原文不符的值
function finalize(data) {
    return Object.fromEntries(
        Object.entries(data).map(([key, value]) => [key, Array.isArray(value) && value.length === 0 ? '' : value]),
    );
}

// 整数与布尔字面量还原为对应类型；加了引号的一律当字符串，故类型推断须在 unquote 之前做
const INTEGER_RE = /^-?(0|[1-9]\d*)$/;
const BOOLEAN_VALUES = Object.freeze({ true: true, false: false });

function parseScalar(raw) {
    const text = String(raw).trim();
    if (text.startsWith('[') && text.endsWith(']')) return splitFlowList(text.slice(1, -1));
    if (INTEGER_RE.test(text)) return Number(text);
    if (Object.prototype.hasOwnProperty.call(BOOLEAN_VALUES, text)) return BOOLEAN_VALUES[text];
    return unquote(text);
}

// 只按顶层逗号切分；带引号的元素内部的逗号不算分隔符
function splitFlowList(inner) {
    const items = [];
    let current = '';
    let quoteChar = '';
    for (let i = 0; i < inner.length; i += 1) {
        const ch = inner[i];
        if (quoteChar) {
            if (ch === '\\' && quoteChar === '"') { current += ch + (inner[i + 1] || ''); i += 1; continue; }
            if (ch === quoteChar) quoteChar = '';
            current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") { quoteChar = ch; current += ch; continue; }
        if (ch === ',') { items.push(current); current = ''; continue; }
        current += ch;
    }
    items.push(current);
    return items.map((item) => unquote(item.trim())).filter((item) => item !== '');
}

function unquote(text) {
    if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
        return unescapeDouble(text.slice(1, -1));
    }
    if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'") {
        return text.slice(1, -1).replace(/''/g, "'");
    }
    return text;
}

const UNESCAPES = Object.freeze({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '/': '/', '0': '\0' });

function unescapeDouble(text) {
    return text.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (match, seq) => {
        if (seq[0] === 'x' || seq[0] === 'u') return String.fromCharCode(parseInt(seq.slice(1), 16));
        return Object.prototype.hasOwnProperty.call(UNESCAPES, seq) ? UNESCAPES[seq] : seq;
    });
}

module.exports = { buildFrontMatter, prependFrontMatter, stripFrontMatter, FIELD_ORDER };
