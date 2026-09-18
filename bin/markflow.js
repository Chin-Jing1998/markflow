#!/usr/bin/env node
/**
 * MarkFlow 命令行入口
 *
 * 子命令：convert（批量转换）、extract（网页正文只读提取）、formats（能力矩阵）、
 * config（读写 ~/.markflow/config.json）、mcp（MCP stdio 服务）。
 * 输出约定：--json 模式下 stdout 只输出一行 JSON，且不输出进度；人类模式下 stdout 只走产物路径（extract 走
 * Markdown 正文），进度、告警与汇总走 stderr；参数错误与运行异常一律走 stderr，便于 agent 直接解析。
 * 退出码：0 全部成功；1 参数错误或运行异常；2 存在失败项（extract 为提取失败）。
 * convert 的转换选项（--theme、--xml-profile 等）在此只做「解析为扁平键」一件事：取值范围、默认值与中文
 * 错误文案都由 converters/options.js 定义，converters/service.js 的 buildOptions 负责映射，并按本批目标
 * 裁决越界取值是报错还是跳过（如 --to docx --font-size 9 只写 docx 段，html 段保留默认值）；--help 的选项段
 * 由 service.describeOptionHint() 依同一描述树生成，故新增选项不必在本文件重复维护取值表。
 * 布尔开关支持 --no-<旗标> 显式关闭：parseArgs 的 allowNegative 自 Node 22.4.0 起才有，而 package.json 的
 * engines 允许 22.0，故在交给 parseArgs 之前自行摘出 --no- 形式，并按「同一开关以最后一次出现为准」合并。
 * parseArgs 的报错按 ERR_PARSE_ARGS_* 错误码转成中文，不回显英文原文。
 * 本文件零第三方依赖，参数解析用 node:util 的 parseArgs。
 */
const path = require('path');
const { parseArgs } = require('node:util');

const service = require('../converters/service');
const { setConfig, readConfig, getMineruToken, getConfigPath, CONFIG_TOKEN_KEY } = require('../converters/config');
const { REMOTE_URL_RE, resolveUserPath, DIRECTORY_SCAN_EXTENSIONS } = require('../converters/targets');
const { expandInputs, DEFAULT_MAX_FILES } = require('../converters/scan');
const { errText, isFile, isDirectory } = require('../converters/util');
const pkg = require('../package.json');

const EXIT = Object.freeze({ OK: 0, USAGE: 1, FAILED: 2 });
const DEFAULT_CONCURRENCY = service.DEFAULT_CONCURRENCY;
// 帮助文案中选项名一列的宽度（终端列数，CJK 字符按两列计）
const FLAG_COLUMN = 28;

