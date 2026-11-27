'use strict';

// 计划（DAG / 子任务）：纯函数边界 + drive 级推进 + 跨 run 续跑。
// 只桩外部边界（模型输出 / 诊断 / git），节点推进、检查点与状态语义走真实 CodingLoop。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CodingLoop = require('../src/core/codingLoop');
const {
  MAX_NODES,
  normalizePlan,
  orderPlanNodes,
  planState,
  selectNextNode,
  describePlan,
  effectiveCriteria
} = require('../src/core/plan');
const { appendCheckpoint, readCheckpoints, completedNodes } = require('../src/core/checkpointLog');

// ---- plan.js 纯函数 ----

test('normalizePlan：null 视为无计划，结构非法一律 fail-closed', () => {
  assert.equal(normalizePlan(null), null);
  assert.equal(normalizePlan(undefined), null);

  assert.throws(() => normalizePlan([]), /不能为空/);
  assert.throws(() => normalizePlan({ nodes: [] }), /不能为空/);
  assert.throws(() => normalizePlan({ nodes: 'a' }), /必须是子任务数组/);
  assert.throws(() => normalizePlan([{ id: 'a' }]), /title 不能为空/);
  assert.throws(() => normalizePlan([{ id: '-bad', title: 'A' }]), /id 只能包含/);
  assert.throws(() => normalizePlan([{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }]), /id 重复/);
  assert.throws(() => normalizePlan([{ id: 'a', title: 'A', requires: 'b' }]), /requires 必须是数组/);
  assert.throws(() => normalizePlan([{ id: 'a', title: 'A', requires: ['a'] }]), /不能依赖自己/);
  assert.throws(() => normalizePlan([{ id: 'a', title: 'A', requires: ['nope'] }]), /依赖了不存在的子任务/);
  assert.throws(() => normalizePlan([
    { id: 'a', title: 'A', requires: ['b'] },
    { id: 'b', title: 'B', requires: ['a'] }
  ]), /循环依赖/);
});

test('normalizePlan：节点上限与 acceptance 注入', () => {
  const many = Array.from({ length: MAX_NODES + 1 }, (_, i) => ({ id: `n${i}`, title: `T${i}` }));
  assert.throws(() => normalizePlan(many), new RegExp(`最多 ${MAX_NODES} 个节点`));

  const raw = [{ id: 'a', title: 'A', acceptance: { passCommand: 'npm test' } }];
  assert.throws(() => normalizePlan(raw), /acceptance 需要由闭环归一化/);
  assert.throws(() => normalizePlan(raw, { normalizeAcceptance: () => ({}) }), /至少要声明一个判据/);

  const plan = normalizePlan(raw, { normalizeAcceptance: (acc, where) => ({ passCommand: `${where}:${acc.passCommand}` }) });
  assert.equal(plan.nodes[0].acceptance.passCommand, 'plan.nodes[0]:npm test');
});

test('orderPlanNodes：稳定拓扑序，同层保持声明顺序', () => {
  const plan = normalizePlan([
    { id: 'b', title: 'B', requires: ['a'] },
    { id: 'a', title: 'A' },
    { id: 'c', title: 'C' }
  ]);
  assert.deepEqual(orderPlanNodes(plan).map(node => node.id), ['a', 'c', 'b']);
});

test('planState / selectNextNode：done / ready / blocked / next / complete', () => {
  const plan = normalizePlan([
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B', requires: ['a'] },
    { id: 'c', title: 'C', requires: ['b'] }
  ]);

  const fresh = planState(plan, []);
  assert.deepEqual(fresh.done, []);
  assert.deepEqual(fresh.ready, ['a']);
  assert.deepEqual(fresh.blocked, ['b', 'c']);
  assert.equal(fresh.next.id, 'a');
  assert.equal(fresh.complete, false);
  assert.equal(selectNextNode(plan, []).id, 'a');

  const middle = planState(plan, ['a', 'unknown']);
  assert.deepEqual(middle.done, ['a']);
  assert.deepEqual(middle.ready, ['b']);
  assert.deepEqual(middle.blocked, ['c']);
  assert.equal(middle.next.id, 'b');

  const done = planState(plan, ['a', 'b', 'c']);
  assert.equal(done.next, null);
  assert.equal(done.complete, true);
});

