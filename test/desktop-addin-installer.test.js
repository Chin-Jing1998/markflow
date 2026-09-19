/**
 * desktop/main/addin/manifest-installer.js 与清单模板的单元测试（只对临时目录安装，绝不触碰真实的 Word 容器目录）
 * 覆盖：未安装 / 已安装 / 清单与当前版本不一致三态；安装时建 wef 目录、原子写入、在 stagingDir 留副本；
 *       卸载只删本加载项的清单，wef 因此为空才删目录，其他加载项的清单原样保留；重复卸载幂等；
 *       Word 数据目录不存在与目录不可写（模拟 macOS 拒绝授权）时的中文错误与手动命令；非 macOS 一律 unsupported；
 *       清单模板：端口与服务默认端口一致、最小形态（无 VersionOverrides）、名称与固定 GUID；
 *       打包清单（package.json 的 build.files）未把 office-addin/ 排除在外。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    createManifestInstaller, defaultWefDir, shellQuote, MANIFEST_FILENAME, STATE, UNSUPPORTED_MESSAGE,
} = require('../desktop/main/addin/manifest-installer');
const { DEFAULT_PORT, STATIC_FILES } = require('../desktop/main/addin/server');
const pkg = require('../package.json');

const TMP_ROOT = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const root = fs.mkdtempSync(path.join(TMP_ROOT, 'addin-installer-'));
const chmodBack = [];
after(() => {
    for (const dir of chmodBack) fs.chmodSync(dir, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
});

const ADDIN_DIR = path.join(__dirname, '..', 'office-addin');
const TEMPLATE = path.join(ADDIN_DIR, 'manifest.xml');

let seq = 0;
/** 造一个假的「Word 容器」：<home>/…/Data/Documents 存在，wef 不存在（与本机实测的初始状态一致） */
function fakeHome({ withDocuments = true } = {}) {
    seq += 1;
    const home = path.join(root, `home ${seq}`);
    const wefDir = defaultWefDir(home);
    if (withDocuments) fs.mkdirSync(path.dirname(wefDir), { recursive: true });
    return { home, wefDir, stagingDir: path.join(home, 'userData', 'word-addin') };
}

function installerFor(home, overrides = {}) {
    return createManifestInstaller({ templatePath: TEMPLATE, wefDir: home.wefDir, stagingDir: home.stagingDir, platform: 'darwin', ...overrides });
}

// ============================================================
// 安装、状态与卸载
// ============================================================

test('defaultWefDir：官方规定的旁加载目录', { skip: process.platform === 'win32' && '旁加载目录是 macOS 路径，Windows 上的分隔符不同' }, () => {
    assert.equal(defaultWefDir('/Users/someone'), '/Users/someone/Library/Containers/com.microsoft.Word/Data/Documents/wef');
    assert.ok(!defaultWefDir(path.join(root, 'x')).startsWith(os.homedir()) || root.startsWith(os.homedir()), '测试只用临时目录下的假 home');
});

test('未安装 → 安装（建 wef、写清单、留副本）→ 已安装', async () => {
    const home = fakeHome();
    const installer = installerFor(home);
    assert.equal(installer.supported, true);
    assert.deepEqual(await installer.status(), { state: STATE.NOT_INSTALLED, manifestPath: path.join(home.wefDir, MANIFEST_FILENAME), wefDir: home.wefDir });
    assert.equal(fs.existsSync(home.wefDir), false, '查询状态不创建任何目录');

    const status = await installer.install();
    assert.equal(status.state, STATE.INSTALLED);
    const installed = fs.readFileSync(path.join(home.wefDir, MANIFEST_FILENAME));
    assert.ok(installed.equals(fs.readFileSync(TEMPLATE)), '写入的清单与模板逐字节一致');
    assert.ok(fs.readFileSync(path.join(home.stagingDir, MANIFEST_FILENAME)).equals(installed), 'stagingDir 留有副本，供手动安装命令使用');
    assert.deepEqual(fs.readdirSync(home.wefDir), [MANIFEST_FILENAME], '不留临时文件');
    assert.equal((await installer.install()).state, STATE.INSTALLED, '重复安装幂等');
});

test('清单内容与当前版本不一致 → outdated；重新安装后恢复 installed', async () => {
    const home = fakeHome();
    const installer = installerFor(home);
    await installer.install();
    fs.writeFileSync(path.join(home.wefDir, MANIFEST_FILENAME), '<OfficeApp>旧版本的清单</OfficeApp>');
    assert.equal((await installer.status()).state, STATE.OUTDATED);
    assert.equal((await installer.install()).state, STATE.INSTALLED);
});

