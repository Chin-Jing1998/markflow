/**
 * PPTX → IR
 *
 * 契约：parse({ path }, ctx) → MarkFlowDocument，按绝对路径读取、不写盘，
 * 内嵌图片以 assets 数组返回，由调用方决定落盘位置。
 *
 * PPTX 是 zip 包，涉及的关键成员：ppt/slides/slideN.xml（p:sp 形状文本 + p:pic 图片）、
 * ppt/slides/_rels/slideN.xml.rels（r:embed → ../media/imageN.png；notesSlide 关系）、
 * ppt/media/*（图片实体）、ppt/notesSlides/*（备注，可选）、docProps/core.xml（dc:title 取标题、
 * dc:creator 取作者，经 ir/util.normalizeAuthor 归一；作者为空或是占位名时 meta 不设 author 键）。
 *
 * 解析策略（cheerio xmlMode）：遍历每个 p:sp，按 p:ph type='title'/'ctrTitle' 判断标题
 * （subTitle 属副标题，仍作正文），收集 a:t 文本并按 a:p 分段，找不到标题占位符时首段升格
 * 为标题；按 p:pic 出现顺序取 a:blip/@r:embed 并经 rels 映射到 ppt/media 下的实体；
 * 备注页一律经本页 rels 中 Type 以 /notesSlide 结尾的关系定位（文件名与页码并不保证一致），
 * 其中所有 a:t 拼为一段。
 *
 * IR 输出：每页 slideBreak（带 title/index/notes）+ 正文段落 + 图片段落 + 备注引用块。
 * 图片资源统一编号 images/image_N.<ext>，同一实体被多页引用时只存一份。
 *
 * 不处理：表格、SmartArt、动画、母版继承。
 */
const fsp = require('fs').promises;
const path = require('path');
const cheerio = require('cheerio');
const { createDocument, createRoot, createParagraph, createSlideBreak, createBlockquote } = require('../ir/schema');
const { stripExt, normalizeAuthor } = require('../ir/util');
const { notify } = require('../util');

/** 图片扩展名 → MIME，未收录的回退 application/octet-stream */
const IMAGE_MIME_BY_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
    webp: 'image/webp', svg: 'image/svg+xml', emf: 'image/emf', wmf: 'image/wmf',
};
const FALLBACK_MIME = 'application/octet-stream';
const FALLBACK_EXT = 'bin';
// 备注页关系类型，形如 .../relationships/notesSlide
const NOTES_REL_TYPE_RE = /\/notesSlide$/;
// 进度百分比区间：parser 只报 parsing 阶段，按已解析页数比例映射到该区间
const PROGRESS_MIN = 20;
const PROGRESS_MAX = 55;
// DrawingML 长度单位：1 px（96 dpi）= 9525 EMU
const EMU_PER_PX = 9525;

let JSZip = null;
function loadJSZip() {
    if (!JSZip) JSZip = require('jszip');
    return JSZip;
}

/**
 * @param {{ path: string }} input 源文件绝对路径
 * @param {{ sourceName?: string, onProgress?: Function }} [ctx]
 */
