/**
 * Turndown 工厂（全库唯一一份）
 *
 * profile 取值与行为来源：
 *   'basic' — 通用 HTML：基础选项 + 移除 script/style/noscript（源自 ir/util.js:78）
 *   'word'  — mammoth 输出：基础选项 + 表格转 GFM + 移除空 img + 保留 <u>/<sup>/<sub>
 *             （<u> 由 mammoth 经 styleMap 'u => u' 产出，<sup>/<sub> 由 w:vertAlign 默认产出；
 *             三者均由 ir/inline-html 提升为 underline / superscript / subscript 节点）
 *   'url'   — 网页正文：基础选项 + 内联样式识别 + figure/figcaption + section 块级 + 保留 <sup>/<sub>
 *             + 移除 script/style/noscript/iframe/nav/footer/aside（源自 旧版 url.js:239）
 *             + 表格转 GFM（turndown 核心不含表格支持，缺失时网页表格退化为逐行纯文本，IR 得不到 table 节点）
 *
 * 各 profile 共同的输出约定：
 *   - 文本中的「~」一律转义为 \~：HTML 文本里的「~」恒为字面量，多为区间号（化学专利的「C1~C30的烷基」、
 *     网页的「疗程3~5天」），而 remark-gfm 默认 singleTilde，成对的单个「~」会被解析成 delete 节点、
 *     波浪号连同区间含义一起丢失。转义只发生在 HTML → Markdown 这一侧，Markdown 输入的 ~删除线~ 语义不受影响。
 *     不经 turndown 文本节点处理的两条通道另行接入同一个 service.escape，转义的是全部 Markdown 记号而不止
 *     「~」：表格单元格由 cellText 直接取 cell.textContent，折叠空白后先 escape、再转义竖线；图片 alt 由内置
 *     image 规则处理，该规则调用的是 turndown 模块私有的 escapeMarkdown（星号、方括号与反斜杠已转义），工厂层
 *     补在实例 escape 上的「~」转义对它不生效，故由 addImageAltRule 接管内置规则、只替换其中的 alt 一段，
 *     并把 alt 内的换行折叠为空格
 *
 * url profile 的输出约定（与 ir/markers、ir/inline-html 配套）：
 *   - 粗体、斜体、删除线一律输出 <strong>/<em>/<del> HTML 而非 ** / * / ~~：CommonMark 的 flanking 规则在中文
 *     标点旁失效（如「依据**《词典》**的」），字面星号会被 md 渲染器转义成 \*\*；HTML 标签由 ir/inline-html
 *     在 remark 解析后还原为 strong/emphasis/delete 节点，与标点无关
 *   - <sup>/<sub> 原样输出：Markdown 没有对应语法，网页的化学式（「C<sub>1</sub>的烷基」）与脚注标号
 *     （「<sup>[1]</sup>」）不加标签就会塌成同级文本，由 ir/inline-html 提升为 superscript / subscript 节点
 *   - <section> 按块级输出（\n\n…\n\n）：微信正文全由 section 构成，透传会使整篇塌成一段
 *   - <br> 输出 BR 标记，由 parsers/url 的 collapseBreakMarkers 折叠：双 BR 分段、单 BR 转硬换行
 *   - 图注（figcaption、微信小字图注）输出 CAPTION 标记开头的独立段落，由 ir/markers 还原为 data.role
 *   - 带 data-mf-display 的 <img> 输出 <img src alt width>，由 ir/inline-html 还原为带 data.display 的 image 节点
 *
 * 表格规则 convertTableToMarkdown 为本文件内部函数，不再在其他文件重复实现。
 */
const TurndownService = require('turndown');
const { MARKERS } = require('./markers');

const BASE_OPTIONS = {
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
};

