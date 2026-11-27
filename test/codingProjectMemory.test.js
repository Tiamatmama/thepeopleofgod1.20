'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CodingCenter = require('../src/core/coding');
const CodingLoop = require('../src/core/codingLoop');
const Board = require('../public/coding-board');

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `coding-proj-${tag}-`));
}

// 只桩掉 toolRegistry 的 CodingLoop（与 codingP1 同法）
function makeLoop(coding) {
  const toolRegistry = { codeDiagnose: async () => ({ success: true, errorCount: 0, errors: [] }) };
  return new CodingLoop({ coding, outputModule: {}, toolRegistry });
}

// 造一个真实存在的工作区目录（taskDir 自带 safeTaskId/userKey 派生）
function setupWorkspace(center, userId, taskId, projectJson) {
  const dir = center.taskDir(userId, taskId);
  fs.mkdirSync(dir, { recursive: true });
  if (projectJson !== undefined) {
    fs.writeFileSync(path.join(dir, 'project.json'), projectJson, 'utf8');
  }
  return dir;
}

// ---- projectProjection：白名单 DTO ----

test('projectProjection：键集合恰等于白名单，不外泄内部字段', () => {
  const center = new CodingCenter(tmpRoot('proj-keys'));
  const loop = makeLoop(center);
  const state = {
    version: 1,
    projectId: 'user__task',
    taskId: 'task',
    goal: '把登录做出来',
    status: 'active',
    updatedAt: '2026-10-14T00:00:00.000Z',
    missing: true,
    legacyText: 'SECRET-LEGACY',
    progress: [{ at: 't1', runId: 'r1', status: 'passed', iterations: 3, result: 'ok' }],
    lessons: [{ at: 't1', text: '别用 innerHTML' }]
  };
  const dto = loop.projectProjection(state);
  assert.deepEqual(Object.keys(dto).sort(),
    ['goal', 'hasMemory', 'lessons', 'progress', 'status', 'updatedAt']);
  assert.equal(dto.goal, '把登录做出来');
  assert.equal(dto.hasMemory, true);
  const blob = JSON.stringify(dto);
  for (const leak of ['projectId', 'version', 'taskId', 'legacyText', 'missing', 'SECRET-LEGACY']) {
    assert.ok(!blob.includes(leak), `不应外泄 ${leak}`);
  }
});

test('projectProjection：null/非对象/数组/缺字段被归一，且不炸', () => {
  const center = new CodingCenter(tmpRoot('proj-norm'));
  const loop = makeLoop(center);
  for (const bad of [null, undefined, 42, 'str', [], true]) {
    const dto = loop.projectProjection(bad);
    assert.equal(dto.goal, '');
    assert.equal(dto.status, 'active');
    assert.equal(dto.updatedAt, '');
    assert.deepEqual(dto.progress, []);
    assert.deepEqual(dto.lessons, []);
    assert.equal(dto.hasMemory, false);
  }
});

test('projectProjection：progress/lessons 逐项白名单 + 缺字段给空串', () => {
  const center = new CodingCenter(tmpRoot('proj-items'));
  const loop = makeLoop(center);
  const dto = loop.projectProjection({
    goal: '',
    progress: [{ runId: 7 }, 'junk', null, { at: 'a', status: 'failed', result: 'x' }],
    lessons: [{ text: 'a' }, { at: 'b' }]
  });
  assert.deepEqual(Object.keys(dto.progress[0]).sort(),
    ['at', 'iterations', 'result', 'runId', 'status']);
  // runId 数字 → 字符串；缺字段补空串
  assert.equal(dto.progress[0].runId, '7');
  assert.equal(dto.progress[0].at, '');
  assert.equal(dto.progress[0].iterations, '');
  // 非对象项被归成空壳，不抛
  assert.deepEqual(dto.progress[1], { at: '', runId: '', status: '', iterations: '', result: '' });
  assert.deepEqual(Object.keys(dto.lessons[0]).sort(), ['at', 'text']);
  assert.equal(dto.lessons[1].text, '');
  // progress 非空即视为有记忆
  assert.equal(dto.hasMemory, true);
});

// ---- readProjectMemory：404 与空态判定 ----

test('readProjectMemory：合法有文件 → exists:true + 投影', () => {
  const center = new CodingCenter(tmpRoot('read-ok'));
  const userId = 'alice';
  setupWorkspace(center, userId, 'ws1', JSON.stringify({
    version: 1, projectId: `${userId}__ws1`, taskId: 'ws1',
    goal: '做登录', status: 'active', updatedAt: '2026-10-14T00:00:00.000Z',
    progress: [{ at: 't', runId: 'r', status: 'passed', iterations: 2, result: 'done' }],
    lessons: [{ at: 't', text: '记得原子写' }]
  }));
  const loop = makeLoop(center);
  const r = loop.readProjectMemory(userId, 'ws1');
  assert.equal(r.exists, true);
  assert.equal(r.project.goal, '做登录');
  assert.equal(r.project.progress.length, 1);
  assert.equal(r.project.lessons[0].text, '记得原子写');
  assert.equal(r.project.hasMemory, true);
});

