const UserApiClient = require('./userApi');
const { UnifiedAPI } = require('./api');
const { CIDEEngine } = require('./cide');
const { buildIdentityLayer, buildTimeLayer } = require('./toolRegistry');
const ScheduleStore = require('./schedule');
// 内部思考块剥离器与主对话链（output.parseAffectionChange）共用同一份，两条正文化链口径一致
const { stripInternalBlocks, FACT_GROUNDING_INSTRUCTION } = require('./output');
const { liveVision } = require('./liveVision');

// 自主发言频率分档（按“距上次用户消息”的时长动态调节，每个会话独立计时）
// 这里只是兜底的“每小时最多几句话”硬上限；真正决定「这会儿到底该不该开口」的是
// CIDE 里的自主发言驱动力（表达欲消耗、冷却、Φ 价值门控、被打扰惩罚一起算）
// 30 分钟内算“刚聊完” → 8 句/小时；超过 3 小时算“很久没聊” → 3 句/小时；中间线性递减
const RECENT_WINDOW_MS = 30 * 60 * 1000;
const IDLE_WINDOW_MS = 3 * 60 * 60 * 1000;
const MAX_PER_HOUR_RECENT = 8;
const MAX_PER_HOUR_IDLE = 3;

// “还想继续说”由 API 每句话自己判断，但同样要过驱动力门控（阈值略放宽 + 续说冷却），
// 不再是无条件直通——否则一旦判真就会一路刷下去，这正是之前频率偏高的主因

// 模型自评「这会儿不想开口」后的静默期：避免每隔 30 秒就重新烧一次思考额度
const DECLINE_SILENCE_MS = 5 * 60 * 1000;

// 模型自评开口意愿低于这个值就不开口（人类的沉默是常态）
const MIN_URGE_TO_SPEAK = 0.6;

// 📊 闸门观测账本（只统计、不改行为）：把每轮 score/threshold/urge 与「本该被拦下」的次数记下来。
// 「沉默是常态」这几条硬闸门目前都软化成日志了，先出数据看清还剩几颗牙，判据动不改等看过数据再说
const GATE_SAMPLE_LIMIT = 200;

// 调度轮询间隔，以及会话状态保留时长（超过该时长没有再说话就不再跟踪）
const TICK_INTERVAL_MS = 30 * 1000;
const TRACK_TTL_MS = 24 * 60 * 60 * 1000;

// 状态驱动的判定节拍：30s 只是调度刻度，每个会话真正多久评估一次看它此刻的状态。
// 兴奋态才值得高频；刚聊完、久无人说话都该少跑（每一次放行都是一次 CIDE 思考 + 一次成文）
const EVAL_EXCITED_MS = 60 * 1000;        // 兴奋态：1 分钟
const EVAL_IDLE_MS = 90 * 1000;           // 常规：1.5 分钟
const EVAL_BUSY_MS = 3 * 60 * 1000;       // 刚聊过：3 分钟，别贴脸
const EVAL_LONG_IDLE_MS = 5 * 60 * 1000;  // 久无互动：5 分钟，判定价值低
const LONG_IDLE_MS = 30 * 60 * 1000;

// 自主发言 RAG（防幻觉）的素材取件上限：历史/归档取最近若干条
const EVIDENCE_HISTORY_LIMIT = 8;
// 📚 书摘素材：只顺着「最近一条用户消息」去查书库；超过这个时间没聊过就不硬翻书（隔夜冷场不掉书袋）
const BOOK_QUERY_WINDOW_MS = 12 * 60 * 60 * 1000;

// 🍚 作息约束：半夜喊饿的根源是提示词里根本没告诉她现在几点，她眼里深夜和中午没区别
// 饭点：早7-9 / 午11-13 / 晚17-19；23:00-07:00 禁食话题；非饭点只许随口带符合角色设定的东西
const MEAL_WINDOWS = [
  { name: '早饭', start: 7, end: 9 },
  { name: '午饭', start: 11, end: 13 },
  { name: '晚饭', start: 17, end: 19 }
];
const NIGHT_MEAL_BAN_START = 23;
const NIGHT_MEAL_BAN_END = 7;
// 她自己刚提过吃的话，这段时间内不再提（硬闸门：实测十几分钟连喊三次饿就是这么来的）
const FOOD_MENTION_COOLDOWN_MS = 90 * 60 * 1000;
// 检测她一句话里是不是沾了吃的（匹配从宽，错杀的代价只是少吃一顿）
const FOOD_TOPIC_RE = /(吃饭|吃了|吃点|吃个|吃吗|吃吧|吃去|想去吃|饿了|肚子饿|有点饿|弄点吃的|弄吃的|煮|下面|鸡蛋盖饭|叉烧|零食|夜宵|宵夜|早饭|早餐|午饭|晚饭|晚餐|加餐)/;
// 事实性发言用低温，压缩「随机发挥」的空间（创作性表达才需要高温度）
const PROACTIVE_TEMPERATURE = 0.3;

// 🔥 兴奋态：happy 强度或 CIDE 觉醒度任一过线即视为「她正兴奋」。
// 兴奋时原有的意愿判断仍在（决定说什么），但放行条件只剩「调用时间」——
// 不再看每小时句数分档、也不再被 CIDE 意愿低分拦下，只隔一个最小调用间隔就允许开口。
const EXCITED_HAPPY_MIN = Number(process.env.PROACTIVE_EXCITED_HAPPY_MIN) || 0.75;
const EXCITED_AROUSAL_MIN = Number(process.env.PROACTIVE_EXCITED_AROUSAL_MIN) || 8;
const EXCITED_MIN_INTERVAL_MS = Number(process.env.PROACTIVE_EXCITED_MIN_INTERVAL_MS) || 2 * 60 * 1000;
// 兴奋连发：每说完一句就再排一次请求，间隔按衰减系数逐次拉长；
// 没人接话最多连发这么多句（默认 10），用户一说话立刻清零。
const EXCITED_CHAIN_MAX = Number(process.env.PROACTIVE_EXCITED_MAX_CHAIN) || 10;
const EXCITED_CHAIN_BASE_MS = Number(process.env.PROACTIVE_EXCITED_CHAIN_BASE_MS) || 3 * 60 * 1000;
const EXCITED_CHAIN_DECAY = Number(process.env.PROACTIVE_EXCITED_CHAIN_DECAY) || 1.35;

// 🗣️ 开口前征询：先单独发一次 API 问她此刻的状态与是否愿意开口，
// 只有明确返回同意才真正生成这句话（返回否定、解析失败、请求异常都不发）。
const CONSENT_ENABLED = process.env.PROACTIVE_CONSENT_ENABLED !== 'false';

// 🗣️ 饱和即停：同一主题在窗口内被反复当自主发言由头 → 冷却，宁可不说也不复读。
// 这是治「白连续 6 条绕临摹」那类复读最直接的一步（见《类脑记忆生命周期设计方案（v2）》§4.3）。
// 判定只看「发言文本的主题指纹」，不碰记忆字段、不依赖不稳定的 topicId
const SPEECH_THEME_WINDOW_MS = 6 * 60 * 60 * 1000;  // 主题指纹窗口：6 小时
const SPEECH_THEME_SIM_THRESHOLD = 0.35;            // 字面重合度达到这个比例视为同一主题
const SPEECH_THEME_SATURATION_COUNT = 3;            // 同一主题累计说到第 3 次即饱和
const SPEECH_THEME_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 饱和后的静默时长

