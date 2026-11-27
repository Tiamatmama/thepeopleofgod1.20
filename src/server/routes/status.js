'use strict';

// 从 server/index.js 抽出：状态/记忆概览与记忆维护（回滚去重、称呼覆盖）路由。
// 依赖经 ctx 注入，避免反向 require index.js 造成循环依赖。

const fs = require('fs');
const path = require('path');

const AMBIENT_AUDIO_DIR = path.join(__dirname, '../../../public/audio');
const AMBIENT_AUDIO_EXT = new Set(['.mp3', '.ogg', '.m4a', '.wav']);

function registerStatusRoutes(app, ctx) {
    const {
        requireLogin,
        serverError,
        emotionModule,
        galgameModule,
        memoryModule,
        systemNarrator,
        expressionProjection,
        deviceLink
    } = ctx;

    app.get('/api/status', requireLogin, (req, res) => {
        const sessionId = req.query.sessionId;
        const userId = req.query.userId;
        const status = {
            emotion: emotionModule.getCurrentEmotions(sessionId, userId),
            // 没有 userId 就不读 session|default 那个旧共享档，直接给一份 STRANGER，
            // 否则没选角色的用户会看到别人的好感度
            relationship: userId
                ? galgameModule.getCurrentRelationship(sessionId, userId)
                : galgameModule.getStrangerRelationship(),
            memoryCount: memoryModule.getMemoryCount(),
            summaryCount: memoryModule.getSummaryCount(),
            recentSummary: memoryModule.getRecentSummary(),
            narratorStatus: systemNarrator.getStatus()
        };
        res.json(status);
    });

    // 表情投影：情绪快照 → VAD / 表情 / 分层动作 / 设备动作。
    // 纯读：只取 getCurrentEmotions() 的现算结果，不写回情绪，不落盘。
    app.get('/api/expression', requireLogin, (req, res) => {
        try {
            const sessionId = req.query.sessionId;
            const userId = req.query.userId;
            const plan = expressionProjection.project(
                {
                    at: Date.now(),
                    sessionId: sessionId || null,
                    userId: userId || null,
                    fast: emotionModule.getCurrentEmotions(sessionId, userId)
                },
                {
                    availableActions: deviceLink ? deviceLink.listActionNames() : []
                }
            );
            res.json(plan);
        } catch (error) {
            serverError(res, error);
        }
    });

    // 记忆面板的数据源：必须带 userId（由 memory 内部规范化成 __role 档）；
    // 不带 userId 时不再回退读 default 档，直接返回空结构
    app.get('/api/summary', requireLogin, (req, res) => {
        const userId = req.query.userId;
        if (!userId) {
            return res.json({
                recentMemories: [],
                summaryMemories: [],
                pinnedCount: 0,
                associations: [],
                mergedGroups: [],
                address: {},
                currentRelationshipScore: 0,
                totalMemoryCount: 0,
                summaryCount: 0,
                userId: null
            });
        }
        res.json(memoryModule.getAllMemoriesWithSummary(userId));
    });

    // 去重合并的可恢复入口（DB-6 同款透明，无 token）：撤销某次合并——把被并入条复原、扣回保留条权重。
    // 与 CLI `dedup-apply.js --rollback` 等价；面板「去重合并（可恢复）」区块据此调用。
    app.post('/api/memory/rollback-dedup', requireLogin, (req, res) => {
        try {
            const { userId, keepId } = req.body || {};
            if (!userId) return res.status(400).json({ success: false, message: '缺少 userId' });
            if (!keepId) return res.status(400).json({ success: false, message: '缺少 keepId' });
            const result = memoryModule.rollbackDedupMerge(userId, keepId);
            res.json({ success: true, ...result });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 背景音乐轮播清单：扫 public/audio，丢新文件进去就参与轮播，不用改前端。
    // 音频本身由 express.static 公开提供，清单也不含敏感信息，因此不挂 requireLogin。
    app.get('/api/ambient/tracks', (req, res) => {
        try {
            const tracks = fs.readdirSync(AMBIENT_AUDIO_DIR)
                .filter((name) => AMBIENT_AUDIO_EXT.has(path.extname(name).toLowerCase()))
                .sort()
                .map((name) => `/audio/${encodeURIComponent(name)}`);
            res.json({ tracks });
        } catch {
            res.json({ tracks: [] });
        }
    });

    // 称呼的手动覆盖入口：面板上改了就存，之后每轮提示词都按改后的来
    app.post('/api/address', requireLogin, (req, res) => {
        try {
            const { userId, roleCallsUser = '', userCallsRole = '' } = req.body || {};
            if (!userId) {
                return res.status(400).json({ success: false, message: '缺少 userId，不能写入共享档' });
            }
            const address = memoryModule.setAddress(userId, { roleCallsUser, userCallsRole }, { replace: true });
            res.json({ success: true, address: address });
        } catch (error) {
            serverError(res, error);
        }
    });
}

module.exports = registerStatusRoutes;
