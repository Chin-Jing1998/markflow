/**
 * converters/ir/turndown.js（url profile）：行内格式元素与链接内的分段 <br>
 * 成因：url profile 把 <br> 写成 BR 标记，parsers/url 的 collapseBreakMarkers 把连续两个及以上折叠为分段（\n\n）。修复前
 * （4a2de9a）格式元素的产物「<em>乙 BR BR 丙</em>」折叠为「<em>乙\n\n丙</em>」，开闭标签分落两段，remark 逐段解析后
 * ir/inline-html 配不成对而删标签，「甲<em>乙<br><br>丙</em>丁」重新解析为段落「甲乙」与「丙丁」，强调丢失；链接的产物
 * 「[乙 BR BR 丙](地址)」折叠后「[」与「](地址)」成为字面文本，地址被 remark-gfm 识别为裸网址，其后紧跟的文本一并计入地址。
 * 修法：url profile 写出标签之前按分段 BR 段切分内容，每段各自包裹（链接每段用同一地址与 title），BR 段原样留在两段之间，
 * 仍由 collapseBreakMarkers 按原规则折叠；分段 BR 段的分组与 collapseBreakMarkers 相同（BR 之间只隔行内空白与换行），
 * 单个 BR 与夹着零宽字符、不换行空格的两个 BR 不切分。
 * 覆盖：
 *   - 已列形态：39 种（七种格式标签与三种内联样式、链接与带 title 的链接、五种嵌套、三个与四个 BR、BR 之间夹空白、换行、
 *     空元素与注释、BR 两侧带空格、BR 段处在格式元素开头或末尾与段首或段末、格式元素只含 BR 段、两处 BR 段、块级的加粗 p、
 *     标题与列表项、BR 段之后接代码或图片、链接内含图片、地址含括号），逐字断言 Markdown 产物与 IR。
 *   - 保持现状：12 种不该切分的形态（单个 BR 及其位置、夹零宽字符或不换行空格的两个 BR、无格式、无 href 的 a、u、mark、
 *     块级子元素）Markdown 产物与 IR 逐字等于修复前的产物。
 *   - 端到端：经 parsers/url 的 parse() 抓取本机页面（站点选择器取正文），断言 IR 与 md、html、content-list 三种渲染器的产物。
 *   - 矩阵：9 种格式标签 × 6 种语境（链接不放进链接）× 4 种位置 × 6 种间隙 × 3 种 BR 个数（1 个为对照），共 3816 例，全链路解析后按段比对。
 *   - 回归护栏：不含分段 BR 的 19 种形态 Markdown 产物逐字等于修复前的产物。
 *   - 种子随机：固定种子生成 1500 个段落，每段 2–6 项，各项按概率取文本、单个 <br>、2–3 个 <br> 的连写（其间可夹空白、
 *     空元素或零宽字符）、空白、零宽字符、空元素、嵌套的格式元素与链接（深度 ≤ 3，<a> 不嵌套 <a>）；容器按 3:1:1 取 p、h2、li。
 * 断言口径：全链路为 preprocessHtml → turndown('url') → collapseBreakMarkers → normalizeMarkdown → remark-parse + remark-gfm →
 * liftInlineHtml → restoreMarkers，与 parsers/url 的调用同序（端到端用例另含正文提取与 cleanNoise）。矩阵与种子随机的
 * 比对按段进行：IR 的每个叶子块（paragraph、heading）展平为「文本 + 格式集合」片段序列，文本略去空白与零宽字符后合并相邻
 * 同格式的片段、去掉空段；期望由模型按 turndown 产物的结构推出——格式元素与链接各自按分段 BR 段切开写标签，容器内连续两个
 * 及以上的 <br>（其间只隔空白；标签与零宽字符都打断）为分段，单个 <br> 不分段（见 expectedOf）。任何 html 节点与意外的节点
 * 类型一律判错。不设耗时断言，线性以提交信息的实测为准。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createTurndownService } = require('../converters/ir/turndown');
const { liftInlineHtml } = require('../converters/ir/inline-html');
const { restoreMarkers } = require('../converters/ir/markers');
const { loadUnified } = require('../converters/ir/unified-loader');
const { normalizeMarkdown } = require('../converters/web/normalize');
const { parse, collapseBreakMarkers, preprocessHtml } = require('../converters/parsers/url');
const { _setLookup } = require('../converters/net/fetch-guard');
const mdRenderer = require('../converters/renderers/md');
const htmlRenderer = require('../converters/renderers/html');
const contentList = require('../converters/renderers/content-list');

// 不可见字符一律以码点生成，源码中不出现不可见字面量
const fromCode = (code) => String.fromCharCode(code);
const ZWSP = fromCode(0x200b);
const NBSP = fromCode(0x00a0);
const BR = fromCode(0xef03);
const U = 'https://example.com/p';
const MAX_REPORTED = 10;

// ============================================================
// 转换、展平与比对
// ============================================================

const toMarkdown = (html) => createTurndownService('url').turndown(preprocessHtml(html));

/** 全链路：与 parsers/url 的 turndown 之后各步同序 */
async function toIr(html) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    const markdown = normalizeMarkdown(collapseBreakMarkers(toMarkdown(html)));
    return restoreMarkers(liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(markdown), { source: 'web' }));
}

/** IR 的紧凑形式：只留类型、值、地址与子节点 */
function compact(node) {
    const out = { t: node.type };
    if (node.value !== undefined) out.v = node.value;
    if (node.url !== undefined) out.u = node.url;
    if (Array.isArray(node.children)) out.c = node.children.map(compact);
    return out;
}

const t = (v) => ({ t: 'text', v });
const p = (...c) => ({ t: 'paragraph', c });
const h = (...c) => ({ t: 'heading', c });
const wrap = (type) => (...c) => ({ t: type, c });
const em = wrap('emphasis');
const strong = wrap('strong');
const del = wrap('delete');
const sup = wrap('superscript');
const sub = wrap('subscript');
const a = (u, ...c) => ({ t: 'link', u, c });
const img = (u) => ({ t: 'image', u });
const brk = () => ({ t: 'break' });
const code = (v) => ({ t: 'inlineCode', v });
const html = (v) => ({ t: 'html', v });
const list = (...c) => ({ t: 'list', c });
const item = (...c) => ({ t: 'listItem', c });

