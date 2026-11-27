const fs = require('fs');
const path = require('path');
const { stripInvisibleChars } = require('./textGuard');

// 研究平台里的「她」😀
// 一头连着真实大模型（复用 output.callWithTools 的工具循环，research_* 工具照常免授权），
// 一头连着任务板/工作台；既能在页面上跟用户对话，也能被定时器叫醒自己去干活。
// 对话与配置全落在 data/research/ 下，跟主会话的情绪/好感度/记忆完全隔开，互不污染。

const CHAT_FILE = 'chat.json';
const CONFIG_FILE = 'agent_config.json';
const TICK_CHECK_MS = 20 * 1000;   // 定时器每隔 20 秒醒来看一眼到点没
const HISTORY_LIMIT = 14;         // 每次喂给模型的最近对话条数
const CHAT_KEEP = 200;            // 聊天记录落盘最多留多少条
const MIN_INTERVAL_MIN = 5;       // 自主轮最小间隔，再短就太烧钱啦 💸
const RESEARCH_USER_ID = 'research-platform'; // 工具上下文里的固定 userId，跟真人用户隔开

const DEFAULT_CONFIG = {
  enabled: false,        // 自主工作总开关，默认关，用户手动开
  intervalMin: 30,       // 每隔多少分钟自己干一轮
  sessionId: '',         // 绑定哪个角色（拿角色卡用）
  lastTickAt: 0,         // 上一轮自主工作的时间戳
  running: false,        // 此刻是不是正在跑（前端拿来显示「她正在工作」）
  lastError: '',
  // 研究轮默认关思考：DeepSeek 的 CoT 按输出计费，而这一轮的正文只要求「一两句话汇报」，
  // 开着思考等于把输出大头花在看不见的推理上（实测单次约 950 字推理 / 993 次调用）。
  thinking: false,
  // 单次生成上限：脚本正文/笔记正文都算输出，默认给 8k 留足写脚本的余量，同时挡住失控长文
  maxTokens: 8192
};

