/**
 * cheerio 节点树的线性工具（供 web/noise 与 parsers/url 逐元素清洗 DOM 时共用）
 *
 * 动机：网页正文属不可信输入，而 cheerio 1.2.0 的五项常用操作在「同一父节点下大量子节点」时是平方级的：
 *   - $(el).find(sel) 把 el 的全部元素子节点作搜索根交给 css-select 的 prepareContext，其中 domutils 的
 *     removeSubsets 对这组根逐个做 lastIndexOf / includes，子元素 n 个即 O(n²)；
 *   - $(node).remove() 经 domutils 的 removeElement 在父节点 children 上做 lastIndexOf + splice，
 *     逐个删除同一父节点下的 n 个子节点即 O(n²)；
 *   - $(node).replaceWith($(node).contents()) 先对每个子节点调 removeElement（k 个子节点即 O(k²)），
 *     再在父节点 children 上做 indexOf + splice；
 *   - cheerio.load(html, null, false) 经 parse5 的 getFragment 把顶层子节点逐个 detachNode（indexOf + splice）
 *     迁入片段根，顶层节点 n 个即 O(n²)；
 *   - 根级查询 $(sel) 以载入根的全部元素子节点作搜索根，同样经 removeSubsets，顶层元素 n 个即 O(n²)。
 *
 *   isElementNode(node)          是否元素节点（含 <script>、<style>），以 attribs 是否存在判定
 *   hasDescendantTag(el, names)  el 是否含标签名属于 names（小写标签名的 Set）的后代，与
 *                                $(el).find(由 names 组成的选择器).length > 0 逐字等价；命中即停，耗时线性于 el 的子树
 *   createTreeEditor()           批量改树：remove / unwrap / absorb 的指针层面立即生效，父节点 children 数组里的
 *                                失效项推迟到 flush 一次压实，一批改动的总耗时线性于所涉节点数；
 *                                与 cheerio 原生写法的对应关系及调用方须遵守的安全性前提见该函数注释
 *   loadFragment(html)           片段载入，与 cheerio.load(html, null, false) 逐字等价，耗时线性于输入
 *   selectElements($, predicate) 根级查询：从载入根前序遍历、收集满足 predicate 的元素，与根级 $(选择器) 逐节点同序，
 *                                耗时线性于树的大小；predicate 须与该选择器逐元素同值
 *   selectByTags($, selector)    selectElements 的标签名版本：selector 为逗号分隔的小写标签名串，与 $(selector) 逐节点同序
 */
const { createRequire } = require('node:module');
const cheerio = require('cheerio');

// parse5 与 htmlparser2 树适配器是 cheerio 的间接依赖，按 cheerio 自身的解析路径加载，保证与 cheerio.load 用的是同一份
// 模块实例（同一份 Parser、同一份 adapter）
const requireFromCheerio = createRequire(require.resolve('cheerio'));
const { Parser } = requireFromCheerio('parse5');
const { adapter: htmlparser2Adapter } = requireFromCheerio('parse5-htmlparser2-tree-adapter');

// selectByTags 只认的标签名：小写字母开头，其后为小写字母、数字或连字符
const TAG_NAME_RE = /^[a-z][a-z0-9-]*$/;

// 元素节点的判定：<script>、<style> 的 type 不是 'tag'，故以 attribs 是否存在为准；文本、注释与
// <template> 的内容片段（type 为 'root'）都没有 attribs
function isElementNode(node) {
    return Boolean(node && node.attribs);
}

