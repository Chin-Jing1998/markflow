/**
 * converters/web/dom.js 单元测试
 *
 * hasDescendantTag 与 cheerio 的 $(el).find(选择器).length > 0 在定种子随机森林上逐元素差分，另以显式用例
 * 覆盖 <template> 内容片段的两种可见性、搜索根只取元素子节点、<svg>／<math> 内的同名元素、<script>／<style>
 * 内形似标签的原始文本与注释。createTreeEditor 的 remove、unwrap、absorb 与 cheerio 原生写法在同一协议
 * （文档前序快照 + isAttached 跳过）下差分：处理每个元素之前核对两侧当前元素的指针与子树，flush 之后比较
 * $.html() 与逐节点的 parent／prev／next／children，并核对编辑器一侧整棵树结构自洽。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const cheerio = require('cheerio');
const { isElementNode, hasDescendantTag, createTreeEditor } = require('../converters/web/dom');
const { NESTED_BLOCK_TAGS } = require('../converters/web/indent');
const { isAttached } = require('../converters/web/noise');

// 不可见字符以码点生成，源码不出现看不见的字面量
const NBSP = String.fromCharCode(0x00a0);
const IDEO = String.fromCharCode(0x3000);

// ============================================================
// 随机森林
// ============================================================

// 定种子的 mulberry32 伪随机数：同一种子每次生成同一批树，用例失败可原样复现
function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const pick = (random, list) => list[Math.floor(random() * list.length)];

// 文本：空串、ASCII 空格、不换行空格、全角空格、可见字
const TEXTS = Object.freeze(['', ' ', NBSP, IDEO, '甲']);
// 注释：含形似标签的内容
const COMMENTS = Object.freeze(['<!--甲-->', '<!--<img>-->', '<!---->']);
// 空元素：不带结束标签，也不生成子节点
const VOID_TAGS = new Set(['img', 'br', 'embed', 'source']);
// 原始文本元素：内容不经 HTML 解析，只生成形似标签的文本
const RAW_TEXT_TAGS = new Set(['script', 'style', 'iframe']);
const RAW_TEXTS = Object.freeze(['', '甲', '<img src="x">', '<br>', '<p>甲</p>', 'a < b']);

/**
 * 随机森林的 HTML：顶层 1 到 maxRoots 个节点，每个元素 0 到 maxChildren 个子节点，深度至多 maxDepth；文本、
 * 注释与元素混排。sameTagChance 为「下一个兄弟沿用上一个元素的标签、中间不夹文本」的概率，用于造出相邻同名兄弟。
 * 顶层可有多个节点，加上 <template>，元素的父节点便覆盖载入根、元素与内容片段三种
 */
function randomForestHtml(random, { tags, maxDepth, maxChildren, maxRoots, sameTagChance = 0 }) {
    function element(tag, depth) {
        if (VOID_TAGS.has(tag)) return `<${tag}>`;
        if (RAW_TEXT_TAGS.has(tag)) return `<${tag}>${pick(random, RAW_TEXTS)}</${tag}>`;
        const count = depth <= 0 ? 0 : Math.floor(random() * (maxChildren + 1));
        return `<${tag}>${siblings(depth - 1, count)}</${tag}>`;
    }
    function siblings(depth, count) {
        let html = '';
        let previousTag = null;
        for (let index = 0; index < count; index += 1) {
            if (previousTag && random() < sameTagChance) {
                html += element(previousTag, depth);
                continue;
            }
            const roll = random();
            if (roll < 0.2) {
                html += pick(random, TEXTS);
                previousTag = null;
            } else if (roll < 0.25) {
                html += pick(random, COMMENTS);
                previousTag = null;
            } else {
                previousTag = pick(random, tags);
                html += element(previousTag, depth);
            }
        }
        return html;
    }
    return siblings(maxDepth, 1 + Math.floor(random() * maxRoots));
}

// ============================================================
// isElementNode
// ============================================================

