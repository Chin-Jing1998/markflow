/**
 * IPC（方案 §3.3.5）：全部 ipcMain.handle，每通道以 zod 校验入参
 *
 * createIpcHandlers(deps) → { handlers: { [channel]: async (event, payload) }, channels }
 *   deps = { electron, settings, grants, library|null, libraryMigrate|null, service, scan, backendStatus,
 *            getMainWindow, applyTheme, log, addin|null }
 * registerIpc(ipcMain, handlers)：逐通道 ipcMain.handle，先 validatePayload 再交处理器
 * validatePayload(channel, payload)：按 SCHEMAS 校验，失败抛「参数不合法（通道）：…」中文错误（纯逻辑，可单测）
 *
 * 通道一览：
 *   mf:formats:describe                      → describeFormats() + options 描述树 + 进程内后端状态
 *   mf:dialog:pickFiles { directory?, purpose? } → 原生对话框；purpose 'read' 为「选择要打开的文件」（单选、可阅读文档过滤器）
 *   mf:dialog:pickDirectory                  → 原生对话框
 *   mf:paths:expand { paths, scope? }        → { files, unsupported, truncated }；scope 缺省 / 'convert' 按转档白名单，
 *       另受理显式给出的 .xml / .zip 与专利五书目录（后者整项收为 files 里 kind 为 'bundle' 的一条，见 convert-inputs.js），
 *       'browse'（文件库仓库树）另列 .html .htm .xml .json
 *   mf:convert:run { items, outputDir?, options? } → { runId, outputDir, tasks }；进度经 mf:convert:event 推送
 *       事件形状：{ runId, taskId, status: 'queued'|'running'|'done'|'failed'|'cancelled', phase, pct, result?, libraryId?, error? }
 *       整批结束：{ runId, taskId: null, status: 'finished', summary }；菜单「打开文件…」：{ runId: null, type: 'enqueue', files, unsupported }
 *       并发 2；MinerU 令牌由主进程解密后注入 options.mineru.token，渲染进程提供的 options 不接受 mineruToken
 *   mf:convert:cancel { runId }              → 未开始的任务标记 cancelled；进行中的任务跑完
 *   mf:preview:open { path|url, target?, options? } → 建预览会话（解析一次并缓存），回包含来源视图与产物视图
 *   mf:preview:render { sessionId, target?, options? } → 只重渲染；命中重解析项时会话内重新解析并回 reparsed
 *   mf:preview:export { sessionId, outputDir? } → 落盘并写入文件库，回 { outputPath, outputs, libraryId }
 *   mf:preview:close { sessionId }           → 关闭预览或阅读会话（撤销 mf-asset 授权、删临时目录）
 *   mf:reader:open { path }                  → 直接打开 md / html / xml / pdf，回视图对象
 *       主进程 → 渲染进程的推送走 mf:preview:event：{ type: 'reader-open', path } 由菜单「打开文件…」触发
 *   mf:library:list/update/remove/reveal/open/reconvert/migrate → 文件库（模块未就绪时抛「文件库模块未就绪」）
 *   mf:settings:get/set/setMineruToken/testMineru → 设置与令牌（回包永不含令牌）
 *   mf:update:check { force? }               → 向 GitHub 取最新 release 与当前版本比对，回
 *       { status: 'latest'|'update-available'|'unknown'|'failed', message, latestVersion, url, checkedAt, currentVersion, cached }；
 *       目标地址在 update-check.js 内写死，本通道不接受任何 URL 入参；force 为假时命中 24 小时缓存直接返回、不发请求
 *   mf:theme:get/set                         → 主题；变化经 mf:theme:changed 广播
 *   mf:shell:openExternal { url }            → 仅 http(s)
 *   mf:file:action { sessionId, action }     → 顶部栏的当前文件操作：reveal 在访达中显示 / open 用默认应用打开 / copyPath 复制路径；
 *                                              渲染层不传路径，主进程依次在预览会话（来源文件）与阅读会话（所开文件）中按 sessionId 取
 *   mf:addin:status/setEnabled/install/uninstall → Word for Mac 加载项（通道、schema 与处理器定义在 addin/ipc.js，此处只并入总表）
 */
const path = require('path');
const fsp = require('fs').promises;
const { z } = require('zod');

const { TARGETS, INPUT_CLASS, DEFAULT_TARGETS, SUPPORTED_EXTENSIONS, BUNDLE_DIR_TYPE, assertTargetAllowed, detectInputType } = require('../../converters/targets');
const { OPTION_ENUMS, describeOptions } = require('../../converters/options');
const { errText, statOrNull, hostnameOf } = require('../../converters/util');
const { THEMES, LIBRARY_MODES, SettingsPatchSchema } = require('./settings');
const { BROWSE_EXTENSIONS, READER_EXTENSIONS, IMAGE_IMPORT_EXTENSIONS, MAX_TEXT_BYTES } = require('./file-kinds');
const { expandConvertPaths, resolveBundleInputs } = require('./convert-inputs');
const { ADDIN_CHANNELS, ADDIN_SCHEMAS, createAddinHandlers } = require('./addin/ipc');

