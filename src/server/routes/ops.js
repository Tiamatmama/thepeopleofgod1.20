'use strict';

// 从 server/index.js 抽出：开发者日志 / 好感度规则 / 旁白 / 时间表 / 备份等运维路由。
// 依赖经 ctx 注入，避免反向 require index.js 造成循环依赖。
// 注意：本文件在 server/routes/ 下，相对路径比原 index.js 深一层。

const path = require('path');

function registerOpsRoutes(app, ctx) {
    const {
        requireAdmin,
        requireHost,
        serverError,
        galgameModule,
        systemNarrator,
        scheduleStore,
        backupManager
    } = ctx;

    // 开发者日志里有用户原话、情绪与思考过程，只允许管理员看
    app.get('/api/logs', requireAdmin, (req, res) => {
        try {
            const fs = require('fs');
            const logPath = path.join(__dirname, '../../tools/developer.log');

            if (fs.existsSync(logPath)) {
                const content = fs.readFileSync(logPath, 'utf8');
                const lines = content.split('\n');
                const lastLines = lines.slice(-1000).join('\n');
                res.json({ success: true, content: lastLines });
            } else {
                res.json({ success: true, content: '暂无日志' });
            }
        } catch (error) {
            serverError(res, error);
        }
    });

    // 获取好感度日志
    app.get('/api/affection-logs', requireAdmin, (req, res) => {
        try {
            const fs = require('fs');
            const logPath = path.join(__dirname, '../../../data/affection_logs.json');

            if (fs.existsSync(logPath)) {
                const content = fs.readFileSync(logPath, 'utf8');
                const logs = JSON.parse(content);
                // 只返回最近100条
                res.json({ success: true, logs: logs.slice(-100) });
            } else {
                res.json({ success: true, logs: [] });
            }
        } catch (error) {
            serverError(res, error);
        }
    });

    // 设置骂人权限
    app.post('/api/developer/swear', requireAdmin, (req, res) => {
        try {
            const { enabled } = req.body;
            galgameModule.setSwearEnabled(enabled);
            res.json({ success: true, enabled: enabled });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 获取开发者设置
    app.get('/api/developer/settings', requireAdmin, (req, res) => {
        try {
            const settings = {
                enableSwear: galgameModule.developerSettings?.enableSwear || false
            };
            res.json({ success: true, settings: settings });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 获取好感度判定规则
    app.get('/api/affection/rules', (req, res) => {
        try {
            const rules = galgameModule.getAffectionRules();
            res.json({ success: true, rules: rules });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 设置好感度判定规则
    app.post('/api/affection/rules', requireHost, (req, res) => {
        try {
            const { rules } = req.body;
            const success = galgameModule.setAffectionRules(rules);
            res.json({ success: success });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 重置好感度判定规则为默认
    app.post('/api/affection/rules/reset', requireHost, (req, res) => {
        try {
            galgameModule.resetAffectionRules();
            const rules = galgameModule.getAffectionRules();
            res.json({ success: true, rules: rules });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.get('/api/narrator/status', (req, res) => {
        res.json(systemNarrator.getStatus());
    });

    app.post('/api/narrator/trigger', requireHost, async (req, res) => {
        try {
            const sessionId = req.body ? req.body.sessionId : null;
            const count = await systemNarrator.triggerNow(sessionId);
            res.json({ success: true, count });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/narrator/toggle', requireHost, (req, res) => {
        try {
            const { enabled } = req.body;
            systemNarrator.setEnabled(enabled);
            res.json({ success: true, enabled: systemNarrator.isEnabled() });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 角色时间表：默认关闭，条目备注可留空（留空就到点由角色自己决定说什么）
    app.get('/api/schedule', (req, res) => {
        res.json({ success: true, ...scheduleStore.describe() });
    });

    app.post('/api/schedule/save', requireHost, (req, res) => {
        try {
            const { enabled, tasks } = req.body || {};
            if (typeof enabled === 'boolean') {
                scheduleStore.setEnabled(enabled);
            }
            if (Array.isArray(tasks)) {
                scheduleStore.replaceTasks(tasks);
            }
            res.json({ success: true, ...scheduleStore.describe() });
        } catch (error) {
            console.error('保存时间表失败:', error);
            serverError(res, error);
        }
    });

    // 备份存档：把 data/ 连画板草稿一起打包成带时间戳的 zip，只留最近几份；不加密，解压就能读
    app.get('/api/backup/list', requireAdmin, (req, res) => {
        res.json({ success: true, ...backupManager.describe() });
    });

    app.post('/api/backup/create', requireAdmin, async (req, res) => {
        try {
            const result = await backupManager.create();
            res.json({ success: true, ...result, ...backupManager.describe() });
        } catch (error) {
            console.error('备份失败:', error);
            serverError(res, error);
        }
    });
}

module.exports = registerOpsRoutes;