/**
 * el 是否含标签名属于 names 的后代。语义等价于 $(el).find(由 names 组成的选择器).length > 0，但命中即停、
 * 显式栈遍历（不递归，深层嵌套不爆栈），耗时线性于 el 的子树大小
 *
 * 与 .find() 逐字等价的五条依据，均以 cheerio 1.2.0 的源码与实测行为为准而非直觉：
 *   - 搜索根只取 el 的元素子节点：.find() 以 this.children()（按 domhandler 的 isTag 过滤）为搜索根，el 自身
 *     不参与匹配，其直接子节点中的文本、注释与 <template> 的内容片段都不作搜索根——故 el 为 <template> 时
 *     结果恒为 false（它唯一的子节点就是内容片段）
 *   - 元素以 attribs 是否存在判定：<script>、<style> 的 type 分别是 'script'、'style' 而非 'tag'，
 *     domhandler 的 isTag 同样把三者都算元素；文本、注释与内容片段没有 attribs
 *   - 只比对标签名、不看命名空间：css-select 的标签匹配就是名字相等（选择器一侧先转小写，故 names 须为小写），
 *     <svg>、<math> 里与 names 同名的元素照样命中（不在 HTML 规范 breakout 列表中的标签会留在外来命名空间内）
 *   - 注释没有子节点，<script>、<style> 的子节点只有原始文本，其中形似标签的字符不构成元素，进去也匹配不到，
 *     不必单独排除
 *   - <template> 的内容被 parse5 放进一个 type 为 'root' 的非元素子节点，其中的元素可见与否取决于 el 的父节点：
 *     父节点是元素时，css-select 的 absolutize 给选择器加上 :scope 后代，而后代组合子的 getElementParent
 *     不跨非元素节点，片段内的元素一律匹配不到；父节点不是元素（载入根，或 el 本身位于某个内容片段之内）时
 *     不加 :scope，退化为纯标签匹配，domutils 的 find 穿过片段、其中的元素照样命中。
 *     这是 cheerio 自身的不一致，此处照搬以保持结果逐字不变
 *
 * @param {object} el 起点节点（domhandler 节点）
 * @param {Set<string>} names 小写标签名集合
 * @returns {boolean}
 */
function hasDescendantTag(el, names) {
    const shouldEnterFragments = !isElementNode(el.parent);
    const stack = [];
    // 逐个 push 而非展开传参：子节点上万时 push(...children) 会超出实参个数上限
    for (const child of el.children || []) {
        if (isElementNode(child)) stack.push(child);
    }
    while (stack.length > 0) {
        const node = stack.pop();
        const isElement = isElementNode(node);
        if (isElement && names.has(node.name)) return true;
        if (!isElement && !shouldEnterFragments) continue;
        for (const child of node.children || []) stack.push(child);
    }
    return false;
}

/**
 * 批量改树。各操作的结果与 cheerio 原生写法逐一对应：
 *   remove(node)            ≡ $(node).remove()：前后兄弟互连，node 的 parent / prev / next 置 null，其子树保留
 *   unwrap(node)            ≡ $(node).replaceWith($(node).contents())：node 的全部子节点（文本、注释、元素）按原序
 *                             占据 node 的位置，parent 指向原父节点、prev / next 与两侧兄弟相连；node.children
 *                             变为空数组，node 的 parent / prev / next 置 null
 *   absorb(target, source)  ≡ $(target).append($(source).contents()); $(source).remove()：source 的子节点按原序
 *                             追加到 target 末尾，source 随后按 remove 处理（供合并相邻同名元素，source 为
 *                             target 的后继兄弟）
 *   flush()                 压实本批次涉及的各父节点的 children 数组，并按数组重写其中各节点的 prev / next；
 *                           之后内部记录清空，同一编辑器可接着用于下一批
 *
 * 指针层面（parent、prev、next，以及 unwrap 时 node 的 children、absorb 时 target 与 source 的 children）立即生效，
 * 故沿 parent 上溯（如 isAttached）、沿 prev / next 走兄弟的读取在 flush 之前就是准确的；父节点 children 数组里的
 * 失效项（已删除、已移走或已拆包的节点）推迟到 flush 一次清理：已删除、已移走的跳过，已拆包的就地展开为其
 * 拆包前的子节点（可嵌套）。
 *
 * 安全性前提（调用方负责）：按文档前序处理一份元素快照、每次只改当前元素（remove / unwrap 当前元素，或 absorb
 * 当前元素与其后继兄弟），每批结束即 flush。前序遍历中祖先先于后代，先处理者的子树与当前元素的子树互不相交，
 * 故处理某元素时其子树从未被本批次改动：途中读取当前元素子树（.text()、hasDescendantTag、children）拿到的都是
 * 真实结构，absorb 时 target 的 children 数组末项也就是真实的末子节点。祖先与先前兄弟所在父节点的 children
 * 数组在 flush 之前含失效项，但前序遍历中不会再被读取；flush 之前也不得经 cheerio 读写这些父节点
 * （$.html()、.contents()、.children()、.remove() 等）。
 */
