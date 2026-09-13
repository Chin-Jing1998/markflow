/**
 * converters/parsers/pdf-local.js（pdfjs 文本层后端）与 converters/parsers/pdf.js（分派器）单元测试
 *
 * 前半部分覆盖本地后端：{ path } 契约、kind/meta 字段、文本抽取、data 不再快照整页文本、
 *   pdfjs 只走 legacy ESM build（不再 require 不存在的 pdf.js）、meta.pdfParser 标注为 pdfjs；
 * 后半部分覆盖分派规则：local / auto / mineru 三种 pdfBackend 与令牌有无的组合。
 * 分派用例一律经 config._setDeps 隔离环境变量与用户目录，结果不受本机是否配置 MinerU 令牌影响。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const parserPath = path.resolve(__dirname, '../converters/parsers/pdf-local.js');
const { parse } = require(parserPath);
const dispatcher = require('../converters/parsers/pdf.js');
const config = require('../converters/config');
const { normalizeOptions } = require('../converters/options');

const SAMPLE_PDF = path.resolve(__dirname, 'fixtures/sample.pdf');

// 空的假用户目录：既没有 ~/.markflow/config.json 也没有 ~/.mineru/config.yaml，
// 令牌有无完全由注入的 env 决定，本机是否配置 MinerU 与本文件结果无关
const EMPTY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-pdf-home-'));
process.on('exit', () => {
    try { fs.rmSync(EMPTY_HOME, { recursive: true, force: true }); } catch (err) { /* 退出阶段静默 */ }
});

/** 把令牌来源钉死：token 为空即「本机没有任何令牌」 */
function isolate(token) {
    config._setDeps({ env: token ? { MINERU_API_TOKEN: token } : {}, homeDir: EMPTY_HOME });
}
isolate(null);

// 本地后端用例一律显式固定 pdfBackend=local：即便日后经分派器调用也不会触网
const LOCAL_CTX = Object.freeze({ options: normalizeOptions({ pdfBackend: 'local' }) });
const ENV_TOKEN = 'env-token-0123456789';

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
    const doc = await parse({ path: SAMPLE_PDF }, LOCAL_CTX);

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
    const doc = await parse({ path: SAMPLE_PDF }, LOCAL_CTX);

    // Assert
    assert.equal(doc.meta.title, 'sample');
    assert.equal(doc.meta.sourceType, 'pdf');
    assert.equal(doc.meta.sourceName, 'sample.pdf');
    assert.equal(doc.meta.pdfParser, 'pdfjs', '本地后端须自报家门，index.js 据此写出 backends.pdfParser');
});

test('ctx.sourceName 覆盖文件名，并参与 title 回退', async () => {
    // Arrange & Act
    const doc = await parse({ path: SAMPLE_PDF }, { ...LOCAL_CTX, sourceName: '季度报告.pdf' });

    // Assert
    assert.equal(doc.meta.sourceName, '季度报告.pdf');
    assert.equal(doc.meta.title, '季度报告');
});

test('data 只保留轻量元信息，不快照整页文本；assets 为空数组', async () => {
    // Arrange & Act
    const doc = await parse({ path: SAMPLE_PDF }, LOCAL_CTX);

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
    const doc = await parse({ path: relative }, LOCAL_CTX);

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
    await assert.rejects(() => parse({ path: missing }, LOCAL_CTX), (err) => err.code === 'ENOENT');
});

