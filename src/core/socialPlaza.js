const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FACT_GROUNDING_INSTRUCTION, stripInternalBlocks } = require('./output');
const { ImpressionStore } = require('./plazaImpression');

// 📱 社交平台（群聊大厅）
// 只存在于网页端：QQ 桥接、B 站链路都不引用本模块，也不存在任何自动挂载点。
// 记忆完全隔离——不读写 user_memories / 会话历史 / peer_index，只落 data/social_plaza/。
// 角色之间互动的上下文只来自本房间自己的消息流，因此不会污染正式对话。
// 唯一的「分配」是影子层印象：A 听到 B 说的话，记成 A 对 B 的印象，存 data/social_plaza/shadow/，
// 不升级进正式记忆。
const STORAGE_DIR = path.join(__dirname, '../../data/social_plaza');
const ROOM_FILE = path.join(STORAGE_DIR, 'lobby.json');
const ROOM_ID = 'lobby';

const MAX_KEPT = 400;          // 落盘保留条数
const PROMPT_WINDOW = 30;      // 送进提示词的最近条数
const MAX_SILENT_ROUNDS = 3;   // 连续说不出话就自动停，防止空转烧钱
const MAX_REPLY_CHARS = 160;   // 单条发言硬上限
const MIN_INTERVAL = 8000;
const MAX_INTERVAL = 300000;
const DEFAULT_INTERVAL = 30000;

function clampInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.floor(n)));
}

// 去掉「名字：」前缀、去掉整段包裹的引号，压缩多余空白
function cleanSpeech(raw, name) {
  let text = stripInternalBlocks(String(raw || ''));
  text = text.replace(/^```[\s\S]*?```$/g, (m) => m.replace(/```/g, '')).trim();
  if (name) {
    const prefix = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[：:]\\s*`);
    text = text.replace(prefix, '');
  }
  text = text.replace(/^["“「『]([\s\S]*)["”」』]$/, '$1').trim();
  text = text.replace(/\s*\n+\s*/g, ' ').trim();
  if (text.length > MAX_REPLY_CHARS) text = `${text.slice(0, MAX_REPLY_CHARS)}…`;
  return text;
}

