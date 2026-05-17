/**
 * URL → IR
 * 调 legacy/url.convert() 抓取 + 解析 + 下载图片，再反向解析为 mdast
 */
const legacyUrl = require('../legacy/url');
const { loadUnified } = require('../ir/unified-loader');
const { createDocument } = require('../ir/schema');

async function parse(url, meta = {}) {
    const { outputDir } = meta;
    if (!outputDir) {
        throw new Error('parsers/url 需要 meta.outputDir');
    }
    if (typeof url !== 'string' || !url.trim()) {
        throw new Error('parsers/url 期望 source 为非空 URL 字符串');
    }

    const legacyResult = await legacyUrl.convert(url.trim(), outputDir);

    const { unified, remarkParse } = await loadUnified();
    const ir = unified().use(remarkParse).parse(legacyResult.markdown);

    return createDocument({
        kind: 'document',
        ir,
        meta: {
            sourceType: 'url',
            sourceUrl: url,
            title: legacyResult.title,
            folderName: legacyResult.folderName,
            imagesCount: legacyResult.imagesCount,
            legacyOutputPath: legacyResult.outputPath,
            legacyMdPath: legacyResult.mdPath,
            ...meta,
        },
    });
}

module.exports = { parse };
