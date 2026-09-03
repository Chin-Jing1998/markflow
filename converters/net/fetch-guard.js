/**
 * 受控网络访问：SSRF 守卫 + 限长限时抓取（基于 Node 内置 http/https）
 *   - assertPublicUrl：仅放行 http/https；主机名解析出的所有地址均不得落入内网/保留段
 *   - fetchText / fetchBinary：连接目标钉扎为守卫刚放行的那个 IP（消除 DNS 重绑定 TOCTOU），
 *     逐跳跟随重定向（最多 5 跳，每跳重新守卫并重新钉扎）、AbortController 超时、
 *     流式计数限长、按 charset 解码文本
 *   - _setLookup：测试注入 DNS 解析结果
 *
 * 不用内置 fetch/undici 的原因：undici 只接受 URL，主机名会在守卫校验之后被再解析一次，
 * 攻击者可在两次解析之间把域名指回内网（DNS rebinding）。改用 http/https 模块后，
 * 连接层的 lookup 由本模块提供，直接返回校验通过的地址，同时保留原主机名用于
 * Host 头与 TLS servername（证书仍按原主机名校验）。
 *
 * 所有错误信息为简体中文。
 */
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const DEFAULT_PORT_BY_PROTOCOL = { 'http:': 80, 'https:': 443 };
// 嗅探 <meta charset> 只看开头这一段
const CHARSET_SNIFF_BYTES = 2048;
const DEFAULT_CHARSET = 'utf-8';

