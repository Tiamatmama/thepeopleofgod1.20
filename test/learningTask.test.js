'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LearningTaskCenter, validateSource, validateRequest } = require('../src/core/learningTask');
const { ResourceGuard } = require('../src/core/resourceGuard');
const { LearningStore } = require('../src/core/learningStore');

const DAY = new Date(2026, 10, 6, 14, 0, 0).getTime();

function makeCenter(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pog-learn-'));
  const now = options.now || (() => DAY);
  const guard = options.guard || new ResourceGuard({ root, now });
  const store = options.store || new LearningStore({ root, now });
  const events = [];
  const center = new LearningTaskCenter({
    root,
    now,
    guard,
    store,
    watchdogMs: 0,
    timeline: { append: (...args) => events.push(args) },
    ...options
  });
  return { center, root, events, guard, store };
}

function baseRequest(extra = {}) {
  return {
    goal: '统计公开数据集的行数分布',
    kind: 'analysis',
    sources: ['https://huggingface.co/datasets/demo/data'],
    script: 'print("hello")',
    ...extra
  };
}

test('L1：来源白名单只放行指定主机与路径', () => {
  assert.equal(validateSource('https://huggingface.co/datasets/demo').ok, true);
  assert.equal(validateSource('https://raw.githubusercontent.com/a/b/main/x.json').ok, true);
  assert.equal(validateSource('https://archive.ics.uci.edu/ml/datasets/demo').ok, true);
  assert.equal(validateSource('https://www.kaggle.com/datasets/demo').ok, true);

  assert.equal(validateSource('http://huggingface.co/datasets/demo').ok, false);
  assert.equal(validateSource('https://huggingface.co/models/demo').ok, false);
  assert.equal(validateSource('https://example.com/demo.json').ok, false);
  assert.equal(validateSource('https://user:pass@huggingface.co/datasets/demo').ok, false);
  assert.equal(validateSource('not-a-url').ok, false);
});

test('L2：validateRequest 检查必填、类型、retain 的 license 与脚本', () => {
  assert.equal(validateRequest(baseRequest()).ok, true);
  assert.equal(validateRequest({ goal: '', sources: [] }).ok, false);
  assert.equal(validateRequest(baseRequest({ kind: 'nope' })).ok, false);
  assert.equal(validateRequest(baseRequest({ sources: ['https://example.com/x'] })).ok, false);
  assert.equal(validateRequest(baseRequest({ retain: true })).ok, false);
  assert.equal(validateRequest(baseRequest({ retain: true, license: 'MIT' })).ok, true);
  assert.equal(validateRequest(baseRequest({ script: 'x'.repeat(20001) })).ok, false);
});

