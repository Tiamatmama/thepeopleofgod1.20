'use strict';

/**
 * 部署执行（deploy）
 *
 * 由 runner 侧声明命令与参数，模型只能执行、不能修改。
 * 安全约束：
 *  - 只走 execFileSync + 参数数组，绝不拼 shell 字符串；
 *  - 命令/参数拒绝 shell 元字符与 NUL（参数数组已无关 shell 转义，这里再兜一层）；
 *  - cwd 必须落在任务工作区内；
 *  - 返回的 stdout/stderr 与命令展示串统一脱敏（token/password/secret/api key）。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 120000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 600000;
const MAX_COMMAND_LENGTH = 512;
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4096;
const MAX_ENV_KEYS = 64;
const MAX_ENV_VALUE_LENGTH = 4096;
const MAX_LOG_CHARS = 4000;
const MAX_REASON_LENGTH = 500;
// 参数数组本身不经 shell，但仍拒绝元字符：避免声明被误当成 shell 片段，也降低未来改动引入注入的风险
const SHELL_META_RE = /[;&|><`$\r\n\0]/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SECRET_KEY = '(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|access[_-]?key|private[_-]?key)';
const KV_SECRET_RE = new RegExp(`(${SECRET_KEY}\\s*[:=]\\s*["']?)([^\\s"',;]+)`, 'gi');
const FLAG_SECRET_RE = new RegExp(`((?:--?|/)(?:${SECRET_KEY})\\s+)(\\S+)`, 'gi');
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

function fail(message) {
  const err = new Error(message);
  err.code = 'DEPLOY_INVALID';
  return err;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function bound(text, max = MAX_REASON_LENGTH) {
  const value = String(text == null ? '' : text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function tail(text, max = MAX_LOG_CHARS) {
  const value = String(text == null ? '' : text);
  return value.length > max ? value.slice(-max) : value;
}

/**
 * 日志脱敏：只保留结构，把密钥类取值替换成 ***。
 * 先脱敏再截断，避免截断点把密钥切一半后漏网。
 */
function redactSecrets(text) {
  return String(text == null ? '' : text)
    // 先处理 Bearer：`Authorization: Bearer sk-xxx` 里的 Bearer 会被 KV 规则当成取值，
    // 若先跑 KV 会只剩 `Authorization: *** sk-xxx`，把真正的 token 留在明文里
    .replace(BEARER_RE, '$1***')
    .replace(KV_SECRET_RE, '$1***')
    .replace(FLAG_SECRET_RE, '$1***');
}

/**
 * 归一化 runner 声明的部署脚本。null/undefined → null（未声明，行为不变）。
 * 非法声明一律抛错（fail-closed），避免坏声明退化成「什么都没部署」。
 */
