'use strict';

// 16-Agent 中枢回归：4 写手 + 12 侦察的编制、manifest 落库、派发/合并/收尾、
// 以及监控员的越界写对账。全部用注入的假执行器，不调模型、不跑真 git。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentFleet } = require('../src/core/agentFleet');
const { DispatchDesk } = require('../src/core/dispatchDesk');
const { FleetMonitor, findUndeclaredChanges } = require('../src/core/fleetMonitor');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
}

function makeCoding(root) {
  return {
    safeTaskId(id) {
      return /^[A-Za-z0-9_-]{1,80}$/.test(String(id || '')) ? String(id) : '';
    },
    taskDir(userId, taskId) {
      return path.join(root, 'ws', String(userId || 'u'), String(taskId || ''));
    },
    createWorkspace(userId, taskId) {
      const dir = this.taskDir(userId, taskId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.gitignore'), '.git/\n', 'utf8');
      return { success: true, dir };
    },
    git() {
      return { success: true, output: 'abc1234' };
    },
    gitCommit() {
      return { success: true, output: 'ok' };
    },
    setTrustLevel() {
      return { success: true };
    }
  };
}

function plannedFixture(fleetId, writers = 4, scouts = 12) {
  const result = { writers: [], scouts: [] };
  for (let i = 1; i <= writers; i++) {
    result.writers.push({
      goal: `改 w${i}.js`,
      reads: [`src/w${i}.js`],
      writes: [`src/w${i}.js`],
      exclusive: [],
      commands: [],
      dependsOn: []
    });
  }
  for (let i = 1; i <= scouts; i++) {
    result.scouts.push({ goal: `侦察 s${i}`, reads: [`src/w${((i - 1) % writers) + 1}.js`] });
  }
  return result;
}

function makePlanner(writers = 4, scouts = 12) {
  return async () => plannedFixture('', writers, scouts);
}

function seedBase(root, userId, baseTaskId, writers = 4) {
  const dir = path.join(root, 'ws', userId, baseTaskId);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (let i = 1; i <= writers; i++) {
    fs.writeFileSync(path.join(dir, 'src', `w${i}.js`), `w${i}\n`, 'utf8');
  }
  return dir;
}

test('AgentFleet.plan：4 写手 + 12 侦察，manifest 落盘，不启动执行', async () => {
  const root = tempDir();
  const coding = makeCoding(root);
  const fleet = new AgentFleet({
    coding,
    codingLoop: {},
    outputModule: {},
    dataDir: path.join(root, 'fleets'),
    pollMs: 10,
    services: { plan: makePlanner(4, 12) }
  });
  const result = await fleet.plan({ userId: 'u1', goal: '拆一个中任务', writers: 4, scouts: 12 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.fleet.slots.length, 16);
  assert.equal(result.fleet.slots.filter(s => s.role === 'writer').length, 4);
  assert.equal(result.fleet.slots.filter(s => s.role === 'scout').length, 12);
  assert.equal(result.manifests.every(item => item.baseSha === ''), true);
  assert.equal(fs.existsSync(path.join(root, 'fleets', `${result.fleet.id}.json`)), true);

  const loaded = fleet.status(result.fleet.id, 'u1');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.fleet.status, 'planned');
  assert.equal(fleet.status(result.fleet.id, 'u2').ok, false, '跨用户不可读');
});

test('AgentFleet.plan：规划数量不足时直接拒绝，不拿空槽凑数', async () => {
  const root = tempDir();
  const fleet = new AgentFleet({
    coding: makeCoding(root),
    codingLoop: {},
    outputModule: {},
    dataDir: path.join(root, 'fleets'),
    services: { plan: makePlanner(1, 0) }
  });
  const result = await fleet.plan({ userId: 'u1', goal: 'x', writers: 4, scouts: 12 });
  assert.equal(result.ok, false);
  assert.match(result.error, /规划结果不完整/);
});

test('AgentFleet.dispatch：16 槽全跑完，写手合并、侦察落 findings、验收通过', async () => {
  const root = tempDir();
  const coding = makeCoding(root);
  const desk = new DispatchDesk();
  const runs = new Map();
  const fleet = new AgentFleet({
    coding,
    codingLoop: {
      start(params) {
        runs.set(params.taskId, { id: `run_${params.taskId}`, status: 'running' });
        return { success: true, run: { id: `run_${params.taskId}` } };
      },
      latestRun(taskId) {
        return runs.get(taskId) || null;
      },
      stop() { return { success: true }; }
    },
    outputModule: {},
    dataDir: path.join(root, 'fleets'),
    pollMs: 10,
    dispatchDesk: desk,
    scout: {
      run(manifest) {
        return Promise.resolve({ ok: true, taskId: manifest.taskId, status: 'done', findings: `发现 ${manifest.taskId}`, usage: 10 });
      },
      stopAll() {}
    },
    services: {
      plan: makePlanner(4, 12),
      provisionWorkspaces(f) {
        seedBase(root, f.userId, f.baseTaskId, 4);
        f.baseSha = 'abc1234';
        f.manifests.forEach(item => { item.baseSha = 'abc1234'; });
        return { ok: true };
      },
      mergeWriter() {
        return { ok: true, baseSha: 'newsha' };
      },
      verifyMerged() {
        return { ok: true, checks: [] };
      }
    }
  });

  const planned = await fleet.plan({ userId: 'u1', goal: '四个小任务', writers: 4, scouts: 12 });
  assert.equal(planned.ok, true);
  const dispatched = await fleet.dispatch({ userId: 'u1', fleetId: planned.fleet.id });
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched));

  // 让假闭环在下一轮被判定为 passed；轮询等收尾
  runs.forEach((run) => {
    run.status = 'passed';
    run.tokenUsage = { billed: 100 };
  });

  const deadline = Date.now() + 1500;
  let snapshot = fleet.status(planned.fleet.id, 'u1').fleet;
  while (Date.now() < deadline && !['done', 'partial', 'failed', 'stopped'].includes(snapshot.status)) {
    await new Promise(resolve => setTimeout(resolve, 20));
    runs.forEach((run) => {
      run.status = 'passed';
      run.tokenUsage = { billed: 100 };
    });
    snapshot = fleet.status(planned.fleet.id, 'u1').fleet;
  }
  assert.ok(['done', 'partial'].includes(snapshot.status), `最终状态 ${snapshot.status}`);
  assert.equal(snapshot.slots.filter(s => s.role === 'writer' && s.status === 'merged').length, 4);
  assert.equal(snapshot.slots.filter(s => s.role === 'scout' && s.status === 'done').length, 12);
  assert.equal(snapshot.verification.ok, true);
  assert.equal(fleet.dispatchDesk.activeLeases().length, 0, '收尾必须释放全部租约');
});

