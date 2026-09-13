#!/usr/bin/env node
/**
 * 专利样稿夹具生成器（可重复执行）
 *
 *   node test/fixtures/patent/build-samples.js
 *
 * 产出两份 docx，覆盖 XML 专利 profile 需要辨认的两种来稿形态：
 *   - sample-patent.docx        规范稿：四书标题（居中加粗段）＋ 五部分标题（Heading 1）＋
 *                               行内公式、独立公式段、2×3 表格、图号段、[0003] 已有段号
 *   - sample-patent-notitle.docx 真实代理所来稿形态：无发明名称、无四书标题、无段号，
 *                               权项用「1、」顿号编号并带无编号续行段，含一处坏引用
 *
 * 说明：
 *   1. 四书标题（权利要求书／说明书／说明书附图／说明书摘要／摘要附图）写成居中加粗段，
 *      五部分标题写成 Heading 1，使同一份夹具同时覆盖「加粗段分节」与「heading 分节」两条识别路径。
 *   2. docx 包只会生成行内 m:oMath，块级公式须是 m:oMathPara。故生成后再打开 zip，
 *      把「整段只有一个 m:oMath」的段落包一层 m:oMathPara，得到真正的块级公式。
 *   3. 图片复用 test/fixtures/images/pic.png（8×8 PNG，74 字节），避免夹具体积膨胀。
 *   4. 正文为虚构示例，不对应任何真实专利申请。
 */
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun,
    Table, TableRow, TableCell, WidthType,
    Math: OMath, MathRun, MathFraction, MathSum, MathRadical,
} = require('docx');

const HERE = __dirname;
const PNG = fs.readFileSync(path.join(HERE, '..', 'images', 'pic.png'));
const IMAGE_SIZE = { width: 96, height: 96 };
// 「整段只有一个 m:oMath」→ 包一层 m:oMathPara，使其成为块级公式
const STANDALONE_MATH_RE = /<w:p>(<m:oMath>[\s\S]*?<\/m:oMath>)<\/w:p>/g;

// ---------- 段落构件 ----------

const body = (text) => new Paragraph({ children: [new TextRun(text)] });
const bookTitle = (text) => new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text, bold: true })],
});
const heading = (text) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)] });
const picture = () => new Paragraph({ children: [new ImageRun({ type: 'png', data: PNG, transformation: IMAGE_SIZE })] });

const cell = (text) => new TableCell({ children: [new Paragraph(text)] });
const table2x3 = () => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
        new TableRow({ children: [cell('试样'), cell('穿刺力/N'), cell('渗漏率/%')] }),
        new TableRow({ children: [cell('实施例1'), cell('12.5'), cell('0.2')] }),
    ],
});

// 行内分式：单位面积承压 F/S
const inlineFormulaParagraph = () => new Paragraph({
    children: [
        new TextRun('本实施例中单位面积承压按 '),
        new OMath({
            children: [new MathFraction({ numerator: [new MathRun('F')], denominator: [new MathRun('S')] })],
        }),
        new TextRun(' 计算，其中 F 为轴向压力，S 为有效承压面积。'),
    ],
});

// 独立公式段：∑ 与根式；生成后由 wrapDisplayEquations 升为 m:oMathPara
const displayFormulaParagraph = () => new Paragraph({
    children: [
        new OMath({
            children: [
                new MathSum({
                    children: [new MathRun('xi')],
                    subScript: [new MathRun('i=1')],
                    superScript: [new MathRun('n')],
                }),
                new MathRun('='),
                new MathRadical({ children: [new MathRun('a+b')] }),
            ],
        }),
    ],
});

// ---------- 两份样稿 ----------

