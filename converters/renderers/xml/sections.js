/**
 * 五书分节（patent profile）：把扁平块序列归入权利要求书 / 说明书 / 说明书附图 / 说明书摘要 / 摘要附图
 *
 * detectSections(blocks, { sectionDetection, meta }) →
 *   { books: { claims, description, drawings, abstract, abstractFigure }（各为块数组，说明书块带 role），
 *     inventionTitle: { text, source } | null, issues: Issue[], assignments: Map<顶层节点, { book, role }> }
 *
 * 规则（方案 §3.4.2、研究报告 §5.2、交接简报 §4）：
 *   1. 官方显式标记先剥离：私用区标记码位（U+E200–U+E20F）一律删除；「名…名」→ 发明名称，「题…题」→ 标题，
 *      「段号[0001]号…」→ 保留 [0001] 交段号模块复用，「条号1.号…」→ 保留 1. 交权项模块，「号图1号」→ 图1。
 *   2. 候选标题 = heading 节点，或（sectionDetection 为 auto 时）整段加粗 / 纯文本 ≤ 12 字的段落；
 *      候选标题命中四书正则（允许字间空白）即为分节标题：权利要求书 / 说明书 / 说明书附图|附图 /
 *      说明书摘要|摘要 / 摘要附图；sectionDetection 为 headings 时只认 heading 节点。
 *   3. 无标题的前导区域按位置推定：权利要求块 = 自首个「N、」「N.」编号段起、至首个五部分标题（或文末附图块）
 *      之前，且必须位于说明书之前；权利要求块之前 ≤ 3 段、无编号、无图表的前导正文推定为摘要，否则并入
 *      说明书（warning）；文末仅由图片段与纯图号段组成的尾部 → 说明书附图；无「摘要附图」标题时摘要内的图片段
 *      → 摘要附图。全部位置推定的书目合并为一条 SECTION_INFERRED 提示并列出段落区间（heading 命中的不列）。
 *   4. 说明书内：五部分标题（技术领域 / 背景技术 / 发明内容|实用新型内容 / 附图说明 / 具体实施方式|实施例）
 *      不论 heading 深度或普通段一律 role 'heading'（输出 level="2"）；heading 节点同样为 heading。
 *   5. 发明名称回退链：「发明名称：X」字段 → 说明书首个标题段 → 文首文档标题 → 权利要求 1 主题（warning）
 *      → doc.meta.title（warning，须不是四书或五部分标题文本）→ 缺失（warning，不输出 invention-title）。
 */
const { runsText, trimRuns, stripPrefix, textRun } = require('./inline');
const { ISSUE_CODES, createIssue } = require('./precheck');
const { CLAIM_START_RE } = require('./claims');
const { isPureLabel } = require('./figures');

