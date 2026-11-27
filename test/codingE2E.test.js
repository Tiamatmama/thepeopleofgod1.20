'use strict';

// 端到端：模型（桩）经真实 ToolRegistry 执行 code_deploy → 真实子进程部署
// → 真实 HTTP 健康检查阶段 → 检查点提交；并按轮次记录轨迹做回归比对。
// 只桩掉模型输出与 git，其余走真实实现。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CodingLoop = require('../src/core/codingLoop');
const { ToolRegistry } = require('../src/core/toolRegistry');
const { normalizeDeploy } = require('../src/core/deploy');
const { buildTrajectory, compareTrajectories } = require('../src/core/trajectory');
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

const DEPLOY_SCRIPT = `'use strict';
const fs = require('fs');
const path = require('path');
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'release.txt'), 'online');
console.log('release built');
`;

function makeCtx(overrides = {}) {
  return {
    userId: 'u_e2e',
    taskId: 't_e2e',
    sessionId: 's_e2e',
    goal: '把登录页做到可以上线',
    passCommand: '',
    model: 'qwen',
    maxIterations: 1,
    timeoutMs: 60000,
    stallK: 3,
    userApiConfig: null,
    webCheck: null,
    healthCheck: null,
    stages: [],
    deploy: null,
    ...overrides
  };
}

