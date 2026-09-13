/**
 * 文件库索引（纯逻辑内核，不依赖 Electron）
 *
 * 方案 §3.4.8 的主进程实现：索引读写、分面、搜索、标签/收藏、缺失标记与托管目录推导。
 * 只依赖 node 内置模块与 converters/ 的纯工具，普通 Node 中 require 无副作用，可直接单测。
 *
 * createLibrary({ dir, now = Date.now, idFactory }) → 实例，方法一律异步（warnings 除外）：
 *   load()                      载入 {dir}/index.json，→ { count, warnings }
 *   list(params)                → { items（含 missing 布尔）, total, facets }
 *   get(id)                     → 记录副本 | null
 *   add(record)                 → 记录副本；id / createdAt / updatedAt 缺省时自动补齐
 *   update(id, patch)           patch 仅接受 { tags, favorite, title }，→ 记录副本
 *   remove(id)                  → boolean（只删索引条目，不动文件）
 *   paths(id)                   → 该记录涉及的绝对路径（outputPath、outputs、extras；去重）
 *   upsertFromResult(result, { managed, outputDir }) → 记录副本，按 outputPath 判定是否同一条产物
 *   relocate(id, { from, to })  供 library-migrate 在迁移成功后整体平移路径并置 managed
 *   managedOutputDir({ root, date }) → {root}/{YYYY-MM}
 *   warnings()                  最近一次 load 的警告（同步）
 * recordFromResult(result, options) 为独立导出的纯函数：转换结果 → 记录（不读时钟、不触碰文件系统）。
 *
 * 不变量：
 *   1. 索引文件恒为 { version: 1, records: [...] }；写入先落 index.json.tmp，
 *      再把现有 index.json 复制为 index.json.bak，最后 fs.rename 原子替换 index.json。
 *   2. 全部写操作经单条串行队列；任一次失败不影响后续排队任务，也不会写出半条记录。
 *   3. 对外返回的记录一律为深拷贝并深冻结，内部数组与对象不外泄。
 *   4. 首次读写自动 load()；显式 load() 重新读盘并重置 warnings。
 *   5. 本模块不删除任何产物文件：remove() 只删索引，删文件由调用方经 shell.trashItem 完成。
 *   6. 记录中的 extras 为 outputPath 内的 POSIX 相对路径（与 converters/index.js 的结果一致），
 *      outputs 的值为绝对路径。
 *   7. load() 不走写队列：它应在实例的其它调用之前完成（主进程启动时调一次），
 *      不要在写操作进行中重新 load()，否则重新读盘会覆盖尚未落盘的内存状态。
 */
const path = require('path');
const fsp = require('fs').promises;
const { randomUUID } = require('crypto');

const { errText, hostnameOf, statOrNull, isWithinDir } = require('../../converters/util');
const { detectInputType, REMOTE_URL_RE } = require('../../converters/targets');

const INDEX_VERSION = 1;
const INDEX_FILENAME = 'index.json';
const TMP_SUFFIX = '.tmp';
const BAK_SUFFIX = '.bak';
const MONTH_LENGTH = 7; // 'YYYY-MM' 在 ISO 字符串中的长度
const SORT_FIELDS = Object.freeze(['createdAt', 'updatedAt', 'title']);
const SORT_ORDERS = Object.freeze(['asc', 'desc']);
const FACET_KEYS = Object.freeze(['sourceType', 'target', 'month', 'sourceDir', 'tag', 'favorite']);
const PATCH_KEYS = Object.freeze(['tags', 'favorite', 'title']);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// ============================================================
// 实例
// ============================================================

