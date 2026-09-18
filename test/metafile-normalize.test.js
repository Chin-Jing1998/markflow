/**
 * converters/assets/metafile-normalize.js 与 image-normalize 图元分支的单元测试（桩后端）
 *
 * 覆盖：按「内容 + 目标像素」去重后只调用一次 rasterize；成功路径（改名、mime、original 留存、IR 同步、
 *       JFIF 密度、像素等于 round(毫米 ÷ 25.4 × jpegPpi)）；取不到显示毫米时按 frame 毫米出图并告警；
 *       目标像素超护栏时按比例缩小并告警；片段页内容；五种回落（后端不可用、转换抛错、后端返回 Error、
 *       出图尺寸不符、空白自检）各一条 S3 告警且资产保持原样、计数正确、其余资产不受影响；
 *       含未支持绘图记录时出图并强告警（含记录名与次数）；双流互校的两个分支；WMF 的处置；
 *       非 patent profile 保持现行为且不触碰后端；restoreOriginals 换回原 EMF；mime 缺失时的魔数嗅探。
 *
 * 夹具一律由 test/helpers/emf-builder.js 现造，不入库任何二进制图元，也不使用任何客户图片。
 */
const { test, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { imageSize } = require('image-size');

const backend = require('../converters/raster/backend');
const { normalizeImages, restoreOriginals, sniffImageMime } = require('../converters/assets/image-normalize');
const { normalizeOptions } = require('../converters/options');
const { loadJimp } = require('../converters/assets/jimp-loader');
const {
    buildEmf, record, rgb, extCreatePen, selectObject, polyline16, emfPlusComment, plusHeader,
} = require('./helpers/emf-builder');

const PNG_MIME = 'image/png';
const EMF_MIME = 'image/x-emf';
/** 参考设备 1000 px / 254000 µm，frame 单位为 0.01 毫米：frame [0,0,2540,1270] 即 25.4 × 12.7 毫米，viewBox 100 × 50 */
const HEADER = { bounds: [0, 0, 99, 49], frame: [0, 0, 2540, 1270] };
/** Word 显示尺寸 20.32 × 10.16 毫米，在 patent 默认的 300 PPI 下即 240 × 120 像素 */
const DISPLAY_MM = { width: 20.32, height: 10.16 };
const TARGET = { width: 240, height: 120 };
/** 取不到显示毫米时退回 frame 毫米：25.4 × 12.7 毫米 → 300 × 150 像素 */
const FRAME_TARGET = { width: 300, height: 150 };
/** EMR_STRETCHDIBITS：位图记录，属未支持的绘图记录 */
const EMR_STRETCHDIBITS = 81;
/** EMR_POLYLINE16 的载荷布局：Bounds(16) + Count(4) + 点数组 */
const EMR_POLYLINE16 = 87;
const POLY_COUNT_OFFSET = 16;

let Jimp;

before(async () => { ({ Jimp } = await loadJimp()); });

afterEach(() => { backend._reset(); });

// ============================================================
// 夹具
// ============================================================

/** 一条粗折线的 EMF；extra 追加在绘图记录之后 */
const drawEmf = (extra = [], header = HEADER) => buildEmf([
    extCreatePen({ handle: 1, width: 4, color: rgb(0, 0, 0) }),
    selectObject(1),
    polyline16([[10, 10], [90, 40]]),
    ...extra,
], header);

/** 另一幅内容不同的 EMF（去重测试用） */
const otherEmf = () => buildEmf([
    extCreatePen({ handle: 1, width: 2, color: rgb(0, 0, 0) }),
    selectObject(1),
    polyline16([[20, 20], [80, 20]]),
], HEADER);

/** 点数字段声称 30 万点、载荷却只有 4 字节：inspectMetafile 照常通过，回放时触发 LIMIT_EXCEEDED */
function overPointsEmf() {
    const payload = Buffer.alloc(24);
    payload.writeUInt32LE(300000, POLY_COUNT_OFFSET);
    return buildEmf([record(EMR_POLYLINE16, payload)], HEADER);
}

/** 前 ink 个像素为黑、其余纯白的 PNG */
async function pngWithInk(width, height, ink) {
    const image = new Jimp({ width, height, color: 0xffffffff });
    const { data } = image.bitmap;
    for (let at = 0; at < Math.min(ink, width * height) * 4; at += 4) {
        data[at] = 0;
        data[at + 1] = 0;
        data[at + 2] = 0;
    }
    return image.getBuffer(PNG_MIME);
}

/** 片段页里 <img> 声明的目标像素 */
function jobSize(html) {
    const matched = /<img width="(\d+)" height="(\d+)"/.exec(html);
    return { width: Number(matched[1]), height: Number(matched[2]) };
}

/**
 * 注册桩后端并返回调用记录。缺省按片段页声明的尺寸出图（尺寸自检恒通过），
 * 每张图带 INK_PIXELS 个非白像素；handler 可覆盖单个作业的产物。
 */
const INK_PIXELS = 8;
function stubBackend(handler) {
    const calls = [];
    backend.registerInProcess({
        name: 'stub',
        rasterize: async (jobs, opts) => {
            calls.push({ ids: jobs.map((job) => job.id), dpi: opts.dpi, htmls: jobs.map((job) => job.html) });
            const out = new Map();
            for (const job of jobs) {
                const custom = handler ? await handler(job) : undefined;
                const size = jobSize(job.html);
                out.set(job.id, custom === undefined ? await pngWithInk(size.width, size.height, INK_PIXELS) : custom);
            }
            return out;
        },
    });
    return calls;
}

const imageNode = (name, mm) => ({
    type: 'image',
    url: name,
    alt: '图',
    data: { assetName: name, ...(mm ? { displayWidthMm: mm.width, displayHeightMm: mm.height } : {}) },
});

function makeDoc(assets, children = []) {
    return {
        schemaVersion: 1,
        kind: 'document',
        ir: { type: 'root', children },
        data: null,
        meta: { title: 'T', sourceType: 'docx' },
        assets,
        extras: [],
        warnings: [],
    };
}

/** 单张 EMF + 一个引用它的 image 节点 */
const singleEmfDoc = (buffer, { name = 'images/image_1.emf', mime = EMF_MIME, mm = DISPLAY_MM } = {}) =>
    makeDoc([{ name, buffer, mime }], [imageNode(name, mm)]);

const patentOptions = (patch = {}) => normalizeOptions({ ...patch, xml: { profile: 'patent', ...(patch.xml || {}) } });

async function makePng(width = 8, height = 8) {
    return new Jimp({ width, height, color: 0xff0000ff }).getBuffer(PNG_MIME);
}

/** JPEG 的 JFIF APP0 密度；无 APP0 返回 null */
function readJfifDensity(buffer) {
    let at = 2;
    while (at + 4 <= buffer.length && buffer[at] === 0xFF) {
        const marker = buffer[at + 1];
        if (marker === 0xDA) return null;
        const length = buffer.readUInt16BE(at + 2);
        if (marker === 0xE0 && buffer.subarray(at + 4, at + 9).toString('latin1') === 'JFIF\x00') {
            return { units: buffer[at + 11], x: buffer.readUInt16BE(at + 12), y: buffer.readUInt16BE(at + 14) };
        }
        at += 2 + length;
    }
    return null;
}

/** JPEG 正中一个像素的亮度（0 黑、255 白） */
async function centerLuma(buffer) {
    const image = await Jimp.read(buffer);
    const at = ((image.height >> 1) * image.width + (image.width >> 1)) * 4;
    return image.bitmap.data[at];
}

// ============================================================
// 批量出图：去重、作业数与后端调用次数
// ============================================================

test('内容与目标像素都相同的图元只出一次图：3 个资产、2 个作业、rasterize 只调用 1 次', async () => {
    // Arrange
    const same = drawEmf();
    const assets = [
        { name: 'images/image_1.emf', buffer: same, mime: EMF_MIME },
        { name: 'images/image_2.emf', buffer: Buffer.from(same), mime: EMF_MIME },
        { name: 'images/image_3.emf', buffer: otherEmf(), mime: EMF_MIME },
    ];
    const doc = makeDoc(assets, assets.map((asset) => imageNode(asset.name, DISPLAY_MM)));
    const calls = stubBackend();

    // Act
    const result = await normalizeImages(doc, patentOptions());

    // Assert
    assert.equal(calls.length, 1, '整份文档只允许启动一次栅格后端');
    assert.deepEqual(calls[0].ids, ['emf-1', 'emf-2']);
    assert.equal(calls[0].dpi, 96, 'dpi 96 即 scale 1，PNG 像素恒等于片段页声明的像素');
    assert.equal(result.converted, 3);
    assert.equal(result.kept, 0);
    assert.deepEqual(result.doc.assets.map((asset) => asset.name), [
        'images/image_1.jpg', 'images/image_2.jpg', 'images/image_3.jpg',
    ]);
});

test('成功路径：改名与 mime、original 留存、IR 同步、JFIF 密度与目标像素', async () => {
    // Arrange
    const emf = drawEmf();
    const doc = singleEmfDoc(emf);
    stubBackend();

    // Act
    const result = await normalizeImages(doc, patentOptions());

    // Assert
    const [asset] = result.doc.assets;
    assert.equal(result.converted, 1);
    assert.equal(result.kept, 0);
    assert.equal(asset.name, 'images/image_1.jpg');
    assert.equal(asset.mime, 'image/jpeg');
    assert.equal(asset.buffer.subarray(0, 2).toString('hex'), 'ffd8');
    assert.deepEqual(asset.original, { name: 'images/image_1.emf', buffer: emf, mime: EMF_MIME });

    const [node] = result.doc.ir.children;
    assert.equal(node.url, 'images/image_1.jpg');
    assert.equal(node.data.assetName, 'images/image_1.jpg');

    assert.deepEqual(readJfifDensity(asset.buffer), { units: 1, x: 300, y: 300 });
    const { width, height } = imageSize(asset.buffer);
    assert.deepEqual({ width, height }, TARGET, '像素 = round(毫米 ÷ 25.4 × jpegPpi)');
    // S0：逐图不告警，整份文档只有一条汇总提示
    assert.deepEqual(result.warnings, ['已由内置图元渲染器把 1 幅 EMF 图转为 JPG，提交前请对照原稿目视核对']);
});

test('目标像素随 jpegPpi 走：150 PPI 得一半像素，JFIF 密度同为 150', async () => {
    // Arrange
    stubBackend();

    // Act
    const result = await normalizeImages(singleEmfDoc(drawEmf()), patentOptions({ jpegPpi: 150 }));

    // Assert
    const [asset] = result.doc.assets;
    const { width, height } = imageSize(asset.buffer);
    assert.deepEqual({ width, height }, { width: 120, height: 60 });
    assert.deepEqual(readJfifDensity(asset.buffer), { units: 1, x: 150, y: 150 });
});

test('取不到显示毫米时按图元自身的 frame 毫米出图并告警', async () => {
    // Arrange：image 节点存在但没有 displayWidthMm（VML 承载的 OLE 预览图即属此类）
    const doc = singleEmfDoc(drawEmf(), { mm: null });
    stubBackend();

    // Act
    const result = await normalizeImages(doc, patentOptions());

    // Assert
    const [asset] = result.doc.assets;
    const { width, height } = imageSize(asset.buffer);
    assert.deepEqual({ width, height }, FRAME_TARGET);
    assert.match(
        result.warnings[0],
        /^图片 images\/image_1\.emf 未按 Word 显示尺寸出图：源文档中未记录该图的显示尺寸，已按图元自身的 25\.4×12\.7 毫米幅面输出$/,
    );
});

test('目标像素超护栏时按比例缩小并告警', async () => {
    // Arrange：1355 × 0.085 毫米在 300 PPI 下单边超过 16000 px
    const doc = singleEmfDoc(drawEmf(), { mm: { width: 1355, height: 0.085 } });
    stubBackend();

    // Act
    const result = await normalizeImages(doc, patentOptions());

    // Assert
    const { width } = imageSize(result.doc.assets[0].buffer);
    assert.ok(width <= 16000 && width > 15000, `实际宽度 ${width}`);
    assert.match(result.warnings[0], /^图片 images\/image_1\.emf 已按比例缩小出图：目标 16004×1 超过单边 16000 px 的上限，实际输出 /);
});

test('片段页：CSP 无 script-src、正文只有一个 <img>、宽高为目标像素、整页无脚本', async () => {
    // Arrange
    const calls = stubBackend();

    // Act
    await normalizeImages(singleEmfDoc(drawEmf()), patentOptions());

    // Assert
    const [html] = calls[0].htmls;
    assert.ok(html.includes("content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\""));
    assert.equal(html.includes('script-src'), false);
    assert.equal(html.includes('<script'), false);
    const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));
    assert.equal(body.split('<').length - 1, 1, '正文只有一个元素');
    assert.match(body, /^<img width="240" height="120" alt="" src="data:image\/svg\+xml;base64,/);
});

