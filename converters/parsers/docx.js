/**
 * DOCX → IR
 *
 * 流程：读入 buffer → inspectOoxml（OOXML 预检信息）→ extractMath（OMML 换成哨兵 run）
 *       → prepareLayout（首行缩进、制表符、题注换成标记 run，图片 alt 前写序号并记下显示尺寸）
 *       → markSections（多分节且页眉有文字时，每节起点插入一个哨兵段）
 *       → mammoth（docx → HTML，图片经 convertImage 截获为 Buffer，下划线经 styleMap 'u => u' 保留）
 *       → turndown('word')（HTML → Markdown）→ remark-parse + remark-gfm（Markdown → mdast）
 *       → restoreMath（哨兵换回 math 节点）→ liftInlineHtml（<u> 等 → 节点）
 *       → applyImageData（显示尺寸与图片角色写回图片）
 *       → restoreMarkers（标记 → data.indent / data.role / \t）→ markCaptions（大图拆段、图注定角色）
 *       → applySections（消去哨兵段，顶层节点写 data.section）
 *
 * 契约：
 *   - async parse({ path } | { buffer }, ctx) → MarkFlowDocument{ ir, data, assets, warnings, meta }
 *   - 不写盘、不打印：mammoth 警告、图片读取失败、预检与公式抽取异常一律推入 warnings
 *   - 图片按出现顺序编号为 images/image_N.ext（N 从 1 起），IR 中 image 节点 url 与 assets 一一对应；
 *     取得到 wp:extent / VML 尺寸的图片带 data.display（px）与 data.displayWidthMm / displayHeightMm
 *     （Word 中的物理显示尺寸，毫米浮点不取整），浮动图另带 data.floating
 *   - 图片角色写入 data.role（见 parsers/docx-chemistry）：化学结构式按四条判据判为 'chemistry'，
 *     替换文字带 markflow:role= 前缀的按标记取 'formula' | 'table' | 'chemistry'；两者都不命中即不写该键。
 *     `<SIPOChemFile` 判据命中后 alt 清空，角色标记前缀连同其后的一个 `;` 从 alt 中剥离
 *   - 标题取首个有文字的 Title 样式段（不带编号的在正文中仍为普通段落，带编号的与同一编号定义下的普通段同为列表项），
 *     其次首个 <h1> 文本，否则取去扩展名的文件名
 *   - data.ooxml 为 OOXML 预检信息（采集失败时为 null），meta.sourcePath 为源文件绝对路径
 *   - meta.author 取 docProps/core.xml 的 dc:creator，经 ir/util.normalizeAuthor 归一（去首尾空白、滤掉占位名）；
 *     为空、缺失或是占位名时不设该键，front matter 随之不写 author 行
 *   - 公式一律进 IR 的 math 节点；options.math='text' 的降级由渲染器负责，解析层不降级
 *   - 段落文本本身不带全角缩进（由 md 渲染器按 data.indent 插入），专利 XML 等下游不受影响
 *   - 文档至少有两个 Word 分节且至少一节的页眉有文字时，每个顶层节点带 data.section = { index, header }
 *     （分节序号 1 起、该节生效页眉的纯文本，见 parsers/docx-sections）；否则不写该键，IR 与此前逐字节一致
 */
const path = require('path');
const fsp = require('fs/promises');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const cheerio = require('cheerio');
const { loadUnified } = require('../ir/unified-loader');
const { createDocument } = require('../ir/schema');
const { createTurndownService } = require('../ir/turndown');
const { liftInlineHtml } = require('../ir/inline-html');
const { MARKERS, restoreMarkers, stripMarkers } = require('../ir/markers');
const { markCaptions } = require('../ir/captions');
const { stripExt, getExtFromContentType, normalizeAuthor } = require('../ir/util');
const { notify, errText } = require('../util');
const { inspectOoxml } = require('./docx-ooxml');
const { extractMath, restoreMath } = require('./docx-math');
const { prepareLayout, parseImageMarker } = require('./docx-layout');
const { CHEMISTRY_ROLE, resolveImageRole } = require('./docx-chemistry');
const { markSections, applySections } = require('./docx-sections');