function createLibrary({ dir, now = Date.now, idFactory = randomUUID } = {}) {
    if (typeof dir !== 'string' || !dir.trim()) throw new Error('createLibrary 需要索引目录 dir');
    if (typeof now !== 'function') throw new Error('createLibrary 的 now 须为函数');
    if (typeof idFactory !== 'function') throw new Error('createLibrary 的 idFactory 须为函数');

    const baseDir = path.resolve(dir);
    const indexPath = path.join(baseDir, INDEX_FILENAME);
    const tmpPath = indexPath + TMP_SUFFIX;
    const bakPath = indexPath + BAK_SUFFIX;

    // records 整体替换而非原地修改，避免读侧拿到写了一半的数组
    const state = { records: [], warnings: [], loading: null, loaded: false };
    let queue = Promise.resolve();

    // ---------- 串行队列 ----------
    // 前一任务无论成败都不阻断后续任务；调用方拿到的仍是本次任务自身的结果
    function enqueue(task) {
        const run = queue.then(task, task);
        queue = run.then(noop, noop);
        return run;
    }

    // ---------- 载入 ----------

    async function readIndexFile(file) {
        let text;
        try {
            text = await fsp.readFile(file, 'utf8');
        } catch (err) {
            if (err && err.code === 'ENOENT') return { ok: false, kind: 'missing', reason: '' };
            return { ok: false, kind: 'broken', reason: `索引文件 ${path.basename(file)} 无法读取：${errText(err)}` };
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            return { ok: false, kind: 'broken', reason: `索引文件 ${path.basename(file)} 不是合法 JSON：${errText(err)}` };
        }
        if (!isPlainObject(parsed) || !Array.isArray(parsed.records)) {
            return { ok: false, kind: 'broken', reason: `索引文件 ${path.basename(file)} 结构不合法：缺少 records 数组` };
        }
        if (parsed.version !== INDEX_VERSION) {
            return {
                ok: false,
                kind: 'version',
                reason: `索引文件 ${path.basename(file)} 的版本为 ${JSON.stringify(parsed.version)}，本版本只支持 ${INDEX_VERSION}，已忽略其中的记录`,
            };
        }
        const records = [];
        const warnings = [];
        parsed.records.forEach((raw, index) => {
            try {
                records.push(normalizeStoredRecord(raw));
            } catch (err) {
                warnings.push(`索引文件 ${path.basename(file)} 第 ${index + 1} 条记录已跳过：${errText(err)}`);
            }
        });
        return { ok: true, records, warnings };
    }

    async function loadInternal() {
        const warnings = [];
        const main = await readIndexFile(indexPath);
        if (main.ok) {
            state.records = main.records;
            warnings.push(...main.warnings);
        } else if (main.kind === 'missing') {
            state.records = [];
        } else if (main.kind === 'version') {
            state.records = [];
            warnings.push(main.reason);
        } else {
            warnings.push(main.reason);
            const backup = await readIndexFile(bakPath);
            if (backup.ok) {
                state.records = backup.records;
                warnings.push(`已回退备份 ${INDEX_FILENAME}${BAK_SUFFIX}，恢复 ${backup.records.length} 条记录`);
                warnings.push(...backup.warnings);
            } else {
                state.records = [];
                warnings.push(`备份 ${INDEX_FILENAME}${BAK_SUFFIX} 不可用，文件库以空索引启动`);
            }
        }
        state.warnings = warnings;
        state.loaded = true;
        return { count: state.records.length, warnings: [...warnings] };
    }

    function load() {
        state.loaded = false;
        state.loading = loadInternal().finally(() => { state.loading = null; });
        return state.loading;
    }

    // 首次读写自动载入；并发调用共享同一次读盘
    async function ensureLoaded() {
        if (state.loaded) return;
        if (!state.loading) {
            state.loading = loadInternal().finally(() => { state.loading = null; });
        }
        await state.loading;
    }

    // ---------- 落盘 ----------

    async function persist() {
        await fsp.mkdir(baseDir, { recursive: true });
        const payload = `${JSON.stringify({ version: INDEX_VERSION, records: state.records }, null, 2)}\n`;
        await fsp.writeFile(tmpPath, payload, 'utf8');
        if (await statOrNull(indexPath)) await fsp.copyFile(indexPath, bakPath);
        await fsp.rename(tmpPath, indexPath);
    }

    const findIndexById = (id) => state.records.findIndex((record) => record.id === id);

    // ---------- 读 ----------

    async function list(params = {}) {
        if (!isPlainObject(params)) throw new Error('list 需要对象形式的参数');
        const { query = '', facets = {}, sort = 'createdAt', order = 'desc', limit, offset = 0 } = params;
        if (!SORT_FIELDS.includes(sort)) throw new Error(`不支持的排序字段：${sort}（可选：${SORT_FIELDS.join('、')}）`);
        if (!SORT_ORDERS.includes(order)) throw new Error(`不支持的排序方向：${order}（可选：${SORT_ORDERS.join('、')}）`);
        const start = assertCount(offset, 'offset');
        const size = limit === undefined || limit === null ? null : assertCount(limit, 'limit');
        const selected = normalizeFacetQuery(facets);
        await ensureLoaded();

        const filtered = state.records.filter((record) => matchesQuery(record, query) && matchesFacets(record, selected));
        const page = sortRecords(filtered, sort, order).slice(start, size === null ? undefined : start + size);
        const items = await Promise.all(page.map(async (record) => freeze({
            ...clone(record),
            missing: !(await statOrNull(record.outputPath)),
        })));
        return { items, total: filtered.length, facets: buildFacets(filtered) };
    }

    async function get(id) {
        await ensureLoaded();
        const index = findIndexById(id);
        return index === -1 ? null : exportRecord(state.records[index]);
    }

    async function paths(id) {
        await ensureLoaded();
        const index = findIndexById(id);
        if (index === -1) return [];
        return collectPaths(state.records[index]);
    }

    // ---------- 写 ----------

    const add = (record) => enqueue(async () => {
        await ensureLoaded();
        const stamp = nowIso();
        const created = normalizeStoredRecord({
            id: pickId(record),
            createdAt: pickIso(record && record.createdAt, stamp),
            updatedAt: pickIso(record && record.updatedAt, stamp),
            ...stripMeta(record),
        });
        if (findIndexById(created.id) !== -1) throw new Error(`记录 id 重复：${created.id}`);
        state.records = [...state.records, created];
        await persist();
        return exportRecord(created);
    });

    const update = (id, patch = {}) => enqueue(async () => {
        await ensureLoaded();
        if (!isPlainObject(patch)) throw new Error('update 需要对象形式的 patch');
        const unknown = Object.keys(patch).filter((key) => !PATCH_KEYS.includes(key));
        if (unknown.length > 0) throw new Error(`update 不接受字段：${unknown.join('、')}（仅支持 ${PATCH_KEYS.join('、')}）`);
        const index = findIndexById(id);
        if (index === -1) throw new Error(`未找到记录：${id}`);

        const current = state.records[index];
        const next = { ...current, updatedAt: nowIso() };
        if ('tags' in patch) next.tags = normalizeTags(patch.tags);
        if ('favorite' in patch) next.favorite = Boolean(patch.favorite);
        if ('title' in patch) next.title = normalizeTitle(patch.title, current.name);
        state.records = replaceAt(state.records, index, next);
        await persist();
        return exportRecord(next);
    });

    const remove = (id) => enqueue(async () => {
        await ensureLoaded();
        const index = findIndexById(id);
        if (index === -1) return false;
        state.records = [...state.records.slice(0, index), ...state.records.slice(index + 1)];
        await persist();
        return true;
    });

    const upsertFromResult = (result, options = {}) => enqueue(async () => {
        await ensureLoaded();
        const draft = recordFromResult(result, options);
        const stamp = nowIso();
        const index = state.records.findIndex((record) => record.outputPath === draft.outputPath);
        if (index === -1) {
            const created = normalizeStoredRecord({ id: idFactory(), createdAt: stamp, updatedAt: stamp, ...draft });
            state.records = [...state.records, created];
            await persist();
            return exportRecord(created);
        }
        const current = state.records[index];
        // 重新转换：保留人工标注（tags / favorite）与原始 id、createdAt，其余字段以本次结果为准
        const next = normalizeStoredRecord({
            ...draft,
            id: current.id,
            createdAt: current.createdAt,
            updatedAt: stamp,
            tags: current.tags,
            favorite: current.favorite,
        });
        state.records = replaceAt(state.records, index, next);
        await persist();
        return exportRecord(next);
    });

    const relocate = (id, { from, to } = {}) => enqueue(async () => {
        await ensureLoaded();
        if (typeof to !== 'string' || !to.trim()) throw new Error('relocate 需要目标路径 to');
        const index = findIndexById(id);
        if (index === -1) throw new Error(`未找到记录：${id}`);

        const current = state.records[index];
        const fromDir = path.resolve(typeof from === 'string' && from.trim() ? from : current.outputPath);
        const toDir = path.resolve(to);
        const remap = (value) => remapPath(fromDir, toDir, value);
        const next = normalizeStoredRecord({
            ...current,
            outputPath: remap(current.outputPath),
            outputs: mapValues(current.outputs, remap),
            extras: current.extras.map(remap), // extras 为相对路径时原样保留
            managed: true,
            updatedAt: nowIso(),
        });
        state.records = replaceAt(state.records, index, next);
        await persist();
        return exportRecord(next);
    });

    // ---------- 托管目录 ----------

    function managedOutputDir({ root, date } = {}) {
        if (typeof root !== 'string' || !root.trim()) throw new Error('managedOutputDir 需要托管根目录 root');
        return path.join(path.resolve(root), monthOf(toIso(date === undefined ? now() : date)));
    }

    const nowIso = () => toIso(now());
    const pickId = (record) => {
        const given = record && typeof record.id === 'string' ? record.id.trim() : '';
        return given || String(idFactory());
    };

    return {
        load,
        list,
        get,
        add,
        update,
        remove,
        paths,
        upsertFromResult,
        relocate,
        managedOutputDir,
        warnings: () => [...state.warnings],
    };
}

