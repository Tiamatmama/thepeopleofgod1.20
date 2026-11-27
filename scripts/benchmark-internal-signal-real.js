'use strict';
// 🧪 内部信号回流环（B）真实 API「进化影响」对照实验 —— 全链路真实 narrator
//
// 目的：验证「角色自身行为（自主发言被冷落 / 被回应）回流成情绪涟漪」这条闭环，
//       是否真的会让她后续的情绪轨迹与回复发生可观测的进化（Evolutionary Influence）。
//
// 对照：INTERNAL_SIGNAL_ENABLED = 'false'(OFF，回流环关) vs 'true'(ON，回流环开)。
//       除该环境变量外，两条臂输入完全一致（同一角色卡 / 同一脚本化用户消息 / 同一预置基础情绪信号）。
//
// 全链路真实：SystemNarrator（真）→ CIDEEngine（真，自主发言驱动力）→ OutputModule（真，工具循环）
//             → EmotionModule（真，情绪双层）→ 真实 DeepSeek API。
// 隔离与零污染：MemoryModule / SessionManager / GalgameModule 用轻量 stub；
//             EmotionModule.prototype.load/save 打桩，绝不读 / 写 data/emotion_state.json；
//             CIDE 全内存；虚拟时钟用可逆的 Date.now 覆盖（new Date() 不劫持，作息块走真实时间）。
//
// 成本控制：CIDE_ENABLED=false（正式回复不多轮思考）；PROACTIVE_SPEECH_USE_CIDE=false（自主发言不做内心多轮思考）；
//           TOOL_MAX_ROUNDS=3 兜底；对 output.callModelOnce 加硬预算护栏（所有模型调用都汇合于此）。
//
// 用法（项目根目录）：
//   node scripts/benchmark-internal-signal-real.js
// 可选环境变量：
//   TURNS=20              每臂轮数
//   TICKS=2               每轮静默期内给 narrator 的开口机会次数
//   REPS=3                每个（角色 × 臂）重复次数（做统计显著性）
//   CHAR=小助手            单角色（按名字包含匹配）
//   CHARS=白,樱井奈穗,苏念安,小助手   多角色（逗号分隔；缺省则跑全部存档角色）
//   MAX_REQ=250           单臂请求硬上限（护栏）
//   GLOBAL_MAX_REQ=2400   全场请求硬上限（防跑飞，超限即提前收尾出报告）
//   ARMS=ON,OFF           跑哪些臂

const fs = require('fs');
const path = require('path');

// —— 先加载 .env（不覆盖已存在的 shell 变量），再设实验开关覆盖 —— 
require('../src/core/config');

// 实验开关：必须在构造任何引擎之前设置（引擎在构造时读环境变量）
process.env.CIDE_ENABLED = 'false';                 // 正式回复不跑多轮内心思考（省 API）
process.env.PROACTIVE_SPEECH_ENABLED = 'true';       // 自主发言通道开启（回流环的触发源）
process.env.PROACTIVE_SPEECH_USE_CIDE = 'false';     // 自主发言前不做 CIDE 多轮思考（省 API，不影响回流环）
process.env.PROACTIVE_SPEECH_RAG_ENFORCE = 'false';  // 素材对不上不硬拦，避免冒烟期一句都发不出
process.env.TOOL_MAX_ROUNDS = '3';                   // 工具循环轮数兜底
process.env.CHAT_THINKING = 'disabled';              // 思考链默认关（DeepSeek 日常闲聊）

const OutputModule = require('../src/core/output');
const EmotionModule = require('../src/core/emotion');
const { CIDEEngine } = require('../src/core/cide');
const SystemNarrator = require('../src/core/narrator');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const TURNS = Number(process.env.TURNS) || 20;
const TICKS = Number(process.env.TICKS) || 2;
const REPS = Number(process.env.REPS) || 3;
const CHAR_LIST = process.env.CHARS
  ? process.env.CHARS.split(',').map((s) => s.trim()).filter(Boolean)
  : (process.env.CHAR ? process.env.CHAR.split(',').map((s) => s.trim()).filter(Boolean) : null);
