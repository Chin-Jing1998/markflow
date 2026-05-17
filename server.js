const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const wordConverter = require('./converters/legacy/word');
const urlConverter = require('./converters/legacy/url');
const textConverter = require('./converters/legacy/text');

// 新通用转换调度 + SSE 任务管理
const converter = require('./converters');
const jobs = require('./server/jobs');
const pdfRenderer = require('./converters/renderers/pdf');
const soffice = require('./server/soffice');
const { decodeUtf8Filename } = require('./converters/ir/util');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// 中间件
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(__dirname)); // 服务前端静态文件

// 文件上传配置 —— 旧 Word 端点专用（仅 .docx）
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            cb(null, true);
        } else {
            cb(new Error('仅支持 .docx 格式的 Word 文件'));
        }
    }
});

// 新统一上传配置 —— /api/convert 用，接受任意类型，按扩展名在调度器中分发
const uploadAny = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB（PPTX/PDF 可能更大）
});
// 判断是否在 Electron 打包环境中运行（asar 内无法写入文件）
const isPackaged = __dirname.includes('app.asar');

// 获取应用根目录（兼容 asar 打包）
const appRoot = isPackaged
    ? path.join(__dirname.replace('app.asar', 'app.asar.unpacked'))
    : __dirname;

// 输出根目录：打包后默认保存到用户文档目录
let outputDir = isPackaged
    ? path.join(require('os').homedir(), 'Documents', 'MarkFlow')
    : path.join(__dirname, 'output');

if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// 动态静态文件服务：让浏览器预览能加载 output 目录中的图片
// 使用自定义中间件而非 express.static，因为 outputDir 可被动态修改
app.use('/output-files', (req, res, next) => {
    const filePath = path.join(outputDir, decodeURIComponent(req.path));
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('文件未找到');
    }
});

/**
 * 获取当前生效的输出目录（支持 API 传入自定义路径覆盖默认值）
 */
function getOutputDir(customDir) {
    if (customDir && customDir.trim()) {
        const dir = customDir.trim();
        // 确保目录存在
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        return dir;
    }
    return outputDir;
}

/**
 * API: 获取当前输出路径
 * GET /api/settings/output-dir
 */
app.get('/api/settings/output-dir', (req, res) => {
    res.json({ success: true, outputDir });
});

/**
 * API: 修改输出路径
 * POST /api/settings/output-dir
 */
app.post('/api/settings/output-dir', (req, res) => {
    try {
        const { dir } = req.body;
        if (!dir || !dir.trim()) {
            return res.status(400).json({ success: false, error: '路径不能为空' });
        }

        const newDir = path.resolve(dir.trim());

        // 验证路径合法性：尝试创建目录
        if (!fs.existsSync(newDir)) {
            fs.mkdirSync(newDir, { recursive: true });
        }

        // 验证路径可写
        const testFile = path.join(newDir, '.markflow_test');
        fs.writeFileSync(testFile, '', 'utf8');
        fs.unlinkSync(testFile);

        outputDir = newDir;
        console.log(`  📂  输出目录已更新: ${outputDir}`);
        res.json({ success: true, outputDir });
    } catch (err) {
        console.error('设置输出路径失败:', err);
        res.status(400).json({ success: false, error: `路径无效或无写入权限：${err.message}` });
    }
});

/**
 * API: 转换 Word 文件
 * POST /api/convert/word
 */