// 两种抓取模式各自的默认上限与请求头
const TEXT_DEFAULTS = {
    maxBytes: 20 * 1024 * 1024,
    headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
};
const BINARY_DEFAULTS = {
    maxBytes: 10 * 1024 * 1024,
    headers: { 'User-Agent': DEFAULT_USER_AGENT, 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
};

// IPv4 内网/保留段：本网络、私网 A/B/C、运营商级 NAT、环回、链路本地（含云元数据
// 169.254.169.254）、组播 224.0.0.0/4、保留 240.0.0.0/4（含广播 255.255.255.255）
const PRIVATE_IPV4_CIDRS = [
    '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
    '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4',
];

const defaultLookup = (host, options) => dns.promises.lookup(host, options);
let lookupImpl = defaultLookup;

/** 测试钩子：注入 (host, options) => Promise<Array<{address, family}>>；传入非函数则恢复默认 */
function _setLookup(fn) {
    lookupImpl = typeof fn === 'function' ? fn : defaultLookup;
}

function parseIPv4(address) {
    if (!net.isIPv4(address)) return null;
    return address.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

const PRIVATE_IPV4_RANGES = PRIVATE_IPV4_CIDRS.map((cidr) => {
    const bits = Number(cidr.split('/')[1]);
    return { base: parseIPv4(cidr.split('/')[0]), mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0 };
});

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

/**
 * 取出 IPv6 中内嵌的 IPv4（无内嵌返回 null），三种形态：
 *   ::ffff:a.b.c.d 映射与 ::a.b.c.d 兼容 → 末 32 位
 *   2002::/16 6to4                      → 第 2、3 组
 *   64:ff9b::/96 NAT64                  → 末 32 位
 */
function embeddedIPv4(groups) {
    const lastTwoGroups = () => ((groups[6] << 16) | groups[7]) >>> 0;
    const isZero = (from, to) => groups.slice(from, to).every((g) => g === 0);
    if (isZero(0, 5) && (groups[5] === 0xffff || groups[5] === 0)) return lastTwoGroups();
    if (groups[0] === 0x2002) return ((groups[1] << 16) | groups[2]) >>> 0;
    if (groups[0] === 0x0064 && groups[1] === 0xff9b && isZero(2, 6)) return lastTwoGroups();
    return null;
}

function isPrivateIPv6Groups(groups) {
    const leadingZero = (count) => groups.slice(0, count).every((g) => g === 0);
    if (leadingZero(8)) return true;                                   // :: 未指定地址
    if (leadingZero(7) && groups[7] === 1) return true;                // ::1 环回
    if ((groups[0] & 0xfe00) === 0xfc00) return true;                  // fc00::/7 ULA
    if ((groups[0] & 0xffc0) === 0xfe80) return true;                  // fe80::/10 链路本地
    const v4 = embeddedIPv4(groups);
    return v4 === null ? false : isPrivateIPv4Int(v4);
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

/** DNS 解析，统一归一为 [{ address, family }]；family 缺失时按地址字面量推断 */
async function resolveAddresses(host) {
    let records;
    try {
        records = await lookupImpl(host, { all: true });
    } catch (err) {
        throw new Error(`域名解析失败: ${host}（${(err && (err.code || err.message)) || String(err)}）`);
    }
    return (Array.isArray(records) ? records : [records])
        .map((r) => (typeof r === 'string' ? { address: r } : r))
        .filter((r) => r && r.address)
        .map((r) => ({ address: String(r.address), family: Number(r.family) || net.isIP(String(r.address)) }));
}

/**
 * 校验 URL 可安全访问，并返回后续连接要钉扎的地址。
 * 主机名本身是 IP 字面量时无解析可言，直接钉扎该字面量；
 * allowPrivateNetwork 为 true 时跳过内网判定，但仍按解析结果钉扎（仅测试使用）。
 * @returns {Promise<{ parsed: URL, address: string, family: number }>}
 */
async function resolveAndPinHost(url, { allowPrivateNetwork = false } = {}) {
    let parsed;
    try {
        parsed = new URL(String(url));
    } catch (err) {
        throw new Error(`URL 格式非法: ${String(url)}`);
    }
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(`仅允许 http/https 协议，实际为 ${parsed.protocol.replace(/:$/, '')}: ${parsed.href}`);
    }

    const host = String(parsed.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (!host) throw new Error(`URL 缺少主机名: ${parsed.href}`);
    const literalFamily = net.isIP(host);

    if (allowPrivateNetwork) {
        if (literalFamily) return { parsed, address: host, family: literalFamily };
        const [first] = await resolveAddresses(host);
        if (!first) throw new Error(`域名未解析到任何地址: ${host}`);
        return { parsed, address: first.address, family: first.family };
    }

    if (host === 'localhost' || host.endsWith('.localhost')) throw new Error(`不允许访问本机地址: ${host}`);

    const addresses = await resolveAddresses(host);
    if (addresses.length === 0) throw new Error(`域名未解析到任何地址: ${host}`);
    const blocked = addresses.find((record) => isPrivateAddress(record.address));
    if (blocked) throw new Error(`不允许访问内网或保留地址: ${host}（解析为 ${blocked.address}）`);
    return literalFamily
        ? { parsed, address: host, family: literalFamily }
        : { parsed, address: addresses[0].address, family: addresses[0].family };
}

/** 校验 URL 可安全访问；allowPrivateNetwork 为 true 时跳过内网判定（仅测试使用） */
async function assertPublicUrl(url, options = {}) {
    return (await resolveAndPinHost(url, options)).parsed;
}

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

/**
 * net.Socket 的自定义 lookup：不再查 DNS，直接交还守卫已放行的地址。
 * Happy Eyeballs（autoSelectFamily）会以 { all: true } 调用，需返回数组形态。
 */
const pinnedLookup = ({ address, family }) => (host, options, callback) => (options && options.all
    ? callback(null, [{ address, family }])
    : callback(null, address, family));

/** 发起单次请求；连接目标为 target.address，Host 与 TLS servername 仍为原主机名 */
function requestPinned(target, headers, signal) {
    const { parsed } = target;
    const isHttps = parsed.protocol === 'https:';
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const options = {
        hostname,
        port: Number(parsed.port) || DEFAULT_PORT_BY_PROTOCOL[parsed.protocol],
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers,
        signal,
        // 不复用连接池：钉扎地址随每跳变化，池化会按 host:port 复用到非本次校验的连接
        agent: false,
        lookup: pinnedLookup(target),
    };
    // IP 字面量不得发 SNI；域名则显式指定，保证证书按原主机名校验
    if (isHttps && !net.isIP(hostname)) options.servername = hostname;

    return new Promise((resolve, reject) => {
        const req = (isHttps ? https : http).request(options);
        const onError = (err) => reject(err);
        req.once('error', onError);
        req.once('response', (res) => {
            req.removeListener('error', onError);
            // 响应已到手，后续断连错误由响应流负责，挂空处理器避免冒泡为未捕获异常
            req.on('error', () => {});
            res.on('error', () => {});
            resolve({ req, res, status: res.statusCode, statusText: res.statusMessage || '', headers: res.headers });
        });
        req.end();
    });
}

async function rawFetch(target, headers, signal) {
    try {
        return await requestPinned(target, headers, signal);
    } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        const detail = (err && (err.code || err.message)) || String(err);
        throw new Error(`请求失败: ${target.parsed.href}（${detail}）`);
    }
}

/** 丢弃响应体并断开连接，失败不影响主流程 */
function discardBody(response) {
    try {
        response.res.resume();
        response.req.destroy();
    } catch (err) { /* 连接已关闭，无需处理 */ }
}

/** 逐跳跟随重定向，每一跳都重新过守卫并重新钉扎地址 */
async function guardedFetch(url, { headers, allowPrivateNetwork, signal }) {
    let current = await resolveAndPinHost(url, { allowPrivateNetwork });

    for (let hop = 0; ; hop += 1) {
        const response = await rawFetch(current, headers, signal);
        if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current.parsed.href };

        const location = response.headers.location;
        discardBody(response);
        if (!location) throw new Error(`重定向缺少 Location 头（HTTP ${response.status}）: ${current.parsed.href}`);
        if (hop >= MAX_REDIRECTS) throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次: ${String(url)}`);

        let next;
        try {
            next = new URL(location, current.parsed);
        } catch (err) {
            throw new Error(`重定向目标非法: ${location}`);
        }
        current = await resolveAndPinHost(next, { allowPrivateNetwork });
    }
}

function assertOk(response, url) {
    if (response.status >= 200 && response.status < 300) return;
    discardBody(response);
    throw new Error(`请求返回 HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}: ${url}`);
}

function tooLargeError(received, maxBytes, url) {
    return new Error(`响应体超过上限 ${maxBytes} 字节（已收到 ${received} 字节）: ${url}`);
}

/** 流式读取响应体并计数，超过 maxBytes 立即断开连接 */
async function readBodyLimited(response, maxBytes, url) {
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
        discardBody(response);
        throw tooLargeError(declared, maxBytes, url);
    }

    const chunks = [];
    let total = 0;
    for await (const chunk of response.res) {
        total += chunk.length;
        if (total > maxBytes) {
            discardBody(response);
            throw tooLargeError(total, maxBytes, url);
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
}

const CONTENT_TYPE_CHARSET_RE = /charset\s*=\s*["']?\s*([\w.:-]+)/i;
const META_CHARSET_RE = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i;

function decodeWith(label, buffer) {
    try {
        return new TextDecoder(label).decode(buffer);
    } catch (err) {
        return null;
    }
}

/** 解码优先级：Content-Type 的 charset → 开头若干字节内的 <meta charset> → utf-8 */
function decodeText(buffer, contentType) {
    const pick = (re, text) => (re.exec(text) || [])[1];
    const label = pick(CONTENT_TYPE_CHARSET_RE, String(contentType || ''))
        || pick(META_CHARSET_RE, buffer.subarray(0, CHARSET_SNIFF_BYTES).toString('latin1'))
        || DEFAULT_CHARSET;
    const decoded = decodeWith(label, buffer);
    return decoded !== null ? decoded : decodeWith(DEFAULT_CHARSET, buffer);
}

/** 守卫 + 限时 + 限长的公共抓取路径，文本与二进制共用 */
async function fetchGuarded(url, options, defaults) {
    const { maxBytes = defaults.maxBytes, timeoutMs = DEFAULT_TIMEOUT_MS, headers, allowPrivateNetwork = false } = options;
    return withTimeout(timeoutMs, async (signal) => {
        const { response, finalUrl } = await guardedFetch(url, {
            headers: { ...defaults.headers, ...(headers || {}) },
            allowPrivateNetwork,
            signal,
        });
        assertOk(response, finalUrl);
        const buffer = await readBodyLimited(response, maxBytes, finalUrl);
        return { buffer, finalUrl, contentType: response.headers['content-type'] || '' };
    });
}

/** 抓取文本资源（网页）→ { text, finalUrl, contentType } */
async function fetchText(url, options = {}) {
    const { buffer, finalUrl, contentType } = await fetchGuarded(url, options, TEXT_DEFAULTS);
    return { text: decodeText(buffer, contentType), finalUrl, contentType };
}

/** 抓取二进制资源（图片等）→ { buffer, mime, finalUrl } */
async function fetchBinary(url, options = {}) {
    const { buffer, finalUrl, contentType } = await fetchGuarded(url, options, BINARY_DEFAULTS);
    return { buffer, mime: contentType.split(';')[0].trim().toLowerCase(), finalUrl };
}

module.exports = { assertPublicUrl, fetchText, fetchBinary, isPrivateAddress, DEFAULT_USER_AGENT, _setLookup };
