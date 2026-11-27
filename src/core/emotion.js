const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');
const evolutionParams = require('./evolutionParams').instance;

// 情绪状态层：把「她此刻什么心情」放在对话上下文之外，持久化保存，让心情能跨轮、跨重启延续。
// 设计要点（对应「情感连续性」方案）：
//   1. 双层时间常数：快层（分钟级，管这一轮的反应）+ 慢层（周级，管整体态度/底色）；
//   2. 一阶滤波更新：朝目标插值，而非加减法；被气到之后的残留由惯性自然带过；
//   3. 快层偏离慢层超过阈值才回写慢层，避免「吵一次就抖掉整段关系」；
//   4. 基线可被慢层缓慢改写，闲久往基线回、但回不到原来；
//   5. 快层每次更新叠加极小随机扰动，防止纯积分器跑久漂到极值。
// 状态文件只存数值向量（无任何自由文本），外部内容无法写入状态，防注入天然成立。
const EMOTIONS = ['happy', 'sad', 'shy', 'anxious', 'jealous', 'dependent', 'calm'];

// 快层初值：平和偏愉悦（与旧实现的默认情绪一致）
const DEFAULT_FAST = { happy: 0.2, sad: 0, shy: 0, anxious: 0, jealous: 0, dependent: 0, calm: 0.8 };
// 慢层 / 基线初值：长期底色，平静为主
const DEFAULT_BASELINE = { happy: 0.1, sad: 0, shy: 0, anxious: 0, jealous: 0, dependent: 0, calm: 0.35 };

const FAST_HALF_LIFE_MS = 8 * 60 * 1000;             // 快层半衰期：分钟级
const SLOW_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;   // 慢层半衰期：周级
const BASELINE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 基线漂移半衰期：月级

const FILTER_GAIN = 0.4;              // 一阶滤波步长：一次事件朝目标走 40%
const SLOW_WRITE_THRESHOLD = 0.2;     // 快层偏离慢层超过此值才回写慢层
const SLOW_WRITE_GAIN = 0.12;         // 回写步长：慢层是周级底色，单次事件只轻推一点，避免忽冷忽热把底色带跑
const NOISE_SIGMA = 0.008;            // 快层随机扰动幅度

const HISTORY_LIMIT = 100;
const STORAGE_PATH = path.join(__dirname, '../../data/emotion_state.json');

// 内部信号（回流环）：角色自身行为（如自主发言被冷落 / 被回应）反过来给情绪带来的涟漪。
// 默认关，须显式开启（INTERNAL_SIGNAL_ENABLED=true）；单次强度有上限、同一来源有冷却，
// 且只动快层、不回写慢层——内部信号只是这一轮的心情涟漪，不许把长期底色带跑。
// 「滤波步长 / 强度上限」两个参数已外置到进化参数层（evolutionParams），代码默认值仍是
// 0.08 / 0.35，运行时先查 data/evolution/params.json 的覆盖值——于是参数过闸即可生效，无需改源码。
const INTERNAL_COOLDOWN_MS = 60 * 1000; // 同一来源两次内部信号的最小间隔
const INTERNAL_LAST_AT_CAP = 1000;      // 冷却账本条目上限：超过才清扫，平时零开销

// 情绪信号（语义类型）→ 7 维目标映射：值为该维的权重，权重越大越接近满值。
// angry 归到 sad+anxious；jealous 略带 anxious；calm 只在真正平静时生效。
const SIGNAL_TARGET_MAP = {
  happy: { happy: 1 },
  sad: { sad: 1 },
  shy: { shy: 1 },
  anxious: { anxious: 1 },
  jealous: { jealous: 1, anxious: 0.5 },
  dependent: { dependent: 1 },
  angry: { sad: 1, anxious: 0.75 },
  calm: { calm: 1 }
};

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

// 归一化一条 7 维向量：缺字段/非法值一律回落到 fallback
function normalizeVector(raw, fallback) {
  const out = {};
  EMOTIONS.forEach((emotion) => {
    const value = raw && Number.isFinite(Number(raw[emotion])) ? Number(raw[emotion]) : fallback[emotion];
    out[emotion] = clamp01(value);
  });
  return out;
}

class EmotionModule {
  constructor() {
    // 每档状态：{ fast, slow, baseline, history, fastAt, slowAt, baselineAt }
    this.states = {};
    // 内部信号节流：记录「某个来源 × 某档」上次写入的时间
    this.internalLastAt = {};
    this.load();
  }

  // 情绪按「角色会话 × 用户」二维分档：同一角色下不同登录用户各存一份，互不影响
  // key 格式：sessionId|userId；userId 缺省 default
  buildKey(sessionId, userId) {
    const sid = sessionId || 'default';
    const uid = (typeof userId === 'string' && userId.trim()) ? userId.trim() : 'default';
    return `${sid}|${uid}`;
  }

