/**
 * 权利要求书：权项拆分（patent profile）
 *
 * CLAIM_START_RE            权项起始：^\s*(\d+)\s*[.、．]（官方正则为 ^[[1-9][0-9]*[0-9]*[\.．、]）
 * isClaimStart(text)        文本是否以权项编号开头
 * buildClaims(blocks, { issues }) → { preface: block[], claims: [{ num, id, parts: [{ runs, block }] }] }
 *   以编号段开新权项，不带编号的后续段归入当前权项作为后续 claim-text；首个编号段之前的段落为 preface
 *   （DTD 允许 cn-claims 在 claim+ 之前有 p*）。项号不连续或重复记「权项：」问题项；id 为 cl + 三位，
 *   取自项号本身（重复时改用序号）。
 * 官方产出不生成 claim-ref：「根据权利要求1所述的…」整句保留为 claim-text 的纯文本，本模块据此
 * 不再解析权项引用表达式。
 */
const { stripPrefix } = require('./inline');
const { ISSUE_CODES, createIssue } = require('./precheck');
const { padNumber } = require('./numbering');

const CLAIM_START_RE = /^\s*(\d+)\s*[.、．]\s*/;
const CLAIM_ID_PREFIX = 'cl';
const CLAIM_ID_WIDTH = 3;

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

module.exports = { CLAIM_START_RE, isClaimStart, buildClaims };
