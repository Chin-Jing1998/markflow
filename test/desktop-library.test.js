/**
 * desktop/main/library.js 与 desktop/main/library-migrate.js 单元测试
 * 覆盖：原子写与 .bak 回退、version 校验、增删改查、分面与派生（month/sourceDir）、
 *       搜索（大小写不敏感、多字段）、标签/收藏与 updatedAt、missing 标记、
 *       upsertFromResult（file 与 url 两种输入）、managedOutputDir、写队列串行、
 *       planMigration（跳过与冲突后缀）、runMigration（成功更新、EXDEV 回退、失败保留原记录）
 */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createLibrary, recordFromResult, INDEX_FILENAME } = require('../desktop/main/library');
const { planMigration, runMigration } = require('../desktop/main/library-migrate');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'library-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// ============================================================
// 夹具
// ============================================================

/**
 * 夹具里的绝对路径一律以 POSIX 写法书写，再经本函数转成本机形态。
 * 生产代码按本机语义归一路径（library.js 的 path.resolve / path.normalize、
 * library-migrate.js 的 path.resolve），Windows 上会补当前盘符并换成反斜杠：
 * path.resolve('/data/out/甲') → 'D:\\data\\out\\甲'。
 * 夹具与期望统一走这一层，类 Unix 上是恒等变换，Windows 上与生产侧同形，
 * 断言比的始终是路径结构本身，而不是某个平台的分隔符写法。
 */
const absPath = (p) => path.resolve(p);

