'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SandboxAgents } = require('../src/core/sandboxAgents');
const SandboxExec = require('../src/core/sandboxExec');

function makeLog() {
  return {
    lines: [],
    ended: false,
    write(text) { this.lines.push(String(text)); },
    end() { this.ended = true; }
  };
}

function makeRun(overrides = {}) {
  return {
    runId: 'cc_test',
    owner: 'alice',
    taskId: 'task_1',
    title: '修复登录',
    status: 'running',
    exitCode: null,
    endedAt: '',
    result: '已修改登录逻辑',
    error: '',
    stopRequested: false,
    updateTask: true,
    child: {},
    lastText: '已修改登录逻辑',
    ...overrides
  };
}

function makeHarness({ params = {}, evaluate = null, runStages = null, commitCheckpoint = null, withLoop = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-agents-'));
  const updates = [];
  const events = [];
  const calls = { evaluate: [], runStages: [], commit: [] };
  const coding = {
    listTasks() {
      return [{ id: 'task_1', params }];
    },
    updateTask(id, patch) {
      updates.push({ id, patch });
      return { success: true };
    }
  };
  const codingLoop = withLoop ? {
    async evaluate(ctx, run, criteria) {
      calls.evaluate.push({ ctx, run, criteria });
      if (evaluate) return evaluate(ctx, run, criteria);
      return { ok: true, reason: '静态诊断与测试均通过' };
    },
    async runStages(ctx, run, relay, criteria) {
      calls.runStages.push({ ctx, run, criteria });
      if (runStages) return runStages(ctx, run, criteria);
      return { ok: true, verdict: 'verified', results: [] };
    },
    commitCheckpoint(userId, taskId, message) {
      calls.commit.push({ userId, taskId, message });
      if (commitCheckpoint) return commitCheckpoint(userId, taskId, message);
      return 'sha_green';
    }
  } : null;
  const agents = new SandboxAgents({
    coding,
    codingLoop,
    projectRoot: root,
    onEvent(event) { events.push(event); }
  });
  return { root, agents, updates, events, calls };
}

async function finalize(harness, run = makeRun(), code = 0) {
  const log = makeLog();
  await harness.agents.finalizeRun(run, code, log);
  return { run, log };
}

test('Claude Code 正常退出后：验收通过才 done，并记录检查点', async (t) => {
  const harness = makeHarness({ params: { passCommand: 'npm test' } });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const { run, log } = await finalize(harness);

  assert.equal(run.status, 'done');
  assert.equal(run.verification.ok, true);
  assert.equal(run.verification.commitSha, 'sha_green');
  assert.equal(harness.calls.evaluate[0].criteria.passCommand, 'npm test');
  assert.equal(harness.calls.commit.length, 1);
  assert.equal(harness.updates[0].patch.status, 'done');
  assert.equal(log.ended, true);
});

test('Claude Code 正常退出但验收失败：不得 done，任务回 todo 并留下原因', async (t) => {
  const harness = makeHarness({
    evaluate: async () => ({ ok: false, errorKind: 'testFailure', reason: '测试未通过（failed=2/5）' })
  });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const { run } = await finalize(harness);

  assert.equal(run.status, 'failed');
  assert.equal(run.error, '测试未通过（failed=2/5）');
  assert.equal(harness.calls.commit.length, 0);
  assert.equal(harness.updates[0].patch.status, 'todo');
  assert.match(harness.updates[0].patch.result, /测试未通过/);
});

test('验收器自身异常：fail-closed，不把 CLI exit 0 当成完成', async (t) => {
  const harness = makeHarness({
    evaluate: async () => { throw new Error('诊断器崩溃'); }
  });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const { run } = await finalize(harness);

  assert.equal(run.status, 'failed');
  assert.equal(run.verification.ok, false);
  assert.match(run.error, /诊断器崩溃/);
  assert.equal(harness.updates[0].patch.status, 'todo');
});

test('验收器缺失：fail-closed，任务回 todo', async (t) => {
  const harness = makeHarness({ withLoop: false });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const { run } = await finalize(harness);

  assert.equal(run.status, 'failed');
  assert.match(run.error, /验收器不可用/);
  assert.equal(harness.updates[0].patch.status, 'todo');
});

test('阶段验收失败：基础诊断通过也不能 done', async (t) => {
  const harness = makeHarness({
    params: { stages: [{ id: 'page', kind: 'webCheck', requires: [] }] },
    runStages: async () => ({
      ok: false,
      verdict: 'failed',
      results: [{ stageId: 'page', ok: false, reason: '登录按钮不可点击' }]
    })
  });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const { run } = await finalize(harness);

  assert.equal(run.status, 'failed');
  assert.equal(harness.calls.runStages.length, 1);
  assert.match(run.error, /登录按钮不可点击/);
  assert.equal(harness.updates[0].patch.status, 'todo');
});

test('CLI 非零退出与手动停止：不重复跑验收', async (t) => {
  const harness = makeHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const failed = await finalize(harness, makeRun({ runId: 'cc_failed' }), 1);
  const stopped = await finalize(harness, makeRun({ runId: 'cc_stopped', stopRequested: true }), 0);

  assert.equal(failed.run.status, 'failed');
  assert.equal(stopped.run.status, 'stopped');
  assert.equal(harness.calls.evaluate.length, 0);
});

function makeStartHarness(sandbox, workspaceDir = null, relayToken = 'test-relay') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-agents-'));
  const bin = path.join(root, 'fake-claude.exe');
  fs.writeFileSync(bin, '');
  const updates = [];
  const events = [];
  const grants = [];
  const coding = {
    userKey: () => 'alice',
    ensureSandboxAccess: (dir) => { grants.push(dir); return { ok: true }; },
    createWorkspace: () => ({ success: true, taskId: 'task_1', dir: typeof workspaceDir === 'function' ? workspaceDir(root) : (workspaceDir || root) }),
    updateTask: (id, patch) => { updates.push(patch); return { success: true }; },
    listTasks: () => [{ id: 'task_1', params: {} }]
  };
  const agents = new SandboxAgents({
    coding,
    projectRoot: root,
    claudeBin: bin,
    sandbox,
    relayToken,
    onEvent(event) { events.push(event); }
  });
  return { root, agents, updates, events, grants };
}

