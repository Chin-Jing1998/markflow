/**
 * CLI 与 MCP 共用的服务层
 *
 * 两个入口对外承诺同一套结果结构（README：MCP「返回结构同命令行的 --json」），
 * 故能力探测、任务规划、批处理与结果信封统一在此实现，入口只做各自的表示层：
 * CLI 负责参数解析、人类可读输出与退出码，MCP 负责 schema 与协议信封。
 *
 * probeCapabilities() → { sofficeAvailable, pdfBackend }
 * describeFormats()   → { targets, capabilities, version }
 * planTasks(raws, requestedTarget, cwd) → [{ raw, input, target }]，任一项不合法即抛中文错误
 * runConversion({ tasks, outputDir, concurrency, onEvent }) → { ok, outputDir, results, errors }
 *
 * 能力探测与转换均按需 require 重模块，保持 require('./service') 本身轻量。
 */
const { convert, listTargets, runBatch } = require('./index');
const { resolveTarget, classifyInput } = require('./targets');
const { errText } = require('./util');
const pkg = require('../package.json');

const DEFAULT_CONCURRENCY = 2;

/** 运行时能力探测：LibreOffice 与 PDF 后端 */
async function probeCapabilities() {
    const [sofficeAvailable, pdfBackend] = await Promise.all([
        require('./soffice').isAvailable(),
        require('./pdf/backend').detect(),
    ]);
    return { sofficeAvailable: Boolean(sofficeAvailable), pdfBackend };
}

/** 能力矩阵 + 版本号，CLI 的 formats 与 MCP 的 list_formats 同源 */
async function describeFormats() {
    const capabilities = await probeCapabilities();
    const targets = listTargets({
        sofficeAvailable: capabilities.sofficeAvailable,
        pdfBackend: capabilities.pdfBackend.available ? capabilities.pdfBackend : null,
    });
    return { targets, capabilities, version: pkg.version };
}

/** 归类输入并裁决目标；不触碰文件系统，存在性由调用方或 convert 负责 */
function planTasks(raws, requestedTarget, cwd) {
    return raws.map((raw) => {
        const { input, type } = classifyInput(raw, cwd);
        return { raw, input, target: resolveTarget(type, requestedTarget) };
    });
}

/** 执行批量转换并生成两个入口共用的结果信封 */
async function runConversion({ tasks, outputDir, concurrency = DEFAULT_CONCURRENCY, onEvent } = {}) {
    const { results, errors } = await runBatch(tasks, { concurrency, onEvent }, (task, onProgress) =>
        convert({ input: task.input, target: task.target, outputDir, onProgress }),
    );
    return {
        ok: errors.length === 0,
        outputDir,
        results: results.map(({ idx, result }) => describeResult(tasks[idx].raw, result)),
        errors: errors.map(({ idx, error }) => ({ input: tasks[idx].raw, error: errText(error) })),
    };
}

/** 单项结果的对外形状；MCP 在此基础上按 returnContent 追加 content 字段 */
function describeResult(input, result) {
    return {
        input,
        target: result.target,
        name: result.name,
        title: result.title,
        outputPath: result.outputPath,
        outputs: result.outputs || {},
        imagesCount: result.imagesCount,
        warnings: result.warnings || [],
    };
}

module.exports = { probeCapabilities, describeFormats, planTasks, runConversion, DEFAULT_CONCURRENCY };
