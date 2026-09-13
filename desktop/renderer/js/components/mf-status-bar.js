/**
 * <mf-status-bar>：内容区顶部的纯标题状态栏，仅显示应用名称。
 */

class MfStatusBar extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.innerHTML = '<span class="status-bar-brand">MarkFlow</span>';
    }
}

customElements.define('mf-status-bar', MfStatusBar);
