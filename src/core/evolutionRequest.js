const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonAtomicSync } = require('../storage/atomicWrite');

// 🧬 进化诉求：她可以「提出」自己缺什么能力，但不能改自己。
//
// 和记忆/自我模型的区别：那两条是认知在变，这里是器官要动（代码、提示词、界面）。
// 所以只落提案，不执行；真正动手由外部 agent 在审批之后做，且必须能回滚。
// 默认 shadow：只记录、不排期，用于观察她到底会提什么，不改变任何行为。

const MODES = new Set(['off', 'shadow', 'live']);
const SCOPES = new Set(['tool', 'memory', 'prompt', 'ui', 'other']);
const DEDUPE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DAILY_DEFAULT = 1;
const MAX_EVIDENCE = 5;

function clip(value, max) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeId(id) {
  const text = String(id || '');
  return /^evo_[A-Za-z0-9_-]{6,40}$/.test(text) ? text : null;
}

function dayKey(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

class EvolutionRequestStore {
  constructor({ dataDir = null, env = process.env, timeline = null, now = () => Date.now() } = {}) {
    this.env = env;
    this.dataDir = dataDir || env.EVOLUTION_DATA_DIR || path.join(__dirname, '..', '..', 'data', 'evolution');
    this.requestsDir = path.join(this.dataDir, 'requests');
    this.timeline = timeline;
    this.now = now;
    try {
      fs.mkdirSync(this.requestsDir, { recursive: true });
    } catch (error) {
      console.warn('[进化诉求] 目录创建失败，诉求将无法落盘:', error.message);
    }
  }

  mode() {
    const value = String(this.env.EVOLUTION_MODE || 'shadow').toLowerCase();
    return MODES.has(value) ? value : 'shadow';
  }

  dailyMax() {
    const value = Number(this.env.EVOLUTION_DAILY_MAX);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : MAX_DAILY_DEFAULT;
  }

  filePath(id) {
    return path.join(this.requestsDir, `${id}.json`);
  }

  loadAll() {
    let files = [];
    try {
      files = fs.readdirSync(this.requestsDir).filter((name) => name.endsWith('.json'));
    } catch (error) {
      return [];
    }
    const list = [];
    for (const name of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.requestsDir, name), 'utf8'));
        if (data && typeof data === 'object' && data.id) list.push(data);
      } catch (error) {
        console.warn(`[进化诉求] 跳过损坏文件 ${name}: ${error.message}`);
      }
    }
    return list.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  }

  get(id) {
    const safe = safeId(id);
    if (!safe) return null;
    try {
      return JSON.parse(fs.readFileSync(this.filePath(safe), 'utf8'));
    } catch (error) {
      return null;
    }
  }

  save(record) {
    try {
      writeJsonAtomicSync(this.filePath(record.id), record);
      return true;
    } catch (error) {
      console.warn('[进化诉求] 保存失败:', error.message);
      return false;
    }
  }

  appendHistory(record, action, by, note = '') {
    if (!Array.isArray(record.history)) record.history = [];
    record.history.push({ at: this.now(), action, by: clip(by, 40) || 'owner', note: clip(note, 200) });
  }

  note(type, record, extra = {}) {
    if (!this.timeline) return;
    try {
      this.timeline.append('evolution', type, {
        id: record.id,
        title: record.title,
        scope: record.scope,
        status: record.status,
        ...extra
      });
    } catch (error) {
      // 观测失败不影响提案本身
    }
  }

  /**
   * 她提出一条诉求。只接受结构化字段，不接受任意代码/文件路径。
   * 返回 { success, id, status, queued, requiresApproval, mode } 或 { success:false, error }
   */
  submit(payload = {}) {
    const mode = this.mode();
    if (mode === 'off') {
      return { success: false, error: '进化诉求通道已关闭（EVOLUTION_MODE=off）' };
    }

    const title = clip(payload.title, 40);
    const need = clip(payload.need, 200);
    const why = clip(payload.why, 400);
    if (!need || need.length < 8) {
      return { success: false, error: 'need 太短：需要说清缺的是哪种能力（至少 8 个字）' };
    }
    if (!why || why.length < 8) {
      return { success: false, error: 'why 太短：需要说清为什么现在需要它' };
    }

    const scope = SCOPES.has(String(payload.scope)) ? String(payload.scope) : 'other';
    const expected = clip(payload.expected, 200);
    const evidence = (Array.isArray(payload.evidence) ? payload.evidence : [])
      .map((item) => clip(item, 120))
      .filter(Boolean)
      .slice(0, MAX_EVIDENCE);

    const now = this.now();
    const all = this.loadAll();

    // 去重：同样的诉求一个月内只提一次；被驳回的可以重新提
    const signature = crypto.createHash('sha1').update(`${scope}|${need}`).digest('hex');
    const duplicate = all.find((item) => item.signature === signature
      && item.status !== 'rejected'
      && now - (Number(item.createdAt) || 0) < DEDUPE_WINDOW_MS);
    if (duplicate) {
      return { success: false, error: `这条诉求已经提过（${duplicate.id}，状态 ${duplicate.status}）`, id: duplicate.id };
    }

    const today = dayKey(now);
    const todayCount = all.filter((item) => item.status !== 'rejected' && dayKey(Number(item.createdAt) || 0) === today).length;
    if (this.dailyMax() !== 0 && todayCount >= this.dailyMax()) {
      return { success: false, error: `今天已经提过 ${todayCount} 条诉求了，明天再说` };
    }

    const id = `evo_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const record = {
      id,
      signature,
      status: 'proposed',
      queued: false,
      title: title || need.slice(0, 24),
      need,
      why,
      expected,
      scope,
      evidence,
      // 来源只记通道标签，不记用户原文，避免把对话里的指直接转成开发任务
      source: clip(payload.source, 20) || 'role',
      createdAt: now,
      updatedAt: now,
      history: []
    };
    this.appendHistory(record, 'proposed', 'self');
    if (!this.save(record)) {
      return { success: false, error: '诉求写入失败，见服务日志' };
    }
    this.note('evolution.requested', record, { mode });
    console.log(`[进化诉求] ${id} 已记录：${record.title}（scope=${scope}, mode=${mode}）`);
    return {
      success: true,
      id,
      status: record.status,
      queued: false,
      requiresApproval: true,
      mode
    };
  }

  approve(id, { by = 'owner', note: noteText = '' } = {}) {
    const record = this.get(id);
    if (!record) return { success: false, error: '诉求不存在' };
    if (record.status !== 'proposed') return { success: false, error: `当前状态是 ${record.status}，不能批准` };
    record.status = 'approved';
    // shadow 下批准也只作记录：不排期、不交给外部 agent
    record.queued = this.mode() === 'live';
    record.updatedAt = this.now();
    this.appendHistory(record, record.queued ? 'approved' : 'approved_shadow', by, noteText);
    this.save(record);
    this.note('evolution.approved', record, { queued: record.queued, by });
    return { success: true, id: record.id, status: record.status, queued: record.queued };
  }

  reject(id, { by = 'owner', reason = '' } = {}) {
    const record = this.get(id);
    if (!record) return { success: false, error: '诉求不存在' };
    if (record.status === 'applied') return { success: false, error: '已经落地的诉求不能驳回' };
    record.status = 'rejected';
    record.queued = false;
    record.updatedAt = this.now();
    this.appendHistory(record, 'rejected', by, reason);
    this.save(record);
    this.note('evolution.rejected', record, { by, reason: clip(reason, 80) });
    return { success: true, id: record.id, status: record.status };
  }

  // 外部 agent 领取：只有 live 下批准过的诉求才会出现在队列里
  claim(id, { agent = 'external' } = {}) {
    const record = this.get(id);
    if (!record) return { success: false, error: '诉求不存在' };
    if (record.status !== 'approved' || record.queued !== true) {
      return { success: false, error: '这条诉求还没有被排期（需要 live 模式并批准）' };
    }
    record.status = 'claimed';
    record.claimedBy = clip(agent, 40) || 'external';
    record.updatedAt = this.now();
    this.appendHistory(record, 'claimed', record.claimedBy);
    this.save(record);
    this.note('evolution.claimed', record, { agent: record.claimedBy });
    return { success: true, id: record.id, status: record.status };
  }

  applied(id, { note: noteText = '' } = {}) {
    const record = this.get(id);
    if (!record) return { success: false, error: '诉求不存在' };
    if (!['claimed', 'approved'].includes(record.status)) {
      return { success: false, error: `当前状态是 ${record.status}，不能标记为已落地` };
    }
    record.status = 'applied';
    record.updatedAt = this.now();
    this.appendHistory(record, 'applied', record.claimedBy || 'external', noteText);
    this.save(record);
    this.note('evolution.applied', record, { note: clip(noteText, 80) });
    return { success: true, id: record.id, status: record.status };
  }

  failed(id, { note: noteText = '' } = {}) {
    const record = this.get(id);
    if (!record) return { success: false, error: '诉求不存在' };
    record.status = 'failed';
    record.queued = false;
    record.updatedAt = this.now();
    this.appendHistory(record, 'failed', 'external', noteText);
    this.save(record);
    this.note('evolution.failed', record, { note: clip(noteText, 80) });
    return { success: true, id: record.id, status: record.status };
  }

  list({ status = '' } = {}) {
    const all = this.loadAll();
    return status ? all.filter((item) => item.status === status) : all;
  }

  queue() {
    return this.loadAll().filter((item) => item.status === 'approved' && item.queued === true);
  }
}

module.exports = { EvolutionRequestStore, MODES, SCOPES };
