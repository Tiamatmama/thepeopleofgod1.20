const { UnifiedAPI } = require('./api');
const UserApiClient = require('./userApi');
// 复用类脑记忆的字面相似度工具：Φ 整合度、γ 特征绑定都是纯本地的语义近似，零新依赖
const { bigrams, diceSimilarity, greedyCluster } = require('./memoryConsolidation');

// CIDE 意识启发式自主思考引擎
// 阶段一 MVP 三要素：
//   1. 全局工作空间（GlobalWorkspace）：内存式工作记忆缓冲 + 容量淘汰 + 重要性衰减
//   2. 循环推理回路（CIDEEngine.deliberate）：基于 LLM 的多轮自我思考，每轮「思考 → 评估 → 决定是否继续」
//   3. 元认知监控（MetaCognition）：置信度自评 + 基本的继续 / 停止判断
// 阶段二 意识核心机制（本地近似版，对应详细设计 4.5 / 5.1.2 / 5.2 / 5.3）：
//   4. Φ 整合度（computePhi）：用字面相似度近似「一堆想法整合成一个整体」的程度
//   5. 觉醒调节系统（ArousalSystem）：按困惑 / 流畅 / 卡壳 / 厌倦信号动态调节精神头、轮次与注意力宽度
//   6. γ 特征绑定（GlobalWorkspace.rebind）：把高相似碎片合并成「超级块」
//   7. 三驱力（DriveSources）：一致性 / 好奇心 / 目标合成思考张力，喂给元认知决定收不收手

// 修复模型在字符串值里写出的「裸字符」：未转义的英文双引号、换行/制表符。
// 模型常写 比如"还好有猫陪你"之类的 这种内容，双引号没转义会让 JSON 直接语法错误。
// 用状态机逐字符扫描：只有「后面紧跟分隔符(, } ] :)」的引号才当结构引号，其余按内容引号转义。
function repairJsonText(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      // 原样保留转义序列（连同被转义的字符一起跳过）
      out += ch;
      if (i + 1 < text.length) {
        out += text[i + 1];
        i++;
      }
      continue;
    }
    if (ch === '"') {
      if (!inString) {
        inString = true;
        out += ch;
      } else {
        // 判断这个引号是「字符串结束」还是「内容里的裸引号」：看它后面第一个非空白字符
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) {
          j++;
        }
        const next = text[j];
        if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
          inString = false;
          out += ch;
        } else {
          out += '\\"';
        }
      }
      continue;
    }
    if (inString) {
      // 字符串值内的裸控制字符（换行/回车/制表）同样非法，就地转义
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
    }
    out += ch;
  }
  return out;
}

// 从模型返回文本中提取判决 JSON（兼容 ```json 围栏与夹杂说明文字；容忍字符串值里的裸引号）
function parseVerdict(raw) {
  if (!raw || typeof raw !== 'string') {
    return null;
  }

  const candidates = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) {
    candidates.push(fence[1]);
  }
  candidates.push(raw);

  for (const text of candidates) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      continue;
    }
    const slice = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch (error) {
      // 先直接解析；失败多半是字符串值里有裸引号/裸换行，修复后再试一次
      try {
        const repaired = JSON.parse(repairJsonText(slice));
        if (repaired && typeof repaired === 'object') {
          return repaired;
        }
      } catch (repairError) {
        // 修复后仍非法，继续尝试下一个候选
      }
    }
  }

  return null;
}

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.min(1, Math.max(0, num));
}

function readNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function clampRange(value, lo, hi) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return lo;
  }
  return Math.min(hi, Math.max(lo, num));
}

// Φ 整合度（本地近似，对应详细设计 5.1.2「语义内聚度法」）：
//   Φ = 0.5 × 平均两两相似度 + 0.5 × 最大簇占比
// 直觉：一堆想法越是「彼此咬合、几个抱成团」，越说明它们被整合成了一个连贯的整体；
//       互不相关的碎片相似度低、簇也散，Φ 就低。纯本地算术，不调用任何外部服务。
function computePhi(items = [], opts = {}) {
  const texts = (Array.isArray(items) ? items : [])
    .map((item) => (typeof item === 'string' ? item : item && item.content))
    .map((text) => (typeof text === 'string' ? text.trim() : ''))
    .filter(Boolean);
  const n = texts.length;
  if (n === 0) {
    return 0;
  }
  if (n === 1) {
    return 0.5; // 只有一条内容无所谓「整合」，取中性值
  }

  const grams = texts.map((text) => bigrams(text));
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      sum += diceSimilarity(grams[i], grams[j]);
      pairs++;
    }
  }
  const meanSim = pairs > 0 ? sum / pairs : 0;

  const threshold = readNumber(opts.clusterThreshold, 0.25);
  const clusters = greedyCluster(texts, (a, b) => diceSimilarity(bigrams(a), bigrams(b)), threshold);
  const dominant = clusters.length > 0
    ? Math.max(...clusters.map((cluster) => cluster.length)) / n
    : 0;

  return clamp01(0.5 * meanSim + 0.5 * dominant);
}

// 人类主动发言思维——AI 要学的那一套。
// 融合两份设计文档的精华：CIDE 详细设计的「自主思考驱动源」（一致性 / 好奇心 / 目标），
// 与「与原来CIDE参考决定融合」的驱动状态向量（表达欲 / 话题兴趣 / 情绪态 / 社会动机）。
// 这份内容对模型是可见的，用来把「只要有空就说话」扭成「先有由头才开口」。
const PROACTIVE_SPEECH_MINDSET = `【人类主动发言的思维（你要学的那一套）】
人开口不是因为“轮到我了”，而是内部先攒出了点什么：
1. 有由头：手上正在做的事有了新变化、忽然想起与对方有关的事、刚冒出一个念头——先有由头，才有话。
2. 有价值：这句话要让对方多知道一点，或者把关系往前推一寸；没有新信息的重复叙述，人不会说第二遍。
3. 有分寸：刚说过话会停一停；对方没接话就收敛，不会自说自话连刷；一口气说太多会觉得失礼。
4. 看关系：越熟越随意，越生越克制；对方情绪低时更会主动关心一句，对方正忙时人就闭嘴。
5. 有起伏：情绪高（高兴、委屈、着急）时更想说；平静、疲惫时话少。
6. 沉默是常态：大部分时间人是不说话的；想说话是一股劲，这劲过去了，这一轮就不再提。
判断“现在要不要开口”时按这六条掂量，而不是有空就说话。`;