const FORMAT_TYPES = new Set(['strong', 'emphasis', 'delete', 'superscript', 'subscript', 'link']);
const LEAF_BLOCKS = new Set(['paragraph', 'heading']);
const PASS_THROUGH = new Set(['root', 'list', 'listItem']);
const INVISIBLE = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map(fromCode));
const squeeze = (text) => Array.from(text).filter((ch) => !/\s/.test(ch) && !INVISIBLE.has(ch)).join('');

/**
 * IR 按叶子块展平为段：每段为「文本 + 格式集合」片段序列（break 略去）；另收集 html 节点与意外的节点类型。
 * 段与片段随后由 normalizeParagraphs 规范化
 */
function flattenParagraphs(tree) {
    const paragraphs = [];
    const stray = [];
    const others = [];
    let current = null;
    const walk = (node, formats) => {
        if (LEAF_BLOCKS.has(node.type)) {
            current = [];
            paragraphs.push(current);
            (node.children || []).forEach((child) => walk(child, formats));
            return;
        }
        if (node.type === 'text') {
            (current || (current = paragraphs[paragraphs.push([]) - 1])).push({ v: node.value, f: formats });
            return;
        }
        if (node.type === 'html') {
            stray.push(node.value);
            return;
        }
        if (node.type === 'break') return;
        let next = formats;
        if (FORMAT_TYPES.has(node.type)) next = formats.includes(node.type) ? formats : [...formats, node.type].sort();
        else if (!PASS_THROUGH.has(node.type)) others.push(node.type);
        (node.children || []).forEach((child) => walk(child, next));
    };
    walk(tree, []);
    return { paragraphs, stray, others };
}

/** 段规范化：文本略去空白与零宽字符、去空、相邻同格式合并，去掉空段；每段写成 "格式:文本|格式:文本" */
function normalizeParagraphs(paragraphs) {
    const out = [];
    for (const frags of paragraphs) {
        const pieces = [];
        for (const frag of frags) {
            const v = squeeze(frag.v);
            if (!v) continue;
            const key = `${frag.f.join('+')}:`;
            if (pieces.length > 0 && pieces[pieces.length - 1].key === key) pieces[pieces.length - 1].v += v;
            else pieces.push({ key, v });
        }
        if (pieces.length > 0) out.push(pieces.map((piece) => piece.key + piece.v).join('|'));
    }
    return out;
}

/** 与期望比对：段序列逐项相同、无 html 节点、无意外节点；返回问题描述或 null */
function problemOf(flat, expectedParagraphs) {
    const actual = normalizeParagraphs(flat.paragraphs);
    const expected = normalizeParagraphs(expectedParagraphs);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return `段 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`;
    if (flat.stray.length > 0) return `多出 html ${JSON.stringify(flat.stray)}`;
    if (flat.others.length > 0) return `意外节点 ${JSON.stringify(flat.others)}`;
    return null;
}

function reportFailures(failures, total) {
    assert.equal(failures.length, 0, `${failures.length}/${total} 例失败，前 ${MAX_REPORTED} 例：\n${failures.slice(0, MAX_REPORTED).join('\n')}`);
}

// ============================================================
// 模型：HTML 与期望段（矩阵与种子随机共用）
// ============================================================

// 模型节点：text(v)、ws（一个空格）、zw（零宽空格）、empty(html)（产物为空的元素或注释）、br、fmt(tag, kids)、link(kids)；
// 容器 p / h2 / li
const FORMAT_OF = Object.freeze({
    strong: 'strong', b: 'strong', em: 'emphasis', i: 'emphasis', del: 'delete', s: 'delete', sup: 'superscript', sub: 'subscript',
});
const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function toHtml(node) {
    switch (node.t) {
        case 'p': return `<p>${node.kids.map(toHtml).join('')}</p>`;
        case 'h2': return `<h2>${node.kids.map(toHtml).join('')}</h2>`;
        case 'li': return `<ul><li>${node.kids.map(toHtml).join('')}</li></ul>`;
        case 'text': return escapeHtml(node.v);
        case 'ws': return ' ';
        case 'zw': return ZWSP;
        case 'empty': return node.html;
        case 'br': return '<br>';
        case 'fmt': return `<${node.tag}>${node.kids.map(toHtml).join('')}</${node.tag}>`;
        case 'link': return `<a href="${U}">${node.kids.map(toHtml).join('')}</a>`;
        default: throw new Error(`未知模型节点：${node.t}`);
    }
}

/**
 * 模型推出的期望段。按 turndown 产物的结构把叶子排成记号——文本 { v, f }、'br' 与 'tag'（格式元素写出的开闭标签、链接写出
 * 的方括号），再按 BR 段分段：
 *   - 格式元素与链接：子记号先按分段 BR 段（连续两个及以上的 br，其间只隔空白文本）切开，各段含空白之外的记号时在两端写
 *     'tag'，只含空白或为空的段不写；不含分段 BR 段的链接即使内容为空也写方括号（turndown 不把 <a> 当作空白元素删除）。
 *     直接相邻的 <strong> 由 preprocessHtml 合并为一个，按一个元素处理。
 *   - 容器：记号序列里连续两个及以上的 br（其间只隔空白文本；'tag' 与零宽字符都打断）为分段，单个 br 不分段。
 * 返回 { paragraphs, splitInFormat }，后者为格式元素或链接内按分段 BR 段切开的次数
 */
