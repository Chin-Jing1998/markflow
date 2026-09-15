/**
 * bundle 旁路文件的纯函数工具（不依赖任何 parser / renderer，调度器可在顶层 require）
 *
 *   CONTENT_LIST_NAME                 '{name}_content_list.json'
 *   findOriginalContentList(extras, name?)
 *                                     MinerU 来源自带的 content_list 附属文件（名为 {name}_content_list.json，
 *                                     或已替换占位符的 <name>_content_list.json）；无则 null
 *   imagePathMap(doc)                 来源图片路径 → 产物图片路径：doc.assets 的 sourcePath → name，
 *                                     IR 图片节点的 data.sourcePath → url；另派生裸文件名 → 裸文件名（layout.json 用）
 *   rewriteJsonText(text, map)        解析 JSON，替换与映射键精确相等的字符串值，按原缩进风格重新序列化；
 *                                     无替换或解析失败时原样返回同一字符串
 *   finalizeMineruExtras(extras, doc) 对 .json 附属文件执行 rewriteJsonText（content_list / v2 / model 中是 images/…，
 *                                     layout 中是裸名，两套映射同时生效——哈希文件名唯一，不会串）；
 *                                     非 JSON 原样保留；无映射时返回原数组
 *   detectIndent(text)                JSON 文本的缩进单位（'    ' / '\t' / undefined 表示紧凑）
 */
const path = require('path');
const { NAME_TOKEN } = require('./output');
const { toBuffer } = require('./util');

const CONTENT_LIST_SUFFIX = '_content_list.json';
const CONTENT_LIST_NAME = `${NAME_TOKEN}${CONTENT_LIST_SUFFIX}`;
const JSON_NAME_RE = /\.json$/i;

function findOriginalContentList(extras, name) {
    const names = new Set([CONTENT_LIST_NAME]);
    if (typeof name === 'string' && name) names.add(`${name}${CONTENT_LIST_SUFFIX}`);
    return (Array.isArray(extras) ? extras : []).find((extra) => extra && names.has(extra.name) && toBuffer(extra.buffer)) || null;
}

function imagePathMap(doc) {
    const map = new Map();
    const add = (from, to) => {
        if (typeof from !== 'string' || !from || typeof to !== 'string' || !to || from === to) return;
        if (!map.has(from)) map.set(from, to);
        const bareFrom = path.posix.basename(from);
        if (bareFrom !== from && !map.has(bareFrom)) map.set(bareFrom, path.posix.basename(to));
    };
    for (const asset of Array.isArray(doc && doc.assets) ? doc.assets : []) add(asset && asset.sourcePath, asset && asset.name);
    walkImages(doc && doc.ir, (node) => add(node.data && node.data.sourcePath, node.url));
    return map;
}

function walkImages(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'image') visit(node);
    if (Array.isArray(node.children)) for (const child of node.children) walkImages(child, visit);
}

function rewriteJsonText(text, map) {
    if (!(map instanceof Map) || map.size === 0) return text;
    let value;
    try {
        value = JSON.parse(text);
    } catch (err) {
        return text;
    }
    let replaced = 0;
    const walk = (node) => {
        if (typeof node === 'string') {
            if (!map.has(node)) return node;
            replaced += 1;
            return map.get(node);
        }
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]));
        return node;
    };
    const next = walk(value);
    return replaced === 0 ? text : JSON.stringify(next, null, detectIndent(text));
}

function finalizeMineruExtras(extras, doc) {
    const list = Array.isArray(extras) ? extras : [];
    const map = imagePathMap(doc);
    if (map.size === 0) return list;
    return list.map((extra) => {
        if (!extra || typeof extra.name !== 'string' || !JSON_NAME_RE.test(extra.name)) return extra;
        const buffer = toBuffer(extra.buffer);
        if (!buffer) return extra;
        const text = buffer.toString('utf8');
        const next = rewriteJsonText(text, map);
        return next === text ? extra : { ...extra, buffer: Buffer.from(next, 'utf8') };
    });
}

function detectIndent(text) {
    const matched = /\n([ \t]+)\S/.exec(String(text || ''));
    return matched ? matched[1] : undefined;
}

module.exports = {
    CONTENT_LIST_NAME, findOriginalContentList, imagePathMap, rewriteJsonText, finalizeMineruExtras, detectIndent,
};