function createTreeEditor() {
    // 待压实的父节点：其 children 数组可能含失效项
    const dirtyParents = new Set();
    // 已拆包节点 → 其拆包前的子节点数组（flush 时就地展开）
    const unwrappedChildren = new Map();

    function remove(node) {
        const { parent, prev, next } = node;
        if (prev) prev.next = next;
        if (next) next.prev = prev;
        if (parent) dirtyParents.add(parent);
        node.parent = null;
        node.prev = null;
        node.next = null;
    }

    function unwrap(node) {
        const { parent, prev, next } = node;
        // 与 replaceWith 一致：没有父节点时什么也不做
        if (!parent) return;
        const children = node.children || [];
        // 不可达：调用方只拆含子节点的元素（removeEmptyElements 只在含 <br> 后代时拆包）。原生写法此时会把两侧兄弟的
        // next / prev 置为 undefined（uniqueSplice 以空数组的首、末项赋值），这里按 remove 处理、让两侧兄弟互连
        if (children.length === 0) {
            remove(node);
            return;
        }
        const first = children[0];
        const last = children[children.length - 1];
        for (const child of children) child.parent = parent;
        first.prev = prev;
        last.next = next;
        if (prev) prev.next = first;
        if (next) next.prev = last;
        unwrappedChildren.set(node, children);
        dirtyParents.add(parent);
        node.children = [];
        node.parent = null;
        node.prev = null;
        node.next = null;
    }

    function absorb(target, source) {
        const kids = target.children;
        let tail = kids.length > 0 ? kids[kids.length - 1] : null;
        // source 无子节点时原生 append 会把 target 末子节点的 next 置为 undefined，这里保持 null；二者渲染结果相同
        for (const child of source.children || []) {
            child.parent = target;
            child.prev = tail;
            if (tail) tail.next = child;
            kids.push(child);
            tail = child;
        }
        if (tail) tail.next = null;
        source.children = [];
        remove(source);
    }

    function flush() {
        for (const parent of dirtyParents) {
            const kids = parent.children;
            const stale = kids.slice();
            kids.length = 0;
            // 显式栈展开（不递归）：数组栈与下标栈同步进出，保持文档顺序
            const arrays = [stale];
            const offsets = [0];
            while (arrays.length > 0) {
                const top = arrays.length - 1;
                if (offsets[top] >= arrays[top].length) {
                    arrays.pop();
                    offsets.pop();
                    continue;
                }
                const node = arrays[top][offsets[top]];
                offsets[top] += 1;
                if (node.parent === parent) {
                    kids.push(node);
                } else if (unwrappedChildren.has(node)) {
                    arrays.push(unwrappedChildren.get(node));
                    offsets.push(0);
                }
            }
            for (let index = 0; index < kids.length; index += 1) {
                kids[index].prev = index > 0 ? kids[index - 1] : null;
                kids[index].next = index + 1 < kids.length ? kids[index + 1] : null;
            }
        }
        dirtyParents.clear();
        unwrappedChildren.clear();
    }

    return { remove, unwrap, absorb, flush };
}

