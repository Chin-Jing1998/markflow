/**
 * 生成回归夹具 test/fixtures/images-sample.docx（可重复执行）
 *
 * 用法：node test/fixtures/build-images-sample.js
 *
 * 夹具内容：一张不透明 PNG（64×48 双色块）与一张带 alpha 通道的 PNG（32×32，除中心小方块外全透明），
 * 供阶段 1A 的 JPG 归一化做端到端回归——不透明图验证「位图 → JPEG 且 md 引用同步」，
 * 透明图验证「透明像素铺白」。两张图均由 jimp 现造，不引入外部二进制依赖；
 * 图各约 0.3 KB、整份 docx 约 10 KB，远低于 40 KB 上限。
 *
 * docx 包会把生成时间写进 docProps/core.xml，故两次运行的字节不完全相同；
 * 夹具只需重新生成后内容等价，不要求逐字节复现。
 */
const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');
const { Document, Packer, Paragraph, HeadingLevel, ImageRun, TextRun } = require('docx');

const OUTPUT = path.join(__dirname, 'images-sample.docx');

const OPAQUE = { width: 64, height: 48 };
const ALPHA = { width: 32, height: 32, square: 8 };

/** 左半蓝、右半橙的不透明 PNG */
async function makeOpaquePng() {
    const image = new Jimp({ width: OPAQUE.width, height: OPAQUE.height, color: 0x1E3A8AFF });
    for (let y = 0; y < OPAQUE.height; y += 1) {
        for (let x = OPAQUE.width / 2; x < OPAQUE.width; x += 1) image.setPixelColor(0xF59E0BFF, x, y);
    }
    return image.getBuffer('image/png');
}

/** 全透明底 + 居中不透明红方块的 PNG；转 JPEG 后四角应为白 */
async function makeAlphaPng() {
    const image = new Jimp({ width: ALPHA.width, height: ALPHA.height, color: 0x00000000 });
    const start = (ALPHA.width - ALPHA.square) / 2;
    for (let y = start; y < start + ALPHA.square; y += 1) {
        for (let x = start; x < start + ALPHA.square; x += 1) image.setPixelColor(0xDC2626FF, x, y);
    }
    return image.getBuffer('image/png');
}

async function main() {
    const [opaque, alpha] = await Promise.all([makeOpaquePng(), makeAlphaPng()]);

    const doc = new Document({
        sections: [{
            children: [
                new Paragraph({ text: '图片归一化回归样例', heading: HeadingLevel.HEADING_1 }),
                new Paragraph({ children: [new TextRun('不透明 PNG：')] }),
                new Paragraph({ children: [new ImageRun({ data: opaque, transformation: OPAQUE })] }),
                new Paragraph({ children: [new TextRun('带 alpha 通道的 PNG：')] }),
                new Paragraph({ children: [new ImageRun({ data: alpha, transformation: ALPHA })] }),
            ],
        }],
    });

    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(OUTPUT, buffer);
    console.log(`已生成 ${OUTPUT}（${buffer.length} 字节；不透明 PNG ${opaque.length} 字节、透明 PNG ${alpha.length} 字节）`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
