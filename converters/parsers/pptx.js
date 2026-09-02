/**
 * PPTX → IR
 *
 * 契约：parse({ path }, ctx) → MarkFlowDocument，按绝对路径读取、不写盘，
 * 内嵌图片以 assets 数组返回，由调用方决定落盘位置。
 *
 * PPTX 是 zip 包，涉及的关键成员：
 *   ppt/slides/slideN.xml            — 每页幻灯片（p:sp 形状文本 + p:pic 图片）
 *   ppt/slides/_rels/slideN.xml.rels — 关系表（r:embed → ../media/imageN.png）
 *   ppt/media/*                      — 图片实体
 *   ppt/notesSlides/notesSlideN.xml  — 备注（可选）
 *   docProps/core.xml                — 元数据（含 dc:title）
 *
 * 解析策略（cheerio xmlMode）：
 *   - 遍历每个 p:sp（shape），检查 p:ph type='title'/'ctrTitle' 判断是否为标题
 *   - 收集所有 a:t 文本节点，按 a:p 分段；找不到标题占位符时首段升格为标题
 *   - 按 p:pic 出现顺序取 a:blip/@r:embed，经 rels 映射到 ppt/media 下的实体
 *   - 备注 notesSlide 中所有 a:t 拼为一段
 *
 * IR 输出：每页 slideBreak（带 title/index/notes）+ 正文段落 + 图片段落 + 备注引用块。
 * 图片资源统一编号 images/image_N.<ext>，同一实体被多页引用时只存一份。
 *
 * 不处理：表格、SmartArt、动画、母版继承。
 */
const fsp = require('fs').promises;
const path = require('path');
const cheerio = require('cheerio');
const {
    createDocument,
    createRoot,
    createParagraph,
    createSlideBreak,
    createBlockquote,
} = require('../ir/schema');
const { stripExt } = require('../ir/util');

/** 图片扩展名 → MIME，未收录的回退 application/octet-stream */
const IMAGE_MIME_BY_EXT = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    bmp: 'image/bmp',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    emf: 'image/emf',
    wmf: 'image/wmf',
};
const FALLBACK_MIME = 'application/octet-stream';
const FALLBACK_EXT = 'bin';

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
    const absPath = resolveInputPath(input);
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
        const xml = await zip.file(slidePath).async('text');
        const { title, bodies, picRefs } = parseSlideXml(xml);

        // 图片：按 p:pic 出现顺序解析
        const relMap = await readRels(zip, slidePath);
        const images = [];
        for (const rid of picRefs) {
            const asset = await resolveImageAsset({
                zip,
                relMap,
                rid,
                slideNum,
                assets,
                assetByMedia,
                warnings,
            });
            if (asset) images.push(asset.name);
        }

        // 备注
        let notes = '';
        const notesFile = zip.file(`ppt/notesSlides/notesSlide${slideNum}.xml`);
        if (notesFile) {
            const notesXml = await notesFile.async('text');
            notes = extractAllText(notesXml)
                .filter((t) => t && t.trim())
                .join('\n')
                .trim();
        }

        slidesData.push({ slideNum, title, bodies, notes, images });

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
        for (const name of images) {
            // 行内 image 节点无工厂函数（schema 只保留块级工厂），按 mdast 结构直接构造
            ir.children.push(createParagraph([{ type: 'image', url: name, alt: '' }]));
        }
        if (notes) {
            ir.children.push(createBlockquote([createParagraph(`备注：${notes}`)]));
        }

        notify(ctx, 'parse', Math.round(((i + 1) / slideFiles.length) * 100));
    }

    return createDocument({
        kind: 'presentation',
        ir,
        data: { slides: slidesData, slideCount: slidesData.length },
        meta: {
            title: await resolveTitle(zip, slidesData, sourceName),
            sourceType: 'pptx',
            sourceName,
            slideCount: slidesData.length,
        },
        assets,
        warnings,
    });
}

// ============================================================
// 图片资源
// ============================================================

/**
 * 把一个 r:embed 引用解析成 asset；解析不到时记 warning 并返回 null。
 * 同一媒体实体被多页引用时复用首次分配的 asset（不重复入库）。
 */
async function resolveImageAsset({
    zip,
    relMap,
    rid,
    slideNum,
    assets,
    assetByMedia,
    warnings,
}) {
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

/** 读取 slide 的 .rels，返回 Map<rId, { target, external }>，target 为 zip 内规范路径 */
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
        map.set(id, {
            external,
            target: external ? target : resolveZipPath(slidePath, target),
        });
    });
    return map;
}

/** rels 的 Target 相对于所属部件所在目录；以 / 开头则相对包根 */
function resolveZipPath(ownerPath, target) {
    if (target.startsWith('/')) return target.replace(/^\/+/, '');
    return path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), target));
}

// ============================================================
// XML 文本提取
// ============================================================

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
        const isTitle = phType === 'title' || phType === 'ctrTitle' || phType === 'subTitle';

        // 每个 a:p 是一段；同段内 a:t 拼接
        const paragraphs = [];
        $sp.find('a\\:p').each((_, p) => {
            const text = $(p)
                .find('a\\:t')
                .map((_, t) => $(t).text())
                .get()
                .join('');
            if (text) paragraphs.push(text);
        });

        const fullText = paragraphs.join('\n').trim();
        if (!fullText) return;

        if (isTitle && !title) {
            title = fullText;
        } else {
            bodies.push(fullText);
        }
    });

    // 兜底：没找到 title placeholder 时，把首个 body 升格为 title
    if (!title && bodies.length > 0) {
        title = bodies.shift();
    }

    const picRefs = [];
    $('p\\:pic').each((_, pic) => {
        const rid = $(pic).find('a\\:blip').first().attr('r:embed');
        if (rid) picRefs.push(rid);
    });

    return { title, bodies, picRefs };
}

function extractAllText(xml) {
    try {
        const $ = cheerio.load(xml, { xmlMode: true });
        return $('a\\:t')
            .map((_, t) => $(t).text())
            .get();
    } catch (e) {
        return [];
    }
}

/** 标题优先级：docProps 的 dc:title → 首页标题 → 去扩展名的文件名 */
async function resolveTitle(zip, slidesData, sourceName) {
    const coreFile = zip.file('docProps/core.xml');
    if (coreFile) {
        const coreXml = await coreFile.async('text');
        const m = coreXml.match(/<dc:title>([^<]*)<\/dc:title>/);
        if (m && m[1] && m[1].trim()) return m[1].trim();
    }
    const firstSlideTitle = slidesData[0] && slidesData[0].title;
    return (firstSlideTitle && firstSlideTitle.trim()) || stripExt(sourceName);
}

// ============================================================
// 工具
// ============================================================

function resolveInputPath(input) {
    if (input && typeof input.path === 'string' && input.path) {
        return path.resolve(input.path);
    }
    throw new Error('parsers/pptx 需要 input.path（文件绝对路径）');
}

// 进度回调异常不得影响解析
function notify(ctx, phase, pct) {
    if (!ctx || typeof ctx.onProgress !== 'function') return;
    try {
        ctx.onProgress(phase, pct);
    } catch (err) {
        // 忽略调用方回调自身的异常
    }
}

module.exports = { parse };
