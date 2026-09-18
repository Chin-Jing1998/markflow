/**
 * 国知局专利五书 XML → IR（反向导入：XML → 可再编辑的 Word，亦可转 md / html / pdf / xml）
 *
 * 契约：async parse({ path }, ctx) → MarkFlowDocument{ ir, data: null, assets, warnings, meta }
 *   path 为下列三种形态之一（形态由 xml/source.js 按 stat 与扩展名判定，书目一律按内容判定、与文件名无关）：
 *     - 单个 .xml：五书中的一书（或一份 XML 内含多个书目容器），图片取自该 XML 的同级目录；
 *     - 案卷 .zip：官方与本工具现行产物（10000N/10000N.xml + 同目录图片）、v3.0.0 的平铺产物（claims.xml 等与图片
 *       同层）、外面多套一层文件夹的 zip 均可；
 *     - 五书目录：目录下直接含 10000N/10000N.xml 或根元素为 cn-application-body 的 .xml（与 converters/scan.js 的
 *       目录签名同一判据）。
 *   多书输入合并为一份文档：每书一个 Word 分节、书目名写在页眉里，顺序为 说明书摘要 → 摘要附图 → 权利要求书 →
 *   说明书 → 说明书附图（IR 约定见 xml/patent.js）。合并是往返闭合的前提——正向链路的契约即「一份 docx → 五书」。
 *   meta.title 取发明名称，无则取输入名；meta.sourceType 恒为 'xml'（zip 与目录同此，调度器的 sourceType 另按输入
 *   类型给出）；meta.sourcePath 为输入的绝对路径。
 *   ctx.options.xmlImport.paragraphNumbers 为 true 时把说明书与摘要的段号写回段首。
 * 不受理：MarkFlow 通用 XML（generic profile）与其它方言——给出中文错误并指明实际的根元素。
 * 问题清单：导入时丢失或改写的信息一律以稳定前缀「导入：」进 warnings（xml/report.js），不另行落盘
 *   （docx 是单文件布局，没有附属文件的去处）；图片缺失、引用越界、超限等只让该图降级为占位文字，不中断导入。
 * 安全：输入属不可信内容。扫描器不解析实体声明与外部实体；体量、zip 条目名、符号链接与图片路径的限制见
 *   xml/source.js 与 xml/images.js；元素嵌套以 MAX_DEPTH 封顶，使下游的递归遍历有界。本模块不写盘、不联网。
 */
const path = require('path');
const { createDocument } = require('../ir/schema');
const { stripExt } = require('../ir/util');
const { notify, statOrNull } = require('../util');
const { parseXml } = require('../xml/dom');
const { openSource, PATENT_ROOT } = require('./xml/source');
const { createImageImporter } = require('./xml/images');
const { createReport } = require('./xml/report');
const { booksToIr, BOOKS, BOOK_ORDER } = require('./xml/patent');

const SOURCE_TYPE = 'xml';
const DEFAULT_SOURCE_NAME = '未命名.xml';
// 五书的实际嵌套不过十层；上限只为让递归遍历有界
const MAX_DEPTH = 64;
const PROGRESS_READ = 15;
const PROGRESS_ASSETS = 45;
const PROGRESS_IR = 55;

/**
 * @param {{ path: string }} input
 * @param {{ sourceName?: string, options?: object, onProgress?: Function, limits?: object }} ctx limits 仅供测试收紧上限
 */
async function parse(input, ctx = {}) {
    const inputPath = resolveInputPath(input);
    const report = createReport();
    notify(ctx, 'parsing', PROGRESS_READ);
    const source = await openSource(inputPath, { report, limits: ctx.limits });
    const documents = parseDocuments(source.documents, report);
    if (documents.length === 0) throw new Error(`未能读出任何一份合法的国知局专利五书 XML（根元素 ${PATENT_ROOT}）`);

    const images = createImageImporter({ readImage: source.readImage, report, defaultDpi: importDpi(ctx.options) });
    notify(ctx, 'parsing', PROGRESS_ASSETS);
    const { children, inventionTitle, summary } = await booksToIr(documents, {
        images, report, paragraphNumbers: wantsParagraphNumbers(ctx.options),
    });
    if (children.length === 0) throw new Error('XML 内没有可导入的内容（五个书目容器均为空）');
    describeImport(report, summary, images);
    notify(ctx, 'parsing', PROGRESS_IR);

    const sourceName = ctx.sourceName || path.basename(inputPath) || DEFAULT_SOURCE_NAME;
    return createDocument({
        kind: 'document',
        ir: { type: 'root', children },
        data: null,
        meta: {
            title: inventionTitle || await fallbackTitle(inputPath, sourceName),
            sourceType: SOURCE_TYPE, sourceName, sourcePath: inputPath,
        },
        assets: images.assets(),
        warnings: report.toWarnings(),
    });
}

function resolveInputPath(input) {
    if (input && typeof input.path === 'string' && input.path) return path.resolve(input.path);
    throw new Error('parsers/xml 需要 input.path（.xml 文件、案卷 .zip 或五书目录的路径）');
}

// 逐份完整解析；单份不合法只作废这一份并提示，其余照常导入
function parseDocuments(candidates, report) {
    const documents = [];
    for (const candidate of candidates) {
        const parsed = parseXml(candidate.text, { maxDepth: MAX_DEPTH });
        if (!parsed.ok) {
            report.warn(`${candidate.name} 不是合法的 XML，已忽略：${parsed.error}`);
            continue;
        }
        if (parsed.root.name === PATENT_ROOT) documents.push({ name: candidate.name, dir: candidate.dir, root: parsed.root });
    }
    return documents;
}

const wantsParagraphNumbers = (options) => Boolean(options && options.xmlImport && options.xmlImport.paragraphNumbers);

// 图片既无密度又无 wi/he 时的估算密度，与正向链路缺密度时的回退值同源（xml.patent.imageDpi，缺省 300）
const importDpi = (options) => (options && options.xml && options.xml.patent ? options.xml.patent.imageDpi : undefined);

// 无发明名称（只导入了权利要求书等）时取输入名：目录名原样采用，文件名去扩展名
async function fallbackTitle(inputPath, sourceName) {
    const stat = await statOrNull(inputPath);
    return stat && stat.isDirectory() ? sourceName : stripExt(sourceName);
}

// 导入概要与「图片不可编辑」提示；丢失项由 report 自行汇总
function describeImport(report, summary, images) {
    const parts = BOOK_ORDER.filter((key) => summary[key]).map((key) => `${BOOKS[key]}（${describeStats(key, summary[key])}）`);
    report.note(`已读取 ${parts.join('、')}；内嵌图片 ${images.count} 幅`);
    if (images.roleCount > 0) {
        report.note(`公式、表格与化学式共 ${images.roleCount} 处为图片，Word 中不能编辑其内容；其替换文字里的 markflow:role 标记用于回转时还原为 maths / tables / chemistry，请勿删改`);
    }
}

function describeStats(key, stats) {
    if (key === 'claims') return `${stats.claims} 项`;
    if (key === 'description') return `${stats.paragraphs} 段、${stats.headings} 个小标题`;
    if (key === 'abstract') return `${stats.paragraphs} 段`;
    return `${stats.figures} 幅`;
}

module.exports = { parse };
