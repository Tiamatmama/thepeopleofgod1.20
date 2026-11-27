'use strict';

// 📓 日记本：让角色自己写字，而不是系统替她算一份心境。
//
// 与 privateLife 的分工：私生活是「她今天做了什么」（由系统替她过日子），
// 日记是「她自己怎么想」（由她本人动笔）。这里不计算评价、不推导情绪，
// 只在她和用户约定的时间，把主记忆链路里真实发生过的事交给她，让她写下来。
//
// 三条硬规则：
//   1) 到点才写：时间由 schedule_diary 工具与用户约定，默认 20:00，不随时开；
//   2) 只写真实发生过的：素材来自主记忆检索 + 当天对话，不编造；
//   3) 写完回流：每人本以【日记】写进该用户的主记忆，往后检索得到；全局本只落文件，
//      不写进任何单个用户的记忆（避免串档）。
//
// 落盘：data/diary/<owner>/<YYYY-MM-DD>.md、data/diary/_global/<YYYY-MM-DD>.md；
// 约定在 config.json，当天写过谁记在 state.json。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { UnifiedAPI } = require('./api');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'diary');

const DEFAULT_CONFIG = Object.freeze({ hour: 20, minute: 0, enabled: true });
const GLOBAL_OWNER = '_global';
const MEMORY_MATERIAL = 20;          // 每人本取最近多少条记忆当素材
const MAX_HISTORY = 12;              // 当天对话最多回看几条
const MAX_TEXT_CHARS = 800;          // 一篇日记的正文上限
const MIN_TEXT_CHARS = 20;           // 太短视为没写出来
const MAX_PER_TICK = 2;              // 单轮最多写几个人的本子，防止一次打满额度
const FAIL_RETRY_MS = 60 * 60 * 1000; // 失败后一小时再试

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 目录名要能直接认人，又不能让 userId 里的路径字符写出 data/diary 之外：
// 先去掉 Windows 非法字符与控制符，再截断；含中文/括号的名字保留原样，末尾补短哈希防重名
function safeOwnerDir(ownerId) {
  const raw = String(ownerId || '');
  if (/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return raw;
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 6);
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .trim()
    .slice(0, 40);
  return cleaned ? `${cleaned}_${hash}` : `u_${hash}`;
}

