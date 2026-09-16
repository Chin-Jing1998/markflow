/**
 * 文件库托管迁移（纯逻辑，不依赖 Electron）
 *
 * 方案 §3.4.8 的托管模式第二半：把索引模式下散落各处的产物平移进 {root}/{YYYY-MM}/。
 * 先 planMigration 出计划供界面 dryRun 展示，确认后再 runMigration 逐条落盘。
 *
 * planMigration({ records, root, monthOf }) → { moves: [{ id, from, to, conflict }], skipped: [{ id, reason }] }
 *   纯函数，不触碰文件系统。跳过三类记录：缺 outputPath、已 managed、outputPath 已在 root 内。
 *   月份默认取记录 createdAt 的 YYYY-MM，可用 monthOf(record) 覆盖。
 *   同批次内目标同名时按 ` (2)`、` (3)` 顺延并把该条标为 conflict: true；
 *   有扩展名的目标（单文件产物）后缀插在扩展名之前，形如 `报告 (2).docx`。
 *   注意：磁盘上已存在的同名项不在本函数判定范围内——托管根目录由 MarkFlow 独占管理。
 *
 * runMigration(plan, { library, fs, onProgress }) → { moved: [{ id, from, to }], failed: [{ id, from, error }] }
 *   逐条串行执行：先建目标月份目录，再 fs.rename；EXDEV（跨卷）回退 copy + rm。
 *   成功者调 library.relocate(id, { from, to })，把 outputPath 与 outputs 中落在原目录内的绝对路径
 *   整体平移并置 managed = true（extras 为相对路径，随目录平移无需改写）；失败者原记录一字不动。
 *   fs 可注入 { rename, copy, rm, mkdir }，缺省用 fs.promises（copy 为 cp --recursive，rm 为 force+recursive）。
 *   onProgress({ index, total, id, from, to, ok, error }) 的异常一律吞掉，不影响迁移本身。
 *
 * 不变量：
 *   1. 本模块只搬运产物、只调 library.relocate，不改索引的其它字段，也不删除迁移目标。
 *   2. 一条记录失败不中断整批；失败项既不落 moved 也不改索引。
 *   3. 计划中的 to 路径互不重复，可直接用于落盘。
 */
const path = require('path');
const fsp = require('fs').promises;

const { errText, isWithinDir } = require('../../converters/util');

const MONTH_RE = /^\d{4}-\d{2}$/;
const MONTH_LENGTH = 7; // 'YYYY-MM'
const FIRST_SUFFIX = 2; // 冲突后缀自 (2) 起
const MAX_SUFFIX = 1000;
// 视为「文件扩展名」的形态：.md、.docx、.json 等；目录名中的 .v2 一类不会误判为扩展名
const FILE_EXT_RE = /^\.[A-Za-z0-9]{1,8}$/;

const EXDEV = 'EXDEV';

const DEFAULT_FS = Object.freeze({
    rename: (from, to) => fsp.rename(from, to),
    // 必须用异步 fsp.cp（Node 22 下为纯 JS 实现）。不要改成 fs.cpSync：它落到原生绑定
    // fsBinding.cpSyncCheckPaths，在 Windows 上会以 0xC0000409 直接终止进程且无栈可查，
    // 目录名含非 ASCII 字符时尤其容易命中（见 nodejs/node#54476、#59408）。
    copy: (from, to) => fsp.cp(from, to, { recursive: true }),
    rm: (target) => fsp.rm(target, { recursive: true, force: true }),
    mkdir: (dir) => fsp.mkdir(dir, { recursive: true }),
});

// ============================================================
// 计划
// ============================================================

