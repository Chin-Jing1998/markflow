/**
 * Electron 子进程启动器（全仓唯一一份；PDF 打印与栅格化两个后端共用）
 *
 * spawnElectron(electronPath, args, { timeoutMs, cwd, env, spawn }) → Promise<SpawnResult>
 *   SpawnResult = { code, signal, stdout, stderr, stderrSummary, timedOut, timeoutMs }
 *   - env 清洗：以 env（缺省 process.env）为底，剔除 SCRUBBED_ENV_KEYS——继承 ELECTRON_RUN_AS_NODE 会让子进程
 *     退化为纯 Node（没有 app / BrowserWindow），NODE_OPTIONS 会把父进程的 Node 开关灌进 Electron 主进程；
 *   - stdio 为 ['ignore', 'pipe', 'pipe']，stdout / stderr 各保留至多 OUTPUT_KEEP_LIMIT 字符；stderr 逐行过滤
 *     STDERR_NOISE_PATTERNS（未签名 Electron 在 macOS 上持续输出的 sandbox_extension_issue_file 等噪声）；
 *   - 超时：SIGKILL 子进程并立即以 timedOut:true 结束（不等待 exit）；退出码非 0 不抛错，由调用方按需
 *     调用 assertExitOk 统一成中文错误；
 *   - spawn 自身抛错或 error 事件 → reject，错误 code 为 ELECTRON_SPAWN_FAILED，cause 保留原错误；
 *   - spawn 可注入以便测试。
 * assertExitOk(result, label) → 超时抛「<label>超时」，退出码非 0 抛含退出码与 stderr 摘要（首行、绝对路径脱敏为
 *   <path>）的中文错误，完整 stderr 走 console.error 供排障；正常返回 undefined。
 * getElectronPath() → 普通 Node 进程里 require('electron') 得到的是 electron 可执行文件的路径字符串，
 *   存在时返回该路径，未安装或文件不存在返回 null（不抛错）。
 */
const { spawn: nodeSpawn } = require('child_process');
const fs = require('fs');
const tmp = require('../tmp');

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_LABEL = 'Electron 工作进程';
const OUTPUT_KEEP_LIMIT = 4096;
const SUMMARY_LIMIT = 500;
/** exit 之后等待 close（stdio 排空）的宽限；注入的假子进程可能只发 exit，不能无限等 */
const CLOSE_GRACE_MS = 50;
const SPAWN_FAILED_CODE = 'ELECTRON_SPAWN_FAILED';
const SCRUBBED_ENV_KEYS = Object.freeze(['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS']);
const STDERR_NOISE_PATTERNS = Object.freeze([
    /sandbox_extension_issue_file/,
    /\bIMKClient\b|\bIMKInputSession\b/,
    /Electron Security Warning/,
]);

/** 同步执行 fn 并吞掉异常，失败返回 null */
const attempt = (fn) => { try { return fn(); } catch (err) { return null; } };

function getElectronPath() {
    const mod = attempt(() => require('electron'));
    if (typeof mod !== 'string' || !mod) return null;
    return attempt(() => fs.existsSync(mod)) ? mod : null;
}

/** 以 base 为底复制一份环境变量并剔除会改变 Electron 身份或注入 Node 开关的键 */
function scrubEnv(base = process.env) {
    const env = { ...(base || {}) };
    for (const key of SCRUBBED_ENV_KEYS) delete env[key];
    return env;
}

const isNoiseLine = (line) => STDERR_NOISE_PATTERNS.some((re) => re.test(line));

/** 按行收集输出：可选逐行过滤，总量封顶；flush 把末尾未换行的残片也收进来 */
function createLineCollector({ filter = null, limit = OUTPUT_KEEP_LIMIT } = {}) {
    let text = '';
    let rest = '';
    const take = (line) => {
        if (filter && filter(line)) return;
        if (text.length >= limit) return;
        text += `${line}\n`;
    };
    return {
        push(chunk) {
            rest += String(chunk);
            const lines = rest.split(/\r?\n/);
            rest = lines.pop();
            lines.forEach(take);
        },
        flush() {
            if (rest) take(rest);
            rest = '';
        },
        text: () => text.slice(0, limit),
    };
}

function spawnElectron(electronPath, args, { timeoutMs, cwd, env, spawn } = {}) {
    const spawnFn = typeof spawn === 'function' ? spawn : nodeSpawn;
    const limitMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
    const argv = Array.isArray(args) ? args.map(String) : [];

    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawnFn(electronPath, argv, {
                env: scrubEnv(env),
                cwd: typeof cwd === 'string' && cwd ? cwd : undefined,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (err) {
            reject(wrapSpawnError(err));
            return;
        }

        const stdout = createLineCollector();
        const stderr = createLineCollector({ filter: isNoiseLine });
        let settled = false;
        let timer = null;
        let closeTimer = null;
        const clearTimers = () => { clearTimeout(timer); clearTimeout(closeTimer); };
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimers();
            fn(value);
        };
        const buildResult = (code, signal, timedOut) => {
            stdout.flush();
            stderr.flush();
            const stderrText = stderr.text();
            return { code, signal, stdout: stdout.text(), stderr: stderrText, stderrSummary: summarize(stderrText), timedOut, timeoutMs: limitMs };
        };

        timer = setTimeout(() => {
            attempt(() => child.kill('SIGKILL')); // 进程可能已退出
            finish(resolve, buildResult(null, 'SIGKILL', true));
        }, limitMs);

        if (child.stdout) child.stdout.on('data', (chunk) => stdout.push(chunk));
        if (child.stderr) child.stderr.on('data', (chunk) => stderr.push(chunk));
        child.on('error', (err) => finish(reject, wrapSpawnError(err)));
        // exit 可能先于 stdio 排空到达：优先等 close，close 迟迟不来（假子进程）则按宽限结束
        child.on('exit', (code, signal) => {
            const done = () => finish(resolve, buildResult(code, signal || null, false));
            child.once('close', done);
            closeTimer = setTimeout(done, CLOSE_GRACE_MS);
        });
    });
}

function wrapSpawnError(err) {
    const wrapped = new Error(`无法启动 Electron 子进程：${err && err.message ? err.message : err}`);
    wrapped.code = SPAWN_FAILED_CODE;
    wrapped.cause = err;
    return wrapped;
}

/**
 * 用户可见的 stderr 摘要：只取首行并把绝对路径替换为 <path>。
 * 首行之后通常是调用栈，既无助于用户排障，又会把项目目录结构暴露到界面与日志导出中。
 */
const summarize = (text) => tmp.excerpt(text, { limit: SUMMARY_LIMIT, firstLineOnly: true, redactPaths: true });

/** 超时或退出码非 0 时抛统一格式的中文错误；完整 stderr（含调用栈与绝对路径）只进日志 */
function assertExitOk(result, label = DEFAULT_LABEL) {
    if (!result || typeof result !== 'object') throw new Error(`${label}未返回执行结果`);
    if (result.timedOut) {
        throw new Error(`${label}超时（${Math.round((result.timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s），已强制结束`);
    }
    if (result.code === 0) return;
    if (result.stderr) console.error(`${label} stderr：`, result.stderr);
    const signalText = result.signal ? `, signal=${result.signal}` : '';
    const detail = result.stderrSummary || '无 stderr 输出';
    throw new Error(`${label}退出异常（code=${result.code}${signalText}）：${detail}`);
}

module.exports = {
    spawnElectron, assertExitOk, getElectronPath, scrubEnv,
    SPAWN_FAILED_CODE, SCRUBBED_ENV_KEYS, STDERR_NOISE_PATTERNS, DEFAULT_TIMEOUT_MS,
};
