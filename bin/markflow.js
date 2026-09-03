#!/usr/bin/env node
/**
 * MarkFlow 命令行入口
 *
 * 子命令：convert（批量转换）、formats（能力矩阵）、mcp（MCP stdio 服务）。
 * 输出约定：--json 模式下 stdout 只输出一行 JSON，进度与错误一律走 stderr，便于 agent 直接解析。
 * 退出码：0 全部成功；1 参数错误或运行异常；2 存在失败项。
 * 本文件零第三方依赖，参数解析用 node:util 的 parseArgs。
 */
const path = require('path');
const { parseArgs } = require('node:util');

const service = require('../converters/service');
const { errText, isFile, isDirectory } = require('../converters/util');
const pkg = require('../package.json');

const EXIT = Object.freeze({ OK: 0, USAGE: 1, FAILED: 2 });
const DEFAULT_CONCURRENCY = service.DEFAULT_CONCURRENCY;
const OPTIONS = Object.freeze({
    to: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' },
    concurrency: { type: 'string' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
});

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
        if (command === 'mcp') return await cmdMcp();
        throw new UsageError(`未知子命令：${command}（可用：convert、formats、mcp）`);
    } catch (err) {
        log(err instanceof UsageError ? err.message : `执行失败：${errText(err)}`);
        return EXIT.USAGE;
    }
}

// ==================== convert ====================

async function cmdConvert(values, inputs) {
    if (inputs.length === 0) throw new UsageError('convert 需要至少一个输入：文件路径或 http(s) 网址');
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
    const payload = await service.runConversion({ tasks, outputDir, concurrency, onEvent });

    if (asJson) out(JSON.stringify(payload));
    else {
        payload.results.forEach((item) => out(item.outputPath));
        log(`汇总：成功 ${payload.results.length} 项，失败 ${payload.errors.length} 项，输出目录 ${outputDir}`);
    }
    return payload.ok ? EXIT.OK : EXIT.FAILED;
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
    const { pdfBackend } = capabilities;
    if (values.json) { out(JSON.stringify(formats)); return EXIT.OK; }
    out(`MarkFlow ${pkg.version} 可用转换目标`);
    out(`  Office/PDF 文件 → ${targets.office.join('、')}`);
    out(`  Markdown        → ${targets.markup.join('、')}`);
    out(`  网页 URL        → ${targets.url.join('、')}`);
    out(`  可用输入类型    → ${Object.keys(targets.inputs).join(' ')}`);
    out(`  LibreOffice     → ${capabilities.sofficeAvailable ? '可用' : '不可用（doc/xls/ppt 旧格式不受支持）'}`);
    out(`  PDF 后端        → ${pdfBackend.available ? pdfBackend.name : `不可用（${pdfBackend.hint}）`}`);
    return EXIT.OK;
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

function printUsage() {
    out(`MarkFlow ${pkg.version} —— 知识库文件转换命令行

用法：markflow <子命令> [选项]

  convert <输入...>   转换本地文件或 http(s) 网页，输入可多个
  formats             列出可用的输入类型、转换目标与运行时能力
  mcp                 以 stdio 方式启动 MCP 服务，供 agent 调用

选项：
  --to <目标>         bundle | docx | pdf；省略时按输入类型取默认值（Office/PDF/网页 → bundle，Markdown → docx）
  --out <目录>        输出目录，必须已存在；默认取 MARKFLOW_OUTPUT_DIR，再回退到当前目录
  --json              stdout 只输出一行 JSON 结果，其余信息走 stderr
  --concurrency <n>   convert 的并发数，默认 ${DEFAULT_CONCURRENCY}
  -h, --help          显示本说明
  -v, --version       显示版本号

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