test('readProjectMemory：taskDir 不存在 → exists:false', () => {
  const center = new CodingCenter(tmpRoot('read-missing'));
  const loop = makeLoop(center);
  const r = loop.readProjectMemory('alice', 'never_created');
  assert.equal(r.exists, false);
  assert.equal(r.project, null);
});

test('readProjectMemory：非法 taskId（穿越/斜杠/空/数组/超长）→ exists:false', () => {
  const center = new CodingCenter(tmpRoot('read-bad'));
  const loop = makeLoop(center);
  const bad = ['..', '../x', 'a/b', 'a\\b', 'a:b', '', '   ', ['a', 'b'], {}, 'x'.repeat(5000)];
  for (const id of bad) {
    const r = loop.readProjectMemory('alice', id);
    assert.equal(r.exists, false, `taskId=${JSON.stringify(id)} 应 exists:false`);
  }
});

test('readProjectMemory：半截 / 非对象 project.json → exists:true + 空投影', () => {
  const center = new CodingCenter(tmpRoot('read-broken'));
  const userId = 'bob';
  setupWorkspace(center, userId, 'ws_broken', '{ "goal": "半截');
  setupWorkspace(center, userId, 'ws_arr', '[]');
  setupWorkspace(center, userId, 'ws_empty', '');
  const loop = makeLoop(center);
  for (const id of ['ws_broken', 'ws_arr', 'ws_empty']) {
    const r = loop.readProjectMemory(userId, id);
    assert.equal(r.exists, true, `${id} 应 exists:true`);
    assert.equal(r.project.goal, '');
    assert.deepEqual(r.project.progress, []);
    assert.deepEqual(r.project.lessons, []);
    assert.equal(r.project.hasMemory, false);
  }
});

// ---- 前端纯函数：safeLinkHref / projectView ----

test('safeLinkHref：仅放行 http/https，其余丢弃', () => {
  assert.equal(Board.safeLinkHref('https://example.com/x?a=1'), 'https://example.com/x?a=1');
  assert.equal(Board.safeLinkHref('http://example.com'), 'http://example.com');
  assert.equal(Board.safeLinkHref('  https://a.com  '), 'https://a.com');
  assert.equal(Board.safeLinkHref('javascript:alert(1)'), '');
  assert.equal(Board.safeLinkHref('data:text/html,<script>'), '');
  assert.equal(Board.safeLinkHref('ftp://x/y'), '');
  assert.equal(Board.safeLinkHref('/relative/path'), '');
  assert.equal(Board.safeLinkHref(''), '');
  assert.equal(Board.safeLinkHref(null), '');
  assert.equal(Board.safeLinkHref(undefined), '');
});

test('projectView：归一默认值 + updatedAt 非法归空', () => {
  const vm = Board.projectView(null);
  assert.equal(vm.goal, '');
  assert.equal(vm.status, 'active');
  assert.equal(vm.updatedAt, '');
  assert.deepEqual(vm.progress, []);
  assert.deepEqual(vm.lessons, []);
  assert.equal(vm.truncated, false);
  assert.equal(vm.total, 0);
  assert.equal(vm.hasMemory, false);

  const bad = Board.projectView({ goal: 'g', updatedAt: 'not-a-date', progress: [] });
  assert.equal(bad.updatedAt, '');
  assert.equal(bad.hasMemory, true);
});

test('projectView：progress 倒序 + 截断最近 N 条', () => {
  const vm = Board.projectView({
    goal: 'g',
    progress: [
      { runId: 'a', status: 'failed' },
      { runId: 'b', status: 'passed' },
      { runId: 'c', status: 'passed' }
    ],
    lessons: [{ text: 'l' }]
  }, 2);
  assert.equal(vm.total, 3);
  assert.equal(vm.truncated, true);
  assert.deepEqual(vm.progress.map(p => p.runId), ['c', 'b']);   // 最新的在前
  assert.equal(vm.lessons.length, 1);
  assert.equal(vm.hasMemory, true);
});

test('projectView：字符串强转，时间字段缺失不崩', () => {
  const vm = Board.projectView({
    goal: 123,
    progress: [{ runId: 9, iterations: 4 }],
    lessons: [{ text: 7 }]
  });
  assert.equal(vm.goal, '123');
  assert.equal(vm.progress[0].runId, '9');
  assert.equal(vm.progress[0].iterations, '4');
  assert.equal(vm.progress[0].at, '');
  assert.equal(vm.lessons[0].text, '7');
});
