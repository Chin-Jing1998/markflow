/**
 * 本地服务安全件：token 鉴权、目录包含判定、静态资源白名单。
 *
 * requireToken(token)          → 校验请求头 X-MarkFlow-Token 的中间件，不匹配返回 401
 * isInsideDir(baseDir, target) → target 解析后是否位于 baseDir 之内（防 .. 穿越）
 * mountStatic(app, rootDir)    → 只开放 /、/css、/js、/assets，其余路径 404
 */
const crypto = require('crypto');
const express = require('express');
const path = require('path');

const TOKEN_HEADER = 'X-MarkFlow-Token';
const STATIC_DIRS = Object.freeze(['css', 'js', 'assets']);
const STATIC_OPTIONS = Object.freeze({ dotfiles: 'deny', index: false, fallthrough: false });

// 先取定长摘要再比较：长度不一致时 timingSafeEqual 会抛异常，摘要可回避该问题且不泄露长度
function digest(value) {
    return crypto.createHash('sha256').update(typeof value === 'string' ? value : '').digest();
}

function requireToken(token) {
    const expected = digest(token);
    const enabled = typeof token === 'string' && token !== '';
    return (req, res, next) => {
        const actual = digest(req.get(TOKEN_HEADER));
        if (enabled && crypto.timingSafeEqual(expected, actual)) {
            next();
            return;
        }
        res.status(401).json({ success: false, error: '未授权' });
    };
}

function isInsideDir(baseDir, target) {
    if (typeof baseDir !== 'string' || typeof target !== 'string') return false;
    const base = path.resolve(baseDir);
    const resolved = path.resolve(target);
    return resolved === base || resolved.startsWith(base + path.sep);
}

// 路径含 .. 段（含百分号编码形式）即视为穿越尝试；无法解码的路径同样拒绝
function hasTraversal(rawPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(rawPath);
    } catch (err) {
        return true;
    }
    return decoded.split(/[\\/]/).includes('..');
}

// 必须在全部 /api 路由之后调用：内含兜底 404，会拦截其后的一切请求
function mountStatic(app, rootDir) {
    // serve-static 对穿越路径默认返回 403，此处统一为 404，不泄露路径判定差异
    app.use((req, res, next) => {
        if (!hasTraversal(req.path)) return next();
        res.status(404).json({ success: false, error: '资源不存在' });
    });
    app.get('/', (req, res) => {
        res.sendFile(path.join(rootDir, 'index.html'));
    });
    for (const dir of STATIC_DIRS) {
        app.use(`/${dir}`, express.static(path.join(rootDir, dir), STATIC_OPTIONS));
    }
    app.use((req, res) => {
        res.status(404).json({ success: false, error: '资源不存在' });
    });
}

module.exports = { requireToken, isInsideDir, mountStatic, TOKEN_HEADER };
