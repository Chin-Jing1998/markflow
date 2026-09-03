/**
 * Markdown 输入自带 YAML front matter 的处理
 *
 * 覆盖两层：
 *   1) parsers/md 层 —— front matter 被摘掉（IR 里不出现 YAML 文本与多余分隔线），
 *      键值合并进 meta，其中 title 显式给出时优先于首个 H1；
 *   2) 端到端 md → docx —— DOCX 正文里不含任何 YAML 残留。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');

const { parse } = require('../converters/parsers/md');
const { convert } = require('../converters');

const FRONT_MATTER_MD = [
    '---',
    'title: 元数据里的标题',
    'author: 王五',
    'date: 2026-05-06',
    'tags: [知识库, 转换]',
    'draft: false',
    '---',
    '',
    '# 正文里的一级标题',
    '',
    '正文段落。',
    '',
].join('\n');

function collect(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) {
        for (const child of node.children) collect(child, predicate, out);
    }
    return out;
}

const allLiterals = (ir) => collect(ir, (n) => typeof n.value === 'string').map((n) => n.value).join('\n');

function makeTempDir(prefix) {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// ============================================================
// parser 层
// ============================================================

test('front matter 被剥离：IR 首个节点是标题而非分隔线，正文里没有 YAML 文本', async () => {
    // Act
    const doc = await parse({ text: FRONT_MATTER_MD }, { baseDir: os.tmpdir() });

    // Assert
    assert.equal(doc.ir.children[0].type, 'heading');
    assert.equal(collect(doc.ir, (n) => n.type === 'thematicBreak').length, 0);
    const literals = allLiterals(doc.ir);
    for (const leaked of ['title:', 'author:', 'tags:', '王五', '知识库']) {
        assert.ok(!literals.includes(leaked), `YAML 内容不应进入正文：${leaked}\n实际：${literals}`);
    }
});

test('front matter 显式给出 title 时优先于首个 H1，其余键合并进 meta', async () => {
    // Act
    const doc = await parse({ text: FRONT_MATTER_MD }, { baseDir: os.tmpdir(), sourceName: '笔记.md' });

    // Assert
    assert.equal(doc.meta.title, '元数据里的标题');
    assert.equal(doc.meta.author, '王五');
    assert.equal(doc.meta.date, '2026-05-06');
    assert.deepEqual(doc.meta.tags, ['知识库', '转换']);
    assert.equal(doc.meta.draft, false);
    // 系统字段不被文档自述值覆盖
    assert.equal(doc.meta.sourceType, 'md');
    assert.equal(doc.meta.sourceName, '笔记.md');
});

test('front matter 未给 title 时，仍按「首个 H1 → 文件名」推断', async () => {
    // Arrange
    const text = '---\nauthor: 赵六\n---\n\n# H1 标题\n\n正文\n';

    // Act
    const doc = await parse({ text }, { baseDir: os.tmpdir() });

    // Assert
    assert.equal(doc.meta.title, 'H1 标题');
    assert.equal(doc.meta.author, '赵六');
});

test('front matter 里的 sourceType 等系统键不会篡改来源信息', async () => {
    // Arrange
    const text = '---\nsourceType: url\nbaseDir: /etc\nsourceName: 伪造.md\n---\n\n# 标题\n';

    // Act
    const doc = await parse({ text }, { baseDir: os.tmpdir(), sourceName: '真实.md' });

    // Assert
    assert.equal(doc.meta.sourceType, 'md');
    assert.equal(doc.meta.sourceName, '真实.md');
    assert.equal(doc.meta.baseDir, os.tmpdir());
});

test('无 front matter 的 Markdown 行为不变', async () => {
    // Act
    const doc = await parse({ text: '# 标题\n\n正文\n' }, { baseDir: os.tmpdir() });

    // Assert
    assert.equal(doc.meta.title, '标题');
    assert.equal(doc.ir.children[0].type, 'heading');
});

test('正文开头的水平分隔线不被误当作 front matter 摘掉', async () => {
    // Arrange：只有起始的 ---，没有闭合行
    const text = '---\n\n# 标题\n\n正文\n';

    // Act
    const doc = await parse({ text }, { baseDir: os.tmpdir() });

    // Assert
    assert.equal(collect(doc.ir, (n) => n.type === 'thematicBreak').length, 1);
    assert.equal(doc.meta.title, '标题');
});

// ============================================================
// 端到端：md → docx
// ============================================================

test('带 front matter 的 md 转 docx：正文不含 YAML 文本，标题取 front matter', async () => {
    // Arrange
    const dir = makeTempDir('markflow-md-fm-');
    const source = path.join(dir, '笔记.md');
    fs.writeFileSync(source, FRONT_MATTER_MD, 'utf8');

    // Act
    const res = await convert({ input: { path: source }, target: 'docx', outputDir: dir });
    const zip = await JSZip.loadAsync(fs.readFileSync(res.outputPath));
    const documentXml = await zip.file('word/document.xml').async('string');

    // Assert
    assert.equal(res.ok, true);
    assert.equal(res.title, '元数据里的标题');
    assert.ok(documentXml.includes('正文里的一级标题'), '正文标题应在 DOCX 中');
    for (const leaked of ['title:', 'author:', 'tags:', '王五', '知识库', '---']) {
        assert.ok(!documentXml.includes(leaked), `DOCX 正文不应含 YAML 残留：${leaked}`);
    }
});
