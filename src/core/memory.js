const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');
const { withFileLock } = require('../storage/writeLock');
const { cleanTempFiles, quarantineCorruptFiles } = require('../storage/storeGuard');
const storeSchema = require('../storage/storeSchema');
const { createVectorStore } = require('../learning/vectorStore');
// 🧠 类脑记忆生命周期（遗忘/强化/归档/淘汰）纯逻辑，见《类脑记忆生命周期设计方案（v2）》
const memoryLifecycle = require('./memoryLifecycle');
// 🧠 记忆巩固（情景 → 语义）的分组/解析纯逻辑，见方案 §4.5
const memoryConsolidation = require('./memoryConsolidation');
// 🧠 自我模型（反思落地）的规范化/去重/解析纯逻辑，见方案 §4.6
const selfModelModule = require('./selfModel');
// 🕰️ 时间线事件总线：只负责「记下这次真的记住了什么」，失败不阻断记忆主流程
const { getTimeline } = require('./timeline');

// 滚动版归档摘要的固定前缀：只认这个前缀，历史上老格式的【早期对话摘要】不会被改动
const ARCHIVE_SUMMARY_PREFIX = '【早期对话摘要·滚动】';

// 话题聚类：把「同一件事的一系列相关记忆」串成一条线，召回时成组带出，
// 避免「相关事件只捞到零散一两条、上下文拼不完整」
const TOPIC_WINDOW_DAYS = 14;               // 只跟近 14 天的记忆比，太久远的不归为同一话题
const TOPIC_SIM_THRESHOLD = 0.26;           // 字面片段重合度达到这个比例才继承同一话题
const TOPIC_CONTINUITY_MS = 10 * 60 * 1000; // 10 分钟内的连续对话默认同话题（承接上文，别把长聊硬粘成一坨）
const TOPIC_EXPAND_MAX_PER_TOPIC = 2;       // 每个话题最多额外补几条兄弟记忆
const TOPIC_EXPAND_MAX_TOTAL = 3;           // 一次召回最多额外补几条（不让提示词膨胀）

// 🔁 召回合并后的去重与配额（见《召回改造-待审方案》v2 §3.3）
const RECALL_NEAR_DUP_RATIO = 0.9;          // 字面近重复判定用 Dice 系数，超过就当同一条
const RECALL_MAX_PER_TOPIC = 2;             // 同一话题最多进几条，避免一次召回全是同一件事的兄弟
// 🔁 召回不应期：刚被注入过的条目在随后的轮次里不再重复注入（本轮查询字面直中时豁免）
const RECALL_REFRACTORY_ROUNDS = 3;         // 抑制窗口：最近几轮注入过的 id 不再上场
const RECALL_REFRACTORY_MAX_KEYS = 500;     // 内存上限：最多跟多少个会话键，超了丢最早的一个

// 💾 合并落盘的分片预算：单次回调最多重写几个用户档，以及还有剩余时的续排间隔。
// 一个千条档的整档写约 16ms，8 档 ≈ 130ms；不分片时几十个脏键会让事件循环一次停摆半秒
const FLUSH_BATCH_KEYS = 8;
const FLUSH_CONTINUE_DELAY_MS = 200;

// 🫀 自发回忆（心情勾出来的旧事）：与「按查询召回」并行的另一条通道，参数各自独立
const MOOD_RECALL_MIN_AGE_MS = 6 * 60 * 60 * 1000;  // 至少过去 6 小时才算「往事」，刚聊过的不叫想起
const MOOD_RECALL_MIN_INTENSITY = 0.55;             // 快层情绪到这个强度才触发
const MOOD_RECALL_SLOW_INTENSITY = 0.5;             // 快层没劲时，慢层底色到这个强度也能触发
const MOOD_RECALL_COOLDOWN_MS = 15 * 60 * 1000;     // 同一会话同一情绪 15 分钟内最多浮出一次
// 情绪族：当前心情能勾出哪些情绪下发生的事。首项是同类，其余是相近的负面/正面情绪。
// calm 留空数组 = 不触发：平静是背景，不是「忽然想起」的引子；否则 calm 记忆占比高，
// 一平静就翻旧账，反而不像人。
const MOOD_MATCH = {
  happy: ['happy', 'shy'],
  sad: ['sad', 'anxious', 'angry'],
  shy: ['shy', 'happy'],
  anxious: ['anxious', 'sad', 'angry', 'jealous'],
  jealous: ['jealous', 'anxious'],
  dependent: ['dependent', 'happy'],
  calm: [],
  angry: ['angry', 'sad', 'anxious']
};

// 关键词兜底用：这些是虚词/泛指时间词，单独出现不足以定义「同一件事」，
// 避免「都提到明天/下周」这类泛用片段把两件不相干的事强行并成一个话题
const TOPIC_STOP_BIGRAMS = new Set([
  '明天', '今天', '昨天', '后天', '每天', '一天', '这周', '下周', '上周', '周末',
  '上午', '下午', '晚上', '早上', '中午', '现在', '以后', '之前', '时候',
  '一个', '一下', '一些', '什么', '怎么', '可以', '需要', '应该', '记得', '觉得',
  '因为', '所以', '但是', '如果', '还是', '就是', '不能', '一起', '已经',
  '我们', '你们', '他们', '这个', '那个', '我的', '你的', '他的', '然后',
  '而且', '还有', '没有', '不是', '知道', '想要', '打算', '准备'
]);

// 关键词兜底再排除一层：只要片段里含虚词字符（如「要去」「点要」），就不算实词关键词，
// 避免靠一个「要/去/的」之类的字把两件不相干的事粘到一起
const TOPIC_STOP_CHARS = new Set(
  '的了是在和我你他她它们这那有要就都也很把被给对到吗呢吧啊呀哦嗯着过得地还又再只才让使从向为去来'.split('')
);

// 只给控制台看的：key 形如 qq_123456789__role / user_xxxxxxxx__role，
// 只留渠道前缀和末尾 4 位，别让截图把完整账号串露出去 😶
function maskKey(k) {
  return String(k).replace(/^(qq|bili|user)_(.+?)(__(role|ai))?$/i, (m, ch, id, tail) => {
    const t = tail || '';
    return id.length <= 4 ? `${ch}_****${t}` : `${ch}_****${id.slice(-4)}${t}`;
  });
}

// 记忆键的落盘安全基线：userId 来自客户端，键会被 path.join 拼成 `${key}.json`，
// 一旦含路径分隔符（../ 或绝对路径）就能越出 data/ 写到别处，甚至命中他人档。
// 这里只做「负向拒绝」——不用正向白名单（\w 是 ASCII-only，会把中文/空格/emoji 昵称整类误杀）；
// 非法键一律回落 'default' + 告警，不抛错（保住 normalizeScopeKey/baseUserKey 返回值恒为 string 的契约）。
function safeScopeBase(userId) {
  const raw = (typeof userId === 'string' && userId.trim()) ? userId.trim() : 'default';
  if (raw === '.' || raw === '..' || /[/\\]/.test(raw) || raw !== path.basename(raw)) {
    console.warn(`[Memory] 非法记忆键（含路径分隔符或非法段）已回落 default: ${JSON.stringify(raw)}`);
    return 'default';
  }
  return raw;
}

class MemoryModule {
  constructor({ timeline = null } = {}) {
    this.userMemories = {};
    // 时间线可注入（测试可传独立实例）；缺省走进程内单例，与其它模块写进同一份日志
    this.timeline = timeline || getTimeline();
    
    this.SUMMARY_EVENT_THRESHOLD = 20;
    this.SUMMARY_TIME_THRESHOLD = 3600000;

    // 🧠 记忆的向量索引：配了 Qdrant 走远端，否则走进程内本地索引。
    // 本地 JSON 才是真相源，向量只是 best-effort 双写，
    // 实例化失败/索引目录不可用都不影响记忆主流程
    try {
      this.vectorStore = createVectorStore();
    } catch (error) {
      console.warn('[Memory] 向量存储初始化失败，长期记忆只用本地字面召回:', error.message);
      this.vectorStore = null;
    }
    
    this.storagePath = path.join(__dirname, '../../data');

    // 🧠 自我模型（关于「她自己」的稳定认知）：按「用户基础身份」存，
    // 不分角色态/AI 态——她对「他这个人」的认知是跨分档共享的
    this.selfModels = {};
    this.selfModelDir = path.join(this.storagePath, 'self_model');
    // 自我认知变更历史：append-only，只增不改，供「我变了」时反查是哪次反思、依据哪几条记忆
    this.selfModelHistoryDir = path.join(this.selfModelDir, 'history');

    // 🫂 跨会话只读通道的本地索引权重：只在 QQ 引用他人消息时用到（见 server/qq/bridge.js）。
    // 记「谁的记忆条目被引用时真的用上过几次」，落 data/peer_index.json；
    // 不改写对方记忆的任何内容，只影响下次被引用时谁排前面
    this.peerIndexPath = path.join(this.storagePath, 'peer_index.json');
    this.peerIndex = this.loadPeerIndex();
    this._peerFlushTimer = null;

    this.ensureStorageDir();

    // 启动自检：清掉上次崩溃可能残留的原子写临时文件，并把解析不动的记忆文件
    // 改名隔离，避免一条坏文件让整库加载失败（DB-5）
    this.guardUserMemoryStore();

    this.loadAllUserMemories();

    // 🧠 提取强化会产生写入，但召回在正式回复主链路上——不能每次召回都同步写盘。
    // 这里用「脏键 + 节流落盘」合并写入：内存里先改，flushDirty 定时批量落盘
    this._dirtyKeys = new Set();
    // 🔁 召回不应期的内存账本（key -> 最近几轮注入过的 id 集合）：不落盘、不进记忆对象
    this._recallInjections = new Map();
    // 🎞️ 最近一次注入快照（key -> { at, ids }）：只留 id，不落盘、不进记忆对象。
    // 哲学要的是「我变了能指向具体条目」，所以记的是「她那一刻手里是哪几条」，不是正文。
    this._recallSnapshots = new Map();
    this._flushTimer = null;
    this._flushDelayMs = 30 * 1000;          // 30s 合并写一次
    this._lastSweepAtByKey = new Map();       // 各用户上次全量遗忘扫描时间（按 key 分桶）
    this.SWEEP_INTERVAL_MS = 10 * 60 * 1000;  // 遗忘扫描节流：每个用户各自 10 分钟跑一次
    // 记忆落盘失败累计（可读观测字段）：多个调用点忽略 saveUserMemories 返回值，
    // 统一在 saveUserMemories 的 catch 里集中计数，不再逐点加 if
    this.saveFailures = 0;

    // 🧠 自我认知「读即用」同样会产生写入（注入主链路上）——沿用同一套「脏键 + 节流落盘」思路，
    // 但 self_model 走独立的 saveSelfModel 通道，故单列一份脏键与定时器
    this._selfModelDirty = new Set();
    this._selfModelFlushTimer = null;
  }
  
  ensureStorageDir() {
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }
    
    const userMemDir = path.join(this.storagePath, 'user_memories');
    if (!fs.existsSync(userMemDir)) {
      fs.mkdirSync(userMemDir, { recursive: true });
    }

