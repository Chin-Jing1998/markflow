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

// ============================================================
// loadFragment：与 cheerio.load(html, null, false) 逐字等价
// ============================================================

const fs = require('node:fs');
const path = require('node:path');
const { loadFragment, selectElements, selectByTags } = require('../converters/web/dom');
const { hasClassOrId } = require('../converters/web/noise');
const { LEAF_BLOCK_SELECTOR } = require('../converters/web/indent');

// 以码点生成字符：BOM、NULL、不换行空格、代理项，以及换行、制表、回车之外的控制字符一律经此生成，源码不出现不可见字面量
const ch = String.fromCharCode;

// 节点的可比内容：类型、标签名、命名空间、属性（含键序）及其命名空间与前缀、文本与注释的内容、指令的各字段
function describeNode(node) {
    const stringified = (record) => (record ? Object.entries(record).map(([key, value]) => [key, String(value)]) : null);
    switch (node.type) {
        case 'tag':
        case 'script':
        case 'style':
            return [node.type, node.name, node.namespace, Object.entries(node.attribs),
                stringified(node['x-attribsNamespace']), stringified(node['x-attribsPrefix'])];
        case 'text':
        case 'comment':
            return [node.type, node.data];
        case 'directive':
            return [node.type, node.name, node.data, node['x-name'], node['x-publicId'], node['x-systemId']];
        case 'root':
            return [node.type, String(node['x-mode'])];
        default:
            return [node.type];
    }
}

// 规范化树转储：按前序逐节点记下可比内容、子节点数，以及 parent / prev / next 折成的前序编号（null 与 undefined 分记，
// 指向树外的节点记为 outside），递归全部子节点（含 template 的内容片段）。两棵树的转储逐字相同，即逐节点同构、同值、同链接
function treeSnapshot(root) {
    const { ids, order } = indexNodes(root);
    const idOf = (other) => {
        if (other === null || other === undefined) return String(other);
        return ids.has(other) ? ids.get(other) : 'outside';
    };
    return order.map((node) => JSON.stringify([
        ...describeNode(node), node.children ? node.children.length : -1, idOf(node.parent), idOf(node.prev), idOf(node.next),
    ])).join('\n');
}

/**
 * 同一输入分别经 loadFragment 与 cheerio.load(html, null, false) 载入：比对规范化树转储与 $.html()，并核对 loadFragment
 * 一侧整棵树的 parent / prev / next 链。原生载入抛错时 loadFragment 须抛出同一类型、同一消息的错误。
 * 返回 true 表示两侧同样抛错
 */
function assertFragmentEquivalent(html, label) {
    let expected = null;
    let expectedError = null;
    try {
        expected = cheerio.load(html, null, false);
    } catch (error) {
        expectedError = error;
    }
    let actual = null;
    let actualError = null;
    try {
        actual = loadFragment(html);
    } catch (error) {
        actualError = error;
    }
    if (expectedError) {
        assert.ok(actualError, `${label}：原生载入抛错（${expectedError.message}），loadFragment 也应抛错`);
        assert.equal(actualError.constructor, expectedError.constructor, `${label}：错误类型应相同`);
        assert.equal(actualError.message, expectedError.message, `${label}：错误消息应相同`);
        return true;
    }
    assert.ok(!actualError, `${label}：原生载入成功，loadFragment 不应抛错（${actualError && actualError.message}）`);
    assert.equal(treeSnapshot(actual.root()[0]), treeSnapshot(expected.root()[0]), `${label}：树转储应逐字相同`);
    assert.equal(actual.html(), expected.html(), `${label}：$.html() 应逐字相同`);
    assertConsistent(actual.root()[0], label);
    return false;
}

// 逐个比对一批输入，汇总用例数与两侧同样抛错的个数
function assertFragmentCorpus(inputs, kind) {
    const stats = { cases: 0, bothThrow: 0 };
    inputs.forEach((html, index) => {
        if (assertFragmentEquivalent(html, `${kind}第 ${index} 个：${JSON.stringify(html)}`)) stats.bothThrow += 1;
        stats.cases += 1;
    });
    return stats;
}

