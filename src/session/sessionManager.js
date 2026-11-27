const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');

// 在场对话硬下限：会话文件里始终保留最近这么多条，任何一次归档都不会把它削得更少
const RESIDENT_CONVERSATION_MESSAGES = 300;
// 归档批量：在场条数涨到「硬下限 + 批量」才剪一次，一次剪掉最老的这么多条（剪完仍剩满硬下限）
const CONVERSATION_ARCHIVE_BATCH = 100;
// 归档触发线：到线才蒸一次，不再来一条消息就触发一次蒸馏
const CONVERSATION_ARCHIVE_TRIGGER = RESIDENT_CONVERSATION_MESSAGES + CONVERSATION_ARCHIVE_BATCH;
// 段位每段的长度：最新 100 条在场、中间 100 条余温、更早的 100 条沉底
const CONVERSATION_TIER_SIZE = 100;
const TIER_PRESENT = '在场';
const TIER_WARM = '余温';
const TIER_SUNK = '沉底';
// 归档条目编号：前缀是类型（食物、吉他、约定…），后缀是按时间全局递增的四位序号，如 食物-0003
const ARCHIVE_SEQ_PAD = 4;
const DEFAULT_ARCHIVE_TYPE = '对话';

// 记忆/人格分区自动判定：先看消息是不是「元层面」的
//  - 进入 AI 态：元层面名词 + 动作或疑问同时出现（查日志、改这个函数、你的提示词是什么）
//    名词里也认文件路径特征（.js/.log 这类后缀、src/ scripts/ 这类目录），「帮我看看 src/core/output.js 那段」才算得上
//  - 维持 AI 态：元名词单独出现，或「结果呢/再跑一次」这类接续词
//  - 连续 PERSONA_AI_MISS_LIMIT 轮都没弱命中，退回角色态
// 阈值故意偏保守：角色态被误判成 AI 态会当场出戏，漏判只是晚一轮切过去
// 另收「能力/外设」类名词（摄像头、镜头、抓拍、抓取、拍照、屏幕、桌面）：提到它就是要动这台机器，同属元层面
// 抓拍/看屏幕的各种同义说法都要收齐：只认「抓拍」的话，用户说「抓取」「拍一张」时切不进 AI 态，
// 角色态又没有摄像头工具，她只能顺着演，演成「你去点那个抓取按钮」；看屏幕同理
// 不收「眼睛」这类会出现在情话里的词，避免「看看你的眼睛」被误判成 AI 态
const PERSONA_META_NOUN = /(源码|源代码|代码|脚本|日志|developer\.log|提示词|prompt|系统提示|架构|模块|函数|接口|配置文件|配置项|报错|异常信息|bug|崩溃|进程|端口|摄像头|摄像|镜头|webcam|抓拍|抓取|拍照|拍一张|拍张|拍个照|照一张|屏幕|桌面|截屏|截图|桥接|窗口|数据库|记忆库|人格|角色卡|向量库|向量|qdrant|完整性|codeintegrity|自检|运行状态|劫持|benchmark|跑分|token|\bapi\b|\.(?:js|json|log|py|md|ts|yml|yaml|env)\b|\b(?:src|scripts|data|config)[\\/])/i;
// 「开/关」是裸字，必须用负向断言挡掉「开心/关心/关于/开始」这类日常用词，否则情话会当场翻成 AI 态
const PERSONA_META_VERB = /(查|看|读|改|修|跑|执行|测试|检查|校验|自检|重启|启动|部署|调用|打开|抓|拍|开(?!心|始|玩笑|销)|关(?!心|怀|于)|在不在|在吗|有没有|能不能|能用|是什么|长什么样|怎么写的|怎么回事|为什么)/;
const PERSONA_FOLLOWUP = /^(结果呢|结果|然后呢|继续|再跑一次|再跑|再来一次|再来|为什么|怎么这样|好了吗|跑完了吗|还有呢|再试一次|重试|那呢)/;
const PERSONA_AI_MISS_LIMIT = 2;