test('AgentFleet：预算耗尽后未启动槽位标记 budget_exhausted', async () => {
  const root = tempDir();
  const fleet = new AgentFleet({
    coding: makeCoding(root),
    codingLoop: { stop() {} },
    outputModule: {},
    dataDir: path.join(root, 'fleets'),
    pollMs: 10,
    scout: { run: () => Promise.resolve({ ok: true, findings: 'x', usage: 100 }), stopAll() {} },
    services: {
      plan: makePlanner(4, 12),
      verifyMerged() { return { ok: true, checks: [] }; },
      mergeWriter() { return { ok: true, baseSha: 'abc' }; }
    }
  });
  const planned = await fleet.plan({ userId: 'u1', goal: '预算测试', writers: 4, scouts: 12, tokenBudget: 10000 });
  assert.equal(planned.ok, true);
  // 不进入 dispatch（会启后台循环 + 监控定时器），直接驱动一次 step 验证预算熔断。
  const f = fleet.load(planned.fleet.id);
  f.status = 'running';
  f.tokenBudget = 10000;
  f.slots.filter(slot => slot.role === 'writer').forEach(slot => { slot.usage = 5000; });
  await fleet.step(f);
  assert.equal(f.status, 'budget_exhausted');
  assert.ok(f.slots.some(slot => slot.status === 'budget_exhausted'));
  assert.equal(f.usedTokens, 20000);
});

test('FleetMonitor：越界写被识别并释放租约；闭环自产物不算越界', async () => {
  const desk = new DispatchDesk();
  const manifest = {
    manifestId: 'mf_1', fleetId: 'fl_1', taskId: 'fleet_1_w1', agentId: 'w1', role: 'writer',
    reads: [], writes: ['src/a.js'], exclusive: [], claimId: 'claim_x', baseSha: 'abc1234', ttlSec: 3600
  };
  const admitted = desk.admit(manifest, {
    workspaceDir: tempDir(), knownManifests: [manifest]
  });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  const violations = [];
  const monitor = new FleetMonitor({
    desk,
    inspect: () => ({ heartbeat: true, changedPaths: ['src/a.js', 'AGENTS.md', 'test/evil.js'] }),
    onViolation: (lease, paths) => violations.push({ taskId: lease.taskId, paths })
  });
  const result = await monitor.tick();
  assert.equal(result.violations.length, 1);
  assert.deepEqual(violations[0].paths, ['test/evil.js']);
  assert.equal(desk.activeLeases().length, 0, '越界后租约必须释放');
});

test('findUndeclaredChanges：只报未声明且非闭环自产物', () => {
  assert.deepEqual(
    findUndeclaredChanges(['src/a.js', 'AGENTS.md', 'src/b.js'], ['src/a.js']),
    ['src/b.js']
  );
});