// 外来内容回溯的四类反例，取自片段载入改写前的差分验证：当时比较过「给片段套一层包裹元素再载入」的方案，外来内容
// （svg、math）中的结束标签回溯到包裹元素会造成四类不对称；loadFragment 不包裹，这些输入照样须逐字等价
const FOREIGN_BACKTRACK_FRAGMENTS = Object.freeze([
    // 其一：</form> 经外来内容回溯
    '<div><form></div><svg></form></svg><form>',
    '<div><form></div><svg><foreignObject></form></foreignObject></svg><form>x</form>',
    '<table><form></table><svg></form></svg><form>x</form>',
    '<div><form></div><math></form></math><form>x</form>',
    // 其二：外来内容中的孤立结束标签，之后被 in body 忽略的记号插入外来元素
    '<svg></markflow-fragment><td>',
    '<b><svg></markflow-fragment>x',
    '<svg></div><circle></svg>',
    // 其三：格式化元素的结束标签经外来内容回溯后走收养代理算法
    '<svg><foreignObject><div><b></div></foreignObject></b></svg>x',
    '<svg><foreignObject><div><b></div></b>x',
    '<svg><foreignObject><p><b><div>x</div></b></p></foreignObject></svg>y',
    '<math><mi><div><b></div></mi></b></math>x',
    '<svg><desc><div><i></div></desc></i></svg><p>z',
    '<svg><foreignObject><div><font color=red></div></foreignObject></font></svg>x',
    '<svg><foreignObject><div><nobr></div></foreignObject></nobr></svg>x',
    // 其四：HTML 上下文中的结束标签弹栈时外来元素仍打开；form、a 从栈中间移除
    '<span><svg></markflow-fragment><td>',
    `<span><svg></markflow-fragment>${ch(0)}`,
    '<b><svg></markflow-fragment><html>',
    '<b><svg></s></div></applet><a><svg><foreignObject><a></a></foreignObject></markflow-fragment><td>',
    '<form><svg></form><foreignObject><div><form></div></foreignObject></form></svg><form>x</form>',
    '<a><svg><foreignObject><a></a><div><b></div></foreignObject></b></svg>x',
    '<a><svg><foreignObject><a></a></foreignObject></markflow-fragment><td>',
    '<form><svg></form></markflow-fragment><td>',
    '<form><a><svg></form><foreignObject><a></a><div><b></div></foreignObject></b></svg>x',
    '<a><math><mi><a></a><div><b></div></mi></b></math>x',
    '<form><math></form><mi><div><form></div></mi></form></math><form>x</form>',
]);

// 对抗样例：上述四类反例，外加首记号、孤立结束标签、注释边角、特殊字符、plaintext、嵌套 template 与表格等解析器分支
const ADVERSARIAL_FRAGMENTS = Object.freeze([
    ...FOREIGN_BACKTRACK_FRAGMENTS,
    // 以表格部件开头：片段上下文为 template，首个起始标签决定插入模式
    '<td>x', '<tr><td>x', '<th>y</th>z', '<caption>c</caption>t', '<col><td>x', '<colgroup><col>', '<tbody><tr><td>x',
    '<thead>', '<tfoot><td>', '<TD>x', '<td/>x', '<td></p>', '<tr></p>', '<caption></p>', '<colgroup></p>', '<col></p>',
    // 以头部类元素、文档结构元素与 template 开头
    '<base><p>x', '<basefont>x', '<bgsound>', '<link rel=x><p>y', '<meta charset=x><p>y', '<title>t</div></title>x',
    '<style>a</p></style>b', '<script>x</div></script>y', '<noframes>n</noframes><p>', '<template>t</template></p>',
    '<html lang=x><p>y', '<head><p>x', '<body class=b><p>y', '<frameset><frame>', '<frame>x',
    '<template><td>x</template></p>', '<template></markflow-fragment></template><p>', '<b><template></markflow-fragment></template>x',
    // 以孤立结束标签开头
    '</p>x', '</br>y', '</div><p>x', '</template>x', '</markflow-fragment>x', '</td>x', '</form><form>x', '</>x', '</3>x', '</ >x',
    // 注释、声明与处理指令的边角
    '<!-->x', '<!--->x', '<!---->x', '<!--x--!>y', '--!>x', '<!--a--!->b-->c', '<!--a<!--b-->c', '<!--a<!-->b', '<!--a<!--->b',
    '<!-- - -->x', '<!--x', '<!--', '<!-', '<!DOCTYPE html><p>x', '<!doctype>', '<?pi>x', '<![CDATA[x<y]]>z',
    '<svg><![CDATA[a<b]]></svg>', '<!x>', '<!',
    // BOM、NULL、CR 与代理项；末一个为低位代理项紧跟低位代理项，parse5 7.3.0 对它抛 RangeError，两侧须同样抛错
    `${ch(0xfeff)}<p>x`, `${ch(0xfeff)}</p>`, `${ch(0)}<p>x${ch(0)}</p>`, `<div${ch(0)}>x`, 'a\r\nb\rc', '\r</p>',
    '<pre>\r\nx</pre>', '<textarea>\r\n\r\nx</textarea>', `${ch(0xd83d)}${ch(0xde00)}`, ch(0xd83d), ch(0xde00),
    `${ch(0xde00)}${ch(0xde00)}`,
    // plaintext：其后全部是文本
    '<plaintext></markflow-fragment><p>x', '<plaintext>', 'a<plaintext><b>',
    // 嵌套 template 与表格
    '<template><template><td>x</template></template>', '<template><tbody><tr><td>x</td></tr></tbody></template>',
    '<table><template><tr><td>x</template></table>', '<table><tr><td><table><td>y</table>z',
    '<template><table><template><col></template></table></template>', '<table>x<td>y</table>',
    '<table><tr><td>x<template><td>y</template></td></tr></table>',
    // 其余解析器分支：表单、选择框、收养代理、重建格式化元素、外来内容的属性调整
    '<form><div></form><form>x</form>', '<table><form><tr><td>x</table><form>y</form>', '<select><option>1<option>2<select>',
    '<table><tr><td><select><td>y', '<select><svg></select>', '<table><svg></table>', '<table><tr><svg><td>x',
    '<a>1<a>2</a>3</a>', '<nobr><nobr>x</nobr>', '<b><i></b></i>', '<p><b></p>x', '<h1><h2>x', '<ruby><rt><rb>',
    '<applet><b></applet></b>', '<button><button>x</button>', '<li><li></li></li>', '<dd><dt></dd>',
    '<math><annotation-xml encoding="text/html"><p>x</p></annotation-xml></math>', '<svg><title><p>x</p></title></svg>',
    '<svg viewbox="0 0 1 1"><g xlink:href=x xml:lang=y></g><foreignobject><p>z</p></foreignobject></svg>',
    '<script id=s>x</script><style class=c>y</style><svg><script class=v>z</script></svg>',
    // 空串与纯空白
    '', ' \n\t',
]);

