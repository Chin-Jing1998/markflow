/**
 * 网页正文提取（三级链路）
 *
 *   1) 站点专属选择器 —— 命中即用，extraction 记为 'site:<域名片段>'；
 *   2) Readability    —— 未命中站点表时启用，extraction 记为 'readability'；
 *   3) 旧兜底链路      —— Readability 判定不可读、解析失败或正文过短时启用，
 *                        依次 <article> → <main> → 文本最长的 div → <body>，
 *                        extraction 记为 'fallback:article' 等。
 *
 * 之所以保留兜底链路：Readability 依赖段落长度打分，对段落极短的中文页面、
 * 纯列表页与代码密集页会判负，此时旧链路仍能捞回正文。
 *
 * Readability 会就地改写传入的 document，故此处用 linkedom 单独解析一份 DOM，
 * 与调用方持有的 cheerio 实例互不影响。
 */
const { parseHTML } = require('linkedom');
const { Readability, isProbablyReaderable } = require('@mozilla/readability');
const { hostnameOf } = require('../util');
const { indentMarker } = require('../ir/markers');
const { createIndentResolver, LEAF_BLOCK_SELECTOR, NESTED_BLOCK_SELECTOR } = require('./indent');

// Readability 预标注用：img 的 style 宽度（px 或 %）
const STYLE_WIDTH_RE = /(?:^|;)\s*width\s*:\s*(\d{1,5}(?:\.\d+)?)\s*(px|%)/i;

// 站点专属选择器：url 含 match 时按 selectors 顺序取第一个非空结果
const SITE_SELECTORS = Object.freeze([
    { match: 'mp.weixin.qq.com', selectors: ['#js_content'] },
    { match: 'zhihu.com', selectors: ['.Post-RichTextContainer', '.RichContent-inner'] },
    { match: 'csdn.net', selectors: ['#content_views', '#article_content'] },
    { match: 'jianshu.com', selectors: ['article', '._2rhmJa'] },
    { match: 'juejin.cn', selectors: ['#article-root', '.article-content'] },
    { match: 'segmentfault.com', selectors: ['#article-content', '.article-content'] },
    { match: 'sspai.com', selectors: ['.article-body'] },
    { match: 'cnblogs.com', selectors: ['#cnblogs_post_body'] },
]);

// 兜底链路中直接按标签取的两级
const FALLBACK_TAGS = Object.freeze(['article', 'main']);
// 兜底「最长 div」：只考虑文本超过此长度的 div
const MIN_CONTENT_TEXT_LENGTH = 200;
// Readability 结果的正文字符数低于此值视为失败，转入兜底链路
const MIN_READABILITY_TEXT_LENGTH = 200;
// charThreshold 默认 500 是按英文文章定的，中文单字信息量更大，短文常不足 500 字，故下调
const READABILITY_OPTIONS = Object.freeze({ charThreshold: 100 });
// 可读性预判阈值同样下调：默认 (140, 20) 要求段落普遍超过 140 字符，中文段落多在 50-150 字之间，
// 按默认值几乎所有中文文章都会被判为不可读。放宽后误判的代价可控——Readability 自身的
// charThreshold 与下面的 MIN_READABILITY_TEXT_LENGTH 会把真正提取不出正文的情况挡回兜底链路。
const READERABLE_OPTIONS = Object.freeze({ minContentLength: 50, minScore: 10 });

/**
 * @param {object} params
 * @param {import('cheerio').CheerioAPI} params.$ 已载入整页 HTML 的 cheerio 实例
 * @param {string} params.html 原始页面 HTML 文本
 * @param {string} params.url 页面 URL（用于站点选择器匹配）
 * @returns {{ html: string, extraction: string, article: object|null }}
 */
function extractContent({ $, html, url }) {
    const bySite = extractBySite($, url);
    if (bySite) return { ...bySite, article: null };

    const byReadability = extractByReadability(html);
    if (byReadability) return byReadability;

    return { ...extractByFallback($), article: null };
}

// ---------- 一级：站点专属选择器 ----------

/** 主机名匹配：全等或为其子域，避免查询串等位置的子串误命中 */
function matchesHost(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
}

function extractBySite($, url) {
    const host = hostnameOf(url);
    for (const site of SITE_SELECTORS) {
        if (!matchesHost(host, site.match)) continue;
        for (const selector of site.selectors) {
            const content = $(selector).first().html();
            if (content && content.trim()) return { html: content, extraction: `site:${site.match}` };
        }
    }
    return null;
}

