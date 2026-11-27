'use strict';

// 取景器：参考界面采集（windows-mcp sidecar）→ 比例化 spec → 同尺子渲染。
// 全部接口仅限本机（requireHost）；截图只落在 data/design/ 下，不进记忆、不外发。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const { McpStdioClient, resolveMcpConfig, collectText } = require('../../core/designMcp');
const {
    buildDesignSpec,
    parsePowerShellReport,
    readPngSize,
    buildWindowProbeScript,
    buildRegionCaptureScript,
} = require('../../core/designCapture');
const { writeJsonAtomicSync } = require('../../storage/atomicWrite');

const DATA_DIR = path.join(__dirname, '../../../data/design');
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_HTML = 512 * 1024;

function ensureDir() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function sendError(res, status, error) {
    const message = error && error.message ? error.message : String(error);
    res.status(status).json({ success: false, message: message.slice(0, 400) });
}

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}

function registerDesignRoutes(app, ctx) {
    const { requireHost } = ctx;

    // sidecar 配置与可用性：前端先看这里，再决定按钮是否可点
    app.get('/api/design/status', requireHost, (req, res) => {
        let config = null;
        let configError = null;
        try {
            config = resolveMcpConfig();
        } catch (error) {
            configError = error.message;
        }
        res.json({
            success: true,
            platform: process.platform,
            enabled: process.platform === 'win32' && !configError,
            command: config ? config.command : null,
            args: config ? config.args : null,
            dataDir: DATA_DIR,
            configError,
        });
    });

    // 采集：量窗口（客户区 + DPI）→ 截参考图 → 落 design-spec
    app.post('/api/design/capture', requireHost, async (req, res) => {
        if (process.platform !== 'win32') {
            return sendError(res, 501, new Error('参考界面采集仅支持 Windows'));
        }
        const body = req.body || {};
        const title = String(body.title == null ? '' : body.title).trim().slice(0, 200);
        const processName = String(body.process == null ? '' : body.process).trim().slice(0, 80);
        if (!title && !processName) {
            return sendError(res, 400, new Error('需要 title（窗口标题关键词）或 process（进程名）'));
        }

        let config;
        try {
            config = resolveMcpConfig();
        } catch (error) {
            return sendError(res, 500, error);
        }

        const client = new McpStdioClient({ command: config.command, args: config.args });
        try {
            await client.start();

            const probe = await client.callTool('PowerShell', {
                command: buildWindowProbeScript({ title, process: processName }),
                timeout: 30,
            }, 60000);
            const { data } = parsePowerShellReport(collectText(probe));
            if (!data || !data.found) {
                return sendError(res, 404, new Error('没有找到匹配的窗口，请先把它切到前台或换关键词'));
            }

            const frame = data.contentRect || data.clientRect;
            if (!frame) {
                return sendError(res, 422, new Error('拿到窗口但读不到客户区矩形'));
            }

            const id = crypto.randomUUID();
            ensureDir();
            const pngPath = path.join(DATA_DIR, `${id}.png`);
            // 窗口可能被别的程序挡住，抓屏前先切到前台，再按抓到的真实矩形出图
            const shot = await client.callTool('PowerShell', {
                command: buildRegionCaptureScript({ outFile: pngPath, handle: data.handle }),
                timeout: 30,
            }, 120000);
            const shotInfo = parsePowerShellReport(collectText(shot)).data;
            if (!shotInfo || !shotInfo.saved || !shotInfo.rect) {
                return sendError(res, 502, new Error('参考图采集失败'));
            }

            if (!fs.existsSync(pngPath)) {
                return sendError(res, 502, new Error('参考图没有落盘'));
            }
            const size = readPngSize(fs.readFileSync(pngPath));
            if (!size) {
                return sendError(res, 502, new Error('参考图不是有效的 PNG'));
            }

            const rect = shotInfo.rect;
            const isContent = shotInfo.frameSource === 'content';
            const spec = buildDesignSpec({
                title: data.title,
                process: data.process,
                handle: data.handle,
                dpi: data.dpi,
                dpiAware: data.dpiAware !== false,
                windowRect: data.windowRect,
                clientRect: isContent ? null : rect,
                contentRect: isContent ? rect : null,
                screenshot: {
                    id,
                    width: size.width,
                    height: size.height,
                    originalWidth: Math.round(rect.right - rect.left),
                    originalHeight: Math.round(rect.bottom - rect.top),
                    scale: Math.round((size.width / (rect.right - rect.left)) * 1000) / 1000,
                },
            });
            writeJsonAtomicSync(path.join(DATA_DIR, `${id}.json`), spec);

            res.json({
                success: true,
                id,
                image: `/api/design/image/${id}.png`,
                spec,
            });
        } catch (error) {
            sendError(res, 502, error);
        } finally {
            client.close();
        }
    });

    // 纯换算入口：把一段采集报告（或已落盘的 metrics）重新算成 spec
    app.post('/api/design/spec', requireHost, (req, res) => {
        try {
            const body = req.body || {};
            res.json({ success: true, spec: buildDesignSpec(body.capture || body) });
        } catch (error) {
            sendError(res, 400, error);
        }
    });

    app.get('/api/design/image/:id', requireHost, (req, res) => {
        const id = String(req.params.id || '').replace(/\.png$/i, '');
        if (!ID_RE.test(id)) return sendError(res, 400, new Error('id 非法'));
        const file = path.join(DATA_DIR, `${id}.png`);
        if (!fs.existsSync(file)) return sendError(res, 404, new Error('截图不存在'));
        res.sendFile(file);
    });

    // 尺子 2：用同一个 CSS 视口 + deviceScaleFactor 渲染生成页
    app.post('/api/design/render', requireHost, async (req, res) => {
        let browser = null;
        let tempFile = null;
        try {
            const body = req.body || {};
            const html = typeof body.html === 'string' ? body.html : '';
            let target = String(body.url == null ? '' : body.url).trim();

            if (html) {
                if (html.length > MAX_HTML) return sendError(res, 400, new Error('html 过大'));
                ensureDir();
                tempFile = path.join(DATA_DIR, `render-${crypto.randomUUID()}.html`);
                fs.writeFileSync(tempFile, html, 'utf8');
                target = pathToFileURL(tempFile).href;
            }
            if (!target) return sendError(res, 400, new Error('需要 url 或 html'));
            if (!/^(https?|file):\/\//i.test(target)) {
                if (!path.isAbsolute(target)) return sendError(res, 400, new Error('url 只支持 http(s) 或绝对路径'));
                target = pathToFileURL(target).href;
            }

            const viewport = body.viewport || {};
            const width = clampInt(viewport.width, 320, 3840, 1280);
            const height = clampInt(viewport.height, 240, 2160, 800);
            const dpr = Math.min(4, Math.max(0.5, Number(viewport.dpr) || 1));

            const webCheck = require('../../core/webCheck');
            browser = await webCheck.launchBrowser({ viewport: { width, height } });
            const { cdp } = browser;
            await cdp.send('Page.enable');
            await cdp.send('Runtime.enable');
            await cdp.send('Emulation.setDeviceMetricsOverride', {
                width,
                height,
                deviceScaleFactor: dpr,
                mobile: false,
            });

            const loaded = cdp.waitForEvent('Page.loadEventFired', null, 20000).catch(() => null);
            await cdp.send('Page.navigate', { url: target });
            await loaded;
            await webCheck.sleep(250);

            const shot = await cdp.send('Page.captureScreenshot', {
                format: 'png',
                captureBeyondViewport: false,
            });
            if (!shot || !shot.data) return sendError(res, 502, new Error('渲染截图失败'));

            const id = crypto.randomUUID();
            ensureDir();
            fs.writeFileSync(path.join(DATA_DIR, `${id}.png`), Buffer.from(shot.data, 'base64'));

            res.json({
                success: true,
                id,
                image: `/api/design/image/${id}.png`,
                viewport: { width, height, dpr },
            });
        } catch (error) {
            sendError(res, 502, error);
        } finally {
            if (browser) {
                try {
                    browser.close();
                } catch {
                    /* 忽略 */
                }
            }
            if (tempFile) {
                try {
                    fs.unlinkSync(tempFile);
                } catch {
                    /* 忽略 */
                }
            }
        }
    });
}

module.exports = registerDesignRoutes;
