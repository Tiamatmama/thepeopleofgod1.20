// 长任务进度跟踪（深化十）：把「哪一条在跑到哪一步」放进一个有界的 Map。
// 只服务 discuss/review 的进度可见性：不落盘、不带正文，token→{phase, at}。
// 用 Map（非对象字面量）——`__proto__`/`constructor` 这类键天然不污染；超上限按最久未更新淘汰。

// 默认 TTL：15 分钟没再更新就当它已经结束/掉线，惰性清掉，避免长期占位。
const DEFAULT_TTL_MS = 15 * 60 * 1000;
// 默认容量上限：同一时刻在飞的讨论/评审远达不到，防的是泄漏而非正常量。
const DEFAULT_MAX_ENTRIES = 64;

function createProgressTracker({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now } = {}) {
  const entries = new Map(); // token -> { phase, at, startedAt }

  // 惰性清扫：只在读写时顺带扫一遍，不额外起定时器。
  function sweep() {
    const t = now();
    for (const [token, entry] of entries) {
      if (t - entry.at > ttlMs) entries.delete(token);
    }
  }

  // 开/续一条进度：空 token 直接忽略（旧调用方不带 progress，行为不变）。
  function set(token, phase) {
    if (!token) return;
    sweep();
    const prev = entries.get(token);
    const at = now();
    // 重新插入到队尾，让「最久没更新」的先被淘汰（Map 保持插入序）。
    entries.delete(token);
    entries.set(token, { phase: String(phase == null ? '' : phase), at, startedAt: prev ? prev.startedAt : at });
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  }

  // 读：未知/已过期一律 { busy:false }，不抛异常、不区分「不存在」与「已结束」。
  function get(token) {
    if (!token) return { busy: false };
    const entry = entries.get(token);
    if (!entry) return { busy: false };
    if (now() - entry.at > ttlMs) {
      entries.delete(token);
      return { busy: false };
    }
    return { busy: true, phase: entry.phase, at: entry.at, startedAt: entry.startedAt };
  }

  // 结束：server 放在 finally，异常也保证清键。
  function end(token) {
    if (token) entries.delete(token);
  }

  return { set, get, end, sweep, size: () => entries.size };
}

module.exports = { createProgressTracker, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES };
