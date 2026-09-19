/**
 * Word 加载项回环服务的请求守卫（纯逻辑、无副作用，可在普通 Node 中单测）
 *
 * 威胁模型：防的是「浏览器里的网页」与误用——跨站请求伪造（CSRF）、DNS 重绑定、跨源读取令牌或结果。
 * 以当前用户身份运行的本机恶意进程不在防护范围内：它本就能直接读写该用户的文件，也能像任务窗格一样
 * 取到页面里的令牌，回环端口上再加任何校验都挡不住它。
 *
 * createToken()                        → 32 字节随机令牌（base64url，43 字符）；只存内存，每次服务启动重新生成
 * tokenMatches(expected, actual)       → 恒定时间比较：两侧先取 SHA-256 摘要再 timingSafeEqual，
 *                                        长度不同也走完整比较，不因长度提前返回；expected 为空一律不通过
 * isHostAllowed(hostHeader, port)      → 只认 localhost:<port> 与 127.0.0.1:<port>（防 DNS 重绑定：
 *                                        恶意域名解析到回环地址时，浏览器带来的 Host 是那个域名）
 * isOriginAllowed(originHeader, port)  → 头缺席放行（同源 GET 与页面导航不带 Origin）；
 *                                        出现则必须严格等于 http://localhost:<port> 或 http://127.0.0.1:<port>，'null' 也拒绝
 * checkRequest({ method, headers, port, token, needsToken }) → null（放行）| { status, code, message }
 *   判定顺序固定：Host（403 bad-host）→ Origin（403 bad-origin）
 *                → 非 GET 缺自定义头（403 missing-client-header）→ 令牌（401 unauthorized）。
 *   自定义头的作用：带自定义头的跨源请求必先发 CORS 预检，而本服务从不回任何 CORS 头，预检必然失败，
 *   表单提交与 no-cors fetch 这类「简单请求」也就到不了任何写操作。
 * decodeHeaderValue(raw, { name, maxLength }) → 百分号解码后的字符串；头缺席回 ''；
 *   重复的头、畸形编码、超长或含控制字符一律抛 GuardError（status 400）
 * GuardError                           → 带 status / code 的 Error，服务层据此回包
 */
const crypto = require('crypto');

const TOKEN_BYTES = 32;
const TOKEN_HEADER = 'x-markflow-token';
const CLIENT_HEADER = 'x-markflow-client';
const CLIENT_HEADER_VALUE = 'word-taskpane';
const ALLOWED_HOSTNAMES = Object.freeze(['localhost', '127.0.0.1']);
const SAFE_METHODS = Object.freeze(['GET']);
// 控制字符（含 NUL、换行与 DEL）：出现在文件名或路径里只可能是畸形输入
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

class GuardError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'GuardError';
        this.status = status;
        this.code = code;
    }
}

function createToken() {
    return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

const digest = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : '').digest();

function tokenMatches(expected, actual) {
    const enabled = typeof expected === 'string' && expected !== '';
    const same = crypto.timingSafeEqual(digest(expected), digest(actual));
    return enabled && typeof actual === 'string' && same;
}

function isHostAllowed(hostHeader, port) {
    if (typeof hostHeader !== 'string') return false;
    return ALLOWED_HOSTNAMES.some((name) => hostHeader === `${name}:${port}`);
}

function isOriginAllowed(originHeader, port) {
    if (originHeader === undefined) return true;
    if (typeof originHeader !== 'string') return false;
    return ALLOWED_HOSTNAMES.some((name) => originHeader === `http://${name}:${port}`);
}

const deny = (status, code, message) => ({ status, code, message });

function checkRequest({ method, headers, port, token, needsToken } = {}) {
    const safeHeaders = headers && typeof headers === 'object' ? headers : {};
    if (!isHostAllowed(safeHeaders.host, port)) {
        return deny(403, 'bad-host', 'Host 头必须是 localhost 或 127.0.0.1 加本服务端口');
    }
    if (!isOriginAllowed(safeHeaders.origin, port)) {
        return deny(403, 'bad-origin', '请求来源（Origin）不是本服务自身，已拒绝');
    }
    if (!SAFE_METHODS.includes(method) && safeHeaders[CLIENT_HEADER] !== CLIENT_HEADER_VALUE) {
        return deny(403, 'missing-client-header', '写操作缺少必需的自定义请求头，已拒绝');
    }
    if (needsToken && !tokenMatches(token, safeHeaders[TOKEN_HEADER])) {
        return deny(401, 'unauthorized', '令牌缺失或已失效，请关闭后重新打开任务窗格');
    }
    return null;
}

function decodeHeaderValue(raw, { name = '请求头', maxLength = 4096 } = {}) {
    if (raw === undefined || raw === '') return '';
    if (typeof raw !== 'string') throw new GuardError(400, 'bad-header', `${name} 重复出现`);
    let decoded;
    try {
        decoded = decodeURIComponent(raw);
    } catch (err) {
        throw new GuardError(400, 'bad-header', `${name} 不是合法的百分号编码`);
    }
    if (decoded.length > maxLength) throw new GuardError(400, 'bad-header', `${name} 过长（上限 ${maxLength} 字符）`);
    if (CONTROL_CHARS_RE.test(decoded)) throw new GuardError(400, 'bad-header', `${name} 含有控制字符`);
    return decoded;
}

module.exports = {
    createToken, tokenMatches, isHostAllowed, isOriginAllowed, checkRequest, decodeHeaderValue, GuardError,
    TOKEN_HEADER, CLIENT_HEADER, CLIENT_HEADER_VALUE, TOKEN_BYTES,
};
