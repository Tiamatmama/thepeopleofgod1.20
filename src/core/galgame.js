const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');

// 负向区间的修复阻尼（纯算术，不依赖实例与落盘，便于单独验证）：
//   分数还在 0 以下时，正向收益按 damping 折算，至少保留 +1（做对的事不能毫无进展）；
//   分数 >= 0、或本轮是负向变化 / 无变化时，原样返回。
// damping 落在 [0, 1] 之外或非数字时按默认 0.7 处理；入参非有限数时原样返回，不制造 NaN。
const DEFAULT_RECOVERY_DAMPING = 0.7;

// 修复迟疑的窗口：阻尼生效后 48 小时内，她都处在「这句还没完全接住」的状态。
// 回到正区间就当修复落定，不追加旧账；窗口过了还没走回来，这条迟疑按失效处理，不无限挂着
const DELAYED_REPAIR_WINDOW_MS = 48 * 60 * 60 * 1000;

function applyRecoveryDamping(previousScore, scoreChange, damping = DEFAULT_RECOVERY_DAMPING) {
  const prev = Number(previousScore);
  const change = Number(scoreChange);
  if (!Number.isFinite(prev) || !Number.isFinite(change)) return scoreChange;
  if (prev >= 0 || change <= 0) return change;
  // null / undefined 走默认（Number(null) 会是 0，等于把阻尼全关，这里显式挡掉）
  const rawFactor = (damping === null || damping === undefined) ? NaN : Number(damping);
  const factor = Number.isFinite(rawFactor)
    ? Math.min(1, Math.max(0, rawFactor))
    : DEFAULT_RECOVERY_DAMPING;
  return Math.max(1, Math.round(change * factor));
}

class GalgameModule {
  // 确保存储目录存在
  ensureStorageDir(storagePath) {
    if (!fs.existsSync(storagePath)) {
      fs.mkdirSync(storagePath, { recursive: true });
    }
  }
  
  // 默认好感度判定规则
  defaultAffectionRules = [
    { threshold: 0.5, change: 5, reason: '用户表现出非常积极的情绪' },
    { threshold: 0.3, change: 3, reason: '用户表现出较为积极的情绪' },
    { threshold: 0, change: 2, reason: '用户表现出轻微积极的情绪' },
    { threshold: -0.3, change: 1, reason: '用户情绪较为中性' },
    { threshold: -0.6, change: 0, reason: '用户情绪略显消极' },
    { threshold: -Infinity, change: -3, reason: '用户表现出恶意或消极的情绪' }
  ];
  
  constructor() {
    this.relationshipStages = {
      STRANGER: {
        name: '陌生',
        minScore: 0,
        maxScore: 20,
        availableActions: ['greet'],
        availableVoices: ['polite'],
        permissions: ['basic']
      },
      ACQUAINTANCE: {
        name: '熟悉',
        minScore: 21,
        maxScore: 40,
        availableActions: ['greet', 'basic_talk'],
        availableVoices: ['polite', 'friendly'],
        permissions: ['basic', 'close_distance']
      },
      FRIEND: {
        name: '信任',
        minScore: 41,
        maxScore: 60,
        availableActions: ['greet', 'basic_talk', 'deep_talk'],
        availableVoices: ['polite', 'friendly', 'warm'],
        permissions: ['basic', 'close_distance', 'physical_contact']
      },
      CLOSE_FRIEND: {
        name: '依赖',
        minScore: 61,
        maxScore: 80,
        availableActions: ['greet', 'basic_talk', 'deep_talk', 'intimate_talk'],
        availableVoices: ['polite', 'friendly', 'warm', 'intimate'],
        permissions: ['basic', 'close_distance', 'physical_contact', 'private_info']
      },
      LOVER: {
        name: '专属',
        minScore: 81,
        maxScore: 100,
        availableActions: ['greet', 'basic_talk', 'deep_talk', 'intimate_talk', 'romantic_gestures'],
        availableVoices: ['polite', 'friendly', 'warm', 'intimate', 'loving'],
        permissions: ['basic', 'close_distance', 'physical_contact', 'private_info', 'romantic']
      },
      HATE: {
        name: '厌恶',
        minScore: -100,
        maxScore: -31,
        availableActions: ['none'],
        availableVoices: ['cold'],
        permissions: ['basic', 'swear']
      },
      DISLIKE: {
        name: '反感',
        minScore: -30,
        maxScore: -1,
        availableActions: ['none'],
        availableVoices: ['cold'],
        permissions: ['basic']
      }
    };
    
    // 开发者权限设置
    this.developerSettings = {
      enableSwear: false // 是否允许骂人
    };
    
    // 好感度判定规则
    this.affectionRules = [...this.defaultAffectionRules];
    
    // 好感度按角色（会话）分档：每个会话各存一份，互不影响
    this.relationships = {};
    
    // 存储文件路径
    this.storagePath = path.join(__dirname, '../../data');
    this.relationshipFile = path.join(this.storagePath, 'relationships.json');
    this.legacyRelationshipFile = path.join(this.storagePath, 'relationship.json');
    this.affectionRulesFile = path.join(this.storagePath, 'affection_rules.json');
    
    // 确保存储目录存在
    this.ensureStorageDir(this.storagePath);
    
    // 加载已保存的关系状态
    this.loadRelationship();
    
    // 加载开发者设置
    this.loadDeveloperSettings();
    
    // 加载好感度判定规则
    this.loadAffectionRules();
  }
  
