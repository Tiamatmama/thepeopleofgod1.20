'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CodingLoop = require('../src/core/codingLoop');
const { createServer } = require('./fixtures/autonomy/server');

const { normalizeStages, evaluateStage } = CodingLoop;

function validWebCheck(overrides = {}) {
  return {
    start: { command: 'node', args: ['server.js'], readyPath: '/' },
    steps: [{ type: 'open', path: '/' }],
    ...overrides
  };
}

function healthStage(id, overrides = {}) {
  return {
    id,
    kind: 'health',
    check: { url: 'http://127.0.0.1:3000/health' },
    ...overrides
  };
}

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

// ---- normalizeStages ----

test('normalizeStages：null/undefined → []', () => {
  assert.deepEqual(normalizeStages(null), []);
  assert.deepEqual(normalizeStages(undefined), []);
});

test('normalizeStages：非数组 → throw', () => {
  for (const bad of ['x', 1, {}, true]) {
    assert.throws(() => normalizeStages(bad), /stages 必须是数组/);
  }
});

test('normalizeStages：阶段必须是对象、id 合法且唯一', () => {
  assert.throws(() => normalizeStages(['x']), /必须是对象/);
  assert.throws(() => normalizeStages([healthStage('')]), /\.id 只能包含/);
  assert.throws(() => normalizeStages([healthStage('-bad')]), /\.id 只能包含/);
  assert.throws(() => normalizeStages([healthStage('a'.repeat(65))]), /\.id 只能包含/);
  assert.throws(
    () => normalizeStages([healthStage('a'), healthStage('a')]),
    /id 重复/
  );
});

test('normalizeStages：未知 kind → throw', () => {
  assert.throws(() => normalizeStages([healthStage('a', { kind: 'deploy' })]), /kind 只支持/);
});

test('normalizeStages：check 缺失或非法 → throw', () => {
  assert.throws(() => normalizeStages([{ id: 'a', kind: 'health' }]), /check 不能为空/);
  assert.throws(() => normalizeStages([{ id: 'a', kind: 'health', check: {} }]), /check 非法/);
  assert.throws(
    () => normalizeStages([{ id: 'a', kind: 'webCheck', check: {} }]),
    /check 非法/
  );
});

test('normalizeStages：requires 非数组/空项/自依赖/未知依赖/循环 → throw', () => {
  assert.throws(() => normalizeStages([healthStage('a', { requires: 'b' })]), /requires 必须是数组/);
  assert.throws(() => normalizeStages([healthStage('a', { requires: [''] })]), /requires\[0\] 不能为空/);
  assert.throws(() => normalizeStages([healthStage('a', { requires: ['a'] })]), /不能依赖自己/);
  assert.throws(() => normalizeStages([healthStage('a', { requires: ['b'] })]), /不存在的阶段/);
  assert.throws(
    () => normalizeStages([
      healthStage('a', { requires: ['b'] }),
      healthStage('b', { requires: ['a'] })
    ]),
    /循环依赖/
  );
});

test('normalizeStages：超过 20 个阶段 → throw', () => {
  const many = Array.from({ length: 21 }, (_, i) => healthStage(`s${i}`));
  assert.throws(() => normalizeStages(many), /最多 20 个阶段/);
});

test('normalizeStages：合法混合阶段保留 check 默认值与依赖关系', () => {
  const stages = normalizeStages([
    { id: 'login', kind: 'webCheck', check: validWebCheck(), requires: [] },
    { id: 'health', kind: 'health', check: { url: 'http://127.0.0.1:3000/health' }, requires: ['login'] }
  ]);
  assert.equal(stages.length, 2);
  assert.equal(stages[0].kind, 'webCheck');
  assert.equal(stages[1].kind, 'health');
  assert.deepEqual(stages[1].requires, ['login']);
  assert.equal(stages[1].check.expectStatus, 200);
  assert.equal(stages[1].check.timeoutMs, 5000);
});

// ---- evaluateStage ----