// ============================================================
// 五种回落：一律 S3「保持原格式」，其余资产不受影响
// ============================================================

const FAIL_TAIL = '。国知局只受理 JPG 与 TIF，请在 Word 中把该图另存为图片后替换';
// reason 允许带正则片段；全角括号与顿号在正则里都是普通字符
const failPattern = (reason) => new RegExp(
    `^图片 images/image_1\\.emf 保持原格式：EMF/WMF 图元渲染失败（${reason}）${FAIL_TAIL}$`,
);

/** 一张 EMF 与一张 PNG 同处一份文档：EMF 走回落时 PNG 仍须照常转码 */
async function docWithCompanion(emf) {
    return makeDoc(
        [
            { name: 'images/image_1.emf', buffer: emf, mime: EMF_MIME },
            { name: 'images/image_2.png', buffer: await makePng(), mime: PNG_MIME },
        ],
        [imageNode('images/image_1.emf', DISPLAY_MM), imageNode('images/image_2.png', DISPLAY_MM)],
    );
}

/** EMF 保持原样、PNG 照常转码、计数正确 */
function assertKeptEmf(result, doc, reason) {
    assert.equal(result.converted, 1, 'PNG 仍应转码');
    assert.equal(result.kept, 1);
    assert.equal(result.doc.assets[0].name, 'images/image_1.emf');
    assert.equal(result.doc.assets[0].buffer, doc.assets[0].buffer, '图元字节原样保留');
    assert.equal(result.doc.assets[0].mime, EMF_MIME);
    assert.equal(result.doc.assets[1].name, 'images/image_2.jpg');
    assert.equal(result.warnings.length, 1, '回落只报一条告警，不再有 S0 汇总以外的噪声');
    assert.match(result.warnings[0], failPattern(reason));
}

