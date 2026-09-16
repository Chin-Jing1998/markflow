/**
 * 自定义协议：mf-app://app/<渲染层文件> 与 mf-asset://<sid>/<相对路径>（方案 §3.4.6，参数照 R4 探针实测）
 *
 * 纯逻辑（可在普通 Node 中单测）：
 *   createAssetGrants()                              → { grants: Map<sid, { roots }>, grant(roots) → sid, revoke(sid), get(sid) }
 *   resolveAssetRequest({ grants, url, allowedExts }) → { status: 200, filePath } | { status, reason }
 *       处理顺序：sid 查找（小写化，与 Chromium 对标准 scheme host 的处理一致）→ decodeURIComponent
 *       → 扩展名白名单 → path.resolve(root, '.' + rel) → isWithinDir → stat().isFile() → realpath 校验
 *   resolveAppRequest({ rendererDir, url })          → { status: 200, filePath, mime } | { status, reason }
 *       host 必须为 app；显式 MIME 表（.js 为 text/javascript，否则模块脚本被拒）；目录边界与 realpath 校验同上
 *
 * Electron 侧：
 *   registerSchemesAsPrivileged(protocol)              app.ready 前调用一次
 *   installProtocols({ protocol, net, rendererDir, grants, csp })   ready 后注册两个 protocol.handle
 *       mf-app 响应直接附带 CSP 头（DEFAULT_CSP）；mf-asset 经 net.fetch(pathToFileURL) 回流文件内容
 *
 * sid 为 16 字节随机数的小写十六进制；授权表只存在于主进程内存，渲染进程拿到的只是 sid。
 */
const path = require('path');
const fsp = require('fs').promises;
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const { isWithinDir, isRealWithinDir } = require('../../converters/util');

const APP_SCHEME = 'mf-app';
const ASSET_SCHEME = 'mf-asset';
const APP_HOST = 'app';
const SID_BYTES = 16;
const ASSET_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tif', '.tiff', '.pdf']);
const APP_MIME = Object.freeze({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
});
const DEFAULT_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' mf-asset: data:; frame-src mf-asset: about:; connect-src 'none'; object-src 'none'";
const SCHEME_PRIVILEGES = Object.freeze([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false } },
    { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// ============================================================
// 授权表
// ============================================================

function createAssetGrants() {
    const grants = new Map();
    return {
        grants,
        /** roots：绝对目录数组；返回新 sid */
        grant(roots) {
            const list = Array.isArray(roots) ? roots : [roots];
            const dirs = list.filter((item) => typeof item === 'string' && item.trim()).map((item) => path.resolve(item));
            if (dirs.length === 0) throw new Error('grant 需要至少一个目录');
            const sid = crypto.randomBytes(SID_BYTES).toString('hex');
            grants.set(sid, { roots: dirs });
            return sid;
        },
        revoke: (sid) => grants.delete(String(sid || '').toLowerCase()),
        get: (sid) => grants.get(String(sid || '').toLowerCase()) || null,
        size: () => grants.size,
    };
}

// ============================================================
// 解析（纯逻辑）
// ============================================================

function parseUrl(url) {
    try {
        return new URL(String(url));
    } catch (err) {
        return null;
    }
}

function decodePath(pathname) {
    try {
        return decodeURIComponent(pathname);
    } catch (err) {
        return null;
    }
}

const deny = (status, reason) => ({ status, reason });

/**
 * @param {{ grants: Map|{ get: Function }, url: string, allowedExts?: string[] }} params
 * @returns {Promise<{ status: number, filePath?: string, reason?: string }>}
 */
async function resolveAssetRequest({ grants, url, allowedExts = ASSET_EXTENSIONS } = {}) {
    const parsed = parseUrl(url);
    if (!parsed || parsed.protocol !== `${ASSET_SCHEME}:`) return deny(400, 'bad-url');
    const lookup = grants && typeof grants.get === 'function' ? grants : null;
    const grant = lookup ? lookup.get(parsed.host.toLowerCase()) : null;
    if (!grant || !Array.isArray(grant.roots) || grant.roots.length === 0) return deny(403, 'sid-not-granted');
    const rel = decodePath(parsed.pathname);
    if (rel === null) return deny(400, 'bad-encoding');
    const exts = new Set((allowedExts || ASSET_EXTENSIONS).map((ext) => ext.toLowerCase()));
    if (!exts.has(path.extname(rel).toLowerCase())) return deny(403, 'ext-not-allowed');

    for (const root of grant.roots) {
        const base = path.resolve(root);
        const abs = path.resolve(base, `.${rel}`);
        if (!isWithinDir(base, abs)) return deny(403, 'outside-root');
        let stat;
        try {
            stat = await fsp.stat(abs);
        } catch (err) {
            continue;
        }
        if (!stat.isFile()) return deny(403, 'not-a-file');
        if (!(await isRealWithinDir(base, abs))) return deny(403, 'symlink-escape');
        return { status: 200, filePath: abs };
    }
    return deny(404, 'not-found');
}

/**
 * @param {{ rendererDir: string, url: string }} params
 * @returns {Promise<{ status: number, filePath?: string, mime?: string, reason?: string }>}
 */
async function resolveAppRequest({ rendererDir, url } = {}) {
    const parsed = parseUrl(url);
    if (!parsed || parsed.protocol !== `${APP_SCHEME}:`) return deny(400, 'bad-url');
    if (parsed.host.toLowerCase() !== APP_HOST) return deny(404, 'bad-host');
    const rel = decodePath(parsed.pathname);
    if (rel === null) return deny(400, 'bad-encoding');
    const base = path.resolve(rendererDir);
    const abs = path.resolve(base, `.${rel === '/' || rel === '' ? '/index.html' : rel}`);
    if (!isWithinDir(base, abs)) return deny(403, 'outside-app-dir');
    const mime = APP_MIME[path.extname(abs).toLowerCase()];
    if (!mime) return deny(404, 'unsupported-type');
    let stat;
    try {
        stat = await fsp.stat(abs);
    } catch (err) {
        return deny(404, 'not-found');
    }
    if (!stat.isFile()) return deny(404, 'not-found');
    if (!(await isRealWithinDir(base, abs))) return deny(403, 'outside-app-dir-real');
    return { status: 200, filePath: abs, mime };
}

// ============================================================
// Electron 处理器
// ============================================================

const denyResponse = (status, reason) => new Response(reason, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-MF-Reason': reason },
});