const CONVERT_CONCURRENCY = 2;
const MAX_ITEMS_PER_RUN = 500;
const MAX_PATHS_PER_EXPAND = 2000;
const MAX_PATH_LENGTH = 4096;
const MINERU_PROBE_TIMEOUT_MS = 15000;
const MINERU_PROBE_BATCH = 'markflow-probe';
const MINERU_AUTH_STATUSES = new Set([401, 403]);
const MINERU_TASK_NOT_FOUND = '-60012';
const LIBRARY_NOT_READY = '文件库模块未就绪';
const PREVIEW_NOT_READY = '预览与阅读模块未就绪';
const UPDATE_NOT_READY = '更新检测模块未就绪';
const EXTERNAL_URL_RE = /^https?:\/\//i;

const CHANNELS = Object.freeze({
    formatsDescribe: 'mf:formats:describe',
    dialogPickFiles: 'mf:dialog:pickFiles',
    dialogPickDirectory: 'mf:dialog:pickDirectory',
    pathsExpand: 'mf:paths:expand',
    convertRun: 'mf:convert:run',
    convertCancel: 'mf:convert:cancel',
    convertEvent: 'mf:convert:event',
    previewOpen: 'mf:preview:open',
    previewRender: 'mf:preview:render',
    previewExport: 'mf:preview:export',
    previewClose: 'mf:preview:close',
    previewEvent: 'mf:preview:event',
    readerOpen: 'mf:reader:open',
    mdRender: 'mf:md:render',
    mdSave: 'mf:md:save',
    mdInsertImage: 'mf:md:insertImage',
    libraryList: 'mf:library:list',
    libraryUpdate: 'mf:library:update',
    libraryRemove: 'mf:library:remove',
    libraryReveal: 'mf:library:reveal',
    libraryOpen: 'mf:library:open',
    libraryReconvert: 'mf:library:reconvert',
    libraryMigrate: 'mf:library:migrate',
    settingsGet: 'mf:settings:get',
    settingsSet: 'mf:settings:set',
    settingsSetMineruToken: 'mf:settings:setMineruToken',
    settingsTestMineru: 'mf:settings:testMineru',
    updateCheck: 'mf:update:check',
    themeGet: 'mf:theme:get',
    themeSet: 'mf:theme:set',
    themeChanged: 'mf:theme:changed',
    shellOpenExternal: 'mf:shell:openExternal',
    fileAction: 'mf:file:action',
    ...ADDIN_CHANNELS,
});

/** mf:file:action 的动作：在访达中显示 / 用默认应用打开 / 复制路径 */
const FILE_ACTIONS = Object.freeze(['reveal', 'open', 'copyPath']);
/** open 动作的扩展名白名单（LOW-2 纵深防御）：仅文档类文件可交给 shell.openPath，比较不分大小写 */
const OPENABLE_EXTENSIONS = new Set([...READER_EXTENSIONS, ...BROWSE_EXTENSIONS].map((ext) => ext.toLowerCase()));

// ============================================================
// schema
// ============================================================

const NoPayload = z.union([z.undefined(), z.null(), z.object({}).strict()]);
const absPath = z.string().min(1).max(MAX_PATH_LENGTH);
const recordId = z.string().min(1).max(200);
const targetEnum = z.enum([...TARGETS]);
const themeEnum = z.enum([...THEMES]);

/** 渲染进程可提交的扁平转换选项（service.buildOptions 的键子集）；mineruToken 一律不接受 */
const FlatOptionsSchema = z.object({
    theme: z.enum([...OPTION_ENUMS.htmlThemes]),
    xmlProfile: z.enum([...OPTION_ENUMS.xmlProfiles]),
    patentParts: z.union([z.literal('auto'), z.array(z.enum([...OPTION_ENUMS.patentParts])).max(5)]),
    pdfBackend: z.enum([...OPTION_ENUMS.pdfBackends]),
    imageFormat: z.enum([...OPTION_ENUMS.imageFormats]),
    jpegQuality: z.number().int().min(60).max(100),
    jpegPpi: z.number().int().min(72).max(600),
    math: z.enum([...OPTION_ENUMS.mathModes]),
    mineruModel: z.enum([...OPTION_ENUMS.mineruModels]),
    mineruOcr: z.boolean(),
    mineruFormula: z.boolean(),
    mineruTable: z.boolean(),
    mineruLang: z.string().max(32),
    mineruTimeout: z.number().int().min(30).max(3600),
    pageRanges: z.string().max(200),
    font: z.string().max(200),
    fontSize: z.number().min(8).max(36),
    lineHeight: z.number().min(1).max(3),
    contentWidth: z.number().int().min(480).max(1600),
    spacing: z.enum([...OPTION_ENUMS.spacing]),
    inlineImages: z.boolean(),
    pageSize: z.enum([...OPTION_ENUMS.pageSizes]),
    landscape: z.boolean(),
    validate: z.boolean(),
    xmlIndent: z.number().int().min(0).max(8),
    numberingStart: z.number().int().min(1).max(9999),
    numberingWidth: z.number().int().min(1).max(6),
    rasterizeTables: z.boolean(),
    rasterizeFormulas: z.boolean(),
    imageDpi: z.number().int().min(72).max(600),
    sectionDetection: z.enum([...OPTION_ENUMS.sectionDetection]),
    rasterScale: z.number().min(1).max(4),
    rasterMaxWidth: z.number().int().min(200).max(10000),
    // 专利五书 XML 反向导入的唯一选项：把段号写进 Word 正文（作用于解析阶段，与目标无关）
    xmlImportParagraphNumbers: z.boolean(),
}).partial().strict();

