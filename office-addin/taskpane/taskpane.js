/* eslint-env browser */
/**
 * MarkFlow 专利 XML —— 任务窗格脚本（零构建、无第三方依赖；运行于 Mac 版 Word 的 WKWebView）
 *
 * 流程：Office.onReady → 探活（GET /v1/health）→ 主按钮「转换为专利 XML」→ 分片取当前文档（含未保存的编辑）
 *       → 上传（POST /v1/jobs）→ 轮询（GET /v1/jobs/:id）→ 展示发明名称、识别到的各书、预检阻断项、分组告警与产物路径。
 * Office.js 用法依微软现行文档：getFileAsync(Office.FileType.Compressed, { sliceSize: 4194304 }) 取 docx 字节，
 *   逐片 getSliceAsync，用完必须 closeAsync——内存里最多允许两份文档，不关闭会让后续的 getFileAsync 失败；
 *   Office.context.document.url 在已保存的本地文档上是绝对路径，未保存时为空串，云端文档是 http(s) 地址。
 * 纪律：页面只显示文件名、进度、告警与产物路径；文档正文不显示、不写日志；动态内容一律经 textContent 写入，不拼 HTML。
 * 令牌由服务端注入 <meta name="markflow-token">，随每个 API 请求放在 X-MarkFlow-Token 头里；写操作另带自定义头。
 *
 * 导出（Node 下 module.exports，浏览器下 window.MarkFlowTaskpane）：boot 与各纯函数，供单元测试与排障使用；
 * 浏览器里检测到全局 Office 时自动 boot，office.js 没加载成功（多为断网）时给出明确提示。
 */
