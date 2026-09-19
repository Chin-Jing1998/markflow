/**
 * Word 加载项回环服务（纯 Node http，可脱离 Electron 单测；任务编排、外部动作与静态目录均经参数注入）
 *
 * 威胁模型：防的是浏览器里的网页（CSRF、DNS 重绑定、跨源读取）与误用；以当前用户身份运行的本机恶意进程
 * 不在防护范围内（详见 guard.js 文件头）。因此：只绑 127.0.0.1；不发任何 CORS 头；Host 与 Origin 严格校验；
 * 写操作要求自定义头；除探活外的 API 一律校验内存令牌；令牌只随 taskpane.html 同源下发，
 * 不放进任何脚本文件（脚本可被跨源 <script> 引入执行，HTML 不能被跨源读取）。
 *
 * createAddinServer({ staticDir, version, jobs, actions?, port?, host?, maxBodyBytes?, log? }) → server
 *   staticDir     任务窗格静态资源目录（office-addin/taskpane），只按 STATIC_FILES 白名单精确匹配路径，
 *                 客户端路径从不参与拼接，路径穿越无从发生（未命中一律 404）
 *   jobs          jobs.js 的任务管理器
 *   actions       { reveal(outputPath), preview(filePath) }；preview 缺席时该端点回 501
 *   port          缺省 49731（写死在 Word 清单里）；0 为临时端口，仅供测试。端口被占用时不自动换端口
 *   start() → 状态   每次启动重新生成令牌；失败不抛出，原因在状态里
 *   stop()  → 状态   立即停止监听并断开全部连接，令牌随即作废
 *   status() → { state: 'stopped'|'listening'|'port-in-use'|'error', port, url, message, hint }
 *   timeouts() → { headersTimeout, requestTimeout, keepAliveTimeout } | null   正在监听的实例上实际生效的三个超时（毫秒）
 *
 * 上传的时序约束：请求流的 close / error 只发一次，错过就再也等不到。jobs.reserve() 含真实的磁盘 I/O，
 * 任务窗格恰在这个窗口内被关掉时，流已销毁、此后挂的监听收不到任何事件。因此 createJob 在第一个 await 之前就挂上
 * 「已中断」哨兵（watchRequest），receiveUpload 动手之前先看哨兵与 req.destroyed，已断开的当场按 upload-aborted 拒绝，
 * 名额、临时目录与写流随即释放；判据与 req.complete 无关——请求体已收完但流已销毁时，缓冲里的数据同样读不出来。
 *
 * 端点（响应统一为 { ok: true, data } | { ok: false, error: { code, message } }，一律 no-store）：
 *   GET  /taskpane.html|.js|.css      静态资源；html 内的 {{MARKFLOW_TOKEN}} 等占位符在此注入
 *   GET  /v1/health                   免令牌，data 只有 { version }
 *   POST /v1/jobs                     请求体为 docx 字节流（application/octet-stream）；
 *                                     X-MarkFlow-File-Name 与 X-MarkFlow-Source-Path 为百分号编码的 UTF-8；回 202 与任务快照
 *   GET  /v1/jobs/:id                 任务快照（状态、进度、结果）
 *   POST /v1/jobs/:id/reveal          在访达中显示产物
 *   POST /v1/jobs/:id/preview         在 MarkFlow 中打开五书之一（可选 JSON 体 { part }，缺省取第一份）
 * 状态码：400 入参畸形 / 401 令牌 / 403 Host、Origin、自定义头 / 404 无此资源 / 409 任务未成功 / 410 产物已不在
 *        / 413 超限 / 415 类型不符 / 429 队列已满 / 501 未接入预览 / 503 已停止。
 * 日志只记方法、路由模式、状态码与错误代码，不记查询串、文件名与任何正文；请求头只在因 Host / Origin 被拒时
 * 记下这一个头的值（截断到 80 字符，供排障：它们不含敏感信息），令牌头从不进日志；
 * 未预料的内部错误另记首行错误文本，其中的本机绝对路径先脱敏为 <path>（converters/tmp.js 的 excerpt）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const { errText } = require('../../../converters/util');
const { excerpt } = require('../../../converters/tmp');
const { createToken, checkRequest, decodeHeaderValue, GuardError } = require('./guard');
const { JobError } = require('./jobs');

const fsp = fs.promises;
const noop = () => undefined;
const DEFAULT_PORT = 49731;
const BIND_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 200 * 1024 * 1024;
const MAX_JSON_BYTES = 4096;
const MAX_HEADER_BYTES = 32 * 1024;
/** 同时存在的连接数上限：任务窗格至多开几条连接，这里只为给误用兜底 */
const MAX_CONNECTIONS = 32;
/**
 * 三个超时显式写出，不依赖 Node 各版本的缺省值（到点由 Node 断开连接，上传中的请求随之收到 close 并释放名额）：
 * 请求头须在 15 秒内收齐——任务窗格的请求头很小，慢速发头的连接到点即断；
 * 整个请求（含请求体）5 分钟——200 MB 的文档经本机回环上传只需数秒，5 分钟留足余量，卡住不动的上传不会无限期占着名额；
 * 空闲的保持连接 5 秒后回收。
 */