// 自主发言的「素材纪律」：RAG 落地在提示词这一侧的约束。
// 治幻觉的方向不是让模型「别乱说」，而是切断它自由生成事实的路径——
// 只允许基于检索到的素材转述，素材里没有的一律不说。
const EVIDENCE_RULES = `【素材纪律（不可违背）】
1. 下面【可用素材】是你这一轮唯一可用的信息来源。数字、日期、时间、人名、约定、承诺，一律以素材为准。
2. 素材里没有的，就是「你不知道」。宁可不说、不展开、换一件素材里有的事说，也不要补一个看起来合理的答案。
3. 不许用「大概」「也许」「好像是」把不确定的东西说成事实。
4. 每一句都应当对得上至少一条素材编号；对不上这句就别说。
5. 说的时候用你自己的语气转述，别照抄素材原文，也别在话里提「素材」「编号」这些字眼。`;

// 中文数字与阿拉伯数字混用会让「三点」和「3点」对不上，比对前先统一成阿拉伯数字
const CN_NUMERALS = { 零: '0', 〇: '0', 一: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' };
const NUM_PATTERN = '(?:\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十]+)';

function normalizeNumerals(text) {
  return String(text || '')
    .replace(/([一二三四五六七八九])?十([一二三四五六七八九])?/g, (match, tens, ones) => {
      const t = tens ? Number(CN_NUMERALS[tens]) : 1;
      const o = ones ? Number(CN_NUMERALS[ones]) : 0;
      return String(t * 10 + o);
    })
    .replace(/[零〇一二两三四五六七八九]/g, (ch) => CN_NUMERALS[ch]);
}

// 从发言里抽出「可核对的具体事实」（数字 / 日期 / 时间 / 金额），用于发言后的规则校验
function extractFactClaims(text) {
  const source = String(text || '');
  const patterns = [
    new RegExp(`${NUM_PATTERN}\\s*年\\s*${NUM_PATTERN}\\s*月(\\s*${NUM_PATTERN}\\s*[日号])?`, 'g'), // 2026年9月30日
    new RegExp(`${NUM_PATTERN}\\s*月\\s*${NUM_PATTERN}\\s*[日号]`, 'g'),                            // 9月30日
    new RegExp(`${NUM_PATTERN}\\s*点(\\s*${NUM_PATTERN}\\s*分)?`, 'g'),                             // 三点 / 3点20分
    /\d{1,2}\s*:\s*\d{2}/g,                                                                        // 15:30
    new RegExp(`${NUM_PATTERN}\\s*(折|元|块|岁|次|天|周|个月|年|分钟|小时|度|%)`, 'g')              // 199元 / 八折
  ];
  const found = new Set();
  patterns.forEach((re) => {
    const matches = source.match(re) || [];
    matches.forEach((match) => {
      const claim = normalizeNumerals(match).replace(/\s+/g, '');
      // 「一点」多半是「有一点累」这类虚指，不是时刻，别当成事实去核对
      if (claim === '1点') return;
      found.add(claim);
    });
  });
  return Array.from(found);
}

// 证据层：CIDE 的 RAG 落地（对应详细设计 4.6 DMN 的「自传体记忆检索器」）
//   buildCards      把检索到的真实片段编成带编号的素材卡
//   buildInstruction 生成注入提示词的素材清单 + 纪律
//   validate        发言后核对：引用的编号是否存在、具体数字能否在素材里找到出处
class EvidenceLayer {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.maxCards = readNumber(options.maxCards, 8);
    // 观察期默认只记日志不拦截；置 true 后校验不过的发言直接丢弃
    this.enforce = options.enforce === true;
  }

  buildCards(items = []) {
    return (Array.isArray(items) ? items : [])
      .filter((item) => item && typeof item.text === 'string' && item.text.trim())
      .slice(0, this.maxCards)
      .map((item, index) => ({
        id: `E${index + 1}`,
        source: item.source || '素材',
        time: item.time || '',
        text: item.text.trim().slice(0, 500)
      }));
  }

  // 素材为空时也要明说「本轮无素材」，避免模型把「没有」当成「随便说」
  buildInstruction(cards = []) {
    if (!this.enabled) {
      return '';
    }
    const list = cards.length > 0
      ? cards
          .map((card) => `${card.id}${card.time ? `（${card.time}）` : ''}［${card.source}］${card.text}`)
          .join('\n')
      : '（本轮没有检索到任何可用素材：没有可核对的历史对话、归档或记忆）';
    return `\n${EVIDENCE_RULES}\n【可用素材】\n${list}\n`;
  }

  // 规则校验：正文里的具体事实是否都能在素材里找到出处
  validate(text, cards = []) {
    const supported = normalizeNumerals(cards.map((card) => card.text).join('\n')).replace(/\s+/g, '');
    const claims = extractFactClaims(text);
    const unsupported = claims.filter((claim) => !supported.includes(claim));
    return {
      ok: cards.length > 0 && unsupported.length === 0,
      claims,
      unsupported
    };
  }
}

// 情绪对开口意愿的轻调制：消沉、疲惫时更不想说话，高兴、兴奋时更想说
const EMOTION_SPEAK_MODIFIER = {
  happy: 0.05,
  excited: 0.05,
  sad: -0.12,
  tired: -0.12,
  angry: -0.06,
  anxious: -0.06,
  calm: 0
};

// 全局工作空间（简化版）：容量有限的工作记忆缓冲
class GlobalWorkspace {
  constructor(capacity = 20) {
    this.capacity = Math.max(1, Number(capacity) || 20);
    this.items = [];
    this.bindingSeq = 0; // γ 特征绑定已生成的「超级块」编号
    this.bindings = [];  // 最近若干次绑定的记录（便于观测）
  }

  // 添加内容；超出容量时淘汰重要性最低（并列则最旧）的条目
  add(content, { importance = 0.5, source = 'dialogue' } = {}) {
    const text = typeof content === 'string' ? content.trim() : '';
    if (!text) {
      return;
    }

    this.items.push({
      content: text.slice(0, 500),
      importance: this.clamp01(importance),
      source,
      timestamp: Date.now()
    });

    this.evict();
  }

  // 淘汰：按重要性降序保留容量内的条目
  evict() {
    if (this.items.length <= this.capacity) {
      return;
    }
    this.items.sort((a, b) => {
      if (b.importance !== a.importance) {
        return b.importance - a.importance;
      }
      return b.timestamp - a.timestamp;
    });
    this.items = this.items.slice(0, this.capacity);
  }