// 随机记号串的字母表（移植自片段载入改写前的模糊测试）：表格部件、头部类、文档结构、表单、列表、块级、行内与格式化、
// 特殊元素、原始文本、外来内容、注释与声明、孤立结束标签、文本与字符引用、特殊字符、带属性的标签、标签名边角
const FRAGMENT_TOKENS = Object.freeze([
    '<table>', '</table>', '<caption>', '</caption>', '<colgroup>', '</colgroup>', '<col>', '<tbody>', '</tbody>', '<thead>',
    '<tfoot>', '<tr>', '</tr>', '<td>', '</td>', '<th>', '</th>',
    '<base>', '<basefont>', '<bgsound>', '<link rel=x>', '<meta charset=x>', '<title>', '</title>', '<title>t</div></title>',
    '<style>', '</style>', '<style>a</markflow-fragment></style>', '<script>', '</script>', '<script>x</div></script>',
    '<noframes>', '</noframes>', '<template>', '</template>',
    '<html>', '</html>', '<html lang=x>', '<head>', '</head>', '<body>', '</body>', '<body class=b>', '<frameset>',
    '</frameset>', '<frame>',
    '<form>', '</form>', '<form id=f>', '<FORM>', '</FORM>', '<button>', '</button>', '<input>', '<input type=hidden>',
    '<select>', '</select>', '<option>', '</option>', '<optgroup>', '</optgroup>', '<keygen>', '<textarea>', '</textarea>',
    '<textarea>t</markflow-fragment></textarea>', '<label>', '</label>', '<fieldset>', '</fieldset>',
    '<ul>', '</ul>', '<ol>', '</ol>', '<li>', '</li>', '<dl>', '</dl>', '<dd>', '</dd>', '<dt>', '</dt>',
    '<p>', '</p>', '<div>', '</div>', '<div class=c>', '<div id=i>', '<section>', '</section>', '<article>', '</article>',
    '<header>', '</header>', '<figure>', '</figure>', '<blockquote>', '</blockquote>', '<h1>', '</h1>', '<h2>', '</h2>',
    '<address>', '</address>', '<pre>', '</pre>', '<pre>\n', '<listing>', '</listing>', '<center>', '<main>', '</main>',
    '<hr>', '<br>', '</br>', '<img src=x>', '<image>', '<wbr>', '<embed>',
    '<a>', '</a>', '<a href=x>', '<b>', '</b>', '<i>', '</i>', '<em>', '</em>', '<strong>', '</strong>', '<nobr>', '</nobr>',
    '<span>', '</span>', '<span class=s>', '<font color=red>', '</font>', '<font size=1>', '<font>', '<code>', '</code>',
    '<small>', '</small>', '<u>', '</u>', '<s>', '</s>', '<big>', '<tt>',
    '<applet>', '</applet>', '<object>', '</object>', '<marquee>', '</marquee>', '<ruby>', '</ruby>', '<rt>', '<rb>', '<rp>',
    '<rtc>',
    '<plaintext>', '<xmp>', '</xmp>', '<xmp>a</p></xmp>', '<noscript>', '</noscript>', '<noscript>n</p></noscript>',
    '<iframe>', '</iframe>', '<iframe>i</div></iframe>', '<noembed>', '</noembed>',
    '<svg>', '</svg>', '<svg class=v>', '<SVG>', '<math>', '</math>', '<MATH>', '<foreignObject>', '</foreignObject>', '<mi>',
    '</mi>', '<mo>', '<mtext>', '<annotation-xml encoding="text/html">', '<annotation-xml>', '</annotation-xml>',
    '<circle/>', '<circle>', '</circle>', '<desc>', '</desc>', '<mglyph>', '<malignmark>', '<g xlink:href=x xml:lang=y>',
    '</g>', '<svg viewbox="0 0 1 1">', '<path d=M0/>', '<svg><![CDATA[a<b]]></svg>',
    '<!---->', '<!-->', '<!--->', '<!--x-->', '<!--x--!>', '<!--<!--x-->', '<!--x', '<!--a--!->', '<!--a<!-->',
    '<!--a<!--->', '<!-- - -->', '<!--a<!--b-->', '<!DOCTYPE html>', '<!doctype>', '<!DOCTYPE x PUBLIC "y">',
    '<![CDATA[x<y]]>', '<![CDATA[', '<?pi>', '<?', '<!x>', '<!', '</>', '</3>', '</ >',
    '</markflow-fragment>', '</MARKFLOW-FRAGMENT>', '</markflow-fragment x>', '</markflow-fragmen>', '</unknown>', '</h3>',
    '</h6>', '</x-el>', '<markflow-fragment>', '<markflow-fragment a=1>', '<MARKFLOW-FRAGMENT>',
    'x', 'yy', ' ', '\n', '\t', ch(0x0c), '  \n ', 'a<b', '<', '< p>', '<1>', 'a<', '&amp;', '&lt;', '&#0;', '&#x41;',
    '&notin;', '&', '"', "'", 'é', '中文',
    ch(0xfeff), ch(0), '\r', '\r\n', '\n\r', ch(0xa0), `${ch(0xd83d)}${ch(0xde00)}`, ch(0xd83d), ch(0xde00), ch(0x0b), ch(0x1f),
    '<div class="a b" id=z>', '<p class=x>', '<span id=q>', '<b class>', '<i id="">', '<img class=c src=x>', '<br class=b>',
    '<strong id=s>', '<a xml:id=q>', '<x-el class=c>', '<section class=s>', '<a class=a>',
    `<div${ch(0)}>`, '<TD>', '<Td>', '<svG>', '<td/>', '<td\t>', `<td${ch(0x0c)}>`, '<td\r>', '<div/>', '<p/>', '<br/>',
    '<svg/>', '<math/>', '<template/>', '<script/>', '<td', '<div', '<td x', '<!--', '<!-', '<form', '<svg',
]);

