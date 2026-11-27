const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

require('../core/config');

// 冷启动保护：先体检启动环境（注入/可疑入口），再装上「就绪前崩溃即退」的兜底。
// 体检不过直接退出，避免带着被劫持的启动参数跑起来
const coldStart = require('../core/coldStart');
coldStart.installCrashGuard();
if (!coldStart.preflight(console)) {
  process.exit(1);
}

// 统一出网闸门：embedding / Qdrant / TTS / 研究与插件都走 axios，
// 挂一次拦截器，所有 axios 出网共用同一道运行期复核
coldStart.installAxiosCircuit(require('axios'));

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
if (process.platform === 'win32') {
    try {
        require('child_process').execSync('chcp 65001', { stdio: 'ignore' });
    } catch (e) {
        console.log('设置编码失败');
    }
}
// 输出被重定向到文件/管道时 stdout/stderr 不是流对象，没有 setEncoding，直接调用会崩
if (typeof process.stdout.setEncoding === 'function') {
    process.stdout.setEncoding('utf8');
}
if (typeof process.stderr.setEncoding === 'function') {
    process.stderr.setEncoding('utf8');
}

const config = {
  doubao: {
    apiUrl: process.env.DOUBAO_API_URL || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    bearerToken: process.env.DOUBAO_BEARER_TOKEN || '',
    modelId: process.env.DOUBAO_MODEL_ID || 'doubao-1.5-lite-32k-250115',
    name: '豆包'
  },
  deepseek: {
    apiUrl: process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions',
    bearerToken: process.env.DEEPSEEK_BEARER_TOKEN || '',
    modelId: process.env.DEEPSEEK_MODEL_ID || 'deepseek-flash',
    name: 'DeepSeek'
  },
  serverPort: Number(process.env.SERVER_PORT) || 41888
};

if (!config[process.env.CURRENT_API]) {
  console.warn(`[配置] CURRENT_API="${process.env.CURRENT_API || ''}" 无效，回退到 doubao`);
}
config.currentAPI = config[process.env.CURRENT_API] ? process.env.CURRENT_API : 'doubao';

global.API_CONFIG = config;

// 开发控制台允许给 API 卡片自定义名称，覆盖项持久化到 data/api_names.json
const API_NAMES_PATH = path.join(__dirname, '../../data/api_names.json');

function loadApiNames() {
  try {
    if (!fs.existsSync(API_NAMES_PATH)) {
      return;
    }
    const saved = JSON.parse(fs.readFileSync(API_NAMES_PATH, 'utf8'));
    Object.keys(saved).forEach((key) => {
      const value = saved[key];
      if (config[key] && typeof config[key] === 'object' && typeof value === 'string' && value.trim()) {
        config[key].name = value.trim();
      }
    });
  } catch (error) {
    console.error('[配置] 加载API自定义名称失败:', error.message);
  }
}

function saveApiNames() {
  try {
    const data = {};
    Object.keys(config).forEach((key) => {
      if (config[key] && typeof config[key] === 'object') {
        data[key] = config[key].name;
      }
    });
    fs.writeFileSync(API_NAMES_PATH, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[配置] 保存API自定义名称失败:', error.message);
  }
}

loadApiNames();

// 全局服务配置（网页可改）：用 data/globalConfig.json 里的值覆盖 .env 默认值，
// 这里必须在创建各 APIManager 之前调用，之后它在同一个 global.API_CONFIG 对象上原地更新
const globalConfig = require('../core/globalConfig');
globalConfig.applyToRuntime();

const app = express();
const server = http.createServer(app);

// WebSocket 同源闸门：WS 不受浏览器同源策略约束，外部任意网页都能直连 127.0.0.1 的端口。
// 不校验 Origin 的话，恶意页面能收广播、发指令、代批工具审批，所以这里只放行本机页面。
function isTrustedWsOrigin(origin) {
    // 非浏览器客户端（本机脚本、测试）不带 Origin；浏览器一定带，不能漏放
    if (!origin) return true;
    try {
        const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
        return host === 'localhost' || host === '127.0.0.1' || host === '::1';
    } catch (error) {
        return false;
    }
}

const wss = new WebSocket.Server({
    server,
    verifyClient: (info, done) => {
        if (isTrustedWsOrigin(info.origin)) {
            done(true);
            return;
        }
        console.warn(`[WebSocket] 拒绝跨站连接: ${info.origin}`);
        done(false, 403, 'Forbidden');
    }
});

// 端口选择：默认 HTTP 和 HTTPS 一起开。要单独开某一个时，由启动脚本传 SERVER_MODE，
// 另一头就完全不监听——两个端口不必绑在一个进程里，出问题时分得开
const SERVER_MODE = String(process.env.SERVER_MODE || 'both').toLowerCase();
const ENABLE_HTTP = SERVER_MODE !== 'https';
const ENABLE_HTTPS = SERVER_MODE !== 'http';

// HTTPS（可选）：certs/ 下放了自签证书就多开一个 HTTPS 端口。
// 手机访问 http://局域网IP 不算「安全上下文」，浏览器不给摄像头/屏幕权限；
// 走 https://局域网IP:41443 才给。没放证书就只跑 HTTP，本机 localhost 完全不受影响
const CERT_KEY_PATH = path.join(__dirname, '../../certs/server.key');
const CERT_CRT_PATH = path.join(__dirname, '../../certs/server.crt');
const HTTPS_PORT = Number(process.env.SERVER_HTTPS_PORT) || 41443;
let httpsServer = null;
if (ENABLE_HTTPS && fs.existsSync(CERT_KEY_PATH) && fs.existsSync(CERT_CRT_PATH)) {
    httpsServer = require('https').createServer({
        key: fs.readFileSync(CERT_KEY_PATH),
        cert: fs.readFileSync(CERT_CRT_PATH)
    }, app);
    // wss 挂在 http server 上，HTTPS 这边手动把 upgrade 转给同一个 wss，两端口共用一套会话
    httpsServer.on('upgrade', (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
} else if (ENABLE_HTTPS && SERVER_MODE === 'https') {
    console.error(`未找到 ${CERT_KEY_PATH} 与 ${CERT_CRT_PATH}，HTTPS 端口（${HTTPS_PORT}）无法开启。`);
    console.error('先生成自签证书（见 README 第三节第 8 条），或改用只开 HTTP 的启动脚本。');
    process.exit(1);
}

// 安全响应头：必须注册在静态资源之前，否则静态文件响应会绕过这些头。
// 注意：不要把 Content-Type 塞进这一段——serve-static 一旦发现 Content-Type 已设置，
// 就不再按文件后缀写自身 MIME，会把 HTML/CSS/JS 当成 application/json 返回、前端整体失效。
// JSON 的 Content-Type 单独放在静态资源之后（见下）。
// 头清单统一由 SecurityModule.getSecurityHeaders() 给出，避免这里手写一份、那边再留一份，
// 改了一处另一处不生效（CSP 之前就是这么漏掉的）。
// SecurityModule 在这里只提前 require，实例化仍在下方，中间件在请求发生时才读它。
const SecurityModule = require('../core/security');
app.use((req, res, next) => {
  const headers = securityModule.getSecurityHeaders();
  Object.keys(headers).forEach((name) => res.setHeader(name, headers[name]));
  next();
});

// 请求体大小上限：挡住超大 JSON 体拖垮内存（本机自用足够，前端单条消息远小于此）
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '../../public')));

// 冷启动闸门：静态页面照常打开，/api 在初始化完成前统一 503，
// 免得页面先拿到一份「空记忆、空会话」的状态并据此渲染
app.use(coldStart.gate());
app.use('/tts-audio', express.static(path.join(__dirname, '../data/tts_output')));

// API 响应统一按 JSON 返回（放在静态资源之后：静态文件要保留自身 MIME）
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

