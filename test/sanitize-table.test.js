/**
 * converters/ir/sanitize-table.js 单元测试
 *
 * 覆盖：规则表 → mdast table、合并单元格 → 白名单 HTML + data.safeTable、
 *       script 与 style 元素、on* 事件属性与 href 被清除、非表格 html 节点不受影响、入参不被修改，
 *       以及经 remark 真实解析出的 html 节点能被正确识别（MinerU full.md 的实际形态）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeTables } = require('../converters/ir/sanitize-table');
const md = require('../converters/parsers/md');

const REGULAR_TABLE = '<table><tr><th>名称</th><th>数量</th></tr><tr><td>甲</td><td>1</td></tr><tr><td>乙</td><td>2</td></tr></table>';
const MERGED_TABLE = '<table><tr><td colspan="2">合计</td></tr><tr><td>甲</td><td>1</td></tr></table>';

const htmlNode = (value) => ({ type: 'html', value });
const rootOf = (...children) => ({ type: 'root', children });

function collect(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) for (const child of node.children) collect(child, predicate, out);
    return out;
}

const cellTexts = (row) => row.children.map((cell) => cell.children.map((c) => c.value).join(''));

// ============================================================
// 规则表 → mdast
// ============================================================

test('无合并单元格的规则表转成 mdast table', () => {
    // Arrange
    const tree = rootOf(htmlNode(REGULAR_TABLE));

    // Act
    const { tree: next, converted, kept } = sanitizeTables(tree);

    // Assert
    assert.equal(converted, 1);
    assert.equal(kept, 0);
    const tables = collect(next, (n) => n.type === 'table');
    assert.equal(tables.length, 1);
    assert.equal(tables[0].children.length, 3);
    assert.deepEqual(cellTexts(tables[0].children[0]), ['名称', '数量']);
    assert.deepEqual(cellTexts(tables[0].children[2]), ['乙', '2']);
    assert.equal(collect(next, (n) => n.type === 'html').length, 0);
});

test('单元格内的标签被剥成纯文本，连续空白折叠', () => {
    // Arrange
    const tree = rootOf(htmlNode('<table><tr><td><b>加粗</b>\n  尾巴</td><td><br>换行</td></tr><tr><td>a</td><td>b</td></tr></table>'));

    // Act
    const { tree: next, converted } = sanitizeTables(tree);

    // Assert
    assert.equal(converted, 1);
    const table = collect(next, (n) => n.type === 'table')[0];
    assert.deepEqual(cellTexts(table.children[0]), ['加粗 尾巴', '换行']);
});

test('各行列数不一致的表不转 mdast，退回白名单 HTML', () => {
    // Arrange
    const tree = rootOf(htmlNode('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>'));

    // Act
    const { tree: next, converted, kept } = sanitizeTables(tree);

    // Assert
    assert.equal(converted, 0);
    assert.equal(kept, 1);
    assert.equal(collect(next, (n) => n.type === 'table').length, 0);
    assert.equal(collect(next, (n) => n.type === 'html')[0].data.safeTable, true);
});

// ============================================================
// 合并单元格 → 白名单 HTML
// ============================================================

test('含合并单元格的表保留 HTML 并标记 data.safeTable', () => {
    // Arrange
    const tree = rootOf(htmlNode(MERGED_TABLE));

    // Act
    const { tree: next, converted, kept } = sanitizeTables(tree);

    // Assert
    assert.equal(converted, 0);
    assert.equal(kept, 1);
    const node = collect(next, (n) => n.type === 'html')[0];
    assert.equal(node.data.safeTable, true);
    assert.equal(
        node.value,
        '<table><tbody><tr><td colspan="2">合计</td></tr><tr><td>甲</td><td>1</td></tr></tbody></table>',
    );
});

test('rowspan 同样视为合并，colspan="1" 不算合并', () => {
    // Arrange
    const merged = rootOf(htmlNode('<table><tr><td rowspan="2">甲</td><td>1</td></tr><tr><td>乙</td><td>2</td></tr></table>'));
    const plain = rootOf(htmlNode('<table><tr><td colspan="1">甲</td><td rowspan="1">1</td></tr><tr><td>乙</td><td>2</td></tr></table>'));

    // Act
    const mergedResult = sanitizeTables(merged);
    const plainResult = sanitizeTables(plain);

    // Assert
    assert.equal(mergedResult.kept, 1);
    assert.equal(plainResult.converted, 1, 'colspan/rowspan 为 1 等同于未合并');
});

test('script / style / on* / href 一律被清除，文本转义', () => {
    // Arrange
    const dirty = [
        '<table><tr>',
        '<td colspan="2" onclick="steal()" style="color:red">',
        '<a href="javascript:alert(1)">链接</a><script>bad()</script>',
        '</td></tr>',
        '<tr><td>1 &lt; 2</td><td>a &amp; b</td></tr></table>',
    ].join('');

    // Act
    const { tree: next, kept } = sanitizeTables(rootOf(htmlNode(dirty)));

    // Assert
    assert.equal(kept, 1);
    const { value } = collect(next, (n) => n.type === 'html')[0];
    for (const forbidden of ['script', 'onclick', 'href', 'style=', 'javascript:', 'bad()']) {
        assert.ok(!value.includes(forbidden), `清洗后不应残留 ${forbidden}：${value}`);
    }
    assert.ok(value.includes('<td colspan="2">链接</td>'), value);
    assert.ok(value.includes('1 &lt; 2'), value);
    assert.ok(value.includes('a &amp; b'), value);
});

test('表格之外还有其它内容时走清洗路径，正文不丢失', () => {
    // Arrange
    const tree = rootOf(htmlNode('<p>表前说明</p><table><tr><td>甲</td></tr></table>'));

    // Act
    const { tree: next, converted, kept } = sanitizeTables(tree);

    // Assert
    assert.equal(converted, 0);
    assert.equal(kept, 1);
    const { value } = collect(next, (n) => n.type === 'html')[0];
    assert.ok(value.startsWith('表前说明<table>'), value);
});

// ============================================================
// 边界
// ============================================================

test('不含表格的 html 节点与整棵树原样返回同一引用', () => {
    // Arrange
    const tree = rootOf(htmlNode('<div>普通片段</div>'), { type: 'paragraph', children: [{ type: 'text', value: 'x' }] });

    // Act
    const { tree: next, converted, kept } = sanitizeTables(tree);

    // Assert
    assert.equal(next, tree);
    assert.equal(converted, 0);
    assert.equal(kept, 0);
});

test('不修改入参：原树的 html 节点保持原值', () => {
    // Arrange
    const node = htmlNode(REGULAR_TABLE);
    const tree = rootOf(node);

    // Act
    sanitizeTables(tree);

    // Assert
    assert.equal(node.value, REGULAR_TABLE);
    assert.equal(tree.children[0], node);
});

test('嵌套在 blockquote 里的表格同样被处理', () => {
    // Arrange
    const tree = rootOf({ type: 'blockquote', children: [htmlNode(REGULAR_TABLE)] });

    // Act
    const { tree: next, converted } = sanitizeTables(tree);

    // Assert
    assert.equal(converted, 1);
    assert.equal(collect(next, (n) => n.type === 'table').length, 1);
});

// ============================================================
// 与 remark 的真实链路
// ============================================================

test('remark 解析 MinerU 风格 full.md 后，表格能被识别并转换', async () => {
    // Arrange
    const text = `# 标题\n\n正文段落。\n\n${REGULAR_TABLE}\n\n结尾。\n`;

    // Act
    const doc = await md.parse({ text }, { sourceName: 'full.md' });
    const { tree, converted } = sanitizeTables(doc.ir);

    // Assert
    assert.equal(collect(doc.ir, (n) => n.type === 'html').length, 1, 'remark 应把原始表格解析为 html 节点');
    assert.equal(converted, 1);
    const table = collect(tree, (n) => n.type === 'table')[0];
    assert.deepEqual(cellTexts(table.children[0]), ['名称', '数量']);
});