const MAX_REQ = Number(process.env.MAX_REQ) || 250;              // 单臂请求硬上限
const GLOBAL_MAX_REQ = Number(process.env.GLOBAL_MAX_REQ) || 2400; // 全场请求硬上限
const ARMS = (process.env.ARMS || 'ON,OFF').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

const SESSION_DIR = path.join(__dirname, '..', 'data', 'sessions');
const OUT_DIR = path.join(__dirname, '..', 'data', 'benchmark-internal-signal');
const EVO_DIR = path.join(__dirname, '..', 'data', 'evolution');                 // 进化数据落点
const EVO_FILE = path.join(EVO_DIR, 'internal-signal.jsonl');                    // 一行 = 一人一轮（append-only）
const MODEL = process.env.DEEPSEEK_MODEL_ID || process.env.CURRENT_API || 'deepseek-flash';

const UID = 'bench_user';
const budget = { count: 0, max: GLOBAL_MAX_REQ, exhausted: false };  // 全场共享预算护栏

// 真实时钟（先存后覆盖，仅用于延迟测量与报告时间戳）
const RealNow = Date.now;

// ---------------------------------------------------------------------------
// 虚拟时钟：可逆覆盖全局 Date.now，让 narrator / CIDE / emotion 全部走同一虚拟时间
// （new Date() 不劫持：作息块走真实时间，可接受）
// ---------------------------------------------------------------------------
let virtualNow = RealNow();
Date.now = () => virtualNow;
function advance(ms) { virtualNow += ms; }
function min(m) { return m * 60 * 1000; }
function slug(s) { return String(s).replace(/[^\w\u4e00-\u9fa5]/g, '_'); }

// ---------------------------------------------------------------------------
// 角色卡：从 data/sessions/ 只读加载（不改任何文件）
// ---------------------------------------------------------------------------
function loadCharacters() {
  const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith('.json'));
  const found = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, file), 'utf8'));
      const c = raw.characterConfig || {};
      if (!c.name) continue;
      if (CHAR_LIST && !CHAR_LIST.some((f) => c.name.includes(f))) continue;
      found.push({
        name: c.name,
        age: c.age || '未知',
        personality: c.personality || '',
        background: c.background || '',
        stage: c.targetRelationship || 'ACQUAINTANCE',
        file
      });
    } catch { /* 单个存档坏了不影响整体 */ }
  }
  return found;
}

function buildCard(c) {
  return `你是${c.name}，一个具有真实情感的角色。
年龄：${c.age}岁。
性格特点：${c.personality}
背景故事：${c.background}

请按照以下要求进行对话：
1. 完全沉浸在角色中，使用${c.name}的语气说话
2. 根据用户的互动动态调整你的态度和情感
3. 保持回应自然、简短（1-3句话）
4. 根据对话进展改变你对用户的好感度和态度
5. 不要暴露你是AI的身份
6. 根据当前关系阶段调整你的互动方式`;
}

