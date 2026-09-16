/**
 * converters/ir/markers.js 单元测试
 * 覆盖：indentMarker 编码与钳制、restoreMarkers（段首 INDENT/CAPTION/FOOTNOTE → data、TAB → \t、残留清除、
 *       深入行内容器取段首标记、只剩标记的段落移除、入参不变）、stripMarkersTree（无残留时同一引用）、
 *       applyTextLayout（缩进与制表符落为全角空格、纯图片段与代码不受影响）、stripMarkers
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    MARKERS, COUNT_BASE, indentMarker, stripMarkers, restoreMarkers, stripMarkersTree, applyTextLayout,
} = require('../converters/ir/markers');

// 不可见字符以码点生成，源码不出现看不见的字面量
const MARKER_RE = new RegExp(`[${String.fromCharCode(0xEF00)}-${String.fromCharCode(0xEF1F)}]`);
const IDEO = String.fromCharCode(0x3000);
const text = (value) => ({ type: 'text', value });
const paragraph = (...children) => ({ type: 'paragraph', children });
const root = (...children) => ({ type: 'root', children });

test('indentMarker：INDENT 后紧跟计数码点，钳制到 1–15，非正数返回空串', () => {
    assert.equal(indentMarker(2), MARKERS.INDENT + String.fromCharCode(COUNT_BASE + 2));
    assert.equal(indentMarker(2.4), indentMarker(2));
    assert.equal(indentMarker(40), MARKERS.INDENT + String.fromCharCode(COUNT_BASE + 15));
    assert.equal(indentMarker(0), '');
    assert.equal(indentMarker(-3), '');
    assert.equal(indentMarker('abc'), '');
});

test('restoreMarkers：段首 INDENT → data.indent，CAPTION / FOOTNOTE → data.role，文本不再带标记', () => {
    // Arrange
    const ir = root(
        paragraph(text(`${indentMarker(2)}缩进两字的段落`)),
        paragraph(text(`${MARKERS.CAPTION}图 1 示意图`)),
        paragraph(text(`${MARKERS.FOOTNOTE}来源：夹具`)),
        paragraph(text(`${MARKERS.INDENT}缺计数码点时按两字`)),
    );

    // Act
    const restored = restoreMarkers(ir);
    const [indented, caption, footnote, fallback] = restored.children;

    // Assert
    assert.deepEqual(indented.data, { indent: 2 });
    assert.equal(indented.children[0].value, '缩进两字的段落');
    assert.deepEqual(caption.data, { role: 'caption' });
    assert.equal(caption.children[0].value, '图 1 示意图');
    assert.deepEqual(footnote.data, { role: 'image_footnote' });
    assert.deepEqual(fallback.data, { indent: 2 });
    assert.ok(!MARKER_RE.test(JSON.stringify(restored)));
});

test('restoreMarkers：段首标记落在行内容器首个文本里也能取到；容器被掏空时继续看下一个兄弟', () => {
    // Arrange：整段加粗 <strong>INDENT…</strong>，以及只装着标记的 strong 后面跟正文
    const ir = root(
        paragraph({ type: 'strong', children: [text(`${indentMarker(3)}整段加粗`)] }),
        paragraph({ type: 'emphasis', children: [text(MARKERS.CAPTION)] }, text('图｜紧随其后')),
    );

    // Act
    const [bold, caption] = restoreMarkers(ir).children;

    // Assert
    assert.equal(bold.data.indent, 3);
    assert.equal(bold.children[0].type, 'strong');
    assert.equal(bold.children[0].children[0].value, '整段加粗');
    assert.equal(caption.data.role, 'caption');
    assert.deepEqual(caption.children, [text('图｜紧随其后')]);
});

test('restoreMarkers：TAB → \\t，段中与残留的 BR / CAPTION 删除，删空的文本节点移除', () => {
    // Arrange
    const ir = root(
        paragraph(text(`图 1${MARKERS.TAB}图 2`)),
        paragraph(text('正文'), { type: 'strong', children: [text(`中间${MARKERS.CAPTION}的标记`)] }, text(MARKERS.BR)),
        { type: 'heading', depth: 2, children: [text(`标题${MARKERS.BR}`)] },
        paragraph({ type: 'image', url: 'images/image_1.png', alt: `图${MARKERS.CAPTION}说明`, title: null }),
        { type: 'code', value: `a${MARKERS.TAB}b` },
    );

    // Act
    const [tab, mixed, heading, image, code] = restoreMarkers(ir).children;

    // Assert
    assert.equal(tab.children[0].value, '图 1\t图 2');
    assert.equal(tab.data, undefined);
    assert.equal(mixed.children.length, 2, JSON.stringify(mixed.children));
    assert.equal(mixed.children[1].children[0].value, '中间的标记');
    assert.equal(heading.children[0].value, '标题');
    assert.equal(image.children[0].alt, '图说明');
    assert.equal(code.value, 'a\tb');
});

test('restoreMarkers：只剩标记或只剩空白（含 \\t）的段落整段移除；无标记的空白段落不动', () => {
    // Arrange
    const ir = root(
        paragraph(text(indentMarker(2))),
        paragraph(text(`${MARKERS.TAB}${MARKERS.TAB}`)),
        paragraph(text('保留的正文')),
    );

    // Act
    const restored = restoreMarkers(ir);

    // Assert
    assert.equal(restored.children.length, 1);
    assert.equal(restored.children[0].children[0].value, '保留的正文');
});

test('restoreMarkers 不改动入参', () => {
    // Arrange
    const original = root(paragraph(text(`${indentMarker(2)}正文${MARKERS.TAB}尾`)));
    const snapshot = JSON.stringify(original);

    // Act
    restoreMarkers(original);

    // Assert
    assert.equal(JSON.stringify(original), snapshot);
});

test('stripMarkersTree：无残留时返回同一引用；有残留时删除标记、TAB 转 \\t', () => {
    // Arrange
    const clean = root(paragraph(text('干净的正文')));
    const dirty = root(paragraph(text(`残留${MARKERS.BR}标记${MARKERS.TAB}尾`)));

    // Act & Assert
    assert.equal(stripMarkersTree(clean), clean);
    assert.equal(stripMarkersTree(dirty).children[0].children[0].value, '残留标记\t尾');
    assert.ok(MARKER_RE.test(JSON.stringify(dirty)), '入参不变');
});

test('applyTextLayout：data.indent → 段首全角空格；\\t → 两个全角空格；代码与纯图片段不受影响', () => {
    // Arrange
    const ir = root(
        { type: 'paragraph', data: { indent: 2 }, children: [text('缩进段落')] },
        { type: 'paragraph', data: { indent: 2 }, children: [{ type: 'image', url: 'images/image_1.png', alt: '' }] },
        { type: 'paragraph', data: { indent: 1 }, children: [{ type: 'strong', children: [text('加粗开头')] }] },
        paragraph(text('图 1\t图 2'), { type: 'inlineCode', value: 'a\tb' }),
        { type: 'code', value: 'x\ty' },
    );

    // Act
    const [indented, image, strong, tab, code] = applyTextLayout(ir).children;

    // Assert
    assert.equal(indented.children[0].value, `${IDEO}${IDEO}缩进段落`);
    assert.equal(image.children.length, 1, '纯图片段不插缩进');
    assert.deepEqual(strong.children[0], text(IDEO));
    assert.equal(tab.children[0].value, `图 1${IDEO}${IDEO}图 2`);
    assert.equal(tab.children[1].value, 'a\tb');
    assert.equal(code.value, 'x\ty');
});

test('stripMarkers 删除全部标记码点', () => {
    assert.equal(stripMarkers(`${indentMarker(2)}正文${MARKERS.TAB}${MARKERS.BR}`), '正文');
    assert.equal(stripMarkers(null), '');
});
