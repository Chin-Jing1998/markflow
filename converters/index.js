/**
 * 转换调度器（MarkFlow）
 *
 * 职责：输入识别 → 懒加载 parser → 解析为 IR → 标题/命名 → 图片归一 → 栅格化 → 懒加载 renderer → 落盘。
 * 本文件顶层不加载任何 parser/renderer/重依赖，也不探测 soffice 或 PDF 后端
 * （运行时能力由调用方传入 listTargets；test/index.test.js 守护「require 调度器零重依赖」）。
 *
 * 三段式 API（桌面端预览「解析一次、按选项重渲染」即依赖此拆分）：
 *   parseDocument({ input, target?, options?, allowPrivateNetwork?, onProgress? })
 *     → { source, doc, name, title, options, backends: { pdfParser, raster } }
 *   renderDocument(doc, target, options?, { imageMode? } = {})
 *     → { files, assets, extras, warnings, title, layout }（title 为渲染器给出的标题，无则 null）
 *   renderBundleSidecars(doc, { name?, options? } = {})
 *     → { json: string, contentList: string }：bundle 的 {name}.json 与 {name}_content_list.json 正文，
 *     转档 bundle 渲染与桌面端「编辑后保存 / 导出」共用，保证两处产出一致。content_list 的 img_path 直接取
 *     IR 图片节点的 url，调用方负责让 url 为产物内的真实相对路径；MinerU 来源改用其原件 content_list
 *     （附属文件 {name}_content_list.json，已补 display），图片路径按 sourcePath → url 改写
 *   writeDocument({ rendered, target, outputDir, name, clean? })
 *     → { outputPath, outputs, extras }；clean 为 true 时 folder 布局先清理产物目录中的旧 MarkFlow 产物
 *     （范围见 output.js），single 布局本就覆盖同一文件、不清理
 *   convert({ input: { path? | url? }, target, outputDir, options?, onProgress?, allowPrivateNetwork?, nameRegistry?, order?, clean?, skipExisting? }) 依次组合三者
 *     → { ok, target, name, title, sourceType, outputPath, outputs, imagesCount, warnings, options, extras, backends }
 *   input.path 一般是文件；唯一受理的目录是「专利五书目录」（converters/scan.js 的 isPatentBundleDir），整个目录
 *   作为一项 xml 输入交 parsers/xml 合并导入，产物名取目录名（不去扩展名——目录名里的点不是扩展名）。
 *   clean 与 skipExisting 为写盘策略参数（非用户 options：不经 normalizeOptions、不回显到结果的 options；缺省 false，
 *   非布尔值抛中文错误）：
 *     skipExisting 为 true 且主产物已存在即跳过本次转换——主产物 folder 布局为 {outputDir}/{name}/{name}.{ext}、
 *     single 布局为 {outputDir}/{name}.{ext}（xml 的 patent profile 不产出 {name}.xml，主产物为 {name}.zip）。
 *     本地文件的产物名只取决于文件名，故先登记产物名再判定，命中即不解析、不改动任何文件、不发进度事件；网页的
 *     产物名取决于标题，只能解析后再判定。跳过的结果与成功结果同形，另带 skipped: true，outputs 只列主产物，
 *     title 在未解析时为 null，imagesCount 为 0。跳过的任务照常占用登记表中的名字，故批内后续同名任务的最终名
 *     与首轮一致。
 *     clean 为 true 时写入前清理该产物目录中的旧 MarkFlow 产物。两者同时为 true：已存在即跳过（不清理），
 *     否则清理后照常转换。
 *   nameRegistry 与 order 为服务层内部参数（非用户 options）：批量转换时由 runConversion 传入同一张
 *   converters/naming.js 的登记表与本任务的批内序号，使同批内派生出同名产物的任务改名而不互相覆盖，
 *   且最终名只由序号决定（与解析快慢无关）；不传登记表即用派生名原样落盘，行为与引入登记表之前一致。
 *   options 经 converters/options.js 归一（非法值抛中文错误），归一之后按输入类型补默认值
 *   （applyPatentImportDefaults：专利五书 XML 输入且未显式给出中文字体时取宋体，依据见 options.js），
 *   再透传 parser ctx（ctx.options）与渲染器；
 *   返回值中的 options 为脱敏后的生效值（mineru.token 置 null），extras 为已落盘附属文件的相对路径。
 *
 * 渲染器契约 v3：render(doc, options, { imageMode }) → string | Buffer
 *   | { files: { '<posix 相对路径>': string|Buffer }, assets?, extras?, warnings?, omitDocAssets?, title? }
 *   string/Buffer 视为主产物 {name}.<ext>（ext 取自 targets.js 的规则表，string 按 utf8）；files 的键可用 {name} 占位符；
 *   warnings（string[]）并入 convert 结果的 warnings；omitDocAssets 为 true 时不再合并 doc.assets，落盘的图片
 *   只取渲染器返回的 assets（patent profile 把图片改名为 <表格代码>_<序号> 并放进各书目录即依赖此项）；title 为非空字符串时
 *   覆盖结果信封的 title（patent profile 给出发明名称），parseDocument 的标题解析不受影响。
 *   layout 'single' 的目标只允许一个文件，经 output.writeSingle 落盘为 {outputDir}/{name}.<ext>；
 *   layout 'folder' 的经 output.writeFolder 落盘到 {outputDir}/{name}/，outputs 形状见 output.js。
 *   imageMode 由目标推导（pdf → 'file'，html → 'inline' 或 'relative'，其余 'relative'），调用方可显式覆盖。
 *   渲染器模块尚未提供（如阶段 2 才有的 xml）时抛中文错误。
 *
 * 固定管线（parseDocument 内）：parser → 标题/命名 → normalizeImages（assets/image-normalize；目标为 bundle 时
 *   跳过，images/ 存与原件逐字节一致的原图）→ rasterizeNodes（raster/rasterize-nodes，仅当 options.math === 'image'
 *   或 patent profile 命中时）。两者均经 moduleLoader 懒加载，阶段 1A / 1C 只替换各自模块文件，不改本文件。
 *
 * bundle 产物（MinerU 式结果包）：{name}.md（带 front matter）+ {name}.json + {name}_content_list.json + images/（原图），
 *   MinerU 来源另有 {name}_content_list_v2.json、{name}_model.json、{name}_layout.json、{name}_origin.pdf。
 *   renderBundle 依次：restoreOriginals（先解析后导出的路径上把已归一的图片换回原图）→ md 渲染 → renderBundleSidecars
 *   → finalizeMineruExtras（附属 JSON 中的 MinerU 哈希图名改写为 images/image_N.*，layout 用裸名）；
 *   EMF / WMF / TIFF 保留原件并告警「多数 Markdown 查看器无法显示」。其它目录布局目标的附属 JSON 同样改写图片路径。
 *
 * 进度协议：onProgress(phase, pct) 依次收到 ('parsing',20) → ('rendering',60) → ('writing',90) → ('writing',100)；
 * parser 内部的细粒度进度会插在前两者之间，且一律归一为 phase='parsing'、pct 钳制到 [0,55] 并在同一次转换内
 * 单调不减（见 buildParserContext）。失败一律 throw（中文错误信息）。
 */
