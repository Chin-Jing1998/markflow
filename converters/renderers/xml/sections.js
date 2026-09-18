/**
 * 五书分节（patent profile）：把扁平块序列归入权利要求书 / 说明书 / 说明书附图 / 说明书摘要 / 摘要附图
 *
 * detectSections(blocks, { sectionDetection, meta }) →
 *   { books: { claims, description, drawings, abstract, abstractFigure }（各为块数组，说明书块带 role），
 *     inventionTitle: { text, source } | null, issues: Issue[], assignments: Map<顶层节点, { book, role }> }
 *
 * 规则（方案 §3.4.2、研究报告 §5.2、交接简报 §4）：
 *   0. Word 分节页眉（官方五书模板的书目名只写在各节页眉里，正文没有书目标题段）：解析层给顶层节点写的
 *      data.section = { index, header }（见 parsers/docx-sections）经 block.origin 读出；页眉文字整体、其次逐行
 *      经 normalizeTitle 与书目正则比对，认得出书目的分节整节直接归入该书，视同显式书目，不报「按位置推定」
 *      与「无法归类」；认不出的分节（事务所抬头、空页眉）不切分区域，仅在紧随页眉区域时另起一个无书目区域，
 *      回落到规则 2–3。同一分节内仍出现书目标题段时，标题段照旧生效（自该段起改归标题所指书目，至下一
 *      分节或下一标题段为止）。不带分节信息的块（栅格化替换出的图片节点等）沿用前一块所在的分节。
 *   1. 官方显式标记按码位识别、用后剥离。Cnipr 字体把私用区码位渲染成「段号／条号／号／名／题」字形，
 *      文档里存的是码位而非这些汉字：U+E209 成对包裹发明名称 → hint 'invention-title'；U+E20A 成对包裹
 *      小标题 → hint 'heading'；U+E206 权项起始 → hint 'claim-start'；U+E208 成对包裹编号或图号 → 去壳保留
 *      内层文字（「1. 」交权项模块，「图13」交图号判定）；U+E205 段落起始 → hint 'paragraph'：撰稿人已标明
 *      这是正文段，不再按文字猜成小标题、发明名称或权项起始（官方转换器同样只认 U+E20A 为小标题，
 *      正文里的「实施例」「1、……」照常输出为 p）。一段含多种码位时按 名称 > 小标题 > 权项起始 > 段落 取其一。
 *      识别之后 U+E200–U+E20F 一律从段落文字与表格单元格中删除，产物不留残留。
 *      字面汉字规则（「名…名」→ 发明名称，「题…题」→ 标题，「段号[0001]号…」→ 保留 [0001] 交段号模块复用，
 *      「条号1.号…」→ 保留 1. 交权项模块，「号图1号」→ 图1）源自对手册截图的推定，真实 docx 中不出现；
 *      「名…名」「题…题」两条对普通正文有误伤风险（首尾同为该字的短段会被削去首尾并改判角色），故仅在
 *      全文不含任何上述结构码位时才启用——官方模板稿一律走码位，不受其影响；未见码位的文稿行为与此前一致。
 *   2. 候选标题 = heading 节点，或（sectionDetection 为 auto 时）整段加粗 / 纯文本 ≤ 12 字的段落；
 *      候选标题命中书目正则（允许字间空白）即为分节标题：权利要求书 / 说明书 / 说明书附图|附图 /
 *      说明书摘要|摘要 / 摘要附图；sectionDetection 为 headings 时只认 heading 节点。
 *   3. 无标题的前导区域按位置推定：权利要求块 = 自首个「N、」「N.」编号段起、至首个五部分标题（或文末附图块）
 *      之前，且必须位于说明书之前；权利要求块之前 ≤ 3 段、无编号、无图表的前导正文推定为摘要，否则并入
 *      说明书（warning）；文末仅由图片段与纯图号段组成的尾部 → 说明书附图；无「摘要附图」标题时摘要内的图片段
 *      → 摘要附图。全部位置推定的书目合并为一条 SECTION_INFERRED 提示并列出段落区间（heading 命中的不列）。
 *   4. 说明书内：五部分标题（技术领域 / 背景技术 / 发明内容|实用新型内容 / 附图说明 / 具体实施方式|实施例）
 *      不论 heading 深度或普通段一律 role 'heading'（输出 level="2"）；heading 节点同样为 heading。
 *   5. 发明名称回退链：「发明名称：X」字段 → 说明书首个标题段 → 文首文档标题 → 权利要求 1 主题（warning）
 *      → doc.meta.title（warning，须不是书目或五部分标题文本）→ 缺失（warning，不输出 invention-title）。
 */