class SessionManager {
  // options.storagePath / options.archivePath：让调用方换一套独立目录（如 QQ 桥接）
  // options.dedupeByName === false：关掉「同名角色只留最新一份」的去重
  constructor(options = {}) {
    const opts = options || {};
    this.storagePath = opts.storagePath || path.join(__dirname, '../../data/sessions');
    this.archivePath = opts.archivePath || path.join(__dirname, '../../data/archives');
    this.sessions = {};
    this.archiveHandler = null;
    // 记忆分区判定状态（按 userId 记，跨会话一致）：{ [userId]: { scope, missStreak } }
    // 只存内存：重启后从角色态重新开始，符合「默认就是角色」的直觉
    this.personaStates = {};
    this.ensureStorageDir();
    this.loadAllSessions();
    // 独立目录里同一个角色会有多份（每个 QQ 一份），按名字去重会把别人的存档删掉，故可关闭
    if (opts.dedupeByName !== false) {
      this.dedupeByName();
    }
  }

  ensureStorageDir() {
    if (!fs.existsSync(this.storagePath)) {
      fs.mkdirSync(this.storagePath, { recursive: true });
    }
    if (!fs.existsSync(this.archivePath)) {
      fs.mkdirSync(this.archivePath, { recursive: true });
    }
  }

  generateSessionId() {
    return `session_${crypto.randomUUID()}`;
  }

  generateUserId() {
    return `user_${crypto.randomUUID()}`;
  }

  normalizeName(name) {
    return ((name || '').toString().trim()) || '未命名';
  }

  getSessionName(session) {
    return this.normalizeName(session && session.characterConfig && session.characterConfig.name);
  }

  // 人设世代档案。老会话没有这个字段，getPersona 会懒初始化成 founding=true / version=1，
  // 不改变现有记忆键，也不会因为升级代码把旧档读丢
  createPersona(overrides = {}) {
    const src = overrides && typeof overrides === 'object' ? overrides : {};
    return {
      lineageId: typeof src.lineageId === 'string' && src.lineageId.trim()
        ? src.lineageId.trim()
        : `p_${crypto.randomUUID().slice(0, 8)}`,
      version: Number.isFinite(Number(src.version)) && Number(src.version) > 0
        ? Math.floor(Number(src.version))
        : 1,
      founding: src.founding !== false,
      cutoverAt: Number(src.cutoverAt) || 0,
      updatedAt: Number(src.updatedAt) || 0
    };
  }

  getPersona(sessionId) {
    const session = this.sessions[sessionId];
    if (!session) return null;
    if (!session.persona) {
      session.persona = this.createPersona({ founding: true });
      this.saveSession(sessionId);
    }
    return session.persona;
  }

  // 两个角色名算不算「同一个人」：完全相同，或一方包含另一方（「苏念安」→「苏念安（三年后）」）。
  // 只有名字完全对不上时才当成换了个不相干的角色
  isSamePersonaName(oldName, newName) {
    const a = this.normalizeName(oldName);
    const b = this.normalizeName(newName);
    return a === b || a.includes(b) || b.includes(a);
  }

  // 记忆 / 称呼 / 自我模型用的用户键：
  //  - founding 世代：沿用原始 userId，老数据零迁移
  //  - 换成不相干角色后：拼上 @lineageId，旧档原样封存，新角色从自己的新档开始
  getScopedUserId(sessionId, userId) {
    const base = (typeof userId === 'string' && userId.trim()) ? userId.trim() : 'default';
    const session = this.sessions[sessionId];
    if (!session) return base;
    const persona = this.getPersona(sessionId);
    if (!persona || persona.founding) return base;
    const suffix = `@${persona.lineageId}`;
    return base.endsWith(suffix) ? base : `${base}${suffix}`;
  }

  findByName(name) {
    const target = this.normalizeName(name);
    return this.getAllSessions().find(session => this.getSessionName(session) === target) || null;
  }

  // 同名角色只保留最新修改的版本，移除其余重复记录
  dedupeByName() {
    const groups = {};
    this.getAllSessions().forEach(session => {
      const name = this.getSessionName(session);
      if (!groups[name]) groups[name] = [];
      groups[name].push(session);
    });

    let removed = 0;
    Object.values(groups).forEach(list => {
      if (list.length <= 1) return;
      list.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      list.slice(1).forEach(duplicate => {
        if (this.deleteSession(duplicate.sessionId)) removed++;
      });
    });

    if (removed > 0) {
      console.log(`[SessionManager] 同名角色去重：保留最新版本，移除 ${removed} 条旧记录`);
    }
    return removed;
  }

