/**
 * converters/ir/inline-html.js 单元测试
 * 覆盖：<img> 提升（块级与行内、宽高与百分比、style 宽度、属性白名单）、src 协议白名单（脚本协议、实体编码与
 *       控制字符绕过、协议相对与绝对路径）、<u>/<strong|b>/<em|i>/<del|s>/<br> 配对提升、未配对标签删除留文本、
 *       同类嵌套拍平与相邻合并、只包图片的格式标签拆除、<figure>/<p> 包图与 figcaption 图注、其它 HTML 保留、
 *       无可提升内容时返回原引用、入参不变
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadUnified } = require('../converters/ir/unified-loader');
const { liftInlineHtml, decodeEntities } = require('../converters/ir/inline-html');

async function parseMarkdown(md) {
    const { unified, remarkParse, remarkGfm } = await loadUnified();
    return unified().use(remarkParse).use(remarkGfm).parse(md);
}

async function lift(md, options) {
    return liftInlineHtml(await parseMarkdown(md), options);
}

function collect(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) for (const child of node.children) collect(child, predicate, out);
    return out;
}

const images = (tree) => collect(tree, (n) => n.type === 'image');
const htmls = (tree) => collect(tree, (n) => n.type === 'html').map((n) => n.value);

// ============================================================
// <img>
// ============================================================

test('独占一行的 <img> 提升为段落中的 image 节点，宽度记入 data.display', async () => {
    // Act
    const tree = await lift('<img src="images/a.png" width="300" alt="示意 &amp; 说明" title="标题">\n\n正文\n', { source: 'html' });

    // Assert
    assert.equal(tree.children[0].type, 'paragraph');
    const [image] = tree.children[0].children;
    assert.deepEqual(image, {
        type: 'image', url: 'images/a.png', alt: '示意 & 说明', title: '标题',
        data: { display: { width: 300, unit: 'px', source: 'html' } },
    });
    assert.deepEqual(htmls(tree), []);
});

test('行内 <img>：宽高都是 px 时记 height；百分比宽度记为 %；style 中的 width:Npx 同样认', async () => {
    // Act
    const tree = await lift([
        '甲<img src="a.png" width="120" height="60">乙',
        '',
        '丙<img src="b.png" width="50%" height="40">丁',
        '',
        '戊<img src="c.png" style="height: 30px; width: 88.6px">己',
        '',
    ].join('\n'), { source: 'web' });

    // Assert
    const displays = images(tree).map((n) => n.data && n.data.display);
    assert.deepEqual(displays, [
        { width: 120, height: 60, unit: 'px', source: 'web' },
        { width: 50, unit: '%', source: 'web' },
        { width: 89, height: 30, unit: 'px', source: 'web' },
    ]);
    assert.deepEqual(tree.children[0].children.map((n) => n.type), ['text', 'image', 'text']);
});

test('不合规的宽度不记 display；白名单外的属性（onerror、class）一律丢弃', async () => {
    // Act
    const tree = await lift('<img src="a.png" width="300px" onerror="alert(1)" class="x" data-foo="1">\n');

    // Assert
    const [image] = images(tree);
    assert.deepEqual(Object.keys(image).sort(), ['alt', 'title', 'type', 'url']);
    assert.equal(image.url, 'a.png');
    assert.equal(JSON.stringify(tree).includes('alert'), false);
});

test('src 协议白名单：脚本协议、实体编码与控制字符绕过、协议相对地址与绝对路径均不提升，原样保留为 html', async () => {
    // Arrange
    const rejected = [
        '<img src="javascript:alert(1)">',
        '<img src="JaVaScRiPt:alert(1)">',
        '<img src="&#106;avascript:alert(1)">',
        '<img src="java&#x09;script:alert(1)">',
        '<img src="vbscript:msgbox(1)">',
        '<img src="data:text/html;base64,PHNjcmlwdD4=">',
        '<img src="//evil.example/x.png">',
        '<img src="/etc/passwd">',
        '<img src="file:///etc/passwd">',
        '<img width="10">',
    ];

    for (const tag of rejected) {
        // Act
        const tree = await lift(`${tag}\n`);

        // Assert
        assert.equal(images(tree).length, 0, tag);
        assert.equal(htmls(tree).length, 1, tag);
    }
});

test('src 白名单放行相对路径、http(s) 与 data:image/*', async () => {
    // Act
    const tree = await lift([
        '<img src="images/图 片.png">', '',
        '<img src="https://example.com/a.png?x=1&amp;y=2">', '',
        '<img src="data:image/png;base64,iVBORw0KGgo=">', '',
    ].join('\n'));

    // Assert
    assert.deepEqual(images(tree).map((n) => n.url), [
        'images/图 片.png',
        'https://example.com/a.png?x=1&y=2',
        'data:image/png;base64,iVBORw0KGgo=',
    ]);
});

// ============================================================
// 行内格式标签
// ============================================================

test('成对的 <u>/<strong>/<b>/<em>/<i>/<del>/<s> 提升为对应节点，<br> 为 break', async () => {
    // Act
    const tree = await lift('<u>下划线</u>、<strong>粗</strong><b>体</b>、<em>斜</em><i>体</i>、<del>删</del><s>除</s>、甲<br>乙\n');
    const types = tree.children[0].children.map((n) => n.type);

    // Assert：相邻的同类节点已合并（<strong>粗</strong><b>体</b> → 一个 strong）
    assert.deepEqual(types, ['underline', 'text', 'strong', 'text', 'emphasis', 'text', 'delete', 'text', 'break', 'text']);
    const strong = tree.children[0].children[2];
    assert.deepEqual(strong.children, [{ type: 'text', value: '粗体' }]);
    assert.deepEqual(htmls(tree), []);
});

test('未配对的标签删除、保留其间文本；中途被关闭的开标签视为未配对', async () => {
    // Act
    const unclosed = await lift('前<u>没有闭合的下划线\n');
    const stray = await lift('多余的</strong>闭标签\n');
    const crossed = await lift('<u>甲<strong>乙</u>丙</strong>\n');

    // Assert
    assert.deepEqual(unclosed.children[0].children, [{ type: 'text', value: '前没有闭合的下划线' }]);
    assert.deepEqual(stray.children[0].children, [{ type: 'text', value: '多余的闭标签' }]);
    const crossedTypes = crossed.children[0].children.map((n) => n.type);
    assert.deepEqual(crossedTypes, ['underline', 'text']);
    assert.deepEqual(crossed.children[0].children[0].children, [{ type: 'text', value: '甲乙' }]);
});

test('同类嵌套拍平；只包着图片的格式标签直接拆除', async () => {
    // Act
    const nested = await lift('<strong>外<strong>内</strong>尾</strong>\n');
    const wrappedImage = await lift('<strong><img src="a.png" width="677"></strong>\n');

    // Assert
    const [strong] = nested.children[0].children;
    assert.equal(strong.type, 'strong');
    assert.deepEqual(strong.children, [{ type: 'text', value: '外内尾' }]);
    assert.deepEqual(wrappedImage.children[0].children.map((n) => n.type), ['image']);
});

test('链接与表格单元格内的行内 HTML 同样提升', async () => {
    // Act
    const tree = await lift('[<u>链接</u>](https://example.com)\n\n| A |\n| --- |\n| <strong>格</strong> |\n');

    // Assert
    const link = collect(tree, (n) => n.type === 'link')[0];
    assert.equal(link.children[0].type, 'underline');
    const cell = collect(tree, (n) => n.type === 'tableCell')[1];
    assert.equal(cell.children[0].type, 'strong');
});

// ============================================================
// 块级包裹
// ============================================================

test('<figure> 只包着 img 与 figcaption：拆成图片段落 + 图注段落（data.role = caption）', async () => {
    // Act
    const tree = await lift('<figure><img src="a.png" width="400"><figcaption>图 1 <b>示意</b>图</figcaption></figure>\n');

    // Assert
    assert.equal(tree.children.length, 2);
    assert.equal(tree.children[0].children[0].type, 'image');
    assert.deepEqual(tree.children[1], { type: 'paragraph', data: { role: 'caption' }, children: [{ type: 'text', value: '图 1 示意 图' }] });
});

test('<p> / <div> 只包着 img 与 br 时提升；夹杂其它内容时保留为 html', async () => {
    // Act
    const wrapped = await lift('<p align="center"><img src="a.png"><br><img src="b.png"></p>\n');
    const mixed = await lift('<div><img src="a.png"><span>文字</span></div>\n');

    // Assert
    assert.deepEqual(wrapped.children[0].children.map((n) => n.type), ['image', 'break', 'image']);
    assert.equal(images(mixed).length, 0);
    assert.equal(htmls(mixed).length, 1);
});

test('白名单外的 HTML（script、span、注释）保留为 html 节点，交渲染器剥离', async () => {
    // Act
    const tree = await lift('<script>alert(1)</script>\n\n正文<span style="x">甲</span>\n');

    // Assert
    assert.ok(htmls(tree).some((value) => value.includes('<script>')));
    assert.ok(htmls(tree).includes('<span style="x">'));
});

test('无可提升内容时返回原引用；入参树不被改动', async () => {
    // Arrange
    const plain = await parseMarkdown('# 标题\n\n**粗体** 正文\n');
    const withHtml = await parseMarkdown('<u>下划线</u>\n');
    const snapshot = JSON.stringify(withHtml);

    // Act
    const same = liftInlineHtml(plain);
    liftInlineHtml(withHtml);

    // Assert
    assert.equal(same, plain);
    assert.equal(JSON.stringify(withHtml), snapshot);
});

test('decodeEntities 解码命名与数字实体，未知实体原样保留', () => {
    assert.equal(decodeEntities('&lt;a&gt; &amp; &quot;&#39;&#x4E2D;&#25991; &copy;'), '<a> & "\'中文 &copy;');
});
