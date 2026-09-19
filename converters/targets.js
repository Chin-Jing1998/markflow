/**
 * 输入识别、归类与目标裁决（全仓单一来源）
 *
 * 本模块是「什么输入能转成什么目标」这一规则的唯一定义处：转换调度器
 * （converters/index.js）与两个入口（CLI、MCP）都从这里取用，不再各写一份。
 * 为此本模块不依赖 index.js，保持为叶子模块。
 *
 * detectInputType(pathOrUrl)          → 输入类型，无法识别返回 null
 * resolveUserPath(p, env?)            → 本地路径写法归一：前导 ~ 展开为主目录、file:// 地址转为本地路径，其余原样返回
 * classifyInput(raw, cwd, hints?)     → { input: { path } | { url }, type }；本地输入先经 resolveUserPath，
 *                                       相对路径再按 cwd 解析为绝对路径。hints.bundleDirs（绝对路径的数组或 Set）
 *                                       列出已由调用方判定为「专利五书目录」的输入（判定在 converters/scan.js，
 *                                       要读盘，故不在本模块内做）：命中者不看扩展名，类型为 BUNDLE_DIR_TYPE
 * resolveTarget(inputType, requested) → 目标格式；未指定时按输入类型取默认值，不合法时抛中文错误
 * assertTargetAllowed(target, type)   → 不合法即抛中文错误，供 convert 复用同一套判定与措辞
 * getTargetRule(target)               → TARGET_RULES 中的规则项（含 layout / ext），未知目标抛中文错误
 * listTargets({ pdfBackend })         → 能力矩阵，由 TARGET_RULES 派生：pdf 目标仅在 PDF 后端可用时列出
 *
 * 目标矩阵（TARGET_RULES）：
 *   bundle  office、url         folder  {name}/{name}.md + {name}.json + images/
 *   docx    markup              single  {name}.docx（markup 含 Markdown 与专利五书 XML：.xml、案卷 .zip、五书目录）
 *   pdf     markup              single  {name}.pdf
 *   html    office、markup、url folder  {name}/{name}.html + images/
 *   xml     office、markup、url folder  {name}/{name}.xml + images/（patent profile 另有五书与 zip）
 *
 * 本模块只做纯逻辑判断，不触碰文件系统：存在性由调用方（CLI 预检）或 convert 负责。
 */
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

// 扩展名 → 输入类型；旧二进制格式（.doc/.xls/.ppt）自 v3 起不再受理。
// .xml 与 .zip 只受理国知局专利五书（单书 XML、案卷包），由 parsers/xml 按内容判定，其它 XML / zip 会得到中文错误
const EXT_TO_TYPE = Object.freeze({
    '.docx': 'docx', '.xlsx': 'xlsx', '.pptx': 'pptx', '.pdf': 'pdf', '.md': 'md', '.markdown': 'md',
    '.xml': 'xml', '.zip': 'zip',
});
const SUPPORTED_EXTENSIONS = Object.freeze(Object.keys(EXT_TO_TYPE));
// 只在显式给出时受理、目录展开与桌面端转档入口的默认扫描都不收的扩展名：文档目录里的 .xml 与 .zip 绝大多数
// 与专利无关，随目录一并转换只会得到一串失败项（目标为 bundle 时还会让整批被拒）。成套的五书目录另由
// converters/scan.js 的目录签名整体识别为一项输入
const EXPLICIT_ONLY_EXTENSIONS = Object.freeze(['.xml', '.zip']);
const DIRECTORY_SCAN_EXTENSIONS = Object.freeze(SUPPORTED_EXTENSIONS.filter((ext) => !EXPLICIT_ONLY_EXTENSIONS.includes(ext)));
// 专利五书目录作为单项输入时的类型：与单个五书 XML 同一个解析器
const BUNDLE_DIR_TYPE = 'xml';

