/**
 * DOCX → IR
 *
 * 策略：调 legacy/word.convert() 拿 markdown + 提取图片 + 写出 .md，
 *      再用 remark-parse 把 markdown 反向解析为 mdast 作为 IR。
 *
 * 副作用：legacy 会写出 {outputDir}/{folderName}/{folderName}.md 和 images/
 *        这与设计中"一文件夹累加多格式"一致——后续 renderer 写 html/json
 *        会落在同一 folderName 下，多格式共存。
 *
 * 输入：buffer (Buffer) — .docx 文件二进制
 * meta 必填：outputDir、sourceName
 */
const legacyWord = require('../legacy/word');
const { loadUnified } = require('../ir/unified-loader');
const { createDocument } = require('../ir/schema');

async function parse(buffer, meta = {}) {
    const { outputDir, sourceName = '未命名.docx' } = meta;
    if (!outputDir) {
        throw new Error('parsers/docx 需要 meta.outputDir');
    }
    if (!Buffer.isBuffer(buffer)) {
        throw new Error('parsers/docx 期望 source 为 Buffer');
    }

    const legacyResult = await legacyWord.convert(buffer, sourceName, outputDir);

    const { unified, remarkParse } = await loadUnified();
    const ir = unified().use(remarkParse).parse(legacyResult.markdown);

    return createDocument({
        kind: 'document',
        ir,
        meta: {
            sourceType: 'docx',
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
