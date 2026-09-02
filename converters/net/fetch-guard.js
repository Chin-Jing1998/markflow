/**
 * 受控网络访问：SSRF 守卫 + 限长限时抓取
 *
 * 全部基于 Node 内置 fetch（undici），不依赖 axios。
 *   - assertPublicUrl：仅放行 http/https；主机名解析出的所有地址均不得落入内网/保留段
 *   - fetchText / fetchBinary：手动逐跳跟随重定向（最多 5 跳，每跳重新守卫）、
 *     AbortController 超时、流式计数限长、按 charset 解码文本
 *   - _setLookup：测试注入 DNS 解析结果
 *
 * 所有错误信息为简体中文。
 */
const dns = require('dns');
const net = require('net');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_TEXT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_BINARY_MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
// 嗅探 <meta charset> 只看开头这一段
const CHARSET_SNIFF_BYTES = 2048;
const DEFAULT_CHARSET = 'utf-8';

const TEXT_HEADERS = {
    'User-Agent': DEFAULT_USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const BINARY_HEADERS = {
    'User-Agent': DEFAULT_USER_AGENT,
    'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
};

// IPv4 内网/保留段：[网段起点, 前缀长度]
const PRIVATE_IPV4_CIDRS = [
    ['0.0.0.0', 8],        // 本网络
    ['10.0.0.0', 8],       // 私网 A
    ['100.64.0.0', 10],    // 运营商级 NAT
    ['127.0.0.0', 8],      // 环回
    ['169.254.0.0', 16],   // 链路本地（含云元数据 169.254.169.254）
    ['172.16.0.0', 12],    // 私网 B
    ['192.168.0.0', 16],   // 私网 C
];

// ============================================================
// DNS 解析（可注入）
// ============================================================

const defaultLookup = (host, options) => dns.promises.lookup(host, options);
let lookupImpl = defaultLookup;

/** 测试钩子：注入 (host, options) => Promise<Array<{address, family}>>；传入非函数则恢复默认 */
function _setLookup(fn) {
    lookupImpl = typeof fn === 'function' ? fn : defaultLookup;
}

// ============================================================
// 地址判定
// ============================================================

function parseIPv4(address) {
    if (!net.isIPv4(address)) return null;
    return address.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

const PRIVATE_IPV4_RANGES = PRIVATE_IPV4_CIDRS.map(([base, bits]) => ({
    base: parseIPv4(base),
    mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0,
}));

function isPrivateIPv4Int(value) {
    return PRIVATE_IPV4_RANGES.some(({ base, mask }) => ((value & mask) >>> 0) === base);
}

/** 展开 IPv6 为 8 个 16 位整数；支持 :: 压缩、嵌入 IPv4 尾段与 zone id；非法返回 null */
function parseIPv6(address) {
    let text = String(address).split('%')[0].toLowerCase();

    const embedded = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
    if (embedded) {
        const v4 = parseIPv4(embedded[2]);
        if (v4 === null) return null;
        text = `${embedded[1]}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
    }

    const halves = text.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - head.length - tail.length;
    if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;

    const groups = [...head, ...Array(missing).fill('0'), ...tail];
    if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups.map((group) => parseInt(group, 16));
}

function isPrivateIPv6Groups(groups) {
    const leadingZero = (count) => groups.slice(0, count).every((g) => g === 0);

    if (leadingZero(8)) return true;                                   // :: 未指定地址
    if (leadingZero(7) && groups[7] === 1) return true;                // ::1 环回
    if ((groups[0] & 0xfe00) === 0xfc00) return true;                  // fc00::/7 ULA
    if ((groups[0] & 0xffc0) === 0xfe80) return true;                  // fe80::/10 链路本地
    if (leadingZero(5) && (groups[5] === 0xffff || groups[5] === 0)) { // ::ffff:a.b.c.d 映射 / ::a.b.c.d 兼容
        return isPrivateIPv4Int(((groups[6] << 16) | groups[7]) >>> 0);
    }
    return false;
}

/** 地址是否属于内网/保留段；无法识别的地址一律按内网处理（失败封闭） */
function isPrivateAddress(address) {
    const text = String(address || '').replace(/^\[|\]$/g, '');
    const v4 = parseIPv4(text);
    if (v4 !== null) return isPrivateIPv4Int(v4);
    const v6 = net.isIPv6(text) ? parseIPv6(text) : null;
    if (v6) return isPrivateIPv6Groups(v6);
    return true;
}

// ============================================================
// URL 守卫
// ============================================================

function parseHttpUrl(url) {
    let parsed;
    try {
        parsed = new URL(String(url));
    } catch (err) {
        throw new Error(`URL 格式非法: ${String(url)}`);
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(`仅允许 http/https 协议，实际为 ${parsed.protocol.replace(/:$/, '')}: ${parsed.href}`);
    }
    return parsed;
}

function normalizeHostname(hostname) {
    return String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
}

async function resolveAddresses(host) {
    let records;
    try {
        records = await lookupImpl(host, { all: true });
    } catch (err) {
        throw new Error(`域名解析失败: ${host}（${(err && (err.code || err.message)) || String(err)}）`);
    }
    const list = Array.isArray(records) ? records : [records];
    return list
        .map((record) => (typeof record === 'string' ? record : record && record.address))
        .filter(Boolean);
}

/**
 * 校验 URL 可安全访问。
 * @param {string|URL} url
 * @param {{ allowPrivateNetwork?: boolean }} options allowPrivateNetwork 为 true 时跳过主机与地址检查（仅测试使用）
 * @returns {Promise<URL>}
 */
async function assertPublicUrl(url, { allowPrivateNetwork = false } = {}) {
    const parsed = parseHttpUrl(url);
    if (allowPrivateNetwork) return parsed;

    const host = normalizeHostname(parsed.hostname);
    if (!host) throw new Error(`URL 缺少主机名: ${parsed.href}`);
    if (host === 'localhost' || host.endsWith('.localhost')) {
        throw new Error(`不允许访问本机地址: ${host}`);
    }

    const addresses = await resolveAddresses(host);
    if (addresses.length === 0) throw new Error(`域名未解析到任何地址: ${host}`);
    const blocked = addresses.find(isPrivateAddress);
    if (blocked) {
        throw new Error(`不允许访问内网或保留地址: ${host}（解析为 ${blocked}）`);
    }
    return parsed;
}

// ============================================================
// 抓取内核
// ============================================================

async function withTimeout(timeoutMs, task) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await task(controller.signal);
    } catch (err) {
        if (controller.signal.aborted) throw new Error(`请求超时（${timeoutMs}ms）`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function rawFetch(target, headers, signal) {
    try {
        return await fetch(target.href, { method: 'GET', headers, redirect: 'manual', signal });
    } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        const cause = err && err.cause;
        const detail = (cause && (cause.code || cause.message)) || (err && err.message) || String(err);
        throw new Error(`请求失败: ${target.href}（${detail}）`);
    }
}

async function discardBody(response) {
    if (!response.body) return;
    try {
        await response.body.cancel();
    } catch (err) {
        // 丢弃响应体失败不影响主流程
    }
}

/** 逐跳跟随重定向，每一跳都重新过守卫 */
async function guardedFetch(url, { headers, allowPrivateNetwork, signal }) {
    let current = await assertPublicUrl(url, { allowPrivateNetwork });

    for (let hop = 0; ; hop += 1) {
        const response = await rawFetch(current, headers, signal);
        if (!REDIRECT_STATUSES.has(response.status)) {
            return { response, finalUrl: current.href };
        }

        const location = response.headers.get('location');
        await discardBody(response);
        if (!location) {
            throw new Error(`重定向缺少 Location 头（HTTP ${response.status}）: ${current.href}`);
        }
        if (hop >= MAX_REDIRECTS) {
            throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次: ${String(url)}`);
        }

        let next;
        try {
            next = new URL(location, current);
        } catch (err) {
            throw new Error(`重定向目标非法: ${location}`);
        }
        current = await assertPublicUrl(next, { allowPrivateNetwork });
    }
}