(function main(root) {
    'use strict';

    const SLICE_SIZE = 4194304;
    const POLL_INTERVAL_MS = 700;
    const POLL_FAILURE_LIMIT = 5;
    const POLL_TIMEOUT_MS = 30 * 60 * 1000;
    const BYTES_PER_MB = 1024 * 1024;
    const TOKEN_HEADER = 'X-MarkFlow-Token';
    const CLIENT_HEADER = 'X-MarkFlow-Client';
    const CLIENT_HEADER_VALUE = 'word-taskpane';
    const UNSAVED_NAME = '未保存的文档';
    const PLACEHOLDER_RE = /^\{\{.*\}\}$/;
    const URL_FORM_RE = /^(?:https?|file):\/\//i;
    const RETRYABLE_CODES = ['service-down', 'lost-contact'];
    const PART_LABELS = [
        ['description', '说明书'], ['claims', '权利要求书'], ['abstract', '说明书摘要'],
        ['drawings', '说明书附图'], ['abstractFigure', '摘要附图'],
    ];
    /** 告警按文案前缀分组；顺序即展示顺序，未命中的归入「其他」 */
    const WARNING_GROUPS = ['预检', '分节', '发明名称', '权项', '段号', '附图', '栅格化', 'DTD 校验'];
    const OTHER_GROUP = '其他';
    const PHASE_LABELS = { queued: '排队中', parsing: '正在解析文档', rendering: '正在生成五书 XML', writing: '正在写入磁盘', done: '已完成' };
    const MESSAGES = {
        notWord: '请在 Word 中打开本任务窗格。',
        officeMissing: '未能加载 Office.js（需要联网访问微软的 appsforoffice.microsoft.com）。请检查网络，然后关闭并重新打开任务窗格。',
        serviceDown: '连接不上 MarkFlow。请确认 MarkFlow 正在运行，并已在「设置 → Word 加载项」中启用，然后点「重试连接」。',
        unauthorized: '令牌已失效（MarkFlow 重新启动过）。请关闭本任务窗格后重新打开。',
        pageBroken: '页面没有拿到令牌。请确认本页是由 MarkFlow 提供的，然后关闭并重新打开任务窗格。',
        lostContact: '与 MarkFlow 的连接中断，转换结果未知。请到 MarkFlow 的输出目录查看，或点「重试连接」后重新转换。',
        timeout: '等待超过 30 分钟仍未完成。转换可能仍在进行，请稍后到输出目录查看。',
    };

    class PaneError extends Error {
        constructor(code, message) {
            super(message);
            this.name = 'PaneError';
            this.code = code;
        }
    }

    // ============================================================
    // 纯函数
    // ============================================================

    /** 'X：……' → 所属分组；blocking 里出现过的文案不再重复列入分组 */
    function groupWarnings(warnings, blocking) {
        const skip = new Set(Array.isArray(blocking) ? blocking : []);
        const buckets = new Map();
        for (const text of Array.isArray(warnings) ? warnings : []) {
            if (typeof text !== 'string' || skip.has(text)) continue;
            const hit = WARNING_GROUPS.find((name) => text.startsWith(`${name}：`));
            const key = hit || OTHER_GROUP;
            buckets.set(key, [...(buckets.get(key) || []), hit ? text.slice(hit.length + 1) : text]);
        }
        return [...WARNING_GROUPS, OTHER_GROUP].filter((name) => buckets.has(name)).map((name) => ({ name, items: buckets.get(name) }));
    }

    /** 文档地址 → 显示用文件名；空串即未保存。只有 URL 形式的地址才做百分号解码，本地路径里的 % 原样保留 */
    function displayNameOf(url) {
        const text = typeof url === 'string' ? url.trim() : '';
        const leaf = text.split(/[\\/]/).filter(Boolean).pop() || '';
        if (!text || !leaf) return UNSAVED_NAME;
        if (!URL_FORM_RE.test(text)) return leaf;
        try {
            return decodeURIComponent(leaf.split(/[?#]/)[0]) || UNSAVED_NAME;
        } catch (err) {
            return leaf;
        }
    }

    const formatSize = (bytes) => (bytes < BYTES_PER_MB ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / BYTES_PER_MB).toFixed(1)} MB`);

    function describeValidation(validation) {
        if (!validation || !validation.requested) return { text: 'DTD 校验：未执行', ok: false };
        if (!validation.engine) return { text: 'DTD 校验：校验器不可用，已跳过（详见告警）', ok: false };
        const files = Array.isArray(validation.files) ? validation.files : [];
        const failed = files.filter((item) => !item.valid);
        if (failed.length === 0) return { text: `DTD 校验：${files.length} 份全部通过`, ok: true };
        return { text: `DTD 校验：${failed.length} 份未通过（${failed.map((item) => item.file).join('、')}）`, ok: false };
    }

    function describeProgress(job) {
        if (job.status === 'queued') return { label: job.position > 1 ? `排队中（前面还有 ${job.position - 1} 个任务）` : '排队中，即将开始', value: 0 };
        return { label: PHASE_LABELS[job.phase] || '正在转换', value: Number.isFinite(job.pct) ? job.pct : 0 };
    }

    // ============================================================
    // Office：分片取当前文档
    // ============================================================

    const officeErrorText = (error) => (error && error.message ? error.message : '未知原因');

    /** → Promise<Uint8Array>：当前文档的 docx 字节（含未保存的编辑） */
    function readDocument(office, { maxBytes, onProgress }) {
        return new Promise((resolve, reject) => {
            office.context.document.getFileAsync(office.FileType.Compressed, { sliceSize: SLICE_SIZE }, (result) => {
                if (result.status !== office.AsyncResultStatus.Succeeded) {
                    reject(new PaneError('read-failed', `读取文档失败：${officeErrorText(result.error)}`));
                    return;
                }
                collectSlices(office, result.value, { maxBytes, onProgress }).then(resolve, reject);
            });
        });
    }

    /**
     * 文件大小事先可知，故各片直接写进一块预分配的缓冲区，不另留副本；
     * 成功、读片失败与超限三条路径都会 closeAsync，且只关一次。
     */
    function collectSlices(office, file, { maxBytes, onProgress }) {
        return new Promise((resolve, reject) => {
            let closed = false;
            const close = () => {
                if (closed) return;
                closed = true;
                try { file.closeAsync(); } catch (err) { /* 关闭失败无从补救，也不影响已取到的字节 */ }
            };
            const bail = (error) => { close(); reject(error); };
            if (Number.isFinite(maxBytes) && file.size > maxBytes) {
                bail(new PaneError('too-large', `文档大小为 ${formatSize(file.size)}，超过上限 ${formatSize(maxBytes)}，无法转换。`));
                return;
            }
            const bytes = new Uint8Array(file.size);
            let offset = 0;
            const finish = () => {
                close();
                if (offset === file.size) resolve(bytes);
                else reject(new PaneError('read-failed', '读取文档失败：取到的字节数与文档大小不一致'));
            };
            /** 收下一片：写进缓冲区并推进；写不下（分片数据超出文档大小）即失败 */
            const accept = (index, sliceResult) => {
                if (sliceResult.status !== office.AsyncResultStatus.Succeeded) {
                    bail(new PaneError('read-failed', `读取文档第 ${index + 1} 片失败：${officeErrorText(sliceResult.error)}`));
                    return;
                }
                try {
                    bytes.set(sliceResult.value.data, offset);
                } catch (err) {
                    bail(new PaneError('read-failed', '读取文档失败：分片数据超出文档大小'));
                    return;
                }
                offset += sliceResult.value.data.length;
                onProgress(index + 1, file.sliceCount);
                step(index + 1);
            };
            function step(index) {
                if (index >= file.sliceCount) finish();
                else file.getSliceAsync(index, (sliceResult) => accept(index, sliceResult));
            }
            step(0);
        });
    }

    // ============================================================
    // 与本机 MarkFlow 的通信（同源）
    // ============================================================

    function createClient({ fetchImpl, token }) {
        async function call(path, { method = 'GET', headers = {}, body } = {}) {
            const extra = method === 'GET' ? {} : { [CLIENT_HEADER]: CLIENT_HEADER_VALUE };
            let response;
            try {
                response = await fetchImpl(path, { method, body, cache: 'no-store', headers: { [TOKEN_HEADER]: token, ...extra, ...headers } });
            } catch (err) {
                throw new PaneError('service-down', MESSAGES.serviceDown);
            }
            let payload = null;
            try { payload = await response.json(); } catch (err) { payload = null; }
            if (response.status === 401) throw new PaneError('unauthorized', MESSAGES.unauthorized);
            if (!response.ok || !payload || payload.ok !== true) {
                const error = payload && payload.error ? payload.error : {};
                throw new PaneError(error.code || `http-${response.status}`, error.message || `MarkFlow 返回了 HTTP ${response.status}`);
            }
            return payload.data;
        }
        return {
            health: () => call('/v1/health'),
            createJob: (bytes, { fileName, sourcePath }) => call('/v1/jobs', {
                method: 'POST', body: bytes,
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'X-MarkFlow-File-Name': encodeURIComponent(fileName || ''),
                    'X-MarkFlow-Source-Path': encodeURIComponent(sourcePath || ''),
                },
            }),
            getJob: (id) => call(`/v1/jobs/${id}`),
            reveal: (id) => call(`/v1/jobs/${id}/reveal`, { method: 'POST' }),
            preview: (id, part) => call(`/v1/jobs/${id}/preview`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(part ? { part } : {}),
            }),
        };
    }

    /** 轮询到任务结束；偶发的网络失败容忍 POLL_FAILURE_LIMIT 次，令牌失效等其余错误立即上抛 */
    async function waitForJob(client, id, { onUpdate, sleep, now }) {
        const startedAt = now();
        let failures = 0;
        for (;;) {
            if (now() - startedAt > POLL_TIMEOUT_MS) throw new PaneError('timeout', MESSAGES.timeout);
            let job = null;
            try {
                job = await client.getJob(id);
                failures = 0;
            } catch (err) {
                if (err.code !== 'service-down') throw err;
                failures += 1;
                if (failures >= POLL_FAILURE_LIMIT) throw new PaneError('lost-contact', MESSAGES.lostContact);
            }
            if (job) onUpdate(job);
            if (job && job.status === 'succeeded') return job;
            if (job && job.status === 'failed') throw new PaneError('convert-failed', `转换失败：${(job.error && job.error.message) || '未知原因'}`);
            await sleep(POLL_INTERVAL_MS);
        }
    }

    // ============================================================
    // 视图（全部经 textContent / createElement，不拼 HTML）
    // ============================================================

    function make(doc, tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function makeButton(doc, className, text, onClick) {
        const node = make(doc, 'button', className, text);
        node.type = 'button';
        node.addEventListener('click', onClick);
        return node;
    }

    function issueList(doc, items) {
        const list = make(doc, 'ul', 'issues');
        for (const text of items) list.appendChild(make(doc, 'li', '', text));
        return list;
    }

    function titleCard(doc, result) {
        const card = make(doc, 'section', 'card');
        card.appendChild(make(doc, 'h2', '', '发明名称'));
        card.appendChild(make(doc, 'p', 'title-value', result.title || '（未识别到发明名称）'));
        return card;
    }

    /** 预检阻断项：置顶标红；没有则不出这张卡 */
    function blockingCard(doc, blocking) {
        if (blocking.length === 0) return null;
        const card = make(doc, 'section', 'card blocking');
        card.appendChild(make(doc, 'h2', '', `预检阻断项（${blocking.length}）：官方转换器会因此拒绝转换，请先在文档中处理`));
        card.appendChild(issueList(doc, blocking));
        return card;
    }

    function partsCard(doc, result, onPreviewPart) {
        const card = make(doc, 'section', 'card');
        card.appendChild(make(doc, 'h2', '', '识别到的各书'));
        const list = make(doc, 'ul', 'parts');
        for (const [key, label] of PART_LABELS) {
            const found = result.parts.includes(key);
            const item = make(doc, 'li');
            item.dataset.found = String(found);
            item.appendChild(make(doc, 'span', '', label));
            item.appendChild(found ? makeButton(doc, 'link', '预览', () => onPreviewPart(key)) : make(doc, 'span', 'mark', '未识别到'));
            list.appendChild(item);
        }
        card.appendChild(list);
        const validation = describeValidation(result.precheck && result.precheck.validation);
        card.appendChild(make(doc, 'p', validation.ok ? 'ok-line' : 'note', validation.text));
        return card;
    }

    function warningsCard(doc, result, blocking) {
        const groups = groupWarnings(result.warnings, blocking);
        const card = make(doc, 'section', 'card');
        card.appendChild(make(doc, 'h2', '', groups.length > 0 ? '告警' : '告警：无'));
        for (const group of groups) {
            const details = make(doc, 'details', 'group');
            const summary = make(doc, 'summary', '', group.name);
            summary.appendChild(make(doc, 'span', 'count', `（${group.items.length}）`));
            details.appendChild(summary);
            details.appendChild(issueList(doc, group.items));
            card.appendChild(details);
        }
        return card;
    }

    function outputCard(doc, job, handlers) {
        const card = make(doc, 'section', 'card');
        card.appendChild(make(doc, 'h2', '', '产物位置'));
        card.appendChild(make(doc, 'p', 'path-value', job.result.outputPath));
        if (job.location && job.location.note) card.appendChild(make(doc, 'p', 'note', job.location.note));
        const actions = make(doc, 'div', 'actions');
        const preview = makeButton(doc, 'secondary', '在 MarkFlow 中预览', () => handlers.onPreviewPart(null));
        preview.disabled = job.result.parts.length === 0;
        actions.appendChild(makeButton(doc, 'secondary', '在访达中显示', handlers.onReveal));
        actions.appendChild(preview);
        card.appendChild(actions);
        return card;
    }

    function createView(doc) {
        const byId = (id) => doc.getElementById(id);

        function showProgress(label, value) {
            byId('progress').hidden = false;
            byId('progress-label').textContent = label;
            if (value === null) byId('progress-bar').removeAttribute('value');
            else byId('progress-bar').value = value;
        }

        function showError(message, { retry = false } = {}) {
            byId('progress').hidden = true;
            byId('error').hidden = false;
            byId('error-text').textContent = message;
            byId('retry').hidden = !retry;
        }

        function clearTransient() {
            byId('error').hidden = true;
            byId('progress').hidden = true;
        }

        function showResult(job, handlers) {
            clearTransient();
            const blocking = job.result.precheck && Array.isArray(job.result.precheck.blocking) ? job.result.precheck.blocking : [];
            const cards = [
                titleCard(doc, job.result), blockingCard(doc, blocking), partsCard(doc, job.result, handlers.onPreviewPart),
                warningsCard(doc, job.result, blocking), outputCard(doc, job, handlers),
            ];
            const host = byId('result');
            host.textContent = '';
            for (const card of cards.filter(Boolean)) host.appendChild(card);
            host.hidden = false;
        }

        return {
            showProgress, showError, clearTransient, showResult,
            setService: (state, text) => { byId('service-state').dataset.state = state; byId('service-state').textContent = text; },
            setDocName: (text) => { byId('doc-name').textContent = text; },
            setFooter: (text) => { byId('footer').textContent = text; },
            setBusy: (busy) => { byId('convert').disabled = busy; },
            hideResult: () => { byId('result').hidden = true; },
            onConvert: (fn) => byId('convert').addEventListener('click', fn),
            onRetry: (fn) => byId('retry').addEventListener('click', fn),
            applyTheme: (dark) => { doc.documentElement.dataset.theme = dark ? 'dark' : 'light'; },
        };
    }

    // ============================================================
    // 启动与主流程
    // ============================================================

    const metaOf = (doc, name) => {
        const node = doc.querySelector(`meta[name="${name}"]`);
        const value = node ? String(node.getAttribute('content') || '') : '';
        return PLACEHOLDER_RE.test(value) ? '' : value;
    };

    function readDocumentUrl(office) {
        try {
            const url = office.context.document.url;
            return typeof url === 'string' ? url : '';
        } catch (err) {
            return '';
        }
    }

    function applyOfficeTheme(office, view) {
        try {
            const theme = office.context.officeTheme;
            if (theme && typeof theme.isDarkTheme === 'boolean') view.applyTheme(theme.isDarkTheme);
        } catch (err) { /* 取不到主题就沿用系统深浅色 */ }
    }

    /** 主流程的状态与三个动作（probe / convert / act）；office、视图、客户端与计时全部注入，便于脱离 Word 验证 */
    function createFlow({ office, view, client, settings, sleep, now }) {
        const state = { ready: false, running: false, locked: false };
        const refreshButton = () => view.setBusy(!state.ready || state.running || state.locked);

        function fail(err) {
            const code = err && err.code;
            if (code === 'unauthorized' || code === 'version-mismatch' || code === 'page-broken') state.locked = true;
            if (code === 'service-down') {
                state.ready = false;
                view.setService('error', '未连接');
            }
            view.showError(err instanceof PaneError ? err.message : `出现意外错误：${err && err.message ? err.message : String(err)}`, { retry: RETRYABLE_CODES.includes(code) });
            refreshButton();
        }

        async function probe() {
            view.clearTransient();
            view.setService('pending', '连接中…');
            try {
                if (!settings.token) throw new PaneError('page-broken', MESSAGES.pageBroken);
                const health = await client.health();
                if (settings.version && health.version && health.version !== settings.version) {
                    throw new PaneError('version-mismatch', `MarkFlow 已更新（页面 ${settings.version}，服务 ${health.version}）。请关闭本任务窗格后重新打开。`);
                }
                state.ready = true;
                view.setService('ok', `已连接 ${health.version || ''}`.trim());
                view.setFooter('转换在本机完成，文档不会上传到任何外部服务。');
            } catch (err) {
                fail(err);
            }
            refreshButton();
        }

        /** 结果区按钮的动作：失败只提示，不清掉已经显示的结果 */
        const act = (task) => task().then(() => view.clearTransient(), fail);

        async function runJob() {
            const url = readDocumentUrl(office);
            view.setDocName(displayNameOf(url));
            view.showProgress('正在读取文档…', 0);
            const bytes = await readDocument(office, {
                maxBytes: settings.maxBytes,
                onProgress: (done, total) => view.showProgress(`正在读取文档（第 ${done}/${total} 片）`, Math.round((done / total) * 100)),
            });
            view.showProgress(`正在上传到 MarkFlow（${formatSize(bytes.length)}）…`, null);
            const created = await client.createJob(bytes, { fileName: url ? displayNameOf(url) : '', sourcePath: url });
            const job = await waitForJob(client, created.id, {
                sleep, now,
                onUpdate: (snapshot) => { const progress = describeProgress(snapshot); view.showProgress(progress.label, progress.value); },
            });
            view.showResult(job, { onReveal: () => act(() => client.reveal(job.id)), onPreviewPart: (part) => act(() => client.preview(job.id, part)) });
        }

        async function convert() {
            if (state.running || !state.ready || state.locked) return;
            state.running = true;
            refreshButton();
            view.clearTransient();
            view.hideResult();
            try {
                await runJob();
            } catch (err) {
                fail(err);
            } finally {
                state.running = false;
                refreshButton();
            }
        }

        return { probe, convert };
    }

    function boot(office, doc, deps = {}) {
        const view = createView(doc);
        const settings = { token: metaOf(doc, 'markflow-token'), version: metaOf(doc, 'markflow-version'), maxBytes: Number(metaOf(doc, 'markflow-max-bytes')) || Infinity };
        const flow = createFlow({
            office, view, settings,
            client: createClient({ fetchImpl: deps.fetchImpl || root.fetch.bind(root), token: settings.token }),
            sleep: deps.sleep || ((ms) => new Promise((resolve) => { root.setTimeout(resolve, ms); })),
            now: deps.now || (() => Date.now()),
        });
        view.onConvert(flow.convert);
        view.onRetry(flow.probe);
        return office.onReady((info) => {
            applyOfficeTheme(office, view);
            view.setDocName(displayNameOf(readDocumentUrl(office)));
            if (info && info.host === office.HostType.Word) return flow.probe();
            view.setService('error', '不在 Word 中');
            view.showError(MESSAGES.notWord);
            return undefined;
        });
    }

    const api = {
        boot, groupWarnings, displayNameOf, formatSize, describeValidation, describeProgress,
        readDocument, collectSlices, createClient, waitForJob, PaneError, SLICE_SIZE, MESSAGES,
    };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
        return;
    }
    root.MarkFlowTaskpane = api;
    if (root.Office && root.document) boot(root.Office, root.document);
    else if (root.document) createView(root.document).showError(MESSAGES.officeMissing);
}(typeof window !== 'undefined' ? window : globalThis));
