// 🧠 自我模型：反思落地的纯逻辑（不碰 fs / 网络，方便单测）
//
// 对应《类脑记忆生命周期设计方案（v2）》§4.6：把零星的高显著记忆 / 情绪线索，
// 收敛成「关于她自己」的稳定认知条目——记忆 → 语义 → 自我认知 → 影响下一次行为。
//
// 本文件只负责「条目的规范化、去重合并、注入挑选、模型输出解析」；
// 真正的 LLM 调用与周期编排在 output.js（复用 archiveDigestChain 同用户串行），
// 灰度落地在 emotionLedger.js，落库在 memory.js（data/self_model/{key}.json）。

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  maxTraits: 12,            // 单用户最多保留多少条自我认知（防无限膨胀）
  injectLimit: 3,           // 注入提示词时最多几条（与 §七「严格限条」一致）
  dedupeSimilarity: 0.6,    // bigram Dice ≥ 此值视为同一条，合并取新
  minConfidence: 0.35,      // 低于此置信度不注入（但保留在库里）
  defaultConfidence: 0.6,   // 无置信度时的默认值
  maxTraitLen: 60,
  maxSourceIds: 5,          // 单条认知最多记几条来源记忆 id（可追溯用）
  useCap: 20,               // 使用计数上限（maturity 的对数拐点，防单条线性碾压）
  halfLifeDays: 14,         // 成熟度半衰期（天）：闲置多久成熟度衰减到一半
  maturityFloor: 0.5,       // 新条目底子：未分化也留一半成熟度，保证至少被注入一次
  leaseTtlMs: 30 * DAY_MS,  // 租约有效期：超过则「过期」，不再注入（最迟回源重算）
  minMaturity: 0.2          // 成熟度下限：萎到「出厂设置」后不再注入
};

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

