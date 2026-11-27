'use strict';

// 🧮 资源闸：磁盘配额账本 + CPU 采样分级。
// 只回答「现在能不能开新任务」，不负责执行、不落业务数据。
// 磁盘按四个桶计量（默认合计 6GB），CPU 用滑动窗口判定降载 / 暂停。
// 详细规则见 docs/superpowers/specs/2026-11-06-self-evolution-learning-design.md

const fs = require('fs');
const path = require('path');
const os = require('os');

const MB = 1024 * 1024;
const GB = 1024 * MB;

const DEFAULT_BUCKETS = Object.freeze({
  datasets: 2 * GB,                 // 下载 / 解压的临时数据，任务结束即删
  assets: Math.floor(1.5 * GB),     // 留存产物
  weights: Math.floor(1.5 * GB),    // 模型权重
  workspace: 1 * GB                 // 任务脚本与工作目录
});

const LIMITS = Object.freeze({
  warnRatio: 0.8,
  refuseRatio: 0.95,
  cpuDegradeRatio: 0.6,
  cpuWindowMs: 20 * 60 * 1000,
  cpuSustainMs: 90 * 60 * 1000,
  // 判定「连续高负载」前至少要观察到 60 分钟，避免刚启动的一条样本就把系统停掉
  cpuSustainCoverageMs: 60 * 60 * 1000,
  cooldownMs: 30 * 60 * 1000,
  jobMaxMs: 45 * 60 * 1000
});

const QUIET_START_HOUR = 23;
const QUIET_END_HOUR = 7;

// 递归量目录体积：跳过符号链接，读不到的项按 0 计（权限 / 半删除状态都不能让账本崩）
function dirSize(target, fsImpl = fs) {
  let total = 0;
  let stat;
  try {
    stat = fsImpl.lstatSync(target);
  } catch {
    return 0;
  }
  if (!stat) return 0;
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let names;
  try {
    names = fsImpl.readdirSync(target);
  } catch {
    return 0;
  }
  for (const name of names) {
    total += dirSize(path.join(target, name), fsImpl);
  }
  return total;
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0B';
  if (n >= GB) return `${(n / GB).toFixed(2)}GB`;
  if (n >= MB) return `${(n / MB).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${Math.round(n)}B`;
}