    if (!fs.existsSync(this.selfModelDir)) {
      fs.mkdirSync(this.selfModelDir, { recursive: true });
    }
  }

  // 记忆库启动自检：清残留临时文件 + 隔离坏文件。失败只告警，不阻断启动
  guardUserMemoryStore() {
    const userMemDir = path.join(this.storagePath, 'user_memories');
    try {
      const removed = cleanTempFiles(userMemDir);
      if (removed.length > 0) {
        console.warn(`[Memory] 清理了 ${removed.length} 个残留临时文件`);
      }
      const report = quarantineCorruptFiles(userMemDir);
      report.quarantined.forEach(({ file, to, error }) => {
        console.warn(`[Memory] 记忆文件损坏已隔离: ${file}${to ? ` → ${to}` : ''}（${error}）`);
      });
    } catch (error) {
      console.warn('[Memory] 记忆库启动自检失败（忽略，继续加载）:', error.message);
    }
  }
  
  // 记忆分区键：把裸 userId 规范成「用户 + 记忆分区」的档名
  //  - role：角色态记忆（扮演角色期间产生的记忆），默认
  //  - ai  ：AI 态记忆（元层面交互：查代码/跑脚本/系统自检等）
  // 已带分档后缀的键原样返回（幂等）；角色态只读 role 档，AI 态由上层合并读取两档
  normalizeScopeKey(userId, scope = 'role') {
    const base = safeScopeBase(userId);
    if (/__(?:role|ai)$/.test(base)) return base;
    return `${base}__${scope === 'ai' ? 'ai' : 'role'}`;
  }

  // 自我模型的存储键：剥掉角色态/AI 态分档后缀，回到「这个用户本人」。
  // 这样 ledger（用裸 userId 写）与提示词注入（用分档键读）能对齐到同一份自我认知
  baseUserKey(userId) {
    const base = safeScopeBase(userId);
    return base.replace(/__(?:role|ai)$/, '') || 'default';
  }

  // 称呼表：角色对用户这个人的认知——她把用户叫什么、用户把她叫什么。
  // 由模型在对话里用 record_address 工具认定后落在这里，之后每轮当既定事实注入。
  // 原先只靠提示词里一条软约束 + 最近几条历史，历史一被截断或换个会话就漂
  normalizeAddress(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      roleCallsUser: typeof source.roleCallsUser === 'string' ? source.roleCallsUser.trim() : '',
      userCallsRole: typeof source.userCallsRole === 'string' ? source.userCallsRole.trim() : '',
      updatedAt: Number(source.updatedAt) || 0
    };
  }

  getAddress(userId = 'default') {
    const userStore = this.getUserMemoryStore(userId);
    return this.normalizeAddress(userStore.address);
  }

  // 默认只覆盖传进来且非空的那一侧（模型这轮可能只报了「他对她的称呼」）；
  // replace:true 时按面板提交的内容整份覆写，允许把某一侧清空
  setAddress(userId = 'default', patch = {}, { replace = false } = {}) {
    const userStore = this.getUserMemoryStore(userId);
    const current = this.normalizeAddress(userStore.address);
    const pick = (value, fallback) => {
      if (typeof value !== 'string') return replace ? '' : fallback;
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      return replace ? '' : fallback;
    };

    const next = {
      roleCallsUser: pick(patch.roleCallsUser, current.roleCallsUser),
      userCallsRole: pick(patch.userCallsRole, current.userCallsRole),
      updatedAt: Date.now()
    };

    if (next.roleCallsUser === current.roleCallsUser && next.userCallsRole === current.userCallsRole) {
      return current;
    }

    userStore.address = next;
    this.saveUserMemories(userId);
    console.log(`[Memory] 用户 ${this.normalizeScopeKey(userId)} 的称呼已更新：她叫他「${next.roleCallsUser || '—'}」/ 他叫她「${next.userCallsRole || '—'}」`);
    return next;
  }

  // 存量迁移：把早期没有分区后缀的 xxx.json 改名成 xxx__role.json（全部归为角色态）。
  // 幂等，失败只警告不阻断启动；.bak 备份与已分档的文件都跳过
  migrateScopeFiles() {
    const userMemDir = path.join(this.storagePath, 'user_memories');
    if (!fs.existsSync(userMemDir)) return;

    let migrated = 0;
    fs.readdirSync(userMemDir).forEach(file => {
      if (!file.endsWith('.json') || file.includes('.bak')) return;
      const name = file.slice(0, -'.json'.length);
      if (name.includes('__')) return;
      const from = path.join(userMemDir, file);
      const to = path.join(userMemDir, `${name}__role.json`);
      if (fs.existsSync(to)) return;
      try {
        fs.renameSync(from, to);
        migrated++;
      } catch (error) {
        console.warn(`[Memory] 存量记忆迁移失败（保持原样）: ${file}`, error.message);
      }
    });
    if (migrated > 0) {
      console.log(`[Memory] 存量记忆已归入角色态分档：${migrated} 个文件 → *__role.json`);
    }
  }

  // 角色改名归并：QQ 端的记忆键里带角色名（qq_<号>_<角色名>__role），改一次名，
  // 同一个人的记忆就裂成两份、旧的再也读不到。这里按「曾用名」把旧档并进新档。
  // aliases: { '<旧键不含后缀>': '<新键不含后缀>' }，如 { 'qq_123_旧名': 'qq_123_新名' }
  // 只并档案不删数据：旧档改名成 *.merged-<时间>.bak，loadAllUserMemories 会跳过
  mergeAliasedMemories(aliases) {
    const userMemDir = path.join(this.storagePath, 'user_memories');
    if (!fs.existsSync(userMemDir) || !aliases || typeof aliases !== 'object') return [];

    const report = [];
    Object.entries(aliases).forEach(([fromBase, toBase]) => {
      if (!fromBase || !toBase || fromBase === toBase) return;
      ['role', 'ai'].forEach(scope => {
        const fromKey = `${fromBase}__${scope}`;
        const toKey = `${toBase}__${scope}`;
        const fromFile = path.join(userMemDir, `${fromKey}.json`);
        const toFile = path.join(userMemDir, `${toKey}.json`);
        if (!fs.existsSync(fromFile)) return;

        try {
          // 目标档还不存在：直接改名，等于把旧记忆挪过去
          if (!fs.existsSync(toFile)) {
            fs.renameSync(fromFile, toFile);
            delete this.userMemories[fromKey];
            this.loadUserMemories(toKey);
            report.push({ from: fromKey, to: toKey, mode: 'moved' });
            return;
          }

          const fromStore = this.readMemoryFile(fromFile);
          const toStore = this.readMemoryFile(toFile);
          if (!fromStore || !toStore) return;
          const merged = this.mergeMemoryFileData(toStore, fromStore);
          withFileLock(toFile, () => {
            writeJsonAtomicSync(toFile, storeSchema.stampVersion(merged, storeSchema.CURRENT_VERSIONS.userMemory));
          });
          fs.renameSync(fromFile, `${fromFile}.merged-${Date.now()}.bak`);
          delete this.userMemories[fromKey];
          this.loadUserMemories(toKey);
          report.push({ from: fromKey, to: toKey, mode: 'merged', memories: merged.memories.length });
        } catch (error) {
          console.warn(`[Memory] 角色改名归并失败（保持原样）: ${maskKey(fromKey)}`, error.message);
        }
      });
    });

    if (report.length > 0) {
      console.log(`[Memory] 角色改名归并完成：${report.map(r => `${maskKey(r.from)}→${maskKey(r.to)}(${r.mode})`).join('，')}`);
      // 归并只搬本地档案：云端向量点的 payload.userId 仍是旧键，按新键检索一条也搜不到。
      // 归并后补一次索引（异步，不阻塞改名流程）
      report.forEach((item) => {
        this.reconcileVectorIndex(item.to).catch((error) => {
          console.warn(`[Memory] 改名归并后补索引失败（${maskKey(item.to)}）:`, error.message);
        });
      });
    }
    return report;
  }

  readMemoryFile(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      console.warn(`[Memory] 读取记忆档失败，跳过归并: ${path.basename(filePath)}`, error.message);
      return null;
    }
  }

  // 合并两份记忆档：情景条目按 id（无 id 时按内容+时间）去重取并集，
  // 滚动摘要只留一条（新档优先，旧档补位），其余计数类字段取较大/较新的一方
  mergeMemoryFileData(toStore, fromStore) {
    const isSummary = (m) => m && typeof m.data === 'string' && m.data.startsWith(ARCHIVE_SUMMARY_PREFIX);
    const pickSummary = (list) => (Array.isArray(list) ? list.filter(isSummary) : []).pop() || null;
    const toSummary = pickSummary(toStore.memories);
    const fromSummary = pickSummary(fromStore.memories);

    const keyOf = (m) => (m.id !== undefined && m.id !== null ? `id:${m.id}` : `d:${m.data}|${m.timestamp || ''}`);
    const byKey = new Map();
    // 先旧后新：同一 id 以新档为准
    [...(Array.isArray(fromStore.memories) ? fromStore.memories : []),
      ...(Array.isArray(toStore.memories) ? toStore.memories : [])].forEach(m => {
      if (!m || typeof m !== 'object' || isSummary(m)) return;
      byKey.set(keyOf(m), m);
    });
    const memories = [...byKey.values()].sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
    const summary = toSummary || fromSummary;
    if (summary) memories.push(summary);

    const dedupeConcat = (a, b) => {
      const seen = new Set();
      return [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].filter(item => {
        const key = JSON.stringify(item);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    return {
      memories,
      relationshipScore: Math.max(Number(toStore.relationshipScore) || 0, Number(fromStore.relationshipScore) || 0),
      summaryMemory: dedupeConcat(toStore.summaryMemory, fromStore.summaryMemory),
      tombstones: dedupeConcat(toStore.tombstones, fromStore.tombstones),
      lastSummaryTime: Math.max(Number(toStore.lastSummaryTime) || 0, Number(fromStore.lastSummaryTime) || 0),
      eventsSinceLastSummary: Math.max(Number(toStore.eventsSinceLastSummary) || 0, Number(fromStore.eventsSinceLastSummary) || 0),
      emotionHistory: [...(Array.isArray(fromStore.emotionHistory) ? fromStore.emotionHistory : []),
        ...(Array.isArray(toStore.emotionHistory) ? toStore.emotionHistory : [])].slice(-2000),
      address: toStore.address || fromStore.address || this.normalizeAddress(null)
    };
  }

  createUserMemoryStore(userId) {
    userId = this.normalizeScopeKey(userId);

    if (!this.userMemories[userId]) {
      this.userMemories[userId] = {
        memories: [],
        relationshipScore: 0,
        emotionHistory: [],
        summaryMemory: [],
        tombstones: [],
        lastSummaryTime: Date.now(),
        eventsSinceLastSummary: 0,
        address: this.normalizeAddress(null),
        initialized: false
      };
    }
    
    return this.userMemories[userId];
  }
  
  getUserMemoryStore(userId) {
    userId = this.normalizeScopeKey(userId);

    return this.userMemories[userId] || this.createUserMemoryStore(userId);
  }
  
  saveUserMemories(userId) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const userMemDir = path.join(this.storagePath, 'user_memories');
    
    const data = {
      memories: userStore.memories,
      relationshipScore: userStore.relationshipScore,
      summaryMemory: userStore.summaryMemory,
      tombstones: userStore.tombstones || [],
      lastSummaryTime: userStore.lastSummaryTime,
      eventsSinceLastSummary: userStore.eventsSinceLastSummary,
      emotionHistory: userStore.emotionHistory,
      address: this.normalizeAddress(userStore.address)
    };
    
    const filePath = path.join(userMemDir, `${key}.json`);
    // 前向兼容守卫（方向二）：磁盘档来自更新版本时拒绝降级覆盖——否则
    // 「升级写过一次 → 降级跑一次」就把新版本才认识的字段抹掉，且无法回滚
    if (userStore.futureVersion) {
      console.warn(`[Memory] 用户 ${key} 的记忆档来自更新版本，拒绝降级写入`);
      return false;
    }
    try {
      // 落盘前盖上结构版本号（方向二）：格式演进后可识别旧档、可迁移/回滚
      // 整档写加文件锁（方向二·持久化并发）：与其它进程的写尽力串行化；
      // 抢不到锁时 fail-open 照常写（可用性优先），故只降低、不能根除交错写坏的可能
      withFileLock(filePath, () => {
        // 记忆档只给机器读，不要缩进：千条档实测体积 -28.6%（625KB→446KB），
        // 序列化耗时 -35%（16ms→10.3ms）；省下的是每次落盘的真实 CPU 与 I/O
        writeJsonAtomicSync(filePath, storeSchema.stampVersion(data, storeSchema.CURRENT_VERSIONS.userMemory), 0);
      });
      // 不再逐档打成功日志：合并落盘一次刷多个键，这行会把日志刷成噪声，写失败仍会打
      return true;
    } catch (error) {
      // 写失败必须让调用方知道（方向二）：返回值 = 是否真的落盘成功，调用方据此决定是否报成功。
      // 其余忽略返回值的调用点不逐点加 if，统一在这里集中计数 + 首次告警（可读字段 this.saveFailures）
      this.saveFailures = (this.saveFailures || 0) + 1;
      console.error(`[Memory] 保存用户 ${key} 记忆失败:`, error);
      if (this.saveFailures === 1) {
        console.warn('[Memory] 记忆落盘开始出现失败（首次告警）；后续失败只累计在 this.saveFailures，不再逐条刷屏');
      }
      return false;
    }
  }
  
  loadUserMemories(userId) {
    const key = this.normalizeScopeKey(userId);
    const userMemDir = path.join(this.storagePath, 'user_memories');
    const filePath = path.join(userMemDir, `${key}.json`);
    
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // 前向兼容守卫（方向二）：档来自更新构建时告警——继续按当前字段兜底读取，
        // 但不静默假装一切正常，便于发现「降级后读旧档」的情况
        const futureVersion = storeSchema.isFutureVersion(data, storeSchema.CURRENT_VERSIONS.userMemory);
        if (futureVersion) {
          console.warn(`[Memory] 用户 ${maskKey(key)} 的记忆档版本 ${storeSchema.readVersion(data)} 高于当前 ${storeSchema.CURRENT_VERSIONS.userMemory}，可能由更新版本写入`);
        }
        this.userMemories[key] = {
          memories: data.memories || [],
          relationshipScore: data.relationshipScore || 0,
          emotionHistory: data.emotionHistory || [],
          summaryMemory: data.summaryMemory || [],
          tombstones: data.tombstones || [],
          lastSummaryTime: data.lastSummaryTime || Date.now(),
          eventsSinceLastSummary: data.eventsSinceLastSummary || 0,
          address: this.normalizeAddress(data.address),
          initialized: true,
          // 标记来源版本：本档来自更新版本时，saveUserMemories 拒绝降级覆盖
          futureVersion
        };
        console.log(`[Memory] 加载了用户 ${maskKey(key)} 的 ${this.userMemories[key].memories.length} 条记忆`);
      } catch (error) {
        console.error(`[Memory] 加载用户 ${maskKey(key)} 记忆失败:`, error);
        this.createUserMemoryStore(key);
      }
    } else {
      this.createUserMemoryStore(key);
    }
  }
  
  loadAllUserMemories() {
    const userMemDir = path.join(this.storagePath, 'user_memories');

    // 先做一次存量归档：老的无后缀记忆全部落到角色态分档
    this.migrateScopeFiles();
    
    if (fs.existsSync(userMemDir)) {
      const files = fs.readdirSync(userMemDir);
      files.forEach(file => {
        if (file.endsWith('.json') && !file.includes('.bak')) {
          const userId = file.replace('.json', '');
          this.loadUserMemories(userId);
        }
      });
    }
  }

  // 写入一条长期记忆：data 存用户的原话（缺失时退回语义场景摘要），供后续召回注入提示词
  // userId 可带分区后缀（xxx__ai）；不带的按角色态处理——落库、向量、好感度、摘要都跟同一个键走
  // 返回 { stored, queued, memory }：stored=是否记住一条内容（false=内容被过滤）；
  // queued=已进待落盘队列（真正写盘失败只会累计在 saveFailures，调用方不再逐条感知）；
  // memory=构造出的记忆条目
  storeMemory(processedInput, userId = 'default', rawText = '', options = {}) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const value = Number(processedInput?.value) || 0;
    // 🗣️ 谁说的：QQ 引用她自己的话、自主发言这类内容必须带 self，
    // 否则召回注入时会被当成「用户说过的事」，她就会把自己说过的话安到对方头上
    const speaker = options.speaker || (processedInput && processedInput.speaker) || '';
    const source = options.source ? String(options.source) : '';
    const text = (typeof rawText === 'string' && rawText.trim().length > 0)
      ? rawText.trim()
      : (typeof processedInput?.scene === 'string' ? processedInput.scene.trim() : '');
    // 主情绪强度：写入时就拿得到的、除情绪值外的第二个 salience 信号（P2/DB-3）
    const emotionIntensity = this.emotionIntensityOf(processedInput?.emotion);

    const memory = {
      id: Date.now() + Math.random(),
      type: 'text',
      timestamp: Date.now(),
      value,
      data: text,
      emotion: processedInput?.emotion || null,
      created_at: new Date(),
      // 🧠 类脑记忆生命周期字段（老数据缺字段时各方法按默认值兜底，向后兼容）
      salience: memoryLifecycle.initialSalience(value, { intensity: emotionIntensity }), // 0~1 显著性：决定遗忘速度
      recallCount: 0,        // 只归「提取强化」：被召回次数
      lastRecallAt: 0,       // 上次被召回时间（衰减基准）
      tier: 'episodic',      // 'episodic' | 'semantic' | 'archived'
      modality: 'text',      // 阶段 1 只占位，多模态汇入留到阶段 4
      consolidatedInto: null, // 被巩固进语义记忆时指向目标 id（阶段 2）
      pinned: false,          // 被用户钉住：豁免衰减/归档/淘汰/强化改写（DB-4）
      // 来源归属：'user' 用户说的 / 'self' 她自己说的；老数据没有这个字段，按用户说的处理
      ...(speaker ? { speaker } : {}),
      ...(source ? { source } : {})
    };

    // 没有可记住的内容时不落库，避免留下只有 id 的空壳记忆
    if (text.length > 0) {
      // 给这条记忆打话题标识：与近 14 天的记忆做字面重合匹配，够像就归入同一话题，
      // 否则开一个新话题（用自身 id 当话题号）。归档摘要这类系统生成的长文不参与聚类
      if (!text.startsWith('【')) {
        memory.topicId = this.assignTopicId(key, text, memory.id);
      }
      // 新开话题=高新颖度，并入旧话题=低：作为 salience 初值的第三个可得信号（P2/DB-3）
      const novelty = (memory.topicId && String(memory.topicId) !== String(memory.id)) ? 0 : 1;
      memory.salience = memoryLifecycle.initialSalience(value, { intensity: emotionIntensity, novelty });
      userStore.memories.push(memory);
      // 淘汰改为按「记得多牢」决定：先做遗忘归档扫描（节流），再按 retention 淘汰超出容量的
      this.maintainStore(key);
      // 🧠 本地落完后异步双写一份向量，不 await、不阻塞回复，云端挂了只警告
      this.queueVectorUpsert(key, memory);
    }

    // 正文以【开头的是系统生成的摘要（滚动归档摘要等），不是「用户/她的经历」：
    // 不计好感度、不抬高滚动摘要的触发计数，否则摘要自己会把计数喂大，加速再摘要。
    // 它们仍照常入库、进入衰减/遗忘链路，只是不参与对话侧的统计。
    // 她自己主动说的话（speaker='self'）同样只是经历，不算「用户的互动」。
    const isSystemSummary = text.startsWith('【');
    const countsAsUser = !isSystemSummary && (!speaker || speaker === 'user');
    if (countsAsUser) {
      this.updateRelationshipScore(value, memory.type, key);
      userStore.eventsSinceLastSummary++;
      if (this.shouldGenerateSummary(key)) {
        this.generateSummaryMemory(key);
      }
    }

    // 写盘移出请求链路：只标脏，由 30s 合并落盘统一处理。
    // 以前每条记忆都在这里整档序列化 + 同步写（千条档约 16ms），整个进程停摆。
    // 代价：进程崩溃会丢掉最多一个落盘周期内的新记忆（本地 JSON 之外的向量索引仍会保留）
    this.markDirty(key);

    // 🕰️ 时间线：记忆真的入库后才记一笔（内容被过滤时不记，宁可漏记也不虚构）。
    // 只追加一行、不 fsync，微秒级；失败只告警计数，绝不影响回复
    if (this.timeline && memory.data && text.length > 0) {
      this.timeline.append(key, 'memory.created', {
        mid: String(memory.id),
        text: text.slice(0, 500),
        scene: typeof processedInput?.scene === 'string' ? processedInput.scene.slice(0, 200) : '',
        speaker: speaker || ''
      });
    }

    // 三类结果分开交给调用方（而不是塌进同一个 else）：内容被过滤 / 已排队落盘
    return { stored: text.length > 0, queued: true, memory };
  }

  // 🧠 阶段 4｜多模态汇入：把视觉/屏幕记忆（camera/screen 的文字总结）写进主记忆生命周期。
  // 与 storeMemory 的差异：没有「用户原话」，不参与好感度与滚动摘要计数，
  // 但和普通情景记忆一样进入 salience / 遗忘 / 提取强化 / 巩固链路（modality 标明来源）。
  // scope 走与文本记忆一致的分区规则：camera/screen 是 AI 态专属，正常落到 *__ai 档
  storeVisualMemory(userId = 'default', { summary = '', imagePath = '', modality = 'vision', scope = 'role', question = '' } = {}) {
    const key = this.normalizeScopeKey(userId, scope);
    const text = typeof summary === 'string' ? summary.trim() : '';
    if (text.length === 0) return null;
    const userStore = this.getUserMemoryStore(key);
    // 只认三种来源：vision（摄像头）/ screen（屏幕）/ audio（暂未接入）→ 其余一律归 vision
    const mode = (modality === 'screen' || modality === 'audio') ? modality : 'vision';
    const memory = {
      id: Date.now() + Math.random(),
      type: 'text',
      timestamp: Date.now(),
      value: 0,
      data: text,
      emotion: null,
      created_at: new Date(),
      // 看到的是一段「可见事实」，不按对话情感加权，给中性初值 0.3
      salience: memoryLifecycle.initialSalience(0),
      recallCount: 0,
      lastRecallAt: 0,
      tier: 'episodic',
      modality: mode,          // 'vision' | 'screen'：与文本模态共享同一套生命周期
      consolidatedInto: null,
      pinned: false,           // 视觉记忆默认不钉住（可由用户钉住，DB-4）
      visualSource: mode,      // 便于将来区分「她看到的」与「他说的」
      imagePath: imagePath ? String(imagePath) : '',
      question: typeof question === 'string' ? question.trim() : ''
    };
    // 与同期文本记忆做话题聚类，使其能被「按话题补齐」成组带出
    memory.topicId = this.assignTopicId(key, text, memory.id);
    userStore.memories.push(memory);
    this.maintainStore(key);
    this.queueVectorUpsert(key, memory);
    // 与文本记忆同一条写盘策略：标脏后由合并落盘处理，不在采集热路径上整档重写
    this.markDirty(key);
    console.log(`[Memory] 已汇入${mode === 'screen' ? '屏幕' : '视觉'}记忆（${maskKey(key)}）：${text.slice(0, 40)}`);
    return memory;
  }

  // 取当前滚动版归档摘要的正文（不含前缀），没有时返回空串
  getArchiveSummary(userId = 'default') {
    const userStore = this.getUserMemoryStore(userId);
    for (let i = userStore.memories.length - 1; i >= 0; i--) {
      const text = userStore.memories[i] && userStore.memories[i].data;
      if (typeof text === 'string' && text.startsWith(ARCHIVE_SUMMARY_PREFIX)) {
        return text.slice(ARCHIVE_SUMMARY_PREFIX.length).trim();
      }
    }
    return '';
  }

  // 覆写当前滚动版归档摘要：这类摘要始终只留一条，原先没有才新建
  // 老格式的【早期对话摘要】不匹配前缀，保持原样不动
  upsertArchiveSummary(userId = 'default', summary = '') {
    const body = typeof summary === 'string' ? summary.trim() : '';
    if (body.length === 0) return null;

    const userStore = this.getUserMemoryStore(userId);
    const text = `${ARCHIVE_SUMMARY_PREFIX}${body}`;

    for (let i = userStore.memories.length - 1; i >= 0; i--) {
      const memory = userStore.memories[i];
      if (memory && typeof memory.data === 'string' && memory.data.startsWith(ARCHIVE_SUMMARY_PREFIX)) {
        memory.data = text;
        memory.timestamp = Date.now();
        memory.created_at = new Date();
        this.saveUserMemories(userId);
        return memory;
      }
    }

    return this.storeMemory({ value: 0, scene: text }, userId, text).memory;
  }

  // 🧠 巩固（阶段 2）：挑出可被抽象成「语义结论」的情景记忆候选（纯逻辑在 memoryConsolidation）
  getConsolidationCandidates(userId = 'default', opts = {}) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const candidates = memoryConsolidation.selectCandidates(userStore.memories, opts);
    // 语义巩固产出的是「关于用户/这段关系的稳定认识」；
    // 她自己说过的话（引用或主动发言）不能拿来蒸成对方的结论
    return Array.isArray(candidates)
      ? candidates.filter(item => item && item.speaker !== 'self')
      : candidates;
  }

  // 🧠 批量取向量（巩固分组用）：向量库不可用或任一条失败都返回 null，
  // 让上层退化为「字面相似」粗分组，功能不中断
  async embedTexts(texts) {
    const list = Array.isArray(texts) ? texts : [];
    if (!this.vectorStore || !this.vectorStore.isEnabled()) return null;
    try {
      const vectors = [];
      for (const text of list) {
        const vector = await this.vectorStore.embed(text);
        vectors.push(Array.isArray(vector) ? vector : null);
      }
      return vectors;
    } catch (error) {
      console.warn('[Memory] 巩固取向量失败，退化为字面聚类:', error.message);
      return null;
    }
  }

  // 🧠 写回一条语义记忆（学习产物）。直接构造而不走 storeMemory：
  // 语义记忆没有「用户原话」语义，也没有话题聚类/好感度主链路，走 storeMemory 会产生副作用
  // kind：区分用途——缺省（null）是「巩固结论」；'association' 是 REM 跨话题联想。
  //   联想条刻意**不进**语义注入池/自我模型素材（见下方 getSemantic* 的过滤），避免污染既有结论；
  //   它只带 confidence + 溯源，供观察与按 id 回滚。
  upsertSemanticMemory(userId = 'default', text, { sourceIds = [], kind = null, confidence = null } = {}) {
    const key = this.normalizeScopeKey(userId);
    const content = typeof text === 'string' ? text.trim() : '';
    if (content.length === 0) return null;
    const userStore = this.getUserMemoryStore(key);
    const memory = {
      id: Date.now() + Math.random(),
      type: 'text',
      timestamp: Date.now(),
      value: 0,
      data: content,
      emotion: null,
      created_at: new Date(),
      salience: 0.7,          // 语义结论是「学到的稳定认识」，给较高初值
      recallCount: 0,
      lastRecallAt: 0,
      tier: 'semantic',       // 耐久条目：不衰减/不归档/不进淘汰池（见 memoryLifecycle.isDurable）
      modality: 'text',
      kind: kind || null,     // null=巩固结论；'association'=REM 联想（不注入提示词）
      confidence: (confidence != null && Number.isFinite(Number(confidence))) ? Number(confidence) : null,
      consolidatedInto: null,
      sourceMemoryIds: (Array.isArray(sourceIds) ? sourceIds : []).map(String)
    };
    userStore.memories.push(memory);
    this.queueVectorUpsert(key, memory);
    this.saveUserMemories(key);
    console.log(`[Memory] 已巩固出语义记忆（${maskKey(key)}，源 ${memory.sourceMemoryIds.length} 条）: ${content.slice(0, 40)}`);
    return memory;
  }

  // 🧠 标注源情景记忆：指向语义记忆并把 salience 减半、转 archived，
  // 使其不再长期占召回池与 token（同时也让它们不再进入下一轮巩固候选）
  linkConsolidated(userId = 'default', { sourceIds = [], semanticId = null } = {}) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const ids = new Set((Array.isArray(sourceIds) ? sourceIds : []).map(String));
    if (ids.size === 0) return 0;
    let changed = 0;
    for (const memory of userStore.memories) {
      if (!memory || !ids.has(String(memory.id))) continue;
      memory.consolidatedInto = semanticId != null ? String(semanticId) : null;
      memory.tier = 'archived';
      const base = memory.salience != null
        ? memoryLifecycle.clamp01(memory.salience)
        : memoryLifecycle.initialSalience(memory.value);
      memory.salience = base * 0.5;
      changed++;
    }
    if (changed > 0) this.saveUserMemories(key);
    return changed;
  }

  // 🧠 巩固透明（DB-6）：从一条语义记忆反查它汇总的全部源情景记忆（复用 consolidatedInto 溯源）。
  // 只读，不落盘——供「是谁把哪几段整理成了哪条经验」的透明度查询/呈现
  getConsolidatedSources(userId = 'default', semanticId) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    return memoryConsolidation.findConsolidatedSources(userStore.memories, semanticId);
  }

  // 🧠 巩固透明（DB-6）：回滚一条语义结论——把它汇总的源情景记忆复原（清溯源/回 episodic/还原
  // 被减半的 salience），并移除该语义记忆本身。返回 { restored, removed }。
  // 注意：向量库无删除接口，本地移除后其残留向量点不再参与本地语义注入（以本地 JSON 为准）
  rollbackConsolidation(userId = 'default', semanticId) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const id = String(semanticId);
    let restored = 0;
    for (const memory of memoryConsolidation.findConsolidatedSources(userStore.memories, id)) {
      if (memoryConsolidation.restoreConsolidatedSource(memory)) restored++;
    }
    const before = userStore.memories.length;
    userStore.memories = userStore.memories.filter(memory => !(memory && String(memory.id) === id));
    const removed = before !== userStore.memories.length;
    if (restored > 0 || removed) this.saveUserMemories(key);
    return { restored, removed };
  }

  // 🧠 巩固期去重（方向一②）：取某分区内全部原始记忆（只读，供 planDedupMerge 扫描）。
  // 返回数组引用；planDedupMerge 只读不改，调用方据计划再走 applyDedupMerge。
  getDedupMemories(userId = 'default') {
    return this.getUserMemoryStore(userId).memories;
  }

  // 🧠 巩固期去重合并（方向一②）：按 planDedupMerge 产出的组，把「归一化正文完全相同」的情景记忆
  // 合并成一条。保留条聚合权重（recallCount 求和 / salience 不降 / lastRecallAt 取最新），被并入条
  // 转 archived 退出召回池并留溯源——与语义巩固同款「可回滚」。pinned / 系统 / 已归档条目本就不在
  // 组内，绝不被触碰。只改涉及到的记忆，有变化才落盘。
  applyDedupMerge(userId = 'default', groups = []) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const list = Array.isArray(groups) ? groups : [];
    if (list.length === 0) return { groups: 0, merged: 0 };

    const byId = new Map();
    for (const memory of userStore.memories) {
      if (memory && memory.id != null) byId.set(String(memory.id), memory);
    }

    let doneGroups = 0;
    let mergedCount = 0;
    for (const group of list) {
      const keep = byId.get(String(group && group.keepId));
      if (!keep) continue;
      const merged = (Array.isArray(group.mergeIds) ? group.mergeIds : [])
        .map(id => byId.get(String(id)))
        .filter(memory => memory && memory !== keep);
      if (merged.length === 0) continue;

      const baseRecall = Number(keep.recallCount) || 0;
      const addedRecall = merged.reduce((sum, memory) => sum + (Number(memory.recallCount) || 0), 0);
      const baseSalience = memoryConsolidation.salienceOf(keep);
      const topSalience = merged.reduce(
        (max, memory) => Math.max(max, memoryConsolidation.salienceOf(memory)),
        baseSalience
      );
      const topRecallAt = merged.reduce(
        (max, memory) => Math.max(max, Number(memory.lastRecallAt) || 0),
        Number(keep.lastRecallAt) || 0
      );

      // 回滚快照：只记第一次合并前的自身显著性；recallCount 汇总量按次累加，回滚时一并扣回
      if (keep.mergedSalienceBefore == null) keep.mergedSalienceBefore = baseSalience;
      keep.recallCount = baseRecall + addedRecall;
      keep.mergedRecallCount = (Number(keep.mergedRecallCount) || 0) + addedRecall;
      keep.salience = memoryLifecycle.clamp01(topSalience);
      keep.lastRecallAt = topRecallAt;
      keep.mergedIds = Array.from(new Set([
        ...(Array.isArray(keep.mergedIds) ? keep.mergedIds : []),
        ...merged.map(memory => String(memory.id))
      ]));

      // 被并入条：留溯源、转归档、salience 减半（与 linkConsolidated 同款：退出召回池但可回滚）
      for (const memory of merged) {
        memory.mergedInto = String(keep.id);
        memory.tier = 'archived';
        memory.salience = memoryLifecycle.clamp01(memoryConsolidation.salienceOf(memory) * 0.5);
      }

      doneGroups++;
      mergedCount += merged.length;
    }

    if (doneGroups > 0) this.saveUserMemories(key);
    return { groups: doneGroups, merged: mergedCount };
  }

  // 🧠 去重合并回滚（DB-6 同款透明）：把 mergedInto 指向 keepId 的条目复原（清溯源 / 回 episodic /
  // salience ×2），并把保留条被聚合进来的权重扣回（recallCount 减掉汇总量、salience 还原到合并前）。
  // 返回 { restored, kept }；非目标回滚无副作用。
  rollbackDedupMerge(userId = 'default', keepId) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const id = String(keepId);
    const keep = userStore.memories.find(memory => memory && String(memory.id) === id) || null;

    let restored = 0;
    for (const memory of userStore.memories) {
      if (!memory || memory.mergedInto == null || String(memory.mergedInto) !== id) continue;
      memory.mergedInto = null;
      memory.tier = 'episodic';
      const base = memory.salience != null
        ? memoryLifecycle.clamp01(memory.salience)
        : memoryLifecycle.initialSalience(memory.value);
      memory.salience = memoryLifecycle.clamp01(base * 2);
      restored++;
    }

    let keepTouched = false;
    if (keep) {
      if (keep.mergedRecallCount != null) {
        keep.recallCount = Math.max(0, (Number(keep.recallCount) || 0) - (Number(keep.mergedRecallCount) || 0));
        keep.mergedRecallCount = null;
        keepTouched = true;
      }
      if (keep.mergedSalienceBefore != null) {
        keep.salience = memoryLifecycle.clamp01(keep.mergedSalienceBefore);
        keep.mergedSalienceBefore = null;
        keepTouched = true;
      }
      if (Array.isArray(keep.mergedIds) && keep.mergedIds.length > 0) {
        keep.mergedIds = [];
        keepTouched = true;
      }
    }

    if (restored > 0 || keepTouched) this.saveUserMemories(key);
    return { restored, kept: !!keep };
  }

  // 🧠 去重合并的可恢复入口（DB-6 同款透明）：列出「曾被去重合并」的保留条及其并入项，
  // 面板/接口据此提供一键撤销（rollbackDedupMerge）。只读，不改动 store。
  getDedupMergedGroups(userId = 'default') {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const groups = [];
    for (const memory of userStore.memories) {
      if (!memory || !Array.isArray(memory.mergedIds) || memory.mergedIds.length === 0) continue;
      const raw = typeof memory.data === 'string' ? memory.data : String(memory.value || '');
      groups.push({
        keepId: String(memory.id),
        text: raw.replace(/\s+/g, ' ').trim().slice(0, 60),
        mergedCount: memory.mergedIds.length,
        mergedIds: memory.mergedIds.map(String)
      });
    }
    return groups;
  }

  // 🧠 语义记忆（学习产物）供提示词独立分区注入：按显著性/时间降序取前 limit 条纯文本。
  // 排除 REM 联想条（kind='association'）——联想只是弱猜测，不进正式注入，避免污染既有结论
  getSemanticMemories(userId = 'default', limit = 5, opts = {}) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const cutoverAt = Number(opts && opts.cutoverAt) || 0;
    return userStore.memories
      .filter(memory => memory && memory.tier === 'semantic' && memory.kind !== 'association'
        && typeof memory.data === 'string' && memory.data.trim().length > 0)
      .sort((a, b) => {
        // 旧人设时期沉淀的结论同样按世代权重折算，新相处里长出来的结论优先
        const diff = memoryConsolidation.salienceOf(b) * this.personaWeight(b, cutoverAt)
          - memoryConsolidation.salienceOf(a) * this.personaWeight(a, cutoverAt);
        if (diff !== 0) return diff;
        return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
      })
      .slice(0, Math.max(0, limit))
      .map(memory => memory.data.trim());
  }

  // 🧠 取语义记忆的完整条目（带 id/时间），供自我模型提炼时溯源与去重（§4.6）。
  // 同 getSemanticMemories：排除 REM 联想条，联想不做自我模型的素材
  getSemanticMemoryEntries(userId = 'default', limit = 5) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    return userStore.memories
      .filter(memory => memory && memory.tier === 'semantic' && memory.kind !== 'association'
        && typeof memory.data === 'string' && memory.data.trim().length > 0)
      .sort((a, b) => {
        const diff = memoryConsolidation.salienceOf(b) - memoryConsolidation.salienceOf(a);
        if (diff !== 0) return diff;
        return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
      })
      .slice(0, Math.max(0, limit))
      .map(memory => ({ id: memory.id, data: memory.data.trim(), timestamp: Number(memory.timestamp) || 0 }));
  }

  // 🧠 REM 跨话题联想（方向一③）：联想条与语义结论分池，由这里显式读，供观察/呈现/回滚。
  // 按 confidence 降序（同分按时间新→旧）取前 limit 条，返回 { id, data, confidence, sourceMemoryIds }
  getAssociationMemories(userId = 'default', limit = 5) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    return userStore.memories
      .filter(memory => memory && memory.tier === 'semantic' && memory.kind === 'association'
        && typeof memory.data === 'string' && memory.data.trim().length > 0)
      .sort((a, b) => {
        const diff = (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
        if (diff !== 0) return diff;
        return (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0);
      })
      .slice(0, Math.max(0, limit))
      .map(memory => ({
        id: memory.id,
        data: memory.data.trim(),
        confidence: Number(memory.confidence) || 0,
        sourceMemoryIds: Array.isArray(memory.sourceMemoryIds) ? memory.sourceMemoryIds.slice() : []
      }));
  }

  // 🧠 自我模型（阶段 3）：关于「她自己」的稳定认知，存 data/self_model/{baseKey}.json。
  // 懒加载 + 缓存，读写都按基础身份键（跨角色态/AI 态共享）
  loadSelfModel(userId = 'default') {
    const key = this.baseUserKey(userId);
    if (this.selfModels[key] && this.selfModels[key].initialized) {
      return this.selfModels[key];
    }
    const filePath = path.join(this.selfModelDir, `${key}.json`);
    let model = selfModelModule.normalizeModel(null);
    let futureVersion = false;
    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // 前向兼容守卫（方向二）：版本判定必须作用在 raw 上——normalizeModel 是白名单重建，
        // 只回 version/updatedAt/traits/boundaries，会把 schemaVersion 抹掉，对归一化后的对象判版本永远为 v1
        futureVersion = storeSchema.isFutureVersion(raw, storeSchema.CURRENT_VERSIONS.selfModel);
        if (futureVersion) {
          console.warn(`[Memory] 用户 ${maskKey(key)} 的自我模型档版本 ${storeSchema.readVersion(raw)} 高于当前 ${storeSchema.CURRENT_VERSIONS.selfModel}，可能由更新版本写入`);
        }
        model = selfModelModule.normalizeModel(raw);
      } catch (error) {
        console.error(`[Memory] 加载 ${maskKey(key)} 的自我模型失败:`, error.message);
      }
    }
    // 标记来源版本：本档来自更新版本时，saveSelfModel 拒绝降级覆盖
    this.selfModels[key] = { ...model, initialized: true, futureVersion };
    return this.selfModels[key];
  }

  // 落盘自我模型。返回值 = 是否真的落盘成功（私有签名，仅 upsertSelfTrait 内部调用）；
  // 失败时回滚内存里的 updatedAt，兑现不变量「落盘失败 ⇒ 内存缓存零残留」
  saveSelfModel(userId = 'default') {
    const key = this.baseUserKey(userId);
    const model = this.loadSelfModel(key);
    // 前向兼容守卫（方向二）：磁盘档来自更新版本时拒绝降级覆盖
    if (model.futureVersion) {
      console.warn(`[Memory] 用户 ${maskKey(key)} 的自我模型来自更新版本，拒绝降级写入`);
      return false;
    }
    const previousUpdatedAt = model.updatedAt;
    model.updatedAt = Date.now();
    const filePath = path.join(this.selfModelDir, `${key}.json`);
    const data = {
      version: model.version || 1,
      updatedAt: model.updatedAt,
      traits: model.traits || [],
      boundaries: model.boundaries || []
    };
    try {
      // 落盘前盖上结构版本号（方向二）：兑现 storeSchema 里 selfModel 的版本登记
      writeJsonAtomicSync(filePath, storeSchema.stampVersion(data, storeSchema.CURRENT_VERSIONS.selfModel));
      console.log(`[Memory] 用户 ${key} 的自我模型已保存（${data.traits.length} 条，界线 ${data.boundaries.length} 条）`);
      return true;
    } catch (error) {
      model.updatedAt = previousUpdatedAt; // 回滚：内存不能假装这次更新落盘了
      console.error(`[Memory] 保存用户 ${key} 的自我模型失败:`, error);
      return false;
    }
  }

  // 并入一条自我认知：规范化 → 去重合并 → 限条落盘。返回 { merged, traits, saved } 或 null
  // saved=false 时已把内存 traits 回滚到落盘前的状态（不变量：失败 ⇒ 零残留）
  upsertSelfTrait(userId = 'default', input = {}) {
    const trait = selfModelModule.normalizeTrait(input);
    if (!trait) return null;
    const model = this.loadSelfModel(userId);
    const { traits, merged } = selfModelModule.mergeTrait(model.traits, trait);
    const previousTraits = model.traits;
    model.traits = traits;
    const saved = this.saveSelfModel(userId);
    if (!saved) {
      model.traits = previousTraits; // 回滚：提示词注入不能看到没落盘的条目
      return { merged, traits, saved: false };
    }
    const key = this.baseUserKey(userId);
    this.appendSelfModelHistory(userId, {
      action: merged ? 'merge' : 'add',
      text: trait.text,
      confidence: trait.confidence,
      source: trait.source,
      sourceIds: trait.sourceIds
    });
    console.log(`[Memory] 用户 ${key} 的自我认知${merged ? '已更新' : '已新增'}：${trait.text}`);
    return { merged, traits, saved: true };
  }

  // 追加一条自我认知变更记录（append-only JSONL）。失败只告警，不影响主流程
  appendSelfModelHistory(userId = 'default', record = {}) {
    try {
      const key = this.baseUserKey(userId);
      fs.mkdirSync(this.selfModelHistoryDir, { recursive: true });
      const line = JSON.stringify({
        at: Date.now(),
        ...record,
        sourceIds: Array.isArray(record.sourceIds) ? record.sourceIds : []
      });
      fs.appendFileSync(path.join(this.selfModelHistoryDir, `${key}.jsonl`), `${line}\n`, 'utf8');
      return true;
    } catch (error) {
      console.error('[Memory] 写自我认知历史失败:', error.message);
      return false;
    }
  }

  // 读最近的变更记录（新的在前），默认 20 条；用于「我为什么变成这样」的回溯
  getSelfModelHistory(userId = 'default', limit = 20) {
    try {
      const key = this.baseUserKey(userId);
      const file = path.join(this.selfModelHistoryDir, `${key}.jsonl`);
      if (!fs.existsSync(file)) return [];
      const max = Math.max(1, Math.floor(Number(limit)) || 20);
      return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-max)
        .reverse()
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch (error) {
      console.error('[Memory] 读自我认知历史失败:', error.message);
      return [];
    }
  }

  // 供提示词注入：取前 limit 条高置信自我认知纯文本（§七「严格限条」）。
  // opts.lifecycle==='live' 时排序/过滤改按「成熟度 + 租约」（用进废退），其余情况同旧行为
  getSelfTraits(userId = 'default', limit = 3, opts = {}) {
    const model = this.loadSelfModel(userId);
    return selfModelModule.selectForInjection(model.traits, limit, opts);
  }

  // 🧠 自我认知「读即用」：把本轮**真正注入**的条目记一次使用（useCount+1 / 刷新 lastUsedAt），
  // 走节流落盘。返回命中条数；未知文本（未在档里找到）不计数，避免凭空长出条目
  markSelfTraitsUsed(userId = 'default', texts = []) {
    const wanted = new Set(
      (Array.isArray(texts) ? texts : [])
        .map(text => String(text == null ? '' : text).trim())
        .filter(Boolean)
    );
    if (wanted.size === 0) return 0;
    const key = this.baseUserKey(userId);
    const model = this.loadSelfModel(key);
    if (!Array.isArray(model.traits)) return 0;
    let touched = 0;
    model.traits = model.traits.map(trait => {
      if (!trait || !wanted.has(String(trait.text || '').trim())) return trait;
      touched++;
      return selfModelModule.touchTrait(trait) || trait;
    });
    if (touched > 0) this._markSelfModelDirty(key);
    return touched;
  }

  // 🚧 界线（事前自限）：并入一条，规范化/去重/限条后落盘。
  // 返回 { merged, boundaries, saved } 或 null（不可核对的不算界线）
  upsertBoundary(userId = 'default', input = {}) {
    const boundary = selfModelModule.normalizeBoundary(input);
    if (!boundary) return null;
    const model = this.loadSelfModel(userId);
    const { boundaries, merged } = selfModelModule.mergeBoundary(model.boundaries, boundary);
    const previous = model.boundaries;
    model.boundaries = boundaries;
    const saved = this.saveSelfModel(userId);
    if (!saved) {
      model.boundaries = previous;
      return { merged, boundaries, saved: false };
    }
    const key = this.baseUserKey(userId);
    console.log(`[Memory] 用户 ${key} 的界线${merged ? '已更新' : '已新增'}：${boundary.text}`);
    return { merged, boundaries, saved: true };
  }

  // 供提示词注入：先判「观察期 → 结账期 → 仍未结账才退场」（有状态变化才标脏），
  // 再按「待结账最优先、触发词命中本轮输入其次」挑最多 limit 条。
  // 返回完整条目，正文与禁止片段都要给 output 核对
  getBoundariesForInjection(userId = 'default', opts = {}) {
    const key = this.baseUserKey(userId);
    const model = this.loadSelfModel(key);
    const { boundaries, closing, retired } = selfModelModule.retireBoundaries(model.boundaries, opts.now || Date.now());
    if (closing > 0 || retired > 0) {
      model.boundaries = boundaries;
      this._markSelfModelDirty(key);
      if (closing > 0) {
        console.log(`[Memory] 用户 ${key} 有 ${closing} 条界线零兑现到点，进入结账期（先结旧账，不静默退场）`);
      }
      if (retired > 0) {
        console.log(`[Memory] 用户 ${key} 有 ${retired} 条界线结账期到点仍未结账，按未结账留痕退场`);
      }
    }
    return selfModelModule.selectBoundariesForInjection(model.boundaries, opts);
  }

  // 🧭 盲区核对用：取该用户所有「仍在守」的界线（不按触发词筛选、不含已退场与待结账）。
  // 与注入清单分开取：盲区核对只观测、不记兑现/违背，所以不能被 select 的限条与触发词过滤带偏
  getActiveBoundaries(userId = 'default', opts = {}) {
    const key = this.baseUserKey(userId);
    const model = this.loadSelfModel(key);
    const { boundaries, closing, retired } = selfModelModule.retireBoundaries(model.boundaries, opts.now || Date.now());
    if (closing > 0 || retired > 0) {
      model.boundaries = boundaries;
      this._markSelfModelDirty(key);
    }
    return boundaries.filter(item => !item.droppedAt && !(item.closingAt && !item.resolution));
  }

  // 结账：她点名一条界线并给出结论（保留/收紧/撤销），旧账与结论一起落盘。
  // 只有结过账的界线才允许被撤销——撤之前必须说清哪次没做到、怎么补救
  closeBoundary(userId = 'default', text = '', opts = {}) {
    const key = this.baseUserKey(userId);
    const model = this.loadSelfModel(key);
    const { boundaries, closed } = selfModelModule.closeBoundary(model.boundaries, text, opts);
    if (!closed) return null;
    model.boundaries = boundaries;
    this._markSelfModelDirty(key);
    console.log(`[Memory] 用户 ${key} 的界线已结账（${closed.resolution}）：${closed.text}`);
    return closed;
  }

  // 发言后核对：honored=true 兑现+1，false 违背+1。只对「本轮真的注入过」的条目调用，
  // 否则不在场的界线会被凭空记账
  markBoundaryOutcome(userId = 'default', text = '', honored = true) {
    const wanted = String(text == null ? '' : text).trim();
    if (!wanted) return false;
    const key = this.baseUserKey(userId);
    const model = this.loadSelfModel(key);
    if (!Array.isArray(model.boundaries)) return false;
    let hit = false;
    const now = Date.now();
    model.boundaries = model.boundaries.map(item => {
      if (!item || String(item.text || '').trim() !== wanted) return item;
      hit = true;
      return {
        ...item,
        honoredCount: (Number(item.honoredCount) || 0) + (honored ? 1 : 0),
        violatedCount: (Number(item.violatedCount) || 0) + (honored ? 0 : 1),
        lastCheckedAt: now
      };
    });
    if (hit) this._markSelfModelDirty(key);
    return hit;
  }

  // 标记自我模型脏键并安排一次节流落盘（与 markDirty 同思路，定时器 unref 不阻塞进程退出）
  _markSelfModelDirty(key) {
    this._selfModelDirty.add(key);
    if (this._selfModelFlushTimer) return;
    this._selfModelFlushTimer = setTimeout(() => {
      this._selfModelFlushTimer = null;
      this.flushSelfModelDirty();
    }, this._flushDelayMs);
    if (this._selfModelFlushTimer && typeof this._selfModelFlushTimer.unref === 'function') {
      this._selfModelFlushTimer.unref();
    }
  }

  // 批量落盘自我模型脏键：单键失败不中断其余键，失败的键保留脏标记等下次重试
  flushSelfModelDirty() {
    if (!this._selfModelDirty || this._selfModelDirty.size === 0) return 0;
    const keys = Array.from(this._selfModelDirty);
    let saved = 0;
    for (const key of keys) {
      try {
        if (this.saveSelfModel(key)) {
          this._selfModelDirty.delete(key);
          saved++;
        }
      } catch (error) {
        console.error('[Memory] 自我认知批量落盘失败，键保留待下次重试:', error);
      }
    }
    return saved;
  }

  shouldGenerateSummary(userId = 'default') {
    const userStore = this.getUserMemoryStore(userId);
    const timeSinceLastSummary = Date.now() - userStore.lastSummaryTime;
    return userStore.eventsSinceLastSummary >= this.SUMMARY_EVENT_THRESHOLD || 
           timeSinceLastSummary >= this.SUMMARY_TIME_THRESHOLD;
  }

  generateSummaryMemory(userId = 'default') {
    const userStore = this.getUserMemoryStore(userId);
    const timeRangeStart = userStore.lastSummaryTime;
    const timeRangeEnd = Date.now();
    
    const recentMemories = userStore.memories.filter(
      m => m.timestamp >= timeRangeStart && m.timestamp <= timeRangeEnd
    );
    
    if (recentMemories.length === 0) return;
    
    const summary = this.createSummary(recentMemories, timeRangeStart, timeRangeEnd);
    
    userStore.summaryMemory.push(summary);
    if (userStore.summaryMemory.length > 100) {
      userStore.summaryMemory.shift();
    }
    
    userStore.lastSummaryTime = Date.now();
    userStore.eventsSinceLastSummary = 0;
    
    console.log(`[Memory] 用户 ${userId} 的总结性记忆已生成: ${summary.type}`);
  }

  // 创建总结
  createSummary(memories, timeRangeStart, timeRangeEnd) {
    const summary = {
      type: this.determineSummaryType(memories),
      content: '',
      timeRangeStart,
      timeRangeEnd,
      keyEvents: this.extractKeyEvents(memories),
      emotionTrend: this.calculateEmotionTrend(memories),
      relationshipImpact: this.calculateRelationshipImpact(memories),
      memoryCount: memories.length,
      positiveRatio: this.calculatePositiveRatio(memories),
      dominantInputType: this.findDominantInputType(memories)
    };
    
    summary.content = this.generateSummaryText(summary);
    
    return summary;
  }

  // 确定总结类型
  determineSummaryType(memories) {
    const avgValue = memories.reduce((sum, m) => sum + m.value, 0) / memories.length;
    const ratio = this.calculatePositiveRatio(memories);
    
    if (ratio > 0.8) return 'very_positive';
    if (ratio > 0.6) return 'positive';
    if (ratio > 0.4) return 'neutral';
    if (ratio > 0.2) return 'negative';
    return 'very_negative';
  }

  // 提取关键事件
  extractKeyEvents(memories) {
    const keyEvents = [];
    const significantMemories = memories.filter(m => Math.abs(m.value) > 0.5);
    
    significantMemories.forEach(memory => {
      keyEvents.push({
        type: memory.type,
        value: memory.value,
        timestamp: memory.timestamp,
        data: memory.data
      });
    });
    
    return keyEvents.slice(-10);
  }

  // 计算情绪趋势
  calculateEmotionTrend(memories) {
    if (memories.length < 2) return 'stable';
    
    const sortedMemories = [...memories].sort((a, b) => a.timestamp - b.timestamp);
    const firstHalf = sortedMemories.slice(0, Math.floor(sortedMemories.length / 2));
    const secondHalf = sortedMemories.slice(Math.floor(sortedMemories.length / 2));
    
    const firstAvg = firstHalf.reduce((sum, m) => sum + m.value, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((sum, m) => sum + m.value, 0) / secondHalf.length;
    
    const diff = secondAvg - firstAvg;
    
    if (diff > 0.3) return 'improving';
    if (diff < -0.3) return 'declining';
    return 'stable';
  }

  // 计算关系影响
  calculateRelationshipImpact(memories) {
    const avgValue = memories.reduce((sum, m) => sum + m.value, 0) / memories.length;
    const count = memories.length;
    
    return avgValue * (count / this.SUMMARY_EVENT_THRESHOLD);
  }

  // 计算正向比例
  calculatePositiveRatio(memories) {
    if (memories.length === 0) return 0.5;
    const positiveCount = memories.filter(m => m.value > 0).length;
    return positiveCount / memories.length;
  }

  // 找出主要输入类型
  findDominantInputType(memories) {
    const typeCount = {};
    memories.forEach(m => {
      typeCount[m.type] = (typeCount[m.type] || 0) + 1;
    });
    
    let maxType = 'text';
    let maxCount = 0;
    for (const [type, count] of Object.entries(typeCount)) {
      if (count > maxCount) {
        maxCount = count;
        maxType = type;
      }
    }
    return maxType;
  }

  // 生成总结文本
  generateSummaryText(summary) {
    const typeDescriptions = {
      'very_positive': '非常愉快的互动',
      'positive': '积极的互动',
      'neutral': '平淡的互动',
      'negative': '消极的互动',
      'very_negative': '不愉快的互动'
    };
    
    const trendDescriptions = {
      'improving': '关系正在升温',
      'declining': '关系有些疏远',
      'stable': '关系保持稳定'
    };
    
    let text = `在这段时间内，我们共进行了${summary.memoryCount}次互动。`;
    text += `整体呈现${typeDescriptions[summary.type]}。`;
    text += `${trendDescriptions[summary.emotionTrend]}。`;
    text += `主要的互动方式是${summary.dominantInputType}。`;
    
    if (summary.keyEvents.length > 0) {
      text += `其中有${summary.keyEvents.length}个重要时刻。`;
    }
    
    return text;
  }

  getSummaryMemories(userId = 'default', limit = 10) {
    const userStore = this.getUserMemoryStore(userId);
    return userStore.summaryMemory.slice(-limit);
  }

  getRecentSummary(userId = 'default') {
    const userStore = this.getUserMemoryStore(userId);
    if (userStore.summaryMemory.length === 0) return null;
    return userStore.summaryMemory[userStore.summaryMemory.length - 1];
  }

  getSummaryCount(userId = 'default') {
    const userStore = this.getUserMemoryStore(userId);
    return userStore.summaryMemory.length;
  }

  getAllMemoriesWithSummary(userId = 'default') {
    const userStore = this.getUserMemoryStore(userId);
    return {
      // getRecentMemories 的第二个参数是「毫秒时间窗」不是条数，早先误传 100 等于只取最近 100ms，面板因此恒空
      recentMemories: this.getMemories(userId, 20),
      summaryMemories: this.getSummaryMemories(userId, 10),
      // ① 可见性：钉住的条数（面板据此提示用户「这条别忘」确实生效了）
      pinnedCount: userStore.memories.filter(memory => memory && memory.pinned).length,
      // ③ 观察：REM 联想条（kind='association'，只展示、不注入提示词，见 getAssociationMemories）
      associations: this.getAssociationMemories(userId, 5),
      // ④ 可恢复：去重合并产生的「保留条 + 并入项」组（面板据此提供一键撤销）
      mergedGroups: this.getDedupMergedGroups(userId),
      address: this.normalizeAddress(userStore.address),
      currentRelationshipScore: userStore.relationshipScore,
      totalMemoryCount: userStore.memories.length,
      summaryCount: userStore.summaryMemory.length,
      userId: this.normalizeScopeKey(userId)
    };
  }

  updateRelationshipScore(value, eventType, userId = 'default') {
    const userStore = this.getUserMemoryStore(userId);
    let weight = 1;
    switch (eventType) {
      case 'text':
        weight = 1.2;
        break;
      case 'touch':
        weight = 1.5;
        break;
      case 'voice':
        weight = 1.0;
        break;
      default:
        weight = 0.8;
    }
    
    userStore.relationshipScore += value * weight;
    userStore.relationshipScore = Math.max(0, Math.min(100, userStore.relationshipScore));
  }

  getMemories(userId = 'default', limit = 100) {
    const userStore = this.getUserMemoryStore(userId);
    return userStore.memories.slice(-limit);
  }

  // 📜 最近记忆常驻区（默认 32 条）：只取还能当经历用的条目，
  // 排除语义结论、已归档、系统摘要。排序 = 近因 × 显著性：
  // 被召回/情绪强化过的条目会往前浮，所以这 32 条会随她的主观状态变化，
  // 不是固定截取最后 32 条。excludeIds 用于让强相关 5 条不占这里的名额。
  getRecentMemoryRecords(userId = 'default', limit = 32, options = {}) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const now = Number(options.now) || Date.now();
    const excludeIds = options.excludeIds instanceof Set
      ? options.excludeIds
      : new Set(options.excludeIds || []);
    const max = Math.max(1, Number(limit) || 32);
    const candidates = [];

    for (const memory of userStore.memories) {
      if (!memory || typeof memory.data !== 'string') continue;
      const text = memory.data.trim();
      if (!text || text.startsWith('【')) continue; // 系统摘要走单独的分区
      if (memory.tier === 'semantic' || memory.tier === 'archived') continue;
      if (excludeIds.has(String(memory.id))) continue;
      const ts = Number(memory.timestamp) || 0;
      const ageDays = Math.max(0, now - ts) / 86400000;
      const recency = 1 / (1 + ageDays);
      const salience = Math.max(0, Math.min(1, Number(memory.salience) || 0));
      // 各占一半：近期的事优先，但被反复想起/情绪强化过的旧事能浮上来，
      // 所以这 32 条不是固定的最后 32 条，会随她的主观状态变化
      candidates.push({ memory, text, score: recency * 0.5 + salience * 0.5 });
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (Number(b.memory.timestamp) || 0) - (Number(a.memory.timestamp) || 0);
    });

    const picked = [];
    for (const item of candidates) {
      if (picked.length >= max) break;
      if (picked.some(prev => this.nearDuplicateRatio(prev.text, item.text) > RECALL_NEAR_DUP_RATIO)) continue;
      picked.push(item);
    }
    // 输出仍按时间从近到远：读起来是一段连续的经历，而不是按分数乱序
    picked.sort((a, b) => (Number(b.memory.timestamp) || 0) - (Number(a.memory.timestamp) || 0));
    return picked.map(item => this.toRecallRecord(item.memory, item.score));
  }

  // 🎯 强相关直取（不占最近 32 的名额）：字面包含优先，其次 bigram 相关。
  // 不走限额/不应期——「他刚提到的这件事」必须立刻能想起来，哪怕上一轮刚说过
  getStrongMatchRecords(userId = 'default', query = '', limit = 5, options = {}) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const text = String(query || '').trim();
    if (!text) return [];
    const grams = this.toBigrams(text);
    const now = Number(options.now) || Date.now();
    const cutoverAt = Number(options.cutoverAt) || 0;
    const excludeIds = options.excludeIds instanceof Set
      ? options.excludeIds
      : new Set(options.excludeIds || []);
    const max = Math.max(1, Number(limit) || 5);
    const scored = [];

    for (const memory of userStore.memories) {
      if (!memory || typeof memory.data !== 'string') continue;
      const content = memory.data.trim();
      if (!content || content.startsWith('【')) continue; // 摘要不进「强相关原文」
      if (memory.tier === 'semantic') continue;
      if (excludeIds.has(String(memory.id))) continue;
      const literal = (text.length >= 4 && content.includes(text))
        || (content.length >= 4 && text.includes(content));
      const relevance = grams && grams.size > 0 ? this.scoreMemoryRelevance(memory, grams) : 0;
      if (!literal && relevance <= 0) continue;
      const score = (literal ? 1 : 0) + relevance * 0.5 + this.personaWeight(memory, cutoverAt, now) * 0.1;
      scored.push({ memory, text: content, score });
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (Number(b.memory.timestamp) || 0) - (Number(a.memory.timestamp) || 0);
    });

    const picked = [];
    for (const item of scored) {
      if (picked.length >= max) break;
      if (picked.some(prev => this.nearDuplicateRatio(prev.text, item.text) > RECALL_NEAR_DUP_RATIO)) continue;
      picked.push(item);
    }
    return picked.map(item => this.toRecallRecord(item.memory, item.score));
  }
  
  getRecentDialogHistory(userId = 'default', limit = 5) {
    const userStore = this.getUserMemoryStore(userId);
    const recentMemories = userStore.memories.slice(-limit * 2);
    
    const history = [];
    
    recentMemories.forEach(memory => {
      if (memory.data && memory.type === 'text') {
        history.push({
          role: 'user',
          content: memory.data
        });
      }
    });
    
    return history;
  }

  getRecentMemories(userId = 'default', timeWindow = 3600000) {
    const userStore = this.getUserMemoryStore(userId);
    const now = Date.now();
    return userStore.memories.filter(memory => now - memory.timestamp < timeWindow);
  }
  
  getRecentTextMemories(userId = 'default', limit = 5) {
    const userStore = this.getUserMemoryStore(userId);
    return userStore.memories
      .filter(memory => memory.type === 'text' && memory.data)
      .slice(-limit);
  }

  // 改人设后的旧记忆降权：cutoverAt 之前的记忆从 0.35 起步，14 天内线性回到 1.0。
  // 不删档、不改写原文——旧相处经验只是先从「主要依据」退成「底色」，再慢慢重新长回来
  personaWeight(memory, cutoverAt, now = Date.now()) {
    const cut = Number(cutoverAt) || 0;
    if (!cut) return 1;
    const ts = Number(memory && memory.timestamp) || 0;
    if (ts >= cut) return 1;
    const days = Math.max(0, (Number(now) || Date.now()) - cut) / 86400000;
    return Math.min(1, 0.35 + 0.65 * (days / 14));
  }

  // 「最近 N 条」兜底也按人设权重排：新世代的记忆优先，旧世代同权时再按时间倒序
  pickRecentByWeight(items, limit, cutoverAt, now = Date.now()) {
    return (Array.isArray(items) ? items : [])
      .map((memory, index) => ({ memory, index }))
      .sort((a, b) => {
        const weightDiff = this.personaWeight(b.memory, cutoverAt, now) - this.personaWeight(a.memory, cutoverAt, now);
        if (Math.abs(weightDiff) > 1e-9) return weightDiff;
        return (Number(b.memory && b.memory.timestamp) || 0) - (Number(a.memory && a.memory.timestamp) || 0)
          || b.index - a.index;
      })
      .slice(0, Math.max(0, limit))
      .map(item => item.memory);
  }

  // 召回与当前话题相关的长期记忆（纯文本数组）：getRelevantMemoryRecords 的投影，不另写一套逻辑
  getRelevantMemories(userId = 'default', query = '', limit = 5, opts = {}) {
    return this.getRelevantMemoryRecords(userId, query, limit, opts)
      .map(record => record.text);
  }

  // 召回与当前话题相关的长期记忆（结构化记录），供正式回复与自主发言注入系统提示词
  // 记录带 id / 时间 / 层级：注入层才能写出「3 天前」，也才能把「我变了」指回具体条目
  // 有查询词时按字符片段重合度排序；没有命中或未提供查询词时退回最近的记忆
  // opts.cutoverAt：人设切换时间，早于它的记忆按 personaWeight 降权
  // opts.now：注入时钟（测试用），缺省取当前时间
  getRelevantMemoryRecords(userId = 'default', query = '', limit = 5, opts = {}) {
    const userStore = this.getUserMemoryStore(userId);
    // 语义记忆不混进通用召回池：它走独立分区注入（见 output.js buildSemanticSection），
    // 否则同一条既当「经历」又当「结论」被注入两次
    const items = userStore.memories.filter(
      memory => memory && typeof memory.data === 'string' && memory.data.trim().length > 0
        && (memory.tier || 'episodic') !== 'semantic'
    );
    if (items.length === 0) return [];

    const cutoverAt = Number(opts && opts.cutoverAt) || 0;
    const now = Number(opts && opts.now) || Date.now();
    const keyword = typeof query === 'string' ? query.trim() : '';
    // 🫀 无查询召回：她没在回应谁的时候（自主开口），线索不该是「最近时间」，而该是「她此刻心里的事」。
    // 调用方把内稳态折算成几句短词传进来；用户这轮有话说时一律以用户的话为准，状态词不参与打分。
    const stateWords = Array.isArray(opts && opts.stateWords)
      ? opts.stateWords.map(word => String(word || '').trim()).filter(Boolean).slice(0, 3)
      : [];
    // 不应期账本可以按调用方分开：自主发言的召回不该与正式回复互相压制，否则两条链
    // 会「轮流把对方刚注入的记忆藏起来」，表现就是自主发言和主链路对不上
    const ledgerKey = (opts && opts.refractoryTag) ? `${userId}|${opts.refractoryTag}` : userId;
    const cue = keyword || stateWords.join(' ');
    const scores = new Map();
    let picked;
    let lexical = [];
    if (cue) {
      const grams = this.toBigrams(cue);
      lexical = items
        .map(memory => ({
          memory,
          // 旧人设时期的记忆按世代权重折算，字面再像也先退一位
          score: this.scoreMemoryRelevance(memory, grams) * this.personaWeight(memory, cutoverAt, now)
        }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || (b.memory.timestamp || 0) - (a.memory.timestamp || 0));
      lexical.forEach(item => scores.set(String(item.memory.id), item.score));
      const hit = lexical.slice(0, limit).map(item => item.memory);
      picked = hit.length > 0 ? hit : this.pickRecentByWeight(items, limit, cutoverAt, now);
    } else {
      picked = this.pickRecentByWeight(items, limit, cutoverAt, now);
    }

    const expanded = this.expandByTopic(userStore, picked, limit);

    // 还有余量就接着吃「与当前话题字面相关」的下一批，避免同系列只捞到前几条
    const seen = new Set(expanded.map(m => String((m && m.data) || '').trim()));
    for (const item of lexical) {
      if (expanded.length >= limit + TOPIC_EXPAND_MAX_TOTAL) break;
      const t = String((item.memory && item.memory.data) || '').trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        scores.set(String(item.memory.id), item.score);
        expanded.push(item.memory);
      }
    }

    // 🔁 去重前先过不应期：最近注入过的条目先让位（字面直中的条目豁免）
    const literalIds = new Set(lexical.map(item => String((item.memory && item.memory.id) || '')));
    const fresh = this.filterRecentlyRecalled(ledgerKey, expanded, literalIds);
    const merged = this.dedupeAndQuota(fresh, limit);
    const finalList = merged.map(entry => entry.memory);
    // 记账只记真正注入的几条（含被合并掉的兄弟 id）
    this.markRecalled(ledgerKey, merged, { snapshotKey: userId });
    // 🧠 提取即强化：被召回的记忆权重上升（内存改 + 节流落盘，不阻塞）
    this.reinforceRecalled(userId, finalList);
    return merged.map(entry => this.toRecallRecord(entry.memory, scores.get(String(entry.memory.id)), entry.mergedIds));
  }

  // 🫀 自发回忆：不是用户问出来的，是她此刻的心情自己勾出来的。
  // 与「按查询召回」是两条独立通道：
  //   1. 线索不是用户这句话，而是当前主导情绪（快层；快层没劲时看慢层底色）；
  //   2. 只挑同一类情绪下发生、且已有一段时间的旧事——刚聊过的、刚注入过的都不算「忽然想起」；
  //   3. 越久没被提取过、当初越戳人的，越容易先浮上来（提取强化本来就会抬高 recallCount，
  //      所以这里对 recallCount 反向加权，避免总是同一条反复「想起」）；
  //   4. 有节流：同一会话一段时间内最多浮出一次，浮完进不应期账本，与查询召回共用同一本账。
  // 返回值与 retrieveMemoryRecords 同形（带 id/时间），调用方直接复用注入格式。
  recallByMood(userId = 'default', opts = {}) {
    const key = this.normalizeScopeKey(userId);
    const now = Number(opts.now) || Date.now();
    const cutoverAt = Number(opts.cutoverAt) || 0;
    const limit = Math.max(0, Math.min(2, Number(opts.limit) || 1));
    if (limit === 0) return [];

    // 当前情绪：先看快层，强度不够再看慢层底色（周级心情也能把旧事勾上来）
    const current = this.pickMoodCue(opts);
    if (!current) return [];

    // 节流：同一会话短时间内不重复「忽然想起」，否则每轮都来一次就不像人了
    const throttleKey = `${opts.sessionKey || key}|${current.type}`;
    const cooldownMs = Number.isFinite(Number(opts.cooldownMs))
      ? Math.max(0, Number(opts.cooldownMs))
      : MOOD_RECALL_COOLDOWN_MS;
    if (!this._moodRecallAt) this._moodRecallAt = new Map();
    const lastAt = Number(this._moodRecallAt.get(throttleKey)) || 0;
    if (now - lastAt < cooldownMs) return [];

    // 空数组 = 这个情绪不出引子（如 calm）；未登记的情绪也不猜，直接不触发
    const moodTargets = MOOD_MATCH[current.type] || [];
    if (moodTargets.length === 0) return [];
    const effectiveLen = (s) => String(s || '').replace(/[\s\p{P}，。！？、~…“”‘’（）()【】《》,.!?;:'"…·-]/gu, '').length;

    const items = this.getUserMemoryStore(key).memories.filter((memory) => {
      if (!memory || typeof memory.data !== 'string') return false;
      const text = memory.data.trim();
      if (!text || text.startsWith('【')) return false;
      if ((memory.tier || 'episodic') !== 'episodic') return false;
      if (effectiveLen(text) < 4) return false;
      const type = String((memory.emotion && memory.emotion.type) || '');
      if (!moodTargets.includes(type)) return false;
      // 「往事」得真的过去了一段时间：几分钟前刚发生的不叫想起
      return (now - (Number(memory.timestamp) || 0)) >= MOOD_RECALL_MIN_AGE_MS;
    });
    if (items.length === 0) return [];

    const scored = items
      .map((memory) => {
        const ageDays = Math.max(0, (now - (Number(memory.timestamp) || 0)) / 86400000);
        // 偏向「两三周前到一两个月前」的事：太近没有回忆感，太久已经模糊
        const ageFit = 1 / (1 + Math.abs(ageDays - 21) / 30);
        const salience = Number.isFinite(Number(memory.salience)) ? Number(memory.salience) : 0.5;
        const recallCount = Number(memory.recallCount) || 0;
        const matchWeight = moodTargets[0] === String((memory.emotion && memory.emotion.type) || '') ? 1 : 0.7;
        const score = matchWeight * (0.35 + 0.65 * salience) * ageFit
          / (1 + recallCount * 0.6)
          * this.personaWeight(memory, cutoverAt, now)
          * current.intensity;
        return { memory, score };
      })
      .sort((a, b) => b.score - a.score || (b.memory.timestamp || 0) - (a.memory.timestamp || 0));

    // 与查询召回共用不应期账本：刚被注入过的那条不再浮上来；全被挡住就这轮不想起
    const fresh = this.filterRecentlyRecalled(key, scored.map(item => item.memory), [], { keepBlockedFallback: false });
    if (fresh.length === 0) return [];
    const chosen = scored.find(item => fresh.includes(item.memory));
    if (!chosen) return [];

    const entries = [{ memory: chosen.memory, mergedIds: [] }];
    this.markRecalled(key, entries);
    this.reinforceRecalled(key, [chosen.memory]);
    this._moodRecallAt.set(throttleKey, now);
    return [this.toRecallRecord(chosen.memory, chosen.score)];
  }

  // 自发回忆的情绪线索：快层强度够就用快层，不够再看慢层底色；都没有就不触发。
  // 返回 { type, intensity } 或 null。
  pickMoodCue(opts = {}) {
    const fastType = typeof opts.emotion === 'string' ? opts.emotion.trim() : '';
    const fastIntensity = Number(opts.intensity) || 0;
    if (fastType && fastIntensity >= MOOD_RECALL_MIN_INTENSITY) {
      return { type: fastType, intensity: fastIntensity };
    }
    const slow = opts.slowMood && typeof opts.slowMood === 'object' ? opts.slowMood : null;
    const slowType = slow && typeof slow.type === 'string' ? slow.type.trim() : '';
    const slowIntensity = slow ? (Number(slow.intensity) || 0) : 0;
    if (slowType && slowIntensity >= MOOD_RECALL_SLOW_INTENSITY) {
      return { type: slowType, intensity: slowIntensity };
    }
    return null;
  }

  // 召回记录的唯一形状：id 与时间在这里定下来，注入层只做格式化，不再反查记忆对象
  toRecallRecord(memory, score = 0, mergedIds = []) {
    return {
      id: String((memory && memory.id) || ''),
      text: String((memory && memory.data) || '').trim(),
      ts: Number((memory && memory.timestamp) || 0),
      tier: String((memory && memory.tier) || 'episodic'),
      score: Number(score) || 0,
      mergedIds: Array.isArray(mergedIds) ? mergedIds : [],
      // 注入层要按「谁说的」分行，不能把她的自我记忆写成用户档案
      speaker: String((memory && memory.speaker) || ''),
      source: String((memory && memory.source) || '')
    };
  }

  // 两条文本的近重复度：Dice 系数 2×交集 ÷ 两边之和。
  // 不用 bigramSimilarity 的「÷ 较小集合」——那会把「今天去体检」判成和任何一条更长的体检记忆重复
  nearDuplicateRatio(textA, textB) {
    const a = this.toBigrams(textA);
    const b = this.toBigrams(textB);
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const gram of a) {
      if (b.has(gram)) inter++;
    }
    return (2 * inter) / (a.size + b.size);
  }

  // 合并后的去重与配额（只决定「留下谁」，不改内容、不改排序）：
  //  - 同文 / Dice > 0.9 的近重复只留先到的一条，被并掉的 id 记在 mergedIds 上（溯源链不断）
  //  - 同一 topicId 最多 RECALL_MAX_PER_TOPIC 条
  //  - 总量上限仍是 limit + TOPIC_EXPAND_MAX_TOTAL
  dedupeAndQuota(memories, limit) {
    const maxTotal = Math.max(0, Number(limit) || 0) + TOPIC_EXPAND_MAX_TOTAL;
    const kept = [];
    const perTopic = new Map();
    for (const memory of Array.isArray(memories) ? memories : []) {
      if (!memory || kept.length >= maxTotal) continue;
      const text = String(memory.data || '').trim();
      if (!text) continue;

      const dup = kept.find(entry => entry.text === text || this.nearDuplicateRatio(entry.text, text) > RECALL_NEAR_DUP_RATIO);
      if (dup) {
        dup.mergedIds.push(String(memory.id));
        continue;
      }

      const topicId = String(memory.topicId || '');
      if (topicId) {
        const count = perTopic.get(topicId) || 0;
        if (count >= RECALL_MAX_PER_TOPIC) continue;
        perTopic.set(topicId, count + 1);
      }
      kept.push({ memory, text, mergedIds: [] });
    }
    return kept;
  }

  // 🔁 召回不应期（过滤）：同一会话里刚被注入过的条目，随后的几轮不再上场——
  // 除非本轮查询「字面直中」它（literalIds 里带着它的 id），那说明这条确实和眼下这句话有关。
  // 只在去重之前过滤：剔除本轮不应期内的条目，不额外补位；
  // 若整批都被挡住，退回原列表，宁可重复一条也不让她忽然失忆。
  // 自发回忆走另一套兜底（keepBlockedFallback=false）：宁可这轮什么都没想起，也不要反复想起同一件。
  filterRecentlyRecalled(key, memories, literalIds = [], { keepBlockedFallback = true } = {}) {
    const list = Array.isArray(memories) ? memories : [];
    if (list.length === 0) return list;
    if (!this._recallInjections) this._recallInjections = new Map();

    const blocked = new Set();
    const blockedTexts = [];
    for (const round of (this._recallInjections.get(String(key || '')) || []).slice(-RECALL_REFRACTORY_ROUNDS)) {
      for (const id of (round.ids instanceof Set ? round.ids : round)) blocked.add(id);
      for (const text of (Array.isArray(round.texts) ? round.texts : [])) blockedTexts.push(text);
    }
    if (blocked.size === 0 && blockedTexts.length === 0) return list;

    const literal = literalIds instanceof Set ? literalIds : new Set(literalIds || []);
    const kept = list.filter((memory) => {
      const id = String((memory && memory.id) || '');
      if (literal.has(id)) return true; // 字面直中：算相关，允许重复
      if (blocked.has(id)) return false;
      // 语义级：id 是新的、说法换了，但讲的是同一件事（巩固产出的兄弟条目），一样让位
      const text = String((memory && memory.data) || '').trim();
      if (!text) return true;
      return !blockedTexts.some(prev => this.nearDuplicateRatio(prev, text) > RECALL_NEAR_DUP_RATIO);
    });
    return kept.length > 0 ? kept : (keepBlockedFallback ? list : []);
  }

  // 🔁 召回不应期（记账）：把本轮真正注入的 id 记进账本（含被去重合并掉的兄弟 id）
  markRecalled(key, entries, { snapshotKey = null } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    if (list.length === 0) return;
    if (!this._recallInjections) this._recallInjections = new Map();

    const storeKey = String(key || '');
    const injected = new Set();
    const injectedTexts = [];
    for (const entry of list) {
      const id = String((entry && entry.memory && entry.memory.id) || '');
      if (id) injected.add(id);
      // 同时记正文：下一轮靠它认出「换了个 id 但说着同一件事」的兄弟条目
      const text = String((entry && entry.memory && entry.memory.data) || '').replace(/\s+/g, ' ').trim();
      if (text) injectedTexts.push(text.slice(0, 300));
      const mergedIds = entry && Array.isArray(entry.mergedIds) ? entry.mergedIds : [];
      for (const merged of mergedIds) {
        if (merged) injected.add(String(merged));
      }
    }
    const history = this._recallInjections.get(storeKey) || [];
    history.push({ ids: injected, texts: injectedTexts });

    // 🎞️ 快照：只记最后一次真正注入的 id（键统一规范成 <用户>__<分档>，读的时候才对得上）
    if (!this._recallSnapshots) this._recallSnapshots = new Map();
    const snapshotKeyResolved = this.normalizeScopeKey(snapshotKey || storeKey);
    if (!this._recallSnapshots.has(snapshotKeyResolved) && this._recallSnapshots.size >= RECALL_REFRACTORY_MAX_KEYS) {
      const oldest = this._recallSnapshots.keys().next();
      if (!oldest.done) this._recallSnapshots.delete(oldest.value);
    }
    this._recallSnapshots.set(snapshotKeyResolved, { at: Date.now(), ids: Array.from(injected) });
    while (history.length > RECALL_REFRACTORY_ROUNDS) history.shift();

    // 容量兜底：只丢最早插入的那个键，不按时间排序（这里不需要精确 LRU）
    if (!this._recallInjections.has(storeKey) && this._recallInjections.size >= RECALL_REFRACTORY_MAX_KEYS) {
      const oldest = this._recallInjections.keys().next();
      if (!oldest.done) this._recallInjections.delete(oldest.value);
    }
    this._recallInjections.set(storeKey, history);
  }


  // 把文本切成相邻两字的片段集合，用于粗粒度的重合度打分
  toBigrams(text) {
    const clean = String(text).replace(/\s+/g, '');
    const grams = new Set();
    for (let i = 0; i < clean.length - 1; i++) {
      grams.add(clean.slice(i, i + 2));
    }
    if (grams.size === 0 && clean.length > 0) {
      grams.add(clean);
    }
    return grams;
  }

  scoreMemoryRelevance(memory, grams) {
    if (!grams || grams.size === 0) return 0;
    const text = String(memory.data || '');
    let score = 0;
    for (const gram of grams) {
      if (text.includes(gram)) score++;
    }
    return score;
  }

  // BM25 分词：中文按相邻两字、拉丁按词，避免引入分词依赖 😺
  tokenizeForBm25(text) {
    const s = String(text || '').toLowerCase();
    const tokens = s.match(/[a-z0-9_]+/g) || [];
    const cjk = s.replace(/[^\u4e00-\u9fff]/g, '');
    if (cjk.length === 1) tokens.push(cjk);
    for (let i = 0; i < cjk.length - 1; i++) tokens.push(cjk.slice(i, i + 2));
    return tokens;
  }

  // 在候选池上现算 BM25，不建持久索引：千条量级足够，维度也不会随文档漂移
  buildBm25Ranker(pool) {
    const docs = (pool || []).map((memory) => {
      const tokens = this.tokenizeForBm25(memory && memory.data);
      const tf = new Map();
      for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
      return { memory, tf, dl: tokens.length };
    });
    const total = docs.length || 1;
    const avgdl = docs.reduce((sum, doc) => sum + doc.dl, 0) / total || 1;
    const df = new Map();
    for (const doc of docs) {
      for (const token of doc.tf.keys()) df.set(token, (df.get(token) || 0) + 1);
    }
    const k1 = 1.2;
    const b = 0.75;
    return (query) => {
      const qTokens = [...new Set(this.tokenizeForBm25(query))];
      if (!qTokens.length) return [];
      const scored = docs.map((doc) => {
        let score = 0;
        for (const token of qTokens) {
          const freq = doc.tf.get(token);
          if (!freq) continue;
          const n = df.get(token) || 0;
          const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
          score += idf * (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (doc.dl / avgdl)));
        }
        return { memory: doc.memory, score };
      }).filter((item) => item.score > 0);
      return scored.sort((a, b2) => b2.score - a.score || (b2.memory.timestamp || 0) - (a.memory.timestamp || 0));
    };
  }

  // RRF：多路有序列表按 1/(k+rank) 融合；世代权重乘在每路贡献上，不让旧人设记忆借排名回升
  fuseRrf(lists, weightOf = () => 1, k = 60) {
    const merged = new Map();
    for (const list of lists || []) {
      (list || []).forEach((item, index) => {
        if (!item || !item.memory) return;
        const id = String(item.memory.id);
        const weight = Number(weightOf(item.memory)) || 0;
        const contribution = weight / (k + index + 1);
        const prev = merged.get(id);
        if (prev) prev.score += contribution;
        else merged.set(id, { memory: item.memory, score: contribution });
      });
    }
    return [...merged.values()].sort((a, b) => b.score - a.score || (b.memory.timestamp || 0) - (a.memory.timestamp || 0));
  }

  // 两个片段集合的重合度：交集大小 ÷ 较小集合大小（短文本被长文本「容纳」也算像）
  bigramSimilarity(gramsA, gramsB) {
    if (!gramsA || !gramsB || gramsA.size === 0 || gramsB.size === 0) return 0;
    const [small, large] = gramsA.size <= gramsB.size ? [gramsA, gramsB] : [gramsB, gramsA];
    let inter = 0;
    for (const gram of small) {
      if (large.has(gram)) inter++;
    }
    return inter / small.size;
  }

  // 判断一个二字片段能否当作话题「实词关键词」：排掉虚词/泛指时间词，以及含虚词字符的片段
  isTopicKeyword(gram) {
    if (!gram || gram.length < 2) return false;
    if (TOPIC_STOP_BIGRAMS.has(gram)) return false;
    for (const ch of gram) {
      if (TOPIC_STOP_CHARS.has(ch)) return false;
    }
    return true;
  }

  // 为本条新记忆决定话题标识：
  //  1) 承接上文：紧挨着的上一条记忆（10 分钟内）有话题，直接跟着走（同一轮对话）
  //  2) 否则与近 14 天已有话题的记忆比字面重合度，够像就继承那个话题
  //  2b) 还不够像、但共享同一个「实词关键词」（如「体检」），也视为同一件事（换措辞/补充细节的场合）
  //  3) 都不沾边就开新话题（用本条自身 id）
  assignTopicId(userId, text, fallbackId) {
    const t = String(text || '').trim();
    if (t.length < 2) return String(fallbackId);

    const grams = this.toBigrams(t);
    if (grams.size === 0) return String(fallbackId);

    const userStore = this.getUserMemoryStore(userId);
    const now = Date.now();

    // 1) 承接上文优先：紧挨着的上一条（10 分钟内）是同一轮对话，直接同话题，
    //    避免「眼前这句明明接着上文，却按字面撞到了几天前另一件事的话题」
    const last = userStore.memories[userStore.memories.length - 1];
    if (last && last.topicId && now - (last.timestamp || 0) <= TOPIC_CONTINUITY_MS) {
      return last.topicId;
    }

    // 2) 字面重合：与近 14 天的记忆比，够像就继承
    const windowStart = now - TOPIC_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    let bestTopic = '';
    let bestScore = 0;
    // 只看最近 200 条，控制单次写入的开销
    const scanStart = Math.max(0, userStore.memories.length - 200);
    for (let i = userStore.memories.length - 1; i >= scanStart; i--) {
      const m = userStore.memories[i];
      if (!m || !m.topicId || typeof m.data !== 'string' || m.data.trim().length === 0) continue;
      if ((m.timestamp || 0) < windowStart) continue;
      const sim = this.bigramSimilarity(grams, this.toBigrams(m.data));
      if (sim > bestScore) {
        bestScore = sim;
        bestTopic = m.topicId;
      }
    }
    if (bestTopic && bestScore >= TOPIC_SIM_THRESHOLD) return bestTopic;

    // 2b) 关键词兜底：整体字面不够像，但只要与新近记忆共享一个「实词」片段（排除虚词/泛指时间词），
    //     就当作同一件事的不同说法（如「…去医院做体检」/「体检要空腹」/「带上…体检单」）
    for (let i = userStore.memories.length - 1; i >= scanStart; i--) {
      const m = userStore.memories[i];
      if (!m || !m.topicId || typeof m.data !== 'string' || m.data.trim().length === 0) continue;
      if ((m.timestamp || 0) < windowStart) continue;
      const other = this.toBigrams(m.data);
      for (const gram of grams) {
        if (other.has(gram) && this.isTopicKeyword(gram)) {
          return m.topicId;
        }
      }
    }

    return String(fallbackId);
  }

  // 按话题补齐：把已挑中记忆的「同话题兄弟」也带出来，让一系列相关的事能被整组利用。
  // 每个话题补 TOPIC_EXPAND_MAX_PER_TOPIC 条、总量不超过 TOPIC_EXPAND_MAX_TOTAL 条
  expandByTopic(userStore, picked, limit) {
    if (!Array.isArray(picked) || picked.length === 0) return picked;
    const pickedIds = new Set(picked.map((m) => String(m && m.id)));
    const topics = new Set();
    picked.forEach((m) => {
      if (m && m.topicId) topics.add(String(m.topicId));
    });
    if (topics.size === 0) return picked;

    const extras = [];
    for (const topicId of topics) {
      if (extras.length >= TOPIC_EXPAND_MAX_TOTAL) break;
      let count = 0;
      const siblings = userStore.memories
        .filter(
          (m) =>
            m &&
            String(m.topicId || '') === topicId &&
            !pickedIds.has(String(m.id)) &&
            typeof m.data === 'string' &&
            m.data.trim().length > 0
        )
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      for (const m of siblings) {
        if (count >= TOPIC_EXPAND_MAX_PER_TOPIC || extras.length >= TOPIC_EXPAND_MAX_TOTAL) break;
        extras.push(m);
        pickedIds.add(String(m.id));
        count++;
      }
    }
    if (extras.length === 0) return picked;
    return [...picked, ...extras];
  }

  // 🧠 把一条记忆异步双写到 Qdrant（storeMemory 用）。不阻塞、不抛出
  queueVectorUpsert(userId, memory) {
    if (!this.vectorStore || !this.vectorStore.isEnabled()) return;
    Promise.resolve()
      .then(() => this.vectorStore.upsert(userId, memory))
      .then((ok) => {
        if (ok) console.log(`[Memory] 记忆向量已双写（用户 ${userId}）`);
      })
      .catch((error) => {
        console.warn('[Memory] 记忆向量双写失败（本地记忆不受影响）:', error.message);
      });
  }

  // 🧠 向量 + 字面混合召回（返回纯文本数组）：retrieveMemoryRecords 的投影，不另写一套逻辑
  async retrieveMemories(userId = 'default', query = '', limit = 5, opts = {}) {
    const records = await this.retrieveMemoryRecords(userId, query, limit, opts);
    return records.map(record => record.text);
  }

  // 🩹 索引自愈：本地 JSON 是真相源，云端向量只是索引。双写是 best-effort（网络抖动/断电
  // 只告警不重试），缺口会静默累积——本地有、云端没点的条目就永远召回不到。
  // 这里只「补缺」不「删多」：多出来的点会被召回时的本地 mid 校验自然挡掉，删了也没坏处但没必要。
  // 短语气词由 vectorStore.upsert 自己按规则跳过，不用在这里另判。
  async reconcileVectorIndex(userId = 'default', { onProgress = null } = {}) {
    const key = this.normalizeScopeKey(userId);
    const store = this.vectorStore;
    if (!store || !store.isEnabled()) {
      return { key, skipped: 'vector-disabled', local: 0, indexed: 0, missing: 0, upserted: 0, failed: 0 };
    }
    const userStore = this.getUserMemoryStore(key);
    const local = userStore.memories.filter((m) => m && typeof m.data === 'string' && m.data.trim());
    const indexed = await store.scrollUserMids(key);
    if (indexed === null) {
      return { key, skipped: 'cloud-unavailable', local: local.length, indexed: 0, missing: 0, upserted: 0, failed: 0 };
    }

    const missing = local.filter((m) => !indexed.has(String(m.id)));
    let upserted = 0;
    let failed = 0;
    for (const memory of missing) {
      try {
        if (await store.upsert(key, memory)) upserted++;
      } catch (error) {
        failed++;
        console.warn(`[Memory] 索引自愈写入失败（${maskKey(key)}，mid=${memory.id}）:`, error.message);
      }
      if (typeof onProgress === 'function') onProgress({ done: upserted + failed, total: missing.length });
    }

    if (missing.length > 0) {
      console.log(
        `[Memory] 索引自愈完成（${maskKey(key)}）：本地 ${local.length} / 云端 ${indexed.size} / 缺失 ${missing.length} → 补写 ${upserted}，失败 ${failed}`
      );
    }
    return { key, local: local.length, indexed: indexed.size, missing: missing.length, upserted, failed };
  }

  // 🧠 向量 + 字面混合召回（结构化记录），供正式回复链路使用
  //  - query 为空：语义检索没有由头，直接退回「最近 N 条」（与老逻辑一致）
  //  - 云端不可用 / 检索异常：静默退回纯字面 bigram 召回，功能不中断
  //  - 向量命中必须在本地记忆里按 mid 校验得到：本地已删/被 1000 条上限挤出的，云端残留也召不回
  //  - opts.now：注入时钟（测试用），缺省取当前时间
  async retrieveMemoryRecords(userId = 'default', query = '', limit = 5, opts = {}) {
    // 向量库按分档键写入（storeMemory 用的是规范化后的 key），这里必须同样规范化，
    // 否则裸 userId 去检索会一条都命中不了
    const key = this.normalizeScopeKey(userId);
    const keyword = typeof query === 'string' ? query.trim() : '';
    const cutoverAt = Number(opts && opts.cutoverAt) || 0;
    const now = Number(opts && opts.now) || Date.now();
    // stateWords：无查询召回的状态线索（自主开口时用），同步路径要用，这里必须透传
    // refractoryTag：把不应期账本按调用方分账（自主发言与正式回复互不压制），需透传到字面回退路径
    const recallOpts = {
      cutoverAt,
      now,
      stateWords: opts && opts.stateWords,
      refractoryTag: opts && opts.refractoryTag
    };
    const ledgerKey = recallOpts.refractoryTag ? `${key}|${recallOpts.refractoryTag}` : key;
    if (!keyword || !this.vectorStore || !this.vectorStore.isEnabled()) {
      return this.getRelevantMemoryRecords(key, keyword, limit, recallOpts);
    }

    const userStore = this.getUserMemoryStore(key);
    try {
      const hits = await this.vectorStore.search(key, keyword, limit * 2);
      if (hits === null) {
        // null = 云端链路失败（不是"没命中"）；回退本地字面召回
        return this.getRelevantMemoryRecords(key, keyword, limit, recallOpts);
      }

      const byMid = new Map(
        userStore.memories
          .filter((m) => m && typeof m.data === 'string' && m.data.trim())
          .map((m) => [String(m.id), m])
      );

      const picked = [];
      const scores = new Map();
      const seenTexts = new Set();
      // 🚫 和向量库同一套准入：原话自命中、最近 10 分钟的眼前对话、纯语气词短条目都不召回
      // 「归档」条目默认不进召回池，但被强线索（向量高相似命中）带出时可唤醒
      const recentCutoff = now - 10 * 60 * 1000;
      const effectiveLen = (s) => String(s || '').replace(/[\s\p{P}，。！？、~…“”‘’（）()【】《》,.!?;:'"…·-]/gu, '').length;
      const eligible = (memory, { allowArchived = false } = {}) => {
        const t = String((memory && memory.data) || '').trim();
        if (!t || t === keyword) return false;
        // 语义记忆走独立分区注入，不进通用召回池（避免与结论重复注入）
        if (memory && memory.tier === 'semantic') return false;
        if (!allowArchived && memory && memory.tier === 'archived') return false;
        if ((memory.timestamp || 0) >= recentCutoff) return false;
        if (effectiveLen(t) < 4) return false;
        return true;
      };
      const pushOnce = (memory, score = 0) => {
        const t = String((memory && memory.data) || '').trim();
        if (t && !seenTexts.has(t)) {
          seenTexts.add(t);
          scores.set(String(memory.id), score);
          picked.push(memory);
        }
      };

      // 1) 向量召回：只做排序，不再先入池；旧人设世代权重在 RRF 融合时统一折算
      const vectorHits = hits
        .map((hit) => {
          const local = byMid.get(hit.mid);
          if (!local || !eligible(local, { allowArchived: true })) return null;
          return { memory: local, score: (Number(hit.score) || 0) * this.personaWeight(local, cutoverAt, now) };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

      // 2) BM25 一路：补上「用词不同但字眼重合」的召回，和向量路按排名融合（RRF）
      const pool = userStore.memories.filter((m) => eligible(m));
      const lexical = this.buildBm25Ranker(pool)(keyword).slice(0, Math.max(limit * 3, limit));

      // 2b) 零命中不凑数：语义通道通着、却连一条字面都不沾边，就当我确实想不起来这件事。
      //     相比「绝对相关度阈值」，这是个零参数布尔判定，不需要标定，也不会被长句天然拉高
      if (vectorHits.length === 0 && lexical.length === 0) return [];

      // 2c) RRF 融合：两条路各自的名次折算成 1/(k+rank)，世代权重乘在贡献上
      const weightOf = (memory) => this.personaWeight(memory, cutoverAt, now);
      const fused = this.fuseRrf([vectorHits, lexical], weightOf);
      fused.forEach((item) => pushOnce(item.memory, item.score));

      // 3) 还不够 limit 条就补最近的记忆（新世代优先），保证总有素材可用
      if (picked.length < limit) {
        this.pickRecentByWeight(pool, limit, cutoverAt, now)
          .forEach((memory) => pushOnce(memory));
      }

      // 4) 按话题补齐同系列的兄弟记忆，让一系列相关的事被整组利用
      const expanded = this.expandByTopic(userStore, picked, limit);

      // 5) 还有余量就接着吃「与当前话题字面相关」的下一批，避免同系列只捞到前几条
      for (const item of lexical) {
        if (expanded.length >= limit + TOPIC_EXPAND_MAX_TOTAL) break;
        const t = String((item.memory && item.memory.data) || '').trim();
        if (t && !seenTexts.has(t)) {
          seenTexts.add(t);
          scores.set(String(item.memory.id), item.score);
          expanded.push(item.memory);
        }
      }

      // 🔁 去重前先过不应期：最近注入过的条目先让位（字面直中的条目豁免）
      const literalIds = new Set(lexical.map((item) => String((item.memory && item.memory.id) || '')));
      const fresh = this.filterRecentlyRecalled(ledgerKey, expanded, literalIds);
      const merged = this.dedupeAndQuota(fresh, limit);
      const finalList = merged.map((entry) => entry.memory);
      // 记账只记真正注入的几条（含被合并掉的兄弟 id）
      this.markRecalled(ledgerKey, merged, { snapshotKey: key });
      // 🧠 提取即强化：召回命中的记忆权重上升，并把归档条目唤醒（内存改 + 节流落盘）
      this.reinforceRecalled(key, finalList);
      return merged.map((entry) => this.toRecallRecord(entry.memory, scores.get(String(entry.memory.id)), entry.mergedIds));
    } catch (error) {
      console.warn('[Memory] 向量召回异常，退回字面召回:', error.message);
      return this.getRelevantMemoryRecords(key, keyword, limit, recallOpts);
    }
  }

  // AI 态：按记忆分区分别召回，返回 { ai: [...], role: [...] }
  // 分成两块而不是混成一坨，是为了让提示词能标明每条记忆来自哪个区（AI 人格知道人格分类）
  async retrieveMemoriesByScopes(baseUserId, query = '', limit = 5, scopes = ['ai', 'role'], opts = {}) {
    const result = {};
    for (const scope of scopes) {
      const key = this.normalizeScopeKey(baseUserId, scope);
      let list = [];
      try {
        list = await this.retrieveMemories(key, query, limit, opts);
      } catch (error) {
        console.warn(`[Memory] 分档 ${key} 召回失败，改走字面召回:`, error.message);
        list = this.getRelevantMemories(key, query, limit, opts);
      }
      result[scope] = Array.isArray(list) ? list : [];
    }
    return result;
  }

  // 🫂 引用索引：加载/落盘都 best-effort，坏了按空表重建（只影响排序，不影响召回是否发生）
  loadPeerIndex() {
    try {
      if (!fs.existsSync(this.peerIndexPath)) return {};
      const raw = JSON.parse(fs.readFileSync(this.peerIndexPath, 'utf8'));
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (error) {
      console.warn('[Memory] 引用索引读取失败，按空表处理:', error.message);
      return {};
    }
  }

  savePeerIndex() {
    try {
      writeJsonAtomicSync(this.peerIndexPath, this.peerIndex);
      return true;
    } catch (error) {
      console.warn('[Memory] 引用索引落盘失败:', error.message);
      return false;
    }
  }

  // 引用索引加成：被引用时真的调用过的条目，下次优先（对数封顶，别让一次热闹永久霸榜）
  peerIndexBoost(targetKey, memory) {
    const bucket = this.peerIndex[this.normalizeScopeKey(targetKey)];
    const used = bucket ? Number(bucket[String(memory && memory.id)]) || 0 : 0;
    return 1 + Math.log1p(Math.min(used, 10));
  }

  // 本地索引权重累加：只记「哪条被引用调用过」，30s 合并落盘，不阻塞回复链路
  bumpPeerIndexWeights(targetKey, memories) {
    const key = this.normalizeScopeKey(targetKey);
    if (!this.peerIndex[key]) this.peerIndex[key] = {};
    const bucket = this.peerIndex[key];
    let changed = 0;
    for (const memory of Array.isArray(memories) ? memories : []) {
      const id = String((memory && memory.id) || '');
      if (!id) continue;
      bucket[id] = (Number(bucket[id]) || 0) + 1;
      changed++;
    }
    if (changed > 0 && !this._peerFlushTimer) {
      this._peerFlushTimer = setTimeout(() => {
        this._peerFlushTimer = null;
        this.savePeerIndex();
      }, this._flushDelayMs);
      if (this._peerFlushTimer && typeof this._peerFlushTimer.unref === 'function') this._peerFlushTimer.unref();
    }
    return changed;
  }

  // 🫂 跨会话只读记忆通道：只在「QQ 里引用别人的消息」时由 bridge 调用。
  //  - 只读：不加 recallCount、不写对方 store、不同步向量库——被引用不等于被改写
  //  - 不建空档：没聊过的人不会因为被引用一次就多出一份空记忆文件
  //  - 本地只调「引用索引权重」，让这次真正用上的条目下次更靠前
  retrievePeerMemories(userId = 'default', query = '', limit = 3) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.userMemories[key];
    if (!userStore || !Array.isArray(userStore.memories) || userStore.memories.length === 0) return [];
    const keyword = typeof query === 'string' ? query.trim() : '';
    const grams = keyword ? this.toBigrams(keyword) : null;
    const items = userStore.memories.filter(memory => memory
      && typeof memory.data === 'string' && memory.data.trim().length > 0
      && (memory.tier || 'episodic') !== 'semantic'
      && memory.tier !== 'archived'
      && !memory.data.startsWith('【'));
    if (items.length === 0) return [];

    const scored = items.map(memory => ({
      memory,
      score: (grams ? this.scoreMemoryRelevance(memory, grams) : 0) * this.peerIndexBoost(key, memory)
    }));
    // 有字面线索先按相关性；一条都不沾边就按「本地索引权重 + 新近」兜底，别交白卷
    let picked = scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    if (picked.length === 0) {
      picked = scored.sort((a, b) => b.score - a.score
        || (Number(b.memory.timestamp) || 0) - (Number(a.memory.timestamp) || 0));
    }
    const max = Math.max(1, Math.min(10, Number(limit) || 3));
    const chosen = picked.slice(0, max).map(item => item.memory);
    this.bumpPeerIndexWeights(key, chosen);
    return chosen.map(memory => String(memory.data || '').trim()).filter(Boolean);
  }

  getRelationshipScore(userId = 'default') {
    const userStore = this.getUserMemoryStore(userId);
    return userStore.relationshipScore;
  }

  getMemoryCount(userId = 'default') {
    const userStore = this.getUserMemoryStore(userId);
    return userStore.memories.length;
  }

  getUserPreferences(userId = 'default') {
    const userStore = this.getUserMemoryStore(userId);
    const preferences = {
      favoriteInputTypes: {},
      positiveInteractions: 0,
      negativeInteractions: 0
    };
    
    userStore.memories.forEach(memory => {
      if (!preferences.favoriteInputTypes[memory.type]) {
        preferences.favoriteInputTypes[memory.type] = 0;
      }
      preferences.favoriteInputTypes[memory.type] += 1;
      
      if (memory.value > 0) {
        preferences.positiveInteractions++;
      } else if (memory.value < 0) {
        preferences.negativeInteractions++;
      }
    });
    
    return preferences;
  }

  // 🧠 记忆生命周期维护：遗忘归档扫描（节流）+ 溢出淘汰。
  // 原先是「按天数删」的死代码，现改为 retention 驱动——忘记 ≠ 删除，先降级归档，再谈清理
  cleanOldMemories(userId = 'default') {
    const key = this.normalizeScopeKey(userId);
    const result = this.maintainStore(key, { force: true });
    this.saveUserMemories(key);
    return result;
  }

  // 维护单个 store：归档扫描按 SWEEP_INTERVAL_MS 节流（全量遍历别每次写入都跑），
  // 溢出淘汰很便宜，每次写入都跑。force=true 时立刻做一次完整遗忘扫描
  maintainStore(userId = 'default', { force = false } = {}) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const now = Date.now();
    let sweep = null;
    // 节流按用户分桶：A 扫过不该抑制 B 的扫描（原来共用一个时间戳会互相压制）
    const lastSweepAt = this._lastSweepAtByKey.get(key) || 0;
    if (force || now - lastSweepAt >= this.SWEEP_INTERVAL_MS) {
      this._lastSweepAtByKey.set(key, now);
      sweep = memoryLifecycle.applyForgetting(userStore, now);
    }
    const evicted = memoryLifecycle.evictOverflow(userStore, now);
    if (sweep && (sweep.archived || sweep.pruned)) {
      console.log(`[Memory] 生命周期维护（${maskKey(key)}）：归档 ${sweep.archived} / 清理 ${sweep.pruned} / 唤醒 ${sweep.recovered}`);
    }
    if (evicted > 0) {
      console.log(`[Memory] 容量淘汰（${maskKey(key)}）：按记忆牢度移除 ${evicted} 条`);
    }
    return { sweep, evicted };
  }

  // 提取即强化：召回命中的记忆加权重，并标记脏键等待节流落盘
  reinforceRecalled(userId, memories) {
    const key = this.normalizeScopeKey(userId);
    const changed = memoryLifecycle.reinforce(memories);
    if (changed > 0) this.markDirty(key);
    return changed;
  }

  // 安排一次合并落盘（默认 30s；定时器 unref 不阻塞进程退出）
  scheduleFlush(delayMs = this._flushDelayMs) {
    if (this._flushTimer) return;
    const delay = Number.isFinite(delayMs) ? delayMs : 30 * 1000;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flushDirtyChunk();
    }, delay);
    if (this._flushTimer && typeof this._flushTimer.unref === 'function') this._flushTimer.unref();
  }

  // 标记脏键并安排一次节流落盘
  markDirty(userId) {
    const key = this.normalizeScopeKey(userId);
    this._dirtyKeys.add(key);
    this.scheduleFlush();
  }

  // 定时器回调：只刷一批，剩下的尽快续排。
  // 以前一次回调把全部脏键串行重写完，几十个千条档会让事件循环停摆几百毫秒——
  // 等于把「每请求阻塞」换成了「每 30 秒一次长阻塞」，问题只是变稀了、没有消失
  flushDirtyChunk() {
    const saved = this.flushDirty({ maxKeys: FLUSH_BATCH_KEYS });
    if (this._dirtyKeys.size > 0) {
      // 有进展就尽快续刷；一条都没写成功（磁盘/锁/版本拒绝）就退回常规节流，避免 200ms 空转
      this.scheduleFlush(saved > 0 ? FLUSH_CONTINUE_DELAY_MS : this._flushDelayMs);
    }
    return saved;
  }

  // 把脏键批量落盘（顺带做一次维护），返回真正落盘成功的用户数。
  // maxKeys 默认不限（退出收尾要一次刷干净）；定时器路径传批次上限，避免单次回调过久。
  // 契约：自身不抛错、单键失败不中断其余键、失败的键保留脏标记等下一次重试（不静默丢更新）。
  // 只删「本快照内且落盘成功」的键：循环中新 markDirty 的键不在快照里，不会被误删清掉。
  flushDirty({ maxKeys = Infinity } = {}) {
    if (!this._dirtyKeys || this._dirtyKeys.size === 0) return 0;
    const keys = Array.from(this._dirtyKeys).slice(0, Math.max(1, maxKeys));
    let saved = 0;
    for (const key of keys) {
      try {
        this.maintainStore(key);
        if (this.saveUserMemories(key)) {
          this._dirtyKeys.delete(key);
          saved++;
        }
      } catch (error) {
        console.error('[Memory] 批量落盘处理失败，键保留待下次重试:', error);
      }
    }
    return saved;
  }

  // 遗忘的可观测性：某用户的记忆生命周期快照（调参用，见方案 §九.7）
  getMemoryLifecycleStats(userId = 'default') {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    // 基线：她最近一次被注入了哪几条记忆（纯内存，重启即空）
    const lastRecall = (this._recallSnapshots && this._recallSnapshots.get(key)) || null;
    return { ...memoryLifecycle.lifecycleStats(userStore, Date.now()), lastRecall };
  }

  // 从情绪对象里取主情绪强度（0~1），缺失/非法一律回 0：只作为 salience 的一个弱信号
  emotionIntensityOf(emotion) {
    const raw = Number(emotion && emotion.intensity);
    return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
  }

  // 遗忘留痕只读读取（元记忆/反思用）：最近 limit 条「曾忘过什么」
  getMemoryTombstones(userId = 'default', limit = 20) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    return memoryLifecycle.listTombstones(userStore, limit);
  }

  // 钉住/取消钉住某条记忆（DB-4）：被钉住的记忆豁免衰减/归档/淘汰/强化改写，持久化生效
  setMemoryPinned(userId = 'default', memoryId, pinned = true) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const memory = userStore.memories.find((m) => m && String(m.id) === String(memoryId));
    if (!memory) return false;
    const previous = !!memory.pinned;
    memory.pinned = !!pinned;
    // 返回值 = 落盘是否真的成功（方向二）；失败回滚内存标记，避免「面板显示已钉住、重启就没了」
    if (!this.saveUserMemories(key)) {
      memory.pinned = previous;
      return false;
    }
    return true;
  }

  // 用户主动归档（同意闸门）：只把条目降级为 archived，不删原文，可还原。
  // 返回 { ok, reason?, previousTier? }；落盘失败回滚内存里的改动
  archiveMemoryRecord(userId = 'default', memoryId) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const memory = userStore.memories.find((m) => m && String(m.id) === String(memoryId));
    if (!memory) return { ok: false, reason: 'not_found' };
    const previousTier = memory.tier;
    if (previousTier === 'archived') return { ok: true, previousTier };
    memory.tier = 'archived';
    memory.archivedAt = Date.now();
    if (!this.saveUserMemories(key)) {
      memory.tier = previousTier;
      delete memory.archivedAt;
      return { ok: false, reason: 'save_failed' };
    }
    return { ok: true, previousTier };
  }

  // 还原一条被归档的记忆（用户主动操作）：回到原层级，默认 episodic
  restoreMemoryRecord(userId = 'default', memoryId, tier = 'episodic') {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const memory = userStore.memories.find((m) => m && String(m.id) === String(memoryId));
    if (!memory) return { ok: false, reason: 'not_found' };
    if (memory.tier !== 'archived') return { ok: true, tier: memory.tier };
    const target = ['episodic', 'semantic'].includes(tier) ? tier : 'episodic';
    memory.tier = target;
    delete memory.archivedAt;
    if (!this.saveUserMemories(key)) {
      memory.tier = 'archived';
      return { ok: false, reason: 'save_failed' };
    }
    return { ok: true, tier: target };
  }

  // 记忆管理面板的只读视图：不带向量等内部字段，按时间倒序，可按层级/关键词过滤
  listMemoryViews(userId = 'default', opts = {}) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
    const tier = typeof opts.tier === 'string' ? opts.tier.trim() : '';
    const query = typeof opts.query === 'string' ? opts.query.trim() : '';
    return userStore.memories
      .filter(m => m && typeof m.data === 'string' && m.data.trim().length > 0)
      .filter(m => (tier ? m.tier === tier : true))
      .filter(m => (query ? m.data.includes(query) : true))
      .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
      .slice(0, limit)
      .map(m => ({
        id: m.id,
        text: m.data,
        tier: m.tier || 'episodic',
        timestamp: Number(m.timestamp) || 0,
        pinned: !!m.pinned,
        salience: Number(m.salience) || 0
      }));
  }

  // 按 id 只读取一条记忆的轻量视图（pin_memory 回确认语用）；找不到返回 null
  getMemoryById(userId = 'default', memoryId) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const memory = userStore.memories.find((m) => m && String(m.id) === String(memoryId));
    if (!memory) return null;
    return { id: memory.id, data: memory.data, timestamp: memory.timestamp, pinned: !!memory.pinned };
  }

  // 按关键词字面匹配查记忆（pin_memory 工具定位用）：返回带 id 的候选，按时间倒序。
  // 排除系统摘要（正文以【开头，不是「用户的经历」，不该被当记忆钉住）
  findMemoriesByKeyword(userId = 'default', query = '', limit = 5) {
    const key = this.normalizeScopeKey(userId);
    const userStore = this.getUserMemoryStore(key);
    const keyword = typeof query === 'string' ? query.trim() : '';
    if (!keyword) return [];
    const max = Math.max(1, Math.min(20, Number(limit) || 5));
    return userStore.memories
      .filter((m) => m && typeof m.data === 'string' && m.data.trim().length > 0
        && !m.data.startsWith('【') && m.data.includes(keyword))
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, max)
      .map((m) => ({ id: m.id, data: m.data, timestamp: m.timestamp, pinned: !!m.pinned }));
  }

  close() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this.flushDirty();
    if (this._selfModelFlushTimer) {
      clearTimeout(this._selfModelFlushTimer);
      this._selfModelFlushTimer = null;
    }
    this.flushSelfModelDirty();
  }
}

module.exports = MemoryModule;