test('isElementNode：元素（含 script、style）为真，文本、注释、template 内容片段与空值为假', () => {
    // Arrange
    const $ = cheerio.load('<div>甲<!--乙--><script>1</script><style>a{}</style><template><i></i></template></div>', null, false);
    const [text, comment, script, style, template] = $('div')[0].children;

    // Act & Assert
    assert.equal(isElementNode($('div')[0]), true);
    assert.equal(isElementNode(script), true, 'script 的 type 是 script 而非 tag，仍是元素');
    assert.equal(isElementNode(style), true, 'style 的 type 是 style 而非 tag，仍是元素');
    assert.equal(isElementNode(text), false);
    assert.equal(isElementNode(comment), false);
    assert.equal(isElementNode(template.children[0]), false, 'template 的内容片段 type 为 root，不是元素');
    assert.equal(isElementNode($.root()[0]), false, '载入根不是元素');
    assert.equal(isElementNode(null), false);
    assert.equal(isElementNode(undefined), false);
});

// ============================================================
// hasDescendantTag：与 .find() 逐字等价
// ============================================================

const CONTENT_DESCENDANT_TAGS = Object.freeze([
    'img', 'video', 'audio', 'iframe', 'table', 'embed', 'object', 'svg', 'canvas', 'picture', 'source',
]);
// 差分所用的标签名集合与等价的选择器串：单个标签、web/noise 的内容后代名单、web/indent 的嵌套块名单
const NAME_SETS = Object.freeze([['img'], ['br'], CONTENT_DESCENDANT_TAGS, NESTED_BLOCK_TAGS]
    .map((names) => ({ names: new Set(names), selector: names.join(', ') })));

const FIND_TREE_TAGS = Object.freeze([
    'img', 'br', 'video', 'audio', 'source', 'iframe', 'table', 'svg', 'math', 'template', 'script', 'style',
    'span', 'i', 'a', 'p', 'div', 'section', 'strong', 'li', 'ul', 'figure', 'h2', 'pre',
]);
const FIND_TREE_SEED = 20260923;
const FIND_TREE_COUNT = 6000;

// 统计口径的朴素参照：搜索根同为元素子节点，是否进入非元素节点（即 template 的内容片段）由参数决定
function naiveHasTag(el, names, enterFragments) {
    const visit = (node) => {
        if (isElementNode(node) && names.has(node.name)) return true;
        if (!isElementNode(node) && !enterFragments) return false;
        return (node.children || []).some(visit);
    };
    return (el.children || []).filter(isElementNode).some(visit);
}

function parentKindOf(el) {
    if (isElementNode(el.parent)) return 'element';
    return el.parent && el.parent.parent ? 'fragment' : 'root';
}

test('hasDescendantTag 与 .find() 逐字等价：定种子随机森林上每个元素、四组标签名集合的判定逐一相同', () => {
    // Arrange
    const random = seededRandom(FIND_TREE_SEED);
    const stats = { checks: 0, hits: 0, root: 0, element: 0, fragment: 0, hiddenInFragment: 0, visibleInFragment: 0 };

    for (let index = 0; index < FIND_TREE_COUNT; index += 1) {
        const html = randomForestHtml(random, { tags: FIND_TREE_TAGS, maxDepth: 3, maxChildren: 3, maxRoots: 3 });
        const $ = cheerio.load(html, null, false);

        // $('*') 会进入 template 的内容片段，片段内的元素同样逐个核对
        for (const el of $('*').toArray()) {
            const kind = parentKindOf(el);
            stats[kind] += 1;
            for (const { names, selector } of NAME_SETS) {
                // Act
                const expected = $(el).find(selector).length > 0;
                const actual = hasDescendantTag(el, names);

                // Assert
                assert.equal(actual, expected, `第 ${index} 棵树的 <${el.name}>（父节点：${kind}）对「${selector}」：${html}`);
                stats.checks += 1;
                if (expected) stats.hits += 1;
                // 只在内容片段里才有匹配的情形：父节点是元素时须判否，否则须判是
                if (naiveHasTag(el, names, true) && !naiveHasTag(el, names, false)) {
                    if (kind === 'element') stats.hiddenInFragment += 1;
                    else stats.visibleInFragment += 1;
                }
            }
        }
    }

    // Assert：核对面确实铺开了——判是、判否都有，三种父节点都出现，template 可见性的两种情形都被差分覆盖
    const misses = stats.checks - stats.hits;
    assert.ok(stats.hits > stats.checks / 20 && misses > stats.checks / 20, `判是、判否应各占二十分之一以上：${JSON.stringify(stats)}`);
    for (const key of ['root', 'element', 'fragment', 'hiddenInFragment', 'visibleInFragment']) {
        assert.ok(stats[key] > 0, `统计项 ${key} 应大于 0：${JSON.stringify(stats)}`);
    }
});