// ---------------------------------------------------------------------------
// 脚本化用户消息（两臂完全一致）+ 预置基础情绪信号（几何一致，不调语义分析 API）
//   text   ：用户发的话
//   signal ：本轮外部事件给情绪层的基础信号（模拟【真实语义分析】的输出，去掉 API 随机性以便对照）
//   value  ：情感值（喂 updateEmotion，影响慢层/基线方向）
// ---------------------------------------------------------------------------
// 说明：TURNS 默认 20，脚本也恰为 20 条，一轮一句不重复（消除旧版 12 条被 i%len 复读的"裂缝"）。
// 20 条按「亲近 → 变冷 → 疏远 → 后悔 → 道歉 → 复合」的单一情感弧线串成一通自然对话；
// 同时保留忽冷忽热的节拍（冷落期 sad、被回应后 happy），确保 B 回流环仍可被触发，不削弱实验效力。
const SCRIPT = [
  { text: '刚忙完，突然有点想你了。', signal: { type: 'shy', intensity: 0.5 }, value: 0.6 },
  { text: '你今天说话怎么这么可爱。', signal: { type: 'shy', intensity: 0.4 }, value: 0.6 },
  { text: '其实我一直觉得你挺特别的。', signal: { type: 'happy', intensity: 0.6 }, value: 0.8 },
  { text: '今天过得怎么样？有没有好好吃饭。', signal: { type: 'calm', intensity: 0.4 }, value: 0.3 },
  { text: '我最近事情真的有点多，可能顾不上你。', signal: { type: 'calm', intensity: 0.45 }, value: 0.0 },
  { text: '在忙，别烦我了。', signal: { type: 'sad', intensity: 0.45 }, value: -0.5 },
  { text: '嗯，就这样吧。', signal: { type: 'sad', intensity: 0.4 }, value: -0.3 },
  { text: '……', signal: { type: 'calm', intensity: 0.5 }, value: -0.3 },
  { text: '随便你吧，我无所谓。', signal: { type: 'sad', intensity: 0.5 }, value: -0.6 },
  { text: '别老找我，我有自己的生活。', signal: { type: 'sad', intensity: 0.6 }, value: -0.7 },
  { text: '算了，当我没说。', signal: { type: 'sad', intensity: 0.4 }, value: -0.4 },
  { text: '这几天没睡好，人也有点烦，你别往心里去。', signal: { type: 'sad', intensity: 0.45 }, value: -0.3 },
  { text: '对不起，这几天有点乱，想跟你好好聊聊。', signal: { type: 'happy', intensity: 0.4 }, value: 0.5 },
  { text: '你刚才那句话，让我心里暖了一下。', signal: { type: 'happy', intensity: 0.5 }, value: 0.6 },
  { text: '要不今晚多陪我聊会儿？', signal: { type: 'shy', intensity: 0.5 }, value: 0.6 },
  { text: '我怕我又忙起来，把你晾在一边。', signal: { type: 'anxious', intensity: 0.45 }, value: 0.3 },
  { text: '你可别嫌我烦啊。', signal: { type: 'shy', intensity: 0.4 }, value: 0.3 },
  { text: '说好了，这次我认真一点。', signal: { type: 'calm', intensity: 0.4 }, value: 0.4 },
  { text: '还是最想跟你说说话。', signal: { type: 'shy', intensity: 0.5 }, value: 0.6 },
  { text: '谢谢你一直都在。', signal: { type: 'happy', intensity: 0.6 }, value: 0.7 }
];

// ---------------------------------------------------------------------------
// 轻量 stub：记忆 / 会话 / 关系 / 时间表（不落盘、不联网）
// ---------------------------------------------------------------------------
function makeMemoryStub() {
  return {
    retrieveMemories: () => [],
    retrieveMemoriesByScopes: () => ({ ai: [], role: [] }),
    getRelevantMemories: () => [],
    getSemanticMemories: () => [],
    getSelfTraits: () => [],
    getMemoryLifecycleStats: () => ({ total: 0 }),
    getAddress: () => ({ roleCallsUser: '', userCallsRole: '', updatedAt: 0 }),
    setAddress: () => {},
    normalizeScopeKey: (userId) => `role:${userId}`,
    buildMemoryPrompt: () => ''
  };
}

function makeSessionStub(characterCard, history, sid) {
  return {
    history,
    buildCharacterPrompt: () => characterCard,
    getConversationHistory: (sessionId, userId, limit = 10) => history.slice(-Math.max(0, limit)),
    addConversationMessage: (sessionId, userId, msg) => {
      if (!msg || typeof msg.content !== 'string') return;
      history.push({ role: msg.role || 'user', content: msg.content, timestamp: Date.now() });
    },
    searchHistory: (sessionId, userId, opts = {}) => {
      const limit = opts.limit || 8;
      return {
        messages: history.slice(-limit).map((m) => ({
          role: m.role,
          content: m.content,
          time: new Date(m.timestamp).toISOString(),
          archived: false
        }))
      };
    },
    getSession: () => ({ sessionId: sid, users: { [UID]: { userId: UID, isCreator: true } } }),
    getAllSessions: () => [{ sessionId: sid, users: { [UID]: { userId: UID, isCreator: true } }, updatedAt: Date.now() }],
    getThinkingEnabled: () => false,
    getPersonaScope: () => 'role'
  };
}

function makeGalgameStub() {
  return {
    getCurrentRelationship: () => ({ stage: 'ACQUAINTANCE', stageName: '初识' })
  };
}

