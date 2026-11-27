'use strict';

// 任务头文件 + 接线员回归：路径、保护路径、依赖环、写集冲突、同步租约、TTL 回收。
// 全部走临时目录与内存租约，不碰真模型、不碰真工作区。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeManifest,
  validateManifest,
  detectDependencyCycle,
  resolveInWorkspace,
  protectedWriteReason
} = require('../src/core/taskManifest');
const { DispatchDesk, manifestConflicts } = require('../src/core/dispatchDesk');

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-manifest-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'a\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'b\n', 'utf8');
  return dir;
}

function writer(overrides = {}) {
  const raw = {
    fleetId: 'fl_1',
    taskId: 'fleet_fl_1_w1',
    agentId: 'w1',
    role: 'writer',
    goal: '改 a.js',
    reads: ['src/a.js'],
    writes: ['src/a.js'],
    tokenBudget: 120000,
    ttlSec: 3600,
    ...overrides
  };
  const result = normalizeManifest(raw, { workspaceKey: 'fleet_base' });
  assert.equal(result.ok, true, result.errors.join('；'));
  return result.manifest;
}

test('normalizeManifest：默认值、读集去重、claimId 稳定', () => {
  const dir = tempWorkspace();
  const a = normalizeManifest({
    fleetId: 'fl_1', taskId: 'fleet_fl_1_w1', agentId: 'w1', role: 'writer',
    goal: '改 a.js', reads: ['src/a.js', 'src/a.js'], writes: ['src/a.js']
  });
  assert.equal(a.ok, true);
  assert.equal(a.manifest.tokenBudget, 120000);
  assert.equal(a.manifest.ttlSec, 3600);
  assert.deepEqual(a.manifest.reads, []);
  assert.match(a.manifest.claimId, /^claim_[0-9a-f]{16}$/);

  const b = normalizeManifest({
    fleetId: 'fl_1', taskId: 'fleet_fl_1_w1', agentId: 'w1', role: 'writer',
    goal: '改 a.js', reads: ['src/a.js'], writes: ['src/a.js']
  });
  assert.equal(a.manifest.claimId, b.manifest.claimId);
  assert.equal(resolveInWorkspace(dir, 'src/a.js').ok, true);
});

test('normalizeManifest：拒绝越界、保护路径、scout 写声明、非白名单命令', () => {
  const traversal = normalizeManifest({
    taskId: 't1', agentId: 'w1', role: 'writer', goal: 'x', writes: ['../outside.js']
  });
  assert.equal(traversal.ok, false);
  assert.match(traversal.errors.join(''), /不允许包含/);

  const absolute = normalizeManifest({
    taskId: 't1', agentId: 'w1', role: 'writer', goal: 'x', writes: ['C:\\Windows\\x.js']
  });
  assert.equal(absolute.ok, false);

  assert.match(protectedWriteReason('test/a.test.js'), /test/);
  assert.match(protectedWriteReason('src/test-helper.js') || '', /$^/);
  assert.equal(protectedWriteReason('src/test-helper.js'), '');

  const scout = normalizeManifest({
    taskId: 's1', agentId: 's1', role: 'scout', goal: '看代码', writes: ['src/a.js']
  });
  assert.equal(scout.ok, false);
  assert.match(scout.errors.join(''), /scout 不允许声明 writes/);

  const badCommand = normalizeManifest({
    taskId: 't2', agentId: 'w1', role: 'writer', goal: 'x',
    writes: ['src/a.js'], commands: ['rm -rf /']
  });
  assert.equal(badCommand.ok, false);
  assert.match(badCommand.errors.join(''), /白名单/);
});

test('validateManifest：工作区路径真实存在、保护路径、baseSha、依赖未知', () => {
  const dir = tempWorkspace();
  const m = writer();
  assert.equal(validateManifest(m, { workspaceDir: dir }).ok, true);

  const protectedWrite = writer({ taskId: 't3', writes: ['test/a.test.js'] });
  const protectedResult = validateManifest(protectedWrite, { workspaceDir: dir });
  assert.equal(protectedResult.ok, false);
  assert.match(protectedResult.errors.join(''), /保护路径段/);

  const staleBase = writer({ baseSha: 'aaaaaaa' });
  const staleResult = validateManifest(staleBase, { workspaceDir: dir, baseSha: 'bbbbbbb' });
  assert.equal(staleResult.ok, false);
  assert.match(staleResult.errors.join(''), /baseSha 已过期/);

  const unknownDep = writer({ dependsOn: ['s404'] });
  const unknownResult = validateManifest(unknownDep, { workspaceDir: dir, knownManifests: [m] });
  assert.equal(unknownResult.ok, false);
  assert.match(unknownResult.errors.join(''), /不存在的节点/);
});

