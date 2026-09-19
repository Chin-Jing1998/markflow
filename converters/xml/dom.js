/**
 * 无依赖的极简 XML 扫描器（桌面端 XML 视图与 parsers/xml 反向导入共用同一份，避免两处语义漂移）
 *
 *   parseXml(text, { maxDepth? })  → { ok: true, prolog, root } | { ok: false, error }
 *       声明 / DOCTYPE（含内部子集）/ 处理指令 / 注释 / CDATA / 元素 / 文本；
 *       标签不闭合、闭合名不匹配、多根、根后有内容一律判为不合法并给出中文错误，绝不抛出。
 *       预定义实体与数字引用解码，未知命名实体原样保留；DOCTYPE 内部子集整体跳过，其中声明的实体
 *       一概不展开、外部实体一概不读取（无 XXE、无实体膨胀）。
 *       节点形态：{ type: 'element', name, attrs, children } 与 { type: 'text', value }；
 *       prolog 为根元素之前的 [{ kind: 'declaration' | 'doctype' | 'instruction', raw }]。
 *       maxDepth 为元素嵌套上限（正整数），超出即判为不合法；缺省不限，行为与引入该参数之前逐字节一致。
 *       扫描本身用显式栈、不递归；给出 maxDepth 是为了让下游的递归遍历有界。
 *   sniffRootName(text)            → 根元素名 | null
 *       只看文首：跳过 BOM、空白、声明、处理指令、注释与 DOCTYPE 后读第一个开始标记的元素名；
 *       不校验其后内容是否合法，供「这份 XML 是不是某种方言」一类的廉价预判，传入文首若干 KB 即可。
 *
 * 输入属不可信内容：本模块只做字符串扫描，不执行、不联网、不触碰文件系统。
 */
