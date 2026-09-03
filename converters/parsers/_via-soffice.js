/**
 * 旧二进制格式（doc / xls / ppt）→ IR 的公共骨架
 *
 * 契约：parse({ path }, ctx)。经 soffice 把源文件转为对应的新格式落到临时目录，
 * 再交给新格式 parser 解析；临时目录在 finally 中清理，对外无落盘副作用。
 * meta.sourceName 始终保留原始文件名，不暴露中间产物名。
 */
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const soffice = require('../soffice');

/**
 * @param {string} sourceExt 源格式短名（doc / xls / ppt），用于错误信息与临时目录前缀
 * @param {string} targetExt soffice 转换目标扩展名（docx / xlsx / pptx）
 * @param {{ parse: Function }} delegate 目标格式的 parser
 * @returns {(input: { path: string }, ctx?: { sourceName?: string, onProgress?: Function }) => Promise<object>}
 */
function createSofficeParser(sourceExt, targetExt, delegate) {
    return async function parse(input, ctx = {}) {
        if (!input || typeof input.path !== 'string' || !input.path) {
            throw new Error(`parsers/${sourceExt} 需要 input.path（文件绝对路径）`);
        }
        const absPath = path.resolve(input.path);
        const sourceName = ctx.sourceName || path.basename(absPath);

        const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), `markflow-${sourceExt}-`));
        try {
            const convertedPath = await soffice.convertFile(absPath, targetExt, { outDir });
            const doc = await delegate.parse({ path: convertedPath }, { ...ctx, sourceName });
            return { ...doc, meta: { ...doc.meta, sourceName } };
        } finally {
            // 临时目录清理失败不影响解析结果
            await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
        }
    };
}

module.exports = { createSofficeParser };