// convert 的转换选项：flag 为长选项名，key 为 service.buildOptions 的扁平键，paths 指向 describeOptions()
// 描述树中的同名字段（帮助文案的可选值、范围与默认值由它生成；一个旗标落到多条路径时逐段列出差异）；
// description 省略时取首条路径的说明。
const CONVERT_FLAGS = Object.freeze([
    { flag: 'theme', key: 'theme', paths: ['html.theme', 'pdf.theme'], value: '<主题>', description: 'html 与 pdf 目标的主题' },
    { flag: 'xml-profile', key: 'xmlProfile', paths: ['xml.profile'], value: '<profile>' },
    { flag: 'patent-parts', key: 'patentParts', paths: ['xml.patent.parts'], value: '<部分列表>', note: '逗号分隔' },
    { flag: 'pdf-backend', key: 'pdfBackend', paths: ['pdfBackend'], value: '<后端>' },
    { flag: 'image-format', key: 'imageFormat', paths: ['imageFormat'], value: '<格式>' },
    { flag: 'jpeg-quality', key: 'jpegQuality', paths: ['jpegQuality'], value: '<n>' },
    { flag: 'jpeg-ppi', key: 'jpegPpi', paths: ['jpegPpi'], value: '<n>' },
    { flag: 'math', key: 'math', paths: ['math'], value: '<方式>' },
    { flag: 'mineru-model', key: 'mineruModel', paths: ['mineru.model'], value: '<模型>' },
    { flag: 'mineru-ocr', key: 'mineruOcr', paths: ['mineru.ocr'], type: 'boolean' },
    { flag: 'mineru-formula', key: 'mineruFormula', paths: ['mineru.formula'], type: 'boolean' },
    { flag: 'mineru-table', key: 'mineruTable', paths: ['mineru.table'], type: 'boolean' },
    { flag: 'mineru-lang', key: 'mineruLang', paths: ['mineru.language'], value: '<语言>' },
    { flag: 'mineru-timeout', key: 'mineruTimeout', paths: ['mineru.timeoutSec'], value: '<秒>' },
    { flag: 'page-ranges', key: 'pageRanges', paths: ['mineru.pageRanges'], value: '<范围>' },
    { flag: 'font', key: 'font', paths: ['html.fontFamily'], value: '<字体栈>' },
    {
        flag: 'font-size', key: 'fontSize', paths: ['html.fontSize', 'docx.fontSize'], value: '<n>',
        description: '正文字号：html 与 pdf 目标按 px，docx 目标按 pt',
    },
    { flag: 'docx-font-size', key: 'docxFontSize', paths: ['docx.fontSize'], value: '<n>', note: '与 --font-size 同给时以本项为准' },
    { flag: 'font-ascii', key: 'fontAscii', paths: ['docx.fontFamily.ascii'], value: '<字体>' },
    { flag: 'font-east-asia', key: 'fontEastAsia', paths: ['docx.fontFamily.eastAsia'], value: '<字体>' },
    { flag: 'line-height', key: 'lineHeight', paths: ['html.lineHeight'], value: '<n>' },
    { flag: 'content-width', key: 'contentWidth', paths: ['html.contentWidth'], value: '<n>' },
    { flag: 'spacing', key: 'spacing', paths: ['html.spacing'], value: '<档位>' },
    { flag: 'inline-images', key: 'inlineImages', paths: ['html.inlineImages'], type: 'boolean' },
    { flag: 'page-size', key: 'pageSize', paths: ['pdf.pageSize', 'docx.pageSize'], value: '<纸张>', description: 'pdf 与 docx 目标的纸张' },
    { flag: 'landscape', key: 'landscape', paths: ['pdf.landscape'], type: 'boolean', note: '仅 pdf 目标' },
    { flag: 'xml-indent', key: 'xmlIndent', paths: ['xml.indent'], value: '<n>' },
    { flag: 'numbering-start', key: 'numberingStart', paths: ['xml.numbering.start'], value: '<n>' },
    { flag: 'numbering-width', key: 'numberingWidth', paths: ['xml.numbering.width'], value: '<n>' },
    { flag: 'patent-image-dpi', key: 'imageDpi', paths: ['xml.patent.imageDpi'], value: '<n>', note: '仅 patent profile' },
    { flag: 'section-detection', key: 'sectionDetection', paths: ['xml.patent.sectionDetection'], value: '<方式>', note: '仅 patent profile' },
    { flag: 'rasterize-tables', key: 'rasterizeTables', paths: ['xml.patent.rasterizeTables'], type: 'boolean', note: '仅 patent profile' },
    { flag: 'rasterize-formulas', key: 'rasterizeFormulas', paths: ['xml.patent.rasterizeFormulas'], type: 'boolean', note: '仅 patent profile' },
    {
        flag: 'xml-import-paragraph-numbers', key: 'xmlImportParagraphNumbers', paths: ['xmlImport.paragraphNumbers'], type: 'boolean',
        note: '仅专利五书 XML 输入',
    },
    { flag: 'raster-scale', key: 'rasterScale', paths: ['raster.scale'], value: '<倍数>' },
    { flag: 'raster-max-width', key: 'rasterMaxWidth', paths: ['raster.maxWidth'], value: '<n>' },
    { flag: 'validate', key: 'validate', paths: ['xml.validate'], type: 'boolean', note: '仅 xml 目标生效，校验结果进 warnings' },
]);