const BOOK_RULES = Object.freeze([
    ['abstractFigure', /^摘\s*要\s*附\s*图$/],
    ['drawings', /^(?:说\s*明\s*书\s*)?附\s*图$/],
    ['abstract', /^(?:说\s*明\s*书\s*)?摘\s*要$/],
    ['claims', /^权\s*利\s*要\s*求\s*书$/],
    ['description', /^说\s*明\s*书$/],
]);
const BOOK_KEYS = Object.freeze(['claims', 'description', 'drawings', 'abstract', 'abstractFigure']);
const BOOK_LABELS = Object.freeze({ claims: '权利要求书', description: '说明书', drawings: '说明书附图', abstract: '说明书摘要', abstractFigure: '摘要附图' });
const PART_HEADING_RE = /^(技术领域|背景技术|发明内容|实用新型内容|附图说明|具体实施方式|具体实施例|实施例)$/;
const TITLE_FIELD_RE = /^\s*(?:发明创造|发明|实用新型)名称\s*[:：]?\s*(.+?)\s*$/;
const CLAIM_SUBJECT_RE = /^\s*\d+\s*[、.．]\s*(一种[^，,：:；;]{2,40}?)(?=[，,：:；;]|其特征)/;
const TERMINAL_PUNCT_RE = /[，。；：,.;:！？!?]/;
const SUBJECT_PREFIX_RE = /^一种/;
// 标题归一：去全部空白、外层括号、尾部冒号与「一、」「1.」一类序号
const BRACKET_RE = /^[(（\[［【〖〔《{｛]+|[)）\]］】〗〕》}｝]+$/g;
const ENUM_PREFIX_RE = /^(?:[一二三四五六七八九十]+|\d+)\s*[、.．]\s*/;
const TRAILING_COLON_RE = /[:：]$/;
const OFFICIAL_PUA_RE = /[-]/g;
const MARK_TITLE_RE = /^名(.+)名$/;
const MARK_HEADING_RE = /^题(.+)题$/;
const MARK_PARA_RE = /^段号(?=[\[［]\d+[\]］])/;
const MARK_PARA_TAIL_RE = /^([\[［]\d+[\]］])号/;
const MARK_CLAIM_RE = /^条号(?=\d+[.．、])/;
const MARK_CLAIM_TAIL_RE = /^(\d+[.．、])号/;
const MARK_FIGURE_RE = /^号(图\s*\d+)号$/;
const MAX_TITLE_CANDIDATE = 12;
const MAX_INVENTION_TITLE = 40;
const MAX_ABSTRACT_PREAMBLE = 3;

function detectSections(blocks, { sectionDetection = 'auto', meta = {} } = {}) {
    const issues = [];
    const assignments = new Map();
    // index 为块在全文块序列中的 1 起序号，供「按位置推定」的段落区间提示使用
    const normalized = blocks.map((block, position) => ({ ...normalizeOfficialMarks(block), index: position + 1 }));
    const titleField = extractTitleField(normalized);
    const remaining = titleField ? normalized.filter((block) => block !== titleField.block) : normalized;
    if (titleField) assignments.set(titleField.block.origin, { book: 'description', role: 'invention-title' });

    const books = emptyBooks();
    const regions = splitRegions(remaining, sectionDetection, assignments);
    const titles = [];
    const inferred = [];
    const explicit = new Set(regions.filter((region) => region.book).map((region) => region.book));
    regions.forEach((region, index) => {
        if (!region.book) {
            const last = index === regions.length - 1;
            inferPreamble(region.blocks, { books, issues, titles, explicit, last, sectionDetection, inferred });
            return;
        }
        books[region.book].push(...region.blocks);
    });
    moveAbstractImages(books, inferred);
    reportInferred(inferred, normalized.length, issues);
    for (const key of BOOK_KEYS) books[key] = finalizeBook(key, books[key], { titles, sectionDetection });

    const inventionTitle = resolveInventionTitle({ titleField, titles, claims: books.claims, meta, issues });
    for (const key of BOOK_KEYS) for (const block of books[key]) assignments.set(block.origin, { book: key, role: block.role || 'paragraph' });
    return { books, inventionTitle, issues, assignments };
}

const emptyBooks = () => Object.fromEntries(BOOK_KEYS.map((key) => [key, []]));

// 无「摘要附图」标题时，摘要区域内的图片段推定为摘要附图
function moveAbstractImages(books, inferred) {
    if (books.abstractFigure.length > 0) return;
    const images = books.abstract.filter((block) => block.kind === 'image');
    if (images.length === 0) return;
    books.abstract = books.abstract.filter((block) => block.kind !== 'image');
    books.abstractFigure.push(...images);
    inferred.push({ key: 'abstractFigure', blocks: images });
}

