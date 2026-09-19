/**
 * Word 加载项清单的安装器（纯 Node，可对临时目录单测；真实的 Word 旁加载目录只在用户点按钮时才会被写入）
 *
 * createManifestInstaller({ templatePath, wefDir, stagingDir, platform? }) → installer
 *   templatePath  随应用分发的清单模板（office-addin/manifest.xml）
 *   wefDir        Word 的旁加载目录：~/Library/Containers/com.microsoft.Word/Data/Documents/wef
 *   stagingDir    userData 下的一个真实目录：安装前先把清单副本放在这里。打包后模板位于 app.asar 之内，
 *                 终端里的 cp 读不到它，手动安装命令因此一律引用这份副本
 *   status()    → { state: 'unsupported'|'not-installed'|'installed'|'outdated', manifestPath, wefDir }
 *                 outdated：已装的清单与当前版本的模板内容不一致（升级 MarkFlow 后可能出现），重新安装即可
 *   unchecked() → 同形对象，state 为 'unchecked'，不触碰文件系统。读 Word 的容器目录同样可能触发 macOS 的
 *                 「访问其他 App 的数据」授权框，故总装只在用户启用了加载项或亲手点了安装 / 移除时才调 status()，
 *                 从不使用本功能的用户打开设置页不会被弹框
 *   install()   → status；旁加载目录不存在则创建（只建 wef 这一层：上一层不存在说明 Word 从未运行过，
 *                 此时替它造出容器目录并无意义，改为提示先启动一次 Word）
 *   uninstall() → status；只删本加载项的清单文件，若 wef 目录因此为空则一并删除；其他加载项的清单不受影响
 *   manual()    → { install, uninstall }：可直接粘贴到「终端」执行的命令
 *
 * 写入 Word 的容器目录可能触发 macOS「访问其他 App 的数据」授权；用户拒绝时系统回 EPERM / EACCES，
 * 此时抛出带手动安装命令的中文错误。本模块不清理 Office 的加载项缓存——官方要求清缓存须整体清空，
 * 那会连带移除用户的其他旁加载项，只在界面上说明，不替用户执行。
 * 非 macOS 平台一律 unsupported，install / uninstall 直接拒绝。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { errText } = require('../../../converters/util');

const fsp = fs.promises;
const noop = () => undefined;
const MANIFEST_FILENAME = 'markflow-patent-xml.xml';
const SUPPORTED_PLATFORM = 'darwin';
const WEF_RELATIVE = Object.freeze(['Library', 'Containers', 'com.microsoft.Word', 'Data', 'Documents', 'wef']);
const STATE = Object.freeze({ UNSUPPORTED: 'unsupported', UNCHECKED: 'unchecked', NOT_INSTALLED: 'not-installed', INSTALLED: 'installed', OUTDATED: 'outdated' });
const UNSUPPORTED_MESSAGE = '仅支持 macOS 版 Word';
const PERMISSION_CODES = new Set(['EPERM', 'EACCES']);

const defaultWefDir = (homeDir) => path.join(homeDir, ...WEF_RELATIVE);
/** 单引号包裹供 shell 使用：路径里的单引号改写为 '\'' */
const shellQuote = (text) => `'${String(text).split("'").join("'\\''")}'`;

async function readOrNull(file) {
    try {
        return await fsp.readFile(file);
    } catch (err) {
        if (err && err.code === 'ENOENT') return null;
        throw err;
    }
}

/** 同目录临时文件 + rename，避免 Word 读到写了一半的清单 */
async function writeAtomic(file, buffer) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        await fsp.writeFile(tmp, buffer, { flag: 'wx' });
        await fsp.rename(tmp, file);
    } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(noop);
        throw err;
    }
}

function createManifestInstaller({ templatePath, wefDir, stagingDir, platform = process.platform } = {}) {
    for (const [name, value] of Object.entries({ templatePath, wefDir, stagingDir })) {
        if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`createManifestInstaller 需要绝对路径的 ${name}`);
    }
    const supported = platform === SUPPORTED_PLATFORM;
    const manifestPath = path.join(wefDir, MANIFEST_FILENAME);
    const stagedPath = path.join(stagingDir, MANIFEST_FILENAME);

    const manual = () => ({
        install: `mkdir -p ${shellQuote(wefDir)} && cp ${shellQuote(stagedPath)} ${shellQuote(wefDir)}/`,
        uninstall: `rm -f ${shellQuote(manifestPath)}`,
    });

    const unchecked = () => ({ manifestPath, wefDir, state: supported ? STATE.UNCHECKED : STATE.UNSUPPORTED });

    async function status() {
        const base = { manifestPath, wefDir };
        if (!supported) return { ...base, state: STATE.UNSUPPORTED };
        let installed;
        try {
            installed = await readOrNull(manifestPath);
        } catch (err) {
            // 读不到（多半是未获授权）按未安装处理：状态查询不应让设置页报错
            return { ...base, state: STATE.NOT_INSTALLED };
        }
        if (!installed) return { ...base, state: STATE.NOT_INSTALLED };
        const template = await fsp.readFile(templatePath);
        return { ...base, state: installed.equals(template) ? STATE.INSTALLED : STATE.OUTDATED };
    }

    /** 清单副本落到 stagingDir：既是手动安装命令的来源，也让 cp 不必面对 app.asar 里的虚拟路径 */
    async function stage() {
        const template = await fsp.readFile(templatePath);
        await fsp.mkdir(stagingDir, { recursive: true });
        await writeAtomic(stagedPath, template);
        return template;
    }

    function describeFailure(action, err, command) {
        const denied = err && PERMISSION_CODES.has(err.code);
        const reason = denied ? 'macOS 未允许 MarkFlow 访问 Word 的数据目录' : errText(err);
        return new Error(`${action}失败：${reason}。可在「终端」执行以下命令手动完成：${command}`);
    }

    async function install() {
        if (!supported) throw new Error(UNSUPPORTED_MESSAGE);
        const template = await stage();
        // 被 macOS 拒绝访问时 stat 报 EPERM / EACCES，与「目录不存在」是两回事，须分开提示
        const parentStat = await fsp.stat(path.dirname(wefDir)).catch((err) => err);
        if (parentStat instanceof Error && PERMISSION_CODES.has(parentStat.code)) throw describeFailure('安装到 Word ', parentStat, manual().install);
        if (parentStat instanceof Error || !parentStat.isDirectory()) {
            throw new Error('未找到 Word 的数据目录：请先安装 Microsoft Word 并至少启动一次，再点「安装到 Word」');
        }
        try {
            await fsp.mkdir(wefDir, { recursive: false }).catch((err) => { if (!err || err.code !== 'EEXIST') throw err; });
            await writeAtomic(manifestPath, template);
        } catch (err) {
            throw describeFailure('安装到 Word ', err, manual().install);
        }
        return status();
    }

    async function uninstall() {
        if (!supported) throw new Error(UNSUPPORTED_MESSAGE);
        try {
            await fsp.rm(manifestPath, { force: true });
            // rmdir 只删空目录：里面还有其他加载项的清单（或任何别的文件）时原样保留
            await fsp.rmdir(wefDir).catch((err) => { if (!err || !['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(err.code)) throw err; });
        } catch (err) {
            throw describeFailure('从 Word 移除', err, manual().uninstall);
        }
        return status();
    }

    return { supported, status, unchecked, install, uninstall, manual, paths: Object.freeze({ manifestPath, wefDir, stagedPath }) };
}

module.exports = { createManifestInstaller, defaultWefDir, shellQuote, MANIFEST_FILENAME, STATE, UNSUPPORTED_MESSAGE, WEF_RELATIVE };
