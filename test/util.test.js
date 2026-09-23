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
// sanitizeFolderName：首尾修剪线性于串长（耗时上限与逐字等价）
// ============================================================

// 制表符、换行与回车写作转义序列，其余不可见字符以码点生成，源码里不出现看不见的字面量
const NBSP = String.fromCharCode(0xa0);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const NUL_CHAR = String.fromCharCode(0x00);
// Windows 视同数字的上标 ¹²³，与上方保留名用例同一约定，以码点生成
const SUPERSCRIPT_DIGITS = String.fromCharCode(0xb9, 0xb2, 0xb3);
// 代理对字符：一个码点占两个 UTF-16 码元，用以考察按码点截断
const EMOJI = String.fromCodePoint(0x1f600);

// 耗时用例的输入规模：a 与 b 之间夹 8 万个首尾修剪字符，这一长段既不在串首也不在串尾
const EDGE_STRESS_LENGTH = 80000;
// 耗时上限取绝对值而非「新旧耗时之比」：毫秒级测量噪声大，倍率断言不稳。200 ms 使两侧余量都不小于 5 倍——
// 线性化之前的 /^[\s._]+|[\s._]+$/g 在这一规模上两种形态实测约 2.0 至 2.6 秒（2 万、4 万时约 0.15、0.6 秒，
// 耗时随段长平方增长），是上限的 10 倍以上；线性化之后单独计时至多约 3 毫秒，全量并行运行时整例（含构造
// 输入）约 6 毫秒，仍不到上限的三十分之一，故慢机以及 node --test 多文件并行抢占 CPU 时都不会误报
const EDGE_STRESS_BUDGET_MS = 200;

const elapsedMsSince = (started) => Number(process.hrtime.bigint() - started) / 1e6;

// 线性化之前的实现，仅作短输入的差分参照：两处「量词 + 行尾锚」的正则在不处于串尾的长段上逐位回溯，
// 不可用于耗时用例的输入规模。各步正则与先后顺序照录旧文件，只把中间结果拆成变量，以便在 hits 上记下
// 三处修剪各自确实删去字符的样本数，供差分用例自证没有对某一分支空转
const LEGACY_EDGE_TRIM_RE = /^[\s._]+|[\s._]+$/g;
const LEGACY_TRAILING_DOT_SPACE_RE = /[\s.]+$/;
const LEGACY_RESERVED_NAME_RE = new RegExp(
    `^(?:CON|PRN|AUX|NUL|COM[1-9${SUPERSCRIPT_DIGITS}]|LPT[1-9${SUPERSCRIPT_DIGITS}])$`, 'i',
);

function legacyAvoidWindowsReservedName(name, hits) {
    const dot = name.indexOf('.');
    const stem = dot === -1 ? name : name.slice(0, dot);
    if (!LEGACY_RESERVED_NAME_RE.test(stem.trimEnd())) return name;
    const fixed = `${stem}_${dot === -1 ? '' : name.slice(dot)}`;
    const truncated = Array.from(fixed).slice(0, 100).join('');
    const result = truncated.replace(LEGACY_TRAILING_DOT_SPACE_RE, '');
    if (result !== truncated) hits.trailingDotSpace += 1;
    return result;
}

function legacySanitizeFolderName(name, fallback = '未命名文档', hits) {
    const collapsed = String(name == null ? '' : name)
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/_+/g, '_')
        .replace(/\s+/g, ' ');
    const cleaned = collapsed.replace(LEGACY_EDGE_TRIM_RE, '');
    if (cleaned !== collapsed) hits.firstTrim += 1;
    const truncated = Array.from(cleaned).slice(0, 100).join('');
    const trimmed = truncated.replace(LEGACY_EDGE_TRIM_RE, '');
    if (trimmed !== truncated) hits.secondTrim += 1;
    return legacyAvoidWindowsReservedName(trimmed || fallback, hits);
}