const path = require('path');
const { sanitizeFolderName, stripExt, collectText } = require('./ir/util');
const { statOrNull, toBuffer, isFile } = require('./util');
const {
    detectInputType, assertTargetAllowed, getTargetRule, listTargets,
    SUPPORTED_EXTENSIONS, REMOTE_URL_RE, BUNDLE_DIR_TYPE,
} = require('./targets');
const { normalizeOptions, applyPatentImportDefaults, redactOptions } = require('./options');
const { prependFrontMatter } = require('./web/frontmatter');
const output = require('./output');
const { runBatch } = require('./batch');
const {
    CONTENT_LIST_NAME, findOriginalContentList, imagePathMap, rewriteJsonText, finalizeMineruExtras,
} = require('./bundle-sidecars');

// 需要内嵌远程图片的目标
const BINARY_TARGETS = Object.freeze(['docx', 'pdf']);
const REMOTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TITLE = '未命名文档';
const PROGRESS = Object.freeze({ PARSING: 20, RENDERING: 60, WRITING: 90, DONE: 100 });
// parser 上报进度的允许区间：上界须低于 RENDERING，避免解析阶段的百分比越过渲染阶段
const PARSER_PCT = Object.freeze({ MIN: 0, MAX: 55 });
const { NAME_TOKEN } = output;
// bundle 保留原图时，这些格式多数 Markdown 查看器无法显示，须告警
const VIEWER_UNFRIENDLY_MIMES = new Set(['image/tiff', 'image/emf', 'image/x-emf', 'image/wmf', 'image/x-wmf', 'application/emf', 'application/x-msmetafile', 'windows/metafile']);
const VIEWER_UNFRIENDLY_EXT_RE = /\.(?:tiff?|emf|wmf)$/i;