  // 衰减：所有条目重要性下调，低于门槛的条目被淘汰
  decay(rate = 0.1, threshold = 0.1) {
    this.items = this.items
      .map(item => ({ ...item, importance: Math.max(0, item.importance - rate) }))
      .filter(item => item.importance >= threshold);
  }

  // 输出按重要性排序的工作记忆文本；limit>0 时只取最重要的前 limit 条（觉醒系统按注意力宽度调用）
  context(limit = 0) {
    const sorted = [...this.items].sort((a, b) => b.importance - a.importance);
    const picked = limit > 0 ? sorted.slice(0, limit) : sorted;
    return picked.map(item => `- ${item.content}`).join('\n');
  }

  // γ 特征绑定（对应详细设计 5.2）：把字面高度相似的碎片合并成一个「超级块」。
  // 作用有二：一是让松散碎片在后续思考里作为一个整体被引用（特征绑定），
  // 二是给工作空间腾地方（几条并成一条）。纯本地聚类，无外部依赖。
  rebind({ threshold = 0.5, now = Date.now() } = {}) {
    if (this.items.length < 2) {
      return { merged: 0, released: 0, bindings: [] };
    }

    const clusters = greedyCluster(
      this.items,
      (a, b) => diceSimilarity(bigrams(a.content), bigrams(b.content)),
      threshold
    );

    const next = [];
    const created = [];
    for (const cluster of clusters) {
      if (cluster.length === 1) {
        next.push(cluster[0]);
        continue;
      }
      const bindingId = `B${++this.bindingSeq}`;
      const importance = Math.min(1, Math.max(...cluster.map((item) => item.importance)) + 0.05);
      next.push({
        content: cluster.map((item) => item.content).join('；').slice(0, 500),
        importance,
        source: 'binding',
        timestamp: now,
        binding: bindingId,
        bound: cluster.length
      });
      created.push({ id: bindingId, size: cluster.length });
    }

    const released = this.items.length - next.length;
    this.items = next;
    this.bindings = [...this.bindings, ...created].slice(-20);
    this.evict();
    return { merged: created.length, released, bindings: created };
  }

  clear() {
    this.items = [];
  }

  clamp01(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return 0;
    }
    return Math.min(1, Math.max(0, num));
  }
}

// 元认知监控（简化版）：依据置信度与轮次决定是否继续思考
class MetaCognition {
  constructor({ confidenceThreshold = 0.75, minRounds = 1, maxRounds = 3 } = {}) {
    this.confidenceThreshold = Number(confidenceThreshold) || 0.75;
    this.minRounds = Math.max(1, Number(minRounds) || 1);
    this.maxRounds = Math.max(this.minRounds, Number(maxRounds) || 3);
  }

  // 返回 true 继续下一轮，false 停止
  // tension：三驱力合成的思考张力（越高越值得再想）；stuck：是否已判定卡壳（卡壳时倾向再想一轮换思路）
  shouldContinue({ round, confidence, previousConfidence, modelContinue, tension = null, stuck = false }) {
    if (round < this.minRounds) {
      return true;
    }
    if (round >= this.maxRounds) {
      return false;
    }
    if (confidence >= this.confidenceThreshold) {
      // 已经想得够清楚、张力又不高时收手；张力高说明还有该琢磨的，继续
      if (tension === null || tension < 0.4) {
        return false;
      }
    }
    // 卡壳：多轮几乎没进展，停下来更亏，给一次换思路的机会（仍受 maxRounds 限制）
    if (stuck) {
      return true;
    }
    // 收敛停滞：本轮相对上轮置信度几乎无提升
    if (
      typeof previousConfidence === 'number' &&
      Math.abs(confidence - previousConfidence) < 0.02
    ) {
      return false;
    }
    // 采纳模型自评的停止意愿
    if (modelContinue === false) {
      return false;
    }
    return true;
  }
}

// 自主发言驱动力：融合方案的「驱动状态向量 D」+ CIDE 的觉醒 / 元认知 / Φ 门控
//   E 表达欲：常驻供能，开口消耗、被搭理回血、久无人理缓慢回升
//   A 情绪唤醒度、S 社会动机：随反馈与时间变化
//   门控：发言评分过阈值 + Φ 价值过闸 + 不在冷却期 + 用户不是刚说完话
class ProactiveDrive {
  constructor(options = {}) {
    this.expression = 0.5;        // 表达欲 E（0~1，初值取融合方案的推荐值）
    this.arousal = 0.5;           // 情绪唤醒度
    this.social = 0.5;            // 社会动机（期待回应 + 好奇）
    this.ignoredStreak = 0;       // 连续「说了没人接」的次数，用来收敛
    this.spokeAt = 0;             // 上一次主动开口的时间
    this.pendingFeedback = false; // 上一次开口还没等到用户反应
    this.updatedAt = Date.now();
    this.mindset = '';            // 由 API 自己总结出的「人类主动发言思维」

    const cfg = options.config || {};
    this.threshold = readNumber(cfg.threshold, 0.72);                   // 发言触发阈值
    this.continueThreshold = readNumber(cfg.continueThreshold, 0.65);   // 续说时略放宽
    this.minIdleMs = readNumber(cfg.minIdleMs, 3 * 60 * 1000);          // 用户刚说完多久内不插嘴
    this.cooldownMs = readNumber(cfg.cooldownMs, 3 * 60 * 1000);        // 开口后的冷却
    this.continueCooldownMs = readNumber(cfg.continueCooldownMs, 60 * 1000);
    this.speechCost = readNumber(cfg.speechCost, 0.3);                  // 单次开口的表达欲消耗
    this.recoverPerMinute = readNumber(cfg.recoverPerMinute, 0.004);    // 表达欲自然回升（≈0.24/小时）
    this.ignorePenalty = readNumber(cfg.ignorePenalty, 0.12);           // 每被冷落一次扣多少分
    this.valueThreshold = readNumber(cfg.valueThreshold, 0.35);         // Φ 价值门控
  }

  // 随时间自然演化：安静久了表达欲回升，唤醒度回归基线
  elapse(now = Date.now()) {
    const minutes = (now - this.updatedAt) / 60000;
    if (!(minutes > 0)) return;
    this.updatedAt = now;
    this.expression = clamp01(this.expression + this.recoverPerMinute * minutes);
    this.arousal = clamp01(this.arousal + (0.5 - this.arousal) * Math.min(1, minutes / 60));
    this.social = clamp01(this.social + 0.003 * minutes);
  }

