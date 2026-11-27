'use strict';

// 从 server/index.js 抽出：根页面 + 认证（登录/注册/登出/校验/改密）路由。
// 依赖经 ctx 注入，避免反向 require index.js 造成循环依赖。
// 注意：本文件在 server/routes/ 下，相对路径比原 index.js 深一层。

const path = require('path');

function registerAuthRoutes(app, ctx) {
    const {
        rateLimit,
        serverError,
        authModule,
        securityModule,
        getClientIp,
        isHostRequest
    } = ctx;

    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, '../../../public/index.html'));
    });

    // 用户登录
    app.post('/api/auth/login', rateLimit, async (req, res) => {
        try {
            const { username, password } = req.body;
            const ip = getClientIp(req);

            if (!username || !password) {
                return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
            }

            // 同一个来源连续输错 5 次就锁 15 分钟，先用记录挡一道
            const lock = securityModule.checkLoginLock(ip);
            if (lock.locked) {
                return res.status(429).json({
                    success: false,
                    message: `密码错误次数过多，请 ${Math.ceil(lock.retryAfterSec / 60)} 分钟后再试`
                });
            }

            // 账号维度（换 IP 也躲不掉的那道）：锁定期内密码错了直接 429；
            // 密码输对的本人照常放行——锁只挡猜密码的，不挡主人自己
            const acctLock = securityModule.checkAccountLock(username);

            const result = await authModule.login(username, password);

            if (!result.success) {
                if (acctLock.locked) {
                    return res.status(429).json({
                        success: false,
                        message: `该账号失败次数过多，请 ${Math.ceil(acctLock.retryAfterSec / 60)} 分钟后再试`
                    });
                }

                const failure = securityModule.recordLoginFailure(ip);
                // 只给真实存在的账号记账，瞎编的用户名不配占格子
                const acctFailure = authModule.userExists(username)
                    ? securityModule.recordAccountFailure(username)
                    : { locked: false };

                if (failure.locked || acctFailure.locked) {
                    return res.status(429).json({
                        success: false,
                        message: `密码错误次数过多，请 ${Math.ceil((failure.retryAfterSec || acctFailure.retryAfterSec) / 60)} 分钟后再试`
                    });
                }
                return res.json({ ...result, message: `${result.message}，还可尝试 ${failure.remaining} 次` });
            }

            // 管理员账号只认跑服务这台机器：手机、别的电脑、公网进来的 admin 登录直接拒掉
            if (result.role === 'admin' && !isHostRequest(req)) {
                authModule.logout(result.sessionId);
                return res.status(403).json({ success: false, message: '管理员账号仅限服务所在机器登录' });
            }

            securityModule.resetLoginFailures(ip);
            securityModule.resetAccountFailures(username);

            if (result.sessionId) {
                const csrfToken = securityModule.generateCSRFToken(result.sessionId);
                result.csrfToken = csrfToken;
            }

            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/auth/register', rateLimit, async (req, res) => {
        try {
            const { username, password } = req.body;

            if (!username || !password) {
                return res.status(400).json({ success: false, message: '用户名和密码不能为空' });
            }

            const result = await authModule.register(username, password, 'normal');
            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });

    // 用户登出
    app.post('/api/auth/logout', (req, res) => {
        try {
            const sessionId = req.headers['x-session-id'] || req.body.sessionId;
            const result = authModule.logout(sessionId);
            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });

    // 验证会话
    app.get('/api/auth/validate', (req, res) => {
        try {
            const sessionId = req.headers['x-session-id'] || req.query.sessionId;
            const session = authModule.validateSession(sessionId);

            if (session) {
                // 手机/别的电脑上残留的 admin 会话照样不认：管理面板只在本机有效，
                // 否则那些设备拿着旧 sessionId 还能把管理员界面开起来
                if (session.role === 'admin' && !isHostRequest(req)) {
                    return res.json({ success: false, message: '管理员会话仅限服务所在机器使用' });
                }
                let csrfToken = securityModule.csrfTokens.get(sessionId);
                if (!csrfToken) {
                    csrfToken = { token: securityModule.generateCSRFToken(sessionId) };
                }
                res.json({ success: true, user: session, csrfToken: csrfToken.token });
            } else {
                res.json({ success: false, message: '会话无效或已过期' });
            }
        } catch (error) {
            serverError(res, error);
        }
    });

    // 修改密码
    app.post('/api/auth/change-password', async (req, res) => {
        try {
            const sessionId = req.headers['x-session-id'] || req.body.sessionId;
            const { oldPassword, newPassword } = req.body;

            const session = authModule.validateSession(sessionId);
            if (!session) {
                return res.json({ success: false, message: '会话无效' });
            }

            const result = await authModule.changePassword(session.username, oldPassword, newPassword);
            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });

    // 重置/找回密码：忘记密码时的兜底。不做会话与旧密码校验，
    // 安全性完全靠「只认跑服务这台机器」（isHostRequest）——本机主人才能重置。
    app.post('/api/auth/reset-password', async (req, res) => {
        try {
            if (!isHostRequest(req)) {
                return res.status(403).json({ success: false, message: '重置密码仅限服务所在机器操作' });
            }

            const username = (req.body.username || '管理员').trim();
            const newPassword = (req.body.newPassword || '123456').trim();

            const result = await authModule.resetPassword(username, newPassword);
            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });
}

module.exports = registerAuthRoutes;
