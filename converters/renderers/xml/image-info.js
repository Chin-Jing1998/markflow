/**
 * 图片元数据读取（patent profile 的 wi/he 毫米换算与预检共用）
 *
 * readJpegInfo(buffer) → { width, height, dpi } | null
 *   逐段扫描 JPEG 标记：SOFn 段取像素尺寸，APP0 JFIF 段取密度（units=1 为 dpi，units=2 为 dpcm 换算为 dpi，
 *   units=0 表示仅有纵横比、无物理密度 → dpi 为 null）；非 JPEG 返回 null。不解码像素数据。
 * readImageInfo(buffer, mime) → { width, height, dpi, format } | null
 *   JPEG 走 readJpegInfo；其它格式经 image-size 取尺寸（dpi 为 null）。format 为 'jpg' | 'tif' | 其它扩展名。
 * pixelsToMm(px, dpi) → 毫米整数（px × 25.4 / dpi，向下取整，最小 1；官方对 wi/he 一律截尾取整）
 */
const { imageSize } = require('image-size');

const JPEG_SOI = 0xffd8;
const MARKER_PREFIX = 0xff;
const MARKER_APP0 = 0xe0;
const MARKER_SOS = 0xda;
const MARKER_EOI = 0xd9;
// 无长度字段的独立标记：SOI、TEM、RSTn
const STANDALONE_MARKERS = new Set([0xd8, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
// 帧头标记 SOF0–SOF15（去掉 DHT c4、JPG c8、DAC cc）
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const JFIF_SIGNATURE = 'JFIF\0';
const UNITS_DPI = 1;
const UNITS_DPCM = 2;
const INCH_MM = 25.4;
const CM_PER_INCH = 2.54;

const FORMAT_BY_MIME = Object.freeze({
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/tiff': 'tif', 'image/png': 'png', 'image/gif': 'gif',
    'image/bmp': 'bmp', 'image/x-ms-bmp': 'bmp', 'image/webp': 'webp', 'image/svg+xml': 'svg',
    'image/x-emf': 'emf', 'image/emf': 'emf', 'image/x-wmf': 'wmf', 'image/wmf': 'wmf',
});

function isJpeg(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.readUInt16BE(0) === JPEG_SOI;
}

function readJpegInfo(buffer) {
    if (!isJpeg(buffer)) return null;
    let width = null;
    let height = null;
    let dpi = null;
    let pos = 2;
    while (pos + 4 <= buffer.length) {
        if (buffer[pos] !== MARKER_PREFIX) { pos += 1; continue; }
        const marker = buffer[pos + 1];
        if (marker === MARKER_PREFIX) { pos += 1; continue; }
        if (STANDALONE_MARKERS.has(marker)) { pos += 2; continue; }
        if (marker === MARKER_EOI || marker === MARKER_SOS) break;
        const length = buffer.readUInt16BE(pos + 2);
        if (length < 2) break;
        const segmentStart = pos + 4;
        const segmentEnd = pos + 2 + length;
        if (marker === MARKER_APP0 && segmentEnd <= buffer.length && length >= 14
            && buffer.toString('latin1', segmentStart, segmentStart + 5) === JFIF_SIGNATURE) {
            dpi = densityOf(buffer[segmentStart + 7], buffer.readUInt16BE(segmentStart + 8));
        }
        if (SOF_MARKERS.has(marker) && segmentEnd <= buffer.length && length >= 7) {
            height = buffer.readUInt16BE(segmentStart + 1);
            width = buffer.readUInt16BE(segmentStart + 3);
        }
        pos = segmentEnd;
    }
    return { width, height, dpi };
}

function densityOf(units, xDensity) {
    if (!xDensity) return null;
    if (units === UNITS_DPI) return xDensity;
    if (units === UNITS_DPCM) return Math.round(xDensity * CM_PER_INCH);
    return null;
}

function readImageInfo(buffer, mime) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
    const format = FORMAT_BY_MIME[String(mime || '').toLowerCase()] || (isJpeg(buffer) ? 'jpg' : null);
    if (isJpeg(buffer)) return { ...readJpegInfo(buffer), format: 'jpg' };
    try {
        const size = imageSize(buffer);
        return { width: size.width || null, height: size.height || null, dpi: null, format: format || size.type || null };
    } catch (err) {
        return { width: null, height: null, dpi: null, format };
    }
}

function pixelsToMm(px, dpi) {
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(dpi) || dpi <= 0) return null;
    return Math.max(1, Math.floor((px * INCH_MM) / dpi));
}

module.exports = { isJpeg, readJpegInfo, readImageInfo, pixelsToMm, FORMAT_BY_MIME };
