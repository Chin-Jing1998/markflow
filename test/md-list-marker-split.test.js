/**
 * converters/renderers/md.js：数字与其后的「.」「)」分属相邻 text 节点时，有序列表记号不转义
 * 成因：mdast-util-to-markdown 2.1.2 的有序列表记号模式为 lib/unsafe.js 第 87 行的 {atBreak: true, before: '\\d+',
 * character: ')'} 与第 98 行的 {atBreak: true, before: '\\d+', character: '.', after: '(?:[ \t\r\n]|$)'}。
 * lib/util/compile-pattern.js 把 atBreak 编译为前缀「换行 + 可选的空格或制表符」，整条模式因而要求「换行 + 可选空白
 * + 数字 + 记号」出现在同一个 value 之内。lib/util/safe.js 以 before + 本节点文本 + after 为 value 匹配，只转义本节点
 * 文本所在区间内的字符；containerPhrasing（lib/util/container-phrasing.js）给 text 节点的 before 只有前一兄弟产物的
 * 末字。数字留在前一节点时，前一节点只在 after 里看到记号，记号不在其转义区间内；后一节点的 before 只有一个数字、没有
 * 换行，模式匹配不上。两侧都不转义，段首、段中换行后与硬换行之后的「数字 + 记号」原样写出，重新解析为有序列表。例如
 * 修复前 [text('1'), text('. 项')] 的产物为「1. 项」，重新解析为有序列表；[text('甲'), break, text('1'), text('. 项')]
 * 在硬换行之后成为列表；[strong(text('甲' + 换行 + '1'), text('. 项'))] 的粗体被列表拆散。其余 unsafe 模式的前后条件
 * 只看一个字符，或由行首空格的字符引用兜住，需要多字符前文的只有有序列表记号。
 * 修法：render() 在剔除产物为空的行内节点的同一遍历中（pruneEmptyInline），在数字边界合并 paragraph、heading、
 * tableCell、行内格式与链接之下相邻的 text：前一段以 ASCII 数字结尾、后一段以 ASCII 数字或「.」「)」开头时并为一个
 * 节点，数字与记号因而同处一个节点，safe() 能在同一 value 内匹配到有序列表记号。不合并全部相邻 text：全部合并会把
 * 任意相邻 text 中的转义位置集中到一次 safe() 调用，耗时成为平方级；a48ad6a 时的另一条理由——并入同一 value 的两行
 * 记号因「.」「-」「+」模式的 after 吞掉行尾换行而第二行不转义——已由 render() 补入的前瞻版模式（LINE_MARKER_UNSAFE）
 * 消除，两行记号的回归护栏继续锁定合并不越过换行。缺陷类用例的切分点位于
 * 数字之间、数字与记号之间或记号之后，语境中另有换行之后的切分点；数字边界合并之后，其余切分点不影响转义，产物因而
 * 与合并全部相邻 text 后的同一 IR 逐字相同，缺陷类用例据此逐字比对（见下文断言口径）。
 * 覆盖：
 *   - 已列形态：实测确认出错的 11 种形态。
 *   - 矩阵：数字 0、1、9、12、123456789 × 记号「.」「)」× 4 种切分方式（数字 | 记号加后文；数字前半 | 数字后半加记号
 *     加后文，只适用于多位数；数字 | 记号 | 空格加后文；数字 | 记号且位于段尾），共 34 种切分形态；再 × 17 种语境：
 *     段首、前一文本以换行结尾、硬换行之后、六种格式节点与链接内部的换行之后，以及段首的切分点插入空节点（空文本与
 *     六种无内容的格式节点，每个切分点各插一个），共 578 例。其中格式节点与链接内部以「.」收尾的段尾形态共 35 例，
 *     记号之后紧接闭定界符、闭标签或「]」而非空白，合并后同样不转义，修复前即往返正确且逐字相同，作护栏保留；其余
 *     543 例修复前出错。
 *   - 回归护栏：数字与记号同在一个 text 节点（不含切分）的 17 种形态，产物逐字等于 d332ef0 的产物；另有修复前不出错的
 *     切分形态 4 种，只断言往返。
 *   - 两行记号的回归护栏：第一行只有记号（1.、0.、12.、1)、2)、-、+、*）8 种，第二行以记号开头（1. 项、1.、1) 项、
 *     2. 项、- 项、+ 项、* 项）7 种，切分点都在换行处（切在换行之前、切在换行之后、换行单独成节点）3 种，× 4 种语境
 *     （段首、前文以换行结尾、硬换行之后、strong 内换行之后），共 672 例。修复前两个节点各自转义，全部往返正确；两行
 *     一旦并入同一 value 即可能出错，合并全部相邻 text 的修法在其中 60 例上出错。只断言往返。
 *   - 种子随机往返：固定种子生成 2000 个段落，每段 1–5 个段落直属位置，各位置按 20% 取产物为空的节点、45% 取切分文本、
 *     12% 取硬换行、13% 取非空格式节点（六种），余下取链接（链接文本与地址不同）。切分文本在随机码点处切成 1–4 个
 *     相邻 text，切分点按 30% 插入产物为空的节点；格式节点与链接的子节点同样由切分文本、空节点与嵌套的非空格式节点
 *     组成，容器嵌套深度 ≤ 2，链接不嵌套链接。文本池以行首「数字 + 记号」形态为主，另含换行在中间的文本、以换行开头
 *     或结尾的文本（只作段落直属文本，每段至多一个，以换行开头的只取「)」记号——本文件写就时的限制，两行记号形态另由
 *     md-line-marker-newline.test.js 覆盖）与普通文本；段首七成、硬换行之后与
 *     以换行结尾的文本之后一律取行首形态。硬换行只接在文本或容器之后，段尾不留硬换行；可见文本以换行开头或结尾时
 *     在段首补「前」、段尾补「后」。只由空节点构成的段落产物须为空串，其余逐例往返正确。
 * 断言口径：缺陷类用例（已列形态、矩阵）断言两项。其一，往返正确：逐例经 remark-parse + remark-gfm + liftInlineHtml
 * 重新解析后只有一个段落，「文本 + 格式集合」片段序列与原 IR 一致（链接视作带 url 的格式，硬换行视作原子片段，相邻 text
 * 与产物为空的节点不影响片段序列），且不出现原文没有的「*」「~」。其二，产物与参照归并（本文件独立实现的剔除空节点并
 * 合并相邻 text，referenceNormalize）后的同一 IR 逐字相同。两项之前先断言对照形态（参照归并后的 IR）往返正确，以确认
 * 形态本身在范围内。种子随机往返只断言往返正确与空段落的产物为空串，不约束写法。回归护栏：单节点形态逐字比对；修复前
 * 不出错的切分形态与两行记号形态只断言往返。
 * 范围外（修复前后都会出错，或属解析器的固有行为），矩阵与随机文本池均已避开：
 *   - 含「www」「@」「:」的文本：remark-gfm 在解析后的文本上识别自动链接，转义拦不住；
 *   - 段首或段尾的换行：解析器丢弃；
 *   - 含连续两个换行的产物：分成两段；
 *   - 相邻的两个 inlineCode：由前一修复（00b479f，在两段之间插入空 HTML 注释）处理，不属本缺陷，本文件仍不生成行内
 *     代码；
 *   - 段尾的硬换行：本文件写就时属范围外——产物「甲\」加换行重新解析为字面反斜杠，硬换行丢失——现已由 render() 把段落与
 *     标题末尾连续的硬换行改写为 <br> 修复，覆盖见 test/md-trailing-break.test.js；本文件仍不在段尾留硬换行；
 *   - 同一个 text 节点内，只有「数字 + .」「-」或「+」的一行紧接换行、下一行行首又是同一种记号加空白（如 [text('0.' +
 *     换行 + '1. 项')]，数字边界合并后的 [text('1'), text('.' + 换行 + '1. 项')] 亦同）：本文件写就时属范围外——这三种
 *     模式的 after 吃掉行尾换行，下一行的记号不转义——现已由 render() 补入的前瞻版模式（LINE_MARKER_UNSAFE）修复，覆盖
 *     见 test/md-line-marker-newline.test.js；本文件仍不测单节点形态，随机文本池中以换行开头的文本仍只取「)」记号，切在
 *     换行处的两行由两行记号的回归护栏覆盖；
 *   - root 直接挂行内节点：pruneEmptyInline 不处理 root 的子节点（与 d332ef0 剔除空节点的范围一致），其下相邻 text 不
 *     合并，如 root 之下直接挂 [text('1'), text('. 项')] 仍输出「1. 项」、重新解析为有序列表；常规 IR 的行内节点总在
 *     段落、标题或单元格之内，本文件只渲染段落与标题；
 *   - 制表符：ir/markers 的 applyTextLayout 把非代码文本中的制表符改为两个全角空格，用例不含制表符。
 * 另有三类切分形态修复前即往返正确：记号之后切分（[text('1.'), text(' 项')] 输出「1」加反斜杠加「. 项」）、超过 9 位
 * 的数字（不构成列表记号）、标题内的切分（标题内容不按块级结构解析）。这三类与子节点拼接后等于地址的链接只断言往返：
 * 10 位数字一例切在数字边界上，合并后与单个节点同样写作「1234567890」加反斜杠加「. 项」，多出的反斜杠无害；标题内的
 * 切分合并后仍写作「## 1. 项」；记号之后切分与该链接（[text('https://a'), text('.com')]）的切分点不在数字边界上，
 * 不合并，产物不变；重新解析的结果均不变。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDeepStrictEqual } = require('node:util');

const mdRenderer = require('../converters/renderers/md');
const { loadUnified } = require('../converters/ir/unified-loader');
const { liftInlineHtml } = require('../converters/ir/inline-html');
const { createDocument, createRoot, createHeading, createParagraph, createText } = require('../converters/ir/schema');

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
const hardBreak = () => ({ type: 'break' });
/** 链接工厂：linkTo(地址)(子项…)；link 指向默认地址 LINK_URL */
const linkTo = (url) => (...children) => ({ type: 'link', url, title: null, children: wrapChildren(children) });
const link = linkTo(LINK_URL);
/** 切分后的各段文本依次建为相邻的 text 节点 */
const texts = (pieces) => pieces.map((piece) => text(piece));

