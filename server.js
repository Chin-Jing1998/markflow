/**
 * MarkFlow 本地 HTTP 服务（默认只监听 127.0.0.1，全部 /api 端点需请求头 X-MarkFlow-Token）
 *   GET  /api/formats             能力矩阵 + soffice / PDF 后端实时探测结果
 *   POST /api/convert             批量转换，NDJSON 流式回传 accepted/start/progress/item/done
 *   GET  /api/settings/output-dir 读取当前输出目录
 *   POST /api/settings/output-dir 设置输出目录（须为已存在且可写的绝对路径目录）
 * 静态资源仅开放 /、/css、/js、/assets；输出目录持久化于 ~/.markflow/settings.json。
 */
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const converters = require('./converters');
const pdfBackend = require('./converters/pdf/backend');
const soffice = require('./server/soffice');
const { assertPublicUrl } = require('./converters/net/fetch-guard');
const { requireToken, mountStatic } = require('./server/security');

const fsp = fs.promises;
const MAX_ITEMS = 200;
const CONCURRENCY = 2;
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), 'Documents', 'MarkFlow');
const errorMessage = (err) => (err && err.message ? err.message : String(err));

function settingsFile() {
    return process.env.MARKFLOW_SETTINGS_FILE || path.join(os.homedir(), '.markflow', 'settings.json');
}

function readPersistedDir() {
    try {
        const { outputDir } = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
        return typeof outputDir === 'string' ? outputDir : '';
    } catch (err) {
        return '';
    }
}