const HEADERS_TIMEOUT_MS = 15 * 1000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const KEEP_ALIVE_TIMEOUT_MS = 5 * 1000;
const MAX_NAME_LENGTH = 1024;
const MAX_PATH_LENGTH = 4096;
const DENIED_VALUE_LIMIT = 80;
const UPLOAD_FILE_MODE = 0o600;
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const FILE_NAME_HEADER = 'x-markflow-file-name';
const SOURCE_PATH_HEADER = 'x-markflow-source-path';
const OCTET_STREAM = 'application/octet-stream';
const JSON_TYPE = 'application/json';
const STATE = Object.freeze({ STOPPED: 'stopped', LISTENING: 'listening', PORT_IN_USE: 'port-in-use', ERROR: 'error' });
const STATIC_FILES = Object.freeze({
    '/taskpane.html': Object.freeze({ file: 'taskpane.html', type: 'text/html; charset=utf-8', inject: true }),
    '/taskpane.js': Object.freeze({ file: 'taskpane.js', type: 'text/javascript; charset=utf-8', inject: false }),
    '/taskpane.css': Object.freeze({ file: 'taskpane.css', type: 'text/css; charset=utf-8', inject: false }),
});
const JOB_ROUTE_RE = /^\/v1\/jobs\/([a-f0-9]{24})(?:\/(reveal|preview))?$/;
const VERSION_SAFE_RE = /^[0-9A-Za-z.+-]{1,64}$/;
/** 每个响应都带；不含任何 Access-Control-* 头。CORP 拦住跨源页面以 no-cors 方式引入本服务的资源 */
const BASE_HEADERS = Object.freeze({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
});

class HttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.code = code;
    }
}

// ============================================================
// 请求与响应工具
// ============================================================

/** 只取路径部分；不做解码与规范化，白名单按原样精确匹配（Word 会在地址后追加 ?_host_Info=…） */
const pathnameOf = (url) => String(url || '/').split('?')[0];

function send(res, status, body, headers) {
    res.writeHead(status, { ...BASE_HEADERS, 'Content-Length': body.length, ...headers });
    res.end(body);
}