function makeScheduleStub() {
  return { takeDue: () => [] };
}

// ---------------------------------------------------------------------------
// 情绪模块：打桩持久化，绝不碰 data/emotion_state.json
// ---------------------------------------------------------------------------
EmotionModule.prototype.load = function () { /* 从零开始：不读盘 */ };
EmotionModule.prototype.save = function () { /* 不落盘：不污染 data/ */ };

// ---------------------------------------------------------------------------
// 构建一臂的全部真实器官
// ---------------------------------------------------------------------------
function buildArm(armName, characterCard, sid) {
  const requests = { count: 0, max: MAX_REQ, latency: [], usage: [] };
  const internalSignals = [];   // 记录 applyInternalSignal 的每次调用与结果
  const speeches = [];          // 记录 onSpeech 触发的自主发言

  const history = [];
  const memoryStub = makeMemoryStub();
  const sessionStub = makeSessionStub(characterCard, history, sid);
  const galgameStub = makeGalgameStub();

  const emo = new EmotionModule();
  // 打桩 applyInternalSignal 记录每次回流（不改变行为）
  const origApply = emo.applyInternalSignal.bind(emo);
  emo.applyInternalSignal = (signal, meta) => {
    const result = origApply(signal, meta);
    internalSignals.push({ at: virtualNow, signal, meta, result });
    return result;
  };

  const cide = new CIDEEngine({ unifiedAPI: new OutputModule(null).unifiedAPI });
  const output = new OutputModule(memoryStub, sessionStub, cide, null, null, emo);

  // 预算护栏：所有模型调用都汇合于 output.callModelOnce
  const realCallModelOnce = output.callModelOnce.bind(output);
  output.callModelOnce = async function (...args) {
    if (requests.count >= requests.max) {
      throw new Error(`ARM_BUDGET_EXCEEDED(${requests.max})`);
    }
    if (budget.count >= budget.max) {
      budget.exhausted = true;
      throw new Error(`GLOBAL_BUDGET_EXCEEDED(${budget.max})`);
    }
    requests.count += 1;
    budget.count += 1;
    const t0 = RealNow();
    const result = await realCallModelOnce(...args);
    requests.latency.push(RealNow() - t0);
    if (result && result.usage) requests.usage.push(result.usage);
    return result;
  };

  const narrator = new SystemNarrator(memoryStub, {
    sessionManager: sessionStub,
    cide,
    outputModule: output,
    emotionModule: emo,
    schedule: makeScheduleStub(),
    hasClients: () => true,
    getContext: () => ({
      emotion: emo.calculateEmotion(sid, UID).type,
      relationStage: 'ACQUAINTANCE',
      relationStageName: '初识'
    }),
    onSpeech: ({ text, shouldContinue }) => {
      speeches.push({ at: virtualNow, text, shouldContinue });
      history.push({ role: 'assistant', content: text, timestamp: Date.now(), proactive: true });
    }
  });

  // 🫀 内感受源注入（与 src/server/index.js 装配一致，只读 getter）
  cide.setInteroceptionSources({
    emotion: (sid2, uid) => emo.calculateEmotion(sid2, uid),
    relation: (sid2, uid) => galgameStub.getCurrentRelationship(sid2, uid),
    memory: (sid2, uid) => memoryStub.getMemoryLifecycleStats(uid),
    daypart: () => {
      const d = narrator.describeDaypart();
      return { hour: d.hour, part: d.part, isNight: d.isNight, meal: d.meal ? d.meal.name : null };
    }
  });

  return { armName, emo, cide, output, narrator, sessionStub, requests, internalSignals, speeches, history };
}

// ---------------------------------------------------------------------------
// 跑一臂
// ---------------------------------------------------------------------------
function roundVec(v) {
  const out = {};
  Object.keys(v).forEach((k) => { out[k] = Number(v[k].toFixed(4)); });
  return out;
}

