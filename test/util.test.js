/**
 * converters/ir/util.js 单元测试
 * 覆盖：sanitizeFolderName、stripExt、collectText、扩展名推断、decodeUtf8Filename、ensureDir
 */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const util = require('../converters/ir/util');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });

// ============================================================
// sanitizeFolderName
// ============================================================

describe('sanitizeFolderName', () => {
    test('去除全部非法字符与首尾空白', () => {
        // Arrange
        const raw = '  a/b\\c:d*e?f"g<h>i|j  ';

        // Act
        const result = util.sanitizeFolderName(raw);

        // Assert
        assert.equal(/[\\/:*?"<>|]/.test(result), false);
        assert.equal(result, result.trim());
        assert.equal(result, 'a_b_c_d_e_f_g_h_i_j');
    });

    test('保留中文与内部空格，连续空白折叠为一个空格', () => {
        assert.equal(util.sanitizeFolderName('知识库   文档 v1'), '知识库 文档 v1');
    });

    test('超过 100 个字符时按码点截断', () => {
        const result = util.sanitizeFolderName('文'.repeat(150));
        assert.equal(Array.from(result).length, 100);
    });

    test('空值、纯空白、纯非法字符与点号回退默认名', () => {
        for (const value of ['', '   ', null, undefined, '???', '..', '.', '___']) {
            assert.equal(util.sanitizeFolderName(value), '未命名文档', JSON.stringify(value));
        }
    });

    test('可自定义回退名', () => {
        assert.equal(util.sanitizeFolderName('', '备用名'), '备用名');
    });

    test('去除控制字符与首尾点号', () => {
        const withNul = '.hidden' + String.fromCharCode(0) + 'name.';
        assert.equal(util.sanitizeFolderName(withNul), 'hiddenname');
    });
});

// ============================================================
// stripExt
// ============================================================

describe('stripExt', () => {
    test('去掉扩展名与目录前缀', () => {
        assert.equal(util.stripExt('报告.docx'), '报告');
        assert.equal(util.stripExt('/a/b/报告.md'), '报告');
        assert.equal(util.stripExt('a.b.c'), 'a.b');
    });

    test('无扩展名与空值', () => {
        assert.equal(util.stripExt('noext'), 'noext');
        assert.equal(util.stripExt(''), '');
        assert.equal(util.stripExt(null), '');
        assert.equal(util.stripExt(undefined), '');
    });
});

// ============================================================
// collectText
// ============================================================

describe('collectText', () => {
    test('递归拼接嵌套节点的文本，image 等无 value 叶子节点贡献空串', () => {
        // Arrange
        const node = {
            type: 'heading',
            depth: 1,
            children: [
                { type: 'text', value: '标' },
                { type: 'strong', children: [{ type: 'text', value: '题' }] },
                { type: 'inlineCode', value: 'x' },
                { type: 'image', url: 'a.png', alt: '图' },
            ],
        };

        // Act & Assert
        assert.equal(util.collectText(node), '标题x');
    });

    test('空值、数值 value 与无子节点的容器', () => {
        assert.equal(util.collectText(null), '');
        assert.equal(util.collectText(undefined), '');
        assert.equal(util.collectText({ type: 'text', value: 0 }), '0');
        assert.equal(util.collectText({ type: 'paragraph' }), '');
    });
});

// ============================================================
// 扩展名推断
// ============================================================

describe('getExtFromContentType', () => {
    test('识别常见 MIME，忽略参数与大小写', () => {
        assert.equal(util.getExtFromContentType('image/jpeg'), '.jpg');
        assert.equal(util.getExtFromContentType('image/png; charset=binary'), '.png');
        assert.equal(util.getExtFromContentType('IMAGE/GIF'), '.gif');
        assert.equal(util.getExtFromContentType('image/svg+xml'), '.svg');
    });

    test('未知类型或空值回退 .png', () => {
        assert.equal(util.getExtFromContentType('application/octet-stream'), '.png');
        assert.equal(util.getExtFromContentType(undefined), '.png');
    });
});

describe('getExtFromUrl', () => {
    test('从路径取扩展名，忽略查询串与大小写', () => {
        assert.equal(util.getExtFromUrl('https://x.y/a.PNG?x=1'), '.png');
        assert.equal(util.getExtFromUrl('https://x.y/b.jpeg#frag'), '.jpeg');
    });

    test('无扩展名、非图片扩展名或非法 URL 回退 .jpg', () => {
        assert.equal(util.getExtFromUrl('https://x.y/img'), '.jpg');
        assert.equal(util.getExtFromUrl('https://x.y/a.exe'), '.jpg');
        assert.equal(util.getExtFromUrl('not a url'), '.jpg');
    });
});

// ============================================================
// decodeUtf8Filename
// ============================================================

describe('decodeUtf8Filename', () => {
    test('还原 latin1 误解码的中文文件名', () => {
        const mangled = Buffer.from('中文 文档.md', 'utf8').toString('latin1');
        assert.equal(util.decodeUtf8Filename(mangled), '中文 文档.md');
    });

    test('已是 utf8 的字符串原样返回', () => {
        assert.equal(util.decodeUtf8Filename('中文.md'), '中文.md');
        assert.equal(util.decodeUtf8Filename('plain.md'), 'plain.md');
    });

    test('非字符串返回空串', () => {
        assert.equal(util.decodeUtf8Filename(undefined), '');
        assert.equal(util.decodeUtf8Filename(42), '');
    });
});

// ============================================================
// ensureDir
// ============================================================

describe('ensureDir', () => {
    const root = fs.mkdtempSync(path.join(TMP_ROOT, 'util-'));
    after(() => fs.rmSync(root, { recursive: true, force: true }));

    test('递归创建并返回路径，重复调用幂等', async () => {
        const target = path.join(root, 'a', 'b', 'c');
        assert.equal(await util.ensureDir(target), target);
        assert.equal(await util.ensureDir(target), target);
        assert.ok(fs.statSync(target).isDirectory());
    });

    test('空路径拒绝', async () => {
        await assert.rejects(util.ensureDir(''), /目录路径/);
    });
});
