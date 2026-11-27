const fs = require('fs');
const path = require('path');
const { UnifiedAPI } = require('./api');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');

// 🏠 私生活档案：给她一条「不依赖你也在走」的时间线。
//
// 现状是——记忆是用户说的、事件簿是用户的约定、时间表是用户设的，角色身上没有任何
// 一条独立于用户的状态。所以只要没人说话，她就不存在。
//
// 这里每天替她补一次「今天」：做过的事、心情、一篇只她可见的日记、以及想说没说出口的话。
// 只落 data/characterLife/，不写主会话历史（生活不是对话），也不碰事件簿（那是用户的约定）。
// 生成是 best-effort：失败静默、次日重试，绝不影响正式回复。

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'characterLife');

const KEEP_DAYS = 14;                 // 档案保留天数
const GENERATE_HOUR = 22;             // 22 点后才写「今天」，此时这一天才完整
const ACTIVE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 三天没聊过就不再替她过日子，省额度
const MAX_SESSIONS_PER_TICK = 20;     // 单轮最多生成几个，防止一次性打满
const MAX_HISTORY = 12;               // 生成时回看的当天对话条数
const FAIL_RETRY_MS = 60 * 60 * 1000; // 失败后一小时再试，别每 30 秒烧一次
const UNSPOKEN_DECAY = 0.7;           // 未说出口的话每天衰减一次，会自己淡掉
const UNSPOKEN_MIN_WEIGHT = 0.3;

function pad(n) {
  return String(n).padStart(2, '0');
}

