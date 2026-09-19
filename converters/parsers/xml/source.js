/**
 * 五书反向导入的输入形态：单个 XML 文件 / 案卷 zip / 五书目录 → 统一的案卷视图
 *
 * openSource(inputPath, { report, limits? }) → Promise<{ kind, documents, readImage }>
 *   limits      仅供测试收紧上限（键同 LIMITS）；正常调用一律省略，用户选项不经此处
 *   kind        'file' | 'zip' | 'directory'
 *   documents   [{ name, dir, text }]：根元素为 cn-application-body 的 XML。name 为相对输入的展示名
 *               （100002/100002.xml，正斜杠）；dir 为该 XML 所在目录的不透明键，图片只在这个目录里找；
 *               text 为解码后的全文。按 name 的码点序排列，故同一书目出现多份时「取第一份」是确定的
 *   readImage(dir, fileName) → Promise<Buffer | null>：dir 目录下名为 fileName 的文件字节；取不到返回 null，
 *               原因（缺失、越界、超限）已记入 report。fileName 须先经 images.js 判定为裸文件名，本模块不再拆路径
 *
 * 三种形态的候选 XML：
 *   file       就是该文件
 *   directory  目录下的 10000N/10000N.xml（N ∈ 1..5，官方与本工具现行产物）与目录下直接的 *.xml（v3.0.0 平铺产物、
 *              手工整理的五书）；与 converters/scan.js 的目录签名同一范围，不递归其它子目录
 *   zip        任意深度的 *.xml 条目（用户常把整个文件夹再压一层，故不限定层级）；macOS 的 __MACOSX/、._* 与
 *              其它点开头的条目不看
 *   书目一律按内容判定：候选里根元素不是 cn-application-body 的直接略过，文件名不参与判定。
 *
 * 安全边界（输入属不可信内容，一律先判后读）：
 *   - 体量：单份 XML ≤ MAX_XML_BYTES，单张图片 ≤ MAX_IMAGE_BYTES，zip 文件本身 ≤ MAX_ZIP_BYTES、条目数
 *     ≤ MAX_ZIP_ENTRIES，全部已读内容合计 ≤ MAX_TOTAL_BYTES；zip 条目边解压边计数，超限即停（中央目录里
 *     申报的大小只用于提前拒绝，不作为依据——zip bomb 会谎报）
 *   - 条目名：含 .. 片段、以 / 开头或带盘符的条目名（含 JSZip 归一前的原名）一经发现，整个 zip 拒绝导入；
 *     符号链接条目忽略并提示
 *   - 目录形态：候选 XML 与图片一律先 realpath，再判定仍落在所属目录之内，符号链接指向目录外的按缺失处理
 *   - 不写盘、不联网、不执行；错误信息只带相对输入的展示名，不带输入之外的路径
 */
const path = require('path');
const fsp = require('fs').promises;
const JSZip = require('jszip');
const { sniffRootName } = require('../../xml/dom');
const { errText, statOrNull, isRealWithinDir } = require('../../util');

