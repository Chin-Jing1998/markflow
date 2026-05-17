/**
 * LibreOffice CLI（soffice）探测与封装
 *
 * 用于 DOC/XLS/PPT 等旧二进制格式转换（先 soffice 转为新格式，再走对应 parser）。
 * 不 bundling LibreOffice（~400MB）；运行时探测 + 缺失时降级抛友好错。
 */

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let _sofficePath = undefined; // undefined=未探测，null=不可用，string=路径

const CANDIDATE_PATHS = {
    darwin: [
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        '/Applications/OpenOffice.app/Contents/MacOS/soffice',
    ],
    win32: [
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    ],
    linux: [
        '/usr/bin/soffice',
        '/usr/bin/libreoffice',
        '/opt/libreoffice/program/soffice',
        '/snap/bin/libreoffice',
    ],
};

function detectSoffice({ force = false } = {}) {
    if (!force && _sofficePath !== undefined) return _sofficePath;

    // 1) which / where
    try {
        const finder = process.platform === 'win32' ? 'where' : 'which';
        const out = execFileSync(finder, ['soffice'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        })
            .split(/\r?\n/)[0]
            .trim();
        if (out && fs.existsSync(out)) {
            _sofficePath = out;
            return _sofficePath;
        }
    } catch (e) {}

    // 2) 平台默认路径
    const candidates = CANDIDATE_PATHS[process.platform] || [];
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                _sofficePath = p;
                return _sofficePath;
            }
        } catch (e) {}
    }

    _sofficePath = null;
    return null;
}

function isAvailable() {
    return !!detectSoffice();
}

function getInstallHint() {
    const p = process.platform;
    if (p === 'darwin') {
        return 'macOS：brew install --cask libreoffice  或前往 https://www.libreoffice.org/download/';
    }
    if (p === 'win32') {
        return 'Windows：前往 https://www.libreoffice.org/download/ 下载安装包';
    }
    return 'Linux：sudo apt install libreoffice  或前往 https://www.libreoffice.org/download/';
}

/**
 * 用 soffice 把 inputBuffer 转换为 targetExt 格式
 * @param {Buffer} inputBuffer
 * @param {string} sourceExt  源扩展名（不含点），如 'doc' 'xls' 'ppt'
 * @param {string} targetExt  目标扩展名（不含点），如 'docx' 'xlsx' 'pptx'
 * @returns {Buffer} 转换后的二进制
 */
async function convertWithSoffice(inputBuffer, sourceExt, targetExt) {
    const sofficePath = detectSoffice();
    if (!sofficePath) {
        throw new Error(
            `不支持的旧二进制格式：需要 LibreOffice 转换。${getInstallHint()}`,
        );
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'markflow-soffice-'));
    const inputPath = path.join(tmpDir, `input.${sourceExt}`);
    fs.writeFileSync(inputPath, inputBuffer);

    try {
        const args = [
            '--headless',
            '--norestore',
            '--nologo',
            '--nofirststartwizard',
            '--convert-to',
            targetExt,
            '--outdir',
            tmpDir,
            inputPath,
        ];

        const result = spawnSync(sofficePath, args, {
            encoding: 'utf8',
            timeout: 60000,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        if (result.error) {
            throw new Error(`soffice 调用失败：${result.error.message}`);
        }
        if (result.status !== 0) {
            const msg = (result.stderr || result.stdout || '').slice(0, 300);
            throw new Error(`soffice 退出码 ${result.status}: ${msg}`);
        }

        const outputPath = path.join(tmpDir, `input.${targetExt}`);
        if (!fs.existsSync(outputPath)) {
            // 列出 tmpDir 实际产物便于排查
            const actual = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
            throw new Error(
                `soffice 未生成预期文件 ${outputPath}（实际产物：${actual.join(', ')}）`,
            );
        }

        return fs.readFileSync(outputPath);
    } finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (e) {}
    }
}

module.exports = {
    detectSoffice,
    isAvailable,
    convertWithSoffice,
    getInstallHint,
};
