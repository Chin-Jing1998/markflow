/**
 * converters/naming.js 批内产物名登记表单元测试
 * 覆盖：同槽冲突的四条裁决规则、网页输入无扩展名、按 layout/ext 分槽、
 *       按批内序号排队（最终名与解析先后无关）、release 放行后续与不撤销已登记的名字、
 *       登记表互相独立（跨批次不去重）与非法入参的中文错误
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createNameRegistry } = require('../converters/naming');

// 登记表只看 source.type 是否为 url 与 sourceName 的扩展名，故可直接构造
const fileSource = (sourceName) => ({ type: path.extname(sourceName).slice(1), sourceName });
const urlSource = (url) => ({ type: 'url', url, sourceName: url });
// 默认按 bundle 目标的落盘形态（folder 布局、主产物 md）登记
const FOLDER = Object.freeze({ layout: 'folder', ext: 'md' });
const SINGLE_DOCX = Object.freeze({ layout: 'single', ext: 'docx' });

describe('同槽冲突的裁决规则', () => {
    test('首个占用者保留原名；异扩展名加 (ext)，同扩展名加 (2)，连锁冲突继续递增', async () => {
        // Arrange
        const { claim } = createNameRegistry();
        const claimFile = (sourceName) => claim({ name: 'sample', source: fileSource(sourceName), ...FOLDER });

        // Act & Assert
        assert.equal(await claimFile('sample.docx'), 'sample');
        assert.equal(await claimFile('sample.pptx'), 'sample (pptx)');
        assert.equal(await claimFile('sample.docx'), 'sample (2)');
        assert.equal(await claimFile('sample.pptx'), 'sample (pptx) (2)');
        assert.equal(await claimFile('sample.docx'), 'sample (3)');
        assert.equal(await claim({ name: '另一个', source: fileSource('另一个.md'), ...FOLDER }), '另一个');
    });

    test('网页输入无扩展名，标题重复时一律数字递增；扩展名大小写归一', async () => {
        // Arrange
        const { claim } = createNameRegistry();
        const claimUrl = (url) => claim({ name: '季度报告', source: urlSource(url), ...FOLDER });

        // Act & Assert
        assert.equal(await claimUrl('https://a.example/1'), '季度报告');
        assert.equal(await claimUrl('https://b.example/2'), '季度报告 (2)');
        assert.equal(await claimUrl('https://c.example/3'), '季度报告 (3)');
        const other = createNameRegistry();
        assert.equal(await other.claim({ name: 'x', source: fileSource('x.docx'), ...FOLDER }), 'x');
        assert.equal(await other.claim({ name: 'x', source: { type: 'pptx', sourceName: 'x.PPTX' }, ...FOLDER }), 'x (pptx)');
    });
});

describe('按落盘形态分槽', () => {
    test('folder 布局的目录与 single 布局的文件互不占位，同槽才改名', async () => {
        // Arrange
        const { claim } = createNameRegistry();

        // Act：sample.docx → bundle 产出目录 sample/，sample.md → docx 产出文件 sample.docx
        const folder = await claim({ name: 'sample', source: fileSource('sample.docx'), ...FOLDER });
        const single = await claim({ name: 'sample', source: fileSource('sample.md'), ...SINGLE_DOCX });
        const sameSlot = await claim({ name: 'sample', source: fileSource('sample.md'), ...SINGLE_DOCX });

        // Assert
        assert.equal(folder, 'sample');
        assert.equal(single, 'sample');
        assert.equal(sameSlot, 'sample (2)');
    });

    test('single 布局之间按目标扩展名分槽：docx 与 pdf 互不占位', async () => {
        const { claim } = createNameRegistry();
        const source = fileSource('sample.md');
        assert.equal(await claim({ name: 'sample', source, ...SINGLE_DOCX }), 'sample');
        assert.equal(await claim({ name: 'sample', source, layout: 'single', ext: 'pdf' }), 'sample');
        assert.equal(await claim({ name: 'sample', source, layout: 'single', ext: 'pdf' }), 'sample (2)');
    });
});

describe('按批内序号排队', () => {
    test('后发起的序号 0 仍得原名：最终名只由序号决定，与登记发起的先后无关', async () => {
        // Arrange
        const { claim } = createNameRegistry();

        // Act：序号 1 先发起（其登记将等待序号 0），序号 0 后发起
        const late = claim({ name: 'sample', source: fileSource('sample.pptx'), order: 1, ...FOLDER });
        const early = claim({ name: 'sample', source: fileSource('sample.docx'), order: 0, ...FOLDER });

        // Assert
        assert.equal(await early, 'sample');
        assert.equal(await late, 'sample (pptx)');
    });

    test('release 放行后续：前序任务失败不占用名字，也不卡住整批', async () => {
        // Arrange
        const { claim, release } = createNameRegistry();
        const waiting = claim({ name: 'sample', source: fileSource('sample.docx'), order: 1, ...FOLDER });

        // Act：序号 0 的任务失败（从未登记），放行后续
        release(0);

        // Assert
        assert.equal(await waiting, 'sample');
    });

    test('release 不撤销已登记的名字，重复放行为空操作', async () => {
        // Arrange
        const { claim, release } = createNameRegistry();
        assert.equal(await claim({ name: 'sample', source: fileSource('sample.docx'), order: 0, ...FOLDER }), 'sample');

        // Act：序号 0 已登记后才失败（落盘可能已部分完成），放行不应把名字让出去
        release(0);
        release(0);

        // Assert
        assert.equal(await claim({ name: 'sample', source: fileSource('sample.docx'), order: 1, ...FOLDER }), 'sample (2)');
    });

    test('省略 order 即不排队，登记立即生效', async () => {
        const { claim } = createNameRegistry();
        assert.equal(await claim({ name: 'sample', source: fileSource('sample.docx'), ...FOLDER }), 'sample');
        assert.equal(await claim({ name: 'sample', source: fileSource('sample.docx'), ...FOLDER }), 'sample (2)');
    });
});

describe('登记表边界', () => {
    test('登记表互相独立（跨批次不去重）', async () => {
        const source = fileSource('sample.docx');
        assert.equal(await createNameRegistry().claim({ name: 'sample', source, ...FOLDER }), 'sample');
        assert.equal(await createNameRegistry().claim({ name: 'sample', source, ...FOLDER }), 'sample');
    });

    test('name 为空即抛中文错误，且仍放行后续序号', async () => {
        // Arrange
        const { claim } = createNameRegistry();
        const source = fileSource('sample.docx');
        const waiting = claim({ name: 'sample', source, order: 1, ...FOLDER });

        // Act & Assert
        await assert.rejects(claim({ name: '   ', source, order: 0, ...FOLDER }), /产物名登记需要非空的 name/);
        await assert.rejects(createNameRegistry().claim(), /产物名登记需要非空的 name/);
        assert.equal(await waiting, 'sample', '前序登记失败不应卡住后续');
    });
});
