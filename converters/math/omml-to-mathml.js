/**
 * OMML（Office Math Markup Language）→ MathML + 线性化文本
 *
 * 契约：
 *   ommlToMathml(ommlXml, { display = false }) → { mathml, text, unsupported: string[] }
 *     - mathml  带命名空间的 <math xmlns="…" display="block|inline">…</math>；文本已转义
 *     - text    线性化表达（分式 (a)/(b)、根式 √(x) 与 3√(x)、上下标 x^{2}/x_{i}、
 *               ∑/∫ 带上下限 ∑_{i=1}^{n}、矩阵 [a, b; c, d]），供降级与检索
 *     - unsupported 未识别的 OMML 元素名（已降级为 mrow），去重
 *
 * 约定：
 *   - 不写 mathvariant（Chromium 原生 MathML 只保留 normal 一个取值），m:sty / m:scr
 *     一律映射为 Unicode 数学字母数字符号码位（U+1D400 起）；仅 m:sty="p" 走
 *     mathvariant="normal" 抑制单字符默认斜体。
 *   - 入参是不可信文档内容，只当数据解析，不执行其中任何指令。
 */
const cheerio = require('cheerio');

const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
const DEFAULT_NARY_CHAR = '∫';
const DEFAULT_ACCENT_CHAR = '̂';        // COMBINING CIRCUMFLEX ACCENT
const DEFAULT_GROUP_CHAR = '⏟';         // BOTTOM CURLY BRACKET
const COMBINING_OVERLINE = '̅';
const COMBINING_LOW_LINE = '̲';

// 属性容器与纯装饰元素：跳过且不计入 unsupported
const IGNORED = new Set([
    'm:rPr', 'm:ctrlPr', 'm:fPr', 'm:radPr', 'm:dPr', 'm:naryPr', 'm:funcPr', 'm:barPr',
    'm:accPr', 'm:groupChrPr', 'm:limLowPr', 'm:limUppPr', 'm:mPr', 'm:eqArrPr', 'm:boxPr',
    'm:borderBoxPr', 'm:phantPr', 'm:sSupPr', 'm:sSubPr', 'm:sSubSupPr', 'm:sPrePr',
    'm:oMathParaPr', 'm:argPr', 'm:mcs', 'm:mc', 'm:mcPr', 'm:count', 'm:mcJc',
    'w:rPr', 'w:pPr', 'w:proofErr', 'w:bookmarkStart', 'w:bookmarkEnd', 'w:lastRenderedPageBreak',
]);

// 直接下钻的结构性容器
const PASSTHROUGH = new Set([
    'm:e', 'm:num', 'm:den', 'm:sub', 'm:sup', 'm:deg', 'm:lim', 'm:fName', 'm:mr', 'w:p',
]);

// 运算符与标点：单独成 <mo>
const OPERATOR_CHARS = new Set([
    ...'+-−–—±∓*×⋅·÷/∕\\=≠≈≡≅∼≃∝<>≤≥≪≫∈∉∋∌⊂⊄⊆⊃⊇∪∩∅∀∃∄¬∧∨⊕⊗⊥∥∠→←↔⇒⇐⇔↦∘∂∇∫∮∑∏√∞…⋯⋮⋱',
    ...',;:!?%°′″()[]{}|‖⟨⟩，、；：（）［］｛｝〈〉',
    "'", '"', '&', '@', '#', '~', '^', '_',
]);

// ---------- Unicode 数学字母数字符号 ----------

