/**
 * 说明书段号与各类元素 id 的计数器（patent profile）
 *
 * createIdFactory()                       → { next(prefix, width = 4) → { index, id } }，每个前缀独立计数
 *                                           （h0001 / l0001 / f0001 / i0001 / tabl0001 / math0001 / chem0001）
 * createParagraphNumbering({ start, width, issues })
 *                                         → { next(explicit?) → { id: 'p0003', num: '0003', index } }
 *   说明书段落顺序编号，四位（width）补零；段首已有 [0003]／［0003］ 的段落把该号传入 explicit：
 *   与预期一致则直接复用；大于预期（向前跳变）记「段号跳变」问题项并从该号续编（以原稿为准）；
 *   小于预期（向后跳变）同样记问题项但按预期续编——复用会与已编段号重复，id 重复即 DTD 校验失败。
 * createTempNumbering(ids)                → { next() → { id: 'l0001', num: 'XXXX' } }
 *   官方「临标记」段：不计段号的段落，id 为 l + 四位序号，num 为字面量 XXXX。
 * stripParagraphNumber(runs)              → { number: number | null, runs }
 *   剥离段首的 [0001]／［0001］ 前缀（含其后空白）。
 */
const { stripPrefix } = require('./inline');
const { ISSUE_CODES, createIssue } = require('./precheck');

const PARA_NUMBER_RE = /^\s*[\[［]\s*(\d{1,6})\s*[\]］]\s*/;
const TEMP_NUM = 'XXXX';
const TEMP_PREFIX = 'l';
const DEFAULT_WIDTH = 4;

const padNumber = (value, width) => String(value).padStart(width, '0');

function createIdFactory() {
    const counters = new Map();
    return {
        next(prefix, width = DEFAULT_WIDTH) {
            const index = (counters.get(prefix) || 0) + 1;
            counters.set(prefix, index);
            return { index, id: `${prefix}${padNumber(index, width)}` };
        },
    };
}

function createParagraphNumbering({ start = 1, width = DEFAULT_WIDTH, issues = [] } = {}) {
    let expected = Number.isInteger(start) && start > 0 ? start : 1;
    let index = 0;
    return {
        next(explicit = null) {
            index += 1;
            let value = expected;
            if (Number.isInteger(explicit) && explicit > 0 && explicit !== expected) {
                // 向前跳变：复用原稿段号并从其续编；向后跳变会与已编段号（即 id）重复，只能按预期续编
                const reusable = explicit > expected;
                issues.push(createIssue(ISSUE_CODES.NUMBERING_JUMP,
                    `第 ${index} 段标为 [${padNumber(explicit, width)}]，预期 [${padNumber(expected, width)}]，`
                    + (reusable ? '已按原稿段号续编' : '原稿段号与已编段号冲突，已按预期续编'),
                    { location: `第 ${index} 段` }));
                if (reusable) value = explicit;
            }
            expected = value + 1;
            return { id: `p${padNumber(value, width)}`, num: padNumber(value, width), index };
        },
    };
}

function createTempNumbering(ids) {
    return { next: () => ({ id: ids.next(TEMP_PREFIX).id, num: TEMP_NUM }) };
}

function stripParagraphNumber(runs) {
    const { match, runs: rest } = stripPrefix(runs, PARA_NUMBER_RE);
    return { number: match ? Number(match[1]) : null, runs: match ? rest : runs };
}

module.exports = {
    createIdFactory, createParagraphNumbering, createTempNumbering, stripParagraphNumber, padNumber, PARA_NUMBER_RE, TEMP_NUM,
};
