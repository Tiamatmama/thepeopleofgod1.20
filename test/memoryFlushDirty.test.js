'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MemoryModule = require('../src/core/memory');

// flushDirty 只依赖 _dirtyKeys / maintainStore / saveUserMemories，用原型对象造最小实例即可
function makeMemory(keys) {
  const mem = Object.create(MemoryModule.prototype);
  mem._dirtyKeys = new Set(keys);
  return mem;
}

// 临时吞掉 console.error，避免用例里预期的错误刷屏
function silence(fn) {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = orig;
  }
}

test('A1：单键 maintainStore 抛错不中断其余键，失败键保留待重试', () => {
  const mem = makeMemory(['u1__role', 'u2__role', 'u3__role']);
  const saved = [];
  mem.maintainStore = (key) => {
    if (key === 'u2__role') throw new Error('模拟维护失败');
    return { sweep: null, evicted: 0 };
  };
  mem.saveUserMemories = (key) => { saved.push(key); return true; };

  const n = silence(() => mem.flushDirty());

  assert.equal(n, 2);                                  // u1、u3 落盘成功
  assert.deepEqual(saved, ['u1__role', 'u3__role']);   // u2 因抛错从未落盘
  assert.equal(mem._dirtyKeys.has('u2__role'), true);  // 失败键保留，不静默丢更新
  assert.equal(mem._dirtyKeys.has('u1__role'), false);
  assert.equal(mem._dirtyKeys.has('u3__role'), false);
});

test('A1：saveUserMemories 返回 false（写失败）时该键保留待重试', () => {
  const mem = makeMemory(['u1__role', 'u2__role']);
  mem.maintainStore = () => ({ sweep: null, evicted: 0 });
  mem.saveUserMemories = (key) => key === 'u1__role'; // u2 写失败

  const n = silence(() => mem.flushDirty());

  assert.equal(n, 1);
  assert.equal(mem._dirtyKeys.has('u1__role'), false); // 成功键清除
  assert.equal(mem._dirtyKeys.has('u2__role'), true);  // 失败键保留
});

test('A1：无脏键时返回 0，且不触碰任何维护/落盘', () => {
  const mem = makeMemory([]);
  mem.maintainStore = () => { throw new Error('不该被调用'); };
  mem.saveUserMemories = () => { throw new Error('不该被调用'); };

  assert.equal(mem.flushDirty(), 0);
});

test('A1：循环中新产生的脏键不在快照内，不被误清', () => {
  const mem = makeMemory(['u1__role']);
  mem.maintainStore = () => ({ sweep: null, evicted: 0 });
  mem.saveUserMemories = (key) => {
    if (key === 'u1__role') mem._dirtyKeys.add('u2__role'); // 处理期间又标脏
    return true;
  };

  const n = silence(() => mem.flushDirty());

  assert.equal(n, 1);
  assert.equal(mem._dirtyKeys.has('u1__role'), false); // 本快照内成功键被清
  assert.equal(mem._dirtyKeys.has('u2__role'), true);  // 快照外的新脏键保留
});

// ---- 分片落盘：单次回调不把全部脏键写完 ----

test('分片落盘：maxKeys 只写前 N 个键，剩余键留在脏集合等下一批', () => {
  const mem = makeMemory(['u1__role', 'u2__role', 'u3__role']);
  mem.maintainStore = () => ({ sweep: null, evicted: 0 });
  mem.saveUserMemories = () => true;

  const n = mem.flushDirty({ maxKeys: 2 });

  assert.equal(n, 2);
  assert.equal(mem._dirtyKeys.size, 1);
});

test('分片落盘：有进展时按 200ms 续排下一批', () => {
  const mem = makeMemory(['u1__role', 'u2__role', 'u3__role']);
  mem.maintainStore = () => ({ sweep: null, evicted: 0 });
  mem.saveUserMemories = (key) => key !== 'u3__role'; // u3 持续写失败
  const delays = [];
  mem.scheduleFlush = (delay) => delays.push(delay);

  mem.flushDirtyChunk();

  assert.equal(delays.length, 1);
  assert.equal(delays[0], 200); // 2 条成功 → 尽快续刷
});

