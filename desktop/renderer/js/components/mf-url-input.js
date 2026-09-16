/**
 * <mf-url-input>：网页链接输入（每行一个，支持批量）。
 * 「添加到任务」时经 url-lines.mjs 解析：合法行以 CustomEvent 'mf-urls'（detail: { urls, duplicates }）冒泡给转换页，
 * 非法行留在文本框内并在下方以中文逐行提示，不阻断其余行。
 */
import { parseUrlLines } from '../url-lines.mjs';
import { escapeHtml } from '../dom.js';
import { icon } from '../icons.js';

const PLACEHOLDER = 'https://mp.weixin.qq.com/s/...\nhttps://zhuanlan.zhihu.com/p/...\n支持微信公众号、知乎、CSDN 等';
const MAX_ERROR_LINES = 8;

class MfUrlInput extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.innerHTML = `
            <div class="url-input">
                <label class="url-input-label" for="mf-url-textarea">文章链接 <span class="hint">（每行一个，支持批量）</span></label>
                <textarea id="mf-url-textarea" class="url-textarea" rows="4" spellcheck="false" placeholder="${escapeHtml(PLACEHOLDER)}"></textarea>
                <div class="url-input-row">
                    <div class="url-errors" data-role="errors" hidden></div>
                    <button class="btn btn-secondary btn-small" type="button" data-action="add">${icon('link')}添加到任务</button>
                </div>
            </div>`;
        this.textarea = this.querySelector('textarea');
        this.querySelector('[data-action="add"]').addEventListener('click', () => this.submit());
        this.textarea.addEventListener('keydown', (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                this.submit();
            }
        });
    }

    submit() {
        const { urls, invalid, duplicates, total } = parseUrlLines(this.textarea.value);
        this.renderErrors(invalid, total);
        if (urls.length > 0) this.dispatchEvent(new CustomEvent('mf-urls', { detail: { urls, duplicates }, bubbles: true }));
        // 合法行已进入任务列表，文本框只保留待修正的非法行
        this.textarea.value = invalid.map((item) => item.text).join('\n');
    }

    renderErrors(invalid, total) {
        const box = this.querySelector('[data-role="errors"]');
        if (total === 0) {
            box.hidden = false;
            box.innerHTML = '<span class="url-error-line">请先粘贴至少一条 http/https 链接</span>';
            return;
        }
        if (invalid.length === 0) {
            box.hidden = true;
            box.innerHTML = '';
            return;
        }
        const lines = invalid.slice(0, MAX_ERROR_LINES).map((item) =>
            `<span class="url-error-line">第 ${item.line} 行：${escapeHtml(item.reason)}<code>${escapeHtml(item.text.length > 80 ? `${item.text.slice(0, 77)}…` : item.text)}</code></span>`);
        if (invalid.length > MAX_ERROR_LINES) lines.push(`<span class="url-error-line">…另有 ${invalid.length - MAX_ERROR_LINES} 行未通过</span>`);
        box.hidden = false;
        box.innerHTML = `<span class="url-error-title">${invalid.length} 行未加入（已保留在文本框中）</span>${lines.join('')}`;
    }
}

customElements.define('mf-url-input', MfUrlInput);
