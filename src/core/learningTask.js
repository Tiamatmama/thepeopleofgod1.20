'use strict';

// 🌱 学习任务：把「取数 → 分析 / 训练 → 沉淀」表达成一次受管任务。
// 只认白名单公开数据源；执行前过资源闸；产物必须带 manifest 才留存。
// 详细设计见 docs/superpowers/specs/2026-11-06-self-evolution-learning-design.md

const fs = require('fs');
const path = require('path');
const { ResourceGuard, DEFAULT_BUCKETS } = require('./resourceGuard');
const { LearningStore, newId } = require('./learningStore');
const { getTimeline } = require('./timeline');

const TASK_KINDS = new Set(['dataset', 'analysis', 'train', 'tool']);
const MAX_SCRIPT_CHARS = 20000;
const MAX_GOAL_CHARS = 500;
const DEFAULT_ESTIMATED_BYTES = 64 * 1024 * 1024;

// 白名单只到「主机 + 路径前缀」：公开数据集页与 raw 文件，其余一律拒绝
const SOURCE_RULES = [
  { host: 'huggingface.co', prefix: '/datasets' },
  { host: 'www.kaggle.com', prefix: '/datasets' },
  { host: 'kaggle.com', prefix: '/datasets' },
  { host: 'archive.ics.uci.edu', prefix: '/' },
  { host: 'raw.githubusercontent.com', prefix: '/' }
];

