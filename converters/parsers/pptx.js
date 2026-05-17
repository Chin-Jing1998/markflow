/**
 * PPTX → IR
 *
 * PPTX 是 zip 包。结构关键文件：
 *   ppt/slides/slideN.xml          — 每页幻灯片（含 p:sp 形状 + a:t 文本）
 *   ppt/notesSlides/notesSlideN.xml — 备注（可选）
 *   docProps/core.xml               — 元数据（含 dc:title）
 *
 * 解析策略（cheerio xmlMode）：
 *   - 遍历每个 p:sp（shape），检查 p:ph type='title'/'ctrTitle' 判断是否为标题
 *   - 收集所有 a:t 文本节点，按 a:p 分段
 *   - 找不到标题占位符时，把第一段文字升格为标题
 *   - 备注 notesSlide 中所有 a:t 拼为一段
 *
 * IR 输出：每页 slideBreak（带 title/index/notes 元数据）+ 正文段落
 * data 字段保留 slides 数组快照，便于 JSON 输出与 PPTX 反向写。
 *
 * 不处理：图片提取（推 P2/P3）、表格、SmartArt、动画。
 */
const cheerio = require('cheerio');
const path = require('path');
const {
    createDocument,
    createRoot,
    createParagraph,
    createSlideBreak,
    createBlockquote,
} = require('../ir/schema');

let JSZip = null;
function loadJSZip() {
    if (!JSZip) JSZip = require('jszip');
    return JSZip;
}

async function parse(buffer, meta = {}) {
    if (!Buffer.isBuffer(buffer)) {
        throw new Error('parsers/pptx 期望 source 为 Buffer');
    }

    const Zip = loadJSZip();
    const zip = await Zip.loadAsync(buffer);

    // 找所有 slide 文件，按编号排序
    const slideFiles = Object.keys(zip.files)
        .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
        .sort((a, b) => extractSlideNum(a) - extractSlideNum(b));

    if (slideFiles.length === 0) {
        throw new Error('PPTX 中未找到 slide 文件');
    }

    const slidesData = [];
    const ir = createRoot();

    for (let i = 0; i < slideFiles.length; i++) {
        const slidePath = slideFiles[i];
        const slideNum = extractSlideNum(slidePath);
        const xml = await zip.file(slidePath).async('text');
        const { title, bodies } = extractSlideText(xml);

        // 备注
        let notes = '';
        const notesPath = `ppt/notesSlides/notesSlide${slideNum}.xml`;
        const notesFile = zip.file(notesPath);
        if (notesFile) {
            const notesXml = await notesFile.async('text');
            const notesTexts = extractAllText(notesXml).filter((t) => t && t.trim());
            notes = notesTexts.join('\n').trim();
        }

        slidesData.push({ slideNum, title, bodies, notes });

        // IR 构建：每段（无论同 shape 还是不同 shape）独立成 paragraph
        ir.children.push(createSlideBreak({ title, index: i, notes }));
        for (const body of bodies) {
            if (!body) continue;
            // body 内含 \n 分隔的多段，拆分成独立段落
            for (const para of body.split('\n')) {
                const trimmed = para.trim();
                if (trimmed) ir.children.push(createParagraph(trimmed));
            }
        }
        if (notes) {
            ir.children.push(
                createBlockquote([createParagraph(`备注：${notes}`)]),
            );
        }
    }

    // 元信息
    let docTitle = '';
    const coreFile = zip.file('docProps/core.xml');
    if (coreFile) {
        const coreXml = await coreFile.async('text');
        const m = coreXml.match(/<dc:title>([^<]*)<\/dc:title>/);
        if (m && m[1]) docTitle = m[1];
    }
    if (!docTitle) {
        docTitle =
            (slidesData[0] && slidesData[0].title) ||
            stripExt(meta.sourceName) ||
            '未命名演示';
    }

    return createDocument({
        kind: 'presentation',
        ir,
        data: { slides: slidesData, slideCount: slidesData.length },
        meta: {
            sourceType: 'pptx',
            title: docTitle,
            slideCount: slidesData.length,
            ...meta,
        },
    });
}

function extractSlideNum(filename) {
    const m = filename.match(/slide(\d+)\.xml$/);
    return m ? parseInt(m[1], 10) : 0;
}

function extractSlideText(xml) {
    const $ = cheerio.load(xml, { xmlMode: true });
    let title = '';
    const bodies = [];

    $('p\\:sp').each((_, sp) => {
        const $sp = $(sp);
        const phEl = $sp.find('p\\:ph').first();
        const phType = phEl.attr('type');
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

    return { title, bodies };
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

function stripExt(name) {
    if (!name) return '';
    return path.basename(name, path.extname(name));
}

module.exports = { parse };
