/**
 * converters/ir/schema.js 单元测试
 * 覆盖：createDocument 默认值与透传、节点工厂、零引用工厂已删除、downgradeCustomNodes
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const schema = require('../converters/ir/schema');

// ============================================================
// createDocument
// ============================================================

describe('createDocument', () => {
    test('默认值：kind=document、空 root、data=null、meta/assets/warnings 为空', () => {
        // Act
        const doc = schema.createDocument();

        // Assert
        assert.equal(doc.schemaVersion, 1);
        assert.equal(doc.schemaVersion, schema.SCHEMA_VERSION);
        assert.equal(doc.kind, 'document');
        assert.deepEqual(doc.ir, { type: 'root', children: [] });
        assert.equal(doc.data, null);
        assert.deepEqual(doc.meta, {});
        assert.deepEqual(doc.assets, []);
        assert.deepEqual(doc.warnings, []);
        assert.deepEqual(Object.keys(doc), ['schemaVersion', 'kind', 'ir', 'data', 'meta', 'assets', 'warnings']);
    });

    test('透传各字段，meta 为浅拷贝', () => {
        // Arrange
        const meta = { title: 'T', sourceType: 'md', sourceName: 'a.md', baseDir: '/tmp' };
        const ir = { type: 'root', children: [{ type: 'paragraph', children: [] }] };
        const assets = [{ name: 'images/image_1.png', buffer: Buffer.alloc(1), mime: 'image/png' }];

        // Act
        const doc = schema.createDocument({
            kind: 'spreadsheet',
            ir,
            data: { sheets: 1 },
            meta,
            assets,
            warnings: ['提示'],
        });

        // Assert
        assert.equal(doc.kind, 'spreadsheet');
        assert.equal(doc.ir, ir);
        assert.deepEqual(doc.data, { sheets: 1 });
        assert.deepEqual(doc.meta, meta);
        assert.notEqual(doc.meta, meta);
        assert.equal(doc.assets, assets);
        assert.deepEqual(doc.warnings, ['提示']);
    });

    test('非数组的 assets/warnings 与空 meta 归一化', () => {
        const doc = schema.createDocument({ assets: 'x', warnings: null, meta: null });
        assert.deepEqual(doc.assets, []);
        assert.deepEqual(doc.warnings, []);
        assert.deepEqual(doc.meta, {});
    });
});

// ============================================================
// 节点工厂
// ============================================================

describe('节点工厂', () => {
    test('normalizeChildren 把字符串包装为 text 节点，空值返回空数组', () => {
        assert.deepEqual(schema.normalizeChildren('文本'), [{ type: 'text', value: '文本' }]);
        assert.deepEqual(schema.normalizeChildren(['a', { type: 'text', value: 'b' }]), [
            { type: 'text', value: 'a' },
            { type: 'text', value: 'b' },
        ]);
        assert.deepEqual(schema.normalizeChildren(null), []);
    });

    test('块级工厂生成合法 mdast 结构', () => {
        assert.deepEqual(schema.createHeading(2, '标题'), {
            type: 'heading',
            depth: 2,
            children: [{ type: 'text', value: '标题' }],
        });
        assert.deepEqual(schema.createParagraph('段落').type, 'paragraph');
        assert.deepEqual(schema.createBlockquote(schema.createParagraph('q')).children.length, 1);
        assert.deepEqual(schema.createThematicBreak(), { type: 'thematicBreak' });
        assert.deepEqual(schema.createText(null), { type: 'text', value: '' });

        const table = schema.createTable(null, [schema.createTableRow([schema.createTableCell('c')])]);
        assert.equal(table.type, 'table');
        assert.equal(table.align, null);
        assert.equal(table.children[0].children[0].children[0].value, 'c');
    });

    test('扩展节点携带 data', () => {
        assert.deepEqual(schema.createSlideBreak({ title: '页', index: 3, notes: 'n' }), {
            type: 'slideBreak',
            data: { title: '页', index: 3, notes: 'n' },
        });
        assert.deepEqual(schema.createSheetSection({ name: 'Sheet1', index: 0 }), {
            type: 'sheetSection',
            data: { name: 'Sheet1', index: 0 },
        });
    });

    test('零引用的行内工厂已删除', () => {
        const removed = [
            'createImage', 'createLink', 'createStrong', 'createEmphasis', 'createDelete',
            'createInlineCode', 'createCode', 'createList', 'createListItem', 'createBreak', 'createHtml',
        ];
        for (const name of removed) {
            assert.equal(schema[name], undefined, name);
        }
    });
});

// ============================================================
// downgradeCustomNodes
// ============================================================

describe('downgradeCustomNodes', () => {
    test('slideBreak：首页仅 H2，其后为分隔线 + H2', () => {
        // Arrange
        const ir = schema.createRoot([
            schema.createSlideBreak({ title: '第一页', index: 0 }),
            schema.createParagraph('内容'),
            schema.createSlideBreak({ title: '第二页', index: 1 }),
        ]);

        // Act
        const out = schema.downgradeCustomNodes(ir);

        // Assert
        assert.deepEqual(out.children.map((n) => n.type), ['heading', 'paragraph', 'thematicBreak', 'heading']);
        assert.equal(out.children[0].depth, 2);
        assert.equal(out.children[3].children[0].value, '第二页');
    });

    test('sheetSection 降级为 H1，无名称时只留分隔线', () => {
        const ir = schema.createRoot([
            schema.createSheetSection({ name: 'Sheet1', index: 0 }),
            schema.createSheetSection({ name: '', index: 1 }),
        ]);
        const out = schema.downgradeCustomNodes(ir);
        assert.deepEqual(out.children.map((n) => n.type), ['heading', 'thematicBreak']);
        assert.equal(out.children[0].depth, 1);
    });

    test('不修改入参，递归处理嵌套，非对象原样返回', () => {
        const ir = schema.createRoot([
            schema.createBlockquote([schema.createSlideBreak({ title: 'x', index: 0 })]),
        ]);
        const snapshot = JSON.stringify(ir);

        const out = schema.downgradeCustomNodes(ir);

        assert.equal(JSON.stringify(ir), snapshot);
        assert.equal(out.children[0].children[0].type, 'heading');
        assert.equal(schema.downgradeCustomNodes(null), null);
    });
});
