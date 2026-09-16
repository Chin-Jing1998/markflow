/**
 * converters/ir/util.js 单元测试
 * 覆盖：sanitizeFolderName（含 Windows 保留名）、normalizeAuthor（占位作者名过滤）、stripExt、
 *       collectText、扩展名推断、ensureDir
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

describe('sanitizeFolderName：Windows 保留名', () => {
    // 上标数字以码点生成：Windows 把 ¹²³ 视同数字，COM¹、LPT³ 等同样是设备名
    const SUP = { 1: String.fromCharCode(0xb9), 2: String.fromCharCode(0xb2), 3: String.fromCharCode(0xb3) };

    test('CON、PRN、AUX、NUL、COM1–COM9、LPT1–LPT9 不分大小写，追加下划线', () => {
        const cases = [
            ['CON', 'CON_'], ['con', 'con_'], ['Prn', 'Prn_'], ['aux', 'aux_'], ['NUL', 'NUL_'],
            ['COM1', 'COM1_'], ['com9', 'com9_'], ['LPT1', 'LPT1_'], ['Lpt9', 'Lpt9_'],
        ];
        for (const [raw, expected] of cases) assert.equal(util.sanitizeFolderName(raw), expected, raw);
    });

    test('带扩展名的形式：下划线追加在第一个点之前的主干之后', () => {
        assert.equal(util.sanitizeFolderName('con.txt'), 'con_.txt');
        assert.equal(util.sanitizeFolderName('NUL.tar.gz'), 'NUL_.tar.gz');
        assert.equal(util.sanitizeFolderName('CON .txt'), 'CON _.txt');
    });

    test('Windows 视同数字的上标 ¹²³ 同样构成保留名', () => {
        assert.equal(util.sanitizeFolderName(`COM${SUP[1]}`), `COM${SUP[1]}_`);
        assert.equal(util.sanitizeFolderName(`lpt${SUP[3]}.md`), `lpt${SUP[3]}_.md`);
        assert.equal(util.sanitizeFolderName(`com${SUP[2]}`), `com${SUP[2]}_`);
    });

    test('去掉末尾的点与空格后再判定', () => {
        assert.equal(util.sanitizeFolderName('CON. '), 'CON_');
        assert.equal(util.sanitizeFolderName('  nul ..'), 'nul_');
    });

    test('非保留名原样不变', () => {
        for (const name of ['COM0', 'COM10', 'LPT', 'CONSOLE', 'con-1', 'console.log', 'aux1', 'PRN1', '报告 CON']) {
            assert.equal(util.sanitizeFolderName(name), name, name);
        }
    });

    test('回退名为保留名时同样处理；结果不超过 100 个码点', () => {
        assert.equal(util.sanitizeFolderName('', 'CON'), 'CON_');
        const long = util.sanitizeFolderName(`CON.${'x'.repeat(200)}`);
        assert.equal(Array.from(long).length, 100);
        assert.ok(long.startsWith('CON_.'));
    });
});

// ============================================================
// normalizeAuthor
// ============================================================

describe('normalizeAuthor', () => {
    test('第三方库与本项目写入的占位作者名视为无作者（不分大小写、含首尾空白）', () => {
        // docx 库缺省 Un-named、exceljs 缺省 Unknown、本项目 md → docx 渲染器写入 MarkFlow
        for (const raw of ['Un-named', 'un-named', 'UN-NAMED', '  Un-named  ', 'Unknown', 'unknown', 'MarkFlow', 'markflow']) {
            assert.equal(util.normalizeAuthor(raw), '', JSON.stringify(raw));
        }
    });

    test('真实作者照旧返回，只去首尾空白', () => {
        assert.equal(util.normalizeAuthor(' 张三 '), '张三');
        assert.equal(util.normalizeAuthor('李四 & 王五'), '李四 & 王五');
        assert.equal(util.normalizeAuthor('咕咕'), '咕咕');
    });

    test('只做整串精确匹配：含占位词的真实姓名不受影响', () => {
        assert.equal(util.normalizeAuthor('un-named 张三'), 'un-named 张三');
        assert.equal(util.normalizeAuthor('MarkFlow 团队'), 'MarkFlow 团队');
        assert.equal(util.normalizeAuthor('Unknown Rivers'), 'Unknown Rivers');
        assert.equal(util.normalizeAuthor('Un-named2'), 'Un-named2');
    });

    test('空值、纯空白与非字符串返回空串', () => {
        for (const raw of ['', '   ', null, undefined, 42, {}]) assert.equal(util.normalizeAuthor(raw), '', JSON.stringify(raw));
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