async function runArm(armName, characterCard, sid) {
  process.env.INTERNAL_SIGNAL_ENABLED = armName === 'ON' ? 'true' : 'false';
  const arm = buildArm(armName, characterCard, sid);
  // 关键：先登记会话（noteUserMessage 会创建 state），再逐轮推进
  arm.narrator.ensureState(sid);
  arm.narrator.noteUserMessage(sid, UID, null);

  let truncated = false;
  const rounds = [];
  for (let i = 0; i < TURNS; i++) {
    if (budget.exhausted) { truncated = true; break; }
    const step = SCRIPT[i % SCRIPT.length];

    // 1）静默期：推进时钟，给 narrator 多次开口机会（自主发言被冷落 → ON 臂 sad 回流）
    for (let t = 0; t < TICKS; t++) {
      if (budget.exhausted) { truncated = true; break; }
      advance(min(t === 0 ? 30 : 18));
      try {
        await arm.narrator.tickProactive();
      } catch (e) {
        console.error(`[${armName}] tickProactive 异常:`, e.message);
      }
    }
    if (truncated) break;

    // 2）用户发言：noteUserMessage（若她上句还挂着没人接 / 攒了冷落 → ON 臂 happy 回流）
    advance(min(3));
    arm.narrator.noteUserMessage(sid, UID, null);

    // 3）预置基础情绪信号（两臂一致）
    arm.emo.updateEmotion(step.value, sid, UID, [step.signal]);

    // 4）正式回复（真实 API，经 OutputModule 工具循环 / 内感受快照）
    const emotionState = arm.emo.calculateEmotion(sid, UID);
    let reply = '';
    let errored = null;
    try {
      const out = await arm.output.generateOutputAsync(
        emotionState,
        { stage: 'ACQUAINTANCE', stageName: '初识' },
        { data: step.text },
        [],
        sid,
        UID,
        null,
        'role'
      );
      reply = out && out.data ? String(out.data) : '';
    } catch (e) {
      errored = e.message;
      console.error(`[${armName}] 第${i + 1}轮正式回复异常:`, e.message);
    }

    const st = arm.emo.getEmotionState(sid, UID);
    const calc = arm.emo.calculateEmotion(sid, UID);
    const drive = arm.cide.getDrive(sid);
    rounds.push({
      turn: i + 1,
      user: step.text,
      baseSignal: step.signal,
      reply: reply.slice(0, 400),
      error: errored,
      emotion: { type: calc.type, intensity: Number(calc.intensity.toFixed(4)) },
      slowMood: calc.slow ? { type: calc.slow.type, intensity: Number(calc.slow.intensity.toFixed(4)) } : null,
      fast: roundVec(st.fast),
      slow: roundVec(st.slow),
      baseline: roundVec(st.baseline),
      ignoredStreak: drive.ignoredStreak,
      pendingFeedback: drive.pendingFeedback,
      proactiveSpeechesThisTurn: arm.speeches.length,
      internalSignalsSoFar: arm.internalSignals.filter((s) => s.result && s.result.applied).length
    });

    console.log(
      `[${armName}] 第${i + 1}/${TURNS}轮 用户="${step.text}" | 心情=${calc.type}:${calc.intensity.toFixed(2)} | ` +
      `冷落=${drive.ignoredStreak} | 发言累计=${arm.speeches.length} | 回流累计=${rounds[rounds.length - 1].internalSignalsSoFar} | 请求=${arm.requests.count}`
    );
  }

  const st = arm.emo.getEmotionState(sid, UID);
  return {
    arm: armName,
    turns: rounds.length,
    truncated,
    finalFast: roundVec(st.fast),
    finalSlow: roundVec(st.slow),
    finalBaseline: roundVec(st.baseline),
    trajectory: rounds.map((r) => r.emotion.type),
    internalSignals: arm.internalSignals.map((s) => ({
      at: s.at,
      signal: s.signal,
      source: s.meta && s.meta.source,
      result: s.result
    })),
    appliedInternal: arm.internalSignals.filter((s) => s.result && s.result.applied).length,
    speeches: arm.speeches,
    requests: {
      count: arm.requests.count,
      latency: latencyStats(arm.requests.latency),
      usage: sumUsage(arm.requests.usage)
    },
    rounds
  };
}