const InputModule = require('../core/input');
const { scrubUserText } = require('../core/textGuard');
const MemoryModule = require('../core/memory');
const { writeServerLock, clearServerLock } = require('../storage/writeLock');
const EmotionModule = require('../core/emotion');
const EmotionLedger = require('../core/emotionLedger');
// 表情投影层：情绪快照 → VAD / 表情 / 分层动作（纯函数，单向依赖，不回写情绪）
const expressionProjection = require('../core/expressionProjection');
const GalgameModule = require('../core/galgame');
const SystemNarrator = require('../core/narrator');
// 通道装配层：角色 / 互动 / 沙箱 / QQ / B站 各一套运行时，器官仍只有一份真值
const {
  createRoleRuntime,
  createInteractionRuntime,
  createSandboxRuntime,
  createCreativeRuntime,
  createQQRuntime,
  createBiliRuntime
} = require('./runtimes');
const ScheduleStore = require('../core/schedule');
const BackupManager = require('../core/backup');
const { CIDEEngine } = require('../core/cide');
const DeveloperTool = require('../tools/developerTool');
const ProcessManager = require('../tools/processManager');
const { ToolRegistry } = require('../core/toolRegistry');
const ResearchAgent = require('../core/researchAgent');
const SocialPlaza = require('../core/socialPlaza');
const CodingTeam = require('../core/codingTeam');
const CodingLoop = require('../core/codingLoop');
const WorkerPool = require('../core/codingWorkers');
const CodingCompetition = require('../core/codingCompetition');
const { SandboxAgents } = require('../core/sandboxAgents');
const { AgentFleet } = require('../core/agentFleet');
const { EvolutionGate } = require('../core/evolutionGate');
const evolutionParams = require('../core/evolutionParams').instance;
const { createProgressTracker } = require('../core/progressTracker');
const CameraModule = require('../core/camera');
const ScreenModule = require('../core/screen');
const SessionManager = require('../session/sessionManager');
const PersonaEvolution = require('../core/personaEvolution');
const { RelayHub } = require('../core/relayHub');
const AuthModule = require('../core/auth');
const VectorLearner = require('../learning/vectorLearner');
const DialogueRetriever = require('../learning/dialogueRetriever');
const KnowledgeRetriever = require('../learning/knowledgeRetriever');
const AppointmentBook = require('../core/appointmentBook');
const PrivateLife = require('../core/privateLife');
const DiaryModule = require('../core/diary');
const { TavernKeeper } = require('../core/tavernClock');
const { EvolutionRequestStore } = require('../core/evolutionRequest');
// 🕰️ 时间线事件总线：全进程一份，各模块都写进同一条日志
const { getTimeline, dayKey } = require('../core/timeline');
// 🌱 事件驱动调度（影子期）：只记候选、不投递，与现有 tick 并行对照
const { attachShadowScheduler } = require('../core/proactiveScheduler');
const { GameTable } = require('../core/gameTable');
// 本地技能市场：在只读 SkillLibrary 之上补写入 / 导入导出
const SkillStore = require('../core/skillStore');

const processManager = new ProcessManager();
// 系统框架工具注册表：把进程管理、代码完整性校验等能力暴露给大模型（function calling）
const toolRegistry = new ToolRegistry({ projectRoot: path.join(__dirname, '..', '..'), processManager });
const inputModule = new InputModule();
const memoryModule = new MemoryModule();
const emotionModule = new EmotionModule();
// 情感履历：记「系统在什么情绪下缺过什么能力」，落 data/emotion_ledger.json；
// P1 已进影子模式——聚类 + 四判据打分只写 data/tool_creation_logs.json，永不发起申请
const emotionLedger = new EmotionLedger({ emotionModule, memoryModule, toolRegistry, inputModule });
const galgameModule = new GalgameModule();
const sessionManager = new SessionManager();
// CIDE（意识启发式自主思考引擎）：正式回复与自主发言共用一个实例，从而共享全局工作空间（工作记忆）
const cideEngine = new CIDEEngine();
// 🕰️ 时间线：一进程一份；记忆键的分档语义只在记忆层，这里只借用它的规范化
const timeline = getTimeline();
const timelineScopeOf = (userId, scope = 'role') => memoryModule.normalizeScopeKey(userId, scope);
// 影子模式默认开启；设 TIMELINE_SHADOW=off 可整段关掉（回退第六刀不影响前五刀）
if (!/^(?:0|false|off|no)$/i.test(String(process.env.TIMELINE_SHADOW || ''))) {
    attachShadowScheduler(timeline);
}
// 📅 事件簿：从聊天里提取约定/日程，到点前叮嘱、过点后追问；挂在正式回复与自主发言两条链路上
const appointmentBook = new AppointmentBook({ timeline, timelineScope: (userId) => timelineScopeOf(userId) });
// 🏠 私生活档案：每天 22 点后替她补写「今天」——做了什么、心情、日记、没说出口的话。
// 与正式回复和自主发言共用同一实例，保证两边读到的是同一天的生活
const privateLife = new PrivateLife({ timeline, timelineScope: (userId) => timelineScopeOf(userId) });
// 📓 日记本：到约定时间由她自己写一段。素材取自主记忆链路，写出的正文回流进去；
// 每人一本 + 一本全局，落 data/diary/。时间由 schedule_diary 工具与用户约定（默认 20:00）
const diary = new DiaryModule({ memory: memoryModule });
toolRegistry.setDiaryModule(diary);

// 🧬 进化诉求：默认 shadow，只记录她想补什么能力；批准与实现都在外部 agent
const evolutionStore = new EvolutionRequestStore({ timeline });
toolRegistry.setEvolutionModule(evolutionStore);
console.log(`[进化诉求] 通道已接（EVOLUTION_MODE=${evolutionStore.mode()}）`);
// 🎲 陪她玩：骰子 / 猜拳 / 猜数字，输赢在服务端按确定规则判，赢了加好感；只在内存里存一局
const gameTable = new GameTable();
// 运行时共用的器官依赖：只传引用，运行时内部不再 new 器官
const runtimeDeps = { memoryModule, cideEngine, toolRegistry, appointmentBook, emotionModule, sessionManager, privateLife };
// 角色运行时：她自己的那条线（自主发言 / 私生活 / 日程 / 人设资产）
const roleRuntime = createRoleRuntime(runtimeDeps);
// 互动运行时：用户↔角色这一轮对话。共用会话库（历史接得上），但输出模块与场景独立
const interactionRuntime = createInteractionRuntime(runtimeDeps);
// 沙箱运行时：编程闭环 / 竞赛评委。只借器官，不写情绪、不碰私生活
const sandboxRuntime = createSandboxRuntime(runtimeDeps);
// 创意世界运行时：打开创意页面时把技能白名单拼进场景提示，世界状态由 toolRegistry.creativeWorld 持有
const creativeRuntime = createCreativeRuntime(runtimeDeps);
// 角色运行时的输出模块就是原有 outputModule 的语义（供动态/点赞/游戏等旁路复用）
const outputModule = roleRuntime.outputModule;
// 📱 社交平台（网页端限定的群聊大厅）：让不同角色在一起闲聊。
// 与 QQ / B 站链路完全无关，也不读写任何长期记忆或会话历史，只落 data/social_plaza/。
const socialPlaza = new SocialPlaza({
    api: outputModule.unifiedAPI,
    sessionManager,
    onMessage: (payload) => broadcastSocial(payload)
});
// 角色自写新版人设：走 updateSession 落库，同名/近名视为演化（旧记忆降权），完全不同名才换代隔离
const personaEvolution = new PersonaEvolution({ sessionManager, memoryModule, outputModule });
// 让「查历史」工具能读到当前会话的在场记录与归档原文
toolRegistry.setSessionManager(sessionManager);
// 研究平台里的她：复用正式回复的工具循环，能在页面上对话，也能被定时器叫醒自己干活
const researchAgent = new ResearchAgent({
    research: toolRegistry.research,
    outputModule,
    sessionManager
});
researchAgent.start();
// 编码闭环（L2）：复用正式回复的工具循环 + L1 编码工具，在 git 工作区里自主改代码、跑测试、打检查点；
// 底模走 Qwen 通道（在主聊链路之外启用，不切主会话）
const codingLoop = new CodingLoop({
    coding: toolRegistry.coding,
    // 沙箱运行时的输出实例：与互动对话互不共享工具上下文与快照缓存
    outputModule: sandboxRuntime.outputModule,
    toolRegistry,
    sessionManager
});
// 工人池（代理式车间）：按名额从任务板自动领「声明了目标」的任务，复用上面的编码闭环并发执行，
// 跑完把结果回写任务板。默认不自动（auto=false），要显式开开关才会自动领单，避免静默烧 API。
const codingWorkers = new WorkerPool({
    coding: toolRegistry.coding,
    codingLoop
});
// 沙箱里的 Claude Code 执行器：把多 Agent 团队讨论出的方案交给本机 Claude Code，
// 在 data/coding/workspaces/<用户>/<taskId>/ 里实际改代码；模型请求走本地中转站 41888。
// 执行通道复用命令沙箱（低权限账户 + Job Object + 空闲/时长上限），不再直接落在宿主账户上。
const sandboxAgents = new SandboxAgents({
    coding: toolRegistry.coding,
    codingLoop,
    sandbox: toolRegistry.sandbox,
    projectRoot: path.join(__dirname, '..', '..'),
    relayBaseUrl: `http://127.0.0.1:${config.serverPort || 41888}/relay`,
    // 中转站要求令牌：取运行时配置（relayHub 在本文件后面才构造，所以传函数、启动时才取值）
    relayToken: () => relayHub.config.authToken,
    defaultModel: 'deepseek',
    smallModel: 'qwen',
    concurrency: 2
});
// 工人池与 Claude Code 共用同一批工作区：让工人池领单时排除 Claude Code 正在跑的任务
codingWorkers.sandboxAgents = sandboxAgents;
// Agent 集群（16 槽：4 写手 + 12 侦察）：只做规划/接线/合并/收尾，代码执行仍走 codingLoop。
// 集群子任务不写任务板；派发前检查工人池与 Claude Code 是否占用源工作区。
const agentFleet = new AgentFleet({
    coding: toolRegistry.coding,
    codingLoop,
    outputModule: sandboxRuntime.outputModule,
    codingWorkers,
    sandboxAgents,
    apiChannel: 'deepseek'
});
// 编程竞赛（竞技场）：多个候选在同一份初始工作区副本上抢同一道题，token 预算相同，跑完按硬指标排名。
// 评委走 outputModule 的一次性调用通道；评委不可用或调用失败时自动退回纯硬指标排序。
const codingCompetition = new CodingCompetition({
    coding: toolRegistry.coding,
    codingLoop,
    judge: CodingCompetition.createModelJudge({ outputModule: sandboxRuntime.outputModule, model: 'deepseek' })
});
// 沙箱进化闸：只有白名单模块 + 已钉基线才允许自动进化；参数档过闸自动生效，
// 工具档过闸只落待审等人拍板。默认关（data/evolution/gate.json 的 enabled）。
const evolutionGate = new EvolutionGate({
    root: path.join(__dirname, '..', '..'),
    params: evolutionParams
});
// 对话超出 200 条后，溢出的旧对话会被剪进独立归档空间；这里再把它们蒸馏成摘要写进长期记忆，
// 随后触发一次语义巩固（情景 → 语义）、巩固期去重（方向一②，默认关）与自我模型提炼（反思落地），
// 复用同一条串行链，不会与蒸馏并发写同一份 store
sessionManager.setArchiveHandler((payload) => outputModule.summarizeArchivedConversation(payload)
    .then(() => outputModule.consolidateUserMemories({ userId: payload && payload.userId }))
    .then(() => outputModule.dedupUserMemories({ userId: payload && payload.userId }))
    .then(() => outputModule.refreshSelfModel({ userId: payload && payload.userId, sessionId: payload && payload.sessionId })));
