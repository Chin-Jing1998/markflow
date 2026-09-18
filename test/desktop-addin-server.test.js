/**
 * desktop/main/addin/server.js 单元测试（真实 http 监听临时端口，转换内核以桩替代，脱离 Electron）
 * 覆盖：探活 200 且免令牌；令牌只注入 taskpane.html、不进脚本与样式，重启即换；无令牌 / 错令牌 401；
 *       错 Host 403、错 Origin 403、非 GET 缺自定义头 403（含 OPTIONS 预检）；任何响应都不带 CORS 头；
 *       超限 413（Content-Length 声明超限与分块实际超限两条路径）；路径穿越与未知路径 404；
 *       上传 → 轮询 → 成功 → 在访达中显示 / 预览（路径一律取自服务端任务记录）；
 *       入参畸形 400 / 415、队列已满 429、任务未成功 409、产物已不在 410、未接入预览 501；
 *       上传被拒或半途断开后不留临时文件与任务记录；端口被占用的错误路径（不换端口、给出排查命令）；
 *       stop 立即释放端口并使令牌作废；只绑 127.0.0.1；日志不含令牌、文件名与路径；
 *       时序：请求流在 jobs.reserve() 未决期间就已断开（只发了请求头，或发完整个请求体后立即断开）时名额与临时目录当场释放，
 *       而同一窗口内已完整收下的小请求体照常成功；三个 HTTP 超时的取值；
 *       Content-Length 与 Transfer-Encoding 并存、重复且不一致的 Content-Length 均为 400。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');

const { createJobManager } = require('../desktop/main/addin/jobs');
const {
    createAddinServer, DEFAULT_PORT, BIND_HOST, MAX_BODY_BYTES, STATIC_FILES, HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS,
} = require('../desktop/main/addin/server');
const { TOKEN_HEADER, CLIENT_HEADER, CLIENT_HEADER_VALUE } = require('../desktop/main/addin/guard');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'addin-server-'));
const STATIC_DIR = path.join(__dirname, '..', 'office-addin', 'taskpane');
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)]);
const FILE_NAME = '机密案件-某某公司.docx';
const NUL = String.fromCharCode(0);
const cleanups = [];
after(async () => {
    for (const cleanup of cleanups) await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
});

let seq = 0;
const freshDir = (label) => {
    seq += 1;
    const dir = path.join(root, `${label}-${seq}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

function createStubService({ fail = false } = {}) {
    const waiters = [];
    const service = {
        gate: false,
        started: 0,
        release: () => { const next = waiters.shift(); if (next) next(); },
        planTasks: (raws, target) => raws.map((raw) => ({ raw, input: { path: raw }, target })),
        buildOptions: (flat) => flat,
        runConversion: async ({ tasks, outputDir, onEvent }) => {
            service.started += 1;
            onEvent({ type: 'progress', idx: 0, phase: 'parsing', pct: 20 });
            if (service.gate) await new Promise((resolve) => { waiters.push(resolve); });
            if (fail) return { ok: false, results: [], errors: [{ input: tasks[0].raw, error: '文档已损坏' }] };
            const dir = path.join(outputDir, path.basename(tasks[0].input.path, '.docx'));
            fs.mkdirSync(dir, { recursive: true });
            const outputs = { claims: path.join(dir, 'c.xml'), description: path.join(dir, 'd.xml') };
            for (const file of Object.values(outputs)) fs.writeFileSync(file, '<x/>');
            return { ok: true, results: [{ title: '一种装置', outputPath: dir, outputs, warnings: ['分节：示例告警'] }], errors: [] };
        },
    };
    return service;
}

async function startServer(overrides = {}) {
    const service = overrides.service || createStubService(overrides.stub);
    const outputDir = freshDir('out');
    const tmpRoot = path.join(freshDir('tmp'), 'uploads');
    const logs = [];
    const actionCalls = [];
    const realJobs = createJobManager({ service, tmpRoot, getOutputDir: () => outputDir, limits: overrides.limits || {} });
    const jobs = overrides.wrapJobs ? overrides.wrapJobs(realJobs) : realJobs;
    const actions = overrides.actions === undefined
        ? { reveal: async (target) => actionCalls.push(['reveal', target]), preview: async (target) => actionCalls.push(['preview', target]) }
        : overrides.actions;
    const server = createAddinServer({
        staticDir: STATIC_DIR, version: '9.8.7', jobs, actions, port: overrides.port === undefined ? 0 : overrides.port,
        log: (line) => logs.push(line), ...(overrides.maxBodyBytes ? { maxBodyBytes: overrides.maxBodyBytes } : {}),
    });
    cleanups.push(async () => { await server.stop(); await jobs.dispose(); });
    const status = await server.start();
    return { server, jobs, service, status, port: status.port, logs, actionCalls, outputDir, tmpRoot };
}

/** 原始 HTTP 请求：Host 由调用方完全控制（fetch 不允许改 Host）；body 为 Buffer 数组时按分块发送 */
function request(port, { method = 'GET', target = '/', headers = {}, body, host } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, method, path: target, setHost: false, agent: false,
            headers: { Host: host === undefined ? `localhost:${port}` : host, ...headers },
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch (err) { json = null; }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('error', reject);
        if (Array.isArray(body)) {
            for (const chunk of body) req.write(chunk);
            req.end();
        } else {
            req.end(body);
        }
    });
}

