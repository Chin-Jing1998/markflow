/**
 * converters/ir/util.js 单元测试
 * 覆盖：sanitizeFolderName（含 Windows 保留名）、normalizeAuthor（占位作者名过滤）、stripExt、
 *       collectText、扩展名推断、ensureDir；
 *       stripHtml 的去标签在 8 万个未闭合「<」长段上的耗时上限，removeHtmlTags 与整条 stripHtml 同线性化之前的实现逐字等价（差分）；
 *       stripHtml 的去注释在 8 万个未闭合「<!--」长段上的耗时上限，removeHtmlComments 与整条 stripHtml 同线性化之前的实现逐字等价（差分）
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

// ============================================================
// stripHtml 去标签：线性于串长（耗时上限与逐字等价）
// ============================================================

// 耗时用例的输入规模：<div> 之后是 8 万个「<」，其后直到串尾都没有「>」
const TAG_STRESS_LENGTH = 80000;
// 上限的取法同 EDGE_STRESS_BUDGET_MS。200 ms 使两侧余量都不小于 5 倍——线性化之前的 /<[^>]*>/g 经 stripHtml 在这一规模上
// 实测约 2.0 至 2.1 秒（2 万、4 万时约 0.12、0.53 秒，耗时随「<」的个数平方增长），是上限的 10 倍以上；线性化之后单独运行时
// 单次调用约 0.3 至 0.4 毫秒，全量并行运行时至多约 1.2 毫秒，仍不到上限的一百五十分之一
const TAG_STRESS_BUDGET_MS = 200;

// 线性化之前的 stripHtml，仅作短输入的差分参照：三条去除替换在缺少闭合的长输入上都逐起点回溯，耗时随串长平方增长，不可用于
// 耗时用例的输入规模。入口、各步正则与先后次序照录旧文件，只把中间结果拆成变量，以便在 steps 上记下各步确有作用的样本数；
// 另两条去除替换日后逐条线性化时，仍以它作整条链的参照
const legacyStripHtml = (value, steps) => {
    const input = String(value || '');
    const withoutBlocks = input.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
    const withoutComments = withoutBlocks.replace(/<!--[\s\S]*?-->/g, '');
    const withoutTags = withoutComments.replace(/<[^>]*>/g, '');
    const decoded = withoutTags
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
    const result = decoded.trim();
    if (steps) {
        if (withoutBlocks !== input) steps.blocks += 1;
        if (withoutComments !== withoutBlocks) steps.comments += 1;
        if (withoutTags !== withoutComments) steps.tags += 1;
        if (decoded !== withoutTags) steps.entities += 1;
        if (result !== decoded) steps.trim += 1;
    }
    return result;
};
// 去标签一步的单步参照：某个「<」之后再无「>」时，[^>]* 从该处扫到串尾再逐位回退、处处失配，其后每个「<」起点都重来一遍，
// 耗时随这一段的长度平方增长
const legacyRemoveHtmlTags = (text) => String(text).replace(/<[^>]*>/g, '');

// 入参的可读形式：字符串逐码点列出，非字符串标明类型
const describeInput = (value) => (typeof value === 'string' ? `[${toCodePoints(value)}]` : `（${typeof value}）${String(value)}`);

// 整条清洗的逐字比较；steps 缺省时不计数。只在不一致时拼装诊断信息，免得数十万次调用都付这笔开销
function assertStripHtmlMatchesLegacy(value, steps) {
    const expected = legacyStripHtml(value, steps);
    const actual = util.stripHtml(value);
    if (actual !== expected) {
        assert.fail(`输入 ${describeInput(value)}：stripHtml 新式 ${describeInput(actual)}，旧式 ${describeInput(expected)}`);
    }
}

// 段落分隔符以码点生成；它与 LF、CR、U+2028 同为行终止符，[^>] 不排除它们，标签可以跨行
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const TAG_LINE_TERMINATORS = ['\n', '\r', LINE_SEPARATOR, PARAGRAPH_SEPARATOR];
// 去标签差分的典型样本，逐一对应下文的分支：不含「<」；含「<」而零匹配；恰一处匹配；两处及以上匹配；匹配之后仍余未闭合的「<」；
// 标签内含第二个「<」；空标签「<>」；标签之外的孤立「>」（含位于首个「<」之前者，以及引号里的「>」使匹配提前结束后余下的「>」）；
// 标签内含行终止符；末一项为耗时用例输入的缩微形态
const TAG_TYPICAL_SAMPLES = [
    '', '图 1 示意图', 'a > b', '>>',
    '<', 'a<b', '<<<', '> <', '图<注 1',
    '<b>', '图 1 <b>', 'a<b>c',
    '<b>示意</b>', '<i>x</i><u>y</u>', '<a><b><c>',
    '<b>x<', '<b>x</b><', '<a>b<c<',
    '<a<b>', '<<b>', 'x<a<b>y',
    '<>', 'a<>b', '<><>',
    '>a<b>', 'a>b<c>d', '<b>>', '> <i>x</i> >', '<a title="x>y">',
    '<a\nb>', '<a\r\nb>', `<a${LINE_SEPARATOR}b>`, `<br${PARAGRAPH_SEPARATOR}/>`,
    `<div>${'<'.repeat(16)}`,
];
// 整条清洗的典型样本：去标签之前两步、之后实体还原与首尾修剪各有作用的样本，以及各步之间的衔接。依次为 script/style 块（大小写、
// 带属性、闭标签名后带空白、未闭合、名后不是词边界、首尾标签名不同）；注释（内含「>」、前有未闭合的「<」、「<!-->」与「<!--->」、
// 未闭合）；实体（六种各有、「&amp;lt;」只还原一层、去标签之后才拼成的实体）；首尾空白（含宽义空白与还原出的空格）；多步并用
const STRIP_HTML_CHAIN_SAMPLES = [
    '<script>a</script>', 'x<style>p{}</style>y', '<SCRIPT type="t">a<b>c</SCRIPT >', '<script>a', '<scripts>a</scripts>',
    '<style>a</script>',
    '<!-- x -->', 'a<!-- b -->c', '<!-- a > b -->', '<a <!-- x -->', '<!-->', '<!--->', '<!-- 未闭合',
    '&lt;b&gt;', '&amp;lt;', 'a&nbsp;b', '&quot;x&quot;', '&#39;y&#39;', '&l<b>t;',
    '  a  ', '\n<b>x</b>\n', `${NBSP}a${IDEOGRAPHIC_SPACE}`, '&nbsp;a', `${BYTE_ORDER_MARK}<b>`,
    '<p>a</p><!-- c --><script>s</script> &amp; b ',
];
// 非字符串入参：stripHtml 入口以 String(value || '') 归一，假值一律按空串处理；逐步线性化的各函数则与旧式同以 String(text) 归一，
// 假值照字面转成字符串
const STRIP_HTML_NON_STRING_INPUTS = [undefined, null, 0, false, NaN, 123, {}];
// 穷举短串的字母表：「<」「>」、字母、半角空格与 LF
const TAG_DIFF_ALPHABET = ['<', '>', 'a', ' ', '\n'];
// 一般随机串的记号：「<」「>」各放三份以提高出现频率；斜杠、引号、等号；感叹号、连字符、「&」与分号（注释与实体的零件）；
// 字母、数字与中文；各类空白与行终止符
const TAG_RANDOM_TOKENS = [
    '<', '<', '<', '>', '>', '>', '/', '"', "'", '=', '!', '-', '&', ';', 'a', 'B', '1', '图', '注',
    ' ', '\t', '\n', '\r', NBSP, IDEOGRAPHIC_SPACE, BYTE_ORDER_MARK, LINE_SEPARATOR, PARAGRAPH_SEPARATOR,
];
// 结构化随机串的片段：成对的格式标签、带属性与引号的标签（含引号里的「>」）、自闭合标签；未闭合的「<」、孤立的「>」、空标签、
// 含第二个「<」或行终止符的标签；注释（含内有「>」者）与注释的两半；script/style 块及其起止标签（含大写与闭标签名后的空白）；
// 实体与实体的残片；正文与空白（含宽义空白）
const STRIP_HTML_RANDOM_FRAGMENTS = [
    '<b>', '</b>', '<i>', '</i>', '<br/>', '<span class="x y">', '</span>', `<a title='甲 "乙"'>`, '<a title="x>y">', '</a>',
    '<', '<<', '>', '>>', '<>', '<a<b>', '<a\nb>', `<i${LINE_SEPARATOR}>`,
    '<!-- x -->', '<!-- a>b -->', '<!--', '-->',
    '<script>a</script>', '<style>p{}</style>', '<SCRIPT>', '</script >', '<style>', '</style>',
    '&lt;b&gt;', '&amp;', '&nbsp;', '&quot;', '&#39;', '&lt;', 'lt;',
    '图 1', '示意', 'x/y', ' ', NBSP, IDEOGRAPHIC_SPACE, '\n', '\t',
];

describe('stripHtml 去标签：线性于串长', () => {
    test('<div> 之后 8 万个「<」其后无「>」，去标签不触发回溯：stripHtml 单次调用在绝对上限内，输出逐字正确', (t) => {
        // Arrange：在计时区间外新构造字符串——V8 对「同一字符串对象 + 同一全局正则」的 replace 结果有缓存
        const input = `<div>${'<'.repeat(TAG_STRESS_LENGTH)}`;
        const expected = '<'.repeat(TAG_STRESS_LENGTH);

        // Act：计时区间只包这一次调用
        const started = process.hrtime.bigint();
        const result = util.stripHtml(input);
        const elapsedMs = elapsedMsSince(started);
        t.diagnostic(`stripHtml 实测 ${elapsedMs.toFixed(2)} ms`);

        // Assert：先验输出正确，以免「快」来自少做了事——<div> 被删去，其后的「<」无一闭合、逐个保留。不一致时只报长度与首尾
        // 各 8 个码点，免得断言信息被 8 万字的整串淹没
        if (result !== expected) {
            assert.fail(`stripHtml 输出不符：长 ${result.length}，首 [${toCodePoints(result.slice(0, 8))}]，`
                + `尾 [${toCodePoints(result.slice(-8))}]`);
        }
        assert.ok(
            elapsedMs < TAG_STRESS_BUDGET_MS,
            `stripHtml 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${TAG_STRESS_BUDGET_MS} ms`,
        );
    });

    test('removeHtmlTags 与 stripHtml 同线性化之前的实现逐字等价：BMP 逐码元、穷举短串与随机串，各分支与各步均有样本', (t) => {
        // Arrange：典型样本在前
        const samples = [...TAG_TYPICAL_SAMPLES, ...STRIP_HTML_CHAIN_SAMPLES];
        // BMP 逐码元 262144 个：每个码元放进四个对「<」「>」敏感的位置——标签之内、未闭合的「<」之后、首个标签之前、末个「>」
        // 与其后未闭合的「<」之间；码元若被误当作「<」或「>」，匹配的起止或末个「>」的位置就会改变
        for (let code = 0; code <= 0xffff; code += 1) {
            const unit = String.fromCharCode(code);
            samples.push(`<a${unit}b>`, `<${unit}`, `${unit}<b>`, `<a>${unit}<`);
        }
        // 穷举 97656 个：字母表上由 0 到 7 个记号拼成的全部字符串
        for (const text of everyStringUpTo(7, TAG_DIFF_ALPHABET)) samples.push(text);
        const random = createSeededRandom(20260923);
        const pick = (items) => items[Math.floor(random() * items.length)];
        const randomTokens = (tokens, count) => Array.from({ length: count }, () => pick(tokens)).join('');
        // 一般随机串 30000 个：0 到 24 个随机记号
        for (let i = 0; i < 30000; i += 1) samples.push(randomTokens(TAG_RANDOM_TOKENS, Math.floor(random() * 25)));
        // 结构化随机串 30000 个：0 到 8 个片段，标签、注释、script/style 块、实体与空白交错，使整条清洗各步之间的衔接也有样本
        for (let i = 0; i < 30000; i += 1) samples.push(randomTokens(STRIP_HTML_RANDOM_FRAGMENTS, Math.floor(random() * 9)));
        assert.equal(samples.length, TAG_TYPICAL_SAMPLES.length + STRIP_HTML_CHAIN_SAMPLES.length + 419800);

        // Act & Assert：非字符串入参先比较去标签一步，再比较整条清洗
        for (const value of STRIP_HTML_NON_STRING_INPUTS) {
            const expected = legacyRemoveHtmlTags(value);
            const actual = util.removeHtmlTags(value);
            if (actual !== expected) {
                assert.fail(`输入 ${describeInput(value)}：removeHtmlTags 新式 ${describeInput(actual)}，旧式 ${describeInput(expected)}`);
            }
            assertStripHtmlMatchesLegacy(value);
        }
        const counts = {
            noOpen: 0, zeroMatch: 0, oneMatch: 0, multiMatch: 0, trailingOpen: 0,
            nestedOpen: 0, emptyTag: 0, strayClose: 0, strayCloseBeforeOpen: 0, terminatorInTag: 0,
        };
        const steps = { blocks: 0, comments: 0, tags: 0, entities: 0, trim: 0 };
        for (const sample of samples) {
            const expected = legacyRemoveHtmlTags(sample);
            const actual = util.removeHtmlTags(sample);
            // 只在不一致时拼装诊断信息，免得数十万次调用都付这笔开销
            if (actual !== expected) {
                assert.fail(`输入 ${describeInput(sample)}：removeHtmlTags 新式 ${describeInput(actual)}，旧式 ${describeInput(expected)}`);
            }
            assertStripHtmlMatchesLegacy(sample, steps);
            // 分支归类只用旧式的结果与测试内独立求得的输入特征：tags 为旧式正则在该样本上的全部匹配
            const tags = sample.match(/<[^>]*>/g) || [];
            const firstOpen = sample.indexOf('<');
            if (firstOpen < 0) counts.noOpen += 1;
            else if (tags.length === 0) counts.zeroMatch += 1;
            else if (tags.length === 1) counts.oneMatch += 1;
            else counts.multiMatch += 1;
            // 旧式结果里残留的「<」都在末个「>」之后，即未闭合者
            if (tags.length > 0 && expected.includes('<')) counts.trailingOpen += 1;
            if (tags.some((tag) => tag.indexOf('<', 1) > 0)) counts.nestedOpen += 1;
            if (tags.includes('<>')) counts.emptyTag += 1;
            // 每处匹配恰含一个「>」，即其末字符；「>」的总数多于匹配数时，多出者都在标签之外
            if (sample.split('>').length - 1 > tags.length) {
                counts.strayClose += 1;
                if (firstOpen >= 0 && sample.indexOf('>') < firstOpen) counts.strayCloseBeforeOpen += 1;
            }
            if (tags.some((tag) => TAG_LINE_TERMINATORS.some((terminator) => tag.includes(terminator)))) counts.terminatorInTag += 1;
        }
        // 覆盖自证：去标签九类分支都须有样本，孤立的「>」另须有位于首个「<」之前者；整条清洗的五步都须有样本确有作用。
        // 差分才不是对某一分支空转
        t.diagnostic(`样本 ${samples.length} 个，另有非字符串入参 ${STRIP_HTML_NON_STRING_INPUTS.length} 个；`
            + `去标签：不含「<」${counts.noOpen}，含「<」而零匹配 ${counts.zeroMatch}，恰一处匹配 ${counts.oneMatch}，`
            + `两处及以上匹配 ${counts.multiMatch}，匹配之后仍余未闭合的「<」${counts.trailingOpen}，`
            + `标签内含第二个「<」${counts.nestedOpen}，空标签「<>」${counts.emptyTag}，`
            + `标签之外的孤立「>」${counts.strayClose}（位于首个「<」之前 ${counts.strayCloseBeforeOpen}），`
            + `标签内含行终止符 ${counts.terminatorInTag}`);
        t.diagnostic(`整条清洗各步确有作用的样本数：删去 script/style 块 ${steps.blocks}，删去注释 ${steps.comments}，`
            + `删去标签 ${steps.tags}，还原实体 ${steps.entities}，修剪首尾 ${steps.trim}`);
        assert.ok(counts.noOpen > 0, '没有不含「<」的样本');
        assert.ok(counts.zeroMatch > 0, '没有含「<」而零匹配的样本');
        assert.ok(counts.oneMatch > 0, '没有恰一处匹配的样本');
        assert.ok(counts.multiMatch > 0, '没有两处及以上匹配的样本');
        assert.ok(counts.trailingOpen > 0, '没有匹配之后仍余未闭合「<」的样本');
        assert.ok(counts.nestedOpen > 0, '没有标签内含第二个「<」的样本');
        assert.ok(counts.emptyTag > 0, '没有空标签「<>」的样本');
        assert.ok(counts.strayClose > 0, '没有标签之外孤立「>」的样本');
        assert.ok(counts.strayCloseBeforeOpen > 0, '没有孤立「>」位于首个「<」之前的样本');
        assert.ok(counts.terminatorInTag > 0, '没有标签内含行终止符的样本');
        assert.ok(steps.blocks > 0, '没有删去 script/style 块的样本');
        assert.ok(steps.comments > 0, '没有删去注释的样本');
        assert.ok(steps.tags > 0, '整条清洗中没有删去标签的样本');
        assert.ok(steps.entities > 0, '没有还原实体的样本');
        assert.ok(steps.trim > 0, '没有修剪首尾的样本');
    });
});

// ============================================================
// stripHtml 去注释：线性于串长（耗时上限与逐字等价）
// ============================================================

// 耗时用例的输入规模：<div> 之后是 8 万个「<!--」，其后直到串尾都没有「-->」
const COMMENT_STRESS_COUNT = 80000;
// 上限的取法同 EDGE_STRESS_BUDGET_MS。200 ms 使两侧余量都不小于 5 倍——线性化之前的 /<!--[\s\S]*?-->/g 经 stripHtml 在这一规模上，
// 于本文件内（前一节已调用 stripHtml 数十万次）实测约 2.3 秒，在新进程里直接调用约 4.5 秒（新进程里 2 万、4 万时约 0.27、1.1 秒，
// 耗时随「<!--」的个数平方增长），较小者也是上限的 11 倍以上；若只取 4 万个，前者约 0.57 秒，余量不足 5 倍，故取 8 万个。线性化
// 之后单独运行时单次调用约 0.3 至 0.6 毫秒，全量并行运行时至多约 1.2 毫秒，仍不到上限的一百五十分之一
const COMMENT_STRESS_BUDGET_MS = 200;

// 去注释一步的单步参照：某个「<!--」之后再无「-->」时，[\s\S]*? 从该处逐位扩展到串尾、处处失配，其后每个「<!--」起点都重来
// 一遍，耗时随这一段的长度平方增长
const legacyRemoveHtmlComments = (text) => String(text).replace(/<!--[\s\S]*?-->/g, '');

// 去注释差分的典型样本，逐一对应下文的分支：不含「-->」（新式提前返回，含未闭合的「<!--」）；含「<!--」与「-->」而零匹配
// （「-->」在「<!--」之前，或只与之重叠）；含「-->」而不含「<!--」；恰一处匹配；两处及以上匹配（含两段之间夹正文者）；末个匹配
// 之后仍余「<!--」；不属于任何匹配的孤立「-->」（含位于首个「<!--」之前者）；末个「-->」与「<!--」重叠的「<!-->」「<!--->」；
// 空注释「<!---->」；注释内含第二个「<!--」；注释内含行终止符；末个「-->」之后仍有字符；与去 script/style 块、去标签两步的
// 衔接；末两项为耗时用例输入的缩微形态及其闭合对照
const COMMENT_TYPICAL_SAMPLES = [
    '', '图 1 示意图', '<!--', '<!-- 未闭合', 'a -> b', '<!-', '--',
    '--><!--', '<!-->', '<!--->',
    '-->', 'a-->b',
    '<!-- x -->', 'a<!-- b -->c', '<!--<b>-->',
    '<!--a--><!--b-->', '<!--a-->x<!--b-->', '<!----><!---->',
    '<!--a--><!--', '<!--a-->b<!--c',
    '<!--a-->-->', '--><!--a-->',
    'x<!-->', '<!--a--><!-->', '<!--a--><!--->',
    '<!---->', 'a<!---->b',
    '<!--<!---->', '<!-- a <!-- b -->',
    '<!--\n-->', '<!--a\r\nb-->', `<!--${LINE_SEPARATOR}-->`, `<!--${PARAGRAPH_SEPARATOR}x-->`,
    '<!--a-->b', '<!---->-->x',
    '<script><!--</script>-->', '<!--<script>-->x</script>', '<b><!-- c --></b>', '<!-- a > b -->x',
    `<div>${'<!--'.repeat(8)}`, `<div>${'<!--'.repeat(8)}-->`,
];
// 穷举短串的字母表：注释的起止记号、它们的零件「<」「!」「-」「>」与字母
const COMMENT_DIFF_ALPHABET = ['<!--', '-->', '<', '!', '-', '>', 'a'];
// 一般随机串的记号：注释的零件——「-」放三份，「<」「>」各两份，另有「<!」「--」「->」，以提高拼出「<!--」「-->」的
// 机会；字母、中文、「&」「;」「/」；各类空白与行终止符
const COMMENT_RANDOM_TOKENS = [
    '<', '<', '!', '-', '-', '-', '>', '>', '<!', '--', '->', 'a', '图', '&', ';', '/',
    ' ', '\t', '\n', '\r', NBSP, IDEOGRAPHIC_SPACE, BYTE_ORDER_MARK, LINE_SEPARATOR, PARAGRAPH_SEPARATOR,
];
// 结构化随机串的片段：完整注释（含空注释「<!---->」，以及内含「>」「<!--」、标签或行终止符者）、注释的两半（各放两份）、与末个
// 「-->」重叠的「<!-->」「<!--->」；标签与注释的零件；script/style 块及其起止标签；实体（含还原之后才成「<!--」的「&lt;!--」）；
// 正文与空白
const COMMENT_RANDOM_FRAGMENTS = [
    '<!-- x -->', '<!--a-->', '<!---->', '<!-- a>b -->', '<!--<!-- -->', '<!--<b>-->',
    '<!--\n-->', `<!--${LINE_SEPARATOR}-->`, `<!--a${PARAGRAPH_SEPARATOR}-->`,
    '<!--', '<!--', '-->', '-->', '<!-->', '<!--->',
    '<b>', '</b>', '<a<b>', '<', '>', '-', '--', '!',
    '<script>a</script>', '<style>p{}</style>', '<script>', '</script>', '<STYLE>', '</style >',
    '&lt;!--', '&amp;', '&nbsp;', '&gt;',
    '图 1', 'x', ' ', NBSP, IDEOGRAPHIC_SPACE, '\n', '\t',
];

describe('stripHtml 去注释：线性于串长', () => {
    test('<div> 之后 8 万个「<!--」其后无「-->」，去注释不触发回溯：stripHtml 单次调用在绝对上限内，输出逐字正确', (t) => {
        // Arrange：在计时区间外新构造字符串——V8 对「同一字符串对象 + 同一全局正则」的 replace 结果有缓存
        const input = `<div>${'<!--'.repeat(COMMENT_STRESS_COUNT)}`;
        const expected = '<!--'.repeat(COMMENT_STRESS_COUNT);

        // Act：计时区间只包这一次调用
        const started = process.hrtime.bigint();
        const result = util.stripHtml(input);
        const elapsedMs = elapsedMsSince(started);
        t.diagnostic(`stripHtml 实测 ${elapsedMs.toFixed(2)} ms`);

        // Assert：先验输出正确，以免「快」来自少做了事——<div> 被删去，其后的「<!--」无一闭合、逐个保留。不一致时只报长度与首尾
        // 各 8 个码点，免得断言信息被 32 万字的整串淹没
        if (result !== expected) {
            assert.fail(`stripHtml 输出不符：长 ${result.length}，首 [${toCodePoints(result.slice(0, 8))}]，`
                + `尾 [${toCodePoints(result.slice(-8))}]`);
        }
        assert.ok(
            elapsedMs < COMMENT_STRESS_BUDGET_MS,
            `stripHtml 实测 ${elapsedMs.toFixed(1)} ms，超出上限 ${COMMENT_STRESS_BUDGET_MS} ms`,
        );
    });

    test('removeHtmlComments 与 stripHtml 同线性化之前的实现逐字等价：BMP 逐码元、穷举短串与随机串，各分支与各步均有样本', (t) => {
        // Arrange：典型样本在前
        const samples = [...COMMENT_TYPICAL_SAMPLES, ...STRIP_HTML_CHAIN_SAMPLES];
        // BMP 逐码元 262144 个：每个码元放进四个位置——完整注释之内，考察 [\s\S] 对任意码元的匹配；「<!-」与「-->」之间、
        // 「<!--x-」与「>」之间，码元为「-」时才拼出注释的起记号或止记号；空注释与其后未闭合的「<!--」之间，即紧接末个「-->」的
        // 余部首个码元
        for (let code = 0; code <= 0xffff; code += 1) {
            const unit = String.fromCharCode(code);
            samples.push(`<!--${unit}-->`, `<!-${unit}-->`, `<!--x-${unit}>`, `<!---->${unit}<!--`);
        }
        // 穷举 137257 个：字母表上由 0 到 6 个记号拼成的全部字符串
        for (const text of everyStringUpTo(6, COMMENT_DIFF_ALPHABET)) samples.push(text);
        const random = createSeededRandom(20260923);
        const pick = (items) => items[Math.floor(random() * items.length)];
        const randomTokens = (tokens, count) => Array.from({ length: count }, () => pick(tokens)).join('');
        // 一般随机串 30000 个：0 到 24 个随机记号
        for (let i = 0; i < 30000; i += 1) samples.push(randomTokens(COMMENT_RANDOM_TOKENS, Math.floor(random() * 25)));
        // 结构化随机串 30000 个：0 到 8 个片段，注释、标签、script/style 块、实体与空白交错，使整条清洗各步之间的衔接也有样本
        for (let i = 0; i < 30000; i += 1) samples.push(randomTokens(COMMENT_RANDOM_FRAGMENTS, Math.floor(random() * 9)));
        assert.equal(samples.length, COMMENT_TYPICAL_SAMPLES.length + STRIP_HTML_CHAIN_SAMPLES.length + 459401);

        // Act & Assert：去注释一步的逐字比较，只在不一致时拼装诊断信息，免得数十万次调用都付这笔开销
        const assertCommentStepMatchesLegacy = (value) => {
            const expected = legacyRemoveHtmlComments(value);
            const actual = util.removeHtmlComments(value);
            if (actual !== expected) {
                assert.fail(`输入 ${describeInput(value)}：removeHtmlComments 新式 ${describeInput(actual)}，`
                    + `旧式 ${describeInput(expected)}`);
            }
        };
        // 非字符串入参先比较去注释一步，再比较整条清洗
        for (const value of STRIP_HTML_NON_STRING_INPUTS) {
            assertCommentStepMatchesLegacy(value);
            assertStripHtmlMatchesLegacy(value);
        }
        const counts = {
            noClose: 0, zeroMatch: 0, closeWithoutOpen: 0, oneMatch: 0, multiMatch: 0, trailingOpen: 0,
            strayClose: 0, strayCloseBeforeOpen: 0, overlapLastClose: 0, emptyComment: 0, nestedOpen: 0,
            terminatorInComment: 0, tailAfterLastClose: 0,
        };
        const steps = { blocks: 0, comments: 0, tags: 0, entities: 0, trim: 0 };
        for (const sample of samples) {
            assertCommentStepMatchesLegacy(sample);
            assertStripHtmlMatchesLegacy(sample, steps);
            // 分支归类只用旧式的结果与测试内独立求得的输入特征：comments 为旧式正则在该样本上的全部匹配（带位置）
            const comments = Array.from(sample.matchAll(/<!--[\s\S]*?-->/g));
            const firstOpen = sample.indexOf('<!--');
            const lastClose = sample.lastIndexOf('-->');
            if (lastClose < 0) counts.noClose += 1;
            else if (comments.length === 0 && firstOpen >= 0) counts.zeroMatch += 1;
            else if (comments.length === 0) counts.closeWithoutOpen += 1;
            else if (comments.length === 1) counts.oneMatch += 1;
            else counts.multiMatch += 1;
            if (comments.length > 0) {
                const lastComment = comments[comments.length - 1];
                if (sample.includes('<!--', lastComment.index + lastComment[0].length)) counts.trailingOpen += 1;
            }
            // 「-->」不与自身重叠，也不会跨在匹配的边界上：每个「-->」要么整个落在某处匹配之内，要么在一切匹配之外，后者即孤立者
            let stray = false;
            let strayBeforeOpen = false;
            for (let at = sample.indexOf('-->'); at >= 0; at = sample.indexOf('-->', at + 1)) {
                if (!comments.some((comment) => at >= comment.index && at + 3 <= comment.index + comment[0].length)) {
                    stray = true;
                    if (firstOpen >= 0 && at < firstOpen) strayBeforeOpen = true;
                }
            }
            if (stray) counts.strayClose += 1;
            if (strayBeforeOpen) counts.strayCloseBeforeOpen += 1;
            // 末个「-->」与一个「<!--」重叠：「<!-->」的起点在它之前 2 位，「<!--->」的起点在它之前 3 位
            if (lastClose >= 2
                && (sample.startsWith('<!--', lastClose - 2) || (lastClose >= 3 && sample.startsWith('<!--', lastClose - 3)))) {
                counts.overlapLastClose += 1;
            }
            if (comments.some((comment) => comment[0] === '<!---->')) counts.emptyComment += 1;
            if (comments.some((comment) => comment[0].indexOf('<!--', 1) > 0)) counts.nestedOpen += 1;
            if (comments.some((comment) => TAG_LINE_TERMINATORS.some((terminator) => comment[0].includes(terminator)))) {
                counts.terminatorInComment += 1;
            }
            if (lastClose >= 0 && lastClose + 3 < sample.length) counts.tailAfterLastClose += 1;
        }
        // 覆盖自证：去注释十二类分支都须有样本（前五类按判断链互斥），孤立的「-->」另须有位于首个「<!--」之前者；整条清洗的五步
        // 都须有样本确有作用。差分才不是对某一分支空转
        t.diagnostic(`样本 ${samples.length} 个，另有非字符串入参 ${STRIP_HTML_NON_STRING_INPUTS.length} 个；`
            + `去注释：不含「-->」${counts.noClose}，含「<!--」与「-->」而零匹配 ${counts.zeroMatch}，`
            + `含「-->」而不含「<!--」${counts.closeWithoutOpen}，恰一处匹配 ${counts.oneMatch}，`
            + `两处及以上匹配 ${counts.multiMatch}，末个匹配之后仍余「<!--」${counts.trailingOpen}，`
            + `孤立的「-->」${counts.strayClose}（位于首个「<!--」之前 ${counts.strayCloseBeforeOpen}），`
            + `末个「-->」与「<!--」重叠 ${counts.overlapLastClose}，`
            + `空注释「<!---->」${counts.emptyComment}，注释内含第二个「<!--」${counts.nestedOpen}，`
            + `注释内含行终止符 ${counts.terminatorInComment}，末个「-->」之后仍有字符 ${counts.tailAfterLastClose}`);
        t.diagnostic(`整条清洗各步确有作用的样本数：删去 script/style 块 ${steps.blocks}，删去注释 ${steps.comments}，`
            + `删去标签 ${steps.tags}，还原实体 ${steps.entities}，修剪首尾 ${steps.trim}`);
        assert.ok(counts.noClose > 0, '没有不含「-->」的样本');
        assert.ok(counts.zeroMatch > 0, '没有含「<!--」与「-->」而零匹配的样本');
        assert.ok(counts.closeWithoutOpen > 0, '没有含「-->」而不含「<!--」的样本');
        assert.ok(counts.oneMatch > 0, '没有恰一处匹配的样本');
        assert.ok(counts.multiMatch > 0, '没有两处及以上匹配的样本');
        assert.ok(counts.trailingOpen > 0, '没有末个匹配之后仍余「<!--」的样本');
        assert.ok(counts.strayClose > 0, '没有孤立「-->」的样本');
        assert.ok(counts.strayCloseBeforeOpen > 0, '没有孤立「-->」位于首个「<!--」之前的样本');
        assert.ok(counts.overlapLastClose > 0, '没有末个「-->」与「<!--」重叠的样本');
        assert.ok(counts.emptyComment > 0, '没有空注释「<!---->」的样本');
        assert.ok(counts.nestedOpen > 0, '没有注释内含第二个「<!--」的样本');
        assert.ok(counts.terminatorInComment > 0, '没有注释内含行终止符的样本');
        assert.ok(counts.tailAfterLastClose > 0, '没有末个「-->」之后仍有字符的样本');
        assert.ok(steps.blocks > 0, '没有删去 script/style 块的样本');
        assert.ok(steps.comments > 0, '没有删去注释的样本');
        assert.ok(steps.tags > 0, '整条清洗中没有删去标签的样本');
        assert.ok(steps.entities > 0, '没有还原实体的样本');
        assert.ok(steps.trim > 0, '没有修剪首尾的样本');
    });
});
