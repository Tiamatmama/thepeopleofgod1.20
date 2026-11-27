const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');

// 情感履历 ledger：记「系统在什么情绪下缺过什么能力」，与「记住用户说过什么」的长期记忆分开存。
// P0：observe() 折算 frustration，把够格的信号落盘。
// P1（影子模式）：聚类 + 四判据打分。结果只写 data/tool_creation_logs.json，永不发起任何申请——
// 这一阶段唯一目的是拿真实数据校准 0.70 / 0.55 / 0.35 这些阈值。
const RECORD_THRESHOLD = 0.35;              // §8.5 低于此不记账
const CANDIDATE_THRESHOLD = 0.50;           // §8.5 进入候选池；也是「值得单开一簇并调模型」的下限
const CLUSTER_SIMILARITY = 0.6;             // §8.6 归簇的 bigram Jaccard 阈值
const FINGERPRINT_GRAM_COUNT = 3;           // §8.6 指纹取簇内频次最高的 3 个 bigram
const CLUSTER_GRAM_LIMIT = 300;             // 簇内 bigram 计数表上限，防长跑无限膨胀
const R_WINDOW_DAYS = 30;                   // §8.7 R 的滑动窗口
const SESSION_DEDUPE_MS = 10 * 60 * 1000;   // §8.7 同会话 10 分钟去重（与 §8.9 同指纹去抖同一个值）
const E_HALF_LIFE_DAYS = 14;                // §8.7 E 的时间半衰期
const N_TRIGGER_COUNTS = [5, 3, 2];         // §8.10 N 判定只在 R 跨过 2/3/5 台阶时触发
const GLOBAL_CREATE_LIMIT = 3;              // §8.8 / §8.9 全局 30 天创建上限
const REJECTED_COOLDOWN_DAYS = 7;           // §8.9 rejected 冷却
const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_LIMIT = 1000;                     // 留痕只保留最近 1000 条，对齐 affection_logs.json
const SIGNAL_LIMIT = 1000;                  // 履历信号上限：R 窗口只有 30 天、台阶最高 5，留最近 1000 条足够且防长跑无界膨胀
const CLUSTER_LIMIT = 200;                  // 簇上限：按最近出现时间保留，淘汰长期不再被触达的陈旧簇

// §8.7 R 台阶表：命中第一个 n ≥ min 的档
const R_LADDER = [
  { min: 5, r: 1.00 },
  { min: 4, r: 0.75 },
  { min: 3, r: 0.55 },
  { min: 2, r: 0.30 },
  { min: 1, r: 0 }
];

// §8.8 准入门槛：必须全部满足
const CREATION_GATE = { S: 0.70, R: 0.55, E: 0.35, N: 0.50, daySpread: 2 };

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