/** 渲染单个块级节点（段落或标题） */
function renderBlock(block) {
    return mdRenderer.render(createDocument({ ir: createRoot([block]) }));
}

const renderParagraph = (children) => renderBlock(createParagraph(children));

async function reparse(md) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    return liftInlineHtml(unified().use(remarkParse).use(remarkGfm).parse(md));
}

/**
 * 节点简式，用于失败信息：文本 → 字符串，html → { html }，链接与图片另带地址，其余 → { 类型: 子节点简式 }，无子节点
 * 的节点（硬换行、行内代码等）→ { 类型: value }
 */
function brief(node) {
    if (node.type === 'text') return node.value;
    if (node.type === 'html') return { html: node.value };
    if (node.type === 'link') return { link: node.url, children: (node.children || []).map(brief) };
    if (node.type === 'image') return { image: node.url, alt: node.alt };
    if (Array.isArray(node.children)) return { [node.type]: node.children.map(brief) };
    return { [node.type]: node.value === undefined ? null : node.value };
}

/**
 * 单个节点的描述：段落直属文本写作 text("…")，容器内的文本只写 JSON 字符串；空文本写作 text('')、空 html 写作
 * html('')，硬换行写作 break；指向 LINK_URL 的链接只写子节点，如 link("甲站")，其余链接另写地址
 */
function describeNode(node, top = true) {
    if (node.type === 'text') {
        if (!node.value) return "text('')";
        return top ? `text(${JSON.stringify(node.value)})` : JSON.stringify(node.value);
    }
    if (node.type === 'html') return node.value ? `html(${JSON.stringify(node.value)})` : "html('')";
    if (node.type === 'break') return 'break';
    const inner = (node.children || []).map((child) => describeNode(child, false)).join(', ');
    if (node.type === 'link' && node.url !== LINK_URL) return `link[${node.url}](${inner})`;
    return `${node.type}(${inner})`;
}

const describeIr = (nodes) => `[${nodes.map((node) => describeNode(node)).join(', ')}]`;
/** 块级节点的描述：段落只写子节点，标题另写层级，如 heading2[text("1"), text(". 项")] */
const describeBlock = (block) => (block.type === 'heading' ? `heading${block.depth}` : '') + describeIr(block.children);

