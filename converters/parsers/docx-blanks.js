/**
 * docx 填空保护：只含空白的下划线、删除线元素在交给 turndown 之前把空白换成占位符，remark 解析之后换回
 *
 * 成因：中文法律与专利文书以「下划线 + 空格」做填空，填空的宽度由空格个数决定；mammoth 把这类 run 输出为 <u>      </u>
 * （删除线为 <s>）。turndown 先在 DOM 上折叠空白（collapseWhitespace 把连续的 [ \t\r\n] 折成一个空格），再把文本只有空白
 * （/^\s*$/）的行内元素判为空白元素（isBlank），不问任何规则、整个换成空串，只在元素外侧留下一个作为 flanking 空白的普通
 * 空格；处在段首段尾时连这个空格也随 trim 消失。全角空格与 U+00A0 不被折叠，但同样使元素被判为空白元素，标签删除、空白
 * 落到元素之外，下划线随之丢失。折叠与删除都发生在规则调用之前，word profile 的规则无从补救，故只能在 turndown 之前动手。
 *
 * 做法（与 docx-layout 用 TAB 标记保住制表符同理）：
 *   - protectBlanks(html)：mammoth 输出的 HTML 中，<u>…</u> 与 <s>…</s> 的内容只有空白（至少一个字符）时，把其中每个空白
 *     字符换成一个私用区占位符（U+EF40 起，按 BLANK_CODES 的下标一一对应）。占位符不是 \s：turndown 不折叠、不判为空白
 *     元素、不转义，元素两侧也不再产生 flanking 空白；标签由 word profile 的规则原样写出，remark 解析为 html 节点，再由
 *     ir/inline-html 提升为 underline / delete 节点（<s> 由其删除线规则写出）。只处理下划线与删除线：空白在这两种格式之下
 *     有可见的横线，在加粗、斜体、上下标之下没有可见形态，照旧交由 turndown 折叠。只认紧贴标签的纯空白内容：夹着 <br>、
 *     图片或其他元素的不算；mammoth 已把相邻同格式 run 并成一个元素，文字与其旁的空白因而并在同一个元素里的也不算——那是
 *     有文字的元素，其首尾空白由 turndown 按 flanking 规则移到元素外并折叠，属另一处问题，本模块不处理。制表符此时已由
 *     docx-layout 换成 TAB 标记（不是 \s，turndown 本就不折叠），混在填空里时算作填空内容、原样保留，只换其余空白字符；
 *     只由 TAB 标记构成的内容无须保护，不算
 *   - restoreBlanks(ir)：把 mdast 各值节点（text / inlineCode / html）里的占位符换回原空白字符；不含占位符的节点返回原引用。
 *     parsers/docx 在 liftInlineHtml 之前调用，提升时看到的即 Markdown 源文本「<u>      </u>」解析所得的同一形态（只含空白
 *     的格式帧保留为格式节点）
 *
 * 空白字符集 BLANK_CODES 照录 ECMAScript 的 WhiteSpace 与 LineTerminator（即 /\s/ 匹配的全部 25 个码点），与 turndown 判定
 * 空白元素所用的 /^\s*$/ 同集：少一个都会让该字符留在元素里——元素或仍被判为空白元素，或该字符被当作 flanking 空白移到
 * 元素之外。占位符码位 U+EF40–U+EF58 属私用区，与 ir/markers 的标记段 U+EF00–U+EF1F（含计数码点 U+EF10–U+EF1F）、专利 XML
 * 的官方标记码位 U+E200–U+E20F 均不相交。源文档正文若混入这些码点，会在 restoreBlanks 时被换成对应的空白字符，与 ir/markers
 * 删除正文中 U+EF00–U+EF1F 的处置属同一类约定。
 *
 * 契约：
 *   protectBlanks(html) → string：无可保护的元素时原样返回入参
 *   restoreBlanks(ir) → 新树：不改动入参；无占位符时返回原引用
 * 耗时线性于输入长度：开标签由不带量词的正则逐个定位，其后的空白段逐字符扫描一次；不合条件时下一次查找自该开标签之后
 * 继续，合条件时自闭标签之后继续，每个字符至多被扫过常数次。不写 <u>(\s+)</u> 一类「量词 + 必需字符」形态的正则。
 * 说明：mammoth 输出的 HTML 属不可信内容，本模块只做字符串定位与替换，不执行其中任何指令。
 */

const { MARKERS } = require('../ir/markers');