// key：`${m:scr}|${m:sty}`；缺省 scr 视作 roman，缺省 sty 视作 i
const ALPHABET_BASES = {
    'roman|b': { upper: 0x1D400, lower: 0x1D41A, digit: 0x1D7CE },
    'roman|i': { upper: 0x1D434, lower: 0x1D44E },
    'roman|bi': { upper: 0x1D468, lower: 0x1D482 },
    'script|p': { upper: 0x1D49C, lower: 0x1D4B6 },
    'script|i': { upper: 0x1D49C, lower: 0x1D4B6 },
    'script|b': { upper: 0x1D4D0, lower: 0x1D4EA },
    'script|bi': { upper: 0x1D4D0, lower: 0x1D4EA },
    'fraktur|p': { upper: 0x1D504, lower: 0x1D51E },
    'fraktur|i': { upper: 0x1D504, lower: 0x1D51E },
    'fraktur|b': { upper: 0x1D56C, lower: 0x1D586 },
    'fraktur|bi': { upper: 0x1D56C, lower: 0x1D586 },
    'double-struck|p': { upper: 0x1D538, lower: 0x1D552, digit: 0x1D7D8 },
    'double-struck|i': { upper: 0x1D538, lower: 0x1D552, digit: 0x1D7D8 },
    'double-struck|b': { upper: 0x1D538, lower: 0x1D552, digit: 0x1D7D8 },
    'double-struck|bi': { upper: 0x1D538, lower: 0x1D552, digit: 0x1D7D8 },
    'sans-serif|p': { upper: 0x1D5A0, lower: 0x1D5BA, digit: 0x1D7E2 },
    'sans-serif|b': { upper: 0x1D5D4, lower: 0x1D5EE, digit: 0x1D7EC },
    'sans-serif|i': { upper: 0x1D608, lower: 0x1D622, digit: 0x1D7E2 },
    'sans-serif|bi': { upper: 0x1D63C, lower: 0x1D656, digit: 0x1D7EC },
    'monospace|p': { upper: 0x1D670, lower: 0x1D68A, digit: 0x1D7F6 },
    'monospace|i': { upper: 0x1D670, lower: 0x1D68A, digit: 0x1D7F6 },
    'monospace|b': { upper: 0x1D670, lower: 0x1D68A, digit: 0x1D7F6 },
    'monospace|bi': { upper: 0x1D670, lower: 0x1D68A, digit: 0x1D7F6 },
};

// SMP 中被保留的空洞码位 → BMP 字母式符号（Letterlike Symbols）
const ALPHABET_HOLES = new Map([
    [0x1D455, 0x210E],                                                     // 斜体 h
    [0x1D49D, 0x212C], [0x1D4A0, 0x2130], [0x1D4A1, 0x2131], [0x1D4A3, 0x210B],
    [0x1D4A4, 0x2110], [0x1D4A7, 0x2112], [0x1D4A8, 0x2133], [0x1D4AD, 0x211B],
    [0x1D4BA, 0x212F], [0x1D4BC, 0x210A], [0x1D4C4, 0x2134],
    [0x1D506, 0x212D], [0x1D50B, 0x210C], [0x1D50C, 0x2111], [0x1D515, 0x211C], [0x1D51D, 0x2128],
    [0x1D53A, 0x2102], [0x1D53F, 0x210D], [0x1D545, 0x2115], [0x1D547, 0x2119],
    [0x1D548, 0x211A], [0x1D549, 0x211D], [0x1D551, 0x2124],
]);

const MATH_DIGIT_RANGES = [[0x1D7CE, 0x1D7FF]];

// ---------- 公开入口 ----------

function ommlToMathml(ommlXml, { display = false } = {}) {
    const source = String(ommlXml == null ? '' : ommlXml);
    const unsupported = [];
    if (!source.trim()) return { mathml: '', text: '', unsupported };

    const $ = cheerio.load(source, { xmlMode: true });
    const state = { $, unsupported };
    const roots = pickRoots($);
    const isBlock = Boolean(display) || $('m\\:oMathPara').length > 0;

    const converted = convertSeq(roots, state);
    const body = converted.items.length === 1 ? converted.items[0] : `<mrow>${converted.items.join('')}</mrow>`;
    const mathml = `<math xmlns="${MATHML_NS}" display="${isBlock ? 'block' : 'inline'}">${body}</math>`;
    return { mathml, text: normalizeSpace(converted.tx), unsupported };
}

// 取转换起点：oMathPara 内的全部 oMath 合并为一个公式；否则取全部顶层 oMath；再否则整个片段
function pickRoots($) {
    const paras = $('m\\:oMathPara');
    if (paras.length) return paras.find('m\\:oMath').toArray();
    const maths = $('m\\:oMath');
    if (maths.length) return maths.toArray();
    return $.root().children().toArray();
}