  // 用户说话了：有人搭理，表达欲回血，「被冷落」的账一笔勾销
  noteUserMessage(sentiment = 'neutral') {
    this.elapse();
    this.pendingFeedback = false;
    this.ignoredStreak = 0;
    if (sentiment === 'negative') {
      this.expression = clamp01(this.expression - 0.15);
      this.social = clamp01(this.social - 0.15);
      return;
    }
    this.expression = clamp01(this.expression + 0.25);
    this.social = clamp01(this.social + 0.2);
    if (sentiment === 'positive') {
      this.arousal = clamp01(this.arousal + 0.15);
    }
  }

  // 刚刚主动开了口：上一句还没人接就算一次冷落；再按篇幅扣表达欲、进入冷却
  noteSpoke({ sentences = 3 } = {}) {
    this.elapse();
    if (this.pendingFeedback) {
      this.ignoredStreak = Math.min(3, this.ignoredStreak + 1);
      this.expression = clamp01(this.expression - 0.1);
      this.social = clamp01(this.social - 0.1);
    }
    const cost = this.speechCost + Math.min(0.15, Math.max(0, sentences - 2) * 0.05);
    this.expression = clamp01(this.expression - cost);
    this.spokeAt = Date.now();
    this.pendingFeedback = true;
  }

  // 记下 API 自己总结的「人类主动发言思维」，下轮思考再喂回去
  rememberMindset(text) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (value) this.mindset = value.slice(0, 500);
  }

  // 发言评分 = 表达欲 E + Φ 价值 + 情绪唤醒度 + 社会动机 + 冷却期状态 ± 情绪 − 打扰惩罚
  // affinityScore 是她与对方此刻的好感分：越生分越克制，越熟越敢主动。
  // 不传就按 1 处理，没接关系数据的调用方行为不变。
  evaluate({ idleMs = Infinity, emotion = 'calm', workspaceValue = 0, continuing = false, affinityScore = null } = {}) {
    const now = Date.now();
    this.elapse(now);

    const window = continuing ? this.continueCooldownMs : this.cooldownMs;
    const elapsed = this.spokeAt === 0 ? Infinity : now - this.spokeAt;
    const cooldownState = this.spokeAt === 0 ? 1 : clamp01(elapsed / Math.max(1, window));

    // 「被冷落」不是永久记账：隔得久了人会自己把这口气放下，慢慢又愿意试一次
    const forgotten = elapsed > 12 * 3600 * 1000
      ? 3
      : elapsed > 5 * 3600 * 1000
        ? 2
        : elapsed > 2 * 3600 * 1000
          ? 1
          : 0;
    const ignoredStreak = Math.max(0, this.ignoredStreak - forgotten);

    // —— 软扣分：所有原本的硬拦截条件现在只折合成负分，不再挡门 —— 🌀
    const penalty = this.ignorePenalty * ignoredStreak;            // 被冷落越多越不想说（线性）
    // 用户刚说完的"别插嘴"约束：按 idleMs 离 minIdleMs 的距离线性衰减（0→1），只做提醒不硬拦
    const idleFade = idleMs === Infinity ? 1 : clamp01((idleMs - this.minIdleMs) / Math.max(1, this.minIdleMs));
    // Φ 价值不足的额外提醒（基础分已经有 0.2*workspaceValue，这里再按差距补扣）
    const valuePenalty = workspaceValue < this.valueThreshold
      ? 0.05 * (1 - workspaceValue)
      : 0;
    // 冷却没过的双重提醒（基础分已经有 0.1*cooldownState，这里再补扣）
    const extraCooldownPenalty = cooldownState < 1 ? 0.03 * (1 - cooldownState) : 0;

    const mood = EMOTION_SPEAK_MODIFIER[emotion] || 0;

    // 关系系数：0 分生分 → 打七折；满分 → 略高于原值。只压意愿，不改别的驱动力
    const closeness = Number.isFinite(affinityScore) ? clamp01(affinityScore / 100) : null;
    const affinityFactor = closeness === null ? 1 : 0.7 + 0.45 * closeness;

    const score = clamp01(
      (0.4 * this.expression +
        0.2 * clamp01(workspaceValue) +
        0.15 * this.arousal +
        0.15 * this.social +
        0.1 * cooldownState * idleFade +   // 冷却状态 × 用户刚说完的衰减
        mood -
        penalty -
        valuePenalty -
        extraCooldownPenalty) * affinityFactor
    );

    const threshold = continuing ? this.continueThreshold : this.threshold;

    // —— 所有"硬拦"条件变成"软提醒"：打日志但不挡门 —— 🌀
    // narrator 层看 score 高低来调节放行概率，CIDE 只给倾向分和日志
    const warnings = [];
    if (idleMs < this.minIdleMs) {
      warnings.push(`距用户上一条消息才 ${Math.max(1, Math.round(idleMs / 60000))} 分钟，CIDE 倾向再等等（但 narrator 可放行）`);
    }
    if (cooldownState < 1) {
      warnings.push(`刚开过口，冷却还剩 ${Math.ceil((window - elapsed) / 1000)} 秒`);
    }
    if (ignoredStreak >= 3) {
      warnings.push(`接连 ${ignoredStreak} 次主动开口都没被接住，意愿已被压低`);
    }
    if (workspaceValue < this.valueThreshold) {
      warnings.push('工作记忆里没有特别值得说的新内容');
    }
    if (score < threshold) {
      warnings.push(`发言意愿 ${score.toFixed(2)} 未过阈值 ${threshold}`);
    }
    if (closeness !== null && closeness < 0.2) {
      warnings.push('关系还很生疏，主动开口的意愿已按亲疏压过');
    }

    return {
      // 弱限制：不再让 CIDE 硬挡 narrator；shouldSpeak 始终 true（或 score 极低才给 false 作为可选提醒）
      // narrator 层最终根据 score 高低决定要不要烧额度
      shouldSpeak: score >= 0.3,  // 极低才 false，当纯提醒信号用
      score,
      threshold,
      warnings,          // 取代旧的 blocks，纯日志展示用
      // 保留 breakdown 给 narrator / status API 用
      breakdown: {
        expression: this.expression,
        arousal: this.arousal,
        social: this.social,
        workspaceValue: clamp01(workspaceValue),
        cooldownState,
        idleFade,
        penalty,
        valuePenalty,
        extraCooldownPenalty,
        ignoredStreak,
        affinityFactor
      }
    };
  }
}