// 结构化种子：解析器各分支的关键交互，随机拼接后插入零到四个随机记号
const FRAGMENT_SEEDS = Object.freeze([
    ...FOREIGN_BACKTRACK_FRAGMENTS,
    '<div><form></div><svg></form></svg><form>x</form>', '<svg></markflow-fragment>',
    '<form><div></form><form>x</form>', '<table><form><tr><td>x</table><form>y</form>', '<form><svg></form></svg><form>x</form>',
    '<form><svg></svg></form><form>x</form>', '<svg><p></form></p></svg><form>x</form>', '<p><b></p><table><td><svg></b>',
    '<a><svg><foreignObject><a></a></foreignObject></svg></a>', '<svg><b></svg>', '<svg><font color=red></svg>',
    '<svg><font></svg>', '<math><annotation-xml encoding="text/html"><p>x</p></annotation-xml></math>',
    '<math><mi><p>x</p></mi></math>', '<svg><title><p>x</p></title></svg>', '<svg><desc><b>x</b></desc></svg>',
    '<template><td>x</template></p>', '<template><tbody><tr><td>x</td></tr></tbody></template>',
    '<template></markflow-fragment></template><p>', '<b><template></markflow-fragment></template>x',
    '<select><option>1<option>2<select>', '<table><tr><td><select><td>y', '<table><tr><td><select></td>y',
    '<select><svg></select>', '<table><svg></table>', '<table><tr><svg><td>x', '<button><button>x</button>',
    '<li><li></li></li>', '<dd><dt></dd>', '<a>1<a>2</a>3</a>', '<nobr><nobr>x</nobr>', '<b><i></b></i>', '<p><b></p>x',
    '<h1><h2>x', '<ruby><rt><rb>', '<applet><b></applet></b>', '<plaintext></markflow-fragment>x', '<textarea>\nx</textarea>',
    '<pre>\n\nx</pre>', '<table>x<td>y</table>', '<table><caption><td>x</caption></table>', '<table><colgroup><col><td>x</table>',
    '<table><tbody><tr><td>x</td><tr>y</table>', '<div></p></div>', '<b></br></b>', '<span></markflow-fragment></span>',
    '<b></markflow-fragment></b>', '<b>x</markflow-fragment>y', '<html class=x><p>y', '<body class=x><p>y', '<frameset><frame>',
    '<head><p>x', '<script>a</script></p>', '<style>a</style></p>', '<title>a</title></p>', '<link><p></p>', '<meta></p>',
    '<base></p>', '<noframes>x</noframes></p>', '<template>x</template></p>', '<noscript>x</noscript></p>', '<td></p>',
    '<tr></p>', '<caption></p>', '<colgroup></p>', '<col></p>', '<tbody></p>', '<th></p>', '<!---->x</p>', '<!--x--></p>',
    'x</p>', `${ch(0xfeff)}</p>`, `${ch(0)}</p>`, '\r</p>', '<!--a--!-></p>', '<!--a--!->x-->y</p>', '<!--a<!--></p>',
    '<!--a<!---></p>',
]);

