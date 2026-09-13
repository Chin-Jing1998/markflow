/**
 * converters/renderers/md.js 与 json.js 对 math / safeTable 节点的处理
 * 覆盖：math 降级为线性化文本并套 TeX 定界符（行内 $…$、块级 $$…$$ 独立成段）、
 *       text 缺省时由 MathML 兜底、safeTable 的 html 节点原样输出、json 原样序列化且不抛错
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const mdRenderer = require('../converters/renderers/md');
const jsonRenderer = require('../converters/renderers/json');
const { createDocument, createRoot, createParagraph, createText, createMath } = require('../converters/ir/schema');

const SAFE_TABLE = '<table><tr><td>甲</td><td>乙</td></tr></table>';

function makeDoc(children) {
    return createDocument({ ir: createRoot(children), meta: { title: '测试文档', sourceType: 'md' } });
}

// ============================================================
// 用例
// ============================================================

test('md：行内公式套 $…$，块级公式套 $$…$$ 并独立成段', async () => {
    // Arrange
    const doc = makeDoc([
        createParagraph([createText('前 '), createMath({ text: 'a^2+b^2=c^2' }), createText(' 后')]),
        createMath({ text: 'E=mc^2', display: true }),
    ]);

    // Act
    const md = await mdRenderer.render(doc);

    // Assert
    assert.ok(md.includes('前 $a^2+b^2=c^2$ 后'), md);
    assert.match(md, /(^|\n)\$\$E=mc\^2\$\$(\n|$)/, md);
});

test('md：text 缺省时线性化文本由 MathML 去标签兜底', async () => {
    // Arrange
    const doc = makeDoc([createParagraph([createMath({ mathml: '<math><mi>x</mi><mo>+</mo><mn>1</mn></math>' })])]);

    // Act
    const md = await mdRenderer.render(doc);

    // Assert
    assert.ok(md.includes('$x+1$'), md);
    assert.ok(!md.includes('<math'), 'md 产物不应含 MathML 标签');
});

test('md：带 data.safeTable 的 html 节点原样输出，不抛错', async () => {
    // Arrange
    const doc = makeDoc([{ type: 'html', value: SAFE_TABLE, data: { safeTable: true } }]);

    // Act
    const md = await mdRenderer.render(doc);

    // Assert
    assert.ok(md.includes(SAFE_TABLE), md);
});

test('json：math 与 safeTable 节点原样序列化，二进制被略过', async () => {
    // Arrange
    const doc = makeDoc([
        createParagraph([createMath({ omml: '<m:oMath/>', mathml: '<math><mi>x</mi></math>', text: 'x', display: false })]),
        { type: 'html', value: SAFE_TABLE, data: { safeTable: true } },
        { type: 'paragraph', children: [{ type: 'image', url: 'images/image_1.png', data: { asset: { buffer: Buffer.from('BIN'), mime: 'image/png' } } }] },
    ]);

    // Act
    const payload = JSON.parse(await jsonRenderer.render(doc));

    // Assert
    const [paragraph, html, imageParagraph] = payload.ir.children;
    assert.deepEqual(paragraph.children[0], {
        type: 'math',
        data: { omml: '<m:oMath/>', mathml: '<math><mi>x</mi></math>', text: 'x', display: false },
    });
    assert.equal(html.data.safeTable, true);
    assert.equal(html.value, SAFE_TABLE);
    assert.equal(imageParagraph.children[0].data.asset.buffer, undefined, '二进制不应进入 JSON');
});