  // sessionId 可显式指定，用于按 QQ 号这类外部标识建立稳定可寻址的会话
  createSession(characterConfig, sessionId = null) {
    const id = sessionId || this.generateSessionId();
    const session = {
      id,
      sessionId: id,
      characterConfig: {
        name: characterConfig.name || '未命名',
        age: characterConfig.age || '',
        personality: characterConfig.personality || '',
        background: characterConfig.background || '',
        backgroundEnabled: characterConfig.backgroundEnabled !== undefined ? characterConfig.backgroundEnabled !== false : true,
        backgroundWeight: this.normalizeBackgroundWeight(characterConfig.backgroundWeight),
        targetRelationship: characterConfig.targetRelationship || 'STRANGER'
      },
      creatorId: characterConfig.creatorId || this.generateUserId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      users: {},
      isActive: true,
      // 人设世代：lineageId 标识「同一个角色的连续人生」，version 是第几版人设。
      // founding=true 表示记忆仍落在原始 userId 档里；cutoverAt 是最近一次改人设的时间，
      // 早于它的旧记忆不删，只在召回时降权（见 memory.personaWeight）
      persona: this.createPersona()
    };

    // 角色级「思考模式」开关：只有显式传了才落盘，未设置时交给上层按全局默认决定
    if (characterConfig.thinkingEnabled !== undefined) {
      session.characterConfig.thinkingEnabled = characterConfig.thinkingEnabled === true;
    }

    session.users[session.creatorId] = {
      userId: session.creatorId,
      joinedAt: Date.now(),
      isCreator: true,
      relationshipScore: 0,
      conversationHistory: []
    };

    this.sessions[id] = session;
    this.saveSession(id);
    return session;
  }
  
  updateSession(sessionId, characterConfig) {
    const session = this.sessions[sessionId];
    if (!session) {
      return null;
    }

    // 改人设分两种：
    //  - 同一个角色的演化（名字没变，或名字互相包含）：旧记忆保留，升 version、记 cutoverAt，召回时降权
    //  - 换了个不相干的角色（名字完全对不上）：开新 lineage，记忆/称呼/自我模型走新档，旧档原样封存
    const persona = this.getPersona(sessionId);
    const prevName = session.characterConfig.name;
    const nameChanged = characterConfig.name !== undefined
      && String(characterConfig.name).trim() !== String(prevName || '').trim();
    const identityFields = ['name', 'age', 'personality', 'background'];
    const identityChanged = identityFields.some(field =>
      characterConfig[field] !== undefined
      && String(characterConfig[field] === null ? '' : characterConfig[field])
        !== String(session.characterConfig[field] === null ? '' : session.characterConfig[field] || '')
    );
    const unrelated = nameChanged && !this.isSamePersonaName(prevName, characterConfig.name);

    if (characterConfig.name !== undefined) {
      session.characterConfig.name = characterConfig.name;
    }
    if (characterConfig.age !== undefined) {
      session.characterConfig.age = characterConfig.age;
    }
    if (characterConfig.personality !== undefined) {
      session.characterConfig.personality = characterConfig.personality;
    }
    if (characterConfig.background !== undefined) {
      session.characterConfig.background = characterConfig.background;
    }
    if (characterConfig.backgroundEnabled !== undefined) {
      session.characterConfig.backgroundEnabled = characterConfig.backgroundEnabled !== false;
    }
    if (characterConfig.backgroundWeight !== undefined) {
      session.characterConfig.backgroundWeight = this.normalizeBackgroundWeight(characterConfig.backgroundWeight);
    }
    if (characterConfig.targetRelationship !== undefined) {
      session.characterConfig.targetRelationship = characterConfig.targetRelationship;
    }
    if (characterConfig.thinkingEnabled !== undefined) {
      session.characterConfig.thinkingEnabled = characterConfig.thinkingEnabled === true;
    }

    if (identityChanged) {
      const now = Date.now();
      if (unrelated) {
        // 换了个不相干的人：记忆、称呼、自我模型、归档各走各的新档；
        // 会话级好感度归零，记忆库里的关系分也会随新档自然从 0 开始
        session.persona = this.createPersona({ founding: false, cutoverAt: now, updatedAt: now });
        Object.values(session.users || {}).forEach(user => {
          if (user) user.relationshipScore = 0;
        });
        console.log(`[SessionManager] 角色换代：${prevName} → ${session.characterConfig.name}（新 lineage ${session.persona.lineageId}）`);
      } else {
        // 同一个角色的自然演化：只升版本、记切点，旧记忆不删也不挪档
        persona.version = (persona.version || 1) + 1;
        persona.cutoverAt = now;
        persona.updatedAt = now;
        console.log(`[SessionManager] 人设演化：${session.characterConfig.name} → v${persona.version}（旧记忆降权）`);
      }
    }

    session.updatedAt = Date.now();
    this.saveSession(sessionId);
    return session;
  }

