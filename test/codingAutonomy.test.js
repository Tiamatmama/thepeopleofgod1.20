'use strict';

// 自主能力垂直切片：drive 级语义（阶段化验收 + 条件提交 + 回滚）
// 只桩掉外部边界（模型输出 / 诊断 / git），阶段判据走真实 HTTP 与真实 evaluateStage。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CodingLoop = require('../src/core/codingLoop');
const { createServer } = require('./fixtures/autonomy/server');

const { normalizeStages } = CodingLoop;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function healthStage(id, url, extra = {}) {
  return { id, kind: 'health', check: { url }, ...extra };
}

// 只桩外部边界：git 用内存记录，避免真的建仓；taskDir 返回空串让产物落盘直接跳过。
function makeHarness({ diagnose = null, gitCommit = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-autonomy-'));
  const gitCalls = [];
  const commitCalls = [];
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
    gitCommit: (userId, taskId, message) => {
      commitCalls.push(message);
      return gitCommit ? gitCommit() : { success: true };
    }
  };
  const outputModule = {
    callWithTools: async () => ({ choices: [{ message: { content: '这一轮先摸清现状，下一步改实现。' } }] })
  };
  const toolRegistry = {
    codeDiagnose: diagnose || (async () => ({ success: true, checked: 1, errorCount: 0, errors: [] })),
    codeRunTests: async () => ({ exitCode: 0, counts: { known: false } })
  };
  const loop = new CodingLoop({ coding, outputModule, toolRegistry });
  return { loop, coding, gitCalls, commitCalls, dir };
}

