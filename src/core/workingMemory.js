// 🧠 L1 工作记忆（短时记忆）：纯逻辑，不碰 fs / 网络 / prompt 文案。
//
// 依据：Cowan (2001) 容量约 4 个 chunk；Peterson & Peterson (1959) 无复述十几秒即忘；
// Brown-Peterson 表明短时遗忘主因是**干扰**而非单纯衰退；Craik & Lockhart (1972)
// 加工越深越耐久——所以「是不是话题、有没有共享 tag」会影响彼此权重。
//
// 职责边界：只回答「此刻哪几块还活跃、按什么顺序进场」。
// 真正的落库（情景/语义）仍由 memory.js 负责，晋升门槛也放在调用方。
//
// 接线状态：**未接入运行时**。按角色哲学「器官层是唯一持有状态的地方，表达层只读消费」，
// 活动块账本不能挂在 OutputModule 上（否则等于表达层持状态，且与 memory.js 的 R9
// 召回不应期方向相反）。当前只有纯函数 arrangePrimacyRecency 被 output.js 用于注入排序；
// 类本身留给未来 CIDE GlobalWorkspace 复用，不单独落盘。

const DEFAULT_CAPACITY = 4;      // 4±1 个 chunk
const DEFAULT_TTL_TURNS = 3;     // 连续 3 轮没被提及才淘汰（不是按秒，按交互轮次）
const DEFAULT_INTERFERENCE = 0.8; // 同 tag 话题互相干扰的权重衰减系数
const MIN_WEIGHT = 0.05;         // 干扰衰减的下限，避免直接归零

const clamp01 = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
};

const round4 = (x) => Number(x.toFixed(4));

// 把「已按重要度降序」的列表重排成首因/近因友好的顺序：
// 最强在首、次强在尾，其余按重要度升序填中间。长度 ≤2 时原样返回。
function arrangePrimacyRecency(sortedDesc) {
  const list = Array.isArray(sortedDesc) ? sortedDesc : [];
  if (list.length <= 2) return [...list];
  const [head, ...rest] = list;
  return [head, ...rest.reverse()];
}

class WorkingMemory {
  constructor({ capacity = DEFAULT_CAPACITY, ttlTurns = DEFAULT_TTL_TURNS, interferenceFactor = DEFAULT_INTERFERENCE } = {}) {
    this.capacity = Number.isInteger(capacity) ? Math.max(0, capacity) : DEFAULT_CAPACITY;
    this.ttlTurns = Number.isInteger(ttlTurns) ? Math.max(0, ttlTurns) : DEFAULT_TTL_TURNS;
    this.interferenceFactor = clamp01(interferenceFactor);
    this.turn = 0;
    this._slots = new Map(); // key -> slot
    this._seq = 0;           // 入槽顺序，用于同权同时间时的淘汰兜底
  }

  // 提及一块记忆：已存在则续命（mentions+1、刷新 lastTurn），否则尝试入槽。
  // 新话题入槽时，会对同 tag 的旧话题施加干扰衰减。
  mention(key, { kind = 'topic', label = '', weight = 0.5, tags = [], text = '', tier = '', ts = 0 } = {}) {
    const k = key == null ? '' : String(key).trim();
    if (!k) return null;

    const existing = this._slots.get(k);
    if (existing) {
      existing.mentions += 1;
      existing.lastTurn = this.turn;
      // 续命只加不减：这次权重低，不该把之前的高权重冲掉
      existing.weight = Math.max(existing.weight, clamp01(weight));
      if (label) existing.label = String(label);
      if (text) existing.text = String(text);
      if (tier) existing.tier = String(tier);
      if (Number(ts) > 0) existing.ts = Number(ts);
      return existing;
    }

    if (this.capacity <= 0) return null;

    const slot = {
      key: k,
      kind: String(kind || 'topic'),
      label: label ? String(label) : '',
      weight: clamp01(weight),
      mentions: 1,
      lastTurn: this.turn,
      tags: Array.isArray(tags) ? tags.map(t => String(t)).filter(Boolean) : [],
      text: text ? String(text) : '',
      tier: tier ? String(tier) : '',
      ts: Number(ts) > 0 ? Number(ts) : 0,
      order: this._seq++
    };
    this._slots.set(k, slot);
    this._applyInterference(slot);
    this._evictOverflow();
    return slot;
  }

  // 推进轮次并淘汰超时块；返回淘汰掉的 key 列表（调用方可据此记日志）
  tick(steps = 1) {
    const n = Math.max(1, Math.floor(Number(steps) || 1));
    this.turn += n;
    const expired = [];
    for (const [key, slot] of this._slots) {
      if (this.turn - slot.lastTurn > this.ttlTurns) {
        this._slots.delete(key);
        expired.push(key);
      }
    }
    return expired;
  }

  // 当前活跃块，按权重降序（同权按更近提及优先，再按入槽顺序）
  slots() {
    return [...this._slots.values()].sort((a, b) =>
      (b.weight - a.weight)
      || (b.lastTurn - a.lastTurn)
      || (a.order - b.order)
    ).map(s => ({ ...s, tags: [...s.tags], weight: round4(s.weight) }));
  }

  // 进场顺序（首因/近因）：最强的放首位、次强的放末尾，其余按权重升序填中间。
  // 序列位置效应：开头和结尾的条目回忆率最高，中间最容易被淹没。
  ordered() {
    return arrangePrimacyRecency(this.slots());
  }

  clear() {
    this._slots.clear();
  }

  // 同 tag 的话题互相干扰：新话题进入时，已存在的话题权重按系数衰减
  _applyInterference(newSlot) {
    if (newSlot.kind !== 'topic' || newSlot.tags.length === 0) return;
    for (const slot of this._slots.values()) {
      if (slot === newSlot || slot.kind !== 'topic') continue;
      if (!slot.tags.some(tag => newSlot.tags.includes(tag))) continue;
      slot.weight = round4(Math.max(MIN_WEIGHT, slot.weight * this.interferenceFactor));
    }
  }

  // 超容量：淘汰权重最低的；同权淘汰更久未提及的；再同则淘汰最早入槽的
  _evictOverflow() {
    while (this._slots.size > this.capacity) {
      let worst = null;
      for (const slot of this._slots.values()) {
        if (!worst) { worst = slot; continue; }
        if (slot.weight < worst.weight) { worst = slot; continue; }
        if (slot.weight === worst.weight && slot.lastTurn < worst.lastTurn) { worst = slot; continue; }
        if (slot.weight === worst.weight && slot.lastTurn === worst.lastTurn && slot.order < worst.order) worst = slot;
      }
      if (!worst) break;
      this._slots.delete(worst.key);
    }
  }
}

module.exports = {
  WorkingMemory,
  arrangePrimacyRecency,
  DEFAULT_CAPACITY,
  DEFAULT_TTL_TURNS,
  DEFAULT_INTERFERENCE
};
