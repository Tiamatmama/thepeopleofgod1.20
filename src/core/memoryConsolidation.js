// 🧠 记忆巩固：情景 → 语义（纯逻辑，不碰 fs / 网络，方便单测）
//
// 对应《类脑记忆生命周期设计方案（v2）》§4.5：把一串「同一件事」的情景记忆
// （episodic，用户原话）抽象成一条可复用的语义结论（semantic，第一人称/关系视角）。
//
// 本文件只负责「怎么挑、怎么分组、怎么解析模型输出」；真正的 LLM 调用与写库
// 编排在 output.js（复用 archiveDigestChain 同用户串行），落库在 memory.js。
//
// 粒度修正（硬伤 H3）：分组不走不稳定的 topicId，走**语义簇**——有 Qdrant 向量就
// 用向量近邻聚类，没有向量就退化为「字面 bigram 相似」粗分组。

const memoryLifecycle = require('./memoryLifecycle');

// 可标定参数
const DEFAULTS = {
  minClusterSize: 3,       // 一个语义簇至少几条情景记忆才值得抽象（太少会以偏概全）
  maxCandidates: 12,       // 单次最多取多少条候选喂给分组（控制开销）
  minSalience: 0.35,       // 只巩固「有点分量」的记忆，纯中性闲聊不值得沉淀为语义
  vectorSimThreshold: 0.80, // 向量余弦相似度达到此值才算同一语义簇
  lexicalSimThreshold: 0.30, // 无向量时的字面 bigram Dice 相似度阈值
  maxClustersPerRun: 2     // 单次最多巩固几个簇（防止一次刷出一堆语义记忆）
};

// 语义结论正文长度上限（超出截断，避免模型夹带解释膨胀提示词）
const MAX_SEMANTIC_LEN = 120;