/**
 * 片段载入。与 cheerio.load(html, null, false) 逐字等价：DOM 逐节点相同（含 parent / prev / next 链），$.html() 逐字相同，
 * 解析出错时抛出同一类型、同一消息的错误；耗时线性于输入。html 不是字符串时（Buffer、既有节点等）原样交给 cheerio.load
 *
 * 平方级的病因：cheerio 1.2.0 的片段模式调 parse5 7.3.0 的 parseFragment，即 Parser.getFragmentParser(null, options)
 * → parser.tokenizer.write(html, true) → parser.getFragment()。getFragment 取临时根（getFragmentParser 插入的假 <html>，
 * 挂在充当文档的 documentmock 元素下）后，以 _adoptNodes 把它的子节点逐个 detachNode 再 appendChild 迁入新建的片段根；
 * htmlparser2 树适配器的 detachNode 是 children.indexOf + splice(idx, 1)，每次摘下首项、挪动其余全部数组项，顶层 n 个
 * 节点即 O(n²)——16 万个顶层节点时载入本机实测 11.8–14.8 秒，detachNode 自耗时近九成。V8 的 shift() 对大数组同样
 * 逐项挪动（16 万项逐个 shift 本机实测 10.6–12.6 秒），换成以 shift 摘首项的自定义适配器也救不了，只能整体替换
 * 最后这一步的搬移
 *
 * 做法：以与 cheerio 相同的参数复刻前两步。cheerio 的 parseWithParse5 把自身的选项对象交给 parse5，只补 treeAdapter
 * （htmlparser2 适配器）与 scriptingEnabled: true；cheerio.load(html, null, false) 的选项里 sourceCodeLocationInfo、
 * onParseError 都未设置，parse5 取默认值。第三步改为把临时根的 children 数组整体挂到 createDocumentFragment() 新建的
 * 片段根上（逐个改 parent，临时根的 children 置空），再交给 cheerio.load——它收到 Document 时原样作根（cheerio 的
 * getParse），cheerio 自己的流式载入也是先由 parse5 建好文档、再这样交给 load
 *
 * 整体挂接与 _adoptNodes 结果相同：解析过程完全一致，差别只在最后的搬移。_adoptNodes 按原序把子节点逐个追加到空的
 * 片段根：detachNode 先把被移节点的 prev / next 置 null，appendChild 再让它与前一个追加的节点互连，终态是 children
 * 顺序不变、parent 指向片段根、首项的 prev 与末项的 next 为 null、相邻项互连——正是这些节点在临时根下原有的链接
 * （树适配器的 appendChild、insertBefore、detachNode 始终维持这一不变式），故整体挂接只需改 parent。临时根与
 * documentmock 随后被丢弃，两条路径都不再触及
 *
 * 所依赖的接口：parse5 的公开导出 Parser 及其静态方法 getFragmentParser、解析器实例的 tokenizer.write（parse5 的
 * parseFragment 自身就由这三步实现）；树适配器的 getFirstChild、createDocumentFragment，以及 domhandler 节点的
 * children / parent 字段。cheerio 升级 parse5 或树适配器时，由 test/web-dom.test.js 的差分用例把关（对抗样例、
 * 定种子随机记号串及其往返串、微信夹具上逐节点、逐字比对，含两侧抛错一致）
 *
 * @param {string} html 片段 HTML
 * @returns {import('cheerio').CheerioAPI}
 */
function loadFragment(html) {
    if (typeof html !== 'string') return cheerio.load(html, null, false);
    const parser = Parser.getFragmentParser(null, { treeAdapter: htmlparser2Adapter, scriptingEnabled: true });
    parser.tokenizer.write(html, true);
    const temporaryRoot = htmlparser2Adapter.getFirstChild(parser.document);
    const fragment = htmlparser2Adapter.createDocumentFragment();
    const children = temporaryRoot.children;
    for (const child of children) child.parent = fragment;
    fragment.children = children;
    temporaryRoot.children = [];
    return cheerio.load(fragment, null, false);
}

