/**
 * <mf-sidebar>：左标签栏导航（转换 / 文件库 / 知识库 / 预览 / 设置）。路由为 hash（#/convert 等）。
 */
import { store } from '../store.js';
import { icon } from '../icons.js';

const NAV = Object.freeze([
    { route: 'convert', label: '转换', icon: 'convert' },
    { route: 'library', label: '文件库', icon: 'library' },
    { route: 'reader', label: '知识库', icon: 'reader' },
    { route: 'preview', label: '预览', icon: 'preview' },
]);
const FOOT = Object.freeze([{ route: 'settings', label: '设置', icon: 'settings' }]);

const item = ({ route, label, icon: name, pending }) => `
    <a class="nav-item${pending ? ' is-pending' : ''}" href="#/${route}" data-route="${route}" aria-label="${label}" title="${pending ? `${pending}提供` : label}" ${pending ? 'aria-disabled="true"' : ''}>
        ${icon(name)}<span class="nav-label">${label}</span>${pending ? `<em class="nav-badge">${pending}</em>` : ''}
    </a>`;

class MfSidebar extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.innerHTML = `
            <nav class="sidebar-nav" aria-label="主标签栏">${NAV.map(item).join('')}</nav>
            <div class="sidebar-spacer"></div>
            <nav class="sidebar-nav sidebar-foot" aria-label="次标签栏">${FOOT.map(item).join('')}</nav>`;
        this.unsubscribe = store.subscribe((state) => this.sync(state));
        this.sync(store.get());
    }

    disconnectedCallback() {
        if (this.unsubscribe) this.unsubscribe();
    }

    sync(state) {
        for (const link of this.querySelectorAll('.nav-item')) {
            const active = link.dataset.route === state.route;
            link.classList.toggle('is-active', active);
            if (active) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        }
    }
}

customElements.define('mf-sidebar', MfSidebar);