// ---------- 转换核心 ----------

function convertSeq(nodes, state) {
    const items = [];
    let tx = '';
    for (const node of nodes) {
        if (!node || node.type === 'comment') continue;
        if (node.type === 'text') {
            const raw = String(node.data || '');
            if (!raw.trim()) continue;
            const part = textToItems(raw, null);
            items.push(...part.items);
            tx += part.tx;
            continue;
        }
        if (!node.name) continue;
        const part = convertNode(node, state);
        items.push(...part.items);
        tx += part.tx;
    }
    return { items, tx };
}

function convertNode(node, state) {
    const name = node.name;
    if (IGNORED.has(name)) return EMPTY();
    if (PASSTHROUGH.has(name)) return convertSeq(kids(node), state);
    const handler = HANDLERS[name];
    if (handler) return handler(node, state);
    if (!state.unsupported.includes(name)) state.unsupported.push(name);
    const inner = convertSeq(kids(node), state);
    return one(`<mrow>${inner.items.join('')}</mrow>`, inner.tx);
}

const HANDLERS = {
    'm:oMath': (node, state) => convertSeq(kids(node), state),
    'm:oMathPara': (node, state) => convertSeq(kids(node), state),
    'm:r': convertRun,
    'w:r': convertRun,
    'm:t': (node, state) => textToItems(state.$(node).text(), null),
    'w:t': (node, state) => textToItems(state.$(node).text(), null),
    'm:f': convertFraction,
    'm:sSup': (node, state) => convertScript(node, state, 'sup'),
    'm:sSub': (node, state) => convertScript(node, state, 'sub'),
    'm:sSubSup': (node, state) => convertScript(node, state, 'subsup'),
    'm:sPre': convertPreScript,
    'm:rad': convertRadical,
    'm:d': convertDelimiter,
    'm:nary': convertNary,
    'm:func': convertFunc,
    'm:bar': convertBar,
    'm:acc': convertAccent,
    'm:groupChr': convertGroupChar,
    'm:limLow': (node, state) => convertLimit(node, state, false),
    'm:limUpp': (node, state) => convertLimit(node, state, true),
    'm:m': convertMatrix,
    'm:eqArr': convertEqArray,
    'm:box': (node, state) => {
        const inner = convertSeq(kids(node), state);
        return one(`<mrow>${inner.items.join('')}</mrow>`, inner.tx);
    },
    'm:borderBox': (node, state) => {
        const e = argOf(node, 'm:e', state);
        return one(`<menclose notation="box">${e.ml}</menclose>`, e.tx);
    },
    'm:phant': (node, state) => {
        const e = argOf(node, 'm:e', state);
        return one(`<mphantom>${e.ml}</mphantom>`, '');
    },
};

// ---------- 各结构 ----------

function convertRun(node, state) {
    const style = styleOf(node, state);
    const raw = state.$(node).find('m\\:t, w\\:t').toArray().map((n) => state.$(n).text()).join('');
    return textToItems(mapStyledText(raw, style), style);
}

function convertFraction(node, state) {
    const type = propVal(node, 'm:fPr', 'm:type', state);
    const num = argOf(node, 'm:num', state);
    const den = argOf(node, 'm:den', state);
    if (type === 'lin') return one(`<mrow>${num.ml}<mo>/</mo>${den.ml}</mrow>`, `${num.tx}/${den.tx}`);
    let attrs = '';
    if (type === 'noBar') attrs = ' linethickness="0"';
    else if (type === 'skw') attrs = ' bevelled="true"';
    return one(`<mfrac${attrs}>${num.ml}${den.ml}</mfrac>`, `(${num.tx})/(${den.tx})`);
}

function convertScript(node, state, kind) {
    const base = argOf(node, 'm:e', state);
    const sub = argOf(node, 'm:sub', state);
    const sup = argOf(node, 'm:sup', state);
    if (kind === 'sub') return one(`<msub>${base.ml}${sub.ml}</msub>`, `${base.tx}_{${sub.tx}}`);
    if (kind === 'sup') return one(`<msup>${base.ml}${sup.ml}</msup>`, `${base.tx}^{${sup.tx}}`);
    return one(`<msubsup>${base.ml}${sub.ml}${sup.ml}</msubsup>`, `${base.tx}_{${sub.tx}}^{${sup.tx}}`);
}

