'use strict';

// 编辑后自动诊断：写入成功后立刻做语法检查，把行级报错随写回结果一起回灌给模型。
// 这里只测「回灌策略」，真正跑 node --check 的行为由 codeDiagnose 自己的用例覆盖。

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const { ToolRegistry } = require('../src/core/toolRegistry');

function makeRegistry(diag) {
  const calls = [];
  const registry = new ToolRegistry({ projectRoot: os.tmpdir() });
  registry.enabled = true;
  registry.codeDiagnose = async (args) => {
    calls.push(args);
    return typeof diag === 'function' ? diag(args) : diag;
  };
  return { registry, calls };
}

test('JS 写入成功后诊断出语法错误：保留 success，附行级报错与修复提示', async () => {
  const diag = {
    success: false,
    checked: 1,
    errorCount: 2,
    errors: [
      { path: 'src/a.js', message: 'a.js:3 Unexpected token' },
      { path: 'src/a.js', message: 'a.js:9 Unexpected end of input' }
    ]
  };
  const { registry, calls } = makeRegistry(diag);
  const result = await registry.withAutoDiagnose(
    { success: true, taskId: 't1', path: 'src/a.js' },
    { taskId: 't1', path: 'src/a.js' }
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { taskId: 't1', path: 'src/a.js' });
  assert.equal(result.success, true);
  assert.equal(result.diagnose.ok, false);
  assert.equal(result.diagnose.errorCount, 2);
  assert.equal(result.diagnose.errors.length, 2);
  assert.match(result.warning, /语法诊断未通过/);
});

test('诊断通过：只加 diagnose.ok，不改原有字段', async () => {
  const { registry } = makeRegistry({ success: true, checked: 1, errorCount: 0, errors: [] });
  const result = await registry.withAutoDiagnose(
    { success: true, taskId: 't1', path: 'a.py', applied: [{ index: 1 }] },
    { taskId: 't1', path: 'a.py' }
  );
  assert.equal(result.success, true);
  assert.deepEqual(result.diagnose, { ok: true });
  assert.deepEqual(result.applied, [{ index: 1 }]);
});

test('非 JS/Python 文件不触发诊断，省一次进程', async () => {
  const { registry, calls } = makeRegistry({ success: true, errorCount: 0, errors: [] });
  const result = await registry.withAutoDiagnose(
    { success: true, taskId: 't1', path: 'docs/readme.md' },
    { taskId: 't1', path: 'docs/readme.md' }
  );
  assert.equal(calls.length, 0);
  assert.equal(result.diagnose, undefined);
});

test('写入本身失败时不再诊断，避免用诊断覆盖真正的错误', async () => {
  const { registry, calls } = makeRegistry({ success: true, errorCount: 0, errors: [] });
  const result = await registry.withAutoDiagnose(
    { success: false, error: 'oldText 未命中' },
    { taskId: 't1', path: 'a.js' }
  );
  assert.equal(calls.length, 0);
  assert.equal(result.success, false);
  assert.equal(result.error, 'oldText 未命中');
});

test('诊断器自身抛错不影响写入结果', async () => {
  const { registry } = makeRegistry(() => { throw new Error('spawn ENOENT'); });
  const original = { success: true, taskId: 't1', path: 'a.js', applied: [{ index: 1 }] };
  const result = await registry.withAutoDiagnose(original, { taskId: 't1', path: 'a.js' });
  assert.deepEqual(result, original);
});

test('taskId 缺省时沿用写回结果里的值', async () => {
  const { registry, calls } = makeRegistry({ success: true, errorCount: 0, errors: [] });
  await registry.withAutoDiagnose({ success: true, taskId: 'from-result', path: 'a.js' }, {});
  assert.deepEqual(calls[0], { taskId: 'from-result', path: 'a.js' });
});
