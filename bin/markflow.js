#!/usr/bin/env node
/**
 * MarkFlow 命令行入口
 *
 * 子命令：convert（批量转换）、formats（能力矩阵）、config（读写 ~/.markflow/config.json）、mcp（MCP stdio 服务）。
 * 输出约定：--json 模式下 stdout 只输出一行 JSON，进度与错误一律走 stderr，便于 agent 直接解析。
 * 退出码：0 全部成功；1 参数错误或运行异常；2 存在失败项。
 * convert 的转换选项（--theme、--xml-profile 等）在此只做「解析为扁平键」一件事：取值范围、默认值与中文
 * 错误文案都由 converters/options.js 定义，converters/service.js 的 buildOptions 负责映射，--help 的选项段
 * 亦由 describeOptions() 的描述树生成，故新增选项不必在本文件重复维护取值表。
 * 本文件零第三方依赖，参数解析用 node:util 的 parseArgs。
 */
const path = require('path');
const { parseArgs } = require('node:util');

const service = require('../converters/service');
const { describeOptions } = require('../converters/options');
const { setConfig, readConfig, getMineruToken, getConfigPath, CONFIG_TOKEN_KEY } = require('../converters/config');
const { errText, isFile, isDirectory } = require('../converters/util');
const pkg = require('../package.json');

const EXIT = Object.freeze({ OK: 0, USAGE: 1, FAILED: 2 });
const DEFAULT_CONCURRENCY = service.DEFAULT_CONCURRENCY;
// 帮助文案中选项名一列的宽度（终端列数，CJK 字符按两列计）
const FLAG_COLUMN = 28;

// convert 的转换选项：flag 为长选项名，key 为 service.buildOptions 的扁平键，path 指向 describeOptions()
// 描述树中的同一字段（帮助文案的可选值、范围与默认值由它生成）；无 path 的项自带 description。
const CONVERT_FLAGS = Object.freeze([
    { flag: 'theme', key: 'theme', path: 'html.theme', value: '<主题>', note: '同时作用于 html 与 pdf 目标' },
    { flag: 'xml-profile', key: 'xmlProfile', path: 'xml.profile', value: '<profile>' },
    { flag: 'patent-parts', key: 'patentParts', path: 'xml.patent.parts', value: '<部分列表>', note: '逗号分隔' },
    { flag: 'pdf-backend', key: 'pdfBackend', path: 'pdfBackend', value: '<后端>' },
    { flag: 'image-format', key: 'imageFormat', path: 'imageFormat', value: '<格式>' },
    { flag: 'jpeg-quality', key: 'jpegQuality', path: 'jpegQuality', value: '<n>' },
    { flag: 'jpeg-ppi', key: 'jpegPpi', path: 'jpegPpi', value: '<n>' },
    { flag: 'math', key: 'math', path: 'math', value: '<方式>' },
    { flag: 'mineru-model', key: 'mineruModel', path: 'mineru.model', value: '<模型>' },
    { flag: 'mineru-ocr', key: 'mineruOcr', path: 'mineru.ocr', type: 'boolean' },
    { flag: 'mineru-lang', key: 'mineruLang', path: 'mineru.language', value: '<语言>' },
    { flag: 'page-ranges', key: 'pageRanges', path: 'mineru.pageRanges', value: '<范围>' },
    { flag: 'font', key: 'font', path: 'html.fontFamily', value: '<字体栈>' },
    { flag: 'font-size', key: 'fontSize', path: 'html.fontSize', value: '<n>', note: 'docx 目标按 pt 取同一取值' },
    { flag: 'line-height', key: 'lineHeight', path: 'html.lineHeight', value: '<n>' },
    { flag: 'numbering-start', key: 'numberingStart', path: 'xml.numbering.start', value: '<n>' },
    { flag: 'validate', key: 'validate', path: 'xml.validate', type: 'boolean', note: '仅 xml 目标生效，校验结果进 warnings' },
]);