const BASIC_REMOVED_TAGS = ['script', 'style', 'noscript'];
const URL_REMOVED_TAGS = ['script', 'style', 'noscript', 'iframe', 'nav', 'footer', 'aside'];
// word profile 输出为行内 HTML 的标签：Markdown 没有对应语法，由 ir/inline-html 提升为 IR 节点
const WORD_INLINE_TAGS = ['u', 'sup', 'sub'];
// 「~」及其前导反斜杠（判定是否已被 turndown 自身转义），按「一串反斜杠（可后接一个 ~）」或「单个 ~」分词。
// 不写成 /(\\*)~/g：前导的 \\* 在不含「~」的超长反斜杠串上逐位回溯，耗时随长度平方增长
//（1 万个反斜杠 40 毫秒、4 万个 777 毫秒、16 万个 13.7 秒），而网页正文属不可信输入。
// 本式的 ~? 可选，极大反斜杠串一次匹配即成功，不存在失败后的逐位回溯，耗时线性于文本长度
const TILDE_RE = /\\+~?|~/g;
// 图片 alt 的分行符。不写成 /\s*[\r\n]+\s*/ 一步替换：前导的 \s* 在不含换行的超长空白串上逐位回溯，
// 耗时随长度平方增长（16 万个空格约 9 秒），而网页的 alt 属不可信输入
const LINE_BREAK_RE = /[\r\n]+/;

// CSS font-weight 视为加粗的取值：bold、600-999、1000
const BOLD_STYLE_RE = /font-weight\s*:\s*(bold|[6-9]\d{2}|1000)/i;
const ITALIC_STYLE_RE = /font-style\s*:\s*italic/i;
const STRIKE_STYLE_RE = /text-decoration\s*:\s*line-through/i;
// 微信图片说明：字号 ≤ 14px 的小字
const SMALL_FONT_RE = /font-size\s*:\s*(1[0-4]|[0-9])px/i;
const CAPTION_MAX_LENGTH = 100;
const CAPTION_TAGS = new Set(['SPAN', 'P', 'SECTION']);
// 分块包裹时不套标签的 Markdown 块语法（标题、引用、列表、表格、代码围栏）
const BLOCK_SYNTAX_RE = /^(?:#{1,6}\s|>|[-*+]\s|\d{1,9}[.)]\s|\||```|~~~)/;
// data-mf-display 的取值：'677' | '677x300' | '50%'（见 web/image-display.formatDisplayAttr）
const DISPLAY_ATTR_RE = /^(\d{1,5})(?:x(\d{1,5}))?$|^(\d{1,3}(?:\.\d+)?)%$/;

/** @param {'basic'|'word'|'url'} profile @returns {TurndownService} */
function createTurndownService(profile = 'basic') {
    const configure = PROFILE_BUILDERS[profile];
    if (!configure) {
        throw new Error(`未知的 turndown profile: ${String(profile)}（可选 basic | word | url）`);
    }
    const service = new TurndownService(BASE_OPTIONS);
    // 最先注册、优先级低于各 profile 的规则：word 的 emptyImg 与 url 的 imgDisplay 仍先于它命中
    addImageAltRule(service);
    configure(service);
    escapeTildesIn(service);
    return service;
}

// ---------- 规则辅助 ----------

function styleOf(node) {
    return (node && node.getAttribute && node.getAttribute('style')) || '';
}

function wrapTrimmed(content, marker) {
    const text = content.trim();
    return text ? `${marker}${text}${marker}` : '';
}

/**
 * 以 HTML 标签包裹：内容含空行（块级内容）时逐块包裹，Markdown 块语法开头的块不包，
 * 避免开闭标签落在不同段落里失配
 */
function wrapHtml(content, open, close) {
    const text = content.trim();
    if (!text) return '';
    if (!/\n\s*\n/.test(text)) return `${open}${text}${close}`;
    return text.split(/\n\s*\n/)
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk) => (BLOCK_SYNTAX_RE.test(chunk) ? chunk : `${open}${chunk}${close}`))
        .join('\n\n');
}

// 图注：CAPTION 标记开头的独立段落（不再转斜体，md 中与 MinerU full.md 一样是图片后的普通段落）
const captionBlock = (content) => (content.trim() ? `\n\n${MARKERS.CAPTION}${content.trim()}\n\n` : '');

// 微信公众号图片说明：紧跟在图片后面、字号较小的短文本；小字样式可能写在元素自身或其首个子元素上
function isWxImageCaption(node) {
    if (!CAPTION_TAGS.has(node.nodeName)) return false;
    const text = node.textContent.trim();
    if (!text || text.length >= CAPTION_MAX_LENGTH) return false;
    if (node.querySelector && node.querySelector('img')) return false;
    const first = node.firstElementChild;
    if (!SMALL_FONT_RE.test(styleOf(node)) && !SMALL_FONT_RE.test(styleOf(first))) return false;
    const prev = node.previousElementSibling
        || (node.parentNode && node.parentNode.previousElementSibling);
    return !!(prev && (prev.nodeName === 'IMG' || (prev.querySelector && prev.querySelector('img'))));
}

