'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { normalizeHealthCheck, runHealthCheck } = require('../src/core/healthCheck');
const { createServer } = require('./fixtures/autonomy/server');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ---- normalizeHealthCheck：非法声明一律抛错（fail-closed）----

test('normalizeHealthCheck：null/undefined → null（未声明不改旧行为）', () => {
  assert.equal(normalizeHealthCheck(null), null);
  assert.equal(normalizeHealthCheck(undefined), null);
});

test('normalizeHealthCheck：非对象 → throw', () => {
  for (const bad of ['x', 1, [], true]) {
    assert.throws(() => normalizeHealthCheck(bad), /healthCheck 必须是对象/);
  }
});

test('normalizeHealthCheck：url 缺失/非法/非 http(s)/带凭据 → throw', () => {
  assert.throws(() => normalizeHealthCheck({}), /url 不能为空/);
  assert.throws(() => normalizeHealthCheck({ url: '   ' }), /url 不能为空/);
  assert.throws(() => normalizeHealthCheck({ url: 'not a url' }), /不是合法 URL/);
  assert.throws(() => normalizeHealthCheck({ url: 'ftp://example.com/health' }), /只支持 http\/https/);
  assert.throws(() => normalizeHealthCheck({ url: 'http://user:pass@example.com/health' }), /不允许携带用户名\/密码/);
});

test('normalizeHealthCheck：默认 expectStatus=200、timeoutMs=5000，主机默认仅本机', () => {
  const spec = normalizeHealthCheck({ url: 'http://127.0.0.1:3000/health' });
  assert.equal(spec.expectStatus, 200);
  assert.equal(spec.timeoutMs, 5000);
  assert.deepEqual(spec.allowedHosts, ['localhost', '127.0.0.1', '::1']);
  // IPv6 的方括号会被 URL.hostname 带上，归一化后仍算本机
  assert.equal(normalizeHealthCheck({ url: 'http://[::1]:3000/health' }).allowedHosts.includes('::1'), true);
});

test('normalizeHealthCheck：远程主机未显式放行 → throw；显式 allowedHosts 可放行', () => {
  assert.throws(
    () => normalizeHealthCheck({ url: 'http://a.test/h' }),
    /不是本机地址.*allowedHosts/
  );
  const spec = normalizeHealthCheck({ url: 'http://a.test/h', allowedHosts: ['a.test', '127.0.0.1'] });
  assert.deepEqual(spec.allowedHosts, ['a.test', '127.0.0.1']);
});

test('normalizeHealthCheck：expectStatus 必须是 100-599 的整数', () => {
  const allow = { allowedHosts: ['a.test'] };
  assert.equal(normalizeHealthCheck({ url: 'http://a.test/h', expectStatus: 204, ...allow }).expectStatus, 204);
  for (const bad of [99, 600, 200.5, '200', NaN]) {
    assert.throws(() => normalizeHealthCheck({ url: 'http://a.test/h', expectStatus: bad, ...allow }), /expectStatus/);
  }
});

test('normalizeHealthCheck：timeoutMs 夹到 [500, 60000]', () => {
  const allow = { allowedHosts: ['a.test'] };
  assert.equal(normalizeHealthCheck({ url: 'http://a.test/h', timeoutMs: 1, ...allow }).timeoutMs, 500);
  assert.equal(normalizeHealthCheck({ url: 'http://a.test/h', timeoutMs: 999999, ...allow }).timeoutMs, 60000);
  assert.equal(normalizeHealthCheck({ url: 'http://a.test/h', timeoutMs: 'abc', ...allow }).timeoutMs, 5000);
});

test('normalizeHealthCheck：allowedHosts 白名单 fail-closed', () => {
  const spec = normalizeHealthCheck({ url: 'http://127.0.0.1:3000/health', allowedHosts: ['127.0.0.1'] });
  assert.deepEqual(spec.allowedHosts, ['127.0.0.1']);
  assert.throws(
    () => normalizeHealthCheck({ url: 'http://evil.test/health', allowedHosts: ['127.0.0.1'] }),
    /不在 allowedHosts 白名单内/
  );
  assert.throws(() => normalizeHealthCheck({ url: 'http://a.test/h', allowedHosts: [] }), /非空数组/);
});