// 用例表中以 data-target 标出起点元素
function assertAgainstFind(cases) {
    for (const [html, names, expected, note] of cases) {
        const $ = cheerio.load(html, null, false);
        const el = $('[data-target]')[0];
        const selector = names.join(', ');
        assert.equal($(el).find(selector).length > 0, expected, `用例前提与 .find() 不符（${note}）：${html}`);
        assert.equal(hasDescendantTag(el, new Set(names)), expected, `${note}：${html}`);
    }
}

test('hasDescendantTag：template 内容片段可见与否取决于起点元素的父节点，template 自身作起点时恒为否', () => {
    // Arrange & Act & Assert：[HTML, 标签名, 期望, 说明]
    assertAgainstFind([
        ['<div data-target><template><img></template></div>', ['img'], true,
            '起点位于载入根之下：不加 :scope，domutils 的 find 穿过内容片段，片段里的元素照样命中'],
        ['<section><div data-target><template><img></template></div></section>', ['img'], false,
            '起点的父节点是元素：加 :scope 后代，后代组合子不跨内容片段，片段里的元素一律匹配不到'],
        ['<section><div data-target><span><template><p><img></p></template></span></div></section>', ['img'], false,
            '内容片段藏在更深的行内元素里同样匹配不到'],
        ['<template><div data-target><template><img></template></div></template>', ['img'], true,
            '起点本身位于内容片段之内：父节点不是元素，嵌套片段里的元素照样命中'],
        ['<template data-target><img></template>', ['img'], false,
            'template 唯一的子节点是内容片段，不是元素，不作搜索根'],
        ['<section><template data-target><img></template></section>', ['img'], false,
            'template 作起点、父节点是元素时同样为否'],
    ]);
});

test('hasDescendantTag：外来内容里的同名元素照样命中；script、style 的原始文本与注释不算元素；起点自身不参与匹配', () => {
    // Arrange & Act & Assert：[HTML, 标签名, 期望, 说明]
    assertAgainstFind([
        ['<div data-target><svg><video></video></svg></div>', ['video'], true, 'svg 里的 video 不在 breakout 列表中，留在外来命名空间，照样命中'],
        ['<p><span data-target><math><section></section></math></span></p>', NESTED_BLOCK_TAGS, true, 'math 里的 section 照样算嵌套块'],
        ['<div data-target><svg><circle></circle></svg></div>', ['video'], false, 'svg 里没有同名元素'],
        ['<div data-target><script>var html = "<img src=x>";</script></div>', ['img'], false, 'script 的内容是原始文本'],
        ['<div data-target><style>br { color: red; }</style></div>', ['br'], false, 'style 的内容同样是原始文本'],
        ['<div data-target><iframe><img></iframe></div>', ['img'], false, 'iframe 的内容同样是原始文本'],
        ['<div data-target><!--<img>--></div>', ['img'], false, '注释不是元素'],
        ['<div data-target>甲</div>', ['div'], false, '起点自身不参与匹配'],
        ['<div data-target><img></div>', ['img'], true, '元素子节点本身即搜索根'],
        ['<div><div data-target><span><em><img></em></span></div></div>', ['img'], true, '深层后代照样命中'],
        ['<div data-target><span>甲<i>乙</i></span></div>', CONTENT_DESCENDANT_TAGS, false, '只含行内后代'],
    ]);
});

// ============================================================
// createTreeEditor：结构核对工具
// ============================================================

// 从根出发逐层核对：每个子节点的 parent 指回父节点，prev / next 与 children 数组的相邻关系一致，根到叶不重复
function assertConsistent(root, label) {
    assert.ok(root.parent == null, `${label}：根节点不应有父节点`);
    const seen = new Set([root]);
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        const children = node.children || [];
        children.forEach((child, index) => {
            assert.ok(!seen.has(child), `${label}：同一节点在树中出现两次`);
            seen.add(child);
            assert.ok(child.parent === node, `${label}：子节点的 parent 未指回父节点`);
            assert.ok(child.prev === (index > 0 ? children[index - 1] : null), `${label}：prev 与 children 数组不一致`);
            assert.ok(child.next === (index + 1 < children.length ? children[index + 1] : null), `${label}：next 与 children 数组不一致`);
            stack.push(child);
        });
    }
}