test('回落一：栅格后端不可用', async () => {
    // Arrange
    backend._setDeps({ electronPath: null });
    const doc = await docWithCompanion(drawEmf());

    // Act
    const result = await normalizeImages(doc, patentOptions());

    // Assert
    assertKeptEmf(result, doc, '栅格化后端不可用：[\\s\\S]+');
});

test('回落二：metafileToSvg 抛错（点数超上限）', async () => {
    // Arrange
    const doc = await docWithCompanion(overPointsEmf());
    stubBackend();

    // Act
    const result = await normalizeImages(doc, patentOptions());

    // Assert
    assertKeptEmf(result, doc, '转换失败：单条记录点数 300000 超过上限（200000）');
});

test('回落三：后端对该作业返回 Error', async () => {
    // Arrange
    const doc = await docWithCompanion(drawEmf());
    stubBackend((job) => (job.id === 'emf-1' ? new Error('离屏窗口加载超时') : undefined));

    // Act
    const result = await normalizeImages(doc, patentOptions());

    // Assert
    assertKeptEmf(result, doc, '后端未出图：离屏窗口加载超时');
});

test('回落四：出图尺寸与目标不符', async () => {
    // Arrange
    const doc = await docWithCompanion(drawEmf());
    stubBackend(async (job) => (job.id === 'emf-1' ? pngWithInk(120, 60, INK_PIXELS) : undefined));

    // Act
    const result = await normalizeImages(doc, patentOptions());

    // Assert
    assertKeptEmf(result, doc, '出图尺寸 120×60 与目标 240×120 不符');
});

