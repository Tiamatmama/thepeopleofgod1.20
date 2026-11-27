'use strict';

// 从 server/index.js 抽出：管理员 / 用户 / 机器人 / 服务器关闭路由。
// 依赖经 ctx 注入，避免反向 require index.js 造成循环依赖。

function registerAdminRoutes(app, ctx) {
    const { requireAdmin, requireHost, serverError, authModule, flushMemoryOnExit } = ctx;

    // 管理员获取用户列表（需要管理员权限）
    app.get('/api/admin/users', requireAdmin, (req, res) => {
        try {
            const users = Object.keys(authModule.users).map(username => {
                const user = authModule.getUser(username);
                return user;
            });
            res.json({ success: true, users });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 管理员删除用户（需要管理员权限）
    app.delete('/api/admin/users/:username', requireAdmin, (req, res) => {
        try {
            const result = authModule.deleteUser(req.params.username);
            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });

    // 用户创建bot后增加计数
    app.post('/api/bot/increment-count', requireHost, (req, res) => {
        try {
            const sessionId = req.headers['x-session-id'] || req.body.sessionId;
            const session = authModule.validateSession(sessionId);

            if (!session) {
                return res.json({ success: false, message: '会话无效' });
            }

            const result = authModule.incrementBotCount(session.username);
            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });

    // 检查用户是否有管理员邀请
    app.get('/api/user/admin-invitation', (req, res) => {
        try {
            const sessionId = req.headers['x-session-id'] || req.query.sessionId;
            const session = authModule.validateSession(sessionId);

            if (!session) {
                return res.json({ success: false, message: '会话无效' });
            }

            const hasInvitation = authModule.checkAdminInvitation(session.username);
            const botCount = authModule.getBotCount(session.username);

            res.json({
                success: true,
                hasInvitation: hasInvitation,
                botCount: botCount,
                requiredBotCount: 10
            });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 接受管理员邀请
    app.post('/api/user/accept-admin-invitation', requireHost, (req, res) => {
        try {
            const sessionId = req.headers['x-session-id'] || req.body.sessionId;
            const session = authModule.validateSession(sessionId);

            if (!session) {
                return res.json({ success: false, message: '会话无效' });
            }

            const result = authModule.acceptAdminInvitation(session.username, sessionId);
            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });

    // 获取用户的bot数量
    app.get('/api/user/bot-count', (req, res) => {
        try {
            const sessionId = req.headers['x-session-id'] || req.query.sessionId;
            const session = authModule.validateSession(sessionId);

            if (!session) {
                return res.json({ success: false, message: '会话无效' });
            }

            const botCount = authModule.getBotCount(session.username);
            res.json({ success: true, botCount: botCount });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/server/shutdown', requireHost, (req, res) => {
        console.log('[Server] 收到关闭请求，正在停止服务器...');
        res.json({ success: true, message: '服务器正在关闭...' });

        setTimeout(() => {
            flushMemoryOnExit();
            process.exit(0);
        }, 1000);
    });
}

module.exports = registerAdminRoutes;
