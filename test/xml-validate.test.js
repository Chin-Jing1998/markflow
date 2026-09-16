/**
 * converters/renderers/xml/validate.js 单元测试
 * 覆盖：参考夹具五份全部 valid（drawings 只有 DTD 自身缺陷的 warning）、缺 num 报错并给出行号、
 *       IDREFS 悬空报错、well-formed 检查（requireDtd=false）、校验器不可用两态、describeValidation 的问题项文案
 */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const validate = require('../converters/renderers/xml/validate');
const { ISSUE_CODES } = require('../converters/renderers/xml/precheck');

const { validateXml, describeValidation } = validate;
const REFERENCE_DIR = path.join(__dirname, 'fixtures', 'patent', 'reference');
const REFERENCE_FILES = ['claims.xml', 'description.xml', 'drawings.xml', 'abstract.xml', 'abstract-figure.xml'];
const readReference = (name) => fs.readFileSync(path.join(REFERENCE_DIR, name), 'utf8');

after(() => validate._reset());

describe('validateXml', () => {
    test('参考夹具五份全部 valid，drawings.xml 只带一条 cn-drawings 内容模型缺陷的 warning', async () => {
        for (const name of REFERENCE_FILES) {
            const result = await validateXml(readReference(name));
            assert.equal(result.available, true, name);
            assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.errors)}`);
            assert.deepEqual(result.errors, [], name);
            if (name === 'drawings.xml') {
                assert.equal(result.warnings.length, 1);
                assert.match(result.warnings[0].message, /Content model of cn-drawings is not determinist/);
                assert.equal(result.warnings[0].line, 20);
            } else {
                assert.deepEqual(result.warnings, [], name);
            }
        }
    });

    test('缺少必填属性 num 时 invalid，并给出行号与 libxml2 原文', async () => {
        const bad = readReference('description.xml').replace('id="p0002" num="0002" ', 'id="p0002" ');

        const result = await validateXml(bad);

        assert.equal(result.available, true);
        assert.equal(result.valid, false);
        assert.equal(result.errors.length, 1);
        assert.equal(result.errors[0].line, 10);
        assert.match(result.errors[0].message, /Element p does not carry attribute num/);
    });

    test('claim-ref 引用不存在的 id 时 invalid（IDREFS 校验真实生效）', async () => {
        const bad = readReference('claims.xml').replace('idref="cl001 cl002"', 'idref="cl001 cl009"');

        const result = await validateXml(bad);

        assert.equal(result.valid, false);
        assert.match(result.errors[0].message, /references an unknown ID "cl009"/);
    });

    test('requireDtd 为 false 时只检查 well-formed', async () => {
        assert.equal((await validateXml('<a><b/></a>', { requireDtd: false })).valid, true);
        const broken = await validateXml('<a><b></a>', { requireDtd: false });
        assert.equal(broken.valid, false);
        assert.match(broken.errors[0].message, /tag mismatch/);
        // 无 DOCTYPE 的文档按 DTD 校验则失败
        const noDtd = await validateXml('<cn-application-body lang="zh" country="CN"><cn-claims/></cn-application-body>');
        assert.equal(noDtd.valid, false);
        assert.match(noDtd.errors[0].message, /no DTD found/);
    });

    test('libxml2-wasm 不可用时返回 available:false 与中文提示，恢复后再次可用', async () => {
        validate._setImporter(async () => { throw new Error("Cannot find module 'libxml2-wasm'"); });
        const result = await validateXml(readReference('claims.xml'));
        assert.deepEqual(result, { available: false, valid: false, errors: [], warnings: [], hint: result.hint });
        assert.match(result.hint, /校验器不可用：未安装可选依赖 libxml2-wasm/);

        validate._reset();
        assert.equal((await validateXml(readReference('claims.xml'))).valid, true);
    });

    test('非字符串入参拒绝', async () => {
        await assert.rejects(validateXml(Buffer.from('<a/>')), /validateXml 需要字符串形式的 XML/);
    });
});

describe('describeValidation', () => {
    test('错误逐条转为 DTD_INVALID 问题项，文案带「DTD 校验：」前缀与文件名、行号', () => {
        const items = describeValidation('claims.xml', { available: true, valid: false, errors: [{ line: 10, message: 'Element p does not carry attribute num' }], warnings: [] });
        assert.equal(items.length, 1);
        assert.equal(items[0].code, ISSUE_CODES.DTD_INVALID);
        assert.equal(items[0].level, 'warning');
        assert.equal(items[0].category, 'dtd');
        assert.equal(items[0].message, 'DTD 校验：DTD 校验失败（claims.xml 第 10 行）：Element p does not carry attribute num');
        assert.equal(items[0].location, 'claims.xml 第 10 行');
    });

    test('校验器不可用时给出一条 DTD_UNAVAILABLE；校验通过不产生问题项', () => {
        const unavailable = describeValidation('claims.xml', { available: false, valid: false, errors: [], warnings: [], hint: '校验器不可用：未安装可选依赖 libxml2-wasm' });
        assert.equal(unavailable.length, 1);
        assert.equal(unavailable[0].code, ISSUE_CODES.DTD_UNAVAILABLE);
        assert.match(unavailable[0].message, /^DTD 校验：校验器不可用：未安装可选依赖 libxml2-wasm.*已跳过 claims\.xml 的校验$/);
        assert.deepEqual(describeValidation('claims.xml', { available: true, valid: true, errors: [], warnings: [] }), []);
    });
});
