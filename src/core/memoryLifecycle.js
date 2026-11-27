// 🧠 类脑记忆生命周期（纯逻辑，不碰 fs / 网络，方便单测）
//
// 负责记忆「记得多牢」这条线：编码初值 → 时间衰减 → 提取强化 → 归档降级 → 溢出淘汰。
// memory.js 只负责把这里算出来的结果落到 store 并做节流写盘；真正的策略都在本文件。
//
// 设计背景见《类脑记忆生命周期设计方案（v2）》：
//  - recallCount 只归「提取强化」（越多越难忘）；自主发言的「饱和」不写这里（H1）
//  - 回想对稳定性的贡献封顶 + 取对数，避免活跃条目「永不忘」（H2）

// 可标定参数（S0/K 见方案 §4.2；evictLimit 沿用原 1000 条上限）
//
// 归档策略（本轮重写）：主导权交给「调用权重 × 上下文额度」。
//  - 人不是按日历忘事的：一件事忘不忘，取决于它最近还有没有被调用（阿德勒的目的论——
//    记忆服务于当下的目的，当下用不上的自然退到后排），而不是「第 37 天到了」。
//  - 所以真正决定「谁进归档」的是工作集预算：模型上下文只给记忆留一小块（默认 DeepSeek
//    128K 的 5%），装不下的按调用权重从低到高退到 archived（只降级、不删除，强线索仍能唤醒）。
//  - s0Days / archiveRetention 保留为时间兜底：从没被调用、也老到想不起来的条目照样淡出，
//    避免「冷启动的弱记忆因为没人调用而永远占着前排」——这正是「感受 → 转化 → 实践」里
//    「实践检验」的一环：没被实践（调用）过的记忆，权重自然掉下去。
const DEFAULTS = {
  evictLimit: 1000,          // 单个 store 的记忆条数上限，超出按 retention 从低到高淘汰
  s0Days: 14,                // 基础记忆稳定性（天）：原值 7 时，salience≈0.4 的平常事约 16 天就落进归档区，
                             // 归档只能靠向量命中唤醒，等于「说过的话两周后就想不起来」；翻倍到 14 后归档点约 37 天
  kSalience: 3,              // salience 对稳定性的线性放大系数（标定：K=2 时高光/琐事半衰期比值仅 1.44，K=3 达 1.6，达标）
  recallDurabilityCap: 10,   // 回想次数对稳定性的封顶（超过不再增益）
  archiveRetention: 0.3,     // 时间兜底：retention 低于此值 → 转 tier='archived'（移出默认召回池，不删除）
  // ---- 上下文额度（按 DeepSeek 128K 窗口推导，不再手写「第几天归档」的日历常数）----
  contextWindowTokens: 131072, // DeepSeek 上下文窗口（128K）：记忆额度按它的比例算
  memoryBudgetRatio: 0.05,     // 记忆工作集最多占上下文的 5%（约 6.5K tokens，约 250 条日常记忆）
  charsPerToken: 1.6,          // 中文按 1.6 字/token 保守估算，宁少勿多（估多了会撑爆真实上下文）
  pruneRetention: 0.05,      // retention 低于此值且从未被召回 → 真正删除
  reinforceSalienceStep: 0.05, // 每被召回一次，salience 的增量
  reinforceSalienceMax: 1,   // salience 上限
  tombstoneLimit: 200,       // 遗忘留痕（tombstone）容量上限，超出按 FIFO 丢弃
  salienceEmotionWeight: 0.15, // 主情绪强度对 salience 初值的增益权重（P2/DB-3）
  salienceNoveltyWeight: 0.05, // 新颖度（是否开新话题）对 salience 初值的增益权重（P2/DB-3）
  fragmentQuota: 1,          // 每个话题被删到「只剩碎片」时至少保留的条数（DB-5）
  negativeSalienceFloor: 0.5 // value<0 的记忆 salience 下限：不因「不好」被更快遗忘（DB-5）
};

// 系统生成的条目（滚动归档摘要等，正文以【开头）不参与衰减/归档/淘汰/强化：
// 它们不是「用户的经历」，用遗忘曲线衡量没有意义，反复召回还会污染曲线
function isProtected(memory) {
  return !!(memory && typeof memory.data === 'string' && memory.data.startsWith('【'));
}

// 被用户「钉住」的记忆：豁免衰减/归档/淘汰，也不被提取强化改写。
// 这是角色共识「有一格不许任何人替我动」的直接落地（见《记忆系统融合方案》DB-4）
function isPinned(memory) {
  return !!(memory && memory.pinned);
}