// 解释器钉死 3.10.11：PATH 里的 python 是另一个版本且没有 torch，不能依赖
const PYTHON_CANDIDATES = [
  process.env.POG_PYTHON_PATH,
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python310\\python.exe` : null,
  '/usr/bin/python3.10'
].filter(Boolean);

function resolvePython() {
  for (const candidate of PYTHON_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 单个候选不可访问就继续看下一个
    }
  }
  return process.env.POG_PYTHON_PATH || 'python';
}

function validateSource(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    return { ok: false, reason: 'URL 格式不合法' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, reason: '只允许 https' };
  if (parsed.username || parsed.password) return { ok: false, reason: 'URL 不能带凭据' };
  const host = parsed.hostname.toLowerCase();
  const pathName = parsed.pathname || '/';
  const rule = SOURCE_RULES.find((item) => item.host === host);
  if (!rule) return { ok: false, reason: `来源不在白名单: ${host}` };
  const prefix = rule.prefix;
  const matched = prefix === '/'
    ? true
    : pathName === prefix || pathName.startsWith(`${prefix}/`);
  if (!matched) return { ok: false, reason: `该来源只允许 ${prefix} 路径` };
  return { ok: true, host, normalized: parsed.toString() };
}

function validateRequest(input = {}) {
  const errors = [];

  const goal = String(input.goal || '').trim();
  if (!goal) errors.push('goal 必填');
  else if (goal.length > MAX_GOAL_CHARS) errors.push(`goal 不能超过 ${MAX_GOAL_CHARS} 字`);

  const kind = String(input.kind || 'analysis').toLowerCase();
  if (!TASK_KINDS.has(kind)) errors.push(`kind 必须是 ${[...TASK_KINDS].join(' / ')}`);

  const rawSources = Array.isArray(input.sources)
    ? input.sources
    : (input.sources ? [input.sources] : []);
  if (!rawSources.length) errors.push('sources 至少 1 条');
  if (rawSources.length > 10) errors.push('sources 最多 10 条');
  const sources = [];
  for (const url of rawSources) {
    const result = validateSource(url);
    if (!result.ok) errors.push(`${String(url)}: ${result.reason}`);
    else sources.push(result.normalized);
  }

  const script = typeof input.script === 'string' ? input.script : '';
  if (script.length > MAX_SCRIPT_CHARS) errors.push(`script 不能超过 ${MAX_SCRIPT_CHARS} 字符`);

  let estimatedBytes = Number(input.estimatedBytes);
  if (!Number.isFinite(estimatedBytes) || estimatedBytes <= 0) estimatedBytes = DEFAULT_ESTIMATED_BYTES;
  if (estimatedBytes > DEFAULT_BUCKETS.datasets) errors.push('estimatedBytes 超过 datasets 桶上限');

  const license = String(input.license || '').trim();
  const retain = input.retain === true;
  if (retain) {
    if (!license) errors.push('retain=true 时必须提供 license');
    if (!script) errors.push('retain=true 时必须有可复现脚本');
  }

  const title = String(input.title || goal).trim().slice(0, 120);
  return {
    ok: errors.length === 0,
    errors,
    plan: { title, goal, kind, sources, script, estimatedBytes, license, retain }
  };
}

class LearningTaskCenter {
  constructor(options = {}) {
    this.root = options.root || path.join(__dirname, '..', '..', 'data', 'learn');
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.guard = options.guard || new ResourceGuard({ root: this.root, now: this.now });
    this.store = options.store || new LearningStore({ root: this.root, now: this.now });
    this.sandbox = options.sandbox || null;
    this.python = options.pythonPath || resolvePython();
    this.executor = typeof options.executor === 'function' ? options.executor : null;
    this.timeline = options.timeline === undefined ? null : options.timeline;
    this.timelineScope = options.timelineScope || 'learning';
    this.watchdogMs = Number.isFinite(options.watchdogMs) ? options.watchdogMs : 15000;
    this._watchdogTimer = null;
    this.tasksDir = path.join(this.root, 'tasks');
    this.workspaceDir = path.join(this.root, 'workspace');
    this.datasetsDir = path.join(this.root, 'datasets');
  }

  _timeline() {
    if (this.timeline) return this.timeline;
    try {
      return getTimeline();
    } catch {
      return null;
    }
  }

  _emit(type, payload) {
    const timeline = this._timeline();
    if (!timeline || typeof timeline.append !== 'function') return;
    timeline.append(this.timelineScope, type, payload, { now: this.now() });
  }

  ensureDirs() {
    this.guard.ensureDirs();
    this.store.ensure();
    for (const dir of [this.tasksDir, this.workspaceDir, this.datasetsDir]) {
      this.fsMkdir(dir);
    }
  }

  fsMkdir(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // 目录已存在或暂时不可写：真正写入时再报错
    }
  }

  _taskFile(id) {
    if (!/^[a-z0-9][a-z0-9-]{5,79}$/i.test(String(id || ''))) return null;
    return path.join(this.tasksDir, `${id}.json`);
  }

  _saveTask(task) {
    this.fsMkdir(this.tasksDir);
    const file = this._taskFile(task.id);
    if (!file) return false;
    try {
      fs.writeFileSync(file, JSON.stringify(task, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  _loadTask(id) {
    const file = this._taskFile(id);
    if (!file) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && typeof data === 'object' ? data : null;
    } catch {
      return null;
    }
  }

  _update(id, patch) {
    const task = this._loadTask(id);
    if (!task) return null;
    const next = { ...task, ...patch, updatedAt: this.now() };
    this._saveTask(next);
    return next;
  }

  // 创建计划：只校验与落盘，不执行。配额不够时直接拒绝，不建半成品任务。
  create(input = {}) {
    const checked = validateRequest(input);
    if (!checked.ok) return { success: false, error: '任务参数不合法', errors: checked.errors };

    const plan = checked.plan;
    const disk = this.guard.checkDisk('datasets', plan.estimatedBytes);
    if (!disk.ok) {
      return {
        success: false,
        error: '磁盘配额不足，任务未创建',
        reason: disk.reason,
        disk: disk.usage
      };
    }

    const id = newId(this.now());
    const task = {
      id,
      ...plan,
      status: 'planned',
      createdAt: this.now(),
      updatedAt: this.now(),
      startedAt: 0,
      finishedAt: 0,
      result: null
    };
    if (!this._saveTask(task)) return { success: false, error: '任务落盘失败' };
    this._emit('learning.task', { taskId: id, status: 'planned', goal: plan.goal, kind: plan.kind });
    return {
      success: true,
      taskId: id,
      task,
      warning: disk.level === 'warn' ? '磁盘占用已超过 80%，建议先清理' : ''
    };
  }

  list() {
    this.fsMkdir(this.tasksDir);
    let names;
    try {
      names = fs.readdirSync(this.tasksDir).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    const tasks = [];
    for (const name of names) {
      const task = this._loadTask(name.slice(0, -5));
      if (task) tasks.push(task);
    }
    tasks.sort((a, b) => b.createdAt - a.createdAt);
    return tasks;
  }

  get(id) {
    const task = this._loadTask(id);
    if (!task) return { success: false, error: '任务不存在' };
    return { success: true, task };
  }

  // 默认执行器：显式 Python 路径进沙箱，onStart 把停止句柄交回去给看门狗
  async _exec({ python, args, cwd, onLine, onStart }) {
    if (!this.sandbox || typeof this.sandbox.startStreamed !== 'function') {
      return { success: false, error: '沙箱不可用，拒绝执行学习任务' };
    }
    const handle = this.sandbox.startStreamed(python, args, { cwd, onLine });
    if (!handle || handle.success === false) {
      return { success: false, error: (handle && handle.error) || '沙箱启动失败' };
    }
    if (typeof onStart === 'function') onStart(() => handle.stop && handle.stop());
    return handle.promise;
  }

  async run(id, options = {}) {
    const found = this.get(id);
    if (!found.success) return { success: false, error: found.error };
    const task = found.task;
    if (task.status === 'running') return { success: false, error: '任务正在运行' };
    if (!task.script) return { success: false, error: '任务没有脚本，无法执行' };

    const heavy = options.heavy !== false;
    const admit = this.guard.admit({
      bucket: 'datasets',
      bytes: task.estimatedBytes,
      heavy,
      startedAt: 0
    });
    if (!admit.ok) {
      this._update(task.id, { status: 'blocked', result: { error: admit.reason } });
      this._emit('learning.task', { taskId: task.id, status: 'blocked', reason: admit.reason });
      return {
        success: false,
        error: `资源闸拒绝：${admit.reason}`,
        level: admit.level,
        disk: admit.disk && admit.disk.usage,
        cpu: admit.cpu
      };
    }

    const workDir = path.join(this.workspaceDir, task.id);
    this.fsMkdir(workDir);
    const scriptPath = path.join(workDir, 'task.py');
    try {
      fs.writeFileSync(scriptPath, task.script, 'utf8');
    } catch (error) {
      return { success: false, error: `写入任务脚本失败: ${error.message}` };
    }

    const startedAt = this.now();
    this._update(task.id, { status: 'running', startedAt });
    this._emit('learning.task', { taskId: task.id, status: 'running', goal: task.goal });

    let stop = null;
    const watchdog = this.watchdogMs > 0
      ? setInterval(() => {
        this.guard.sampleCpu();
        const state = this.guard.cpuState({ jobStartedAt: startedAt, heavy });
        if ((state.level === 'paused' || state.level === 'blocked') && typeof stop === 'function') {
          stop();
        }
      }, this.watchdogMs)
      : null;
    if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();

    let result;
    try {
      const exec = this.executor || this._exec.bind(this);
      result = await exec({
        python: this.python,
        args: ['-u', scriptPath],
        cwd: workDir,
        onLine: typeof options.onLine === 'function' ? options.onLine : null,
        onStart: (fn) => { stop = fn; }
      });
    } catch (error) {
      result = { success: false, error: `执行异常: ${error.message}` };
    } finally {
      if (watchdog) clearInterval(watchdog);
      // 临时数据任务结束即删，避免 datasets 桶被单次任务长期占住
      try {
        fs.rmSync(path.join(this.datasetsDir, task.id), { recursive: true, force: true });
      } catch {
        // 清理失败不影响任务结果
      }
    }

    const finishedAt = this.now();
    const ok = !!(result && result.success);
    const patch = {
      status: ok ? 'done' : 'failed',
      finishedAt,
      durationMs: finishedAt - startedAt,
      result: {
        success: ok,
        exitCode: Number.isInteger(result && result.exitCode) ? result.exitCode : null,
        stdout: String((result && result.stdout) || '').slice(0, 4000),
        stderr: String((result && result.stderr) || '').slice(0, 2000),
        error: (result && result.error) || null
      }
    };

    let retained = null;
    if (ok && task.retain && task.license) {
      retained = this._retain(task, workDir);
      patch.result.retained = retained;
    } else if (ok && task.retain && !task.license) {
      patch.result.retained = { success: false, error: '缺少 license，产物未留存' };
    }

    this._update(task.id, patch);
    this._emit('learning.task', {
      taskId: task.id,
      status: patch.status,
      durationMs: patch.durationMs,
      error: patch.result.error
    });
    if (retained && retained.success) {
      this._emit('learning.artifact', {
        taskId: task.id,
        artifactId: retained.id,
        bytes: retained.bytes,
        title: task.title
      });
    }

    return { success: ok, taskId: task.id, ...patch.result, retained };
  }

  _retain(task, workDir) {
    const files = [];
    let names;
    try {
      names = fs.readdirSync(workDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (name === 'task.py' || name === '__pycache__') continue;
      const full = path.join(workDir, name);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        files.push({ name, path: full });
      } catch {
        // 读不到就跳过
      }
    }
    if (!files.length) return { success: false, error: '任务没有产出文件，未留存' };
    const saved = this.store.retain({
      kind: task.kind,
      title: task.title,
      source: task.sources[0],
      license: task.license,
      script: task.script,
      files
    });
    if (saved.success) this.store.prune();
    return saved;
  }

  status() {
    return {
      disk: this.guard.usage(),
      cpu: this.guard.cpuState(),
      artifacts: this.store.stats(),
      tasks: {
        total: this.list().length,
        running: this.list().filter((task) => task.status === 'running').length
      },
      python: this.python
    };
  }

  // 15 秒采样一次，保证 CPU 窗口有数据；重复调用不会叠加定时器
  startMonitor() {
    if (this._watchdogTimer) return this._watchdogTimer;
    if (this.watchdogMs <= 0) return null;
    this._watchdogTimer = setInterval(() => this.guard.sampleCpu(), this.watchdogMs);
    if (typeof this._watchdogTimer.unref === 'function') this._watchdogTimer.unref();
    return this._watchdogTimer;
  }
}

module.exports = {
  LearningTaskCenter,
  validateSource,
  validateRequest,
  resolvePython,
  SOURCE_RULES,
  TASK_KINDS
};
