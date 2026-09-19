/**
 * xml 目标 generic profile：mdast 逐节点映射为通用文档 XML（命名空间 urn:markflow:document:1）
 *
 * 结构（方案 §3.4.2）：
 *   <document xmlns="urn:markflow:document:1" version="1">
 *     <meta><title/><source/><sourceType/><convertedAt/><warning/>*</meta>
 *     <body> 块级：heading[level] / p / list[ordered,start] > item[checked] / table > row[header] > cell[align]
 *            / code[lang] / quote / figure > image[src,alt,width,height] / hr / section-break[kind,index,title] </body>
 *   </document>
 *   行内：b / i / s / u / sup / sub / code / a[href] / br / image / math[display]
 *        （MathML 内嵌，经解析重建保证 well-formed）
 * slideBreak / sheetSection 保真为 section-break，不降级；图片沿用 images/ 相对引用（资产由调度器落盘）；
 * 文本经 builder.cleanText 剔除 XML 1.0 非法控制字符。产物 {name}.xml。
 */
const { load } = require('cheerio');
const { el, serializeDocument } = require('./builder');
const { mathToText } = require('../../ir/schema');
const { stripHtml } = require('../../ir/util');

const NAMESPACE = 'urn:markflow:document:1';
const VERSION = '1';
const NAME_TOKEN = '{name}';
const MATHML_NAMESPACE = 'http://www.w3.org/1998/Math/MathML';

async function render(doc, options) {
    const root = el('document', { xmlns: NAMESPACE, version: VERSION }, [
        buildMeta(doc),
        el('body', {}, blocks(doc.ir && Array.isArray(doc.ir.children) ? doc.ir.children : [], doc)),
    ]);
    const xml = serializeDocument({ root, indent: options.xml.indent });
    const fileName = `${NAME_TOKEN}.xml`;
    const warnings = [];
    if (options.xml.validate) {
        // generic 无 DTD：只做 well-formed 检查
        const { validateXml, describeValidation } = require('./validate');
        const result = await validateXml(xml, { requireDtd: false });
        warnings.push(...describeValidation(fileName.replace(NAME_TOKEN, 'document'), result, { requireDtd: false }).map((issue) => issue.message));
    }
    return { files: { [fileName]: xml }, assets: [], extras: [], warnings };
}

function buildMeta(doc) {
    const meta = doc.meta || {};
    const children = [
        el('title', {}, [String(meta.title || '')]),
        meta.sourceName ? el('source', {}, [String(meta.sourceName)]) : null,
        el('sourceType', {}, [String(meta.sourceType || '')]),
        el('convertedAt', {}, [new Date().toISOString()]),
        ...(Array.isArray(doc.warnings) ? doc.warnings : []).map((warning) => el('warning', {}, [String(warning)])),
    ];
    return el('meta', {}, children);
}

// ============================================================
// 块级
// ============================================================

function blocks(nodes, doc) {
    return nodes.flatMap((node) => block(node, doc)).filter(Boolean);
}

function block(node, doc) {
    if (!node || typeof node !== 'object') return [];
    switch (node.type) {
        case 'heading': return [el('heading', { level: String(node.depth || 1) }, inline(node.children, doc))];
        case 'paragraph': return [paragraph(node, doc)];
        case 'list': return [el('list', { ordered: String(Boolean(node.ordered)), start: node.ordered && Number.isInteger(node.start) ? String(node.start) : null },
            (node.children || []).map((item) => listItem(item, doc)))];
        case 'table': return [table(node, doc)];
        case 'code': return [el('code', { lang: node.lang || null }, [String(node.value == null ? '' : node.value)])];
        case 'blockquote': return [el('quote', {}, blocks(node.children || [], doc))];
        case 'thematicBreak': return [el('hr')];
        case 'slideBreak': return [sectionBreak('slide', node.data, node.data && node.data.title)];
        case 'sheetSection': return [sectionBreak('sheet', node.data, node.data && node.data.name)];
        case 'math': return [el('p', {}, [math(node)])];
        case 'image': return [el('figure', {}, [image(node, doc)])];
        case 'html': {
            const text = stripHtml(node.value);
            return text ? [el('p', {}, [text])] : [];
        }
        default:
            if (Array.isArray(node.children)) return [el('p', {}, inline(node.children, doc))];
            return node.value !== undefined && node.value !== null ? [el('p', {}, [String(node.value)])] : [];
    }
}

// 仅含一张图片的段落输出为 figure
function paragraph(node, doc) {
    const children = (node.children || []).filter((child) => !(child.type === 'text' && !String(child.value || '').trim()));
    if (children.length === 1 && children[0].type === 'image') return el('figure', {}, [image(children[0], doc)]);
    return el('p', {}, inline(node.children, doc));
}

function listItem(item, doc) {
    const attrs = typeof item.checked === 'boolean' ? { checked: String(item.checked) } : {};
    return el('item', attrs, blocks(item.children || [], doc));
}

