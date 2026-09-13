/**
 * 权利要求书：权项拆分与 claim-ref 解析（patent profile）
 *
 * CLAIM_START_RE            权项起始：^\s*(\d+)\s*[.、．]（官方正则为 ^[[1-9][0-9]*[0-9]*[\.．、]）
 * isClaimStart(text)        文本是否以权项编号开头
 * buildClaims(blocks, { issues }) → { preface: block[], claims: [{ num, id, parts: [{ runs, block }] }] }
 *   以编号段开新权项，不带编号的后续段归入当前权项作为后续 claim-text；首个编号段之前的段落为 preface
 *   （DTD 允许 cn-claims 在 claim+ 之前有 p*）。项号不连续或重复记「权项：」问题项；id 为 cl + 三位，
 *   取自项号本身（重复时改用序号）。
 * resolveClaimRefs(runs, { claimNum, idByNum, issues, el }) → runs
 *   把「权利要求 N」「权利要求 2-3」「权利要求 1或2」中的编号表达式包成 <claim-ref idref="cl001 cl002">，
 *   范围（-、~、～、至）展开为连续项号，「或」「、」为并列；起点大于终点或引用不存在的权项时不生成
 *   claim-ref、保留原文并记问题项——claim-ref/@idref 为 IDREFS，悬空引用会导致 DTD 校验失败。
 */
const { stripPrefix, splitText } = require('./inline');
const { ISSUE_CODES, createIssue } = require('./precheck');
const { padNumber } = require('./numbering');

const CLAIM_START_RE = /^\s*(\d+)\s*[.、．]\s*/;
// 只匹配「权利要求」之后的编号表达式，元素内容即该表达式，「权利要求」四字留在正文
const CLAIM_REF_RE = /(?<=权利要求\s*)\d+(?:\s*[-~～至或、]\s*\d+)*/g;
const REF_TOKEN_RE = /\s*([-~～至或、])\s*/;
const RANGE_CONNECTORS = new Set(['-', '~', '～', '至']);
const CLAIM_ID_PREFIX = 'cl';
const CLAIM_ID_WIDTH = 3;
const REASON_RANGE = '起点大于终点';
const REASON_MISSING = '引用不存在的权项';

const isClaimStart = (text) => CLAIM_START_RE.test(String(text == null ? '' : text));

function buildClaims(blocks, { issues = [] } = {}) {
    const preface = [];
    const claims = [];
    for (const block of blocks) {
        if (block.kind === 'paragraph') {
            const { match, runs } = stripPrefix(block.runs, CLAIM_START_RE);
            if (match) { claims.push({ num: Number(match[1]), parts: [{ runs, block }] }); continue; }
            if (claims.length === 0) { preface.push(block); continue; }
            claims[claims.length - 1].parts.push({ runs: block.runs, block });
            continue;
        }
        // 图片、表格、公式块：归入当前权项；尚无权项时归入前言
        if (claims.length === 0) preface.push(block);
        else claims[claims.length - 1].parts.push({ runs: null, block });
    }
    checkSequence(claims, issues);
    return { preface, claims: assignIds(claims) };
}

function checkSequence(claims, issues) {
    if (claims.length === 0) return;
    const nums = claims.map((claim) => claim.num);
    const isSequential = nums.every((num, index) => num === index + 1);
    if (!isSequential) {
        issues.push(createIssue(ISSUE_CODES.CLAIM_NUMBER_GAP, `权利要求项号不连续或重复：实际为 ${nums.join('、')}，应为 1–${nums.length} 连续编号`));
    }
}

function assignIds(claims) {
    const used = new Set();
    return claims.map((claim, index) => {
        let id = `${CLAIM_ID_PREFIX}${padNumber(claim.num, CLAIM_ID_WIDTH)}`;
        if (used.has(id)) id = `${CLAIM_ID_PREFIX}${padNumber(index + 1, CLAIM_ID_WIDTH)}`;
        while (used.has(id)) id = `${id}x`;
        used.add(id);
        return { ...claim, id };
    });
}

function resolveClaimRefs(runs, { claimNum, idByNum, issues = [], el }) {
    return splitText(runs, CLAIM_REF_RE, (match) => {
        const expr = match[0];
        const { nums, error } = parseRefExpression(expr);
        const missing = nums.find((num) => !idByNum.has(num));
        const reason = error || (missing !== undefined ? REASON_MISSING : null);
        if (reason) {
            issues.push(createIssue(ISSUE_CODES.CLAIM_REF_INVALID,
                `权利要求 ${claimNum} 的引用“${expr}”无法解析（${reason}），已保留原文、未生成 claim-ref`,
                { location: `权利要求 ${claimNum}` }));
            return null;
        }
        return el('claim-ref', { idref: nums.map((num) => idByNum.get(num)).join(' ') }, [expr]);
    });
}

/** 「1」「2-3」「1或2」「1、2至4」→ 项号列表（去重、升序）；起点大于终点时给出 error */
function parseRefExpression(expr) {
    const tokens = String(expr).trim().split(REF_TOKEN_RE);
    const nums = new Set();
    let error = null;
    let previous = null;
    let connector = null;
    for (const token of tokens) {
        if (token === '' ) continue;
        if (RANGE_CONNECTORS.has(token) || token === '或' || token === '、') { connector = token; continue; }
        const value = Number(token);
        if (!Number.isInteger(value)) continue;
        if (connector && RANGE_CONNECTORS.has(connector) && previous !== null) {
            if (previous > value) error = REASON_RANGE;
            else for (let i = previous; i <= value; i += 1) nums.add(i);
        } else {
            nums.add(value);
        }
        previous = value;
        connector = null;
    }
    return { nums: [...nums].sort((a, b) => a - b), error };
}

module.exports = { CLAIM_START_RE, CLAIM_REF_RE, isClaimStart, buildClaims, resolveClaimRefs, parseRefExpression };