const NAME_START = /[A-Za-z_:]/;
const NAME_CHAR = /[-A-Za-z0-9._:]/;
const WHITESPACE = /\s/;
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g;
const NAMED_ENTITIES = Object.freeze({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" });
// 不可见字符以码点声明，源码里不出现看不见的字面量
const BOM = String.fromCharCode(0xFEFF);

const element = (name, attrs) => ({ type: 'element', name, attrs, children: [] });
const text = (value) => ({ type: 'text', value });

function parseXml(input, { maxDepth } = {}) {
    const src = String(input == null ? '' : input);
    const depthLimit = Number.isInteger(maxDepth) && maxDepth > 0 ? maxDepth : Infinity;
    const prolog = [];
    const stack = [];
    let root = null;
    let i = 0;

    const fail = (message, at) => ({ ok: false, error: `${message}（位置 ${describePosition(src, at)}）` });

    while (i < src.length) {
        if (src[i] !== '<') {
            const next = src.indexOf('<', i);
            const end = next === -1 ? src.length : next;
            const chunk = src.slice(i, end);
            if (stack.length === 0) {
                if (chunk.trim() !== '') return fail(root ? '根元素之外出现了文本' : 'XML 序言之后、根元素之前出现了文本', i);
            } else {
                stack[stack.length - 1].children.push(text(decodeEntities(chunk)));
            }
            i = end;
            continue;
        }
        if (src.startsWith('<!--', i)) {
            const end = src.indexOf('-->', i + 4);
            if (end === -1) return fail('注释没有结束标记 -->', i);
            i = end + 3;
            continue;
        }
        if (src.startsWith('<![CDATA[', i)) {
            const end = src.indexOf(']]>', i + 9);
            if (end === -1) return fail('CDATA 段没有结束标记 ]]>', i);
            if (stack.length > 0) stack[stack.length - 1].children.push(text(src.slice(i + 9, end)));
            i = end + 3;
            continue;
        }
        if (src.startsWith('<?', i)) {
            const end = src.indexOf('?>', i + 2);
            if (end === -1) return fail('处理指令没有结束标记 ?>', i);
            const raw = src.slice(i, end + 2);
            if (stack.length === 0) prolog.push({ kind: raw.startsWith('<?xml ') || raw === '<?xml?>' ? 'declaration' : 'instruction', raw });
            i = end + 2;
            continue;
        }
        if (src.startsWith('<!DOCTYPE', i)) {
            const end = findDoctypeEnd(src, i);
            if (end === -1) return fail('DOCTYPE 声明没有结束标记 >', i);
            if (stack.length === 0) prolog.push({ kind: 'doctype', raw: src.slice(i, end + 1) });
            i = end + 1;
            continue;
        }
        if (src.startsWith('</', i)) {
            const parsed = readName(src, i + 2);
            if (!parsed) return fail('结束标记缺少元素名', i);
            let cursor = parsed.next;
            while (cursor < src.length && WHITESPACE.test(src[cursor])) cursor += 1;
            if (src[cursor] !== '>') return fail(`结束标记 </${parsed.name}> 格式不正确`, i);
            const open = stack.pop();
            if (!open) return fail(`多余的结束标记 </${parsed.name}>`, i);
            if (open.name !== parsed.name) return fail(`结束标记 </${parsed.name}> 与开始标记 <${open.name}> 不匹配`, i);
            i = cursor + 1;
            continue;
        }

        const parsed = readName(src, i + 1);
        if (!parsed) return fail('开始标记缺少元素名', i);
        const attrs = readAttributes(src, parsed.next);
        if (attrs.error) return fail(attrs.error, i);
        if (stack.length >= depthLimit) return fail(`元素嵌套超过 ${depthLimit} 层`, i);
        const node = element(parsed.name, attrs.attrs);
        if (stack.length === 0) {
            if (root) return fail(`出现了第二个根元素 <${parsed.name}>，XML 只允许一个根元素`, i);
            root = node;
        } else {
            stack[stack.length - 1].children.push(node);
        }
        if (!attrs.selfClosing) stack.push(node);
        i = attrs.next;
    }

    if (stack.length > 0) return { ok: false, error: `元素 <${stack[stack.length - 1].name}> 没有对应的结束标记` };
    if (!root) return { ok: false, error: '没有找到根元素，内容可能不是 XML' };
    return { ok: true, prolog, root };
}

function readName(src, start) {
    if (start >= src.length || !NAME_START.test(src[start])) return null;
    let i = start + 1;
    while (i < src.length && NAME_CHAR.test(src[i])) i += 1;
    return { name: src.slice(start, i), next: i };
}

function readAttributes(src, start) {
    const attrs = {};
    let i = start;
    while (i < src.length) {
        while (i < src.length && WHITESPACE.test(src[i])) i += 1;
        if (src.startsWith('/>', i)) return { attrs, selfClosing: true, next: i + 2 };
        if (src[i] === '>') return { attrs, selfClosing: false, next: i + 1 };
        const name = readName(src, i);
        if (!name) return { error: '属性名不合法' };
        i = name.next;
        while (i < src.length && WHITESPACE.test(src[i])) i += 1;
        if (src[i] !== '=') return { error: `属性 ${name.name} 缺少取值` };
        i += 1;
        while (i < src.length && WHITESPACE.test(src[i])) i += 1;
        const quote = src[i];
        if (quote !== '"' && quote !== "'") return { error: `属性 ${name.name} 的取值必须用引号括起` };
        const end = src.indexOf(quote, i + 1);
        if (end === -1) return { error: `属性 ${name.name} 的引号没有闭合` };
        attrs[name.name] = decodeEntities(src.slice(i + 1, end));
        i = end + 1;
    }
    return { error: '标记没有闭合' };
}

/** DOCTYPE 可带 [ ... ] 内部子集，其中的 > 不算结束 */
function findDoctypeEnd(src, start) {
    let depth = 0;
    for (let i = start; i < src.length; i += 1) {
        if (src[i] === '[') depth += 1;
        else if (src[i] === ']') depth -= 1;
        else if (src[i] === '>' && depth <= 0) return i;
    }
    return -1;
}

function decodeEntities(value) {
    return String(value).replace(ENTITY_RE, (match, name) => {
        if (name.startsWith('#x') || name.startsWith('#X')) return codePoint(parseInt(name.slice(2), 16), match);
        if (name.startsWith('#')) return codePoint(parseInt(name.slice(1), 10), match);
        return NAMED_ENTITIES[name] !== undefined ? NAMED_ENTITIES[name] : match;
    });
}

function codePoint(value, fallback) {
    if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return fallback;
    try {
        return String.fromCodePoint(value);
    } catch (err) {
        return fallback;
    }
}

function describePosition(src, at) {
    const before = src.slice(0, Math.max(0, at));
    const line = before.split('\n').length;
    const column = before.length - (before.lastIndexOf('\n') + 1) + 1;
    return `第 ${line} 行第 ${column} 列`;
}

// ============================================================
// 根元素名的廉价预判
// ============================================================

function sniffRootName(input) {
    const src = String(input == null ? '' : input);
    let i = src.startsWith(BOM) ? 1 : 0;
    while (i < src.length) {
        if (WHITESPACE.test(src[i])) { i += 1; continue; }
        if (src[i] !== '<') return null;
        const end = skipProlog(src, i);
        if (end === null) {
            const name = readName(src, i + 1);
            return name ? name.name : null;
        }
        if (end < 0) return null;
        i = end;
    }
    return null;
}

// 文首的注释 / 处理指令 / DOCTYPE：返回其后的位置；没有结束标记返回 -1；不是这三者返回 null
function skipProlog(src, at) {
    if (src.startsWith('<!--', at)) return endAfter(src.indexOf('-->', at + 4), 3);
    if (src.startsWith('<?', at)) return endAfter(src.indexOf('?>', at + 2), 2);
    if (src.startsWith('<!DOCTYPE', at)) return endAfter(findDoctypeEnd(src, at), 1);
    return null;
}

const endAfter = (index, length) => (index === -1 ? -1 : index + length);

module.exports = { parseXml, sniffRootName, decodeEntities };