const PATENT_ROOT = 'cn-application-body';
const GENERIC_ROOT = 'document';
const MB = 1024 * 1024;
// 体量上限。官方样稿的说明书 XML 约 40 KB、最大的附图约 250 KB、整包 1.5 MB；上限留出两到三个数量级的余量，
// 只为拦住畸形输入与 zip bomb
const LIMITS = Object.freeze({
    MAX_XML_BYTES: 32 * MB,
    MAX_IMAGE_BYTES: 64 * MB,
    MAX_ZIP_BYTES: 512 * MB,
    MAX_TOTAL_BYTES: 1024 * MB,
    MAX_ZIP_ENTRIES: 2000,
    MAX_XML_CANDIDATES: 64,
});
const SNIFF_BYTES = 8192;
const ENCODING_PROBE_BYTES = 256;
const BOOK_CODES = Object.freeze(['100001', '100002', '100003', '100004', '100005']);
const XML_EXT = '.xml';
const ZIP_EXT = '.zip';
// Unix 文件类型位：0o170000 为掩码，0o120000 为符号链接
const MODE_TYPE_MASK = 0o170000;
const MODE_SYMLINK = 0o120000;
const XML_DECLARED_ENCODING_RE = /<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]{1,40})["']/;
const UTF8_LABEL_RE = /^utf-?8$/i;
const DRIVE_RE = /^[A-Za-z]:/;
const NOISE_SEGMENT_RE = /^(?:\.|__MACOSX$|Thumbs\.db$)/i;

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// 上限的可读写法：整 MB 写「N MB」，不足 1 MB 的（测试收紧后的上限）写字节数
const sizeLabel = (bytes) => (bytes >= MB ? `${Math.round(bytes / MB)} MB` : `${bytes} 字节`);

async function openSource(inputPath, { report, limits: overrides } = {}) {
    const stat = await statOrNull(inputPath);
    if (!stat) throw new Error('输入不存在或无法访问');
    const limits = { ...LIMITS, ...(overrides || {}) };
    const ctx = { report, limits, budget: createBudget(limits.MAX_TOTAL_BYTES) };
    if (stat.isDirectory()) return openDirectory(inputPath, ctx);
    if (!stat.isFile()) throw new Error('输入既不是文件也不是目录');
    if (path.extname(inputPath).toLowerCase() === ZIP_EXT) return openZip(inputPath, stat, ctx);
    return openFile(inputPath, stat, ctx);
}

// 已读内容的总量预算：超出即整体拒绝（单项上限另由各读取点把关）
function createBudget(maxTotal) {
    let used = 0;
    return {
        take(bytes) {
            used += bytes;
            if (used > maxTotal) throw new Error(`案卷内容合计超过 ${sizeLabel(maxTotal)} 上限，已拒绝导入`);
        },
    };
}

// ============================================================
// 单个 XML 文件
// ============================================================

async function openFile(filePath, stat, ctx) {
    const name = path.basename(filePath);
    const { MAX_XML_BYTES } = ctx.limits;
    if (stat.size > MAX_XML_BYTES) throw new Error(`XML 文件 ${name} 超过 ${sizeLabel(MAX_XML_BYTES)} 上限，已拒绝导入`);
    ctx.budget.take(stat.size);
    const text = decodeXml(await fsp.readFile(filePath), name, ctx.report);
    const root = sniffRootName(text.slice(0, SNIFF_BYTES));
    if (root !== PATENT_ROOT) throw new Error(describeForeignRoot(name, root));
    const dir = path.dirname(filePath);
    return { kind: 'file', documents: [{ name, dir, text }], readImage: fsImageReader(ctx) };
}

function describeForeignRoot(name, root) {
    if (root === GENERIC_ROOT) {
        return `${name} 是 MarkFlow 通用 XML（generic profile，根元素 document），反向导入只受理国知局专利五书 XML（根元素 ${PATENT_ROOT}）`;
    }
    const found = root ? `根元素为 ${root}` : '未找到根元素，内容可能不是 XML';
    return `${name} 不是国知局专利五书 XML：${found}，应为 ${PATENT_ROOT}`;
}

// ============================================================
// 五书目录
// ============================================================

async function openDirectory(dirPath, ctx) {
    const candidates = await listDirectoryCandidates(dirPath, ctx.limits.MAX_XML_CANDIDATES);
    const documents = [];
    for (const candidate of candidates) {
        const document = await readDirectoryXml(dirPath, candidate, ctx);
        if (document) documents.push(document);
    }
    if (documents.length === 0) {
        throw new Error(`目录内未找到国知局专利五书 XML（根元素 ${PATENT_ROOT}）：只查看目录下的 *.xml 与 10000N/10000N.xml`);
    }
    return { kind: 'directory', documents: sortDocuments(documents), readImage: fsImageReader(ctx) };
}

// 候选的相对路径（正斜杠）：10000N/10000N.xml 在前，目录下直接的 *.xml 在后；点开头的隐藏文件不看
async function listDirectoryCandidates(dirPath, maxCandidates) {
    const coded = BOOK_CODES.map((code) => `${code}/${code}${XML_EXT}`);
    let entries = [];
    try {
        entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch (err) {
        throw new Error(`无法读取输入目录（${errText(err)}）`);
    }
    const direct = entries
        .filter((entry) => !entry.name.startsWith('.') && path.extname(entry.name).toLowerCase() === XML_EXT)
        .map((entry) => entry.name).sort(compareText);
    return [...coded, ...direct].slice(0, maxCandidates);
}

async function readDirectoryXml(dirPath, relative, { report, budget, limits }) {
    const { MAX_XML_BYTES } = limits;
    const abs = path.join(dirPath, ...relative.split('/'));
    const stat = await statOrNull(abs);
    if (!stat || !stat.isFile()) return null;
    const dir = path.dirname(abs);
    if (!(await isRealWithinDir(dirPath, abs))) {
        report.warn(`${relative} 是指向输入目录之外的链接，已忽略`);
        return null;
    }
    if (stat.size > MAX_XML_BYTES) {
        report.warn(`${relative} 超过 ${sizeLabel(MAX_XML_BYTES)} 上限，已忽略`);
        return null;
    }
    budget.take(stat.size);
    const text = decodeXml(await fsp.readFile(abs), relative, report);
    return sniffRootName(text.slice(0, SNIFF_BYTES)) === PATENT_ROOT ? { name: relative, dir, text } : null;
}

// 目录与单文件形态共用：图片只在 XML 所在目录里找，解开符号链接后仍须落在该目录之内
function fsImageReader({ report, budget, limits }) {
    const { MAX_IMAGE_BYTES } = limits;
    return async (dir, fileName) => {
        const abs = path.join(dir, fileName);
        const stat = await statOrNull(abs);
        if (!stat || !stat.isFile()) {
            report.warn(`图片 ${fileName} 不在其 XML 所在的目录里，已按缺图处理`);
            return null;
        }
        if (!(await isRealWithinDir(dir, abs))) {
            report.warn(`图片 ${fileName} 是指向 XML 所在目录之外的链接，已按缺图处理`);
            return null;
        }
        if (stat.size > MAX_IMAGE_BYTES) {
            report.warn(`图片 ${fileName} 超过 ${sizeLabel(MAX_IMAGE_BYTES)} 上限，已按缺图处理`);
            return null;
        }
        budget.take(stat.size);
        return fsp.readFile(abs);
    };
}

// ============================================================
// 案卷 zip
// ============================================================

async function openZip(zipPath, stat, ctx) {
    const { report } = ctx;
    const { MAX_ZIP_BYTES, MAX_XML_BYTES, MAX_XML_CANDIDATES } = ctx.limits;
    if (stat.size > MAX_ZIP_BYTES) throw new Error(`zip 文件超过 ${sizeLabel(MAX_ZIP_BYTES)} 上限，已拒绝导入`);
    let zip;
    try {
        zip = await JSZip.loadAsync(await fsp.readFile(zipPath));
    } catch (err) {
        throw new Error(`无法读取 zip（文件已损坏、已加密或不是 zip）：${errText(err)}`);
    }
    const entries = collectZipEntries(zip, ctx);
    const documents = [];
    const xmlNames = [...entries.keys()].filter((name) => path.posix.extname(name).toLowerCase() === XML_EXT).sort(compareText);
    if (xmlNames.length > MAX_XML_CANDIDATES) report.warn(`zip 内的 XML 超过 ${MAX_XML_CANDIDATES} 份，只查看前 ${MAX_XML_CANDIDATES} 份`);
    for (const name of xmlNames.slice(0, MAX_XML_CANDIDATES)) {
        const buffer = await readZipEntry(entries.get(name), MAX_XML_BYTES, name, ctx);
        if (!buffer) continue;
        const text = decodeXml(buffer, name, report);
        if (sniffRootName(text.slice(0, SNIFF_BYTES)) === PATENT_ROOT) documents.push({ name, dir: zipDirOf(name), text });
    }
    if (documents.length === 0) {
        throw new Error(`zip 内未找到国知局专利五书 XML（根元素 ${PATENT_ROOT}）；反向导入只受理专利案卷包`);
    }
    return { kind: 'zip', documents: sortDocuments(documents), readImage: zipImageReader(entries, ctx) };
}

const zipDirOf = (name) => {
    const dir = path.posix.dirname(name);
    return dir === '.' ? '' : `${dir}/`;
};

/**
 * 归一条目名 → 条目。条目数超限或出现不安全的条目名即抛错（整个 zip 拒绝）；目录条目、符号链接与杂项条目不收。
 * JSZip 3.8 起会在载入时自行化解条目名里的 ..，原名留在 unsafeOriginalName，故两者都要查。
 */
function collectZipEntries(zip, { report, limits }) {
    const { MAX_ZIP_ENTRIES } = limits;
    const all = Object.values(zip.files);
    if (all.length > MAX_ZIP_ENTRIES) throw new Error(`zip 条目数 ${all.length} 超过 ${MAX_ZIP_ENTRIES} 上限，已拒绝导入`);
    const entries = new Map();
    for (const entry of all) {
        const name = normalizeEntryName(entry.name);
        for (const candidate of [name, normalizeEntryName(entry.unsafeOriginalName || '')]) {
            if (isUnsafeEntryName(candidate)) throw new Error('zip 内含不安全的条目名（.. 片段、绝对路径或盘符），已拒绝导入');
        }
        if (entry.dir || name.split('/').some((segment) => NOISE_SEGMENT_RE.test(segment))) continue;
        if (isSymlinkEntry(entry)) {
            report.warn(`zip 条目 ${name} 是符号链接，已忽略`);
            continue;
        }
        if (!entries.has(name)) entries.set(name, entry);
    }
    return entries;
}

const normalizeEntryName = (name) => String(name == null ? '' : name).replace(/\\/g, '/');

function isUnsafeEntryName(name) {
    if (!name) return false;
    if (name.startsWith('/') || DRIVE_RE.test(name) || name.includes('\0')) return true;
    return name.split('/').includes('..');
}

const isSymlinkEntry = (entry) => Number.isInteger(entry.unixPermissions)
    && (entry.unixPermissions & MODE_TYPE_MASK) === MODE_SYMLINK;

/**
 * 限长解压：申报大小超限的提前拒绝；其余边解压边计数，超限即暂停数据流并放弃该条目。
 * 超限与解压失败都只让这一条目作废（返回 null 并记入 report），总量预算超限才整体抛错。
 */
async function readZipEntry(entry, limit, label, { report, budget }) {
    const declared = entry._data && Number.isFinite(entry._data.uncompressedSize) ? entry._data.uncompressedSize : 0;
    if (declared > limit) {
        report.warn(`zip 条目 ${label} 解压后超过 ${sizeLabel(limit)} 上限，已忽略`);
        return null;
    }
    let buffer;
    try {
        buffer = await inflateWithLimit(entry, limit);
    } catch (err) {
        report.warn(err instanceof EntryTooLargeError
            ? `zip 条目 ${label} 解压后超过 ${sizeLabel(limit)} 上限，已忽略`
            : `zip 条目 ${label} 解压失败，已忽略（${errText(err)}）`);
        return null;
    }
    budget.take(buffer.length);
    return buffer;
}

class EntryTooLargeError extends Error {}

function inflateWithLimit(entry, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        const stream = entry.internalStream('nodebuffer');
        stream.on('data', (chunk) => {
            total += chunk.length;
            if (total > limit) {
                stream.pause();
                reject(new EntryTooLargeError());
                return;
            }
            chunks.push(chunk);
        }).on('error', reject).on('end', () => resolve(Buffer.concat(chunks))).resume();
    });
}