  // 角色级思考模式开关的原始值：true/false 为显式设置，null 表示没设置过（由上层退回全局默认）
  getThinkingEnabled(sessionId) {
    const value = this.sessions[sessionId]?.characterConfig?.thinkingEnabled;
    return typeof value === 'boolean' ? value : null;
  }
  
  validateSession(sessionId) {
    return this.sessions[sessionId] ? { valid: true } : null;
  }

  createUserForSession(sessionId, loginUsername) {
    const session = this.sessions[sessionId];
    if (!session) {
      return null;
    }

    // 同一用户名多次调 join 直接返回已存在的 userId，不要不停生成新的
    if (loginUsername) {
      const existing = Object.values(session.users).find(u => u.loggedInUsername === loginUsername);
      if (existing) return { userId: existing.userId, sessionId, existing: true };
    }

    const userId = this.generateUserId();
    const entry = {
      userId,
      joinedAt: Date.now(),
      isCreator: false,
      relationshipScore: 0,
      conversationHistory: []
    };
    if (loginUsername) entry.loggedInUsername = loginUsername;
    session.users[userId] = entry;

    session.updatedAt = Date.now();
    this.saveSession(sessionId);
    return { userId, sessionId, existing: false };
  }

  // 按用户名确保 session 里有这个 user：有就返回，没有就创建
  // 同时兼容 creatorId 首次创建（session 刚建好时 creator 那个 user 也需要挂上 username）
  ensureSessionUser(sessionId, loginUsername) {
    const session = this.sessions[sessionId];
    if (!session || !loginUsername) return null;

    // creator 的 user 可能还没挂 username——补一下
    const creator = session.users[session.creatorId];
    if (creator && !creator.loggedInUsername && creator.isCreator) {
      creator.loggedInUsername = loginUsername;
      session.updatedAt = Date.now();
      this.saveSession(sessionId);
      return { userId: creator.userId, sessionId, existing: true, isCreator: true };
    }

    const existing = Object.values(session.users).find(u => u.loggedInUsername === loginUsername);
    if (existing) return { userId: existing.userId, sessionId, existing: true };

    return this.createUserForSession(sessionId, loginUsername);
  }

  getSession(sessionId) {
    return this.sessions[sessionId] || null;
  }

  getUser(sessionId, userId) {
    const session = this.sessions[sessionId];
    if (!session) return null;
    return session.users[userId] || null;
  }

  updateUserRelationship(sessionId, userId, score) {
    const user = this.getUser(sessionId, userId);
    if (user) {
      user.relationshipScore = Math.max(0, Math.min(100, score));
      this.saveSession(sessionId);
    }
  }

  // 自动判定本轮该走哪个记忆分区：'ai'（元层面交互）或 'role'（角色扮演，默认）
  // 状态按 userId 记（与记忆分档同一把键），跨会话一致
  resolvePersonaScope(userId, text) {
    const key = (typeof userId === 'string' && userId.trim()) ? userId.trim() : 'default';
    const raw = typeof text === 'string' ? text : '';
    const state = this.personaStates[key] || { scope: 'role', missStreak: 0 };

    const strong = PERSONA_META_NOUN.test(raw) && PERSONA_META_VERB.test(raw);
    const weak = PERSONA_META_NOUN.test(raw) || PERSONA_FOLLOWUP.test(raw.trim());

    if (strong) {
      state.scope = 'ai';
      state.missStreak = 0;
    } else if (state.scope === 'ai') {
      if (weak) {
        state.missStreak = 0;
      } else {
        state.missStreak += 1;
        if (state.missStreak >= PERSONA_AI_MISS_LIMIT) {
          state.scope = 'role';
          state.missStreak = 0;
        }
      }
    }

    this.personaStates[key] = state;
    console.log(`[Persona] ${key} → ${state.scope}（strong=${strong} weak=${weak} miss=${state.missStreak}）: ${raw.slice(0, 40)}`);
    return state.scope;
  }