test('回落五：空白自检——扫描显示有绘图记录而出图全白', async () => {
    // Arrange
    const doc = await docWithCompanion(drawEmf());
    stubBackend(async (job) => (job.id === 'emf-1' ? pngWithInk(TARGET.width, TARGET.height, 0) : undefined));

    // Act
    const result = await normalizeImages(doc, patentOptions());

    // Assert
    assertKeptEmf(result, doc, '出图为空白，但扫描显示该图元含绘图记录');
});

test('WMF 保持原格式，告警里点明是 WMF', async () => {
    // Arrange：Aldus 可置放 WMF 的魔数
    const wmf = Buffer.concat([Buffer.from([0xD7, 0xCD, 0xC6, 0x9A]), Buffer.alloc(20)]);
    const doc = makeDoc([{ name: 'images/image_1.wmf', buffer: wmf, mime: 'image/x-wmf' }]);
    stubBackend();

    // Act
    const result = await normalizeImages(doc, patentOptions());

    // Assert
    assert.equal(result.converted, 0);
    assert.equal(result.kept, 1);
    assert.equal(result.doc, doc, '零改动时原样返回入参 doc');
    assert.equal(
        result.warnings[0],
        `图片 images/image_1.wmf 保持原格式：EMF/WMF 图元渲染失败（文件是 WMF 图元，本版本只能渲染 EMF）${FAIL_TAIL}`,
    );
});

