/**
 * converters/options.js 单元测试
 * 覆盖：默认值与深冻结、部分覆盖时的深合并、幂等、枚举/数值/布尔/字符串/parts 各类校验的中文错误、
 *       敏感项不回显、可空对象、未知键拒绝、枚举表、描述树、脱敏拷贝
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeOptions, describeOptions, redactOptions, OPTION_ENUMS, DEFAULT_OPTIONS,
} = require('../converters/options');

// ============================================================
// normalizeOptions
// ============================================================

describe('normalizeOptions', () => {
    test('省略入参返回全默认值并深冻结', () => {
        // Act
        const opts = normalizeOptions();

        // Assert：方案 §3.3.1 的默认值
        assert.deepEqual(opts, DEFAULT_OPTIONS);
        assert.equal(opts.imageFormat, 'jpg');
        assert.equal(opts.jpegQuality, 90);
        assert.equal(opts.jpegPpi, 330);
        assert.equal(opts.math, 'image');
        assert.equal(opts.pdfBackend, 'auto');
        assert.deepEqual(opts.mineru, {
            model: 'pipeline', ocr: false, formula: true, table: true, language: 'ch', pageRanges: null, timeoutSec: 600, token: null,
        });
        assert.deepEqual(opts.html, {
            theme: 'apple', fontFamily: null, fontSize: 16, lineHeight: 1.7, contentWidth: 760, spacing: 'normal', inlineImages: false,
        });
        assert.deepEqual(opts.pdf, {
            theme: 'print', pageSize: 'A4', landscape: false, margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
        });
        assert.deepEqual(opts.docx, {
            pageSize: 'A4', fontSize: 11, fontFamily: { ascii: 'Calibri', eastAsia: '微软雅黑' }, margins: null,
        });
        assert.deepEqual(opts.xml, {
            profile: 'generic', validate: false, indent: 2, numbering: { start: 1, width: 4 },
            patent: { parts: 'auto', rasterizeTables: true, rasterizeFormulas: true, imageDpi: 300, sectionDetection: 'auto' },
        });
        assert.deepEqual(opts.xmlImport, { paragraphNumbers: false });
        assert.deepEqual(opts.raster, { scale: 2, maxWidth: 1600 });

        // Assert：深冻结（Reflect.set 在冻结对象上返回 false，不依赖严格模式）
        assert.ok(Object.isFrozen(opts));
        assert.ok(Object.isFrozen(opts.xml.patent));
        assert.ok(Object.isFrozen(opts.pdf.margins));
        assert.equal(Reflect.set(opts.html, 'theme', 'github'), false);
        assert.equal(opts.html.theme, 'apple');
    });

    test('null 入参等同省略', () => {
        assert.deepEqual(normalizeOptions(null), DEFAULT_OPTIONS);
    });

    test('部分覆盖时深合并，其余保持默认', () => {
        const opts = normalizeOptions({
            jpegQuality: 75,
            html: { theme: 'github', fontSize: 18 },
            xml: { profile: 'patent', patent: { parts: ['claims', 'description'] } },
        });

        assert.equal(opts.jpegQuality, 75);
        // patent profile 下未显式给 jpegPpi，取 profile 默认的 300（官方只受理 72–300 DPI）
        assert.equal(opts.jpegPpi, 300);
        assert.equal(opts.html.theme, 'github');
        assert.equal(opts.html.fontSize, 18);
        assert.equal(opts.html.lineHeight, 1.7);
        assert.equal(opts.xml.profile, 'patent');
        assert.deepEqual(opts.xml.patent.parts, ['claims', 'description']);
        assert.equal(opts.xml.patent.imageDpi, 300);
        assert.deepEqual(opts.xml.numbering, { start: 1, width: 4 });
        assert.equal(opts.pdf.theme, 'print');
    });

    test('jpegPpi 按 profile 取默认：patent 为 300、其余为 330，显式给出的值一律优先', () => {
        // Act
        const patent = normalizeOptions({ xml: { profile: 'patent' } });
        const explicit = normalizeOptions({ jpegPpi: 420, xml: { profile: 'patent' } });
        const generic = normalizeOptions({ xml: { profile: 'generic' } });

        // Assert：官方只受理 72–300 DPI，通用默认 330 会被专利预检判为超范围
        assert.equal(patent.jpegPpi, 300);
        assert.equal(explicit.jpegPpi, 420);
        assert.equal(generic.jpegPpi, 330);
        assert.equal(normalizeOptions({}).jpegPpi, 330);

        // Assert：补默认值发生在深冻结与幂等登记之前，两项性质都不受影响
        assert.ok(Object.isFrozen(patent));
        assert.equal(normalizeOptions(patent), patent);
        // Assert：只改 jpegPpi，其余字段与通用默认值逐项一致
        assert.deepEqual({ ...patent, jpegPpi: 330, xml: generic.xml }, { ...generic });
    });

    test('对已归一的结果重复归一返回同一引用；结构相同的普通对象则得到等值的新结果', () => {
        const once = normalizeOptions({ jpegQuality: 75, docx: { margins: { left: 0.8 } } });
        assert.equal(normalizeOptions(once), once);
        assert.equal(normalizeOptions(DEFAULT_OPTIONS), DEFAULT_OPTIONS);
        const copy = normalizeOptions(JSON.parse(JSON.stringify(once)));
        assert.notEqual(copy, once);
        assert.deepEqual(copy, once);
        assert.ok(Object.isFrozen(copy));
    });

    test('枚举值非法时抛中文错误并列出可选值', () => {
        assert.throws(
            () => normalizeOptions({ html: { theme: 'solarized' } }),
            /选项 html\.theme 须为 apple \| apple-dark \| github \| academic \| reader \| print 之一，实际："solarized"/,
        );
        assert.throws(() => normalizeOptions({ pdfBackend: 'cloud' }), /选项 pdfBackend 须为 auto \| mineru \| local 之一/);
        assert.throws(() => normalizeOptions({ xml: { profile: 'cnipa' } }), /选项 xml\.profile 须为 generic \| patent 之一/);
        assert.throws(() => normalizeOptions({ imageFormat: 'png' }), /选项 imageFormat 须为 jpg \| keep 之一/);
        assert.throws(() => normalizeOptions({ math: 'mathml' }), /选项 math 须为 image \| text 之一/);
    });

    test('数值越界、非整数或非数字时抛中文错误', () => {
        assert.throws(() => normalizeOptions({ jpegQuality: 120 }), /选项 jpegQuality 须为 60–100 之间的整数，实际：120/);
        assert.throws(() => normalizeOptions({ jpegQuality: 80.5 }), /选项 jpegQuality 须为 60–100 之间的整数，实际：80\.5/);
        assert.throws(() => normalizeOptions({ jpegQuality: '90' }), /选项 jpegQuality 须为 60–100 之间的整数，实际："90"/);
        assert.throws(() => normalizeOptions({ html: { lineHeight: 5 } }), /选项 html\.lineHeight 须为 1–3 之间的数字，实际：5/);
        assert.throws(() => normalizeOptions({ xml: { numbering: { width: 0 } } }), /选项 xml\.numbering\.width 须为 1–6 之间的整数/);
        assert.throws(() => normalizeOptions({ pdf: { margins: { top: -1 } } }), /选项 pdf\.margins\.top 须为 0–3 之间的数字/);
        assert.equal(normalizeOptions({ html: { lineHeight: 2.2 } }).html.lineHeight, 2.2);
        assert.equal(normalizeOptions({ jpegQuality: 60 }).jpegQuality, 60);
        assert.equal(normalizeOptions({ jpegQuality: 100 }).jpegQuality, 100);
    });

    test('xmlImport.paragraphNumbers 为布尔项，默认关闭；非布尔值与段内未知键拒绝；描述树带中文说明', () => {
        assert.equal(normalizeOptions({ xmlImport: { paragraphNumbers: true } }).xmlImport.paragraphNumbers, true);
        assert.equal(normalizeOptions({ xmlImport: {} }).xmlImport.paragraphNumbers, false);
        assert.throws(() => normalizeOptions({ xmlImport: { paragraphNumbers: 'yes' } }), /选项 xmlImport\.paragraphNumbers 须为布尔值，实际："yes"/);
        assert.throws(() => normalizeOptions({ xmlImport: { images: 'link' } }), /未知选项：xmlImport\.images（可用：paragraphNumbers）/);
        assert.throws(() => normalizeOptions({ xmlImport: null }), /选项 xmlImport 不可为空/);
        const spec = describeOptions().xmlImport;
        assert.equal(spec.type, 'object');
        assert.deepEqual(Object.keys(spec.fields), ['paragraphNumbers']);
        assert.deepEqual([spec.fields.paragraphNumbers.type, spec.fields.paragraphNumbers.default], ['boolean', false]);
        assert.match(spec.fields.paragraphNumbers.description, /段号写回段首/);
    });

    test('xml.validate 为布尔项，默认关闭，非布尔值拒绝', () => {
        assert.equal(normalizeOptions({ xml: { validate: true } }).xml.validate, true);
        assert.equal(normalizeOptions({ xml: { validate: false } }).xml.validate, false);
        assert.throws(() => normalizeOptions({ xml: { validate: 'yes' } }), /选项 xml\.validate 须为布尔值，实际："yes"/);
        assert.equal(describeOptions().xml.fields.validate.description, '渲染后用官方 DTD 校验并把结果写入 warnings');
    });

    test('布尔与字符串字段的类型与格式校验', () => {
        assert.throws(() => normalizeOptions({ mineru: { ocr: 'yes' } }), /选项 mineru\.ocr 须为布尔值，实际："yes"/);
        assert.throws(() => normalizeOptions({ html: { inlineImages: 1 } }), /选项 html\.inlineImages 须为布尔值/);
        assert.throws(() => normalizeOptions({ mineru: { language: 'zh cn' } }), /选项 mineru\.language 格式非法/);
        assert.throws(() => normalizeOptions({ mineru: { language: '' } }), /选项 mineru\.language 不可为空/);
        assert.throws(() => normalizeOptions({ mineru: { language: null } }), /选项 mineru\.language 不可为空/);
        assert.throws(() => normalizeOptions({ docx: { fontFamily: { ascii: 42 } } }), /选项 docx\.fontFamily\.ascii 须为字符串/);
        assert.throws(() => normalizeOptions({ html: { fontFamily: 'a; b' } }), /选项 html\.fontFamily 格式非法/);
        assert.throws(() => normalizeOptions({ html: { fontFamily: 'x'.repeat(201) } }), /选项 html\.fontFamily 长度不得超过 200/);
        assert.throws(() => normalizeOptions({ mineru: { pageRanges: 'a-b' } }), /选项 mineru\.pageRanges 格式非法/);

        assert.equal(normalizeOptions({ html: { fontFamily: '  "PingFang SC", serif ' } }).html.fontFamily, '"PingFang SC", serif');
        assert.equal(normalizeOptions({ html: { fontFamily: '' } }).html.fontFamily, null);
        assert.equal(normalizeOptions({ html: { fontFamily: null } }).html.fontFamily, null);
        assert.equal(normalizeOptions({ mineru: { pageRanges: '1-5, 8,10-12' } }).mineru.pageRanges, '1-5, 8,10-12');
        assert.equal(normalizeOptions({ mineru: { language: 'chinese_cht' } }).mineru.language, 'chinese_cht');
    });

    test('敏感项 mineru.token 校验失败时不回显取值，合法时裁剪空白', () => {
        assert.throws(
            () => normalizeOptions({ mineru: { token: 424242 } }),
            (err) => /选项 mineru\.token 须为字符串，实际：（已隐藏）/.test(err.message) && !err.message.includes('424242'),
        );
        assert.equal(normalizeOptions({ mineru: { token: ' secret-token ' } }).mineru.token, 'secret-token');
        assert.equal(normalizeOptions({ mineru: { token: '' } }).mineru.token, null);
    });

    test('patent.parts 接受 auto 或不重复的五书子集', () => {
        assert.equal(normalizeOptions({ xml: { patent: { parts: 'auto' } } }).xml.patent.parts, 'auto');
        assert.deepEqual(
            normalizeOptions({ xml: { patent: { parts: ['abstract-figure', 'claims'] } } }).xml.patent.parts,
            ['abstract-figure', 'claims'],
        );
        for (const bad of [[], ['claims', 'claims'], ['cover'], 'claims', 'all']) {
            assert.throws(
                () => normalizeOptions({ xml: { patent: { parts: bad } } }),
                /选项 xml\.patent\.parts 须为 'auto' 或由 claims、description、drawings、abstract、abstract-figure 组成的非空且不重复的数组/,
                JSON.stringify(bad),
            );
        }
    });

    test('可空对象 docx.margins：null 保持 null，对象则补齐默认；pdf.margins 不可为空', () => {
        assert.equal(normalizeOptions({ docx: { margins: null } }).docx.margins, null);
        assert.deepEqual(
            normalizeOptions({ docx: { margins: { top: 0.5 } } }).docx.margins,
            { top: 0.5, bottom: 1, left: 1, right: 1 },
        );
        assert.throws(() => normalizeOptions({ pdf: { margins: null } }), /选项 pdf\.margins 不可为空/);
    });

    test('未知键与非对象入参被拒绝', () => {
        assert.throws(() => normalizeOptions({ jpegQualiy: 90 }), /未知选项：jpegQualiy（可用：imageFormat、jpegQuality、jpegPpi、math、pdfBackend/);
        assert.throws(() => normalizeOptions({ html: { fontsize: 12 } }), /未知选项：html\.fontsize（可用：theme、fontFamily、fontSize/);
        assert.throws(() => normalizeOptions({ xml: { patent: { rasterize: true } } }), /未知选项：xml\.patent\.rasterize/);
        assert.throws(() => normalizeOptions('jpg'), /选项 options 须为对象，实际："jpg"/);
        assert.throws(() => normalizeOptions([]), /选项 options 须为对象/);
        assert.throws(() => normalizeOptions({ html: 'apple' }), /选项 html 须为对象，实际："apple"/);
        assert.throws(() => normalizeOptions({ html: null }), /选项 html 不可为空/);
    });
});

// ============================================================
// OPTION_ENUMS / describeOptions / redactOptions
// ============================================================

describe('OPTION_ENUMS、describeOptions 与 redactOptions', () => {
    test('枚举表冻结且取值与方案一致', () => {
        assert.deepEqual(OPTION_ENUMS.htmlThemes, ['apple', 'apple-dark', 'github', 'academic', 'reader', 'print']);
        assert.deepEqual(OPTION_ENUMS.xmlProfiles, ['generic', 'patent']);
        assert.deepEqual(OPTION_ENUMS.pdfBackends, ['auto', 'mineru', 'local']);
        assert.deepEqual(OPTION_ENUMS.imageFormats, ['jpg', 'keep']);
        assert.deepEqual(OPTION_ENUMS.mathModes, ['image', 'text']);
        assert.deepEqual(OPTION_ENUMS.mineruModels, ['pipeline', 'vlm']);
        assert.deepEqual(OPTION_ENUMS.patentParts, ['claims', 'description', 'drawings', 'abstract', 'abstract-figure']);
        assert.deepEqual(OPTION_ENUMS.spacing, ['compact', 'normal', 'loose']);
        assert.deepEqual(OPTION_ENUMS.pageSizes, ['A4', 'Letter']);
        assert.deepEqual(OPTION_ENUMS.sectionDetection, ['auto', 'headings']);
        assert.ok(Object.isFrozen(OPTION_ENUMS));
        assert.ok(Object.isFrozen(OPTION_ENUMS.htmlThemes));
    });

    test('describeOptions 给出纯 JSON 描述树：类型、默认值、枚举、范围、敏感标记', () => {
        // Act
        const desc = describeOptions();

        // Assert
        assert.deepEqual(JSON.parse(JSON.stringify(desc)), desc);
        assert.deepEqual(desc.jpegQuality, {
            type: 'number', description: 'JPEG 质量', min: 60, max: 100, integer: true, default: 90,
        });
        // 描述树给的是通用默认值；patent profile 的 300 由 normalizeOptions 在校验后补，故只在说明文字里点出
        assert.deepEqual(desc.jpegPpi, {
            type: 'number',
            description: 'JPEG 分辨率（PPI）；xml.profile 为 patent 且未显式指定时取 300',
            min: 72, max: 600, integer: true, default: 330,
        });
        assert.equal(desc.html.type, 'object');
        assert.deepEqual(desc.html.fields.theme.values, OPTION_ENUMS.htmlThemes);
        assert.equal(desc.html.fields.theme.default, 'apple');
        assert.equal(desc.html.fields.fontFamily.nullable, true);
        assert.equal(desc.mineru.fields.token.secret, true);
        assert.equal(desc.docx.fields.margins.nullable, true);
        assert.equal(desc.pdf.fields.margins.fields.top.default, 0.6);
        assert.equal(desc.xml.fields.patent.fields.parts.type, 'parts');
        assert.deepEqual(Object.keys(desc), Object.keys(DEFAULT_OPTIONS));
        for (const key of Object.keys(DEFAULT_OPTIONS)) assert.equal(typeof desc[key].description, 'string', key);
    });

    test('redactOptions 置空 mineru.token、不改动入参、其余字段原样', () => {
        // Arrange
        const opts = normalizeOptions({ mineru: { token: 'abc-secret' }, html: { theme: 'reader' } });

        // Act
        const redacted = redactOptions(opts);

        // Assert
        assert.equal(redacted.mineru.token, null);
        assert.equal(opts.mineru.token, 'abc-secret');
        assert.equal(JSON.stringify(redacted).includes('abc-secret'), false);
        assert.equal(Object.isFrozen(redacted), false);
        assert.deepEqual(
            { ...redacted, mineru: { ...redacted.mineru, token: 'abc-secret' } },
            JSON.parse(JSON.stringify(opts)),
        );
        assert.equal(redactOptions(undefined), undefined);
    });
});