// 角色时间表：默认关闭，到点由角色自己开口；落 data/schedule.json
const scheduleStore = new ScheduleStore();
// 📚 书摘检索器（Qdrant 豆瓣书库）：自主发言时给证据层补一条书素材，云端不可用会自动静默降级
const knowledgeRetriever = new KnowledgeRetriever();
// 备份存档：把 data/（含画板草稿）原样打包到 backups/
const backupManager = new BackupManager();
const systemNarrator = new SystemNarrator(memoryModule, {
    sessionManager,
    // 🕰️ 时间线：网页端的自主开口记 channel='web'
    timeline,
    hasClients: () => clients.size > 0,
    onSpeech: handleProactiveSpeech,
    cide: cideEngine,
    toolRegistry,
    // 自主发言复用正式回复的工具循环，这样她说的「我写好了」是真的写了
    outputModule,
    schedule: scheduleStore,
    knowledgeRetriever,
    appointmentBook,
    // 🏠 私生活：自主发言的由头可以来自她自己的生活，而不只是用户最后那句话
    privateLife,
    // 🫀 情绪模块：自主发言被冷落 / 被回应时，把这条「自己的遭遇」回流成情绪涟漪（默认关）
    emotionModule,
    // 供 CIDE 内部思考读取当前情绪与关系阶段（自主发言没有外部输入，需要环境上下文）
    getContext: (sessionId, userId) => {
        // calculateEmotion() 返回的是主导情绪 type（如 happy/calm），需与 primaryEmotion 兼容
        const emotionState = emotionModule.calculateEmotion(sessionId, userId);
        const relationshipStatus = galgameModule.getCurrentRelationship(sessionId, userId);
        return {
            emotion: emotionState?.type || emotionState?.primaryEmotion || 'calm',
            // 🔥 兴奋判定要用强度：happy 高强度即视为「她正兴奋」（见 narrator.getExcitement）
            emotionIntensity: typeof emotionState?.intensity === 'number' ? emotionState.intensity : 0,
            relationStage: relationshipStatus?.stage || 'STRANGER',
            // 关系说法直接取自关系账本，供自主发言按真实亲疏演，不另立一份映射
            relationStageName: relationshipStatus?.stageName || '',
            // 好感分进门控：关系还生分时，她主动找你的频率会被压低
            affinityScore: typeof relationshipStatus?.score === 'number' ? relationshipStatus.score : null
        };
    }
});
// 🫀 内感受中枢：把情绪/关系/记忆/作息四个器官的「此刻状态」以只读 getter 注入 CIDE，
// 由 cide.readInteroception() 汇总成一份机体快照供 output 消费。纯读，不回写、不落盘。
cideEngine.setInteroceptionSources({
    emotion: (sessionId, userId) => emotionModule.calculateEmotion(sessionId, userId),
    relation: (sessionId, userId) => galgameModule.getCurrentRelationship(sessionId, userId),
    memory: (sessionId, userId) => memoryModule.getMemoryLifecycleStats(userId),
    daypart: () => {
        const daypart = systemNarrator.describeDaypart();
        return {
            hour: daypart.hour,
            part: daypart.part,
            isNight: daypart.isNight,
            meal: daypart.meal ? daypart.meal.name : null
        };
    }
});
const devTool = new DeveloperTool();
const authModule = new AuthModule();
// 语义分析系统专用的独立学习器：数据文件与角色扮演分开，互不影响
const semanticLearner = new VectorLearner(path.join(__dirname, '../../data/semantic_training_data.json'));
// 爬取到的台词对话语料检索器（Qdrant），检索不可用时自动降级
const dialogueRetriever = new DialogueRetriever();
const UserApiClient = require('../core/userApi');
const userApiClient = new UserApiClient();
const TTSModule = require('../core/tts');
// QQ 对接：OneBot v11 协议端（NapCat），配置见 oneBotConfig
const oneBotConfig = require('../core/oneBotConfig');
const { OneBotClient } = require('../core/oneBotClient');
const { UnifiedAPI } = require('../core/api');
// 编程团队：多人格方案讨论 + 抓点监控。给它一个独立的模型通道，跟主聊链路隔开；
// 数据落 data/coding/，主控沿用角色的名字与语气
const { createReadTools } = require('../core/readTools');
const codingTeam = new CodingTeam({
    coding: toolRegistry.coding,
    skills: toolRegistry.skills,
    api: new UnifiedAPI(),
    sessionManager,
    // 只读工具：人格发言前可核对真实代码，断言落在「文件:行」；根目录钉在项目根内
    readTools: createReadTools({ root: path.join(__dirname, '../..') })
});
toolRegistry.setCodingTeam(codingTeam);
// 闭环硬门禁：判通过前强制让安全审查看一遍本轮改动，与上面供模型主动调用的 discuss 是两回事
codingLoop.setCodingTeam(codingTeam);
// 自动巡检：默认 10 分钟看一次运行日志，有失败才拉相关人格做 log 抓点并留告警
codingTeam.startPatrol({ sessionId: '' });
// 讨论/评审的步进进度（深化十）：客户端带 clientToken 上行，前端轮询 status 回读。
// 内存有界（TTL + 容量上限），请求结束即清键；只服务进度可见性，不落盘、不回显正文。
const discussProgress = createProgressTracker();
const reviewProgress = createProgressTracker();
// 进度关联 id 白名单：客户端随机 id。与讨论记录 id 同风格，挡住超长/异常字符等输入面。
const PROGRESS_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// 把请求里的 clientToken 归一成「可用 token 或空串」：缺失/非法一律当没带（旧调用方零改动）。
function normalizeProgressToken(raw) {
    const token = String(raw == null ? '' : raw).trim();
    return PROGRESS_ID_RE.test(token) ? token : '';
}
// B站直播：配置（房间号 / 弹幕源 / 凭证）+ 桥接（弹幕 → 角色回复 → 语音 → 网页皮套）
const biliLiveConfig = require('../core/biliLiveConfig');
const { BiliLiveBridge } = require('../core/biliLiveBridge');