// 差分字母表：多数记号为单个字符；CON 与 COM 为整词，与点、空白、上标一拼即成保留名。涵盖首尾修剪
// 字符类 [\s._] 的各类成员（含宽义空白与回车）、会被替换为下划线的非法字符、会被剔除的控制字符，
// 以及考察按码点截断的代理对字符
const DIFF_ALPHABET = [
    ' ', '\t', '\n', '\r', '.', '_', 'a', '/', 'CON', 'COM',
    NBSP, IDEOGRAPHIC_SPACE, LINE_SEPARATOR, BYTE_ORDER_MARK, NUL_CHAR, SUPERSCRIPT_DIGITS[0], EMOJI,
];
// 宽义空白：名称里的会被折叠为普通空格，只有经由不经清洗的 fallback 才能原样到达 trimEnd 与末尾修剪
const WIDE_SPACES = [NBSP, IDEOGRAPHIC_SPACE, LINE_SEPARATOR, BYTE_ORDER_MARK];
// 回退名取值：缺省（undefined，即「未命名文档」）、空串、保留名、带尾随点与空格的保留名、
// 以宽义空白结尾的保留名，以及非保留名
const DIFF_FALLBACKS = [
    undefined, '', 'CON', 'CON. ', `CON.${IDEOGRAPHIC_SPACE}`, `nul${NBSP}`,
    `COM${SUPERSCRIPT_DIGITS[0]}.${LINE_SEPARATOR}`, `Lpt9 .${BYTE_ORDER_MARK}`, '备用名',
];
// 保留名主干：大小写混排，含上标变体
const RESERVED_STEMS = [
    'CON', 'con', 'Prn', 'AUX', 'nul', 'COM1', 'com9', 'LPT1', 'Lpt9',
    `COM${SUPERSCRIPT_DIGITS[0]}`, `lpt${SUPERSCRIPT_DIGITS[2]}`,
];
// 长串尾部的记号：可见字符居多，夹杂点、空白、下划线、非法字符与控制字符，使截断点两侧的字符有变化
const LONG_TAIL_TOKENS = ['x', 'x', 'y', '甲', EMOJI, EMOJI, '.', '.', ' ', '_', '/', NBSP, '\t', NUL_CHAR];
// 清洗后必定全被删去的记号：以之拼成的名称结果必取回退名
const VANISHING_TOKENS = [' ', '\t', '\n', '\r', '.', '_', '/', NUL_CHAR, ...WIDE_SPACES];

// 字母表上由 0 到 maxLength 个记号拼成的全部字符串
function everyStringUpTo(maxLength, alphabet) {
    const all = [''];
    let level = [''];
    for (let length = 1; length <= maxLength; length += 1) {
        level = level.flatMap((prefix) => alphabet.map((token) => prefix + token));
        for (const text of level) all.push(text);
    }
    return all;
}

