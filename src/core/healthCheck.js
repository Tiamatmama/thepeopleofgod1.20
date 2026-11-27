'use strict';

/**
 * 部署后健康检查（healthCheck）
 *
 * 由 runner 侧声明 URL 与期望状态码，模型只能读、不能改。
 * 只做一次 GET：不跟随重定向（避免把「302 到错误页」当成健康），
 * 连接失败 / 超时归 error，状态码不符归 failed。
 */

const http = require('http');
const https = require('https');

const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 60000;
const MAX_BODY_BYTES = 2048;
const MAX_URL_LENGTH = 2048;
const DEFAULT_EXPECT_STATUS = 200;
const MAX_REASON_LENGTH = 500;
const USER_AGENT = 'PeopleOfGod-HealthCheck/1.0';
// 默认只允许本机：无人值守闭环里 healthCheck 由 runner 声明、模型只读，
// 但仍要挡住「模型诱导/配置误填 → 请求任意内网地址」。远程检查必须显式声明 allowedHosts。
const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];

function fail(message) {
  const err = new Error(message);
  err.code = 'HEALTH_CHECK_INVALID';
  return err;
}

// 统一主机名口径：小写，并去掉 IPv6 的方括号（URL.hostname 会返回 "[::1]"）
function hostKey(hostname) {
  return String(hostname == null ? '' : hostname).trim().toLowerCase().replace(/^\[|\]$/g, '');
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

/**
 * 归一化 runner 声明的健康检查。null/undefined → null（未声明，行为不变）。
 * 非法声明一律抛错（fail-closed），避免坏判据退化成「没有检查」。
 */
function normalizeHealthCheck(spec) {
  if (spec == null) return null;
  if (typeof spec !== 'object' || Array.isArray(spec)) {
    throw fail('healthCheck 必须是对象');
  }

  const rawUrl = typeof spec.url === 'string' ? spec.url.trim() : '';
  if (!rawUrl) throw fail('healthCheck.url 不能为空');
  if (rawUrl.length > MAX_URL_LENGTH) {
    throw fail(`healthCheck.url 超过 ${MAX_URL_LENGTH} 字符`);
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw fail('healthCheck.url 不是合法 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw fail('healthCheck.url 只支持 http/https');
  }
  if (parsed.username || parsed.password) {
    throw fail('healthCheck.url 不允许携带用户名/密码');
  }

  let expectStatus = DEFAULT_EXPECT_STATUS;
  if (spec.expectStatus != null) {
    if (!Number.isInteger(spec.expectStatus) || spec.expectStatus < 100 || spec.expectStatus > 599) {
      throw fail('healthCheck.expectStatus 必须是 100-599 的整数');
    }
    expectStatus = spec.expectStatus;
  }

  // 主机白名单：未声明时默认仅本机；显式声明时按声明放行（仍必须包含目标主机）。
  const hostname = hostKey(parsed.hostname);
  let allowedHosts;
  if (spec.allowedHosts != null) {
    if (!Array.isArray(spec.allowedHosts) || !spec.allowedHosts.length) {
      throw fail('healthCheck.allowedHosts 必须是非空数组');
    }
    allowedHosts = spec.allowedHosts.map((host, i) => {
      const text = hostKey(host);
      if (!text) throw fail(`healthCheck.allowedHosts[${i}] 不能为空`);
      return text;
    });
    if (!allowedHosts.includes(hostname)) {
      throw fail(`healthCheck.url 的主机 ${hostname} 不在 allowedHosts 白名单内`);
    }
  } else {
    if (!DEFAULT_ALLOWED_HOSTS.includes(hostname)) {
      throw fail(`healthCheck.url 的主机 ${hostname} 不是本机地址；如确需远程检查，请显式声明 allowedHosts`);
    }
    allowedHosts = DEFAULT_ALLOWED_HOSTS.slice();
  }

  return {
    url: parsed.toString(),
    expectStatus,
    timeoutMs: clampInt(spec.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    allowedHosts
  };
}

/**
 * 执行一次健康检查。永不抛出，总是返回结构化结果。
 *
 * verdict:
 *   verified - 状态码等于期望值
 *   failed   - 服务有响应但状态码不符
 *   error    - 连接失败 / 超时 / 判据非法等基础设施错误
 */
function runHealthCheck({ spec } = {}) {
  let normalized;
  try {
    normalized = normalizeHealthCheck(spec);
  } catch (error) {
    return baseResult({ reason: `healthCheck 声明非法: ${error.message}`, errorKind: 'invalid' });
  }
  if (!normalized) {
    return baseResult({ reason: '本任务没有声明 healthCheck 判据', errorKind: 'invalid' });
  }

  const startedAt = Date.now();
  const mod = normalized.url.startsWith('https:') ? https : http;

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (patch) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ...baseResult({
          url: normalized.url,
          expectStatus: normalized.expectStatus
        }),
        elapsedMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        ...patch
      });
    };

    let req;
    try {
      req = mod.request(normalized.url, {
        method: 'GET',
        headers: {
          'user-agent': USER_AGENT,
          accept: '*/*'
        }
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          if (size >= MAX_BODY_BYTES) return;
          const remain = MAX_BODY_BYTES - size;
          const slice = chunk.length > remain ? chunk.slice(0, remain) : chunk;
          chunks.push(slice);
          size += slice.length;
        });
        res.on('end', () => {
          const status = Number(res.statusCode) || 0;
          const bodySnippet = Buffer.concat(chunks).toString('utf8');
          if (status === normalized.expectStatus) {
            finish({
              success: true,
              ok: true,
              verdict: 'verified',
              errorKind: null,
              reason: `健康检查通过（HTTP ${status}）`,
              status,
              bodySnippet
            });
            return;
          }
          finish({
            success: false,
            ok: false,
            verdict: 'failed',
            errorKind: 'statusMismatch',
            reason: `健康检查状态码不符：期望 ${normalized.expectStatus}，实际 ${status}`,
            status,
            bodySnippet
          });
        });
        res.on('error', (error) => {
          finish({
            success: false,
            ok: false,
            verdict: 'error',
            errorKind: 'networkError',
            reason: `健康检查响应读取失败: ${bound(error.message)}`,
            status: Number(res.statusCode) || 0
          });
        });
      });
    } catch (error) {
      finish({
        success: false,
        ok: false,
        verdict: 'error',
        errorKind: 'networkError',
        reason: `健康检查请求失败: ${bound(error.message)}`,
        status: 0
      });
      return;
    }

    timer = setTimeout(() => {
      const error = new Error(`健康检查超时（${normalized.timeoutMs}ms）`);
      error.code = 'ETIMEDOUT';
      try {
        req.destroy(error);
      } catch {
        /* 已结束的请求忽略 */
      }
      finish({
        success: false,
        ok: false,
        verdict: 'error',
        errorKind: 'timeout',
        reason: `健康检查超时（${normalized.timeoutMs}ms）`,
        status: 0
      });
    }, normalized.timeoutMs);

    req.on('error', (error) => {
      const timeout = error && error.code === 'ETIMEDOUT';
      finish({
        success: false,
        ok: false,
        verdict: 'error',
        errorKind: timeout ? 'timeout' : 'networkError',
        reason: `健康检查请求失败: ${bound(error && error.message ? error.message : String(error))}`,
        status: 0
      });
    });
    req.end();
  });
}

function baseResult({
  url = '',
  expectStatus = null,
  reason = '',
  errorKind = 'healthCheckError'
} = {}) {
  return {
    success: false,
    ok: false,
    verdict: 'error',
    errorKind,
    reason,
    url,
    expectStatus,
    status: 0,
    elapsedMs: 0,
    bodySnippet: '',
    checkedAt: new Date().toISOString()
  };
}

module.exports = {
  normalizeHealthCheck,
  runHealthCheck
};