const asArray = (value) => (Array.isArray(value) ? value : []);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);

// ============================================================
// convert：三段组合
// ============================================================

async function convert(params = {}) {
    const {
        input, target, outputDir, onProgress, allowPrivateNetwork = false, options: rawOptions, nameRegistry, order,
        clean = false, skipExisting = false,
    } = params || {};
    assertBooleanParam(clean, 'clean');
    assertBooleanParam(skipExisting, 'skipExisting');
    const source = await resolveSource(input);
    await assertOutputDir(outputDir);
    assertTargetAllowed(target, source.type);
    const options = applyPatentImportDefaults(normalizeOptions(rawOptions), source.type);
    const emit = createProgressEmitter(onProgress);
    const skipCheck = skipExisting === true ? { outputDir, target, options, source } : null;

    // skipExisting 下本地文件的产物名只取决于文件名：先登记再查主产物，命中即跳过解析（PDF 云端解析等开销一并省去）
    let name = null;
    if (skipCheck && source.type !== 'url') {
        name = await claimOutputName({ nameRegistry, order, target, name: resolveOutputName(source, ''), source });
        const skipped = await skipIfExisting({ ...skipCheck, name, title: null });
        if (skipped) return skipped;
    }
    const parsed = await parseResolved({ source, target, options, allowPrivateNetwork, emit });
    if (name === null) {
        // 名字登记在解析之后（网页标题要解析后才知道）、落盘之前；登记表按批内序号排队，
        // 故此处可能短暂等待前序任务登记完毕，等待时间不超过前序任务的解析耗时
        name = await claimOutputName({ nameRegistry, order, target, name: parsed.name, source });
        const skipped = skipCheck ? await skipIfExisting({ ...skipCheck, name, title: parsed.title, backends: parsed.backends }) : null;
        if (skipped) return skipped;
    }
    emit('rendering', PROGRESS.RENDERING);
    const rendered = await renderDocument(parsed.doc, target, options);
    emit('writing', PROGRESS.WRITING);
    const written = await writeDocument({ rendered, target, outputDir, name, clean: clean === true });
    emit('writing', PROGRESS.DONE);

    return {
        ok: true, target, name, title: rendered.title || parsed.title, sourceType: source.type,
        outputPath: written.outputPath, outputs: written.outputs,
        imagesCount: rendered.assets.length,
        warnings: [...asArray(parsed.doc.warnings), ...asArray(rendered.warnings)],
        options: redactOptions(options),
        extras: written.extras,
        backends: parsed.backends,
    };
}

// 交登记表裁决最终产物名。未传登记表——单次转换、桌面端预览与既有调用方——原样沿用派生名，
// 行为与引入登记表之前完全一致；本文件不 require naming.js，登记表由服务层注入。
// 落盘形态（layout 与主产物扩展名）取自 targets.js 的规则表，登记表据此分槽，
// 使 single 布局的 {name}.{ext} 与 folder 布局的 {name}/ 互不占位
async function claimOutputName({ nameRegistry, order, target, name, source }) {
    if (!nameRegistry || typeof nameRegistry.claim !== 'function') return name;
    const { layout, ext } = getTargetRule(target);
    const claimed = await nameRegistry.claim({ name, source, order, layout, ext });
    if (typeof claimed !== 'string' || !claimed.trim()) throw new Error('产物名登记表返回了无效的产物名');
    return claimed;
}