async function tokenOf(port) {
    const page = await request(port, { target: '/taskpane.html' });
    return /<meta name="markflow-token" content="([^"]+)">/.exec(page.text)[1];
}

const apiHeaders = (token, extra = {}) => ({ [TOKEN_HEADER]: token, ...extra });
const writeHeaders = (token, extra = {}) => apiHeaders(token, { [CLIENT_HEADER]: CLIENT_HEADER_VALUE, ...extra });
const uploadHeaders = (token, extra = {}) => writeHeaders(token, { 'Content-Type': 'application/octet-stream', ...extra });

async function until(predicate, label) {
    for (let i = 0; i < 400; i += 1) {
        if (await predicate()) return;
        await new Promise((resolve) => { setTimeout(resolve, 5); });
    }
    throw new Error(`等待超时：${label}`);
}

async function uploadAndWait(ctx, token, extraHeaders = {}) {
    const created = await request(ctx.port, { method: 'POST', target: '/v1/jobs', headers: uploadHeaders(token, extraHeaders), body: DOCX });
    assert.equal(created.status, 202, created.text);
    const { id } = created.json.data;
    await until(async () => ['succeeded', 'failed'].includes((await request(ctx.port, { target: `/v1/jobs/${id}`, headers: apiHeaders(token) })).json.data.status), '任务结束');
    return id;
}

const leftovers = (tmpRoot) => (fs.existsSync(tmpRoot) ? fs.readdirSync(tmpRoot) : []);

// ============================================================
// 探活、静态资源与令牌注入
// ============================================================

test('探活 200 且免令牌；响应不含任何 CORS 头，带 no-store / nosniff / CORP', async () => {
    const ctx = await startServer();
    assert.deepEqual(ctx.status, { state: 'listening', port: ctx.port, url: `http://localhost:${ctx.port}/taskpane.html`, message: '', hint: '' });
    for (const host of [`localhost:${ctx.port}`, `127.0.0.1:${ctx.port}`]) {
        const res = await request(ctx.port, { target: '/v1/health', host });
        assert.equal(res.status, 200);
        assert.deepEqual(res.json, { ok: true, data: { version: '9.8.7' } }, '探活只回版本号');
        assert.deepEqual(Object.keys(res.headers).filter((name) => name.startsWith('access-control-')), []);
        assert.equal(res.headers['cache-control'], 'no-store');
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin');
    }
    assert.equal(DEFAULT_PORT, 49731);
    assert.equal(MAX_BODY_BYTES, 200 * 1024 * 1024);
});