test('effectiveCriteria：逐字段继承，显式 stages: [] 关闭继承', () => {
  const ctx = {
    passCommand: 'run-cmd',
    webCheck: { baseUrl: 'http://127.0.0.1' },
    healthCheck: { url: 'http://127.0.0.1/health' },
    deploy: { command: 'node', args: ['deploy.js'] },
    stages: [{ id: 'run-stage' }]
  };

  assert.deepEqual(effectiveCriteria(ctx, null), {
    passCommand: 'run-cmd',
    webCheck: ctx.webCheck,
    healthCheck: ctx.healthCheck,
    deploy: ctx.deploy,
    stages: ctx.stages
  });

  const overridden = effectiveCriteria(ctx, { acceptance: { passCommand: 'node-cmd', stages: [] } });
  assert.equal(overridden.passCommand, 'node-cmd');
  assert.deepEqual(overridden.stages, []);
  assert.equal(overridden.healthCheck, ctx.healthCheck);
  assert.equal(overridden.deploy, ctx.deploy);
});

test('describePlan：完成 / 当前 / 未开始 + 依赖与独立验收标记', () => {
  const plan = normalizePlan([
    { id: 'a', title: 'A', acceptance: { passCommand: 'npm test' } },
    { id: 'b', title: 'B', requires: ['a'] }
  ], { normalizeAcceptance: acceptance => acceptance });
  const text = describePlan(plan, ['a'], 'b');
  assert.match(text, /- \[x\] 1\. \[a\] A〔独立验收〕/);
  assert.match(text, /- \[>\] 2\. \[b\] B（需先完成：a）/);
});

test('completedNodes：只认通过的 node，跨 run 累计、去重、过滤计划外节点', () => {
  const entries = [
    { kind: 'node', nodeId: 'a', ok: true },
    { kind: 'node', nodeId: 'x', ok: true },
    { kind: 'node', nodeId: 'b', ok: false },
    { kind: 'node', nodeId: 'a', ok: true },
    { kind: 'node', nodeId: 'b', ok: true }
  ];
  assert.deepEqual(completedNodes(entries, ['a', 'b']), ['a', 'b']);
  assert.deepEqual(completedNodes(entries), ['a', 'x', 'b']);
});

// ---- drive 级：节点推进 ----

function makeCtx(overrides = {}) {
  return {
    userId: 'u_plan',
    taskId: 't_plan',
    sessionId: 's_plan',
    goal: '从登录页做到上线',
    passCommand: '',
    model: 'qwen',
    maxIterations: 1,
    timeoutMs: 60000,
    stallK: 3,
    userApiConfig: null,
    webCheck: null,
    healthCheck: null,
    stages: [],
    ...overrides
  };
}

