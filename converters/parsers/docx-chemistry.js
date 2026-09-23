/**
 * docx 图片角色判定：化学结构式判据与通用角色标记
 *
 * 两项判定产出同一个结果——image 节点的 data.role（见 ir/schema）。
 *
 * 一、化学结构式（四条判据，命中任一即 'chemistry'；出处见 调研与验收记录/chemistry-recognition.md 2.2 节）
 *   (a) OLE 对象的 ProgID 命中化学白名单（CHEMISTRY_PROG_IDS，容忍 ChemDraw.Document.6.0 一类版本后缀），
 *       打标对象是该 w:object 内 v:imagedata 对应的预览图；
 *   (c) 域代码 `EMBED <白名单 ProgID>`（w:fldSimple/@w:instr 或复合域的 w:instrText），打标对象是域结果里的图片；
 *       (a) 与 (c) 同为 document.xml 上的区间判据，由 collectChemistryRanges 给出字符区间，
 *       docx-layout 在给图片编号时按图片的起始位置命中；
 *   (b) 替换文字以 `<SIPOChemFile` 开头（官方工具把 CML 存进 Word 图形对象的替换文字）。命中后 alt 一律清空：
 *       这段 CML 可长达数十 KB，不得流入任何产物的 alt；
 *   (d) EMF 字节内带 ChemDraw 原生数据：ChemDraw 输出的 EMF 在 EmfPlusComment 记录里以 `CDIF` 标记分块携带
 *       CDX 文档（魔数 `VjCD0100`），首块的 `CDIF\0VjCD0100` 十三字节连写即判据（取证见
 *       调研与验收记录/emf-rasterization.md 的 F7 与 3.5 节）。这条覆盖「以普通图片形式粘贴的结构式」，
 *       是 (a) 漏掉的大头；只对 EMF 生效、扫描长度有上限，畸形或截断的文件一律按未命中处理，不抛错。
 *
 * 二、通用角色标记（为 XML 反向导入的往返服务，写入侧在 docx 渲染器）：替换文字匹配
 *   `^markflow:role=(formula|table|chemistry)(?:;|$)` 时取该角色，并从 alt 中去掉这个前缀与紧随其后的一个 `;`，
 *   余下文字仍作 alt；不匹配时 alt 原样。显式标记优先于上述四条判据。
 *
 * 契约：
 *   isChemistryProgId(progId) → boolean
 *   stripVersionSuffix(value) → string（去掉串尾的「.数字」版本后缀；isChemistryProgId 的一步，导出供测试逐字比对）
 *   collectChemistryRanges(documentXml) → [{ start, end }]（按 start 升序，区间之间可重叠）
 *   inChemistryRange(ranges, index) → boolean
 *   hasChemistryEmf(buffer, mime) → boolean
 *   resolveImageRole({ alt, buffer, mime, ooxmlChemistry }) → { role: string | null, alt: string }
 *     入参均可省略；不改动入参，alt 一律返回新串
 *
 * 说明：document.xml 与图片字节均属不可信文档内容，本模块只做字符串与字节定位，不执行其中任何指令。
 */
const { findBlocks, readTag } = require('./docx-math');

// 官方 WordToolKit.dll 内的化学 OLE 白名单，逐字一致；比对时忽略大小写与版本后缀
const CHEMISTRY_PROG_ID_LIST = Object.freeze([
    'ChemDraw.Document', 'ChemDraw_x64.Document', 'Chem3D.Document', 'Chem3D_x64.Document',
    'FXChem.Equation', 'FXChemStruct.Structure', 'KingDrawObject.Document', 'KingDrawXObject.Document',
]);
const CHEMISTRY_PROG_IDS = new Set(CHEMISTRY_PROG_ID_LIST.map((id) => id.toLowerCase()));
// 版本后缀：ChemDraw.Document.6.0 的「.6.0」，即串尾的一段或多段「点号 + 数字串」。Chem3D.Document 的「3」不在点号之后，
// 不会被误剥。数字逐字符判定用的单字符正则：\d 只认 ASCII 0–9
const VERSION_DIGIT_RE = /\d/;
// 角色取值：chemistry 由本模块四条判据产出，formula / table 只来自显式标记
const CHEMISTRY_ROLE = 'chemistry';
const ROLE_MARKER_RE = /^markflow:role=(formula|table|chemistry)(?:;|$)/;
// 官方编辑器写入替换文字的 CML 存档根元素，按前缀比对（同一位置以 `<math` 开头的是公式，不归本模块）
const SIPO_CHEM_PREFIX = '<SIPOChemFile';
// EmfPlusComment 的注释数据首块：`CDIF\0` 标记后紧接 CDX 文档魔数 `VjCD0100`
const CDX_SIGNATURE = Buffer.from('CDIF\x00VjCD0100', 'latin1');
const EMF_MIMES = new Set(['image/x-emf', 'image/emf']);
// EMF 扫描上限：样稿最大的 EMF 为 502 KiB，8 MiB 已远超实际用量；超限者只扫末尾这么多字节——
// ChemDraw 把 CDIF 注释块写在图元记录之后，样稿 26 例均落在文件末 20% 以内
const MAX_EMF_SCAN_BYTES = 8 * 1024 * 1024;

// ---------- (a) OLE ProgID ----------

function isChemistryProgId(progId) {
    const value = String(progId == null ? '' : progId).trim().toLowerCase();
    if (!value) return false;
    return CHEMISTRY_PROG_IDS.has(value) || CHEMISTRY_PROG_IDS.has(stripVersionSuffix(value));
}

