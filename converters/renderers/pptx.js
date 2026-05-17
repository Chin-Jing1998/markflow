/**
 * IR → PPTX (Buffer)
 *
 * 优先策略：用 doc.data.slides（来自 pptx parser 的快照）—— PPTX→PPTX 高保真。
 * 兜底策略：扫描 mdast
 *   - 优先按 slideBreak 扩展节点分页
 *   - 找不到 slideBreak 时按 H1/H2 自动分页（每个 H1/H2 一页，标题为 H 文字，正文为之后的段落）
 *   - 都找不到时把整篇内容塞到单页
 *
 * 使用 16:9 宽幕（LAYOUT_WIDE）。
 */

const pptxgen = require('pptxgenjs');

async function render(doc) {
    const pres = new pptxgen();
    pres.layout = 'LAYOUT_WIDE'; // 13.33" x 7.5"
    pres.title = (doc.meta && doc.meta.title) || '';
    pres.author = 'MarkFlow';

    // 路径 A：用 data 快照
    let slides = [];
    if (
        doc.data &&
        Array.isArray(doc.data.slides) &&
        doc.data.slides.length > 0
    ) {
        slides = doc.data.slides.map((s) => ({
            title: s.title || '',
            bodies: Array.isArray(s.bodies) ? s.bodies.filter(Boolean) : [],
            notes: s.notes || '',
        }));
    } else {
        slides = extractSlidesFromIR(doc.ir);
    }

    if (slides.length === 0) {
        slides = [
            {
                title: (doc.meta && doc.meta.title) || '空演示',
                bodies: [],
                notes: '',
            },
        ];
    }

    for (const s of slides) {
        const slide = pres.addSlide();

        // 标题
        slide.addText(s.title || '', {
            x: 0.5,
            y: 0.3,
            w: 12.3,
            h: 1.0,
            fontSize: 32,
            bold: true,
            color: '1D1D1F',
        });

        // 正文（每段一行）
        const bodyParas = s.bodies.filter((b) => b && String(b).trim());
        if (bodyParas.length > 0) {
            slide.addText(
                bodyParas.map((t) => ({ text: String(t), options: { breakLine: true } })),
                {
                    x: 0.5,
                    y: 1.5,
                    w: 12.3,
                    h: 5.5,
                    fontSize: 18,
                    color: '1D1D1F',
                    valign: 'top',
                    paraSpaceAfter: 8,
                },
            );
        }

        if (s.notes) {
            slide.addNotes(String(s.notes));
        }
    }

    const buf = await pres.write({ outputType: 'nodebuffer' });
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

function extractSlidesFromIR(ir) {
    const slides = [];
    let currentSlide = null;
    let hasSlideBreak = false;

    // 第一遍：判断是否有 slideBreak
    for (const node of (ir && ir.children) || []) {
        if (node.type === 'slideBreak') {
            hasSlideBreak = true;
            break;
        }
    }

    for (const node of (ir && ir.children) || []) {
        if (node.type === 'slideBreak') {
            currentSlide = {
                title: (node.data && node.data.title) || '',
                bodies: [],
                notes: (node.data && node.data.notes) || '',
            };
            slides.push(currentSlide);
            continue;
        }

        // 没 slideBreak 时按 H1/H2 自动分页
        if (
            !hasSlideBreak &&
            node.type === 'heading' &&
            (node.depth === 1 || node.depth === 2)
        ) {
            currentSlide = {
                title: collectText(node),
                bodies: [],
                notes: '',
            };
            slides.push(currentSlide);
            continue;
        }

        // 其余正文挂到当前 slide
        if (!currentSlide) {
            currentSlide = { title: '', bodies: [], notes: '' };
            slides.push(currentSlide);
        }

        const text = nodeToPlainText(node);
        if (text && text.trim()) {
            currentSlide.bodies.push(text.trim());
        }
    }

    return slides;
}

// 把任意节点转为单行/多行纯文本（列表、blockquote 也支持）
function nodeToPlainText(node) {
    if (!node) return '';
    if (node.type === 'list') {
        return (node.children || [])
            .map((li, i) => {
                const prefix = node.ordered ? `${i + 1}. ` : '• ';
                return prefix + collectText(li);
            })
            .join('\n');
    }
    if (node.type === 'table') {
        return (node.children || [])
            .map((tr) =>
                (tr.children || []).map((td) => collectText(td)).join(' | '),
            )
            .join('\n');
    }
    return collectText(node);
}

function collectText(node) {
    if (!node) return '';
    if (node.value !== undefined) return String(node.value);
    if (Array.isArray(node.children)) {
        return node.children.map(collectText).join('');
    }
    return '';
}

module.exports = { render };