  // 只读取当前分区状态、不推进状态机（归档蒸馏等旁路用它，避免污染判定节奏）
  getPersonaScope(userId) {
    const key = (typeof userId === 'string' && userId.trim()) ? userId.trim() : 'default';
    const state = this.personaStates[key];
    return state && state.scope === 'ai' ? 'ai' : 'role';
  }

  addConversationMessage(sessionId, userId, message) {
    const user = this.getUser(sessionId, userId);
    if (user) {
      const persona = this.getPersona(sessionId);
      user.conversationHistory.push({
        ...message,
        // 消息属于哪个人设世代：换到不相干角色后，只回看新世代的消息；
        // 老消息没有这个字段，按「开国世代」处理（founding 会话照常全读）
        personaLineageId: persona ? persona.lineageId : undefined,
        // 消息自带时间就用自带的（保持真实发生时刻），否则按写入时刻补
        timestamp: message.timestamp || Date.now()
      });

      // 涨到触发线才动一次手：整批剪掉最老的 100 条（沉底段），剪完仍剩满 300 条
      // 这样蒸馏频率从「每条一次」降到「每 100 条一次」，在场条数也永远不会低于硬下限
      if (user.conversationHistory.length >= CONVERSATION_ARCHIVE_TRIGGER) {
        const overflow = user.conversationHistory.slice(0, user.conversationHistory.length - RESIDENT_CONVERSATION_MESSAGES);
        user.conversationHistory = user.conversationHistory.slice(-RESIDENT_CONVERSATION_MESSAGES);
        this.archiveMessages(sessionId, userId, overflow);
      }

      this.saveSession(sessionId);
    }
  }

  // 一条消息在短期记忆里的段位：由整段窗口的下标实时算，不落盘
  // 窗口一滑动，同一条消息的段位就会变（今天是「在场」，明天是「余温」），写进文件就会自相矛盾
  // 不足三段（300 条）时统一算「在场」——那会儿还没有哪一段要滑出去
  getConversationTier(index, total) {
    if (total <= CONVERSATION_TIER_SIZE * 3) return TIER_PRESENT;
    const fromEnd = total - index;
    if (fromEnd <= CONVERSATION_TIER_SIZE) return TIER_PRESENT;
    if (fromEnd <= CONVERSATION_TIER_SIZE * 2) return TIER_WARM;
    return TIER_SUNK;
  }

