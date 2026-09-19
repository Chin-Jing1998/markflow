/**
 * patent profile 的图片资源登记：把 IR 里的资产名（images/image_3.jpg）映射为官方案卷结构下的图片文件
 *
 * createAssetRegistry(docAssets) → registry
 *   forBook(code) → { use(assetName) → { file, asset } | null }
 *     code 为该书的表格代码（100001–100005，由 patent.js 的 BOOK_CODES 给出），同时是该书的目录名。
 *     首次使用时分配裸文件名 <code>_<序号>.<原扩展名>（imageFileName）：序号自 IMAGE_SEQ_START 起、不补零，
 *     按该书内首次使用顺序递增；非 JPG 的遗留图片（如尚未栅格化的 .emf）同样按此命名、保留原扩展名。
 *     同书内同一资产再次使用返回同一文件名；不同书各自计数、各自落盘一份（官方的摘要附图 100005_1.jpg 与
 *     说明书附图 100003_N.jpg 即两份独立文件）。资产不存在返回 null，且不占用序号。
 *   list(codes?) → [{ name: '<code>/<file>', buffer, mime }]
 *     name 为相对产物目录的 posix 路径（图片与所属 XML 同目录），供渲染器作为 assets 返回并写入 zip；
 *     给出 codes 时只列这些书的图片并按其顺序（未输出的书不落盘图片），缺省按各书首次登记顺序；书内按序号。
 *   unused() → 未被任何一书引用的资产名列表
 * img/@file 只写裸文件名 file：官方产出的 XML 与图片同目录（研究报告 §4.4）。
 * 推定：同一书内的全部图片（附图、公式、表格、化学式、段内图片）共用一个计数器。官方样稿的 100002 内只有
 * 公式图、100003 与 100005 内只有附图，无法直接验证几类图片混排时是否分别计数；命名规则集中于下方常量，
 * 日后取得混排样稿核对后只需改这一处。
 */
const path = require('path');

const IMAGE_SEQ_START = 1;
const IMAGE_SEQ_SEPARATOR = '_';
const DEFAULT_EXT = '.jpg';
const BOOK_CODE_RE = /^[0-9A-Za-z]+$/;

const imageFileName = (code, seq, ext) => `${code}${IMAGE_SEQ_SEPARATOR}${seq}${ext}`;
const imagePath = (code, file) => `${code}/${file}`;

function createAssetRegistry(docAssets) {
    const byName = indexAssets(docAssets);
    // 表格代码 → Map<资产名, { file, asset }>（Map 的插入顺序即序号顺序）
    const books = new Map();
    const referenced = new Set();

    function forBook(code) {
        if (typeof code !== 'string' || !BOOK_CODE_RE.test(code)) throw new Error(`图片登记需要合法的表格代码：${String(code)}`);
        if (!books.has(code)) books.set(code, new Map());
        const used = books.get(code);
        return {
            use(assetName) {
                if (typeof assetName !== 'string' || !byName.has(assetName)) return null;
                if (used.has(assetName)) return used.get(assetName);
                const ext = path.posix.extname(assetName).toLowerCase() || DEFAULT_EXT;
                const entry = { file: imageFileName(code, IMAGE_SEQ_START + used.size, ext), asset: byName.get(assetName) };
                used.set(assetName, entry);
                referenced.add(assetName);
                return entry;
            },
        };
    }

    function list(codes) {
        const order = Array.isArray(codes) ? codes.filter((code) => books.has(code)) : [...books.keys()];
        return order.flatMap((code) => [...books.get(code).values()]
            .map(({ file, asset }) => ({ name: imagePath(code, file), buffer: asset.buffer, mime: asset.mime })));
    }

    return { forBook, list, unused: () => [...byName.keys()].filter((name) => !referenced.has(name)) };
}

// 资产名 → 资产（同名只认第一份；缺名或缺 Buffer 的条目忽略）
function indexAssets(docAssets) {
    const byName = new Map();
    for (const asset of Array.isArray(docAssets) ? docAssets : []) {
        if (asset && typeof asset.name === 'string' && asset.name && Buffer.isBuffer(asset.buffer) && !byName.has(asset.name)) {
            byName.set(asset.name, asset);
        }
    }
    return byName;
}

module.exports = { createAssetRegistry, imageFileName, IMAGE_SEQ_START };
