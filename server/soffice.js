/**
 * LibreOffice CLI（soffice）探测与异步封装
 *
 * 用于 DOC/XLS/PPT 等旧二进制格式转换（先 soffice 转为新格式，再走对应 parser），
 * 以及 DOCX → PDF 的后端出图。不 bundling LibreOffice（~400MB），运行时探测，
 * 缺失时抛带安装提示的中文错误。
 * 关键约束：全程异步（execFile），不阻塞事件循环，不使用任何 *Sync API；同一时刻只允许
 * 一个 soffice 进程，内部 Promise 链串行排队；每次转换用独立的 UserInstallation 临时
 * profile，用完即删。
 */
const { execFile } = require('child_process');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const CONVERT_TIMEOUT_MS = 120000;
/** 探测失败后的缓存有效期（毫秒）：过期可重探，避免用户装好 LibreOffice 后必须重启 */
const DETECT_FAILURE_TTL_MS = 60000;
const STDERR_EXCERPT_LIMIT = 300;
const EXEC_MAX_BUFFER = 8 * 1024 * 1024;

const CANDIDATE_PATHS = {
    darwin: [
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        '/Applications/OpenOffice.app/Contents/MacOS/soffice',
    ],
    win32: [
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    ],
    linux: ['/usr/bin/soffice', '/usr/bin/libreoffice', '/opt/libreoffice/program/soffice', '/snap/bin/libreoffice'],
};

let _sofficePath = undefined; // undefined=未探测，null=不可用，string=路径
let _detectFailedAt = 0; // 上次探测失败的时间戳
let _queue = Promise.resolve(); // 串行队列尾

// 测试注入钩子（默认指向真实实现）
let _execFileImpl = execFile;
let _detectImpl = probeSoffice;

const noop = () => undefined;

/** execFile 的 Promise 封装；impl 可替换以便测试注入 */
function runExecFile(impl, file, args, options = {}) {
    return new Promise((resolve, reject) => {
        impl(file, args, options, (err, stdout, stderr) => {
            if (!err) return resolve({ stdout, stderr });
            if (err.stderr === undefined && stderr !== undefined) err.stderr = stderr;
            return reject(err);
        });
    });
}

async function pathExists(p) {
    try { await fsp.access(p); return true; } catch (e) { return false; }
}

function excerpt(text) {
    return String(text || '').trim().slice(0, STDERR_EXCERPT_LIMIT);
}

// ---- 探测 ----

/** 真实探测：先查 PATH（which/where），再查平台默认安装路径 */
async function probeSoffice() {
    try {
        const finder = process.platform === 'win32' ? 'where' : 'which';
        const { stdout } = await runExecFile(execFile, finder, ['soffice'], { encoding: 'utf8' });
        const first = String(stdout || '').split(/\r?\n/)[0].trim();
        if (first && (await pathExists(first))) return first;
    } catch (e) {
        // PATH 中没有，继续查默认路径
    }
    for (const p of CANDIDATE_PATHS[process.platform] || []) {
        if (await pathExists(p)) return p;
    }
    return null;
}

/**
 * 探测 soffice 可执行文件路径
 * 成功结果永久缓存；失败结果只缓存 DETECT_FAILURE_TTL_MS，过期后自动重探。
 * @returns {Promise<string|null>}
 */
async function detectSoffice({ force = false } = {}) {
    if (!force) {
        if (typeof _sofficePath === 'string') return _sofficePath;
        if (_sofficePath === null && Date.now() - _detectFailedAt < DETECT_FAILURE_TTL_MS) return null;
    }
    let found = null;
    try { found = await _detectImpl(); } catch (e) { found = null; }
    _sofficePath = found || null;
    _detectFailedAt = found ? 0 : Date.now();
    return _sofficePath;
}

/** @returns {Promise<boolean>} soffice 是否可用 */
async function isAvailable() {
    return !!(await detectSoffice());
}

/** 缺失时给用户的安装指引（按平台） */
function getInstallHint() {
    const p = process.platform;
    if (p === 'darwin') return 'macOS：brew install --cask libreoffice  或前往 https://www.libreoffice.org/download/';
    if (p === 'win32') return 'Windows：前往 https://www.libreoffice.org/download/ 下载安装包';
    return 'Linux：sudo apt install libreoffice  或前往 https://www.libreoffice.org/download/';
}