// 自串尾向前逐段剥去「点号 + 极大数字串」，代替「量词 + 行尾锚」的 /\.\d+(?:\.\d+)*$/：该正则在不处于串尾的「.数字」长段上
// 从每个点号起都贪婪吃到段尾再逐位回溯，耗时随段长平方增长。点号不是数字，后缀的分段方式唯一，剥到不能再剥处即该正则的最左匹配起点
function stripVersionSuffix(value) {
    let end = value.length;
    for (;;) {
        let start = end;
        while (start > 0 && VERSION_DIGIT_RE.test(value[start - 1])) start -= 1;
        if (start === end || start === 0 || value[start - 1] !== '.') return value.slice(0, end);
        end = start - 1;
    }
}

// ---------- (a) 与 (c)：document.xml 上的化学区间 ----------

function collectChemistryRanges(documentXml) {
    const xml = String(documentXml == null ? '' : documentXml);
    if (!xml) return [];
    return [...oleRanges(xml), ...simpleFieldRanges(xml), ...complexFieldRanges(xml)].sort((a, b) => a.start - b.start);
}

const inChemistryRange = (ranges, index) => ranges.some((range) => index >= range.start && index < range.end);

// (a) w:object 内任一 o:OLEObject 的 ProgID 命中白名单 → 整个 w:object 为化学区间（其内的预览图随之打标）
function oleRanges(xml) {
    const progIdRe = /<o:OLEObject\b[^>]*\bProgID\s*=\s*"([^"]*)"/g;
    return findBlocks(xml, 'w:object')
        .filter((block) => [...xml.slice(block.start, block.end).matchAll(progIdRe)]
            .some((matched) => isChemistryProgId(matched[1])))
        .map(({ start, end }) => ({ start, end }));
}

// (c) 简单域：<w:fldSimple w:instr=" EMBED ChemDraw.Document "> 的整个元素即域结果
function simpleFieldRanges(xml) {
    return findBlocks(xml, 'w:fldSimple')
        .filter((block) => {
            const open = readTag(xml, block.start);
            return Boolean(open) && isChemistryEmbed(attrOf(xml.slice(block.start, open.end + 1), 'w:instr'));
        })
        .map(({ start, end }) => ({ start, end }));
}

// (c) 复合域：begin → instrText（可跨多个 run，拼接后判定）→ separate → 域结果 → end；
// 取 separate 之后到 end 为止的区间（无 separate 时从 begin 起算），嵌套域按最内层归属
function complexFieldRanges(xml) {
    const re = /<w:fldChar\b[^>]*\bw:fldCharType\s*=\s*"(begin|separate|end)"[^>]*>|<w:instrText\b[^>]*>([^<]*)<\/w:instrText>/g;
    const ranges = [];
    const stack = [];
    for (let matched = re.exec(xml); matched; matched = re.exec(xml)) {
        const [token, type, text] = matched;
        const frame = stack[stack.length - 1];
        if (text !== undefined) {
            if (frame) frame.instr += text;
            continue;
        }
        if (type === 'begin') { stack.push({ start: matched.index, resultAt: -1, instr: '' }); continue; }
        if (!frame) continue;
        if (type === 'separate') { frame.resultAt = matched.index + token.length; continue; }
        stack.pop();
        if (isChemistryEmbed(frame.instr)) {
            ranges.push({ start: frame.resultAt >= 0 ? frame.resultAt : frame.start, end: matched.index + token.length });
        }
    }
    return ranges;
}

// 域代码形如 ` EMBED ChemDraw.Document.6.0 \* MERGEFORMAT `
function isChemistryEmbed(instr) {
    const matched = /(?:^|[\s\\])EMBED\s+([\w.\-]+)/i.exec(String(instr == null ? '' : instr));
    return Boolean(matched) && isChemistryProgId(matched[1]);
}

function attrOf(tagText, name) {
    const matched = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tagText);
    return matched ? (matched[1] ?? matched[2] ?? '') : '';
}

// ---------- (d) EMF 内的 ChemDraw 原生数据 ----------

function hasChemistryEmf(buffer, mime) {
    if (!EMF_MIMES.has(String(mime == null ? '' : mime).split(';')[0].trim().toLowerCase())) return false;
    if (!Buffer.isBuffer(buffer) || buffer.length < CDX_SIGNATURE.length) return false;
    const window = buffer.length <= MAX_EMF_SCAN_BYTES ? buffer : buffer.subarray(buffer.length - MAX_EMF_SCAN_BYTES);
    return window.includes(CDX_SIGNATURE);
}

// ---------- 角色汇总 ----------

function resolveImageRole({ alt = '', buffer = null, mime = '', ooxmlChemistry = false } = {}) {
    const text = String(alt == null ? '' : alt);
    const marked = ROLE_MARKER_RE.exec(text);
    if (marked) return { role: marked[1], alt: text.slice(marked[0].length) };
    // (b) 命中即清空 alt：替换文字里的 CML 可长达数十 KB
    if (text.startsWith(SIPO_CHEM_PREFIX)) return { role: CHEMISTRY_ROLE, alt: '' };
    if (ooxmlChemistry || hasChemistryEmf(buffer, mime)) return { role: CHEMISTRY_ROLE, alt: text };
    return { role: null, alt: text };
}

module.exports = {
    CHEMISTRY_ROLE, CHEMISTRY_PROG_ID_LIST,
    isChemistryProgId, stripVersionSuffix, collectChemistryRanges, inChemistryRange, hasChemistryEmf, resolveImageRole,
};