// 输入类型 → 输入类别（决定可选目标）；键序即 listTargets().inputs 的键序。
// 键必须与 detectInputType 的返回值一一对应：.markdown 已归入 md，故此处没有 markdown 键
const INPUT_CLASS = Object.freeze({
    docx: 'office', xlsx: 'office', pptx: 'office', pdf: 'office', md: 'markup', xml: 'markup', zip: 'markup', url: 'url',
});
// 输入类别的固定顺序，即 listTargets() 中 office / markup / url 三个键的顺序
const INPUT_CLASSES = Object.freeze(['office', 'markup', 'url']);
// 输入类别 → 未指定 --to 时的默认目标
const DEFAULT_TARGET_BY_CLASS = Object.freeze({ office: 'bundle', markup: 'docx', url: 'bundle' });
// 目标 → { 接受的输入类别, 落盘布局, 主产物扩展名, 拒绝时的提示 }；键序即错误提示与 listTargets 的罗列顺序
const TARGET_RULES = Object.freeze({
    bundle: Object.freeze({ classes: Object.freeze(['office', 'url']), layout: 'folder', ext: 'md', hint: 'bundle 仅接受 Office、PDF 文件与网页输入' }),
    docx: Object.freeze({ classes: Object.freeze(['markup']), layout: 'single', ext: 'docx', hint: 'docx 仅接受 Markdown 与专利五书 XML（.xml、案卷 .zip、五书目录）输入' }),
    pdf: Object.freeze({ classes: Object.freeze(['markup']), layout: 'single', ext: 'pdf', hint: 'pdf 仅接受 Markdown 与专利五书 XML（.xml、案卷 .zip、五书目录）输入' }),
    html: Object.freeze({ classes: Object.freeze(['office', 'markup', 'url']), layout: 'folder', ext: 'html', hint: 'html 接受全部输入' }),
    xml: Object.freeze({ classes: Object.freeze(['office', 'markup', 'url']), layout: 'folder', ext: 'xml', hint: 'xml 接受全部输入' }),
});
const TARGETS = Object.freeze(Object.keys(TARGET_RULES));
// 需要 PDF 后端才可用的目标
const PDF_BACKEND_TARGETS = Object.freeze(['pdf']);
// 输入类型 → 默认目标，由上面两张表派生，不另行维护
const DEFAULT_TARGETS = Object.freeze(Object.fromEntries(
    Object.entries(INPUT_CLASS).map(([type, cls]) => [type, DEFAULT_TARGET_BY_CLASS[cls]]),
));

const REMOTE_URL_RE = /^https?:\/\//i;
// 本地文件地址；scheme 不分大小写（new URL 会将其归一为小写）
const FILE_URL_RE = /^file:\/\//i;

// 'docx'|'xlsx'|'pptx'|'pdf'|'md'|'xml'|'zip'|'url'|null
function detectInputType(pathOrUrl) {
    if (typeof pathOrUrl !== 'string' || !pathOrUrl.trim()) return null;
    const value = pathOrUrl.trim();
    if (REMOTE_URL_RE.test(value)) return 'url';
    return EXT_TO_TYPE[path.extname(value).toLowerCase()] || null;
}

function getTargetRule(target) {
    const rule = TARGET_RULES[target];
    if (!rule) throw new Error(`不支持的目标格式：${target}（可选：${TARGETS.join('、')}）`);
    return rule;
}

function assertTargetAllowed(target, inputType) {
    const rule = getTargetRule(target);
    if (!rule.classes.includes(INPUT_CLASS[inputType])) {
        throw new Error(`目标 ${target} 不接受 ${inputType} 输入：${rule.hint}`);
    }
}

function resolveTarget(inputType, requested) {
    const fallback = DEFAULT_TARGETS[inputType];
    if (!fallback) throw new Error(`不支持的输入类型：${inputType || '(空)'}`);
    if (requested === undefined || requested === null || requested === '') return fallback;
    assertTargetAllowed(requested, inputType);
    return requested;
}