function addTableRule(service) {
    service.addRule('table', {
        filter: 'table',
        // escape 在转换时才取值，拿到的是 escapeTildesIn 包装后的版本（含「~」转义）
        replacement: (content, node) => convertTableToMarkdown(node, (text) => service.escape(text)),
    });
}

/**
 * 接管内置 image 规则，只把其中的 alt 换成经 service.escape 转义的版本。src 与 title 仍交内置规则生成
 * （分别走模块私有的 escapeLinkDestination 与 escapeLinkTitle，title 不按 Markdown 解析、其中的「~」
 * 不必也不应转义），故克隆一个去掉 alt 的节点交它处理，再把转义后的 alt 拼回去，产物与内置规则逐字一致。
 * alt 只折叠换行：换行后的「- 」「# 」「>」等块级记号会打断段落，整张图片连同 alt 一起丢失。
 */
function addImageAltRule(service) {
    const builtinImage = service.options.rules.image;
    service.addRule('imageAlt', {
        filter: 'img',
        replacement: (content, node, options) => {
            const withoutAlt = node.cloneNode(false);
            withoutAlt.removeAttribute('alt');
            // 内置规则的产物为 ![](src "title")，无 src 时为空串
            const rest = builtinImage.replacement(content, withoutAlt, options);
            if (!rest) return '';
            return `![${service.escape(joinAltLines(node.getAttribute('alt')))}${rest.slice(2)}`;
        },
    });
}

// 逐行 trim 后以单个空格连接，空行丢弃：被折叠的只有换行及其两侧的空白，行内的制表符与连续空格逐字保留
function joinAltLines(alt) {
    return String(alt || '').split(LINE_BREAK_RE).map((line) => line.trim()).filter(Boolean).join(' ');
}

// 带显示尺寸的图片：<img src alt width [height]>（属性值转义；无 src 的图片交默认规则）
function imageHtml(node) {
    const matched = DISPLAY_ATTR_RE.exec(String(node.getAttribute('data-mf-display') || '').trim());
    const src = String(node.getAttribute('src') || '').trim();
    if (!matched || !src) return null;
    const attrs = [`src="${escapeAttr(src)}"`];
    const alt = String(node.getAttribute('alt') || '').trim();
    if (alt) attrs.push(`alt="${escapeAttr(alt)}"`);
    if (matched[3]) {
        attrs.push(`width="${matched[3]}%"`);
    } else {
        attrs.push(`width="${matched[1]}"`);
        if (matched[2]) attrs.push(`height="${matched[2]}"`);
    }
    return `<img ${attrs.join(' ')}>`;
}

function escapeAttr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- word profile：段内换行与强调定界符 ----------

