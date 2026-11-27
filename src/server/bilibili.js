'use strict';

// B站直播 + TTS 路由（从 server/index.js 抽出）
// 依赖经 ctx 注入，调用点与原文件保持一致；本文件与 index.js 同在 src/server，
// 故 __dirname 相对路径（../../assets/...）解析结果不变。
const path = require('path');
const fs = require('fs');

function registerBilibiliRoutes(app, ctx) {
    const { requireHost, requireAdmin, serverError, biliLiveConfig, biliBridge, ttsModule } = ctx;

    // ==================== B站直播接口 ====================
    // 弹幕源的三种取值：mock（本地假弹幕）/ unofficial（需 SESSDATA）/ official（需开放平台四要素）。
    // 什么都不配时自动落到 mock，靠 POST /api/bili/test-danmaku 把整条链路跑通。
    app.get('/api/bili/config', requireAdmin, (req, res) => {
        res.json({ success: true, config: biliLiveConfig.getMasked() });
    });

    app.post('/api/bili/config', requireAdmin, (req, res) => {
        try {
            const config = biliLiveConfig.update(req.body || {});
            // 角色名与是否语音是开播时缓存的，改完同步刷新，不必重启
            biliBridge.roleName = config.roleName;
            biliBridge.autoSpeak = config.autoSpeak;
            biliBridge.applyRoleToSessions();
            res.json({ success: true, config });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.delete('/api/bili/config', requireAdmin, (req, res) => {
        res.json({ success: true, config: biliLiveConfig.reset() });
    });

    app.post('/api/bili/live/start', requireAdmin, async (req, res) => {
        try {
            const result = await biliBridge.start();
            res.json({ success: result.ok, message: result.message, status: biliBridge.status() });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/bili/live/stop', requireAdmin, async (req, res) => {
        try {
            const result = await biliBridge.stop();
            res.json({ success: result.ok, message: result.message, status: biliBridge.status() });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.get('/api/bili/live/status', requireAdmin, (req, res) => {
        res.json({ success: true, status: biliBridge.status() });
    });

    // 本地喂一条假弹幕（只有 mock 源可用），用来在没有凭证时验证整条链路
    app.post('/api/bili/test-danmaku', requireAdmin, (req, res) => {
        const result = biliBridge.inject(req.body || {});
        res.json({ success: result.ok !== false, ...result });
    });

    // 让角色直接说一句（调试 / 场间垫话）
    app.post('/api/bili/say', requireAdmin, async (req, res) => {
        try {
            const result = await biliBridge.say((req.body || {}).text);
            res.json({ success: result.ok !== false, ...result });
        } catch (error) {
            serverError(res, error);
        }
    });

    // TTS 文本转语音接口
    app.get('/api/tts/voices', (req, res) => {
        const voices = ttsModule.getVoiceList();
        res.json({ success: true, voices });
    });

    app.post('/api/tts/synthesize', requireHost, async (req, res) => {
        try {
            const { text, voice, speed, volume } = req.body;

            if (!text) {
                return res.json({ success: false, message: '请提供要转换的文本' });
            }

            const result = await ttsModule.synthesize(text, { voice, speed, volume });
            res.json(result);
        } catch (error) {
            console.error('[TTS] 合成失败:', error);
            serverError(res, error);
        }
    });

    app.get('/api/tts/audio/:filename', (req, res) => {
        const audioPath = ttsModule.getAudioFile(req.params.filename);

        if (!audioPath) {
            return res.status(404).json({ success: false, message: '音频文件不存在' });
        }

        res.sendFile(audioPath);
    });

    app.delete('/api/tts/audio/:filename', requireHost, (req, res) => {
        const deleted = ttsModule.deleteAudioFile(req.params.filename);
        res.json({ success: deleted });
    });

    // 音色复刻接口 - 自动上传文件
    app.post('/api/tts/clone', requireHost, async (req, res) => {
        try {
            const { voiceName, text } = req.body;

            if (!voiceName) {
                return res.json({ success: false, message: '请提供音色名称' });
            }

            // 使用用户上传的音频文件
            const audioFilePath = path.join(__dirname, '../../assets/20260619_114859.m4a');

            if (!fs.existsSync(audioFilePath)) {
                return res.json({ success: false, message: '音频文件不存在，请先上传' });
            }

            const result = await ttsModule.cloneVoiceFromFile(audioFilePath, voiceName, text);
            res.json(result);
        } catch (error) {
            console.error('[TTS] 音色复刻失败:', error);
            serverError(res, error);
        }
    });

    // 音色复刻接口 - 手动提供file_id
    app.post('/api/tts/clone-with-fileid', requireHost, async (req, res) => {
        try {
            const { fileId, voiceName, text } = req.body;

            if (!fileId) {
                return res.json({ success: false, message: '请提供file_id' });
            }
            if (!voiceName) {
                return res.json({ success: false, message: '请提供音色名称' });
            }

            const result = await ttsModule.cloneVoice(fileId, voiceName, text);
            res.json(result);
        } catch (error) {
            console.error('[TTS] 音色复刻失败:', error);
            serverError(res, error);
        }
    });

    // 刷新自定义音色列表
    app.post('/api/tts/refresh-voices', requireHost, async (req, res) => {
        try {
            await ttsModule.loadCustomVoices();
            const voices = ttsModule.getVoiceList();
            res.json({ success: true, voices });
        } catch (error) {
            serverError(res, error);
        }
    });
}

module.exports = registerBilibiliRoutes;