// 图片按「XML 所在目录前缀 + 裸文件名」取条目；大小写不一致（Windows 上打的包）时退一步按小写匹配
function zipImageReader(entries, ctx) {
    const { report } = ctx;
    const byLowerName = new Map();
    for (const name of entries.keys()) if (!byLowerName.has(name.toLowerCase())) byLowerName.set(name.toLowerCase(), name);
    return async (dir, fileName) => {
        const wanted = `${dir}${fileName}`;
        const name = entries.has(wanted) ? wanted : byLowerName.get(wanted.toLowerCase());
        if (!name) {
            report.warn(`图片 ${fileName} 不在 zip 内与其 XML 同级的位置，已按缺图处理`);
            return null;
        }
        return readZipEntry(entries.get(name), ctx.limits.MAX_IMAGE_BYTES, name, ctx);
    };
}

// ============================================================
// 公用
// ============================================================

const sortDocuments = (documents) => [...documents].sort((a, b) => compareText(a.name, b.name));

/**
 * XML 字节 → 文本。BOM 优先（UTF-8 / UTF-16 LE / UTF-16 BE），其次取 XML 声明里的 encoding（GBK、GB2312 等由
 * TextDecoder 解码），都没有按 UTF-8。声明的编码不认识时按 UTF-8 继续并提示，不中断导入。
 */
function decodeXml(buffer, label, report) {
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) return buffer.toString('utf8', 3);
    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) return buffer.toString('utf16le', 2);
    if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
    const declared = XML_DECLARED_ENCODING_RE.exec(buffer.toString('latin1', 0, ENCODING_PROBE_BYTES));
    if (!declared || UTF8_LABEL_RE.test(declared[1])) return buffer.toString('utf8');
    try {
        return new TextDecoder(declared[1]).decode(buffer);
    } catch (err) {
        report.warn(`${label} 声明的编码 ${declared[1]} 无法识别，已按 UTF-8 读取`);
        return buffer.toString('utf8');
    }
}

module.exports = { openSource, decodeXml, isUnsafeEntryName, PATENT_ROOT, LIMITS };
