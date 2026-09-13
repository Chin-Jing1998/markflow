/**
 * MinerU 错误中文化
 *
 * MinerU Open API 与其官方 SDK 抛出的错误只有英文 msg 与数字/字母错误码（形如 `[A0202] token invalid`），
 * 直接透出对用户没有指导意义。本模块把已知错误码映射为「问题 + 处置建议」的中文文案，未知错误则
 * 保留原始信息的截断摘要。
 *
 *   describeMineruError(err, { token?, tokenSource? }) → string
 *
 * 四条硬约束：
 *   1) 绝不回显令牌 —— 输出前一律经 scrubSecrets 抹掉调用方给出的 token 与任何 `Bearer xxx` 片段；
 *   2) 鉴权失败必须点明令牌来源（env:MINERU_TOKEN / env:MINERU_API_TOKEN / config / mineru-cli / options）——
 *      本机可能同时存在多份令牌，不说来源就无从判断该去改哪一份（尤其是 ~/.mineru/config.yaml 里的陈旧令牌）；
 *   3) 超时错误必须带上 batch_id，用户才能到 MinerU 控制台查任务；
 *   4) 额度与页数一类「换条路就能继续」的错误必须给出具体命令（--pdf-backend local / pageRanges）。
 *
 * 错误码来源：MinerU Open API v4 文档与 mineru-open-sdk 的 CODE_TO_ERROR 表。
 */

/** 自造错误使用的码：超时与 zip 体积超限，不与服务端错误码冲突 */
const TIMEOUT_CODE = 'MINERU_TIMEOUT';
const ZIP_TOO_LARGE_CODE = 'MINERU_ZIP_TOO_LARGE';

/** 鉴权失败的错误码：文案含令牌来源，须动态拼装，不进静态表 */
const AUTH_CODES = new Set(['A0202', 'A0211']);
/** config.getMineruToken 的 source → 面向用户的名字 */
const SOURCE_ALIASES = Object.freeze({ explicit: 'options' });
/** 需要额外点明读取位置的来源 */
const SOURCE_NOTES = Object.freeze({ 'mineru-cli': '，读取自 ~/.mineru/config.yaml' });
const UNKNOWN_SOURCE = '未知';

/** 已知错误码 → 中文文案 */
const CODE_MESSAGES = Object.freeze({
    '-60005': '文件体积超过 MinerU 单文件 200 MB 上限：请先拆分 PDF，或改用 --pdf-backend local。',
    '-60006': '文档页数超过 MinerU 单次解析上限：请用 mineru.pageRanges（如 1-100）分批解析，或改用 --pdf-backend local。',
    '-60010': 'MinerU 云端解析失败：该文档可能已加密、损坏或版面异常；可换 mineru.model（pipeline / vlm）重试，或改用 --pdf-backend local。',
    '-60012': 'MinerU 任务不存在或已过期：请重新发起转换。',
    '-60013': 'MinerU 拒绝了该任务：请确认文件格式受支持。',
    '-60018': 'MinerU 额度已耗尽：请等待额度重置或升级套餐，也可改用 --pdf-backend local 走本地文本层解析。',
    '-60019': 'MinerU 额度已耗尽：请等待额度重置或升级套餐，也可改用 --pdf-backend local 走本地文本层解析。',
    '-500': 'MinerU 接口参数非法：请检查 mineru 选项（model / language / pageRanges）取值。',
    '-10002': 'MinerU 接口参数非法：请检查 mineru 选项（model / language / pageRanges）取值。',
    [ZIP_TOO_LARGE_CODE]: 'MinerU 结果包超过 1 GB 上限：请用 mineru.pageRanges（如 1-100）分批解析，或改用 --pdf-backend local。',
});

/** 网络层错误码（Node fetch 的 cause.code） */
const NETWORK_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
const NETWORK_MESSAGE = 'MinerU 接口网络请求失败：请检查网络连通性与代理设置，或改用 --pdf-backend local。';

/** 摘要长度上限：错误信息只用于给人看，过长的服务端回包没有阅读价值 */
const DETAIL_LIMIT = 200;
const SECRET_PLACEHOLDER = '（已隐藏）';
// 形如 Bearer eyJhbG... 的授权片段；防御性兜底，正常路径下错误信息里不该出现它
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
// 官方 SDK 的错误信息前缀：[A0202] xxx (trace: yyy)
const SDK_CODE_RE = /^\[([A-Za-z0-9_-]+)\]/;
// 实测：令牌失效时服务端回的是 HTTP 401 而非 code 非 0 的 200 响应，业务码藏在响应体的 msgCode 里
const BODY_CODE_RE = /"(?:msgCode|code|err_code)"\s*:\s*"?(-?[A-Za-z0-9_]+)"?/;
const HTTP_CODE_RE = /^HTTP_(\d{3})$/;
// 自造 HTTP 错误码里代表鉴权失败的状态
const HTTP_AUTH_CODES = new Set(['HTTP_401', 'HTTP_403']);

