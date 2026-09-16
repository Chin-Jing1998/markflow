/**
 * 路径展开（桌面端转引）
 *
 * 实现已下沉到 converters/scan.js，桌面端与 CLI / MCP 共用同一套目录遍历规则；本文件只做转引，
 * 导出名与行为保持不变（契约见 converters/scan.js 文件头）：
 *   scanPaths(paths, opts)、expandPaths(paths, opts)、normalizeExts(exts)、DEFAULT_MAX_DEPTH、DEFAULT_MAX_FILES
 */
const { scanPaths, expandPaths, normalizeExts, DEFAULT_MAX_DEPTH, DEFAULT_MAX_FILES } = require('../../converters/scan');

module.exports = { scanPaths, expandPaths, normalizeExts, DEFAULT_MAX_DEPTH, DEFAULT_MAX_FILES };
