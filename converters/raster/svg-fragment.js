'use strict';
/**
 * SVG 图元片段页：把 converters/metafile 生成的 SVG 包成自包含的 HTML 页，交 raster/backend.js 出图
 *
 * buildSvgImageFragment(svg, { width, height }) → html
 *   零边距白底；body 为 inline-block（与 electron-raster-worker.js 的「量取 body 外接矩形」约定一致）；
 *   正文只有一个 <img width height alt="" src="data:image/svg+xml;base64,…">，整页没有任何脚本。
 *   width / height 为目标像素；后端以 dpi 96（scale = 1）出图，故 PNG 像素恒等于该值。
 *
 * 安全（调研报告 4.6 第三层）：CSP 为 default-src 'none'; style-src 'unsafe-inline'; img-src data:，
 *   不含 script-src。SVG 以 base64 data URI 放进 <img>，浏览器按「图像模式」处理——脚本不执行、
 *   外链不加载，即便 SVG 生成层出现疏漏也越不过这一层。base64 的字母表不含 HTML 特殊字符，
 *   故属性值无需再做转义；svg 入参必须是本项目自己生成的字符串，不得直接透传文档来源的内容。
 *
 * 另设本文件而不并入 raster/fragment.js：图元片段页与表格／公式片段页的骨架、CSP 与约束各不相同，
 * 且两者的改动节奏独立。文档骨架的三行拼装与 fragment.js 的 document() 形似，但 CSP 与 css 皆不同，
 * 未作抽取。
 */

/** 目标像素的单边上下限：与 electron-raster-worker.js 的 MAX_EDGE_PX 一致 */
const MIN_EDGE_PX = 1;
const MAX_EDGE_PX = 16000;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
const CSS = 'html,body{margin:0;padding:0;background:#fff}'
    + 'body{display:inline-block;font-size:0;line-height:0}'
    + 'img{display:block}';

/** 边长校验：必须是 1–16000 的有限数，否则抛错由调用方降级为「保持原格式 + 告警」 */
function requireEdge(value, name) {
    const edge = Math.round(Number(value));
    if (!Number.isFinite(edge) || edge < MIN_EDGE_PX || edge > MAX_EDGE_PX) {
        return { error: `buildSvgImageFragment 的 ${name} 须为 ${MIN_EDGE_PX}–${MAX_EDGE_PX} 之间的像素数，实际：${String(value)}` };
    }
    return { edge };
}

function buildSvgImageFragment(svg, { width, height } = {}) {
    if (typeof svg !== 'string' || svg === '') throw new Error('buildSvgImageFragment 需要非空的 SVG 字符串');
    const w = requireEdge(width, 'width');
    if (w.error) throw new Error(w.error);
    const h = requireEdge(height, 'height');
    if (h.error) throw new Error(h.error);

    const src = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
    return '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
        + `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
        + `<style>${CSS}</style></head><body>`
        + `<img width="${w.edge}" height="${h.edge}" alt="" src="${src}"></body></html>`;
}

module.exports = { buildSvgImageFragment, SVG_FRAGMENT_CSP: CSP, MAX_EDGE_PX };