function persistOutputDir(outputDir) {
    const file = settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ outputDir }, null, 2)}\n`, 'utf8');
}

// 仅默认目录允许自动创建，其余来源一律要求目录已存在
function resolveInitialOutputDir(explicit) {
    const picked = explicit || process.env.MARKFLOW_OUTPUT_DIR || readPersistedDir();
    if (picked) return picked;
    fs.mkdirSync(DEFAULT_OUTPUT_DIR, { recursive: true });
    return DEFAULT_OUTPUT_DIR;
}

// 目录须为绝对路径、已存在且可写；不满足则抛出中文原因
async function assertUsableDir(dir) {
    if (typeof dir !== 'string' || dir.trim() === '') throw new Error('目录不能为空');
    const target = dir.trim();
    if (!path.isAbsolute(target)) throw new Error(`必须是绝对路径：${target}`);
    const stat = await fsp.stat(target).catch(() => null);
    if (!stat || !stat.isDirectory()) throw new Error(`目录不存在：${target}`);
    await fsp.access(target, fs.constants.W_OK).catch(() => { throw new Error(`目录不可写：${target}`); });
    return target;
}

// 每次调用都实时探测运行时依赖，并据此拼装可用目标矩阵
async function probeTargets() {
    const [sofficeAvailable, backend] = await Promise.all([soffice.isAvailable(), pdfBackend.detect()]);
    const targets = converters.listTargets({ sofficeAvailable, pdfBackend: backend.available ? backend : null });
    return { capabilities: { sofficeAvailable, pdfBackend: backend }, targets };
}

async function resolveFileInput(filePath) {
    if (!path.isAbsolute(filePath)) throw new Error(`路径必须是绝对路径：${filePath}`);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error(`文件不存在或不是普通文件：${filePath}`);
    const type = converters.detectInputType(filePath);
    if (!type) throw new Error(`不支持的输入格式：${path.extname(filePath) || '(无扩展名)'}`);
    return { type, input: { path: filePath } };
}

async function resolveUrlInput(url) {
    await assertPublicUrl(url); // 拒绝本机地址与内网、保留网段
    return { type: 'url', input: { url } };
}

// → { input: { path } | { url }, target }
async function normalizeItem(raw, targets) {
    const item = raw && typeof raw === 'object' ? raw : {};
    const hasPath = typeof item.path === 'string' && item.path.trim() !== '';
    const hasUrl = typeof item.url === 'string' && item.url.trim() !== '';
    if (hasPath === hasUrl) throw new Error('path 与 url 必须二选一');
    const { type, input } = hasPath
        ? await resolveFileInput(item.path.trim())
        : await resolveUrlInput(item.url.trim());
    const allowed = targets[targets.inputs[type]];
    if (!allowed) throw new Error(`当前环境不支持 ${type} 输入`);
    const target = typeof item.target === 'string' ? item.target : '';
    if (!allowed.includes(target)) {
        throw new Error(`${type} 输入只能转为 ${allowed.join('、')}，实际为 ${target || '(空)'}`);
    }
    return { input, target };
}

// 逐项串行校验，任一项不合法即整批拒绝，错误信息保留出错项序号
async function normalizeItems(rawItems, targets) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) throw new Error('items 必须是非空数组');
    if (rawItems.length > MAX_ITEMS) throw new Error(`单次最多 ${MAX_ITEMS} 项，实际 ${rawItems.length} 项`);
    const items = [];
    for (let i = 0; i < rawItems.length; i += 1) {
        try {
            items.push(await normalizeItem(rawItems[i], targets));
        } catch (err) {
            throw new Error(`第 ${i + 1} 项：${err.message}`);
        }
    }
    return items;
}

// accepted → runBatch 的 start/progress/item 事件 → done；客户端断开后停止写入，但不打断已在进行的转换
async function streamBatch(req, res, items, outputDir) {
    res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let alive = true;
    req.on('close', () => { alive = false; });
    const write = (event) => {
        if (!alive) return;
        const payload = event.type === 'item' && !event.ok
            ? { ...event, error: errorMessage(event.error) }
            : event;
        res.write(`${JSON.stringify(payload)}\n`);
    };
    write({ type: 'accepted', total: items.length, outputDir });
    try {
        await converters.runBatch(items, { concurrency: CONCURRENCY, onEvent: write }, (item, onProgress) => (
            converters.convert({ input: item.input, target: item.target, outputDir, onProgress })
        ));
    } catch (err) {
        write({ type: 'done', total: items.length, succeeded: 0, failed: items.length, error: errorMessage(err) });
    }
    if (alive) res.end();
}

function createApp(token, state) {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    }, requireToken(token));

    app.get('/api/formats', async (req, res) => {
        const { capabilities, targets } = await probeTargets();
        res.json({ success: true, targets, capabilities, outputDir: state.outputDir });
    });

    app.get('/api/settings/output-dir', (req, res) => {
        res.json({ success: true, outputDir: state.outputDir });
    });

    app.post('/api/settings/output-dir', async (req, res, next) => {
        try {
            const dir = await assertUsableDir((req.body || {}).dir);
            persistOutputDir(dir);
            state.outputDir = dir;
            res.json({ success: true, outputDir: dir });
        } catch (err) {
            if (err.code) return next(err); // 带 errno 的写盘失败按 500 处理
            res.status(400).json({ success: false, error: errorMessage(err) });
        }
    });

    app.post('/api/convert', async (req, res) => {
        const body = req.body || {};
        let batch;
        try {
            const outputDir = body.outputDir ? await assertUsableDir(body.outputDir) : state.outputDir;
            batch = { outputDir, items: await normalizeItems(body.items, (await probeTargets()).targets) };
        } catch (err) {
            res.status(400).json({ success: false, error: errorMessage(err) });
            return;
        }
        await streamBatch(req, res, batch.items, batch.outputDir);
    });

    mountStatic(app, __dirname);
    app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
        const status = err.status || err.statusCode || 500;
        if (status >= 500) console.error('服务异常:', err);
        if (res.headersSent) return res.end();
        res.status(status).json({ success: false, error: errorMessage(err) });
    });
    return app;
}

function startServer({ host = '127.0.0.1', port = 0, token, outputDir } = {}) {
    const authToken = token || crypto.randomBytes(24).toString('hex');
    const app = createApp(authToken, { outputDir: resolveInitialOutputDir(outputDir) });
    return new Promise((resolve, reject) => {
        const server = app.listen(port, host);
        server.once('error', reject);
        server.once('listening', () => resolve({
            server,
            port: server.address().port,
            token: authToken,
            close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
        }));
    });
}

module.exports = { startServer };

// 直接运行：端口与 token 取自环境变量，启动信息只写 stderr，stdout 保持干净
if (require.main === module) {
    startServer({ port: Number(process.env.PORT) || 0, token: process.env.MARKFLOW_TOKEN })
        .then(({ port, token }) => console.error(`MarkFlow 服务已启动: http://127.0.0.1:${port}  token=${token}`))
        .catch((err) => { console.error('MarkFlow 启动失败:', errorMessage(err)); process.exitCode = 1; });
}
