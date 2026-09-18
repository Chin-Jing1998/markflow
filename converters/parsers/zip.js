/**
 * 专利案卷 zip → IR
 *
 * 调度器按输入类型名懒加载 converters/parsers/<类型>.js（.zip → 类型 zip），而案卷 zip、单个五书 XML 与五书目录
 * 走的是同一条导入链路，实现统一在 parsers/xml.js——由它按输入形态分流。本文件只做转引，契约见该文件头。
 * 受理范围：官方「WORD 转 XML 编辑器」与本工具产出的专利案卷包；其它 zip 会得到中文错误，不会被解包落盘。
 */
const { parse } = require('./xml');

module.exports = { parse };
