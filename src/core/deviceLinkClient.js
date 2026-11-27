'use strict';

const fs = require('fs');
const path = require('path');

// 感知与行动平台（pog-sense）的协议客户端。
// 主项目只认 /v1 接口，不 require 平台任何文件、不装 serialport；
// 平台没启动时全部降级：动作名为空 → robot_action 自动从工具列表消失。

const DEFAULT_BASE_URL = 'http://127.0.0.1:7788';
const REFRESH_MS = 5000;
const INBOX_POLL_MS = 1000;
const REQUEST_TIMEOUT_MS = 10000;
// 平台未配置 token 时会自动生成到兄弟目录的 .token；这里只读配置，不引入代码依赖
const DEFAULT_TOKEN_FILE = path.join(__dirname, '..', '..', '..', 'pog-sense', '.token');

// 光读一个状态不需要等满 10 秒：动作后的回读是主链路上的，超时就当没读到
const STATE_TIMEOUT_MS = 2000;

// 本体状态只保留能读懂的字段：平台/本体两侧字段可能增减，这里做一次白名单收敛
function normalizeBodyState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const state = {};
  if (typeof raw.mode === 'string') state.mode = raw.mode;
  if (Number.isFinite(raw.battery)) state.battery = raw.battery;
  if (raw.joints && typeof raw.joints === 'object') {
    state.joints = {};
    for (const [name, value] of Object.entries(raw.joints)) {
      const num = Number(value);
      if (Number.isFinite(num)) state.joints[name] = Math.round(num * 100) / 100;
    }
  }
  if (typeof raw.source === 'string') state.source = raw.source;
  if (raw.lastSkill && typeof raw.lastSkill === 'object') state.lastSkill = raw.lastSkill;
  if (typeof raw.online === 'boolean') state.online = raw.online;
  return Object.keys(state).length > 0 ? state : null;
}

// 动作之后判「到底动没动」：只看关节变化量，不猜动作语义（动作表里没有目标角度）。
// 1.5° 是噪声与真实位移的分界；仍不确定时宁可说看不出，也不替她下结论
const MOTION_EPSILON_DEG = 1.5;
const MOTION_RECHECK_MS = 400;

function diffJoints(before, after) {
  if (!before || !after || !before.joints || !after.joints) return null;
  const changed = {};
  let maxAbs = 0;
  let count = 0;
  for (const [name, value] of Object.entries(after.joints)) {
    if (!Object.prototype.hasOwnProperty.call(before.joints, name)) continue;
    const delta = Math.round((value - before.joints[name]) * 100) / 100;
    if (Math.abs(delta) >= 0.01) changed[name] = delta;
    if (Math.abs(delta) > maxAbs) maxAbs = Math.abs(delta);
    count += 1;
  }
  return { changed, maxAbs, count };
}