function sendJson(res, status, payload, extraHeaders = {}) {
    send(res, status, Buffer.from(JSON.stringify(payload), 'utf8'), { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
}

const sendData = (res, status, data) => sendJson(res, status, { ok: true, data });
/** 出错即关连接：请求体可能还没读完，不值得为一个被拒的请求把余下的字节收完 */
const sendError = (res, status, code, message) => sendJson(res, status, { ok: false, error: { code, message } }, { Connection: 'close' });

function declaredLength(req) {
    const raw = req.headers['content-length'];
    if (raw === undefined) return null;
    if (!/^\d{1,15}$/.test(String(raw))) throw new HttpError(400, 'bad-request', 'Content-Length 不合法');
    return Number(raw);
}

const uploadAborted = () => new HttpError(400, 'upload-aborted', '上传中断');

/**
 * 「已中断」哨兵：必须在处理器的第一个 await 之前调用。流的 close / error 各只发一次，
 * 等 await 回来再挂监听就可能已经错过；哨兵把「错过的事件」记成一个可以事后查询的标记。
 */
function watchRequest(req) {
    const watch = { interrupted: false };
    const mark = () => { watch.interrupted = true; };
    req.once('error', mark);
    req.once('close', mark);
    return watch;
}

/**
 * 把请求体写入 filePath（wx + 0600），边收边计数；超过 limit 即中止并抛 413。回 { bytes, head }。
 * 每条路径都会落定：见到 end → 写流 finish → resolve；未见 end 就 close、流报错、写盘出错、超限 → reject。
 * 动手之前流已断开（watch.interrupted 或 req.destroyed）的当场 reject，且不创建文件；
 * 请求体虽已在 await 期间完整到达、但客户端仍在等响应的，数据还在流的缓冲里，挂上 data 监听即照常读完。
 */
function receiveUpload(req, filePath, limit, watch) {
    return new Promise((resolve, reject) => {
        if (watch.interrupted || req.destroyed) {
            reject(uploadAborted());
            return;
        }
        const out = fs.createWriteStream(filePath, { flags: 'wx', mode: UPLOAD_FILE_MODE });
        const meter = { bytes: 0, head: Buffer.alloc(0) };
        const progress = { settled: false, ended: false };
        const fail = (err) => {
            if (progress.settled) return;
            progress.settled = true;
            req.pause();
            req.removeAllListeners('data');
            out.destroy();
            reject(err);
        };
        req.on('data', (chunk) => {
            meter.bytes += chunk.length;
            if (meter.head.length < ZIP_MAGIC.length) meter.head = Buffer.concat([meter.head, chunk]).subarray(0, ZIP_MAGIC.length);
            if (meter.bytes > limit) {
                fail(new HttpError(413, 'payload-too-large', `文档超过大小上限（${Math.floor(limit / 1024 / 1024)} MB）`));
                return;
            }
            if (!out.write(chunk)) {
                req.pause();
                out.once('drain', () => req.resume());
            }
        });
        req.once('end', () => {
            progress.ended = true;
            out.end();
        });
        req.once('error', () => fail(uploadAborted()));
        // 未见 end 就 close：数据没读完流就没了（不看 req.complete——已收完但被销毁的流同样读不出缓冲里的数据）
        req.once('close', () => { if (!progress.ended) fail(uploadAborted()); });
        out.on('error', (err) => fail(new HttpError(500, 'write-failed', `无法写入临时文件：${errText(err)}`)));
        out.once('finish', () => {
            if (progress.settled) return;
            progress.settled = true;
            resolve(meter);
        });
    });
}

/** 读一个很小的 JSON 体（预览端点的 { part }）；没有请求体回 {}。必须带 Content-Length，长度因此事先可知 */
async function readSmallJson(req) {
    const length = declaredLength(req);
    if (length === null && req.headers['transfer-encoding'] !== undefined) throw new HttpError(411, 'length-required', '请求体须带 Content-Length');
    if (length === null || length === 0) return {};
    if (length > MAX_JSON_BYTES) throw new HttpError(413, 'payload-too-large', '请求体过大');
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith(JSON_TYPE)) throw new HttpError(415, 'unsupported-media-type', '请求体须为 application/json');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('须为对象');
        return parsed;
    } catch (err) {
        throw new HttpError(400, 'bad-request', '请求体不是合法的 JSON 对象');
    }
}

/** 因 Host / Origin 被拒时附上收到的值，便于判断是哪个环节改写了它；其余拒绝原因不附任何头值 */
function describeDenied(code, headers) {
    const name = { 'bad-host': 'host', 'bad-origin': 'origin' }[code];
    if (!name) return '';
    return `（${name}=${String(headers[name]).slice(0, DENIED_VALUE_LIMIT)}）`;
}

function describeListenError(err, port) {
    if (err && err.code === 'EADDRINUSE') {
        return {
            state: STATE.PORT_IN_USE,
            message: `端口 ${port} 已被其他程序占用，Word 加载项服务未能启动`,
            hint: `在「终端」执行 lsof -nP -iTCP:${port} -sTCP:LISTEN 查出占用该端口的进程，退出它之后取消勾选再重新勾选「启用」。端口写在 Word 的清单里，因此不会自动改用其他端口。`,
        };
    }
    return { state: STATE.ERROR, message: `Word 加载项服务启动失败：${errText(err)}`, hint: '' };
}

// ============================================================
// 服务
// ============================================================