/**
 * @param {unknown} err 任意错误值
 * @param {{ token?: string|null }} [opts] token 给出时从输出中抹除
 * @returns {string} 中文错误文案（单行，不含令牌）
 */
function describeMineruError(err, opts = {}) {
    const token = typeof opts.token === 'string' ? opts.token : '';
    const code = extractCode(err);
    const detail = scrubSecrets(messageOf(err), token);

    if (code === TIMEOUT_CODE) {
        const batchId = err && typeof err.batchId === 'string' ? err.batchId : '';
        const tail = batchId ? `（batch_id: ${batchId}）` : '';
        const limit = err && Number.isFinite(err.timeoutSec) ? `设定的 ${err.timeoutSec} 秒` : '设定时长';
        return `MinerU 解析超时${tail}：任务已提交但未在${limit}内完成，可到 MinerU 控制台按 batch_id 查看，或调大 mineru.timeoutSec 后重试。`;
    }
    if (isAuthCode(code)) return authMessage(opts.tokenSource);
    if (Object.prototype.hasOwnProperty.call(CODE_MESSAGES, code)) return CODE_MESSAGES[code];
    if (isNetworkError(err)) return NETWORK_MESSAGE;

    const suffix = code ? `[${code}] ` : '';
    return `MinerU 接口调用失败：${suffix}${truncate(detail) || '未知错误'}`;
}

/** 鉴权失败文案：点名令牌来源，但绝不带出令牌本身 */
function authMessage(source) {
    const raw = typeof source === 'string' ? source.trim() : '';
    const name = SOURCE_ALIASES[raw] || raw || UNKNOWN_SOURCE;
    const note = SOURCE_NOTES[raw] || '';
    return `MinerU 令牌无效或已过期（来源：${name}${note}），请用 markflow config set mineru-token 更新或设置环境变量 MINERU_API_TOKEN`;
}

/**
 * 取错误码，优先级：自造错误 / SDK 错误的业务码 → 响应体里的 msgCode / code → HTTP 状态码。
 * 业务码之所以要从响应体里捞：SDK 的 ApiClient 对非 2xx 响应只抛 `HTTP 401: ... — <原始报文>`，
 * 不走它自己的错误码映射，业务码只剩报文里那一处。
 */
function extractCode(err) {
    const direct = directCode(err);
    if (direct && !HTTP_CODE_RE.test(direct)) return direct;
    const body = BODY_CODE_RE.exec(messageOf(err));
    if (body && body[1] && body[1] !== '0') return body[1];
    if (direct) return direct;
    const status = /\bHTTP (\d{3})\b/.exec(messageOf(err));
    return status ? `HTTP_${status[1]}` : '';
}

function directCode(err) {
    if (!err || typeof err !== 'object') return '';
    if (typeof err.code === 'string' && err.code) return err.code;
    if (typeof err.code === 'number') return String(err.code);
    const matched = SDK_CODE_RE.exec(messageOf(err));
    return matched ? matched[1] : '';
}

/** 业务码或 HTTP 状态码指向鉴权失败 */
const isAuthCode = (code) => AUTH_CODES.has(code) || HTTP_AUTH_CODES.has(code);

function isNetworkError(err) {
    if (!err || typeof err !== 'object') return false;
    if (typeof err.code === 'string' && NETWORK_CODES.has(err.code)) return true;
    const cause = err.cause;
    if (cause && typeof cause === 'object' && typeof cause.code === 'string' && NETWORK_CODES.has(cause.code)) return true;
    return err.name === 'TypeError' && /fetch failed/i.test(messageOf(err));
}

const messageOf = (err) => (err && typeof err === 'object' && typeof err.message === 'string' ? err.message : String(err == null ? '' : err));

/** 抹除令牌本体与 Bearer 片段；token 为空时只做后者 */
function scrubSecrets(text, token) {
    let out = String(text == null ? '' : text);
    if (token) out = out.split(token).join(SECRET_PLACEHOLDER);
    return out.replace(BEARER_RE, `Bearer ${SECRET_PLACEHOLDER}`);
}

const truncate = (text) => (text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT - 3)}...` : text);

module.exports = { describeMineruError, scrubSecrets, CODE_MESSAGES, AUTH_CODES, TIMEOUT_CODE, ZIP_TOO_LARGE_CODE };