const { runsText, trimRuns, stripPrefix, textRun } = require('./inline');
const { ISSUE_CODES, createIssue } = require('./precheck');
const { CLAIM_START_RE } = require('./claims');
const { isPureLabel } = require('./figures');
const { mergeSplitGroups, splitGroupOf } = require('./blocks');

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
// 官方标记码位（不可见字符一律以码点声明、运行时生成，源码里不出现看不见的字面量）
const fromCode = (code) => String.fromCharCode(code);
const OFFICIAL_MARKS = Object.freeze({
    PARAGRAPH: fromCode(0xE205), CLAIM: fromCode(0xE206), NUMBER: fromCode(0xE208),
    TITLE: fromCode(0xE209), HEADING: fromCode(0xE20A),
});
const OFFICIAL_PUA_CLASS = `[${fromCode(0xE200)}-${fromCode(0xE20F)}]`;
const OFFICIAL_PUA_RE = new RegExp(OFFICIAL_PUA_CLASS, 'g');
const HAS_OFFICIAL_PUA_RE = new RegExp(OFFICIAL_PUA_CLASS);
const STRUCTURAL_MARK_RE = new RegExp(`[${Object.values(OFFICIAL_MARKS).join('')}]`);
// 码位 → hint，按先后取首个命中者：发明名称 > 小标题 > 权项起始 > 段落
const HINT_BY_MARK = Object.freeze([
    [OFFICIAL_MARKS.TITLE, 'invention-title'], [OFFICIAL_MARKS.HEADING, 'heading'],
    [OFFICIAL_MARKS.CLAIM, 'claim-start'], [OFFICIAL_MARKS.PARAGRAPH, 'paragraph'],
]);
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
    const useLiteralMarks = !blocks.some(hasStructuralMark);
    const normalized = blocks.map((block, position) => ({ ...normalizeOfficialMarks(block, useLiteralMarks), index: position + 1 }));
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