// 只桩外部边界：git 用内存记录，taskDir 返回空串让产物落盘直接跳过。
function makeHarness({ gitCommit = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-plan-'));
  const gitCalls = [];
  let seq = 0;
  const coding = {
    dir,
    taskDir: () => '',
    safeTaskId: (id) => String(id || '').trim(),
    getTrustLevel: () => 'auto',
    createWorkspace: () => ({ success: true }),
    git: (userId, taskId, args) => {
      gitCalls.push(args);
      if (args[0] === 'rev-parse') return { success: true, output: `sha${++seq}\n` };
      return { success: true, output: '' };
    },
    gitCommit: () => (gitCommit ? gitCommit() : { success: true })
  };
  const outputModule = {
    callWithTools: async () => ({ choices: [{ message: { content: '这一轮做当前子任务。' } }] })
  };
  const toolRegistry = {
    codeDiagnose: async () => ({ success: true, checked: 1, errorCount: 0, errors: [] }),
    codeRunTests: async () => ({ exitCode: 0, counts: { known: false } })
  };
  const loop = new CodingLoop({ coding, outputModule, toolRegistry });
  return { loop, coding, gitCalls, dir };
}

function makeRun(ctx) {
  return {
    id: `run_plan_${Math.random().toString(36).slice(2, 8)}`,
    userId: ctx.userId,
    taskId: ctx.taskId,
    goal: ctx.goal,
    passCommand: ctx.passCommand,
    model: ctx.model,
    maxIterations: ctx.maxIterations,
    startedAt: new Date().toISOString(),
    status: 'running',
    iterations: [],
    lastGreen: '',
    rolledBackTo: '',
    result: '',
    error: '',
    verdict: 'unverified',
    webCheck: null,
    webCheckResult: null,
    healthCheck: null,
    healthCheckResult: null,
    stages: ctx.stages,
    stageResults: [],
    stageCommits: []
  };
}

async function driveOnce(harness, ctx) {
  const run = makeRun(ctx);
  await harness.loop.drive(run, ctx, Date.now() + 30000);
  return run;
}

test('drive：按 DAG 逐个通过节点，每个节点落独立检查点，最终 passed', async () => {
  const harness = makeHarness();
  harness.loop.evaluate = async () => ({ ok: true, verdict: 'verified', reason: 'ok' });
  const ctx = makeCtx({
    plan: normalizePlan([
      { id: 'a', title: '搭骨架' },
      { id: 'b', title: '接登录', requires: ['a'] },
      { id: 'c', title: '部署上线', requires: ['b'] }
    ])
  });

  const run = await driveOnce(harness, ctx);

  assert.equal(run.status, 'passed');
  assert.deepEqual(run.planDone, ['a', 'b', 'c']);
  assert.deepEqual(run.iterations.map(step => step.nodeId), ['a', 'b', 'c']);
  assert.equal(run.nodeResults.length, 3);
  assert.equal(run.nodeCommits.length, 3);
  assert.equal(new Set(run.nodeCommits.map(item => item.sha)).size, 3);
  assert.equal(run.currentNode, '');
  assert.equal(run.rolledBackTo, '');

  const entries = readCheckpoints(harness.loop.checkpointFile(ctx));
  const nodes = entries.filter(entry => entry.kind === 'node' && entry.ok);
  assert.deepEqual(nodes.map(entry => entry.nodeId), ['a', 'b', 'c']);
  assert.deepEqual(nodes.map(entry => entry.sha), run.nodeCommits.map(item => item.sha));
});

test('drive：节点 acceptance 覆盖 run 级判据，未声明字段继续继承', async () => {
  const harness = makeHarness();
  const seen = [];
  harness.loop.evaluate = async (ctx, run, criteria) => {
    seen.push({ passCommand: criteria.passCommand, stages: criteria.stages });
    return { ok: true, verdict: 'verified', reason: 'ok' };
  };
  const plan = normalizePlan([
    { id: 'a', title: 'A' }
  ]);
  plan.nodes[0].acceptance = { passCommand: 'a-cmd' };
  plan.nodes.push({ id: 'b', title: 'B', requires: ['a'], acceptance: { stages: [] } });

  const run = await driveOnce(harness, makeCtx({ passCommand: 'run-cmd', plan }));

  assert.equal(run.status, 'passed');
  assert.deepEqual(seen, [
    { passCommand: 'a-cmd', stages: [] },
    { passCommand: 'run-cmd', stages: [] }
  ]);
});

test('drive：当前节点预算耗尽仍有剩余 → paused，回滚到最近节点检查点', async () => {
  const harness = makeHarness();
  let calls = 0;
  harness.loop.evaluate = async () => {
    calls++;
    return calls === 1
      ? { ok: true, verdict: 'verified', reason: 'ok' }
      : { ok: false, verdict: 'failed', reason: '还没做完', errorKind: 'testFailure' };
  };
  const ctx = makeCtx({
    maxIterations: 1,
    plan: normalizePlan([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B', requires: ['a'] },
      { id: 'c', title: 'C', requires: ['b'] }
    ])
  });

  const run = await driveOnce(harness, ctx);

  assert.equal(run.status, 'paused');
  assert.deepEqual(run.planDone, ['a']);
  assert.equal(run.currentNode, 'b');
  assert.equal(run.nodeCommits.length, 1);
  assert.equal(run.lastGreen, run.nodeCommits[0].sha);
  assert.equal(run.rolledBackTo, run.nodeCommits[0].sha);
  assert.match(run.error, /子任务 b/);
  assert.match(run.error, /剩余子任务：b、c/);

  const reset = harness.gitCalls.find(args => args[0] === 'reset');
  assert.deepEqual(reset, ['reset', '--hard', run.nodeCommits[0].sha]);

  const entries = readCheckpoints(harness.loop.checkpointFile(ctx));
  const end = entries.filter(entry => entry.kind === 'run_end').pop();
  assert.equal(end.verdict, 'paused');
  // 已完成的节点检查点不会被回滚抹掉
  assert.ok(entries.some(entry => entry.kind === 'node' && entry.nodeId === 'a' && entry.ok));
});

test('drive：无 plan 时保持旧语义（整轮通过 → stage 检查点）', async () => {
  const harness = makeHarness();
  harness.loop.evaluate = async () => ({ ok: true, verdict: 'unverified', reason: 'ok' });
  const ctx = makeCtx();

  const run = await driveOnce(harness, ctx);

  assert.equal(run.status, 'passed');
  assert.equal(run.plan || null, null);
  assert.equal(run.iterations.length, 1);
  const entries = readCheckpoints(harness.loop.checkpointFile(ctx));
  assert.equal(entries.filter(entry => entry.kind === 'node').length, 0);
  const stage = entries.find(entry => entry.kind === 'stage' && entry.ok);
  assert.equal(stage.stageId, '');
  assert.equal(stage.sha, run.lastGreen);
});

// ---- 跨 run：续跑与 plan_done ----

// ancestor(currentHead, resumeSha)：模拟 merge-base --is-ancestor 的判定
function makeResumeHarness({ head = 'sha_b', ancestor = () => true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-plan-resume-'));
  let currentHead = head;
  let seq = 0;
  const gitCalls = [];
  const coding = {
    dir,
    userKey: () => 'u_plan_hash',
    taskDir: () => '',
    safeTaskId: (id) => String(id || '').trim(),
    getTrustLevel: () => 'auto',
    createWorkspace: () => ({ success: true }),
    git: (userId, taskId, args) => {
      gitCalls.push(args);
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { success: true, output: '' };
      if (args[0] === 'rev-parse') return { success: true, output: `${currentHead}\n` };
      if (args[0] === 'merge-base') {
        return ancestor(args[2], currentHead) ? { success: true, output: '' } : { success: false, output: '' };
      }
      return { success: true, output: '' };
    },
    gitCommit: () => {
      currentHead = `sha_${++seq}`;
      return { success: true };
    }
  };
  const outputModule = {
    callWithTools: async () => ({ choices: [{ message: { content: '继续未完成的子任务。' } }] })
  };
  const toolRegistry = {
    codeDiagnose: async () => ({ success: true, checked: 1, errorCount: 0, errors: [] }),
    codeRunTests: async () => ({ exitCode: 0, counts: { known: false } })
  };
  const loop = new CodingLoop({ coding, outputModule, toolRegistry });
  return { loop, coding, gitCalls, dir };
}

function seed(harness, ctx, entries) {
  const file = harness.loop.checkpointFile(ctx);
  entries.forEach(entry => appendCheckpoint(file, { taskId: ctx.taskId, ...entry }));
  return file;
}

async function waitFor(fn, timeout = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('等待超时');
}

const THREE_NODES = [
  { id: 'a', title: 'A' },
  { id: 'b', title: 'B', requires: ['a'] },
  { id: 'c', title: 'C', requires: ['b'] }
];

test('start：跨 run 读已完成节点，跳过它们从下一个节点继续', async () => {
  const harness = makeResumeHarness({ head: 'sha_b' });
  const ctx = makeCtx();
  const file = seed(harness, ctx, [
    { runId: 'run_prev', iteration: 1, kind: 'node', nodeId: 'a', ok: true, sha: 'sha_a', at: '2026-01-01T00:00:00.000Z' },
    { runId: 'run_prev', iteration: 2, kind: 'node', nodeId: 'b', ok: true, sha: 'sha_b', at: '2026-01-01T00:01:00.000Z' },
    { runId: 'run_prev', iteration: 2, kind: 'run_end', ok: false, verdict: 'paused', sha: 'sha_b' }
  ]);

  const started = await harness.loop.start({
    userId: ctx.userId,
    taskId: ctx.taskId,
    goal: ctx.goal,
    maxIterations: 1,
    model: 'qwen',
    plan: THREE_NODES
  });
  assert.equal(started.success, true);
  assert.deepEqual(started.run.planDone, ['a', 'b']);
  assert.equal(started.run.currentNode, 'c');
  assert.equal(started.run.lastGreen, 'sha_b');
  assert.deepEqual(started.run.resumedFrom.doneNodes, ['a', 'b']);

  // 在 setImmediate 触发前请求停止：drive 第一轮即熔断，走 finally 回滚
  harness.loop.stop(ctx.taskId);
  await waitFor(() => readCheckpoints(file).some(entry => entry.kind === 'run_end' && entry.runId === started.run.id));

  const reset = harness.gitCalls.find(args => args[0] === 'reset');
  assert.deepEqual(reset, ['reset', '--hard', 'sha_b']);
});

test('start：计划全部完成 → 直接返回 plan_done，不再起 run', async () => {
  const harness = makeResumeHarness({ head: 'sha_b' });
  const ctx = makeCtx();
  seed(harness, ctx, [
    { runId: 'run_prev', iteration: 1, kind: 'node', nodeId: 'a', ok: true, sha: 'sha_a' },
    { runId: 'run_prev', iteration: 2, kind: 'node', nodeId: 'b', ok: true, sha: 'sha_b' }
  ]);

  const res = await harness.loop.start({
    userId: ctx.userId,
    taskId: ctx.taskId,
    goal: ctx.goal,
    plan: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B', requires: ['a'] }
    ]
  });

  assert.equal(res.success, false);
  assert.equal(res.code, 'plan_done');
  assert.match(res.error, /全部完成/);
});

test('start：非法 plan（含非法 acceptance）直接拒绝启动', async () => {
  const harness = makeHarness();

  const unknownDep = await harness.loop.start({
    userId: 'u_plan',
    taskId: 't_bad_plan',
    goal: '做登录页',
    plan: [{ id: 'a', title: 'A', requires: ['missing'] }]
  });
  assert.equal(unknownDep.success, false);
  assert.match(unknownDep.error, /plan 声明非法/);

  const badAcceptance = await harness.loop.start({
    userId: 'u_plan',
    taskId: 't_bad_acceptance',
    goal: '做登录页',
    plan: [{
      id: 'a',
      title: 'A',
      acceptance: { stages: [{ id: 'health', kind: 'health', check: { url: 'ftp://127.0.0.1/health' } }] }
    }]
  });
  assert.equal(badAcceptance.success, false);
  assert.match(badAcceptance.error, /plan 声明非法/);

  const emptyAcceptance = await harness.loop.start({
    userId: 'u_plan',
    taskId: 't_empty_acceptance',
    goal: '做登录页',
    plan: [{ id: 'a', title: 'A', acceptance: {} }]
  });
  assert.equal(emptyAcceptance.success, false);
  assert.match(emptyAcceptance.error, /至少要声明一个判据/);
});