const DEFAULT_SOURCE_NAME = '未命名.docx';
const DEFAULT_IMAGE_MIME = 'image/png';
// 作者等核心属性所在的 OOXML 部件
const CORE_PROPS_PATH = 'docProps/core.xml';
// mammoth 默认丢弃下划线；映射为 <u> 后由 turndown 的 word profile 保留、ir/inline-html 提升为 underline。
// mammoth 默认样式表不认 Title（封面题名常用此样式而非标题 1），标成带类名的普通段落供 extractTitle 采信；
// turndown 不理会类名，正文输出不变。style-name 按样式名匹配（不分大小写），与样式 ID（中文版 Word 为 a4 等）无关
const TITLE_CLASS = 'mf-title';
// 带编号的 Title 段按默认列表映射的同一路径输出为列表项：自定义映射排在默认映射之前、先匹配者生效，须先于普通 Title 映射截住。
// 层级 1–5 与 mammoth 默认样式表（lib/options-reader.js）一致，超出者与普通编号段一样不成列表，仍走普通 Title 映射。
// 类名放在 li 内的 span 上而非 li 本身：li 带属性后与其后下级编号段路径中的 li 属性不同，mammoth 不再合并，
// 下级列表会另起一个空列表项、打乱后续编号；span 由 turndown 按内容输出，md 中不留痕迹
const LIST_LEVELS = Object.freeze([1, 2, 3, 4, 5]);
const titleListItemPath = (listTag, level) => `${'ul|ol > li > '.repeat(level - 1)}${listTag} > li:fresh > span.${TITLE_CLASS}`;
const TITLE_LIST_MAP = LIST_LEVELS.flatMap((level) => [
    `p[style-name='Title']:ordered-list(${level}) => ${titleListItemPath('ol', level)}`,
    `p[style-name='Title']:unordered-list(${level}) => ${titleListItemPath('ul', level)}`,
]);
const STYLE_MAP = Object.freeze(['u => u', ...TITLE_LIST_MAP, `p[style-name='Title'] => p.${TITLE_CLASS}:fresh`]);
// 残留在 HTML 里的 base64 内嵌图片（正常情况下 convertImage 已截获全部图片，此处兜底）
const INLINE_BASE64_IMG_RE = /<img\b[^>]*?\bsrc="data:image\/([a-z0-9.+-]+);base64,([^"]*)"[^>]*>/gi;
// 游离在标签之外的 base64 图片文本
const STRAY_BASE64_RE = /data:image\/[^;]+;base64,[A-Za-z0-9+/=]{50,}/g;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;
// Title 样式段的文字：不带编号的在 <p class> 内，带编号的在列表项的 <span class> 内（见 STYLE_MAP）
const TITLE_P_RE = new RegExp(`<(p|span) class="${TITLE_CLASS}">([\\s\\S]*?)</\\1>`, 'g');
// 标题文字里连续的 TAB 标记（如「第一章<Tab>总则」）换成一个空格，避免与相邻文字粘连；其余标记仍整段删除
const TITLE_TAB_RE = new RegExp(`${MARKERS.TAB}+`, 'g');
// 进度百分比：parser 只报 parsing 阶段，三个节点单调递增且不超过 55（其后由调度器接管）
const PROGRESS_READ = 20;
const PROGRESS_ASSETS = 40;
const PROGRESS_IR = 55;
const HTML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/**
 * @param {{ path?: string, buffer?: Buffer }} input
 * @param {{ sourceName?: string, onProgress?: (phase: string, pct: number) => void }} ctx
 */
async function parse(input, ctx = {}) {
    const source = resolveSource(input);
    const sourceName = ctx.sourceName || (source.path ? path.basename(source.path) : DEFAULT_SOURCE_NAME);
    const assets = [];
    const warnings = [];

    notify(ctx, 'parsing', PROGRESS_READ);
    const original = source.buffer || await fsp.readFile(source.path);
    const ooxml = await inspectSafely(original, warnings);
    const { buffer, formulas } = await extractSafely(original, warnings);
    const layout = await layoutSafely(buffer, warnings);
    const sectioned = await sectionsSafely(layout.buffer, warnings);

    const displayByAsset = new Map();
    const roleByAsset = new Map();
    const rawHtml = await convertWithMammoth({ buffer: sectioned.buffer }, {
        assets, warnings, displays: layout.displays, roles: layout.roles, displayByAsset, roleByAsset,
    });
    const html = collectInlineBase64Images(rawHtml, assets, warnings);
    notify(ctx, 'parsing', PROGRESS_ASSETS);

    const title = titleText(html) || stripExt(sourceName);
    const markdown = cleanupMarkdown(createTurndownService('word').turndown(html));

    const { unified, remarkParse, remarkGfm } = await loadUnified();
    const parsed = unified().use(remarkParse).use(remarkGfm).parse(markdown);
    const restored = restoreMath(parsed, formulas);
    warnings.push(...restored.warnings);
    const lifted = applyImageData(liftInlineHtml(restored.ir, { source: 'docx' }), { displayByAsset, roleByAsset });
    const ir = applySections(markCaptions(restoreMarkers(lifted)), sectioned.sections);
    notify(ctx, 'parsing', PROGRESS_IR);

    const author = await readCoreCreator(original);
    return createDocument({
        kind: 'document',
        ir,
        data: ooxml ? { ooxml } : null,
        // 作者为空时不设该键：meta 与 front matter 均与引入作者之前逐字节一致
        meta: { title, ...(author ? { author } : {}), sourceType: 'docx', sourceName, sourcePath: source.path || null },
        assets,
        warnings,
    });
}