// 首记号专项：片段上下文为 template，首个记号决定插入模式；前缀为零到两个文本、注释或特殊字符
const FIRST_TOKEN_PREFIXES = Object.freeze(['x', ' ', '\n', '<!--c-->', '<!---->', ch(0xfeff), ch(0), '\r']);
const FIRST_TOKENS = Object.freeze([
    '<td>', '<tr>', '<th>', '<caption>', '<col>', '<colgroup>', '<tbody>', '<script>', '<style>', '<title>', '<template>',
    '<link>', '<meta>', '<base>', '<noframes>', '<html>', '<head>', '<body>', '<frameset>', '<frame>', '<!--x-->', '<!---->',
    '<!-->', 'x', ' ', '\n', ch(0), ch(0xfeff), '\r', '<!DOCTYPE html>', '<?x>', '<!x>', '</p>', '</br>', '</div>',
    '</template>', '<', 'a<', '<1>', '</>', '<div>', '<p>', '<svg>', '<math>', '<form>', '<select>', '<textarea>',
    '<plaintext>', '<noscript>', '<iframe>', '<xmp>', '<pre>', '<listing>', '<table>', '<button>', '<li>', '<a>', '<b>',
    '<span>', '<markflow-fragment>', '</markflow-fragment>', '<image>', '<input type=hidden>', '<hr>', '<br>', '<img>',
    '<applet>', '<option>', '<optgroup>', '<ruby>', '<rt>', '<dd>', '<dt>', '<h1>', '<center>', '<address>', '<x-el>', '<TD>',
    '<td/>', '<td', `<div${ch(0)}>`,
]);

// 主题分组：外来内容与表单、表格与 template、格式化元素与收养代理、原始文本与注释、外来内容与活动格式化元素，以及首记号表
const FRAGMENT_GROUPS = Object.freeze([
    ['<svg>', '</svg>', '<math>', '</math>', '<form>', '</form>', '<div>', '</div>', '<foreignObject>', '</foreignObject>',
        '<table>', '</table>', 'x', '<b>', '</b>', '<mi>', '</mi>', '<annotation-xml encoding="text/html">', '</annotation-xml>',
        '<p>', '</p>', '<template>', '</template>', '<font color=red>', '<circle/>', '</markflow-fragment>', '<a>', '</a>',
        '<input type=hidden>', '<select>', '</select>'],
    ['<table>', '</table>', '<tr>', '</tr>', '<td>', '</td>', '<tbody>', '<caption>', '</caption>', '<col>', '<colgroup>',
        '<template>', '</template>', 'x', ' ', '<form>', '</form>', '<select>', '</select>', '<option>', '<input type=hidden>',
        '<b>', '</b>', '<div>', '</div>', '</markflow-fragment>', '<svg>', '</svg>', '<p>', '<script>x</script>',
        '<style>y</style>'],
    ['<a>', '</a>', '<b>', '</b>', '<i>', '</i>', '<nobr>', '</nobr>', '<p>', '</p>', '<div>', '</div>', '<table>', '</table>',
        '<td>', '<span>', '</span>', 'x', '<applet>', '</applet>', '<button>', '</button>', '<li>', '</li>', '<font color=red>',
        '</font>', '</markflow-fragment>', '<svg>', '</svg>', '<h1>', '</h1>', '<br>', '</br>', '<em>', '</em>', '<strong>',
        '</strong>'],
    ['<script>', '</script>', '<style>', '</style>', '<textarea>', '</textarea>', '<title>', '</title>', '<plaintext>', '<xmp>',
        '</xmp>', '<noscript>', '</noscript>', '<iframe>', '</iframe>', '<!--', '-->', '--!>', '<!-->', '<!--->', '<!---->', '-',
        '--', '!', '<', '>', 'x', '</div>', '</p>', '</markflow-fragment>', '<p>', '<div>', '<!DOCTYPE html>', '<?pi>',
        '<![CDATA[', ']]>', '<svg>', '</svg>', ch(0), '\r', ch(0xfeff)],
    ['<svg>', '</svg>', '<math>', '</math>', '<foreignObject>', '</foreignObject>', '<mi>', '</mi>', '<desc>', '</desc>',
        '<annotation-xml encoding="text/html">', '</annotation-xml>', '<div>', '</div>', '<p>', '</p>', '<b>', '</b>', '<a>',
        '</a>', '<font color=red>', '</font>', '<nobr>', '</nobr>', '<i>', '</i>', '<form>', '</form>', 'x', '<td>', '<li>',
        '</li>', '<span>', '</span>', '</markflow-fragment>', '<table>', '</table>', '<circle/>', '<button>', '</button>', '<br>',
        '</br>', '</h1>', '</p>'],
    FIRST_TOKENS,
].map((group) => Object.freeze(group)));

const RANDOM_FRAGMENT_SEED = 20261001;
const RANDOM_FRAGMENT_COUNT = 20000;