test('令牌只注入 taskpane.html：脚本与样式里没有；Word 追加的查询串不影响匹配；重启即换令牌、旧令牌 401', async () => {
    const ctx = await startServer({ maxBodyBytes: 4096 });
    const page = await request(ctx.port, { target: '/taskpane.html?_host_Info=Word$Mac$16.01$zh-CN' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.ok(!page.text.includes('{{'), '占位符全部被替换');
    const token = /<meta name="markflow-token" content="([A-Za-z0-9_-]{43})">/.exec(page.text)[1];
    assert.match(page.text, /<meta name="markflow-version" content="9\.8\.7">/);
    assert.match(page.text, /<meta name="markflow-max-bytes" content="4096">/);

    for (const [target, type] of [['/taskpane.js', /^text\/javascript/], ['/taskpane.css', /^text\/css/]]) {
        const asset = await request(ctx.port, { target });
        assert.equal(asset.status, 200);
        assert.match(asset.headers['content-type'], type);
        assert.ok(!asset.text.includes(token), `${target} 不含令牌：脚本可被跨源 <script> 引入执行，令牌不能放在里面`);
        assert.equal(asset.text, fs.readFileSync(path.join(STATIC_DIR, target.slice(1)), 'utf8'), '脚本与样式原样下发');
    }
    assert.deepEqual(Object.keys(STATIC_FILES), ['/taskpane.html', '/taskpane.js', '/taskpane.css']);

    assert.equal((await request(ctx.port, { target: '/v1/jobs/aaaaaaaaaaaaaaaaaaaaaaaa', headers: apiHeaders(token) })).status, 404, '令牌有效：任务不存在');
    await ctx.server.stop();
    const restarted = await ctx.server.start();
    const nextToken = await tokenOf(restarted.port);
    assert.notEqual(nextToken, token, '每次启动重新生成令牌');
    assert.equal((await request(restarted.port, { target: '/v1/jobs/aaaaaaaaaaaaaaaaaaaaaaaa', headers: apiHeaders(token) })).status, 401, '旧令牌随重启作废');
});

// ============================================================
// 守卫
// ============================================================

test('无令牌 / 错令牌 401：读任务、建任务、显示与预览都要令牌', async () => {
    const ctx = await startServer();
    const token = await tokenOf(ctx.port);
    const id = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const cases = [
        ['GET', `/v1/jobs/${id}`, {}], ['POST', '/v1/jobs', { 'Content-Type': 'application/octet-stream' }],
        ['POST', `/v1/jobs/${id}/reveal`, {}], ['POST', `/v1/jobs/${id}/preview`, {}], ['GET', '/v1/unknown', {}],
    ];
    for (const [method, target, extra] of cases) {
        for (const bad of [undefined, 'wrong', `${token}x`, token.slice(0, -1)]) {
            const headers = { [CLIENT_HEADER]: CLIENT_HEADER_VALUE, ...extra, ...(bad === undefined ? {} : { [TOKEN_HEADER]: bad }) };
            const res = await request(ctx.port, { method, target, headers, body: method === 'POST' ? DOCX : undefined });
            assert.equal(res.status, 401, `${method} ${target} 令牌=${String(bad).slice(0, 6)}`);
            assert.deepEqual(res.json, { ok: false, error: { code: 'unauthorized', message: '令牌缺失或已失效，请关闭后重新打开任务窗格' } });
        }
    }
    assert.deepEqual(leftovers(ctx.tmpRoot), [], '被拒的上传不落盘');
});

test('错 Host 403（防 DNS 重绑定）：探活、静态资源与 API 一视同仁', async () => {
    const ctx = await startServer();
    const token = await tokenOf(ctx.port);
    for (const host of [`evil.example:${ctx.port}`, 'localhost', `localhost:${ctx.port + 1}`, `localhost.evil.example:${ctx.port}`, `[::1]:${ctx.port}`]) {
        for (const [method, target] of [['GET', '/v1/health'], ['GET', '/taskpane.html'], ['GET', '/taskpane.js'], ['POST', '/v1/jobs']]) {
            const res = await request(ctx.port, { method, target, host, headers: uploadHeaders(token), body: method === 'POST' ? DOCX : undefined });
            assert.equal(res.status, 403, `${host} ${target}`);
            assert.equal(res.json.error.code, 'bad-host');
            assert.ok(!res.text.includes(token), '被拒的页面请求不会带出令牌');
        }
    }
});

test('错 Origin 403；本源的 Origin 放行；null 也拒绝', async () => {
    const ctx = await startServer();
    const token = await tokenOf(ctx.port);
    for (const origin of ['https://evil.example', 'null', `https://localhost:${ctx.port}`, `http://localhost:${ctx.port + 1}`]) {
        const res = await request(ctx.port, { method: 'POST', target: '/v1/jobs', headers: uploadHeaders(token, { Origin: origin }), body: DOCX });
        assert.equal(res.status, 403, origin);
        assert.equal(res.json.error.code, 'bad-origin');
        assert.equal((await request(ctx.port, { target: '/v1/health', headers: { Origin: origin } })).status, 403, `GET 也校验 Origin：${origin}`);
    }
    for (const origin of [`http://localhost:${ctx.port}`, `http://127.0.0.1:${ctx.port}`]) {
        const ok = await request(ctx.port, { method: 'POST', target: '/v1/jobs', headers: uploadHeaders(token, { Origin: origin }), body: DOCX });
        assert.equal(ok.status, 202, origin);
    }
});

test('非 GET 缺自定义头 403：带着正确令牌也不行；OPTIONS 预检同样被拒且不回 CORS 头', async () => {
    const ctx = await startServer();
    const token = await tokenOf(ctx.port);
    for (const clientHeader of [undefined, 'something-else']) {
        const headers = apiHeaders(token, { 'Content-Type': 'application/octet-stream', ...(clientHeader ? { [CLIENT_HEADER]: clientHeader } : {}) });
        const res = await request(ctx.port, { method: 'POST', target: '/v1/jobs', headers, body: DOCX });
        assert.equal(res.status, 403);
        assert.equal(res.json.error.code, 'missing-client-header');
    }
    const preflight = await request(ctx.port, {
        method: 'OPTIONS', target: '/v1/jobs',
        headers: { Origin: `http://localhost:${ctx.port}`, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-markflow-token,x-markflow-client' },
    });
    assert.equal(preflight.status, 403);
    assert.deepEqual(Object.keys(preflight.headers).filter((name) => name.startsWith('access-control-')), [], '预检拿不到任何放行头，跨源写操作无从成立');
    assert.deepEqual(leftovers(ctx.tmpRoot), []);
});

test('路径穿越与未知路径一律 404；静态资源只认白名单上的三个精确路径', async () => {
    const ctx = await startServer();
    const token = await tokenOf(ctx.port);
    const targets = [
        '/', '/index.html', '/taskpane.html/', '/taskpane.html/../../package.json', '/../package.json', '/../../../../etc/passwd',
        '/%2e%2e/%2e%2e/package.json', '/..%2f..%2fpackage.json', '/taskpane/../manifest.xml', '/manifest.xml', '//etc/passwd',
        '/taskpane.html%00.js', '/TASKPANE.HTML', '/taskpane.js.map', '/.git/config', '/office-addin/taskpane/taskpane.html',
    ];
    for (const target of targets) {
        const res = await request(ctx.port, { target });
        assert.equal(res.status, 404, target);
        assert.deepEqual(res.json, { ok: false, error: { code: 'not-found', message: '无此资源' } });
        assert.ok(!res.text.includes(token));
    }
    for (const [method, target] of [['PUT', '/taskpane.html'], ['DELETE', '/v1/jobs/aaaaaaaaaaaaaaaaaaaaaaaa'], ['POST', '/v1/health'], ['GET', '/v1/jobs'], ['GET', '/v1/jobs/../../etc'], ['GET', '/v1/jobs/NOT-HEX']]) {
        const res = await request(ctx.port, { method, target, headers: writeHeaders(token) });
        assert.equal(res.status, 404, `${method} ${target}`);
    }
});

// ============================================================
// 上传限制与入参校验
// ============================================================

test('超限 413：Content-Length 声明超限当场拒绝，分块上传实际超限中途拒绝；都不留临时文件与任务记录', async () => {
    const ctx = await startServer({ maxBodyBytes: 1024 });
    const token = await tokenOf(ctx.port);
    const big = Buffer.concat([DOCX, Buffer.alloc(2048, 1)]);
    const declared = await request(ctx.port, { method: 'POST', target: '/v1/jobs', headers: uploadHeaders(token, { 'Content-Length': String(big.length) }), body: big });
    assert.equal(declared.status, 413);
    assert.equal(declared.json.error.code, 'payload-too-large');
    assert.equal(declared.headers.connection, 'close');

    const chunked = await request(ctx.port, { method: 'POST', target: '/v1/jobs', headers: uploadHeaders(token), body: [DOCX, Buffer.alloc(600, 1), Buffer.alloc(600, 2)] });
    assert.equal(chunked.status, 413);
    assert.equal(chunked.json.error.code, 'payload-too-large');
    assert.deepEqual(ctx.jobs.stats(), { pending: 0, running: 0, records: 0 });
    assert.deepEqual(leftovers(ctx.tmpRoot), []);

    const exact = await request(ctx.port, { method: 'POST', target: '/v1/jobs', headers: uploadHeaders(token), body: Buffer.concat([DOCX, Buffer.alloc(1024 - DOCX.length, 1)]) });
    assert.equal(exact.status, 202, '恰好等于上限的文档照常受理');
    await until(() => leftovers(ctx.tmpRoot).length === 0, '临时目录清空');
    assert.deepEqual(ctx.jobs.stats(), { pending: 0, running: 0, records: 1 });
});

test('入参畸形：类型不符 415、空请求体 400、不是 zip 400、请求头畸形 400；均不留痕', async () => {
    const ctx = await startServer();
    const token = await tokenOf(ctx.port);
    const post = (headers, body) => request(ctx.port, { method: 'POST', target: '/v1/jobs', headers: writeHeaders(token, headers), body });
    const cases = [
        [await post({ 'Content-Type': 'multipart/form-data; boundary=x' }, DOCX), 415, 'unsupported-media-type'],
        [await post({}, DOCX), 415, 'unsupported-media-type'],
        [await post({ 'Content-Type': 'application/octet-stream' }, Buffer.alloc(0)), 400, 'empty-body'],
        [await post({ 'Content-Type': 'application/octet-stream' }, Buffer.from('<html>不是 docx</html>')), 400, 'invalid-docx'],
        [await post({ 'Content-Type': 'application/octet-stream' }, Buffer.from('PK')), 400, 'invalid-docx'],
        [await post({ 'Content-Type': 'application/octet-stream', 'X-MarkFlow-File-Name': '%E0%A4%A' }, DOCX), 400, 'bad-header'],
        [await post({ 'Content-Type': 'application/octet-stream', 'X-MarkFlow-Source-Path': encodeURIComponent(`/a${NUL}b.docx`) }, DOCX), 400, 'bad-header'],
        [await post({ 'Content-Type': 'application/octet-stream', 'X-MarkFlow-File-Name': encodeURIComponent('长'.repeat(1025)) }, DOCX), 400, 'bad-header'],
    ];
    for (const [res, status, code] of cases) {
        assert.equal(res.status, status, code);
        assert.equal(res.json.ok, false);
        assert.equal(res.json.error.code, code);
    }
    assert.deepEqual(leftovers(ctx.tmpRoot), []);
    assert.deepEqual(ctx.jobs.stats(), { pending: 0, running: 0, records: 0 });
});

test('上传半途断开：临时文件被清理、不留任务记录，服务照常可用', async () => {
    const ctx = await startServer();
    const token = await tokenOf(ctx.port);
    await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: ctx.port, method: 'POST', path: '/v1/jobs', agent: false, headers: { ...uploadHeaders(token), 'Content-Length': '100000' } });
        req.on('error', () => resolve());
        req.write(DOCX);
        setTimeout(() => { req.destroy(); resolve(); }, 50);
    });
    await until(() => leftovers(ctx.tmpRoot).length === 0 && ctx.jobs.stats().records === 0, '断开后的清理');
    assert.equal((await request(ctx.port, { target: '/v1/health' })).status, 200);
});