const BASE_OPTIONS = Object.freeze({
    to: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' },
    concurrency: { type: 'string' }, 'max-chars': { type: 'string' },
    clean: { type: 'boolean' }, 'skip-existing': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
});
const OPTIONS = Object.freeze({
    ...BASE_OPTIONS,
    ...Object.fromEntries(CONVERT_FLAGS.map((item) => [item.flag, { type: item.type || 'string' }])),
});
// 可用 --no- 前缀关闭的布尔开关：转换选项中的布尔项、重跑策略与 --json；--help / --version 只作一次性动作，不参与
const NEGATABLE = new Set([
    ...CONVERT_FLAGS.filter((item) => item.type === 'boolean').map((item) => item.flag),
    'json', 'clean', 'skip-existing',
]);
// 位置参数恰为 true / false 时，多半是给布尔开关写了取值
const BOOLEAN_VALUE_RE = /^(?:true|false)$/i;

// config 可读写的条目：key 为 config.json 中的键名，probe 报告当前生效的来源；取值一律不回显
const CONFIG_ITEMS = Object.freeze([
    Object.freeze({ name: 'mineru-token', key: CONFIG_TOKEN_KEY, label: 'MinerU 令牌', probe: getMineruToken }),
]);

// 参数层面的错误：只打印说明并以 EXIT.USAGE 退出，不启动转换
class UsageError extends Error {}

const out = (text) => process.stdout.write(`${text}\n`);
const log = (text) => process.stderr.write(`${text}\n`);

// ==================== 入口 ====================

// 返回数字表示退出码；返回 null 表示保持进程运行（mcp）
async function main(argv) {
    const { rest, overrides } = splitNegations(argv);
    let parsed;
    try {
        parsed = parseArgs({ args: rest, allowPositionals: true, options: OPTIONS, tokens: true });
    } catch (err) {
        log(`参数错误：${describeParseError(err)}`);
        return EXIT.USAGE;
    }
    // --no-<开关> 摘出后由 overrides 落定，故同一开关以命令行中最后一次出现为准
    const values = { ...parsed.values, ...overrides };
    const { positionals, tokens } = parsed;
    const command = positionals[0];
    if (values.version) { out(pkg.version); return EXIT.OK; }
    if (values.help || !command) { printUsage(); return EXIT.OK; }
    try {
        if (command === 'convert') return await cmdConvert(values, positionals.slice(1), tokens);
        if (command === 'extract') return await cmdExtract(values, positionals.slice(1), tokens);
        if (command === 'formats') return await cmdFormats(values);
        if (command === 'config') return await cmdConfig(values, positionals.slice(1));
        if (command === 'mcp') return await cmdMcp();
        throw new UsageError(`未知子命令：${command}（可用：convert、extract、formats、config、mcp）`);
    } catch (err) {
        log(err instanceof UsageError ? err.message : `执行失败：${errText(err)}`);
        return EXIT.USAGE;
    }
}

// ==================== 参数解析 ====================

/**
 * 摘出 --no-<布尔旗标>：rest 交 parseArgs，overrides 记录每个布尔开关最后一次出现的取值
 * （--旗标 为 true，--no-旗标 为 false）。`--` 之后的参数原样保留，不参与识别。
 */
function splitNegations(argv) {
    const rest = [];
    const overrides = {};
    let terminated = false;
    for (const arg of argv) {
        if (terminated || arg === '--') {
            terminated = true;
            rest.push(arg);
            continue;
        }
        const negated = arg.startsWith('--no-') ? arg.slice('--no-'.length) : '';
        if (negated && NEGATABLE.has(negated)) {
            overrides[negated] = false;
            continue;
        }
        if (arg.startsWith('--') && NEGATABLE.has(arg.slice(2))) overrides[arg.slice(2)] = true;
        rest.push(arg);
    }
    return { rest, overrides };
}

