'use strict';

// 表达学习平台路由。依赖经 ctx 注入；所有接口仅限本机（requireHost）。
const expressive = require('../../core/expressive');

const WHEN_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function registerExpressiveRoutes(app, ctx) {
    const { requireHost, outputModule } = ctx;

    app.get('/api/expressive/state', requireHost, (req, res) => {
        try {
            res.json(expressive.getState());
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 投放语料：一行一条，落盘前统一洗掉隐形字符
    app.post('/api/expressive/corpus', requireHost, (req, res) => {
        try {
            const added = expressive.appendCorpus((req.body || {}).text);
            res.json({ added });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 手动学一批：异步跑，立即返回；失败信息由 getState 的 lastError 带回
    app.post('/api/expressive/learn', requireHost, (req, res) => {
        try {
            const batchSize = (req.body || {}).batchSize;
            setImmediate(() => {
                expressive.learnBatch({ outputModule, batchSize }).catch((error) => {
                    console.error('[Expressive] 学习失败:', error.message);
                });
            });
            res.json({ started: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // 双方协商后的约定：只保存已确认的约定 + 历史，不在平台内谈判
    app.post('/api/expressive/agreement', requireHost, (req, res) => {
        try {
            const body = req.body || {};
            const when = String(body.when == null ? '' : body.when).trim();
            if (!WHEN_RE.test(when)) {
                return res.status(400).json({ error: 'when 必须是 HH:mm 格式' });
            }
            let weekday = null;
            if (body.weekday !== undefined && body.weekday !== null && body.weekday !== '') {
                const parsed = Number(body.weekday);
                if (!Number.isInteger(parsed) || parsed < 0 || parsed > 6) {
                    return res.status(400).json({ error: 'weekday 必须是 0-6' });
                }
                weekday = parsed;
            }
            let batchSize = expressive.DEFAULT_BATCH_SIZE;
            if (body.batchSize !== undefined && body.batchSize !== null && body.batchSize !== '') {
                const parsed = Number(body.batchSize);
                if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
                    return res.status(400).json({ error: 'batchSize 必须是 1-200 的整数' });
                }
                batchSize = parsed;
            }
            const note = String(body.note == null ? '' : body.note).trim().slice(0, 200);
            const proposedBy = body.proposedBy === 'role' ? 'role' : 'user';
            const confirmedAt = new Date().toISOString();

            const config = expressive.loadConfig();
            config.agreement = { when, weekday, batchSize, note, proposedBy, confirmedAt };
            config.history = (config.history || []).concat([{
                at: confirmedAt,
                action: 'agreement_confirmed',
                by: proposedBy,
                detail: `约定 ${when}${weekday === null ? '' : `（周${weekday}）`}，每批 ${batchSize} 条${note ? `；${note}` : ''}`
            }]);
            expressive.saveConfig(config);
            res.json(config);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
}

module.exports = registerExpressiveRoutes;
