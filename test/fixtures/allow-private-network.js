/**
 * 测试专用预加载脚本（node --require）
 *
 * MCP 服务进程不会、也不应把 allowPrivateNetwork 暴露成工具入参，因此集成测试没法
 * 让它抓取跑在 127.0.0.1 上的测试服务器。这里在进程启动最早期改写 fetch-guard 的
 * 导出函数，为其补上 allowPrivateNetwork——守卫本体一行没动，仅测试进程内生效。
 *
 * 时序前提：converters/index.js 顶层不加载任何 parser，parsers/url.js 要等到工具被
 * 调用时才 require，那时它解构到的已经是下面改写过的函数。
 */
const path = require('path');

const guard = require(path.resolve(__dirname, '..', '..', 'converters', 'net', 'fetch-guard'));
const originalFetchText = guard.fetchText;
const originalFetchBinary = guard.fetchBinary;

guard.fetchText = (url, options = {}) => originalFetchText(url, { ...options, allowPrivateNetwork: true });
guard.fetchBinary = (url, options = {}) => originalFetchBinary(url, { ...options, allowPrivateNetwork: true });