async function parse(input, ctx = {}) {
    if (!input || typeof input.path !== 'string' || !input.path) {
        throw new Error('parsers/pptx 需要 input.path（文件绝对路径）');
    }
    const absPath = path.resolve(input.path);
    const sourceName = ctx.sourceName || path.basename(absPath);

    const buffer = await fsp.readFile(absPath);
    const zip = await loadJSZip().loadAsync(buffer);

    // 找所有 slide 文件，按编号排序
    const slideFiles = Object.keys(zip.files)
        .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort((a, b) => extractSlideNum(a) - extractSlideNum(b));
    if (slideFiles.length === 0) {
        throw new Error('PPTX 中未找到 slide 文件');
    }

    const slidesData = [];
    const assets = [];
    const warnings = [];
    // zip 内媒体路径 → 已分配的 asset（去重用）
    const assetByMedia = new Map();
    const ir = createRoot();

    for (let i = 0; i < slideFiles.length; i++) {
        const slidePath = slideFiles[i];
        const slideNum = extractSlideNum(slidePath);
        const { title, bodies, picRefs } = parseSlideXml(await zip.file(slidePath).async('text'));

        // 图片：按 p:pic 出现顺序解析；显示尺寸取自本页形状的 a:ext（同一媒体在各页可以不同）
        const relMap = await readRels(zip, slidePath);
        const images = [];
        for (const ref of picRefs) {
            const asset = await resolveImageAsset({ zip, relMap, rid: ref.rid, slideNum, assets, assetByMedia, warnings });
            if (asset) images.push({ name: asset.name, display: displayFromExtent(ref) });
        }

        const notes = await readNotes(zip, relMap);
        slidesData.push({ slideNum, title, bodies, notes, images: images.map((image) => image.name) });

        // IR 构建：slideBreak → 正文段落 → 图片段落 → 备注
        ir.children.push(createSlideBreak({ title, index: i, notes }));
        for (const body of bodies) {
            if (!body) continue;
            // body 内含 \n 分隔的多段，拆分成独立段落
            for (const para of body.split('\n')) {
                const trimmed = para.trim();
                if (trimmed) ir.children.push(createParagraph(trimmed));
            }
        }
        for (const image of images) {
            // 行内 image 节点无工厂函数（schema 只保留块级工厂），按 mdast 结构直接构造
            const node = { type: 'image', url: image.name, alt: '' };
            if (image.display) node.data = { display: image.display };
            ir.children.push(createParagraph([node]));
        }
        if (notes) {
            ir.children.push(createBlockquote([createParagraph(`备注：${notes}`)]));
        }

        const ratio = (i + 1) / slideFiles.length;
        notify(ctx, 'parsing', PROGRESS_MIN + Math.round(ratio * (PROGRESS_MAX - PROGRESS_MIN)));
    }

    const core = await readCoreProps(zip);
    return createDocument({
        kind: 'presentation',
        ir,
        data: { slides: slidesData, slideCount: slidesData.length },
        meta: {
            title: resolveTitle(core.title, slidesData, sourceName),
            // 作者为空时不设该键：meta 与 front matter 均与引入作者之前逐字节一致
            ...(core.creator ? { author: core.creator } : {}),
            sourceType: 'pptx',
            sourceName,
            slideCount: slidesData.length,
        },
        assets,
        warnings,
    });
}

// ---------- 图片资源 ----------

/**
 * 把一个 r:embed 引用解析成 asset；解析不到时记 warning 并返回 null。
 * 同一媒体实体被多页引用时复用首次分配的 asset（不重复入库）。
 */
async function resolveImageAsset({ zip, relMap, rid, slideNum, assets, assetByMedia, warnings }) {
    const rel = relMap.get(rid);
    if (!rel) {
        warnings.push(`第 ${slideNum} 页图片引用 ${rid} 在关系表中缺失，已跳过`);
        return null;
    }
    if (rel.external) {
        warnings.push(`第 ${slideNum} 页图片为外部链接（${rel.target}），未内嵌`);
        return null;
    }

    const cached = assetByMedia.get(rel.target);
    if (cached) return cached;

    const file = zip.file(rel.target);
    if (!file) {
        warnings.push(`第 ${slideNum} 页图片 ${rel.target} 在 PPTX 包内不存在，已跳过`);
        return null;
    }

    const ext = path.posix.extname(rel.target).replace(/^\./, '').toLowerCase();
    const asset = {
        name: `images/image_${assets.length + 1}.${ext || FALLBACK_EXT}`,
        buffer: await file.async('nodebuffer'),
        mime: IMAGE_MIME_BY_EXT[ext] || FALLBACK_MIME,
    };
    assets.push(asset);
    assetByMedia.set(rel.target, asset);
    return asset;
}

/** 读取 slide 的 .rels，返回 Map<rId, { type, target, external }>，target 为 zip 内规范路径 */
async function readRels(zip, slidePath) {
    const relsPath = `${path.posix.dirname(slidePath)}/_rels/${path.posix.basename(slidePath)}.rels`;
    const map = new Map();
    const file = zip.file(relsPath);
    if (!file) return map;

    const $ = cheerio.load(await file.async('text'), { xmlMode: true });
    $('Relationship').each((_, el) => {
        const id = $(el).attr('Id');
        const target = $(el).attr('Target');
        if (!id || !target) return;
        const external = String($(el).attr('TargetMode') || '').toLowerCase() === 'external';
        const type = String($(el).attr('Type') || '');
        map.set(id, { external, type, target: external ? target : resolveZipPath(slidePath, target) });
    });
    return map;
}

/** rels 的 Target 相对于所属部件所在目录；以 / 开头则相对包根 */
const resolveZipPath = (ownerPath, target) => (target.startsWith('/')
    ? target.replace(/^\/+/, '')
    : path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), target)));

