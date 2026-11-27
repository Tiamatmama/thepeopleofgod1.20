'use strict';

// 编程沙箱 + 编程团队 + 点子板 + 编码闭环（跟研究平台并列的自留地）。
// 由 server/index.js 通过 registerCodingRoutes(app, ctx) 装配；
// 门禁/归属/进度追踪器与各实例（toolRegistry/codingTeam/codingLoop/authModule）经 ctx 注入，
// 避免反向 require index.js 造成循环依赖。

function registerCodingRoutes(app, ctx) {
    const {
        requireCodingUser,
        codingOwner,
        CODING_CLOUD_MODE,
        discussProgress,
        reviewProgress,
        PROGRESS_ID_RE,
        normalizeProgressToken,
        toolRegistry,
        codingTeam,
        codingLoop,
        codingWorkers,
        codingCompetition,
        sandboxAgents,
        agentFleet,
        authModule,
        createReadTools,
        serverError
    } = ctx;

// 讨论/执行的对象工作区：优先用请求里选中的 taskId，解析出真实目录。
// 解析不到（没选 / 名字非法 / 目录不存在）返回 null，调用方退回沙箱项目根。
function resolveWorkspace(owner, taskId) {
    const id = toolRegistry.coding.safeTaskId(taskId);
    if (!id) return null;
    const found = toolRegistry.coding.listWorkspaces(owner).find(w => w.taskId === id);
    return found ? { taskId: found.taskId, dir: found.dir } : null;
}

// 讨论期只读工具的根必须跟着工作区走：否则团队读的是沙箱源码，
// 结论里会写 src/core/coding.js，而 Claude Code 在 ChessMaidBot 里根本找不到这些文件。
function readToolsFor(workspace) {
    return (workspace && createReadTools) ? createReadTools({ root: workspace.dir }) : null;
}

// 项目记忆 ↔ 团队讨论：讨论前注入 project.json 的只读投影，讨论后把结论写回 lessons。
// 这样团队开会时能看到闭环留下的进度/教训，闭环下一轮也能看到团队讨论的结论。
function projectMemoryText(owner, workspace) {
    if (!workspace) return '';
    try {
        return codingLoop.loadProjectMemory({ userId: owner, taskId: workspace.taskId });
    } catch (error) {
        console.error('[Coding] 读取项目记忆失败:', error.message);
        return '';
    }
}

function rememberDiscussion(owner, workspace, discussion) {
    if (!workspace || !discussion) return;
    try {
        const structured = discussion.structured || {};
        const consensus = Array.isArray(structured.consensus) ? structured.consensus : [];
        const actions = Array.isArray(structured.actions) ? structured.actions : [];
        const parts = [`【团队讨论】${String(discussion.topic || '').slice(0, 200)}`];
        if (consensus.length) parts.push(`共识：${consensus.slice(0, 5).join('；')}`);
        if (actions.length) parts.push(`动作：${actions.slice(0, 5).join('；')}`);
        if (consensus.length === 0 && actions.length === 0 && discussion.synthesis) {
            parts.push(`结论：${String(discussion.synthesis).slice(0, 600)}`);
        }
        codingLoop.appendProjectLesson({ userId: owner, taskId: workspace.taskId }, parts.join('\n'));
    } catch (error) {
        console.error('[Coding] 讨论结论写回项目记忆失败:', error.message);
    }
}

// ===== 编程沙箱 + 编程团队（跟研究平台并列的自留地）=====
// 门禁：requireCodingUser —— 默认「本机 + 需登录」，云端部署可设 CODING_ACCESS=cloud 放开来源限制。
// 身份键：登录用户名，工作区按用户隔离在 data/coding/workspaces/<userKey>/ 下。
// 页面：http://localhost:41888/coding.html

// 当前登录者与部署形态（前端据此决定是否显示「请先登录」引导）
app.get('/api/coding/me', requireCodingUser, (req, res) => {
    res.json({
        success: true,
        username: req.user.username,
        role: req.user.role,
        cloudMode: CODING_CLOUD_MODE
    });
});

app.get('/api/coding/tasks', requireCodingUser, (req, res) => {
    try {
        res.json({ success: true, tasks: toolRegistry.coding.listTasks(req.query.status) });
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/coding/tasks', requireCodingUser, (req, res) => {
    try {
        // createdBy 一律服务端派生（后置覆盖，禁止客户端伪造归属）
        res.json(toolRegistry.coding.addTask({ ...(req.body || {}), createdBy: codingOwner(req) }));
    } catch (error) {
        serverError(res, error);
    }
});

app.put('/api/coding/tasks/:id', requireCodingUser, (req, res) => {
    try {
        res.json(toolRegistry.coding.updateTask(req.params.id, req.body || {}));
    } catch (error) {
        serverError(res, error);
    }
});

app.delete('/api/coding/tasks/:id', requireCodingUser, (req, res) => {
    try {
        res.json(toolRegistry.coding.deleteTask(req.params.id));
    } catch (error) {
        serverError(res, error);
    }
});

app.get('/api/coding/scripts', requireCodingUser, (req, res) => {
    try {
        res.json({ success: true, scripts: toolRegistry.coding.listScripts() });
    } catch (error) {
        serverError(res, error);
    }
});

app.get('/api/coding/file', requireCodingUser, (req, res) => {
    try {
        res.json(toolRegistry.codeRead({ name: req.query.name }));
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/coding/run', requireCodingUser, async (req, res) => {
    try {
        res.json(await toolRegistry.codeRun(req.body || {}));
    } catch (error) {
        serverError(res, error);
    }
});

// 只写文件不运行（面板「只保存不运行」用）
app.post('/api/coding/save', requireCodingUser, (req, res) => {
    try {
        res.json(toolRegistry.codeWrite(req.body || {}));
    } catch (error) {
        serverError(res, error);
    }
});

app.get('/api/coding/runs', requireCodingUser, (req, res) => {
    try {
        res.json({ success: true, runs: toolRegistry.coding.recentRuns(req.query.limit) });
    } catch (error) {
        serverError(res, error);
    }
});

// 单次运行的完整事件流（对话追溯/回放）：读 data/coding/transcripts/<runId>.jsonl
app.get('/api/coding/runs/:runId', requireCodingUser, (req, res) => {
    try {
        res.json(toolRegistry.coding.readTranscript(req.params.runId, req.query.limit));
    } catch (error) {
        serverError(res, error);
    }
});

// 文件改动账本：路径/时间/动作/字节，按当前用户（可选 taskId）过滤
app.get('/api/coding/file-history', requireCodingUser, (req, res) => {
    try {
        res.json({
            success: true,
            changes: toolRegistry.coding.readFileChanges({
                userId: codingOwner(req),
                taskId: req.query.taskId,
                limit: req.query.limit
            })
        });
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/coding/open-vscode', requireCodingUser, async (req, res) => {
    try {
        res.json(await toolRegistry.openInVscode(toolRegistry.coding.workspace));
    } catch (error) {
        serverError(res, error);
    }
});

// 编程团队：可参与的人格清单（含各自抓点）
app.get('/api/coding/personas', requireCodingUser, (req, res) => {
    try {
        res.json({ success: true, personas: codingTeam.listPersonas() });
    } catch (error) {
        serverError(res, error);
    }
});

// 多人格方案讨论：开会 → 各人格发言 → 主控归纳，落 data/coding/discussions/
// body.clientToken 可选：带了对本次讨论做步进可见（前端轮询 status 回读），不带则行为与旧版一致。
app.post('/api/coding/discuss', requireCodingUser, async (req, res) => {
    const body = req.body || {};
    const token = normalizeProgressToken(body.clientToken);
    try {
        // 选了工作区就以它为讨论对象（只读工具钉在该目录）；没选则维持原行为（讨论沙箱项目本身）。
        const owner = codingOwner(req);
        const workspace = resolveWorkspace(owner, body.taskId);
        // 显式指定了工作区却解析不到：明确报错，绝不悄悄退回沙箱项目（否则结论又会落到别的工作区）。
        if (body.taskId && !workspace) {
            return res.status(400).json({ success: false, message: `工作区 ${body.taskId} 不存在或不可用，先刷新左侧列表` });
        }
        const result = await codingTeam.discuss({
            topic: body.topic,
            context: body.context,
            memory: projectMemoryText(owner, workspace),
            personaIds: body.personaIds,
            rounds: body.rounds,
            rebuttals: body.rebuttals,
            vote: body.vote,
            sessionId: body.sessionId,
            readTools: readToolsFor(workspace),
            workspace,
            onProgress: token ? (evt) => discussProgress.set(token, evt.phase) : null
        });
        rememberDiscussion(owner, workspace, result);
        res.json({ success: true, discussion: result, workspace });
    } catch (error) {
        serverError(res, error);
    } finally {
        // 无论成功/异常都清键，避免进度条目残留。
        if (token) discussProgress.end(token);
    }
});

// 讨论进度（深化十）：前端在 POST /discuss 在飞时轮询，读「跑到哪一步」。
// 未知/已结束/过期一律 busy:false；非法 id 明确 400。
app.get('/api/coding/discuss/status', requireCodingUser, (req, res) => {
    const id = String(req.query.id || '');
    if (!PROGRESS_ID_RE.test(id)) {
        return res.status(400).json({ success: false, message: '进度 id 不合法' });
    }
    const state = discussProgress.get(id);
    res.json(state.busy
        ? { success: true, busy: true, phase: state.phase, at: state.at }
        : { success: true, busy: false });
});

// 抓点监控：拿一段代码/日志/方案/任务板，各人格分别列问题。clientToken 语义同 discuss。
app.post('/api/coding/review', requireCodingUser, async (req, res) => {
    const body = req.body || {};
    const token = normalizeProgressToken(body.clientToken);
    try {
        res.json({ success: true, review: await codingTeam.review({
            target: body.target,
            kind: body.kind,
            personaIds: body.personaIds,
            autoTask: !!body.autoTask,
            sessionId: body.sessionId,
            onProgress: token ? (evt) => reviewProgress.set(token, evt.phase) : null
        }) });
    } catch (error) {
        serverError(res, error);
    } finally {
        if (token) reviewProgress.end(token);
    }
});

// 评审进度（深化十）：与 discuss/status 同构。
app.get('/api/coding/review/status', requireCodingUser, (req, res) => {
    const id = String(req.query.id || '');
    if (!PROGRESS_ID_RE.test(id)) {
        return res.status(400).json({ success: false, message: '进度 id 不合法' });
    }
    const state = reviewProgress.get(id);
    res.json(state.busy
        ? { success: true, busy: true, phase: state.phase, at: state.at }
        : { success: true, busy: false });
});

// 抓点闭环：把一次 review 的 findings 挑出来一键立成任务板条目
app.post('/api/coding/review/commit', requireCodingUser, (req, res) => {
    try {
        const body = req.body || {};
        const findings = Array.isArray(body.findings) ? body.findings : [];
        const created = codingTeam.findingsToTasks(findings, { kind: body.kind || 'review', topic: body.topic || '', discussionId: body.discussionId || '', createdBy: codingOwner(req) });
        res.json({ success: true, created });
    } catch (error) {
        serverError(res, error);
    }
});

// 巡检告警：自动巡检发现运行失败时留下的记录
app.get('/api/coding/alerts', requireCodingUser, (req, res) => {
    try {
        res.json({ success: true, alerts: toolRegistry.coding.recentAlerts(req.query.limit) });
    } catch (error) {
        serverError(res, error);
    }
});

// 手动触发一次巡检（面板按钮），不等定时器
app.post('/api/coding/patrol', requireCodingUser, async (req, res) => {
    try {
        const body = req.body || {};
        res.json(await codingTeam.patrolOnce({ sessionId: body.sessionId, personaIds: body.personaIds }));
    } catch (error) {
        serverError(res, error);
    }
});

app.get('/api/coding/discussions', requireCodingUser, (req, res) => {
    try {
        res.json({ success: true, discussions: toolRegistry.coding.listDiscussions(req.query.limit) });
    } catch (error) {
        serverError(res, error);
    }
});

// 讨论记录 id 白名单：生产端为 `disc_<ts>_<rand>` / `div_<ts>_<rand>`，只允许字母数字下划线连字符。
// 入口先校验，挡住 `..`（basename 不消除单段 `..`）、Windows 尾随空格/点、NTFS ADS（`:`）等路径穿越面。
const DISCUSSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
app.get('/api/coding/discussions/:id', requireCodingUser, (req, res) => {
    const id = String(req.params.id || '');
    if (!DISCUSSION_ID_RE.test(id)) {
        res.status(400).json({ success: false, message: '讨论 id 不合法' });
        return;
    }
    try {
        res.json(toolRegistry.coding.getDiscussion(id));
    } catch (error) {
        serverError(res, error);
    }
});

// ===== 方向三：点子板（灵感小组）+ spike =====

// 灵感小组成员清单（与工程评估者 personas 分开命名空间）
app.get('/api/coding/ideation/personas', requireCodingUser, (req, res) => {
    try {
        res.json({ success: true, personas: codingTeam.listIdeationPersonas() });
    } catch (error) {
        serverError(res, error);
    }
});

// 点子清单（可按 status 过滤 + limit 有界）
app.get('/api/coding/ideas', requireCodingUser, (req, res) => {
    try {
        res.json({ success: true, ideas: toolRegistry.coding.listIdeas({ status: req.query.status, limit: req.query.limit, sortBy: req.query.sort }) });
    } catch (error) {
        serverError(res, error);
    }
});

// 发散：灵感小组各出点子（狂想）→ 主控收敛 Top-N，落库并标 shortlisted
app.post('/api/coding/diverge', requireCodingUser, async (req, res) => {
    try {
        const body = req.body || {};
        res.json({ success: true, result: await codingTeam.diverge({
            topic: body.topic,
            context: body.context,
            personaIds: body.personaIds,
            perPersona: body.perPersona,
            topN: body.topN,
            sessionId: body.sessionId
        }) });
    } catch (error) {
        serverError(res, error);
    }
});

// 半自动（B）：把 shortlisted 点子立成任务板上的 spike 候选（只立项、不自动开跑）
app.post('/api/coding/ideas/shortlist', requireCodingUser, (req, res) => {
    try {
        res.json(codingTeam.shortlistIdeas({ ideaIds: (req.body || {}).ideaIds, createdBy: codingOwner(req) }));
    } catch (error) {
        serverError(res, error);
    }
});

// 人工一键开跑 spike：独立工作区隔离、小轮数、并发上限、幂等
app.post('/api/coding/spike/start', requireCodingUser, async (req, res) => {
    try {
        const body = { ...(req.body || {}), userId: codingOwner(req) };
        if (String(body.model || '').trim().toLowerCase() === 'custom') {
            const raw = authModule.getCustomApiConfigRaw(req.user.username);
            if (!raw || !raw.apiUrl) {
                return res.json({ success: false, error: '已选自定义通道，但还没配置自定义API：请在编程页「自定义API」里填好地址/密钥/模型并保存' });
            }
            body.userApiConfig = raw; // 含真实密钥，仅服务端内使用，不回传前端
        }
        res.json(await codingLoop.startSpike(body));
    } catch (error) {
        serverError(res, error);
    }
});

// spike 结论：读运行证据，判「支持/证伪/存疑」并写回 idea（不复用主闭环 pass）
app.post('/api/coding/spike/verdict', requireCodingUser, async (req, res) => {
    try {
        const body = req.body || {};
        const found = toolRegistry.coding.getIdea(body.ideaId);
        if (!found.success) return res.json({ success: false, error: found.error });
        // 未显式给 run 就取该 idea 对应 spike 工作区的最近一次运行作证据
        const run = body.run || (found.idea.spikeTaskId ? codingLoop.latestRun(found.idea.spikeTaskId) : null);
        res.json(await codingTeam.judgeSpike({ ideaId: body.ideaId, run, sessionId: body.sessionId, userId: codingOwner(req) }));
    } catch (error) {
        serverError(res, error);
    }
});

// ===== 编码闭环（L2）+ git 工作区（L1）+ 每用户面板状态 =====

// 闭环状态：当前在跑的任务 + 最近几次运行记录
app.get('/api/coding/loop/status', requireCodingUser, (req, res) => {
    try {
        res.json({ success: true, ...codingLoop.getStatus() });
    } catch (error) {
        serverError(res, error);
    }
});

// 启动一次编码闭环：{ taskId, goal, passCommand?, model?, thinking?, maxIterations?, timeoutMs?, sessionId? }
// model 可选，白名单 qwen / deepseek / custom（默认 deepseek = deepseek-flash），只影响本轮闭环。
// thinking 可选 enabled / disabled（DeepSeek 两档；qwen 常开关不掉），默认 enabled。
// custom 通道复用该登录用户在「自定义API配置」里保存的个人端点（编程页可直接填，两边同一份配置）。
app.post('/api/coding/loop/start', requireCodingUser, async (req, res) => {
    try {
        const body = { ...(req.body || {}), userId: codingOwner(req) };
        if (String(body.model || '').trim().toLowerCase() === 'custom') {
            const raw = authModule.getCustomApiConfigRaw(req.user.username);
            if (!raw || !raw.apiUrl) {
                return res.json({ success: false, error: '已选自定义通道，但还没配置自定义API：请在编程页「自定义API」里填好地址/密钥/模型并保存' });
            }
            body.userApiConfig = raw; // 含真实密钥，仅服务端内使用，不回传前端
        }
        res.json(await codingLoop.start(body));
    } catch (error) {
        serverError(res, error);
    }
});

// 请求停止当前闭环（跑到这一轮末回滚到最近绿点后退出）
app.post('/api/coding/loop/stop', requireCodingUser, (req, res) => {
    try {
        res.json(codingLoop.stop((req.body || {}).taskId));
    } catch (error) {
        serverError(res, error);
    }
});

// 回答开跑前的澄清问题：{ taskId, answers:[{ id, answer }] }
// 答案会拼进后续 kickoff 作为硬约束，然后闭环继续跑；归属按登录用户校验。
app.post('/api/coding/loop/answer', requireCodingUser, (req, res) => {
    try {
        const body = req.body || {};
        res.json(codingLoop.answer({
            taskId: body.taskId,
            answers: body.answers,
            userId: codingOwner(req)
        }));
    } catch (error) {
        serverError(res, error);
    }
});

// 从任务板一键开跑：按任务 params.kind 分派（spike 候选 → spike；idea-promoted 候选 → 实现闭环）。
// userId 一律服务端派生（codingOwner），不接受客户端传入，避免越权在别人工作区开跑。
app.post('/api/coding/tasks/:id/start', requireCodingUser, async (req, res) => {
    try {
        const body = { ...(req.body || {}) };
        if (String(body.model || '').trim().toLowerCase() === 'custom') {
            const raw = authModule.getCustomApiConfigRaw(req.user.username);
            if (!raw || !raw.apiUrl) {
                return res.json({ success: false, error: '已选自定义通道，但还没配置自定义API：请在编程页「自定义API」里填好地址/密钥/模型并保存' });
            }
            body.userApiConfig = raw; // 含真实密钥，仅服务端内使用，不回传前端
        }
        const result = await codingLoop.startFromTask({
            taskId: req.params.id,
            userId: codingOwner(req),
            sessionId: body.sessionId,
            model: body.model,
            maxIterations: body.maxIterations,
            userApiConfig: body.userApiConfig,
            webCheck: body.webCheck,
            healthCheck: body.healthCheck,
            stages: body.stages,
            deploy: body.deploy,
            plan: body.plan
        });
        // 按失败码映射 HTTP 状态；响应体补 message，供前端 api() 兜底显示人话
        if (result && result.success === false) {
            const status = { not_found: 404, forbidden: 403, conflict: 409, done: 409, unsupported_kind: 400 }[result.code] || 200;
            return res.status(status).json({ ...result, message: result.error });
        }
        res.json(result);
    } catch (error) {
        serverError(res, error);
    }
});

// ===== 沙箱内的 Claude Code 执行器（多 Agent 联动）=====
// 与编码闭环并列：codingLoop 用内置工具循环直连底模；这里把「真正改代码」交给本机的 Claude Code CLI，
// cwd 锁在该用户的 git 工作区 data/coding/workspaces/<用户>/<taskId>/，模型请求统一走本地中转站（同端口 /relay）。
// 运行事件经 WebSocket 以 {type:'coding-event', kind:'agent_*'} 广播，前端按 owner/taskId 过滤。

// 当前用户的 Claude Code 运行记录（内存里保留最近 50 条）
app.get('/api/coding/agents', requireCodingUser, (req, res) => {
    try {
        if (!sandboxAgents) return res.json({ success: false, error: 'Claude Code 执行器未启用' });
        res.json({ success: true, runs: sandboxAgents.list(codingOwner(req)) });
    } catch (error) {
        serverError(res, error);
    }
});

// 直接启动一次：{ taskId, prompt, model?, title? }；userId 一律服务端派生
app.post('/api/coding/agents/start', requireCodingUser, (req, res) => {
    try {
        if (!sandboxAgents) return res.json({ success: false, error: 'Claude Code 执行器未启用' });
        const body = req.body || {};
        const result = sandboxAgents.start({
            userId: codingOwner(req),
            taskId: body.taskId,
            prompt: body.prompt,
            model: body.model,
            title: body.title
        });
        if (result && result.success === false) {
            const status = { conflict: 409, busy: 429 }[result.code] || 200;
            return res.status(status).json({ ...result, message: result.error });
        }
        res.json(result);
    } catch (error) {
        serverError(res, error);
    }
});

// 先让多人格团队开会（共识 + 动作清单），再把结论交给 Claude Code 在工作区里落地。
// body: { topic, context?, taskId, model?, personaIds?, rounds?, title? }
app.post('/api/coding/agents/team', requireCodingUser, async (req, res) => {
    const body = req.body || {};
    const token = normalizeProgressToken(body.clientToken);
    try {
        if (!sandboxAgents) return res.json({ success: false, error: 'Claude Code 执行器未启用' });
        const topic = String(body.topic || '').trim();
        if (!topic) return res.json({ success: false, error: '缺少讨论议题 topic' });
        // 执行必须有明确的工作区：讨论与执行都钉在同一个真实目录上。
        const owner = codingOwner(req);
        const workspace = resolveWorkspace(owner, body.taskId);
        if (!workspace) return res.status(400).json({ success: false, message: `工作区 ${body.taskId || '（未选）'} 不存在或不可用，先刷新左侧列表` });

        const discussion = await codingTeam.discuss({
            topic,
            context: body.context,
            memory: projectMemoryText(owner, workspace),
            personaIds: body.personaIds,
            rounds: body.rounds,
            sessionId: body.sessionId,
            readTools: readToolsFor(workspace),
            workspace,
            onProgress: token ? (evt) => discussProgress.set(token, evt.phase) : null
        });
        rememberDiscussion(owner, workspace, discussion);

        const structured = (discussion && discussion.structured) || {};
        const consensus = Array.isArray(structured.consensus) ? structured.consensus : [];
        const actions = Array.isArray(structured.actions) ? structured.actions : [];
        const bullet = (items) => items.map((item, idx) => `${idx + 1}. ${item}`).join('\n');

        const parts = [
            `你正在沙箱工作区里执行一个已经过多 Agent 讨论的需求。`,
            `【目标工作区】${workspace.taskId}`,
            `【工作区真实路径】${workspace.dir}`,
            `【讨论主题】${topic}`
        ];
        if (body.context) parts.push(`【任务背景】${String(body.context).slice(0, 4000)}`);
        if (consensus.length) parts.push(`【团队共识】\n${bullet(consensus)}`);
        if (actions.length) parts.push(`【下一步动作】\n${bullet(actions)}`);
        if (!consensus.length && !actions.length && discussion && discussion.synthesis) {
            parts.push(`【团队结论】\n${String(discussion.synthesis).slice(0, 6000)}`);
        }
        parts.push([
            '【执行要求】',
            '- 只改当前工作目录（本任务工作区）内的文件，不要动工作区之外的内容。',
            '- 当前工作目录里的实际文件是唯一事实来源；结论里提到的路径若在这里不存在，不要臆造，按实际结构落地或直接说明差异。',
            '- 按「下一步动作」落地；动作与共识冲突时以共识为准。',
            '- 完成后用一段话总结：改了哪些文件、怎么验证的、还有什么没做。'
        ].join('\n'));

        const result = sandboxAgents.start({
            userId: codingOwner(req),
            taskId: body.taskId,
            prompt: parts.join('\n\n'),
            model: body.model,
            title: body.title || topic
        });
        if (result && result.success === false) {
            const status = { conflict: 409, busy: 429 }[result.code] || 200;
            return res.status(status).json({ success: false, ...result, discussion });
        }
        res.json({ success: true, discussion, workspace, run: result.run });
    } catch (error) {
        serverError(res, error);
    } finally {
        if (token) discussProgress.end(token);
    }
});

// 单次运行详情（只允许看自己的）
app.get('/api/coding/agents/:runId', requireCodingUser, (req, res) => {
    try {
        if (!sandboxAgents) return res.json({ success: false, error: 'Claude Code 执行器未启用' });
        res.json(sandboxAgents.get(req.params.runId, codingOwner(req)));
    } catch (error) {
        serverError(res, error);
    }
});

// 停止（Windows 下连子进程树一起结束）
app.post('/api/coding/agents/:runId/stop', requireCodingUser, (req, res) => {
    try {
        if (!sandboxAgents) return res.json({ success: false, error: 'Claude Code 执行器未启用' });
        const owned = sandboxAgents.get(req.params.runId, codingOwner(req));
        if (!owned.success) return res.json(owned);
        res.json(sandboxAgents.stop(req.params.runId));
    } catch (error) {
        serverError(res, error);
    }
});

// ===== 工人池（代理式车间）：自动领单 + 并发执行 + 回写任务板 =====
// 与「一键开跑」的关系：一键开跑是人工派单，工人池是调度器——按名额从板上自动领「声明了目标」的任务，
// 复用同一个编码闭环执行，跑完把结果回写任务板。默认不开自动（auto=false），要显式开开关才会自动领单。

// 工人池状态：在跑工人、待领任务数、自动开关、最近领单记录
app.get('/api/coding/workers/status', requireCodingUser, (req, res) => {
    try {
        if (!codingWorkers) return res.json({ success: false, error: '工人池未启用' });
        res.json({ success: true, ...codingWorkers.status() });
    } catch (error) {
        serverError(res, error);
    }
});

// 手动领单一次（不依赖自动开关）：先收工回写，再按名额派新单。适合点一下看效果。
app.post('/api/coding/workers/tick', requireCodingUser, async (req, res) => {
    try {
        if (!codingWorkers) return res.json({ success: false, error: '工人池未启用' });
        res.json({ success: true, ...(await codingWorkers.tick()) });
    } catch (error) {
        serverError(res, error);
    }
});

// 自动开关：{ enabled: true } 开自动领单，{ enabled: false } 关（已在跑的工人不打断，跑完照常回写）
app.post('/api/coding/workers/auto', requireCodingUser, (req, res) => {
    try {
        if (!codingWorkers) return res.json({ success: false, error: '工人池未启用' });
        const enabled = !!(req.body || {}).enabled;
        const snap = enabled ? codingWorkers.start() : codingWorkers.stop();
        res.json({ success: true, ...snap });
    } catch (error) {
        serverError(res, error);
    }
});

// ===== 编程竞赛（竞技场）：同一目标 + 同一份初始工作区 + 有限 token 预算，多候选竞争 =====
// 与工人池的关系：工人池各领各的任务；竞技场是多个工人抢同一道题，跑完按硬指标排名。
// 三个接口都只压在 requireCodingUser 后面，owner 由 codingOwner 解析，默认只能看见自己的竞赛。

// 开赛：{ goal, candidates?: 3 | [{name, model}], tokenBudget?, maxIterations?, baseTaskId?, concurrency? }
app.post('/api/coding/compete/start', requireCodingUser, (req, res) => {
    try {
        if (!codingCompetition) return res.json({ success: false, error: '竞赛模块未启用' });
        const body = req.body || {};
        res.json(codingCompetition.start({
            userId: codingOwner(req),
            goal: body.goal,
            candidates: body.candidates,
            tokenBudget: body.tokenBudget,
            maxIterations: body.maxIterations,
            baseTaskId: body.baseTaskId,
            model: body.model,
            concurrency: body.concurrency
        }));
    } catch (error) {
        serverError(res, error);
    }
});

// 查赛况：/api/coding/compete/status?id=<竞赛 id>
app.get('/api/coding/compete/status', requireCodingUser, (req, res) => {
    try {
        if (!codingCompetition) return res.json({ success: false, error: '竞赛模块未启用' });
        res.json(codingCompetition.status(req.query.id, codingOwner(req)));
    } catch (error) {
        serverError(res, error);
    }
});

// 历史竞赛：只返回当前用户（admin 可带 ?owner=）的最近 30 场
app.get('/api/coding/compete/list', requireCodingUser, (req, res) => {
    try {
        if (!codingCompetition) return res.json({ success: false, error: '竞赛模块未启用' });
        res.json(codingCompetition.list(codingOwner(req)));
    } catch (error) {
        serverError(res, error);
    }
});

// 叫停：把所有还在跑的候选停掉，已跑完的保留结果
app.post('/api/coding/compete/stop', requireCodingUser, (req, res) => {
    try {
        if (!codingCompetition) return res.json({ success: false, error: '竞赛模块未启用' });
        const id = (req.body || {}).id;
        res.json(codingCompetition.stop(id, codingOwner(req)));
    } catch (error) {
        serverError(res, error);
    }
});

// 列出当前用户的工作区（admin 可用 ?owner=<用户名> 查看他人）
app.get('/api/coding/workspaces', requireCodingUser, (req, res) => {
    try {
        res.json({ success: true, workspaces: toolRegistry.coding.listWorkspaces(codingOwner(req)) });
    } catch (error) {
        serverError(res, error);
    }
});

// 新建（或复用）一个 git 工作区，创建即按给定信任档初始化
app.post('/api/coding/workspace/create', requireCodingUser, (req, res) => {
    try {
        const body = req.body || {};
        const userId = codingOwner(req);
        const result = toolRegistry.coding.createWorkspace(userId, body.taskId);
        if (result.success && body.trust) {
            const trust = toolRegistry.coding.setTrustLevel(userId, body.taskId, body.trust);
            result.trust = trust.success ? trust.level : undefined;
        }
        res.json(result);
    } catch (error) {
        serverError(res, error);
    }
});

// 删除工作区：junction/符号链接只摘链接，真实目录才递归删（详见 CodingCenter.deleteWorkspace）
app.delete('/api/coding/workspace/:taskId', requireCodingUser, (req, res) => {
    try {
        res.json(toolRegistry.coding.deleteWorkspace(codingOwner(req), req.params.taskId));
    } catch (error) {
        serverError(res, error);
    }
});

// 在文件管理器中打开工作区目录
app.post('/api/coding/reveal', requireCodingUser, (req, res) => {
    try {
        res.json(toolRegistry.coding.revealInExplorer(codingOwner(req), (req.body || {}).taskId));
    } catch (error) {
        serverError(res, error);
    }
});

// 浏览本地目录树（给"导入本地目录"弹窗用）
app.get('/api/coding/browse', requireCodingUser, (req, res) => {
    try {
        res.json(toolRegistry.coding.browseDirs(req.query.dir || ''));
    } catch (error) {
        serverError(res, error);
    }
});

// 导入本地目录为工作区（Windows junction，免管理员权限）
app.post('/api/coding/import-dir', requireCodingUser, (req, res) => {
    try {
        const body = req.body || {};
        const userId = codingOwner(req);
        const result = toolRegistry.coding.importDir(userId, body.taskId, body.sourcePath);
        if (result.success && body.trust) {
            // 工作区名可能留空由后端自动派生，这里用返回的真实 taskId 落信任档，别用请求里的空值
            const trust = toolRegistry.coding.setTrustLevel(userId, result.taskId || body.taskId, body.trust);
            result.trust = trust.success ? trust.level : undefined;
        }
        res.json(result);
    } catch (error) {
        serverError(res, error);
    }
});

// 单个工作区的 git 状态（分支 / 是否干净）
app.get('/api/coding/workspace/status', requireCodingUser, (req, res) => {
    try {
        res.json(toolRegistry.coding.workspaceStatus(codingOwner(req), req.query.taskId));
    } catch (error) {
        serverError(res, error);
    }
});

// 手动回滚：把工作区退到指定提交。
// 只允许当前 HEAD 的祖先，避免误切到别的分支；未跟踪文件保持原样（不做 git clean）。
app.post('/api/coding/rollback', requireCodingUser, (req, res) => {
    try {
        const userId = codingOwner(req);
        const body = req.body || {};
        const taskId = toolRegistry.coding.safeTaskId(body.taskId);
        if (!taskId) return res.status(400).json({ success: false, error: 'taskId 非法' });
        const sha = String(body.sha || '').trim();
        if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
            return res.status(400).json({ success: false, error: 'sha 非法（只接受 7-40 位十六进制）' });
        }
        const verified = toolRegistry.coding.git(userId, taskId, ['rev-parse', '--verify', `${sha}^{commit}`]);
        if (!verified.success) {
            return res.status(400).json({ success: false, error: '提交不存在' });
        }
        const ancestor = toolRegistry.coding.git(userId, taskId, ['merge-base', '--is-ancestor', sha, 'HEAD']);
        if (!ancestor.success) {
            return res.status(400).json({ success: false, error: '只能回滚到当前分支的历史提交' });
        }
        const result = toolRegistry.coding.git(userId, taskId, ['reset', '--hard', sha]);
        res.json({
            success: !!result.success,
            sha,
            output: result.output || '',
            error: result.success ? undefined : (result.error || result.output || '回滚失败')
        });
    } catch (error) {
        serverError(res, error);
    }
});

// 文件树：当前用户的工作区列表 + 指定工作区的目录树
app.get('/api/coding/tree', requireCodingUser, (req, res) => {
    try {
        const userId = codingOwner(req);
        const taskId = toolRegistry.coding.safeTaskId(req.query.taskId);
        const workspaces = toolRegistry.coding.listWorkspaces(userId);
        let entries = [];
        let note = '';
        if (taskId) {
            const listed = toolRegistry.codeListDir({ userId, taskId, path: req.query.path || '.', depth: req.query.depth });
            if (listed.success) entries = listed.entries || [];
            else note = listed.error || '读取目录失败';
        }
        res.json({ success: true, userId, workspaces, taskId: taskId || '', entries, note });
    } catch (error) {
        serverError(res, error);
    }
});

// 跨会话项目记忆（只读）：把 project.json 的只读投影给编码页「项目」Tab。
// 404 = 工作区不存在（taskId 非法/穿越/数组/空，或 taskDir 不存在）；存在但无项目记忆是空态 200。
app.get('/api/coding/project', requireCodingUser, (req, res) => {
    try {
        const taskId = req.query.taskId;
        if (typeof taskId !== 'string' || !toolRegistry.coding.safeTaskId(taskId)) {
            return res.status(404).json({ success: false, message: '工作区不存在' });
        }
        const result = codingLoop.readProjectMemory(codingOwner(req), taskId);
        if (!result.exists) {
            return res.status(404).json({ success: false, message: '工作区不存在' });
        }
        res.json({ success: true, project: result.project });
    } catch (error) {
        serverError(res, error);
    }
});

// 读工作区内的文件内容（带行号，供右侧代码面板）
app.get('/api/coding/ws/file', requireCodingUser, (req, res) => {
    try {
        const userId = codingOwner(req);
        res.json(toolRegistry.codeReadRange({
            userId,
            taskId: req.query.taskId,
            path: req.query.path,
            startLine: req.query.startLine,
            endLine: req.query.endLine
        }));
    } catch (error) {
        serverError(res, error);
    }
});

// 写回工作区文件：编辑器里 Ctrl+S 直接保存，不再绕道让 agent 打 patch。
// 这里是人主动保存，覆盖是明确意图，故 overwrite:true；测试目录仍由 codeWriteFile 拦截。
app.post('/api/coding/ws/file', requireCodingUser, (req, res) => {
    try {
        const body = req.body || {};
        res.json(toolRegistry.codeWriteFile({
            userId: codingOwner(req),
            taskId: body.taskId,
            path: body.path,
            content: body.content,
            overwrite: true
        }));
    } catch (error) {
        serverError(res, error);
    }
});

// 逐块审阅的基线：取 git HEAD 里的同一文件，和当前工作区内容对照。
// 没有基线（未提交过/未跟踪）时 hasBaseline:false，前端只提示、不伪造空文件。
app.get('/api/coding/ws/diff', requireCodingUser, (req, res) => {
    try {
        const userId = codingOwner(req);
        const current = toolRegistry.codeReadRange({
            userId,
            taskId: req.query.taskId,
            path: req.query.path
        });
        if (current.success === false) return res.json(current);
        const base = toolRegistry.coding.git(userId, req.query.taskId, ['show', `HEAD:${current.path}`]);
        res.json({
            success: true,
            path: current.path,
            current: String(current.content || ''),
            baseline: base.success ? String(base.output || '') : '',
            hasBaseline: !!base.success
        });
    } catch (error) {
        serverError(res, error);
    }
});

// 每用户面板状态：打开了哪些文件 / 当前激活文件 / 各任务信任档
app.get('/api/coding/state', requireCodingUser, (req, res) => {
    try {
        res.json({ success: true, state: toolRegistry.coding.getUiState(codingOwner(req)) });
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/coding/state', requireCodingUser, (req, res) => {
    try {
        res.json(toolRegistry.coding.saveUiState(codingOwner(req), req.body || {}));
    } catch (error) {
        serverError(res, error);
    }
});

// 信任三档：读 / 写（readonly / ask / auto）
app.get('/api/coding/trust', requireCodingUser, (req, res) => {
    try {
        res.json({
            success: true,
            levels: ['readonly', 'ask', 'auto'],
            level: toolRegistry.coding.getTrustLevel(codingOwner(req), req.query.taskId)
        });
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/coding/trust', requireCodingUser, (req, res) => {
    try {
        const body = req.body || {};
        res.json(toolRegistry.coding.setTrustLevel(codingOwner(req), body.taskId, body.level));
    } catch (error) {
        serverError(res, error);
    }
});

// 挂起的审批：页面掉线重连后补拉，避免错过确认弹窗
app.get('/api/coding/approvals', requireCodingUser, (req, res) => {
    try {
        res.json({ success: true, approvals: toolRegistry.listPendingApprovals(codingOwner(req)) });
    } catch (error) {
        serverError(res, error);
    }
});

// HTTP 版审批响应（WebSocket 之外的兜底通道）
app.post('/api/coding/approvals/:id', requireCodingUser, (req, res) => {
    try {
        const body = req.body || {};
        const matched = toolRegistry.resolveApproval(req.params.id, body.approved === true, body.reason);
        res.json({ success: matched });
    } catch (error) {
        serverError(res, error);
    }
});

// ===== Agent 集群（16 槽：4 写手 + 12 侦察）=====
// 集群子任务不写任务板；owner 一律服务端派生。plan 只生成 manifest，dispatch 才真正占用工作区。
// 与工人池/Claude Code 的互斥在 AgentFleet.sourceBusy 里做，这里只负责转发错误。

app.get('/api/coding/fleet/list', requireCodingUser, (req, res) => {
    try {
        if (!agentFleet) return res.json({ success: false, error: '集群模块未启用' });
        res.json({ success: true, ...agentFleet.list(codingOwner(req)) });
    } catch (error) {
        serverError(res, error);
    }
});

// 规划：{ goal, writers?, scouts?, sourceTaskId?, tokenBudget? }
app.post('/api/coding/fleet/plan', requireCodingUser, async (req, res) => {
    try {
        if (!agentFleet) return res.json({ success: false, error: '集群模块未启用' });
        const body = req.body || {};
        res.json(await agentFleet.plan({
            userId: codingOwner(req),
            goal: body.goal,
            writers: body.writers,
            scouts: body.scouts,
            sourceTaskId: body.sourceTaskId,
            tokenBudget: body.tokenBudget
        }));
    } catch (error) {
        serverError(res, error);
    }
});

// 派发：{ fleetId, manifests? } —— manifests 允许用户在派发前手改写集/读集
app.post('/api/coding/fleet/dispatch', requireCodingUser, async (req, res) => {
    try {
        if (!agentFleet) return res.json({ success: false, error: '集群模块未启用' });
        const body = req.body || {};
        res.json(await agentFleet.dispatch({
            userId: codingOwner(req),
            fleetId: body.fleetId,
            manifests: body.manifests
        }));
    } catch (error) {
        serverError(res, error);
    }
});

// 状态：?fleetId= 指定一场（兼容 spec 的 ?id=）；不传则返回当前用户最近 20 场
app.get('/api/coding/fleet/status', requireCodingUser, (req, res) => {
    try {
        if (!agentFleet) return res.json({ success: false, error: '集群模块未启用' });
        const fleetId = String(req.query.fleetId || req.query.id || '').trim();
        if (!fleetId) return res.json({ success: true, ...agentFleet.list(codingOwner(req)) });
        res.json(agentFleet.status(fleetId, codingOwner(req)));
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/coding/fleet/pause', requireCodingUser, (req, res) => {
    try {
        if (!agentFleet) return res.json({ success: false, error: '集群模块未启用' });
        const body = req.body || {};
        res.json(agentFleet.pause(body.fleetId || body.id, codingOwner(req)));
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/coding/fleet/resume', requireCodingUser, (req, res) => {
    try {
        if (!agentFleet) return res.json({ success: false, error: '集群模块未启用' });
        const body = req.body || {};
        res.json(agentFleet.resume(body.fleetId || body.id, codingOwner(req)));
    } catch (error) {
        serverError(res, error);
    }
});

// 停止：断掉所有写手闭环 + 侦察 + 监控，释放全部租约
app.post('/api/coding/fleet/stop', requireCodingUser, async (req, res) => {
    try {
        if (!agentFleet) return res.json({ success: false, error: '集群模块未启用' });
        const body = req.body || {};
        res.json(await agentFleet.stop(body.fleetId || body.id, codingOwner(req)));
    } catch (error) {
        serverError(res, error);
    }
});

}

module.exports = registerCodingRoutes;