function convertPreScript(node, state) {
    const base = argOf(node, 'm:e', state);
    const sub = argOf(node, 'm:sub', state);
    const sup = argOf(node, 'm:sup', state);
    const ml = `<mmultiscripts>${base.ml}<mprescripts></mprescripts>${sub.ml}${sup.ml}</mmultiscripts>`;
    return one(ml, `_{${sub.tx}}^{${sup.tx}}${base.tx}`);
}

function convertRadical(node, state) {
    const hideDegree = isTrue(propVal(node, 'm:radPr', 'm:degHide', state));
    const body = argOf(node, 'm:e', state);
    const degree = argOf(node, 'm:deg', state);
    if (hideDegree || !degree.tx) return one(`<msqrt>${body.ml}</msqrt>`, `√(${body.tx})`);
    return one(`<mroot>${body.ml}${degree.ml}</mroot>`, `${degree.tx}√(${body.tx})`);
}

function convertDelimiter(node, state) {
    const begRaw = propVal(node, 'm:dPr', 'm:begChr', state);
    const endRaw = propVal(node, 'm:dPr', 'm:endChr', state);
    const sepRaw = propVal(node, 'm:dPr', 'm:sepChr', state);
    const beg = begRaw === undefined ? '(' : begRaw;
    const end = endRaw === undefined ? ')' : endRaw;
    const sep = sepRaw === undefined ? ',' : sepRaw;
    const parts = state.$(node).children('m\\:e').toArray().map((e) => wrapArg(convertSeq(kids(e), state)));

    const pieces = [];
    if (beg) pieces.push(`<mo fence="true" stretchy="true">${escapeXml(beg)}</mo>`);
    parts.forEach((part, index) => {
        if (index > 0 && sep) pieces.push(`<mo separator="true" stretchy="false">${escapeXml(sep)}</mo>`);
        pieces.push(part.ml);
    });
    if (end) pieces.push(`<mo fence="true" stretchy="true">${escapeXml(end)}</mo>`);
    return one(`<mrow>${pieces.join('')}</mrow>`, `${beg}${parts.map((p) => p.tx).join(sep)}${end}`);
}

function convertNary(node, state) {
    const chrRaw = propVal(node, 'm:naryPr', 'm:chr', state);
    const chr = chrRaw === undefined || chrRaw === '' ? DEFAULT_NARY_CHAR : chrRaw;
    const underOver = propVal(node, 'm:naryPr', 'm:limLoc', state) === 'undOvr';
    const sub = argOf(node, 'm:sub', state);
    const sup = argOf(node, 'm:sup', state);
    const body = argOf(node, 'm:e', state);
    const hasSub = !isTrue(propVal(node, 'm:naryPr', 'm:subHide', state)) && Boolean(sub.tx);
    const hasSup = !isTrue(propVal(node, 'm:naryPr', 'm:supHide', state)) && Boolean(sup.tx);

    const op = `<mo largeop="true" stretchy="false">${escapeXml(chr)}</mo>`;
    let decorated = op;
    if (hasSub && hasSup) decorated = underOver ? `<munderover>${op}${sub.ml}${sup.ml}</munderover>` : `<msubsup>${op}${sub.ml}${sup.ml}</msubsup>`;
    else if (hasSub) decorated = underOver ? `<munder>${op}${sub.ml}</munder>` : `<msub>${op}${sub.ml}</msub>`;
    else if (hasSup) decorated = underOver ? `<mover>${op}${sup.ml}</mover>` : `<msup>${op}${sup.ml}</msup>`;

    const tx = `${chr}${hasSub ? `_{${sub.tx}}` : ''}${hasSup ? `^{${sup.tx}}` : ''}${body.tx}`;
    return one(`<mrow>${decorated}${body.ml}</mrow>`, tx);
}