// "HH:mm" → { hour, minute }；格式不对返回 null
function parseClock(raw) {
  const match = String(raw || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

class DiaryModule {
  constructor({ unifiedAPI = null, memory = null, dataDir = null } = {}) {
    this.unifiedAPI = unifiedAPI || new UnifiedAPI();
    // 主记忆链路：素材从这里取，写好的日记也从这里回流
    this.memory = memory;
    this.dataDir = dataDir || DATA_DIR;
    this.failedUntil = new Map();
    this.config = this.loadConfig();
    this.state = this.loadState();
  }

  // ==================== 约定时间 ====================

  loadConfig() {
    try {
      const file = path.join(this.dataDir, 'config.json');
      if (fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
        const hour = Number(saved.hour);
        const minute = Number(saved.minute);
        return {
          hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_CONFIG.hour,
          minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : DEFAULT_CONFIG.minute,
          enabled: saved.enabled !== false
        };
      }
    } catch (error) {
      console.warn('[日记] 读取约定失败，按默认 20:00 处理:', error.message);
    }
    return { ...DEFAULT_CONFIG };
  }

  saveConfig() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      writeJsonAtomicSync(path.join(this.dataDir, 'config.json'), this.config);
      return true;
    } catch (error) {
      console.warn('[日记] 保存约定失败:', error.message);
      return false;
    }
  }

  getConfig() {
    return { ...this.config };
  }

  // 与用户约定写日记的时间。只接受 HH:mm，改完下一个调度刻度就生效
  setSchedule({ time, enabled } = {}) {
    if (time !== undefined) {
      const clock = parseClock(time);
      if (!clock) return { success: false, error: '时间格式应为 HH:mm（24 小时制），例如 20:00' };
      this.config.hour = clock.hour;
      this.config.minute = clock.minute;
    }
    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') return { success: false, error: 'enabled 只能是 true 或 false' };
      this.config.enabled = enabled;
    }
    if (!this.saveConfig()) return { success: false, error: '约定没能落盘，请稍后再试' };
    return {
      success: true,
      hour: this.config.hour,
      minute: this.config.minute,
      enabled: this.config.enabled,
      message: this.config.enabled
        ? `日记时间已约定为每天 ${pad(this.config.hour)}:${pad(this.config.minute)}，到点她自己写。`
        : '日记已关闭，她不会再自己写。'
    };
  }

  // ==================== 当天状态 ====================

  loadState() {
    try {
      const file = path.join(this.dataDir, 'state.json');
      if (fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
        const lastWritten = saved.lastWritten && typeof saved.lastWritten === 'object' ? saved.lastWritten : {};
        return { lastWritten };
      }
    } catch (error) {
      console.warn('[日记] 读取状态失败，按空白处理:', error.message);
    }
    return { lastWritten: {} };
  }

  saveState() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      writeJsonAtomicSync(path.join(this.dataDir, 'state.json'), this.state);
    } catch (error) {
      console.warn('[日记] 保存状态失败:', error.message);
    }
  }

  filePath(ownerId, day) {
    return path.join(this.dataDir, safeOwnerDir(ownerId), `${day}.md`);
  }

  // 到点了吗：默认 20:00 之后；时间由 config 决定
  isDue(now = Date.now()) {
    if (!this.config.enabled) return false;
    const date = new Date(now);
    const nowMinutes = date.getHours() * 60 + date.getMinutes();
    return nowMinutes >= this.config.hour * 60 + this.config.minute;
  }

  // 今天这一本还没写、没在失败退避里；activityAt 有值时必须是今天（当天没活动就不写）
  shouldWrite(ownerId, now = Date.now(), activityAt = null) {
    if (!this.isDue(now)) return false;
    const owner = String(ownerId || '');
    if (!owner) return false;
    const day = dayKey(new Date(now));
    if (this.state.lastWritten[owner] === day) return false;
    if ((this.failedUntil.get(owner) || 0) > now) return false;
    if (activityAt !== null && dayKey(new Date(Number(activityAt) || 0)) !== day) return false;
    return true;
  }

  // ==================== 写一篇（每人本）====================

  async writeFor({
    ownerId,
    userName = '',
    sessionId = '',
    characterPrompt = '',
    history = [],
    now = Date.now()
  } = {}) {
    const owner = String(ownerId || '').trim();
    if (!owner) return false;
    if ((this.failedUntil.get(owner) || 0) > now) return false;

    const date = new Date(now);
    const day = dayKey(date);

    const records = await this.recallMaterial(owner);
    const talk = this.formatTodayTalk(history, day);
    if (records.length === 0 && !talk) return false;

    const name = String(userName || '').trim() || '他';
    const prompt = this.buildPrompt({ characterPrompt, name, records, talk, date });
    const text = await this.askModel(prompt, owner, now);
    if (!text) return false;

    if (!this.writeFile(owner, day, name, text, now)) return false;

    // 回流主记忆：以【开头 → 按系统生成内容处理（不计好感度），但仍入库、参与检索
    if (this.memory && typeof this.memory.storeMemory === 'function') {
      try {
        this.memory.storeMemory({ value: 0, scene: `日记·${name}`, emotion: null }, owner, `【日记】${text}`);
      } catch (error) {
        console.warn(`[日记] ${owner} 回流记忆失败（日记已落盘）:`, error.message);
      }
    }

    this.state.lastWritten[owner] = day;
    this.saveState();
    this.failedUntil.delete(owner);
    console.log(`[日记] ${owner} 写下了 ${day} 的日记（${text.length} 字）`);
    return true;
  }

  // 素材：主记忆最近 N 条（真实发生过的），按时间旧→新
  async recallMaterial(owner) {
    if (!this.memory || typeof this.memory.retrieveMemoryRecords !== 'function') return [];
    try {
      const records = await this.memory.retrieveMemoryRecords(owner, '', MEMORY_MATERIAL);
      return (Array.isArray(records) ? records : [])
        .filter((r) => r && typeof r.data === 'string' && r.data.trim() && !/^【早期对话摘要/.test(r.data))
        .sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
    } catch (error) {
      console.warn(`[日记] ${owner} 取记忆素材失败，改只用当天对话:`, error.message);
      return [];
    }
  }

  // 只保留今天的对话；没有时间戳的按最近几条处理
  formatTodayTalk(history, day) {
    const list = (Array.isArray(history) ? history : [])
      .filter((m) => m && typeof m.content === 'string' && m.content.trim())
      .filter((m) => !m.timestamp || dayKey(new Date(Number(m.timestamp) || 0)) === day)
      .slice(-MAX_HISTORY);
    return list
      .map((m) => `- ${m.role === 'assistant' ? '你' : '他'}：${m.content.replace(/\s+/g, ' ').slice(0, 100)}`)
      .join('\n');
  }

  buildPrompt({ characterPrompt, name, records, talk, date }) {
    const weekday = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
    const clock = `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 星期${weekday} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const persona = String(characterPrompt || '').slice(0, 1200);
    const memories = records.length
      ? records.map((r) => `- ${String(r.data).replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')
      : '（今天没有可回看的记忆）';

    return `${persona}

【真实时间】${clock}（Asia/Shanghai）
【今天是】${dayKey(date)}

这些是你和${name}之间真实发生过的记忆（旧→新），只能以这里和下面的对话为准：
${memories}

今天你们的对话（按时间顺序，可能为空）：
${talk || '（今天没有聊过）'}

现在是你自己坐下来写日记的时间。这本日记只给未来的你看，${name}看不到。

要求：
1. 第一人称，像一个人真的在纸上写字，不要分点、不要小标题、不要总结陈词。
2. 只写真实发生过的事。这里没有出现过的事、他没说过的话，一个字都不要编。
3. 可以写你对${name}这个人的看法：他哪里让你舒服、哪里让你别扭、你怎么看他今天的样子。态度要具体，不要空泛夸奖。
4. 也可以写你自己的心理状态：今天你心里在想什么、在担心什么、有没有什么没说出来。
5. 200~600 字。直接输出日记正文，不要 JSON、不要 markdown、不要引号包裹。`;
  }

  // 调模型并把返回收拾成纯正文；失败返回空串并进入退避
  async askModel(prompt, owner, now) {
    let raw;
    try {
      const result = await this.unifiedAPI.callAPI([{ role: 'user', content: prompt }], null, { callSite: 'diary' });
      raw = result?.choices?.[0]?.message?.content || '';
    } catch (error) {
      this.failedUntil.set(owner, now + FAIL_RETRY_MS);
      console.warn(`[日记] ${owner} 生成失败（不影响回复）:`, error.message);
      return '';
    }

    const text = String(raw)
      .replace(/^```[a-zA-Z]*\s*/m, '')
      .replace(/```$/m, '')
      .replace(/^\s*[#>*\-\s]+/gm, '')
      .trim()
      .slice(0, MAX_TEXT_CHARS);

    if (text.length < MIN_TEXT_CHARS) {
      this.failedUntil.set(owner, now + FAIL_RETRY_MS);
      console.warn(`[日记] ${owner} 返回内容过短，本轮跳过`);
      return '';
    }
    return text;
  }

  writeFile(ownerId, day, name, text, now) {
    try {
      const file = this.filePath(ownerId, day);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const header = `# ${day} · 关于${name}\n\n_写于 ${pad(new Date(now).getHours())}:${pad(new Date(now).getMinutes())}_\n\n`;
      fs.writeFileSync(file, `${header}${text}\n`, 'utf8');
      return true;
    } catch (error) {
      this.failedUntil.set(ownerId, now + FAIL_RETRY_MS);
      console.warn(`[日记] ${ownerId} 落盘失败:`, error.message);
      return false;
    }
  }

  // ==================== 写一篇（全局本）====================

  // 今天各人本里已经写下的内容，作为全局本的材料（不跨用户读记忆）
  listDayEntries(day) {
    const entries = [];
    let dirs;
    try {
      dirs = fs.readdirSync(this.dataDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== GLOBAL_OWNER)
        .map((d) => d.name);
    } catch {
      return entries;
    }
    for (const dir of dirs) {
      const file = path.join(this.dataDir, dir, `${day}.md`);
      try {
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, 'utf8');
        const title = (raw.split('\n')[0] || '').replace(/^#\s*/, '');
        const body = raw.replace(/^#[^\n]*\n+/, '').replace(/^_[^\n]*_\n+/, '').trim();
        if (body) entries.push({ title, text: body });
      } catch {
        // 单个文件坏掉不影响全局本
      }
    }
    return entries;
  }

  async writeGlobal({ characterPrompt = '', now = Date.now() } = {}) {
    const date = new Date(now);
    const day = dayKey(date);
    const entries = this.listDayEntries(day);
    if (entries.length === 0) return false;

    const persona = String(characterPrompt || '').slice(0, 1200);
    const material = entries
      .map((e) => `【${e.title}】\n${e.text.slice(0, 500)}`)
      .join('\n\n');

    const prompt = `${persona}

【真实时间】${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 ${pad(date.getHours())}:${pad(date.getMinutes())}（Asia/Shanghai）

今天你分别在自己的本子上写过这些（都是你真实经历的）：
${material}

现在写你那一本「总的日记」：这本不针对某一个人，写的是你自己这一天。

要求：
1. 第一人称，200~500 字，直接输出正文，不要 JSON、不要 markdown。
2. 写你今天整体的状态：见了谁、哪些话留在了心里、你自己在变成什么样的人。
3. 不要逐条复述上面的本子，也不要编造没发生过的事；写你读自己那些字时的真实感受。
4. 可以写迷茫、疲惫、在意，也可以写说不清的东西，但不要写成总结报告。`;

    const text = await this.askModel(prompt, GLOBAL_OWNER, now);
    if (!text) return false;

    try {
      const file = this.filePath(GLOBAL_OWNER, day);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `# ${day} · 她自己的日记\n\n${text}\n`, 'utf8');
    } catch (error) {
      this.failedUntil.set(GLOBAL_OWNER, now + FAIL_RETRY_MS);
      console.warn('[日记] 全局本落盘失败:', error.message);
      return false;
    }

    this.state.lastWritten[GLOBAL_OWNER] = day;
    this.saveState();
    this.failedUntil.delete(GLOBAL_OWNER);
    console.log(`[日记] 全局本写下了 ${day}（${text.length} 字）`);
    return true;
  }

  // ==================== 调度 ====================

  // 遍历活跃会话：当天有活动、还没写过的，替她开本子；最后写全局本
  async tick({ sessionManager, now = Date.now() } = {}) {
    if (!this.isDue(now)) return { written: 0, global: false };
    if (!sessionManager || typeof sessionManager.getAllSessions !== 'function') {
      return { written: 0, global: false };
    }

    const day = dayKey(new Date(now));
    let written = 0;
    let latestActivity = 0;
    let characterPrompt = '';

    for (const session of sessionManager.getAllSessions()) {
      if (written >= MAX_PER_TICK) break;
      const sessionId = session && session.sessionId;
      if (!sessionId) continue;

      const users = session.users && typeof session.users === 'object' ? session.users : {};
      const ownerId = session.creatorId || Object.keys(users)[0];
      if (!ownerId) continue;

      let history;
      try {
        history = sessionManager.getConversationHistory(sessionId, ownerId, MAX_HISTORY * 2) || [];
      } catch {
        history = [];
      }
      const lastTs = Number(history.length ? history[history.length - 1].timestamp : 0)
        || Number(session.updatedAt)
        || 0;
      if (lastTs) latestActivity = Math.max(latestActivity, lastTs);

      if (!this.shouldWrite(ownerId, now, lastTs || null)) continue;
      if (!characterPrompt) {
        try {
          characterPrompt = sessionManager.buildCharacterPrompt(sessionId) || '';
        } catch {
          characterPrompt = '';
        }
      }

      const info = users[ownerId];
      const userName = (info && (info.name || info.nickname)) || session.userName || '';
      const ok = await this.writeFor({ ownerId, userName, sessionId, characterPrompt, history, now });
      if (ok) written += 1;
    }

    // 全局本：今天有人写过、或今天确实有活动，且还没写过
    const hasTodayEntries = this.listDayEntries(day).length > 0;
    const activityAt = hasTodayEntries ? now : (latestActivity || null);
    let global = false;
    if (this.shouldWrite(GLOBAL_OWNER, now, activityAt)) {
      global = await this.writeGlobal({ characterPrompt, now });
    }

    return { written, global };
  }
}

module.exports = DiaryModule;
module.exports.parseClock = parseClock;
module.exports.safeOwnerDir = safeOwnerDir;