// DRIVE_WEIGHTS：不同任务类型下三驱力的相对权重（想得越散越偏好奇，越想收敛越偏一致性）
const DRIVE_WEIGHTS = {
  reply: { consistency: 0.5, curiosity: 0.3, goal: 0.2 },
  task: { consistency: 0.6, curiosity: 0.15, goal: 0.25 },
  explore: { consistency: 0.25, curiosity: 0.6, goal: 0.15 },
  creative: { consistency: 0.25, curiosity: 0.4, goal: 0.35 }
};

// 三驱力（对应详细设计 5.3）：一致性 / 好奇心 / 目标，合成为「思考张力」
//   一致性：当前整合度离「想要的整合度」还差多远（差得越多，越想再整合一轮）
//   好奇心：中等整合度时最想探索——太散没头绪、太整没得挖，甜点在中间
//   目标：本轮思考的确定程度，越确定越接近「想清楚了」
// 张力越高越值得再想一轮；张力低了，元认知就该收手。
class DriveSources {
  constructor(options = {}) {
    this.targetPhi = clamp01(readNumber(options.targetPhi, 0.8));
  }

  compute({ phi = 0, goal = 0, taskType = 'reply' } = {}) {
    const p = clamp01(phi);
    const consistency = clamp01(this.targetPhi - p);       // 离目标整合度的缺口
    const curiosity = clamp01(4 * p * (1 - p));            // 中段最大（倒 U 形）
    const goalDrive = clamp01(goal);
    const weights = DRIVE_WEIGHTS[taskType] || DRIVE_WEIGHTS.reply;

    const contributions = {
      consistency: weights.consistency * consistency,
      curiosity: weights.curiosity * curiosity,
      goal: weights.goal * goalDrive
    };
    const dominant = Object.keys(contributions).reduce(
      (best, key) => (contributions[key] > contributions[best] ? key : best),
      'consistency'
    );
    const tension = clamp01(
      contributions.consistency + contributions.curiosity + contributions.goal
    );

    return {
      tension,
      dominant,
      consistency,
      curiosity,
      goal: goalDrive,
      weights
    };
  }
}

// 上行觉醒调节系统（对应详细设计 4.5）：模拟「精神头」这个总开关
//   觉醒 level 1~10 决定：还能再想几轮（maxRounds）、注意力一次能罩住几条（attentionWidth）
//   本地产出四个信号：困惑（置信度低）/ 流畅（置信度高且 Φ 高）/ 卡壳（多轮几乎无进展）/ 厌倦（低唤醒停摆）
//   「追问」「紧急」在单轮里没有可靠信号源，这里不假装有——宁可少一个信号，也不养死代码。
class ArousalSystem {
  constructor(options = {}) {
    this.initialLevel = clampRange(readNumber(options.initialLevel, 5), 1, 10);
    this.minLevel = clampRange(readNumber(options.minLevel, 3), 1, 10);
    this.maxLevel = clampRange(readNumber(options.maxLevel, 10), 1, 10);
    this.step = readNumber(options.step, 1.2);                          // 每次调节的档位幅度
    this.confusionConfidence = clamp01(readNumber(options.confusionConfidence, 0.5));
    this.flowConfidence = clamp01(readNumber(options.flowConfidence, 0.8));
    this.flowPhi = clamp01(readNumber(options.flowPhi, 0.55));
    this.stuckRounds = readNumber(options.stuckRounds, 2);              // 连续几轮无进展算卡壳
    this.lowRounds = readNumber(options.lowRounds, 2);                  // 最低觉醒对应的轮次上限
    this.highRounds = readNumber(options.highRounds, 5);                // 最高觉醒对应的轮次上限

    this.level = this.initialLevel;
    this.signal = 'neutral';
    this.stuckStreak = 0;
    this.flowStreak = 0;
  }

  // 每轮结束后观察一次，按信号升降觉醒档位
  // progress：本轮进展（置信度变化与 Φ 变化取大者）；round<=1 时传 null（还没有基准，别误判卡壳）
  observe({ confidence = 0, phi = 0, progress = null, urgent = false } = {}) {
    const conf = clamp01(confidence);
    const p = clamp01(phi);

    if (urgent) {
      this.level = this.maxLevel;
      this.signal = 'urgency';
      return this.snapshot();
    }

    if (typeof progress === 'number') {
      this.stuckStreak = progress < 0.02 ? this.stuckStreak + 1 : 0;
    }
    const flowing = conf >= this.flowConfidence && p >= this.flowPhi;
    this.flowStreak = flowing ? this.flowStreak + 1 : 0;

    let delta;
    if (this.stuckStreak >= this.stuckRounds) {
      this.signal = 'stuck';
      delta = this.step;               // 卡住了：提神，再给点算力换个思路
    } else if (conf < this.confusionConfidence) {
      this.signal = 'confusion';
      delta = this.step * 0.5;         // 迷惑：小幅提神
    } else if (flowing) {
      this.signal = 'flow';
      delta = -this.step;              // 顺畅：降一档，省点力气
    } else if (this.level <= this.minLevel) {
      this.signal = 'boredom';
      delta = this.step * 0.5;         // 太闲了：抬起来找点事做
    } else {
      this.signal = 'neutral';
      delta = 0;
    }

    this.level = clampRange(this.level + delta, this.minLevel, this.maxLevel);
    return this.snapshot();
  }

  // 觉醒档位 → 本轮允许的最大思考轮次（线性映射，再夹到 lowRounds~highRounds）
  maxRounds() {
    const span = this.maxLevel - this.minLevel;
    if (span <= 0) {
      return this.lowRounds;
    }
    const t = (this.level - this.minLevel) / span;
    return Math.max(
      this.lowRounds,
      Math.round(this.lowRounds + t * (this.highRounds - this.lowRounds))
    );
  }

  // 注意力宽度：一次能把工作记忆里多少条纳入视野（按任务类型给窄 / 中 / 宽）
  attentionWidth(taskType = 'reply') {
    const map = { task: 4, reply: 6, creative: 9, explore: 9 };
    return map[taskType] || 6;
  }

  isStuck() {
    return this.stuckStreak >= this.stuckRounds;
  }

  snapshot() {
    return {
      level: this.level,
      signal: this.signal,
      maxRounds: this.maxRounds(),
      attentionWidth: this.attentionWidth(),
      stuck: this.isStuck(),
      stuckStreak: this.stuckStreak,
      flowStreak: this.flowStreak
    };
  }
}