// ---------- 二级：Readability ----------

function extractByReadability(html) {
    let document;
    try {
        ({ document } = parseHTML(String(html || '')));
    } catch (err) {
        return null;
    }
    if (!document || !isReaderable(document)) return null;
    annotateLayout(document);

    let article;
    try {
        const reader = new Readability(document, { ...READABILITY_OPTIONS });
        // 可见性判定换成不经 linkedom 的 el.style 取值的等价实现，理由与前提见 isProbablyVisible
        reader._isProbablyVisible = isProbablyVisible;
        // 懒加载修正换成判定单个图片地址时线性的等价实现，理由与前提见 fixLazyImages
        reader._fixLazyImages = fixLazyImages;
        article = reader.parse();
    } catch (err) {
        return null;
    }
    if (!article || !article.content) return null;
    const textLength = String(article.textContent || '').trim().length;
    if (textLength < MIN_READABILITY_TEXT_LENGTH) return null;
    return { html: article.content, extraction: 'readability', article };
}

/**
 * Readability 的 _cleanStyles 会删掉 style（text-indent 与图片宽度随之丢失），但保留 data-* 属性与文本，
 * 故在它运行前先把两者预标注下来：叶子块的有效 text-indent → 段首 INDENT 标记文本（ir/markers），
 * img 的 style 宽度 → data-mf-width（web/image-display 读取）。标注失败不影响正文提取。
 */
function annotateLayout(document) {
    try {
        for (const img of Array.from(document.querySelectorAll('img'))) {
            const matched = STYLE_WIDTH_RE.exec(img.getAttribute('style') || '');
            if (matched && !img.getAttribute('data-mf-width')) img.setAttribute('data-mf-width', `${matched[1]}${matched[2].toLowerCase()}`);
        }
        const indentOf = createIndentResolver(DOM_STYLE_ACCESS);
        for (const el of Array.from(document.querySelectorAll(LEAF_BLOCK_SELECTOR))) {
            if (el.querySelector(NESTED_BLOCK_SELECTOR)) continue;
            if (!/[^\s]/.test(el.textContent || '')) continue;
            const count = indentOf(el);
            if (count > 0) el.insertBefore(document.createTextNode(indentMarker(count)), el.firstChild);
        }
    } catch (err) {
        /* 预标注只为保真，DOM 能力不足时按未标注继续 */
    }
}

// annotateLayout 的 style 链访问器：自叶子块起沿 parentElement 向上，遇到首个非元素节点即止，口径与原先逐叶建链的
// styleChainOf 相同。逐元素缓存（web/indent 的 createIndentResolver）使祖先 style 只匹配一次，其前提在遍历中成立：
// 标注只在叶子块之首插入文本节点（图片宽度写的是 data-mf-width），不改元素的 style 与父子关系
const DOM_STYLE_ACCESS = Object.freeze({
    isElement: (node) => Boolean(node && node.nodeType === 1),
    styleOf: (node) => node.getAttribute('style') || '',
    parentOf: (node) => node.parentElement,
});

// isProbablyReaderable 内部依赖 matches/className 等 DOM 能力，异常时按不可读处理。可见性判定经公开选项
// visibilityChecker 换成不经 linkedom 的 el.style 取值的等价实现，理由见 inlineStyleValue
function isReaderable(document) {
    try {
        return isProbablyReaderable(document, { ...READERABLE_OPTIONS, visibilityChecker: isNodeVisible });
    } catch (err) {
        return false;
    }
}

