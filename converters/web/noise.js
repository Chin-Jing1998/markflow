/**
 * 网页正文噪声清洗（规则表驱动）
 *
 * 作用对象：已经从页面中提取出来的正文 HTML 片段；调用时机在图片下载之前，
 * 使分享二维码、广告位里的图片不会被白白下载。
 *
 * 三类规则，按顺序施加：
 *   1) 属性规则 NOISE_ATTR_RULES —— 按 class/id 的「令牌」判定，而非子串匹配。
 *      令牌化会拆分连字符、下划线与驼峰，因此 "social-share"、"shareBtn"、"share_box"
 *      都含令牌 share，而 "shared-content" 拆出的是 shared，不会被误伤。
 *   2) 文案规则 NOISE_TEXT_RULES —— 整段只有引导语（关注、转载声明等）的短块删除。
 *   3) 结构规则 —— 连续 <br> 削减、空元素迭代删除。
 *
 * 清洗属常规行为，不写入 warnings。
 */
const cheerio = require('cheerio');

// 属性规则的 match 为析取范式：外层任一组命中即判为噪声，组内令牌须全部出现。
const NOISE_ATTR_RULES = Object.freeze([
    { name: 'share', desc: '分享栏与社交按钮', match: [['share'], ['sharing'], ['social', 'bar'], ['social', 'btn'], ['social', 'list']] },
    { name: 'recommend', desc: '推荐位', match: [['recommend'], ['recommends'], ['recommendation'], ['recommended']] },
    { name: 'related', desc: '相关阅读', match: [['related'], ['relate', 'post'], ['relate', 'article']] },
    { name: 'comment', desc: '评论区', match: [['comment'], ['comments'], ['disqus'], ['discuss'], ['livere'], ['gitalk'], ['valine']] },
    { name: 'breadcrumb', desc: '面包屑', match: [['breadcrumb'], ['breadcrumbs'], ['crumbs']] },
    { name: 'advert', desc: '广告位', match: [['advert'], ['advertisement'], ['adsbygoogle'], ['ad', 'banner'], ['ad', 'slot'], ['ad', 'wrap'], ['sponsor'], ['promotion']] },
    { name: 'subscribe', desc: '订阅与关注引导', match: [['subscribe'], ['subscription'], ['newsletter'], ['follow', 'btn'], ['follow', 'card'], ['qrcode'], ['qr', 'code']] },
    { name: 'toc', desc: '页内目录', match: [['toc'], ['catalog'], ['table', 'of', 'contents'], ['article', 'directory']] },
    { name: 'author-card', desc: '作者卡片', match: [['author', 'card'], ['author', 'info'], ['author', 'profile'], ['author', 'bio'], ['author', 'box'], ['byline', 'card'], ['profile', 'card']] },
    { name: 'nav', desc: '页内导航与上下篇', match: [['pagination'], ['pager'], ['prev', 'next'], ['post', 'nav'], ['article', 'nav']] },
]);

// 整段只有这些引导语的短块删除；只在 NOISE_TEXT_MAX_LENGTH 以内的块上生效
const NOISE_TEXT_RULES = Object.freeze([
    { name: 'follow-blue', desc: '点击上方蓝字关注', re: /^点击(上方|上面|以?上)?(的)?[^，。！？\s]{0,10}(蓝字|名片|关注)/ },
    { name: 'follow-us', desc: '关注我们', re: /^(欢迎)?关注(我们|我|本号|公众号)/ },
    { name: 'welcome-action', desc: '欢迎点赞转发', re: /^欢迎(点赞|转发|收藏|订阅|留言|在看)/ },
    { name: 'long-press', desc: '长按识别二维码', re: /长按[^，。！？\s]{0,8}二维码|扫[码描][^，。！？\s]{0,8}二维码|扫码(关注|添加|加群|领取|进群)/ },
    { name: 'reprint', desc: '转载声明', re: /转载请注明(出处|来源)|未经(授权|允许|许可)(不得|禁止)转载|禁止(任何形式的)?转载/ },
    { name: 'first-publish', desc: '首发声明', re: /^本文(首发于|最早发布于|原载于)/ },
    { name: 'copyright', desc: '版权与免责声明', re: /^(版权声明|免责声明|声明[:：])/ },
    { name: 'origin-link', desc: '原文链接引导', re: /^(点击)?(阅读原文|查看原文|原文链接)/ },
    { name: 'more-reading', desc: '推荐阅读栏目标题', re: /^(推荐阅读|相关阅读|延伸阅读|更多精彩|往期(推荐|回顾|精选)|热门推荐)[：:]?$/ },
    { name: 'end-mark', desc: '文末互动引导', re: /^(点个|点击)?(在看|点赞|分享)(和|与|\+)?(在看|点赞|分享)?[，,。!！]?$/ },
]);