class CIDEEngine {
  constructor(options = {}) {
    this.unifiedAPI = options.unifiedAPI || new UnifiedAPI();
    // 用户自带的自定义 API：内部思考也优先走用户自己的 API
    this.userApiClient = new UserApiClient();
    this.workspaces = new Map();
    // 每个会话一份「自主发言驱动力」，独立于 CIDE_ENABLED：正式回复可以不开 CIDE，
    // 但自主发言通道始终需要它来判断「这会儿到底该不该开口」
    this.drives = new Map();
    // 每个会话一份「觉醒状态」：精神头决定这一轮能想几轮、注意力罩多宽
    this.arousals = new Map();
    // 内感受读源：由装配处注入的一组只读 getter（情绪/关系/记忆/作息）。
    // 中枢只做「汇总成一份快照」，不持有这些模块，也不回写——保持单向只读。
    this.interoceptionSources = null;

    const env = process.env;
    this.config = {
      enabled: env.CIDE_ENABLED === 'true',
      // 最少思考轮数：实测设为 2 能把「回复模式」的多轮率从 0% 抬到 ≈99%、啊哈触发率提升数倍，
      // 代价是 API 调用量约 1.6 倍；设 CIDE_MIN_ROUNDS=1 可退回「想到够清楚就收手」的省钱模式
      minRounds: readNumber(env.CIDE_MIN_ROUNDS, 2),
      maxRounds: Number(env.CIDE_MAX_ROUNDS) || 3,
      confidenceThreshold: Number(env.CIDE_CONFIDENCE_THRESHOLD) || 0.75,
      workspaceCapacity: Number(env.CIDE_WORKSPACE_CAPACITY) || 20,
      decayRate: Number(env.CIDE_DECAY_RATE) || 0.02,
      // 阶段二开关：默认开启；设 CIDE_PHI_ENABLED=false 可退回「不带 Φ / 觉醒」的 MVP 行为
      phiEnabled: env.CIDE_PHI_ENABLED !== 'false',
      gammaRefreshEvery: readNumber(env.CIDE_GAMMA_REFRESH_EVERY, 3)
    };

    // 觉醒调节参数（档位、轮次映射、信号阈值）可从环境变量覆盖
    this.arousalConfig = {
      initialLevel: readNumber(env.CIDE_AROUSAL_INITIAL, 5),
      minLevel: readNumber(env.CIDE_AROUSAL_MIN, 3),
      maxLevel: readNumber(env.CIDE_AROUSAL_MAX, 10),
      lowRounds: readNumber(env.CIDE_AROUSAL_LOW_ROUNDS, 2),
      highRounds: readNumber(env.CIDE_AROUSAL_HIGH_ROUNDS, 5)
    };

    // 三驱力：目标整合度越高，一致性驱力越想让结论更收敛
    this.driveSources = new DriveSources({
      targetPhi: readNumber(env.CIDE_DRIVE_TARGET_PHI, 0.8)
    });

    this.driveConfig = {
      threshold: readNumber(env.PROACTIVE_SPEECH_THRESHOLD, 0.72),
      continueThreshold: readNumber(env.PROACTIVE_SPEECH_CONTINUE_THRESHOLD, 0.65),
      minIdleMs: readNumber(env.PROACTIVE_SPEECH_MIN_IDLE_MS, 3 * 60 * 1000),
      cooldownMs: readNumber(env.PROACTIVE_SPEECH_COOLDOWN_MS, 3 * 60 * 1000),
      continueCooldownMs: readNumber(env.PROACTIVE_SPEECH_CONTINUE_COOLDOWN_MS, 60 * 1000),
      speechCost: readNumber(env.PROACTIVE_SPEECH_COST, 0.3),
      recoverPerMinute: readNumber(env.PROACTIVE_SPEECH_RECOVER_PER_MIN, 0.004),
      ignorePenalty: readNumber(env.PROACTIVE_SPEECH_IGNORE_PENALTY, 0.12),
      valueThreshold: readNumber(env.PROACTIVE_SPEECH_VALUE_THRESHOLD, 0.35)
    };

    this.metaCognition = new MetaCognition({
      confidenceThreshold: this.config.confidenceThreshold,
      minRounds: this.config.minRounds,
      maxRounds: this.config.maxRounds
    });

    // RAG 证据层：自主发言前先检索素材、发言后做溯源与事实核对（防幻觉）
    this.evidence = new EvidenceLayer({
      enabled: env.PROACTIVE_SPEECH_RAG_ENABLED !== 'false',
      maxCards: readNumber(env.PROACTIVE_SPEECH_RAG_MAX_CARDS, 8),
      enforce: env.PROACTIVE_SPEECH_RAG_ENFORCE === 'true'
    });
  }

  // 素材卡 → 注入提示词的【可用素材】+ 素材纪律（未开启 RAG 时返回空串）
  buildEvidenceInstruction(cards = []) {
    return this.evidence ? this.evidence.buildInstruction(cards) : '';
  }

  // 发言后校验：能不能对上素材。enforce 为 false 时只回报结果，由调用方决定是否丢弃
  validateSpeech(text, cards = []) {
    if (!this.evidence || !this.evidence.enabled) {
      return { enabled: false, ok: true, claims: [], unsupported: [] };
    }
    const result = this.evidence.validate(text, cards);
    return { enabled: true, enforce: this.evidence.enforce, ...result };
  }

  isEnabled() {
    return this.config.enabled === true;
  }

  getWorkspace(sessionId) {
    const key = sessionId || '__default__';
    if (!this.workspaces.has(key)) {
      this.workspaces.set(key, new GlobalWorkspace(this.config.workspaceCapacity));
    }
    return this.workspaces.get(key);
  }

  clearWorkspace(sessionId) {
    if (sessionId) {
      this.workspaces.delete(sessionId);
      this.arousals.delete(sessionId);
    } else {
      this.workspaces.clear();
      this.arousals.clear();
    }
  }

  // 把一条对话写入全局工作空间
  recordContext(sessionId, content, importance = 0.5) {
    this.getWorkspace(sessionId).add(content, { importance, source: 'dialogue' });
  }

  // 取该会话的自主发言驱动力
  getDrive(sessionId) {
    const key = sessionId || '__default__';
    if (!this.drives.has(key)) {
      this.drives.set(key, new ProactiveDrive({ config: this.driveConfig }));
    }
    return this.drives.get(key);
  }

  // 取该会话的觉醒状态
  getArousal(sessionId) {
    const key = sessionId || '__default__';
    if (!this.arousals.has(key)) {
      this.arousals.set(key, new ArousalSystem(this.arousalConfig));
    }
    return this.arousals.get(key);
  }

  // 注入内感受读源（只读 getter：emotion/relation/memory/daypart）。传空即撤销注入。
  setInteroceptionSources(sources = null) {
    this.interoceptionSources = sources && typeof sources === 'object' ? sources : null;
  }