/**
 * 元素内联 style 中属性 name 的取值，与 linkedom 0.18.13 的 node.style[name] 逐字相同，而耗时线性于 style 的长度。
 * name 须已是连字符小写形式：linkedom 查表前先经 uhyphen 把驼峰名转成连字符小写，此处不做该转换；调用方只传
 * display 与 visibility，二者经 uhyphen 不变。没有 style 属性或没有匹配的声明时返回空串。
 *
 * 旧写法为何超线性：两处可见性判定原经 linkedom 的 node.style.display／visibility 取值，linkedom 取值前先以正则
 * \s*;\s* 切分整个 style 属性值（css-style-declaration.js 的 updateKeys）。在不邻接分号的长段空白上，该正则从段内每个
 * 起点都要吞下其后的全部空白、找不到分号再逐步回溯，耗时随段长平方增长：纯空格 style 为 8／16／32／64 KB 时，首次读取
 * style.display 依次约 34／128／506／2015 ms，isProbablyReaderable 读 <p> 的 style 在 8／16／32 KB 时依次约
 * 34／130／690 ms；64 KB 的长空白 style 使整条提取链路实测约 2.0 至 4.9 秒（替换后约 1 至 5 毫秒），按平方律外推，
 * 1 MB 时达数分钟。
 * 不改用「先截短 style 中的连续空白」：Readability 的输出会保留或复制部分 style 的原值——svg 子树的 style 不经
 * _cleanStyles 清除；_unwrapNoscriptImages 把含图片扩展名的 style 复制为 data-old-style，并以 === 比较新旧两值；
 * _fixLazyImages 把 svg 内 img 的 style 复制进 src——截短即改变输出。
 *
 * 新写法为何线性：一次 split(';') 加逐段各一次 trim，线性于 style 的长度；每次可见性判定对 display、visibility 各求值
 * 一次。isProbablyReaderable 对每个候选元素至多判定一次；Readability 每轮 _grabArticle 对每个元素至多判定一次，
 * 重试至多四轮（每轮去掉一个标志，共三个）。故两处判定的总耗时线性于页面中 style 的总长。
 *
 * 为何逐字等价（记 s 为 style 属性的当前值，R 为正则 \s*;\s* ）：
 *   (a) s.split(R) 与 s.split(';') 段数相同、一一对应：R 不能匹配空串，每处匹配恰含一个分号，另含其后的全部空白与其前
 *       尚未被上一处匹配吞下的全部空白，故每个分号恰对应一处匹配。前者第 i 段等于后者第 i 段去掉首部空白（i > 0 时）
 *       与尾部空白（i 非末段时）；段内有冒号时，多出的首部空白落在首个冒号之前、属于键，多出的尾部空白落在首个冒号
 *       之后、属于值，而段内有无冒号不变。linkedom 以 [key, ...rest] = rule.split(':') 取首个冒号前后的两部分，与此处的
 *       两次 slice 相同
 *   (b) 正则的 \s 与 String.prototype.trim 去除的是同一字符集（WhiteSpace 与 LineTerminator），故多出的空白恰被 trim 去尽
 *   (c) linkedom 把各段存入 Map，键与值皆非空才写入、后写覆盖先写，取值为 get(name) ?? ''。name 非空，故其效果就是
 *       「键等于 name 且值非空的最后一段」的值，没有则为空串
 *   (d) 没有 style 属性时，linkedom 清空 Map，取值为空串，与此处相同
 *   (e) linkedom 缓存切分结果，只在属性经 value 设值器改写（置 CHANGED）或换成另一个 Attr 时重新切分；属性值的写入只有
 *       构造 Attr、解析期新建（parse-from-string）与 value 设值器三处，故它读到的总是当前属性值的切分结果。例外是经
 *       node.style.X = v 写入：该途径直接改缓存的 Map，其值可与属性值的切分结果不一致（如写入含分号或首尾空白的值），
 *       本链路（annotateLayout、可读性预判与 Readability 0.6.0）没有这种写法
 *   (f) 读的是 linkedom 所切分的同一个值：getAttributeNode('style').value 即 linkedom 读取的 [VALUE]。不用 getAttribute，
 *       因其在 XML 文档中返回转义后的值
 * package.json 以 ^0.18.13 允许 linkedom 升级到 0.18.x：若取值规则改变，test/web-extract.test.js 中以 linkedom 的
 * el.style 为参照的差分用例会报出。
 */
function inlineStyleValue(node, name) {
    const attr = node.getAttributeNode('style');
    if (!attr) return '';
    let found = '';
    for (const piece of attr.value.split(';')) {
        const colon = piece.indexOf(':');
        if (colon < 0) continue;
        const key = piece.slice(0, colon).trim();
        const value = piece.slice(colon + 1).trim();
        if (key === name && value) found = value;
    }
    return found;
}

/**
 * 可读性预判的可见性判定：照录 Readability 0.6.0 的 Readability-readerable.js 中的 isNodeVisible（isProbablyReaderable
 * 缺省的 visibilityChecker），只把 node.style.display 换成 inlineStyleValue(node, 'display')，经公开选项 visibilityChecker
 * 传入。库实现不看 visibility，此处照旧。照录的约定见 isProbablyVisible。
 */