// ============================================================
// 转换结果 → 记录（纯函数）
// ============================================================

/**
 * 把 converters/service.js 的 describeResult 结果转成文件库记录。
 * options：{ managed = false, outputDir, id, createdAt, updatedAt, tags, favorite }；
 * 未给 id / createdAt / updatedAt 时不产出这三个字段，由 add()、upsertFromResult() 补齐。
 * outputDir 只用于把相对的 outputPath 补成绝对路径（桌面端恒传绝对路径，此处仅作兜底）。
 */
function recordFromResult(result, options = {}) {
    if (!isPlainObject(result)) throw new Error('recordFromResult 需要对象形式的转换结果');
    if (!isPlainObject(options)) throw new Error('recordFromResult 需要对象形式的 options');
    const input = typeof result.input === 'string' ? result.input.trim() : '';
    if (!input) throw new Error('转换结果缺少 input');
    const target = typeof result.target === 'string' ? result.target.trim() : '';
    if (!target) throw new Error('转换结果缺少 target');
    const rawOutput = typeof result.outputPath === 'string' ? result.outputPath.trim() : '';
    if (!rawOutput) throw new Error('转换结果缺少 outputPath');
    const outputPath = path.isAbsolute(rawOutput) || !options.outputDir
        ? path.resolve(rawOutput)
        : path.resolve(options.outputDir, rawOutput);

    const name = typeof result.name === 'string' ? result.name : '';
    const record = {
        source: sourceFromInput(input, result.sourceType),
        target,
        options: isPlainObject(result.options) ? clone(result.options) : {},
        name,
        title: normalizeTitle(result.title, name),
        outputPath,
        outputs: mapValues(isPlainObject(result.outputs) ? result.outputs : {}, (value) => (typeof value === 'string' ? value : null)),
        extras: normalizeStringList(result.extras),
        imagesCount: Number.isFinite(result.imagesCount) ? Number(result.imagesCount) : 0,
        warnings: normalizeStringList(result.warnings),
        tags: normalizeTags(options.tags),
        favorite: Boolean(options.favorite),
        managed: Boolean(options.managed),
    };
    // 三个元字段只在调用方给出时出现，保证本函数不依赖时钟
    const meta = {};
    if (options.id !== undefined) meta.id = String(options.id);
    if (options.createdAt !== undefined) meta.createdAt = toIso(options.createdAt);
    if (options.updatedAt !== undefined) meta.updatedAt = toIso(options.updatedAt);
    return { ...meta, ...record };
}

