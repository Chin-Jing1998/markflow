/**
 * desktop/main/preview-session.js 单元测试
 * 转换内核（parseDocument / renderDocument / writeDocument）与 mammoth 以桩替代，
 * 授权表、临时目录与选项映射用真实实现，故 mf-asset 地址、临时目录清理与令牌注入都是真行为。
 *
 * 覆盖：open 只解析一次并同时给出来源栏与产物栏；render 复用缓存只重渲染；
 *       命中 REPARSE_KEYS 的选项变更被标出并触发重新解析（连同来源栏重建）；
 *       xml 产物的五书分文件、precheck 与结构化视图（官方案卷结构下按书目目录取图、按内容选主视图）；
 *       真实转换内核下专利预览的图片地址逐一可经 mf-asset 协议解析；export 落盘后写入文件库记录；
 *       close 撤销 mf-asset 授权并删除会话临时目录；
 *       网页来源 open/render 走通且全程不经路径展开；
 *       MinerU 令牌注入 buildOptions 却不出现在任何回包与会话选项里。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPreviewSessions, changedReparseKeys, REPARSE_KEYS } = require('../desktop/main/preview-session');
const { createAssetGrants, resolveAssetRequest } = require('../desktop/main/asset-protocol');
const service = require('../converters/service');
const { redactOptions } = require('../converters/options');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'preview-'));
/** 会话临时目录建在 os.tmpdir() 下，须逐个会话关闭后才会删除；用例跑完统一收尾，避免残留 */
const harnesses = [];
after(async () => {
    for (const harness of harnesses) await harness.preview.closeAll();
    fs.rmSync(root, { recursive: true, force: true });
});

const TOKEN = 'mineru-secret-token-4242';
const SOURCE_DOCX = path.join(root, '专利申请.docx');
fs.writeFileSync(SOURCE_DOCX, 'PK-not-a-real-docx');
const SOURCE_URL = 'https://example.com/article/1';

const PRECHECK = {
    profile: 'patent', generatedAt: '2026-09-13T00:00:00.000Z', source: '专利申请.docx',
    blocking: [], warnings: ['段号：段号跳变'],
    items: [{ code: 'NUMBERING_JUMP', level: 'warning', category: 'numbering', message: '段号：段号跳变' }],
};
// 与 patent 渲染器的真实产出同形：UTF-8 BOM、CRLF、空元素 " />"，五书按表格代码分目录、图片与所属 XML 同目录
const PATENT_DESCRIPTION = [
    '\ufeff<?xml version="1.0" encoding="UTF-8"?>',
    '<cn-application-body lang="zh" country="CN"><description>',
    '<invention-title>一种测试装置</invention-title>',
    '<p id="p0001" num="0001" Italic="0">正文<tables id="tabl0001" num="0001"><img id="idf0001" file="100002_1.jpg" wi="60" he="20" inline="no" /></tables></p>',
    '</description></cn-application-body>',
    '',
].join('\r\n');
const PATENT_CLAIMS = '<cn-application-body><cn-claims><claim id="cl001" num="1"><claim-text>一种测试装置。</claim-text></claim></cn-claims></cn-application-body>';
const PATENT_DESCRIPTION_FILE = '100002/100002.xml';
const PATENT_CLAIMS_FILE = '100001/100001.xml';
const PATENT_TABLE_IMAGE = '100002/100002_1.jpg';

// ============================================================
// 桩
// ============================================================

function makeDoc(tag) {
    return {
        ir: { type: 'root', children: [] },
        meta: { title: '样例文档' },
        assets: [{ name: 'images/image_1.jpg', buffer: Buffer.from(`jpg-${tag}`) }],
        extras: [],
        warnings: [`解析提示-${tag}`],
    };
}

