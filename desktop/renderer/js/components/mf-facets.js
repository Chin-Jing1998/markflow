/**
 * <mf-facets>：文件库分面侧栏。property data = { facets, selected }；
 * 点击派发 'mf-facet-change'（detail: { key, value }，value 为 null 表示清除该分面）。
 */
import { escapeHtml, escapeAttr, targetLabel, typeLabel } from '../dom.js';

const GROUPS = Object.freeze([
    { key: 'sourceType', label: '来源类型', format: typeLabel },
    { key: 'target', label: '目标', format: targetLabel },
    { key: 'month', label: '月份', format: (value) => value },
    { key: 'sourceDir', label: '来源目录', format: (value) => value },
    { key: 'tag', label: '标签', format: (value) => value },
    { key: 'favorite', label: '收藏', format: (value) => (value === true || value === 'true' ? '已收藏' : '未收藏') },
]);
const MAX_ITEMS = 12;

class MfFacets extends HTMLElement {
    constructor() {
        super();
        this._facets = null;
        this._selected = {};
    }

    set data({ facets, selected } = {}) {
        this._facets = facets || null;
        this._selected = selected || {};
        this.render();
    }

    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.addEventListener('click', (event) => {
            const button = event.target instanceof Element ? event.target.closest('button[data-key]') : null;
            if (!button) return;
            const { key } = button.dataset;
            const raw = button.dataset.value;
            const value = key === 'favorite' ? raw === 'true' : raw;
            const active = button.classList.contains('is-active');
            this.dispatchEvent(new CustomEvent('mf-facet-change', { detail: { key, value: active ? null : value }, bubbles: true }));
        });
        this.render();
    }

    render() {
        if (!this._facets) {
            this.innerHTML = '<div class="facets-empty">暂无记录</div>';
            return;
        }
        const groups = GROUPS.map(({ key, label, format }) => {
            const entries = Array.isArray(this._facets[key]) ? this._facets[key].slice(0, MAX_ITEMS) : [];
            if (entries.length === 0) return '';
            const selected = this._selected[key];
            const items = entries.map(({ value, count }) => {
                const active = selected !== undefined && selected !== null && String(selected) === String(value);
                return `<button class="facet${active ? ' is-active' : ''}" type="button" data-key="${key}" data-value="${escapeAttr(value)}" title="${escapeAttr(value)}">
                    <span class="facet-label">${escapeHtml(format(value))}</span><span class="facet-count">${count}</span></button>`;
            }).join('');
            return `<section class="facet-group"><h4>${label}</h4>${items}</section>`;
        }).join('');
        this.innerHTML = groups || '<div class="facets-empty">暂无记录</div>';
    }
}

customElements.define('mf-facets', MfFacets);
