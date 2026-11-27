'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const MemoryModule = require('../src/core/memory');

// 只测纯算法，不落盘：借用原型上的方法即可
function makeMemory() {
  return Object.create(MemoryModule.prototype);
}

test('tokenizeForBm25：中文二元切分 + 拉丁按词 + 小写化', () => {
  const mem = makeMemory();
  const tokens = mem.tokenizeForBm25('今天聊 Node.js 和数据库');
  assert.ok(tokens.includes('node'));
  assert.ok(tokens.includes('js'));
  assert.ok(tokens.includes('今天'));
  assert.ok(tokens.includes('数据'));
  assert.ok(!tokens.includes('今'));
});

test('buildBm25Ranker：完全匹配排在部分匹配之前，无交集返回空', () => {
  const mem = makeMemory();
  const pool = [
    { id: 'a', data: '她喜欢在雨天听爵士乐', timestamp: 1 },
    { id: 'b', data: '雨天路滑，注意安全', timestamp: 2 },
    { id: 'c', data: '完全不相关的一条记忆', timestamp: 3 }
  ];
  const rank = mem.buildBm25Ranker(pool)('雨天爵士');
  assert.equal(rank[0].memory.id, 'a');
  assert.ok(rank.every(item => item.memory.id !== 'c'));
  assert.equal(mem.buildBm25Ranker(pool)('量子力学').length, 0);
});

test('fuseRrf：双路都靠前的条目胜过单路第一', () => {
  const mem = makeMemory();
  const a = { id: 'a', data: 'x', timestamp: 1 };
  const b = { id: 'b', data: 'y', timestamp: 2 };
  const fused = mem.fuseRrf([
    [{ memory: b }, { memory: a }],
    [{ memory: b }, { memory: a }]
  ]);
  assert.equal(fused[0].memory.id, 'b');
  assert.ok(fused[0].score > fused[1].score);
});

test('fuseRrf：同一路重复出现只累加，不重复入池', () => {
  const mem = makeMemory();
  const a = { id: 'a', data: 'x', timestamp: 1 };
  const fused = mem.fuseRrf([[{ memory: a }], [{ memory: a }]]);
  assert.equal(fused.length, 1);
  assert.ok(Math.abs(fused[0].score - 2 / 61) < 1e-9);
});

test('fuseRrf：世代权重为 0 的旧记忆不再因排名靠前而占位', () => {
  const mem = makeMemory();
  const oldMem = { id: 'old', data: '旧人设', timestamp: 100 };
  const newMem = { id: 'new', data: '新人设', timestamp: 1 };
  const lists = [[{ memory: oldMem }, { memory: newMem }]];
  const fused = mem.fuseRrf(lists, (m) => (m.id === 'old' ? 0 : 1));
  assert.equal(fused[0].memory.id, 'new');
});

test('fuseRrf：分数相同时按时间新的在前', () => {
  const mem = makeMemory();
  const older = { id: 'o', data: 'x', timestamp: 1 };
  const newer = { id: 'n', data: 'y', timestamp: 2 };
  const fused = mem.fuseRrf([[{ memory: older }], [{ memory: newer }]]);
  assert.deepEqual(fused.map(item => item.memory.id), ['n', 'o']);
});