function createAppHandler({ rendererDir, csp = DEFAULT_CSP } = {}) {
    return async function handleApp(request) {
        const hit = await resolveAppRequest({ rendererDir, url: request.url });
        if (hit.status !== 200) return denyResponse(hit.status, hit.reason);
        let data;
        try {
            data = await fsp.readFile(hit.filePath);
        } catch (err) {
            return denyResponse(404, 'not-found');
        }
        return new Response(data, {
            headers: { 'Content-Type': hit.mime, 'Cache-Control': 'no-store', 'Content-Security-Policy': csp },
        });
    };
}

function createAssetHandler({ grants, net } = {}) {
    if (!net || typeof net.fetch !== 'function') throw new Error('createAssetHandler 需要 electron.net');
    return async function handleAsset(request) {
        const hit = await resolveAssetRequest({ grants, url: request.url });
        if (hit.status !== 200) return denyResponse(hit.status, hit.reason);
        return net.fetch(pathToFileURL(hit.filePath).href);
    };
}

/** app.ready 前调用一次 */
function registerSchemesAsPrivileged(protocol) {
    protocol.registerSchemesAsPrivileged(SCHEME_PRIVILEGES.map((item) => ({ scheme: item.scheme, privileges: { ...item.privileges } })));
}

/** app.ready 后调用一次 */
function installProtocols({ protocol, net, rendererDir, grants, csp } = {}) {
    if (!protocol || typeof protocol.handle !== 'function') throw new Error('installProtocols 需要 electron.protocol');
    protocol.handle(APP_SCHEME, createAppHandler({ rendererDir, csp }));
    protocol.handle(ASSET_SCHEME, createAssetHandler({ grants, net }));
}

module.exports = {
    createAssetGrants, resolveAssetRequest, resolveAppRequest,
    createAppHandler, createAssetHandler, registerSchemesAsPrivileged, installProtocols,
    APP_SCHEME, ASSET_SCHEME, APP_HOST, ASSET_EXTENSIONS, APP_MIME, DEFAULT_CSP, SCHEME_PRIVILEGES,
};