// ============================================================
// S2：未支持的绘图记录
// ============================================================

test('含未支持的绘图记录时照常出图，并强告警列出记录名与次数', async () => {
    // Arrange
    const doc = singleEmfDoc(drawEmf([record(EMR_STRETCHDIBITS, Buffer.alloc(80))]));
    stubBackend();

    // Act
    const result = await normalizeImages(doc, patentOptions());

    // Assert
    assert.equal(result.converted, 1);
    assert.equal(result.doc.assets[0].name, 'images/image_1.jpg');
    assert.equal(
        result.warnings[0],
        '图片 images/image_1.emf 含内置渲染器尚未支持的图元记录（EMR_STRETCHDIBITS×1），'
        + '已按可识别部分出图，该图可能缺失内容，提交前必须对照原稿核对',
    );
});

// ============================================================
// 双流互校
// ============================================================

const dualEmf = () => drawEmf([emfPlusComment([plusHeader({ dual: true })])]);
const ALL_PIXELS = TARGET.width * TARGET.height;

test('双流互校：EMF+ 路径墨量不足经典路径的 90% 时改用经典路径出图并告警', async () => {
    // Arrange：auto 只有 4 个非白像素，classic 整幅全黑
    const calls = stubBackend(async (job) => (job.id === 'emf-1'
        ? pngWithInk(TARGET.width, TARGET.height, 4)
        : pngWithInk(TARGET.width, TARGET.height, ALL_PIXELS)));

    // Act
    const result = await normalizeImages(singleEmfDoc(dualEmf()), patentOptions());

    // Assert
    assert.deepEqual(calls[0].ids, ['emf-1', 'emf-1c'], 'Dual 图元多出一个只回放经典记录的作业');
    assert.equal(result.converted, 1);
    assert.equal(
        result.warnings[0],
        `图片 images/image_1.emf 改用经典 EMR 记录出图：EMF+ 记录的墨量（4 像素）不足经典记录（${ALL_PIXELS} 像素）的 90%，`
        + '该图可能有漏画，提交前请对照原稿核对',
    );
    assert.ok(await centerLuma(result.doc.assets[0].buffer) < 64, '出图应取自经典路径（全黑）');
});