// 种子固定的 32 位伪随机数发生器（mulberry32）：每次运行抽到同一批样本，失败可原样复现
function createSeededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = Math.imul(state ^ (state >>> 15), state | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

// 逐码点列出，失败输出里的不可见字符也能看清
const toCodePoints = (text) => (text === undefined
    ? 'undefined'
    : Array.from(text, (ch) => ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' '));

describe('sanitizeFolderName：首尾修剪线性于串长', () => {
    // [形态说明, 构造输入]：点与「下划线 + 空格」交替两种形态，合起来覆盖字符类 [\s._] 的三类成员。
    // 后者不会被前面「连续下划线折叠」「连续空白折叠」两步缩短，整段原样进入首尾修剪
    const stressShapes = [
        ['8 万个点', () => `a${'.'.repeat(EDGE_STRESS_LENGTH)}b`],
        ['8 万个下划线与空格交替的字符', () => `a${'_ '.repeat(EDGE_STRESS_LENGTH / 2)}b`],
    ];

    for (const [label, buildInput] of stressShapes) {
        test(`夹在可见字符之间的 ${label}不触发回溯：单次调用在绝对上限内，输出逐字正确`, () => {
            // Arrange：在计时区间外新构造字符串——V8 对「同一字符串对象 + 同一全局正则」的 replace 结果有缓存
            const input = buildInput();

            // Act：计时区间只包这一次调用
            const started = process.hrtime.bigint();
            const result = util.sanitizeFolderName(input);
            const elapsedMs = elapsedMsSince(started);

            // Assert：先验输出正确，以免「快」来自少做了事——截断到 100 个码点后，a 之后全是修剪字符
            assert.equal(result, 'a');
            assert.ok(
                elapsedMs < EDGE_STRESS_BUDGET_MS,
                `sanitizeFolderName 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${EDGE_STRESS_BUDGET_MS} ms`,
            );
        });
    }

    test('与线性化之前的实现逐字等价：穷举短串与种子固定的随机串，三处修剪均有样本确实删去字符', (t) => {
        // Arrange：17 个记号的字母表上由 0 到 4 个记号拼成的全部字符串共 88741 个，回退名取缺省值
        const samples = everyStringUpTo(4, DIFF_ALPHABET).map((name) => [name, undefined]);
        assert.equal(samples.length, 88741);

        const random = createSeededRandom(20260923);
        const pick = (items) => items[Math.floor(random() * items.length)];
        const randomTokens = (tokens, count) => Array.from({ length: count }, () => pick(tokens)).join('');
        // 一般随机串 20000 个：字母表上 0 到 24 个记号，回退名随机取值
        for (let i = 0; i < 20000; i += 1) {
            samples.push([randomTokens(DIFF_ALPHABET, Math.floor(random() * 25)), pick(DIFF_FALLBACKS)]);
        }
        // 长串 6000 个：保留名主干（可带空白）+ 点 + 随机尾部，总长 95 到 130 个码点，跨越 100 个码点的截断边界，
        // 覆盖截断后的第二次修剪，以及保留名追加下划线再截断之后的末尾修剪
        for (let i = 0; i < 6000; i += 1) {
            const head = `${pick(RESERVED_STEMS)}${randomTokens([' ', NBSP], Math.floor(random() * 2))}.`;
            const tailLength = 95 + Math.floor(random() * 36) - Array.from(head).length;
            samples.push([head + randomTokens(LONG_TAIL_TOKENS, tailLength), pick(DIFF_FALLBACKS)]);
        }
        // 回退串 4000 个：名称清洗后为空，结果必取回退名；回退名一半取自固定取值，一半为随机生成的
        // 「保留名主干 + 随机中段 + 宽义空白结尾」
        for (let i = 0; i < 4000; i += 1) {
            const name = randomTokens(VANISHING_TOKENS, Math.floor(random() * 7));
            const fallback = random() < 0.5
                ? pick(DIFF_FALLBACKS)
                : pick(RESERVED_STEMS) + randomTokens([' ', '.', 'x', ...WIDE_SPACES], Math.floor(random() * 4)) + pick(WIDE_SPACES);
            samples.push([name, fallback]);
        }
        assert.equal(samples.length, 118741);

        // Act & Assert
        const hits = { firstTrim: 0, secondTrim: 0, trailingDotSpace: 0 };
        for (const [name, fallback] of samples) {
            const expected = legacySanitizeFolderName(name, fallback, hits);
            const actual = util.sanitizeFolderName(name, fallback);
            // 只在不一致时拼装诊断信息，免得十余万次调用都付这笔开销
            if (actual !== expected) {
                assert.equal(actual, expected, `name=[${toCodePoints(name)}] fallback=[${toCodePoints(fallback)}]`);
            }
        }
        // 覆盖自证：三处修剪都须有样本确实删去了字符，差分才不是对某一分支空转
        t.diagnostic(`样本 ${samples.length} 个；删去字符的样本数：第一次首尾修剪 ${hits.firstTrim}，`
            + `截断后的第二次修剪 ${hits.secondTrim}，末尾点与空白修剪 ${hits.trailingDotSpace}`);
        assert.ok(hits.firstTrim > 0, '第一次首尾修剪没有样本删去字符');
        assert.ok(hits.secondTrim > 0, '截断后的第二次修剪没有样本删去字符');
        assert.ok(hits.trailingDotSpace > 0, '末尾点与空白修剪没有样本删去字符');
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
