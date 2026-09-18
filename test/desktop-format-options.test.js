/**
 * desktop/renderer/js/format-options.mjs 单元测试（渲染层纯逻辑，Node 经 import() 载入）
 * 覆盖：字段表的关键约定（专利五书导入字段的可见条件与文案）、按 profile 的缺省值、
 *       「哪些键该提交」的显式值语义、键 → 中文标签、描述树下钻与可见字段筛选。
 */
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { describeOptions, normalizeOptions } = require('../converters/options');

let fo;
before(async () => {
    fo = await import(pathToFileURL(path.join(__dirname, '..', 'desktop', 'renderer', 'js', 'format-options.mjs')).href);
});

const tree = () => describeOptions();
const fieldOf = (key) => fo.FIELDS.find((item) => item.key === key);

// ============================================================
// 字段表
// ============================================================

test('字段表：专利五书导入的段号字段限定输入类型、标记需重新解析、文案说明用途与代价', () => {
    const field = fieldOf('xmlImportParagraphNumbers');
    assert.ok(field, 'FIELDS 应含 xmlImportParagraphNumbers');
    assert.deepEqual(field.types, ['xml', 'zip']);
    assert.equal(field.targets, fo.ALL_TARGETS, '作用于解析阶段，与目标无关');
    assert.equal(field.reparse, true);
    assert.match(field.hint, /审查意见/);
    assert.match(field.hint, /增删段落/);
    assert.deepEqual(field.path, ['xmlImport', 'paragraphNumbers']);
});

test('字段表：每个字段的 path 都能在描述树里下钻到叶子节点', () => {
    for (const field of fo.FIELDS) {
        const node = fo.pickNode(tree(), field.path);
        assert.ok(node, `${field.key} 的 path 落空：${field.path.join('.')}`);
        assert.equal(typeof node.type, 'string', field.key);
    }
    assert.equal(fo.pickNode(tree(), ['不存在的键']), null);
    assert.equal(fo.pickNode(tree(), ['xml', '不存在的子键']), null);
});

test('字段表：group 取值都在 GROUPS 之内，key 不重复', () => {
    const groups = new Set(fo.GROUPS.map((group) => group.key));
    const keys = fo.FIELDS.map((field) => field.key);
    for (const field of fo.FIELDS) assert.ok(groups.has(field.group), `${field.key} 的分组越界：${field.group}`);
    assert.deepEqual(keys, [...new Set(keys)], 'key 不得重复');
});

// ============================================================
// 按 profile 的缺省值
// ============================================================

test('effectiveDefault：jpegPpi 在 patent 方言下取 300，其余取通用默认 330', () => {
    const node = fo.pickNode(tree(), ['jpegPpi']);
    assert.equal(fo.effectiveDefault(node, 'patent'), 300);
    assert.equal(fo.effectiveDefault(node, 'generic'), 330);
    assert.equal(fo.effectiveDefault(node, undefined), 330);
    assert.equal(fo.effectiveDefault(node, '不认得的方言'), 330);
    // 与内核实际补的值一致：这是本函数存在的全部意义
    assert.equal(fo.effectiveDefault(node, 'patent'), normalizeOptions({ xml: { profile: 'patent' } }).jpegPpi);
    assert.equal(fo.effectiveDefault(node, 'generic'), normalizeOptions({ xml: { profile: 'generic' } }).jpegPpi);
});

test('effectiveDefault：没有 profileDefaults 的节点一律取 default；空节点回 undefined', () => {
    assert.equal(fo.effectiveDefault(fo.pickNode(tree(), ['jpegQuality']), 'patent'), 90);
    assert.equal(fo.effectiveDefault(fo.pickNode(tree(), ['imageFormat']), 'patent'), 'jpg');
    assert.equal(fo.effectiveDefault(null, 'patent'), undefined);
});

// ============================================================
// 显式值语义
// ============================================================

test('shouldSubmit：只提交「会话里本来就显式给出的」与「用户改动过的」', () => {
    const options = { xmlProfile: 'patent', fontSize: 0, theme: '', font: null };
    const touched = new Set(['imageFormat']);
    // 会话里显式存在
    assert.equal(fo.shouldSubmit('xmlProfile', { touched, options }), true);
    assert.equal(fo.shouldSubmit('fontSize', { touched, options }), true, '0 是有效取值，不算未给出');
    // 用户改动过
    assert.equal(fo.shouldSubmit('imageFormat', { touched, options }), true);
    // 既未给出也未改动
    assert.equal(fo.shouldSubmit('jpegPpi', { touched, options }), false, '这正是 patent 的 300 被 330 顶掉的根因');
    assert.equal(fo.shouldSubmit('theme', { touched, options }), false, '空串算未给出');
    assert.equal(fo.shouldSubmit('font', { touched, options }), false, 'null 算未给出');
    // touched 也接受数组形式
    assert.equal(fo.shouldSubmit('jpegPpi', { touched: ['jpegPpi'], options }), true);
    // 缺参数时按「都没有」处理
    assert.equal(fo.shouldSubmit('jpegPpi'), false);
});

