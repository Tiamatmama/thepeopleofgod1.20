'use strict';

// 工人池（代理式自动化车间 / Artax 式并发车间的最小落地）
// 一句话：任务板上「待办且声明了目标」的任务，由工人池自动领单 → 派给编码闭环并发执行 → 跑完把结果回写任务板。
//
// 与「评审人格」的分工：人格（codingTeam 的五个评估者）负责挑刺、定验收视角；工人只负责干活。
// 裁判不兼任球员——工人不是人格，而是无状态的执行单元，专长落在任务本身与放行的工具集上。
//
// 三条边界（刻意卡死，别越）：
// 1. 安全默认：池默认「不自动领单」（auto=false）。要自动跑得显式开开关（接口 / 前端）。
// 2. 只领「可说清目标」的任务：params.goal 非空，或 spike / idea-promoted 候选。
//    普通抓点任务没有显式目标，仍走人工一键开跑，不被自动消费。
// 3. 反打转：同一任务自动重派有上限（maxAttempts），超限回落到人工，不再自动领单。

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_ATTEMPTS = 2;
const TICK_INTERVAL_MS = 5000;
// 在跑表的兜底寿命：只在「查不到自己那次运行」时生效（历史被裁剪 / 工作区被别的运行顶掉）。
// 只要还能看见自己那次没跑完，就不按这个判死——否则长任务会被当成失联。
const DEFAULT_INFLIGHT_TTL_MS = 45 * 60 * 1000;
const LOG_KEEP = 50;

class WorkerPool {
  // coding: CodingCenter（任务板读写）；codingLoop: 编码闭环（唯一执行入口，不另开执行路径）
  constructor({ coding, codingLoop, sandboxAgents = null, concurrency = DEFAULT_CONCURRENCY, maxAttempts = DEFAULT_MAX_ATTEMPTS, intervalMs = TICK_INTERVAL_MS, inflightTtlMs = DEFAULT_INFLIGHT_TTL_MS, now = Date.now } = {}) {
    this.coding = coding;
    this.codingLoop = codingLoop;
    this.sandboxAgents = sandboxAgents;
    this.concurrency = Math.max(1, parseInt(concurrency, 10) || DEFAULT_CONCURRENCY);
    this.maxAttempts = Math.max(1, parseInt(maxAttempts, 10) || DEFAULT_MAX_ATTEMPTS);
    this.intervalMs = Math.max(1000, parseInt(intervalMs, 10) || TICK_INTERVAL_MS);
    this.inflightTtlMs = Math.max(1000, parseInt(inflightTtlMs, 10) || DEFAULT_INFLIGHT_TTL_MS);
    this.now = typeof now === 'function' ? now : Date.now;
    this.inflight = new Map(); // runTaskId → { boardTaskId, runTaskId, runId, userId, goal, startedAt }
    this.auto = false;
    this.timer = null;
    this.ticking = false;      // 防重入：两个 tick 并发会把同一条任务派两次
    this.lastTickAt = '';
    this.log = [];             // 有界：最近 LOG_KEEP 条领单 / 回写记录
  }

  // ---- 状态（给面板看）----

  status() {
    return {
      auto: this.auto,
      concurrency: this.concurrency,
      maxAttempts: this.maxAttempts,
      running: this.inflight.size,
      pending: this.eligibleTasks().length,
      lastTickAt: this.lastTickAt,
      workers: Array.from(this.inflight.values()).map(w => ({
        boardTaskId: w.boardTaskId,
        runTaskId: w.runTaskId,
        runId: w.runId,
        userId: w.userId,
        goal: w.goal,
        startedAt: w.startedAt
      })),
      recent: this.log.slice(-20).reverse()
    };
  }

  note(entry) {
    this.log.push({ at: new Date().toISOString(), ...entry });
    if (this.log.length > LOG_KEEP) this.log = this.log.slice(-LOG_KEEP);
  }

  // ---- 领单规则 ----

  // 任务 → 闭环运行的工作区 taskId（与前端 runTaskIdFor 同一约定，别各写一套）
  runTaskIdFor(task) {
    const p = (task && task.params) || {};
    const kind = String(p.kind || '');
    const ideaId = String(p.ideaId || '');
    if (kind === 'spike' && ideaId) return `spike_${ideaId}`;
    if (kind === 'idea-promoted' && ideaId) return `impl_${ideaId}`;
    return String((task && task.id) || '');
  }

  // 能不能自动领：声明了目标，或是 spike / idea-promoted 候选。
  // 集群（AgentFleet）的子任务与汇总任务一律不领：那些槽位由中枢自己接线，
  // 工人池再领一遍就会和写手抢同一份工作区。
  isDispatchable(task) {
    const p = (task && task.params) || {};
    const kind = String(p.kind || '');
    if (kind === 'fleet' || kind === 'fleet-result') return false;
    if (String(p.fleetId || '').trim()) return false;
    if (String((task && task.id) || '').startsWith('fleet_')) return false;
    if (String(p.goal || '').trim()) return true;
    if ((kind === 'spike' || kind === 'idea-promoted') && String(p.ideaId || '').trim()) return true;
    return false;
  }