// 按前序给整棵树的每个节点编号（含文本、注释与 template 的内容片段）：同一 HTML 载入两份，编号一一对应
function indexNodes(root) {
    const ids = new Map();
    const order = [];
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        ids.set(node, order.length);
        order.push(node);
        const children = node.children || [];
        for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
    }
    return { ids, order };
}

// 节点的指针与子节点折成编号。null 与 undefined 同记为 null：原生 append 在 source 无子节点时会把
// target 末子节点的 next 置为 undefined，编辑器保持 null，二者渲染与判定结果相同
function shapeOf(ids, node) {
    const idOf = (other) => (other == null ? null : (ids.has(other) ? ids.get(other) : -1));
    return [idOf(node.parent), idOf(node.prev), idOf(node.next), node.children ? node.children.map(idOf) : null];
}

// ============================================================
// createTreeEditor：显式用例
// ============================================================

test('createTreeEditor：remove 立即互连前后兄弟、保留被删节点的子树，父节点数组待 flush 才压实', () => {
    // Arrange
    const $ = cheerio.load('<p>甲<span>乙<i>丙</i></span><em>丁</em></p>', null, false);
    const p = $('p')[0];
    const [text, span, em] = p.children;
    const editor = createTreeEditor();

    // Act
    editor.remove(span);

    // Assert：指针层面立即生效
    assert.ok(text.next === em && em.prev === text, '前后兄弟应立即互连');
    assert.ok(span.parent === null && span.prev === null && span.next === null, '被删节点的 parent、prev、next 应置 null');
    assert.equal(span.children.length, 2, '被删节点的子树应保留');
    assert.equal(p.children.length, 3, 'flush 之前父节点数组仍含失效项');

    // Act
    editor.flush();

    // Assert
    assert.ok(p.children.length === 2 && p.children[0] === text && p.children[1] === em, 'flush 之后父节点数组应压实');
    assert.equal($.html(), '<p>甲<em>丁</em></p>');
});

test('createTreeEditor：unwrap 让子节点按原序占据原位，嵌套拆包与拆包后再删除在 flush 时一并展开', () => {
    // Arrange
    const $ = cheerio.load('<p>甲<span>乙<a><br>丙</a><i>丁</i></span>戊</p>', null, false);
    const p = $('p')[0];
    const span = $('span')[0];
    const [second, anchor, italic] = span.children;
    const [br, third] = anchor.children;
    const editor = createTreeEditor();

    // Act：按前序先拆外层 span，再拆其原子节点 a，再删其原子节点 i
    editor.unwrap(span);

    // Assert：子节点立即改挂到原父节点，并与两侧兄弟相连
    assert.ok(second.parent === p && anchor.parent === p && italic.parent === p, '子节点的 parent 应改为原父节点');
    assert.ok(p.children[0].next === second && second.prev === p.children[0], '首个子节点应与左侧兄弟相连');
    assert.ok(italic.next === p.children[2] && p.children[2].prev === italic, '末个子节点应与右侧兄弟相连');
    assert.ok(span.children.length === 0 && span.parent === null && span.prev === null && span.next === null, '拆包节点应清空子节点并脱离');

    // Act
    editor.unwrap(anchor);
    editor.remove(italic);

    // Assert
    assert.ok(br.parent === p && third.parent === p && second.next === br && third.next.data === '戊', '嵌套拆包后指针应连贯');

    // Act
    editor.flush();

    // Assert
    assert.equal($.html(), '<p>甲乙<br>丙戊</p>');
    assert.deepEqual(p.children.map((node) => node.data || node.name), ['甲', '乙', 'br', '丙', '戊']);
    assertConsistent($.root()[0], '显式用例');
});