// 全部位置推定的书目合并为一条提示，按首块位置排序，附段落区间
function reportInferred(inferred, total, issues) {
    const entries = inferred.filter((entry) => entry.blocks.length > 0)
        .sort((a, b) => firstIndex(a.blocks) - firstIndex(b.blocks));
    if (entries.length === 0) return;
    const summary = entries.map((entry) => `${BOOK_LABELS[entry.key]}=${rangeOf(entry.blocks, total)}`).join('；');
    issues.push(createIssue(ISSUE_CODES.SECTION_INFERRED, `未发现书目标题，按位置推定：${summary}`));
}

const firstIndex = (blocks) => Math.min(...blocks.map((block) => block.index));

function rangeOf(blocks, total) {
    const indexes = blocks.map((block) => block.index);
    const start = Math.min(...indexes);
    const end = Math.max(...indexes);
    if (start === end) return `第 ${start} 段`;
    return end >= total ? `第 ${start} 段起` : `第 ${start}–${end} 段`;
}

// ============================================================
// 官方标记
// ============================================================

function normalizeOfficialMarks(block) {
    if (block.kind !== 'paragraph' && block.kind !== 'heading') return block;
    let runs = trimRuns(block.runs.map((run) => (run.kind === 'text' ? textRun(run.text.replace(OFFICIAL_PUA_RE, ''), run.marks) : run)));
    let hint = null;
    const text = runsText(runs).trim();
    if (MARK_TITLE_RE.test(text)) { runs = stripEdges(runs, /^名/, /名$/); hint = 'invention-title'; }
    else if (MARK_HEADING_RE.test(text)) { runs = stripEdges(runs, /^题/, /题$/); hint = 'heading'; }
    else if (MARK_FIGURE_RE.test(text)) { runs = stripEdges(runs, /^号/, /号$/); }
    else if (MARK_PARA_RE.test(text)) { runs = stripMarkedNumber(runs, MARK_PARA_RE, MARK_PARA_TAIL_RE); }
    else if (MARK_CLAIM_RE.test(text)) { runs = stripMarkedNumber(runs, MARK_CLAIM_RE, MARK_CLAIM_TAIL_RE); }
    return { ...block, runs, text: runsText(runs).trim(), hint };
}

function stripEdges(runs, headRe, tailRe) {
    const { runs: withoutHead } = stripPrefix(runs, headRe);
    const out = [...withoutHead];
    for (let i = out.length - 1; i >= 0; i -= 1) {
        if (out[i].kind !== 'text') continue;
        out[i] = textRun(out[i].text.replace(tailRe, ''), out[i].marks);
        break;
    }
    return trimRuns(out);
}

// 「段号[0001]号正文」→「[0001]正文」；「条号1.号正文」→「1.正文」
function stripMarkedNumber(runs, headRe, tailRe) {
    const { runs: withoutHead } = stripPrefix(runs, headRe);
    const match = tailRe.exec(runsText(withoutHead));
    if (!match) return withoutHead;
    const { runs: rest } = stripPrefix(withoutHead, tailRe);
    return trimRuns([textRun(match[1], []), ...rest]);
}

// ============================================================
// 标题判定与分区
// ============================================================

function normalizeTitle(text) {
    return String(text || '').replace(/\s+/g, '').replace(BRACKET_RE, '').replace(TRAILING_COLON_RE, '').replace(ENUM_PREFIX_RE, '');
}

function isTitleCandidate(block, sectionDetection) {
    if (block.kind === 'heading') return true;
    if (block.kind !== 'paragraph' || sectionDetection === 'headings') return false;
    return block.isBold || block.text.length <= MAX_TITLE_CANDIDATE;
}

function bookOf(block, sectionDetection) {
    if (!isTitleCandidate(block, sectionDetection)) return null;
    const title = normalizeTitle(block.text);
    const hit = BOOK_RULES.find(([, re]) => re.test(title));
    return hit ? hit[0] : null;
}

const isPartHeading = (block, sectionDetection) => block.hint === 'heading'
    || (isTitleCandidate(block, sectionDetection) && PART_HEADING_RE.test(normalizeTitle(block.text)));

