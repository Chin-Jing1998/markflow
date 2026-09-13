/**
 * converters/pdf/mineru.js 单元测试
 *
 * 全程不触网：client（SDK 的 submit）、fetch（轮询与 zip 下载）、now / sleep（时钟）、stat（文件大小）
 * 一律经 _setDeps 注入；结果包由 jszip 现造。
 *
 * 覆盖：zip 全部条目进 extras（含 mineru/ 前缀）、IR 图片引用与 extras 内图片一致、表格进 IR、
 *       提交参数映射、进度单调且 ≤ 55、令牌不进结果、各错误码中文化（鉴权失败须点名令牌来源）、
 *       超时含 batch_id 且不含令牌、超 200 MB 与 zip 超 1 GB 的拦截。
 * 分派规则（auto 无令牌回退 local 并 warning、mineru 无令牌抛错）在 test/pdf-parser.test.js。
 *
 * 令牌一律由用例显式传入（parseWithMineru 的第三参），不经 config 解析；模块加载时另把 config 的
 * 环境变量与用户目录钉到空值，杜绝任何路径读到本机真实令牌。用例中的 PDF 只被 stat，不走真实解析器。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');

const mineru = require('../converters/pdf/mineru');
const config = require('../converters/config');
const { normalizeOptions } = require('../converters/options');

// 离线可复现：空环境变量 + 空用户目录，令牌来源只可能是用例显式传入的那一个
const EMPTY_HOME = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'markflow-mineru-home-'));
config._setDeps({ env: {}, homeDir: EMPTY_HOME });
process.on('exit', () => {
    try { fs.rmSync(EMPTY_HOME, { recursive: true, force: true }); } catch (err) { /* 退出阶段静默 */ }
});

const SAMPLE_PDF = path.resolve(__dirname, 'fixtures/sample.pdf');
const PIC_PNG = fs.readFileSync(path.resolve(__dirname, 'fixtures/images/pic.png'));
const TOKEN = 'secret-token-abcdef123456';
const BATCH_ID = 'batch-0001';
const ZIP_URL = 'https://cdn.mineru.net/results/batch-0001.zip';
const POLL_URL = `${mineru.API_BASE}/extract-results/batch/${BATCH_ID}`;

const FULL_MD = [
    '# MinerU 示例文档',
    '',
    '第一段正文。',
    '',
    '![](images/pic.png)',
    '',
    '<table><tr><th>名称</th><th>数量</th></tr><tr><td>甲</td><td>1</td></tr></table>',
    '',
    '结尾段落。',
    '',
].join('\n');

// ============================================================
// 夹具
// ============================================================

async function makeResultZip(files = {}) {
    const zip = new JSZip();
    zip.file('full.md', FULL_MD);
    zip.file('layout.json', '{"pdf_info":[]}');
    zip.file('sample_content_list.json', '[]');
    zip.file('sample_model.json', '[]');
    zip.file('images/pic.png', PIC_PNG);
    for (const [name, content] of Object.entries(files)) zip.file(name, content);
    return zip.generateAsync({ type: 'nodebuffer' });
}

const jsonResponse = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
});

const taskBody = (task) => ({ code: 0, msg: 'ok', data: { batch_id: BATCH_ID, extract_result: [task] } });

const donePolls = (extra = []) => [
    taskBody({ state: 'waiting-file' }),
    taskBody({ state: 'pending' }),
    taskBody({ state: 'running', extract_progress: { extracted_pages: 1, total_pages: 4 } }),
    taskBody({ state: 'running', extract_progress: { extracted_pages: 4, total_pages: 4 } }),
    taskBody({ state: 'converting', extract_progress: { extracted_pages: 4, total_pages: 4 } }),
    ...extra,
    taskBody({
        state: 'done',
        full_zip_url: ZIP_URL,
        file_name: 'sample.pdf',
        extract_progress: { extracted_pages: 4, total_pages: 4 },
    }),
];

/**
 * 轮询按顺序回放 polls，最后一条到顶后重复；zip 地址回放结果包。
 * polls 的元素为响应体对象（自动包成 200 JSON）或返回 Response 的函数（用于造非 2xx 响应）。
 */
