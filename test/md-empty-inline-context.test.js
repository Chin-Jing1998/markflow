/**
 * converters/renderers/md.js：产物为空的行内节点遮住相邻文本节点的转义语境
 * 成因：containerPhrasing（mdast-util-to-markdown 2.1.2，lib/util/container-phrasing.js）只凭紧邻兄弟给出每个子节点
 * 的 before 与 after。非首个子节点的 before 取前一兄弟产物的末字，前一兄弟产物为空时为空串，看不到更前的真实字符，
 * 也看不到段首的换行；非末个子节点的 after 取后一兄弟 peek 结果的首字（无 peek 的 text 取其产物首字），空文本给出
 * 空串，无内容的格式节点给出「*」「~」或「<」，空 html 给出「<」；紧接 html 节点之前的行尾换行改为空格，html 值为空
 * 时同样如此。safe()（lib/util/safe.js 与 lib/unsafe.js）依据 before、after 决定转义：行首记号（「#」「1.」「1)」「-」
 * 「+」「>」「=」等）要求 before 含换行，行首与行尾的空格要求紧邻换行；「&」后接字母或「#」、「<」后接字母或「!」「/」
 * 「?」、「!」后接「[」、反斜杠后接换行，这些看 after；末尾反斜杠只在 after 为 ASCII 标点时转义。空节点使这些判定
 * 落空，例如修复前 [strong(), text('# 标题')] 的产物为「# 标题」，重新解析为标题；[text('甲!'), html(''), link('甲站')]
 * 的产物为「甲![甲站](https://a.com)」，重新解析为图片；[text('甲' + 换行), html(''), text('乙')] 的产物为「甲 乙」。
 * 修法：render() 在 stringify 之前剔除行内语境中产物为空的节点，即 paragraph、heading、tableCell、六种行内格式与链接
 * 的子节点中的空文本、空 html 与内容为空的格式节点（链接只剔除子节点、不剔除自身）。各节点改由真实邻居给出 before、
 * after 与 peek，含空节点的 IR 与去掉空节点后的 IR 产物逐字相同；f4a1567 与 d5d6823 的标签回退规则保留作兜底。
 * 覆盖：
 *   - 已列形态：实测确认的 13 种形态。
 *   - 矩阵：10 种产物为空的节点 E × 60 种敏感边界形态，形态分 12 类：段首行首记号、段首行首空白、段中换行后的行首
 *     记号与行首空白、行首记号与其后必需的字符被 E 隔开、段尾行尾空白、反斜杠加 ASCII 标点（文本、链接、行内代码、
 *     下划线与三种定界符式格式）、反斜杠加换行、空格加换行、感叹号加链接、「&」加实体形态、「<」加标签形态、空 html
 *     之前以换行结尾的文本。
 *   - 格式节点与链接内部：E 位于 strong／emphasis／delete／underline／superscript／subscript 或 link 的子节点之间
 *     或末尾。
 *   - 已知行为变化：链接子节点去掉空节点后只剩与地址相同的文本时改写为自动链接；以反斜杠结尾的文本后接空格式节点或
 *     空 html、再接非 ASCII 标点时，反斜杠不再因空节点 peek 报出的 ASCII 标点而多转义。紧邻空节点的格式节点由标签改回
 *     定界符一类见 test/md-emphasis-adjacency.test.js 与 test/md-emphasis-empty-sibling.test.js。
 *   - 回归护栏：不含空节点的 8 种敏感形态，产物逐字等于 d5d6823 的产物。
 *   - 种子随机往返：固定种子生成 2000 个段落，每段 1–6 个行内节点，各位置按 25% 取产物为空的节点（含段落与格式节点
 *     直属的空文本）、30% 取敏感边界文本、15% 取普通文本、20% 取非空格式节点（六种）、10% 取链接，容器（格式节点与
 *     链接）嵌套深度 ≤ 2，链接不嵌套链接；含换行的文本只作段落直属文本且每段至多一个，可见文本以换行开头或结尾时在
 *     段首补「前」、段尾补「后」。每段产物须与本文件独立实现的参照剔除（referencePrune）后的 IR 产物逐字相同；只由
 *     空节点构成的段落产物为空串，其余逐例往返正确。
 * 断言口径：缺陷类用例（已列形态、矩阵、格式节点与链接内部、种子随机往返）断言两项。其一，往返正确：逐例经
 * remark-parse + remark-gfm + liftInlineHtml 重新解析后只有一个段落，「文本 + 格式集合」片段序列与原 IR 一致（链接
 * 视作带 url 的格式，行内代码视作原子片段，产物为空的节点不产生片段），且不出现原文没有的「*」「~」。其二，产物与
 * 去掉空节点后的同一 IR 逐字相同，不区分空节点两侧是否为定界符式格式节点。已列形态、矩阵、格式节点与链接内部三项
 * 先断言对照形态（去掉空节点后的 IR）往返正确，以确认形态本身在范围内。已知行为变化与回归护栏逐字比对产物。
 * 范围外（去掉空节点后同样出错，或属解析器的固有行为），矩阵与随机文本池均已避开：
 *   - 含「www.」「http:」或电子邮箱形态的文本：remark-gfm 在解析后的文本上识别自动链接，转义拦不住；
 *   - 段首或段尾的换行：解析器丢弃；
 *   - 相邻的两个 inlineCode：去掉空节点后同样粘连成一个，已由后续修复在两段之间插入空 HTML 注释分隔，用例见
 *     test/md-inline-code-adjacent.test.js；
 *   - 含连续两个换行的文本：分成两段；
 *   - 数字与其后的「.」「)」分属两个文本节点（如 [text('1'), E, text('. 项')]）：去掉 E 后数字与记号仍分属两个节点，
 *     单凭剔除空节点不能修复；已由后续修复在数字边界合并相邻 text 处理，用例见 test/md-list-marker-split.test.js；
 *   - 制表符：ir/markers 的 applyTextLayout 把非代码文本中的制表符改为两个全角空格，用例不含制表符。
 * 另有若干形态在修复前对各种 E 均往返正确（如段首的「#标题」「===」，被 E 隔开的「#」与「 标题」，段尾以反斜杠结尾
 * 的文本），不属缺陷，未收入。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');

const mdRenderer = require('../converters/renderers/md');
const { loadUnified } = require('../converters/ir/unified-loader');
const { liftInlineHtml } = require('../converters/ir/inline-html');
const { createDocument, createRoot, createParagraph, createText } = require('../converters/ir/schema');

// 片段展平所认的格式类型：定界符式三种与只写 HTML 标签的三种
const FORMAT_TYPES = ['strong', 'emphasis', 'delete', 'underline', 'superscript', 'subscript'];
const DELIMITER_CHARS = ['*', '~'];
// 失败信息最多列出的用例数
const MAX_REPORTED = 10;
// 换行、反斜杠与辅助平面表情一律以码点生成，源码中不出现转义序列与不可见字面量
const NL = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);
const EMOJI = String.fromCodePoint(0x1f600);
// 用例中链接的默认地址：不含空白与括号，文本与地址不同时产物恒为「[文本](地址)」
const LINK_URL = 'https://a.com';

// ============================================================
// 构造、渲染与重新解析
// ============================================================

/** 容器节点的子项：字符串包装为 text 节点 */
const wrapChildren = (children) => children.map((c) => (typeof c === 'string' ? createText(c) : c));
/** 格式节点工厂：不传子项即为无内容的格式节点 */
const format = (type) => (...children) => ({ type, children: wrapChildren(children) });
const strong = format('strong');
const emphasis = format('emphasis');
const del = format('delete');
const underline = format('underline');
const superscript = format('superscript');
const subscript = format('subscript');
const text = createText;
const html = (value) => ({ type: 'html', value });
/** 链接工厂：linkTo(地址)(子项…)；link 指向默认地址 LINK_URL */
const linkTo = (url) => (...children) => ({ type: 'link', url, title: null, children: wrapChildren(children) });
const link = linkTo(LINK_URL);
const inlineCode = (value) => ({ type: 'inlineCode', value });