function isNodeVisible(node) {
    // SVG、MathML 节点可能没有 style 或 className.includes，故先判空（库注释之意）
    return (
        (!node.style || inlineStyleValue(node, 'display') != 'none')
        && !node.hasAttribute('hidden')
        // class 含 fallback-image 者照常显示，以免维基百科的数学公式图片被当作隐藏（库注释之意）
        && (!node.hasAttribute('aria-hidden')
            || node.getAttribute('aria-hidden') != 'true'
            || (node.className && node.className.includes && node.className.includes('fallback-image')))
    );
}

/**
 * Readability 的可见性判定：照录 Readability 0.6.0 的 _isProbablyVisible，只把 node.style.display 与
 * node.style.visibility 换成 inlineStyleValue 的取值，由 extractByReadability 覆盖到 Readability 实例上。
 *
 * 两处照录的共同约定：
 *   - 保留 !node.style 的判空、松散比较 !=，以及各子表达式的先后次序与短路结构。node.style 为真时，linkedom 取值同样要
 *     调用该元素的 getAttributeNode('style') 并切分其值，故新写法不引入新的异常点
 *   - 只读不写、不改 DOM，Readability 输出中保留或复制的 style 原值不受影响
 *   - 覆盖 _isProbablyVisible 依赖 Readability 0.6.0 的私有方法名，库内仅 _grabArticle 一处（Readability.js 第 1066 行）
 *     经 this 调用它。package.json 以 ^0.6.0 允许升级到 0.6.x：若方法名或语义改变，test/web-extract.test.js 中以库自身
 *     实现为参照的差分用例会报出
 */
function isProbablyVisible(node) {
    // SVG、MathML 节点可能没有 style 或 className.includes，故先判空（库注释之意）
    return (
        (!node.style || inlineStyleValue(node, 'display') != 'none')
        && (!node.style || inlineStyleValue(node, 'visibility') != 'hidden')
        && !node.hasAttribute('hidden')
        // class 含 fallback-image 者照常显示，以免维基百科的数学公式图片被当作隐藏（库注释之意）
        && (!node.hasAttribute('aria-hidden')
            || node.getAttribute('aria-hidden') != 'true'
            || (node.className && node.className.includes && node.className.includes('fallback-image')))
    );
}

// 判定「属性值为单个图片地址」的两条正则：前者判定恰含一段非空白，后者判定有非空白字符紧接「.扩展名」。合用即与 Readability 0.6.0
// _fixLazyImages 中的原正则逐值同真假，且都线性，理由见 isSingleImageToken
const SINGLE_SEGMENT_RE = /^\s*\S+\s*$/;
const EXTENSION_AFTER_NON_SPACE_RE = /\S\.(jpg|jpeg|png|webp)/;