// docProps/core.xml 的 dc:creator（XML 实体经 cheerio 还原，再经 normalizeAuthor 去空白并滤掉占位名）。
// 作者是可选元数据：core.xml 缺失、字段为空、是占位名或读取失败一律按无作者处理，不记 warning
// （包体本身损坏时 mammoth 自会报错）
async function readCoreCreator(buffer) {
    try {
        const zip = await JSZip.loadAsync(buffer);
        const core = zip.file(CORE_PROPS_PATH);
        if (!core) return '';
        return normalizeAuthor(cheerio.load(await core.async('text'), { xmlMode: true })('dc\\:creator').first().text());
    } catch (err) {
        return '';
    }
}

// 预检信息采集失败不阻断解析，只记 warning
async function inspectSafely(buffer, warnings) {
    try {
        return await inspectOoxml(buffer);
    } catch (err) {
        warnings.push(`OOXML 预检信息采集失败，已跳过（${errText(err)}）`);
        return null;
    }
}

// 公式抽取失败时按无公式继续，交由 mammoth 决定后续成败
async function extractSafely(buffer, warnings) {
    try {
        return await extractMath(buffer);
    } catch (err) {
        warnings.push(`公式抽取失败，已按无公式处理（${errText(err)}）`);
        return { buffer, formulas: [] };
    }
}

// 版面预处理失败时按原样交给 mammoth：缩进、制表符与图片尺寸缺失，但正文不受影响
async function layoutSafely(buffer, warnings) {
    try {
        return await prepareLayout(buffer);
    } catch (err) {
        warnings.push(`版面信息（缩进、制表符、题注、图片尺寸）读取失败，已按原样转换（${errText(err)}）`);
        return { buffer, displays: new Map(), roles: new Map() };
    }
}

// 分节与页眉读取失败时按无分节继续：顶层节点不带 data.section，下游回落到既有的标题段与位置推定
async function sectionsSafely(buffer, warnings) {
    try {
        return await markSections(buffer);
    } catch (err) {
        warnings.push(`分节与页眉读取失败，已按无分节处理（${errText(err)}）`);
        return { buffer, sections: [] };
    }
}

function resolveSource(input) {
    if (input && typeof input.path === 'string' && input.path) return { path: path.resolve(input.path) };
    if (input && Buffer.isBuffer(input.buffer)) return { buffer: input.buffer };
    throw new Error('parsers/docx 需要 input.path（.docx 文件路径）或 input.buffer');
}

// ---------- mammoth 转换 ----------

/**
 * 图片 alt 里的序号标记（docx-layout 写入）在此取出并还原原 alt，据此把显示尺寸与 OOXML 侧的角色
 * 登记到资产名上；另两条化学式判据（替换文字、EMF 字节）在此就地判定（见 parsers/docx-chemistry）
 */
async function convertWithMammoth(source, { assets, warnings, displays, roles, displayByAsset, roleByAsset }) {
    const options = {
        styleMap: [...STYLE_MAP],
        convertImage: mammoth.images.imgElement(async (image) => {
            const { index, alt: rawAlt } = parseImageMarker(image.altText);
            // 角色标记与 SIPOChemFile 前缀都写在替换文字里，先只按文本判一次：
            // 图片读不出时也不让这些前缀（尤其是可长达数十 KB 的 CML）流进 alt
            const textOnly = resolveImageRole({ alt: rawAlt });
            let buffer;
            try {
                buffer = await image.readAsBuffer();
            } catch (err) {
                warnings.push(`图片读取失败，已跳过（${errText(err)}）`);
                return { src: '', alt: textOnly.alt };
            }
            if (!buffer || buffer.length === 0) {
                warnings.push('遇到空图片，已跳过');
                return { src: '', alt: textOnly.alt };
            }
            const name = pushAsset(assets, buffer, image.contentType);
            const display = index === null ? null : displays.get(index);
            if (display && display.width >= 1) displayByAsset.set(name, display);
            const { role, alt } = resolveImageRole({
                alt: rawAlt,
                buffer,
                mime: image.contentType,
                ooxmlChemistry: index !== null && roles.get(index) === CHEMISTRY_ROLE,
            });
            if (role) roleByAsset.set(name, role);
            return { src: name, alt };
        }),
    };

    const result = await mammoth.convertToHtml(source, options);
    for (const message of result.messages || []) {
        warnings.push(`mammoth ${message.type || 'warning'}: ${message.message}`);
    }
    return result.value || '';
}