test('双流互校：经典路径墨量偏少时以 auto 为准，不告警', async () => {
    // Arrange：auto 整幅全黑，classic 只有 4 个非白像素
    stubBackend(async (job) => (job.id === 'emf-1'
        ? pngWithInk(TARGET.width, TARGET.height, ALL_PIXELS)
        : pngWithInk(TARGET.width, TARGET.height, 4)));

    // Act
    const result = await normalizeImages(singleEmfDoc(dualEmf()), patentOptions());

    // Assert
    assert.equal(result.converted, 1);
    assert.deepEqual(result.warnings, ['已由内置图元渲染器把 1 幅 EMF 图转为 JPG，提交前请对照原稿目视核对']);
    assert.ok(await centerLuma(result.doc.assets[0].buffer) < 64, '出图应取自 auto 路径（全黑）');
});

// ============================================================
// profile 边界、原图还原与魔数嗅探
// ============================================================

test('非 patent profile：图元保持原样并告警，且不触碰栅格后端', async () => {
    // Arrange
    const doc = singleEmfDoc(drawEmf());
    const calls = stubBackend();

    // Act
    const result = await normalizeImages(doc, normalizeOptions());

    // Assert
    assert.equal(calls.length, 0);
    assert.equal(result.converted, 0);
    assert.equal(result.kept, 1);
    assert.equal(result.doc, doc);
    assert.deepEqual(result.warnings, [
        '图片 images/image_1.emf 保持原格式：EMF/WMF 图元只在专利（patent）profile 下栅格化为 JPG',
    ]);
});

test('restoreOriginals 把归一后的 .jpg 换回原 EMF，IR 同步改回', async () => {
    // Arrange
    const emf = drawEmf();
    stubBackend();
    const normalized = await normalizeImages(singleEmfDoc(emf), patentOptions());

    // Act
    const restored = restoreOriginals(normalized.doc);

    // Assert
    const [asset] = restored.assets;
    assert.equal(asset.name, 'images/image_1.emf');
    assert.equal(asset.mime, EMF_MIME);
    assert.ok(asset.buffer.equals(emf));
    assert.equal(asset.original, undefined);
    assert.equal(restored.ir.children[0].url, 'images/image_1.emf');
    assert.equal(restored.ir.children[0].data.assetName, 'images/image_1.emf');
});

test('mime 缺失但魔数为 EMF 的资产照常出图；sniffImageMime 同时识别 WMF', async () => {
    // Arrange
    const emf = drawEmf();
    const doc = singleEmfDoc(emf, { name: 'images/image_1.bin', mime: undefined });
    stubBackend();

    // Act
    const result = await normalizeImages(doc, patentOptions());

    // Assert
    assert.equal(sniffImageMime(emf), EMF_MIME);
    assert.equal(sniffImageMime(Buffer.concat([Buffer.from([0xD7, 0xCD, 0xC6, 0x9A]), Buffer.alloc(20)])), 'image/x-wmf');
    assert.equal(result.converted, 1);
    assert.equal(result.doc.assets[0].name, 'images/image_1.jpg');
    const { width, height } = imageSize(result.doc.assets[0].buffer);
    assert.deepEqual({ width, height }, TARGET);
});