/*
 * 成因：turndown 默认把 <br> 写成「两个空格 + 换行」（options.br + '\n'），默认的 strong / emphasis 规则把它原样
 * 包进定界符：<strong><br />加粗</strong> →「**  \n加粗**」。开定界符后紧跟空白、闭定界符前紧跟空白时，按 CommonMark
 * 的 flanking 规则都不能开闭强调，两侧星号成为字面文字；两个以上 <br> 连写时，中间行只剩两个空格、即为空行，
 * 段落在此断开。另外，元素文本带首尾空白时 turndown 先对其内容整体 trim，贴在强调、下划线或链接内侧首尾的
 * 「  \n」随之削掉，换行静默丢失（<strong> 加粗<br /></strong> →「 **加粗**」）。
 *
 * 换行规则按所在块的上下文取三种写法之一：
 *   - 所在块为 h1–h6：沿用「两个空格 + 换行」，标题内换行的既有表现（标题 + 段落）不变；
 *   - 在所在块的行内连续区中前面没有内容或后面没有内容（段首、段尾）：同样沿用原写法，由 remark 按块边界舍弃，
 *     IR 与原先一致；
 *   - 前后都有内容（段中）：输出行内 HTML <br>，由 ir/inline-html 提升为 break 节点。连写多个也不产生空行，
 *     其中也没有空白可供 trim 削去。
 * 不用反斜杠式（「\」+ 换行）：trim 只削掉其中的换行，留下的孤立反斜杠会转义下一个字符（「<u>下划线\</u>」
 * 「[链接\](u)」），标签与链接随之失配。
 * 块按 turndown 的块级元素判定，沿父链取最近的块级祖先；块内嵌套的块级元素（如 li 里的 ul）是行内连续区的边界，
 * 不算内容。内容指含 [ \t\r\n] 以外字符的文本节点，或带非空 src 的 img（无 src 的由 emptyImg 规则删除）；其余元素
 * 按其后代判定，<br> 本身不算内容。
 *
 * 加粗与斜体规则把内容首尾的换行记号（<br> 或「两个空格 + 换行」）剥到定界符之外，输出「首部 <br> + 定界符 + 核心 +
 * 定界符 + 尾部 <br>」；嵌套时由内向外逐层剥离（斜体先剥到 * 外，加粗再剥到 ** 外）。剥下的「两个空格 + 换行」
 * （段首段尾与标题内的换行）不再输出：remark 本就按块边界舍弃段首段尾的换行，留在输出里反而有害——列表项以两行
 * 以上的空白行开头时成为空项、其后内容变为缩进代码块，外层链接被空行拆开；标题内处在强调首尾的换行随之舍弃，
 * 标题不再被拆开。与换行记号相邻的空白一并剥去、不再输出：<br> 不贡献文本，这些空白处在元素文本的首尾，turndown
 * 已据此在元素外侧补出 flanking 空白，留在定界符内侧既重复一份，又使定界符贴着空白而失效（换行与全角空格相邻时
 * 即如此）。已知限制：turndown 补出的空白位于整个元素产出的外侧，剥出的 <br> 却在元素产出之内，二者次序因此颠倒。
 * turndown 在调用规则之前已把这份空白拼进输出（见其 replacementForNode），规则内无从调整：以「换行 + 全角空格」
 * 开头的 run，全角空格移到换行之前；以「全角空格 + 换行」结尾的 run，全角空格移到换行之后。修复前这类 run 的
 * 换行整个丢失。尾部的 <br> 前紧邻奇数个反斜杠时，「<」是被转义的字面文字（文本中的「<」转义为 \< 之后），剥离
 * 到此为止。
 *
 * 耗时须线性于块长：一段内连写 n 个 <br> 时，逐个重扫兄弟节点即成平方级，故首次遇到某块时整块线性扫描一次，
 * 把其中每个 <br> 的归类写入 WeakMap，同块其余 <br> 直接查表。剥离一律按下标手工扫描，不写「量词 + 行尾锚」或
 * 「前导量词 + 必需字符」形态的正则：长串换行记号位于中段时，这类正则从每个起点逐位回溯，耗时随长度平方增长。
 */

// turndown 7.2 判定块级所用的标签（其内部 blockElements 未导出，此处照录），换行的归类须与之一致
const TURNDOWN_BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'AUDIO', 'BLOCKQUOTE', 'BODY', 'CANVAS', 'CENTER', 'DD', 'DIR', 'DIV', 'DL', 'DT',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'FRAMESET', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
    'HGROUP', 'HR', 'HTML', 'ISINDEX', 'LI', 'MAIN', 'MENU', 'NAV', 'NOFRAMES', 'NOSCRIPT', 'OL', 'OUTPUT', 'P', 'PRE',
    'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);
const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const HTML_BREAK = '<br>';
// 与 turndown 折叠空白所用的字符集一致：只由这四种字符构成的文本节点不算内容
const CONTENT_CHAR_RE = /[^ \t\r\n]/;
// 单个空白字符，与 String.prototype.trim 去除的字符同集
const TRIMMABLE_CHAR_RE = /\s/;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;

/** word profile 的换行规则与加粗、斜体规则（说明见上方块注释） */
function addBreakRules(service) {
    // <br> 节点 → 是否在所在块的行内连续区中前后都有内容。每次 turndown 调用都解析出新的 DOM，键不会串用
    const midBreaks = new WeakMap();
    service.addRule('wordLineBreak', {
        filter: 'br',
        replacement: (content, node, options) => (isMidBreak(node, midBreaks) ? HTML_BREAK : `${options.br}\n`),
    });
    service.addRule('wordStrong', {
        filter: ['strong', 'b'],
        replacement: (content, node, options) => wrapOutsideBreaks(content, options.strongDelimiter, `${options.br}\n`),
    });
    service.addRule('wordEmphasis', {
        filter: ['em', 'i'],
        replacement: (content, node, options) => wrapOutsideBreaks(content, options.emDelimiter, `${options.br}\n`),
    });
}