  // 好感度按「角色会话 × 用户」二维分档：同一 session 不同登录用户各自独立一份，互不窜档
  // key 格式：sessionId|userId；userId 缺省 default；旧格式（纯 sessionId）启动时统一迁移到 sessionId|default
  buildKey(sessionId, userId) {
    const sid = sessionId || 'default';
    const uid = (typeof userId === 'string' && userId.trim()) ? userId.trim() : 'default';
    return `${sid}|${uid}`;
  }

  // 取得某个角色会话下、某个用户的好感度档位；不存在则初始化一份
  getRelationshipState(sessionId, userId) {
    const key = this.buildKey(sessionId, userId);
    if (!this.relationships[key]) {
      this.relationships[key] = { currentScore: 0, relationshipHistory: [] };
    }
    return this.relationships[key];
  }

  // 保存某个 key 的关系状态到文件（按会话×用户分档）
  saveRelationship(sessionId, userId) {
    try {
      const key = this.buildKey(sessionId, userId);
      this.relationships[key] = this.getRelationshipState(sessionId, userId);

      this.ensureStorageDir(this.storagePath);

      // 原子写：先写临时文件再 rename，崩溃/断电时不会留下半截 JSON 导致好感度档损坏
      writeJsonAtomicSync(this.relationshipFile, this.relationships);
    } catch (error) {
      console.error('保存关系状态失败:', error);
    }
  }