test('onProgress 回调抛错不影响解析', async () => {
    // Arrange
    const calls = [];

    // Act
    const doc = await parse(
        { path: SAMPLE_PDF },
        {
            ...LOCAL_CTX,
            onProgress: (phase, pct) => {
                calls.push([phase, pct]);
                throw new Error('调用方回调故意抛错');
            },
        },
    );

    // Assert
    assert.ok(calls.length >= 1);
    assert.equal(calls[0][0], 'parsing');
    assert.ok(
        calls.every(([phase, pct]) => phase === 'parsing' && pct >= 20 && pct <= 55),
        `进度只应为 parsing 且落在 20–55，实际 ${JSON.stringify(calls)}`,
    );
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

// ============================================================
// 分派器：pdfBackend × 令牌
// ============================================================

function stubDoc(pdfParser) {
    return {
        schemaVersion: 1,
        kind: 'document',
        ir: { type: 'root', children: [] },
        data: null,
        meta: { sourceType: 'pdf', sourceName: 'sample.pdf', pdfParser },
        assets: [],
        extras: [],
        warnings: [],
    };
}

function createBackendStubs({ mineruError } = {}) {
    const calls = { local: [], mineru: [] };
    return {
        calls,
        local: {
            parse: async (input, ctx) => {
                calls.local.push({ input, ctx });
                return stubDoc('pdfjs');
            },
        },
        mineru: {
            parseWithMineru: async (input, ctx, auth) => {
                calls.mineru.push({ input, ctx, auth });
                if (mineruError) throw mineruError;
                return stubDoc('mineru');
            },
        },
    };
}

async function dispatch({ backend, token, stubs, mineruOptions }) {
    isolate(token);
    dispatcher._setDeps({ local: stubs.local, mineru: stubs.mineru });
    try {
        return await dispatcher.parse(
            { path: SAMPLE_PDF },
            {
                sourceName: 'sample.pdf',
                options: normalizeOptions({ pdfBackend: backend, ...(mineruOptions ? { mineru: mineruOptions } : {}) }),
            },
        );
    } finally {
        dispatcher._reset();
        isolate(null);
    }
}

test('pdfBackend 为 local 时走本地后端，即便配置了令牌', async () => {
    // Arrange
    const stubs = createBackendStubs();

    // Act
    const doc = await dispatch({ backend: 'local', token: ENV_TOKEN, stubs });

    // Assert
    assert.equal(stubs.calls.local.length, 1);
    assert.equal(stubs.calls.mineru.length, 0);
    assert.equal(doc.meta.pdfParser, 'pdfjs');
    assert.deepEqual(doc.warnings, [], 'local 是用户显式选择，不该附加回退提示');
});

test('pdfBackend 为 auto 且无令牌时回退本地，并给出 warning', async () => {
    // Arrange
    const stubs = createBackendStubs();

    // Act
    const doc = await dispatch({ backend: 'auto', token: null, stubs });

    // Assert
    assert.equal(stubs.calls.local.length, 1);
    assert.equal(stubs.calls.mineru.length, 0);
    assert.deepEqual(doc.warnings, [dispatcher.FALLBACK_WARNING]);
    assert.match(dispatcher.FALLBACK_WARNING, /未配置 MinerU 令牌/);
});

test('pdfBackend 为 auto 且有令牌时走云端，令牌透传给后端', async () => {
    // Arrange
    const stubs = createBackendStubs();

    // Act
    const doc = await dispatch({ backend: 'auto', token: ENV_TOKEN, stubs });

    // Assert
    assert.equal(stubs.calls.mineru.length, 1);
    assert.equal(stubs.calls.local.length, 0);
    assert.equal(stubs.calls.mineru[0].auth.token, ENV_TOKEN);
    assert.equal(doc.meta.pdfParser, 'mineru');
});

test('options.mineru.token 显式给出时即便环境变量为空也走云端', async () => {
    // Arrange
    const stubs = createBackendStubs();

    // Act
    await dispatch({ backend: 'auto', token: null, stubs, mineruOptions: { token: 'explicit-token-xyz' } });

    // Assert
    assert.equal(stubs.calls.mineru.length, 1);
    assert.equal(stubs.calls.mineru[0].auth.token, 'explicit-token-xyz');
});

test('pdfBackend 为 mineru 却无令牌时抛中文错误，并指出两种配置方式', async () => {
    // Arrange
    const stubs = createBackendStubs();

    // Act & Assert
    await assert.rejects(
        () => dispatch({ backend: 'mineru', token: null, stubs }),
        (err) => {
            assert.match(err.message, /未配置 MinerU 令牌/);
            assert.match(err.message, /markflow config set mineru-token/);
            assert.match(err.message, /MINERU_TOKEN \/ MINERU_API_TOKEN/);
            return true;
        },
    );
    assert.equal(stubs.calls.local.length, 0, '强制云端时不得偷偷回退本地');
});

test('云端解析失败时直接抛错，不静默降级为本地解析', async () => {
    // Arrange
    const stubs = createBackendStubs({ mineruError: new Error('MinerU 额度已耗尽：…') });

    // Act & Assert
    await assert.rejects(() => dispatch({ backend: 'auto', token: ENV_TOKEN, stubs }), /额度已耗尽/);
    assert.equal(stubs.calls.local.length, 0);
});

test('分派器缺少 input.path 时抛中文错误', async () => {
    // Arrange
    const stubs = createBackendStubs();
    dispatcher._setDeps({ local: stubs.local, mineru: stubs.mineru });

    // Act & Assert
    try {
        await assert.rejects(() => dispatcher.parse({}), /parsers\/pdf 需要 input\.path/);
    } finally {
        dispatcher._reset();
    }
});

test('分派器在 pdfBackend=local 下调用真实本地后端，全程离线', async () => {
    // Arrange：故意让环境里有令牌，验证 local 是硬性选择而非「没令牌才走」
    isolate(ENV_TOKEN);

    // Act
    try {
        const doc = await dispatcher.parse({ path: SAMPLE_PDF }, { ...LOCAL_CTX, sourceName: 'sample.pdf' });

        // Assert
        assert.equal(doc.meta.pdfParser, 'pdfjs');
        assert.equal(doc.meta.sourceType, 'pdf');
        assert.deepEqual(doc.warnings, []);
    } finally {
        isolate(null);
    }
});