// 随机记号串，五种生成方式：全字母表、随机子字母表、主题分组、种子拼接、首记号专项
function randomTokenString(random) {
    const pickFrom = (list) => pick(random, list);
    const between = (min, max) => min + Math.floor(random() * (max - min + 1));
    const roll = random();
    let tokens;
    if (roll < 0.3) {
        tokens = Array.from({ length: between(1, 14) }, () => pickFrom(FRAGMENT_TOKENS));
    } else if (roll < 0.55) {
        const subset = Array.from({ length: between(4, 10) }, () => pickFrom(FRAGMENT_TOKENS));
        tokens = Array.from({ length: between(3, 16) }, () => pickFrom(subset));
    } else if (roll < 0.75) {
        const group = pickFrom(FRAGMENT_GROUPS);
        tokens = Array.from({ length: between(3, 20) }, () => pickFrom(group));
    } else if (roll < 0.92) {
        tokens = Array.from({ length: between(1, 3) }, () => pickFrom(FRAGMENT_SEEDS));
        const extra = between(0, 4);
        for (let index = 0; index < extra; index += 1) {
            tokens.splice(Math.floor(random() * (tokens.length + 1)), 0, pickFrom(FRAGMENT_TOKENS));
        }
    } else {
        tokens = Array.from({ length: between(0, 2) }, () => pickFrom(FIRST_TOKEN_PREFIXES));
        tokens.push(pickFrom(FIRST_TOKENS));
        const tail = between(0, 7);
        for (let index = 0; index < tail; index += 1) tokens.push(pickFrom(FRAGMENT_TOKENS));
    }
    return tokens.join('');
}

// 微信夹具：整份页面源码、body 与子节点不少于 FIXTURE_MIN_CHILDREN 个的容器的 innerHTML
const WECHAT_FIXTURE_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'web', 'wechat-collapse.html'), 'utf8');
const FIXTURE_MIN_CHILDREN = 5;

function fixtureFragments() {
    const $ = cheerio.load(WECHAT_FIXTURE_HTML);
    const containers = $('*').toArray().filter((el) => el.children.length >= FIXTURE_MIN_CHILDREN);
    assert.ok(containers.some((el) => el.name === 'body'), '夹具的 body 应在容器之列');
    return [WECHAT_FIXTURE_HTML, ...containers.map((el) => $(el).html())];
}

// 差分语料只构造一次，供 loadFragment 与根级查询两组用例共用：随机串的往返串为其 cheerio.load(串, null, false).html()，
// 原生载入抛错的串没有往返串
let fragmentCorpus = null;
function getFragmentCorpus() {
    if (fragmentCorpus) return fragmentCorpus;
    const random = seededRandom(RANDOM_FRAGMENT_SEED);
    const randomStrings = Array.from({ length: RANDOM_FRAGMENT_COUNT }, () => randomTokenString(random));
    const roundTrips = [];
    for (const html of randomStrings) {
        try {
            roundTrips.push(cheerio.load(html, null, false).html());
        } catch {
            // 原生载入抛错：该串的抛错一致性由随机串用例核对
        }
    }
    fragmentCorpus = Object.freeze({
        adversarial: ADVERSARIAL_FRAGMENTS,
        random: randomStrings,
        roundTrip: roundTrips,
        fixture: fixtureFragments(),
    });
    return fragmentCorpus;
}

test('loadFragment 与 cheerio.load 逐字等价：对抗样例（外来内容回溯、首记号、孤立结束标签、注释边角、BOM／NULL／CR、plaintext、嵌套 template 与表格）', (t) => {
    // Act & Assert：比对在 assertFragmentEquivalent 内
    const stats = assertFragmentCorpus(getFragmentCorpus().adversarial, '对抗样例');
    t.diagnostic(`对抗样例：${JSON.stringify(stats)}`);

    // Assert：低位代理项紧跟低位代理项一例两侧同样抛错
    assert.ok(stats.bothThrow >= 1, `对抗样例中应有两侧同样抛错的输入：${JSON.stringify(stats)}`);
});

test('loadFragment 与 cheerio.load 逐字等价：定种子随机记号串 2 万个，含两侧同样抛错的输入', (t) => {
    // Act & Assert
    const stats = assertFragmentCorpus(getFragmentCorpus().random, '随机记号串');
    t.diagnostic(`随机记号串：${JSON.stringify(stats)}`);

    // Assert：核对面确实铺开了——全部用例都比对过，抛错一致的分支也被覆盖
    assert.equal(stats.cases, RANDOM_FRAGMENT_COUNT);
    assert.ok(stats.bothThrow >= 1, `随机记号串中应有两侧同样抛错的输入：${JSON.stringify(stats)}`);
});

test('loadFragment 与 cheerio.load 逐字等价：随机记号串经原生载入与序列化得到的往返串', (t) => {
    // Act & Assert
    const { random, roundTrip } = getFragmentCorpus();
    const stats = assertFragmentCorpus(roundTrip, '往返串');
    t.diagnostic(`往返串：${JSON.stringify(stats)}`);

    // Assert：原生载入抛错的随机串才没有往返串
    assert.ok(stats.cases > random.length * 0.99, `往返串应覆盖绝大多数随机串：${JSON.stringify(stats)}`);
});

test('loadFragment 与 cheerio.load 逐字等价：微信夹具的整页源码、body 与子节点不少于 5 个的容器', (t) => {
    // Act & Assert
    const stats = assertFragmentCorpus(getFragmentCorpus().fixture, '微信夹具');
    t.diagnostic(`微信夹具：${JSON.stringify(stats)}`);

    // Assert：整页源码之外至少有 body 与一个正文容器
    assert.ok(stats.cases >= 3, `夹具输入应不少于 3 个：${JSON.stringify(stats)}`);
});

