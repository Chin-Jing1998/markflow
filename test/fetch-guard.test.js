/**
 * converters/net/fetch-guard.js 单元测试
 * 覆盖：协议与内网地址拦截、DNS 注入、IPv6 判定、重定向逐跳守卫、限长、超时、charset 解码
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
    assertPublicUrl,
    fetchText,
    fetchBinary,
    isPrivateAddress,
    _setLookup,
} = require('../converters/net/fetch-guard');

const CHINESE_RE = /[一-龥]/;
const PUBLIC_ADDRESS = '93.184.216.34';
// RFC 5737 TEST-NET-3：守卫眼中是公网地址，实际不可路由，用于验证连接目标
const UNROUTABLE_PUBLIC_ADDRESS = '203.0.113.1';
const GBK_CHINESE = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // "中文" 的 GBK 编码
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const BIG_BODY = Buffer.alloc(4096, 0x61);

// ============================================================
// 测试服务器
// ============================================================

function startServer() {
    const pending = [];
    // 记录实际到达本地服务器的请求路径，用于验证连接是否真的打到了本机
    const hits = [];
    const server = http.createServer((req, res) => {
        hits.push(req.url);
        const route = ROUTES[req.url];
        if (!route) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
            return;
        }
        route(req, res, pending);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const base = `http://127.0.0.1:${server.address().port}`;
            resolve({
                base,
                port: server.address().port,
                hits,
                close: () => new Promise((done) => {
                    pending.forEach((res) => res.destroy());
                    server.closeAllConnections();
                    server.close(() => done());
                }),
            });
        });
    });
}

const ROUTES = {
    '/gbk': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=gbk' });
        res.end(Buffer.concat([Buffer.from('<p>'), GBK_CHINESE, Buffer.from('</p>')]));
    },
    '/meta-charset': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(Buffer.concat([Buffer.from('<meta charset="gbk"><p>'), GBK_CHINESE, Buffer.from('</p>')]));
    },
    '/big': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(BIG_BODY);
    },
    '/a.png': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(PNG_BYTES);
    },
    '/echo-host': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(String(req.headers.host || ''));
    },
    '/r1': (req, res) => { res.writeHead(302, { Location: '/r2' }); res.end(); },
    '/r2': (req, res) => { res.writeHead(301, { Location: '/final' }); res.end(); },
    '/final': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('final'); },
    '/loop': (req, res) => { res.writeHead(302, { Location: '/loop' }); res.end(); },
    '/to-private': (req, res) => { res.writeHead(302, { Location: 'http://10.0.0.1/' }); res.end(); },
    '/slow': (req, res, pending) => { pending.push(res); },
};

// ============================================================
// URL 守卫
// ============================================================

test('assertPublicUrl 拒绝环回、内网、链路本地、localhost 与非 http 协议', async () => {
    const blocked = [
        'http://127.0.0.1/',
        'http://localhost/',
        'http://10.0.0.1/',
        'http://192.168.1.1/',
        'http://169.254.169.254/',
        'http://[::1]/',
        'ftp://example.com/',
    ];
    for (const url of blocked) {
        await assert.rejects(assertPublicUrl(url), CHINESE_RE, `应拒绝 ${url}`);
    }
});

test('_setLookup 注入：域名解析到内网地址被拒，解析到公网地址放行', async (t) => {
    t.after(() => _setLookup(null));

    _setLookup(async () => [{ address: '10.0.0.1', family: 4 }]);
    await assert.rejects(assertPublicUrl('http://example.com/'), /内网|保留/);

    _setLookup(async () => [{ address: PUBLIC_ADDRESS, family: 4 }]);
    const parsed = await assertPublicUrl('http://example.com/path?q=1');
    assert.equal(parsed.hostname, 'example.com');
    assert.equal(parsed.href, 'http://example.com/path?q=1');
});

test('任一解析结果命中内网即拒绝，allowPrivateNetwork 跳过地址检查', async (t) => {
    t.after(() => _setLookup(null));
    _setLookup(async () => [
        { address: PUBLIC_ADDRESS, family: 4 },
        { address: '::ffff:127.0.0.1', family: 6 },
    ]);
    await assert.rejects(assertPublicUrl('http://example.com/'), CHINESE_RE);

    const parsed = await assertPublicUrl('http://127.0.0.1/', { allowPrivateNetwork: true });
    assert.equal(parsed.hostname, '127.0.0.1');
    await assert.rejects(assertPublicUrl('ftp://127.0.0.1/', { allowPrivateNetwork: true }), /协议/);
});

test('isPrivateAddress 覆盖 IPv4 保留段与 IPv6 环回、ULA、链路本地、v4 映射', () => {
    const privateList = [
        '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
        '172.16.0.1', '172.31.255.255', '192.168.0.1',
        '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%en0',
        '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '[::1]',
        'not-an-ip',
    ];
    const publicList = ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8'];

    for (const address of privateList) assert.equal(isPrivateAddress(address), true, `${address} 应判为内网`);
    for (const address of publicList) assert.equal(isPrivateAddress(address), false, `${address} 应判为公网`);
});

// ============================================================
// 抓取
// ============================================================

test('fetchText 按 Content-Type charset 与 <meta charset> 解码，并跟随重定向返回 finalUrl', async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    const options = { allowPrivateNetwork: true };

    const gbk = await fetchText(`${server.base}/gbk`, options);
    assert.equal(gbk.text, '<p>中文</p>');
    assert.equal(gbk.contentType, 'text/html; charset=gbk');

    const meta = await fetchText(`${server.base}/meta-charset`, options);
    assert.equal(meta.text, '<meta charset="gbk"><p>中文</p>');

    const redirected = await fetchText(`${server.base}/r1`, options);
    assert.equal(redirected.text, 'final');
    assert.equal(redirected.finalUrl, `${server.base}/final`);
});

test('响应体超过 maxBytes 抛中文错误', async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    await assert.rejects(
        fetchText(`${server.base}/big`, { allowPrivateNetwork: true, maxBytes: 1024 }),
        /超过上限/,
    );
});

test('重定向到私网地址在第二跳被拒', async (t) => {
    const server = await startServer();
    t.after(() => server.close());
    t.after(() => _setLookup(null));

    // 让首跳 127.0.0.1 在守卫眼中是公网地址，重定向目标 10.0.0.1 保持内网
    const seen = [];
    _setLookup(async (host) => {
        seen.push(host);
        return [{ address: host === '127.0.0.1' ? PUBLIC_ADDRESS : host, family: 4 }];
    });

    await assert.rejects(fetchText(`${server.base}/to-private`), /内网|保留/);
    assert.deepEqual(seen, ['127.0.0.1', '10.0.0.1']);
});

test('重定向超过 5 次抛中文错误', async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    await assert.rejects(
        fetchText(`${server.base}/loop`, { allowPrivateNetwork: true }),
        /重定向次数超过 5 次/,
    );
});

test('超时抛中文错误', async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    await assert.rejects(
        fetchText(`${server.base}/slow`, { allowPrivateNetwork: true, timeoutMs: 300 }),
        /超时/,
    );
});

test('HTTP 错误状态抛中文错误', async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    await assert.rejects(
        fetchText(`${server.base}/missing`, { allowPrivateNetwork: true }),
        /HTTP 404/,
    );
});

test('fetchBinary 返回 Buffer、mime 与 finalUrl，且透传自定义头', async (t) => {
    const server = await startServer();
    t.after(() => server.close());

    const result = await fetchBinary(`${server.base}/a.png`, {
        allowPrivateNetwork: true,
        headers: { Referer: `${server.base}/` },
    });
    assert.ok(Buffer.isBuffer(result.buffer));
    assert.ok(result.buffer.equals(PNG_BYTES));
    assert.equal(result.mime, 'image/png');
    assert.equal(result.finalUrl, `${server.base}/a.png`);
});

test('assertPublicUrl 拒绝 6to4、NAT64、组播与保留段地址', async () => {
    // Arrange：前两个内嵌 127.0.0.1，后两个分别属于 224.0.0.0/4 与 240.0.0.0/4
    const blocked = [
        'http://[2002:7f00:1::]/',
        'http://[64:ff9b::7f00:1]/',
        'http://224.0.0.1/',
        'http://255.255.255.255/',
    ];

    // Act & Assert
    for (const url of blocked) {
        await assert.rejects(assertPublicUrl(url), CHINESE_RE, `应拒绝 ${url}`);
    }
    assert.equal(isPrivateAddress('2002:7f00:1::'), true);
    assert.equal(isPrivateAddress('64:ff9b::7f00:1'), true);
    assert.equal(isPrivateAddress('2002:0808:0808::'), false, '6to4 内嵌公网 IPv4 时应放行');
});

test('连接按守卫已校验的地址建立，Host 头仍为原主机名', async (t) => {
    // Arrange：域名解析到本机，抓取后由服务器回显收到的 Host
    const server = await startServer();
    t.after(() => server.close());
    t.after(() => _setLookup(null));
    _setLookup(async () => [{ address: '127.0.0.1', family: 4 }]);

    // Act
    const res = await fetchText(`http://example.test:${server.port}/echo-host`, { allowPrivateNetwork: true });

    // Assert
    assert.equal(res.text, `example.test:${server.port}`);
    assert.deepEqual(server.hits, ['/echo-host'], '请求应确实落到解析出的本机地址');
});

test('DNS 重绑定：连接钉扎首次解析结果，第二次解析到本机也打不进来', async (t) => {
    // Arrange：第一次解析（守卫用）给不可路由的公网地址，第二次给本机
    const server = await startServer();
    t.after(() => server.close());
    t.after(() => _setLookup(null));
    let calls = 0;
    _setLookup(async () => {
        calls += 1;
        return [{ address: calls === 1 ? UNROUTABLE_PUBLIC_ADDRESS : '127.0.0.1', family: 4 }];
    });

    // Act & Assert：连接打向首次解析结果，超时或直接连接失败，均不得到达本地服务器
    await assert.rejects(
        fetchText(`http://rebind.test:${server.port}/echo-host`, { timeoutMs: 300 }),
        /超时|请求失败/,
    );
    assert.equal(calls, 1, 'DNS 只应在守卫阶段解析一次');
    assert.deepEqual(server.hits, [], '第二次解析结果不得被采用');
});