function makeCtx(overrides = {}) {
  return {
    userId: 'u_test',
    taskId: 't_autonomy',
    sessionId: 's_test',
    goal: '做一个登录页并通过健康检查',
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

function makeRun(ctx) {
  return {
    id: `run_test_${Math.random().toString(36).slice(2, 8)}`,
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

// ---- 阶段全过：passed + 阶段检查点 ----

test('drive：健康检查阶段 200 → passed、verdict=verified、阶段已提交', async () => {
  const server = createServer({ healthStatus: 200 });
  const base = await listen(server);
  try {
    const harness = makeHarness();
    const ctx = makeCtx({ stages: normalizeStages([healthStage('health', `${base}/health`)]) });
    const run = await driveOnce(harness, ctx);

    assert.equal(run.status, 'passed');
    assert.equal(run.verdict, 'verified');
    assert.equal(run.stageResults.length, 1);
    assert.equal(run.stageResults[0].ok, true);
    assert.equal(run.stageCommits.length, 1);
    assert.equal(run.stageCommits[0].stageId, 'health');
    // 阶段提交的 sha 同时成为绿点；passed 后不再做整轮二次提交
    assert.equal(run.lastGreen, run.stageCommits[0].sha);
    assert.equal(run.stageResults[0].commitSha, run.lastGreen);
    assert.equal(harness.gitCalls.filter(a => a[0] === 'add').length, 1);
  } finally {
    await close(server);
  }
});

// ---- 阶段失败：不提交、不回滚（没有安全点） ----

test('drive：健康检查 500 → 不 passed、errorKind=healthCheck、不提交检查点', async () => {
  const server = createServer({ healthStatus: 500 });
  const base = await listen(server);
  try {
    const harness = makeHarness();
    const ctx = makeCtx({ stages: normalizeStages([healthStage('health', `${base}/health`)]) });
    const run = await driveOnce(harness, ctx);

    assert.equal(run.status, 'failed');
    assert.equal(run.verdict, 'failed');
    assert.equal(run.stageResults[0].ok, false);
    assert.equal(run.stageCommits.length, 0);
    assert.equal(run.lastGreen, '');
    assert.equal(run.rolledBackTo, '');
    assert.equal(run.iterations[0].check.errorKind, 'healthCheck');
    assert.match(run.iterations[0].check.reason, /阶段验收未通过/);
    assert.equal(harness.commitCalls.length, 0);
    assert.equal(harness.gitCalls.filter(a => a[0] === 'reset').length, 0);
  } finally {
    await close(server);
  }
});

// ---- 部分通过：已完成阶段的提交保留，回滚只退到最近阶段检查点 ----

test('drive：先过阶段已提交，后续阶段失败 → 回滚到该阶段检查点而不是起点', async () => {
  const okServer = createServer({ healthStatus: 200 });
  const badServer = createServer({ healthStatus: 500 });
  const okBase = await listen(okServer);
  const badBase = await listen(badServer);
  try {
    const harness = makeHarness();
    const ctx = makeCtx({
      stages: normalizeStages([
        healthStage('first', `${okBase}/health`),
        healthStage('second', `${badBase}/health`)
      ])
    });
    const run = await driveOnce(harness, ctx);

    assert.equal(run.status, 'failed');
    assert.equal(run.stageCommits.length, 1);
    assert.equal(run.stageCommits[0].stageId, 'first');
    assert.equal(run.lastGreen, run.stageCommits[0].sha);
    assert.equal(run.rolledBackTo, run.stageCommits[0].sha);
    // 只有第一个阶段提交（add + commit + rev-parse），第二个阶段失败不提交
    assert.equal(harness.gitCalls.filter(a => a[0] === 'rev-parse').length, 1);
    const resetCall = harness.gitCalls.find(a => a[0] === 'reset');
    assert.deepEqual(resetCall, ['reset', '--hard', run.stageCommits[0].sha]);
  } finally {
    await close(okServer);
    await close(badServer);
  }
});

// ---- 依赖语义：前置未过 → 后续阶段 skipped，不执行 ----

test('drive：前置阶段失败 → 依赖阶段标记 skipped', async () => {
  const badServer = createServer({ healthStatus: 500 });
  const okServer = createServer({ healthStatus: 200 });
  const badBase = await listen(badServer);
  const okBase = await listen(okServer);
  try {
    const harness = makeHarness();
    const ctx = makeCtx({
      stages: normalizeStages([
        healthStage('root', `${badBase}/health`),
        healthStage('leaf', `${okBase}/health`, { requires: ['root'] })
      ])
    });
    const run = await driveOnce(harness, ctx);

    const [root, leaf] = run.stageResults;
    assert.equal(root.ok, false);
    assert.equal(leaf.skipped, true);
    assert.match(leaf.reason, /前置阶段未通过/);
    assert.equal(leaf.commitSha, '');
    assert.equal(run.stageCommits.length, 0);
    assert.equal(run.status, 'failed');
  } finally {
    await close(badServer);
    await close(okServer);
  }
});

// ---- 有 stages 时不再重复跑旧的自动 webCheck ----

test('drive：声明 stages 时跳过旧 webCheck 自动验收', async () => {
  const server = createServer({ healthStatus: 200 });
  const base = await listen(server);
  try {
    const harness = makeHarness();
    harness.loop.evaluateWebCheck = async () => {
      throw new Error('声明 stages 时不应再跑旧的 webCheck');
    };
    const ctx = makeCtx({
      webCheck: { start: { command: 'node', args: ['server.js'] }, steps: [{ type: 'open', path: '/' }] },
      stages: normalizeStages([healthStage('health', `${base}/health`)])
    });
    const run = await driveOnce(harness, ctx);

    assert.equal(run.status, 'passed');
    assert.equal(run.verdict, 'verified');
  } finally {
    await close(server);
  }
});

// ---- 旧语义回归：无 stages / 无 webCheck 时行为不变 ----

test('drive：未声明阶段时保持旧语义（诊断通过即 passed 并打绿色检查点）', async () => {
  const harness = makeHarness();
  const ctx = makeCtx();
  const run = await driveOnce(harness, ctx);

  assert.equal(run.status, 'passed');
  assert.equal(run.verdict, 'unverified');
  assert.equal(run.lastGreen, 'sha1');
  assert.equal(run.stageCommits.length, 0);
  assert.equal(run.iterations[0].check.ok, true);
});

// ---- prepare：非法阶段声明 fail-closed ----

test('start：非法 stages 声明直接拒绝启动', async () => {
  const harness = makeHarness();
  const res = await harness.loop.start({
    userId: 'u_test',
    taskId: 't_bad_stages',
    goal: '做登录页',
    stages: [{ id: 'health', kind: 'health', check: { url: 'ftp://127.0.0.1/health' } }]
  });

  assert.equal(res.success, false);
  assert.match(res.error, /stages 声明非法/);
});

// ---- commitCheckpoint：阶段未通过绝不提交 ----

test('commitCheckpoint：断言 ok !== true 时不写检查点', () => {
  const harness = makeHarness();

  const denied = harness.loop.commitCheckpoint('u_test', 't_autonomy', 'stage denied', { stageId: 'health', ok: false });
  assert.equal(denied, '');
  assert.equal(harness.gitCalls.length, 0);

  const allowed = harness.loop.commitCheckpoint('u_test', 't_autonomy', 'stage allowed', { stageId: 'health', ok: true });
  assert.equal(allowed, 'sha1');
});

test('commitCheckpoint：git 提交失败时返回空 sha', () => {
  const harness = makeHarness({ gitCommit: () => ({ success: false }) });
  const sha = harness.loop.commitCheckpoint('u_test', 't_autonomy', 'stage allowed', { stageId: 'health', ok: true });
  assert.equal(sha, '');
});
