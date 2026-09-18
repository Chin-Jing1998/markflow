/**
 * Word 加载项总装：把设置开关、回环服务、任务编排与清单安装器接在一起（纯 Node，依赖全部经参数注入）
 *
 * createWordAddin({ settings, service, actions?, version, paths, platform?, port?, maxBodyBytes?, log? }) → addin
 *   settings   desktop/main/settings 的 store：读 get().wordAddin.enabled / outputDir / defaults，写 setWordAddin()
 *   service    converters/service（只调用，不改）
 *   actions    { reveal(outputPath), preview(filePath) }：由主进程入口注入（shell 与窗口都在那边）
 *   paths      { staticDir, templatePath, wefDir, stagingDir, tmpRoot }，一律绝对路径
 *   port       缺省 49731；测试传 0 取临时端口
 *
 *   init()               应用启动时调用一次：设置里已启用且平台受支持才开始监听（默认关闭，故默认不监听任何端口）
 *   setEnabled(enabled)  先持久化开关，再立即启停服务 → describe()；非 macOS 上启用直接拒绝。
 *                        端口被占用时开关仍保持「已启用」，原因写在 server 状态里，下次启动会再试
 *   describe()           → { supported, platform, enabled, server, manifest, manual, unsupportedMessage }（供设置页展示，不含令牌）。
 *                        清单状态只在加载项已启用时才去读 Word 的容器目录，未启用时为 'unchecked'：读该目录可能触发 macOS 的
 *                        「访问其他 App 的数据」授权框，不应让从不使用本功能的用户一打开设置页就被弹框
 *   install() / uninstall() → describe({ probe: true })：用户亲手点了按钮，此时必然要读写该目录
 *   dispose()            应用退出时调用：停止监听、结束任务编排并清理临时目录
 *
 * 启停串行：连续切换开关时后一次等前一次完成，不会出现「先发的 stop 晚于后发的 start」。
 */
const { createJobManager } = require('./jobs');
const { createAddinServer } = require('./server');
const { createManifestInstaller, UNSUPPORTED_MESSAGE } = require('./manifest-installer');

const SUPPORTED_PLATFORM = 'darwin';
const noop = () => undefined;

function createWordAddin({
    settings, service, actions = {}, version, paths = {}, platform = process.platform, port, maxBodyBytes, log = noop,
} = {}) {
    if (!settings || typeof settings.get !== 'function' || typeof settings.setWordAddin !== 'function') throw new Error('createWordAddin 缺少 settings');
    if (!service) throw new Error('createWordAddin 缺少 service');
    const supported = platform === SUPPORTED_PLATFORM;
    const jobs = createJobManager({
        service, log,
        tmpRoot: paths.tmpRoot,
        getOutputDir: () => settings.get().outputDir,
        getDefaults: () => settings.get().defaults || {},
    });
    const server = createAddinServer({
        staticDir: paths.staticDir, version, jobs, actions, log,
        ...(port === undefined ? {} : { port }),
        ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
    });
    const installer = createManifestInstaller({ templatePath: paths.templatePath, wefDir: paths.wefDir, stagingDir: paths.stagingDir, platform });

    let chain = Promise.resolve();
    const serial = (task) => {
        const run = chain.then(task, task);
        chain = run.then(noop, noop);
        return run;
    };

    const isEnabled = () => Boolean((settings.get().wordAddin || {}).enabled);

    async function describe({ probe = false } = {}) {
        return {
            supported, platform,
            enabled: isEnabled(),
            server: server.status(),
            manifest: probe || isEnabled() ? await installer.status() : installer.unchecked(),
            manual: installer.manual(),
            unsupportedMessage: supported ? '' : UNSUPPORTED_MESSAGE,
        };
    }

    const init = () => serial(async () => {
        if (supported && isEnabled()) await server.start();
        return describe();
    });

    const setEnabled = (enabled) => serial(async () => {
        const next = Boolean(enabled);
        if (next && !supported) throw new Error(UNSUPPORTED_MESSAGE);
        await settings.setWordAddin({ enabled: next });
        if (next) await server.start();
        else await server.stop();
        return describe();
    });

    const install = () => serial(async () => {
        await installer.install();
        return describe({ probe: true });
    });

    const uninstall = () => serial(async () => {
        await installer.uninstall();
        return describe({ probe: true });
    });

    const dispose = () => serial(async () => {
        await server.stop();
        await jobs.dispose();
    });

    return { init, setEnabled, describe, install, uninstall, dispose, supported };
}

module.exports = { createWordAddin };
