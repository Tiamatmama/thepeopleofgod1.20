'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TimelineStore, dayKey } = require('../src/core/timeline');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-'));
  return { store: new TimelineStore({ dir }), dir };
}

function readRaw(store, day, scope) {
  return fs.readFileSync(path.join(store.dir, day, `${scope}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('T1：append / readDay 往返，payload 原样存取', () => {
  const { store, dir } = makeStore();
  try {
    const at = new Date(2026, 10, 6, 10, 0, 0).getTime();
    assert.equal(store.append('u1__role', 'memory.created', { mid: 'm1', text: '记得吃药' }, { now: at }), true);
    const list = store.readDay('u1__role', '2026-11-06');
    assert.equal(list.length, 1);
    assert.equal(list[0].type, 'memory.created');
    assert.deepEqual(list[0].payload, { mid: 'm1', text: '记得吃药' });
    assert.equal(list[0].v, 1);
    assert.equal(list[0].seq, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T2：同一天同一档 seq 连续；不同档各自从 1 开始', () => {
  const { store, dir } = makeStore();
  try {
    const at = new Date(2026, 10, 6, 10, 0, 0).getTime();
    store.append('u1__role', 'message.in', { text: '你好' }, { now: at });
    store.append('u1__role', 'message.out', { text: '在的' }, { now: at + 1000 });
    store.append('u1__ai', 'message.in', { text: '跑测试' }, { now: at + 2000 });
    const role = readRaw(store, '2026-11-06', 'u1__role');
    const ai = readRaw(store, '2026-11-06', 'u1__ai');
    assert.deepEqual(role.map((r) => r.seq), [1, 2]);
    assert.deepEqual(ai.map((r) => r.seq), [1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T3：进程内已有文件时，seq 从文件行数续上（重启不重号）', () => {
  const { store, dir } = makeStore();
  try {
    const day = '2026-11-06';
    const at = new Date(2026, 10, 6, 10, 0, 0).getTime();
    store.append('u1__role', 'memory.created', { text: '第一' }, { now: at });
    store.append('u1__role', 'memory.created', { text: '第二' }, { now: at + 1 });
    const fresh = new TimelineStore({ dir });
    fresh.append('u1__role', 'memory.created', { text: '第三' }, { now: at + 2 });
    assert.deepEqual(readRaw(fresh, day, 'u1__role').map((r) => r.seq), [1, 2, 3]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T4：跨天分片，各天独立', () => {
  const { store, dir } = makeStore();
  try {
    const d1 = new Date(2026, 10, 6, 23, 50, 0).getTime();
    const d2 = new Date(2026, 10, 7, 0, 10, 0).getTime();
    store.append('u1__role', 'speech.proactive', { text: '晚安' }, { now: d1 });
    store.append('u1__role', 'speech.proactive', { text: '早' }, { now: d2 });
    assert.equal(store.readDay('u1__role', '2026-11-06').length, 1);
    assert.equal(store.readDay('u1__role', '2026-11-07').length, 1);
    assert.deepEqual(store.listDays('u1__role'), ['2026-11-07', '2026-11-06']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T5：坏行跳过并计数，不影响其余行', () => {
  const { store, dir } = makeStore();
  try {
    const day = '2026-11-06';
    const at = new Date(2026, 10, 6, 10, 0, 0).getTime();
    store.append('u1__role', 'memory.created', { text: '好行' }, { now: at });
    fs.appendFileSync(path.join(dir, day, 'u1__role.jsonl'), '{"v":1,半截\n', 'utf8');
    store.append('u1__role', 'memory.created', { text: '又一条好行' }, { now: at + 1 });
    const list = store.readDay('u1__role', day);
    assert.equal(list.length, 2);
    assert.equal(store.badLines, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T6：types 过滤只取指定事件类', () => {
  const { store, dir } = makeStore();
  try {
    const at = new Date(2026, 10, 6, 10, 0, 0).getTime();
    store.append('u1__role', 'message.in', { text: 'a' }, { now: at });
    store.append('u1__role', 'message.out', { text: 'b' }, { now: at + 1 });
    const only = store.readDay('u1__role', '2026-11-06', { types: ['message.in'] });
    assert.equal(only.length, 1);
    assert.equal(only[0].payload.text, 'a');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T7：非法 scopeKey 拒绝写入，不越出时间线目录', () => {
  const { store, dir } = makeStore();
  try {
    const at = new Date(2026, 10, 6, 10, 0, 0).getTime();
    assert.equal(store.append('../evil', 'memory.created', { text: 'x' }, { now: at }), false);
    assert.equal(store.append('a/b', 'memory.created', { text: 'x' }, { now: at }), false);
    assert.equal(store.append('', 'memory.created', { text: 'x' }, { now: at }), false);
    assert.equal(store.failures, 3);
    assert.equal(fs.existsSync(path.join(dir, 'evil')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T8：没有记录时 readDay / listDays 返回空，不抛错', () => {
  const { store, dir } = makeStore();
  try {
    assert.deepEqual(store.readDay('u1__role', '2026-11-06'), []);
    assert.deepEqual(store.listDays('u1__role'), []);
    assert.deepEqual(store.readDay('u1__role', 'not-a-date'), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T9：订阅者收到事件；订阅者抛错不影响写入', () => {
  const { store, dir } = makeStore();
  try {
    const seen = [];
    store.subscribe((record) => seen.push(record.type));
    store.subscribe(() => { throw new Error('模拟订阅失败'); });
    const at = new Date(2026, 10, 6, 10, 0, 0).getTime();
    assert.equal(store.append('u1__role', 'life.event', { text: '散步' }, { now: at }), true);
    assert.deepEqual(seen, ['life.event']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('T10：dayKey 用本地日期，凌晨不被算到前一天', () => {
  const local = new Date(2026, 10, 6, 0, 30, 0);
  assert.equal(dayKey(local), '2026-11-06');
});