// ---- 转换 ----

/** 把任务挂到串行队列尾部：前一个任务无论成败，后一个都会接着跑 */
function enqueue(task) {
    const run = _queue.then(task, task);
    _queue = run.then(noop, noop);
    return run;
}

async function runConvert(inputPath, targetExt, outDir) {
    const sofficePath = await detectSoffice();
    if (!sofficePath) {
        throw new Error(`需要 LibreOffice 才能转换该格式，但未在本机找到 soffice。${getInstallHint()}`);
    }

    await fsp.mkdir(outDir, { recursive: true });
    const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'markflow-soffice-profile-'));

    try {
        // UserInstallation 必须是规范 file URL：裸拼接会让含空格、井号或非 ASCII 的临时目录路径
        // 被 LibreOffice 误解析，pathToFileURL 负责百分号编码（空格 → %20）并补齐 Windows 盘符形态
        const args = ['--headless', '--norestore', `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
            '--convert-to', targetExt, '--outdir', outDir, inputPath];

        let stderr = '';
        try {
            const result = await runExecFile(_execFileImpl, sofficePath, args, {
                encoding: 'utf8',
                timeout: CONVERT_TIMEOUT_MS,
                maxBuffer: EXEC_MAX_BUFFER,
            });
            stderr = String((result && result.stderr) || '');
        } catch (err) {
            const detail = excerpt((err && (err.stderr || err.message)) || '未知错误');
            throw new Error(`soffice 转换失败（${path.basename(inputPath)} → ${targetExt}）：${detail}`);
        }

        const outputPath = path.join(outDir, `${path.basename(inputPath, path.extname(inputPath))}.${targetExt}`);
        if (!(await pathExists(outputPath))) {
            const actual = await fsp.readdir(outDir).catch(() => []);
            throw new Error(
                `soffice 未生成预期文件 ${outputPath}（实际产物：${actual.join(', ') || '无'}；stderr：${excerpt(stderr) || '空'}）`,
            );
        }
        return outputPath;
    } finally {
        // 临时 profile 清理失败不影响转换结果
        await fsp.rm(profileDir, { recursive: true, force: true }).catch(noop);
    }
}

/**
 * 用 soffice 把 inputPath 转换为 targetExt 格式，输出到 outDir
 * 多次调用自动串行排队（LibreOffice 同一时间只跑一个转换）。
 * @param {string} inputPath 输入文件绝对路径
 * @param {string} targetExt 目标扩展名（不含点），如 'docx' 'xlsx' 'pptx' 'pdf'
 * @param {{ outDir: string }} opts 输出目录
 * @returns {Promise<string>} 输出文件绝对路径
 */
async function convertFile(inputPath, targetExt, { outDir } = {}) {
    if (!inputPath || typeof inputPath !== 'string') throw new Error('soffice.convertFile 需要 inputPath（字符串路径）');
    if (!targetExt || typeof targetExt !== 'string') throw new Error('soffice.convertFile 需要 targetExt（如 docx/xlsx/pptx）');
    if (!outDir || typeof outDir !== 'string') throw new Error('soffice.convertFile 需要 options.outDir（输出目录）');
    return enqueue(() => runConvert(inputPath, targetExt, outDir));
}

// ---- 测试注入钩子 ----

/** 注入假的 execFile（签名同 child_process.execFile） */
function _setExecFile(fn) {
    _execFileImpl = typeof fn === 'function' ? fn : execFile;
}

/** 注入假的探测实现（async () => string|null），并清空探测缓存 */
function _setDetect(fn) {
    _detectImpl = typeof fn === 'function' ? fn : probeSoffice;
    _sofficePath = undefined;
    _detectFailedAt = 0;
}

/** 恢复真实实现并清空探测缓存与队列 */
function _reset() {
    _execFileImpl = execFile;
    _detectImpl = probeSoffice;
    _sofficePath = undefined;
    _detectFailedAt = 0;
    _queue = Promise.resolve();
}

module.exports = { detectSoffice, isAvailable, getInstallHint, convertFile, _setExecFile, _setDetect, _reset };