function renderParagraph(children) {
    return mdRenderer.render(createDocument({ ir: createRoot([createParagraph(children)]) }));
}

async function reparse(md) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    return liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(md));
}

/**
 * 节点简式，用于失败信息：文本 → 字符串，html → { html }，行内代码 → { code }，链接与图片另带地址，
 * 其余 → { 类型: 子节点简式 }
 */
function brief(node) {
    if (node.type === 'text') return node.value;
    if (node.type === 'html') return { html: node.value };
    if (node.type === 'inlineCode') return { code: node.value };
    if (node.type === 'link') return { link: node.url, children: (node.children || []).map(brief) };
    if (node.type === 'image') return { image: node.url, alt: node.alt };
    if (Array.isArray(node.children)) return { [node.type]: node.children.map(brief) };
    return { [node.type]: node.value === undefined ? null : node.value };
}

/**
 * 单个节点的描述：段落直属文本写作 text("…")，容器内的文本只写 JSON 字符串；空文本写作 text('')、空 html 写作
 * html('')，以便区分 strong() 与 strong(text(''))；指向 LINK_URL 的链接只写子节点，如 link("甲站")，其余链接另写
 * 地址，如 link[mailto:a@b.com]("a@b.com")；行内代码写作 code("…")
 */
function describeNode(node, top = true) {
    if (node.type === 'text') {
        if (!node.value) return "text('')";
        return top ? `text(${JSON.stringify(node.value)})` : JSON.stringify(node.value);
    }
    if (node.type === 'html') return node.value ? `html(${JSON.stringify(node.value)})` : "html('')";
    if (node.type === 'inlineCode') return `code(${JSON.stringify(node.value)})`;
    const inner = (node.children || []).map((child) => describeNode(child, false)).join(', ');
    if (node.type === 'link' && node.url !== LINK_URL) return `link[${node.url}](${inner})`;
    return `${node.type}(${inner})`;
}

const describeIr = (nodes) => `[${nodes.map((node) => describeNode(node)).join(', ')}]`;

/**
 * 行内节点序列展平为片段序列：文本片段为 { text, formats }，formats 为祖先中各格式类型与「link=地址」的集合（排序后
 * 以「+」连接）；行内代码为原子片段 { code, formats }。相邻且格式集合相同的文本片段合并，空文本与值为空串的 html 节点
 * 略去，产物为空的节点因而不产生片段。容许 liftInlineHtml 合并相邻同类节点与嵌套次序变化；其余类型的节点（残留的
 * 非空 html、图片、硬换行等）记为 { unexpected } 片段，与原 IR 的任何片段都不相等
 */