// 无「摘要附图」标题时，摘要区域内独立成段的图片推定为摘要附图。与摘要文字同属一个 Word 段落的图片
// （大图拆段拆出来的、与某个文字块同组的图片块）是段内图片——多为结构式或公式——留在摘要里，由渲染器并回原段
function moveAbstractImages(books, inferred) {
    if (books.abstractFigure.length > 0) return;
    const textGroups = new Set(books.abstract.filter((block) => block.kind === 'paragraph').map(splitGroupOf).filter((group) => group !== null));
    const isStandaloneImage = (block) => block.kind === 'image' && !textGroups.has(splitGroupOf(block));
    const images = books.abstract.filter(isStandaloneImage);
    if (images.length === 0) return;
    books.abstract = books.abstract.filter((block) => !isStandaloneImage(block));
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

const hasTextRuns = (block) => block.kind === 'paragraph' || block.kind === 'heading';

const hasStructuralMark = (block) => hasTextRuns(block) && STRUCTURAL_MARK_RE.test(runsText(block.runs));

const hintOfMarks = (text) => {
    const hit = HINT_BY_MARK.find(([mark]) => text.includes(mark));
    return hit ? hit[1] : null;
};

// useLiteralMarks：全文不含结构码位时才按字面汉字规则识别（见文件头规则 1）
function normalizeOfficialMarks(block, useLiteralMarks) {
    if (block.kind === 'table') return stripTableMarks(block);
    if (!hasTextRuns(block)) return block;
    let hint = hintOfMarks(runsText(block.runs));
    let runs = trimRuns(block.runs.map((run) => (run.kind === 'text' ? textRun(run.text.replace(OFFICIAL_PUA_RE, ''), run.marks) : run)));
    const text = runsText(runs).trim();
    if (!useLiteralMarks) return { ...block, runs, text, hint };
    if (MARK_TITLE_RE.test(text)) { runs = stripEdges(runs, /^名/, /名$/); hint = 'invention-title'; }
    else if (MARK_HEADING_RE.test(text)) { runs = stripEdges(runs, /^题/, /题$/); hint = 'heading'; }
    else if (MARK_FIGURE_RE.test(text)) { runs = stripEdges(runs, /^号/, /号$/); }
    else if (MARK_PARA_RE.test(text)) { runs = stripMarkedNumber(runs, MARK_PARA_RE, MARK_PARA_TAIL_RE); }
    else if (MARK_CLAIM_RE.test(text)) { runs = stripMarkedNumber(runs, MARK_CLAIM_RE, MARK_CLAIM_TAIL_RE); }
    return { ...block, runs, text: runsText(runs).trim(), hint };
}

// 未栅格化的表格降级为逐行文本输出，单元格里的官方码位同样不得进入产物；无码位时返回原块
function stripTableMarks(block) {
    if (!block.rows.some((row) => row.some((cell) => HAS_OFFICIAL_PUA_RE.test(cell)))) return block;
    return { ...block, rows: block.rows.map((row) => row.map((cell) => cell.replace(OFFICIAL_PUA_RE, ''))) };
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

// 官方「段落起始」码位标明的正文段不参与按文字的角色推断
const isMarkedBody = (block) => block.hint === 'paragraph';

const isPartHeading = (block, sectionDetection) => block.hint === 'heading'
    || (!isMarkedBody(block) && isTitleCandidate(block, sectionDetection) && PART_HEADING_RE.test(normalizeTitle(block.text)));

// 权项起始段：带官方「权项起始」码位，或文字以权项编号开头（标明为正文段的除外）
const isClaimStartBlock = (block) => block.hint === 'claim-start' || (!isMarkedBody(block) && CLAIM_START_RE.test(block.text));

// 标题样段：heading 节点，或无终结标点、不带编号的短段——加粗，或以「一种」起头的普通段
function isTitleLike(block) {
    if (block.hint === 'invention-title') return true;
    if (isMarkedBody(block)) return false;
    if (block.kind === 'heading') return block.text.length > 0 && block.text.length <= MAX_INVENTION_TITLE;
    if (block.kind !== 'paragraph' || !block.text || block.text.length > MAX_INVENTION_TITLE) return false;
    return !TERMINAL_PUNCT_RE.test(block.text) && !isClaimStartBlock(block) && (block.isBold || SUBJECT_PREFIX_RE.test(block.text));
}

// 区域切分：页眉认得出书目的分节与书目标题段各起一个显式区域，其余块并入当前区域（见文件头规则 0、2）
function splitRegions(blocks, sectionDetection, assignments) {
    const regions = [{ book: null, blocks: [] }];
    let section = null;
    for (const block of blocks) {
        const entered = sectionOf(block);
        if (entered && (!section || entered.index !== section.index)) {
            const headerBook = bookOfHeader(entered.header);
            if (headerBook || (section && section.book)) regions.push({ book: headerBook, blocks: [] });
            section = { index: entered.index, book: headerBook };
        }
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

// 块所属的 Word 分节（解析层写在顶层节点上）；没有分节信息时为 null，由调用方沿用前一块的分节
function sectionOf(block) {
    const section = block.origin && block.origin.data && block.origin.data.section;
    return section && Number.isInteger(section.index) ? section : null;
}

// 页眉 → 书目：先整体比对，再逐行比对（事务所页眉常见「案号一行、书目名一行」）
function bookOfHeader(header) {
    const lines = String(header == null ? '' : header).split('\n');
    for (const candidate of [lines.join(''), ...lines]) {
        const title = normalizeTitle(candidate);
        const hit = BOOK_RULES.find(([, re]) => re.test(title));
        if (hit) return hit[0];
    }
    return null;
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
        : list.findIndex((block, index) => index < bodyEnd && block.kind === 'paragraph' && isClaimStartBlock(block));

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

// 权利要求块（或首个五部分标题）之前的无标题前导正文：≤ 3 段、无编号、无图表 → 摘要；否则并入说明书。
// 段数与「无图表」按 Word 段落计：解析层的大图拆段会把「文字 + 段尾大图」拆成文字块与图片块（同一 splitGroup），
// 判定前先并回，否则摘要段只因图片够大就落入「无法归类」；归书的仍是未并回的原块，由 patent 渲染器统一并回
function classifyLeading(leading, { books, issues, explicit, inferred, hasBodyAfter }) {
    if (leading.length === 0) return;
    const units = mergeSplitGroups(leading);
    const paragraphs = units.filter((block) => block.kind === 'paragraph');
    const isAbstractLike = hasBodyAfter && !explicit.has('abstract') && books.abstract.length === 0
        && paragraphs.length === units.length && paragraphs.length <= MAX_ABSTRACT_PREAMBLE
        && paragraphs.every((block) => !isClaimStartBlock(block));
    if (isAbstractLike) {
        books.abstract.push(...leading);
        inferred.push({ key: 'abstract', blocks: leading });
        return;
    }
    books.description.push(...leading);
    issues.push(createIssue(ISSUE_CODES.SECTION_UNCLASSIFIED, `${leading.length} 个前导块无法归类（无书目标题），已并入说明书`));
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
