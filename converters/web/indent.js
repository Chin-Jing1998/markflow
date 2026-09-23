/**
 * 网页段首缩进识别（url 解析器的 preprocessHtml 与 web/extract 的 Readability 预标注共用）
 *
 *   indentFromStyleChain(styles)  styles 为「自身 → 祖先」由近及远的 style 串；text-indent 是继承属性，
 *                                 取最近一处声明：em 四舍五入；rem 按根字号 16px 折算；px 除以最近一处
 *                                 font-size（px，缺省 16）；结果钳制到 1–4，非正值（含显式 0）返回 0
 *   createIndentResolver(access)  逐元素缓存版：access 为 { isElement, styleOf, parentOf } 三个访问器，返回
 *                                 indentOf(el)，其值与 indentFromStyleChain(自 el 起由近及远的 style 串) 逐字相同，
 *                                 而每个元素的 style 至多各匹配一次；调用方每次遍历各建一个
 *   leadingIndentRun(text)        段首连续空白里 NBSP / U+3000 / em 空格 / en 空格合计 ≥ 2 个时返回
 *                                 { count, length }：count = U+3000 与 em 空格个数 + ⌈NBSP 与 en 空格个数 / 2⌉，
 *                                 length 为应删除的前缀长度（含其间的 ASCII 空白）；否则返回 null。
 *                                 ASCII 空格在 HTML 中会被折叠、不产生缩进，故不计数
 *   LEAF_BLOCK_SELECTOR           缩进的承载者：这些块元素中不含 NESTED_BLOCK_SELECTOR 后代者为「叶子块」
 *   NESTED_BLOCK_SELECTOR
 */

const LEAF_BLOCK_SELECTOR = 'p, section, div, li, blockquote';
const NESTED_BLOCK_SELECTOR = 'p, section, div, li, blockquote, ul, ol, table, figure, pre, h1, h2, h3, h4, h5, h6';

// 旧式数值之后的三个 \s* 之间只隔两个可空项，不命中时要把同一段空白在三者之间的各种分法逐一试遍，耗时随段长立方增长；
// 现把单位与 !important 各自连同其后的空白并成可选组，每段空白只归一处，匹配位置与各捕获组均与旧式相同
const TEXT_INDENT_RE = /(?:^|;)\s*text-indent\s*:\s*(-?\d+(?:\.\d+)?)\s*(?:(em|rem|px)\s*)?(?:!important\s*)?(?=;|$)/i;
const FONT_SIZE_RE = /(?:^|;)\s*font-size\s*:\s*(\d+(?:\.\d+)?)px/i;
const DEFAULT_FONT_PX = 16;
const ROOT_FONT_PX = 16;
const MIN_INDENT = 1;
const MAX_INDENT = 4;
// 不可见字符以码点声明、运行时生成（与 web/normalize 同一约定）：U+3000 全角空格、U+2003 em 空格记一字，
// U+00A0 不换行空格、U+2002 en 空格记半字
const WIDE_SPACE_CODES = Object.freeze([0x3000, 0x2003]);
const NARROW_SPACE_CODES = Object.freeze([0x00a0, 0x2002]);
const WIDE_SPACES = new Set(WIDE_SPACE_CODES.map((code) => String.fromCharCode(code)));
const NARROW_SPACES = new Set(NARROW_SPACE_CODES.map((code) => String.fromCharCode(code)));
const INDENT_SPACE_CLASS = ` \\t\\r\\n\\f${[...NARROW_SPACES, ...WIDE_SPACES].join('')}`;
const LEADING_SPACE_RE = new RegExp(`^[${INDENT_SPACE_CLASS}]+`);
const MIN_VISIBLE_SPACES = 2;

function indentFromStyleChain(styles) {
    const list = Array.isArray(styles) ? styles : [];
    const at = list.findIndex((style) => TEXT_INDENT_RE.test(String(style || '')));
    if (at < 0) return 0;
    return indentFromDeclaration(TEXT_INDENT_RE.exec(String(list[at])), () => textFontSize(list));
}

// 字数以正文实际字号为单位：自叶子块起向上取最近一处 font-size（px）
function textFontSize(styles) {
    for (const style of styles) {
        const px = fontSizePx(style);
        if (px > 0) return px;
    }
    return DEFAULT_FONT_PX;
}

// text-indent 声明（TEXT_INDENT_RE 的 exec 结果）折算为字数：em 取原值；rem 按根字号、px 按正文字号折算，正文字号
// 由 fontSizeOf() 给出，只在这两种单位下求值；非正值与无单位返回 0，四舍五入后不足 1 返回 0，超过 4 钳制到 4
function indentFromDeclaration(declaration, fontSizeOf) {
    const [, rawValue, rawUnit] = declaration;
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value <= 0) return 0;
    const unit = String(rawUnit || '').toLowerCase();
    let chars;
    if (unit === 'em') chars = value;
    else if (unit === 'rem') chars = (value * ROOT_FONT_PX) / fontSizeOf();
    else if (unit === 'px') chars = value / fontSizeOf();
    else return 0;
    const rounded = Math.round(chars);
    if (rounded < MIN_INDENT) return 0;
    return Math.min(MAX_INDENT, rounded);
}

// 单个 style 串的字号：取首个 font-size 声明的 px 值，没有 px 声明时为 0。为 0 者（含显式 0px）由调用方跳过、
// 转取更远的祖先，即使同一串里其后另有正值
function fontSizePx(style) {
    const matched = FONT_SIZE_RE.exec(String(style || ''));
    return matched ? Number(matched[1]) : 0;
}

