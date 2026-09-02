#!/usr/bin/env node
/**
 * MarkFlow 命令行入口
 *
 * 子命令：convert（批量转换）、formats（能力矩阵）、serve（本地 HTTP 服务）、mcp（MCP stdio 服务）。
 * 输出约定：--json 模式下 stdout 只输出一行 JSON，进度与错误一律走 stderr，便于 agent 直接解析。
 * 退出码：0 全部成功；1 参数错误或运行异常；2 存在失败项。
 * 本文件零第三方依赖，参数解析用 node:util 的 parseArgs。
 */
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('node:util');

const { convert, listTargets, runBatch } = require('../converters');
const { resolveTarget, classifyInput } = require('../converters/targets');
const pkg = require('../package.json');

const EXIT = Object.freeze({ OK: 0, USAGE: 1, FAILED: 2 });
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_HOST = '127.0.0.1';
const OPTIONS = Object.freeze({
    to: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' },
    concurrency: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
});

// 参数层面的错误：只打印说明并以 EXIT.USAGE 退出，不启动转换
class UsageError extends Error {}

const out = (text) => process.stdout.write(`${text}\n`);
const log = (text) => process.stderr.write(`${text}\n`);
const messageOf = (err) => (err && err.message ? err.message : String(err));

// ==================== 入口 ====================

// 返回数字表示退出码；返回 null 表示保持进程运行（serve / mcp）
async function main(argv) {
    let parsed;
    try {
        parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
    } catch (err) {
        log(`参数错误：${messageOf(err)}`);
        return EXIT.USAGE;
    }
    const { values, positionals } = parsed;
    const command = positionals[0];
    if (values.version) { out(pkg.version); return EXIT.OK; }
    if (values.help || !command) { printUsage(); return EXIT.OK; }
    try {
        if (command === 'convert') return await cmdConvert(values, positionals.slice(1));
        if (command === 'formats') return await cmdFormats(values);
        if (command === 'serve') return await cmdServe(values);
        if (command === 'mcp') return await cmdMcp();
        throw new UsageError(`未知子命令：${command}（可用：convert、formats、serve、mcp）`);
    } catch (err) {
        log(err instanceof UsageError ? err.message : `执行失败：${messageOf(err)}`);
        return EXIT.USAGE;
    }
}

// ==================== convert ====================

async function cmdConvert(values, inputs) {
    if (inputs.length === 0) throw new UsageError('convert 需要至少一个输入：文件路径或 http(s) 网址');
    const outputDir = resolveOutputDir(values.out);
    const tasks = inputs.map((raw) => planTask(raw, values.to));
    const asJson = Boolean(values.json);
    const concurrency = parsePositiveInt(values.concurrency, DEFAULT_CONCURRENCY);

    // 人类模式下每项开始与结束各打一行进度到 stderr；--json 模式保持 stdout 纯净
    const onEvent = (event) => {
        if (asJson) return;
        const task = tasks[event.idx];
        if (event.type === 'start') log(`开始：${task.raw} → ${task.target}`);
        else if (event.type === 'item') {
            log(event.ok ? `完成：${task.raw} → ${event.result.outputPath}` : `失败：${task.raw} → ${messageOf(event.error)}`);
        }
    };
    const { results, errors } = await runBatch(tasks, { concurrency, onEvent }, (task, onProgress) =>
        convert({ input: task.input, target: task.target, outputDir, onProgress }),
    );

    const payload = {
        ok: errors.length === 0,
        outputDir,
        results: results.map(({ idx, result }) => ({
            input: tasks[idx].raw, target: result.target, name: result.name, title: result.title,
            outputPath: result.outputPath, outputs: result.outputs,
            imagesCount: result.imagesCount, warnings: result.warnings,
        })),
        errors: errors.map(({ idx, error }) => ({ input: tasks[idx].raw, error: messageOf(error) })),
    };
    if (asJson) out(JSON.stringify(payload));
    else {
        payload.results.forEach((item) => out(item.outputPath));
        log(`汇总：成功 ${payload.results.length} 项，失败 ${payload.errors.length} 项，输出目录 ${outputDir}`);
    }
    return errors.length === 0 ? EXIT.OK : EXIT.FAILED;
}

// 归类输入、预检存在性并裁决目标；任一不合法即抛 UsageError（不启动转换）
function planTask(raw, requested) {
    try {
        const { input, type } = classifyInput(raw, process.cwd());
        if (input.path && !isFile(input.path)) throw new Error(`输入文件不存在：${input.path}`);
        return { raw, input, target: resolveTarget(type, requested) };
    } catch (err) {
        throw new UsageError(messageOf(err));
    }
}