// 规范稿：四书标题齐备、五部分标题为 Heading 1、含公式与表格
function buildStandardChildren() {
    return [
        body('发明名称：一种测试装置'),

        bookTitle('权利要求书'),
        body('1. 一种测试装置，其特征在于，包括壳体、设于所述壳体内的驱动件以及与所述驱动件连接的穿刺针。'),
        body('2. 根据权利要求1所述的测试装置，其特征在于，所述驱动件为弹簧。'),
        body('3. 根据权利要求1或2所述的测试装置，其特征在于，所述穿刺针的针尖为斜面。'),

        bookTitle('说明书'),

        heading('技术领域'),
        body('本发明涉及医疗器械技术领域，具体涉及一种测试装置。'),

        heading('背景技术'),
        body('现有的穿刺装置在使用时需要人工对准，操作繁琐且穿刺深度难以控制。'),
        body('此外，现有装置的密封结构在反复穿刺后容易失效，存在渗漏风险。'),

        heading('发明内容'),
        body('本发明的目的在于提供一种测试装置，以解决上述技术问题。'),
        inlineFormulaParagraph(),
        displayFormulaParagraph(),

        heading('附图说明'),
        body('图1为本发明实施例的整体结构示意图；图2为本发明实施例中穿刺针的局部放大图。'),

        heading('具体实施方式'),
        body('下面结合附图对本发明的实施例作进一步说明。'),
        body('[0003] 如图1所示，所述壳体呈筒状，其上端设有进液口，下端设有穿刺针安装座。'),
        body('各实施例的测试数据如下表所示。'),
        table2x3(),

        bookTitle('说明书附图'),
        picture(),
        body('图1'),
        picture(),
        body('图2'),

        bookTitle('说明书摘要'),
        body('本发明公开了一种测试装置，包括壳体、驱动件与穿刺针，能够在无需人工对准的情况下完成定深穿刺。'),

        bookTitle('摘要附图'),
        picture(),
    ];
}

// 无标题稿：无发明名称、无四书标题、无段号，权项用顿号编号
function buildNoTitleChildren() {
    return [
        body('本实用新型公开了一种试剂灌装装置，包括瓶体固定座、升降组件以及穿刺头，解决了现有装置穿刺深度不可控的问题。'),

        body('1、一种液体容器，其特征在于，包括容器本体以及设于所述容器本体顶部的穿刺部。'),
        body('所述穿刺部包括基座与穿刺针，所述穿刺针可拆卸地安装于所述基座。'),
        body('所述容器本体的侧壁设有刻度线，用于指示剩余液量。'),
        body('2、根据权利要求1所述的液体容器，其特征在于，所述穿刺针为不锈钢材质。'),
        body('3、根据权利要求12-3任一项所述的液体容器，其特征在于，所述基座与所述容器本体螺纹连接。'),
        body('4、根据权利要求1-3任一项所述的液体容器，其特征在于，所述刻度线为激光蚀刻线。'),

        heading('技术领域'),
        body('本实用新型涉及包装容器技术领域。'),

        heading('背景技术'),
        body('现有液瓶在取液时需另行准备穿刺工具，使用不便。'),
        body('且穿刺后瓶口密封性下降，易造成液体污染。'),

        heading('实用新型内容'),
        body('本实用新型的目的在于提供一种结构简单、密封可靠的液体容器。'),

        heading('附图说明'),
        body('图1为本实用新型实施例的结构示意图；'),

        heading('具体实施方式'),
        body('下面结合实施例对本实用新型作进一步说明。'),
        body('所述穿刺针的针尖与轴线呈三十度夹角，以降低穿刺阻力。'),

        picture(),
        body('图1'),
        picture(),
        body('图2'),
    ];
}

// ---------- 生成 ----------

async function build(children) {
    const document = new Document({ sections: [{ children }] });
    return wrapDisplayEquations(await Packer.toBuffer(document));
}

async function wrapDisplayEquations(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const entry = zip.file('word/document.xml');
    if (!entry) return buffer;
    const xml = await entry.async('string');
    const wrapped = xml.replace(STANDALONE_MATH_RE, '<w:p><m:oMathPara>$1</m:oMathPara></w:p>');
    if (wrapped === xml) return buffer;
    zip.file('word/document.xml', wrapped);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function main() {
    const targets = [
        ['sample-patent.docx', buildStandardChildren()],
        ['sample-patent-notitle.docx', buildNoTitleChildren()],
    ];
    for (const [name, children] of targets) {
        const file = path.join(HERE, name);
        const buffer = await build(children);
        fs.writeFileSync(file, buffer);
        process.stdout.write(`${name} ${buffer.length} 字节\n`);
    }
}

if (require.main === module) {
    main().catch((err) => {
        process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
        process.exitCode = 1;
    });
}

module.exports = { main };