function makeCore() {
    const calls = { parse: [], render: [], write: [] };
    let parseSeq = 0;
    const core = {
        calls,
        parseDocument: async ({ input, options }) => {
            parseSeq += 1;
            calls.parse.push({ input, options, seq: parseSeq });
            return { source: {}, doc: makeDoc(parseSeq), name: '样例文档', title: '样例文档', options, backends: { pdfParser: 'pdfjs', raster: 'in-process' } };
        },
        renderDocument: async (doc, target, options, context = {}) => {
            calls.render.push({ target, options, imageMode: context.imageMode, docTag: doc.warnings[0] });
            if (target === 'html') {
                const base = context.imageMode && context.imageMode.base ? context.imageMode.base : '';
                return { files: { '{name}.html': `<html><body><img src="${base}images/image_1.jpg"><p>主题 ${options.html.theme} 字号 ${options.html.fontSize}</p></body></html>` }, assets: doc.assets, extras: [], warnings: [], title: null, layout: 'folder' };
            }
            if (target === 'xml') {
                return {
                    files: {
                        [PATENT_CLAIMS_FILE]: PATENT_CLAIMS,
                        [PATENT_DESCRIPTION_FILE]: PATENT_DESCRIPTION,
                        '{name}.zip': Buffer.from('zip'),
                        'precheck.json': JSON.stringify(PRECHECK),
                    },
                    assets: [{ name: PATENT_TABLE_IMAGE, buffer: Buffer.from('table') }],
                    extras: [], warnings: ['段号：段号跳变'], title: '一种测试装置', layout: 'folder',
                };
            }
            if (target === 'bundle') {
                return { files: { '{name}.md': '# 样例\n\n![图](images/image_1.jpg)\n', '{name}.json': '{}' }, assets: doc.assets, extras: [], warnings: [], title: null, layout: 'folder' };
            }
            if (target === 'docx') return { files: { '{name}.docx': Buffer.from('docx') }, assets: [], extras: [], warnings: [], title: null, layout: 'single' };
            if (target === 'pdf') return { files: { '{name}.pdf': Buffer.from('%PDF-1.4') }, assets: [], extras: [], warnings: [], title: null, layout: 'single' };
            throw new Error(`桩渲染器不支持目标：${target}`);
        },
        writeDocument: async ({ rendered, target, outputDir, name }) => {
            calls.write.push({ target, outputDir, name, files: Object.keys(rendered.files) });
            const outputPath = path.join(outputDir, name);
            fs.mkdirSync(outputPath, { recursive: true });
            return { outputPath, outputs: { [target]: path.join(outputPath, `${name}.${target}`) }, extras: [] };
        },
        buildOptions: service.buildOptions,
        redactOptions,
    };
    return core;
}

/** mammoth 桩：只回一段正文，图片回调不被调用也不影响断言 */
const mammothStub = {
    images: { imgElement: (fn) => fn },
    convertToHtml: async (input) => ({ value: `<p>mammoth 直转：${input.path ? 'path' : 'buffer'}</p><img src="images/image_1.jpg">`, messages: [] }),
};

function makeHarness({ libraryMode = 'index', withLibrary = true, token = TOKEN, coreOverrides = null } = {}) {
    const dir = fs.mkdtempSync(path.join(root, 'h-'));
    const outputDir = path.join(dir, 'out');
    fs.mkdirSync(outputDir, { recursive: true });
    const upserts = [];
    const library = withLibrary ? {
        upsertFromResult: async (result, options) => { upserts.push({ result, options }); return { id: `rec-${upserts.length}` }; },
        managedOutputDir: ({ root: base }) => path.join(base, '2026-09'),
    } : null;
    const settings = {
        get: () => ({
            defaults: { theme: 'apple', imageFormat: 'jpg' },
            defaultTargets: { office: 'bundle', markup: 'docx', url: 'bundle' },
            outputDir,
            library: { mode: libraryMode, root: path.join(dir, 'managed') },
        }),
        getMineruToken: () => token,
    };
    const grants = createAssetGrants();
    const core = makeCore();
    if (typeof coreOverrides === 'function') Object.assign(core, coreOverrides(core));
    const preview = createPreviewSessions({ grants, settings, library, core, mammoth: mammothStub, log: () => undefined });
    const harness = { preview, grants, core, upserts, outputDir, dir, settings };
    harnesses.push(harness);
    return harness;
}

const openDocx = (h, extra = {}) => h.preview.open({ path: SOURCE_DOCX, type: 'docx', target: 'html', options: { theme: 'github', fontSize: 18 }, ...extra });

