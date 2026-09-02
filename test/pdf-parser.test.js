/**
 * converters/parsers/pdf.js 单元测试
 * 覆盖：{ path } 契约、kind/meta 字段、文本抽取、data 不再快照整页文本、
 *       pdfjs 只走 legacy ESM build（不再 require 不存在的 pdf.js）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const parserPath = path.resolve(__dirname, '../converters/parsers/pdf.js');
const { parse } = require(parserPath);

const SAMPLE_PDF = path.resolve(__dirname, 'fixtures/sample.pdf');

// ============================================================
// IR 遍历辅助
// ============================================================

function collect(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) {
        for (const child of node.children) collect(child, predicate, out);
    }
    return out;
}

function plainText(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.type === 'text' || node.type === 'inlineCode') return String(node.value || '');
    if (!Array.isArray(node.children)) return '';
    return node.children.map(plainText).join('');
}

// ============================================================
// 用例
// ============================================================

test('按路径解析 PDF，得到含文本的 IR 与 document kind', async () => {
    // Arrange & Act
    const doc = await parse({ path: SAMPLE_PDF });

    // Assert
    assert.equal(doc.kind, 'document');
    const paragraphs = collect(doc.ir, (n) => n.type === 'paragraph');
    assert.ok(paragraphs.length >= 2, `应至少抽出 2 个段落，实际 ${paragraphs.length}`);
    const text = paragraphs.map(plainText).join('\n');
    assert.match(text, /MarkFlow sample document/);
    assert.match(text, /second line/);
});

test('PDF 无内嵌 Title 时 meta.title 回退为去扩展名的文件名', async () => {
    // Arrange & Act
    const doc = await parse({ path: SAMPLE_PDF });

    // Assert
    assert.equal(doc.meta.title, 'sample');
    assert.equal(doc.meta.sourceType, 'pdf');
    assert.equal(doc.meta.sourceName, 'sample.pdf');
});

test('ctx.sourceName 覆盖文件名，并参与 title 回退', async () => {
    // Arrange & Act
    const doc = await parse({ path: SAMPLE_PDF }, { sourceName: '季度报告.pdf' });

    // Assert
    assert.equal(doc.meta.sourceName, '季度报告.pdf');
    assert.equal(doc.meta.title, '季度报告');
});

test('data 只保留轻量元信息，不快照整页文本；assets 为空数组', async () => {
    // Arrange & Act
    const doc = await parse({ path: SAMPLE_PDF });

    // Assert
    assert.equal(doc.data.numPages, 1);
    assert.equal(doc.data.pages, undefined, 'data 不应再包含整页文本快照');
    assert.deepEqual(doc.data.pageLineCounts, [2]);
    assert.deepEqual(doc.assets, []);
    assert.deepEqual(doc.warnings, []);
});

test('相对路径输入被解析为绝对路径', async () => {
    // Arrange
    const relative = path.relative(process.cwd(), SAMPLE_PDF);

    // Act
    const doc = await parse({ path: relative });

    // Assert
    assert.equal(doc.meta.sourceName, 'sample.pdf');
    assert.equal(doc.kind, 'document');
});

test('缺少 input.path 时抛出中文错误', async () => {
    // Arrange & Act & Assert
    await assert.rejects(() => parse({}), /parsers\/pdf 需要 input\.path/);
});

test('源文件不存在时抛出 ENOENT', async () => {
    // Arrange
    const missing = path.join(os.tmpdir(), 'markflow-not-exist-xyz.pdf');

    // Act & Assert
    await assert.rejects(() => parse({ path: missing }), (err) => err.code === 'ENOENT');
});

test('onProgress 回调抛错不影响解析', async () => {
    // Arrange
    const calls = [];

    // Act
    const doc = await parse(
        { path: SAMPLE_PDF },
        {
            onProgress: (phase, pct) => {
                calls.push([phase, pct]);
                throw new Error('调用方回调故意抛错');
            },
        },
    );

    // Assert
    assert.ok(calls.length >= 1);
    assert.equal(calls[0][0], 'parse');
    assert.equal(doc.kind, 'document');
});

test('源码不再引用已不存在的 legacy/build/pdf.js', () => {
    // Arrange
    const source = fs.readFileSync(parserPath, 'utf8');

    // Assert
    assert.ok(
        !source.includes('legacy/build/pdf.js'),
        'pdfjs-dist 4.x 未发布 legacy/build/pdf.js，不应再引用',
    );
    assert.ok(source.includes('legacy/build/pdf.mjs'));
});
