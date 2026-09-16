/**
 * converters/raster/rasterize-nodes.js 与 raster/fragment.js 单元测试（桩后端）
 * 覆盖：table → image 节点与 JPG 资源（JFIF 密度 330、白底）、omath-<段>-<序> 命名与行内 inline 标记、
 *       patent 不缩放 / 非 patent 按 scale 与 maxWidth、后端不可用与单任务 / 整批失败的降级 + warning、
 *       入参不变与未触及节点保持引用、无命中不触碰后端、资源名冲突、片段页内容与无 http(s) 引用
 */
const { test, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { rasterizeNodes } = require('../converters/raster/rasterize-nodes');
const backend = require('../converters/raster/backend');
const { buildTableFragment, buildMathFragment } = require('../converters/raster/fragment');
const { normalizeOptions } = require('../converters/options');
const { loadJimp } = require('../converters/assets/jimp-loader');
const {
    createDocument, createRoot, createHeading, createParagraph, createText,
    createTable, createTableRow, createTableCell, createMath,
} = require('../converters/ir/schema');

const MML = '<math><mfrac><mi>a</mi><mi>b</mi></mfrac></math>';
const RED = 0xff0000ff;
const TRANSPARENT = 0x00000000;
const PNG_MIME = 'image/png';

let Jimp;
let PNG_RED;
let PNG_TRANSPARENT;

before(async () => {
    ({ Jimp } = await loadJimp());
    PNG_RED = await new Jimp({ width: 400, height: 40, color: RED }).getBuffer(PNG_MIME);
    PNG_TRANSPARENT = await new Jimp({ width: 40, height: 20, color: TRANSPARENT }).getBuffer(PNG_MIME);
});

afterEach(() => {
    backend._reset();
});

// ============================================================
// 辅助
// ============================================================

/** 注册桩后端并返回调用记录；handler 缺省为每个任务返回红色 PNG */
function stubBackend(handler = (jobs) => new Map(jobs.map((job) => [job.id, PNG_RED]))) {
    const calls = [];
    backend.registerInProcess({
        name: 'stub',
        rasterize: async (jobs, opts) => {
            calls.push({ ids: jobs.map((job) => job.id), dpi: opts.dpi, htmls: jobs.map((job) => job.html) });
            return handler(jobs, opts);
        },
    });
    return calls;
}

const table = (rows) => createTable(null, rows.map((cells) => createTableRow(cells.map((cell) => createTableCell(cell)))));

/** 段 1（两个行内公式）、表 1（段 2）、标题（段 3）、段 4（段内块级公式）、独立块级公式（段 5）、表 2（段 6） */
function sampleDoc() {
    return createDocument({
        ir: createRoot([
            createParagraph([createText('前 '), createMath({ mathml: MML, text: 'a/b' }), createText(' 中 '), createMath({ text: 'x+1' }), createText(' 后')]),
            table([['甲', '乙'], ['1', '2']]),
            createHeading(2, '标题'),
            createParagraph([createMath({ text: 'E=mc^2', display: true })]),
            createMath({ mathml: MML, text: 'a/b', display: true }),
            table([['丙']]),
        ]),
        meta: { title: '样例', sourceType: 'docx' },
        assets: [{ name: 'images/image_1.jpg', buffer: Buffer.from('x'), mime: 'image/jpeg' }],
    });
}

/** JFIF APP0 紧跟 SOI：units 在偏移 13，X/Y 密度在 14/16 */
function readJfif(buf) {
    assert.deepEqual([buf[0], buf[1], buf[2], buf[3]], [0xFF, 0xD8, 0xFF, 0xE0]);
    assert.equal(buf.subarray(6, 10).toString('latin1'), 'JFIF');
    return { units: buf[13], x: buf.readUInt16BE(14), y: buf.readUInt16BE(16) };
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
}

/** 去掉 XML 命名空间声明后不得再出现 http(s) 引用 */
function assertNoRemote(html) {
    const stripped = html.replace(/xmlns(?::\w+)?="http:\/\/www\.w3\.org\/[^"]*"/g, '');
    assert.ok(!/https?:\/\//i.test(stripped), 'fragment 不得引用 http(s) 资源');
}

const dims = (node) => ({ width: node.data.width, height: node.data.height, dpi: node.data.dpi });

// ============================================================
// rasterizeNodes
// ============================================================

test('table → image 节点与 JPG 资源：命名 table-<序>、role table、JFIF 密度 330、math 节点不受影响', async () => {
    // Arrange
    const calls = stubBackend();
    const doc = sampleDoc();

    // Act
    const result = await rasterizeNodes(doc, { kinds: ['table'], options: normalizeOptions({ xml: { profile: 'patent' } }) });

    // Assert
    assert.equal(result.backend, 'stub');
    assert.equal(result.rasterized, 2);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(calls[0].ids, ['table-1', 'table-2']);
    assert.equal(calls[0].dpi, 300);
    assert.ok(calls[0].htmls[0].includes('<table>'), '表格任务的 html 为表格片段页');

    const children = result.doc.ir.children;
    assert.equal(children[1].type, 'image');
    assert.equal(children[1].url, 'images/table-1.jpg');
    assert.equal(children[1].alt, '表格 1');
    assert.deepEqual(children[1].data, { assetName: 'images/table-1.jpg', role: 'table', inline: false, width: 400, height: 40, dpi: 330 });
    assert.equal(children[5].url, 'images/table-2.jpg');
    assert.equal(children[0], doc.ir.children[0], '未命中的段落沿用原引用');

    assert.equal(result.doc.assets.length, 3);
    assert.equal(result.doc.assets[0].name, 'images/image_1.jpg');
    const asset = result.doc.assets[1];
    assert.equal(asset.name, 'images/table-1.jpg');
    assert.equal(asset.mime, 'image/jpeg');
    assert.deepEqual(readJfif(asset.buffer), { units: 1, x: 330, y: 330 });
    assert.equal(result.doc.assets[2].name, 'images/table-2.jpg');
});

test('math → image 节点：omath-<段>-<序> 编号、行内公式 inline 为 true、alt 为线性化文本、表格不受影响', async () => {
    // Arrange
    const calls = stubBackend();
    const doc = sampleDoc();

    // Act
    const result = await rasterizeNodes(doc, { kinds: ['math'], options: normalizeOptions({}) });

    // Assert
    assert.equal(result.rasterized, 4);
    assert.deepEqual(calls[0].ids, ['omath-1-1', 'omath-1-2', 'omath-4-1', 'omath-5-1'], '表格整张占一个段号');
    assert.ok(calls[0].htmls.every((html) => html.includes('mml-svg.js')), '公式任务的 html 引用本地 MathJax');
    assert.deepEqual(result.doc.assets.slice(1).map((asset) => asset.name), ['images/omath-1-1.jpg', 'images/omath-1-2.jpg', 'images/omath-4-1.jpg', 'images/omath-5-1.jpg']);

    const children = result.doc.ir.children;
    const p1 = children[0];
    assert.deepEqual(p1.children.map((node) => node.type), ['text', 'image', 'text', 'image', 'text']);
    assert.equal(p1.children[1].url, 'images/omath-1-1.jpg');
    assert.equal(p1.children[1].alt, 'a/b');
    assert.deepEqual(p1.children[1].data, { assetName: 'images/omath-1-1.jpg', role: 'formula', inline: true, width: 400, height: 40, dpi: 330 });
    assert.equal(p1.children[3].url, 'images/omath-1-2.jpg');
    assert.equal(p1.children[3].data.inline, true);
    assert.equal(children[1], doc.ir.children[1], '表格沿用原引用');
    assert.equal(children[2], doc.ir.children[2], '标题沿用原引用');
    assert.equal(children[3].children[0].type, 'image');
    assert.equal(children[3].children[0].data.inline, false, '段内块级公式不算行内');
    assert.equal(children[4].type, 'image');
    assert.equal(children[4].url, 'images/omath-5-1.jpg');
    assert.equal(children[4].data.inline, false);
    assert.equal(children[4].alt, 'a/b');
});

test('patent profile 按 imageDpi 出图且不缩放；JPEG 统一写入 jpegPpi 密度，非 patent 仍按 raster.scale 出图并按 maxWidth 限宽', async () => {
    // Arrange
    const doc = createDocument({ ir: createRoot([table([['甲']])]) });
    const run = async (raw) => {
        backend._reset();
        const calls = stubBackend();
        const result = await rasterizeNodes(doc, { kinds: ['table'], options: normalizeOptions(raw) });
        return { dpi: calls[0].dpi, node: result.doc.ir.children[0], asset: result.doc.assets[0] };
    };

    // Act
    const patent = await run({ xml: { profile: 'patent', patent: { imageDpi: 150 } }, raster: { scale: 1, maxWidth: 200 } });
    const limited = await run({ raster: { scale: 1, maxWidth: 200 } });
    const scaled = await run({ raster: { scale: 3 } });

    // Assert
    assert.equal(patent.dpi, 150);
    assert.deepEqual(dims(patent.node), { width: 400, height: 40, dpi: 330 });
    assert.deepEqual(readJfif(patent.asset.buffer), { units: 1, x: 330, y: 330 });

    assert.equal(limited.dpi, 96);
    assert.deepEqual(dims(limited.node), { width: 200, height: 20, dpi: 330 });
    assert.deepEqual(readJfif(limited.asset.buffer), { units: 1, x: 330, y: 330 });

    assert.equal(scaled.dpi, 288);
    assert.deepEqual(dims(scaled.node), { width: 400, height: 40, dpi: 330 });
    assert.deepEqual(readJfif(scaled.asset.buffer), { units: 1, x: 330, y: 330 });
});

test('后端不可用：表格降级为逐行文本、公式降级为线性化文本，附一条中文 warning，backend 为 null', async () => {
    // Arrange
    backend._setDeps({ electronPath: null });

    // Act
    const result = await rasterizeNodes(sampleDoc(), { kinds: ['table', 'math'], options: normalizeOptions({ xml: { profile: 'patent' } }) });

    // Assert
    assert.equal(result.backend, null);
    assert.equal(result.rasterized, 0);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^栅格化后端不可用：/);
    assert.match(result.warnings[0], /2 个表格降级为逐行文本/);
    assert.match(result.warnings[0], /4 个公式降级为线性化文本/);

    const children = result.doc.ir.children;
    assert.deepEqual(children[0], createParagraph([createText('前 '), createText('a/b'), createText(' 中 '), createText('x+1'), createText(' 后')]));
    assert.deepEqual(children[1], createParagraph([createText('甲 | 乙')]));
    assert.deepEqual(children[2], createParagraph([createText('1 | 2')]));
    assert.equal(children[3].type, 'heading');
    assert.deepEqual(children[4], createParagraph([createText('E=mc^2')]), '段内块级公式降级为文本');
    assert.deepEqual(children[5], createParagraph([createText('a/b')]), '独立块级公式降级为段落');
    assert.deepEqual(children[6], createParagraph([createText('丙')]));
    assert.equal(result.doc.assets.length, 1);
});

test('单任务失败只降级该节点并 warning，其余照常栅格', async () => {
    // Arrange
    stubBackend((jobs) => new Map(jobs.map((job) => [job.id, job.id === 'table-1' ? new Error('模拟失败') : PNG_RED])));

    // Act
    const result = await rasterizeNodes(sampleDoc(), { kinds: ['table'], options: normalizeOptions({ xml: { profile: 'patent' } }) });

    // Assert
    assert.equal(result.rasterized, 1);
    assert.equal(result.backend, 'stub');
    assert.deepEqual(result.warnings, ['栅格化失败：表格 table-1（模拟失败），已降级为逐行文本']);
    const children = result.doc.ir.children;
    assert.deepEqual(children[1], createParagraph([createText('甲 | 乙')]));
    assert.deepEqual(children[2], createParagraph([createText('1 | 2')]));
    assert.equal(children[6].type, 'image');
    assert.equal(children[6].url, 'images/table-2.jpg');
    assert.deepEqual(result.doc.assets.map((asset) => asset.name), ['images/image_1.jpg', 'images/table-2.jpg']);
});

test('整批失败（后端抛错）：全部降级并附 warning，backend 记录为实际调用的后端', async () => {
    // Arrange
    stubBackend(() => { throw new Error('boom'); });

    // Act
    const result = await rasterizeNodes(sampleDoc(), { kinds: ['table', 'math'], options: normalizeOptions({}) });

    // Assert
    assert.equal(result.rasterized, 0);
    assert.equal(result.backend, 'stub');
    assert.deepEqual(result.warnings, ['栅格化失败：boom；已将 2 个表格降级为逐行文本、4 个公式降级为线性化文本']);
    assert.equal(result.doc.ir.children.filter((node) => node.type === 'image').length, 0);
});

test('不修改入参：深冻结的 doc 也能处理，未触及的节点沿用原引用', async () => {
    // Arrange
    stubBackend();
    const doc = deepFreeze(sampleDoc());
    const snapshot = JSON.stringify(doc);

    // Act
    const result = await rasterizeNodes(doc, { kinds: ['table'], options: normalizeOptions({}) });

    // Assert
    assert.equal(JSON.stringify(doc), snapshot, '入参未被改动');
    assert.notEqual(result.doc, doc);
    assert.equal(result.doc.ir.children[0], doc.ir.children[0]);
    assert.equal(result.doc.ir.children[2], doc.ir.children[2]);
    assert.equal(result.doc.assets[0], doc.assets[0]);
});

test('kinds 为空、未知或无命中节点时原样返回且不触碰后端', async () => {
    // Arrange
    const calls = stubBackend();
    const plain = createDocument({ ir: createRoot([createParagraph('纯文本')]) });

    // Act
    const noHit = await rasterizeNodes(plain, { kinds: ['table', 'math'], options: normalizeOptions({}) });
    const noKinds = await rasterizeNodes(sampleDoc(), { kinds: [], options: normalizeOptions({}) });
    const unknown = await rasterizeNodes(sampleDoc(), { kinds: ['image'], options: normalizeOptions({}) });

    // Assert
    assert.equal(noHit.doc, plain);
    assert.deepEqual({ rasterized: noHit.rasterized, warnings: noHit.warnings, backend: noHit.backend }, { rasterized: 0, warnings: [], backend: null });
    assert.equal(noKinds.backend, null);
    assert.equal(unknown.backend, null);
    assert.equal(calls.length, 0, '无命中时不得调用后端');
});

test('资源名与既有 assets 冲突时追加 -2 后缀', async () => {
    // Arrange
    stubBackend();
    const doc = createDocument({
        ir: createRoot([table([['甲']])]),
        assets: [{ name: 'images/table-1.jpg', buffer: Buffer.from('x'), mime: 'image/jpeg' }],
    });

    // Act
    const result = await rasterizeNodes(doc, { kinds: ['table'], options: normalizeOptions({}) });

    // Assert
    assert.equal(result.doc.ir.children[0].url, 'images/table-1-2.jpg');
    assert.equal(result.doc.ir.children[0].data.assetName, 'images/table-1-2.jpg');
    assert.deepEqual(result.doc.assets.map((asset) => asset.name), ['images/table-1.jpg', 'images/table-1-2.jpg']);
});

test('透明 PNG 铺白后转 JPG：像素为白色', async () => {
    // Arrange
    stubBackend((jobs) => new Map(jobs.map((job) => [job.id, PNG_TRANSPARENT])));

    // Act
    const result = await rasterizeNodes(createDocument({ ir: createRoot([table([['甲']])]) }), { kinds: ['table'], options: normalizeOptions({}) });

    // Assert
    const image = await Jimp.read(result.doc.assets[0].buffer);
    assert.equal(image.width, 40);
    assert.equal(image.height, 20);
    const [r, g, b] = image.bitmap.data.subarray(0, 3);
    assert.ok(r > 240 && g > 240 && b > 240, `左上像素应为白色，实际 ${r},${g},${b}`);
});

// ============================================================
// fragment
// ============================================================

test('表格片段：表头、对齐、字体栈与转义文本，不引用 http(s) 资源', () => {
    // Arrange
    const node = createTable(['left', 'center', 'right'], [
        createTableRow([createTableCell('a'), createTableCell('b'), createTableCell('c')]),
        createTableRow([
            createTableCell('<script>alert(1)</script>'),
            createTableCell([{ type: 'html', value: '<b>粗</b>' }]),
            createTableCell([{ type: 'strong', children: [createText('强')] }, { type: 'break' }, createText('次行')]),
        ]),
    ]);

    // Act
    const html = buildTableFragment(node);

    // Assert
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('<thead><tr><th>a</th><th style="text-align:center">b</th><th style="text-align:right">c</th></tr></thead>'), html);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>alert'));
    assert.ok(html.includes('<td style="text-align:center">粗</td>'), 'html 节点先去标签再转义');
    assert.ok(html.includes('<td style="text-align:right"><b>强</b><br>次行</td>'));
    assert.ok(html.includes('font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif'));
    assert.ok(html.includes('font-size:12pt'));
    assert.ok(html.includes('width:max-content'));
    assert.ok(html.includes('padding:4pt'));
    assert.ok(html.includes('border:1px solid #000'));
    assert.ok(html.includes('background:#fff'));
    assert.ok(html.includes('body{display:inline-block'));
    assert.ok(html.includes('Content-Security-Policy'));
    assertNoRemote(html);

    assert.ok(buildTableFragment(createTable(null, []), { fontFamily: '"Songti SC",serif' }).includes('font-family:"Songti SC",serif'));
    assert.ok(buildTableFragment(createTable(null, []), { fontFamily: 'x;}<script>' }).includes('"PingFang SC"'), '非法字体栈回退默认');
});

