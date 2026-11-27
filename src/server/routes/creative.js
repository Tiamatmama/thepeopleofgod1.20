'use strict';

// 自由创意世界页面接口（public/creative.html）。
// 世界状态由 core/creativeWorld 持有，这里只做协议转换；一律 requireHost，只许本机开。
// 场景提示与技能白名单由 runtimes.js 的创意世界通道提供，进界面时一并取回。

// 创意对话只放这几样：改世界 + 按需取技能。其余工具（写文件/跑命令/设备）一律不发，
// 免得在搭东西的场景里误触发审批。
const CREATIVE_TOOL_NAMES = new Set([
    'world_place',
    'world_remove',
    'world_snapshot',
    'world_clear',
    'world_move_character',
    'world_say',
    'world_pay',
    'world_open_page',
    'skill_list',
    'skill_load',
    'skill_resource'
]);

const MAX_HISTORY = 16;
const MAX_MESSAGE_CHARS = 2000;

const { describeScene } = require('../../core/tavernClock');

function cleanHistory(input) {
    if (!Array.isArray(input)) return [];
    return input
        .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
        .map((item) => ({ role: item.role, content: String(item.content || '').slice(0, MAX_MESSAGE_CHARS) }))
        .filter((item) => item.content.trim())
        .slice(-MAX_HISTORY);
}

