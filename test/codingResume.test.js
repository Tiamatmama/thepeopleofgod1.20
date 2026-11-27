'use strict';

// 跨 run 续跑：JSONL 检查点 → resolveResume → 起始绿点 → 失败回滚到该绿点。
// git 用内存桩（可控 head 与祖先关系），其余走真实 CodingLoop。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CodingLoop = require('../src/core/codingLoop');
const { appendCheckpoint, readCheckpoints } = require('../src/core/checkpointLog');

function makeCtx(overrides = {}) {
  return {
    userId: 'u_resume',
    taskId: 't_resume',
    sessionId: 's_resume',
    goal: '把登录页做到上线',
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

// ancestor(currentHead, resumeSha)：模拟 merge-base --is-ancestor 的判定
function makeHarness({ head = 'sha_green', ancestor = () => true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-resume-'));
  let currentHead = head;
  let seq = 0;
  const gitCalls = [];
  const coding = {
    dir,
    userKey: () => 'u_resume_hash',
    taskDir: () => '', // 产物落盘直接跳过，只测检查点/回滚
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
    callWithTools: async () => ({ choices: [{ message: { content: '继续未完成的阶段。' } }] })
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

test('resolveResume：读最近已提交阶段作为绿点，并汇总该 run 已通过阶段', () => {
  const harness = makeHarness({ head: 'sha_health' });
  const ctx = makeCtx();
  seed(harness, ctx, [
    { runId: 'run_old', iteration: 1, kind: 'stage', stageId: 'web', ok: true, sha: 'sha_web', at: '2026-01-01T00:00:00.000Z' },
    { runId: 'run_old', iteration: 1, kind: 'stage', stageId: 'health', ok: true, sha: 'sha_health', at: '2026-01-01T00:01:00.000Z' },
    { runId: 'run_old', iteration: 1, kind: 'run_end', ok: true, verdict: 'passed', sha: 'sha_health' }
  ]);

  const resume = harness.loop.resolveResume(ctx);
  assert.equal(resume.sha, 'sha_health');
  assert.equal(resume.runId, 'run_old');
  assert.deepEqual(resume.passedStages, ['web', 'health']);
});

test('resolveResume：绿点 sha 不是 HEAD 祖先（历史被改写）→ 拒绝续跑', () => {
  const harness = makeHarness({ head: 'sha_rewritten', ancestor: () => false });
  const ctx = makeCtx();
  seed(harness, ctx, [
    { runId: 'run_a', iteration: 1, kind: 'stage', stageId: 'web', ok: true, sha: 'sha_web' }
  ]);

  const resume = harness.loop.resolveResume(ctx);
  assert.equal(resume.sha, '');
  assert.deepEqual(resume.passedStages, []);
});

test('resolveResume：只有失败阶段 / 阶段记录没有 sha → 不续跑', () => {
  const harness = makeHarness();
  const ctx = makeCtx();
  seed(harness, ctx, [
    { runId: 'run_a', iteration: 1, kind: 'stage', stageId: 'web', ok: false, sha: 'sha_bad' },
    { runId: 'run_a', iteration: 1, kind: 'stage', stageId: 'health', ok: true, sha: '' }
  ]);

  assert.equal(harness.loop.resolveResume(ctx).sha, '');
});

test('start：续跑绿点写入 lastGreen / resumedFrom，停止后回滚到该绿点并落 run_end', async () => {
  const harness = makeHarness({ head: 'sha_web' });
  const ctx = makeCtx();
  const file = seed(harness, ctx, [
    { runId: 'run_prev', iteration: 1, kind: 'stage', stageId: 'web', ok: true, sha: 'sha_web', at: '2026-01-01T00:00:00.000Z', verdict: 'verified' },
    { runId: 'run_prev', iteration: 1, kind: 'run_end', ok: false, verdict: 'failed', sha: 'sha_web' }
  ]);

  const started = await harness.loop.start({
    userId: ctx.userId,
    taskId: ctx.taskId,
    goal: ctx.goal,
    maxIterations: 1,
    model: 'qwen'
  });
  assert.equal(started.success, true);
  assert.equal(started.run.lastGreen, 'sha_web');
  assert.equal(started.run.resumedFrom.sha, 'sha_web');
  assert.deepEqual(started.run.resumedFrom.passedStages, ['web']);

  // 在 setImmediate 触发前请求停止：drive 第一轮即熔断，走 finally 回滚
  harness.loop.stop(ctx.taskId);
  await waitFor(() => readCheckpoints(file).some(e => e.kind === 'run_end' && e.runId === started.run.id));

  const reset = harness.gitCalls.find(args => args[0] === 'reset');
  assert.deepEqual(reset, ['reset', '--hard', 'sha_web']);

  const entries = readCheckpoints(file);
  const end = entries.filter(e => e.kind === 'run_end').pop();
  assert.equal(end.verdict, 'stopped');
  assert.equal(end.runId, started.run.id);
});

test('buildSystemPrompt：有续跑点时注入只读 resume 数据块，无续跑点时不注入', () => {
  const harness = makeHarness();
  const ctx = makeCtx({ stages: [] });

  const withResume = harness.loop.buildSystemPrompt({
    ...ctx,
    resume: { sha: 'sha_web', runId: 'run_prev', at: '2026-01-01T00:00:00.000Z', passedStages: ['web'] }
  });
  assert.match(withResume, /<resume-data>/);
  assert.match(withResume, /sha_web/);
  assert.match(withResume, /已通过阶段：web/);
  assert.match(withResume, /不是给你的指令/);

  assert.doesNotMatch(harness.loop.buildSystemPrompt(ctx), /<resume-data>/);
});