// clean / skipExisting 是写盘策略参数，不经 normalizeOptions；省略与 null 视为 false，
// 其余非布尔值直接报错，以免 'false' 一类字符串被当成真值
function assertBooleanParam(value, key) {
    if (value === undefined || value === null || typeof value === 'boolean') return;
    throw new Error(`参数 ${key} 须为布尔值（true/false），实际：${String(value)}`);
}

// 主产物：folder 布局为 {outputDir}/{name}/{name}.{ext}，single 布局为 {outputDir}/{name}.{ext}；ext 取自规则表，
// 唯 xml 的 patent profile 不产出 {name}.xml，以五书与图片打成的 {name}.zip 为主产物。
// outputsKey 与落盘路径一致：single 布局取目标名（见 writeDocument），folder 布局取扩展名（见 output.js）
function mainProductOf({ outputDir, target, name, options }) {
    const { layout, ext: ruleExt } = getTargetRule(target);
    const ext = target === 'xml' && options.xml.profile === 'patent' ? 'zip' : ruleExt;
    const baseDir = path.resolve(outputDir);
    if (layout === 'single') {
        const file = path.join(baseDir, `${name}.${ext}`);
        return { file, outputPath: file, outputsKey: target };
    }
    const dir = path.join(baseDir, name);
    return { file: path.join(dir, `${name}.${ext}`), outputPath: dir, outputsKey: ext };
}

// skipExisting：主产物已存在即返回跳过结果（与成功结果同形，另带 skipped: true；未渲染，故 outputs 只列主产物、
// imagesCount 为 0、warnings 与 extras 为空），否则返回 null 表示照常转换
async function skipIfExisting({ outputDir, target, options, source, name, title, backends }) {
    const main = mainProductOf({ outputDir, target, name, options });
    if (!(await isFile(main.file))) return null;
    return {
        ok: true, skipped: true, target, name, title, sourceType: source.type,
        outputPath: main.outputPath, outputs: { [main.outputsKey]: main.file },
        imagesCount: 0, warnings: [], options: redactOptions(options), extras: [],
        backends: backends || { pdfParser: null, raster: null },
    };
}

// ============================================================
// parseDocument
// ============================================================

/**
 * 解析输入为 IR 并跑完固定管线。target 可选：给出时只有 docx/pdf 目标为 md 输入提供远程图片下载器，
 * 且 patent profile 的表格/公式栅格化只在目标为 xml 时生效；省略（桌面端预览）时两者都按最大保真启用。
 */
async function parseDocument({ input, target, options: rawOptions, allowPrivateNetwork = false, onProgress } = {}) {
    const source = await resolveSource(input);
    if (target !== undefined && target !== null) getTargetRule(target);
    const options = applyPatentImportDefaults(normalizeOptions(rawOptions), source.type);
    return parseResolved({ source, target, options, allowPrivateNetwork, emit: createProgressEmitter(onProgress) });
}

async function parseResolved({ source, target, options, allowPrivateNetwork, emit }) {
    emit('parsing', PROGRESS.PARSING);
    const parser = getParser(source.type);
    const ctx = buildParserContext({ source, target, options, allowPrivateNetwork, emit });
    const parsed = await parser.parse(source.type === 'url' ? { url: source.url } : { path: source.path }, ctx);
    if (!parsed || typeof parsed !== 'object' || !parsed.ir) throw new Error(`解析器 ${source.type} 未返回有效的 IR 文档`);

    // 标题：meta.title → 首个 H1 → 文件名（去扩展名）→ 默认值；渲染前写回 meta.title
    const rawTitle = extractRawTitle(parsed);
    const title = rawTitle || (source.type === 'url' ? '' : baseNameOf(source)) || DEFAULT_TITLE;
    const name = resolveOutputName(source, rawTitle);
    let doc = {
        ...parsed,
        meta: { ...(parsed.meta || {}), title },
        assets: asArray(parsed.assets),
        extras: asArray(parsed.extras),
        warnings: [...asArray(parsed.warnings)],
    };

    // bundle 的 images/ 存原图（字节与原件一致、不改 JFIF 密度），故不做归一；「图片格式」只作用于其它目标
    if (target !== 'bundle') doc = applyStep(doc, await getImageNormalizer().normalizeImages(doc, options), '图片归一化');
    const kinds = rasterKinds(options, target);
    let raster = null;
    if (kinds.length > 0) {
        const result = await getRasterizer().rasterizeNodes(doc, { kinds, options });
        doc = applyStep(doc, result, '栅格化');
        raster = typeof result.backend === 'string' && result.backend ? result.backend : null;
    }
    const pdfParser = typeof doc.meta.pdfParser === 'string' && doc.meta.pdfParser ? doc.meta.pdfParser : null;
    return { source, doc, name, title, options, backends: { pdfParser, raster } };
}