/**
 * 属性值是否为「单个图片地址」：与 Readability 0.6.0 的 _fixLazyImages 中决定 copyTo = 'src' 的原正则
 * /^\s*\S+\.(jpg|jpeg|png|webp)\S*\s*$/ 逐值同真假，而耗时线性于值的长度。扩展名区分大小写，与原正则相同。
 *
 * 旧写法为何超线性：原正则锚定串首，\S+ 先吞下首段的全部非空白，再逐位退让以寻找「.扩展名」；每找到一处，\S* 又吞到段尾、\s*
 * 吞下其后的空白，若随后不是串尾（首段之后另有非空白），\s* 与 \S* 要逐位退让至全部失败，\S+ 才退到上一处「.扩展名」。首段长 n、
 * 含 k 处扩展名时，失败前的回溯合计约 O(k·n)，病态值上即 O(n²)。值为 a.jpg 重复后接空格与 b 时，纯正则在 8／16／32／64／128／256 KB
 * 上依次约 14.8／67.7／241／939／3843／16246 ms；64 KB 时 extractContent 全链路约 939 ms（同长度而不触发回溯的对照值约 1.2 ms），
 * 该正则占 99.9%；页面使 Readability 重试四轮时 _fixLazyImages 随之执行四次，64 KB 约 3786 ms。按平方律外推，1 MB 约 4 分钟，
 * 20 MB 约 27 小时。
 *
 * 新写法为何线性：前一条正则锚定串首，\s 与 \S 两类不相交，失败时每退一位只做 O(1) 的检查；后一条对每个起点只查定长片段（一个
 * 非空白、点号与至多四个字母）。20 MB 的病态值实测约 46 ms；替换后 64 KB 的文章页约 0.78 ms，四轮重试页约 2.25 ms。
 *
 * 为何逐值等价（记 v 为属性值，「段」指 v 中非空白码元的极大连续片段，扩展名指 jpg、jpeg、png、webp 之一）：
 *   (a) 原正则成立 ⇔ v 恰含一段 R，且 R 中下标 ≥ 1 处有「.扩展名」：\S+\.(扩展名)\S* 只含非空白码元，两侧的 \s* 只含空白，故它
 *       就是 v 唯一的段，\S+ 非空保证「.」的下标 ≥ 1；反之，在 R 中该处切开，前后两部分分别交给 \S+ 与 \S*，即得一次匹配
 *   (b) /^\s*\S+\s*$/ 成立 ⇔ v 恰含一段：不带 u 标志时 \s 与 \S 按 UTF-16 码元互补；不带 m 标志时 $ 只匹配串尾
 *   (c) 在 (b) 成立时，v 的非空白码元全在 R 内，/\S\.(扩展名)/ 的匹配全由非空白码元组成，只能落在 R 内，其首个 \S 保证「.」在 R
 *       中的下标 ≥ 1；反之，R 中下标 ≥ 1 处的「.扩展名」前一个码元非空白，该正则必能匹配。故两条正则同时成立 ⇔ (a) 的右端
 *   (d) test 只报有无匹配：三条正则都不带 g、y 标志，没有 lastIndex 状态，求值先后互不影响；attr.value 在 linkedom 中恒为字符串
 *   (e) 唯一可观察的差别是 RegExp.$1、RegExp.lastMatch 等遗留静态属性，本仓库与 Readability、linkedom、turndown 均不读取
 * 另以随机 40 万个与穷举 3835 万个样本核对，不一致 0；在链路中替换后，1510 份页面的输出逐字相同（一次性补验，不进仓库）。
 */
function isSingleImageToken(value) {
    return SINGLE_SEGMENT_RE.test(value) && EXTENSION_AFTER_NON_SPACE_RE.test(value);
}

/**
 * Readability 的懒加载图片修正：照录 Readability 0.6.0 的 _fixLazyImages，只把决定 copyTo = 'src' 的原正则换成
 * isSingleImageToken(attr.value)，由 extractByReadability 覆盖到 Readability 实例上。img 的 src 为空且没有有效 srcset（缺失、空串
 * 或 "null"），或 class 含 lazy（不区分大小写）时，以及 picture、figure 与 svg 内的 img（linkedom 中三者没有 src 与 srcset 取值器），
 * 都会逐个检查属性值，故默认网页转换（未命中站点选择器时）即经此判定：_prepArticle 在每轮 _grabArticle 中调用本函数一次，
 * Readability 重试时至多四次。
 *
 * 照录的约定：
 *   - 其余语句与库逐字对应：base64 占位图一段对 this.REGEXPS.b64DataUrl 的两次调用（先 test 后 exec）、与 'image/svg+xml' 的全等
 *     比较、/\.(jpg|jpeg|png|webp)/i 的字面量、133 的阈值与 removeAttribute；提前返回的表达式、短路次序与 != 的松散比较（svg 内的
 *     img 是 SVGElement，没有 src 与 srcset 取值器，className 是不带 toLowerCase 的对象，全靠短路才不求值）；按名跳过 src、srcset
 *     与 alt；首条正则 /\.(jpg|jpeg|png|webp)\s+\d/ 的字面量与两条判定的先后；tagName 的全等比较、this._doc.createElement('img')
 *     与 figure 分支的 _getAllNodesWithTag 判定；经 this._forEachNode 以 function 表达式遍历，其 this 即 Readability 实例
 *   - 只改写法、不改语义之处：var 改为 let 与 const，双引号改为单引号。库中两个循环共用一个函数作用域的 attr，此处各自声明，因两个
 *     循环都先赋值后读取，结果不变
 *   - 每轮重读 elem.attributes.length 与 elem.attributes[j]，不取快照：linkedom 的 setAttribute 把新增的属性插到属性表之首
 *     （shared/attributes.js 的 knownSiblings），复制之后下标后移一位，库的循环会重访当前属性并再写一次同一个值。照录保持与库相同的
 *     访问与写入序列
 *   - 覆盖 _fixLazyImages 依赖 Readability 0.6.0 的私有方法名，库内仅 _prepArticle 一处（Readability.js 第 790 行）经 this 调用它。
 *     package.json 以 ^0.6.0 允许升级到 0.6.x：若方法名或语义改变，test/web-extract.test.js 中以库自身实现为参照的差分用例会报出
 */
