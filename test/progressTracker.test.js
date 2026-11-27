'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createProgressTracker } = require('../src/core/progressTracker');

// 深化十：长任务进度跟踪的纯逻辑（不落盘、不带正文，token→{phase,at}）。
// 覆盖：生命周期 / 空与未知 token / Map 键安全 / 容量上限淘汰 / TTL 过期。

test('set/get/end：命中有 phase/at，startedAt 首次确定后续不重置；end 后回落 busy:false', () => {
  let t = 1000;
  const tr = createProgressTracker({ now: () => t });

  tr.set('tok', 'speech');
  const first = tr.get('tok');
  assert.equal(first.busy, true);
  assert.equal(first.phase, 'speech');
  assert.equal(first.at, 1000);
  assert.equal(first.startedAt, 1000);

  t = 1500;
  tr.set('tok', 'vote');
  const second = tr.get('tok');
  assert.equal(second.busy, true);
  assert.equal(second.phase, 'vote');
  assert.equal(second.at, 1500, 'at 应随每次上报刷新');
  assert.equal(second.startedAt, 1000, 'startedAt 首次 set 时确定，后续不重置');

  tr.end('tok');
  assert.equal(tr.get('tok').busy, false, 'end 后即视为不在飞');
  assert.equal(tr.size(), 0);
});

test('空 / 未知 token：set 不落条目，get 一律 busy:false', () => {
  const tr = createProgressTracker();
  tr.set('', 'speech');
  tr.set(null, 'speech');
  tr.set(undefined, 'speech');
  assert.equal(tr.size(), 0, '空 token 不应产生条目');
  assert.equal(tr.get('').busy, false);
  assert.equal(tr.get(null).busy, false);
  assert.equal(tr.get('nope').busy, false, '未知 token 回落忙否');
});

test('键安全：__proto__/constructor 走 Map，不污染普通对象原型', () => {
  const tr = createProgressTracker();
  tr.set('__proto__', 'vote');
  tr.set('constructor', 'synthesis');

  assert.equal(tr.get('__proto__').busy, true);
  assert.equal(tr.get('__proto__').phase, 'vote');
  assert.equal(tr.get('constructor').phase, 'synthesis');
  assert.equal({}.phase, undefined, '普通对象原型未被污染');
  assert.equal(tr.size(), 2);
});

test('容量上限：超出 maxEntries 按「最久未更新」淘汰', () => {
  const tr = createProgressTracker({ maxEntries: 3 });
  tr.set('a', 'speech');
  tr.set('b', 'speech');
  tr.set('c', 'speech');
  tr.set('a', 'vote');       // a 被刷新 → 变成最近使用；此刻最旧的是 b
  tr.set('d', 'synthesis');  // 触发淘汰：b 出局

  assert.equal(tr.size(), 3);
  assert.equal(tr.get('b').busy, false, '最久未更新的 b 被淘汰');
  assert.equal(tr.get('a').busy, true);
  assert.equal(tr.get('c').busy, true);
  assert.equal(tr.get('d').busy, true);
});

test('TTL：超过 ttlMs 未更新即过期回落 busy:false，且读取时顺手清理', () => {
  let t = 0;
  const tr = createProgressTracker({ ttlMs: 1000, now: () => t });
  tr.set('tok', 'speech');

  t = 1000;
  assert.equal(tr.get('tok').busy, true, '恰好等于 ttl 边界仍算在飞');

  t = 1001;
  assert.equal(tr.get('tok').busy, false, '超过 ttl 即过期');
  assert.equal(tr.size(), 0, 'get 过期应顺手清掉条目');
});
