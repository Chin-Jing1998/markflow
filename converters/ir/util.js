/**
 * IR 层公共工具（全仓唯一一份）
 *
 * 只收纳与具体格式无关的纯函数与目录工具：
 *   - 名称处理：sanitizeFolderName（含 Windows 保留设备名规避）/ stripExt / normalizeAuthor
 *   - 文本收集：collectText
 *   - 扩展名推断：getExtFromContentType / getExtFromUrl
 *   - HTML 清洗：stripHtml / removeScriptStyleBlocks / removeHtmlComments / removeHtmlTags
 *   - 目录：ensureDir
 *
 * Turndown 工厂与 HTML 表格转换已迁往 converters/ir/turndown.js；
 * 产物落盘统一由 converters/output.js 负责。
 */
const path = require('path');
const fsp = require('fs').promises;

// 文件夹名最大长度（按 Unicode 码点计数，避免截断代理对）
const MAX_FOLDER_NAME_LENGTH = 100;
// 各操作系统均不允许出现在文件名中的字符
const ILLEGAL_FILENAME_CHARS_RE = /[\\/:*?"<>|]/g;
// 控制字符（含 NUL 与 DEL）直接剔除
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g;
// 首尾须去掉的单个字符：空白、点与下划线（前导点会生成隐藏目录，尾随点与空白在 Windows 上非法）
const EDGE_TRIM_CHAR_RE = /[\s._]/;
// Windows 保留设备名（不分大小写；NUL.txt、NUL.tar.gz 等带扩展名的形式同样等价于 NUL）：CON、PRN、AUX、NUL、
// COM1–COM9、LPT1–LPT9，以及 Windows 视同数字的上标 1、2、3（U+00B9、U+00B2、U+00B3，即 COM¹、LPT³ 等）。
// 出处：Microsoft Learn「Naming Files, Paths, and Namespaces」
const WINDOWS_RESERVED_NAME_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i;
// 命中保留名时追加在主干之后的后缀
const RESERVED_NAME_SUFFIX = '_';
// 末尾须去掉的单个字符：点与空白（Windows 不允许文件名以此结尾）
const TRAILING_DOT_SPACE_CHAR_RE = /[\s.]/;
// 各方在没有真实作者时写入 docProps/core.xml 的占位名（小写形式，供不分大小写的精确匹配）：
//   un-named  docx 库（node_modules/docx）生成文档时 creator 的缺省值
//   unknown   exceljs 写出工作簿时 dc:creator 的缺省值（lib/doc/workbook.js）
//   markflow  本项目 md → docx 渲染器写入的 creator（converters/renderers/docx.js）
// 三者都不是真实作者，写进 front matter 只是噪音，故一律按无作者处理。
const PLACEHOLDER_AUTHORS = new Set(['un-named', 'unknown', 'markflow']);

const EXT_BY_CONTENT_TYPE = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif',
    'image/bmp': '.bmp', 'image/svg+xml': '.svg', 'image/webp': '.webp', 'image/tiff': '.tiff',
    'image/x-emf': '.emf', 'image/x-wmf': '.wmf', 'image/emf': '.emf', 'image/wmf': '.wmf',
};
const DEFAULT_CONTENT_TYPE_EXT = '.png';
const KNOWN_URL_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
const DEFAULT_URL_IMAGE_EXT = '.jpg';

// 首尾修剪以逐字符扫描代替「量词 + 行尾锚」的正则：后者在不处于串尾的长段上从每个起点都贪婪吃到段尾再逐位回溯，
// 耗时随段长平方增长。charRe 须为只匹配单个字符的非全局正则；按 UTF-16 码元逐个判定，与无 u 标志的正则同一口径
function trimTrailingChars(text, charRe) {
    let end = text.length;
    while (end > 0 && charRe.test(text[end - 1])) end -= 1;
    return text.slice(0, end);
}

function trimEdgeChars(text, charRe) {
    let start = 0;
    while (start < text.length && charRe.test(text[start])) start += 1;
    return trimTrailingChars(text.slice(start), charRe);
}

// 把任意标题清洗为可安全落盘的文件夹名：非法字符替换为 "_"（保留分词边界，避免 "a/b" 与
// "ab" 撞名），空白折叠为单个空格，去首尾空白与点，超长按码点截断，空结果回退到 fallback；
// 最后避开 Windows 保留设备名（与平台无关一律处理，保证产物可移植）。
function sanitizeFolderName(name, fallback = '未命名文档') {
    const collapsed = String(name == null ? '' : name)
        .replace(CONTROL_CHARS_RE, '')
        .replace(ILLEGAL_FILENAME_CHARS_RE, '_')
        .replace(/_+/g, '_')
        .replace(/\s+/g, ' ');
    const cleaned = trimEdgeChars(collapsed, EDGE_TRIM_CHAR_RE);
    const base = trimEdgeChars(Array.from(cleaned).slice(0, MAX_FOLDER_NAME_LENGTH).join(''), EDGE_TRIM_CHAR_RE) || fallback;
    return avoidWindowsReservedName(base);
}

