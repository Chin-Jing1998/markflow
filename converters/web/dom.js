/**
 * cheerio 节点树的线性工具（供逐元素清洗 DOM 的模块共用，现由 web/noise 的空元素清理使用）
 *
 * 动机：网页正文属不可信输入，而 cheerio 1.2.0 的三项常用操作在「同一父节点下大量子节点」时是平方级的：
 *   - $(el).find(sel) 把 el 的全部元素子节点作搜索根交给 css-select 的 prepareContext，其中 domutils 的
 *     removeSubsets 对这组根逐个做 lastIndexOf / includes，子元素 n 个即 O(n²)；
 *   - $(node).remove() 经 domutils 的 removeElement 在父节点 children 上做 lastIndexOf + splice，
 *     逐个删除同一父节点下的 n 个子节点即 O(n²)；
 *   - $(node).replaceWith($(node).contents()) 先对每个子节点调 removeElement（k 个子节点即 O(k²)），
 *     再在父节点 children 上做 indexOf + splice。
 *
 *   isElementNode(node)          是否元素节点（含 <script>、<style>），以 attribs 是否存在判定
 *   hasDescendantTag(el, names)  el 是否含标签名属于 names（小写标签名的 Set）的后代，与
 *                                $(el).find(由 names 组成的选择器).length > 0 逐字等价；命中即停，耗时线性于 el 的子树
 *   createTreeEditor()           批量改树：remove / unwrap / absorb 的指针层面立即生效，父节点 children 数组里的
 *                                失效项推迟到 flush 一次压实，一批改动的总耗时线性于所涉节点数；
 *                                与 cheerio 原生写法的对应关系及调用方须遵守的安全性前提见该函数注释
 */

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

module.exports = { isElementNode, hasDescendantTag, createTreeEditor };