// 本地文件 → { kind: 'file', dir, name }；URL → { kind: 'url', host, name }
function sourceFromInput(input, sourceType) {
    const type = typeof sourceType === 'string' && sourceType ? sourceType : (detectInputType(input) || 'unknown');
    if (type === 'url' || REMOTE_URL_RE.test(input)) {
        return { kind: 'url', value: input, type: 'url', host: hostnameOf(input), name: urlLeafName(input) };
    }
    const value = path.isAbsolute(input) ? path.normalize(input) : input;
    return { kind: 'file', value, type, dir: path.dirname(value), name: path.basename(value) };
}

function urlLeafName(value) {
    try {
        const url = new URL(value);
        const segments = url.pathname.split('/').filter(Boolean);
        const leaf = segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]) : '';
        return leaf || url.hostname;
    } catch (err) {
        return value;
    }
}

// ============================================================
// 记录归一
// ============================================================

function normalizeStoredRecord(raw) {
    if (!isPlainObject(raw)) throw new Error('记录须为对象');
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) throw new Error('记录缺少 id');
    const outputPath = typeof raw.outputPath === 'string' ? raw.outputPath.trim() : '';
    if (!outputPath) throw new Error('记录缺少 outputPath');
    const target = typeof raw.target === 'string' ? raw.target.trim() : '';
    if (!target) throw new Error('记录缺少 target');
    const name = typeof raw.name === 'string' ? raw.name : '';
    const createdAt = toIso(raw.createdAt);
    return {
        id,
        createdAt,
        updatedAt: raw.updatedAt === undefined ? createdAt : toIso(raw.updatedAt),
        source: normalizeSource(raw.source),
        target,
        options: isPlainObject(raw.options) ? clone(raw.options) : {},
        name,
        title: normalizeTitle(raw.title, name),
        outputPath,
        outputs: mapValues(isPlainObject(raw.outputs) ? raw.outputs : {}, (value) => (typeof value === 'string' ? value : null)),
        extras: normalizeStringList(raw.extras),
        imagesCount: Number.isFinite(raw.imagesCount) ? Number(raw.imagesCount) : 0,
        warnings: normalizeStringList(raw.warnings),
        tags: normalizeTags(raw.tags),
        favorite: Boolean(raw.favorite),
        managed: Boolean(raw.managed),
    };
}

