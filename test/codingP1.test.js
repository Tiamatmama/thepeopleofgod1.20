'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CodingCenter = require('../src/core/coding');
const CodingLoop = require('../src/core/codingLoop');

// 每个用例一个独立临时目录，互不干扰
function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `coding-p1-${tag}-`));
}

// 造一个只桩掉 toolRegistry 的 CodingLoop；coding 只需支持 dir / taskDir / safeTaskId / createWorkspace
function makeLoop(coding) {
  const toolRegistry = { codeDiagnose: async () => ({ success: true, errorCount: 0, errors: [] }) };
  return new CodingLoop({ coding, outputModule: {}, toolRegistry });
}

// ---- 动作 7：任务板升级（旧扁构数据仍可读）----

test('任务板：旧扁构任务（无 parent/order）读入时被非破坏性补齐', () => {
  const center = new CodingCenter(tmpRoot('tasks'));
  // 手写「旧结构」：完全没有 parent / order 字段
  fs.writeFileSync(center.tasksFile, JSON.stringify({
    seq: 1,
    tasks: [{ id: 'c_1', title: '旧任务一', desc: '', params: {}, status: 'todo', result: '', createdAt: '', updatedAt: '' }]
  }), 'utf8');

  const tasks = center.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'c_1');
  assert.equal(tasks[0].parent, '');
  assert.equal(tasks[0].order, 0); // 缺省沿用数组下标
});

test('任务板：addTask 支持 parent（悬空父子被拒）/order，updateTask 可改 parent', () => {
  const center = new CodingCenter(tmpRoot('tasks2'));
  const root = center.addTask({ title: '父任务' });
  assert.equal(root.success, true);

  // 悬空 parent（指向不存在的任务）被归零，防止挂到不存在的父节点上
  const dangling = center.addTask({ title: '悬空', parent: 'c_not_exist' });
  assert.equal(dangling.task.parent, '');

  const child = center.addTask({ title: '子任务', parent: root.task.id, order: 7 });
  assert.equal(child.task.parent, root.task.id);
  assert.equal(child.task.order, 7);

  // updateTask：改父 + 清空父
  const moved = center.updateTask(child.task.id, { parent: '' });
  assert.equal(moved.task.parent, '');
  const reparent = center.updateTask(child.task.id, { parent: root.task.id });
  assert.equal(reparent.task.parent, root.task.id);
  // 非法 parent 不改动
  const bad = center.updateTask(child.task.id, { parent: 'c_nope' });
  assert.equal(bad.task.parent, root.task.id);
});

// ---- 动作 5：project.json 独立状态 + 旧 AGENTS.md 迁移可读 ----

test('项目状态：只有旧 AGENTS.md 时，迁移态可读（不丢历史）', () => {
  const dir = tmpRoot('mem');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 旧记忆\n\n关键约定：先跑测试再提交。', 'utf8');
  const loop = makeLoop({ dir, taskDir: () => dir });
  const ctx = { userId: 'u1', taskId: 't1' };

  const state = loop.loadProjectState(ctx);
  assert.equal(state.status, 'legacy');
  assert.equal(state.migratedFrom, 'AGENTS.md');

  const mem = loop.loadProjectMemory(ctx);
  assert.ok(mem.includes('先跑测试再提交'));
});

test('项目状态：updateProjectMemory 落 project.json（带 projectId）并把 AGENTS.md 变只读投影', () => {
  const dir = tmpRoot('proj');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '旧内容 OLD-MARKER', 'utf8');
  const loop = makeLoop({ dir, taskDir: () => dir });
  const ctx = { userId: 'u1', taskId: 't1' };
  const run = { id: 'run_1', goal: '实现加法', status: 'passed', maxIterations: 12, iterations: [{}, {}, {}], result: '完成' };

  loop.updateProjectMemory(ctx, run);

  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  assert.equal(pj.version, 1);
  assert.equal(pj.projectId, 'u1__t1');
  assert.equal(pj.goal, '实现加法');
  assert.equal(pj.progress.length, 1);
  assert.equal(pj.progress[0].runId, 'run_1');
  // 迁移态：旧 AGENTS.md 原文被收进教训，避免一迁移就丢历史
  assert.ok(pj.lessons.some(l => l.text.includes('OLD-MARKER')));

  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('由 project.json 自动投影生成'));
  assert.ok(agents.includes('实现加法'));

  // 再更新一次：AGENTS.md 是「覆盖投影」而非追加，投影头只应有一份（不再累积污染）
  loop.updateProjectMemory(ctx, { ...run, id: 'run_2' });
  const agents2 = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.equal(agents2.split('由 project.json 自动投影生成').length - 1, 1);
  const pj2 = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  assert.equal(pj2.progress.length, 2);
});

// ---- 动作 6：L3 停滞熔断（结构化签名 + K 最小值）----

test('停滞熔断：同一失败签名连续 K-1 轮不触发、第 K 轮触发', () => {
  const loop = makeLoop({ dir: os.tmpdir(), taskDir: () => '' });
  const K = 3;
  const check = { errorKind: 'testFailure', failed: 1, failedNames: ['加法应正确'] };

  let s = loop.advanceStall(null, check, K);
  assert.equal(s.count, 1);
  assert.equal(s.stalled, false);

  s = loop.advanceStall(s, check, K);
  assert.equal(s.count, 2);
  assert.equal(s.stalled, false); // K-1 轮不触发

  s = loop.advanceStall(s, check, K);
  assert.equal(s.count, 3);
  assert.equal(s.stalled, true);  // 第 K 轮触发
});

test('停滞熔断：换签名即重置计数（改一处→换一组错，不算停滞）', () => {
  const loop = makeLoop({ dir: os.tmpdir(), taskDir: () => '' });
  const K = 3;
  let s = loop.advanceStall(null, { errorKind: 'testFailure', failed: 1, failedNames: ['A'] }, K);
  s = loop.advanceStall(s, { errorKind: 'testFailure', failed: 1, failedNames: ['A'] }, K);
  assert.equal(s.count, 2);

  // 签名变化（失败用例集合变了）→ 重置为 1
  s = loop.advanceStall(s, { errorKind: 'testFailure', failed: 2, failedNames: ['A', 'B'] }, K);
  assert.equal(s.count, 1);
  assert.equal(s.stalled, false);
});

test('停滞熔断：签名对失败用例名的顺序/重复不敏感（结构化，非字符串比较）', () => {
  const loop = makeLoop({ dir: os.tmpdir(), taskDir: () => '' });
  const a = loop.stallSignature({ errorKind: 'testFailure', failed: 2, failedNames: ['B', 'A', 'A'] });
  const b = loop.stallSignature({ errorKind: 'testFailure', failed: 2, failedNames: ['A', 'B'] });
  assert.equal(a, b);
});

test('prepare：stallK 有下限，小于 STALL_K_MIN 会被抬到下限', () => {
  const coding = {
    dir: os.tmpdir(),
    taskDir: () => '',
    safeTaskId: (s) => String(s || ''),
    createWorkspace: () => ({ success: true })
  };
  const loop = makeLoop(coding);
  const low = loop.prepare({ userId: 'u1', taskId: 't1', goal: 'x', stallK: 1 });
  assert.equal(low.stallK, 3);
  const normal = loop.prepare({ userId: 'u1', taskId: 't1', goal: 'x', stallK: 5 });
  assert.equal(normal.stallK, 5);
  const absent = loop.prepare({ userId: 'u1', taskId: 't1', goal: 'x' });
  assert.equal(absent.stallK, 3);
});