function normalizeDeploy(spec) {
  if (spec == null) return null;
  if (typeof spec !== 'object' || Array.isArray(spec)) {
    throw fail('deploy 必须是对象');
  }

  const command = typeof spec.command === 'string' ? spec.command.trim() : '';
  if (!command) throw fail('deploy.command 不能为空');
  if (command.length > MAX_COMMAND_LENGTH) {
    throw fail(`deploy.command 超过 ${MAX_COMMAND_LENGTH} 字符`);
  }
  if (SHELL_META_RE.test(command)) {
    throw fail('deploy.command 不允许包含 shell 元字符（; & | > < ` $ 换行）');
  }

  let args = [];
  if (spec.args != null) {
    if (!Array.isArray(spec.args)) throw fail('deploy.args 必须是数组');
    if (spec.args.length > MAX_ARGS) throw fail(`deploy.args 最多 ${MAX_ARGS} 个参数`);
    args = spec.args.map((arg, i) => {
      if (typeof arg !== 'string' && typeof arg !== 'number') {
        throw fail(`deploy.args[${i}] 必须是字符串或数字`);
      }
      const text = String(arg);
      if (text.length > MAX_ARG_LENGTH) throw fail(`deploy.args[${i}] 超过 ${MAX_ARG_LENGTH} 字符`);
      if (text.includes('\0')) throw fail(`deploy.args[${i}] 不允许包含 NUL`);
      return text;
    });
  }

  let env = null;
  if (spec.env != null) {
    if (typeof spec.env !== 'object' || Array.isArray(spec.env)) {
      throw fail('deploy.env 必须是对象');
    }
    const entries = Object.entries(spec.env);
    if (entries.length > MAX_ENV_KEYS) throw fail(`deploy.env 最多 ${MAX_ENV_KEYS} 个键`);
    env = {};
    entries.forEach(([key, value]) => {
      if (!ENV_KEY_RE.test(key)) throw fail(`deploy.env 键名非法: ${key}`);
      if (value == null || typeof value === 'object') {
        throw fail(`deploy.env.${key} 必须是字符串/数字/布尔值`);
      }
      const text = String(value);
      if (text.length > MAX_ENV_VALUE_LENGTH) throw fail(`deploy.env.${key} 超过 ${MAX_ENV_VALUE_LENGTH} 字符`);
      if (text.includes('\0')) throw fail(`deploy.env.${key} 不允许包含 NUL`);
      env[key] = text;
    });
  }

  let expectExitCode = 0;
  if (spec.expectExitCode != null) {
    if (!Number.isInteger(spec.expectExitCode) || spec.expectExitCode < 0 || spec.expectExitCode > 255) {
      throw fail('deploy.expectExitCode 必须是 0-255 的整数');
    }
    expectExitCode = spec.expectExitCode;
  }

  const cwd = typeof spec.cwd === 'string' ? spec.cwd.trim() : '';
  if (cwd.length > 1024) throw fail('deploy.cwd 超过 1024 字符');

  return {
    command,
    args,
    cwd,
    env,
    timeoutMs: clampInt(spec.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    expectExitCode
  };
}

function isInside(child, root) {
  const target = path.resolve(child).toLowerCase();
  const base = path.resolve(root).toLowerCase();
  return target === base || target.startsWith(base + path.sep);
}

function displayCommand(command, args) {
  return redactSecrets([command].concat(args || []).join(' '));
}

function baseResult({ reason = '', errorKind = 'deployError' } = {}) {
  return {
    success: false,
    ok: false,
    errorKind,
    reason,
    exitCode: null,
    expectExitCode: null,
    timedOut: false,
    signal: null,
    command: '',
    cwd: '',
    envKeys: [],
    stdout: '',
    stderr: '',
    elapsedMs: 0,
    checkedAt: new Date().toISOString()
  };
}

/**
 * 执行一次部署。永不抛出，总是返回结构化结果（同步，execFileSync）。
 *
 * ok = 退出码等于声明值且未超时；
 * errorKind: invalid / timeout / spawnError / exitCodeMismatch
 */
function runDeploy({ spec, workspace } = {}) {
  let normalized;
  try {
    normalized = normalizeDeploy(spec);
  } catch (error) {
    return baseResult({ reason: `deploy 声明非法: ${error.message}`, errorKind: 'invalid' });
  }
  if (!normalized) {
    return baseResult({ reason: '本任务没有声明 deploy 脚本', errorKind: 'invalid' });
  }

  const root = path.resolve(String(workspace || ''));
  if (!workspace || !fs.existsSync(root)) {
    return baseResult({ reason: `工作区不存在: ${workspace || ''}`, errorKind: 'invalid' });
  }
  const workdir = normalized.cwd ? path.resolve(root, normalized.cwd) : root;
  if (!isInside(workdir, root)) {
    return baseResult({ reason: 'deploy.cwd 超出工作区范围', errorKind: 'invalid' });
  }

  const commandLine = displayCommand(normalized.command, normalized.args);
  const envKeys = normalized.env ? Object.keys(normalized.env) : [];
  const env = normalized.env ? { ...process.env, ...normalized.env } : process.env;
  const startedAt = Date.now();
  const common = {
    command: commandLine,
    cwd: workdir,
    envKeys,
    expectExitCode: normalized.expectExitCode
  };

  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(normalized.command, normalized.args, {
      cwd: workdir,
      env,
      timeout: normalized.timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }) || '';
    return {
      ...baseResult(),
      ...common,
      success: normalized.expectExitCode === 0,
      ok: normalized.expectExitCode === 0,
      exitCode: 0,
      reason: normalized.expectExitCode === 0 ? '部署命令执行成功（退出码 0）' : `部署命令退出码为 0，与声明的 ${normalized.expectExitCode} 不符`,
      errorKind: normalized.expectExitCode === 0 ? null : 'exitCodeMismatch',
      stdout: tail(redactSecrets(stdout)),
      elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    stdout = error && error.stdout != null ? String(error.stdout) : '';
    stderr = error && error.stderr != null ? String(error.stderr) : '';
    const timedOut = !!(error && (error.code === 'ETIMEDOUT' || (error.killed && error.signal)));
    const exitCode = error && typeof error.status === 'number' ? error.status : null;
    const signal = (error && error.signal) || null;
    const matched = !timedOut && exitCode === normalized.expectExitCode;

    let errorKind = 'spawnError';
    let reason = '';
    if (timedOut) {
      errorKind = 'timeout';
      reason = `部署命令超时（${normalized.timeoutMs}ms），已终止`;
    } else if (exitCode != null && exitCode !== normalized.expectExitCode) {
      errorKind = 'exitCodeMismatch';
      reason = `部署命令退出码不符：期望 ${normalized.expectExitCode}，实际 ${exitCode}`;
    } else {
      reason = `部署命令启动失败: ${bound(error && error.message ? error.message : String(error))}`;
    }

    return {
      ...baseResult(),
      ...common,
      success: matched,
      ok: matched,
      exitCode,
      expectedExitCode: normalized.expectExitCode,
      timedOut,
      signal,
      reason: matched ? `部署命令按预期退出（退出码 ${exitCode}）` : reason,
      errorKind: matched ? null : errorKind,
      stdout: tail(redactSecrets(stdout)),
      stderr: tail(redactSecrets(stderr)),
      elapsedMs: Date.now() - startedAt
    };
  }
}

module.exports = {
  normalizeDeploy,
  runDeploy,
  redactSecrets
};