function expectedOf(model) {
    let splitInFormat = 0;
    // 只含行内空白与换行的文本记号：以否定字符类判定，不写「量词 + 行尾锚」
    const isSpace = (token) => typeof token === 'object' && !/[^ \t\n]/.test(token.v);
    // 记号序列按分段 BR 段切开：返回 [段, BR 段, 段, …]，奇数位为 br 记号数组；单个 br 留在段内
    const splitRuns = (tokens) => {
        const parts = [[]];
        let index = 0;
        while (index < tokens.length) {
            if (tokens[index] !== 'br') {
                parts[parts.length - 1].push(tokens[index]);
                index += 1;
                continue;
            }
            let count = 1;
            let end = index + 1;
            let probe = end;
            while (probe < tokens.length) {
                if (tokens[probe] === 'br') {
                    count += 1;
                    end = probe + 1;
                    probe += 1;
                } else if (isSpace(tokens[probe])) probe += 1;
                else break;
            }
            if (count >= 2) parts.push(Array(count).fill('br'), []);
            else parts[parts.length - 1].push('br');
            index = end;
        }
        return parts;
    };
    const emit = (node, formats) => {
        switch (node.t) {
            case 'text': return [{ v: node.v, f: formats }];
            case 'ws': return [{ v: ' ', f: formats }];
            case 'zw': return [{ v: ZWSP, f: formats }];
            case 'br': return ['br'];
            case 'fmt': case 'link': {
                const type = node.t === 'link' ? 'link' : FORMAT_OF[node.tag];
                const next = formats.includes(type) ? formats : [...formats, type].sort();
                const parts = splitRuns(emitKids(node.kids, next));
                const wrapPiece = (piece) => (piece.some((token) => !isSpace(token)) ? ['tag', ...piece, 'tag'] : []);
                if (parts.length === 1) return node.t === 'link' ? ['tag', ...parts[0], 'tag'] : wrapPiece(parts[0]);
                splitInFormat += 1;
                return parts.flatMap((part, i) => (i % 2 === 1 ? part : wrapPiece(part)));
            }
            default: return [];
        }
    };
    const emitKids = (kids, formats) => {
        const out = [];
        for (let i = 0; i < kids.length; i += 1) {
            let kid = kids[i];
            if (kid.t === 'fmt' && kid.tag === 'strong') {
                const merged = [...kid.kids];
                while (i + 1 < kids.length && kids[i + 1].t === 'fmt' && kids[i + 1].tag === 'strong') {
                    merged.push(...kids[i + 1].kids);
                    i += 1;
                }
                kid = { t: 'fmt', tag: 'strong', kids: merged };
            }
            out.push(...emit(kid, formats));
        }
        return out;
    };
    const parts = splitRuns(emitKids(model.kids, []));
    const paragraphs = parts.filter((_, i) => i % 2 === 0).map((part) => part.filter((token) => typeof token === 'object'));
    return { paragraphs, splitInFormat };
}

const expectedParagraphs = (model) => expectedOf(model).paragraphs;

// ============================================================
// 已列形态
// ============================================================

