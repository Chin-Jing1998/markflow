/**
 * converters/ir/captions.js 的大图拆段分组标记单元测试
 * 覆盖：splitImageParagraphs 给同一原段落拆出的各块写同值 data.splitGroup、按文档顺序递增、未被拆的段落不写该键、
 *       入参不变；markCaptions 经同一条拆段，图注识别不受影响且图注段不带该键；
 *       md / html / docx 三个渲染器对「带与不带 splitGroup」的同一棵树产出相同（docx 只有内含生成时刻的
 *       docProps/core.xml 一项随时间变化，其余条目逐字节相同）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');

const { splitImageParagraphs, markCaptions } = require('../converters/ir/captions');
const mdRenderer = require('../converters/renderers/md');
const htmlRenderer = require('../converters/renderers/html');
const docxRenderer = require('../converters/renderers/docx');
const { normalizeOptions } = require('../converters/options');

// 大图阈值为 200 px，取 300 px 确保被拆
const BIG_PX = 300;
// docx 的 docProps/core.xml 写入生成时刻，同一棵树两次渲染也不相同，故比对时排除
const VOLATILE_DOCX_ENTRY = 'docProps/core.xml';

const text = (value) => ({ type: 'text', value });
const paragraph = (...children) => ({ type: 'paragraph', children });
const root = (...children) => ({ type: 'root', children });

const bigImage = (url, extra = {}) => ({
    type: 'image', url, alt: '', data: { display: { width: BIG_PX, height: 100, unit: 'px' }, ...extra },
});
const floatingImage = (url) => bigImage(url, { floating: true });

const groupsOf = (tree) => tree.children.map((node) => (node.data ? node.data.splitGroup : undefined));

/** 去掉 data.splitGroup，键去空后连 data 一并去掉：还原成未打标记时的同一棵树 */
function stripSplitGroup(node) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.children)) return node;
    const children = node.children.map(stripSplitGroup);
    if (!node.data || !Object.hasOwn(node.data, 'splitGroup')) return { ...node, children };
    const { splitGroup, ...rest } = node.data;
    const out = { ...node, children };
    if (Object.keys(rest).length > 0) out.data = rest;
    else delete out.data;
    return out;
}

const makeDoc = (ir) => ({
    schemaVersion: 1, kind: 'document', ir, data: null,
    meta: { title: '拆段分组测试', sourceType: 'md' }, assets: [], warnings: [],
});

/** docx 解包为「条目名 → base64 内容」，排除随时间变化的条目 */
async function stableEntries(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const out = {};
    for (const name of Object.keys(zip.files).sort()) {
        if (name === VOLATILE_DOCX_ENTRY) continue;
        out[name] = (await zip.files[name].async('nodebuffer')).toString('base64');
    }
    return out;
}

// ============================================================
// splitGroup
// ============================================================

test('splitImageParagraphs：同一原段落拆出的各块写同值 splitGroup，未被拆的段落不写该键', () => {
    const tree = root(
        paragraph(text('前一段。')),
        paragraph(text('按下式计算：'), bigImage('a.png')),
        paragraph(text('后一段。')),
    );
    const out = splitImageParagraphs(tree);

    assert.equal(out.children.length, 4);
    assert.deepEqual(groupsOf(out), [undefined, 1, 1, undefined]);
    assert.equal(out.children[1].children.length, 1);
    assert.equal(out.children[1].children[0].type, 'text');
    assert.equal(out.children[2].children[0].type, 'image');
});

test('splitImageParagraphs：不同原段落拆出的块分组号不同，按文档顺序递增', () => {
    const tree = root(
        paragraph(text('甲段：'), bigImage('a.png')),
        paragraph(text('未被拆的一段。')),
        paragraph(bigImage('b.png'), text('乙段。')),
    );
    const out = splitImageParagraphs(tree);

    assert.deepEqual(groupsOf(out), [1, 1, undefined, 2, 2]);
});

test('splitImageParagraphs：浮动图与段尾大图同属一组；段中间的大图不拆，也不写 splitGroup', () => {
    const floating = root(paragraph(text('标签段'), floatingImage('f.png')));
    assert.deepEqual(groupsOf(splitImageParagraphs(floating)), [1, 1]);

    const middle = root(paragraph(text('前'), bigImage('m.png'), text('后')));
    const out = splitImageParagraphs(middle);
    assert.equal(out.children.length, 1);
    assert.equal(out.children[0].data, undefined);
});

test('splitImageParagraphs：既有 data 的键保留，入参不改动', () => {
    const tree = root(paragraph(text('正文：'), bigImage('a.png')));
    tree.children[0].data = { role: 'body' };
    const before = JSON.stringify(tree);

    const out = splitImageParagraphs(tree);

    assert.deepEqual(out.children[0].data, { role: 'body', splitGroup: 1 });
    assert.deepEqual(out.children[1].data, { splitGroup: 1 });
    assert.equal(JSON.stringify(tree), before, '入参不变');
});

test('markCaptions：图注识别不受影响，图注段不带 splitGroup', () => {
    const tree = root(
        paragraph(text('前言：'), bigImage('a.png')),
        paragraph(text('图 1 示意图')),
    );
    const out = markCaptions(tree);

    assert.deepEqual(groupsOf(out), [1, 1, undefined]);
    assert.equal(out.children[2].data.role, 'caption');
});

// ============================================================
// 其它渲染器不受影响
// ============================================================

test('md / html / docx：带与不带 splitGroup 的同一棵树产出相同', async () => {
    const tree = root(
        paragraph(text('按下式计算：'), bigImage('pic.png')),
        paragraph(text('后一段。')),
    );
    const withGroup = splitImageParagraphs(tree);
    const without = stripSplitGroup(withGroup);
    assert.deepEqual(groupsOf(withGroup), [1, 1, undefined]);
    assert.deepEqual(groupsOf(without), [undefined, undefined, undefined]);

    assert.equal(await mdRenderer.render(makeDoc(withGroup)), await mdRenderer.render(makeDoc(without)));

    const options = normalizeOptions({});
    assert.equal(
        await htmlRenderer.render(makeDoc(withGroup), options, {}),
        await htmlRenderer.render(makeDoc(without), options, {}),
    );

    const a = await stableEntries(await docxRenderer.render(makeDoc(withGroup), options));
    const b = await stableEntries(await docxRenderer.render(makeDoc(without), options));
    assert.deepEqual(a, b);
});