  getConversationHistory(sessionId, userId, limit = 20) {
    const user = this.getUser(sessionId, userId);
    if (!user) return [];

    const persona = this.getPersona(sessionId);
    // 换成不相干角色之后只回看新世代的消息；founding 会话（以及升级前的旧消息）照常全读
    const all = (persona && persona.founding === false)
      ? user.conversationHistory.filter(msg => msg && msg.personaLineageId === persona.lineageId)
      : user.conversationHistory;
    const start = Math.max(0, all.length - limit);
    const history = all.slice(start);

    return history.map((msg, offset) => {
      const role = msg.role && (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system') 
        ? msg.role 
        : 'user';
      
      const content = typeof msg.content === 'string' ? msg.content.trim() : '';
      
      return {
        role,
        content,
        timestamp: msg.timestamp || Date.now(),
        // 是否是角色自己主动开口（自主发言）；普通一问一答为 false
        proactive: msg.proactive === true,
        // 段位按整段窗口算，不受本次 limit 影响
        tier: this.getConversationTier(start + offset, all.length)
      };
    }).filter(msg => msg.content.length > 0);
  }

  // 归档后续处理的回调（上层用来把旧对话蒸馏成摘要写进长期记忆），失败不影响归档本身
  setArchiveHandler(handler) {
    this.archiveHandler = typeof handler === 'function' ? handler : null;
  }

  getArchiveFilePath(sessionId, userId) {
    const safeSession = String(sessionId || 'unknown').replace(/[^\w.-]/g, '_');
    const safeUser = String(userId || 'default').replace(/[^\w.-]/g, '_');
    return path.join(this.archivePath, `${safeSession}__${safeUser}.json`);
  }

  // 归档条目编号：类型前缀 + 按时间递增的序号，模型可以直接报「食物-0003」定位某条
  buildArchiveId(type, seq) {
    return `${type}-${String(seq).padStart(ARCHIVE_SEQ_PAD, '0')}`;
  }

  // 读取归档并补齐编号：老条目没有编号时按位置补，保证编号稳定、可被引用
  normalizeArchiveEntries(entries) {
    return (Array.isArray(entries) ? entries : [])
      .filter(entry => entry && typeof entry.content === 'string' && entry.content.trim().length > 0)
      .map((entry, index) => {
        const type = typeof entry.type === 'string' && entry.type.trim() ? entry.type.trim() : DEFAULT_ARCHIVE_TYPE;
        const seq = Number.isFinite(entry.seq) && entry.seq > 0 ? entry.seq : index + 1;
        return {
          ...entry,
          type,
          seq,
          id: typeof entry.id === 'string' && entry.id ? entry.id : this.buildArchiveId(type, seq),
          content: entry.content.trim()
        };
      });
  }

  readArchive(sessionId, userId) {
    try {
      const filePath = this.getArchiveFilePath(sessionId, userId);
      if (!fs.existsSync(filePath)) return [];
      return this.normalizeArchiveEntries(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch (error) {
      console.error('[SessionManager] 读取归档失败:', error.message);
      return [];
    }
  }

  saveArchive(sessionId, userId, entries) {
    try {
      writeJsonAtomicSync(this.getArchiveFilePath(sessionId, userId), entries);
      return true;
    } catch (error) {
      console.error('[SessionManager] 写入归档失败:', error.message);
      return false;
    }
  }

  getNextArchiveSeq(entries) {
    return entries.reduce((max, entry) => Math.max(max, entry.seq || 0), 0) + 1;
  }

  // 把滑出在场窗口的「沉底段」按原文追加进独立归档文件，不占用那 300 条的额度
  // 这批条目统一挂默认类型前缀，模型之后可以再自己按类型补充条目
  archiveMessages(sessionId, userId, messages) {
    const kept = (Array.isArray(messages) ? messages : []).filter(
      msg => msg && typeof msg.content === 'string' && msg.content.trim().length > 0
    );
    if (kept.length === 0) return [];

    // 归档跟着人设世代走：换过不相干角色后，新角色的沉底段不与旧角色的归档混在一起
    const scopedUserId = this.getScopedUserId(sessionId, userId);
    const entries = this.readArchive(sessionId, scopedUserId);
    let seq = this.getNextArchiveSeq(entries) - 1;
    kept.forEach(msg => {
      seq += 1;
      entries.push({
        id: this.buildArchiveId(DEFAULT_ARCHIVE_TYPE, seq),
        type: DEFAULT_ARCHIVE_TYPE,
        seq,
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content.trim(),
        timestamp: msg.timestamp || Date.now(),
        // 归档时保留自主发言标记，否则沉底后就分不出哪些是她自己主动说的了
        proactive: msg.proactive === true,
        source: 'auto'
      });
    });

    if (!this.saveArchive(sessionId, scopedUserId, entries)) {
      return [];
    }
    console.log(`[SessionManager] 归档 ${kept.length} 条旧对话（${TIER_SUNK}段，${sessionId}/${scopedUserId}），累计 ${entries.length} 条`);

    if (this.archiveHandler) {
      Promise.resolve()
        // 蒸馏产物也写进 scoped 档，保证换角色后旧记忆不回流
        .then(() => this.archiveHandler({ sessionId, userId: scopedUserId, messages: kept }))
        .catch(error => console.error('[SessionManager] 归档后续处理失败:', error.message));
    }

    return kept;
  }

  // 模型自己写的归档条目：类型由它定，序号仍按时间全局递增（食物-0001、吉他-0002…）
  writeArchiveEntry(sessionId, userId, { type, content, role } = {}) {
    const text = typeof content === 'string' ? content.trim() : '';
    if (text.length === 0 || !sessionId || !userId) return null;

    const typeLabel = typeof type === 'string' && type.trim()
      ? type.trim().slice(0, 12)
      : DEFAULT_ARCHIVE_TYPE;

    const scopedUserId = this.getScopedUserId(sessionId, userId);
    const entries = this.readArchive(sessionId, scopedUserId);
    const seq = this.getNextArchiveSeq(entries);
    const entry = {
      id: this.buildArchiveId(typeLabel, seq),
      type: typeLabel,
      seq,
      role: role === 'user' ? 'user' : 'assistant',
      content: text,
      timestamp: Date.now(),
      source: 'model'
    };
    entries.push(entry);

    if (!this.saveArchive(sessionId, scopedUserId, entries)) {
      return null;
    }
    console.log(`[SessionManager] 模型写入归档条目 ${entry.id}（${sessionId}/${scopedUserId}）`);
    return entry;
  }

  // 供模型主动「查历史」：在场记录与归档原文放在一起检索，按关键词重合度取最相关的若干条
  // 没有关键词（或都没命中）时退回最近的记录，scope 可限定只看在场 / 只看归档
  // 也可以直接按编号（食物-0003）或类型（食物）精确取归档条目
  searchHistory(sessionId, userId, options = {}) {
    const scope = ['recent', 'archive', 'all'].includes(options.scope) ? options.scope : 'all';
    const parsedLimit = parseInt(options.limit, 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(50, Math.max(1, parsedLimit)) : 20;
    const keyword = typeof options.keyword === 'string' ? options.keyword.trim() : '';
    const targetId = typeof options.id === 'string' ? options.id.trim() : '';
    const typeFilter = typeof options.type === 'string' ? options.type.trim() : '';
    // 只看自主发言（true）/ 只看被用户触发的回复（false）；不传则都返回
    const proactiveFilter = typeof options.proactive === 'boolean' ? options.proactive : null;

    let tagged = [];
    if (scope !== 'archive') {
      // 在场记录整段带回（含段位标签），再多也由下面的 limit 收敛
      this.getConversationHistory(sessionId, userId, Number.MAX_SAFE_INTEGER)
        .forEach(msg => tagged.push({ ...msg, archived: false }));
    }
    if (scope !== 'recent') {
      // 归档按人设世代隔离；在场记录由 getConversationHistory 自己按 lineage 过滤
      this.readArchive(sessionId, this.getScopedUserId(sessionId, userId)).forEach(entry => {
        tagged.push({
          id: entry.id,
          type: entry.type,
          role: entry.role === 'assistant' ? 'assistant' : 'user',
          content: entry.content,
          timestamp: entry.timestamp || 0,
          proactive: entry.proactive === true,
          archived: true
        });
      });
    }

    // 自主发言过滤：在编号/类型/关键词之前先筛，保证语义一致
    if (proactiveFilter !== null) {
      tagged = tagged.filter(msg => (msg.proactive === true) === proactiveFilter);
    }

    // 编号优先，其次类型，最后才是原来的关键词规则
    if (targetId) {
      tagged = tagged.filter(msg => msg.id === targetId);
    } else if (typeFilter) {
      tagged = tagged.filter(msg => msg.archived && msg.type === typeFilter);
    }

    let picked;
    if (keyword && !targetId) {
      const grams = this.toBigrams(keyword);
      const scored = tagged.map(msg => ({ msg, score: this.scoreByKeyword(msg.content, grams) }));
      const hit = scored.filter(item => item.score > 0);
      if (hit.length > 0) {
        picked = hit
          .sort((a, b) => b.score - a.score || (b.msg.timestamp || 0) - (a.msg.timestamp || 0))
          .slice(0, limit)
          .map(item => item.msg);
      }
    }
    if (!picked) {
      // 没有关键词时退回「最近的记录」：必须先按时间排序再取尾部。
      // 归档条目是追加在在场记录之后的，直接 slice(-limit) 永远命中归档末尾
      // 那几条最新写入的东西（如「人物」设定卡），而不是真正刚聊过的内容。
      picked = tagged
        .slice()
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        .slice(-limit);
    }

    picked.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    return {
      scope,
      keyword,
      id: targetId,
      type: typeFilter,
      proactive: proactiveFilter,
      // 归档里已有的类型前缀，方便按类型继续翻
      types: [...new Set(this.readArchive(sessionId, userId).map(entry => entry.type))],
      total: tagged.length,
      returned: picked.length,
      messages: picked.map(msg => ({
        id: msg.id || '',
        type: msg.type || '',
        role: msg.role,
        content: msg.content,
        archived: msg.archived,
        // 是否是角色自己主动开口（自主发言）
        proactive: msg.proactive === true,
        // 在场条目的段位（在场/余温/沉底），归档条目为空
        tier: msg.tier || '',
        time: msg.timestamp ? new Date(msg.timestamp).toLocaleString('zh-CN') : ''
      }))
    };
  }

  // 把文本切成相邻两字的片段集合，用于粗粒度的重合度打分
  toBigrams(text) {
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

  scoreByKeyword(text, grams) {
    if (!grams || grams.size === 0) return 0;
    const source = String(text || '');
    let score = 0;
    for (const gram of grams) {
      if (source.includes(gram)) score++;
    }
    return score;
  }

  buildCharacterPrompt(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) {
      return '';
    }

    const { characterConfig } = session;
    const backgroundWeight = this.getBackgroundWeight(characterConfig);
    let prompt = '';

    if (characterConfig.name) {
      prompt += `你是${characterConfig.name}，一个具有真实情感的角色。\n`;
    }

    if (characterConfig.age) {
      prompt += `年龄：${characterConfig.age}岁。\n`;
    }

    if (characterConfig.personality) {
      prompt += `性格特点：${characterConfig.personality}。\n`;
    }

    if (characterConfig.background && backgroundWeight > 0) {
      prompt += `背景故事：${characterConfig.background}。\n`;
      if (backgroundWeight < 1) {
        prompt += `（以上背景的权重为 ${backgroundWeight}，仅作氛围参考：请优先回应用户当前说的话，不要反复援引背景设定。）\n`;
      }
    }

    prompt += `
请按照以下要求进行对话：
1. 完全沉浸在角色中，使用${characterConfig.name}的语气说话
2. 根据用户的互动动态调整你的态度和情感
3. 保持回应自然、简短（1-3句话）
4. 根据对话进展改变你对用户的好感度和态度
5. 不要暴露你是AI的身份
6. 根据当前关系阶段调整你的互动方式

关系阶段：
- 陌生人：保持礼貌但有距离
- 熟人：更加放松，可以聊更多话题
- 朋友：亲近，可以分享心事
- 好友：非常亲密，可以撒娇或开玩笑
- 恋人：浪漫、温柔、亲昵
`;

    return prompt;
  }

  // 初始记忆（背景故事）权重：0~1，0 表示不注入；未显式配置时取全局默认
  normalizeBackgroundWeight(value) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return undefined;
    }
    return Math.min(1, Math.max(0, num));
  }

  getBackgroundWeight(characterConfig) {
    const cfg = characterConfig || {};

    const enabled = cfg.backgroundEnabled !== undefined
      ? cfg.backgroundEnabled !== false
      : process.env.ROLE_BACKGROUND_ENABLED !== 'false';
    if (!enabled) return 0;

    const raw = cfg.backgroundWeight !== undefined && cfg.backgroundWeight !== null && cfg.backgroundWeight !== ''
      ? cfg.backgroundWeight
      : process.env.ROLE_BACKGROUND_WEIGHT;
    const num = Number(raw);
    if (raw === undefined || raw === '' || !Number.isFinite(num)) {
      return 1;
    }
    return Math.min(1, Math.max(0, num));
  }

  saveSession(sessionId) {
    const session = this.sessions[sessionId];
    if (session) {
      const filePath = path.join(this.storagePath, `${sessionId}.json`);
      writeJsonAtomicSync(filePath, session);
    }
  }

  loadAllSessions() {
    try {
      const files = fs.readdirSync(this.storagePath);
      files.forEach(file => {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.storagePath, file);
          try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            this.sessions[data.sessionId] = data;
          } catch (error) {
            console.error(`加载会话文件失败 ${file}:`, error);
          }
        }
      });
      console.log(`已加载 ${Object.keys(this.sessions).length} 个会话`);
    } catch (error) {
      console.error('扫描会话目录失败:', error);
    }
  }

  getAllSessions() {
    return Object.values(this.sessions);
  }

  deleteSession(sessionId) {
    if (this.sessions[sessionId]) {
      delete this.sessions[sessionId];
      const filePath = path.join(this.storagePath, `${sessionId}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      return true;
    }
    return false;
  }
}

module.exports = SessionManager;
