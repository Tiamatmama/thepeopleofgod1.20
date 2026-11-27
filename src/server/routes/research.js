'use strict';

// 研究平台（她的免授权自留地）路由（从 server/index.js 抽出）。依赖经 ctx 注入，
// 快照式迁移，逻辑未改；UnifiedAPI 为该块内 /api/research/llm 专用实例。
const { UnifiedAPI } = require('../../core/api');
const { stripInvisibleChars } = require('../../core/textGuard');

function registerResearchRoutes(app, ctx) {
    const { requireHost, serverError, toolRegistry, researchAgent } = ctx;

// ===== 研究平台（她的免授权自留地）=====
// 不要求登录，但一律 requireHost：只许本机打开，局域网里别的机器别想伸进来 😤
// 页面：http://localhost:41888/research.html

app.get('/api/research/tasks', requireHost, (req, res) => {
    try {
        res.json({ success: true, tasks: toolRegistry.research.listTasks(req.query.status) });
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/research/tasks', requireHost, (req, res) => {
    try {
        res.json(toolRegistry.research.addTask(req.body || {}));
    } catch (error) {
        serverError(res, error);
    }
});

app.put('/api/research/tasks/:id', requireHost, (req, res) => {
    try {
        res.json(toolRegistry.research.updateTask(req.params.id, req.body || {}));
    } catch (error) {
        serverError(res, error);
    }
});

app.delete('/api/research/tasks/:id', requireHost, (req, res) => {
    try {
        res.json(toolRegistry.research.deleteTask(req.params.id));
    } catch (error) {
        serverError(res, error);
    }
});

app.get('/api/research/note', requireHost, (req, res) => {
    try {
        res.json(toolRegistry.research.getNote());
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/research/note', requireHost, (req, res) => {
    try {
        res.json(toolRegistry.research.saveNote((req.body || {}).content));
    } catch (error) {
        serverError(res, error);
    }
});

app.get('/api/research/search', requireHost, async (req, res) => {
    try {
        const source = String(req.query.source || 'papers');
        const result = source === 'news'
            ? await toolRegistry.research.searchNews(req.query.q, req.query.max)
            : await toolRegistry.research.searchPapers(req.query.q, req.query.max);
        res.json(result);
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/research/run', requireHost, async (req, res) => {
    try {
        res.json(await toolRegistry.researchRun(req.body || {}));
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/research/open-vscode', requireHost, async (req, res) => {
    try {
        const workspace = toolRegistry.research.workspace;
        res.json(await toolRegistry.openInVscode(workspace));
    } catch (error) {
        serverError(res, error);
    }
});

// 研究工作台的模型接口：她的 Python/Node 脚本没法直接调大模型，这里开一个本机专用口子，
// 脚本用 stdlib 发 HTTP 就能批量打标/抽取（免授权自留地，但同样只许本机来源）。
const researchLLMAPI = new UnifiedAPI();
app.post('/api/research/llm', requireHost, async (req, res) => {
    try {
        const body = req.body || {};
        let messages = body.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
            const prompt = String(body.prompt || '').trim();
            if (!prompt) {
                return res.status(400).json({ success: false, message: '需要 messages 数组，或 prompt（可配 system）' });
            }
            messages = [];
            if (body.system) messages.push({ role: 'system', content: String(body.system) });
            messages.push({ role: 'user', content: prompt });
        }
        if (body.model) researchLLMAPI.switchAPI(String(body.model));
        // 脚本喂进来的多半是抓来的网页/论文原文：先剥掉隐形字符，别让页面里的
        // Tag 字符/零宽载荷顺着这个口子进模型
        messages = messages
            .filter(m => m && typeof m === 'object')
            .map(m => (typeof m.content === 'string'
                ? { ...m, content: stripInvisibleChars(m.content) }
                : m));
        const options = {};
        if (Number.isFinite(body.temperature)) options.temperature = body.temperature;
        const result = await researchLLMAPI.callAPI(messages, null, options);
        const content = String(result?.choices?.[0]?.message?.content || '').trim();
        res.json({ success: true, model: researchLLMAPI.getCurrentAPIName(), content });
    } catch (error) {
        serverError(res, error);
    }
});

// 研究平台对话 + 自主工作调度：同样 requireHost，免登录但仅限本机
app.get('/api/research/bots', requireHost, (req, res) => {
    try {
        res.json({ success: true, bots: researchAgent.listBots() });
    } catch (error) {
        serverError(res, error);
    }
});

app.get('/api/research/chat', requireHost, (req, res) => {
    try {
        res.json({ success: true, ...researchAgent.loadChat() });
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/research/chat', requireHost, async (req, res) => {
    try {
        res.json(await researchAgent.chat((req.body || {}).message));
    } catch (error) {
        serverError(res, error);
    }
});

app.delete('/api/research/chat', requireHost, (req, res) => {
    try {
        res.json(researchAgent.clearChat());
    } catch (error) {
        serverError(res, error);
    }
});

app.get('/api/research/agent', requireHost, (req, res) => {
    try {
        res.json({ success: true, ...researchAgent.getStatus() });
    } catch (error) {
        serverError(res, error);
    }
});

// 开关自主模式 / 改间隔 / 换角色 / 手动叫醒她立刻跑一轮
app.post('/api/research/agent', requireHost, async (req, res) => {
    try {
        const body = req.body || {};
        if (body.runNow) {
            res.json(await researchAgent.runNow());
            return;
        }
        res.json({ success: true, ...researchAgent.updateConfig(body) });
    } catch (error) {
        serverError(res, error);
    }
});

}

module.exports = registerResearchRoutes;
