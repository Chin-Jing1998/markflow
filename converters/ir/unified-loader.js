/**
 * CJS 侧加载 ESM-only 的 unified 生态
 *
 * unified v11+ 仅提供 ESM 入口，本项目是 CJS，故用 `await import()` 动态加载。
 * Node.js 自身有模块缓存，但额外维护 cache 减少 await 开销。
 */

let cache = null;

async function loadUnified() {
    if (cache) return cache;

    const [
        unifiedMod,
        remarkParseMod,
        remarkStringifyMod,
        remarkRehypeMod,
        remarkGfmMod,
        rehypeStringifyMod,
        rehypeParseMod,
        mdastToMarkdownMod,
    ] = await Promise.all([
        import('unified'),
        import('remark-parse'),
        import('remark-stringify'),
        import('remark-rehype'),
        import('remark-gfm'),
        import('rehype-stringify'),
        import('rehype-parse'),
        import('mdast-util-to-markdown'),
    ]);

    cache = {
        unified: unifiedMod.unified,
        remarkParse: remarkParseMod.default,
        remarkStringify: remarkStringifyMod.default,
        remarkRehype: remarkRehypeMod.default,
        remarkGfm: remarkGfmMod.default,
        rehypeStringify: rehypeStringifyMod.default,
        rehypeParse: rehypeParseMod.default,
        toMarkdown: mdastToMarkdownMod.toMarkdown,
    };
    return cache;
}

module.exports = { loadUnified };
