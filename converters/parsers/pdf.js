/**
 * PDF → IR 分派器
 *
 * 契约：parse({ path }, ctx) → MarkFlowDocument，与其它 parser 一致。本文件本身不解析 PDF，
 * 只按 ctx.options.pdfBackend 与 MinerU 令牌的有无，把请求转给两个后端之一：
 *
 *   local   → parsers/pdf-local.js（pdfjs 文本层；无图片、无版面、无表格）
 *   mineru  → pdf/mineru.js（MinerU Open API 云端解析；图片、版面、表格、公式齐全）
 *
 * 分派规则：
 *   pdfBackend 'local'   一律本地，不读取任何令牌来源；
 *   pdfBackend 'mineru'  强制云端，取不到令牌即抛中文错误（提示配置方式），不回退；
 *   pdfBackend 'auto'    有令牌走云端，云端失败直接抛错（不静默降级为质量更差的本地解析）；
 *                        无令牌走本地并追加 warning，告知用户回退事实与代价。
 *
 * 「云端失败不回退」是刻意的：回退会让一次失败的云端解析悄悄产出一份缺图少版面的文档，
 * 用户难以察觉；显式报错并提示 `--pdf-backend local` 才能把选择权交回用户。
 */
const { normalizeOptions } = require('../options');
const { getMineruToken, TOKEN_ENV_VARS } = require('../config');

/** auto 且无令牌时追加到文档上的提示 */
const FALLBACK_WARNING = '未配置 MinerU 令牌，已回退本地文本层解析：无图片、无版面';
/** 强制 mineru 却无令牌时的错误文案 */
const MISSING_TOKEN_ERROR = [
    '未配置 MinerU 令牌，无法使用 --pdf-backend mineru。',
    '可执行 `markflow config set mineru-token <令牌>` 写入配置，',
    `或设置环境变量 ${TOKEN_ENV_VARS.join(' / ')}；`,
    '也可改用 --pdf-backend local 走本地文本层解析。',
].join('');

/**
 * @param {{ path: string }} input 源文件绝对路径
 * @param {{ options?: object, sourceName?: string, onProgress?: Function }} [ctx]
 */
async function parse(input, ctx = {}) {
    if (!input || typeof input.path !== 'string' || !input.path) {
        throw new Error('parsers/pdf 需要 input.path（文件绝对路径）');
    }
    const options = normalizeOptions(ctx.options);
    if (options.pdfBackend === 'local') return getLocal().parse(input, ctx);

    // source 一并带下去：鉴权失败时要告诉用户用的是哪一份令牌（本机可能同时有环境变量与两处配置文件）
    const { token, source } = await getMineruToken({ explicit: options.mineru.token });
    if (options.pdfBackend === 'mineru') {
        if (!token) throw new Error(MISSING_TOKEN_ERROR);
        return getMineru().parseWithMineru(input, ctx, { token, source });
    }
    // auto
    if (token) return getMineru().parseWithMineru(input, ctx, { token, source });
    const doc = await getLocal().parse(input, ctx);
    return { ...doc, warnings: [...(Array.isArray(doc.warnings) ? doc.warnings : []), FALLBACK_WARNING] };
}

// 两个后端都按需加载：本地后端会拉起 pdfjs，云端后端会拉起 SDK 与 jszip，
// 只走其中一条路径时不该为另一条付出加载代价
let deps = {};
const getLocal = () => deps.local || require('./pdf-local');
const getMineru = () => deps.mineru || require('../pdf/mineru');

/** 测试钩子：{ local, mineru } 注入桩后端 */
function _setDeps(next = {}) { deps = { ...deps, ...next }; }
function _reset() { deps = {}; }

module.exports = { parse, FALLBACK_WARNING, MISSING_TOKEN_ERROR, _setDeps, _reset };