class ResearchAgent {
  // research: ResearchCenter（任务板/目录）；outputModule: 正式回复模块（工具循环）；
  // sessionManager: 取角色卡
  constructor({ research, outputModule, sessionManager }) {
    this.research = research;
    this.outputModule = outputModule;
    this.sessionManager = sessionManager;
    this.dir = research.dir;
    this.chatFile = path.join(this.dir, CHAT_FILE);
    this.configFile = path.join(this.dir, CONFIG_FILE);
    this.timer = null;
    this.busy = false; // 进程级防重入：上一轮没跑完绝不开下一轮
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.chatFile)) {
      fs.writeFileSync(this.chatFile, JSON.stringify({ messages: [] }, null, 2), 'utf8');
    }
  }

  // ---- 角色清单 / 配置 ----

  // 列出本机所有角色，供页面下拉选「这次让谁在研究平台干活」
  listBots() {
    if (!this.sessionManager) return [];
    return this.sessionManager.getAllSessions().map(s => ({
      sessionId: s.sessionId,
      name: this.sessionManager.getSessionName(s)
    }));
  }

  // 没绑定过就默认挑「小助手」，挑不到就退回第一个角色
  resolveDefaultSessionId() {
    const bots = this.listBots();
    if (!bots.length) return '';
    const her = bots.find(b => b.name.includes('小助手'));
    return (her || bots[0]).sessionId;
  }

  loadConfig() {
    let cfg = { ...DEFAULT_CONFIG };
    try {
      if (fs.existsSync(this.configFile)) {
        cfg = { ...cfg, ...JSON.parse(fs.readFileSync(this.configFile, 'utf8')) };
      }
    } catch (error) {
      console.error('[ResearchAgent] 配置读坏了，用默认值:', error.message);
    }
    if (!cfg.sessionId) {
      cfg.sessionId = this.resolveDefaultSessionId();
    }
    return cfg;
  }

  saveConfig(cfg) {
    fs.writeFileSync(this.configFile, JSON.stringify(cfg, null, 2), 'utf8');
  }

  updateConfig(patch = {}) {
    const cfg = this.loadConfig();
    if (typeof patch.enabled === 'boolean') cfg.enabled = patch.enabled;
    if (patch.intervalMin !== undefined) {
      const mins = Math.max(MIN_INTERVAL_MIN, parseInt(patch.intervalMin, 10) || cfg.intervalMin);
      cfg.intervalMin = mins;
    }
    if (patch.sessionId !== undefined) {
      // 允许传角色名或 sessionId，怎么方便怎么来
      let sid = String(patch.sessionId || '').trim();
      if (sid && !this.sessionManager.getSession(sid)) {
        const found = this.sessionManager.findByName(sid);
        sid = found ? found.sessionId : '';
      }
      if (sid) cfg.sessionId = sid;
    }
    if (typeof patch.thinking === 'boolean') cfg.thinking = patch.thinking;
    if (patch.maxTokens !== undefined) {
      const n = parseInt(patch.maxTokens, 10);
      if (Number.isFinite(n)) cfg.maxTokens = Math.max(512, Math.min(n, 16384));
    }
    this.saveConfig(cfg);
    return this.getStatus();
  }

  // 给前端看的状态（running 以内存锁为准，配置文件里的只作兜底）
  getStatus() {
    const cfg = this.loadConfig();
    return {
      enabled: cfg.enabled,
      intervalMin: cfg.intervalMin,
      sessionId: cfg.sessionId,
      lastTickAt: cfg.lastTickAt,
      running: this.busy,
      lastError: cfg.lastError || '',
      thinking: cfg.thinking === true,
      maxTokens: cfg.maxTokens,
      bots: this.listBots(),
      nextTickAt: cfg.enabled && cfg.lastTickAt
        ? cfg.lastTickAt + cfg.intervalMin * 60000
        : 0
    };
  }

  // ---- 聊天记录 ----

  loadChat() {
    try {
      const data = JSON.parse(fs.readFileSync(this.chatFile, 'utf8'));
      return { messages: Array.isArray(data.messages) ? data.messages : [] };
    } catch (error) {
      return { messages: [] };
    }
  }

  appendMessage(msg) {
    const store = this.loadChat();
    store.messages.push({
      role: msg.role,
      content: String(msg.content || ''),
      ts: Date.now(),
      auto: !!msg.auto
    });
    // 超量就砍最旧的，别让文件无限长胖 🐷
    if (store.messages.length > CHAT_KEEP) {
      store.messages = store.messages.slice(-CHAT_KEEP);
    }
    fs.writeFileSync(this.chatFile, JSON.stringify(store, null, 2), 'utf8');
  }

  clearChat() {
    fs.writeFileSync(this.chatFile, JSON.stringify({ messages: [] }, null, 2), 'utf8');
    return { success: true };
  }

  // ---- 提示词 ----

  buildSystemPrompt(sessionId, autonomous) {
    const characterPrompt = this.sessionManager.buildCharacterPrompt(sessionId) || '你是用户的 AI 伙伴。';
    const now = new Date();
    const clock = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return `${characterPrompt}

【研究平台工作模式】现在是 ${clock}，你正处在自己名下的研究平台上（http://localhost 的本机页面）。这里有一套免授权工具归你调：
- research_task_list / research_task_add / research_task_update：管理你的研究任务板
- research_search：搜 arXiv 论文（source=papers）和各源新闻（source=news）
- research_run：把 Python / Node 脚本写进工作台并直接运行（单次最长 10 分钟），用来验证想法、处理数据
- research_note_save：写研究方向笔记
- research_open_page：把平台页面弹到用户屏幕上
- 编码沙箱（同样免授权）：先用 code_workspace_create 开一个工作区（taskId 只含字母/数字/下划线/连字符），再用 code_list_dir / code_read_range / code_search 看代码、code_apply_patch 做精确编辑、code_run_tests 跑测试、code_diagnose 看语法、code_git 看 diff 打检查点；写/跑/提交在这里全程免授权，尽管用
- 真模型接口：工作台目录里有 llm_client.py（同目录直接 import 就能用），底层是本机免授权的 POST http://localhost:${process.env.SERVER_PORT || '41888'}/api/research/llm。需要模型批量处理/打标/抽取时用它，别再用脚本硬编规则冒充模型结果
铁律：
1. 你声称做过的事，必须是这一轮真的调用工具、且工具返回成功的；工具没返回成功就不许汇报成功，更不许编造数据、论文和运行结果
2. 干活要留痕：立项用 research_task_add，开干置 doing，做完置 done 并把结论写进 result；结论必须来自脚本真实输出或搜索到的真实条目（给出处）
3. 脚本跑失败就看报错改了再跑，别把失败说成成功
4. 跟用户说话保持你自己的角色语气，简短自然，一次别写小作文${autonomous ? `
5. 这是无人值守的自主工作时间：每轮至少推进一件具体的事，任务板空着就自己立项；实在没有新方向时再收工
6. 干完用一两句话向用户汇报这轮做了什么（他会在平台对话区看到），不许提「定时器/系统/自主模式」这类词` : `
5. 用户在平台页面上直接跟你说话，他能看到任务板、笔记和运行结果，所以你不用转述工具原始输出，说重点就行`}`;
  }

  // 跑一轮完整对话（带工具循环），返回她的正文
  async runTurn({ userText, autonomous = false, temperature = null }) {
    const cfg = this.loadConfig();
    const sessionId = cfg.sessionId || this.resolveDefaultSessionId();
    if (!sessionId) {
      throw new Error('还没有任何角色，先去主界面创建一个角色吧');
    }
    const systemPrompt = this.buildSystemPrompt(sessionId, autonomous);

    // 历史只取最近几条，老对话不必每轮都背
    const history = this.loadChat().messages.slice(-HISTORY_LIMIT);
    const messages = [{ role: 'system', content: systemPrompt }];
    history.forEach(m => {
      if (m.role === 'user' || m.role === 'assistant') {
        messages.push({ role: m.role, content: m.content });
      }
    });
    messages.push({ role: 'user', content: userText });

    const options = {
      sessionId,
      userId: RESEARCH_USER_ID,
      scope: 'research',          // 研究平台专属 scope：不下发需要人工审批的原始工具，也不弹审批
      origin: 'research',         // 审批来源标记（研究平台已全程免授权，这里只作兜底）
      includeAffectionTool: false, // 研究平台不计好感度，把旁路工具摘掉
      forceThinking: cfg.thinking === true ? 'enabled' : 'disabled', // 显式压过角色自己的思考开关
      maxTokens: cfg.maxTokens   // 单次生成上限（含工具参数），防失控长文
    };
    if (temperature !== null) options.temperature = temperature;

    const result = await this.outputModule.callWithTools(messages, options);
    let content = result?.choices?.[0]?.message?.content || '';
    content = String(content).trim();
    // 模型偶尔手痒在结尾附 continue 标记，不是研究平台的协议，剥掉
    content = content.replace(/\n*\{["']continue["']\s*:\s*(true|false)\}\s*$/i, '').trim();
    return content || '（她这一轮什么也没说）';
  }

  // 用户在页面上发消息
  async chat(text) {
    // 同一条输入会进历史落盘，所以先剥隐形字符再存，别指望下一轮再洗
    const content = stripInvisibleChars(String(text || '')).trim();
    if (!content) throw new Error('消息不能为空');
    if (this.busy) throw new Error('她正在自主干活，等这一轮跑完再说～');
    this.appendMessage({ role: 'user', content });
    try {
      const reply = await this.runTurn({ userText: content, autonomous: false });
      this.appendMessage({ role: 'assistant', content: reply });
      return { success: true, reply };
    } catch (error) {
      const note = `（这一轮调用失败：${error.message}）`;
      this.appendMessage({ role: 'assistant', content: note });
      return { success: false, reply: note, message: error.message };
    }
  }

  // ---- 自主工作轮 ----

  // 手动按钮：立刻让她跑一轮（不等定时器）
  async runNow() {
    if (this.busy) return { success: false, message: '她已经在干活了' };
    // 不等定时器，后台跑，接口立刻返回
    setImmediate(() => { this.tick(true); });
    return { success: true, message: '已叫醒她' };
  }

  async tick(manual = false) {
    if (this.busy) return;
    const cfg = this.loadConfig();
    if (!manual && !cfg.enabled) return;

    const due = cfg.lastTickAt + cfg.intervalMin * 60000;
    if (!manual && Date.now() < due) return;

    this.busy = true;
    try {
      cfg.running = true;
      cfg.lastError = '';
      this.saveConfig(cfg);
      console.log('[ResearchAgent] 自主工作轮开始');

      const reply = await this.runTurn({
        autonomous: true,
        temperature: 0.4,
        userText: '【自主工作时间】用户没有发新消息，按你的研究平台铁律自己安排这一轮：先 research_task_list 看任务板，有 todo/doing 就挑一个真刀真枪推进（搜资料、写脚本验证、更新任务状态和 result）；任务板空着就自己立一个小而具体的研究项再动手。做完用一两句话向用户汇报本轮真实进展。'
      });
      this.appendMessage({ role: 'assistant', content: reply, auto: true });

      const done = this.loadConfig();
      done.lastTickAt = Date.now();
      done.running = false;
      this.saveConfig(done);
      console.log('[ResearchAgent] 自主工作轮结束');
    } catch (error) {
      console.error('[ResearchAgent] 自主工作轮失败:', error.message);
      const cfg2 = this.loadConfig();
      cfg2.running = false;
      cfg2.lastTickAt = Date.now(); // 失败也算这一轮用过了，免得在错误上疯狂空转
      cfg2.lastError = error.message;
      this.saveConfig(cfg2);
      this.appendMessage({ role: 'assistant', auto: true, content: `（自主工作这轮出错了：${error.message}）` });
    } finally {
      this.busy = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick(false).catch(error => console.error('[ResearchAgent] 调度异常:', error.message));
    }, TICK_CHECK_MS);
    // 不阻止进程退出
    if (this.timer.unref) this.timer.unref();
    console.log('[ResearchAgent] 自主研究调度已启动（默认关闭，页面上可开）');
  }
}

module.exports = ResearchAgent;
