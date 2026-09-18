/**
 * 桌面端文件类别表（纯常量，不依赖 Electron）
 *
 *   READER_EXTENSIONS      阅读模式能直接打开的扩展名（md / html / xml / pdf / json）
 *   KIND_BY_EXT            扩展名 → 阅读视图类别
 *   BROWSE_EXTENSIONS      文件库仓库树列出的扩展名 = 转档入口的扫描白名单 ∪ .html .htm .xml .json
 *                          （转档入口 mf:paths:expand 的默认范围即 DIRECTORY_SCAN_EXTENSIONS，不受此表影响）。
 *                          取 DIRECTORY_SCAN_EXTENSIONS 而非 SUPPORTED_EXTENSIONS：后者自专利五书反向导入起含 .zip，
 *                          而本表同时是 ipc.js「用默认应用打开」的扩展名白名单（OPENABLE_EXTENSIONS）的来源，不得因此放宽
 *   IMAGE_IMPORT_EXTENSIONS Markdown 编辑器「插入图片」接受的扩展名
 *   MAX_IMAGE_IMPORT_BYTES 单张插图上限
 *   MAX_TEXT_BYTES         单个文本文件的读取 / 保存上限
 */
const { DIRECTORY_SCAN_EXTENSIONS } = require('../../converters/targets');

const READER_EXTENSIONS = Object.freeze(['.md', '.markdown', '.html', '.htm', '.xml', '.pdf', '.json']);
const KIND_BY_EXT = Object.freeze({
    '.md': 'md', '.markdown': 'md', '.html': 'html', '.htm': 'html', '.xml': 'xml', '.pdf': 'pdf', '.json': 'json',
});
const BROWSE_EXTENSIONS = Object.freeze([...new Set([...DIRECTORY_SCAN_EXTENSIONS, '.html', '.htm', '.xml', '.json'])]);
const IMAGE_IMPORT_EXTENSIONS = Object.freeze(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
const MAX_IMAGE_IMPORT_BYTES = 20 * 1024 * 1024;
/** 阅读视图不承担超大文件，超限给中文提示而不是卡死渲染进程；保存沿用同一上限 */
const MAX_TEXT_BYTES = 16 * 1024 * 1024;

module.exports = {
    READER_EXTENSIONS, KIND_BY_EXT, BROWSE_EXTENSIONS, IMAGE_IMPORT_EXTENSIONS, MAX_IMAGE_IMPORT_BYTES, MAX_TEXT_BYTES,
};