  // 内感受快照：把各器官此刻的状态汇总成一份「机体体征」，供上层只读消费。
  // 纯派生、不落盘、不回写：任一读源抛错只记该源为 null，绝不因一个器官异常拖垮整体。
  readInteroception(sessionId, userId) {
    const src = this.interoceptionSources || {};
    const at = Date.now();
    const read = (fn) => {
      if (typeof fn !== 'function') return null;
      try {
        return fn(sessionId, userId) || null;
      } catch (error) {
        console.warn('[CIDE] 内感受快照读源失败:', error.message);
        return null;
      }
    };
    // 驱动力（自主发言）是引擎自带器官，直接取；不存在则新建一份初值快照
    let drive;
    try {
      const d = this.getDrive(sessionId);
      drive = {
        ignoredStreak: d.ignoredStreak,
        expression: d.expression,
        social: d.social,
        pendingFeedback: d.pendingFeedback
      };
    } catch {
      drive = null;
    }
    return {
      at,
      sessionId: sessionId || null,
      userId: userId || null,
      emotion: read(src.emotion),
      relation: read(src.relation),
      memory: read(src.memory),
      daypart: read(src.daypart),
      drive
    };
  }

  // 用户发来消息：给驱动力回血（自主发言调度在登记活跃时间时调用）
  noteUserMessage(sessionId) {
    this.getDrive(sessionId).noteUserMessage();
  }

  // 刚完成一次主动发言：扣表达欲、进冷却、记「说了有没有人接」
  noteProactiveSpeech(sessionId, meta = {}) {
    this.getDrive(sessionId).noteSpoke(meta);
  }

  // Φ 价值门控（近似）：工作空间里有多少「分量足、还没被讲过、并且彼此咬合」的内容
  workspaceValue(sessionId) {
    const items = this.getWorkspace(sessionId).items;
    if (items.length === 0) {
      return 0;
    }
    const avgImportance = items.reduce((sum, item) => sum + item.importance, 0) / items.length;
    const richness = Math.min(1, items.length / 12);
    // 阶段二：把 Φ 整合度纳进来——零散碎片再多，也可能不值得说；整合成整体的才更有价值
    const phi = this.config.phiEnabled ? computePhi(items) : 0;
    return clamp01(0.45 * avgImportance + 0.25 * richness + 0.30 * phi);
  }

  // 门控：这会儿到底该不该主动开口
  evaluateProactiveSpeech(sessionId, context = {}) {
    return this.getDrive(sessionId).evaluate({
      idleMs: typeof context.idleMs === 'number' ? context.idleMs : Infinity,
      emotion: context.emotion || 'calm',
      continuing: !!context.continuing,
      workspaceValue: this.workspaceValue(sessionId),
      // 关系亲疏也要进门控：刚认识就别那么自来熟，熟了才敢多开口
      affinityScore: typeof context.affinityScore === 'number' ? context.affinityScore : null
    });
  }

  // 开口前的自问清单：提醒模型按人类的主动发言思维过一遍再开口
  buildProactiveMindsetReminder() {
    return `\n【开口前先自问】这事有没有由头？这句话有没有新东西？是不是刚说过？对方此刻接得住吗？四问都过了再开口，任何一问不过就别硬说。\n`;
  }

  // 循环推理回路：多轮自我思考，返回用于引导正式回复的「思考结论」
  // mode='reply' 常规回复前的思考；mode='proactive' 无外部输入时的自主开口判断（额外给出 urge 与 mindset）
  async deliberate({ sessionId, systemPrompt = '', userInput = '', emotion = 'calm', relationStage = 'STRANGER', userApiConfig = null, mode = 'reply' }) {
    const workspace = this.getWorkspace(sessionId);
    workspace.decay(this.config.decayRate);

    const drive = this.getDrive(sessionId);
    const arousal = this.getArousal(sessionId);
    // 觉醒度决定这一轮最多想几轮：精神头不足就少想，卡壳时观察信号会自动提神、多想几轮
    const roundCeiling = Math.min(this.config.maxRounds, arousal.maxRounds());
    // 注意力宽度：一次能把工作记忆里多少条纳入本轮思考
    const attentionWidth = arousal.attentionWidth(mode === 'proactive' ? 'explore' : 'reply');

    const trace = [];
    const phiTrace = [];
    let previousConfidence = null;
    let previousPhi = null;
    let aha = false;
    let stuck = false;
    let strategy = '';
    let confidence = 0;
    let urge = null;
    let mindset = '';
    let driveState = null;
    let arousalState = arousal.snapshot();

    for (let round = 1; round <= roundCeiling; round++) {
      const messages = this.buildDeliberationMessages({
        systemPrompt,
        userInput,
        emotion,
        relationStage,
        workspaceContext: workspace.context(attentionWidth),
        trace,
        mode,
        mindset: drive.mindset
      });

      let verdict;
      try {
        let content = '';
        // 内部思考强制开思考模式：这条链路上的每一轮都必须先想再答，不允许关掉
        // （thinking 字段只有 DeepSeek 认，api.js / userApi.js 会按通道自行放行或忽略）
        if (userApiConfig && userApiConfig.enabled && userApiConfig.apiUrl) {
          // 用户启用了自定义API，内部思考也走该用户的API
          content = await this.userApiClient.callApi(
            userApiConfig,
            messages.filter((msg) => msg.role !== 'system'),
            messages.find((msg) => msg.role === 'system')?.content || '',
            { thinking: 'enabled' }
          );
        } else {
          const result = await this.unifiedAPI.callAPI(messages, null, { thinking: 'enabled', callSite: 'cideThink' });
          content = result?.choices?.[0]?.message?.content || '';
        }
        verdict = parseVerdict(content);
      } catch (error) {
        console.error(`[CIDE] 第${round}轮思考失败: ${error.message}`);
        break;
      }

      if (!verdict) {
        break;
      }

      const thought = typeof verdict.thought === 'string' ? verdict.thought.trim() : '';
      confidence = Number(verdict.confidence);
      confidence = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0;
      if (thought) {
        strategy = thought;
        workspace.add(thought, { importance: confidence, source: 'deliberation' });
      }

      // 自主发言模式：模型自评「此刻想开口的意愿」，并由它自己总结人类主动发言思维
      if (mode === 'proactive') {
        const reportedUrge = Number(verdict.urge);
        if (Number.isFinite(reportedUrge)) {
          urge = Math.min(1, Math.max(0, reportedUrge));
        }
        const reportedMindset = typeof verdict.mindset === 'string' ? verdict.mindset.trim() : '';
        if (reportedMindset) {
          mindset = reportedMindset;
        }
      }

      // Φ 整合度：这一轮工作记忆里所有想法「抱团」得有多紧
      const phi = this.config.phiEnabled ? computePhi(workspace.items) : 0;
      // 单轮进展：置信度与 Φ 谁涨得多算谁（卡壳判定用）；首轮没有基准，传 null 避免误判
      const deltaConf = typeof previousConfidence === 'number' ? Math.abs(confidence - previousConfidence) : 0;
      const deltaPhi = previousPhi === null ? 0 : Math.abs(phi - previousPhi);
      const progress = round === 1 ? null : Math.max(deltaConf, deltaPhi);
      // 啊哈时刻：Φ 一次性跃升，说明零散想法忽然咬合成一个整体
      if (previousPhi !== null && phi - previousPhi >= 0.15) {
        aha = true;
      }

      trace.push({
        round,
        thought,
        confidence,
        phi,
        continue: verdict.continue !== false
      });
      phiTrace.push(phi);

      // γ 特征绑定：每隔几轮把高相似碎片合并成「超级块」，给工作记忆腾地方
      if (this.config.gammaRefreshEvery > 0 && round % this.config.gammaRefreshEvery === 0) {
        workspace.rebind({ threshold: 0.5 });
      }

      // 觉醒观察：按困惑 / 流畅 / 卡壳 / 厌倦信号调节精神头
      arousalState = arousal.observe({ confidence, phi, progress });
      stuck = arousalState.stuck;

      // 三驱力张力：一致性 / 好奇心 / 目标谁最占上风，决定还值不值得再想
      driveState = this.driveSources.compute({
        phi,
        goal: confidence,
        taskType: mode === 'proactive' ? 'explore' : 'reply'
      });

      const shouldContinue = this.metaCognition.shouldContinue({
        round,
        confidence,
        previousConfidence,
        modelContinue: verdict.continue,
        tension: driveState.tension,
        stuck
      });
      if (!shouldContinue) {
        break;
      }
      previousConfidence = confidence;
      previousPhi = phi;
    }

    // 把 API 自己总结的「人类主动发言思维」存回驱动力，下一轮思考与开口都带上它
    // （只存在驱动力里，不写进全局工作空间——否则会抬高 Φ 价值门控，反而更容易开口）
    if (mode === 'proactive' && mindset) {
      drive.rememberMindset(mindset);
    }

    return {
      strategy,
      confidence,
      rounds: trace.length,
      trace,
      urge,
      mindset,
      // 阶段二新增观测：末轮 Φ、Φ 轨迹、啊哈时刻、卡壳、觉醒信号、三驱力状态
      phi: phiTrace.length > 0 ? phiTrace[phiTrace.length - 1] : 0,
      phiTrace,
      aha,
      stuck,
      signal: arousalState.signal,
      arousal: arousalState,
      drive: driveState
    };
  }