function isMidBreak(br, midBreaks) {
    if (!midBreaks.has(br)) {
        const block = enclosingBlock(br);
        if (HEADING_TAGS.has(block.nodeName)) return false;
        classifyBreaks(block, midBreaks);
    }
    return midBreaks.get(br) === true;
}

/** 最近的块级祖先；父链上没有块级元素时（以脱离文档的 DOM 节点为输入）取最顶层的祖先 */
function enclosingBlock(node) {
    let top = node;
    for (let parent = node.parentNode; parent; parent = parent.parentNode) {
        if (TURNDOWN_BLOCK_TAGS.has(parent.nodeName)) return parent;
        top = parent;
    }
    return top;
}

/**
 * 按文档顺序把块内节点扫描一遍（不进入嵌套的块级元素，它们归各自的块扫描），把其中每个 <br> 的归类写入 midBreaks。
 * waiting 为当前行内连续区中尚未见到后续内容的 <br> 及其前面是否已有内容，每个 <br> 入列、出列各一次
 */
function classifyBreaks(block, midBreaks) {
    let waiting = [];
    let contentBefore = false;
    const settle = (contentAfter) => {
        for (const { br, before } of waiting) midBreaks.set(br, before && contentAfter);
        waiting = [];
    };
    const meetContent = () => {
        settle(true);
        contentBefore = true;
    };
    let node = block.firstChild;
    while (node) {
        let descend = false;
        if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_SECTION_NODE) {
            if (CONTENT_CHAR_RE.test(node.data)) meetContent();
        } else if (node.nodeType === ELEMENT_NODE) {
            if (node.nodeName === 'BR') {
                waiting.push({ br: node, before: contentBefore });
            } else if (TURNDOWN_BLOCK_TAGS.has(node.nodeName)) {
                // 嵌套的块级元素：行内连续区在此断开
                settle(false);
                contentBefore = false;
            } else if (node.nodeName === 'IMG') {
                if (node.getAttribute('src')) meetContent();
            } else {
                descend = Boolean(node.firstChild);
            }
        }
        node = descend ? node.firstChild : nextOutsideSubtree(node, block);
    }
    settle(false);
}

/** 文档顺序中跳过 node 的子树之后的下一个节点；越出 block 时返回 null */
function nextOutsideSubtree(node, block) {
    for (let current = node; current && current !== block; current = current.parentNode) {
        if (current.nextSibling) return current.nextSibling;
    }
    return null;
}

/**
 * 以定界符包裹：首尾的换行记号与相邻空白剥到定界符之外，其中只输出段中换行 <br>（理由见上方块注释）。
 * 核心为空（只含换行与空白）时只输出剥下的 <br>，只含换行的 run 由此保住段中换行；既无 <br> 又无核心时返回空串，
 * 同默认规则
 */
function wrapOutsideBreaks(content, delimiter, lineBreak) {
    const head = leadingBreaks(content, lineBreak);
    const tail = trailingBreaks(content, head.end, lineBreak);
    const core = content.slice(head.end, tail.start);
    const htmlBreaks = (tokens) => tokens.filter((token) => token === HTML_BREAK).join('');
    if (!core) return htmlBreaks([...head.tokens, ...tail.tokens]);
    return `${htmlBreaks(head.tokens)}${delimiter}${core}${delimiter}${htmlBreaks(tail.tokens)}`;
}

/** 自串首起连续的换行记号与空白：返回其终点与其中的换行记号（按原序） */
function leadingBreaks(content, lineBreak) {
    const tokens = [];
    let at = 0;
    while (at < content.length) {
        let token = null;
        if (content.startsWith(HTML_BREAK, at)) token = HTML_BREAK;
        else if (content.startsWith(lineBreak, at)) token = lineBreak;
        if (token) {
            tokens.push(token);
            at += token.length;
        } else if (TRIMMABLE_CHAR_RE.test(content[at])) {
            at += 1;
        } else {
            break;
        }
    }
    return { end: at, tokens };
}

/**
 * 自串尾向前、不越过 floor 的连续换行记号与空白：返回其起点与其中的换行记号（按原序）。
 * <br> 前紧邻奇数个反斜杠时「<」是被转义的字面文字，到此为止。串首无须此判定：首部的 <br> 之前只有换行记号与空白
 */
