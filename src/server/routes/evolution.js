'use strict';

// 沙箱进化闸管理端 API（管理端专属，requireAdmin 门禁）。
// 由 server/index.js 通过 registerEvolutionRoutes(app, ctx) 装配；
// 闸门与参数外置层经 ctx 注入，避免反向 require index.js。
//
// 定位：这是「她能不能改自己」的后台闸门面板接口——
// 提案 → 评估 → 判定 → 生效，全流程可查、可回滚。

function registerEvolutionRoutes(app, ctx) {
    const { requireAdmin, serverError, evolutionGate, evolutionParams } = ctx;

    // 总览：开关 + 白名单模块 + 参数表 + 提案统计
    app.get('/api/evolution/status', requireAdmin, (req, res) => {
        try {
            res.json({ success: true, ...evolutionGate.status() });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 参数外置层：清单
    app.get('/api/evolution/params', requireAdmin, (req, res) => {
        try {
            res.json({ success: true, params: evolutionParams.list() });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 参数外置层：直接改某个参数（人工通道，方便先手动标定）
    app.post('/api/evolution/params', requireAdmin, (req, res) => {
        try {
            const { name, value } = req.body || {};
            const applied = evolutionParams.set(name, value);
            if (applied === null) {
                return res.status(400).json({ success: false, error: '未知参数或非法值' });
            }
            res.json({ success: true, name, value: applied, params: evolutionParams.list() });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 参数外置层：抹掉覆盖，回到代码默认值
    app.delete('/api/evolution/params/:name', requireAdmin, (req, res) => {
        try {
            res.json({ success: true, params: evolutionParams.reset(req.params.name) });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 白名单模块
    app.get('/api/evolution/modules', requireAdmin, (req, res) => {
        try {
            res.json({ success: true, modules: evolutionGate.listModules() });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 开关闸门（默认关）
    app.post('/api/evolution/enabled', requireAdmin, (req, res) => {
        try {
            const enabled = evolutionGate.setEnabled(!!(req.body && req.body.enabled));
            res.json({ success: true, enabled });
        } catch (error) {
            serverError(res, error);
        }
    });

    // 提案列表 / 新建
    app.get('/api/evolution/proposals', requireAdmin, (req, res) => {
        try {
            res.json({ success: true, proposals: evolutionGate.listProposals() });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/evolution/proposals', requireAdmin, (req, res) => {
        try {
            const result = evolutionGate.propose(req.body || {});
            if (!result.success) return res.status(400).json(result);
            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });

    // 评估：拿另一个副本的数据跟基线比（不劣化才放行）
    app.post('/api/evolution/proposals/:id/evaluate', requireAdmin, async (req, res) => {
        try {
            const result = await evolutionGate.evaluate(req.params.id);
            if (!result.success) return res.status(400).json(result);
            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });

    // 生效：参数档自动生效，工具档只落待审
    app.post('/api/evolution/proposals/:id/promote', requireAdmin, (req, res) => {
        try {
            const result = evolutionGate.promote(req.params.id);
            if (!result.success) return res.status(400).json(result);
            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });

    // 回滚：退回该提案生效前的参数快照
    app.post('/api/evolution/proposals/:id/rollback', requireAdmin, (req, res) => {
        try {
            const result = evolutionGate.rollback(req.params.id);
            if (!result.success) return res.status(400).json(result);
            res.json(result);
        } catch (error) {
            serverError(res, error);
        }
    });
}

module.exports = registerEvolutionRoutes;