function flatten(nodes, formats = [], out = []) {
    for (const node of nodes) {
        if (node.type === 'text') {
            appendSegment(out, node.value, formats);
        } else if (FORMAT_TYPES.includes(node.type) || node.type === 'link') {
            const key = node.type === 'link' ? `link=${node.url}` : node.type;
            const next = formats.includes(key) ? formats : [...formats, key].sort();
            flatten(node.children || [], next, out);
        } else if (node.type === 'inlineCode') {
            out.push({ code: node.value, formats: formats.join('+') });
        } else if (node.type !== 'html' || node.value) {
            out.push({ unexpected: node.type, value: node.value });
        }
    }
    return out;
}

function appendSegment(out, value, formats) {
    if (!value) return;
    const key = formats.join('+');
    const last = out[out.length - 1];
    if (last && last.text !== undefined && last.formats === key) last.text += value;
    else out.push({ text: value, formats: key });
}

/** 文本与行内代码的原文串接，用于核对重新解析后是否多出定界符字符 */
const plainText = (nodes) => nodes.map((node) => {
    if (node.type === 'text' || node.type === 'inlineCode') return node.value;
    return plainText(node.children || []);
}).join('');

/**
 * 行内节点的产物是否为空，与渲染器的判定一致：text 与 html 看 value 是否为空串；六种格式节点在全部子节点产物为空时
 * 为空（无子节点视同为空）；链接与其余类型一律视为非空
 */
function isEmptyOutput(node) {
    if (node.type === 'text' || node.type === 'html') return !node.value;
    if (!FORMAT_TYPES.includes(node.type)) return false;
    return !Array.isArray(node.children) || node.children.every(isEmptyOutput);
}

/**
 * 参照剔除：本文件独立实现的「去掉空节点」，不调用渲染器的内部函数。去掉 value 为空串的 text 与 html，以及子节点
 * 去掉之后已无子节点的六种格式节点；链接只剔除其子节点、不剔除自身。返回新数组，不修改入参
 */
function referencePrune(nodes) {
    const out = [];
    for (const node of nodes) {
        if ((node.type === 'text' || node.type === 'html') && !node.value) continue;
        if (!Array.isArray(node.children)) {
            out.push(node);
            continue;
        }
        const children = referencePrune(node.children);
        if (FORMAT_TYPES.includes(node.type) && children.length === 0) continue;
        out.push({ ...node, children });
    }
    return out;
}

/** 重新解析 md 并与原 IR 比对：往返正确时返回 null，否则返回 { ir, md, reparsed, reasons } */
async function roundTripFailureOf(children, md) {
    const tree = await reparse(md);
    const reasons = [];
    const [paragraph] = tree.children;
    if (tree.children.length !== 1 || paragraph.type !== 'paragraph') {
        reasons.push('重新解析后不是单个段落');
    } else {
        if (!isDeepStrictEqual(flatten(paragraph.children), flatten(children))) reasons.push('片段序列与原 IR 不一致');
        const original = plainText(children);
        const reparsed = plainText(paragraph.children);
        for (const char of DELIMITER_CHARS) {
            if (!original.includes(char) && reparsed.includes(char)) reasons.push(`重新解析文本出现原文没有的「${char}」`);
        }
    }
    return reasons.length ? { ir: describeIr(children), md, reparsed: tree.children.map(brief), reasons } : null;
}

/** 渲染单段 IR 并重新解析，返回 { md, failure }：往返正确时 failure 为 null */
async function renderAndReparse(children) {
    const md = await renderParagraph(children);
    return { md, failure: await roundTripFailureOf(children, md) };
}

/** 逐例检查往返，返回失败项 */
async function roundTripFailures(cases) {
    const failures = [];
    for (const children of cases) {
        const { failure } = await renderAndReparse(children);
        if (failure) failures.push(failure);
    }
    return failures;
}

/** 往返失败的逐项说明：前 limit 项的 IR 描述、md 产物、失败原因与重新解析结果 */
function reportLines(failures, limit = MAX_REPORTED) {
    return failures.slice(0, limit).map((f, i) => `${i + 1}. ${f.ir} → ${JSON.stringify(f.md)}；`
        + `${f.reasons.join('、')}；重新解析：${JSON.stringify(f.reparsed)}`);
}

/** 逐例检查往返，先收集失败项再一次断言；失败信息列出总数、失败数与前若干项 */
async function assertAllRoundTrip(label, cases) {
    const failures = await roundTripFailures(cases);
    const lines = reportLines(failures);
    assert.equal(failures.length, 0, `${label}：${cases.length} 例中 ${failures.length} 例失败，前 ${lines.length} 例：${NL}${lines.join(NL)}`);
}

/** 逐例比对产物与期望值，先收集不符项再一次断言；失败信息列出前若干项的 IR 描述、实际产物与期望产物 */
async function assertOutputs(label, cases) {
    const mismatches = [];
    for (const { children, md: expected } of cases) {
        const md = await renderParagraph(children);
        if (md !== expected) mismatches.push(`${describeIr(children)} → ${JSON.stringify(md)}；期望 ${JSON.stringify(expected)}`);
    }
    const lines = mismatches.slice(0, MAX_REPORTED).map((line, i) => `${i + 1}. ${line}`);
    assert.equal(mismatches.length, 0, `${label}：${cases.length} 例中 ${mismatches.length} 例产物与期望不符，前 ${lines.length} 例：`
        + `${NL}${lines.join(NL)}`);
}

// ============================================================
// 带对照的形态：往返与逐字比对
// ============================================================

/**
 * 产物为空的节点 empty 夹在 before 与 after 之间的形态。control 为去掉 empty 后的同一 IR（深拷贝，不与 children 共享
 * 节点），empty 另记其描述，供分类计数
 */