// ---------- 时序：请求流在 jobs.reserve() 未决期间就已断开 ----------

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 把 reserve 的异步窗口拉长到由测试掌控：真实的 reserve 先完成（名额已占、临时目录已建），再停在闸门上，
 * 由测试在「客户端已断开」之后放行。真实环境里这个窗口由 purgeOnce、stat、access、mkdir 等磁盘 I/O 构成。
 */
function gatedReserve() {
    const waiters = [];
    const state = { held: 0 };
    return {
        state,
        release: () => { for (const resolve of waiters.splice(0)) resolve(); },
        wrap: (real) => ({
            ...real,
            reserve: async (meta) => {
                const reserved = await real.reserve(meta);
                state.held += 1;
                await new Promise((resolve) => { waiters.push(resolve); });
                return reserved;
            },
        }),
    };
}

/** 直接往 TCP 连接里写请求文本，写完（可选）立即销毁连接 */
function rawSend(port, text, { destroyAfterWrite = true } = {}) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port }, () => {
            socket.write(text, 'latin1', () => { if (destroyAfterWrite) { socket.destroy(); resolve(''); } });
        });
        const chunks = [];
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.on('close', () => resolve(Buffer.concat(chunks).toString('latin1')));
        socket.on('error', () => resolve(''));
    });
}

