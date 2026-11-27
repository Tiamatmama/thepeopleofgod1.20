'use strict';

// 任务头文件（Task Manifest）：派发前把「我要读什么、写什么、独占什么、跑什么命令」
// 先声明出来，接线员据此做静态检查。它只做纯函数校验，不启动任何执行器、不碰磁盘状态。
//
// 与 C++ 头文件的同构点：
//   1) 先声明后使用——写手没有 manifest 不允许派发；
//   2) include guard——同一路径同一时刻只允许一份写租约（claimId 唯一）；
//   3) 编译期报错——越界路径、保护路径、依赖成环在派发前就返回，而不是等运行期炸。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROLES = new Set(['writer', 'scout']);
const PROTECTED_WRITE_SEGMENTS = new Set(['test', '.git', 'data', 'node_modules', '.trae']);
const PROTECTED_WRITE_ROOT_FILES = new Set(['agents.md', 'project.json']);
const MAX_PATHS = 40;
const MAX_COMMANDS = 4;
const MAX_GOAL_CHARS = 1500;
const DEFAULT_WRITER_BUDGET = 120000;
const DEFAULT_SCOUT_BUDGET = 8000;
const DEFAULT_WRITER_TTL_SEC = 3600;
const DEFAULT_SCOUT_TTL_SEC = 600;
const MAX_TOKEN_BUDGET = 2000000;
const MIN_TTL_SEC = 60;
const MAX_TTL_SEC = 7200;

// 默认测试命令白名单。生产装配时可注入 toolRegistry.isWhitelistedTestCommand，
// 这里保留一份等价兜底，避免纯单测依赖整个工具注册表。
const DEFAULT_COMMAND_PATTERNS = [
  /^node\s+--test(?:\s|$)/,
  /^npm\s+(?:run\s+)?test(?:\s|$)/,
  /^npm\s+run\s+(?:test|lint|typecheck|check)(?:\s|$)/,
  /^npx\s+(?:jest|vitest|mocha|playwright)(?:\s|$)/,
  /^pytest(?:\s|$)/,
  /^eslint(?:\s|$)/,
  /^tsc\s+--noEmit(?:\s|$)/
];

function isSafeId(value) {
  return /^[A-Za-z0-9_-]{1,80}$/.test(String(value || '').trim());
}

function normalizeRelPath(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, reason: '路径为空' };
  if (text.includes('\0')) return { ok: false, reason: '路径包含非法字符' };
  if (/^[A-Za-z]:[\\/]/.test(text) || path.isAbsolute(text)) {
    return { ok: false, reason: '只允许工作区内相对路径' };
  }
  const posix = text.replace(/\\/g, '/').replace(/\/+/g, '/');
  const segments = posix.split('/').filter(Boolean);
  if (!segments.length) return { ok: false, reason: '路径为空' };
  if (segments.some(seg => seg === '..' || seg === '.')) {
    return { ok: false, reason: '路径不允许包含 . 或 ..' };
  }
  return { ok: true, rel: segments.join('/') };
}

