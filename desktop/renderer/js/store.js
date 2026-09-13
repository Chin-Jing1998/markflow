/**
 * 极简可观察状态容器：state 不可变（每次 set 产生新对象），subscribe 返回取消函数。
 *
 * 全局 store 字段：
 *   route            当前路由：convert | library | settings | reader | preview
 *   theme            用户设置的主题：system | light | dark
 *   isDark           主进程 nativeTheme.shouldUseDarkColors
 *   formats          mf:formats:describe 的回包（targets / capabilities / options / inProcess）
 *   settings         mf:settings:get 的回包（settings / mineruTokenConfigured / encryptionAvailable / paths）
 *   tasks            转换页任务列表 [{ id, path|url, name, type, size, target, status, phase, pct, error, result, libraryId, runId }]
 *   run              进行中的批次 { runId, outputDir } | null
 *   libraryVersion   文件库变更计数（转换完成后 +1，文件库页据此刷新）
 *   preview          对比预览会话 { sessionId, source, type, name, title, target, options, live,
 *                                  sourceView, product, warnings, backends } | null
 *   previewBusy      预览正在解析 / 渲染 / 导出（界面据此禁用按钮并显示进度条）
 *   previewError     预览最近一次失败的中文文案 | ''
 *   reader           阅读会话 { sessionId, kind, name, path, view, warnings } | null
 *   readerBusy       阅读正在打开
 *   readerError      阅读最近一次失败的中文文案 | ''
 */
export function createStore(initial = {}) {
    let state = Object.freeze({ ...initial });
    const listeners = new Set();
    return {
        get: () => state,
        set(patch) {
            const next = typeof patch === 'function' ? patch(state) : patch;
            if (!next) return state;
            state = Object.freeze({ ...state, ...next });
            for (const listener of listeners) listener(state);
            return state;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

export const store = createStore({
    route: 'convert',
    theme: 'system',
    isDark: false,
    formats: null,
    settings: null,
    tasks: [],
    run: null,
    libraryVersion: 0,
    preview: null,
    previewBusy: false,
    previewError: '',
    reader: null,
    readerBusy: false,
    readerError: '',
});

// ---------- 任务列表操作（转换页与文件库页共用） ----------

export function addTasks(entries) {
    store.set((state) => {
        const existing = new Set(state.tasks.map((task) => task.path || task.url));
        const fresh = entries.filter((entry) => !existing.has(entry.path || entry.url)).map((entry) => ({
            status: 'idle', phase: '', pct: 0, error: '', result: null, libraryId: null, runId: null, ...entry,
        }));
        return fresh.length > 0 ? { tasks: [...state.tasks, ...fresh] } : null;
    });
}

export function updateTask(id, patch) {
    store.set((state) => {
        const index = state.tasks.findIndex((task) => task.id === id);
        if (index === -1) return null;
        const next = { ...state.tasks[index], ...patch };
        return { tasks: [...state.tasks.slice(0, index), next, ...state.tasks.slice(index + 1)] };
    });
}

export function removeTask(id) {
    store.set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) }));
}

export function clearTasks(predicate = () => true) {
    store.set((state) => ({ tasks: state.tasks.filter((task) => !predicate(task)) }));
}