test('公式片段：本地 MathJax 脚本与字体路径、display 归一、就绪钩子与 nonce CSP，不安全或缺失的 MathML 回退为 mtext', () => {
    // Arrange
    const mathml = '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mfrac><mi>a</mi><mi>b</mi></mfrac></math>';

    // Act
    const display = buildMathFragment(createMath({ mathml, text: 'a/b', display: true }));
    const inline = buildMathFragment(createMath({ mathml, text: 'a/b', display: true }), { display: false });
    const fallback = buildMathFragment(createMath({ text: 'E=mc^2 <x>' }));
    const unsafe = buildMathFragment(createMath({ mathml: '<math><mi>a</mi><script>alert(1)</script></math>', text: 'a', display: true }));

    // Assert
    assert.ok(display.includes('<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mfrac>'), display);
    assert.match(display, /<script nonce="[^"]+" src="file:\/\/\/[^"]*mathjax\/mml-svg\.js"><\/script>/);
    assert.match(display, /"fontPath":"file:\/\/\/[^"]*@mathjax\/mathjax-newcm-font"/);
    assert.ok(display.includes('"font":"mathjax-newcm"'));
    assert.ok(display.includes('"fontCache":"local"'));
    assert.ok(display.includes('"enableMenu":false'));
    assert.ok(display.includes('window.__markflowReady=function()'));
    assert.match(display, /script-src file: 'nonce-[A-Za-z0-9+/=]+'/);
    assert.ok(display.includes("worker-src file: blob:"));
    assert.ok(display.includes('"STIX Two Math","Cambria Math",serif'));
    assertNoRemote(display);

    assert.ok(inline.includes('<math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac>'), '行内渲染时去掉 display 属性');
    assert.ok(!inline.includes('display="block"'));

    assert.ok(fallback.includes('<mtext>E=mc^2 &lt;x&gt;</mtext>'), '无 MathML 时以 mtext 包裹转义后的线性化文本');
    assert.ok(!fallback.includes('display="block"'));
    assert.ok(unsafe.includes('<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mtext>a</mtext></math>'));
    assert.ok(!unsafe.includes('<script>alert'));
    assertNoRemote(fallback);
});