// 去掉标点/空白后数有效字符（与 memory.js / memoryVectorStore 同款判定）
function effectiveLen(text) {
  return String(text || '').replace(/[\s\p{P}，。！？、~…“”‘’（）()【】《》,.!?;:'"…·-]/gu, '').length;
}

function textOf(memory) {
  return String((memory && memory.data) || '').trim();
}

// 是否为「可被巩固」的情景记忆：
//   - tier 必须是 episodic（semantic 不再重复巩固；archived 已经淡出，不回收）
//   - 没有被巩固过（consolidatedInto 空）
//   - 不是系统生成条目（正文以【开头，如滚动归档摘要）
//   - 有效字符足够长（排掉「嗯」「好啦」这类语气词）
//   - 模态：文本 + 视觉/屏幕（阶段 4 汇入，都是文字总结）可巩固；其余模态暂不处理
function isConsolidationCandidate(memory) {
  if (!memory || typeof memory.data !== 'string') return false;
  const tier = memory.tier || 'episodic';
  if (tier !== 'episodic') return false;
  if (memory.consolidatedInto) return false;
  const text = memory.data.trim();
  if (text.startsWith('【')) return false;
  if (effectiveLen(text) < 4) return false;
  const modality = memory.modality || 'text';
  if (modality !== 'text' && modality !== 'vision' && modality !== 'screen') return false;
  return true;
}

// 记忆显著性：已有 salience 就用，老数据缺字段时按 value 推初值兜底
function salienceOf(memory) {
  if (memory && memory.salience != null && Number.isFinite(Number(memory.salience))) {
    return memoryLifecycle.clamp01(memory.salience);
  }
  return memoryLifecycle.initialSalience(memory && memory.value);
}

// 挑选候选：过滤 → 按 salience（显著性）降序、同分按时间新→旧 → 截断
function selectCandidates(memories, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const list = Array.isArray(memories) ? memories : [];
  return list
    .filter(isConsolidationCandidate)
    .filter(memory => salienceOf(memory) >= cfg.minSalience)
    .sort((a, b) => {
      const diff = salienceOf(b) - salienceOf(a);
      if (diff !== 0) return diff;
      return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
    })
    .slice(0, Math.max(0, cfg.maxCandidates));
}

// 相邻两字片段集合（去掉标点空白后再切）
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

// 余弦相似度（Qdrant embedding 是 Cosine 距离，这里对齐同一度量）
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// 贪心聚类：逐条与已有簇的「代表」比相似度，够像就并入，否则另起新簇。
// 返回 [[item, ...], ...]，保持输入顺序
function greedyCluster(items, similar, threshold) {
  const clusters = [];
  for (const item of items) {
    let placed = false;
    for (const cluster of clusters) {
      if (similar(item, cluster.rep) >= threshold) {
        cluster.items.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ rep: item, items: [item] });
  }
  return clusters.map(cluster => cluster.items);
}

// 有向量可用时：先按向量余弦贪心聚类；没有向量的条目再尝试按字面相似并入已有簇
function clusterByVectors(items, vectors, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const vectorOf = new Map();
  items.forEach((item, index) => {
    const vector = vectors && vectors[index];
    if (Array.isArray(vector) && vector.length > 0) vectorOf.set(item, vector);
  });

  const withVector = items.filter(item => vectorOf.has(item));
  const withoutVector = items.filter(item => !vectorOf.has(item));

  const clusters = [];
  for (const item of withVector) {
    const vector = vectorOf.get(item);
    let placed = false;
    for (const cluster of clusters) {
      if (cosineSimilarity(vector, vectorOf.get(cluster.rep)) >= cfg.vectorSimThreshold) {
        cluster.items.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ rep: item, items: [item] });
  }

  for (const item of withoutVector) {
    const grams = bigrams(textOf(item));
    let placed = false;
    for (const cluster of clusters) {
      if (diceSimilarity(grams, bigrams(textOf(cluster.rep))) >= cfg.lexicalSimThreshold) {
        cluster.items.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ rep: item, items: [item] });
  }

  return clusters.map(cluster => cluster.items);
}

// 无向量时：纯字面 bigram Dice 贪心聚类
function clusterByText(items, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  return greedyCluster(
    items,
    (a, b) => diceSimilarity(bigrams(textOf(a)), bigrams(textOf(b))),
    cfg.lexicalSimThreshold
  );
}

// 统一入口：只要候选里有可用向量就走向量聚类，否则退化字面聚类
function clusterCandidates(items, vectors, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];
  const hasVector = Array.isArray(vectors) && vectors.some(v => Array.isArray(v) && v.length > 0);
  return hasVector ? clusterByVectors(list, vectors, opts) : clusterByText(list, opts);
}

// 簇权重：以体积为主，平均显著性做 tie-break
function clusterWeight(items) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const total = items.reduce((sum, item) => sum + salienceOf(item), 0);
  return items.length + total / items.length;
}

// 挑选够格的簇：size ≥ minClusterSize，按权重排序，截断 maxClustersPerRun
function pickClusters(clusters, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const eligible = (Array.isArray(clusters) ? clusters : [])
    .filter(cluster => Array.isArray(cluster) && cluster.length >= cfg.minClusterSize)
    .map(cluster => ({ items: cluster, weight: clusterWeight(cluster) }));
  eligible.sort((a, b) => b.weight - a.weight);
  return eligible.slice(0, Math.max(0, cfg.maxClustersPerRun)).map(entry => entry.items);
}