function makeRun(ctx) {
  return {
    id: `run_e2e_${Math.random().toString(36).slice(2, 8)}`,
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

// 真实 ToolRegistry + 真实工作区；git 用内存桩，避免测试依赖本机 git 配置。
function makeHarness({ trust = 'auto' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-e2e-'));
  const workspace = path.join(root, 'task');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'deploy.js'), DEPLOY_SCRIPT, 'utf8');

  const gitCalls = [];
  const commitCalls = [];
  let seq = 0;
  const coding = {
    dir: root,
    taskDir: () => workspace,
    safeTaskId: (id) => String(id || '').trim(),
    getTrustLevel: () => trust,
    createWorkspace: () => ({ success: true }),
    git: (userId, taskId, args) => {
      gitCalls.push(args);
      if (args[0] === 'rev-parse') return { success: true, output: `sha${++seq}\n` };
      return { success: true, output: '' };
    },
    gitCommit: (userId, taskId, message) => {
      commitCalls.push(message);
      return { success: true };
    }
  };

  const registry = new ToolRegistry({ projectRoot: root });
  registry.enabled = true;
  registry.coding = coding;

  // 模拟模型每轮的第一步：在闭环注入的上下文里调用 code_deploy，然后把结果写回对话。
  const deployCalls = [];
  const outputModule = {
    callWithTools: async (history, options) => {
      registry.setActiveContext(options);
      const raw = await registry.execute('code_deploy', {});
      deployCalls.push({ options, result: JSON.parse(raw) });
      return { choices: [{ message: { content: '已完成部署，交给阶段验收。' } }] };
    }
  };

  const toolRegistry = {
    codeDiagnose: async () => ({ success: true, checked: 1, errorCount: 0, errors: [] }),
    codeRunTests: async () => ({ exitCode: 0, counts: { known: false } })
  };

  const loop = new CodingLoop({ coding, outputModule, toolRegistry });
  return { root, workspace, registry, loop, deployCalls, gitCalls, commitCalls, coding };
}

function deploySpec() {
  return normalizeDeploy({ command: process.execPath, args: ['deploy.js'] });
}

function healthStage(url) {
  return { id: 'health', kind: 'health', check: { url } };
}

function cleanup(harness) {
  fs.rmSync(harness.root, { recursive: true, force: true });
}

test('端到端：部署 → 健康检查 200 → passed，且同一刺激序列轨迹完全一致', async () => {
  const server = createServer({ healthStatus: 200 });
  const base = await listen(server);
  const harness = makeHarness();
  try {
    const ctx = makeCtx({
      stages: normalizeStages([healthStage(`${base}/health`)]),
      deploy: deploySpec()
    });

    const first = makeRun(ctx);
    await harness.loop.drive(first, ctx, Date.now() + 30000);

    assert.equal(first.status, 'passed');
    assert.equal(first.verdict, 'verified');
    assert.deepEqual(buildTrajectory(first), [{ round: 1, stageId: 'health', ok: true }]);
    assert.equal(first.stageCommits.length, 1);
    assert.equal(first.stageCommits[0].stageId, 'health');
    assert.equal(first.lastGreen, first.stageCommits[0].sha);

    // 部署真的执行了：退出码、日志、产物都可见
    assert.equal(harness.deployCalls.length, 1);
    const deployed = harness.deployCalls[0];
    assert.ok(deployed.options.deploy, '闭环应把 deploy 声明透传给工具上下文');
    assert.equal(deployed.result.success, true);
    assert.equal(deployed.result.ok, true);
    assert.equal(deployed.result.exitCode, 0);
    assert.match(deployed.result.stdout, /release built/);
    assert.ok(fs.existsSync(path.join(harness.workspace, 'dist', 'release.txt')));

    // 同一刺激序列再跑一次：轨迹逐项一致
    const second = makeRun(ctx);
    await harness.loop.drive(second, ctx, Date.now() + 30000);
    assert.equal(second.status, 'passed');
    const comparison = compareTrajectories(buildTrajectory(first), buildTrajectory(second));
    assert.deepEqual(comparison, { match: true, divergence: null });
  } finally {
    cleanup(harness);
    await close(server);
  }
});

test('端到端：第 1 轮健康检查 500、第 2 轮恢复 → 轨迹记录两轮并定位首个分歧', async () => {
  const server = createServer({ healthStatus: 500 });
  const base = await listen(server);
  const harness = makeHarness();
  try {
    // 模拟「第 1 轮失败后完成修复」：等首轮判据落定，再把服务切回健康
    harness.loop.emitEvent = (event) => {
      if (event.kind === 'check' && event.iteration === 1) server.state.healthStatus = 200;
    };

    const ctx = makeCtx({
      maxIterations: 2,
      stages: normalizeStages([healthStage(`${base}/health`)]),
      deploy: deploySpec()
    });
    const run = makeRun(ctx);
    await harness.loop.drive(run, ctx, Date.now() + 30000);

    assert.equal(run.status, 'passed');
    assert.equal(run.verdict, 'verified');
    assert.deepEqual(buildTrajectory(run), [
      { round: 1, stageId: 'health', ok: false },
      { round: 2, stageId: 'health', ok: true }
    ]);
    // 只有第 2 轮通过后才提交检查点；第 1 轮没有可回滚的安全点
    assert.equal(run.stageCommits.length, 1);
    assert.equal(run.stageCommits[0].stageId, 'health');
    assert.equal(run.rolledBackTo, '');
    assert.equal(harness.deployCalls.length, 2);

    // 与「一次就过」的基线比对：首个分歧应定位到第 1 轮 health 的 ok
    const baseline = [
      { round: 1, stageId: 'health', ok: true },
      { round: 2, stageId: 'health', ok: true }
    ];
    const comparison = compareTrajectories(baseline, buildTrajectory(run));
    assert.equal(comparison.match, false);
    assert.equal(comparison.divergence.index, 0);
    assert.equal(comparison.divergence.round, 1);
    assert.equal(comparison.divergence.stageId, 'health');
    assert.equal(comparison.divergence.field, 'ok');
  } finally {
    cleanup(harness);
    await close(server);
  }
});

test('端到端：只读信任档下 code_deploy 被拒绝，部署脚本不执行', async () => {
  const harness = makeHarness({ trust: 'readonly' });
  try {
    harness.registry.setActiveContext({
      sessionId: 's_e2e',
      userId: 'u_e2e',
      taskId: 't_e2e',
      origin: 'coding',
      scope: 'ai',
      deploy: deploySpec()
    });

    const raw = await harness.registry.execute('code_deploy', {});
    const result = JSON.parse(raw);
    assert.equal(result.approved, false);
    assert.equal(result.executed, false);
    assert.match(result.reason, /只读/);
    assert.equal(fs.existsSync(path.join(harness.workspace, 'dist', 'release.txt')), false);
  } finally {
    cleanup(harness);
  }
});
