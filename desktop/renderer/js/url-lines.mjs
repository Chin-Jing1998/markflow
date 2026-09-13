/**
 * 网页链接行解析（纯逻辑 ES 模块：渲染层直接 import，Node 测试经 import() 载入）
 *
 * parseUrlLines(text) → { urls: string[], invalid: [{ line, text, reason }], duplicates: number, total: number }
 *   每行一个链接；前后空白与空行忽略；只接受 http/https 且 URL 可解析、含主机名的行；
 *   非法行记入 invalid（行号从 1 起、原文与中文原因）而不阻断其余行；同一链接重复出现只保留首个并计入 duplicates。
 * hostOf(url) → 主机名（小写），无法解析时返回原文
 */
const HTTP_RE = /^https?:\/\//i;
const MAX_URL_LENGTH = 4096;

export const REASONS = Object.freeze({
    scheme: '仅接受 http/https 链接',
    malformed: '链接格式不正确',
    tooLong: `链接过长（上限 ${MAX_URL_LENGTH} 字符）`,
});

export function parseUrlLines(text) {
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    const urls = [];
    const invalid = [];
    const seen = new Set();
    let duplicates = 0;
    let total = 0;
    lines.forEach((raw, index) => {
        const value = raw.trim();
        if (!value) return;
        total += 1;
        const line = index + 1;
        if (!HTTP_RE.test(value)) {
            invalid.push({ line, text: value, reason: REASONS.scheme });
            return;
        }
        if (value.length > MAX_URL_LENGTH) {
            invalid.push({ line, text: value, reason: REASONS.tooLong });
            return;
        }
        let parsed;
        try {
            parsed = new URL(value);
        } catch (err) {
            parsed = null;
        }
        if (!parsed || !parsed.hostname) {
            invalid.push({ line, text: value, reason: REASONS.malformed });
            return;
        }
        if (seen.has(value)) {
            duplicates += 1;
            return;
        }
        seen.add(value);
        urls.push(value);
    });
    return { urls, invalid, duplicates, total };
}

export function hostOf(url) {
    try {
        return new URL(String(url)).hostname.toLowerCase() || String(url);
    } catch (err) {
        return String(url);
    }
}
