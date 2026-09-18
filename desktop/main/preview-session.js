/**
 * 双栏对比预览的会话（方案 §3.4.7）：open 时解析一次并缓存，render 只重跑渲染，export 落盘并写文件库
 *
 * createPreviewSessions(deps) → { open, render, export: exportProduct, close, closeAll, sessions }
 *   deps = { grants, settings, library|null, core?, tmp?, mammoth?, log? }
 *     core 省略时懒加载 converters/index 与 converters/service，测试可整体注入桩：
 *       { parseDocument, renderDocument, writeDocument, buildOptions, redactOptions }
 *
 *   open({ path|url, type, target, options })
 *     → { sessionId, source, type, name, title, target, options, sourceView, product, warnings, backends }
 *     只调用一次 parseDocument；网页来源经 parseDocument({ input: { url } })，SSRF 守卫保持默认
 *     （桌面端永不传 allowPrivateNetwork），且全程不经 mf:paths:expand。
 *   render({ sessionId, target, options })
 *     → { sessionId, target, options, product, warnings, reparsed, changedKeys, sourceView? }
 *     仅当 REPARSE_KEYS 里的项发生变化时才重新解析（imageFormat / jpegQuality / jpegPpi / math / pdfBackend /
 *     xml profile 与 patent 子项 / mineru 各项 / raster 各项——它们都作用在解析管线上），
 *     此时连同来源栏一起重建；其余选项只重渲染，界面据此做 300 ms 防抖实时预览。
 *   export({ sessionId, outputDir? })
 *     → { outputPath, outputs, extras, warnings, libraryId, name, title, managed }
 *     以默认图片寻址重渲染后 writeDocument 落盘，再 library.upsertFromResult 写入文件库。
 *   close({ sessionId }) 先等挂起的保存与导出跑完，再撤销 sid、删除临时目录。
 *
 * 产物 Markdown 编辑（仅 bundle 目标；ipc 按 sessionId 分派到这里）：
 *   renderMarkdown({ sessionId, text? }) → { sessionId, html, warnings, gen }   首次调用时建编辑区 tempDir/edit
 *       （bundle 以 relative 寻址渲染，图片写入其中，markdown 初值为 bundle md 原文），预览图片写 tempDir/edit-view/g<gen>/
 *   saveMarkdown({ sessionId, text, force? }) → 未导出时只暂存，回 { saved:true, staged:true }；
 *       导出后已绑定到导出的 md，按 md-edit.saveMarkdownFile 原子写盘（带 mtime/size 冲突检测）
 *   importImage({ sessionId, sourcePath }) → 导入编辑区（已绑定时即导出目录）的 images/
 *   render 时若有编辑即丢弃（回包带 editDiscarded:true）；export 在 md 有改动或已绑定时走 exportEdited：
 *       md 逐字写出 + 只带被引用的图片 + 契约 renderBundleSidecars 重建旁路 json → writeDocument → 文件库，
 *       随后绑定到导出文件（回包带 boundPath）。
 *
 * 标题：每次渲染后若 renderDocument 给出非空 title（patent profile 为发明名称），即回写会话并随
 * open / render 回包下发给页头，export 写入文件库记录时用同一值；渲染器给不出时沿用解析阶段的标题。
 *
 * 令牌：MinerU 令牌由 settings.getMineruToken() 在主进程内取出、只在调 buildOptions 时注入，
 * 会话保存的 flat 选项与任何回包都不含令牌（desktop-preview-session.test.js 守护该不变量）。
 *
 * 图片寻址：会话建一个临时目录，source/ 放来源栏的图、product/ 放产物栏的图，
 * sid 授权该临时目录（PDF 来源另加该文件所在目录），渲染进程一律经 mf-asset://<sid>/… 取图，
 * 不开放任何 file:// 通道。xml 产物的图片与所属 XML 同目录（patent 五书按官方案卷结构落在
 * product/<表格代码>/ 内，img/@file 为裸文件名），故各分文件的取图基址取其所在目录；分文件另带
 * book（xml-view 按内容判定的书目）与 label（书目名 + 相对路径），主视图据 book 选说明书。
 */
const path = require('path');
const fsp = require('fs').promises;