// 本地日期键：跨天判定和存储都用它，避免 UTC 偏移把凌晨算到前一天
function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function safeSessionId(raw) {
  const id = String(raw || '');
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

class PrivateLife {
  constructor({ unifiedAPI = null, dataDir = null, timeline = null, timelineScope = null } = {}) {
    this.unifiedAPI = unifiedAPI || new UnifiedAPI();
    // 落盘目录可注入：测试必须走临时目录，不能读写真实的 data/characterLife
    this.dataDir = dataDir || DATA_DIR;
    // 🕰️ 时间线：每天生成出一条新动态后记一笔；scope 由上层规范化
    this.timeline = timeline;
    this.timelineScope = typeof timelineScope === 'function' ? timelineScope : null;
    this.cache = new Map();      // sessionId → 档案对象
    this.failedUntil = new Map(); // sessionId → 最早重试时间戳
    this.firstFeedDone = new Set(); // 朋友圈首次补写只做一次（进程内）
  }

  filePath(sessionId) {
    return path.join(this.dataDir, `${sessionId}.json`);
  }

  load(sessionId) {
    const id = safeSessionId(sessionId);
    if (!id) return null;
    if (this.cache.has(id)) return this.cache.get(id);

    let data = null;
    try {
      const file = this.filePath(id);
      if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      console.warn(`[私生活] ${id} 读取失败，按空档案处理:`, error.message);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      data = { sessionId: id, characterName: '', lastGeneratedDay: '', days: [] };
    }
    if (!Array.isArray(data.days)) data.days = [];
    this.cache.set(id, data);
    return data;
  }

  save(data) {
    if (!data || !data.sessionId) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      writeJsonAtomicSync(this.filePath(data.sessionId), data);
    } catch (error) {
      console.warn('[私生活] 保存失败:', error.message);
    }
  }

  // 到了该写「今天」的时候了吗：必须是 22 点后，且这一天还没写过
  shouldGenerate(sessionId, now = Date.now()) {
    const data = this.load(sessionId);
    if (!data) return false;
    const date = new Date(now);
    if (date.getHours() < GENERATE_HOUR) return false;
    if (data.lastGeneratedDay === dayKey(date)) return false;
    const failedAt = this.failedUntil.get(sessionId) || 0;
    return now >= failedAt;
  }

  // 单会话生成一条「今天」。history 为该会话最近的对话（旧→新）；
  // userId 只给时间线用（写 life.event 时才知道这条生活属于谁），不参与生成
  async generateFor({ sessionId, characterPrompt = '', history = [], now = Date.now(), preview = false, userId = '' }) {
    const id = safeSessionId(sessionId);
    if (!id) return false;

    const data = this.load(id);
    if (!data) return false;

    const date = new Date(now);
    const weekday = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
    const clock = `${date.getFullYear()}年${pad(date.getMonth() + 1)}月${pad(date.getDate())}日 星期${weekday} ${pad(date.getHours())}:${pad(date.getMinutes())}`;

    const talk = (Array.isArray(history) ? history : [])
      .filter((m) => m && typeof m.content === 'string' && m.content.trim())
      .slice(-MAX_HISTORY)
      .map((m) => `- ${m.role === 'assistant' ? '你说' : '他说'}：${m.content.replace(/\s+/g, ' ').slice(0, 80)}`)
      .join('\n');

    const persona = String(characterPrompt || '').slice(0, 1200);

    // 前 1~2 天的生活也带上：日子要有连续性，不能每天从零凭空活一遍
    const recent = (Array.isArray(data.days) ? data.days : [])
      .filter((d) => d && d.day < dayKey(date) && Array.isArray(d.events) && d.events.length)
      .sort((a, b) => String(a.day).localeCompare(String(b.day)))
      .slice(-2)
      .map((d) => {
        const items = d.events.map((e) => `${e.at ? `${e.at} ` : ''}${e.what}`).join('；');
        return `- ${d.day}：${items}${d.mood ? `（心情：${d.mood}）` : ''}`;
      })
      .join('\n');

    const prompt = `${persona}

【真实时间】${clock}（Asia/Shanghai）

前两天你自己是这样过的（只是延续的参照，不要照抄，也不要当成他知道的事）：
${recent || '（没有更早的记录）'}

今天你和他的对话（按时间顺序，可能为空）：
${talk || '（今天没有聊过）'}

现在请你以第一人称，补完「你自己」这一天的私人生活。这部分只有你自己知道，他看不到，也不会被告知。

要求：
1. events 写 3 条今天你亲手做过的事：具体、生活化、有细节，符合你的人设与作息。不要宏大叙事，不要写成心情总结。若前一两天有事没做完、或还在挂心，今天可以自然接着做，不要每天凭空换一套新生活。
2. diary 是一条你今晚写下的私密日记，50~120 字，写真实感受。可以提到他，但不要变成汇报或抒情作文。
3. unspoken 是 1~2 句「你想对他说、但今天没说出口的话」，是你没讲出来的念头，不是已经说过的话。
4. 时间都在今天之内、且不晚于现在；不许编造他做过或说过的事，他做过什么只能以【对话】里出现过的为准。
5. 如果你今天大部分时间在忙自己的事，就如实写你在忙什么，不要为了配合他而虚构陪伴。
6. post 是你今晚会发在朋友圈的一句话：口语、有画面、20~60 字。可以是吐槽、碎念、随手记下的小事。
   不要喊口号，不要总结心情，不要写成日记的缩写。tag 是两个字以内的分类（如 生活 / 碎念 / 深夜）。

只输出一行 JSON，不要任何其他内容：
{"mood":"三个字以内的心情","events":[{"at":"HH:mm","what":"做了什么"}],"diary":"...","unspoken":["..."],"post":{"text":"...","tag":"生活"}}`;

    let raw;
    try {
      const result = await this.unifiedAPI.callAPI([{ role: 'user', content: prompt }], null, { callSite: 'privateLife' });
      raw = result?.choices?.[0]?.message?.content || '';
    } catch (error) {
      this.failedUntil.set(id, Date.now() + FAIL_RETRY_MS);
      console.warn(`[私生活] ${id} 生成失败（不影响回复）:`, error.message);
      return false;
    }

    const match = String(raw).match(/\{[\s\S]*\}/);
    if (!match) {
      this.failedUntil.set(id, Date.now() + FAIL_RETRY_MS);
      console.warn(`[私生活] ${id} 返回无法解析，本轮跳过`);
      return false;
    }

    let parsed;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      this.failedUntil.set(id, Date.now() + FAIL_RETRY_MS);
      return false;
    }
    if (!parsed || typeof parsed !== 'object') {
      this.failedUntil.set(id, Date.now() + FAIL_RETRY_MS);
      return false;
    }

    const today = dayKey(date);

    // 同一天可能生成两次（白天预览 + 22 点正式）：只在跨天时衰减一次，
    // 否则同一天会被 0.7 打两次（0.7 → 0.49），没说的话提前消失。
    const previous = data.days.find((d) => d && d.day === today);
    data.days = data.days.filter((d) => d && d.day !== today);
    if (!previous) for (const day of data.days) this.decayDay(day);

    const nextDay = this.normalizeDay(parsed, today, now);
    if (previous) {
      // 正文以新生成的那次为准，但用户的痕迹必须原样带过来
      if (previous.post && nextDay.post) {
        nextDay.post.liked = previous.post.liked === true;
        nextDay.post.likedAt = Number(previous.post.likedAt) || 0;
        nextDay.post.comments = Array.isArray(previous.post.comments) ? previous.post.comments : [];
      }
      // 预览版已经写下的心事不能因为重生成而丢掉：去重后并回来
      const known = new Set(nextDay.unspoken.map((u) => u.text));
      const carried = (Array.isArray(previous.unspoken) ? previous.unspoken : [])
        .filter((u) => u && u.text && !known.has(u.text));
      if (carried.length) nextDay.unspoken = nextDay.unspoken.concat(carried);
    }
    data.days.push(nextDay);
    data.days.sort((a, b) => String(a.day).localeCompare(String(b.day)));
    if (data.days.length > KEEP_DAYS) data.days = data.days.slice(-KEEP_DAYS);
    // 白天的一次性回填只是「预览」，不能把今天标记成已生成，否则 22 点就不会再写完整版
    if (!preview) data.lastGeneratedDay = today;
    data.characterName = data.characterName || '';
    this.failedUntil.delete(id);
    this.save(data);
    // 🕰️ 时间线：她今天真的多了一段生活（预览版也算，当晚完整版会覆盖同一天）
    if (this.timeline && userId) {
      const scope = this.timelineScope ? this.timelineScope(String(userId)) : `${String(userId)}__role`;
      const post = nextDay && nextDay.post ? nextDay.post : null;
      this.timeline.append(scope, 'life.event', {
        postId: post && post.id ? String(post.id) : `life:${id}:${today}`,
        day: today,
        text: String((post && post.text) || nextDay.diary || '').slice(0, 500)
      });
    }
    console.log(`[私生活] ${id} 记下 ${today} 的一天（${data.days[data.days.length - 1].events.length} 件事）`);
    return true;
  }

  // 旧一天里未说出口的话逐日变淡，最后自己消失——想念会淡，不会堆成账本
  decayDay(day) {
    if (!day || !Array.isArray(day.unspoken)) return;
    day.unspoken = day.unspoken
      .map((u) => (u && typeof u === 'object' ? { ...u, weight: (Number(u.weight) || 0.7) * UNSPOKEN_DECAY } : null))
      .filter((u) => u && u.text && u.weight >= UNSPOKEN_MIN_WEIGHT);
  }

  normalizeDay(parsed, day, now) {
    const events = (Array.isArray(parsed.events) ? parsed.events : [])
      .slice(0, 3)
      .map((e) => {
        if (typeof e === 'string') return { at: '', what: e.slice(0, 80) };
        return {
          at: /^\d{1,2}:\d{2}$/.test(String(e && e.at)) ? String(e.at) : '',
          what: String((e && e.what) || '').slice(0, 80)
        };
      })
      .filter((e) => e.what);

    const unspoken = (Array.isArray(parsed.unspoken) ? parsed.unspoken : [])
      .slice(0, 2)
      .map((text) => ({
        text: String(typeof text === 'string' ? text : (text && text.text) || '').slice(0, 80),
        weight: 0.7,
        at: now
      }))
      .filter((u) => u.text);

    return {
      day,
      mood: String(parsed.mood || '').slice(0, 20),
      events,
      diary: String(parsed.diary || '').slice(0, 300),
      unspoken,
      post: this.normalizePost(parsed.post, now)
    };
  }

  // 朋友圈的一条动态。缺字段就是没有，不伪造
  normalizePost(raw, now) {
    const source = raw && typeof raw === 'object' ? raw : null;
    const text = String((source && source.text) || '').trim().slice(0, 120);
    if (!text) return null;
    return {
      id: `p_${now}`,
      at: now,
      text,
      tag: String((source && source.tag) || '生活').slice(0, 6),
      liked: false,
      likedAt: 0,
      comments: []
    };
  }

  // 注入用文本。只给最近一天，且必须是今天——过时的生活流不能当成「我今天」播报
  getLifePrompt(sessionId, now = Date.now()) {
    const data = this.load(sessionId);
    if (!data || data.days.length === 0) return '';

    const latest = data.days[data.days.length - 1];
    if (!latest) return '';
    const isToday = latest.day === dayKey(new Date(now));

    const lines = [];
    if (isToday && Array.isArray(latest.events) && latest.events.length > 0) {
      lines.push(`【你今天的生活】你不是只在他说话时才存在的人。今天你自己是这样的：`);
      for (const e of latest.events) {
        lines.push(`- ${e.at ? `${e.at} ` : ''}${e.what}`);
      }
    } else if (latest.diary) {
      // 今天还没写：只用昨天日记的余温，不拿旧事件冒充「今天」
      lines.push(`【你最近的生活】你也有自己的日子要过，只是这会儿没细想。`);
    }

    if (latest.diary) {
      lines.push(`${isToday ? '今晚' : '最近'}你在日记里写过一句：「${latest.diary}」`);
    }

    // 跨天累计的「没说出口的话」，挑分量最重的那一句
    const unspoken = data.days
      .flatMap((d) => (Array.isArray(d.unspoken) ? d.unspoken : []))
      .filter((u) => u && u.text)
      .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0))[0];
    if (unspoken) {
      lines.push(`你心里还有一句没说出口的话：「${unspoken.text}」——此刻若自然，可以让它透出来；不必刻意说，更不要照搬原句。`);
    }

    if (lines.length <= 1) return '';

    lines.push('这些是你真实的经历和心情，可以自然提起，但不要一开口就汇报日程；也不要声称自己做了上面之外的事。');
    return `\n${lines.join('\n')}\n`;
  }

  // ==================== 朋友圈（动态流）====================
  // 动态是生活档案的一种展示：不另存文件，直接取 days[].post，跟着 14 天保留期一起走

  listPosts(sessionId) {
    const data = this.load(sessionId);
    if (!data) return [];
    return data.days
      .filter((d) => d && d.post && d.post.text)
      .map((d) => ({ day: d.day, mood: d.mood || '', ...d.post }))
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  }

  findPost(sessionId, postId) {
    const data = this.load(sessionId);
    if (!data) return null;
    for (const day of data.days) {
      if (day && day.post && day.post.id === postId) return { data, day, post: day.post };
    }
    return null;
  }

  toggleLike(sessionId, postId) {
    const hit = this.findPost(sessionId, postId);
    if (!hit) return null;
    hit.post.liked = !hit.post.liked;
    hit.post.likedAt = hit.post.liked ? Date.now() : 0;
    this.save(hit.data);
    return { liked: hit.post.liked };
  }

  // 只负责落评论，生成回复交给上层（避免这里反向依赖 outputModule）
  addComment(sessionId, postId, role, text) {
    const hit = this.findPost(sessionId, postId);
    if (!hit) return null;
    const clean = String(text || '').trim().slice(0, 200);
    if (!clean) return null;
    const entry = { role: role === 'assistant' ? 'assistant' : 'user', text: clean, at: Date.now() };
    hit.post.comments.push(entry);
    this.save(hit.data);
    return entry;
  }

  // 首次访问朋友圈时的一条「即时补写」：只在一条动态都没有时触发，每个会话只跑一次。
  // 白天触发的是预览版，不写 lastGeneratedDay，所以当晚 22 点仍会生成完整版
  async ensureFirstFeed({ sessionId, characterPrompt = '', history = [], now = Date.now(), userId = '' }) {
    const id = safeSessionId(sessionId);
    if (!id) return false;
    if (this.listPosts(id).length > 0) return false;
    if (this.firstFeedDone.has(id)) return false;
    if ((this.failedUntil.get(id) || 0) > now) return false;
    this.firstFeedDone.add(id);
    return this.generateFor({ sessionId: id, characterPrompt, history, now, preview: true, userId });
  }

  // 遍历活跃会话，替还没写「今天」的角色补上
  async tick({ sessionManager, now = Date.now() } = {}) {
    if (!sessionManager || typeof sessionManager.getAllSessions !== 'function') return;
    if (new Date(now).getHours() < GENERATE_HOUR) return;

    let generated = 0;
    for (const session of sessionManager.getAllSessions()) {
      if (generated >= MAX_SESSIONS_PER_TICK) break;
      const sessionId = session && session.sessionId;
      if (!sessionId || !this.shouldGenerate(sessionId, now)) continue;

      const userId = session.creatorId || Object.keys(session.users || {})[0];
      if (!userId) continue;

      let history;
      try {
        history = sessionManager.getConversationHistory(sessionId, userId, MAX_HISTORY) || [];
      } catch {
        history = [];
      }
      // 三天没说过话的角色不替她过日子：生成出来也没人会看到，纯粹白烧额度
      const lastTs = Number(history.length > 0 ? history[history.length - 1].timestamp : 0) || 0;
      if (!lastTs || now - lastTs > ACTIVE_WINDOW_MS) continue;

      let characterPrompt;
      try {
        characterPrompt = sessionManager.buildCharacterPrompt(sessionId) || '';
      } catch {
        characterPrompt = '';
      }

      const ok = await this.generateFor({ sessionId, characterPrompt, history, now, userId });
      if (ok) generated += 1;
    }
  }
}

module.exports = PrivateLife;