test('createTreeEditor：absorb 把后继兄弟的子节点按原序并入，source 或 target 无子节点时指针照样自洽', () => {
    // Arrange
    const $ = cheerio.load('<p><strong>甲</strong><strong>乙<i>丙</i></strong><strong></strong>丁<em></em><em>戊</em></p>', null, false);
    const [first, second, third, , emptyEm, fullEm] = $('p')[0].children;
    const editor = createTreeEditor();

    // Act
    editor.absorb(first, second);
    editor.absorb(first, third);
    editor.absorb(emptyEm, fullEm);

    // Assert：并入的子节点改挂到 target，首尾与 target 原有子节点相连，末尾 next 为 null
    assert.deepEqual(first.children.map((node) => node.data || node.name), ['甲', '乙', 'i']);
    assert.ok(first.children.every((node) => node.parent === first), '并入的子节点 parent 应为 target');
    assert.ok(first.children[0].next === first.children[1] && first.children[1].prev === first.children[0], '原末子节点应与并入的首个子节点相连');
    assert.ok(first.children[2].next === null, '并入空 source 之后末子节点的 next 仍为 null');
    assert.ok(second.children.length === 0 && second.parent === null, 'source 应清空子节点并脱离');
    assert.ok(emptyEm.children.length === 1 && emptyEm.children[0].prev === null && emptyEm.children[0].next === null, '空 target 并入后首子节点的 prev 为 null');

    // Act
    editor.flush();

    // Assert
    assert.equal($.html(), '<p><strong>甲乙<i>丙</i></strong>丁<em>戊</em></p>');
    assertConsistent($.root()[0], '显式用例');
});

// ============================================================
// createTreeEditor：与原生写法的随机差分
// ============================================================

const NATIVE_OPS = Object.freeze({
    remove: ($, el) => $(el).remove(),
    unwrap: ($, el) => $(el).replaceWith($(el).contents()),
    absorb: ($, target, source) => {
        $(target).append($(source).contents());
        $(source).remove();
    },
});

/**
 * 同一 HTML 载入两份，按「文档前序快照 + isAttached 跳过」的协议逐个元素处理：一份用 cheerio 原生写法，一份用
 * 编辑器。choose(el) 依原生一侧的当前状态返回 'remove'、'unwrap'、'absorb' 或 null（跳过），两侧照做；
 * 'absorb' 表示只要后继兄弟是同名元素就并入。返回本棵树各操作的次数
 */
function runEditorDifferential(html, choose, label) {
    const $native = cheerio.load(html, null, false);
    const $edited = cheerio.load(html, null, false);
    const nativeIndex = indexNodes($native.root()[0]);
    const editedIndex = indexNodes($edited.root()[0]);
    const nativeElements = $native('*').toArray();
    const editedElements = $edited('*').toArray();
    assert.equal(editedElements.length, nativeElements.length, label);
    const editor = createTreeEditor();
    const counts = { remove: 0, unwrap: 0, absorb: 0 };
    const sameShape = (el, twin, at) => assert.deepEqual(
        shapeOf(editedIndex.ids, twin), shapeOf(nativeIndex.ids, el), `${label}，快照第 ${at} 个元素 <${el.name}>`);

    nativeElements.forEach((el, at) => {
        const twin = editedElements[at];
        const attached = isAttached(el);
        assert.equal(isAttached(twin), attached, `${label}，快照第 ${at} 个元素的在树判定`);
        if (!attached) return;
        // 处理前核对：当前元素的父、兄弟指针与子节点两侧一致，其子树文本也一致（flush 之前读到的是真实结构）
        sameShape(el, twin, at);
        assert.equal($edited(twin).text(), $native(el).text(), `${label}，快照第 ${at} 个元素的文本`);

        const op = choose(el);
        if (op === 'remove' || op === 'unwrap') {
            NATIVE_OPS[op]($native, el);
            editor[op](twin);
            counts[op] += 1;
        } else if (op === 'absorb') {
            while (isElementNode(el.next) && el.next.name === el.name) {
                NATIVE_OPS.absorb($native, el, el.next);
                editor.absorb(twin, twin.next);
                counts.absorb += 1;
                sameShape(el, twin, at);
            }
        }
    });
    editor.flush();

    // Assert：渲染结果逐字相同，逐节点的 parent / prev / next / children 一致（含已脱离的节点），编辑器一侧结构自洽
    assert.equal($edited.html(), $native.html(), label);
    nativeIndex.order.forEach((node, id) => {
        assert.deepEqual(shapeOf(editedIndex.ids, editedIndex.order[id]), shapeOf(nativeIndex.ids, node), `${label}，第 ${id} 号节点`);
    });
    assertConsistent($edited.root()[0], label);
    return counts;
}

