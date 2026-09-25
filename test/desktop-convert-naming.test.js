/**
 * 桌面端「转换」页批内产物名登记回归（desktop/main/ipc.js 的 mf:convert:run）
 *
 * 桌面端一轮转换把任务逐个入队、并发执行，每个任务各调一次 service.runConversion；若每次新建一张产物名
 * 登记表，不同子目录下的同名文件就会写进同一个产物目录并互相覆盖。整轮共用一张登记表后，行为须与 CLI
 * 的单次 runConversion 一致。覆盖：
 *   1. 两个子目录下的同名 docx 一并转换，产物为 report 与 report (2)，两份内容各自完整（真解析真落盘）；
 *   2. 后入队的任务先解析完也抢不到原名——登记按批内序号排队，与并发下谁先解析完无关；
 *   3. 前序任务失败时放行后续，整轮不卡在登记排队上。
 */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createIpcHandlers, validatePayload } = require('../desktop/main/ipc');
const { createSettingsStore } = require('../desktop/main/settings');
const scan = require('../desktop/main/scan');
const service = require('../converters/service');
const converters = require('../converters');
const { createDocument, createRoot, createParagraph } = require('../converters/ir/schema');
const { buildTitleSample } = require('./fixtures/build-title-sample');

const CONVERT_RUN = 'mf:convert:run';
const CONVERT_EVENT = 'mf:convert:event';

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'convert-naming-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// settings 只在本文件里存放输出目录，令牌不参与用例，故加解密用可逆的桩
const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`enc:${text}`),
    decryptString: (buffer) => Buffer.from(buffer).toString('utf8').slice(4),
};

// ============================================================
// 夹具
// ============================================================

/** 真实 service、无文件库的最小主进程环境；预览与阅读通道用不到，故不注入 */
function makeHarness() {
    const dir = fs.mkdtempSync(path.join(root, 'run-'));
    const outputDir = path.join(dir, 'out');
    const settings = createSettingsStore({
        dir, safeStorage: fakeSafeStorage, defaults: { outputDir, libraryRoot: path.join(dir, 'lib') },
    });
    settings.load();
    const electron = {
        dialog: {},
        shell: { openExternal: async () => undefined, showItemInFolder: () => undefined, openPath: async () => '', trashItem: async () => undefined },
        nativeTheme: { shouldUseDarkColors: false },
        BrowserWindow: { fromWebContents: () => null },
    };
    const { handlers } = createIpcHandlers({ electron, settings, service, scan, log: () => undefined });
    return { dir, outputDir, handlers };
}

/** 发起一轮转换并等到 finished 事件；回 { res, events, summary, nameOf } */
async function runConvert(h, items) {
    const events = [];
    let markFinished = () => {};
    const finished = new Promise((resolve) => { markFinished = resolve; });
    const event = {
        sender: {
            isDestroyed: () => false,
            send: (channel, payload) => {
                assert.equal(channel, CONVERT_EVENT);
                events.push(payload);
                if (payload.status === 'finished') markFinished(payload);
            },
        },
    };
    const payload = validatePayload(CONVERT_RUN, { items });
    const res = await h.handlers[CONVERT_RUN](event, payload);
    const last = await finished;
    // 并发下 done 事件的先后不定，故按 taskId 取结果而非按到达顺序
    const results = new Map(events.filter((item) => item.status === 'done').map((item) => [item.taskId, item.result]));
    return { res, events, summary: last.summary, nameOf: (taskId) => (results.get(taskId) || {}).name };
}

/** 在 dir/sub/ 下造一份以 title 为题名的 docx，回绝对路径 */
async function seedDocx(dir, sub, fileName, title) {
    const folder = path.join(dir, sub);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, fileName);
    fs.writeFileSync(file, await buildTitleSample({ title }));
    return file;
}

const readBundleMd = (outputDir, name) => fs.readFileSync(path.join(outputDir, name, `${name}.md`), 'utf8');

// ============================================================
// 用例
// ============================================================