// 主题指纹：去空白/标点后的相邻二字片段集合
function buildThemeGrams(text) {
  const clean = String(text || '').replace(/[\s\p{P}，。！？、~…“”‘’（）()【】《》,.!?;:'"…·-]/gu, '');
  const grams = new Set();
  for (let i = 0; i < clean.length - 1; i++) grams.add(clean.slice(i, i + 2));
  if (grams.size === 0 && clean.length > 0) grams.add(clean);
  return grams;
}

// 两个主题指纹的重合度：交集 ÷ 较小集合（短句被长句「容纳」也算同主题）
function themeSimilarity(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const gram of small) {
    if (large.has(gram)) inter++;
  }
  return inter / small.size;
}

class SystemNarrator {
  constructor(memoryModule, options = {}) {
    this.memoryModule = memoryModule;
    this.sessionManager = options.sessionManager || null;
    this.hasClients = typeof options.hasClients === 'function' ? options.hasClients : () => true;
    this.onSpeech = typeof options.onSpeech === 'function' ? options.onSpeech : null;
    this.unifiedAPI = new UnifiedAPI();
    // 用户自带的自定义 API：自主发言优先走该用户自己的 API
    this.userApiClient = new UserApiClient();
    // CIDE（意识启发式自主思考引擎）：自主发言前先做内部思考，由其“自主思考驱动源”产生话头
    // 与正式回复共用同一个引擎实例，从而共享全局工作空间（工作记忆）
    this.cide = options.cide || new CIDEEngine({ unifiedAPI: this.unifiedAPI });
    this.useCide = process.env.PROACTIVE_SPEECH_USE_CIDE !== 'false';
    // 提供当前情绪与关系阶段的回调，供 CIDE 内部思考使用
    this.getContext = typeof options.getContext === 'function' ? options.getContext : null;
    // 🏷️ 场景层：同一个 narrator 出口固定在一个场景（如 QQ 私聊），开口时要先知道自己在哪说话
    this.scenePrompt = typeof options.scenePrompt === 'string' ? options.scenePrompt : '';
    // 系统框架工具注册表：仅用于身份层描述可用框架能力
    this.toolRegistry = options.toolRegistry || null;
    // 可选的工具过滤：QQ 这类聊天场景不下发框架工具，省掉每次上万 token 的工具 schema
    this.toolFilter = typeof options.toolFilter === 'function' ? options.toolFilter : null;
    // 正式回复模块：借它的工具循环让自主发言也能真的调用工具（复用同一套执行/回填逻辑）
    this.outputModule = options.outputModule || null;
    // 📚 书摘检索器（Qdrant 豆瓣书库）：自主发言时顺话题补一条"她读过的书"做素材，没传就不带书摘
    this.knowledgeRetriever = options.knowledgeRetriever || null;
    // 📅 事件簿：聊天里记下的约定/日程，到点前叮嘱、过点后追问（没传就不启用这条通道）
    this.appointmentBook = options.appointmentBook || null;
    // 已经因为「找不到主人会话」而记过日志的事件 id，避免每轮 tick 都刷同一条
    this.unroutableAppointments = new Set();
    // 事件簿只投给哪些会话：QQ 侧只有管理员会被登记成可主动私聊的对象，
    // 不设限的话会把非管理员的约定投进一个没人接收的会话，白白标成「已提醒」
    this.appointmentSessionFilter =
      typeof options.appointmentSessionFilter === 'function' ? options.appointmentSessionFilter : null;
    // 🏠 私生活档案：她自己那条不依赖用户的时间线（没传就既不生成也不注入）
    this.privateLife = options.privateLife || null;
    // 🫀 情绪模块：供内部信号回流（自主发言被冷落 / 被回应 → 情绪涟漪）。未注入则整条回流静默
    this.emotionModule = options.emotionModule || null;
    // 🕰️ 时间线：自主开口的通道标签（web / qq），与正式回复各端互不重复记账。
    // 由装配处注入实例（测试传临时目录的 store，避免往真实 data/ 写）
    this.timelineChannel = options.timelineChannel === 'qq' ? 'qq' : 'web';
    this.timeline = options.timeline || null;

    this.enabled = process.env.PROACTIVE_SPEECH_ENABLED !== 'false';
    // 角色自己排的时间表（默认关闭），到点由角色主动开口，和上面的频率分档互不影响
    this.scheduleStore = options.schedule || new ScheduleStore();
    this.sessions = new Map();
    this.timer = null;
    this.isTicking = false;
    this.lastSpeechAt = 0;
    // 🍚 记她上次在自主发言里提吃的时间（sessionId -> 时间戳），喂给饭点硬闸门
    this.lastFoodMentionAt = new Map();
    // 🗣️ 自主发言主题指纹（sessionId -> [{ grams, count, at }]），用于「饱和即停」防复读
    this.speechThemes = new Map();
    // 🔥 兴奋连发的待触发定时器（sessionId -> timer）：用户一接话就取消，别把旧链续上
    this.excitedTimers = new Map();
    // 📊 闸门观测账本（只出数据、不改是否发言的行为）：
    // ticks 走过闸门判定的会话轮次；passed 放行次数；lowScoreBlocked 被 0.3 低限挡下；
    // wouldBlockByThreshold 若按 CIDE 硬阈值本该拦下的次数（现只 warn 不拦）；
    // wouldBlockByUrge 若按 MIN_URGE_TO_SPEAK 本该拦下的次数（现只 warn 不拦）
    this.gateStats = {
      ticks: 0,
      passed: 0,
      lowScoreBlocked: 0,
      wouldBlockByThreshold: 0,
      wouldBlockByUrge: 0,
      samples: [],
      urgeSamples: []
    };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick();
    }, TICK_INTERVAL_MS);
    console.log(`[SystemNarrator] 自主发言调度已启动（${this.enabled ? '开启' : '关闭'}）`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    console.log(`[SystemNarrator] 自主发言已${this.enabled ? '开启' : '关闭'}`);
  }

  isEnabled() {
    return this.enabled;
  }

  ensureState(sessionId) {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        userId: null,
        userApiConfig: null,
        lastUserMessageAt: Date.now(),
        lastSpeechAt: 0,
        speechTimestamps: [],
        continuing: false,
        silenceUntil: 0,
        // —— 新增：用户输入 / 处理状态挡门 —— 🌀
        processing: false,     // 后端正在处理该用户的消息（/api/input 到 res.json 整个区间）
        generating: false,     // 该会话的正式回复正在生成中（避免 narrator 与正式回复抢 API）
        lastTypingAt: 0,       // 前端 WebSocket 最近一次 typing 事件时间戳
        // 🔥 兴奋连发计数：只在兴奋态累加，用户一说话就清零
        excitedChainCount: 0,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  // 挡门 1：后端正在处理 /api/input → narrator 闭嘴别插话
  setProcessing(sessionId, value) {
    const state = this.ensureState(sessionId);
    const changed = state.processing !== !!value;
    state.processing = !!value;
    if (changed) {
      console.log(`[SystemNarrator] ${sessionId} processing=${state.processing}（后端${state.processing ? '正在处理用户消息' : '处理完毕'}）`);
    }
  }

  // 挡门 2：正式回复正在生成（output.js generateOutputAsync 里置 true / false）
  setGenerating(sessionId, value) {
    const state = this.ensureState(sessionId);
    state.generating = !!value;
  }

  // 挡门 3：前端刚有 typing 事件（用户正在输入还没 send）
  noteTyping(sessionId) {
    const state = this.ensureState(sessionId);
    state.lastTypingAt = Date.now();
  }

  // 用户发消息时登记该会话的活跃时间与当前使用的 API 配置
  noteUserMessage(sessionId, userId, userApiConfig = null) {
    if (!sessionId) return;
    const state = this.ensureState(sessionId);
    if (userId) state.userId = userId;
    state.userApiConfig = userApiConfig || null;
    state.lastUserMessageAt = Date.now();
    state.continuing = false;
    state.silenceUntil = 0;
    // 人回来了：兴奋连发立刻收手，旧链上的定时器一并拆掉
    state.excitedChainCount = 0;
    this.clearExcitedTimer(sessionId);
    state.speechTimestamps = state.speechTimestamps.filter((t) => Date.now() - t < 60 * 60 * 1000);
    // 用户搭理了：驱动力回血，「被冷落」的账一笔勾销
    if (this.cide) {
      // 先看一眼「她上句话是不是还在等回应 / 是否攒了冷落」——回应的是自己人，这本身就该有点情绪涟漪
      const wasWaiting = (() => {
        try {
          const drive = this.cide.getDrive(sessionId);
          return !!drive && (drive.pendingFeedback === true || drive.ignoredStreak > 0);
        } catch {
          return false;
        }
      })();
      this.cide.noteUserMessage(sessionId);
      if (wasWaiting) {
        // 被冷落后终于有人接：回暖
        this.emitInternalEmotion(sessionId, state, { type: 'happy', intensity: 0.25 }, 'narrator.answered');
      }
    }
  }

  // 🫀 内部信号回流：把「她自己发起的行为被如何对待」折成一条情绪涟漪交给情绪模块。
  // 默认关（由 emotionModule.isInternalSignalEnabled 把关）；未注入情绪模块或未开启时静默跳过。
  emitInternalEmotion(sessionId, state, signal, source) {
    if (!this.emotionModule || typeof this.emotionModule.applyInternalSignal !== 'function') return;
    if (typeof this.emotionModule.isInternalSignalEnabled === 'function' && !this.emotionModule.isInternalSignalEnabled()) return;
    this.emotionModule.applyInternalSignal(signal, {
      sessionId,
      userId: this.resolveUserId(sessionId, state),
      source
    });
  }

  // 取该会话的实际归属用户：优先用登记过的 userId，没有则退回会话创建者。
  // 缺 userId 会导致历史读不到、自主发言也写不回历史——角色便「看不见自己上一句说了什么」
  resolveUserId(sessionId, state) {
    if (state && state.userId) return state.userId;
    if (!this.sessionManager || typeof this.sessionManager.getSession !== 'function') return null;
    const session = this.sessionManager.getSession(sessionId);
    if (!session) return null;
    const users = Object.values(session.users || {});
    const owner = users.find((user) => user && user.isCreator) || users[0];
    if (!owner || !owner.userId) return null;
    if (state) state.userId = owner.userId;
    return owner.userId;
  }

  // 🕰️ 时间线 scope：与记忆层同一套键（角色态带人设世代后缀），不另造一套
  timelineScopeFor(sessionId, userId) {
    if (!userId) return null;
    const base = (this.sessionManager && typeof this.sessionManager.getScopedUserId === 'function')
      ? this.sessionManager.getScopedUserId(sessionId, userId)
      : userId;
    return (this.memoryModule && typeof this.memoryModule.normalizeScopeKey === 'function')
      ? this.memoryModule.normalizeScopeKey(base, 'role')
      : `${base}__role`;
  }

  // 把时间戳格式化成「MM-DD HH:mm」，拼在每条历史前让角色看清那句话是什么时候说的
  formatClock(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '时间未知';
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // 🍚 当前时刻的人类作息描述：时段名 + 是否饭点 + 是否深夜禁食窗口
  describeDaypart(date = new Date()) {
    const hour = date.getHours();
    const isNight = hour >= NIGHT_MEAL_BAN_START || hour < NIGHT_MEAL_BAN_END;
    const meal = MEAL_WINDOWS.find((w) => hour >= w.start && hour < w.end) || null;
    let part;
    if (hour >= 23 || hour < 5) part = '深夜';
    else if (hour < 7) part = '凌晨';
    else if (hour < 9) part = '早晨';
    else if (hour < 11) part = '上午';
    else if (hour < 13) part = '中午';
    else if (hour < 17) part = '下午';
    else if (hour < 19) part = '傍晚';
    else part = '晚上';
    return { hour, part, meal, isNight };
  }

  // 🍚 作息提示词块：告诉 她「现在几点」+ 饭点规则 + 自己养成的作息习惯，
  // 再用「她最近自己提过吃」的硬闸门拦住连环喊饿
  buildDaypartPrompt(sessionId, recentHistory = []) {
    const now = new Date();
    const { part, meal, isNight } = this.describeDaypart(now);
    const clock = this.formatClock(now.getTime());

    let rule;
    if (isNight) {
      rule = '现在是深夜23点到早上7点，正常人这时候在睡觉。你绝对不许提吃饭、饿、弄吃的、夜宵，也不许叫人起来吃东西；想开口就说困了、懒得动、要睡了这类。';
    } else if (meal) {
      rule = `现在正处在${meal.name}的饭点，这时候说饿了、说弄吃的才合情理。`;
    } else {
      rule = '现在不是饭点（饭点只有早7-9、午11-13、晚17-19），不许喊饿、不许说要弄正餐；只有符合你设定的东西可以随口带一句，但不能当主题。';
    }

    // 硬闸门：取「内存记账」和「最近历史里她自己的吃话题」中较新的一条
    let lastFoodAt = this.lastFoodMentionAt.get(sessionId) || 0;
    (recentHistory || []).forEach((msg) => {
      if (msg && msg.role === 'assistant' && FOOD_TOPIC_RE.test(String(msg.content || ''))) {
        const ts = msg.timestamp || 0;
        if (ts > lastFoodAt) lastFoodAt = ts;
      }
    });
    if (lastFoodAt) {
      const minsAgo = Math.round((Date.now() - lastFoodAt) / 60000);
      if (minsAgo >= 0 && minsAgo < FOOD_MENTION_COOLDOWN_MS / 60000) {
        rule += `另外你 ${minsAgo} 分钟前刚提过吃的，这次一个字都不许再沾吃的话题，说点别的：手头的事、忽然想到什么都行。`;
      }
    }

    return `\n【现在几点·作息规则】真实时间是 ${clock}（${part}）。${rule}\n你有自己养成的作息习惯：三餐跟着饭点走，深夜23点后犯困想睡，白天忙自己的事；你给自己排的计划任务都是照这个习惯安排的，到点做计划内的事很自然。说的话要符合这个时间点正常人正在做、正在想的事。`;
  }

  // 基础频率：20 句/小时 线性衰减到 5 句/小时
  // 再按关系亲疏缩放上限：生分时压到 45%，熟了最多比满额松 15%，不会突破 MAX_PER_HOUR_RECENT
  baseRatePerHour(idleMs, affinityScore = null) {
    let base;
    if (idleMs <= RECENT_WINDOW_MS) {
      base = MAX_PER_HOUR_RECENT;
    } else if (idleMs >= IDLE_WINDOW_MS) {
      base = MAX_PER_HOUR_IDLE;
    } else {
      const ratio = (idleMs - RECENT_WINDOW_MS) / (IDLE_WINDOW_MS - RECENT_WINDOW_MS);
      base = MAX_PER_HOUR_RECENT - ratio * (MAX_PER_HOUR_RECENT - MAX_PER_HOUR_IDLE);
    }
    if (!Number.isFinite(affinityScore)) return base;
    const closeness = Math.max(0, Math.min(1, affinityScore / 100));
    return Math.max(1, Math.min(MAX_PER_HOUR_RECENT, base * (0.45 + 0.7 * closeness)));
  }

  countLastHour(state) {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    state.speechTimestamps = state.speechTimestamps.filter((t) => t >= oneHourAgo);
    return state.speechTimestamps.length;
  }

  // 📊 记一条闸门样本（环形截断，长期运行也不会无限膨胀）
  recordGateSample(sample) {
    const list = this.gateStats.samples;
    list.push(sample);
    if (list.length > GATE_SAMPLE_LIMIT) {
      list.splice(0, list.length - GATE_SAMPLE_LIMIT);
    }
  }

  // 📊 记一条模型自评开口意愿样本
  recordUrgeSample(sessionId, urge) {
    const list = this.gateStats.urgeSamples;
    list.push({ sessionId, urge: Math.round(urge * 100) / 100, at: Date.now() });
    if (list.length > GATE_SAMPLE_LIMIT) {
      list.splice(0, list.length - GATE_SAMPLE_LIMIT);
    }
  }

  // 📊 闸门观测快照：给 getStatus() / /api/narrator/status 读
  getGateStats() {
    const s = this.gateStats;
    return {
      ticks: s.ticks,
      passed: s.passed,
      lowScoreBlocked: s.lowScoreBlocked,
      wouldBlockByThreshold: s.wouldBlockByThreshold,
      wouldBlockByUrge: s.wouldBlockByUrge,
      recentGates: s.samples.slice(-10),
      recentUrges: s.urgeSamples.slice(-10)
    };
  }

  async tick() {
    if (this.isTicking) return;
    // 🏠 她过日子不依赖有没有人开着页面，所以这一步放在 hasClients 之前；
    // 但内部仍按「22 点后 + 当天没写过 + 三天内有对话」三重条件自我节制
    await this.tickLife();
    // 没有任何页面在看着时不必燃烧 API 额度
    if (!this.hasClients()) return;

    this.isTicking = true;
    try {
      await this.tickSchedule();
      await this.tickAppointments();
      if (this.enabled) {
        await this.tickProactive();
      }
    } finally {
      this.isTicking = false;
    }
  }

  async tickProactive() {
    if (this.sessions.size === 0) return;

    for (const [sessionId, state] of Array.from(this.sessions.entries())) {
      const now = Date.now();
      // 状态节流：没到该会话的下次判定时间就跳过——30s 只是调度刻度，不是每会话的判定频率
      if (state.nextEvalAt && now < state.nextEvalAt) continue;
      state.nextEvalAt = now + this.nextEvalDelay(sessionId, state);
      try {
        await this.tickSession(sessionId, state);
      } catch (error) {
        console.error(`[SystemNarrator] ${sessionId} 本轮判定失败:`, error.message);
      }
    }
  }

  // 按会话状态给下一次判定定时：只有兴奋态值得 1 分钟一评，
  // 刚聊过或久无互动都拉长间隔，省掉没必要的 CIDE 思考与成文调用
  nextEvalDelay(sessionId, state) {
    const now = Date.now();
    const idleMs = now - (state.lastUserMessageAt || now);
    const context = this.getContext ? this.getContext(sessionId, state.userId) : {};
    const excitement = this.getExcitement(sessionId, context);
    if (excitement.excited) return EVAL_EXCITED_MS;
    if (idleMs < 5 * 60 * 1000) return EVAL_BUSY_MS;
    if (idleMs > LONG_IDLE_MS) return EVAL_LONG_IDLE_MS;
    return EVAL_IDLE_MS;
  }

  // 单个会话的开口判定：常规轮询和兴奋连发共用这一条路径
  async tickSession(sessionId, state) {
    const now = Date.now();
    const TYPING_GRACE_MS = 10 * 1000;   // 用户最近 10 秒有 typing 活动 → 视为"可能还在输入"，跳过

    if (now - state.lastUserMessageAt > TRACK_TTL_MS) {
      this.sessions.delete(sessionId);
      this.clearExcitedTimer(sessionId);
      return;
    }

    // —— 输入状态挡门（三层，硬挡在前，软挡在后）—— 🌀
    if (state.processing) {
      // 1. 用户 send 了消息，后端正在跑 processInput → 别插话
      console.log(`[SystemNarrator] ${sessionId} 跳过：后端正在处理用户消息`);
      return;
    }
    if (state.generating) {
      // 2. 正式回复正在生成（output.js generateOutputAsync 未返回）→ 别抢 API 额度
      console.log(`[SystemNarrator] ${sessionId} 跳过：正式回复正在生成`);
      return;
    }
    if (state.lastTypingAt && now - state.lastTypingAt < TYPING_GRACE_MS) {
      // 3. 前端刚有 typing 事件（近 10s 有活动）→ 用户可能还在输入，等一等
      console.log(`[SystemNarrator] ${sessionId} 跳过：用户最近 ${Math.round((now - state.lastTypingAt) / 1000)}s 还在输入`);
      return;
    }

    // 模型刚说过「这会儿不想开口」：静默一会儿，别每 30 秒就重新烧一次思考额度
    if (state.silenceUntil && now < state.silenceUntil) return;

    const idleMs = now - state.lastUserMessageAt;
    const context = this.getContext ? this.getContext(sessionId, state.userId) : {};

    // 🔥 兴奋态：意愿判断照旧决定「说什么」，但放行条件只剩调用时间这一条
    const excitement = this.getExcitement(sessionId, context);
    if (excitement.excited) {
      if (state.lastSpeechAt && now - state.lastSpeechAt < EXCITED_MIN_INTERVAL_MS) {
        console.log(
          `[SystemNarrator] ${sessionId} 兴奋中，距上次开口才 ${Math.round((now - state.lastSpeechAt) / 1000)}s，未到最小调用间隔`
        );
        return;
      }
      this.gateStats.ticks += 1;
      this.gateStats.passed += 1;
      console.log(
        `[SystemNarrator] ${sessionId} 兴奋态（happy ${excitement.happy.toFixed(2)} / 觉醒 ${excitement.level.toFixed(1)}）：不看频率分档与意愿低分，只看调用间隔`
      );
      await this.speak(sessionId, state, { excited: true });
      return;
    }

    // 兜底硬上限：无论驱动力怎么算，每小时都不许超过这个句数（亲疏只缩放这个上限）
    const rate = this.baseRatePerHour(idleMs, context.affinityScore);
    if (this.countLastHour(state) >= rate) return;

    // 主闸门：CIDE 的自主发言驱动力
    // —— 弱限制：CIDE 只给倾向分 + 软提醒，不再硬挡 narrator —— 🌀
    // score 很低（< 0.3）才放行失败；高于这个就尊重 narrator 节奏尝试烧额度
    if (this.cide) {
      const gate = this.cide.evaluateProactiveSpeech(sessionId, {
        idleMs,
        emotion: context.emotion || 'calm',
        continuing: !!state.continuing,
        affinityScore: context.affinityScore
      });
      this.gateStats.ticks += 1;
      if (!gate.shouldSpeak) {
        // score < 0.3，驱动力极低——真的没什么想说的，尊重它继续等
        this.gateStats.lowScoreBlocked += 1;
        console.log(
          `[SystemNarrator] ${sessionId} 暂不开口（意愿 ${gate.score.toFixed(2)} 极低，未过 0.3 低限）`
        );
        return;
      }
      // 📊 只观测不改行为：按 CIDE 硬阈值本该被拦下、这里却放行了——记一笔，看闸门还剩几颗牙
      this.gateStats.passed += 1;
      this.recordGateSample({
        sessionId,
        score: Math.round(gate.score * 100) / 100,
        threshold: gate.threshold,
        at: Date.now()
      });
      if (typeof gate.threshold === 'number' && gate.score < gate.threshold) {
        this.gateStats.wouldBlockByThreshold += 1;
      }
      // CIDE 有软提醒就打出来让用户/开发者知道，但不挡门
      if (gate.warnings && gate.warnings.length > 0) {
        console.log(
          `[SystemNarrator] ${sessionId} 开口意愿 ${gate.score.toFixed(2)}/${gate.threshold}，CIDE 提醒：${gate.warnings.join('；')}`
        );
      }
    } else if (!state.continuing && now - state.lastSpeechAt < 3600000 / rate) {
      // 没接驱动力时退回原来的固定间隔
      return;
    }

    await this.speak(sessionId, state);
  }

  // 兴奋判定：happy 强度或 CIDE 觉醒度任一过线即算兴奋
  getExcitement(sessionId, context = {}) {
    const happy = context.emotion === 'happy' ? Number(context.emotionIntensity) || 0 : 0;
    let level = 0;
    try {
      level = this.cide && typeof this.cide.getArousal === 'function'
        ? Number(this.cide.getArousal(sessionId).level) || 0
        : 0;
    } catch {
      level = 0;
    }
    return { excited: happy >= EXCITED_HAPPY_MIN || level >= EXCITED_AROUSAL_MIN, happy, level };
  }

  // 🏠 到点替她补写「今天」的私人生活：每个会话每天最多一次，失败静默
  async tickLife() {
    if (!this.privateLife || typeof this.privateLife.tick !== 'function') return;
    if (!this.sessionManager) return;
    try {
      await this.privateLife.tick({ sessionManager: this.sessionManager });
    } catch (error) {
      console.warn('[SystemNarrator] 私生活生成失败（不影响发言）:', error.message);
    }
  }

  // 时间表到点检查：走的是同一条主动发言通道，但不吃频率分档的额度上限
  async tickSchedule() {
    if (!this.scheduleStore) return;
    const due = this.scheduleStore.takeDue();
    if (due.length === 0) return;

    const sessionId = this.pickScheduleSession();
    if (!sessionId) {
      console.warn('[定时任务] 到点了但没有可发言的会话，本次跳过');
      return;
    }

    const state = this.ensureState(sessionId);
    for (const task of due) {
      await this.speak(sessionId, state, { schedule: { time: task.time, note: task.note } });
    }
  }

  // 时间表是对着人说话的：优先挑最近说过话的那个会话；重启后还没人说话时退回最近更新的角色
  pickScheduleSession() {
    let picked = null;
    for (const state of this.sessions.values()) {
      if (!picked || state.lastUserMessageAt > picked.lastUserMessageAt) picked = state;
    }
    if (picked) return picked.sessionId;

    if (!this.sessionManager || typeof this.sessionManager.getAllSessions !== 'function') return null;
    const sessions = this.sessionManager.getAllSessions().filter((session) => session && session.sessionId);
    if (sessions.length === 0) return null;
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    const fallback = sessions[0];
    const state = this.ensureState(fallback.sessionId);
    const users = Object.values(fallback.users || {});
    const owner = users.find((user) => user && user.isCreator) || users[0];
    if (owner) state.userId = owner.userId;
    return fallback.sessionId;
  }

  // 📅 事件簿到点检查：像时间表一样走主动发言通道、不吃频率分档额度，
  // 但比时间表多一层体贴——用户正在打字 / 服务正忙着回复时不插嘴
  async tickAppointments() {
    if (!this.appointmentBook) return;
    const due = this.appointmentBook.takeDueForSpeech();
    if (due.length === 0) return;

    for (const { appointment, kind, minutesAway } of due) {
      // 找到这个约定所属用户的会话；找不到就留着下轮再看，绝不退到别人的会话去说
      const target = this.findSessionForUser(appointment.userId);
      if (!target) {
        // 不标掉：这条约定可能属于另一个 narrator（如 QQ 侧），或者主人还没回来。
        // 一旦标掉，等主人真出现时也永远不会再提醒；这里只记一次日志，下轮继续等。
        if (!this.unroutableAppointments.has(appointment.id)) {
          this.unroutableAppointments.add(appointment.id);
          console.log(`[事件簿] 「${appointment.event}」到点了但没有对应会话，先留着（不跨会话顶替）`);
        }
        continue;
      }
      const { sessionId, state } = target;

      // 用户正在打字 / 后端在处理 / 正在生成回复：这轮先不打扰，窗口没过下轮还能说
      if (state.processing || state.generating || (state.lastTypingAt && Date.now() - state.lastTypingAt < 10000)) {
        console.log(`[事件簿] 「${appointment.event}」先等等，用户那边正忙`);
        continue;
      }

      await this.speak(sessionId, state, { appointment: { kind, minutesAway, event: appointment.event, dueAt: appointment.dueAt } });
      // speak 后查一下 state 里最近一次发言是否落了内容：speak 内部失败不打标记，
      // 这里用「这一轮有没有新增 speechTimestamp」来近似判断成败
      const stamps = state.speechTimestamps || [];
      const spoke = stamps.length > 0 && Date.now() - stamps[stamps.length - 1] < 5000;
      if (spoke) {
        this.appointmentBook.markSpoken(appointment, kind);
        console.log(`[事件簿] ${kind === 'pre' ? '到点前叮嘱' : '过点追问'}「${appointment.event}」已说出口`);
      }
    }
  }

  // 按 userId 找会话（事件簿是跟着用户走的）：只认会话主人匹配。
  // 对不上就放弃这次投递——宁可漏一条提醒，也不能把 A 的约定讲给 B。
  findSessionForUser(userId) {
    if (!this.sessionManager || typeof this.sessionManager.getAllSessions !== 'function') return null;
    const key = String(userId || '').trim();
    if (!key) return null;
    // 记忆键可能带分区后缀（__role / __ai）或人设世代后缀（@lineage），比对前先剥掉
    const bare = (value) => String(value || '').replace(/__(?:role|ai)$/, '').replace(/@[^@]*$/, '');
    const owners = this.sessionManager
      .getAllSessions()
      .filter((s) => s && s.sessionId)
      .filter((s) => !this.appointmentSessionFilter || this.appointmentSessionFilter(s.sessionId))
      .map((session) => {
        const owner = Object.values(session.users || {}).find((u) => u && (u.isCreator || u.userId));
        return { session, owner };
      })
      .filter((item) => item.owner && item.owner.userId);

    const exact = owners.find((item) => String(item.owner.userId) === key);
    if (exact) {
      return { sessionId: exact.session.sessionId, state: this.ensureState(exact.session.sessionId) };
    }

    const loose = owners.filter((item) => bare(item.owner.userId) === bare(key));
    if (loose.length === 1) {
      const sessionId = loose[0].session.sessionId;
      return { sessionId, state: this.ensureState(sessionId) };
    }
    return null;
  }

  async speak(sessionId, state, options = {}) {
    // 🗣️ 开口前征询：先说一句「你现在想说话吗」，只有她明确同意才真正生成内容。
    // 时间表 / 事件簿是她自己早先定下的事，属于既定承诺，不走征询（否则到点也可能被自己否掉）
    const needConsent = CONSENT_ENABLED && !options.schedule && !options.appointment;
    if (needConsent) {
      const consent = await this.askConsent(sessionId, state);
      if (!consent.agree) {
        // 她说了不想说：按「模型自评不开口」同样静默一会儿，别每 30 秒再问一次白烧额度
        state.silenceUntil = Date.now() + DECLINE_SILENCE_MS;
        console.log(`[SystemNarrator] ${sessionId} 征询未通过（${consent.reason || '未同意'}），这句不说`);
        return;
      }
      console.log(
        `[SystemNarrator] ${sessionId} 征询通过：${consent.state || '状态合适'}${consent.reason ? `（${consent.reason}）` : ''}`
      );
    }

    let result;
    try {
      result = await this.generateSpeech(sessionId, state, options);
    } catch (error) {
      console.error('[SystemNarrator] 生成自主发言失败:', error.message);
      return;
    }

    if (!result || !result.text) return;

    const now = Date.now();

    // 🗣️ 饱和即停：同一主题在窗口内被反复当由头 → 冷却期内掐掉这一句（不发 onSpeech）。
    // 宁可冷场也不复读——人类不会因为「没什么可说的」就把同一件事说六遍
    if (this.registerSpeechTheme(sessionId, result.text, now)) {
      state.silenceUntil = now + SPEECH_THEME_COOLDOWN_MS;
      // 🕰️ 被主题闸门拦下的这句不直接丢弃：以 draft 留在时间线里，之后还能被捞起来
      const draftScope = this.timelineScopeFor(sessionId, this.resolveUserId(sessionId, state));
      if (draftScope && this.timeline) {
        this.timeline.append(draftScope, 'artifact.created', {
          artifactId: `draft:${sessionId}:${now}`,
          kind: 'draft',
          text: result.text.slice(0, 500),
          trigger: 'theme-blocked'
        });
      }
      console.log('[SystemNarrator] 自主发言主题饱和，本轮静默（避免复读）');
      return;
    }

    this.lastSpeechAt = now;
    state.lastSpeechAt = now;
    state.speechTimestamps.push(now);
    // “继续说”的资格由 API 每句话自行判断，但下一轮仍要过驱动力门控（阈值放宽 + 续说冷却）
    state.continuing = !!result.shouldContinue;
    state.silenceUntil = 0;
    // 🍚 这句要是提了吃的，记下来喂给饭点硬闸门（90 分钟内不再提吃）
    if (FOOD_TOPIC_RE.test(result.text)) {
      this.lastFoodMentionAt.set(sessionId, now);
    }

    // 记一笔「刚开过口」：扣表达欲、进冷却，并记下这句有没有被接住（没被接住下次就收敛）
    if (this.cide) {
      const sentences = (result.text.match(/[。！？!?…]/g) || []).length || 1;
      this.cide.noteProactiveSpeech(sessionId, { sentences });
      // 上句话还挂着没人接（ignoredStreak>0）：连续被冷落，心情往下沉一点
      let ignored;
      try {
        ignored = this.cide.getDrive(sessionId).ignoredStreak;
      } catch {
        ignored = 0;
      }
      if (ignored > 0) {
        this.emitInternalEmotion(sessionId, state, { type: 'sad', intensity: Math.min(0.35, 0.12 * ignored) }, 'narrator.ignored');
      }
    }

    if (this.onSpeech) {
      this.onSpeech({
        sessionId,
        userId: this.resolveUserId(sessionId, state),
        text: result.text,
        shouldContinue: result.shouldContinue,
        idleMinutes: Math.round((now - state.lastUserMessageAt) / 60000),
        cide: result.cide || null
      });
    }

    // 🕰️ 时间线：她的自主开口（决策记录，不是投递回执；渠道失败由各端自己记）
    const speechScope = this.timelineScopeFor(sessionId, this.resolveUserId(sessionId, state));
    if (speechScope && this.timeline) {
      this.timeline.append(speechScope, 'speech.proactive', {
        text: result.text.slice(0, 500),
        trigger: options.schedule ? 'schedule' : (options.appointment ? 'appointment' : (options.excited ? 'excited' : 'proactive')),
        channel: this.timelineChannel
      });
    }

    // 🔥 兴奋连发：这句说完后，若她仍处于兴奋态就再排一次请求；
    // 间隔按衰减系数逐次拉长，没人接话最多连到 EXCITED_CHAIN_MAX 句（默认 10）。
    // 用户一开口，noteUserMessage 会把计数清零并拆掉待触发的定时器。
    const excitedNow = options.excited
      || this.getExcitement(sessionId, this.getContext ? this.getContext(sessionId, state.userId) : {}).excited;
    if (excitedNow && EXCITED_CHAIN_MAX > 0) {
      state.excitedChainCount = (state.excitedChainCount || 0) + 1;
      if (state.excitedChainCount < EXCITED_CHAIN_MAX) {
        this.scheduleExcitedChain(sessionId, state);
      } else {
        console.log(`[SystemNarrator] ${sessionId} 兴奋连发已到 ${state.excitedChainCount} 句上限，停下等他回话`);
      }
    }
  }

  // 🗣️ 开口前征询：单独发一次 API，问她此刻的状态与是否愿意开口。
  // 只有明确返回 {"agree":true} 才放行；否定、解析失败、请求异常一律当作「不想说」。
  async askConsent(sessionId, state) {
    const characterPrompt = this.sessionManager
      ? this.sessionManager.buildCharacterPrompt(sessionId)
      : '';
    if (!characterPrompt) return { agree: false, reason: '没有可用的角色设定' };

    const context = this.getContext ? this.getContext(sessionId, state.userId) : {};
    const idleMinutes = Math.round((Date.now() - state.lastUserMessageAt) / 60000);
    // 征询也要看好感：关系还很生分时，她不该像熟人一样主动凑上去
    const affinityHint = typeof context.affinityScore === 'number'
      ? `，好感 ${Math.round(context.affinityScore)} 分`
      : '';
    const prompt = `${characterPrompt}

【此刻的一次征询】现在是 ${this.formatClock(Date.now())}，距离用户上一条消息过去 ${idleMinutes} 分钟。
你此刻的情绪是 ${context.emotion || 'calm'}（强度 ${Number(context.emotionIntensity) || 0}），关系阶段 ${context.relationStage || 'STRANGER'}${affinityHint}。
现在没有新消息，是你自己想不想主动开口的时刻。先在心里过三件事：
1. 你此刻到底是什么状态：手上在做什么、心里是什么滋味
2. 有没有真想对他说的事：是刚冒出来的念头，还是只是「好像该说点什么」
3. 现在开口合不合适：他可能正忙、你自己也没话，那就别说

只输出一行 JSON，不要任何多余文字：
{"agree": true, "state": "你此刻的状态（一句话）", "reason": "同意或拒绝的理由（一句话）"}
不想说、没由头、觉得会打扰他，就 agree=false。`;

    try {
      const result = await this.unifiedAPI.callAPI(
        [
          { role: 'system', content: prompt },
          { role: 'user', content: '现在由你决定：要不要开口？只回那一行 JSON。' }
        ],
        null,
        { temperature: 0.2 }
      );
      const text = result?.choices?.[0]?.message?.content || '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return { agree: false, reason: '没给出明确答复' };
      let parsed = null;
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return { agree: false, reason: '答复解析失败' };
      }
      if (!parsed || typeof parsed.agree !== 'boolean') return { agree: false, reason: '没给出明确答复' };
      return {
        agree: parsed.agree === true,
        state: typeof parsed.state === 'string' ? parsed.state : '',
        reason: typeof parsed.reason === 'string' ? parsed.reason : ''
      };
    } catch (error) {
      console.error('[SystemNarrator] 征询请求失败，保守起见不开口:', error.message);
      return { agree: false, reason: '征询请求失败' };
    }
  }

  // 🔥 兴奋连发：排下一次请求，间隔 = 基础间隔 × 衰减系数^(已连发句数-1)
  scheduleExcitedChain(sessionId, state) {
    this.clearExcitedTimer(sessionId);
    const count = state.excitedChainCount || 0;
    if (count <= 0 || count >= EXCITED_CHAIN_MAX) return;

    const delay = Math.round(EXCITED_CHAIN_BASE_MS * Math.pow(EXCITED_CHAIN_DECAY, count - 1));
    const timer = setTimeout(async () => {
      this.excitedTimers.delete(sessionId);
      const live = this.sessions.get(sessionId);
      if (!live || live !== state || !this.enabled || !this.hasClients()) return;
      try {
        await this.tickSession(sessionId, live);
      } catch (error) {
        console.error(`[SystemNarrator] ${sessionId} 兴奋连发判定失败:`, error.message);
      }
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    this.excitedTimers.set(sessionId, timer);
    console.log(
      `[SystemNarrator] ${sessionId} 兴奋连发第 ${count} 句已排期，${Math.round(delay / 1000)}s 后再问一次（上限 ${EXCITED_CHAIN_MAX}）`
    );
  }

  clearExcitedTimer(sessionId) {
    const timer = this.excitedTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.excitedTimers.delete(sessionId);
    }
  }

  // 🗣️ 记录一次自主发言的主题并判断是否「饱和」：
  //   - 与窗口内已有主题指纹相似度 ≥ 阈值 → 视为同一主题，累计计数 +1，返回是否已达饱和
  //   - 否则作为新主题加入，返回 false
  // 返回 true 时调用方应放弃这次发言（防止同一件事被反复说）
  registerSpeechTheme(sessionId, text, now = Date.now()) {
    const grams = buildThemeGrams(text);
    if (grams.size === 0) return false;

    let list = this.speechThemes.get(sessionId);
    if (!list) {
      list = [];
      this.speechThemes.set(sessionId, list);
    }
    // 清掉窗口外的旧指纹，别让 Map 无限膨胀
    for (let i = list.length - 1; i >= 0; i--) {
      if (now - list[i].at > SPEECH_THEME_WINDOW_MS) list.splice(i, 1);
    }
    for (const item of list) {
      if (themeSimilarity(grams, item.grams) >= SPEECH_THEME_SIM_THRESHOLD) {
        item.count += 1;
        item.at = now;
        item.grams = grams; // 用最新措辞当代表，避免主题随措辞缓慢漂移
        return item.count >= SPEECH_THEME_SATURATION_COUNT;
      }
    }
    list.push({ grams, count: 1, at: now });
    return false;
  }

  // 自主发言前的证据检索（RAG 的检索层）：把在场对话、归档与长期记忆里真实存在的片段
  // 编成带编号的素材卡，交给模型「转述」而不是「凭记忆编造」
  async retrieveEvidence(sessionId, state) {
    if (this.cide && this.cide.evidence && !this.cide.evidence.enabled) return [];

    const userId = this.resolveUserId(sessionId, state);
    if (!userId) return [];

    const sources = [];

    // 1) 在场对话 + 归档：最近的对话一定进素材，保证「刚聊过什么」有据可查
    if (this.sessionManager && typeof this.sessionManager.searchHistory === 'function') {
      try {
        const result = this.sessionManager.searchHistory(sessionId, userId, {
          scope: 'all',
          limit: EVIDENCE_HISTORY_LIMIT
        });
        (result.messages || []).forEach((msg) => {
          sources.push({
            source: msg.archived ? '归档' : '对话',
            time: msg.time || '',
            text: `${msg.role === 'assistant' ? '角色' : '用户'}：${msg.content}`
          });
        });
      } catch (error) {
        console.error('[SystemNarrator] 检索历史素材失败:', error.message);
      }
    }

    // 2) 📅 事件簿：把还没发生的约定列成素材卡，她说起这些事就有了出处，不会被证据纪律拦住
    if (this.appointmentBook && typeof this.appointmentBook.getPendingText === 'function') {
      const pending = this.appointmentBook.getPendingText(userId);
      if (pending) {
        pending.split('\n').forEach((line) => {
          const m = line.match(/^- (.+?)：(\d{1,2}月\d{1,2}日.+)/);
          if (m) sources.push({ source: '约定', text: `用户说过「${m[1]}」，时间 ${m[2]}（事件簿记录）` });
        });
      }
    }

    // 3) 长期记忆：不再注入。
    //    原先这里用空 query 取「最近 3 条记忆」，取的其实总是用户最新那几句——
    //    其中混着针对本系统的元层面抱怨（如「我不是白」「自主发言又乱引用」），
    //    被她当成素材转述，就会出现「借别人的人设发言」「原样复述用户的话」的自指回路。
    //    与『自主发言只读最近对话』的既定口径一致，这里彻底不碰长期记忆档。

    // 4) 📚 书摘：只顺着最近一条用户消息去书库找一本相关的书（最多带 1 条，避免开口就掉书袋）
    //    超过 12 小时没聊过就不查；检索器没配 / 云端抖动 / 分数不够，全部静默跳过
    if (
      this.knowledgeRetriever &&
      Date.now() - state.lastUserMessageAt < BOOK_QUERY_WINDOW_MS &&
      this.sessionManager && typeof this.sessionManager.getConversationHistory === 'function'
    ) {
      try {
        const recent = this.sessionManager.getConversationHistory(sessionId, userId, 4) || [];
        // 取最近一条用户说的话当 query；没有用户消息（纯定时任务冷启动）就不查书
        for (let i = recent.length - 1; i >= 0; i--) {
          const msg = recent[i];
          if (msg && msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
            const card = await this.knowledgeRetriever.retrieveBookCard(msg.content.trim().slice(0, 500));
            if (card) {
              sources.push(card);
              console.log(`[SystemNarrator] 书摘素材命中《${card.title}》(score=${Number(card.score).toFixed(3)})`);
            }
            break;
          }
        }
      } catch (error) {
        console.error('[SystemNarrator] 检索书摘素材失败:', error.message);
      }
    }

    const cards = this.cide && typeof this.cide.buildEvidenceInstruction === 'function'
      ? this.cide.evidence.buildCards(sources)
      : [];
    console.log(
      `[SystemNarrator] RAG 素材 ${cards.length} 条（${cards.map((card) => `${card.id}[${card.source}]`).join(' ') || '无'}）`
    );
    return cards;
  }

  // RAG 校验层：把话里的具体说法（数字/日期/时刻）逐条回素材里找，找不到就记一笔并交回结果
  // 调用方拿到 unsupported 后再按 enforce 决定发不发（见 generateSpeech）
  validateEvidence(text, cards = []) {
    if (!this.cide || typeof this.cide.validateSpeech !== 'function') return null;
    try {
      const check = this.cide.validateSpeech(text, cards);
      if (!check || !check.enabled) return null;

      if (check.claims.length === 0) {
        console.log('[SystemNarrator] 素材校验：这句没有具体数字/日期，无需比对');
      } else if (check.unsupported.length === 0) {
        console.log(`[SystemNarrator] 素材校验通过（${check.claims.length} 处具体说法均有出处）`);
      } else {
        console.warn(
          `[SystemNarrator] 素材校验：${check.unsupported.length} 处具体说法在素材里找不到出处（${check.unsupported.join('、')}）${check.enforce ? '，按配置拦截' : '，仅记录未拦截'}`
        );
      }
      return check;
    } catch (error) {
      console.error('[SystemNarrator] 素材校验失败:', error.message);
      return null;
    }
  }

  async generateSpeech(sessionId, state, options = {}) {
    const characterPrompt = this.sessionManager
      ? this.sessionManager.buildCharacterPrompt(sessionId)
      : '';
    if (!characterPrompt) return null;

    const idleMinutes = Math.round((Date.now() - state.lastUserMessageAt) / 60000);
    const schedule = options.schedule || null;
    // 📅 事件簿到点：{kind:'pre'|'post', minutesAway, event, dueAt}
    const appointment = options.appointment || null;
    // 距角色自己上一次开口过了多久：让它知道这些独白之间隔了真实的时间，而不是连成一串
    const sinceOwnMinutes = state.lastSpeechAt
      ? Math.round((Date.now() - state.lastSpeechAt) / 60000)
      : null;

    // 自主发言既看最近对话，也接主对话记忆（见下），但不再像早期那样无脑翻旧账
    const context = this.getContext ? this.getContext(sessionId, state.userId) : {};

    // 🧠 接入主对话记忆：与正式回复（output.generateOutputAsync）同一套召回路径——
    // 同一个 scoped userId、同一个人设换代时间点、同一批长期记忆 / 语义记忆 / 自我模型。
    // CIDE 的内部思考与最终成文都要看得到，否则自主发言会像个不记得事的陌生人。
    const historyUserId = this.resolveUserId(sessionId, state);
    const recentHistory = (this.sessionManager && historyUserId)
      ? (this.sessionManager.getConversationHistory(sessionId, historyUserId, 12) || [])
      : [];
    // 召回 query 用最近一条用户消息；还没有用户消息（纯冷启动）就退化为空 query。
    // 窗口取 12 而不是 4：她连发几句后，4 条里可能全是她自己的话，query 会退化成空、
    // 召回切到「状态线索」通道，和主链路按用户原话召回的结果就对不上了
    const memoryQuery = (() => {
      for (let i = recentHistory.length - 1; i >= 0; i--) {
        const msg = recentHistory[i];
        if (msg && msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
          return msg.content.trim().slice(0, 300);
        }
      }
      return '';
    })();
    const memoryPrompt = await this.buildMainMemoryPrompt(sessionId, historyUserId, memoryQuery);
    if (memoryPrompt) console.log(`[SystemNarrator] 已接入主对话记忆（${memoryPrompt.length} 字）`);

    // 🧭 场景投影：自主开口也要知道「此刻在哪、在不在一起」。
    // 与正式回复同一条只读派生（历史优先、记忆补位），取不到就明确不知道；
    // 群聊由 bridge 另行关掉 sceneContext，这里只服务私聊与网页。
    let sceneSection = '';
    if (this.outputModule && typeof this.outputModule.buildSceneSection === 'function' && historyUserId) {
      try {
        const sceneUserId = (this.sessionManager && typeof this.sessionManager.getScopedUserId === 'function')
          ? this.sessionManager.getScopedUserId(sessionId, historyUserId)
          : historyUserId;
        const persona = (this.sessionManager && typeof this.sessionManager.getPersona === 'function')
          ? this.sessionManager.getPersona(sessionId)
          : null;
        const cutoverAt = persona && persona.founding === false ? (Number(persona.cutoverAt) || 0) : 0;
        sceneSection = await this.outputModule.buildSceneSection({
          sessionId,
          memoryUserId: sceneUserId,
          history: recentHistory,
          sceneHint: this.scenePrompt,
          scope: 'role',
          cutoverAt,
          toolOptions: {}
        });
      } catch (error) {
        console.warn('[SystemNarrator] 场景投影失败（不影响发言）:', error.message);
        sceneSection = '';
      }
    }

    // 👁️ 实时视觉：自主开口也要知道她此刻「看见」了什么。
    // 只给网页本机通道，QQ / B站不该看到用户房间；没有新鲜画面时返回空串
    let visionSection = '';
    if (this.timelineChannel === 'web') {
      try {
        visionSection = liveVision.buildPromptSection();
      } catch (error) {
        console.warn('[SystemNarrator] 实时视觉注入失败（不影响发言）:', error.message);
      }
    }

    // RAG 检索层：先取出真实素材（对话/归档/书摘），后面只让模型基于这些素材转述
    const evidenceCards = await this.retrieveEvidence(sessionId, state);

    // 先由 CIDE 做一轮内部思考（无外部输入时的“自己想事情”），再把结论注入提示词
    let cideInstruction = '';
    let cideMeta = null;
    let deliberation = null;
    if (this.cide && this.useCide) {
      try {
        deliberation = await this.cide.deliberate({
          sessionId,
          // 角色设定 + 主对话记忆：让她「自己想的」也建立在真实记得的事上
          systemPrompt: `${characterPrompt}${this.scenePrompt}${sceneSection}${visionSection}${memoryPrompt}`,
          userInput: '',
          emotion: context.emotion || 'calm',
          relationStage: context.relationStage || 'STRANGER',
          userApiConfig: state.userApiConfig,
          // 自主开口：让模型先掂量由头、自评开口意愿，并由它自己总结人类主动发言思维
          mode: 'proactive'
        });
        if (deliberation.strategy) {
          cideInstruction = this.cide.buildInstruction(deliberation.strategy);
        }
        if (deliberation.mindset) {
          console.log(`[SystemNarrator] 模型自总结的主动发言思维：${deliberation.mindset}`);
        }
        cideMeta = {
          enabled: true,
          rounds: deliberation.rounds,
          confidence: deliberation.confidence,
          urge: deliberation.urge,
          trace: deliberation.trace
        };
        console.log(
          `[SystemNarrator] CIDE 思考完成：${deliberation.rounds}轮，置信度 ${deliberation.confidence}，开口意愿 ${
            typeof deliberation.urge === 'number' ? deliberation.urge.toFixed(2) : '未给出'
          }`
        );
      } catch (error) {
        console.error('[SystemNarrator] CIDE 思考失败:', error.message);
      }
    }

    // —— 弱限制：模型 urge 低只做提示，不硬挡 —— 🌀
    // 让它仍然走 generateSpeech，说不定想一会儿就有由头了
    if (deliberation && typeof deliberation.urge === 'number') {
      this.recordUrgeSample(sessionId, deliberation.urge);
      if (deliberation.urge < MIN_URGE_TO_SPEAK) {
        // 📊 只观测不改行为：按「沉默是常态」本该拦下，这里仍按 narrator 节奏放行——记一笔
        this.gateStats.wouldBlockByUrge += 1;
        console.warn(
          `[SystemNarrator] 模型自评此刻开口意愿仅 ${deliberation.urge.toFixed(2)}（低于 ${MIN_URGE_TO_SPEAK}），仍按 narrator 节奏尝试开口`
        );
      }
    }

    const identity = buildIdentityLayer(
      this.unifiedAPI.getCurrentAPIName(),
      this.toolRegistry ? this.toolRegistry.describeCapabilities() : ''
    );

    // 两种开口理由：自己排的时间表到点了，或者只是隔太久没聊想主动说话
    const ownClock = sinceOwnMinutes === null
      ? '这是你第一次主动开口。'
      : `距离你自己上一次开口已经过去 ${sinceOwnMinutes} 分钟。`;

    // 🍚 recentHistory 与 historyUserId 已在上面取好（供记忆召回与消息拼装共用）
    // 🍚 作息块：告诉她现在几点 + 饭点规则 + 她养成的作息习惯
    const daypartPrompt = this.buildDaypartPrompt(sessionId, recentHistory);

    // 刚聊过（用户上一条消息还在 30 分钟内）→ 算「接着聊」，久没聊才算「自言自语」。
    // 之前两种情形共用一套独白式文案，用户在场时她也只会自说自话，这是「连续独白」的根因之一
    const justTalked = idleMinutes <= RECENT_WINDOW_MS / 60000;

    // 上一条若是 assistant（自己刚给出的正式回复，或另一侧人格说过的），用户那一轮就已被回应过了。
    // 这种时候绝不能把那条 assistant 当成「对方刚说完」去接：模型会顺着它自己一句句往下写，
    // 在对话框里就表现成「两个人格互相说话」。只有历史末尾确实是用户消息，才算「接着对方说」
    const lastHistoryMsg = recentHistory.length ? recentHistory[recentHistory.length - 1] : null;
    const userTurnOpen = !lastHistoryMsg || lastHistoryMsg.role === 'user';
    const continueUserTurn = justTalked && userTurnOpen;

    // 非时间表 / 非事件簿时的常态开口姿态：按在场程度分档，独白与对话分开写
    const idleSituation = continueUserTurn
      ? `【当前情境】距离用户上一条消息只过去 ${idleMinutes} 分钟，你们其实还在聊天中间。${ownClock}现在轮到你开口，是接着刚才的话题往下聊，不是自言自语。
要求：
1. 先看上面历史里用户最后说了什么，优先接住它：回应他说的事、就他刚说的追一句、或者把你自己那半边话说完
2. 历史里标着「角色」的和你自己那些发言，全都是你这一侧说过的话，不是对方说的；不要把它们当成对方的话去回应，更不要接你自己刚说的最后一句
3. 可以问他问题、可以顺着调侃、可以说你此刻的感受；别只顾着汇报你自己在干什么
4. 一次 1-2 句，就是微信聊天的长度，短、有来有回
5. 不要提及“系统”“AI”“主动发言”“等待”等字眼
6. 不要写环境与实物：房间、家具、天气、光线、方位一概不提，不出现沙发、窗外、桌上一类的具体物件
7. 不要重复最近已经说过的话`
      : justTalked
      ? `【当前情境】距离用户上一条消息只过去 ${idleMinutes} 分钟，你已经回过他了，这一轮用户没再开口。${ownClock}现在你想再说，属于你自己起话头。
要求：
1. 不要接你自己刚说的最后一句、也不要追着同一件事再问一遍：换个由头——你手上正在做的事、忽然想到的事、心里冒出来的一句话
2. 历史里你自己那些发言不是对方说的话，别拿它们当提问或回应对象
3. 一次 1-2 句，短，像忽然想起一句而已
4. 不要提及“系统”“AI”“主动发言”“等待”等字眼
5. 不要写环境与实物：房间、家具、天气、光线、方位一概不提，不出现沙发、窗外、桌上一类的具体物件
6. 不要重复最近已经说过的话`
      : `【当前情境】${ownClock}距离用户上一条消息已经过去 ${idleMinutes} 分钟，你是一个人待着的时候想起他，主动开口说句话。
要求：
1. 想说什么由你决定：手上正在做的事、忽然想到的事、心里冒出来的一句话都可以
2. 上面历史里每条消息都标了发生时间，你看得见自己之前说过什么；先看一遍，别把刚说过的话再说一遍
3. 把话往前推：同一件事要讲就讲出新进展、新动作或新决定；若这件事你已经讲了两遍以上对方仍没回，就换一件新的事
4. 不要提及“系统”“AI”“主动发言”“等待”等字眼
5. 不要写环境与实物：房间、家具、天气、光线、方位一概不提，不出现沙发、窗外、桌上一类的具体物件
6. 不要重复最近已经说过的话`;

    // 📅 事件簿到点的情境：叮嘱（pre）/ 追问（post），是一等触发理由，优先于普通闲聊
    const situation = appointment
      ? (appointment.kind === 'pre'
        ? `【当前情境】你一直记着一件事：「${appointment.event}」，定在 ${this.formatClock(appointment.dueAt)}，现在离那件事还有约 ${appointment.minutesAway} 分钟。你想起了这事，主动跟用户说一句——提醒一声、叮嘱两句、问问准备好了没有都行，完全用角色的语气说 1-2 句。
要求：
1. 别像念日程表一样复述时间信息，要像真人「突然想起来」那样自然带出
2. 不要提及“系统”“AI”“主动发言”“事件簿”“定时”“时间表”“等待”等字眼
3. 不要写环境与实物：房间、家具、天气、光线、方位一概不提
4. 看一眼下面的最近对话：如果事情已经有了新进展（比如用户已经聊过了），就顺着新情况说，别装不知道`
        : `【当前情境】用户之前说过「${appointment.event}」，说好的时间（${this.formatClock(appointment.dueAt)}）已经过去约 ${appointment.minutesAway} 分钟了。你惦记着这事，主动问一句结果怎么样，用角色的语气说 1-2 句。
要求：
1. 别像念日程表，要像真人惦记着随口一问；关心可以带着角色自己的别扭劲儿
2. 不要提及“系统”“AI”“主动发言”“事件簿”“定时”“时间表”“等待”等字眼
3. 不要写环境与实物：房间、家具、天气、光线、方位一概不提
4. 看一眼下面的最近对话：如果用户已经主动聊过结果了，就顺着聊，别再问一遍`)
      : schedule
      ? `【当前情境】${ownClock}现在是 ${schedule.time}，这是你自己给自己排的时间点${
          schedule.note ? `，你当时写下的是：「${schedule.note}」` : '，你当时没写具体要说什么，由你此刻自己决定'
        }。这是你按自己养成的作息习惯提前计划好的事，到点照着做很自然，现在轮到你开口。
要求：
1. 完全用角色的语气，一次说 1-3 句，像日常里忽然想到什么随口讲出来；有实在由头就多说两句，没什么就一句带过
2. ${schedule.note ? '就围绕你自己写下的那件事说，别跑题' : '把你这会儿正在做、正在想的事说给对方听'}
3. 上面历史里每条消息都标了发生时间，你看得见自己之前说过什么；可以顺着往下讲，但必须往前推进，不要重复同一批意象、同一件事
4. 不要提及“系统”“AI”“主动发言”“定时”“时间表”“等待”等字眼
5. 不要写环境与实物：房间、家具、天气、光线、方位一概不提，不出现沙发、窗外、桌上一类的具体物件
6. 不要重复最近已经说过的话`
      : idleSituation;

    // 关系层：独自开口时也要落在该会话真实的亲疏上，否则关系早已很近仍会退回「刚认识」的客套。
    // 好感分一并写进来：同一个阶段里，刚入段和快到下一段，语气不该一样
    const affinityHint = typeof context.affinityScore === 'number'
      ? `，好感 ${Math.round(context.affinityScore)} 分`
      : '';
    const relationPrompt = context.relationStageName
      ? `

【你与对方的关系】当前关系阶段：${context.relationStage || '未知'}（${context.relationStageName}${affinityHint}）。你主动开口时的称呼、语气和分寸都要与这个亲疏程度一致，不要退回刚认识时的客气。`
      : '';

    // 称呼是既定事实：主动开口也必须用同一个叫法。这里只读取已经定下来的称呼（认定走正式回复那条链路），
    // 否则正式回复里刚定下的叫法一到主动发言就漂成另一个
    // 记忆档案键可能带人设世代后缀（换过不相干角色时天然进新档）
    const scopedUserId = (historyUserId && this.sessionManager
      && typeof this.sessionManager.getScopedUserId === 'function')
      ? this.sessionManager.getScopedUserId(sessionId, historyUserId)
      : historyUserId;
    const addressPrompt = this.outputModule && typeof this.outputModule.buildAddressPrompt === 'function'
      ? this.outputModule.buildAddressPrompt(scopedUserId)
      : '';

    // 表达层纪律：和主对话链共用同一份「说话方式」约束 + 「你最近说过的话」回显。
    // 自主发言此前只给情境分档、不接表达层，历史又是平铺的——模型看不见自己在重复，
    // 「别重复」这条规则因此永远执行不了，才会滑向金句体/自我旁白 🌀
    const stylePrompt = this.outputModule && typeof this.outputModule.buildStylePrompt === 'function'
      ? this.outputModule.buildStylePrompt({
          sessionId,
          memoryUserId: scopedUserId,
          historyUserId,
          relationStage: context.relationStage
        })
      : '';
    const recentSelfPrompt = this.outputModule && typeof this.outputModule.buildRecentSelfPromptFromHistory === 'function'
      ? this.outputModule.buildRecentSelfPromptFromHistory(sessionId, historyUserId)
      : '';

    // 开口前的自问清单：按「人类主动发言的思维」再过一遍，任何一问不过就别硬说
    const mindsetReminder = this.cide && this.useCide && typeof this.cide.buildProactiveMindsetReminder === 'function'
      ? this.cide.buildProactiveMindsetReminder()
      : '';

    // RAG 约束层：把素材编成带编号的清单写进提示词，模型只能照素材转述
    const evidenceInstruction = this.cide && typeof this.cide.buildEvidenceInstruction === 'function'
      ? this.cide.buildEvidenceInstruction(evidenceCards)
      : '';

    // 🏠 私生活：她自己今天做了些什么。开口时可以有由头从自己的生活里来，
    // 而不是每次都只能从用户最后那句话里找话说
    const lifePrompt = this.privateLife && typeof this.privateLife.getLifePrompt === 'function'
      ? this.privateLife.getLifePrompt(sessionId)
      : '';

    // 👁️ 这次开口由画面里的动静触发：把动静说清楚，接不接由她自己判断
    const visionNote = options.vision
      ? `\n【你刚注意到的动静】${options.vision}。如果这值得接一句，就自然地带出来；不想理会也可以当没看见，别刻意解释。`
      : '';

    // 稳定段在前、易变段在后：前缀缓存只认逐字节相同的前缀，
    // 记忆 / 最近说过的话 / 思考策略 / 素材 / 情境 / 作息时间 这些每轮都变的内容一律压到末尾
    const systemPrompt = `${identity}${characterPrompt}${this.scenePrompt}${sceneSection}${visionSection}${relationPrompt}${stylePrompt}${addressPrompt}${FACT_GROUNDING_INSTRUCTION}${mindsetReminder}${lifePrompt}${memoryPrompt}${recentSelfPrompt}${cideInstruction}${evidenceInstruction}
${situation}${daypartPrompt}${visionNote}
${buildTimeLayer()}
在正文最后另起一行，附加一个 JSON：{"continue": true} 或 {"continue": false}
   - 你说完了就返回 false（默认。人不是每次开口都要连着讲好几轮）
   - 只有当手里那件事确实还没讲完、而且你还想接着说，才返回 true`;

    const messages = [];
    // 🍚 复用上面已取好的 recentHistory（同一条数据，不再查第二遍）
    recentHistory.forEach((msg) => {
      if (msg && typeof msg.content === 'string' && msg.content.length > 0) {
        // 把每条消息的真实发生时间一并喂进去，角色才看得见「上一轮发言」是什么时候说的
        messages.push({
          role: msg.role || 'user',
          content: `[${this.formatClock(msg.timestamp)}] ${msg.content.substring(0, 2000)}`
        });
      }
    });
    // 末尾这句是「轮到你了」的直接指令，措辞必须跟上面的情境分档一致：
    // 用户的话还没被接住时不能说「现在没有新消息」，那等于当面告诉她对方不在，她会立刻退回自说自话；
    // 反过来，用户那一轮已经被回应过（历史末尾是发言）时不能说「对方刚说完」，
    // 那会让她把上一条发言当成对方的话来自问自答，看起来就是两个人在对话框里互相说话
    const trailingHint = schedule
      ? '（到你自己排的时间点了，按你的安排简短说两句，往前推进，别重复刚说过的话）'
      : appointment
      ? '（按上面说的那件事主动开口，简短说 1-2 句，别像念日程表）'
      : continueUserTurn
      ? '（用户上一条消息刚说完，你接着用户的话说，简短 1-2 句，别重复刚说过的话）'
      : '（现在没有新消息，你想开口就简短说两句，往前推进，别重复刚说过的话；没什么由头也可以只说一句）';
    messages.push({ role: 'user', content: trailingHint });

    let content = '';
    const config = state.userApiConfig;
    const useCustomApi = !!(config && config.enabled && config.apiUrl);

    // 自主发言也走完整工具循环：她说「我记下来了 / 我写好了」就必须真的落到文件上，
    // 而不是嘴上答应。工具是否免授权由 toolRegistry 判定（写桌面文本、新建自己的工具免审；
    // 改写已有工具或写别处仍会弹窗要授权）。思考模式强制开启，先想再开口
    if (this.outputModule && typeof this.outputModule.callWithTools === 'function') {
      const callOptions = {
        sessionId,
        userId: historyUserId,
        memoryUserId: scopedUserId,
        includeAffectionTool: false,
        // QQ 这条链路不下发框架工具（正式回复、群聊、自主发言统一口径）
        ...(this.toolFilter ? { toolFilter: this.toolFilter } : {}),
        forceThinking: 'enabled',
        // 事实性发言照旧用低温，压缩随机发挥的空间
        temperature: PROACTIVE_TEMPERATURE
      };
      if (useCustomApi) {
        try {
          console.log(`[SystemNarrator] 尝试用户自定义API: ${config.apiUrl}`);
          const result = await this.outputModule.callWithTools(
            [{ role: 'system', content: systemPrompt }, ...messages],
            { ...callOptions, userApiConfig: config }
          );
          content = result?.choices?.[0]?.message?.content || '';
        } catch (error) {
          console.error('[SystemNarrator] 用户自定义API调用失败，回退到默认API:', error.message);
        }
      }
      if (!content) {
        const result = await this.outputModule.callWithTools(
          [{ role: 'system', content: systemPrompt }, ...messages],
          callOptions
        );
        content = result?.choices?.[0]?.message?.content || '';
      }
    } else {
      // 兜底：没挂上正式回复模块时退回纯文本调用（仍然强制开思考）
      if (useCustomApi) {
        try {
          content = await this.userApiClient.callApi(config, messages, systemPrompt, { thinking: 'enabled' });
        } catch (error) {
          console.error('[SystemNarrator] 用户自定义API调用失败，回退到默认API:', error.message);
        }
      }

      if (!content) {
        const result = await this.unifiedAPI.callAPI([
          { role: 'system', content: systemPrompt },
          ...messages
        ], null, { temperature: PROACTIVE_TEMPERATURE, thinking: 'enabled' });
        content = result?.choices?.[0]?.message?.content || '';
      }
    }

    if (!content) return null;
    const speech = this.parseSpeech(content);
    speech.cide = cideMeta;

    // RAG 校验层：核对句中的数字/日期有没有素材出处；开了 enforce 后对不上就不发这句
    // 只按 unsupported 拦，不按 ok 拦——素材一条没检索到时 ok 也是 false，那是「没素材」不是「在编」
    const evidenceCheck = this.validateEvidence(speech.text, evidenceCards);
    if (evidenceCheck && evidenceCheck.enforce && evidenceCheck.unsupported.length > 0) {
      console.warn(`[SystemNarrator] 素材校验未通过，放弃这句自主发言：${evidenceCheck.unsupported.join('、')}`);
      return null;
    }

    // 把这次自主发言写回全局工作空间，供后续思考与正式回复参考
    if (this.cide && this.useCide && speech.text) {
      this.cide.recordContext(sessionId, `角色（主动）：${speech.text}`, 0.6);
    }

    return speech;
  }

  // 🧠 接入主对话记忆：与 output.generateOutputAsync 完全同一条召回路径。
  // 同一个 scoped userId、同一个人设换代时间点（cutoverAt）、同一批长期/语义/自我模型记忆，
  // 最终由 outputModule.buildMemoryPrompt 拼成统一格式——自主发言与正式回复看到的是同一份档案。
  // 🫀 无查询召回：她要主动开口时没人给她线索，那就用「她此刻心里压着的事」当线索。
  // 只取现成状态里最像「念头」的两样：没说出口的话（分量最重的几条）、被晾着的体感。
  // 读不到就返回空数组——召回退回「补最近」，绝不因为状态缺失而阻断开口。
  buildStateRecallWords(sessionId) {
    const words = [];
    try {
      if (this.privateLife && typeof this.privateLife.load === 'function') {
        const data = this.privateLife.load(sessionId) || {};
        (Array.isArray(data.days) ? data.days : [])
          .flatMap(day => (Array.isArray(day && day.unspoken) ? day.unspoken : []))
          .filter(item => item && item.text)
          .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))
          .slice(0, 2)
          .forEach(item => words.push(String(item.text).trim().slice(0, 40)));
      }
      if (this.cide && typeof this.cide.getDrive === 'function') {
        const drive = this.cide.getDrive(sessionId) || {};
        if (Number(drive.ignoredStreak) > 0) words.push('被晾着 没人理');
        if (Number(drive.expression) >= 0.6) words.push('想说话 憋着');
      }
    } catch {
      // 状态读失败只意味着「这轮没有状态线索」，不能让她因此失声
    }
    return words.filter(Boolean);
  }

  async buildMainMemoryPrompt(sessionId, userId, query = '') {
    if (!this.memoryModule || !userId) return '';

    const scopedUserId = (this.sessionManager && typeof this.sessionManager.getScopedUserId === 'function')
      ? this.sessionManager.getScopedUserId(sessionId, userId)
      : userId;
    const persona = (this.sessionManager && typeof this.sessionManager.getPersona === 'function')
      ? this.sessionManager.getPersona(sessionId)
      : null;
    const cutoverAt = persona && persona.founding === false ? (Number(persona.cutoverAt) || 0) : 0;

    let preloaded = null;
    try {
      // 有话说 → 按她这句话召回；没话说（主动开口）→ 按她自己此刻的状态召回
      const stateWords = String(query || '').trim() ? [] : this.buildStateRecallWords(sessionId);
      // 取「记录」而不是纯文本：记录带 id/时间戳，注入层才能写「3 天前」并认出话题兄弟；
      // 主链路走的就是 retrieveMemoryRecords，这里必须同口径，否则两条链拿到的记忆既不同批也不同格式
      preloaded = typeof this.memoryModule.retrieveMemoryRecords === 'function'
        ? await this.memoryModule.retrieveMemoryRecords(scopedUserId, query, 5, {
            cutoverAt,
            stateWords,
            // 自主发言独立记不应期账本：和正式回复共用一本时，两边会轮流把对方刚注入的记忆藏起来
            refractoryTag: 'proactive'
          })
        : await this.memoryModule.retrieveMemories(scopedUserId, query, 5, { cutoverAt, stateWords });
    } catch (error) {
      console.error('[SystemNarrator] 召回长期记忆失败:', error.message);
      preloaded = null;
    }

    if (!this.outputModule || typeof this.outputModule.buildMemoryPrompt !== 'function') return '';
    try {
      return this.outputModule.buildMemoryPrompt(scopedUserId, query, preloaded, 'role', cutoverAt) || '';
    } catch (error) {
      console.error('[SystemNarrator] 组装记忆提示词失败:', error.message);
      return '';
    }
  }

  // 从回复中拆出正文与“是否继续”判定
  parseSpeech(raw) {
    const text = typeof raw === 'string' ? raw : '';
    let shouldContinue = false;
    let verdictBlock = null;

    const blocks = text.match(/\{[^{}]*\}/g) || [];
    for (const block of blocks) {
      try {
        const parsed = JSON.parse(block);
        if (parsed && typeof parsed.continue === 'boolean') {
          shouldContinue = parsed.continue;
          verdictBlock = block;
        }
      } catch (error) {
        // 不是合法 JSON，跳过
      }
    }

    let dialogue = verdictBlock ? text.replace(verdictBlock, ' ') : text;
    // 先剥内部思考块：这条链原先没有任何标签剥离，模型漏出的 <commentary>…</commentary>
    // 会原样进正文、再被 recordContext 回灌成历史，越滚越脏
    dialogue = stripInternalBlocks(dialogue);
    dialogue = dialogue
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\{[\s\S]*\}/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return { text: dialogue, shouldContinue };
  }

  // 手动触发一次自主发言（调试用）
  async triggerNow(sessionId) {
    const ids = sessionId ? [sessionId] : Array.from(this.sessions.keys());
    if (ids.length === 0) return 0;
    const state = this.ensureState(ids[0]);
    await this.speak(ids[0], state);
    return 1;
  }

  // 👁️ 实时视觉触发的一次主动注意：人进来/离开时调用。
  // 只挑最近有互动的会话说；用户正在聊天（3 分钟内说过话）就不插嘴，交给正常回复去接。
  async notifyVisionEvent(trigger) {
    if (!this.enabled || !trigger || !trigger.text) return false;
    const ids = Array.from(this.sessions.keys());
    if (!ids.length) return false;
    let target = null;
    ids.forEach((id) => {
      const state = this.sessions.get(id);
      if (!state) return;
      if (!target || (state.lastUserMessageAt || 0) > (target.state.lastUserMessageAt || 0)) {
        target = { id, state };
      }
    });
    if (!target) return false;
    const idleMs = Date.now() - (target.state.lastUserMessageAt || 0);
    if (idleMs < 3 * 60 * 1000) return false;
    await this.speak(target.id, target.state, { vision: trigger.text });
    return true;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      isNarrating: this.isTicking,
      lastNarrateTime: this.lastSpeechAt,
      trackedSessions: this.sessions.size,
      pendingCount: 0,
      timeUntilNextNarrate: 0,
      sessions: Array.from(this.sessions.values()).map((st) => {
        const idleMs = Date.now() - st.lastUserMessageAt;
        const context = this.getContext ? this.getContext(st.sessionId, st.userId) : {};
        const gate = this.cide
          ? this.cide.evaluateProactiveSpeech(st.sessionId, {
              idleMs,
              emotion: context.emotion || 'calm',
              continuing: !!st.continuing,
              affinityScore: context.affinityScore
            })
          : null;
        return {
          sessionId: st.sessionId,
          idleMinutes: Math.round(idleMs / 60000),
          ratePerHour: Math.round(this.baseRatePerHour(idleMs, context.affinityScore) * 10) / 10,
          sentLastHour: this.countLastHour(st),
          unlimited: !!st.continuing,
          // 自主发言驱动力：此刻的开口意愿、阈值，以及 CIDE 软提醒（弱限制，仅展示不拦门）
          speechUrge: gate ? Math.round(gate.score * 100) / 100 : null,
          speechThreshold: gate ? gate.threshold : null,
          affinity: typeof context.affinityScore === 'number' ? context.affinityScore : null,
          ignoredStreak: gate ? gate.breakdown.ignoredStreak : null,
          warnings: gate ? gate.warnings : []
        };
      }),
      // 📊 闸门观测（只出数据不改行为）：用来判断「沉默是常态」是否还真的挡得住
      gates: this.getGateStats()
    };
  }

  getCurrentAPI() {
    return this.unifiedAPI.getCurrentAPI();
  }

  getCurrentAPIName() {
    return this.unifiedAPI.getCurrentAPIName();
  }

  switchAPI(apiName) {
    return this.unifiedAPI.switchAPI(apiName);
  }
}

module.exports = SystemNarrator;
