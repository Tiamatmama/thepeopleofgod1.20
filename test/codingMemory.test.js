'use strict';

// 编码工作记忆：只记结构化事实、按上限收敛、落盘可恢复，且不因 userId/taskId 越界写文件。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CodingMemory, LIMITS } = require('../src/core/codingMemory');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coding-memory-'));
}

test('读文件去重：同一路径只留一条，并排在最近的位置', () => {
  const memory = new CodingMemory({ userId: 'u1', taskId: 't1', baseDir: tempDir() });
  memory.recordToolCall('code_read_range', { path: 'a.js' }, true, 'ok');
  memory.recordToolCall('code_read_range', { path: 'b.js' }, true, 'ok');
  memory.recordToolCall('code_read_range', { path: 'a.js' }, true, 'ok');
  const read = memory.data.filesRead;
  assert.equal(read.length, 2);
  assert.equal(read[read.length - 1], 'a.js');
});

test('改文件：同一路径覆盖旧记录，失败标记会带进渲染文本', () => {
  const memory = new CodingMemory({ userId: 'u1', taskId: 't1', baseDir: tempDir() });
  memory.recordToolCall('code_apply_patch', { path: 'src/app.js' }, false, 'oldText 未命中');
  memory.recordToolCall('code_apply_patch', { path: 'src/app.js' }, true, 'ok');
  assert.equal(memory.data.filesChanged.length, 1);
  assert.equal(memory.data.filesChanged[0].ok, true);
  assert.match(memory.render(), /已改文件：src\/app\.js/);
});

test('测试失败：只保留限长的单行报错，并出现在「最近验证」里', () => {
  const memory = new CodingMemory({ userId: 'u1', taskId: 't1', baseDir: tempDir() });
  const noise = 'Error: expected 1\n'.repeat(80);
  memory.recordToolCall('code_run_tests', { command: 'npm test' }, false, noise);
  const check = memory.data.checks[0];
  assert.equal(check.ok, false);
  assert.ok(check.detail.length <= LIMITS.lineChars);
  assert.ok(!check.detail.includes('\n'));
  assert.match(memory.render(), /code_run_tests 失败/);
});

test('验证记录按上限收敛，旧记录被挤掉', () => {
  const memory = new CodingMemory({ userId: 'u1', taskId: 't1', baseDir: tempDir() });
  for (let i = 0; i < LIMITS.checks + 6; i++) {
    memory.recordToolCall('code_diagnose', { path: `f${i}.js` }, i % 2 === 0, `第 ${i} 次`);
  }
  assert.equal(memory.data.checks.length, LIMITS.checks);
  assert.ok(!memory.data.checks.some(item => item.detail === '第 0 次'));
});

test('空记忆渲染为空串，不往 prompt 里塞空标题', () => {
  const memory = new CodingMemory({ userId: 'u1', taskId: 't1', baseDir: tempDir() });
  assert.equal(memory.render(), '');
});

test('落盘后可恢复：目标、读过的文件、失败验证都还在', () => {
  const baseDir = tempDir();
  const first = new CodingMemory({ userId: 'u1', taskId: 't1', baseDir });
  first.setGoal('把登录页改成深色').save();
  first.recordToolCall('code_read_range', { path: 'public/login.html' }, true, 'ok');
  first.recordToolCall('code_run_tests', { command: 'npm test' }, false, '1 failing');
  const second = new CodingMemory({ userId: 'u1', taskId: 't1', baseDir }).load();
  assert.equal(second.data.goal, '把登录页改成深色');
  assert.deepEqual(second.data.filesRead, ['public/login.html']);
  assert.equal(second.data.checks.length, 1);
  assert.equal(second.data.checks[0].ok, false);
});

test('坏文件不挡任务：JSON 损坏时按空记忆继续', () => {
  const baseDir = tempDir();
  const file = path.join(baseDir, 'u1', 't1.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json', 'utf8');
  const memory = new CodingMemory({ userId: 'u1', taskId: 't1', baseDir }).load();
  assert.deepEqual(memory.data.filesRead, []);
  memory.setGoal('重新开始');
  assert.equal(memory.data.goal, '重新开始');
});

test('userId / taskId 不能穿出 baseDir', () => {
  const baseDir = tempDir();
  const memory = new CodingMemory({ userId: '../../etc', taskId: '../evil', baseDir });
  const target = memory.filePath();
  assert.ok(target.startsWith(baseDir));
  assert.ok(!target.includes('..'));
});

test('渲染长度有硬上限，超长记忆被截断', () => {
  const memory = new CodingMemory({ userId: 'u1', taskId: 't1', baseDir: tempDir() });
  memory.setGoal('x'.repeat(300));
  for (let i = 0; i < 60; i++) {
    memory.recordToolCall('code_read_range', { path: `very/long/path/file-${i}.js` }, true, 'ok');
    memory.note(`备注 ${i} ` + 'y'.repeat(180));
  }
  const text = memory.render(400);
  assert.ok(text.length <= 401);
  assert.match(text, /编码工作记忆/);
});
