'use strict';

// 实时视觉上报接口（public/live-vision.html）。
// 浏览器端负责检测，这里只收结构化 track；原图不出本机，服务端也不落盘。
// 状态由 core/liveVision 的单例持有，对话侧只读同一份场景。

const { liveVision } = require('../../core/liveVision');

function registerVisionRoutes(app, ctx = {}) {
    const { serverError, systemNarrator } = ctx;

    // 浏览器每 100ms 左右批量上报一次当前帧的检测结果
    app.post('/api/vision/tracks', (req, res) => {
        try {
            const body = req.body || {};
            // 页面暂停/隐藏：直接清空，别让最后一帧一直「新鲜」着影响对话
            if (body.active === false) {
                liveVision.reset();
                res.json({ success: true, summary: '' });
                return;
            }
            const tracks = Array.isArray(body.tracks) ? body.tracks : [];
            const result = liveVision.ingest(tracks, body.meta || {});

            // 人的进出若值得主动开口，交给自主发言链路；不等待结果，别拖慢 10fps 上报
            if (systemNarrator) {
                const trigger = liveVision.takeInteractionTrigger();
                if (trigger) {
                    Promise.resolve(systemNarrator.notifyVisionEvent(trigger))
                        .catch((error) => console.warn('[实时视觉] 主动开口失败:', error.message));
                }
            }

            res.json({ success: true, summary: result.summary });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 场景快照：调试面板 / 其他页面想看她此刻「看见」什么时读这里
    app.get('/api/vision/scene', (req, res) => {
        try {
            res.json({ success: true, scene: liveVision.snapshot() });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 页面关闭或用户主动关掉时清空场景，避免用旧画面继续影响对话
    app.post('/api/vision/off', (req, res) => {
        try {
            liveVision.reset();
            res.json({ success: true });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 摄像头面板复用：开关实时视觉（关闭即清空当前场景）
    app.post('/api/vision/toggle', (req, res) => {
        try {
            const enabled = Boolean(req.body && req.body.enabled);
            res.json({ success: true, enabled: liveVision.setEnabled(enabled) });
        } catch (error) {
            serverError(res, error);
        }
    });
}

module.exports = registerVisionRoutes;
