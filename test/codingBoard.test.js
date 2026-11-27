'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const CodingBoard = require('../public/coding-board');

// 任务板 / 点子板 的纯视图逻辑（不触 DOM，可单测）。覆盖定稿 §3 用例矩阵 C12-C15。

test('groupTasksByStatus：三态分组，非法/缺失状态归 todo，同组保序（C12）', () => {
  const tasks = [
    { id: 'a', status: 'done' },
    { id: 'b', status: 'doing' },
    { id: 'c', status: 'bogus' },
    { id: 'd' },
    { id: 'e', status: 'doing' }
  ];
  const g = CodingBoard.groupTasksByStatus(tasks);
  assert.deepEqual(g.todo.map(t => t.id), ['c', 'd']);
  assert.deepEqual(g.doing.map(t => t.id), ['b', 'e']);
  assert.deepEqual(g.done.map(t => t.id), ['a']);
  // 非数组/空输入不炸
  assert.deepEqual(CodingBoard.groupTasksByStatus(null), { todo: [], doing: [], done: [] });
  assert.deepEqual(CodingBoard.groupTasksByStatus([]), { todo: [], doing: [], done: [] });
});

test('summarizeRun：优先在跑的（currentAll），否则回落最近历史（recent），都没有则 run:null（C13）', () => {
  const loop = {
    busy: true,
    currentAll: [{ taskId: 'spike_i_1', status: 'running', iteration: 2 }],
    recent: [{ taskId: 'spike_i_1', status: 'passed' }, { taskId: 'spike_i_2', status: 'failed' }]
  };
  assert.deepEqual(CodingBoard.summarizeRun(loop, 'spike_i_1'), { running: true, run: loop.currentAll[0] });
  assert.deepEqual(CodingBoard.summarizeRun(loop, 'spike_i_2'), { running: false, run: loop.recent[1] });
  assert.deepEqual(CodingBoard.summarizeRun(loop, 'nope'), { running: false, run: null });
  assert.deepEqual(CodingBoard.summarizeRun(null, 'x'), { running: false, run: null });
  assert.equal(CodingBoard.summarizeRun(loop, '').run, null); // 空 taskId 不误配
});

test('governanceHint：达阈值才提示，且只点名 spike_ 开头的产物；未达阈值不提示（C14）', () => {
  const few = Array.from({ length: 5 }, (_, i) => ({ taskId: 'w' + i }));
  assert.deepEqual(CodingBoard.governanceHint(few, 30), { total: 5, threshold: 30, over: false, candidates: [] });

  const many = [{ taskId: 'spike_i_1' }, { taskId: 'proj_a' }, { taskId: 'spike_i_2' }];
  const h = CodingBoard.governanceHint(many, 3);
  assert.equal(h.over, true);
  assert.deepEqual(h.candidates, ['spike_i_1', 'spike_i_2']);

  // 默认阈值 30；非数组不炸
  assert.equal(CodingBoard.governanceHint(null).threshold, 30);
  assert.equal(CodingBoard.governanceHint(null).over, false);
});

test('startErrorText：后端错误码翻成人话，未知码回落原文，全空给兜底（C15）', () => {
  assert.equal(CodingBoard.startErrorText('not_found'), '任务不存在或已被删除');
  assert.equal(CodingBoard.startErrorText('forbidden'), '这条任务不属于你，无法开跑');
  assert.equal(CodingBoard.startErrorText('conflict'), '这个工作区已经有闭环在跑了，先停或等它结束');
  assert.equal(CodingBoard.startErrorText('done'), '任务已完成，不再重复开跑');
  assert.equal(CodingBoard.startErrorText('unsupported_kind'), '这类任务不支持一键开跑（仅限 spike / 已验证实现的候选）');
  assert.equal(CodingBoard.startErrorText('weird', '原始错误'), '原始错误'); // 未知码回落原文
  assert.equal(CodingBoard.startErrorText('', ''), '开跑失败');             // 全空兜底
  assert.equal(CodingBoard.startErrorText(null, '   '), '开跑失败');
});

test('formatElapsed：毫秒→mm:ss，负数/非法/空回落 00:00（深化九 M1）', () => {
  assert.equal(CodingBoard.formatElapsed(0), '00:00');
  assert.equal(CodingBoard.formatElapsed(999), '00:00');     // 不足 1s 向下取整
  assert.equal(CodingBoard.formatElapsed(1000), '00:01');
  assert.equal(CodingBoard.formatElapsed(59000), '00:59');
  assert.equal(CodingBoard.formatElapsed(60000), '01:00');
  assert.equal(CodingBoard.formatElapsed(125000), '02:05');
  assert.equal(CodingBoard.formatElapsed(3600000), '60:00'); // 不封顶到小时，只到分钟
  // 非法/负值一律回落，绝不产生误导性计时
  assert.equal(CodingBoard.formatElapsed(-1), '00:00');
  assert.equal(CodingBoard.formatElapsed(NaN), '00:00');
  assert.equal(CodingBoard.formatElapsed(Infinity), '00:00');
  assert.equal(CodingBoard.formatElapsed('x'), '00:00');
  assert.equal(CodingBoard.formatElapsed(null), '00:00');
  assert.equal(CodingBoard.formatElapsed(undefined), '00:00');
});