test('卸载：只删本加载项的清单；wef 因此为空才删目录；其他加载项的清单原样保留；重复卸载幂等', async () => {
    const alone = fakeHome();
    const installer = installerFor(alone);
    await installer.install();
    assert.equal((await installer.uninstall()).state, STATE.NOT_INSTALLED);
    assert.equal(fs.existsSync(alone.wefDir), false, 'wef 本机原本不存在：清空后一并删除，回到原状');
    assert.ok(fs.existsSync(path.dirname(alone.wefDir)), '上一层目录不动');
    assert.equal((await installer.uninstall()).state, STATE.NOT_INSTALLED, '未安装时卸载不报错');

    const shared = fakeHome();
    const sharedInstaller = installerFor(shared);
    await sharedInstaller.install();
    const other = path.join(shared.wefDir, 'someone-elses-addin.xml');
    fs.writeFileSync(other, '<OfficeApp/>');
    assert.equal((await sharedInstaller.uninstall()).state, STATE.NOT_INSTALLED);
    assert.deepEqual(fs.readdirSync(shared.wefDir), ['someone-elses-addin.xml'], '别的加载项的清单不受影响');
    assert.equal(fs.readFileSync(other, 'utf8'), '<OfficeApp/>');
});

test('Word 的数据目录不存在：不替它造容器目录，提示先启动一次 Word', async () => {
    const home = fakeHome({ withDocuments: false });
    const installer = installerFor(home);
    await assert.rejects(installer.install(), /未找到 Word 的数据目录.*至少启动一次/);
    assert.equal(fs.existsSync(path.join(home.home, 'Library')), false, '没有创建任何容器目录');
    assert.equal((await installer.status()).state, STATE.NOT_INSTALLED);
});

test('目录不可写（模拟 macOS 未授权访问其他 App 的数据）：中文错误附带可粘贴的手动命令', async (t) => {
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
        t.skip('Windows 没有 POSIX 权限位，root 不受目录权限限制');
        return;
    }
    const home = fakeHome();
    const installer = installerFor(home);
    const documents = path.dirname(home.wefDir);
    fs.chmodSync(documents, 0o555);
    chmodBack.push(documents);
    await assert.rejects(installer.install(), (err) => {
        assert.match(err.message, /安装到 Word 失败：macOS 未允许 MarkFlow 访问 Word 的数据目录/);
        assert.ok(err.message.includes(installer.manual().install), '错误文案里带着手动安装命令');
        return true;
    });
    fs.chmodSync(documents, 0o755);
    await installer.install();
    fs.chmodSync(home.wefDir, 0o555);
    chmodBack.push(home.wefDir);
    await assert.rejects(installer.uninstall(), (err) => err.message.includes('从 Word 移除失败') && err.message.includes(installer.manual().uninstall));
});

test('连数据目录都不让看（stat 即被拒）：按「未获授权」提示并给手动命令，而不是误报「未找到 Word 的数据目录」', async (t) => {
    if (process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) {
        t.skip('Windows 没有 POSIX 权限位，root 不受目录权限限制');
        return;
    }
    const home = fakeHome();
    const installer = installerFor(home);
    const dataDir = path.dirname(path.dirname(home.wefDir));
    fs.chmodSync(dataDir, 0o000);
    chmodBack.push(dataDir);
    await assert.rejects(installer.install(), (err) => /macOS 未允许 MarkFlow 访问 Word 的数据目录/.test(err.message) && err.message.includes(installer.manual().install));
    assert.equal((await installer.status()).state, STATE.NOT_INSTALLED, '状态查询读不到时按未安装处理，不让设置页报错');
});

test('unchecked()：不触碰文件系统的占位状态（未启用加载项时用它，避免无谓地触发 macOS 授权框）', () => {
    const home = fakeHome({ withDocuments: false });
    assert.deepEqual(installerFor(home).unchecked(), { state: STATE.UNCHECKED, manifestPath: path.join(home.wefDir, MANIFEST_FILENAME), wefDir: home.wefDir });
    assert.equal(installerFor(home, { platform: 'win32' }).unchecked().state, STATE.UNSUPPORTED);
    assert.equal(fs.existsSync(home.home), false);
});

test('手动命令：引用 stagingDir 里的副本（打包后模板在 app.asar 内，终端的 cp 读不到），路径经单引号转义', () => {
    const home = fakeHome();
    const tricky = { ...home, wefDir: path.join(home.home, "it's a dir", 'wef') };
    const manual = installerFor(tricky).manual();
    assert.equal(manual.install, `mkdir -p ${shellQuote(tricky.wefDir)} && cp ${shellQuote(path.join(home.stagingDir, MANIFEST_FILENAME))} ${shellQuote(tricky.wefDir)}/`);
    assert.equal(manual.uninstall, `rm -f ${shellQuote(path.join(tricky.wefDir, MANIFEST_FILENAME))}`);
    assert.equal(shellQuote("a'b c"), "'a'\\''b c'");
    assert.ok(!manual.uninstall.includes('rm -rf'), '手动卸载也只删单个清单文件');
});