function createFetchStub({ polls, zip, zipHeaders = {} }) {
    const calls = [];
    let index = 0;
    const impl = async (url, init) => {
        const target = String(url);
        calls.push({ url: target, init });
        if (target.startsWith(`${mineru.API_BASE}/extract-results/batch/`)) {
            const body = polls[Math.min(index, polls.length - 1)];
            index += 1;
            return typeof body === 'function' ? body() : jsonResponse(body);
        }
        if (target === ZIP_URL) return new Response(zip, { headers: zipHeaders });
        throw new Error(`未预期的请求：${target}`);
    };
    impl.calls = calls;
    return impl;
}

function createClientStub({ batchId = BATCH_ID, onSubmit } = {}) {
    const calls = [];
    return {
        calls,
        submit: async (source, options) => {
            calls.push({ source, options });
            if (typeof onSubmit === 'function') return onSubmit(source, options);
            return batchId;
        },
    };
}

/** 单调递增的假时钟：每次取值前进 step 毫秒 */
function createClock(step = 1000) {
    let value = 0;
    return () => {
        value += step;
        return value;
    };
}

async function run({ polls, zip, zipHeaders, client, options, stat, clockStep = 1000, authSource = 'env:MINERU_API_TOKEN' } = {}) {
    const events = [];
    const fetchStub = createFetchStub({ polls: polls || donePolls(), zip: zip || await makeResultZip(), zipHeaders });
    const clientStub = client || createClientStub();
    mineru._setDeps({
        client: clientStub,
        fetch: fetchStub,
        now: createClock(clockStep),
        sleep: async () => {},
        ...(stat ? { stat } : {}),
    });
    try {
        const doc = await mineru.parseWithMineru(
            { path: SAMPLE_PDF },
            {
                sourceName: 'sample.pdf',
                options: normalizeOptions(options),
                onProgress: (phase, pct) => events.push([phase, pct]),
            },
            { token: TOKEN, source: authSource },
        );
        return { doc, events, fetchStub, clientStub };
    } finally {
        mineru._reset();
    }
}

async function runRejects({ polls, zip, zipHeaders, client, options, stat, clockStep = 1000, authSource } = {}) {
    try {
        await run({ polls, zip, zipHeaders, client, options, stat, clockStep, authSource });
    } catch (err) {
        return err;
    }
    throw new Error('预期抛出错误，实际成功返回');
}

function collect(node, predicate, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (predicate(node)) out.push(node);
    if (Array.isArray(node.children)) for (const child of node.children) collect(child, predicate, out);
    return out;
}

// ============================================================
// 产物完整性
// ============================================================

test('zip 内全部条目原样进 extras，名字带 mineru/ 前缀', async () => {
    // Arrange & Act
    const { doc } = await run();

    // Assert
    const names = doc.extras.map((item) => item.name).sort();
    assert.deepEqual(names, [
        'mineru/full.md',
        'mineru/images/pic.png',
        'mineru/layout.json',
        'mineru/sample_content_list.json',
        'mineru/sample_model.json',
    ]);
    const layout = doc.extras.find((item) => item.name === 'mineru/layout.json');
    assert.equal(layout.buffer.toString('utf8'), '{"pdf_info":[]}');
    assert.ok(doc.extras.every((item) => Buffer.isBuffer(item.buffer)));
});

test('data.mineru 记录 model / batchId / pages / files，meta 标注解析后端', async () => {
    // Arrange & Act
    const { doc } = await run({ options: { mineru: { model: 'vlm' } } });

    // Assert
    assert.deepEqual(doc.data.mineru, {
        model: 'vlm',
        batchId: BATCH_ID,
        pages: 4,
        files: ['full.md', 'images/pic.png', 'layout.json', 'sample_content_list.json', 'sample_model.json'],
    });
    assert.equal(doc.meta.pdfParser, 'mineru');
    assert.equal(doc.meta.mineruModel, 'vlm');
    assert.equal(doc.meta.sourceType, 'pdf');
    assert.equal(doc.meta.sourceName, 'sample.pdf');
    assert.equal(doc.meta.title, 'MinerU 示例文档');
    assert.equal(doc.kind, 'document');
});

