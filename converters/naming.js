/**
 * 批内产物名登记表
 *
 * 同一批转换（一次 runConversion）内，不同输入可能派生出同一个产物名——同基名不同扩展名的文件
 * （sample.docx 与 sample.pptx）、不同目录下的同名文件、标题相同的网页——若各自按原名落盘就会
 * 互相覆盖。登记表按批内序号裁决最终名：
 *
 *   createNameRegistry() → {
 *     claim({ name, source, order, layout, ext }) → Promise<finalName>,
 *     release(order) → void,
 *   }
 *
 * 排队（order）：序号 i 的登记须等 0..i-1 全部「已登记」或「已放行」之后才生效，故最终名只由批内
 *   序号决定，与各任务解析完成的先后无关。解析仍并行，只有登记这一步排队，等待时间不超过前序任务
 *   的解析耗时。失败的任务由调用方 release(order) 放行后续，避免整批卡住；省略 order 即不排队。
 *
 * 分槽（layout / ext）：落盘形态不同的产物本就不会互相覆盖，故按槽位登记——folder 布局的槽位键为
 *   「{name}」（产物是目录），single 布局为「{name}.{ext}」（产物是文件，ext 取自 targets.js 的规则表）。
 *   因此 sample.md → docx（文件 sample.docx）与 sample.docx → bundle（目录 sample）同批互不改名。
 *
 * 同槽冲突的裁决规则：
 *   1. 槽位未被占用 → 保留原名；
 *   2. 已被占用，且本次为本地文件、其扩展名与占用者不同 → 「{name} ({ext})」（如 sample (pptx)）；
 *   3. 其余情形（同扩展名不同目录、网页标题相同）→ 「{name} (2)」「{name} (3)」递增；
 *   4. 规则 2 生成的名字再次冲突时，在其基础上按规则 3 递增（sample (pptx) (2)）。
 *
 * 只登记名字、不触碰文件系统：登记表的生命周期即一批任务，跨批次仍是「同名产物直接覆盖」，
 * 故单独再次转换同一输入依然幂等。名字的合法性由 converters/output.js 负责，本模块不做路径校验。
 */
const path = require('path');

// 数字后缀的起始序号：第二个同名产物记作 (2)
const FIRST_NUMERIC_SUFFIX = 2;

function createNameRegistry() {
    // 已占用的槽位键 → 占用者的输入扩展名（不含点、小写；网页输入与无扩展名的文件为 null）
    const used = new Map();
    // 批内序号 → 「已登记或已放行」的信号；序号 i 的登记等的就是 i-1 的这个信号
    const gates = new Map();

    function gateFor(order) {
        let gate = gates.get(order);
        if (!gate) {
            let open;
            gate = { opened: new Promise((resolve) => { open = resolve; }), open: () => open() };
            gates.set(order, gate);
        }
        return gate;
    }

    // 放行某序号。重复放行、以及放行一个已登记的序号，均为空操作：已登记的名字不会被撤销，
    // 因为落盘可能已部分完成，把名字让给后续任务反而有覆盖风险
    const release = (order) => { if (Number.isInteger(order)) gateFor(order).open(); };

    async function claim({ name, source, order, layout, ext } = {}) {
        try {
            const base = typeof name === 'string' ? name.trim() : '';
            if (!base) throw new Error('产物名登记需要非空的 name');
            if (Number.isInteger(order) && order > 0) await gateFor(order - 1).opened;
            return decide(base, extOf(source), slotKeyFactory(layout, ext));
        } finally {
            // 无论登记成功与否都放行后续，避免整批卡在某一项上
            release(order);
        }
    }

    // 登记本身同步完成：与上一步的 await 之间不再有挂起点，「按序号先后登记」才成立
    function decide(base, sourceExt, keyOf) {
        const taken = (candidate) => used.has(keyOf(candidate));
        const register = (finalName) => {
            used.set(keyOf(finalName), sourceExt);
            return finalName;
        };
        if (!taken(base)) return register(base);
        // 扩展名足以区分时先试「{name} ({ext})」，该名字也已被占用则退回数字后缀
        const byExt = sourceExt && sourceExt !== used.get(keyOf(base)) ? `${base} (${sourceExt})` : null;
        if (byExt && !taken(byExt)) return register(byExt);
        const candidate = byExt || base;
        // used 为有限集合，循环必然终止
        let seq = FIRST_NUMERIC_SUFFIX;
        while (taken(`${candidate} (${seq})`)) seq += 1;
        return register(`${candidate} (${seq})`);
    }

    return { claim, release };
}

// 槽位键：single 布局连同目标扩展名（产物是文件 {name}.{ext}），folder 布局只用产物名（产物是目录）
function slotKeyFactory(layout, ext) {
    const suffix = layout === 'single' && typeof ext === 'string' && ext.trim() ? `.${ext.trim()}` : '';
    return (name) => `${name}${suffix}`;
}

// 本地文件取扩展名（不含点、小写）；网页输入与无扩展名的文件返回 null
function extOf(source) {
    if (!source || typeof source !== 'object' || source.type === 'url') return null;
    const name = typeof source.sourceName === 'string' && source.sourceName ? source.sourceName : source.path;
    const ext = path.extname(typeof name === 'string' ? name : '').replace(/^\./, '').toLowerCase();
    return ext || null;
}

module.exports = { createNameRegistry };
