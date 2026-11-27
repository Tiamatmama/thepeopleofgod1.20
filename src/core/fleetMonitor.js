'use strict';

// 监控员（FleetMonitor）：租约心跳、TTL 回收、写手越界对账。
// 它不直接跑模型，也不直接改代码；只负责「看」和「报」，处置由 AgentFleet 执行。

// 编码闭环自己会写这些投影文件，它们不算写手越界；否则每个写手一开跑就会被误判。
const LOOP_ARTIFACTS = new Set(['agents.md', 'project.json', 'plan.md', 'summary.md', 'index.md', '.gitignore']);

function normalizeChangedPath(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  text = text.replace(/\\/g, '/').replace(/^\.\//, '');
  return text;
}

function parseChangedPaths(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map(normalizeChangedPath)
    .filter(Boolean);
}

function findUndeclaredChanges(changedPaths, writes, extraAllowed = []) {
  const writeSet = new Set((writes || []).map(rel => normalizeChangedPath(rel).toLowerCase()));
  const allowed = new Set([...LOOP_ARTIFACTS, ...extraAllowed.map(normalizeChangedPath)].map(rel => rel.toLowerCase()));
  return (changedPaths || [])
    .map(normalizeChangedPath)
    .filter(rel => rel && !writeSet.has(rel.toLowerCase()) && !allowed.has(rel.toLowerCase()));
}

class FleetMonitor {
  constructor(options = {}) {
    this.desk = options.desk || null;
    this.inspect = typeof options.inspect === 'function' ? options.inspect : null;
    this.onViolation = typeof options.onViolation === 'function' ? options.onViolation : null;
    this.onExpired = typeof options.onExpired === 'function' ? options.onExpired : null;
    this.onHeartbeat = typeof options.onHeartbeat === 'function' ? options.onHeartbeat : null;
    this.intervalMs = Math.max(1000, parseInt(options.intervalMs, 10) || 5000);
    this.logger = options.logger || console;
    this.timer = null;
    this.ticking = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch(error => this.logger.warn(`[FleetMonitor] tick 异常：${error.message}`));
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.ticking || !this.desk) return { expired: [], checked: 0, violations: [] };
    this.ticking = true;
    const result = { expired: [], checked: 0, violations: [] };
    try {
      const expired = this.desk.reclaimExpired();
      expired.forEach(lease => {
        result.expired.push(lease);
        if (this.onExpired) this.onExpired(lease);
      });
      if (!this.inspect) return result;
      for (const lease of this.desk.activeLeases()) {
        result.checked++;
        let observed;
        try {
          observed = await this.inspect(lease);
        } catch (error) {
          this.logger.warn(`[FleetMonitor] 检查 ${lease.taskId} 失败：${error.message}`);
          continue;
        }
        if (observed && observed.heartbeat) this.desk.heartbeat(lease.leaseId);
        if (this.onHeartbeat) this.onHeartbeat(lease, observed || {});
        if (lease.role !== 'writer') continue;
        const violations = findUndeclaredChanges(observed && observed.changedPaths, lease.writes, observed && observed.allowed);
        if (violations.length) {
          result.violations.push({ lease, violations });
          this.desk.release(lease.leaseId);
          if (this.onViolation) this.onViolation(lease, violations);
        }
      }
      return result;
    } finally {
      this.ticking = false;
    }
  }
}

module.exports = {
  LOOP_ARTIFACTS,
  normalizeChangedPath,
  parseChangedPaths,
  findUndeclaredChanges,
  FleetMonitor
};