test('L3：磁盘配额不足时创建被拒绝，不落半成品任务', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pog-learn-'));
  try {
    const guard = new ResourceGuard({
      root,
      now: () => DAY,
      buckets: { datasets: 100, assets: 100, weights: 100, workspace: 100 }
    });
    const center = new LearningTaskCenter({ root, now: () => DAY, guard, watchdogMs: 0, timeline: { append() {} } });
    fs.mkdirSync(path.join(root, 'datasets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'datasets', 'big.bin'), Buffer.alloc(96));

    const result = center.create(baseRequest({ estimatedBytes: 10 }));
    assert.equal(result.success, false);
    assert.equal(result.reason, 'quota');
    assert.equal(center.list().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('L4：创建计划写入任务与时间线事件，参数错误直接返回 errors', () => {
  const { center, events, root } = makeCenter();
  try {
    const created = center.create(baseRequest());
    assert.equal(created.success, true);
    assert.match(created.taskId, /^[a-z0-9-]+$/i);
    assert.equal(center.get(created.taskId).task.status, 'planned');
    assert.equal(center.list().length, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0][1], 'learning.task');

    const bad = center.create(baseRequest({ sources: [] }));
    assert.equal(bad.success, false);
    assert.ok(Array.isArray(bad.errors) && bad.errors.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('L5：执行成功 → 产出文件带 manifest 留存，并清理 datasets 临时目录', async () => {
  const executor = async ({ cwd }) => {
    fs.writeFileSync(path.join(cwd, 'summary.json'), '{"rows":3}', 'utf8');
    return { success: true, exitCode: 0, stdout: 'done', stderr: '' };
  };
  const { center, root, events, store } = makeCenter({ executor });
  try {
    const created = center.create(baseRequest({ retain: true, license: 'MIT' }));
    assert.equal(created.success, true);

    const tempDir = path.join(root, 'datasets', created.taskId);
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'raw.bin'), Buffer.alloc(8));

    const result = await center.run(created.taskId);
    assert.equal(result.success, true);
    assert.equal(result.stdout, 'done');
    assert.equal(result.retained.success, true);
    assert.equal(fs.existsSync(tempDir), false);

    const artifact = store.get(result.retained.id);
    assert.equal(artifact.success, true);
    assert.equal(artifact.manifest.source, 'https://huggingface.co/datasets/demo/data');
    assert.equal(artifact.manifest.license, 'MIT');
    assert.equal(
      fs.readFileSync(path.join(artifact.dir, 'summary.json'), 'utf8'),
      '{"rows":3}'
    );

    const saved = center.get(created.taskId).task;
    assert.equal(saved.status, 'done');
    assert.ok(saved.result.retained.id);
    assert.deepEqual(events.map((item) => item[1]), [
      'learning.task', 'learning.task', 'learning.task', 'learning.artifact'
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('L6：资源闸暂停时任务标记 blocked，不启动执行器', async () => {
  let called = 0;
  const executor = async () => {
    called += 1;
    return { success: true, exitCode: 0 };
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pog-learn-'));
  try {
    const guard = new ResourceGuard({ root, now: () => DAY });
    guard.cooldownUntil = DAY + 60 * 1000;
    const center = new LearningTaskCenter({
      root, now: () => DAY, guard, executor, watchdogMs: 0, timeline: { append() {} }
    });
    const created = center.create(baseRequest());
    const result = await center.run(created.taskId);
    assert.equal(result.success, false);
    assert.equal(result.error.includes('资源闸拒绝'), true);
    assert.equal(called, 0);
    assert.equal(center.get(created.taskId).task.status, 'blocked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('L7：执行失败标记 failed；retain=false 不留存', async () => {
  const executor = async () => ({ success: false, exitCode: 1, stdout: '', stderr: 'boom', error: '进程非零退出' });
  const { center, root, store } = makeCenter({ executor });
  try {
    const failed = center.create(baseRequest({ retain: true, license: 'MIT' }));
    const failedResult = await center.run(failed.taskId);
    assert.equal(failedResult.success, false);
    assert.equal(center.get(failed.taskId).task.status, 'failed');
    assert.equal(store.list().length, 0);

    const okExecutor = async ({ cwd }) => {
      fs.writeFileSync(path.join(cwd, 'x.json'), '{}', 'utf8');
      return { success: true, exitCode: 0 };
    };
    center.executor = okExecutor;
    const noRetain = center.create(baseRequest({ retain: false }));
    const noRetainResult = await center.run(noRetain.taskId);
    assert.equal(noRetainResult.success, true);
    assert.equal(noRetainResult.retained, null);
    assert.equal(store.list().length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('L8：run 缺少脚本直接拒绝；status 汇总磁盘 / CPU / 产物', async () => {
  const { center, root } = makeCenter();
  try {
    const created = center.create(baseRequest({ script: '' }));
    const result = await center.run(created.taskId);
    assert.equal(result.success, false);
    assert.match(result.error, /没有脚本/);
    const status = center.status();
    assert.ok(status.disk.buckets.datasets);
    assert.ok(status.cpu.level);
    assert.equal(status.artifacts.count, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