test('submittedKeys：按 FIELDS 顺序筛出该提交的键，未给出且未改动的一律不进', () => {
    const fields = [fieldOf('imageFormat'), fieldOf('jpegPpi'), fieldOf('xmlProfile')];
    assert.deepEqual(fo.submittedKeys(fields, { touched: new Set(['xmlProfile']), options: {} }), ['xmlProfile']);
    assert.deepEqual(fo.submittedKeys(fields, { touched: new Set(), options: { imageFormat: 'keep' } }), ['imageFormat']);
    assert.deepEqual(
        fo.submittedKeys(fields, { touched: new Set(['jpegPpi']), options: { imageFormat: 'keep' } }),
        ['imageFormat', 'jpegPpi'],
    );
    assert.deepEqual(fo.submittedKeys(fields, { touched: new Set(), options: {} }), []);
    assert.deepEqual(fo.submittedKeys(null, { touched: new Set(), options: {} }), []);
});

test('isExplicit：undefined、null 与空串都算未给出，false 与 0 算给出', () => {
    assert.equal(fo.isExplicit({ a: false }, 'a'), true);
    assert.equal(fo.isExplicit({ a: 0 }, 'a'), true);
    assert.equal(fo.isExplicit({ a: undefined }, 'a'), false);
    assert.equal(fo.isExplicit({ a: null }, 'a'), false);
    assert.equal(fo.isExplicit({ a: '' }, 'a'), false);
    assert.equal(fo.isExplicit(null, 'a'), false);
});

// ============================================================
// 键 → 标签
// ============================================================

test('fieldLabel / describeKeys：扁平键名换成中文标签，非面板字段回退为键名', () => {
    assert.equal(fo.fieldLabel('xmlImportParagraphNumbers'), '段号写进正文');
    assert.equal(fo.fieldLabel('imageFormat'), '图片格式');
    assert.equal(fo.fieldLabel('jpegPpi'), 'JPG 分辨率（PPI）');
    assert.equal(fo.fieldLabel('mineruModel'), 'mineruModel', '不是面板字段的键回退为键名');
    assert.equal(fo.fieldLabel(undefined), '');
    assert.equal(
        fo.describeKeys(['imageFormat', 'jpegPpi', 'xmlImportParagraphNumbers']),
        '图片格式、JPG 分辨率（PPI）、段号写进正文',
    );
    assert.equal(fo.describeKeys(['xmlImportParagraphNumbers']), '段号写进正文');
    assert.equal(fo.describeKeys([]), '');
    assert.equal(fo.describeKeys(null), '');
});

test('XML 方言文案：两处下拉共用同一份，取值与描述树一致', () => {
    const node = fo.pickNode(tree(), ['xml', 'profile']);
    assert.deepEqual(node.values, Object.keys(fo.XML_PROFILE_LABELS));
    assert.equal(fo.profileLabel('generic'), '通用结构');
    assert.equal(fo.profileLabel('patent'), '国知局五书');
    assert.equal(fo.profileLabel('未知'), '未知');
    assert.equal(node.default, 'generic', '下拉未设默认项时的初值');
});

// ============================================================
// 可见字段
// ============================================================

test('visibleFields：按目标、输入类型与 xml 方言筛选', () => {
    const has = (fields, key) => fields.some((field) => field.key === key);
    const xmlPatent = fo.visibleFields({ target: 'xml', type: 'docx', profile: 'patent' });
    assert.ok(has(xmlPatent, 'xmlProfile') && has(xmlPatent, 'patentParts') && has(xmlPatent, 'validate'));
    assert.ok(!has(xmlPatent, 'theme'), 'html 专属字段不出现在 xml 目标下');

    const xmlGeneric = fo.visibleFields({ target: 'xml', type: 'docx', profile: 'generic' });
    assert.ok(has(xmlGeneric, 'xmlProfile') && has(xmlGeneric, 'xmlIndent'));
    assert.ok(!has(xmlGeneric, 'patentParts'), 'patent 专属字段不出现在 generic 下');
    assert.ok(!has(xmlGeneric, 'validate'), 'DTD 校验字段只在 patent 下出现');

    // 输入类型限定：段号只对五书输入出现，文档公式只对 docx 出现
    assert.ok(has(fo.visibleFields({ target: 'docx', type: 'xml' }), 'xmlImportParagraphNumbers'));
    assert.ok(has(fo.visibleFields({ target: 'docx', type: 'zip' }), 'xmlImportParagraphNumbers'));
    assert.ok(!has(fo.visibleFields({ target: 'xml', type: 'docx' }), 'xmlImportParagraphNumbers'));
    assert.ok(has(fo.visibleFields({ target: 'xml', type: 'docx' }), 'math'));
    assert.ok(!has(fo.visibleFields({ target: 'xml', type: 'md' }), 'math'));

    // profile 缺省按 generic 处理；hasNode 为假的字段被剔除
    assert.deepEqual(
        fo.visibleFields({ target: 'xml', type: 'docx' }).map((f) => f.key),
        xmlGeneric.map((f) => f.key),
    );
    assert.deepEqual(fo.visibleFields({ target: 'xml', type: 'docx' }, () => false), []);
});

test('描述树里存在的字段才会显示：以真实 describeOptions() 作 hasNode', () => {
    const fields = fo.visibleFields({ target: 'xml', type: 'docx', profile: 'patent' }, (field) => fo.pickNode(tree(), field.path));
    assert.ok(fields.length > 0);
    for (const field of fields) assert.ok(fo.pickNode(tree(), field.path), field.key);
});
