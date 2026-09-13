/**
 * IR → XML（xml 目标入口）
 *
 * 按 options.xml.profile 分派：
 *   generic → renderers/xml/generic.js  通用文档结构（命名空间 urn:markflow:document:1），产物 {name}.xml，
 *             图片沿用 images/ 相对引用，由调度器连同 doc.assets 落盘
 *   patent  → renderers/xml/patent.js   国知局专利五书分文件 + {name}.zip + precheck.json，图片改为裸文件名
 *             平铺在 {name}/ 根下（omitDocAssets 为 true，调度器不再合并 doc.assets）
 * 返回 { files, assets, extras, warnings, omitDocAssets, title? }（渲染器契约 v3 的 files 对象形态，外加
 * warnings、omitDocAssets 与可选 title——patent 以发明名称覆盖结果信封的 title——由 converters/index.js 合并进结果）。
 * profile 实现按需 require。
 */
const { normalizeOptions } = require('../options');

const PROFILE_MODULES = Object.freeze({ generic: './xml/generic', patent: './xml/patent' });

async function render(doc, options, context = {}) {
    if (!doc || typeof doc !== 'object') throw new Error('xml 渲染器需要 doc 对象');
    const normalized = normalizeOptions(options);
    const request = PROFILE_MODULES[normalized.xml.profile];
    if (!request) throw new Error(`未知的 xml profile：${String(normalized.xml.profile)}`);
    const result = await require(request).render(doc, normalized, context);
    return {
        files: result.files,
        assets: Array.isArray(result.assets) ? result.assets : [],
        extras: Array.isArray(result.extras) ? result.extras : [],
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        omitDocAssets: Boolean(result.omitDocAssets),
        ...(Array.isArray(result.issues) ? { issues: result.issues } : {}),
        ...(typeof result.title === 'string' && result.title.trim() ? { title: result.title.trim() } : {}),
    };
}

module.exports = { render, PROFILE_MODULES };