  // 目标文本：优先 params.goal；候选类任务的目标由闭环内部按 kind 生成，这里给个占位不参与
  buildGoal(task) {
    const p = (task && task.params) || {};
    const goal = String(p.goal || '').trim();
    if (goal) return goal;
    return `${String((task && task.title) || '').trim()}\n${String((task && task.desc) || '').trim()}`.trim();
  }

  // 同一工作区是否正被沙箱里的 Claude Code 占用：占用了就不再派给编码闭环
  // snapshot 可选：调用方已取过 runningRuns() 就传进来，避免在 filter 里 N 次重复取
  claudeBusy(task, snapshot) {
    if (!this.sandboxAgents || typeof this.sandboxAgents.runningRuns !== 'function') return false;
    const runs = Array.isArray(snapshot) ? snapshot : (this.sandboxAgents.runningRuns() || []);
    const owner = String((task && task.createdBy) || '').trim();
    const taskId = this.runTaskIdFor(task);
    return runs.some(run => run.owner === owner && run.taskId === taskId);
  }

  // 可自动领单的任务清单：待办 + 有归属 + 可派 + 未在跑 + 重派未超限
  eligibleTasks() {
    let tasks;
    try {
      tasks = this.coding.listTasks('todo') || [];
    } catch {
      return [];
    }
    // 沙箱在跑列表只取一次：纯读、无副作用，放 filter 里就是 N×M 次数组分配
    const running = this.sandboxAgents && typeof this.sandboxAgents.runningRuns === 'function'
      ? (this.sandboxAgents.runningRuns() || [])
      : null;
    return tasks.filter(t => {
      if (!t || !t.id) return false;
      if (!String(t.createdBy || '').trim()) return false; // 不知道记到谁名下 → 不自动跑
      const attempts = Number((t.params || {}).attempts) || 0;
      if (attempts >= this.maxAttempts) return false;       // 反打转：超限回落人工
      if (this.inflight.has(this.runTaskIdFor(t))) return false;
      if (this.claudeBusy(t, running)) return false;
      return this.isDispatchable(t);
    });
  }

  // ---- 派单 ----

  // 派一条：走既有唯一执行入口（codingLoop），不新开执行路径
  async dispatchOne(task) {
    const userId = String(task.createdBy || '').trim();
    const p = (task && task.params) || {};
    const kind = String(p.kind || '');
    const candidate = (kind === 'spike' || kind === 'idea-promoted');
    // 工人池是无人值守自动派单：不设 auto，写文件会等 120s 授权后自动拒绝，
    // 每个工人都只能空转烧 token（实测连跑两轮零产出）。与竞技场同一个处理。
    try {
      if (this.coding && typeof this.coding.setTrustLevel === 'function') {
        this.coding.setTrustLevel(userId, this.runTaskIdFor(task), 'auto');
      }
    } catch (error) {
      // 信任档设不上不算致命：失败原因会落进任务 result，面板能看见
    }
    let res;
    try {
      res = candidate
        ? await this.codingLoop.startFromTask({ taskId: task.id, userId, webCheck: p.webCheck, healthCheck: p.healthCheck, stages: p.stages, deploy: p.deploy, plan: p.plan })
        : await this.codingLoop.start({
            userId,
            taskId: this.runTaskIdFor(task),
            goal: this.buildGoal(task),
            passCommand: String(p.passCommand || '').trim(),
            webCheck: p.webCheck,
            healthCheck: p.healthCheck,
            stages: p.stages,
            deploy: p.deploy,
            plan: p.plan
          });
    } catch (error) {
      res = { success: false, error: error.message };
    }
    if (!res || res.success === false) {
      const reason = String((res && (res.error || res.message)) || '未知错误');
      // 并发冲突不是失败：工作区已有闭环在跑，跳过即可，不记一次尝试
      if (res && res.code === 'conflict') {
        this.note({ action: 'skip', taskId: task.id, reason });
        return { dispatched: false, taskId: task.id, skipped: true };
      }
      this.bumpAttempt(task, `领单失败：${reason}`);
      this.note({ action: 'dispatch_failed', taskId: task.id, reason });
      return { dispatched: false, taskId: task.id, reason };
    }
    const runTaskId = String(res.taskId || this.runTaskIdFor(task));
    const runId = (res.run && res.run.id) || '';
    this.inflight.set(runTaskId, {
      boardTaskId: task.id,
      runTaskId,
      runId,
      userId,
      goal: this.buildGoal(task).slice(0, 200),
      startedAt: new Date(this.now()).toISOString() // 走注入的时钟：否则寿命判定对注入无效、用例没法测
    });
    this.coding.updateTask(task.id, { status: 'doing', result: `工人已领单开跑（${runTaskId}）` });
    this.note({ action: 'dispatch', taskId: task.id, runTaskId, userId });
    return { dispatched: true, taskId: task.id, runTaskId };
  }

