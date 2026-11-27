'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ResourceGuard,
  dirSize,
  formatBytes,
  isQuietHour,
  windowAverage
} = require('../src/core/resourceGuard');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pog-guard-'));
}

function writeBytes(file, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 1));
}

test('G1：dirSize 递归统计文件，缺失目录按 0', () => {
  const root = tempRoot();
  try {
    writeBytes(path.join(root, 'a', 'x.bin'), 100);
    writeBytes(path.join(root, 'a', 'b', 'y.bin'), 50);
    assert.equal(dirSize(path.join(root, 'a')), 150);
    assert.equal(dirSize(path.join(root, 'missing')), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('G2：磁盘 80% 告警、95% 拒绝，并把 incoming 算进去', () => {
  const root = tempRoot();
  try {
    const buckets = { datasets: 1000, assets: 1000, weights: 1000, workspace: 1000 };
    const guard = new ResourceGuard({ root, buckets });
    writeBytes(path.join(root, 'datasets', 'a.bin'), 810);
    const warn = guard.checkDisk('datasets', 0);
    assert.equal(warn.ok, true);
    assert.equal(warn.level, 'warn');

    const refused = guard.checkDisk('datasets', 200);
    assert.equal(refused.ok, false);
    assert.equal(refused.level, 'refuse');
    assert.equal(refused.reason, 'quota');

    const unknown = guard.checkDisk('nope', 0);
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, 'unknown_bucket');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('G3：CPU 20 分钟均值超 60% 降载；90 分钟均值超 60% 暂停 30 分钟', () => {
  const now = new Date(2026, 10, 6, 14, 0, 0).getTime();
  const guard = new ResourceGuard({ root: tempRoot(), now: () => now });

  guard.samples = [{ at: now - 10 * 60 * 1000, load: 0.8 }];
  assert.equal(guard.cpuState({ now, heavy: true }).level, 'degraded');

  guard.samples = [
    { at: now - 80 * 60 * 1000, load: 0.7 },
    { at: now - 40 * 60 * 1000, load: 0.7 },
    { at: now - 5 * 60 * 1000, load: 0.7 }
  ];
  const paused = guard.cpuState({ now, heavy: true });
  assert.equal(paused.level, 'paused');
  assert.equal(paused.reason, 'cpu_sustained');
  assert.equal(paused.cooldownUntil, now + 30 * 60 * 1000);

  // 冷却期内即使样本清零也不放行
  assert.equal(guard.cpuState({ now: now + 60 * 1000, heavy: true }).level, 'paused');
});

test('G4：夜间只允许轻量任务；单任务超过 45 分钟拒绝', () => {
  const night = new Date(2026, 10, 6, 23, 30, 0).getTime();
  assert.equal(isQuietHour(new Date(night)), true);
  const guard = new ResourceGuard({ root: tempRoot(), now: () => night });
  assert.equal(guard.cpuState({ now: night, heavy: true }).reason, 'quiet_hours');
  assert.equal(guard.cpuState({ now: night, heavy: false }).level, 'ok');

  const day = new Date(2026, 10, 6, 14, 0, 0).getTime();
  const longRun = guard.cpuState({ now: day, heavy: true, jobStartedAt: day - 46 * 60 * 1000 });
  assert.equal(longRun.level, 'blocked');
  assert.equal(longRun.reason, 'job_runtime');
});

test('G5：admit 同时看磁盘与 CPU，任一拒绝即整体拒绝', () => {
  const root = tempRoot();
  try {
    const now = new Date(2026, 10, 6, 14, 0, 0).getTime();
    const guard = new ResourceGuard({
      root,
      buckets: { datasets: 100, assets: 100, weights: 100, workspace: 100 },
      now: () => now
    });
    writeBytes(path.join(root, 'datasets', 'big.bin'), 96);
    const refused = guard.admit({ bytes: 10, heavy: false });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'quota');

    const clean = new ResourceGuard({ root: tempRoot(), now: () => now });
    const ok = clean.admit({ bytes: 10, heavy: false });
    assert.equal(ok.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('G6：windowAverage 只取窗口内样本；formatBytes 可读', () => {
  const now = 1000000;
  const avg = windowAverage([
    { at: now - 30 * 60 * 1000, load: 0.1 },
    { at: now - 60 * 1000, load: 0.5 }
  ], now, 20 * 60 * 1000);
  assert.equal(avg, 0.5);
  assert.equal(windowAverage([], now), null);
  assert.equal(formatBytes(0), '0B');
  assert.match(formatBytes(2 * 1024 * 1024 * 1024), /GB$/);
});