const ConvertItemSchema = z.object({
    id: z.string().min(1).max(100).optional(),
    path: absPath.optional(),
    url: z.string().max(MAX_PATH_LENGTH).regex(EXTERNAL_URL_RE, '仅接受 http(s) 网址').optional(),
    target: targetEnum.optional(),
}).strict().refine((item) => Boolean(item.path) !== Boolean(item.url), { message: 'path 与 url 须二选一' });

/** 预览 open：path 与 url 二选一，与 ConvertItemSchema 同一套约束 */
const PreviewOpenSchema = z.object({
    path: absPath.optional(),
    url: z.string().max(MAX_PATH_LENGTH).regex(EXTERNAL_URL_RE, '仅接受 http(s) 网址').optional(),
    target: targetEnum.optional(),
    options: FlatOptionsSchema.optional(),
}).strict().refine((item) => Boolean(item.path) !== Boolean(item.url), { message: 'path 与 url 须二选一' });

const FacetQuerySchema = z.object({
    sourceType: z.string().max(40).optional(),
    target: z.string().max(40).optional(),
    month: z.string().max(7).optional(),
    sourceDir: z.string().max(MAX_PATH_LENGTH).optional(),
    tag: z.string().max(60).optional(),
    favorite: z.boolean().optional(),
}).strict();

const SCHEMAS = Object.freeze({
    [CHANNELS.formatsDescribe]: NoPayload,
    [CHANNELS.dialogPickFiles]: z.object({ directory: z.boolean().optional(), purpose: z.enum(['convert', 'read']).optional() }).strict().optional(),
    [CHANNELS.dialogPickDirectory]: z.object({ defaultPath: absPath.optional(), title: z.string().max(200).optional() }).strict().optional(),
    [CHANNELS.pathsExpand]: z.object({ paths: z.array(absPath).max(MAX_PATHS_PER_EXPAND), scope: z.enum(['convert', 'browse']).optional() }).strict(),
    [CHANNELS.convertRun]: z.object({
        items: z.array(ConvertItemSchema).min(1).max(MAX_ITEMS_PER_RUN),
        outputDir: absPath.optional(),
        options: FlatOptionsSchema.optional(),
    }).strict(),
    [CHANNELS.convertCancel]: z.object({ runId: recordId }).strict(),
    [CHANNELS.previewOpen]: PreviewOpenSchema,
    [CHANNELS.previewRender]: z.object({
        sessionId: recordId,
        target: targetEnum.optional(),
        options: FlatOptionsSchema.optional(),
    }).strict(),
    [CHANNELS.previewExport]: z.object({ sessionId: recordId, outputDir: absPath.optional() }).strict(),
    [CHANNELS.previewClose]: z.object({ sessionId: recordId }).strict(),
    [CHANNELS.readerOpen]: z.object({ path: absPath }).strict(),
    [CHANNELS.mdRender]: z.object({ sessionId: recordId, text: z.string().max(MAX_TEXT_BYTES).optional() }).strict(),
    [CHANNELS.mdSave]: z.object({ sessionId: recordId, text: z.string().max(MAX_TEXT_BYTES), force: z.boolean().optional() }).strict(),
    [CHANNELS.mdInsertImage]: z.object({ sessionId: recordId }).strict(),
    [CHANNELS.libraryList]: z.object({
        query: z.string().max(200).optional(),
        facets: FacetQuerySchema.optional(),
        sort: z.enum(['createdAt', 'updatedAt', 'title']).optional(),
        order: z.enum(['asc', 'desc']).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
    }).strict().optional(),
    [CHANNELS.libraryUpdate]: z.object({
        id: recordId,
        patch: z.object({
            tags: z.array(z.string().min(1).max(60)).max(50).optional(),
            favorite: z.boolean().optional(),
            highlighted: z.boolean().optional(),
            title: z.string().max(300).optional(),
        }).strict(),
    }).strict(),
    [CHANNELS.libraryRemove]: z.object({ id: recordId, trash: z.boolean().optional() }).strict(),
    [CHANNELS.libraryReveal]: z.object({ id: recordId }).strict(),
    [CHANNELS.libraryOpen]: z.object({ id: recordId }).strict(),
    [CHANNELS.libraryReconvert]: z.object({ id: recordId, target: targetEnum.optional() }).strict(),
    [CHANNELS.libraryMigrate]: z.object({ dryRun: z.boolean() }).strict(),
    [CHANNELS.settingsGet]: NoPayload,
    [CHANNELS.settingsSet]: z.object({ patch: SettingsPatchSchema }).strict(),
    [CHANNELS.settingsSetMineruToken]: z.object({ token: z.string().max(512).nullable() }).strict(),
    [CHANNELS.settingsTestMineru]: z.object({ token: z.string().min(1).max(512).optional() }).strict().optional(),
    // 只收一个「是否无视缓存」开关：请求地址在主进程写死，渲染层不得指定任何 URL
    [CHANNELS.updateCheck]: z.object({ force: z.boolean().optional() }).strict().optional(),
    [CHANNELS.themeGet]: NoPayload,
    [CHANNELS.themeSet]: z.object({ theme: themeEnum }).strict(),
    [CHANNELS.shellOpenExternal]: z.object({ url: z.string().max(MAX_PATH_LENGTH).regex(EXTERNAL_URL_RE, '仅接受 http(s) 网址') }).strict(),
    // 渲染层只给会话与动作，不给路径：路径一律由主进程按 sessionId 在预览会话与阅读会话中取
    [CHANNELS.fileAction]: z.object({ sessionId: recordId, action: z.enum([...FILE_ACTIONS]) }).strict(),
    ...ADDIN_SCHEMAS,
});