// [名称, HTML, 期望 Markdown（BR 为 BR 标记）, 期望 IR]
const LISTED_FORMS = [
    ['em 内（任务举例）', '<p>甲<em>乙<br><br>丙</em>丁</p>', `甲<em>乙</em>${BR}${BR}<em>丙</em>丁`, [p(t('甲'), em(t('乙'))), p(em(t('丙')), t('丁'))]],
    ['strong 内', '<p>甲<strong>乙<br><br>丙</strong>丁</p>', `甲<strong>乙</strong>${BR}${BR}<strong>丙</strong>丁`,
        [p(t('甲'), strong(t('乙'))), p(strong(t('丙')), t('丁'))]],
    ['b 内', '<p>甲<b>乙<br><br>丙</b>丁</p>', `甲<strong>乙</strong>${BR}${BR}<strong>丙</strong>丁`, [p(t('甲'), strong(t('乙'))), p(strong(t('丙')), t('丁'))]],
    ['del 内', '<p>甲<del>乙<br><br>丙</del>丁</p>', `甲<del>乙</del>${BR}${BR}<del>丙</del>丁`, [p(t('甲'), del(t('乙'))), p(del(t('丙')), t('丁'))]],
    ['s 内', '<p>甲<s>乙<br><br>丙</s>丁</p>', `甲<del>乙</del>${BR}${BR}<del>丙</del>丁`, [p(t('甲'), del(t('乙'))), p(del(t('丙')), t('丁'))]],
    ['sup 内', '<p>甲<sup>乙<br><br>丙</sup>丁</p>', `甲<sup>乙</sup>${BR}${BR}<sup>丙</sup>丁`, [p(t('甲'), sup(t('乙'))), p(sup(t('丙')), t('丁'))]],
    ['sub 内', '<p>甲<sub>乙<br><br>丙</sub>丁</p>', `甲<sub>乙</sub>${BR}${BR}<sub>丙</sub>丁`, [p(t('甲'), sub(t('乙'))), p(sub(t('丙')), t('丁'))]],
    ['加粗样式的 span 内', '<p>甲<span style="font-weight:bold">乙<br><br>丙</span>丁</p>', `甲<strong>乙</strong>${BR}${BR}<strong>丙</strong>丁`,
        [p(t('甲'), strong(t('乙'))), p(strong(t('丙')), t('丁'))]],
    ['斜体样式的 span 内', '<p>甲<span style="font-style:italic">乙<br><br>丙</span>丁</p>', `甲<em>乙</em>${BR}${BR}<em>丙</em>丁`,
        [p(t('甲'), em(t('乙'))), p(em(t('丙')), t('丁'))]],
    ['删除线样式的 span 内', '<p>甲<span style="text-decoration:line-through">乙<br><br>丙</span>丁</p>', `甲<del>乙</del>${BR}${BR}<del>丙</del>丁`,
        [p(t('甲'), del(t('乙'))), p(del(t('丙')), t('丁'))]],
    ['加粗样式的 p 内（块级）', '<p style="font-weight:bold">乙<br><br>丙</p>', `<strong>乙</strong>${BR}${BR}<strong>丙</strong>`,
        [p(strong(t('乙'))), p(strong(t('丙')))]],
    ['链接内（任务举例）', `<p>甲<a href="${U}">乙<br><br>丙</a>丁</p>`, `甲[乙](${U})${BR}${BR}[丙](${U})丁`,
        [p(t('甲'), a(U, t('乙'))), p(a(U, t('丙')), t('丁'))]],
    ['带 title 的链接内', `<p>甲<a href="${U}" title="题">乙<br><br>丙</a>丁</p>`, `甲[乙](${U} "题")${BR}${BR}[丙](${U} "题")丁`,
        [p(t('甲'), a(U, t('乙'))), p(a(U, t('丙')), t('丁'))]],
    ['链接地址含括号', '<p>甲<a href="https://example.com/p(1)">乙<br><br>丙</a>丁</p>',
        `甲[乙](https://example.com/p\\(1\\))${BR}${BR}[丙](https://example.com/p\\(1\\))丁`,
        [p(t('甲'), a('https://example.com/p(1)', t('乙'))), p(a('https://example.com/p(1)', t('丙')), t('丁'))]],
    ['链接内含图片', `<p>甲<a href="${U}"><img src="x.png" alt="图"><br><br>丙</a>丁</p>`, `甲[![图](x.png)](${U})${BR}${BR}[丙](${U})丁`,
        [p(t('甲'), a(U, img('x.png'))), p(a(U, t('丙')), t('丁'))]],
    ['链接内 BR 段之前无文本', `<p>甲<a href="${U}"><br><br>丙</a>丁</p>`, `甲${BR}${BR}[丙](${U})丁`, [p(t('甲')), p(a(U, t('丙')), t('丁'))]],
    ['嵌套：em 内含 strong，BR 段在 strong 内', '<p>甲<em>乙<strong>丙<br><br>丁</strong>戊</em>己</p>',
        `甲<em>乙<strong>丙</strong></em>${BR}${BR}<em><strong>丁</strong>戊</em>己`,
        [p(t('甲'), em(t('乙'), strong(t('丙')))), p(em(strong(t('丁')), t('戊')), t('己'))]],
    ['嵌套：strong 内含 em，BR 段在 em 内', '<p>甲<strong>乙<em>丙<br><br>丁</em>戊</strong>己</p>',
        `甲<strong>乙<em>丙</em></strong>${BR}${BR}<strong><em>丁</em>戊</strong>己`,
        [p(t('甲'), strong(t('乙'), em(t('丙')))), p(strong(em(t('丁')), t('戊')), t('己'))]],
    ['嵌套：BR 段在 em 的直接子级、strong 之后', '<p>甲<em>乙<strong>丙</strong><br><br>丁</em>戊</p>',
        `甲<em>乙<strong>丙</strong></em>${BR}${BR}<em>丁</em>戊`, [p(t('甲'), em(t('乙'), strong(t('丙')))), p(em(t('丁')), t('戊'))]],
    ['嵌套：链接内含 em，BR 段在 em 内', `<p>甲<a href="${U}">乙<em>丙<br><br>丁</em>戊</a>己</p>`,
        `甲[乙<em>丙</em>](${U})${BR}${BR}[<em>丁</em>戊](${U})己`,
        [p(t('甲'), a(U, t('乙'), em(t('丙')))), p(a(U, em(t('丁')), t('戊')), t('己'))]],
    ['嵌套：em 内含链接，BR 段在链接内', `<p>甲<em>乙<a href="${U}">丙<br><br>丁</a>戊</em>己</p>`,
        `甲<em>乙[丙](${U})</em>${BR}${BR}<em>[丁](${U})戊</em>己`,
        [p(t('甲'), em(t('乙'), a(U, t('丙')))), p(em(a(U, t('丁')), t('戊')), t('己'))]],
    ['三个 br', '<p>甲<em>乙<br><br><br>丙</em>丁</p>', `甲<em>乙</em>${BR}${BR}${BR}<em>丙</em>丁`, [p(t('甲'), em(t('乙'))), p(em(t('丙')), t('丁'))]],
    ['四个 br', '<p>甲<em>乙<br><br><br><br>丙</em>丁</p>', `甲<em>乙</em>${BR}${BR}${BR}${BR}<em>丙</em>丁`,
        [p(t('甲'), em(t('乙'))), p(em(t('丙')), t('丁'))]],
    ['br 之间夹空格', '<p>甲<em>乙<br> <br>丙</em>丁</p>', `甲<em>乙</em>${BR}${BR}<em>丙</em>丁`, [p(t('甲'), em(t('乙'))), p(em(t('丙')), t('丁'))]],
    ['br 之间夹换行与空格', '<p>甲<em>乙<br> \n  <br>丙</em>丁</p>', `甲<em>乙</em>${BR}${BR}<em>丙</em>丁`, [p(t('甲'), em(t('乙'))), p(em(t('丙')), t('丁'))]],
    ['br 之间夹空 span', '<p>甲<em>乙<br><span></span><br>丙</em>丁</p>', `甲<em>乙</em>${BR}${BR}<em>丙</em>丁`, [p(t('甲'), em(t('乙'))), p(em(t('丙')), t('丁'))]],
    ['br 之间夹空 b', '<p>甲<em>乙<br><b></b><br>丙</em>丁</p>', `甲<em>乙</em>${BR}${BR}<em>丙</em>丁`, [p(t('甲'), em(t('乙'))), p(em(t('丙')), t('丁'))]],
    ['br 之间夹注释', '<p>甲<em>乙<br><!-- 注 --><br>丙</em>丁</p>', `甲<em>乙</em>${BR}${BR}<em>丙</em>丁`, [p(t('甲'), em(t('乙'))), p(em(t('丙')), t('丁'))]],
    ['br 两侧有空格', '<p>甲<em>乙 <br><br> 丙</em>丁</p>', `甲<em>乙</em>${BR}${BR}<em>丙</em>丁`, [p(t('甲'), em(t('乙'))), p(em(t('丙')), t('丁'))]],
    ['BR 段在 em 开头（前有文本）', '<p>甲<em><br><br>乙</em>丁</p>', `甲${BR}${BR}<em>乙</em>丁`, [p(t('甲')), p(em(t('乙')), t('丁'))]],
    ['BR 段在 em 末尾（后有文本）', '<p>甲<em>乙<br><br></em>丁</p>', `甲<em>乙</em>${BR}${BR}丁`, [p(t('甲'), em(t('乙'))), p(t('丁'))]],
    ['BR 段在 em 开头且处于段首（折叠时删除）', '<p><em><br><br>乙</em>丁</p>', `${BR}${BR}<em>乙</em>丁`, [p(em(t('乙')), t('丁'))]],
    ['BR 段在 em 末尾且处于段末（折叠时删除）', '<p>甲<em>乙<br><br></em></p>', `甲<em>乙</em>${BR}${BR}`, [p(t('甲'), em(t('乙')))]],
    ['em 只含 BR 段', '<p>甲<em><br><br></em>乙</p>', `甲${BR}${BR}乙`, [p(t('甲')), p(t('乙'))]],
    ['两处 BR 段', '<p>甲<em>乙<br><br>丙<br><br>丁</em>戊</p>', `甲<em>乙</em>${BR}${BR}<em>丙</em>${BR}${BR}<em>丁</em>戊`,
        [p(t('甲'), em(t('乙'))), p(em(t('丙'))), p(em(t('丁')), t('戊'))]],
    ['标题内', '<h2>甲<em>乙<br><br>丙</em>丁</h2>', `## 甲<em>乙</em>${BR}${BR}<em>丙</em>丁`, [h(t('甲'), em(t('乙'))), p(em(t('丙')), t('丁'))]],
    ['列表项内', '<ul><li>甲<em>乙<br><br>丙</em>丁</li></ul>', `-   甲<em>乙</em>${BR}${BR}<em>丙</em>丁`,
        [list(item(p(t('甲'), em(t('乙'))))), p(em(t('丙')), t('丁'))]],
    ['BR 段之后接代码', '<p>甲<em>乙<br><br><code>a</code></em>丁</p>', `甲<em>乙</em>${BR}${BR}<em>\`a\`</em>丁`,
        [p(t('甲'), em(t('乙'))), p(em(code('a')), t('丁'))]],
    // 只包着图片的格式标签由 ir/inline-html 拆除（图片不承载格式），与既有约定一致
    ['BR 段之后接图片', '<p>甲<em>乙<br><br><img src="x.png" alt="图"></em>丁</p>', `甲<em>乙</em>${BR}${BR}<em>![图](x.png)</em>丁`,
        [p(t('甲'), em(t('乙'))), p(img('x.png'), t('丁'))]],
];