function createAddinServer({
    staticDir, version, jobs, actions = {}, port = DEFAULT_PORT, host = BIND_HOST, maxBodyBytes = MAX_BODY_BYTES, log = noop,
} = {}) {
    if (typeof staticDir !== 'string' || !path.isAbsolute(staticDir)) throw new Error('createAddinServer 需要绝对路径的 staticDir');
    if (!jobs || typeof jobs.reserve !== 'function') throw new Error('createAddinServer 缺少 jobs');
    const safeVersion = VERSION_SAFE_RE.test(String(version)) ? String(version) : '';
    let current = { server: null, token: null, port: null, failure: null };

    function status() {
        if (current.server) {
            return { state: STATE.LISTENING, port: current.port, url: `http://localhost:${current.port}/taskpane.html`, message: '', hint: '' };
        }
        const failure = current.failure || { state: STATE.STOPPED, message: '', hint: '' };
        return { state: failure.state, port, url: null, message: failure.message, hint: failure.hint };
    }

    function timeouts() {
        const { server } = current;
        if (!server) return null;
        return { headersTimeout: server.headersTimeout, requestTimeout: server.requestTimeout, keepAliveTimeout: server.keepAliveTimeout };
    }

    function listen(server) {
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => {
                server.removeListener('error', reject);
                resolve(server.address().port);
            });
        });
    }

    async function start() {
        if (current.server) return status();
        const token = createToken();
        const server = http.createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
            handle(req, res, token, server.address().port).catch((err) => fail(req, res, err));
        });
        server.maxConnections = MAX_CONNECTIONS;
        server.headersTimeout = HEADERS_TIMEOUT_MS;
        server.requestTimeout = REQUEST_TIMEOUT_MS;
        server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
        try {
            const boundPort = await listen(server);
            server.on('error', (err) => log(`[addin] 服务异常：${excerpt(errText(err), { firstLineOnly: true, redactPaths: true })}`));
            current = { server, token, port: boundPort, failure: null };
            log(`[addin] 回环服务已监听 ${host}:${boundPort}`);
        } catch (err) {
            current = { server: null, token: null, port: null, failure: describeListenError(err, port) };
            log(`[addin] ${current.failure.message}`);
        }
        return status();
    }

    async function stop() {
        const { server } = current;
        current = { server: null, token: null, port: null, failure: null };
        if (!server) return status();
        await new Promise((resolve) => {
            server.close(() => resolve());
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        });
        log('[addin] 回环服务已停止');
        return status();
    }

    // ---------- 路由 ----------

    function matchRoute(method, pathname) {
        if (method === 'GET' && STATIC_FILES[pathname]) return { kind: 'static', needsToken: false, entry: STATIC_FILES[pathname], label: pathname };
        if (method === 'GET' && pathname === '/v1/health') return { kind: 'health', needsToken: false, label: pathname };
        if (method === 'POST' && pathname === '/v1/jobs') return { kind: 'create', needsToken: true, label: pathname };
        const hit = JOB_ROUTE_RE.exec(pathname);
        if (hit && !hit[2] && method === 'GET') return { kind: 'job', needsToken: true, id: hit[1], label: '/v1/jobs/:id' };
        if (hit && hit[2] && method === 'POST') return { kind: hit[2], needsToken: true, id: hit[1], label: `/v1/jobs/:id/${hit[2]}` };
        return null;
    }

    async function handle(req, res, token, boundPort) {
        const route = matchRoute(req.method, pathnameOf(req.url));
        // 未知路径也先过 Host / Origin / 自定义头：探测者拿不到「此路径是否存在」以外的任何信息；/v1/ 之下一律要令牌
        const needsToken = route ? route.needsToken : pathnameOf(req.url).startsWith('/v1/');
        const denied = checkRequest({ method: req.method, headers: req.headers, port: boundPort, token, needsToken });
        if (denied) {
            log(`[addin] ${req.method} ${route ? route.label : '(未知路径)'} → ${denied.status} ${denied.code}${describeDenied(denied.code, req.headers)}`);
            sendError(res, denied.status, denied.code, denied.message);
            return;
        }
        if (!route) {
            sendError(res, 404, 'not-found', '无此资源');
            return;
        }
        await HANDLERS[route.kind](req, res, route, token);
        log(`[addin] ${req.method} ${route.label} → ${res.statusCode}`);
    }

    function fail(req, res, err) {
        const known = err instanceof HttpError || err instanceof GuardError || err instanceof JobError;
        const status = known ? err.status : 500;
        log(`[addin] ${req.method} → ${status} ${known ? err.code : `internal：${excerpt(errText(err), { firstLineOnly: true, redactPaths: true })}`}`);
        if (res.headersSent) {
            res.destroy();
            return;
        }
        sendError(res, status, known ? err.code : 'internal', known ? err.message : '内部错误，详见 MarkFlow 的日志');
    }

    async function serveStatic(req, res, route, token) {
        let body;
        try {
            body = await fsp.readFile(path.join(staticDir, route.entry.file));
        } catch (err) {
            throw new HttpError(500, 'asset-missing', '任务窗格资源缺失，请重新安装 MarkFlow');
        }
        if (route.entry.inject) {
            const html = body.toString('utf8')
                .split('{{MARKFLOW_TOKEN}}').join(token)
                .split('{{MARKFLOW_VERSION}}').join(safeVersion)
                .split('{{MARKFLOW_MAX_BYTES}}').join(String(maxBodyBytes));
            body = Buffer.from(html, 'utf8');
        }
        send(res, 200, body, { 'Content-Type': route.entry.type });
    }

    const serveHealth = async (req, res) => sendData(res, 200, { version: safeVersion });

    async function createJob(req, res) {
        // 哨兵须先于本函数的第一个 await（jobs.reserve）挂上，缘由见文件头「上传的时序约束」
        const watch = watchRequest(req);
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith(OCTET_STREAM)) {
            throw new HttpError(415, 'unsupported-media-type', `请求体须为 ${OCTET_STREAM}`);
        }
        const length = declaredLength(req);
        if (length !== null && length > maxBodyBytes) throw new HttpError(413, 'payload-too-large', `文档超过大小上限（${Math.floor(maxBodyBytes / 1024 / 1024)} MB）`);
        if (length === 0) throw new HttpError(400, 'empty-body', '请求体为空');
        const fileName = decodeHeaderValue(req.headers[FILE_NAME_HEADER], { name: '文件名', maxLength: MAX_NAME_LENGTH });
        const sourcePath = decodeHeaderValue(req.headers[SOURCE_PATH_HEADER], { name: '源路径', maxLength: MAX_PATH_LENGTH });
        const { id, uploadPath } = await jobs.reserve({ fileName, sourcePath });
        try {
            const meter = await receiveUpload(req, uploadPath, maxBodyBytes, watch);
            if (meter.bytes === 0) throw new HttpError(400, 'empty-body', '请求体为空');
            if (!meter.head.equals(ZIP_MAGIC)) throw new HttpError(400, 'invalid-docx', '收到的内容不是 docx（zip）格式');
            log(`[addin] 任务 ${id} 已接收 ${meter.bytes} 字节`);
            sendData(res, 202, jobs.commit(id));
        } catch (err) {
            await jobs.abort(id);
            throw err;
        }
    }

    async function readJob(req, res, route) {
        const snapshot = jobs.get(route.id);
        if (!snapshot) throw new HttpError(404, 'job-not-found', '任务不存在或已过期');
        sendData(res, 200, snapshot);
    }

    function requireProduct(id) {
        if (!jobs.get(id)) throw new HttpError(404, 'job-not-found', '任务不存在或已过期');
        const product = jobs.productOf(id);
        if (!product) throw new HttpError(409, 'job-not-succeeded', '任务尚未成功完成');
        return product;
    }

    async function assertExists(target) {
        const stat = await fsp.stat(target).catch(() => null);
        if (!stat) throw new HttpError(410, 'output-missing', '产物不存在或已被移动');
    }

    async function revealJob(req, res, route) {
        const product = requireProduct(route.id);
        if (typeof actions.reveal !== 'function') throw new HttpError(501, 'reveal-unavailable', '当前环境无法在访达中显示');
        await assertExists(product.outputPath);
        await actions.reveal(product.outputPath);
        sendData(res, 200, { revealed: true });
    }

    async function previewJob(req, res, route) {
        const product = requireProduct(route.id);
        if (typeof actions.preview !== 'function') throw new HttpError(501, 'preview-unavailable', '当前环境未接入 MarkFlow 预览');
        const body = await readSmallJson(req);
        const part = body.part === undefined ? product.parts[0] : body.part;
        if (typeof part !== 'string' || !product.parts.includes(part)) throw new HttpError(400, 'bad-part', '没有这一部分的产物可供预览');
        await assertExists(product.outputs[part]);
        await actions.preview(product.outputs[part]);
        sendData(res, 200, { opened: true, part });
    }

    const HANDLERS = Object.freeze({ static: serveStatic, health: serveHealth, create: createJob, job: readJob, reveal: revealJob, preview: previewJob });

    return { start, stop, status, timeouts };
}

module.exports = {
    createAddinServer, HttpError, DEFAULT_PORT, BIND_HOST, MAX_BODY_BYTES, STATE, STATIC_FILES,
    FILE_NAME_HEADER, SOURCE_PATH_HEADER, HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, KEEP_ALIVE_TIMEOUT_MS,
};