// 管线步骤的结果合并：取其返回的 doc（缺省沿用当前），其 warnings 追加到文档
function applyStep(doc, result, label) {
    if (!result || typeof result !== 'object') throw new Error(`${label}未返回有效结果`);
    const next = result.doc && typeof result.doc === 'object' ? result.doc : doc;
    return { ...next, warnings: [...asArray(next.warnings), ...asArray(result.warnings)] };
}

// 需要栅格的节点类型：math: 'image' → 公式；patent profile（目标为 xml 或未指定）→ 按 patent 子项追加表格/公式
function rasterKinds(options, target) {
    const kinds = new Set();
    if (options.math === 'image') kinds.add('math');
    if (options.xml.profile === 'patent' && (target === undefined || target === null || target === 'xml')) {
        if (options.xml.patent.rasterizeTables) kinds.add('table');
        if (options.xml.patent.rasterizeFormulas) kinds.add('math');
    }
    return [...kinds];
}

// → { type, path?, url?, sourceName }
async function resolveSource(input) {
    const src = input && typeof input === 'object' ? input : {};
    const hasPath = typeof src.path === 'string' && src.path.trim() !== '';
    const hasUrl = typeof src.url === 'string' && src.url.trim() !== '';
    if (hasPath === hasUrl) throw new Error('input 必须是对象，且 path 与 url 二选一');

    if (hasUrl) {
        const url = src.url.trim();
        if (!REMOTE_URL_RE.test(url)) throw new Error(`仅支持 http(s) 网址：${url}`);
        return { type: 'url', url, sourceName: url };
    }

    const filePath = src.path;
    if (!path.isAbsolute(filePath)) throw new Error(`输入路径必须是绝对路径：${filePath}`);
    const stat = await statOrNull(filePath);
    if (!stat) throw new Error(`输入文件不存在：${filePath}`);
    // 唯一受理的目录输入：专利五书目录。scan.js 只依赖 targets 与零依赖的 xml/dom，按需加载即可
    if (stat.isDirectory() && await require('./scan').isPatentBundleDir(filePath)) {
        return { type: BUNDLE_DIR_TYPE, path: filePath, sourceName: path.basename(filePath), isDirectory: true };
    }
    if (!stat.isFile()) throw new Error(`输入路径不是文件：${filePath}`);

    const type = detectInputType(filePath);
    if (type) return { type, path: filePath, sourceName: path.basename(filePath) };
    const ext = path.extname(filePath) || '(无扩展名)';
    throw new Error(`不支持的输入格式：${ext}，支持：${SUPPORTED_EXTENSIONS.join(' ')}`);
}

async function assertOutputDir(outputDir) {
    if (typeof outputDir !== 'string' || !outputDir.trim()) throw new Error('缺少输出目录 outputDir');
    const stat = await statOrNull(outputDir);
    if (!stat) throw new Error(`输出目录不存在：${outputDir}`);
    if (!stat.isDirectory()) throw new Error(`输出路径不是目录：${outputDir}`);
}

// meta.title 优先，其次首个 H1 的纯文本
function extractRawTitle(doc) {
    const metaTitle = doc.meta && typeof doc.meta.title === 'string' ? doc.meta.title.trim() : '';
    return metaTitle || firstH1Text(doc.ir);
}

// 深度优先取首个非空的 depth=1 标题文本；无此类标题返回空串
function firstH1Text(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'heading' && node.depth === 1) return collectText(node).trim();
    if (!Array.isArray(node.children)) return '';
    for (const child of node.children) {
        const text = firstH1Text(child);
        if (text) return text;
    }
    return '';
}