function registerCreativeRoutes(app, ctx = {}) {
    const { requireHost, serverError, creativeWorld, creativeRuntime } = ctx;

    const hasWorld = (res) => {
        if (creativeWorld && typeof creativeWorld.snapshot === 'function') return true;
        res.status(503).json({ success: false, message: '创意世界未装配' });
        return false;
    };

    // 世界快照：尺寸 / 调色板 / 全部方块 / 评分
    app.get('/api/creative/world', requireHost, (req, res) => {
        if (!hasWorld(res)) return;
        try {
            res.json(creativeWorld.snapshot());
        } catch (error) {
            serverError(res, error);
        }
    });

    // 场景上下文：进入界面时把技能白名单与场景提示拼好交给前端展示
    app.get('/api/creative/context', requireHost, (req, res) => {
        try {
            const scenePrompt = (creativeRuntime && creativeRuntime.scenePrompt) || '';
            const skills = [];
            const match = scenePrompt.match(/[（(]需要具体做法时用 skill_load 取完整指令[）)]：([\s\S]*)$/);
            if (match) {
                match[1].split('\n').forEach((line) => {
                    const item = /^\s*-\s*([^：:]+)[：:]\s*(.*)$/.exec(line);
                    if (item) skills.push({ name: item[1].trim(), description: item[2].trim() });
                });
            }
            res.json({ success: true, skills, scenePrompt });
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/creative/place', requireHost, (req, res) => {
        if (!hasWorld(res)) return;
        try {
            const body = req.body || {};
            const result = creativeWorld.place({
                x: body.x,
                y: body.y,
                z: body.z,
                block: body.block
            });
            if (!result.success) return res.status(400).json(result);
            res.json(Object.assign({}, result, { world: creativeWorld.snapshot() }));
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/creative/remove', requireHost, (req, res) => {
        if (!hasWorld(res)) return;
        try {
            const body = req.body || {};
            const result = creativeWorld.remove({ x: body.x, y: body.y, z: body.z });
            if (!result.success) return res.status(400).json(result);
            res.json(Object.assign({}, result, { world: creativeWorld.snapshot() }));
        } catch (error) {
            serverError(res, error);
        }
    });

    // 付款：钱包划转
    app.post('/api/creative/pay', requireHost, (req, res) => {
        if (!hasWorld(res)) return;
        try {
            const body = req.body || {};
            const result = creativeWorld.pay({ from: body.from, to: body.to, amount: body.amount });
            if (!result.success) return res.status(400).json(result);
            res.json(Object.assign({}, result, { world: creativeWorld.snapshot() }));
        } catch (error) {
            serverError(res, error);
        }
    });

    // 角色说一句台词（页面画气泡，10 秒后自己消失）
    app.post('/api/creative/say', requireHost, (req, res) => {
        if (!hasWorld(res)) return;
        try {
            const body = req.body || {};
            const result = creativeWorld.say({ id: body.id, text: body.text });
            if (!result.success) return res.status(400).json(result);
            res.json(Object.assign({}, result, { world: creativeWorld.snapshot() }));
        } catch (error) {
            serverError(res, error);
        }
    });

    // 挪动角色（页面拖动或 AI 调用）
    app.post('/api/creative/character', requireHost, (req, res) => {
        if (!hasWorld(res)) return;
        try {
            const body = req.body || {};
            const result = creativeWorld.moveCharacter({ id: body.id, x: body.x, z: body.z });
            if (!result.success) return res.status(400).json(result);
            res.json(Object.assign({}, result, { world: creativeWorld.snapshot() }));
        } catch (error) {
            serverError(res, error);
        }
    });

    app.post('/api/creative/clear', requireHost, (req, res) => {
        if (!hasWorld(res)) return;
        try {
            const result = creativeWorld.clear();
            res.json(Object.assign({}, result, { world: creativeWorld.snapshot() }));
        } catch (error) {
            serverError(res, error);
        }
    });

    // 边聊边放：一轮对话内模型可以连调 world_place / world_remove，结束后把最新世界一并回给前端。
    // 只放行创意相关的八个工具，避免在搭东西时误触发写文件、跑命令、设备动作这类审批。
    app.post('/api/creative/chat', requireHost, async (req, res) => {
        if (!hasWorld(res)) return;
        const outputModule = creativeRuntime && creativeRuntime.outputModule;
        if (!outputModule || typeof outputModule.callWithTools !== 'function') {
            return res.status(503).json({ success: false, message: '创意对话通道未就绪' });
        }
        try {
            const body = req.body || {};
            const message = String(body.message || '').trim().slice(0, MAX_MESSAGE_CHARS);
            if (!message) return res.status(400).json({ success: false, message: '说点什么再发' });

            const messages = [{ role: 'system', content: buildChatSystemPrompt(creativeRuntime, creativeWorld) }]
                .concat(cleanHistory(body.history))
                .concat([{ role: 'user', content: message }]);

            const result = await outputModule.callWithTools(messages, {
                sessionId: 'creative-world',
                userId: 'creative-host',
                scope: 'ai',
                includeAffectionTool: false,
                maxRounds: 6,
                maxTokens: 3000,
                toolFilter: (tool) => CREATIVE_TOOL_NAMES.has(tool && tool.function && tool.function.name)
            });
            const reply = (result && result.choices && result.choices[0] && result.choices[0].message
                && String(result.choices[0].message.content || '').trim()) || '（这轮没说出话来）';
            res.json({ success: true, reply, world: creativeWorld.snapshot() });
        } catch (error) {
            serverError(res, error);
        }
    });
}

function buildChatSystemPrompt(runtime, world) {
    const scene = (runtime && runtime.scenePrompt) || '';
    // 把此刻店里的情况（谁在哪、刚说了什么）拼进提示词，她回话时才能接上「刚才谁点了什么」
    let live = '';
    try {
        if (world && typeof world.snapshot === 'function') {
            live = describeScene(new Date(), world.snapshot().characters);
        }
    } catch (error) {
        console.warn('[创意世界] 场景上下文拼装失败（不影响对话）:', error.message);
    }
    return [
        scene,
        live,
        '【回复要求】先把方块放到位，再用一两句话说明你做了什么；不要长篇解释，不要复述规则。',
        '一次回复最多放 12 块，放完用 world_snapshot 确认一下再说话。',
        '想走过去迎客、坐到他旁边时，用 world_move_character 挪你自己（id=ai）；别挪对方，除非他让你这么做。',
        '你身上有金币（快照里 characters[].wallet 就是余额）。点单付账用 world_pay，from 填 ai；酒吧西侧酒架顶上的金币是余额自动摆的（一枚代表 10 个），别手动摆 coin。',
        '对方在自己动手时，你别抢着把整片地铺满，留白给他。'
    ].filter(Boolean).join('\n');
}

module.exports = registerCreativeRoutes;
module.exports.registerCreativeRoutes = registerCreativeRoutes;