function formatIssues(error) {
    const issues = error && Array.isArray(error.issues) ? error.issues : [];
    return issues.map((issue) => `${issue.path && issue.path.length ? issue.path.join('.') : '(根)'}：${issue.message}`).join('；') || '未知原因';
}

function validatePayload(channel, payload) {
    const schema = SCHEMAS[channel];
    if (!schema) throw new Error(`未知的 IPC 通道：${channel}`);
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new Error(`参数不合法（${channel}）：${formatIssues(parsed.error)}`);
    return parsed.data;
}

// ============================================================
// 工具
// ============================================================

async function runPool(items, concurrency, worker) {
    let cursor = 0;
    const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            await worker(items[index], index);
        }
    });
    await Promise.all(lanes);
}

/** 目标裁决：显式 > 设置里该输入类别的默认 > targets.js 默认；设置值与输入类别不兼容时回退 */
function pickTarget(inputType, requested, defaultTargets) {
    if (requested) return requested;
    const preferred = defaultTargets && defaultTargets[INPUT_CLASS[inputType]];
    if (preferred) {
        try {
            assertTargetAllowed(preferred, inputType);
            return preferred;
        } catch (err) { /* 回退默认 */ }
    }
    return DEFAULT_TARGETS[inputType];
}

/** 文件库记录里的 options（mineru.token 已置 null）回灌前去掉该键，避免覆盖主进程注入的令牌 */
function stripToken(options) {
    if (!options || typeof options !== 'object') return {};
    const copy = { ...options };
    if (copy.mineru && typeof copy.mineru === 'object') {
        const { token, ...rest } = copy.mineru;
        copy.mineru = rest;
    }
    return copy;
}

/** 抹除回包片段里可能回显的令牌（显式传入的与已存的都抹） */
const scrubAll = (text, tokens) => tokens.filter(Boolean).reduce((out, token) => out.split(token).join('（已隐藏）'), String(text));

// ============================================================
// 处理器
// ============================================================

