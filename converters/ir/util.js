/**
 * IR 层公共工具（全仓唯一一份）
 *
 * 只收纳与具体格式无关的纯函数与目录工具：
 *   - 名称处理：sanitizeFolderName / stripExt
 *   - 文本收集：collectText
 *   - 扩展名推断：getExtFromContentType / getExtFromUrl
 *   - HTML 清洗：stripHtml
 *   - 目录：ensureDir
 *
 * Turndown 工厂与 HTML 表格转换已迁往 converters/ir/turndown.js；
 * 产物落盘统一由 converters/output.js 负责。
 */
const path = require('path');
const fsp = require('fs').promises;

// 文件夹名最大长度（按 Unicode 码点计数，避免截断代理对）
const MAX_FOLDER_NAME_LENGTH = 100;
// 各操作系统均不允许出现在文件名中的字符
const ILLEGAL_FILENAME_CHARS_RE = /[\\/:*?"<>|]/g;
// 控制字符（含 NUL 与 DEL）直接剔除
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/g;
// 首尾的空白、点与下划线（前导点会生成隐藏目录，尾随点与空白在 Windows 上非法）
const EDGE_TRIM_RE = /^[\s._]+|[\s._]+$/g;

const EXT_BY_CONTENT_TYPE = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif',
    'image/bmp': '.bmp', 'image/svg+xml': '.svg', 'image/webp': '.webp', 'image/tiff': '.tiff',
    'image/x-emf': '.emf', 'image/x-wmf': '.wmf', 'image/emf': '.emf', 'image/wmf': '.wmf',
};
const DEFAULT_CONTENT_TYPE_EXT = '.png';
const KNOWN_URL_IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
const DEFAULT_URL_IMAGE_EXT = '.jpg';

// 把任意标题清洗为可安全落盘的文件夹名：非法字符替换为 "_"（保留分词边界，避免 "a/b" 与
// "ab" 撞名），空白折叠为单个空格，去首尾空白与点，超长按码点截断，空结果回退到 fallback。
function sanitizeFolderName(name, fallback = '未命名文档') {
    const cleaned = String(name == null ? '' : name)
        .replace(CONTROL_CHARS_RE, '')
        .replace(ILLEGAL_FILENAME_CHARS_RE, '_')
        .replace(/_+/g, '_')
        .replace(/\s+/g, ' ')
        .replace(EDGE_TRIM_RE, '');
    return Array.from(cleaned).slice(0, MAX_FOLDER_NAME_LENGTH).join('').replace(EDGE_TRIM_RE, '') || fallback;
}

// 去掉路径前缀与扩展名："/a/b/报告.docx" → "报告"
function stripExt(name) {
    if (!name) return '';
    const str = String(name);
    return path.basename(str, path.extname(str));
}

// 递归拼接 mdast 节点的纯文本：value 节点取 value，容器节点拼接子节点
function collectText(node) {
    if (!node || typeof node !== 'object') return '';
    if (node.value !== undefined && node.value !== null) return String(node.value);
    return Array.isArray(node.children) ? node.children.map(collectText).join('') : '';
}

// "image/jpeg; charset=binary" → ".jpg"；未知类型回退 ".png"
function getExtFromContentType(contentType) {
    const mime = String(contentType == null ? '' : contentType).split(';')[0].trim().toLowerCase();
    return EXT_BY_CONTENT_TYPE[mime] || DEFAULT_CONTENT_TYPE_EXT;
}

// 从 URL 路径部分取图片扩展名；不可识别或 URL 非法时回退 ".jpg"
function getExtFromUrl(url) {
    try {
        const ext = path.extname(new URL(String(url)).pathname).toLowerCase();
        if (KNOWN_URL_IMAGE_EXTS.includes(ext)) return ext;
    } catch (err) { /* URL 非法：走默认扩展名 */ }
    return DEFAULT_URL_IMAGE_EXT;
}

// 递归创建目录（已存在时静默），返回传入的目录路径
async function ensureDir(dir) {
    if (typeof dir !== 'string' || !dir) throw new Error('ensureDir 需要非空的目录路径');
    await fsp.mkdir(dir, { recursive: true });
    return dir;
}

// 去除 HTML 标签（连同 script/style 内容与注释），并还原常见实体
function stripHtml(value) {
    return String(value || '')
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .trim();
}

module.exports = {
    stripHtml, sanitizeFolderName, stripExt, collectText,
    getExtFromContentType, getExtFromUrl, ensureDir,
};