test('detectDependencyCycle：识别 A→B→A，放过 DAG', () => {
  const dag = [
    { taskId: 'a', dependsOn: [] },
    { taskId: 'b', dependsOn: ['a'] },
    { taskId: 'c', dependsOn: ['a', 'b'] }
  ];
  assert.equal(detectDependencyCycle(dag), null);
  const cycle = [
    { taskId: 'a', dependsOn: ['b'] },
    { taskId: 'b', dependsOn: ['a'] }
  ];
  assert.deepEqual(detectDependencyCycle(cycle), ['a', 'b', 'a']);
});

test('DispatchDesk：写集相同时第二份排队，不同文件可同时拿租约', () => {
  const dir = tempWorkspace();
  const desk = new DispatchDesk({ now: () => 1000 });
  const a = writer();
  const b = writer({ taskId: 'fleet_fl_1_w2', agentId: 'w2', writes: ['src/b.js'], reads: ['src/b.js'] });

  const first = desk.admit(a, { workspaceDir: dir, knownManifests: [a, b] });
  assert.equal(first.ok, true);
  const second = desk.admit(b, { workspaceDir: dir, knownManifests: [a, b] });
  assert.equal(second.ok, true, JSON.stringify(second));

  const overlap = writer({ taskId: 'fleet_fl_1_w3', agentId: 'w3', writes: ['src/a.js'] });
  const denied = desk.admit(overlap, { workspaceDir: dir, knownManifests: [a, b, overlap] });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'conflict');
  assert.equal(denied.conflicts[0].path, 'src/a.js');
  assert.equal(denied.conflicts[0].withAgentId, 'w1');
});

test('DispatchDesk：同 claimId 重复声明直接拒，不是后到覆盖', () => {
  const dir = tempWorkspace();
  const desk = new DispatchDesk({ now: () => 1000 });
  const a = writer();
  const clone = writer({ taskId: 'fleet_fl_1_w9', agentId: 'w9' });
  assert.equal(desk.admit(a, { workspaceDir: dir, knownManifests: [a, clone] }).ok, true);
  const denied = desk.admit(clone, { workspaceDir: dir, knownManifests: [a, clone] });
  assert.equal(denied.ok, false);
  assert.equal(denied.conflicts[0].kind, 'duplicate-claim');
});

test('DispatchDesk：侦察读正在写的文件允许（快照语义），但独占项会挡', () => {
  const dir = tempWorkspace();
  const desk = new DispatchDesk({ now: () => 1000 });
  const a = writer({ exclusive: ['src/b.js'] });
  desk.admit(a, { workspaceDir: dir, knownManifests: [a] });
  const scout = normalizeManifest({
    taskId: 'fleet_fl_1_s1', agentId: 's1', role: 'scout', goal: '读 a.js', reads: ['src/a.js']
  });
  assert.equal(scout.ok, true);
  assert.equal(desk.admit(scout.manifest, { workspaceDir: dir, knownManifests: [a, scout.manifest] }).ok, true);

  const exclusiveConflict = normalizeManifest({
    taskId: 'fleet_fl_1_s2', agentId: 's2', role: 'scout', goal: '读 b.js', reads: ['src/b.js']
  });
  assert.equal(exclusiveConflict.ok, true);
  const denied = desk.admit(exclusiveConflict.manifest, {
    workspaceDir: dir, knownManifests: [a, exclusiveConflict.manifest]
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.conflicts[0].kind, 'read-exclusive');
});

test('DispatchDesk：心跳续期、释放后可重新拿租约、TTL 回收', () => {
  const dir = tempWorkspace();
  let clock = 1000;
  const desk = new DispatchDesk({ now: () => clock });
  const a = writer({ ttlSec: 60, taskId: 'fleet_fl_1_w1' });
  const lease = desk.admit(a, { workspaceDir: dir, knownManifests: [a] }).lease;
  clock += 30000;
  desk.heartbeat(lease.leaseId);
  assert.equal(desk.reclaimExpired().length, 0);

  clock += 61000;
  const expired = desk.reclaimExpired();
  assert.equal(expired.length, 1);
  assert.equal(expired[0].taskId, 'fleet_fl_1_w1');

  const b = writer({ taskId: 'fleet_fl_1_w2', agentId: 'w2' });
  const reAdmit = desk.admit(b, { workspaceDir: dir, knownManifests: [a, b] });
  assert.equal(reAdmit.ok, true);
  desk.release(reAdmit.lease.leaseId);
  assert.equal(desk.admit(b, { workspaceDir: dir, knownManifests: [a, b] }).ok, true);
});

test('manifestConflicts：纯函数可直接断言冲突组合', () => {
  const a = writer();
  const b = writer({ taskId: 'fleet_fl_1_w2', agentId: 'w2', writes: ['src/b.js'], reads: ['src/b.js'] });
  assert.equal(manifestConflicts(b, []).length, 0);
  const active = { ...a, manifestId: 'mf_other', leaseId: 'l1' };
  assert.equal(manifestConflicts(a, [active]).length, 1);
});