test('非 macOS：状态为 unsupported，安装与卸载直接拒绝，不读不写任何目录', async () => {
    for (const platform of ['win32', 'linux']) {
        const home = fakeHome();
        const installer = installerFor(home, { platform });
        assert.equal(installer.supported, false);
        assert.equal((await installer.status()).state, STATE.UNSUPPORTED);
        await assert.rejects(installer.install(), new RegExp(UNSUPPORTED_MESSAGE));
        await assert.rejects(installer.uninstall(), new RegExp(UNSUPPORTED_MESSAGE));
        assert.equal(fs.existsSync(home.wefDir), false);
        assert.equal(fs.existsSync(home.stagingDir), false);
    }
    assert.equal(UNSUPPORTED_MESSAGE, '仅支持 macOS 版 Word');
});

test('入参须为绝对路径', () => {
    const home = fakeHome();
    assert.throws(() => createManifestInstaller({ templatePath: 'manifest.xml', wefDir: home.wefDir, stagingDir: home.stagingDir }), /绝对路径的 templatePath/);
    assert.throws(() => createManifestInstaller({ templatePath: TEMPLATE, wefDir: 'wef', stagingDir: home.stagingDir }), /绝对路径的 wefDir/);
    assert.throws(() => createManifestInstaller({ templatePath: TEMPLATE, wefDir: home.wefDir }), /绝对路径的 stagingDir/);
});

// ============================================================
// 清单模板与打包清单
// ============================================================

test('清单模板：门禁实测通过的最小形态，端口与服务默认端口一致', () => {
    const xml = fs.readFileSync(TEMPLATE, 'utf8');
    const body = xml.replace(/<!--[\s\S]*?-->/g, '');
    assert.match(body, /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<OfficeApp\b[^>]*xsi:type="TaskPaneApp"/);
    assert.match(body, /<Id>E4E146E8-7926-41F1-9D50-340228E0CAE9<\/Id>/, '固定 GUID：变了 Word 会把它当成另一个加载项');
    assert.ok(!body.includes('D07335F8-4CFB-4308-A3F5-F4ED86701C89'), '不与门禁测试清单共用 GUID');
    assert.match(body, /<DisplayName DefaultValue="MarkFlow 专利 XML" \/>/);
    assert.match(body, /<Host Name="Document" \/>/);
    assert.match(body, /<Permissions>ReadWriteDocument<\/Permissions>/);
    const source = /<SourceLocation DefaultValue="([^"]+)" \/>/.exec(body)[1];
    assert.equal(source, `http://localhost:${DEFAULT_PORT}/taskpane.html`);
    assert.ok(STATIC_FILES[new URL(source).pathname], '清单指向的页面在服务的静态白名单上');
    for (const absent of ['VersionOverrides', 'IconUrl', 'SupportUrl', 'AppDomains', 'Requirements']) assert.ok(!body.includes(absent), `最小形态不含 ${absent}`);
    const order = ['<Id>', '<Version>', '<ProviderName>', '<DefaultLocale>', '<DisplayName', '<Description', '<Hosts>', '<DefaultSettings>', '<Permissions>'].map((tag) => body.indexOf(tag));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), '元素须按官方规定的顺序出现');
    assert.ok(order.every((index) => index > 0));
});

test('任务窗格只引用一个外部脚本（微软官方 CDN 的 office.js），其余资源同源', () => {
    const html = fs.readFileSync(path.join(ADDIN_DIR, 'taskpane', 'taskpane.html'), 'utf8');
    const external = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((hit) => hit[1]);
    assert.deepEqual(external, ['https://appsforoffice.microsoft.com/lib/1/hosted/office.js']);
    const local = [...html.matchAll(/(?:src|href)="([^":]+)"/g)].map((hit) => `/${hit[1]}`);
    assert.deepEqual(local.sort(), ['/taskpane.css', '/taskpane.js']);
    for (const target of local) assert.ok(STATIC_FILES[target], target);
    assert.ok(!/\son[a-z]+=/i.test(html), '不用内联事件处理器');
});

test('打包清单未把 office-addin/ 排除在外（build.files 的 **/* 已覆盖，否定模式都不指向它）', () => {
    const files = pkg.build.files;
    assert.ok(files.includes('**/*') || files.includes('office-addin/**'));
    const negations = files.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1));
    for (const pattern of negations) assert.ok(!/^(?:\*\*\/)?office-addin\b/.test(pattern), pattern);
    const shipped = ['office-addin/manifest.xml', 'office-addin/taskpane/taskpane.html', 'office-addin/taskpane/taskpane.js', 'office-addin/taskpane/taskpane.css'];
    const excludedExts = negations.filter((pattern) => pattern.startsWith('**/*.')).map((pattern) => pattern.slice('**/*'.length));
    for (const file of shipped) {
        assert.ok(fs.existsSync(path.join(__dirname, '..', file)), file);
        assert.ok(!excludedExts.includes(path.extname(file)), `${file} 的扩展名未被排除`);
    }
});