// 耐久条目：不参与遗忘衰减、不进淘汰池、不被提取强化改写。
//  - 系统生成的摘要（isProtected）本来就是旁路产物
//  - 用户钉住的记忆（isPinned）：由用户显式要求长期保留
//  - 语义记忆（tier='semantic'）是「学到的稳定认识」，不是一次经历：它应长期留存，
//    被遗忘曲线淡出或被归档降级都会把它这条学习成果弄丢（务必与 isProtected 区别开：
//    isProtected 只看正文前缀，语义记忆正文不是【开头）
function isDurable(memory) {
  if (isProtected(memory)) return true;
  if (isPinned(memory)) return true;
  return !!(memory && memory.tier === 'semantic');
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// salience 初值：情感越强越不容易忘，落在 [0.3,1]。
// 可选 extra 传入另外两个「写入时就拿得到」的信号（P2/DB-3）：
//   intensity —— 主情绪强度 0~1；novelty —— 是否开启新话题 0/1。
// 不传 extra 时与旧版单维公式完全等价（向后兼容）。
// 负面保底（DB-5）：value<0 的条目显著度不低于 negativeSalienceFloor，
//   避免「不愉快/难堪的事」因为情绪值为负而被更快忘掉（角色共识：负面记忆不该被轻易删除）
function initialSalience(value, extra = {}) {
  const v = Number(value) || 0;
  const intensity = clamp01(extra && extra.intensity);
  const novelty = clamp01(extra && extra.novelty);
  const base = 0.3
    + 0.5 * Math.abs(v)
    + DEFAULTS.salienceEmotionWeight * intensity
    + DEFAULTS.salienceNoveltyWeight * novelty;
  return clamp01(v < 0 ? Math.max(base, DEFAULTS.negativeSalienceFloor) : base);
}

// 记忆稳定性 S（天）：越大越难忘，半衰期 = S·ln2。
// computeRetention 与离线标定脚本都基于这个量，避免遗忘公式在两处各写一份而漂移。
function stabilityDays(memory, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const salience = clamp01(memory && memory.salience != null ? memory.salience : initialSalience(memory && memory.value));
  const recallCount = Math.max(0, Number(memory && memory.recallCount) || 0);
  // 回想贡献有界：cap 之外不再增益（H2）
  const recallLever = 1 + Math.log1p(Math.min(recallCount, cfg.recallDurabilityCap));
  return Math.max(0.1, cfg.s0Days * (1 + cfg.kSalience * salience) * recallLever);
}

// 当前保留度 retention ∈ (0,1]：retention(t) = exp(-dt / S)
function computeRetention(memory, now = Date.now(), opts = {}) {
  const last = Number(memory && memory.lastRecallAt) || Number(memory && memory.timestamp) || now;
  const dtDays = Math.max(0, (now - last) / 86400000);
  return Math.exp(-dtDays / stabilityDays(memory, opts));
}

// 记忆工作集预算（tokens）：由 DeepSeek 上下文窗口 × 记忆占比直接推出来。
// 没有任何「第几天该归档」的日历常数——窗口多大、给记忆留几成，额度就多大
function workingSetBudget(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const windowTokens = Math.max(0, Number(cfg.contextWindowTokens) || 0);
  const ratio = clamp01(cfg.memoryBudgetRatio);
  return Math.floor(windowTokens * ratio);
}

// 单条记忆占用多少 tokens（估算）：中文按字/token 比例折算，空条目记 0
function estimateTokens(memory, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const text = String((memory && memory.data) || '');
  if (!text) return 0;
  const perToken = Number(cfg.charsPerToken) > 0 ? Number(cfg.charsPerToken) : 1.6;
  return Math.max(1, Math.ceil(text.length / perToken));
}

// 调用权重：这条记忆「当下还被调用得动」的程度，用来排工作集的座次。
// 三个因子都来自真实使用痕迹，而不是日历：
//   retention   —— 时间衰减后的可达性（久不想 → 掉）
//   recallCount —— 被召回过的次数（常用的记得牢，对数封顶，避免「永不忘」）
//   salience    —— 情绪/重要性权重（感受越强越靠前，对应「感受 → 转化」）
function callWeight(memory, now = Date.now(), opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const retention = computeRetention(memory, now, cfg);
  const recallCount = Math.max(0, Number(memory && memory.recallCount) || 0);
  const salience = clamp01(
    memory && memory.salience != null ? memory.salience : initialSalience(memory && memory.value)
  );
  return retention * (1 + Math.log1p(Math.min(recallCount, cfg.recallDurabilityCap))) * (1 + salience);
}

// 按上下文额度归档：工作集（未归档、非耐久条目）占用的 tokens 超出记忆额度时，
// 按调用权重从低到高转 archived（只降级、不删除，强线索仍可唤醒）。
// 至少留 1 条在工作集里：全归档等于「记忆库看起来是空的」，不符合「像人一样」的连续性
function archiveByWorkingSet(store, now = Date.now(), opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const budget = workingSetBudget(cfg);
  if (budget <= 0 || !store || !Array.isArray(store.memories)) return 0;

  const active = [];
  let used = 0;
  for (const memory of store.memories) {
    if (!memory || typeof memory !== 'object') continue;
    if (isDurable(memory) || memory.tier === 'archived') continue;
    const tokens = estimateTokens(memory, cfg);
    active.push({ memory, tokens, weight: callWeight(memory, now, cfg) });
    used += tokens;
  }
  if (used <= budget) return 0;

  active.sort((a, b) => a.weight - b.weight
    || (Number(a.memory.timestamp) || 0) - (Number(b.memory.timestamp) || 0));
  let archived = 0;
  for (const item of active) {
    if (used <= budget) break;
    if (active.length - archived <= 1) break;
    item.memory.tier = 'archived';
    used -= item.tokens;
    archived++;
  }
  return archived;
}

// 遗忘扫描：把已经想不起来的条目转 archived、把彻底忘掉的删除、把被重新想起的唤醒。
// 就地改写 store.memories，返回本次的统计，供日志/调参用
function applyForgetting(store, now = Date.now(), opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const result = { scanned: 0, archived: 0, pruned: 0, recovered: 0 };
  if (!store || !Array.isArray(store.memories)) return result;

  // 第一遍：先标记「够格删除」的候选（忘到阈值以下且从没被想起过），但不立刻删 ——
  // 交给碎片配额，避免把整个话题「一律删」干净（DB-5）
  const retentionOf = new Map();  // memory -> 当前 retention
  const doomed = new Set();       // 够格删除的条目
  const byTopic = new Map();      // topicId -> 该话题下够格删除的 [{ memory, retention }]
  for (const memory of store.memories) {
    if (!memory || typeof memory !== 'object') continue;
    if (isDurable(memory)) continue;
    result.scanned++;
    const retention = computeRetention(memory, now, cfg);
    retentionOf.set(memory, retention);
    const recallCount = Number(memory.recallCount) || 0;
    if (retention <= cfg.pruneRetention && recallCount === 0) {
      doomed.add(memory);
      if (memory.topicId != null) {
        const tid = String(memory.topicId);
        if (!byTopic.has(tid)) byTopic.set(tid, []);
        byTopic.get(tid).push({ memory, retention });
      }
    }
  }

  // 碎片配额：同一话题若整组都够格删除，保底留下 N 条最低 retention 的「碎片」——
  // 不是只记住情绪最强的那些，平凡的细节也该留一点（角色共识④「保留低显著度碎片」）。
  // 没有 topicId 的条目不成话题，不受配额保护，照常删除
  const quota = Math.max(0, Math.floor(Number(cfg.fragmentQuota)) || 0);
  for (const items of byTopic.values()) {
    if (items.length <= quota) continue;
    items.sort((a, b) => a.retention - b.retention); // 保留最低 retention 的 N 条
    // 把要「保留」的 N 条从删除集里剔除，其余照删
    for (let i = 0; i < Math.min(quota, items.length); i++) doomed.delete(items[i].memory);
  }

  // 第二遍：落盘 —— 删除（留痕）、归档、或唤醒
  const kept = [];
  for (const memory of store.memories) {
    if (!memory || typeof memory !== 'object') continue;
    if (isDurable(memory)) {
      kept.push(memory);
      continue;
    }
    // 彻底忘掉且从没被想起过 → 真正删除，腾出容量
    if (doomed.has(memory)) {
      // 遗忘留痕：删除前记一笔「曾忘过什么」，供反思/元记忆读取（角色共识「别当成从没发生过」）
      if (!Array.isArray(store.tombstones)) store.tombstones = [];
      store.tombstones.push({
        topicId: memory.topicId || null,
        prunedAt: now,
        lastSalience: clamp01(memory.salience != null ? memory.salience : initialSalience(memory.value))
      });
      // 容量封顶：超出按 FIFO 丢弃最早的留痕，避免无限膨胀
      if (store.tombstones.length > cfg.tombstoneLimit) {
        store.tombstones.splice(0, store.tombstones.length - cfg.tombstoneLimit);
      }
      result.pruned++;
      continue;
    }
    const retention = retentionOf.get(memory);
    // 淡出但还留着线索，移出默认召回池
    if (retention <= cfg.archiveRetention) {
      if (memory.tier !== 'archived') {
        memory.tier = 'archived';
        result.archived++;
      }
      kept.push(memory);
      continue;
    }
    // 保留度回升（被强线索召回强化过）→ 从归档里唤醒
    if (memory.tier === 'archived') {
      memory.tier = 'episodic';
      result.recovered++;
    }
    kept.push(memory);
  }

  store.memories = kept;
  // 时间兜底之后，再按「调用权重 × 上下文额度」做一次自动归档：
  // 这是现在的主归档通道——装不进记忆额度的、最不常用的先退到后排
  result.archived += archiveByWorkingSet(store, now, cfg);
  return result;
}

// 溢出淘汰：超过 evictLimit 时，按 retention 从低到高淘汰（最先忘的先走），
// 取代原先「无脑 shift 最旧一条」的队列式硬淘汰
function evictOverflow(store, now = Date.now(), opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (!store || !Array.isArray(store.memories)) return 0;
  const overflow = store.memories.length - cfg.evictLimit;
  if (overflow <= 0) return 0;

  const protectedList = [];
  const evictable = [];
  for (const memory of store.memories) {
    if (!memory || typeof memory !== 'object') continue;
    if (isDurable(memory)) protectedList.push(memory);
    else evictable.push(memory);
  }
  if (evictable.length === 0) return 0;

  evictable.sort((a, b) => computeRetention(a, now, cfg) - computeRetention(b, now, cfg));
  const removed = Math.min(overflow, evictable.length);
  const survivors = evictable.slice(removed);

  store.memories = [...protectedList, ...survivors]
    .sort((a, b) => (Number(a && a.timestamp) || 0) - (Number(b && b.timestamp) || 0));
  return removed;
}

// 提取即强化：召回命中的记忆增加 recallCount / salience、刷新 lastRecallAt，并把归档唤醒为情景记忆
function reinforce(memories, now = Date.now(), opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const list = Array.isArray(memories) ? memories : [memories];
  let changed = 0;
  for (const memory of list) {
    if (!memory || typeof memory !== 'object' || isDurable(memory)) continue;
    memory.recallCount = (Number(memory.recallCount) || 0) + 1;
    memory.lastRecallAt = now;
    const base = memory.salience != null ? clamp01(memory.salience) : initialSalience(memory.value);
    memory.salience = Math.min(cfg.reinforceSalienceMax, base + cfg.reinforceSalienceStep);
    if (memory.tier === 'archived') memory.tier = 'episodic';
    changed++;
  }
  return changed;
}

// 遗忘的可观测性：给调参一个只读快照，避免盲调
function lifecycleStats(store, now = Date.now(), opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const memories = store && Array.isArray(store.memories) ? store.memories : [];
  const stats = {
    total: memories.length, episodic: 0, semantic: 0, archived: 0, atRisk: 0, avgRetention: 0,
    // 上下文额度观测量：额度多大、当前工作集占了多少（>100% 说明下一轮扫描会把最弱的归档）
    budgetTokens: workingSetBudget(cfg),
    workingSetTokens: 0
  };
  let sum = 0;
  let counted = 0;
  for (const memory of memories) {
    if (!memory || typeof memory !== 'object') continue;
    const tier = memory.tier || 'episodic';
    if (tier === 'archived') stats.archived++;
    else if (tier === 'semantic') stats.semantic++;
    else stats.episodic++;
    if (tier !== 'archived') stats.workingSetTokens += estimateTokens(memory, cfg);

    if (isDurable(memory)) continue;
    const retention = computeRetention(memory, now, cfg);
    sum += retention;
    counted++;
    if (retention <= cfg.archiveRetention) stats.atRisk++;
  }
  stats.avgRetention = counted > 0 ? sum / counted : 0;
  return stats;
}

// 只读：取最近 limit 条遗忘留痕（元记忆/反思用），不改动 store
function listTombstones(store, limit = 20) {
  const list = store && Array.isArray(store.tombstones) ? store.tombstones : [];
  const n = Math.max(0, Math.floor(Number(limit)) || 0);
  return n > 0 ? list.slice(-n) : [];
}

module.exports = {
  DEFAULTS,
  isProtected,
  isPinned,
  isDurable,
  clamp01,
  initialSalience,
  stabilityDays,
  computeRetention,
  workingSetBudget,
  estimateTokens,
  callWeight,
  archiveByWorkingSet,
  applyForgetting,
  evictOverflow,
  reinforce,
  lifecycleStats,
  listTombstones
};