function normalizeSource(raw) {
    if (!isPlainObject(raw)) throw new Error('记录缺少 source');
    const value = typeof raw.value === 'string' ? raw.value.trim() : '';
    if (!value) throw new Error('记录的 source 缺少 value');
    const kind = raw.kind === 'url' ? 'url' : 'file';
    const type = typeof raw.type === 'string' && raw.type ? raw.type : (detectInputType(value) || 'unknown');
    const name = typeof raw.name === 'string' && raw.name ? raw.name : (kind === 'url' ? urlLeafName(value) : path.basename(value));
    if (kind === 'url') {
        return { kind, value, type, host: typeof raw.host === 'string' && raw.host ? raw.host : hostnameOf(value), name };
    }
    return { kind, value, type, dir: typeof raw.dir === 'string' && raw.dir ? raw.dir : path.dirname(value), name };
}

const normalizeTitle = (title, fallback) => {
    const text = typeof title === 'string' ? title.trim() : '';
    return text || String(fallback || '');
};

function normalizeTags(tags) {
    if (tags === undefined || tags === null) return [];
    if (!Array.isArray(tags)) throw new Error('tags 须为字符串数组');
    const out = [];
    for (const tag of tags) {
        const text = typeof tag === 'string' ? tag.trim() : '';
        if (!text) continue;
        if (!out.includes(text)) out.push(text);
    }
    return out;
}

const normalizeStringList = (list) => (Array.isArray(list) ? list.filter((item) => typeof item === 'string' && item) : []);

// 去掉调用方传入的元字段，避免 add() 里 spread 时覆盖已算好的 id 与时间戳
function stripMeta(record) {
    if (!isPlainObject(record)) throw new Error('add 需要对象形式的记录');
    const { id, createdAt, updatedAt, ...rest } = record;
    return rest;
}

function mapValues(source, fn) {
    const out = {};
    for (const [key, value] of Object.entries(source)) {
        const mapped = fn(value);
        if (mapped !== null && mapped !== undefined) out[key] = mapped;
    }
    return out;
}

const replaceAt = (list, index, value) => [...list.slice(0, index), value, ...list.slice(index + 1)];

// ============================================================
// 搜索、分面、排序
// ============================================================

function matchesQuery(record, query) {
    const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
    if (!needle) return true;
    const haystack = [record.title, record.name, record.source.value, ...record.tags];
    return haystack.some((field) => String(field || '').toLowerCase().includes(needle));
}

function normalizeFacetQuery(facets) {
    if (!isPlainObject(facets)) throw new Error('facets 须为对象');
    const unknown = Object.keys(facets).filter((key) => !FACET_KEYS.includes(key));
    if (unknown.length > 0) throw new Error(`不支持的分面：${unknown.join('、')}（可选：${FACET_KEYS.join('、')}）`);
    const out = {};
    for (const key of FACET_KEYS) {
        const value = facets[key];
        if (value === undefined || value === null || value === '') continue;
        out[key] = key === 'favorite' ? Boolean(value) : String(value);
    }
    return out;
}

function matchesFacets(record, selected) {
    for (const [key, value] of Object.entries(selected)) {
        if (key === 'tag') {
            if (!record.tags.includes(value)) return false;
        } else if (key === 'favorite') {
            if (record.favorite !== value) return false;
        } else if (facetValueOf(record, key) !== value) {
            return false;
        }
    }
    return true;
}