function trailingBreaks(content, floor, lineBreak) {
    const tokens = [];
    let at = content.length;
    while (at > floor) {
        let token = null;
        if (endsAt(content, HTML_BREAK, at, floor) && !isEscaped(content, at - HTML_BREAK.length)) token = HTML_BREAK;
        else if (endsAt(content, lineBreak, at, floor)) token = lineBreak;
        if (token) {
            tokens.push(token);
            at -= token.length;
        } else if (TRIMMABLE_CHAR_RE.test(content[at - 1])) {
            at -= 1;
        } else {
            break;
        }
    }
    return { start: at, tokens: tokens.reverse() };
}

/** content 中止于 end 的一段恰为 token，且起点不小于 floor */
function endsAt(content, token, end, floor) {
    const start = end - token.length;
    return start >= floor && content.startsWith(token, start);
}

/** 下标 index 处的字符前紧邻奇数个反斜杠，即该字符已被转义 */
function isEscaped(content, index) {
    let count = 0;
    for (let at = index - 1; at >= 0 && content[at] === '\\'; at -= 1) count += 1;
    return count % 2 === 1;
}

// ---------- 各 profile 配置 ----------

function configureBasic(service) {
    service.remove(BASIC_REMOVED_TAGS);
}

function configureWord(service) {
    addTableRule(service);
    addBreakRules(service);
    service.addRule('emptyImg', {
        filter: (node) => node.nodeName === 'IMG' && !node.getAttribute('src'),
        replacement: () => '',
    });
    // 不用 service.keep：keep 输出 outerHTML，标签内的首尾空白会与 turndown 置于标签外的同一份空白重复
    //（「K<sub>3 </sub>(348」变成两个空格），且标签内的文本绕过 escape、其中的「~」得不到转义。
    // 改为按常规规则处理内容，只在外层补回标签本身（不带属性）
    service.addRule('inlineFormat', {
        filter: WORD_INLINE_TAGS,
        replacement: (content, node) => {
            const tag = node.nodeName.toLowerCase();
            return content ? `<${tag}>${content}</${tag}>` : '';
        },
    });
}

/** 在实例的转义链末端补上「~」的转义（各 profile 共用，故挂在工厂层而非某个 configure 内） */
function escapeTildesIn(service) {
    const escapeMarkdown = service.escape.bind(service);
    service.escape = (text) => escapeTildes(escapeMarkdown(text));
}

/**
 * 在 turndown 自身的转义结果上补转义「~」。turndown 的转义表只处理行首的 ~~~，且会把文本中的字面
 * 反斜杠加倍，因此按前导反斜杠的奇偶判定：奇数个表示该「~」已被转义，原样保留；偶数个（含 0 个）补一个。
 * TILDE_RE 的记号只有两形：不以「~」结尾的即纯反斜杠串，与「~」无关，原样返回；以「~」结尾的其
 * 前导反斜杠个数即记号长度减 1，该串恒为该「~」之前极大的连续反斜杠串。
 */
function escapeTildes(text) {
    return text.replace(TILDE_RE, (matched) => {
        if (!matched.endsWith('~')) return matched;
        const slashCount = matched.length - 1;
        return slashCount % 2 === 1 ? matched : `${matched.slice(0, slashCount)}\\~`;
    });
}

// [规则名, filter, 开标签, 闭标签]；turndown 后注册的规则优先级更高，顺序不可调整。
// 上下标排在表首、优先级最低：带 line-through 等样式的 <sup>/<sub> 仍归后面的样式规则接管
const URL_WRAP_RULES = [
    ['supTag', ['sup'], '<sup>', '</sup>'],
    ['subTag', ['sub'], '<sub>', '</sub>'],
    ['inlineBold', (node) => ['SPAN', 'P', 'SECTION'].includes(node.nodeName) && BOLD_STYLE_RE.test(styleOf(node)), '<strong>', '</strong>'],
    ['inlineItalic', (node) => node.nodeName === 'SPAN' && ITALIC_STYLE_RE.test(styleOf(node)), '<em>', '</em>'],
    ['inlineStrikethrough', (node) => STRIKE_STYLE_RE.test(styleOf(node)), '<del>', '</del>'],
    ['delTag', ['del', 's'], '<del>', '</del>'],
    ['htmlStrong', ['strong', 'b'], '<strong>', '</strong>'],
    ['htmlEmphasis', ['em', 'i'], '<em>', '</em>'],
];