/** parseArgs 的报错 → 中文说明；英文原文只用于区分同一错误码下的几种情形，不回显给用户 */
function describeParseError(err) {
    const message = String((err && err.message) || '');
    const quoted = (/'([^']+)'/.exec(message) || [])[1] || '';
    // 形如 "Option '--to <value>' argument missing"：取引号内的第一段即选项名
    const flag = quoted.split(' ')[0];
    const code = err && err.code;
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
        const hint = flag.startsWith('--no-') ? '--no- 前缀只适用于布尔开关' : 'markflow --help 查看可用选项';
        return `未知选项 ${flag}（${hint}）`;
    }
    if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
        if (/argument missing/.test(message)) return `选项 ${flag} 缺少取值`;
        if (/does not take an argument/.test(message)) return describeBooleanMisuse(flag);
        if (/ambiguous/.test(message)) {
            return `选项 ${flag} 的取值以短横线开头，无法判断是取值还是下一个选项；取值确以短横线开头时请写成 ${flag}=<取值>`;
        }
        return `选项 ${flag} 的取值不合法`;
    }
    if (code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') return `多余的参数：${quoted}`;
    return '参数无法解析，请用 markflow --help 核对用法';
}

const describeBooleanMisuse = (flag) => (flag.startsWith('--') && NEGATABLE.has(flag.slice(2))
    ? `布尔开关 ${flag} 不接受取值：开启直接写 ${flag}，关闭写 --no-${flag.slice(2)}`
    : `布尔开关 ${flag} 不接受取值`);

/** 位置参数恰为 true / false：多半是给布尔开关写了取值（--mineru-ocr false），parseArgs 会把它当成输入 */
function assertNoBooleanValue(tokens) {
    tokens.forEach((token, index) => {
        if (token.kind !== 'positional' || !BOOLEAN_VALUE_RE.test(token.value)) return;
        const previous = tokens[index - 1];
        const flag = previous && previous.kind === 'option' && NEGATABLE.has(previous.name) ? previous.name : '';
        throw new UsageError(flag
            ? `布尔开关 --${flag} 不接受取值「${token.value}」：开启直接写 --${flag}，关闭写 --no-${flag}`
            : `布尔开关不接受取值：位置参数「${token.value}」像是布尔取值，开启直接写旗标，关闭写 --no-<旗标>`);
    });
}

// ==================== convert ====================

async function cmdConvert(values, inputs, tokens) {
    assertNoBooleanValue(tokens);
    if (inputs.length === 0) throw new UsageError('convert 需要至少一个输入：文件路径、目录或 http(s) 网址');
    const asJson = Boolean(values.json);
    // 目录就地展开为其下受支持的文件（产物平铺在同一输出目录，不保留子目录层级）；未给目录时逐项与入参相同
    const expansion = await expandInputs(inputs, { cwd: process.cwd() });
    if (expansion.inputs.length === 0) {
        throw new UsageError(`输入目录中没有可转换的文件（目录展开受理：${DIRECTORY_SCAN_EXTENSIONS.join(' ')}；.xml 与 .zip 须显式给出）`);
    }
    if (!asJson) reportExpansion(expansion);
    // 选项按本批目标校验，故先规划任务再构建 options
    const tasks = await planTasks(expansion.inputs, values.to, expansion.bundles);
    const options = buildConvertOptions(values, tasks);
    const validate = Boolean(values.validate);
    const outputDir = await resolveCliOutputDir(values.out);
    const concurrency = resolveConcurrency(values.concurrency);

    // 人类模式下每项开始与结束各打一行进度到 stderr，告警逐条跟在完成行之后；--json 模式不输出进度，
    // 告警随结果进 JSON，stdout 保持纯净
    const onEvent = (event) => {
        if (asJson) return;
        const task = tasks[event.idx];
        if (event.type === 'start') { log(`开始：${task.raw} → ${task.target}`); return; }
        if (event.type !== 'item') return;
        if (!event.ok) { log(event.cancelled ? `已取消：${task.raw}` : `失败：${task.raw} → ${errText(event.error)}`); return; }
        log(event.result.skipped
            ? `已跳过：${task.raw} → ${event.result.outputPath}（产物已存在）`
            : `完成：${task.raw} → ${event.result.outputPath}`);
        for (const warning of event.result.warnings || []) log(`  告警：${warning}`);
    };

    // 首次 SIGINT 中止批次（不再领取新任务），第二次立即退出
    const cancel = installCancelHandler();
    let payload;
    try {
        payload = await service.runConversion({
            tasks, outputDir, concurrency, onEvent, options, signal: cancel.signal,
            clean: Boolean(values.clean), skipExisting: Boolean(values['skip-existing']),
        });
    } finally {
        cancel.dispose();
    }
    // --validate 已作为 xml.validate 进入 options（渲染器据此校验并把结果写入 warnings）；结果信封上另留标记
    const envelope = {
        ...payload,
        ...(validate ? { validate: true } : {}),
        ...expansionEnvelope(expansion),
    };

    if (asJson) out(JSON.stringify(envelope));
    else {
        payload.results.forEach((item) => out(item.outputPath));
        log(summaryLine(payload, outputDir));
    }
    return payload.ok ? EXIT.OK : EXIT.FAILED;
}