test('evaluateStage：健康检查通过 → ok，artifacts 带状态码', async () => {
  const server = createServer();
  const baseUrl = await listen(server);
  try {
    const result = await evaluateStage(
      { userId: 'u1', taskId: 't1' },
      { id: 'health', kind: 'health', check: { url: `${baseUrl}/health` } },
      { id: 'run_1', lastGreen: '' }
    );
    assert.equal(result.stageId, 'health');
    assert.equal(result.ok, true);
    assert.match(result.reason, /通过/);
    assert.equal(result.artifacts.kind, 'health');
    assert.equal(result.artifacts.verdict, 'verified');
    assert.equal(result.artifacts.status, 200);
    assert.equal(result.commitSha, '');
  } finally {
    await close(server);
  }
});

test('evaluateStage：健康检查状态码不符 → failed', async () => {
  const server = createServer({ healthStatus: 500 });
  const baseUrl = await listen(server);
  try {
    const result = await evaluateStage(
      {},
      { id: 'health', kind: 'health', check: { url: `${baseUrl}/health` } },
      null
    );
    assert.equal(result.ok, false);
    assert.equal(result.artifacts.verdict, 'failed');
    assert.equal(result.artifacts.errorKind, 'statusMismatch');
    assert.equal(result.artifacts.status, 500);
  } finally {
    await close(server);
  }
});

test('evaluateStage：连接失败 → error', async () => {
  const server = createServer();
  const baseUrl = await listen(server);
  await close(server);
  const result = await evaluateStage(
    {},
    { id: 'health', kind: 'health', check: { url: `${baseUrl}/health`, timeoutMs: 1000 } },
    null
  );
  assert.equal(result.ok, false);
  assert.equal(result.artifacts.verdict, 'error');
  assert.equal(result.artifacts.errorKind, 'networkError');
});

test('evaluateStage：健康检查声明非法 → error / invalid，不抛异常', async () => {
  const result = await evaluateStage({}, { id: 'health', kind: 'health', check: {} }, null);
  assert.equal(result.ok, false);
  assert.equal(result.artifacts.verdict, 'error');
  assert.equal(result.artifacts.errorKind, 'invalid');
});

test('evaluateStage：通过且已有绿点 → 回填 commitSha', async () => {
  const server = createServer();
  const baseUrl = await listen(server);
  try {
    const result = await evaluateStage(
      {},
      { id: 'health', kind: 'health', check: { url: `${baseUrl}/health` } },
      { id: 'run_1', lastGreen: 'abc123' }
    );
    assert.equal(result.ok, true);
    assert.equal(result.commitSha, 'abc123');
  } finally {
    await close(server);
  }
});

test('evaluateStage：webCheck 缺 coding 依赖 → error', async () => {
  const result = await evaluateStage({}, { id: 'login', kind: 'webCheck', check: validWebCheck() }, null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /缺少 coding 依赖/);
  assert.equal(result.artifacts.kind, 'webCheck');
});

test('evaluateStage：webCheck 判据非法 → 不抛异常，返回 error', async () => {
  const result = await evaluateStage(
    { coding: {}, userId: 'u1', taskId: 't1' },
    { id: 'login', kind: 'webCheck', check: {} },
    null
  );
  assert.equal(result.ok, false);
  assert.equal(result.artifacts.verdict, 'error');
  assert.match(result.reason, /webCheck/);
});

test('evaluateStage：执行期异常被捕获', async () => {
  const ctx = {
    get coding() {
      throw new Error('boom');
    },
    userId: 'u1',
    taskId: 't1'
  };
  const result = await evaluateStage(ctx, { id: 'login', kind: 'webCheck', check: validWebCheck() }, null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /阶段验收执行失败: boom/);
  assert.equal(result.artifacts.verdict, 'error');
});

test('evaluateStage：阶段缺失 / 未知 kind → ok=false', async () => {
  const missing = await evaluateStage({}, null, null);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /阶段定义缺失/);

  const unknown = await evaluateStage({}, { id: 'x', kind: 'deploy' }, null);
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /未知阶段类型/);
});