  // —— 持久化 ——

  load() {
    try {
      if (!fs.existsSync(STORAGE_PATH)) return;
      const parsed = JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'));
      const stored = parsed && parsed.states && typeof parsed.states === 'object' ? parsed.states : null;
      if (!stored) return;
      Object.entries(stored).forEach(([key, raw]) => {
        if (!raw || typeof raw !== 'object') return;
        const now = Date.now();
        this.states[key] = {
          fast: normalizeVector(raw.fast, DEFAULT_FAST),
          slow: normalizeVector(raw.slow, DEFAULT_BASELINE),
          baseline: normalizeVector(raw.baseline, DEFAULT_BASELINE),
          history: Array.isArray(raw.history) ? raw.history.slice(-HISTORY_LIMIT) : [],
          fastAt: Number.isFinite(raw.fastAt) ? raw.fastAt : now,
          slowAt: Number.isFinite(raw.slowAt) ? raw.slowAt : now,
          baselineAt: Number.isFinite(raw.baselineAt) ? raw.baselineAt : now
        };
      });
    } catch (error) {
      console.error('[情绪] 状态读取失败，改用空档:', error.message);
    }
  }

  save() {
    try {
      // 原子写：先写临时文件再 rename，崩溃/断电时不会留下半截 JSON 导致下次读取失败
      writeJsonAtomicSync(STORAGE_PATH, { version: 1, states: this.states });
    } catch (error) {
      console.error('[情绪] 状态落盘失败:', error.message);
    }
  }

  // 取得某档状态；不存在则初始化一份
  getEmotionState(sessionId, userId) {
    const key = this.buildKey(sessionId, userId);
    if (!this.states[key]) {
      const now = Date.now();
      this.states[key] = {
        fast: { ...DEFAULT_FAST },
        slow: { ...DEFAULT_BASELINE },
        baseline: { ...DEFAULT_BASELINE },
        history: [],
        fastAt: now,
        slowAt: now,
        baselineAt: now
      };
    }
    return this.states[key];
  }

  // —— 时间投影（纯读取，不写回；避免「看一眼就掉一档」）——

  // 把一层按半衰期朝其目标投影到 now
  projectLayer(current, target, halfLifeMs, lastAt, now) {
    const factor = Math.pow(0.5, Math.max(0, now - lastAt) / halfLifeMs);
    const out = {};
    EMOTIONS.forEach((emotion) => {
      out[emotion] = target[emotion] + (current[emotion] - target[emotion]) * factor;
    });
    return out;
  }

  // 快/慢都朝基线回落，基线则朝慢层缓漂 → 长期看基线被事件改写，回不到原来。
  // 慢层与基线是互相牵引的耦合系统，必须联立求解，不能一层层各自投影：
  // 若先让慢层落回旧基线、再让基线去追已经衰完的慢层，长间隔会把「基线漂移」整段抹掉。
  // 联立 dS/dt = -a(S-B)、dB/dt = -b(B-S)（a=慢层速率，b=基线速率）有解析解：
  //   D(t) = D0·e^{-(a+b)t}
  //   S(t) = S0 − a·D0·(1−e^{-(a+b)t})/(a+b)
  //   B(t) = S(t) − D(t)
  // 长时间后二者收敛到同一偏移平衡点 S0 − a·D0/(a+b)，该点通常不为 0 → 回不到原样成立。
  projectState(state, now) {
    const dt = Math.max(0, now - state.slowAt);
    const a = Math.LN2 / SLOW_HALF_LIFE_MS;
    const b = Math.LN2 / BASELINE_HALF_LIFE_MS;
    const x = (a + b) * dt;
    const decay = Math.exp(-x);
    const u = (-Math.expm1(-x)) / (a + b); // 数值稳定的 (1−e^{-x})/(a+b)
    const slow = {};
    const baseline = {};
    EMOTIONS.forEach((emotion) => {
      const s0 = state.slow[emotion];
      const d0 = s0 - state.baseline[emotion];
      const s1 = s0 - a * d0 * u;
      slow[emotion] = clamp01(s1);
      baseline[emotion] = clamp01(s1 - d0 * decay);
    });
    // 快层朝「慢层」回落（而非直接跳回长期基线）：此刻心情回落到最近心境，
    // 这样短时间多次同向互动能在快层累积，而不是每次都被打回基线。
    const fast = this.projectLayer(state.fast, slow, FAST_HALF_LIFE_MS, state.fastAt, now);
    return { fast, slow, baseline };
  }