app.post('/api/convert/word', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: '未上传文件' });
        }
        // multer (busboy) 默认以 latin1 解析文件名，中文会乱码
        // 需要将 latin1 字节还原为 utf8
        const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
        const dir = getOutputDir(req.body.outputDir);
        const result = await wordConverter.convert(req.file.buffer, originalName, dir);
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('Word 转换失败:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * API: 转换 URL 文章
 * POST /api/convert/url
 */
app.post('/api/convert/url', async (req, res) => {
    try {
        const { url, outputDir: customDir } = req.body;
        if (!url) {
            return res.status(400).json({ success: false, error: '请提供文章链接' });
        }
        const dir = getOutputDir(customDir);
        const result = await urlConverter.convert(url, dir);
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('URL 转换失败:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * API: 转换粘贴文本
 * POST /api/convert/text
 */
app.post('/api/convert/text', async (req, res) => {
    try {
        const { text, title, outputDir: customDir } = req.body;
        if (!text) {
            return res.status(400).json({ success: false, error: '请提供文本内容' });
        }
        const dir = getOutputDir(customDir);
        const result = await textConverter.convert(text, title, dir);
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('文本转换失败:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * API: 保存编辑后的 Markdown
 * POST /api/save
 */
app.post('/api/save', async (req, res) => {
    try {
        const { markdown, folderName, outputDir: customDir } = req.body;
        if (!markdown || !folderName) {
            return res.status(400).json({ success: false, error: '缺少参数' });
        }
        const dir = getOutputDir(customDir);
        const outputFolder = path.join(dir, folderName);
        if (!fs.existsSync(outputFolder)) {
            fs.mkdirSync(outputFolder, { recursive: true });
        }
        const mdPath = path.join(outputFolder, `${folderName}.md`);
        fs.writeFileSync(mdPath, markdown, 'utf8');
        res.json({ success: true, message: '保存成功', path: mdPath });
    } catch (err) {
        console.error('保存失败:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 新统一转换 API（P0 起步，与旧端点并存，零回归）
// ============================================================

/**
 * 能力矩阵 + 平台依赖探测结果
 * GET /api/formats
 */
app.get('/api/formats', (req, res) => {
    res.json({
        success: true,
        ...converter.getCapabilities({
            sofficeAvailable: soffice.isAvailable(),
            electronPrintToPdf: pdfRenderer.isAvailable(),
        }),
        sofficeHint: soffice.isAvailable() ? null : soffice.getInstallHint(),
    });
});

/**
 * 统一转换入口
 * POST /api/convert
 *
 * multipart/form-data：
 *   files[]   多个文件
 *   manifest  JSON.stringify({ items:[{idx,inputType,outputFormat,options?}], commonOutputDir })
 *
 * application/json：
 *   { items:[{idx,inputType,outputFormat,source,options?}], commonOutputDir }
 *
 * 立即返回 { jobId }，转换异步推进；客户端通过 SSE 订阅进度。
 */
app.post(
    '/api/convert',
    (req, res, next) => {
        const ct = (req.headers['content-type'] || '').toLowerCase();
        if (ct.startsWith('multipart/form-data')) {
            uploadAny.array('files', 50)(req, res, next);
        } else {
            next();
        }
    },
    async (req, res) => {
        try {
            let items;
            let commonOutputDir;

            if (req.files && req.files.length > 0) {
                // multipart 模式
                const manifestStr = req.body && req.body.manifest;
                if (!manifestStr) {
                    return res.status(400).json({ success: false, error: '缺少 manifest 字段' });
                }
                let manifest;
                try {
                    manifest = JSON.parse(manifestStr);
                } catch (e) {
                    return res.status(400).json({ success: false, error: 'manifest JSON 解析失败' });
                }
                if (!manifest || !Array.isArray(manifest.items)) {
                    return res.status(400).json({ success: false, error: 'manifest.items 必须是数组' });
                }
                items = manifest.items.map((it) => {
                    const file = req.files[it.idx];
                    return {
                        ...it,
                        name: file ? decodeUtf8Filename(file.originalname) : it.name,
                        source: file ? file.buffer : it.source,
                        file: file || null,
                    };
                });
                commonOutputDir = manifest.commonOutputDir;
            } else {
                // JSON 模式
                const body = req.body || {};
                if (!Array.isArray(body.items)) {
                    return res.status(400).json({ success: false, error: '缺少 items 数组' });
                }
                items = body.items;
                commonOutputDir = body.commonOutputDir;
            }

            const dir = getOutputDir(commonOutputDir);
            const job = jobs.createJob(items);

            // 异步执行，立即返回 jobId，进度通过 SSE 推送
            jobs.runJob(
                job.id,
                async (item, reportProgress) => {
                    return converter.convert({
                        inputType: item.inputType,
                        outputFormat: item.outputFormat,
                        source: item.source,
                        name: item.name,
                        options: item.options || {},
                        outputDir: dir,
                        reportProgress,
                    });
                },
                { concurrency: 2 },
            ).catch((err) => {
                console.error(`Job ${job.id} 运行异常:`, err);
            });

            res.json({
                success: true,
                jobId: job.id,
                items: job.items.map((it) => ({ idx: it.idx, status: it.status })),
            });
        } catch (err) {
            console.error('/api/convert 失败:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    },
);

/**
 * 任务状态轮询（SSE 兜底）
 * GET /api/jobs/:id
 */
app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.getJob(req.params.id);
    if (!job) {
        return res.status(404).json({ success: false, error: '任务不存在或已过期' });
    }
    res.json({
        success: true,
        jobId: job.id,
        status: job.status,
        items: job.items.map((it) => ({
            idx: it.idx,
            status: it.status,
            result: it.result,
            error: it.error,
        })),
        summary: job.summary,
    });
});

/**
 * 任务进度 SSE 流
 * GET /api/jobs/:id/events
 */
app.get('/api/jobs/:id/events', (req, res) => {
    jobs.subscribe(req.params.id, res);
});

/**
 * 编辑后跨格式导出
 * POST /api/export
 * body: { content, sourceFormat, targetFormat, folderName, outputDir? }
 *   - content: 当前编辑器内容（md/html/json 字符串）
 *   - sourceFormat: 'md' | 'html' | 'json'
 *   - targetFormat: 任意 renderer 支持的格式
 *   - folderName: 复用之前转换的文件夹名（避免重算导致写到别处）
 */
app.post('/api/export', async (req, res) => {
    try {
        const {
            content,
            sourceFormat,
            targetFormat,
            folderName,
            outputDir: customDir,
        } = req.body || {};

        if (!content || !sourceFormat || !targetFormat || !folderName) {
            return res.status(400).json({
                success: false,
                error: '缺少必要参数：content/sourceFormat/targetFormat/folderName',
            });
        }

        const reg = converter._registry;
        const parser = reg.parsers[sourceFormat];
        const renderer = reg.renderers[targetFormat];
        if (!parser) {
            return res.status(400).json({
                success: false,
                error: `不支持的源格式: ${sourceFormat}`,
            });
        }
        if (!renderer) {
            return res.status(400).json({
                success: false,
                error: `不支持的目标格式: ${targetFormat}`,
            });
        }

        const dir = getOutputDir(customDir);
        const outputFolder = path.join(dir, folderName);
        fs.mkdirSync(outputFolder, { recursive: true });

        // 解析（md/html/json 三类源格式的 parser 不需要 outputDir，但传上无害）
        const doc = await parser.parse(content, {
            outputDir: dir,
            sourceName: folderName,
        });
        doc.meta = { ...(doc.meta || {}), folderName };

        const output = await renderer.render(doc);

        const { writeOutputFile } = require('./converters/ir/util');
        const outputPath = writeOutputFile(
            outputFolder,
            folderName,
            targetFormat,
            output,
        );

        res.json({
            success: true,
            path: outputPath,
            filename: path.basename(outputPath),
            folderName,
            format: targetFormat,
        });
    } catch (err) {
        console.error('/api/export 失败:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 启动服务（支持 Electron 嵌入和独立运行两种模式）
function startServer(port = PORT) {
    return new Promise((resolve) => {
        const server = app.listen(port, () => {
            console.log(`\n  MarkFlow 服务已启动`);
            console.log(`  🌐  http://localhost:${port}`);
            console.log(`  📂  输出目录: ${outputDir}\n`);
            resolve(server);
        });
    });
}

// 导出供 Electron 主进程使用
module.exports = { app, startServer, getOutputDir };

// 如果直接运行（非 Electron），自动启动
if (require.main === module) {
    startServer();
}