// 第一个点之前的主干（去尾部空白后）命中保留名时，在主干之后追加 "_"：CON → CON_，con.txt → con_.txt；
// 非保留名原样返回。追加后超长则按码点截断，并去掉末尾的点与空白
function avoidWindowsReservedName(name) {
    const dot = name.indexOf('.');
    const stem = dot === -1 ? name : name.slice(0, dot);
    if (!WINDOWS_RESERVED_NAME_RE.test(stem.trimEnd())) return name;
    const fixed = `${stem}${RESERVED_NAME_SUFFIX}${dot === -1 ? '' : name.slice(dot)}`;
    return trimTrailingChars(Array.from(fixed).slice(0, MAX_FOLDER_NAME_LENGTH).join(''), TRAILING_DOT_SPACE_CHAR_RE);
}

// 文档作者名归一，供 docx / pptx / xlsx 三个 parser 共用（网页来源的作者另由 parsers/url.js 提取，不走这里）：
// 去首尾空白；整串不分大小写命中 PLACEHOLDER_AUTHORS 时返回空串，调用方据此不写 meta.author。
// 只做整串精确匹配，「un-named 张三」「MarkFlow 团队」这类含占位词的真实姓名照旧返回。
// 非字符串与空白串一律返回空串。
function normalizeAuthor(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    return PLACEHOLDER_AUTHORS.has(text.toLowerCase()) ? '' : text;
}

// 去掉路径前缀与扩展名："/a/b/报告.docx" → "报告"
function stripExt(name) {
    if (!name) return '';
    const str = String(name);
    return path.basename(str, path.extname(str));
}

// 递归拼接 mdast 节点的纯文本：value 节点取 value，容器节点拼接子节点
function collectText(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.value !== undefined && node.value !== null) return String(node.value);
    return Array.isArray(node.children) ? node.children.map(collectText).join('') : '';
}

// "image/jpeg; charset=binary" → ".jpg"；未知类型回退 ".png"
function getExtFromContentType(contentType) {
    const mime = String(contentType == null ? '' : contentType).split(';')[0].trim().toLowerCase();
    return EXT_BY_CONTENT_TYPE[mime] || DEFAULT_CONTENT_TYPE_EXT;
}

// 从 URL 路径部分取图片扩展名；不可识别或 URL 非法时回退 ".jpg"
function getExtFromUrl(url) {
    try {
        const ext = path.extname(new URL(String(url)).pathname).toLowerCase();
        if (KNOWN_URL_IMAGE_EXTS.includes(ext)) return ext;
    } catch (err) { /* URL 非法：走默认扩展名 */ }
    return DEFAULT_URL_IMAGE_EXT;
}

// 递归创建目录（已存在时静默），返回传入的目录路径
async function ensureDir(dir) {
    if (typeof dir !== 'string' || !dir) throw new Error('ensureDir 需要非空的目录路径');
    await fsp.mkdir(dir, { recursive: true });
    return dir;
}

// 去除 HTML 标签（连同 script/style 内容与注释），并还原常见实体
function stripHtml(value) {
    const withoutComments = removeHtmlComments(removeScriptStyleBlocks(String(value || '')));
    return removeHtmlTags(withoutComments)
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .trim();
}

// stripHtml 的去 script/style 块一步。旧式为 .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')：某个开标签之后再无同名闭标签
// 时，[\s\S]*? 从该处逐位扩展到串尾、处处失配，其后每个同名开标签都重来一遍，耗时随这一段的长度平方增长。只用末个闭标签做单一
// 前缀限定并不成立：<script>×n + </style> 的末个闭标签就在串尾，前缀即全串，每个「<script」仍扫到串尾，2 万个时实测约 0.22 秒，
// 与旧式相同，故须逐起点处理。起点判定：起点正则 /<(script|style)\b/gi 要求「<」接 script 或 style（不分大小写）再接词边界；
// 第二个字母 c 与 t 互斥，标签名由文本唯一确定；无 u 标志时 i 只让 ASCII 字母按大小写匹配，U+017F、U+212A、U+0131、U+0130 等
// 都不与 ASCII 字母互配。起点处的结果：以旧式本身的粘连副本（y 标志，lastIndex 置于起点）尝试，所得与全局替换在该处的尝试相同；
// 成功则拼上此前未删的一段，起点正则与已拼位置都移到匹配终点；失败则把小写的标签名记入 exhausted，此后同名起点一律跳过。跳过
// 的正当性（单调性）：旧式在名为 N 的起点失配，当且仅当名后一位 b 及其后再无闭标签 </N\s*>——\1 在 i 标志下按 Canonicalize
// 逐码元比较，与字面量 N 同集；同名的更晚起点 b' > b 同样找不到，必失配；其余位置不以起点起首，旧式必失配；起点处失配或跳过
// 之后，起点正则自名后一位续找，被越过的只是标签名字母，不可能是「<」。故逐轮取得的匹配序列与旧式相同。线性：起点正则的
// lastIndex 只增不减；成功的尝试只扫过自身的匹配区间，</N 后接空白再接非「>」时，\s* 的回退限于各自不相交的空白段；失败的
// 尝试每个标签名至多一次，每次至多扫到串尾