// 🧠 巩固期去重合并（方向一②，dry-run 优先）：把「正文归一化后完全相同的情景记忆」归为可合并组。
// 本组函数**只产出合并计划、不改任何记忆对象本身**——dry-run 阶段只读不写，正式落库由上层
// 按计划执行（保留 sourceMemoryIds 可回滚，沿用 DB-6 溯源机制）。
//
// 起步形态（经 4 设定人格 + 编程沙箱两轮评审确定）：groupBy='contentHash' + similarity='exact'
// ——只合「归一化正文完全相等」的条目：零阈值、二值可判定；阈值型模糊合并暂时挂起。
const DEDUP_DEFAULTS = {
  groupBy: 'contentHash',    // 'contentHash'：按归一化正文分桶（起步形态）；'topicId'：旧的话题号分桶
  similarity: 'exact',       // 'exact'：归一化正文完全相等才算重复；'fuzzy'：阈值型模糊相似
  storeKey: '',              // 归属键（ownerId/scope，通常传存档名）；进分桶键，跨归属绝不合并
  polarityGuard: true,       // 情绪极性硬门槛：正/负/中性分别归桶，极性相反的记忆不合
  minGroupSize: 2,           // 至少两条相同才成组（单条无需合并）
  maxGroups: 10,             // 单次最多产出多少组，控制上层开销
  vectorSimThreshold: 0.92,  // 仅 similarity='fuzzy' 用：向量余弦阈值
  lexicalSimThreshold: 0.68  // 仅 similarity='fuzzy' 用：字面 bigram Dice 阈值
};

