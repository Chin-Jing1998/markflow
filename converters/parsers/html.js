/**
 * HTML → IR
 *
 * 路径：HTML 字符串 → turndown → Markdown 字符串 → remark-parse → mdast
 *
 * 选 turndown 路径而非 rehype-remark 的理由：
 *   1) 不增加新依赖；
 *   2) 与 legacy/url.js、legacy/text.js 同源行为，保留对微信/知乎等富 HTML 的处理细节；
 *   3) round-trip 保真度对纯文档场景足够。
 *
 * P2 若需要更高保真，可改用 rehype-parse + rehype-remark 直接得到 mdast。
 */
const { loadUnified } = require('../ir/unified-loader');
const { createDocument } = require('../ir/schema');
const { createRichTurndownService } = require('../ir/util');

async function parse(html, meta = {}) {
    const turndown = createRichTurndownService();
    const md = turndown.turndown(String(html || ''));
    const { unified, remarkParse } = await loadUnified();
    const ir = unified().use(remarkParse).parse(md);
    return createDocument({
        kind: 'document',
        ir,
        meta: { sourceType: 'html', ...meta },
    });
}

module.exports = { parse };
