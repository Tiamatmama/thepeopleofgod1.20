'use strict';

// 接线员（DispatchDesk）：派发前的唯一闸门。
// 它只做三件事：校验 manifest、查冲突、同步发租约。
// 「同步」是关键：Node 单线程里先在不 await 的代码段完成 check + reserve，
// 两个同时到达的 dispatch 不可能都拿到同一路径的写租约。

const { validateManifest } = require('./taskManifest');

function leasePaths(lease) {
  return {
    writes: new Set(lease && lease.writes || []),
    reads: new Set(lease && lease.reads || []),
    exclusive: new Set(lease && lease.exclusive || [])
  };
}

function intersect(a, b) {
  for (const item of a) if (b.has(item)) return item;
  return null;
}

// 冲突只看「会互相踩」的组合：
//   - 写 ↔ 写：绝对冲突；
//   - 写 ↔ 独占：独占方声明期间谁都不许碰；
//   - 独占 ↔ 读/写：独占本身就是在禁止别人读；
//   - 读 ↔ 写：允许，侦察读的是快照；真要在运行中读半截，由监控员按 baseSha 回退。
function manifestConflicts(manifest, activeLeases) {
  const conflicts = [];
  const mine = {
    writes: new Set(manifest.writes || []),
    reads: new Set(manifest.reads || []),
    exclusive: new Set(manifest.exclusive || [])
  };
  (activeLeases || []).forEach(lease => {
    if (!lease || lease.manifestId === manifest.manifestId) return;
    const other = leasePaths(lease);
    // 同一份写声明再来一次：优先报 duplicate-claim，比笼统的 write-write 更能说明原因
    if (manifest.role === 'writer' && lease.role === 'writer' && manifest.claimId === lease.claimId) {
      conflicts.push({
        kind: 'duplicate-claim',
        path: (manifest.writes || [])[0] || '',
        withManifestId: lease.manifestId,
        withTaskId: lease.taskId,
        withAgentId: lease.agentId
      });
      return;
    }
    const pairs = [
      ['write-write', mine.writes, other.writes],
      ['write-exclusive', mine.writes, other.exclusive],
      ['exclusive-write', mine.exclusive, other.writes],
      ['exclusive-read', mine.exclusive, other.reads],
      ['read-exclusive', mine.reads, other.exclusive]
    ];
    for (const [kind, a, b] of pairs) {
      const hit = intersect(a, b);
      if (hit) {
        conflicts.push({
          kind,
          path: hit,
          withManifestId: lease.manifestId,
          withTaskId: lease.taskId,
          withAgentId: lease.agentId
        });
        break;
      }
    }
  });
  return conflicts;
}

class DispatchDesk {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.leases = new Map();
    this.seq = 0;
  }

  activeLeases() {
    return Array.from(this.leases.values()).map(lease => ({ ...lease }));
  }

  get(leaseId) {
    const lease = this.leases.get(String(leaseId || ''));
    return lease ? { ...lease } : null;
  }

  // 派发前唯一入口：校验 → 冲突 → 预留。返回 ok=false 时不会留下任何租约。
  admit(manifest, options = {}) {
    if (!manifest || typeof manifest !== 'object') {
      return { ok: false, code: 'invalid', errors: ['manifest 缺失'] };
    }
    const knownManifests = Array.isArray(options.knownManifests) ? options.knownManifests : [];
    const validation = validateManifest(manifest, {
      workspaceDir: options.workspaceDir,
      knownManifests,
      baseSha: options.baseSha
    });
    if (!validation.ok) {
      return { ok: false, code: 'invalid', errors: validation.errors };
    }
    const conflicts = manifestConflicts(manifest, this.activeLeases());
    if (conflicts.length) {
      return { ok: false, code: 'conflict', conflicts };
    }
    const lease = {
      leaseId: `lease_${++this.seq}`,
      manifestId: manifest.manifestId,
      fleetId: manifest.fleetId || '',
      taskId: manifest.taskId,
      agentId: manifest.agentId,
      role: manifest.role,
      goal: manifest.goal,
      reads: [...(manifest.reads || [])],
      writes: [...(manifest.writes || [])],
      exclusive: [...(manifest.exclusive || [])],
      claimId: manifest.claimId,
      baseSha: manifest.baseSha || '',
      ttlSec: manifest.ttlSec,
      grantedAt: this.now(),
      heartbeatAt: this.now()
    };
    this.leases.set(lease.leaseId, lease);
    return { ok: true, lease: { ...lease } };
  }

  heartbeat(leaseId) {
    const lease = this.leases.get(String(leaseId || ''));
    if (!lease) return { ok: false, error: '租约不存在' };
    lease.heartbeatAt = this.now();
    return { ok: true, lease: { ...lease } };
  }

  release(leaseId) {
    const id = String(leaseId || '');
    const lease = this.leases.get(id);
    if (!lease) return { ok: false, error: '租约不存在' };
    this.leases.delete(id);
    return { ok: true, lease: { ...lease } };
  }

  // 回收心跳超时的租约。返回被回收的租约，由中枢把对应节点标 stalled/failed。
  reclaimExpired() {
    const now = this.now();
    const expired = [];
    for (const [leaseId, lease] of Array.from(this.leases.entries())) {
      const ttlMs = Math.max(60, Number(lease.ttlSec) || 60) * 1000;
      if (now - Number(lease.heartbeatAt || 0) > ttlMs) {
        this.leases.delete(leaseId);
        expired.push({ ...lease });
      }
    }
    return expired;
  }

  releaseAll(filter = {}) {
    const released = [];
    for (const [leaseId, lease] of Array.from(this.leases.entries())) {
      if (filter.fleetId && lease.fleetId !== filter.fleetId) continue;
      if (filter.taskId && lease.taskId !== filter.taskId) continue;
      this.leases.delete(leaseId);
      released.push({ ...lease });
    }
    return released;
  }

  snapshot() {
    return {
      active: this.activeLeases()
    };
  }
}

module.exports = {
  DispatchDesk,
  manifestConflicts
};