test('done 响应不带 extract_progress 时，页数取轮询期间见过的最大值', async () => {
    // Arrange：实测小文档完成得快，done 响应里往往已没有 extract_progress
    const polls = [
        taskBody({ state: 'running', extract_progress: { extracted_pages: 2, total_pages: 7 } }),
        taskBody({ state: 'done', full_zip_url: ZIP_URL }),
    ];

    // Act
    const { doc } = await run({ polls });

    // Assert
    assert.equal(doc.data.mineru.pages, 7);
    assert.equal(doc.data.numPages, 7);
});

test('IR 中的图片引用与 extras 内的图片一致，且已登记为 assets', async () => {
    // Arrange & Act
    const { doc } = await run();

    // Assert
    assert.equal(doc.assets.length, 1);
    assert.equal(doc.assets[0].name, 'images/image_1.png');
    assert.ok(doc.assets[0].buffer.equals(PIC_PNG));

    const images = collect(doc.ir, (n) => n.type === 'image');
    assert.equal(images.length, 1);
    assert.equal(images[0].url, 'images/image_1.png', 'IR 引用须对齐资源名，否则产物 md 指向不存在的文件');
    assert.equal(images[0].data.assetName, 'images/image_1.png');

    const packed = doc.extras.find((item) => item.name === 'mineru/images/pic.png');
    assert.ok(packed.buffer.equals(doc.assets[0].buffer), 'extras 内的图片与 assets 应是同一份字节');
    assert.deepEqual(doc.warnings, []);
});

test('full.md 中的规则表被转成 mdast table 进入 IR', async () => {
    // Arrange & Act
    const { doc } = await run();

    // Assert
    const tables = collect(doc.ir, (n) => n.type === 'table');
    assert.equal(tables.length, 1);
    assert.equal(tables[0].children.length, 2);
    const header = tables[0].children[0].children.map((cell) => cell.children[0].value);
    assert.deepEqual(header, ['名称', '数量']);
    assert.equal(collect(doc.ir, (n) => n.type === 'html').length, 0, '规则表不应再以原始 HTML 形式留在 IR 中');
});

// ============================================================
// 提交参数与进度
// ============================================================

test('提交参数按 options.mineru 映射，并带上 sourceName 的哈希作 data_id', async () => {
    // Arrange
    const client = createClientStub();

    // Act
    await run({
        client,
        options: { mineru: { model: 'vlm', ocr: true, formula: false, table: false, language: 'en', pageRanges: '1-3' } },
    });

    // Assert
    assert.equal(client.calls.length, 1);
    const { source, options } = client.calls[0];
    assert.equal(source, SAMPLE_PDF);
    assert.equal(options.model, 'vlm');
    assert.equal(options.ocr, true);
    assert.equal(options.formula, false);
    assert.equal(options.table, false);
    assert.equal(options.language, 'en');
    assert.equal(options.pages, '1-3');
    const fileParam = options.fileParams[SAMPLE_PDF];
    assert.match(fileParam.dataId, /^markflow-[0-9a-f]{16}$/, 'data_id 须为定长哈希，不含路径与中文');
});