// 单值分面的取值；tag（多值）与 favorite（布尔）各自单独处理
function facetValueOf(record, key) {
    if (key === 'sourceType') return record.source.type;
    if (key === 'target') return record.target;
    if (key === 'month') return monthOf(record.createdAt);
    if (key === 'sourceDir') return sourceDirOf(record);
    return '';
}

// 文件输入取所在目录，URL 输入取主机
const sourceDirOf = (record) => (record.source.kind === 'url' ? record.source.host : record.source.dir) || '';

/** 分面计数覆盖「查询 + 全部已选分面」之后的记录集，与 total 同一口径，不含分页 */
function buildFacets(records) {
    return {
        sourceType: countValues(records, (record) => [facetValueOf(record, 'sourceType')]),
        target: countValues(records, (record) => [facetValueOf(record, 'target')]),
        month: countValues(records, (record) => [facetValueOf(record, 'month')]),
        sourceDir: countValues(records, (record) => [facetValueOf(record, 'sourceDir')]),
        tag: countValues(records, (record) => record.tags),
        favorite: countFavorite(records),
    };
}

// 计数降序，同数按取值升序；空值不计入
function countValues(records, pick) {
    const counts = new Map();
    for (const record of records) {
        for (const value of pick(record)) {
            if (value === '' || value === undefined || value === null) continue;
            counts.set(value, (counts.get(value) || 0) + 1);
        }
    }
    return [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || compareText(a.value, b.value));
}

// 只列出实际出现的取值，true 在前
function countFavorite(records) {
    const yes = records.filter((record) => record.favorite).length;
    const entries = [];
    if (yes > 0) entries.push({ value: true, count: yes });
    if (records.length - yes > 0) entries.push({ value: false, count: records.length - yes });
    return entries;
}

function sortRecords(records, field, order) {
    const factor = order === 'asc' ? 1 : -1;
    return [...records].sort((a, b) => {
        const diff = field === 'title'
            ? compareText(a.title, b.title)
            : compareText(a[field], b[field]);
        return (diff || compareText(a.id, b.id)) * factor;
    });
}

const compareText = (a, b) => String(a).localeCompare(String(b), 'zh');

// ============================================================
// 路径
// ============================================================

function collectPaths(record) {
    const out = [];
    const push = (value) => {
        if (typeof value === 'string' && value && !out.includes(value)) out.push(value);
    };
    push(record.outputPath);
    for (const value of Object.values(record.outputs)) push(value);
    for (const extra of record.extras) {
        const abs = path.resolve(record.outputPath, extra);
        if (isWithinDir(record.outputPath, abs)) push(abs);
    }
    return out;
}

// 绝对且落在 fromDir 内的路径整体平移到 toDir；相对路径（extras）与外部路径原样保留
function remapPath(fromDir, toDir, value) {
    if (typeof value !== 'string' || !value) return value;
    if (!path.isAbsolute(value)) return value;
    const abs = path.resolve(value);
    if (!isWithinDir(fromDir, abs)) return value;
    return path.join(toDir, path.relative(fromDir, abs));
}

// ============================================================
// 时间与副本
// ============================================================

// 数字、Date 与 ISO 字符串统一为 ISO 字符串；无法解析时抛中文错误
function toIso(value) {
    if (value === undefined || value === null || value === '') throw new Error('缺少时间戳');
    const date = value instanceof Date ? value : new Date(typeof value === 'number' ? value : String(value));
    if (Number.isNaN(date.getTime())) throw new Error(`无法解析时间戳：${String(value)}`);
    return date.toISOString();
}

const pickIso = (value, fallback) => (value === undefined || value === null || value === '' ? fallback : toIso(value));

const monthOf = (iso) => String(iso || '').slice(0, MONTH_LENGTH);

// 用 JSON 往返而非 structuredClone：记录最终以 JSON 落盘，
// 往返一次可保证内存中的记录与 index.json 中的形状完全一致（Date 一类不会内外不一）
const clone = (value) => JSON.parse(JSON.stringify(value));

function freeze(value) {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const inner of Object.values(value)) freeze(inner);
    return value;
}

const exportRecord = (record) => freeze(clone(record));

function assertCount(value, label) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${label} 须为非负整数`);
    return value;
}

function noop() {}

module.exports = { createLibrary, recordFromResult, INDEX_VERSION, INDEX_FILENAME };