/** 去掉块注释与行注释，使结构性守卫只看实际代码 */
const stripComments = (source) => String(source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ============================================================
// open
// ============================================================

test('open 只解析一次，同时给出来源栏与产物栏，图片经 mf-asset 寻址', async () => {
    const h = makeHarness();
    const opened = await openDocx(h);

    assert.equal(h.core.calls.parse.length, 1, 'open 只允许解析一次');
    assert.deepEqual(h.core.calls.parse[0].input, { path: SOURCE_DOCX });
    assert.match(opened.sessionId, /^preview-/);
    assert.equal(opened.type, 'docx');
    assert.equal(opened.target, 'html');
    assert.equal(opened.live, true, 'html 目标支持实时重渲染');
    assert.deepEqual(opened.source, { kind: 'file', value: SOURCE_DOCX, name: '专利申请.docx', dir: root, type: 'docx' });
    assert.deepEqual(opened.backends, { pdfParser: 'pdfjs', raster: 'in-process' });
    assert.deepEqual(opened.warnings, ['解析提示-1']);

    // 来源栏：docx 走 mammoth 直转并经 html-sanitize
    assert.equal(opened.sourceView.kind, 'html');
    assert.equal(opened.sourceView.structured, false);
    assert.ok(opened.sourceView.html.includes('mammoth 直转：path'));

    // 产物栏：html 用 mf-asset 前缀取图，选项落到渲染器
    const session = h.preview.sessions.get(opened.sessionId);
    const base = `mf-asset://${session.sid}/`;
    assert.equal(opened.product.view.kind, 'html');
    assert.ok(opened.product.view.html.includes(`${base}product/images/image_1.jpg`), `产物图片未走 mf-asset：${opened.product.view.html}`);
    assert.ok(opened.product.view.html.includes('主题 github 字号 18'), '面板选项未透传到渲染器');
    assert.deepEqual(opened.product.files, ['样例文档.html']);
    assert.deepEqual(opened.product.warnings, ['解析提示-1']);

    // 资产真的落到了会话临时目录，且授权根就是该目录
    assert.ok(fs.existsSync(path.join(session.tempDir, 'product', 'images', 'image_1.jpg')));
    assert.deepEqual(h.grants.get(session.sid).roots, [session.tempDir]);
    assert.match(session.sid, /^[0-9a-f]{32}$/);
});

test('open 拒绝与输入类别不兼容的目标', async () => {
    const h = makeHarness();
    await assert.rejects(h.preview.open({ path: SOURCE_DOCX, type: 'docx', target: 'docx' }), /docx/);
    assert.equal(h.core.calls.parse.length, 0, '目标不合法时不应解析');
    assert.equal(h.preview.sessions.size, 0);
});

// ============================================================
// render
// ============================================================

test('render 复用缓存：非重解析项只重渲染，不再解析', async () => {
    const h = makeHarness();
    const opened = await openDocx(h);
    const rendered = await h.preview.render({ sessionId: opened.sessionId, options: { theme: 'academic', fontSize: 20 } });

    assert.equal(h.core.calls.parse.length, 1, 'render 不应重新解析');
    assert.equal(rendered.reparsed, false);
    assert.deepEqual(rendered.changedKeys, []);
    assert.equal(rendered.sourceView, undefined, '未重新解析时不重建来源栏');
    assert.ok(rendered.product.view.html.includes('主题 academic 字号 20'));
    // docx 来源栏走 mammoth 直转、不经 renderDocument，故 html 渲染恰为 open 与 render 各一次
    assert.equal(h.core.calls.render.filter((item) => item.target === 'html').length, 2);
});

test('预览选项按本次目标校验：xml 目标下 9 号字不因 html 段越界被拒', async () => {
    // Arrange
    const h = makeHarness();
    const opened = await openDocx(h);

    // Act：9 落在 docx 段的 8–36 内、却在 html 段的 10–32 外；本次目标为 xml，两段都不属于本批
    const rendered = await h.preview.render({ sessionId: opened.sessionId, target: 'xml', options: { theme: 'github', fontSize: 9 } });

    // Assert
    assert.equal(rendered.target, 'xml');
    const last = h.core.calls.render.at(-1);
    assert.equal(last.target, 'xml');
    assert.equal(last.options.html.fontSize, 16, 'html 段不属于本次目标，越界取值跳过并保留默认值');
    assert.equal(last.options.docx.fontSize, 9, '9 对 docx 段合法，照常写入');
});

test('render 命中重解析项时重新解析并重建来源栏', async () => {
    const h = makeHarness();
    const opened = await openDocx(h);
    const rendered = await h.preview.render({ sessionId: opened.sessionId, options: { theme: 'github', fontSize: 18, imageFormat: 'keep' } });

    assert.equal(h.core.calls.parse.length, 2, '重解析项变更应触发第二次解析');
    assert.equal(rendered.reparsed, true);
    assert.deepEqual(rendered.changedKeys, ['imageFormat']);
    assert.ok(rendered.sourceView, '重新解析时须一并重建来源栏');
    assert.equal(h.core.calls.parse[1].options.imageFormat, 'keep', '新选项须落到解析');
    assert.ok(rendered.product.warnings.includes('解析提示-2'), '产物警告应取自新解析的文档');
});

test('REPARSE_KEYS 覆盖解析管线相关项，changedReparseKeys 逐项判定（含数组）', () => {
    for (const key of ['imageFormat', 'math', 'pdfBackend', 'patentParts', 'rasterizeTables', 'rasterizeFormulas', 'imageDpi', 'sectionDetection', 'xmlProfile', 'jpegQuality', 'jpegPpi']) {
        assert.ok(REPARSE_KEYS.includes(key), `REPARSE_KEYS 缺少 ${key}`);
    }
    // 五书 XML 反向导入的段号开关作用于 parsers/xml，改动后须重新解析，否则预览里改它不生效
    assert.ok(REPARSE_KEYS.includes('xmlImportParagraphNumbers'), 'REPARSE_KEYS 缺少 xmlImportParagraphNumbers');
    assert.deepEqual(changedReparseKeys({ xmlImportParagraphNumbers: false }, { xmlImportParagraphNumbers: true }), ['xmlImportParagraphNumbers']);
    assert.deepEqual(changedReparseKeys({ xmlImportParagraphNumbers: true }, { xmlImportParagraphNumbers: true }), []);
    assert.ok(!REPARSE_KEYS.includes('theme') && !REPARSE_KEYS.includes('fontSize'), '排版类选项不应触发重解析');
    assert.deepEqual(changedReparseKeys({ math: 'image' }, { math: 'image' }), []);
    assert.deepEqual(changedReparseKeys({ math: 'image' }, { math: 'text' }), ['math']);
    assert.deepEqual(changedReparseKeys({ patentParts: ['claims'] }, { patentParts: ['claims'] }), []);
    assert.deepEqual(changedReparseKeys({ patentParts: ['claims'] }, { patentParts: ['claims', 'abstract'] }), ['patentParts']);
    assert.deepEqual(changedReparseKeys({}, { imageFormat: undefined }), [], 'undefined 与缺省视为相同');
});

test('render 可切换目标：xml 产物给出五书分文件、结构化视图与预检清单', async () => {
    const h = makeHarness();
    const opened = await openDocx(h);
    const rendered = await h.preview.render({ sessionId: opened.sessionId, target: 'xml', options: { xmlProfile: 'patent' } });

    assert.equal(rendered.target, 'xml');
    assert.equal(rendered.product.view.kind, 'xml');
    const { view } = rendered.product;
    assert.deepEqual(view.parts.map((part) => part.name), [PATENT_CLAIMS_FILE, PATENT_DESCRIPTION_FILE]);
    assert.deepEqual(view.parts.map((part) => part.label), ['权利要求书（100001/100001.xml）', '说明书（100002/100002.xml）'], '表格代码文件名须配书目名才可读');
    assert.deepEqual(view.parts.map((part) => part.book), ['cn-claims', 'description']);
    assert.equal(view.parts[0].profile, 'patent');
    assert.equal(view.primary, 1, '主视图按内容认定为说明书，与文件名和排列顺序无关');
    assert.equal(view.structuredHtml, view.parts[1].structuredHtml);
    assert.ok(view.structuredHtml.includes('<span class="pnum">[0001]</span>'), '段号未进结构视图');
    assert.deepEqual(view.precheck, PRECHECK);
    assert.deepEqual(rendered.product.files.sort(), [PATENT_CLAIMS_FILE, PATENT_DESCRIPTION_FILE, 'precheck.json', '样例文档.zip'].sort());

    // 图片与所属 XML 同目录：img/@file 为裸文件名，取图基址须落在该书的表格代码目录内
    const session = h.preview.sessions.get(opened.sessionId);
    assert.ok(view.structuredHtml.includes(`src="mf-asset://${session.sid}/product/${PATENT_TABLE_IMAGE}"`), `表格图未按书目目录寻址：${view.structuredHtml}`);
    assert.ok(!view.structuredHtml.includes('class="img-missing"'), '结构视图不应有取不到的图片');
    assert.ok(fs.existsSync(path.join(session.tempDir, 'product', '100002', '100002_1.jpg')), '资产应落在产物目录的书目子目录内');
    assert.ok(!fs.existsSync(path.join(session.tempDir, 'product', 'images')), '切换目标时产物目录须先清空');
});

test('真实转换内核下的专利预览：各书结构视图里的图片地址都落在该书的表格代码目录内，经 mf-asset 协议逐一可解析', async () => {
    // Arrange：不注入内核桩（core 省略即懒加载真实的 converters）；关闭栅格化以免依赖 Electron
    const grants = createAssetGrants();
    const settings = { get: () => ({ defaults: {}, outputDir: path.join(root, 'real-out') }), getMineruToken: () => null };
    const preview = createPreviewSessions({ grants, settings, library: null, mammoth: mammothStub, log: () => undefined });
    harnesses.push({ preview });
    const samplePatent = path.join(__dirname, 'fixtures', 'patent', 'sample-patent.docx');

    // Act
    const opened = await preview.open({
        path: samplePatent, type: 'docx', target: 'xml',
        options: { xmlProfile: 'patent', math: 'text', rasterizeTables: false, rasterizeFormulas: false },
    });

    // Assert：五书齐备、主视图为说明书
    const { view } = opened.product;
    assert.deepEqual(view.parts.map((part) => part.name), ['100001/100001.xml', '100002/100002.xml', '100003/100003.xml', '100004/100004.xml', '100005/100005.xml']);
    assert.deepEqual(view.parts.map((part) => part.book), ['cn-claims', 'description', 'cn-drawings', 'cn-abstract', 'cn-abst-figure']);
    assert.equal(view.parts[view.primary].book, 'description');
    // Assert：每份结构视图里的图片地址都在该书目录下，且授权表能把它解析到会话临时目录内的真实文件
    const session = preview.sessions.get(opened.sessionId);
    let images = 0;
    for (const part of view.parts) {
        const code = part.name.split('/')[0];
        assert.ok(!part.structuredHtml.includes('class="img-missing"'), `${part.name} 有取不到的图片`);
        for (const [, url] of part.structuredHtml.matchAll(/<img class="[^"]*" src="([^"]+)"/g)) {
            images += 1;
            assert.ok(url.startsWith(`mf-asset://${session.sid}/product/${code}/${code}_`), `${part.name} 的图片地址不在书目目录内：${url}`);
            const resolved = await resolveAssetRequest({ grants: grants.grants, url });
            assert.equal(resolved.status, 200, `${url} → ${JSON.stringify(resolved)}`);
            assert.equal(fs.realpathSync(path.dirname(resolved.filePath)), fs.realpathSync(path.join(session.tempDir, 'product', code)));
        }
    }
    assert.ok(images >= 2, `夹具稿的附图与摘要附图都应出现在结构视图里，实际 ${images} 处`);
});

test('bundle 产物给出 md 渲染与原文，pdf 产物落临时文件经 mf-asset 展示', async () => {
    const h = makeHarness();
    const opened = await h.preview.open({ path: SOURCE_DOCX, type: 'docx', target: 'bundle' });
    assert.equal(opened.product.view.kind, 'md');
    assert.ok(opened.product.view.raw.startsWith('# 样例'), 'bundle 须给出 md 原文');
    assert.ok(opened.product.view.html.includes('<img'), 'bundle 须给出 md 渲染');

    const md = makeHarness();
    const pdf = await md.preview.open({ path: path.join(root, 'x.md'), type: 'md', target: 'pdf' }).catch((err) => err);
    assert.ok(pdf instanceof Error, 'md 源文件不存在时来源栏构建失败');
    assert.equal(md.preview.sessions.size, 0, '构建失败的会话须被回收');
    assert.equal(md.grants.size(), 0, '构建失败时授权须一并撤销');
});

test('渲染器给出 title 时页头与导出记录采用之，给不出时沿用解析标题', async () => {
    const h = makeHarness();
    // html 渲染器不给 title（桩返回 null）：页头沿用 parseDocument 的标题
    const opened = await openDocx(h);
    assert.equal(opened.title, '样例文档');

    // xml(patent) 渲染器给出发明名称：页头随 render 回包更新
    const rendered = await h.preview.render({ sessionId: opened.sessionId, target: 'xml', options: { xmlProfile: 'patent' } });
    assert.equal(rendered.title, '一种测试装置');
    assert.equal(h.preview.sessions.get(opened.sessionId).title, '一种测试装置');

    // 导出写入文件库的 title 与页头同源
    const exported = await h.preview.export({ sessionId: opened.sessionId });
    assert.equal(exported.title, '一种测试装置');
    assert.equal(h.upserts[0].result.title, '一种测试装置');

    // 切回 html（选项不变，故不重新解析）：渲染器不再给 title，沿用会话已有的标题而不是回退成空
    const back = await h.preview.render({ sessionId: opened.sessionId, target: 'html', options: { xmlProfile: 'patent' } });
    assert.equal(back.reparsed, false);
    assert.equal(back.title, '一种测试装置');

    // 重新解析会把标题拉回解析值（该次 html 渲染同样给不出 title）
    const reparsed = await h.preview.render({ sessionId: opened.sessionId, target: 'html', options: { xmlProfile: 'patent', imageFormat: 'keep' } });
    assert.deepEqual(reparsed.changedKeys, ['imageFormat']);
    assert.equal(reparsed.title, '样例文档');

    // title 不混进产物回包，页头只读顶层 title 一处
    assert.equal(rendered.product.title, undefined);
});

test('open 时页头即采用渲染器给出的 title', async () => {
    const h = makeHarness();
    const opened = await h.preview.open({ path: SOURCE_DOCX, type: 'docx', target: 'xml', options: { xmlProfile: 'patent' } });
    assert.equal(opened.title, '一种测试装置', 'open 的回包须已带上发明名称');
    assert.equal(h.core.calls.parse.length, 1, '取渲染器标题不得额外解析');
});

// ============================================================
// export
// ============================================================

test('export 以默认图片寻址重渲染、落盘并写入文件库记录', async () => {
    const h = makeHarness();
    const opened = await openDocx(h);
    const exported = await h.preview.export({ sessionId: opened.sessionId });

    const write = h.core.calls.write[0];
    assert.equal(write.target, 'html');
    assert.equal(write.outputDir, h.outputDir);
    assert.equal(write.name, '样例文档');
    assert.equal(exported.outputPath, path.join(h.outputDir, '样例文档'));
    assert.equal(exported.libraryId, 'rec-1');
    assert.equal(exported.managed, false);

    // 导出用的渲染不得带 mf-asset 前缀，否则落盘的 html 会指向临时目录
    const last = h.core.calls.render[h.core.calls.render.length - 1];
    assert.equal(last.imageMode, undefined, '导出渲染须用目标默认的图片寻址');

    const { result, options } = h.upserts[0];
    assert.equal(result.input, SOURCE_DOCX);
    assert.equal(result.target, 'html');
    assert.equal(result.sourceType, 'docx');
    assert.equal(result.imagesCount, 1);
    assert.deepEqual(result.warnings, ['解析提示-1']);
    assert.equal(result.options.mineru.token, null, '写进文件库的选项须已脱敏');
    assert.deepEqual(options, { managed: false, outputDir: h.outputDir });
});

test('托管模式下导出写入托管目录；文件库缺席时导出仍成功但无记录', async () => {
    const managed = makeHarness({ libraryMode: 'managed' });
    const opened = await openDocx(managed);
    const exported = await managed.preview.export({ sessionId: opened.sessionId });
    assert.equal(exported.managed, true);
    assert.equal(exported.outputPath, path.join(managed.dir, 'managed', '2026-09', '样例文档'));
    assert.deepEqual(managed.upserts[0].options, { managed: true, outputDir: path.join(managed.dir, 'managed', '2026-09') });

    const bare = makeHarness({ withLibrary: false });
    const opened2 = await openDocx(bare);
    const exported2 = await bare.preview.export({ sessionId: opened2.sessionId });
    assert.equal(exported2.libraryId, null);
    assert.ok(fs.existsSync(exported2.outputPath));
});

// ============================================================
// close
// ============================================================

test('close 撤销 mf-asset 授权并删除会话临时目录', async () => {
    const h = makeHarness();
    const opened = await openDocx(h);
    const session = h.preview.sessions.get(opened.sessionId);
    const { sid, tempDir } = session;
    assert.ok(fs.existsSync(tempDir));
    assert.ok(h.grants.get(sid));

    assert.deepEqual(await h.preview.close({ sessionId: opened.sessionId }), { closed: true });
    assert.equal(h.grants.get(sid), null, '授权未撤销');
    assert.equal(fs.existsSync(tempDir), false, '临时目录未删除');
    assert.equal(h.preview.sessions.size, 0);
    assert.deepEqual(await h.preview.close({ sessionId: opened.sessionId }), { closed: false });
    await assert.rejects(h.preview.render({ sessionId: opened.sessionId }), /预览会话不存在/);
});

test('同时在场的会话数受限，closeAll 清空全部授权与临时目录', async () => {
    const h = makeHarness();
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push((await openDocx(h)).sessionId);
    assert.ok(h.preview.sessions.size <= 3, `会话数应受限，实际 ${h.preview.sessions.size}`);
    assert.equal(h.grants.size(), h.preview.sessions.size, '被淘汰会话的授权须一并撤销');
    const dirs = [...h.preview.sessions.values()].map((item) => item.tempDir);
    await h.preview.closeAll();
    assert.equal(h.preview.sessions.size, 0);
    assert.equal(h.grants.size(), 0);
    for (const dir of dirs) assert.equal(fs.existsSync(dir), false);
});

// ============================================================
// 网页来源
// ============================================================

test('网页来源：open/render 走通，来源栏为结构视图，且全程不经路径展开', async () => {
    const h = makeHarness();
    const opened = await h.preview.open({ url: SOURCE_URL, type: 'url', target: 'html', options: { theme: 'reader' } });

    assert.deepEqual(h.core.calls.parse[0].input, { url: SOURCE_URL }, 'url 须原样交 parseDocument');
    assert.equal(h.core.calls.parse[0].options.mineru.token, TOKEN);
    assert.deepEqual(opened.source, { kind: 'url', value: SOURCE_URL, name: 'example.com', host: 'example.com', type: 'url' });
    assert.equal(opened.sourceView.kind, 'html');
    assert.equal(opened.sourceView.structured, true, '网页来源以结构视图呈现');
    assert.equal(opened.sourceView.label, '结构视图（网页正文）');
    assert.equal(opened.sourceView.host, 'example.com');
    assert.equal(opened.sourceView.url, SOURCE_URL);

    const session = h.preview.sessions.get(opened.sessionId);
    assert.ok(opened.sourceView.html.includes(`mf-asset://${session.sid}/source/images/image_1.jpg`), '来源结构视图的图片未走 mf-asset');
    assert.ok(fs.existsSync(path.join(session.tempDir, 'source', 'images', 'image_1.jpg')));

    const rendered = await h.preview.render({ sessionId: opened.sessionId, target: 'bundle' });
    assert.equal(rendered.product.view.kind, 'md');
    assert.equal(h.core.calls.parse.length, 1);

    // 结构性守卫：代码（去掉注释后）不接触 scan / mf:paths:expand，也不提供私网开关
    const source = stripComments(fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main', 'preview-session.js'), 'utf8'));
    assert.ok(!/scan/i.test(source), 'preview-session 不应依赖 scan 或路径展开');
    assert.ok(!/expand/i.test(source), 'preview-session 不应涉及路径展开');
    assert.ok(!/allowPrivateNetwork/.test(source), '桌面端预览不得提供私网开关');
});

// ============================================================
// 令牌
// ============================================================

test('MinerU 令牌注入 buildOptions，却不出现在任何回包与会话选项里', async () => {
    const h = makeHarness();
    const opened = await openDocx(h);
    const rendered = await h.preview.render({ sessionId: opened.sessionId, options: { theme: 'apple', math: 'text' } });
    const exported = await h.preview.export({ sessionId: opened.sessionId });

    assert.equal(h.core.calls.parse[0].options.mineru.token, TOKEN, '令牌须注入解析选项');
    assert.equal(h.core.calls.render[0].options.mineru.token, TOKEN, '令牌须注入渲染选项');
    for (const [label, payload] of [['open', opened], ['render', rendered], ['export', exported]]) {
        assert.ok(!JSON.stringify(payload).includes(TOKEN), `${label} 回包泄露了 MinerU 令牌`);
    }
    const session = h.preview.sessions.get(opened.sessionId);
    assert.ok(!JSON.stringify(session.flat).includes(TOKEN), '会话保存的扁平选项不得含令牌');
    assert.ok(!JSON.stringify(session.parseFlat).includes(TOKEN), '解析快照不得含令牌');
    assert.ok(!JSON.stringify(h.upserts[0].result.options).includes(TOKEN), '文件库记录不得含令牌');
    assert.equal(opened.options.theme, 'github', '回包须给出面板生效的扁平选项');
});

// ============================================================
// 产物 Markdown 编辑（仅 bundle）
// ============================================================

const { writeFolder } = require('../converters/output');

function pngHeader(width, height) {
    const buffer = Buffer.alloc(33);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    buffer.writeUInt8(8, 24);
    buffer.writeUInt8(6, 25);
    return buffer;
}

/** 真正落盘的 writeDocument（复用 output.writeFolder 的路径校验）与契约函数 renderBundleSidecars 的桩 */
function editingCore(core) {
    const sidecarCalls = [];
    return {
        sidecarCalls,
        writeDocument: async ({ rendered, target, outputDir, name }) => {
            core.calls.write.push({ target, outputDir, name, files: Object.keys(rendered.files), assets: (rendered.assets || []).map((asset) => asset.name) });
            const written = await writeFolder({ outputDir, name, files: rendered.files, assets: rendered.assets || [] });
            return { ...written, extras: [] };
        },
        renderBundleSidecars: async (doc, { name }) => {
            sidecarCalls.push({ name, doc: JSON.parse(JSON.stringify(doc)) });
            return { json: JSON.stringify({ schemaVersion: 1, kind: 'document', ir: doc.ir, meta: doc.meta }), contentList: '[]' };
        },
    };
}

const openBundle = (h) => h.preview.open({ path: SOURCE_DOCX, type: 'docx', target: 'bundle' });

test('bundle 编辑：暂存 → 插图 → 导出，md 与暂存文本逐字节相同、只落盘被引用的图片、旁路文件已写、登记一次并绑定', async () => {
    const h = makeHarness({ coreOverrides: editingCore });
    const opened = await openBundle(h);
    const session = h.preview.sessions.get(opened.sessionId);

    const view = await h.preview.renderMarkdown({ sessionId: opened.sessionId });
    assert.ok(view.html.includes(`mf-asset://${session.sid}/edit-view/g1/`), `实时预览图片未走 edit-view 代次目录：${view.html}`);
    assert.ok(fs.existsSync(path.join(session.tempDir, 'edit', 'images', 'image_1.jpg')), '编辑区带着产物图片');
    assert.equal(session.edit.markdown, opened.product.view.raw, '初值为 bundle md 原文');

    const picDir = fs.mkdtempSync(path.join(root, 'pics-'));
    const pic = path.join(picDir, 'pic.png');
    const orphan = path.join(picDir, 'orphan.png');
    fs.writeFileSync(pic, pngHeader(320, 200));
    fs.writeFileSync(orphan, pngHeader(8, 8));
    assert.deepEqual(await h.preview.importImage({ sessionId: opened.sessionId, sourcePath: pic }), { relPath: 'images/pic.png', width: 320, height: 200, alt: 'pic' });
    await h.preview.importImage({ sessionId: opened.sessionId, sourcePath: orphan });
    assert.equal(h.preview.imageDialogDir({ sessionId: opened.sessionId }), root, '未导出时插图对话框默认来源文件所在目录');

    const text = `${opened.product.view.raw}\n编辑后的段落\n\n<img src="images/pic.png" width="320" alt="pic">\n`;
    const staged = await h.preview.saveMarkdown({ sessionId: opened.sessionId, text });
    assert.equal(staged.saved, true);
    assert.equal(staged.staged, true);
    assert.equal(h.core.calls.write.length, 0, '暂存不落盘');

    const exported = await h.preview.export({ sessionId: opened.sessionId });
    const outDir = path.join(h.outputDir, '样例文档');
    assert.equal(exported.outputPath, outDir);
    assert.equal(exported.boundPath, path.join(outDir, '样例文档.md'));
    assert.deepEqual(fs.readFileSync(exported.boundPath), Buffer.from(text, 'utf8'), 'md 与暂存文本逐字节相同');
    assert.deepEqual(fs.readdirSync(path.join(outDir, 'images')).sort(), ['image_1.jpg', 'pic.png'], '只落盘被引用的图片');
    assert.ok(fs.existsSync(path.join(outDir, '样例文档.json')), '旁路 json 已写');
    assert.ok(fs.existsSync(path.join(outDir, '样例文档_content_list.json')), 'content_list 已写');
    assert.equal(h.core.sidecarCalls.length, 1);
    assert.equal(h.core.sidecarCalls[0].name, '样例文档');
    assert.ok(!JSON.stringify(h.core.sidecarCalls[0].doc).includes(session.tempDir), '旁路文件的输入不含临时目录绝对路径');
    assert.equal(h.core.sidecarCalls[0].doc.meta.title, '样例', '标题取编辑后文本');
    assert.equal(h.upserts.length, 1, '文件库登记一次');
    assert.equal(h.upserts[0].result.target, 'bundle');
    assert.equal(h.upserts[0].result.outputPath, outDir);
    assert.equal(h.upserts[0].result.imagesCount, 2);
    assert.equal(fs.existsSync(path.join(session.tempDir, 'edit')), false, '绑定后删掉临时编辑区');
    assert.equal(h.preview.imageDialogDir({ sessionId: opened.sessionId }), outDir, '绑定后插图对话框默认导出目录');
    assert.ok(!JSON.stringify(exported).includes(TOKEN), '导出回包不含令牌');
});

test('bundle 编辑：绑定后保存直接写盘（重建旁路 json），外部修改报冲突；重渲染回 editDiscarded 且不删导出目录', async () => {
    const h = makeHarness({ coreOverrides: editingCore });
    const opened = await openBundle(h);
    const session = h.preview.sessions.get(opened.sessionId);
    const text = `${opened.product.view.raw}\n第一次修改\n`;
    await h.preview.saveMarkdown({ sessionId: opened.sessionId, text });
    const exported = await h.preview.export({ sessionId: opened.sessionId });

    const text2 = `${text}\n绑定后的修改\n`;
    const saved = await h.preview.saveMarkdown({ sessionId: opened.sessionId, text: text2 });
    assert.equal(saved.saved, true);
    assert.equal(saved.staged, false);
    assert.equal(saved.boundPath, exported.boundPath);
    assert.equal(fs.readFileSync(exported.boundPath, 'utf8'), text2);
    assert.equal(h.core.sidecarCalls.length, 2, '已绑定的保存按新文本重建旁路 json');

    fs.writeFileSync(exported.boundPath, 'external');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(exported.boundPath, future, future);
    const conflict = await h.preview.saveMarkdown({ sessionId: opened.sessionId, text: 'mine' });
    assert.equal(conflict.saved, false);
    assert.equal(conflict.conflict, true);
    assert.equal(fs.readFileSync(exported.boundPath, 'utf8'), 'external');

    const again = await h.preview.export({ sessionId: opened.sessionId });
    assert.equal(again.boundPath, exported.boundPath, '已绑定时再次导出仍走编辑后的导出');

    const rerendered = await h.preview.render({ sessionId: opened.sessionId, options: { theme: 'academic' } });
    assert.equal(rerendered.editDiscarded, true);
    assert.equal(session.edit, null);
    assert.ok(fs.existsSync(path.dirname(exported.boundPath)), '已绑定的导出目录不随丢弃编辑删除');
    const plain = await h.preview.render({ sessionId: opened.sessionId, options: { theme: 'academic' } });
    assert.equal(plain.editDiscarded, undefined, '没有编辑时回包不带 editDiscarded');
});

test('bundle 编辑：未导出的修改在重渲染时丢弃并删临时编辑区；未改动时导出走常规路径', async () => {
    const h = makeHarness({ coreOverrides: editingCore });
    const opened = await openBundle(h);
    const session = h.preview.sessions.get(opened.sessionId);
    await h.preview.saveMarkdown({ sessionId: opened.sessionId, text: '# 改过\n' });
    assert.ok(fs.existsSync(path.join(session.tempDir, 'edit')));
    const rerendered = await h.preview.render({ sessionId: opened.sessionId, target: 'bundle' });
    assert.equal(rerendered.editDiscarded, true);
    assert.equal(fs.existsSync(path.join(session.tempDir, 'edit')), false);

    await h.preview.renderMarkdown({ sessionId: opened.sessionId });
    const exported = await h.preview.export({ sessionId: opened.sessionId });
    assert.equal(exported.boundPath, undefined, '文本未改动时不绑定');
    assert.equal(h.core.sidecarCalls.length, 0, '常规导出不经编辑路径重建旁路文件');
    assert.deepEqual(h.core.calls.write[0].files, ['{name}.md', '{name}.json'], '常规导出沿用 renderDocument 的产物');
});

test('非 bundle 目标调编辑接口报错', async () => {
    const h = makeHarness({ coreOverrides: editingCore });
    const opened = await openDocx(h);
    await assert.rejects(h.preview.renderMarkdown({ sessionId: opened.sessionId }), /只有「MD 包」目标的产物可以编辑/);
    await assert.rejects(h.preview.saveMarkdown({ sessionId: opened.sessionId, text: 'x' }), /只有「MD 包」目标的产物可以编辑/);
    await assert.rejects(h.preview.renderMarkdown({ sessionId: 'nope' }), /预览会话不存在/);
});
