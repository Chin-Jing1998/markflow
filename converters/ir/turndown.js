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
 *
 * 强调定界符的失效与改写。成因：CommonMark 的 flanking 规则要求开定界符后面不是空白，且后面是标点时前面须为空白、
 * 标点或行首；闭定界符前面不是空白，且前面是标点时后面须为空白、标点或行尾（micromark 的标点取 \p{P} 与 \p{S}，空白
 * 取 \s，行首行尾同算空白）。中文正文里的强调常以书名号、引号、冒号、句号收尾而两侧紧贴汉字（「依据**《专利法》**的规定」
 * 「**注意：**本发明」），定界符不成立、字面星号进入 IR，md 渲染时再被转义成 \*\*；内层的 <u>、<sup>、<sub>、图片与链接
 * 处在边界上时定界符贴着「<」「!」「[」，同样失效。两对定界符紧邻时（「***甲****乙*」「**加粗***。*」）星号串合并成一个
 * 定界符串，micromark 按自己的拆分（其「3 的倍数」规则按剩余长度计，与 cmark 不同）配对，结果无从推演。
 * 写法：加粗、斜体规则不再直接写定界符，而在定界符的位置写四种哨兵（加粗开、加粗闭、斜体开、斜体闭），configureWord
 * 包装 service.turndown，在整篇输出上由 resolveWordEmphasis 按栈给哨兵配对，逐对决定写成 ** / * 还是 <strong> / <em>——
 * 后者由 ir/inline-html 在 remark 解析后还原为 strong / emphasis 节点，与标点无关。判定按最终输出中真实相邻的字符进行；
 * 各对的结论互不依赖——凡与别的哨兵相邻即改写为标签，与相邻那一对的写法无关，只有整段包住的两对一并决定。处理顺序为
 * 闭哨兵的先后（内层先于外层、前一兄弟先于后一兄弟），整段包住的判定在内层这一对上完成、外层随之定案。
 * 判定依据（任一命中即改写为标签）：
 *   - 核心为空：整对删除，只在输入混入同码点字符时出现；核心含换行：标题内处在强调中段的「两个空格 + 换行」；
 *   - 同类嵌套（Strong 字符样式叠加加粗 run 时 mammoth 产出 <strong><strong>）：内外两对都改写，否则内层的开定界符
 *     会与外层配对，「**甲**乙**丙**」里的乙失去加粗；改写后由 ir/inline-html 拍平为一个节点；
 *   - 开哨兵的前后、闭哨兵的前后四个位置任一处是别的哨兵：写定界符会与相邻对的定界符合并成串。唯一例外是加粗恰好整段
 *     包住斜体（或斜体整段包住加粗）且外层两侧都不贴着哨兵：合并串 ***X*** 是 CommonMark 规定的 emphasis(strong(X))
 *     写法，按 X 的首尾字符与外层的外侧字符做同一 flanking 判定，成立则两对都写定界符，否则两对都改写；
 *   - flanking 不成立：核心首字符是空白，或是标点而开定界符的前一字符既非空白、标点也非串首；核心末字符是空白，或是
 *     标点而闭定界符的后一字符既非空白、标点也非串尾。串首串尾与换行符同算空白，与 micromark 一致：块级前缀（「# 」
 *     「-   」）之后的位置在 micromark 里是行首，在本串里是空格，同属空白。
 *     辅助平面字符的归类：micromark 4 以 UTF-16 码元为单位（preprocess 按 charCodeAt 切分，attention 取前一码元交
 *     classifyCharacter），单个代理项不匹配 \p{P}|\p{S} 也不是空白，辅助平面的标点与符号在其眼中一律为「其他」；
 *     CommonMark 0.31.2 按字符定义，同一字符则算标点。两种归类下都不得写出会失效的定界符，故取其严：核心首末字符按
 *     码点归类，辅助平面的标点与符号算标点（对外侧字符的要求更严）；外侧字符凡属辅助平面一律按「其他」，不因其为标点
 *     而放宽（对核心首末为标点的情形更严）；BMP 字符两种归类相同、照旧。代价是少数本可写定界符的情形改写为标签
 *     （核心只有 U+1F600 而两侧为汉字时改写；外侧为 U+1F600 而核心为书名号时本就失效），IR 不变；只有加粗斜体
 *     整段包住、核心首尾为辅助平面符号而外侧为汉字时，改写后 IR 由 emphasis(strong) 变为 strong(emphasis)。
 *     整段包住的 ***X*** 判定走同一规则。
 * 哨兵取 XML 1.0 不允许出现的 C0 控制字符 U+001C–U+001F（FS、GS、RS、US），docx 正文不可能含有，也不与 ir/markers 的
 * 私用区标记（U+EF00 起）相交；一律以码点生成。输入混入同码点字符时行为确定：按栈配对，配不成对的（无对应开哨兵的
 * 闭哨兵、到串尾仍未闭合的开哨兵、被异类闭哨兵越过的开哨兵）一律删除，其余照常判定，产物不含任何哨兵。
 * 已知表现：加粗整段包住斜体而外层贴着别的强调时（「<strong><em>甲</em></strong><em>乙</em>」）两对都改写为标签，IR 为
 * strong(emphasis) 而非定界符 ***X*** 解析出的 emphasis(strong)，两种次序各渲染器同等处理；只包着图片的加粗改写为标签时，
 * ir/inline-html 拆除该格式帧（图片不承载加粗），写定界符时则仍为 strong(image)。
 * 耗时线性于输出长度：配对、删除孤儿、判定与写出各扫描一遍；配对按种类各维护一个开哨兵栈，闭哨兵直接取同类栈顶，越过
 * 的开哨兵逐个弹出，每个哨兵入栈出栈至多各一次；判定只看每对的四个相邻位置与核心首尾字符，核心是否含换行查换行符的
 * 前缀计数表，不切取核心子串（交替嵌套 n 层时逐对切取即成平方级）。扫描一律按下标进行，不用正则。
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
// 强调定界符的哨兵：XML 1.0 不允许出现的 C0 控制字符 U+001C–U+001F（FS、GS、RS、US），一律以码点生成。
// 码点的次序即种类与开闭：偶数位为开、奇数位为闭，前两个为加粗、后两个为斜体
const SENTINEL_FIRST = 0x1c;
const SENTINEL_LAST = 0x1f;
const EM_SENTINEL_FIRST = 0x1e;
const fromCode = (code) => String.fromCharCode(code);
const STRONG_OPEN = fromCode(SENTINEL_FIRST);
const STRONG_CLOSE = fromCode(SENTINEL_FIRST + 1);
const EM_OPEN = fromCode(EM_SENTINEL_FIRST);
const EM_CLOSE = fromCode(EM_SENTINEL_FIRST + 1);
// 是否含哨兵的快速判定：单个字符类、无量词
const SENTINEL_RE = new RegExp(`[${STRONG_OPEN}-${EM_CLOSE}]`);
const EMPHASIS_FORMS = Object.freeze({
    strong: { delimiter: '**', open: '<strong>', close: '</strong>' },
    em: { delimiter: '*', open: '<em>', close: '</em>' },
});
// flanking 判定的字符类别：标点取 \p{P} 与 \p{S}，空白取 \s（同 TRIMMABLE_CHAR_RE），串首串尾同算空白。micromark 4 按 UTF-16
// 码元归类，辅助平面字符（两个代理项码元）在其眼中一律为「其他」，CommonMark 则按字符（码点）定义；两种归类下都不得写出会失效
// 的定界符，故取其严：核心首末字符按码点归类（辅助平面的标点、符号算标点），外侧字符凡属辅助平面一律按「其他」（见 isFlankingSafe）
const PUNCTUATION_RE = /[\p{P}\p{S}]/u;
const MAX_BMP_CODE_POINT = 0xffff;
const CHAR_SPACE = 'space';
const CHAR_PUNCT = 'punct';
const CHAR_OTHER = 'other';
// 每对哨兵的写法
const FORM_DELIMITER = 'delimiter';
const FORM_HTML = 'html';
const FORM_DROP = 'drop';

/** word profile 的换行规则与加粗、斜体规则（说明见上方块注释） */
function addBreakRules(service) {
    // <br> 节点 → 是否在所在块的行内连续区中前后都有内容。每次 turndown 调用都解析出新的 DOM，键不会串用
    const midBreaks = new WeakMap();
    service.addRule('wordLineBreak', {
        filter: 'br',
        replacement: (content, node, options) => (isMidBreak(node, midBreaks) ? HTML_BREAK : `${options.br}\n`),
    });
    // 定界符的位置先写哨兵，写成 ** / * 还是 <strong> / <em> 由 resolveWordEmphasis 在整篇输出上决定（见下方块注释）
    service.addRule('wordStrong', {
        filter: ['strong', 'b'],
        replacement: (content, node, options) => wrapOutsideBreaks(content, STRONG_OPEN, STRONG_CLOSE, `${options.br}\n`),
    });
    service.addRule('wordEmphasis', {
        filter: ['em', 'i'],
        replacement: (content, node, options) => wrapOutsideBreaks(content, EM_OPEN, EM_CLOSE, `${options.br}\n`),
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
 * 以开闭记号包裹：首尾的换行记号与相邻空白剥到记号之外，其中只输出段中换行 <br>（理由见上方块注释）。
 * 核心为空（只含换行与空白）时只输出剥下的 <br>，只含换行的 run 由此保住段中换行；既无 <br> 又无核心时返回空串，
 * 同默认规则
 */
function wrapOutsideBreaks(content, open, close, lineBreak) {
    const head = leadingBreaks(content, lineBreak);
    const tail = trailingBreaks(content, head.end, lineBreak);
    const core = content.slice(head.end, tail.start);
    const htmlBreaks = (tokens) => tokens.filter((token) => token === HTML_BREAK).join('');
    if (!core) return htmlBreaks([...head.tokens, ...tail.tokens]);
    return `${htmlBreaks(head.tokens)}${open}${core}${close}${htmlBreaks(tail.tokens)}`;
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

// ---------- 强调定界符：哨兵配对与写法定夺（说明见上方块注释） ----------

/**
 * 把 word profile 的 turndown 输出里的强调哨兵换成 ** / * 或 <strong> / <em>，配不成对的哨兵删除；不含哨兵时原样返回。
 * 全程按下标扫描、不建位置索引：先按栈配对并标出孤儿，再把串切成相邻两个保留哨兵之间的文本段（孤儿删去、两侧文本并为
 * 一段），各对的相邻字符、是否贴着别的哨兵、核心是否为空或含换行都从文本段及其换行计数得出，最后逐段写出
 */
function resolveWordEmphasis(markdown) {
    const raw = String(markdown);
    if (!SENTINEL_RE.test(raw)) return raw;
    const pairs = pairSentinels(raw);
    const { kept, segments, newlines } = splitBySentinels(raw, pairs);
    markSameKindNesting(kept);
    for (const pair of pairs) decideEmphasisForm(pair, kept, segments, newlines);
    const parts = [];
    for (let index = 0; index < kept.length; index += 1) {
        parts.push(segments[index]);
        const { pair, open } = kept[index];
        if (pair.form === FORM_DROP) continue;
        const forms = EMPHASIS_FORMS[pair.kind];
        parts.push(pair.form === FORM_DELIMITER ? forms.delimiter : open ? forms.open : forms.close);
    }
    parts.push(segments[kept.length]);
    return parts.join('');
}

/**
 * 按栈给哨兵配对：闭哨兵取同类开哨兵中最近的一个，被它越过的（更晚入栈、尚未闭合的）开哨兵与无对应开哨兵的闭哨兵、
 * 到串尾仍未闭合的开哨兵同为孤儿。返回按闭哨兵先后排列的各对，其 tokens 为串中全部哨兵的记录（孤儿的 pair 为 null）。
 * 每个哨兵入栈、出栈至多各一次，线性于串长
 */
function pairSentinels(raw) {
    const tokens = [];
    const stack = [];
    const openByKind = { strong: [], em: [] };
    const pairs = [];
    for (let at = 0; at < raw.length; at += 1) {
        const code = raw.charCodeAt(at);
        if (code < SENTINEL_FIRST || code > SENTINEL_LAST) continue;
        const token = { at, kind: code < EM_SENTINEL_FIRST ? 'strong' : 'em', open: code % 2 === 0, pair: null };
        tokens.push(token);
        if (token.open) {
            token.pair = { kind: token.kind, openAt: -1, closeAt: -1, form: null, nested: false };
            stack.push(token);
            openByKind[token.kind].push(token);
            continue;
        }
        const opens = openByKind[token.kind];
        if (opens.length === 0) continue;
        const match = opens[opens.length - 1];
        // 越过的开哨兵按入栈的逆序弹出，此时各自恰是本种类栈的栈顶
        while (stack[stack.length - 1] !== match) {
            const skipped = stack.pop();
            openByKind[skipped.kind].pop();
            skipped.pair = null;
        }
        stack.pop();
        opens.pop();
        token.pair = match.pair;
        pairs.push(match.pair);
    }
    for (const token of stack) token.pair = null;
    pairs.tokens = tokens;
    return pairs;
}

/**
 * 按保留的哨兵切段：segments[k] 为第 k 个保留哨兵之前（上一个保留哨兵之后）的文本，segments[kept.length] 为串尾的文本，
 * 孤儿哨兵删去、其两侧文本并为一段；newlines[k] 为 segments[0..k] 中换行符的累计个数。各对记下开闭哨兵在 kept 中的下标
 */
function splitBySentinels(raw, pairs) {
    const kept = [];
    const segments = [];
    const newlines = [];
    const pieces = [];
    let copied = 0;
    let count = 0;
    const closeSegment = () => {
        const segment = pieces.length === 1 ? pieces[0] : pieces.join('');
        pieces.length = 0;
        count += countNewlines(segment);
        segments.push(segment);
        newlines.push(count);
    };
    for (const token of pairs.tokens) {
        pieces.push(raw.slice(copied, token.at));
        copied = token.at + 1;
        if (!token.pair) continue;
        closeSegment();
        if (token.open) token.pair.openAt = kept.length;
        else token.pair.closeAt = kept.length;
        kept.push({ pair: token.pair, open: token.open });
    }
    pieces.push(raw.slice(copied));
    closeSegment();
    return { kept, segments, newlines };
}

function countNewlines(text) {
    let count = 0;
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) count += 1;
    return count;
}

/** 同类嵌套：内外两对都标记 nested，各自改写为标签（否则内层的开定界符会与外层配对） */
function markSameKindNesting(kept) {
    const open = { strong: [], em: [] };
    for (const { pair, open: isOpen } of kept) {
        const stack = open[pair.kind];
        if (!isOpen) {
            stack.pop();
            continue;
        }
        if (stack.length > 0) {
            pair.nested = true;
            stack[stack.length - 1].nested = true;
        }
        stack.push(pair);
    }
}

/**
 * 逐对定夺写法。调用顺序为闭哨兵的先后：内层先于外层、前一兄弟先于后一兄弟；整段包住它的另一类对随它一并决定，
 * 轮到该对时已有结论则跳过。开哨兵在 kept 中的下标为 a、闭哨兵为 b 时，核心即 segments[a + 1 .. b]，
 * 一段为空串即该处两个哨兵紧邻（segments[0] 与 segments[kept.length] 为空则是串首、串尾）
 */
function decideEmphasisForm(pair, kept, segments, newlines) {
    if (pair.form) return;
    const a = pair.openAt;
    const b = pair.closeAt;
    const end = kept.length;
    if (b === a + 1 && segments[b] === '') {
        pair.form = FORM_DROP;
        return;
    }
    if (pair.nested || newlines[b] - newlines[a] > 0) {
        pair.form = FORM_HTML;
        return;
    }
    const before = segments[a];
    const first = segments[a + 1];
    const last = segments[b];
    const after = segments[b + 1];
    const outer = a > 0 && b + 1 < end && before === '' && after === '' ? kept[a - 1].pair : null;
    if (outer && outer === kept[b + 1].pair && outer.kind !== pair.kind && !outer.form && !outer.nested
        && (a === 1 || segments[a - 1] !== '') && (b + 2 === end || segments[b + 2] !== '') && first !== '' && last !== '') {
        // 合并串 ***X***：按 X 的首尾字符与外层的外侧字符判定，两对同进退
        const ok = isFlankingSafe(segments[a - 1], first, last, segments[b + 2]);
        pair.form = ok ? FORM_DELIMITER : FORM_HTML;
        outer.form = pair.form;
        return;
    }
    if ((a > 0 && before === '') || first === '' || last === '' || (b + 1 < end && after === '')) {
        pair.form = FORM_HTML;
        return;
    }
    pair.form = isFlankingSafe(before, first, last, after) ? FORM_DELIMITER : FORM_HTML;
}

/**
 * CommonMark 的 flanking 判定：开定界符（前一字符为 before 段的末字符、核心首字符为 first 段的首字符）须为左侧 flanking，
 * 闭定界符（核心末字符为 last 段的末字符、后一字符为 after 段的首字符）须为右侧 flanking；空段即串首或串尾。
 * 核心首末字符按码点归类，外侧字符按 classOfOutside 归类（辅助平面一律为「其他」），两种归类取其严（理由见块注释）
 */
function isFlankingSafe(before, first, last, after) {
    const beforeClass = classOfOutside(codePointBefore(before, before.length));
    const firstClass = classOf(codePointAt(first, 0));
    const lastClass = classOf(codePointBefore(last, last.length));
    const afterClass = classOfOutside(codePointAt(after, 0));
    const canOpen = firstClass !== CHAR_SPACE && (firstClass !== CHAR_PUNCT || beforeClass !== CHAR_OTHER);
    const canClose = lastClass !== CHAR_SPACE && (lastClass !== CHAR_PUNCT || afterClass !== CHAR_OTHER);
    return canOpen && canClose;
}

/** 按码点归类：串首串尾（null）与 \s 为空白，\p{P} 与 \p{S} 为标点（辅助平面的标点、符号在内），其余为「其他」 */
function classOf(codePoint) {
    if (codePoint === null) return CHAR_SPACE;
    const char = String.fromCodePoint(codePoint);
    if (TRIMMABLE_CHAR_RE.test(char)) return CHAR_SPACE;
    return PUNCTUATION_RE.test(char) ? CHAR_PUNCT : CHAR_OTHER;
}

/** 外侧字符的归类：辅助平面字符一律为「其他」（micromark 4 只看贴着定界符的那个代理项码元），其余同 classOf */
function classOfOutside(codePoint) {
    return codePoint !== null && codePoint > MAX_BMP_CODE_POINT ? CHAR_OTHER : classOf(codePoint);
}

/** 始于 at 的码点；越界为 null */
function codePointAt(text, at) {
    return at >= 0 && at < text.length ? text.codePointAt(at) : null;
}

/** 止于 at（最后一个码元的下标为 at - 1）的码点，代理对按整体取；at 不大于 0 时为 null */
function codePointBefore(text, at) {
    if (at <= 0 || at > text.length) return null;
    const low = text.charCodeAt(at - 1);
    if (low >= 0xdc00 && low <= 0xdfff && at >= 2) {
        const high = text.charCodeAt(at - 2);
        if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(at - 2);
    }
    return low;
}

// ---------- 各 profile 配置 ----------

function configureBasic(service) {
    service.remove(BASIC_REMOVED_TAGS);
}

function configureWord(service) {
    addTableRule(service);
    addBreakRules(service);
    // 强调规则写出的哨兵在整篇输出上统一定夺写法（见 resolveWordEmphasis），哨兵不外泄
    const turndown = service.turndown.bind(service);
    service.turndown = (input) => resolveWordEmphasis(turndown(input));
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