test('轮询走 Bearer 鉴权的 extract-results 端点', async () => {
    // Arrange & Act
    const { fetchStub } = await run();

    // Assert
    const polls = fetchStub.calls.filter((call) => call.url.startsWith(`${mineru.API_BASE}/extract-results/`));
    assert.ok(polls.length >= 6);
    assert.equal(polls[0].url, POLL_URL);
    assert.equal(polls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(fetchStub.calls.at(-1).url, ZIP_URL);
});

test('进度单调不减、上限 55，提交后从 10 起、IR 建好为 55', async () => {
    // Arrange & Act
    const { events } = await run();

    // Assert
    assert.ok(events.every(([phase]) => phase === 'parsing'), `阶段名须恒为 parsing，实际 ${JSON.stringify(events)}`);
    const values = events.map(([, pct]) => pct);
    assert.equal(values[0], 10);
    assert.equal(values.at(-1), 55);
    assert.ok(values.every((v) => v <= 55), `进度不得越过 55，实际 ${values.join(',')}`);
    assert.ok(values.every((v, i) => i === 0 || v >= values[i - 1]), `进度须单调不减，实际 ${values.join(',')}`);
    assert.ok(values.includes(48), 'converting 阶段应上报 48');
    assert.ok(values.some((v) => v > 15 && v < 48), `running 阶段应按页进度插值，实际 ${values.join(',')}`);
});

test('令牌不出现在返回的 data / meta / warnings 中', async () => {
    // Arrange & Act
    const { doc } = await run();

    // Assert
    const payload = JSON.stringify({ data: doc.data, meta: doc.meta, warnings: doc.warnings });
    assert.ok(!payload.includes(TOKEN));
});

// ============================================================
// 错误处理
// ============================================================

test('令牌无效（A0202）点名令牌来源，且不回显令牌', async () => {
    // Arrange
    const client = createClientStub({
        onSubmit: () => {
            throw Object.assign(new Error(`[A0202] token ${TOKEN} invalid (trace: abc)`), { code: 'A0202' });
        },
    });

    // Act
    const err = await runRejects({ client, authSource: 'env:MINERU_API_TOKEN' });

    // Assert
    assert.equal(
        err.message,
        'MinerU 令牌无效或已过期（来源：env:MINERU_API_TOKEN），请用 markflow config set mineru-token 更新或设置环境变量 MINERU_API_TOKEN',
    );
    assert.ok(!err.message.includes(TOKEN), `错误信息不得回显令牌：${err.message}`);
});

test('鉴权失败来源为 mineru-cli 时点明读取自 ~/.mineru/config.yaml', async () => {
    // Arrange
    const client = createClientStub({
        onSubmit: () => {
            throw Object.assign(new Error('[A0211] auth failed'), { code: 'A0211' });
        },
    });

    // Act
    const err = await runRejects({ client, authSource: 'mineru-cli' });

    // Assert
    assert.match(err.message, /来源：mineru-cli/);
    assert.match(err.message, /读取自 ~\/\.mineru\/config\.yaml/);
    assert.ok(!err.message.includes(TOKEN));
});

test('令牌由 options 显式给出时来源显示为 options', async () => {
    // Arrange
    const client = createClientStub({
        onSubmit: () => {
            throw Object.assign(new Error('[A0202] token invalid'), { code: 'A0202' });
        },
    });

    // Act
    const err = await runRejects({ client, authSource: 'explicit' });

    // Assert
    assert.match(err.message, /来源：options/);
});

test('超页数（-60006）提示用 pageRanges 分批', async () => {
    // Arrange & Act
    const err = await runRejects({ polls: [{ code: -60006, msg: 'page limit exceeded' }] });

    // Assert
    assert.match(err.message, /页数超过 MinerU 单次解析上限/);
    assert.match(err.message, /pageRanges/);
});

test('额度耗尽（-60018 / -60019）提示改用 --pdf-backend local', async () => {
    // Arrange & Act
    const first = await runRejects({ polls: [{ code: -60018, msg: 'quota exceeded' }] });
    const second = await runRejects({ polls: [{ code: -60019, msg: 'quota exceeded' }] });

    // Assert
    for (const err of [first, second]) {
        assert.match(err.message, /额度已耗尽/);
        assert.match(err.message, /--pdf-backend local/);
    }
});

test('任务 failed 且 err_code 为 -60010 时翻译为云端解析失败', async () => {
    // Arrange
    const polls = [taskBody({ state: 'failed', err_code: -60010, err_msg: 'parse failed' })];

    // Act
    const err = await runRejects({ polls });

    // Assert
    assert.match(err.message, /MinerU 云端解析失败/);
});

test('轮询遇到 HTTP 401 时按鉴权失败处理并点名来源', async () => {
    // Arrange：实测服务端令牌失效时回的是 401，业务码只在响应体的 msgCode 里
    const polls = [() => new Response(
        '{"traceId":"151fc5e3064a","msgCode":"A0202","msg":"user authenticate failed","success":false}',
        { status: 401, statusText: 'Unauthorized' },
    )];

    // Act
    const err = await runRejects({ polls, authSource: 'config' });

    // Assert
    assert.match(err.message, /MinerU 令牌无效或已过期（来源：config）/);
    assert.ok(!err.message.includes(TOKEN));
});

test('SDK 抛出的 HTTP 401（业务码在响应体里）同样认作鉴权失败', async () => {
    // Arrange
    const client = createClientStub({
        onSubmit: () => {
            throw new Error('HTTP 401: Unauthorized — {"traceId":"abc","msgCode":"A0202","msg":"user authenticate failed"}');
        },
    });

    // Act
    const err = await runRejects({ client, authSource: 'mineru-cli' });

    // Assert
    assert.match(err.message, /来源：mineru-cli，读取自 ~\/\.mineru\/config\.yaml/);
});

test('非鉴权的 HTTP 错误回落到通用失败文案', async () => {
    // Arrange
    const polls = [() => new Response('upstream boom', { status: 500, statusText: 'Server Error' })];

    // Act
    const err = await runRejects({ polls });

    // Assert
    assert.match(err.message, /MinerU 接口调用失败/);
    assert.match(err.message, /HTTP 500/);
    assert.ok(!/令牌无效/.test(err.message));
});

test('任务不存在（-60012）翻译为重新发起转换', async () => {
    // Arrange & Act
    const err = await runRejects({ polls: [{ code: -60012, msg: 'task not found' }] });

    // Assert
    assert.match(err.message, /任务不存在或已过期/);
});

test('网络故障翻译为网络请求失败', async () => {
    // Arrange
    const client = createClientStub({
        onSubmit: () => {
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
        },
    });

    // Act
    const err = await runRejects({ client });

    // Assert
    assert.match(err.message, /网络请求失败/);
});

test('未知错误码回显服务端摘要，但抹掉其中的令牌', async () => {
    // Arrange
    const polls = [{ code: -99999, msg: `rejected for Bearer ${TOKEN}` }];

    // Act
    const err = await runRejects({ polls });

    // Assert
    assert.match(err.message, /MinerU 接口调用失败/);
    assert.ok(!err.message.includes(TOKEN), `错误信息不得回显令牌：${err.message}`);
    assert.match(err.message, /（已隐藏）/);
});

test('超时错误带上 batch_id 且不含令牌', async () => {
    // Arrange：时钟每次前进 100 秒，默认 timeoutSec 600 会在数轮内耗尽
    const polls = [taskBody({ state: 'pending' })];

    // Act
    const err = await runRejects({ polls, clockStep: 100000 });

    // Assert
    assert.match(err.message, /MinerU 解析超时/);
    assert.ok(err.message.includes(BATCH_ID), `超时错误须带 batch_id：${err.message}`);
    assert.ok(!err.message.includes(TOKEN));
    assert.match(err.message, /mineru\.timeoutSec/);
});

test('文件超过 200 MB 时本地直接拒绝，不发起上传', async () => {
    // Arrange
    const client = createClientStub();
    const stat = async () => ({ size: mineru.MAX_UPLOAD_BYTES + 1, isFile: () => true });

    // Act
    const err = await runRejects({ client, stat });

    // Assert
    assert.match(err.message, /超过 MinerU 单文件 200 MB 上限/);
    assert.equal(client.calls.length, 0, '超限时不应发起提交');
});

test('结果包 content-length 超过 1 GB 时拒绝下载', async () => {
    // Arrange
    const zipHeaders = { 'content-length': String(mineru.MAX_ZIP_BYTES + 1) };

    // Act
    const err = await runRejects({ zipHeaders });

    // Assert
    assert.match(err.message, /结果包超过 1 GB 上限/);
});

test('结果包为空时给出中文错误', async () => {
    // Arrange
    const empty = await new JSZip().generateAsync({ type: 'nodebuffer' });

    // Act
    const err = await runRejects({ zip: empty });

    // Assert
    assert.match(err.message, /结果包为空/);
});

test('缺少 input.path 时抛出中文错误', async () => {
    // Arrange & Act & Assert
    await assert.rejects(() => mineru.parseWithMineru({}, {}, { token: TOKEN }), /pdf\/mineru 需要 input\.path/);
});