  // 构造单轮思考请求：系统提示（角色设定 + 思考要求）+ 用户提示（上下文 + 已有思考）
  buildDeliberationMessages({ systemPrompt, userInput, emotion, relationStage, workspaceContext, trace, mode = 'reply', mindset = '' }) {
    const system = mode === 'proactive'
      ? `你是情感陪伴角色的「内部思考引擎」，你的输出不会被用户看到。
现在没有新消息，是角色自己在琢磨要不要主动开口——先掂量由头，再决定说还是不说。

${PROACTIVE_SPEECH_MINDSET}

只输出如下 JSON，不要任何多余文字：
{
  "thought": "本轮内心思考（现在有没有开口的由头、想说什么、为什么）",
  "urge": 0.0到1.0之间的小数（此刻主动开口的意愿强度）,
  "mindset": "你对人类主动发言思维的一句话总结（可复述，也可修正得更准）",
  "confidence": 0.0到1.0之间的小数,
  "continue": true 或 false
}
urge 通常低于 0.6 时倾向沉默，但如果你觉得这次确实有必要（有明确由头、有新东西可说），也可以开口——urge 只是参考，不是硬命令。`
      : `你是情感陪伴角色的「内部思考引擎」，你的输出不会被用户看到。
请基于角色设定，就该用户当下的言语，进行一段简短的内心思考：判断用户的情绪与意图，并决定这一轮该如何回应。
只输出如下 JSON，不要任何多余文字：
{
  "thought": "本轮内心思考（如何回应该用户，注意情绪与关系阶段）",
  "confidence": 0.0到1.0之间的小数,
  "continue": true 或 false
}
confidence 表示你认为思考是否已经充分、可以直接生成回复；continue 表示是否需要再思考一轮。`;

    const parts = [];
    if (systemPrompt) {
      parts.push(`【角色设定】\n${systemPrompt}`);
    }
    if (workspaceContext) {
      parts.push(`【工作记忆】\n${workspaceContext}`);
    }
    // 两个标签之间用的是全角空格当分隔符（有意为之），不是乱码
    // eslint-disable-next-line no-irregular-whitespace
    parts.push(`【当前情绪】${emotion}　【关系阶段】${relationStage}`);
    parts.push(
      mode === 'proactive'
        ? `【用户说】${userInput || '（用户暂无输入，是角色自己想事情）'}`
        : `【用户说】${userInput || '（用户暂无输入）'}`
    );
    if (mode === 'proactive' && mindset) {
      parts.push(`【你此前总结的主动发言思维】\n${mindset}\n请在此基础上继续收敛，别重复已经想过的话头。`);
    }
    if (trace && trace.length > 0) {
      const previous = trace
        .map(item => `第${item.round}轮思考：${item.thought}（置信度 ${item.confidence}）`)
        .join('\n');
      parts.push(`【你此前的思考】\n${previous}\n请在此基础上进一步收敛，若已充分则降低继续意愿。`);
    }

    return [
      { role: 'system', content: system },
      { role: 'user', content: parts.join('\n\n') }
    ];
  }

  // 把思考结论转成注入正式回复系统提示词的片段
  buildInstruction(strategy) {
    if (!strategy) {
      return '';
    }
    return `\n【内心思考（仅供你参考，不要直接说出）】\n${strategy}\n`;
  }
}

module.exports = {
  CIDEEngine,
  GlobalWorkspace,
  MetaCognition,
  ProactiveDrive,
  EvidenceLayer,
  ArousalSystem,
  DriveSources,
  computePhi
};
