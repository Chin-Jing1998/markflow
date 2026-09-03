/**
 * converters/web/frontmatter.js 单元测试
 *
 * 生成侧覆盖：字段顺序固定、缺失字段整条省略、值转义（冒号/引号/换行/特殊起始字符/
 * 控制字符）、数值裸写、finalUrl 仅在与 source 不同时出现、办公文档只写它拥有的字段。
 * 剥离侧覆盖：标准块、CRLF、BOM、缺闭合、注释与非法行、流式与块式数组、引号值，
 * 以及「生成 → 剥离」的往返一致性。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildFrontMatter, prependFrontMatter, stripFrontMatter } = require('../converters/web/frontmatter');

const CONVERTED_AT = '2026-09-03T01:00:00.000Z';
const FULL_META = Object.freeze({
    title: '网页标题',
    author: '张三',
    publishedAt: '2026-01-02T03:04:05.000Z',
    sourceUrl: 'https://example.com/a',
    finalUrl: 'https://example.com/a-final',
    sourceType: 'url',
    siteName: '示例站',
    excerpt: '一句话摘要',
    lang: 'zh-CN',
    wordCount: 1234,
    extraction: 'readability',
    fetchedAt: '2026-09-03T00:00:00.000Z',
});

const keysOf = (yaml) => yaml.split('\n').filter((line) => line.includes(': ')).map((line) => line.split(':')[0]);

// ============================================================
// 生成
// ============================================================

test('字段顺序固定，键序不随 meta 的属性顺序变化', () => {
    // Arrange：把 meta 的属性顺序完全打乱
    const shuffled = Object.fromEntries(Object.entries(FULL_META).reverse());

    // Act
    const yaml = buildFrontMatter(shuffled, { convertedAt: CONVERTED_AT });

    // Assert
    assert.deepEqual(keysOf(yaml), [
        'title', 'author', 'date', 'source', 'finalUrl', 'sourceType',
        'siteName', 'excerpt', 'lang', 'wordCount', 'extraction', 'fetchedAt', 'convertedAt',
    ]);
    assert.ok(yaml.startsWith('---\n') && yaml.endsWith('---\n'));
});

test('缺失字段整条省略，不写空值占位', () => {
    // Act
    const yaml = buildFrontMatter({ title: '只有标题', sourceType: 'url', author: '', excerpt: null }, { convertedAt: CONVERTED_AT });

    // Assert
    assert.deepEqual(keysOf(yaml), ['title', 'sourceType', 'convertedAt']);
    assert.ok(!yaml.includes('author'));
    assert.ok(!yaml.includes('excerpt'));
});

test('办公文档 bundle 只写它拥有的字段', () => {
    // Act
    const yaml = buildFrontMatter({ title: '季度报告', sourceType: 'docx', sourceName: '季度报告.docx' }, { convertedAt: CONVERTED_AT });

    // Assert
    assert.equal(yaml, [
        '---',
        'title: "季度报告"',
        'source: "季度报告.docx"',
        'sourceType: "docx"',
        `convertedAt: "${CONVERTED_AT}"`,
        '---',
        '',
    ].join('\n'));
});

test('finalUrl 仅在与 source 不同时写出', () => {
    // Act
    const differs = buildFrontMatter(FULL_META, { convertedAt: CONVERTED_AT });
    const same = buildFrontMatter({ ...FULL_META, finalUrl: FULL_META.sourceUrl }, { convertedAt: CONVERTED_AT });

    // Assert
    assert.ok(differs.includes('finalUrl: "https://example.com/a-final"'));
    assert.ok(!same.includes('finalUrl'));
});

test('数值字段裸写为数字，字符串字段一律加引号', () => {
    // Act
    const yaml = buildFrontMatter(FULL_META, { convertedAt: CONVERTED_AT });

    // Assert
    assert.ok(yaml.includes('wordCount: 1234'), yaml);
    assert.ok(yaml.includes('title: "网页标题"'), yaml);
});

const ESCAPE_CASES = [
    ['冒号', '标题: 副标题', 'title: "标题: 副标题"'],
    ['双引号', '他说"你好"', 'title: "他说\\"你好\\""'],
    ['反斜杠', 'C:\\path\\to', 'title: "C:\\\\path\\\\to"'],
    ['换行折叠为单行', '第一行\n第二行', 'title: "第一行\\n第二行"'],
    ['制表符', '前\t后', 'title: "前\\t后"'],
    ['以短横线开头', '- 起始', 'title: "- 起始"'],
    ['以井号开头', '#标签', 'title: "#标签"'],
    ['以 at 开头', '@提及', 'title: "@提及"'],
    ['形如布尔值', 'true', 'title: "true"'],
    ['形如数字', '2026', 'title: "2026"'],
];

for (const [name, title, expectedLine] of ESCAPE_CASES) {
    test(`YAML 值转义：${name}`, () => {
        // Act
        const yaml = buildFrontMatter({ title }, { convertedAt: CONVERTED_AT });

        // Assert
        assert.ok(yaml.includes(expectedLine), `期望包含 ${expectedLine}，实际：\n${yaml}`);
        // 转义后整块仍是「三行栅栏 + 键值行」结构，值里的换行不会撑出多余行
        assert.equal(yaml.split('\n').length, 5, yaml);
    });
}

test('控制字符被转义为 \\xNN，不进入产物原文', () => {
    // Act
    const yaml = buildFrontMatter({ title: `前${String.fromCharCode(1)}后` }, { convertedAt: CONVERTED_AT });

    // Assert
    assert.ok(yaml.includes('title: "前\\x01后"'), yaml);
});

test('prependFrontMatter 把头部置于正文之前，两者之间恰有一个空行', () => {
    // Act
    const md = prependFrontMatter('# 正文\n\n段落\n', { title: 'T', sourceType: 'url' }, { convertedAt: CONVERTED_AT });

    // Assert
    assert.match(md, /^---\ntitle: "T"\nsourceType: "url"\nconvertedAt: "[^"]+"\n---\n\n# 正文\n\n段落\n$/);
});

// ============================================================
// 剥离
// ============================================================

test('剥离标准 front matter，正文与键值都正确', () => {
    // Arrange
    const text = '---\ntitle: 我的笔记\ntags: [技术, 笔记]\ndraft: false\ncount: 12\n---\n\n# 正文\n\n段落\n';

    // Act
    const { body, data, found } = stripFrontMatter(text);

    // Assert
    assert.equal(found, true);
    assert.equal(body, '# 正文\n\n段落\n');
    assert.deepEqual(data, { title: '我的笔记', tags: ['技术', '笔记'], draft: false, count: 12 });
});

test('剥离支持块式数组、引号值、注释与非法行', () => {
    // Arrange
    const text = [
        '---',
        '# 这是注释',
        'title: "带: 冒号的标题"',
        "subtitle: '单引号里的 it''s'",
        'tags:',
        '  - 甲',
        '  - 乙',
        '这一行没有冒号，应被忽略',
        'empty:',
        '---',
        '正文',
    ].join('\n');

    // Act
    const { body, data } = stripFrontMatter(text);

    // Assert
    assert.equal(body, '正文');
    assert.deepEqual(data, {
        title: '带: 冒号的标题',
        subtitle: "单引号里的 it's",
        tags: ['甲', '乙'],
        empty: '',
    });
});

test('剥离兼容 CRLF 与 BOM 开头', () => {
    // Arrange
    const bom = String.fromCharCode(0xfeff);
    const text = `${bom}---\r\ntitle: CRLF 标题\r\n---\r\n正文\r\n`;

    // Act
    const { body, data, found } = stripFrontMatter(text);

    // Assert
    assert.equal(found, true);
    assert.equal(data.title, 'CRLF 标题');
    assert.equal(body, '正文\r\n');
});

test('没有闭合栅栏时原样返回，正文开头的分隔线不被误认为 front matter', () => {
    // Arrange
    const text = '---\n\n# 这其实是一条分隔线加正文\n\n段落\n';

    // Act
    const { body, data, found } = stripFrontMatter(text);

    // Assert
    assert.equal(found, false);
    assert.equal(body, text);
    assert.deepEqual(data, {});
});

test('没有 front matter 的文本原样返回', () => {
    // Act
    const { body, data, found } = stripFrontMatter('# 标题\n\n正文\n');

    // Assert
    assert.equal(found, false);
    assert.equal(body, '# 标题\n\n正文\n');
    assert.deepEqual(data, {});
    assert.deepEqual(stripFrontMatter(null), { body: '', data: {}, found: false });
});

// ============================================================
// 往返
// ============================================================

test('生成的 front matter 能被自身的剥离逻辑读回，值不失真', () => {
    // Arrange：标题同时含冒号、引号与换行
    const meta = { ...FULL_META, title: '标题: 含"引号"\n与换行' };

    // Act
    const md = prependFrontMatter('# 正文\n', meta, { convertedAt: CONVERTED_AT });
    const { body, data } = stripFrontMatter(md);

    // Assert
    assert.equal(body, '# 正文\n');
    assert.equal(data.title, '标题: 含"引号"\n与换行');
    assert.equal(data.wordCount, 1234);
    assert.equal(data.source, FULL_META.sourceUrl);
    assert.equal(data.date, FULL_META.publishedAt);
});