// 归一化正文：去空白与标点、转小写。这是判定「完全重复」的唯一口径，写死以保证可复现
function normalizeForDedup(text) {
  return String(text || '')
    .replace(/[\s\p{P}，。！？、~…“”‘’（）()【】《》,.!?;:'"…·-]/gu, '')
    .toLowerCase();
}

// 情绪极性：pos / neg / neu。极性相反的记忆不合并，保住「看着一样、情绪相反」的差别
function polarityOf(memory) {
  const value = Number(memory && memory.value);
  if (!Number.isFinite(value) || value === 0) return 'neu';
  return value > 0 ? 'pos' : 'neg';
}

// 归属键：优先用显式传入的 storeKey；否则退回记忆自带的 userId/ownerId。
// 空串也合法（单档内调用），但绝不允许两个不同归属落进同一分桶键
function ownerKeyOf(memory, cfg) {
  if (cfg.storeKey) return String(cfg.storeKey);
  return String((memory && (memory.userId || memory.ownerId)) || '');
}

// 记忆摘要（报告用）：压掉空白并截断，别把整条原话打进日志
function dedupSnippet(text, max = 40) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// 是否可参与维护（= 去重合并）：episodic、未巩固、非系统条目、内容够实，且未被钉住。
// 把 pinned / semantic / archived / 系统条目 / 已巩固 五处豁免**收敛到这一个谓词**，避免散落各处漏判
function isEligibleForMaintenance(memory) {
  if (!isConsolidationCandidate(memory)) return false; // 已排除 semantic/archived/【/已巩固/过短
  if (memoryLifecycle.isPinned(memory)) return false;  // 用户明确要留的，绝不静默合并掉
  return true;
}

// 两条记忆的相似度：都有向量走余弦，否则退回字面 Dice（与聚类同款度量）
function dedupSimilarity(a, b, vectorMap) {
  const va = vectorMap.get(a);
  const vb = vectorMap.get(b);
  if (va && vb) return cosineSimilarity(va, vb);
  return diceSimilarity(bigrams(textOf(a)), bigrams(textOf(b)));
}

// 组内平均相似度：两两算再平均，给报告一个「这组到底多像」的量化指标
function groupAvgSimilarity(group, vectorMap) {
  const items = Array.isArray(group) ? group : [];
  if (items.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      sum += dedupSimilarity(items[i], items[j], vectorMap);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

// 组内「保留哪一条」：显著性最高 → 更近（新近表述更完整）→ id 最小（写死，保证回滚可复现）
function pickKeep(group) {
  return group.reduce((best, memory) => {
    if (!best) return memory;
    const diff = salienceOf(memory) - salienceOf(best);
    if (diff > 0) return memory;
    if (diff < 0) return best;
    const tDiff = (Number(memory.timestamp) || 0) - (Number(best.timestamp) || 0);
    if (tDiff > 0) return memory;
    if (tDiff < 0) return best;
    return String(memory.id) < String(best.id) ? memory : best;
  }, null);
}

// 分桶键：storeKey::(极性)::(归一化正文 | 话题号)。跨归属 / 跨极性 / 正文不等 → 不同桶
function dedupBucketKey(memory, cfg) {
  const parts = [ownerKeyOf(memory, cfg)];
  if (cfg.polarityGuard) parts.push(polarityOf(memory));
  parts.push(cfg.groupBy === 'topicId' ? String(memory.topicId || '') : normalizeForDedup(textOf(memory)));
  return parts.join('\u0000');
}

// 契约断言：一组内必须同归属（宁可不合，不可跨归属错合）
function sameOwner(items, cfg) {
  const first = ownerKeyOf(items[0], cfg);
  return items.every(memory => ownerKeyOf(memory, cfg) === first);
}

// 合并后的权重：recallCount 求和；salience 取不降（不低于来源最大值，绝不因合并而降权）
function aggregateWeight(items) {
  const recallCount = items.reduce((sum, memory) => sum + (Number(memory.recallCount) || 0), 0);
  const salience = items.reduce((max, memory) => Math.max(max, salienceOf(memory)), 0);
  return { recallCount, salience: Number(salience.toFixed(4)) };
}

// 构造一个合并计划组（只描述「保留谁、并入谁」，不改任何对象本身）
function buildDedupGroup(groupKey, cluster, vectorMap, cfg) {
  const keep = pickKeep(cluster);
  return {
    groupKey,
    storeKey: ownerKeyOf(cluster[0], cfg),
    topicId: cluster[0].topicId != null ? String(cluster[0].topicId) : '',
    keepId: String(keep.id),
    ids: cluster.map(memory => String(memory.id)),
    mergeIds: cluster.filter(memory => memory !== keep).map(memory => String(memory.id)),
    sourceMemoryIds: cluster.map(memory => String(memory.id)), // 合并后据此反查/回滚
    size: cluster.length,
    avgSimilarity: cfg.similarity === 'exact' ? 1 : Number(groupAvgSimilarity(cluster, vectorMap).toFixed(4)),
    mergedWeight: aggregateWeight(cluster),
    samples: cluster.map(memory => ({ id: String(memory.id), text: dedupSnippet(textOf(memory)) }))
  };
}

// 生成去重合并计划（dry-run 核心）。
//   memories 应为「同一用户同一分区」的记忆数组；vectors 为对齐的可选向量数组（仅 fuzzy 用）。
//   返回按（组大小 → 平均相似度）降序排的合并组；不改动入参任何对象。
//   exact 形态下分桶键已含归一化正文，**同桶即视为完全重复**，无需再算相似度
function planDedupMerge(memories, vectors, opts = {}) {
  const cfg = { ...DEDUP_DEFAULTS, ...opts };
  const list = Array.isArray(memories) ? memories : [];
  const vectorMap = new Map();
  list.forEach((memory, index) => {
    const vector = vectors && vectors[index];
    if (Array.isArray(vector) && vector.length > 0) vectorMap.set(memory, vector);
  });

  // 分桶：只纳入可维护条目；topicId 模式下无话题号的不参与
  const buckets = new Map();
  for (const memory of list) {
    if (!isEligibleForMaintenance(memory)) continue;
    if (cfg.groupBy === 'topicId' && !String(memory.topicId || '')) continue;
    const key = dedupBucketKey(memory, cfg);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(memory);
  }

  const groups = [];
  for (const [groupKey, items] of buckets) {
    if (items.length < cfg.minGroupSize) continue;
    if (!sameOwner(items, cfg)) continue; // 契约断言：跨归属一律不合
    const alignedVectors = items.map(memory => vectorMap.get(memory) || null);
    const clusters = cfg.similarity === 'fuzzy'
      ? clusterCandidates(items, alignedVectors, cfg)
      : [items];
    for (const cluster of clusters) {
      if (cluster.length < cfg.minGroupSize) continue;
      groups.push(buildDedupGroup(groupKey, cluster, vectorMap, cfg));
    }
  }

  groups.sort((a, b) => (b.size - a.size) || (b.avgSimilarity - a.avgSimilarity));
  return groups.slice(0, Math.max(0, cfg.maxGroups));
}

// 🧠 巩固期跨话题联想（方向一③ REM，dry-run 优先）：巩固时不止「同一话题内整理」，
// 还跨不同话题找**弱关联**——相似度落在 [minSimilarity, maxSimilarity) 的才叫弱关联：
// 太像的（≥maxSimilarity）其实就是「同一件事」，交给巩固/去重；太不像的视为无关，不联想。
// 与 planDedupMerge 同款契约：**只产出计划、不改任何记忆对象**；每条联想带
// sourceMemoryIds（可溯源/回滚，沿用 DB-6 思路）与 confidence（给上层写联想结论时排序/设阈用）。
// 已灰度接入运行时（output.js runSemanticConsolidation → appendRemAssociations）：落库为
// kind='association' 的联想条，不注入提示词、不占用源记忆，单次最多 1 条，确保不污染既有结论。
const REM_DEFAULTS = {
  minSimilarity: 0.35,   // 低于此值的跨话题对视为无关，不联想（字面 Dice 尺度）
  maxSimilarity: 0.80,   // 达到此值的视为「同一件事」，不是弱关联，交给巩固/去重
  maxAssociations: 4,    // 单次最多产出几条联想
  maxSamples: 4          // 每条联想最多附几个样本（报告体积控制）
};

// 话题对键：两个话题号排序后拼接，保证 (A,B) 与 (B,A) 归到同一键、output 顺序可复现
function topicPairKey(a, b) {
  const x = String(a);
  const y = String(b);
  return x <= y ? `${x}\u0000${y}` : `${y}\u0000${x}`;
}

// 生成跨话题联想计划（dry-run 核心）。
//   memories 应为「同一用户同一分区」的记忆数组；vectors 为对齐的可选向量数组。
//   返回按（confidence → pairCount）降序排的联想组；不改动入参任何对象。
function planRemAssociations(memories, vectors, opts = {}) {
  const cfg = { ...REM_DEFAULTS, ...opts };
  const list = Array.isArray(memories) ? memories : [];
  const vectorMap = new Map();
  list.forEach((memory, index) => {
    const vector = vectors && vectors[index];
    if (Array.isArray(vector) && vector.length > 0) vectorMap.set(memory, vector);
  });

  // 只取「有话题号的可巩固情景记忆」：无话题号无法定义跨话题；已巩固/系统条目/过短也不入
  const pool = list.filter(memory => memory && isConsolidationCandidate(memory)
    && String(memory.topicId || '').trim() !== '');

  // 逐对找「跨话题且落在弱关联带」的记忆对，按话题对聚合
  const pairsByTopic = new Map(); // 话题对键 -> { a, b, pairs: [{ x, y, sim }] }
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const x = pool[i];
      const y = pool[j];
      const tx = String(x.topicId);
      const ty = String(y.topicId);
      if (tx === ty) continue;                                  // 同话题不算跨话题联想
      if (ownerKeyOf(x, cfg) !== ownerKeyOf(y, cfg)) continue;  // 契约断言：跨归属绝不联想
      const sim = dedupSimilarity(x, y, vectorMap);             // 有向量走余弦，否则字面 Dice
      if (sim < cfg.minSimilarity || sim >= cfg.maxSimilarity) continue;
      const key = topicPairKey(tx, ty);
      if (!pairsByTopic.has(key)) {
        pairsByTopic.set(key, { a: tx <= ty ? tx : ty, b: tx <= ty ? ty : tx, pairs: [] });
      }
      pairsByTopic.get(key).pairs.push({ x, y, sim });
    }
  }

  const span = Math.max(1e-9, cfg.maxSimilarity - cfg.minSimilarity);
  const associations = [];
  for (const [groupKey, entry] of pairsByTopic) {
    const sims = entry.pairs.map(pair => pair.sim);
    const maxSimilarity = Math.max(...sims);
    const avgSimilarity = sims.reduce((sum, value) => sum + value, 0) / sims.length;
    // 参与联想的去重记忆集合（两个话题各自的成员，按出现序）
    const involved = [];
    const seen = new Set();
    for (const { x, y } of entry.pairs) {
      for (const memory of [x, y]) {
        const id = String(memory.id);
        if (!seen.has(id)) {
          seen.add(id);
          involved.push(memory);
        }
      }
    }
    associations.push({
      groupKey,
      topicIds: [entry.a, entry.b],
      sourceMemoryIds: involved.map(memory => String(memory.id)), // 据此反查/回滚
      pairCount: entry.pairs.length,
      maxSimilarity: Number(maxSimilarity.toFixed(4)),
      avgSimilarity: Number(avgSimilarity.toFixed(4)),
      // 置信度：在弱关联带里的相对位置（越靠近「同一件事」越有把握）
      confidence: Number(memoryLifecycle.clamp01((maxSimilarity - cfg.minSimilarity) / span).toFixed(4)),
      samples: involved.slice(0, Math.max(0, cfg.maxSamples)).map(memory => ({
        id: String(memory.id),
        topicId: String(memory.topicId),
        text: dedupSnippet(textOf(memory))
      }))
    });
  }

  associations.sort((p, q) => (q.confidence - p.confidence) || (q.pairCount - p.pairCount));
  return associations.slice(0, Math.max(0, cfg.maxAssociations));
}

// 🧠 巩固透明（DB-6）：从一组记忆中反查「被巩固进 semanticId 的全部源情景记忆」。
// 复用 linkConsolidated 写下的 consolidatedInto 溯源字段，不新增审计结构；id 一律按字符串比对
function findConsolidatedSources(memories, semanticId) {
  const id = String(semanticId);
  const list = Array.isArray(memories) ? memories : [];
  return list.filter(memory => memory && memory.consolidatedInto != null
    && String(memory.consolidatedInto) === id);
}

// 🧠 巩固透明（DB-6）：把一个源情景记忆复原到「被巩固前」的状态——
// 清溯源、从 archived 回到 episodic、把 linkConsolidated 减半的 salience 还原（夹回 [0,1]）。
// 返回是否确实发生了复原（非源条目返回 false）
function restoreConsolidatedSource(memory) {
  if (!memory || typeof memory !== 'object' || !memory.consolidatedInto) return false;
  memory.consolidatedInto = null;
  memory.tier = 'episodic';
  const base = memory.salience != null ? memoryLifecycle.clamp01(memory.salience) : 0;
  memory.salience = memoryLifecycle.clamp01(base * 2);
  return true;
}

// 解析模型返回的语义结论：
//   - 去 ``` 围栏、去整体包裹的引号/书名号、去列表前缀
//   - 像 JSON（以 [ { 开头）视为跑偏，直接丢弃
//   - 只取第一行，空/过短返回 ''，过长截断
function parseConsolidationOutput(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.trim();
  if (!text) return '';
  text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
  if (/^[[{]/.test(text)) return '';
  text = text.replace(/^[“"'「『]+/, '').replace(/[”"'」』]+$/, '').trim();
  const firstLine = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || '';
  text = firstLine.replace(/^(?:[-*·]|\d+[.、)])\s*/, '').trim();
  if (!text || effectiveLen(text) < 4) return '';
  if (text.length > MAX_SEMANTIC_LEN) text = text.slice(0, MAX_SEMANTIC_LEN);
  return text;
}

module.exports = {
  DEFAULTS,
  MAX_SEMANTIC_LEN,
  effectiveLen,
  isConsolidationCandidate,
  salienceOf,
  selectCandidates,
  bigrams,
  diceSimilarity,
  cosineSimilarity,
  greedyCluster,
  clusterByVectors,
  clusterByText,
  clusterCandidates,
  pickClusters,
  DEDUP_DEFAULTS,
  normalizeForDedup,
  polarityOf,
  isEligibleForMaintenance,
  planDedupMerge,
  REM_DEFAULTS,
  planRemAssociations,
  findConsolidatedSources,
  restoreConsolidatedSource,
  parseConsolidationOutput
};