const oneBotClient = new OneBotClient();
const ttsModule = new TTSModule();
// speak 工具要合成自己的声音，把 TTS 模块交给工具注册表
toolRegistry.setTTSModule(ttsModule);
// 设备链路：串口和设备能力都在独立的感知与行动平台 pog-sense（兄弟目录）里，
// 主项目只通过 127.0.0.1:7788 的 /v1 协议访问，不装 serialport、不 require 平台文件
const { DeviceLinkClient } = require('../core/deviceLinkClient');
const deviceLink = new DeviceLinkClient();
// robot_action 靠它把动作名翻译成抓包得到的原始指令
toolRegistry.setDeviceLink(deviceLink);
const securityModule = new SecurityModule();

// B站直播桥接：每个观众一份独立会话，落在 data/bili_sessions/，
// 和网页端存档、QQ 桥接存档都分开，互相不覆盖
const biliRuntime = createBiliRuntime(runtimeDeps);
const biliBridge = new BiliLiveBridge({
    biliSessionManager: biliRuntime.sessionManager,
    roleSourceManager: sessionManager, // 角色设定跟网页端那份走
    inputModule,
    memoryModule,
    emotionModule,
    emotionLedger,
    galgameModule,
    outputModule: biliRuntime.outputModule,
    ttsModule
});
// 桥接的每一条消息（弹幕 / 回复 / 状态）都推给网页端，皮套页与调试面板共用同一条通道
biliBridge.on('message', (payload) => broadcastOutput(payload));

// QQ 运行时：独立会话库 + 独立私生活 + 独立输出实例。
// 装配留在本层，qq/bridge.js 只消费，不再在路由文件里 require 阶段自建一套。
const qqRuntime = createQQRuntime(runtimeDeps);

// 📓 日记调度：网页与 QQ 各有一套会话库，统一在这里按分钟看一次。
// 到约定时间（默认 20:00）、当天有活动、当天没写过才会真的动笔；
// 不挂在 narrator 上——QQ 侧的自主发言走自己的定时器，不经过 narrator.tick
const diaryTimer = setInterval(() => {
    diary.tick({ sessionManager: roleRuntime.sessionManager })
        .catch((error) => console.warn('[日记] 网页调度失败（不影响服务）:', error.message))
        .then(() => diary.tick({ sessionManager: qqRuntime.sessionManager }))
        .catch((error) => console.warn('[日记] QQ 调度失败（不影响服务）:', error.message));
}, 60 * 1000);
// 不让这个定时器拖住进程退出
if (typeof diaryTimer.unref === 'function') diaryTimer.unref();
console.log(`[日记] 调度已启动：每分钟检查一次（${String(diary.getConfig().hour).padStart(2, '0')}:${String(diary.getConfig().minute).padStart(2, '0')}，已${diary.getConfig().enabled ? '开启' : '关闭'}）`);

// 🍺 酒馆节律：每 3 秒把角色朝当前作息点位挪一小步，前端 3 秒轮询一次世界，看着就像在走。
// 位置只改内存，落盘由 TavernKeeper 节流到 30 秒一次，别让挪人把 world.json 写穿。
const tavernKeeper = new TavernKeeper({ world: toolRegistry.creativeWorld });
const tavernTimer = setInterval(() => {
    try {
        tavernKeeper.tick();
    } catch (error) {
        console.warn('[酒馆] 节律推进失败（不影响服务）:', error.message);
    }
}, 3000);
if (typeof tavernTimer.unref === 'function') tavernTimer.unref();
console.log('[酒馆] 节律已启动：每 3 秒推进一次角色位置');

// 取客户端 IP。Express 在 IPv4 连接上可能给成 ::ffff:127.0.0.1 这种形式，先剥掉前缀
function getClientIp(req) {
    return String(req.ip || req.connection.remoteAddress || '').replace(/^::ffff:/i, '');
}

// 跑服务这台机器自己的地址集合：回环 + 本机各网卡的地址。
// 用 127.0.0.1 还是本机的局域网 IP 打开都算「在本机上」，手机/别的电脑则不在里面
const HOST_ADDRESSES = new Set(['127.0.0.1', '::1']);
Object.values(os.networkInterfaces()).forEach((list) => {
    (list || []).forEach((info) => HOST_ADDRESSES.add(String(info.address).split('%')[0]));
});

// 管理员面板只允许在跑服务的那台机器上打开。局域网里的手机、别的电脑，
// 以及从公网/VPN 绕进来的请求一律不认——否则面板等于挂在网络上等爆破
function isHostRequest(req) {
    return HOST_ADDRESSES.has(getClientIp(req).split('%')[0]);
}

// 只认本机来源的中间件：关服务、停进程这类开关只允许在跑服务这台机器上按。
// 不然内网里谁都能把服务打停，重启还会把登录失败计数清掉，等于帮着爆破
function requireHost(req, res, next) {
    if (!isHostRequest(req)) {
        return res.status(403).json({ success: false, message: '该操作仅限服务所在机器执行' });
    }
    next();
}

// B1：路由内 500 的统一出口。服务端记录完整错误（堆栈）便于排障，客户端只回一句通用话术，
// 不回吐 error.message——避免把内部细节、路径、库信息泄露给调用方。
// 保留各路由既有的响应外形（success / ok / status），不改动前端既有读取方式。
function serverError(res, error, shape = 'success') {
    console.error('[Server] 内部错误:', (error && error.stack) ? error.stack : error);
    if (res.headersSent) return;
    if (shape === 'ok') {
        return res.status(500).json({ ok: false, error: '服务器内部错误' });
    }
    if (shape === 'status') {
        return res.status(500).json({ status: 'error', message: '服务器内部错误' });
    }
    return res.status(500).json({ success: false, message: '服务器内部错误' });
}

function requireAdmin(req, res, next) {
    const sessionId = req.headers['x-session-id'] || req.query.sessionId;
    const session = authModule.validateSession(sessionId);
    
    if (!session || session.role !== 'admin') {
        return res.status(403).json({ success: false, message: '无权访问，需要管理员权限' });
    }

    // 就算是 admin，不是从本机来的也一律挡回去：管理接口只认跑服务这台机器
    if (!isHostRequest(req)) {
        return res.status(403).json({ success: false, message: '管理员接口仅限服务所在机器访问' });
    }
    
    req.user = session;
    next();
}

// 【0c · 归属越权 — 云端版本待启用，本机版不校验】
// 现状（本机单人自用）：记忆侧的 userId 由客户端提交（req.query.userId / body.userId / WS data.userId），
//   服务端只验「会话有效」，不比对该 userId 是否属于当前登录用户。本地自用无威胁，暂不拦截。
// 为何现在可以不管：qq_/bili_ 前缀的 id 均为系统生成的（非用户自选），不存在伪造他人身份的空间。
// 云端启用时（CODING_ACCESS=cloud，届时另开版本）：归属必须由 session 推导，
//   客户端传的 userId 只当 persona（角色分档），不得当账号身份。落地形态照抄既有 codingOwner：
//     const owner = session.username;            // 账号身份只认登录名
//     const persona = req.query.userId;          // 客户端值只用于分档，不用于鉴权
//   即：请求里的「账号维度」与 session.username 不一致时拒绝（403），或直接忽略之、一律用 session.username 读档。
// 注意：存量档名为 qq_xxx__role 形态、无 owner 字段，换键会让旧档失联，需配套迁移方案。
function requireLogin(req, res, next) {
    const sessionId = req.headers['x-session-id'] || req.query.sessionId;
    const session = authModule.validateSession(sessionId);

    if (!session) {
        return res.status(401).json({ success: false, message: '请先登录' });
    }

    req.user = session;
    // 【云端版本启用点】本机版到此为止；上云端后在此加归属校验，例如：
    // const requestedOwner = req.query.userId || req.body?.userId;
    // if (requestedOwner && requestedOwner !== session.username && !CODING_CLOUD_MODE) { ... }
    next();
}

// 编程沙箱门禁：默认「本机 + 需登录」。部署到云端时把 CODING_ACCESS 设成 cloud，
// 就只校验登录、不再限制来源 IP —— 身份与部署形态解耦，不会硬绑 localhost。
const CODING_CLOUD_MODE = String(process.env.CODING_ACCESS || 'local').toLowerCase() === 'cloud';

function requireCodingUser(req, res, next) {
    if (!CODING_CLOUD_MODE && !isHostRequest(req)) {
        return res.status(403).json({ success: false, message: '编程沙箱仅限服务所在机器使用（云端部署请设 CODING_ACCESS=cloud）' });
    }
    const sessionId = req.headers['x-session-id'] || req.query.sessionId;
    const session = authModule.validateSession(sessionId);
    if (!session) {
        return res.status(401).json({ success: false, message: '请先登录后再使用编程沙箱' });
    }
    req.user = session;
    next();
}

// 编码沙箱的身份键：登录用户名（跨会话稳定）。admin 可以用 ?owner=<用户名> 窥看别人的工作区。
function codingOwner(req) {
    const override = String(req.query.owner || (req.body && req.body.owner) || '').trim();
    if (override && req.user && req.user.role === 'admin') {
        return override;
    }
    return req.user ? req.user.username : '';
}

// 角色归属校验：管理员放行；创建者或已加入该角色（botIds 里有它）的登录用户放行
function canAccessCharacter(loginSession, sessionId) {
    if (!loginSession) {
        return false;
    }
    if (loginSession.role === 'admin') {
        return true;
    }
    return authModule.isOwner(loginSession.username, sessionId);
}

function rateLimit(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;

    if (!securityModule.checkRateLimit(ip)) {
        return res.status(429).json({ success: false, message: '请求过于频繁，请稍后再试' });
    }

    next();
}

// 【B4 · CSRF 防护 — 云端版本待启用，本机版未挂载】
// 现状（本机单人自用）：本函数未在任何路由上 app.use 挂载，属「预留但未启用」。
// 为何现在可以不管：本机版仅监听回环地址、无跨站攻击面。
// 云端启用时（CODING_ACCESS=cloud，届时另开版本）：在写操作路由前挂载 app.use(csrfProtect)，
//   并让前端在请求头带上 x-csrf-token（与 securityModule.validateCSRFToken 配套）。
function csrfProtect(req, res, next) {
    if (req.method === 'GET' || req.method === 'OPTIONS') {
        return next();
    }
    
    const sessionId = req.headers['x-session-id'] || req.body.sessionId;
    const csrfToken = req.headers['x-csrf-token'] || req.body.csrfToken;
    
    if (!securityModule.validateCSRFToken(sessionId, csrfToken)) {
        return res.status(403).json({ success: false, message: 'CSRF验证失败' });
    }
    
    next();
}

const clients = new Set();
// ws → 登录用户名：前端连上后发 ws-auth 关联，审批广播时按 owner 精准投递
const clientUsers = new Map();
// 通过登录会话校验的连接：只有这些连接能代批高危工具，ws-auth 自报用户名不算
const authenticatedSockets = new Set();

// 中转站：本地 OpenAI 兼容入口 + Agent 信箱 + 后台任务队列。
// 配置落 data/relay/config.json；邮箱/任务事件经既有 ws 推给所有前端。
const relayHub = new RelayHub({
    dataDir: path.join(__dirname, '../../data'),
    onEvent: (event) => broadcastOutput({ type: 'relay-event', event })
});

// 摄像头 / 图片记忆：抓帧走浏览器（Node 端拿不到 getUserMedia），
// 由打开了服务页面、且授权过摄像头的机器抓帧后经 WebSocket 回传
const cameraModule = new CameraModule();

// 屏幕 / 屏幕记忆：同样走浏览器抓帧（Node 端拿不到 getDisplayMedia），
// 由服务页面抓屏后经 WebSocket 回传；只留文字描述，原图不落盘
const screenModule = new ScreenModule();

// 高危工具（写文件/删文件/执行终端命令）每次调用都需前端人工确认：
// 这里把审批请求广播给所有已连接前端，由用户在弹窗中允许或拒绝
toolRegistry.setApprovalNotifier((request) => {
    const owner = toolRegistry.codingUserId(request.args || {}); // 编码审批归属用户，供前端按身份过滤
    const payload = JSON.stringify({
        type: 'tool-confirm-request',
        requestId: request.requestId,
        tool: request.tool,
        args: request.args,
        owner,
        origin: request.origin || '', // 审批来源：chat=主对话、coding=编码闭环、research=研究平台
        timeoutMs: request.timeoutMs
    });
    let sent = 0;
    clients.forEach((client) => {
        if (client.readyState !== WebSocket.OPEN) return;
        // 审批广播发给所有连接，由前端按来源与归属过滤：
        // - 主界面：只弹 chat 来源的审批（编码闭环与研究平台的审批不窜到主对话）
        // - 编码页：只弹 owner === 自己的审批（主对话 owner 是会话 userId，与登录用户名不同，天然不窜）
        client.send(payload);
        sent++;
    });
    console.log(`[工具审批] 已向 ${sent} 个前端发送确认请求: ${request.tool} (${request.requestId})`);
});

// 🛠 自建工具闭环接线（§8.13 / §8.14 / §8.15）：
// - 情感履历 → 自建工具存储：四判据 + 限流全过后把工具注册进 data/auto_tools.json
// - 工具注册表 → 情感履历：自建工具每次被调用时回传调用事件，驱动「后续 2 轮」反馈回收与自动停用
// - 创建通知：复用广播通道，只展示、不阻塞、不等回执（区别于上面的审批弹窗）
toolRegistry.setEmotionLedger(emotionLedger);
emotionLedger.setAutoToolStore(toolRegistry.autoToolStore);
emotionLedger.setCreationNotifier((notification) => {
    broadcastOutput(notification);
});

// 画板通道：模型调用画板工具（canvas_draw / canvas_clear）时，把转好的笔迹实时推给前端落笔上屏
toolRegistry.setCanvasEmitter((payload) => {
    const message = JSON.stringify({
        type: 'canvas-strokes',
        action: payload.action,
        strokes: payload.strokes || []
    });
    let sent = 0;
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
            sent++;
        }
    });
    console.log(`[画板] 已向 ${sent} 个前端推送 ${payload.action}（${(payload.strokes || []).length} 笔）`);
});

// 摄像头抓帧通道：把抓帧请求推给所有已连接前端，返回实际收到请求的客户端数量
// （0 个接收方时 cameraModule 会立刻判失败，不必干等超时）
toolRegistry.setCameraController(cameraModule);
// 长期记忆模块注入：让 pin_memory 工具能钉住当前用户/分区里的某条记忆
toolRegistry.setMemoryModule(memoryModule);
// 🧠 阶段 4｜视觉记忆汇入主记忆生命周期：注入 MemoryModule，识图后同步写一份到主 memories
cameraModule.setMemoryModule(memoryModule);
cameraModule.setFrameRequester((request) => {
    const message = JSON.stringify({ type: 'camera-request', requestId: request.requestId });
    let sent = 0;
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
            sent++;
        }
    });
    console.log(`[摄像头] 已向 ${sent} 个前端请求抓帧 (${request.requestId})`);
    return sent;
});

// 屏幕抓帧通道：与摄像头同构，只是前端用 getDisplayMedia 抓屏幕
toolRegistry.setScreenController(screenModule);
// 🧠 阶段 4｜屏幕记忆汇入主记忆生命周期（与摄像头同构）
screenModule.setMemoryModule(memoryModule);
screenModule.setFrameRequester((request) => {
    const message = JSON.stringify({ type: 'screen-request', requestId: request.requestId });
    let sent = 0;
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
            sent++;
        }
    });
    console.log(`[屏幕] 已向 ${sent} 个前端请求抓屏 (${request.requestId})`);
    return sent;
});