const uploadHead = (port, token, lines) => `POST /v1/jobs HTTP/1.1\r\nHost: localhost:${port}\r\n${TOKEN_HEADER}: ${token}\r\n${CLIENT_HEADER}: ${CLIENT_HEADER_VALUE}\r\nContent-Type: application/octet-stream\r\nX-MarkFlow-File-Name: ${encodeURIComponent(FILE_NAME)}\r\n${lines.join('\r\n')}\r\n\r\n`;

test('reserve() 未决期间请求即断开（只发了请求头）：任务不停留在 uploading，名额与临时目录当场释放，随后的正常上传仍得 202', async () => {
    const gate = gatedReserve();
    const ctx = await startServer({ wrapJobs: gate.wrap });
    const token = await tokenOf(ctx.port);
    // 连断 6 次（排队上限是 5）：只要有一次泄漏名额，后面的正常上传就会是 429
    for (let round = 1; round <= 6; round += 1) {
        await rawSend(ctx.port, uploadHead(ctx.port, token, ['Content-Length: 1000000']));
        await until(() => gate.state.held === round, `第 ${round} 次请求进入 reserve 的窗口`);
        await sleep(40);
        gate.release();
        await until(() => ctx.jobs.stats().pending === 0 && leftovers(ctx.tmpRoot).length === 0, `第 ${round} 次断开后名额与临时目录释放`);
    }
    assert.deepEqual(ctx.jobs.stats(), { pending: 0, running: 0, records: 0 }, '没有任何任务停留在 uploading');
    assert.ok(ctx.logs.filter((line) => line === '[addin] POST → 400 upload-aborted').length === 6, '每次断开都按 upload-aborted 记了一条');

    const ok = request(ctx.port, { method: 'POST', target: '/v1/jobs', headers: uploadHeaders(token), body: DOCX });
    await until(() => gate.state.held === 7, '正常上传进入 reserve 的窗口');
    gate.release();
    const res = await ok;
    assert.equal(res.status, 202, res.text);
    await until(() => ctx.jobs.stats().running === 0 && leftovers(ctx.tmpRoot).length === 0, '正常任务跑完');
});

test('reserve() 未决期间发完整个请求体后立即断开：流已销毁、缓冲里的数据再也读不到，同样当场释放而不是挂起', async () => {
    const gate = gatedReserve();
    const ctx = await startServer({ wrapJobs: gate.wrap });
    const token = await tokenOf(ctx.port);
    await rawSend(ctx.port, `${uploadHead(ctx.port, token, [`Content-Length: ${DOCX.length}`])}${DOCX.toString('latin1')}`);
    await until(() => gate.state.held === 1, '请求进入 reserve 的窗口');
    await sleep(40);
    gate.release();
    await until(() => ctx.jobs.stats().pending === 0 && leftovers(ctx.tmpRoot).length === 0, '名额与临时目录释放');
    assert.deepEqual(ctx.jobs.stats(), { pending: 0, running: 0, records: 0 }, '客户端已经不在了：不转换、不留记录');
    assert.equal(ctx.service.started, 0);
});

test('小请求体在 reserve() 的窗口内已完整收下、客户端仍在等响应：数据还在流的缓冲里，照常读完并成功', async () => {
    const gate = gatedReserve();
    const service = createStubService();
    const received = [];
    const runConversion = service.runConversion;
    service.runConversion = async (args) => { received.push(fs.readFileSync(args.tasks[0].input.path)); return runConversion(args); };
    const ctx = await startServer({ service, wrapJobs: gate.wrap });
    const token = await tokenOf(ctx.port);
    const pending = request(ctx.port, { method: 'POST', target: '/v1/jobs', headers: uploadHeaders(token), body: DOCX });
    await until(() => gate.state.held === 1, '请求进入 reserve 的窗口');
    await sleep(60);
    gate.release();
    const res = await pending;
    assert.equal(res.status, 202, res.text);
    await until(() => received.length === 1, '转换开始');
    assert.ok(received[0].equals(DOCX), '窗口内到达的请求体一个字节不少');
    await until(() => ctx.jobs.stats().running === 0, '任务结束');
});

test('上传途中（监听已挂好）客户端在发完之前断开：未见 end 即 close，一律按中断处理', async () => {
    const ctx = await startServer();
    const token = await tokenOf(ctx.port);
    await new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port: ctx.port }, () => {
            socket.write(`${uploadHead(ctx.port, token, ['Content-Length: 500000'])}${DOCX.toString('latin1')}`, 'latin1');
            setTimeout(() => { socket.destroy(); resolve(); }, 80);
        });
        socket.on('error', () => resolve());
    });
    await until(() => ctx.jobs.stats().pending === 0 && leftovers(ctx.tmpRoot).length === 0, '断开后的清理');
    assert.deepEqual(ctx.jobs.stats(), { pending: 0, running: 0, records: 0 });
});

