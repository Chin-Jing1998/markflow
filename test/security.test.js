/**
 * server/security.js 单元测试
 * 覆盖：isInsideDir 的包含判定与穿越防护、requireToken 的放行与 401 分支
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { requireToken, isInsideDir, TOKEN_HEADER } = require('../server/security');

// 最小 req/res 替身：只实现中间件用到的 get / status / json
function fakeReq(headerValue) {
    return {
        get(name) {
            return name.toLowerCase() === TOKEN_HEADER.toLowerCase() ? headerValue : undefined;
        },
    };
}

function fakeRes() {
    const res = { statusCode: null, body: null };
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (payload) => {
        res.body = payload;
        return res;
    };
    return res;
}

// 返回 { res, nextCalls }
function runMiddleware(middleware, headerValue) {
    const res = fakeRes();
    let nextCalls = 0;
    middleware(fakeReq(headerValue), res, () => { nextCalls += 1; });
    return { res, nextCalls };
}

// ============================================================
// isInsideDir
// ============================================================

describe('isInsideDir', () => {
    test('子文件位于基准目录内时返回 true', () => {
        assert.equal(isInsideDir('/a/b', '/a/b/c.md'), true);
    });

    test('基准目录自身返回 true', () => {
        assert.equal(isInsideDir('/a/b', '/a/b'), true);
    });

    test('同前缀的兄弟目录返回 false', () => {
        assert.equal(isInsideDir('/a/b', '/a/bc/x'), false);
    });

    test('借助 .. 逃出基准目录返回 false', () => {
        assert.equal(isInsideDir('/a/b', '/a/b/../x'), false);
    });

    test('多级 .. 逃出基准目录返回 false', () => {
        assert.equal(isInsideDir('/a/b', '/a/b/c/../../../etc/passwd'), false);
    });

    test('非字符串入参返回 false 而非抛异常', () => {
        assert.equal(isInsideDir('/a/b', null), false);
        assert.equal(isInsideDir(undefined, '/a/b/c'), false);
    });
});

// ============================================================
// requireToken
// ============================================================

describe('requireToken', () => {
    test('token 完全一致时放行且不写响应', () => {
        // Arrange
        const middleware = requireToken('abc123');

        // Act
        const { res, nextCalls } = runMiddleware(middleware, 'abc123');

        // Assert
        assert.equal(nextCalls, 1);
        assert.equal(res.statusCode, null);
    });

    test('长度不同的 token 不抛异常，返回 401', () => {
        // Arrange
        const middleware = requireToken('abc123');

        // Act
        const { res, nextCalls } = runMiddleware(middleware, 'x');

        // Assert
        assert.equal(nextCalls, 0);
        assert.equal(res.statusCode, 401);
        assert.deepEqual(res.body, { success: false, error: '未授权' });
    });

    test('等长但不同的 token 返回 401', () => {
        const { res, nextCalls } = runMiddleware(requireToken('abc123'), 'abc124');
        assert.equal(nextCalls, 0);
        assert.equal(res.statusCode, 401);
    });

    test('缺少请求头返回 401', () => {
        const { res, nextCalls } = runMiddleware(requireToken('abc123'), undefined);
        assert.equal(nextCalls, 0);
        assert.equal(res.statusCode, 401);
    });

    test('服务端 token 为空时一律 401（不因空串对空串而放行）', () => {
        const { res, nextCalls } = runMiddleware(requireToken(''), '');
        assert.equal(nextCalls, 0);
        assert.equal(res.statusCode, 401);
    });
});