// 监督通道拒绝（凭据缺失/沙箱关闭）时不能悄悄退回宿主账户，任务要退回 todo
test('启动被监督通道拒绝：不产生 agent_start，任务回 todo', async (t) => {
  const harness = makeStartHarness({
    startStreamed: () => ({
      success: false,
      error: '已拒绝启动：凭据文件缺失，请以管理员身份重新运行 scripts\\sandbox-setup.ps1',
      sandbox: { degraded: true, reason: 'credential_missing' }
    })
  });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const result = harness.agents.start({ userId: 'alice', prompt: '把登录页的按钮修好' });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(result.success, false);
  assert.match(result.error, /已拒绝启动/);
  assert.equal(harness.events.some((event) => event.kind === 'agent_start'), false);
  // 第一条是 claimTask 的 doing，最后一条必须是退回 todo 的失败回写
  assert.equal(harness.updates[0].status, 'doing');
  assert.equal(harness.updates.at(-1).status, 'todo');
  assert.match(harness.updates.at(-1).result, /已拒绝启动/);
});

// prompt 必须走 stdin：命令行里不能出现用户输入，宿主环境也不能整体继承
test('启动走监督通道：prompt 走 stdin，环境只带白名单配置', async (t) => {
  let captured = null;
  const harness = makeStartHarness({
    startStreamed: (bin, args, options) => {
      captured = { bin, args, options };
      return {
        success: true,
        pid: 4242,
        stop() { captured.stopped = true; },
        promise: Promise.resolve({ success: true, exitCode: 0, sandbox: { mode: 'account', degraded: false, reason: 'exited' } })
      };
    }
  });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const prompt = '把登录页的按钮修好\n并且补一条测试';
  const result = harness.agents.start({ userId: 'alice', prompt });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(result.success, true);
  assert.equal(captured.args.includes(prompt), false, 'prompt 不能进命令行');
  assert.equal(captured.options.promptText, prompt);
  assert.equal(captured.options.cwd, harness.root);
  assert.equal(captured.options.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:41888/relay');
  // 令牌必须来自中转站配置：写死的假值会被中转站 403 挡回来，CLI 只能在日志里留一句认证失败
  assert.equal(captured.options.env.ANTHROPIC_AUTH_TOKEN, 'test-relay');
  assert.equal(captured.options.env.PATH, undefined, '宿主环境不能被带进沙箱');

  const run = harness.agents.list('alice')[0];
  assert.equal(run.sandbox.mode, 'account');
  // 没有验收器时 fail-closed：CLI 退出 0 也不能算完成
  assert.equal(run.status, 'failed');
  assert.equal(harness.updates.at(-1).status, 'todo');
});

// 沙箱账户读不到安装目录时只回一句 Access is denied，必须翻译成可执行的修复步骤
test('沙箱账户读不到 Claude Code：失败原因要给出修复步骤', async (t) => {
  const harness = makeStartHarness({
    startStreamed: () => ({
      success: true,
      pid: 4243,
      stop() {},
      promise: Promise.resolve({
        success: false,
        exitCode: 5,
        stderr: 'Access is denied.\r\n',
        error: '进程非零退出',
        sandbox: { mode: 'account', degraded: false, reason: 'exited' }
      })
    })
  });
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  harness.agents.start({ userId: 'alice', prompt: '修登录页' });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const run = harness.agents.list('alice')[0];
  assert.equal(run.status, 'failed');
  assert.match(run.error, /sandbox-setup\.ps1/);
  assert.match(run.error, /SANDBOX_CLAUDE_BIN/);
  assert.equal(harness.updates.at(-1).status, 'todo');
});

// 导入的工作区是指向项目外的 junction：realpath 之后落在项目外，
// 只认 projectRoot 就会判「工作目录不可用」，必须把当前工作区这一条真实路径放行
test('工作区是项目外 junction：allowedRoots 要把该工作区放行', async (t) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-agents-outside-'));
  let wsDir = '';
  let captured = null;
  const harness = makeStartHarness({
    startStreamed: (bin, args, options) => {
      captured = options;
      return {
        success: true,
        pid: 4244,
        stop() {},
        promise: Promise.resolve({
          success: true,
          exitCode: 0,
          sandbox: { mode: 'account', degraded: false, reason: 'exited' }
        })
      };
    }
  }, (root) => {
    wsDir = path.join(root, 'data', 'coding', 'workspaces', 'alice', 'task_1');
    fs.mkdirSync(path.dirname(wsDir), { recursive: true });
    fs.symlinkSync(outside, wsDir, 'junction');
    return wsDir;
  });
  t.after(() => {
    try { fs.unlinkSync(wsDir); } catch { /* 链接已被删掉 */ }
    fs.rmSync(harness.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const result = harness.agents.start({ userId: 'alice', prompt: '改一下这个项目' });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(result.success, true);
  assert.ok(Array.isArray(captured.allowedRoots), 'allowedRoots 必须是数组');
  // cwd 必须钉到真实路径：cwd 是 junction 时 Claude Code 的 Write 工具会判
  // 「symlink resolution changed after permission was checked」，只能退回 bash 写文件
  assert.equal(captured.cwd, fs.realpathSync(wsDir));
  // 老工作区可能从没跑过命令，沙箱账户在这个真实目录上没有任何 ACE，写入会直接失败
  assert.equal(harness.grants.length, 1, '启动前必须补一次工作区授权');
  assert.equal(harness.grants[0], wsDir);
  // 用真实的解析逻辑验一遍：没传 allowedRoots 时这里返回 null，启动会被直接拒绝
  const exec = new SandboxExec({ projectRoot: harness.root });
  assert.equal(exec.resolveCwd(wsDir, captured.allowedRoots), fs.realpathSync(wsDir));
});

// 中转站一律要求令牌：写死假值只会得到一个 403，任务板看不出原因。
// 没有令牌必须在启动前就拦下来，并明确告诉用户去哪里填
test('中转站没配访问令牌：启动前拒绝，并指出要填哪里', async (t) => {
  let launched = false;
  const harness = makeStartHarness({
    startStreamed: () => { launched = true; return { success: true, pid: 4245, stop() {}, promise: Promise.resolve({}) }; }
  }, null, '');
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  const result = harness.agents.start({ userId: 'alice', prompt: '写个 hello 跑通' });

  assert.equal(result.success, false);
  assert.equal(result.code, 'relay_token_missing');
  assert.match(result.error, /中转站/);
  assert.equal(launched, false, '没有令牌不能真的去启动 CLI');
  assert.equal(harness.grants.length, 0, '没令牌时不必先补工作区授权');
});