  // 加载关系状态：key 统一为 sessionId|userId；旧格式（纯 sessionId 不带 |）启动时一律
  // 迁移到 sessionId|default，避免数据丢失；legacy relationship.json（早期单份全局）迁移到 default|default
  loadRelationship() {
    const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
    try {
      let migrated = 0;
      let data = null;
      if (fs.existsSync(this.relationshipFile)) {
        data = readJson(this.relationshipFile);
      } else if (fs.existsSync(this.legacyRelationshipFile)) {
        const legacy = readJson(this.legacyRelationshipFile);
        data = { default: legacy };
        console.log('已把旧的全局关系状态迁移到 default 档');
      } else {
        this.relationships = {};
        return;
      }

      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        this.relationships = {};
        return;
      }

      const next = {};
      Object.entries(data).forEach(([oldKey, val]) => {
        if ('currentScore' in val && 'relationshipHistory' in val) {
          // 已带 userId 维度：原样保留
          if (oldKey.includes('|')) {
            next[oldKey] = val;
          } else {
            // 旧格式纯 sessionId → 迁移到 sessionId|default
            const newKey = this.buildKey(oldKey, 'default');
            next[newKey] = val;
            migrated++;
          }
        }
      });

      if (migrated > 0) {
        console.log(`[Galgame] 好感度分档升级：${migrated} 份旧格式（纯 sessionId）迁移到 sessionId|default，新用户从 0 开始`);
        this.relationships = next;
        this.saveRelationshipForInitMigrate();
      } else {
        this.relationships = next;
      }
      console.log(`加载了 ${Object.keys(this.relationships).length} 份会话×用户关系状态`);
    } catch (error) {
      console.error('加载关系状态失败:', error);
      this.relationships = {};
    }
  }

  // 迁移过程中需要整份 relationships 重写，不走带 sessionId 语义的 saveRelationship
  saveRelationshipForInitMigrate() {
    try {
      fs.writeFileSync(this.relationshipFile, JSON.stringify(this.relationships, null, 2));
    } catch (error) {
      console.error('保存迁移后的关系状态失败:', error);
    }
  }
  
  // 最大历史长度
  maxHistoryLength = 50;

  // 负向区间的修复阻尼：伤了之后再哄回来，本来就比一开始处好更难。
  // 分数还在 0 以下时，正向收益只按七成计入（至少保留 +1，别让做对的事毫无进展）；
  // 回到 0 以上立刻恢复原速。只管正向变化，负向照旧。算法见 applyRecoveryDamping
  negativeRecoveryDamping = DEFAULT_RECOVERY_DAMPING;

  // 更新关系状态 - 支持API返回的好感度变化
  updateRelationship(inputData, apiAffectionChange = null, apiThinking = '', sessionId = 'default', userId = 'default') {
    const state = this.getRelationshipState(sessionId, userId);
    const value = inputData.value || 0;
    const previousScore = state.currentScore;
    
    let scoreChange = 0;
    let changeReason = '';
    let thinkingProcess = '';
    
    // 优先使用API返回的好感度变化
    if (typeof apiAffectionChange === 'number' && Number.isFinite(apiAffectionChange)) {
      scoreChange = apiAffectionChange;
      changeReason = 'API判断好感度变化';
      thinkingProcess = apiThinking || `API分析用户输入后判定好感度变化为 ${scoreChange}`;
      console.log(`[Galgame] 使用API返回的好感度变化: ${scoreChange}`);
    } else {
      // 使用可配置的好感度判定规则
      for (const rule of this.affectionRules) {
        if (value > rule.threshold) {
          scoreChange = rule.change;
          changeReason = rule.reason;
          thinkingProcess = `检测到用户情绪值为${value.toFixed(2)}，超过阈值${rule.threshold}，${rule.reason}，${scoreChange > 0 ? '给予+' : ''}${scoreChange}好感度${scoreChange >= 0 ? '提升' : '降低'}。`;
          break;
        }
      }
      console.log(`[Galgame] 使用本地规则计算好感度变化: ${scoreChange}`);
    }

    // 好感度已经拉满之后的黏性：只有 -10 级别的重创才让它掉 1 分，
    // 日常闹脾气、小摩擦一律归 0，避免满值后被慢慢磨下去
    if (previousScore >= 100 && scoreChange < 0) {
      const damped = -Math.floor(Math.abs(scoreChange) / 10);
      console.log(`[Galgame] 好感度已满，负向变化 ${scoreChange} 削弱为 ${damped}`);
      scoreChange = damped;
    }

    // 负向区间的修复阻尼：还在 0 分以下时正向收益只算七成，至少保留 +1。
    // 满值黏性处理的是上一档（>=100）的负向变化，两者区间不重叠
    const nowTs = Date.now();
    // 过期就先清掉：迟疑不是无限期挂着的账
    if (state.delayedRepair && nowTs >= (Number(state.delayedRepair.expireAt) || 0)) {
      console.log('[Galgame] 修复迟疑已过 48 小时仍未走回正区间，按失效处理');
      state.delayedRepair = null;
    }
    const dampedRecovery = applyRecoveryDamping(previousScore, scoreChange, this.negativeRecoveryDamping);
    let delayedRepairApplied = false;
    if (dampedRecovery !== scoreChange) {
      console.log(`[Galgame] 好感度为负（${previousScore}），修复收益 ${scoreChange} 打折为 ${dampedRecovery}`);
      delayedRepairApplied = true;
      // 明账：阻尼不能只是数字上悄悄少给，得同时留下一条「这句还没接住」的迟疑，
      // 供上层读出来让她说清楚，而不是让同一句道歉今天莫名不管用
      if (state.delayedRepair && typeof state.delayedRepair === 'object') {
        state.delayedRepair = {
          ...state.delayedRepair,
          lastAt: nowTs,
          gap: (Number(state.delayedRepair.gap) || 0) + (scoreChange - dampedRecovery)
        };
      } else {
        state.delayedRepair = {
          at: nowTs,
          lastAt: nowTs,
          expireAt: nowTs + DELAYED_REPAIR_WINDOW_MS,
          fromScore: previousScore,
          gap: scoreChange - dampedRecovery
        };
      }
      scoreChange = dampedRecovery;
      changeReason = `${changeReason}（负向修复阻尼）`;
    }

    // 更新好感度（支持-100到100范围）
    state.currentScore = Math.max(-100, Math.min(100, state.currentScore + scoreChange));

    // 回到正区间 = 修复落定：迟疑清掉，不追加旧账（不因为「你欠我的」再罚一次）
    let recovered = false;
    if (state.currentScore >= 0 && state.delayedRepair) {
      console.log(`[Galgame] 好感回到 ${state.currentScore}，修复落定，不追加旧账`);
      state.delayedRepair = null;
      recovered = true;
    }
    
    // 确定当前关系阶段
    const currentStage = this.getRelationshipStage(sessionId, userId);
    const previousStage = this.getRelationshipStageByScore(previousScore);
    
    // 记录关系历史
    state.relationshipHistory.push({
      score: state.currentScore,
      stage: currentStage,
      timestamp: Date.now(),
      change: scoreChange,
      reason: changeReason
    });
    
    // 限制历史长度
    if (state.relationshipHistory.length > this.maxHistoryLength) {
      state.relationshipHistory.shift();
    }
    
    // 保存到文件
    this.saveRelationship(sessionId, userId);
    
    // 记录好感度变化到日志（把「明账」的两件事一起记进去：本轮是否被阻尼、修复是否落定）
    this.logAffectionChange(previousScore, state.currentScore, scoreChange, changeReason, thinkingProcess, sessionId, userId, {
      delayed: delayedRepairApplied,
      recovered,
      delayedRepair: state.delayedRepair ? { ...state.delayedRepair } : null
    });
    
    const result = {
      stage: currentStage,
      score: state.currentScore,
      stageName: this.relationshipStages[currentStage].name,
      availableActions: this.relationshipStages[currentStage].availableActions,
      availableVoices: this.relationshipStages[currentStage].availableVoices,
      permissions: this.relationshipStages[currentStage].permissions,
      timestamp: Date.now(),
      // 好感度变化详情
      affectionChange: {
        change: scoreChange,
        previousScore: previousScore,
        currentScore: state.currentScore,
        reason: changeReason,
        thinkingProcess: thinkingProcess,
        stageChanged: previousStage !== currentStage,
        previousStage: previousStage,
        newStage: currentStage,
        // 明账：本轮被阻尼了 = 她这轮本来就该「慢半拍」；还没落定就继续挂着
        delayed: delayedRepairApplied,
        recovered,
        delayedRepair: state.delayedRepair ? { ...state.delayedRepair } : null
      }
    };
    
    return result;
  }
  
  // 读取「还没落定的修复迟疑」。上层可在下一轮开始前取一次，让她的语气带一点接不住的迟钝，
  // 而不是同一句道歉今天莫名不管用——这才是把阻尼从暗账翻成明账的那一步
  getDelayedRepair(sessionId = 'default', userId = 'default') {
    const state = this.getRelationshipState(sessionId, userId);
    const pending = state && state.delayedRepair;
    if (!pending || typeof pending !== 'object') return null;
    if (Date.now() >= (Number(pending.expireAt) || 0)) return null;
    return {
      at: Number(pending.at) || 0,
      lastAt: Number(pending.lastAt) || 0,
      expireAt: Number(pending.expireAt) || 0,
      fromScore: Number(pending.fromScore) || 0,
      gap: Number(pending.gap) || 0
    };
  }

  // 记录好感度变化到日志
  // opts.delayed / opts.recovered 是「明账」的两个观测字段：本轮是否被阻尼、修复是否落定。
  // 只记分数不记这两项，负向修复就又变回暗账了
  logAffectionChange(previousScore, currentScore, change, reason, thinkingProcess, sessionId = 'default', userId = 'default', opts = {}) {
    const logData = {
      timestamp: new Date().toISOString(),
      type: 'affection_change',
      sessionId: sessionId,
      userId: userId,
      previousScore: previousScore,
      currentScore: currentScore,
      change: change,
      reason: reason,
      thinkingProcess: thinkingProcess,
      delayed: Boolean(opts.delayed),
      recovered: Boolean(opts.recovered),
      delayedRepair: opts.delayedRepair || null
    };
    
    try {
      const fs = require('fs');
      const path = require('path');
      const logPath = path.join(__dirname, '../../data/affection_logs.json');
      
      let logs = [];
      if (fs.existsSync(logPath)) {
        try {
          const existingLogs = fs.readFileSync(logPath, 'utf8');
          logs = JSON.parse(existingLogs);
        } catch (e) {
          console.error('[Galgame] 读取好感度日志失败:', e);
        }
      }
      
      logs.push(logData);
      
      // 只保留最近1000条记录
      if (logs.length > 1000) {
        logs = logs.slice(-1000);
      }
      
      fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
      console.log(`[Galgame] 好感度变化已记录: ${change} (${previousScore} -> ${currentScore})`);
    } catch (error) {
      console.error('[Galgame] 记录好感度日志失败:', error);
    }
  }
  
  // 根据分数获取关系阶段（辅助方法）
  getRelationshipStageByScore(score) {
    if (score >= 81) return 'LOVER';
    if (score >= 61) return 'CLOSE_FRIEND';
    if (score >= 41) return 'FRIEND';
    if (score >= 21) return 'ACQUAINTANCE';
    if (score >= 0) return 'STRANGER';
    if (score >= -30) return 'DISLIKE';
    return 'HATE';
  }

  // 获取当前关系阶段
  getRelationshipStage(sessionId = 'default', userId = 'default') {
    const score = this.getRelationshipState(sessionId, userId).currentScore;
    if (score >= 81) return 'LOVER';
    if (score >= 61) return 'CLOSE_FRIEND';
    if (score >= 41) return 'FRIEND';
    if (score >= 21) return 'ACQUAINTANCE';
    if (score >= 0) return 'STRANGER';
    if (score >= -30) return 'DISLIKE';
    return 'HATE';
  }

  // 获取关系历史
  getRelationshipHistory(sessionId = 'default', userId = 'default') {
    return this.getRelationshipState(sessionId, userId).relationshipHistory;
  }

  // 获取当前关系状态
  getCurrentRelationship(sessionId = 'default', userId = 'default') {
    const state = this.getRelationshipState(sessionId, userId);
    const currentStage = this.getRelationshipStage(sessionId, userId);
    return {
      stage: currentStage,
      score: state.currentScore,
      stageName: this.relationshipStages[currentStage].name,
      availableActions: this.relationshipStages[currentStage].availableActions,
      availableVoices: this.relationshipStages[currentStage].availableVoices,
      permissions: this.relationshipStages[currentStage].permissions,
      // 还没落定的修复迟疑（窗口内才有值）。随关系状态一起走，所有通道（网页/QQ/直播）
      // 只要拿的是这份关系快照，就都能看见「上一轮那句她还没接住」，不必各自再查一次
      delayedRepair: this.getDelayedRepair(sessionId, userId)
    };
  }

  // 未选定角色时对外展示的陌生人状态（不落盘、不读写任何用户档）
  getStrangerRelationship() {
    const stage = 'STRANGER';
    return {
      stage,
      score: 0,
      stageName: this.relationshipStages[stage].name,
      availableActions: this.relationshipStages[stage].availableActions,
      availableVoices: this.relationshipStages[stage].availableVoices,
      permissions: this.relationshipStages[stage].permissions,
      delayedRepair: null
    };
  }

  // 重置关系状态
  resetRelationship(sessionId = 'default', userId = 'default') {
    const state = this.getRelationshipState(sessionId, userId);
    state.currentScore = 0;
    state.relationshipHistory = [];
    this.saveRelationship(sessionId, userId);
  }
  
  // 设置骂人权限
  setSwearEnabled(enabled) {
    this.developerSettings.enableSwear = enabled;
    console.log(`[Galgame] 骂人权限已${enabled ? '开启' : '关闭'}`);
    // 保存设置
    this.saveDeveloperSettings();
  }
  
  // 保存开发者设置
  saveDeveloperSettings() {
    try {
      const fs = require('fs');
      const path = require('path');
      const settingsPath = path.join(this.storagePath, 'developer_settings.json');
      
      fs.writeFileSync(settingsPath, JSON.stringify(this.developerSettings, null, 2));
      console.log('[Galgame] 开发者设置已保存');
    } catch (error) {
      console.error('[Galgame] 保存开发者设置失败:', error);
    }
  }
  
  // 加载开发者设置
  loadDeveloperSettings() {
    try {
      const fs = require('fs');
      const path = require('path');
      const settingsPath = path.join(this.storagePath, 'developer_settings.json');
      
      if (fs.existsSync(settingsPath)) {
        const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        this.developerSettings = { ...this.developerSettings, ...data };
        console.log('[Galgame] 开发者设置已加载');
      }
    } catch (error) {
      console.error('[Galgame] 加载开发者设置失败:', error);
    }
  }
  
  // 加载好感度判定规则
  loadAffectionRules() {
    try {
      if (fs.existsSync(this.affectionRulesFile)) {
        const data = JSON.parse(fs.readFileSync(this.affectionRulesFile, 'utf8'));
        if (Array.isArray(data) && data.length > 0) {
          this.affectionRules = data;
          console.log('[Galgame] 好感度判定规则已加载');
        }
      }
    } catch (error) {
      console.error('[Galgame] 加载好感度判定规则失败:', error);
    }
  }
  
  // 保存好感度判定规则
  saveAffectionRules() {
    try {
      fs.writeFileSync(this.affectionRulesFile, JSON.stringify(this.affectionRules, null, 2));
      console.log('[Galgame] 好感度判定规则已保存');
    } catch (error) {
      console.error('[Galgame] 保存好感度判定规则失败:', error);
    }
  }
  
  // 获取好感度判定规则
  getAffectionRules() {
    return this.affectionRules;
  }
  
  // 设置好感度判定规则
  setAffectionRules(rules) {
    if (Array.isArray(rules) && rules.length > 0) {
      // 验证规则格式
      const validRules = rules.filter(rule => 
        typeof rule.threshold === 'number' && 
        typeof rule.change === 'number' && 
        typeof rule.reason === 'string'
      );
      
      if (validRules.length > 0) {
        // 按阈值降序排序
        this.affectionRules = validRules.sort((a, b) => b.threshold - a.threshold);
        this.saveAffectionRules();
        console.log('[Galgame] 好感度判定规则已更新');
        return true;
      }
    }
    return false;
  }
  
  // 重置为默认规则
  resetAffectionRules() {
    this.affectionRules = [...this.defaultAffectionRules];
    this.saveAffectionRules();
    console.log('[Galgame] 好感度判定规则已重置为默认');
  }
  
  // 获取当前权限状态
  getPermissions(sessionId = 'default', userId = 'default') {
    const currentStage = this.getRelationshipStage(sessionId, userId);
    let permissions = [...this.relationshipStages[currentStage].permissions];
    
    // 如果开发者开启了骂人权限，添加swear权限
    if (this.developerSettings.enableSwear && !permissions.includes('swear')) {
      permissions.push('swear');
    }
    
    return permissions;
  }
}

module.exports = GalgameModule;
// 纯算术单独挂出来，供测试直接引用，不必构造实例（构造会读写 data/）
module.exports.applyRecoveryDamping = applyRecoveryDamping;
module.exports.DEFAULT_RECOVERY_DAMPING = DEFAULT_RECOVERY_DAMPING;
module.exports.DELAYED_REPAIR_WINDOW_MS = DELAYED_REPAIR_WINDOW_MS;