// 编码闭环事件通道：把每轮进度、模型正文、工具调用与结果实时推给已连接前端。
// 广播给所有客户端，前端按 event.owner / event.taskId 过滤后落到对话流。
codingLoop.setEventNotifier((event) => {
    const message = JSON.stringify({ type: 'coding-event', ...event });
    let sent = 0;
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
            sent++;
        }
    });
    if (event.kind === 'run_end') {
        console.log(`[编码闭环] 事件已广播给 ${sent} 个前端（${event.kind}/${event.status}）`);
    }
});
// 沙箱 Claude Code 的事件通道：前端按 owner / taskId 过滤，落到同一个对话流里
sandboxAgents.setEventNotifier((event) => {
    const message = JSON.stringify({ type: 'coding-event', ...event });
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
});
// Agent 集群事件通道：槽位启动/合并/越界/预算熔断都走同一条 coding-event，
// 前端按 type 前缀 fleet- 落到「🧬 集群」子界面。
agentFleet.setEventNotifier((event) => {
    const message = JSON.stringify({ type: 'coding-event', ...event });
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
});

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('新客户端连接');
    
    ws.on('message', async (message) => {
        try {
            console.log('[WebSocket] 收到消息:', message.toString().substring(0, 100));
            const data = JSON.parse(message);

            // ws-auth：前端报上登录用户名与会话。会话有效才允许代批工具；用户名只用于审批展示过滤
            if (data.type === 'ws-auth') {
                const sid = data.sessionId ? String(data.sessionId) : '';
                const session = sid ? authModule.validateSession(sid) : null;
                if (session) {
                    authenticatedSockets.add(ws);
                    clientUsers.set(ws, session.username);
                    console.log(`[WebSocket] 客户端已认证: ${session.username}`);
                } else if (data.username) {
                    clientUsers.set(ws, String(data.username).trim());
                }
                return;
            }

            // —— 用户输入状态挡门 3：前端正在输入（还没 send），记一下时间戳 —— 🌀
            if (data.type === 'typing' && data.sessionId) {
                systemNarrator.noteTyping(data.sessionId);
                return;
            }

            // 工具审批响应：必须来自通过登录会话校验的连接，否则任意本机网页都能替用户点「允许」
            if (data.type === 'tool-confirm-response') {
                if (!authenticatedSockets.has(ws)) {
                    console.warn('[工具审批] 拒绝未认证连接提交的审批响应');
                    return;
                }
                const matched = toolRegistry.resolveApproval(data.requestId, data.approved, data.reason);
                console.log(`[工具审批] 收到响应 requestId=${data.requestId} approved=${data.approved} matched=${matched}`);
                return;
            }

            // 摄像头回帧：前端抓到的一帧画面，直接唤醒挂起的抓帧请求
            if (data.type === 'camera-frame') {
                const matched = cameraModule.resolveFrame(data.requestId, { dataUrl: data.dataUrl, error: data.error });
                console.log(`[摄像头] 收到前端回帧 requestId=${data.requestId} matched=${matched}`);
                return;
            }

            // 屏幕回帧：前端抓到的一帧屏幕画面，直接唤醒挂起的抓屏请求（原图不落盘）
            if (data.type === 'screen-frame') {
                const matched = screenModule.resolveFrame(data.requestId, { dataUrl: data.dataUrl, error: data.error });
                console.log(`[屏幕] 收到前端回帧 requestId=${data.requestId} matched=${matched}`);
                return;
            }

            const sessionId = data?.sessionId;
            if (sessionId) systemNarrator.setProcessing(sessionId, true);
            try {
                const output = await processInput(data);
                console.log('[WebSocket] 处理完成');
            
                // 创建干净的状态对象，移除affectionChange，但保留好感度变化信息给前端
                const status = {
                    emotion: emotionModule.getCurrentEmotions(data.sessionId, data.userId)
                };
                
                const relationshipData = galgameModule.getCurrentRelationship(data.sessionId, data.userId);
                // 移除affectionChange，确保不在status对象中
                const { affectionChange, ...cleanRelationship } = relationshipData;
                status.relationship = cleanRelationship;
                
                // 发送状态更新
                const statusUpdate = JSON.stringify({
                    type: 'status-update',
                    relationship: status.relationship,
                    emotion: status.emotion
                });
                ws.send(statusUpdate);
                console.log('[WebSocket] 发送状态更新');
                
                // 如果有好感度变化，单独发送一个好感度变化事件
                if (output.relationship && output.relationship.affectionChange) {
                    const affectionUpdate = JSON.stringify({
                        type: 'affection-update',
                        affectionChange: output.relationship.affectionChange
                    });
                    ws.send(affectionUpdate);
                    console.log('[WebSocket] 发送好感度变化');
                }
                
            } finally {
                if (sessionId) systemNarrator.setProcessing(sessionId, false);
            }
        } catch (error) {
            console.error('[WebSocket] 消息处理错误:', error);
            console.error('[WebSocket] 错误堆栈:', error.stack);
            try {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: error.message
                }));
            } catch (sendError) {
                console.error('[WebSocket] 发送错误消息失败:', sendError);
            }
        }
    });
    
    ws.on('close', (code, reason) => {
        clients.delete(ws);
        clientUsers.delete(ws);
        authenticatedSockets.delete(ws);
        console.log(`[WebSocket] 客户端断开连接，代码: ${code}, 原因: ${reason}`);
    });
    
    ws.on('error', (error) => {
        console.error('[WebSocket] 连接错误:', error);
    });
});

async function processInput(data) {
  // 收到即盖章：日志与消息都带上真实发生时间，不再出现「时间戳: 未提供」
  if (data && !data.timestamp) {
    data.timestamp = Date.now();
  }
  // 🖼️ 只发图不打字也放行：补一行占位正文，记忆/历史/日志都有可读内容
  if (data && data.image && (!data.data || !String(data.data).trim())) {
    data.data = '[图片]';
  }
  // 唯一输入闸门：先把肉眼不可见的字符剥掉，再往下走。
  // 放在这里而不是 output.js，是因为这条原文还会被写进历史、记忆、情绪、日程——
  // 只清 prompt 不清存档，下一轮从历史里又把它读回来，等于没防。
  if (data && typeof data.data === 'string') {
    const scrubbed = scrubUserText(data.data);
    if (scrubbed.changed) {
      console.warn(`[输入防护] 移除 ${scrubbed.removed.length} 类隐形字符：${scrubbed.removed.join(' ')}`);
      data.data = scrubbed.text;
    }
  }
  // 附图 base64 不写进日志/调试面板：只留长度，避免几十万字符刷屏
  const loggable = (data && data.image)
    ? { ...data, image: `[图片 base64 ${String(data.image).length} 字符]` }
    : data;
  devTool.logSendData(loggable);
  
  try {
    console.log('开始处理输入数据:', loggable);
    
    const { sessionId, userId } = data;

    // 缺 sessionId/userId 直接拒绝——以前会回退到 default 记忆池，导致没选角色的用户
    // 把消息混进 default 档，而 default 档又会被别人的会话读取，彻底打乱隔离
    if (!sessionId || !userId) {
      return {
        type: 'text',
        data: '请先选择一个角色再开始对话。',
        emotion: { type: 'calm', intensity: 0.3 },
        relationship: galgameModule.getCurrentRelationship('default', 'default'),
        sessionId: null,
        userId: null
      };
    }

    const history = userId 
      ? sessionManager.getConversationHistory(sessionId, userId, 5) 
      : [];
    console.log('获取到历史对话:', history.length, '条');
    
    // 主聊天走 WebSocket，登录态由前端在 data.authSessionId 中携带，以此取出该用户的自定义API配置
    let userApiConfig = null;
    if (data.authSessionId) {
      const loginSession = authModule.validateSession(data.authSessionId);
      if (loginSession && loginSession.username) {
        const rawConfig = authModule.getCustomApiConfigRaw(loginSession.username);
        if (rawConfig && rawConfig.enabled && rawConfig.apiUrl) {
          userApiConfig = rawConfig;
          console.log(`[processInput] 用户 ${loginSession.username} 启用自定义API: ${rawConfig.apiUrl}`);
        }
      }
    }
    
    // 登记本会话的活跃时间与用户自定义API，作为自主发言调度的计时基准
    systemNarrator.noteUserMessage(sessionId, userId, userApiConfig);
    
    const processedInput = await inputModule.process(data, history, userApiConfig);
    console.log('inputModule.process 返回');
    
    const userIdentifier = userId;
    // 人格分区自动判定：命中「元层面」问法（查代码 / 跑脚本 / 系统自检等）进入 AI 态，
    // 之后按 AI 档落账（AI 态读取时会连带角色档，角色态则读不到 AI 档）；连续两轮不相关退回角色态
    const personaScope = sessionManager.resolvePersonaScope(userIdentifier, data?.data);
    // 角色态记忆可能带人设世代后缀（换过不相干角色时天然进新档）；AI 态记忆属于用户本身，不随角色隔离
    const memoryOwner = personaScope === 'ai'
      ? userIdentifier
      : sessionManager.getScopedUserId(sessionId, userIdentifier);
    const memoryKey = memoryModule.normalizeScopeKey(memoryOwner, personaScope);
    const storedMemory = memoryModule.storeMemory(processedInput, memoryKey, data?.data, {
        speaker: 'user',
        source: personaScope === 'ai' ? 'web_ai' : 'web_role'
    });
    if (!storedMemory.stored) {
      console.log('memoryModule.storeMemory 内容被过滤');
    } else if (storedMemory.queued) {
      // 已进待落盘队列：写盘由记忆模块的合并落盘负责，失败会累计在 memoryModule.saveFailures
      console.log('memoryModule.storeMemory 完成（已排队落盘）');
    }
    
    emotionModule.updateEmotion(processedInput.value, sessionId, userIdentifier, processedInput.signals);
    // 情感履历记账：跑在 setImmediate 里，绝不阻塞本轮回复
    setImmediate(() => {
      emotionLedger.observe(processedInput, {
        sessionId, userId: userIdentifier, text: data?.data, source: 'chat'
      }).catch(error => console.error('[情感工具] 履历记账失败:', error.message));
    });
    const emotionState = emotionModule.calculateEmotion(sessionId, userIdentifier);
    console.log('emotionModule.calculateEmotion 返回');
    
    // 先生成输出（让API先返回好感度变化）
    const outputData = {
      ...data,
      semantic: processedInput.semantic
    };
    
    let output;
    try {
      // 必须把该会话当前的关系档位带进去：传 null 会让 output.js 一律回退成 STRANGER，
      // 结果关系早已到 LOVER、系统提示词里却还写着「陌生（刚认识）」，角色只能演陌生人
      // 互动运行时：本轮的输出实例与场景独立，会话库/情绪/记忆仍与其他通道共享
      output = await interactionRuntime.outputModule.generateOutputAsync(
        emotionState, 
        galgameModule.getCurrentRelationship(sessionId, userIdentifier), // 本轮好感度变化在下方 updateRelationship 才生效，这就是本次回复应依据的关系
        outputData, 
        history,
        sessionId,
        userId,
        userApiConfig,
        personaScope,
        interactionRuntime.scenePrompt
      );
      console.log('outputModule.generateOutputAsync 返回');
    } catch (outputError) {
      console.error('输出生成失败，使用本地生成:', outputError.message);
      output = outputModule.localStyleGenerate(
        emotionState?.primaryEmotion || emotionState?.type || 'calm',
        galgameModule.getCurrentRelationship(sessionId, userIdentifier).stage
      );
    }
    
    // 获取API返回的好感度变化（做类型校验，避免非数值污染好感度）
    const apiAffectionChange = typeof output.apiAffectionChange === 'number' ? output.apiAffectionChange : null;
    const apiThinking = typeof output.apiThinking === 'string' ? output.apiThinking : '';
    
    // 更新关系状态，传入API返回的好感度变化与判定理由
    const relationshipStatus = galgameModule.updateRelationship(processedInput, apiAffectionChange, apiThinking, sessionId, userIdentifier);
    console.log('galgameModule.updateRelationship 返回');
    
    // 更新output中的关系状态
    output.relationship = relationshipStatus;
    // 标记本条输出所属会话，前端据此只渲染当前角色的消息，避免多角色串台
    output.sessionId = sessionId;
    
    if (sessionId && userId) {
      const currentUser = sessionManager.getUser(sessionId, userId);
      if (currentUser) {
        const localDelta = (Number(processedInput.value) || 0) * 5;
        const scoreDelta = apiAffectionChange !== null ? apiAffectionChange : localDelta;
        const newScore = currentUser.relationshipScore + scoreDelta;
        sessionManager.updateUserRelationship(sessionId, userId, newScore);
      }
    }
    
    if (!output.timestamp) {
      output.timestamp = Date.now();
    }
    devTool.logReceiveData(output);
    broadcastOutput(output);
    console.log('处理输入数据完成');
    
    return output;
  } catch (error) {
    console.error('处理输入数据时出错:', error);
    
    const errorOutput = {
      type: 'text',
      data: '抱歉，系统暂时无法响应，请稍后再试。',
      emotion: { type: 'calm', intensity: 0.5 },
      relationship: galgameModule.getCurrentRelationship(data?.sessionId, data?.userId)
    };
    broadcastOutput(errorOutput);
    
    throw error;
  }
}