function configureUrl(service) {
    // 最先注册、优先级最低：带样式的 section（加粗、图注）由后注册的规则接管
    service.addRule('sectionBlock', { filter: 'section', replacement: (content) => `\n\n${content}\n\n` });
    service.addRule('lineBreak', { filter: 'br', replacement: () => MARKERS.BR });
    for (const [name, filter, open, close] of URL_WRAP_RULES) {
        service.addRule(name, {
            filter,
            replacement: (content, node) => {
                const wrapped = wrapHtml(content, open, close);
                return node.isBlock && wrapped ? `\n\n${wrapped}\n\n` : wrapped;
            },
        });
    }
    service.addRule('mark', { filter: 'mark', replacement: (content) => wrapTrimmed(content, '==') });
    service.addRule('figcaption', { filter: 'figcaption', replacement: captionBlock });
    service.addRule('figure', { filter: 'figure', replacement: (content) => `\n\n${content.trim()}\n\n` });
    service.addRule('wxImgCaption', { filter: isWxImageCaption, replacement: captionBlock });
    service.addRule('imgDisplay', {
        filter: (node) => node.nodeName === 'IMG' && Boolean(node.getAttribute('data-mf-display')) && Boolean(node.getAttribute('src')),
        replacement: (content, node) => imageHtml(node) || '',
    });
    addTableRule(service);
    service.remove(URL_REMOVED_TAGS);
}

const PROFILE_BUILDERS = { basic: configureBasic, word: configureWord, url: configureUrl };

// ---------- HTML 表格 → GFM 表格（源自 旧版 word.js:164）----------
// 单元格取纯文本；折叠换行后经 service.escape 转义，再转义竖线，避免破坏 GFM 表格结构

function convertTableToMarkdown(tableNode, escape) {
    const rows = ownRows(tableNode);
    if (rows.length === 0) return '';
    const matrix = rows.map((row) => ownCells(row).map((cell) => cellText(cell, escape)));
    // 列数取各行最大值：首行是表头时常比数据行短，只按首行算会截断整表
    const columnCount = matrix.reduce((max, cells) => Math.max(max, cells.length), 0);
    const lines = matrix.map((cells) => {
        const padded = [...cells];
        while (padded.length < columnCount) padded.push('');
        return `| ${padded.join(' | ')} |`;
    });
    const separator = `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`;
    return `\n\n${[lines[0], separator, ...lines.slice(1)].join('\n')}\n\n`;
}

// querySelectorAll 会连嵌套表格的行一并取回，须按「最近的 table 祖先」筛出直属本表格的行
function ownRows(tableNode) {
    const rows = tableNode.querySelectorAll ? Array.from(tableNode.querySelectorAll('tr')) : [];
    return rows.filter((row) => closestByName(row, 'TABLE') === tableNode);
}

// 单元格必为 tr 的直接子节点，取子节点即可天然排除嵌套表格的单元格
function ownCells(row) {
    return Array.from(row.children || []).filter((el) => el.nodeName === 'TD' || el.nodeName === 'TH');
}

function closestByName(node, nodeName) {
    for (let current = node.parentNode; current; current = current.parentNode) {
        if (current.nodeName === nodeName) return current;
    }
    return null;
}

/**
 * 单元格纯文本：折叠空白 → escape → 转义竖线。三步顺序不可调换：
 *   - escape 须先于竖线转义。escape 会把字面反斜杠加倍，此后每个竖线的前导反斜杠必为偶数个，再补一个即成
 *     奇数，micromark 的表格分词器先成对吃掉 \\、再把 \| 当作转义竖线，「a\|b」才不会被拆成两个单元格；
 *     反过来先转义竖线，补上的那个反斜杠会被随后的 escape 一并加倍而失效。
 *   - 折叠须先于 escape。turndown 转义表里的 ^- 、^> 、^(\d+). 等只锚定字符串开头，先 trim 可使其是否
 *     触发不取决于源 HTML 的前导空白；这些转义在单元格内虽非必需，但均为合法转义，IR 文本不变。
 */
function cellText(cell, escape) {
    return escape(cell.textContent.replace(/\s+/g, ' ').trim()).replace(/\|/g, '\\|');
}

module.exports = { createTurndownService, URL_REMOVED_TAGS };