// 文案规则只作用于这些标签，且文本长度不超过阈值——避免把长正文整段删掉
const TEXT_RULE_TAGS = 'p, div, section, span, li, h1, h2, h3, h4, h5, h6, strong, em, blockquote';
const NOISE_TEXT_MAX_LENGTH = 60;

// 空元素删除的标签白名单：不含 td/th/tr/table，避免破坏表格结构
const EMPTY_TAGS = 'p, div, section, span, li, blockquote, h1, h2, h3, h4, h5, h6, article, header, figure, a';
// 这些后代视为「有内容」，即便没有文本也不能删
const CONTENT_DESCENDANTS = 'img, video, audio, iframe, table, embed, object, svg, canvas, picture, source';
const EMPTY_SWEEP_ROUNDS = 3;
// 连续 <br> 最多保留的个数
const MAX_CONSECUTIVE_BR = 2;
// 安全阀：命中噪声规则的元素若占据正文过半文本，视为误判，保留不删
const MAX_REMOVAL_TEXT_RATIO = 0.5;

/**
 * @param {string} html 正文 HTML 片段
 * @returns {string} 清洗后的 HTML 片段
 */
function cleanNoise(html) {
    const source = String(html == null ? '' : html);
    if (!source.trim()) return source;

    const $ = cheerio.load(source, null, false);
    const totalLength = $.root().text().trim().length;
    removeByAttributes($, totalLength);
    removeByText($);
    collapseLineBreaks($);
    removeEmptyElements($);
    return $.html();
}

// ---------- 规则一：class/id 令牌 ----------

// "social-share shareBtn_2" → ['social','share','share','btn','2']
function tokensOf(value) {
    return String(value == null ? '' : value)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function matchNoiseRule(tokens) {
    if (tokens.length === 0) return null;
    const set = new Set(tokens);
    for (const rule of NOISE_ATTR_RULES) {
        if (rule.match.some((group) => group.every((token) => set.has(token)))) return rule;
    }
    return null;
}

function removeByAttributes($, totalLength) {
    // 文档序遍历：父元素先被删除时，其子元素随之消失，无需再判定
    $('[class], [id]').each((_, el) => {
        if (!isAttached(el)) return;
        const $el = $(el);
        const tokens = [...tokensOf($el.attr('class')), ...tokensOf($el.attr('id'))];
        if (!matchNoiseRule(tokens)) return;
        if (exceedsRemovalBudget($el, totalLength)) return;
        $el.remove();
    });
}

// each() 拿到的是遍历开始时的快照：父元素被删后，子元素虽仍指向原父，却已不与根相连。
// 沿 parent 链向上追溯，能走到 root 才算仍在树上。
function isAttached(el) {
    for (let node = el; node; node = node.parent) {
        if (node.type === 'root') return true;
    }
    return false;
}

function exceedsRemovalBudget($el, totalLength) {
    if (totalLength <= 0) return false;
    return $el.text().trim().length > totalLength * MAX_REMOVAL_TEXT_RATIO;
}

// ---------- 规则二：引导文案 ----------

function removeByText($) {
    $(TEXT_RULE_TAGS).each((_, el) => {
        if (!isAttached(el)) return;
        const $el = $(el);
        const text = $el.text().replace(/\s+/g, ' ').trim();
        if (!text || text.length > NOISE_TEXT_MAX_LENGTH) return;
        if (!NOISE_TEXT_RULES.some((rule) => rule.re.test(text))) return;
        $el.remove();
    });
}

// ---------- 规则三：结构 ----------

// 连续的 <br> 超过 MAX_CONSECUTIVE_BR 个时，多余的删除（其间的空白文本节点一并清掉）
function collapseLineBreaks($) {
    $('br').each((_, el) => {
        let seen = 1;
        let node = el.nextSibling;
        const pending = [];
        while (node) {
            if (node.type === 'text' && !String(node.data || '').trim()) {
                pending.push(node);
                node = node.nextSibling;
                continue;
            }
            if (!(node.type === 'tag' && node.tagName === 'br')) break;
            seen += 1;
            const next = node.nextSibling;
            if (seen > MAX_CONSECUTIVE_BR) {
                pending.forEach((blank) => $(blank).remove());
                $(node).remove();
            }
            pending.length = 0;
            node = next;
        }
    });
}

// 迭代若干轮：删掉内层空元素后，外层容器可能随之变空
function removeEmptyElements($) {
    for (let round = 0; round < EMPTY_SWEEP_ROUNDS; round += 1) {
        let removed = 0;
        $(EMPTY_TAGS).each((_, el) => {
            if (!isAttached(el)) return;
            const $el = $(el);
            if ($el.text().trim()) return;
            if ($el.find(CONTENT_DESCENDANTS).length > 0) return;
            $el.remove();
            removed += 1;
        });
        if (removed === 0) return;
    }
}

module.exports = { cleanNoise, tokensOf, NOISE_ATTR_RULES, NOISE_TEXT_RULES };