// 标题样段：heading 节点，或无终结标点、不带编号的短段——加粗，或以「一种」起头的普通段
function isTitleLike(block) {
    if (block.hint === 'invention-title') return true;
    if (block.kind === 'heading') return block.text.length > 0 && block.text.length <= MAX_INVENTION_TITLE;
    if (block.kind !== 'paragraph' || !block.text || block.text.length > MAX_INVENTION_TITLE) return false;
    return !TERMINAL_PUNCT_RE.test(block.text) && !CLAIM_START_RE.test(block.text) && (block.isBold || SUBJECT_PREFIX_RE.test(block.text));
}

function splitRegions(blocks, sectionDetection, assignments) {
    const regions = [{ book: null, blocks: [] }];
    for (const block of blocks) {
        const book = bookOf(block, sectionDetection);
        if (book) {
            assignments.set(block.origin, { book, role: 'title' });
            regions.push({ book, blocks: [] });
            continue;
        }
        regions[regions.length - 1].blocks.push(block);
    }
    return regions.filter((region) => region.book || region.blocks.length > 0);
}

function extractTitleField(blocks) {
    for (const block of blocks) {
        if (block.kind !== 'paragraph' && block.kind !== 'heading') continue;
        const match = TITLE_FIELD_RE.exec(block.text);
        if (match) return { block, text: match[1] };
    }
    return null;
}

// ============================================================
// 无标题区域的位置推定
// ============================================================

function inferPreamble(blocks, { books, issues, titles, explicit, last, sectionDetection, inferred }) {
    let list = [...blocks];
    if (list.length > 0 && isTitleLike(list[0]) && !isPartHeading(list[0], sectionDetection) && list[0].kind === 'heading') {
        titles.push({ text: list[0].text, source: 'document-title', block: list[0] });
        list = list.slice(1);
    }
    const drawingsStart = last && !explicit.has('drawings') ? trailingDrawingsStart(list) : list.length;
    const partIndex = list.findIndex((block, index) => index < drawingsStart && isPartHeading(block, sectionDetection));
    const bodyEnd = partIndex >= 0 ? partIndex : drawingsStart;
    const claimsStart = explicit.has('claims') ? -1
        : list.findIndex((block, index) => index < bodyEnd && block.kind === 'paragraph' && CLAIM_START_RE.test(block.text));

    let claimsEnd = bodyEnd;
    if (claimsStart >= 0 && partIndex > claimsStart + 1 && isTitleLike(list[partIndex - 1])) claimsEnd = partIndex - 1;
    const leading = list.slice(0, claimsStart >= 0 ? claimsStart : bodyEnd);
    classifyLeading(leading, { books, issues, explicit, inferred, hasBodyAfter: claimsStart >= 0 || partIndex >= 0 });
    const assign = (key, slice) => {
        if (slice.length === 0) return;
        books[key].push(...slice);
        inferred.push({ key, blocks: slice });
    };
    if (claimsStart >= 0) assign('claims', list.slice(claimsStart, claimsEnd));
    assign('description', list.slice(claimsStart >= 0 ? claimsEnd : bodyEnd, drawingsStart));
    if (drawingsStart < list.length) assign('drawings', list.slice(drawingsStart));
}

// 文末仅由图片段与纯图号段组成、且至少含一幅图片的尾部
function trailingDrawingsStart(list) {
    let start = list.length;
    while (start > 0) {
        const block = list[start - 1];
        const isLabel = block.kind === 'paragraph' && isPureLabel(block.text);
        if (block.kind !== 'image' && !isLabel) break;
        start -= 1;
    }
    return list.slice(start).some((block) => block.kind === 'image') ? start : list.length;
}