function convertFunc(node, state) {
    const name = argOf(node, 'm:fName', state);
    const body = argOf(node, 'm:e', state);
    const ml = `<mrow>${name.ml}<mo>&#x2061;</mo>${body.ml}</mrow>`;
    const tx = body.tx.startsWith('(') ? `${name.tx}${body.tx}` : `${name.tx}(${body.tx})`;
    return one(ml, tx);
}

function convertBar(node, state) {
    const body = argOf(node, 'm:e', state);
    const onTop = propVal(node, 'm:barPr', 'm:pos', state) === 'top';
    if (onTop) return one(`<mover accent="true">${body.ml}<mo stretchy="true">&#x203E;</mo></mover>`, `${body.tx}${COMBINING_OVERLINE}`);
    return one(`<munder accentunder="true">${body.ml}<mo stretchy="true">&#x5F;</mo></munder>`, `${body.tx}${COMBINING_LOW_LINE}`);
}

function convertAccent(node, state) {
    const chrRaw = propVal(node, 'm:accPr', 'm:chr', state);
    const chr = chrRaw === undefined || chrRaw === '' ? DEFAULT_ACCENT_CHAR : chrRaw;
    const body = argOf(node, 'm:e', state);
    return one(`<mover accent="true">${body.ml}<mo stretchy="false">${escapeXml(chr)}</mo></mover>`, `${body.tx}${chr}`);
}

function convertGroupChar(node, state) {
    const chrRaw = propVal(node, 'm:groupChrPr', 'm:chr', state);
    const chr = chrRaw === undefined || chrRaw === '' ? DEFAULT_GROUP_CHAR : chrRaw;
    const onTop = propVal(node, 'm:groupChrPr', 'm:pos', state) === 'top';
    const body = argOf(node, 'm:e', state);
    const glyph = `<mo stretchy="true">${escapeXml(chr)}</mo>`;
    if (onTop) return one(`<mover>${body.ml}${glyph}</mover>`, `${chr}${body.tx}`);
    return one(`<munder>${body.ml}${glyph}</munder>`, `${body.tx}${chr}`);
}

function convertLimit(node, state, upper) {
    const body = argOf(node, 'm:e', state);
    const limit = argOf(node, 'm:lim', state);
    if (upper) return one(`<mover>${body.ml}${limit.ml}</mover>`, `${body.tx}^{${limit.tx}}`);
    return one(`<munder>${body.ml}${limit.ml}</munder>`, `${body.tx}_{${limit.tx}}`);
}

function convertMatrix(node, state) {
    const rows = state.$(node).children('m\\:mr').toArray().map((row) => (
        state.$(row).children('m\\:e').toArray().map((cellNode) => wrapArg(convertSeq(kids(cellNode), state)))
    ));
    const ml = `<mtable>${rows.map((cells) => `<mtr>${cells.map((c) => `<mtd>${c.ml}</mtd>`).join('')}</mtr>`).join('')}</mtable>`;
    const tx = `[${rows.map((cells) => cells.map((c) => c.tx).join(', ')).join('; ')}]`;
    return one(ml, tx);
}

function convertEqArray(node, state) {
    const rows = state.$(node).children('m\\:e').toArray().map((row) => wrapArg(convertSeq(kids(row), state)));
    const ml = `<mtable>${rows.map((row) => `<mtr><mtd>${row.ml}</mtd></mtr>`).join('')}</mtable>`;
    return one(ml, rows.map((row) => row.tx).join('; '));
}

// ---------- 文本切分与样式映射 ----------

function textToItems(text, style) {
    const source = String(text == null ? '' : text);
    if (!source) return EMPTY();
    const upright = Boolean(style && style.sty === 'p' && isRomanScript(style.scr));
    const items = [];
    let index = 0;
    while (index < source.length) {
        const codePoint = source.codePointAt(index);
        const char = String.fromCodePoint(codePoint);
        if (/\s/.test(char)) { index += char.length; continue; }
        if (isDigitCode(codePoint)) {
            const digits = takeWhile(source, index, (cp) => isDigitCode(cp) || cp === 0x2E);
            items.push(`<mn>${escapeXml(digits)}</mn>`);
            index += digits.length;
            continue;
        }
        if (OPERATOR_CHARS.has(char)) {
            items.push(`<mo>${escapeXml(char)}</mo>`);
            index += char.length;
            continue;
        }
        const word = takeWhile(source, index, (cp) => {
            const c = String.fromCodePoint(cp);
            return !/\s/.test(c) && !isDigitCode(cp) && !OPERATOR_CHARS.has(c);
        });
        const attr = upright && [...word].length === 1 ? ' mathvariant="normal"' : '';
        items.push(`<mi${attr}>${escapeXml(word)}</mi>`);
        index += word.length;
    }
    return { items, tx: source.replace(/\s+/g, ' ') };
}