// 目录展开的一行提示（人类模式）：展开出多少文件、跳过多少不受支持的文件、是否触达上限
function reportExpansion(expansion) {
    if (!hasExpansion(expansion)) return;
    const { directories, skipped, truncated } = expansion;
    const files = directories.reduce((sum, item) => sum + item.count, 0);
    const parts = [`目录展开：${directories.length} 个目录 → ${files} 个文件`];
    if (skipped.length > 0) parts.push(`已跳过 ${skipped.length} 个不支持的文件`);
    if (truncated) parts.push(`已达上限 ${DEFAULT_MAX_FILES} 个文件，其余未展开`);
    log(parts.join('；'));
}

// --json：展开情况作为新增字段进结果信封；未给目录时整条省略，既有字段不变
function expansionEnvelope(expansion) {
    if (!hasExpansion(expansion)) return {};
    const { directories, skipped, truncated } = expansion;
    return { inputExpansion: { directories, skipped, truncated } };
}

const hasExpansion = ({ directories, skipped, truncated }) => directories.length > 0 || skipped.length > 0 || truncated;

// 汇总行：跳过与取消各自单列，均只在发生时出现；失败数不含取消项
function summaryLine(payload, outputDir) {
    const cancelled = payload.errors.filter((item) => item.cancelled === true).length;
    const skipped = payload.results.filter((item) => item.skipped === true).length;
    const warnings = payload.results.reduce((sum, item) => sum + item.warnings.length, 0);
    // 四个计数把本批分完，可直接相加：跳过项在 results 中，故不计入「成功」
    const parts = [`成功 ${payload.results.length - skipped} 项`, `失败 ${payload.errors.length - cancelled} 项`];
    if (cancelled > 0) parts.push(`已取消 ${cancelled} 项`);
    if (skipped > 0) parts.push(`跳过 ${skipped} 项`);
    parts.push(`输出目录 ${outputDir}`);
    if (warnings > 0) parts.push(`告警 ${warnings} 条`);
    return `汇总：${parts.join('，')}`;
}

/** SIGINT：首次中止批次并等待进行中的任务结束，再按一次立即退出 */
function installCancelHandler() {
    const controller = new AbortController();
    const onSigint = () => {
        if (controller.signal.aborted) {
            log('已收到第二次中断，立即退出。');
            process.exit(EXIT.FAILED);
        }
        controller.abort();
        log('已中止，正在等待进行中的任务结束…（再按一次立即退出）');
    };
    process.on('SIGINT', onSigint);
    return { signal: controller.signal, dispose: () => process.off('SIGINT', onSigint) };
}

// 命令行取值 → service.buildOptions 的扁平键；取值非法即参数错误（中文文案来自 converters/options.js）。
// 本批目标一并传入：只作用于其它目标的段，取值越界时跳过写入而不是让整批失败
function buildConvertOptions(values, tasks) {
    const flat = {};
    for (const { flag, key } of CONVERT_FLAGS) {
        if (!key || values[flag] === undefined) continue;
        flat[key] = values[flag];
    }
    try {
        return service.buildOptions(flat, { targets: tasks.map((task) => task.target) });
    } catch (err) {
        throw new UsageError(errText(err));
    }
}

