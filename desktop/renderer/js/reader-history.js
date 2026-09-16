const STORAGE_KEY = 'markflow.reader.open-history';
const MAX_HISTORY = 50;

function normalizeEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const path = typeof entry.path === 'string' ? entry.path.trim() : '';
    if (!path) return null;
    const name = typeof entry.name === 'string' && entry.name.trim()
        ? entry.name.trim()
        : path.split(/[\\/]/).pop() || path;
    return { path, name, favorite: Boolean(entry.favorite) };
}

export function readOpenHistory() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        if (!Array.isArray(saved)) return [];
        const seen = new Set();
        return saved.map(normalizeEntry).filter((entry) => {
            if (!entry || seen.has(entry.path)) return false;
            seen.add(entry.path);
            return true;
        }).slice(0, MAX_HISTORY);
    } catch (err) {
        return [];
    }
}

function writeOpenHistory(history) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch (err) {
        // 本地存储不可用时，调用方仍可使用本次的内存结果。
    }
    return history;
}

export function rememberOpenFile(filePath, fileName = '') {
    const path = String(filePath || '').trim();
    if (!path) return readOpenHistory();
    const history = readOpenHistory();
    const existing = history.find((item) => item.path === path);
    const entry = normalizeEntry({ path, name: fileName, favorite: existing ? existing.favorite : false });
    return writeOpenHistory([entry, ...history.filter((item) => item.path !== path)].slice(0, MAX_HISTORY));
}

/** 收藏状态仅打开记录内本地维护，与文件库记录的收藏字段无关联。 */
export function toggleFavoriteOpenFile(filePath) {
    const path = String(filePath || '').trim();
    if (!path) return readOpenHistory();
    return writeOpenHistory(readOpenHistory().map((item) => (item.path === path ? { ...item, favorite: !item.favorite } : item)));
}