async function assertOk(response, url) {
    if (response.ok) return;
    await discardBody(response);
    const statusText = response.statusText ? ` ${response.statusText}` : '';
    throw new Error(`请求返回 HTTP ${response.status}${statusText}: ${url}`);
}

function tooLargeError(received, maxBytes, url) {
    return new Error(`响应体超过上限 ${maxBytes} 字节（已收到 ${received} 字节）: ${url}`);
}

/** 流式读取响应体并计数，超过 maxBytes 立即中止 */
async function readBodyLimited(response, maxBytes, url) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        await discardBody(response);
        throw tooLargeError(declared, maxBytes, url);
    }
    if (!response.body) return Buffer.alloc(0);

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw tooLargeError(total, maxBytes, url);
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
}

function buildHeaders(defaults, extra) {
    return { ...defaults, ...(extra || {}) };
}

// ============================================================
// 文本解码
// ============================================================

function charsetFromContentType(contentType) {
    const matched = /charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(String(contentType || ''));
    return matched ? matched[1] : null;
}

function sniffMetaCharset(buffer) {
    const head = buffer.subarray(0, CHARSET_SNIFF_BYTES).toString('latin1');
    const matched = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
    return matched ? matched[1] : null;
}

function decodeWith(label, buffer) {
    try {
        return new TextDecoder(label).decode(buffer);
    } catch (err) {
        return null;
    }
}