/**
 * 行内节点序列展平为片段序列：文本片段为 { text, formats }，formats 为祖先中各格式类型与「link=地址」的集合（排序后
 * 以「+」连接）；硬换行为原子片段 { break, formats }。相邻且格式集合相同的文本片段合并，空文本与值为空串的 html 节点
 * 略去，切分出的相邻 text 与产物为空的节点因而不影响片段序列。容许 liftInlineHtml 合并相邻同类节点与嵌套次序变化；
 * 其余类型的节点（残留的非空 html、图片、行内代码等）记为 { unexpected } 片段，与原 IR 的任何片段都不相等
 */
function flatten(nodes, formats = [], out = []) {
    for (const node of nodes) {
        if (node.type === 'text') {
            appendSegment(out, node.value, formats);
        } else if (FORMAT_TYPES.includes(node.type) || node.type === 'link') {
            const key = node.type === 'link' ? `link=${node.url}` : node.type;
            const next = formats.includes(key) ? formats : [...formats, key].sort();
            flatten(node.children || [], next, out);
        } else if (node.type === 'break') {
            out.push({ break: true, formats: formats.join('+') });
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

/** 文本的原文串接（硬换行不计入），用于核对重新解析后是否多出定界符字符，以及随机段落的可见文本首尾是否为换行 */
const plainText = (nodes) => nodes.map((node) => {
    if (node.type === 'text') return node.value;
    return plainText(node.children || []);
}).join('');

/**
 * 行内节点的产物是否为空，与渲染器的判定一致：text 与 html 看 value 是否为空串；六种格式节点在全部子节点产物为空时
 * 为空（无子节点视同为空）；链接、硬换行与其余类型一律视为非空
 */
function isEmptyOutput(node) {
    if (node.type === 'text' || node.type === 'html') return !node.value;
    if (!FORMAT_TYPES.includes(node.type)) return false;
    return !Array.isArray(node.children) || node.children.every(isEmptyOutput);
}

/**
 * 参照归并：本文件独立实现的「剔除空节点 + 合并相邻 text」，不调用渲染器的内部函数。逐层先递归处理子节点，再去掉
 * value 为空串的 text 与 html、子节点处理后已无子节点的六种格式节点（链接只处理其子节点、不剔除自身），并把同一父节点
 * 下相邻的 text 合并为一个；空节点去掉后两侧的 text 随之相邻、一并合并。连续的 text 先收集各段文本、再一次拼接。
 * 返回新数组，不修改入参
 */
function referenceNormalize(nodes) {
    const out = [];
    let run = [];
    const flush = () => {
        if (run.length) out.push(text(run.join('')));
        run = [];
    };
    for (const node of nodes) {
        if (node.type === 'text') {
            if (node.value) run.push(node.value);
            continue;
        }
        if (node.type === 'html' && !node.value) continue;
        if (!Array.isArray(node.children)) {
            flush();
            out.push(node);
            continue;
        }
        const children = referenceNormalize(node.children);
        if (FORMAT_TYPES.includes(node.type) && children.length === 0) continue;
        flush();
        out.push({ ...node, children });
    }
    flush();
    return out;
}

/** 重新解析 md 并与原块级节点比对：往返正确时返回 null，否则返回 { ir, md, reparsed, reasons } */
async function roundTripFailureOf(block, md) {
    const tree = await reparse(md);
    const reasons = [];
    const [first] = tree.children;
    if (tree.children.length !== 1 || first.type !== block.type || first.depth !== block.depth) {
        reasons.push(`重新解析后不是单个${block.type === 'heading' ? `${block.depth} 级标题` : '段落'}`);
    } else {
        if (!isDeepStrictEqual(flatten(first.children), flatten(block.children))) reasons.push('片段序列与原 IR 不一致');
        const original = plainText(block.children);
        const reparsed = plainText(first.children);
        for (const char of DELIMITER_CHARS) {
            if (!original.includes(char) && reparsed.includes(char)) reasons.push(`重新解析文本出现原文没有的「${char}」`);
        }
    }
    return reasons.length ? { ir: describeBlock(block), md, reparsed: tree.children.map(brief), reasons } : null;
}

/** 渲染块级节点并重新解析，返回 { md, failure }：往返正确时 failure 为 null */
async function renderAndReparse(block) {
    const md = await renderBlock(block);
    return { md, failure: await roundTripFailureOf(block, md) };
}

/** 逐例检查块级节点的往返，返回失败项 */
async function roundTripFailures(blocks) {
    const failures = [];
    for (const block of blocks) {
        const { failure } = await renderAndReparse(block);
        if (failure) failures.push(failure);
    }
    return failures;
}

/** 往返失败的逐项说明：前 limit 项的 IR 描述、md 产物、失败原因与重新解析结果 */
function reportLines(failures, limit = MAX_REPORTED) {
    return failures.slice(0, limit).map((f, i) => `${i + 1}. ${f.ir} → ${JSON.stringify(f.md)}；`
        + `${f.reasons.join('、')}；重新解析：${JSON.stringify(f.reparsed)}`);
}

/** 逐例检查块级节点的往返，先收集失败项再一次断言；失败信息列出总数、失败数与前若干项 */
async function assertAllRoundTrip(label, blocks) {
    const failures = await roundTripFailures(blocks);
    const lines = reportLines(failures);
    assert.equal(failures.length, 0, `${label}：${blocks.length} 例中 ${failures.length} 例失败，前 ${lines.length} 例：${NL}${lines.join(NL)}`);
}

// ============================================================
// 带对照的形态：往返与逐字比对
// ============================================================

/**
 * 带对照的形态：children 为段落的子节点，control 为参照归并后的同一 IR（先深拷贝，不与 children 共享节点）；
 * extra 另记分类字段，供分类计数
 */
const withControl = (children, extra = {}) => ({ children, control: referenceNormalize(structuredClone(children)), ...extra });

/**
 * 逐例检查带对照的形态，返回 { roundTrip, identity }：roundTrip 为往返失败项，identity 为产物与对照形态不同的项。
 * 各失败项另带原用例 item，供分类计数
 */
async function checkShapes(shapes) {
    const roundTrip = [];
    const identity = [];
    for (const item of shapes) {
        const { md, failure } = await renderAndReparse(createParagraph(item.children));
        if (failure) roundTrip.push({ ...failure, item });
        const controlMd = await renderParagraph(item.control);
        if (md !== controlMd) identity.push({ ir: describeIr(item.children), md, controlMd, item });
    }
    return { roundTrip, identity };
}

/** 逐字比对失败的逐项说明：前 limit 项的 IR 描述、md 产物与参照归并后的产物 */
function identityLines(failures, limit = MAX_REPORTED) {
    return failures.slice(0, limit).map((f, i) => `${i + 1}. ${f.ir} → ${JSON.stringify(f.md)}；`
        + `合并相邻 text 后为 ${JSON.stringify(f.controlMd)}`);
}

/** 按键抽样：每个键只取首个失败项，失败信息因而覆盖各类别，不被同一语境的多个组合占满 */
function firstPerKey(failures, keyOf) {
    const seen = new Set();
    return failures.filter((f) => {
        const key = keyOf(f.item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** 先断言对照形态（参照归并后的 IR）往返正确：对照形态本身出错时该形态属范围外，不能用来判定切分的影响 */
async function assertControlsRoundTrip(label, controls) {
    const failures = await roundTripFailures(controls.map((children) => createParagraph(children)));
    const lines = reportLines(failures);
    assert.equal(failures.length, 0, `${label}：参照归并后的对照形态 ${controls.length} 例中 ${failures.length} 例往返失败（形态`
        + `本身属范围外），前 ${lines.length} 例：${NL}${lines.join(NL)}`);
}

/**
 * 按键统计：返回「键 出错数/总数（往返失败数、逐字比对失败数）」的列表，列出全部键；同一用例往返与逐字比对都失败时
 * 出错数只计一次。总数减出错数即修复前不出错、作护栏保留的例数
 */
function tally(shapes, { roundTrip, identity }, keyOf) {
    const roundTripItems = new Set(roundTrip.map((f) => f.item));
    const identityItems = new Set(identity.map((f) => f.item));
    const stats = new Map();
    for (const item of shapes) {
        const key = keyOf(item);
        const entry = stats.get(key) || { total: 0, failed: 0, roundTrip: 0, identity: 0 };
        entry.total += 1;
        if (roundTripItems.has(item)) entry.roundTrip += 1;
        if (identityItems.has(item)) entry.identity += 1;
        if (roundTripItems.has(item) || identityItems.has(item)) entry.failed += 1;
        stats.set(key, entry);
    }
    return [...stats].map(([key, e]) => `${key} ${e.failed}/${e.total}（往返 ${e.roundTrip}、逐字 ${e.identity}）`);
}

/**
 * 一次断言往返与逐字比对的结果。breakdowns 为 [标题, keyOf] 列表，按键列出各类的出错数与总数；给出 sampleBy 时
 * 失败信息每个键列出首例，否则列出前 limit 例
 */
function assertShapes(label, shapes, result, { breakdowns = [], sampleBy = null, limit = MAX_REPORTED } = {}) {
    const { roundTrip, identity } = result;
    const failedItems = new Set([...roundTrip, ...identity].map((f) => f.item));
    const summary = breakdowns.map(([title, keyOf]) => `${title}：${tally(shapes, result, keyOf).join('、')}`);
    const rtLines = sampleBy ? reportLines(firstPerKey(roundTrip, sampleBy), Infinity) : reportLines(roundTrip, limit);
    const idLines = sampleBy ? identityLines(firstPerKey(identity, sampleBy), Infinity) : identityLines(identity, limit);
    const scope = sampleBy ? '每类首例' : `前 ${Math.min(limit, shapes.length)} 例`;
    assert.equal(roundTrip.length + identity.length, 0, [
        `${label}：${shapes.length} 例中往返失败 ${roundTrip.length} 例、与合并相邻 text 后的产物不一致 ${identity.length} 例；`
            + `出错用例（往返或逐字比对失败）共 ${failedItems.size} 例`,
        ...summary,
        `往返失败（${scope}）：`, ...rtLines,
        `逐字比对失败（${scope}）：`, ...idLines,
    ].join(NL));
}

// ============================================================
// 已列形态
// ============================================================

/** 实测确认出错的 11 种形态；各行注释为修复前（d332ef0）的产物与重新解析的结果 */
function listedShapes() {
    return [
        // 「1. 项」：前一节点只在 after 里看到「.」，后一节点的 before 只有「1」、没有换行，重新解析为有序列表
        withControl([text('1'), text('. 项')]),
        // 「1) 项」：「)」同理，重新解析为有序列表
        withControl([text('1'), text(') 项')]),
        // 「12. 项」：多位数字整体留在前一节点
        withControl([text('12'), text('. 项')]),
        // 「12. 项」：切分点在两位数字之间，后一节点的 before 只有「1」
        withControl([text('1'), text('2. 项')]),
        // 「1. 项」：数字、记号、空格加后文各成一个节点
        withControl([text('1'), text('.'), text(' 项')]),
        // 「0. 项」：起始编号 0 同样构成列表记号
        withControl([text('0'), text('. 项')]),
        // 「1.」：段尾的数字与记号，重新解析为空列表项
        withControl([text('1'), text('.')]),
        // 「甲」加换行再加「1. 项」：换行与数字同在前一节点，段中换行后的「1.」打断段落，第二行成为列表
        withControl([text(`甲${NL}1`), text('. 项')]),
        // 「甲\」加换行再加「1. 项」：硬换行之后的「1.」打断段落，成为列表
        withControl([text('甲'), hardBreak(), text('1'), text('. 项')]),
        // 「**甲」加换行再加「1. 项**」：粗体内换行后的「1.」打断段落，粗体被拆散
        withControl([strong(text(`甲${NL}1`), text('. 项'))]),
        // 「1. 项」：切分点夹着的空文本先被剔除，剔除后数字与记号仍分属两个节点
        withControl([text('1'), text(''), text('. 项')]),
    ];
}

// ============================================================
// 矩阵
// ============================================================

// 数字：0 与 9 为单个数字的两端，1 是唯一能打断段落的起始编号，12 为两位数，123456789 为列表记号允许的最长 9 位
const MATRIX_DIGITS = ['0', '1', '9', '12', '123456789'];
const MATRIX_MARKERS = ['.', ')'];
/** 在数字 digits 的中点切开，返回 [前半, 后半] */
const halves = (digits) => [digits.slice(0, Math.floor(digits.length / 2)), digits.slice(Math.floor(digits.length / 2))];
// 切分方式：给出数字 d 与记号 m，返回相邻 text 的各段文本；不适用时返回 null（单个数字无从在数字之间切分）
const SPLITS = [
    { name: '数字 | 记号加后文', pieces: (d, m) => [d, `${m} 项`] },
    { name: '数字前半 | 数字后半加记号加后文', pieces: (d, m) => (d.length < 2 ? null : [halves(d)[0], `${halves(d)[1]}${m} 项`]) },
    { name: '数字 | 记号 | 空格加后文', pieces: (d, m) => [d, m, ' 项'] },
    { name: '数字 | 记号（段尾）', pieces: (d, m) => [d, m] },
];
// 容器语境：六种格式节点与链接，内部先有以换行结尾的文本、再接切分形态，容器即段落的全部内容
const CONTAINERS = [
    ['strong', strong], ['emphasis', emphasis], ['delete', del], ['underline', underline], ['superscript', superscript],
    ['subscript', subscript], ['link', link],
];
// 语境：给出切分出的 text 节点，返回段落的子节点
const CONTEXTS = [
    { name: '段首', wrap: (nodes) => nodes },
    { name: '前一文本以换行结尾', wrap: (nodes) => [text(`甲${NL}`), ...nodes] },
    { name: '硬换行之后', wrap: (nodes) => [text('甲'), hardBreak(), ...nodes] },
    ...CONTAINERS.map(([name, make]) => ({ name: `${name} 内换行之后`, wrap: (nodes) => [make(text(`甲${NL}`), ...nodes)] })),
];
// 切分点插入的空节点：空文本与六种无内容的格式节点，以工厂给出，每处新建节点
const SPLIT_EMPTY_NODES = [
    () => text(''), () => strong(), () => emphasis(), () => del(), () => underline(), () => superscript(), () => subscript(),
];
const SPLIT_EMPTY_CONTEXT = '段首切分点插入空节点';

/** 在相邻节点之间（即各切分点）各插入一个 makeEmpty 新建的空节点 */
function interleave(nodes, makeEmpty) {
    const out = [];
    nodes.forEach((node, i) => {
        if (i > 0) out.push(makeEmpty());
        out.push(node);
    });
    return out;
}

/** 切分形态：数字 × 记号 × 适用的切分方式，每项给出各段文本与分类字段 */
function splitShapes() {
    const shapes = [];
    for (const digits of MATRIX_DIGITS) {
        for (const marker of MATRIX_MARKERS) {
            for (const split of SPLITS) {
                const pieces = split.pieces(digits, marker);
                if (pieces) shapes.push({ pieces, digits, marker, split: split.name });
            }
        }
    }
    return shapes;
}

/** 矩阵各例：切分形态 × 语境，另带数字、记号、切分方式、语境与空节点种类，供分类计数 */
function buildMatrix() {
    const cases = [];
    for (const { pieces, ...keys } of splitShapes()) {
        for (const context of CONTEXTS) {
            cases.push(withControl(context.wrap(texts(pieces)), { ...keys, context: context.name, empty: '无' }));
        }
        for (const makeEmpty of SPLIT_EMPTY_NODES) {
            const children = interleave(texts(pieces), makeEmpty);
            cases.push(withControl(children, { ...keys, context: SPLIT_EMPTY_CONTEXT, empty: describeNode(makeEmpty()) }));
        }
    }
    return cases;
}

// ============================================================
// 两行记号：切分点在换行处
// ============================================================

// 第一行只有记号，第二行以记号开头。「.」「-」「+」三种模式的 after 可含换行，两行同处一个 value 时会把行尾换行吃进
// 前一次匹配，第二行的记号不再转义；「*」与「)」不受影响，一并收入作对照
const TWO_LINE_FIRSTS = ['1.', '0.', '12.', '1)', '2)', '-', '+', '*'];
const TWO_LINE_SECONDS = ['1. 项', '1.', '1) 项', '2. 项', '- 项', '+ 项', '* 项'];
// 切分方式：给出两行文本，返回相邻 text 的各段文本，切分点都在换行处；单节点形态属范围外（见文件头）
const TWO_LINE_SPLITS = [
    { name: '切在换行之前', pieces: (first, second) => [first, `${NL}${second}`] },
    { name: '切在换行之后', pieces: (first, second) => [`${first}${NL}`, second] },
    { name: '换行单独成节点', pieces: (first, second) => [first, NL, second] },
];
// 语境：给出切分出的 text 节点，返回段落的子节点
const TWO_LINE_CONTEXTS = [
    { name: '段首', wrap: (nodes) => nodes },
    { name: '前文以换行结尾', wrap: (nodes) => [text(`甲${NL}`), ...nodes] },
    { name: '硬换行之后', wrap: (nodes) => [text('甲'), hardBreak(), ...nodes] },
    { name: 'strong 内换行之后', wrap: (nodes) => [strong(text(`甲${NL}`), ...nodes)] },
];

/** 两行记号形态：第一行 × 第二行 × 切分方式 × 语境，每例为一个段落，另带第一行、切分方式与语境，供分类计数 */
function twoLineCases() {
    const cases = [];
    for (const first of TWO_LINE_FIRSTS) {
        for (const second of TWO_LINE_SECONDS) {
            for (const split of TWO_LINE_SPLITS) {
                for (const context of TWO_LINE_CONTEXTS) {
                    const block = createParagraph(context.wrap(texts(split.pieces(first, second))));
                    cases.push({ block, first, split: split.name, context: context.name });
                }
            }
        }
    }
    return cases;
}

/** 按键统计往返失败数：返回「键 失败数/总数」的列表，列出全部键 */
function countFailures(items, failedItems, keyOf) {
    const stats = new Map();
    for (const item of items) {
        const key = keyOf(item);
        const entry = stats.get(key) || { total: 0, failed: 0 };
        entry.total += 1;
        if (failedItems.has(item)) entry.failed += 1;
        stats.set(key, entry);
    }
    return [...stats].map(([key, e]) => `${key} ${e.failed}/${e.total}`);
}

// ============================================================
// 种子随机段落
// ============================================================

// 行首「数字 + 记号」形态：数字取单个、两位与 9 位，记号取「.」「)」，其后接空格加文字、直接接文字或位于文本末尾；
// 另含记号后不接空白与一行两个记号的形态
const MARKER_TEXTS = [
    '1. 项', '1) 项', '0. 项', '9) 项', '2. 项', '12. 项', '12)', '123456789) 项', '1.', '1)', '0.', '1.项', '1)项', '1. 1) 项',
];
// 换行在中间的文本：换行之后接「数字 + 记号」，可作段落直属文本，也可作格式节点与链接的子节点
const INNER_NEWLINE_TEXTS = [`甲${NL}1. 项`, `甲${NL}1) 项`, `乙${NL}1.`, `乙${NL}1)`, `甲${NL}0. 项`, `甲${NL}12) 项`];
// 以换行开头或结尾的文本：只作段落直属文本且每段至多一个，不紧接硬换行，因而不出现连续两个换行。以换行开头的文本
// 只取「)」记号，是本文件写就时为避开两行记号形态所设的限制（「.」模式的 after 吞掉行尾换行、下一行不转义，该形态现已
// 由 LINE_MARKER_UNSAFE 修复，见 md-line-marker-newline.test.js）；限制保留，随机序列与空段计数因而不变。以换行开头的
// 文本不在数字边界上，修复不会把它与前文合并；切在换行处的两行记号另由两行记号的回归护栏覆盖
const EDGE_NEWLINE_TEXTS = [`甲${NL}`, `${NL}1) 项`, `${NL}1)`];
// 普通文本：汉字、中文标点、ASCII 字母、辅助平面表情、字面星号与波浪号，以及不接记号的数字；不含「w」「@」「:」
const ORDINARY_TEXTS = ['甲', '乙丙', '。', '，', '《乙》', 'ab', 'a b', EMOJI, '（注）', '*', '~', '3', '1.5 版', '第 2 项'];
const RANDOM_SEED = 20260925;
const RANDOM_COUNT = 2000;
// 每段段落直属位置数的上限
const MAX_ITEMS = 5;
// 段落直属各位置的取值概率：产物为空的节点、切分文本、硬换行、非空格式节点，余下为链接
const EMPTY_RATE = 0.2;
const TEXT_RATE = 0.45;
const BREAK_RATE = 0.12;
const FORMAT_RATE = 0.13;
// 段首取行首形态的概率（硬换行之后与以换行结尾的文本之后一律取行首形态）
const START_MARKER_RATE = 0.7;
// 切分点插入产物为空的节点的概率
const GAP_EMPTY_RATE = 0.3;
// 每段文本切分的段数上限
const MAX_PIECES = 4;
// 容器（格式节点与链接）的嵌套深度上限：深度达到该值的位置不再嵌套格式节点，空格式节点改为空 html
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
 * 空 html、只含一个无内容的格式节点四种（最后一种只在深度 0 出现）；深度达到上限时空格式节点一律改为空 html
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

/** 在随机码点处把文本切成 1–MAX_PIECES 段（段数不超过码点数），各段非空，不拆开代理对 */
function randomPieces(rand, value) {
    const chars = Array.from(value);
    const count = Math.min(chars.length, 1 + Math.floor(rand() * MAX_PIECES));
    const cuts = new Set();
    while (cuts.size < count - 1) cuts.add(1 + Math.floor(rand() * (chars.length - 1)));
    const pieces = [];
    let start = 0;
    for (const cut of [...[...cuts].sort((a, b) => a - b), chars.length]) {
        pieces.push(chars.slice(start, cut).join(''));
        start = cut;
    }
    return pieces;
}

/** 切分文本：各段依次为相邻的 text 节点，切分点按 GAP_EMPTY_RATE 的概率插入产物为空的节点 */
function randomSplitText(rand, value, depth) {
    const nodes = [];
    randomPieces(rand, value).forEach((piece, i) => {
        if (i > 0 && rand() < GAP_EMPTY_RATE) nodes.push(randomEmpty(rand, depth));
        nodes.push(text(piece));
    });
    return nodes;
}

/**
 * 段落直属切分文本的原文。last 为此前最后一个产物非空的位置：硬换行之后与以换行结尾的文本之后一律取行首形态，段首以
 * START_MARKER_RATE 的概率取行首形态；其余情形 45% 取行首形态、15% 取换行在中间的文本、10% 取以换行开头或结尾的
 * 文本（每段至多一个，已取过则改取普通文本），余下取普通文本
 */
function randomTopText(rand, last, ctx) {
    if (last === 'break' || last === 'newline' || (last === 'start' && rand() < START_MARKER_RATE)) return pick(rand, MARKER_TEXTS);
    const roll = rand();
    if (roll < 0.45) return pick(rand, MARKER_TEXTS);
    if (roll < 0.6) return pick(rand, INNER_NEWLINE_TEXTS);
    if (roll < 0.7 && !ctx.edgeUsed) {
        ctx.edgeUsed = true;
        return pick(rand, EDGE_NEWLINE_TEXTS);
    }
    return pick(rand, ORDINARY_TEXTS);
}

/** 容器内切分文本的原文：45% 取行首形态、25% 取换行在中间的文本，余下取普通文本；不取以换行开头或结尾的文本 */
function randomInnerText(rand) {
    const roll = rand();
    if (roll < 0.45) return pick(rand, MARKER_TEXTS);
    if (roll < 0.7) return pick(rand, INNER_NEWLINE_TEXTS);
    return pick(rand, ORDINARY_TEXTS);
}

/**
 * 容器的子节点（深度 depth）：1–3 个子项，每项按 25% 取产物为空的节点、按 20% 取嵌套的非空格式节点（深度未达上限时），
 * 其余取切分文本；全部子项都是空节点时末尾补一段切分文本，容器因而恒有可见文本
 */
function randomInnerChildren(rand, depth) {
    const count = 1 + Math.floor(rand() * 3);
    const nodes = [];
    let visible = false;
    for (let i = 0; i < count; i += 1) {
        const roll = rand();
        if (roll < 0.25) {
            nodes.push(randomEmpty(rand, depth));
        } else if (roll < 0.45 && depth < MAX_DEPTH) {
            nodes.push(randomFormat(rand, depth + 1));
            visible = true;
        } else {
            nodes.push(...randomSplitText(rand, randomInnerText(rand), depth));
            visible = true;
        }
    }
    if (!visible) nodes.push(...randomSplitText(rand, randomInnerText(rand), depth));
    return nodes;
}

/** 非空格式节点：六种之一，子节点位于深度 depth */
function randomFormat(rand, depth) {
    return format(pick(rand, FORMAT_TYPES))(...randomInnerChildren(rand, depth));
}

/**
 * 一个段落的子节点：1–MAX_ITEMS 个段落直属位置，按 EMPTY_RATE、TEXT_RATE、BREAK_RATE、FORMAT_RATE 依次取产物为空的
 * 节点、切分文本、硬换行与非空格式节点，余下为链接（子节点深度 1，链接之内不再嵌套链接）。硬换行只接在文本或容器之后，
 * 否则改取切分文本；以硬换行收尾时补一段行首形态的切分文本，段尾因而不留硬换行。可见文本以换行开头或结尾时在段首补
 * 「前」、段尾补「后」，避开解析器丢弃的段首段尾换行
 */
function randomParagraph(rand) {
    const ctx = { edgeUsed: false };
    const children = [];
    // 此前最后一个产物非空的位置：start（尚无）、text、newline（以换行结尾的文本）、break、container
    let last = 'start';
    const size = 1 + Math.floor(rand() * MAX_ITEMS);
    for (let i = 0; i < size; i += 1) {
        const roll = rand();
        if (roll < EMPTY_RATE) {
            children.push(randomEmpty(rand, 0));
        } else if (roll < EMPTY_RATE + TEXT_RATE + BREAK_RATE) {
            const breakable = last === 'text' || last === 'container';
            if (roll >= EMPTY_RATE + TEXT_RATE && breakable) {
                children.push(hardBreak());
                last = 'break';
            } else {
                const value = randomTopText(rand, last, ctx);
                children.push(...randomSplitText(rand, value, 0));
                last = value.endsWith(NL) ? 'newline' : 'text';
            }
        } else {
            const isFormat = roll < EMPTY_RATE + TEXT_RATE + BREAK_RATE + FORMAT_RATE;
            children.push(isFormat ? randomFormat(rand, 1) : link(...randomInnerChildren(rand, 1)));
            last = 'container';
        }
    }
    if (last === 'break') children.push(...randomSplitText(rand, pick(rand, MARKER_TEXTS), 0));
    const visible = plainText(children);
    if (visible.startsWith(NL)) children.unshift(text('前'));
    if (visible.endsWith(NL)) children.push(text('后'));
    return children;
}

/** count 个随机段落 */
function randomParagraphs(seed, count) {
    const rand = mulberry32(seed);
    const paragraphs = [];
    for (let k = 0; k < count; k += 1) paragraphs.push(randomParagraph(rand));
    return paragraphs;
}

// ============================================================
// 用例：已列形态
// ============================================================

test('已列形态：数字与其后的「.」「)」分属相邻 text 节点的 11 种形态（段首、段尾、数字之间切分、三段切分、段中换行后、硬换行之后、粗体内换行后、切分点夹空文本），对照形态往返正确；各例重新解析后不成列表，格式与文本均不变，产物与剔除空节点并合并相邻 text 后的同一 IR 逐字相同', async () => {
    // Arrange
    const shapes = listedShapes();
    assert.equal(shapes.length, 11);
    await assertControlsRoundTrip('已列形态', shapes.map((item) => item.control));

    // Act
    const result = await checkShapes(shapes);

    // Assert：失败信息列出全部 11 例
    assertShapes('已列形态', shapes, result, { limit: shapes.length });
});

// ============================================================
// 用例：矩阵
// ============================================================

test('矩阵：5 种数字 × 2 种记号 × 4 种切分方式共 34 种切分形态，× 17 种语境（段首、前一文本以换行结尾、硬换行之后、六种格式节点与链接内部的换行之后、段首切分点插入 7 种空节点），对照形态往返正确；各例重新解析后格式、链接与文本均不变，产物与剔除空节点并合并相邻 text 后的同一 IR 逐字相同', async () => {
    // Arrange
    const shapes = splitShapes();
    const cases = buildMatrix();
    assert.equal(shapes.length, 34);
    assert.equal(cases.length, shapes.length * (CONTEXTS.length + SPLIT_EMPTY_NODES.length));
    assert.equal(cases.length, 578);
    await assertControlsRoundTrip('矩阵', cases.map((item) => item.control));

    // Act
    const result = await checkShapes(cases);

    // Assert：失败信息按语境、切分方式、数字、记号与空节点种类分别计数，每种语境列出首例
    const byContext = (item) => item.context;
    assertShapes('矩阵', cases, result, {
        breakdowns: [
            ['按语境', byContext], ['按切分方式', (item) => item.split], ['按数字', (item) => item.digits],
            ['按记号', (item) => item.marker], ['按空节点', (item) => item.empty],
        ],
        sampleBy: byContext,
    });
});

// ============================================================
// 用例：回归护栏（修复前后均应通过）
// ============================================================

test('回归护栏：数字与记号同在一个 text 节点（不含切分）的形态（段首、段尾、段中换行后、硬换行之后、粗体内、非行首、记号后不接空白、10 位数字、标题内）产物逐字不变', async () => {
    // Arrange：期望值取自现行代码（d332ef0）的实际产物
    const cases = [
        { block: createParagraph([text('1. 项')]), md: `1${BACKSLASH}. 项${NL}` },
        { block: createParagraph([text('1) 项')]), md: `1${BACKSLASH}) 项${NL}` },
        { block: createParagraph([text('0) 项')]), md: `0${BACKSLASH}) 项${NL}` },
        { block: createParagraph([text('12. 项')]), md: `12${BACKSLASH}. 项${NL}` },
        { block: createParagraph([text('123456789. 项')]), md: `123456789${BACKSLASH}. 项${NL}` },
        { block: createParagraph([text('1234567890. 项')]), md: `1234567890${BACKSLASH}. 项${NL}` },
        { block: createParagraph([text('1.')]), md: `1${BACKSLASH}.${NL}` },
        { block: createParagraph([text('1)')]), md: `1${BACKSLASH})${NL}` },
        { block: createParagraph([text('1.项')]), md: `1.项${NL}` },
        { block: createParagraph([text('1)项')]), md: `1${BACKSLASH})项${NL}` },
        { block: createParagraph([text('甲 1. 项')]), md: `甲 1. 项${NL}` },
        { block: createParagraph([text('1.5 版')]), md: `1.5 版${NL}` },
        { block: createParagraph([text(`甲${NL}1. 项`)]), md: `甲${NL}1${BACKSLASH}. 项${NL}` },
        { block: createParagraph([text(`甲${NL}2) 项`)]), md: `甲${NL}2${BACKSLASH}) 项${NL}` },
        { block: createParagraph([text('甲'), hardBreak(), text('1. 项')]), md: `甲${BACKSLASH}${NL}1${BACKSLASH}. 项${NL}` },
        { block: createParagraph([strong(text(`甲${NL}1. 项`))]), md: `**甲${NL}1${BACKSLASH}. 项**${NL}` },
        { block: createHeading(2, [text('1. 项')]), md: `## 1. 项${NL}` },
    ];
    assert.equal(cases.length, 17);

    for (const { block, md: expected } of cases) {
        // Act
        const md = await renderBlock(block);

        // Assert
        assert.equal(md, expected, describeBlock(block));
    }
});

test('回归护栏：修复前不出错的切分形态（记号之后切分、10 位数字、标题内的切分）与子节点拼接后等于地址的链接，重新解析后格式、链接与文本均不变（只断言往返，不约束写法）', async () => {
    // Arrange：d332ef0 的产物依次为「1\. 项」「1234567890. 项」「## 1. 项」「[https://a.com](https://a.com)」。在数字
    // 边界合并之后，第二例写作「1234567890\. 项」，其余三例不变；重新解析的结果均不变，故只断言往返
    const blocks = [
        createParagraph([text('1.'), text(' 项')]),
        createParagraph([text('1234567890'), text('. 项')]),
        createHeading(2, [text('1'), text('. 项')]),
        createParagraph([link(text('https://a'), text('.com'))]),
    ];

    // Act & Assert
    await assertAllRoundTrip('修复前不出错的切分形态', blocks);
});

test('回归护栏：两行记号形态（第一行只有记号 8 种 × 第二行以记号开头 7 种 × 切在换行之前、切在换行之后、换行单独成节点 3 种切分 × 段首、前文以换行结尾、硬换行之后、strong 内换行之后 4 种语境）共 672 例，重新解析后只有一个段落，格式、硬换行与文本均不变（只断言往返）', async () => {
    // Arrange：修复前两个节点各自转义，全部往返正确；两行一旦并入同一 value，「.」「-」「+」模式的 after 吞掉行尾换行，
    // 第二行的记号不再转义。切分点在换行处，不在数字边界上，合并不应越过
    const cases = twoLineCases();
    const total = TWO_LINE_FIRSTS.length * TWO_LINE_SECONDS.length * TWO_LINE_SPLITS.length * TWO_LINE_CONTEXTS.length;
    assert.equal(cases.length, total);
    assert.equal(cases.length, 672);

    // Act
    const failures = [];
    for (const item of cases) {
        const { failure } = await renderAndReparse(item.block);
        if (failure) failures.push({ ...failure, item });
    }

    // Assert：失败信息按切分方式、第一行与语境分别计数，并列出前若干例
    const failedItems = new Set(failures.map((f) => f.item));
    const lines = reportLines(failures);
    assert.equal(failures.length, 0, [
        `两行记号形态：${cases.length} 例中往返失败 ${failures.length} 例`,
        `按切分方式：${countFailures(cases, failedItems, (item) => item.split).join('、')}`,
        `按第一行：${countFailures(cases, failedItems, (item) => item.first).join('、')}`,
        `按语境：${countFailures(cases, failedItems, (item) => item.context).join('、')}`,
        `往返失败（前 ${lines.length} 例）：`, ...lines,
    ].join(NL));
});

// ============================================================
// 用例：种子随机往返
// ============================================================

test(`种子随机往返：种子 ${RANDOM_SEED} 生成 ${RANDOM_COUNT} 个段落（文本池以行首「数字 + 记号」形态为主，每段文本在随机码点处切成 1–${MAX_PIECES} 个相邻 text，穿插空节点、硬换行、非空格式节点与链接，容器嵌套深度 ≤ ${MAX_DEPTH}），只由空节点构成的段落产物为空串，其余重新解析后格式、链接、硬换行与文本均不变`, async () => {
    // Arrange：只由空节点构成的段落渲染为空串，不产生段落节点；其数目随生成器固定
    const cases = randomParagraphs(RANDOM_SEED, RANDOM_COUNT);
    const blank = cases.filter((children) => children.every(isEmptyOutput));
    assert.equal(cases.length, RANDOM_COUNT);
    assert.equal(blank.length, 103);

    // Act：只由空节点构成的段落核对产物为空串，其余段落核对往返
    const nonBlank = [];
    const roundTrip = [];
    for (const children of cases) {
        const md = await renderParagraph(children);
        if (children.every(isEmptyOutput)) {
            if (md !== '') nonBlank.push(`${describeIr(children)} → ${JSON.stringify(md)}`);
            continue;
        }
        const failure = await roundTripFailureOf(createParagraph(children), md);
        if (failure) roundTrip.push(failure);
    }

    // Assert：两项一并断言，失败信息分别计数
    const blankLines = nonBlank.slice(0, MAX_REPORTED).map((line, i) => `${i + 1}. ${line}`);
    const rtLines = reportLines(roundTrip);
    assert.equal(nonBlank.length + roundTrip.length, 0, [
        `种子随机往返：只由空节点构成的 ${blank.length} 段中产物非空 ${nonBlank.length} 段；其余 ${cases.length - blank.length} 段中`
            + `往返失败 ${roundTrip.length} 段`,
        `产物非空（前 ${blankLines.length} 段）：`, ...blankLines,
        `往返失败（前 ${rtLines.length} 段）：`, ...rtLines,
    ].join(NL));
});