// 在服务层规划之上追加 CLI 专属的存在性预检；任一不合法即抛 UsageError（不启动转换）。
// bundles 为目录展开时判定出的专利五书目录：它们是目录而非文件，已确认存在，不再按文件预检
async function planTasks(inputs, requested, bundles) {
    let tasks;
    try {
        tasks = service.planTasks(inputs, requested, process.cwd(), { bundles });
    } catch (err) {
        throw new UsageError(errText(err));
    }
    const bundleDirs = new Set(bundles);
    for (const task of tasks) {
        if (task.input.path && !bundleDirs.has(task.input.path) && !(await isFile(task.input.path))) {
            throw new UsageError(`输入文件不存在：${task.input.path}`);
        }
    }
    return tasks;
}

// --out → 环境变量 MARKFLOW_OUTPUT_DIR → 当前工作目录；支持 ~ 与 file:// 写法，目录必须已存在
async function resolveCliOutputDir(value) {
    const raw = value || process.env.MARKFLOW_OUTPUT_DIR || process.cwd();
    let expanded;
    try {
        expanded = resolveUserPath(raw);
    } catch (err) {
        throw new UsageError(errText(err));
    }
    const dir = path.resolve(process.cwd(), expanded);
    if (!(await isDirectory(dir))) throw new UsageError(`输出目录不存在：${dir}`);
    return dir;
}

// 并发数只影响快慢、不影响产物，故非法取值不报错：告警后按默认值继续
function resolveConcurrency(value) {
    if (value === undefined) return DEFAULT_CONCURRENCY;
    const parsed = Number(String(value).trim());
    if (!Number.isFinite(parsed) || parsed < 1) {
        log(`注意：--concurrency 取值「${value}」无效（须为正整数），已按默认值 ${DEFAULT_CONCURRENCY} 执行`);
        return DEFAULT_CONCURRENCY;
    }
    if (!Number.isInteger(parsed)) log(`注意：--concurrency 取值「${value}」不是整数，已向下取整为 ${Math.floor(parsed)}`);
    return Math.floor(parsed);
}

// ==================== extract ====================

// 网页正文只读提取：正文走 stdout（不落盘、不下载图片），摘要与提示走 stderr；与 MCP 的 extract_article 同源
async function cmdExtract(values, args, tokens) {
    assertNoBooleanValue(tokens);
    const [url, ...extra] = args;
    if (!url) throw new UsageError('extract 需要一个 http(s) 网址：markflow extract <网址> [--json] [--max-chars <n>]');
    if (extra.length > 0) throw new UsageError(`extract 只接受一个网址，多余的参数：${extra.join(' ')}`);
    if (!REMOTE_URL_RE.test(url.trim())) throw new UsageError(`extract 只接受 http(s) 网址：${url}`);
    const maxChars = parseMaxChars(values['max-chars']);

    let article;
    try {
        article = await service.extractArticle({ url, maxChars });
    } catch (err) {
        log(`提取失败：${errText(err)}`);
        return EXIT.FAILED;
    }

    if (values.json) { out(JSON.stringify(article)); return EXIT.OK; }
    process.stdout.write(article.markdown.endsWith('\n') ? article.markdown : `${article.markdown}\n`);
    log(`标题：${article.title || '（无）'}；提取方式：${article.extraction || '（未知）'}；`
        + `字数：${article.wordCount}；图片 ${article.images.length} 张（只列地址，未下载）`);
    if (article.truncated) log(`注意：正文超过 ${maxChars} 字符，已截断；--max-chars <n> 可调大上限`);
    return EXIT.OK;
}

// --max-chars：正整数；省略时取服务层的默认上限
function parseMaxChars(value) {
    if (value === undefined) return service.DEFAULT_EXTRACT_MAX_CHARS;
    const parsed = Number(String(value).trim());
    if (!Number.isInteger(parsed) || parsed < 1) throw new UsageError(`--max-chars 须为正整数，实际：${value}`);
    return parsed;
}

// ==================== formats ====================