test('loadFragment：非字符串输入原样交给 cheerio.load，结果与抛错都相同', () => {
    // Arrange
    const buffer = Buffer.from('<p>甲<b>乙</b></p>');
    const $existing = cheerio.load('<i>丙</i>', null, false);

    // Act & Assert：Buffer 按字符串解析；既有的根节点原样作根
    assert.equal(loadFragment(buffer).html(), cheerio.load(buffer, null, false).html());
    const $reloaded = loadFragment($existing.root()[0]);
    assert.ok($reloaded.root()[0] === $existing.root()[0], '既有的根节点应原样作根');

    // Act & Assert：null 与 undefined 两侧抛出同一错误
    for (const input of [null, undefined]) {
        assert.throws(() => cheerio.load(input, null, false), /expects a string/);
        assert.throws(() => loadFragment(input), /expects a string/);
    }
});

// ============================================================
// selectElements／selectByTags：与根级 $(选择器) 逐节点同序
// ============================================================

// 管线里全部根级查询的选择器及其改写：web/noise 的属性规则、文案规则、连续 br 削减、空元素清理，parsers/url 的图片、
// 样式规则（'span, b' 与 'span'）、段首缩进、相邻 strong 合并与空 span 清理。文案规则与空元素清理的标签串逐字照抄
// web/noise 的 TEXT_RULE_TAGS 与 EMPTY_TAGS
const PIPELINE_TEXT_RULE_TAGS = 'p, div, section, span, li, h1, h2, h3, h4, h5, h6, strong, em, blockquote';
const PIPELINE_EMPTY_TAGS = 'p, div, section, span, li, blockquote, h1, h2, h3, h4, h5, h6, article, header, figure, a';
const PIPELINE_SELECTIONS = Object.freeze([
    ['[class], [id]', ($) => selectElements($, hasClassOrId)],
    ...[PIPELINE_TEXT_RULE_TAGS, 'br', PIPELINE_EMPTY_TAGS, 'img', 'span, b', 'span', LEAF_BLOCK_SELECTOR, 'strong']
        .map((selector) => [selector, ($) => selectByTags($, selector)]),
]);

// 元素是否位于某个 template 的内容片段之内（载入根之外另有 type 为 'root' 的祖先）
function insideTemplateContent(el) {
    for (let node = el.parent; node && node.parent; node = node.parent) {
        if (node.type === 'root') return true;
    }
    return false;
}

// 对一份载入逐个比对管线选择器：结果逐节点为同一对象、同序；另按命中的元素统计覆盖面（bySelector 为各选择器的命中数）
function assertPipelineSelections($, label, stats) {
    for (const [selector, select] of PIPELINE_SELECTIONS) {
        const expected = $(selector).toArray();
        const actual = select($).toArray();
        const same = actual.length === expected.length && actual.every((node, index) => node === expected[index]);
        assert.ok(same, `${label}：「${selector}」应逐节点同一对象、同序（$() ${expected.length} 个，改写 ${actual.length} 个）`);
        stats.queries += 1;
        stats.matched += expected.length;
        stats.bySelector[selector] = (stats.bySelector[selector] || 0) + expected.length;
        for (const el of expected) {
            if (insideTemplateContent(el)) stats.inTemplate += 1;
            if (el.namespace !== 'http://www.w3.org/1999/xhtml') stats.foreign += 1;
            if (el.type !== 'tag') stats.rawText += 1;
        }
    }
}

// 随机森林的标签：管线选择器涉及的全部标签，外加 template、svg、math、foreignObject、script、style、table 与未知元素；
// 元素随机带或不带 class／id（含空值、无值与大写属性名）。svg、math 里不在 breakout 列表中的 section、article、header、
// figure、a 等留在外来命名空间，与同名 HTML 元素一样按名字命中
const SELECT_FOREST_TAGS = Object.freeze([
    'p', 'div', 'section', 'span', 'li', 'h1', 'h2', 'h6', 'strong', 'em', 'blockquote', 'article', 'header', 'figure', 'a',
    'b', 'br', 'img', 'i', 'template', 'svg', 'math', 'foreignObject', 'script', 'style', 'table', 'x-el',
]);
const SELECT_FOREST_ATTRIBUTES = Object.freeze([
    '', '', '', ' class="a"', ' id="b"', ' class', ' id=""', ' class="x" id="y"', ' CLASS="u"', ' Id=q', ' data-k="v"',
]);
const SELECT_FOREST_SEED = 20261002;
const SELECT_FOREST_COUNT = 6000;
const SELECT_FOREST_MAX_DEPTH = 4;
const SELECT_FOREST_MAX_CHILDREN = 4;