const EDITOR_TREE_COUNT = 6000;
const EDITOR_TREE_TAGS = Object.freeze([
    'p', 'div', 'section', 'li', 'span', 'a', 'i', 'strong', 'br', 'img', 'table', 'template', 'svg', 'math', 'script', 'style',
]);
// absorb 只并入相邻同名兄弟，故字母表收窄、并以 sameTagChance 造出相邻同名的元素
const ABSORB_TREE_TAGS = Object.freeze(['strong', 'span', 'i', 'a', 'p', 'li', 'div', 'br', 'img', 'template', 'svg', 'script']);

// 逐棵生成并差分，汇总各操作次数与发生改动的树数
function runEditorForest({ seed, tags, sameTagChance, choose }) {
    const random = seededRandom(seed);
    const totals = { remove: 0, unwrap: 0, absorb: 0, changedTrees: 0 };
    for (let index = 0; index < EDITOR_TREE_COUNT; index += 1) {
        const html = randomForestHtml(random, { tags, maxDepth: 3, maxChildren: 4, maxRoots: 3, sameTagChance });
        const counts = runEditorDifferential(html, (el) => choose(random, el), `第 ${index} 棵树：${html}`);
        totals.remove += counts.remove;
        totals.unwrap += counts.unwrap;
        totals.absorb += counts.absorb;
        if (counts.remove + counts.unwrap + counts.absorb > 0) totals.changedTrees += 1;
    }
    return totals;
}

test('createTreeEditor 与原生写法逐节点一致：定种子随机森林上按前序逐个 remove 或 unwrap', () => {
    // Arrange：约三成删除、三成拆包（仅限有子节点者）、其余跳过
    const choose = (random, el) => {
        const roll = random();
        if (roll < 0.3) return 'remove';
        if (roll < 0.6 && el.children.length > 0) return 'unwrap';
        return null;
    };

    // Act & Assert：差分断言在 runEditorDifferential 内
    const totals = runEditorForest({ seed: 20260924, tags: EDITOR_TREE_TAGS, sameTagChance: 0, choose });

    // Assert：核对面确实铺开了
    assert.ok(totals.changedTrees > EDITOR_TREE_COUNT / 2, `发生改动的树应过半：${JSON.stringify(totals)}`);
    assert.ok(totals.remove > EDITOR_TREE_COUNT && totals.unwrap > EDITOR_TREE_COUNT / 2,
        `删除次数应多于树数、拆包次数应多于树数的一半：${JSON.stringify(totals)}`);
});

test('createTreeEditor 与原生写法逐节点一致：定种子随机森林上逐个 absorb 相邻同名兄弟', () => {
    // Act & Assert
    const totals = runEditorForest({ seed: 20260925, tags: ABSORB_TREE_TAGS, sameTagChance: 0.5, choose: () => 'absorb' });

    // Assert
    assert.ok(totals.changedTrees > EDITOR_TREE_COUNT / 2, `发生并入的树应过半：${JSON.stringify(totals)}`);
});

test('createTreeEditor 与原生写法逐节点一致：同一批次混用 remove、unwrap 与 absorb', () => {
    // Arrange：拆包之后原子节点改挂到原父节点，其后的并入与删除须在 flush 时与展开正确交织
    const choose = (random, el) => {
        const roll = random();
        if (roll < 0.2) return 'remove';
        if (roll < 0.45 && el.children.length > 0) return 'unwrap';
        if (roll < 0.75) return 'absorb';
        return null;
    };

    // Act & Assert
    const totals = runEditorForest({ seed: 20260926, tags: ABSORB_TREE_TAGS, sameTagChance: 0.4, choose });

    // Assert
    assert.ok(totals.changedTrees > EDITOR_TREE_COUNT / 2, `发生改动的树应过半：${JSON.stringify(totals)}`);
    assert.ok(totals.remove > 0 && totals.unwrap > 0 && totals.absorb > 0, `三种操作都应发生：${JSON.stringify(totals)}`);
});