function normalizePathList(raw, label, errors, { allowEmpty = true } = {}) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${label} 必须是数组`);
    return [];
  }
  if (raw.length > MAX_PATHS) {
    errors.push(`${label} 最多 ${MAX_PATHS} 条`);
    return [];
  }
  const out = [];
  const seen = new Set();
  raw.forEach((item, index) => {
    const parsed = normalizeRelPath(item);
    if (!parsed.ok) {
      errors.push(`${label}[${index}] ${parsed.reason}`);
      return;
    }
    const key = process.platform === 'win32' ? parsed.rel.toLowerCase() : parsed.rel;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(parsed.rel);
  });
  if (!allowEmpty && out.length === 0) errors.push(`${label} 至少声明 1 条`);
  return out;
}

function protectedWriteReason(rel) {
  const segments = String(rel || '').split('/').filter(Boolean);
  const lower = segments.map(seg => seg.toLowerCase());
  const hit = lower.find(seg => PROTECTED_WRITE_SEGMENTS.has(seg));
  if (hit) return `禁止写保护路径段: ${hit}`;
  if (segments.length === 1 && PROTECTED_WRITE_ROOT_FILES.has(lower[0])) {
    return `禁止写保护文件: ${segments[0]}`;
  }
  return '';
}

function realPathOf(target) {
  let cur = path.resolve(target);
  const rest = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  let real = cur;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(cur) : fs.realpathSync(cur);
  } catch {
    real = cur;
  }
  return rest.length ? path.join(real, ...rest) : real;
}

function sameOrInside(candidate, base) {
  const isWin = process.platform === 'win32';
  const a = isWin ? candidate.toLowerCase() : candidate;
  const b = isWin ? base.toLowerCase() : base;
  return a === b || a.startsWith(b + path.sep);
}

// 词法 + realpath 双校验；工作区不存在时直接拒绝，避免拿一个不存在的根做前缀比较。
function resolveInWorkspace(workspaceDir, rel) {
  const base = path.resolve(String(workspaceDir || ''));
  if (!workspaceDir || !fs.existsSync(base)) {
    return { ok: false, reason: '工作区不存在' };
  }
  const target = path.resolve(base, ...String(rel || '').split('/'));
  if (!sameOrInside(target, base)) {
    return { ok: false, reason: '路径越出工作区' };
  }
  const baseReal = realPathOf(base);
  const targetReal = realPathOf(target);
  if (!sameOrInside(targetReal, baseReal)) {
    return { ok: false, reason: '路径真实位置在工作区之外（符号链接/junction 越界）' };
  }
  return { ok: true, absolute: target, rel };
}

function commandAllowed(command, isAllowedCommand) {
  const text = String(command || '').trim();
  if (!text) return false;
  if (typeof isAllowedCommand === 'function') {
    try {
      return Boolean(isAllowedCommand(text));
    } catch {
      return false;
    }
  }
  return DEFAULT_COMMAND_PATTERNS.some(re => re.test(text));
}

function normalizeManifest(raw, options = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest 必须是对象'], manifest: null };
  }
  const role = String(raw.role || '').trim().toLowerCase();
  if (!ROLES.has(role)) errors.push('role 只能是 writer / scout');
  const taskId = String(raw.taskId || '').trim();
  const agentId = String(raw.agentId || '').trim();
  if (!isSafeId(taskId)) errors.push('taskId 只能包含字母、数字、下划线和连字符');
  if (!isSafeId(agentId)) errors.push('agentId 只能包含字母、数字、下划线和连字符');
  const fleetId = String(raw.fleetId || '').trim();
  if (fleetId && !isSafeId(fleetId)) errors.push('fleetId 只能包含字母、数字、下划线和连字符');
  const goal = String(raw.goal || '').trim().slice(0, MAX_GOAL_CHARS);
  if (!goal) errors.push('goal 不能为空');

  const reads = normalizePathList(raw.reads, 'reads', errors);
  const writes = normalizePathList(raw.writes, 'writes', errors, { allowEmpty: role !== 'writer' });
  const exclusive = normalizePathList(raw.exclusive, 'exclusive', errors);
  if (role === 'scout' && writes.length) errors.push('scout 不允许声明 writes');

  const commands = Array.isArray(raw.commands) ? raw.commands.map(item => String(item || '').trim()).filter(Boolean).slice(0, MAX_COMMANDS) : [];
  if (Array.isArray(raw.commands) && raw.commands.length > MAX_COMMANDS) errors.push(`commands 最多 ${MAX_COMMANDS} 条`);
  if (role === 'scout' && commands.length) errors.push('scout 不允许声明 commands');
  commands.forEach((command, index) => {
    if (!commandAllowed(command, options.isAllowedCommand)) errors.push(`commands[${index}] 不在测试命令白名单内`);
  });

  const dependsOn = Array.isArray(raw.dependsOn)
    ? raw.dependsOn.map(item => String(item || '').trim()).filter(Boolean).slice(0, 12)
    : [];
  if (dependsOn.some(id => id === taskId)) errors.push('dependsOn 不能依赖自己');

  const baseSha = String(raw.baseSha || '').trim();
  if (baseSha && !/^[0-9a-f]{7,40}$/i.test(baseSha)) errors.push('baseSha 必须是 7~40 位十六进制提交号');

  const defaultBudget = role === 'scout' ? DEFAULT_SCOUT_BUDGET : DEFAULT_WRITER_BUDGET;
  const tokenBudget = Math.max(1000, Math.min(parseInt(raw.tokenBudget, 10) || defaultBudget, MAX_TOKEN_BUDGET));
  const defaultTtl = role === 'scout' ? DEFAULT_SCOUT_TTL_SEC : DEFAULT_WRITER_TTL_SEC;
  const ttlSec = Math.max(MIN_TTL_SEC, Math.min(parseInt(raw.ttlSec, 10) || defaultTtl, MAX_TTL_SEC));

  // 写集与读集重叠时，以写为准，避免同一路径既读又写产生假冲突
  const readOnly = reads.filter(rel => !writes.includes(rel));
  const workspaceKey = String(options.workspaceKey || taskId);
  const claimId = `claim_${crypto.createHash('sha1')
    .update(`${workspaceKey}|${writes.length ? writes.slice().sort().join(',') : `scout:${agentId}`}`)
    .digest('hex').slice(0, 16)}`;

  const manifest = {
    manifestId: String(raw.manifestId || '').trim() || `mf_${fleetId || 'fleet'}_${taskId}`,
    fleetId,
    taskId,
    agentId,
    role,
    goal,
    reads: readOnly,
    writes,
    exclusive,
    commands,
    dependsOn,
    baseSha,
    tokenBudget,
    ttlSec,
    claimId
  };
  return { ok: errors.length === 0, errors, manifest };
}

function detectDependencyCycle(manifests) {
  const map = new Map();
  (manifests || []).forEach(item => {
    if (item && item.taskId) map.set(item.taskId, Array.isArray(item.dependsOn) ? item.dependsOn : []);
  });
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    const color = state.get(id) || 0;
    if (color === 1) {
      const at = stack.indexOf(id);
      return stack.slice(at >= 0 ? at : 0).concat(id);
    }
    if (color === 2) return null;
    state.set(id, 1);
    stack.push(id);
    for (const dep of map.get(id) || []) {
      if (!map.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of map.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

function validateManifest(manifest, options = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return { ok: false, errors: ['manifest 缺失'] };
  const workspaceDir = String(options.workspaceDir || '').trim();
  if (!workspaceDir) return { ok: false, errors: ['缺少 workspaceDir'] };

  const allPaths = [
    ...(manifest.reads || []).map(rel => ({ rel, kind: 'reads' })),
    ...(manifest.writes || []).map(rel => ({ rel, kind: 'writes' })),
    ...(manifest.exclusive || []).map(rel => ({ rel, kind: 'exclusive' }))
  ];
  allPaths.forEach(({ rel, kind }) => {
    const resolved = resolveInWorkspace(workspaceDir, rel);
    if (!resolved.ok) errors.push(`${kind}: ${rel} → ${resolved.reason}`);
    if (kind === 'writes') {
      const blocked = protectedWriteReason(rel);
      if (blocked) errors.push(`writes: ${rel} → ${blocked}`);
    }
  });

  const knownIds = new Set((options.knownManifests || []).map(item => item && item.taskId).filter(Boolean));
  knownIds.add(manifest.taskId);
  (manifest.dependsOn || []).forEach(dep => {
    if (!knownIds.has(dep)) errors.push(`dependsOn 指向不存在的节点: ${dep}`);
  });
  if (manifest.baseSha) {
    const expected = String(options.baseSha || '').trim();
    if (expected && manifest.baseSha !== expected) errors.push(`baseSha 已过期：声明 ${manifest.baseSha}，当前 ${expected}`);
  }

  const combined = [...(options.knownManifests || []), manifest].filter(Boolean);
  const cycle = detectDependencyCycle(combined);
  if (cycle) errors.push(`dependsOn 成环: ${cycle.join(' → ')}`);

  return { ok: errors.length === 0, errors };
}

module.exports = {
  ROLES,
  DEFAULT_WRITER_BUDGET,
  DEFAULT_SCOUT_BUDGET,
  DEFAULT_WRITER_TTL_SEC,
  DEFAULT_SCOUT_TTL_SEC,
  normalizeRelPath,
  protectedWriteReason,
  resolveInWorkspace,
  normalizeManifest,
  validateManifest,
  detectDependencyCycle,
  commandAllowed
};
