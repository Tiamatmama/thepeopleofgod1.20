'use strict';

// 中枢（AgentFleet）：16 个槽位 = 4 写手 + 12 只读侦察。
// 它只做「规划 → 接线 → 派发 → 合并 → 收尾」，真正的代码执行仍由 CodingLoop 完成；
// 本文件不实现第二套执行器，也不直接改任何用户工作区。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { DispatchDesk } = require('./dispatchDesk');
const { FleetMonitor } = require('./fleetMonitor');
const { FleetScout } = require('./fleetScout');
const { copyTaskWorkspace } = require('./workspaceCopy');
const { normalizeManifest, validateManifest } = require('./taskManifest');

const MAX_SLOTS = 16;
const DEFAULT_WRITERS = 4;
const DEFAULT_SCOUTS = 12;
const DEFAULT_TOKEN_BUDGET = 600000;
const DEFAULT_POLL_MS = 500;
const DEFAULT_MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const TERMINAL_STATUS = new Set(['passed', 'failed', 'stopped', 'timeout', 'paused', 'stalled', 'budget_exhausted', 'error']);

// 写手工具白名单：不含任意 code_run / code_git / code_deploy，
// 写手只能写声明过的文件、跑声明过的测试；合并由中枢统一做。
const WRITER_TOOLS = [
  'code_write',
  'code_apply_patch',
  'code_read',
  'code_read_range',
  'code_list_dir',
  'code_search',
  'code_find_symbol',
  'code_find_refs',
  'code_repo_map',
  'code_diagnose',
  'code_run_tests',
  'web_search',
  'fetch_url'
];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function safeInt(value, min, max, fallback) {
  const num = parseInt(value, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(num, max));
}