  // 把投影结果落盘并推进时间基准（只有写路径会调用）
  advanceState(state) {
    const now = Date.now();
    const projected = this.projectState(state, now);
    state.fast = projected.fast;
    state.slow = projected.slow;
    state.baseline = projected.baseline;
    state.fastAt = now;
    state.slowAt = now;
    state.baselineAt = now;
  }

  // 按真实经过时间把情绪投影到此刻（只算不写回）
  projectEmotions(sessionId = 'default', userId = 'default', now = Date.now()) {
    return this.projectState(this.getEmotionState(sessionId, userId), now).fast;
  }

  dominantOf(vector) {
    let maxEmotion = 'calm';
    let maxIntensity = vector.calm;
    EMOTIONS.forEach((emotion) => {
      if (vector[emotion] > maxIntensity) {
        maxEmotion = emotion;
        maxIntensity = vector[emotion];
      }
    });
    return maxEmotion;
  }

  // 获取主导情绪
  getDominantEmotion(sessionId = 'default', userId = 'default') {
    return this.dominantOf(this.projectEmotions(sessionId, userId));
  }

  // 由本次情绪倾向值推出一条「目标向量」（无 signals 时的回退路径）：
  // 命中分支的情绪给目标值，其余保持基线。不再顺带抬高 calm，避免 calm 抢走主导。
  targetFromInput(inputValue, baseline) {
    const target = { ...baseline };
    if (inputValue > 0.5) {
      target.happy = Math.max(baseline.happy, 0.9);
    } else if (inputValue < -0.3) {
      target.sad = Math.max(baseline.sad, 0.8);
      target.anxious = Math.max(baseline.anxious, 0.6);
    } else if (inputValue > 0.3) {
      target.happy = Math.max(baseline.happy, 0.6);
    } else if (inputValue > 0) {
      target.happy = Math.max(baseline.happy, 0.45);
    }
    return target;
  }

  // 由情绪信号列表推出「目标向量」：按语义类型映射到 7 维，取各维最大值（支持复合情绪）。
  // 目标值 = 0.5 + 0.45×intensity×weight，强度越高越接近该维满值；不驱动未被信号命中的维。
  // 出现非 calm 信号时把 calm 目标压到 0：平静感当轮退位——否则残留的高位 calm（衰减后≈0.5+）
  // 会在单轮内压死任何新情绪（实测 43% 的强信号轮主导仍是 calm）。
  targetFromSignal(signals, baseline) {
    const target = { ...baseline };
    if (!Array.isArray(signals) || signals.length === 0) return target;
    let hasNonCalm = false;
    signals.forEach((signal) => {
      const map = SIGNAL_TARGET_MAP[signal?.type];
      if (!map) return;
      const raw = Number(signal.intensity);
      const intensity = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.5;
      if (signal?.type !== 'calm') hasNonCalm = true;
      Object.entries(map).forEach(([emotion, weight]) => {
        const level = 0.5 + 0.45 * intensity * weight;
        target[emotion] = Math.max(target[emotion], level);
      });
    });
    if (hasNonCalm) target.calm = 0;
    return target;
  }

  // 更新情绪
  updateEmotion(inputValue, sessionId = 'default', userId = 'default', signals = null) {
    const state = this.getEmotionState(sessionId, userId);
    // 先把旧情绪按真实经过时间落到此刻，再叠加本次的变化
    this.advanceState(state);

    const value = Number.isFinite(Number(inputValue)) ? Number(inputValue) : 0;
    // 有情绪信号则按类型驱动对应维度；否则回退到标量倾向值（向后兼容旧调用方）
    const target = Array.isArray(signals) && signals.length > 0
      ? this.targetFromSignal(signals, state.baseline)
      : this.targetFromInput(value, state.baseline);

    // 一阶滤波：只推进本次被激活的情绪（目标与基线不同的那几维），其余交给时间衰减
    EMOTIONS.forEach((emotion) => {
      if (target[emotion] === state.baseline[emotion]) return;
      const next = state.fast[emotion] + FILTER_GAIN * (target[emotion] - state.fast[emotion]);
      // 随机扰动：防止纯平滑的状态长期收敛到极值
      const noise = (Math.random() * 2 - 1) * NOISE_SIGMA;
      state.fast[emotion] = clamp01(next + noise);
    });

    // 快层偏离慢层超过阈值才回写慢层：小波动不惊动长期底色
    EMOTIONS.forEach((emotion) => {
      if (Math.abs(state.fast[emotion] - state.slow[emotion]) > SLOW_WRITE_THRESHOLD) {
        state.slow[emotion] = clamp01(state.slow[emotion] + SLOW_WRITE_GAIN * (state.fast[emotion] - state.slow[emotion]));
      }
    });

    state.history.push({ emotions: { ...state.fast }, timestamp: Date.now() });
    if (state.history.length > HISTORY_LIMIT) {
      state.history.shift();
    }
    this.save();
  }

