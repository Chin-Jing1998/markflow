/**
 * DTD 校验（libxml2-wasm，可选依赖）
 *
 * validateXml(xml, { dtdDir?, requireDtd = true, url? })
 *   → { available: true, valid, errors: [{ line, message }], warnings: [{ line, message }] }
 *   → { available: false, valid: false, errors: [], warnings: [], hint }（未安装 libxml2-wasm）
 *   - 走 XmlDocument.fromString(xml, { url, option: XML_PARSE_DTDVALID })：libxml2 按文档 DOCTYPE 的 SYSTEM
 *     标识符请求外部 DTD，输入提供器按 basename 把请求映射到 dtdDir（缺省为本目录 dtd/）内的白名单文件
 *     （cn-application-body-20080416.dtd、soextblx.dtd），拒绝其它任何路径，杜绝穿越与网络取用；
 *     XmlDtd.fromString 没有 base URI，解析不到 %calstblx; 引用的 soextblx.dtd，故不用（研究报告 §7.2）。
 *   - 官方 DTD 的 cn-drawings 内容模型违反确定性约束，libxml2 对任何 cn-drawings 都报
 *     「Content model of cn-drawings is not deterministic」，属 DTD 自身缺陷，单列为 warning（§3.11）。
 *   - requireDtd 为 false 时只做 well-formed 检查（generic profile 无 DTD）。
 *   - libxml2-wasm 仅有 ESM 出口，CommonJS 侧用动态 import()；解析成功后 dispose() 释放 wasm 内存。
 * describeValidation(fileName, result, { requireDtd }) → Issue[]（DTD_INVALID / DTD_UNAVAILABLE 问题项）
 *   fileName 只用于问题项的文案与 location，由调用方决定写法：patent profile 传「书目名 + 相对路径」
 *   （权利要求书 100001/100001.xml），免得只见表格代码不知是哪一书；generic profile 传主产物的文件名。
 */
const fs = require('fs');
const path = require('path');
const { ISSUE_CODES, createIssue } = require('./precheck');

const DEFAULT_DTD_DIR = path.join(__dirname, 'dtd');
const ALLOWED_DTD = new Set(['cn-application-body-20080416.dtd', 'soextblx.dtd']);
const DTD_DEFECT_RE = /Content model of \S+ is not determinist/;
const LEVEL_WARNING = 1;
const UNAVAILABLE_HINT = '校验器不可用：未安装可选依赖 libxml2-wasm（npm install libxml2-wasm 后可用）';
const NO_DTD_RE = /no DTD found/;

let importer = (specifier) => import(specifier);
let libPromise = null;
let providerRegistered = false;
// 输入提供器为进程级单例；fromString 为同步调用，校验期间该目录不会被并发改写
let activeDtdDir = DEFAULT_DTD_DIR;

async function loadLibrary() {
    if (!libPromise) {
        libPromise = importer('libxml2-wasm').catch(() => null);
    }
    const lib = await libPromise;
    if (lib && !providerRegistered) {
        lib.xmlRegisterInputProvider(createDtdProvider());
        providerRegistered = true;
    }
    return lib;
}

function createDtdProvider() {
    const handles = new Map();
    let nextHandle = 1;
    const resolve = (name) => {
        const base = path.basename(String(name));
        return ALLOWED_DTD.has(base) ? path.join(activeDtdDir, base) : null;
    };
    return {
        match: (name) => resolve(name) !== null,
        open(name) {
            const file = resolve(name);
            if (!file) return undefined;
            let buffer;
            try { buffer = fs.readFileSync(file); } catch (err) { return undefined; }
            const handle = nextHandle++;
            handles.set(handle, { buffer, position: 0 });
            return handle;
        },
        read(handle, out) {
            const state = handles.get(handle);
            if (!state) return -1;
            const count = Math.min(out.length, state.buffer.length - state.position);
            if (count <= 0) return 0;
            out.set(state.buffer.subarray(state.position, state.position + count));
            state.position += count;
            return count;
        },
        close: (handle) => handles.delete(handle),
    };
}

async function validateXml(xml, { dtdDir = DEFAULT_DTD_DIR, requireDtd = true, url } = {}) {
    if (typeof xml !== 'string') throw new Error('validateXml 需要字符串形式的 XML');
    const lib = await loadLibrary();
    if (!lib) return { available: false, valid: false, errors: [], warnings: [], hint: UNAVAILABLE_HINT };

    const errors = [];
    const warnings = [];
    activeDtdDir = path.resolve(dtdDir);
    const option = requireDtd ? lib.ParseOption.XML_PARSE_DTDVALID : lib.ParseOption.XML_PARSE_DEFAULT;
    let doc = null;
    try {
        doc = lib.XmlDocument.fromString(xml, { url, option });
    } catch (err) {
        if (!(err instanceof lib.XmlError)) throw err;
        const details = Array.isArray(err.details) ? err.details : [];
        for (const detail of details) {
            const item = { line: Number.isFinite(detail.line) ? detail.line : 0, message: String(detail.message || '').trim() };
            const soft = DTD_DEFECT_RE.test(item.message) || detail.level === LEVEL_WARNING;
            (soft ? warnings : errors).push(item);
        }
        if (details.length === 0) errors.push({ line: 0, message: String(err.message || err).trim() });
    } finally {
        if (doc) doc.dispose();
    }
    return { available: true, valid: errors.length === 0, errors, warnings };
}

/** 校验结果 → 问题项；校验通过不产生问题项 */
function describeValidation(fileName, result, { requireDtd = true } = {}) {
    if (!result.available) {
        return [createIssue(ISSUE_CODES.DTD_UNAVAILABLE, `${result.hint || UNAVAILABLE_HINT}，已跳过 ${fileName} 的校验`, { location: fileName })];
    }
    const label = requireDtd ? 'DTD 校验失败' : 'XML 格式检查失败';
    return result.errors.map((error) => createIssue(ISSUE_CODES.DTD_INVALID,
        `${label}（${fileName} 第 ${error.line} 行）：${error.message.replace(NO_DTD_RE, '文档未声明 DTD')}`,
        { location: `${fileName} 第 ${error.line} 行` }));
}

// 测试钩子：替换动态 import（模拟未安装）；_reset 恢复并清空缓存
function _setImporter(fn) {
    importer = typeof fn === 'function' ? fn : ((specifier) => import(specifier));
    libPromise = null;
}
function _reset() {
    importer = (specifier) => import(specifier);
    libPromise = null;
}

module.exports = { validateXml, describeValidation, DEFAULT_DTD_DIR, ALLOWED_DTD, _setImporter, _reset };
