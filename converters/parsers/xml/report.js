/**
 * 五书反向导入的问题清单（独立于 renderers/xml/precheck 的 ISSUE_CODES：那张表描述「不合规」，这里描述「导入时丢了什么」）
 *
 * createReport() → report
 *   report.loss(key, detail?)   记一处「回转 XML 时无法恢复」的信息；key 取自 LOSS_KINDS，同一 key 只汇总成一条并计数；
 *                               detail（元素名等短文本）按出现次数聚合后附在该条之后
 *   report.warn(message)        记一条独立提示（缺图、越界引用、重复书目等），自动冠以稳定前缀「导入：」，重复文案只留一条
 *   report.note(message)        同 warn，但排在清单最前（导入概要）
 *   report.toWarnings()         → string[]：概要 → 独立提示（按记录顺序）→ 丢失项（按 LOSS_KINDS 的声明顺序）
 * 所有条目一律以 IMPORT_PREFIX 开头，调用方（CLI、MCP、桌面端）据此与渲染阶段的告警区分；
 * 条目总数以 MAX_WARNINGS 封顶，超出部分折成一条「另有 N 条」——输入属不可信内容，不能让它把结果信封撑爆。
 */
const IMPORT_PREFIX = '导入：';
const MAX_WARNINGS = 200;
const MAX_DETAIL_KINDS = 8;
const MAX_DETAIL_CHARS = 40;

// 已知必丢项：key → 文案。声明顺序即输出顺序；README「XML 反向导入」一节与 test/xml-import-roundtrip 的清单以此为准
const LOSS_KINDS = Object.freeze({
    references: 'claim-ref / figref / crossref 等引用元素已按纯文本导入：官方转换器不生成这些元素，回转 XML 时不会恢复',
    pageBreak: 'pb 分页标记未导入，回转 XML 时不会恢复',
    tempParagraph: '说明书或摘要内的临时段（num="XXXX"）按普通段落导入，回转时会编入顺序段号',
    paragraphNumber: '段号不是自 1 起的连续编号，回转时会按顺序重新编号（需保留原段号时用 xmlImport.paragraphNumbers）',
    headingLevel: 'heading 的 level 不是 2，回转后一律写作 level="2"',
    titleMarkup: 'invention-title 内的行内标记与图片未导入，回转后只保留纯文本',
    nestedClaimText: 'claim-text 的嵌套已拍平为并列的 claim-text',
    claimType: 'claim 的 claim-type 属性未导入',
    claimContinuation: '权项内的后续 claim-text 以「数字＋. 、」开头，回转时会被识别为新的权项，请在 Word 中核对',
    codedObject: 'maths / tables / chemistry 的代码化内容（math、table、chem、cn-mathf、cn-tablef）未导入，仅保留其图片或文字',
    inlineStyle: 'smallcaps / overscore 与 u 的 style 属性未导入，仅保留文字与普通下划线',
    imageAttributes: 'img 的 top / left / img-content 取值未导入，回转时按官方转换器的固定取值（0、0、drawing）重写',
    figureAttributes: '摘要附图的 figure-labels 与非图号的附图说明文字，回转时不会写回 XML',
    unmapped: '未映射的元素仅保留其文字',
});

function createReport() {
    const notes = [];
    const messages = [];
    const seen = new Set();
    const losses = new Map();

    const push = (list, message) => {
        const text = `${IMPORT_PREFIX}${String(message == null ? '' : message).trim()}`;
        if (seen.has(text)) return;
        seen.add(text);
        list.push(text);
    };

    return {
        note: (message) => push(notes, message),
        warn: (message) => push(messages, message),
        loss(key, detail) {
            if (!Object.hasOwn(LOSS_KINDS, key)) throw new Error(`未登记的导入丢失项：${key}`);
            const entry = losses.get(key) || { count: 0, details: new Map() };
            entry.count += 1;
            const label = clip(detail);
            if (label) entry.details.set(label, (entry.details.get(label) || 0) + 1);
            losses.set(key, entry);
        },
        toWarnings() {
            const lossLines = Object.keys(LOSS_KINDS).filter((key) => losses.has(key))
                .map((key) => `${IMPORT_PREFIX}${LOSS_KINDS[key]}（${losses.get(key).count} 处${describeDetails(losses.get(key).details)}）`);
            return capWarnings([...notes, ...messages, ...lossLines]);
        },
    };
}

const clip = (detail) => {
    const text = String(detail == null ? '' : detail).replace(/\s+/g, ' ').trim();
    return Array.from(text).slice(0, MAX_DETAIL_CHARS).join('');
};

// 「：<dl>×2、<patcit>」——按出现次数降序，至多列 MAX_DETAIL_KINDS 种
function describeDetails(details) {
    if (details.size === 0) return '';
    const sorted = [...details.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const shown = sorted.slice(0, MAX_DETAIL_KINDS).map(([label, count]) => (count > 1 ? `${label}×${count}` : label));
    return `：${shown.join('、')}${sorted.length > MAX_DETAIL_KINDS ? ' 等' : ''}`;
}

function capWarnings(lines) {
    if (lines.length <= MAX_WARNINGS) return lines;
    return [...lines.slice(0, MAX_WARNINGS - 1), `${IMPORT_PREFIX}另有 ${lines.length - MAX_WARNINGS + 1} 条提示未列出`];
}

module.exports = { createReport, IMPORT_PREFIX, LOSS_KINDS, MAX_WARNINGS };