const { errText, hostnameOf } = require('../../converters/util');
const { assertTargetAllowed, INPUT_CLASS } = require('../../converters/targets');
const { buildStyles } = require('../../converters/renderers/html-themes');
const { normalizeOptions } = require('../../converters/options');
const { sanitizeHtml } = require('./html-sanitize');
const { buildXmlView } = require('./xml-view');
const { buildMarkdownView, writeAssets, assetBaseFor, READER_THEME } = require('./reader');
const {
    renderMarkdownText, saveMarkdownFile, buildBundleSidecars, importImage: importImageFile, referencedImages,
} = require('./md-edit');
const { MAX_TEXT_BYTES } = require('./file-kinds');

const TEMP_PREFIX = 'markflow-preview-';
const SOURCE_DIRNAME = 'source';
const PRODUCT_DIRNAME = 'product';
/** 产物 Markdown 编辑区（未导出前的 md 图片与插图落在这里，不受 renderProduct 清空产物目录影响） */
const EDIT_DIRNAME = 'edit';
/** 编辑器实时预览的图片按渲染代次落在 edit-view/g<gen>/ */
const EDIT_VIEW_DIRNAME = 'edit-view';
const NAME_TOKEN = '{name}';
const PDF_PREVIEW_NAME = 'preview.pdf';
const PRECHECK_FILE = 'precheck.json';
/** xml-view 给出的书目标识：说明书那一份作产物栏主视图 */
const PRIMARY_XML_BOOK = 'description';
const MAX_SESSIONS = 3;
/** 来源栏用「结构视图」呈现（无原始版式可直转）的输入类型 */
const STRUCTURED_SOURCE_TYPES = Object.freeze(['xlsx', 'pptx', 'url']);
/** 改这些扁平选项须重新解析：它们作用在 parseDocument 的管线（图片归一、栅格化、PDF 后端）上 */
const REPARSE_KEYS = Object.freeze([
    'imageFormat', 'jpegQuality', 'jpegPpi', 'math', 'pdfBackend',
    'xmlProfile', 'patentParts', 'rasterizeTables', 'rasterizeFormulas', 'imageDpi', 'sectionDetection',
    'mineruModel', 'mineruOcr', 'mineruFormula', 'mineruTable', 'mineruLang', 'mineruTimeout', 'pageRanges',
    'rasterScale', 'rasterMaxWidth',
]);
/** 改这些扁平选项只需重渲染，界面按 300 ms 防抖实时刷新（docx/pdf 目标仍走「刷新预览」按钮） */
const LIVE_KEYS = Object.freeze([
    'theme', 'font', 'fontSize', 'lineHeight', 'contentWidth', 'spacing', 'inlineImages',
    'pageSize', 'landscape', 'xmlIndent', 'numberingStart', 'numberingWidth',
]);
/** 目标 → 是否支持实时重渲染（docx / pdf 出图慢，交给「刷新预览」按钮） */
const LIVE_TARGETS = Object.freeze(['html', 'xml', 'bundle']);

const asArray = (value) => (Array.isArray(value) ? value : []);

/** 渲染器给出的非空 title 优先（patent profile 为发明名称），否则沿用解析阶段的标题 */
const pickTitle = (rendered, fallback) => (typeof rendered === 'string' && rendered.trim() ? rendered.trim() : fallback);

function sameValue(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(asArray(a)) === JSON.stringify(asArray(b));
    return (a === undefined || a === null ? null : a) === (b === undefined || b === null ? null : b);
}

/** 前后两份扁平选项之间需要重新解析的差异键 */
const changedReparseKeys = (prev = {}, next = {}) => REPARSE_KEYS.filter((key) => !sameValue(prev[key], next[key]));

function loadCore(core) {
    return {
        parseDocument: (core && core.parseDocument) || ((params) => require('../../converters/index').parseDocument(params)),
        renderDocument: (core && core.renderDocument) || ((doc, target, options, context) => require('../../converters/index').renderDocument(doc, target, options, context)),
        writeDocument: (core && core.writeDocument) || ((params) => require('../../converters/index').writeDocument(params)),
        buildOptions: (core && core.buildOptions) || ((flat, scope) => require('../../converters/service').buildOptions(flat, scope)),
        redactOptions: (core && core.redactOptions) || ((options) => require('../../converters/options').redactOptions(options)),
    };
}

// ============================================================
// 实例
// ============================================================