function decodeText(buffer, contentType) {
    const label = charsetFromContentType(contentType) || sniffMetaCharset(buffer) || DEFAULT_CHARSET;
    const decoded = decodeWith(label, buffer);
    return decoded !== null ? decoded : decodeWith(DEFAULT_CHARSET, buffer);
}

function mimeFromContentType(contentType) {
    return String(contentType || '').split(';')[0].trim().toLowerCase();
}

// ============================================================
// 对外接口
// ============================================================

/**
 * 抓取文本资源（网页）。
 * @returns {Promise<{ text: string, finalUrl: string, contentType: string }>}
 */
async function fetchText(url, options = {}) {
    const {
        maxBytes = DEFAULT_TEXT_MAX_BYTES,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        headers,
        allowPrivateNetwork = false,
    } = options;

    return withTimeout(timeoutMs, async (signal) => {
        const { response, finalUrl } = await guardedFetch(url, {
            headers: buildHeaders(TEXT_HEADERS, headers),
            allowPrivateNetwork,
            signal,
        });
        await assertOk(response, finalUrl);
        const buffer = await readBodyLimited(response, maxBytes, finalUrl);
        const contentType = response.headers.get('content-type') || '';
        return { text: decodeText(buffer, contentType), finalUrl, contentType };
    });
}

/**
 * 抓取二进制资源（图片等）。
 * @returns {Promise<{ buffer: Buffer, mime: string, finalUrl: string }>}
 */
async function fetchBinary(url, options = {}) {
    const {
        maxBytes = DEFAULT_BINARY_MAX_BYTES,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        headers,
        allowPrivateNetwork = false,
    } = options;

    return withTimeout(timeoutMs, async (signal) => {
        const { response, finalUrl } = await guardedFetch(url, {
            headers: buildHeaders(BINARY_HEADERS, headers),
            allowPrivateNetwork,
            signal,
        });
        await assertOk(response, finalUrl);
        const buffer = await readBodyLimited(response, maxBytes, finalUrl);
        return { buffer, mime: mimeFromContentType(response.headers.get('content-type')), finalUrl };
    });
}

module.exports = {
    assertPublicUrl,
    fetchText,
    fetchBinary,
    isPrivateAddress,
    DEFAULT_USER_AGENT,
    _setLookup,
};