// 去掉标点/空白后数有效字符（与 memory.js / memoryConsolidation 同款判定）
function effectiveLen(text) {
  return String(text || '').replace(/[\s\p{P}，。！？、~…“”‘’（）()【】《》,.!?;:'"…·-]/gu, '').length;
}

// 相邻两字片段集合（去标点空白后再切）
function bigrams(text) {
  const clean = String(text || '').replace(/[\s\p{P}，。！？、~…“”‘’（）()【】《》,.!?;:'"…·-]/gu, '');
  const grams = new Set();
  for (let i = 0; i < clean.length - 1; i++) {
    grams.add(clean.slice(i, i + 2));
  }
  if (grams.size === 0 && clean.length > 0) grams.add(clean);
  return grams;
}

// Dice 系数：2|A∩B| / (|A|+|B|)，两段文本字面重合度，∈[0,1]
function diceSimilarity(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const gram of small) {
    if (large.has(gram)) inter++;
  }
  return (2 * inter) / (a.size + b.size);
}

// 剥掉整体包裹的引号/书名号、行首列表前缀
function stripDecoration(text) {
  return String(text || '')
    .replace(/^[“"'「『]+/, '')
    .replace(/[”"'」』]+$/, '')
    .replace(/^(?:[-*·]|\d+[.、)])\s*/, '')
    .trim();
}

// 来源记忆 id：可追溯「这条自我认知是从哪几条记忆提炼出来的」（哲学 §1.9③）。
// 去重、限长、最多 5 条；非法输入一律当空
function normalizeSourceIds(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const id = String(item == null ? '' : item).trim().slice(0, 64);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= DEFAULTS.maxSourceIds) break;
  }
  return out;
}

// 规范化一条自我认知条目：正文有效、置信度夹到 [0,1]、补齐时间与来源。不合法返回 null
function normalizeTrait(input) {
  const source = input && typeof input === 'object' ? input : {};
  let text = typeof source.text === 'string' ? source.text.trim().replace(/\s+/g, ' ') : '';
  text = stripDecoration(text);
  if (!text || effectiveLen(text) < 4) return null;
  if (text.length > DEFAULTS.maxTraitLen) text = text.slice(0, DEFAULTS.maxTraitLen);
  return {
    text,
    confidence: clamp01(source.confidence != null ? Number(source.confidence) : DEFAULTS.defaultConfidence),
    source: source.source != null ? String(source.source) : null,
    sourceIds: normalizeSourceIds(source.sourceIds),
    updatedAt: Number(source.updatedAt) || Date.now(),
    useCount: Math.max(0, Math.floor(Number(source.useCount)) || 0),   // 被注入过多少次
    lastUsedAt: Number(source.lastUsedAt) || 0                        // 最近一次被注入的时间
  };
}

// 把新条目并进现有列表：字面相近（bigram Dice ≥ 阈值）的算同一条，取新覆盖旧的；
// 否则追加。最后按置信度+时间降序限条，超出的淘汰置信度最低、最旧的。
// 返回 { traits, merged }：merged=true 表示命中了已有条目做了合并
function mergeTrait(traits, trait, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const list = (Array.isArray(traits) ? traits : []).filter(Boolean).slice();
  if (!trait) return { traits: list, merged: false };

  const grams = bigrams(trait.text);
  const index = list.findIndex(item => diceSimilarity(grams, bigrams(item.text)) >= cfg.dedupeSimilarity);
  const merged = index >= 0;
  if (merged) {
    // 同一条：正文/来源取新，但「使用痕迹」累积——继承较大 useCount、取较新 lastUsedAt；
    // 来源记忆取并集，保证合并后仍能追到最早那条的依据
    const prev = list[index] || {};
    list[index] = {
      ...trait,
      sourceIds: normalizeSourceIds([...(trait.sourceIds || []), ...(prev.sourceIds || [])]),
      useCount: Math.max(Number(trait.useCount) || 0, Number(prev.useCount) || 0),
      lastUsedAt: Math.max(Number(trait.lastUsedAt) || 0, Number(prev.lastUsedAt) || 0)
    };
  } else {
    list.push({ ...trait });
  }
  list.sort((a, b) => {
    const diff = clamp01(b.confidence) - clamp01(a.confidence);
    if (diff !== 0) return diff;
    return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
  });
  return { traits: list.slice(0, Math.max(1, cfg.maxTraits)), merged };
}

// 取条目最近一次「被碰到」的时间：优先 lastUsedAt，缺失回落 updatedAt
function traitTouchAt(trait) {
  const t = trait && typeof trait === 'object' ? trait : {};
  return Number(t.lastUsedAt) || Number(t.updatedAt) || 0;
}

// 成熟度（派生量，不落盘）：用进废退
//   用得多 → useNorm↑ → 长开；闲置久 → recency↓ → 萎缩
//   base = confidence × (floor + (1-floor)×useNorm)  ∈ [floor×conf, conf]
function computeTraitMaturity(trait, now = Date.now(), opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const t = normalizeTrait(trait);
  if (!t) return 0;
  const cap = Math.max(1, Number(cfg.useCap) || 1);
  const useNorm = Math.log1p(Math.min(t.useCount, cap)) / Math.log1p(cap);   // ∈ [0,1]
  const floor = clamp01(cfg.maturityFloor);
  const base = t.confidence * (floor + (1 - floor) * useNorm);
  const idleMs = Math.max(0, Number(now) - traitTouchAt(t));
  const halfLifeMs = Math.max(1, Number(cfg.halfLifeDays) || 1) * DAY_MS;
  const recency = Math.pow(0.5, idleMs / halfLifeMs);   // 真·半衰：闲置一个半衰期恰好衰减一半
  return clamp01(base * recency);
}

// 租约是否仍在有效期内（时钟回拨 / 无时间信息时保守判「活」）
function isTraitLeaseAlive(trait, now = Date.now(), opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const t = normalizeTrait(trait);
  if (!t) return false;
  const touchAt = traitTouchAt(t);
  if (!touchAt) return true;
  return (Number(now) - touchAt) < Math.max(0, Number(cfg.leaseTtlMs) || 0);
}

// 记一次「使用」：useCount+1、刷新 lastUsedAt（续租）。不可变风格，方便单测
function touchTrait(trait, now = Date.now()) {
  const t = normalizeTrait(trait);
  if (!t) return null;
  return {
    ...t,
    useCount: Math.max(0, Math.floor(Number(t.useCount)) || 0) + 1,
    lastUsedAt: Number(now) || Date.now()
  };
}

// 注入挑选：过滤低置信 → 排序 → 取前 limit 条纯文本
//   lifecycle==='live' 时：先按租约/成熟度过筛，再按 成熟度→置信度→时间 降序（用进废退）
//   否则：保持既有 置信度→时间 降序（逐字节与旧行为一致）
function selectForInjection(traits, limit = DEFAULTS.injectLimit, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const max = Number.isFinite(limit) ? limit : cfg.injectLimit;
  const items = (Array.isArray(traits) ? traits : [])
    .map(normalizeTrait)
    .filter(Boolean)
    .filter(item => item.confidence >= cfg.minConfidence);

  let ranked;
  if (cfg.lifecycle === 'live') {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    ranked = items
      .filter(item => isTraitLeaseAlive(item, now, cfg))
      .map(item => ({ item, maturity: computeTraitMaturity(item, now, cfg) }))
      .filter(entry => entry.maturity >= cfg.minMaturity)
      .sort((a, b) => {
        const diff = b.maturity - a.maturity;
        if (diff !== 0) return diff;
        const conf = b.item.confidence - a.item.confidence;
        if (conf !== 0) return conf;
        return (Number(b.item.updatedAt) || 0) - (Number(a.item.updatedAt) || 0);
      })
      .map(entry => entry.item);
  } else {
    ranked = items.sort((a, b) => {
      const diff = b.confidence - a.confidence;
      if (diff !== 0) return diff;
      return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
    });
  }

  return ranked.slice(0, Math.max(0, max)).map(item => item.text);
}

// 解析模型返回的自我认知：允许多行，一行一条；去围栏/引号/列表前缀，拒绝 JSON 与过短
function parseSelfTraitOutput(raw) {
  if (typeof raw !== 'string') return [];
  const text = raw.replace(/```[a-zA-Z]*/g, '').trim();
  if (!text || /^[[{]/.test(text)) return [];
  return text
    .split(/\r?\n/)
    .map(line => stripDecoration(line.trim()))
    // 界线行与结账行走的是另外两套格式，别当成自我认知收进来
    .filter(line => line && !/^(?:界线|结账)\s*[:：]/.test(line))
    .filter(line => line && effectiveLen(line) >= 4)
    .slice(0, 5)
    .map(line => (line.length > DEFAULTS.maxTraitLen ? line.slice(0, DEFAULTS.maxTraitLen) : line));
}

// 🚧 界线（事前自限）：用来区分「演化的痕迹」和「漂移」。
// 哲学判据只有一条——痕迹必须能在下一次同类情境里看见它对行为的约束，否则只是解释。
// 所以每条界线必须带两样可核对的字段：
//   trigger：什么情境算「同类」，决定这条界线这一轮该不该被带进视野；
//   avoid  ：她不该说出口的具体片段，发言后做字面核对（出现=违背，没出现=兑现）。
// 兑现过 ≥1 次才算真的长出来了。
// 但「窗口内一次都没兑现」不能静默退场——那等于受不了被量就把尺子撤了。
// 所以到点先进「结账期」：必须由她自己说清哪次没做到、怎么补救，再宣告新尺与生效点；
// 结账期到点仍不结账，才留一条 unclosed 的退场记录（可审计，不是悄悄消失）。
const BOUNDARY_DEFAULTS = {
  maxBoundaries: 8,
  injectLimit: 2,
  probationMs: 2 * DAY_MS,
  dropMs: 3 * DAY_MS,
  closeGraceMs: 7 * DAY_MS,
  closeNoteMaxLen: 120,
  maxTextLen: 80,
  maxTrigger: 4,
  maxAvoid: 3
};

// 结账结论：保留（尺没坏，是我没做到）/ 收紧（尺要改窄）/ 撤销（旧尺不再成立，立新尺）
const BOUNDARY_RESOLUTIONS = ['kept', 'revised', 'dropped'];

function normalizePhraseList(raw, max) {
  return (Array.isArray(raw) ? raw : [])
    .map(item => String(item == null ? '' : item).replace(/^[“"'「『]+|[”"'」』]+$/g, '').trim())
    .filter(Boolean)
    .slice(0, max);
}

// 规范化一条界线：正文、触发词、禁止片段缺一不可——没有可核对的禁止片段就不算界线，
// 那只是又一句自我描述（本文件上半部分的 traits 已经管这件事了）
function normalizeBoundary(input) {
  const source = input && typeof input === 'object' ? input : {};
  let text = stripDecoration(typeof source.text === 'string' ? source.text : '');
  if (!text || effectiveLen(text) < 4) return null;
  if (text.length > BOUNDARY_DEFAULTS.maxTextLen) text = text.slice(0, BOUNDARY_DEFAULTS.maxTextLen);
  const trigger = normalizePhraseList(source.trigger, BOUNDARY_DEFAULTS.maxTrigger);
  const avoid = normalizePhraseList(source.avoid, BOUNDARY_DEFAULTS.maxAvoid)
    .filter(item => effectiveLen(item) >= 2);
  if (avoid.length === 0) return null;
  return {
    text,
    trigger,
    avoid,
    confidence: clamp01(source.confidence != null ? Number(source.confidence) : DEFAULTS.defaultConfidence),
    createdAt: Number(source.createdAt) || Date.now(),
    honoredCount: Math.max(0, Math.floor(Number(source.honoredCount)) || 0),
    violatedCount: Math.max(0, Math.floor(Number(source.violatedCount)) || 0),
    lastCheckedAt: Number(source.lastCheckedAt) || 0,
    // 结账三件套：进入结账期的时间、结账结论、她结账时说的原话片段
    closingAt: Number(source.closingAt) || 0,
    closedAt: Number(source.closedAt) || 0,
    resolution: BOUNDARY_RESOLUTIONS.includes(source.resolution) ? source.resolution : '',
    closeNote: typeof source.closeNote === 'string'
      ? source.closeNote.slice(0, BOUNDARY_DEFAULTS.closeNoteMaxLen)
      : '',
    droppedAt: Number(source.droppedAt) || 0,
    // 结账期到点仍未结账就退场：这条不是「合法撤尺」，是「她没能面对」，单独留痕
    unclosed: Boolean(source.unclosed)
  };
}

// 并入一条界线：正文相近即同一条（取新的，但兑现/违背次数取大，不因覆盖丢账）
function mergeBoundary(boundaries, boundary, opts = {}) {
  const cfg = { ...BOUNDARY_DEFAULTS, ...opts };
  const list = (Array.isArray(boundaries) ? boundaries : []).filter(Boolean).slice();
  if (!boundary) return { boundaries: list, merged: false };
  const grams = bigrams(boundary.text);
  const index = list.findIndex(item => diceSimilarity(grams, bigrams(item.text)) >= DEFAULTS.dedupeSimilarity);
  const merged = index >= 0;
  if (merged) {
    const prev = list[index] || {};
    list[index] = {
      ...boundary,
      createdAt: Math.min(Number(prev.createdAt) || boundary.createdAt, boundary.createdAt),
      honoredCount: Math.max(Number(prev.honoredCount) || 0, boundary.honoredCount),
      violatedCount: Math.max(Number(prev.violatedCount) || 0, boundary.violatedCount),
      lastCheckedAt: Math.max(Number(prev.lastCheckedAt) || 0, boundary.lastCheckedAt),
      // 结账状态不能被一次重新反思冲掉：她结过的账是历史，不是可覆盖的当前值
      closingAt: Number(prev.closingAt) || 0,
      closedAt: Math.max(Number(prev.closedAt) || 0, Number(boundary.closedAt) || 0),
      resolution: boundary.resolution || prev.resolution || '',
      closeNote: boundary.closeNote || prev.closeNote || '',
      unclosed: Boolean(prev.unclosed)
    };
  } else {
    list.push({ ...boundary });
  }
  list.sort((a, b) => {
    const hon = (b.honoredCount || 0) - (a.honoredCount || 0);
    if (hon !== 0) return hon;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  return { boundaries: list.slice(0, Math.max(1, cfg.maxBoundaries)), merged };
}

// 到点判定的三段：观察期 → 结账期 → （仍未结账才）退场。
// 静默退场就是撤尺；合法撤尺必须先结旧账，所以中间多一道 closing 状态。
function retireBoundaries(boundaries, now = Date.now(), opts = {}) {
  const cfg = { ...BOUNDARY_DEFAULTS, ...opts };
  const t = Number(now) || Date.now();
  let closing = 0;
  let retired = 0;
  const next = (Array.isArray(boundaries) ? boundaries : [])
    .map(item => normalizeBoundary(item))
    .filter(Boolean)
    .map(item => {
      if (item.droppedAt) return item;
      // 兑现过、或已经结过账（保留/收紧）→ 这条尺立住了，不再走退场流程
      if (item.honoredCount > 0 || item.resolution) return item;
      // 观察期还没过：给一次机会
      if (!item.closingAt) {
        if (t - item.createdAt < cfg.dropMs) return item;
        closing++;
        return { ...item, closingAt: t };
      }
      // 结账期过了还没结账：可以退场，但要留一条「她没能面对」的痕迹，不是悄悄消失
      if (t - item.closingAt >= cfg.closeGraceMs) {
        retired++;
        return { ...item, droppedAt: t, unclosed: true };
      }
      return item;
    });
  return { boundaries: next, closing, retired };
}

// 结账：她点名一条界线，说清哪次没做到、怎么补救，然后给结论。
// 只有走完这一步，界线才可以被撤销；撤销之后再立的新尺是另一条，旧账仍留在旧条目里
function closeBoundary(boundaries, text, opts = {}) {
  const cfg = { ...BOUNDARY_DEFAULTS, ...opts };
  const list = (Array.isArray(boundaries) ? boundaries : []).map(item => normalizeBoundary(item)).filter(Boolean);
  const wanted = stripDecoration(String(text == null ? '' : text)).trim();
  const resolution = BOUNDARY_RESOLUTIONS.includes(opts.resolution) ? opts.resolution : '';
  if (!wanted || !resolution) return { boundaries: list, closed: null };
  const now = Number(opts.now) || Date.now();
  const note = String(opts.note == null ? '' : opts.note).trim().slice(0, cfg.closeNoteMaxLen);
  // 先按原文精确匹配；模型复述可能差几个字，退回字面相似
  let index = list.findIndex(item => item.text === wanted);
  if (index < 0) {
    const grams = bigrams(wanted);
    index = list.findIndex(item => diceSimilarity(grams, bigrams(item.text)) >= DEFAULTS.dedupeSimilarity);
  }
  if (index < 0) return { boundaries: list, closed: null };
  const closed = {
    ...list[index],
    resolution,
    closeNote: note,
    closingAt: Number(list[index].closingAt) || now,
    closedAt: now,
    droppedAt: resolution === 'dropped' ? now : (Number(list[index].droppedAt) || 0)
  };
  list[index] = closed;
  return { boundaries: list, closed };
}

// 注入挑选：只看「同类情境」——触发词命中本轮输入（或没有输入时留给主动开口）。
// 排序：待结账的最优先（必须先把旧账说清），其次命中情境的，再按兑现次数与时间。
// 观察期内的新界线也给一次机会；已退场的（含 unclosed）不再带进视野。
function selectBoundariesForInjection(boundaries, { now = Date.now(), query = '', limit = BOUNDARY_DEFAULTS.injectLimit } = {}) {
  const q = String(query || '');
  const t = Number(now) || Date.now();
  const items = (Array.isArray(boundaries) ? boundaries : [])
    .map(item => normalizeBoundary(item))
    .filter(Boolean)
    .filter(item => !item.droppedAt)
    .filter(item => item.honoredCount > 0 || item.closingAt || (t - item.createdAt) <= BOUNDARY_DEFAULTS.probationMs)
    .map(item => {
      const matched = q && item.trigger.some(word => word && q.includes(word));
      // 待结账的条目即使触发词没命中也要带上：她欠的账不能因为这一轮没聊到就消失
      const pendingClose = item.closingAt && !item.resolution;
      return { item, pendingClose: pendingClose ? 1 : 0, matched: matched ? 1 : 0 };
    })
    .filter(entry => entry.pendingClose === 1 || entry.matched === 1 || !q)
    .sort((a, b) => {
      if (b.pendingClose !== a.pendingClose) return b.pendingClose - a.pendingClose;
      if (b.matched !== a.matched) return b.matched - a.matched;
      const hon = (b.item.honoredCount || 0) - (a.item.honoredCount || 0);
      if (hon !== 0) return hon;
      return (b.item.createdAt || 0) - (a.item.createdAt || 0);
    });
  return items.slice(0, Math.max(0, Number(limit) || 0)).map(entry => entry.item);
}

// 解析结账行：`结账：<界线原文>｜结论：保留/收紧/撤销｜做到：<哪次没做到、怎么补救>`
// 与界线行分开认：结账是「对一条已经存在的界线做处置」，不从零生成新的
function parseBoundaryCloseOutput(raw) {
  if (typeof raw !== 'string') return [];
  const RESOLUTION_MAP = { 保留: 'kept', 收紧: 'revised', 撤销: 'dropped', 撤掉: 'dropped', 删掉: 'dropped' };
  const out = [];
  raw.replace(/```[a-zA-Z]*/g, '').split(/\r?\n/).forEach(line => {
    const text = line.trim();
    if (!text || !/结账/.test(text)) return;
    const body = text.replace(/^(?:[-*·]|\d+[.、)])\s*/, '').replace(/^结账\s*[:：]\s*/, '').trim();
    const parts = body.split(/[｜|]/).map(seg => seg.trim()).filter(Boolean);
    if (parts.length < 2) return;
    let resolution = '';
    let note = '';
    parts.slice(1).forEach(seg => {
      const verdict = /^(?:结论|处置)\s*[:：]\s*(.*)$/.exec(seg);
      if (verdict) resolution = RESOLUTION_MAP[verdict[1].trim()] || '';
      const done = /^(?:做到|补救|结清)\s*[:：]\s*(.*)$/.exec(seg);
      if (done) note = done[1].trim();
    });
    if (!resolution || !parts[0]) return;
    out.push({ text: parts[0], resolution, note });
  });
  return out.slice(0, 2);
}

// 解析模型产出的界线行：`界线：<一句话>｜触发：<词1,词2>｜不说：<片段1,片段2>`
// 只认这一种格式——宽格式必然被写成又一段自我描述，那就不再有可核对性
function parseBoundaryOutput(raw) {
  if (typeof raw !== 'string') return [];
  const out = [];
  raw.replace(/```[a-zA-Z]*/g, '').split(/\r?\n/).forEach(line => {
    const text = line.trim();
    if (!text || !/界线/.test(text)) return;
    const body = text.replace(/^(?:[-*·]|\d+[.、)])\s*/, '').replace(/^界线\s*[:：]\s*/, '').trim();
    const parts = body.split(/[｜|]/).map(seg => seg.trim()).filter(Boolean);
    if (parts.length < 3) return;
    let trigger = [];
    let avoid = [];
    parts.slice(1).forEach(seg => {
      const trig = /^(?:触发|情境)\s*[:：]\s*(.*)$/.exec(seg);
      if (trig) trigger = trig[1].split(/[,，、\s/]+/).filter(Boolean);
      const ban = /^(?:不说|不做|禁止)\s*[:：]\s*(.*)$/.exec(seg);
      if (ban) avoid = ban[1].split(/[,，、]+/).filter(Boolean);
    });
    const boundary = normalizeBoundary({ text: parts[0], trigger, avoid, source: 'reflect' });
    if (boundary) out.push(boundary);
  });
  return out.slice(0, 3);
}

// 读取旧 JSON 时归一整份自我模型，保证老档 / 坏档不报错
function normalizeModel(parsed) {
  const source = parsed && typeof parsed === 'object' ? parsed : {};
  const traits = Array.isArray(source.traits)
    ? source.traits.map(normalizeTrait).filter(Boolean)
    : [];
  const boundaries = Array.isArray(source.boundaries)
    ? source.boundaries.map(normalizeBoundary).filter(Boolean)
    : [];
  return {
    version: 1,
    updatedAt: Number(source.updatedAt) || 0,
    traits,
    boundaries
  };
}

module.exports = {
  DEFAULTS,
  clamp01,
  effectiveLen,
  bigrams,
  diceSimilarity,
  normalizeTrait,
  mergeTrait,
  computeTraitMaturity,
  isTraitLeaseAlive,
  touchTrait,
  selectForInjection,
  parseSelfTraitOutput,
  normalizeModel,
  BOUNDARY_DEFAULTS,
  BOUNDARY_RESOLUTIONS,
  normalizeBoundary,
  mergeBoundary,
  retireBoundaries,
  closeBoundary,
  selectBoundariesForInjection,
  parseBoundaryOutput,
  parseBoundaryCloseOutput
};