function pushAsset(assets, buffer, contentType) {
    const mime = normalizeMime(contentType);
    const name = `images/image_${assets.length + 1}${getExtFromContentType(mime)}`;
    assets.push({ name, buffer, mime });
    return name;
}

function normalizeMime(contentType) {
    const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (!mime) return DEFAULT_IMAGE_MIME;
    return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

// ---------- IR 后处理 ----------

// 资产名 → 显示尺寸与角色，写回 image 节点的 data.display（px）、data.displayWidthMm / displayHeightMm
// （毫米，浮点不取整）与 data.role；浮动图另记 data.floating。各项取不到即不写该键。不改动入参
function applyImageData(node, maps) {
    if (!node || typeof node !== 'object' || (maps.displayByAsset.size === 0 && maps.roleByAsset.size === 0)) return node;
    if (node.type === 'image') return withImageData(node, maps);
    if (!Array.isArray(node.children)) return node;
    const children = node.children.map((child) => applyImageData(child, maps));
    return children.some((child, i) => child !== node.children[i]) ? { ...node, children } : node;
}

function withImageData(node, { displayByAsset, roleByAsset }) {
    const size = displayByAsset.get(node.url);
    const role = roleByAsset.get(node.url);
    if (!size && !role) return node;
    const data = { ...(node.data || {}) };
    if (size) {
        const display = { width: size.width };
        if (size.height >= 1) display.height = size.height;
        display.unit = 'px';
        display.source = 'docx';
        data.display = display;
        if (size.floating) data.floating = true;
        if (size.widthMm > 0) data.displayWidthMm = size.widthMm;
        if (size.heightMm > 0) data.displayHeightMm = size.heightMm;
    }
    if (role) data.role = role;
    return { ...node, data };
}

// ---------- HTML 后处理 ----------

// 把残留的 base64 内嵌图片收进 assets，并清掉游离的 base64 文本
function collectInlineBase64Images(html, assets, warnings) {
    return html
        .replace(INLINE_BASE64_IMG_RE, (tag, format, base64) => {
            const buffer = Buffer.from(base64, 'base64');
            if (buffer.length === 0) {
                warnings.push('遇到空的内嵌 base64 图片，已移除');
                return '';
            }
            const name = pushAsset(assets, buffer, `image/${format}`);
            return tag.replace(/\bsrc="[^"]*"/i, `src="${name}"`);
        })
        .replace(STRAY_BASE64_RE, '');
}

// 标题最终文本：TAB 标记（连续多个算一处）换成一个空格，其余标记删除，折叠空白后掐头去尾
function titleText(html) {
    const withSpaces = extractTitle(html).replace(TITLE_TAB_RE, ' ');
    return stripMarkers(withSpaces).replace(/\s+/g, ' ').trim();
}

// Title 样式段中首个有文字的优先（只含版面标记的不算），其次首个 <h1>
function extractTitle(html) {
    for (const matched of html.matchAll(TITLE_P_RE)) {
        const text = htmlText(matched[2]);
        if (stripMarkers(text).trim()) return text;
    }
    const matched = H1_RE.exec(html);
    return matched ? htmlText(matched[1]) : '';
}

function htmlText(inner) {
    const text = inner.replace(/<[^>]+>/g, '')
        .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => HTML_ENTITIES[entity] || entity);
    return text.replace(/\s+/g, ' ').trim();
}

// Markdown 清理（源自 旧版 word.js:101-110）
// 注：legacy 还会删除任意 100 字符以上的 [A-Za-z0-9+/=] 连续串以清理 base64 残留；
//     本实现已在 HTML 阶段精确收编全部内嵌图片，该规则会误删正文长串，故不再沿用。
function cleanupMarkdown(markdown) {
    return String(markdown || '')
        .replace(/!\[[^\]]*\]\(data:image\/[^)]+\)/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

module.exports = { parse };
