/**
 * CJS 侧加载 ESM-only 的 unified 生态
 *
 * unified v11+ 仅提供 ESM 入口，本项目是 CJS，故用 `await import()` 动态加载。
 * 缓存的是 Promise 而非结果：并发的首次调用共享同一次加载；加载失败则清空缓存，允许重试。
 *
 * 返回：{ unified, remarkParse, remarkStringify, remarkGfm, remarkRehype, rehypeStringify }
 */

let pending = null;

async function loadUnified() {
    if (!pending) {
        pending = importAll().catch((err) => {
            pending = null;
            throw err;
        });
    }
    return pending;
}

async function importAll() {
    const [
        unifiedMod,
        remarkParseMod,
        remarkStringifyMod,
        remarkGfmMod,
        remarkRehypeMod,
        rehypeStringifyMod,
    ] = await Promise.all([
        import('unified'),
        import('remark-parse'),
        import('remark-stringify'),
        import('remark-gfm'),
        import('remark-rehype'),
        import('rehype-stringify'),
    ]);

    return Object.freeze({
        unified: unifiedMod.unified,
        remarkParse: remarkParseMod.default,
        remarkStringify: remarkStringifyMod.default,
        remarkGfm: remarkGfmMod.default,
        remarkRehype: remarkRehypeMod.default,
        rehypeStringify: rehypeStringifyMod.default,
    });
}

module.exports = { loadUnified };
