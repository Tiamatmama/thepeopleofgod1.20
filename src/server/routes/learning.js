'use strict';

// 🌱 学习任务接口：状态 / 计划 / 执行 / 产物删除。
// 读接口要求登录；创建与执行要求本机（requireHost），避免局域网里别人替她开训练任务。

module.exports = (app, { requireLogin, requireHost, serverError, learning }) => {
    if (!learning) return;
    learning.startMonitor();

    app.get('/api/learning/status', requireLogin, (req, res) => {
        try {
            res.json({
                success: true,
                ...learning.status(),
                tasks: learning.list()
            });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.get('/api/learning/tasks', requireLogin, (req, res) => {
        try {
            res.json({ success: true, tasks: learning.list() });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/learning/tasks', requireHost, (req, res) => {
        try {
            res.json(learning.create(req.body || {}));
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/learning/tasks/:id/run', requireHost, async (req, res) => {
        try {
            res.json(await learning.run(req.params.id, req.body || {}));
        } catch (error) {
            serverError(res, error);
        }
    });

    app.delete('/api/learning/assets/:id', requireHost, (req, res) => {
        try {
            res.json(learning.store.remove(req.params.id));
        } catch (error) {
            serverError(res, error);
        }
    });
};
