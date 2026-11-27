'use strict';

// 🧠 记忆管理：让用户能看、能钉、能在同意后归档，也能还原。
// 硬约束（角色哲学）：删除类动作一律不做，只做可逆的「归档 / 还原」；
// 归档必须由用户显式确认（confirm===true），未确认时返回 409 + needsConfirm，前端据此弹确认框。
// 作用域只从登录会话解析，绝不接受请求参数里的 userId / scope。

const { buildMemoryGraph, parseScopeLabel } = require('../../core/memoryGraph');

module.exports = (app, { requireLogin, serverError, memoryModule, galgameModule, emotionModule }) => {
    const scopeOf = req => memoryModule.normalizeScopeKey(req.user.userId, 'role');

    // 星图可看的来源：网页账号只看自己；管理员额外能看本机已加载的 QQ 档
    // （QQ 对话按 qq_<号>_<角色>__role 存，和网页登录名不是同一套键）
    const scopesFor = (req) => {
        const own = scopeOf(req);
        const all = (req.user && req.user.role === 'admin')
            ? Object.keys(memoryModule.userMemories || {})
            : [own];
        return all
            .map((key) => {
                const store = memoryModule.userMemories[key];
                const count = store && Array.isArray(store.memories)
                    ? store.memories.filter((m) => m && typeof m.data === 'string' && m.data.trim()).length
                    : 0;
                return Object.assign({ key, count, current: key === own }, parseScopeLabel(key));
            })
            .filter((item) => item.count > 0 || item.current)
            .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));
    };

    // 来源清单：页面用它渲染「网页 / QQ 号」下拉，不做任何写入
    app.get('/api/memory/graph/scopes', requireLogin, (req, res) => {
        try {
            const scopes = scopesFor(req);
            const own = scopeOf(req);
            // 自己的档是空的（常见于只用 QQ 聊过），默认落到记忆最多的那一档
            const recommended = scopes.some((s) => s.key === own && s.count > 0)
                ? own
                : (scopes[0] ? scopes[0].key : own);
            res.json({ success: true, current: own, recommended, scopes });
        } catch (error) {
            serverError(res, error);
        }
    });

    // ✨ 记忆星图：一次取回窗口内的节点/边/每日概览，前端本地做布局与动画。
    // 只读——直接读内存里已加载的记忆档，不起任何写入链路，也不落新文件。
    app.get('/api/memory/graph', requireLogin, (req, res) => {
        try {
            // source 必须在允许清单里，避免靠参数读到不属于自己的档
            const allowed = scopesFor(req).map((item) => item.key);
            const requested = typeof req.query.source === 'string' ? req.query.source : '';
            const key = allowed.indexOf(requested) !== -1 ? requested : scopeOf(req);
            const own = key === scopeOf(req);
            const store = memoryModule.getUserMemoryStore(key);
            const score = Number(store.relationshipScore) || 0;
            const stage = galgameModule ? galgameModule.getRelationshipStageByScore(score) : '';
            const stageName = (galgameModule && stage && galgameModule.relationshipStages[stage])
                ? galgameModule.relationshipStages[stage].name
                : '';

            // 当前情绪只用于页面顶部的一颗「此刻」星，不影响任何写回；
            // QQ 档没有实时的情绪键，交给 buildMemoryGraph 用最近一条带情绪的记忆代指
            const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId
                ? req.query.sessionId
                : 'default';
            let currentEmotion = '';
            let currentEmotionVector = null;
            if (emotionModule && own) {
                currentEmotionVector = emotionModule.getCurrentEmotions(sessionId, req.user.userId);
                currentEmotion = emotionModule.dominantOf(currentEmotionVector);
            }

            const graph = buildMemoryGraph(
                {
                    memories: store.memories,
                    relationshipScore: score,
                    stage,
                    stageName,
                    currentEmotion
                },
                { days: req.query.days, maxNodes: req.query.limit }
            );
            const scope = parseScopeLabel(key);
            res.json({
                success: true,
                ...graph,
                currentEmotionVector,
                source: { key, ...scope, own }
            });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.get('/api/memory/list', requireLogin, (req, res) => {
        try {
            const items = memoryModule.listMemoryViews(scopeOf(req), {
                limit: req.query.limit,
                tier: req.query.tier,
                query: req.query.q
            });
            res.json({ success: true, items });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/memory/:id/pin', requireLogin, (req, res) => {
        try {
            const pinned = req.body && req.body.pinned === true;
            const ok = memoryModule.setMemoryPinned(scopeOf(req), req.params.id, pinned);
            if (!ok) return res.status(404).json({ success: false, error: '记忆不存在或保存失败' });
            res.json({ success: true, pinned });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 同意闸门：没有 confirm===true 就不动，返回 409 让前端展示「确认归档？」
    app.post('/api/memory/:id/archive', requireLogin, (req, res) => {
        try {
            if (!req.body || req.body.confirm !== true) {
                return res.status(409).json({
                    success: false,
                    needsConfirm: true,
                    error: '归档会让她暂时想不起这条记忆，确认后再试'
                });
            }
            const result = memoryModule.archiveMemoryRecord(scopeOf(req), req.params.id);
            if (!result.ok) return res.status(404).json({ success: false, error: '记忆不存在或保存失败' });
            res.json({ success: true, ...result });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/memory/:id/restore', requireLogin, (req, res) => {
        try {
            const tier = req.body && typeof req.body.tier === 'string' ? req.body.tier : 'episodic';
            const result = memoryModule.restoreMemoryRecord(scopeOf(req), req.params.id, tier);
            if (!result.ok) return res.status(404).json({ success: false, error: '记忆不存在或保存失败' });
            res.json({ success: true, ...result });
        } catch (error) {
            serverError(res, error);
        }
    });
};