describe('桌面端一轮转换共用产物名登记表', () => {
    test('两个子目录下的同名 docx 一并转换：产物为 report 与 report (2)，两份内容都在', async () => {
        // Arrange
        const h = makeHarness();
        const first = await seedDocx(h.dir, '甲', 'report.docx', '甲方年度报告');
        const second = await seedDocx(h.dir, '乙', 'report.docx', '乙方年度报告');

        // Act
        const run = await runConvert(h, [{ id: 'a', path: first }, { id: 'b', path: second }]);

        // Assert
        assert.deepEqual(run.summary, { total: 2, succeeded: 2, failed: 0, cancelled: 0 });
        assert.equal(run.nameOf('a'), 'report');
        assert.equal(run.nameOf('b'), 'report (2)');
        assert.deepEqual(fs.readdirSync(run.res.outputDir).sort(), ['report', 'report (2)']);
        assert.match(readBundleMd(run.res.outputDir, 'report'), /甲方年度报告/);
        assert.match(readBundleMd(run.res.outputDir, 'report (2)'), /乙方年度报告/);
    });

    test('后入队的任务先解析完也抢不到原名：最终名只由入队顺序决定', async () => {
        // Arrange：第 2 项立即解析完，第 1 项要等它解析完才返回，解析先后与入队顺序恰好相反
        const h = makeHarness();
        const first = path.join(h.dir, '甲', 'report.docx');
        const second = path.join(h.dir, '乙', 'report.docx');
        for (const file of [first, second]) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, 'PK');
        }
        let markSecondParsed = () => {};
        const secondParsed = new Promise((resolve) => { markSecondParsed = resolve; });
        let parsedCount = 0;
        const stubs = {
            './renderers/md': { render: async () => '# 正文\n' },
            './renderers/json': { render: async () => '{}' },
            './parsers/docx': {
                parse: async () => {
                    parsedCount += 1;
                    // 第 1 项（parsedCount 为 1）等第 2 项解析完；并发为 2，两项同时起跑
                    if (parsedCount === 1) await secondParsed;
                    else markSecondParsed();
                    return createDocument({ ir: createRoot([createParagraph('正文')]), meta: { sourceType: 'docx' } });
                },
            },
        };

        // Act
        const run = await withStubs(stubs, () => runConvert(h, [{ id: 'a', path: first }, { id: 'b', path: second }]));

        // Assert
        assert.deepEqual(run.summary, { total: 2, succeeded: 2, failed: 0, cancelled: 0 });
        assert.equal(run.nameOf('a'), 'report', '入队在先者保留原名');
        assert.equal(run.nameOf('b'), 'report (2)');
        assert.deepEqual(fs.readdirSync(run.res.outputDir).sort(), ['report', 'report (2)']);
    });

    test('前序任务失败时放行后续：整轮不卡住，失败项也不占用名字', async () => {
        // Arrange：第 1 项的文件不存在，convert 在登记之前即失败
        const h = makeHarness();
        const missing = path.join(h.dir, '缺失', 'report.docx');
        const first = await seedDocx(h.dir, '甲', 'report.docx', '甲方年度报告');
        const second = await seedDocx(h.dir, '乙', 'report.docx', '乙方年度报告');

        // Act
        const run = await runConvert(h, [
            { id: 'x', path: missing }, { id: 'a', path: first }, { id: 'b', path: second },
        ]);

        // Assert
        assert.deepEqual(run.summary, { total: 3, succeeded: 2, failed: 1, cancelled: 0 });
        const failed = run.events.find((item) => item.status === 'failed');
        assert.equal(failed.taskId, 'x');
        assert.match(failed.error, /输入文件不存在/);
        assert.equal(run.nameOf('a'), 'report', '失败项不占用名字');
        assert.equal(run.nameOf('b'), 'report (2)');
        assert.deepEqual(fs.readdirSync(run.res.outputDir).sort(), ['report', 'report (2)']);
    });
});

// 桩 parser / renderer 只经调度器的 moduleLoader 注入，避免用例依赖真实解析后端
function withStubs(stubs, fn) {
    converters._setModuleLoader((rel) => (
        Object.hasOwn(stubs, rel) ? stubs[rel] : require(path.join(__dirname, '..', 'converters', rel))
    ));
    return fn().finally(() => converters._reset());
}