function usageBilled(run) {
  const usage = run && run.tokenUsage;
  if (!usage) return 0;
  const billed = Number(usage.billed);
  return Number.isFinite(billed) ? billed : (Number(usage.total) || 0);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function appendJsonl(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(data)}\n`, 'utf8');
}

function publicSlot(slot) {
  return {
    agentId: slot.agentId,
    role: slot.role,
    taskId: slot.taskId,
    status: slot.status,
    runId: slot.runId || '',
    error: slot.error || '',
    findings: slot.findings || '',
    usage: slot.usage || 0,
    startedAt: slot.startedAt || '',
    finishedAt: slot.finishedAt || '',
    heartbeatAt: slot.heartbeatAt || ''
  };
}

function publicFleet(fleet) {
  return {
    id: fleet.id,
    goal: fleet.goal,
    sourceTaskId: fleet.sourceTaskId || '',
    baseTaskId: fleet.baseTaskId,
    baseSha: fleet.baseSha || '',
    status: fleet.status,
    createdAt: fleet.createdAt,
    updatedAt: fleet.updatedAt,
    startedAt: fleet.startedAt || '',
    finishedAt: fleet.finishedAt || '',
    tokenBudget: fleet.tokenBudget,
    usedTokens: fleet.usedTokens || 0,
    maxWriters: fleet.maxWriters,
    maxScouts: fleet.maxScouts,
    slots: (fleet.slots || []).map(publicSlot),
    manifests: fleet.manifests || [],
    queue: (fleet.manifests || []).filter(item => (fleet.slots || []).some(s => s.taskId === item.taskId && s.status === 'queued')).map(item => item.taskId),
    mergeQueue: fleet.mergeQueue || [],
    merges: fleet.merges || [],
    verification: fleet.verification || null,
    alerts: fleet.alerts || []
  };
}

function stripJsonFence(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fenced ? fenced[1].trim() : raw;
}

function parsePlanJson(text) {
  const cleaned = stripJsonFence(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
}

function normalizeIdList(list, knownIds) {
  if (!Array.isArray(list)) return [];
  const map = new Map();
  knownIds.forEach(id => {
    map.set(id, id);
    const short = String(id).match(/_([ws])(\d+)$/);
    if (short) map.set(`${short[1]}${short[2]}`, id);
  });
  return list.map(item => String(item || '').trim())
    .map(item => map.get(item) || item)
    .filter(item => knownIds.includes(item));
}

function listProjectFiles(dir, limit = 240) {
  const out = [];
  const walk = (current, prefix, depth) => {
    if (out.length >= limit || depth > 3) return;
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (['node_modules', 'data', '.git', '.trae', 'dist', 'build'].includes(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel, depth + 1);
      else out.push(rel);
    }
  };
  walk(dir, '', 0);
  return out;
}

function gitApply(cwd, patch) {
  const result = spawnSync('git', ['apply', '--3way'], {
    cwd,
    input: patch,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60000
  });
  return {
    success: result.status === 0,
    output: String(result.stdout || ''),
    error: String(result.stderr || result.error?.message || '')
  };
}

function runCommand(cwd, command, timeoutMs = 10 * 60 * 1000) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs
  });
  return {
    success: result.status === 0,
    output: String(result.stdout || '').slice(-6000),
    error: String(result.stderr || result.error?.message || '')
  };
}

class AgentFleet {
  constructor(options = {}) {
    this.coding = options.coding;
    this.codingLoop = options.codingLoop;
    this.outputModule = options.outputModule;
    this.codingWorkers = options.codingWorkers || null;
    this.sandboxAgents = options.sandboxAgents || null;
    this.dataDir = options.dataDir || path.join(__dirname, '../../data/coding/fleets');
    this.pollMs = safeInt(options.pollMs, 100, 5000, DEFAULT_POLL_MS);
    this.maxDurationMs = safeInt(options.maxDurationMs, 60000, 24 * 60 * 60 * 1000, DEFAULT_MAX_DURATION_MS);
    this.apiChannel = String(options.apiChannel || 'deepseek');
    this.logger = options.logger || console;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.dispatchDesk = options.dispatchDesk || new DispatchDesk();
    this.scout = options.scout || new FleetScout({ outputModule: this.outputModule, apiChannel: this.apiChannel });
    this.services = options.services || {};
    this.fleets = new Map();
    this.timers = new Map();
    this.onEvent = null;
  }

  setEventNotifier(fn) {
    this.onEvent = typeof fn === 'function' ? fn : null;
  }

  fleetFile(fleetId) {
    return path.join(this.dataDir, `${String(fleetId || '')}.json`);
  }

  eventFile(fleetId) {
    return path.join(this.dataDir, String(fleetId || ''), 'events.jsonl');
  }

  emit(fleet, action, payload = {}) {
    const event = { type: `fleet-${action}`, fleetId: fleet.id, at: nowIso(), ...payload };
    try { appendJsonl(this.eventFile(fleet.id), event); } catch (error) {
      this.logger.warn(`[AgentFleet] 事件落盘失败：${error.message}`);
    }
    if (this.onEvent) {
      try { this.onEvent(event); } catch (error) {
        this.logger.warn(`[AgentFleet] 事件广播失败：${error.message}`);
      }
    }
  }

  persist(fleet) {
    fleet.updatedAt = nowIso();
    writeJsonAtomic(this.fleetFile(fleet.id), fleet);
  }

  load(fleetId) {
    const id = String(fleetId || '').trim();
    if (!id) return null;
    if (this.fleets.has(id)) return this.fleets.get(id);
    const data = readJson(this.fleetFile(id), null);
    if (!data) return null;
    this.fleets.set(id, data);
    return data;
  }

  // ---- 规划：只生成 manifest，不启动任何执行器 ----
  async plan(params = {}) {
    const userId = String(params.userId || '').trim();
    if (!userId) return { ok: false, error: '缺少 userId' };
    const goal = String(params.goal || '').trim();
    if (!goal) return { ok: false, error: '缺少 goal' };
    const writers = safeInt(params.writers, 1, 4, DEFAULT_WRITERS);
    const scouts = safeInt(params.scouts, 0, 12, DEFAULT_SCOUTS);
    if (writers + scouts > MAX_SLOTS) return { ok: false, error: `槽位最多 ${MAX_SLOTS} 个` };
    const sourceTaskId = this.coding.safeTaskId(params.sourceTaskId || '');
    if (params.sourceTaskId && !sourceTaskId) return { ok: false, error: 'sourceTaskId 非法' };
    if (sourceTaskId) {
      const dir = this.coding.taskDir(userId, sourceTaskId);
      if (!dir || !fs.existsSync(dir)) return { ok: false, error: `源工作区不存在：${sourceTaskId}` };
    }
    const tokenBudget = safeInt(params.tokenBudget, 10000, 2000000, DEFAULT_TOKEN_BUDGET);
    const stamp = `${this.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const fleetId = `fl_${stamp}`;
    const baseTaskId = `fleet_${fleetId}_base`;

    let planned;
    if (typeof this.services.plan === 'function') {
      planned = await this.services.plan({ userId, goal, sourceTaskId, writers, scouts });
    } else {
      planned = await this.planWithModel({ userId, goal, sourceTaskId, writers, scouts });
    }
    if (!planned || !Array.isArray(planned.writers) || !Array.isArray(planned.scouts)) {
      return { ok: false, error: planned?.error || '规划模型没有返回合法的 writers/scouts' };
    }
    if (planned.writers.length < writers || planned.scouts.length < scouts) {
      return {
        ok: false,
        error: `规划结果不完整：需要 ${writers} 写手 + ${scouts} 侦察，实际 ${planned.writers.length}+${planned.scouts.length}`
      };
    }

    const knownIds = [];
    for (let i = 1; i <= writers; i++) knownIds.push(`fleet_${fleetId}_w${i}`);
    for (let i = 1; i <= scouts; i++) knownIds.push(`fleet_${fleetId}_s${i}`);

    const manifests = [];
    const makeManifest = (raw, index, role) => {
      const prefix = role === 'writer' ? 'w' : 's';
      const taskId = `fleet_${fleetId}_${prefix}${index}`;
      const normalized = normalizeManifest({
        ...raw,
        fleetId,
        taskId,
        agentId: `${prefix}${index}`,
        role,
        goal: String(raw.goal || goal).trim(),
        dependsOn: normalizeIdList(raw.dependsOn, knownIds)
      }, { workspaceKey: baseTaskId, isAllowedCommand: this.services.isAllowedCommand });
      if (!normalized.ok) {
        return { error: `${taskId}：${normalized.errors.join('；')}` };
      }
      return { manifest: normalized.manifest };
    };
    for (let i = 0; i < writers; i++) {
      const made = makeManifest(planned.writers[i], i + 1, 'writer');
      if (made.error) return { ok: false, error: made.error };
      manifests.push(made.manifest);
    }
    for (let i = 0; i < scouts; i++) {
      const made = makeManifest(planned.scouts[i], i + 1, 'scout');
      if (made.error) return { ok: false, error: made.error };
      manifests.push(made.manifest);
    }

    const fleet = {
      id: fleetId,
      userId,
      goal,
      sourceTaskId,
      baseTaskId,
      baseSha: '',
      status: 'planned',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: '',
      finishedAt: '',
      tokenBudget,
      usedTokens: 0,
      maxWriters: writers,
      maxScouts: scouts,
      manifests,
      slots: manifests.map(item => ({
        agentId: item.agentId,
        role: item.role,
        taskId: item.taskId,
        status: 'idle',
        runId: '',
        error: '',
        findings: '',
        usage: 0,
        startedAt: '',
        finishedAt: ''
      })),
      mergeQueue: [],
      merges: [],
      verification: null,
      alerts: []
    };
    this.fleets.set(fleetId, fleet);
    this.persist(fleet);
    this.emit(fleet, 'planned', { slots: fleet.slots.length });
    return { ok: true, fleet: publicFleet(fleet), manifests };
  }

  async planWithModel({ userId, goal, sourceTaskId, writers, scouts }) {
    if (!this.outputModule || typeof this.outputModule.callModelOnce !== 'function') {
      return { error: 'outputModule.callModelOnce 不可用' };
    }
    const sourceDir = sourceTaskId ? this.coding.taskDir(userId, sourceTaskId) : '';
    const files = sourceDir && fs.existsSync(sourceDir) ? listProjectFiles(sourceDir) : [];
    const prompt = [
      '你是编程沙箱集群的规划中枢。把目标拆成 4 个写手 + 12 个只读侦察的子任务。',
      '只能输出 JSON，不要解释，不要 Markdown 代码块。结构：',
      '{"writers":[{"goal":"...","reads":["..."],"writes":["..."],"exclusive":[],"commands":[],"dependsOn":[]}],"scouts":[{"goal":"...","reads":["..."]}]}',
      '硬性规则：',
      '1) 写手 writes 必须是相对路径，且每个写手写集互不相交；',
      '2) 写手 reads/writes 只能来自给定文件清单，不要编造路径；',
      '3) 侦察只填 goal + reads，不填 writes/commands；',
      '4) dependsOn 只能引用 w1..w4 / s1..s12；',
      '5) 每个写手至少 1 个 writes；commands 只写测试命令，可留空。',
      `写手数量：${writers}；侦察数量：${scouts}。`,
      `目标：${goal}`,
      `文件清单：\n${files.length ? files.join('\n') : '（没有源工作区，按目标给出最小必要相对路径）'}`
    ].join('\n');
    const messages = [
      { role: 'system', content: '你只输出一个合法 JSON 对象；任何多余文字都会导致解析失败。' },
      { role: 'user', content: prompt }
    ];
    try {
      const result = await this.outputModule.callModelOnce(messages, [], null, {
        apiChannel: this.apiChannel,
        forceThinking: 'disabled',
        temperature: 0.1,
        maxTokens: 5000,
        stream: false
      });
      const text = result?.choices?.[0]?.message?.content || '';
      const parsed = parsePlanJson(text);
      if (!parsed) return { error: '规划结果不是合法 JSON' };
      return {
        writers: Array.isArray(parsed.writers) ? parsed.writers : [],
        scouts: Array.isArray(parsed.scouts) ? parsed.scouts : []
      };
    } catch (error) {
      return { error: `规划模型调用失败：${error.message}` };
    }
  }

  // ---- 派发：建基座、复制写手工作区、接线、启动 ----
  async dispatch(params = {}) {
    const userId = String(params.userId || '').trim();
    const fleet = this.load(params.fleetId);
    if (!fleet) return { ok: false, error: '集群不存在' };
    if (fleet.userId !== userId) return { ok: false, error: '无权操作该集群' };
    if (fleet.status !== 'planned' && fleet.status !== 'paused') {
      return { ok: false, error: `集群当前状态 ${fleet.status}，不能派发` };
    }
    if (fleet.status === 'paused') {
      fleet.status = 'planned';
    }

    const busy = this.sourceBusy(fleet);
    if (busy) return { ok: false, error: busy };

    if (Array.isArray(params.manifests)) {
      const byTask = new Map(params.manifests.filter(Boolean).map(item => [String(item.taskId || ''), item]));
      fleet.manifests = fleet.manifests.map(existing => {
        const override = byTask.get(existing.taskId);
        if (!override) return existing;
        const normalized = normalizeManifest({
          ...existing,
          ...override,
          fleetId: fleet.id,
          taskId: existing.taskId,
          agentId: existing.agentId,
          role: existing.role,
          dependsOn: normalizeIdList(override.dependsOn, fleet.manifests.map(item => item.taskId))
        }, { workspaceKey: fleet.baseTaskId, isAllowedCommand: this.services.isAllowedCommand });
        return normalized.ok ? normalized.manifest : existing;
      });
    }

    const provision = await this.provisionWorkspaces(fleet);
    if (!provision.ok) {
      fleet.status = 'failed';
      fleet.finishedAt = nowIso();
      this.persist(fleet);
      return { ok: false, error: provision.error };
    }
    const baseDir = this.coding.taskDir(fleet.userId, fleet.baseTaskId);
    const validationErrors = [];
    fleet.manifests.forEach(manifest => {
      const checked = validateManifest(manifest, {
        workspaceDir: baseDir,
        knownManifests: fleet.manifests,
        baseSha: fleet.baseSha
      });
      if (!checked.ok) validationErrors.push(`${manifest.taskId}：${checked.errors.join('；')}`);
    });
    if (validationErrors.length) {
      fleet.status = 'failed';
      fleet.alerts = validationErrors;
      this.persist(fleet);
      return { ok: false, error: 'manifest 校验失败', errors: validationErrors };
    }

    fleet.status = 'running';
    fleet.startedAt = nowIso();
    fleet.usedTokens = 0;
    fleet.mergeQueue = [];
    fleet.merges = [];
    fleet.verification = null;
    fleet.alerts = [];
    fleet.slots = fleet.manifests.map(item => ({
      agentId: item.agentId,
      role: item.role,
      taskId: item.taskId,
      status: 'idle',
      runId: '',
      error: '',
      findings: '',
      usage: 0,
      startedAt: '',
      finishedAt: ''
    }));
    this.persist(fleet);
    this.emit(fleet, 'dispatched', { baseTaskId: fleet.baseTaskId, baseSha: fleet.baseSha });

    const monitor = new FleetMonitor({
      desk: this.dispatchDesk,
      intervalMs: 5000,
      inspect: (lease) => this.inspectLease(fleet, lease),
      onViolation: (lease, violations) => this.handleViolation(fleet, lease, violations),
      onExpired: (lease) => this.handleExpired(fleet, lease),
      onHeartbeat: (lease) => {
        const slot = this.slotOf(fleet, lease.taskId);
        if (slot) slot.heartbeatAt = nowIso();
      },
      logger: this.logger
    });
    monitor.start();
    this.timers.set(fleet.id, monitor);

    setImmediate(() => {
      this.runFleet(fleet).catch(error => {
        this.logger.error(`[AgentFleet] 集群异常：${error.message}`);
        fleet.status = 'failed';
        fleet.alerts.push(error.message);
        fleet.finishedAt = nowIso();
        this.persist(fleet);
        this.stopMonitor(fleet.id);
      });
    });
    return { ok: true, fleet: publicFleet(fleet) };
  }

  sourceBusy(fleet) {
    const sourceTaskId = fleet.sourceTaskId;
    if (!sourceTaskId) return '';
    try {
      const workerStatus = this.codingWorkers && typeof this.codingWorkers.status === 'function'
        ? this.codingWorkers.status()
        : null;
      const workers = (workerStatus && Array.isArray(workerStatus.workers)) ? workerStatus.workers : [];
      if (workers.some(item => item && (item.boardTaskId === sourceTaskId || item.runTaskId === sourceTaskId))) {
        return `源工作区正被工人池执行：${sourceTaskId}`;
      }
    } catch { /* 工人池状态不可用时不阻塞，交给后续锁兜底 */ }
    try {
      if (this.sandboxAgents && typeof this.sandboxAgents.runningRuns === 'function') {
        const runs = this.sandboxAgents.runningRuns();
        if (Array.isArray(runs) && runs.some(run => run && run.taskId === sourceTaskId)) {
          return `源工作区正被 Claude Code 占用：${sourceTaskId}`;
        }
      }
    } catch { /* 同上 */ }
    return '';
  }

  async provisionWorkspaces(fleet) {
    const coding = this.coding;
    if (typeof this.services.provisionWorkspaces === 'function') {
      return this.services.provisionWorkspaces(fleet);
    }
    let base;
    if (fleet.sourceTaskId) {
      base = copyTaskWorkspace(coding, fleet.userId, fleet.sourceTaskId, fleet.baseTaskId);
    } else {
      base = coding.createWorkspace(fleet.userId, fleet.baseTaskId);
    }
    if (!base.success) return { ok: false, error: base.error || '基座创建失败' };
    const ensure = coding.createWorkspace(fleet.userId, fleet.baseTaskId);
    if (!ensure.success) return { ok: false, error: ensure.error };
    const head = coding.git(fleet.userId, fleet.baseTaskId, ['rev-parse', 'HEAD']);
    if (!head.success) return { ok: false, error: `基座没有可用 HEAD：${head.error}` };
    fleet.baseSha = String(head.output || '').trim();
    fleet.manifests.forEach(manifest => {
      manifest.baseSha = fleet.baseSha;
    });

    const writerManifests = fleet.manifests.filter(item => item.role === 'writer');
    for (const manifest of writerManifests) {
      const copied = copyTaskWorkspace(coding, fleet.userId, fleet.baseTaskId, manifest.taskId);
      if (!copied.success) return { ok: false, error: copied.error || `复制写手工作区失败：${manifest.taskId}` };
      const ready = coding.createWorkspace(fleet.userId, manifest.taskId);
      if (!ready.success) return { ok: false, error: ready.error || `写手工作区不可用：${manifest.taskId}` };
      if (typeof coding.setTrustLevel === 'function') {
        coding.setTrustLevel(fleet.userId, manifest.taskId, 'auto');
      }
    }
    return { ok: true };
  }

  slotOf(fleet, taskId) {
    return (fleet.slots || []).find(slot => slot.taskId === taskId) || null;
  }

  manifestOf(fleet, taskId) {
    return (fleet.manifests || []).find(item => item.taskId === taskId) || null;
  }

  async runFleet(fleet) {
    const started = this.now();
    // finishedAt 一旦落定（收尾/停止），循环必须退出；budget_exhausted 仍留在循环里，
    // 是为了让「已跑的写手先合并完再收尾」，但收尾后不能继续空转。
    while (!fleet.finishedAt && ['running', 'paused', 'pausing', 'budget_exhausted'].includes(fleet.status)) {
      if (this.now() - started > this.maxDurationMs) {
        fleet.alerts.push('集群超过最长运行时间，已自动停止');
        await this.stop(fleet.id, fleet.userId);
        break;
      }
      await this.step(fleet);
      await delay(this.pollMs);
    }
  }

  async step(fleet) {
    if (fleet.stepping) return;
    fleet.stepping = true;
    try {
      this.refreshWriterStatuses(fleet);
      this.updateBudget(fleet);
      if (fleet.status === 'paused') {
        this.persist(fleet);
        return;
      }
      if (fleet.status === 'budget_exhausted') {
        this.markPending(fleet, 'budget_exhausted', '全局 token 预算耗尽');
      }
      this.tryDispatch(fleet);
      await this.processMergeQueue(fleet);
      if (['running', 'budget_exhausted'].includes(fleet.status) && this.isFinished(fleet)) {
        await this.finish(fleet);
      }
      this.persist(fleet);
    } finally {
      fleet.stepping = false;
    }
  }

  refreshWriterStatuses(fleet) {
    (fleet.slots || []).filter(slot => slot.role === 'writer' && slot.status === 'running').forEach(slot => {
      const run = this.codingLoop && typeof this.codingLoop.latestRun === 'function'
        ? this.codingLoop.latestRun(slot.taskId)
        : null;
      if (!run) return;
      slot.usage = usageBilled(run);
      slot.runId = run.id || slot.runId;
      if (!TERMINAL_STATUS.has(run.status)) return;
      this.dispatchDesk.releaseAll({ fleetId: fleet.id, taskId: slot.taskId });
      slot.finishedAt = nowIso();
      if (run.status === 'passed') {
        slot.status = 'merging';
        if (!fleet.mergeQueue.includes(slot.taskId)) fleet.mergeQueue.push(slot.taskId);
        this.emit(fleet, 'writer_passed', { taskId: slot.taskId, agentId: slot.agentId });
      } else {
        slot.status = run.status === 'stopped' ? 'stopped' : 'failed';
        slot.error = run.error || `闭环结束：${run.status}`;
        this.emit(fleet, 'writer_failed', { taskId: slot.taskId, agentId: slot.agentId, error: slot.error });
      }
    });
  }

  updateBudget(fleet) {
    const writerUsage = (fleet.slots || [])
      .filter(slot => slot.role === 'writer')
      .reduce((sum, slot) => sum + (Number(slot.usage) || 0), 0);
    const scoutUsage = (fleet.slots || [])
      .filter(slot => slot.role === 'scout')
      .reduce((sum, slot) => sum + (Number(slot.usage) || 0), 0);
    fleet.usedTokens = writerUsage + scoutUsage;
    if (fleet.tokenBudget > 0 && fleet.usedTokens >= fleet.tokenBudget && fleet.status === 'running') {
      fleet.status = 'budget_exhausted';
      this.emit(fleet, 'budget_exhausted', { usedTokens: fleet.usedTokens, tokenBudget: fleet.tokenBudget });
    }
  }

  tryDispatch(fleet) {
    if (fleet.status !== 'running') return;
    const doneIds = new Set((fleet.slots || []).filter(slot => slot.status === 'done' || slot.status === 'merged').map(slot => slot.taskId));
    const pending = (fleet.slots || []).filter(slot => ['idle', 'queued', 'blocked'].includes(slot.status));
    for (const slot of pending) {
      if (fleet.status !== 'running') break;
      const manifest = this.manifestOf(fleet, slot.taskId);
      if (!manifest) continue;
      const depSlots = (manifest.dependsOn || []).map(dep => this.slotOf(fleet, dep)).filter(Boolean);
      const waiting = depSlots.filter(dep => !doneIds.has(dep.taskId));
      if (waiting.length) {
        const failedDep = waiting.find(dep => ['failed', 'stopped', 'conflict', 'violated', 'stalled', 'budget_exhausted'].includes(dep.status));
        slot.status = 'blocked';
        slot.error = failedDep
          ? `依赖 ${failedDep.taskId} 未成功（${failedDep.status}），不再派发`
          : `等待依赖：${waiting.map(dep => dep.taskId).join('、')}`;
        continue;
      }
      const admitted = this.dispatchDesk.admit(manifest, {
        workspaceDir: this.coding.taskDir(fleet.userId, fleet.baseTaskId),
        knownManifests: fleet.manifests,
        baseSha: fleet.baseSha
      });
      if (!admitted.ok) {
        if (admitted.code === 'conflict') {
          slot.status = 'queued';
          slot.error = admitted.conflicts.map(item => `${item.kind}:${item.path}`).join('；');
          continue;
        }
        slot.status = 'failed';
        slot.error = (admitted.errors || ['接线被拒']).join('；');
        this.emit(fleet, 'dispatch_denied', { taskId: slot.taskId, errors: admitted.errors, conflicts: admitted.conflicts });
        continue;
      }
      this.emit(fleet, 'lease_granted', { taskId: slot.taskId, leaseId: admitted.lease.leaseId });
      if (manifest.role === 'writer') this.startWriter(fleet, slot, manifest, admitted.lease);
      else this.startScout(fleet, slot, manifest, admitted.lease);
    }
  }

  startWriter(fleet, slot, manifest, lease) {
    const started = this.codingLoop.start({
      userId: fleet.userId,
      taskId: manifest.taskId,
      goal: manifest.goal,
      passCommand: (manifest.commands || [])[0] || '',
      tokenBudget: manifest.tokenBudget,
      maxIterations: 12,
      timeoutMs: 45 * 60 * 1000,
      model: this.apiChannel,
      thinking: 'disabled',
      policy: { maxWrites: Math.max(2, manifest.writes.length * 2), maxReads: 40 },
      requireChange: true,
      writePlan: false,
      toolAllowlist: WRITER_TOOLS
    });
    if (!started.success) {
      this.dispatchDesk.release(lease.leaseId);
      slot.status = 'failed';
      slot.error = started.error || '写手启动失败';
      slot.finishedAt = nowIso();
      this.emit(fleet, 'writer_start_failed', { taskId: slot.taskId, error: slot.error });
      return;
    }
    slot.status = 'running';
    slot.startedAt = nowIso();
    slot.runId = started.run?.id || '';
    this.emit(fleet, 'writer_started', { taskId: slot.taskId, agentId: slot.agentId, runId: slot.runId });
  }

  startScout(fleet, slot, manifest, lease) {
    if (!this.scout || typeof this.scout.run !== 'function') {
      this.dispatchDesk.release(lease.leaseId);
      slot.status = 'failed';
      slot.error = '侦察执行器不可用';
      slot.finishedAt = nowIso();
      return;
    }
    slot.status = 'running';
    slot.startedAt = nowIso();
    this.emit(fleet, 'scout_started', { taskId: slot.taskId, agentId: slot.agentId });
    // 「暂停」只停派发、不杀在跑节点：侦察要能跑到收尾；只有停止/收尾才中断。
    const shouldStop = () => !!fleet.finishedAt
      || ['running', 'paused', 'pausing', 'budget_exhausted'].indexOf(fleet.status) < 0;
    this.scout.run(manifest, {
      userId: fleet.userId,
      baseTaskId: fleet.baseTaskId,
      shouldStop,
      onUsage: (used) => { slot.usage = used; },
      onEvent: (event) => this.emit(fleet, 'scout_event', { taskId: slot.taskId, event })
    }).then(result => {
      this.dispatchDesk.release(lease.leaseId);
      slot.finishedAt = nowIso();
      slot.usage = result.usage || slot.usage;
      if (result.ok) {
        slot.status = 'done';
        slot.findings = result.findings || '';
        this.emit(fleet, 'scout_done', { taskId: slot.taskId, agentId: slot.agentId, usage: slot.usage });
      } else {
        slot.status = 'failed';
        slot.error = result.error || '侦察失败';
        this.emit(fleet, 'scout_failed', { taskId: slot.taskId, agentId: slot.agentId, error: slot.error });
      }
    }).catch(error => {
      this.dispatchDesk.release(lease.leaseId);
      slot.status = 'failed';
      slot.error = error.message;
      slot.finishedAt = nowIso();
      this.emit(fleet, 'scout_failed', { taskId: slot.taskId, agentId: slot.agentId, error: slot.error });
    });
  }

  async processMergeQueue(fleet) {
    if (fleet.mergeBusy || !fleet.mergeQueue.length) return;
    fleet.mergeBusy = true;
    try {
      while (fleet.mergeQueue.length) {
        const taskId = fleet.mergeQueue.shift();
        const slot = this.slotOf(fleet, taskId);
        const manifest = this.manifestOf(fleet, taskId);
        if (!slot || !manifest) continue;
        const result = await this.mergeWriter(fleet, manifest);
        fleet.merges.push({ taskId, at: nowIso(), ...result });
        if (result.ok) {
          slot.status = 'merged';
          slot.finishedAt = nowIso();
          if (result.baseSha) fleet.baseSha = result.baseSha;
          this.emit(fleet, 'merged', { taskId, baseSha: fleet.baseSha });
        } else {
          slot.status = 'conflict';
          slot.error = result.error || '合并失败';
          this.emit(fleet, 'merge_conflict', { taskId, error: slot.error });
        }
        this.persist(fleet);
      }
    } finally {
      fleet.mergeBusy = false;
    }
  }

  async mergeWriter(fleet, manifest) {
    if (typeof this.services.mergeWriter === 'function') {
      return this.services.mergeWriter(fleet, manifest);
    }
    const writerDir = this.coding.taskDir(fleet.userId, manifest.taskId);
    const baseDir = this.coding.taskDir(fleet.userId, fleet.baseTaskId);
    if (!writerDir || !baseDir) return { ok: false, error: '工作区路径非法' };
    this.coding.git(fleet.userId, manifest.taskId, ['add', '-A', '-N']);
    const diff = this.coding.git(fleet.userId, manifest.taskId, [
      'diff', manifest.baseSha, '--', ...manifest.writes
    ]);
    if (!diff.success) return { ok: false, error: diff.error || '生成 diff 失败' };
    const patch = String(diff.output || '');
    if (!patch.trim()) return { ok: false, error: '写手没有产生声明路径的改动' };
    const applied = gitApply(baseDir, patch);
    if (!applied.success) return { ok: false, error: applied.error || 'git apply --3way 失败' };
    const add = this.coding.git(fleet.userId, fleet.baseTaskId, ['add', '-A']);
    if (!add.success) return { ok: false, error: add.error || '基座 git add 失败' };
    const commit = this.coding.gitCommit(fleet.userId, fleet.baseTaskId, `fleet merge ${manifest.taskId}`);
    if (!commit.success) return { ok: false, error: commit.error || '基座提交失败' };
    const head = this.coding.git(fleet.userId, fleet.baseTaskId, ['rev-parse', 'HEAD']);
    return { ok: true, baseSha: head.success ? String(head.output || '').trim() : '', patchBytes: patch.length };
  }

  inspectLease(fleet, lease) {
    if (!lease || lease.role !== 'writer') return { heartbeat: true, changedPaths: [] };
    const changed = this.coding.git(fleet.userId, lease.taskId, ['diff', '--name-only']);
    const untracked = this.coding.git(fleet.userId, lease.taskId, ['ls-files', '--others', '--exclude-standard']);
    return {
      heartbeat: true,
      changedPaths: [
        ...String(changed.output || '').split(/\r?\n/),
        ...String(untracked.output || '').split(/\r?\n/)
      ].filter(Boolean)
    };
  }

  handleViolation(fleet, lease, violations) {
    const slot = this.slotOf(fleet, lease.taskId);
    if (this.codingLoop && typeof this.codingLoop.stop === 'function') this.codingLoop.stop(lease.taskId);
    try {
      this.coding.git(fleet.userId, lease.taskId, ['reset', '--hard', lease.baseSha || 'HEAD']);
      this.coding.git(fleet.userId, lease.taskId, ['clean', '-fd']);
    } catch { /* 回滚失败不阻塞告警 */ }
    if (slot) {
      slot.status = 'violated';
      slot.error = `越界写：${violations.join('、')}`;
      slot.finishedAt = nowIso();
    }
    fleet.alerts.push(`写手 ${lease.agentId} 越界写：${violations.join('、')}`);
    this.emit(fleet, 'violation', { taskId: lease.taskId, agentId: lease.agentId, paths: violations });
  }

  handleExpired(fleet, lease) {
    const slot = this.slotOf(fleet, lease.taskId);
    if (this.codingLoop && typeof this.codingLoop.stop === 'function') this.codingLoop.stop(lease.taskId);
    if (slot) {
      slot.status = 'stalled';
      slot.error = '租约心跳超时';
      slot.finishedAt = nowIso();
    }
    fleet.alerts.push(`槽位 ${lease.agentId} 租约超时`);
    this.emit(fleet, 'lease_expired', { taskId: lease.taskId, agentId: lease.agentId });
  }

  markPending(fleet, status, reason) {
    (fleet.slots || []).forEach(slot => {
      if (slot.status === 'idle' || slot.status === 'queued' || slot.status === 'blocked') {
        slot.status = status;
        slot.error = reason;
        slot.finishedAt = nowIso();
      }
    });
  }

  isFinished(fleet) {
    const active = (fleet.slots || []).some(slot => ['idle', 'queued', 'running', 'merging'].includes(slot.status));
    return !active && !fleet.mergeQueue.length && !fleet.mergeBusy;
  }

  async verifyMerged(fleet) {
    if (typeof this.services.verifyMerged === 'function') {
      return this.services.verifyMerged(fleet);
    }
    const baseDir = this.coding.taskDir(fleet.userId, fleet.baseTaskId);
    if (!baseDir) return { ok: false, checks: [], error: '基座工作区不存在' };
    const commands = Array.from(new Set((fleet.manifests || [])
      .filter(item => item.role === 'writer')
      .flatMap(item => item.commands || [])));
    const checks = [];
    if (!commands.length) {
      const diffCheck = this.coding.git(fleet.userId, fleet.baseTaskId, ['diff', '--check', 'HEAD']);
      checks.push({ command: 'git diff --check', ok: diffCheck.success, output: String(diffCheck.error || diffCheck.output || '').slice(-1000) });
      return { ok: diffCheck.success, checks };
    }
    for (const command of commands) {
      const result = runCommand(baseDir, command);
      checks.push({ command, ok: result.success, output: `${result.output}${result.error ? `\n${result.error}` : ''}`.slice(-2000) });
      if (!result.success) return { ok: false, checks };
    }
    return { ok: true, checks };
  }

  async finish(fleet) {
    const verification = await this.verifyMerged(fleet);
    fleet.verification = verification;
    const failed = (fleet.slots || []).filter(slot => ['failed', 'violated', 'stalled', 'conflict', 'budget_exhausted'].includes(slot.status));
    if (!verification.ok) fleet.alerts.push('合并后验收未通过');
    // 预算熔断是「主动停机」而非正常收尾：收尾可以跑，但终态要保留 budget_exhausted，
    // 否则 UI 会把它显示成 done/partial，掩盖「还有槽位没派发」这一事实。
    fleet.status = fleet.status === 'budget_exhausted'
      ? 'budget_exhausted'
      : ((failed.length || !verification.ok) ? 'partial' : 'done');
    fleet.finishedAt = nowIso();
    this.stopMonitor(fleet.id);
    this.dispatchDesk.releaseAll({ fleetId: fleet.id });
    if (this.scout && typeof this.scout.stopAll === 'function') this.scout.stopAll();
    this.persist(fleet);
    this.emit(fleet, 'finished', {
      status: fleet.status,
      failed: failed.length,
      usedTokens: fleet.usedTokens,
      verification: verification.ok
    });
  }

  stopMonitor(fleetId) {
    const monitor = this.timers.get(fleetId);
    if (monitor) monitor.stop();
    this.timers.delete(fleetId);
  }

  async stop(fleetId, userId) {
    const fleet = this.load(fleetId);
    if (!fleet) return { ok: false, error: '集群不存在' };
    if (userId && fleet.userId !== String(userId)) return { ok: false, error: '无权操作该集群' };
    fleet.status = 'stopped';
    (fleet.slots || []).forEach(slot => {
      if (['idle', 'queued', 'blocked', 'running', 'merging'].includes(slot.status)) {
        slot.status = 'stopped';
        slot.finishedAt = nowIso();
      }
      if (slot.role === 'writer' && this.codingLoop && typeof this.codingLoop.stop === 'function') {
        this.codingLoop.stop(slot.taskId);
      }
    });
    if (this.scout && typeof this.scout.stopAll === 'function') this.scout.stopAll();
    this.stopMonitor(fleet.id);
    this.dispatchDesk.releaseAll({ fleetId: fleet.id });
    fleet.finishedAt = nowIso();
    this.persist(fleet);
    this.emit(fleet, 'stopped', {});
    return { ok: true, fleet: publicFleet(fleet) };
  }

  pause(fleetId, userId) {
    const fleet = this.load(fleetId);
    if (!fleet) return { ok: false, error: '集群不存在' };
    if (userId && fleet.userId !== String(userId)) return { ok: false, error: '无权操作该集群' };
    if (fleet.status !== 'running') return { ok: false, error: `集群当前状态 ${fleet.status}` };
    fleet.status = 'paused';
    this.persist(fleet);
    this.emit(fleet, 'paused', {});
    return { ok: true, fleet: publicFleet(fleet) };
  }

  resume(fleetId, userId) {
    const fleet = this.load(fleetId);
    if (!fleet) return { ok: false, error: '集群不存在' };
    if (userId && fleet.userId !== String(userId)) return { ok: false, error: '无权操作该集群' };
    if (fleet.status !== 'paused') return { ok: false, error: `集群当前状态 ${fleet.status}` };
    fleet.status = 'running';
    this.persist(fleet);
    this.emit(fleet, 'resumed', {});
    return { ok: true, fleet: publicFleet(fleet) };
  }

  status(fleetId, userId) {
    const fleet = this.load(fleetId);
    if (!fleet) return { ok: false, error: '集群不存在' };
    if (userId && fleet.userId !== String(userId)) return { ok: false, error: '无权操作该集群' };
    return { ok: true, fleet: publicFleet(fleet) };
  }

  list(userId) {
    const owner = String(userId || '').trim();
    let files = [];
    try { files = fs.readdirSync(this.dataDir).filter(name => name.endsWith('.json') && !name.endsWith('.tmp')); } catch { return { ok: true, fleets: [] }; }
    const fleets = [];
    files.forEach(name => {
      const data = readJson(path.join(this.dataDir, name), null);
      if (data && data.id && (!owner || data.userId === owner)) fleets.push(publicFleet(data));
    });
    fleets.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { ok: true, fleets: fleets.slice(0, 20) };
  }
}

function createAgentFleet(options) {
  return new AgentFleet(options);
}

module.exports = {
  AgentFleet,
  createAgentFleet,
  WRITER_TOOLS,
  DEFAULT_WRITERS,
  DEFAULT_SCOUTS,
  DEFAULT_TOKEN_BUDGET
};