/**
 * 用户给出的本地路径写法归一，供各入口的本地输入、CLI 的 --out 与 MCP 的 outputDir 共用：
 *   - '~' 与 '~/…' 展开为主目录；'~\…' 仅在 Windows 下展开（其它平台上反斜杠是合法的文件名字符）；
 *   - 'file://…'（scheme 不分大小写）经 url.fileURLToPath 转为本地路径，百分号编码随之解码，Windows 下识别盘符与 UNC；
 *   - 其余原样返回：不裁剪空白、不解析相对路径（由调用方 path.resolve）、'~user' 形式不展开，非字符串值原样返回。
 * 第二参数只供测试注入：{ homedir = os.homedir(), platform = process.platform }。
 * file:// 地址无法转换（主机名不是本机、路径含编码后的分隔符等）时抛中文错误「无法识别的 file:// 地址：…（原因）」。
 */
function resolveUserPath(p, { homedir, platform = process.platform } = {}) {
    if (typeof p !== 'string') return p;
    const windows = platform === 'win32';
    if (FILE_URL_RE.test(p)) return fileUrlToLocalPath(p, windows);
    const expandsHome = p === '~' || p.startsWith('~/') || (windows && p.startsWith('~\\'));
    if (!expandsHome) return p;
    const home = typeof homedir === 'string' && homedir ? homedir : os.homedir();
    return (windows ? path.win32 : path.posix).join(home, p.slice(2));
}

function fileUrlToLocalPath(value, windows) {
    try {
        return fileURLToPath(value, { windows });
    } catch (err) {
        throw new Error(`无法识别的 file:// 地址：${value}（${err && err.message ? err.message : String(err)}）`);
    }
}

function classifyInput(raw, cwd, { bundleDirs } = {}) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) throw new Error('输入不能为空');
    if (REMOTE_URL_RE.test(value)) return { input: { url: value }, type: 'url' };
    const local = resolveUserPath(value);
    const abs = path.resolve(cwd || process.cwd(), local);
    if (isListed(bundleDirs, abs)) return { input: { path: abs }, type: BUNDLE_DIR_TYPE };
    const type = detectInputType(local);
    if (!type) {
        throw new Error(`不支持的输入格式：${value}（支持 ${SUPPORTED_EXTENSIONS.join(' ')}、专利五书目录与 http(s) 网址）`);
    }
    return { input: { path: abs }, type };
}

const isListed = (list, value) => (list instanceof Set ? list.has(value) : Array.isArray(list) && list.includes(value));

/**
 * 能力矩阵：按 TARGET_RULES 派生各输入类别可选的目标。
 * 调用方负责探测 PDF 后端并把探测结果传入；pdfBackend 为假值时不列出 pdf 目标。
 * @returns {{ office: string[], markup: string[], url: string[], inputs: object, capabilities: { pdfBackend } }}
 */
function listTargets({ pdfBackend = null } = {}) {
    const targetsFor = (cls) => TARGETS.filter((target) =>
        TARGET_RULES[target].classes.includes(cls) && (pdfBackend || !PDF_BACKEND_TARGETS.includes(target)));
    return {
        ...Object.fromEntries(INPUT_CLASSES.map((cls) => [cls, targetsFor(cls)])),
        inputs: { ...INPUT_CLASS },
        capabilities: { pdfBackend: pdfBackend || null },
    };
}

module.exports = {
    detectInputType, resolveUserPath, classifyInput, resolveTarget, assertTargetAllowed, getTargetRule, listTargets,
    SUPPORTED_EXTENSIONS, EXPLICIT_ONLY_EXTENSIONS, DIRECTORY_SCAN_EXTENSIONS, BUNDLE_DIR_TYPE,
    INPUT_CLASS, INPUT_CLASSES, DEFAULT_TARGETS, TARGET_RULES, TARGETS, REMOTE_URL_RE,
};