async function cmdFormats(values) {
    const formats = await service.describeFormats();
    const { targets, capabilities, extensions } = formats;
    const { pdfBackend, raster, mineru, validator, libreoffice } = capabilities;
    if (values.json) { out(JSON.stringify(formats)); return EXIT.OK; }
    out(`MarkFlow ${pkg.version} 可用转换目标`);
    out(`  Office/PDF 文件 → ${targets.office.join('、')}`);
    out(`  Markdown/专利XML → ${targets.markup.join('、')}`);
    out(`  网页 URL        → ${targets.url.join('、')}`);
    out(`  可用输入类型    → ${Object.keys(targets.inputs).join(' ')}`);
    out(`  受理扩展名      → ${extensions.join(' ')}`);
    out(`  PDF 后端        → ${describeBackend(pdfBackend)}`);
    out(`  栅格化后端      → ${describeBackend(raster)}`);
    out(`  DTD 校验器      → ${describeBackend(validator)}`);
    out(`  LibreOffice     → ${describeBackend(libreoffice)}`);
    out(`  MinerU 令牌     → ${describeMineru(mineru)}`);
    out(`  HTML 主题       → ${capabilities.themes.join('、')}`);
    out(`  XML profile     → ${capabilities.xmlProfiles.join('、')}`);
    return EXIT.OK;
}

// 后端探测结果的一行文案：可用时给名称，否则给安装提示
const describeBackend = (backend) => (backend.available ? backend.name : `不可用（${backend.hint}）`);
// 令牌状态只报是否已配置与来源；未配置时给出配置入口
const describeMineru = (mineru) => (mineru.configured
    ? `已配置（来源：${mineru.source}）`
    : '未配置（PDF 解析走本地后端；markflow config set mineru-token <令牌> 可配置）');

// ==================== config ====================

async function cmdConfig(values, args) {
    const [action, name, value] = args;
    if (action === 'get') return await configGet(values);
    if (action === 'set') return await configSet(name, value);
    if (action === 'unset') return await configUnset(name);
    throw new UsageError(`config 需要子动作：get | set <项> <值> | unset <项>（可用项：${configNames()}）`);
}

const configNames = () => CONFIG_ITEMS.map((item) => item.name).join('、');

function findConfigItem(name) {
    const item = CONFIG_ITEMS.find((candidate) => candidate.name === name);
    if (!item) throw new UsageError(`未知配置项：${name || '（缺少项名）'}（可用：${configNames()}）`);
    return item;
}

async function configSet(name, value) {
    const item = findConfigItem(name);
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) throw new UsageError(`config set ${item.name} 需要取值：markflow config set ${item.name} <取值>`);
    await setConfig({ [item.key]: text });
    out(`已保存：${item.label} 写入 ${getConfigPath()}（文件权限 0600，取值不回显）`);
    return EXIT.OK;
}

async function configUnset(name) {
    const item = findConfigItem(name);
    await setConfig({ [item.key]: null });
    out(`已删除：${item.label} 已从 ${getConfigPath()} 移除`);
    const status = await describeConfigItem(item);
    // 环境变量等其它来源仍可能提供取值，删除配置文件并不等于停用
    if (status.configured) log(`注意：${item.label}仍可由其它来源取得（来源：${status.source}）`);
    return EXIT.OK;
}

async function configGet(values) {
    const items = [];
    for (const item of CONFIG_ITEMS) items.push(await describeConfigItem(item));
    if (values.json) { out(JSON.stringify({ configPath: getConfigPath(), items })); return EXIT.OK; }
    out(`MarkFlow ${pkg.version} 配置文件：${getConfigPath()}`);
    for (const item of items) {
        const state = item.configured ? `已配置（来源：${item.source}）` : '未配置';
        out(`${padRight(`  ${item.name}`, FLAG_COLUMN)}${item.label}：${state}；配置文件中${item.inConfigFile ? '已写入' : '未写入'}`);
    }
    out('  （只报是否已配置与来源，取值一律不回显）');
    return EXIT.OK;
}

// 单项状态：是否已配置、当前来源、配置文件中是否写过；一律不含取值
async function describeConfigItem(item) {
    const config = await readConfig();
    const stored = config[item.key];
    const { token, source } = await item.probe();
    return {
        name: item.name,
        label: item.label,
        configured: Boolean(token),
        source,
        inConfigFile: typeof stored === 'string' && stored.trim() !== '',
    };
}

// ==================== mcp ====================

async function cmdMcp() {
    await require('../mcp/server').start();
    return null;
}

// ==================== 通用工具 ====================

