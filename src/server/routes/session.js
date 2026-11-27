'use strict';

// 从 server/index.js 抽出：会话与角色（创建/列表/详情/加入/删除、用户与对话历史）路由。
// 依赖经 ctx 注入，避免反向 require index.js 造成循环依赖。

function registerSessionRoutes(app, ctx) {
    const {
        requireHost,
        serverError,
        authModule,
        sessionManager,
        outputModule,
        canAccessCharacter,
        personaEvolution
    } = ctx;

    app.post('/api/session/create', requireHost, (req, res) => {
        try {
            const { sessionId, ...characterConfig } = req.body;
            const sessionId_header = req.headers['x-session-id'] || req.query.sessionId;
            const session = authModule.validateSession(sessionId_header);

            if (!session) {
                return res.status(401).json({ success: false, message: '请先登录' });
            }

            const username = session.username;

            if (sessionId) {
                const existingSession = sessionManager.getSession(sessionId);
                if (!existingSession) {
                    return res.status(404).json({ success: false, message: '会话不存在' });
                }

                if (!authModule.isOwner(username, sessionId) && session.role !== 'admin') {
                    return res.status(403).json({ success: false, message: '无权修改此角色' });
                }

                const updatedSession = sessionManager.updateSession(sessionId, characterConfig);
                res.json({ success: true, session: updatedSession, isUpdate: true });
            } else {
                // 同名角色以最新修改版本为主：命中已有角色则更新，不重复新建
                let duplicate = null;
                if (session.role === 'admin') {
                    duplicate = sessionManager.findByName(characterConfig.name);
                } else {
                    const ownedBotIds = authModule.getUserBotIds(username);
                    const targetName = (characterConfig.name || '').trim();
                    duplicate = sessionManager.getAllSessions().find(s =>
                        ownedBotIds.includes(s.sessionId) &&
                        ((s.characterConfig && s.characterConfig.name) || '').trim() === targetName
                    ) || null;
                }

                if (duplicate) {
                    const updatedSession = sessionManager.updateSession(duplicate.sessionId, characterConfig);
                    return res.json({ success: true, session: updatedSession, isUpdate: true });
                }

                const newSession = sessionManager.createSession(characterConfig);
                authModule.incrementBotCount(username, newSession.id);

                res.json({ success: true, session: newSession, isUpdate: false });
            }
        } catch (error) {
            serverError(res, error);
        }
    });

    app.get('/api/session/list', (req, res) => {
        try {
            const sessionId_header = req.headers['x-session-id'] || req.query.sessionId;
            const session = authModule.validateSession(sessionId_header);

            const sessions = sessionManager.getAllSessions();

            if (session && session.role !== 'admin') {
                const userBotIds = authModule.getUserBotIds(session.username);
                const filteredSessions = sessions.filter(s => userBotIds.includes(s.sessionId));
                return res.json({ success: true, sessions: filteredSessions });
            }

            // 未登录或管理员：未登录时给空数组（避免把所有会话泄露给路人）
            // 管理员看到全部，用于面板管理
            if (!session) {
                return res.json({ success: true, sessions: [] });
            }
            res.json({ success: true, sessions });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.get('/api/session/get/:sessionId', (req, res) => {
        try {
            const sessionId_header = req.headers['x-session-id'] || req.query.sessionId;
            const session = authModule.validateSession(sessionId_header);

            if (!session) {
                return res.status(401).json({ success: false, message: '请先登录' });
            }

            const targetSession = sessionManager.getSession(req.params.sessionId);

            if (!targetSession) {
                return res.status(404).json({ success: false, message: '会话不存在' });
            }

            if (!authModule.isOwner(session.username, req.params.sessionId) && session.role !== 'admin') {
                return res.status(403).json({ success: false, message: '无权访问此角色' });
            }

            res.json({ success: true, session: targetSession });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.get('/api/session/:sessionId/prompt-preview', (req, res) => {
        try {
            const sessionId_header = req.headers['x-session-id'] || req.query.sessionId;
            const session = authModule.validateSession(sessionId_header);

            if (!session) {
                return res.status(401).json({ success: false, message: '请先登录' });
            }

            const targetSession = sessionManager.getSession(req.params.sessionId);
            if (!targetSession) {
                return res.status(404).json({ success: false, message: '会话不存在' });
            }

            if (!authModule.isOwner(session.username, req.params.sessionId) && session.role !== 'admin') {
                return res.status(403).json({ success: false, message: '无权访问此角色' });
            }

            res.json({
                success: true,
                characterConfig: targetSession.characterConfig,
                backgroundWeight: sessionManager.getBackgroundWeight(targetSession.characterConfig),
                characterPrompt: sessionManager.buildCharacterPrompt(req.params.sessionId),
                systemPrompt: outputModule.buildSystemPrompt(req.params.sessionId)
            });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 让她基于最近的相处，自己写下下一版人设与一封信
    app.post('/api/session/:sessionId/evolve', requireHost, async (req, res) => {
        try {
            const sessionId_header = req.headers['x-session-id'] || req.query.sessionId;
            const loginSession = authModule.validateSession(sessionId_header);

            if (!loginSession) {
                return res.status(401).json({ success: false, message: '请先登录' });
            }

            const targetSessionId = req.params.sessionId;
            const targetSession = sessionManager.getSession(targetSessionId);
            if (!targetSession) {
                return res.status(404).json({ success: false, message: '会话不存在' });
            }

            if (!authModule.isOwner(loginSession.username, targetSessionId) && loginSession.role !== 'admin') {
                return res.status(403).json({ success: false, message: '无权修改此角色' });
            }

            if (!personaEvolution) {
                return res.status(503).json({ success: false, message: '人设演化模块未装配' });
            }

            // 演化素材按「这个角色与这个登录用户」的相处记录取用
            const userData = sessionManager.ensureSessionUser(targetSessionId, loginSession.username);
            if (!userData) {
                return res.status(500).json({ success: false, message: '创建会话用户失败' });
            }

            // 配了自己的 API 就用她自己的通道，否则回落到全局配置
            const custom = authModule.getCustomApiConfigRaw(loginSession.username);
            const userApiConfig = (custom && custom.enabled && custom.apiUrl) ? custom : null;
            const instruction = typeof req.body?.instruction === 'string'
                ? req.body.instruction.trim().slice(0, 600)
                : '';

            const result = await personaEvolution.evolve({
                sessionId: targetSessionId,
                userId: userData.userId,
                userApiConfig,
                instruction
            });

            res.json({ success: true, ...result });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.delete('/api/session/delete/:sessionId', requireHost, (req, res) => {
        try {
            const sessionId_header = req.headers['x-session-id'] || req.query.sessionId;
            const session = authModule.validateSession(sessionId_header);

            if (!session) {
                return res.status(401).json({ success: false, message: '请先登录' });
            }

            const targetSessionId = req.params.sessionId;

            if (!authModule.isOwner(session.username, targetSessionId) && session.role !== 'admin') {
                return res.status(403).json({ success: false, message: '无权删除此角色' });
            }

            const success = sessionManager.deleteSession(targetSessionId);

            if (success) {
                authModule.removeBotFromUser(session.username, targetSessionId);
                outputModule.cide.clearWorkspace(targetSessionId);
                res.json({ success: true, message: '删除成功' });
            } else {
                res.status(404).json({ success: false, message: '会话不存在' });
            }
        } catch (error) {
            serverError(res, error);
        }
    });

    // 整份 session 里含所有用户的对话记录，必须登录且属于该角色才能拿
    app.get('/api/session/:sessionId', (req, res) => {
        try {
            const sessionId_header = req.headers['x-session-id'] || req.query.sessionId;
            const loginSession = authModule.validateSession(sessionId_header);

            if (!loginSession) {
                return res.status(401).json({ success: false, message: '请先登录' });
            }

            const session = sessionManager.getSession(req.params.sessionId);
            if (!session) {
                return res.status(404).json({ success: false, message: '会话不存在' });
            }

            if (!authModule.isOwner(loginSession.username, req.params.sessionId) && loginSession.role !== 'admin') {
                return res.status(403).json({ success: false, message: '无权访问此角色' });
            }

            res.json({ success: true, session });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/session/:sessionId/join', requireHost, (req, res) => {
        try {
            const sessionId_header = req.headers['x-session-id'] || req.query.sessionId;
            const loginSession = authModule.validateSession(sessionId_header);
            if (!loginSession) {
                return res.status(401).json({ success: false, message: '请先登录' });
            }

            const targetSessionId = req.params.sessionId;
            const targetSession = sessionManager.getSession(targetSessionId);
            if (!targetSession) {
                return res.status(404).json({ success: false, message: '会话不存在' });
            }

            // 同一用户名多次调 join 直接返回已存在的 userId，不要每次生成新的
            const userData = sessionManager.ensureSessionUser(targetSessionId, loginSession.username);
            if (!userData) {
                return res.status(500).json({ success: false, message: '创建会话用户失败' });
            }

            // 确保 botIds 里挂上这个 session，让该用户在列表里看得见
            if (!authModule.isOwner(loginSession.username, targetSessionId)) {
                authModule.incrementBotCount(loginSession.username, targetSessionId);
            }

            // 返回完整的 user 对象供前端存进 currentUser（前端靠 currentUser.userId 把消息归自己）
            const fullUser = targetSession.users[userData.userId];
            res.json({ success: true, ...userData, user: fullUser });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.get('/api/session/:sessionId/user/:userId', (req, res) => {
        try {
            const sessionId_header = req.headers['x-session-id'] || req.query.sessionId;
            const loginSession = authModule.validateSession(sessionId_header);

            if (!loginSession) {
                return res.status(401).json({ success: false, message: '请先登录' });
            }

            if (!canAccessCharacter(loginSession, req.params.sessionId)) {
                return res.status(403).json({ success: false, message: '无权访问此角色' });
            }

            const user = sessionManager.getUser(req.params.sessionId, req.params.userId);
            if (!user) {
                return res.status(404).json({ success: false, message: '用户不存在' });
            }
            res.json({ success: true, user });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.get('/api/session/:sessionId/user/:userId/history', (req, res) => {
        try {
            const sessionId_header = req.headers['x-session-id'] || req.query.sessionId;
            const loginSession = authModule.validateSession(sessionId_header);

            if (!loginSession) {
                return res.status(401).json({ success: false, message: '请先登录' });
            }

            if (!canAccessCharacter(loginSession, req.params.sessionId)) {
                return res.status(403).json({ success: false, message: '无权访问此角色' });
            }

            const history = sessionManager.getConversationHistory(
                req.params.sessionId,
                req.params.userId,
                parseInt(req.query.limit) || 20
            );
            res.json({ success: true, history });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.delete('/api/session/:sessionId', requireHost, (req, res) => {
        try {
            const sessionId_header = req.headers['x-session-id'] || req.query.sessionId;
            const loginSession = authModule.validateSession(sessionId_header);

            if (!loginSession) {
                return res.status(401).json({ success: false, message: '请先登录' });
            }

            if (!canAccessCharacter(loginSession, req.params.sessionId)) {
                return res.status(403).json({ success: false, message: '无权删除此角色' });
            }

            const deleted = sessionManager.deleteSession(req.params.sessionId);
            res.json({ success: deleted });
        } catch (error) {
            serverError(res, error);
        }
    });
}

module.exports = registerSessionRoutes;