// ---------- XML 文本提取 ----------

function extractSlideNum(filename) {
    const m = filename.match(/slide(\d+)\.xml$/);
    return m ? parseInt(m[1], 10) : 0;
}

/** 一次 load 同时取出标题、正文段落与图片引用，避免重复解析 XML */
function parseSlideXml(xml) {
    const $ = cheerio.load(xml, { xmlMode: true });
    let title = '';
    const bodies = [];

    $('p\\:sp').each((_, sp) => {
        const $sp = $(sp);
        const phType = $sp.find('p\\:ph').first().attr('type');
        // subTitle 是副标题占位符，升格为标题会顶掉真正的 title，故只认 title/ctrTitle
        const isTitle = phType === 'title' || phType === 'ctrTitle';

        // 每个 a:p 是一段；同段内 a:t 拼接
        const paragraphs = [];
        $sp.find('a\\:p').each((_, p) => {
            const text = $(p).find('a\\:t').map((_, t) => $(t).text()).get().join('');
            if (text) paragraphs.push(text);
        });

        const fullText = paragraphs.join('\n').trim();
        if (!fullText) return;
        if (isTitle && !title) title = fullText;
        else bodies.push(fullText);
    });

    // 兜底：没找到 title placeholder 时，把首个 body 升格为 title
    if (!title && bodies.length > 0) title = bodies.shift();

    // 图片引用连同形状的显示尺寸（p:spPr/a:xfrm/a:ext，EMU）一并取出，位置顺序不变
    const picRefs = [];
    $('p\\:pic').each((_, pic) => {
        const $pic = $(pic);
        const rid = $pic.find('a\\:blip').first().attr('r:embed');
        if (!rid) return;
        const $ext = $pic.children('p\\:spPr').children('a\\:xfrm').children('a\\:ext').first();
        picRefs.push({ rid, cx: Number($ext.attr('cx')) || 0, cy: Number($ext.attr('cy')) || 0 });
    });

    return { title, bodies, picRefs };
}

/** a:ext 的 EMU 尺寸 → data.display（px）；取不到宽度返回 null */
function displayFromExtent({ cx, cy }) {
    const width = Math.round(cx / EMU_PER_PX);
    if (!(width >= 1)) return null;
    const display = { width };
    const height = Math.round(cy / EMU_PER_PX);
    if (height >= 1) display.height = height;
    display.unit = 'px';
    display.source = 'pptx';
    return display;
}

/**
 * 备注页所有 a:t 拼为一段；无备注返回空串，XML 解析失败按无备注处理。
 * 备注文件名不保证与页码一致（删页后 slide3 可能配 notesSlide2.xml），只能经 rels 定位。
 */
async function readNotes(zip, relMap) {
    const rel = [...relMap.values()].find((r) => !r.external && NOTES_REL_TYPE_RE.test(r.type));
    const file = rel && zip.file(rel.target);
    if (!file) return '';
    const xml = await file.async('text');
    let texts = [];
    try {
        const $ = cheerio.load(xml, { xmlMode: true });
        texts = $('a\\:t').map((_, t) => $(t).text()).get();
    } catch (e) { /* 解析失败按无备注处理 */ }
    return texts.filter((t) => t && t.trim()).join('\n').trim();
}

/** 标题优先级：docProps 的 dc:title → 首页标题 → 去扩展名的文件名 */
function resolveTitle(coreTitle, slidesData, sourceName) {
    if (coreTitle) return coreTitle;
    const firstSlideTitle = slidesData[0] && slidesData[0].title;
    return (firstSlideTitle && firstSlideTitle.trim()) || stripExt(sourceName);
}

/**
 * 从 docProps/core.xml 取 dc:title 与 dc:creator；标题去首尾空白，作者经 normalizeAuthor 归一
 * （去首尾空白并滤掉占位名）。core.xml 缺失或解析失败一律按空串处理
 */
async function readCoreProps(zip) {
    const empty = { title: '', creator: '' };
    const coreFile = zip.file('docProps/core.xml');
    if (!coreFile) return empty;
    const xml = await coreFile.async('text');
    try {
        // 用 XML 解析而非正则，否则 &amp; 等实体不会被还原
        const $ = cheerio.load(xml, { xmlMode: true });
        return { title: $('dc\\:title').first().text().trim(), creator: normalizeAuthor($('dc\\:creator').first().text()) };
    } catch (err) {
        return empty;
    }
}


module.exports = { parse };