test('分片落盘：一条都没成功时退回常规节流，避免 200ms 空转', () => {
  const mem = makeMemory(['u1__role']);
  mem._flushDelayMs = 30000;
  mem.maintainStore = () => ({ sweep: null, evicted: 0 });
  mem.saveUserMemories = () => false;
  const delays = [];
  mem.scheduleFlush = (delay) => delays.push(delay);

  mem.flushDirtyChunk();

  assert.equal(delays.length, 1);
  assert.equal(delays[0], 30000);
});

// ---- A6：遗忘扫描节流按用户分桶 ----

// 裸实例：只补 maintainStore 需要的字段，getUserMemoryStore 桩成固定假 store
function makeSweepMemory() {
  const mem = Object.create(MemoryModule.prototype);
  mem._lastSweepAtByKey = new Map();
  mem.SWEEP_INTERVAL_MS = 10 * 60 * 1000;
  mem.getUserMemoryStore = () => ({ memories: [] });
  return mem;
}

test('A6：同一用户 10 分钟内二次维护不再全量扫描', () => {
  const mem = makeSweepMemory();

  const first = mem.maintainStore('u1');
  assert.ok(first.sweep, '首次维护应执行遗忘扫描');

  const second = mem.maintainStore('u1');
  assert.equal(second.sweep, null, '节流窗口内不再扫描');
});

test('A6：A 用户扫过不抑制 B 用户（按 key 各自独立）', () => {
  const mem = makeSweepMemory();

  mem.maintainStore('u1'); // u1 先扫，落下时间戳
  const other = mem.maintainStore('u2');

  assert.ok(other.sweep, 'u2 是另一个用户，应各自独立扫描，不被 u1 的时间戳压制');
  assert.equal(mem._lastSweepAtByKey.has(mem.normalizeScopeKey('u1')), true);
  assert.equal(mem._lastSweepAtByKey.has(mem.normalizeScopeKey('u2')), true);
});

test('A6：force=true 绕过节流，立刻扫描', () => {
  const mem = makeSweepMemory();

  mem.maintainStore('u1');
  const forced = mem.maintainStore('u1', { force: true });
  assert.ok(forced.sweep, 'force 应无视节流窗口直接扫描');
});

// ---- 自我认知「读即用」：markSelfTraitsUsed / flushSelfModelDirty ----

// 裸实例：loadSelfModel 桩成固定假档，_markSelfModelDirty 记录调用（不真起定时器）
function makeSelfTraitMemory(traits) {
  const mem = Object.create(MemoryModule.prototype);
  const model = { version: 1, updatedAt: 0, traits };
  mem.loadSelfModel = () => model;
  mem._markedKeys = [];
  mem._markSelfModelDirty = (key) => mem._markedKeys.push(key);
  return { mem, model };
}

test('B1：注入命中的条目 useCount+1、lastUsedAt 刷新，并标脏一次', () => {
  const { mem, model } = makeSelfTraitMemory([
    { text: '我最近很在意他有没有回消息', confidence: 0.6, useCount: 2, lastUsedAt: 0, updatedAt: 1 }
  ]);

  const touched = mem.markSelfTraitsUsed('u1__role', ['我最近很在意他有没有回消息']);

  assert.equal(touched, 1);
  assert.equal(model.traits[0].useCount, 3);          // 原 2 → 3
  assert.ok(model.traits[0].lastUsedAt > 0);          // 刷新为当前时间
  assert.deepEqual(mem._markedKeys, ['u1']);          // baseUserKey 剥掉 __role 后缀
});

test('B2：未知文本不计数、不标脏', () => {
  const { mem, model } = makeSelfTraitMemory([
    { text: '我最近很在意他有没有回消息', confidence: 0.6, useCount: 0, lastUsedAt: 0, updatedAt: 1 }
  ]);

  const touched = mem.markSelfTraitsUsed('u1', ['一条档里根本没有的认知']);

  assert.equal(touched, 0);
  assert.equal(model.traits[0].useCount, 0);
  assert.deepEqual(mem._markedKeys, []);
});