// ---- runHealthCheck：真实本地服务 ----

test('runHealthCheck：200 命中期望 → verified', async () => {
  const server = createServer();
  const baseUrl = await listen(server);
  try {
    const result = await runHealthCheck({ spec: { url: `${baseUrl}/health` } });
    assert.equal(result.success, true);
    assert.equal(result.ok, true);
    assert.equal(result.verdict, 'verified');
    assert.equal(result.status, 200);
    assert.equal(result.expectStatus, 200);
    assert.equal(result.bodySnippet, 'ok');
  } finally {
    await close(server);
  }
});

test('runHealthCheck：状态码不符 → failed / statusMismatch', async () => {
  const server = createServer({ healthStatus: 500 });
  const baseUrl = await listen(server);
  try {
    const result = await runHealthCheck({ spec: { url: `${baseUrl}/health` } });
    assert.equal(result.ok, false);
    assert.equal(result.verdict, 'failed');
    assert.equal(result.errorKind, 'statusMismatch');
    assert.equal(result.status, 500);
  } finally {
    await close(server);
  }
});

test('runHealthCheck：expectStatus=500 时 500 也算 verified', async () => {
  const server = createServer({ healthStatus: 500 });
  const baseUrl = await listen(server);
  try {
    const result = await runHealthCheck({ spec: { url: `${baseUrl}/health`, expectStatus: 500 } });
    assert.equal(result.ok, true);
    assert.equal(result.verdict, 'verified');
    assert.equal(result.status, 500);
  } finally {
    await close(server);
  }
});

test('runHealthCheck：不跟随重定向（302 就按 302 判定）', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(302, { location: '/health' });
    res.end();
  });
  const baseUrl = await listen(server);
  try {
    const asIs = await runHealthCheck({ spec: { url: `${baseUrl}/health`, expectStatus: 302 } });
    assert.equal(asIs.ok, true);
    assert.equal(asIs.status, 302);

    const expect200 = await runHealthCheck({ spec: { url: `${baseUrl}/health` } });
    assert.equal(expect200.ok, false);
    assert.equal(expect200.verdict, 'failed');
    assert.equal(expect200.status, 302);
  } finally {
    await close(server);
  }
});

test('runHealthCheck：连接失败 → error / networkError', async () => {
  const server = createServer();
  const baseUrl = await listen(server);
  await close(server);
  const result = await runHealthCheck({ spec: { url: `${baseUrl}/health`, timeoutMs: 1000 } });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'error');
  assert.equal(result.errorKind, 'networkError');
  assert.equal(result.status, 0);
});

test('runHealthCheck：超时 → error / timeout', async () => {
  const server = http.createServer(() => { /* 永不响应 */ });
  const baseUrl = await listen(server);
  try {
    const result = await runHealthCheck({ spec: { url: `${baseUrl}/health`, timeoutMs: 500 } });
    assert.equal(result.ok, false);
    assert.equal(result.verdict, 'error');
    assert.equal(result.errorKind, 'timeout');
  } finally {
    await close(server);
  }
});

test('runHealthCheck：响应体截断到 2048 字节', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('x'.repeat(5000));
  });
  const baseUrl = await listen(server);
  try {
    const result = await runHealthCheck({ spec: { url: `${baseUrl}/health` } });
    assert.equal(result.ok, true);
    assert.equal(result.bodySnippet.length, 2048);
  } finally {
    await close(server);
  }
});

test('runHealthCheck：非法/未声明判据 → error / invalid，不抛异常', async () => {
  const missing = await runHealthCheck({ spec: null });
  assert.equal(missing.ok, false);
  assert.equal(missing.verdict, 'error');
  assert.equal(missing.errorKind, 'invalid');

  const bad = await runHealthCheck({ spec: { url: 'ftp://a.test/h' } });
  assert.equal(bad.ok, false);
  assert.equal(bad.verdict, 'error');
  assert.equal(bad.errorKind, 'invalid');
});
