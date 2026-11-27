/**
 * 摄像头 / 看图（视觉记忆）模块
 *
 * 需求约定：
 *  - 只有 AI 态人格能看（角色态拿不到这两个工具，见 toolRegistry 的 AI_ONLY_TOOL_NAMES）
 *  - 伪开发者面板可以开关摄像头、设置抓帧最小间隔（初始 5 分钟）
 *  - 看不看由 AI 自己决定：她主动调用 look_at_user 才会抓，且两次之间受节流限制
 *  - 图片记忆独立成档：data/vision_memories/{userId}.json，只存文字总结（不留原图路径）
 *  - 🔒 隐私：原图仅作为识图的临时落盘，识图一完成立即删除，原始画面不在磁盘留存
 *  - 阶段 4：同一段总结还会汇入主记忆（modality:'vision'），共享显著性/遗忘/召回/巩固；
 *    独立档只留给 recall_vision_memory 主动翻阅
 *
 * 抓帧走浏览器：Node 端拿不到 getUserMedia，由服务页面（已授权摄像头的那台机器）
 * 抓到一帧 JPEG base64 后经 WebSocket 回传，这里只负责发起请求、等回帧、识图、落账。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'data', 'camera_config.json');
const VISION_DIR = path.join(PROJECT_ROOT, 'data', 'vision');
const MEMORY_DIR = path.join(PROJECT_ROOT, 'data', 'vision_memories');

// 默认：开着，两次抓拍最小间隔 5 分钟，初始不设 lastCaptureAt（第一次随时可看）
const DEFAULT_CONFIG = { enabled: true, minIntervalMs: 5 * 60 * 1000, lastCaptureAt: 0 };

// 等前端回帧的上限：页面没开、没授权、或用户不理，都按「看不到」处理
const FRAME_TIMEOUT_MS = 15000;
// 识图请求上限
const VISION_TIMEOUT_MS = 60000;
// 单帧 base64 上限，防止超大图把请求体撑爆（DeepSeek 内联上限 48MiB，这里留足余量）
const MAX_DATA_URL_CHARS = 12 * 1024 * 1024;
// 单个用户的图片记忆最多保留多少条（超出丢弃最早的）
const MAX_MEMORY_ENTRIES = 200;

// 识图时的提问：只要可见事实，不替她下结论、不写成作文
const VISION_PROMPT = [
  '这是刚刚从电脑摄像头捕捉到的一帧画面（可能是用户本人、他的房间或他的桌面）。',
  '请用中文客观描述你看到的内容：画面里有没有人、大致姿态与表情、所处环境、光线，以及任何显眼的东西。',
  '只描述确实看得见的，看不清就说看不清，不要猜测画面外的事，不要编造身份与关系。',
  '控制在 120 字以内，直接给描述，不要加任何前缀。'
].join('\n');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// 把 userId 收敛成安全文件名：只留字母数字下划线连字符，避免路径穿越
function safeUserId(userId) {
  const raw = (typeof userId === 'string' && userId.trim()) ? userId.trim() : 'default';
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return cleaned || 'default';
}

function postJson(urlString, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(urlString);
    } catch (error) {
      reject(new Error(`接口地址无效: ${urlString}`));
      return;
    }
    const lib = target.protocol === 'http:' ? http : https;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = lib.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      }, headers)
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          parsed = null;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed === null ? raw : parsed);
          return;
        }
        const message = parsed?.error?.message || parsed?.message || raw.slice(0, 300);
        reject(new Error(`HTTP ${res.statusCode}: ${message}`));
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

class CameraModule {
  constructor(options = {}) {
    this.configPath = options.configPath || CONFIG_PATH;
    this.visionDir = options.visionDir || VISION_DIR;
    this.memoryDir = options.memoryDir || MEMORY_DIR;
    // 🧠 阶段 4｜多模态汇入：由服务端注入 MemoryModule，把视觉记忆同时写进主记忆生命周期
    this.memoryModule = null;
    // 由服务端注入：把抓帧请求推给前端页面，返回实际收到请求的客户端数量
    this.frameRequester = null;
    // requestId -> { resolve, timer }
    this.pendingFrames = new Map();
    // 同一时刻只允许一次抓帧，避免连续调用把摄像头占用打满
    this.capturing = null;

    ensureDir(this.visionDir);
    ensureDir(this.memoryDir);
    this.config = this.loadConfig();
  }

  // ========== 配置（伪开发者面板：开关 + 抓拍最小间隔） ==========

  loadConfig() {
    const base = Object.assign({}, DEFAULT_CONFIG);
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        if (typeof raw.enabled === 'boolean') base.enabled = raw.enabled;
        const interval = Number(raw.minIntervalMs);
        if (Number.isFinite(interval) && interval >= 0) base.minIntervalMs = interval;
        const last = Number(raw.lastCaptureAt);
        if (Number.isFinite(last) && last > 0) base.lastCaptureAt = last;
      }
    } catch (error) {
      console.error('[Camera] 配置读取失败，使用默认值:', error.message);
    }
    return base;
  }

  saveConfig() {
    try {
      ensureDir(path.dirname(this.configPath));
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error('[Camera] 配置保存失败:', error.message);
    }
  }

  getConfig() {
    return Object.assign({}, this.config);
  }

  // 伪开发者端提交：分钟数转为毫秒，最小 0（0 = 不节流，随便看）
  updateConfig(patch = {}) {
    if (typeof patch.enabled === 'boolean') {
      this.config.enabled = patch.enabled;
    }
    if (patch.minIntervalMinutes !== undefined && patch.minIntervalMinutes !== null && patch.minIntervalMinutes !== '') {
      const minutes = Number(patch.minIntervalMinutes);
      if (Number.isFinite(minutes) && minutes >= 0) {
        this.config.minIntervalMs = Math.round(minutes * 60 * 1000);
      }
    }
    this.saveConfig();
    console.log(`[Camera] 配置已更新：${this.config.enabled ? '开启' : '关闭'}，最小间隔 ${(this.config.minIntervalMs / 60000).toFixed(1)} 分钟`);
    return this.getConfig();
  }

  patchConfig(patch = {}) {
    Object.assign(this.config, patch);
    this.saveConfig();
    return this.getConfig();
  }

  // 面板展示用：把配置摊平成人类可读的状态
  getStatus() {
    const cfg = this.getConfig();
    const sinceLast = cfg.lastCaptureAt ? Date.now() - cfg.lastCaptureAt : null;
    return {
      enabled: cfg.enabled,
      minIntervalMinutes: Number((cfg.minIntervalMs / 60000).toFixed(2)),
      lastCaptureAt: cfg.lastCaptureAt || 0,
      minutesSinceLastCapture: sinceLast === null ? null : Number((sinceLast / 60000).toFixed(1)),
      clientConnected: typeof this.frameRequester === 'function'
    };
  }

  // ========== 抓帧通道（浏览器回传） ==========

  setFrameRequester(requester) {
    this.frameRequester = typeof requester === 'function' ? requester : null;
  }

  // 🧠 阶段 4｜注入主记忆模块：视觉记忆除了落独立档，还会汇入主 memories 共享生命周期
  setMemoryModule(memoryModule) {
    this.memoryModule = memoryModule || null;
  }

  // 前端把抓到的一帧塞回来，唤醒挂起的抓帧请求
  resolveFrame(requestId, { dataUrl = '', error = '' } = {}) {
    const pending = this.pendingFrames.get(requestId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingFrames.delete(requestId);
    if (error || !dataUrl) {
      pending.resolve({ success: false, error: error || '前端没有提供画面' });
    } else {
      pending.resolve({ success: true, dataUrl: String(dataUrl) });
    }
    return true;
  }

  captureFrame() {
    if (typeof this.frameRequester !== 'function') {
      return Promise.resolve({ success: false, error: '摄像头通道没有接上（服务端未启用前端抓帧）' });
    }
    const requestId = `cam_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingFrames.delete(requestId);
        resolve({ success: false, error: '等了 15 秒也没等到画面：可能页面没开、没授权摄像头，或者人不在电脑前' });
      }, FRAME_TIMEOUT_MS);
      this.pendingFrames.set(requestId, { resolve, timer });
      let recipients = 0;
      try {
        recipients = this.frameRequester({ requestId }) || 0;
      } catch (error) {
        recipients = 0;
      }
      if (!recipients) {
        clearTimeout(timer);
        this.pendingFrames.delete(requestId);
        resolve({ success: false, error: '现在没有打开的前端页面，没有人能替你把摄像头打开' });
      }
    });
  }

  // ========== 识图（DeepSeek 视觉，deepseek-flash 原生多模态） ==========

  resolveVisionConfig() {
    let deepseek = {};
    try {
      deepseek = require('./globalConfig').getDefaultApi().deepseek || {};
    } catch (error) {
      console.warn('[Camera] 读取全局配置失败，回退 .env:', error.message);
    }
    return {
      apiUrl: process.env.VISION_API_URL || deepseek.apiUrl || 'https://api.deepseek.com/v1/chat/completions',
      bearerToken: process.env.VISION_BEARER_TOKEN || deepseek.bearerToken || '',
      // 固定用支持图像理解的 flash 模型，不跟随面板上可能被改成纯文本的模型
      modelId: process.env.VISION_MODEL_ID || 'deepseek-flash'
    };
  }

  async describeImage(dataUrl, extraQuestion = '') {
    const cfg = this.resolveVisionConfig();
    if (!cfg.bearerToken) {
      return { success: false, error: '没有配置视觉模型的密钥（DEEPSEEK_BEARER_TOKEN 为空）' };
    }
    const prompt = extraQuestion
      ? `${VISION_PROMPT}\n另外，调用方特别想知道：${String(extraQuestion).slice(0, 200)}`
      : VISION_PROMPT;
    const body = {
      model: cfg.modelId,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
        ]
      }],
      // deepseek-flash 是带思考的模型：它先吐 reasoning_content 再吐 content，两者共用一个额度。
      // 上限给 400 的话，推理还没写完额度就见底（finish_reason 会是 length），content 直接是空串，
      // 表现就是「画面明明拿到了却说认不出来」。这里干脆给足 3 万，不让额度成为识图失败的原因
      max_tokens: 30000,
      temperature: 0.3,
      stream: false
    };
    try {
      const data = await postJson(cfg.apiUrl, { Authorization: `Bearer ${cfg.bearerToken}` }, body, VISION_TIMEOUT_MS);
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        return { success: false, error: '视觉模型没有返回内容' };
      }
      return { success: true, text: text.trim(), modelId: cfg.modelId };
    } catch (error) {
      return { success: false, error: `识图失败: ${error.message}` };
    }
  }

  // ========== 原图落盘（识图后立即删除，不留存） ==========

  saveOriginalImage(userId, dataUrl) {
    const match = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || '').trim());
    if (!match) {
      return { success: false, error: '前端回传的画面格式不对（不是 JPEG/PNG/WebP 的 base64）' };
    }
    const ext = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
    const buffer = Buffer.from(match[2], 'base64');
    const safe = safeUserId(userId);
    const dir = path.join(this.visionDir, safe);
    try {
      ensureDir(dir);
      const file = path.join(dir, `${Date.now()}.${ext}`);
      fs.writeFileSync(file, buffer);
      return {
        success: true,
        imagePath: path.relative(PROJECT_ROOT, file).split(path.sep).join('/'),
        bytes: buffer.length
      };
    } catch (error) {
      return { success: false, error: `原图保存失败: ${error.message}` };
    }
  }

  // 🔒 隐私：识图完成后立即删除临时原图，确保原始画面不在磁盘留存
  deleteOriginalImage(imagePath) {
    if (!imagePath) {
      return false;
    }
    const abs = path.isAbsolute(imagePath) ? imagePath : path.join(PROJECT_ROOT, imagePath);
    try {
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        return true;
      }
    } catch (error) {
      console.warn('[Camera] 原图删除失败（不影响识图结果）:', error.message);
    }
    return false;
  }

  // ========== 图片记忆（独立格式文件，只有 AI 态能读） ==========

  memoryPath(userId) {
    return path.join(this.memoryDir, `${safeUserId(userId)}.json`);
  }

  loadMemories(userId) {
    const file = this.memoryPath(userId);
    const empty = { userId: safeUserId(userId), updatedAt: 0, entries: [] };
    try {
      if (!fs.existsSync(file)) {
        return empty;
      }
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const entries = Array.isArray(raw.entries) ? raw.entries : [];
      return {
        userId: typeof raw.userId === 'string' ? raw.userId : empty.userId,
        updatedAt: Number(raw.updatedAt) || 0,
        entries: entries.filter(item => item && typeof item.summary === 'string')
      };
    } catch (error) {
      console.error('[Camera] 图片记忆读取失败:', error.message);
      return empty;
    }
  }

  saveMemories(userId, store) {
    const entries = Array.isArray(store.entries) ? store.entries.slice(-MAX_MEMORY_ENTRIES) : [];
    const payload = {
      userId: safeUserId(userId),
      updatedAt: Date.now(),
      entries
    };
    try {
      ensureDir(this.memoryDir);
      fs.writeFileSync(this.memoryPath(userId), JSON.stringify(payload, null, 2));
      return payload;
    } catch (error) {
      console.error('[Camera] 图片记忆写入失败:', error.message);
      return null;
    }
  }

  // 每看一次就留一条：文字总结 + 原图路径 + 时间
  addVisionMemory(userId, { summary, imagePath = '', question = '', scope = 'role' }) {
    const store = this.loadMemories(userId);
    const entry = {
      id: `vm_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      capturedAt: Date.now(),
      summary: String(summary || '').trim(),
      imagePath,
      question: String(question || '').trim()
    };
    store.entries.push(entry);
    this.saveMemories(userId, store);
    // 🧠 阶段 4｜汇入主记忆生命周期：与文本记忆共享 salience/遗忘/召回/巩固（独立档仍保留给 recall_vision_memory）
    if (this.memoryModule && typeof this.memoryModule.storeVisualMemory === 'function') {
      try {
        this.memoryModule.storeVisualMemory(userId, {
          summary: entry.summary,
          imagePath: entry.imagePath,
          modality: 'vision',
          scope,
          question: entry.question
        });
      } catch (error) {
        console.warn('[Camera] 视觉记忆汇入主记忆失败（独立档已落，不影响主流程）:', error.message);
      }
    }
    console.log(`[Camera] 已写入图片记忆（${safeUserId(userId)}）：${entry.summary.slice(0, 40)}…`);
    return entry;
  }

  // 按需检索：给关键词就在总结里模糊匹配，不给就返回最近的几条
  recallMemories(userId, { keyword = '', limit = 5 } = {}) {
    const store = this.loadMemories(userId);
    const size = Math.max(1, Math.min(Number(limit) || 5, 20));
    const key = String(keyword || '').trim().toLowerCase();
    const pool = store.entries.slice().reverse();
    const matched = key
      ? pool.filter(item => item.summary.toLowerCase().includes(key))
      : pool;
    return {
      total: store.entries.length,
      keyword: key,
      items: matched.slice(0, size).map(item => ({
        capturedAt: item.capturedAt,
        summary: item.summary,
        imagePath: item.imagePath
      }))
    };
  }

  // ========== 主入口：看一眼 ==========

  async look({ userId = 'default', question = '', scope = 'role' } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      return { success: false, error: '摄像头被伪开发者关掉了，现在看不了' };
    }

    const elapsed = cfg.lastCaptureAt ? Date.now() - cfg.lastCaptureAt : null;
    if (elapsed !== null && elapsed < cfg.minIntervalMs) {
      const waitMinutes = Math.ceil((cfg.minIntervalMs - elapsed) / 60000);
      return {
        success: false,
        throttled: true,
        error: `距上次看你才过了 ${Math.floor(elapsed / 60000)} 分钟，最少间隔 ${(cfg.minIntervalMs / 60000).toFixed(1)} 分钟，大约还要等 ${waitMinutes} 分钟`
      };
    }

    // 并发保护：同时多次调用共用同一次抓帧
    if (this.capturing) {
      return this.capturing;
    }

    this.capturing = this.performLook({ userId, question, scope });
    try {
      return await this.capturing;
    } finally {
      this.capturing = null;
    }
  }

  async performLook({ userId, question, scope }) {
    const frame = await this.captureFrame();
    if (!frame.success) {
      return { success: false, error: frame.error };
    }
    if (frame.dataUrl.length > MAX_DATA_URL_CHARS) {
      return { success: false, error: '抓到的画面太大了，没法处理' };
    }

    // 抓帧成功就先盖时间戳：配额已经被这次消耗掉了，不管后面识图成不成功
    this.patchConfig({ lastCaptureAt: Date.now() });

    const saved = this.saveOriginalImage(userId, frame.dataUrl);
    const described = await this.describeImage(frame.dataUrl, question);

    // 🔒 隐私：识图一结束（无论成功与否）就删掉临时原图，不让原始画面留在磁盘
    if (saved.success) {
      this.deleteOriginalImage(saved.imagePath);
    }

    if (!described.success) {
      return {
        success: false,
        error: `画面拿到了，但没能认出来：${described.error}`,
        imagePath: ''
      };
    }

    // 原图已即时删除，记忆只保留文字总结，不再保留 imagePath
    const entry = this.addVisionMemory(userId, {
      summary: described.text,
      imagePath: '',
      question,
      scope
    });

    return {
      success: true,
      summary: entry.summary,
      imagePath: '',
      capturedAt: entry.capturedAt,
      modelId: described.modelId
    };
  }
}

module.exports = CameraModule;