function broadcastOutput(output) {
    // 创建输出的干净副本，移除好感度变化信息（不显示在对话中）
    const cleanOutput = { ...output };
    
    // 如果有relationship字段，移除affectionChange
    if (cleanOutput.relationship) {
        cleanOutput.relationship = { ...cleanOutput.relationship };
        delete cleanOutput.relationship.affectionChange;
    }
    
    // 移除顶层可能的affectionChange
    delete cleanOutput.affectionChange;
    
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(cleanOutput));
        }
    });
}

// 社交平台的独立广播通道：type 与正式对话区分开，
// 主控制台页面即使同时开着也不会把大厅发言渲染成当前角色的回复
function broadcastSocial(payload) {
    const message = JSON.stringify({ type: 'social-message', payload });
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// 角色自主发言回调：由 SystemNarrator 按会话独立调度、判定后调用
function handleProactiveSpeech({ sessionId, userId, text, shouldContinue, idleMinutes }) {
    if (!text) return;

    // 落库进该会话历史，保证后续对话上下文连贯（含真实时间，角色下次便看得见自己上一句）
    if (sessionId && userId) {
        try {
            sessionManager.addConversationMessage(sessionId, userId, {
                role: 'assistant',
                content: text,
                timestamp: Date.now(),
                // 标记为角色自己主动开口（未经用户触发），供后续检索/AI 态辨认
                proactive: true
            });
        } catch (error) {
            console.error('[自主发言] 写入会话历史失败:', error.message);
        }
        // 与 QQ 链路对齐：她主动说出口的话也进长期记忆（speaker='self'）。
        // 短期历史滑走后，她仍知道「这是我提过的」，不会把自己的话当成对方说的事实
        try {
            const scoped = sessionManager.getScopedUserId(sessionId, userId);
            memoryModule.storeMemory(
                { value: 0, scene: '' },
                memoryModule.normalizeScopeKey(scoped, 'role'),
                `（你在网页里主动说）${text}`,
                { speaker: 'self', source: 'web_proactive' }
            );
        } catch (error) {
            console.error('[自主发言] 写入自我记忆失败:', error.message);
        }
    }

    const proactiveOutput = {
        type: 'text',
        data: text,
        isSystemNarration: false,
        proactive: true,
        timestamp: Date.now(),
        sessionId,
        userId,
        emotion: emotionModule.getCurrentEmotions(sessionId, userId),
        relationship: galgameModule.getCurrentRelationship(sessionId, userId)
    };

    devTool.logReceiveData(proactiveOutput);
    broadcastOutput(proactiveOutput);
    console.log(`[自主发言] 会话 ${sessionId} 距上次消息 ${idleMinutes} 分钟，继续说=${shouldContinue}`);
}

// 对话输入 + 本地语义分析/训练（已抽到 ./routes/input，依赖经 ctx 注入）
require('./routes/input')(app, {
    requireLogin, serverError, processInput, systemNarrator, galgameModule,
    inputModule, dialogueRetriever, semanticLearner, outputModule
});

// 状态 / 记忆概览与记忆维护（已抽到 ./routes/status，依赖经 ctx 注入）
require('./routes/status')(app, { requireLogin, serverError, emotionModule, galgameModule, memoryModule, systemNarrator, expressionProjection, deviceLink });

// 摄像头 / 屏幕（已抽到 ./routes/capture，依赖经 ctx 注入）
require('./routes/capture')(app, { serverError, cameraModule, screenModule });

// 实时视觉（浏览器端检测，只收结构化 track；已抽到 ./routes/vision，依赖经 ctx 注入）
require('./routes/vision')(app, { serverError, systemNarrator });

// 安全护栏：命令拦截账本与路径溯源（只读；已抽到 ./routes/security，依赖经 ctx 注入）
require('./routes/security')(app, { requireLogin, serverError });

// AI 配置与进程管理（已抽到 ./routes/aiConfig，依赖经 ctx 注入）
require('./routes/aiConfig')(app, { requireHost, serverError, inputModule, outputModule, systemNarrator, processManager, saveApiNames });

// 研究平台（她的免授权自留地）路由（已抽到 ./routes/research，依赖经 ctx 注入）
require('./routes/research')(app, { requireHost, serverError, toolRegistry, researchAgent });

// 表达学习平台（口语语料 / 学习笔记 / 学习约定；页面 public/expressive.html）
require('./routes/expressive')(app, { requireHost, serverError, outputModule });

// 开源方案准入通道：单通道评审页（页面 public/intake.html）
require('./routes/intake')(app, { requireHost, serverError });

// 取景器：windows-mcp sidecar 采集参考界面 → 比例化 spec → 同尺子渲染（仅本机）
require('./routes/design')(app, { requireHost, serverError });

// 编程沙箱 + 编程团队 + 点子板 + 编码闭环（已抽到 ./routes/coding，依赖经 ctx 注入）
require('./routes/coding')(app, { serverError, requireCodingUser, codingOwner, CODING_CLOUD_MODE, discussProgress, reviewProgress, PROGRESS_ID_RE, normalizeProgressToken, toolRegistry, codingTeam, codingLoop, codingWorkers, codingCompetition, sandboxAgents, agentFleet, authModule, createReadTools });

// 自由创意世界（public/creative.html）：等距棋盘 + 纯色方块；仅本机可开
require('./routes/creative')(app, {
    requireHost, serverError, creativeWorld: toolRegistry.creativeWorld, creativeRuntime
});

// 本地技能市场：技能包列表 / 详情 / 新建 / 删除 / 导出 / 导入（已抽到 ./routes/skills，依赖经 ctx 注入）
require('./routes/skills')(app, { requireCodingUser, serverError, skillStore: new SkillStore(path.join(__dirname, '..', '..')) });

// 沙箱进化闸（参数外置层 + 进化闸门，管理端专属；已抽到 ./routes/evolution，依赖经 ctx 注入）
require('./routes/evolution')(app, { requireAdmin, serverError, evolutionGate, evolutionParams });

// 开发者日志 / 好感度规则 / 旁白 / 时间表 / 备份（已抽到 ./routes/ops，依赖经 ctx 注入）
require('./routes/ops')(app, { requireAdmin, requireHost, serverError, galgameModule, systemNarrator, scheduleStore, backupManager });

// 会话管理（已抽到 ./routes/session，依赖经 ctx 注入）
require('./routes/session')(app, {
    requireHost, serverError, authModule, sessionManager, outputModule, canAccessCharacter, personaEvolution
});

// 社交平台（网页端群聊大厅；QQ / B 站链路不引用）
require('./routes/social')(app, { requireLogin, serverError, socialPlaza });

// 她的动态（朋友圈）：读流 / 点赞 / 评论；内容取自私生活档案，不建新存储
require('./routes/feed')(app, { requireLogin, serverError, privateLife, sessionManager, outputModule });
// 🌙 她的一天：只从登录会话解析 scope，不认请求里的 userId（防后缀穿透）
require('./routes/timeline')(app, { requireLogin, serverError, timeline, memoryModule });
require('./routes/memory')(app, { requireLogin, serverError, memoryModule, galgameModule, emotionModule });
// 🌱 学习任务：白名单取数 / 沙箱分析训练 / 带 manifest 沉淀到 data/learn（读需登录，写入需本机）
require('./routes/learning')(app, { requireLogin, requireHost, serverError, learning: toolRegistry.learning });

// 大神蒸馏 + 圆桌：联网取公开语料 → 产人格 → 二次筛查 → 多人讨论（搜索/抓取复用 toolRegistry）
require('./routes/experts')(app, { requireLogin, serverError, toolRegistry });

// 陪她玩：开局 / 出手 / 认输；判定走 gameTable，赢了写好感度
// 这是用户↔角色的互动，出口用互动运行时（场景提示与工具策略跟自主生活分开）
require('./routes/games')(app, { requireLogin, serverError, gameTable, galgameModule, sessionManager, outputModule: interactionRuntime.outputModule });

// 她们的闲话：只读群聊大厅的影子印象，展示角色之间互相留下的印象（不新增存储、不调模型）
require('./routes/gossip')(app, { requireLogin, serverError, socialPlaza, sessionManager });

// 中转站：OpenAI / Anthropic 兼容入口 + 管理接口（已抽到 ./routes/relay，依赖经 ctx 注入）
require('./routes/relay')(app, { requireLogin, serverError, relayHub, isHostRequest });

// 只接受 http/https，避免 file:// 之类的协议被塞进配置里
function validateServiceUrl(value) {
    if (!value) return true;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (error) {
        return false;
    }
}

// 用户自定义 API（已抽到 ./routes/userApi，依赖经 ctx 注入）
require('./routes/userApi')(app, { requireHost, serverError, authModule, userApiClient });

// 全局服务配置（已抽到 ./routes/globalConfig，依赖经 ctx 注入）
require('./routes/globalConfig')(app, { requireLogin, serverError, globalConfig, validateServiceUrl });

// QQ 对接读取接口 + 群聊桥接（已抽到 ./qq/，依赖经 ctx 注入）
require('./qq/onebotRoutes')(app, { requireAdmin, serverError, oneBotConfig, oneBotClient, validateServiceUrl });
const { startQQProactiveSpeech } = require('./qq/bridge')(app, {
    oneBotClient, memoryModule, sessionManager, cideEngine, toolRegistry,
    appointmentBook, emotionModule, inputModule, emotionLedger, galgameModule,
    // QQ 的会话库/输出实例/私生活由运行时统一装配，桥接只消费
    qqRuntime,
    requireAdmin
});

// B站直播 + TTS 路由（已抽到 ./bilibili，依赖经 ctx 注入）
require('./bilibili')(app, { requireHost, requireAdmin, serverError, biliLiveConfig, biliBridge, ttsModule });

// 画板笔迹存档（已抽到 ./routes/canvas，依赖经 ctx 注入）
require('./routes/canvas')(app, { requireHost, serverError });

// 认证：根页面 + 登录/注册/登出/校验/改密（已抽到 ./routes/auth，依赖经 ctx 注入）
require('./routes/auth')(app, {
    rateLimit, serverError, authModule, securityModule, getClientIp, isHostRequest
});

// 启动装配 / 生命周期（已抽到 ./lifecycle，依赖经 ctx 注入）
const { onServerReady, onListenError, flushMemoryOnExit } = require('./lifecycle')({
    memoryModule, inputModule, systemNarrator, startQQProactiveSpeech, writeServerLock, clearServerLock
});

// 管理员 / 用户 / 机器人 / 服务器关闭（已抽到 ./routes/admin，依赖经 ctx 注入）
require('./routes/admin')(app, { requireAdmin, requireHost, serverError, authModule, flushMemoryOnExit });

// 全局错误兜底：只兜「没被各路由内 try/catch 接住」的错误（请求体解析失败/过大、同步抛错等）。
// 路由内已自行 catch 的响应维持原样——全量改写那百余处状态码无 HTTP 契约测试兜底，属盲改，不做。
// 这里保证：漏网错误只写服务端日志，向客户端回一句通用话术，不回吐 error.message / 堆栈。
app.use((err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }
    const label = `${req.method} ${req.path}`;
    if (err && err.type === 'entity.too.large') {
        console.error(`[Server] 请求体过大 ${label}`);
        return res.status(413).json({ success: false, message: '请求体过大' });
    }
    if (err && err.type === 'entity.parse.failed') {
        console.error(`[Server] 请求体解析失败 ${label}`);
        return res.status(400).json({ success: false, message: '请求体格式错误' });
    }
    console.error(`[Server] 未捕获错误 ${label}:`, (err && err.stack) ? err.stack : err);
    return res.status(500).json({ success: false, message: '服务器内部错误' });
});