  // 领单一次：先收工（把跑完的回写任务板），再按剩余名额派新单。
  // 各工人是独立工作区 + 独立闭环，一个慢/失败不影响其他（互不 await）。
  async tick() {
    this.lastTickAt = new Date(this.now()).toISOString();
    if (this.ticking) return { dispatched: [], running: this.inflight.size, pending: this.eligibleTasks().length, skipped: 'busy' };
    this.ticking = true;
    try {
      this.reapFinished();
      // 一个 tick 只读一次任务板：派谁、还剩几单，都从同一份快照里算（原先是 3 次重复读）
      const eligible = this.eligibleTasks();
      const slots = this.concurrency - this.inflight.size;
      if (slots <= 0) return { dispatched: [], running: this.inflight.size, pending: eligible.length };
      const dispatched = [];
      // 名额内逐条派；await 的是「起跑」而非「跑完」——start 立即返回，drive 在后台
      for (const task of eligible.slice(0, slots)) {
        const r = await this.dispatchOne(task);
        if (r && r.dispatched) dispatched.push(r);
      }
      // 派单失败的还留在待办里，pending 要算上，不能直接用快照长度
      const taken = new Set(dispatched.map(r => r.taskId));
      return { dispatched, running: this.inflight.size, pending: eligible.filter(t => !taken.has(t.id)).length };
    } finally {
      this.ticking = false;
    }
  }

  // 收工：把已经跑完的工人从在跑表里摘掉，并把结果回写任务板
  reapFinished() {
    const settled = [];
    for (const [runTaskId, w] of Array.from(this.inflight.entries())) {
      const snap = this.codingLoop.latestRun(runTaskId);
      const mine = snap && snap.id === w.runId;
      // 看得见自己那次且还没跑完 → 继续等（长任务不按寿命判死）
      if (mine && !snap.finishedAt) continue;
      if (mine) {
        this.inflight.delete(runTaskId);
        this.settleTask(w, snap);
        settled.push({ taskId: w.boardTaskId, runTaskId, status: snap.status });
        continue;
      }
      // 查不到（历史被裁剪）或 id 对不上（工作区被别的运行顶掉）→ 按墙钟寿命兜底摘除。
      // 没有这条，inflight 只增不减，漏两格 concurrency=3 就永远停摆。
      const startedAt = Date.parse(w.startedAt);
      const age = Number.isFinite(startedAt) ? this.now() - startedAt : Infinity;
      if (age < this.inflightTtlMs) continue;
      this.inflight.delete(runTaskId);
      this.settleTask(w, { status: 'lost', error: '运行记录已不可见，按超时摘除' });
      settled.push({ taskId: w.boardTaskId, runTaskId, status: 'lost' });
    }
    return settled;
  }

  // 结果回写：过判据 → 已完成；没过 → 退回待办并记一次尝试（超限后不再被领）
  settleTask(w, snap) {
    const status = String((snap && snap.status) || '');
    const task = (this.coding.listTasks() || []).find(t => t.id === w.boardTaskId);
    if (status === 'passed') {
      this.coding.updateTask(w.boardTaskId, { status: 'done', result: `工人跑完：通过判据（${w.runTaskId}）` });
      this.note({ action: 'done', taskId: w.boardTaskId, runTaskId: w.runTaskId });
      return;
    }
    const reason = String((snap && snap.error) || '').trim();
    this.bumpAttempt(task || { id: w.boardTaskId, params: {} }, `工人第 N 次尝试未过：${status}${reason ? ' · ' + reason : ''}（${w.runTaskId}）`);
    this.note({ action: 'failed', taskId: w.boardTaskId, runTaskId: w.runTaskId, status });
  }

  // 记一次尝试并退回待办（params.attempts 累加，供反打转判定；不会丢原有 params）
  bumpAttempt(task, reason) {
    const id = task && task.id;
    if (!id) return;
    const params = { ...((task && task.params) || {}) };
    const attempts = (Number(params.attempts) || 0) + 1;
    params.attempts = attempts;
    const text = String(reason || '').replace('第 N 次', `第 ${attempts} 次`);
    this.coding.updateTask(id, {
      status: 'todo',
      params,
      result: `${text}（第 ${attempts}/${this.maxAttempts} 次自动尝试）`
    });
  }

  // ---- 自动开关 ----

  // 开自动：起一个定时器，按 intervalMs 领单。重复调用幂等。
  start() {
    this.auto = true;
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.tick().catch(error => console.error('[WorkerPool] 领单失败:', error.message));
      }, this.intervalMs);
      // 定时器不挡进程退出（服务端另有 HTTP listener 托底）
      if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
    }
    return this.status();
  }

  // 关自动：停定时器；已在跑的工人不打断，跑完照常回写
  stop() {
    this.auto = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.status();
  }
}

module.exports = WorkerPool;