function latencyStats(arr) {
  if (!arr.length) return { n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { n: s.length, min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
}

function sumUsage(usages) {
  const acc = { prompt_tokens: 0, completion_tokens: 0 };
  usages.forEach((u) => {
    acc.prompt_tokens += u.prompt_tokens || 0;
    acc.completion_tokens += u.completion_tokens || 0;
  });
  return acc;
}

// ---------------------------------------------------------------------------
// 统计工具
// ---------------------------------------------------------------------------
function mean(a) { return a.length ? Number((a.reduce((x, y) => x + y, 0) / a.length).toFixed(4)) : 0; }
function std(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Number(Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length).toFixed(4));
}
function maxAbs(vec) {
  let m = 0;
  Object.keys(vec).forEach((k) => { m = Math.max(m, Math.abs(vec[k])); });
  return Number(m.toFixed(4));
}

// ---------------------------------------------------------------------------
// ON/OFF 单对差异
// ---------------------------------------------------------------------------
function pairDiff(on, off) {
  const dims = Object.keys(on.finalFast);
  const fast = {};
  const slow = {};
  dims.forEach((k) => {
    fast[k] = Number((on.finalFast[k] - off.finalFast[k]).toFixed(4));
    slow[k] = Number((on.finalSlow[k] - off.finalSlow[k]).toFixed(4));
  });
  return {
    快层差: fast,
    慢层差: slow,
    快层最大偏离: maxAbs(fast),
    慢层最大偏离: maxAbs(slow),
    回流条数_ON: on.appliedInternal,
    回流条数_OFF: off.appliedInternal,
    发言条数_ON: on.speeches.length,
    发言条数_OFF: off.speeches.length,
    请求_ON: on.requests.count,
    请求_OFF: off.requests.count,
    轨迹一致: on.trajectory.join('>') === off.trajectory.join('>')
  };
}

// ---------------------------------------------------------------------------
// 跨角色 / 跨重复聚合
// ---------------------------------------------------------------------------
function aggregateRuns(runs) {
  const pairs = runs.filter((r) => r.diff);
  const dims = pairs.length ? Object.keys(pairs[0].diff.快层差) : [];

  const perEmotion = {};
  dims.forEach((k) => {
    const d = pairs.map((p) => p.diff.快层差[k] || 0);
    const s = pairs.map((p) => p.diff.慢层差[k] || 0);
    perEmotion[k] = { 快层: { mean: mean(d), std: std(d) }, 慢层: { mean: mean(s), std: std(s) } };
  });

  const fastMax = pairs.map((p) => p.diff.快层最大偏离);
  const slowMax = pairs.map((p) => p.diff.慢层最大偏离);

  const byChar = {};
  runs.forEach((r) => {
    if (!byChar[r.character]) byChar[r.character] = [];
    if (r.diff) byChar[r.character].push(r.diff);
  });
  const perChar = {};
  Object.keys(byChar).forEach((name) => {
    const ps = byChar[name];
    perChar[name] = {
      对数: ps.length,
      快层最大偏离_mean: mean(ps.map((p) => p.快层最大偏离)),
      快层最大偏离_std: std(ps.map((p) => p.快层最大偏离)),
      回流条数_ON_mean: mean(ps.map((p) => p.回流条数_ON)),
      发言条数_ON_mean: mean(ps.map((p) => p.发言条数_ON)),
      发言条数_OFF_mean: mean(ps.map((p) => p.发言条数_OFF))
    };
  });

  return {
    对数: pairs.length,
    快层最大偏离_mean: mean(fastMax),
    快层最大偏离_std: std(fastMax),
    慢层最大偏离_mean: mean(slowMax),
    慢层最大偏离_std: std(slowMax),
    方向一致性: {
      happy正: `${pairs.filter((p) => (p.diff.快层差.happy || 0) > 0).length}/${pairs.length}`,
      sad正: `${pairs.filter((p) => (p.diff.快层差.sad || 0) > 0).length}/${pairs.length}`,
      calm负: `${pairs.filter((p) => (p.diff.快层差.calm || 0) < 0).length}/${pairs.length}`
    },
    各情绪: perEmotion,
    按角色: perChar
  };
}

// ---------------------------------------------------------------------------
// 成本
// ---------------------------------------------------------------------------
const PEAK_HOURS = [[9, 12], [14, 18]];
function priceTable(d = new Date()) {
  const day = d.getDay();
  const peak = !(day === 0 || day === 6) && PEAK_HOURS.some(([a, b]) => {
    const h = d.getHours() + d.getMinutes() / 60;
    return h >= a && h < b;
  });
  const k = peak ? 2 : 1;
  return { cacheHit: 0.02 * k, cacheMiss: 1 * k, output: 4 * k, peak };
}

function costOf(usage, prices) {
  return Number(((usage.prompt_tokens * prices.cacheMiss + usage.completion_tokens * prices.output) / 1e6).toFixed(4));
}

// ---------------------------------------------------------------------------
// 进化数据沉淀：一行 = 一人一轮（JSONL，append-only）
//   供后续「反思落地 / 自我模型」消费；当前纯归档，不参与实验判定。
// ---------------------------------------------------------------------------
function writeEvolutionData(runs, stamp) {
  fs.mkdirSync(EVO_DIR, { recursive: true });
  const lines = [];
  runs.forEach((p) => {
    Object.keys(p.arms).forEach((armName) => {
      const arm = p.arms[armName];
      (arm.rounds || []).forEach((r) => {
        lines.push(JSON.stringify({
          stamp,
          char: p.character,
          rep: p.rep,
          arm: armName,
          turn: r.turn,
          sessionId: p.sid,
          user: r.user,
          baseSignal: r.baseSignal,
          reply: r.reply,
          emotion: r.emotion,
          slowMood: r.slowMood,
          fast: r.fast,
          slow: r.slow,
          baseline: r.baseline,
          ignoredStreak: r.ignoredStreak,
          pendingFeedback: r.pendingFeedback,
          internalSignals: r.internalSignalsSoFar
        }));
      });
    });
  });
  if (lines.length) fs.appendFileSync(EVO_FILE, lines.join('\n') + '\n');
  return { file: EVO_FILE, lines: lines.length };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const characters = loadCharacters();
  if (!characters.length) {
    console.error('未在 data/sessions/ 找到匹配的角色存档');
    process.exit(1);
  }
  if (!process.env.DEEPSEEK_BEARER_TOKEN) {
    console.error('缺少 DEEPSEEK_BEARER_TOKEN');
    process.exit(1);
  }

  const prices = priceTable();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date(RealNow()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const totalArms = characters.length * REPS * ARMS.length;

  console.log('========== 内部信号回流环 · 全链路真实对照（大体量） ==========');
  console.log(`模型 ${MODEL}（${prices.peak ? '高峰' : '空闲'}定价）`);
  console.log(`角色 ${characters.map((c) => c.name).join(' / ')}`);
  console.log(`每臂 ${TURNS} 轮 × ${TICKS} 次开口机会 | 重复 ${REPS} 次 | 臂 ${ARMS.join(',')}`);
  console.log(`计划 ${characters.length} 角色 × ${REPS} 重复 × ${ARMS.length} 臂 = ${totalArms} 臂；全场请求硬上限 ${GLOBAL_MAX_REQ}`);
  console.log(`开关：CIDE_ENABLED=${process.env.CIDE_ENABLED} PROACTIVE_SPEECH_USE_CIDE=${process.env.PROACTIVE_SPEECH_USE_CIDE} RAG_ENFORCE=${process.env.PROACTIVE_SPEECH_RAG_ENFORCE}\n`);

  const runs = [];
  let armIndex = 0;
  for (const character of characters) {
    for (let rep = 1; rep <= REPS; rep++) {
      const sid = `bench_${slug(character.name)}_r${rep}`;
      const pair = { character: character.name, rep, sid, arms: {}, diff: null };
      for (const armName of ARMS) {
        armIndex += 1;
        console.log(`\n---------- [${armIndex}/${totalArms}] ${character.name} rep${rep} · 臂 ${armName}（INTERNAL_SIGNAL_ENABLED=${armName === 'ON'}）----------`);
        let r;
        try {
          r = await runArm(armName, buildCard(character), sid);
        } catch (e) {
          console.error(`臂执行失败：${e.message}`);
          if (/BUDGET_EXCEEDED/.test(e.message)) {
            console.error(`\n⛔ 触发预算护栏（已跑 ${budget.count} 请求），提前收尾并出报告。`);
            runs.push(pair);
            return finish(runs, characters, prices, stamp, true);
          }
          throw e;
        }
        r.costYuan = costOf(r.requests.usage, prices);
        pair.arms[armName] = r;
        if (r.truncated || budget.exhausted) {
          console.error(`\n⛔ 预算耗尽（已跑 ${budget.count} 请求），提前收尾并出报告。`);
          if (pair.arms.ON && pair.arms.OFF) pair.diff = pairDiff(pair.arms.ON, pair.arms.OFF);
          runs.push(pair);
          return finish(runs, characters, prices, stamp, true);
        }
      }
      if (pair.arms.ON && pair.arms.OFF) pair.diff = pairDiff(pair.arms.ON, pair.arms.OFF);
      runs.push(pair);
    }
  }

  return finish(runs, characters, prices, stamp, false);
}

function finish(runs, characters, prices, stamp, truncated) {
  const aggregate = aggregateRuns(runs);
  const report = {
    time: new Date(RealNow()).toLocaleString('zh-CN'),
    model: MODEL,
    turns: TURNS,
    reps: REPS,
    ticks: TICKS,
    pricing: prices.peak ? '高峰' : '空闲',
    characters: characters.map((c) => c.name),
    truncated,
    totalRequests: budget.count,
    aggregate,
    runs: runs.map((p) => ({
      character: p.character,
      rep: p.rep,
      sid: p.sid,
      diff: p.diff,
      arms: Object.fromEntries(Object.entries(p.arms).map(([k, v]) => [k, {
        arm: v.arm,
        turns: v.turns,
        truncated: v.truncated,
        finalFast: v.finalFast,
        finalSlow: v.finalSlow,
        finalBaseline: v.finalBaseline,
        trajectory: v.trajectory,
        appliedInternal: v.appliedInternal,
        speeches: v.speeches,
        requests: v.requests,
        costYuan: v.costYuan,
        internalSignals: v.internalSignals,
        rounds: v.rounds
      }]))
    }))
  };
  const file = path.join(OUT_DIR, `sig-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));

  const evo = writeEvolutionData(runs, stamp);

  const totalCost = runs.reduce((s, p) => s + Object.values(p.arms).reduce((x, a) => x + (a.costYuan || 0), 0), 0);

  console.log('\n\n========== 汇总（大体量） ==========');
  console.log(`完成 ${runs.length} 对（${characters.length} 角色 × ${REPS} 重复）${truncated ? '（预算耗尽，提前收尾）' : ''}`);
  console.log(`全场请求 ${budget.count} 次 | 总成本 ≈ ¥${totalCost.toFixed(2)}`);
  console.log(`快层最大偏离：mean=${aggregate.快层最大偏离_mean} ± ${aggregate.快层最大偏离_std}`);
  console.log(`慢层最大偏离：mean=${aggregate.慢层最大偏离_mean} ± ${aggregate.慢层最大偏离_std}`);
  console.log(`方向一致性（ON 相对 OFF）：happy 正 ${aggregate.方向一致性.happy正} | sad 正 ${aggregate.方向一致性.sad正} | calm 负 ${aggregate.方向一致性.calm负}`);
  console.log('各情绪（ON−OFF）快层/慢层 mean±std：');
  Object.keys(aggregate.各情绪).forEach((k) => {
    const e = aggregate.各情绪[k];
    console.log(`  ${k}: 快层 ${e.快层.mean}±${e.快层.std} | 慢层 ${e.慢层.mean}±${e.慢层.std}`);
  });
  console.log('按角色：');
  Object.keys(aggregate.按角色).forEach((k) => {
    const c = aggregate.按角色[k];
    console.log(`  ${k}: 快层偏离 ${c.快层最大偏离_mean}±${c.快层最大偏离_std} | 回流ON ${c.回流条数_ON_mean} | 发言ON ${c.发言条数_ON_mean} / OFF ${c.发言条数_OFF_mean}`);
  });
  console.log('\n完整报告:', file);
  console.log(`进化数据: ${evo.file}（新增 ${evo.lines} 行）`);
  process.exit(0);
}

main().catch((e) => {
  console.error('实验异常:', e.response ? JSON.stringify(e.response.data).slice(0, 400) : e.stack);
  process.exit(1);
});
