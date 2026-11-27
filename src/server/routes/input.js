'use strict';

// 从 server/index.js 抽出：对话输入与本地语义分析/训练路由。
// 依赖经 ctx 注入，避免反向 require index.js 造成循环依赖。

function registerInputRoutes(app, ctx) {
    const {
        requireLogin,
        serverError,
        processInput,
        systemNarrator,
        galgameModule,
        inputModule,
        dialogueRetriever,
        semanticLearner,
        outputModule
    } = ctx;

    app.post('/api/input', async (req, res) => {
        const sessionId = req.body?.sessionId;
        if (sessionId) systemNarrator.setProcessing(sessionId, true);
        try {
            const inputData = req.body;
            const output = await processInput(inputData);

            // 获取好感度变化信息
            const relationshipStatus = galgameModule.getCurrentRelationship(inputData?.sessionId, inputData?.userId);
            const affectionChange = relationshipStatus.affectionChange;

            // 构建API返回，包含好感度变化但不影响对话输出
            const apiResponse = {
                ...output,
                affectionChange: affectionChange
            };

            res.json(apiResponse);
        } catch (error) {
            console.error('API处理错误:', error);
            serverError(res, error, 'status');
        } finally {
            if (sessionId) systemNarrator.setProcessing(sessionId, false);
        }
    });

    app.post('/api/local-semantic/analyze', requireLogin, async (req, res) => {
        try {
            const text = (req.body && typeof req.body.text === 'string') ? req.body.text.trim() : '';
            if (!text) {
                return res.status(400).json({ ok: false, error: '请输入要分析的文本' });
            }

            const sem = inputModule.localSemanticAnalysis(text);
            const value = inputModule.deriveSentimentValue(sem);

            // 回应优先级：Qdrant 台词对话检索 → 本地语义训练数据 → 模板
            let reply = null;

            const hit = await dialogueRetriever.retrieve(text);
            if (hit) {
                reply = {
                    data: hit.reply,
                    source: 'dialogue_retrieval',
                    matchedInput: hit.matchedInput,
                    score: hit.score,
                    title: hit.title
                };
            }

            // 检索未命中或不可用时，用语义分析系统自己的训练数据（与角色扮演的学习数据完全分离）
            if (!reply) {
                const learned = semanticLearner.predictOutput(text, sem.emotion.type, sem.relation.stage);
                if (learned && learned.output) {
                    reply = { data: learned.output, source: 'semantic_learned' };
                }
            }

            if (!reply) {
                const tpl = outputModule.localStyleGenerate(sem.emotion.type, sem.relation.stage);
                reply = { data: tpl.data, source: tpl.source };
            }

            res.json({
                ok: true,
                data: {
                    input: text,
                    emotion: sem.emotion,
                    value: value,
                    relation: sem.relation,
                    scene: sem.scene,
                    reply: {
                        text: reply.data,
                        source: reply.source,
                        matchedInput: reply.matchedInput || '',
                        score: reply.score,
                        title: reply.title || ''
                    }
                }
            });
        } catch (error) {
            console.error('语义分析错误:', error);
            serverError(res, error, 'ok');
        }
    });

    app.post('/api/local-semantic/learn', requireLogin, (req, res) => {
        try {
            const text = (req.body && typeof req.body.text === 'string') ? req.body.text.trim() : '';
            const replyText = (req.body && typeof req.body.reply === 'string') ? req.body.reply.trim() : '';
            if (!text || !replyText) {
                return res.status(400).json({ ok: false, error: '文本与回应都不能为空' });
            }

            const sem = inputModule.localSemanticAnalysis(text);
            semanticLearner.addTrainingPair(text, replyText, sem.emotion.type, sem.relation.stage);

            res.json({ ok: true, data: { total: semanticLearner.trainingData.length } });
        } catch (error) {
            console.error('语义训练失败:', error);
            serverError(res, error, 'ok');
        }
    });

    app.get('/api/local-semantic/train-stats', requireLogin, (req, res) => {
        try {
            res.json({ ok: true, data: semanticLearner.getTrainingStats() });
        } catch (error) {
            console.error('获取语义训练统计失败:', error);
            serverError(res, error, 'ok');
        }
    });
}

module.exports = registerInputRoutes;