function fixLazyImages(root) {
    this._forEachNode(
        this._getAllNodesWithTag(root, ['img', 'picture', 'figure']),
        function (elem) {
            // 有的站点（如 Kotaku）在 src 中放 1 像素见方的 base64 占位图，过短的 data URI 不如删去（库注释之意）
            if (elem.src && this.REGEXPS.b64DataUrl.test(elem.src)) {
                // 不删 SVG：SVG 在 133 字节以内也可能是有意义的图（库注释之意）
                const parts = this.REGEXPS.b64DataUrl.exec(elem.src);
                if (parts[1] === 'image/svg+xml') {
                    return;
                }

                // 别的属性里另有图片地址，src 才可删；否则该 src 是要紧的图（库注释之意）
                let srcCouldBeRemoved = false;
                for (let i = 0; i < elem.attributes.length; i++) {
                    const attr = elem.attributes[i];
                    if (attr.name === 'src') {
                        continue;
                    }

                    if (/\.(jpg|jpeg|png|webp)/i.test(attr.value)) {
                        srcCouldBeRemoved = true;
                        break;
                    }
                }

                // 编码前不足 100 字节（base64 编码后不足 133 个字符）的图视为占位图（库注释之意）
                if (srcCouldBeRemoved) {
                    const b64starts = parts[0].length;
                    const b64length = elem.src.length - b64starts;
                    if (b64length < 133) {
                        elem.removeAttribute('src');
                    }
                }
            }

            // 另判 "null"，以绕过 jsdom 的缺陷 https://github.com/jsdom/jsdom/issues/2580（库注释之意）
            if (
                (elem.src || (elem.srcset && elem.srcset != 'null'))
                && !elem.className.toLowerCase().includes('lazy')
            ) {
                return;
            }

            for (let j = 0; j < elem.attributes.length; j++) {
                const attr = elem.attributes[j];
                if (
                    attr.name === 'src'
                    || attr.name === 'srcset'
                    || attr.name === 'alt'
                ) {
                    continue;
                }
                let copyTo = null;
                if (/\.(jpg|jpeg|png|webp)\s+\d/.test(attr.value)) {
                    copyTo = 'srcset';
                } else if (isSingleImageToken(attr.value)) {
                    copyTo = 'src';
                }
                if (copyTo) {
                    // img 与 picture 直接设置该属性（库注释之意）
                    if (elem.tagName === 'IMG' || elem.tagName === 'PICTURE') {
                        elem.setAttribute(copyTo, attr.value);
                    } else if (
                        elem.tagName === 'FIGURE'
                        && !this._getAllNodesWithTag(elem, ['img', 'picture']).length
                    ) {
                        // 不含 img 与 picture 的 figure：新建一个 img 放进去，例见库的 nytimes-3 用例（库注释之意）
                        const img = this._doc.createElement('img');
                        img.setAttribute(copyTo, attr.value);
                        elem.appendChild(img);
                    }
                }
            }
        },
    );
}

// ---------- 三级：旧兜底链路 ----------

function extractByFallback($) {
    for (const tag of FALLBACK_TAGS) {
        const content = $(tag).first().html();
        if (content && content.trim()) return { html: content, extraction: `fallback:${tag}` };
    }

    const longest = longestDiv($);
    if (longest) return { html: longest, extraction: 'fallback:longest-div' };

    const body = $('body').html();
    if (body && body.trim()) return { html: body, extraction: 'fallback:body' };
    return { html: '', extraction: 'fallback:empty' };
}

function longestDiv($) {
    let best = '';
    let maxLength = 0;
    $('div').each((_, el) => {
        const text = $(el).text().trim();
        if (text.length > maxLength && text.length > MIN_CONTENT_TEXT_LENGTH) {
            maxLength = text.length;
            best = $(el).html();
        }
    });
    return best;
}

module.exports = {
    extractContent, matchesHost, annotateLayout,
    SITE_SELECTORS, MIN_READABILITY_TEXT_LENGTH, READERABLE_OPTIONS,
    inlineStyleValue, isNodeVisible, isProbablyVisible,
    isSingleImageToken, fixLazyImages,
};
