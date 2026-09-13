/**
 * <mf-progress value="42" label="解析中" state="running">：单任务进度条。
 */
import { escapeHtml } from '../dom.js';

const clampPct = (value) => Math.max(0, Math.min(100, Number(value) || 0));

class MfProgress extends HTMLElement {
    static get observedAttributes() { return ['value', 'label', 'state']; }

    connectedCallback() {
        if (!this.querySelector('.progress-bar')) {
            this.innerHTML = '<div class="progress-bar"><div class="progress-fill"></div></div><span class="progress-text"></span>';
        }
        this.render();
    }

    attributeChangedCallback() {
        if (this.isConnected) this.render();
    }

    render() {
        const fill = this.querySelector('.progress-fill');
        const text = this.querySelector('.progress-text');
        if (!fill || !text) return;
        const pct = clampPct(this.getAttribute('value'));
        fill.style.width = `${pct}%`;
        const label = this.getAttribute('label') || '';
        text.textContent = label ? `${label} ${Math.round(pct)}%` : `${Math.round(pct)}%`;
        this.dataset.state = this.getAttribute('state') || 'running';
        this.setAttribute('role', 'progressbar');
        this.setAttribute('aria-valuenow', String(Math.round(pct)));
        this.setAttribute('aria-valuemin', '0');
        this.setAttribute('aria-valuemax', '100');
        this.setAttribute('aria-label', escapeHtml(label));
    }
}

customElements.define('mf-progress', MfProgress);