  // 内部信号开关：默认关，须显式开启。每次调用实时读环境变量，便于运行时开关与测试。
  isInternalSignalEnabled() {
    return process.env.INTERNAL_SIGNAL_ENABLED === 'true';
  }

  // 施加一条「内部信号」：角色自身行为（如自主发言被冷落 / 被回应）回流成情绪涟漪。
  // 与外部输入的五重隔离：①默认关；②只认已知信号类型；③单次强度封顶；④同一来源有冷却；
  // ⑤只推快层、绝不回写慢层。任何一步不满足都不写状态，返回 applied:false 并说明原因。
  applyInternalSignal(signal, { sessionId = 'default', userId = 'default', source = 'internal' } = {}) {
    if (!this.isInternalSignalEnabled()) {
      return { applied: false, reason: 'disabled' };
    }
    const type = signal && signal.type;
    if (!SIGNAL_TARGET_MAP[type]) {
      return { applied: false, reason: 'unknown-signal' };
    }
    const now = Date.now();
    const key = `${this.buildKey(sessionId, userId)}#${source}`;
    if (now - (this.internalLastAt[key] || 0) < INTERNAL_COOLDOWN_MS) {
      return { applied: false, reason: 'cooldown' };
    }
    const raw = Number(signal.intensity);
    const intensity = Math.min(evolutionParams.get('internalIntensityCap'), Number.isFinite(raw) ? Math.max(0, raw) : 0);
    if (!(intensity > 0)) {
      return { applied: false, reason: 'zero-intensity' };
    }

    const state = this.getEmotionState(sessionId, userId);
    this.advanceState(state);

    const target = this.targetFromSignal([{ type, intensity }], state.baseline);
    const gain = evolutionParams.get('internalFilterGain');
    EMOTIONS.forEach((emotion) => {
      if (target[emotion] === state.baseline[emotion]) return;
      const next = state.fast[emotion] + gain * (target[emotion] - state.fast[emotion]);
      const noise = (Math.random() * 2 - 1) * NOISE_SIGMA;
      state.fast[emotion] = clamp01(next + noise);
    });
    // 刻意不跑慢层回写：内部信号只掀快层涟漪，不动周级底色

    state.history.push({ emotions: { ...state.fast }, timestamp: now, origin: 'internal', source });
    if (state.history.length > HISTORY_LIMIT) {
      state.history.shift();
    }
    this.internalLastAt[key] = now;
    this.pruneInternalLastAt(now);
    this.save();
    return { applied: true, type, intensity, source };
  }

  // 冷却账本清扫：只保留仍在冷却窗口内的记录——过期的既不再拦人，也没必要留着。
  // 平时条目不多时零开销（仅比一次长度），超过上限才真正遍历回收，保证账本有界。
  pruneInternalLastAt(now = Date.now()) {
    const keys = Object.keys(this.internalLastAt);
    if (keys.length <= INTERNAL_LAST_AT_CAP) return;
    keys.forEach((k) => {
      if (now - this.internalLastAt[k] >= INTERNAL_COOLDOWN_MS) delete this.internalLastAt[k];
    });
  }

  // 计算情绪状态（纯读取：只看不改）
  calculateEmotion(sessionId = 'default', userId = 'default') {
    const now = Date.now();
    const { fast, slow } = this.projectState(this.getEmotionState(sessionId, userId), now);
    const dominantEmotion = this.dominantOf(fast);
    const slowEmotion = this.dominantOf(slow);
    return {
      type: dominantEmotion,
      intensity: fast[dominantEmotion],
      timestamp: now,
      // 慢层心境：供提示词注入「最近这段时间」的长期语气
      slow: { type: slowEmotion, intensity: slow[slowEmotion] }
    };
  }

  // 慢层心境（单独取用）
  getSlowMood(sessionId = 'default', userId = 'default', now = Date.now()) {
    const slow = this.projectState(this.getEmotionState(sessionId, userId), now).slow;
    const type = this.dominantOf(slow);
    return { type, intensity: slow[type] };
  }

  // 获取情绪历史
  getEmotionHistory(sessionId = 'default', userId = 'default') {
    return this.getEmotionState(sessionId, userId).history;
  }

  // 获取当前情绪状态（按时间投影到此刻，同样不写回）
  getCurrentEmotions(sessionId = 'default', userId = 'default') {
    return this.projectEmotions(sessionId, userId);
  }

  // 重置情绪状态
  resetEmotions(sessionId = 'default', userId = 'default') {
    const key = this.buildKey(sessionId, userId);
    delete this.states[key];
    this.getEmotionState(sessionId, userId);
    this.save();
  }
}

module.exports = EmotionModule;
