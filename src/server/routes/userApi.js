'use strict';

// 从 server/index.js 抽出：用户自定义 API 配置（读取/保存/删除/测试/拉模型列表）路由。
// 依赖经 ctx 注入，避免反向 require index.js 造成循环依赖。

function registerUserApiRoutes(app, ctx) {
    const { requireHost, serverError, authModule, userApiClient } = ctx;

    app.get('/api/user/custom-api', (req, res) => {
        try {
            const sessionId = req.headers['x-session-id'] || req.query.sessionId;
            const session = authModule.validateSession(sessionId);

            if (!session) {
                return res.status(401).json({ success: false, message: '请先登录' });
            }

            const config = authModule.getCustomApiConfig(session.username);
            res.json({ success: true, config: config || null });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/user/custom-api', requireHost, (req, res) => {
        try {
            const sessionId = req.headers['x-session-id'] || req.query.sessionId;
            const session = authModule.validateSession(sessionId);

            if (!session) {
                return res.status(401).json({ success: false, message: '请先登录' });
            }

            const result = authModule.setCustomApiConfig(session.username, req.body);
            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });

    app.delete('/api/user/custom-api', requireHost, (req, res) => {
        try {
            const sessionId = req.headers['x-session-id'] || req.query.sessionId;
            const session = authModule.validateSession(sessionId);

            if (!session) {
                return res.status(401).json({ success: false, message: '请先登录' });
            }

            const result = authModule.removeCustomApiConfig(session.username);
            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/user/custom-api/test', requireHost, (req, res) => {
        try {
            const sessionId = req.headers['x-session-id'] || req.query.sessionId;
            const session = authModule.validateSession(sessionId);

            if (!session) {
                return res.status(401).json({ success: false, message: '请先登录' });
            }

            const config = { ...req.body };
            // 界面上密钥以打码形式展示，用户留空即表示沿用已保存的真实密钥
            if (!config.apiKey) {
                const saved = authModule.getCustomApiConfigRaw(session.username);
                if (saved && saved.apiKey) {
                    config.apiKey = saved.apiKey;
                }
            }
            const result = authModule.validateApiConfig(config);

            if (!result.valid) {
                return res.json({ success: false, message: result.message });
            }

            userApiClient.testApi(config).then(testResult => {
                res.json(testResult);
            }).catch(error => {
                serverError(res, error);
            });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 浏览器直连中转站的 /models 会被 CORS 拦掉，这里由服务端代取一次，供面板下拉选模型
    app.post('/api/user/custom-api/models', requireHost, (req, res) => {
        try {
            const sessionId = req.headers['x-session-id'] || req.query.sessionId;
            const session = authModule.validateSession(sessionId);

            if (!session) {
                return res.status(401).json({ success: false, message: '请先登录' });
            }

            const config = { ...req.body };

            // 界面上密钥以打码形式展示，用户留空即表示沿用已保存的真实密钥
            if (!config.apiKey) {
                const saved = authModule.getCustomApiConfigRaw(session.username);
                if (saved && saved.apiKey) {
                    config.apiKey = saved.apiKey;
                }
            }

            if (!config.apiUrl) {
                return res.json({ success: false, message: '请先填写API地址' });
            }

            userApiClient.fetchModels(config).then(result => {
                res.json(result);
            }).catch(error => {
                serverError(res, error);
            });
        } catch (error) {
            serverError(res, error);
        }
    });
}

module.exports = registerUserApiRoutes;