/**
 * 根级查询：从载入根起前序遍历（显式栈，不递归），进入一切带子节点的节点（含 template 的内容片段），收集 predicate
 * 为真的元素，返回 $(元素数组)，调用方可照旧 .each。与根级 $(选择器) 逐节点、同序等价，耗时线性于树的大小；
 * 根级 $() 以载入根的全部元素子节点作搜索根，css-select 的 prepareContext 经 domutils 的 removeSubsets 对这组根
 * 逐个做 lastIndexOf / includes，顶层元素 n 个即 O(n²)（4 万个时每次约 1 秒）
 *
 * 与 $(选择器) 逐节点同序的依据，均以 cheerio 1.2.0 及其 cheerio-select、css-select、domutils 的源码与实测为准：
 *   - 搜索根：$(sel) 即载入根上的 .find(sel)，以载入根的元素子节点为搜索根；载入根不是元素，css-select 不给选择器加
 *     :scope，对每个节点单独测试（同 hasDescendantTag 注释中「父节点不是元素」的情形）
 *   - 遍历：domutils 的 find 前序遍历搜索根及其后代，凡 children 非空的节点都进入（含 template 的内容片段），测试条件
 *     为 isTag（type 为 tag、script、style）且选择器匹配；这里以 attribs 是否存在判定元素，二者一致。载入根的非元素
 *     子节点（文本、注释、指令）没有子节点，故从载入根的全部子节点出发与只从其元素子节点出发结果相同
 *   - 顺序：不含位置伪类的选择器（逗号分隔的多个也一样）并为一次查找，结果不经 uniqueSort，即遍历顺序（文档序）；
 *     predicate 只读不改，遍历途中树不变
 *   - predicate 须与选择器逐元素同值：标签选择器只比标签名（选择器一侧先转小写，不看命名空间），见 selectByTags；
 *     属性存在选择器 [name] 为 attribs 的自有属性且值不为 null（domutils 的 hasAttrib）
 *
 * @param {import('cheerio').CheerioAPI} $ 载入结果
 * @param {(el: object) => boolean} predicate 元素谓词，只读
 * @returns {import('cheerio').Cheerio} 按文档序排列的元素
 */
function selectElements($, predicate) {
    const found = [];
    // 数组栈与下标栈同步进出：栈顶是正在走的兄弟数组及走到的位置，子节点数组先于其余兄弟走完，即前序
    const arrays = [$.root()[0].children];
    const offsets = [0];
    while (arrays.length > 0) {
        const top = arrays.length - 1;
        if (offsets[top] >= arrays[top].length) {
            arrays.pop();
            offsets.pop();
            continue;
        }
        const node = arrays[top][offsets[top]];
        offsets[top] += 1;
        if (isElementNode(node) && predicate(node)) found.push(node);
        if (node.children && node.children.length > 0) {
            arrays.push(node.children);
            offsets.push(0);
        }
    }
    return $(found);
}

/**
 * 按标签名的根级查询，与 $(selector) 逐节点同序。selector 为逗号分隔的小写标签名串（如 'span, b'），拆成集合后逐元素
 * 比对标签名，不看命名空间，与 css-select 的标签选择器一致。遇到不是纯标签名的片段（属性、类、组合子、伪类、通配符、
 * 大写名或空片段）即抛错：交给按名比对会静默错配，大写名在 css-select 里会先转小写，这里不代为转换
 *
 * @param {import('cheerio').CheerioAPI} $ 载入结果
 * @param {string} selector 逗号分隔的小写标签名串
 * @returns {import('cheerio').Cheerio} 按文档序排列的元素
 */
function selectByTags($, selector) {
    if (typeof selector !== 'string') {
        throw new TypeError(`selectByTags 的选择器须为字符串，实际为 ${typeof selector}`);
    }
    const names = new Set();
    for (const piece of selector.split(',')) {
        const name = piece.trim();
        if (!TAG_NAME_RE.test(name)) {
            throw new Error(`selectByTags 只接受逗号分隔的小写标签名，${JSON.stringify(selector)} 中的片段 ${JSON.stringify(name)} 不是`);
        }
        names.add(name);
    }
    return selectElements($, (el) => names.has(el.name));
}

module.exports = { isElementNode, hasDescendantTag, createTreeEditor, loadFragment, selectElements, selectByTags };
