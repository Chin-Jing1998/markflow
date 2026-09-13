/**
 * jimp 懒加载器（CJS 侧组装带 WebP 解码能力的 Jimp）
 *
 * jimp 1.6 的 CJS 出口自带 bmp/gif/jpeg/png/tiff 五种格式，WebP 须外挂 @jimp/wasm-webp。
 * 但该插件在 Node 下不能直接用，原因有二，故本模块自行组装：
 *   1) @jimp/wasm-webp 的 decode 每次调用都无参调用 @jsquash/webp 的 init()，而无参 init 走
 *      emscripten 的 fetch(wasm 文件) 路径；Node 的 fetch 不支持 file:// 协议，直接抛
 *      「fetch failed」。本模块改为自行读取并编译 codec/dec/webp_dec.wasm 后调 init(module)
 *      预置解码器，再用该解码器替换格式对象的 decode，只沿用插件给出的格式描述（mime/hasAlpha）。
 *   2) WebP 编码（enc wasm）在 Node 下同样取不到 wasm，且本项目只输出 JPEG，故 encode 一律报中文错误。
 *
 * 缓存的是 Promise 而非结果：并发的首次调用共享同一次加载；加载失败则清空缓存，允许重试
 * （同 converters/ir/unified-loader.js）。WebP 不可用不阻断整体加载——返回 webpSupported:false
 * 与中文原因，由调用方降级为「保持原格式 + warning」。
 *
 * 返回：{ Jimp, webpSupported, webpError }
 */
const fsp = require('fs').promises;
const { errText } = require('../util');

// @jsquash/webp 无 exports 字段，可按子路径直接解析到 wasm 文件
const WEBP_WASM_REQUEST = '@jsquash/webp/codec/dec/webp_dec.wasm';
const WEBP_DECODER_REQUEST = '@jsquash/webp/decode.js';

let pending = null;

async function loadJimp() {
    if (!pending) {
        pending = assemble().catch((err) => {
            pending = null;
            throw err;
        });
    }
    return pending;
}

async function assemble() {
    let core;
    let jimp;
    try {
        [core, jimp] = await Promise.all([import('@jimp/core'), import('jimp')]);
    } catch (err) {
        throw new Error(`图片处理库 jimp 加载失败（${errText(err)}）：请在项目根目录执行 npm install 安装 jimp 与 @jimp/core`);
    }

    const { format, error } = await loadWebpFormat();
    const formats = format ? [...jimp.defaultFormats, format] : [...jimp.defaultFormats];
    const Jimp = core.createJimp({ formats, plugins: jimp.defaultPlugins });
    return Object.freeze({ Jimp, webpSupported: Boolean(format), webpError: error });
}

// WebP 解码器：失败不抛出，以 { format: null, error } 形式降级
async function loadWebpFormat() {
    try {
        const [plugin, decoder] = await Promise.all([import('@jimp/wasm-webp'), import(WEBP_DECODER_REQUEST)]);
        const wasm = await WebAssembly.compile(await fsp.readFile(require.resolve(WEBP_WASM_REQUEST)));
        await decoder.init(wasm);
        const descriptor = plugin.default();
        const format = () => ({
            ...descriptor,
            encode: () => { throw new Error('MarkFlow 不输出 WebP：位图一律归一为 JPEG'); },
            decode: async (data) => {
                const decoded = await decoder.default(toArrayBuffer(data));
                const { buffer, byteOffset, byteLength } = decoded.data;
                return { data: Buffer.from(buffer, byteOffset, byteLength), width: decoded.width, height: decoded.height };
            },
        });
        return { format, error: null };
    } catch (err) {
        return { format: null, error: `WebP 解码器不可用（${errText(err)}）` };
    }
}

// @jsquash 的 decode 只接受 ArrayBuffer；Buffer 常是大池子的视图，须按视图范围切出
function toArrayBuffer(data) {
    if (data instanceof ArrayBuffer) return data;
    const view = ArrayBuffer.isView(data) ? data : Buffer.from(data);
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

module.exports = { loadJimp };
