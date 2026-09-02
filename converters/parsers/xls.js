/**
 * XLS（旧 Excel 二进制）→ IR
 *
 * 契约：parse({ path }, ctx)。经 soffice 把源文件转为 .xlsx 落到临时目录，
 * 再交给 parsers/xlsx 解析；临时目录在 finally 中清理，对外无落盘副作用。
 * meta.sourceName 始终保留原始文件名，不暴露中间产物名。
 */
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const soffice = require('../../server/soffice');
const xlsxParser = require('./xlsx');

/**
 * @param {{ path: string }} input 源文件绝对路径
 * @param {{ sourceName?: string, onProgress?: Function }} [ctx]
 */
async function parse(input, ctx = {}) {
    const absPath = resolveInputPath(input);
    const sourceName = ctx.sourceName || path.basename(absPath);

    const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'markflow-xls-'));
    try {
        const convertedPath = await soffice.convertFile(absPath, 'xlsx', { outDir });
        const doc = await xlsxParser.parse({ path: convertedPath }, { ...ctx, sourceName });
        return { ...doc, meta: { ...doc.meta, sourceName } };
    } finally {
        await removeDir(outDir);
    }
}

function resolveInputPath(input) {
    if (input && typeof input.path === 'string' && input.path) {
        return path.resolve(input.path);
    }
    throw new Error('parsers/xls 需要 input.path（文件绝对路径）');
}

async function removeDir(dir) {
    try {
        await fsp.rm(dir, { recursive: true, force: true });
    } catch (err) {
        // 临时目录清理失败不影响解析结果
    }
}

module.exports = { parse };