// 本地输入的基名：文件去扩展名；目录（专利五书目录）原样采用，目录名里的点不是扩展名
const baseNameOf = (source) => (source.isDirectory ? source.sourceName : stripExt(source.sourceName));

// 文件输入取文件名；网页输入取标题，无标题时取「主机名-时间戳」
function resolveOutputName(source, rawTitle) {
    if (source.type !== 'url') return sanitizeFolderName(baseNameOf(source));
    if (rawTitle) return sanitizeFolderName(rawTitle);
    return sanitizeFolderName(`${hostnameForFileName(source.url)}-${formatTimestamp()}`);
}

// 仅用于给无标题网页起文件名，故取不到主机名时回退为可读的 'web'，
// 与 web/extract.js 中用于站点匹配的 hostnameOf（回退空串）语义不同
function hostnameForFileName(url) {
    try { return new URL(url).hostname || 'web'; } catch (err) { return 'web'; }
}

// 本地时间 YYYYMMDD-HHmmss
function formatTimestamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    return `${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

// ============================================================
// renderDocument
// ============================================================

async function renderDocument(doc, target, rawOptions, { imageMode } = {}) {
    if (!doc || typeof doc !== 'object' || !doc.ir) throw new Error('renderDocument 需要有效的 IR 文档');
    const rule = getTargetRule(target);
    // 桌面端按扁平选项重新构造 options 后才调本函数（不经 convert / parseDocument），输入类型只能从 doc.meta 读
    const options = applyPatentImportDefaults(normalizeOptions(rawOptions), doc.meta && doc.meta.sourceType);
    const mode = imageMode || defaultImageMode(target, options);
    const rendered = target === 'bundle'
        ? await renderBundle(doc, options, mode)
        : normalizeRendered(await getRenderer(target).render(doc, options, { imageMode: mode }), target, rule);
    const count = Object.keys(rendered.files).length;
    if (rule.layout === 'single' && count !== 1) throw new Error(`目标 ${target} 为单文件布局，渲染器却产出了 ${count} 个文件`);
    // 附属 JSON 里的来源图片路径（MinerU 哈希图名）改写为产物图片路径；bundle 已自行处理（omitDocExtras）
    const docExtras = rendered.omitDocExtras ? [] : finalizeMineruExtras(asArray(doc.extras), doc);
    return {
        files: rendered.files,
        // 渲染器声明 omitDocAssets（如 patent profile 把图片改名后放进各书目录）时，文档资产以其返回的 assets 为准
        assets: [...(rendered.omitDocAssets ? [] : asArray(doc.assets)), ...asArray(rendered.assets)],
        extras: [...docExtras, ...asArray(rendered.extras)],
        warnings: asArray(rendered.warnings),
        // 渲染器给出非空 title（patent profile 的发明名称）时覆盖结果信封的标题；解析阶段的 title 不变
        title: rendered.title || null,
        layout: rule.layout,
    };
}

/**
 * MinerU 式结果包：{name}.md + {name}.json + {name}_content_list.json + images/（原图）+ 附属文件。
 * Markdown 产物统一带 YAML front matter，便于知识库按元数据检索；docx/pdf 这类单文件目标不加，
 * 否则 YAML 会变成正文里的一段文字
 */
async function renderBundle(doc, options, imageMode) {
    const restored = restoreOriginalImages(doc);
    const md = await getRenderer('md').render(restored, options, { imageMode });
    const sidecars = await renderBundleSidecars(restored, { options });
    const original = findOriginalContentList(restored.extras);
    const extras = finalizeMineruExtras(asArray(restored.extras).filter((extra) => extra !== original), restored);
    return {
        files: {
            [`${NAME_TOKEN}.md`]: prependFrontMatter(String(md), restored.meta),
            [`${NAME_TOKEN}.json`]: sidecars.json,
            [CONTENT_LIST_NAME]: sidecars.contentList,
        },
        assets: asArray(restored.assets),
        extras,
        warnings: viewerWarnings(restored.assets),
        omitDocAssets: true,
        omitDocExtras: true,
    };
}

/** bundle 旁路文件正文（契约见文件头）；name 仅用于识别已替换占位符的 MinerU content_list 附属文件名 */
async function renderBundleSidecars(doc, { name, options: rawOptions } = {}) {
    if (!doc || typeof doc !== 'object' || !doc.ir) throw new Error('renderBundleSidecars 需要有效的 IR 文档');
    const options = normalizeOptions(rawOptions);
    // 来源包内的原始图片路径（MinerU 的哈希图名）一律改写为产物路径，旁路文件里不留指向不存在文件的引用
    const pathMap = imagePathMap(doc);
    const json = rewriteJsonText(String(await getRenderer('json').render(doc, options, { imageMode: 'relative' })), pathMap);
    const original = findOriginalContentList(doc.extras, name);
    const contentList = original
        ? rewriteJsonText(toBuffer(original.buffer).toString('utf8'), pathMap)
        : String(await getRenderer('content-list').render(doc, options, { imageMode: 'relative' }));
    return { json, contentList };
}

// 先解析后导出的路径上（桌面端预览按无目标解析，图片已归一）把资产换回原图；模块未提供还原时原样返回
function restoreOriginalImages(doc) {
    const normalizer = getImageNormalizer();
    return typeof normalizer.restoreOriginals === 'function' ? normalizer.restoreOriginals(doc) : doc;
}

function viewerWarnings(assets) {
    return asArray(assets)
        .filter((asset) => asset && (VIEWER_UNFRIENDLY_MIMES.has(String(asset.mime || '').toLowerCase()) || VIEWER_UNFRIENDLY_EXT_RE.test(String(asset.name || ''))))
        .map((asset) => `图片 ${asset.name} 保持原格式：多数 Markdown 查看器无法显示`);
}

// 渲染器返回值归一为 { files, assets, extras, warnings, omitDocAssets }
function normalizeRendered(result, target, rule) {
    if (typeof result === 'string') return { files: { [`${NAME_TOKEN}.${rule.ext}`]: result } };
    const binary = toBuffer(result);
    if (binary) return { files: { [`${NAME_TOKEN}.${rule.ext}`]: binary } };
    if (isPlainObject(result) && isPlainObject(result.files) && Object.keys(result.files).length > 0) {
        for (const [key, content] of Object.entries(result.files)) {
            if (typeof content !== 'string' && !toBuffer(content)) {
                throw new Error(`渲染器 ${target} 的产物 ${key} 须为字符串或 Buffer`);
            }
        }
        return {
            files: result.files, assets: asArray(result.assets), extras: asArray(result.extras),
            warnings: asArray(result.warnings).filter((item) => typeof item === 'string'),
            omitDocAssets: result.omitDocAssets === true,
            title: typeof result.title === 'string' && result.title.trim() ? result.title.trim() : null,
        };
    }
    throw new Error(`渲染器 ${target} 返回了不支持的产物类型（须为字符串、Buffer 或 { files }）`);
}

function defaultImageMode(target, options) {
    if (target === 'pdf') return 'file';
    if (target === 'html') return options.html.inlineImages ? 'inline' : 'relative';
    return 'relative';
}

// ============================================================
// writeDocument
// ============================================================

async function writeDocument({ rendered, target, outputDir, name, clean = false } = {}) {
    const rule = getTargetRule(target);
    await assertOutputDir(outputDir);
    if (!rendered || !isPlainObject(rendered.files)) throw new Error('writeDocument 需要 renderDocument 的结果');

    // single 布局本就覆盖写同一个文件，没有旧产物残留，clean 只作用于 folder 布局的产物目录
    if (rule.layout === 'single') {
        const entries = Object.entries(rendered.files);
        if (entries.length !== 1) throw new Error(`目标 ${target} 为单文件布局，只能写出一个文件（实际 ${entries.length} 个）`);
        const content = entries[0][1];
        const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : toBuffer(content);
        if (!buffer) throw new Error(`目标 ${target} 的产物须为字符串或 Buffer`);
        const filePath = await output.writeSingle({ outputDir, name, ext: rule.ext, buffer });
        // 单文件目标没有附属文件的去处，extras 不落盘
        return { outputPath: filePath, outputs: { [target]: filePath }, extras: [] };
    }

    const extras = asArray(rendered.extras);
    const written = await output.writeFolder({ outputDir, name, files: rendered.files, assets: asArray(rendered.assets), extras, clean: clean === true });
    // 附属文件名中的 {name} 已由 writeFolder 替换，这里返回实际落盘的相对路径
    return { outputPath: written.outputPath, outputs: written.outputs, extras: extras.map((item) => String(item.name).split(NAME_TOKEN).join(name)) };
}

// ============================================================
// parser 上下文
// ============================================================

function buildParserContext({ source, target, options, allowPrivateNetwork, emit }) {
    // parser 各自命名的 phase（fetching / assets / ir 等）对外无意义，一律归一为 'parsing'；
    // pct 钳制到 [MIN, MAX] 并记住上次取值，低于上次的回退进度直接丢弃
    let lastPct = -Infinity;
    // 远程图片只为需要内嵌的二进制目标下载；目标未知（桌面端预览）时同样下载以保全保真度
    const wantsRemote = target === undefined || target === null || BINARY_TARGETS.includes(target);
    return {
        sourceName: source.sourceName,
        options,
        // 只接受 (phase: string, pct: number) 形态的进度，其它形态一律丢弃
        onProgress: (phase, pct) => {
            if (typeof phase !== 'string' || !Number.isFinite(pct)) return;
            const clamped = Math.min(Math.max(pct, PARSER_PCT.MIN), PARSER_PCT.MAX);
            if (clamped < lastPct) return;
            lastPct = clamped;
            emit('parsing', clamped);
        },
        allowPrivateNetwork: Boolean(allowPrivateNetwork),
        fetchRemote: wantsRemote ? createRemoteFetcher(allowPrivateNetwork) : undefined,
    };
}

// 远程图片下载器：经 net/fetch-guard 限长抓取，SSRF 校验在守卫内完成。
// 走 moduleLoader 而非直接 require，以便测试注入桩实现（同 parser/renderer 的加载路径）
function createRemoteFetcher(allowPrivateNetwork) {
    const { fetchBinary } = moduleLoader('./net/fetch-guard');
    return (url) => fetchBinary(url, { maxBytes: REMOTE_IMAGE_MAX_BYTES, allowPrivateNetwork: Boolean(allowPrivateNetwork) });
}

// 进度回调自身的异常不影响转换
function createProgressEmitter(onProgress) {
    if (typeof onProgress !== 'function') return () => {};
    return (phase, pct) => { try { onProgress(phase, pct); } catch (err) { /* 忽略 */ } };
}

// ============================================================
// 懒加载
// ============================================================

// parser/renderer/管线模块只在首次使用时 require，保证 require('./converters') 本身零重依赖
let moduleLoader = require;
const getParser = (type) => loadPart('parsers', type, 'parse', '解析器');
const getRenderer = (name) => loadPart('renderers', name, 'render', '渲染器');
const getImageNormalizer = () => loadPart('assets', 'image-normalize', 'normalizeImages', '图片归一化模块');
const getRasterizer = () => loadPart('raster', 'rasterize-nodes', 'rasterizeNodes', '栅格化模块');

function loadPart(dir, name, method, label) {
    const request = `./${dir}/${name}`;
    let mod;
    try {
        mod = moduleLoader(request);
    } catch (err) {
        // 只把「本模块自身不存在」翻译成中文提示；模块内部缺依赖等其它加载错误原样抛出
        if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(request)) {
            throw new Error(`${label} ${name} 尚未提供：模块 converters/${dir}/${name}.js 不存在`);
        }
        throw err;
    }
    if (!mod || typeof mod[method] !== 'function') throw new Error(`${label} ${name} 未导出 ${method}()`);
    return mod;
}

// 测试钩子：替换模块加载器以注入桩 parser/renderer（与 converters/soffice.js 的 _set*/_reset 约定一致）
function _setModuleLoader(fn) { moduleLoader = typeof fn === 'function' ? fn : require; }
function _reset() { moduleLoader = require; }

module.exports = {
    convert, parseDocument, renderDocument, renderBundleSidecars, writeDocument,
    listTargets, detectInputType, SUPPORTED_EXTENSIONS, runBatch,
    _setModuleLoader, _reset,
};