// 链尾之外的继承值：尚无 text-indent 声明，字号取缺省
const ROOT_INDENT_STATE = Object.freeze({ declaration: null, fontPx: DEFAULT_FONT_PX });

/**
 * 逐元素缓存的段首缩进解析器。access 为三个访问器：isElement(node) 判定链是否延续，styleOf(node) 取元素的
 * style 串，parentOf(node) 取父节点；链自叶子块起沿 parentOf 向上，遇到首个不满足 isElement 者即止（起点
 * 不满足时链为空，结果为 0）。返回 indentOf(el)，其值与 indentFromStyleChain(自 el 起由近及远的 style 串) 逐字相同。
 * 缓存随解析器存亡，调用方每次遍历各建一个；遍历期间不得改动链上元素的 style 与父子关系。
 *
 * 旧写法为何超线性：每个叶子块都重建整条祖先链，再对链上各 style 从头匹配 TEXT_INDENT_RE（rem、px 时还要匹配
 * FONT_SIZE_RE），每次匹配的耗时与该 style 的长度成正比。n 个叶子块共享一个长为 L 的祖先 style 时合计 O(n·L)，
 * 链深为 d 时建链另需 O(n·d)：1 MB 空白的祖先 style 配 1000 个叶子块实测约 1.2 至 1.6 秒。
 *
 * 新写法为何线性：为每个元素 e 缓存状态 S(e) = { declaration, fontPx }，
 *   S(e) = own(s_e, 父元素在链上 ? S(父元素) : { declaration: null, fontPx: 16 })，其中 s_e = String(styleOf(e) || '')，
 *   own(s, 继承) = { declaration: TEXT_INDENT_RE.exec(s) || 继承.declaration,
 *                    fontPx: fontSizePx(s) > 0 ? fontSizePx(s) : 继承.fontPx }。
 * 查询时自 el 向上收集尚未缓存的链上元素，遇到已缓存者或链尾即停，再自上而下逐个求值并写入缓存——迭代而非
 * 递归，深层嵌套不爆栈。每个元素只求值一次，其 style 至多各匹配一次 TEXT_INDENT_RE 与 FONT_SIZE_RE；每次查询
 * 向上走过的除至多一个已缓存元素外都是新元素，故一次遍历的总成本线性于元素数与 style 总长。
 *
 * 为何逐字等价：设 el 的链为 e0 = el, e1, …, ek，e(i+1) = parentOf(e(i))，诸 e(i) 满足 isElement，
 * parentOf(ek) 不满足。对 k 归纳可得：
 *   - S(e0).declaration 是令 exec 非空的最小下标处的 exec 结果，没有则为 null。两个正则都不带 g、y 标志，
 *     没有 lastIndex 状态，exec 非空当且仅当 test 为真，故它就是 indentFromStyleChain 中 at 处的 exec 结果；
 *     String(style || '') 与 String(list[at]) 只在假值上有别，而假值转成的空串不可能令 test 为真，at 处二者一致
 *   - S(e0).fontPx 是令 fontSizePx > 0 的最小下标处的值，没有则为 16：与 textFontSize 一样自叶子块（而非 at）
 *     起扫，一样跳过首个 font-size 为 0 的元素，二者相同
 *   - 其后的折算由同一个 indentFromDeclaration 完成。旧写法只在 rem、px 时才求字号，新写法为每个元素预先求出；
 *     二者都是纯函数，求值时机只影响成本、不影响结果
 * 缓存可以复用：S(e) 只取决于 e 的链与链上各元素的 style，而任一经过 e 的叶子块，其链自 e 起的部分恰是 e 的链。
 */
function createIndentResolver({ isElement, styleOf, parentOf }) {
    const states = new Map();
    return function indentOf(el) {
        const pending = [];
        let state = ROOT_INDENT_STATE;
        for (let node = el; isElement(node); node = parentOf(node)) {
            const cached = states.get(node);
            if (cached) {
                state = cached;
                break;
            }
            pending.push(node);
        }
        for (let index = pending.length - 1; index >= 0; index -= 1) {
            state = ownIndentState(String(styleOf(pending[index]) || ''), state);
            states.set(pending[index], state);
        }
        const { declaration, fontPx } = state;
        return declaration ? indentFromDeclaration(declaration, () => fontPx) : 0;
    };
}

// 元素自身的状态：本元素的 style 有 text-indent 声明时取之，否则继承父元素的；字号同理，首个 font-size 为 0 时继承
function ownIndentState(style, inherited) {
    const px = fontSizePx(style);
    return {
        declaration: TEXT_INDENT_RE.exec(style) || inherited.declaration,
        fontPx: px > 0 ? px : inherited.fontPx,
    };
}

function leadingIndentRun(text) {
    const matched = LEADING_SPACE_RE.exec(String(text == null ? '' : text));
    if (!matched) return null;
    let wide = 0;
    let narrow = 0;
    for (const char of matched[0]) {
        if (WIDE_SPACES.has(char)) wide += 1;
        else if (NARROW_SPACES.has(char)) narrow += 1;
    }
    if (wide + narrow < MIN_VISIBLE_SPACES) return null;
    return { count: wide + Math.ceil(narrow / 2), length: matched[0].length };
}

module.exports = {
    indentFromStyleChain, createIndentResolver, leadingIndentRun,
    LEAF_BLOCK_SELECTOR, NESTED_BLOCK_SELECTOR, INDENT_SPACE_CLASS,
};