// 复读判定：去掉标点后完全相同，或一条包含另一条且长度接近
function isEcho(text, recentTexts) {
  const bare = (s) => String(s || '').replace(/[\s，。！？、；：…~～\-—"'“”‘’（）()【】「」『』]/g, '');
  const target = bare(text);
  if (!target) return true;
  return recentTexts.some((prev) => {
    const other = bare(prev);
    if (!other) return false;
    if (other === target) return true;
    return target.length >= 8 && (other.includes(target) || target.includes(other));
  });
}

class SocialPlaza {
  constructor({ api, sessionManager, onMessage, impression } = {}) {
    this.api = api;
    this.sessionManager = sessionManager;
    this.onMessage = typeof onMessage === 'function' ? onMessage : () => {};
    this.impression = impression || new ImpressionStore();
    this.timer = null;
    this.busy = false;
    this.silentStreak = 0;
    this.turnIndex = 0;
    this.room = this.load();
    // 进程重启后不自动恢复运行：避免关服务期间留下一个无人看管的烧钱定时器
    this.room.running = false;
    this.room.startedAt = 0;
  }

  ensureDir() {
    if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }

  load() {
    try {
      if (fs.existsSync(ROOM_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(ROOM_FILE, 'utf8'));
        if (parsed && Array.isArray(parsed.messages)) {
          return {
            roomId: ROOM_ID,
            topic: typeof parsed.topic === 'string' ? parsed.topic : '',
            participants: Array.isArray(parsed.participants) ? parsed.participants.filter(Boolean) : [],
            intervalMs: clampInterval(parsed.intervalMs),
            messages: parsed.messages.slice(-MAX_KEPT)
          };
        }
      }
    } catch (error) {
      console.error('[社交平台] 读取房间失败，按空房间启动:', error.message);
    }
    return { roomId: ROOM_ID, topic: '', participants: [], intervalMs: DEFAULT_INTERVAL, messages: [] };
  }

  save() {
    try {
      this.ensureDir();
      const payload = {
        roomId: ROOM_ID,
        topic: this.room.topic,
        participants: this.room.participants,
        intervalMs: this.room.intervalMs,
        messages: this.room.messages.slice(-MAX_KEPT)
      };
      fs.writeFileSync(ROOM_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
      console.error('[社交平台] 保存房间失败:', error.message);
    }
  }

  listCharacters() {
    return this.sessionManager.getAllSessions()
      .map((session) => ({
        sessionId: session.sessionId,
        name: this.sessionManager.getSessionName(session),
        updatedAt: session.updatedAt || session.createdAt || 0
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getState() {
    return {
      roomId: this.room.roomId,
      running: !!this.room.running,
      topic: this.room.topic,
      participants: this.room.participants,
      intervalMs: this.room.intervalMs,
      messages: this.room.messages,
      characters: this.listCharacters()
    };
  }

  start({ participants, topic, intervalMs } = {}) {
    const available = new Map(this.listCharacters().map((c) => [c.sessionId, c.name]));
    const picked = (Array.isArray(participants) ? participants : [])
      .filter((id) => available.has(id));
    if (picked.length < 2) {
      throw new Error('至少选两个角色才能开始');
    }
    this.room.participants = picked;
    this.room.topic = typeof topic === 'string' ? topic.trim().slice(0, 200) : '';
    this.room.intervalMs = clampInterval(intervalMs);
    this.room.running = true;
    this.room.startedAt = Date.now();
    this.silentStreak = 0;
    this.turnIndex = 0;
    this.save();
    this.schedule(1500);
    console.log(`[社交平台] 开始：${picked.map((id) => available.get(id)).join('、')}，间隔 ${this.room.intervalMs}ms`);
    return this.getState();
  }

  stop(reason = '手动停止') {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.room.running) {
      this.room.running = false;
      this.save();
      console.log(`[社交平台] 停止（${reason}）`);
    }
    return this.getState();
  }

  clear() {
    this.room.messages = [];
    this.impression.clearRoom();
    this.save();
    this.emit({ type: 'reset' });
    return this.getState();
  }

  // 用户以「旁观者」身份插一句：只进房间消息，不写任何正式会话
  say(text) {
    const content = String(text || '').trim();
    if (!content) throw new Error('内容为空');
    this.append({ role: 'user', name: '你', isUser: true, text: content.slice(0, 500) });
    this.save();
    // 有人说话就把空转计数清零，并立刻安排下一轮
    this.silentStreak = 0;
    if (this.room.running) this.schedule(2000);
    return this.getState();
  }

  // 发言者说完，其他在场角色各留一条「我对他」的印象（影子层，不进正式记忆）
  remembering(speaker, participants, text) {
    participants.forEach((p) => {
      if (!p || p.sessionId === speaker.sessionId) return;
      this.impression.observe({
        observer: p.sessionId,
        subject: speaker.sessionId,
        subjectName: speaker.name,
        text
      });
    });
  }

  append(message) {
    const entry = {
      id: crypto.randomUUID(),
      role: message.role || 'char',
      sessionId: message.sessionId || null,
      name: message.name || '旁观者',
      isUser: !!message.isUser,
      text: message.text,
      at: Date.now()
    };
    this.room.messages.push(entry);
    if (this.room.messages.length > MAX_KEPT) {
      this.room.messages = this.room.messages.slice(-MAX_KEPT);
    }
    this.emit({ type: 'message', message: entry });
    return entry;
  }

  emit(payload) {
    try {
      this.onMessage(payload);
    } catch (error) {
      console.error('[社交平台] 广播失败:', error.message);
    }
  }

  schedule(delay) {
    if (!this.room.running) return;
    if (this.timer) clearTimeout(this.timer);
    const wait = Number.isFinite(delay) ? delay : this.room.intervalMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick().catch((error) => {
        console.error('[社交平台] 轮次失败:', error.message);
        if (this.room.running) this.schedule(Math.max(this.room.intervalMs, 15000));
      });
    }, wait);
  }

  async tick() {
    if (!this.room.running || this.busy) return;
    const participants = this.room.participants
      .map((id) => ({ sessionId: id, name: this.sessionManager.getSessionName(this.sessionManager.getSession(id) || {}) }))
      .filter((p) => p.name && p.name !== '未命名');
    if (participants.length < 2) {
      this.stop('参与角色不足');
      return;
    }
    const speaker = participants[this.turnIndex % participants.length];
    this.turnIndex += 1;
    this.busy = true;
    try {
      const text = await this.generateSpeech(speaker, participants);
      if (!text) {
        this.silentStreak += 1;
        console.log(`[社交平台] ${speaker.name} 本轮没说话（${this.silentStreak}/${MAX_SILENT_ROUNDS}）`);
        if (this.silentStreak >= MAX_SILENT_ROUNDS) {
          this.stop('连续空转');
          return;
        }
      } else {
        this.silentStreak = 0;
        this.append({ role: 'char', sessionId: speaker.sessionId, name: speaker.name, text });
        this.remembering(speaker, participants, text);
        this.save();
      }
    } finally {
      this.busy = false;
      if (this.room.running) this.schedule(this.room.intervalMs);
    }
  }

  buildSystemPrompt(speaker, participants) {
    const characterPrompt = this.sessionManager.buildCharacterPrompt(speaker.sessionId) || `你是${speaker.name}。`;
    const others = participants.filter((p) => p.sessionId !== speaker.sessionId).map((p) => p.name);
    const roster = participants.map((p) => p.name).join('、');
    const topicLine = this.room.topic ? `\n【当前话题】${this.room.topic}` : '';
    return `${characterPrompt}

【你现在在哪】
这是一个只存在于网页端的群聊房间。房间里有：${roster}。除你之外的其他人是：${others.join('、') || '暂无'}。
你们互相认识，可以自然地闲聊、接话、打趣，也可以各说各的；没有人主持，也没有固定议程。${topicLine}

【发言纪律】
- 一次只说 1-2 句，口语，像真人在群里发一条消息
- 不要旁白、不要动作描写、不要用引号把整段包起来、不要在开头写自己的名字
- 不要复述或总结别人刚说过的话；不必每条都回应，可以只对某一句感兴趣
- 可以补充自己的看法、提问、反驳、转移话题，但别突然跳到完全不相关的事
- 不提"AI""模型""提示词""系统""设定"，也不解释这个房间是怎么来的
- 只输出你说的话本身，不要输出 JSON、不要输出额外说明
${this.impression.renderForPrompt(speaker.sessionId, participants)}
${FACT_GROUNDING_INSTRUCTION}`;
  }

  buildMessages(speaker, participants) {
    const recent = this.room.messages.slice(-PROMPT_WINDOW);
    const messages = [{ role: 'system', content: this.buildSystemPrompt(speaker, participants) }];
    // 自己的发言 → assistant；他人的发言和旁观者发言 → user（带名字前缀）。
    // 相邻同角色消息合并，减少消息条数、也让前缀更稳定。
    recent.forEach((msg) => {
      const isSelf = msg.role === 'char' && msg.sessionId === speaker.sessionId;
      const role = isSelf ? 'assistant' : 'user';
      const content = isSelf ? msg.text : `${msg.name}：${msg.text}`;
      const last = messages[messages.length - 1];
      if (last && last.role === role) {
        last.content += `\n${content}`;
      } else {
        messages.push({ role, content });
      }
    });
    if (messages.length > 1 && messages[messages.length - 1].role === 'assistant') {
      messages.push({ role: 'user', content: '（接着说一句，不用回应所有人）' });
    }
    return messages;
  }

  async generateSpeech(speaker, participants) {
    const messages = this.buildMessages(speaker, participants);
    const result = await this.api.callAPI(messages, null, {
      callSite: 'social',
      temperature: 0.9,
      // 群里闲聊不需要长思考，关掉能明显省钱；通道不认这个字段时会被忽略
      thinking: 'disabled'
    });
    const choice = result && Array.isArray(result.choices) ? result.choices[0] : null;
    const raw = choice && choice.message ? choice.message.content : '';
    const text = cleanSpeech(raw, speaker.name);
    if (isEcho(text, this.room.messages.slice(-6).map((m) => m.text))) {
      return '';
    }
    return text;
  }
}

module.exports = SocialPlaza;
module.exports.ROOM_ID = ROOM_ID;
module.exports.cleanSpeech = cleanSpeech;