// ---------- HTTP 超时与畸形的长度声明 ----------

test('三个 HTTP 超时显式设置：请求头 15 秒、整个请求 5 分钟（容得下 200 MB 回环上传）、空闲保持连接 5 秒', async () => {
    assert.deepEqual([HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS], [15000, 300000, 5000]);
    const ctx = await startServer();
    assert.deepEqual(ctx.server.timeouts(), { headersTimeout: 15000, requestTimeout: 300000, keepAliveTimeout: 5000 }, '取自正在监听的 http.Server 实例，而非常量本身');
    await ctx.server.stop();
    assert.equal(ctx.server.timeouts(), null, '未监听时没有实例可言');
});

test('Content-Length 与 Transfer-Encoding 并存、重复且不一致的 Content-Length：一律 400，不占名额、不落盘（防请求走私）', async () => {
    const ctx = await startServer();
    const token = await tokenOf(ctx.port);
    const body = DOCX.toString('latin1');
    const chunked = `${DOCX.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`;
    const cases = [
        ['CL 与 TE 并存', uploadHead(ctx.port, token, [`Content-Length: ${DOCX.length}`, 'Transfer-Encoding: chunked']) + chunked],
        ['TE 在前、CL 在后', uploadHead(ctx.port, token, ['Transfer-Encoding: chunked', `Content-Length: ${DOCX.length}`]) + chunked],
        ['两个不一致的 CL', uploadHead(ctx.port, token, [`Content-Length: ${DOCX.length}`, 'Content-Length: 4']) + body],
        ['CL 为逗号列表', uploadHead(ctx.port, token, [`Content-Length: ${DOCX.length}, 4`]) + body],
    ];
    for (const [label, text] of cases) {
        const reply = await rawSend(ctx.port, text, { destroyAfterWrite: false });
        assert.match(reply, /^HTTP\/1\.1 400 /, `${label}：${reply.split('\r\n')[0]}`);
    }
    await sleep(50);
    assert.deepEqual(ctx.jobs.stats(), { pending: 0, running: 0, records: 0 });
    assert.deepEqual(leftovers(ctx.tmpRoot), []);
    assert.equal((await request(ctx.port, { target: '/v1/health' })).status, 200, '服务照常可用');
});