/** 自左向右删去每个 script/style 块；与 String(text).replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '') 逐字相同 */
function removeScriptStyleBlocks(text) {
    const value = String(text);
    const headRe = /<(script|style)\b/gi;
    const blockRe = /<(script|style)\b[\s\S]*?<\/\1\s*>/iy;
    const exhausted = new Set();
    let result = '';
    let copied = 0;
    let head;
    while ((head = headRe.exec(value)) !== null) {
        const name = head[1].toLowerCase();
        if (exhausted.has(name)) continue;
        blockRe.lastIndex = head.index;
        const block = blockRe.exec(value);
        if (block === null) {
            exhausted.add(name);
            continue;
        }
        result += value.slice(copied, head.index);
        copied = head.index + block[0].length;
        headRe.lastIndex = copied;
    }
    return result + value.slice(copied);
}

// stripHtml 的去注释一步。旧式为 .replace(/<!--[\s\S]*?-->/g, '')：某个「<!--」之后再无「-->」时，[\s\S]*? 从该处逐位扩展到
// 串尾、处处失配，其后每个「<!--」起点都重来一遍，耗时随这一段的长度平方增长。新式先求末个「-->」的起点 last：没有时旧式无一处
// 匹配，原样返回；否则令 end = last + 3，只对 [0, end) 执行原正则替换，再原样接上 [end, 串尾)。等价判据：起点 p 处能否匹配、
// 止于何处，只取决于 p 处是否为「<!--」与 p + 4 及其后首个「-->」的位置——last ≥ p + 4 时首个这样的「-->」不晚于 last，整段匹配
// 落在 [0, end) 之内，截取前后相同；last < p + 4 时 p + 4 及其后再无「-->」，两边都失配；p ≥ end 时其后再无「-->」，旧式在该处
// 失配，截取后的前缀里也没有这样的起点。前缀之内失配的「<!--」只能与末个「-->」重叠：「<!-->」即 p = last - 2，「<!--->」即
// p = last - 3，二者互斥；旧式在该处扫到串尾、新式扫到 end，都找不到 p + 4 及其后的「-->」，新式只多扫至多 2 个码元。故全局替换
// 逐轮取得的匹配序列相同，[end, 串尾) 在旧式里同样原样保留。线性：前缀里除这至多一处重叠起点外，每个「<!--」都一次成功，
// [\s\S]*? 只扫过自身的匹配区间，下一轮自匹配终点起算，每个码元只被扫过常数次

/** 自左向右删去「<!--」起、至其后首个不与之重叠的「-->」止的每一段；与 String(text).replace(/<!--[\s\S]*?-->/g, '') 逐字相同 */
function removeHtmlComments(text) {
    const value = String(text);
    const last = value.lastIndexOf('-->');
    if (last < 0) return value;
    const end = last + 3;
    return value.slice(0, end).replace(/<!--[\s\S]*?-->/g, '') + value.slice(end);
}

// stripHtml 的去标签一步。旧式为 .replace(/<[^>]*>/g, '')：某个「<」之后再无「>」时，[^>]* 从该处扫到串尾再逐位回退、处处
// 失配，其后每个「<」起点都重来一遍，耗时随这一段的长度平方增长。新式先求末个「>」的下一位 end，只对 [0, end) 执行原正则替换，
// 再原样接上 [end, 串尾)。等价判据：起点 p 处能否匹配、止于何处，只取决于 p 处是否为「<」与 p 之后首个「>」的位置——p < end 且
// p 处为「<」时，end - 1 处的「>」在其后，首个「>」落在 [0, end) 之内，截取前后相同；p ≥ end 时其后再无「>」，旧式在该处失配，
// 截取后的前缀里也没有这样的起点。故全局替换逐轮取得的匹配序列相同，[end, 串尾) 在旧式里同样原样保留。线性：前缀里每个「<」
// 之后都有「>」，[^>]* 止于首个「>」即一次成功、不回退，下一轮自该「>」之后起算，每个码元只被扫过常数次

/** 自左向右删去「<」至其后首个「>」的每一段（含两端）；与 String(text).replace(/<[^>]*>/g, '') 逐字相同 */
function removeHtmlTags(text) {
    const value = String(text);
    const end = value.lastIndexOf('>') + 1;
    return value.slice(0, end).replace(/<[^>]*>/g, '') + value.slice(end);
}

module.exports = {
    stripHtml, removeScriptStyleBlocks, removeHtmlComments, removeHtmlTags,
    sanitizeFolderName, stripExt, normalizeAuthor, collectText,
    getExtFromContentType, getExtFromUrl, ensureDir,
};
