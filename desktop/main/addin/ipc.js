/**
 * Word 加载项的 IPC 通道定义（供设置页的「Word 加载项」分区使用；由 desktop/main/ipc.js 并入总表统一校验与注册）
 *
 * ADDIN_CHANNELS / ADDIN_SCHEMAS：通道名与逐通道的 zod 入参 schema
 *   mf:addin:status                   → describe()：{ supported, platform, enabled, server, manifest, manual, unsupportedMessage }
 *   mf:addin:setEnabled { enabled }   → 持久化开关并立即启停回环服务，回 describe()
 *   mf:addin:install / mf:addin:uninstall → 写入 / 移除 Word 旁加载目录里的清单，回 describe()
 * createAddinHandlers(addin) → { [channel]: async (event, payload) }；addin 为 null（模块未就绪）时各通道抛中文错误
 *
 * 渲染层只能给一个布尔开关：端口、目录与清单内容都由主进程决定；回包不含令牌。
 */
const { z } = require('zod');

const ADDIN_NOT_READY = 'Word 加载项模块未就绪';

const ADDIN_CHANNELS = Object.freeze({
    addinStatus: 'mf:addin:status',
    addinSetEnabled: 'mf:addin:setEnabled',
    addinInstall: 'mf:addin:install',
    addinUninstall: 'mf:addin:uninstall',
});

const NoPayload = z.union([z.undefined(), z.null(), z.object({}).strict()]);

const ADDIN_SCHEMAS = Object.freeze({
    [ADDIN_CHANNELS.addinStatus]: NoPayload,
    [ADDIN_CHANNELS.addinSetEnabled]: z.object({ enabled: z.boolean() }).strict(),
    [ADDIN_CHANNELS.addinInstall]: NoPayload,
    [ADDIN_CHANNELS.addinUninstall]: NoPayload,
});

function createAddinHandlers(addin) {
    const requireAddin = () => {
        if (!addin) throw new Error(ADDIN_NOT_READY);
        return addin;
    };
    return {
        [ADDIN_CHANNELS.addinStatus]: async () => requireAddin().describe(),
        [ADDIN_CHANNELS.addinSetEnabled]: async (event, payload) => requireAddin().setEnabled(payload.enabled),
        [ADDIN_CHANNELS.addinInstall]: async () => requireAddin().install(),
        [ADDIN_CHANNELS.addinUninstall]: async () => requireAddin().uninstall(),
    };
}

module.exports = { ADDIN_CHANNELS, ADDIN_SCHEMAS, createAddinHandlers, ADDIN_NOT_READY };