// CJK 字符在终端占两列，按显示宽度补空格才能让说明文字对齐
const CJK_RE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const displayWidth = (text) => [...text].reduce((sum, char) => sum + (CJK_RE.test(char) ? 2 : 1), 0);
const padRight = (text, width) => {
    const padding = width - displayWidth(text);
    return padding > 0 ? text + ' '.repeat(padding) : `${text} `;
};

// convert 选项段：一行一个选项，说明与取值约束取自 converters/options.js 的描述树
function convertOptionLines() {
    return CONVERT_FLAGS.map((item) => {
        const head = `  --${item.flag}${item.value ? ` ${item.value}` : ''}`;
        const description = item.description || descriptionOf(item.paths);
        const note = item.note ? `；${item.note}` : '';
        return `${padRight(head, FLAG_COLUMN)}${description}${service.describeOptionHint(item.paths)}${note}`;
    });
}

// 说明取首条路径的描述；多条路径之间的取值差异由 describeOptionHint 的括注给出
function descriptionOf(paths) {
    const spec = service.describeOptionSpec(paths[0]);
    return spec ? spec.description : '';
}

function configItemLines() {
    return CONFIG_ITEMS.map((item) => `${padRight(`  ${item.name}`, FLAG_COLUMN)}${item.label}，写入 ~/.markflow/config.json（权限 0600），取值不回显`);
}

function printUsage() {
    out(`MarkFlow ${pkg.version} —— 知识库文件转换命令行

用法：markflow <子命令> [选项]

  convert <输入...>   转换本地文件、目录或 http(s) 网页，输入可多个；目录展开为其下受支持的文件
                      （.xml、.zip 须显式给出）；专利五书目录（内含 10000N/10000N.xml 或五书 XML）整体作为一项输入
  extract <网址>      抓取网页正文：Markdown 写标准输出，不落盘、不下载图片
  formats             列出可用的输入类型、转换目标与运行时能力
  config              读写 ~/.markflow/config.json：get | set <项> <值> | unset <项>
  mcp                 以 stdio 方式启动 MCP 服务，供 agent 调用

通用选项：
  --to <目标>         bundle | docx | pdf | html | xml；省略时按输入类型取默认值（Office/PDF/网页 → bundle，
                      Markdown 与专利五书 XML（.xml、案卷 .zip、五书目录）→ docx）
  --out <目录>        输出目录，必须已存在；默认取 MARKFLOW_OUTPUT_DIR，再回退到当前目录
  --json              stdout 只输出一行 JSON 结果；不输出进度，告警随结果进 JSON，其余信息走 stderr
  --concurrency <n>   convert 的并发数，默认 ${DEFAULT_CONCURRENCY}；取值非法时告警并按默认值执行
  --max-chars <n>     extract 返回 Markdown 的字符上限，默认 ${service.DEFAULT_EXTRACT_MAX_CHARS}，超出即截断并提示
  --clean             convert：写入前清理产物目录中本工具生成的旧产物，用户放入的其它文件保留
  --skip-existing     convert：主产物已存在即跳过该项，不解析、不改动任何文件；与 --clean 同给时以跳过为准
  --no-<开关>         关闭布尔开关，如 --no-mineru-formula；同一开关以最后一次出现为准
  -h, --help          显示本说明
  -v, --version       显示版本号

路径写法：输入与 --out 均支持 ~ 与 file:// 写法，相对路径按当前工作目录解析。
中断：转换中按一次 Ctrl+C 停止领取新任务并等待进行中的任务结束（未开始的记为已取消，退出码 2），再按一次立即退出。

convert 的转换选项：
${convertOptionLines().join('\n')}

config 可配置项：
${configItemLines().join('\n')}

退出码：0 全部成功；1 参数错误或运行异常；2 存在失败项（extract 为提取失败）`);
}

main(process.argv.slice(2))
    .then((code) => {
        // 不调用 process.exit，避免 stdout 为管道时输出被截断
        if (typeof code === 'number') process.exitCode = code;
    })
    .catch((err) => {
        log(`执行失败：${errText(err)}`);
        process.exitCode = EXIT.USAGE;
    });