// --out → 环境变量 MARKFLOW_OUTPUT_DIR → 当前工作目录；目录必须已存在
function resolveOutputDir(value) {
    const dir = path.resolve(process.cwd(), value || process.env.MARKFLOW_OUTPUT_DIR || process.cwd());
    if (!isDirectory(dir)) throw new UsageError(`输出目录不存在：${dir}`);
    return dir;
}

// ==================== formats ====================

async function cmdFormats(values) {
    const capabilities = await probeCapabilities();
    const { pdfBackend } = capabilities;
    const targets = listTargets({
        sofficeAvailable: capabilities.sofficeAvailable,
        pdfBackend: pdfBackend.available ? pdfBackend : null,
    });
    if (values.json) { out(JSON.stringify({ targets, capabilities, version: pkg.version })); return EXIT.OK; }
    out(`MarkFlow ${pkg.version} 可用转换目标`);
    out(`  Office/PDF 文件 → ${targets.office.join('、')}`);
    out(`  Markdown        → ${targets.markup.join('、')}`);
    out(`  网页 URL        → ${targets.url.join('、')}`);
    out(`  可用输入类型    → ${Object.keys(targets.inputs).join(' ')}`);
    out(`  LibreOffice     → ${capabilities.sofficeAvailable ? '可用' : '不可用（doc/xls/ppt 旧格式不受支持）'}`);
    out(`  PDF 后端        → ${pdfBackend.available ? pdfBackend.name : `不可用（${pdfBackend.hint}）`}`);
    return EXIT.OK;
}

// 运行时能力探测：LibreOffice 与 PDF 后端
async function probeCapabilities() {
    const [sofficeAvailable, pdfBackend] = await Promise.all([
        require('../server/soffice').isAvailable(),
        require('../converters/pdf/backend').detect(),
    ]);
    return { sofficeAvailable: Boolean(sofficeAvailable), pdfBackend };
}

// ==================== serve / mcp ====================

async function cmdServe(values) {
    const { startServer } = require('../server');
    const host = values.host || DEFAULT_HOST;
    const handle = await startServer({
        host,
        port: parsePositiveInt(values.port, 0),
        outputDir: values.out ? path.resolve(process.cwd(), values.out) : undefined,
    });
    log(`MarkFlow 服务已启动：http://${host}:${handle.port}`);
    if (handle.token) log(`访问令牌：${handle.token}`);
    log('按 Ctrl+C 停止服务');
    const stop = () => {
        Promise.resolve(typeof handle.close === 'function' ? handle.close() : undefined)
            .catch((err) => log(`停止服务时出错：${messageOf(err)}`))
            .then(() => process.exit(EXIT.OK));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return null;
}

async function cmdMcp() {
    await require('../mcp/server').start();
    return null;
}

// ==================== 通用工具 ====================

// 路径不存在时返回 null 而非抛异常
const statOrNull = (target) => fs.statSync(target, { throwIfNoEntry: false }) || null;
const isFile = (target) => { const stat = statOrNull(target); return Boolean(stat && stat.isFile()); };
const isDirectory = (target) => { const stat = statOrNull(target); return Boolean(stat && stat.isDirectory()); };

function parsePositiveInt(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function printUsage() {
    out(`MarkFlow ${pkg.version} —— 知识库文件转换命令行

用法：markflow <子命令> [选项]

  convert <输入...>   转换本地文件或 http(s) 网页，输入可多个
  formats             列出可用的输入类型、转换目标与运行时能力
  serve               启动本地 HTTP 服务（地址与令牌打印到 stderr）
  mcp                 以 stdio 方式启动 MCP 服务，供 agent 调用

选项：
  --to <目标>         bundle | docx | pdf；省略时按输入类型取默认值（Office/PDF/网页 → bundle，Markdown → docx）
  --out <目录>        输出目录，必须已存在；默认取 MARKFLOW_OUTPUT_DIR，再回退到当前目录
  --json              stdout 只输出一行 JSON 结果，其余信息走 stderr
  --concurrency <n>   convert 的并发数，默认 ${DEFAULT_CONCURRENCY}
  --host <地址>       serve 监听地址，默认 ${DEFAULT_HOST}
  --port <端口>       serve 监听端口，默认 0（由系统分配）
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
        log(`执行失败：${messageOf(err)}`);
        process.exitCode = EXIT.USAGE;
    });