function takeWhile(source, start, predicate) {
    let index = start;
    let out = '';
    while (index < source.length) {
        const codePoint = source.codePointAt(index);
        if (!predicate(codePoint)) break;
        const char = String.fromCodePoint(codePoint);
        out += char;
        index += char.length;
    }
    return out;
}

function styleOf(node, state) {
    const rPr = state.$(node).children('m\\:rPr, w\\:rPr').first();
    if (!rPr.length) return null;
    const sty = attrOf(rPr.children('m\\:sty').first());
    const scr = attrOf(rPr.children('m\\:scr').first());
    if (sty === undefined && scr === undefined) return null;
    return { sty: sty || 'i', scr: scr || 'roman' };
}

// m:sty / m:scr → Unicode 数学字母数字符号；默认斜体（roman|i）交给 MathML 自身渲染，不改码位
function mapStyledText(text, style) {
    if (!style) return text;
    const { sty, scr } = style;
    if (isRomanScript(scr) && (sty === 'i' || sty === 'p')) return text;
    const base = ALPHABET_BASES[`${scr}|${sty}`] || ALPHABET_BASES[`${scr}|p`];
    if (!base) return text;
    let out = '';
    for (const char of text) {
        const codePoint = char.codePointAt(0);
        let mapped = codePoint;
        if (codePoint >= 0x41 && codePoint <= 0x5A) mapped = base.upper + (codePoint - 0x41);
        else if (codePoint >= 0x61 && codePoint <= 0x7A) mapped = base.lower + (codePoint - 0x61);
        else if (codePoint >= 0x30 && codePoint <= 0x39 && base.digit) mapped = base.digit + (codePoint - 0x30);
        out += String.fromCodePoint(ALPHABET_HOLES.get(mapped) || mapped);
    }
    return out;
}

const isRomanScript = (scr) => !scr || scr === 'roman';

function isDigitCode(codePoint) {
    if (codePoint >= 0x30 && codePoint <= 0x39) return true;
    return MATH_DIGIT_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

// ---------- 小工具 ----------

const EMPTY = () => ({ items: [], tx: '' });
const one = (ml, tx) => ({ items: [ml], tx });
const kids = (node) => (node.children || []).filter((child) => child && (child.name || child.type === 'text'));
const isTrue = (value) => value === '1' || value === 'true' || value === 'on';
const normalizeSpace = (value) => String(value || '').replace(/\s+/g, ' ').trim();

function attrOf(selection) {
    if (!selection || !selection.length) return undefined;
    const value = selection.attr('m:val');
    return value === undefined ? '' : String(value);
}

// 读 <父/属性容器/属性元素 m:val>；属性容器或属性元素缺失时返回 undefined
function propVal(node, containerName, propName, state) {
    const container = state.$(node).children(escapeSelector(containerName)).first();
    if (!container.length) return undefined;
    return attrOf(container.children(escapeSelector(propName)).first());
}

// 取具名子元素的转换结果；缺失时给空 mrow
function argOf(node, name, state) {
    const child = state.$(node).children(escapeSelector(name)).first();
    if (!child.length) return { ml: '<mrow></mrow>', tx: '' };
    return wrapArg(convertSeq(kids(child[0]), state));
}

function wrapArg(part) {
    if (part.items.length === 0) return { ml: '<mrow></mrow>', tx: part.tx };
    if (part.items.length === 1) return { ml: part.items[0], tx: part.tx };
    return { ml: `<mrow>${part.items.join('')}</mrow>`, tx: part.tx };
}

const escapeSelector = (name) => name.replace(/:/g, '\\:');

function escapeXml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

module.exports = { ommlToMathml };