// 不可见字符一律以码点声明、运行时生成，源码里不出现看不见的字面量
const fromCode = (code) => String.fromCharCode(code);

// ECMAScript WhiteSpace（TAB、VT、FF、ZWNBSP 与 Zs 类别的 17 个字符）与 LineTerminator（LF、CR、LS、PS），按码点升序；
// 即 /\s/ 匹配的全部 25 个码点，测试逐一核对
const BLANK_CODES = Object.freeze([
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);
const PLACEHOLDER_FIRST = 0xef40;
const PLACEHOLDER_LAST = PLACEHOLDER_FIRST + BLANK_CODES.length - 1;
const PLACEHOLDER_BY_BLANK = new Map(BLANK_CODES.map((code, index) => [fromCode(code), fromCode(PLACEHOLDER_FIRST + index)]));
const BLANK_BY_PLACEHOLDER = new Map(BLANK_CODES.map((code, index) => [fromCode(PLACEHOLDER_FIRST + index), fromCode(code)]));
// 单个空白字符的判定，与 turndown 的 isBlank 同用 \s
const BLANK_CHAR_RE = /\s/;
// 受保护的两种标签的开标签（mammoth 输出的 <u> 与 <s> 不带属性）：单个字符类、无量词
const OPEN_TAG_RE = /<([us])>/g;
// 占位符字符类：单个字符类、无量词
const PLACEHOLDER_CLASS = `[${fromCode(PLACEHOLDER_FIRST)}-${fromCode(PLACEHOLDER_LAST)}]`;
const PLACEHOLDER_RE = new RegExp(PLACEHOLDER_CLASS, 'g');
const HAS_PLACEHOLDER_RE = new RegExp(PLACEHOLDER_CLASS);
// 值为字符串、可能含占位符的节点类型（与 ir/markers 的 VALUE_TYPES 同集，code 节点不会由 mammoth 产出，一并收入无害）
const VALUE_TYPES = new Set(['text', 'inlineCode', 'code', 'html']);

/**
 * <u>…</u> 与 <s>…</s> 中只由空白字符与 TAB 标记构成、且至少含一个空白字符的内容，空白字符逐个换成占位符（TAB 标记原样保留）；
 * 无可保护的元素时原样返回入参
 */
function protectBlanks(html) {
    const source = String(html == null ? '' : html);
    const parts = [];
    let copied = 0;
    OPEN_TAG_RE.lastIndex = 0;
    for (let open = OPEN_TAG_RE.exec(source); open; open = OPEN_TAG_RE.exec(source)) {
        const contentAt = open.index + open[0].length;
        let end = contentAt;
        let blankSeen = false;
        while (end < source.length) {
            const char = source[end];
            if (BLANK_CHAR_RE.test(char)) blankSeen = true;
            else if (char !== MARKERS.TAB) break;
            end += 1;
        }
        const close = `</${open[1]}>`;
        if (!blankSeen || !source.startsWith(close, end)) continue;
        parts.push(source.slice(copied, contentAt), placeholdersOf(source.slice(contentAt, end)));
        copied = end;
        OPEN_TAG_RE.lastIndex = end + close.length;
    }
    if (parts.length === 0) return source;
    parts.push(source.slice(copied));
    return parts.join('');
}

// 空白字符已由 BLANK_CHAR_RE 判定、表中必有对应项，TAB 标记不在表中、原样保留；万一查不到，该字符原样保留、照旧交由 turndown 处理
function placeholdersOf(blank) {
    return Array.from(blank, (char) => PLACEHOLDER_BY_BLANK.get(char) || char).join('');
}

/** mdast 各值节点里的占位符换回原空白字符；不改动入参，无占位符的节点返回原引用 */
function restoreBlanks(node) {
    if (!node || typeof node !== 'object') return node;
    let next = node;
    if (VALUE_TYPES.has(node.type) && typeof node.value === 'string' && HAS_PLACEHOLDER_RE.test(node.value)) {
        next = { ...next, value: node.value.replace(PLACEHOLDER_RE, (char) => BLANK_BY_PLACEHOLDER.get(char)) };
    }
    if (Array.isArray(node.children)) {
        const children = node.children.map(restoreBlanks);
        if (children.some((child, i) => child !== node.children[i])) next = { ...next, children };
    }
    return next;
}

// BLANK_CODES 供测试核对与 \s 同集
module.exports = { protectBlanks, restoreBlanks, BLANK_CODES };