// 随机森林的 HTML：顶层 1 到 3 个节点，每个元素 0 到 SELECT_FOREST_MAX_CHILDREN 个子节点、深度至多 SELECT_FOREST_MAX_DEPTH，
// 文本、注释与元素混排
function randomAttributedForest(random, depth = SELECT_FOREST_MAX_DEPTH) {
    const count = depth === SELECT_FOREST_MAX_DEPTH
        ? 1 + Math.floor(random() * 3)
        : Math.floor(random() * (SELECT_FOREST_MAX_CHILDREN + 1));
    let html = '';
    for (let index = 0; index < count; index += 1) {
        const roll = random();
        if (depth <= 0 || roll < 0.2) {
            html += pick(random, TEXTS);
            continue;
        }
        if (roll < 0.25) {
            html += pick(random, COMMENTS);
            continue;
        }
        const tag = pick(random, SELECT_FOREST_TAGS);
        const open = `<${tag}${pick(random, SELECT_FOREST_ATTRIBUTES)}>`;
        if (VOID_TAGS.has(tag)) html += open;
        else if (RAW_TEXT_TAGS.has(tag)) html += `${open}${pick(random, RAW_TEXTS)}</${tag}>`;
        else html += `${open}${randomAttributedForest(random, depth - 1)}</${tag}>`;
    }
    return html;
}

test('selectElements／selectByTags 与根级 $(选择器) 逐节点同序：定种子随机森林上的全部管线选择器与随机标签串', (t) => {
    // Arrange
    const random = seededRandom(SELECT_FOREST_SEED);
    const stats = { queries: 0, matched: 0, inTemplate: 0, foreign: 0, rawText: 0, randomLists: 0, bySelector: {} };
    const tagPool = [...new Set(SELECT_FOREST_TAGS.map((tag) => tag.toLowerCase()))];

    for (let index = 0; index < SELECT_FOREST_COUNT; index += 1) {
        const html = randomAttributedForest(random);
        const $ = cheerio.load(html, null, false);
        const label = `第 ${index} 棵树：${html}`;

        // Act & Assert：管线选择器
        assertPipelineSelections($, label, stats);

        // Act & Assert：随机抽取的标签串，含选择器一侧写成小写后不再命中的 foreignobject
        const selector = Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(random, tagPool)).join(', ');
        const expected = $(selector).toArray();
        const actual = selectByTags($, selector).toArray();
        assert.ok(actual.length === expected.length && actual.every((node, at) => node === expected[at]),
            `${label}：随机标签串「${selector}」应逐节点同一对象、同序`);
        stats.randomLists += 1;
    }
    t.diagnostic(`随机森林：${JSON.stringify(stats)}`);

    // Assert：核对面确实铺开了——每个管线选择器都有命中，命中里有 template 内容片段中的元素、外来命名空间的元素与
    // script／style
    for (const [selector] of PIPELINE_SELECTIONS) {
        assert.ok(stats.bySelector[selector] > 0, `「${selector}」应有命中：${JSON.stringify(stats)}`);
    }
    for (const key of ['inTemplate', 'foreign', 'rawText']) {
        assert.ok(stats[key] > 0, `统计项 ${key} 应大于 0：${JSON.stringify(stats)}`);
    }
});

test('selectElements／selectByTags 与根级 $(选择器) 逐节点同序：loadFragment 差分用例的全部语料', (t) => {
    // Arrange
    const corpus = getFragmentCorpus();
    const stats = { inputs: 0, skippedThrows: 0, queries: 0, matched: 0, inTemplate: 0, foreign: 0, rawText: 0, bySelector: {} };

    for (const [kind, inputs] of Object.entries(corpus)) {
        inputs.forEach((html, index) => {
            let $;
            try {
                $ = cheerio.load(html, null, false);
            } catch {
                // 原生载入抛错的输入没有可查询的树，抛错一致性已由 loadFragment 的用例核对
                stats.skippedThrows += 1;
                return;
            }

            // Act & Assert
            assertPipelineSelections($, `${kind} 第 ${index} 个：${JSON.stringify(html)}`, stats);
            stats.inputs += 1;
        });
    }
    t.diagnostic(`差分语料：${JSON.stringify(stats)}`);

    // Assert
    for (const key of ['matched', 'inTemplate', 'foreign', 'rawText']) {
        assert.ok(stats[key] > 0, `统计项 ${key} 应大于 0：${JSON.stringify(stats)}`);
    }
});

test('selectByTags：选择器不是逗号分隔的小写标签名串即抛错，不静默错配', () => {
    // Arrange
    const $ = cheerio.load('<p class="a" id="b"><span>甲</span></p>', null, false);
    const rejected = ['[class]', 'p.a', '#b', 'p span', 'p > span', 'span:first-child', '*', 'P', 'span,', ', span',
        'span,, p', 'span, [id]', '', ' '];

    // Act & Assert
    for (const selector of rejected) {
        assert.throws(() => selectByTags($, selector), /只接受逗号分隔的小写标签名/, `应拒绝 ${JSON.stringify(selector)}`);
    }
    assert.throws(() => selectByTags($, undefined), TypeError);

    // Assert：对照组——纯标签名串照常查询，结果按文档序
    assert.deepEqual(selectByTags($, 'span, p').toArray().map((el) => el.name), ['p', 'span']);
});
