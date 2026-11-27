'use strict';

// 从 server/index.js 抽出：摄像头 / 屏幕状态读取与配置修改路由。
// 依赖经 ctx 注入，避免反向 require index.js 造成循环依赖。

function registerCaptureRoutes(app, ctx) {
    const { serverError, cameraModule, screenModule } = ctx;

    // 摄像头面板：读状态（开关 / 最小间隔 / 上次抓拍 / 前端是否连着）
    app.get('/api/camera', (req, res) => {
        res.json({ success: true, camera: cameraModule.getStatus() });
    });

    // 摄像头面板：伪开发者改开关与抓拍最小间隔（分钟，0 表示不节流）
    app.post('/api/camera', (req, res) => {
        try {
            const { enabled, minIntervalMinutes } = req.body || {};
            const patch = {};
            if (typeof enabled === 'boolean') patch.enabled = enabled;
            if (minIntervalMinutes !== undefined) patch.minIntervalMinutes = minIntervalMinutes;
            cameraModule.updateConfig(patch);
            res.json({ success: true, camera: cameraModule.getStatus() });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 屏幕面板：读状态（开关 / 最小间隔 / 上次抓屏 / 前端是否连着）
    app.get('/api/screen', (req, res) => {
        res.json({ success: true, screen: screenModule.getStatus() });
    });

    // 屏幕面板：伪开发者改开关与抓屏最小间隔（分钟，0 表示不节流）
    app.post('/api/screen', (req, res) => {
        try {
            const { enabled, minIntervalMinutes } = req.body || {};
            const patch = {};
            if (typeof enabled === 'boolean') patch.enabled = enabled;
            if (minIntervalMinutes !== undefined) patch.minIntervalMinutes = minIntervalMinutes;
            screenModule.updateConfig(patch);
            res.json({ success: true, screen: screenModule.getStatus() });
        } catch (error) {
            serverError(res, error);
        }
    });
}

module.exports = registerCaptureRoutes;
