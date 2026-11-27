'use strict';

// 从 server/index.js 抽出：AI 配置读取/改名/切换与进程管理路由。
// 依赖经 ctx 注入，避免反向 require index.js 造成循环依赖。

function registerAiConfigRoutes(app, ctx) {
    const {
        requireHost,
        serverError,
        inputModule,
        outputModule,
        systemNarrator,
        processManager,
        saveApiNames
    } = ctx;

    app.get('/api/ai/config', (req, res) => {
        res.json({
            currentAPI: inputModule.getCurrentAPI(),
            currentAPIName: inputModule.getCurrentAPIName(),
            configs: inputModule.getAPIConfig()
        });
    });

    // 自定义 API 卡片名称（仅改显示名，地址/密钥/模型仍来自 .env）
    app.post('/api/ai/rename', requireHost, (req, res) => {
        const { key, name } = req.body || {};
        const target = global.API_CONFIG[key];

        if (!target || typeof target !== 'object') {
            return res.status(400).json({ success: false, message: '无效的API标识' });
        }

        const trimmed = typeof name === 'string' ? name.trim() : '';
        if (!trimmed) {
            return res.status(400).json({ success: false, message: '名称不能为空' });
        }
        if (trimmed.length > 40) {
            return res.status(400).json({ success: false, message: '名称过长（最多40字）' });
        }

        target.name = trimmed;
        saveApiNames();
        console.log(`API名称已修改: ${key} -> ${trimmed}`);
        res.json({ success: true, key: key, name: trimmed });
    });

    app.post('/api/ai/switch', requireHost, (req, res) => {
        const { apiName } = req.body;
        const success = inputModule.switchAPI(apiName);

        if (success) {
            outputModule.switchAPI(apiName);
            systemNarrator.switchAPI(apiName);
            console.log(`API已切换到: ${inputModule.getCurrentAPIName()}`);
            res.json({ success: true, currentAPI: apiName, currentAPIName: inputModule.getCurrentAPIName() });
        } else {
            res.status(400).json({ success: false, message: '无效的API名称' });
        }
    });

    app.post('/api/process/start/server', requireHost, async (req, res) => {
        try {
            const result = await processManager.startServer();
            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/process/stop/server', requireHost, async (req, res) => {
        try {
            const result = await processManager.stopServer();
            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });

    app.get('/api/process/status', (req, res) => {
        res.json(processManager.getStatus());
    });
}

module.exports = registerAiConfigRoutes;