let seq = 0;
const workDir = (label) => {
    const dir = path.join(root, `${label}-${(seq += 1)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

// 可推进的假时钟：now() 返回毫秒，advance 手动推进，避免用例依赖真实时间
function fakeClock(startIso) {
    let current = Date.parse(startIso);
    return { now: () => current, advance: (ms) => { current += ms; } };
}

function idCounter(prefix = 'r') {
    let n = 0;
    return () => `${prefix}${(n += 1)}`;
}

function makeLibrary(label, { start = '2026-03-05T08:00:00.000Z' } = {}) {
    const dir = workDir(label);
    const clock = fakeClock(start);
    return { dir, clock, lib: createLibrary({ dir, now: clock.now, idFactory: idCounter() }) };
}

// 最小可用记录：source.dir / source.name 由 value 派生，用于顺带验证归一
const recordOf = (overrides = {}) => ({
    source: { kind: 'file', value: '/data/in/甲.docx', type: 'docx' },
    target: 'bundle',
    name: '甲',
    title: '甲',
    outputPath: '/data/out/甲',
    outputs: {},
    extras: [],
    imagesCount: 0,
    warnings: [],
    ...overrides,
});

// 本地文件输入夹具的源目录与产物目录（本机形态，见 absPath 注释）
const DEMO_INPUT_DIR = absPath('/Users/demo/输入');
const DEMO_INPUT_FILE = path.join(DEMO_INPUT_DIR, '季度报告.docx');
const DEMO_PRODUCT_DIR = path.join(absPath('/Users/demo/输出'), '季度报告');

// converters/service.js describeResult 的形状（本地文件输入）
const fileResult = (overrides = {}) => ({
    input: DEMO_INPUT_FILE,
    target: 'bundle',
    name: '季度报告',
    title: '季度报告 Q3',
    sourceType: 'docx',
    outputPath: DEMO_PRODUCT_DIR,
    outputs: {
        md: path.join(DEMO_PRODUCT_DIR, '季度报告.md'),
        json: path.join(DEMO_PRODUCT_DIR, '季度报告.json'),
        imagesDir: path.join(DEMO_PRODUCT_DIR, 'images'),
    },
    imagesCount: 3,
    warnings: ['表格已降级为图片'],
    options: { imageFormat: 'jpg', mineru: { token: null } },
    extras: [],
    backends: { pdfParser: 'local', raster: null },
    ...overrides,
});

// describeResult 的形状（网页输入）
const urlResult = (overrides = {}) => ({
    input: 'https://Example.COM/blog/2026/Node-22-Notes?ref=rss',
    target: 'bundle',
    name: 'Node-22-Notes',
    title: 'Node 22 发行说明',
    sourceType: 'url',
    outputPath: '/Users/demo/输出/Node-22-Notes',
    outputs: { md: '/Users/demo/输出/Node-22-Notes/Node-22-Notes.md' },
    imagesCount: 0,
    warnings: [],
    options: {},
    extras: [],
    backends: { pdfParser: null, raster: null },
    ...overrides,
});

const readIndex = (dir) => JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILENAME), 'utf8'));

// ============================================================
// 索引读写与损坏回退
// ============================================================

describe('索引原子写与损坏回退', () => {
    test('首次写入不产生 .bak，再次写入把上一版留为 .bak', async () => {
        // Arrange
        const { dir, lib } = makeLibrary('atomic');

        // Act
        await lib.add(recordOf());
        const bakAfterFirst = fs.existsSync(path.join(dir, `${INDEX_FILENAME}.bak`));
        await lib.add(recordOf({ outputPath: '/data/out/乙', name: '乙', title: '乙' }));

        // Assert
        assert.equal(bakAfterFirst, false);
        assert.equal(fs.existsSync(path.join(dir, `${INDEX_FILENAME}.tmp`)), false, '临时文件应已被 rename 消费');
        const bak = JSON.parse(fs.readFileSync(path.join(dir, `${INDEX_FILENAME}.bak`), 'utf8'));
        assert.equal(bak.records.length, 1, '.bak 应为上一版索引');
        const index = readIndex(dir);
        assert.equal(index.version, 1);
        assert.equal(index.records.length, 2);
    });

    test('主文件损坏：回退 .bak 并给出中文 warning', async () => {
        const { dir, lib } = makeLibrary('broken');
        await lib.add(recordOf());
        await lib.add(recordOf({ outputPath: '/data/out/乙', name: '乙' }));
        fs.writeFileSync(path.join(dir, INDEX_FILENAME), '{ 坏掉的 JSON', 'utf8');

        const reopened = createLibrary({ dir, now: Date.now, idFactory: idCounter('x') });
        const loaded = await reopened.load();

        assert.equal(loaded.count, 1, '应恢复 .bak 中的 1 条记录');
        assert.ok(loaded.warnings.some((w) => w.includes('不是合法 JSON')), loaded.warnings.join(' | '));
        assert.ok(loaded.warnings.some((w) => w.includes('已回退备份')), loaded.warnings.join(' | '));
        assert.deepEqual(reopened.warnings(), loaded.warnings);
    });

    test('主文件损坏且无 .bak：以空索引启动并给 warning', async () => {
        const dir = workDir('nobak');
        fs.writeFileSync(path.join(dir, INDEX_FILENAME), 'not json at all', 'utf8');

        const lib = createLibrary({ dir });
        const loaded = await lib.load();

        assert.equal(loaded.count, 0);
        assert.ok(loaded.warnings.some((w) => w.includes('以空索引启动')), loaded.warnings.join(' | '));
    });

    test('version 不符：拒绝其中的记录并给 warning', async () => {
        const dir = workDir('version');
        fs.writeFileSync(
            path.join(dir, INDEX_FILENAME),
            JSON.stringify({ version: 2, records: [{ id: 'a', createdAt: '2026-03-01T00:00:00.000Z', target: 'bundle', outputPath: '/x', source: { kind: 'file', value: '/x.docx' } }] }),
            'utf8',
        );

        const lib = createLibrary({ dir });
        const loaded = await lib.load();

        assert.equal(loaded.count, 0);
        assert.ok(loaded.warnings.some((w) => w.includes('版本') && w.includes('只支持 1')), loaded.warnings.join(' | '));
    });

    test('结构不合法的单条记录被跳过并计入 warning', async () => {
        const dir = workDir('bad-record');
        fs.writeFileSync(path.join(dir, INDEX_FILENAME), JSON.stringify({
            version: 1,
            records: [
                { id: 'ok', createdAt: '2026-03-01T00:00:00.000Z', target: 'bundle', outputPath: '/data/out/甲', source: { kind: 'file', value: '/data/in/甲.docx' } },
                { id: '缺产物路径' },
            ],
        }), 'utf8');

        const loaded = await createLibrary({ dir }).load();

        assert.equal(loaded.count, 1);
        assert.ok(loaded.warnings.some((w) => w.includes('第 2 条记录已跳过')), loaded.warnings.join(' | '));
    });

    test('索引文件不存在：空索引启动且无 warning', async () => {
        const { lib } = makeLibrary('fresh');
        assert.deepEqual(await lib.load(), { count: 0, warnings: [] });
    });
});

// ============================================================
// 增删改查
// ============================================================

describe('增删改查', () => {
    test('add 补齐 id 与时间戳、派生 source.dir/name，get 取回冻结深拷贝', async () => {
        const { lib, clock } = makeLibrary('crud');

        const added = await lib.add(recordOf());

        assert.equal(added.id, 'r1');
        assert.equal(added.createdAt, new Date(clock.now()).toISOString());
        assert.equal(added.updatedAt, added.createdAt);
        assert.deepEqual(added.source, {
            kind: 'file', value: '/data/in/甲.docx', type: 'docx', dir: '/data/in', name: '甲.docx',
        });
        assert.deepEqual(added.tags, []);
        assert.equal(added.favorite, false);
        assert.equal(added.managed, false);

        const got = await lib.get('r1');
        assert.deepEqual(got, added);
        assert.notEqual(got, added, '每次返回独立副本');
        assert.ok(Object.isFrozen(got) && Object.isFrozen(got.tags));
        assert.throws(() => got.tags.push('x'), TypeError);
        assert.equal(await lib.get('不存在'), null);
    });

    test('add 拒绝缺 outputPath 的记录，且不写入索引', async () => {
        const { dir, lib } = makeLibrary('reject');
        await lib.add(recordOf());

        await assert.rejects(() => lib.add(recordOf({ outputPath: '' })), /记录缺少 outputPath/);
        assert.equal(readIndex(dir).records.length, 1);
    });

    test('update 改 tags/favorite/highlighted/title 并刷新 updatedAt；未知字段与不存在的 id 抛中文错误', async () => {
        const { lib, clock } = makeLibrary('update');
        const added = await lib.add(recordOf());
        clock.advance(60_000);

        const updated = await lib.update('r1', { tags: [' 季报 ', '财务', '季报'], favorite: true, highlighted: true, title: '甲（终稿）' });

        assert.deepEqual(updated.tags, ['季报', '财务'], '标签去空白并去重');
        assert.equal(updated.favorite, true);
        assert.equal(updated.highlighted, true);
        assert.equal(updated.title, '甲（终稿）');
        assert.equal(updated.createdAt, added.createdAt);
        assert.notEqual(updated.updatedAt, added.updatedAt);
        assert.equal(updated.updatedAt, new Date(clock.now()).toISOString());

        await assert.rejects(() => lib.update('r1', { outputPath: '/tmp/x' }), /update 不接受字段：outputPath/);
        await assert.rejects(() => lib.update('不存在', { favorite: true }), /未找到记录：不存在/);
    });

    test('remove 只删索引条目，不动文件；重复删除返回 false', async () => {
        const { dir, lib } = makeLibrary('remove');
        const productDir = workDir('product');
        fs.writeFileSync(path.join(productDir, 'a.md'), '# a', 'utf8');
        await lib.add(recordOf({ outputPath: productDir }));

        assert.equal(await lib.remove('r1'), true);
        assert.equal(await lib.remove('r1'), false);
        assert.equal(readIndex(dir).records.length, 0);
        assert.equal(fs.existsSync(path.join(productDir, 'a.md')), true, '产物文件不得被删除');
    });

    test('paths 汇总 outputPath、outputs 与 extras 并去重，越界 extras 被丢弃', async () => {
        const { lib } = makeLibrary('paths');
        // extras 是相对 outputPath 的路径，由生产侧 path.resolve 拼成绝对路径，故基准目录取本机形态
        const out = absPath('/data/out/甲');
        await lib.add(recordOf({
            outputPath: out,
            outputs: { md: path.join(out, '甲.md'), imagesDir: path.join(out, 'images'), dup: path.join(out, '甲.md') },
            extras: ['mineru/full.md', '../越界.md'],
        }));

        assert.deepEqual(await lib.paths('r1'), [
            out,
            path.join(out, '甲.md'),
            path.join(out, 'images'),
            path.join(out, 'mineru', 'full.md'),
        ]);
        assert.deepEqual(await lib.paths('不存在'), []);
    });
});

// ============================================================
// 列表、搜索、分面
// ============================================================

// 四条样本：两个月份、三个来源目录（含一个 URL 主机）、两种 target
async function seedListLibrary(label) {
    const ctx = makeLibrary(label);
    await ctx.lib.add(recordOf({
        createdAt: '2026-01-10T00:00:00.000Z', source: { kind: 'file', value: '/data/in/甲.docx', type: 'docx' },
        name: '甲', title: '季度报告', outputPath: '/data/out/甲', tags: ['财务'],
    }));
    await ctx.lib.add(recordOf({
        createdAt: '2026-01-20T00:00:00.000Z', source: { kind: 'file', value: '/data/in/乙.xlsx', type: 'xlsx' },
        name: '乙', title: '预算表', outputPath: '/data/out/乙', target: 'html', tags: ['财务', '内部'], favorite: true,
    }));
    await ctx.lib.add(recordOf({
        createdAt: '2026-02-02T00:00:00.000Z', source: { kind: 'file', value: '/archive/丙.docx', type: 'docx' },
        name: '丙', title: 'Roadmap 2026', outputPath: '/data/out/丙',
    }));
    await ctx.lib.add(recordOf({
        createdAt: '2026-02-08T00:00:00.000Z',
        source: { kind: 'url', value: 'https://news.example.com/a/b', type: 'url' },
        name: 'b', title: '行业动态', outputPath: '/data/out/b',
    }));
    return ctx;
}

describe('列表、搜索与分面', () => {
    test('分面计数与 month/sourceDir 派生', async () => {
        const { lib } = await seedListLibrary('facets');

        const { total, facets } = await lib.list();

        assert.equal(total, 4);
        assert.deepEqual(facets.sourceType, [
            { value: 'docx', count: 2 }, { value: 'url', count: 1 }, { value: 'xlsx', count: 1 },
        ]);
        assert.deepEqual(facets.target, [{ value: 'bundle', count: 3 }, { value: 'html', count: 1 }]);
        assert.deepEqual(facets.month, [{ value: '2026-01', count: 2 }, { value: '2026-02', count: 2 }]);
        assert.deepEqual(facets.sourceDir, [
            { value: '/data/in', count: 2 },
            { value: '/archive', count: 1 },
            { value: 'news.example.com', count: 1 },
        ], 'URL 记录的 sourceDir 取主机');
        assert.deepEqual(facets.tag, [{ value: '财务', count: 2 }, { value: '内部', count: 1 }]);
        assert.deepEqual(facets.favorite, [{ value: true, count: 1 }, { value: false, count: 3 }]);
    });

    test('分面过滤：单选生效，分面计数随过滤结果收敛', async () => {
        const { lib } = await seedListLibrary('facet-filter');

        const byMonth = await lib.list({ facets: { month: '2026-01' } });
        assert.deepEqual(byMonth.items.map((item) => item.name), ['乙', '甲']);
        assert.equal(byMonth.total, 2);
        assert.deepEqual(byMonth.facets.month, [{ value: '2026-01', count: 2 }]);

        const byTag = await lib.list({ facets: { tag: '内部' } });
        assert.deepEqual(byTag.items.map((item) => item.name), ['乙']);

        const byFavorite = await lib.list({ facets: { favorite: true } });
        assert.deepEqual(byFavorite.items.map((item) => item.name), ['乙']);

        const bySourceDir = await lib.list({ facets: { sourceDir: 'news.example.com' } });
        assert.deepEqual(bySourceDir.items.map((item) => item.name), ['b']);

        await assert.rejects(() => lib.list({ facets: { 不存在: 'x' } }), /不支持的分面/);
    });

    test('搜索：大小写不敏感，覆盖 title/name/source.value/tags', async () => {
        const { lib } = await seedListLibrary('search');

        const byTitle = await lib.list({ query: 'roadmap' });
        assert.deepEqual(byTitle.items.map((item) => item.name), ['丙']);

        const byName = await lib.list({ query: '乙' });
        assert.deepEqual(byName.items.map((item) => item.name), ['乙']);

        const bySource = await lib.list({ query: 'NEWS.EXAMPLE.COM' });
        assert.deepEqual(bySource.items.map((item) => item.name), ['b']);

        const byTag = await lib.list({ query: '财务' });
        assert.deepEqual(byTag.items.map((item) => item.name).sort(), ['乙', '甲']);
        assert.equal(byTag.total, 2);
        assert.deepEqual(byTag.facets.month, [{ value: '2026-01', count: 2 }]);

        assert.equal((await lib.list({ query: '查无此项' })).total, 0);
    });

    test('排序与分页：默认 createdAt 降序，可切 title 升序并取分页', async () => {
        const { lib } = await seedListLibrary('sort');

        const latest = await lib.list();
        assert.deepEqual(latest.items.map((item) => item.name), ['b', '丙', '乙', '甲']);

        const oldest = await lib.list({ order: 'asc' });
        assert.deepEqual(oldest.items.map((item) => item.name), ['甲', '乙', '丙', 'b']);

        const byTitle = await lib.list({ sort: 'title', order: 'asc' });
        assert.deepEqual(byTitle.items.map((item) => item.title), ['季度报告', '行业动态', '预算表', 'Roadmap 2026']);

        const page = await lib.list({ sort: 'title', order: 'asc', limit: 2, offset: 1 });
        assert.equal(page.total, 4, 'total 为过滤后的总数，不受分页影响');
        assert.deepEqual(page.items.map((item) => item.name), ['b', '乙']);

        await assert.rejects(() => lib.list({ sort: 'size' }), /不支持的排序字段/);
        await assert.rejects(() => lib.list({ limit: -1 }), /limit 须为非负整数/);
    });

    test('missing：outputPath 不存在时标记为 true', async () => {
        const { lib } = makeLibrary('missing');
        const productDir = workDir('exists');
        await lib.add(recordOf({ outputPath: productDir }));

        const before = await lib.list();
        assert.equal(before.items[0].missing, false);

        fs.rmSync(productDir, { recursive: true, force: true });
        const after = await lib.list();
        assert.equal(after.items[0].missing, true);
    });
});

// ============================================================
// upsertFromResult / recordFromResult / managedOutputDir
// ============================================================

describe('转换结果入库', () => {
    test('file 输入：source 取目录与文件名，产物字段整体带入', async () => {
        const { lib, clock } = makeLibrary('upsert-file');

        const record = await lib.upsertFromResult(fileResult(), { managed: false });

        assert.equal(record.id, 'r1');
        assert.equal(record.createdAt, new Date(clock.now()).toISOString());
        assert.deepEqual(record.source, {
            kind: 'file', value: DEMO_INPUT_FILE, type: 'docx',
            dir: DEMO_INPUT_DIR, name: '季度报告.docx',
        });
        assert.equal(record.target, 'bundle');
        assert.equal(record.title, '季度报告 Q3');
        assert.equal(record.outputPath, DEMO_PRODUCT_DIR);
        assert.equal(record.outputs.md, path.join(DEMO_PRODUCT_DIR, '季度报告.md'));
        assert.equal(record.imagesCount, 3);
        assert.deepEqual(record.warnings, ['表格已降级为图片']);
        assert.deepEqual(record.options, { imageFormat: 'jpg', mineru: { token: null } });
        assert.equal(record.managed, false);
    });

    test('url 输入：source.kind 为 url，host 与末段文件名派生', async () => {
        const { lib } = makeLibrary('upsert-url');

        const record = await lib.upsertFromResult(urlResult(), { managed: true });

        assert.deepEqual(record.source, {
            kind: 'url',
            value: 'https://Example.COM/blog/2026/Node-22-Notes?ref=rss',
            type: 'url',
            host: 'example.com',
            name: 'Node-22-Notes',
        });
        assert.equal(record.managed, true);
        assert.equal(record.title, 'Node 22 发行说明');
    });

    test('同一 outputPath 再次转换：合并为同一条，保留 id/createdAt/标签，刷新 updatedAt 与产物字段', async () => {
        const { lib, clock } = makeLibrary('upsert-merge');
        const first = await lib.upsertFromResult(fileResult());
        await lib.update(first.id, { tags: ['季报'], favorite: true, highlighted: true });
        clock.advance(3_600_000);

        const again = await lib.upsertFromResult(fileResult({ imagesCount: 9, title: '季度报告 Q3（修订）' }));

        assert.equal(again.id, first.id);
        assert.equal(again.createdAt, first.createdAt);
        assert.notEqual(again.updatedAt, first.updatedAt);
        assert.equal(again.imagesCount, 9);
        assert.equal(again.title, '季度报告 Q3（修订）');
        assert.equal(again.highlighted, true);
        assert.deepEqual(again.tags, ['季报']);
        assert.equal(again.favorite, true);
        assert.equal((await lib.list()).total, 1);
    });

    test('recordFromResult 为纯函数：不产出 id 与时间戳，缺字段抛中文错误', () => {
        const draft = recordFromResult(fileResult(), { managed: true });

        assert.equal('id' in draft, false);
        assert.equal('createdAt' in draft, false);
        assert.equal(draft.managed, true);
        assert.deepEqual(draft.tags, []);
        assert.throws(() => recordFromResult(fileResult({ input: '' })), /转换结果缺少 input/);
        assert.throws(() => recordFromResult(fileResult({ outputPath: '' })), /转换结果缺少 outputPath/);
    });

    test('managedOutputDir 按 createdAt 月份归档，默认取当前时钟', () => {
        const { lib } = makeLibrary('managed-dir', { start: '2026-11-30T23:00:00.000Z' });

        const libRoot = absPath('/Users/demo/Documents/MarkFlow Library');
        const shortRoot = absPath('/lib');
        assert.equal(lib.managedOutputDir({ root: libRoot }), path.join(libRoot, '2026-11'));
        assert.equal(lib.managedOutputDir({ root: shortRoot, date: '2026-02-01T00:00:00.000Z' }), path.join(shortRoot, '2026-02'));
        assert.throws(() => lib.managedOutputDir({}), /需要托管根目录 root/);
    });
});

// ============================================================
// 写队列
// ============================================================

describe('写队列', () => {
    test('并发 add 串行落盘，10 条全部保留且索引文件一致', async () => {
        const { dir, lib } = makeLibrary('concurrent');

        const added = await Promise.all(Array.from({ length: 10 }, (unused, i) => lib.add(recordOf({
            outputPath: `/data/out/第${i}`, name: `第${i}`, title: `第${i}`,
        }))));

        assert.equal(new Set(added.map((record) => record.id)).size, 10);
        assert.equal((await lib.list()).total, 10);
        assert.equal(readIndex(dir).records.length, 10);
    });

    test('队列中一次失败不影响后续写入', async () => {
        const { lib } = makeLibrary('queue-error');

        const results = await Promise.allSettled([
            lib.add(recordOf({ outputPath: '/data/out/一' })),
            lib.add(recordOf({ outputPath: '' })),
            lib.add(recordOf({ outputPath: '/data/out/二' })),
        ]);

        assert.deepEqual(results.map((item) => item.status), ['fulfilled', 'rejected', 'fulfilled']);
        assert.equal((await lib.list()).total, 2);
    });
});

// ============================================================
// 托管迁移
// ============================================================

describe('planMigration', () => {
    const LIB_ROOT = absPath('/Users/demo/Documents/MarkFlow Library');

    test('跳过已托管、已在 root 内与缺 outputPath 的记录', () => {
        const plan = planMigration({
            root: LIB_ROOT,
            records: [
                { id: 'a', createdAt: '2026-03-01T00:00:00.000Z', outputPath: absPath('/data/out/甲'), managed: false },
                { id: 'b', createdAt: '2026-03-01T00:00:00.000Z', outputPath: absPath('/data/out/乙'), managed: true },
                { id: 'c', createdAt: '2026-03-01T00:00:00.000Z', outputPath: path.join(LIB_ROOT, '2026-03', '丙') },
                { id: 'd', createdAt: '2026-03-01T00:00:00.000Z', outputPath: '' },
                { id: 'e', createdAt: '不是时间', outputPath: absPath('/data/out/戊') },
            ],
        });

        assert.deepEqual(plan.moves, [
            { id: 'a', from: absPath('/data/out/甲'), to: path.join(LIB_ROOT, '2026-03', '甲'), conflict: false },
        ]);
        assert.deepEqual(plan.skipped, [
            { id: 'b', reason: '记录已处于托管模式' },
            { id: 'c', reason: '产物已位于托管根目录内' },
            { id: 'd', reason: '记录缺少 outputPath' },
            { id: 'e', reason: '无法推导归档月份："不是时间"' },
        ]);
    });

    test('同名冲突顺延 (2)、(3)，单文件产物的后缀插在扩展名之前', () => {
        const base = { createdAt: '2026-03-01T00:00:00.000Z' };
        const plan = planMigration({
            root: LIB_ROOT,
            records: [
                { ...base, id: 'a', outputPath: absPath('/in/一/报告') },
                { ...base, id: 'b', outputPath: absPath('/in/二/报告') },
                { ...base, id: 'c', outputPath: absPath('/in/三/报告') },
                { ...base, id: 'd', outputPath: absPath('/in/一/说明.docx') },
                { ...base, id: 'e', outputPath: absPath('/in/二/说明.docx') },
            ],
        });

        assert.deepEqual(plan.moves.map((move) => ({ id: move.id, to: move.to, conflict: move.conflict })), [
            { id: 'a', to: path.join(LIB_ROOT, '2026-03', '报告'), conflict: false },
            { id: 'b', to: path.join(LIB_ROOT, '2026-03', '报告 (2)'), conflict: true },
            { id: 'c', to: path.join(LIB_ROOT, '2026-03', '报告 (3)'), conflict: true },
            { id: 'd', to: path.join(LIB_ROOT, '2026-03', '说明.docx'), conflict: false },
            { id: 'e', to: path.join(LIB_ROOT, '2026-03', '说明 (2).docx'), conflict: true },
        ]);
    });

    test('按月份分桶，monthOf 可注入', () => {
        const plan = planMigration({
            root: LIB_ROOT,
            monthOf: () => '2030-12',
            records: [{ id: 'a', createdAt: '2026-03-01T00:00:00.000Z', outputPath: absPath('/in/甲') }],
        });

        assert.equal(plan.moves[0].to, path.join(LIB_ROOT, '2030-12', '甲'));
        assert.throws(() => planMigration({ records: [], root: '' }), /需要托管根目录 root/);
    });
});

describe('runMigration', () => {
    /**
     * 夹具自带的递归拷贝，刻意不用 fs.cpSync。
     * Node 22 的 cpSync 落到原生绑定 fsBinding.cpSyncCheckPaths，该实现在 Windows 上会以
     * 0xC0000409（STATUS_STACK_BUFFER_OVERRUN，退出码 3221226505）直接终止进程，且不抛任何 JS 异常、
     * 无栈可查；目录名含非 ASCII 字符（本夹具的「季度报告」）时尤其容易命中。上游至今未修，
     * 见 nodejs/node#54476 与 #59408。生产代码走的是异步 fsp.cp（JS 实现），不经过该原生路径。
     * 此处只是 EXDEV 回退分支的桩实现，换成 copyFileSync 逐项拷贝后语义完全相同。
     */
    const copyTree = (from, to) => {
        fs.mkdirSync(to, { recursive: true });
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
            const src = path.join(from, entry.name);
            const dest = path.join(to, entry.name);
            if (entry.isDirectory()) copyTree(src, dest);
            else fs.copyFileSync(src, dest);
        }
    };

    // 造一个真实产物目录并入库，返回 { lib, record, libRoot }
    async function seedMigration(label) {
        const { lib, clock } = makeLibrary(label, { start: '2026-04-09T02:00:00.000Z' });
        const outputDir = workDir(`${label}-src`);
        const productDir = path.join(outputDir, '季度报告');
        fs.mkdirSync(path.join(productDir, 'images'), { recursive: true });
        fs.writeFileSync(path.join(productDir, '季度报告.md'), '# 季度报告', 'utf8');
        fs.writeFileSync(path.join(productDir, 'images', 'image_1.jpg'), 'fake', 'utf8');

        const record = await lib.upsertFromResult(fileResult({
            outputPath: productDir,
            outputs: {
                md: path.join(productDir, '季度报告.md'),
                imagesDir: path.join(productDir, 'images'),
            },
            extras: ['mineru/full.md'],
        }));
        return { lib, clock, record, libRoot: workDir(`${label}-lib`) };
    }

    test('成功：文件落到 {root}/{YYYY-MM}/，记录路径整体平移并置 managed', async () => {
        const { lib, record, libRoot } = await seedMigration('migrate-ok');
        const plan = planMigration({ records: [record], root: libRoot });

        const result = await runMigration(plan, { library: lib });

        const to = path.join(libRoot, '2026-04', '季度报告');
        assert.deepEqual(result.failed, []);
        assert.deepEqual(result.moved, [{ id: record.id, from: record.outputPath, to }]);
        assert.equal(fs.existsSync(path.join(to, '季度报告.md')), true);
        assert.equal(fs.existsSync(path.join(to, 'images', 'image_1.jpg')), true);
        assert.equal(fs.existsSync(record.outputPath), false);

        const updated = await lib.get(record.id);
        assert.equal(updated.outputPath, to);
        assert.equal(updated.outputs.md, path.join(to, '季度报告.md'));
        assert.equal(updated.outputs.imagesDir, path.join(to, 'images'));
        assert.deepEqual(updated.extras, ['mineru/full.md'], 'extras 为相对路径，随目录平移无需改写');
        assert.equal(updated.managed, true);
        assert.equal(updated.createdAt, record.createdAt);
        assert.equal((await lib.list()).items[0].missing, false);
    });

    test('跨卷：rename 抛 EXDEV 时回退 copy + rm', async () => {
        const { lib, record, libRoot } = await seedMigration('migrate-exdev');
        const plan = planMigration({ records: [record], root: libRoot });
        const calls = [];
        const exdev = Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });

        const result = await runMigration(plan, {
            library: lib,
            fs: {
                rename: async () => { calls.push('rename'); throw exdev; },
                copy: async (from, to) => { calls.push(`copy:${path.basename(to)}`); copyTree(from, to); },
                rm: async (target) => { calls.push('rm'); fs.rmSync(target, { recursive: true, force: true }); },
            },
        });

        assert.deepEqual(calls, ['rename', 'copy:季度报告', 'rm']);
        assert.equal(result.failed.length, 0);
        const to = path.join(libRoot, '2026-04', '季度报告');
        assert.equal(fs.readFileSync(path.join(to, '季度报告.md'), 'utf8'), '# 季度报告');
        assert.equal(fs.existsSync(record.outputPath), false);
        assert.equal((await lib.get(record.id)).outputPath, to);
    });

    test('失败：原记录一字不动，错误文本中文可读', async () => {
        const { lib, record, libRoot } = await seedMigration('migrate-fail');
        const plan = planMigration({ records: [record], root: libRoot });
        const events = [];

        const result = await runMigration(plan, {
            library: lib,
            onProgress: (payload) => events.push(payload),
            fs: { rename: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } },
        });

        assert.deepEqual(result.moved, []);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].id, record.id);
        assert.match(result.failed[0].error, /permission denied/);
        assert.equal(fs.existsSync(path.join(record.outputPath, '季度报告.md')), true, '原产物应保持原位');

        const unchanged = await lib.get(record.id);
        assert.equal(unchanged.outputPath, record.outputPath);
        assert.equal(unchanged.managed, false);
        assert.equal(unchanged.updatedAt, record.updatedAt);
        assert.deepEqual(events.map((event) => ({ ok: event.ok, total: event.total })), [{ ok: false, total: 1 }]);
    });

    test('多条记录：一条失败不中断其余迁移', async () => {
        const { lib, libRoot } = await seedMigration('migrate-mixed');
        const otherDir = workDir('migrate-mixed-src2');
        const otherProduct = path.join(otherDir, '预算表');
        fs.mkdirSync(otherProduct, { recursive: true });
        fs.writeFileSync(path.join(otherProduct, '预算表.md'), '# 预算表', 'utf8');
        await lib.upsertFromResult(fileResult({
            input: '/Users/demo/输入/预算表.xlsx', sourceType: 'xlsx', name: '预算表', title: '预算表',
            outputPath: otherProduct, outputs: { md: path.join(otherProduct, '预算表.md') },
        }));

        const { items } = await lib.list({ order: 'asc' });
        const plan = planMigration({ records: items, root: libRoot });
        const result = await runMigration(plan, {
            library: lib,
            fs: {
                rename: async (from, to) => {
                    if (from.endsWith('季度报告')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
                    fs.renameSync(from, to);
                },
            },
        });

        assert.equal(result.moved.length, 1);
        assert.equal(result.failed.length, 1);
        assert.equal(path.basename(result.moved[0].to), '预算表');
        assert.equal(fs.existsSync(path.join(libRoot, '2026-04', '预算表', '预算表.md')), true);
    });

    test('计划为空或形状不对：分别返回空结果与中文错误', async () => {
        assert.deepEqual(await runMigration({ moves: [], skipped: [] }), { moved: [], failed: [] });
        await assert.rejects(() => runMigration({}), /需要 planMigration 产出的计划/);
    });
});