// 自然日（本地时区）：跨天判据要按用户所在时区算，不能用 UTC
function localDay(timestamp) {
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// bigram 集合：与 memory.js 的 toBigrams() 同一套切法，纯本地运算，不调模型
function toBigrams(text) {
  const clean = String(text || '').replace(/\s+/g, '');
  const grams = new Set();
  for (let i = 0; i < clean.length - 1; i++) {
    grams.add(clean.slice(i, i + 2));
  }
  if (grams.size === 0 && clean.length > 0) {
    grams.add(clean);
  }
  return grams;
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const gram of left) {
    if (right.has(gram)) intersection++;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function rLadderIndex(count) {
  const index = R_LADDER.findIndex(step => count >= step.min);
  return index === -1 ? R_LADDER.length - 1 : index;
}

// 镜像 index.js 的 extractJsonObject：剥掉 markdown 围栏再取最外层 JSON
function extractJsonObject(text) {
  const raw = String(text || '').replace(/```[a-zA-Z]*/g, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    return null;
  }
}

class EmotionLedger {
  constructor({ emotionModule, memoryModule, toolRegistry, inputModule, selfModelLive, autoToolLive } = {}) {
    this.emotionModule = emotionModule;
    // M 判据要召回用户长期记忆，N 判据要现有工具能力清单和一条模型通道，都从主流程注入
    this.memoryModule = memoryModule;
    this.toolRegistry = toolRegistry;
    this.inputModule = inputModule;
    // 🧠 自我模型灰度开关（§4.6）：关闭时 ledger 行为与现状完全一致，只记影子日志；
    // 打开时，过阈值的诉求会顺带把一句「关于她自己」的稳定认知写进 self_model
    this.selfModelLive = typeof selfModelLive === 'boolean'
      ? selfModelLive
      : String(process.env.SELF_MODEL_LIVE || '').toLowerCase() === 'true';
    // 🛠 P2 开关（§8.14 / §8.18）：关闭时与 P1 完全一致，只写影子日志、永不发起创建；
    // 打开后，四判据 + 限流全过的诉求会直接注册成自建工具（创建免审批）。
    // 默认关闭——§8.18 明确「P1 影子校准是 P2 的前置条件」，须先跑够真实样本再手动开
    this.autoToolLive = typeof autoToolLive === 'boolean'
      ? autoToolLive
      : String(process.env.AUTO_TOOL_LIVE || '').toLowerCase() === 'true';
    // 自建工具存储：由服务端注入（toolRegistry.autoToolStore）。未注入时 P2 整段跳过
    this.autoToolStore = null;
    // 创建通知通道：复用 toolRegistry 的审批推送（§8.14「不是审批、不阻塞、不等回执」）
    this.creationNotifier = null;
    // P3 反馈回收：自建工具每次被调用后，观察后续 2 轮内用户的 frustration 变化（§8.15）
    this.pendingFeedback = [];
    this.storagePath = path.join(__dirname, '../../data/emotion_ledger.json');
    this.logPath = path.join(__dirname, '../../data/tool_creation_logs.json');
    this.data = this.load();
  }

  // 服务端注入自建工具存储（§8.13）
  setAutoToolStore(autoToolStore) {
    this.autoToolStore = autoToolStore || null;
  }

  // 服务端注入创建通知通道：签名 (notification) => void，只展示、不等待回执（§8.14）
  setCreationNotifier(notifier) {
    this.creationNotifier = typeof notifier === 'function' ? notifier : null;
  }

  ensureStorageDir() {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  createEmptyLedger() {
    return { version: 1, signals: [], clusters: [], trust: {} };
  }

  load() {
    try {
      if (!fs.existsSync(this.storagePath)) return this.createEmptyLedger();
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
      const ledger = this.createEmptyLedger();
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.signals)) ledger.signals = parsed.signals;
        if (Array.isArray(parsed.clusters)) {
          ledger.clusters = parsed.clusters
            .filter(item => item && typeof item === 'object')
            .map(item => ({
              ...item,
              gramCounts: item.gramCounts && typeof item.gramCounts === 'object' ? item.gramCounts : {},
              signalIds: Array.isArray(item.signalIds) ? item.signalIds : [],
              necessity: item.necessity || null
            }));
        }
        if (parsed.trust && typeof parsed.trust === 'object') ledger.trust = parsed.trust;
      }
      return ledger;
    } catch (error) {
      console.error('[情感工具] 情感履历读取失败，改用空档:', error.message);
      return this.createEmptyLedger();
    }
  }

  save() {
    try {
      this.ensureStorageDir();
      this.trimLedger();
      writeJsonAtomicSync(this.storagePath, this.data);
    } catch (error) {
      console.error('[情感工具] 情感履历落盘失败:', error.message);
    }
  }

  // 落盘前收口数组规模：signals 按追加顺序（时间递增）留最近 SIGNAL_LIMIT 条；
  // clusters 按 lastSeenAt 保留最近的 CLUSTER_LIMIT 个（旧的只是不再被拿来比较，不影响已落盘的自建工具记录）。
  trimLedger() {
    if (this.data.signals.length > SIGNAL_LIMIT) {
      this.data.signals = this.data.signals.slice(-SIGNAL_LIMIT);
    }
    if (this.data.clusters.length > CLUSTER_LIMIT) {
      this.data.clusters = this.data.clusters
        .slice()
        .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
        .slice(0, CLUSTER_LIMIT);
    }
  }

  // 挫败度与正向兴趣：纯本地折算，不调模型
  computeScores(processedInput, sessionId, userId) {
    const emotions = this.emotionModule ? this.emotionModule.getCurrentEmotions(sessionId, userId) : {};
    const value = Number.isFinite(processedInput?.value) ? processedInput.value : 0;
    // 不安 / 低落 / 吃醋 三者取最高，作为「负面情绪底噪」
    const negative = Math.max(emotions.anxious || 0, emotions.sad || 0, emotions.jealous || 0);
    const frustration = clamp01(0.6 * Math.max(0, -value) + 0.4 * negative);
    const positiveInterest = clamp01(0.6 * Math.max(0, value) + 0.4 * (emotions.happy || 0));
    return { value, frustration, positiveInterest };
  }

  async observe(processedInput, { sessionId, userId, text, source } = {}) {
    const { value, frustration, positiveInterest } = this.computeScores(processedInput, sessionId, userId);
    const owner = userId || 'default';

    // P3 反馈回收（§8.15）：先用「上轮基线」结算待观察的自建工具调用，再更新基线。
    // 必须放在 frustration < RECORD_THRESHOLD 的提前返回之前——否则「调用后用户情绪回落」
    // 这种最典型的好反馈（frustration 降到 0.35 以下）反而永远结算不到
    this.updateAutoToolFeedback(owner, frustration);

    if (frustration < RECORD_THRESHOLD) {
      return { recorded: false, frustration };
    }

    const timestamp = Date.now();
    // 情绪记本次输入的语义判定（用户带着什么情绪提的诉求）。
    // 不用会话主导情绪：calm 的默认值会恒压过刚叠加的 sad/anxious，记下来恒为 calm，没有参考价值。
    const inputEmotion = processedInput?.emotion;
    const rawIntensity = Number(inputEmotion?.intensity);
    const emotion = inputEmotion?.type
      ? {
          type: inputEmotion.type,
          intensity: Number.isFinite(rawIntensity) ? Math.max(0, Math.min(1, rawIntensity)) : 0.5
        }
      : null;

    const signal = {
      id: `sig_${timestamp}_${Math.random().toString(16).slice(2, 6)}`,
      timestamp,
      userId: owner,
      sessionId: sessionId || 'default',
      day: localDay(timestamp),
      text: typeof text === 'string' ? text.slice(0, 500) : '',
      // 聚类结果：clusterSignal() 里回填，没归进任何簇时保持空
      clusterId: null,
      fingerprint: null,
      value,
      emotion: emotion,
      frustration,
      positiveInterest,
      source: source || 'chat',
      matchedTool: null
    };

    this.data.signals.push(signal);
    if (!Number.isFinite(this.data.trust[owner])) {
      this.data.trust[owner] = 0.5;
    }
    // 先按 P0 的样子落一次盘：聚类与打分要调模型，万一卡在这里也不能把这条信号丢了
    this.save();
    console.log(`[情感工具] 履历记账 ${signal.id} frustration=${frustration.toFixed(2)} source=${signal.source}`);

    // P1 影子模式：聚类 + 四判据打分，结果只写 data/tool_creation_logs.json，永不发起任何申请
    const { cluster, similarity } = await this.clusterSignal(signal);
    if (cluster) {
      await this.scoreCreation(signal, cluster, similarity);
      this.save();
    }

    return { recorded: true, signal };
  }

  // —— P1：聚类 ——

  // 簇的比较集合 = 簇内出现过的所有 bigram ∪ needText 的 bigram。
  // 若只拿「频次最高的 3 个 bigram」当指纹去算 Jaccard，稍长一点的原话永远够不到 0.6，
  // 同一件事会被拆成一堆单次簇；所以指纹只作展示与留痕，判相似度用全量 gram。
  comparisonGrams(cluster) {
    const grams = new Set(Object.keys(cluster.gramCounts || {}));
    for (const gram of toBigrams(cluster.needText)) {
      grams.add(gram);
    }
    return grams;
  }

  // 把一条信号并进簇：累加 bigram 频次、重算指纹、回填信号的簇归属
  absorbIntoCluster(cluster, signal) {
    for (const gram of toBigrams(signal.text)) {
      cluster.gramCounts[gram] = (cluster.gramCounts[gram] || 0) + 1;
    }
    this.pruneGramCounts(cluster);

    cluster.fingerprint = Object.entries(cluster.gramCounts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, FINGERPRINT_GRAM_COUNT)
      .map(entry => entry[0])
      .join('|');

    signal.clusterId = cluster.id;
    signal.fingerprint = cluster.fingerprint;
    if (!cluster.signalIds.includes(signal.id)) {
      cluster.signalIds.push(signal.id);
    }
    cluster.lastSeenAt = signal.timestamp;
  }

  pruneGramCounts(cluster) {
    const keys = Object.keys(cluster.gramCounts);
    if (keys.length <= CLUSTER_GRAM_LIMIT) return;
    const kept = keys
      .sort((a, b) => cluster.gramCounts[b] - cluster.gramCounts[a])
      .slice(0, CLUSTER_GRAM_LIMIT);
    const next = {};
    for (const key of kept) next[key] = cluster.gramCounts[key];
    cluster.gramCounts = next;
  }

  async clusterSignal(signal) {
    const grams = toBigrams(signal.text);
    if (grams.size === 0) return { cluster: null, similarity: 0 };

    let best = null;
    let bestSimilarity = 0;
    for (const cluster of this.data.clusters) {
      // 簇按用户隔离：跨用户聚簇会把不同人的诉求混成一件事
      if (cluster.userId !== signal.userId) continue;
      const similarity = jaccard(grams, this.comparisonGrams(cluster));
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        best = cluster;
      }
    }

    if (best && bestSimilarity >= CLUSTER_SIMILARITY) {
      this.absorbIntoCluster(best, signal);
      return { cluster: best, similarity: bestSimilarity };
    }

    // 没归进任何簇：只有够格进候选池的诉求才值得单开一簇（新簇要调一次模型生成 needText）
    if (signal.frustration < CANDIDATE_THRESHOLD) {
      return { cluster: null, similarity: bestSimilarity };
    }

    const cluster = {
      id: `clu_${signal.timestamp}_${Math.random().toString(16).slice(2, 6)}`,
      userId: signal.userId,
      fingerprint: '',
      gramCounts: {},
      needText: null,
      signalIds: [],
      count: 0,
      daySpread: 0,
      avgFrustration: 0,
      positiveInterest: 0,
      necessity: null,
      firstSeenAt: signal.timestamp,
      lastSeenAt: signal.timestamp
    };
    this.data.clusters.push(cluster);
    this.absorbIntoCluster(cluster, signal);
    cluster.needText = await this.summarizeNeed(signal.text);
    return { cluster, similarity: bestSimilarity };
  }

  // 新建簇时调一次模型，把原话蒸馏成一句「用户到底想要什么」，整簇复用，之后不再花钱
  async summarizeNeed(text) {
    const messages = [
      {
        role: 'system',
        content: [
          '你在概括用户诉求的本质：他提出的这件事，究竟想让系统替他做什么。',
          '只输出一句话，不超过 20 个字，不要解释、不要引号、不要列点。',
          `用户原话：${text}`
        ].join('\n')
      }
    ];
    try {
      const result = await this.inputModule.unifiedAPI.callAPI(messages, null, { temperature: 0.1, callSite: 'emotionNeed' });
      const need = String(result?.choices?.[0]?.message?.content || '')
        .replace(/[\s"'“”]/g, '')
        .slice(0, 40);
      return need || String(text || '').slice(0, 40);
    } catch (error) {
      // 模型不可用时退回原话：需求描述糙一点，也好过整条履历链路断在这里
      console.error('[情感工具] 需求概括调用失败，退回原话:', error.message);
      return String(text || '').slice(0, 40);
    }
  }

  // 🧠 自我模型落地（§4.6）：把一个「反复让她受挫/在意」的诉求，提炼成一句关于她自己的稳定认知。
  // 只在 live 模式且过了准入门槛时调用；模型不可用退回模板句，绝不让这条链路断在这里
  async summarizeSelfTrait(cluster) {
    const needText = String(cluster.needText || '').slice(0, 40);
    const messages = [
      {
        role: 'system',
        content: [
          '你在提炼一句「关于她自己」的稳定自我认知，用第一人称「我」。',
          '基于她反复受挫、反复在意的这件事，写一句她因此更看清自己的一句话。',
          '只输出一句话，不超过 24 个字，不要解释、不要引号、不要列点。',
          `她反复在意的事：${needText}`
        ].join('\n')
      }
    ];
    try {
      const result = await this.inputModule.unifiedAPI.callAPI(messages, null, { temperature: 0.4, callSite: 'emotionTrait' });
      const trait = String(result?.choices?.[0]?.message?.content || '')
        .replace(/[\s"'“”]/g, '')
        .slice(0, 60);
      return trait || (needText ? `我最近总在意${needText}` : '');
    } catch (error) {
      console.error('[情感工具] 自我认知生成调用失败，退回模板:', error.message);
      return needText ? `我最近总在意${needText}` : '';
    }
  }

  // —— P1：四判据打分 ——

  // R 的计数基础：30 天窗口内同一簇的信号，同会话 10 分钟内的重复算 1 次
  collectClusterMembers(clusterId, now) {
    const windowStart = now - R_WINDOW_DAYS * DAY_MS;
    const members = this.data.signals
      .filter(signal => signal.clusterId === clusterId && signal.timestamp >= windowStart)
      .sort((a, b) => a.timestamp - b.timestamp);

    const lastSeenBySession = new Map();
    let independent = 0;
    for (const signal of members) {
      const lastSeen = lastSeenBySession.get(signal.sessionId);
      if (lastSeen !== undefined && signal.timestamp - lastSeen < SESSION_DEDUPE_MS) {
        continue;
      }
      lastSeenBySession.set(signal.sessionId, signal.timestamp);
      independent++;
    }
    return { members, independent };
  }

  computeCreationScores(cluster, now) {
    const { members, independent } = this.collectClusterMembers(cluster.id, now);
    const ladderIndex = rLadderIndex(independent);
    const R = R_LADDER[ladderIndex].r;

    // E：14 天半衰期的时间加权均值，再按跨了几个自然日打折——全挤在同一天说明是一时冲动
    let weighted = 0;
    let weightSum = 0;
    const days = new Set();
    for (const signal of members) {
      const deltaDays = Math.max(0, (now - signal.timestamp) / DAY_MS);
      const weight = Math.pow(0.5, deltaDays / E_HALF_LIFE_DAYS);
      weighted += (signal.frustration || 0) * weight;
      weightSum += weight;
      days.add(signal.day);
    }
    const eBase = weightSum > 0 ? weighted / weightSum : 0;
    const daySpread = days.size;
    const E = clamp01(eBase * Math.min(1, 0.5 + 0.25 * daySpread));

    // M：用户长期记忆里有没有这摊事（0.6）+ 该簇的正向兴趣（0.4）
    // 显式锁在角色态分档：M 衡量的是日常陪伴关系里的记忆存量，不含 AI 态那档
    const needText = cluster.needText || '';
    const memHit = this.memoryModule && needText
      ? (this.memoryModule.getRelevantMemories(this.memoryModule.normalizeScopeKey(cluster.userId, 'role'), needText, 5).length > 0 ? 1 : 0)
      : 0;
    const avgFrustration = members.length > 0
      ? members.reduce((sum, signal) => sum + (signal.frustration || 0), 0) / members.length
      : 0;
    const positiveInterest = members.length > 0
      ? members.reduce((sum, signal) => sum + (signal.positiveInterest || 0), 0) / members.length
      : 0;
    const M = clamp01(0.6 * memHit + 0.4 * positiveInterest);

    return { members, independent, ladderIndex, R, E, daySpread, M, memHit, avgFrustration, positiveInterest };
  }

  // N 判据：复用「让模型出 JSON + 本地白名单收敛」范式，认不出当 0（保守，不创建）
  async judgeNecessity(needText) {
    const capabilitiesText = this.toolRegistry ? this.toolRegistry.describeCapabilities() : '';
    if (!capabilitiesText || !needText) {
      return { covered: 0, reason: '缺少能力清单或需求描述，保守按已覆盖处理' };
    }

    const messages = [
      {
        role: 'system',
        content: [
          '你在判断：用户反复提出的这个需求，现有工具能不能满足。',
          '',
          '现有工具清单：',
          capabilitiesText,
          '',
          '用户反复提出的需求：', needText,
          '',
          '只输出一个 JSON 对象，不要解释、不要加 markdown 代码块：',
          '{"covered": 0 | 0.5 | 1, "reason": "一句话理由"}',
          'covered=1 → 现有工具完全做不到；',
          'covered=0.5 → 能做，但要人工绕很大一圈或手工多步；',
          'covered=0 → 现有工具已经能直接做。'
        ].join('\n')
      }
    ];

    try {
      const result = await this.inputModule.unifiedAPI.callAPI(messages, null, { temperature: 0.1, callSite: 'emotionNecessity' });
      const parsed = extractJsonObject(result?.choices?.[0]?.message?.content);
      const covered = parsed ? parsed.covered : null;
      if (covered === 1 || covered === 0.5 || covered === 0) {
        return { covered, reason: String(parsed.reason || '').slice(0, 200) };
      }
      return { covered: 0, reason: '模型返回值不在白名单内，保守按已覆盖处理' };
    } catch (error) {
      console.error('[情感工具] 必要性判定调用失败，保守按已覆盖处理:', error.message);
      return { covered: 0, reason: '必要性判定调用失败，保守按已覆盖处理' };
    }
  }

  // §8.9 限流：只影响「发起申请的频率上限」，不放松任何审批
  checkRateLimits(cluster, userId, logs, now) {
    const rejected = logs.find(log =>
      log.clusterId === cluster.id &&
      log.event === 'rejected' &&
      log.timestamp >= now - REJECTED_COOLDOWN_DAYS * DAY_MS
    );
    if (rejected) {
      return `该诉求 ${REJECTED_COOLDOWN_DAYS} 天内已被拒绝过，冷却中`;
    }

    const trust = Number.isFinite(this.data.trust[userId]) ? this.data.trust[userId] : 0.5;
    // trust 修正：trust 高放宽到 3 个/24h，低则收紧到 1 个
    const dailyCap = 1 + Math.round(trust * 2);
    const proposedIn24h = logs.filter(log =>
      log.userId === userId &&
      log.timestamp >= now - DAY_MS &&
      (log.event === 'created' || (log.event === 'shadow' && log.decision === 'would_create'))
    ).length;
    if (proposedIn24h >= dailyCap) {
      return `该用户 24 小时内已触发 ${proposedIn24h} 次候选（上限 ${dailyCap}），限流中`;
    }

    return null;
  }

  async scoreCreation(signal, cluster, similarity) {
    // 该簇已经自主造过工具：不重复创建（§8.19.4 不允许改写自身 steps），也不再刷影子日志
    if (cluster.toolName) {
      return { scores: null, decision: 'created' };
    }

    const now = Date.now();
    const scores = this.computeCreationScores(cluster, now);
    const { R, E, M, independent, daySpread, members } = scores;

    // 每次打分都把实时统计写回簇，供 §8.4 那套「情绪触发点」直接读
    cluster.count = members.length;
    cluster.daySpread = daySpread;
    cluster.avgFrustration = round3(scores.avgFrustration);
    cluster.positiveInterest = round3(scores.positiveInterest);
    cluster.memHit = scores.memHit;
    cluster.lastScoredAt = now;

    const logs = this.readLogs();

    // 同指纹 10 分钟去抖：连发的重复抱怨算同一次，不重复留痕（R 的计数里已经去过重）
    const debounced = logs.some(log =>
      log.clusterId === cluster.id &&
      log.userId === signal.userId &&
      log.timestamp >= now - SESSION_DEDUPE_MS
    );
    if (debounced) {
      console.log(`[情感工具] ${cluster.fingerprint} 10 分钟内已记过一次，本次不再留痕`);
      return { scores: { S: null, R, E, N: null, M }, decision: 'debounced' };
    }

    // N 最贵：只在 R 跨过 2/3/5 台阶时调一次，结果按台阶缓存，同一台阶内复用
    const trigger = N_TRIGGER_COUNTS.find(count => independent >= count) || null;
    let N = 0;
    let necessityReason = '未跨过 R 台阶，暂不做必要性判定';
    if (trigger) {
      if (!cluster.necessity || cluster.necessity.trigger !== trigger) {
        const judged = await this.judgeNecessity(cluster.needText);
        cluster.necessity = { trigger, covered: judged.covered, reason: judged.reason };
      }
      N = cluster.necessity.covered;
      necessityReason = cluster.necessity.reason;
    }

    const S = 0.35 * R + 0.30 * E + 0.25 * N + 0.10 * M;

    const gateFailures = [];
    if (S < CREATION_GATE.S) gateFailures.push(`S=${S.toFixed(2)}<${CREATION_GATE.S}`);
    if (R < CREATION_GATE.R) gateFailures.push(`R=${R.toFixed(2)}<${CREATION_GATE.R}`);
    if (E < CREATION_GATE.E) gateFailures.push(`E=${E.toFixed(2)}<${CREATION_GATE.E}`);
    if (N < CREATION_GATE.N) gateFailures.push(`N=${N.toFixed(2)}<${CREATION_GATE.N}`);
    if (daySpread < CREATION_GATE.daySpread) gateFailures.push(`跨天=${daySpread}<${CREATION_GATE.daySpread}`);
    const createdIn30d = logs.filter(log =>
      log.event === 'created' && log.timestamp >= now - R_WINDOW_DAYS * DAY_MS
    ).length;
    if (createdIn30d >= GLOBAL_CREATE_LIMIT) {
      gateFailures.push(`30 天内已自主创建 ${createdIn30d} 个 ≥ ${GLOBAL_CREATE_LIMIT}`);
    }

    const limited = this.checkRateLimits(cluster, signal.userId, logs, now);
    const passed = gateFailures.length === 0 && !limited;

    // 🧠 灰度落地（§4.6）：仅当 live 开关打开、且该诉求过了准入门槛时，
    // 顺带把一句「关于她自己」的稳定认知写进 self_model。
    // 关闭开关时这里整段跳过 → record 与现状逐字段一致（§八硬约束）
    const liveReady = passed && this.selfModelLive
      && this.memoryModule && typeof this.memoryModule.upsertSelfTrait === 'function';
    let selfTrait = null;
    if (liveReady) {
      selfTrait = await this.summarizeSelfTrait(cluster);
      if (selfTrait) {
        this.memoryModule.upsertSelfTrait(signal.userId, {
          text: selfTrait,
          confidence: 0.5,
          source: cluster.id
        });
      }
    }

    // 🛠 P2 自动注册（§8.14 创建免审批）：四判据 + 限流全过，且 live 开关打开、store 已注入，才走到这里。
    // 走的是「让模型出草案 → 本地白名单强校验 → 落盘」这条线；不生成任何代码，执行体只是编排（§8.12）
    const autoReady = passed && this.autoToolLive && this.autoToolStore;
    const scoresPayload = { S: round3(S), R, E: round3(E), N, M: round3(M) };
    let createdTool = null;
    let rejectReason = null;
    if (autoReady) {
      const draft = await this.generateToolDraft(cluster, scores);
      if (draft) {
        const result = this.autoToolStore.register(draft, {
          fingerprint: cluster.fingerprint,
          needText: cluster.needText,
          scores: scoresPayload,
          userIds: [...new Set(members.map(item => item.userId))],
          signalIds: members.map(item => item.id)
        });
        if (result.ok) {
          createdTool = result.tool;
          cluster.toolName = createdTool.name;
          cluster.status = 'created';
        } else {
          rejectReason = result.reason;
        }
      } else {
        rejectReason = '工具草案生成失败，未注册';
      }
    }

    const base = {
      timestamp: now,
      fingerprint: cluster.fingerprint,
      clusterId: cluster.id,
      userId: signal.userId,
      scores: scoresPayload,
      counts: { independent, daySpread, createdIn30d },
      similarity: round3(similarity),       // 本次原话与最佳簇的 Jaccard，供校准 §8.6 的 0.6 阈值
      emotionContext: {
        type: signal.emotion?.type || null,
        intensity: signal.emotion?.intensity ?? null,
        frustration: round3(signal.frustration)
      },
      necessityReason
    };

    let record;
    if (createdTool) {
      // §8.16：创建留痕
      record = {
        ...base,
        event: 'created',
        toolName: createdTool.name,
        decision: 'auto_created',
        decidedBy: 'auto',
        reason: '四判据与限流全过，创建免审批（§8.14）'
      };
    } else if (autoReady && rejectReason) {
      // §8.16：过了闸门但草案没通过注册校验 → 记 rejected（不再区分管理员拒绝）
      record = {
        ...base,
        event: 'rejected',
        toolName: null,
        decision: 'rejected_validation',
        decidedBy: 'auto',
        reason: rejectReason
      };
    } else {
      // P1 影子：维持与现状逐字段一致（关闭 P2 时行为不变，§八硬约束）
      record = {
        ...base,
        event: limited ? 'cooldown' : 'shadow',
        toolName: null,
        decision: limited ? 'cooldown' : (passed ? 'would_create' : 'would_reject'),
        decidedBy: liveReady ? 'live_mode' : 'shadow_mode',
        reason: limited || (passed ? '影子模式：分数达标，换到 P2 会发起申请' : gateFailures.join('; '))
      };
    }
    // 仅在真正落地了自我认知时才追加该字段，保证关闭开关时 record 结构与现状完全一致
    if (selfTrait) record.selfTrait = selfTrait;
    this.appendLog(logs, record);

    console.log(
      `[情感工具] ${cluster.fingerprint} S=${S.toFixed(2)} R=${R.toFixed(2)} ` +
      `E=${E.toFixed(2)} N=${N.toFixed(2)} M=${M.toFixed(2)} → ${record.decision} | ${record.reason}`
    );

    // 创建后立刻推通知：只展示、不阻塞、不等回执（§8.14）
    if (createdTool) {
      this.notifyCreation(createdTool, cluster, scoresPayload, independent, daySpread);
      this.save();   // 回写 cluster.toolName / status
    }
    return { scores: record.scores, decision: record.decision, record };
  }

  // —— P2：工具草案生成（§8.11）——
  // 复用「让模型出 JSON + 本地白名单收敛」范式：模型只负责把诉求翻译成编排步骤，
  // 能不能落地由 autoToolStore.validateDraft() 说了算，模型越界一律拒
  async generateToolDraft(cluster, scores) {
    const capabilitiesText = this.toolRegistry ? this.toolRegistry.describeCapabilities() : '';
    if (!capabilitiesText) return null;

    const messages = [
      {
        role: 'system',
        content: [
          '你在为用户反复提出、现有工具又做不到的需求，设计一个新工具的「编排步骤」。',
          '你不写代码：新工具的执行体只是把下面这些现有工具按顺序串起来。',
          '',
          '现有工具清单：',
          capabilitiesText,
          '',
          '用户的诉求：', String(cluster.needText || '').slice(0, 60),
          '',
          '硬性约束（违反则草案作废）：',
          '1. name 必须以 auto_ 开头，后续只用小写字母、数字、下划线；',
          '2. steps 里每一步的 tool 必须来自上面「现有工具清单」，且不得使用 run_command / run_python / run_node / delete_file；',
          '3. steps 最多 8 步；用 bind 把某一步结果存成变量，后续用 $变量名 引用，变量引用链最多 2 层；',
          '4. 路径里只能用 %DESKTOP% 或 %PROJECT_ROOT% 两个占位符，不得写死绝对路径；',
          '5. parameters 用 JSON Schema，类型只允许 string/number/integer/boolean/array/object，嵌套不超过 2 层。',
          '',
          '只输出一个 JSON 对象，不要解释、不要加 markdown 代码块：',
          '{"name":"auto_xxx","description":"一句话说明何时用它","parameters":{"type":"object","properties":{},"required":[]},"steps":[{"tool":"某现有工具","args":{},"bind":"变量名或null"}]}'
        ].join('\n')
      }
    ];

    try {
      const result = await this.inputModule.unifiedAPI.callAPI(messages, null, { temperature: 0.2, callSite: 'emotionToolDraft' });
      const parsed = extractJsonObject(result?.choices?.[0]?.message?.content);
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        name: parsed.name,
        description: parsed.description,
        parameters: parsed.parameters,
        steps: parsed.steps
      };
    } catch (error) {
      console.error('[情感工具] 工具草案生成调用失败:', error.message);
      return null;
    }
  }

  // 创建通知（§8.14）：内容含需求、指纹、次数、五项分数、步骤的人话描述与「可随时手动停用」提示
  notifyCreation(tool, cluster, scores, independent, daySpread) {
    if (!this.creationNotifier) return;
    const description = this.autoToolStore && typeof this.autoToolStore.describeSteps === 'function'
      ? this.autoToolStore.describeSteps(tool)
      : '';
    const notification = {
      type: 'auto-tool-created',
      toolName: tool.name,
      needText: cluster.needText || '',
      fingerprint: cluster.fingerprint,
      independent,
      daySpread,
      scores,
      description,
      note: '这是系统自己新建的工具（创建免审批），未经人工确认，可随时手动停用'
    };
    try {
      this.creationNotifier(notification);
    } catch (error) {
      console.error('[情感工具] 创建通知推送失败:', error.message);
    }
  }

  // —— P3：反馈回收与自动停用（§8.15）——

  // 自建工具被调用时登记一条待观察记录。
  // 基线留空、由本轮收尾的 observe() 补：调用发生在该轮回复生成期间，此刻还拿不到本轮
  // frustration，硬取上一轮的值会把「后续 2 轮」的窗口整体算早一轮
  noteAutoToolCall(toolName, context = {}) {
    if (!toolName) return;
    const owner = (context && context.userId) || 'default';
    this.pendingFeedback.push({
      toolName,
      userId: owner,
      baseline: null,
      remaining: 2
    });
  }

  // 每次 observe 推进一次：第一次观察只锁基线（本轮收尾），之后 2 轮内出现 |Δ| ≥ 0.20 即定档，
  // 否则 2 轮后记 neutral（§8.15）
  updateAutoToolFeedback(owner, frustration) {
    if (this.pendingFeedback.length === 0) return;
    const settled = [];
    for (const item of this.pendingFeedback) {
      if (item.userId !== owner) continue;
      if (item.baseline === null) {
        item.baseline = frustration;
        continue;
      }
      item.remaining -= 1;
      const delta = frustration - item.baseline;
      if (delta <= -0.20) {
        this.recordAutoToolFeedback(item.toolName, 'positive', owner);
        settled.push(item);
      } else if (delta >= 0.20) {
        this.recordAutoToolFeedback(item.toolName, 'negative', owner);
        settled.push(item);
      } else if (item.remaining <= 0) {
        this.recordAutoToolFeedback(item.toolName, 'neutral', owner);
        settled.push(item);
      }
    }
    if (settled.length > 0) {
      this.pendingFeedback = this.pendingFeedback.filter(item => !settled.includes(item));
    }
  }

  recordAutoToolFeedback(toolName, kind, owner) {
    if (!this.autoToolStore || typeof this.autoToolStore.applyFeedback !== 'function') return;
    const result = this.autoToolStore.applyFeedback(toolName, kind);
    if (!result || !result.tool) return;

    this.applyTrustFromFeedback(result.tool, kind);

    const logs = this.readLogs();
    const baseRecord = {
      timestamp: Date.now(),
      toolName,
      fingerprint: result.tool.origin?.fingerprint || null,
      clusterId: null,
      userId: owner || 'default',
      scores: null,
      emotionContext: null,
      decidedBy: 'auto',
      emotionFeedback: result.emotionFeedback
    };
    if (result.disabled) {
      // §8.16 / §8.15：连续 3 次 negative → 自动停用留痕
      this.appendLog(logs, {
        ...baseRecord,
        event: 'disabled',
        decision: 'auto_disabled',
        reason: '连续 3 次 negative，自动停用（§8.15）'
      });
    } else {
      // §8.16：每次调用后的反馈结算
      this.appendLog(logs, {
        ...baseRecord,
        event: 'called',
        decision: `feedback_${kind}`,
        reason: `调用后 2 轮内反馈：${kind}`
      });
    }
    if (result.needsReview) {
      // 30 天累计 5 次 negative：标记待复议，留给管理员决定是否删（§8.15）
      this.appendLog(logs, {
        ...baseRecord,
        event: 'reconsider',
        decision: 'needs_review',
        reason: '30 天内累计 5 次 negative，待人工复议'
      });
      this.notifyCreation({
        type: 'auto-tool-reconsider',
        toolName,
        needText: result.tool.origin?.needText || '',
        note: '该自建工具 30 天内累计 5 次负面反馈，请人工决定是否停用'
      }, { fingerprint: result.tool.origin?.fingerprint || '', needText: result.tool.origin?.needText || '' }, null, null, null);
    }

    if (result.disabled) {
      console.log(`[情感工具] 自建工具 ${toolName} 连续 3 次负面反馈，已自动停用`);
    }
  }

  // trust 只由工具实测反馈驱动，且只在累计跨过 3 次时结算一次（§8.9）：
  // 「创建成功就加分」会自激——创建免审批后尤其如此，故创建动作本身不触碰 trust
  applyTrustFromFeedback(tool, kind) {
    const users = (tool.origin && Array.isArray(tool.origin.userIds)) ? tool.origin.userIds : [];
    if (users.length === 0) return;
    let delta = 0;
    if (kind === 'positive' && tool.emotionFeedback.positive === 3) {
      delta = 0.15;
    } else if (kind === 'negative' && tool.emotionFeedback.negative === 3) {
      delta = -0.10;
    }
    if (delta === 0) return;
    for (const owner of users) {
      const current = Number.isFinite(this.data.trust[owner]) ? this.data.trust[owner] : 0.5;
      this.data.trust[owner] = clamp01(current + delta);
    }
    this.save();
  }

  // —— P1：留痕（data/tool_creation_logs.json，与 affection_logs.json 同一套追溯风格） ——

  readLogs() {
    try {
      if (!fs.existsSync(this.logPath)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.logPath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('[情感工具] 创建留痕读取失败，改用空档:', error.message);
      return [];
    }
  }

  appendLog(logs, record) {
    try {
      this.ensureStorageDir();
      logs.push(record);
      writeJsonAtomicSync(this.logPath, logs.slice(-LOG_LIMIT));
    } catch (error) {
      console.error('[情感工具] 创建留痕落盘失败:', error.message);
    }
  }
}

module.exports = EmotionLedger;