function createIpcHandlers(deps = {}) {
    const {
        electron, settings, library = null, libraryMigrate = null, service, scan,
        preview = null, reader = null, update = null, addin = null,
        backendStatus = { pdf: false, raster: false }, getMainWindow = () => null, applyTheme = () => undefined,
        log = (line) => process.stderr.write(`${line}\n`),
    } = deps;
    if (!electron || !settings || !service || !scan) throw new Error('createIpcHandlers 缺少 electron / settings / service / scan');
    const { dialog, shell, nativeTheme } = electron;
    const runs = new Map();
    let runSeq = 0;

    const requireLibrary = () => {
        if (!library) throw new Error(LIBRARY_NOT_READY);
        return library;
    };
    const requireModule = (mod) => {
        if (!mod) throw new Error(PREVIEW_NOT_READY);
        return mod;
    };

    const parentWindow = (event) => (electron.BrowserWindow ? electron.BrowserWindow.fromWebContents(event.sender) : null) || getMainWindow() || undefined;

    // ---------- 能力 ----------

    async function formatsDescribe() {
        const formats = await service.describeFormats();
        return { ...formats, options: describeOptions(), inProcess: { ...backendStatus }, library: Boolean(library), platform: process.platform };
    }

    // ---------- 对话框与路径 ----------

    async function dialogPickFiles(event, payload = {}) {
        if (payload && payload.purpose === 'read') {
            const picked = await dialog.showOpenDialog(parentWindow(event), {
                title: '选择要打开的文件',
                properties: ['openFile'],
                filters: [
                    { name: '可阅读的文档', extensions: READER_EXTENSIONS.map((ext) => ext.slice(1)) },
                    { name: '全部文件', extensions: ['*'] },
                ],
            });
            return { canceled: Boolean(picked.canceled), paths: picked.canceled ? [] : picked.filePaths.slice(0, 1) };
        }
        const directory = Boolean(payload && payload.directory);
        const result = await dialog.showOpenDialog(parentWindow(event), {
            title: directory ? '选择要转换的文件夹' : '选择要转换的文件',
            properties: directory ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
            filters: directory ? undefined : [
                { name: '支持的文档', extensions: SUPPORTED_EXTENSIONS.map((ext) => ext.slice(1)) },
                { name: '全部文件', extensions: ['*'] },
            ],
        });
        return { canceled: Boolean(result.canceled), paths: result.canceled ? [] : result.filePaths };
    }

    async function dialogPickDirectory(event, payload = {}) {
        const result = await dialog.showOpenDialog(parentWindow(event), {
            title: (payload && payload.title) || '选择目录',
            defaultPath: payload && payload.defaultPath ? payload.defaultPath : undefined,
            properties: ['openDirectory', 'createDirectory'],
        });
        return { canceled: Boolean(result.canceled) || result.filePaths.length === 0, path: result.canceled ? null : (result.filePaths[0] || null) };
    }

    /**
     * 转档入口（缺省 / convert）：目录展开仍按转档白名单，另受理显式给出的 .xml / .zip 与专利五书目录；
     * 文件库仓库树（browse）另列 html / htm / xml / json，其目录遍历不变
     */
    const pathsExpand = (event, payload) => (payload.scope === 'browse'
        ? scan.scanPaths(payload.paths, { exts: BROWSE_EXTENSIONS })
        : expandConvertPaths(payload.paths, { scanPaths: scan.scanPaths }));

    // ---------- 转换 ----------

    async function convertRun(event, payload) {
        return startRun(event, payload.items, { outputDir: payload.outputDir, options: payload.options || {} });
    }

    async function startRun(event, items, { outputDir, options, managed } = {}) {
        const current = settings.get();
        const useManaged = managed !== undefined ? managed : current.library.mode === 'managed';
        const dir = outputDir || (useManaged && library ? library.managedOutputDir({ root: current.library.root }) : current.outputDir);
        await fsp.mkdir(dir, { recursive: true });

        const flat = { ...current.defaults, ...options };
        const token = settings.getMineruToken();
        if (token) flat.mineruToken = token;
        // 专利五书目录没有扩展名可辨，须读盘按签名判定；判定结果同时决定输入类型与 planTasks 的 hints.bundles
        const { bundles, isBundle } = await resolveBundleInputs(items.map((item) => item.path).filter(Boolean));
        const tasks = items.map((item, index) => {
            const raw = item.path || item.url;
            const type = isBundle(raw) ? BUNDLE_DIR_TYPE : detectInputType(raw);
            const [task] = service.planTasks([raw], pickTarget(type, item.target, current.defaultTargets), process.cwd(), { bundles });
            return { ...task, taskId: item.id || `task-${index + 1}`, type, name: item.path ? path.basename(item.path) : hostnameOf(raw) || raw };
        });
        // 扁平选项按本批目标校验：只作用于其它目标的段，取值越界时跳过写入而不是让整批失败
        const normalized = service.buildOptions(flat, { targets: tasks.map((task) => task.target) });

        runSeq += 1;
        const runId = `run-${Date.now().toString(36)}-${runSeq}`;
        const sender = event.sender;
        const run = {
            id: runId, cancelled: false, outputDir: dir, options: normalized, managed: useManaged,
            summary: { total: tasks.length, succeeded: 0, failed: 0, cancelled: 0 },
            send: (data) => { if (!sender.isDestroyed()) sender.send(CHANNELS.convertEvent, { runId, ...data }); },
        };
        runs.set(runId, run);
        for (const task of tasks) run.send({ taskId: task.taskId, status: 'queued', phase: '', pct: 0 });

        runPool(tasks, CONVERT_CONCURRENCY, (task) => executeTask(run, task))
            .catch((err) => log(`[desktop] 转换批次 ${runId} 异常：${errText(err)}`))
            .finally(() => {
                run.send({ taskId: null, status: 'finished', phase: '', pct: 100, summary: { ...run.summary } });
                runs.delete(runId);
            });

        return { runId, outputDir: dir, tasks: tasks.map((task) => ({ taskId: task.taskId, input: task.raw, target: task.target, type: task.type, name: task.name })) };
    }

    async function executeTask(run, task) {
        const { taskId } = task;
        if (run.cancelled) {
            run.summary.cancelled += 1;
            run.send({ taskId, status: 'cancelled', phase: '', pct: 0 });
            return;
        }
        run.send({ taskId, status: 'running', phase: 'parsing', pct: 0 });
        let outcome;
        try {
            outcome = await service.runConversion({
                tasks: [task], outputDir: run.outputDir, concurrency: 1, options: run.options,
                onEvent: (ev) => { if (ev && ev.type === 'progress') run.send({ taskId, status: 'running', phase: ev.phase, pct: ev.pct }); },
            });
        } catch (err) {
            outcome = { ok: false, results: [], errors: [{ input: task.raw, error: errText(err) }] };
        }
        const result = outcome.ok && outcome.results[0];
        if (result) {
            const libraryId = await upsertLibrary(result, run);
            run.summary.succeeded += 1;
            run.send({ taskId, status: 'done', phase: 'done', pct: 100, result, libraryId });
            return;
        }
        run.summary.failed += 1;
        const failure = outcome.errors && outcome.errors[0];
        run.send({ taskId, status: 'failed', phase: 'failed', pct: 0, error: (failure && failure.error) || '转换失败' });
    }

    async function upsertLibrary(result, run) {
        if (!library) return null;
        try {
            const record = await library.upsertFromResult(result, { managed: run.managed, outputDir: run.outputDir });
            return record.id;
        } catch (err) {
            log(`[desktop] 写入文件库失败：${errText(err)}`);
            return null;
        }
    }

    async function convertCancel(event, payload) {
        const run = runs.get(payload.runId);
        if (!run) return { cancelled: false, reason: '批次不存在或已结束' };
        run.cancelled = true;
        return { cancelled: true };
    }

    // ---------- 预览与阅读 ----------

    /** 目标裁决与转换页一致：显式 > 设置里该输入类别的默认 > targets.js 默认；网页来源类型固定为 url */
    async function previewOpen(event, payload) {
        const raw = payload.path || payload.url;
        const type = payload.url ? 'url' : detectInputType(raw);
        if (!type) throw new Error(`不支持的输入格式：${raw}`);
        const current = settings.get();
        return requireModule(preview).open({
            ...(payload.url ? { url: payload.url } : { path: payload.path }),
            type,
            target: pickTarget(type, payload.target, current.defaultTargets),
            options: payload.options || {},
        });
    }

    const previewRender = async (event, payload) => requireModule(preview).render(payload);
    const previewExport = async (event, payload) => requireModule(preview).export(payload);

    /** 预览会话与阅读会话共用同一个关闭通道：先问预览，未命中再问阅读 */
    async function previewClose(event, payload) {
        const closed = preview ? await preview.close(payload) : { closed: false };
        if (closed.closed) return closed;
        return reader ? reader.close(payload) : { closed: false };
    }

    const readerOpen = async (event, payload) => requireModule(reader).open(payload);

    // ---------- Markdown 编辑 ----------

    /** 按 sessionId 找编辑会话的归属：预览会话优先，其次阅读会话；都不在即中文报错 */
    function mdOwner(sessionId) {
        const id = String(sessionId || '');
        if (preview && preview.sessions && preview.sessions.has(id)) return preview;
        if (reader && reader.sessions && reader.sessions.has(id)) return reader;
        throw new Error('编辑会话不存在或已关闭，请重新打开文件');
    }

    const mdRender = async (event, payload) => mdOwner(payload.sessionId).renderMarkdown(payload);
    const mdSave = async (event, payload) => mdOwner(payload.sessionId).saveMarkdown(payload);

    /** 插图：由主进程弹原生对话框（仅图片扩展名，默认目录为文档目录），写入路径同样由主进程按会话决定 */
    async function mdInsertImage(event, payload) {
        const owner = mdOwner(payload.sessionId);
        const defaultPath = typeof owner.imageDialogDir === 'function' ? owner.imageDialogDir(payload) : undefined;
        const picked = await dialog.showOpenDialog(parentWindow(event), {
            title: '插入图片',
            ...(defaultPath ? { defaultPath } : {}),
            properties: ['openFile'],
            filters: [{ name: '图片', extensions: IMAGE_IMPORT_EXTENSIONS.map((ext) => ext.slice(1)) }],
        });
        if (!picked || picked.canceled || !Array.isArray(picked.filePaths) || picked.filePaths.length === 0) return { canceled: true };
        const imported = await owner.importImage({ sessionId: payload.sessionId, sourcePath: picked.filePaths[0] });
        return { canceled: false, ...imported };
    }

    // ---------- 文件库 ----------

    async function libraryList(event, payload) {
        return requireLibrary().list(payload || {});
    }

    async function libraryUpdate(event, payload) {
        return requireLibrary().update(payload.id, payload.patch);
    }

    async function libraryRemove(event, payload) {
        const lib = requireLibrary();
        const record = await lib.get(payload.id);
        if (!record) return { removed: false, trashed: false };
        let trashed = false;
        if (payload.trash && record.outputPath && (await statOrNull(record.outputPath))) {
            await shell.trashItem(record.outputPath);
            trashed = true;
        }
        const removed = await lib.remove(payload.id);
        return { removed, trashed };
    }

    async function locateRecord(id) {
        const record = await requireLibrary().get(id);
        if (!record) throw new Error(`未找到记录：${id}`);
        if (!record.outputPath || !(await statOrNull(record.outputPath))) throw new Error('产物不存在或已被移动');
        return record;
    }

    async function libraryReveal(event, payload) {
        const record = await locateRecord(payload.id);
        shell.showItemInFolder(record.outputPath);
        return { ok: true };
    }

    async function libraryOpen(event, payload) {
        const record = await locateRecord(payload.id);
        const failure = await shell.openPath(record.outputPath);
        if (failure) throw new Error(`无法打开：${failure}`);
        return { ok: true };
    }

    async function libraryReconvert(event, payload) {
        const record = await requireLibrary().get(payload.id);
        if (!record) throw new Error(`未找到记录：${payload.id}`);
        const raw = record.source.value;
        if (record.source.kind === 'file' && !(await statOrNull(raw))) throw new Error(`来源文件不存在：${raw}`);
        const item = record.source.kind === 'url' ? { id: `lib-${record.id}`, url: raw } : { id: `lib-${record.id}`, path: raw };
        return startRun(event, [{ ...item, target: payload.target || record.target }], {
            outputDir: path.dirname(record.outputPath),
            options: stripToken(record.options),
            managed: record.managed,
        });
    }

    async function libraryMigrateHandler(event, payload) {
        const lib = requireLibrary();
        if (!libraryMigrate) throw new Error(LIBRARY_NOT_READY);
        const current = settings.get();
        if (current.library.mode !== 'managed') throw new Error('请先在设置中启用托管模式并指定托管根目录');
        const { items } = await lib.list({});
        const present = items.filter((item) => !item.missing);
        const plan = libraryMigrate.planMigration({ records: present, root: current.library.root });
        const skipped = [...plan.skipped, ...items.filter((item) => item.missing).map((item) => ({ id: item.id, reason: '产物不存在，无法迁移' }))];
        const fullPlan = { moves: plan.moves, skipped };
        if (payload.dryRun) return { dryRun: true, plan: fullPlan };
        const result = await libraryMigrate.runMigration(plan, { library: lib });
        return { dryRun: false, plan: fullPlan, result };
    }

    // ---------- 设置与主题 ----------

    const settingsGet = async () => settings.describe();

    async function settingsSet(event, payload) {
        const before = settings.get();
        const next = await settings.set(payload.patch);
        if (next.theme !== before.theme) applyTheme(next.theme);
        return settings.describe();
    }

    async function settingsSetMineruToken(event, payload) {
        const configured = await settings.setMineruToken(payload.token);
        return { configured };
    }

    async function settingsTestMineru(event, payload) {
        const token = (payload && payload.token) || settings.getMineruToken();
        if (!token) return { ok: false, status: 'not-configured', message: '尚未配置 MinerU 令牌' };
        const { API_BASE } = require('../../converters/pdf/mineru');
        const { describeMineruError, AUTH_CODES } = require('../../converters/pdf/mineru-errors');
        let res;
        try {
            res = await fetch(`${API_BASE}/extract-results/batch/${MINERU_PROBE_BATCH}`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                signal: AbortSignal.timeout(MINERU_PROBE_TIMEOUT_MS),
            });
        } catch (err) {
            return { ok: false, status: 'network', message: describeMineruError(err, { token }) };
        }
        const text = await res.text().catch(() => '');
        let body = null;
        try { body = JSON.parse(text); } catch (err) { body = null; }
        const code = body && body.code != null ? String(body.code) : '';
        if (MINERU_AUTH_STATUSES.has(res.status) || AUTH_CODES.has(code)) {
            return { ok: false, status: 'auth-failed', message: '鉴权失败：MinerU 令牌无效或已过期，请检查后重新保存' };
        }
        if (res.ok || code === '0' || code === MINERU_TASK_NOT_FOUND || res.status === 404) {
            return { ok: true, status: 'ok', message: 'MinerU 令牌有效，连接正常' };
        }
        const detail = scrubAll(text.slice(0, 200), [token, settings.getMineruToken()]);
        return { ok: false, status: 'error', message: `MinerU 返回异常：HTTP ${res.status}${detail ? ` — ${detail}` : ''}` };
    }

    // ---------- 更新检测 ----------

    /** 渲染层只能触发检测并读结果；请求地址与护栏都在 update-check.js 内，本通道不透传任何 URL */
    async function updateCheck(event, payload) {
        if (!update) throw new Error(UPDATE_NOT_READY);
        return update.check({ force: Boolean(payload && payload.force) });
    }

    const themeGet = async () => ({ theme: settings.get().theme, shouldUseDarkColors: Boolean(nativeTheme && nativeTheme.shouldUseDarkColors) });

    async function themeSet(event, payload) {
        await settings.set({ theme: payload.theme });
        applyTheme(payload.theme);
        return themeGet();
    }

    async function shellOpenExternal(event, payload) {
        await shell.openExternal(payload.url);
        return { ok: true };
    }

    // ---------- 当前文件操作（顶部栏） ----------

    /** 按 sessionId 取会话对应的本地文件：先查预览会话（取来源文件，网页来源没有本地文件），再查阅读会话（取所开文件） */
    function sessionFilePath(sessionId) {
        const id = String(sessionId || '');
        const previewSession = preview && preview.sessions ? preview.sessions.get(id) : null;
        if (previewSession) {
            const filePath = previewSession.input && previewSession.input.path;
            if (!filePath) throw new Error('当前预览来自网页，没有对应的本地文件');
            return filePath;
        }
        const readerSession = reader && reader.sessions ? reader.sessions.get(id) : null;
        if (readerSession && readerSession.path) return readerSession.path;
        throw new Error('文件会话不存在或已关闭，请重新打开文件');
    }

    /** reveal 用 shell.showItemInFolder，open 用 shell.openPath（失败回中文错误），copyPath 用主进程剪贴板；复制路径不要求文件仍在 */
    async function fileAction(event, payload) {
        const filePath = sessionFilePath(payload.sessionId);
        if (payload.action === 'copyPath') {
            const { clipboard } = electron;
            if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error('剪贴板不可用');
            clipboard.writeText(filePath);
            return { ok: true };
        }
        if (!(await statOrNull(filePath))) throw new Error(`文件不存在或已被移动：${path.basename(filePath)}`);
        if (payload.action === 'reveal') {
            shell.showItemInFolder(filePath);
            return { ok: true };
        }
        if (!OPENABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
            throw new Error('只能用默认应用打开文档类文件');
        }
        const failure = await shell.openPath(filePath);
        if (failure) throw new Error(`无法用默认应用打开：${failure}`);
        return { ok: true };
    }

    const handlers = {
        [CHANNELS.formatsDescribe]: formatsDescribe,
        [CHANNELS.dialogPickFiles]: dialogPickFiles,
        [CHANNELS.dialogPickDirectory]: dialogPickDirectory,
        [CHANNELS.pathsExpand]: pathsExpand,
        [CHANNELS.convertRun]: convertRun,
        [CHANNELS.convertCancel]: convertCancel,
        [CHANNELS.previewOpen]: previewOpen,
        [CHANNELS.previewRender]: previewRender,
        [CHANNELS.previewExport]: previewExport,
        [CHANNELS.previewClose]: previewClose,
        [CHANNELS.readerOpen]: readerOpen,
        [CHANNELS.mdRender]: mdRender,
        [CHANNELS.mdSave]: mdSave,
        [CHANNELS.mdInsertImage]: mdInsertImage,
        [CHANNELS.libraryList]: libraryList,
        [CHANNELS.libraryUpdate]: libraryUpdate,
        [CHANNELS.libraryRemove]: libraryRemove,
        [CHANNELS.libraryReveal]: libraryReveal,
        [CHANNELS.libraryOpen]: libraryOpen,
        [CHANNELS.libraryReconvert]: libraryReconvert,
        [CHANNELS.libraryMigrate]: libraryMigrateHandler,
        [CHANNELS.settingsGet]: settingsGet,
        [CHANNELS.settingsSet]: settingsSet,
        [CHANNELS.settingsSetMineruToken]: settingsSetMineruToken,
        [CHANNELS.settingsTestMineru]: settingsTestMineru,
        [CHANNELS.updateCheck]: updateCheck,
        [CHANNELS.themeGet]: themeGet,
        [CHANNELS.themeSet]: themeSet,
        [CHANNELS.shellOpenExternal]: shellOpenExternal,
        [CHANNELS.fileAction]: fileAction,
        ...createAddinHandlers(addin),
    };
    return { handlers, channels: CHANNELS, runs };
}

function registerIpc(ipcMain, handlers) {
    for (const [channel, handler] of Object.entries(handlers)) {
        ipcMain.handle(channel, async (event, payload) => handler(event, validatePayload(channel, payload)));
    }
}

module.exports = {
    createIpcHandlers, registerIpc, validatePayload, pickTarget, stripToken,
    CHANNELS, SCHEMAS, FlatOptionsSchema, CONVERT_CONCURRENCY, PREVIEW_NOT_READY, LIBRARY_NOT_READY, UPDATE_NOT_READY, LIBRARY_MODES,
};
