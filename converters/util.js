/**
 * 跨层通用工具（全仓唯一一份）
 *
 * 收纳与 IR、格式均无关的基础设施：错误取文、二进制归一、文件系统探查、进度上报。
 * 与 converters/ir/util.js 的分工：那边只放 IR 与名称相关的纯函数，这边放进程侧工具。
 */
const fsp = require('fs').promises;

// 取错误的可读文本；非 Error 值一律 String 化
const errText = (err) => (err && err.message ? err.message : String(err));

// 取 URL 主机名（小写）；解析失败返回空串。
// 与 converters/index.js 的 hostnameForFileName 不同：那边用于起文件名，取不到时回退 'web'
function hostnameOf(url) {
    try { return new URL(String(url || '')).hostname.toLowerCase(); } catch (err) { return ''; }
}

// 把各类二进制载体归一为 Buffer；不可识别返回 null
function toBuffer(value) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) return Buffer.from(value);
    return null;
}

// 路径不存在或不可访问时返回 null，不抛异常
async function statOrNull(target) {
    if (typeof target !== 'string' || !target.trim()) return null;
    try { return await fsp.stat(target); } catch (err) { return null; }
}

async function isFile(target) {
    const stat = await statOrNull(target);
    return Boolean(stat && stat.isFile());
}

async function isDirectory(target) {
    const stat = await statOrNull(target);
    return Boolean(stat && stat.isDirectory());
}

// parser 上报进度；ctx 未提供回调即静默，回调自身的异常一律吞掉，不影响解析
function notify(ctx, phase, pct) {
    if (!ctx || typeof ctx.onProgress !== 'function') return;
    try {
        ctx.onProgress(phase, pct);
    } catch (err) {
        // 忽略调用方回调自身的异常
    }
}

module.exports = { errText, hostnameOf, toBuffer, statOrNull, isFile, isDirectory, notify };
