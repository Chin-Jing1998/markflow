/**
 * <mf-toast>：全局轻提示容器。show(message, type, duration)；notify() 为模块级快捷函数。
 */
import { escapeHtml } from '../dom.js';
import { icon } from '../icons.js';

const ICONS = Object.freeze({ success: 'check', error: 'x', warning: 'warning', info: 'info' });
const DEFAULT_DURATION_MS = 3200;
const EXIT_MS = 300;

class MfToast extends HTMLElement {
    show(message, type = 'info', duration = DEFAULT_DURATION_MS) {
        const kind = ICONS[type] ? type : 'info';
        const el = document.createElement('div');
        el.className = `toast toast-${kind}`;
        el.setAttribute('role', 'status');
        el.innerHTML = `${icon(ICONS[kind])}<span>${escapeHtml(message)}</span>`;
        this.append(el);
        requestAnimationFrame(() => el.classList.add('show'));
        setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), EXIT_MS);
        }, duration);
    }
}

customElements.define('mf-toast', MfToast);

export function notify(message, type = 'info', duration) {
    const host = document.querySelector('mf-toast');
    if (host) host.show(message, type, duration);
}
