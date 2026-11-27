'use strict';

// T5/V6 验收：withFileLock 的 fail-open 行为 + isLockStale 谓词。
// 背景：writeLock.js 顶部注释已按实现（有界预算后 fail-open，绝不无限等）修正，
// 这里用「活他进程锁 + retryMs=1」把 fail-open 从行为上钉住，而不是只测谓词。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('node:child_process');

const { withFileLock, isLockStale } = require('../src/storage/writeLock');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'writelock-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// 起一个真在跑的其它进程（非本进程），拿到「活」pid
function startLiveChild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

// 跑到自然退出的子进程，返回一个「已死」的 pid（存活检测应判 false）
function getDeadPid() {
  const result = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  return result.pid;
}

function writeLockFile(lockPath, pid) {
  fs.writeFileSync(lockPath, JSON.stringify({ pid, at: Date.now() }));
}

// 谓词单测：只覆盖「陈旧判定」，**不**替代下面的 fail-open 行为断言
test('isLockStale：缺档/死 pid/自 pid 判陈旧，活他进程 pid 判未陈旧', async () => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, 'x.json.lock');
  try {
    // 缺档 → 当陈旧（读不动一律可抢占）
    assert.equal(isLockStale(lockPath), true);

    // 死 pid → 当陈旧
    writeLockFile(lockPath, getDeadPid());
    assert.equal(isLockStale(lockPath), true);

    // 自 pid（本进程自己持有的锁）→ 当陈旧，可抢占
    writeLockFile(lockPath, process.pid);
    assert.equal(isLockStale(lockPath), true);

    // 活他进程 pid → 未陈旧
    const child = await startLiveChild();
    try {
      writeLockFile(lockPath, child.pid);
      assert.equal(isLockStale(lockPath), false);
    } finally {
      child.kill();
    }
  } finally {
    cleanup(dir);
  }
});

// 行为断言：锁被他进程实际持有、预算耗尽 → fail-open 照常执行（不卡死、不抢别人锁）
test('withFileLock：锁被活他进程占用且预算耗尽 → fail-open 继续执行（V6）', async () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, 'u1__role.json');
  const lockPath = `${filePath}.lock`;
  const child = await startLiveChild();

  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    writeLockFile(lockPath, child.pid); // 活他进程真正持锁

    let ran = 0;
    // 注：retryMs:0 会被实现里的 `|| 200` 吃掉，必须用 1 才能构造「预算耗尽」
    const result = withFileLock(filePath, () => { ran += 1; return 'ok'; }, { retryMs: 1 });

    assert.equal(result, 'ok');                   // fail-open：fn 照常执行
    assert.equal(ran, 1);
    assert.equal(fs.existsSync(lockPath), true);  // 不 unlink 别人持有的锁
    assert.equal(warns.some((w) => w.includes('fail-open')), true);
  } finally {
    console.warn = origWarn;
    child.kill();
    cleanup(dir);
  }
});

// 常规路径：无竞争时加锁执行并释放，不留 .lock 残留
test('withFileLock：无竞争时执行 fn 并释放锁', () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, 'u1__role.json');
  try {
    let ran = 0;
    const result = withFileLock(filePath, () => { ran += 1; return 42; });
    assert.equal(result, 42);
    assert.equal(ran, 1);
    assert.equal(fs.existsSync(`${filePath}.lock`), false);
  } finally {
    cleanup(dir);
  }
});