test('/v1/health 的响应不含任何 Access-Control-* 头：带同源 Origin、带跨站 Origin（被拒）与 OPTIONS 预检都一样', async () => {
    const ctx = await startServer();
    const corsHeaders = (res) => Object.keys(res.headers).filter((name) => name.toLowerCase().startsWith('access-control-'));
    const sameOrigin = await request(ctx.port, { target: '/v1/health', headers: { Origin: `http://localhost:${ctx.port}` } });
    assert.deepEqual([sameOrigin.status, corsHeaders(sameOrigin)], [200, []]);
    const crossSite = await request(ctx.port, { target: '/v1/health', headers: { Origin: 'https://evil.example' } });
    assert.deepEqual([crossSite.status, corsHeaders(crossSite)], [403, []], '被拒的跨站请求同样拿不到任何 CORS 头');
    const preflight = await request(ctx.port, { method: 'OPTIONS', target: '/v1/health', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
    assert.deepEqual([preflight.status, corsHeaders(preflight)], [403, []]);
    assert.equal(sameOrigin.headers.vary, undefined, '也不发 Vary: Origin——响应从不随 Origin 变化');
});

test('排队名额已满 429', async () => {
    const service = createStubService();
    service.gate = true;
    const ctx = await startServer({ service, limits: { maxPending: 1 } });
    const token = await tokenOf(ctx.port);
    const post = () => request(ctx.port, { method: 'POST', target: '/v1/jobs', headers: uploadHeaders(token), body: DOCX });
    assert.equal((await post()).status, 202);
    await until(() => service.started === 1, '第一个任务开始运行');
    const second = await post();
    assert.equal(second.status, 202);
    assert.equal(second.json.data.position, 1);
    const third = await post();
    assert.equal(third.status, 429);
    assert.equal(third.json.error.code, 'queue-full');
    service.gate = false;
    service.release();
    await until(() => ctx.jobs.stats().pending === 0 && ctx.jobs.stats().running === 0, '队列排空');
});

// ============================================================
// 任务主流程与产物动作
// ============================================================

test('上传 → 轮询 → 成功 → 在访达中显示 / 预览：路径取自服务端任务记录；日志不含令牌、文件名与路径', async () => {
    const ctx = await startServer();
    const token = await tokenOf(ctx.port);
    const sourcePath = '/Users/someone/机密目录/不存在的文件.docx';
    const id = await uploadAndWait(ctx, token, { 'X-MarkFlow-File-Name': encodeURIComponent(FILE_NAME), 'X-MarkFlow-Source-Path': encodeURIComponent(sourcePath) });

    const job = (await request(ctx.port, { target: `/v1/jobs/${id}`, headers: apiHeaders(token) })).json.data;
    assert.equal(job.status, 'succeeded');
    assert.equal(job.name, '机密案件-某某公司', '源路径不可用时按客户端给的文件名起名');
    assert.equal(job.result.title, '一种装置');
    assert.equal(job.result.outputPath, path.join(ctx.outputDir, '机密案件-某某公司'), '非法源路径一律落到输出目录');
    assert.deepEqual(job.location, { basis: 'output-dir', note: '文档路径不可用（该路径上没有这个文件），产物已存入 MarkFlow 的输出目录' });
    assert.deepEqual(job.result.parts, ['description', 'claims']);

    const reveal = await request(ctx.port, { method: 'POST', target: `/v1/jobs/${id}/reveal`, headers: writeHeaders(token) });
    assert.deepEqual([reveal.status, reveal.json], [200, { ok: true, data: { revealed: true } }]);
    const preview = await request(ctx.port, { method: 'POST', target: `/v1/jobs/${id}/preview`, headers: writeHeaders(token) });
    assert.deepEqual([preview.status, preview.json], [200, { ok: true, data: { opened: true, part: 'description' } }]);
    const claims = await request(ctx.port, { method: 'POST', target: `/v1/jobs/${id}/preview`, headers: writeHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ part: 'claims' }) });
    assert.equal(claims.json.data.part, 'claims');
    assert.deepEqual(ctx.actionCalls, [['reveal', job.result.outputPath], ['preview', job.result.outputs.description], ['preview', job.result.outputs.claims]]);

    for (const body of [{ part: '/etc/passwd' }, { part: 'zip' }, { part: 'abstract' }, { part: 42 }, { part: '../claims' }]) {
        const res = await request(ctx.port, { method: 'POST', target: `/v1/jobs/${id}/preview`, headers: writeHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.json.error.code, 'bad-part');
    }
    const notJson = await request(ctx.port, { method: 'POST', target: `/v1/jobs/${id}/preview`, headers: writeHeaders(token, { 'Content-Type': 'application/json' }), body: '[1,2' });
    assert.equal(notJson.status, 400);
    const wrongType = await request(ctx.port, { method: 'POST', target: `/v1/jobs/${id}/preview`, headers: writeHeaders(token, { 'Content-Type': 'text/plain' }), body: '{"part":"claims"}' });
    assert.equal(wrongType.status, 415);
    const tooBig = await request(ctx.port, { method: 'POST', target: `/v1/jobs/${id}/preview`, headers: writeHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ part: 'x'.repeat(5000) }) });
    assert.equal(tooBig.status, 413);
    assert.equal(ctx.actionCalls.length, 3, '被拒的请求没有触发任何动作');

    fs.rmSync(job.result.outputPath, { recursive: true, force: true });
    const gone = await request(ctx.port, { method: 'POST', target: `/v1/jobs/${id}/reveal`, headers: writeHeaders(token) });
    assert.deepEqual([gone.status, gone.json.error.code], [410, 'output-missing']);

    const logText = ctx.logs.join(' | ');
    assert.ok(logText.includes('/v1/jobs/:id'), '日志记路由模式而非具体地址');
    for (const secret of [token, FILE_NAME, '机密', sourcePath, ctx.outputDir]) assert.ok(!logText.includes(secret), `日志不应包含：${secret.slice(0, 12)}`);
});

test('任务不存在 404、任务失败 409、未接入预览 501', async () => {
    const ctx = await startServer({ stub: { fail: true }, actions: { reveal: async () => undefined } });
    const token = await tokenOf(ctx.port);
    const missing = await request(ctx.port, { method: 'POST', target: '/v1/jobs/bbbbbbbbbbbbbbbbbbbbbbbb/reveal', headers: writeHeaders(token) });
    assert.deepEqual([missing.status, missing.json.error.code], [404, 'job-not-found']);

    const id = await uploadAndWait(ctx, token);
    const job = (await request(ctx.port, { target: `/v1/jobs/${id}`, headers: apiHeaders(token) })).json.data;
    assert.deepEqual([job.status, job.error.message, job.result], ['failed', '文档已损坏', null]);
    for (const action of ['reveal', 'preview']) {
        const res = await request(ctx.port, { method: 'POST', target: `/v1/jobs/${id}/${action}`, headers: writeHeaders(token) });
        assert.deepEqual([res.status, res.json.error.code], [409, 'job-not-succeeded'], action);
    }

    const okCtx = await startServer({ actions: { reveal: async () => undefined } });
    const okToken = await tokenOf(okCtx.port);
    const okId = await uploadAndWait(okCtx, okToken);
    const preview = await request(okCtx.port, { method: 'POST', target: `/v1/jobs/${okId}/preview`, headers: writeHeaders(okToken) });
    assert.deepEqual([preview.status, preview.json.error.code], [501, 'preview-unavailable']);
});

test('动作回调抛出的异常回 500，文案不外泄内部细节', async () => {
    const ctx = await startServer({ actions: { reveal: async () => { throw new Error('内部路径 /secret/path 出错'); }, preview: async () => undefined } });
    const token = await tokenOf(ctx.port);
    const id = await uploadAndWait(ctx, token);
    const res = await request(ctx.port, { method: 'POST', target: `/v1/jobs/${id}/reveal`, headers: writeHeaders(token) });
    assert.equal(res.status, 500);
    assert.deepEqual(res.json, { ok: false, error: { code: 'internal', message: '内部错误，详见 MarkFlow 的日志' } });
    const line = ctx.logs.find((item) => item.includes('internal'));
    assert.equal(line, '[addin] POST → 500 internal：内部路径 <path> 出错', '内部错误进日志时本机绝对路径先脱敏');
});

