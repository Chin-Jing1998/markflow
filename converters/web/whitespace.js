/**
 * 超长连续空白截断（url 解析器 preprocessHtml 的第一步）
 *
 * 动机：turndown 7.2.4 的 postProcess 对整篇输出跑 output.replace(/[\t\r\n\s]+$/, '')，
 * 输出里任何一段不在末尾、长度为 R 的连续空白都要花约 R²/2 步，而依赖不能改。本仓库下游的
 * BR 折叠（parsers/url 的 collapseBreakMarkers）与行尾空白清理（web/normalize）自身线性于
 * 文本长度，不依赖本截断。网页正文属不可信输入，故在进入 turndown 之前就地把
 * 「会进入 turndown 输出的连续空白」截到 MAX_WHITESPACE_RUN 个，此后残余成本线性于页面大小。
 *
 *   capWhitespaceRuns($, droppedTags)  就地修改 DOM、无返回值（与 parsers/url 的 markIndents、tidyEmptySpans 同一惯例）
 *
 * 成本模型对齐 turndown 的两条规则，规则变更时须同步本文件：
 *   - collapseWhitespace 只折叠 [ \r\n\t]，且只跳过 <pre>（本项目未开 preformattedCode）。
 *     故 pre 之外、只含这四种字符的一段空白至多折出 1 个空格，成本记 1；含不换行空格、
 *     全角空格等其他 \s 字符的，以及 pre 之内的，逐字进入输出，成本为其长度。
 *   - 属性值不经空白折叠，一律按长度截断；各属性独立计数（属性之间在输出里必有
 *     「![」「](」引号等可见字符隔开，不会并成一段）。
 *   - 文本节点须跨节点累计：<i>&nbsp;</i> 重复 n 次在输出里就是 n 个相连的不换行空格，
 *     逐节点各自截断挡不住。累计值遇到「会进入输出的可见字符」才清零。
 */

const MAX_WHITESPACE_RUN = 256;

// 一段极大空白串。无必需后缀，极大串一次匹配即成功，不存在失败后的逐位回溯
const WHITESPACE_RUN_RE = /\s+/g;
// 整段只含可被 turndown 折叠的 ASCII 空白。两端锚定，单次尝试即出结果
const COLLAPSIBLE_ONLY_RE = /^[ \t\r\n]+$/;

// 内部文字不进入 turndown('url') 输出、自身也不产出任何可见字符的元素：整棵子树既不计数
// 也不清零，其属性亦不处理。让这类文字清零会使两侧空白在输出里重新并成一段，上限即被绕过。
// template 的内容不在 turndown 所见的 childNodes 中；表格规则只取行内单元格，caption 不进输出。
// 调用方另经 droppedTags 传入 turndown service.remove 掉的标签（见 ir/turndown 的 URL_REMOVED_TAGS）
const NEVER_RENDERED_TAGS = Object.freeze(['template', 'caption']);

/** @param {import('cheerio').CheerioAPI} $ @param {string[]} droppedTags turndown 移除的标签 */
function capWhitespaceRuns($, droppedTags = []) {
    const skipped = new Set([...droppedTags, ...NEVER_RENDERED_TAGS]);
    // 自上一个会进入输出的可见字符以来，已放行的空白成本
    let emitted = 0;

    const capText = (text, inPre) => {
        let endsWithSpace = false;
        const capped = text.replace(WHITESPACE_RUN_RE, (run, offset) => {
            // 不在节点开头，则其前必为可见字符，累计从此段重新起算
            if (offset > 0) emitted = 0;
            endsWithSpace = offset + run.length === text.length;
            const room = MAX_WHITESPACE_RUN - emitted;
            if (!inPre && COLLAPSIBLE_ONLY_RE.test(run)) {
                if (room <= 0) return '';
                emitted += 1;
                return run;
            }
            const kept = run.length > room ? run.slice(0, room) : run;
            emitted += kept.length;
            return kept;
        });
        if (text && !endsWithSpace) emitted = 0;
        return capped;
    };

    const capAttribs = (attribs) => {
        for (const name of Object.keys(attribs)) {
            const value = attribs[name];
            // 整个值不超过上限时，其中任何一段都不可能超过
            if (typeof value !== 'string' || value.length <= MAX_WHITESPACE_RUN) continue;
            const capped = value.replace(
                WHITESPACE_RUN_RE,
                (run) => (run.length > MAX_WHITESPACE_RUN ? run.slice(0, MAX_WHITESPACE_RUN) : run),
            );
            if (capped !== value) attribs[name] = capped;
        }
    };

    // 按文档顺序遍历；注释与指令节点不进入输出，跳过即可（不清零）
    const visit = (nodes, inPre) => {
        for (const node of nodes || []) {
            if (node.type === 'text') {
                const capped = capText(node.data || '', inPre);
                if (capped !== node.data) node.data = capped;
                continue;
            }
            // script、style 的 type 不是 'tag'，以 attribs 判定元素节点
            if (!node.attribs) continue;
            if (skipped.has(node.name)) continue;
            capAttribs(node.attribs);
            visit(node.children, inPre || node.name === 'pre');
        }
    };

    visit($.root()[0].children, false);
}

module.exports = { capWhitespaceRuns, MAX_WHITESPACE_RUN };