function createPreviewSessions(deps = {}) {
    const { grants, settings, library = null, log = () => undefined } = deps;
    if (!grants || typeof grants.grant !== 'function') throw new Error('createPreviewSessions 需要 asset-protocol 的授权表 grants');
    if (!settings || typeof settings.get !== 'function') throw new Error('createPreviewSessions 需要设置存储 settings');
    const tmp = deps.tmp || require('../../converters/tmp');
    const core = loadCore(deps.core);
    const loadMammoth = () => deps.mammoth || require('mammoth');
    const sessions = new Map();
    let seq = 0;

    const defaultsOf = () => {
        const current = settings.get();
        return current && current.defaults ? current.defaults : {};
    };
    /**
     * 令牌只在此处注入，绝不落进 session.flat，也就绝不进入任何回包。
     * 选项按本次目标校验（见 service.buildOptions 的 targets）：只服务于其它目标的段，取值越界时跳过写入并
     * 保留该段默认值，故 docx 目标下的 9 号字不会因 html 段的 10–32 而被拒。
     */
    const optionsFor = (flat, target) => {
        const token = typeof settings.getMineruToken === 'function' ? settings.getMineruToken() : null;
        const scope = target ? { targets: [target] } : undefined;
        return core.buildOptions(token ? { ...flat, mineruToken: token } : { ...flat }, scope);
    };

    async function dispose(session) {
        if (!session) return;
        try { grants.revoke(session.sid); } catch (err) { log(`[desktop] 撤销预览授权失败：${errText(err)}`); }
        if (session.tempDir) await tmp.removeTempDir(session.tempDir);
        sessions.delete(session.id);
    }

    async function trim() {
        while (sessions.size >= MAX_SESSIONS) {
            const oldest = sessions.values().next().value;
            if (!oldest) return;
            await dispose(oldest);
        }
    }

    const require_ = (sessionId) => {
        const session = sessions.get(String(sessionId || ''));
        if (!session) throw new Error('预览会话不存在或已关闭，请重新打开预览');
        return session;
    };

    // ---------- open ----------

    async function open(payload = {}) {
        const isUrl = typeof payload.url === 'string' && payload.url.trim() !== '';
        const value = isUrl ? payload.url.trim() : path.resolve(String(payload.path || ''));
        const type = String(payload.type || (isUrl ? 'url' : ''));
        if (!type) throw new Error('预览需要给出输入类型 type');
        const target = String(payload.target || '');
        if (!target) throw new Error('预览需要给出目标格式 target');
        assertTargetAllowed(target, type);
        await trim();

        const tempDir = await tmp.makeTempDir(TEMP_PREFIX);
        const sourceDir = path.join(tempDir, SOURCE_DIRNAME);
        const productDir = path.join(tempDir, PRODUCT_DIRNAME);
        await fsp.mkdir(sourceDir, { recursive: true });
        await fsp.mkdir(productDir, { recursive: true });
        const roots = [tempDir];
        if (!isUrl && type === 'pdf') roots.push(path.dirname(value));
        const sid = grants.grant(roots);

        seq += 1;
        const session = {
            id: `preview-${Date.now().toString(36)}-${seq}`, sid, tempDir, sourceDir, productDir,
            input: isUrl ? { url: value } : { path: value },
            source: isUrl
                ? { kind: 'url', value, name: hostnameOf(value) || value, host: hostnameOf(value), type: 'url' }
                : { kind: 'file', value, name: path.basename(value), dir: path.dirname(value), type },
            type, target, flat: { ...defaultsOf(), ...(payload.options || {}) },
            parseFlat: null, doc: null, name: '', title: '', backends: null,
            // 产物 Markdown 编辑：edit 为 null 或 { original, markdown, dir, boundPath, base, gen }；
            // epoch 在每次重渲染丢弃编辑时递增，挂起的建区与保存据此作废；chain 串行化保存与导出
            edit: null, editInit: null, epoch: 0, chain: Promise.resolve(),
        };
        sessions.set(session.id, session);

        try {
            await parseInto(session);
            const sourceView = await buildSourceView(session);
            const product = await renderProduct(session);
            return describeOpen(session, sourceView, product);
        } catch (err) {
            await dispose(session);
            throw err;
        }
    }

    function describeOpen(session, sourceView, product) {
        return {
            sessionId: session.id, source: { ...session.source }, type: session.type,
            name: session.name, title: session.title, target: session.target,
            options: { ...session.flat }, live: LIVE_TARGETS.includes(session.target),
            sourceView, product, backends: session.backends,
            warnings: asArray(session.doc && session.doc.warnings),
        };
    }

    /** 唯一调用 parseDocument 的地方：open 一次，render 命中 REPARSE_KEYS 时再一次 */
    async function parseInto(session) {
        const flat = { ...session.flat };
        const parsed = await core.parseDocument({ input: session.input, options: optionsFor(flat, session.target) });
        session.doc = parsed.doc;
        session.name = parsed.name;
        session.title = parsed.title;
        session.backends = parsed.backends || null;
        session.parseFlat = flat;
        return parsed;
    }

    // ---------- 来源栏 ----------

    async function buildSourceView(session) {
        const base = `${assetBaseFor(session.sid)}${SOURCE_DIRNAME}/`;
        await resetDir(session.sourceDir);
        if (session.type === 'pdf' && session.source.kind === 'file') {
            return {
                kind: 'pdf', url: `${assetBaseFor(session.sid)}${encodeURIComponent(session.source.name)}`,
                label: '原文（内置阅读器）', structured: false,
            };
        }
        if (session.type === 'md') {
            const built = await buildMarkdownView({ filePath: session.source.value, assetBase: base, assetDir: session.sourceDir, theme: READER_THEME });
            return { ...built.view, label: '原文', structured: false };
        }
        if (session.type === 'docx') {
            const html = await docxToHtml({ input: { path: session.source.value }, dir: session.sourceDir, base, title: session.title });
            return { kind: 'html', html, label: '原文（Word 版式还原）', structured: false };
        }
        const html = await renderIrHtml(session, base, session.sourceDir);
        const label = session.type === 'url' ? '结构视图（网页正文）' : '结构视图';
        return { kind: 'html', html, label, structured: true, host: session.source.host || null, url: session.source.kind === 'url' ? session.source.value : null };
    }

    /** xlsx / pptx / url：没有可直转的原始版式，用 reader 主题把 IR 渲染成结构视图 */
    async function renderIrHtml(session, base, dir) {
        const options = normalizeOptions({ html: { theme: READER_THEME } });
        await writeAssets(dir, session.doc.assets);
        const rendered = await core.renderDocument(session.doc, 'html', options, { imageMode: { base } });
        return String(Object.values(rendered.files)[0] || '');
    }

    /** mammoth 直转（来源栏）与产物 docx 的反读（产物栏）共用：图片落 dir，正文经 html-sanitize */
    async function docxToHtml({ input, dir, base, title }) {
        const mammoth = loadMammoth();
        let index = 0;
        const convertImage = mammoth.images.imgElement(async (image) => {
            const buffer = await image.readAsBuffer().catch(() => null);
            if (!buffer || buffer.length === 0) return { src: '' };
            index += 1;
            const name = `images/image_${index}${extFromMime(image.contentType)}`;
            await writeAssets(dir, [{ name, buffer }]);
            return { src: name };
        });
        const result = await mammoth.convertToHtml(input, { convertImage });
        const styles = buildStyles(normalizeOptions({ html: { theme: READER_THEME } }).html, { theme: READER_THEME });
        const page = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(title || '')}</title><style>${styles}</style></head><body><article>${result.value || ''}</article></body></html>`;
        return sanitizeHtml(page, { baseDir: dir, assetBase: base }).html;
    }

    // ---------- 产物栏 ----------

    async function renderProduct(session) {
        assertTargetAllowed(session.target, session.type);
        const base = `${assetBaseFor(session.sid)}${PRODUCT_DIRNAME}/`;
        await resetDir(session.productDir);
        const options = optionsFor(session.flat, session.target);
        const builders = { html: productHtml, xml: productXml, docx: productDocx, pdf: productPdf, bundle: productBundle };
        const build = builders[session.target];
        if (!build) throw new Error(`预览暂不支持目标：${session.target}`);
        const built = await build(session, options, base);
        // 渲染器给出的 title（patent profile 为发明名称）覆盖解析阶段的标题，页头与导出记录据此取值；
        // 给不出时沿用解析标题。title 不进产物回包，页头一律读会话的 title 字段
        const { title, ...product } = built;
        session.title = pickTitle(title, session.title);
        return {
            target: session.target, live: LIVE_TARGETS.includes(session.target),
            ...product,
            warnings: [...asArray(session.doc.warnings), ...asArray(built.warnings)],
        };
    }

    async function productHtml(session, options, base) {
        const rendered = await core.renderDocument(session.doc, 'html', options, { imageMode: { base } });
        await writeAssets(session.productDir, rendered.assets);
        return { view: { kind: 'html', html: String(Object.values(rendered.files)[0] || '') }, files: fileNames(session, rendered), warnings: rendered.warnings, title: rendered.title };
    }

    async function productXml(session, options, base) {
        const rendered = await core.renderDocument(session.doc, 'xml', options, { imageMode: 'relative' });
        await writeAssets(session.productDir, rendered.assets);
        const parts = [];
        let precheck = null;
        for (const [rawName, content] of Object.entries(rendered.files)) {
            const name = rawName.replace('{name}', session.name);
            if (name === PRECHECK_FILE) {
                precheck = parseJson(String(content));
                continue;
            }
            if (!name.toLowerCase().endsWith('.xml')) continue;
            // 图片与所属 XML 同目录：patent 为各书的表格代码目录（100003/100003.xml 引 100003_1.jpg），
            // generic 的 XML 在产物根下，取图基址即随 XML 所在目录走
            const view = buildXmlView(String(content), { assetBase: `${base}${assetDirOf(name)}`, indent: options.xml.indent, label: name });
            parts.push({
                name, label: view.bookLabel ? `${view.bookLabel}（${name}）` : name, book: view.book,
                xml: view.xml, structuredHtml: view.structuredHtml, profile: view.profile, error: view.error,
            });
        }
        // 主视图取说明书（patent 五书里内容最全的一份，按内容判定而非文件名），generic 只有一份 XML 时即它自己
        const primaryIndex = Math.max(0, parts.findIndex((part) => part.book === PRIMARY_XML_BOOK));
        const primary = parts[primaryIndex] || null;
        return {
            view: primary
                ? { kind: 'xml', xml: primary.xml, structuredHtml: primary.structuredHtml, profile: primary.profile, parts, primary: primaryIndex, precheck }
                : { kind: 'xml', xml: '', structuredHtml: null, profile: null, parts, primary: 0, precheck },
            files: fileNames(session, rendered), warnings: rendered.warnings, title: rendered.title,
        };
    }

    async function productDocx(session, options, base) {
        const rendered = await core.renderDocument(session.doc, 'docx', options);
        const buffer = Object.values(rendered.files)[0];
        const html = await docxToHtml({ input: { buffer }, dir: session.productDir, base, title: session.title });
        return {
            view: { kind: 'html', html, quick: true, hint: '快速预览由生成的 DOCX 反读而来，版式以 Word 打开为准（需先导出）' },
            files: fileNames(session, rendered), warnings: rendered.warnings, title: rendered.title,
        };
    }

    async function productPdf(session, options, base) {
        const rendered = await core.renderDocument(session.doc, 'pdf', options);
        const buffer = Object.values(rendered.files)[0];
        await fsp.writeFile(path.join(session.productDir, PDF_PREVIEW_NAME), buffer);
        return { view: { kind: 'pdf', url: `${base}${PDF_PREVIEW_NAME}` }, files: fileNames(session, rendered), warnings: rendered.warnings, title: rendered.title };
    }

    async function productBundle(session, options, base) {
        const rendered = await core.renderDocument(session.doc, 'bundle', options, { imageMode: 'relative' });
        const mdName = Object.keys(rendered.files).find((key) => key.endsWith('.md'));
        const raw = mdName ? String(rendered.files[mdName]) : '';
        const htmlOptions = normalizeOptions({ ...options, html: { ...options.html, theme: options.html.theme } });
        const html = await core.renderDocument(session.doc, 'html', htmlOptions, { imageMode: { base } });
        await writeAssets(session.productDir, html.assets);
        return {
            view: { kind: 'md', html: String(Object.values(html.files)[0] || ''), raw },
            files: fileNames(session, rendered), warnings: rendered.warnings, title: rendered.title,
        };
    }

    const fileNames = (session, rendered) => Object.keys(rendered.files).map((key) => key.replace('{name}', session.name));

    /** 产物内相对路径 → 其所在目录的 URL 片段（带结尾斜杠；根下的文件为空串） */
    const assetDirOf = (name) => name.split('/').slice(0, -1).map((segment) => `${encodeURIComponent(segment)}/`).join('');

    // ---------- render ----------

    async function render(payload = {}) {
        const session = require_(payload.sessionId);
        const flat = { ...defaultsOf(), ...(payload.options || {}) };
        if (payload.target) {
            assertTargetAllowed(payload.target, session.type);
            session.target = payload.target;
        }
        const changedKeys = changedReparseKeys(session.parseFlat, flat);
        session.flat = flat;
        // 重渲染即丢弃产物 Markdown 的编辑（界面已先征得用户确认）；已绑定到导出文件的修改早已落盘，导出目录不动
        const editDiscarded = await discardEdit(session);
        let sourceView = null;
        if (changedKeys.length > 0) {
            await parseInto(session);
            sourceView = await buildSourceView(session);
        }
        const product = await renderProduct(session);
        return {
            sessionId: session.id, target: session.target, options: { ...session.flat },
            product, reparsed: changedKeys.length > 0, changedKeys,
            ...(sourceView ? { sourceView } : {}),
            ...(editDiscarded ? { editDiscarded: true } : {}),
            name: session.name, title: session.title, backends: session.backends,
        };
    }

    // ---------- 产物 Markdown 编辑 ----------

    const noop = () => undefined;
    const mdCore = mdCoreOf(deps.core, core);
    const editDirOf = (session) => path.join(session.tempDir, EDIT_DIRNAME);

    /** 首次调用 md 接口时建编辑区，并发调用共用同一次建区；仅 bundle 目标可编辑 */
    function ensureEdit(session) {
        if (session.edit) return Promise.resolve(session.edit);
        if (!session.editInit) {
            session.editInit = beginEdit(session).catch((err) => {
                session.editInit = null;
                throw err;
            });
        }
        return session.editInit;
    }

    /** 以 relative 寻址渲染 bundle：图片写进 tempDir/edit，markdown 初值为 bundle md 原文（含 front matter） */
    async function beginEdit(session) {
        if (session.target !== 'bundle') throw new Error('只有「MD 包」目标的产物可以编辑，请先把目标切换为 MD 包');
        const epoch = session.epoch;
        const dir = editDirOf(session);
        await resetDir(dir);
        const rendered = await core.renderDocument(session.doc, 'bundle', optionsFor(session.flat, session.target), { imageMode: 'relative' });
        await writeAssets(dir, rendered.assets);
        if (session.epoch !== epoch) throw new Error('产物已重新渲染，请重试');
        const mdName = Object.keys(rendered.files).find((key) => key.endsWith('.md'));
        const original = mdName ? String(rendered.files[mdName]) : '';
        session.edit = { original, markdown: original, dir, boundPath: null, base: null, gen: 0 };
        return session.edit;
    }

    /** 丢弃编辑：删临时编辑区与预览代次目录；已绑定时 dir 是导出目录，绝不删除 */
    async function discardEdit(session) {
        session.epoch += 1;
        session.editInit = null;
        const edit = session.edit;
        session.edit = null;
        await tmp.removeTempDir(path.join(session.tempDir, EDIT_VIEW_DIRNAME));
        if (!edit) return false;
        if (edit.dir === editDirOf(session)) await tmp.removeTempDir(edit.dir);
        return true;
    }

    /** 编辑器实时预览：baseDir 为编辑区（或已绑定的导出目录），图片按代次写 edit-view/g<gen>/，主题同产物预览 */
    async function renderMarkdown(payload = {}) {
        const session = require_(payload.sessionId);
        const edit = await ensureEdit(session);
        const text = typeof payload.text === 'string' ? payload.text : edit.markdown;
        edit.gen += 1;
        const gen = edit.gen;
        const viewRoot = path.join(session.tempDir, EDIT_VIEW_DIRNAME);
        const options = optionsFor(session.flat, session.target);
        const built = await renderMarkdownText({
            text, baseDir: edit.dir, sourceName: `${session.name}.md`,
            assetDir: path.join(viewRoot, `g${gen}`), assetBase: `${assetBaseFor(session.sid)}${EDIT_VIEW_DIRNAME}/g${gen}/`,
            theme: options.html.theme, options, core: mdCore,
        });
        if (gen > 2) await tmp.removeTempDir(path.join(viewRoot, `g${gen - 2}`));
        return { sessionId: session.id, html: built.html, warnings: built.warnings, gen };
    }

    function assertTextSize(text) {
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > MAX_TEXT_BYTES) throw new Error(`文本过大（${(bytes / 1024 / 1024).toFixed(1)} MB），保存上限为 ${MAX_TEXT_BYTES / 1024 / 1024} MB`);
    }

    /** 保存与编辑后导出串行：同一会话同一时刻只有一个写操作 */
    function exclusive(session, task) {
        const run = session.chain.then(task);
        session.chain = run.then(noop, noop);
        return run;
    }

    /** 未绑定时只暂存（回 staged:true）；导出后已绑定则对导出的 md 走带冲突检测的原子写 */
    async function saveMarkdown(payload = {}) {
        const session = require_(payload.sessionId);
        const text = String(payload.text == null ? '' : payload.text);
        assertTextSize(text);
        const epoch = session.epoch;
        return exclusive(session, async () => {
            if (session.epoch !== epoch) return { sessionId: session.id, saved: false, conflict: false, missing: false, discarded: true, warnings: [] };
            const edit = await ensureEdit(session);
            if (!edit.boundPath) {
                edit.markdown = text;
                return { sessionId: session.id, saved: true, staged: true, conflict: false, missing: false, warnings: [] };
            }
            const result = await saveMarkdownFile({ filePath: edit.boundPath, text, base: edit.base, force: Boolean(payload.force), core: mdCore, log });
            if (result.saved) {
                edit.base = result.base;
                edit.markdown = text;
            }
            return { sessionId: session.id, staged: false, boundPath: edit.boundPath, ...result };
        });
    }

    async function importImage(payload = {}) {
        const session = require_(payload.sessionId);
        const edit = await ensureEdit(session);
        return importImageFile({ sourcePath: payload.sourcePath, docDir: edit.dir });
    }

    /** 插图对话框的默认目录：已绑定取导出目录，否则取来源文件所在目录（网页来源不给） */
    function imageDialogDir(payload = {}) {
        const session = require_(payload.sessionId);
        if (session.edit && session.edit.boundPath) return path.dirname(session.edit.boundPath);
        return session.source.kind === 'file' ? session.source.dir : undefined;
    }

    const hasEditedMarkdown = (session) => Boolean(session.edit && session.target === 'bundle'
        && (session.edit.boundPath || session.edit.markdown !== session.edit.original));

    async function registerLibrary(result, { managed, dir }) {
        if (!library) return null;
        try {
            const record = await library.upsertFromResult(result, { managed, outputDir: dir });
            return record.id;
        } catch (err) {
            log(`[desktop] 预览导出写入文件库失败：${errText(err)}`);
            return null;
        }
    }

    /**
     * 编辑后的导出：md 按编辑器文本逐字写出，只带出被引用的图片，旁路 json 由契约函数按新文本重建；
     * 仍交 core.writeDocument 复用路径校验，再登记文件库；随后把编辑区绑定到导出文件，此后保存直接写盘。
     */
    async function exportEdited(session, { dir, managed }) {
        const edit = session.edit;
        const text = edit.markdown;
        const warnings = [...asArray(session.doc.warnings)];
        const files = { [`${NAME_TOKEN}.md`]: text };
        try {
            const sidecars = await buildBundleSidecars({
                text, baseDir: edit.dir, sourceName: `${session.name}.md`, previousMeta: session.doc.meta, name: session.name, core: mdCore,
            });
            if (sidecars) {
                files[`${NAME_TOKEN}.json`] = sidecars.json;
                files[`${NAME_TOKEN}_content_list.json`] = sidecars.contentList;
            } else {
                warnings.push('当前转换内核未提供 renderBundleSidecars，本次导出未附带旁路 JSON');
            }
        } catch (err) {
            warnings.push(`旁路 JSON 重建失败：${errText(err)}`);
        }
        const images = await referencedImages(text, edit.dir);
        const assets = await Promise.all(images.map(async (item) => ({ name: item.name, buffer: await fsp.readFile(item.absPath) })));
        const written = await core.writeDocument({ rendered: { files, assets, extras: [] }, target: 'bundle', outputDir: dir, name: session.name });
        const result = {
            input: session.source.value, target: 'bundle', name: session.name, title: session.title, sourceType: session.type,
            outputPath: written.outputPath, outputs: written.outputs, imagesCount: assets.length, warnings,
            options: core.redactOptions(optionsFor(session.flat, session.target)), extras: written.extras || [],
            backends: session.backends || { pdfParser: null, raster: null },
        };
        const libraryId = await registerLibrary(result, { managed, dir });
        const boundPath = await bindEdit(session, edit, written);
        if (!boundPath) warnings.push('导出成功，但未能定位导出的 Markdown 文件，之后的修改需再次导出');
        return {
            outputPath: written.outputPath, outputs: written.outputs, extras: written.extras || [],
            warnings, libraryId, managed, name: session.name, title: session.title, target: 'bundle',
            ...(boundPath ? { boundPath } : {}),
        };
    }

    async function bindEdit(session, edit, written) {
        const outputs = written && written.outputs ? written.outputs : {};
        const mdPath = typeof outputs.md === 'string' ? outputs.md : path.join(written.outputPath, `${session.name}.md`);
        const stat = await fsp.stat(mdPath).catch(() => null);
        if (!stat || !stat.isFile() || session.edit !== edit) return null;
        const previousDir = edit.dir;
        edit.dir = written.outputPath;
        edit.boundPath = mdPath;
        edit.base = { mtimeMs: stat.mtimeMs, size: stat.size };
        if (previousDir === editDirOf(session)) await tmp.removeTempDir(previousDir);
        return mdPath;
    }

    // ---------- export ----------

    async function exportProduct(payload = {}) {
        const session = require_(payload.sessionId);
        const current = settings.get();
        const managed = Boolean(current.library && current.library.mode === 'managed' && library);
        const dir = payload.outputDir
            || (managed ? library.managedOutputDir({ root: current.library.root }) : current.outputDir);
        await fsp.mkdir(dir, { recursive: true });
        if (hasEditedMarkdown(session)) return exclusive(session, () => exportEdited(session, { dir, managed }));

        const options = optionsFor(session.flat, session.target);
        const rendered = await core.renderDocument(session.doc, session.target, options);
        const written = await core.writeDocument({ rendered, target: session.target, outputDir: dir, name: session.name });
        const warnings = [...asArray(session.doc.warnings), ...asArray(rendered.warnings)];
        // 与页头同源：导出这次渲染给出的 title 一并回写会话，文件库记录与页头不会出现两个标题
        session.title = pickTitle(rendered.title, session.title);
        const result = {
            input: session.source.value, target: session.target, name: session.name,
            title: session.title, sourceType: session.type,
            outputPath: written.outputPath, outputs: written.outputs,
            imagesCount: asArray(rendered.assets).length, warnings,
            options: core.redactOptions(options), extras: written.extras,
            backends: session.backends || { pdfParser: null, raster: null },
        };
        const libraryId = await registerLibrary(result, { managed, dir });
        return {
            outputPath: written.outputPath, outputs: written.outputs, extras: written.extras,
            warnings, libraryId, managed, name: session.name, title: result.title, target: session.target,
        };
    }

    // ---------- close ----------

    /** 先等该会话挂起的保存与导出跑完，再撤销授权、删临时目录 */
    async function close(payload = {}) {
        const session = sessions.get(String(payload.sessionId || ''));
        if (!session) return { closed: false };
        await session.chain.catch(noop);
        await dispose(session);
        return { closed: true };
    }

    async function closeAll() {
        for (const session of [...sessions.values()]) {
            await session.chain.catch(noop);
            await dispose(session);
        }
    }

    return {
        open, render, export: exportProduct, close, closeAll,
        renderMarkdown, saveMarkdown, importImage, imageDialogDir, sessions,
    };
}

/** md-edit 用的内核：渲染沿用会话内核（测试桩同样生效）；parseMarkdown / renderBundleSidecars 仅在注入时覆盖 */
function mdCoreOf(raw, loaded) {
    const out = { renderDocument: loaded.renderDocument };
    if (raw && typeof raw.parseMarkdown === 'function') out.parseMarkdown = raw.parseMarkdown;
    if (raw && Object.prototype.hasOwnProperty.call(raw, 'renderBundleSidecars')) out.renderBundleSidecars = raw.renderBundleSidecars;
    return out;
}

// ============================================================
// 工具
// ============================================================

async function resetDir(dir) {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
}

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch (err) {
        return null;
    }
}

const MIME_EXT = Object.freeze({
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif',
    'image/bmp': '.bmp', 'image/webp': '.webp', 'image/tiff': '.tiff', 'image/svg+xml': '.svg',
});
const extFromMime = (mime) => MIME_EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || '.png';

const escapeHtml = (value) => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

module.exports = {
    createPreviewSessions, changedReparseKeys,
    REPARSE_KEYS, LIVE_KEYS, LIVE_TARGETS, STRUCTURED_SOURCE_TYPES, INPUT_CLASS,
    MAX_SESSIONS, SOURCE_DIRNAME, PRODUCT_DIRNAME, PDF_PREVIEW_NAME, PRECHECK_FILE,
};