const PORT = config.serverPort || 41888;
// 本机自用：绑回回环地址，局域网/公网无法直连（若需手机/平板访问，再改回 0.0.0.0）
const HOST = '127.0.0.1';

// ws 会把 HTTP server 的 'error' 事件转发到 WebSocketServer 上，这里必须一并兜住，
// 否则端口占用时会以「Unhandled 'error' event on WebSocketServer」崩溃
wss.on('error', onListenError(PORT));

if (ENABLE_HTTP) {
    server.on('error', onListenError(PORT));
    server.listen(PORT, HOST, () => {
        console.log(`情感中枢服务器运行在 http://${HOST}:${PORT}`);
        coldStart.markReady();
        // 启动时预置证书基线：把 TOFU 提前到启动阶段，指纹直接打在日志里（幂等，两端口只跑一次）
        coldStart.probePins();
        onServerReady();
    });
}

if (httpsServer) {
    httpsServer.on('error', onListenError(HTTPS_PORT));
    httpsServer.listen(HTTPS_PORT, HOST, () => {
        console.log(`HTTPS 已开启：https://<局域网IP>:${HTTPS_PORT}（自签证书，浏览器提示不安全时点「继续访问」）`);
        coldStart.markReady();
        // 启动时预置证书基线：把 TOFU 提前到启动阶段，指纹直接打在日志里（幂等，两端口只跑一次）
        coldStart.probePins();
        onServerReady();
    });
}

// 设备上行文本直接复用网页端同一条对话链路，角色、记忆、工具、审批全部一致
// 一键开关：DEVICE_ENABLED=false 时不连平台、不轮询，robot_action 也不会出现在工具列表里
if (process.env.DEVICE_ENABLED !== 'false') {
    deviceLink.start({
        onInput: (text, meta) => processInput({
            type: 'text',
            data: text,
            sessionId: meta.sessionId,
            userId: meta.userId,
            timestamp: Date.now()
        })
    });
}