test('因 Host / Origin 被拒时日志记下收到的值（截断），因令牌被拒时不记任何头值', async () => {
    const ctx = await startServer();
    const token = await tokenOf(ctx.port);
    await request(ctx.port, { target: '/v1/health', host: `evil.example:${ctx.port}` });
    await request(ctx.port, { target: '/v1/health', headers: { Origin: `https://${'x'.repeat(200)}.example` } });
    await request(ctx.port, { target: '/v1/jobs/aaaaaaaaaaaaaaaaaaaaaaaa', headers: apiHeaders(`${token}-wrong`) });
    assert.ok(ctx.logs.includes(`[addin] GET /v1/health → 403 bad-host（host=evil.example:${ctx.port}）`));
    assert.ok(ctx.logs.includes(`[addin] GET /v1/health → 403 bad-origin（origin=${`https://${'x'.repeat(200)}`.slice(0, 80)}）`));
    assert.ok(ctx.logs.includes('[addin] GET /v1/jobs/:id → 401 unauthorized'));
    assert.ok(ctx.logs.every((line) => !line.includes(token)));
});

test('已知错误（413 / 400 / 415 等）在日志里留下方法、状态码与错误代码，便于排障', async () => {
    const ctx = await startServer({ maxBodyBytes: 32 });
    const token = await tokenOf(ctx.port);
    await request(ctx.port, { method: 'POST', target: '/v1/jobs', headers: uploadHeaders(token), body: Buffer.concat([DOCX, DOCX]) });
    await request(ctx.port, { method: 'POST', target: '/v1/jobs', headers: writeHeaders(token, { 'Content-Type': 'text/plain' }), body: 'x' });
    assert.ok(ctx.logs.includes('[addin] POST → 413 payload-too-large'));
    assert.ok(ctx.logs.includes('[addin] POST → 415 unsupported-media-type'));
});

// ============================================================
// 监听：端口占用、停止与绑定地址
// ============================================================

test('端口被占用：不抛出、不换端口，状态给出明确原因与排查命令；端口腾出后可再次启动', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => { blocker.listen(0, '127.0.0.1', resolve); });
    const busyPort = blocker.address().port;
    const ctx = await startServer({ port: busyPort });
    assert.equal(ctx.status.state, 'port-in-use');
    assert.equal(ctx.status.port, busyPort, '仍报告原端口：清单里写死了端口，不会自动漂移');
    assert.equal(ctx.status.url, null);
    assert.match(ctx.status.message, new RegExp(`端口 ${busyPort} 已被其他程序占用`));
    assert.match(ctx.status.hint, new RegExp(`lsof -nP -iTCP:${busyPort} -sTCP:LISTEN`));
    assert.deepEqual(ctx.server.status(), ctx.status, '失败原因保留到下次启停');

    await new Promise((resolve) => { blocker.close(resolve); });
    const retried = await ctx.server.start();
    assert.deepEqual([retried.state, retried.port, retried.message], ['listening', busyPort, '']);
    assert.equal((await request(busyPort, { target: '/v1/health' })).status, 200);
});

test('stop 立即释放端口（保持中的连接一并断开）；重复 start / stop 幂等', async () => {
    const ctx = await startServer();
    const { port } = ctx;
    const agent = new http.Agent({ keepAlive: true });
    await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/v1/health', agent, headers: { Host: `localhost:${port}` } }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
    });
    assert.deepEqual(await ctx.server.start(), ctx.status, '已在监听时 start 不重复绑定');
    const stopped = await ctx.server.stop();
    agent.destroy();
    assert.deepEqual([stopped.state, stopped.url], ['stopped', null]);
    assert.deepEqual((await ctx.server.stop()).state, 'stopped');
    await assert.rejects(request(port, { target: '/v1/health' }), /ECONNREFUSED/);
    const probe = net.createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
    await new Promise((resolve) => { probe.close(resolve); });
});

test('只绑 127.0.0.1：经本机的局域网地址连不上', async (t) => {
    assert.equal(BIND_HOST, '127.0.0.1');
    const lan = Object.values(os.networkInterfaces()).flat().find((item) => item && item.family === 'IPv4' && !item.internal);
    if (!lan) {
        t.skip('本机没有非回环的 IPv4 地址');
        return;
    }
    const ctx = await startServer();
    await assert.rejects(new Promise((resolve, reject) => {
        const socket = net.connect({ host: lan.address, port: ctx.port, timeout: 1500 }, () => { socket.destroy(); resolve(); });
        socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
        socket.on('error', reject);
    }));
});

test('入参校验：staticDir 须为绝对路径、jobs 必填', () => {
    assert.throws(() => createAddinServer({ staticDir: 'relative', jobs: { reserve() {} } }), /绝对路径/);
    assert.throws(() => createAddinServer({ staticDir: STATIC_DIR }), /缺少 jobs/);
});