test('已列形态：格式元素与链接的内容按分段 BR 段切分包裹，全链路解析后两侧各自保留格式、链接各用同一地址', async () => {
    const failures = [];
    for (const [name, source, markdown, expected] of LISTED_FORMS) {
        // Act
        const actualMarkdown = toMarkdown(source);
        const ir = (await toIr(source)).children.map(compact);

        // Assert（汇总后统一断言，失败时列出全部不符的形态）
        if (actualMarkdown !== markdown) failures.push(`${name}：Markdown ${JSON.stringify(actualMarkdown)}，期望 ${JSON.stringify(markdown)}`);
        try {
            assert.deepEqual(ir, expected);
        } catch (err) {
            failures.push(`${name}：IR ${JSON.stringify(ir)}，期望 ${JSON.stringify(expected)}`);
        }
    }
    reportFailures(failures, LISTED_FORMS.length);
});

// ============================================================
// 保持现状：不该切分的形态
// ============================================================

// [名称, HTML, 修复前的 Markdown 产物, 修复前的 IR]（均为 4a2de9a 的实测产物）
const UNCHANGED_FORMS = [
    ['格式内单个 br 为硬换行', '<p>甲<em>乙<br>丙</em>丁</p>', `甲<em>乙${BR}丙</em>丁`, [p(t('甲'), em(t('乙'), brk(), t('丙')), t('丁'))]],
    ['单个 br 在 em 开头', '<p>甲<em><br>乙</em>丁</p>', `甲<em>${BR}乙</em>丁`, [p(t('甲'), em(brk(), t('乙')), t('丁'))]],
    ['单个 br 在 em 末尾', '<p>甲<em>乙<br></em>丁</p>', `甲<em>乙${BR}</em>丁`, [p(t('甲'), em(t('乙'), brk()), t('丁'))]],
    ['两个不相邻的单 br', '<p>甲<em>乙<br>丙<br>丁</em>戊</p>', `甲<em>乙${BR}丙${BR}丁</em>戊`, [p(t('甲'), em(t('乙'), brk(), t('丙'), brk(), t('丁')), t('戊'))]],
    ['链接内单个 br', `<p>甲<a href="${U}">乙<br>丙</a>丁</p>`, `甲[乙${BR}丙](${U})丁`, [p(t('甲'), a(U, t('乙'), brk(), t('丙')), t('丁'))]],
    ['br 之间夹零宽空格：两个硬换行', `<p>甲<em>乙<br>${ZWSP}<br>丙</em>丁</p>`, `甲<em>乙${BR}${ZWSP}${BR}丙</em>丁`,
        [p(t('甲'), em(t('乙'), brk(), brk(), t('丙')), t('丁'))]],
    ['br 之间夹不换行空格：两个硬换行', `<p>甲<em>乙<br>${NBSP}<br>丙</em>丁</p>`, `甲<em>乙${BR}${NBSP}${BR}丙</em>丁`,
        [p(t('甲'), em(t('乙'), brk(), brk(), t('丙')), t('丁'))]],
    ['无格式的双 br 分段', '<p>甲乙<br><br>丙丁</p>', `甲乙${BR}${BR}丙丁`, [p(t('甲乙')), p(t('丙丁'))]],
    ['无 href 的 a 透传', '<p>甲<a>乙<br><br>丙</a>丁</p>', `甲乙${BR}${BR}丙丁`, [p(t('甲乙')), p(t('丙丁'))]],
    ['u 透传', '<p>甲<u>乙<br><br>丙</u>丁</p>', `甲乙${BR}${BR}丙丁`, [p(t('甲乙')), p(t('丙丁'))]],
    ['mark 写成「==」，两侧本就是字面文本', '<p>甲<mark>乙<br><br>丙</mark>丁</p>', `甲==乙${BR}${BR}丙==丁`, [p(t('甲==乙')), p(t('丙==丁'))]],
    ['块级子元素按空行逐块包裹（既有做法）', '<p>甲<em>乙<div>丙</div>丁</em>戊</p>', '甲<em>乙</em>\n\n<em>丙</em>\n\n<em>丁</em>戊',
        [p(t('甲'), em(t('乙'))), p(em(t('丙'))), p(em(t('丁')), t('戊'))]],
];