test('B3：空列表 / 非数组入参直接返回 0，不触碰档', () => {
  const { mem } = makeSelfTraitMemory([{ text: '在意他回不回消息', confidence: 0.6 }]);

  assert.equal(mem.markSelfTraitsUsed('u1', []), 0);
  assert.equal(mem.markSelfTraitsUsed('u1', null), 0);
  assert.deepEqual(mem._markedKeys, []);
});

test('B4：自我模型批量落盘——失败键保留、成功键清除', () => {
  const mem = Object.create(MemoryModule.prototype);
  mem._selfModelDirty = new Set(['u1', 'u2']);
  mem.saveSelfModel = (key) => key === 'u1'; // u2 写失败

  const n = silence(() => mem.flushSelfModelDirty());

  assert.equal(n, 1);
  assert.equal(mem._selfModelDirty.has('u1'), false);
  assert.equal(mem._selfModelDirty.has('u2'), true);
});

test('B5：无脏键时自我模型落盘返回 0，不触碰 saveSelfModel', () => {
  const mem = Object.create(MemoryModule.prototype);
  mem._selfModelDirty = new Set();
  mem.saveSelfModel = () => { throw new Error('不该被调用'); };

  assert.equal(mem.flushSelfModelDirty(), 0);
});

// ---- 自我认知变更历史：append-only、可追溯 ----

// 最小实例：只提供 loadSelfModel/saveSelfModel 桩与临时目录，不碰真实 data/
function makeHistoryMemory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-history-'));
  const mem = Object.create(MemoryModule.prototype);
  mem.selfModelDir = dir;
  mem.selfModelHistoryDir = path.join(dir, 'history');
  mem.selfModels = {};
  mem.loadSelfModel = () => ({ version: 1, updatedAt: 0, traits: [] });
  mem.saveSelfModel = () => true;
  return { mem, dir };
}

test('自我认知历史：新增落一条 add 记录，带来源记忆 id', () => {
  const { mem, dir } = makeHistoryMemory();
  const res = mem.upsertSelfTrait('u1__role', {
    text: '我开始相信不解释也没关系', source: 'reflect', sourceIds: ['m1', 'm2']
  });
  assert.equal(res.saved, true);

  const history = mem.getSelfModelHistory('u1', 10);
  assert.equal(history.length, 1);
  assert.equal(history[0].action, 'add');
  assert.equal(history[0].text, '我开始相信不解释也没关系');
  assert.deepEqual(history[0].sourceIds, ['m1', 'm2']);
  assert.ok(history[0].at > 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('自我认知历史：同一条再次提炼记为 merge，读取新的在前', () => {
  const { mem, dir } = makeHistoryMemory();
  const model = { version: 1, updatedAt: 0, traits: [] };
  mem.loadSelfModel = () => model;

  mem.upsertSelfTrait('u1', { text: '我最近很在意他有没有回消息', source: 'reflect' });
  const second = mem.upsertSelfTrait('u1', { text: '我最近很在意他有没有回消息', source: 'reflect' });
  assert.equal(second.merged, true);

  const history = mem.getSelfModelHistory('u1', 10);
  assert.deepEqual(history.map(item => item.action), ['merge', 'add']);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('自我认知历史：无记录返回空数组，limit 生效', () => {
  const { mem, dir } = makeHistoryMemory();
  assert.deepEqual(mem.getSelfModelHistory('nobody'), []);

  for (let i = 0; i < 3; i++) {
    mem.appendSelfModelHistory('u2', { action: 'add', text: `第 ${i} 条` });
  }
  assert.equal(mem.getSelfModelHistory('u2', 2).length, 2);
  assert.equal(mem.getSelfModelHistory('u2', 2)[0].text, '第 2 条');

  fs.rmSync(dir, { recursive: true, force: true });
});