const BASE_OPTIONS = Object.freeze({
    to: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' },
    concurrency: { type: 'string' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
});
const OPTIONS = Object.freeze({
    ...BASE_OPTIONS,
    ...Object.fromEntries(CONVERT_FLAGS.map((item) => [item.flag, { type: item.type || 'string' }])),
});

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
    let parsed;
    try {
        parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
    } catch (err) {
        log(`参数错误：${errText(err)}`);
        return EXIT.USAGE;
    }
    const { values, positionals } = parsed;
    const command = positionals[0];
    if (values.version) { out(pkg.version); return EXIT.OK; }
    if (values.help || !command) { printUsage(); return EXIT.OK; }
    try {
        if (command === 'convert') return await cmdConvert(values, positionals.slice(1));
        if (command === 'formats') return await cmdFormats(values);
        if (command === 'config') return await cmdConfig(values, positionals.slice(1));
        if (command === 'mcp') return await cmdMcp();
        throw new UsageError(`未知子命令：${command}（可用：convert、formats、config、mcp）`);
    } catch (err) {
        log(err instanceof UsageError ? err.message : `执行失败：${errText(err)}`);
        return EXIT.USAGE;
    }
}

// ==================== convert ====================

async function cmdConvert(values, inputs) {
    if (inputs.length === 0) throw new UsageError('convert 需要至少一个输入：文件路径或 http(s) 网址');
    const options = buildConvertOptions(values);
    const validate = Boolean(values.validate);
    const outputDir = await resolveCliOutputDir(values.out);
    const tasks = await planTasks(inputs, values.to);
    const asJson = Boolean(values.json);
    const concurrency = parsePositiveInt(values.concurrency, DEFAULT_CONCURRENCY);

    // 人类模式下每项开始与结束各打一行进度到 stderr；--json 模式保持 stdout 纯净
    const onEvent = (event) => {
        if (asJson) return;
        const task = tasks[event.idx];
        if (event.type === 'start') log(`开始：${task.raw} → ${task.target}`);
        else if (event.type === 'item') {
            log(event.ok ? `完成：${task.raw} → ${event.result.outputPath}` : `失败：${task.raw} → ${errText(event.error)}`);
        }
    };
    const payload = await service.runConversion({ tasks, outputDir, concurrency, onEvent, options });
    // --validate 已作为 xml.validate 进入 options（渲染器据此校验并把结果写入 warnings）；结果信封上另留标记
    const envelope = validate ? { ...payload, validate: true } : payload;

    if (asJson) out(JSON.stringify(envelope));
    else {
        payload.results.forEach((item) => out(item.outputPath));
        log(`汇总：成功 ${payload.results.length} 项，失败 ${payload.errors.length} 项，输出目录 ${outputDir}`);
    }
    return payload.ok ? EXIT.OK : EXIT.FAILED;
}

// 命令行取值 → service.buildOptions 的扁平键；取值非法即参数错误（中文文案来自 converters/options.js）
function buildConvertOptions(values) {
    const flat = {};
    for (const { flag, key } of CONVERT_FLAGS) {
        if (!key || values[flag] === undefined) continue;
        flat[key] = values[flag];
    }
    try {
        return service.buildOptions(flat);
    } catch (err) {
        throw new UsageError(errText(err));
    }
}

// 在服务层规划之上追加 CLI 专属的存在性预检；任一不合法即抛 UsageError（不启动转换）
async function planTasks(inputs, requested) {
    let tasks;
    try {
        tasks = service.planTasks(inputs, requested, process.cwd());
    } catch (err) {
        throw new UsageError(errText(err));
    }
    for (const task of tasks) {
        if (task.input.path && !(await isFile(task.input.path))) {
            throw new UsageError(`输入文件不存在：${task.input.path}`);
        }
    }
    return tasks;
}

// --out → 环境变量 MARKFLOW_OUTPUT_DIR → 当前工作目录；目录必须已存在
async function resolveCliOutputDir(value) {
    const dir = path.resolve(process.cwd(), value || process.env.MARKFLOW_OUTPUT_DIR || process.cwd());
    if (!(await isDirectory(dir))) throw new UsageError(`输出目录不存在：${dir}`);
    return dir;
}

// ==================== formats ====================