test('保持现状：单个 BR、夹零宽字符或不换行空格的两个 BR、无格式、透传元素与块级子元素的产物逐字不变', async () => {
    const failures = [];
    for (const [name, source, markdown, expected] of UNCHANGED_FORMS) {
        // Act
        const actualMarkdown = toMarkdown(source);
        const ir = (await toIr(source)).children.map(compact);

        // Assert
        if (actualMarkdown !== markdown) failures.push(`${name}：Markdown ${JSON.stringify(actualMarkdown)}，期望 ${JSON.stringify(markdown)}`);
        try {
            assert.deepEqual(ir, expected);
        } catch (err) {
            failures.push(`${name}：IR ${JSON.stringify(ir)}，期望 ${JSON.stringify(expected)}`);
        }
    }
    reportFailures(failures, UNCHANGED_FORMS.length);
});

// ============================================================
// 端到端：parsers/url 的 parse() 与渲染器
// ============================================================

const E2E_BODY = [
    '<p>甲<em>乙<br><br>丙</em>丁</p>',
    `<p>前<a href="${U}">乙<br><br>丙</a>后</p>`,
    '<section><span leaf="">一<strong>二<br><br>三</strong>四</span></section>',
].join('\n');
const E2E_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>分段</title></head><body><div id="js_content">${E2E_BODY}</div></body></html>`;

function startPageServer(page) {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            close: () => new Promise((done) => {
                server.closeAllConnections();
                server.close(() => done());
            }),
        }));
    });
}

test('端到端：网页正文里格式元素与链接内的双 <br> 进入 IR 后分段且两侧各自保留格式，md、html、content-list 的产物随之正确', async (t0) => {
    // Arrange：经 _setLookup 把 mp.weixin.qq.com 解析到本机，站点选择器按主机名命中，正文原样取出
    const server = await startPageServer(E2E_PAGE);
    t0.after(() => server.close());
    _setLookup(async () => [{ address: '127.0.0.1', family: 4 }]);
    t0.after(() => _setLookup(null));

    // Act
    const doc = await parse({ url: `http://mp.weixin.qq.com:${server.port}/mp.weixin.qq.com/s/break-format` }, { allowPrivateNetwork: true, skipImages: true });
    const paragraphs = doc.ir.children.filter((node) => node.type === 'paragraph').map(compact);
    const md = await mdRenderer.render(doc);
    const rendered = await htmlRenderer.render(doc);
    const blocks = JSON.parse(await contentList.render(doc));

    // Assert：IR
    assert.deepEqual(paragraphs, [
        p(t('甲'), em(t('乙'))), p(em(t('丙')), t('丁')),
        p(t('前'), a(U, t('乙'))), p(a(U, t('丙')), t('后')),
        p(t('一'), strong(t('二'))), p(strong(t('三')), t('四')),
    ]);
    // Assert：渲染器
    assert.ok(md.includes(`前[乙](${U})\n\n[丙](${U})后`), md);
    assert.ok(!md.includes('[乙\n') && !md.includes('\n丙]('), md);
    assert.ok(rendered.includes('<p>甲<em>乙</em></p>') && rendered.includes('<p><em>丙</em>丁</p>'), rendered);
    assert.ok(rendered.includes(`<p>前<a href="${U}">乙</a></p>`) && rendered.includes(`<p><a href="${U}">丙</a>后</p>`), rendered);
    assert.ok(rendered.includes('<p>一<strong>二</strong></p>') && rendered.includes('<p><strong>三</strong>四</p>'), rendered);
    const texts = blocks.filter((block) => block.type === 'text').map((block) => block.text);
    assert.deepEqual(texts, ['分段', '甲乙', '丙丁', '前乙', '丙后', '一二', '三四']);
});

// ============================================================
// 矩阵
// ============================================================

const MATRIX_TAGS = ['em', 'strong', 'b', 'i', 'del', 's', 'sup', 'sub', 'a'];
// 语境：把格式节点放进容器；链接不放进链接（HTML 解析器遇到嵌套的 <a> 会先关闭外层）
const MATRIX_CONTEXTS = [
    ['段落直属', (node) => ({ t: 'p', kids: [node] })],
    ['前后有文本', (node) => ({ t: 'p', kids: [{ t: 'text', v: '前' }, node, { t: 'text', v: '后' }] })],
    ['外层 strong', (node) => ({ t: 'p', kids: [{ t: 'fmt', tag: 'strong', kids: [{ t: 'text', v: '前' }, node, { t: 'text', v: '后' }] }] })],
    ['外层链接', (node) => ({ t: 'p', kids: [{ t: 'link', kids: [{ t: 'text', v: '前' }, node, { t: 'text', v: '后' }] }] })],
    ['标题', (node) => ({ t: 'h2', kids: [{ t: 'text', v: '前' }, node] })],
    ['列表项', (node) => ({ t: 'li', kids: [node, { t: 'text', v: '后' }] })],
];
// 位置：BR 段在格式内容的开头、中间、末尾，或两处
const MATRIX_POSITIONS = [
    ['中间', (run) => [{ t: 'text', v: '乙' }, ...run(), { t: 'text', v: '丙' }]],
    ['开头', (run) => [...run(), { t: 'text', v: '丙' }]],
    ['末尾', (run) => [{ t: 'text', v: '乙' }, ...run()]],
    ['两处', (run) => [{ t: 'text', v: '乙' }, ...run(), { t: 'text', v: '丙' }, ...run(), { t: 'text', v: '丁' }]],
];
// 间隙：相邻两个 <br> 之间夹的内容
const MATRIX_GAPS = [
    ['直接相邻', []], ['空格', [{ t: 'ws' }]], ['换行', [{ t: 'text', v: '\n' }]], ['空 span', [{ t: 'empty', html: '<span></span>' }]],
    ['注释', [{ t: 'empty', html: '<!-- 注 -->' }]], ['空 b', [{ t: 'empty', html: '<b></b>' }]],
];
const MATRIX_COUNTS = [1, 2, 3];

