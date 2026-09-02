/**
 * server.js 集成测试（真实 HTTP 服务，端口由系统分配）
 * 覆盖：token 鉴权、静态资源白名单、/api/formats、输出目录设置、/api/convert 的 NDJSON 流与入参校验
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-server-'));
// 必须在 startServer 之前改写，避免测试写入用户真实的 ~/.markflow/settings.json
process.env.MARKFLOW_SETTINGS_FILE = path.join(TMP_ROOT, 'settings.json');

const { startServer } = require('../server');

const OUTPUT_DIR = path.join(TMP_ROOT, 'out');
const ALT_DIR = path.join(TMP_ROOT, 'alt');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(ALT_DIR, { recursive: true });

const SAMPLE_MD = path.join(__dirname, 'fixtures', 'sample.md');

let handle;

before(async () => {
    handle = await startServer({ port: 0, outputDir: OUTPUT_DIR });
});

after(async () => {
    if (handle) await handle.close();
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// 用 node:http 而非 fetch：fetch 会规范化 URL 路径，无法验证 /css/../server.js 这类原样请求
function request(method, rawPath, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
        const req = http.request(
            {
                host: '127.0.0.1',
                port: handle.port,
                method,
                path: rawPath,
                agent: false,
                headers: {
                    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
                    ...headers,
                },
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    text: Buffer.concat(chunks).toString('utf8'),
                }));
            },
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// 带鉴权头的请求
function authed(method, rawPath, options = {}) {
    return request(method, rawPath, {
        ...options,
        headers: { 'X-MarkFlow-Token': handle.token, ...(options.headers || {}) },
    });
}

const parseNdjson = (text) => text.trim().split('\n').map((line) => JSON.parse(line));

// ============================================================
// 鉴权
// ============================================================

describe('token 鉴权', () => {
    test('缺少 token 访问 /api/formats 返回 401', async () => {
        const res = await request('GET', '/api/formats');
        assert.equal(res.status, 401);
        assert.deepEqual(JSON.parse(res.text), { success: false, error: '未授权' });
    });

    test('错误 token 返回 401', async () => {
        const res = await request('GET', '/api/formats', { headers: { 'X-MarkFlow-Token': 'wrong' } });
        assert.equal(res.status, 401);
    });

    test('缺少 token 访问 /api/convert 返回 401', async () => {
        const res = await request('POST', '/api/convert', { body: { items: [] } });
        assert.equal(res.status, 401);
    });
});

// ============================================================
// 静态资源白名单
// ============================================================

describe('静态资源白名单', () => {
    test('GET / 返回首页 HTML', async () => {
        const res = await authed('GET', '/');
        assert.equal(res.status, 200);
        assert.ok(res.text.includes('<html'), '响应体应包含 <html');
    });

    test('GET /css/styles.css 返回 200', async () => {
        const res = await request('GET', '/css/styles.css');
        assert.equal(res.status, 200);
    });

    for (const rawPath of ['/server.js', '/package.json', '/css/../server.js', '/converters/index.js']) {
        test(`GET ${rawPath} 返回 404`, async () => {
            const res = await request('GET', rawPath);
            assert.equal(res.status, 404);
        });
    }

    test('白名单目录内的不存在文件返回 404', async () => {
        const res = await request('GET', '/js/not-exist.js');
        assert.equal(res.status, 404);
    });
});

// ============================================================
// /api/formats
// ============================================================

describe('GET /api/formats', () => {
    test('带 token 返回能力矩阵与当前输出目录', async () => {
        // Act
        const res = await authed('GET', '/api/formats');
        const body = JSON.parse(res.text);

        // Assert
        assert.equal(res.status, 200);
        assert.equal(body.success, true);
        assert.ok(body.targets.office.includes('bundle'), 'targets.office 应包含 bundle');
        assert.ok(body.targets.markup.includes('docx'), 'targets.markup 应包含 docx');
        assert.equal(typeof body.capabilities.sofficeAvailable, 'boolean');
        assert.equal(typeof body.capabilities.pdfBackend.available, 'boolean');
        assert.equal(body.outputDir, OUTPUT_DIR);
        assert.equal(res.headers['cache-control'], 'no-store');
    });
});

// ============================================================
// 输出目录设置
// ============================================================

describe('/api/settings/output-dir', () => {
    test('GET 返回启动时设定的输出目录', async () => {
        const res = await authed('GET', '/api/settings/output-dir');
        assert.equal(res.status, 200);
        assert.deepEqual(JSON.parse(res.text), { success: true, outputDir: OUTPUT_DIR });
    });

    test('POST 不存在的目录返回 400', async () => {
        const res = await authed('POST', '/api/settings/output-dir', { body: { dir: '/nonexistent' } });
        assert.equal(res.status, 400);
        assert.equal(JSON.parse(res.text).success, false);
    });

    test('POST 相对路径返回 400', async () => {
        const res = await authed('POST', '/api/settings/output-dir', { body: { dir: 'relative/dir' } });
        assert.equal(res.status, 400);
        assert.match(JSON.parse(res.text).error, /绝对路径/);
    });

    test('POST 空值恢复默认目录并删除持久化设置', async () => {
        process.env.MARKFLOW_OUTPUT_DIR = OUTPUT_DIR;
        try {
            const res = await authed('POST', '/api/settings/output-dir', { body: {} });
            assert.equal(res.status, 200);
            assert.deepEqual(JSON.parse(res.text), { success: true, outputDir: OUTPUT_DIR });
            assert.equal(fs.existsSync(process.env.MARKFLOW_SETTINGS_FILE), false);
        } finally {
            delete process.env.MARKFLOW_OUTPUT_DIR;
        }
    });

    test('POST 合法目录写入持久化文件，随后可恢复', async () => {
        // Act
        const res = await authed('POST', '/api/settings/output-dir', { body: { dir: ALT_DIR } });

        // Assert
        assert.equal(res.status, 200);
        assert.deepEqual(JSON.parse(res.text), { success: true, outputDir: ALT_DIR });
        const persisted = JSON.parse(fs.readFileSync(process.env.MARKFLOW_SETTINGS_FILE, 'utf8'));
        assert.equal(persisted.outputDir, ALT_DIR);

        // 复原，避免影响后续用例
        await authed('POST', '/api/settings/output-dir', { body: { dir: OUTPUT_DIR } });
    });
});

// ============================================================
// /api/convert
// ============================================================

describe('POST /api/convert 入参校验', () => {
    const cases = [
        ['items 为空数组', { items: [] }, /items 必须是非空数组/],
        ['items 缺失', {}, /items 必须是非空数组/],
        ['相对路径', { items: [{ path: 'relative.md', target: 'docx' }] }, /^第 1 项：路径必须是绝对路径/],
        ['文件不存在', { items: [{ path: '/nonexistent/a.md', target: 'docx' }] }, /^第 1 项：文件不存在/],
        ['目标与输入类型不匹配', { items: [{ path: SAMPLE_MD, target: 'bundle' }] }, /^第 1 项：md 输入只能转为/],
        ['本机地址 URL', { items: [{ url: 'http://127.0.0.1/', target: 'bundle' }] }, /^第 1 项：/],
        ['path 与 url 同时缺失', { items: [{ target: 'docx' }] }, /^第 1 项：path 与 url 必须二选一/],
        ['outputDir 不存在', { items: [{ path: SAMPLE_MD, target: 'docx' }], outputDir: '/nonexistent' }, /目录不存在/],
    ];

    for (const [name, body, pattern] of cases) {
        test(`${name} 返回 400 且不启动转换`, async () => {
            const res = await authed('POST', '/api/convert', { body });
            assert.equal(res.status, 400);
            const parsed = JSON.parse(res.text);
            assert.equal(parsed.success, false);
            assert.match(parsed.error, pattern);
        });
    }

    test('第 2 项非法时错误信息指明序号', async () => {
        const res = await authed('POST', '/api/convert', {
            body: { items: [{ path: SAMPLE_MD, target: 'docx' }, { path: 'bad.md', target: 'docx' }] },
        });
        assert.equal(res.status, 400);
        assert.match(JSON.parse(res.text).error, /^第 2 项：/);
    });
});

describe('POST /api/convert 流式转换', () => {
    test('Markdown 转 docx 成功并按 NDJSON 回传事件', async () => {
        // Act
        const res = await authed('POST', '/api/convert', {
            body: { items: [{ path: SAMPLE_MD, target: 'docx' }] },
        });

        // Assert：响应头
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'], /application\/x-ndjson/);
        assert.equal(res.headers['x-accel-buffering'], 'no');

        // Assert：事件序列
        const events = parseNdjson(res.text);
        assert.equal(events[0].type, 'accepted');
        assert.equal(events[0].total, 1);
        assert.equal(events[0].outputDir, OUTPUT_DIR);
        assert.ok(events.some((e) => e.type === 'start' && e.idx === 0), '应有 start 事件');
        assert.ok(events.some((e) => e.type === 'progress'), '应有 progress 事件');

        const item = events.find((e) => e.type === 'item');
        assert.equal(item.ok, true);
        assert.ok(fs.existsSync(item.result.outputPath), '产物文件应存在于磁盘');
        assert.equal(path.dirname(item.result.outputPath), OUTPUT_DIR);

        const last = events[events.length - 1];
        assert.deepEqual(last, { type: 'done', total: 1, succeeded: 1, failed: 0 });
    });

    test('outputDir 显式指定时产物落在该目录', async () => {
        const res = await authed('POST', '/api/convert', {
            body: { items: [{ path: SAMPLE_MD, target: 'docx' }], outputDir: ALT_DIR },
        });
        const events = parseNdjson(res.text);
        assert.equal(events[0].outputDir, ALT_DIR);
        const item = events.find((e) => e.type === 'item');
        assert.equal(path.dirname(item.result.outputPath), ALT_DIR);
    });
});
