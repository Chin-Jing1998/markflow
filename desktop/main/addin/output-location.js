/**
 * Word 加载项任务的输出位置与产物名裁决（服务端单方面决定，客户端不能指定任意目录）
 *
 * resolveOutputLocation({ sourcePath, fileName, fallbackDir, now? }) → Promise<{
 *     outputDir,   绝对路径，返回前已确认存在且可写
 *     baseName,    产物目录名主干（已经 sanitizeFolderName）；上传的临时文件命名为 `${baseName}.docx`，
 *                  转换内核据文件名派生产物名，二者因此一致
 *     basis,       'source-dir'（源文件所在目录，与命令行「产物与源文件同级」的习惯一致）| 'output-dir'（设置里的输出目录）
 *     sourcePath,  通过全部校验的源文件绝对路径，否则 null
 *     note,        未能存到源文件旁边的原因（中文，供任务窗格原样展示）；存到源文件旁边时为 null
 * }>
 *
 * sourcePath 来自任务窗格读到的 Office.context.document.url：已保存的本地文档是绝对路径，未保存的新文档是空串，
 * 云端文档是 http(s) 地址。它只用来决定「写到哪个目录」，因此逐项校验：须为绝对路径（file:// 先换算），
 * 不得含 .. 段，指向的文件须存在且为普通文件，所在目录须可写；任一项不满足即弃用该路径、改存 fallbackDir，
 * 并把原因写进 note——弃用的只是路径，任务照常进行。
 * fileName 只在 sourcePath 不可用时用来起名：先剥掉目录部分与扩展名再清洗；仍取不到名字则用「未命名文档-时间戳」。
 * fallbackDir 不存在时自动创建（与桌面端转换页对输出目录的处理一致），创建失败或不可写则抛中文错误。
 */
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');

const { sanitizeFolderName, stripExt } = require('../../../converters/ir/util');
const { errText } = require('../../../converters/util');

const fsp = fs.promises;
const UNTITLED_PREFIX = '未命名文档';
const FILE_URL_RE = /^file:\/\//i;
const REMOTE_URL_RE = /^https?:\/\//i;
const BASIS = Object.freeze({ SOURCE_DIR: 'source-dir', OUTPUT_DIR: 'output-dir' });
const NOTES = Object.freeze({
    unsaved: '文档尚未保存到磁盘，产物已存入 MarkFlow 的输出目录',
    remote: '文档位于云端（不是本机路径），产物已存入 MarkFlow 的输出目录',
});

/** 本地时间 YYYYMMDD-HHmmss */
function formatTimestamp(date) {
    const pad = (n) => String(n).padStart(2, '0');
    const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    return `${day}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** 词法校验：→ { ok: true, path } | { ok: false, note }；不触碰文件系统 */
function normalizeSourcePath(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return { ok: false, note: NOTES.unsaved };
    if (REMOTE_URL_RE.test(text)) return { ok: false, note: NOTES.remote };
    let candidate = text;
    if (FILE_URL_RE.test(text)) {
        try {
            candidate = fileURLToPath(text);
        } catch (err) {
            return { ok: false, note: invalidNote('file:// 地址无法换算为本机路径') };
        }
    }
    if (!path.isAbsolute(candidate)) return { ok: false, note: invalidNote('不是绝对路径') };
    if (candidate.split(/[\\/]/).includes('..')) return { ok: false, note: invalidNote('含有 .. 段') };
    return { ok: true, path: path.normalize(candidate) };
}

const invalidNote = (reason) => `文档路径不可用（${reason}），产物已存入 MarkFlow 的输出目录`;

/** 文件系统校验：文件存在且为普通文件、所在目录可写 */
async function checkSourceOnDisk(filePath) {
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) return { ok: false, note: invalidNote('该路径上没有这个文件') };
    const dir = path.dirname(filePath);
    try {
        await fsp.access(dir, fs.constants.W_OK);
    } catch (err) {
        return { ok: false, note: '文档所在目录不可写，产物已存入 MarkFlow 的输出目录' };
    }
    return { ok: true, dir };
}

/** 从客户端给的文件名里取主干：剥目录、剥扩展名、清洗；取不到回空串 */
function baseNameFromFileName(fileName) {
    const text = typeof fileName === 'string' ? fileName.trim() : '';
    if (!text) return '';
    const leaf = text.split(/[\\/]/).pop() || '';
    return sanitizeFolderName(stripExt(leaf), '');
}

async function ensureFallbackDir(fallbackDir) {
    if (typeof fallbackDir !== 'string' || !path.isAbsolute(fallbackDir)) throw new Error('MarkFlow 的输出目录未设置或不是绝对路径');
    const dir = path.resolve(fallbackDir);
    try {
        await fsp.mkdir(dir, { recursive: true });
        await fsp.access(dir, fs.constants.W_OK);
    } catch (err) {
        throw new Error(`MarkFlow 的输出目录不可用：${errText(err)}`);
    }
    return dir;
}

async function resolveOutputLocation({ sourcePath, fileName, fallbackDir, now = () => new Date() } = {}) {
    const lexical = normalizeSourcePath(sourcePath);
    const onDisk = lexical.ok ? await checkSourceOnDisk(lexical.path) : lexical;
    const untitled = `${UNTITLED_PREFIX}-${formatTimestamp(now())}`;
    if (lexical.ok && onDisk.ok) {
        return {
            outputDir: onDisk.dir,
            baseName: sanitizeFolderName(stripExt(path.basename(lexical.path)), untitled),
            basis: BASIS.SOURCE_DIR,
            sourcePath: lexical.path,
            note: null,
        };
    }
    // 路径虽不可用，文件名部分仍可用来起名（云端文档、源文件已被移走等）
    const hinted = baseNameFromFileName(fileName) || (lexical.ok ? baseNameFromFileName(lexical.path) : '');
    return {
        outputDir: await ensureFallbackDir(fallbackDir),
        baseName: hinted || untitled,
        basis: BASIS.OUTPUT_DIR,
        sourcePath: null,
        note: onDisk.note,
    };
}

module.exports = { resolveOutputLocation, normalizeSourcePath, baseNameFromFileName, formatTimestamp, BASIS, UNTITLED_PREFIX };