test('矩阵：9 种格式标签 × 6 种语境 × 4 种位置 × 6 种间隙 × 3 种 BR 个数，全链路解析后按段与期望一致', async () => {
    const failures = [];
    let total = 0;
    for (const tag of MATRIX_TAGS) {
        for (const [ctxName, wrapCtx] of MATRIX_CONTEXTS) {
            if (tag === 'a' && ctxName === '外层链接') continue;
            for (const [posName, place] of MATRIX_POSITIONS) {
                for (const [gapName, gap] of MATRIX_GAPS) {
                    for (const count of MATRIX_COUNTS) {
                        const run = () => {
                            const out = [];
                            for (let i = 0; i < count; i += 1) {
                                if (i > 0) out.push(...gap);
                                out.push({ t: 'br' });
                            }
                            return out;
                        };
                        const inner = tag === 'a' ? { t: 'link', kids: place(run) } : { t: 'fmt', tag, kids: place(run) };
                        const model = wrapCtx(inner);
                        total += 1;

                        // Act
                        const problem = problemOf(flattenParagraphs(await toIr(toHtml(model))), expectedParagraphs(model));

                        // Assert
                        if (problem) failures.push(`${tag} / ${ctxName} / ${posName} / ${gapName} / ${count} 个 br：${problem}\n  HTML ${toHtml(model)}`);
                    }
                }
            }
        }
    }
    assert.equal(total, 3816);
    reportFailures(failures, total);
});

// ============================================================
// 回归护栏：不含分段 BR 的形态产物逐字不变
// ============================================================

// [HTML, 4a2de9a 的 Markdown 产物]
const GUARD_FORMS = [
    [`<p>甲<a href="${U}" title="题">乙</a>丁</p>`, `甲[乙](${U} "题")丁`],
    ['<p>甲<a href="https://example.com/p(1)">乙</a>丁</p>', '甲[乙](https://example.com/p\\(1\\))丁'],
    [`<p>甲<a href="${U}"><img src="x.png" alt="图">乙</a>丁</p>`, `甲[![图](x.png)乙](${U})丁`],
    [`<p>甲<a href="${U}">乙<em>丙</em>丁</a>戊</p>`, `甲[乙<em>丙</em>丁](${U})戊`],
    [`<p>甲<a href="${U}">乙<br>丙</a>丁</p>`, `甲[乙${BR}丙](${U})丁`],
    [`<p>甲<a href="${U}"> 乙 </a>丁</p>`, `甲 [乙](${U}) 丁`],
    [`<p>甲<a href="${U}"></a>丁</p>`, `甲[](${U})丁`],
    [`<p>甲<a href="${U}"><br></a>丁</p>`, `甲[${BR}](${U})丁`],
    [`<p>甲<a href="${U}">乙<a href="${U}">丙</a>丁</a>戊</p>`, `甲[乙](${U})[丙](${U})丁戊`],
    ['<p>甲<em>乙<strong>丙</strong>丁</em>戊</p>', '甲<em>乙<strong>丙</strong>丁</em>戊'],
    ['<p>甲<em>乙<br>丙</em>丁</p>', `甲<em>乙${BR}丙</em>丁`],
    ['<p>甲<em> 乙 </em>丁</p>', '甲 <em>乙</em> 丁'],
    ['<section style="font-weight: bold"><p>甲</p><p>乙</p></section>', '<strong>甲</strong>\n\n<strong>乙</strong>'],
    ['<p>甲<em>乙<div>丙</div>丁</em>戊</p>', '甲<em>乙</em>\n\n<em>丙</em>\n\n<em>丁</em>戊'],
    ['<p>甲<em><code>a</code>乙</em>丁</p>', '甲<em>`a`乙</em>丁'],
    ['<p>甲<sup>2</sup><sub>3</sub><del>删</del><s>删</s><b>粗</b><i>斜</i>丁</p>', '甲<sup>2</sup><sub>3</sub><del>删</del><del>删</del><strong>粗</strong><em>斜</em>丁'],
    ['<p>甲<span style="font-weight:bold">乙<br>丙</span>丁</p>', `甲<strong>乙${BR}丙</strong>丁`],
    ['<h2>甲<em>乙<br>丙</em>丁</h2>', `## 甲<em>乙${BR}丙</em>丁`],
    [`<ul><li>甲<a href="${U}">乙<br>丙</a>丁</li></ul>`, `-   甲[乙${BR}丙](${U})丁`],
];