// 权利要求块（或首个五部分标题）之前的无标题前导正文：≤ 3 段、无编号、无图表 → 摘要；否则并入说明书
function classifyLeading(leading, { books, issues, explicit, inferred, hasBodyAfter }) {
    if (leading.length === 0) return;
    const paragraphs = leading.filter((block) => block.kind === 'paragraph');
    const isAbstractLike = hasBodyAfter && !explicit.has('abstract') && books.abstract.length === 0
        && paragraphs.length === leading.length && paragraphs.length <= MAX_ABSTRACT_PREAMBLE
        && paragraphs.every((block) => !CLAIM_START_RE.test(block.text));
    if (isAbstractLike) {
        books.abstract.push(...leading);
        inferred.push({ key: 'abstract', blocks: leading });
        return;
    }
    books.description.push(...leading);
    issues.push(createIssue(ISSUE_CODES.SECTION_UNCLASSIFIED, `${leading.length} 个前导块无法归类（无四书标题），已并入说明书`));
}

// ============================================================
// 各书收尾：说明书标题与 role 标注
// ============================================================

function finalizeBook(key, blocks, { titles, sectionDetection }) {
    if (key !== 'description') return blocks.map((block) => ({ ...block, role: block.role || roleOf(key, block) }));
    const out = [];
    let seenHeading = false;
    let titleTaken = titles.some((title) => title.source === 'description-title');
    for (const block of blocks) {
        if (!seenHeading && !titleTaken && isTitleLike(block) && !isPartHeading(block, sectionDetection)) {
            titles.push({ text: block.text, source: 'description-title', block });
            titleTaken = true;
            continue;
        }
        const heading = block.kind === 'heading' || isPartHeading(block, sectionDetection);
        if (heading) seenHeading = true;
        out.push({ ...block, role: heading ? 'heading' : 'paragraph', headingText: heading ? headingTextOf(block) : undefined });
    }
    return out;
}

const roleOf = (key, block) => {
    if (block.kind === 'image') return 'figure';
    if (key === 'drawings' && block.kind === 'paragraph' && isPureLabel(block.text)) return 'label';
    return 'paragraph';
};

// 五部分标题输出归一文本（去序号与冒号）；其它标题保留原文
const headingTextOf = (block) => {
    const normalized = normalizeTitle(block.text);
    return PART_HEADING_RE.test(normalized) ? normalized : block.text;
};

// ============================================================
// 发明名称
// ============================================================

function resolveInventionTitle({ titleField, titles, claims, meta, issues }) {
    if (titleField) return { text: titleField.text, source: 'field' };
    const preferred = ['description-title', 'document-title'];
    for (const source of preferred) {
        const hit = titles.find((title) => title.source === source);
        if (hit) return { text: hit.text, source };
    }
    const subject = claimSubject(claims);
    if (subject) {
        issues.push(createIssue(ISSUE_CODES.TITLE_FALLBACK, `未找到发明名称段，已从权利要求 1 推定为“${subject}”`));
        return { text: subject, source: 'claim' };
    }
    const metaTitle = typeof meta.title === 'string' ? meta.title.trim() : '';
    if (metaTitle && !isSectionName(metaTitle)) {
        issues.push(createIssue(ISSUE_CODES.TITLE_FALLBACK, `未找到发明名称段，已回退为文档标题“${metaTitle}”`));
        return { text: metaTitle, source: 'meta' };
    }
    issues.push(createIssue(ISSUE_CODES.TITLE_MISSING, '未找到发明名称段，说明书将不含 invention-title'));
    return null;
}

function claimSubject(claims) {
    const first = claims.find((block) => block.kind === 'paragraph' && CLAIM_START_RE.test(block.text));
    const match = first ? CLAIM_SUBJECT_RE.exec(first.text) : null;
    return match ? match[1].trim() : '';
}

const isSectionName = (text) => {
    const title = normalizeTitle(text);
    return PART_HEADING_RE.test(title) || BOOK_RULES.some(([, re]) => re.test(title));
};

module.exports = { detectSections, normalizeTitle, isSectionName, BOOK_KEYS, PART_HEADING_RE, TITLE_FIELD_RE, CLAIM_SUBJECT_RE };
