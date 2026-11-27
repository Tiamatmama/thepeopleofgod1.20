const fs = require('fs');
const path = require('path');

// 🔒 跨进程写保护（方向二·持久化并发收口）。
//
// 本地 JSON 存储是「整档覆盖写」。server 侧是「内存快照 + 30s 节流 flush」，
// CLI 维护脚本（dedup-apply 等）直接覆盖写同一批文件——两者同时写会出现 lost-update：
// 脚本写完，server 下一次 flush 又拿陈旧内存整档盖回去，脚本的改动凭空消失。
//
// 这里给两层保护，锁等待只在「有界预算」内同步重试（默认 200ms 上限），绝不无限等：
//  1) 文件锁 withFileLock：写单个文件时用 O_EXCL 建同名 `.lock` 当互斥量，把「物理写入」
//     串行化，杜绝两个进程同时写同一文件写串/写坏；抢不到锁在预算内短暂重试，仍抢不到就
//     fail-open（照常写，只告警）——可用性优先。
//  2) 服务锁 writeServerLock / isServerRunning：server 启动时在 data/ 下落 `.server.lock`
//     （含 pid），供 CLI 脚本先探测「服务是否在跑」——在跑就拒绝写盘并提示先停服。
//     这才是 lost-update 的根治：只要没有并发的整档写者，冲突窗口就不存在。
//
// `.lock` 后缀既不被 storeGuard 当临时文件清、也不被加载器当数据档读（只认 .json），是安全的。

const SERVER_LOCK_NAME = '.server.lock';

// 进程是否存活：信号 0 只探测存在性，不真的发信号
function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    // EPERM = 进程存在但没权限给它发信号 → 仍视为存活
    return !!(error && error.code === 'EPERM');
  }
}

// 同步小睡：Node 同步场景用 Atomics.wait 阻塞，避免忙等占满 CPU
function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* 环境不支持就短暂忙等兜底 */ }
  }
}

// 服务锁文件路径
function serverLockPath(storagePath) {
  return path.join(storagePath, SERVER_LOCK_NAME);
}

// server 启动时写服务锁（含 pid + 时间），供 CLI 探测
function writeServerLock(storagePath) {
  try {
    fs.mkdirSync(storagePath, { recursive: true });
    fs.writeFileSync(serverLockPath(storagePath), JSON.stringify({ pid: process.pid, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

// server 退出/关闭时清服务锁（正常退出会调；残留由 pid 存活检测兜底）
function clearServerLock(storagePath) {
  try {
    fs.unlinkSync(serverLockPath(storagePath));
    return true;
  } catch {
    return false;
  }
}

// 读服务锁内容；不存在/坏档返回 null
function readServerLock(storagePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(serverLockPath(storagePath), 'utf8'));
    return { pid: Number(raw && raw.pid) || 0, at: Number(raw && raw.at) || 0 };
  } catch {
    return null;
  }
}

// 服务是否真的在跑：锁里的 pid 仍存活才算「在跑」。
// 崩溃/Ctrl+C 残留的锁因 pid 已死被判为陈旧 → 返回 false，不会误挡 CLI。
// 返回值：{ running: true, pid, at } 或 { running: false }
function isServerRunning(storagePath, opts = {}) {
  const info = readServerLock(storagePath);
  if (!info || !info.pid) return { running: false };
  if (info.pid === process.pid) return { running: false }; // 自己就是服务进程，别挡自己
  if (!isProcessAlive(info.pid)) return { running: false };
  const staleMs = Number(opts.staleMs) || 0;
  if (staleMs > 0 && Date.now() - info.at > staleMs) return { running: false };
  return { running: true, pid: info.pid, at: info.at };
}

// 锁是否已陈旧（可抢占）：读不动/坏锁一律当陈旧
function isLockStale(lockPath, staleMs) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return true;
  }
  const pid = Number(raw && raw.pid);
  if (isProcessAlive(pid) && pid !== process.pid) {
    if (!(staleMs > 0) || Date.now() - (Number(raw.at) || 0) <= staleMs) return false;
  }
  return true;
}

// 给「单文件整档写」加锁执行：fn 结束后释放。抢不到锁在预算内短重试，
// 仍抢不到则 fail-open（照常执行 fn，只告警）——绝不因锁把主流程卡死。
function withFileLock(filePath, fn, opts = {}) {
  const lockPath = `${filePath}.lock`;
  const staleMs = Number(opts.staleMs) || 60 * 1000;
  const budgetMs = Number(opts.retryMs) || 200;
  const stepMs = 10;
  const deadline = Date.now() + budgetMs;

  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx'); // O_CREAT | O_EXCL：已存在即抛 EEXIST
    } catch (error) {
      if (!(error && error.code === 'EEXIST')) throw error;
      if (isLockStale(lockPath, staleMs)) {
        try { fs.unlinkSync(lockPath); } catch { /* 别人刚释放也无妨 */ }
        continue; // 清掉陈旧锁后立刻重试
      }
      if (Date.now() >= deadline) {
        console.warn(`[writeLock] ${path.basename(filePath)} 未能及时获得写锁，按 fail-open 继续写入`);
        return fn();
      }
      sleepSync(stepMs);
      continue;
    }

    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }

    try {
      return fn();
    } finally {
      try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
}

module.exports = {
  isProcessAlive,
  isLockStale,
  serverLockPath,
  writeServerLock,
  clearServerLock,
  readServerLock,
  isServerRunning,
  withFileLock
};