test('回归护栏：不含分段 BR 的链接与格式元素，Markdown 产物逐字等于修复前的产物', () => {
    const failures = [];
    for (const [source, expected] of GUARD_FORMS) {
        const actual = toMarkdown(source);
        if (actual !== expected) failures.push(`${source}：${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
    }
    reportFailures(failures, GUARD_FORMS.length);
});

// ============================================================
// 种子随机
// ============================================================

function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let x = state;
        x = Math.imul(x ^ (x >>> 15), x | 1);
        x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

// 文本值：中文、英文、标点与会被 turndown 转义的 Markdown 记号；不含只在行首才有块语法含义的记号（- # > 1. 等），
// 它们在本用例之外另有转义规则可查
const TEXT_VALUES = ['甲', '乙', '丙', '文本', '示例', 'x', 'abc', '，', '。', '（', '）', '*', '_', '[', ']', '`', '\\', '~', 'a*b', 'a_b'];
const EMPTY_HTML = ['<span></span>', '<b></b>', '<i></i>', '<!-- 注 -->', '<wbr>', '<img>'];
const FMT_TAGS = ['strong', 'b', 'em', 'i', 'del', 's', 'sup', 'sub'];
const CONTAINERS = ['p', 'p', 'p', 'h2', 'li'];

function createGenerator(seed) {
    const rand = mulberry32(seed);
    const pick = (values) => values[Math.floor(rand() * values.length)];
    const chance = (probability) => rand() < probability;
    const text = () => ({ t: 'text', v: pick(TEXT_VALUES) });
    // 2–3 个 br 的连写，其间可夹空白、空元素或零宽字符（夹零宽字符的不分段）
    const brRun = () => {
        const count = chance(0.7) ? 2 : 3;
        const out = [];
        for (let i = 0; i < count; i += 1) {
            if (i > 0) {
                const r = rand();
                if (r < 0.15) out.push({ t: 'ws' });
                else if (r < 0.3) out.push({ t: 'empty', html: pick(EMPTY_HTML) });
                else if (r < 0.38) out.push({ t: 'zw' });
            }
            out.push({ t: 'br' });
        }
        return out;
    };
    const seq = (length, depth, inLink) => {
        const out = [];
        for (let i = 0; i < length; i += 1) {
            const r = rand();
            if (r < 0.32) out.push(text());
            else if (r < 0.42) out.push({ t: 'br' });
            else if (r < 0.54) out.push(...brRun());
            else if (r < 0.59) out.push({ t: 'ws' });
            else if (r < 0.63) out.push({ t: 'zw' });
            else if (r < 0.69) out.push({ t: 'empty', html: pick(EMPTY_HTML) });
            else if (r < 0.86 && depth < 3) out.push({ t: 'fmt', tag: pick(FMT_TAGS), kids: seq(1 + Math.floor(rand() * 4), depth + 1, inLink) });
            else if (r < 0.93 && depth < 3 && !inLink) out.push({ t: 'link', kids: seq(1 + Math.floor(rand() * 4), depth + 1, true) });
            else out.push(text());
        }
        return out;
    };
    // 生成后的修补，避开与格式元素无关的原有问题（均见提交信息的范围外遗留）：
    //   - 标题与列表项以文本起首：容器直属的首个 <br> 之前只有空白时，collapseBreakMarkers 把「## 」「-   」的空格并入 BR 段，
    //     标题与列表标记随之失效；
    //   - <br> 之后（越过空白与空元素）紧跟的零宽字符换成文本：单个 <br> 折叠为「\ + 换行」后，其后只剩零宽字符的一行经
    //     normalizeMarkdown 删去零宽字符即成空行或段末，反斜杠成为字面文本；段末的 <br> 之后只剩零宽字符、空元素或空白时同理，
    //     补一项文本；
    //   - 列表项内以 <br> 结尾（越过空白、空元素与零宽字符）的格式元素与链接补一项文本：硬换行之后只剩闭标签的一行在列表项内
    //     被 remark 解析为 HTML 块，格式随之丢失（段落与标题内不发生）
    const isGap = (leaf) => leaf.t === 'ws' || leaf.t === 'empty';
    const leavesOf = (kids) => {
        const out = [];
        const walk = (node) => (Array.isArray(node.kids) ? node.kids.forEach(walk) : out.push(node));
        kids.forEach(walk);
        return out;
    };
    const replaceZwAfterBr = (kids) => {
        const leaves = leavesOf(kids);
        leaves.forEach((leaf, i) => {
            if (leaf.t !== 'zw') return;
            let j = i - 1;
            while (j >= 0 && isGap(leaves[j])) j -= 1;
            if (j >= 0 && leaves[j].t === 'br') Object.assign(leaf, text());
        });
    };
    const endsWithBr = (node) => {
        const leaves = leavesOf(node.kids);
        let k = leaves.length - 1;
        while (k >= 0 && (isGap(leaves[k]) || leaves[k].t === 'zw')) k -= 1;
        return k >= 0 && leaves[k].t === 'br';
    };
    const padTrailingBr = (node) => {
        node.kids.forEach((kid) => { if (kid.t === 'fmt' || kid.t === 'link') padTrailingBr(kid); });
        if ((node.t === 'fmt' || node.t === 'link') && endsWithBr(node)) node.kids.push(text());
    };
    return {
        sample: () => {
            const container = pick(CONTAINERS);
            const kids = seq(2 + Math.floor(rand() * 5), 0, false);
            if (container !== 'p') kids.unshift(text());
            replaceZwAfterBr(kids);
            if (endsWithBareBreak(kids)) kids.push(text());
            if (container === 'li') padTrailingBr({ t: 'root', kids });
            return { t: container, kids };
        },
    };
}

/** 叶子按文档序展开：最后一个 <br> 之后直到段末只有零宽字符、空元素或空白 */
function endsWithBareBreak(kids) {
    const leaves = [];
    const walk = (node) => {
        if (Array.isArray(node.kids)) node.kids.forEach(walk);
        else leaves.push(node);
    };
    kids.forEach(walk);
    let lastBreak = -1;
    leaves.forEach((leaf, i) => { if (leaf.t === 'br') lastBreak = i; });
    if (lastBreak < 0) return false;
    return leaves.slice(lastBreak + 1).every((leaf) => leaf.t === 'zw' || leaf.t === 'empty' || leaf.t === 'ws');
}

test('种子随机：1500 个含格式元素、链接与 <br> 连写的段落，全链路解析后按段与模型推出的期望一致', async () => {
    // Arrange
    const generator = createGenerator(20260927);
    const samples = Array.from({ length: 1500 }, () => generator.sample());

    // Act
    const failures = [];
    let withSplits = 0;
    for (const [index, model] of samples.entries()) {
        const expected = expectedOf(model);
        if (expected.splitInFormat > 0) withSplits += 1;
        const problem = problemOf(flattenParagraphs(await toIr(toHtml(model))), expected.paragraphs);
        if (problem) failures.push(`第 ${index} 段：${problem}\n  HTML ${toHtml(model)}`);
    }

    // Assert：样本须有相当数量在格式元素或链接内切分，否则用例失去意义
    assert.ok(withSplits >= 300, `格式元素或链接内含分段 <br> 的段落只有 ${withSplits} 个`);
    reportFailures(failures, samples.length);
});