async function cmdFormats(values) {
    const formats = await service.describeFormats();
    const { targets, capabilities } = formats;
    const { pdfBackend, raster, mineru } = capabilities;
    if (values.json) { out(JSON.stringify(formats)); return EXIT.OK; }
    out(`MarkFlow ${pkg.version} 可用转换目标`);
    out(`  Office/PDF 文件 → ${targets.office.join('、')}`);
    out(`  Markdown        → ${targets.markup.join('、')}`);
    out(`  网页 URL        → ${targets.url.join('、')}`);
    out(`  可用输入类型    → ${Object.keys(targets.inputs).join(' ')}`);
    out(`  PDF 后端        → ${describeBackend(pdfBackend)}`);
    out(`  栅格化后端      → ${describeBackend(raster)}`);
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

function parsePositiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

// CJK 字符在终端占两列，按显示宽度补空格才能让说明文字对齐
const CJK_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const displayWidth = (text) => [...text].reduce((sum, char) => sum + (CJK_RE.test(char) ? 2 : 1), 0);
const padRight = (text, width) => {
    const padding = width - displayWidth(text);
    return padding > 0 ? text + ' '.repeat(padding) : `${text} `;
};

// convert 选项段：一行一个选项，说明与取值约束取自 converters/options.js 的描述树
function convertOptionLines() {
    const tree = describeOptions();
    return CONVERT_FLAGS.map((item) => {
        const spec = item.path ? resolveDescriptor(tree, item.path) : null;
        const head = `  --${item.flag}${item.value ? ` ${item.value}` : ''}`;
        const description = item.description || (spec ? spec.description : '');
        const note = item.note ? `；${item.note}` : '';
        return `${padRight(head, FLAG_COLUMN)}${description}${hintOf(spec)}${note}`;
    });
}

// 'html.theme' → 描述树中的叶子；顶层按键取，其余层经 fields 下钻
function resolveDescriptor(tree, dotted) {
    return dotted.split('.').reduce((node, key, index) => {
        if (!node) return null;
        return index === 0 ? node[key] : (node.fields ? node.fields[key] : null);
    }, tree);
}

// 取值约束的括注：枚举列可选值，数字列范围，最后附默认值（默认为 null 的可空项不列）
function hintOf(spec) {
    if (!spec) return '';
    const parts = [];
    if (Array.isArray(spec.values)) parts.push(`可选 ${spec.values.join(' | ')}`);
    else if (typeof spec.min === 'number') parts.push(`范围 ${spec.min}–${spec.max}`);
    if (spec.default !== undefined && spec.default !== null) parts.push(`默认 ${spec.default}`);
    return parts.length > 0 ? `（${parts.join('；')}）` : '';
}

function configItemLines() {
    return CONFIG_ITEMS.map((item) => `${padRight(`  ${item.name}`, FLAG_COLUMN)}${item.label}，写入 ~/.markflow/config.json（权限 0600），取值不回显`);
}

function printUsage() {
    out(`MarkFlow ${pkg.version} —— 知识库文件转换命令行

用法：markflow <子命令> [选项]

  convert <输入...>   转换本地文件或 http(s) 网页，输入可多个
  formats             列出可用的输入类型、转换目标与运行时能力
  config              读写 ~/.markflow/config.json：get | set <项> <值> | unset <项>
  mcp                 以 stdio 方式启动 MCP 服务，供 agent 调用

通用选项：
  --to <目标>         bundle | docx | pdf | html | xml；省略时按输入类型取默认值（Office/PDF/网页 → bundle，Markdown → docx）
  --out <目录>        输出目录，必须已存在；默认取 MARKFLOW_OUTPUT_DIR，再回退到当前目录
  --json              stdout 只输出一行 JSON 结果，其余信息走 stderr
  --concurrency <n>   convert 的并发数，默认 ${DEFAULT_CONCURRENCY}
  -h, --help          显示本说明
  -v, --version       显示版本号

convert 的转换选项：
${convertOptionLines().join('\n')}

config 可配置项：
${configItemLines().join('\n')}

退出码：0 全部成功；1 参数错误或运行异常；2 存在失败项`);
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
