/**
 * <mf-dropzone>：拖放 / 浏览文件 / 选择文件夹。
 * 收集到的本地路径经 CustomEvent 'mf-files'（detail: { paths }）冒泡给父组件，由父组件调用 expandPaths 展开。
 */
import { api, pathForFile, isDesktop } from '../api.js';
import { icon } from '../icons.js';
import { notify } from './mf-toast.js';

const SUPPORTED_TEXT = '支持 .docx / .xlsx / .pptx / .pdf / .md，可拖入文件夹；专利五书另收 .xml、案卷 .zip 与五书目录';

class MfDropzone extends HTMLElement {
    connectedCallback() {
        if (this.dataset.ready) return;
        this.dataset.ready = '1';
        this.innerHTML = `
            <div class="dropzone" tabindex="0" role="button" aria-label="拖放文件或点击浏览">
                <div class="dropzone-icon">${icon('upload')}</div>
                <h3>拖拽文件至此</h3>
                <p>${SUPPORTED_TEXT}</p>
                <div class="dropzone-actions">
                    <button class="btn btn-secondary" type="button" data-action="files">${icon('file')}浏览文件</button>
                    <button class="btn btn-secondary" type="button" data-action="folder">${icon('folder')}选择文件夹</button>
                </div>
            </div>`;
        const zone = this.querySelector('.dropzone');
        zone.addEventListener('dragover', (event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
            zone.classList.add('is-dragover');
        });
        zone.addEventListener('dragleave', (event) => {
            if (!zone.contains(event.relatedTarget)) zone.classList.remove('is-dragover');
        });
        zone.addEventListener('drop', (event) => {
            event.preventDefault();
            zone.classList.remove('is-dragover');
            const paths = Array.from(event.dataTransfer.files || []).map(pathForFile).filter(Boolean);
            if (paths.length === 0) {
                notify(isDesktop ? '未能读取拖入项的路径' : '请在 MarkFlow 桌面版中拖入文件', 'warning');
                return;
            }
            this.emit(paths);
        });
        zone.addEventListener('click', (event) => {
            // 区域内任意位置点击都触发选择文件；只有「选择文件夹」按钮本身例外，走文件夹选择
            const folderButton = event.target instanceof Element ? event.target.closest('[data-action="folder"]') : null;
            event.stopPropagation();
            this.pick(Boolean(folderButton));
        });
        zone.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.pick(false);
            }
        });
    }

    async pick(directory) {
        try {
            const result = await api.pickFiles({ directory });
            if (!result.canceled && result.paths.length > 0) this.emit(result.paths);
        } catch (err) {
            notify(err.message, 'error');
        }
    }

    emit(paths) {
        this.dispatchEvent(new CustomEvent('mf-files', { detail: { paths }, bubbles: true }));
    }
}

customElements.define('mf-dropzone', MfDropzone);