function planMigration({ records, root, monthOf = monthFromRecord } = {}) {
    if (!Array.isArray(records)) throw new Error('planMigration 需要数组形式的 records');
    if (typeof root !== 'string' || !root.trim()) throw new Error('planMigration 需要托管根目录 root');
    if (typeof monthOf !== 'function') throw new Error('planMigration 的 monthOf 须为函数');
    const rootDir = path.resolve(root);

    const moves = [];
    const skipped = [];
    const taken = new Set();

    for (const record of records) {
        const id = record && record.id !== undefined ? record.id : null;
        const from = record && typeof record.outputPath === 'string' ? record.outputPath.trim() : '';
        if (!from) {
            skipped.push({ id, reason: '记录缺少 outputPath' });
            continue;
        }
        if (record.managed === true) {
            skipped.push({ id, reason: '记录已处于托管模式' });
            continue;
        }
        const absFrom = path.resolve(from);
        if (isWithinDir(rootDir, absFrom)) {
            skipped.push({ id, reason: '产物已位于托管根目录内' });
            continue;
        }
        const month = monthOf(record);
        if (!MONTH_RE.test(String(month))) {
            skipped.push({ id, reason: `无法推导归档月份：${JSON.stringify(record.createdAt)}` });
            continue;
        }
        const { to, conflict } = resolveTarget(path.join(rootDir, month), path.basename(absFrom), taken);
        taken.add(to);
        moves.push({ id, from: absFrom, to, conflict });
    }
    return { moves, skipped };
}

const monthFromRecord = (record) => String((record && record.createdAt) || '').slice(0, MONTH_LENGTH);

// 目标同名时顺延 ` (2)`、` (3)`；有扩展名的插在扩展名之前
function resolveTarget(dir, base, taken) {
    const first = path.join(dir, base);
    if (!taken.has(first)) return { to: first, conflict: false };
    const ext = path.extname(base);
    const hasExt = FILE_EXT_RE.test(ext);
    const stem = hasExt ? base.slice(0, -ext.length) : base;
    for (let n = FIRST_SUFFIX; n < MAX_SUFFIX; n += 1) {
        const candidate = path.join(dir, `${stem} (${n})${hasExt ? ext : ''}`);
        if (!taken.has(candidate)) return { to: candidate, conflict: true };
    }
    throw new Error(`同名产物过多，无法为 ${base} 分配托管路径`);
}

// ============================================================
// 执行
// ============================================================

async function runMigration(plan, { library, fs: injected, onProgress } = {}) {
    const moves = plan && Array.isArray(plan.moves) ? plan.moves : null;
    if (!moves) throw new Error('runMigration 需要 planMigration 产出的计划');
    const io = { ...DEFAULT_FS, ...(injected || {}) };

    const moved = [];
    const failed = [];
    for (const [index, move] of moves.entries()) {
        const { id, from, to } = move;
        try {
            await io.mkdir(path.dirname(to));
            await moveOne(io, from, to);
            await updateIndex(library, id, from, to);
            moved.push({ id, from, to });
            report(onProgress, { index, total: moves.length, id, from, to, ok: true, error: null });
        } catch (err) {
            failed.push({ id, from, error: errText(err) });
            report(onProgress, { index, total: moves.length, id, from, to, ok: false, error: errText(err) });
        }
    }
    return { moved, failed };
}

// 同卷用 rename；跨卷（EXDEV）回退 copy + rm
async function moveOne(io, from, to) {
    try {
        await io.rename(from, to);
    } catch (err) {
        if (!err || err.code !== EXDEV) throw err;
        await io.copy(from, to);
        await io.rm(from);
    }
}

async function updateIndex(library, id, from, to) {
    if (!library || typeof library.relocate !== 'function') return;
    try {
        await library.relocate(id, { from, to });
    } catch (err) {
        throw new Error(`产物已移动到 ${to}，但索引更新失败：${errText(err)}`);
    }
}

function report(onProgress, payload) {
    if (typeof onProgress !== 'function') return;
    try {
        onProgress(payload);
    } catch (err) {
        // 忽略调用方回调自身的异常
    }
}

module.exports = { planMigration, runMigration };