function readSharedToken() {
  try {
    return fs.readFileSync(DEFAULT_TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

class DeviceLinkClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || process.env.POG_SENSE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.token = String(options.token || process.env.POG_SENSE_TOKEN || readSharedToken()).trim();
    this.refreshMs = parseInt(options.refreshMs, 10) || REFRESH_MS;
    this.inboxPollMs = parseInt(options.inboxPollMs, 10) || INBOX_POLL_MS;
    this.requestTimeoutMs = parseInt(options.requestTimeoutMs, 10) || REQUEST_TIMEOUT_MS;

    this.enabled = false;
    this.ready = false;
    this.stopping = false;
    this.onInput = null;
    this.names = [];
    this.serialStatus = null;
    this.refreshTimer = null;
    this.inboxTimer = null;
    this.inboxCursor = 0;
    this.lastError = '';
  }

  // 一键开关：DEVICE_ENABLED=false 时服务器不调这里，也没有任何轮询。
  start(handlers = {}) {
    if (handlers.onInput) this.onInput = handlers.onInput;
    if (this.enabled) return this;
    this.enabled = true;
    this.stopping = false;
    this.refresh();
    this.scheduleRefresh();
    this.pollInbox();
    return this;
  }

  headers() {
    const headers = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  async request(pathname, init = {}, timeoutMs = this.requestTimeoutMs) {
    const response = await fetch(`${this.baseUrl}${pathname}`, Object.assign({}, init, {
      headers: Object.assign(this.headers(), init.headers || {}),
      signal: AbortSignal.timeout(timeoutMs)
    }));
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error((data && data.error) || `HTTP ${response.status}`);
      // 4xx 是平台对这条指令的拒绝，不是链路掉线；上层据此决定要不要摘工具
      error.status = response.status;
      throw error;
    }
    return data;
  }

  // 动作名和设备状态都由平台给：主项目不再读动作表文件
  async refresh() {
    if (!this.enabled) return;
    try {
      const data = await this.request('/v1/capabilities');
      this.ready = true;
      this.lastError = '';
      this.names = Array.isArray(data && data.actions) ? data.actions.slice() : [];
      this.serialStatus = (data && data.serial) || null;
    } catch (error) {
      this.ready = false;
      this.names = [];
      this.serialStatus = null;
      if (this.lastError !== error.message) {
        this.lastError = error.message;
        console.warn(`[设备平台] 不可用（${error.message}），robot_action 暂时下架`);
      }
    }
  }

  scheduleRefresh() {
    if (this.stopping) return;
    this.refreshTimer = setTimeout(async () => {
      await this.refresh();
      this.scheduleRefresh();
    }, this.refreshMs);
    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }

  // 同步接口：工具表构建时不能等网络，这里只返回上次刷新到的快照
  listActionNames() {
    if (!this.enabled || !this.ready) return [];
    return this.names.slice();
  }

  // 同步快照：工具表构建/提示词不能等网络，这里只给最近一次刷新到的状态
  bodyState() {
    const state = normalizeBodyState(this.serialStatus);
    if (!state) return null;
    return Object.assign({ online: !!this.ready }, state);
  }

  // 主动感知：随时读一眼本体真实状态（check_body 与动作回执共用）
  async observe() {
    try {
      const data = await this.request('/v1/capabilities', {}, STATE_TIMEOUT_MS);
      this.ready = true;
      this.lastError = '';
      if (Array.isArray(data && data.actions)) this.names = data.actions.slice();
      this.serialStatus = (data && data.serial) || null;
      return this.bodyState();
    } catch (error) {
      this.lastError = error.message;
      return null;
    }
  }

  // 给模型看的一句话状态：只要模式/电量/主要关节，不把原始结构塞进上下文
  describeState(state) {
    if (!state || typeof state !== 'object') return '';
    const parts = [];
    if (state.mode) parts.push(`模式 ${state.mode}`);
    if (Number.isFinite(state.battery)) parts.push(`电量 ${Math.round(state.battery)}%`);
    if (state.joints && typeof state.joints === 'object') {
      const pairs = Object.entries(state.joints)
        .slice(0, 8)
        .map(([name, value]) => `${name} ${Math.round(Number(value))}°`);
      if (pairs.length) parts.push(`关节 ${pairs.join('，')}`);
    }
    return parts.join('；');
  }

  // 动作前后对比：moved（确实动了）/ still（完全没动）/ unknown（没数据或还在执行中）
  describeMotion(before, after) {
    const diff = diffJoints(before, after);
    if (!diff || diff.count === 0) return { verdict: 'unknown' };
    if (diff.maxAbs < MOTION_EPSILON_DEG) {
      // 还在 executing 说明可能只是没走完，不能判「没动」
      if (after && after.mode === 'executing') return { verdict: 'unknown' };
      return { verdict: 'still', maxDelta: diff.maxAbs, joints: diff.changed };
    }
    return { verdict: 'moved', maxDelta: diff.maxAbs, joints: diff.changed };
  }

  async enqueue(action, meta = {}) {
    // 动作前的快照用最近一次刷新：不为了判定再插一次前置请求
    const before = this.bodyState();
    try {
      const data = await this.request('/v1/actions', {
        method: 'POST',
        body: JSON.stringify({ action, source: (meta && meta.source) || 'tool' })
      });
      const result = data && data.result;
      if (!result || typeof result !== 'object') {
        return { success: false, error: '设备平台没有返回执行结果' };
      }
      // 闭环：动作发出去之后再读一眼真实状态，让她能确认「到底动没动、到没到位」。
      // 读不到状态只是少一条回执，不影响动作本身的结果
      if (result.success !== false) {
        let state = await this.observe();
        if (state) {
          let motion = this.describeMotion(before, state);
          // 第一眼没动、又不在执行中，等 400ms 复核一次，避免抓在动作起步前误判
          if (motion.verdict === 'still') {
            await new Promise(resolve => setTimeout(resolve, MOTION_RECHECK_MS));
            const again = await this.observe();
            if (again) {
              state = again;
              motion = this.describeMotion(before, again);
            }
          }
          result.state = state;
          result.motion = motion;
          result.summary = this.describeState(state);
          if (motion.verdict === 'still') {
            result.summary += '（关节没有变化，可能没动或被卡住）';
          }
        }
      }
      return result;
    } catch (error) {
      // 平台明确拒绝这条指令（未知动作/参数非法/队列满）时链路还在，不摘工具
      if (error.status >= 400 && error.status < 500) {
        return { success: false, error: `设备平台拒绝：${error.message}` };
      }
      this.ready = false;
      return { success: false, error: `设备平台不可用：${error.message}` };
    }
  }

  async status() {
    try {
      const data = await this.request('/v1/capabilities');
      return Object.assign({ success: true }, (data && data.serial) || {});
    } catch (error) {
      return { success: false, error: `设备平台不可用：${error.message}` };
    }
  }

  async pollInbox() {
    if (this.stopping) return;
    try {
      const data = await this.request(`/v1/inbox?since=${this.inboxCursor}`);
      const events = Array.isArray(data && data.events) ? data.events : [];
      for (const event of events) {
        if (typeof event.id === 'number' && event.id > this.inboxCursor) {
          this.inboxCursor = event.id;
        }
        this.handleInput(event);
      }
    } catch {
      // 在线状态只由 refresh 维护：轮询失败不额外改状态，避免把动作名闪掉
    }
    if (this.stopping) return;
    this.inboxTimer = setTimeout(() => this.pollInbox(), this.inboxPollMs);
    if (this.inboxTimer.unref) this.inboxTimer.unref();
  }

  // 设备上行文本走网页端同一条对话链路，处理完再把回复交回平台
  async handleInput(event) {
    if (typeof this.onInput !== 'function') {
      this.replyInput(event.reqId, { error: '服务端未接上对话链路' }).catch(() => {});
      return;
    }
    try {
      const output = await this.onInput(event.text, {
        sessionId: event.sessionId,
        userId: event.userId,
        source: 'device'
      });
      this.replyInput(event.reqId, {
        text: (output && output.data) || '',
        emotion: (output && output.emotion) || null
      }).catch(error => console.warn('[设备平台] 回复设备失败:', error.message));
    } catch (error) {
      console.error('[设备平台] 上行文本处理失败:', error.message);
      this.replyInput(event.reqId, { error: '对话处理失败' }).catch(() => {});
    }
  }

  async replyInput(reqId, payload) {
    return this.request('/v1/reply', {
      method: 'POST',
      body: JSON.stringify(Object.assign({ reqId }, payload))
    });
  }

  stop() {
    this.stopping = true;
    this.enabled = false;
    this.ready = false;
    this.names = [];
    this.serialStatus = null;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.inboxTimer) {
      clearTimeout(this.inboxTimer);
      this.inboxTimer = null;
    }
  }
}

module.exports = { DeviceLinkClient, normalizeBodyState };