function table(node, doc) {
    const align = Array.isArray(node.align) ? node.align : [];
    const rows = (node.children || []).map((row, rowIndex) => el('row', rowIndex === 0 ? { header: 'true' } : {},
        (row.children || []).map((cell, cellIndex) => el('cell', { align: align[cellIndex] || null }, inline(cell.children, doc)))));
    return el('table', {}, rows);
}

function sectionBreak(kind, data, title) {
    const index = data && Number.isInteger(data.index) ? String(data.index) : '0';
    return el('section-break', { kind, index, title: title || null });
}

// ============================================================
// 行内
// ============================================================

function inline(nodes, doc) {
    return (Array.isArray(nodes) ? nodes : []).flatMap((node) => inlineNode(node, doc)).filter((item) => item !== null && item !== '');
}

function inlineNode(node, doc) {
    if (!node || typeof node !== 'object') return [];
    switch (node.type) {
        case 'text': return [String(node.value == null ? '' : node.value)];
        case 'strong': return [el('b', {}, inline(node.children, doc))];
        case 'emphasis': return [el('i', {}, inline(node.children, doc))];
        case 'delete': return [el('s', {}, inline(node.children, doc))];
        case 'underline': return [el('u', {}, inline(node.children, doc))];
        case 'superscript': return [el('sup', {}, inline(node.children, doc))];
        case 'subscript': return [el('sub', {}, inline(node.children, doc))];
        case 'inlineCode': return [el('code', {}, [String(node.value == null ? '' : node.value)])];
        case 'link': return [el('a', { href: node.url || null }, inline(node.children, doc))];
        case 'break': return [el('br')];
        case 'image': return [image(node, doc)];
        case 'math': return [math(node)];
        case 'html': return [stripHtml(node.value)];
        case 'footnoteReference': return [`[${node.label || node.identifier || ''}]`];
        default:
            if (Array.isArray(node.children)) return inline(node.children, doc);
            return node.value !== undefined && node.value !== null ? [String(node.value)] : [];
    }
}

function image(node, doc) {
    const data = node.data || {};
    const assetName = typeof data.assetName === 'string' && data.assetName ? data.assetName : (typeof node.url === 'string' ? node.url : '');
    const asset = (Array.isArray(doc.assets) ? doc.assets : []).find((item) => item && item.name === assetName) || null;
    const attrs = { src: assetName || null, alt: node.alt || null };
    const { width, height } = imageSize(data, asset);
    if (Number.isFinite(width)) attrs.width = String(width);
    if (Number.isFinite(height)) attrs.height = String(height);
    if (data.role) attrs.role = String(data.role);
    return el('image', attrs);
}

// 显示尺寸（data.display 的 px）优先，缺高度时按像素宽高比补；其次栅格化记下的像素尺寸，再次资源自带尺寸
function imageSize(data, asset) {
    const naturalWidth = data.width || (asset && asset.width) || (data.asset && data.asset.width) || null;
    const naturalHeight = data.height || (asset && asset.height) || (data.asset && data.asset.height) || null;
    const display = data.display;
    if (display && display.unit === 'px' && Number.isFinite(display.width) && display.width > 0) {
        const width = Math.round(display.width);
        if (Number.isFinite(display.height) && display.height > 0) return { width, height: Math.round(display.height) };
        const height = Number.isFinite(naturalWidth) && Number.isFinite(naturalHeight) && naturalWidth > 0
            ? Math.round((naturalHeight * width) / naturalWidth) : null;
        return { width, height };
    }
    return { width: naturalWidth, height: naturalHeight };
}

// MathML 经 cheerio（xmlMode）解析后按元素重建，保证输出 well-formed：根 <math> 合并 display 属性并补
// MathML 命名空间；解析不到 <math> 根时降级为只含线性化文本的 <math display>
function math(node) {
    const data = node.data || {};
    const display = data.display === true ? 'true' : 'false';
    const mathml = typeof data.mathml === 'string' ? data.mathml.trim() : '';
    const rebuilt = mathml ? rebuildMathml(mathml) : null;
    if (rebuilt) return el('math', { ...rebuilt.attrs, display }, rebuilt.children);
    return el('math', { display }, [mathToText(node)]);
}

function rebuildMathml(mathml) {
    let $;
    try {
        $ = load(mathml, { xmlMode: true, decodeEntities: true });
    } catch (err) {
        return null;
    }
    const root = $.root().children().filter((index, element) => element.type === 'tag' && element.name === 'math').first();
    if (root.length === 0) return null;
    try {
        const converted = convertElement(root.get(0));
        return { attrs: { xmlns: MATHML_NAMESPACE, ...converted.attrs }, children: converted.children };
    } catch (err) {
        return null;
    }
}

function convertElement(element) {
    const children = (element.children || []).flatMap((child) => {
        if (child.type === 'text') return child.data && child.data.trim() ? [child.data] : [];
        if (child.type === 'tag') return [convertElement(child)];
        return [];
    });
    return el(element.name, { ...(element.attribs || {}) }, children);
}

module.exports = { render, NAMESPACE };