// 夜间只允许轻量任务（本地时间）
function isQuietHour(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const hour = d.getHours();
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

// 窗口内样本均值；没有样本返回 null（而不是 0，避免把「没数据」判成「很闲」）
function windowAverage(samples = [], now = Date.now(), windowMs = LIMITS.cpuWindowMs) {
  const from = now - windowMs;
  const list = samples.filter((item) => item && Number.isFinite(item.at) && item.at >= from && Number.isFinite(item.load));
  if (!list.length) return null;
  return list.reduce((sum, item) => sum + item.load, 0) / list.length;
}

// 窗口内的实际观察跨度：样本从多久以前开始。样本太少时不据此判「连续」。
function windowCoverage(samples = [], now = Date.now(), windowMs = LIMITS.cpuSustainMs) {
  const from = now - windowMs;
  const times = samples
    .filter((item) => item && Number.isFinite(item.at) && item.at >= from)
    .map((item) => item.at);
  if (!times.length) return 0;
  return now - Math.min(...times);
}

// CPU 快照只取空闲与总时间，两次快照相减得到区间占用率
function snapshotCpu(cpus = os.cpus()) {
  return cpus.map((cpu) => {
    const t = cpu.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
}

function diffCpu(prev, next) {
  if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length || !prev.length) return null;
  let idle = 0;
  let total = 0;
  for (let i = 0; i < next.length; i += 1) {
    const dIdle = next[i].idle - prev[i].idle;
    const dTotal = next[i].total - prev[i].total;
    if (dIdle < 0 || dTotal <= 0) continue;
    idle += dIdle;
    total += dTotal;
  }
  if (total <= 0) return null;
  return Math.max(0, Math.min(1, 1 - idle / total));
}

class ResourceGuard {
  constructor(options = {}) {
    this.root = options.root || path.join(__dirname, '..', '..', 'data', 'learn');
    this.buckets = { ...DEFAULT_BUCKETS, ...(options.buckets || {}) };
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.fs = options.fs || fs;
    // 可注入的 CPU 读取器（测试用）；默认按两次 os.cpus() 快照相减
    this.cpuReader = typeof options.cpuReader === 'function' ? options.cpuReader : null;
    this._prevCpu = null;
    this.cpuPercent = 0;
    this.samples = [];
    this.cooldownUntil = 0;
    this.pausedReason = '';
  }

  ensureDirs() {
    for (const name of Object.keys(this.buckets)) {
      try {
        this.fs.mkdirSync(path.join(this.root, name), { recursive: true });
      } catch {
        // 目录建不出来时由后续写入报错；这里不阻断状态查询
      }
    }
  }

  usage() {
    const buckets = {};
    let totalUsed = 0;
    let totalLimit = 0;
    for (const [name, limit] of Object.entries(this.buckets)) {
      const used = dirSize(path.join(this.root, name), this.fs);
      const ratio = limit > 0 ? used / limit : 0;
      buckets[name] = { used, limit, ratio, text: `${formatBytes(used)} / ${formatBytes(limit)}` };
      totalUsed += used;
      totalLimit += limit;
    }
    return {
      buckets,
      totalUsed,
      totalLimit,
      totalRatio: totalLimit > 0 ? totalUsed / totalLimit : 0,
      text: `${formatBytes(totalUsed)} / ${formatBytes(totalLimit)}`
    };
  }

  // 预估占用：incomingBytes 是本次下载 / 解压前的大小估算（解压后再按实际值复查）
  checkDisk(bucket, incomingBytes = 0) {
    const usage = this.usage();
    const target = usage.buckets[bucket];
    if (!target) {
      return { ok: false, level: 'refuse', reason: 'unknown_bucket', bucket, usage };
    }
    const incoming = Number.isFinite(incomingBytes) && incomingBytes > 0 ? incomingBytes : 0;
    const projected = target.used + incoming;
    const bucketRatio = target.limit > 0 ? projected / target.limit : 1;
    const totalRatio = usage.totalLimit > 0 ? (usage.totalUsed + incoming) / usage.totalLimit : 1;

    if (bucketRatio > LIMITS.refuseRatio || totalRatio > LIMITS.refuseRatio) {
      return {
        ok: false,
        level: 'refuse',
        reason: 'quota',
        bucket,
        usage,
        projectedBytes: projected,
        projectedRatio: Math.max(bucketRatio, totalRatio)
      };
    }
    const level = bucketRatio > LIMITS.warnRatio || totalRatio > LIMITS.warnRatio ? 'warn' : 'ok';
    return { ok: true, level, reason: 'ok', bucket, usage, projectedBytes: projected, projectedRatio: Math.max(bucketRatio, totalRatio) };
  }

  // 采一次样；返回本次占用率（0–1）。样本保留 90 分钟，内存占用固定。
  sampleCpu(now = this.now()) {
    let percent = null;
    if (this.cpuReader) {
      const value = this.cpuReader();
      percent = Number.isFinite(value) ? value : null;
    } else {
      const snap = snapshotCpu(os.cpus());
      if (this._prevCpu) percent = diffCpu(this._prevCpu, snap);
      this._prevCpu = snap;
    }
    if (percent !== null) {
      this.cpuPercent = Math.max(0, Math.min(1, percent));
      this.samples.push({ at: now, load: this.cpuPercent });
    }
    this.samples = this.samples.filter((item) => now - item.at <= LIMITS.cpuSustainMs);
    return this.cpuPercent;
  }

  cpuState({ now = this.now(), jobStartedAt = 0, heavy = true } = {}) {
    if (this.cooldownUntil > now) {
      return {
        level: 'paused',
        reason: 'cooldown',
        cooldownUntil: this.cooldownUntil,
        avg20: windowAverage(this.samples, now, LIMITS.cpuWindowMs),
        avg90: windowAverage(this.samples, now, LIMITS.cpuSustainMs)
      };
    }
    if (heavy && isQuietHour(new Date(now))) {
      return { level: 'blocked', reason: 'quiet_hours', avg20: null, avg90: null };
    }
    if (jobStartedAt > 0 && now - jobStartedAt > LIMITS.jobMaxMs) {
      return { level: 'blocked', reason: 'job_runtime', avg20: null, avg90: null };
    }

    const avg20 = windowAverage(this.samples, now, LIMITS.cpuWindowMs);
    const avg90 = windowAverage(this.samples, now, LIMITS.cpuSustainMs);
    const coverage = windowCoverage(this.samples, now, LIMITS.cpuSustainMs);
    if (avg90 !== null && coverage >= LIMITS.cpuSustainCoverageMs && avg90 >= LIMITS.cpuDegradeRatio) {
      this.cooldownUntil = now + LIMITS.cooldownMs;
      this.pausedReason = 'cpu_sustained';
      return { level: 'paused', reason: 'cpu_sustained', cooldownUntil: this.cooldownUntil, avg20, avg90 };
    }
    if (avg20 !== null && avg20 >= LIMITS.cpuDegradeRatio) {
      return { level: 'degraded', reason: 'cpu_high', avg20, avg90 };
    }
    return { level: 'ok', reason: 'ok', avg20, avg90 };
  }

  // 新任务总闸：磁盘 + CPU 都过才放行；warn / degraded 仍放行但带标记
  admit(job = {}) {
    const disk = this.checkDisk(job.bucket || 'datasets', job.bytes || 0);
    if (!disk.ok) {
      return { ok: false, level: disk.level, reason: disk.reason, disk, cpu: null };
    }
    const cpu = this.cpuState({ jobStartedAt: job.startedAt || 0, heavy: job.heavy !== false });
    if (cpu.level === 'blocked' || cpu.level === 'paused') {
      return { ok: false, level: cpu.level, reason: cpu.reason, disk, cpu };
    }
    const level = disk.level === 'warn' || cpu.level === 'degraded' ? 'degraded' : 'ok';
    return { ok: true, level, reason: 'ok', disk, cpu };
  }

  status(options = {}) {
    return {
      disk: this.usage(),
      cpu: {
        percent: this.cpuPercent,
        ...this.cpuState(options)
      },
      limits: { ...LIMITS }
    };
  }
}

module.exports = {
  ResourceGuard,
  DEFAULT_BUCKETS,
  LIMITS,
  dirSize,
  formatBytes,
  isQuietHour,
  windowAverage,
  windowCoverage,
  snapshotCpu,
  diffCpu
};