function around(before, empty, after) {
    return {
        children: [...before, empty, ...after],
        control: structuredClone([...before, ...after]),
        empty: describeNode(empty),
    };
}

/**
 * 逐例检查带对照的形态，返回 { roundTrip, identity }：roundTrip 为往返失败项，identity 为产物与对照形态不同的项。
 * 各失败项另带原用例 item，供分类计数
 */
async function checkShapes(shapes) {
    const roundTrip = [];
    const identity = [];
    for (const item of shapes) {
        const { md, failure } = await renderAndReparse(item.children);
        if (failure) roundTrip.push({ ...failure, item });
        const controlMd = await renderParagraph(item.control);
        if (md !== controlMd) identity.push({ ir: describeIr(item.children), md, controlMd, item });
    }
    return { roundTrip, identity };
}

/** 逐字比对失败的逐项说明：前 limit 项的 IR 描述、md 产物与去掉空节点后的产物 */
function identityLines(failures, limit = MAX_REPORTED) {
    return failures.slice(0, limit).map((f, i) => `${i + 1}. ${f.ir} → ${JSON.stringify(f.md)}；`
        + `去掉空节点后为 ${JSON.stringify(f.controlMd)}`);
}

/** 按键抽样：每个键只取首个失败项，失败信息因而覆盖各类别，不被同一形态的十种空节点占满 */
function firstPerKey(failures, keyOf) {
    const seen = new Set();
    return failures.filter((f) => {
        const key = keyOf(f.item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** 先断言对照形态（去掉空节点后的 IR）往返正确：对照形态本身出错时该形态属范围外，不能用来判定空节点的影响 */
async function assertControlsRoundTrip(label, controls) {
    const failures = await roundTripFailures(controls);
    const lines = reportLines(failures);
    assert.equal(failures.length, 0, `${label}：去掉空节点后的对照形态 ${controls.length} 例中 ${failures.length} 例往返失败（形态`
        + `本身属范围外），前 ${lines.length} 例：${NL}${lines.join(NL)}`);
}

/** 按键统计出错的用例：返回「键 出错数/总数」的列表，只列出错数非零的键；同一用例往返与逐字比对都失败时只计一次 */
function tally(shapes, failedItems, keyOf) {
    const stats = new Map();
    for (const item of shapes) {
        const key = keyOf(item);
        const entry = stats.get(key) || { total: 0, failed: 0 };
        entry.total += 1;
        if (failedItems.has(item)) entry.failed += 1;
        stats.set(key, entry);
    }
    return [...stats].filter(([, entry]) => entry.failed > 0).map(([key, entry]) => `${key} ${entry.failed}/${entry.total}`);
}

/**
 * 一次断言往返与逐字比对的结果。breakdowns 为 [标题, keyOf] 列表，按键列出出错的用例数；给出 sampleBy 时失败信息
 * 每个键列出首例，否则列出前 MAX_REPORTED 例
 */
function assertShapes(label, shapes, { roundTrip, identity }, { breakdowns = [], sampleBy = null } = {}) {
    const failedItems = new Set([...roundTrip, ...identity].map((f) => f.item));
    const summary = breakdowns.map(([title, keyOf]) => `${title}：${tally(shapes, failedItems, keyOf).join('、')}`);
    const rtLines = sampleBy ? reportLines(firstPerKey(roundTrip, sampleBy), Infinity) : reportLines(roundTrip);
    const idLines = sampleBy ? identityLines(firstPerKey(identity, sampleBy), Infinity) : identityLines(identity);
    const scope = sampleBy ? '每类首例' : `前 ${MAX_REPORTED} 例`;
    assert.equal(roundTrip.length + identity.length, 0, [
        `${label}：${shapes.length} 例中往返失败 ${roundTrip.length} 例、与去掉空节点后的产物不一致 ${identity.length} 例；`
            + `出错用例（往返或逐字比对失败）共 ${failedItems.size} 例`,
        ...summary,
        `往返失败（${scope}）：`, ...rtLines,
        `逐字比对失败（${scope}）：`, ...idLines,
    ].join(NL));
}

// ============================================================
// 已列形态
// ============================================================

/** 实测确认的 13 种形态；各行注释为修复前（d5d6823）的产物与重新解析的结果 */
function listedShapes() {
    return [
        // 「# 标题」：段首空节点使 before 为空串，「#」不转义，重新解析为一级标题
        around([], strong(), [text('# 标题')]),
        // 「甲\!」：空文本使 after 为空串，末尾反斜杠不转义，反斜杠转义了感叹号
        around([text(`甲${BACKSLASH}`)], text(''), [text('!')]),
        // 「甲![甲站](https://a.com)」：空 html 的 peek 报「<」，感叹号不转义，重新解析为图片
        around([text('甲!')], html(''), [link('甲站')]),
        // 「甲 乙」：紧接 html 节点之前的行尾换行改为空格
        around([text(`甲${NL}`)], html(''), [text('乙')]),
        // 「 甲」：行首空格不转义，被解析器去掉
        around([], strong(), [text(' 甲')]),
        // 「甲 」：行尾空格不转义，被解析器去掉
        around([text('甲 ')], strong(), []),
        // 「甲&amp;」：「&」不转义，重新解析为字符引用
        around([text('甲&')], text(''), [text('amp;')]),
        // 「甲<b>乙」：「<」不转义，重新解析为 HTML 标签
        around([text('甲<')], strong(), [text('b>乙')]),
        // 「甲\」加换行再加「乙」：反斜杠不转义，与其后的换行构成硬换行
        around([text(`甲${BACKSLASH}`)], text(''), [text(`${NL}乙`)]),
        // 「甲  」加换行再加「乙」：两个尾随空格不转义，与其后的换行构成硬换行
        around([text('甲  ')], del(), [text(`${NL}乙`)]),
        // 「甲」加换行再加「# 标题」：段中换行后的「#」不转义，第二行成为标题
        around([text(`甲${NL}`)], strong(), [text('# 标题')]),
        // 「    缩进」：行首的四个空格不转义，成为缩进代码块
        around([], emphasis(), [text('    缩进')]),
        // 「甲\[乙](https://a.com)」：末尾反斜杠不转义，转义了链接的「[」
        around([text(`甲${BACKSLASH}`)], text(''), [link('乙')]),
    ];
}

// ============================================================
// 矩阵
// ============================================================

// 产物为空的节点 E：以工厂给出，每例新建节点
const EMPTY_NODES = [
    () => text(''),
    () => html(''),
    () => strong(),
    () => emphasis(),
    () => del(),
    () => strong(text('')),
    () => underline(),
    () => superscript(),
    () => subscript(),
    () => del(strong(text(''))),
];
// 段首的行首记号：去掉 E 后均转义；修复前 E 在前时 before 为空串，记号原样写出
const PARAGRAPH_START_MARKERS = ['# 标题', '#', '1. 项', '1.', '1) 项', '- 项', '-', '+ 项', '> 引', '---'];
// 段中换行后的行首记号：单独的「1.」是空列表项，不能打断段落；「=」只在段中才构成 setext 标题下划线；故与段首的
// 表略有不同
const LINE_BREAK_MARKERS = ['# 标题', '#', '1. 项', '1) 项', '- 项', '-', '+ 项', '> 引', '---', '='];
// 行首空白：一个、两个与四个空格
const LEADING_SPACES = [' 甲', '  甲', '    缩进'];

/** 矩阵形态：E 之前与之后的节点以工厂给出，每例新建节点 */
const shape = (category, before, after) => ({ category, before, after });

const MATRIX_SHAPES = [
    ...PARAGRAPH_START_MARKERS.map((x) => shape('段首行首记号', () => [], () => [text(x)])),
    ...LEADING_SPACES.map((x) => shape('段首行首空白', () => [], () => [text(x)])),
    ...[...LINE_BREAK_MARKERS, ...LEADING_SPACES].map((x) => shape('段中换行后', () => [text(`甲${NL}`)], () => [text(x)])),
    // 「-」「+」「1.」在行首的转义另要求其后紧跟空白（「-」之后亦可为「-」），E 把记号与该字符隔开
    shape('行首记号与其后的必需字符被隔开', () => [text('-')], () => [text(' 项')]),
    shape('行首记号与其后的必需字符被隔开', () => [text('+')], () => [text(' 项')]),
    shape('行首记号与其后的必需字符被隔开', () => [text('1.')], () => [text(' 项')]),
    shape('行首记号与其后的必需字符被隔开', () => [text('-')], () => [text('--')]),
    shape('行首记号与其后的必需字符被隔开', () => [text(`甲${NL}-`)], () => [text(' 项')]),
    shape('段尾行尾空白', () => [text('甲 ')], () => []),
    shape('段尾行尾空白', () => [text('甲  ')], () => []),
    // E 之后的 ASCII 标点来自文本本身，或来自链接、行内代码、HTML 标签与定界符的首字
    ...[
        () => text('!'), () => text('(注)'), () => link('乙'), () => inlineCode('x'), () => underline('乙'),
        () => strong('乙'), () => emphasis('乙'), () => del('乙'),
    ].map((next) => shape('反斜杠加 ASCII 标点', () => [text(`甲${BACKSLASH}`)], () => [next()])),
    shape('反斜杠加换行', () => [text(`甲${BACKSLASH}`)], () => [text(`${NL}乙`)]),
    shape('空格加换行', () => [text('甲  ')], () => [text(`${NL}乙`)]),
    shape('空格加换行', () => [text('甲 ')], () => [text(`${NL}乙`)]),
    shape('感叹号加链接', () => [text('甲!')], () => [link('甲站')]),
    shape('感叹号加链接', () => [text('!')], () => [link('乙')]),
    shape('感叹号加链接', () => [text('甲!')], () => [link(strong('乙'))]),
    shape('& 加实体形态', () => [text('甲&')], () => [text('amp;')]),
    shape('& 加实体形态', () => [text('甲&')], () => [text('#x41;')]),
    shape('& 加实体形态', () => [text('&')], () => [text('lt;乙')]),
    ...['b>乙', '/b>乙', 'u>乙', '!-- 注 -->', '?x?>乙'].map((x) => shape('< 加标签形态', () => [text('甲<')], () => [text(x)])),
    ...[() => text('乙'), () => link('乙'), () => underline('乙'), () => inlineCode('x'), () => strong('乙')]
        .map((next) => shape('空 html 之前以换行结尾的文本', () => [text(`甲${NL}`)], () => [next()])),
];

/** 矩阵各例：形态 × E，另带类别，供分类计数 */
function buildMatrix() {
    const cases = [];
    for (const item of MATRIX_SHAPES) {
        for (const makeEmpty of EMPTY_NODES) cases.push({ ...around(item.before(), makeEmpty(), item.after()), category: item.category });
    }
    return cases;
}

// ============================================================
// 格式节点与链接内部
// ============================================================

// 空节点位于容器节点的子节点之间或末尾：containerPhrasing 在容器内部同样只凭紧邻兄弟给出 before 与 after
const INNER_CASES = [
    // 末尾反斜杠贴着闭定界符、闭标签或链接的「]」：后一兄弟为空文本时 after 为空串，反斜杠不转义
    [strong(text(`甲${BACKSLASH}`), text(''))],
    [emphasis(text(`甲${BACKSLASH}`), text(''))],
    [del(text(`甲${BACKSLASH}`), text(''))],
    [underline(text(`甲${BACKSLASH}`), text(''))],
    [superscript(text(`甲${BACKSLASH}`), text(''))],
    [link(text(`甲${BACKSLASH}`), text(''))],
    [text('前'), strong(emphasis(text(`甲${BACKSLASH}`), text('')))],
    [link(strong(text(`甲${BACKSLASH}`), text('')))],
    // 反斜杠加 ASCII 标点、反斜杠加换行
    [emphasis(text(`甲${BACKSLASH}`), text(''), text('!'))],
    [emphasis(text(`甲${BACKSLASH}`), text(''), text(`${NL}乙`))],
    // 「&」加实体形态、「<」加标签形态、感叹号加链接
    [strong(text('甲&'), underline(), text('amp;'))],
    [link(text('甲&'), strong(), text('amp;'))],
    [subscript(text('甲&'), text(''), text('#x41;'))],
    [underline(text('甲<'), html(''), text('b>乙'))],
    [strong(text('甲!'), del(), link('乙'))],
    // 段中换行后的行首记号与行首空白
    [strong(text(`甲${NL}`), del(), text('# 标题'))],
    [link(text(`甲${NL}`), emphasis(), text('- 项'))],
    [strong(text(`甲${NL}`), underline(), text(' 乙'))],
    // 空格加换行
    [strong(text('甲  '), del(), text(`${NL}乙`))],
    [link(text('甲 '), html(''), text(`${NL}乙`))],
    // 空 html 之前以换行结尾的文本
    [underline(text(`甲${NL}`), html(''), text('乙'))],
    [link(text(`甲${NL}`), html(''), text('乙'))],
];

// ============================================================
// 种子随机段落
// ============================================================

// 敏感边界文本：行首记号，行首与行尾空白，以反斜杠结尾的文本及可被其转义的 ASCII 标点，感叹号，「&」与实体形态，「<」
// 与标签形态。避开范围外形态：不含「w」「@」「:」。另避开已有专测的数字记号切分形态：不以数字结尾，
// 不以「.」「)」开头（专测见 test/md-list-marker-split.test.js）
const BOUNDARY_TEXTS = [
    '# 标题', '#', '1. 项', '1) 项', '- 项', '-', '+ 项', '> 引', '---', '=',
    ' 甲', '    缩进', '甲 ', '甲  ',
    `甲${BACKSLASH}`, BACKSLASH, '!', '(注)',
    '甲!', '甲&', '&', 'amp;', '#x41;', 'lt;乙', '甲<', '<', 'b>乙', '/b>乙',
];
// 含换行的文本：只作段落直属文本，每段至多一个，因而不会出现连续两个换行
const NEWLINE_TEXTS = [`甲${NL}`, `${NL}乙`];
// 普通文本：汉字、中文标点、ASCII 字母、辅助平面表情与字面星号、波浪号
const ORDINARY_TEXTS = ['甲', '乙丙', '。', '，', '《乙》', '「甲', 'ab', 'a b', EMOJI, '（注）', '*', '~'];
const RANDOM_SEED = 20260925;
const RANDOM_COUNT = 2000;
// 各位置的取值概率：产物为空的节点、敏感边界文本、普通文本、非空格式节点，余下为链接
const EMPTY_RATE = 0.25;
const BOUNDARY_RATE = 0.3;
const ORDINARY_RATE = 0.15;
const FORMAT_RATE = 0.2;
// 抽中敏感边界文本时改取含换行文本的概率（仅段落直属、每段至多一次）
const NEWLINE_RATE = 0.15;
// 容器（格式节点与链接）的嵌套深度上限：深度达到该值的位置只取文本与空文本、空 html
const MAX_DEPTH = 2;

/** mulberry32：32 位状态的确定性伪随机数发生器，返回 [0, 1) 内的数 */
function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const pick = (rand, list) => list[Math.floor(rand() * list.length)];

/**
 * 产物为空的节点：四分之一为空文本，五分之一为空 html，其余为六种格式之一的空格式节点，其子节点无、只含空文本、只含
 * 空 html、只含一个无内容的格式节点四种（最后一种只在深度 0 出现，格式嵌套深度因此 ≤ 2）；深度达到上限时空格式节点
 * 一律改为空 html
 */
function randomEmpty(rand, depth) {
    const roll = rand();
    if (roll < 0.25) return text('');
    if (roll < 0.45 || depth >= MAX_DEPTH) return html('');
    const type = pick(rand, FORMAT_TYPES);
    const shapeRoll = rand();
    if (shapeRoll < 0.4) return format(type)();
    if (shapeRoll < 0.7) return format(type)(text(''));
    if (shapeRoll < 0.85 || depth > 0) return format(type)(html(''));
    return format(type)(format(pick(rand, FORMAT_TYPES))());
}

/**
 * 行内节点：按 EMPTY_RATE、BOUNDARY_RATE、ORDINARY_RATE、FORMAT_RATE 依次取产物为空的节点、敏感边界文本、普通文本与含
 * 1–3 个子节点的格式节点，余下为链接。深度达到上限时格式节点与链接改取普通文本；链接之内不再嵌套链接，改取格式节点。
 * 链接的首个子节点为非空文本，另以 50% 的概率再接一个任意行内节点
 */
function randomInline(rand, depth, ctx) {
    const roll = rand();
    if (roll < EMPTY_RATE) return randomEmpty(rand, depth);
    if (roll < EMPTY_RATE + BOUNDARY_RATE) {
        if (depth === 0 && !ctx.newlineUsed && rand() < NEWLINE_RATE) {
            ctx.newlineUsed = true;
            return text(pick(rand, NEWLINE_TEXTS));
        }
        return text(pick(rand, BOUNDARY_TEXTS));
    }
    if (roll < EMPTY_RATE + BOUNDARY_RATE + ORDINARY_RATE || depth >= MAX_DEPTH) return text(pick(rand, ORDINARY_TEXTS));
    if (roll < EMPTY_RATE + BOUNDARY_RATE + ORDINARY_RATE + FORMAT_RATE || ctx.inLink) {
        const type = pick(rand, FORMAT_TYPES);
        const count = 1 + Math.floor(rand() * 3);
        const children = [];
        for (let i = 0; i < count; i += 1) children.push(randomInline(rand, depth + 1, ctx));
        return format(type)(...children);
    }
    const children = [text(pick(rand, [...BOUNDARY_TEXTS, ...ORDINARY_TEXTS]))];
    if (rand() < 0.5) children.push(randomInline(rand, depth + 1, { ...ctx, inLink: true }));
    return link(...children);
}

/**
 * count 个段落，每段 1–6 个行内节点；可见文本以换行开头或结尾时在段首补「前」、段尾补「后」，避开解析器丢弃的
 * 段首段尾换行
 */
function randomParagraphs(seed, count) {
    const rand = mulberry32(seed);
    const paragraphs = [];
    for (let k = 0; k < count; k += 1) {
        const size = 1 + Math.floor(rand() * 6);
        const ctx = { newlineUsed: false, inLink: false };
        const children = [];
        for (let i = 0; i < size; i += 1) children.push(randomInline(rand, 0, ctx));
        const visible = plainText(children);
        if (visible.startsWith(NL)) children.unshift(text('前'));
        if (visible.endsWith(NL)) children.push(text('后'));
        paragraphs.push(children);
    }
    return paragraphs;
}

// ============================================================
// 用例：已列形态
// ============================================================

test('已列形态：空节点遮住转义语境的 13 种形态（段首行首记号与行首空白、段尾尾随空格、反斜杠、感叹号加链接、「&」「<」、空格加换行、段中换行后、空 html 之前的换行），对照形态往返正确；各例重新解析后格式、链接与文本均不变，产物与去掉空节点后的同一 IR 逐字相同', async () => {
    // Arrange
    const shapes = listedShapes();
    assert.equal(shapes.length, 13);
    await assertControlsRoundTrip('已列形态', shapes.map((item) => item.control));

    // Act
    const result = await checkShapes(shapes);

    // Assert
    assertShapes('已列形态', shapes, result);
});

// ============================================================
// 用例：矩阵
// ============================================================

test('矩阵：10 种产物为空的节点 × 12 类共 60 种敏感边界形态，对照形态往返正确；各例重新解析后格式、链接与文本均不变，产物与去掉空节点后的同一 IR 逐字相同', async () => {
    // Arrange
    const cases = buildMatrix();
    assert.equal(MATRIX_SHAPES.length, 60);
    assert.equal(cases.length, MATRIX_SHAPES.length * EMPTY_NODES.length);
    await assertControlsRoundTrip('矩阵', MATRIX_SHAPES.map((item) => [...item.before(), ...item.after()]));

    // Act
    const result = await checkShapes(cases);

    // Assert：失败信息按形态类别与空节点种类分别计数，每类列出首例
    const byCategory = (item) => item.category;
    assertShapes('矩阵', cases, result, {
        breakdowns: [['按形态类别', byCategory], ['按空节点', (item) => item.empty]],
        sampleBy: byCategory,
    });
});

// ============================================================
// 用例：格式节点与链接内部
// ============================================================

test('格式节点与链接内部：空节点位于六种格式节点或链接的子节点之间或末尾，遮住末尾反斜杠、「&」「<」、感叹号、段中换行与尾随空格的转义语境，对照形态往返正确；各例重新解析后格式、链接与文本均不变，产物与参照剔除后的同一 IR 逐字相同', async () => {
    // Arrange：对照形态由 referencePrune 去掉容器内的空节点
    const shapes = INNER_CASES.map((children) => ({ children, control: referencePrune(children) }));
    await assertControlsRoundTrip('格式节点与链接内部', shapes.map((item) => item.control));

    // Act
    const result = await checkShapes(shapes);

    // Assert
    assertShapes('格式节点与链接内部', shapes, result);
});

// ============================================================
// 用例：已知行为变化
// ============================================================

test('已知行为变化：链接子节点去掉空节点后只剩与地址相同的文本时改写为自动链接，以反斜杠结尾的文本后接空格式节点或空 html 再接汉字时反斜杠不再多转义，产物逐字符合新写法，重新解析后格式、链接与文本均不变', async () => {
    // Arrange：d5d6823 的产物依次为「[https://a.com](https://a.com)」三例、「[a@b.com](mailto:a@b.com)」，以及
    // 「甲」加两个反斜杠加「乙」两例。前者的链接子节点含空节点，不满足「只有一个与地址相同的文本」而写成普通链接，
    // 剔除后写成自动链接；后者的第二个反斜杠来自空节点 peek 报出的「*」或「<」：末尾反斜杠只在 after 为 ASCII 标点
    // 时转义，剔除后 after 取真实邻居「乙」，反斜杠不再转义。新旧写法重新解析的结果相同
    const cases = [
        { children: [link(text(LINK_URL), text(''))], md: `<${LINK_URL}>${NL}` },
        { children: [link(html(''), text(LINK_URL))], md: `<${LINK_URL}>${NL}` },
        { children: [link(text(LINK_URL), strong())], md: `<${LINK_URL}>${NL}` },
        { children: [linkTo('mailto:a@b.com')(text('a@b.com'), text(''))], md: `<a@b.com>${NL}` },
        { children: [text(`甲${BACKSLASH}`), strong(), text('乙')], md: `甲${BACKSLASH}乙${NL}` },
        { children: [text(`甲${BACKSLASH}`), html(''), text('乙')], md: `甲${BACKSLASH}乙${NL}` },
    ];

    // Act & Assert
    await assertOutputs('已知行为变化', cases);
    await assertAllRoundTrip('已知行为变化', cases.map(({ children }) => children));
});

// ============================================================
// 用例：回归护栏（修复前后均应通过）
// ============================================================

test('回归护栏：不含空节点的敏感形态（段首行首记号、段首行首空白、段尾行尾空白、感叹号加链接、反斜杠加感叹号、段中换行后的行首记号、「&」加实体、「<」加标签）产物逐字不变', async () => {
    // Arrange：期望值取自现行代码（d5d6823）的实际产物
    const cases = [
        { children: [text('# 标题')], md: `${BACKSLASH}# 标题${NL}` },
        { children: [text(' 甲')], md: `&#x20;甲${NL}` },
        { children: [text('甲 ')], md: `甲&#x20;${NL}` },
        { children: [text('甲!'), link('甲站')], md: `甲${BACKSLASH}![甲站](${LINK_URL})${NL}` },
        { children: [text(`甲${BACKSLASH}`), text('!')], md: `甲${BACKSLASH}${BACKSLASH}!${NL}` },
        { children: [text(`甲${NL}`), text('# 标题')], md: `甲${NL}${BACKSLASH}# 标题${NL}` },
        { children: [text('甲&'), text('amp;')], md: `甲${BACKSLASH}&amp;${NL}` },
        { children: [text('甲<'), text('b>乙')], md: `甲${BACKSLASH}<b>乙${NL}` },
    ];

    for (const { children, md: expected } of cases) {
        // Act
        const md = await renderParagraph(children);

        // Assert
        assert.equal(md, expected, describeIr(children));
    }
});

// ============================================================
// 用例：种子随机往返
// ============================================================

test(`种子随机往返：种子 ${RANDOM_SEED} 生成 ${RANDOM_COUNT} 个段落（每段 1–6 个行内节点，取自敏感边界文本、普通文本、各类空节点、非空格式节点与链接，各位置以 ${EMPTY_RATE * 100}% 的概率取空节点，容器嵌套深度 ≤ ${MAX_DEPTH}），每段产物与参照剔除后的 IR 产物逐字相同，只由空节点构成的段落产物为空串，其余重新解析后格式、链接与文本均不变`, async () => {
    // Arrange：只由空节点构成的段落渲染为空串，不产生段落节点；其数目随生成器固定
    const cases = randomParagraphs(RANDOM_SEED, RANDOM_COUNT);
    const blank = cases.filter((children) => children.every(isEmptyOutput));
    assert.equal(cases.length, RANDOM_COUNT);
    assert.equal(blank.length, 120);

    // Act：逐段渲染并与参照剔除后的 IR 的产物比对；只由空节点构成的段落核对产物为空串，其余段落核对往返
    const identity = [];
    const nonBlank = [];
    const roundTrip = [];
    for (const children of cases) {
        const md = await renderParagraph(children);
        const controlMd = await renderParagraph(referencePrune(children));
        if (md !== controlMd) identity.push({ ir: describeIr(children), md, controlMd });
        if (children.every(isEmptyOutput)) {
            if (md !== '') nonBlank.push(`${describeIr(children)} → ${JSON.stringify(md)}`);
            continue;
        }
        const failure = await roundTripFailureOf(children, md);
        if (failure) roundTrip.push(failure);
    }

    // Assert：三项一并断言，失败信息分别计数
    const idLines = identityLines(identity);
    const blankLines = nonBlank.slice(0, MAX_REPORTED).map((line, i) => `${i + 1}. ${line}`);
    const rtLines = reportLines(roundTrip);
    assert.equal(identity.length + nonBlank.length + roundTrip.length, 0, [
        `种子随机往返：${cases.length} 段中与参照剔除后的产物不一致 ${identity.length} 段；只由空节点构成的 ${blank.length} 段中`
            + `产物非空 ${nonBlank.length} 段；其余 ${cases.length - blank.length} 段中往返失败 ${roundTrip.length} 段`,
        `逐字比对失败（前 ${idLines.length} 段）：`, ...idLines,
        `产物非空（前 ${blankLines.length} 段）：`, ...blankLines,
        `往返失败（前 ${rtLines.length} 段）：`, ...rtLines,
    ].join(NL));
});
