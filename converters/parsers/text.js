/**
 * Text/HTML 粘贴 → IR
 * 调 legacy/text.convert()（内部自动检测 HTML 或纯文本），再反向解析为 mdast
 */
const legacyText = require('../legacy/text');
const { loadUnified } = require('../ir/unified-loader');
const { createDocument } = require('../ir/schema');

async function parse(text, meta = {}) {
    const { outputDir, title } = meta;
    if (!outputDir) {
        throw new Error('parsers/text 需要 meta.outputDir');
    }
    if (typeof text !== 'string') {
        throw new Error('parsers/text 期望 source 为字符串');
    }

    const legacyResult = await legacyText.convert(text, title || '', outputDir);

    const { unified, remarkParse } = await loadUnified();
    const ir = unified().use(remarkParse).parse(legacyResult.markdown);

    return createDocument({
        kind: 'document',
        ir,
        meta: {
            sourceType: 'text',
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
